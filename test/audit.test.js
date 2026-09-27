// The audit: rules over one file and over a ladder, the expectations, the report, and reading
// a remote file by byte ranges without fetching it whole.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import { open, sample, haveSample } from './helpers.mjs';
import { auditFile, auditLadder, auditMarkdown, allRules, tally } from '../web/core/audit.js';
import { REMEDIES } from '../web/core/remedies.js';
import { HttpSource, CachedSource } from '../web/core/source.js';
import { openDocument } from '../web/formats/index.js';
import { parseExpect, toSarif, toReport } from '../scripts/audit.mjs';

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

test('expectations parse from the command line', () => {
  const ex = parseExpect('gop=5,fpsMax=60,colour=1/1/1,audio.codec=AAC LC,audio.sampleRate=44100,loudness=-16,loudnessTolerance=1,truePeak=-1,segments=5/10');
  assert.equal(ex.gop, 5);
  assert.equal(ex.fpsMax, 60);
  assert.deepEqual(ex.colour, { primaries: 1, transfer: 1, matrix: 1 });
  assert.deepEqual(ex.audio, { codec: 'AAC LC', sampleRate: 44100 });
  assert.deepEqual(ex.loudness, { integrated: -16, tolerance: 1, truePeakMax: -1 });
  assert.deepEqual(ex.segments, [5, 10]);
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
  assert.equal(byId(r.checks, 'av-sync').level, 'fail', '46 ms is past the detectability limit');
  assert.equal(byId(r.checks, 'av-sync').severity, 'CRITICAL');
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

/** A small server that honours Range (or ignores it, to test the fallback). */
function serve(file, { ranges = true } = {}) {
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
      res.writeHead(206, { 'content-range': `bytes ${start}-${end}/${bytes.length}`, 'content-length': end - start + 1, 'content-type': 'video/mp4' });
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
    const cached = new CachedSource(src, { blockSize: 64 * 1024 });
    const doc = await openDocument(cached);
    const r = await auditFile(doc, { gop: 1 }, { payloadBudget: 64 * 1024 });
    assert.equal(byId(r.checks, 'fast-start').level, 'pass');
    assert.equal(byId(r.checks, 'gop-length').level, 'pass', 'the GOP comes from the sample tables, no payload needed');
    assert.ok(r.facts.payload.gopsRead < r.facts.payload.gops, `read ${r.facts.payload.gopsRead} of ${r.facts.payload.gops} GOPs`);
    assert.match(byId(r.checks, 'key-is-idr').title, /GOPs read\)/);
    assert.ok(src.stats.bytes < s.size, `${src.stats.bytes} of ${s.size} bytes fetched`);
    assert.ok(s.hits.every((h) => h && h.startsWith('bytes=')), 'every request was a range request');
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
