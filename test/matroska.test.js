// Matroska / WebM: compare Vidscope's frame tables with FFmpeg's demuxer frame by frame,
// check EBML primitives against the RFC examples, and exercise lacing, unknown sizes,
// damaged files and the lazy/large-file paths.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { haveSample, haveFfprobe, probeStreams, probePackets, checkInvariants, sample } from './helpers.mjs';
import MKV from '../web/formats/matroska/index.js';
import { CachedSource, BytesSource } from '../web/core/source.js';
import { ensureChildren, walk, segments } from '../web/core/model.js';
import { NodeFileSource } from '../scripts/node-source.mjs';
import { readVint, readHeader, crc32, idProblem, signedVint } from '../web/formats/matroska/ebml.js';
import { blockLayout } from '../web/formats/matroska/blocks.js';
import { LIMITS } from '../web/formats/matroska/parse.js';
import { BY_NAME } from '../web/formats/matroska/elements.js';

// Open through the Matroska module directly, so these tests do not depend on other formats.
async function openFile(file) {
  const src = await NodeFileSource.open(file);
  const doc = await MKV.open(new CachedSource(src));
  doc._close = () => src.close();
  return doc;
}

async function openBytes(bytes, name = 'test.mkv') {
  return MKV.open(new CachedSource(new BytesSource(bytes, name)));
}

async function expandAll(node) {
  if (node.lazy) await ensureChildren(node);
  for (const c of node.children ?? []) await expandAll(c);
}

function parseFailures(doc) {
  const out = [];
  for (const n of walk(doc.root)) for (const w of n.warnings) out.push(`${n.type}@${n.offset}: ${w}`);
  return out;
}

function ffprobePackets(file) {
  const out = execFileSync('ffprobe', ['-v', 'quiet', '-show_entries', 'packet=stream_index,pts,dts,duration,size,pos,flags', '-of', 'json', file], { maxBuffer: 256 << 20 });
  return JSON.parse(out.toString()).packets.map((p) => ({
    stream: p.stream_index,
    pts: p.pts === undefined ? null : Number(p.pts),
    duration: p.duration === undefined ? null : Number(p.duration),
    size: Number(p.size),
    pos: p.pos === undefined ? null : Number(p.pos),
    key: String(p.flags || '').includes('K'),
  }));
}

/**
 * Frame-by-frame comparison with FFmpeg. FFmpeg reports pkt.pos as the start of the
 * block's data (the track number), subtracts CodecDelay (rounded to ticks) from the
 * timestamps and derives durations from the codec when the file has none.
 */
function compareWithFfmpeg(doc, packets) {
  for (const t of doc.tracks) {
    const s = t.samples;
    const theirs = packets.filter((p) => p.stream === t.index);
    assert.ok(s, `${t.label}: no frame table`);
    assert.equal(s.count, theirs.length, `${t.label}: frame count`);
    const delay = Math.round(t.codecDelay / t.seg.timestampScale);
    for (let i = 0; i < s.count; i++) {
      const p = theirs[i];
      assert.equal(s.sizes[i], p.size, `${t.label} frame ${i}: size`);
      assert.equal(s.blockData[i], p.pos, `${t.label} frame ${i}: block position`);
      assert.ok(s.offsets[i] > s.blockData[i] && s.offsets[i] + s.sizes[i] <= doc.size, `${t.label} frame ${i}: frame inside its block`);
      if (p.pts !== null) assert.equal(s.dts[i] + (s.cto ? s.cto[i] : 0) - delay, p.pts, `${t.label} frame ${i}: timestamp`);
      if (t.kind === 'video') assert.equal(!!s.key[i], p.key, `${t.label} frame ${i}: key frame`);
      // The last frame's duration is not always in the file (FFmpeg then asks the codec).
      if (p.duration && i < s.count - 1) assert.ok(Math.abs(s.durations[i] - p.duration) <= 1, `${t.label} frame ${i}: duration ${s.durations[i]} vs ${p.duration}`);
    }
    // Decode times never go backwards and are never after the presentation time.
    for (let i = 1; i < s.count; i++) assert.ok(s.dts[i] >= s.dts[i - 1], `${t.label}: dts ${i} goes backwards`);
    if (s.cto) for (let i = 0; i < s.count; i++) assert.ok(s.cto[i] >= 0, `${t.label}: negative cto`);
  }
}

// ------------------------------------------------------------------ real files

const FILES = [
  'h264-aac.mkv', 'vp9-opus.webm', 'matroska-live.webm', 'matroska-hevc-hdr.mkv', 'matroska-av1-opus.mkv',
  'matroska-vp8-vorbis.webm', 'matroska-mpeg4-mp3-ac3.mkv', 'matroska-flac-ass.mkv',
];

for (const name of FILES) {
  test(`matroska: ${name}`, { skip: !haveSample(name) && 'run npm run samples' }, async () => {
    const doc = await openFile(sample(name));
    try {
      assert.equal(doc.format.id, 'matroska');
      assert.deepEqual(checkInvariants(doc), []);
      assert.deepEqual(parseFailures(doc), []);
      // Cluster contents are lazy until opened.
      const clusters = doc.root.findAll('Cluster');
      assert.ok(clusters.length > 0);
      assert.ok(clusters.every((c) => c.lazy && !c.children), 'clusters are not parsed at open');
      await doc.loadSamples();
      await expandAll(doc.root);
      assert.deepEqual(checkInvariants(doc), [], 'invariants after expanding every cluster');
      assert.deepEqual(parseFailures(doc), []);
      // Every frame lies inside a SimpleBlock/Block and the hex view segments tile the file.
      const segs = segments(doc.root, 0, doc.size);
      assert.equal(segs[0].start, 0);
      assert.equal(segs[segs.length - 1].end, doc.size);
      for (let i = 1; i < segs.length; i++) assert.equal(segs[i].start, segs[i - 1].end);
      if (!haveFfprobe()) return;
      const probe = probeStreams(name);
      // FFmpeg also exposes image attachments as "attached picture" streams.
      const streams = probe.streams.filter((st) => !st.disposition?.attached_pic && st.codec_type !== 'attachment');
      assert.equal(doc.tracks.length, streams.length, 'track count');
      compareWithFfmpeg(doc, probePackets(name));
      for (const t of doc.tracks) {
        const st = streams[t.index];
        if (st.codec_type === 'video') {
          assert.equal(t.video.pixelWidth, st.width);
          assert.equal(t.video.pixelHeight, st.height);
        }
        if (st.codec_type === 'audio' && t.cp?.asc) assert.equal(t.cp.asc.sampleRate, Number(st.sample_rate));
      }
      if (probe.format.duration && doc.summary.duration) assert.ok(Math.abs(doc.summary.duration - Number(probe.format.duration)) < 0.05, 'duration');
    } finally {
      await doc._close();
    }
  });
}

test('matroska: structure and codec details of h264-aac.mkv', { skip: !haveSample('h264-aac.mkv') }, async () => {
  const doc = await openFile(sample('h264-aac.mkv'));
  try {
    const ebml = doc.root.child('EBML');
    assert.equal(ebml.child('DocType').data.value, 'matroska');
    const seg = doc.root.child('Segment');
    // Header fields: ID with its marker kept, size with the marker removed.
    const [id, size] = seg.fields;
    assert.equal(id.role, 'header');
    assert.equal(id.value, 0x18538067);
    assert.equal(id.size, 4);
    assert.equal(size.role, 'header');
    assert.equal(size.size, 8, 'FFmpeg writes an 8-byte Segment size');
    assert.equal(seg.offset + seg.headerSize + size.value, doc.size);
    const info = seg.child('Info');
    assert.equal(info.child('TimestampScale').data.value, 1000000);
    assert.match(info.child('TimestampScale').fields[2].display, /1 ms ticks/);
    assert.match(info.child('Duration').fields[2].display, /0:04\.021/);
    assert.equal(info.child('Title').data.value, 'Vidscope Matroska sample');
    // SeekHead entries point at the right elements.
    for (const s of seg.child('SeekHead').childrenOf('Seek')) {
      const target = s.child('SeekPosition').fields.find((f) => f.ref === 'offset').value;
      const node = doc.nodeAt(target);
      assert.equal(node.offset, target);
      assert.equal(node.data.id, s.child('SeekID').data.value);
    }
    // Every CRC-32 in the file matches.
    await expandAll(doc.root);
    const crcs = doc.root.findAll('CRC-32');
    assert.ok(crcs.length >= 6);
    assert.ok(crcs.every((c) => c.data.crcOk === true), 'all CRC-32 elements verify');
    // Tracks
    assert.equal(doc.tracks.length, 3);
    const [v, a, s] = doc.tracks;
    assert.equal(v.kind, 'video');
    assert.equal(v.codec, 'V_MPEG4/ISO/AVC');
    assert.equal(v.codecString, 'avc1.64001E');
    assert.equal(v.sps.width, 640);
    assert.equal(v.sampleCfg.family, 'avc');
    assert.equal(v.sampleCfg.lengthSize, 4);
    assert.equal(a.codecString, 'mp4a.40.2');
    assert.equal(a.cp.asc.sampleRate, 48000);
    assert.equal(s.kind, 'subtitle');
    assert.equal(s.codec, 'S_TEXT/UTF8');
    // Chapters and tags
    const chapters = doc.root.findAll('ChapterAtom');
    assert.deepEqual(chapters.map((c) => c.find('ChapString').data.value), ['Opening', 'Ending']);
    assert.equal(chapters[1].child('ChapterTimeStart').data.value, 2e9);
    const title = doc.root.findAll('SimpleTag').map((t) => t.child('TagName').data.value);
    assert.ok(title.includes('ENCODER'));
    // Cues point to key frames.
    await doc.loadSamples();
    const ins = await doc.insights();
    assert.ok(ins.length > 10);
    assert.ok(ins.some((i) => /Cues/.test(i.title) && i.level === 'good'), 'cues insight');
    assert.ok(!ins.some((i) => i.level === 'bad'), `no bad insights: ${ins.filter((i) => i.level === 'bad').map((i) => i.title)}`);
    const g = doc.glossary();
    for (const term of ['EBML', 'VINT', 'Cluster', 'SimpleBlock', 'lacing', 'Cues', 'SeekHead', 'TimestampScale', 'CodecPrivate', 'Void', 'unknown size']) {
      assert.ok(g.some((x) => x.term.toLowerCase() === term.toLowerCase()), `glossary: ${term}`);
    }
  } finally {
    await doc._close();
  }
});

test('matroska: frames and their codec units', { skip: !haveSample('h264-aac.mkv') }, async () => {
  const doc = await openFile(sample('h264-aac.mkv'));
  try {
    // Before the scan, detailAt reads the block lazily.
    const v = doc.tracks[0];
    const early = await doc.detailAt(1044 + 10);
    assert.equal(early.kind, 'sample');
    assert.equal(early.track, v);
    await doc.loadSamples();
    const d = await doc.detailAt(v.samples.offsets[0] + 10);
    assert.equal(d.sample, 0);
    const kinds = d.units.map((u) => u.kind);
    assert.ok(kinds.includes(6), 'SEI in the first frame');
    assert.ok(kinds.includes(5), 'IDR slice in the first frame');
    assert.match(d.units.find((u) => u.kind === 6).summary, /x264/);
    assert.equal(d.units.reduce((n, u) => n + u.size, 0), v.samples.sizes[0], 'NAL units tile the frame');
    assert.ok(d.hit && d.hit.fields.length > 0);
    // Subtitles show their text.
    const s = doc.tracks[2];
    const sd = await doc.detailAt(s.samples.offsets[0]);
    assert.equal(sd.units[0].fields[0].value, 'Hello from Vidscope');
    // The overlay tints frames per track inside the blocks.
    const runs = doc.overlay(0, doc.size);
    const total = doc.tracks.reduce((n, t) => n + t.samples.count, 0);
    assert.equal(runs.length, total);
    assert.ok(runs.every((r) => r.end > r.start && doc.tracks[r.track]));
    await doc.ensureUnits(v.samples.offsets[0], v.samples.offsets[0] + 100);
    assert.ok(doc.overlay(v.samples.offsets[0], v.samples.offsets[0] + 10)[0].units.length > 0);
    // Block header fields: track number VINT, relative timestamp, flags.
    const cluster = doc.root.find('Cluster');
    await ensureChildren(cluster);
    const sb = cluster.child('SimpleBlock');
    const names = sb.fields.map((f) => f.name);
    for (const n of ['ID', 'size', 'track number', 'timestamp', 'keyframe', 'invisible', 'lacing', 'discardable']) assert.ok(names.includes(n), n);
    assert.equal(sb.fields.find((f) => f.name === 'keyframe').value, 1);
  } finally {
    await doc._close();
  }
});

test('matroska: other codecs (HEVC, AV1, VP8, Vorbis, MP3, AC-3, FLAC, ASS, attachments)', { skip: !haveSample('matroska-flac-ass.mkv') && 'extra samples missing' }, async () => {
  const check = async (name, fn) => {
    if (!haveSample(name)) return;
    const doc = await openFile(sample(name));
    try {
      await doc.loadSamples();
      await fn(doc);
    } finally {
      await doc._close();
    }
  };
  await check('matroska-hevc-hdr.mkv', async (doc) => {
    const v = doc.tracks[0];
    assert.equal(v.sampleCfg.family, 'hevc');
    assert.match(v.codecString, /^hvc1\.2\./);
    assert.equal(v.sps.bit_depth_luma, 10);
    const d = await doc.detailAt(v.samples.offsets[0]);
    assert.ok(d.units.some((u) => /IDR|CRA|BLA/.test(u.title)), 'IRAP NAL unit in the first frame');
    assert.equal(d.units.reduce((n, u) => n + u.size, 0), v.samples.sizes[0]);
    assert.ok(v.props.some(([k, x]) => k === 'colour' && /PQ/.test(x)), 'Colour element: PQ');
  });
  await check('matroska-av1-opus.mkv', async (doc) => {
    const v = doc.tracks[0];
    assert.equal(v.sampleCfg.family, 'av1');
    assert.match(v.codecString, /^av01\.0\./);
    const d = await doc.detailAt(v.samples.offsets[0]);
    assert.ok(d.units.some((u) => /sequence header/.test(u.title)));
    assert.ok(d.units.some((u) => /frame/.test(u.title)));
  });
  await check('matroska-vp8-vorbis.webm', async (doc) => {
    const [v, a] = doc.tracks;
    assert.equal(v.codec, 'V_VP8');
    assert.equal(a.cp.xiph.sampleRate, 44100);
    assert.match(a.cp.xiph.vendor, /Xiph|libVorbis/i);
    const d = await doc.detailAt(v.samples.offsets[0]);
    assert.match(d.units[0].summary, /key frame 320×240/);
  });
  await check('matroska-mpeg4-mp3-ac3.mkv', async (doc) => {
    const [v, mp3, ac3] = doc.tracks;
    assert.equal(v.codec, 'V_MPEG4/ISO/ASP');
    assert.match((await doc.detailAt(mp3.samples.offsets[0])).units[0].summary, /MP3 128 kb\/s 48,000 Hz/);
    assert.match((await doc.detailAt(ac3.samples.offsets[0])).units[0].summary, /AC-3/);
    // The last MP3 frame is trimmed with DiscardPadding in a BlockGroup.
    assert.ok(doc.root.find('Cues'));
    await expandAll(doc.root);
    assert.ok(doc.root.find('DiscardPadding'));
  });
  await check('matroska-flac-ass.mkv', async (doc) => {
    assert.equal(doc.summary.label, 'Matroska audio');
    const [a, s] = doc.tracks;
    assert.equal(a.cp.flac.sampleRate, 48000);
    assert.equal(s.codec, 'S_TEXT/ASS');
    assert.match(s.cp.text, /\[Script Info\]/);
    const d = await doc.detailAt(s.samples.offsets[0]);
    const text = d.units[0].fields.find((f) => f.name === 'Text');
    assert.match(text.value, /Bold/);
    const att = doc.root.find('AttachedFile');
    assert.equal(att.find('FileName').data.value, 'cover.png');
    assert.match(att.find('FileData').fields[2].display, /PNG image/);
    const ins = await doc.insights();
    assert.ok(ins.some((i) => /attachment/.test(i.title)));
  });
});

test('matroska: large-file code paths give the same frames', { skip: !haveSample('h264-aac.mkv') }, async () => {
  const ref = await openFile(sample('h264-aac.mkv'));
  await ref.loadSamples();
  const saved = { ...LIMITS };
  // Force: lazy Cues, masters walked with small reads, Clusters parsed and scanned by streaming.
  Object.assign(LIMITS, { cuesLazy: 16, inMemory: 256, clusterRead: 4096, leafMax: 64 });
  try {
    const doc = await openFile(sample('h264-aac.mkv'));
    try {
      const cues = doc.root.find('Cues');
      assert.ok(cues.lazy, 'Cues opened on demand');
      await doc.loadSamples();
      for (const t of doc.tracks) {
        const r = ref.tracks[t.index].samples;
        assert.deepEqual(Array.from(t.samples.offsets), Array.from(r.offsets));
        assert.deepEqual(Array.from(t.samples.sizes), Array.from(r.sizes));
        assert.deepEqual(Array.from(t.samples.pts), Array.from(r.pts));
      }
      await expandAll(doc.root);
      assert.deepEqual(checkInvariants(doc), []);
      assert.deepEqual(parseFailures(doc), []);
      assert.equal(doc.root.findAll('SimpleBlock').length, ref.scan.blocks - ref.scan.groups);
      const ins = await doc.insights();
      assert.ok(ins.some((i) => /cue points point at the right frames/.test(i.title)));
    } finally {
      await doc._close();
    }
  } finally {
    Object.assign(LIMITS, saved);
    await ref._close();
  }
});

test('matroska: two Segments in one file (EBML stream)', { skip: !haveSample('vp9-opus.webm') }, async () => {
  const one = new Uint8Array(fs.readFileSync(sample('vp9-opus.webm')));
  const two = new Uint8Array(one.length * 2);
  two.set(one);
  two.set(one, one.length);
  const doc = await openBytes(two, 'chained.webm');
  assert.deepEqual(checkInvariants(doc), []);
  assert.equal(doc.root.childrenOf('Segment').length, 2);
  assert.equal(doc.root.childrenOf('EBML').length, 2);
  assert.equal(doc.tracks.length, 4);
  await doc.loadSamples();
  assert.equal(doc.tracks[2].samples.count, doc.tracks[0].samples.count);
  assert.equal(doc.tracks[2].samples.offsets[0], doc.tracks[0].samples.offsets[0] + one.length);
  const ins = await doc.insights();
  assert.ok(ins.some((i) => /2 Segments/.test(i.title)));
});

test('matroska: vp9-opus.webm codec details', { skip: !haveSample('vp9-opus.webm') }, async () => {
  const doc = await openFile(sample('vp9-opus.webm'));
  try {
    assert.equal(doc.summary.label, 'WebM');
    const [v, a] = doc.tracks;
    assert.equal(v.codec, 'V_VP9');
    assert.equal(a.codec, 'A_OPUS');
    assert.equal(a.cp.opus.preSkip, 312);
    assert.equal(a.codecDelay, 6500000);
    assert.equal(a.seekPreRoll, 80000000);
    await doc.loadSamples();
    const d = await doc.detailAt(v.samples.offsets[0]);
    assert.match(d.units[0].summary, /key frame 640×360/);
    const o = await doc.detailAt(a.samples.offsets[0]);
    assert.equal(o.units[0].title, 'Opus packet');
    const ins = await doc.insights();
    assert.ok(ins.some((i) => i.group === 'Encoding' && /WebM/.test(i.title) && i.level === 'good'), 'WebM codecs OK');
  } finally {
    await doc._close();
  }
});

// ------------------------------------------------------------------ EBML primitives

test('matroska: VINTs, IDs and sizes (RFC 8794 examples)', () => {
  // The integer 2 written with 1 to 4 bytes (RFC 8794 Table 2).
  for (const bytes of [[0x82], [0x40, 0x02], [0x20, 0x00, 0x02], [0x10, 0x00, 0x00, 0x02]]) {
    const v = readVint(Uint8Array.from(bytes), 0, bytes.length);
    assert.equal(v.value, 2);
    assert.equal(v.len, bytes.length);
    assert.equal(v.unknown, false);
  }
  // All value bits set: unknown size, at every length.
  assert.equal(readVint(Uint8Array.from([0xff]), 0, 1).unknown, true);
  assert.equal(readVint(Uint8Array.from([0x7f, 0xff]), 0, 2).unknown, true);
  assert.equal(readVint(Uint8Array.from([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]), 0, 8).unknown, true);
  // 127 needs 2 bytes because 0xFF is reserved (RFC 8794 Table 7).
  assert.equal(readVint(Uint8Array.from([0x40, 0x7f]), 0, 2).value, 127);
  assert.equal(readVint(Uint8Array.from([0x00]), 0, 1), null);
  // IDs keep their marker; a header with an 8-byte size.
  const h = readHeader(Uint8Array.from([0x18, 0x53, 0x80, 0x67, 0x01, 0, 0, 0, 0, 0x06, 0x1d, 0xf7]), 0, 12);
  assert.equal(h.id, 0x18538067);
  assert.equal(h.headerSize, 12);
  assert.equal(h.size, 0x061df7);
  // ID validity (RFC 8794 § 5, with 0x80 allowed by RFC 9559 § 4.2).
  assert.equal(idProblem(0xbf, 1), null);
  assert.equal(idProblem(0x80, 1), null);
  assert.match(idProblem(0x403f, 2), /shortest/);
  assert.equal(idProblem(0x407f, 2), null);
  assert.match(idProblem(0x4000, 2), /zero/);
  assert.ok(readHeader(Uint8Array.from([0xff, 0x81]), 0, 2).error);
  assert.ok(readHeader(Uint8Array.from([0x08, 0, 0, 0, 0x81]), 0, 5).error, 'a 5-byte ID is not allowed');
  // EBML lacing signed VINTs: 0x5ED3 is -300.
  const d = readVint(Uint8Array.from([0x5e, 0xd3]), 0, 2);
  assert.equal(signedVint(d.value, d.len), -300);
  // CRC-32 is the zlib one.
  assert.equal(crc32(new TextEncoder().encode('123456789'), 0, 9), 0xcbf43926);
});

test('matroska: lacing layouts (RFC 9559 § 10.3 examples)', () => {
  const header = [0x81, 0x00, 0x00];
  const block = (flags, lace, total) => {
    const u8 = new Uint8Array(total);
    u8.set([...header, flags, ...lace]);
    return u8;
  };
  // Xiph: 800, 500, 1000 → 2311 bytes.
  let L = blockLayout(block(0x02, [0x02, 0xff, 0xff, 0xff, 0x23, 0xff, 0xf5], 2311), 0, 2311);
  assert.equal(L.lacing, 1);
  assert.deepEqual([L.frames[1], L.frames[3], L.frames[5]], [800, 500, 1000]);
  assert.equal(L.frames[0], 11);
  // EBML: 2309 bytes (the RFC's octet table overlaps by one: sizes end at octet 8, frames start at 9).
  L = blockLayout(block(0x06, [0x02, 0x43, 0x20, 0x5e, 0xd3], 2309), 0, 2309);
  assert.equal(L.lacing, 3);
  assert.deepEqual([L.frames[1], L.frames[3], L.frames[5]], [800, 500, 1000]);
  assert.equal(L.frames[0], 9);
  // Fixed-size: three 800-byte frames, 2405 bytes.
  L = blockLayout(block(0x04, [0x02], 2405), 0, 2405);
  assert.equal(L.lacing, 2);
  assert.deepEqual([L.frames[0], L.frames[1], L.frames[3], L.frames[5]], [5, 800, 800, 800]);
  // Keyframe / invisible / discardable flags.
  L = blockLayout(block(0x89, [], 10), 0, 10);
  assert.equal(L.key, true);
  assert.equal(L.invisible, true);
  assert.equal(L.discardable, true);
  // Damaged lace sizes are reported, not thrown.
  L = blockLayout(block(0x02, [0x05, 0xff, 0xff], 8), 0, 8);
  assert.ok(L.error);
});

// ------------------------------------------------------------------ synthetic files

// A tiny EBML writer for building test files.
function vintSize(n) {
  let len = 1;
  while (len < 8 && n > 2 ** (7 * len) - 2) len++;
  const out = new Array(len);
  let v = n;
  for (let i = len - 1; i >= 0; i--) {
    out[i] = v % 256;
    v = Math.floor(v / 256);
  }
  out[0] |= 0x80 >> (len - 1);
  return out;
}

function idBytes(id) {
  const out = [];
  for (let v = id; v > 0; v = Math.floor(v / 256)) out.unshift(v % 256);
  return out;
}

const cat = (...parts) => parts.flat();
const E = (id, ...payload) => {
  const data = cat(...payload);
  return [...idBytes(id), ...vintSize(data.length), ...data];
};
const U = (id, v) => {
  const b = [];
  for (let x = v; x > 0; x = Math.floor(x / 256)) b.unshift(x % 256);
  return E(id, b.length ? b : [0]);
};
const S = (id, s) => E(id, [...new TextEncoder().encode(s)]);
const F = (id, v) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setFloat64(0, v);
  return E(id, [...b]);
};
const fill = (n, seed) => Array.from({ length: n }, (_, i) => (i * 7 + seed) & 0xff);

function pcmTrack(num, extra = []) {
  return E(0xae, U(0xd7, num), U(0x73c5, 1000 + num), U(0x83, 2), S(0x86, 'A_PCM/INT/LIT'), U(0x23e383, 10000000), ...extra,
    E(0xe1, F(0xb5, 48000), U(0x9f, 2), U(0x6264, 16)));
}

function simpleBlock(track, rel, flags, lace, frames) {
  return E(0xa3, [0x80 | track, (rel >> 8) & 0xff, rel & 0xff, flags, ...lace], ...frames);
}

/** A Matroska file with Xiph, EBML and fixed lacing, a BlockGroup and an unknown-size Cluster. */
function lacedFile({ unknownCluster = false } = {}) {
  const x = [fill(800, 1), fill(496, 2), fill(1000, 3)];
  const e = [fill(804, 4), fill(500, 5), fill(1000, 6)];
  const f = [fill(400, 7), fill(400, 8), fill(400, 9), fill(400, 10)];
  const cluster1 = cat(
    U(0xe7, 0),
    simpleBlock(1, 0, 0x82, [0x02, 0xff, 0xff, 0xff, 0x23, 0xff, 0xf1], x), // Xiph: 800, 496, 1000
    simpleBlock(2, 0, 0x86, [0x02, 0x43, 0x24, 0x5e, 0xcf], e), // EBML: 804, 500 (delta -304), 1000
    simpleBlock(3, 0, 0x84, [0x03], f), // fixed: 4 × 400
    E(0xa0, U(0x9b, 20), E(0xa1, [0x82, 0x00, 30, 0x02, 0x01, 200], fill(200, 11), fill(240, 12))), // BlockGroup, Xiph, 2 frames
  );
  const cluster2 = cat(U(0xe7, 100), simpleBlock(1, 0, 0x80, [], [fill(1920, 13)]), simpleBlock(2, 5, 0x80, [], [fill(1920, 14)]));
  const c1 = unknownCluster ? [0x1f, 0x43, 0xb6, 0x75, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, ...cluster1] : E(0x1f43b675, cluster1);
  const segment = cat(
    E(0x1549a966, U(0x2ad7b1, 1000000), S(0x4d80, 'Vidscope test'), S(0x5741, 'Vidscope test'), F(0x4489, 120)),
    E(0x1654ae6b, pcmTrack(1), pcmTrack(2), pcmTrack(3)),
    E(0xec, fill(9, 0).map(() => 0)),
    c1,
    E(0x1f43b675, cluster2),
  );
  const ebml = E(0x1a45dfa3, U(0x4286, 1), U(0x42f7, 1), U(0x42f2, 4), U(0x42f3, 8), S(0x4282, 'matroska'), U(0x4287, 4), U(0x4285, 2));
  return Uint8Array.from(cat(ebml, E(0x18538067, segment)));
}

/** ffprobe packets of in-memory bytes (written to a temporary file that is removed afterwards). */
function ffprobeBytes(bytes, name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bv-mkv-'));
  try {
    const file = path.join(dir, name);
    fs.writeFileSync(file, bytes);
    return ffprobePackets(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

for (const unknownCluster of [false, true]) {
  test(`matroska: lacing and BlockGroups agree with FFmpeg${unknownCluster ? ' (unknown-size Cluster)' : ''}`, async () => {
    const bytes = lacedFile({ unknownCluster });
    const doc = await openBytes(bytes);
    assert.deepEqual(checkInvariants(doc), []);
    const clusters = doc.root.findAll('Cluster');
    assert.equal(clusters.length, 2, 'the unknown-size Cluster ends where the next Cluster starts');
    if (unknownCluster) {
      assert.ok(clusters[0].data.unknownSize);
      assert.equal(clusters[0].end, clusters[1].offset);
    }
    await doc.loadSamples();
    const [t1, t2, t3] = doc.tracks;
    assert.deepEqual(Array.from(t1.samples.sizes), [800, 496, 1000, 1920]);
    assert.deepEqual(Array.from(t2.samples.sizes), [804, 500, 1000, 200, 240, 1920]);
    assert.deepEqual(Array.from(t3.samples.sizes), [400, 400, 400, 400]);
    // Laced frames are 10 ms apart (DefaultDuration); the BlockGroup's 20 ms are split in two.
    assert.deepEqual(Array.from(t1.samples.pts), [0, 10, 20, 100]);
    assert.deepEqual(Array.from(t2.samples.pts), [0, 10, 20, 30, 40, 105]);
    assert.equal(t2.lacing.xiph, 1);
    assert.equal(t2.lacing.ebml, 1);
    assert.equal(t3.lacing.fixed, 1);
    await expandAll(doc.root);
    assert.deepEqual(checkInvariants(doc), []);
    const sb = doc.root.find('SimpleBlock');
    const laceSizes = sb.fields.filter((f) => /^frame \d+ size$/.test(f.name));
    assert.deepEqual(laceSizes.map((f) => f.value), [800, 496, 1000]);
    assert.deepEqual(laceSizes.map((f) => f.type), ['Xiph lacing', 'Xiph lacing', 'computed'], 'the last size is implied');
    if (haveFfprobe()) {
      compareWithFfmpeg(doc, ffprobeBytes(bytes, unknownCluster ? 'unknown.mkv' : 'laced.mkv'));
    }
    const ins = await doc.insights();
    assert.ok(ins.some((i) => /lacing/i.test(i.title)), 'lacing insight');
    if (unknownCluster) assert.ok(ins.some((i) => /unknown size/i.test(i.title)), 'unknown size insight');
  });
}

test('matroska: live-style file with unknown-size Segment and Clusters', { skip: !haveSample('matroska-live.webm') }, async () => {
  // Patch every Cluster size of FFmpeg's live output to "unknown" (3-byte VINT 3F FF FF), as browser
  // MediaRecorder files have them.
  const bytes = new Uint8Array(fs.readFileSync(sample('matroska-live.webm')));
  const ref = await openBytes(bytes);
  const clusters = ref.root.findAll('Cluster');
  for (const c of clusters) {
    assert.equal(c.fields[1].size, 3);
    bytes.set([0x3f, 0xff, 0xff], c.offset + 4);
  }
  for (const small of [false, true]) {
    const saved = LIMITS.unknownScan;
    if (small) LIMITS.unknownScan = 64 * 1024; // force the lazy "unscanned group" path
    try {
      const doc = await openBytes(bytes, 'live.webm');
      assert.deepEqual(checkInvariants(doc), []);
      const seg = doc.root.child('Segment');
      assert.ok(seg.data.unknownSize);
      if (small) {
        const group = seg.children.find((c) => c.kind === 'group');
        assert.ok(group && group.lazy, 'rest of the segment left as a lazy group');
      }
      await doc.loadSamples();
      await expandAll(doc.root);
      assert.deepEqual(checkInvariants(doc), []);
      const found = doc.root.findAll('Cluster');
      assert.equal(found.length, clusters.length);
      found.forEach((c, i) => {
        assert.equal(c.offset, clusters[i].offset);
        assert.equal(c.size, clusters[i].size);
      });
      if (haveFfprobe()) compareWithFfmpeg(doc, ffprobeBytes(bytes, 'live.webm'));
      const ins = await doc.insights();
      assert.ok(ins.some((i) => /unknown size/i.test(i.title)));
      assert.ok(ins.some((i) => /No Cues/i.test(i.title)));
    } finally {
      LIMITS.unknownScan = saved;
    }
  }
});

test('matroska: damaged and truncated files never throw', { skip: !haveSample('h264-aac.mkv') }, async () => {
  const good = new Uint8Array(fs.readFileSync(sample('h264-aac.mkv')));
  const clusters = (await openBytes(good)).root.findAll('Cluster');
  assert.ok(clusters.length >= 2, 'the sample has at least two Clusters');
  const [c1, c2] = [clusters[0].offset, clusters[1].offset];
  // Truncated in the middle of the second Cluster.
  const cut = good.subarray(0, Math.floor((c2 + clusters[1].end) / 2));
  let doc = await openBytes(cut);
  assert.deepEqual(checkInvariants(doc), []);
  assert.ok(doc.root.child('Segment').warnings.some((w) => /truncated/.test(w)));
  await doc.loadSamples();
  await expandAll(doc.root);
  assert.deepEqual(checkInvariants(doc), []);
  assert.ok(doc.tracks[0].samples.count > 0);
  // Garbage in the middle: Vidscope resynchronises on the next Cluster.
  const bad = good.slice();
  bad.fill(0x00, c2 - 100, c2 - 90);
  bad.fill(0xab, c1, c1 + 9); // destroy the first Cluster header
  doc = await openBytes(bad);
  assert.deepEqual(checkInvariants(doc), []);
  assert.ok(doc.root.find('garbage'), 'damaged bytes become an "unparsed" region');
  assert.ok(doc.root.findAll('Cluster').some((c) => c.offset === c2), 'resynchronised on the next Cluster');
  await doc.loadSamples();
  await expandAll(doc.root);
  assert.deepEqual(checkInvariants(doc), []);
  const ins = await doc.insights();
  assert.ok(ins.some((i) => i.level === 'bad'));
  // A flipped byte inside a Cluster breaks its CRC-32.
  const flip = good.slice();
  flip[Math.floor((c1 + c2) / 2)] ^= 0xff;
  doc = await openBytes(flip);
  await doc.loadSamples();
  assert.ok((await doc.insights()).some((i) => /CRC-32/.test(i.title) && i.level === 'bad'));
  // Random bytes after a valid EBML header.
  const junk = Uint8Array.from([...good.subarray(0, 52), ...fill(5000, 3)]);
  doc = await openBytes(junk);
  assert.deepEqual(checkInvariants(doc), []);
  await doc.loadSamples();
  await doc.insights();
});

test('matroska: random corruption never throws (deterministic fuzz)', { skip: !haveSample('h264-aac.mkv') }, async () => {
  let seed = 20260922;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (const name of ['h264-aac.mkv', 'vp9-opus.webm']) {
    if (!haveSample(name)) continue;
    const orig = new Uint8Array(fs.readFileSync(sample(name)));
    for (let k = 0; k < 24; k++) {
      let b = orig.slice();
      if (k % 3 === 0) for (let i = 0; i < 1 + k; i++) b[Math.floor(rnd() * b.length)] = Math.floor(rnd() * 256);
      else if (k % 3 === 1) b = b.subarray(0, Math.floor(rnd() * b.length));
      else b[Math.floor(rnd() * Math.min(b.length, 1200))] = Math.floor(rnd() * 256); // damage the metadata
      const doc = await openBytes(b, name);
      await doc.loadSamples();
      await expandAll(doc.root);
      assert.deepEqual(checkInvariants(doc), [], `${name} mutation ${k}`);
      await doc.insights();
      for (let i = 0; i < 8; i++) await doc.detailAt(Math.floor(rnd() * b.length));
      for (const t of doc.tracks) {
        const s = t.samples;
        for (let i = 0; i < s.count; i++) assert.ok(s.offsets[i] + s.sizes[i] <= b.length, `${name} mutation ${k}: frame inside the file`);
      }
    }
  }
});

test('matroska: a bare media segment (Clusters without a header)', { skip: !haveSample('matroska-live.webm') }, async () => {
  const full = await openFile(sample('matroska-live.webm'));
  try {
    await full.loadSamples();
    const second = full.root.findAll('Cluster')[1];
    const bytes = new Uint8Array(fs.readFileSync(sample('matroska-live.webm'))).subarray(second.offset);
    assert.ok(MKV.probe(bytes.subarray(0, 64)) > 0);
    const doc = await openBytes(bytes, 'fragment.webm');
    assert.deepEqual(checkInvariants(doc), []);
    assert.match(doc.summary.label, /fragment/);
    await doc.loadSamples();
    // Placeholder tracks carry the same frames as the complete file, shifted by the cut.
    for (const t of doc.tracks) {
      assert.ok(t.placeholder);
      const ref = full.tracks.find((x) => x.id === t.id).samples;
      const from = Array.from(ref.offsets).findIndex((o) => o >= second.offset);
      assert.equal(t.samples.count, ref.count - from);
      assert.equal(t.samples.offsets[0], ref.offsets[from] - second.offset);
      assert.equal(t.samples.pts[0], ref.pts[from]);
    }
    const ins = await doc.insights();
    assert.ok(ins.some((i) => /No EBML header/.test(i.title)));
    assert.ok(!ins.some((i) => i.level === 'bad'));
  } finally {
    await full._close();
  }
});

test('matroska: probe', () => {
  const head = (bytes) => Uint8Array.from(bytes);
  assert.equal(MKV.probe(head(cat(E(0x1a45dfa3, S(0x4282, 'webm'))))), 100);
  assert.equal(MKV.probe(head(cat(E(0x1a45dfa3, S(0x4282, 'matroska'))))), 100);
  assert.ok(MKV.probe(head(cat(E(0x1a45dfa3, S(0x4282, 'other'))))) < 50);
  assert.equal(MKV.probe(head([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70])), 0);
  assert.ok(MKV.probe(head(cat(E(0x1f43b675, U(0xe7, 0))))) > 0, 'a bare Cluster (media segment)');
});

test('matroska: element dictionary', () => {
  // Every RFC 9559 element has a plain-language description and a section.
  for (const el of BY_NAME.values()) {
    assert.ok(el.desc && el.desc.length > 20, `${el.name}: description`);
    if (!el.v5 && !el.notInRfc) assert.ok(el.section, `${el.name}: section`);
  }
  assert.equal(BY_NAME.get('SimpleBlock').id, 0xa3);
  assert.equal(BY_NAME.get('Info').section, '5.1.2');
  assert.equal(BY_NAME.get('TimestampScale').default, 1000000);
  assert.ok(BY_NAME.size > 270);
});
