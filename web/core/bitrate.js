// Bitrate over time: how many bits each track spends per time slice, its average and peak,
// a guess at the encoder's rate control, and a VBV (video buffering verifier) simulation that
// shows what -maxrate and -bufsize mean for a file.

import { frameRate } from './frames.js';

/** Decode time of sample i of a track, in seconds. */
function dtsSec(t, i) {
  const s = t.samples;
  return s.dts[i] / (t.timescale || s.timescale || 1);
}

/** Tracks with a frame table, in a fixed order: video first, then audio, then the rest. */
export function rateTracks(doc) {
  const rank = { video: 0, audio: 1 };
  return doc.tracks.filter((t) => t.samples?.count).sort((a, b) => (rank[a.kind] ?? 2) - (rank[b.kind] ?? 2) || a.index - b.index);
}

/**
 * Bits per time slice for each track: { start, bin, n, series: [{ track, bits: Float64Array }],
 * total: Float64Array }. Frames count at their decode time, the order a player receives them.
 */
export function bitrateSeries(tracks, bin = 1) {
  let start = Infinity;
  let end = -Infinity;
  for (const t of tracks) {
    const s = t.samples;
    start = Math.min(start, dtsSec(t, 0));
    const last = s.count - 1;
    end = Math.max(end, dtsSec(t, last) + (s.durations?.[last] ?? 0) / (t.timescale || s.timescale || 1));
  }
  if (!Number.isFinite(start)) return { start: 0, bin, n: 0, series: [], total: new Float64Array(0), end: 0 };
  const n = Math.max(1, Math.ceil((end - start) / bin - 1e-9));
  const total = new Float64Array(n);
  const series = tracks.map((t) => {
    const bits = new Float64Array(n);
    const s = t.samples;
    for (let i = 0; i < s.count; i++) {
      const k = Math.min(n - 1, Math.max(0, Math.floor((dtsSec(t, i) - start) / bin)));
      bits[k] += s.sizes[i] * 8;
    }
    for (let k = 0; k < n; k++) total[k] += bits[k];
    return { track: t, bits };
  });
  return { start, end, bin, n, series, total };
}

/** Average, peak and variation of a bits-per-slice series (the last, partial slice is left out). */
export function rateStats(bits, bin, seconds) {
  const n = bits.length;
  const full = n > 1 ? n - 1 : n;
  let sum = 0;
  let peak = 0;
  let peakAt = 0;
  for (let k = 0; k < n; k++) sum += bits[k];
  for (let k = 0; k < full; k++) {
    if (bits[k] > peak) {
      peak = bits[k];
      peakAt = k;
    }
  }
  const avg = seconds > 0 ? sum / seconds : 0;
  const mean = full ? bits.slice(0, full).reduce((a, b) => a + b, 0) / full : 0;
  let v = 0;
  for (let k = 0; k < full; k++) v += (bits[k] - mean) ** 2;
  const cv = mean ? Math.sqrt(v / Math.max(1, full)) / mean : 0;
  return { avg, peak: peak / bin, peakAt, cv, ratio: avg ? peak / bin / avg : 0 };
}

/** Width and height of a video track, from its properties ("640×360"). */
export function frameSize(t) {
  for (const key of ['coded size', 'display size', 'size', 'resolution']) {
    const v = (t.props ?? []).find(([k]) => k === key)?.[1];
    const m = v && /(\d+)\s*[×x]\s*(\d+)/.exec(v);
    if (m) return { width: Number(m[1]), height: Number(m[2]) };
  }
  return null;
}

/** Bits per pixel: the average bitrate spread over every pixel of every frame. */
export function bitsPerPixel(t, avgBitrate) {
  const size = frameSize(t);
  const fps = frameRate(t);
  if (!size || !fps || !avgBitrate) return null;
  return avgBitrate / (size.width * size.height * fps);
}

/**
 * What the bitrate curve suggests about the encoder's rate control. Only a guess: the
 * encoder settings, when the file has them, say for sure.
 */
export function rateControlGuess(st, seconds) {
  if (seconds < 6) return { key: 'short', label: 'too short to tell', text: 'The clip is only a few seconds long, too short to judge how the encoder managed its bitrate.' };
  if (st.cv < 0.1 && st.ratio < 1.2) {
    return { key: 'cbr', label: 'constant bitrate (CBR)', text: 'Every second carries almost the same number of bits. That is constant bitrate: predictable for networks and broadcast, but easy scenes get more bits than they need and hard scenes fewer.' };
  }
  if (st.ratio < 1.6) {
    return { key: 'capped', label: 'variable, but capped', text: 'The bitrate varies with the content but stays close to its average, as if a maximum rate held the peaks down: typical of capped CRF or constrained VBR, the usual choice for streaming.' };
  }
  return { key: 'vbr', label: 'variable (quality-based)', text: 'The bitrate follows the content: busy scenes take several times the average, calm scenes much less. That is how constant-quality modes such as CRF, or unconstrained 2-pass VBR, spend bits.' };
}

/**
 * Simulate the decoder's input buffer (the VBV / HRD model) for a video track: bits arrive at
 * `maxrate` until the buffer holds `bufsize`, and each frame's bits leave at its decode time.
 * A frame that finds too few bits in the buffer is an underflow: a player receiving the stream
 * at maxrate would have to stop and wait.
 */
export function simulateVbv(t, { maxrate, bufsize, init = 0.9 }) {
  const s = t.samples;
  const n = s.count;
  const level = new Float64Array(n); // bits in the buffer just after frame i was removed
  const before = new Float64Array(n); // bits in the buffer just before
  const underflows = [];
  let buf = bufsize * init;
  let prev = dtsSec(t, 0);
  let min = Infinity;
  let full = 0; // seconds spent with a full buffer (the encoder could have used more bits)
  for (let i = 0; i < n; i++) {
    const at = dtsSec(t, i);
    const dt = Math.max(0, at - prev);
    const room = bufsize - buf;
    const inflow = maxrate * dt;
    if (inflow > room) full += (inflow - room) / maxrate;
    buf = Math.min(bufsize, buf + inflow);
    prev = at;
    before[i] = buf;
    buf -= s.sizes[i] * 8;
    if (buf < 0) {
      // Half a bit of slack: a stream running at exactly maxrate must not underflow by rounding.
      if (buf < -0.5) underflows.push(i);
      buf = 0;
    }
    level[i] = buf;
    if (buf < min) min = buf;
  }
  return { level, before, underflows, min, fullSeconds: full };
}
