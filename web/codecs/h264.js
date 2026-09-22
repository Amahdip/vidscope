// H.264 / AVC: decoder configuration (avcC), parameter sets, SEI and NAL units.
// Syntax references are to ITU-T H.264 (sections 7.3.x and Annex E) and
// ISO/IEC 14496-15 § 5.3.3 for the AVCDecoderConfigurationRecord.

import { FieldReader, ParseError } from '../core/fields.js';
import { HEX2, fmtNum } from '../core/util.js';
import { rbspReader, moreRbspData } from './nal.js';
import { parseSeiRbsp } from './sei.js';
import {
  COLOUR_PRIMARIES, TRANSFER_CHARACTERISTICS, MATRIX_COEFFICIENTS, VIDEO_FORMAT, CHROMA_FORMAT,
  ASPECT_RATIO_IDC, SAR_VALUES,
} from './color.js';

export const NAL_TYPES = {
  0: 'unspecified',
  1: 'coded slice (non-IDR)',
  2: 'slice data partition A',
  3: 'slice data partition B',
  4: 'slice data partition C',
  5: 'coded slice (IDR)',
  6: 'SEI',
  7: 'sequence parameter set (SPS)',
  8: 'picture parameter set (PPS)',
  9: 'access unit delimiter',
  10: 'end of sequence',
  11: 'end of stream',
  12: 'filler data',
  13: 'SPS extension',
  14: 'prefix NAL unit',
  15: 'subset SPS',
  16: 'depth parameter set',
  19: 'auxiliary slice',
  20: 'coded slice extension (SVC/MVC)',
  21: 'coded slice extension (3D-AVC)',
};

export const NAL_SHORT = { 1: 'slice', 5: 'IDR slice', 6: 'SEI', 7: 'SPS', 8: 'PPS', 9: 'AUD', 10: 'end of seq', 11: 'end of stream', 12: 'filler' };

export const PROFILES = {
  44: 'CAVLC 4:4:4 Intra', 66: 'Baseline', 77: 'Main', 83: 'Scalable Baseline', 86: 'Scalable High',
  88: 'Extended', 100: 'High', 110: 'High 10', 118: 'Multiview High', 122: 'High 4:2:2', 128: 'Stereo High',
  134: 'MFC High', 135: 'MFC Depth High', 138: 'Multiview Depth High', 139: 'Enhanced Multiview Depth High',
  144: 'High 4:4:4 (removed)', 244: 'High 4:4:4 Predictive',
};

const HIGH_PROFILES = new Set([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135]);

export function profileName(profile, compat = 0) {
  if (profile === 66 && compat & 0x40) return 'Constrained Baseline';
  if (profile === 100 && (compat & 0x0c) === 0x0c) return 'Constrained High';
  if (profile === 110 && compat & 0x10) return 'High 10 Intra';
  if (profile === 122 && compat & 0x10) return 'High 4:2:2 Intra';
  if (profile === 244 && compat & 0x10) return 'High 4:4:4 Intra';
  return PROFILES[profile] ?? `profile ${profile}`;
}

export function levelName(level, compat = 0, profile = 0) {
  if (level === 9 || (level === 11 && compat & 0x10 && (profile === 66 || profile === 77 || profile === 88))) return '1b';
  return fmtNum(level / 10, 1);
}

/** RFC 6381 codec string, e.g. avc1.64001F. */
export function codecString(fourcc, profile, compat, level) {
  return `${fourcc}.${HEX2[profile]}${HEX2[compat]}${HEX2[level]}`;
}

const SLICE_TYPES = { 0: 'P', 1: 'B', 2: 'I', 3: 'SP', 4: 'SI', 5: 'P', 6: 'B', 7: 'I', 8: 'SP', 9: 'SI' };

// --------------------------------------------------------------------------- avcC

/**
 * AVCDecoderConfigurationRecord. `r` is positioned at configurationVersion.
 * Returns {profile, compat, level, lengthSize, sps: [info], pps: [info], codec}.
 */
export function parseAvcC(r, fourcc = 'avc1') {
  const info = { sps: [], pps: [], spsById: new Map(), ppsById: new Map() };
  r.u8('configurationVersion', { desc: 'Always 1. A reader that sees another value must not parse the rest.', expect: 1 });
  info.profile = r.u8('AVCProfileIndication', {
    key: true,
    display: (v) => `${v} — ${PROFILES[v] ?? 'unknown'}`,
    desc: 'The profile: which coding tools the stream may use (Baseline, Main, High...). Copied from the SPS.',
  });
  info.compat = r.u8('profile_compatibility', {
    display: (v) => `0x${HEX2[v]} (constraint_set flags ${v.toString(2).padStart(8, '0')})`,
    desc: 'The constraint_set0..5 flags of the SPS. They narrow the profile, e.g. Constrained Baseline.',
  });
  info.level = r.u8('AVCLevelIndication', {
    key: true,
    display: (v) => `${v} — level ${levelName(v, info.compat, info.profile)}`,
    desc: 'The level: limits on resolution, frame rate and bitrate a decoder must handle. 31 means level 3.1.',
  });
  r.bits(6, 'reserved', { reserved: true, desc: 'Reserved, all ones.' });
  info.lengthSize = r.bits(2, 'lengthSizeMinusOne', {
    display: (v) => `${v} → ${v + 1}-byte NAL unit lengths`,
    desc: 'Inside each sample, every NAL unit is preceded by its length in this many bytes (+1). Almost always 4 bytes.',
  }) + 1;
  r.bits(3, 'reserved', { reserved: true, desc: 'Reserved, all ones.' });
  const nsps = r.bits(5, 'numOfSequenceParameterSets', { desc: 'How many SPS NAL units follow.' });
  for (let i = 0; i < nsps; i++) {
    r.group(`sequenceParameterSet[${i}]`, (g) => {
      const len = r.u16('sequenceParameterSetLength', { unit: 'bytes' });
      const start = r.pos;
      r.bounded(len, () => {
        const sps = parseNalUnit(r.u, start, start + len, r.base, g.children, info, { standalone: true });
        if (sps && sps.sps) {
          info.sps.push(sps.sps);
          info.spsById.set(sps.sps.id, sps.sps);
          g.display = sps.summary;
        }
      });
    });
  }
  const npps = r.u8('numOfPictureParameterSets', { desc: 'How many PPS NAL units follow.' });
  for (let i = 0; i < npps; i++) {
    r.group(`pictureParameterSet[${i}]`, (g) => {
      const len = r.u16('pictureParameterSetLength', { unit: 'bytes' });
      const start = r.pos;
      r.bounded(len, () => {
        const pps = parseNalUnit(r.u, start, start + len, r.base, g.children, info, { standalone: true });
        if (pps && pps.pps) {
          info.pps.push(pps.pps);
          info.ppsById.set(pps.pps.id, pps.pps);
          g.display = pps.summary;
        }
      });
    });
  }
  if (r.remaining >= 4 && HIGH_PROFILES.has(info.profile)) {
    r.bits(6, 'reserved', { reserved: true });
    r.bits(2, 'chroma_format', { enum: CHROMA_FORMAT });
    r.bits(5, 'reserved', { reserved: true });
    r.bits(3, 'bit_depth_luma_minus8', { display: (v) => `${v} → ${v + 8}-bit luma` });
    r.bits(5, 'reserved', { reserved: true });
    r.bits(3, 'bit_depth_chroma_minus8', { display: (v) => `${v} → ${v + 8}-bit chroma` });
    const next = r.u8('numOfSequenceParameterSetExt');
    for (let i = 0; i < next; i++) {
      r.group(`sequenceParameterSetExt[${i}]`, () => {
        const len = r.u16('sequenceParameterSetExtLength', { unit: 'bytes' });
        r.bytes('sequenceParameterSetExtNALUnit', len);
      });
    }
  }
  info.codec = codecString(fourcc, info.profile, info.compat, info.level);
  return info;
}

// --------------------------------------------------------------------------- NAL units

/**
 * Parse one NAL unit u8[start, end) (without start code / length prefix).
 * Fields go into `out`. `state` holds spsById/ppsById so slices can be read.
 * Returns {type, name, summary, sps?, pps?, slice?, sei?}.
 */
export function parseNalUnit(u8, start, end, base, out, state = {}, opts = {}) {
  const r = new FieldReader(u8, base, { start, end, out });
  r.bits(1, 'forbidden_zero_bit', { desc: 'Must be 0. A 1 marks a NAL unit known to be damaged.' });
  const refIdc = r.bits(2, 'nal_ref_idc', {
    desc: 'Non-zero when this NAL unit is needed to decode other pictures (reference pictures, parameter sets). 0 means it can be dropped.',
  });
  const type = r.bits(5, 'nal_unit_type', {
    key: true,
    enum: NAL_TYPES,
    desc: 'What this NAL unit carries. 5 = IDR slice (a clean key frame), 1 = other slices, 6 = SEI, 7/8 = SPS/PPS.',
  });
  const res = { type, name: NAL_TYPES[type] ?? `type ${type}`, short: NAL_SHORT[type] ?? `NAL ${type}`, refIdc };
  res.summary = res.name;
  const pay = start + 1;
  if (pay >= end) return res;
  try {
    if (type === 7) {
      withRbsp(u8, pay, end, base, out, 'seq_parameter_set_rbsp', (rr) => {
        res.sps = parseSps(rr);
        if (state.spsById && !opts.standalone) state.spsById.set(res.sps.id, res.sps);
        res.summary = `SPS: ${res.sps.summary}`;
      });
    } else if (type === 8) {
      withRbsp(u8, pay, end, base, out, 'pic_parameter_set_rbsp', (rr) => {
        res.pps = parsePps(rr, state.spsById);
        if (state.ppsById && !opts.standalone) state.ppsById.set(res.pps.id, res.pps);
        res.summary = `PPS ${res.pps.id}: ${res.pps.cabac ? 'CABAC' : 'CAVLC'} entropy coding`;
      });
    } else if (type === 6) {
      withRbsp(u8, pay, end, base, out, 'sei_rbsp', (rr) => {
        res.sei = parseSeiRbsp(rr, false);
        res.summary = `SEI: ${res.sei.map((m) => m.summary ?? m.name).join(', ')}`;
      });
    } else if (type === 1 || type === 5) {
      const g = withRbsp(u8, pay, Math.min(end, pay + 64), base, out, 'slice_header', (rr) => {
        res.slice = parseSliceHeader(rr, type, refIdc, state);
        res.summary = `${type === 5 ? 'IDR' : ''} ${res.slice.typeName}-slice`.trim()
          + (res.slice.frame_num !== undefined ? `, frame_num ${res.slice.frame_num}` : '');
      }, { partial: true });
      pushSliceData(out, g.offset + g.size, base + end);
    } else if (type === 9) {
      const rr = new FieldReader(u8, base, { start: pay, end, out });
      const t = rr.bits(3, 'primary_pic_type', {
        enum: { 0: 'I', 1: 'I, P', 2: 'I, P, B', 3: 'SI', 4: 'SI, SP', 5: 'I, SI', 6: 'I, SI, P, SP', 7: 'I, SI, P, SP, B' },
        desc: 'Which slice types the picture in this access unit may contain.',
      });
      res.summary = `access unit delimiter (${['I', 'I/P', 'I/P/B', 'SI', 'SI/SP', 'I/SI', 'I/SI/P/SP', 'any'][t]})`;
    }
  } catch (e) {
    if (!(e instanceof ParseError)) throw e;
    res.error = e.message;
  }
  return res;
}

/** The undecoded remainder of a coded slice, from the end of the decoded header fields. */
export function pushSliceData(out, from, to) {
  if (to <= from) return;
  out.push({
    name: 'slice_data',
    type: 'bytes',
    offset: from,
    size: to - from,
    value: null,
    display: `${(to - from).toLocaleString('en-US')} bytes (rest of the slice header, then entropy-coded picture data)`,
    desc: 'The compressed picture itself. Only the first slice-header fields are decoded above; the rest is CABAC/CAVLC-coded data that needs a full decoder.',
    role: 'payload',
  });
}

/** Run fn over an RBSP reader whose fields are grouped under one struct. */
export function withRbsp(u8, start, end, base, out, name, fn, o = {}) {
  const g = { name, type: 'struct', offset: base + start, size: end - start, children: [] };
  if (o.partial) g.desc = 'Only the first fields of the slice header are decoded.';
  out.push(g);
  const r = rbspReader(u8, start, end, base, g.children);
  try {
    fn(r, g);
  } finally {
    const endPos = r.bit ? r.pos + 1 : r.pos;
    if (o.partial && endPos > 0) g.size = r.spanSize(0, endPos);
    if (r.epb) g.note = `${r.epb} emulation-prevention byte${r.epb === 1 ? '' : 's'} (00 00 03) removed before parsing`;
  }
  return g;
}

// --------------------------------------------------------------------------- SPS

function scalingList(r, name, size) {
  let last = 8;
  let next = 8;
  r.group(name, () => {
    for (let j = 0; j < size; j++) {
      if (next !== 0) {
        const delta = r.se(`delta_scale[${j}]`);
        next = (last + delta + 256) % 256;
      }
      last = next === 0 ? last : next;
      if (next === 0 && j === 0) break;
    }
  });
}

export function parseSps(r) {
  const s = {};
  s.profile_idc = r.u8('profile_idc', { key: true, display: (v) => `${v} — ${PROFILES[v] ?? 'unknown'}`, desc: 'Coding profile.' });
  let compat = 0;
  for (let i = 0; i <= 5; i++) {
    const f = r.flag(`constraint_set${i}_flag`, i === 1 ? { desc: 'With Baseline, marks Constrained Baseline.' } : i === 3 ? { desc: 'With level_idc 11, marks level 1b (Baseline/Main/Extended), or an intra-only profile for High 10/4:2:2/4:4:4.' } : undefined);
    compat |= f << (7 - i);
  }
  r.bits(2, 'reserved_zero_2bits', { reserved: true });
  s.compat = compat;
  s.level_idc = r.u8('level_idc', { key: true, display: (v) => `${v} — level ${levelName(v, compat, s.profile_idc)}` });
  s.id = r.ue('seq_parameter_set_id', { desc: 'Identifier that PPS NAL units refer to.' });
  s.chroma_format_idc = 1;
  s.bit_depth_luma = 8;
  s.bit_depth_chroma = 8;
  s.separate_colour_plane = 0;
  if (HIGH_PROFILES.has(s.profile_idc)) {
    s.chroma_format_idc = r.ue('chroma_format_idc', { key: true, enum: CHROMA_FORMAT, desc: 'Chroma subsampling. 1 = 4:2:0, which almost all delivery video uses.' });
    if (s.chroma_format_idc === 3) s.separate_colour_plane = r.flag('separate_colour_plane_flag');
    s.bit_depth_luma = r.ue('bit_depth_luma_minus8', { display: (v) => `${v} → ${v + 8}-bit` }) + 8;
    s.bit_depth_chroma = r.ue('bit_depth_chroma_minus8', { display: (v) => `${v} → ${v + 8}-bit` }) + 8;
    r.flag('qpprime_y_zero_transform_bypass_flag', { desc: 'Allows lossless coding of macroblocks with QP 0.' });
    const scaling = r.flag('seq_scaling_matrix_present_flag', { desc: 'Custom quantisation matrices follow (otherwise flat defaults).' });
    if (scaling) {
      const n = s.chroma_format_idc !== 3 ? 8 : 12;
      for (let i = 0; i < n; i++) {
        if (r.flag(`seq_scaling_list_present_flag[${i}]`)) scalingList(r, `scaling_list[${i}]`, i < 6 ? 16 : 64);
      }
    }
  }
  s.log2_max_frame_num = r.ue('log2_max_frame_num_minus4', { display: (v) => `${v} → frame_num uses ${v + 4} bits` }) + 4;
  s.poc_type = r.ue('pic_order_cnt_type', {
    enum: { 0: 'explicit POC LSBs in each slice', 1: 'derived from frame_num with offsets', 2: 'output order = decoding order' },
    desc: 'How the display order (picture order count) is signalled. Type 2 means no B-frame reordering.',
  });
  if (s.poc_type === 0) {
    s.log2_max_poc_lsb = r.ue('log2_max_pic_order_cnt_lsb_minus4', { display: (v) => `${v} → ${v + 4} bits` }) + 4;
  } else if (s.poc_type === 1) {
    s.delta_pic_order_always_zero = r.flag('delta_pic_order_always_zero_flag');
    r.se('offset_for_non_ref_pic');
    r.se('offset_for_top_to_bottom_field');
    const n = r.ue('num_ref_frames_in_pic_order_cnt_cycle');
    for (let i = 0; i < n; i++) r.se(`offset_for_ref_frame[${i}]`);
  }
  s.max_num_ref_frames = r.ue('max_num_ref_frames', { desc: 'How many reference frames the decoder must keep. More references can mean better compression.' });
  r.flag('gaps_in_frame_num_value_allowed_flag');
  const wmbs = r.ue('pic_width_in_mbs_minus1', { key: true, display: (v) => `${v} → ${(v + 1) * 16} pixels (${v + 1} macroblocks)`, desc: 'Coded width in 16×16 macroblocks, minus one.' }) + 1;
  const hmu = r.ue('pic_height_in_map_units_minus1', { key: true, display: (v) => `${v} → ${v + 1} map units`, desc: 'Coded height in macroblock rows (or pairs of rows for interlaced), minus one.' }) + 1;
  s.frame_mbs_only = r.flag('frame_mbs_only_flag', { desc: '1 = progressive only. 0 = the stream may contain interlaced fields.' });
  if (!s.frame_mbs_only) r.flag('mb_adaptive_frame_field_flag', { desc: 'MBAFF: each macroblock pair can switch between frame and field coding.' });
  r.flag('direct_8x8_inference_flag');
  const crop = r.flag('frame_cropping_flag', { desc: 'The decoded picture is cropped to the display size (e.g. 1088 coded rows become 1080).' });
  let cl = 0;
  let cr = 0;
  let ct = 0;
  let cb = 0;
  if (crop) {
    cl = r.ue('frame_crop_left_offset');
    cr = r.ue('frame_crop_right_offset');
    ct = r.ue('frame_crop_top_offset');
    cb = r.ue('frame_crop_bottom_offset');
  }
  const chromaArrayType = s.separate_colour_plane ? 0 : s.chroma_format_idc;
  const subW = chromaArrayType === 3 ? 1 : 2;
  const subH = chromaArrayType === 1 ? 2 : 1;
  const cropX = chromaArrayType === 0 ? 1 : subW;
  const cropY = (chromaArrayType === 0 ? 1 : subH) * (2 - s.frame_mbs_only);
  s.coded_width = wmbs * 16;
  s.coded_height = (2 - s.frame_mbs_only) * hmu * 16;
  s.width = s.coded_width - cropX * (cl + cr);
  s.height = s.coded_height - cropY * (ct + cb);
  const vui = r.flag('vui_parameters_present_flag', { desc: 'Video usability information follows: aspect ratio, colour, timing.' });
  if (vui) {
    r.group('vui_parameters', () => {
      s.vui = parseVui(r);
    });
  }
  if (r.bitsLeft > 0) r.align('rbsp_trailing_bits');
  const vuiParts = [];
  if (s.vui?.fps) vuiParts.push(`${fmtNum(s.vui.fps, 3)} fps`);
  s.summary = `${profileName(s.profile_idc, compat)}@L${levelName(s.level_idc, compat, s.profile_idc)}, ${s.width}×${s.height}`
    + `${s.frame_mbs_only ? '' : ' interlaced'}, ${CHROMA_FORMAT[s.chroma_format_idc] ?? ''}${s.bit_depth_luma !== 8 ? ` ${s.bit_depth_luma}-bit` : ''}`
    + (vuiParts.length ? `, ${vuiParts.join(', ')}` : '');
  return s;
}

function hrdParameters(r, name) {
  r.group(name, () => {
    const cnt = r.ue('cpb_cnt_minus1') + 1;
    r.bits(4, 'bit_rate_scale');
    r.bits(4, 'cpb_size_scale');
    for (let i = 0; i < cnt; i++) {
      r.ue(`bit_rate_value_minus1[${i}]`);
      r.ue(`cpb_size_value_minus1[${i}]`);
      r.flag(`cbr_flag[${i}]`, { desc: '1 = constant bitrate delivery for this schedule.' });
    }
    r.bits(5, 'initial_cpb_removal_delay_length_minus1');
    r.bits(5, 'cpb_removal_delay_length_minus1');
    r.bits(5, 'dpb_output_delay_length_minus1');
    r.bits(5, 'time_offset_length');
  });
}

function parseVui(r) {
  const v = {};
  if (r.flag('aspect_ratio_info_present_flag')) {
    const idc = r.u8('aspect_ratio_idc', { enum: ASPECT_RATIO_IDC, desc: 'Shape of each pixel (sample aspect ratio). 1:1 means square pixels.' });
    if (idc === 255) {
      v.sar = [r.u16('sar_width'), r.u16('sar_height')];
    } else if (SAR_VALUES[idc]) {
      v.sar = SAR_VALUES[idc];
    }
  }
  if (r.flag('overscan_info_present_flag')) r.flag('overscan_appropriate_flag');
  if (r.flag('video_signal_type_present_flag', { desc: 'Colour range and colour description follow.' })) {
    r.bits(3, 'video_format', { enum: VIDEO_FORMAT });
    v.full_range = r.flag('video_full_range_flag', { key: true, desc: '0 = limited "TV" range (16–235), 1 = full range (0–255).' });
    if (r.flag('colour_description_present_flag')) {
      v.primaries = r.u8('colour_primaries', { key: true, enum: COLOUR_PRIMARIES });
      v.transfer = r.u8('transfer_characteristics', { key: true, enum: TRANSFER_CHARACTERISTICS });
      v.matrix = r.u8('matrix_coefficients', { key: true, enum: MATRIX_COEFFICIENTS });
    }
  }
  if (r.flag('chroma_loc_info_present_flag')) {
    r.ue('chroma_sample_loc_type_top_field');
    r.ue('chroma_sample_loc_type_bottom_field');
  }
  if (r.flag('timing_info_present_flag', { desc: 'Frame timing follows.' })) {
    v.num_units_in_tick = r.u32('num_units_in_tick');
    v.time_scale = r.u32('time_scale', {
      desc: 'Frame rate = time_scale / (2 × num_units_in_tick) for H.264, because a "tick" is one field.',
    });
    v.fixed_frame_rate = r.flag('fixed_frame_rate_flag');
    if (v.num_units_in_tick) v.fps = v.time_scale / (2 * v.num_units_in_tick);
  }
  const nal = r.flag('nal_hrd_parameters_present_flag');
  if (nal) hrdParameters(r, 'nal_hrd_parameters');
  const vcl = r.flag('vcl_hrd_parameters_present_flag');
  if (vcl) hrdParameters(r, 'vcl_hrd_parameters');
  if (nal || vcl) r.flag('low_delay_hrd_flag');
  v.pic_struct_present = r.flag('pic_struct_present_flag');
  if (r.flag('bitstream_restriction_flag')) {
    r.flag('motion_vectors_over_pic_boundaries_flag');
    r.ue('max_bytes_per_pic_denom');
    r.ue('max_bits_per_mb_denom');
    r.ue('log2_max_mv_length_horizontal');
    r.ue('log2_max_mv_length_vertical');
    v.max_num_reorder_frames = r.ue('max_num_reorder_frames', { desc: 'How many frames may arrive before one that is shown earlier (B-frame reordering depth).' });
    v.max_dec_frame_buffering = r.ue('max_dec_frame_buffering');
  }
  return v;
}

// --------------------------------------------------------------------------- PPS

export function parsePps(r, spsById) {
  const p = {};
  p.id = r.ue('pic_parameter_set_id');
  p.sps_id = r.ue('seq_parameter_set_id');
  p.cabac = r.flag('entropy_coding_mode_flag', {
    key: true,
    enum: { 0: 'CAVLC', 1: 'CABAC' },
    desc: 'Entropy coder. CABAC (1) compresses about 10–15% better than CAVLC but is slower to decode.',
  });
  p.bottom_field_pic_order_in_frame_present = r.flag('bottom_field_pic_order_in_frame_present_flag');
  const groups = r.ue('num_slice_groups_minus1', { desc: 'Flexible macroblock ordering (Baseline/Extended). Almost always 0.' });
  if (groups > 0) {
    p.partial = true;
    return p;
  }
  p.num_ref_idx_l0_default = r.ue('num_ref_idx_l0_default_active_minus1') + 1;
  p.num_ref_idx_l1_default = r.ue('num_ref_idx_l1_default_active_minus1') + 1;
  p.weighted_pred = r.flag('weighted_pred_flag', { desc: 'Weighted prediction for P slices (helps fades).' });
  r.bits(2, 'weighted_bipred_idc');
  r.se('pic_init_qp_minus26', { display: (v) => `${v} → initial QP ${v + 26}` });
  r.se('pic_init_qs_minus26');
  r.se('chroma_qp_index_offset');
  p.deblocking_control = r.flag('deblocking_filter_control_present_flag');
  r.flag('constrained_intra_pred_flag');
  p.redundant_pic_cnt_present = r.flag('redundant_pic_cnt_present_flag');
  if (moreRbspData(r)) {
    p.transform_8x8 = r.flag('transform_8x8_mode_flag', { desc: '8×8 transforms are allowed (a High profile tool).' });
    if (r.flag('pic_scaling_matrix_present_flag')) {
      const sps = spsById?.get(p.sps_id);
      const n = 6 + ((sps?.chroma_format_idc !== 3 ? 2 : 6) * p.transform_8x8);
      for (let i = 0; i < n; i++) {
        if (r.flag(`pic_scaling_list_present_flag[${i}]`)) scalingList(r, `scaling_list[${i}]`, i < 6 ? 16 : 64);
      }
    }
    r.se('second_chroma_qp_index_offset');
  }
  if (r.bitsLeft > 0) r.align('rbsp_trailing_bits');
  return p;
}

// --------------------------------------------------------------------------- slice header

function parseSliceHeader(r, nalType, refIdc, state) {
  const h = {};
  r.ue('first_mb_in_slice', { desc: 'Address of the first macroblock in this slice. 0 = the slice starts the picture.' });
  h.slice_type = r.ue('slice_type', {
    key: true,
    display: (v) => `${v} → ${SLICE_TYPES[v] ?? '?'}${v >= 5 ? ' (all slices of the picture have this type)' : ''}`,
    desc: 'I = intra only (no reference to other frames), P = predicts from earlier frames, B = predicts from two directions.',
  });
  h.typeName = SLICE_TYPES[h.slice_type] ?? '?';
  const ppsId = r.ue('pic_parameter_set_id');
  const pps = state.ppsById?.get(ppsId);
  const sps = pps ? state.spsById?.get(pps.sps_id) : null;
  if (!pps || !sps) return h;
  if (sps.separate_colour_plane) r.bits(2, 'colour_plane_id');
  h.frame_num = r.bits(sps.log2_max_frame_num, 'frame_num', { desc: 'Counts reference pictures in decoding order; wraps around.' });
  let field = 0;
  if (!sps.frame_mbs_only) {
    field = r.flag('field_pic_flag', { desc: '1 = this slice belongs to a single field of an interlaced frame.' });
    if (field) r.flag('bottom_field_flag');
  }
  if (nalType === 5) r.ue('idr_pic_id');
  if (sps.poc_type === 0) {
    h.poc_lsb = r.bits(sps.log2_max_poc_lsb, 'pic_order_cnt_lsb', { desc: 'Low bits of the picture order count, i.e. the display position.' });
    if (pps.bottom_field_pic_order_in_frame_present && !field) r.se('delta_pic_order_cnt_bottom');
  } else if (sps.poc_type === 1 && !sps.delta_pic_order_always_zero) {
    r.se('delta_pic_order_cnt[0]');
    if (pps.bottom_field_pic_order_in_frame_present && !field) r.se('delta_pic_order_cnt[1]');
  }
  if (pps.redundant_pic_cnt_present) r.ue('redundant_pic_cnt');
  const st = h.slice_type % 5;
  if (st === 1) r.flag('direct_spatial_mv_pred_flag');
  if (st === 0 || st === 1 || st === 3) {
    if (r.flag('num_ref_idx_active_override_flag')) {
      r.ue('num_ref_idx_l0_active_minus1');
      if (st === 1) r.ue('num_ref_idx_l1_active_minus1');
    }
  }
  void refIdc;
  return h;
}
