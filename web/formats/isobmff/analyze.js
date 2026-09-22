// Turns the parsed box tree into tracks, sample tables, labels and a summary.

import { fmtInt, fmtNum, fmtHz, fmtBitrate, fmtDuration, ratio } from '../../core/util.js';
import { walk } from '../../core/model.js';
import { samplesFromStbl, samplesFromFragments, concatSamples, SampleIndex } from './samples.js';
import { handlerName, matrixRotation } from './boxes.js';
import { codecDisplayName } from './entries.js';
import { codecFamily } from '../../codecs/index.js';
import { profileName as avcProfile, levelName as avcLevel } from '../../codecs/h264.js';
import { PROFILES as HEVC_PROFILES, levelName as hevcLevel } from '../../codecs/h265.js';
import { aacName, CHANNEL_CONFIG } from '../../codecs/mpeg4audio.js';
import { colourSummary } from '../../codecs/color.js';

const KIND_BY_HANDLER = {
  vide: 'video', soun: 'audio', subt: 'subtitle', sbtl: 'subtitle', text: 'subtitle', clcp: 'subtitle',
  tmcd: 'timecode', meta: 'data', hint: 'hint', auxv: 'video',
};

const KIND_LABEL = { video: 'Video', audio: 'Audio', subtitle: 'Subtitle', timecode: 'Timecode', data: 'Data', hint: 'Hint' };

/** Format label from the brands, e.g. "MP4 / ISO-BMFF", "MOV / QuickTime", "HEIF". */
export function formatLabel(ctx, root) {
  const major = ctx.brands?.major?.trim();
  const all = new Set([ctx.brands?.major, ...(ctx.brands?.compatible ?? [])].filter(Boolean).map((b) => b.trim()));
  const fragmented = !!root.child('moof') || !!root.child('moov')?.child('mvex');
  if (!ctx.brands) {
    if (root.child('styp')) return 'fMP4 segment (styp)';
    if (root.child('moof')) return 'fMP4 segment';
    return 'MOV / QuickTime (no ftyp)';
  }
  if (major === 'qt') return 'MOV / QuickTime';
  if (major === 'avif' || major === 'avis') return 'AVIF';
  if (['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'mif1', 'msf1'].includes(major) && root.child('meta')) return 'HEIF / HEIC';
  if (major === 'crx') return 'Canon CR3 (ISO-BMFF)';
  if (/^M4[ABP]$/.test(major)) return 'M4A / MPEG-4 audio';
  if (major === 'M4V' || major === 'M4VH' || major === 'M4VP') return 'M4V / MPEG-4 video';
  if (/^3g/.test(major)) return '3GP / 3GPP';
  if (major === 'f4v') return 'F4V (Flash MP4)';
  if (major === 'mjp2') return 'Motion JPEG 2000';
  if (fragmented && (all.has('cmfc') || all.has('cmf2') || all.has('cmfs'))) return 'CMAF / fragmented MP4';
  if (fragmented && (all.has('dash') || all.has('msdh') || all.has('msix') || all.has('iso5') || all.has('iso6'))) return 'fMP4 / DASH';
  if (fragmented) return 'Fragmented MP4';
  return 'MP4 / ISO-BMFF';
}

function trackEntry(trak) {
  const stsd = trak.find('stsd');
  return stsd?.children?.find((c) => c.data.entry) ?? null;
}

export function analyze(doc, ctx) {
  const root = doc.root;
  const moov = root.child('moov');
  const tracks = [];
  const kindCount = {};
  const byId = new Map();
  const trex = new Map();
  for (const t of moov?.find('mvex')?.childrenOf('trex') ?? []) trex.set(t.data.trackId, t.data);

  for (const trak of moov?.childrenOf('trak') ?? []) {
    const tkhd = trak.child('tkhd');
    const mdhd = trak.find('mdhd');
    const hdlr = trak.child('mdia')?.child('hdlr');
    const entryNode = trackEntry(trak);
    const entry = entryNode?.data.entry ?? {};
    const handler = hdlr?.data.handler ?? '';
    const kind = entry.kind === 'timecode' ? 'timecode' : KIND_BY_HANDLER[handler] ?? entry.kind ?? 'data';
    kindCount[kind] = (kindCount[kind] ?? 0) + 1;
    const fourcc = entryNode?.type ?? '?';
    const codec = entry.originalFormat ?? fourcc;
    const track = {
      id: tkhd?.data.trackId ?? tracks.length + 1,
      index: tracks.length,
      kind,
      handler,
      node: trak,
      entryNode,
      entry,
      fourcc,
      codec,
      codecName: codecDisplayName(codec) ?? codec,
      encrypted: fourcc === 'encv' || fourcc === 'enca' || fourcc === 'enct',
      timescale: mdhd?.data.timescale ?? 0,
      language: trak.find('elng')?.data.language ?? mdhd?.data.language ?? null,
      name: hdlr?.data.name ?? '',
    };
    track.label = `${KIND_LABEL[kind] ?? kind} ${kindCount[kind]} – ${fourcc.trim()}`;
    trak.label = track.label;
    track.duration = track.timescale && mdhd ? mdhd.data.duration / track.timescale : null;

    // Codec details
    const cfg = { family: codecFamily(codec) };
    if (entry.avc) {
      cfg.lengthSize = entry.avc.lengthSize;
      cfg.state = { spsById: new Map(entry.avc.spsById), ppsById: new Map(entry.avc.ppsById) };
      track.codecString = entry.avc.codec.replace(/^[a-z0-9]{4}/i, codec);
      track.profile = `${avcProfile(entry.avc.profile, entry.avc.compat)}@L${avcLevel(entry.avc.level, entry.avc.compat, entry.avc.profile)}`;
      track.sps = entry.avc.sps[0];
    } else if (entry.hevc) {
      cfg.lengthSize = entry.hevc.lengthSize;
      cfg.state = { spsById: new Map(entry.hevc.spsById), ppsById: new Map(entry.hevc.ppsById) };
      track.codecString = entry.hevc.codec.replace(/^[a-z0-9]{4}/i, codec);
      track.profile = `${HEVC_PROFILES[entry.hevc.profile_idc] ?? entry.hevc.profile_idc}@L${hevcLevel(entry.hevc.level_idc)}${entry.hevc.tier ? ' High' : ''}`;
      track.sps = entry.hevc.sps[0];
    } else if (entry.av1) {
      cfg.state = { seq: entry.av1.seq };
      track.codecString = entry.av1.codec;
      track.profile = `profile ${entry.av1.seq_profile}`;
    } else if (entry.vp) {
      track.codecString = entry.vp.codec;
    } else if (entry.esds) {
      track.codecString = entry.esds.codec;
      if (entry.esds.oti === 0x6b || entry.esds.oti === 0x69) cfg.family = 'mp3';
      if (entry.esds.asc) track.profile = aacName(entry.esds.asc);
    } else if (entry.opus) track.codecString = 'opus';
    else if (entry.ac3) track.codecString = 'ac-3';
    else if (entry.ec3) track.codecString = 'ec-3';
    else if (entry.flac) track.codecString = 'flac';
    if (track.encrypted) cfg.encrypted = true;
    if (entry.kind === 'timecode') cfg.tmcd = entry;
    track.sampleCfg = cfg;

    // Samples
    track.samples = samplesFromStbl(trak, track.timescale);
    track.trex = trex.get(track.id);
    tracks.push(track);
    byId.set(track.id, track);
  }

  // Movie fragments
  if (root.child('moof')) {
    const info = new Map(tracks.map((t) => [t.id, { timescale: t.timescale, trex: t.trex }]));
    const frag = samplesFromFragments(root, info);
    for (const [id, s] of frag) {
      const t = byId.get(id);
      if (!t) continue;
      t.samples = concatSamples(t.samples?.count ? t.samples : null, s);
    }
    doc.fragmented = true;
    let n = 0;
    for (const moof of root.childrenOf('moof')) {
      const seq = moof.child('mfhd')?.data.seq;
      moof.label = seq !== undefined ? `#${seq}` : `#${++n}`;
    }
  }

  // Derived per-track numbers and property lists
  for (const t of tracks) {
    const s = t.samples;
    if (s && s.count) {
      let bytes = 0;
      for (let i = 0; i < s.count; i++) bytes += s.sizes[i];
      t.bytes = bytes;
      let ticks = 0;
      for (let i = 0; i < s.count; i++) ticks += s.durations[i];
      t.mediaDuration = t.timescale ? ticks / t.timescale : null;
      if (!t.duration && t.mediaDuration) t.duration = t.mediaDuration;
      if (t.duration) t.bitrate = (bytes * 8) / t.duration;
      if (s.key) {
        let k = 0;
        for (let i = 0; i < s.count; i++) k += s.key[i];
        t.keyframes = k;
      } else t.keyframes = s.count;
      if (t.kind === 'video' && t.timescale && s.count > 1) {
        t.fps = (s.count / ticks) * t.timescale;
        let min = Infinity;
        let max = 0;
        for (let i = 0; i < s.count - 1; i++) {
          const d = s.durations[i];
          if (d < min) min = d;
          if (d > max) max = d;
        }
        t.vfr = max > min * 1.05 + 1;
      }
    }
    t.props = trackProps(t, doc);
  }

  // Labels shown next to boxes in the tree
  for (const n of walk(root)) {
    if (n.label) continue;
    const p = n.parent?.type;
    if ((p === 'stsd' || p === 'ilst' || n.def?.id?.startsWith('qttext') || p === 'tref') && n.data.summary) n.label = n.data.summary;
    else if (n.type === 'traf') {
      const id = n.child('tfhd')?.data.trackId;
      const t = byId.get(id);
      n.label = t ? t.label : id !== undefined ? `track ${id}` : '';
    } else if (n.type === 'hdlr' && n.parent?.type === 'mdia') n.label = n.data.handler;
  }

  doc.tracks = tracks;
  doc.tracksById = byId;
  try {
    doc.sampleIndex = new SampleIndex(tracks);
  } catch (e) {
    doc.warnings.push({ msg: `Could not index samples: ${e.message}` });
  }

  // Summary for the header line
  const mvhd = moov?.child('mvhd');
  let duration = mvhd?.data.timescale ? mvhd.data.duration / mvhd.data.timescale : null;
  if (!duration || duration > 1e9) duration = tracks.reduce((m, t) => Math.max(m, t.duration ?? 0), 0) || null;
  const label = formatLabel(ctx, root);
  doc.summary = { label, anatomy: `${label} anatomy`, duration };
}

function trackProps(t, doc) {
  const p = [];
  const e = t.entry;
  p.push(['track ID', String(t.id)]);
  p.push(['codec', `${t.codecName}${t.codec !== t.fourcc ? ` (encrypted as '${t.fourcc}')` : ''}`]);
  if (t.codecString) p.push(['codec string', t.codecString]);
  if (t.profile) p.push(['profile', t.profile]);
  if (t.kind === 'video') {
    const w = t.sps?.width ?? e.width;
    const h = t.sps?.height ?? e.height;
    if (w) p.push(['coded size', `${w}×${h}${t.sps && e.width && (t.sps.width !== e.width || t.sps.height !== e.height) ? ` (sample entry says ${e.width}×${e.height})` : ''}`]);
    const tk = t.node.child('tkhd')?.data;
    if (tk?.width) p.push(['display size', `${fmtNum(tk.width, 2)}×${fmtNum(tk.height, 2)} (${ratio(Math.round(tk.width), Math.round(tk.height))})`]);
    if (e.pasp && e.pasp[0] !== e.pasp[1]) p.push(['pixel aspect', `${e.pasp[0]}:${e.pasp[1]}`]);
    const rot = matrixRotation(tk?.matrix);
    if (rot) {
      const w0 = Math.round(tk.width);
      const h0 = Math.round(tk.height);
      const how = rot === 90 ? '90° clockwise' : rot === 270 ? '90° counter-clockwise' : '180°';
      p.push(['rotation', `${how} (tkhd matrix)${rot !== 180 && w0 ? `: shown as ${h0}×${w0}` : ''}`]);
    }
    if (t.fps) p.push(['frame rate', `${fmtNum(t.fps, 3)} fps${t.vfr ? ' (variable)' : ''}`]);
    const sps = t.sps;
    if (sps) {
      p.push(['chroma / depth', `${['4:0:0', '4:2:0', '4:2:2', '4:4:4'][sps.chroma_format_idc] ?? '?'}, ${sps.bit_depth_luma}-bit`]);
      if (sps.frame_mbs_only === 0) p.push(['scan', 'interlaced']);
    }
    const c = e.colr ?? (sps?.vui?.transfer !== undefined ? sps.vui : null);
    if (c) p.push(['colour', `${colourSummary(c.primaries, c.transfer, c.matrix)}${c.full ?? c.full_range ? ', full range' : ''}`]);
    if (e.dolbyVision) p.push(['Dolby Vision', `profile ${e.dolbyVision.profile}, level ${e.dolbyVision.level}`]);
  }
  if (t.kind === 'audio') {
    const asc = e.esds?.asc;
    const rate = asc ? asc.extSampleRate || asc.sampleRate : e.opus ? 48000 : e.ac3?.sampleRate ?? e.ec3?.sampleRate ?? e.flac?.sampleRate ?? e.alac?.sampleRate ?? e.sampleRate;
    const ch = asc?.channels || e.opus?.channels || e.ac3?.channels || e.ec3?.channels || e.flac?.channels || e.alac?.channels || e.channels;
    p.push(['sample rate', fmtHz(rate)]);
    p.push(['channels', asc && CHANNEL_CONFIG[asc.channelConfig] ? CHANNEL_CONFIG[asc.channelConfig] : e.ac3?.layout ?? e.ec3?.layout ?? String(ch ?? '?')]);
    if (e.ec3?.atmos) p.push(['Dolby Atmos', 'yes (JOC)']);
    if (e.opus?.preSkip) p.push(['pre-skip', `${e.opus.preSkip} samples`]);
  }
  if (t.language && t.language !== 'und') p.push(['language', t.language]);
  if (t.name) p.push(['handler name', t.name]);
  p.push(['timescale', `${fmtInt(t.timescale)} / s`]);
  if (t.duration) p.push(['duration', fmtDuration(t.duration)]);
  const s = t.samples;
  if (s) {
    p.push(['samples', fmtInt(s.count)]);
    if (t.keyframes !== undefined && t.kind === 'video') p.push(['key frames', `${fmtInt(t.keyframes)}${t.keyframes && s.count ? ` (every ${fmtNum(s.count / t.keyframes, 1)} frames on average)` : ''}`]);
    if (t.bytes) p.push(['media bytes', `${fmtInt(t.bytes)} (${((t.bytes / doc.size) * 100).toFixed(2)}% of file)`]);
    if (t.bitrate) p.push(['average bitrate', fmtBitrate(t.bitrate)]);
    if (s.cto) p.push(['reordering', 'yes (composition offsets: B-frames)']);
  }
  if (t.encrypted) p.push(['encryption', `${e.scheme ?? 'yes'}${e.kid ? `, KID ${e.kid.replace(/-/g, '')}` : ''}`]);
  return p;
}
