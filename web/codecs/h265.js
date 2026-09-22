// H.265 / HEVC: decoder configuration (hvcC), parameter sets, SEI and NAL units.
// Syntax references are to ITU-T H.265 (7.3.x, Annex E) and ISO/IEC 14496-15 § 8.3.3.

import { FieldReader, ParseError } from '../core/fields.js';
import { fmtNum } from '../core/util.js';
import { parseSeiRbsp } from './sei.js';
import { withRbsp, pushSliceData } from './h264.js';
import {
  COLOUR_PRIMARIES, TRANSFER_CHARACTERISTICS, MATRIX_COEFFICIENTS, VIDEO_FORMAT, CHROMA_FORMAT,
  ASPECT_RATIO_IDC, SAR_VALUES,
} from './color.js';

export const NAL_TYPES = {
  0: 'TRAIL_N (trailing picture, non-reference)', 1: 'TRAIL_R (trailing picture)',
  2: 'TSA_N (temporal sub-layer access)', 3: 'TSA_R (temporal sub-layer access)',
  4: 'STSA_N (step-wise temporal sub-layer access)', 5: 'STSA_R (step-wise temporal sub-layer access)',
  6: 'RADL_N (random access decodable leading)', 7: 'RADL_R (random access decodable leading)',
  8: 'RASL_N (random access skipped leading)', 9: 'RASL_R (random access skipped leading)',
  16: 'BLA_W_LP (broken link access)', 17: 'BLA_W_RADL (broken link access)', 18: 'BLA_N_LP (broken link access)',
  19: 'IDR_W_RADL (instantaneous decoding refresh)', 20: 'IDR_N_LP (instantaneous decoding refresh)',
  21: 'CRA (clean random access)', 22: 'reserved IRAP', 23: 'reserved IRAP',
  32: 'VPS (video parameter set)', 33: 'SPS (sequence parameter set)', 34: 'PPS (picture parameter set)',
  35: 'AUD (access unit delimiter)', 36: 'EOS (end of sequence)', 37: 'EOB (end of bitstream)',
  38: 'FD (filler data)', 39: 'prefix SEI', 40: 'suffix SEI',
};

const SHORT = {
  0: 'TRAIL_N', 1: 'TRAIL_R', 2: 'TSA_N', 3: 'TSA_R', 4: 'STSA_N', 5: 'STSA_R', 6: 'RADL_N', 7: 'RADL_R',
  8: 'RASL_N', 9: 'RASL_R', 16: 'BLA', 17: 'BLA', 18: 'BLA', 19: 'IDR', 20: 'IDR', 21: 'CRA',
  32: 'VPS', 33: 'SPS', 34: 'PPS', 35: 'AUD', 36: 'EOS', 37: 'EOB', 38: 'filler', 39: 'SEI', 40: 'suffix SEI',
};

export const PROFILES = {
  1: 'Main', 2: 'Main 10', 3: 'Main Still Picture', 4: 'Format Range Extensions (RExt)',
  5: 'High Throughput', 6: 'Multiview Main', 7: 'Scalable Main', 8: '3D Main', 9: 'Screen Content Coding',
  10: 'Scalable Format Range Extensions', 11: 'High Throughput Screen Content',
};

export const isIrap = (t) => t >= 16 && t <= 23;
export const isVcl = (t) => t < 32;

export function levelName(level) {
  return fmtNum(level / 30, 1);
}

/** RFC 6381 / ISO/IEC 14496-15 Annex E codec string, e.g. hvc1.1.6.L93.B0. */
export function codecString(fourcc, c) {
  const space = ['', 'A', 'B', 'C'][c.profile_space] ?? '';
  // Compatibility flags are written in reverse bit order, as hex without leading zeros.
  let rev = 0;
  for (let i = 0; i < 32; i++) if (c.compat_flags & (2 ** (31 - i))) rev |= 1 << i;
  let s = `${fourcc}.${space}${c.profile_idc}.${(rev >>> 0).toString(16).toUpperCase()}.${c.tier ? 'H' : 'L'}${c.level_idc}`;
  const bytes = [...c.constraint_bytes];
  while (bytes.length && bytes[bytes.length - 1] === 0) bytes.pop();
  for (const b of bytes) s += `.${b.toString(16).toUpperCase()}`;
  return s;
}

// --------------------------------------------------------------------------- hvcC

export function parseHvcC(r, fourcc = 'hvc1') {
  const info = { vps: [], sps: [], pps: [], spsById: new Map(), ppsById: new Map(), vpsById: new Map() };
  r.u8('configurationVersion', { expect: 1, desc: 'Always 1.' });
  info.profile_space = r.bits(2, 'general_profile_space');
  info.tier = r.bits(1, 'general_tier_flag', { enum: { 0: 'Main tier', 1: 'High tier' }, desc: 'High tier allows higher bitrates at the same level.' });
  info.profile_idc = r.bits(5, 'general_profile_idc', { key: true, enum: PROFILES, desc: 'Coding profile: Main (8-bit), Main 10 (10-bit, used for HDR)...' });
  info.compat_flags = r.u32('general_profile_compatibility_flags', {
    display: (v) => `0x${v.toString(16).padStart(8, '0')}`,
    desc: 'Bit j set means the stream also conforms to profile j.',
  });
  const cb = r.bytes('general_constraint_indicator_flags', 6, { desc: 'progressive_source, interlaced_source, non_packed, frame_only and profile-specific constraint flags.' });
  info.constraint_bytes = Array.from(cb);
  info.level_idc = r.u8('general_level_idc', { key: true, display: (v) => `${v} → level ${levelName(v)}`, desc: 'Level × 30: 93 means level 3.1, 120 means level 4, 153 means level 5.1.' });
  r.bits(4, 'reserved', { reserved: true });
  r.bits(12, 'min_spatial_segmentation_idc');
  r.bits(6, 'reserved', { reserved: true });
  r.bits(2, 'parallelismType', { enum: { 0: 'mixed or unknown', 1: 'slice-based', 2: 'tile-based', 3: 'wavefront (entropy sync)' } });
  r.bits(6, 'reserved', { reserved: true });
  info.chroma_format_idc = r.bits(2, 'chromaFormat', { enum: CHROMA_FORMAT });
  r.bits(5, 'reserved', { reserved: true });
  info.bit_depth_luma = r.bits(3, 'bitDepthLumaMinus8', { display: (v) => `${v} → ${v + 8}-bit luma` }) + 8;
  r.bits(5, 'reserved', { reserved: true });
  info.bit_depth_chroma = r.bits(3, 'bitDepthChromaMinus8', { display: (v) => `${v} → ${v + 8}-bit chroma` }) + 8;
  r.u16('avgFrameRate', { display: (v) => (v ? `${v} → ${fmtNum(v / 256, 3)} fps` : '0 (unspecified)') });
  r.bits(2, 'constantFrameRate', { enum: { 0: 'may vary', 1: 'constant', 2: 'constant per temporal layer' } });
  r.bits(3, 'numTemporalLayers');
  r.bits(1, 'temporalIdNested');
  info.lengthSize = r.bits(2, 'lengthSizeMinusOne', {
    display: (v) => `${v} → ${v + 1}-byte NAL unit lengths`,
    desc: 'Every NAL unit inside a sample is preceded by its length in this many bytes (+1).',
  }) + 1;
  const arrays = r.u8('numOfArrays', { desc: 'Number of NAL unit arrays (VPS, SPS, PPS, SEI) that follow.' });
  for (let a = 0; a < arrays; a++) {
    r.group(`array[${a}]`, (ga) => {
      r.flag('array_completeness', { desc: '1 = all NAL units of this type are here; none are sent in the samples.' });
      r.bits(1, 'reserved', { reserved: true });
      const type = r.bits(6, 'NAL_unit_type', { enum: NAL_TYPES });
      ga.display = SHORT[type] ?? `type ${type}`;
      const n = r.u16('numNalus');
      for (let i = 0; i < n; i++) {
        r.group(`nalu[${i}]`, (g) => {
          const len = r.u16('nalUnitLength', { unit: 'bytes' });
          const start = r.pos;
          r.bounded(len, () => {
            const res = parseNalUnit(r.u, start, start + len, r.base, g.children, info, { standalone: true });
            g.display = res.summary;
            if (res.sps) {
              info.sps.push(res.sps);
              info.spsById.set(res.sps.id, res.sps);
            }
            if (res.pps) {
              info.pps.push(res.pps);
              info.ppsById.set(res.pps.id, res.pps);
            }
            if (res.vps) info.vpsById.set(res.vps.id, res.vps);
          });
        });
      }
    });
  }
  info.codec = codecString(fourcc, info);
  return info;
}

// --------------------------------------------------------------------------- NAL units

export function parseNalUnit(u8, start, end, base, out, state = {}, opts = {}) {
  const r = new FieldReader(u8, base, { start, end, out });
  r.bits(1, 'forbidden_zero_bit', { desc: 'Must be 0.' });
  const type = r.bits(6, 'nal_unit_type', {
    key: true,
    enum: NAL_TYPES,
    desc: '0–31 are picture data (VCL); 16–23 are random-access points (IDR/CRA/BLA); 32+ are parameter sets, SEI and delimiters.',
  });
  r.bits(6, 'nuh_layer_id', { desc: '0 for ordinary single-layer video.' });
  const tid = r.bits(3, 'nuh_temporal_id_plus1', { display: (v) => `${v} → temporal layer ${v - 1}` }) - 1;
  const res = { type, name: NAL_TYPES[type] ?? `type ${type}`, short: SHORT[type] ?? `NAL ${type}`, tid };
  res.summary = res.name;
  const pay = start + 2;
  if (pay >= end) return res;
  try {
    if (type === 32) {
      withRbsp(u8, pay, end, base, out, 'video_parameter_set_rbsp', (rr) => {
        res.vps = parseVps(rr);
        res.summary = `VPS ${res.vps.id}`;
      });
    } else if (type === 33) {
      withRbsp(u8, pay, end, base, out, 'seq_parameter_set_rbsp', (rr) => {
        res.sps = parseSps(rr);
        if (state.spsById && !opts.standalone) state.spsById.set(res.sps.id, res.sps);
        res.summary = `SPS: ${res.sps.summary}`;
      });
    } else if (type === 34) {
      withRbsp(u8, pay, end, base, out, 'pic_parameter_set_rbsp', (rr) => {
        res.pps = parsePps(rr);
        if (state.ppsById && !opts.standalone) state.ppsById.set(res.pps.id, res.pps);
        res.summary = `PPS ${res.pps.id}`;
      });
    } else if (type === 39 || type === 40) {
      withRbsp(u8, pay, end, base, out, 'sei_rbsp', (rr) => {
        res.sei = parseSeiRbsp(rr, true);
        res.summary = `${type === 40 ? 'suffix ' : ''}SEI: ${res.sei.map((m) => m.summary ?? m.name).join(', ')}`;
      });
    } else if (type === 35) {
      const rr = new FieldReader(u8, base, { start: pay, end, out });
      rr.bits(3, 'pic_type', { enum: { 0: 'I', 1: 'P, I', 2: 'B, P, I' } });
      res.summary = 'access unit delimiter';
    } else if (isVcl(type)) {
      const g = withRbsp(u8, pay, Math.min(end, pay + 64), base, out, 'slice_segment_header', (rr) => {
        res.slice = parseSliceHeader(rr, type, state);
        res.summary = `${SHORT[type] ?? 'VCL'} ${res.slice.typeName ?? ''}-slice`.replace(' -slice', ' slice');
      }, { partial: true });
      pushSliceData(out, g.offset + g.size, base + end);
    }
  } catch (e) {
    if (!(e instanceof ParseError)) throw e;
    res.error = e.message;
  }
  return res;
}

// --------------------------------------------------------------------------- parameter sets

function profileTierLevel(r, maxSubLayersMinus1, s) {
  r.group('profile_tier_level', () => {
    s.profile_space = r.bits(2, 'general_profile_space');
    s.tier = r.flag('general_tier_flag', { enum: { 0: 'Main tier', 1: 'High tier' } });
    s.profile_idc = r.bits(5, 'general_profile_idc', { key: true, enum: PROFILES });
    s.compat_flags = r.bits(32, 'general_profile_compatibility_flags', { display: (v) => `0x${v.toString(16).padStart(8, '0')}` });
    s.progressive = r.flag('general_progressive_source_flag');
    s.interlaced = r.flag('general_interlaced_source_flag');
    r.flag('general_non_packed_constraint_flag');
    r.flag('general_frame_only_constraint_flag');
    r.bits(43, 'general_constraint_flags', { desc: 'Profile-specific constraint flags (e.g. max_10bit, max_422chroma for RExt).' });
    r.flag('general_inbld_flag');
    s.level_idc = r.u8('general_level_idc', { key: true, display: (v) => `${v} → level ${levelName(v)}` });
    const prof = [];
    const lev = [];
    for (let i = 0; i < maxSubLayersMinus1; i++) {
      prof.push(r.flag(`sub_layer_profile_present_flag[${i}]`));
      lev.push(r.flag(`sub_layer_level_present_flag[${i}]`));
    }
    if (maxSubLayersMinus1 > 0) for (let i = maxSubLayersMinus1; i < 8; i++) r.bits(2, 'reserved_zero_2bits', { reserved: true });
    for (let i = 0; i < maxSubLayersMinus1; i++) {
      if (prof[i]) r.bits(88, `sub_layer_profile[${i}]`);
      if (lev[i]) r.u8(`sub_layer_level_idc[${i}]`);
    }
  });
}

function parseVps(r) {
  const v = {};
  v.id = r.bits(4, 'vps_video_parameter_set_id');
  r.flag('vps_base_layer_internal_flag');
  r.flag('vps_base_layer_available_flag');
  r.bits(6, 'vps_max_layers_minus1');
  const subLayers = r.bits(3, 'vps_max_sub_layers_minus1');
  r.flag('vps_temporal_id_nesting_flag');
  r.u16('vps_reserved_0xffff_16bits', { reserved: true });
  profileTierLevel(r, subLayers, v);
  return v;
}

function scalingListData(r) {
  r.group('scaling_list_data', () => {
    for (let sizeId = 0; sizeId < 4; sizeId++) {
      for (let matrixId = 0; matrixId < 6; matrixId += sizeId === 3 ? 3 : 1) {
        if (!r.flag(`scaling_list_pred_mode_flag[${sizeId}][${matrixId}]`)) {
          r.ue(`scaling_list_pred_matrix_id_delta[${sizeId}][${matrixId}]`);
        } else {
          const coefNum = Math.min(64, 1 << (4 + (sizeId << 1)));
          if (sizeId > 1) r.se(`scaling_list_dc_coef_minus8[${sizeId - 2}][${matrixId}]`);
          for (let i = 0; i < coefNum; i++) r.se(null);
        }
      }
    }
  });
}

function stRefPicSet(r, idx, num, numDeltaPocs) {
  r.group(`st_ref_pic_set[${idx}]`, () => {
    let interPred = 0;
    if (idx !== 0) interPred = r.flag('inter_ref_pic_set_prediction_flag');
    if (interPred) {
      let deltaIdx = 1;
      if (idx === num) deltaIdx = r.ue('delta_idx_minus1') + 1;
      r.flag('delta_rps_sign');
      r.ue('abs_delta_rps_minus1');
      const ref = idx - deltaIdx;
      let count = 0;
      for (let j = 0; j <= (numDeltaPocs[ref] ?? 0); j++) {
        const used = r.flag(`used_by_curr_pic_flag[${j}]`);
        let useDelta = 1;
        if (!used) useDelta = r.flag(`use_delta_flag[${j}]`);
        if (used || useDelta) count++;
      }
      numDeltaPocs[idx] = count;
    } else {
      const neg = r.ue('num_negative_pics');
      const pos = r.ue('num_positive_pics');
      for (let i = 0; i < neg; i++) {
        r.ue(`delta_poc_s0_minus1[${i}]`);
        r.flag(`used_by_curr_pic_s0_flag[${i}]`);
      }
      for (let i = 0; i < pos; i++) {
        r.ue(`delta_poc_s1_minus1[${i}]`);
        r.flag(`used_by_curr_pic_s1_flag[${i}]`);
      }
      numDeltaPocs[idx] = neg + pos;
    }
  });
}

export function parseSps(r) {
  const s = {};
  r.bits(4, 'sps_video_parameter_set_id');
  s.max_sub_layers_minus1 = r.bits(3, 'sps_max_sub_layers_minus1');
  r.flag('sps_temporal_id_nesting_flag');
  profileTierLevel(r, s.max_sub_layers_minus1, s);
  s.id = r.ue('sps_seq_parameter_set_id');
  s.chroma_format_idc = r.ue('chroma_format_idc', { key: true, enum: CHROMA_FORMAT });
  s.separate_colour_plane = 0;
  if (s.chroma_format_idc === 3) s.separate_colour_plane = r.flag('separate_colour_plane_flag');
  s.coded_width = r.ue('pic_width_in_luma_samples', { key: true, unit: 'pixels' });
  s.coded_height = r.ue('pic_height_in_luma_samples', { key: true, unit: 'pixels' });
  s.width = s.coded_width;
  s.height = s.coded_height;
  if (r.flag('conformance_window_flag', { desc: 'The decoded picture is cropped to this window for display.' })) {
    const subW = s.chroma_format_idc === 1 || s.chroma_format_idc === 2 ? 2 : 1;
    const subH = s.chroma_format_idc === 1 ? 2 : 1;
    const l = r.ue('conf_win_left_offset');
    const rt = r.ue('conf_win_right_offset');
    const t = r.ue('conf_win_top_offset');
    const b = r.ue('conf_win_bottom_offset');
    s.width -= subW * (l + rt);
    s.height -= subH * (t + b);
  }
  s.bit_depth_luma = r.ue('bit_depth_luma_minus8', { key: true, display: (v) => `${v} → ${v + 8}-bit` }) + 8;
  s.bit_depth_chroma = r.ue('bit_depth_chroma_minus8', { display: (v) => `${v} → ${v + 8}-bit` }) + 8;
  s.log2_max_poc_lsb = r.ue('log2_max_pic_order_cnt_lsb_minus4', { display: (v) => `${v} → ${v + 4} bits` }) + 4;
  const ordering = r.flag('sps_sub_layer_ordering_info_present_flag');
  for (let i = ordering ? 0 : s.max_sub_layers_minus1; i <= s.max_sub_layers_minus1; i++) {
    r.ue(`sps_max_dec_pic_buffering_minus1[${i}]`);
    s.max_num_reorder = r.ue(`sps_max_num_reorder_pics[${i}]`, { desc: 'How many pictures may precede another in decoding order but follow it in display order.' });
    r.ue(`sps_max_latency_increase_plus1[${i}]`);
  }
  const log2MinCb = r.ue('log2_min_luma_coding_block_size_minus3') + 3;
  const log2DiffCb = r.ue('log2_diff_max_min_luma_coding_block_size');
  s.ctb_size = 1 << (log2MinCb + log2DiffCb);
  r.ue('log2_min_luma_transform_block_size_minus2');
  r.ue('log2_diff_max_min_luma_transform_block_size');
  r.ue('max_transform_hierarchy_depth_inter');
  r.ue('max_transform_hierarchy_depth_intra');
  if (r.flag('scaling_list_enabled_flag')) {
    if (r.flag('sps_scaling_list_data_present_flag')) scalingListData(r);
  }
  r.flag('amp_enabled_flag', { desc: 'Asymmetric motion partitions.' });
  r.flag('sample_adaptive_offset_enabled_flag', { desc: 'SAO in-loop filter.' });
  if (r.flag('pcm_enabled_flag')) {
    r.bits(4, 'pcm_sample_bit_depth_luma_minus1');
    r.bits(4, 'pcm_sample_bit_depth_chroma_minus1');
    r.ue('log2_min_pcm_luma_coding_block_size_minus3');
    r.ue('log2_diff_max_min_pcm_luma_coding_block_size');
    r.flag('pcm_loop_filter_disabled_flag');
  }
  const nSets = r.ue('num_short_term_ref_pic_sets');
  s.num_short_term_ref_pic_sets = nSets;
  const numDeltaPocs = [];
  for (let i = 0; i < nSets; i++) stRefPicSet(r, i, nSets, numDeltaPocs);
  if (r.flag('long_term_ref_pics_present_flag')) {
    const n = r.ue('num_long_term_ref_pics_sps');
    for (let i = 0; i < n; i++) {
      r.bits(s.log2_max_poc_lsb, `lt_ref_pic_poc_lsb_sps[${i}]`);
      r.flag(`used_by_curr_pic_lt_sps_flag[${i}]`);
    }
  }
  r.flag('sps_temporal_mvp_enabled_flag');
  r.flag('strong_intra_smoothing_enabled_flag');
  if (r.flag('vui_parameters_present_flag')) {
    r.group('vui_parameters', () => {
      s.vui = parseVui(r);
    });
  }
  s.summary = `${PROFILES[s.profile_idc] ?? `profile ${s.profile_idc}`}@L${levelName(s.level_idc)}${s.tier ? ' High' : ''}, `
    + `${s.width}×${s.height}, ${CHROMA_FORMAT[s.chroma_format_idc] ?? ''} ${s.bit_depth_luma}-bit`
    + (s.vui?.fps ? `, ${fmtNum(s.vui.fps, 3)} fps` : '');
  return s;
}

function parseVui(r) {
  const v = {};
  if (r.flag('aspect_ratio_info_present_flag')) {
    const idc = r.u8('aspect_ratio_idc', { enum: ASPECT_RATIO_IDC });
    if (idc === 255) v.sar = [r.u16('sar_width'), r.u16('sar_height')];
    else if (SAR_VALUES[idc]) v.sar = SAR_VALUES[idc];
  }
  if (r.flag('overscan_info_present_flag')) r.flag('overscan_appropriate_flag');
  if (r.flag('video_signal_type_present_flag')) {
    r.bits(3, 'video_format', { enum: VIDEO_FORMAT });
    v.full_range = r.flag('video_full_range_flag', { key: true, desc: '0 = limited range (16–235 for 8-bit), 1 = full range.' });
    if (r.flag('colour_description_present_flag')) {
      v.primaries = r.u8('colour_primaries', { key: true, enum: COLOUR_PRIMARIES });
      v.transfer = r.u8('transfer_characteristics', { key: true, enum: TRANSFER_CHARACTERISTICS });
      v.matrix = r.u8('matrix_coeffs', { key: true, enum: MATRIX_COEFFICIENTS });
    }
  }
  if (r.flag('chroma_loc_info_present_flag')) {
    r.ue('chroma_sample_loc_type_top_field');
    r.ue('chroma_sample_loc_type_bottom_field');
  }
  r.flag('neutral_chroma_indication_flag');
  v.field_seq = r.flag('field_seq_flag', { desc: '1 = each picture is a field of interlaced video.' });
  r.flag('frame_field_info_present_flag');
  if (r.flag('default_display_window_flag')) {
    r.ue('def_disp_win_left_offset');
    r.ue('def_disp_win_right_offset');
    r.ue('def_disp_win_top_offset');
    r.ue('def_disp_win_bottom_offset');
  }
  if (r.flag('vui_timing_info_present_flag')) {
    v.num_units_in_tick = r.u32('vui_num_units_in_tick');
    v.time_scale = r.u32('vui_time_scale', { desc: 'Frame rate = vui_time_scale / vui_num_units_in_tick.' });
    if (v.num_units_in_tick) v.fps = v.time_scale / v.num_units_in_tick;
    if (r.flag('vui_poc_proportional_to_timing_flag')) r.ue('vui_num_ticks_poc_diff_one_minus1');
    if (r.flag('vui_hrd_parameters_present_flag')) {
      v.hrd = true;
      return v; // hrd_parameters() is not decoded; stop here.
    }
  }
  if (r.flag('bitstream_restriction_flag')) {
    r.flag('tiles_fixed_structure_flag');
    r.flag('motion_vectors_over_pic_boundaries_flag');
    r.flag('restricted_ref_pic_lists_flag');
    r.ue('min_spatial_segmentation_idc');
    r.ue('max_bytes_per_pic_denom');
    r.ue('max_bits_per_min_cu_denom');
    r.ue('log2_max_mv_length_horizontal');
    r.ue('log2_max_mv_length_vertical');
  }
  return v;
}

function parsePps(r) {
  const p = {};
  p.id = r.ue('pps_pic_parameter_set_id');
  p.sps_id = r.ue('pps_seq_parameter_set_id');
  p.dependent_slice_segments_enabled = r.flag('dependent_slice_segments_enabled_flag');
  p.output_flag_present = r.flag('output_flag_present_flag');
  p.num_extra_slice_header_bits = r.bits(3, 'num_extra_slice_header_bits');
  r.flag('sign_data_hiding_enabled_flag');
  r.flag('cabac_init_present_flag');
  r.ue('num_ref_idx_l0_default_active_minus1');
  r.ue('num_ref_idx_l1_default_active_minus1');
  r.se('init_qp_minus26', { display: (v) => `${v} → initial QP ${v + 26}` });
  r.flag('constrained_intra_pred_flag');
  r.flag('transform_skip_enabled_flag');
  if (r.flag('cu_qp_delta_enabled_flag')) r.ue('diff_cu_qp_delta_depth');
  r.se('pps_cb_qp_offset');
  r.se('pps_cr_qp_offset');
  r.flag('pps_slice_chroma_qp_offsets_present_flag');
  r.flag('weighted_pred_flag');
  r.flag('weighted_bipred_flag');
  r.flag('transquant_bypass_enabled_flag');
  p.tiles = r.flag('tiles_enabled_flag', { desc: 'The picture is split into independently decodable rectangular tiles.' });
  p.wpp = r.flag('entropy_coding_sync_enabled_flag', { desc: 'Wavefront parallel processing: CTU rows can be decoded in parallel.' });
  return p;
}

function parseSliceHeader(r, type, state) {
  const h = {};
  const first = r.flag('first_slice_segment_in_pic_flag', { desc: '1 = this slice segment starts a new picture.' });
  if (isIrap(type)) r.flag('no_output_of_prior_pics_flag');
  const ppsId = r.ue('slice_pic_parameter_set_id');
  const pps = state.ppsById?.get(ppsId);
  const sps = pps ? state.spsById?.get(pps.sps_id) : null;
  if (!pps || !sps) return h;
  let dependent = 0;
  if (!first) {
    if (pps.dependent_slice_segments_enabled) dependent = r.flag('dependent_slice_segment_flag');
    const ctbs = Math.ceil(sps.coded_width / sps.ctb_size) * Math.ceil(sps.coded_height / sps.ctb_size);
    r.bits(Math.ceil(Math.log2(ctbs)), 'slice_segment_address');
  }
  if (dependent) return h;
  for (let i = 0; i < pps.num_extra_slice_header_bits; i++) r.flag(`slice_reserved_flag[${i}]`);
  h.slice_type = r.ue('slice_type', { key: true, enum: { 0: 'B', 1: 'P', 2: 'I' } });
  h.typeName = ['B', 'P', 'I'][h.slice_type];
  if (pps.output_flag_present) r.flag('pic_output_flag');
  if (sps.separate_colour_plane) r.bits(2, 'colour_plane_id');
  if (type !== 19 && type !== 20) {
    h.poc_lsb = r.bits(sps.log2_max_poc_lsb, 'slice_pic_order_cnt_lsb', { desc: 'Low bits of the picture order count (display position).' });
  }
  return h;
}
