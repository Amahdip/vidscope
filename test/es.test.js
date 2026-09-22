// Raw elementary streams (H.264 and HEVC Annex B, MPEG-2 video): every frame's position, size and
// key flag must match FFmpeg's parser, and the display order worked out from the picture order
// count (or temporal reference) must match the order FFmpeg's decoder outputs frames in.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { open, sample, haveSample, haveFfprobe, checkInvariants } from './helpers.mjs';
import esFormat, { sniff } from '../web/formats/es/index.js';
import { ensureChildren, walk } from '../web/core/model.js';

const STREAMS = [
  ['es-h264.h264', 'avc'],
  ['es-h264-baseline.264', 'avc'],
  ['es-hevc.hevc', 'hevc'],
  ['es-hevc-notiming.265', 'hevc'],
  ['es-mpeg2.m2v', 'mpeg2v'],
];

function probe(name, what) {
  const out = execFileSync('ffprobe', ['-v', 'quiet', '-select_streams', 'v:0', ...what, '-of', 'json', sample(name)], { maxBuffer: 256 << 20 });
  return JSON.parse(out.toString());
}

for (const [name, codec] of STREAMS) {
  test(`elementary stream matches FFmpeg: ${name}`, { skip: (!haveSample(name) || !haveFfprobe()) && 'sample or ffprobe missing' }, async () => {
    const doc = await open(name);
    if (doc.loadSamples) await doc.loadSamples();
    assert.equal(doc.format.id, 'es');
    assert.equal(doc.codec, codec);
    const s = doc.tracks[0].samples;
    const packets = probe(name, ['-show_entries', 'packet=pos,size,flags']).packets;
    assert.equal(s.count, packets.length, 'frame count');
    packets.forEach((p, i) => {
      assert.equal(s.offsets[i], Number(p.pos), `frame ${i + 1} offset`);
      assert.equal(s.sizes[i], Number(p.size), `frame ${i + 1} size`);
      assert.equal(!!s.key[i], p.flags.includes('K'), `frame ${i + 1} key flag`);
    });
    // FFmpeg's decoder outputs frames in display order; ours comes from the POC / temporal reference.
    const frames = probe(name, ['-show_frames', '-show_entries', 'frame=pkt_pos,pict_type']).frames;
    const byOffset = new Map(Array.from(s.offsets, (o, i) => [o, i]));
    const order = Array.from({ length: s.count }, (_, i) => i).sort((a, b) => doc.scan.rank[a] - doc.scan.rank[b]);
    const pic = { 1: 'I', 2: 'P', 3: 'B' };
    frames.forEach((f, k) => {
      const i = byOffset.get(Number(f.pkt_pos));
      assert.equal(i, order[k], `display position ${k + 1}`);
      assert.equal(pic[doc.scan.pic[i]], f.pict_type, `frame ${i + 1} type`);
    });
    // The tree: frames, then NAL units with their fields, all inside their parents.
    for (const n of [...walk(doc.root)].slice(0, 40)) await ensureChildren(n);
    assert.deepEqual(checkInvariants(doc), []);
    const first = doc.root.children.find((n) => n.kind === 'frame' || n.kind === 'group');
    assert.ok(first, 'frames in the tree');
    doc._close();
  });
}

test('POC reordering: B-frames are shown before the P-frame stored ahead of them', { skip: !haveSample('es-h264.h264') }, async () => {
  const doc = await open('es-h264.h264');
  assert.equal(doc.scan.reordered, true);
  const s = doc.tracks[0].samples;
  assert.ok(s.cto, 'presentation offsets are rebuilt from the POC');
  // Presentation times never come before decoding times.
  for (let i = 0; i < s.count; i++) assert.ok(s.cto[i] >= 0, `frame ${i + 1}`);
  const base = await open('es-h264-baseline.264');
  assert.equal(base.scan.reordered, false, 'no B-frames: display order = decoding order');
  assert.equal(base.tracks[0].samples.cto, null);
  doc._close();
  base._close();
});

test('frame rate: from the SPS when it is there, 25 fps (with a warning) when it is not', { skip: !haveSample('es-hevc-notiming.265') || !haveSample('es-hevc.hevc') }, async () => {
  const timed = await open('es-hevc.hevc');
  assert.equal(timed.rate.fps, 25);
  assert.ok(timed.rate.source);
  const untimed = await open('es-hevc-notiming.265');
  assert.equal(untimed.rate.source, null);
  const ins = await untimed.insights();
  assert.ok(ins.some((i) => i.level === 'warn' && /No frame rate/.test(i.title)));
  const tins = await timed.insights();
  assert.ok(tins.some((i) => /Access unit delimiters/.test(i.title)), 'aud=1');
  assert.ok(tins.some((i) => /Parameter sets before every key frame/.test(i.title)), 'repeat-headers=1 with keyint=50');
  assert.ok(tins.some((i) => /Encoded with x265/.test(i.title)));
  assert.ok(tins.some((i) => i.cmd?.includes('-c copy -tag:v hvc1')), 'how to wrap it in MP4');
  timed._close();
  untimed._close();
});

test('large streams are walked in the background', { skip: !haveSample('es-hevc.hevc') }, async () => {
  const saved = esFormat.limits.scanAtOpen;
  esFormat.limits.scanAtOpen = 1024;
  try {
    const doc = await open('es-hevc.hevc');
    assert.ok(doc.loadSamples, 'the frame table waits for the walk');
    assert.equal(doc.tracks[0].samples, undefined);
    assert.equal(doc.rate.fps, 25, 'the start of the stream already gives the frame rate');
    await doc.loadSamples();
    assert.equal(doc.tracks[0].samples.count, 100);
    assert.ok(doc.root.children.every((n) => n.kind === 'frame'));
    doc._close();
  } finally {
    esFormat.limits.scanAtOpen = saved;
  }
});

test('recognising raw streams', () => {
  const b = (...x) => Uint8Array.from(x);
  assert.equal(sniff(b(0, 0, 0, 1, 0x40, 0x01, 0x0c, 0x01, 0, 0, 0, 1, 0x42, 0x01, 1)), 'hevc', 'starts with a VPS');
  assert.equal(sniff(b(0, 0, 0, 1, 0x67, 0x64, 0, 0x1e, 0, 0, 0, 1, 0x68, 0xee)), 'avc', 'starts with an SPS');
  assert.equal(sniff(b(0, 0, 0, 1, 0x09, 0xf0, 0, 0, 0, 1, 0x67, 0x42)), 'avc', 'starts with an AUD');
  assert.equal(sniff(b(0, 0, 1, 0xb3, 0x28, 0x01, 0x68)), 'mpeg2v', 'sequence header');
  assert.equal(sniff(b(0, 0, 1, 0xba, 0x44, 0, 4)), null, 'MPEG program stream');
  assert.equal(sniff(b(0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70)), null, 'MP4');
  assert.equal(sniff(b(0x47, 0x40, 0, 0x10)), null, 'transport stream');
});
