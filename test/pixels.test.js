// Pixel comparisons for the pixel microscope: PSNR and SSIM must match FFmpeg's psnr and ssim
// filters, the bilinear scaling FFmpeg's scale filter, and every container must give the decoder
// its configuration record.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { open, sample, haveSample } from './helpers.mjs';
import { psnr, ssim, mse, resizeLuma, diffImage, lumaFromRGBA, comparePictures, sameAspect } from '../web/core/pixels.js';
import { configRange } from '../web/core/decode.js';

let ffmpegOk;
function haveFfmpeg() {
  if (ffmpegOk === undefined) {
    try {
      execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
      ffmpegOk = true;
    } catch {
      ffmpegOk = false;
    }
  }
  return ffmpegOk;
}

/** The Y plane of frame n (display order) as FFmpeg decodes it, optionally after a filter. */
function lumaOf(name, n, w, h, vf = '') {
  const out = execFileSync('ffmpeg', ['-v', 'error', '-i', sample(name), '-vf', `select=eq(n\\,${n})${vf ? `,${vf}` : ''},format=yuv420p`, '-frames:v', '1', '-f', 'rawvideo', '-'], { maxBuffer: 64 << 20 });
  return { w, h, y: new Uint8Array(out.subarray(0, w * h)) };
}

/** FFmpeg's per-frame statistics line for frame n from a psnr or ssim filter graph. */
function ffStats(a, b, graph, n) {
  const out = execFileSync('ffmpeg', ['-v', 'error', '-i', sample(a), '-i', sample(b), '-lavfi', graph, '-f', 'null', '-'], { maxBuffer: 64 << 20 }).toString();
  return out.split('\n').find((l) => l.startsWith(`n:${n + 1} `)) ?? '';
}

const plane = (w, h, f) => ({ w, h, y: Uint8Array.from({ length: w * h }, (_, i) => f(i % w, Math.floor(i / w))) });

test('PSNR and SSIM of identical and known pictures', () => {
  const a = plane(64, 32, (x, y) => (x * 3 + y * 5) & 255);
  assert.equal(psnr(a, a), Infinity);
  assert.equal(ssim(a, a), 1);
  // Every pixel off by one: MSE 1, PSNR 10·log10(255²) = 48.13 dB.
  const b = { ...a, y: a.y.map((v) => (v === 255 ? 254 : v + 1)) };
  assert.equal(mse(a, b), 1);
  assert.ok(Math.abs(psnr(a, b) - 48.1308) < 1e-3);
  assert.ok(ssim(a, b) > 0.99 && ssim(a, b) < 1);
  // Flat grey against a pattern: structure gone, SSIM low.
  assert.ok(ssim(a, plane(64, 32, () => 128)) < 0.2);
});

test('scaling, differences and video-range luma', () => {
  const g = plane(8, 4, (x) => x * 30);
  assert.equal(resizeLuma(g, 8, 4), g, 'same size: nothing to do');
  const up = resizeLuma(g, 16, 8);
  assert.equal(up.w, 16);
  for (let x = 1; x < 16; x++) assert.ok(up.y[x] >= up.y[x - 1], 'a ramp stays a ramp');
  const d = diffImage(g, { ...g, y: g.y.map((v, i) => (i === 3 ? v + 10 : v)) }, 4);
  assert.equal(d.max, 10);
  assert.equal(d.rgba[3 * 4], 40, 'difference × gain');
  assert.equal(d.bigShare, 1 / 32);
  const L = lumaFromRGBA(Uint8ClampedArray.from([255, 255, 255, 255, 0, 0, 0, 255]), 2, 1);
  assert.deepEqual([...L.y], [235, 16], 'white and black in video range');
  assert.ok(sameAspect(1920, 1080, 640, 360));
  assert.ok(!sameAspect(1920, 1080, 960, 400));
  assert.deepEqual(comparePictures({ luma: plane(16, 9, () => 1) }, { luma: plane(12, 5, () => 1) }), { error: 'different picture shapes' });
});

const haveLadder = ['ladder-source.mkv', 'ladder-270p.mp4', 'ladder-180p.mp4', 'ladder-180p-gop40.mp4'].every(haveSample);

test('PSNR and SSIM match FFmpeg\'s psnr and ssim filters', { skip: (!haveFfmpeg() || !haveLadder) && 'needs ffmpeg and npm run samples' }, () => {
  for (const n of [0, 25, 60]) {
    const a = lumaOf('ladder-180p.mp4', n, 320, 180);
    const b = lumaOf('ladder-180p-gop40.mp4', n, 320, 180);
    const p = /psnr_y:(\S+)/.exec(ffStats('ladder-180p-gop40.mp4', 'ladder-180p.mp4', '[0:v][1:v]psnr=stats_file=-', n))[1];
    const s = Number(/Y:(\S+)/.exec(ffStats('ladder-180p-gop40.mp4', 'ladder-180p.mp4', '[0:v][1:v]ssim=stats_file=-', n))[1]);
    if (p === 'inf') assert.equal(psnr(a, b), Infinity, `frame ${n}`);
    else assert.ok(Math.abs(psnr(a, b) - Number(p)) < 0.006, `frame ${n}: PSNR ${psnr(a, b)} vs ${p}`);
    assert.ok(Math.abs(ssim(a, b) - s) < 2e-6, `frame ${n}: SSIM ${ssim(a, b)} vs ${s}`);
  }
});

test('bilinear scaling matches FFmpeg, and so does PSNR against a bigger reference', { skip: (!haveFfmpeg() || !haveLadder) && 'needs ffmpeg and npm run samples' }, () => {
  const small = lumaOf('ladder-270p.mp4', 25, 480, 270);
  const mine = resizeLuma(small, 640, 360);
  const theirs = lumaOf('ladder-270p.mp4', 25, 640, 360, 'scale=640:360:flags=bilinear');
  assert.ok(psnr(theirs, mine) > 55, `our scaling vs FFmpeg's: ${psnr(theirs, mine)} dB`);
  const src = lumaOf('ladder-source.mkv', 25, 640, 360);
  const p = Number(/psnr_y:(\S+)/.exec(ffStats('ladder-270p.mp4', 'ladder-source.mkv', '[0:v]scale=640:360:flags=bilinear[s];[s][1:v]psnr=stats_file=-', 25))[1]);
  const c = comparePictures({ luma: src }, { luma: small });
  assert.ok(c.scaled);
  assert.ok(Math.abs(c.psnr - p) < 0.01, `${c.psnr} vs FFmpeg ${p}`);
});

test('every container hands the decoder its configuration record', { skip: !haveSample('h264-aac.mp4') && 'run npm run samples' }, async () => {
  const cases = [
    ['h264-aac.mp4', 0x01], ['hevc-aac.mp4', 0x01], ['av1-opus.mp4', 0x81], ['h264-aac-fragmented.mp4', 0x01],
    ['h264-aac.mkv', 0x01], ['matroska-hevc-hdr.mkv', 0x01], ['matroska-av1-opus.mkv', 0x81],
    ['h264-aac.flv', 0x01], ['flv-hevc-opus.flv', 0x01], ['flv-av1-aac.flv', 0x81],
    // MPEG-TS and AVI carry the parameter sets in the frames (Annex B): no record.
    ['h264-aac.ts', null], ['riff-h264-aac.avi', null],
  ];
  for (const [name, first] of cases) {
    if (!haveSample(name)) continue;
    const doc = await open(name);
    if (doc.loadSamples) await doc.loadSamples();
    const t = doc.tracks.find((x) => x.kind === 'video');
    const r = configRange(doc, t);
    if (first === null) {
      assert.equal(r, null, name);
    } else {
      assert.ok(r && r[1] > r[0] + 4, `${name}: a record`);
      const b = await doc.source.read(r[0], r[1] - r[0]);
      assert.equal(b[0], first, `${name}: record version byte`);
    }
    doc._close();
  }
});
