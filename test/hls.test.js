// The HLS playlist audit: parsing, the RFC 8216 rates, and a presentation made by FFmpeg served
// over HTTP, first as FFmpeg wrote it and then with the defects seen on real services.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { haveFfmpeg } from './helpers.mjs';
import { parsePlaylist, parseAttributes, peakSegmentRate, averageSegmentRate, measureHls, redact } from '../web/core/hls.js';
import { auditPlaylist, tally } from '../web/core/audit.js';
import { auditInputs, toReport } from '../scripts/audit.mjs';

const byId = (checks, id) => checks.find((c) => c.id === id);

test('attribute lists keep commas inside quoted strings', () => {
  const a = parseAttributes('BANDWIDTH=191049,CODECS="avc1.4d401e,mp4a.40.2",RESOLUTION=592x320,FRAME-RATE=32.000');
  assert.deepEqual(a, { BANDWIDTH: '191049', CODECS: 'avc1.4d401e,mp4a.40.2', RESOLUTION: '592x320', 'FRAME-RATE': '32.000' });
});

test('a multivariant and a media playlist parse, with the version their tags need', () => {
  const m = parsePlaylist('#EXTM3U\n#EXT-X-INDEPENDENT-SEGMENTS\n#EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=958048,AVERAGE-BANDWIDTH=946767,RESOLUTION=640x360,FRAME-RATE=25,CODECS="avc1.64001e,mp4a.40.2"\nv0/index.m3u8?sig=abc\n#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=90000,URI="v0/iframes.m3u8"\n', 'https://cdn.example/show/master.m3u8');
  assert.equal(m.kind, 'master');
  assert.equal(m.variants[0].url, 'https://cdn.example/show/v0/index.m3u8?sig=abc');
  assert.deepEqual(m.variants[0].resolution, { width: 640, height: 360 });
  assert.equal(m.variants[0].averageBandwidth, 946767);
  assert.equal(m.iframes.length, 1);
  assert.ok(m.programId && m.independentSegments);
  const media = parsePlaylist('#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:6\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:5.005,\n#EXT-X-BYTERANGE:1000@0\nall.m4s\n#EXTINF:5.005,\n#EXT-X-BYTERANGE:1200\nall.m4s\n#EXT-X-ENDLIST\n', 'https://cdn.example/v0/index.m3u8');
  assert.equal(media.kind, 'media');
  assert.deepEqual(media.segments.map((s) => s.range), [{ length: 1000, offset: 0 }, { length: 1200, offset: 1000 }], 'a range without @ follows the previous one');
  assert.equal(media.needsVersion, 6, 'EXT-X-MAP outside an I-frame playlist needs version 6');
  assert.ok(media.endList && media.segments[0].map.url.endsWith('/v0/init.mp4'));
});

test('the peak segment bit rate is the busiest run of 0.5 to 1.5 target durations (RFC 8216 §4.1)', () => {
  // The last segment of a 10 s-target playlist, 6.688 s long, is a run on its own.
  const tail = [{ duration: 10, size: 262072 }, { duration: 10, size: 274104 }, { duration: 6.688, size: 198904 }];
  assert.equal(Math.round(peakSegmentRate(tail, 10).rate), 237923);
  // With a 6 s target, runs of 3 to 9 s count: one 2 s segment alone is too short however big
  // it is, so the busiest run is the big segment with its neighbour (4 s).
  const two = [{ duration: 2, size: 900000 }, { duration: 2, size: 100000 }, { duration: 2, size: 100000 }, { duration: 2, size: 100000 }, { duration: 2, size: 100000 }];
  const p = peakSegmentRate(two, 6);
  assert.equal(p.count, 2);
  assert.equal(Math.round(p.rate), Math.round((1000000 * 8) / 4));
  assert.equal(Math.round(averageSegmentRate(two)), Math.round((1300000 * 8) / 10));
  assert.equal(peakSegmentRate([{ duration: 10, size: null }], 10), null, 'an unmeasured segment makes no run');
});

test('signed URLs lose their query in anything written down', () => {
  assert.equal(redact('https://node.example/a/chunk.m3u8?sig=SECRET'), 'https://node.example/a/chunk.m3u8?…');
});

// ------------------------------------------------------------------ a presentation over HTTP

let dir;
let server;
let base;
const broken = new Set(); // paths the server answers 404 for
let refuseHead = false;

before(() => {
  if (!haveFfmpeg()) return;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vidscope-hls-'));
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=25:d=12', '-f', 'lavfi', '-i', 'sine=f=440:d=12',
    '-filter_complex', '[0:v]split=2[a][b];[b]scale=320:180[bs]', '-map', '[a]', '-map', '[bs]', '-map', '1:a', '-map', '1:a',
    '-c:v', 'libx264', '-g', '50', '-keyint_min', '50', '-sc_threshold', '0', '-b:v:0', '800k', '-b:v:1', '300k', '-c:a', 'aac', '-b:a', '96k',
    '-f', 'hls', '-hls_time', '4', '-hls_playlist_type', 'vod', '-master_pl_name', 'master.m3u8', '-var_stream_map', 'v:0,a:0 v:1,a:1',
    '-hls_segment_filename', path.join(dir, 'v%v/seg%03d.ts'), path.join(dir, 'v%v/index.m3u8')], { stdio: 'ignore' });
  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const file = path.join(dir, url.pathname);
    if (broken.has(url.pathname) || !file.startsWith(dir) || !fs.existsSync(file)) {
      res.writeHead(404).end();
      return;
    }
    if (req.method === 'HEAD' && refuseHead) {
      res.writeHead(405).end();
      return;
    }
    const body = fs.readFileSync(file);
    const range = /bytes=(\d+)-(\d+)/.exec(req.headers.range ?? '');
    if (range) {
      const [from, to] = [Number(range[1]), Math.min(Number(range[2]), body.length - 1)];
      res.writeHead(206, { 'Content-Range': `bytes ${from}-${to}/${body.length}`, 'Content-Length': to - from + 1 });
      res.end(req.method === 'HEAD' ? undefined : body.subarray(from, to + 1));
      return;
    }
    res.writeHead(200, { 'Content-Length': body.length });
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

const io = {
  text: async (u) => {
    const r = await fetch(u);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.text();
  },
  size: async (u) => {
    let r = await fetch(u, { method: 'HEAD' });
    if (r.ok && Number(r.headers.get('content-length')) > 0) return Number(r.headers.get('content-length'));
    r = await fetch(u, { headers: { Range: 'bytes=0-0' } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return Number(/\/(\d+)$/.exec(r.headers.get('content-range'))[1]);
  },
  bytes: async (u) => new Uint8Array(await (await fetch(u)).arrayBuffer()),
};

/** Write a variant of FFmpeg's master playlist and audit it. */
async function auditMaster(edit, name = 'edited.m3u8') {
  const text = edit(fs.readFileSync(path.join(dir, 'master.m3u8'), 'utf8'));
  fs.writeFileSync(path.join(dir, name), text);
  const m = await measureHls(`${base}/${name}`, io);
  return { m, ...auditPlaylist(m) };
}

test('FFmpeg\'s own HLS: declared and measured agree, and what it leaves out is named', { skip: !haveFfmpeg() }, async () => {
  const { m, checks, facts } = await auditMaster((t) => t, 'master-as-is.m3u8');
  assert.equal(m.playlists.length, 2);
  assert.equal(byId(checks, 'hls-bandwidth').level, 'pass', 'FFmpeg writes the peak segment bit rate as RFC 8216 defines it');
  assert.equal(byId(checks, 'hls-average-bandwidth').level, 'pass');
  assert.equal(byId(checks, 'hls-codecs').level, 'pass');
  assert.equal(byId(checks, 'hls-resolution').level, 'pass');
  assert.equal(byId(checks, 'hls-aligned').level, 'pass');
  assert.equal(byId(checks, 'hls-starts-idr').level, 'pass');
  assert.equal(byId(checks, 'hls-frame-rate').severity, 'CRITICAL', 'FFmpeg writes no FRAME-RATE (Apple 9.15)');
  assert.equal(byId(checks, 'hls-iframes').severity, 'CRITICAL', 'nor I-frame playlists (Apple 6.1)');
  assert.equal(facts.variants[0].declared.bandwidth, facts.variants[0].measured.peak);
});

test('an understated BANDWIDTH, a missing AVERAGE-BANDWIDTH and a wrong CODECS fail', { skip: !haveFfmpeg() }, async () => {
  // As on a service that writes BANDWIDTH from a file's average and names another profile.
  const { checks } = await auditMaster((t) => t
    .replace(/BANDWIDTH=(\d+),AVERAGE-BANDWIDTH=\d+,/g, (_, b) => `BANDWIDTH=${Math.round(Number(b) * 0.75)},`)
    .replace('avc1.64001e', 'avc1.4d401e'));
  const bw = byId(checks, 'hls-bandwidth');
  assert.equal(bw.level, 'fail');
  assert.equal(bw.severity, 'CRITICAL');
  assert.match(bw.title, /^360p declares .*, its segments peak at .* \(\+33\.3 %\)/);
  assert.match(byId(checks, 'hls-average-bandwidth').title, /^No AVERAGE-BANDWIDTH on 360p, 180p$/);
  assert.match(byId(checks, 'hls-codecs').title, /360p: segments hold avc1\.64001E, CODECS says avc1\.4d401e,mp4a\.40\.2/i);
});

test('a missing segment is found, sizes come by range when HEAD is refused, and no token is written down', { skip: !haveFfmpeg() }, async () => {
  broken.add('/v1/seg001.ts');
  refuseHead = true;
  try {
    const text = fs.readFileSync(path.join(dir, 'master.m3u8'), 'utf8').replace(/index\.m3u8/g, 'index.m3u8?token=SECRET');
    fs.writeFileSync(path.join(dir, 'signed.m3u8'), text);
    const out = await auditInputs({ inputs: [`${base}/signed.m3u8`], headers: {}, expect: {}, ladder: false, budget: null, measure: false }, () => {});
    assert.equal(out.playlists.length, 1);
    const reach = byId(out.playlists[0].checks, 'hls-reachable');
    assert.equal(reach.level, 'fail');
    assert.match(reach.title, /180p: 1 segment failed \(HTTP 404\)/);
    assert.ok(out.playlists[0].facts.variants[0].measured.sized === 3, 'HEAD refused: sizes from a one-byte range request');
    const report = toReport(out, { expect: {} });
    assert.ok(tally(report.playlists[0].checks).critical >= 1);
    assert.doesNotMatch(JSON.stringify(report), /SECRET/);
  } finally {
    broken.clear();
    refuseHead = false;
  }
});
