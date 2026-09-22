// Frame types and GOPs: every frame's type (I, P, B...) must match what FFmpeg's decoders
// report (ffprobe -show_frames pict_type), in every container; GOP analysis on known encodes;
// and the classifier on hand-made headers for the cases the samples don't cover.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { open, sample, haveSample, haveFfprobe } from './helpers.mjs';
import { frameTypes, analyzeFrames, displayOrder, frameInsights } from '../web/core/frames.js';
import { FT, FF, classifyFrame, frameContext, typeLetter } from '../web/codecs/frametype.js';

const LETTER = { [FT.I]: 'I', [FT.P]: 'P', [FT.B]: 'B', [FT.S]: 'S' };

/** Open a sample, build its frame tables and classify every frame of each video track. */
async function classified(name) {
  const doc = await open(name);
  if (doc.loadSamples) await doc.loadSamples();
  const tracks = doc.tracks.filter((t) => t.kind === 'video' && t.samples?.count);
  for (const t of tracks) await frameTypes(doc, t).ensure();
  return { doc, tracks };
}

/** ffprobe's decoded frames (display order) with their packet positions. */
function probeFrames(name, index) {
  try {
    const out = execFileSync('ffprobe', ['-v', 'quiet', '-select_streams', `v:${index}`, '-show_frames', '-show_entries', 'frame=pict_type,pkt_pos', '-of', 'json', sample(name)], { maxBuffer: 256 << 20 });
    return JSON.parse(out.toString()).frames ?? [];
  } catch {
    return [];
  }
}

const SAMPLES = [
  'h264-aac.mp4', 'h264-aac-fragmented.mp4', 'hevc-aac.mp4', 'hevc-10bit-hdr.mp4', 'av1-opus.mp4', 'h264-aac.mov',
  'h264-aac.mkv', 'matroska-hevc-hdr.mkv', 'matroska-av1-opus.mkv', 'matroska-mpeg4-mp3-ac3.mkv', 'vp9-opus.webm', 'matroska-vp8-vorbis.webm',
  'h264-aac.ts', 'hevc-ac3.ts', 'mpegts-mpeg2-mp2-cbr.ts', 'mpegts-h264-aac.m2ts',
  'h264-pcm.avi', 'mpeg4-mp3.avi', 'riff-mjpeg-ac3.avi',
  'h264-aac.flv', 'flv-hevc-opus.flv', 'flv-av1-aac.flv', 'flv-vp9-aac.flv', 'flv-sorenson-mp3.flv',
];

for (const name of SAMPLES) {
  test(`frame types match FFmpeg: ${name}`, { skip: (!haveSample(name) || !haveFfprobe()) && 'sample or ffprobe missing' }, async () => {
    const { doc, tracks } = await classified(name);
    assert.ok(tracks.length, 'has a video track');
    tracks.forEach((t, vi) => {
      const ft = frameTypes(doc, t);
      const s = t.samples;
      assert.ok(ft.supported, `${t.label}: frame types supported`);
      assert.ok(ft.complete, `${t.label}: every frame looked at`);
      const frames = probeFrames(name, vi);
      assert.ok(frames.length, 'ffprobe decoded frames');
      // Join on the packet position where the container's positions match ours (MP4, AVI);
      // otherwise both lists are in display order and are compared position by position.
      const byPos = new Map();
      for (let i = 0; i < s.count; i++) byPos.set(Math.round(s.offsets[i]), i);
      let pairs = frames.map((f) => [byPos.get(Number(f.pkt_pos)), f.pict_type]).filter(([i]) => i !== undefined);
      if (pairs.length < frames.length / 2) {
        const { order } = displayOrder(t);
        pairs = frames.slice(0, order.length).map((f, k) => [order[k], f.pict_type]);
      }
      let compared = 0;
      for (const [i, pict] of pairs) {
        const ours = ft.type[i];
        if (ours === FT.REPEAT || ours === FT.UNKNOWN) continue; // shown again, no picture of its own
        compared++;
        assert.equal(LETTER[ours], pict === 'SP' || pict === 'SI' ? 'S' : pict, `${t.label} frame ${i + 1}`);
      }
      assert.ok(compared >= Math.min(20, s.count / 2), `${t.label}: compared ${compared} frames`);
    });
    doc._close();
  });
}

test('GOPs of an x264 encode: fixed, closed, B-pyramid', { skip: !haveSample('h264-aac.mp4') }, async () => {
  const { doc, tracks } = await classified('h264-aac.mp4');
  const an = analyzeFrames(frameTypes(doc, tracks[0]));
  // make-samples.sh: 100 frames at 25 fps, -g 50 -bf 2
  assert.equal(an.gop.count, 2);
  assert.equal(an.gop.minFrames, 50);
  assert.equal(an.gop.fixed, true);
  assert.equal(an.gop.closed, 2);
  assert.equal(an.gop.open, 0);
  assert.equal(an.maxB, 2);
  assert.ok(an.refB > 0, 'x264 uses a B-pyramid by default');
  assert.equal(an.types.I.count, 2);
  assert.ok(an.pattern.startsWith('IBb') || an.pattern.startsWith('IbB'), an.pattern);
  assert.ok(Math.abs(an.gop.avgSeconds - 2) < 0.01);
  const ins = await frameInsights(doc);
  assert.ok(ins.some((i) => /a key frame every 50 frames \(2(\.00)? s\)/.test(i.title) && i.level === 'good'), ins.map((i) => i.title).join(' | '));
  assert.ok(ins.some((i) => /B-pyramid/.test(i.title)));
  doc._close();
});

test('decoding order and display order differ with B-frames', { skip: !haveSample('h264-aac.mp4') }, async () => {
  const { doc, tracks } = await classified('h264-aac.mp4');
  const t = tracks[0];
  const ft = frameTypes(doc, t);
  const { order, rank, reordered } = displayOrder(t);
  assert.equal(reordered, true);
  // The frame stored second is a P-frame shown after the B-frames stored behind it.
  assert.equal(ft.letter(0), 'I');
  assert.equal(ft.letter(1), 'P');
  assert.ok(rank[1] > rank[2], 'P shown after the B stored after it');
  assert.equal(order[0], 0, 'the IDR frame is shown first');
  doc._close();
});

test('MPEG-2 in TS: open GOPs, B-frames are never references', { skip: !haveSample('mpegts-mpeg2-mp2-cbr.ts') }, async () => {
  const { doc, tracks } = await classified('mpegts-mpeg2-mp2-cbr.ts');
  const an = analyzeFrames(frameTypes(doc, tracks[0]));
  assert.ok(an.gop.open > 0, 'FFmpeg writes open GOPs for MPEG-2 by default');
  assert.equal(an.refB, 0);
  assert.ok(an.types.b.count > 0);
  assert.ok(an.pattern.startsWith('bbI'), `leading B-frames are shown before the I-frame: ${an.pattern}`);
  const ins = await frameInsights(doc);
  assert.ok(ins.some((i) => /open GOP/.test(i.title)));
  doc._close();
});

test('AV1: hidden frames and show-existing frames', { skip: !haveSample('av1-opus.mp4') }, async () => {
  const { doc, tracks } = await classified('av1-opus.mp4');
  const an = analyzeFrames(frameTypes(doc, tracks[0]));
  assert.ok(an.hidden > 0, 'SVT-AV1 codes alternate reference frames');
  assert.ok(an.types['='].count > 0, 'and shows them later with show_existing_frame');
  assert.equal(an.types.I.count, 1);
  doc._close();
});

test('intra-only video: every frame is an I-frame', { skip: !haveSample('riff-mjpeg-ac3.avi') }, async () => {
  const { doc, tracks } = await classified('riff-mjpeg-ac3.avi');
  const ft = frameTypes(doc, tracks[0]);
  assert.equal(ft.intraOnly, true);
  const an = analyzeFrames(ft);
  assert.equal(an.types.I.count, tracks[0].samples.count);
  const ins = await frameInsights(doc);
  assert.ok(ins.some((i) => /every frame is a key frame/.test(i.title)));
  doc._close();
});

test('encrypted H.264: only the clear NAL header is used', { skip: !haveSample('h264-cenc.mp4') }, async () => {
  const { doc, tracks } = await classified('h264-cenc.mp4');
  const ft = frameTypes(doc, tracks[0]);
  for (let i = 0; i < ft.count; i++) {
    assert.ok(ft.type[i] === FT.I || ft.type[i] === FT.UNKNOWN, `frame ${i + 1}: ${typeLetter(ft.type[i], ft.flags[i])}`);
    assert.ok(ft.flags[i] & (FF.REF | FF.NONREF), 'nal_ref_idc is in the clear');
  }
  assert.equal(ft.type[0], FT.I);
  doc._close();
});

// ------------------------------------------------------------ hand-made headers

function run(family, bytes, extra = {}) {
  const ctx = frameContext({ family, lengthSize: 4, ...extra });
  const out = {};
  const u8 = Uint8Array.from(bytes);
  const r = classifyFrame(ctx, u8, 0, u8.length, u8.length, out);
  return { r, ...out };
}
const lp = (...nal) => [0, 0, 0, nal.length, ...nal]; // one length-prefixed NAL unit

test('H.264: IDR, non-reference B, recovery point', () => {
  // nal_ref_idc 3, type 5; first_mb_in_slice ue(0) = 1, slice_type ue(7) = 0001000
  let f = run('avc', lp(0x65, 0b10001000, 0x80));
  assert.equal(f.type, FT.I);
  assert.ok(f.flags & FF.RAP && f.flags & FF.CLOSED && f.flags & FF.REF);
  // nal_ref_idc 0, type 1; slice_type ue(6) (B) = 00111
  f = run('avc', lp(0x01, 0b10011100, 0x80));
  assert.equal(f.type, FT.B);
  assert.ok(f.flags & FF.NONREF);
  assert.equal(typeLetter(f.type, f.flags), 'b');
  // SEI with a recovery point (payload 6, size 1, recovery_frame_cnt 0), then a non-IDR I slice
  f = run('avc', [...lp(0x06, 0x06, 0x01, 0x80, 0x80), ...lp(0x61, 0b10001000, 0x80)]);
  assert.equal(f.type, FT.I);
  assert.ok(f.flags & FF.RECOVERY && f.flags & FF.RAP);
  assert.ok(!(f.flags & FF.CLOSED));
});

test('HEVC: CRA and RASL frames', () => {
  // CRA (21): first_slice 1, no_output_of_prior_pics 0, pps_id ue(0) = 1, slice_type ue(2) = 011
  let f = run('hevc', lp(21 << 1, 0x01, 0b10101110));
  assert.equal(f.type, FT.I);
  assert.ok(f.flags & FF.RAP);
  assert.ok(!(f.flags & FF.CLOSED));
  // RASL_N (8): first_slice 1, pps_id 1, slice_type ue(0) = 1 (B)
  f = run('hevc', lp(8 << 1, 0x01, 0b11100000));
  assert.equal(f.type, FT.B);
  assert.ok(f.flags & FF.LEADING && f.flags & FF.SKIPPABLE && f.flags & FF.NONREF);
  // An in-band PPS with num_extra_slice_header_bits = 2 shifts slice_type by two bits.
  // PPS: pps_id ue(0) 1, sps_id ue(0) 1, two flags 00, extra bits 010 -> 11000101 (then stop bit)
  f = run('hevc', [...lp(34 << 1, 0x01, 0b11000101, 0x80), ...lp(1 << 1, 0x01, 0b11000100)]);
  // TRAIL_R: first 1, pps 1, two reserved flags 00, slice_type ue(1) = 010 -> P
  assert.equal(f.type, FT.P);
});

test('AV1: a show-existing frame repeats a hidden frame', () => {
  // temporal delimiter OBU, then a frame header OBU with show_existing_frame = 1
  const f = run('av1', [0x12, 0x00, 0x1a, 0x01, 0x80]);
  assert.equal(f.type, FT.REPEAT);
  const g = run('av1', [0x12, 0x00, 0x32, 0x01, 0b00010000]); // OBU_FRAME: show_existing 0, KEY_FRAME (00), show_frame 1
  assert.equal(g.type, FT.I);
  assert.ok(g.flags & FF.CLOSED);
});

test('Sorenson Spark: disposable inter frames are not references', () => {
  // 17-bit start code, version 0, temporal ref 0, size 2 (fixed), type 2 (disposable)
  const bits = '00000000000000001' + '00000' + '00000000' + '010' + '10' + '0'.repeat(7);
  const bytes = bits.match(/.{8}/g).map((b) => parseInt(b, 2));
  const f = run('h263s', bytes);
  assert.equal(f.type, FT.P);
  assert.ok(f.flags & FF.NONREF);
});

test('classifier asks for more bytes when a header is cut off', () => {
  const ctx = frameContext({ family: 'avc', lengthSize: 4 });
  const u8 = Uint8Array.from([0, 0, 1, 0, 0x06, 0xff, 0xff]); // a 256-byte SEI; only 3 bytes present
  const out = {};
  assert.equal(classifyFrame(ctx, u8, 0, u8.length, 300, out), -1);
});
