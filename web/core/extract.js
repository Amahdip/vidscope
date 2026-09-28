// An audio track's frames as a stream a decoder reads on its own, fetched by byte range, so a
// decoder on the far side of HTTP gets the audio without the file: all of the audio and, where
// frames are finely interleaved, some of the video between them, in a bounded number of reads.

import { adtsHeader } from '../codecs/mpeg4audio.js';

/**
 * How a track's frames can be streamed: 'aac' (framed with ADTS headers), 'ac3' or 'eac3'
 * (their frames carry their own sync words), or null with the reason it cannot.
 */
export function audioStreamFormat(doc, t) {
  if (!t?.samples?.count) return { format: null, reason: 'no audio samples' };
  if (t.encrypted || t.encryption) return { format: null, reason: 'the samples are encrypted' };
  if (!doc.framesContiguous) return { format: null, reason: 'frames are not stored as whole runs of bytes' };
  const e = t.entry ?? {};
  if (e.esds?.asc) return adtsHeader(e.esds.asc, 0) ? { format: 'aac' } : { format: null, reason: 'an AAC configuration ADTS cannot carry' };
  if (e.ac3) return { format: 'ac3' };
  if (e.ec3) return { format: 'eac3' };
  return { format: null, reason: `${t.codecName ?? t.codec ?? 'this codec'} is not streamed by range` };
}

/**
 * Byte runs covering a track's samples in order, one request each. Samples closer than `gap`
 * share a run; beyond that only the largest gaps split runs, so there are at most `maxRuns`
 * (FFmpeg interleaves two audio frames per video frame: reading those one by one would take
 * thousands of requests, so the video between them is read along). No run exceeds `maxRun`.
 */
export function sampleRuns(t, { gap = 16 * 1024, maxRuns = 1000, maxRun = 4 * 1024 * 1024 } = {}) {
  const s = t.samples;
  const gaps = [];
  for (let i = 1; i < s.count; i++) {
    const g = s.offsets[i] - (s.offsets[i - 1] + s.sizes[i - 1]);
    if (g > gap) gaps.push(g);
  }
  let join = gap;
  if (gaps.length >= maxRuns) join = gaps.sort((a, b) => b - a)[maxRuns - 1];
  const runs = [];
  let run = null;
  for (let i = 0; i < s.count; i++) {
    const at = s.offsets[i];
    const end = at + s.sizes[i];
    if (run && at >= run.end && at - run.end <= join && end - run.start <= maxRun) {
      run.end = end;
      run.last = i;
    } else {
      run = { start: at, end, first: i, last: i };
      runs.push(run);
    }
  }
  return runs;
}

/**
 * The track's frames in decoding order, as chunks of bytes ready for a decoder, with at most
 * `concurrency` runs read at once. `read(offset, length)` fetches exact bytes (a raw source's
 * readRaw, not a block cache that would pull the video in too).
 */
export async function* audioStream(doc, t, read, { concurrency = 6, gap, maxRuns, maxRun } = {}) {
  const { format, reason } = audioStreamFormat(doc, t);
  if (!format) throw new Error(`cannot stream this audio track: ${reason}`);
  const s = t.samples;
  const asc = t.entry?.esds?.asc;
  const runs = sampleRuns(t, { gap, maxRuns, maxRun });
  const pending = [];
  let next = 0;
  const fill = () => {
    while (pending.length < concurrency && next < runs.length) {
      const r = runs[next++];
      const p = Promise.resolve().then(() => read(r.start, r.end - r.start)).then((u8) => ({ r, u8 }));
      p.catch(() => {}); // a read still in flight when the reader stops must not go unhandled
      pending.push(p);
    }
  };
  fill();
  while (pending.length) {
    const { r, u8 } = await pending.shift();
    fill();
    if (u8.length < r.end - r.start) throw new Error(`short read at byte ${r.start}: ${u8.length} of ${r.end - r.start} bytes`);
    if (format !== 'aac') {
      // Samples of one run may sit apart (a gap under `gap`): copy each out.
      if (r.end - r.start === sizeOf(s, r)) {
        yield u8.subarray(0, r.end - r.start);
      } else {
        for (let i = r.first; i <= r.last; i++) yield u8.subarray(s.offsets[i] - r.start, s.offsets[i] - r.start + s.sizes[i]);
      }
      continue;
    }
    let bytes = 0;
    for (let i = r.first; i <= r.last; i++) bytes += 7 + s.sizes[i];
    const out = new Uint8Array(bytes);
    let o = 0;
    for (let i = r.first; i <= r.last; i++) {
      const head = adtsHeader(asc, s.sizes[i]);
      if (!head) throw new Error(`AAC frame ${i} is too large for ADTS (${s.sizes[i]} bytes)`);
      out.set(head, o);
      out.set(u8.subarray(s.offsets[i] - r.start, s.offsets[i] - r.start + s.sizes[i]), o + 7);
      o += 7 + s.sizes[i];
    }
    yield out;
  }
}

const sizeOf = (s, r) => {
  let n = 0;
  for (let i = r.first; i <= r.last; i++) n += s.sizes[i];
  return n;
};
