// Decoding video frames in the browser with WebCodecs (VideoDecoder), for the pixel microscope.
// A decoder is set up from the track's codec configuration; a frame is decoded by feeding every
// frame from the key frame before it, in decoding order, which is what a player does when it
// seeks there.
//
// A decoded picture is { bitmap: ImageBitmap, luma: { w, h, y } | null, lumaExact, width, height,
// format, index }: the bitmap for drawing, and the luma (Y) plane for measuring.

import { walk } from './model.js';
import { ptsOf, displayOrder } from './frames.js';
import { frameSize } from './bitrate.js';
import { lumaFromRGBA } from './pixels.js';

const DECODABLE = new Set(['avc', 'hevc', 'av1', 'vp9', 'vp8']);
const KEEP = 6; // decoded pictures kept per file, for stepping back and forth

/** Whether this browser can decode video (WebCodecs). */
export function canDecode() {
  return typeof VideoDecoder === 'function' && typeof EncodedVideoChunk === 'function';
}

/** Byte range of the track's decoder configuration record (avcC, hvcC or av1C), or null. */
export function configRange(doc, t) {
  switch (doc.format.id) {
    case 'isobmff':
      for (const n of walk(t.node)) if (/^(avcC|hvcC|av1C)$/.test(n.type)) return [n.bodyOffset, n.end];
      return null;
    case 'matroska':
      return t.cpNode ? [t.cpNode.bodyOffset, t.cpNode.end] : null;
    case 'flv':
      return t.configs?.[0]?.cfg?.record ?? null;
    default:
      return null; // MPEG-TS, AVI and raw streams carry the parameter sets in the frames
  }
}

const startsWithStartCode = (u8) => u8.length >= 4 && u8[0] === 0 && u8[1] === 0 && (u8[2] === 1 || (u8[2] === 0 && u8[3] === 1));

/** VP9's codec string needs the profile: vp09.PP.LL.DD, from the first frame's header. */
function vp9Codec(head) {
  const b = head[0] ?? 0x80;
  const profile = ((b >> 5) & 1) | (((b >> 4) & 1) << 1);
  return `vp09.0${profile}.10.${profile >= 2 ? '10' : '08'}`;
}

/**
 * How to decode track t: { config } for VideoDecoder.configure, or { error } saying why it
 * cannot be decoded here.
 */
export async function decoderSetup(doc, t) {
  if (!canDecode()) return { error: 'This browser cannot decode video itself (no WebCodecs). Chrome, Edge and Safari 16.4 or later can.' };
  if (!t?.samples?.count) return { error: 'The track has no frames.' };
  const fc = doc.frameCodec(t);
  const family = fc?.family ?? t.family ?? null;
  if (fc?.encrypted || t.encrypted) return { error: 'The frames are encrypted (DRM), so they cannot be decoded without the key.' };
  if (!DECODABLE.has(family)) return { error: `${t.codecName} cannot be decoded in the browser: WebCodecs decodes H.264, HEVC, AV1, VP9 and VP8.` };
  const s = t.samples;
  let first = 0;
  while (first < s.count && !s.sizes[first]) first++;
  if (first >= s.count) return { error: 'The track has no frames with data.' };
  const head = await doc.frameHead(t, first, 16);
  const annexB = (family === 'avc' || family === 'hevc') && (!!fc?.annexB || startsWithStartCode(head));
  let codec = t.codecString ?? null;
  if (family === 'vp9' && !/^vp09\./.test(codec ?? '')) codec = vp9Codec(head);
  if (family === 'vp8') codec = 'vp8';
  if (!codec) return { error: 'The codec string of the track is unknown, so the decoder cannot be set up.' };
  const config = { codec, optimizeForLatency: true };
  const size = frameSize(t);
  if (size) {
    config.codedWidth = size.width;
    config.codedHeight = size.height;
  }
  if ((family === 'avc' || family === 'hevc') && !annexB) {
    const range = configRange(doc, t);
    if (!range) return { error: `The ${family === 'avc' ? 'avcC' : 'hvcC'} record with the parameter sets was not found.` };
    config.description = (await doc.source.read(range[0], range[1] - range[0])).slice();
  } else if (family === 'av1') {
    const range = configRange(doc, t);
    if (range && range[1] - range[0] >= 4) config.description = (await doc.source.read(range[0], range[1] - range[0])).slice();
  }
  let support;
  try {
    support = await VideoDecoder.isConfigSupported(config);
  } catch (e) {
    return { error: `The decoder setup was refused: ${e.message}` };
  }
  if (!support.supported) {
    return { error: family === 'hevc'
      ? `This browser cannot decode HEVC (${codec}): it only does with a hardware decoder, which this computer or browser does not offer.`
      : `This browser cannot decode ${codec}.` };
  }
  return { config: support.config ?? config, codec, annexB, family };
}

/** The luma (Y) plane of a decoded frame, reduced to 8 bits; null when the frame cannot be read. */
async function lumaOf(frame) {
  const fmt = frame.format;
  const rect = frame.visibleRect;
  const w = rect.width;
  const h = rect.height;
  if (!fmt || !/^(I420|I422|I444|NV12)/.test(fmt)) return null;
  const buf = new Uint8Array(frame.allocationSize({ rect }));
  const layout = await frame.copyTo(buf, { rect });
  const { offset, stride } = layout[0];
  const y = new Uint8Array(w * h);
  const deep = /P(10|12)$/.exec(fmt);
  if (!deep) {
    for (let r = 0; r < h; r++) y.set(buf.subarray(offset + r * stride, offset + r * stride + w), r * w);
  } else {
    // 10- or 12-bit samples, little-endian 16-bit words: keep the top 8 bits.
    const shift = Number(deep[1]) - 8;
    for (let r = 0; r < h; r++) {
      const o = offset + r * stride;
      for (let x = 0; x < w; x++) y[r * w + x] = ((buf[o + 2 * x] | (buf[o + 2 * x + 1] << 8)) >> shift) & 255;
    }
  }
  return { w, h, y };
}

/** A picture to keep from a decoded VideoFrame (which the caller then closes). */
async function toPicture(frame, index) {
  const w = frame.visibleRect.width;
  const h = frame.visibleRect.height;
  const bitmap = await createImageBitmap(frame, { resizeWidth: w, resizeHeight: h });
  let luma = await lumaOf(frame).catch(() => null);
  let exact = !!luma;
  if (!luma) {
    // No access to the planes (for example a frame kept in GPU memory): read the picture back.
    const cv = new OffscreenCanvas(w, h);
    const g = cv.getContext('2d', { willReadFrequently: true });
    g.drawImage(bitmap, 0, 0);
    luma = lumaFromRGBA(g.getImageData(0, 0, w, h).data, w, h);
    exact = false;
  }
  return { bitmap, luma, lumaExact: exact, width: w, height: h, displayWidth: frame.displayWidth, displayHeight: frame.displayHeight, format: frame.format, index };
}

/** Resolves on the decoder's next 'dequeue' event (it took a chunk from its queue). */
const dequeued = (dec) => new Promise((r) => dec.addEventListener('dequeue', r, { once: true }));

/**
 * Decodes frames of one video track on request, keeping the last few pictures.
 *
 * AV1, VP9 and VP8 show frames in the order they are stored (hidden frames instead of B-frames),
 * so one decoder keeps running and the next frame costs a single decode. H.264 and HEVC may
 * reorder (B-frames; in AVI the file cannot even tell), so a frame may only come out of the
 * decoder after later ones went in: each request decodes from the key frame and flushes.
 */
export class FrameDecoder {
  constructor(doc, t, setup) {
    this.doc = doc;
    this.t = t;
    this.setup = setup;
    this.ts = t.timescale || t.samples.timescale || 1;
    this.cache = new Map(); // decoding index -> picture, least recently used first
    this.queue = Promise.resolve();
    this.closed = false;
    this.lowDelay = ['av1', 'vp9', 'vp8'].includes(setup.family);
    this.live = null;
  }

  micros(i) {
    return Math.round((ptsOf(this.t.samples, i) / this.ts) * 1e6);
  }

  chunk(j, data, first) {
    const s = this.t.samples;
    return new EncodedVideoChunk({ type: j === first || (s.key && s.key[j]) ? 'key' : 'delta', timestamp: this.micros(j), data });
  }

  /** The frame to decode from to get frame i: the key frame before it (or the one before that for a leading frame of an open GOP). */
  startFor(i) {
    const s = this.t.samples;
    if (!s.key) return i;
    let k = i;
    while (k > 0 && !s.key[k]) k--;
    const { rank } = displayOrder(this.t);
    if (k > 0 && rank[i] < rank[k]) {
      k--;
      while (k > 0 && !s.key[k]) k--;
    }
    return k;
  }

  /** How many frames decoding frame i takes from here. */
  cost(i) {
    const L = this.live;
    if (this.lowDelay && L && !L.done && L.start === this.startFor(i) && i >= L.next) return i - L.next + 1;
    return i - this.startFor(i) + 1;
  }

  /**
   * The decoded picture of frame i (decoding order). Requests run one after the other; one whose
   * `stale()` returns true by the time it runs, or while it decodes, gives up and returns null.
   */
  picture(i, { onProgress, stale } = {}) {
    const run = this.queue.then(() => this.decode(i, onProgress, stale));
    this.queue = run.catch(() => {});
    return run;
  }

  async decode(i, onProgress, stale) {
    if (this.closed) return null;
    const s = this.t.samples;
    // A frame without data (a dropped frame in AVI) shows the frame before it.
    while (i > 0 && !s.sizes[i]) i--;
    const hit = this.cache.get(i);
    if (hit) {
      this.cache.delete(i);
      this.cache.set(i, hit);
      return hit;
    }
    if (stale?.()) return null;
    const got = this.lowDelay ? await this.decodeLive(i, onProgress, stale) : await this.decodeRun(i, onProgress, stale);
    if (!got) return null;
    const pic = got.get(i);
    // Keep what was decoded, the wanted picture last: it is the one used most recently.
    for (const [j, p] of [...got].filter(([j]) => j !== i).concat(pic ? [[i, pic]] : [])) {
      if (!p) continue;
      const old = this.cache.get(j);
      if (old) {
        this.cache.delete(j);
        old.bitmap.close();
      }
      this.cache.set(j, p);
    }
    while (this.cache.size > KEEP) {
      const [k, old] = this.cache.entries().next().value;
      this.cache.delete(k);
      old.bitmap.close();
    }
    if (!pic) throw new Error('The decoder did not return this frame.');
    return pic;
  }

  /** Decode from the key frame through frame i, then flush: the pictures of i and its neighbours. */
  async decodeRun(i, onProgress, stale) {
    const s = this.t.samples;
    const start = this.startFor(i);
    // Keep the wanted frame and its neighbours on screen, when this run decodes them anyway.
    const { order, rank } = displayOrder(this.t);
    const keep = new Map();
    for (const k of [rank[i] - 1, rank[i], rank[i] + 1]) {
      const j = order[k];
      if (j !== undefined && j >= start && j <= i && s.sizes[j]) keep.set(this.micros(j), j);
    }
    const got = new Map();
    const pending = [];
    let failure = null;
    const dec = new VideoDecoder({
      output: (frame) => {
        const j = keep.get(frame.timestamp);
        if (j === undefined || got.has(j)) {
          frame.close();
          return;
        }
        got.set(j, null);
        pending.push(toPicture(frame, j).then((p) => got.set(j, p), (e) => { failure ??= e; }).finally(() => frame.close()));
      },
      error: (e) => { failure ??= e; },
    });
    try {
      dec.configure(this.setup.config);
      const total = i - start + 1;
      for (let j = start; j <= i; j++) {
        if (failure) break;
        if (stale?.() || this.closed) return null;
        if (!s.sizes[j]) continue;
        dec.decode(this.chunk(j, await this.doc.frameHead(this.t, j, s.sizes[j]), start));
        if (onProgress && ((j - start) % 8 === 0 || j === i)) onProgress(j - start + 1, total);
        // Let the decoder catch up instead of queueing hundreds of frames.
        while (dec.decodeQueueSize > 12 && !failure) await dequeued(dec);
      }
      if (!failure) await dec.flush();
      await Promise.all(pending);
    } catch (e) {
      failure ??= e;
    } finally {
      if (dec.state !== 'closed') dec.close();
    }
    if (failure) {
      for (const p of got.values()) p?.bitmap.close();
      throw failure instanceof Error ? failure : new Error(String(failure));
    }
    return got;
  }

  /** Frames shown in decoding order: feed the running decoder up to frame i and take its picture. */
  async decodeLive(i, onProgress, stale) {
    const s = this.t.samples;
    const start = this.startFor(i);
    let L = this.live;
    if (!L || L.done || L.start !== start || i < L.next) {
      if (L && !L.done) L.dec.close();
      L = this.live = this.openLive(start);
    }
    const T = this.micros(i);
    const want = new Promise((resolve, reject) => L.waiting.set(T, { i, resolve, reject }));
    want.catch(() => {});
    const from = L.next;
    const total = i - from + 1;
    for (let j = from; j <= i; j++) {
      if (L.done) break;
      if (stale?.() || this.closed) {
        L.waiting.delete(T);
        return null;
      }
      L.next = j + 1;
      if (!s.sizes[j]) continue;
      const data = await this.doc.frameHead(this.t, j, s.sizes[j]);
      if (L.done) break;
      L.dec.decode(this.chunk(j, data, L.start));
      if (onProgress && ((j - from) % 8 === 0 || j === i)) onProgress(j - from + 1, total);
      while (L.dec.decodeQueueSize > 12 && !L.done) await dequeued(L.dec);
    }
    // The decoder returns each frame once it is decoded. If it holds the last one back, flush it
    // out; after a flush it needs a key frame again, so the next request starts over.
    while (L.dec.decodeQueueSize > 0 && !L.done) await dequeued(L.dec);
    const timer = setTimeout(() => {
      if (!L.waiting.has(T) || L.done) return;
      L.done = true;
      L.dec.flush().catch(() => {});
    }, 500);
    try {
      return new Map([[i, await want]]);
    } finally {
      clearTimeout(timer);
    }
  }

  openLive(start) {
    const L = { start, next: start, waiting: new Map(), done: false, dec: null };
    const fail = (e) => {
      L.done = true;
      for (const w of L.waiting.values()) w.reject(e);
      L.waiting.clear();
    };
    L.dec = new VideoDecoder({
      output: (frame) => {
        const w = L.waiting.get(frame.timestamp);
        if (!w) {
          frame.close();
          return;
        }
        L.waiting.delete(frame.timestamp);
        toPicture(frame, w.i).then(w.resolve, w.reject).finally(() => frame.close());
      },
      error: (e) => fail(e instanceof Error ? e : new Error(String(e))),
    });
    L.dec.configure(this.setup.config);
    return L;
  }

  close() {
    this.closed = true;
    if (this.live && !this.live.done) {
      this.live.done = true;
      try {
        this.live.dec.close();
      } catch {
        // already closed
      }
    }
    for (const p of this.cache.values()) p.bitmap.close();
    this.cache.clear();
  }
}
