// RIFF (AVI, WAV): compare Vidscope's frame tables with FFmpeg's demuxer, check
// the tree invariants, and make sure damaged or unusual files never crash the parser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { open, haveSample, haveFfprobe, probeStreams, probePackets, checkInvariants, sample } from './helpers.mjs';
import { openDocument } from '../web/formats/index.js';
import { BytesSource } from '../web/core/source.js';
import { ensureChildren, walk } from '../web/core/model.js';
import riff from '../web/formats/riff/index.js';

const AVI_FILES = ['mpeg4-mp3.avi', 'h264-pcm.avi', 'riff-noindex.avi', 'riff-h264-aac.avi', 'riff-mjpeg-ac3.avi'];
const WAV_FILES = ['pcm.wav', 'riff-float51.wav', 'riff-bwf.wav', 'riff-rf64.wav', 'riff-mp3.wav', 'riff-adpcm.wav', 'riff-peak.wav'];
const LEVELS = new Set(['good', 'info', 'warn', 'bad']);
const GROUPS = new Set(['Overview', 'Layout', 'Tracks', 'Encoding', 'Timing', 'Integrity', 'Metadata']);

/** Load every lazy node (movi and its groups). */
async function expandAll(doc) {
  for (let pass = 0; pass < 4; pass++) {
    const lazy = [...walk(doc.root)].filter((n) => n.lazy);
    if (!lazy.length) break;
    for (const n of lazy) await ensureChildren(n);
  }
}

function parseFailures(doc) {
  const out = [];
  for (const n of walk(doc.root)) for (const w of n.warnings) if (/could not parse|could not interpret|internal/i.test(w)) out.push(`${n.type}@${n.offset}: ${w}`);
  return out;
}

function checkInsights(items) {
  assert.ok(items.length > 0, 'some insights');
  for (const i of items) {
    assert.ok(LEVELS.has(i.level), `level ${i.level}`);
    assert.ok(GROUPS.has(i.group), `group ${i.group}`);
    assert.ok(i.title && typeof i.title === 'string');
    assert.ok(!/undefined|NaN|\[object/.test(`${i.title} ${i.text ?? ''} ${(i.facts ?? []).flat().join(' ')}`), `no undefined/NaN in "${i.title}"`);
  }
}

/** Compare one doc's tracks with ffprobe's packets (zero-byte AVI chunks are dropped frames FFmpeg skips). */
function compareWithFfprobe(doc, streams, packets) {
  assert.equal(doc.tracks.length, streams.length, 'track count');
  for (const t of doc.tracks) {
    const st = streams[t.index];
    assert.equal(st.codec_type, t.kind, `${t.label}: kind`);
    const [num, den] = st.time_base.split('/').map(Number);
    const s = t.samples;
    assert.ok(s, `${t.label}: samples`);
    const mine = [];
    for (let i = 0; i < s.count; i++) if (s.sizes[i] > 0) mine.push(i);
    const theirs = packets.filter((p) => p.stream === t.index);
    assert.equal(mine.length, theirs.length, `${t.label}: frame count`);
    for (let k = 0; k < mine.length; k++) {
      const i = mine[k];
      const p = theirs[k];
      assert.equal(s.offsets[i], p.pos, `${t.label} frame ${k}: offset`);
      assert.equal(s.sizes[i], p.size, `${t.label} frame ${k}: size`);
      assert.ok(Math.abs(s.dts[i] / s.timescale - (p.dts * num) / den) < 1e-9, `${t.label} frame ${k}: dts ${s.dts[i] / s.timescale} vs ${(p.dts * num) / den}`);
      if (t.kind === 'video') assert.equal(!!s.key[i], p.key, `${t.label} frame ${k}: key flag`);
    }
  }
}

for (const name of AVI_FILES) {
  test(`riff: ${name} matches FFmpeg`, { skip: !haveSample(name) && 'run npm run samples' }, async () => {
    const doc = await open(name);
    try {
      assert.equal(doc.format.id, 'riff');
      assert.match(doc.summary.label, /^AVI/);
      if (doc.loadSamples) await doc.loadSamples();
      assert.ok(doc.tracks.length >= 2);
      assert.ok(doc.summary.duration > 1.5);
      await expandAll(doc);
      assert.deepEqual(checkInvariants(doc), []);
      assert.deepEqual(parseFailures(doc), []);
      // Every media chunk under movi is a frame the index knows (or found by the scan).
      const known = new Set();
      for (const t of doc.tracks) for (let i = 0; i < t.samples.count; i++) known.add(t.samples.offsets[i] - 8);
      for (const n of walk(doc.root)) if (/^\d\d(dc|db|wb)$/.test(n.type)) assert.ok(known.has(n.offset), `${n.type}@${n.offset} is in the frame table`);
      if (haveFfprobe()) compareWithFfprobe(doc, probeStreams(name).streams, probePackets(name));
      checkInsights(await doc.insights());
      assert.ok(doc.glossary().length > 20);
    } finally {
      await doc._close();
    }
  });
}

test('riff: AVI structure and codec details', { skip: !haveSample('h264-pcm.avi') }, async () => {
  const doc = await open('h264-pcm.avi');
  const riffNode = doc.root.children[0];
  assert.equal(riffNode.type, 'RIFF');
  assert.equal(riffNode.label, 'AVI');
  assert.deepEqual(riffNode.children.map((c) => c.type), ['hdrl', 'INFO', 'JUNK', 'movi', 'idx1']);
  const hdrl = riffNode.children[0];
  assert.deepEqual(hdrl.children.map((c) => c.type), ['avih', 'strl', 'strl', 'JUNK']);
  assert.equal(hdrl.children[3].data.placeholder, 'odml', 'FFmpeg reserves an odml list inside JUNK');
  assert.ok(riffNode.children[3].lazy, 'movi is lazy');
  const [v, a] = doc.tracks;
  assert.equal(v.codecString, 'avc1.64001E');
  assert.equal(v.sps.width, 640);
  assert.equal(v.samples.timescale, 25);
  assert.equal(a.samples.clock.mode, 'bytes', 'PCM time comes from the byte count');
  assert.equal(a.stream.audio.blockAlign, 2);
  // H.264 in AVI is Annex B: the first frame carries SPS, PPS, SEI and the IDR slice.
  const d = await doc.detailAt(v.samples.offsets[0] + 20);
  assert.equal(d.kind, 'sample');
  assert.deepEqual(d.units.map((u) => u.kind), [7, 8, 6, 5]);
  assert.equal(d.units.reduce((n, u) => n + u.size, 0), v.samples.sizes[0], 'NAL units tile the frame');
  assert.ok(d.hit && d.hit.fields.length > 0);
  // Later frames still decode their slice headers thanks to the SPS/PPS seen in frame 0.
  const d2 = await doc.detailAt(v.samples.offsets[5] + 8);
  assert.ok(d2.units.some((u) => /frame_num/.test(u.summary)), 'slice header parsed');
  // Overlay: frames of both tracks inside movi.
  const movi = riffNode.children[3];
  const runs = doc.overlay(movi.offset, movi.offset + 40000);
  assert.ok(runs.some((r) => r.track === 0) && runs.some((r) => r.track === 1));
  for (const r of runs) assert.ok(r.end > r.start);
  // The idx1 table resolves relative offsets.
  assert.equal(doc.ctx.idx1Info.base, movi.offset + 8);
  assert.equal(doc.ctx.idx1Info.absolute, false);
  await doc._close();
});

test('riff: MPEG-4 Part 2 and MP3 details', { skip: !haveSample('mpeg4-mp3.avi') }, async () => {
  const doc = await open('mpeg4-mp3.avi');
  const [v, a] = doc.tracks;
  assert.equal(v.mp4v.width, 640);
  assert.equal(v.mp4v.timeRes, 25);
  const d = await doc.detailAt(v.samples.offsets[0] + 100);
  assert.ok(d.units.some((u) => u.title === 'VOP · I'), 'first frame is an I-VOP');
  assert.ok(d.units.some((u) => u.title === 'VOL'));
  const empty = [...v.samples.sizes].indexOf(0);
  assert.ok(empty > 0, 'FFmpeg wrote a zero-byte drop frame');
  assert.equal(a.samples.clock.mode, 'blocks');
  assert.equal(a.samples.timescale, 125);
  const da = await doc.detailAt(a.samples.offsets[3] + 1);
  assert.match(da.units[0].summary, /MP3 128 kb\/s 48,000 Hz/);
  const items = await doc.insights();
  assert.ok(items.some((i) => /no B-frames/.test(i.title)));
  assert.ok(items.some((i) => /JUNK/.test(i.title)));
  await doc._close();
});

test('riff: AVI without an index is scanned', { skip: !haveSample('riff-noindex.avi') }, async () => {
  const doc = await open('riff-noindex.avi');
  assert.equal(typeof doc.loadSamples, 'function');
  assert.equal(doc.tracks[0].samples, undefined, 'no frames before the scan');
  await doc.loadSamples();
  assert.equal(doc.tracks[0].samples.source, 'scan');
  const items = await doc.insights();
  assert.ok(items.some((i) => i.level === 'bad' && i.title === 'No index' && i.cmd));
  assert.ok(items.some((i) => /RIFF size not filled in/.test(i.title)));
  await doc._close();
});

for (const name of WAV_FILES) {
  test(`riff: ${name}`, { skip: !haveSample(name) && 'run npm run samples' }, async () => {
    const doc = await open(name);
    try {
      assert.equal(doc.format.id, 'riff');
      assert.match(doc.summary.label, /WAV/);
      assert.deepEqual(checkInvariants(doc), []);
      assert.deepEqual(parseFailures(doc), []);
      const t = doc.tracks[0];
      const a = doc.ctx.fmt;
      if (haveFfprobe()) {
        const probe = probeStreams(name);
        const st = probe.streams[0];
        assert.equal(a.sampleRate, Number(st.sample_rate));
        assert.equal(a.channels, st.channels);
        if (st.duration) assert.ok(Math.abs(doc.summary.duration - Number(st.duration)) < 0.03, `duration ${doc.summary.duration} vs ${st.duration}`);
      }
      assert.equal(t.kind, 'audio');
      // A byte inside the data chunk is always explained.
      const w = doc.wav;
      const d = await doc.detailAt(w.dataStart + Math.floor(w.dataSize / 2));
      assert.ok(d, 'detail inside data');
      checkInsights(await doc.insights());
    } finally {
      await doc._close();
    }
  });
}

test('riff: WAV specifics', { skip: !haveSample('riff-bwf.wav') }, async () => {
  const pcm = await open('pcm.wav');
  const w = pcm.wav;
  const d = await pcm.detailAt(w.dataStart + 2 * 1000 + 1);
  assert.equal(d.range[0], w.dataStart + 2000);
  assert.match(d.title, /Sample frame 1,000/);
  assert.equal(d.units[0].fields.length, 1);
  assert.equal(d.hit.fields[0].f.name, 'mono');
  await pcm._close();

  const f51 = await open('riff-float51.wav');
  assert.equal(f51.ctx.fmt.channelMask, 0x3f);
  assert.equal(f51.ctx.fmt.subTag, 3);
  const d51 = await f51.detailAt(f51.wav.dataStart + 24 * 10 + 5);
  assert.deepEqual(d51.units[0].fields.map((f) => f.name), ['FL', 'FR', 'FC', 'LFE', 'BL', 'BR']);
  await f51._close();

  const bwf = await open('riff-bwf.wav');
  assert.equal(bwf.summary.label, 'Broadcast WAV (BWF)');
  assert.equal(bwf.ctx.bext.originator, 'Vidscope');
  assert.equal(bwf.ctx.bext.timeReference, 172800000);
  const bext = bwf.root.children[0].children.find((c) => c.type === 'bext');
  assert.equal(bext.size % 2, 0, 'odd bext is padded');
  assert.equal(bext.fields.at(-1).name, 'pad');
  await bwf._close();

  const rf = await open('riff-rf64.wav');
  assert.equal(rf.summary.label, 'WAV (RF64)');
  assert.equal(rf.ctx.ds64.dataSize, 96000);
  assert.equal(rf.wav.dataSize, 96000);
  await rf._close();

  const adpcm = await open('riff-adpcm.wav');
  const da = await adpcm.detailAt(adpcm.wav.dataStart + 1024 + 10);
  assert.match(da.title, /ADPCM block 1/);
  const items = await adpcm.insights();
  assert.ok(items.some((i) => /nAvgBytesPerSec does not match/.test(i.title)), 'FFmpeg writes a wrong byte rate for IMA ADPCM');
  await adpcm._close();
});

// ------------------------------------------------------------ synthetic files

const enc = new TextEncoder();
function u16(v) { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, v, true); return b; }
function u32(v) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v >>> 0, true); return b; }
function u64(v) { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(v), true); return b; }
function cat(...parts) {
  const n = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
function ck(id, data, { pad = true } = {}) {
  return cat(enc.encode(id), u32(data.length), data, pad && data.length % 2 ? new Uint8Array(1) : new Uint8Array(0));
}
function lst(id, type, ...kids) {
  return ck(id, cat(enc.encode(type), ...kids));
}

/** A small OpenDML AVI: two RIFF chunks, a super index pointing at two ix00 chunks, idx1 for the first RIFF. */
function buildOdml() {
  const frames = [];
  for (let i = 0; i < 60; i++) {
    const key = i % 12 === 0;
    const size = 200 + ((i * 37) % 91); // odd and even sizes
    const f = new Uint8Array(size);
    f.set([0, 0, 1, 0xb6, key ? 0x10 : 0x50, 0x12], 0);
    for (let k = 6; k < size; k++) f[k] = (k * 7 + i) & 0x7f;
    frames.push({ data: f, key });
  }
  const split = 36;
  const strh = cat(enc.encode('vids'), enc.encode('FMP4'), u32(0), u16(0), u16(0), u32(0), u32(1), u32(25), u32(0), u32(frames.length), u32(4096), u32(0xffffffff), u32(0), u16(0), u16(0), u16(320), u16(240));
  const strf = cat(u32(40), u32(320), u32(240), u16(1), u16(24), enc.encode('FMP4'), u32(320 * 240 * 3), u32(0), u32(0), u32(0), u32(0));
  const indxBody = (entries) => cat(u16(4), new Uint8Array([0, 0]), u32(entries.length), enc.encode('00dc'), new Uint8Array(12), ...entries.map((e) => cat(u64(e.off), u32(e.size), u32(e.dur))), new Uint8Array(16 * (4 - entries.length)));
  const avih = (total) => cat(u32(40000), u32(0), u32(0), u32(0x910), u32(total), u32(0), u32(1), u32(0), u32(320), u32(240), new Uint8Array(16));
  // Pass 1 with placeholder index values to learn the layout, pass 2 with the real ones.
  let layout = null;
  let file = null;
  for (let pass = 0; pass < 2; pass++) {
    const ixEntries = layout ? layout.ix : [{ off: 0, size: 0, dur: 0 }, { off: 0, size: 0, dur: 0 }];
    const hdrl = lst('LIST', 'hdrl', ck('avih', avih(split)), lst('LIST', 'strl', ck('strh', strh), ck('strf', strf), ck('indx', indxBody(ixEntries))), lst('LIST', 'odml', ck('dmlh', cat(u32(frames.length), new Uint8Array(244)))));
    const riff1Head = 12;
    const moviStart1 = riff1Head + hdrl.length;
    const build = (list, base, withIdx) => {
      let pos = base + 12;
      const chunks = [];
      const entries = [];
      for (const f of list) {
        const c = ck('00dc', f.data);
        entries.push({ rel: pos - (base + 8), data: pos + 8, size: f.data.length, key: f.key });
        chunks.push(c);
        pos += c.length;
      }
      const ixAt = pos;
      const ix = ck('ix00', cat(u16(2), new Uint8Array([0, 1]), u32(entries.length), enc.encode('00dc'), u64(base + 8), u32(0), ...entries.map((e) => cat(u32(e.data - (base + 8)), u32(e.size | (e.key ? 0 : 0x80000000))))));
      const movi = lst('LIST', 'movi', ...chunks, ix);
      return { movi, entries, ixAt, ixSize: ix.length, withIdx };
    };
    const m1 = build(frames.slice(0, split), moviStart1, true);
    const idx1 = ck('idx1', cat(...m1.entries.map((e) => cat(enc.encode('00dc'), u32(e.key ? 0x10 : 0), u32(e.rel), u32(e.size)))));
    const riff1 = ck('RIFF', cat(enc.encode('AVI '), hdrl, m1.movi, idx1));
    const moviStart2 = riff1.length + 12;
    const m2 = build(frames.slice(split), moviStart2, false);
    const riff2 = ck('RIFF', cat(enc.encode('AVIX'), m2.movi));
    layout = { ix: [{ off: m1.ixAt, size: m1.ixSize, dur: split }, { off: m2.ixAt, size: m2.ixSize, dur: frames.length - split }] };
    file = cat(riff1, riff2);
  }
  return file;
}

function ffprobeFile(file, entries) {
  return JSON.parse(execFileSync('ffprobe', ['-v', 'quiet', ...entries, '-of', 'json', file], { maxBuffer: 64 << 20 }).toString());
}

test('riff: synthetic OpenDML file (AVIX + indx + ix00) matches FFmpeg', async () => {
  const bytes = buildOdml();
  const doc = await openDocument(new BytesSource(bytes, 'odml.avi'));
  assert.equal(doc.format.id, 'riff');
  assert.equal(doc.summary.label, 'AVI (OpenDML)');
  assert.deepEqual(doc.root.children.map((c) => `${c.type}:${c.label}`), ['RIFF:AVI', 'RIFF:AVIX']);
  assert.equal(doc.ctx.index.kind, 'OpenDML');
  assert.equal(doc.ctx.dmlhTotalFrames, 60);
  const t = doc.tracks[0];
  assert.equal(t.samples.count, 60);
  assert.equal(t.samples.source, 'OpenDML');
  for (let i = 0; i < 60; i++) assert.equal(t.samples.key[i], i % 12 === 0 ? 1 : 0);
  await expandAll(doc);
  assert.deepEqual(checkInvariants(doc), []);
  assert.deepEqual(parseFailures(doc), []);
  const ix = [...walk(doc.root)].filter((n) => n.type === 'ix00');
  assert.equal(ix.length, 2);
  assert.equal(ix[1].data.index.table.count, 24);
  const pads = [...walk(doc.root)].filter((n) => n.type === '00dc' && n.size % 2 === 0 && (n.size - 8) % 2 === 1);
  assert.ok(pads.length === 0, 'odd chunks include their pad byte');
  checkInsights(await doc.insights());
  if (haveFfprobe()) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bv-riff-'));
    const file = path.join(dir, 'odml.avi');
    fs.writeFileSync(file, bytes);
    try {
      const probe = ffprobeFile(file, ['-show_streams']);
      const packets = ffprobeFile(file, ['-show_entries', 'packet=stream_index,pts,dts,duration,size,pos,flags']).packets.map((p) => ({
        stream: p.stream_index, dts: Number(p.dts), size: Number(p.size), pos: Number(p.pos), key: String(p.flags).includes('K'),
      }));
      compareWithFfprobe(doc, probe.streams, packets);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

/** An AVI whose frames sit in 'rec ' lists, indexed with AVIIF_LIST entries; offsets relative or absolute. */
function buildRecAvi({ absolute }) {
  const strl = (type, handler, rate, ss, fmtBody) => lst('LIST', 'strl', ck('strh', cat(enc.encode(type), enc.encode(handler), u32(0), u16(0), u16(0), u32(0), u32(1), u32(rate), u32(0), u32(0), u32(0), u32(0), u32(ss), new Uint8Array(8))), ck('strf', fmtBody));
  const hdrl = lst('LIST', 'hdrl',
    ck('avih', cat(u32(40000), u32(0), u32(0), u32(0x110), u32(30), u32(0), u32(2), u32(0), u32(64), u32(48), new Uint8Array(16))),
    strl('vids', 'XVID', 25, 0, cat(u32(40), u32(64), u32(48), u16(1), u16(24), enc.encode('XVID'), u32(0), u32(0), u32(0), u32(0), u32(0))),
    strl('auds', '\0\0\0\0', 8000, 1, cat(u16(1), u16(1), u32(8000), u32(8000), u16(1), u16(8))));
  const moviStart = 12 + hdrl.length; // offset of 'LIST' of movi
  const base = absolute ? 0 : moviStart + 8;
  let pos = moviStart + 12;
  const recs = [];
  const idx = [];
  for (let i = 0; i < 30; i++) {
    const v = new Uint8Array(101 + (i % 4));
    v.set([0, 0, 1, 0xb6, i % 10 === 0 ? 0x10 : 0x50]);
    const a = new Uint8Array(320).fill(128);
    const vc = ck('00dc', v);
    const ac = ck('01wb', a);
    const rec = lst('LIST', 'rec ', vc, ac);
    idx.push(cat(enc.encode('rec '), u32(0x1), u32(pos - base), u32(rec.length - 8)));
    idx.push(cat(enc.encode('00dc'), u32(i % 10 === 0 ? 0x10 : 0), u32(pos + 12 - base), u32(v.length)));
    idx.push(cat(enc.encode('01wb'), u32(0x10), u32(pos + 12 + vc.length - base), u32(a.length)));
    recs.push(rec);
    pos += rec.length;
  }
  return ck('RIFF', cat(enc.encode('AVI '), hdrl, lst('LIST', 'movi', ...recs), ck('idx1', cat(...idx))));
}

for (const absolute of [false, true]) {
  test(`riff: rec lists with ${absolute ? 'absolute' : 'relative'} idx1 offsets match FFmpeg`, async () => {
    const bytes = buildRecAvi({ absolute });
    const doc = await openDocument(new BytesSource(bytes, 'rec.avi'));
    assert.equal(doc.ctx.idx1Info.absolute, absolute);
    assert.ok(doc.ctx.idx1Info.verified);
    assert.equal(doc.ctx.index.recs, 30);
    assert.equal(doc.tracks[0].samples.count, 30);
    assert.equal(doc.tracks[1].samples.count, 30);
    await expandAll(doc);
    assert.deepEqual(checkInvariants(doc), []);
    assert.deepEqual(parseFailures(doc), []);
    const movi = doc.root.children[0].children.find((c) => c.type === 'movi');
    assert.equal(movi.children.length, 30);
    assert.ok(movi.children.every((c) => c.type === 'rec ' && c.children.length === 2));
    assert.match(movi.children[0].children[0].label, /^#1 · key/);
    const items = await doc.insights();
    checkInsights(items);
    assert.ok(items.some((i) => /rec lists/.test(i.title)));
    if (haveFfprobe()) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bv-riff-'));
      const file = path.join(dir, 'rec.avi');
      fs.writeFileSync(file, bytes);
      try {
        const probe = ffprobeFile(file, ['-show_streams']);
        const packets = ffprobeFile(file, ['-show_entries', 'packet=stream_index,pts,dts,duration,size,pos,flags']).packets.map((p) => ({
          stream: p.stream_index, dts: Number(p.dts), size: Number(p.size), pos: Number(p.pos), key: String(p.flags).includes('K'),
        }));
        compareWithFfprobe(doc, probe.streams, packets);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });
}

test('riff: synthetic WAV with cue, adtl, smpl, inst, id3 and RIFX', async () => {
  const fmt = ck('fmt ', cat(u16(1), u16(2), u32(44100), u32(44100 * 4), u16(4), u16(16)));
  const data = ck('data', new Uint8Array(4 * 1000));
  const cue = ck('cue ', cat(u32(2), u32(1), u32(0), enc.encode('data'), u32(0), u32(0), u32(0), u32(2), u32(500), enc.encode('data'), u32(0), u32(0), u32(500)));
  const adtl = lst('LIST', 'adtl', ck('labl', cat(u32(1), enc.encode('Intro\0'))), ck('note', cat(u32(2), enc.encode('Chorus!\0'))));
  const smpl = ck('smpl', cat(u32(0), u32(0), u32(22676), u32(60), u32(0), u32(0), u32(0), u32(1), u32(0), u32(0), u32(0), u32(100), u32(900), u32(0), u32(0)));
  const inst = ck('inst', new Uint8Array([60, 0, 0, 0, 127, 1, 127]));
  const id3body = cat(enc.encode('TIT2'), new Uint8Array([0, 0, 0, 6, 0, 0, 3]), enc.encode('Hello'));
  const id3 = ck('id3 ', cat(enc.encode('ID3'), new Uint8Array([3, 0, 0, 0, 0, 0, id3body.length]), id3body));
  const info = lst('LIST', 'INFO', ck('INAM', enc.encode('Test tone\0')), ck('IART', enc.encode('Vidscope\0')));
  const wav = ck('RIFF', cat(enc.encode('WAVE'), fmt, data, cue, adtl, smpl, inst, id3, info));
  const doc = await openDocument(new BytesSource(wav, 'meta.wav'));
  assert.equal(doc.summary.label, 'WAV (RIFF)');
  assert.deepEqual(checkInvariants(doc), []);
  assert.deepEqual(parseFailures(doc), []);
  const types = doc.root.children[0].children.map((c) => c.type);
  assert.deepEqual(types, ['fmt ', 'data', 'cue ', 'adtl', 'smpl', 'inst', 'id3 ', 'INFO']);
  const kids = doc.root.children[0].children;
  assert.equal(kids[2].data.summary, '2 cue points');
  assert.equal(kids[3].children[0].label, 'cue 1: Intro');
  assert.equal(kids[3].children[1].label, 'cue 2: Chorus!');
  assert.equal(kids[4].data.summary, '1 loop');
  assert.match(kids[6].data.summary, /TIT2=Hello/);
  assert.equal(kids[7].children[0].data.text, 'Test tone');
  assert.ok(Math.abs(doc.summary.duration - 1000 / 44100) < 1e-9);
  const items = await doc.insights();
  checkInsights(items);
  assert.ok(items.some((i) => i.title === 'ID3 tag'));

  // The same file big-endian (RIFX).
  const be = (b) => { const c = b.slice(); return c; };
  const fmtBE = cat(enc.encode('fmt '), new Uint8Array([0, 0, 0, 16, 0, 1, 0, 2, 0, 0, 0xac, 0x44, 0, 2, 0xb1, 0x10, 0, 4, 0, 16]));
  const dataBE = cat(enc.encode('data'), new Uint8Array([0, 0, 0, 8]), be(new Uint8Array([0x7f, 0xff, 0x80, 0x00, 0, 1, 0, 2])));
  const body = cat(enc.encode('WAVE'), fmtBE, dataBE);
  const rifx = cat(enc.encode('RIFX'), new Uint8Array([0, 0, 0, body.length]), body);
  const d2 = await openDocument(new BytesSource(rifx, 'be.wav'));
  assert.equal(d2.summary.label, 'WAV (RIFX, big-endian)');
  assert.equal(d2.ctx.fmt.sampleRate, 44100);
  const det = await d2.detailAt(d2.wav.dataStart + 1);
  assert.deepEqual(det.units[0].fields.map((f) => f.value), [32767, -32768]);
});

test('riff: a large movi list is grouped and fully lazy', async () => {
  const n = 3000;
  const chunks = [];
  const entries = [];
  let pos = 4;
  for (let i = 0; i < n; i++) {
    const id = i % 3 === 2 ? '01wb' : '00dc';
    const body = new Uint8Array(i % 3 === 2 ? 64 : 33 + (i % 5));
    const c = ck(id, body);
    entries.push(cat(enc.encode(id), u32(id === '00dc' && i % 30 === 0 ? 0x10 : id === '01wb' ? 0x10 : 0), u32(pos), u32(body.length)));
    chunks.push(c);
    pos += c.length;
  }
  const strl = (type, handler, fmtBody) => lst('LIST', 'strl', ck('strh', cat(enc.encode(type), enc.encode(handler), u32(0), u16(0), u16(0), u32(0), u32(1), u32(type === 'vids' ? 25 : 8000), u32(0), u32(0), u32(0), u32(0), u32(type === 'vids' ? 0 : 1), new Uint8Array(8))), ck('strf', fmtBody));
  const hdrl = lst('LIST', 'hdrl',
    ck('avih', cat(u32(40000), u32(0), u32(0), u32(0x10), u32(2000), u32(0), u32(2), u32(0), u32(16), u32(16), new Uint8Array(16))),
    strl('vids', 'XVID', cat(u32(40), u32(16), u32(16), u16(1), u16(24), enc.encode('XVID'), u32(0), u32(0), u32(0), u32(0), u32(0))),
    strl('auds', '\0\0\0\0', cat(u16(1), u16(1), u32(8000), u32(8000), u16(1), u16(8))));
  const file = ck('RIFF', cat(enc.encode('AVI '), hdrl, lst('LIST', 'movi', ...chunks), ck('idx1', cat(...entries))));
  const doc = await openDocument(new BytesSource(file, 'big.avi'));
  const movi = doc.root.children[0].children.find((c) => c.type === 'movi');
  assert.ok(movi.lazy);
  assert.equal(doc.summary.unitCount, doc.ctx.headerCount + n);
  await ensureChildren(movi);
  assert.ok(movi.children.length >= 6 && movi.children.every((c) => c.type === 'chunks' && c.lazy), 'groups from the index');
  await expandAll(doc);
  assert.deepEqual(checkInvariants(doc), []);
  const media = [...walk(doc.root)].filter((c) => /^\d\d(dc|wb)$/.test(c.type));
  assert.equal(media.length, n);
  assert.equal(doc.tracks[0].samples.count, 2000);
  assert.equal(doc.tracks[1].samples.count, 1000);
  assert.equal(doc.tracks[1].samples.clock.mode, 'bytes');
  assert.equal(doc.tracks[1].samples.dts[1], 64, '8-bit mono PCM: 64 bytes = 64 samples');
});

// ------------------------------------------------------------ robustness

function prng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

async function exercise(bytes, name) {
  const doc = await riff.open(new (await import('../web/core/source.js')).CachedSource(new BytesSource(bytes, name)), {});
  if (doc.loadSamples) await doc.loadSamples();
  await expandAll(doc);
  const problems = checkInvariants(doc);
  assert.deepEqual(problems, [], `${name}: invariants`);
  await doc.insights();
  doc.glossary();
  for (let k = 0; k < 8; k++) {
    const off = Math.floor((k / 8) * bytes.length);
    await doc.detailAt(off);
    doc.overlay(off, off + 4096);
  }
  return doc;
}

test('riff: truncated and corrupted files never crash', { skip: !haveSample('mpeg4-mp3.avi') }, async () => {
  const sources = ['mpeg4-mp3.avi', 'h264-pcm.avi', 'pcm.wav', 'riff-bwf.wav'].filter(haveSample).map((n) => [n, new Uint8Array(fs.readFileSync(sample(n)))]);
  sources.push(['odml.avi', buildOdml()]);
  const rnd = prng(1234);
  for (const [name, full] of sources) {
    // Truncations at structural boundaries and at random points.
    for (const cut of [13, 100, 300, 5000, Math.floor(full.length / 2), full.length - 1, full.length - 17]) {
      if (cut >= full.length) continue;
      await exercise(full.subarray(0, cut), `${name}[:${cut}]`);
    }
    // Random byte corruption.
    for (let iter = 0; iter < 25; iter++) {
      const b = full.slice();
      const flips = 1 + Math.floor(rnd() * 12);
      for (let f = 0; f < flips; f++) b[Math.floor(rnd() * b.length)] = Math.floor(rnd() * 256);
      await exercise(b, `${name}~${iter}`);
    }
  }
  // Specific damage: garbage in the middle of movi, a missing pad byte, an absurd RIFF size.
  if (haveSample('mpeg4-mp3.avi')) {
    const b = new Uint8Array(fs.readFileSync(sample('mpeg4-mp3.avi')));
    const ref = await open('mpeg4-mp3.avi');
    const header = ref.tracks[0].samples.offsets[50] - 8;
    await ref._close();
    b.fill(0xff, header, header + 8); // destroy one chunk header in the middle of movi
    const doc = await exercise(b, 'garbage-in-movi');
    assert.ok([...walk(doc.root)].some((n) => n.type === 'garbage'), 'the unreadable chunk is shown as garbage');
    const items = await doc.insights();
    assert.ok(items.some((i) => i.group === 'Integrity' && i.level === 'bad'));
  }
  const noPad = ck('RIFF', cat(enc.encode('WAVE'), ck('fmt ', cat(u16(1), u16(1), u32(8000), u32(8000), u16(1), u16(8))), ck('odd!', new Uint8Array(3), { pad: false }), ck('data', new Uint8Array(10))));
  const d1 = await exercise(noPad, 'missing-pad');
  assert.ok([...walk(d1.root)].some((n) => n.warnings.some((w) => /no pad byte/.test(w))));
  const huge = cat(enc.encode('RIFF'), u32(0x7ffffff0), enc.encode('WAVE'), ck('fmt ', cat(u16(1), u16(1), u32(8000), u32(8000), u16(1), u16(8))), ck('data', new Uint8Array(10)));
  const d2 = await exercise(huge, 'huge-riff');
  assert.ok(d2.root.children[0].warnings.length > 0);
});

test('riff: probe', async () => {
  const head = (s) => cat(enc.encode(s.slice(0, 4)), u32(100), enc.encode(s.slice(4)));
  assert.equal(riff.probe(head('RIFFAVI ')), 100);
  assert.equal(riff.probe(head('RIFFWAVE')), 100);
  assert.equal(riff.probe(head('RF64WAVE')), 100);
  assert.ok(riff.probe(head('RIFFWEBP')) > 0 && riff.probe(head('RIFFWEBP')) < 100);
  assert.equal(riff.probe(enc.encode('FLV\x01\x05\0\0\0\x09')), 0);
  if (haveSample('h264-aac.mp4')) {
    const mp4 = new Uint8Array(fs.readFileSync(sample('h264-aac.mp4'))).subarray(0, 64);
    assert.equal(riff.probe(mp4), 0);
  }
});
