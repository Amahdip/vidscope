// MPEG-TS: compare Vidscope's frames with FFmpeg's demuxer (offsets, sizes,
// timestamps, key flags), and check the packet tree, tables, details and insights.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { open, sample, haveSample, haveFfprobe, probeStreams, probePackets, checkInvariants } from './helpers.mjs';
import { openDocument } from '../web/formats/index.js';
import { BytesSource } from '../web/core/source.js';
import { ensureChildren, walk } from '../web/core/model.js';
import { findField } from '../web/core/fields.js';
import { crc32 } from '../web/formats/mpegts/psi.js';

const FILES = ['h264-aac.ts', 'hevc-ac3.ts', 'mpegts-h264-aac.m2ts', 'mpegts-mpeg2-mp2-cbr.ts', 'mpegts-2programs-dvb.ts', 'mpegts-20-audio-langs.ts', 'mpegts-h264-aac-latm.ts'];

/** Frames of streams whose PTS FFmpeg interpolates may differ by a few ticks (it truncates frame durations). */
const INTERPOLATION_TOLERANCE = 8;

async function openBytes(bytes, name = 'synthetic.ts') {
  const doc = await openDocument(new BytesSource(bytes, name));
  return doc;
}

/** Expand a few groups (first, middle, last) and return the packets created. */
async function expandSome(doc) {
  const groups = doc.root.children.filter((n) => n.type === 'packets');
  const pick = [...new Set([groups[0], groups[Math.floor(groups.length / 2)], groups[groups.length - 1]])].filter(Boolean);
  const packets = [];
  for (const g of pick) {
    await ensureChildren(g);
    for (const c of g.children ?? []) if (c.type === 'packet') packets.push(c);
  }
  return { groups: pick, packets };
}

for (const name of FILES) {
  test(`mpegts: ${name}`, { skip: !haveSample(name) && 'run npm run samples (and see the mpegts-* commands in the report)' }, async () => {
    const doc = await open(name);
    try {
      assert.equal(doc.format.id, 'mpegts');
      const L = doc.layout;
      assert.equal(doc.summary.unitCount, Math.floor((doc.size - L.first) / L.size), 'unitCount = packets in the file');
      assert.equal(L.size, name.endsWith('.m2ts') ? 192 : 188);
      assert.deepEqual(checkInvariants(doc), [], 'invariants at open');

      // Tree: expanding groups creates one node per packet, all valid.
      const { groups, packets } = await expandSome(doc);
      assert.deepEqual(checkInvariants(doc), [], 'invariants after expanding groups');
      for (const g of groups) {
        const n = g.data.lastIndex - g.data.firstIndex + 1;
        assert.equal(g.children.filter((c) => c.type === 'packet').length, n, `${g.name}: one node per packet`);
      }
      const failures = [];
      for (const p of packets) {
        for (const n of walk(p)) for (const w of n.warnings) if (/Not enough data|internal|could not/i.test(w)) failures.push(`${n.type}@${n.offset}: ${w}`);
        assert.equal(findField(p.fields, 'sync_byte').value, 0x47);
      }
      assert.deepEqual(failures, []);
      // Every table section in the expanded packets has a valid CRC.
      for (const p of packets) {
        for (const c of p.children ?? []) {
          if (c.data.section?.crcOk !== undefined) assert.ok(c.data.section.crcOk, `${c.type}@${c.offset}: CRC`);
        }
      }

      if (!haveFfprobe()) return;
      const probe = probeStreams(name);
      assert.equal(doc.tracks.length, probe.streams.length, 'one track per elementary stream');
      await doc.loadSamples();
      const packetsFf = probePackets(name);
      for (const st of probe.streams) {
        const pid = parseInt(st.id, 16);
        const t = doc.tracks.find((x) => x.pid === pid);
        assert.ok(t, `track for PID ${st.id}`);
        assert.equal(t.kind, st.codec_type === 'subtitle' ? 'subtitle' : st.codec_type, `${t.label}: kind`);
        const theirs = packetsFf.filter((p) => p.stream === st.index);
        const s = t.samples;
        assert.equal(s.count, theirs.length, `${t.label}: frame count`);
        for (let i = 0; i < s.count; i++) {
          const p = theirs[i];
          assert.equal(s.sizes[i], p.size, `${t.label} frame ${i}: size`);
          const tol = s.firstInPes[i] ? 0 : INTERPOLATION_TOLERANCE;
          assert.ok(Math.abs(s.pts[i] - p.pts) <= tol, `${t.label} frame ${i}: pts ${s.pts[i]} vs ${p.pts}`);
          assert.ok(Math.abs(s.dts[i] - p.dts) <= tol, `${t.label} frame ${i}: dts ${s.dts[i]} vs ${p.dts}`);
          assert.equal(s.dts[i] + (s.cto ? s.cto[i] : 0), s.pts[i], `${t.label} frame ${i}: dts + cto = pts`);
          if (t.kind === 'video') assert.equal(!!s.key[i], p.key, `${t.label} frame ${i}: key frame`);
          // FFmpeg reports the position of the packet where the PES packet starts, for the first frame of each PES packet.
          if (p.pos !== null) {
            assert.equal(s.firstInPes[i], 1, `${t.label} frame ${i}: first frame of its PES packet`);
            assert.equal(t.pes.offsets[s.pesIndex[i]], p.pos, `${t.label} frame ${i}: PES position`);
          } else {
            assert.equal(s.firstInPes[i], 0, `${t.label} frame ${i}: not the first frame of its PES packet`);
          }
          assert.ok(s.ends[i] > s.offsets[i] && s.ends[i] - s.offsets[i] >= s.sizes[i], `${t.label} frame ${i}: byte span`);
        }
        if (st.codec_type === 'video' && st.width && t.sps) {
          assert.equal(t.sps.width, st.width, `${t.label}: width`);
          assert.equal(t.sps.height, st.height, `${t.label}: height`);
        }
      }
      assert.deepEqual(checkInvariants(doc), []);
      assert.equal(doc.stats.ccErrorCount, 0);
      assert.equal(doc.stats.syncLosses.length, 0);
    } finally {
      await doc._close();
    }
  });
}

test('mpegts: codec details and tables', { skip: !haveSample('mpegts-2programs-dvb.ts') && 'samples missing' }, async () => {
  const a = await open('h264-aac.ts');
  assert.equal(a.tracks[0].codecString, 'avc1.64001E');
  assert.equal(a.tracks[0].sps.width, 640);
  assert.equal(a.tracks[0].sps.height, 360);
  assert.equal(a.tracks[0].sampleCfg.annexB, true);
  assert.equal(a.tracks[1].codecString, 'mp4a.40.2');
  assert.equal(a.tracks[1].sampleCfg.adts, true);
  assert.equal(a.model.programs.get(1).pcrPid, 0x100);
  assert.equal(a.model.sdt.services[0].name, 'Service01');
  assert.equal(a.model.sdt.services[0].provider, 'FFmpeg');
  assert.ok(a.tracks[0].props.some(([k, v]) => k === 'program' && v.includes('Service01')));
  await a._close();

  const h = await open('hevc-ac3.ts');
  assert.equal(h.tracks[0].codec, 'hevc');
  assert.match(h.tracks[0].codecString, /^hvc1\.1\.6\.L\d+/);
  assert.equal(h.tracks[1].codec, 'ac3');
  assert.equal(h.tracks[1].streamType, 0x81);
  assert.ok(h.tracks[1].descriptors.some((d) => d.tag === 0x05 && d.format === 'AC-3'), 'registration AC-3');
  await h._close();

  const m = await open('mpegts-mpeg2-mp2-cbr.ts');
  assert.equal(m.tracks[0].codec, 'mpeg2video');
  assert.equal(m.tracks[0].config.width, 640);
  assert.equal(m.tracks[1].codec, 'mp2');
  assert.equal(m.tracks[1].language, 'eng');
  await m._close();

  const d = await open('mpegts-2programs-dvb.ts');
  assert.equal(d.model.programs.size, 2);
  const [v1, a1, v2, a2] = d.tracks;
  assert.equal(a1.codec, 'eac3', 'stream_type 0x06 resolved by the enhanced AC-3 descriptor');
  assert.match(a1.how, /0x7A/);
  assert.equal(a2.codec, 'ac3', 'stream_type 0x06 resolved by the AC-3 descriptor');
  assert.equal(a1.language, 'eng');
  assert.equal(a2.language, 'fra');
  assert.equal(v1.program, 1);
  assert.equal(v2.program, 2);
  assert.deepEqual(d.model.sdt.services.map((s) => s.name), ['First', 'Second']);
  await d._close();

  if (haveSample('mpegts-h264-aac-latm.ts')) {
    const l = await open('mpegts-h264-aac-latm.ts');
    assert.equal(l.tracks[1].codec, 'aac_latm');
    assert.equal(l.tracks[1].codecString, 'mp4a.40.2', 'AudioSpecificConfig read from the LATM StreamMuxConfig');
    assert.equal(l.tracks[1].config.sampleRate, 44100);
    await l._close();
  }

  const b = await open('mpegts-h264-aac.m2ts');
  assert.equal(b.summary.label, 'M2TS / BDAV (192-byte packets)');
  assert.equal(b.tracks[1].codec, 'aac', 'AAC with stream_type 0x06 and no descriptor is recognised from the payload');
  assert.match(b.tracks[1].how, /payload/);
  const { packets } = await expandSome(b);
  const ats = findField(packets[0].fields, 'arrival_time_stamp');
  assert.ok(ats && ats.size === 4 && ats.offset === packets[0].offset, 'TP_extra_header is decoded');
  await b._close();
});

test('mpegts: packet fields map to their bytes', { skip: !haveSample('h264-aac.ts') }, async () => {
  const doc = await open('h264-aac.ts');
  const { packets } = await expandSome(doc);
  // Packet 3 is the first video packet: PCR in the adaptation field, PES header with PTS and DTS.
  const p = packets[3];
  assert.equal(findField(p.fields, 'PID').value, 0x100);
  assert.equal(findField(p.fields, 'payload_unit_start_indicator').value, 1);
  const af = p.children.find((c) => c.type === 'adaptation_field');
  assert.ok(af, 'adaptation field node');
  assert.equal(findField(af.fields, 'random_access_indicator').value, 1);
  const pcr = findField(af.fields, 'PCR');
  assert.equal(pcr.value, 63000 * 300);
  const pes = p.children.find((c) => c.type === 'PES_header');
  assert.ok(pes, 'PES header node');
  assert.equal(findField(pes.fields, 'stream_id').value, 0xe0);
  assert.equal(findField(pes.fields, 'PTS').value, 133200);
  assert.equal(findField(pes.fields, 'DTS').value, 126000);
  assert.equal(pes.offset, af.end, 'PES header follows the adaptation field');
  // PAT and PMT sections
  const pat = packets[1].children.find((c) => c.type === 'PAT');
  assert.equal(pat.data.section.programs[0].pid, 0x1000);
  const pmt = packets[2].children.find((c) => c.type === 'PMT');
  assert.deepEqual(pmt.data.section.streams.map((s) => [s.type, s.pid]), [[0x1b, 0x100], [0x0f, 0x101]]);
  assert.equal(findField(pmt.fields, 'CRC_32').mismatch, undefined);
  await doc._close();
});

test('mpegts: frame details and hex overlay', { skip: !haveSample('h264-aac.ts') }, async () => {
  const doc = await open('h264-aac.ts');
  await doc.loadSamples();
  const v = doc.tracks[0];
  const s = v.samples;
  const d = await doc.detailAt(s.offsets[0] + 10);
  assert.equal(d.kind, 'sample');
  const kinds = d.units.map((u) => u.kind);
  assert.ok(kinds.includes(9), 'access unit delimiter');
  assert.ok(kinds.includes(7) && kinds.includes(8), 'SPS and PPS in the key frame');
  assert.ok(kinds.includes(5), 'IDR slice');
  assert.match(d.units.find((u) => u.kind === 6).summary, /x264/);
  assert.equal(d.units.reduce((n, u) => n + u.esSize, 0), s.sizes[0], 'NAL units tile the reassembled frame');
  assert.ok(d.hit && d.hit.fields.length > 0, 'the byte is attributed to a field');
  // Units are mapped back to file offsets: the IDR slice spans many packets.
  const idr = d.units.find((u) => u.kind === 5);
  assert.ok(idr.size > idr.esSize, 'file span of a unit includes the packet headers in between');
  assert.equal(d.units[d.units.length - 1].offset + d.units[d.units.length - 1].size, s.ends[0]);

  // An audio frame that is not the first of its PES packet.
  const a = doc.tracks[1];
  const k = Array.from(a.samples.firstInPes).indexOf(0);
  const ad = await doc.detailAt(a.samples.offsets[k]);
  assert.equal(ad.units[0].title, 'ADTS frame');
  assert.ok(ad.rows.some(([key, val]) => key === 'PTS' && /interpolated/.test(val)));

  // Header bytes describe the packet.
  const pd = await doc.detailAt(564 + 1);
  assert.equal(pd.kind, 'packet');

  // Overlay: runs lie inside payloads and inside their frames.
  await doc.source.read(0, 64 * 1024);
  const runs = doc.overlay(0, 64 * 1024);
  assert.ok(runs.length > 10);
  for (const r of runs) {
    const t = doc.tracks[r.track];
    assert.ok(r.start >= t.samples.offsets[r.sample] && r.end <= t.samples.ends[r.sample], 'run inside its frame');
    const inPacket = (r.start - doc.layout.first) % doc.layout.size;
    assert.ok(inPacket >= 4, 'runs never cover a packet header');
    assert.ok(Math.floor((r.start - doc.layout.first) / 188) === Math.floor((r.end - 1 - doc.layout.first) / 188), 'runs stay within one packet');
  }
  await doc._close();
});

test('mpegts: insights and glossary', { skip: !haveSample('mpegts-mpeg2-mp2-cbr.ts') }, async () => {
  const cbr = await open('mpegts-mpeg2-mp2-cbr.ts');
  const before = await cbr.insights();
  assert.ok(before.some((i) => i.title === 'Full scan pending'));
  await cbr.loadSamples();
  const ins = await cbr.insights();
  assert.ok(ins.some((i) => i.group === 'Layout' && /null packets/.test(i.title) && i.level === 'warn'), 'null packet overhead');
  assert.ok(ins.some((i) => /^Constant bitrate multiplex/.test(i.title)), 'CBR detected');
  assert.ok(ins.some((i) => /^PCR every/.test(i.title) && i.level === 'good'), 'PCR every 20 ms is within 40 ms');
  assert.ok(ins.some((i) => /^PAT every/.test(i.title)));
  assert.ok(ins.some((i) => /continuity/.test(i.title) && i.level === 'good'));
  for (const i of ins) {
    assert.ok(['good', 'info', 'warn', 'bad'].includes(i.level));
    assert.ok(i.title && i.group);
  }
  await cbr._close();

  const a = await open('h264-aac.ts');
  await a.loadSamples();
  const ai = await a.insights();
  assert.ok(ai.some((i) => /^PCR every 80 ms/.test(i.title) && i.level === 'warn'), 'FFmpeg VBR output sends a PCR every 80 ms: above the DVB 40 ms');
  assert.ok(ai.some((i) => /^Audio starts \d+ ms before video/.test(i.title)));
  const terms = a.glossary().map((g) => g.term);
  for (const t of ['TS packet', 'sync byte', 'PID', 'PUSI', 'adaptation field', 'PCR', 'PES', 'PTS', 'DTS', 'PSI', 'PAT', 'PMT', 'SDT', 'continuity counter', 'null packet', 'stream_type', 'M2TS']) {
    assert.ok(terms.includes(t), `glossary has ${t}`);
  }
  await a._close();
});

test('mpegts: 204-byte packets and files that start mid-packet', { skip: !haveSample('h264-aac.ts') }, async () => {
  const src = new Uint8Array(fs.readFileSync(sample('h264-aac.ts')));
  const ref = await openBytes(src, 'ref.ts');
  await ref.loadSamples();
  const n = src.length / 188;

  const v204 = new Uint8Array(n * 204);
  for (let i = 0; i < n; i++) v204.set(src.subarray(i * 188, i * 188 + 188), i * 204);
  const d204 = await openBytes(v204, 'rs.ts');
  assert.equal(d204.format.id, 'mpegts');
  assert.equal(d204.layout.size, 204);
  assert.equal(d204.summary.unitCount, n);
  await d204.loadSamples();
  for (const [ti, t] of d204.tracks.entries()) {
    const r = ref.tracks[ti].samples;
    assert.equal(t.samples.count, r.count, `${t.label}: frames with 204-byte packets`);
    assert.deepEqual(Array.from(t.samples.sizes), Array.from(r.sizes));
    assert.deepEqual(Array.from(t.samples.pts), Array.from(r.pts));
  }
  const { packets } = await expandSome(d204);
  assert.equal(packets[0].size, 204);
  assert.ok(findField(packets[0].fields, 'reed_solomon_parity'));
  assert.deepEqual(checkInvariants(d204), []);

  // Cut 1,000 bytes: the file now starts inside packet 5.
  const mid = src.slice(1000);
  const dm = await openBytes(mid, 'mid.ts');
  assert.equal(dm.format.id, 'mpegts');
  assert.equal(dm.layout.first, 188 * 6 - 1000);
  assert.equal(dm.root.children[0].type, 'partial packet');
  await dm.loadSamples();
  const va = ref.tracks[0].samples;
  const vb = dm.tracks[0].samples;
  assert.equal(vb.count, va.count - 1, 'the first video frame (cut) is dropped');
  assert.equal(vb.offsets[0] + 1000, va.offsets[1], 'offsets shift with the cut');
  assert.equal(dm.tracks[1].samples.count, ref.tracks[1].samples.count);
  assert.ok((await dm.insights()).some((i) => /middle of a packet/.test(i.title)));
});

test('mpegts: damaged streams are reported, never fatal', { skip: !haveSample('h264-aac.ts') }, async () => {
  const src = new Uint8Array(fs.readFileSync(sample('h264-aac.ts')));
  // Drop packet 10 (video, CC 7): a continuity error on PID 0x100.
  const drop = new Uint8Array(src.length - 188);
  drop.set(src.subarray(0, 188 * 10));
  drop.set(src.subarray(188 * 11), 188 * 10);
  const d = await openBytes(drop, 'drop.ts');
  await d.loadSamples();
  assert.equal(d.stats.ccErrorCount, 1);
  const cc = [...d.stats.ccErrors.values()][0];
  assert.deepEqual([cc.pid, cc.expected, cc.got, cc.lost], [0x100, 7, 8, 1]);
  const ins = await d.insights();
  assert.ok(ins.some((i) => i.level === 'bad' && /continuity counter error/.test(i.title)));
  const { packets } = await expandSome(d);
  assert.ok(packets[10].warnings.some((w) => /Continuity counter error/.test(w)), 'the packet after the gap is flagged in the tree');

  // 77 bytes of garbage in the middle: sync loss, resync, and the rest still parses.
  const ins2 = new Uint8Array(src.length + 77);
  ins2.set(src.subarray(0, 188 * 500 + 30));
  ins2.fill(0x11, 188 * 500 + 30, 188 * 500 + 107);
  ins2.set(src.subarray(188 * 500 + 30), 188 * 500 + 107);
  const g = await openBytes(ins2, 'garbage.ts');
  await g.loadSamples();
  assert.equal(g.stats.syncLosses.length, 1);
  assert.equal(g.stats.lostBytes, 77, 'exactly the inserted bytes are skipped');
  assert.equal(g.tracks[0].samples.count, 100);
  const gi = await g.insights();
  assert.ok(gi.some((i) => i.level === 'bad' && /Lost packet sync/.test(i.title)));
  for (const n of g.root.children) await ensureChildren(n);
  assert.deepEqual(checkInvariants(g), []);
  assert.ok([...walk(g.root)].some((n) => n.type === 'unsynced bytes'), 'the damaged bytes are shown as a region');

  // Two recordings joined byte for byte: the PMT changes without a new version, clocks restart.
  const b2 = new Uint8Array(fs.readFileSync(sample('hevc-ac3.ts')));
  const joined = new Uint8Array(src.length + b2.length);
  joined.set(src);
  joined.set(b2, src.length);
  const j = await openBytes(joined, 'joined.ts');
  await j.loadSamples();
  const ji = await j.insights();
  assert.ok(ji.some((i) => i.level === 'bad' && /without a new version_number/.test(i.title)), 'silent PMT change');
  assert.ok(ji.some((i) => /PCR discontinuities/.test(i.title)), 'PCR jump');
  assert.ok(ji.some((i) => /Timestamps jump/.test(i.title)), 'PTS/DTS jump');
  assert.ok(j.stats.ccErrorCount > 0);
  assert.ok(Math.abs(j.summary.duration - 8) < 0.05, 'duration sums both parts');

  // Random bit flips: whatever happens, opening and scanning must not throw.
  let seed = 12345;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (let k = 0; k < 8; k++) {
    const c = src.slice();
    for (let i = 0; i < 300; i++) c[Math.floor(rnd() * c.length)] ^= 1 << Math.floor(rnd() * 8);
    const doc = await openBytes(c, `flip${k}.ts`);
    await doc.loadSamples();
    for (const n of doc.root.children) await ensureChildren(n);
    await doc.insights();
    await doc.detailAt(Math.floor(rnd() * c.length));
    assert.deepEqual(checkInvariants(doc), []);
  }
});

test('mpegts: probe', { skip: !haveSample('h264-aac.mp4') || !haveSample('h264-aac.ts') }, async () => {
  const mpegts = (await import('../web/formats/mpegts/index.js')).default;
  const ts = new Uint8Array(fs.readFileSync(sample('h264-aac.ts'))).subarray(0, 65536);
  const mp4 = new Uint8Array(fs.readFileSync(sample('h264-aac.mp4'))).subarray(0, 65536);
  assert.ok(mpegts.probe(ts, { size: 435784 }) >= 90);
  assert.equal(mpegts.probe(mp4, { size: 402114 }), 0);
  assert.equal(mpegts.probe(new Uint8Array(0), { size: 0 }), 0);
});

test('mpegts: sections longer than one packet', { skip: !haveSample('mpegts-20-audio-langs.ts') }, async () => {
  const doc = await open('mpegts-20-audio-langs.ts');
  assert.equal(doc.tracks.length, 21);
  assert.deepEqual(doc.tracks.slice(1, 4).map((t) => t.language), ['eng', 'fra', 'deu']);
  const { packets } = await expandSome(doc);
  // Packet 2 starts the PMT (241 bytes), packet 3 carries its last 58 bytes, then stuffing.
  const first = packets[2].children.find((c) => c.type === 'PMT');
  assert.ok(first.data.section.truncated);
  assert.equal(first.end, packets[2].end);
  const cont = findField(packets[3].fields, 'section_data (continued)');
  assert.equal(cont.size, 241 - 183);
  assert.equal(findField(packets[3].fields, 'stuffing').size, 184 - 58);
  // The detail of a byte in the second packet is the whole reassembled section, fields at file offsets.
  const d = await doc.detailAt(packets[3].offset + 10);
  assert.equal(d.kind, 'section');
  assert.ok(d.rows.some(([k, v]) => k === 'CRC_32' && v === 'valid'));
  assert.ok(d.rows.some(([k, v]) => k === 'length' && /2 packets/.test(v)));
  const crc = findField(d.units[0].fields, 'CRC_32');
  assert.ok(crc.offset > packets[3].offset && crc.offset + 4 <= packets[3].end, 'CRC_32 lies in the second packet');
  assert.ok(d.hit.fields.length > 0);
  await doc._close();
});

/** h264-aac.ts with an SCTE-35 PID added to the PMT and two splice_insert packets. */
function withScte35(src) {
  const section = (bytes) => {
    const out = Uint8Array.from([...bytes, 0, 0, 0, 0]);
    const c = crc32(out, 0, out.length - 4);
    out.set([c >>> 24, (c >>> 16) & 255, (c >>> 8) & 255, c & 255], out.length - 4);
    return out;
  };
  const packet = (pid, cc, sec) => {
    const p = new Uint8Array(188).fill(0xff);
    p.set([0x47, 0x40 | (pid >> 8), pid & 255, 0x10 | cc, 0x00]);
    p.set(sec, 5);
    return p;
  };
  // PMT: registration 'CUEI' in program_info, then H.264, AAC and SCTE-35 (0x86) on PID 0x1F0.
  const pmt = section([0x02, 0xb0, 34, 0x00, 0x01, 0xc1, 0x00, 0x00, 0xe1, 0x00, 0xf0, 0x06, 0x05, 0x04, 0x43, 0x55, 0x45, 0x49,
    0x1b, 0xe1, 0x00, 0xf0, 0x00, 0x0f, 0xe1, 0x01, 0xf0, 0x00, 0x86, 0xe1, 0xf0, 0xf0, 0x00]);
  // splice_insert #42: out of network at PTS 270000 (3 s) for 2,700,000 ticks (30 s).
  const cue = section([0xfc, 0x30, 37, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff, 0xff, 0xf0, 0x14, 0x05,
    0x00, 0x00, 0x00, 0x2a, 0x7f, 0xef, 0xfe, 0x00, 0x04, 0x1e, 0xb0, 0xfe, 0x00, 0x29, 0x32, 0xe0, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00]);
  const out = [];
  const n = src.length / 188;
  let cc = 0;
  for (let i = 0; i < n; i++) {
    const p = src.slice(i * 188, i * 188 + 188);
    const pid = ((p[1] & 0x1f) << 8) | p[2];
    if (pid === 0x1000 && p[1] & 0x40) {
      p.fill(0xff, 5);
      p[4] = 0;
      p.set(pmt, 5);
    }
    out.push(p);
    if (i === 50 || i === 1000) out.push(packet(0x1f0, cc++, cue));
  }
  const bytes = new Uint8Array(out.length * 188);
  out.forEach((p, i) => bytes.set(p, i * 188));
  return bytes;
}

test('mpegts: SCTE-35 cues', { skip: !haveSample('h264-aac.ts') }, async () => {
  const bytes = withScte35(new Uint8Array(fs.readFileSync(sample('h264-aac.ts'))));
  const doc = await openBytes(bytes, 'scte35.ts');
  const t = doc.tracks.find((x) => x.pid === 0x1f0);
  assert.ok(t, 'SCTE-35 track');
  assert.equal(t.codec, 'scte_35');
  assert.equal(t.kind, 'data');
  assert.ok(t.sections);
  await doc.loadSamples();
  assert.equal(t.samples.count, 2, 'one sample per splice_info_section');
  assert.equal(t.samples.sizes[0], 40);
  const cue = doc.model.scte35[0].info;
  assert.equal(cue.commandName, 'splice_insert');
  assert.equal(cue.eventId, 42);
  assert.equal(cue.outOfNetwork, 1);
  assert.equal(cue.spliceTime, 270000);
  assert.equal(cue.breakDuration, 2700000);
  assert.equal(cue.crcOk, true);
  const ins = await doc.insights();
  assert.ok(ins.some((i) => /2 SCTE-35 cue messages/.test(i.title)));
  const { packets } = await expandSome(doc);
  const node = packets[51].children.find((c) => c.type === 'SCTE-35');
  assert.ok(node, 'SCTE-35 section node');
  assert.match(node.label, /splice_insert #42 \(break start\)/);
  assert.equal(packets[51].category, 'meta');
  assert.deepEqual(checkInvariants(doc), []);
  // The video and audio frames are unaffected.
  assert.equal(doc.tracks[0].samples.count, 100);
  assert.equal(doc.tracks[1].samples.count, 189);
});
