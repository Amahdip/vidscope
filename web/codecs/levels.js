// Codec levels: the limits a decoder of a given level must handle (picture size, pictures or
// samples per second, bitrate, buffer and reference frames), and a check of a stream against them.
//
// Sources: ITU-T H.264 Table A-1 (and Table A-2 for the bitrate factors), ITU-T H.265 Tables A.8
// and A.9 (and A.4.2 for the DPB size), the AV1 specification Annex A.3, and the WebM project's
// VP9 level definitions (https://www.webmproject.org/vp9/levels/).

import { fmtInt, fmtNum, fmtBitrate } from '../core/util.js';

// ------------------------------------------------------------------ tables

/**
 * H.264 Table A-1. MaxMBPS in macroblocks/s, MaxFS and MaxDpbMbs in macroblocks, MaxBR in
 * cpbBrVclFactor (or cpbBrNalFactor) bits/s, MaxCPB in cpbBrVclFactor (or cpbBrNalFactor) bits.
 * Level 1b is level_idc 11 with constraint_set3_flag in Baseline/Main/Extended, level_idc 9 otherwise.
 */
export const H264_LEVELS = [
  { name: '1', idc: 10, maxMBPS: 1485, maxFS: 99, maxDpbMbs: 396, maxBR: 64, maxCPB: 175 },
  { name: '1b', idc: 9, maxMBPS: 1485, maxFS: 99, maxDpbMbs: 396, maxBR: 128, maxCPB: 350 },
  { name: '1.1', idc: 11, maxMBPS: 3000, maxFS: 396, maxDpbMbs: 900, maxBR: 192, maxCPB: 500 },
  { name: '1.2', idc: 12, maxMBPS: 6000, maxFS: 396, maxDpbMbs: 2376, maxBR: 384, maxCPB: 1000 },
  { name: '1.3', idc: 13, maxMBPS: 11880, maxFS: 396, maxDpbMbs: 2376, maxBR: 768, maxCPB: 2000 },
  { name: '2', idc: 20, maxMBPS: 11880, maxFS: 396, maxDpbMbs: 2376, maxBR: 2000, maxCPB: 2000 },
  { name: '2.1', idc: 21, maxMBPS: 19800, maxFS: 792, maxDpbMbs: 4752, maxBR: 4000, maxCPB: 4000 },
  { name: '2.2', idc: 22, maxMBPS: 20250, maxFS: 1620, maxDpbMbs: 8100, maxBR: 4000, maxCPB: 4000 },
  { name: '3', idc: 30, maxMBPS: 40500, maxFS: 1620, maxDpbMbs: 8100, maxBR: 10000, maxCPB: 10000 },
  { name: '3.1', idc: 31, maxMBPS: 108000, maxFS: 3600, maxDpbMbs: 18000, maxBR: 14000, maxCPB: 14000 },
  { name: '3.2', idc: 32, maxMBPS: 216000, maxFS: 5120, maxDpbMbs: 20480, maxBR: 20000, maxCPB: 20000 },
  { name: '4', idc: 40, maxMBPS: 245760, maxFS: 8192, maxDpbMbs: 32768, maxBR: 20000, maxCPB: 25000 },
  { name: '4.1', idc: 41, maxMBPS: 245760, maxFS: 8192, maxDpbMbs: 32768, maxBR: 50000, maxCPB: 62500 },
  { name: '4.2', idc: 42, maxMBPS: 522240, maxFS: 8704, maxDpbMbs: 34816, maxBR: 50000, maxCPB: 62500 },
  { name: '5', idc: 50, maxMBPS: 589824, maxFS: 22080, maxDpbMbs: 110400, maxBR: 135000, maxCPB: 135000 },
  { name: '5.1', idc: 51, maxMBPS: 983040, maxFS: 36864, maxDpbMbs: 184320, maxBR: 240000, maxCPB: 240000 },
  { name: '5.2', idc: 52, maxMBPS: 2073600, maxFS: 36864, maxDpbMbs: 184320, maxBR: 240000, maxCPB: 240000 },
  { name: '6', idc: 60, maxMBPS: 4177920, maxFS: 139264, maxDpbMbs: 696320, maxBR: 240000, maxCPB: 240000 },
  { name: '6.1', idc: 61, maxMBPS: 8355840, maxFS: 139264, maxDpbMbs: 696320, maxBR: 480000, maxCPB: 480000 },
  { name: '6.2', idc: 62, maxMBPS: 16711680, maxFS: 139264, maxDpbMbs: 696320, maxBR: 800000, maxCPB: 800000 },
];

/**
 * H.264 Table A-2: [cpbBrVclFactor, cpbBrNalFactor] by profile_idc. The VCL factor applies to the
 * coded picture data alone, the NAL factor to the whole stream of NAL units (what a file stores).
 * The intra and constrained variants share the factor of their base profile.
 */
export const H264_BR_FACTORS = {
  66: [1000, 1200], // Baseline, Constrained Baseline
  77: [1000, 1200], // Main
  88: [1000, 1200], // Extended
  100: [1250, 1500], // High, Progressive High, Constrained High
  110: [3000, 3600], // High 10, High 10 Intra
  122: [4000, 4800], // High 4:2:2, High 4:2:2 Intra
  244: [4000, 4800], // High 4:4:4 Predictive, High 4:4:4 Intra
  44: [4000, 4800], // CAVLC 4:4:4 Intra
};

/**
 * H.265 Tables A.8 and A.9 (Main, Main 10 and Main Still Picture). MaxLumaPs in samples,
 * MaxLumaSr in samples/s; MaxCPB (in CpbVclFactor or CpbNalFactor bits) and MaxBR (in BrVclFactor
 * or BrNalFactor bits/s) as [Main tier, High tier]. The High tier starts at level 4.
 */
export const HEVC_LEVELS = [
  { name: '1', idc: 30, maxLumaPs: 36864, maxCPB: [350, null], maxLumaSr: 552960, maxBR: [128, null] },
  { name: '2', idc: 60, maxLumaPs: 122880, maxCPB: [1500, null], maxLumaSr: 3686400, maxBR: [1500, null] },
  { name: '2.1', idc: 63, maxLumaPs: 245760, maxCPB: [3000, null], maxLumaSr: 7372800, maxBR: [3000, null] },
  { name: '3', idc: 90, maxLumaPs: 552960, maxCPB: [6000, null], maxLumaSr: 16588800, maxBR: [6000, null] },
  { name: '3.1', idc: 93, maxLumaPs: 983040, maxCPB: [10000, null], maxLumaSr: 33177600, maxBR: [10000, null] },
  { name: '4', idc: 120, maxLumaPs: 2228224, maxCPB: [12000, 30000], maxLumaSr: 66846720, maxBR: [12000, 30000] },
  { name: '4.1', idc: 123, maxLumaPs: 2228224, maxCPB: [20000, 50000], maxLumaSr: 133693440, maxBR: [20000, 50000] },
  { name: '5', idc: 150, maxLumaPs: 8912896, maxCPB: [25000, 100000], maxLumaSr: 267386880, maxBR: [25000, 100000] },
  { name: '5.1', idc: 153, maxLumaPs: 8912896, maxCPB: [40000, 160000], maxLumaSr: 534773760, maxBR: [40000, 160000] },
  { name: '5.2', idc: 156, maxLumaPs: 8912896, maxCPB: [60000, 240000], maxLumaSr: 1069547520, maxBR: [60000, 240000] },
  { name: '6', idc: 180, maxLumaPs: 35651584, maxCPB: [60000, 240000], maxLumaSr: 1069547520, maxBR: [60000, 240000] },
  { name: '6.1', idc: 183, maxLumaPs: 35651584, maxCPB: [120000, 480000], maxLumaSr: 2139095040, maxBR: [120000, 480000] },
  { name: '6.2', idc: 186, maxLumaPs: 35651584, maxCPB: [240000, 800000], maxLumaSr: 4278190080, maxBR: [240000, 800000] },
];

/** [CpbVclFactor, CpbNalFactor] (also used for MaxBR) by general_profile_idc; other profiles use other factors. */
export const HEVC_BR_FACTORS = {
  1: [1000, 1100], // Main
  2: [1000, 1100], // Main 10
  3: [1000, 1100], // Main Still Picture
};

/**
 * AV1 Annex A.3, by seq_level_idx (levels missing here are not defined). Sizes in samples, rates in
 * luma samples per second, bitrates in Mbit/s (HighMbps exists from level 4.0).
 */
export const AV1_LEVELS = [
  { name: '2.0', idx: 0, maxPicSize: 147456, maxHSize: 2048, maxVSize: 1152, maxDisplayRate: 4423680, maxDecodeRate: 5529600, mainMbps: 1.5, highMbps: null },
  { name: '2.1', idx: 1, maxPicSize: 278784, maxHSize: 2816, maxVSize: 1584, maxDisplayRate: 8363520, maxDecodeRate: 10454400, mainMbps: 3, highMbps: null },
  { name: '3.0', idx: 4, maxPicSize: 665856, maxHSize: 4352, maxVSize: 2448, maxDisplayRate: 19975680, maxDecodeRate: 24969600, mainMbps: 6, highMbps: null },
  { name: '3.1', idx: 5, maxPicSize: 1065024, maxHSize: 5504, maxVSize: 3096, maxDisplayRate: 31950720, maxDecodeRate: 39938400, mainMbps: 10, highMbps: null },
  { name: '4.0', idx: 8, maxPicSize: 2359296, maxHSize: 6144, maxVSize: 3456, maxDisplayRate: 70778880, maxDecodeRate: 77856768, mainMbps: 12, highMbps: 30 },
  { name: '4.1', idx: 9, maxPicSize: 2359296, maxHSize: 6144, maxVSize: 3456, maxDisplayRate: 141557760, maxDecodeRate: 155713536, mainMbps: 20, highMbps: 50 },
  { name: '5.0', idx: 12, maxPicSize: 8912896, maxHSize: 8192, maxVSize: 4352, maxDisplayRate: 267386880, maxDecodeRate: 273715200, mainMbps: 30, highMbps: 100 },
  { name: '5.1', idx: 13, maxPicSize: 8912896, maxHSize: 8192, maxVSize: 4352, maxDisplayRate: 534773760, maxDecodeRate: 547430400, mainMbps: 40, highMbps: 160 },
  { name: '5.2', idx: 14, maxPicSize: 8912896, maxHSize: 8192, maxVSize: 4352, maxDisplayRate: 1069547520, maxDecodeRate: 1094860800, mainMbps: 60, highMbps: 240 },
  { name: '5.3', idx: 15, maxPicSize: 8912896, maxHSize: 8192, maxVSize: 4352, maxDisplayRate: 1069547520, maxDecodeRate: 1176502272, mainMbps: 60, highMbps: 240 },
  { name: '6.0', idx: 16, maxPicSize: 35651584, maxHSize: 16384, maxVSize: 8704, maxDisplayRate: 1069547520, maxDecodeRate: 1176502272, mainMbps: 60, highMbps: 240 },
  { name: '6.1', idx: 17, maxPicSize: 35651584, maxHSize: 16384, maxVSize: 8704, maxDisplayRate: 2139095040, maxDecodeRate: 2189721600, mainMbps: 100, highMbps: 480 },
  { name: '6.2', idx: 18, maxPicSize: 35651584, maxHSize: 16384, maxVSize: 8704, maxDisplayRate: 4278190080, maxDecodeRate: 4379443200, mainMbps: 160, highMbps: 800 },
  { name: '6.3', idx: 19, maxPicSize: 35651584, maxHSize: 16384, maxVSize: 8704, maxDisplayRate: 4278190080, maxDecodeRate: 4706009088, mainMbps: 160, highMbps: 800 },
];

/** AV1 BitrateProfileFactor by seq_profile (A.3). */
export const AV1_PROFILE_FACTOR = { 0: 1, 1: 2, 2: 3 };

/**
 * VP9 levels as defined by the WebM project. Luma sample rate in samples/s, picture size in
 * samples, breadth (largest width or height) in samples, bitrate in kbit/s, CPB in kbit: the most
 * data any 4 consecutive frames may hold. The CPB of levels 5.2 and up is still "TBD".
 */
export const VP9_LEVELS = [
  { name: '1', idc: 10, maxLumaSr: 829440, maxLumaPs: 36864, maxBreadth: 512, maxBR: 200, maxCPB: 400 },
  { name: '1.1', idc: 11, maxLumaSr: 2764800, maxLumaPs: 73728, maxBreadth: 768, maxBR: 800, maxCPB: 1000 },
  { name: '2', idc: 20, maxLumaSr: 4608000, maxLumaPs: 122880, maxBreadth: 960, maxBR: 1800, maxCPB: 1500 },
  { name: '2.1', idc: 21, maxLumaSr: 9216000, maxLumaPs: 245760, maxBreadth: 1344, maxBR: 3600, maxCPB: 2800 },
  { name: '3', idc: 30, maxLumaSr: 20736000, maxLumaPs: 552960, maxBreadth: 2048, maxBR: 7200, maxCPB: 6000 },
  { name: '3.1', idc: 31, maxLumaSr: 36864000, maxLumaPs: 983040, maxBreadth: 2752, maxBR: 12000, maxCPB: 10000 },
  { name: '4', idc: 40, maxLumaSr: 83558400, maxLumaPs: 2228224, maxBreadth: 4160, maxBR: 18000, maxCPB: 16000 },
  { name: '4.1', idc: 41, maxLumaSr: 160432128, maxLumaPs: 2228224, maxBreadth: 4160, maxBR: 30000, maxCPB: 18000 },
  { name: '5', idc: 50, maxLumaSr: 311951360, maxLumaPs: 8912896, maxBreadth: 8384, maxBR: 60000, maxCPB: 36000 },
  { name: '5.1', idc: 51, maxLumaSr: 588251136, maxLumaPs: 8912896, maxBreadth: 8384, maxBR: 120000, maxCPB: 46000 },
  { name: '5.2', idc: 52, maxLumaSr: 1176502272, maxLumaPs: 8912896, maxBreadth: 8384, maxBR: 180000, maxCPB: null },
  { name: '6', idc: 60, maxLumaSr: 1176502272, maxLumaPs: 35651584, maxBreadth: 16832, maxBR: 180000, maxCPB: null },
  { name: '6.1', idc: 61, maxLumaSr: 2353004544, maxLumaPs: 35651584, maxBreadth: 16832, maxBR: 240000, maxCPB: null },
  { name: '6.2', idc: 62, maxLumaSr: 4706009088, maxLumaPs: 35651584, maxBreadth: 16832, maxBR: 480000, maxCPB: null },
];

// ------------------------------------------------------------------ measurements from the frames

/**
 * Highest bitrate (bits/s) over any `window` seconds, from frame sizes (bytes) and decode times
 * (seconds, non-decreasing). Null when the stream is shorter than the window.
 */
export function peakBitrate(sizes, times, window = 1) {
  const n = Math.min(sizes.length, times.length);
  if (n < 2 || times[n - 1] - times[0] < window * 0.999) return null;
  let best = 0;
  let sum = 0;
  let j = 0;
  for (let i = 0; i < n; i++) {
    while (j < n && times[j] < times[i] + window - 1e-9) sum += sizes[j++];
    if (sum > best) best = sum;
    sum -= sizes[i];
  }
  return (best * 8) / window;
}

/**
 * Smallest decoder buffer (bits) that plays the frames without running dry when data arrives at
 * `rate` bits/s: a leaky bucket that each frame fills with its bits and `rate` drains between
 * frames. This is the VBV/CPB constraint (with the most favourable initial buffer fullness).
 */
export function bufferNeeded(sizes, times, rate) {
  const n = Math.min(sizes.length, times.length);
  let fill = 0;
  let max = 0;
  for (let i = 0; i < n; i++) {
    if (i) fill = Math.max(0, fill - rate * Math.max(0, times[i] - times[i - 1]));
    fill += sizes[i] * 8;
    if (fill > max) max = fill;
  }
  return max;
}

/** Most bits in any `count` consecutive frames (VP9 measures its CPB this way, with 4 frames). */
export function maxRunBits(sizes, count = 4) {
  let best = 0;
  let sum = 0;
  for (let i = 0; i < sizes.length; i++) {
    sum += sizes[i];
    if (i >= count) sum -= sizes[i - count];
    if (sum > best) best = sum;
  }
  return best * 8;
}

// ------------------------------------------------------------------ level names

/** The H.264 table row for a level_idc (constraint_set3_flag marks level 1b in the lower profiles). */
export function h264Level(levelIdc, constraintSet3 = false, profileIdc = 0) {
  if (levelIdc === 9 || (levelIdc === 11 && constraintSet3 && [66, 77, 88].includes(profileIdc))) return H264_LEVELS[1];
  return H264_LEVELS.find((l) => l.idc === levelIdc && l.name !== '1b') ?? null;
}

export function hevcLevel(levelIdc) {
  return HEVC_LEVELS.find((l) => l.idc === levelIdc) ?? null;
}

export function av1Level(idx) {
  return AV1_LEVELS.find((l) => l.idx === idx) ?? null;
}

export function vp9Level(idc) {
  return VP9_LEVELS.find((l) => l.idc === idc) ?? null;
}

// ------------------------------------------------------------------ the check

const CODEC_NAMES = { avc: 'H.264', hevc: 'H.265 / HEVC', av1: 'AV1', vp9: 'VP9' };

const mbit = (bits) => `${fmtNum(bits / 1e6, bits < 1e7 ? 2 : 1)} Mbit`;

/**
 * Check a video stream against a codec level.
 *
 * `s` = { codec: 'avc'|'hevc'|'av1'|'vp9', width, height (coded picture size in luma samples),
 *   fps, bitrate (average, bits/s), frames?: { sizes (bytes), times (s, decode order) },
 *   profile, level, tier, constraintSet3, refs, dpb }
 * `level` is level_idc (H.264, HEVC), seq_level_idx (AV1) or the vpcC level (VP9, 10 × level);
 * `refs` is H.264 max_num_ref_frames; `dpb` is the decoded-picture buffering the stream declares
 * (H.264 max_dec_frame_buffering, HEVC sps_max_dec_pic_buffering).
 *
 * Returns { codec, name, signalled, limits: [{ id, label, value, max, display, maxDisplay, unit,
 * pass, soft?, text }], pass, lowest, against?, notes } where `lowest` is the lowest level whose
 * limits all hold (null if none does). The limits are those of the signalled level, or, when no
 * known level is signalled, of the lowest level that fits (`against`). A `soft` limit may be
 * exceeded briefly (a buffer absorbs it); it does not decide `pass`.
 */
export function checkLevel(s) {
  const spec = SPECS[s.codec];
  if (!spec) return null;
  const notes = [];
  const levels = spec.levels(s);
  const signalled = spec.signalled(s, notes);
  const out = { codec: s.codec, name: CODEC_NAMES[s.codec], signalled, limits: [], pass: null, lowest: null, notes, unconstrained: false };
  if (signalled?.unconstrained) {
    out.unconstrained = true;
    out.pass = true;
    notes.push(signalled.text);
    return out;
  }
  if (signalled?.row) {
    out.limits = spec.limits(s, signalled.row, notes);
    const hard = out.limits.filter((l) => !l.soft && l.pass !== null);
    out.pass = hard.length ? hard.every((l) => l.pass) : null;
  }
  for (const row of levels) {
    const lim = spec.limits(s, row, []);
    if (lim.every((l) => l.soft || l.pass !== false)) {
      out.lowest = { name: row.name, row };
      break;
    }
  }
  // Nothing (usable) signalled: show the limits of the lowest level that fits instead.
  if (!signalled?.row && out.lowest) {
    out.limits = spec.limits(s, out.lowest.row, []);
    out.against = out.lowest.name;
  }
  return out;
}

function limit(id, label, value, max, display, maxDisplay, text, extra = {}) {
  const pass = value === null || value === undefined || max === null || max === undefined ? null : value <= max * (1 + 1e-9);
  return { id, label, value, max, display, maxDisplay, pass, text, ...extra };
}

const SPECS = {
  avc: {
    levels: () => H264_LEVELS, // in order of capability, 1b between 1 and 1.1
    signalled(s, notes) {
      const row = h264Level(s.level, s.constraintSet3, s.profile);
      if (!row) {
        if (s.level !== undefined && s.level !== null) notes.push(`level_idc ${s.level} is not a level defined in H.264 Table A-1.`);
        return null;
      }
      return { name: row.name, row };
    },
    limits(s, L, notes) {
      const out = [];
      const wMb = Math.ceil(s.width / 16);
      const hMb = Math.ceil(s.height / 16);
      const mbs = wMb * hMb;
      const side = Math.floor(Math.sqrt(8 * L.maxFS));
      out.push(limit('size', 'Frame size', mbs, L.maxFS, `${fmtInt(mbs)} macroblocks (${wMb} × ${hMb})`, `${fmtInt(L.maxFS)} macroblocks`,
        'H.264 counts pictures in 16×16 macroblocks (MaxFS). A level caps the frame size so that a decoder knows how much memory one picture needs.'));
      out.push(limit('side', 'Width and height', Math.max(wMb, hMb), side, `${wMb} × ${hMb} macroblocks`, `${side} macroblocks per side`,
        'Neither side may exceed √(8 × MaxFS) macroblocks, so that very wide or very tall pictures are ruled out too.', { advanced: true }));
      if (s.fps) {
        const rate = mbs * s.fps;
        out.push(limit('rate', 'Macroblock rate', rate, L.maxMBPS, `${fmtInt(Math.round(rate))} MB/s (${fmtNum(s.fps, 3)} fps)`, `${fmtInt(L.maxMBPS)} MB/s`,
          'Macroblocks decoded per second (MaxMBPS): frame size × frame rate. It is the decoder\'s processing speed, so a bigger frame allows fewer frames per second.'));
      }
      const dpbFrames = Math.min(Math.floor(L.maxDpbMbs / mbs), 16);
      const used = Math.max(s.refs ?? 0, s.dpb ?? 0);
      if (s.refs !== undefined || s.dpb !== undefined) {
        out.push(limit('dpb', 'Reference frames', used, dpbFrames, `${used} frame${used === 1 ? '' : 's'}${s.dpb !== undefined && s.dpb !== s.refs ? ` (${s.refs ?? '?'} references, buffering ${s.dpb})` : ''}`, `${dpbFrames} frames at this size`,
          'The decoded picture buffer (MaxDpbMbs) holds the frames kept for prediction and reordering. The level fixes its size in macroblocks, so the number of reference frames allowed shrinks as the frame grows: at 1080p, level 4.1 allows 4.'));
      }
      const f = H264_BR_FACTORS[s.profile];
      if (!f) {
        if (s.profile) notes.push(`The bitrate limits of profile_idc ${s.profile} are not in Table A-2, so bitrate and buffer are not checked.`);
        return out;
      }
      const maxBr = L.maxBR * f[1];
      if (s.bitrate) {
        out.push(limit('bitrate', 'Bitrate (average)', s.bitrate, maxBr, fmtBitrate(s.bitrate), fmtBitrate(maxBr),
          `Level ${L.name} allows ${fmtBitrate(maxBr)} for this profile counting everything the stream carries (MaxBR ${fmtInt(L.maxBR)} × cpbBrNalFactor ${f[1]}), or ${fmtBitrate(L.maxBR * f[0])} counting only the coded pictures, the figure usually quoted. A file stores everything, so its bitrate is compared with the first.`));
      }
      addFrameLimits(out, s, maxBr, L.maxCPB * f[1]);
      return out;
    },
  },
  hevc: {
    levels: () => HEVC_LEVELS,
    signalled(s, notes) {
      if (s.level === 255) return { name: '8.5', unconstrained: true, text: 'Level 8.5 (level_idc 255) places no limits on the stream.' };
      const row = hevcLevel(s.level);
      if (!row) {
        if (s.level !== undefined && s.level !== null) notes.push(`general_level_idc ${s.level} is not a level defined in H.265 Table A.8.`);
        return null;
      }
      if (s.tier && !row.maxBR[1]) notes.push(`The High tier does not exist below level 4, yet level ${row.name} is signalled with the High tier.`);
      return { name: row.name, row, tier: s.tier ? 'High' : 'Main' };
    },
    limits(s, L, notes) {
      const out = [];
      const tier = s.tier ? 1 : 0;
      const ps = s.width * s.height;
      const side = Math.floor(Math.sqrt(8 * L.maxLumaPs));
      out.push(limit('size', 'Picture size', ps, L.maxLumaPs, `${fmtInt(ps)} luma samples (${s.width} × ${s.height})`, `${fmtInt(L.maxLumaPs)} samples`,
        'MaxLumaPs: the number of luma (brightness) samples in one coded picture.'));
      out.push(limit('side', 'Width and height', Math.max(s.width, s.height), side, `${s.width} × ${s.height}`, `${fmtInt(side)} per side`,
        'Neither side may exceed √(8 × MaxLumaPs) samples.', { advanced: true }));
      if (s.fps) {
        const rate = ps * s.fps;
        out.push(limit('rate', 'Luma sample rate', rate, L.maxLumaSr, `${fmtInt(Math.round(rate))} samples/s (${fmtNum(s.fps, 3)} fps)`, `${fmtInt(L.maxLumaSr)} samples/s`,
          'MaxLumaSr: luma samples decoded per second, picture size × frame rate. It is the decoder\'s processing speed.'));
      }
      if (s.dpb !== undefined) {
        const buf = 6;
        let max;
        if (ps <= L.maxLumaPs >> 2) max = Math.min(4 * buf, 16);
        else if (ps <= L.maxLumaPs >> 1) max = Math.min(2 * buf, 16);
        else if (ps <= (3 * L.maxLumaPs) >> 2) max = Math.min(Math.floor((4 * buf) / 3), 16);
        else max = buf;
        out.push(limit('dpb', 'Decoded picture buffer', s.dpb, max, `${s.dpb} picture${s.dpb === 1 ? '' : 's'}`, `${max} pictures at this size`,
          'sps_max_dec_pic_buffering: pictures the decoder must keep for reference and reordering. The allowance (maxDpbSize, A.4.2) is 6 pictures at the level\'s largest picture size and grows, up to 16, for smaller pictures.'));
      }
      const f = HEVC_BR_FACTORS[s.profile];
      if (!f) {
        if (s.profile) notes.push(`The bitrate factor of HEVC profile ${s.profile} depends on its exact format range extension, so bitrate and buffer are not checked.`);
        return out;
      }
      const br = L.maxBR[tier];
      if (!br) {
        out.push(limit('tier', 'Tier', 1, 0, 'High tier', 'Main tier only', 'The High tier (with higher bitrates) exists from level 4 up.'));
        return out;
      }
      const maxBr = br * f[1];
      if (s.bitrate) {
        out.push(limit('bitrate', 'Bitrate (average)', s.bitrate, maxBr, fmtBitrate(s.bitrate), fmtBitrate(maxBr),
          `Level ${L.name}, ${tier ? 'High' : 'Main'} tier, allows ${fmtBitrate(maxBr)} counting everything the stream carries (MaxBR ${fmtInt(br)} × BrNalFactor ${f[1]}), or ${fmtBitrate(br * f[0])} counting only the coded pictures. The tier sets the bitrate limits: the High tier allows much more, for professional uses.`));
      }
      addFrameLimits(out, s, maxBr, L.maxCPB[tier] * f[1]);
      return out;
    },
  },
  av1: {
    levels: () => AV1_LEVELS,
    signalled(s, notes) {
      if (s.level === 31) return { name: 'max', unconstrained: true, text: 'seq_level_idx 31 is the "maximum parameters" level: no level limits apply (used for very large still images).' };
      const row = av1Level(s.level);
      if (!row) {
        if (s.level !== undefined && s.level !== null) notes.push(`seq_level_idx ${s.level} is not a level defined in the AV1 specification.`);
        return null;
      }
      return { name: row.name, row, tier: s.tier && row.highMbps ? 'High' : 'Main' };
    },
    limits(s, L) {
      const out = [];
      const ps = s.width * s.height;
      out.push(limit('size', 'Picture size', ps, L.maxPicSize, `${fmtInt(ps)} samples (${s.width} × ${s.height})`, `${fmtInt(L.maxPicSize)} samples`,
        'MaxPicSize: luma samples in one frame.'));
      out.push(limit('width', 'Width', s.width, L.maxHSize, fmtInt(s.width), fmtInt(L.maxHSize), 'MaxHSize: the widest frame allowed.', { advanced: true }));
      out.push(limit('height', 'Height', s.height, L.maxVSize, fmtInt(s.height), fmtInt(L.maxVSize), 'MaxVSize: the tallest frame allowed.', { advanced: true }));
      if (s.fps) {
        const rate = ps * s.fps;
        out.push(limit('rate', 'Display sample rate', rate, L.maxDisplayRate, `${fmtInt(Math.round(rate))} samples/s (${fmtNum(s.fps, 3)} fps)`, `${fmtInt(L.maxDisplayRate)} samples/s`,
          `MaxDisplayRate: luma samples shown per second. Frames that are decoded but not shown count towards the separate MaxDecodeRate (${fmtInt(L.maxDecodeRate)} samples/s), which Vidscope does not measure.`));
      }
      const high = s.tier && L.highMbps;
      const factor = AV1_PROFILE_FACTOR[s.profile] ?? 1;
      const maxBr = (high ? L.highMbps : L.mainMbps) * 1e6 * factor;
      if (s.bitrate) {
        out.push(limit('bitrate', 'Bitrate (average)', s.bitrate, maxBr, fmtBitrate(s.bitrate), fmtBitrate(maxBr),
          `MaxBitrate is ${high ? 'HighMbps' : 'MainMbps'} (${fmtNum(high ? L.highMbps : L.mainMbps, 1)} Mbit/s) × the profile factor ${factor}. The High tier (from level 4.0) allows more.`));
      }
      addFrameLimits(out, s, maxBr, maxBr * 1);
      return out;
    },
  },
  vp9: {
    levels: () => VP9_LEVELS,
    signalled(s, notes) {
      if (!s.level) {
        notes.push('No VP9 level is signalled (the codec configuration is missing or says level 0, "undefined").');
        return null;
      }
      const row = vp9Level(s.level);
      if (!row) notes.push(`${s.level} is not a level defined by the WebM project.`);
      return row ? { name: row.name, row } : null;
    },
    limits(s, L) {
      const out = [];
      const ps = s.width * s.height;
      out.push(limit('size', 'Picture size', ps, L.maxLumaPs, `${fmtInt(ps)} samples (${s.width} × ${s.height})`, `${fmtInt(L.maxLumaPs)} samples`,
        'Max luma picture size: luma samples in one frame.'));
      out.push(limit('side', 'Width and height', Math.max(s.width, s.height), L.maxBreadth, `${s.width} × ${s.height}`, `${fmtInt(L.maxBreadth)} per side`,
        'Max luma picture breadth: neither side may be longer than this.', { advanced: true }));
      if (s.fps) {
        const rate = ps * s.fps;
        out.push(limit('rate', 'Luma sample rate', rate, L.maxLumaSr, `${fmtInt(Math.round(rate))} samples/s (${fmtNum(s.fps, 3)} fps)`, `${fmtInt(L.maxLumaSr)} samples/s`,
          'Luma samples per second. The WebM definition counts hidden alt-ref frames too, which Vidscope does not, so a stream close to the limit may exceed it.'));
      }
      if (s.bitrate) {
        out.push(limit('bitrate', 'Bitrate (average)', s.bitrate, L.maxBR * 1000, fmtBitrate(s.bitrate), fmtBitrate(L.maxBR * 1000),
          'Max bitrate: the highest average bitrate over the video.'));
      }
      if (s.frames?.sizes?.length >= 4) {
        const bits = maxRunBits(s.frames.sizes, 4);
        out.push(limit('cpb', 'Buffer (4 frames)', bits, L.maxCPB === null ? null : L.maxCPB * 1000, mbit(bits), L.maxCPB === null ? 'not yet defined' : mbit(L.maxCPB * 1000),
          'Max CPB size: the most data any 4 consecutive frames may hold (a packet with a hidden alt-ref frame counts as one frame here, so this is an upper estimate).', { advanced: true }));
      }
      return out;
    },
  },
};

/** Peak (soft) and buffer (hard) limits that need the frame table. */
function addFrameLimits(out, s, maxBr, maxBuf) {
  const fr = s.frames;
  if (!fr?.sizes?.length) return;
  const peak = peakBitrate(fr.sizes, fr.times, 1);
  if (peak !== null) {
    out.push(limit('peak', 'Bitrate (peak over 1 s)', peak, maxBr, fmtBitrate(peak), fmtBitrate(maxBr),
      'The busiest second of the stream. Going above the maximum for a moment is allowed as long as the decoder\'s buffer can absorb it (next row).', { soft: true, advanced: true }));
  }
  const need = bufferNeeded(fr.sizes, fr.times, maxBr);
  out.push(limit('buffer', 'Buffer needed', need, maxBuf, mbit(need), mbit(maxBuf),
    `A decoder receiving data at the level's maximum bitrate (${fmtBitrate(maxBr)}) needs a buffer (the CPB, or VBV on the encoder side) at least this big to play every frame on time. The level guarantees ${mbit(maxBuf)}.`, { advanced: true }));
}
