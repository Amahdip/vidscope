// FLV (Flash Video), including Enhanced RTMP FourCC tags (HEVC, AV1, VP9, Opus...).
//
// open() reads the header and the first tags (onMetaData and the decoder
// configurations are always at the start); the remaining tags are listed lazily
// in groups. loadSamples() walks every tag once to build the frame tables.

import { Node, fieldsAt } from '../../core/model.js';
import { Doc } from '../../core/doc.js';
import { fmtInt, fmtNum, fmtDuration, fmtHz, fmtBitrate, hex } from '../../core/util.js';
import { parseSample } from '../../codecs/index.js';
import { parseMpegAudioHeader } from '../../codecs/audio.js';
import { CHANNEL_CONFIG } from '../../codecs/mpeg4audio.js';
import { FrameIndex, Grow, median } from '../../core/scan.js';
import { headerNodes, tagNode, codecName, codecHeader } from './tags.js';
import { scanTags, headOf } from './scan.js';
import { insights } from './insights.js';
import { glossary } from './glossary.js';

const HEAD_TAGS = 16;
const HEAD_BYTES = 512 << 10;
const GROUP = 500;
const PEEK = 64;
const MAX_WHOLE_TAG = 4 << 20;
const MAX_SAMPLE_READ = 16 << 20;
const KIND_LABEL = { video: 'Video', audio: 'Audio' };

function probe(head) {
  if (head.length < 9) return 0;
  if (head[0] !== 0x46 || head[1] !== 0x4c || head[2] !== 0x56) return 0;
  const version = head[3];
  const offset = (head[5] << 24) | (head[6] << 16) | (head[7] << 8) | head[8];
  if (version === 1 && offset >= 9) return 100;
  return version >= 1 && version <= 4 ? 60 : 30;
}

class FlvDoc extends Doc {
  constructor(o) {
    super(o);
    this.unitCache = new Map();
  }

  overlay(a, b) {
    return this.frameIndex?.count ? this.frameIndex.runs(a, b, this.unitCache) : null;
  }

  async ensureUnits(a, b) {
    const idx = this.frameIndex;
    if (!idx || !idx.count) return false;
    let changed = false;
    for (let k = idx.firstEndingAfter(a), n = 0; k < idx.count && idx.starts[k] < b && n < 64; k++, n++) {
      const key = `${idx.track[k]}:${idx.sample[k]}`;
      if (this.unitCache.has(key)) continue;
      await this.sampleUnits(this.tracks[idx.track[k]], idx.sample[k]);
      changed = true;
    }
    return changed;
  }

  frameCodec(t) {
    const cfg = t.configs?.[0]?.cfg;
    if (t.family) return { family: t.family, lengthSize: cfg?.lengthSize ?? 4, annexB: false, state: cfg?.state ?? null };
    const legacy = { 2: 'h263s', 4: 'vp6', 5: 'vp6a' }[t.h?.codecId];
    return t.kind === 'video' && legacy ? { family: legacy } : null;
  }

  /** The decoder configuration in effect for a frame (the last one sent before it). */
  configFor(t, offset) {
    let cfg = null;
    for (const c of t.configs ?? []) if (c.offset < offset) cfg = c.cfg;
    return cfg ?? t.configs?.[0]?.cfg ?? null;
  }

  async sampleUnits(t, i) {
    const key = `${t.index}:${i}`;
    const hit = this.unitCache.get(key);
    if (hit) return hit;
    const s = t.samples;
    let units = [];
    const cfg = this.configFor(t, s.offsets[i]);
    const family = t.family;
    if (family && s.sizes[i]) {
      const sampleCfg = { family, lengthSize: cfg?.lengthSize ?? 4, state: cfg?.state };
      if (family === 'avc' || family === 'hevc') {
        sampleCfg.state = { spsById: new Map(cfg?.state?.spsById ?? []), ppsById: new Map(cfg?.state?.ppsById ?? []) };
      } else if (family === 'av1') sampleCfg.state = { ...(cfg?.state ?? {}) };
      const bytes = await this.source.read(s.offsets[i], Math.min(s.sizes[i], MAX_SAMPLE_READ));
      const res = parseSample(sampleCfg, bytes, 0, bytes.length, s.offsets[i]);
      units = res.units;
      if (res.error) units.error = res.error;
    }
    if (this.unitCache.size > 512) this.unitCache.delete(this.unitCache.keys().next().value);
    this.unitCache.set(key, units);
    return units;
  }

  async detailAt(offset) {
    const idx = this.frameIndex;
    const k = idx?.count ? idx.find(offset) : -1;
    if (k < 0) {
      const node = this.nodeAt(offset);
      if (node?.type === 'tags' || node?.kind === 'group') {
        return { kind: 'gap', title: 'Tag data', text: 'Open this group to see the individual tags.', range: [node.offset, node.end], rows: [] };
      }
      return null;
    }
    const t = this.tracks[idx.track[k]];
    const i = idx.sample[k];
    const s = t.samples;
    const units = await this.sampleUnits(t, i);
    const tagAt = s.tags[i];
    const rows = [
      ['track', t.label],
      [t.kind === 'video' ? 'frame' : 'audio frame', `${fmtInt(i + 1)} of ${fmtInt(s.count)}`],
      ['tag', `at ${fmtInt(tagAt)} (${hex(tagAt)}), ${fmtInt(s.sizes[i] + (s.offsets[i] - tagAt - 11) + 11)} bytes with its header`],
      ['codec data', `${fmtInt(s.sizes[i])} bytes at ${fmtInt(s.offsets[i])} (${hex(s.offsets[i])})`],
      ['timestamp (DTS)', `${fmtInt(s.dts[i])} ms → ${fmtDuration(s.dts[i] / 1000)}`],
    ];
    if (s.cto) rows.push(['presentation (PTS)', `${fmtInt(s.dts[i] + s.cto[i])} ms (CompositionTime ${fmtInt(s.cto[i])} ms)`]);
    rows.push(['duration', `${fmtNum(s.durations[i], 3)} ms (to the next frame of this track)`]);
    if (t.kind === 'video') rows.push(['key frame', s.key[i] ? 'yes (FrameType 1: decoding can start here)' : 'no (FrameType 2: needs earlier frames)']);
    const d = {
      kind: 'sample',
      title: `${t.kind === 'video' ? 'Frame' : 'Audio frame'} ${fmtInt(i + 1)} · ${t.label}`,
      subtitle: t.codecName,
      range: [s.offsets[i], s.offsets[i] + s.sizes[i]],
      rows,
      units,
      track: t,
      sample: i,
      text: units.length ? null : 'Vidscope does not look inside frames of this codec; the data is shown as one block.',
    };
    const u = units.findIndex((x) => offset >= x.offset && offset < x.offset + x.size);
    if (u >= 0) d.hit = { unit: u, fields: fieldsAt({ fields: units[u].fields, _leaves: null }, offset) };
    return d;
  }

  loadSamples(onProgress) {
    if (!this._loading) this._loading = loadAll(this, onProgress);
    return this._loading;
  }

  async insights() {
    return insights(this);
  }

  glossary() {
    return glossary(this);
  }
}

// ------------------------------------------------------------ tracks

function ensureTrack(doc, kind, h) {
  let t = doc.tracks.find((x) => x.kind === kind);
  if (t) return t;
  const n = doc.tracks.filter((x) => x.kind === kind).length + 1;
  t = {
    id: doc.tracks.length,
    index: doc.tracks.length,
    kind,
    codec: h.enhanced ? h.fourcc : kind === 'video' ? `CodecID ${h.codecId}` : `SoundFormat ${h.soundFormat}`,
    codecName: codecName(h),
    family: h.family ?? null,
    label: `${KIND_LABEL[kind]} ${n} – ${h.enhanced ? h.fourcc.trim() : codecName(h).replace(/ \(.*\)$/, '')}`,
    configs: [],
    h,
    props: [],
    timescale: 1000,
  };
  t.sampleCfg = { family: t.family };
  doc.tracks.push(t);
  return t;
}

function addConfig(t, offset, cfg) {
  if (t.configs.some((c) => c.offset === offset)) return;
  t.configs.push({ offset, cfg });
  t.configs.sort((a, b) => a.offset - b.offset);
  const first = t.configs[0].cfg;
  if (first.codecString) t.codecString = first.codecString;
  if (first.profile) t.profile = first.profile;
  if (first.sps) t.sps = first.sps;
  if (first.asc) t.asc = first.asc;
  if (first.opus) t.opus = first.opus;
  if (first.lengthSize) t.sampleCfg.lengthSize = first.lengthSize;
  if (first.state) t.sampleCfg.state = first.state;
}

function trackProps(doc, t) {
  const p = [];
  const h = t.h;
  const m = doc.meta ?? {};
  p.push(['codec', `${t.codecName}${h.enhanced ? ` (Enhanced RTMP FourCC '${h.fourcc}')` : t.kind === 'video' ? ` (CodecID ${h.codecId})` : ` (SoundFormat ${h.soundFormat})`}`]);
  if (t.codecString) p.push(['codec string', t.codecString]);
  if (t.profile) p.push(['profile', t.profile]);
  if (t.kind === 'video') {
    if (t.sps?.width) p.push(['coded size', `${t.sps.width}×${t.sps.height}${m.width && (m.width !== t.sps.width || m.height !== t.sps.height) ? ` (onMetaData says ${m.width}×${m.height})` : ''}`]);
    else if (m.width) p.push(['coded size', `${m.width}×${m.height} (from onMetaData)`]);
    if (t.fps) p.push(['frame rate', `${fmtNum(t.fps, 3)} fps (measured from timestamps)${m.framerate ? `, onMetaData says ${fmtNum(m.framerate, 3)}` : ''}`]);
    else if (m.framerate) p.push(['frame rate', `${fmtNum(m.framerate, 3)} fps (from onMetaData)`]);
    if (t.sps) p.push(['chroma / depth', `${['4:0:0', '4:2:0', '4:2:2', '4:4:4'][t.sps.chroma_format_idc] ?? '?'}, ${t.sps.bit_depth_luma}-bit`]);
  } else {
    if (t.asc) {
      p.push(['sample rate', fmtHz(t.asc.extSampleRate || t.asc.sampleRate)]);
      p.push(['channels', CHANNEL_CONFIG[t.asc.channelConfig] ?? String(t.asc.channels)]);
    } else if (t.opus) {
      p.push(['sample rate', '48 kHz (Opus always decodes at 48 kHz)']);
      p.push(['channels', String(t.opus.channels)]);
    } else if (t.mpa?.sampleRate) {
      p.push(['sample rate', `${fmtHz(t.mpa.sampleRate)} (from the MP3 frame header)`]);
      p.push(['channels', ['stereo', 'joint stereo', 'dual channel', 'mono'][t.mpa.mode] ?? '?']);
      p.push(['bitrate (first frame)', fmtBitrate(t.mpa.bitrate)]);
    } else if (!h.enhanced) {
      const rate = h.soundFormat === 4 ? 16000 : h.soundFormat === 5 || h.soundFormat === 7 || h.soundFormat === 8 ? 8000 : h.soundFormat === 11 ? 16000 : [5512.5, 11025, 22050, 44100][h.rate];
      p.push(['sample rate', `${fmtHz(rate)} (from the tag header)`]);
      p.push(['channels', h.stereo ? 'stereo' : 'mono']);
    }
    if (!h.enhanced) p.push(['tag header', `SoundRate ${['5.5', '11', '22', '44'][h.rate]} kHz, SoundSize ${h.size16 ? 16 : 8}-bit, SoundType ${h.stereo ? 'stereo' : 'mono'}${h.soundFormat === 10 ? ' (fixed values for AAC)' : ''}`]);
  }
  p.push(['timescale', '1000 / s (FLV timestamps are milliseconds)']);
  const s = t.samples;
  if (s) {
    if (t.duration) p.push(['duration', fmtDuration(t.duration)]);
    p.push([t.kind === 'video' ? 'frames' : 'audio frames', fmtInt(s.count)]);
    if (t.kind === 'video') p.push(['key frames', `${fmtInt(t.keyframes)}${t.keyframes ? ` (every ${fmtNum(s.count / t.keyframes, 1)} frames on average)` : ''}`]);
    if (t.bytes) p.push(['media bytes', `${fmtInt(t.bytes)} (${((t.bytes / doc.size) * 100).toFixed(2)}% of file)`]);
    if (t.bitrate) p.push(['average bitrate', fmtBitrate(t.bitrate)]);
    if (s.cto) p.push(['reordering', 'yes (CompositionTime offsets: B-frames)']);
  }
  if (t.configs.length > 1) p.push(['configurations', `${t.configs.length} sequence headers (the stream parameters change)`]);
  return p;
}

// ------------------------------------------------------------ samples

function buildSamples(doc, scan) {
  const per = new Map();
  const frameOf = new Int32Array(scan.count).fill(-1);
  let enhanced = false;
  for (let k = 0; k < scan.count; k++) {
    const type = scan.types[k];
    if (type !== 8 && type !== 9) continue;
    const h = headOf(scan, k);
    if (h.enhanced) enhanced = true;
    if (h.frameType === undefined && h.soundFormat === undefined) continue;
    const t = ensureTrack(doc, h.kind, h);
    if (!h.isFrame || scan.flags[k]) continue;
    const size = scan.sizes[k] - h.headerLen;
    if (size <= 0) continue;
    let a = per.get(t);
    if (!a) {
      a = { off: new Grow(Float64Array), size: new Grow(Uint32Array), dts: new Grow(Float64Array), cto: new Grow(Int32Array), key: new Grow(Uint8Array), tag: new Grow(Float64Array), anyCto: false };
      per.set(t, a);
    }
    frameOf[k] = a.off.n;
    a.off.push(scan.offs[k] + 11 + h.headerLen);
    a.size.push(size);
    a.dts.push(scan.ts[k]);
    a.cto.push(h.cts);
    if (h.cts) a.anyCto = true;
    a.key.push(h.key ? 1 : 0);
    a.tag.push(scan.offs[k]);
  }
  for (const [t, a] of per) {
    const n = a.off.n;
    const dts = a.dts.done();
    const durations = new Float64Array(n);
    const deltas = [];
    for (let i = 0; i + 1 < n; i++) {
      durations[i] = dts[i + 1] - dts[i];
      if (deltas.length < 1000) deltas.push(durations[i]);
    }
    if (n) durations[n - 1] = n > 1 ? median(deltas) : 0;
    t.samples = {
      count: n,
      timescale: 1000,
      offsets: a.off.done(),
      sizes: a.size.done(),
      dts,
      cto: a.anyCto || t.h.hasCts ? a.cto.done() : null,
      durations,
      key: a.key.done(),
      tags: a.tag.done(),
    };
  }
  doc.frameOfTag = frameOf;
  doc.enhanced = enhanced || doc.enhanced;
}

function trackStats(t) {
  const s = t.samples;
  if (!s || !s.count) return;
  let bytes = 0;
  let keys = 0;
  for (let i = 0; i < s.count; i++) {
    bytes += s.sizes[i];
    keys += s.key[i];
  }
  t.bytes = bytes;
  t.keyframes = keys;
  const last = s.count - 1;
  t.start = s.dts[0] / 1000;
  t.end = (s.dts[last] + s.durations[last]) / 1000;
  t.duration = t.end - t.start;
  if (t.duration > 0) t.bitrate = (bytes * 8) / t.duration;
  if (t.kind === 'video' && s.count > 1) {
    const d = median(Array.from(s.durations.subarray(0, Math.min(s.count - 1, 2000))));
    if (d > 0) t.fps = 1000 / d;
  }
}

async function loadAll(doc, onProgress) {
  const ctx = doc.ctx;
  const scan = await scanTags(ctx, ctx.bodyStart, onProgress);
  doc.scan = scan;
  buildSamples(doc, scan);
  for (const t of doc.tracks) if (!t.node) t.node = doc.restNode ?? doc.root.children?.[0];
  for (const c of scan.configs) {
    const t = ensureTrack(doc, c.kind, c.h);
    addConfig(t, c.offset, c.cfg);
  }
  const meta = scan.scripts.find((s) => s.kind === 'script' && s.name === 'onMetaData');
  if (meta && meta.value && typeof meta.value === 'object') doc.meta = meta.value;
  for (const t of doc.tracks) {
    trackStats(t);
    if (t.family === 'mp3' && t.samples?.count) {
      const s = t.samples;
      const bytes = await doc.source.read(s.offsets[0], Math.min(s.sizes[0], 8));
      const mpa = parseMpegAudioHeader(bytes, 0, bytes.length, s.offsets[0], []);
      if (mpa.sampleRate) t.mpa = mpa;
    }
    t.props = trackProps(doc, t);
  }
  doc.frameIndex = new FrameIndex(doc.tracks);
  const ends = doc.tracks.map((t) => t.end ?? 0);
  const starts = doc.tracks.filter((t) => t.start !== undefined).map((t) => t.start);
  const dur = Math.max(0, ...ends) - (starts.length ? Math.min(...starts) : 0);
  if (dur > 0) doc.summary.duration = dur;
  doc.summary.unitCount = scan.count;
  if (doc.enhanced) doc.summary.label = 'FLV (Enhanced RTMP)';
  const g = doc.restNode;
  if (g) {
    const first = doc.headCount;
    g.label = scan.count > first ? `#${fmtInt(first + 1)}–#${fmtInt(scan.count)}${timeRange(scan, first, scan.count - 1)}` : 'no further tags';
  }
  doc.recount();
}

function timeRange(scan, a, b) {
  if (b < a) return '';
  return ` · ${fmtDuration(scan.ts[a] / 1000)}–${fmtDuration(scan.ts[b] / 1000)}`;
}

// ------------------------------------------------------------ lazy tag groups

async function addTags(doc, parent, from, to, limit) {
  const scan = doc.scan;
  const ctx = doc.ctx;
  let pos = parent.offset;
  for (let k = from; k < to; k++) {
    const off = scan.offs[k];
    if (off > pos) gapNode(doc, parent, pos, off);
    const h = headOf(scan, k);
    const whole = !h.isFrame && scan.sizes[k] <= MAX_WHOLE_TAG;
    const want = Math.min(whole ? 11 + scan.sizes[k] + 4 : Math.min(11 + scan.sizes[k], 11 + PEEK), limit - off);
    const buf = await ctx.source.read(off, want);
    const extra = { prev: scan.prev[k] >= 0 ? scan.prev[k] : undefined, frame: doc.frameOfTag?.[k] >= 0 ? doc.frameOfTag[k] : undefined };
    const res = tagNode(ctx, parent, buf, off, 0, buf.length, extra);
    pos = res.node.end;
  }
  return pos;
}

function gapNode(doc, parent, a, b) {
  const g = doc.scan.garbage.find((x) => x.start <= a && x.end >= b);
  const node = new Node({ type: 'garbage', name: 'Unparsed bytes', kind: 'region', offset: a, size: b - a, category: 'unknown' });
  node.def = {
    name: 'Unparsed bytes',
    cat: 'unknown',
    desc: 'Bytes that do not form a valid tag.',
    more: 'A player reading tag by tag loses sync here. Vidscope (like FFmpeg) searched forward for the next position where a tag header and its PreviousTagSize agree, and continues from there.',
  };
  node.warn(g?.resynced === false ? `${fmtInt(b - a)} bytes at the end of the file do not form a tag.` : `${fmtInt(b - a)} bytes that do not form a tag; parsing resumed at ${hex(b)}.`);
  parent.add(node);
}

function restLoader(doc) {
  return async (node) => {
    await doc.loadSamples();
    const scan = doc.scan;
    const first = doc.headCount;
    const count = scan.count - first;
    if (count <= GROUP * 2) {
      const end = await addTags(doc, node, first, scan.count, node.end);
      if (end < node.end) gapNode(doc, node, end, node.end);
    } else {
      for (let k = first; k < scan.count; k += GROUP) {
        const last = Math.min(scan.count, k + GROUP);
        const a = scan.offs[k];
        const lastEnd = last < scan.count ? scan.offs[last] : Math.min(node.end, scan.end);
        const g = new Node({ type: 'tags', name: 'Group of tags', kind: 'group', offset: a, size: lastEnd - a, category: 'media' });
        g.def = {
          name: 'Group of tags',
          cat: 'media',
          desc: 'A run of consecutive tags. Vidscope groups them because an FLV file can hold hundreds of thousands of tags; the grouping is not part of the file.',
        };
        g.label = `#${fmtInt(k + 1)}–#${fmtInt(last)}${timeRange(scan, k, last - 1)}`;
        const from = k;
        g.lazy = async (gn) => {
          const end = await addTags(doc, gn, from, last, gn.end);
          if (end < gn.end) gapNode(doc, gn, end, gn.end);
          doc.recount();
        };
        node.add(g);
      }
      const tailStart = Math.min(node.end, scan.end);
      if (tailStart < node.end) gapNode(doc, node, tailStart, node.end);
    }
    doc.recount();
  };
}

// ------------------------------------------------------------ open

function codecHeaderAt(buf, type, dataSize) {
  return codecHeader(type, buf, 11, Math.max(0, Math.min(buf.length - 11, dataSize)), dataSize);
}

async function open(source) {
  const root = new Node({ type: source.name, name: source.name, kind: 'file', offset: 0, size: source.size, category: 'file' });
  const doc = new FlvDoc({ source, format: FORMAT, root });
  const ctx = { source, doc };
  doc.ctx = ctx;
  const head = await source.read(0, Math.min(source.size, 64 << 10));
  const hdr = headerNodes(ctx, root, head);
  doc.header = hdr;
  ctx.bodyStart = hdr.bodyStart;
  // The first tags: onMetaData and the decoder configurations come first.
  let pos = hdr.bodyStart;
  let n = 0;
  const frames = { video: 0, audio: 0 };
  while (pos + 11 <= source.size && n < HEAD_TAGS && pos < HEAD_BYTES) {
    const h11 = await source.read(pos, 11);
    const type = h11[0] & 0x1f;
    const dataSize = (h11[1] << 16) | (h11[2] << 8) | h11[3];
    if ((type !== 8 && type !== 9 && type !== 18) || (h11[0] & 0xc0) || h11[8] || h11[9] || h11[10]) break;
    const tagEnd = pos + 11 + dataSize;
    if (tagEnd + 4 > source.size) break;
    // Frames: the header and codec header are enough. Other tags (metadata, configurations) are read whole.
    let buf = await source.read(pos, Math.min(11 + dataSize, 11 + PEEK));
    const peek = codecHeaderAt(buf, type, dataSize);
    if (!peek.isFrame && dataSize <= MAX_WHOLE_TAG) buf = await source.read(pos, 11 + dataSize + 4);
    const extra = peek.isFrame && !(h11[0] & 0x20) ? { frame: frames[peek.kind]++ } : {};
    if (buf.length < 11 + dataSize + 4) {
      const pts = await source.read(tagEnd, 4);
      if (pts.length === 4) extra.prev = ((pts[0] << 24) | (pts[1] << 16) | (pts[2] << 8) | pts[3]) >>> 0;
    }
    const res = tagNode(ctx, root, buf, pos, 0, buf.length, extra);
    const h = res.h;
    if (h.kind === 'video' || h.kind === 'audio') {
      if (h.frameType !== undefined || h.soundFormat !== undefined) {
        const t = ensureTrack(doc, h.kind, h);
        if (!t.node) t.node = res.node;
        if (res.config) addConfig(t, pos, res.config);
      }
      if (h.enhanced) doc.enhanced = true;
    }
    if (res.meta && h.kind === 'script' && res.meta.name === 'onMetaData' && res.meta.value && typeof res.meta.value === 'object') doc.meta = res.meta.value;
    n++;
    pos = res.node.end;
  }
  doc.headCount = n;
  if (pos < source.size) {
    const rest = new Node({ type: 'tags', name: 'Remaining tags', kind: 'group', offset: pos, size: source.size - pos, category: 'media' });
    rest.def = {
      name: 'Remaining tags',
      cat: 'media',
      desc: 'The rest of the file: the audio and video tags after the first few. They are listed (in groups) once Vidscope has walked the whole file, which FLV requires because it has no index.',
    };
    rest.label = 'loading…';
    rest.lazy = restLoader(doc);
    root.add(rest);
    doc.restNode = rest;
  }
  for (const t of doc.tracks) t.props = trackProps(doc, t);
  const m = doc.meta;
  if (m && typeof m.duration === 'number' && m.duration > 0) doc.summary.duration = m.duration;
  const label = doc.enhanced ? 'FLV (Enhanced RTMP)' : 'FLV (Flash Video)';
  doc.summary.label = label;
  doc.summary.anatomy = 'FLV anatomy';
  return doc;
}

const FORMAT = {
  id: 'flv',
  name: 'FLV (Flash Video)',
  unit: ['tag', 'tags'],
  probe,
  open,
};

export default FORMAT;
