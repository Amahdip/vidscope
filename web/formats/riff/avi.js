// Turns the parsed AVI chunks into tracks and frame tables.
//
// Frames come from an index: the OpenDML indexes (indx super index -> ix##
// standard indexes, covering every RIFF chunk) when present, else the legacy
// idx1. A file without an index is scanned in loadSamples().
//
// Timing follows how players (and FFmpeg's demuxer) interpret AVI, which has no
// timestamps: each stream counts in units of dwScale/dwRate seconds starting at
// dwStart. A chunk lasts one unit (video, or VBR audio), ceil(size / nBlockAlign)
// units (audio with dwSampleSize 0 and a block size), or, when dwSampleSize > 0,
// the number of bytes before it divided by dwSampleSize.

import { cell } from '../../core/fields.js';
import { fmtInt, fmtNum, fmtHz, fmtBitrate, fmtDuration, hex } from '../../core/util.js';
import { parseSample } from '../../codecs/index.js';
import { profileName as avcProfile, levelName as avcLevel, codecString as avcCodecString } from '../../codecs/h264.js';
import { PROFILES as HEVC_PROFILES, levelName as hevcLevel } from '../../codecs/h265.js';
import { parseMpegAudioHeader, parseAc3Header } from '../../codecs/audio.js';
import { aacName, CHANNEL_CONFIG } from '../../codecs/mpeg4audio.js';
import { Grow, FrameIndex, u32le, u32be, fccFromNum, WindowReader, tick } from '../../core/scan.js';
import { STREAM_KIND, mediaChunkInfo } from './chunks.js';
import { channelMaskText } from './tables.js';
import { parseMpeg4Visual, firstVopType } from '../../codecs/mpeg4v.js';
import { walkChunks } from './movi.js';

const KIND_LABEL = { video: 'Video', audio: 'Audio', subtitle: 'Subtitle', data: 'Data' };
const LIST = 0x5453494c;
const REC = 0x20636572; // 'rec '
const MAX_FIRST_FRAME = 1 << 20;

// ------------------------------------------------------------ timing

/** How a stream's chunks advance its clock (see the header comment). */
function clockOf(s) {
  const audio = s.type === 'auds';
  const block = audio ? s.audio?.blockAlign ?? 0 : 0;
  let sampleSize = s.sampleSize ?? 0;
  if (audio && sampleSize && block && sampleSize !== block) sampleSize = block;
  let scale = s.scale;
  let rate = s.rate;
  let fixed = false;
  if (!scale || !rate) {
    fixed = true;
    if (s.type === 'vids' && s.usPerFrame) {
      scale = s.usPerFrame;
      rate = 1e6;
    } else if (audio && s.audio?.sampleRate) {
      scale = 1;
      rate = s.audio.sampleRate;
    } else {
      scale = 1;
      rate = 25;
    }
  }
  return { mode: sampleSize > 0 ? 'bytes' : audio && block ? 'blocks' : 'frames', sampleSize, block, scale, rate, fixed };
}

/** Build a sample table from per-chunk offsets (of the data), sizes and key flags. */
export function buildSamples(s, offsets, sizes, keys, source, chunkId = null) {
  const n = offsets.length;
  const c = clockOf(s);
  const dts = new Float64Array(n);
  const durations = new Float64Array(n);
  let units = s.start ?? 0;
  let bytes = 0;
  for (let i = 0; i < n; i++) {
    const len = sizes[i];
    if (c.mode === 'bytes') {
      dts[i] = ((s.start ?? 0) + Math.floor(bytes / c.sampleSize)) * c.scale;
      bytes += len;
      durations[i] = (len / c.sampleSize) * c.scale;
    } else {
      dts[i] = units * c.scale;
      const d = c.mode === 'blocks' ? Math.ceil(len / c.block) : 1;
      units += d;
      durations[i] = d * c.scale;
    }
  }
  return {
    count: n,
    timescale: c.rate,
    offsets: Float64Array.from(offsets),
    sizes: Uint32Array.from(sizes),
    dts,
    durations,
    key: keys ? Uint8Array.from(keys) : null,
    fromIndex: source !== 'scan',
    source,
    chunkId,
    clock: c,
  };
}

// ------------------------------------------------------------ idx1

/** Decide whether idx1 offsets are relative to the movi list or absolute. */
async function idx1Base(ctx) {
  const t = ctx.idx1.table;
  const movi = ctx.movis[0];
  if (!t.count || !movi) return null;
  const moviFcc = movi.offset + 8;
  // Probe up to three entries spread over the index, preferring media chunks over 'rec ' lists.
  const probe = [];
  for (let k = 0; k < 3; k++) {
    let i = Math.floor((k * (t.count - 1)) / 2);
    for (let step = 0; step < 16 && i < t.count && cell(t, i, 1) & 1; step++) i++;
    if (i < t.count && !probe.includes(i)) probe.push(i);
  }
  const candidates = [moviFcc, 0, moviFcc + 4, movi.offset];
  for (const base of candidates) {
    let ok = true;
    for (const i of probe) {
      const id = u32le(t.u, t.rel + i * 16);
      const isList = cell(t, i, 1) & 1 || id === REC;
      const at = base + cell(t, i, 2);
      const h = await ctx.source.read(at, 12);
      if (h.length < 8 || (isList ? u32le(h, 0) !== LIST || (h.length >= 12 && u32le(h, 8) !== id) : u32le(h, 0) !== id)) {
        ok = false;
        break;
      }
    }
    if (ok) return { base, verified: true, absolute: base === 0 };
  }
  // Nothing matched: do what FFmpeg does and align the first entry with the first chunk.
  return { base: movi.offset + 12 - cell(t, 0, 2), verified: false, absolute: false };
}

function samplesFromIdx1(ctx, base) {
  const t = ctx.idx1.table;
  const rd = ctx.le ? u32le : u32be;
  const per = ctx.streams.map(() => ({ off: new Grow(Float64Array), size: new Grow(Uint32Array), key: new Grow(Uint8Array) }));
  let recs = 0;
  let unknown = 0;
  for (let i = 0; i < t.count; i++) {
    const p = t.rel + i * 16;
    const id = u32le(t.u, p); // FOURCCs are byte strings: read the same way in RIFF and RIFX
    const flags = rd(t.u, p + 4);
    if (id === REC || flags & 1) {
      recs++;
      continue;
    }
    const info = mediaChunkInfo(fccFromNum(id));
    if (!info || info.twocc === 'pc' || info.stream >= per.length) {
      unknown++;
      continue;
    }
    const a = per[info.stream];
    if (!a.id) a.id = fccFromNum(id);
    a.off.push(base + rd(t.u, p + 8) + 8);
    a.size.push(rd(t.u, p + 12));
    a.key.push(flags & 0x10 ? 1 : 0);
  }
  if (recs) ctx.hasRecLists = true;
  return { per, recs, unknown };
}

// ------------------------------------------------------------ OpenDML

async function readStdIndex(ctx, at, size, s, problems) {
  const head = await ctx.source.read(at, Math.max(32, Math.min(size || 32, 64 << 20)));
  if (head.length < 32) {
    problems.push(`index chunk at ${hex(at)} is cut off`);
    return null;
  }
  const dv = new DataView(head.buffer, head.byteOffset, head.byteLength);
  const le = ctx.le;
  const id = String.fromCharCode(head[0], head[1], head[2], head[3]);
  const cb = dv.getUint32(4, le);
  const longs = dv.getUint16(8, le);
  const type = head[11];
  const n = dv.getUint32(12, le);
  const base = Number(dv.getBigUint64(20, le));
  if (!/^(ix\d\d|\d\dix)$/.test(id) || type !== 1) {
    problems.push(`the super index points at ${hex(at)}, where there is '${id}' rather than a standard index`);
    return null;
  }
  let buf = head;
  const need = 8 + cb;
  if (buf.length < need) buf = await ctx.source.read(at, Math.min(need, 64 << 20));
  const entry = (longs || 2) * 4;
  const count = Math.min(n, Math.floor((buf.length - 32) / entry));
  if (count < n) problems.push(`index chunk at ${hex(at)} lists ${n} entries but holds ${count}`);
  ctx.ixOffsets.push(at);
  const bdv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  return { base, count, entry, dv: bdv, at, le };
}

async function samplesFromOdml(ctx, s) {
  const indx = s.indx;
  const off = new Grow(Float64Array);
  const size = new Grow(Uint32Array);
  const key = new Grow(Uint8Array);
  const problems = [];
  const parts = [];
  if (indx.type === 0 && indx.table) {
    for (let e = 0; e < indx.table.count; e++) {
      const at = cell(indx.table, e, 0);
      const sz = cell(indx.table, e, 1);
      const part = await readStdIndex(ctx, at, sz, s, problems);
      if (part) parts.push(part);
    }
  } else if (indx.type === 1 && indx.table) {
    const t = indx.table;
    parts.push({ base: indx.baseOffset, count: t.count, entry: t.entrySize, dv: t.dv, rel: t.rel, le: ctx.le });
  }
  for (const p of parts) {
    const start = p.rel ?? 32;
    for (let i = 0; i < p.count; i++) {
      const q = start + i * p.entry;
      const o = p.dv.getUint32(q, p.le);
      const z = p.dv.getUint32(q + 4, p.le);
      off.push(p.base + o);
      size.push(z & 0x7fffffff);
      key.push(z & 0x80000000 ? 0 : 1);
    }
  }
  if (!off.n) return { problems };
  return { off: off.done(), size: size.done(), key: key.done(), problems, parts: parts.length };
}

// ------------------------------------------------------------ scan (no index)

/** Walk every movi list (and rec lists inside) and collect the media chunks of each stream. */
export async function scanMovis(ctx, onProgress) {
  const per = ctx.streams.map(() => ({ off: new Grow(Float64Array), size: new Grow(Uint32Array), key: new Grow(Uint8Array) }));
  const total = ctx.movis.reduce((n, m) => n + m.size, 0) || 1;
  let done = 0;
  let seen = 0;
  const wr = new WindowReader(ctx.source);
  for (const movi of ctx.movis) {
    const w = await walkChunks(ctx, movi.offset + movi.headerSize, movi.data.bodyEnd, wr, async (pos, id, size, listType) => {
      if (id === LIST && listType === REC) {
        ctx.hasRecLists = true;
        await walkChunks(ctx, pos + 12, pos + 8 + size, wr, (p2, id2, size2) => addScanned(ctx, per, id2, p2, size2, wr));
      } else {
        await addScanned(ctx, per, id, pos, size, wr);
      }
      if (onProgress && ++seen % 2000 === 0) onProgress(done + (pos - movi.offset), total);
    });
    ctx.moviWalks.set(movi, w);
    done += movi.size;
    if (onProgress) onProgress(done, total);
    await tick();
  }
  return per;
}

async function addScanned(ctx, per, id, off, size, wr) {
  const info = mediaChunkInfo(fccFromNum(id));
  if (!info || info.twocc === 'pc' || info.stream >= per.length) return;
  const s = ctx.streams[info.stream];
  const a = per[info.stream];
  if (!a.id) a.id = fccFromNum(id);
  a.off.push(off + 8);
  a.size.push(size);
  let key = s.type === 'vids' && size === 0 ? 0 : 1;
  if (s.type === 'vids' && size > 0) {
    // Without an index the only way to know key frames is to look inside the frame.
    const fam = s.family;
    if (fam === 'mpeg4v' || fam === 'avc' || fam === 'hevc') {
      const n = Math.min(size, fam === 'mpeg4v' ? 512 : 4096);
      const { u8, i, avail } = await wr.at(off + 8, n);
      const m = Math.min(n, avail);
      if (fam === 'mpeg4v') {
        const t = firstVopType(u8, i, i + m);
        key = t === 0 || t === -1 ? 1 : 0;
      } else key = annexBKey(u8, i, i + m, fam) ? 1 : 0;
    }
  }
  a.key.push(key);
}

/** Key frame test for an Annex B frame: the first slice decides; parameter sets alone count as key. */
function annexBKey(u8, start, end, fam) {
  let params = false;
  for (let i = start; i + 3 < end; i++) {
    if (u8[i] === 0 && u8[i + 1] === 0 && u8[i + 2] === 1) {
      const b = u8[i + 3];
      if (fam === 'avc') {
        const t = b & 0x1f;
        if (t === 5) return true;
        if (t >= 1 && t <= 4) return false;
        if (t === 7) params = true;
      } else {
        const t = (b >> 1) & 0x3f;
        if (t >= 16 && t <= 23) return true;
        if (t < 16) return false;
        if (t === 32 || t === 33) params = true;
      }
      i += 2;
    }
  }
  return params;
}

// ------------------------------------------------------------ tracks

function makeTrack(ctx, s, counts) {
  const kind = STREAM_KIND[s.type] ?? 'data';
  counts[kind] = (counts[kind] ?? 0) + 1;
  const t = {
    id: s.index,
    index: s.index,
    kind,
    stream: s,
    node: s.node,
    chunkPrefix: String(s.index).padStart(2, '0'),
  };
  if (s.type === 'vids' || s.type === 'iavs') {
    const v = s.video ?? {};
    t.codec = v.fourcc ?? s.handler ?? '?';
    t.codecName = v.codecName ?? s.handler ?? '?';
    t.family = v.family ?? null;
    s.family = t.family;
    t.sampleCfg = { family: t.family === 'mpeg4v' ? null : t.family };
    if (t.family === 'avc' || t.family === 'hevc') {
      t.sampleCfg.annexB = !v.avcC;
      if (v.avcC) {
        t.sampleCfg.lengthSize = v.avcC.lengthSize;
        t.sampleCfg.state = { spsById: new Map(v.avcC.spsById), ppsById: new Map(v.avcC.ppsById) };
        t.sps = v.avcC.sps[0];
      }
    }
    if (t.family === 'mpeg4v') t.mp4v = {};
  } else if (s.type === 'auds') {
    const a = s.audio ?? {};
    t.codec = a.tag !== undefined ? `0x${a.tag.toString(16).padStart(4, '0')}` : '?';
    t.codecName = a.codec?.name ?? '?';
    if (a.asc) t.codecName = aacName(a.asc);
    t.family = a.codec?.family ?? null;
    t.sampleCfg = { family: t.family, adts: !!a.codec?.adts };
  } else {
    t.codec = s.handler ?? s.type ?? '?';
    t.codecName = s.type === 'txts' ? 'Text / subtitles' : s.type === 'mids' ? 'MIDI' : `'${s.type}' stream`;
    t.sampleCfg = { family: null };
  }
  const short = s.type === 'vids' ? (t.codec ?? '').trim() : s.type === 'auds' ? t.codecName.replace(/ \(.*\)$/, '') : t.codec;
  t.label = `${KIND_LABEL[kind] ?? kind} ${counts[kind]} – ${short}`;
  t.timescale = 0;
  return t;
}

/** Decode the first frame(s) of each track for codec details (SPS, VOL, MP3 header...). */
export async function inspectFirstFrames(ctx, doc) {
  for (const t of doc.tracks) {
    const s = t.samples;
    if (!s || !s.count) continue;
    let i = 0;
    while (i < s.count && s.sizes[i] === 0) i++;
    if (i >= s.count) continue;
    const bytes = await ctx.source.read(s.offsets[i], Math.min(s.sizes[i], MAX_FIRST_FRAME));
    try {
      if (t.family === 'avc' || t.family === 'hevc') {
        const cfg = t.sampleCfg;
        if (cfg.annexB && !(bytes[0] === 0 && bytes[1] === 0 && (bytes[2] === 1 || (bytes[2] === 0 && bytes[3] === 1)))) {
          t.problems = [...(t.problems ?? []), 'the first frame does not start with an Annex B start code'];
        }
        const res = parseSample(cfg, bytes, 0, bytes.length, s.offsets[i]);
        t.firstUnits = res.units;
        const sps = cfg.state?.spsById?.values().next().value;
        if (sps) t.sps = sps;
      } else if (t.family === 'mpeg4v') {
        const st = t.mp4v;
        const ex = t.stream.video?.extradata;
        if (ex && t.stream.video.extradataAnnexB) parseMpeg4Visual(ex.bytes, 0, ex.bytes.length, ex.offset, st);
        const res = parseMpeg4Visual(bytes, 0, bytes.length, s.offsets[i], st);
        st.userData = [...(st.userData ?? []), ...res.userData];
      } else if (t.family === 'mp3') {
        const k = bytes.findIndex((b, j) => b === 0xff && (bytes[j + 1] & 0xe0) === 0xe0);
        if (k >= 0) t.mpa = parseMpegAudioHeader(bytes, k, bytes.length, s.offsets[i], []);
      } else if (t.family === 'ac3') {
        t.ac3 = parseAc3Header(bytes, 0, bytes.length, s.offsets[i], []);
      } else if (t.family === 'aac') {
        if (bytes[0] === 0xff && (bytes[1] & 0xf6) === 0xf0) t.sampleCfg.adts = true;
      }
    } catch (e) {
      t.problems = [...(t.problems ?? []), `could not decode the first frame: ${e.message}`];
    }
  }
}

function codecDetails(t) {
  if (t.sps && t.family === 'avc') {
    const sp = t.sps;
    t.profile = `${avcProfile(sp.profile_idc, sp.compat)}@L${avcLevel(sp.level_idc, sp.compat, sp.profile_idc)}`;
    t.codecString = avcCodecString('avc1', sp.profile_idc, sp.compat, sp.level_idc);
  } else if (t.sps && t.family === 'hevc') {
    t.profile = `${HEVC_PROFILES[t.sps.profile_idc] ?? t.sps.profile_idc}@L${hevcLevel(t.sps.level_idc)}`;
  } else if (t.family === 'mpeg4v' && t.mp4v?.profile) {
    t.profile = t.mp4v.profile;
  } else if (t.stream.audio?.asc) {
    t.codecString = `mp4a.40.${t.stream.audio.asc.firstAot}`;
    t.profile = aacName(t.stream.audio.asc);
  }
}

function sampleStats(t) {
  const s = t.samples;
  if (!s || !s.count) return;
  let bytes = 0;
  let empty = 0;
  let max = 0;
  let keys = 0;
  for (let i = 0; i < s.count; i++) {
    bytes += s.sizes[i];
    if (!s.sizes[i]) empty++;
    if (s.sizes[i] > max) max = s.sizes[i];
    if (!s.key || s.key[i]) keys++;
  }
  t.bytes = bytes;
  t.emptyChunks = empty;
  t.maxChunk = max;
  t.keyframes = keys;
  const ts = s.timescale || 1;
  const last = s.count - 1;
  t.duration = (s.dts[last] + s.durations[last] - s.dts[0]) / ts;
  t.end = (s.dts[last] + s.durations[last]) / ts;
  if (t.duration > 0) t.bitrate = (bytes * 8) / t.duration;
}

export function trackProps(t, doc) {
  const s = t.stream;
  const p = [];
  const c = t.samples?.clock ?? clockOf(s);
  p.push(['stream', `${t.chunkPrefix}${t.samples?.chunkId ? ` (chunks '${t.samples.chunkId}')` : ''}`]);
  if (s.type === 'vids') {
    p.push(['codec', `${t.codecName} ('${(t.codec ?? '').trim()}')${s.handler && s.handler.trim() && s.handler.toLowerCase() !== (t.codec ?? '').toLowerCase() ? `, handler '${s.handler}'` : ''}`]);
    if (t.codecString) p.push(['codec string', t.codecString]);
    if (t.profile) p.push(['profile', t.profile]);
    const v = s.video ?? {};
    const w = t.sps?.width ?? t.mp4v?.width ?? v.width;
    const h = t.sps?.height ?? t.mp4v?.height ?? Math.abs(v.height ?? 0);
    if (w) p.push(['coded size', `${w}×${h}${v.width && (v.width !== w || Math.abs(v.height) !== h) ? ` (BITMAPINFOHEADER says ${v.width}×${Math.abs(v.height)})` : ''}`]);
    if (s.aspect && s.aspect[0] && s.aspect[1]) p.push(['display aspect', `${s.aspect[0]}:${s.aspect[1]} (vprp)`]);
    if (v.bitCount) p.push(['bits per pixel', String(v.bitCount)]);
    if (c.rate) p.push(['frame rate', `${fmtNum(c.rate / c.scale, 3)} fps (dwRate/dwScale = ${fmtInt(c.rate)}/${fmtInt(c.scale)})${c.fixed ? ' — strh values invalid, guessed' : ''}`]);
    if (t.sps) {
      p.push(['chroma / depth', `${['4:0:0', '4:2:0', '4:2:2', '4:4:4'][t.sps.chroma_format_idc] ?? '?'}, ${t.sps.bit_depth_luma}-bit`]);
      if (t.sps.frame_mbs_only === 0) p.push(['scan', 'interlaced']);
    }
    if (t.mp4v?.interlaced) p.push(['scan', 'interlaced']);
  } else if (s.type === 'auds') {
    const a = s.audio ?? {};
    p.push(['codec', `${t.codecName} (wFormatTag 0x${(a.tag ?? 0).toString(16).padStart(4, '0')}${a.subTag !== undefined ? `, SubFormat 0x${a.subTag.toString(16).padStart(4, '0')}` : ''})`]);
    if (t.codecString) p.push(['codec string', t.codecString]);
    const rate = a.asc ? a.asc.extSampleRate || a.asc.sampleRate : a.sampleRate;
    p.push(['sample rate', fmtHz(rate)]);
    p.push(['channels', a.asc && CHANNEL_CONFIG[a.asc.channelConfig] ? CHANNEL_CONFIG[a.asc.channelConfig] : `${a.channels ?? '?'}${a.channelMask ? ` (${channelMaskText(a.channelMask)})` : a.channels === 1 ? ' (mono)' : a.channels === 2 ? ' (stereo)' : ''}`]);
    if (a.pcm) p.push(['sample format', `${a.validBits && a.validBits !== a.bits ? `${a.validBits} valid bits in ` : ''}${a.bits}-bit ${(a.subTag ?? a.tag) === 3 ? 'float' : 'integer'}, block ${a.blockAlign} bytes`]);
    if (t.mpa?.bitrate) p.push(['first frame', `${t.mpa.summary}`]);
    p.push(['data rate', `${fmtInt(a.byteRate ?? 0)} bytes/s (${fmtBitrate((a.byteRate ?? 0) * 8)}) declared`]);
    p.push(['clock', c.mode === 'bytes' ? `dwSampleSize ${c.sampleSize}: time from the byte count, ${fmtNum(c.rate / c.scale, 3)} units/s` : c.mode === 'blocks' ? `dwSampleSize 0: each chunk is ceil(size / ${c.block}) blocks of ${fmtNum((c.scale / c.rate) * 1000, 3)} ms` : `each chunk is one frame of ${fmtNum((c.scale / c.rate) * 1000, 3)} ms`]);
  } else {
    p.push(['codec', t.codecName]);
  }
  if (s.name) p.push(['name', s.name]);
  if (t.duration) p.push(['duration', fmtDuration(t.duration)]);
  const sm = t.samples;
  if (sm) {
    p.push([s.type === 'vids' ? 'frames' : 'chunks', `${fmtInt(sm.count)}${t.emptyChunks ? ` (${fmtInt(t.emptyChunks)} empty)` : ''}; strh dwLength ${fmtInt(s.length)}`]);
    if (s.type === 'vids' && t.keyframes !== undefined) p.push(['key frames', `${fmtInt(t.keyframes)}${t.keyframes ? ` (every ${fmtNum(sm.count / t.keyframes, 1)} frames on average)` : ''}`]);
    if (t.bytes) p.push(['media bytes', `${fmtInt(t.bytes)} (${((t.bytes / doc.size) * 100).toFixed(2)}% of file)`]);
    if (t.bitrate) p.push(['average bitrate', fmtBitrate(t.bitrate)]);
    if (t.maxChunk) p.push(['largest chunk', `${fmtInt(t.maxChunk)} bytes (dwSuggestedBufferSize ${fmtInt(s.bufferSize ?? 0)})`]);
    p.push(['index', sm.source === 'OpenDML' ? 'OpenDML (indx → ix##)' : sm.source === 'idx1' ? 'idx1' : 'none: found by scanning movi']);
  }
  return p;
}

/** Labels for chunk nodes inside movi: frame number, time and key flag. */
export function makeMediaLabeler(doc) {
  return (node) => {
    const info = mediaChunkInfo(node.type);
    if (!info) return;
    const t = doc.tracks[info.stream];
    const s = t?.samples;
    if (!s || !s.count) return;
    const off = node.offset + 8;
    let lo = 0;
    let hi = s.count - 1;
    let k = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (s.offsets[mid] < off) lo = mid + 1;
      else if (s.offsets[mid] > off) hi = mid - 1;
      else {
        k = mid;
        break;
      }
    }
    if (k < 0) {
      node.label = 'not in the index';
      return;
    }
    const time = fmtDuration(s.dts[k] / (s.timescale || 1));
    if (!s.sizes[k]) node.label = `#${k + 1} · empty (dropped frame) · ${time}`;
    else if (t.kind === 'video') node.label = `#${k + 1}${!s.key || s.key[k] ? ' · key' : ''} · ${time}`;
    else node.label = `#${k + 1} · ${time}`;
    node.data.sample = { track: t.index, index: k };
  };
}

// ------------------------------------------------------------ analyse

export async function analyzeAvi(doc, ctx) {
  const counts = {};
  doc.tracks = ctx.streams.map((s) => makeTrack(ctx, s, counts));
  for (const t of doc.tracks) if (t.node) t.node.label = t.label;
  if (ctx.avih) for (const s of ctx.streams) s.usPerFrame = ctx.avih.usPerFrame;

  ctx.index = { kind: 'none', problems: [] };
  let loaded = false;
  // 1. OpenDML
  if (ctx.streams.some((s) => s.indx && s.indx.entries)) {
    const res = [];
    for (const s of ctx.streams) res.push(s.indx ? await samplesFromOdml(ctx, s) : null);
    if (res.some((r) => r && r.off)) {
      doc.tracks.forEach((t, i) => {
        const r = res[i];
        if (r?.off) t.samples = buildSamples(t.stream, r.off, r.size, r.key, 'OpenDML', t.stream.indx?.chunkId ?? null);
        if (r?.problems?.length) ctx.index.problems.push(...r.problems.map((p) => `${t.label}: ${p}`));
      });
      ctx.index.kind = 'OpenDML';
      loaded = true;
    }
  }
  // 2. idx1
  if (ctx.idx1 && ctx.idx1.table.count) {
    const b = await idx1Base(ctx);
    ctx.idx1Base = b?.base ?? null;
    ctx.idx1Info = b;
    if (!loaded && b) {
      const { per, recs, unknown } = samplesFromIdx1(ctx, b.base);
      doc.tracks.forEach((t, i) => {
        const a = per[i];
        if (a.off.n) t.samples = buildSamples(t.stream, a.off.done(), a.size.done(), a.key.done(), 'idx1', a.id);
      });
      ctx.index.kind = 'idx1';
      ctx.index.recs = recs;
      ctx.index.unknown = unknown;
      loaded = true;
    }
  }
  ctx.index.loaded = loaded;
  await inspectFirstFrames(ctx, doc);
  finishTracks(doc, ctx);
}

export function finishTracks(doc, ctx) {
  for (const t of doc.tracks) {
    codecDetails(t);
    sampleStats(t);
    t.timescale = t.samples?.timescale ?? clockOf(t.stream).rate;
    t.props = trackProps(t, doc);
  }
  doc.frameIndex = new FrameIndex(doc.tracks);
  ctx.labelMedia = makeMediaLabeler(doc);
  // Duration: the longest stream, from the frames or from strh.
  let dur = 0;
  for (const t of doc.tracks) {
    if (t.end) dur = Math.max(dur, t.end);
    else {
      const c = clockOf(t.stream);
      if (t.stream.length && c.rate) dur = Math.max(dur, ((t.stream.start + t.stream.length) * c.scale) / c.rate);
    }
  }
  if (!dur && ctx.avih?.usPerFrame) dur = (ctx.avih.usPerFrame * (ctx.dmlhTotalFrames ?? ctx.avih.totalFrames)) / 1e6;
  doc.summary.duration = dur || null;
}

