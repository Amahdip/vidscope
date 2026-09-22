// What the options x264 and x265 write into their SEI message mean, for people who know video
// but not encoder internals. Used by encoders.js.
//
// Each entry: { cat, name, what, value?(v, ctx), tradeoff?, ff?(v, ctx), key?, generic?, machine? }
//   cat       one of CATEGORIES
//   name      a friendly name
//   what      what the option controls, in plain words
//   value     what the value in this file means (ctx.get(key) reads other options, ctx.fps the frame rate)
//   tradeoff  the price of turning it up or down: quality, speed, size, compatibility
//   ff        how to set it with FFmpeg: a dedicated flag, or -x264-params / -x265-params key=value
//   key       an essential option, shown in Beginner mode
//   generic   deliberately described only in general terms (what the encoder's help says), without
//             interpreting the value
//   machine   depends on the computer that encoded, not on the video
//
// The descriptions follow `x264 --fullhelp`, `x265 --fullhelp`, the encoders' sources (x264
// common/base.c and encoder/encoder.c, x265 common/param.cpp and encoder/encoder.cpp) and FFmpeg's
// libx264/libx265 wrappers.

import { fmtInt, fmtNum } from '../core/util.js';
import { COLOUR_PRIMARIES, TRANSFER_CHARACTERISTICS, MATRIX_COEFFICIENTS } from './color.js';

export const CATEGORIES = [
  ['rate', 'Rate control', 'How the encoder decides how many bits each frame, and each part of a frame, gets: the quality or bitrate target, the buffer limits (VBV) and the look-ahead that plans ahead.'],
  ['gop', 'GOP and frame types', 'Where keyframes (I-frames) go, and how many B-frames sit between the reference frames. This decides how a player can seek and where streaming segments can be cut.'],
  ['motion', 'Motion, references and coding tools', 'How hard the encoder searches for the best way to predict each block from other frames, and which compression tools it uses. Mostly a speed-against-efficiency trade: presets change these.'],
  ['psy', 'Psychovisual, AQ and loop filters', 'Tuning for what the eye sees rather than what a metric measures: where bits go inside a frame (adaptive quantization), keeping texture and grain (psy-rd), and filters that clean up block edges.'],
  ['color', 'Colour and HDR', 'Colour description and HDR metadata written into the stream, telling players how to turn the pixel values into colours and brightness.'],
  ['misc', 'Threads and other settings', 'Parallel encoding, headers, extra messages and settings that describe the input rather than the compression.'],
];

// ------------------------------------------------------------------ helpers

const onOff = (v) => (v === '0' ? 'off' : 'on');
const yesNo = (v, on, off) => (v === '0' ? off : on);
const num = (v) => Number(v);

function frames(v, ctx) {
  const n = num(v);
  if (!ctx.fps || !Number.isFinite(n) || n <= 0) return `${fmtInt(n)} frame${n === 1 ? '' : 's'}`;
  return `${fmtInt(n)} frame${n === 1 ? '' : 's'} (${fmtNum(n / ctx.fps, 2)} s at ${fmtNum(ctx.fps, 3)} fps)`;
}

function kbps(v) {
  const n = num(v);
  return n >= 1000 ? `${fmtInt(n)} kbit/s (${fmtNum(n / 1000, 2)} Mbit/s)` : `${fmtInt(n)} kbit/s`;
}

function vbvSeconds(ctx, maxKey, bufKey) {
  const max = num(ctx.get(maxKey));
  const buf = num(ctx.get(bufKey));
  return max > 0 && buf > 0 ? `, ${fmtNum(buf / max, 2)} s of data at the maximum rate` : '';
}

const pick = (table, v) => table[v] ?? `${v} (not a value Vidscope knows)`;

// ------------------------------------------------------------------ x264

const X264_ME = { dia: 'diamond search, radius 1 (fastest)', hex: 'hexagon search, radius 2 (x264\'s default)', umh: 'uneven multi-hexagon search (slower, finds more)', esa: 'exhaustive search (very slow)', tesa: 'transformed exhaustive search (slowest)' };
const X264_SUBME = {
  0: 'full-pixel only (not recommended)', 1: 'SAD mode decision, one quarter-pixel iteration', 2: 'SATD mode decision', 3: 'more quarter-pixel refinement', 4: 'more quarter-pixel refinement', 5: 'more quarter-pixel refinement',
  6: 'rate-distortion (RD) mode decision for I/P-frames', 7: 'RD mode decision for all frames (x264\'s default)', 8: 'RD refinement for I/P-frames', 9: 'RD refinement for all frames', 10: 'QP-RD (needs trellis 2 and AQ)', 11: 'full RD with no early exits',
};
const X264_DIRECT = { 0: 'none', 1: 'spatial', 2: 'temporal', 3: 'auto' };
const X264_BPYRAMID = { 0: 'none', 1: 'strict', 2: 'normal' };
const X264_WEIGHTP = { 0: 'off', 1: 'simple (weighted references)', 2: 'smart (weighted references and duplicates, x264\'s default)' };
const X264_AQ = { 0: 'off', 1: 'variance AQ', 2: 'auto-variance AQ', 3: 'auto-variance AQ biased towards dark scenes' };

/** Partition names of x264's analyse masks (intra:inter). */
export function x264Partitions(mask) {
  const m = parseInt(mask, 16);
  if (!Number.isFinite(m)) return mask;
  const names = [];
  if (m & 0x0010) names.push('p8x8');
  if (m & 0x0020) names.push('p4x4');
  if (m & 0x0100) names.push('b8x8');
  if (m & 0x0002) names.push('i8x8');
  if (m & 0x0001) names.push('i4x4');
  return names.length ? names.join(',') : 'none';
}

function crfText(v, def, enc) {
  const n = num(v);
  const d = n === def ? `${fmtNum(n, 1)} is ${enc}'s default.` : `${enc}'s default is ${def}.`;
  return `${d} Lower values mean higher quality and larger files.`;
}

export const X264_OPTIONS = {
  // --- rate control
  rc: {
    cat: 'rate', key: true, name: 'Rate control mode',
    what: 'How x264 decides how many bits each frame gets: a constant quality target (crf), an average bitrate in one pass (abr), a constant bitrate (cbr: the average target equals the VBV maximum rate), the second pass of a two-pass encode (2pass), or fixed quantizers (cqp).',
    value: (v) => pick({ crf: 'constant quality (constant rate factor)', abr: 'average bitrate, in one pass', cbr: 'constant bitrate: the target equals vbv_maxrate', '2pass': 'second pass of a two-pass encode', cqp: 'constant quantizer' }, v),
    tradeoff: 'CRF gives the best quality for its size but no control of the size; the bitrate modes hit a size or bandwidth target with less even quality; two passes get both at twice the encoding time.',
    ff: (v, c) => ({ crf: `-crf ${c.get('crf')}`, abr: `-b:v ${c.get('bitrate')}k`, cbr: `-b:v ${c.get('bitrate')}k -maxrate ${c.get('bitrate')}k -bufsize ${c.get('vbv_bufsize')}k`, '2pass': `-b:v ${c.get('bitrate')}k with -pass 1, then -pass 2`, cqp: `-qp ${c.get('qp')}` })[v],
  },
  crf: {
    cat: 'rate', key: true, name: 'Constant rate factor (CRF)',
    what: 'The quality target of CRF mode. x264 varies the quantizer from frame to frame to keep the perceived quality even: complex, fast scenes get more bits, simple ones fewer. The file size is whatever that quality costs.',
    value: (v) => crfText(v, 23, 'x264'),
    tradeoff: 'Quality against size. FFmpeg\'s H.264 guide calls 17–28 the sane range, with 17–18 close to visually lossless, and notes that +6 roughly halves the bitrate (rough guides: the effect depends on the content).',
    ff: (v) => `-crf ${v}`,
  },
  bitrate: {
    cat: 'rate', key: true, name: 'Target bitrate',
    what: 'The average bitrate x264 aims for in ABR, CBR and two-pass modes. The file size follows from it: bitrate × duration.',
    value: (v) => kbps(v),
    tradeoff: 'A fixed budget makes the size and bandwidth predictable, but easy scenes may get more bits than they need and hard ones fewer.',
    ff: (v) => `-b:v ${v}k`,
  },
  ratetol: {
    cat: 'rate', name: 'Rate tolerance',
    what: 'The tolerance of ABR rate control and VBV (x264 --ratetol): how far the bitrate may stray from the target in the short term. Higher values allow more deviation.',
    value: (v) => (num(v) === 1 ? '1.0, x264\'s default' : v),
    ff: (v) => `-x264-params ratetol=${v}`,
  },
  qcomp: {
    cat: 'rate', name: 'Quantizer curve compression',
    what: 'How closely the bitrate follows scene complexity. 0 would give every frame the same bits (like constant bitrate); 1 the same quantizer (bits proportional to complexity). The default 0.60 lies between: hard scenes get more bits, but not proportionally more. It also sets how strongly mb-tree works.',
    value: (v) => (num(v) === 0.6 ? '0.60, x264\'s default' : `${v} (x264's default is 0.60; tune grain uses 0.80)`),
    tradeoff: 'Higher values keep quality steadier across scenes at the cost of bigger bitrate swings.',
    ff: (v) => `-qcomp ${v}`,
  },
  qpmin: {
    cat: 'rate', name: 'Minimum quantizer',
    what: 'The lowest quantizer (QP, the size of the rounding steps) rate control may use, i.e. the best quality it may spend bits on.',
    value: (v) => (num(v) === 0 ? '0: no limit' : v),
    ff: (v) => `-qmin ${v}`,
  },
  qpmax: {
    cat: 'rate', name: 'Maximum quantizer',
    what: 'The highest quantizer rate control may use, i.e. the worst quality it may fall to.',
    value: (v) => (num(v) === 69 || num(v) === 81 ? `${v}: no limit (the largest QP x264 uses at this bit depth)` : v),
    ff: (v) => `-qmax ${v}`,
  },
  qpstep: {
    cat: 'rate', name: 'Maximum QP step',
    what: 'The largest change of quantizer rate control may make from one frame to the next.',
    value: (v) => (num(v) === 4 ? '4, x264\'s default' : v),
    ff: (v) => `-qdiff ${v}`,
  },
  cplxblur: {
    cat: 'rate', generic: true, name: 'Complexity blur',
    what: 'In two-pass encoding, how much the measured complexity of frames is smoothed over time before bits are assigned (reduces quantizer fluctuations).',
    ff: (v) => `-x264-params cplxblur=${v}`,
  },
  qblur: {
    cat: 'rate', generic: true, name: 'Quantizer blur',
    what: 'In two-pass encoding, how much the frame quantizers are smoothed over time after the quantizer curve is applied.',
    ff: (v) => `-x264-params qblur=${v}`,
  },
  vbv_maxrate: {
    cat: 'rate', key: true, name: 'VBV maximum rate',
    what: 'The rate at which the decoder\'s buffer fills in the VBV model (video buffering verifier): the bandwidth x264 assumes. With vbv_bufsize it caps the bitrate: short peaks above it are allowed only as far as the buffer absorbs them.',
    value: (v, c) => `${kbps(v)}${vbvSeconds(c, 'vbv_maxrate', 'vbv_bufsize')}`,
    tradeoff: 'Protects players on limited connections or hardware from stalling, at the cost of quality in the hardest scenes, which cannot take all the bits they would like.',
    ff: (v) => `-maxrate ${v}k`,
  },
  vbv_bufsize: {
    cat: 'rate', key: true, name: 'VBV buffer size',
    what: 'The size of the decoder buffer VBV assumes. Divided by the maximum rate it gives how long a burst above that rate may last.',
    value: (v, c) => `${fmtInt(num(v))} kbit${vbvSeconds(c, 'vbv_maxrate', 'vbv_bufsize')}`,
    tradeoff: 'A larger buffer lets the bitrate swing further (better quality in hard scenes) but needs more decoder memory and a longer start-up delay; a smaller one keeps the bitrate steadier.',
    ff: (v) => `-bufsize ${v}k`,
  },
  crf_max: {
    cat: 'rate', name: 'CRF ceiling under VBV',
    what: 'With CRF and VBV together, the worst rate factor VBV may push a frame to in order to stay within the buffer; 0.0 means no limit.',
    value: (v) => (num(v) === 0 ? '0.0: no limit' : v),
    ff: (v) => `-crf_max ${v}`,
  },
  qp: {
    cat: 'rate', key: true, name: 'Constant quantizer (QP)',
    what: 'In CQP mode, the quantizer of P-frames; I-frames and B-frames get offsets from ip_ratio and pb_ratio. The quantizer sets the size of the rounding steps: small steps keep detail, big steps throw it away. qp 0 is lossless. Adaptive quantization is off in this mode.',
    value: (v) => (num(v) === 0 ? '0: lossless' : v),
    tradeoff: 'Simple and predictable for tests, but it wastes bits on easy content and gives no control of the size, which is why CRF is preferred.',
    ff: (v) => `-qp ${v}`,
  },
  nal_hrd: {
    cat: 'rate', name: 'HRD signalling',
    what: 'Whether x264 writes hypothetical reference decoder (HRD) parameters and buffering/timing SEI messages, which let a device verify the buffer model: none, vbr or cbr. Broadcast and Blu-ray need them; cbr also pads the stream with filler data.',
    value: (v) => v,
    ff: (v) => `-x264-params nal-hrd=${v}`,
  },
  filler: {
    cat: 'rate', name: 'Filler data',
    what: 'Pads the stream with filler NAL units so that the bitrate is exactly constant ("hard" CBR), as some broadcast chains require. Without it, x264\'s CBR may use less than the target on easy content.',
    value: (v) => onOff(v),
    ff: (v) => `-x264-params filler=${v}`,
  },
  ip_ratio: {
    cat: 'rate', name: 'I/P quantizer ratio',
    what: 'How much finer I-frames are quantized than P-frames. Every following frame predicts from the I-frame, so quality spent there pays off. 1.40 (the default) lowers the I-frame QP by about 3 (6 × log2 1.4).',
    value: (v) => (num(v) === 1.4 ? '1.40, x264\'s default' : `${v}: I-frame QP ${fmtNum(6 * Math.log2(num(v)), 1)} below P-frames`),
    ff: (v) => `-x264-params ipratio=${v}`,
  },
  pb_ratio: {
    cat: 'rate', name: 'P/B quantizer ratio',
    what: 'How much coarser B-frames are quantized than P-frames: fewer frames predict from B-frames, so they can afford lower quality. x264 writes it only when mb-tree is off; with mb-tree the quantizer of each block follows how much it is referenced instead.',
    value: (v) => (num(v) === 1.3 ? '1.30, x264\'s default' : v),
    ff: (v) => `-x264-params pbratio=${v}`,
  },
  mbtree: {
    cat: 'rate', key: true, name: 'Macroblock-tree rate control',
    what: 'Uses the look-ahead to measure how much each macroblock is reused as a reference by later frames, and gives more quality (a lower quantizer) to blocks many frames copy from, typically static backgrounds, and less to detail that disappears quickly.',
    value: (v) => onOff(v),
    tradeoff: 'Usually a clear efficiency gain. It needs look-ahead frames (latency and memory), so zero-latency encoding turns it off.',
    ff: (v) => `-x264-params mbtree=${v}`,
  },
  rc_lookahead: {
    cat: 'rate', key: true, name: 'Rate-control look-ahead',
    what: 'How many frames x264 analyses ahead before deciding frame types and bits (for mb-tree and VBV). x264 writes it when mb-tree or VBV is on.',
    value: (v, c) => frames(v, c),
    tradeoff: 'More look-ahead gives better decisions but delays the output by that many frames and uses more memory.',
    ff: (v) => `-rc-lookahead ${v}`,
  },
  zones: {
    cat: 'rate', generic: true, name: 'Zones',
    what: 'Frame ranges with their own quantizer or bitrate multiplier.',
    ff: (v) => `-x264-params zones=${v}`,
  },

  // --- GOP and frame types
  keyint: {
    cat: 'gop', key: true, name: 'Maximum GOP length (keyint)',
    what: 'The most frames allowed between two keyframes (IDR frames, where decoding can start from scratch). Players seek to keyframes, and streaming packagers cut segments at them.',
    value: (v, c) => (v === 'infinite' ? 'infinite: only the first frame is a keyframe' : frames(v, c)),
    tradeoff: 'Longer GOPs compress better (keyframes are expensive) but make seeking coarser and slower, and recovery from a damaged frame later. Adaptive streaming wants a keyframe at every segment boundary, for example every 2 seconds.',
    ff: (v) => (v === 'infinite' ? '-x264-params keyint=infinite' : `-g ${v}`),
  },
  keyint_min: {
    cat: 'gop', key: true, name: 'Minimum GOP length',
    what: 'A scene change detected sooner than this many frames after the last keyframe gets a plain I-frame instead of an IDR keyframe. By default x264 uses keyint ÷ 10, at most the frame rate.',
    value: (v, c) => {
      const k = num(c.get('keyint'));
      const auto = Number.isFinite(k) && c.fps ? Math.max(1, Math.min(Math.floor(k / 10), Math.floor(c.fps))) : null;
      return `${frames(v, c)}${auto === num(v) ? ', the automatic value' : ''}`;
    },
    tradeoff: 'Equal to keyint (with scene-cut detection off) it forces a perfectly regular GOP, which some streaming workflows want.',
    ff: (v) => `-keyint_min ${v}`,
  },
  scenecut: {
    cat: 'gop', key: true, name: 'Scene-cut detection',
    what: 'How eagerly x264 inserts an extra I-frame or keyframe where it detects a scene change; 0 turns detection off, the default is 40.',
    value: (v) => (num(v) === 0 ? '0: off, keyframes only every keyint frames' : num(v) === 40 ? '40, x264\'s default' : v),
    tradeoff: 'A keyframe at a cut helps quality (the new scene has nothing to predict from anyway) but makes GOP lengths irregular; streaming with fixed segments often turns it off (-sc_threshold 0).',
    ff: (v) => `-sc_threshold ${v}`,
  },
  intra_refresh: {
    cat: 'gop', name: 'Periodic intra refresh',
    what: 'Instead of whole keyframes, a column of intra-coded blocks sweeps across the picture over each keyint period. The bitrate stays smooth (no big keyframes), which suits low-latency links, but there are no clean keyframes to seek to.',
    value: (v) => onOff(v),
    ff: (v) => `-x264-params intra-refresh=${v}`,
  },
  bframes: {
    cat: 'gop', key: true, name: 'B-frames',
    what: 'The most B-frames in a row. A B-frame predicts from a frame before and a frame after it, so it is the cheapest kind of frame to code; the decoder must receive the later frame first, so frames are stored out of display order.',
    value: (v) => (num(v) === 0 ? '0: no B-frames, only I- and P-frames (lowest latency; required by the Baseline profile)' : `up to ${v} consecutive B-frames`),
    tradeoff: 'More B-frames usually save bits on static or slow content, at the cost of reordering delay; the Baseline profile does not allow them. In the Tracks tab, B-frames make decode and presentation times differ.',
    ff: (v) => `-bf ${v}`,
  },
  b_pyramid: {
    cat: 'gop', name: 'B-pyramid',
    what: 'Lets some B-frames serve as references for other B-frames (a hierarchy), which improves compression with 2 or more B-frames: 0 none, 1 strict (Blu-ray compatible), 2 normal.',
    value: (v) => pick(X264_BPYRAMID, v),
    ff: (v) => `-x264-params b-pyramid=${X264_BPYRAMID[v] ?? v}`,
  },
  b_adapt: {
    cat: 'gop', name: 'Adaptive B-frame placement',
    what: 'How x264 decides where B-frames go: 0 always uses the maximum number, 1 a fast estimate (the default), 2 an optimal search (trellis) that slows down as bframes grows.',
    value: (v) => pick({ 0: 'off: always the maximum number of B-frames', 1: 'fast', 2: 'optimal (trellis)' }, v),
    ff: (v) => `-x264-params b-adapt=${v}`,
  },
  b_bias: {
    cat: 'gop', name: 'B-frame bias',
    what: 'Makes x264 more (positive) or less (negative) inclined to use B-frames; 0 is neutral.',
    value: (v) => (num(v) === 0 ? '0: neutral' : v),
    ff: (v) => `-x264-params b-bias=${v}`,
  },
  open_gop: {
    cat: 'gop', key: true, name: 'Open GOP',
    what: 'Lets B-frames just before a keyframe reference frames on both sides of it. That keyframe is then a non-IDR I-frame with a recovery point, not a clean cut: a player starting there skips a few leading frames.',
    value: (v) => yesNo(v, 'on: open GOPs', 'off: closed GOPs, every keyframe is an IDR frame'),
    tradeoff: 'Slightly better compression, but some players, editors and segmenters handle open GOPs badly; closed GOPs are the safe choice for streaming.',
    ff: (v) => `-x264-params open-gop=${v}`,
  },

  // --- motion, references and coding tools
  cabac: {
    cat: 'motion', key: true, name: 'Entropy coding (CABAC)',
    what: 'The last, lossless step that packs all decisions into bits. CABAC (context-adaptive binary arithmetic coding) compresses better than CAVLC but is more work to decode, and the Baseline profile does not allow it.',
    value: (v) => yesNo(v, 'CABAC', 'CAVLC'),
    tradeoff: 'CABAC saves bits for more decoding effort; CAVLC is used for Baseline-profile devices and for fast decoding (tune fastdecode).',
    ff: (v) => `-x264-params cabac=${v}`,
  },
  ref: {
    cat: 'motion', key: true, name: 'Reference frames',
    what: 'How many previously decoded frames a P- or B-frame may predict from. More references help with content that repeats (flashes, back-and-forth motion, cuts between two cameras).',
    value: (v) => `${v} reference frame${v === '1' ? '' : 's'}`,
    tradeoff: 'More references cost encoding time and decoder memory (the decoded picture buffer), and the level caps them: 1080p at level 4.1 allows 4. The level check below compares this file with its level.',
    ff: (v) => `-refs ${v}`,
  },
  analyse: {
    cat: 'motion', name: 'Partitions',
    what: 'Which block sizes x264 considers when splitting a 16×16 macroblock (intra:inter bit masks): i4x4 and i8x8 for intra prediction, p8x8, p4x4 and b8x8 for motion-compensated blocks. More partitions follow detail more closely but take longer to try.',
    value: (v) => {
      const [intra, inter] = v.split(':');
      return `intra ${x264Partitions(intra)}; inter ${x264Partitions(inter)}`;
    },
    ff: (v) => `-x264-params partitions=${x264Partitions(v.split(':')[1] ?? '0')}`,
  },
  me: {
    cat: 'motion', key: true, name: 'Motion search method',
    what: 'The pattern x264 uses to search the reference frame for the best match of each block (full-pixel motion estimation).',
    value: (v) => pick(X264_ME, v),
    tradeoff: 'Wider searches find better matches in fast motion but cost encoding time; hex is the usual balance, umh is used by the slower presets.',
    ff: (v) => `-x264-params me=${v}`,
  },
  subme: {
    cat: 'motion', key: true, name: 'Subpixel refinement and mode decision',
    what: 'How much effort goes into refining motion vectors to quarter-pixel precision and into choosing between coding modes, from 0 to 11. From 6 up, decisions use rate-distortion optimization (the real bit cost and error); psy-rd only works from 6.',
    value: (v) => `${v}: ${pick(X264_SUBME, v)}`,
    tradeoff: 'One of the biggest speed-for-efficiency levers: presets range from 0 (ultrafast) to 11 (placebo).',
    ff: (v) => `-subq ${v}`,
  },
  mixed_ref: {
    cat: 'motion', name: 'Mixed references',
    what: 'Lets each 8×8 partition of a macroblock choose its own reference frame instead of one per macroblock. Only matters with more than one reference frame (x264 turns it off otherwise).',
    value: (v) => onOff(v),
    ff: (v) => `-x264-params mixed-refs=${v}`,
  },
  me_range: {
    cat: 'motion', name: 'Motion search range',
    what: 'How far, in pixels, the motion search may go from its starting point. x264 limits it to 16 for the dia and hex methods.',
    value: (v) => `${v} pixels`,
    ff: (v) => `-me_range ${v}`,
  },
  chroma_me: {
    cat: 'motion', name: 'Chroma in motion search',
    what: 'Also compares the colour planes, not just brightness, when searching for motion.',
    value: (v) => onOff(v),
    ff: (v) => `-x264-params chroma-me=${v}`,
  },
  trellis: {
    cat: 'motion', key: true, name: 'Trellis quantization',
    what: 'Chooses which transform coefficients to keep or round away by their real bit cost against the error they cause (rate-distortion optimal quantization): 0 off, 1 on the final encode of each macroblock, 2 during all mode decisions.',
    value: (v) => pick({ 0: 'off', 1: 'final encode only', 2: 'all mode decisions' }, v),
    tradeoff: 'Saves bits for encoding time; 2 is used by the slow presets.',
    ff: (v) => `-trellis ${v}`,
  },
  '8x8dct': {
    cat: 'motion', name: 'Adaptive 8×8 transform',
    what: 'Lets x264 choose between 4×4 and 8×8 transforms per macroblock. 8×8 transforms code smooth areas more efficiently; it is a High-profile tool (not in Baseline or Main).',
    value: (v) => onOff(v),
    ff: (v) => `-x264-params 8x8dct=${v}`,
  },
  cqm: {
    cat: 'motion', name: 'Quantization matrices',
    what: 'How strongly each frequency is quantized: 0 flat (every frequency alike, x264\'s default), 1 the JVT matrices, 2 custom matrices.',
    value: (v) => pick({ 0: 'flat', 1: 'JVT', 2: 'custom' }, v),
    ff: (v) => (v === '1' ? '-x264-params cqm=jvt' : v === '0' ? '-x264-params cqm=flat' : '-x264-params cqmfile=<file>'),
  },
  deadzone: {
    cat: 'motion', name: 'Quantization deadzones',
    what: 'How aggressively small coefficients (fine detail) are rounded to zero, for inter and intra blocks. x264 uses these deadzones where it does not use trellis quantization; the defaults are 21 and 11, tune grain lowers both to 6 to keep grain.',
    value: (v) => {
      const [inter, intra] = v.split(',');
      return `inter ${inter}, intra ${intra}${inter === '21' && intra === '11' ? ' (x264\'s defaults)' : ''}`;
    },
    ff: (v) => {
      const [inter, intra] = v.split(',');
      return `-x264-params deadzone-inter=${inter}:deadzone-intra=${intra}`;
    },
  },
  fast_pskip: {
    cat: 'motion', name: 'Fast P-skip',
    what: 'Decides early that a macroblock of a P-frame can simply be copied from the reference ("skip"), without trying other modes. Faster, at a very small cost in quality; only the placebo preset turns it off.',
    value: (v) => onOff(v),
    ff: (v) => `-x264-params fast-pskip=${v}`,
  },
  chroma_qp_offset: {
    cat: 'motion', name: 'Chroma QP offset',
    what: 'The quantizer difference between the colour planes and brightness. x264 lowers it by 1–2 by itself when psy-rd and psy-trellis are active, to protect colour, so the value written here is after that adjustment.',
    value: (v) => v,
    ff: () => '-chromaoffset <value before x264\'s own adjustment>',
  },
  decimate: {
    cat: 'motion', name: 'DCT decimation',
    what: 'Drops blocks of P-frames that have only a few tiny coefficients left after quantization, saving bits. Tune grain turns it off to keep grain.',
    value: (v) => onOff(v),
    ff: (v) => `-x264-params dct-decimate=${v}`,
  },
  direct: {
    cat: 'motion', name: 'Direct motion vector prediction',
    what: 'How B-frames derive the motion of "direct" blocks without coding it: spatial (from neighbouring blocks, the default), temporal (from the same block in the next reference), auto (chosen per frame, slower presets) or none.',
    value: (v) => pick(X264_DIRECT, v),
    ff: (v) => `-x264-params direct=${X264_DIRECT[v] ?? v}`,
  },
  weightb: {
    cat: 'motion', name: 'Weighted prediction for B-frames',
    what: 'Lets B-frames blend their two references with unequal weights, which helps fades and cross-fades.',
    value: (v) => onOff(v),
    ff: (v) => `-x264-params weightb=${v}`,
  },
  weightp: {
    cat: 'motion', name: 'Weighted prediction for P-frames',
    what: 'Lets P-frames scale the brightness of their reference, which saves many bits in fades and lighting changes: 0 off, 1 simple, 2 smart. The Baseline profile does not allow it.',
    value: (v) => pick(X264_WEIGHTP, v),
    ff: (v) => `-x264-params weightp=${v}`,
  },
  constrained_intra: {
    cat: 'motion', name: 'Constrained intra prediction',
    what: 'Intra-coded blocks may only predict from other intra-coded blocks. Needed for some error-resilience and scalable uses; it costs compression.',
    value: (v) => onOff(v),
    ff: (v) => `-x264-params constrained-intra=${v}`,
  },

  // --- psychovisual, AQ and loop filters
  aq: {
    cat: 'psy', key: true, name: 'Adaptive quantization (AQ)',
    what: 'Moves bits around inside each frame. Without it, flat areas (sky, walls, dark gradients) show blocks and banding while busy textures get bits the eye would not miss; AQ lowers the quantizer in flat areas and raises it in detailed ones. Written as mode:strength.',
    value: (v, c) => {
      const [m, s] = v.split(':');
      if (m === '1' && num(s) === 0 && c.get('mbtree') === '1') return 'effectively off: strength 0 (x264 keeps mode 1 because mb-tree needs AQ switched on)';
      return `${pick(X264_AQ, m)}${s !== undefined ? `, strength ${s}${num(s) === 1 ? ' (the default)' : ''}` : ''}`;
    },
    tradeoff: 'Better-looking flat areas at the cost of PSNR, which prefers uniform quantization (tune psnr turns AQ off).',
    ff: (v) => {
      const [m, s] = v.split(':');
      return `-aq-mode ${m}${s !== undefined ? ` -aq-strength ${s}` : ''}`;
    },
  },
  psy: {
    cat: 'psy', name: 'Psychovisual optimizations',
    what: 'Switches all of x264\'s psychovisual optimizations (psy-rd, psy-trellis and related tweaks), which keep detail and texture the eye notices at the expense of PSNR and SSIM scores. Tune psnr and tune ssim turn them off.',
    value: (v) => onOff(v),
    ff: (v) => `-x264-params psy=${v}`,
  },
  psy_rd: {
    cat: 'psy', key: true, name: 'Psychovisual rate-distortion (psy-rd:psy-trellis)',
    what: 'Strength of psy-rd, which makes mode decisions keep the energy (texture, grain) of the source instead of smoothing it away, and of psy-trellis, the same idea in trellis quantization. psy-rd needs subme 6 or more; psy-trellis needs trellis.',
    value: (v, c) => {
      const [rd, tr] = v.split(':');
      const notes = [];
      if (num(rd) > 0 && num(c.get('subme')) < 6) notes.push('psy-rd has no effect here because subme is below 6');
      if (num(tr) > 0 && c.get('trellis') === '0') notes.push('psy-trellis has no effect because trellis is off');
      return `psy-rd ${rd}, psy-trellis ${tr}${rd === '1.00' && tr === '0.00' ? ' (the defaults)' : ''}${notes.length ? `; ${notes.join('; ')}` : ''}`;
    },
    tradeoff: 'Higher values look sharper and keep grain but can add artefacts and lower PSNR/SSIM scores. Tunes set film 1.0:0.15, grain 1.0:0.25, animation 0.4:0.',
    ff: (v) => `-psy-rd ${v}`,
  },
  deblock: {
    cat: 'psy', key: true, name: 'Deblocking filter',
    what: 'The in-loop deblocking filter smooths the edges between blocks after decoding, inside the prediction loop, so later frames predict from the cleaned picture. Written as on:alpha:beta; the two offsets (−6 to 6) make it weaker (negative, keeps detail and grain) or stronger (positive, smoother).',
    value: (v) => {
      const [on, a, b] = v.split(':');
      if (on === '0') return 'off';
      return `on, strength offsets ${a}:${b}${a === '0' && b === '0' ? ' (neutral)' : ''}`;
    },
    tradeoff: 'Tunes set film −1:−1, grain −2:−2, animation 1:1. Turning it off (tune fastdecode) saves decoding work but shows blocking.',
    ff: (v) => {
      const [on, a, b] = v.split(':');
      return on === '0' ? '-x264-params no-deblock=1' : `-deblock ${a}:${b}`;
    },
  },
  nr: {
    cat: 'psy', name: 'Noise reduction',
    what: 'A fast noise reduction inside the encoder that estimates noise and drops small details before quantization; 0 is off. It may not match a good external denoising filter, but it costs almost nothing.',
    value: (v) => (num(v) === 0 ? '0: off' : `strength ${v}`),
    ff: (v) => `-x264-params nr=${v}`,
  },

  // --- colour and HDR
  'mastering-display': {
    cat: 'color', name: 'Mastering display (HDR10)',
    what: 'SMPTE ST 2086 mastering display colour volume: the primaries, white point and luminance range of the display the video was graded on. HDR displays use it for tone mapping.',
    value: (v) => v,
    ff: (v) => `-x264-params mastering-display=${v}`,
  },
  cll: {
    cat: 'color', name: 'Content light level (HDR10)',
    what: 'MaxCLL and MaxFALL in cd/m²: the brightest pixel and the brightest frame average of the content.',
    value: (v) => {
      const [a, b] = v.split(',');
      return `MaxCLL ${a} cd/m², MaxFALL ${b} cd/m²`;
    },
    ff: (v) => `-x264-params cll=${v}`,
  },
  crop_rect: {
    cat: 'color', generic: true, name: 'Crop rectangle',
    what: 'A cropping rectangle (left, top, right, bottom) written into the stream\'s SPS, so decoders show only part of the coded picture.',
    ff: (v) => `-x264-params crop-rect=${v}`,
  },

  // --- threads and other
  threads: {
    cat: 'misc', machine: true, name: 'Threads',
    what: 'The number of frames x264 encoded in parallel. By default it is 1.5 × the CPU cores (fewer for small pictures), so it describes the computer that encoded.',
    value: (v) => `${v} threads`,
    tradeoff: 'More threads encode faster; with frame threads, quality drops very slightly.',
    ff: (v) => `-threads ${v}`,
  },
  lookahead_threads: {
    cat: 'misc', machine: true, name: 'Look-ahead threads',
    what: 'Threads used by the look-ahead (frame-type decisions and mb-tree analysis); chosen automatically from the thread count.',
    value: (v) => v,
    ff: (v) => `-x264-params lookahead-threads=${v}`,
  },
  sliced_threads: {
    cat: 'misc', name: 'Sliced threads',
    what: 'Threads work on slices of the same frame instead of on several frames at once. No frame delay (used by tune zerolatency), but less efficient, and every frame is split into slices.',
    value: (v) => onOff(v),
    ff: (v) => `-x264-params sliced-threads=${v}`,
  },
  slices: {
    cat: 'misc', name: 'Slices per frame',
    what: 'How many independently decodable slices each frame is split into. Slices help error resilience and parallel decoding but cost compression; with sliced threads their number equals the thread count.',
    value: (v) => v,
    ff: (v) => `-x264-params slices=${v}`,
  },
  slices_max: { cat: 'misc', generic: true, name: 'Maximum slices', what: 'An absolute maximum number of slices per frame.', ff: (v) => `-x264-params slices-max=${v}` },
  slice_max_size: { cat: 'misc', generic: true, name: 'Maximum slice size', what: 'Limits each slice to this many bytes, for example to fit network packets.', ff: (v) => `-x264-params slice-max-size=${v}` },
  slice_max_mbs: { cat: 'misc', generic: true, name: 'Maximum slice length', what: 'Limits each slice to this many macroblocks.', ff: (v) => `-x264-params slice-max-mbs=${v}` },
  slice_min_mbs: { cat: 'misc', generic: true, name: 'Minimum slice length', what: 'Each slice has at least this many macroblocks.', ff: (v) => `-x264-params slice-min-mbs=${v}` },
  interlaced: {
    cat: 'misc', name: 'Interlacing',
    what: 'Whether the video was coded as interlaced fields: 0 progressive, tff or bff (top or bottom field first), or fake (progressive coded with interlaced flags, for Blu-ray).',
    value: (v) => pick({ 0: 'progressive', tff: 'interlaced, top field first', bff: 'interlaced, bottom field first', fake: 'progressive, flagged as interlaced' }, v),
    ff: (v) => (v === 'tff' ? '-flags +ildct -x264-params tff=1' : v === 'bff' ? '-flags +ildct -x264-params bff=1' : v === 'fake' ? '-x264-params fake-interlaced=1' : '(progressive: no option)'),
  },
  bluray_compat: {
    cat: 'misc', name: 'Blu-ray compatibility',
    what: 'Applies the restrictions Blu-ray players need (at most 3 B-frames, strict B-pyramid, access unit delimiters, HRD signalling and more).',
    value: (v) => onOff(v),
    ff: (v) => `-x264-params bluray-compat=${v}`,
  },
  stitchable: {
    cat: 'misc', generic: true, name: 'Stitchable',
    what: 'Keeps the headers independent of the content, so that separately encoded segments can be joined.',
    ff: (v) => `-x264-params stitchable=${v}`,
  },
  'frame-packing': {
    cat: 'misc', generic: true, name: 'Stereo frame packing',
    what: 'A frame-packing SEI message for stereoscopic 3D: 0 checkerboard, 1 column alternation, 2 row alternation, 3 side by side, 4 top-bottom, 5 frame alternation, 6 2D, 7 tile format.',
    ff: (v) => `-x264-params frame-packing=${v}`,
  },
  opencl: {
    cat: 'misc', machine: true, name: 'OpenCL look-ahead',
    what: 'Runs part of the look-ahead on the graphics card through OpenCL.',
    value: (v) => onOff(v),
    ff: (v) => `-x264-params opencl=${v}`,
  },
};

// ------------------------------------------------------------------ x265

const X265_ME = { 0: 'dia (diamond, fastest)', 1: 'hex (hexagon, x265\'s default)', 2: 'umh (uneven multi-hexagon)', 3: 'star (a three-step search from the HEVC reference encoder)', 4: 'sea (successive elimination, exhaustive but pruned)', 5: 'full (exhaustive, slowest)' };
const X265_AQ = { 0: 'off', 1: 'uniform (variance) AQ', 2: 'auto-variance AQ', 3: 'auto-variance AQ biased towards dark scenes', 4: 'auto-variance AQ with edge information' };
const X265_CSP = { 0: '4:0:0 (monochrome)', 1: '4:2:0', 2: '4:2:2', 3: '4:4:4' };
const X265_RC = { crf: 'constant quality (constant rate factor)', abr: 'average bitrate', cbr: 'constant bitrate: the target equals vbv-maxrate', cqp: 'constant quantizer' };
const X265_HASH = { 0: 'off', 1: 'MD5', 2: 'CRC', 3: 'checksum' };
const X265_VIDEOFORMAT = { 0: 'component', 1: 'PAL', 2: 'NTSC', 3: 'SECAM', 4: 'MAC', 5: 'unspecified' };

/** -x265-params spelling of a boolean option. */
const p265 = (key) => (v) => `-x265-params ${key}=${v}`;
const g = (name, what, cat = 'misc', extra = {}) => ({ cat, generic: true, name, what, ...extra });

export const X265_OPTIONS = {
  // --- rate control
  rc: {
    cat: 'rate', key: true, name: 'Rate control mode',
    what: 'How x265 decides how many bits each frame gets: constant quality (crf), an average bitrate (abr), a constant bitrate (cbr: the target equals the VBV maximum rate) or fixed quantizers (cqp). The final pass of a multi-pass encode also shows stats-read.',
    value: (v) => pick(X265_RC, v),
    tradeoff: 'CRF gives the best quality for its size but no control of the size; the bitrate modes hit a size or bandwidth target with less even quality.',
    ff: (v, c) => ({ crf: `-crf ${c.get('crf')}`, abr: `-b:v ${c.get('bitrate')}k`, cbr: `-b:v ${c.get('bitrate')}k -maxrate ${c.get('bitrate')}k -bufsize ${c.get('vbv-bufsize')}k`, cqp: `-qp ${c.get('qp')}` })[v],
  },
  crf: {
    cat: 'rate', key: true, name: 'Constant rate factor (CRF)',
    what: 'The quality target of CRF mode (0–51). x265 varies the quantizer to keep the perceived quality even: complex scenes get more bits, simple ones fewer, and the file size is whatever that costs.',
    value: (v) => crfText(v, 28, 'x265'),
    tradeoff: 'Quality against size. x265\'s scale is not x264\'s: FFmpeg\'s H.265 guide says x265\'s default 28 should look roughly like x264\'s 23 at about half the size (a rough guide).',
    ff: (v) => `-crf ${v}`,
  },
  bitrate: {
    cat: 'rate', key: true, name: 'Target bitrate',
    what: 'The average bitrate x265 aims for (ABR, CBR and multi-pass modes). The file size follows from it: bitrate × duration.',
    value: (v) => kbps(v),
    tradeoff: 'A fixed budget makes size and bandwidth predictable, but easy scenes may get more bits than they need and hard ones fewer.',
    ff: (v) => `-b:v ${v}k`,
  },
  qp: {
    cat: 'rate', key: true, name: 'Constant quantizer (QP)',
    what: 'In CQP mode, the quantizer of P-frames; I- and B-frames get offsets from ipratio and pbratio. Adaptive quantization is off in this mode.',
    value: (v) => v,
    tradeoff: 'Simple and predictable for tests, but it wastes bits and gives no control of the size.',
    ff: (v) => `-qp ${v}`,
  },
  qcomp: {
    cat: 'rate', name: 'Quantizer curve compression',
    what: 'How closely the bitrate follows scene complexity: 0 gives every frame similar bits, 1 the same quantizer (constant QP). The default 0.60 lies between.',
    value: (v) => (num(v) === 0.6 ? '0.60, x265\'s default' : v),
    tradeoff: 'Higher values keep quality steadier across scenes, with bigger bitrate swings.',
    ff: (v) => `-qcomp ${v}`,
  },
  qpstep: {
    cat: 'rate', name: 'Maximum QP step',
    what: 'The largest change of quantizer rate control may make between frames (tune grain sets 1 to avoid pulsing).',
    value: (v) => (num(v) === 4 ? '4, x265\'s default' : v),
    ff: (v) => `-qdiff ${v}`,
  },
  qpmin: { cat: 'rate', name: 'Minimum quantizer', what: 'The lowest quantizer rate control may use.', value: (v) => (num(v) === 0 ? '0: no limit' : v), ff: (v) => `-qmin ${v}` },
  qpmax: { cat: 'rate', name: 'Maximum quantizer', what: 'The highest quantizer rate control may use.', value: (v) => (num(v) === 69 ? '69: no limit (x265\'s default)' : v), ff: (v) => `-qmax ${v}` },
  'stats-write': {
    cat: 'rate', name: 'Multi-pass: writes statistics',
    what: '1 when this encode was a first (or middle) pass that recorded statistics for a later pass.',
    value: (v) => yesNo(v, 'yes: this was an analysis pass', 'no'),
    ff: () => '-pass 1',
  },
  'stats-read': {
    cat: 'rate', key: true, name: 'Multi-pass: reads statistics',
    what: 'Non-zero when this encode used the statistics of an earlier pass to distribute bits: the final pass of a two-pass encode.',
    value: (v) => yesNo(v, 'yes: this is the final pass of a multi-pass encode', 'no: single pass'),
    ff: () => '-pass 2',
  },
  cplxblur: g('Complexity blur', 'In multi-pass encoding, temporal smoothing of the measured frame complexity.', 'rate', { ff: p265('cplxblur') }),
  qblur: g('Quantizer blur', 'In multi-pass encoding, temporal smoothing of the frame quantizers.', 'rate', { ff: p265('qblur') }),
  'slow-firstpass': g('Slow first pass', 'In a first pass, whether x265 runs with the full settings (slow) instead of faster ones.', 'rate', { ff: p265('slow-firstpass') }),
  'vbv-maxrate': {
    cat: 'rate', key: true, name: 'VBV maximum rate',
    what: 'The rate at which the decoder\'s buffer fills in the VBV model: the bandwidth x265 assumes. With vbv-bufsize it caps the bitrate; short peaks are allowed only as far as the buffer absorbs them.',
    value: (v, c) => `${kbps(v)}${vbvSeconds(c, 'vbv-maxrate', 'vbv-bufsize')}`,
    tradeoff: 'Protects players on limited connections from stalling, at the cost of quality in the hardest scenes.',
    ff: (v) => `-maxrate ${v}k`,
  },
  'vbv-bufsize': {
    cat: 'rate', key: true, name: 'VBV buffer size',
    what: 'The size of the decoder buffer VBV assumes; divided by the maximum rate it gives how long a burst above that rate may last.',
    value: (v, c) => `${fmtInt(num(v))} kbit${vbvSeconds(c, 'vbv-maxrate', 'vbv-bufsize')}`,
    tradeoff: 'A larger buffer lets the bitrate swing further but needs more decoder memory and start-up delay.',
    ff: (v) => `-bufsize ${v}k`,
  },
  'vbv-init': {
    cat: 'rate', name: 'Initial VBV fullness',
    what: 'How full the decoder buffer is assumed to be when playback starts: a fraction of vbv-bufsize (or kbit when above 1). x265\'s default is 0.9; FFmpeg starts it three-quarters full (0.75, written as 0.8) unless -rc_init_occupancy is given.',
    value: (v) => v,
    ff: p265('vbv-init'),
  },
  'min-vbv-fullness': g('Minimum VBV fullness', 'The lowest buffer fullness, in percent, x265 tries to keep (default 50).', 'rate', { ff: p265('min-vbv-fullness') }),
  'max-vbv-fullness': g('Maximum VBV fullness', 'The highest buffer fullness, in percent, x265 tries to keep (default 80).', 'rate', { ff: p265('max-vbv-fullness') }),
  'vbv-end': g('Final VBV emptiness', 'How empty the buffer should be at the end of the encode (for joining segments).', 'rate', { ff: p265('vbv-end') }),
  'vbv-end-fr-adj': g('VBV end adjustment', 'From which frame x265 starts adjusting the quantizer to reach vbv-end.', 'rate', { ff: p265('vbv-end-fr-adj') }),
  'crf-max': { cat: 'rate', name: 'CRF ceiling under VBV', what: 'With CRF and VBV, the worst rate factor VBV may push to; 0 means no limit.', value: (v) => (num(v) === 0 ? '0: no limit' : v), ff: p265('crf-max') },
  'crf-min': { cat: 'rate', name: 'CRF floor under VBV', what: 'With CRF and VBV, the best rate factor x265 may use; 0 means no limit.', value: (v) => (num(v) === 0 ? '0: no limit' : v), ff: p265('crf-min') },
  ipratio: {
    cat: 'rate', name: 'I/P quantizer ratio',
    what: 'How much finer I-frames are quantized than P-frames (other frames predict from them). 1.40, the default, lowers the I-frame QP by about 3.',
    value: (v) => (num(v) === 1.4 ? '1.40, x265\'s default' : v),
    ff: p265('ipratio'),
  },
  pbratio: {
    cat: 'rate', name: 'P/B quantizer ratio',
    what: 'How much coarser B-frames are quantized than P-frames. 1.30 is the default; strict CBR and tune grain lower it to 1.0.',
    value: (v) => (num(v) === 1.3 ? '1.30, x265\'s default' : v),
    ff: p265('pbratio'),
  },
  cutree: {
    cat: 'rate', key: true, name: 'CU-tree',
    what: 'x265\'s version of x264\'s mb-tree: uses the look-ahead to measure how much each coding unit is reused as a reference by later frames, and lowers the quantizer of those that are.',
    value: (v) => onOff(v),
    tradeoff: 'Usually a clear efficiency gain; it needs look-ahead, and tune grain and zerolatency turn it off.',
    ff: p265('cutree'),
  },
  'zone-count': { cat: 'rate', name: 'Zones', what: 'How many frame ranges have their own quantizer or bitrate multiplier.', value: (v) => (v === '0' ? 'none' : v), ff: () => '-x265-params zones=<start>,<end>,q=<qp>/...' },
  zones: g('Zone settings', 'The frame ranges and their forced quantizer or bitrate multiplier.', 'rate', { ff: () => '-x265-params zones=<start>,<end>,q=<qp> or b=<factor>' }),
  'strict-cbr': { cat: 'rate', name: 'Strict CBR', what: 'Stricter control of bitrate deviations in CBR mode (it also sets pbratio to 1.0).', value: (v) => onOff(v), ff: p265('strict-cbr') },
  'qg-size': {
    cat: 'psy', name: 'Quantization group size',
    what: 'The smallest block size (64, 32, 16 or 8) that can get its own quantizer from AQ. Smaller groups let AQ adapt more finely.',
    value: (v) => `${v}×${v}`,
    ff: p265('qg-size'),
  },
  'rc-grain': {
    cat: 'rate', name: 'Grain rate control',
    what: 'A rate-control mode for film grain (turned on by tune grain) that keeps quantizers steady within and across frames, so the grain does not pulse.',
    value: (v) => onOff(v),
    ff: p265('rc-grain'),
  },
  'const-vbv': { cat: 'rate', name: 'Consistent VBV', what: 'Makes the VBV algorithm behave consistently across runs (turned on by tune grain).', value: (v) => onOff(v), ff: p265('const-vbv') },
  'hevc-aq': g('HEVC AQ', 'An alternative adaptive quantization that scales the quantizer by the spatial activity of each coding unit; it replaces aq-mode when on.', 'psy', { ff: p265('hevc-aq') }),
  'qp-adaptation-range': g('QP adaptation range', 'The range of quantizer changes of the psycho-visual QP adaptation (1.0 to 6.0).', 'psy', { ff: p265('qp-adaptation-range') }),
  'aq-motion': g('Motion AQ', 'Adapts the quantizer of each block to its motion relative to the frame.', 'psy', { ff: p265('aq-motion') }),
  'scenecut-aware-qp': g('Scene-cut aware QP', 'Raises the quantizer of frames next to a scene cut, where the change masks the loss: 0 off, 1 forward, 2 backward, 3 both.', 'rate', { ff: p265('scenecut-aware-qp') }),
  'fwd-scenecut-window': g('Forward scene-cut window', 'Duration of the forward masking window (scene-cut aware QP).', 'rate'),
  'fwd-ref-qp-delta': g('Forward reference QP delta', 'QP increase for reference frames after a scene cut (scene-cut aware QP).', 'rate'),
  'fwd-nonref-qp-delta': g('Forward non-reference QP delta', 'QP increase for non-reference frames after a scene cut (scene-cut aware QP).', 'rate'),
  'bwd-scenecut-window': g('Backward scene-cut window', 'Duration of the backward masking window (scene-cut aware QP).', 'rate'),
  'bwd-ref-qp-delta': g('Backward reference QP delta', 'QP increase for reference frames before a scene cut (scene-cut aware QP).', 'rate'),
  'bwd-nonref-qp-delta': g('Backward non-reference QP delta', 'QP increase for non-reference frames before a scene cut (scene-cut aware QP).', 'rate'),
  sbrc: g('Segment-based rate control', 'Rate control that works per segment (for fixed-length streaming segments).', 'rate', { ff: p265('sbrc') }),
  'frame-rc': g('Per-frame rate control', 'Rate control settings can be changed for each frame through the x265 API.', 'rate', { ff: p265('frame-rc') }),
  'vbv-live-multi-pass': g('Live VBV in multi-pass', 'Adjusts quantizers to the real-time VBV fullness in the second pass (experimental).', 'rate', { ff: p265('vbv-live-multi-pass') }),
  'decoder-max-rate': g('Decoder maximum rate', 'A maximum rate that can be signalled to the decoder (set through the x265 API; 0 means not set).', 'rate'),
  'rc-lookahead': {
    cat: 'rate', key: true, name: 'Look-ahead',
    what: 'How many frames x265 queues and analyses before deciding frame types (and for cu-tree). It sets the encoder\'s latency.',
    value: (v, c) => frames(v, c),
    tradeoff: 'Longer look-ahead gives better B-frame, scene-cut and cu-tree decisions, but more latency and memory.',
    ff: p265('rc-lookahead'),
  },
  'lookahead-slices': {
    cat: 'misc', name: 'Look-ahead slices',
    what: 'Splits each look-ahead cost estimate into this many slices for parallelism; x265 lowers it by itself for small pictures, so it depends on the resolution.',
    value: (v) => (v === '0' ? '0: off' : v),
    ff: p265('lookahead-slices'),
  },

  // --- GOP and frame types
  keyint: {
    cat: 'gop', key: true, name: 'Maximum GOP length (keyint)',
    what: 'The most frames allowed between two keyframes (where decoding can start). Players seek to keyframes, and streaming packagers cut segments at them.',
    value: (v, c) => (num(v) === 2147483647 || num(v) < 0 ? 'infinite: only the first frame is a keyframe' : frames(v, c)),
    tradeoff: 'Longer GOPs compress better but make seeking coarser and recovery from damage slower. Adaptive streaming wants a keyframe at every segment boundary, for example every 2 seconds.',
    ff: (v) => `-g ${v}`,
  },
  'min-keyint': {
    cat: 'gop', key: true, name: 'Minimum GOP length',
    what: 'Scene cuts closer together than this are coded as I-frames, not IDR keyframes. By default x265 uses keyint ÷ 10, at most the frame rate.',
    value: (v, c) => {
      const k = num(c.get('keyint'));
      const auto = Number.isFinite(k) && c.fps ? Math.max(1, Math.min(Math.floor(c.fps), Math.floor(k / 10))) : null;
      return `${frames(v, c)}${auto === num(v) ? ', the automatic value' : ''}`;
    },
    tradeoff: 'Equal to keyint (with scene-cut detection off) it forces a perfectly regular GOP.',
    ff: (v) => `-keyint_min ${v}`,
  },
  'open-gop': {
    cat: 'gop', key: true, name: 'Open GOP',
    what: 'Allows I-frames that are not IDR keyframes (CRA pictures): frames after them may still reference frames before them, so a player starting there skips a few leading frames.',
    value: (v) => yesNo(v, 'on: open GOPs (x265\'s default)', 'off: closed GOPs'),
    tradeoff: 'Better compression, but some players, editors and segmenters handle open GOPs badly; closed GOPs are the safe choice for streaming.',
    ff: p265('open-gop'),
  },
  scenecut: {
    cat: 'gop', key: true, name: 'Scene-cut detection',
    what: 'How eagerly x265 inserts an extra I-frame at a detected scene change; 0 turns it off, the default is 40.',
    value: (v) => (num(v) === 0 ? '0: off' : num(v) === 40 ? '40, x265\'s default' : v),
    tradeoff: 'A keyframe at a cut helps quality but makes GOP lengths irregular; fixed streaming segments often need it off.',
    ff: p265('scenecut'),
  },
  'hist-scenecut': { cat: 'gop', name: 'Histogram scene-cut detection', what: 'Detects scene cuts from picture histograms instead of the look-ahead\'s cost estimates.', value: (v) => onOff(v), ff: p265('hist-scenecut') },
  'scenecut-bias': g('Scene-cut bias', 'A bias for scene-cut detection: the percentage difference between the inter and intra cost of a frame used to decide a cut (default 5%, written here as a fraction).', 'gop', { ff: () => '-x265-params scenecut-bias=<percent>' }),
  'gop-lookahead': g('GOP look-ahead', 'Extends a GOP past keyint when a scene cut follows within this many frames, so the keyframe lands on the cut.', 'gop', { ff: p265('gop-lookahead') }),
  bframes: {
    cat: 'gop', key: true, name: 'B-frames',
    what: 'The most B-frames in a row. A B-frame predicts from frames before and after it, the cheapest kind of frame to code, so frames are stored out of display order.',
    value: (v) => (num(v) === 0 ? '0: no B-frames' : `up to ${v} consecutive B-frames`),
    tradeoff: 'More B-frames usually save bits, with more reordering delay. In the Tracks tab, B-frames make decode and presentation times differ.',
    ff: (v) => `-bf ${v}`,
  },
  'b-adapt': {
    cat: 'gop', name: 'Adaptive B-frame placement',
    what: 'How x265 places B-frames: 0 a fixed pattern of bframes B-frames, 1 a fast estimate, 2 a full trellis search (the default).',
    value: (v) => pick({ 0: 'fixed pattern', 1: 'fast', 2: 'full (trellis)' }, v),
    ff: p265('b-adapt'),
  },
  'b-pyramid': { cat: 'gop', name: 'B-pyramid', what: 'Uses the middle B-frame of a group of B-frames as a reference for the others, which improves compression.', value: (v) => onOff(v), ff: p265('b-pyramid') },
  'bframe-bias': { cat: 'gop', name: 'B-frame bias', what: 'Makes x265 more (positive) or less (negative) inclined to choose B-frames.', value: (v) => (v === '0' ? '0: neutral' : v), ff: p265('bframe-bias') },
  radl: { cat: 'gop', name: 'RADL pictures', what: 'How many frames shown just before each IDR keyframe may be coded after it, as leading pictures that stay decodable when playback starts at that keyframe (random access decodable leading pictures).', value: (v) => v, ff: p265('radl') },
  'intra-refresh': {
    cat: 'gop', name: 'Periodic intra refresh',
    what: 'Replaces keyframes by a column of intra blocks that sweeps across the picture, spreading the cost of a keyframe over many frames. Smooth bitrate for low latency, but no clean keyframes.',
    value: (v) => onOff(v),
    ff: p265('intra-refresh'),
  },
  'temporal-layers': g('Temporal layers', 'Codes unreferenced B-frames in a separate temporal sub-layer, so the stream can be decoded at a lower frame rate by dropping it.', 'gop', { ff: p265('temporal-layers') }),
  splice: g('HRD splice flag', 'Sets the concatenation flag in the buffering period SEI of the first keyframe, for splicing streams.', 'gop', { ff: p265('hrd-concat') }),
  'frame-dup': g('Frame duplication', 'Detects duplicated frames and signals them with picture timing instead of coding them again.', 'gop', { ff: p265('frame-dup') }),
  'dup-threshold': g('Duplication threshold', 'PSNR threshold above which frames count as duplicates (frame-dup).', 'gop', { ff: p265('dup-threshold') }),
  'idr-recovery-sei': g('IDR recovery SEI', 'Writes a recovery point SEI message with each IDR frame.', 'misc', { ff: p265('idr-recovery-sei') }),

  // --- motion, references and coding tools
  ref: {
    cat: 'motion', key: true, name: 'Reference frames',
    what: 'How many previously decoded frames (list 0 references) a P- or B-frame may predict from. More references help with repeating content.',
    value: (v) => `${v} reference frame${v === '1' ? '' : 's'}`,
    tradeoff: 'More references cost encoding time and decoder memory (the decoded picture buffer, which the level limits).',
    ff: (v) => `-refs ${v}`,
  },
  'limit-refs': { cat: 'motion', name: 'Limit references', what: 'Restricts which references each motion search tries, based on earlier searches: 0 none, 1 per depth, 2 per CU, 3 both. Faster, slightly less thorough.', value: (v) => v, ff: p265('limit-refs') },
  me: {
    cat: 'motion', key: true, name: 'Motion search method',
    what: 'The pattern x265 uses to search reference frames for the best match of each block.',
    value: (v) => pick(X265_ME, v),
    tradeoff: 'Wider searches find better matches in fast motion but cost time; the slow presets use star.',
    ff: (v) => `-x265-params me=${v}`,
  },
  subme: {
    cat: 'motion', key: true, name: 'Subpixel refinement',
    what: 'How much effort goes into refining motion vectors below one pixel, from 0 (least) to 7 (most).',
    value: (v) => (num(v) === 2 ? '2, x265\'s default' : v),
    tradeoff: 'Higher values find slightly better predictions at a speed cost; presets use 0 to 5.',
    ff: (v) => `-x265-params subme=${v}`,
  },
  merange: { cat: 'motion', name: 'Motion search range', what: 'How far, in pixels, the motion search may go (default 57).', value: (v) => `${v} pixels`, ff: p265('merange') },
  'temporal-mvp': { cat: 'motion', name: 'Temporal motion vector predictors', what: 'Lets motion vectors be predicted from the co-located block of a reference frame.', value: (v) => onOff(v), ff: p265('temporal-mvp') },
  hme: g('Hierarchical motion estimation', 'Searches motion at 1/16, 1/4 and full resolution in turn (3 levels).', 'motion', { ff: p265('hme') }),
  'hme-search': g('HME search methods', 'The motion search method of each HME level (L0, L1, L2).', 'motion', { ff: p265('hme-search') }),
  'hme-range': g('HME search ranges', 'The motion search range of each HME level (L0, L1, L2).', 'motion', { ff: p265('hme-range') }),
  weightp: { cat: 'motion', name: 'Weighted prediction for P-frames', what: 'Lets P-frames scale the brightness of their reference, which saves many bits in fades and lighting changes.', value: (v) => onOff(v), ff: p265('weightp') },
  weightb: { cat: 'motion', name: 'Weighted prediction for B-frames', what: 'Lets B-frames weight their references unequally, which helps cross-fades.', value: (v) => onOff(v), ff: p265('weightb') },
  'analyze-src-pics': g('Search source pictures', 'Motion estimation searches the original frames instead of the decoded ones.', 'motion', { ff: p265('analyze-src-pics') }),
  ctu: {
    cat: 'motion', key: true, name: 'CTU size',
    what: 'The size of the coding tree unit, HEVC\'s basic block (the counterpart of H.264\'s 16×16 macroblock): 64, 32 or 16 pixels square. Each CTU is split into smaller coding units where needed.',
    value: (v) => `${v}×${v}`,
    tradeoff: 'Large CTUs code smooth areas of big pictures much more efficiently; smaller ones give more rows to process in parallel (and FFmpeg picks 32 for pictures under 64 pixels).',
    ff: p265('ctu'),
  },
  'min-cu-size': { cat: 'motion', name: 'Minimum CU size', what: 'The smallest coding unit x265 splits a CTU into (64, 32, 16 or 8). Larger minimums are faster but follow detail less closely.', value: (v) => `${v}×${v}`, ff: p265('min-cu-size') },
  rect: { cat: 'motion', name: 'Rectangular partitions', what: 'Also tries splitting blocks into two rectangles (Nx2N, 2NxN) for motion prediction.', value: (v) => onOff(v), tradeoff: 'Better prediction at object edges, for encoding time (slow presets and up).', ff: p265('rect') },
  amp: { cat: 'motion', name: 'Asymmetric partitions', what: 'Also tries 25%/75% splits of blocks for motion prediction (needs rect).', value: (v) => onOff(v), ff: p265('amp') },
  'limit-modes': { cat: 'motion', name: 'Limit modes', what: 'Skips rectangular and asymmetric partitions when the costs of the four sub-blocks suggest they will not win.', value: (v) => onOff(v), ff: p265('limit-modes') },
  'max-tu-size': { cat: 'motion', name: 'Maximum TU size', what: 'The largest transform unit (32, 16, 8 or 4): the block size the residual is transformed in.', value: (v) => `${v}×${v}`, ff: p265('max-tu-size') },
  'tu-inter-depth': { cat: 'motion', name: 'TU depth (inter)', what: 'How many times the transform tree of an inter block may split beyond its coding unit (1 to 4). Deeper is more efficient and much slower.', value: (v) => v, ff: p265('tu-inter-depth') },
  'tu-intra-depth': { cat: 'motion', name: 'TU depth (intra)', what: 'How many times the transform tree of an intra block may split beyond its coding unit (1 to 4).', value: (v) => v, ff: p265('tu-intra-depth') },
  'limit-tu': g('Limit TU recursion', 'Early exits from the transform-tree search of inter blocks (0 off, 1 to 4 different rules).', 'motion', { ff: p265('limit-tu') }),
  rd: {
    cat: 'motion', key: true, name: 'RD level',
    what: 'How much rate-distortion optimization (weighing the real bit cost against the error) goes into mode and block-size decisions, from 1 (least) to 6 (full).',
    value: (v) => (num(v) === 3 ? '3, x265\'s default' : v),
    tradeoff: 'Higher levels compress better at a large speed cost; presets use 2 to 6.',
    ff: p265('rd'),
  },
  'rdoq-level': {
    cat: 'motion', name: 'RDOQ level',
    what: 'Rate-distortion optimized quantization: 0 none, 1 optimal rounding of each coefficient level, 2 also decides which 4×4 coefficient groups to drop. psy-rdoq needs 1 or 2.',
    value: (v) => pick({ 0: 'off', 1: 'levels', 2: 'levels and coding groups' }, v),
    ff: p265('rdoq-level'),
  },
  'dynamic-rd': g('Dynamic RD', 'Raises the RD effort where VBV forces the bitrate down (0 to 4).', 'motion', { ff: p265('dynamic-rd') }),
  'ssim-rd': g('SSIM RDO', 'Uses an SSIM-based distortion measure in mode decisions.', 'motion', { ff: p265('ssim-rd') }),
  signhide: { cat: 'motion', name: 'Sign bit hiding', what: 'Saves sign bits: the sign of one coefficient is not coded but inferred from the parity of the others (sign data hiding).', value: (v) => onOff(v), ff: p265('signhide') },
  tskip: { cat: 'motion', name: 'Transform skip', what: 'Lets 4×4 intra blocks be coded without the transform when that is cheaper (helps screen content and sharp graphics).', value: (v) => onOff(v), ff: p265('tskip') },
  'tskip-fast': g('Fast transform skip', 'A faster decision whether to skip the transform.', 'motion', { ff: p265('tskip-fast') }),
  'nr-intra': { cat: 'psy', name: 'Noise reduction (intra)', what: 'Strength of the encoder\'s noise reduction in intra coding units (0 to 2000; 0 is off).', value: (v) => (v === '0' ? '0: off' : v), ff: p265('nr-intra') },
  'nr-inter': { cat: 'psy', name: 'Noise reduction (inter)', what: 'Strength of the encoder\'s noise reduction in inter coding units (0 to 2000; 0 is off).', value: (v) => (v === '0' ? '0: off' : v), ff: p265('nr-inter') },
  'constrained-intra': { cat: 'motion', name: 'Constrained intra prediction', what: 'Intra blocks predict only from intra-coded neighbours; more robust to errors, with a compression penalty.', value: (v) => onOff(v), ff: p265('constrained-intra') },
  'strong-intra-smoothing': { cat: 'motion', name: 'Strong intra smoothing', what: 'Smooths the reference pixels of 32×32 intra blocks when they are flat, which avoids contouring in gradients.', value: (v) => onOff(v), ff: p265('strong-intra-smoothing') },
  'max-merge': { cat: 'motion', name: 'Merge candidates', what: 'How many neighbouring motion candidates a block may copy its motion from (1 to 5).', value: (v) => v, tradeoff: 'More candidates find better matches but cost encoding time.', ff: p265('max-merge') },
  'early-skip': { cat: 'motion', name: 'Early skip', what: 'Detects blocks that can simply be copied (skip) before trying other modes. Faster.', value: (v) => onOff(v), ff: p265('early-skip') },
  rskip: {
    cat: 'motion', name: 'Recursion skip',
    what: 'Stops splitting a CTU early: mode 1 decides by RD cost and homogeneity, mode 2 by edge density. x265 writes it as on or off; mode 2 shows as an extra rskip-edge-threshold.',
    value: (v, c) => (v === '0' ? 'off' : c.has('rskip-edge-threshold') ? 'on, mode 2 (edge density)' : 'on, mode 1 (RD cost and homogeneity)'),
    ff: (v, c) => `-x265-params rskip=${v === '0' ? 0 : c.has('rskip-edge-threshold') ? 2 : 1}`,
  },
  'rskip-edge-threshold': {
    cat: 'motion', name: 'Recursion skip threshold',
    what: 'The minimum edge density of rskip mode 2, written as a fraction (the option takes a percentage; the default is 5).',
    value: (v) => `${fmtNum(Number(v) * 100, 1)}%`,
    ff: (v) => `-x265-params rskip-edge-threshold=${Math.round(Number(v) * 100)}`,
  },
  'fast-intra': { cat: 'motion', name: 'Fast intra', what: 'A faster search for the best angular intra prediction direction.', value: (v) => onOff(v), ff: p265('fast-intra') },
  'b-intra': { cat: 'motion', name: 'Intra in B-frames', what: 'Also evaluates intra blocks in B-frames (only with rd 5 or 6).', value: (v) => onOff(v), ff: p265('b-intra') },
  'splitrd-skip': g('Split RD skip', 'Skips analysing a split of intra blocks when the unsplit cost is already lower.', 'motion', { ff: p265('splitrd-skip') }),
  rdpenalty: g('RD penalty', 'A cost penalty for 32×32 intra transforms in inter frames (0 off, 1 small, 2 full), favouring inter coding.', 'motion', { ff: p265('rdpenalty') }),
  'rd-refine': g('RD refinement', 'Refines the quantizer of the chosen blocks by RD cost (rd 5 and 6 only).', 'motion', { ff: p265('rd-refine') }),
  'cu-lossless': g('Lossless CUs', 'Considers coding each block losslessly when that is cheaper.', 'motion', { ff: p265('cu-lossless') }),
  lossless: { cat: 'rate', name: 'Lossless', what: 'Lossless coding: transform, quantization and loop filters are bypassed and the pictures are reproduced exactly.', value: (v) => onOff(v), ff: p265('lossless') },
  cbqpoffs: { cat: 'motion', name: 'Cb QP offset', what: 'Quantizer offset of the blue-difference colour plane relative to brightness.', value: (v) => v, ff: p265('cbqpoffs') },
  crqpoffs: { cat: 'motion', name: 'Cr QP offset', what: 'Quantizer offset of the red-difference colour plane relative to brightness.', value: (v) => v, ff: p265('crqpoffs') },
  'lowpass-dct': g('Low-pass DCT', 'Uses a cheaper, approximate forward transform (a low-pass subband DCT) whose results are close to the standard one.', 'motion', { ff: p265('lowpass-dct') }),
  mcstf: g('Temporal filter (MCSTF)', 'x265\'s GOP-based, motion-compensated temporal filter: a pre-filter that reduces noise before coding.', 'psy', { ff: p265('mcstf') }),

  // --- psychovisual, AQ and loop filters
  'aq-mode': {
    cat: 'psy', key: true, name: 'Adaptive quantization mode',
    what: 'Moves bits around inside each frame: flat areas (sky, walls, gradients) get a lower quantizer to avoid blocking and banding, busy textures a higher one.',
    value: (v, c) => {
      if (v === '1' && num(c.get('aq-strength')) === 0 && c.get('cutree') === '1') return 'effectively off: strength 0 (x265 keeps mode 1 because cu-tree needs AQ switched on)';
      return pick(X265_AQ, v);
    },
    tradeoff: 'Better-looking flat areas at the cost of PSNR (tune psnr sets the strength to 0).',
    ff: p265('aq-mode'),
  },
  'aq-strength': {
    cat: 'psy', key: true, name: 'AQ strength',
    what: 'How strongly AQ moves bits between flat and detailed areas (0 to 3; default 1.0).',
    value: (v) => (num(v) === 1 ? '1.00, x265\'s default' : v),
    ff: p265('aq-strength'),
  },
  'psy-rd': {
    cat: 'psy', key: true, name: 'Psychovisual RD',
    what: 'Makes mode decisions favour keeping the energy (texture, grain, sharpness) of the source over smoothing it away (0 to 5; x265\'s default is 2.0).',
    value: (v) => (num(v) === 0 ? '0: off' : num(v) === 2 ? '2.00, x265\'s default' : v),
    tradeoff: 'Higher values look sharper and keep grain but can add artefacts and lower PSNR/SSIM; tune psnr and ssim turn it off, grain raises it to 4.',
    ff: p265('psy-rd'),
  },
  'psy-rdoq': {
    cat: 'psy', name: 'Psychovisual RDOQ',
    what: 'The same idea as psy-rd, applied in quantization: keeps coefficient energy instead of zeroing it. Only works with rdoq-level 1 or 2.',
    value: (v, c) => (num(v) > 0 && c.get('rdoq-level') === '0' ? `${v}, but no effect because rdoq-level is 0` : num(v) === 0 ? '0: off' : v),
    ff: p265('psy-rdoq'),
  },
  deblock: {
    cat: 'psy', key: true, name: 'Deblocking filter',
    what: 'The in-loop deblocking filter smooths block edges after decoding, inside the prediction loop. Written as tC:beta offsets (−6 to 6): negative is weaker (keeps detail), positive stronger.',
    value: (v) => (v === '0' ? 'off' : `on, offsets ${v}${v === '0:0' ? ' (neutral)' : ''}`),
    tradeoff: 'Tune animation sets 1:1; turning it off (tune fastdecode) saves decoding work but shows blocking.',
    ff: (v) => (v === '0' ? '-x265-params no-deblock=1' : `-x265-params deblock=${v.replace(':', ',')}`),
  },
  sao: {
    cat: 'psy', key: true, name: 'Sample adaptive offset (SAO)',
    what: 'HEVC\'s second in-loop filter, after deblocking: it adds small corrections to classes of pixels (bands of brightness, or edges) to bring them closer to the source, reducing ringing and banding.',
    value: (v) => onOff(v),
    tradeoff: 'Usually improves efficiency; some turn it off for very high quality or grainy encodes, where it can smooth texture.',
    ff: p265('sao'),
  },
  'sao-non-deblock': g('SAO on non-deblocked pixels', 'SAO uses pixels before deblocking at the right and bottom CTU edges instead of skipping them.', 'psy', { ff: p265('sao-non-deblock') }),
  'selective-sao': { cat: 'psy', name: 'Selective SAO', what: 'Which frames SAO runs on: 0 none, 1 I-frames, 2 I and P, 3 all but non-reference B, 4 all (x265 sets 4 whenever SAO is on).', value: (v) => v, ff: p265('selective-sao') },
  'limit-sao': g('Limit SAO', 'Early termination of the SAO decisions to save encoding time.', 'psy', { ff: p265('limit-sao') }),

  // --- colour and HDR
  colorprim: {
    cat: 'color', name: 'Colour primaries',
    what: 'Which red, green and blue the pixel values refer to (BT.709 for HD, BT.2020 for UHD and HDR), written in the VUI.',
    value: (v) => `${v}: ${COLOUR_PRIMARIES[v] ?? 'unknown code'}`,
    ff: p265('colorprim'),
  },
  transfer: {
    cat: 'color', name: 'Transfer characteristics',
    what: 'How pixel values map to light: SDR gamma (BT.709), or HDR curves such as PQ (SMPTE ST 2084, HDR10) and HLG.',
    value: (v) => `${v}: ${TRANSFER_CHARACTERISTICS[v] ?? 'unknown code'}`,
    ff: p265('transfer'),
  },
  colormatrix: {
    cat: 'color', name: 'Colour matrix',
    what: 'How the stored Y′CbCr values convert back to RGB.',
    value: (v) => `${v}: ${MATRIX_COEFFICIENTS[v] ?? 'unknown code'}`,
    ff: p265('colormatrix'),
  },
  range: { cat: 'color', name: 'Range', what: 'Whether pixel values use the limited "TV" range (16–235 in 8 bits) or the full range.', value: (v) => yesNo(v, 'full', 'limited'), ff: (v) => `-x265-params range=${v === '1' ? 'full' : 'limited'}` },
  videoformat: { cat: 'color', name: 'Video format', what: 'The analogue format the video came from, as written in the VUI (5 means unspecified).', value: (v) => pick(X265_VIDEOFORMAT, v), ff: p265('videoformat') },
  chromaloc: { cat: 'color', name: 'Chroma location', what: 'Whether the stream says where the colour samples sit relative to the brightness samples.', value: (v) => yesNo(v, 'signalled', 'not signalled'), ff: () => '-x265-params chromaloc=<0..5>' },
  'chromaloc-top': g('Chroma location (top field)', 'The chroma sample location type of the top field.', 'color'),
  'chromaloc-bottom': g('Chroma location (bottom field)', 'The chroma sample location type of the bottom field.', 'color'),
  sar: { cat: 'color', name: 'Sample aspect ratio', what: 'The shape of each pixel, as a VUI code (1 = square pixels, 0 = unspecified, 255 = a custom ratio).', value: (v) => pick({ 0: 'unspecified', 1: 'square pixels (1:1)', 255: 'custom ratio' }, v), ff: p265('sar') },
  'sar-width:sar-height': g('Custom pixel aspect ratio', 'The width:height of each pixel when sar is 255.', 'color'),
  overscan: g('Overscan', 'Whether the stream says if the picture may be cropped by the display.', 'color'),
  'overscan-crop': g('Overscan crop', 'Whether the display should crop the overscan region.', 'color'),
  'display-window': g('Default display window', 'Whether a display window (a region of the picture to show) is signalled.', 'color', { ff: () => '-x265-params display-window=<left,top,right,bottom>' }),
  'master-display': {
    cat: 'color', name: 'Mastering display (HDR10)',
    what: 'SMPTE ST 2086 mastering display colour volume: primaries, white point and luminance range of the display the video was graded on. HDR displays use it for tone mapping.',
    value: (v) => v,
    ff: p265('master-display'),
  },
  cll: {
    cat: 'color', name: 'Content light level (HDR10)',
    what: 'MaxCLL and MaxFALL in cd/m²: the brightest pixel and the brightest frame average. 0,0 means not specified.',
    value: (v) => {
      const [a, b] = v.split(',');
      return a === '0' && b === '0' ? 'not specified' : `MaxCLL ${a} cd/m², MaxFALL ${b} cd/m²`;
    },
    ff: (v) => `-x265-params max-cll=${v}`,
  },
  hdr10: { cat: 'color', key: true, name: 'HDR10 SEI', what: 'Writes the HDR10 static metadata (mastering display and content light level SEI messages).', value: (v) => onOff(v), ff: p265('hdr10') },
  'hdr10-opt': { cat: 'color', name: 'HDR10 optimization', what: 'Block-level quantizer optimization for HDR10 content.', value: (v) => onOff(v), ff: p265('hdr10-opt') },
  'dhdr10-opt': g('Dynamic HDR10+ optimization', 'Writes HDR10+ dynamic metadata only at IDR frames and when it changes.', 'color', { ff: p265('dhdr10-opt') }),
  'min-luma': g('Minimum luma', 'Luma values below this are clipped to it.', 'color', { ff: p265('min-luma') }),
  'max-luma': g('Maximum luma', 'Luma values above this are clipped to it (by default the largest value at this bit depth).', 'color', { ff: p265('max-luma') }),
  'conformance-window-offsets': g('Conformance window', 'The right and bottom padding x265 added to reach a multiple of the minimum coding unit; decoders crop it away.', 'color'),
  'film-grain': g('Film grain SEI', 'A file of film grain characteristics written as an SEI message.', 'color'),
  'aom-film-grain': g('AOM film grain SEI', 'A file of AOM film grain characteristics written as an SEI message.', 'color'),

  // --- threads and other settings
  cpuid: g('CPU features', 'The CPU instruction sets x265 detected and used.', 'misc', { machine: true }),
  'frame-threads': { cat: 'misc', machine: true, name: 'Frame threads', what: 'How many frames x265 encoded concurrently (chosen from the CPU core count by default).', value: (v) => v, tradeoff: 'More frame threads are faster but make rate control slightly less accurate.', ff: p265('frame-threads') },
  'numa-pools': g('Thread pools', 'Threads per NUMA node of the computer.', 'misc', { machine: true }),
  wpp: { cat: 'misc', name: 'Wavefront parallel processing', what: 'Lets rows of CTUs be encoded (and decoded) in parallel, each row starting two CTUs behind the one above. It costs less than 1% of compression efficiency, according to x265\'s documentation.', value: (v) => onOff(v), ff: p265('wpp') },
  pmode: g('Parallel mode analysis', 'Uses more threads to evaluate coding modes (deprecated since x265 4.1).', 'misc', { machine: true, ff: p265('pmode') }),
  pme: g('Parallel motion estimation', 'Uses more threads for motion estimation (deprecated since x265 4.1).', 'misc', { machine: true, ff: p265('pme') }),
  psnr: g('PSNR reporting', 'Whether x265 measured PSNR while encoding (reporting only).', 'misc', { machine: true }),
  ssim: g('SSIM reporting', 'Whether x265 measured SSIM while encoding (reporting only).', 'misc', { machine: true }),
  'log-level': g('Log level', 'How much the encoder printed while running.', 'misc', { machine: true }),
  csv: g('CSV log', 'Statistics were logged to a CSV file.', 'misc', { machine: true }),
  'csv-log-level': g('CSV log level', 'Detail of the CSV statistics log.', 'misc', { machine: true }),
  bitdepth: { cat: 'misc', key: true, name: 'Bit depth', what: 'Bits per sample inside the encoder and in the stream: 8, 10 or 12. 10-bit reduces banding and is required for HDR.', value: (v) => `${v}-bit`, ff: (v) => `-pix_fmt ${v === '8' ? 'yuv420p' : `yuv420p${v}le`} (for 4:2:0)` },
  'input-csp': { cat: 'misc', name: 'Chroma subsampling', what: 'The colour format of the pictures: 4:2:0 for almost all delivery video.', value: (v) => pick(X265_CSP, v), ff: () => '-pix_fmt yuv420p / yuv422p / yuv444p (with the bit depth suffix)' },
  fps: { cat: 'misc', name: 'Frame rate', what: 'The frame rate x265 was told, as a fraction.', value: (v) => v, ff: () => '(taken from the input; -r to change it)' },
  'input-res': { cat: 'misc', name: 'Input resolution', what: 'The size of the pictures x265 received.', value: (v) => v, ff: () => '(taken from the input; -vf scale=W:H to change it)' },
  interlace: { cat: 'misc', name: 'Interlacing', what: '0 progressive; 1 or 2 interlaced fields (top or bottom first).', value: (v) => pick({ 0: 'progressive', 1: 'interlaced, top field first', 2: 'interlaced, bottom field first' }, v), ff: () => '-x265-params interlace=tff|bff' },
  field: g('Field coding', 'Codes the fields of interlaced video separately.', 'misc', { ff: p265('field') }),
  'total-frames': g('Total frames', 'The number of frames x265 was told to expect (0 when unknown, for example when reading from a pipe).', 'misc', { machine: true }),
  'chunk-start': g('Chunk start', 'The first frame of a chunk encoded on its own.', 'misc'),
  'chunk-end': g('Chunk end', 'The last frame of a chunk encoded on its own.', 'misc'),
  'level-idc': { cat: 'misc', name: 'Forced level', what: 'A minimum decoder level x265 was asked to meet; 0 means x265 chose the level itself (the level check below shows which).', value: (v) => (v === '0' ? '0: chosen automatically' : v), ff: p265('level-idc') },
  'high-tier': { cat: 'misc', name: 'High tier allowed', what: 'Whether x265 may use the High tier (higher bitrate limits) when it sets the level; the tier actually used is in the SPS.', value: (v) => yesNo(v, 'allowed', 'Main tier only'), ff: p265('high-tier') },
  'uhd-bd': { cat: 'misc', name: 'UHD Blu-ray', what: 'Applies the restrictions of UHD Blu-ray.', value: (v) => onOff(v), ff: p265('uhd-bd') },
  'allow-non-conformance': { cat: 'misc', name: 'Allow non-conformance', what: 'Lets x265 write streams that break the limits of every profile and level.', value: (v) => onOff(v), ff: p265('allow-non-conformance') },
  'repeat-headers': { cat: 'misc', name: 'Repeat headers', what: 'Repeats the VPS, SPS and PPS parameter sets at every keyframe, as streams that can be joined mid-way (MPEG-TS, live) need. MP4 and Matroska keep them once, in the codec configuration.', value: (v) => onOff(v), ff: p265('repeat-headers') },
  annexb: { cat: 'misc', name: 'Annex B start codes', what: 'Whether x265 separated NAL units with start codes (00 00 01); muxers rewrite them to length prefixes for MP4 and Matroska.', value: (v) => onOff(v) },
  aud: { cat: 'misc', name: 'Access unit delimiters', what: 'Writes a small delimiter NAL unit at the start of each frame (some broadcast and Blu-ray workflows need them).', value: (v) => onOff(v), ff: p265('aud') },
  eob: g('End of bitstream NAL', 'Writes an end-of-bitstream NAL unit at the end.', 'misc', { ff: p265('eob') }),
  eos: g('End of sequence NAL', 'Writes an end-of-sequence NAL unit at the end of each coded video sequence.', 'misc', { ff: p265('eos') }),
  hrd: { cat: 'misc', name: 'HRD signalling', what: 'Writes hypothetical reference decoder parameters and buffering/timing SEI messages that let a device verify the stream\'s buffer model.', value: (v) => onOff(v), ff: p265('hrd') },
  info: { cat: 'misc', name: 'Encoder info SEI', what: 'Writes the SEI message this list comes from: the x265 version and all its options.', value: (v) => onOff(v), ff: p265('info') },
  hash: { cat: 'misc', name: 'Decoded picture hash', what: 'Writes a checksum of every decoded picture in an SEI message, so decoders can verify their output (a debugging aid).', value: (v) => pick(X265_HASH, v), ff: p265('hash') },
  slices: { cat: 'misc', name: 'Slices per frame', what: 'How many slices each frame is split into.', value: (v) => v, ff: p265('slices') },
  'vui-timing-info': g('VUI timing info', 'Writes the frame rate into the VUI.', 'misc', { ff: p265('vui-timing-info') }),
  'vui-hrd-info': g('VUI HRD info', 'Writes HRD information into the VUI.', 'misc', { ff: p265('vui-hrd-info') }),
  'log2-max-poc-lsb': g('POC bits', 'Bits used for the picture order count in slice headers.', 'misc', { ff: p265('log2-max-poc-lsb') }),
  'opt-qp-pps': g('Optimize PPS QP', 'Picks the initial QP of the PPS from the previous GOP.', 'misc', { ff: p265('opt-qp-pps') }),
  'opt-ref-list-length-pps': g('Optimize PPS reference lists', 'Picks the reference list lengths of the PPS from the previous GOP.', 'misc', { ff: p265('opt-ref-list-length-pps') }),
  'multi-pass-opt-rps': g('Multi-pass RPS', 'Stores commonly used reference picture sets in the SPS in multi-pass mode.', 'misc', { ff: p265('multi-pass-opt-rps') }),
  'opt-cu-delta-qp': g('Optimize CU delta QP', 'Signals consistent delta QPs per coding unit (rd above 4).', 'misc', { ff: p265('opt-cu-delta-qp') }),
  'single-sei': g('Single SEI NAL', 'Writes all SEI messages of a frame into one NAL unit.', 'misc', { ff: p265('single-sei') }),
  'analysis-save': g('Analysis save', 'Saved its analysis to a file for reuse by another encode.', 'misc'),
  'analysis-load': g('Analysis load', 'Reused analysis saved by another encode.', 'misc'),
  'analysis-reuse-level': g('Analysis reuse level', 'Amount of analysis reused (deprecated).', 'misc'),
  'analysis-save-reuse-level': g('Analysis save level', 'Amount of analysis saved for reuse.', 'misc'),
  'analysis-load-reuse-level': g('Analysis load level', 'Amount of saved analysis reused.', 'misc'),
  'scale-factor': g('Analysis scale factor', 'Resolution factor between the saving and the loading encode of analysis reuse.', 'misc'),
  'refine-intra': g('Intra refinement', 'How much intra analysis is redone on top of loaded analysis.', 'misc'),
  'refine-inter': g('Inter refinement', 'How much inter analysis is redone on top of loaded analysis.', 'misc'),
  'refine-mv': g('Motion vector refinement', 'Motion vector refinement when loading analysis.', 'misc'),
  'refine-ctu-distortion': g('CTU distortion refinement', 'Stores or loads CTU distortion with the analysis.', 'misc'),
  'refine-analysis-type': g('Analysis type', 'Reuses analysis from an AVC or HEVC encoder through the API.', 'misc'),
  'dynamic-refine': g('Dynamic refinement', 'Changes the inter refinement level per block.', 'misc'),
  'ctu-info': g('CTU info', 'How x265 reacts to CTU information given through the API.', 'misc'),
  'copy-pic': g('Copy pictures', 'Whether x265 copies the input pictures into its own buffers.', 'misc', { machine: true }),
  'max-ausize-factor': g('Maximum access unit size', 'Fraction of the maximum access unit size of the specification that frames may use.', 'misc', { ff: p265('max-ausize-factor') }),
  svt: g('SVT-HEVC', 'Whether the SVT-HEVC encoder was used through x265.', 'misc'),
  alpha: g('Alpha layer', 'Encodes an alpha (transparency) channel as a second layer.', 'misc'),
  'num-views': g('Views', 'Number of views of a multiview (for example stereo) encode.', 'misc'),
  format: g('Multiview format', 'How the views of a multiview encode are arranged in the input.', 'misc'),
  scc: g('Screen content coding', 'Screen content coding extensions.', 'misc'),
};
