// MPEG-4 Part 2 Visual (ISO/IEC 14496-2): the start-code delimited headers found
// in DivX / Xvid / FFmpeg "FMP4" frames in AVI files. Only the headers are
// decoded (VOS, VO, VOL up to the picture size, GOV, VOP type and timing,
// user data); the macroblock data needs a full decoder. Used by the AVI parser.

import { FieldReader, ParseError } from '../core/fields.js';
import { decodeText, fmtInt, HEX2 } from '../core/util.js';

export const VOP_TYPES = { 0: 'I', 1: 'P', 2: 'B', 3: 'S (sprite / GMC)' };

const PROFILE_LEVELS = {
  0x01: 'Simple Profile @ Level 1', 0x02: 'Simple Profile @ Level 2', 0x03: 'Simple Profile @ Level 3',
  0x04: 'Simple Profile @ Level 4a', 0x05: 'Simple Profile @ Level 5', 0x06: 'Simple Profile @ Level 6',
  0x08: 'Simple Profile @ Level 0', 0x09: 'Simple Profile @ Level 0b',
  0x11: 'Simple Scalable @ Level 1', 0x12: 'Simple Scalable @ Level 2',
  0x21: 'Core Profile @ Level 1', 0x22: 'Core Profile @ Level 2',
  0x32: 'Main Profile @ Level 2', 0x33: 'Main Profile @ Level 3', 0x34: 'Main Profile @ Level 4',
  0xf0: 'Advanced Simple @ Level 0', 0xf1: 'Advanced Simple @ Level 1', 0xf2: 'Advanced Simple @ Level 2',
  0xf3: 'Advanced Simple @ Level 3', 0xf4: 'Advanced Simple @ Level 4', 0xf5: 'Advanced Simple @ Level 5',
  0xf7: 'Advanced Simple @ Level 3b',
};

const ASPECT = { 1: '1:1 (square)', 2: '12:11 (625-line 4:3)', 3: '10:11 (525-line 4:3)', 4: '16:11 (625-line 16:9)', 5: '40:33 (525-line 16:9)', 15: 'extended (par_width:par_height follow)' };

function codeName(c) {
  if (c <= 0x1f) return 'video object';
  if (c <= 0x2f) return 'VOL';
  switch (c) {
    case 0xb0: return 'VOS';
    case 0xb1: return 'VOS end';
    case 0xb2: return 'user data';
    case 0xb3: return 'GOV';
    case 0xb5: return 'visual object';
    case 0xb6: return 'VOP';
    case 0xc3: return 'stuffing';
    default: return `start code 0x${HEX2[c]}`;
  }
}

/** Split [start, end) on 00 00 01 start codes. */
export function splitStartCodes(u8, start, end) {
  const out = [];
  let cur = null;
  for (let i = start; i + 3 < end; i++) {
    if (u8[i] === 0 && u8[i + 1] === 0 && u8[i + 2] === 1) {
      if (cur) {
        cur.end = i;
        out.push(cur);
      }
      cur = { start: i, code: u8[i + 3], end };
      i += 3;
    }
  }
  if (cur) {
    cur.end = end;
    out.push(cur);
  }
  return out;
}

function bitsFor(resolution) {
  let n = 1;
  while ((1 << n) < resolution) n++;
  return n;
}

/**
 * Decode the headers of one frame (or codec extradata). `state` keeps the VOL
 * settings needed to read later VOP headers. Returns {units, vops: [{type, coded}], key, userData: []}.
 */
export function parseMpeg4Visual(u8, start, end, base, state = {}) {
  const res = { units: [], vops: [], userData: [], key: false };
  const parts = splitStartCodes(u8, start, end);
  if (!parts.length) {
    res.units.push({ title: 'data', offset: base + start, size: end - start, summary: 'no MPEG-4 start code found', fields: [] });
    return res;
  }
  if (parts[0].start > start) {
    res.units.push({ title: 'leading bytes', offset: base + start, size: parts[0].start - start, summary: 'bytes before the first start code', fields: [] });
  }
  for (const p of parts) {
    const fields = [];
    const r = new FieldReader(u8, base, { start: p.start, end: p.end, out: fields });
    const unit = { title: codeName(p.code), offset: base + p.start, size: p.end - p.start, summary: '', fields };
    try {
      r.bytes('start_code_prefix', 3, { role: 'header', display: '00 00 01', desc: 'Start code prefix: marks the beginning of a header in an MPEG-4 Visual bitstream.' });
      r.u8('start_code', { role: 'header', display: (v) => `0x${HEX2[v]} (${codeName(v)})`, desc: 'Which header follows (0xB6 = a picture, VOP; 0x20–0x2F = video object layer; 0xB2 = user data).' });
      if (p.code === 0xb6) vop(r, unit, state, res);
      else if (p.code >= 0x20 && p.code <= 0x2f) vol(r, unit, state);
      else if (p.code === 0xb0) {
        const pl = r.u8('profile_and_level_indication', { key: true, display: (v) => `0x${HEX2[v]} — ${PROFILE_LEVELS[v] ?? 'other'}` });
        state.profile = PROFILE_LEVELS[pl] ?? `0x${HEX2[pl]}`;
        unit.summary = state.profile;
      } else if (p.code === 0xb2) {
        const txt = decodeText(u8.subarray(r.pos, p.end), 'latin1').replace(/\0+$/, '');
        r.bytes('user_data', p.end - r.pos, { display: `"${txt}"`, desc: 'Free-form data, usually the encoder name and version ("Lavc…", "XviD0064", "DivX503b1393p"; a trailing p in DivX user data means packed bitstream).' });
        res.userData.push(txt);
        unit.summary = `"${txt.slice(0, 60)}"`;
      } else if (p.code === 0xb3) {
        r.bits(5, 'time_code_hours');
        r.bits(6, 'time_code_minutes');
        r.flag('marker_bit');
        r.bits(6, 'time_code_seconds');
        r.flag('closed_gov', { desc: '1 = the B-VOPs right after the next I-VOP do not refer to the previous GOV.' });
        r.flag('broken_link');
        unit.summary = 'group of VOPs';
      } else if (p.code === 0xb5) {
        unit.summary = 'visual object';
      } else if (p.code <= 0x1f) {
        unit.summary = `video object ${p.code}`;
      }
    } catch (e) {
      if (!(e instanceof ParseError)) throw e;
      unit.summary += `${unit.summary ? ' ' : ''}(${e.message})`;
    }
    const used = fields.length ? Math.max(...fields.map((f) => f.offset + f.size)) - base : p.start;
    if (p.end > used && (p.code === 0xb6 || (p.code >= 0x20 && p.code <= 0x2f))) {
      fields.push({
        name: p.code === 0xb6 ? 'vop data' : 'rest of the header',
        type: 'bytes',
        offset: base + used,
        size: p.end - used,
        value: null,
        display: `${fmtInt(p.end - used)} bytes`,
        role: 'payload',
        desc: p.code === 0xb6 ? 'The rest of the VOP header and the coded macroblocks; only a full decoder can read them.' : 'Header fields Vidscope does not decode.',
      });
    }
    res.units.push(unit);
  }
  return res;
}

function vop(r, unit, state, res) {
  const type = r.bits(2, 'vop_coding_type', { key: true, enum: VOP_TYPES, desc: 'I = intra (key frame), P = predicted from the previous frame, B = bidirectional, S = sprite / global motion compensation.' });
  const sb = r.pos;
  const sbit = r.bit;
  let mod = 0;
  while (r.bits(1, null) === 1 && mod < 64) mod++;
  const lastByte = r.bit === 0 ? r.pos - 1 : r.pos;
  const f = r.record('modulo_time_base', `bits(${mod + 1})`, sb, lastByte - sb + 1, mod, {
    display: `${mod} (whole seconds since the last GOV / I-VOP time base)`,
    desc: 'A run of 1 bits ended by a 0: how many full seconds this VOP is past the reference time.',
  });
  f.bitOffset = sbit;
  f.bitSize = mod + 1;
  const v = { type: VOP_TYPES[type][0], coded: 1 };
  if (state.timeRes) {
    r.flag('marker_bit');
    const inc = r.bits(bitsFor(state.timeRes), 'vop_time_increment', { display: (x) => `${fmtInt(x)} / ${fmtInt(state.timeRes)}`, desc: 'Time of this VOP within the second, in units of 1 / vop_time_increment_resolution.' });
    r.flag('marker_bit');
    v.coded = r.flag('vop_coded', { desc: '0 = not coded: the previous picture is repeated. Encoders emit these "N-VOPs" as placeholders, for example after a packed B-frame.' });
    v.time = mod + inc / state.timeRes;
  }
  res.vops.push(v);
  if (type === 0) res.key = true;
  unit.title = `VOP · ${v.type}${v.coded ? '' : ' (not coded)'}`;
  unit.summary = `${VOP_TYPES[type]}-VOP${v.coded ? '' : ', not coded (N-VOP)'}`;
  unit.key = type === 0;
}

function vol(r, unit, state) {
  r.flag('random_accessible_vol');
  r.u8('video_object_type_indication', { display: (v) => `${v}${v === 1 ? ' (Simple Object)' : v === 17 ? ' (Advanced Simple)' : ''}` });
  let verid = 1;
  if (r.flag('is_object_layer_identifier')) {
    verid = r.bits(4, 'video_object_layer_verid');
    r.bits(3, 'video_object_layer_priority');
  }
  const ar = r.bits(4, 'aspect_ratio_info', { enum: ASPECT, desc: 'Pixel aspect ratio.' });
  if (ar === 15) {
    state.par = [r.u8('par_width'), r.u8('par_height')];
  }
  if (r.flag('vol_control_parameters')) {
    r.bits(2, 'chroma_format', { enum: { 1: '4:2:0' } });
    state.lowDelay = r.flag('low_delay', { desc: '1 = no B-VOPs, so frames are stored in display order. 0 = B-VOPs may follow.' });
    if (r.flag('vbv_parameters')) {
      r.bits(15, 'first_half_bit_rate');
      r.flag('marker_bit');
      r.bits(15, 'latter_half_bit_rate');
      r.flag('marker_bit');
      r.bits(15, 'first_half_vbv_buffer_size');
      r.flag('marker_bit');
      r.bits(3, 'latter_half_vbv_buffer_size');
      r.bits(11, 'first_half_vbv_occupancy');
      r.flag('marker_bit');
      r.bits(15, 'latter_half_vbv_occupancy');
      r.flag('marker_bit');
    }
  }
  const shape = r.bits(2, 'video_object_layer_shape', { enum: { 0: 'rectangular', 1: 'binary', 2: 'binary only', 3: 'grayscale' } });
  if (shape === 3 && verid !== 1) r.bits(4, 'video_object_layer_shape_extension');
  r.flag('marker_bit');
  state.timeRes = r.u16('vop_time_increment_resolution', { key: true, desc: 'Ticks per second of the VOP clock (25 for 25 fps material from FFmpeg, 30000 for NTSC...).' });
  r.flag('marker_bit');
  if (r.flag('fixed_vop_rate')) r.bits(bitsFor(state.timeRes), 'fixed_vop_time_increment');
  if (shape !== 2) {
    if (shape === 0) {
      r.flag('marker_bit');
      state.width = r.bits(13, 'video_object_layer_width', { key: true, unit: 'pixels' });
      r.flag('marker_bit');
      state.height = r.bits(13, 'video_object_layer_height', { key: true, unit: 'pixels' });
      r.flag('marker_bit');
    }
    state.interlaced = r.flag('interlaced');
    r.flag('obmc_disable');
    r.bits(verid === 1 ? 1 : 2, 'sprite_enable');
  }
  unit.summary = `${state.width ?? '?'}×${state.height ?? '?'}, time resolution ${fmtInt(state.timeRes)}${state.lowDelay === 0 ? ', B-VOPs allowed' : state.lowDelay === 1 ? ', low delay (no B-VOPs)' : ''}${state.interlaced ? ', interlaced' : ''}`;
  if (r.bit) r.align(null);
}

/** Quick check of the first VOP type in a frame (for key-frame detection without parsing fields). */
export function firstVopType(u8, start, end) {
  for (let i = start; i + 4 < end; i++) {
    if (u8[i] === 0 && u8[i + 1] === 0 && u8[i + 2] === 1 && u8[i + 3] === 0xb6) return u8[i + 4] >> 6;
  }
  return -1;
}
