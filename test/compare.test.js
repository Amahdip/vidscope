// Comparing a source with the versions converted from it: properties side by side, copies,
// key frame alignment, segment lengths and the frame each version shows at a moment.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { open, haveSample } from './helpers.mjs';
import {
  summarize, compareRows, changesFor, keyAlignment, segmentFit, bitsOverTime, frameAtTime, frameFacts,
  framesAround, copiedTrack, contentStem, encoderSummary, niceFps, fpsText, audioCodecName,
} from '../web/core/compare.js';

const LADDER = ['ladder-source.mkv', 'ladder-270p.mp4', 'ladder-180p.mp4', 'ladder-180p-gop40.mp4', 'ladder-remux.mp4'];
const haveLadder = LADDER.every(haveSample);

let cache = null;
/** The ladder samples, opened and summarized once. */
async function ladder() {
  if (!cache) {
    cache = {};
    for (const name of LADDER) {
      const doc = await open(name);
      cache[name.replace(/^ladder-|\.\w+$/g, '')] = await summarize(doc);
    }
  }
  return cache;
}

const row = (rows, label) => rows.find((r) => r.label === label);

test('names that differ only in version words group together', () => {
  const stem = contentStem('Big_Buck_Bunny_1080_10s_5MB.mp4');
  assert.equal(contentStem('Big_Buck_Bunny_360_10s_1MB (1).mp4'), stem);
  assert.equal(contentStem('Big_Buck_Bunny_720_10s_2MB.mkv'), stem);
  for (const n of ['movie_1080p.mp4', 'movie-720p-high.mp4', 'movie.480p.low.mp4', 'movie_source.mov']) assert.equal(contentStem(n), 'movie', n);
  assert.equal(contentStem('sample_1920x1080.mp4'), contentStem('sample_640x360.mp4'));
  assert.notEqual(contentStem('trailer_720p.mp4'), contentStem('movie_720p.mp4'));
});

test('encoder settings are summarized from the x264 and x265 strings', () => {
  const x264 = encoderSummary('x264 - core 164 r3095 baee400 - H.264/MPEG-4 AVC codec - Copyleft 2003-2022 - http://www.videolan.org/x264.html - options: cabac=1 ref=3 deblock=1:0:0 bframes=3 keyint=48 keyint_min=48 scenecut=0 rc=crf mbtree=1 crf=23.0 qcomp=0.60 vbv_maxrate=3000 vbv_bufsize=6000 crf_max=0.0');
  assert.equal(x264.who, 'x264 core 164 r3095 baee400');
  assert.equal(x264.text, 'x264 core 164 r3095 baee400 · crf 23.0 · maxrate 3000 / bufsize 6000 · keyint 48 · bframes 3 · ref 3');
  const x265 = encoderSummary('x265 (build 199) - 3.5+1-f0c1022b6:[Mac OS X][clang 14.0.3][64 bit] 8bit+10bit+12bit - H.265/HEVC codec - Copyright 2013-2018 (c) Multicoreware, Inc - http://x265.org - options: cpuid=1111039 bframes=4 keyint=250 min-keyint=25 rc=abr bitrate=2000 qcomp=0.60 vbv-maxrate=0 vbv-bufsize=0 ref=3');
  assert.equal(x265.who, 'x265 (build 199) 3.5+1-f0c1022b6');
  assert.equal(x265.text, 'x265 (build 199) 3.5+1-f0c1022b6 · ABR 2000 kb/s · keyint 250 · bframes 4 · ref 3');
  assert.equal(encoderSummary(null), null);
});

test('frame rates measured from rounded timestamps snap to the usual ones', () => {
  assert.equal(fpsText(niceFps(29.999)), '30 fps');
  assert.equal(fpsText(niceFps(30000 / 1001)), '29.97 fps');
  assert.equal(fpsText(niceFps(23.976)), '23.976 fps');
  assert.equal(fpsText(niceFps(12.5)), '12.5 fps');
  assert.equal(fpsText(niceFps(29.9)), '29.9 fps', 'a rate that is really different is kept');
});

test('audio codecs have one name whatever the container calls them', () => {
  assert.equal(audioCodecName({ codecName: 'AAC', codecString: 'mp4a.40.2' }), 'AAC LC');
  assert.equal(audioCodecName({ codecName: 'MPEG-4 Audio (AAC)', codecString: 'mp4a.40.2' }), 'AAC LC');
  assert.equal(audioCodecName({ codecName: 'AAC (ADTS)', codecString: 'mp4a.40.5' }), 'HE-AAC');
  assert.equal(audioCodecName({ codecName: 'AC-3 (Dolby Digital)', codecString: 'ac-3' }), 'AC-3');
  assert.equal(audioCodecName({ codecName: 'AC-3' }), 'AC-3');
  assert.equal(audioCodecName({ codecName: 'MPEG Audio Layer II', codecString: 'mp4a.6B' }), 'MP2');
  assert.equal(audioCodecName({ codecName: 'MP3' }), 'MP3');
});

test('key frames line up when they are within half a frame', () => {
  const item = (keys, fps = 25) => ({ fps, keyTimes: Float64Array.from(keys), duration: 6 });
  const ref = item([0]);
  assert.equal(keyAlignment([ref, item([0, 2, 4]), item([0, 2.01, 4])], 0).aligned, true);
  const ka = keyAlignment([ref, item([0, 2, 4]), item([0, 2.05, 4])], 0);
  assert.equal(ka.aligned, false);
  assert.deepEqual([...ka.per[1].odd], [0, 1, 0]);
  assert.equal(ka.per[2].alignedAll, 2);
  const fit = segmentFit([ref, item([0, 2, 4]), item([0, 2, 3, 4])], 0, [2, 4]);
  assert.deepEqual(fit.map((f) => [f.len, f.bounds, f.missing]), [[2, 2, 0], [4, 1, 0]]);
});

test('the ladder: what each conversion changed and lost', { skip: !haveLadder }, async () => {
  const L = await ladder();
  const items = [L.source, L['270p'], L['180p'], L.remux];
  const rows = compareRows(items, 0);
  const res = row(rows, 'resolution');
  assert.deepEqual(res.cells.map((c) => c.text), ['640×360', '480×270', '320×180', '640×360']);
  assert.deepEqual(res.cells.map((c) => c.state), ['ref', 'changed', 'changed', 'same']);
  assert.equal(res.cells[1].note, '−44 %');
  assert.deepEqual(row(rows, 'subtitles').cells.map((c) => c.state), ['ref', 'lost', 'lost', 'lost']);
  assert.deepEqual(row(rows, 'channels').cells.map((c) => c.state), ['ref', 'changed', 'changed', 'same']);
  // The same codec is called differently by the MKV and MP4 parsers; the rows must not say it changed.
  assert.deepEqual(row(rows, 'codec').cells.map((c) => c.state), ['ref', 'same', 'same', 'same']);
  assert.deepEqual(row(rows, 'audio tracks').cells.map((c) => c.state), ['ref', 'same', 'same', 'same']);
  assert.ok(row(rows, 'duration').cells.slice(1).every((c) => c.state === 'same'), 'milliseconds of container rounding are not a change');
  assert.match(row(rows, 'encoder').cells[1].text, /crf 26\.0 · maxrate 500 \/ bufsize 1000 · keyint 25/);
  const ch = changesFor(rows, 0, 1).map((c) => `${c.label}:${c.state}`);
  for (const want of ['container:changed', 'resolution:changed', 'video bitrate:changed', 'GOP:changed', 'channels:changed', 'subtitles:lost']) assert.ok(ch.includes(want), want);
  assert.ok(!changesFor(rows, 0, 3).some((c) => ['resolution', 'video bitrate', 'GOP', 'channels'].includes(c.label)), 'the remux changed only the container and dropped the subtitles');
});

test('a remux is recognized as a copy, a re-encode is not', { skip: !haveLadder }, async () => {
  const L = await ladder();
  assert.equal(copiedTrack(L.source.video, L.remux.video), true);
  assert.equal(copiedTrack(L.source.audio[0], L.remux.audio[0]), true);
  assert.equal(copiedTrack(L.source.video, L['270p'].video), false);
  assert.equal(copiedTrack(L.source.video, null), null);
});

test('key frames of the ladder versions line up; a different GOP does not', { skip: !haveLadder }, async () => {
  const L = await ladder();
  const good = keyAlignment([L.source, L['270p'], L['180p']], 0);
  assert.equal(good.aligned, true);
  assert.equal(good.per[1].keys, 4, 'a key frame every second in a 4 s clip');
  assert.deepEqual(segmentFit([L.source, L['270p'], L['180p']], 0, [1, 2]).map((f) => f.missing), [0, 0]);
  const bad = keyAlignment([L.source, L['270p'], L['180p-gop40']], 0);
  assert.equal(bad.aligned, false);
  assert.equal(bad.per[2].keys, 3, 'key frames at 0, 1.6 and 3.2 s');
  assert.equal(bad.per[2].alignedAll, 1, 'only the first one has a match');
  assert.ok(segmentFit([L.source, L['270p'], L['180p-gop40']], 0, [2]).every((f) => f.missing > 0));
});

test('the frame each version shows at a moment', { skip: !haveLadder }, async () => {
  const L = await ladder();
  const it = L['270p'];
  const k1 = frameFacts(it, frameAtTime(it, 1.0));
  assert.equal(k1.display, 25);
  assert.equal(k1.key, true);
  assert.equal(k1.gopIndex, 1);
  assert.equal(k1.time, 1);
  const mid = frameFacts(it, frameAtTime(it, 1.5));
  assert.equal(mid.display, 37);
  assert.equal(mid.key, false);
  assert.ok(Math.abs(mid.sinceKey - 0.48) < 1e-9);
  assert.ok(mid.decodeFrom > 1 && mid.decodeFrom <= 25);
  assert.equal(frameAtTime(it, 99), it.order[it.times.length - 1], 'after the end: the last frame');
  // The strip around a frame is in display order, centred on it.
  const around = framesAround(it, mid.display, 3, 3);
  assert.deepEqual(around.map((x) => x.k), [34, 35, 36, 37, 38, 39, 40]);
  // Bits over time add up to the whole video track.
  const bits = bitsOverTime(it, 0.5, Math.ceil(it.duration / 0.5));
  let total = 0;
  for (let i = 0; i < it.video.samples.count; i++) total += it.video.samples.sizes[i] * 8;
  assert.equal(bits.reduce((a, b) => a + b, 0), total);
});
