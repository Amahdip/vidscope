// AV1: codec configuration (av1C), OBUs and the sequence header.
// References: AV1 Bitstream & Decoding Process Specification (5.3, 5.5, 5.9)
// and AV1 Codec ISO Media File Format Binding § 2.3.

import { FieldReader, ParseError } from '../core/fields.js';
import { COLOUR_PRIMARIES, TRANSFER_CHARACTERISTICS, MATRIX_COEFFICIENTS } from './color.js';

export const OBU_TYPES = {
  0: 'reserved', 1: 'sequence header', 2: 'temporal delimiter', 3: 'frame header', 4: 'tile group',
  5: 'metadata', 6: 'frame', 7: 'redundant frame header', 8: 'tile list', 15: 'padding',
};

const FRAME_TYPES = { 0: 'KEY_FRAME', 1: 'INTER_FRAME', 2: 'INTRA_ONLY_FRAME', 3: 'SWITCH_FRAME' };
const PROFILES = { 0: 'Main (4:2:0, 8/10-bit)', 1: 'High (4:4:4)', 2: 'Professional (4:2:2, 12-bit)' };
const METADATA_TYPES = { 1: 'HDR content light level', 2: 'HDR mastering display colour volume', 3: 'scalability', 4: 'ITU-T T.35', 5: 'timecode' };

export function levelName(idx) {
  if (idx === 31) return 'max';
  return `${2 + (idx >> 2)}.${idx & 3}`;
}

/** av01.P.LLT.DD codec string. */
export function codecString(c) {
  const bd = c.twelve_bit ? 12 : c.high_bitdepth ? 10 : 8;
  return `av01.${c.seq_profile}.${String(c.seq_level_idx_0).padStart(2, '0')}${c.seq_tier_0 ? 'H' : 'M'}.${String(bd).padStart(2, '0')}`;
}

export function parseAv1C(r) {
  const c = {};
  r.flag('marker', { expect: 1, desc: 'Always 1.' });
  r.bits(7, 'version', { expect: 1 });
  c.seq_profile = r.bits(3, 'seq_profile', { key: true, enum: PROFILES });
  c.seq_level_idx_0 = r.bits(5, 'seq_level_idx_0', { key: true, display: (v) => `${v} → level ${levelName(v)}` });
  c.seq_tier_0 = r.flag('seq_tier_0', { enum: { 0: 'Main tier', 1: 'High tier' } });
  c.high_bitdepth = r.flag('high_bitdepth');
  c.twelve_bit = r.flag('twelve_bit');
  c.monochrome = r.flag('monochrome');
  r.flag('chroma_subsampling_x');
  r.flag('chroma_subsampling_y');
  r.bits(2, 'chroma_sample_position', { enum: { 0: 'unknown', 1: 'vertical (left)', 2: 'colocated (top-left)', 3: 'reserved' } });
  r.bits(3, 'reserved', { reserved: true });
  if (r.flag('initial_presentation_delay_present')) r.bits(4, 'initial_presentation_delay_minus_one');
  else r.bits(4, 'reserved', { reserved: true });
  if (r.remaining > 0) {
    r.group('configOBUs', () => {
      const res = parseObus(r.u, r.pos, r.end, r.base, r.out, c);
      c.seq = res.seq;
      r.pos = r.end;
    }, { desc: 'Usually one sequence header OBU, identical to the one in the first key frame.' });
  }
  c.codec = codecString(c);
  return c;
}

/** Parse a run of OBUs (the "low overhead bitstream format" used in samples). */
export function parseObus(u8, start, end, base, out, state = {}) {
  const units = [];
  let p = start;
  let seq = state.seq ?? null;
  while (p < end && units.length < 512) {
    const unit = { offset: base + p };
    const g = { name: `obu[${units.length}]`, type: 'struct', offset: base + p, size: 0, children: [] };
    out.push(g);
    const r = new FieldReader(u8, base, { start: p, end, out: g.children });
    let obuEnd = end;
    try {
      r.bits(1, 'obu_forbidden_bit');
      unit.type = r.bits(4, 'obu_type', { key: true, enum: OBU_TYPES });
      const ext = r.flag('obu_extension_flag');
      const hasSize = r.flag('obu_has_size_field');
      r.bits(1, 'obu_reserved_1bit', { reserved: true });
      if (ext) {
        r.bits(3, 'temporal_id');
        r.bits(2, 'spatial_id');
        r.bits(3, 'extension_header_reserved_3bits', { reserved: true });
      }
      let size = end - r.pos;
      if (hasSize) size = r.leb128('obu_size', { unit: 'bytes' });
      obuEnd = Math.min(end, r.pos + size);
      unit.name = OBU_TYPES[unit.type] ?? `type ${unit.type}`;
      unit.summary = unit.name;
      const payStart = r.pos;
      r.bounded(obuEnd - payStart, () => {
        if (unit.type === 1) {
          r.group('sequence_header_obu', () => {
            seq = parseSequenceHeader(r);
            unit.summary = `sequence header: ${seq.summary}`;
          });
        } else if (unit.type === 3 || unit.type === 6) {
          r.group(unit.type === 6 ? 'frame_header' : 'frame_header_obu', () => {
            const fh = parseFrameHeaderStart(r, seq);
            unit.frame = fh;
            unit.summary = `${unit.name}: ${fh.summary}`;
          }, { desc: 'Only the first fields of the frame header are decoded.' });
          if (r.bit) r.align(null);
          if (r.remaining > 0) {
            r.bytes(unit.type === 6 ? 'rest of frame (header + tile data)' : 'rest of frame header', r.remaining, {
              role: 'payload',
              desc: 'Remaining header fields and entropy-coded tile data.',
            });
          }
        } else if (unit.type === 5) {
          const t = r.leb128('metadata_type', { enum: METADATA_TYPES });
          unit.summary = `metadata: ${METADATA_TYPES[t] ?? t}`;
          if (t === 1) {
            r.u16('max_cll', { unit: 'cd/m²' });
            r.u16('max_fall', { unit: 'cd/m²' });
          }
        } else if (unit.type === 4) {
          r.bytes('tile_group_data', r.remaining, { role: 'payload' });
        } else if (unit.type === 15) {
          r.bytes('padding', r.remaining, { reserved: true });
        }
        if (r.bit) r.align('trailing_bits');
        if (r.remaining > 0) r.bytes('obu_payload', r.remaining, { role: 'payload' });
      });
    } catch (e) {
      if (!(e instanceof ParseError)) throw e;
      unit.error = e.message;
    }
    unit.size = obuEnd - p;
    g.size = unit.size;
    g.display = unit.summary;
    units.push(unit);
    if (obuEnd <= p) break;
    p = obuEnd;
  }
  return { units, seq };
}

function uvlc(r, name) {
  const startByte = r.pos;
  const startBit = r.bit;
  let zeros = 0;
  while (!r.bits(1, null)) {
    if (++zeros >= 32) return 2 ** 32 - 1;
  }
  const v = zeros ? r.bits(zeros, null) + 2 ** zeros - 1 : 0;
  if (name) {
    const lastByte = r.bit === 0 ? r.pos - 1 : r.pos;
    const f = r.record(name, 'uvlc()', startByte, lastByte - startByte + 1, v);
    f.bitOffset = startBit;
    f.bitSize = zeros * 2 + 1;
  }
  return v;
}

export function parseSequenceHeader(r) {
  const s = {};
  s.seq_profile = r.bits(3, 'seq_profile', { key: true, enum: PROFILES });
  s.still_picture = r.flag('still_picture');
  s.reduced = r.flag('reduced_still_picture_header');
  s.decoder_model_info_present = 0;
  s.equal_picture_interval = 0;
  if (s.reduced) {
    s.seq_level_idx = r.bits(5, 'seq_level_idx[0]', { display: (v) => `${v} → level ${levelName(v)}` });
  } else {
    s.timing_info_present = r.flag('timing_info_present_flag');
    if (s.timing_info_present) {
      const units = r.u32('num_units_in_display_tick');
      const ts = r.u32('time_scale');
      s.equal_picture_interval = r.flag('equal_picture_interval');
      let ticks = 1;
      if (s.equal_picture_interval) ticks = uvlc(r, 'num_ticks_per_picture_minus_1') + 1;
      if (units) s.fps = ts / (units * ticks);
      s.decoder_model_info_present = r.flag('decoder_model_info_present_flag');
      if (s.decoder_model_info_present) {
        s.buffer_delay_length = r.bits(5, 'buffer_delay_length_minus_1') + 1;
        r.u32('num_units_in_decoding_tick');
        r.bits(5, 'buffer_removal_time_length_minus_1');
        s.frame_presentation_time_length = r.bits(5, 'frame_presentation_time_length_minus_1') + 1;
      }
    }
    const initialDelay = r.flag('initial_display_delay_present_flag');
    const ops = r.bits(5, 'operating_points_cnt_minus_1') + 1;
    for (let i = 0; i < ops; i++) {
      r.bits(12, `operating_point_idc[${i}]`);
      const lvl = r.bits(5, `seq_level_idx[${i}]`, { display: (v) => `${v} → level ${levelName(v)}` });
      if (i === 0) s.seq_level_idx = lvl;
      if (lvl > 7) r.flag(`seq_tier[${i}]`);
      if (s.decoder_model_info_present) {
        if (r.flag(`decoder_model_present_for_this_op[${i}]`)) {
          r.bits(s.buffer_delay_length, 'decoder_buffer_delay');
          r.bits(s.buffer_delay_length, 'encoder_buffer_delay');
          r.flag('low_delay_mode_flag');
        }
      }
      if (initialDelay && r.flag(`initial_display_delay_present_for_this_op[${i}]`)) r.bits(4, `initial_display_delay_minus_1[${i}]`);
    }
  }
  const wb = r.bits(4, 'frame_width_bits_minus_1') + 1;
  const hb = r.bits(4, 'frame_height_bits_minus_1') + 1;
  s.max_width = r.bits(wb, 'max_frame_width_minus_1', { key: true, display: (v) => `${v} → ${v + 1} pixels` }) + 1;
  s.max_height = r.bits(hb, 'max_frame_height_minus_1', { key: true, display: (v) => `${v} → ${v + 1} pixels` }) + 1;
  s.frame_id_numbers_present = 0;
  if (!s.reduced) s.frame_id_numbers_present = r.flag('frame_id_numbers_present_flag');
  if (s.frame_id_numbers_present) {
    r.bits(4, 'delta_frame_id_length_minus_2');
    r.bits(3, 'additional_frame_id_length_minus_1');
  }
  r.flag('use_128x128_superblock');
  r.flag('enable_filter_intra');
  r.flag('enable_intra_edge_filter');
  if (!s.reduced) {
    r.flag('enable_interintra_compound');
    r.flag('enable_masked_compound');
    r.flag('enable_warped_motion');
    r.flag('enable_dual_filter');
    const orderHint = r.flag('enable_order_hint');
    if (orderHint) {
      r.flag('enable_jnt_comp');
      r.flag('enable_ref_frame_mvs');
    }
    let forceSct = 2;
    if (!r.flag('seq_choose_screen_content_tools')) forceSct = r.flag('seq_force_screen_content_tools');
    if (forceSct > 0 && !r.flag('seq_choose_integer_mv')) r.flag('seq_force_integer_mv');
    if (orderHint) r.bits(3, 'order_hint_bits_minus_1');
  }
  r.flag('enable_superres');
  r.flag('enable_cdef');
  r.flag('enable_restoration');
  r.group('color_config', () => {
    const high = r.flag('high_bitdepth');
    s.bit_depth = 8;
    if (s.seq_profile === 2 && high) s.bit_depth = r.flag('twelve_bit') ? 12 : 10;
    else s.bit_depth = high ? 10 : 8;
    let mono = 0;
    if (s.seq_profile !== 1) mono = r.flag('mono_chrome');
    let cp = 2;
    let tc = 2;
    let mc = 2;
    if (r.flag('color_description_present_flag')) {
      cp = r.u8('color_primaries', { key: true, enum: COLOUR_PRIMARIES });
      tc = r.u8('transfer_characteristics', { key: true, enum: TRANSFER_CHARACTERISTICS });
      mc = r.u8('matrix_coefficients', { key: true, enum: MATRIX_COEFFICIENTS });
    }
    Object.assign(s, { primaries: cp, transfer: tc, matrix: mc });
    if (mono) {
      s.full_range = r.flag('color_range');
      s.chroma = '4:0:0';
    } else if (cp === 1 && tc === 13 && mc === 0) {
      s.full_range = 1;
      s.chroma = '4:4:4';
    } else {
      s.full_range = r.flag('color_range', { enum: { 0: 'limited (studio) range', 1: 'full range' } });
      let sx = 1;
      let sy = 1;
      if (s.seq_profile === 1) {
        sx = 0;
        sy = 0;
      } else if (s.seq_profile === 2) {
        if (s.bit_depth === 12) {
          sx = r.flag('subsampling_x');
          sy = sx ? r.flag('subsampling_y') : 0;
        } else {
          sx = 1;
          sy = 0;
        }
      }
      s.chroma = sx && sy ? '4:2:0' : sx ? '4:2:2' : '4:4:4';
      if (sx && sy) r.bits(2, 'chroma_sample_position');
    }
    r.flag('separate_uv_delta_q');
  });
  r.flag('film_grain_params_present', { desc: 'Film grain is synthesised by the decoder instead of being coded.' });
  s.summary = `${PROFILES[s.seq_profile]?.split(' ')[0] ?? s.seq_profile} profile, level ${levelName(s.seq_level_idx ?? 0)}, `
    + `up to ${s.max_width}×${s.max_height}, ${s.chroma ?? ''} ${s.bit_depth}-bit`;
  return s;
}

function parseFrameHeaderStart(r, seq) {
  const f = {};
  if (seq?.reduced) {
    f.frame_type = 0;
    f.show_frame = 1;
    f.summary = 'KEY_FRAME (still picture)';
    return f;
  }
  if (r.flag('show_existing_frame', { desc: '1 = no new picture is coded; a previously decoded frame is shown again.' })) {
    r.bits(3, 'frame_to_show_map_idx');
    f.show_existing = 1;
    f.summary = 'show existing frame';
    return f;
  }
  f.frame_type = r.bits(2, 'frame_type', { key: true, enum: FRAME_TYPES, desc: 'KEY_FRAME resets decoding (a random-access point when shown).' });
  f.show_frame = r.flag('show_frame', { desc: '0 = decoded but not displayed now (e.g. an alt-ref frame shown later).' });
  f.summary = `${FRAME_TYPES[f.frame_type]}${f.show_frame ? '' : ' (hidden)'}`;
  if (seq && f.show_frame && seq.decoder_model_info_present && !seq.equal_picture_interval) {
    r.bits(seq.frame_presentation_time_length, 'frame_presentation_time');
  }
  if (!f.show_frame) r.flag('showable_frame');
  if (!(f.frame_type === 3 || (f.frame_type === 0 && f.show_frame))) r.flag('error_resilient_mode');
  return f;
}
