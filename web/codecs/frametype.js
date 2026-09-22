// What kind of picture a video frame is (I, P or B), whether other frames depend on it,
// and whether decoding can start there. This reads only the first bytes of each frame
// (the first slice header, frame header or picture header), so a whole file can be
// classified quickly; the full field-by-field decoding lives in the per-codec modules.

import { vp9Frames } from './vp9.js';
import { parseMpeg4Visual } from './mpeg4v.js';

/** Picture types. B is split by the REF / NONREF flags below. */
export const FT = { UNKNOWN: 0, I: 1, P: 2, B: 3, S: 4, REPEAT: 5 };

/** Per-frame flags. */
export const FF = {
  REF: 1, // later frames may be predicted from this one
  NONREF: 2, // known not to be used for prediction (a player may drop it)
  RAP: 4, // random access point: decoding can start here
  CLOSED: 8, // a random access point after which nothing refers back past it (IDR, key frame)
  LEADING: 16, // shown before the random access point it follows in decoding order
  SKIPPABLE: 32, // leading frame that cannot be decoded when playback starts at that point (RASL)
  HIDDEN: 64, // carries a frame that is decoded but not shown (VP9/AV1 alternate reference)
  RECOVERY: 128, // H.264 recovery point SEI: an open-GOP or gradual-refresh entry point
};

/** Codec families classifyFrame understands. */
export const FRAME_FAMILIES = new Set(['avc', 'hevc', 'av1', 'vp9', 'vp8', 'mpeg2v', 'mpeg4v', 'h263s', 'vp6', 'vp6a']);

const MORE = -1;
const NONE = 0;
const OK = 1;

/** Reads bits (and Exp-Golomb codes) from u8, removing emulation-prevention bytes when asked. */
class Bits {
  constructor(u8, start, end, epb) {
    if (epb) {
      // Strip 00 00 03 from the few bytes a header needs.
      const out = new Uint8Array(end - start);
      let w = 0;
      let zeros = 0;
      for (let i = start; i < end; i++) {
        const b = u8[i];
        if (zeros >= 2 && b === 3) {
          zeros = 0;
          continue;
        }
        out[w++] = b;
        zeros = b === 0 ? zeros + 1 : 0;
      }
      this.u = out;
      this.p = 0;
      this.end = w * 8;
    } else {
      this.u = u8;
      this.p = start * 8;
      this.end = end * 8;
    }
  }

  bit() {
    if (this.p >= this.end) throw OUT;
    const b = (this.u[this.p >> 3] >> (7 - (this.p & 7))) & 1;
    this.p++;
    return b;
  }

  bits(n) {
    let v = 0;
    for (let i = 0; i < n; i++) v = v * 2 + this.bit();
    return v;
  }

  ue() {
    let z = 0;
    while (this.bit() === 0) if (++z > 31) throw OUT;
    return z ? 2 ** z - 1 + this.bits(z) : 0;
  }
}
const OUT = new Error('out of data');

/**
 * Parsing context for one track: the codec configuration plus what earlier frames
 * told us (parameter sets sent in-band, the AV1 sequence header...).
 */
export function frameContext(codec) {
  if (!codec?.family) return null;
  const ctx = { family: codec.family, lengthSize: codec.lengthSize ?? 4, annexB: !!codec.annexB, encrypted: !!codec.encrypted, hevcPps: new Map(), av1Reduced: false, mp4v: {} };
  const st = codec.state;
  if (st?.ppsById && codec.family === 'hevc') {
    for (const [id, p] of st.ppsById) ctx.hevcPps.set(id, p.num_extra_slice_header_bits ?? 0);
  }
  if (codec.family === 'av1') ctx.av1Reduced = !!st?.seq?.reduced;
  if (codec.family === 'mpeg4v' && st) ctx.mp4v = { ...st };
  return ctx;
}

/**
 * Classify one frame. u8[start, end) is the frame; only u8[start, avail) is present.
 * Writes { type, flags, nal, layer } into `out`. Returns 1 when classified, 0 when the
 * frame holds no picture this code recognises, -1 when bytes past `avail` are needed.
 */
export function classifyFrame(ctx, u8, start, avail, end, out) {
  out.type = FT.UNKNOWN;
  out.flags = 0;
  out.nal = 0;
  out.layer = 0;
  if (!ctx || end <= start) return NONE;
  try {
    switch (ctx.family) {
      case 'avc': return nalFrame(ctx, u8, start, avail, end, out, avcNal);
      case 'hevc': return nalFrame(ctx, u8, start, avail, end, out, hevcNal);
      case 'av1': return av1Frame(ctx, u8, start, avail, end, out);
      case 'vp9': return vp9Frame(u8, start, avail, end, out);
      case 'vp8': return vp8Frame(u8, start, avail, out);
      case 'mpeg2v': return mpeg2Frame(u8, start, avail, end, out);
      case 'mpeg4v': return mpeg4Frame(ctx, u8, start, avail, end, out);
      case 'h263s': return sorensonFrame(u8, start, avail, out);
      case 'vp6':
      case 'vp6a': return vp6Frame(u8, start + (ctx.family === 'vp6a' ? 3 : 0), avail, out);
      default: return NONE;
    }
  } catch (e) {
    if (e === OUT) return avail < end ? MORE : NONE;
    throw e;
  }
}

// ------------------------------------------------------------ H.264 / H.265

/** Walk the NAL units of a frame until the first slice has been classified. */
function nalFrame(ctx, u8, start, avail, end, out, onNal) {
  const seen = { recovery: -1 };
  if (ctx.annexB) {
    let i = start;
    let s = -1;
    for (; i + 2 < avail; i++) {
      if (u8[i] !== 0 || u8[i + 1] !== 0 || u8[i + 2] !== 1) continue;
      if (s >= 0) {
        const r = onNal(ctx, u8, s, i, i, out, seen);
        if (r !== null) return r;
      }
      s = i + 3;
      i += 2;
    }
    if (s >= 0) {
      const r = onNal(ctx, u8, s, avail, avail >= end ? end : Infinity, out, seen);
      if (r !== null) return r;
    }
    return avail < end ? MORE : NONE;
  }
  const L = ctx.lengthSize;
  let p = start;
  while (p + L <= end) {
    if (p + L > avail) return MORE;
    let len = 0;
    for (let k = 0; k < L; k++) len = len * 256 + u8[p + k];
    const s = p + L;
    const e = s + len;
    if (!len || e > end) return NONE;
    if (s >= avail) return MORE;
    const r = onNal(ctx, u8, s, Math.min(e, avail), e, out, seen);
    if (r !== null) return r;
    p = e;
  }
  return NONE;
}

// onNal(ctx, u8, nalStart, availableEnd, nalEnd, out, seen) -> result, or null to continue.
// nalEnd is Infinity when the NAL may continue past the available bytes.

function avcNal(ctx, u8, s, a, e, out, seen) {
  if (s >= a) return a < e ? MORE : null;
  const hdr = u8[s];
  const type = hdr & 31;
  const refIdc = (hdr >> 5) & 3;
  if (type === 6) {
    const cnt = avcRecoveryPoint(u8, s + 1, a);
    if (cnt >= 0) seen.recovery = cnt;
    return null;
  }
  if (type !== 1 && type !== 5 && type !== 2) return null;
  out.nal = type;
  out.flags = refIdc ? FF.REF : FF.NONREF;
  if (ctx.encrypted) {
    // Common Encryption leaves only the NAL header in the clear: IDR or not, reference or not.
    out.type = type === 5 ? FT.I : FT.UNKNOWN;
    if (type === 5) out.flags |= FF.RAP | FF.CLOSED;
    return OK;
  }
  const r = new Bits(u8, s + 1, Math.min(a, s + 24), true);
  r.ue(); // first_mb_in_slice
  const st = r.ue() % 5;
  out.type = [FT.P, FT.B, FT.I, FT.S, FT.S][st];
  if (type === 5) out.flags |= FF.RAP | FF.CLOSED;
  else if (seen.recovery >= 0) {
    out.flags |= FF.RECOVERY;
    if (out.type === FT.I || seen.recovery === 0) out.flags |= FF.RAP;
  }
  out.sub = st; // 3 = SP, 4 = SI
  return OK;
}

/** recovery_frame_cnt of a recovery point SEI message in this SEI NAL, or -1. */
function avcRecoveryPoint(u8, p, a) {
  // SEI messages: payloadType and payloadSize coded as runs of 0xFF plus a last byte.
  // Emulation prevention does not affect these small numbers in practice.
  while (p < a && u8[p] !== 0x80) {
    let type = 0;
    while (p < a && u8[p] === 0xff) {
      type += 255;
      p++;
    }
    if (p >= a) return -1;
    type += u8[p++];
    let size = 0;
    while (p < a && u8[p] === 0xff) {
      size += 255;
      p++;
    }
    if (p >= a) return -1;
    size += u8[p++];
    if (type === 6) {
      try {
        return new Bits(u8, p, Math.min(a, p + 8), true).ue();
      } catch {
        return 0;
      }
    }
    p += size;
  }
  return -1;
}

function hevcNal(ctx, u8, s, a, e, out, seen) {
  if (s + 1 >= a) return a < e ? MORE : null;
  const type = (u8[s] >> 1) & 63;
  const tid = (u8[s + 1] & 7) - 1;
  if (type === 34) {
    // PPS: pps_pic_parameter_set_id, pps_seq_parameter_set_id, two flags, num_extra_slice_header_bits.
    try {
      const r = new Bits(u8, s + 2, Math.min(a, s + 16), true);
      const id = r.ue();
      r.ue();
      r.bit();
      r.bit();
      ctx.hevcPps.set(id, r.bits(3));
    } catch {
      // a truncated PPS: keep what we had
    }
    return null;
  }
  if (type > 31) return null;
  const r = new Bits(u8, s + 2, Math.min(a, s + 32), true);
  const first = r.bit();
  if (type >= 16 && type <= 23) r.bit(); // no_output_of_prior_pics_flag
  const pps = r.ue();
  out.nal = type;
  out.layer = Math.max(0, tid);
  out.flags = type <= 14 && type % 2 === 0 ? FF.NONREF : FF.REF;
  if (type === 19 || type === 20) out.flags |= FF.RAP | FF.CLOSED;
  else if (type >= 16 && type <= 23) out.flags |= FF.RAP;
  if (type === 6 || type === 7) out.flags |= FF.LEADING;
  if (type === 8 || type === 9) out.flags |= FF.LEADING | FF.SKIPPABLE;
  if (ctx.encrypted) {
    // Common Encryption leaves only the NAL header in the clear.
    out.type = type >= 16 && type <= 23 ? FT.I : FT.UNKNOWN;
    return OK;
  }
  if (!first) {
    // Not the first slice segment of the picture (should not happen for the first VCL NAL).
    out.type = type >= 16 && type <= 23 ? FT.I : FT.UNKNOWN;
    return OK;
  }
  const extra = ctx.hevcPps.get(pps) ?? 0;
  for (let i = 0; i < extra; i++) r.bit();
  out.type = [FT.B, FT.P, FT.I][r.ue()] ?? FT.UNKNOWN;
  return OK;
}

// ------------------------------------------------------------ AV1

function leb128(u8, p, a) {
  let v = 0;
  for (let i = 0; i < 8; i++) {
    if (p + i >= a) return null;
    const b = u8[p + i];
    v += (b & 0x7f) * 2 ** (7 * i);
    if (!(b & 0x80)) return { v, n: i + 1 };
  }
  return null;
}

function av1Frame(ctx, u8, start, avail, end, out) {
  let p = start;
  let shown = null;
  let hidden = false;
  let keyShown = false;
  while (p < end) {
    if (p >= avail) return MORE;
    const b = u8[p];
    const type = (b >> 3) & 15;
    const ext = (b >> 2) & 1;
    const hasSize = (b >> 1) & 1;
    let q = p + 1 + ext;
    let size;
    if (hasSize) {
      const l = leb128(u8, q, avail);
      if (!l) return avail < end ? MORE : NONE;
      q += l.n;
      size = l.v;
    } else size = end - q;
    const tid = ext && p + 1 < avail ? u8[p + 1] >> 5 : 0;
    if (type === 1) {
      // sequence header: seq_profile(3) still_picture(1) reduced_still_picture_header(1)
      if (q >= avail) return MORE;
      ctx.av1Reduced = !!((u8[q] >> 3) & 1);
    } else if (type === 3 || type === 6) {
      if (q >= avail) return MORE;
      const f = av1FrameHeader(ctx, u8, q, Math.min(avail, q + size));
      if (f.showExisting || f.show) {
        shown = { ...f, tid };
        if (f.show && f.frameType === 0) keyShown = true;
      } else hidden = true;
    }
    p = q + size;
  }
  if (!shown) return NONE;
  out.layer = shown.tid;
  if (shown.showExisting) {
    out.type = FT.REPEAT;
    out.nal = 4;
  } else {
    out.type = [FT.I, FT.P, FT.I, FT.S][shown.frameType];
    out.nal = shown.frameType;
    if (keyShown) out.flags |= FF.RAP | FF.CLOSED | FF.REF;
  }
  if (hidden) out.flags |= FF.HIDDEN;
  return OK;
}

function av1FrameHeader(ctx, u8, p, a) {
  if (ctx.av1Reduced) return { showExisting: false, frameType: 0, show: true };
  const r = new Bits(u8, p, a, false);
  if (r.bit()) return { showExisting: true, frameType: -1, show: true };
  const frameType = r.bits(2);
  return { showExisting: false, frameType, show: !!r.bit() };
}

// ------------------------------------------------------------ VP9 / VP8

function vp9Frame(u8, start, avail, end, out) {
  // The superframe index sits at the end of the packet, so the whole packet is needed.
  if (avail < end) return MORE;
  const { frames } = vp9Frames(u8, start, end);
  let shown = null;
  let hidden = false;
  for (const f of frames) {
    const h = vp9Header(u8, f.start, f.end);
    if (!h) continue;
    if (h.show || h.showExisting) shown = h;
    else hidden = true;
  }
  if (!shown) return NONE;
  if (shown.showExisting) {
    out.type = FT.REPEAT;
    out.nal = 3;
  } else if (shown.key) {
    out.type = FT.I;
    out.nal = 0;
    out.flags |= FF.RAP | FF.CLOSED | FF.REF;
  } else {
    out.type = shown.intraOnly ? FT.I : FT.P;
    out.nal = shown.intraOnly ? 2 : 1;
    if (shown.refresh !== undefined) out.flags |= shown.refresh ? FF.REF : FF.NONREF;
  }
  if (hidden) out.flags |= FF.HIDDEN;
  return OK;
}

function vp9Header(u8, s, e) {
  try {
    const r = new Bits(u8, s, Math.min(e, s + 16), false);
    if (r.bits(2) !== 2) return null; // frame_marker
    const profile = r.bit() + 2 * r.bit();
    if (profile === 3) r.bit();
    if (r.bit()) return { showExisting: true };
    const key = r.bit() === 0;
    const show = !!r.bit();
    const errorRes = r.bit();
    if (key) return { key: true, show };
    const intraOnly = show ? 0 : r.bit();
    if (!errorRes) r.bits(2); // reset_frame_context
    if (intraOnly) return { key: false, show, intraOnly: true };
    return { key: false, show, intraOnly: false, refresh: r.bits(8) };
  } catch {
    return null;
  }
}

function vp8Frame(u8, start, avail, out) {
  if (avail - start < 3) return MORE;
  const b = u8[start];
  const key = (b & 1) === 0;
  const show = (b >> 4) & 1;
  out.type = key ? FT.I : FT.P;
  out.nal = key ? 0 : 1;
  if (key) out.flags |= FF.RAP | FF.CLOSED | FF.REF;
  if (!show) out.flags |= FF.HIDDEN;
  return OK;
}

// ------------------------------------------------------------ Flash-era codecs (FLV)

/** Sorenson Spark (the H.263 variant in FLV): picture type 0 intra, 1 inter, 2 disposable inter. */
function sorensonFrame(u8, start, avail, out) {
  const r = new Bits(u8, start, Math.min(avail, start + 16), false);
  if (r.bits(17) !== 1) return NONE; // picture start code
  r.bits(5); // version
  r.bits(8); // temporal reference
  const size = r.bits(3);
  if (size === 0) r.bits(16);
  else if (size === 1) r.bits(32);
  const pt = r.bits(2);
  out.type = pt === 0 ? FT.I : pt <= 2 ? FT.P : FT.UNKNOWN;
  out.nal = pt;
  out.flags = pt === 0 ? FF.RAP | FF.CLOSED | FF.REF : pt === 1 ? FF.REF : pt === 2 ? FF.NONREF : 0;
  return OK;
}

/** On2 VP6: the first bit of a frame is 0 for an intra (key) frame. */
function vp6Frame(u8, p, avail, out) {
  if (p >= avail) return MORE;
  const key = (u8[p] & 0x80) === 0;
  out.type = key ? FT.I : FT.P;
  out.nal = key ? 0 : 1;
  if (key) out.flags |= FF.RAP | FF.CLOSED | FF.REF;
  return OK;
}

// ------------------------------------------------------------ MPEG-2 / MPEG-4 Part 2

function mpeg2Frame(u8, start, avail, end, out) {
  let gop = null;
  let seq = false;
  for (let i = start; i + 5 < avail; i++) {
    if (u8[i] !== 0 || u8[i + 1] !== 0 || u8[i + 2] !== 1) continue;
    const code = u8[i + 3];
    if (code === 0xb3) seq = true;
    else if (code === 0xb8 && i + 7 < avail) gop = { closed: (u8[i + 7] >> 6) & 1, broken: (u8[i + 7] >> 5) & 1 };
    else if (code === 0x00) {
      const t = (u8[i + 5] >> 3) & 7;
      out.type = t === 1 || t === 4 ? FT.I : t === 2 ? FT.P : t === 3 ? FT.B : FT.UNKNOWN;
      out.nal = t;
      out.flags = out.type === FT.B ? FF.NONREF : FF.REF;
      if (out.type === FT.I && (gop || seq)) out.flags |= FF.RAP | (gop?.closed ? FF.CLOSED : 0);
      return OK;
    }
    i += 3;
  }
  return avail < end ? MORE : NONE;
}

function mpeg4Frame(ctx, u8, start, avail, end, out) {
  let gov = null;
  for (let i = start; i + 6 < avail; i++) {
    if (u8[i] === 0 && u8[i + 1] === 0 && u8[i + 2] === 1 && u8[i + 3] === 0xb3) {
      gov = { closed: (u8[i + 6] >> 5) & 1 };
      break;
    }
    if (u8[i] === 0 && u8[i + 1] === 0 && u8[i + 2] === 1 && u8[i + 3] === 0xb6) break;
  }
  const res = parseMpeg4Visual(u8, start, Math.min(avail, start + 4096), 0, ctx.mp4v);
  const vop = res.vops[0];
  if (!vop) return avail < end ? MORE : NONE;
  const map = { I: FT.I, P: FT.P, B: FT.B, S: FT.S };
  out.type = vop.coded === 0 ? FT.REPEAT : map[vop.type] ?? FT.UNKNOWN;
  out.nal = res.vops.length > 1 ? 2 : 1; // 2 = packed bitstream: two VOPs in one frame
  out.flags = vop.type === 'B' ? FF.NONREF : vop.coded === 0 ? 0 : FF.REF;
  if (vop.type === 'I' && vop.coded !== 0) out.flags |= FF.RAP | (gov?.closed ? FF.CLOSED : 0);
  return OK;
}

// ------------------------------------------------------------ names and explanations

/** One letter per frame: I, P, B (reference B), b (B nothing refers to), S, = (repeat), ? */
export function typeLetter(type, flags) {
  switch (type) {
    case FT.I: return 'I';
    case FT.P: return flags & FF.NONREF ? 'p' : 'P';
    case FT.B: return flags & FF.REF ? 'B' : 'b';
    case FT.S: return 'S';
    case FT.REPEAT: return '=';
    default: return '?';
  }
}

const HEVC_NAMES = {
  0: 'TRAIL_N', 1: 'TRAIL_R', 2: 'TSA_N', 3: 'TSA_R', 4: 'STSA_N', 5: 'STSA_R', 6: 'RADL_N', 7: 'RADL_R', 8: 'RASL_N', 9: 'RASL_R',
  16: 'BLA_W_LP', 17: 'BLA_W_RADL', 18: 'BLA_N_LP', 19: 'IDR_W_RADL', 20: 'IDR_N_LP', 21: 'CRA',
};
const AV1_TYPES = ['KEY_FRAME', 'INTER_FRAME', 'INTRA_ONLY_FRAME', 'SWITCH_FRAME', 'show_existing_frame'];
const VP9_TYPES = ['key frame', 'inter frame', 'intra-only frame', 'show-existing frame'];

/** The codec's own name for what the frame header says (IDR slice, CRA, KEY_FRAME...). */
export function codecTypeName(family, nal) {
  switch (family) {
    case 'avc': return nal === 5 ? 'IDR slice (nal_unit_type 5)' : nal === 2 ? 'slice data partition A' : 'non-IDR slice (nal_unit_type 1)';
    case 'hevc': return `${HEVC_NAMES[nal] ?? `type ${nal}`} (nal_unit_type ${nal})`;
    case 'av1': return AV1_TYPES[nal] ?? '?';
    case 'vp9': return VP9_TYPES[nal] ?? '?';
    case 'vp8': return nal === 0 ? 'key frame' : 'inter frame';
    case 'mpeg2v': return ['', 'I picture', 'P picture', 'B picture', 'D picture'][nal] ?? '?';
    case 'mpeg4v': return nal === 2 ? 'packed: two VOPs in one frame' : 'VOP';
    case 'h263s': return ['intra frame', 'inter frame', 'disposable inter frame'][nal] ?? '?';
    case 'vp6':
    case 'vp6a': return nal === 0 ? 'intra (key) frame' : 'inter frame';
    default: return '';
  }
}

/** Short label such as "IDR I-frame" or "B-frame (not a reference)". */
export function frameLabel(family, type, flags) {
  const base = { [FT.I]: 'I-frame', [FT.P]: 'P-frame', [FT.B]: 'B-frame', [FT.S]: 'S-frame', [FT.REPEAT]: 'repeated frame' }[type] ?? 'frame (type unknown)';
  const parts = [];
  if (type === FT.I && flags & FF.CLOSED) parts.push(family === 'avc' || family === 'hevc' ? 'IDR' : 'key');
  else if (flags & FF.RAP) parts.push(family === 'hevc' ? 'CRA' : 'open-GOP');
  let label = parts.length ? `${parts.join(' ')} ${base}` : base;
  if (type === FT.B) label += flags & FF.REF ? ' (reference)' : flags & FF.NONREF ? ' (not a reference)' : '';
  if (flags & FF.HIDDEN) label += ' + hidden frame';
  return label;
}

/** Plain-language explanation of a frame's type, for tooltips and the inspector. */
export function explainFrame(family, type, flags) {
  const lines = [];
  if (type === FT.I) {
    lines.push('An I-frame (intra) is coded on its own, like a still image: no other frame is needed to decode it. That makes it the largest kind of frame.');
    if (flags & FF.CLOSED) {
      lines.push(family === 'avc' || family === 'hevc'
        ? 'It is an IDR frame (instantaneous decoding refresh): the decoder forgets everything before it, so playback, seeking and stream switching can start here cleanly.'
        : 'It is a key frame: decoding can start here, and nothing after it refers to earlier frames.');
    } else if (flags & FF.RAP) {
      lines.push(family === 'hevc'
        ? 'It is a CRA frame (clean random access): decoding can start here, but some frames that follow it in the file may be shown before it and refer to the previous group; a player starting here skips those.'
        : 'It starts an open GOP: decoding can start here, but the B-frames right after it may refer to the previous group of frames and are skipped when playback starts here.');
    } else lines.push('It is not marked as an entry point, so a player cannot count on starting playback here.');
  } else if (type === FT.P) {
    lines.push('A P-frame (predicted) stores only what changed since earlier frames: it refers back to one or more frames that were decoded before it.');
    if (family === 'av1' || family === 'vp9' || family === 'vp8') lines.push('AV1, VP9 and VP8 have no B-frames; their inter frames can still refer to a hidden "alternate reference" frame that shows a future picture.');
  } else if (type === FT.B) {
    lines.push('A B-frame (bi-directional) is predicted from frames both before and after it in display order, so it is usually the smallest kind of frame. Because it needs a later frame first, the file stores frames in decoding order, which differs from display order.');
    if (flags & FF.REF) lines.push('This B-frame is itself a reference: other B-frames are predicted from it (a "B-pyramid"), which saves more bits.');
    else if (flags & FF.NONREF) lines.push('No other frame is predicted from this one, so a player that falls behind can drop it without damaging the picture.');
  } else if (type === FT.S) {
    lines.push(family === 'av1' ? 'A switch frame: an inter frame that lets a player switch between streams of different quality at this point.'
      : family === 'mpeg4v' ? 'An S-VOP (sprite / global motion compensation) frame.'
        : 'An SP or SI slice: special H.264 frames for switching between streams.');
  } else if (type === FT.REPEAT) {
    lines.push(family === 'mpeg4v' ? 'A not-coded VOP ("N-VOP"): a placeholder that repeats the previous picture, typical of packed B-frames in AVI files.'
      : 'This frame codes no new picture: it tells the decoder to show a frame it decoded earlier (for example a hidden alternate reference frame).');
  }
  if (flags & FF.LEADING) lines.push(flags & FF.SKIPPABLE ? 'It is a RASL frame (random access skipped leading): it is shown before the CRA frame it follows, refers to the previous group, and is skipped when playback starts at that CRA.' : 'It is a RADL frame (random access decodable leading): shown before the entry frame it follows, but decodable from it.');
  if (flags & FF.HIDDEN) lines.push('This packet also carries a hidden frame: one that is decoded but not shown, used as a reference (often a picture from the future, called an alternate reference or "alt-ref"). That is why it can be much larger than its neighbours.');
  if (flags & FF.RECOVERY && !(flags & FF.CLOSED)) lines.push('A recovery point SEI message marks it as an entry point: decoding can start here and the picture is correct from here (or after a few frames with gradual intra refresh).');
  return lines.join('\n');
}
