// FLV: compare Vidscope's frame tables with FFmpeg's demuxer tag by tag, check
// the tree invariants, the lazy tag groups, and damaged files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { open, haveSample, haveFfprobe, probeStreams, probePackets, checkInvariants, sample } from './helpers.mjs';
import { openDocument } from '../web/formats/index.js';
import { BytesSource, CachedSource } from '../web/core/source.js';
import { ensureChildren, walk } from '../web/core/model.js';
import flv from '../web/formats/flv/index.js';

const FILES = ['h264-aac.flv', 'flv-h264-mp3-keyframes.flv', 'flv-hevc-opus.flv', 'flv-vp9-aac.flv', 'flv-av1-aac.flv', 'flv-sorenson-mp3.flv'];
const LEVELS = new Set(['good', 'info', 'warn', 'bad']);
const GROUPS = new Set(['Overview', 'Layout', 'Tracks', 'Encoding', 'Timing', 'Integrity', 'Metadata']);

async function expandAll(doc) {
  for (let pass = 0; pass < 4; pass++) {
    const lazy = [...walk(doc.root)].filter((n) => n.lazy);
    if (!lazy.length) break;
    for (const n of lazy) await ensureChildren(n);
  }
}

function checkInsights(items) {
  assert.ok(items.length > 0);
  for (const i of items) {
    assert.ok(LEVELS.has(i.level), `level ${i.level}`);
    assert.ok(GROUPS.has(i.group), `group ${i.group}`);
    assert.ok(i.title);
    assert.ok(!/undefined|NaN|\[object/.test(`${i.title} ${i.text ?? ''} ${(i.facts ?? []).flat().join(' ')}`), `no undefined/NaN in "${i.title}"`);
  }
}

for (const name of FILES) {
  test(`flv: ${name} matches FFmpeg`, { skip: !haveSample(name) && 'run npm run samples' }, async () => {
    const doc = await open(name);
    try {
      assert.equal(doc.format.id, 'flv');
      assert.ok(doc.root.children.length < 30, 'open() only parses the first tags');
      await doc.loadSamples();
      await expandAll(doc);
      assert.deepEqual(checkInvariants(doc), []);
      const failures = [];
      for (const n of walk(doc.root)) for (const w of n.warnings) failures.push(`${n.type}@${n.offset}: ${w}`);
      assert.deepEqual(failures, []);
      // Every tag of the scan is in the tree exactly once, in order.
      const tags = [...walk(doc.root)].filter((n) => n.kind === 'tag');
      assert.equal(tags.length, doc.scan.count);
      tags.forEach((n, k) => assert.equal(n.offset, doc.scan.offs[k]));
      assert.equal(doc.summary.unitCount, doc.scan.count);
      if (haveFfprobe()) {
        const streams = probeStreams(name).streams;
        const packets = probePackets(name);
        assert.equal(doc.tracks.length, streams.length, 'track count');
        for (const t of doc.tracks) {
          const st = streams[t.index];
          assert.equal(st.codec_type, t.kind, `${t.label}: stream order follows the first tag of each kind`);
          const s = t.samples;
          const theirs = packets.filter((p) => p.stream === t.index);
          assert.equal(s.count, theirs.length, `${t.label}: frame count`);
          for (let i = 0; i < s.count; i++) {
            const p = theirs[i];
            assert.equal(s.tags[i], p.pos, `${t.label} frame ${i}: tag offset`);
            assert.equal(s.sizes[i], p.size, `${t.label} frame ${i}: size`);
            assert.equal(s.dts[i], p.dts, `${t.label} frame ${i}: dts`);
            assert.equal(s.dts[i] + (s.cto ? s.cto[i] : 0), p.pts, `${t.label} frame ${i}: pts`);
            if (t.kind === 'video') assert.equal(!!s.key[i], p.key, `${t.label} frame ${i}: key`);
          }
        }
      }
      // Frame bytes are explained by detailAt (codec units when the codec has a parser).
      for (const t of doc.tracks) {
        const s = t.samples;
        const d = await doc.detailAt(s.offsets[0] + Math.floor(s.sizes[0] / 2));
        assert.equal(d.kind, 'sample');
        assert.equal(d.track, t);
        if (t.family) {
          assert.ok(d.units.length > 0, `${t.label}: units`);
          if (t.family === 'avc' || t.family === 'hevc') assert.equal(d.units.reduce((n, u) => n + u.size, 0), s.sizes[0], 'NAL units tile the frame');
        }
      }
      const runs = doc.overlay(0, doc.size);
      assert.equal(runs.length, doc.tracks.reduce((n, t) => n + t.samples.count, 0));
      checkInsights(await doc.insights());
      assert.ok(doc.glossary().length > 15);
    } finally {
      await doc._close();
    }
  });
}

test('flv: structure of h264-aac.flv', { skip: !haveSample('h264-aac.flv') }, async () => {
  const doc = await open('h264-aac.flv');
  const kids = doc.root.children;
  assert.deepEqual(kids.slice(0, 5).map((c) => c.type), ['header', 'PreviousTagSize0', 'script', 'video', 'audio']);
  assert.equal(kids[0].size, 9);
  assert.equal(kids[2].label, 'onMetaData');
  assert.equal(kids[3].label, 'AVC sequence header');
  assert.equal(kids[4].label, 'AAC sequence header');
  assert.equal(kids.at(-1).type, 'tags');
  assert.ok(kids.at(-1).lazy);
  assert.equal(doc.meta.duration, 4.08);
  assert.equal(doc.meta.width, 640);
  assert.equal(doc.meta.encoder.slice(0, 4), 'Lavf');
  const [v, a] = doc.tracks;
  assert.equal(v.codecString, 'avc1.64001E');
  assert.equal(v.sampleCfg.lengthSize, 4);
  assert.equal(a.codecString, 'mp4a.40.2');
  // The header fields map to the right bytes.
  const f = kids[3].fields;
  assert.deepEqual(f.slice(0, 7).map((x) => x.name), ['Reserved', 'Filter', 'TagType', 'DataSize', 'Timestamp', 'TimestampExtended', 'StreamID']);
  assert.equal(f.find((x) => x.name === 'PreviousTagSize').value, 11 + f.find((x) => x.name === 'DataSize').value);
  await doc.loadSamples();
  const s = v.samples;
  assert.equal(s.cto[0], 80, 'B-frames: CompositionTime');
  const d = await doc.detailAt(s.offsets[0] + 3);
  assert.deepEqual(d.units.map((u) => u.kind), [6, 5]);
  assert.equal(d.hit.fields[0].f.name, 'NALUnitLength');
  const items = await doc.insights();
  assert.ok(items.some((i) => i.title === 'onMetaData matches the stream'));
  assert.ok(items.some((i) => i.title === 'Every PreviousTagSize matches'));
  assert.ok(items.some((i) => i.title === 'No keyframes index' && i.cmd));
  await doc._close();
});

test('flv: Enhanced RTMP and the keyframes index', { skip: !haveSample('flv-hevc-opus.flv') }, async () => {
  const doc = await open('flv-hevc-opus.flv');
  assert.equal(doc.summary.label, 'FLV (Enhanced RTMP)');
  const [v, a] = doc.tracks;
  assert.equal(v.h.fourcc, 'hvc1');
  assert.match(v.codecString, /^hvc1\.1\./);
  assert.equal(a.h.fourcc, 'Opus');
  assert.equal(a.opus.channels, 1);
  const labels = doc.root.children.map((c) => c.label);
  assert.ok(labels.includes('Opus channel config'), 'MultichannelConfig tag');
  assert.ok(labels.includes('hvc1 metadata'), 'colorInfo metadata tag');
  const meta = doc.root.children.find((c) => c.label === 'hvc1 metadata');
  assert.ok(meta.fields.some((x) => x.name === 'name' && x.display === '"colorInfo"'));
  await doc.loadSamples();
  const d = await doc.detailAt(v.samples.offsets[0] + 10);
  assert.match(d.units[0].title, /IDR/);
  await doc._close();

  if (haveSample('flv-h264-mp3-keyframes.flv')) {
    const kf = await open('flv-h264-mp3-keyframes.flv');
    assert.equal(kf.meta.keyframes.times.length, 4);
    const items = await kf.insights();
    assert.ok(items.some((i) => /keyframes index verified/.test(i.title)));
    const scriptNode = kf.root.children[2];
    const table = [...walk(scriptNode)].length && JSON.stringify(scriptNode.fields.map((x) => x.name));
    assert.ok(table.includes('value'));
    await kf._close();
  }
});

// ------------------------------------------------------------ synthetic files

function tag(type, ts, data) {
  const b = new Uint8Array(11 + data.length + 4);
  const dv = new DataView(b.buffer);
  b[0] = type;
  b[1] = data.length >> 16;
  b[2] = (data.length >> 8) & 0xff;
  b[3] = data.length & 0xff;
  b[4] = (ts >> 16) & 0xff;
  b[5] = (ts >> 8) & 0xff;
  b[6] = ts & 0xff;
  b[7] = (ts >>> 24) & 0xff;
  b.set(data, 11);
  dv.setUint32(11 + data.length, 11 + data.length);
  return b;
}

function cat(parts) {
  const n = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

const HEADER = new Uint8Array([0x46, 0x4c, 0x56, 1, 5, 0, 0, 0, 9, 0, 0, 0, 0]);

/** An FLV with MP3 audio tags only (10-byte frames): many tags, tiny file. */
function manyTags(n) {
  const parts = [HEADER];
  for (let i = 0; i < n; i++) parts.push(tag(8, i * 26, new Uint8Array([0x2e, 0xff, 0xfb, 0x90, 0x44, 0, 0, 0, 0, 0])));
  return cat(parts);
}

test('flv: many tags stay lazy and grouped', async () => {
  const bytes = manyTags(20000);
  const t0 = performance.now();
  const doc = await openDocument(new BytesSource(bytes, 'many.flv'));
  assert.ok(performance.now() - t0 < 500, 'open() is fast');
  assert.equal(doc.format.id, 'flv');
  assert.ok(doc.root.children.length <= 20);
  const rest = doc.root.children.at(-1);
  assert.equal(rest.type, 'tags');
  await doc.loadSamples();
  assert.equal(doc.scan.count, 20000);
  assert.equal(doc.tracks[0].samples.count, 20000);
  await ensureChildren(rest);
  assert.ok(rest.children.length >= 39 && rest.children.every((g) => g.kind === 'group' && g.lazy), 'groups of tags');
  await expandAll(doc);
  assert.deepEqual(checkInvariants(doc), []);
  assert.equal([...walk(doc.root)].filter((n) => n.kind === 'tag').length, 20000);
});

test('flv: damaged files are reported, not fatal', async () => {
  const good = manyTags(300);
  // 1. A PreviousTagSize that lies.
  const b1 = good.slice();
  const off = 13 + 25 * 5 + 21; // the PreviousTagSize after tag 5
  b1[off + 3] ^= 0x10;
  let doc = await openDocument(new BytesSource(b1, 'pts.flv'));
  await doc.loadSamples();
  let items = await doc.insights();
  assert.ok(items.some((i) => /PreviousTagSize mismatch/.test(i.title)));
  await expandAll(doc);
  assert.deepEqual(checkInvariants(doc), []);
  // 2. Garbage in the middle: the scan resyncs on the next tag whose PreviousTagSize matches.
  const b2 = good.slice();
  b2.fill(0xee, 13 + 25 * 100, 13 + 25 * 100 + 60);
  doc = await openDocument(new BytesSource(b2, 'garbage.flv'));
  await doc.loadSamples();
  assert.equal(doc.scan.garbage.length, 1);
  assert.ok(doc.scan.garbage[0].resynced);
  assert.ok(doc.scan.count > 290);
  items = await doc.insights();
  assert.ok(items.some((i) => i.level === 'bad' && /Unreadable bytes/.test(i.title)));
  await expandAll(doc);
  assert.deepEqual(checkInvariants(doc), []);
  assert.ok([...walk(doc.root)].some((n) => n.type === 'garbage'));
  // 3. Truncated in the middle of a tag.
  doc = await openDocument(new BytesSource(good.subarray(0, good.length - 30), 'cut.flv'));
  await doc.loadSamples();
  items = await doc.insights();
  assert.ok(items.some((i) => /cut off/.test(i.title)));
  await expandAll(doc);
  assert.deepEqual(checkInvariants(doc), []);
  // 4. Header only, and less than a header.
  for (const n of [0, 3, 9, 13, 20]) {
    doc = await flv.open(new CachedSource(new BytesSource(good.subarray(0, n), 'tiny.flv')), {});
    await doc.loadSamples();
    await expandAll(doc);
    assert.deepEqual(checkInvariants(doc), []);
    await doc.insights();
  }
});

function prng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

test('flv: random corruption never crashes', { skip: !haveSample('h264-aac.flv') }, async () => {
  const rnd = prng(99);
  for (const name of FILES.filter(haveSample)) {
    const full = new Uint8Array(fs.readFileSync(sample(name)));
    for (let iter = 0; iter < 15; iter++) {
      const b = full.slice();
      const flips = 1 + Math.floor(rnd() * 10);
      for (let f = 0; f < flips; f++) b[Math.floor(rnd() * Math.min(b.length, 40000))] = Math.floor(rnd() * 256);
      const cut = rnd() < 0.3 ? Math.floor(rnd() * b.length) : b.length;
      const doc = await flv.open(new CachedSource(new BytesSource(b.subarray(0, cut), `${name}~${iter}`)), {});
      await doc.loadSamples();
      await expandAll(doc);
      assert.deepEqual(checkInvariants(doc), [], `${name}~${iter}`);
      await doc.insights();
      for (const t of doc.tracks) if (t.samples?.count) await doc.detailAt(t.samples.offsets[0]);
    }
  }
});

test('flv: probe', () => {
  assert.equal(flv.probe(HEADER), 100);
  assert.equal(flv.probe(new Uint8Array([0x46, 0x4c, 0x56, 1, 5, 0, 0])), 0);
  assert.equal(flv.probe(new TextEncoder().encode('RIFF\0\0\0\0AVI ')), 0);
});
