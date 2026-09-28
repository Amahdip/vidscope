// Loudness from the audio samples alone: the ADTS framing, the bound on requests, the value
// against FFmpeg reading the whole file, and a ladder over HTTP where renditions that share an
// audio encode are measured once, from the smallest file.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { haveFfmpeg, haveSample, sample } from './helpers.mjs';
import { adtsHeader, parseAdts } from '../web/codecs/mpeg4audio.js';
import { sampleRuns } from '../web/core/extract.js';
import { auditInputs } from '../scripts/audit.mjs';

const byId = (checks, id) => checks.find((c) => c.id === id);
// The frames streamed to FFmpeg include the codec's first samples, which FFmpeg reading the file
// trims by its edit list; on a clip of a few seconds that moves the rounded value by 0.1 LU,
// the accuracy EBU Tech 3341 asks of a meter.
const near = (a, b, what) => assert.ok(Math.abs(a - b) <= 0.1 + 1e-9, `${what}: ${a}, FFmpeg on the whole file ${b}`);

test('an ADTS header written from the AudioSpecificConfig reads back as the same frame', () => {
  const head = adtsHeader({ aot: 2, sampleRate: 48000, channelConfig: 2 }, 371);
  const frame = new Uint8Array(378);
  frame.set(head);
  const h = parseAdts(frame, 0, frame.length, 0, []);
  assert.equal(h.error, undefined);
  assert.deepEqual([h.aot, h.sampleRate, h.channelConfig, h.frameLength, h.headerSize, h.blocks], [2, 48000, 2, 378, 7, 1]);
  assert.equal(adtsHeader({ aot: 2, sampleRate: 48000, channelConfig: 0 }, 100), null, 'a channel layout from a PCE');
  assert.equal(adtsHeader({ aot: 23, sampleRate: 48000, channelConfig: 2 }, 100), null, 'an object type ADTS cannot name');
  assert.equal(adtsHeader({ aot: 2, sampleRate: 12345, channelConfig: 2 }, 100), null, 'a rate outside the index table');
  assert.equal(adtsHeader({ aot: 2, sampleRate: 48000, channelConfig: 2 }, 8185), null, 'a frame over 8191 bytes');
});

test('runs keep to a bounded number of requests and read the video between frames only when they must', () => {
  const track = (n, size, gap) => ({ samples: { count: n, offsets: Float64Array.from({ length: n }, (_, i) => i * (size + gap)), sizes: Uint32Array.from({ length: n }, () => size) } });
  const coarse = sampleRuns(track(600, 24000, 300000)); // one audio chunk per second of a 10-minute film
  assert.equal(coarse.length, 600, 'coarse chunks are read on their own');
  assert.ok(coarse.every((r) => r.end - r.start === 24000), 'no video read along');
  const fine = sampleRuns(track(14000, 380, 27000)); // two AAC frames per video frame
  assert.ok(fine.length <= 1000, `${fine.length} runs`);
  const close = sampleRuns(track(100, 400, 1000));
  assert.equal(close.length, 1, 'neighbours closer than 16 KB share a run');
  assert.equal(sampleRuns(track(10, 3 * 1024 * 1024, 0)).length, 10, 'no run grows past 4 MB');
});

// ------------------------------------------------------------------ a ladder over HTTP

let dir;
let server;
let base;
const served = new Map(); // path -> bytes sent

before(() => {
  if (!haveFfmpeg()) return;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vidscope-loud-'));
  // Three renditions of one source, each with its own AAC encoder at the same settings, as a
  // converter writes them: the audio frames come out identical.
  const out = (name, scale, rate) => ['-map', scale, '-map', '1:a', '-c:v', 'libx264', '-preset', 'ultrafast', '-b:v', rate, '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', path.join(dir, name)];
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=25:d=20', '-f', 'lavfi', '-i', 'sine=f=440:d=20:sample_rate=48000',
    '-filter_complex', '[0:v]split=3[a][b][c];[b]scale=640:360[b2];[c]scale=320:180[c2]',
    ...out('film-720p.mp4', '[a]', '4M'), ...out('film-360p.mp4', '[b2]', '1M'), ...out('film-180p.mp4', '[c2]', '200k')], { stdio: 'ignore' });
  server = http.createServer((req, res) => {
    const file = path.join(dir, new URL(req.url, 'http://x').pathname);
    if (!file.startsWith(dir) || !fs.existsSync(file)) return res.writeHead(404).end();
    const size = fs.statSync(file).size;
    const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? '');
    const from = m ? Number(m[1]) : 0;
    const to = m && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
    res.writeHead(m ? 206 : 200, { 'Content-Length': to - from + 1, ...(m ? { 'Content-Range': `bytes ${from}-${to}/${size}` } : {}) });
    const body = fs.readFileSync(file).subarray(from, to + 1);
    served.set(req.url, (served.get(req.url) ?? 0) + body.length);
    res.end(req.method === 'HEAD' ? undefined : body);
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => {
    base = `http://127.0.0.1:${server.address().port}`;
    r();
  }));
});

after(() => {
  server?.close();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

/** FFmpeg's own reading of the whole file, mono as dual mono: { integrated, truePeak }. */
function reference(file) {
  const err = spawnSync('ffmpeg', ['-hide_banner', '-nostdin', '-i', file, '-vn', '-af', 'ebur128=peak=true:dualmono=true', '-f', 'null', '-'], { encoding: 'utf8' }).stderr;
  const tail = err.slice(err.lastIndexOf('Integrated loudness'));
  return { integrated: Number(/I:\s*(-?[\d.]+) LUFS/.exec(tail)[1]), truePeak: Number(/Peak:\s*(-?[\d.]+) dBFS/.exec(tail)[1]) };
}

test('a ladder sharing one audio encode is measured once, from its smallest file, without reading the large ones', { skip: !haveFfmpeg() }, async () => {
  served.clear();
  const lines = [];
  const inputs = ['film-720p.mp4', 'film-360p.mp4', 'film-180p.mp4'].map((n) => `${base}/${n}`);
  const out = await auditInputs({ inputs, headers: {}, expect: { loudness: { integrated: -16, tolerance: 1 } }, ladder: true, budget: [262144], measure: true, source: null }, (l) => lines.push(l));
  const want = reference(path.join(dir, 'film-720p.mp4'));
  for (const r of out.results) {
    const l = byId(r.checks, 'loudness');
    near(l.value, want.integrated, `${r.file}: integrated loudness`);
    near(byId(r.checks, 'true-peak').value, want.truePeak, `${r.file}: true peak`);
  }
  const said = lines.filter((l) => /loudness/.test(l));
  assert.equal(said.length, 1, said.join('\n'));
  assert.match(said[0], /film-180p\.mp4: loudness .* from [\d.]+ MB in \d+ requests?; the same audio in 2 other inputs/);
  const size = (n) => fs.statSync(path.join(dir, n)).size;
  assert.ok(served.get('/film-720p.mp4') < size('film-720p.mp4') / 4, `720p: ${served.get('/film-720p.mp4')} of ${size('film-720p.mp4')} bytes read`);
  assert.ok(served.get('/film-360p.mp4') < size('film-360p.mp4') / 2, `360p: ${served.get('/film-360p.mp4')} of ${size('film-360p.mp4')} bytes read`);
});

test('AC-3 frames stream as they are, and Opus is left to FFmpeg', { skip: !haveFfmpeg() || !haveSample('h264-ac3.mp4') || !haveSample('av1-opus.mp4') }, async () => {
  for (const [name, via] of [['h264-ac3.mp4', /from [\d.]+ MB in \d+ requests?$/], ['av1-opus.mp4', /from the whole file, read by ffmpeg \(Opus is not streamed by range\)/]]) {
    const lines = [];
    const out = await auditInputs({ inputs: [sample(name)], headers: {}, expect: {}, ladder: false, budget: null, measure: true, source: null }, (l) => lines.push(l));
    const want = reference(sample(name));
    near(byId(out.results[0].checks, 'loudness').value, want.integrated, name);
    assert.match(lines.find((l) => /loudness/.test(l)), via, name);
  }
});

test('a mono rendition measures as loud as the same sound in stereo, as players send it to both speakers', { skip: !haveFfmpeg() }, async () => {
  // R 128 measures mono as one loudspeaker, 3 LU below the same signal on two; a player plays a
  // mono track on both, so the audit measures it as dual mono (EBU Tech 3344).
  // The stereo file carries the tone at full level on both channels, as a player plays mono.
  for (const [name, pan] of [['tone-stereo.mp4', 'pan=stereo|c0=c0|c1=c0'], ['tone-mono.mp4', 'pan=mono|c0=c0']]) {
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=f=1000:d=10:sample_rate=48000', '-af', pan, '-c:a', 'aac', '-b:a', '96k', path.join(dir, name)], { stdio: 'ignore' });
  }
  const out = await auditInputs({ inputs: ['tone-stereo.mp4', 'tone-mono.mp4'].map((n) => path.join(dir, n)), headers: {}, expect: {}, ladder: false, budget: null, measure: true, source: null }, () => {});
  const [stereo, mono] = out.results.map((r) => byId(r.checks, 'loudness').value);
  assert.ok(Math.abs(stereo - mono) <= 0.2, `stereo ${stereo} LUFS, mono ${mono} LUFS`);
});
