// The audit: rules over one file and over a ladder, the expectations, the report, and reading
// a remote file by byte ranges without fetching it whole.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { open, sample, haveSample, haveFfmpeg } from './helpers.mjs';
import { NodeFileSource } from '../scripts/node-source.mjs';
import { auditFile, auditLadder, auditMarkdown, allRules, tally, SPECS } from '../web/core/audit.js';
import { REMEDIES } from '../web/core/remedies.js';
import { HttpSource, CachedSource } from '../web/core/source.js';
import { openDocument } from '../web/formats/index.js';
import { parseExpect, mergeExpect, toSarif, toReport, auditInputs, ladderKey } from '../scripts/audit.mjs';

/** A fixture made with ffmpeg for one test, in a temporary folder. */
function makeFixture(name, args) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vidscope-audit-'));
  const file = path.join(dir, name);
  execFileSync('ffmpeg', ['-v', 'error', '-y', ...args, file], { stdio: 'ignore' });
  return { file, dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

async function auditPath(file, expect = {}, opts = {}) {
  const src = await NodeFileSource.open(file);
  const doc = await openDocument(src);
  const r = await auditFile(doc, expect, opts);
  await src.close();
  return r;
}

const LADDER = ['ladder-source.mkv', 'ladder-270p.mp4', 'ladder-180p.mp4', 'ladder-180p-gop40.mp4', 'ladder-remux.mp4'];
const haveLadder = LADDER.every(haveSample);

const byId = (checks, id) => checks.find((c) => c.id === id);

test('every rule has a stable id, a source and a remedy where it can fail', () => {
  const rules = allRules();
  assert.ok(rules.length >= 40, `${rules.length} rules`);
  assert.equal(new Set(rules.map((r) => r.id)).size, rules.length, 'ids are unique');
  for (const r of rules) {
    assert.ok(['critical', 'warning', 'info'].includes(r.severity), `${r.id}: severity`);
    assert.ok(r.spec, `${r.id}: spec`);
  }
  // A remedy exists for every rule that can fail or warn with a fix worth giving.
  for (const id of ['fast-start', 'colour-signalled', 'audio-priming', 'vbv', 'idr-aligned', 'hdr-consistent']) assert.ok(REMEDIES[id]?.fix, `${id} has a remedy`);
});

test('every rule cites a source it links to, Apple items by number, and says when it is only practice', () => {
  for (const r of allRules()) {
    assert.ok(SPECS[r.spec], `${r.id}: unknown source ${r.spec}`);
    assert.match(SPECS[r.spec].url, /^https:\/\//, `${r.id}: the source has a link`);
    assert.ok(r.clause, `${r.id}: names a clause`);
    if (r.spec === 'hlsAuth') assert.match(r.clause, /^\d+\.\d+[a-z]?\b/, `${r.id}: an Apple item number`);
  }
  assert.match(SPECS.practice.name, /not a standard/);
  const bySpec = (id) => allRules().find((r) => r.id === id).spec;
  assert.equal(bySpec('same-audio'), 'rfc8216', 'the same audio bitstream in every variant is RFC 8216 §6.2.4');
  assert.equal(bySpec('audio-rate'), 'practice', 'no Apple item names a sample rate');
});

test('expectations parse from the command line and merge', () => {
  const ex = parseExpect('gop=5,fpsMax=60,colour=1/1/1,audio.codec=AAC LC,audio.sampleRate=44100,audio.required=false,loudness=-16,loudnessTolerance=1,truePeak=-1,segments=5/10');
  assert.equal(ex.gop, 5);
  assert.equal(ex.fpsMax, 60);
  assert.deepEqual(ex.colour, { primaries: 1, transfer: 1, matrix: 1 });
  assert.deepEqual(ex.audio, { codec: 'AAC LC', sampleRate: 44100, required: false }, 'true/false become booleans');
  assert.deepEqual(ex.loudness, { integrated: -16, tolerance: 1, truePeakMax: -1 });
  assert.deepEqual(ex.segments, [5, 10]);
  const merged = mergeExpect(ex, parseExpect('audio.channelsMax=2,gop=2'));
  assert.deepEqual(merged.audio, { codec: 'AAC LC', sampleRate: 44100, required: false, channelsMax: 2 }, 'nested objects merge');
  assert.equal(merged.gop, 2);
  assert.throws(() => parseExpect('colour=bt709'), /primaries\/transfer\/matrix/);
});

test('sync verdicts follow BT.1359: sound may lag more than it may lead', { skip: !haveLadder }, async () => {
  const doc = await open('ladder-270p.mp4');
  const at = async (ms) => byId((await auditFile(doc, {}, { measured: { sync: { audioLateMs: ms } } })).checks, 'av-sync');
  assert.equal((await at(10)).level, 'pass');
  assert.equal((await at(100)).level, 'warn', '100 ms of lag is below the 125 ms detectability threshold');
  assert.equal((await at(150)).level, 'warn', '150 ms of lag is detectable but not yet objectionable');
  assert.equal((await at(200)).level, 'fail', '200 ms of lag is objectionable');
  assert.equal((await at(-60)).level, 'warn', '60 ms of lead is detectable');
  assert.equal((await at(-100)).level, 'fail', '100 ms of lead is objectionable');
  doc._close();
});

test('renditions of one content group into a ladder, other numbered files do not', () => {
  assert.equal(ladderKey('/a/movie-1080p.mp4'), ladderKey('/a/movie-720p.mp4'));
  assert.equal(ladderKey('/a/clip_1920x1080.mp4'), ladderKey('/a/clip_640x360.mp4'));
  assert.notEqual(ladderKey('/a/movie-720p.mp4'), ladderKey('/b/movie-720p.mp4'), 'a different folder is a different ladder');
  assert.equal(ladderKey('/a/movie-1.mp4'), null, 'a bare number is not a rendition label');
  assert.equal(ladderKey('http://h/x/movie-360p.mp4?token=1'), ladderKey('http://h/x/movie-720p.mp4?token=2'));
});

test('an input that cannot be opened is reported and the others still are', { skip: !haveLadder }, async () => {
  const log = [];
  const out = await auditInputs({ inputs: [sample('ladder-270p.mp4'), sample('no-such-file.mp4')], headers: {}, expect: {}, ladder: false, budget: null, measure: false }, (s) => log.push(s));
  assert.equal(out.results.length, 2);
  assert.equal(out.results[0].error, undefined);
  assert.match(out.results[1].error, /ENOENT|no such file/i);
  const report = toReport(out, { expect: {} });
  assert.equal(report.summary.errors, 1);
  assert.equal(report.files[1].error, out.results[1].error);
  const md = auditMarkdown(out.results, out.ladders);
  assert.match(md, /Could not be audited/);
  const sarif = toSarif(report);
  assert.ok(sarif.runs[0].results.every((r) => r.locations[0].physicalLocation.artifactLocation.uri.startsWith('file:')), 'artifacts are file: URLs');
});

test('a Markdown report lists every ladder', { skip: !haveLadder }, async () => {
  const a = await Promise.all(['ladder-270p.mp4', 'ladder-180p.mp4'].map(open));
  const ra = await Promise.all(a.map((d) => auditFile(d, {})));
  const ladders = [{ files: ['x-1080p.mp4', 'x-720p.mp4'], ...auditLadder(ra, {}) }, { files: ['y-1080p.mp4', 'y-720p.mp4'], ...auditLadder(ra, {}) }];
  const md = auditMarkdown(ra, ladders);
  assert.equal((md.match(/^## Ladder: /gm) ?? []).length, 2);
  for (const d of a) d._close();
});

test('pixel aspect and display size read the VUI as the parser stores it', { skip: !haveSample('h264-aac.mp4') || !haveFfmpeg() }, async () => {
  const fx = makeFixture('anamorphic.mp4', ['-i', sample('h264-aac.mp4'), '-t', '1', '-vf', 'setsar=4/3', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'copy']);
  try {
    const r = await auditPath(fx.file);
    assert.equal(byId(r.checks, 'square-pixels').level, 'warn', 'a 4:3 pixel aspect is not square');
    assert.equal(byId(r.checks, 'square-pixels').value, '4:3');
    assert.equal(byId(r.checks, 'display-aspect').level, 'pass', 'ffmpeg wrote a matching tkhd size for the wide pixels');
  } finally {
    fx.cleanup();
  }
});

test('fragments are checked per track, so one moof per track is continuous', { skip: !haveSample('h264-aac.mp4') || !haveFfmpeg() }, async () => {
  const fx = makeFixture('separate.mp4', ['-i', sample('h264-aac.mp4'), '-c', 'copy', '-movflags', 'frag_keyframe+separate_moof+empty_moov', '-frag_duration', '1000000']);
  try {
    const r = await auditPath(fx.file);
    const f = byId(r.checks, 'fragments');
    assert.equal(f.level, 'pass', f.title);
    assert.ok(f.value > 2);
  } finally {
    fx.cleanup();
  }
});

test('a service\'s overlay caps levels per rendition and promotes severities', { skip: !haveLadder }, async () => {
  const doc = await open('ladder-270p.mp4');
  const signalled = Number((await auditFile(doc, {})).facts.video.levelName);
  const below = (signalled - 0.1).toFixed(1);
  const overlay = { severity: { vbv: 'critical', 'gop-length': 'info' }, levelCap: [{ height: 480, fpsMax: 30, level: below }, { height: 1080, fpsMax: 60, level: '4.2' }] };
  const r = await auditFile(doc, { gop: 2, overlay });
  const lp = byId(r.checks, 'level-policy');
  assert.equal(lp.level, 'fail', `the sample signals level ${signalled}, above a cap of ${below}`);
  assert.equal(lp.severity, 'CRITICAL');
  const ok = await auditFile(doc, { overlay: { levelCap: [{ height: 480, fpsMax: 30, level: String(signalled) }] } });
  assert.equal(byId(ok.checks, 'level-policy').level, 'pass', 'a cap at the signalled level passes');
  assert.equal(byId(r.checks, 'gop-length').level, 'fail', 'a 1 s GOP is not the 2 s expected');
  assert.equal(byId(r.checks, 'gop-length').severity, 'INFO', 'demoted by the overlay');
  const plain = await auditFile(doc, { gop: 2 });
  assert.equal(byId(plain.checks, 'level-policy'), undefined, 'no cap, no rule');
  assert.equal(byId(plain.checks, 'gop-length').severity, 'WARNING');
  // A promoted rule's soft finding (a warn) takes the service's severity too.
  const soft = await auditFile(doc, { peakRatio: 0.5 });
  assert.equal(byId(soft.checks, 'peak-ratio').level, 'warn');
  assert.equal(byId(soft.checks, 'peak-ratio').severity, 'WARNING');
  const promoted = await auditFile(doc, { peakRatio: 0.5, overlay: { severity: { 'peak-ratio': 'critical' } } });
  assert.equal(byId(promoted.checks, 'peak-ratio').severity, 'CRITICAL', 'a warning of a rule the service calls critical is critical');
  assert.ok(r.facts.index.size > 0 && r.facts.index.offset >= 0, 'the index location is in the facts');
  doc._close();
});

test('expectation keys are validated, budgets apply per input, digests name the bytes read', { skip: !haveLadder }, async () => {
  const { validateExpect } = await import('../scripts/audit.mjs');
  assert.throws(() => validateExpect({ gopLength: 5 }), /unknown expectation gopLength/);
  assert.throws(() => validateExpect({ audio: { sampleRate: '44100' } }), /audio.sampleRate wants a number/);
  assert.throws(() => validateExpect({ overlay: { levelCap: {} } }), /overlay.levelCap wants a list/);
  assert.deepEqual(validateExpect({ _comment: 'x', gop: 5, audio: { required: false } }), { _comment: 'x', gop: 5, audio: { required: false } });
  const out = await auditInputs({ inputs: [sample('ladder-270p.mp4'), sample('ladder-180p.mp4')], headers: {}, expect: {}, ladder: false, budget: [16 * 1024, 0], digest: true, measure: false }, () => {});
  const [a, b] = out.results;
  assert.ok(a.facts.payload && a.facts.payload.gopsRead < a.facts.payload.gops, 'the first input got the small budget');
  assert.equal(b.facts.payload, null, 'the second input read everything');
  assert.match(a.facts.digest.index, /^[0-9a-f]{64}$/);
  assert.ok(a.facts.digest.ranges.length >= 1 && a.facts.digest.ranges.every((x) => /^[0-9a-f]{64}$/.test(x.sha256) && x.to > x.from));
  const again = await auditInputs({ inputs: [sample('ladder-270p.mp4')], headers: {}, expect: {}, ladder: false, budget: [16 * 1024], digest: true, measure: false }, () => {});
  assert.deepEqual(again.results[0].facts.digest, a.facts.digest, 'the same bytes give the same digests');
});

test('a large file on a server that ignores Range is refused, not downloaded', { skip: !haveLadder }, async () => {
  const s = await serve(sample('ladder-180p.mp4'), { ranges: false });
  try {
    const src = await HttpSource.open(s.url);
    src.maxWholeFile = 1024;
    await assert.rejects(() => openDocument(src), (e) => e.code === 'NO_RANGE_SUPPORT');
    assert.ok(src.stats.bytes < s.size, 'nothing beyond the probe was fetched');
    // Below the cap the whole-file fallback still serves small files.
    const small = await HttpSource.open(s.url);
    const doc = await openDocument(small);
    assert.equal(byId((await auditFile(doc, {})).checks, 'fast-start').level, 'pass');
  } finally {
    await s.close();
  }
});

test('the frame budget spreads the GOPs it reads over the whole file', { skip: !haveLadder }, async () => {
  const doc = await open('ladder-source.mkv');
  const r = await auditFile(doc, {}, { payloadBudget: 1 });
  assert.ok(r.facts.payload, 'a budget below one GOP still reads the start of GOP 0');
  assert.equal(r.facts.payload.gopsRead, 1);
  doc._close();
  const doc2 = await open('ladder-270p.mp4');
  const half = Math.floor(doc2.size / 2);
  const r2 = await auditFile(doc2, {}, { payloadBudget: half });
  const p = r2.facts.payload;
  assert.ok(p.gopsRead >= 2 && p.gopsRead < p.gops, `read ${p.gopsRead} of ${p.gops} GOPs`);
  assert.match(byId(r2.checks, 'key-is-idr').title, /GOPs read/);
  assert.doesNotMatch(byId(r2.checks, 'gop-fixed').title, /GOPs read/, 'key-frame positions come from the sample tables');
  doc2._close();
});

test('a converted rung passes the container and GOP rules, and the ladder rules see its shape', { skip: !haveLadder }, async () => {
  const docs = await Promise.all(['ladder-270p.mp4', 'ladder-180p.mp4'].map(open));
  const results = await Promise.all(docs.map((d) => auditFile(d, { gop: 1, fpsMax: 30, audio: { sampleRate: 48000 }, segments: [1, 2] })));
  const r = results[0];
  assert.equal(byId(r.checks, 'fast-start').level, 'pass');
  assert.equal(byId(r.checks, 'integrity').level, 'pass');
  assert.equal(byId(r.checks, 'one-video-track').level, 'pass');
  assert.equal(byId(r.checks, 'gop-fixed').level, 'pass', 'a key frame every second');
  assert.equal(byId(r.checks, 'gop-length').level, 'pass');
  assert.equal(byId(r.checks, 'key-is-idr').level, 'pass');
  assert.equal(byId(r.checks, 'vbv').level, 'pass', 'the sample was made with maxrate/bufsize');
  assert.equal(byId(r.checks, 'audio-rate').level, 'pass');
  assert.ok(r.facts.video.width === 480 && r.facts.video.height === 270);
  assert.ok(r.facts.encoder.crf > 0, 'the x264 settings were read');
  assert.equal(typeof byId(r.checks, 'fast-start').offset, 'number', 'findings carry a byte offset');
  // A failure carries its severity and a remedy.
  const failed = r.checks.filter((c) => c.level === 'fail' || c.level === 'warn');
  for (const c of failed) assert.ok(c.severity && (c.remedy || c.severity === 'INFO'), `${c.id}: severity and remedy`);
  const ladder = auditLadder(results, { segments: [1, 2] });
  assert.equal(byId(ladder.checks, 'idr-aligned').level, 'pass');
  assert.equal(byId(ladder.checks, 'segment-lengths').level, 'pass');
  assert.deepEqual(byId(ladder.checks, 'segment-lengths').value, [1, 2]);
  assert.equal(byId(ladder.checks, 'same-audio').level, 'pass');
  assert.equal(byId(ladder.checks, 'label-matches-size').level, 'pass');
  for (const d of docs) d._close();
});

test('a rung with a different GOP breaks the alignment of the ladder', { skip: !haveLadder }, async () => {
  const docs = await Promise.all(['ladder-270p.mp4', 'ladder-180p-gop40.mp4'].map(open));
  const results = await Promise.all(docs.map((d) => auditFile(d, {})));
  const ladder = auditLadder(results, { segments: [1, 2] });
  const al = byId(ladder.checks, 'idr-aligned');
  assert.equal(al.level, 'fail');
  assert.equal(al.severity, 'CRITICAL');
  assert.ok(al.value > 0);
  assert.ok(al.remedy.fix.includes('-sc_threshold 0'));
  assert.equal(byId(ladder.checks, 'segment-lengths').level, 'fail', '1.6 s GOPs fit neither 1 nor 2 s segments');
  for (const d of docs) d._close();
});

test('a GOP cut short is named, and the segment it pushes long is found the way a packager cuts', { skip: !haveFfmpeg() }, async () => {
  // A key frame forced at 3.4 s into 1 s GOPs: the GOP before it is 0.4 s and the key frames
  // after it are off the 1 s grid, as at a join between the chunks of a chunked encode.
  const make = (w, h) => makeFixture(`chunk-${h}p.mp4`, ['-f', 'lavfi', '-i', `testsrc2=s=${w}x${h}:r=25:d=8`, '-c:v', 'libx264', '-g', '25', '-keyint_min', '25', '-sc_threshold', '0', '-force_key_frames', '3.4', '-crf', '30', '-pix_fmt', 'yuv420p']);
  const fx = [make(480, 270), make(320, 180)];
  try {
    const results = await Promise.all(fx.map((f) => auditPath(f.file, { gop: 1 })));
    const r = results[0];
    const gf = byId(r.checks, 'gop-fixed');
    assert.equal(gf.level, 'info', 'one short GOP is not an interval that varies');
    assert.match(gf.title, /^Key frame every 25 frames \(1 s\), except 1 shorter GOP \(0\.4 s at 0:03\)/);
    assert.equal(byId(r.checks, 'gop-length').level, 'pass', 'the usual interval, not an average the short GOP pulls down');
    assert.equal(r.facts.video.gop, 1);
    const ladder = auditLadder(results, { segments: [1, 2] });
    assert.equal(byId(ladder.checks, 'idr-aligned').level, 'pass');
    const seg = byId(ladder.checks, 'segment-lengths');
    assert.equal(seg.level, 'warn', 'every GOP but one fits, and the packager meets the shifted key frames');
    assert.equal(seg.severity, 'WARNING');
    assert.match(seg.title, /^1 s segments: 1 of 8 run long \(1\.4 s at 0:03\)$/);
    assert.equal(seg.value, 1.4);
    assert.match(seg.remedy.cause, /chunk/);
  } finally {
    for (const f of fx) f.cleanup();
  }
});

test('the peak is measured per segment, so a large key frame alone does not make a rendition busy', { skip: !haveFfmpeg() }, async () => {
  // A still picture of noise: a large key frame every 4 s and next to nothing between, so the
  // second with the key frame runs about four times the average while every segment is even.
  const fx = makeFixture('still.mp4', ['-f', 'lavfi', '-i', 'color=gray:s=320x240:r=25:d=12,noise=alls=60', '-c:v', 'libx264', '-g', '100', '-keyint_min', '100', '-sc_threshold', '0', '-crf', '23', '-pix_fmt', 'yuv420p']);
  try {
    const r = await auditPath(fx.file, {});
    assert.ok(r.item.rate.ratio > 3, `the busiest second is ${r.item.rate.ratio}× the average`);
    const p = byId(r.checks, 'peak-ratio');
    assert.equal(p.level, 'pass');
    assert.match(p.title, /^Busiest 4 s segment .*, 1(\.\d+)?× the average/);
    assert.ok(p.value < 1.1, `segment peak ${p.value}× the average`);
    assert.match(p.text, /busiest single second/);
    const busy = await auditPath(fx.file, { peakRatio: 0.5 });
    assert.equal(byId(busy.checks, 'peak-ratio').level, 'warn', 'a ratio above the expectation still warns');
  } finally {
    fx.cleanup();
  }
});

test('few bits per pixel warn under a bitrate target, not under constant quality', { skip: !haveFfmpeg() }, async () => {
  const flat = ['-f', 'lavfi', '-i', 'color=gray:s=640x360:r=25:d=4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p'];
  const crf = makeFixture('crf.mp4', [...flat, '-crf', '23']);
  const abr = makeFixture('abr.mp4', [...flat, '-b:v', '30k']);
  try {
    const q = byId((await auditPath(crf.file)).checks, 'bits-per-pixel');
    assert.equal(q.level, 'info', 'CRF spends what a simple picture needs');
    assert.match(q.title, /bits per pixel at CRF 23/);
    const b = byId((await auditPath(abr.file)).checks, 'bits-per-pixel');
    assert.equal(b.level, 'warn');
    assert.equal(b.severity, 'WARNING');
  } finally {
    crf.cleanup();
    abr.cleanup();
  }
});

test('audio priming: an edit list that skips it, one that starts at 0, and none', { skip: !haveFfmpeg() }, async () => {
  const ts = makeFixture('a.ts', ['-f', 'lavfi', '-i', 'sine=f=440:d=3', '-c:a', 'aac', '-f', 'mpegts']);
  const direct = makeFixture('direct.mp4', ['-f', 'lavfi', '-i', 'color=black:s=64x64:r=25:d=3', '-f', 'lavfi', '-i', 'sine=f=440:d=3', '-c:v', 'libx264', '-c:a', 'aac']);
  const remux = (edit) => {
    const file = path.join(ts.dir, `remux-${edit}.mp4`);
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=black:s=64x64:r=25:d=3', '-i', ts.file, '-map', '0', '-map', '1', '-c:v', 'libx264', '-c:a', 'copy', '-use_editlist', String(edit), file], { stdio: 'ignore' });
    return file;
  };
  try {
    const skip = byId((await auditPath(direct.file)).checks, 'audio-priming');
    assert.equal(skip.level, 'pass');
    assert.match(skip.title, /^Edit list skips the first 2\d\.\d ms/);
    const zero = byId((await auditPath(remux(1))).checks, 'audio-priming');
    assert.equal(zero.level, 'warn');
    assert.equal(zero.title, 'The audio edit list starts at 0, so the encoder priming is played', 'an edit list is there, it just does not skip anything');
    const none = byId((await auditPath(remux(0))).checks, 'audio-priming');
    assert.equal(none.level, 'warn');
    assert.equal(none.title, 'No edit list for the encoder priming');
  } finally {
    ts.cleanup();
    direct.cleanup();
  }
});

test('verdicts follow the strength of the Apple item they cite', { skip: !haveFfmpeg() }, async () => {
  const clip = (name, args, input = 'testsrc2=s=320x180:r=25:d=1') => makeFixture(name, ['-f', 'lavfi', '-i', input, ...args]);
  const x264 = (...args) => ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', ...args];
  const fx = {
    main: clip('main.mp4', x264('-profile:v', 'main')),
    high10: clip('high10.mp4', ['-c:v', 'libx264', '-profile:v', 'high10', '-pix_fmt', 'yuv420p10le']),
    l61: clip('l61.mp4', x264('-level', '6.1')),
    l42: clip('l42.mp4', x264('-level', '4.2')),
    fps120: clip('fps120.mp4', x264(), 'testsrc2=s=320x180:r=120:d=1'),
    gop5: clip('gop5.mp4', x264('-g', '125', '-keyint_min', '125', '-sc_threshold', '0'), 'testsrc2=s=160x90:r=25:d=11'),
    av1: clip('av1.mp4', ['-c:v', 'libsvtav1', '-preset', '12', '-pix_fmt', 'yuv420p']),
    mpeg4: clip('mpeg4.mp4', ['-c:v', 'mpeg4']),
    surround: makeFixture('surround.mp4', ['-f', 'lavfi', '-i', 'testsrc2=s=160x90:r=25:d=1', '-f', 'lavfi', '-i', 'sine=d=1', ...x264(), '-c:a', 'aac', '-ac', '6']),
  };
  try {
    const r = Object.fromEntries(await Promise.all(Object.entries(fx).map(async ([k, f]) => [k, await auditPath(f.file)])));
    const at = (k, id) => byId(r[k].checks, id);
    // 1.4 SHOULD: High in preference to Main; 1.3b MUST: nothing above High.
    assert.equal(at('main', 'profile').level, 'warn');
    assert.equal(at('main', 'profile').severity, 'WARNING');
    assert.equal(at('high10', 'profile').severity, 'CRITICAL');
    assert.equal(at('high10', 'depth').severity, 'CRITICAL', '10-bit H.264 is beyond High Profile (1.3b)');
    // 1.3b MUST: at most Level 5.2; 1.11 SHOULD: no higher level than needed.
    assert.equal(at('l42', 'level-cap').level, 'pass', 'level 4.2 is within Apple\'s 5.2');
    assert.equal(at('l61', 'level-cap').severity, 'CRITICAL');
    assert.equal(at('l61', 'level-minimal').level, 'warn');
    assert.equal(at('l61', 'level-minimal').spec, 'hlsAuth');
    // 1.3a SHOULD: some H.264 variants at 4.1 or below.
    const ladder = auditLadder([r.l61, r.l42]);
    assert.equal(byId(ladder.checks, 'levels').level, 'warn');
    assert.equal(byId(auditLadder([r.l42, r.main]).checks, 'levels').level, 'info', 'the Main clip picked a level below 4.1');
    // 1.19 SHALL NOT: above 60 fps.
    assert.equal(at('fps120', 'fps-range').severity, 'CRITICAL');
    // 1.13 SHOULD: a key frame every 2 s, when the service sets no interval of its own.
    assert.equal(at('gop5', 'gop-length').level, 'warn');
    assert.equal(byId((await auditPath(fx.gop5.file, { gop: 5 })).checks, 'gop-length').level, 'pass', 'a service that intends 5 s is judged on its intent');
    // 1.1: AV1 is an Apple codec. 9.6 MUST: multichannel audio in separate audio streams.
    assert.equal(at('av1', 'codec').level, 'pass');
    assert.equal(at('mpeg4', 'codec').severity, 'CRITICAL', 'a codec outside 1.1 breaks a MUST');
    assert.equal(at('surround', 'audio-channels').severity, 'CRITICAL');
  } finally {
    for (const f of Object.values(fx)) f.cleanup();
  }
});

test('what the audit could not check is listed, and the pass rate counts every verdict', { skip: !haveLadder }, async () => {
  const doc = await open('ladder-270p.mp4');
  const r = await auditFile(doc, { loudness: { integrated: -16, tolerance: 1 } });
  for (const id of ['loudness', 'true-peak', 'av-sync', 'quality']) {
    const c = byId(r.checks, id);
    assert.equal(c?.level, 'skip', `${id} is listed as not checked, not left out`);
    assert.match(c.title, /not measured/);
  }
  assert.match(byId(r.checks, 'loudness').text, /target is -16 LUFS/);
  const measured = await auditFile(doc, { loudness: { integrated: -16, tolerance: 1 } }, { measured: { loudness: { integrated: -16.4, truePeak: -2 } } });
  assert.equal(byId(measured.checks, 'loudness').level, 'pass');
  assert.equal(byId(measured.checks, 'true-peak').level, 'pass');
  doc._close();
  const t = tally([{ level: 'pass' }, { level: 'pass' }, { level: 'warn', severity: 'WARNING' }, { level: 'fail', severity: 'CRITICAL' }, { level: 'info' }, { level: 'skip' }]);
  assert.equal(t.compliance, 0.5, 'two passes of four verdicts: a warning is not a pass');
  assert.equal(t.skip, 1);
});

test('a playlist is not failed as a file without video: the CLI audits HLS and refuses DASH', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vidscope-audit-'));
  const file = path.join(dir, 'master.m3u8');
  fs.writeFileSync(file, '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=191049,RESOLUTION=592x320\nv360.m3u8\n');
  try {
    const r = await auditPath(file);
    assert.equal(r.checks.length, 1);
    assert.equal(r.checks[0].level, 'skip');
    assert.match(r.checks[0].title, /Not audited: HLS playlist/);
    assert.equal(tally(r.checks).critical, 0, 'no "No video track" critical finding');
    const out = await auditInputs({ inputs: [file], headers: {}, expect: {}, ladder: false, budget: null, measure: false }, () => {});
    assert.equal(out.results.length, 0);
    assert.equal(out.playlists.length, 1, 'an HLS playlist is audited as a presentation');
    assert.match(out.playlists[0].checks.find((c) => c.id === 'hls-reachable').title, /320p: the playlist could not be read/);
    const mpd = path.join(dir, 'manifest.mpd');
    fs.writeFileSync(mpd, '<?xml version="1.0"?>\n<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static"></MPD>\n');
    const dash = await auditInputs({ inputs: [mpd], headers: {}, expect: {}, ladder: false, budget: null, measure: false }, () => {});
    assert.equal(dash.results[0].reason, 'unsupported');
    assert.match(dash.results[0].error, /DASH manifests are not audited yet/);
    assert.equal(toReport(dash, { expect: {} }).summary.errors, 1, 'the CLI exits 3: an input could not be audited');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('rendition names are size tiers: a wide picture keeps its tier, a wrong one is named', () => {
  const rung = (file, width, height) => ({ file, facts: { video: { width, height } }, checks: [], item: null });
  const ok = auditLadder([rung('v-360p.mp4', 592, 320), rung('v-240p.mp4', 426, 230), rung('v-144p.mp4', 264, 142), rung('film-1080p.mp4', 1920, 800)]);
  const c = byId(ok.checks, 'label-matches-size');
  assert.equal(c.level, 'pass', c.title);
  assert.match(c.text, /keeps the source's shape/);
  const bad = byId(auditLadder([rung('v-360p.mp4', 854, 480), rung('v-720p.mp4', 640, 360)]).checks, 'label-matches-size');
  assert.equal(bad.level, 'warn');
  assert.match(bad.title, /v-360p\.mp4: labelled 360p, but 854×480 is larger than 360p/);
  assert.match(bad.title, /v-720p\.mp4: labelled 720p, but 640×360 fits a 540p frame/);
});

test('the remux keeps the source audio and video, and is judged on its own', { skip: !haveLadder }, async () => {
  const doc = await open('ladder-remux.mp4');
  const r = await auditFile(doc, {});
  assert.equal(r.facts.format, 'isobmff');
  assert.ok(r.checks.length > 15);
  const t = tally(r.checks);
  assert.equal(t.pass + t.warn + t.fail + t.info + t.skip, r.checks.length);
  const md = auditMarkdown([r]);
  assert.match(md, /^# Vidscope audit/);
  assert.match(md, /## Sources/);
  doc._close();
});

test('measured values feed the loudness, sync and fidelity rules', { skip: !haveLadder }, async () => {
  const doc = await open('ladder-270p.mp4');
  const r = await auditFile(doc, { loudness: { integrated: -16, tolerance: 1, truePeakMax: -1 } }, { measured: { loudness: { integrated: -19.2, truePeak: -0.3 }, sync: { audioLateMs: 46 }, quality: { psnr: 38.1, ssim: 0.97 } } });
  assert.equal(byId(r.checks, 'loudness').level, 'fail');
  assert.equal(byId(r.checks, 'true-peak').level, 'fail');
  assert.equal(byId(r.checks, 'av-sync').level, 'warn', '46 ms of lag is a defect but below the BT.1359 detectability threshold');
  assert.equal(byId(r.checks, 'av-sync').severity, 'WARNING');
  assert.equal(byId(r.checks, 'quality').level, 'info');
  doc._close();
});

test('the JSON report and its SARIF form carry the findings', { skip: !haveLadder }, async () => {
  const doc = await open('ladder-180p-gop40.mp4');
  const r = await auditFile(doc, { gop: 1 });
  r.input = sample('ladder-180p-gop40.mp4');
  r.ms = 1;
  const report = toReport({ results: [r], ladders: [] }, { expect: { gop: 1 } });
  assert.equal(report.tool.name, 'vidscope');
  assert.equal(report.files[0].facts.video.gop > 1.5, true, '1.6 s GOPs');
  assert.equal(byId(report.files[0].checks, 'gop-length').level, 'fail');
  assert.ok(report.summary.critical + report.summary.warning >= 1);
  const sarif = toSarif(report);
  assert.equal(sarif.version, '2.1.0');
  assert.ok(sarif.runs[0].tool.driver.rules.length >= 40);
  const gop = sarif.runs[0].results.find((x) => x.ruleId === 'gop-length');
  assert.ok(gop, 'the failed check is a SARIF result');
  assert.equal(gop.level, 'warning');
  doc._close();
});

test('brands, display size, the declared VBV and HDR metadata are judged from the boxes', { skip: !haveLadder || !haveSample('h264-aac-fragmented.mp4') || !haveSample('hevc-10bit-hdr.mp4') }, async () => {
  const rung = await open('ladder-270p.mp4');
  const r = await auditFile(rung, {});
  assert.equal(byId(r.checks, 'brands').level, 'info');
  assert.ok(byId(r.checks, 'brands').value.includes('isom'));
  assert.equal(byId(r.checks, 'display-aspect').level, 'pass');
  assert.equal(byId(r.checks, 'vbv-holds').level, 'pass', 'the sample never underflows its own VBV');
  assert.equal(byId(r.checks, 'fragments'), undefined, 'not a fragmented file');
  rung._close();
  const frag = await open('h264-aac-fragmented.mp4');
  const f = await auditFile(frag, {});
  assert.equal(byId(f.checks, 'fragments').level, 'pass');
  assert.equal(byId(f.checks, 'fragments').value, 4);
  frag._close();
  const cmaf = await open('h264-aac-dash-sidx.mp4');
  const d = await auditFile(cmaf, {});
  assert.match(byId(d.checks, 'brands').title, /CMAF/);
  cmaf._close();
  const hdr = await open('hevc-10bit-hdr.mp4');
  const h = await auditFile(hdr, {});
  assert.equal(byId(h.checks, 'colour-signalled').level, 'pass');
  assert.equal(byId(h.checks, 'hdr-consistent').level, 'info', '10-bit PQ with BT.2020 primaries and matrix is a genuine HDR rendition');
  assert.equal(byId(h.checks, 'hdr-metadata').level, 'warn', 'no mdcv/clli in the sample');
  assert.equal(h.facts.video.colour, '9/16/9');
  hdr._close();
});

/** A server scripted per request: handler(req, res, n) with n counting from 0. */
function scripted(handler) {
  let n = 0;
  const server = http.createServer((req, res) => handler(req, res, n++));
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${server.address().port}/x.mp4`,
    reset: () => { n = 0; },
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
  })));
}

test('a retry is judged on its own status: a whole-file answer after a failed range read meets the size cap', async () => {
  const bytes = Buffer.from('0123456789');
  // First answer: a 206 whose body dies after the headers. Second: the whole file with 200.
  const s = await scripted((req, res, n) => {
    if (n % 2 === 0) {
      res.writeHead(206, { 'content-range': 'bytes 5-6/10', 'content-length': 2 });
      res.flushHeaders();
      setTimeout(() => res.socket.destroy(), 20);
      return;
    }
    res.writeHead(200, { 'content-length': bytes.length });
    res.end(bytes);
  });
  try {
    const capped = new HttpSource(s.url, 10, 'x.mp4', { retries: 1, timeoutMs: 2000, maxWholeFile: 5 });
    await assert.rejects(() => capped.readRaw(5, 2), (e) => e.code === 'NO_RANGE_SUPPORT', 'a 10-byte whole-file retry is refused under a 5-byte cap');
    s.reset();
    const open = new HttpSource(s.url, 10, 'x.mp4', { retries: 1, timeoutMs: 2000, maxWholeFile: 64 });
    const got = await open.readRaw(5, 2);
    assert.equal(Buffer.from(got).toString(), '56', 'the two bytes asked for, not the whole file');
    assert.equal(open.stats.wholeFile, true);
  } finally {
    await s.close();
  }
});

test('a server that sends headers and then nothing cannot hold a read', async () => {
  const s = await scripted((req, res) => {
    res.writeHead(206, { 'content-range': 'bytes 0-1/10', 'content-length': 2 });
    res.flushHeaders();
    // ... and never a byte of the body.
  });
  try {
    const src = new HttpSource(s.url, 10, 'x.mp4', { retries: 0, timeoutMs: 200 });
    const t0 = Date.now();
    await assert.rejects(() => src.readRaw(0, 2));
    assert.ok(Date.now() - t0 < 3000, `gave up after ${Date.now() - t0} ms`);
  } finally {
    await s.close();
  }
});

test('a range answer that starts elsewhere is refused', async () => {
  const s = await scripted((req, res) => {
    res.writeHead(206, { 'content-range': 'bytes 0-1/10', 'content-length': 2 });
    res.end('01');
  });
  try {
    const src = new HttpSource(s.url, 10, 'x.mp4', { retries: 0, timeoutMs: 2000 });
    await assert.rejects(() => src.readRaw(5, 2), (e) => e.code === 'BAD_RANGE');
  } finally {
    await s.close();
  }
});

/** A small server that honours Range (or ignores it, or hides the total, to test the fallbacks). */
function serve(file, { ranges = true, total = true } = {}) {
  const bytes = fs.readFileSync(file);
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push(req.headers.range ?? null);
    const m = ranges && req.headers.range && /^bytes=(\d+)-(\d*)$/.exec(req.headers.range);
    if (req.method === 'HEAD') {
      res.writeHead(200, { 'content-length': bytes.length, 'accept-ranges': ranges ? 'bytes' : 'none' });
      return res.end();
    }
    if (m) {
      const start = Number(m[1]);
      const end = m[2] ? Math.min(Number(m[2]), bytes.length - 1) : bytes.length - 1;
      res.writeHead(206, { 'content-range': `bytes ${start}-${end}/${total ? bytes.length : '*'}`, 'content-length': end - start + 1, 'content-type': 'video/mp4' });
      return res.end(bytes.subarray(start, end + 1));
    }
    res.writeHead(200, { 'content-length': bytes.length, 'content-type': 'video/mp4' });
    res.end(bytes);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}/${encodeURIComponent(file.split('/').pop())}`, hits, close: () => new Promise((r) => server.close(r)), size: bytes.length })));
}

test('a remote file is audited by byte ranges, reading only what the rules need', { skip: !haveLadder }, async () => {
  const s = await serve(sample('ladder-270p.mp4'));
  try {
    const src = await HttpSource.open(s.url, { headers: { 'x-audit': 'yes' } });
    assert.equal(src.size, s.size, 'the size comes from Content-Range');
    assert.equal(src.name, 'ladder-270p.mp4');
    const cached = new CachedSource(src, { blockSize: 16 * 1024 });
    const doc = await openDocument(cached);
    const r = await auditFile(doc, { gop: 1 }, { payloadBudget: 16 * 1024 });
    assert.equal(byId(r.checks, 'fast-start').level, 'pass');
    assert.equal(byId(r.checks, 'gop-length').level, 'pass', 'the GOP comes from the sample tables, no payload needed');
    assert.ok(r.facts.payload.gopsRead < r.facts.payload.gops, `read ${r.facts.payload.gopsRead} of ${r.facts.payload.gops} GOPs`);
    assert.match(byId(r.checks, 'key-is-idr').title, /GOPs read/);
    assert.ok(src.stats.bytes < s.size, `${src.stats.bytes} of ${s.size} bytes fetched`);
    assert.ok(s.hits.every((h) => h && h.startsWith('bytes=')), 'every request was a range request');
  } finally {
    await s.close();
  }
});

test('a range reply without a total length falls back to the HEAD for the size', { skip: !haveLadder }, async () => {
  const s = await serve(sample('ladder-180p.mp4'), { total: false });
  try {
    const src = await HttpSource.open(s.url);
    assert.equal(src.size, s.size);
    assert.ok(s.hits.length >= 1);
    const doc = await openDocument(src);
    const r = await auditFile(doc, {});
    assert.equal(byId(r.checks, 'fast-start').level, 'pass');
    assert.notEqual(src.stats.wholeFile, true, 'ranges were honoured');
  } finally {
    await s.close();
  }
});

test('a server that ignores Range costs one download, not one per read', { skip: !haveLadder }, async () => {
  const s = await serve(sample('ladder-180p.mp4'), { ranges: false });
  try {
    const src = await HttpSource.open(s.url);
    assert.equal(src.size, s.size, 'the size comes from Content-Length');
    const doc = await openDocument(src);
    const r = await auditFile(doc, {});
    assert.equal(byId(r.checks, 'fast-start').level, 'pass');
    assert.equal(src.stats.wholeFile, true);
    assert.ok(src.stats.bytes <= s.size * 2, `${src.stats.bytes} bytes for a ${s.size} byte file`);
  } finally {
    await s.close();
  }
});
