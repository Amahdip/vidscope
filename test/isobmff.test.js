// ISO-BMFF: compare Vidscope's sample tables with FFmpeg's demuxer, sample by sample.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { open, haveSample, haveFfprobe, probeStreams, probePackets, checkInvariants } from './helpers.mjs';

const FILES = [
  'h264-aac.mp4', 'h264-aac-faststart.mp4', 'h264-aac-fragmented.mp4', 'h264-aac-dash-sidx.mp4', 'hevc-aac.mp4',
  'hevc-10bit-hdr.mp4', 'av1-opus.mp4', 'h264-ac3.mp4', 'h264-eac3.mp4', 'h264-cenc.mp4', 'h264-rotated.mp4',
  'h264-aac-subs-chapters.mp4', 'h264-aac.mov', 'aac.m4a', 'still.avif',
];

for (const name of FILES) {
  test(`isobmff: ${name}`, { skip: !haveSample(name) && 'run npm run samples' }, async () => {
    const doc = await open(name);
    try {
      assert.equal(doc.format.id, 'isobmff');
      assert.deepEqual(checkInvariants(doc), []);

      // No box should fail to parse.
      const failures = [];
      const visit = (n) => {
        for (const w of n.warnings) if (/could not parse|Not enough data|internal/.test(w)) failures.push(`${n.type}@${n.offset}: ${w}`);
        for (const c of n.children ?? []) visit(c);
      };
      visit(doc.root);
      assert.deepEqual(failures, []);

      if (!haveFfprobe() || name.endsWith('.avif')) return;
      const probe = probeStreams(name);
      const streams = probe.streams;
      assert.equal(doc.tracks.length, streams.length, 'track count');

      // ffprobe without edit lists applied shows every sample exactly as stored.
      const packets = probePackets(name, ['-ignore_editlist', '1']);
      for (const t of doc.tracks) {
        const st = streams[t.index];
        const mine = t.samples;
        const theirs = packets.filter((p) => p.stream === t.index);
        if (st.codec_type === 'data' && theirs.length === 0) continue; // timecode tracks
        assert.ok(mine, `${t.label}: no sample table`);
        assert.equal(mine.count, theirs.length, `${t.label}: sample count`);
        // FFmpeg shifts PTS by the most negative composition offset so that PTS >= DTS.
        let shift = 0;
        if (mine.cto) for (let i = 0; i < mine.count; i++) shift = Math.max(shift, -mine.cto[i]);
        for (let i = 0; i < mine.count; i++) {
          const p = theirs[i];
          assert.equal(mine.sizes[i], p.size, `${t.label} sample ${i}: size`);
          assert.equal(mine.offsets[i], p.pos, `${t.label} sample ${i}: offset`);
          assert.equal(mine.dts[i], p.dts, `${t.label} sample ${i}: dts`);
          if (mine.cto) assert.equal(mine.dts[i] + mine.cto[i] + shift, p.pts, `${t.label} sample ${i}: pts`);
          const key = mine.key ? !!mine.key[i] : true;
          if (t.kind === 'video') assert.equal(key, p.key, `${t.label} sample ${i}: key frame`);
        }
        if (st.codec_type === 'video' && st.width && t.sps) {
          assert.equal(t.sps.width, st.width, `${t.label}: width`);
          assert.equal(t.sps.height, st.height, `${t.label}: height`);
        }
      }
    } finally {
      await doc._close();
    }
  });
}

test('isobmff: codec details', { skip: !haveSample('hevc-10bit-hdr.mp4') }, async () => {
  const h264 = await open('h264-aac.mp4');
  const v = h264.tracks[0];
  assert.equal(v.codecString, 'avc1.64001E');
  assert.equal(v.sps.width, 640);
  assert.equal(v.sps.vui.fps, 25);
  const a = h264.tracks[1];
  assert.equal(a.codecString, 'mp4a.40.2');
  await h264._close();

  const hdr = await open('hevc-10bit-hdr.mp4');
  const hv = hdr.tracks[0];
  assert.match(hv.codecString, /^hvc1\.2\.4\.L\d+\.[0-9A-F]+/);
  assert.equal(hv.sps.bit_depth_luma, 10);
  assert.equal(hv.sps.vui.transfer, 16, 'PQ transfer in the VUI');
  await hdr._close();

  const av1 = await open('av1-opus.mp4');
  assert.match(av1.tracks[0].codecString, /^av01\.0\.\d\dM\.08$/);
  assert.equal(av1.tracks[1].codecString, 'opus');
  await av1._close();

  const rot = await open('h264-rotated.mp4');
  assert.ok(rot.tracks[0].props.some(([k, v2]) => k === 'rotation' && v2.startsWith('90° counter-clockwise')), 'FFmpeg display_rotation 90 is counter-clockwise');
  await rot._close();

  const enc = await open('h264-cenc.mp4');
  assert.equal(enc.tracks[0].fourcc, 'encv');
  assert.equal(enc.tracks[0].codec, 'avc1');
  assert.equal(enc.tracks[0].entry.kid, 'a7e61c37-3e21-9033-c210-91fa607bf3b8');
  await enc._close();
});

test('isobmff: NAL units inside samples', { skip: !haveSample('h264-aac.mp4') }, async () => {
  const doc = await open('h264-aac.mp4');
  const t = doc.tracks[0];
  const d = await doc.detailAt(t.samples.offsets[0] + 10);
  assert.equal(d.kind, 'sample');
  const kinds = d.units.map((u) => u.kind);
  assert.ok(kinds.includes(6), 'first sample has an SEI (x264 settings)');
  assert.ok(kinds.includes(5), 'first sample has an IDR slice');
  const sei = d.units.find((u) => u.kind === 6);
  assert.match(sei.summary, /x264/);
  const units = d.units.reduce((n, u) => n + u.size, 0);
  assert.equal(units, t.samples.sizes[0], 'NAL units tile the sample');
  // The byte we asked about is attributed to a field.
  assert.ok(d.hit && d.hit.fields.length > 0);
  await doc._close();
});

test('isobmff: sample units for encrypted, E-AC-3, text and timecode tracks', { skip: !haveSample('h264-aac.mov') }, async () => {
  const first = async (name, kind) => {
    const doc = await open(name);
    const t = doc.tracks.find((x) => x.kind === kind || x.fourcc === kind);
    const d = await doc.detailAt(t.samples.offsets[t.samples.count > 1 ? 1 : 0]);
    await doc._close();
    return d.units;
  };
  const enc = await first('h264-cenc.mp4', 'encv');
  assert.ok(enc.every((u) => /encrypted/.test(u.summary)), 'encrypted NAL units are not decoded past their header');
  const ec3 = await first('h264-eac3.mp4', 'ec-3');
  assert.match(ec3[0].summary, /^E-AC-3 independent/);
  const chapters = await first('h264-aac-subs-chapters.mp4', 'text');
  assert.equal(chapters[0].summary, '"Ending"');
  const tc = await first('h264-aac.mov', 'tmcd');
  assert.match(tc[0].summary, /01:00:00:00/);
});
