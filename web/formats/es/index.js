// Raw video elementary streams: H.264 and HEVC in Annex B form (.h264, .264, .hevc, .265) and
// MPEG-1/2 video (.m1v, .m2v). There is no container, only the encoder's output: Vidscope finds
// the NAL units (or MPEG-2 start codes), groups them into access units (one per coded picture,
// shown as frames), and rebuilds what a container would say: key frames, display order, timing.

import { Node, fieldsAt } from '../../core/model.js';
import { Doc } from '../../core/doc.js';
import { fmtInt, fmtNum, fmtDuration, fmtBitrate, hex, humanBytes, humanSize, plural } from '../../core/util.js';
import { parseSample } from '../../codecs/index.js';
import * as h264 from '../../codecs/h264.js';
import * as h265 from '../../codecs/h265.js';
import { mpeg2Units } from '../mpegts/es.js';
import { scanStream, frameRateOf, PIC } from './scan.js';

const SCAN_AT_OPEN = 64 << 20; // smaller streams are walked completely before the first render
const PREVIEW = 8 << 20;
const GROUP = 1000;

const CODEC = {
  hevc: { name: 'H.265 / HEVC', short: 'hevc', label: 'HEVC elementary stream', ext: 'hevc', mux: '-tag:v hvc1 ' },
  avc: { name: 'H.264 / AVC', short: 'h264', label: 'H.264 elementary stream', ext: 'h264', mux: '' },
  mpeg2v: { name: 'MPEG-2 Video', short: 'mpeg2video', label: 'MPEG video elementary stream', ext: 'm2v', mux: '' },
};

const PIC_NAME = { [PIC.I]: 'I', [PIC.P]: 'P', [PIC.B]: 'B', [PIC.S]: 'S' };

// ------------------------------------------------------------ recognising a stream

/** Walk the start codes at the beginning of a file: which kind of raw stream is it? */
export function sniff(head, name = '') {
  let i = 0;
  while (i < head.length && i < 32 && head[i] === 0) i++;
  if (i < 2 || head[i] !== 1 || i + 2 >= head.length) return null;
  const q = i + 1;
  if (head[q] === 0xb3) return 'mpeg2v'; // an MPEG-1/2 sequence header
  const hdrs = [];
  for (let k = q - 3; k + 4 < head.length && hdrs.length < 12; k++) {
    if (head[k] === 0 && head[k + 1] === 0 && head[k + 2] === 1) {
      hdrs.push([head[k + 3], head[k + 4]]);
      k += 2;
    }
  }
  if (!hdrs.length) return null;
  const HEVC_TYPES = new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 16, 17, 18, 19, 20, 21, 32, 33, 34, 35, 36, 37, 38, 39, 40]);
  const AVC_TYPES = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 19, 20]);
  const hevc = hdrs.every(([a, b]) => !(a & 0x81) && !(b & 0xf8) && (b & 7) >= 1 && HEVC_TYPES.has((a >> 1) & 63));
  const avc = hdrs.every(([a]) => !(a & 0x80) && AVC_TYPES.has(a & 31));
  const ext = name.toLowerCase().split('.').pop();
  if (hevc && (!avc || ['hevc', 'h265', '265', 'hvc', 'x265'].includes(ext) || ((hdrs[0][0] >> 1) & 63) === 32)) return 'hevc';
  if (avc) return 'avc';
  return hevc ? 'hevc' : null;
}

function probe(head, source) {
  // Program streams (00 00 01 BA) and other start-code formats are left to their own parsers.
  return sniff(head, source?.name) ? 70 : 0;
}

// ------------------------------------------------------------ the document

class EsDoc extends Doc {
  constructor(o) {
    super(o);
    this.unitCache = new Map();
  }

  /** Walk the whole stream once; later calls return the same promise. */
  runScan(onProgress) {
    this.scanning ??= (async () => {
      const scan = await scanStream(this.source, this.codec, { onProgress });
      this.applyScan(scan);
    })();
    return this.scanning;
  }

  applyScan(scan) {
    this.scan = scan;
    const t = this.tracks[0];
    const rate = frameRateOf(scan);
    this.rate = rate;
    const n = scan.count;
    const dur = rate.duration;
    // No timestamps in the stream: frames are one frame duration apart in decoding order, from 0
    // as in FFmpeg's raw demuxers, and shown in the order their POC (or temporal reference)
    // gives. With B-frames the first picture is then shown a frame or two after 0, as FFmpeg
    // reports it too.
    let shift = 0;
    for (let i = 0; i < n; i++) shift = Math.max(shift, i - scan.rank[i]);
    const dts = new Float64Array(n);
    const cto = scan.reordered ? new Int32Array(n) : null;
    for (let i = 0; i < n; i++) {
      dts[i] = i * dur;
      if (cto) cto[i] = (scan.rank[i] - i + shift) * dur;
    }
    t.timescale = rate.timescale;
    t.fps = rate.fps;
    t.samples = {
      count: n,
      timescale: rate.timescale,
      offsets: scan.offsets,
      sizes: scan.sizes,
      dts,
      cto,
      durations: new Float64Array(n).fill(dur),
      key: scan.key,
    };
    t.duration = (n * dur) / rate.timescale;
    let bytes = 0;
    for (let i = 0; i < n; i++) bytes += scan.sizes[i];
    t.bitrate = t.duration ? (bytes * 8) / t.duration : 0;
    t.sampleCfg = this.codec === 'mpeg2v' ? { family: 'mpeg2v' } : { family: this.codec, annexB: true, state: scan.state };
    t.props = trackProps(this, t, scan);
    t.codecString = codecString(this.codec, scan);
    this.summary.duration = t.duration;
    this.summary.unitCount = scan.units;
    buildTree(this, scan);
    this.recount();
  }

  /** The NAL units (or MPEG-2 headers and slices) of frame i, decoded. */
  async auUnits(i) {
    const hit = this.unitCache.get(i);
    if (hit) return hit;
    const s = this.tracks[0].samples;
    const off = s.offsets[i];
    const bytes = await this.source.read(off, Math.min(s.sizes[i], 16 << 20));
    let units;
    if (this.codec === 'mpeg2v') units = mpeg2Units(bytes, 0, bytes.length, off);
    else {
      const res = parseSample({ family: this.codec, annexB: true, state: this.scan.state }, bytes, 0, bytes.length, off);
      units = res.units;
      if (res.error) units.error = res.error;
    }
    if (this.unitCache.size > 256) this.unitCache.delete(this.unitCache.keys().next().value);
    this.unitCache.set(i, units);
    return units;
  }

  /** The frame containing `offset`, by binary search over the frame offsets. */
  frameAt(offset) {
    const s = this.tracks[0]?.samples;
    if (!s?.count) return -1;
    let lo = 0;
    let hi = s.count - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (s.offsets[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return offset >= s.offsets[lo] && offset < s.offsets[lo] + s.sizes[lo] ? lo : -1;
  }

  async detailAt(offset) {
    const i = this.frameAt(offset);
    if (i < 0) return null;
    const t = this.tracks[0];
    const s = t.samples;
    const scan = this.scan;
    const units = await this.auUnits(i);
    const ts = t.timescale;
    const pts = s.dts[i] + (s.cto ? s.cto[i] : 0);
    const rows = [
      ['frame', `${fmtInt(i + 1)} of ${fmtInt(s.count)} (decoding order)`],
      ['offset', `${fmtInt(s.offsets[i])} (${hex(s.offsets[i])})`],
      ['size', `${fmtInt(s.sizes[i])} bytes`],
    ];
    if (scan.reordered) rows.push(['shown', `${fmtInt(scan.rank[i] + 1)}${ordinal(scan.rank[i] + 1)} (display order, from the ${this.codec === 'mpeg2v' ? 'temporal reference' : 'picture order count'})`]);
    rows.push(['time', `${fmtDuration(pts / ts)}${this.rate.source ? '' : ' (assuming 25 fps: the stream has no timing)'}`]);
    if (!Number.isNaN(scan.poc[i])) rows.push([this.codec === 'mpeg2v' ? 'temporal reference' : 'POC', `${fmtInt(scan.poc[i])}${this.codec === 'mpeg2v' ? '' : ` in coded video sequence ${fmtInt(scan.cvs[i] + 1)}`}`]);
    rows.push(['key frame', s.key[i] ? 'yes: decoding can start here' : 'no: needs earlier frames']);
    const d = {
      kind: 'sample',
      title: `Frame ${fmtInt(i + 1)} · ${PIC_NAME[scan.pic[i]] ?? '?'}-frame`,
      subtitle: CODEC[this.codec].name,
      range: [s.offsets[i], s.offsets[i] + s.sizes[i]],
      rows,
      units,
      track: t,
      sample: i,
    };
    const u = units.findIndex((x) => offset >= x.offset && offset < x.offset + x.size);
    if (u >= 0) d.hit = { unit: u, fields: fieldsAt({ fields: units[u].fields, _leaves: null }, offset) };
    return d;
  }

  frameCodec(t) {
    if (this.codec === 'mpeg2v') return { family: 'mpeg2v' };
    return { family: this.codec, annexB: true, state: this.scan?.state ?? null };
  }

  async insights() {
    return esInsights(this);
  }

  glossary() {
    return GLOSSARY.map(([term, name, desc]) => ({ term, name, desc, cat: 'concept' }));
  }
}

// ------------------------------------------------------------ tree

const AU_DEF = {
  name: 'Access unit (one coded picture)',
  cat: 'media',
  desc: 'All the NAL units of one coded picture: optionally an access unit delimiter and parameter sets, then SEI messages and the slices that hold the picture itself. A decoder turns one access unit into one frame. The stream does not mark these groups: Vidscope finds them the way a decoder does.',
};
const MPEG2_AU_DEF = {
  name: 'Coded picture',
  cat: 'media',
  desc: 'One picture of MPEG video: optional sequence and GOP headers, the picture header (which says whether it is an I, P or B picture) and the slices of the picture.',
};
const GROUP_DEF = {
  name: 'Group of frames',
  cat: 'media',
  desc: 'A run of consecutive frames. Vidscope groups them so that streams with hundreds of thousands of frames stay browsable; the grouping is not part of the file.',
};

function buildTree(doc, scan) {
  const root = doc.root;
  root.children = [];
  if (scan.first > 0) {
    const g = new Node({ type: 'leading bytes', name: 'Bytes before the first start code', kind: 'region', offset: 0, size: scan.first, category: 'unknown' });
    g.def = { name: 'Bytes before the first start code', cat: 'unknown', desc: 'The stream should begin with a start code. These bytes belong to no NAL unit: the file was probably cut out of a longer stream, starting in the middle of a picture.' };
    root.add(g);
  }
  const n = scan.count;
  if (n <= GROUP * 2) {
    for (let i = 0; i < n; i++) root.add(auNode(doc, scan, i));
  } else {
    for (let k = 0; k < n; k += GROUP) {
      const last = Math.min(n, k + GROUP);
      const a = scan.offsets[k];
      const g = new Node({ type: 'frames', name: 'Group of frames', kind: 'group', offset: a, size: scan.offsets[last - 1] + scan.sizes[last - 1] - a, category: 'media' });
      g.def = GROUP_DEF;
      g.label = `#${fmtInt(k + 1)}–#${fmtInt(last)}`;
      const from = k;
      g.lazy = async (gn) => {
        for (let i = from; i < last; i++) gn.add(auNode(doc, scan, i));
        doc.recount();
      };
      root.add(g);
    }
  }
}

function auNode(doc, scan, i) {
  const node = new Node({ type: 'frame', name: `Frame ${fmtInt(i + 1)}`, kind: 'frame', offset: scan.offsets[i], size: scan.sizes[i], category: 'media' });
  node.def = doc.codec === 'mpeg2v' ? MPEG2_AU_DEF : AU_DEF;
  const pic = PIC_NAME[scan.pic[i]] ?? '?';
  const name = scan.nal[i] !== 255 ? vclName(doc.codec, scan.nal[i]) : '';
  node.label = `${pic}${scan.key[i] ? ' · key' : ''}${!scan.ref[i] ? ' · not a reference' : ''}${name ? ` · ${name}` : ''} · ${humanSize(scan.sizes[i])}`;
  node.data.summary = `${pic}-frame${scan.key[i] ? ', key frame' : ''}, ${fmtInt(scan.sizes[i])} bytes`;
  node.lazy = async (nd) => {
    const units = await doc.auUnits(i);
    for (const u of units) nd.add(unitNode(doc, u));
    doc.recount();
  };
  return node;
}

function vclName(codec, t) {
  if (codec === 'hevc') return HEVC_NAMES[t]?.[0] ?? `type ${t}`;
  if (codec === 'avc') return t === 5 ? 'IDR' : '';
  return '';
}

function unitNode(doc, u) {
  let type;
  let def;
  let cat = 'media';
  let headerSize = 0;
  const start = u.fields[0]?.name === 'start_code' ? u.fields[0].size : 0;
  if (doc.codec === 'hevc') {
    const [short, name, desc, c] = HEVC_NAMES[u.kind] ?? [`NAL ${u.kind}`, `NAL unit type ${u.kind}`, 'A NAL unit type Vidscope has no description for.', 'unknown'];
    type = short;
    def = { name, cat: c, desc };
    cat = c;
    headerSize = start + 2;
  } else if (doc.codec === 'avc') {
    const [short, name, desc, c] = AVC_NAMES[u.kind] ?? [`NAL ${u.kind}`, `NAL unit type ${u.kind}`, 'A NAL unit type Vidscope has no description for.', 'unknown'];
    type = short;
    def = { name, cat: c, desc };
    cat = c;
    headerSize = start + 1;
  } else {
    type = u.title;
    const c = /slice/i.test(type) ? 'media' : /user/i.test(type) ? 'meta' : 'header';
    def = { name: type, cat: c, desc: MPEG2_DESC[type] ?? 'An MPEG video header, introduced by a 00 00 01 start code.' };
    cat = c;
    headerSize = 4;
  }
  const node = new Node({ type, name: def.name, kind: 'nal', offset: u.offset, size: u.size, headerSize: Math.min(headerSize, u.size), category: cat });
  node.def = def;
  node.fields = u.fields;
  node.data.summary = u.summary;
  return node;
}

// [short name, full name, description, colour category]
const PS_MORE = ' Decoders need it before the first picture that refers to it; streams meant for broadcast or live repeat it before every key frame so a viewer can join at any point.';
const HEVC_NAMES = {
  0: ['TRAIL_N', 'Trailing picture, not a reference', 'A slice of an ordinary picture that comes after its entry point in both decoding and display order. No other picture of its temporal layer refers to it, so it can be dropped.', 'media'],
  1: ['TRAIL_R', 'Trailing picture', 'A slice of an ordinary picture that comes after its entry point in both decoding and display order, and that later pictures may refer to.', 'media'],
  2: ['TSA_N', 'Temporal sub-layer access, not a reference', 'A slice of a picture where a decoder may switch up to a higher temporal layer (a higher frame rate).', 'media'],
  3: ['TSA_R', 'Temporal sub-layer access', 'A slice of a picture where a decoder may switch up to a higher temporal layer (a higher frame rate).', 'media'],
  4: ['STSA_N', 'Step-wise temporal sub-layer access, not a reference', 'A slice of a picture where a decoder may switch up one temporal layer.', 'media'],
  5: ['STSA_R', 'Step-wise temporal sub-layer access', 'A slice of a picture where a decoder may switch up one temporal layer.', 'media'],
  6: ['RADL_N', 'Random access decodable leading, not a reference', 'A slice of a leading picture: shown before the entry frame it follows, but decodable from it.', 'media'],
  7: ['RADL_R', 'Random access decodable leading', 'A slice of a leading picture: shown before the entry frame it follows, but decodable from it.', 'media'],
  8: ['RASL_N', 'Random access skipped leading, not a reference', 'A slice of a leading picture that refers to the previous GOP: it is skipped when playback starts at the CRA frame before it.', 'media'],
  9: ['RASL_R', 'Random access skipped leading', 'A slice of a leading picture that refers to the previous GOP: it is skipped when playback starts at the CRA frame before it.', 'media'],
  16: ['BLA_W_LP', 'Broken link access', 'A slice of an entry picture where the stream was spliced: leading pictures after it may be undecodable and are skipped.', 'index'],
  17: ['BLA_W_RADL', 'Broken link access', 'A slice of an entry picture where the stream was spliced.', 'index'],
  18: ['BLA_N_LP', 'Broken link access', 'A slice of an entry picture where the stream was spliced, with no leading pictures.', 'index'],
  19: ['IDR_W_RADL', 'Instantaneous decoding refresh', 'A slice of an IDR picture: an I-frame after which nothing refers to earlier pictures. Decoding, seeking and switching can start here cleanly. It may be followed by decodable leading pictures.', 'index'],
  20: ['IDR_N_LP', 'Instantaneous decoding refresh', 'A slice of an IDR picture with no leading pictures: decoding can start here cleanly.', 'index'],
  21: ['CRA', 'Clean random access', 'A slice of an open-GOP entry picture: decoding can start here, but the RASL pictures that follow it refer to the previous GOP and are skipped.', 'index'],
  32: ['VPS', 'Video parameter set', `Describes the whole stream: how many layers and temporal sub-layers it has, and their profile and level.${PS_MORE}`, 'header'],
  33: ['SPS', 'Sequence parameter set', `Picture size, profile and level, bit depth, chroma format, block sizes, and timing (VUI) for a sequence of pictures.${PS_MORE}`, 'header'],
  34: ['PPS', 'Picture parameter set', `Coding options for the pictures that refer to it: entropy coding details, tiles, deblocking and initial quantiser.${PS_MORE}`, 'header'],
  35: ['AUD', 'Access unit delimiter', 'Marks the start of a new picture and says which slice types it holds. Optional in general, but required by some broadcast and Blu-ray specifications.', 'meta'],
  36: ['EOS', 'End of sequence', 'Ends a coded video sequence: the next picture must be an entry point.', 'meta'],
  37: ['EOB', 'End of bitstream', 'The end of the stream.', 'meta'],
  38: ['FD', 'Filler data', 'Padding bytes, used to keep a constant bitrate. Decoders throw them away.', 'free'],
  39: ['SEI', 'Supplemental enhancement information', 'Extra data a decoder does not need to make pictures: encoder settings, HDR metadata, closed captions, timecodes, recovery points.', 'meta'],
  40: ['suffix SEI', 'Supplemental enhancement information (suffix)', 'SEI messages that follow the slices of a picture, such as picture hashes for checking the decoder.', 'meta'],
};
const AVC_NAMES = {
  1: ['slice', 'Coded slice', 'A slice of an ordinary (non-IDR) picture: I, P or B, as its slice header says.', 'media'],
  2: ['slice A', 'Slice data partition A', 'The most important part of a slice when data partitioning is used (Extended profile).', 'media'],
  3: ['slice B', 'Slice data partition B', 'Intra residual data of a partitioned slice.', 'media'],
  4: ['slice C', 'Slice data partition C', 'Inter residual data of a partitioned slice.', 'media'],
  5: ['IDR slice', 'IDR slice', 'A slice of an IDR picture: an I-frame after which nothing refers to earlier pictures. Decoding, seeking and switching can start here cleanly.', 'index'],
  6: ['SEI', 'Supplemental enhancement information', 'Extra data a decoder does not need to make pictures: encoder settings, captions, recovery points, HDR metadata.', 'meta'],
  7: ['SPS', 'Sequence parameter set', `Picture size, profile and level, frame numbering, reference frame count and timing (VUI).${PS_MORE}`, 'header'],
  8: ['PPS', 'Picture parameter set', `Coding options for the pictures that refer to it: entropy coding (CAVLC or CABAC), initial quantiser, weighted prediction.${PS_MORE}`, 'header'],
  9: ['AUD', 'Access unit delimiter', 'Marks the start of a new picture and says which slice types it holds. Required in transport streams by some broadcast specifications.', 'meta'],
  10: ['EOS', 'End of sequence', 'Ends a coded video sequence: the next picture must be an IDR picture.', 'meta'],
  11: ['EOB', 'End of stream', 'The end of the stream.', 'meta'],
  12: ['filler', 'Filler data', 'Padding bytes, used to keep a constant bitrate. Decoders throw them away.', 'free'],
  13: ['SPS ext', 'SPS extension', 'Alpha (auxiliary picture) parameters.', 'header'],
  14: ['prefix', 'Prefix NAL unit', 'Scalable (SVC) or multiview (MVC) information for the slice that follows.', 'meta'],
  15: ['subset SPS', 'Subset sequence parameter set', 'Parameters for the scalable (SVC) or multiview (MVC) layers.', 'header'],
  19: ['aux slice', 'Auxiliary slice', 'A slice of an auxiliary picture, such as an alpha channel.', 'media'],
  20: ['slice ext', 'Slice extension', 'A slice of a scalable (SVC) or multiview (MVC) layer.', 'media'],
};
const MPEG2_DESC = {
  'sequence header': 'Picture size, aspect ratio, frame rate and bitrate of the video, plus optional quantiser matrices. Repeated before key frames so decoding can start there.',
  sequence_extension: 'The MPEG-2 part of the sequence header: profile and level, progressive or interlaced, chroma format. Its presence is what makes a stream MPEG-2 rather than MPEG-1.',
  sequence_display_extension: 'How to display the video: colour primaries, transfer characteristics and the display size.',
  picture_coding_extension: 'MPEG-2 picture details: motion vector ranges, field or frame picture, top field first, repeat first field (3:2 pulldown) and whether the picture is progressive.',
  'user data': 'Free-form data inside the video stream, such as closed captions (ATSC A/53) or the encoder\'s name.',
  'GOP header': 'Starts a group of pictures: a time code, and whether the GOP is closed (its first B-pictures do not refer to the previous GOP).',
  'picture header': 'Starts a picture: its temporal reference (display position within the GOP) and whether it is an I, P or B picture.',
};

// ------------------------------------------------------------ track

function codecString(codec, scan) {
  const sps = scan.state.spsById.values().next().value;
  if (!sps) return null;
  if (codec === 'avc') return h264.codecString('avc1', sps.profile_idc, sps.compat, sps.level_idc);
  if (codec === 'hevc') {
    const b0 = (sps.progressive << 7) | (sps.interlaced << 6) | ((sps.non_packed ?? 0) << 5) | ((sps.frame_only ?? 0) << 4);
    return h265.codecString('hvc1', { ...sps, constraint_bytes: [b0, 0, 0, 0, 0, 0] });
  }
  return null;
}

function trackProps(doc, t, scan) {
  const p = [];
  const sps = scan.state.spsById.values().next().value;
  if (doc.codec === 'mpeg2v') {
    const q = scan.seq;
    p.push(['codec', scan.counts.get(0xb5) ? 'MPEG-2 Video' : 'MPEG-1 Video']);
    if (q) {
      p.push(['coded size', `${q.width}×${q.height}`]);
      if (q.bitRate) p.push(['declared bitrate', `${fmtBitrate(q.bitRate)} (bit_rate in the sequence header)`]);
    }
  } else if (sps) {
    p.push(['profile', `${doc.codec === 'avc' ? h264.profileName(sps.profile_idc, sps.compat) : h265.PROFILES[sps.profile_idc] ?? sps.profile_idc}, level ${doc.codec === 'avc' ? h264.levelName(sps.level_idc, sps.compat, sps.profile_idc) : h265.levelName(sps.level_idc)}${doc.codec === 'hevc' ? (sps.tier ? ', High tier' : ', Main tier') : ''}`]);
    p.push(['coded size', `${sps.width}×${sps.height}`]);
    p.push(['bit depth', `${sps.bit_depth_luma}-bit`]);
  }
  const r = doc.rate;
  p.push(['frame rate', r.source ? `${fmtNum(r.fps, r.fps % 1 ? 3 : 0)} fps (from ${r.source}: ${r.detail})` : '25 fps (assumed: the stream carries no timing, and 25 is what FFmpeg assumes too)']);
  p.push(['frames', `${fmtInt(scan.count)} (${fmtInt(countKeys(scan))} key frames)`]);
  p.push([doc.codec === 'mpeg2v' ? 'start codes' : 'NAL units', fmtInt(scan.units)]);
  if (t.bitrate) p.push(['average bitrate', fmtBitrate(t.bitrate)]);
  return p;
}

function countKeys(scan) {
  let k = 0;
  for (let i = 0; i < scan.count; i++) k += scan.key[i];
  return k;
}

// ------------------------------------------------------------ insights

const sh = (s) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${String(s).replace(/'/g, `'\\''`)}'`);

async function esInsights(doc) {
  const out = [];
  const add = (level, group, title, text, extra = {}) => out.push({ level, group, title, text, ...extra });
  const scan = doc.scan;
  const c = CODEC[doc.codec];
  if (!scan) {
    add('info', 'Overview', 'Stream not walked yet', 'Vidscope is still finding the frames of this stream.');
    return out;
  }
  const t = doc.tracks[0];
  const name = doc.name;
  const rate = doc.rate;
  const audioInName = /audio/i.test(name);
  const outName = name.replace(/\.[^.]+$/, '') + (doc.codec === 'mpeg2v' ? '.mpg' : '.mp4');
  const fr = rate.source ? `${rate.timescale}/${rate.duration}` : '25';
  add('info', 'Overview', `A raw ${c.name} stream, with no container`, `This file is an elementary stream: the encoder's output as it comes, ${doc.codec === 'mpeg2v' ? 'headers and slices each introduced by a 00 00 01 start code' : 'a series of NAL units each introduced by a 00 00 01 start code'}. A container (MP4, MKV, TS) would add timestamps, an index for seeking, other tracks such as audio, and metadata. Here there are none: a player has to scan for start codes to find frames, and guess the frame rate if the stream does not state it. Elementary streams carry exactly one stream${audioInName ? ', so this file has no audio, even though its name mentions audio' : ''}. To play or edit it comfortably, wrap it in a container; no re-encoding is needed.`, {
    facts: [['frames', fmtInt(scan.count)], [doc.codec === 'mpeg2v' ? 'start codes' : 'NAL units', fmtInt(scan.units)], ['codec string', t.codecString ?? '—']],
    cmd: `ffmpeg -framerate ${fr} -i ${sh(name)} -c copy ${c.mux}${sh(outName)}`,
  });
  if (rate.source) {
    add('good', 'Timing', `Frame rate stated in the stream: ${fmtNum(rate.fps, rate.fps % 1 ? 3 : 0)} fps`, `An elementary stream has no timestamps, so ${rate.source} is the only place that says how fast to play it: ${rate.detail} = ${fmtNum(rate.fps, 3)} frames per second. Players and FFmpeg use it; the times Vidscope shows are frame counts converted with this rate.`);
  } else {
    add('warn', 'Timing', 'No frame rate in the stream', 'Neither the SPS (VUI timing) nor anything else says how fast to play this stream, so players guess: FFmpeg assumes 25 fps. If the video was shot at another rate it will play too fast or too slow; give the rate when you wrap it in a container (ffmpeg -framerate 30000/1001 -i …).');
  }
  if (doc.codec !== 'mpeg2v') {
    const keys = countKeys(scan);
    const ps = doc.codec === 'hevc' ? scan.counts.get(33) ?? 0 : scan.counts.get(7) ?? 0;
    if (keys > 1) {
      if (scan.paramSetsBeforeKeys >= keys) {
        add('good', 'Layout', 'Parameter sets before every key frame', `The ${doc.codec === 'hevc' ? 'VPS, SPS and PPS are' : 'SPS and PPS are'} sent again before each of the ${fmtInt(keys)} key frames (${fmtInt(ps)} SPS in total). A decoder can therefore start at any key frame, which live streams, broadcast and cut-out clips need.`);
      } else if (ps <= 1) {
        add('info', 'Layout', 'Parameter sets only at the start', `The parameter sets appear once, at the start of the stream. That is fine for a file played from the beginning, but a decoder that starts at any other key frame (a viewer joining a live stream, a clip cut from the middle) has no SPS/PPS and cannot decode anything. Encoders can repeat them: x264 and x265 do so with repeat-headers=1, and FFmpeg's dump_extra bitstream filter adds them to an existing stream.`, {
          cmd: `ffmpeg -i ${sh(name)} -c copy -bsf:v dump_extra=freq=keyframe ${sh(name.replace(/(\.\w+)?$/, '-repeated$1'))}`,
        });
      }
    }
    const aud = doc.codec === 'hevc' ? scan.counts.get(35) : scan.counts.get(9);
    if (aud) add('info', 'Layout', `Access unit delimiters (${fmtInt(aud)})`, 'Every picture starts with an access unit delimiter (AUD), a tiny NAL unit that marks where one picture ends and the next begins. Some broadcast and Blu-ray specifications require them; decoders can also find picture boundaries without them.', { offset: scan.firstOffsets.get(doc.codec === 'hevc' ? 35 : 9) });
    const fill = doc.codec === 'hevc' ? scan.counts.get(38) : scan.counts.get(12);
    if (fill) add('info', 'Encoding', `${plural(fill, 'filler NAL unit')}`, 'Filler data NAL units are padding: the encoder adds them to keep a constant bitrate (CBR), and decoders throw them away.', { offset: scan.firstOffsets.get(doc.codec === 'hevc' ? 38 : 12) });
    if (scan.reordered) {
      add('info', 'Timing', 'Display order comes from the picture order count', 'The frames are stored in decoding order, and there are no timestamps to say when each is shown. A decoder works out the display order from the picture order count (POC) in every slice header; Vidscope does the same, which is how the Frames view can show both orders for this stream.');
    } else if (scan.pocMissing) {
      add('info', 'Timing', 'Display order not worked out', 'Vidscope could not read the picture order count of every frame (for example with H.264 POC type 1), so frames are shown in decoding order.');
    }
    const enc = await encoderText(doc);
    if (enc) {
      const who = enc.split(' - ').slice(0, 2).join(' ').replace(/[:[].*$/, '').trim();
      add('info', 'Encoding', `Encoded with ${who}`, 'The encoder left its name, version and every option it was run with in an SEI message (user data) at the start of the stream. Open the first frame in the structure tree to read it.', { facts: [['settings', enc.length > 400 ? `${enc.slice(0, 400)}…` : enc]] });
    }
  } else if (scan.seq) {
    const q = scan.seq;
    add('info', 'Overview', `${q.width}×${q.height} ${scan.counts.get(0xb5) ? 'MPEG-2' : 'MPEG-1'} video`, 'The sequence header gives the picture size, aspect ratio, frame rate and a declared bitrate. MPEG-2 adds a sequence extension (profile, level, interlacing); a stream without one is MPEG-1.', { offset: scan.firstOffsets.get(0xb3) });
  }
  if (scan.first > 0) add('warn', 'Integrity', `${fmtInt(scan.first)} bytes before the first start code`, 'The stream should begin with a start code. These bytes belong to no NAL unit: the file was probably cut out of a longer stream in the middle of a picture. Decoders skip them.', { offset: 0 });
  return out;
}

/** The x264/x265 settings string from the SEI messages of the first frame, if any. */
async function encoderText(doc) {
  if (!doc.tracks[0]?.samples?.count) return null;
  const units = await doc.auUnits(0);
  const walk = (fields) => {
    for (const f of fields ?? []) {
      if (f.name === 'user_data_payload' && typeof f.value === 'string' && /^x26[45]/.test(f.value)) return f.value;
      const inner = walk(f.children);
      if (inner) return inner;
    }
    return null;
  };
  for (const u of units) {
    const s = walk(u.fields);
    if (s) return s.replace(/\0+$/, '');
  }
  return null;
}

// ------------------------------------------------------------ glossary

const GLOSSARY = [
  ['elementary-stream', 'Elementary stream (ES)', 'The output of an encoder with no container around it: for H.264 and HEVC a series of NAL units separated by start codes, for MPEG-2 a series of headers and slices. It carries exactly one stream (no audio next to the video), no timestamps and no index.'],
  ['start-code', 'Start code', 'The bytes 00 00 01 (often with an extra 00 before them) that mark where a NAL unit or header begins in a raw stream. Encoders make sure the pattern never appears inside the data (emulation prevention), so a reader can find every unit by scanning for it.'],
  ['access-unit', 'Access unit', 'Everything that belongs to one coded picture: optional delimiter and parameter sets, SEI messages and the slices. A decoder turns one access unit into one frame; containers store one access unit per sample.'],
  ['aud', 'Access unit delimiter (AUD)', 'A tiny NAL unit that marks the start of a new picture and says which slice types it contains. Optional, but some broadcast specifications require it.'],
  ['poc', 'Picture order count (POC)', 'A number in each H.264/HEVC slice header that gives the picture\'s position in display order within its coded video sequence. Without a container\'s timestamps it is the only way to know when a B-frame is shown.'],
  ['cvs', 'Coded video sequence', 'A run of pictures from one IDR (or other clean entry point) up to the next. Picture order counts restart in every coded video sequence.'],
  ['vui-timing', 'VUI timing', 'Optional fields in the SPS (num_units_in_tick, time_scale) that give the frame rate of the stream. In a raw stream they are the only statement of how fast to play it.'],
];

async function open(source, { onProgress } = {}) {
  const head = await source.read(0, Math.min(source.size, 64 << 10));
  const codec = sniff(head, source.name);
  const root = new Node({ type: source.name, name: source.name, kind: 'file', offset: 0, size: source.size, category: 'file' });
  const doc = new EsDoc({ source, format: FORMAT, root });
  doc.codec = codec;
  doc.unit = codec === 'mpeg2v' ? ['start code', 'start codes'] : ['NAL unit', 'NAL units'];
  const c = CODEC[codec];
  doc.summary.label = c.label;
  doc.summary.anatomy = `Raw ${c.short === 'mpeg2video' ? 'MPEG video' : c.short === 'h264' ? 'H.264' : 'HEVC'} stream anatomy`;
  doc.tracks.push({ id: 1, index: 0, kind: 'video', codec: c.short, codecName: c.name, label: `Video 1 – ${c.short}`, props: [], node: root });
  if (source.size <= FORMAT.limits.scanAtOpen) {
    await doc.runScan(onProgress);
  } else {
    // Large streams: learn the codec parameters from the start, walk the rest in the background.
    const preview = await scanStream(source, codec, { end: Math.min(source.size, PREVIEW) });
    doc.rate = frameRateOf(preview);
    doc.tracks[0].props = [['frames', 'counting… (the whole stream is walked in the background)'], ...trackProps(doc, doc.tracks[0], preview).filter(([k]) => k !== 'frames' && k !== 'NAL units' && k !== 'start codes')];
    doc.tracks[0].codecString = codecString(codec, preview);
    const rest = new Node({ type: 'frames', name: 'Frames', kind: 'group', offset: 0, size: source.size, category: 'media' });
    rest.def = { name: 'Frames', cat: 'media', desc: 'The frames of the stream. A raw stream has no index, so Vidscope has to walk the whole file to find where each frame starts; they are listed (in groups) once that is done.' };
    rest.label = 'finding frames…';
    rest.lazy = async () => {
      await doc.runScan();
    };
    root.add(rest);
    doc.loadSamples = (cb) => doc.runScan(cb);
  }
  return doc;
}

const FORMAT = {
  id: 'es',
  name: 'Elementary stream',
  unit: ['NAL unit', 'NAL units'],
  limits: { scanAtOpen: SCAN_AT_OPEN }, // tests lower it to exercise the background walk
  primer: [
    'An elementary stream is the encoder\'s output with nothing around it. For H.264 and HEVC that is a series of NAL units, each introduced by a start code (00 00 01, often with one more 00 in front); for MPEG-2 video a series of headers and slices introduced by 00 00 01 and a code byte.',
    'There is no container, so there are no timestamps, no index and no other tracks. A player finds frames by scanning for start codes, works out the display order from each picture\'s order count (POC), and takes the frame rate from the timing information in the SPS, or guesses it.',
    'Vidscope groups the NAL units into access units (one per coded picture, listed as frames) the way a decoder does. Open a frame to see its NAL units: parameter sets (VPS, SPS, PPS), SEI messages, and the slices that hold the picture.',
  ],
  probe,
  open,
};

function ordinal(n) {
  const t = n % 100;
  if (t >= 11 && t <= 13) return 'th';
  return ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th';
}

export default FORMAT;
