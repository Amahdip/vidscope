// Frame types and GOP structure of video tracks, for the Frames view, the Tracks tab,
// the inspector and File insights. Each frame is classified from its first bytes
// (web/codecs/frametype.js); a GOP is the run of frames from one key frame to the next.

import { FT, FF, FRAME_FAMILIES, frameContext, classifyFrame, typeLetter } from '../codecs/frametype.js';
import { fmtInt, fmtNum, humanBytes, plural } from './util.js';
import { tick } from './scan.js';

const HEAD = 2048; // bytes looked at per frame on the first try
const WINDOW = 4 << 20; // one read covers many frames when they are close together
const SMALL_READ = 16 << 10;
const FULL_MAX = 8 << 20; // frames read in full when the head was not enough
const CHUNK = 512; // frames classified between yields to the event loop

/** Scans of video data up to this size start on their own; larger ones wait to be asked. */
export const AUTO_SCAN_BYTES = 1536 << 20;

const perDoc = new WeakMap();

/** A file name quoted for a POSIX shell. */
const sh = (s) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${String(s).replace(/'/g, `'\\''`)}'`);

/** The FrameTypes of a track, created on first use. */
export function frameTypes(doc, track) {
  let m = perDoc.get(doc);
  if (!m) perDoc.set(doc, (m = new Map()));
  let ft = m.get(track);
  if (!ft) m.set(track, (ft = new FrameTypes(doc, track)));
  return ft;
}

/** Stop the scans of a document that is no longer shown. */
export function cancelFrameScans(doc) {
  for (const ft of perDoc.get(doc)?.values() ?? []) ft.cancel();
}

/** Every frame of the track is a key frame (intra-only codecs such as ProRes or MJPEG). */
function allKey(s) {
  if (!s.key) return true;
  for (let i = 0; i < s.count; i++) if (!s.key[i]) return false;
  return true;
}

export class FrameTypes {
  constructor(doc, track) {
    this.doc = doc;
    this.track = track;
    const s = track.samples;
    const n = s?.count ?? 0;
    this.count = n;
    this.type = new Uint8Array(n);
    this.flags = new Uint8Array(n);
    this.nal = new Uint8Array(n);
    this.layer = new Uint8Array(n);
    this.have = new Uint8Array(n);
    this.scanned = 0;
    this.version = 0;
    this.codec = track.kind === 'video' && n ? doc.frameCodec(track) : null;
    this.family = this.codec?.family ?? null;
    this.ctx = FRAME_FAMILIES.has(this.family) ? frameContext(this.codec) : null;
    this.intraOnly = !this.ctx && track.kind === 'video' && n > 0 && allKey(s);
    this.queue = [];
    this.running = false;
    this.cancelled = false;
    this.listeners = new Set();
    this.lastEmit = 0;
    if (this.intraOnly) {
      this.type.fill(FT.I);
      this.flags.fill(FF.RAP | FF.CLOSED);
      this.have.fill(1);
      this.scanned = n;
    }
  }

  /** Whether the frame types of this track can be worked out at all. */
  get supported() {
    return !!this.ctx || this.intraOnly;
  }

  get complete() {
    return this.scanned >= this.count;
  }

  /** Roughly how many bytes classifying every frame reads. */
  get scanBytes() {
    if (this._bytes === undefined) {
      const s = this.track.samples;
      let b = 0;
      for (let i = 0; i < this.count; i++) b += s.sizes[i];
      this._bytes = b;
    }
    return this._bytes;
  }

  /** Call fn(this) whenever more frames are classified; returns an unsubscribe function. */
  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(force) {
    const now = Date.now();
    if (!force && now - this.lastEmit < 150) return;
    this.lastEmit = now;
    for (const fn of this.listeners) {
      try {
        fn(this);
      } catch (e) {
        console.error(e);
      }
    }
  }

  cancel() {
    this.cancelled = true;
    for (const job of this.queue) job.resolve();
    this.queue = [];
  }

  /**
   * Classify frames [from, to) (in decoding order). Resolves once they are done.
   * `urgent` jumps the queue: the frames on screen go before a background scan of the rest.
   */
  ensure(from = 0, to = this.count, { urgent = false } = {}) {
    from = Math.max(0, from);
    to = Math.min(this.count, to);
    if (!this.ctx || from >= to || this.cancelled) return Promise.resolve();
    return new Promise((resolve) => {
      const job = { from, to, resolve };
      if (urgent) this.queue.unshift(job);
      else this.queue.push(job);
      this.pump();
    });
  }

  async pump() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length && !this.cancelled) {
        const job = this.queue[0];
        while (job.from < job.to && this.have[job.from]) job.from++;
        if (job.from >= job.to) {
          this.queue.shift();
          job.resolve();
          continue;
        }
        const end = Math.min(job.to, job.from + CHUNK);
        await this.scanChunk(job.from, end);
        job.from = end;
        this.version++;
        this.emit(false);
        await tick();
      }
    } catch (e) {
      console.error('frame scan failed', e);
      for (const job of this.queue) job.resolve();
      this.queue = [];
    } finally {
      this.running = false;
      this.version++;
      this.emit(true);
    }
  }

  async scanChunk(from, to) {
    const s = this.track.samples;
    const doc = this.doc;
    const contiguous = doc.framesContiguous !== false;
    const out = { type: 0, flags: 0, nal: 0, layer: 0 };
    let win = null;
    let winStart = 0;
    for (let i = from; i < to; i++) {
      if (this.have[i]) continue;
      const off = s.offsets[i];
      const size = s.sizes[i];
      let r = 0;
      if (size > 0) {
        let u8;
        let start;
        if (contiguous) {
          const head = Math.min(size, HEAD);
          if (!win || off < winStart || off + head > winStart + win.length) {
            // Read a window covering the next frames when they are close together,
            // or just this frame's first bytes when frames are far apart.
            let j = i + 1;
            while (j < to && j - i < 512 && s.offsets[j] >= off && s.offsets[j] + Math.min(s.sizes[j], HEAD) <= off + WINDOW) j++;
            const len = j - i >= 4
              ? Math.min(WINDOW, Math.max(head, s.offsets[j - 1] + s.sizes[j - 1] - off))
              : Math.min(size, Math.max(head, SMALL_READ));
            win = await doc.source.read(off, len);
            winStart = off;
          }
          u8 = win;
          start = off - winStart;
        } else {
          u8 = await doc.frameHead(this.track, i, HEAD);
          start = 0;
        }
        const avail = Math.min(start + size, u8.length);
        r = classifyFrame(this.ctx, u8, start, avail, start + size, out);
        if (r < 0) {
          const full = contiguous ? await doc.source.read(off, Math.min(size, FULL_MAX)) : await doc.frameHead(this.track, i, FULL_MAX);
          r = classifyFrame(this.ctx, full, 0, full.length, size, out);
        }
      }
      if (r > 0) {
        this.type[i] = out.type;
        this.flags[i] = out.flags;
        this.nal[i] = out.nal;
        this.layer[i] = out.layer;
      }
      this.have[i] = 1;
      this.scanned++;
    }
  }

  letter(i) {
    return this.have[i] ? typeLetter(this.type[i], this.flags[i]) : '';
  }
}

// ------------------------------------------------------------ order and timing

/** Presentation time of sample i, in track ticks. */
export function ptsOf(s, i) {
  if (s.pts) return s.pts[i];
  return s.dts[i] + (s.cto ? s.cto[i] : 0);
}

/**
 * Display order of a track's frames: `order[k]` is the sample shown k-th, `rank[i]` is
 * where sample i is shown. Samples are stored in decoding order.
 */
export function displayOrder(track) {
  if (track._display) return track._display;
  const s = track.samples;
  const n = s.count;
  const pts = new Float64Array(n);
  let sorted = true;
  for (let i = 0; i < n; i++) {
    pts[i] = ptsOf(s, i);
    if (i && pts[i] < pts[i - 1]) sorted = false;
  }
  const order = new Uint32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  if (!sorted) order.sort((a, b) => pts[a] - pts[b] || a - b);
  const rank = new Uint32Array(n);
  for (let k = 0; k < n; k++) rank[order[k]] = k;
  track._display = { order, rank, reordered: !sorted };
  return track._display;
}

function trackSeconds(track, from, to) {
  const s = track.samples;
  const ts = track.timescale || s.timescale || 1;
  if (to < s.count) return (s.dts[to] - s.dts[from]) / ts;
  const last = s.count - 1;
  return (s.dts[last] + (s.durations?.[last] ?? 0) - s.dts[from]) / ts;
}

/** Frames per second, from the frame count and the track's time span. */
export function frameRate(track) {
  const s = track.samples;
  if (!s || s.count < 2) return track.fps || null;
  const sec = trackSeconds(track, 0, s.count);
  return sec > 0 ? s.count / sec : track.fps || null;
}

// ------------------------------------------------------------ GOPs and statistics

const LETTERS = ['I', 'P', 'p', 'B', 'b', 'S', '=', '?'];

/**
 * GOPs and statistics of the classified frames. Recomputed when more frames are classified.
 * GOPs start at the frames the container marks as key frames (what players seek to).
 */
export function analyzeFrames(ft) {
  if (ft._an && ft._an.version === ft.version) return ft._an;
  const t = ft.track;
  const s = t.samples;
  const n = s.count;
  const { rank } = displayOrder(t);
  const types = Object.fromEntries(LETTERS.map((l) => [l, { count: 0, bytes: 0, min: Infinity, max: 0 }]));
  let totalBytes = 0;
  let classified = 0;
  let hidden = 0;
  let leading = 0;
  let skippable = 0;
  let maxLayer = 0;
  const keyNotRap = [];
  const rapNotKey = [];
  const gops = [];
  let cur = null;
  const closeGop = (end) => {
    if (!cur) return;
    cur.end = end;
    cur.frames = end - cur.start;
    cur.seconds = trackSeconds(t, cur.start, end);
    gops.push(cur);
  };
  for (let i = 0; i < n; i++) {
    const key = !s.key || s.key[i];
    if (key || i === 0) {
      closeGop(i);
      cur = { start: i, end: i, frames: 0, bytes: 0, seconds: 0, partial: !key, leading: 0, skippable: 0, counts: {}, known: 0 };
    }
    const size = s.sizes[i];
    cur.bytes += size;
    totalBytes += size;
    if (!ft.have[i]) continue;
    const L = typeLetter(ft.type[i], ft.flags[i]);
    const st = types[L];
    st.count++;
    st.bytes += size;
    if (size < st.min) st.min = size;
    if (size > st.max) st.max = size;
    cur.counts[L] = (cur.counts[L] ?? 0) + 1;
    if (ft.type[i] !== FT.UNKNOWN) {
      classified++;
      cur.known++;
    }
    const f = ft.flags[i];
    if (f & FF.HIDDEN) hidden++;
    if (f & FF.SKIPPABLE) {
      skippable++;
      cur.skippable++;
    }
    if (ft.layer[i] > maxLayer) maxLayer = ft.layer[i];
    if (i > cur.start && rank[i] < rank[cur.start]) {
      cur.leading++;
      leading++;
    }
    if (ft.type[i] !== FT.UNKNOWN && !ft.intraOnly) {
      if (key && !(f & FF.RAP)) keyNotRap.push(i);
      else if (!key && f & FF.CLOSED) rapNotKey.push(i);
    }
  }
  closeGop(n);

  // Closed or open: open when the entry frame is not an IDR/key frame and frames after it
  // (in decoding order) are shown before it and may refer to the previous GOP. In HEVC those
  // are the RASL frames; RADL frames are shown first too but decode from the entry frame.
  let open = 0;
  let closed = 0;
  for (const g of gops) {
    if (g.partial || !ft.have[g.start] || ft.type[g.start] === FT.UNKNOWN) {
      g.closed = null;
      continue;
    }
    const lead = ft.family === 'hevc' ? g.skippable : g.leading;
    g.closed = !!(ft.flags[g.start] & FF.CLOSED) || lead === 0;
    if (g.closed) closed++;
    else open++;
  }

  // Longest run of B-frames between two reference frames, in display order.
  const { order } = displayOrder(t);
  let maxB = 0;
  let run = 0;
  let refB = 0;
  for (let k = 0; k < n; k++) {
    const i = order[k];
    if (ft.have[i] && ft.type[i] === FT.B) {
      run++;
      if (ft.flags[i] & FF.REF) refB++;
      if (run > maxB) maxB = run;
    } else run = 0;
  }

  const full = gops.filter((g) => !g.partial);
  const counted = full.length > 1 ? full.slice(0, -1) : full; // the last GOP is usually cut short
  const range = (list, key) => {
    let lo = Infinity;
    let hi = 0;
    let sum = 0;
    for (const g of list) {
      lo = Math.min(lo, g[key]);
      hi = Math.max(hi, g[key]);
      sum += g[key];
    }
    return list.length ? { lo, hi, avg: sum / list.length } : { lo: 0, hi: 0, avg: 0 };
  };
  const fr = range(counted, 'frames');
  const sc = range(counted, 'seconds');
  const gop = {
    count: full.length,
    minFrames: fr.lo,
    maxFrames: fr.hi,
    avgFrames: fr.avg,
    minSeconds: sc.lo,
    maxSeconds: range(full, 'seconds').hi,
    avgSeconds: sc.avg,
    // Every GOP but the last has the same length (the last one is usually cut short).
    fixed: full.length >= 2 && fr.lo === fr.hi && full[full.length - 1].frames <= fr.lo,
    open,
    closed,
    leadIn: gops[0]?.partial ? gops[0].frames : 0,
  };
  ft._an = {
    version: ft.version,
    track: t,
    frames: n,
    classified,
    complete: ft.complete,
    totalBytes,
    types,
    gops,
    gop,
    maxB,
    refB,
    hidden,
    leading,
    skippable,
    layers: maxLayer + 1,
    keyNotRap,
    rapNotKey,
    pattern: typicalPattern(ft, gops),
  };
  return ft._an;
}

/** The letters of GOP g in display (or decoding) order. */
export function gopLetters(ft, g, display = true) {
  const idx = [];
  for (let i = g.start; i < g.end; i++) idx.push(i);
  if (display) {
    const { rank } = displayOrder(ft.track);
    idx.sort((a, b) => rank[a] - rank[b]);
  }
  return idx.map((i) => ({ i, letter: ft.letter(i) || '·' }));
}

/** The most common display-order pattern of the first frames of each GOP, such as "IbBbP". */
function typicalPattern(ft, gops) {
  const counts = new Map();
  for (const g of gops.slice(0, 400)) {
    if (g.partial || g.known < Math.min(g.frames, 2)) continue;
    const p = gopLetters(ft, { start: g.start, end: Math.min(g.end, g.start + 24) }).map((x) => x.letter).join('');
    counts.set(p, (counts.get(p) ?? 0) + 1);
  }
  let best = '';
  let n = 0;
  for (const [p, c] of counts) if (c > n) [best, n] = [p, c];
  return best;
}

// ------------------------------------------------------------ insights

const pct = (a, b) => (b ? `${fmtNum((a / b) * 100, a / b < 0.1 ? 1 : 0)} %` : '–');
const secs = (x) => `${fmtNum(x, x < 10 ? 2 : 1)} s`;

/**
 * File insights about GOPs and frame types, for every video track. Classifies the frames
 * first when that is cheap enough (see AUTO_SCAN_BYTES).
 */
export async function frameInsights(doc) {
  const out = [];
  for (const t of doc.tracks) {
    if (t.kind !== 'video' || !t.samples?.count) continue;
    const ft = frameTypes(doc, t);
    if (ft.ctx && !ft.complete && ft.scanBytes <= AUTO_SCAN_BYTES) await ft.ensure();
    const an = analyzeFrames(ft);
    gopInsight(doc, t, ft, an, out);
    if (ft.supported && an.classified) typeInsights(doc, t, ft, an, out);
    else if (ft.ctx && !ft.complete) {
      out.push({ level: 'info', group: 'Encoding', title: `${t.label}: frame types not analysed yet`, text: `Working out which frames are I, P or B means reading the start of every frame (about ${humanBytes(ft.scanBytes)} here). Open the Frames view to run it.` });
    }
  }
  return out;
}

function gopInsight(doc, t, ft, an, out) {
  const g = an.gop;
  const fps = frameRate(t);
  const learn = 'A GOP (group of pictures) runs from one key frame to the next. Decoding can only start at a key frame, so the key frame interval decides how precisely a player seeks, how long a viewer joining a live stream waits for a picture, and where streaming segments (HLS, DASH) can be cut.';
  const facts = [];
  if (g.count) facts.push(['GOPs', fmtInt(g.count)]);
  if (g.avgFrames) facts.push(['frames per GOP', g.fixed ? fmtInt(g.minFrames) : `${fmtInt(g.minFrames)}–${fmtInt(g.maxFrames)} (average ${fmtNum(g.avgFrames, 1)})`]);
  if (g.avgSeconds) facts.push(['GOP duration', g.fixed ? secs(g.avgSeconds) : `${secs(g.minSeconds)}–${secs(g.maxSeconds)}`]);
  if (g.closed || g.open) facts.push(['closed / open GOPs', `${fmtInt(g.closed)} / ${fmtInt(g.open)}`]);
  if (an.pattern.length > 1) facts.push(['typical start (display order)', `${an.pattern.split('').join(' ')}${an.pattern.length >= 24 ? ' …' : ''}`]);
  if (g.leadIn) facts.push(['frames before the first key frame', `${fmtInt(g.leadIn)} (cannot be decoded)`]);
  const node = t.node;
  if (ft.intraOnly || (g.count === an.frames && an.frames > 1)) {
    out.push({ level: 'info', group: 'Encoding', title: `${t.label}: every frame is a key frame`, text: `The codec (or this encode) uses intra-only frames: each one is decoded on its own, like a sequence of still images. Seeking and editing are exact and cheap, but the file is several times larger than with inter-frame coding (P- and B-frames). ${learn}`, node });
    return;
  }
  if (g.count <= 1) {
    const long = (an.gops.length ? trackSeconds(t, 0, an.frames) : 0) > 10;
    out.push({ level: long || !g.count ? 'warn' : 'info', group: 'Encoding', title: `${t.label}: ${g.count ? 'a single key frame' : 'no key frame'}`, text: `${g.count ? 'Only the first frame is a key frame' : 'No frame is marked as a key frame'}${long ? '' : ' (normal for a clip shorter than the encoder\'s key frame interval)'}: seeking has to decode from the start, and a viewer joining a live stream could not start at all. ${learn}`, facts, node });
    return;
  }
  const long = g.maxSeconds > 10;
  const title = g.fixed
    ? `${t.label}: a key frame every ${fmtInt(g.minFrames)} frames (${secs(g.avgSeconds)})`
    : `${t.label}: key frames every ${fmtInt(g.minFrames)}–${fmtInt(g.maxFrames)} frames (${secs(g.minSeconds)}–${secs(g.maxSeconds)})`;
  let text = learn;
  let cmd;
  if (long) text += ' Some key frames here are more than 10 seconds apart, which makes seeking slow and coarse and forces long segments.';
  if (g.fixed) text += ` Here every GOP has the same length, so segments of any multiple of ${secs(g.avgSeconds)} start on a key frame.`;
  else {
    text += ' Here the interval varies: encoders add a key frame at scene changes (scene-cut detection), which helps quality but means fixed-length streaming segments do not always start on a key frame. For streaming, a fixed interval is usually forced.';
    const n = Math.max(1, Math.round((fps || 25) * 2));
    cmd = `ffmpeg -i ${sh(doc.name)} -c:v libx264 -g ${n} -keyint_min ${n} -sc_threshold 0 -c:a copy fixed-gop.mp4`;
  }
  out.push({ level: long ? 'warn' : g.fixed ? 'good' : 'info', group: 'Encoding', title, text, facts, node, cmd });
}

function typeInsights(doc, t, ft, an, out) {
  const T = an.types;
  const I = T.I;
  const P = { count: T.P.count + T.p.count, bytes: T.P.bytes + T.p.bytes };
  const B = { count: T.B.count + T.b.count, bytes: T.B.bytes + T.b.bytes };
  const n = an.classified || an.frames;
  const bytes = an.totalBytes;
  const facts = [];
  const row = (label, st) => {
    if (st.count) facts.push([label, `${fmtInt(st.count)} frames (${pct(st.count, n)}), average ${humanBytes(st.bytes / st.count)}, ${pct(st.bytes, bytes)} of the bytes`]);
  };
  row('I-frames', I);
  row('P-frames', P);
  row('B-frames', B);
  row('other (switch, repeated)', { count: T.S.count + T['='].count, bytes: T.S.bytes + T['='].bytes });
  if (ft.ctx?.encrypted) {
    out.push({ level: 'info', group: 'Encoding', title: `${t.label}: frame types hidden by encryption`, text: `Common Encryption leaves only each NAL unit's header in the clear, so Vidscope can tell IDR frames (${fmtInt(I.count)} here) and whether a frame is a reference, but not whether the others are P- or B-frames. ${fmtInt(an.frames - an.classified)} of ${fmtInt(an.frames)} frames stay unclassified.`, node: t.node });
    return;
  }
  const partial = an.complete ? '' : ` (${fmtInt(an.classified)} of ${fmtInt(an.frames)} frames classified so far)`;
  out.push({
    level: 'info',
    group: 'Encoding',
    title: `${t.label}: ${pct(I.count, n)} I, ${pct(P.count, n)} P, ${pct(B.count, n)} B frames`,
    text: `I-frames are pictures coded on their own; P-frames store only changes from earlier frames; B-frames also use a later frame, so they are the cheapest.${I.count && bytes ? ` Here I-frames are ${pct(I.count, n)} of the frames but ${pct(I.bytes, bytes)} of the bytes${B.count ? `, while an average B-frame is ${fmtNum(I.bytes / I.count / Math.max(1, B.bytes / B.count), 0)}× smaller than an I-frame` : ''}.` : ''}${partial}`,
    facts,
    node: t.node,
  });
  if (B.count) {
    const drop = T.b.count;
    out.push({
      level: 'info',
      group: 'Encoding',
      title: `${t.label}: up to ${fmtInt(an.maxB)} B-frame${an.maxB === 1 ? '' : 's'} in a row${an.refB ? ', B-pyramid' : ''}`,
      text: `A B-frame needs the next reference frame before it can be decoded, so the file stores frames in decoding order and the player reorders them for display: the Frames view shows both orders.${an.refB ? ' Some B-frames are themselves references for other B-frames (a B-pyramid), which saves bits.' : ''}${drop ? ` ${fmtInt(drop)} frames (${pct(drop, n)}) are not used as a reference by any other frame, so a player that falls behind can drop them.` : ''} B-frames add a little delay, so low-latency live encodes often turn them off (-bf 0).`,
      node: t.node,
    });
  } else if (['avc', 'hevc', 'mpeg2v', 'mpeg4v'].includes(ft.family) && an.complete && an.classified > 10) {
    out.push({ level: 'info', group: 'Encoding', title: `${t.label}: no B-frames`, text: 'Every inter frame is a P-frame, so decoding order equals display order. This keeps latency low (useful for live streaming and video calls) and is required by the Baseline profile of H.264, at the cost of some compression efficiency.', node: t.node });
  }
  if (an.gop.open) {
    const hevc = ft.family === 'hevc';
    out.push({
      level: 'info',
      group: 'Encoding',
      title: `${t.label}: ${plural(an.gop.open, 'open GOP')}`,
      text: `An open GOP starts with an I-frame that is not an IDR frame (${hevc ? 'a CRA frame' : 'marked by a recovery point'}). The frames right after it in the file may be shown before it and refer to the previous GOP, so a player starting there has to skip them (${hevc ? 'RASL frames' : 'leading B-frames'}). Open GOPs compress slightly better, but many streaming packagers and players expect every segment to start with a closed GOP.${hevc ? ' x265 uses open GOPs by default.' : ''}`,
      cmd: hevc ? `ffmpeg -i ${sh(doc.name)} -c:v libx265 -x265-params open-gop=0 -c:a copy closed-gop.mp4` : undefined,
      node: t.node,
    });
  }
  if (an.hidden) {
    out.push({ level: 'info', group: 'Encoding', title: `${t.label}: ${plural(an.hidden, 'hidden frame')}`, text: 'Some packets carry a frame that is decoded but never shown: an alternate reference ("alt-ref") that usually holds a picture from the future. VP9 and AV1 use these instead of B-frames; the packets that carry them are much larger than their neighbours.', node: t.node });
  }
  if (an.layers > 1) {
    out.push({ level: 'info', group: 'Encoding', title: `${t.label}: ${an.layers} temporal layers`, text: 'Frames are organised in temporal layers: dropping the highest layer halves the frame rate without breaking decoding, which lets a player or network scale the stream down.', node: t.node });
  }
  const s = t.samples;
  if (an.keyNotRap.length) {
    const i = an.keyNotRap[0];
    out.push({ level: 'warn', group: 'Integrity', title: `${t.label}: ${plural(an.keyNotRap.length, 'key frame')} that ${an.keyNotRap.length === 1 ? 'is' : 'are'} not an entry point`, text: `The container marks ${an.keyNotRap.length === 1 ? 'this frame' : 'these frames'} as key frames (where seeking may start), but the frame itself is a ${ft.letter(i) || '?'}-frame that needs earlier frames. A player seeking there shows a broken picture until the next real key frame. First one: frame ${fmtInt(i + 1)}.`, offset: s.offsets[i] });
  }
  if (an.rapNotKey.length) {
    const i = an.rapNotKey[0];
    out.push({ level: 'info', group: 'Integrity', title: `${t.label}: ${plural(an.rapNotKey.length, 'IDR frame')} not marked as key frame${an.rapNotKey.length === 1 ? '' : 's'}`, text: `${an.rapNotKey.length === 1 ? 'This frame is' : 'These frames are'} self-contained entry points in the bitstream, but the container does not list them as key frames, so players will not seek to them. First one: frame ${fmtInt(i + 1)}.`, offset: s.offsets[i] });
  }
}
