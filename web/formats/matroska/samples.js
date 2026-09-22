// Frame tables from the Clusters: one sequential pass over the media data (large
// reads, each Cluster read once) that records every frame's position, size,
// timestamp and key flag per track, plus statistics for the insights.
//
// Timestamps are kept in Segment ticks (TimestampScale units), so the timescale of
// every track is 1e9 / TimestampScale ticks per second and block timestamps are exact.
// Matroska only stores presentation times; decode times are derived for tracks whose
// frames are stored out of presentation order (B-frames).

import { ensureChildren } from '../../core/model.js';
import { fmtInt } from '../../core/util.js';
import { readHeader, readUint, readInt, crc32 } from './ebml.js';
import { blockLayout } from './blocks.js';
import { ChunkReader, LIMITS } from './parse.js';
import { placeholderTrack } from './tracks.js';

const ID_TIMESTAMP = 0xe7;
const ID_SIMPLEBLOCK = 0xa3;
const ID_BLOCKGROUP = 0xa0;
const ID_BLOCK = 0xa1;
const ID_BLOCKDURATION = 0x9b;
const ID_REFERENCEBLOCK = 0xfb;
const ID_DISCARDPADDING = 0x75a2;
const ID_BLOCKADDITIONS = 0x75a1;
const ID_CRC = 0xbf;

/** CRC-32 of Cluster data is verified for this many bytes at most (CPU cost). */
export const CRC_BUDGET = 1 << 30;

class Grow {
  constructor(Type, n = 256) {
    this.Type = Type;
    this.a = new Type(n);
    this.n = 0;
  }

  push(v) {
    if (this.n === this.a.length) {
      const b = new this.Type(this.a.length * 2);
      b.set(this.a);
      this.a = b;
    }
    this.a[this.n++] = v;
  }

  done() {
    return this.a.slice(0, this.n);
  }
}

class TrackAcc {
  constructor(track) {
    this.t = track;
    this.offsets = new Grow(Float64Array);
    this.sizes = new Grow(Uint32Array);
    this.blockPts = new Grow(Float64Array);
    this.lace = new Grow(Uint16Array);
    this.laceN = new Grow(Uint16Array);
    this.bdur = new Grow(Float64Array);
    this.key = new Grow(Uint8Array);
    this.block = new Grow(Float64Array);
    this.blockData = new Grow(Float64Array);
    this.cluster = new Grow(Uint32Array);
    this.flags = new Grow(Uint8Array);
    this.stats = { blocks: 0, groups: 0, xiph: 0, ebml: 0, fixed: 0, maxFrames: 1, invisible: 0, discardable: 0, refs: 0, discardPadding: 0, additions: 0, laceErrors: 0 };
  }
}

/** All frames of all tracks sorted by file offset, for the hex view and detailAt. */
export class FrameIndex {
  constructor(starts, ends, track, sample) {
    this.starts = starts;
    this.ends = ends;
    this.track = track;
    this.sample = sample;
    this.count = starts.length;
  }

  /** Index of the frame containing `offset`, or -1. */
  find(offset) {
    let lo = 0;
    let hi = this.count - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.starts[mid] <= offset) {
        ans = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return ans >= 0 && offset < this.ends[ans] ? ans : -1;
  }

  /** First frame whose end is after `offset`. */
  firstEndingAfter(offset) {
    let lo = 0;
    let hi = this.count - 1;
    let ans = this.count;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.starts[mid] <= offset) lo = mid + 1;
      else {
        ans = mid;
        hi = mid - 1;
      }
    }
    if (ans > 0 && this.ends[ans - 1] > offset) return ans - 1;
    return ans;
  }
}

function lowerBound(arr, n, v) {
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export { lowerBound };

class Scanner {
  constructor(doc) {
    this.doc = doc;
    this.ctx = doc.ctx;
    this.acc = new Map(); // track object -> TrackAcc
    this.starts = new Grow(Float64Array, 4096);
    this.ends = new Grow(Float64Array, 4096);
    this.gTrack = new Grow(Uint16Array, 4096);
    this.gSample = new Grow(Uint32Array, 4096);
    this.clusters = [];
    this.unknownTracks = new Map();
    this.problems = [];
    this.elements = 0; // elements inside Clusters (for the header count)
    this.crc = { checked: 0, ok: 0, bad: [], skipped: 0, bytes: 0 };
    this.relMin = Infinity;
    this.relMax = -Infinity;
    this.blocks = 0;
    this.groups = 0;
  }

  accFor(track) {
    let a = this.acc.get(track);
    if (!a) {
      a = new TrackAcc(track);
      this.acc.set(track, a);
    }
    return a;
  }

  /** One SimpleBlock or Block: u8[s, e) is its data; `pos` the element offset. */
  block(seg, u8, base, s, e, simple, cl, g, pos, dataEnd = e) {
    const L = blockLayout(u8, s, e, dataEnd);
    const cs = cl.stats;
    if (!L.frames) {
      this.problems.push(`${simple ? 'SimpleBlock' : 'Block'} at ${fmtInt(pos)}: ${L.error}`);
      return;
    }
    this.blocks++;
    cs.blocks++;
    if (L.rel < this.relMin) this.relMin = L.rel;
    if (L.rel > this.relMax) this.relMax = L.rel;
    let t = seg.trackByNumber.get(L.track);
    if (!t && seg.bare && L.track > 0 && seg.trackByNumber.size < 64) t = placeholderTrack(this.doc, seg, L.track);
    if (!t) {
      this.unknownTracks.set(L.track, (this.unknownTracks.get(L.track) ?? 0) + 1);
      return;
    }
    const a = this.accFor(t);
    const st = a.stats;
    st.blocks++;
    if (!simple) st.groups++;
    if (L.error) {
      st.laceErrors++;
      this.problems.push(`${t.short}: block at ${fmtInt(pos)}: ${L.error}`);
    }
    if (L.lacing === 1) st.xiph++;
    else if (L.lacing === 2) st.fixed++;
    else if (L.lacing === 3) st.ebml++;
    if (L.count > st.maxFrames) st.maxFrames = L.count;
    if (L.invisible) st.invisible++;
    if (simple && L.discardable) st.discardable++;
    const key = simple ? L.key : !g || g.refs === 0;
    if (g) {
      if (g.refs) st.refs++;
      if (g.discard) st.discardPadding++;
      if (g.additions) st.additions++;
    }
    const tts = t.trackTimestampScale || 1;
    const pts = (cl.ts ?? 0) + L.rel * tts;
    const bdur = g && g.dur !== null ? g.dur * tts : NaN;
    const flags = (L.invisible ? 1 : 0) | (simple && L.discardable ? 2 : 0) | (L.lacing << 2) | (simple ? 0 : 16);
    const blockData = base + s;
    const n = L.count;
    const frames = L.frames;
    for (let k = 0; k < n; k++) {
      const off = base + frames[2 * k];
      const size = frames[2 * k + 1];
      const idx = a.offsets.n;
      a.offsets.push(off);
      a.sizes.push(size);
      a.blockPts.push(pts);
      a.lace.push(k);
      a.laceN.push(n);
      a.bdur.push(bdur);
      a.key.push(key ? 1 : 0);
      a.block.push(pos);
      a.blockData.push(blockData);
      a.cluster.push(cl.index);
      a.flags.push(flags);
      this.starts.push(off);
      this.ends.push(off + size);
      this.gTrack.push(t.index);
      this.gSample.push(idx);
    }
    cs.frames += n;
    if (cs.firstBlockPts === null) cs.firstBlockPts = pts;
    if (pts < cs.minPts) cs.minPts = pts;
    if (pts > cs.maxPts) cs.maxPts = pts;
    if (t.kind === 'video' && cs.firstVideoKey === null) cs.firstVideoKey = key;
  }

  /** Children of a BlockGroup in u8[s, e). */
  blockGroup(seg, u8, base, s, e, cl, pos) {
    let p = s;
    let bs = -1;
    let be = -1;
    const g = { dur: null, refs: 0, discard: 0, additions: false };
    while (p < e) {
      const h = readHeader(u8, p, e);
      if (h.error || h.unknown) break;
      this.elements++;
      const ds = p + h.headerSize;
      const de = Math.min(ds + h.size, e);
      if (h.id === ID_BLOCK) {
        bs = ds;
        be = de;
      } else if (h.id === ID_BLOCKDURATION) g.dur = readUint(u8, ds, de - ds).value;
      else if (h.id === ID_REFERENCEBLOCK) g.refs++;
      else if (h.id === ID_DISCARDPADDING) g.discard = readInt(u8, ds, de - ds).value;
      else if (h.id === ID_BLOCKADDITIONS) g.additions = true;
      p = de;
    }
    this.groups++;
    if (bs >= 0) this.block(seg, u8, base, bs, be, false, cl, g, pos);
    else this.problems.push(`BlockGroup at ${fmtInt(pos)} has no Block`);
  }

  newCluster(node, seg) {
    const cl = {
      index: this.clusters.length,
      node,
      seg,
      offset: node.offset,
      size: node.size,
      ts: node.data.timestamp ?? null,
      stats: { blocks: 0, frames: 0, firstVideoKey: null, firstBlockPts: null, minPts: Infinity, maxPts: -Infinity, crc: null },
    };
    this.clusters.push(cl);
    return cl;
  }

  /** A Cluster whose bytes are all in u8 (node.offset = base + at). */
  clusterSync(seg, node, u8, base, at) {
    const cl = this.newCluster(node, seg);
    const s = at + node.headerSize;
    const e = at + node.size;
    let p = s;
    let first = true;
    while (p < e) {
      const h = readHeader(u8, p, e);
      if (h.error) {
        this.problems.push(`Cluster #${cl.index + 1}: unreadable element at ${fmtInt(base + p)} (${h.error})`);
        break;
      }
      if (h.unknown) break;
      this.elements++;
      const ds = p + h.headerSize;
      const de = Math.min(ds + h.size, e);
      switch (h.id) {
        case ID_TIMESTAMP:
          cl.ts = readUint(u8, ds, de - ds).value;
          break;
        case ID_SIMPLEBLOCK:
          this.block(seg, u8, base, ds, de, true, cl, null, base + p);
          break;
        case ID_BLOCKGROUP:
          this.blockGroup(seg, u8, base, ds, de, cl, base + p);
          break;
        case ID_CRC:
          if (first && de - ds === 4) {
            if (this.crc.bytes + (e - de) <= CRC_BUDGET) {
              const stored = (u8[ds] | (u8[ds + 1] << 8) | (u8[ds + 2] << 16) | (u8[ds + 3] << 24)) >>> 0;
              const computed = crc32(u8, de, e);
              this.crc.bytes += e - de;
              this.crc.checked++;
              cl.stats.crc = stored === computed;
              if (stored === computed) this.crc.ok++;
              else this.crc.bad.push({ offset: node.offset, stored, computed, index: cl.index });
            } else this.crc.skipped++;
          }
          break;
        default:
          break;
      }
      p = de;
      first = false;
    }
    return cl;
  }

  /** A Cluster too large to hold in memory: walk it with streaming reads. */
  async clusterAsync(seg, node, cr) {
    const cl = this.newCluster(node, seg);
    let p = node.bodyOffset;
    const e = node.end;
    while (p < e) {
      let i = await cr.at(p, 16);
      if (i < 0) break;
      const h = readHeader(cr.buf, i, cr.buf.length);
      if (h.error || h.unknown) break;
      this.elements++;
      const ds = p + h.headerSize;
      const total = Math.min(h.size, e - ds);
      if (h.id === ID_TIMESTAMP) {
        i = await cr.at(ds, total);
        cl.ts = readUint(cr.buf, i, total).value;
      } else if (h.id === ID_SIMPLEBLOCK) {
        const n = Math.min(total, 64 * 1024);
        i = await cr.at(ds, n);
        this.block(seg, cr.buf, cr.base, i, i + Math.min(n, cr.buf.length - i), true, cl, null, p, i + total);
      } else if (h.id === ID_BLOCKGROUP) {
        if (total <= LIMITS.clusterRead) {
          i = await cr.at(ds, total);
          this.blockGroup(seg, cr.buf, cr.base, i, i + total, cl, p);
        } else this.problems.push(`BlockGroup at ${fmtInt(p)} is too large to scan (${fmtInt(total)} bytes)`);
      }
      p = ds + total;
    }
    return cl;
  }

  /** Turn the accumulated frames into per-track sample tables. */
  finish() {
    const doc = this.doc;
    for (const t of doc.tracks) {
      const a = this.acc.get(t);
      t.lacing = a ? { ...a.stats } : null;
      if (!a || !a.offsets.n) {
        t.samples = { count: 0, timescale: t.timescale, offsets: new Float64Array(0), sizes: new Uint32Array(0), dts: new Float64Array(0), cto: null, durations: new Float64Array(0), key: new Uint8Array(0), problems: [], source: 'clusters' };
        continue;
      }
      t.samples = buildTable(t, a);
    }
    // Index sample numbers were assigned per track in file order: already correct.
    doc.frameIndex = new FrameIndex(this.starts.done(), this.ends.done(), this.gTrack.done(), this.gSample.done());
  }
}

/** Per-track table: presentation times of laced frames, durations, derived decode times. */
function buildTable(t, a) {
  const n = a.offsets.n;
  const scale = t.seg.timestampScale;
  const ddur = t.defaultDuration ? t.defaultDuration / scale : NaN; // ticks
  const blockPts = a.blockPts.done();
  const laceI = a.lace.done();
  const laceN = a.laceN.done();
  const bdur = a.bdur.done();
  const pts = new Float64Array(n);
  const durations = new Float64Array(n);
  const problems = [];
  // Frame duration within a lace: BlockDuration / frames, else DefaultDuration, else interpolate.
  let nextBlockPts = NaN;
  for (let i = n - 1; i >= 0; i--) {
    const k = laceI[i];
    const cnt = laceN[i];
    let fd = !Number.isNaN(bdur[i]) ? bdur[i] / cnt : ddur;
    if (Number.isNaN(fd) && cnt > 1 && !Number.isNaN(nextBlockPts)) fd = (nextBlockPts - blockPts[i]) / cnt;
    pts[i] = blockPts[i] + (cnt > 1 && !Number.isNaN(fd) ? k * fd : 0);
    durations[i] = fd;
    if (k === 0) nextBlockPts = blockPts[i];
  }
  // Remaining unknown durations: distance to the next frame in presentation order.
  let unknown = 0;
  for (let i = 0; i < n; i++) if (Number.isNaN(durations[i])) unknown++;
  if (unknown) {
    const order = Array.from({ length: n }, (_, i) => i).sort((x, y) => pts[x] - pts[y] || x - y);
    let last = 0;
    for (let j = 0; j < n; j++) {
      const i = order[j];
      if (!Number.isNaN(durations[i])) {
        last = durations[i];
        continue;
      }
      const nx = j + 1 < n ? pts[order[j + 1]] - pts[i] : last;
      durations[i] = nx >= 0 ? nx : 0;
      last = durations[i];
    }
  }
  // Decode order vs presentation order.
  let reordered = false;
  for (let i = 1; i < n; i++) {
    if (pts[i] < pts[i - 1]) {
      reordered = true;
      break;
    }
  }
  let dts = pts;
  let cto = null;
  if (reordered && t.kind === 'video') {
    const sorted = Float64Array.from(pts).sort();
    let shift = 0;
    for (let i = 0; i < n; i++) shift = Math.max(shift, sorted[i] - pts[i]);
    dts = new Float64Array(n);
    cto = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      dts[i] = sorted[i] - shift;
      cto[i] = Math.round(pts[i] - dts[i]);
    }
  } else if (reordered) {
    problems.push('timestamps go backwards in file order');
  }
  return {
    count: n,
    timescale: t.timescale,
    offsets: a.offsets.done(),
    sizes: a.sizes.done(),
    dts,
    cto,
    pts,
    durations,
    key: a.key.done(),
    block: a.block.done(),
    blockData: a.blockData.done(),
    lace: laceI,
    laceCount: laceN,
    cluster: a.cluster.done(),
    flags: a.flags.done(),
    codecDelay: t.codecDelay ? t.codecDelay / scale : 0,
    reordered,
    problems,
    source: 'clusters',
  };
}

/** Derived per-track numbers after the scan (keyframes, duration, bitrate, frame rate). */
function trackStats(t) {
  const s = t.samples;
  if (!s || !s.count) return;
  let bytes = 0;
  let keys = 0;
  let first = Infinity;
  let end = -Infinity;
  for (let i = 0; i < s.count; i++) {
    bytes += s.sizes[i];
    keys += s.key[i];
    const p = s.pts[i];
    if (p < first) first = p;
    const e2 = p + s.durations[i];
    if (e2 > end) end = e2;
  }
  t.bytes = bytes;
  t.keyframes = keys;
  t.firstPts = first;
  t.endPts = end;
  const secs = ((end - first) / s.timescale) || 0;
  t.mediaDuration = secs > 0 ? secs : null;
  t.duration = t.mediaDuration;
  if (t.duration) t.bitrate = (bytes * 8) / t.duration;
  if (t.kind === 'video' && s.count > 1 && t.duration) {
    t.fps = s.count / t.duration;
    let min = Infinity;
    let max = 0;
    for (let i = 0; i < s.count - 1; i++) {
      const d = s.durations[i];
      if (d < min) min = d;
      if (d > max) max = d;
    }
    t.vfr = max > min * 1.05 + 1;
  }
  // Key frame intervals (GOP lengths) in frames and seconds.
  if (t.kind === 'video' && keys > 1) {
    const kf = [];
    for (let i = 0; i < s.count; i++) if (s.key[i]) kf.push(i);
    let maxGap = 0;
    let maxSec = 0;
    for (let k = 1; k < kf.length; k++) {
      maxGap = Math.max(maxGap, kf[k] - kf[k - 1]);
      maxSec = Math.max(maxSec, (s.pts[kf[k]] - s.pts[kf[k - 1]]) / s.timescale);
    }
    t.gop = { count: kf.length, avgFrames: (kf[kf.length - 1] - kf[0]) / (kf.length - 1), maxFrames: maxGap, maxSeconds: maxSec, avgSeconds: (s.pts[kf[kf.length - 1]] - s.pts[kf[0]]) / s.timescale / (kf.length - 1) };
  } else if (t.kind === 'video' && keys === 1) {
    t.gop = { count: 1 };
  }
}

/** Scan all Clusters of the document and fill the tracks' sample tables. */
export async function scanClusters(doc, onProgress) {
  const ctx = doc.ctx;
  // Live files: Clusters of unknown size left for later are enumerated first.
  for (const seg of ctx.segments) for (const g of seg.groups) if (g.lazy) await ensureChildren(g);
  const sc = new Scanner(doc);
  const cr = new ChunkReader(ctx.source, 8 << 20);
  let total = 0;
  for (const seg of ctx.segments) for (const c of seg.clusters) total += c.size;
  let done = 0;
  let lastReport = 0;
  for (const seg of ctx.segments) {
    for (const node of seg.clusters) {
      if (node.size <= LIMITS.clusterRead) {
        const i = await cr.at(node.offset, node.size);
        if (i < 0) break;
        sc.clusterSync(seg, node, cr.buf, cr.base, i);
      } else {
        await sc.clusterAsync(seg, node, cr);
      }
      done += node.size;
      if (onProgress && done - lastReport > 4 << 20) {
        lastReport = done;
        onProgress(done, total);
      }
    }
  }
  sc.finish();
  for (const t of doc.tracks) trackStats(t);
  if (onProgress) onProgress(total, total);
  return sc;
}

