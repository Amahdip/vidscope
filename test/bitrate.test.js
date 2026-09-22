// Bitrate over time, rate-control guesses and the VBV buffer simulation.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { open, haveSample } from './helpers.mjs';
import { rateTracks, bitrateSeries, rateStats, rateControlGuess, simulateVbv, frameSize, bitsPerPixel } from '../web/core/bitrate.js';

/** A fake video track: `sizes` in bytes, one frame every 1/fps s. */
function fakeTrack(sizes, fps = 25, props = [['coded size', '640×360']]) {
  const n = sizes.length;
  const dts = new Float64Array(n);
  const durations = new Float64Array(n).fill(1);
  for (let i = 0; i < n; i++) dts[i] = i;
  return { kind: 'video', index: 0, label: 'Video 1', props, timescale: fps, samples: { count: n, sizes: Uint32Array.from(sizes), dts, durations, offsets: new Float64Array(n) } };
}

test('bits per slice add up to the track sizes', { skip: !haveSample('h264-aac.mp4') }, async () => {
  const doc = await open('h264-aac.mp4');
  const tracks = rateTracks(doc);
  assert.equal(tracks[0].kind, 'video', 'video first');
  for (const bin of [0.5, 1, 2]) {
    const d = bitrateSeries(tracks, bin);
    d.series.forEach(({ track, bits }) => {
      let bytes = 0;
      for (let i = 0; i < track.samples.count; i++) bytes += track.samples.sizes[i];
      assert.equal(bits.reduce((a, b) => a + b, 0), bytes * 8, `${track.label}, ${bin} s slices`);
    });
    assert.ok(Math.abs(d.n * bin - (d.end - d.start)) <= bin, 'slices cover the duration');
  }
  doc._close();
});

test('average, peak and variation', () => {
  const st = rateStats(Float64Array.from([1e6, 2e6, 1e6, 2e6, 5e5]), 1, 4.5);
  assert.equal(st.avg, 6.5e6 / 4.5);
  assert.equal(st.peak, 2e6, 'the last, partial slice is not a peak');
  assert.equal(st.peakAt, 1);
  assert.ok(st.cv > 0.3);
});

test('rate-control guesses', () => {
  const flat = rateStats(new Float64Array(20).fill(4e6), 1, 20);
  assert.equal(rateControlGuess(flat, 20).key, 'cbr');
  const capped = rateStats(Float64Array.from({ length: 20 }, (_, k) => (k % 2 ? 5e6 : 3e6)), 1, 20);
  assert.equal(rateControlGuess(capped, 20).key, 'capped');
  const vbr = rateStats(Float64Array.from({ length: 20 }, (_, k) => (k === 7 ? 2e7 : 2e6)), 1, 20);
  assert.equal(rateControlGuess(vbr, 20).key, 'vbr');
  assert.equal(rateControlGuess(vbr, 3).key, 'short');
});

test('VBV: a stream at maxrate never underflows; one huge frame does', () => {
  // 25 fps, 20,000 bytes per frame = 4 Mb/s.
  const steady = fakeTrack(new Array(250).fill(20000));
  const ok = simulateVbv(steady, { maxrate: 4e6, bufsize: 8e6 });
  assert.equal(ok.underflows.length, 0);
  // A 1.5 MB frame (12 Mbit) cannot fit an 8 Mbit buffer.
  const spike = fakeTrack([...new Array(100).fill(20000), 1500000, ...new Array(100).fill(20000)]);
  const bad = simulateVbv(spike, { maxrate: 4e6, bufsize: 8e6 });
  assert.deepEqual(bad.underflows, [100]);
  // A buffer big enough for the spike (and full when it comes) absorbs it.
  const big = simulateVbv(spike, { maxrate: 4e6, bufsize: 16e6, init: 1 });
  assert.equal(big.underflows.length, 0);
  // Below the stream's own rate the buffer drains.
  assert.ok(simulateVbv(steady, { maxrate: 3e6, bufsize: 8e6 }).underflows.length > 0);
});

test('frame size and bits per pixel', () => {
  const t = fakeTrack(new Array(50).fill(10000), 25, [['coded size', '1920×1080 (the SPS says 1920×1088)']]);
  assert.deepEqual(frameSize(t), { width: 1920, height: 1080 });
  // 2 Mb/s over 1920×1080 at 25 fps
  assert.ok(Math.abs(bitsPerPixel(t, 2e6) - 2e6 / (1920 * 1080 * 25)) < 1e-9);
  assert.equal(frameSize({ props: [] }), null);
});
