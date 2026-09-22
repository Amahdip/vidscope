// Transport packets: a fast header reader (for scans and the hex overlay) and
// the full parser that turns one packet into a Node with every field mapped to
// its bytes: header, adaptation field, PES header or PSI sections.

import { Node } from '../../core/model.js';
import { FieldReader, ParseError } from '../../core/fields.js';
import { fmtInt, fmtBitrate } from '../../core/util.js';
import {
  SYNC_BYTE, TS_SIZE, NULL_PID, hexPid, AFC, SCRAMBLING, streamIdName, pesHasOptionalHeader, fixedPidName,
} from './tables.js';
import { bin } from './tables.js';
import { PACKET_DEFS, ADAPTATION_FIELD, PES_HEADER, sectionDef, M2TS_HEADER_DESC } from './defs.js';
import { readSection, sectionLabel } from './psi.js';
import { fmtTs, tsNote, fmtPcrTime } from './text.js';
import { videoKeyInfo } from './es.js';

// ------------------------------------------------------------------ fast paths

/** 90 kHz timestamp from the 5-byte PTS/DTS encoding at u8[q]. */
export function readTimestamp(u8, q) {
  return ((u8[q] >> 1) & 7) * 1073741824 + ((u8[q + 1] << 7) | (u8[q + 2] >> 1)) * 32768 + ((u8[q + 3] << 7) | (u8[q + 4] >> 1));
}

/** 27 MHz clock value from the 6 PCR bytes at u8[q]. */
export function readPcr(u8, q) {
  const base = u8[q] * 33554432 + u8[q + 1] * 131072 + u8[q + 2] * 512 + u8[q + 3] * 2 + (u8[q + 4] >> 7);
  const ext = ((u8[q + 4] & 1) << 8) | u8[q + 5];
  return base * 300 + ext;
}

/**
 * Decode the 4-byte header and adaptation-field flags of the unit at u8[p].
 * Returns { sync, tei, pusi, prio, pid, tsc, afc, cc, ts, end, afLen, payload, disc, rai, pcr, badAf }.
 * `payload` is the index of the first payload byte (end when there is none).
 */
export function tsHeader(u8, p, L) {
  const s = p + L.syncOffset;
  const b1 = u8[s + 1];
  const b3 = u8[s + 3];
  const h = {
    sync: u8[s] === SYNC_BYTE, tei: b1 >> 7, pusi: (b1 >> 6) & 1, prio: (b1 >> 5) & 1, pid: ((b1 & 0x1f) << 8) | u8[s + 2],
    tsc: b3 >> 6, afc: (b3 >> 4) & 3, cc: b3 & 15, ts: s, end: s + TS_SIZE, afLen: -1, payload: s + 4, disc: 0, rai: 0, pcr: -1, badAf: false,
  };
  if (h.afc & 2) {
    const len = u8[s + 4];
    h.afLen = len;
    if (len > 0) {
      const f = u8[s + 5];
      h.disc = f >> 7;
      h.rai = (f >> 6) & 1;
      if (f & 0x10 && len >= 7) h.pcr = readPcr(u8, s + 6);
    }
    h.payload = s + 5 + len;
    if (len > 183 || (h.afc === 3 && len > 182)) {
      h.badAf = true;
      h.payload = h.end;
    }
  }
  if (!(h.afc & 1)) h.payload = h.end;
  return h;
}

/** PES header summary at u8[p] (the payload of a packet with PUSI), or null without a start code. */
export function pesHeader(u8, p, end) {
  if (end - p < 6 || u8[p] !== 0 || u8[p + 1] !== 0 || u8[p + 2] !== 1) return null;
  const sid = u8[p + 3];
  const r = { streamId: sid, length: (u8[p + 4] << 8) | u8[p + 5], hdrEnd: p + 6, pts: -1, dts: -1, align: 0, scrambled: 0, split: false };
  if (!pesHasOptionalHeader(sid)) return r;
  if (end - p < 9) {
    r.split = true;
    r.hdrEnd = end;
    return r;
  }
  r.scrambled = (u8[p + 6] >> 4) & 3;
  r.align = (u8[p + 6] >> 2) & 1;
  const flags = u8[p + 7];
  r.hdrEnd = p + 9 + u8[p + 8];
  if (r.hdrEnd > end) r.split = true;
  const ptsDts = flags >> 6;
  if (ptsDts & 2 && p + 14 <= end) r.pts = readTimestamp(u8, p + 9);
  if (ptsDts === 3 && p + 19 <= end) r.dts = readTimestamp(u8, p + 14);
  return r;
}

// ------------------------------------------------------------------ field helpers

function tsGroup(r, name, prefix, o = {}) {
  let v = 0;
  r.group(name, (g) => {
    r.bits(4, prefix === 2 ? "'0010'" : prefix === 3 ? "'0011'" : "'0001'", { display: bin(4), desc: 'Fixed marker bits that say which timestamp follows.' });
    const a = r.bits(3, `${name}[32..30]`);
    r.bits(1, 'marker_bit', { desc: 'Always 1, so that a timestamp can never imitate a start code (00 00 01).' });
    const b = r.bits(15, `${name}[29..15]`);
    r.bits(1, 'marker_bit');
    const c = r.bits(15, `${name}[14..0]`);
    r.bits(1, 'marker_bit');
    v = a * 1073741824 + b * 32768 + c;
    g.display = fmtTs(v);
    g.note = tsNote(v);
    g.value = v;
  }, o);
  return v;
}

function clockGroup(r, name, o = {}) {
  let v = 0;
  r.group(name, (g) => {
    const base = r.bits(33, name === 'PCR' ? 'program_clock_reference_base' : 'original_program_clock_reference_base', {
      desc: 'The clock in 90 kHz units (the same scale as PTS/DTS).',
    });
    r.bits(6, 'reserved', { reserved: true, display: bin(6) });
    const ext = r.bits(9, name === 'PCR' ? 'program_clock_reference_extension' : 'original_program_clock_reference_extension', {
      desc: 'The 27 MHz remainder (0–299) that refines the base.',
    });
    v = base * 300 + ext;
    g.display = `${fmtPcrTime(v)} (${fmtInt(v)} ticks of 27 MHz)`;
    g.note = `base ${fmtInt(base)} × 300 + extension ${ext} = ${fmtInt(v)}; ÷ 27,000,000 = ${(v / 27e6).toFixed(6)} s`;
    g.value = v;
  }, o);
  return v;
}

// ------------------------------------------------------------------ adaptation field

function parseAdaptationField(r, node, h) {
  const info = {};
  const len = r.u8('adaptation_field_length', {
    role: 'header',
    unit: 'bytes',
    desc: 'Number of bytes of the adaptation field after this byte. 183 when the packet has no payload; with a payload at most 182. Muxers grow it with stuffing to fill the last packet of a PES packet.',
  });
  info.len = len;
  if (len === 0) return info;
  const end = Math.min(r.end, r.pos + len);
  r.bounded(end - r.pos, () => {
    info.disc = r.flag('discontinuity_indicator', {
      desc: '1 = a discontinuity: the continuity counter and/or the PCR time base restart here (a splice or a switch of source). Decoders must not treat the jump as an error.',
    });
    info.rai = r.flag('random_access_indicator', {
      key: true,
      desc: '1 = the next PES packet on this PID starts at a random access point: a key frame for video (with the sequence/parameter headers needed to decode it), a frame start for audio. Segmenters (HLS, DASH) and players that seek rely on it.',
    });
    r.flag('elementary_stream_priority_indicator', { desc: '1 = this payload has higher priority than other packets of the PID (e.g. intra-coded data).' });
    const pcrF = r.flag('PCR_flag', { desc: '1 = a Program Clock Reference follows.' });
    const opcrF = r.flag('OPCR_flag', { desc: '1 = an Original PCR follows (the PCR of the source this stream was copied from).' });
    const spliceF = r.flag('splicing_point_flag', { desc: '1 = splice_countdown follows.' });
    const privF = r.flag('transport_private_data_flag');
    const extF = r.flag('adaptation_field_extension_flag');
    if (pcrF) {
      info.pcr = clockGroup(r, 'PCR', {
        key: true,
        desc: 'Program Clock Reference: the value of the encoder’s 27 MHz system clock at the moment the byte containing the last bit of program_clock_reference_base should arrive at the decoder. Decoders lock their own clock to it. It must arrive at least every 100 ms (DVB: 40 ms).',
      });
    }
    if (opcrF) info.opcr = clockGroup(r, 'OPCR', { desc: 'Original Program Clock Reference, kept when a program is copied from one transport stream into another.' });
    if (spliceF) {
      info.splice = r.i8('splice_countdown', {
        display: (v) => (v > 0 ? `${v} (packets of this PID until a splice point)` : v === 0 ? '0 (splice point: the last byte before it is in this packet)' : `${v} (packets since the splice point)`),
      });
    }
    if (privF) {
      const n = r.u8('transport_private_data_length', { unit: 'bytes' });
      if (n) r.bytes('private_data_byte', n, { desc: 'Private data in the adaptation field (e.g. EBP/timeline markers or DVB-defined data).' });
    }
    if (extF) {
      r.group('adaptation_field_extension', () => {
        const el = r.u8('adaptation_field_extension_length', { unit: 'bytes' });
        r.bounded(el, () => {
          const ltw = r.flag('ltw_flag');
          const pw = r.flag('piecewise_rate_flag');
          const ss = r.flag('seamless_splice_flag');
          const afd = r.flag('af_descriptor_not_present_flag', { desc: 'In recent editions of H.222.0, 0 means adaptation-field descriptors (e.g. timeline/TEMI) follow; older streams set all these bits to 1.' });
          r.bits(4, 'reserved', { reserved: true, display: bin(4) });
          if (ltw) {
            r.flag('ltw_valid_flag');
            r.bits(15, 'ltw_offset', { desc: 'Legal time window offset (for re-multiplexers).' });
          }
          if (pw) {
            r.bits(2, 'reserved', { reserved: true, display: bin(2) });
            r.bits(22, 'piecewise_rate', { display: (v) => `${fmtInt(v)} × 50 bytes/s = ${fmtBitrate(v * 400)}` });
          }
          if (ss) {
            r.bits(4, 'splice_type');
            tsGroup(r, 'DTS_next_AU', 1, { desc: 'Decode time of the first access unit after the splice point.' });
          }
          if (!afd && r.remaining > 0) r.rest('af_descriptors', { desc: 'Adaptation-field descriptors (for example timeline descriptors of TEMI, Annex U).' });
          if (r.remaining > 0) r.rest('reserved', { reserved: true });
        });
      });
    }
    if (r.remaining > 0) {
      const n = r.remaining;
      const allFF = r.u.subarray(r.pos, r.end).every((b) => b === 0xff);
      r.bytes('stuffing_byte', n, {
        display: `${fmtInt(n)} byte${n === 1 ? '' : 's'} of ${allFF ? '0xFF' : 'data (should be 0xFF)'}`,
        desc: 'Padding so that the packet is exactly 188 bytes: the payload was too short to fill it (typically the end of a PES packet).',
      });
      if (!allFF) node.warn('Adaptation field stuffing bytes are not all 0xFF.');
    }
  });
  if (h.badAf) node.warn(`adaptation_field_length ${len} is too large (at most ${h.afc === 2 ? 183 : 182} here): the packet is malformed.`);
  return info;
}

// ------------------------------------------------------------------ PES header

const PTS_DTS = { 0: 'no timestamps', 1: 'forbidden value', 2: 'PTS only', 3: 'PTS and DTS' };

function parsePesHeader(r, node, info) {
  r.u24('packet_start_code_prefix', { role: 'header', display: (v) => `0x${v.toString(16).padStart(6, '0')}`, expect: 1, desc: 'The bytes 00 00 01 that start every PES packet.' });
  const sid = r.u8('stream_id', {
    key: true,
    role: 'header',
    display: (v) => `0x${v.toString(16).toUpperCase()} — ${streamIdName(v)}`,
    desc: 'The kind of stream: 0xE0–0xEF video, 0xC0–0xDF MPEG audio, 0xBD private_stream_1 (AC-3, DTS, subtitles...), 0xFC metadata. The PMT, not the stream_id, is authoritative for the codec.',
  });
  info.streamId = sid;
  const len = r.u16('PES_packet_length', {
    key: true,
    role: 'header',
    display: (v) => (v === 0 ? '0 (unbounded: the packet lasts until the next PES packet starts; allowed for video in transport streams)' : `${fmtInt(v)} bytes follow`),
    desc: 'Bytes in the PES packet after this field. Video frames can be larger than 65,535 bytes, so video often uses 0 (unbounded).',
  });
  info.length = len;
  if (!pesHasOptionalHeader(sid)) {
    info.noHeader = true;
    return;
  }
  r.bits(2, "'10'", { display: bin(2), desc: 'Fixed bits 10 that mark the MPEG-2 PES header syntax.', expect: 2 });
  const sc = r.bits(2, 'PES_scrambling_control', { enum: { 0: 'not scrambled', 1: 'user defined', 2: 'user defined', 3: 'user defined' } });
  if (sc) info.scrambled = sc;
  r.flag('PES_priority');
  info.align = r.flag('data_alignment_indicator', {
    desc: '1 = the payload starts with the kind of unit the data_stream_alignment_descriptor announces (by default a video start code / access unit, or an audio sync word).',
  });
  r.flag('copyright');
  r.flag('original_or_copy', { enum: { 0: 'copy', 1: 'original' } });
  const pd = r.bits(2, 'PTS_DTS_flags', { key: true, enum: PTS_DTS, desc: 'Which timestamps follow. DTS is only sent when it differs from PTS (B-frame reordering).' });
  const escrF = r.flag('ESCR_flag');
  const rateF = r.flag('ES_rate_flag');
  const trickF = r.flag('DSM_trick_mode_flag');
  const copyF = r.flag('additional_copy_info_flag');
  const crcF = r.flag('PES_CRC_flag');
  const extF = r.flag('PES_extension_flag');
  const hdl = r.u8('PES_header_data_length', { unit: 'bytes', desc: 'Bytes of optional fields and stuffing that follow, before the frame data starts.' });
  info.hdl = hdl;
  r.bounded(hdl, () => {
    if (pd & 2) {
      info.pts = tsGroup(r, 'PTS', pd === 3 ? 3 : 2, {
        key: true,
        desc: 'Presentation Time Stamp: when the first frame (access unit) that starts in this PES packet is to be shown or played, on the program’s 90 kHz clock.',
      });
    }
    if (pd === 3) {
      info.dts = tsGroup(r, 'DTS', 1, {
        key: true,
        desc: 'Decode Time Stamp: when that frame must be decoded. Earlier than the PTS for frames that B-frames depend on.',
      });
    }
    if (escrF) {
      r.group('ESCR', (g) => {
        r.bits(2, 'reserved', { reserved: true, display: bin(2) });
        const a = r.bits(3, 'ESCR_base[32..30]');
        r.bits(1, 'marker_bit');
        const b = r.bits(15, 'ESCR_base[29..15]');
        r.bits(1, 'marker_bit');
        const c = r.bits(15, 'ESCR_base[14..0]');
        r.bits(1, 'marker_bit');
        const e = r.bits(9, 'ESCR_extension');
        r.bits(1, 'marker_bit');
        const v = (a * 1073741824 + b * 32768 + c) * 300 + e;
        g.display = `${fmtPcrTime(v)} (27 MHz)`;
      }, { desc: 'Elementary Stream Clock Reference (used in PES streams, rarely in transport streams).' });
    }
    if (rateF) {
      r.bits(1, 'marker_bit');
      r.bits(22, 'ES_rate', { display: (v) => `${fmtInt(v)} × 50 bytes/s = ${fmtBitrate(v * 400)}` });
      r.bits(1, 'marker_bit');
    }
    if (trickF) r.u8('DSM_trick_mode', { display: (v) => `control ${v >> 5}, 0x${(v & 31).toString(16)}`, desc: 'Fast forward / slow motion information for digital storage media.' });
    if (copyF) {
      r.bits(1, 'marker_bit');
      r.bits(7, 'additional_copy_info');
    }
    if (crcF) r.u16('previous_PES_packet_CRC', { display: (v) => `0x${v.toString(16).padStart(4, '0')}` });
    if (extF) {
      r.group('PES_extension', () => {
        const priv = r.flag('PES_private_data_flag');
        const pack = r.flag('pack_header_field_flag');
        const seq = r.flag('program_packet_sequence_counter_flag');
        const pstd = r.flag('P-STD_buffer_flag');
        r.bits(3, 'reserved', { reserved: true, display: bin(3) });
        const ext2 = r.flag('PES_extension_flag_2');
        if (priv) r.bytes('PES_private_data', 16);
        if (pack) {
          const n = r.u8('pack_field_length', { unit: 'bytes' });
          r.bytes('pack_header', n);
        }
        if (seq) {
          r.bits(1, 'marker_bit');
          r.bits(7, 'program_packet_sequence_counter');
          r.bits(1, 'marker_bit');
          r.flag('MPEG1_MPEG2_identifier');
          r.bits(6, 'original_stuff_length');
        }
        if (pstd) {
          r.bits(2, "'01'", { display: bin(2) });
          r.flag('P-STD_buffer_scale', { enum: { 0: '128-byte units', 1: '1024-byte units' } });
          r.bits(13, 'P-STD_buffer_size');
        }
        if (ext2) {
          r.bits(1, 'marker_bit');
          const n = r.bits(7, 'PES_extension_field_length', { unit: 'bytes' });
          if (n) r.bytes('PES_extension_field', n, { desc: 'stream_id_extension and/or TREF fields.' });
        }
      });
    }
    if (r.remaining > 0) {
      const n = r.remaining;
      r.bytes('stuffing_byte', n, { display: `${fmtInt(n)} byte${n === 1 ? '' : 's'} of 0xFF`, desc: 'Padding inside the PES header (encoders may add up to 32 bytes).' });
    }
  });
}

// ------------------------------------------------------------------ packet node

function pidDisplay(pid, role) {
  if (role?.label) return `${hexPid(pid)} (${pid}) — ${role.label}`;
  const fixed = fixedPidName(pid);
  return `${hexPid(pid)} (${pid})${fixed ? ` — ${fixed}` : ' — not described by any table'}`;
}

/**
 * Parse the packet unit at u8[p] (file offset `off`) into a Node.
 * ctx: { L, roleOf(pid), psiCtx, pending: Map (per build), cc: Map (per build), ccErrors?: Set, keyInfo? }
 */
export function buildPacketNode(ctx, u8, p, off, index) {
  const L = ctx.L;
  const S = L.size;
  const node = new Node({ type: 'packet', name: `Packet ${fmtInt(index)}`, kind: 'packet', offset: off, size: S, headerSize: L.syncOffset + 4, category: 'media', def: PACKET_DEFS.pesCont });
  const base = off - p;
  const r = new FieldReader(u8, base, { start: p, end: p + S, out: node.fields });
  const h = tsHeader(u8, p, L);
  const parts = [];
  try {
    if (L.syncOffset === 4) {
      r.group('TP_extra_header', (g) => {
        r.bits(2, 'copy_permission_indicator', { desc: 'Copy control bits of the Blu-ray/AVCHD recording.' });
        const ats = r.bits(30, 'arrival_time_stamp', {
          key: true,
          display: (v) => `${fmtInt(v)} (27 MHz) → ${(v / 27e6).toFixed(6)} s (modulo ${((2 ** 30) / 27e6).toFixed(3)} s)`,
          desc: 'When this packet arrived at the recorder, on a 27 MHz clock that wraps every ~39.8 s. Players use it to feed packets to the decoder at the original pace.',
        });
        g.display = `ATS ${(ats / 27e6).toFixed(6)} s`;
        node.data.ats = ats;
      }, { role: 'header', desc: M2TS_HEADER_DESC });
    }
    const sync = r.u8('sync_byte', {
      role: 'header',
      display: (v) => `0x${v.toString(16).toUpperCase()}${v === SYNC_BYTE ? " ('G')" : ' — should be 0x47!'}`,
      expect: SYNC_BYTE,
      desc: 'Always 0x47. Receivers find packet boundaries by looking for this byte every 188 bytes.',
    });
    if (sync !== SYNC_BYTE) {
      node.def = PACKET_DEFS.noSync;
      node.category = 'unknown';
      node.label = 'no sync byte';
      node.warn(`Expected the sync byte 0x47 here but found 0x${sync.toString(16).padStart(2, '0')}: the stream is not aligned at this position.`);
      return node;
    }
    r.flag('transport_error_indicator', {
      role: 'header',
      desc: 'Set by the demodulator when it could not correct transmission errors in this packet. The content is then unreliable and decoders usually drop it.',
    });
    r.flag('payload_unit_start_indicator', {
      key: true,
      role: 'header',
      desc: '1 = a new PES packet starts at the beginning of this payload, or (for tables) a new section starts somewhere in it and the first payload byte is a pointer_field.',
    });
    r.flag('transport_priority', { role: 'header', desc: 'Priority among packets of the same PID. Rarely used.' });
    const role = ctx.roleOf(h.pid);
    r.bits(13, 'PID', {
      key: true,
      role: 'header',
      display: (v) => pidDisplay(v, role),
      desc: 'Packet identifier: which stream this packet belongs to. 0x0000 is always the PAT, 0x1FFF null packets; the PAT and PMTs say what the other PIDs carry.',
    });
    r.bits(2, 'transport_scrambling_control', {
      role: 'header',
      enum: SCRAMBLING,
      desc: '00 = the payload is in the clear. Other values mean the payload is encrypted (in DVB, 10/11 select the even/odd control word).',
    });
    r.bits(2, 'adaptation_field_control', { role: 'header', enum: AFC, desc: 'Whether an adaptation field and/or a payload follow the header.' });
    r.bits(4, 'continuity_counter', {
      role: 'header',
      desc: 'Counts 0–15 per PID, incrementing on every packet that has a payload. A jump means packets were lost; the same value twice is an allowed duplicate.',
    });

    node.data.pid = h.pid;
    node.data.index = index;
    if (h.tei) node.warn('transport_error_indicator is set: the receiver could not correct errors in this packet, so its content is unreliable.');
    if (h.afc === 0) node.warn('adaptation_field_control is 00 (reserved): decoders discard this packet.');
    checkContinuity(ctx, node, h, off);

    // Adaptation field
    let af = null;
    if (h.afc & 2) {
      const afStart = h.ts + 4;
      const afEnd = Math.min(h.end, afStart + 1 + u8[afStart]);
      const afNode = new Node({ type: 'adaptation_field', name: 'Adaptation Field', kind: 'element', offset: base + afStart, size: afEnd - afStart, headerSize: 1, category: 'header', def: ADAPTATION_FIELD });
      const ar = new FieldReader(u8, base, { start: afStart, end: afEnd, out: afNode.fields });
      try {
        af = parseAdaptationField(ar, afNode, h);
      } catch (e) {
        if (!(e instanceof ParseError)) throw e;
        afNode.warn(e.message);
      }
      const bits = [];
      if (af?.pcr !== undefined) bits.push(`PCR ${fmtPcrTime(af.pcr)}`);
      if (af?.rai) bits.push('random access');
      if (af?.disc) bits.push('discontinuity');
      if (af?.splice !== undefined) bits.push(`splice ${af.splice}`);
      const stuff = afNode.fields.find((f) => f.name === 'stuffing_byte');
      if (stuff) bits.push(`${fmtInt(stuff.size)} stuffing byte${stuff.size === 1 ? '' : 's'}`);
      if (af && af.len > 1 && !bits.length) bits.push(`${af.len} bytes`);
      if (af?.len === 0) bits.push('1 stuffing byte');
      afNode.label = bits.join(' · ');
      afNode.data.summary = afNode.label;
      if (h.badAf) node.warn(afNode.warnings[afNode.warnings.length - 1] ?? 'Invalid adaptation field length.');
      node.add(afNode);
      if (af?.pcr !== undefined) {
        node.data.pcr = af.pcr;
        parts.push(`PCR ${fmtPcrTime(af.pcr)}`);
      }
      if (af?.rai) parts.push('RAI');
      if (af?.disc) parts.push('discontinuity');
    }

    // Payload
    const hasPayload = (h.afc & 1) && h.payload < h.end;
    let what = '';
    if (h.pid === NULL_PID) {
      node.def = PACKET_DEFS.null;
      node.category = 'free';
      what = 'null (stuffing)';
    } else if (!hasPayload) {
      if (h.afc === 2) {
        node.def = PACKET_DEFS.afOnly;
        node.category = 'header';
        what = 'adaptation field only';
      }
    } else if (h.tsc) {
      node.def = PACKET_DEFS.scrambled;
      node.category = 'protect';
      what = `scrambled payload (${SCRAMBLING[h.tsc]})`;
    } else if (role?.psi) {
      what = parsePsiPayload(ctx, node, u8, base, h, role);
    } else if (role?.pes || (!role && h.pusi && u8[h.payload] === 0 && u8[h.payload + 1] === 0 && u8[h.payload + 2] === 1)) {
      what = parsePesPayload(ctx, node, u8, base, h, role);
    } else {
      node.def = role ? PACKET_DEFS.pesCont : PACKET_DEFS.unknown;
      node.category = role ? 'media' : 'unknown';
      what = role ? 'payload' : 'unreferenced PID';
    }

    // Trailing bytes of 204-byte (Reed-Solomon) or 192-byte (trailer) units
    if (L.trailer) {
      const tStart = h.end;
      node.fields.push({
        name: L.size === 204 ? 'reed_solomon_parity' : 'trailer',
        type: 'bytes',
        offset: base + tStart,
        size: L.trailer,
        value: u8.subarray(tStart, tStart + L.trailer),
        display: `${L.trailer} bytes`,
        desc: L.size === 204
          ? '16 bytes of Reed-Solomon RS(204,188) parity (or zero padding) added by the DVB channel coder. Captures from DVB-ASI or broadcast demodulators may keep them; they are not part of the MPEG-2 packet.'
          : '4 bytes stored after the 188-byte packet (a timestamp or checksum of the capture device).',
      });
    }

    const who = `${hexPid(h.pid)}${role?.short && !(what && what.startsWith(role.short)) ? ` ${role.short}` : ''}`;
    node.label = [who, what, ...parts].filter(Boolean).join(' · ');
    node.data.summary = packetSummary(h, role, what, parts);
  } catch (e) {
    if (!(e instanceof ParseError)) throw e;
    node.warn(e.message);
  }
  return node;
}

function packetSummary(h, role, what, parts) {
  const who = role?.label ? `${hexPid(h.pid)} (${role.label})` : hexPid(h.pid);
  return `PID ${who}, CC ${h.cc}${h.pusi ? ', unit start' : ''}: ${what || 'no payload'}${parts.length ? ` · ${parts.join(', ')}` : ''}`;
}

function checkContinuity(ctx, node, h, off) {
  if (h.pid === NULL_PID) return;
  if (ctx.ccErrors && ctx.ccErrors.has(off)) {
    const e = ctx.ccErrors.get(off);
    node.warn(`Continuity counter error: expected ${e.expected}, found ${h.cc}${e.lost ? ` — about ${e.lost} packet${e.lost === 1 ? '' : 's'} of this PID are missing before this one` : ''}.`);
    return;
  }
  if (!ctx.cc) return;
  const last = ctx.cc.get(h.pid);
  const hasPayload = h.afc & 1;
  if (last !== undefined && !h.disc && !(ctx.ccErrors)) {
    if (hasPayload) {
      const expected = (last + 1) & 15;
      if (h.cc !== expected && h.cc !== last) {
        const lost = (h.cc - expected + 16) & 15;
        node.warn(`Continuity counter jumps from ${last} to ${h.cc}: about ${lost} packet${lost === 1 ? '' : 's'} of this PID are missing before this one.`);
      }
    } else if (h.cc !== last) {
      node.warn(`continuity_counter changed (${last} → ${h.cc}) on a packet without payload; it must stay the same.`);
    }
  }
  ctx.cc.set(h.pid, h.cc);
}

// ------------------------------------------------------------------ PSI payload

function parsePsiPayload(ctx, node, u8, base, h, role) {
  node.def = role.kind === 'pat' ? PACKET_DEFS.pat : role.kind === 'pmt' ? PACKET_DEFS.pmt : role.kind === 'scte35' ? PACKET_DEFS.scte35 : role.dvbSi ? PACKET_DEFS.si : PACKET_DEFS.psi;
  node.category = role.kind === 'scte35' ? 'meta' : 'table';
  const r = new FieldReader(u8, base, { start: h.payload, end: h.end, out: node.fields });
  const labels = [];
  let q = h.payload;
  const pending = ctx.pending?.get(h.pid);
  if (h.pusi) {
    const ptr = r.u8('pointer_field', {
      key: true,
      unit: 'bytes',
      display: (v) => (v === 0 ? '0 (a section starts right after this byte)' : `${v} (bytes that end the previous section come first)`),
      desc: 'Present because payload_unit_start_indicator = 1: the number of bytes, after this one, that still belong to a section started in an earlier packet. The first new section starts right after them.',
    });
    q = h.payload + 1;
    if (ptr > 0) {
      const n = Math.min(ptr, h.end - q);
      r.bytes('previous_section_end', n, { desc: 'The last bytes of a section that began in an earlier packet of this PID.' });
      q += n;
    }
  } else {
    // No section starts here: the payload continues a section from an earlier packet.
    const n = pending !== undefined ? Math.min(pending, h.end - q) : h.end - q;
    r.bytes('section_data (continued)', n, {
      desc: 'The next bytes of a section that started in an earlier packet on this PID. No new section can start in a packet without payload_unit_start_indicator.',
      note: pending === undefined ? 'Vidscope has not seen where this section started, so the end of the section is not known here.' : undefined,
    });
    q += n;
    if (pending !== undefined) ctx.pending.set(h.pid, pending - n);
    if (pending !== undefined && pending - n <= 0) ctx.pending.delete(h.pid);
    labels.push('section continued');
  }
  if (h.pusi) ctx.pending?.delete(h.pid);
  let guard = 0;
  while (h.pusi && q < h.end && guard++ < 32) {
    if (u8[q] === 0xff) break;
    const sr = new FieldReader(u8, base, { start: q, end: h.end });
    const secNode = new Node({ type: 'section', name: 'Section', kind: 'element', offset: base + q, size: 0, headerSize: 3, category: 'table' });
    sr.out = secNode.fields;
    let info;
    try {
      info = readSection(sr, ctx.psiCtx ?? {});
    } catch (e) {
      if (!(e instanceof ParseError)) throw e;
      secNode.warn(e.message);
      info = { short: 'section', end: base + h.end, truncated: true };
    }
    const end = Math.max(q + 1, Math.min(h.end, info.end !== undefined ? info.end - base : h.end));
    secNode.size = end - q;
    secNode.type = info.short ?? 'section';
    secNode.def = sectionDef(info.tableId);
    secNode.name = secNode.def.name;
    secNode.category = secNode.def.cat;
    secNode.label = sectionLabel(info);
    secNode.data.summary = info.summary ?? '';
    secNode.data.section = info;
    if (info.crcOk === false) secNode.warn('CRC_32 does not match: receivers discard this section.');
    if (info.error && !info.truncated) secNode.warn(info.error);
    if (info.truncated && ctx.pending && info.end !== undefined) ctx.pending.set(h.pid, info.end - (base + h.end));
    node.add(secNode);
    labels.push(sectionLabel(info));
    q = end;
    if (info.truncated) break;
  }
  if (q < h.end) {
    r.pos = q;
    const n = h.end - q;
    const allFF = u8.subarray(q, h.end).every((b) => b === 0xff);
    r.bytes('stuffing', n, {
      display: `${fmtInt(n)} byte${n === 1 ? '' : 's'}${allFF ? ' of 0xFF' : ''}`,
      desc: 'After the last section, the packet is filled with 0xFF bytes. A table_id of 0xFF tells the receiver that no more sections follow in this packet.',
    });
  }
  return labels.join(' · ');
}

// ------------------------------------------------------------------ PES payload

/** "frame 12" or "frames 12–13": which frames the payload bytes [a, b] belong to (after the full scan). */
function framesIn(ctx, role, a, b) {
  const t = role?.track;
  if (!t || !ctx.frameIndex) return null;
  const i = ctx.frameIndex(t, a);
  const j = ctx.frameIndex(t, b);
  const noun = t.framing || t.kind === 'video' ? 'frame' : 'sample';
  if (i >= 0 && j > i) return `${noun}s ${fmtInt(i + 1)}–${fmtInt(j + 1)}`;
  if (i >= 0) return `${noun} ${fmtInt(i + 1)}`;
  if (j >= 0) return `${noun} ${fmtInt(j + 1)}`;
  return null;
}

function parsePesPayload(ctx, node, u8, base, h, role) {
  node.def = PACKET_DEFS.pesCont;
  node.category = role?.category ?? 'media';
  if (!role) node.def = PACKET_DEFS.unknown;
  if (!h.pusi) {
    const which = framesIn(ctx, role, base + h.payload, base + h.end - 1);
    return which ? `PES data · ${which}` : 'PES data';
  }
  node.def = role ? PACKET_DEFS.pesStart : PACKET_DEFS.unknown;
  const q = h.payload;
  if (!(u8[q] === 0 && u8[q + 1] === 0 && u8[q + 2] === 1)) {
    node.warn('payload_unit_start_indicator is set, but the payload does not begin with a PES start code (00 00 01).');
    return 'no PES start code';
  }
  const optional = pesHasOptionalHeader(u8[q + 3]);
  const hdrNeed = optional && q + 9 <= h.end ? 9 + u8[q + 8] : 6;
  const split = optional && (q + 9 > h.end || q + hdrNeed > h.end);
  const end = Math.min(h.end, q + hdrNeed);
  const pn = new Node({ type: 'PES_header', name: 'PES Packet Header', kind: 'element', offset: base + q, size: end - q, headerSize: 6, category: 'header', def: PES_HEADER });
  const pr = new FieldReader(u8, base, { start: q, end, out: pn.fields });
  const info = {};
  try {
    parsePesHeader(pr, pn, info);
  } catch (e) {
    if (!(e instanceof ParseError)) throw e;
    pn.warn(split ? 'The PES header continues in the next packet of this PID (the adaptation field left too little room).' : e.message);
  }
  const bits = [];
  if (info.pts !== undefined) bits.push(`PTS ${fmtTs(info.pts).split(' → ')[1]}`);
  if (info.dts !== undefined) bits.push(`DTS ${fmtTs(info.dts).split(' → ')[1]}`);
  pn.label = `${streamIdName(info.streamId ?? u8[q + 3]).split(' (')[0]}${bits.length ? ` · ${bits.join(' · ')}` : ''}`;
  pn.data.summary = pn.label;
  node.add(pn);
  node.data.pes = info;
  let what = `PES start${bits.length ? ` · ${bits.join(' · ')}` : ''}`;
  const which = end < h.end ? framesIn(ctx, role, base + end, base + h.end - 1) : null;
  if (which) what = `PES start · ${which}${bits.length ? ` · ${bits.join(' · ')}` : ''}`;
  // Is it a key frame? Look at the first bytes of the frame in this packet.
  if (role?.kind === 'video' && end < h.end && !info.scrambled) {
    const keyName = role.family === 'avc' ? 'IDR' : role.family === 'hevc' ? 'IRAP' : role.family === 'mpeg2v' ? 'I-picture' : 'key frame';
    const known = ctx.frameKey?.(role.track, base + end);
    if (known === 1) what += ` · key frame (${keyName})`;
    else if (known === undefined && role.family) {
      const k = videoKeyInfo(role.family, u8, end, h.end);
      if (k.found && k.key) what += ` · key frame (${keyName})`;
      else if (k.recovery) what += ' · recovery point';
    }
  }
  return what;
}

