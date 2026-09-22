// Walks a raw video elementary stream (H.264 or HEVC in Annex B form, MPEG-1/2 video) and finds
// what a container would normally tell a player: where each coded picture (access unit) starts,
// which ones are key frames, in which order they are shown (from the picture order count, POC,
// or the MPEG-2 temporal reference), and the frame rate the encoder wrote into the stream.

import * as h264 from '../../codecs/h264.js';
import * as h265 from '../../codecs/h265.js';
import { Grow, tick } from '../../core/scan.js';

const WINDOW = 4 << 20;
const LOOK = 96; // bytes after a start code the walker may look at
const PARAM_MAX = 64 << 10;

/** Reads bits and Exp-Golomb codes, removing emulation-prevention bytes (00 00 03). */
class Bits {
  constructor(u8, start, end) {
    const out = new Uint8Array(Math.max(0, end - start));
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

/** MPEG-1/2 frame_rate_code → [numerator, denominator]. */
export const MPEG2_RATES = { 1: [24000, 1001], 2: [24, 1], 3: [25, 1], 4: [30000, 1001], 5: [30, 1], 6: [50, 1], 7: [60000, 1001], 8: [60, 1] };

/** Picture type codes stored per access unit. */
export const PIC = { UNKNOWN: 0, I: 1, P: 2, B: 3, S: 4 };

/**
 * Scan `source` from 0 to `end`. `codec` is 'avc', 'hevc' or 'mpeg2v'.
 * Returns the access units, counts of every NAL unit type, parameter sets, and timing.
 */
export async function scanStream(source, codec, { end = source.size, onProgress } = {}) {
  const S = {
    codec,
    state: { spsById: new Map(), ppsById: new Map() },
    au: { off: new Grow(Float64Array), key: new Grow(Uint8Array), pic: new Grow(Uint8Array), ref: new Grow(Uint8Array), nal: new Grow(Uint8Array), cvs: new Grow(Uint32Array), poc: new Grow(Float64Array) },
    counts: new Map(), // NAL unit type (or MPEG-2 start code) -> count
    firstOffsets: new Map(), // type -> offset of the first one
    units: 0,
    first: -1, // offset of the first start code
    seenVcl: false,
    cur: -1, // index of the current access unit
    // picture order count bookkeeping
    cvs: -1,
    firstPic: true,
    afterEos: false,
    prevTid0Poc: 0,
    prevMsb: 0,
    prevLsb: 0,
    decodeInCvs: 0,
    pocMissing: false,
    gop: -1,
    seq: null, // MPEG-2 sequence header facts
    paramSetsBeforeKeys: 0,
    pendingParams: false,
  };
  let pos = 0;
  let prevLast = -1; // last byte of the previous window, for 4-byte start codes across windows
  while (pos < end) {
    const win = await source.read(pos, Math.min(WINDOW, end - pos));
    if (!win.length) break;
    const last = pos + win.length >= end;
    const limit = last ? win.length : win.length - LOOK;
    let i = 0;
    while (i + 2 < limit) {
      const c = win[i + 2];
      if (c > 1) {
        i += 3;
        continue;
      }
      if (c === 1 && win[i] === 0 && win[i + 1] === 0) {
        // In H.264/HEVC a 00 before 00 00 01 is part of the start code (zero_byte); in MPEG video
        // it is the end of the previous picture.
        const zero = S.codec !== 'mpeg2v' && (i > 0 ? win[i - 1] === 0 : prevLast === 0);
        await unit(S, source, win, pos, i + 3, pos + i - (zero ? 1 : 0));
        i += 3;
        continue;
      }
      i++;
    }
    prevLast = limit > 0 ? win[limit - 1] : prevLast;
    pos += last ? win.length : limit;
    onProgress?.(pos, end);
    await tick();
  }
  return finish(S, end);
}

function newAu(S, offset) {
  const a = S.au;
  a.off.push(offset);
  a.key.push(0);
  a.pic.push(0);
  a.ref.push(1);
  a.nal.push(255);
  a.cvs.push(Math.max(0, S.cvs));
  a.poc.push(NaN);
  S.cur = a.off.n - 1;
  S.seenVcl = false;
}

function count(S, type, offset) {
  S.counts.set(type, (S.counts.get(type) ?? 0) + 1);
  if (!S.firstOffsets.has(type)) S.firstOffsets.set(type, offset);
  S.units++;
  if (S.first < 0) S.first = offset;
}

/** Bytes of the NAL unit starting at payload index q of `win`, up to the next start code. */
async function nalBytes(source, win, pos, q) {
  const lim = Math.min(win.length, q + PARAM_MAX);
  for (let k = q; k + 2 < lim; k++) if (win[k] === 0 && win[k + 1] === 0 && (win[k + 2] === 1 || (win[k + 2] === 0 && win[k + 3] === 1))) return { u8: win, s: q, e: k, base: pos };
  if (lim === win.length && pos + win.length < source.size) {
    const u8 = await source.read(pos + q, PARAM_MAX);
    for (let k = 0; k + 2 < u8.length; k++) if (u8[k] === 0 && u8[k + 1] === 0 && (u8[k + 2] === 1 || (u8[k + 2] === 0 && u8[k + 3] === 1))) return { u8, s: 0, e: k, base: pos + q };
    return { u8, s: 0, e: u8.length, base: pos + q };
  }
  return { u8: win, s: q, e: lim, base: pos };
}

async function unit(S, source, win, pos, q, offset) {
  if (S.codec === 'hevc') return hevcUnit(S, source, win, pos, q, offset);
  if (S.codec === 'avc') return avcUnit(S, source, win, pos, q, offset);
  return mpeg2Unit(S, win, q, offset);
}

// ------------------------------------------------------------ HEVC

async function hevcUnit(S, source, win, pos, q, offset) {
  if (q + 1 >= win.length) return;
  const type = (win[q] >> 1) & 63;
  const tid = (win[q + 1] & 7) - 1;
  count(S, type, offset);
  const vcl = type < 32;
  // A new access unit starts at the first of these after the last VCL NAL unit of a picture
  // (H.265 7.4.2.4.4), or at a first slice segment.
  const startsAu = vcl ? S.seenVcl && win[q + 2] >> 7 : S.seenVcl && (type === 35 || type === 32 || type === 33 || type === 34 || type === 39 || (type >= 41 && type <= 44) || (type >= 48 && type <= 55));
  if (S.cur < 0 || startsAu) newAu(S, offset);
  if (type >= 32 && type <= 34) {
    const { u8, s, e, base } = await nalBytes(source, win, pos, q);
    try {
      h265.parseNalUnit(u8, s, e, base, [], S.state);
    } catch {
      // a damaged parameter set: slices that refer to it stay unclassified
    }
    S.pendingParams = true;
  }
  if (type === 36) S.afterEos = true;
  if (!vcl || S.seenVcl) {
    if (vcl) S.seenVcl = true;
    return;
  }
  S.seenVcl = true;
  const a = S.au;
  const k = S.cur;
  a.nal.a[k] = type;
  const irap = type >= 16 && type <= 23;
  if (irap) {
    a.key.a[k] = 1;
    if (S.pendingParams) S.paramSetsBeforeKeys++;
  }
  S.pendingParams = false;
  a.ref.a[k] = type <= 14 && type % 2 === 0 ? 0 : 1;
  const noRasl = irap && (type <= 20 || S.firstPic || S.afterEos);
  if (noRasl) S.cvs++;
  a.cvs.a[k] = Math.max(0, S.cvs);
  try {
    const r = new Bits(win, q + 2, Math.min(win.length, q + LOOK));
    r.bit(); // first_slice_segment_in_pic_flag (1 here)
    if (irap) r.bit(); // no_output_of_prior_pics_flag
    const pps = S.state.ppsById.get(r.ue());
    const sps = pps && S.state.spsById.get(pps.sps_id);
    if (!pps || !sps) throw OUT;
    for (let i = 0; i < pps.num_extra_slice_header_bits; i++) r.bit();
    const st = r.ue();
    a.pic.a[k] = [PIC.B, PIC.P, PIC.I][st] ?? PIC.UNKNOWN;
    if (pps.output_flag_present) r.bit();
    if (sps.separate_colour_plane) r.bits(2);
    let poc = 0;
    if (type !== 19 && type !== 20) {
      const lsb = r.bits(sps.log2_max_poc_lsb);
      const max = 2 ** sps.log2_max_poc_lsb;
      let msb;
      if (irap && noRasl) msb = 0;
      else {
        const prevLsb = ((S.prevTid0Poc % max) + max) % max;
        const prevMsb = S.prevTid0Poc - prevLsb;
        if (lsb < prevLsb && prevLsb - lsb >= max / 2) msb = prevMsb + max;
        else if (lsb > prevLsb && lsb - prevLsb > max / 2) msb = prevMsb - max;
        else msb = prevMsb;
      }
      poc = msb + lsb;
    }
    a.poc.a[k] = poc;
    // The previous TemporalId-0 picture that is not a RASL, RADL or sub-layer non-reference picture.
    if (tid === 0 && !(type >= 6 && type <= 9) && !(type <= 14 && type % 2 === 0)) S.prevTid0Poc = poc;
  } catch {
    S.pocMissing = true;
  }
  S.firstPic = false;
  S.afterEos = false;
}

// ------------------------------------------------------------ H.264

async function avcUnit(S, source, win, pos, q, offset) {
  if (q >= win.length) return;
  const b0 = win[q];
  const type = b0 & 31;
  const refIdc = (b0 >> 5) & 3;
  count(S, type, offset);
  const vcl = type === 1 || type === 5 || type === 2;
  // H.264 7.4.1.2.3: a new access unit starts at an AUD, SPS, PPS, SEI or types 14–18 after the
  // last VCL NAL unit of a picture, or at the first slice of the next picture.
  const startsAu = vcl ? S.seenVcl && win[q + 1] >> 7 : S.seenVcl && (type === 9 || type === 7 || type === 8 || type === 6 || (type >= 14 && type <= 18));
  if (S.cur < 0 || startsAu) newAu(S, offset);
  if (type === 7 || type === 8) {
    const { u8, s, e, base } = await nalBytes(source, win, pos, q);
    try {
      h264.parseNalUnit(u8, s, e, base, [], S.state);
    } catch {
      // a damaged parameter set
    }
    S.pendingParams = true;
  }
  if (type === 10) S.afterEos = true;
  if (!vcl || S.seenVcl) {
    if (vcl) S.seenVcl = true;
    return;
  }
  S.seenVcl = true;
  const a = S.au;
  const k = S.cur;
  a.nal.a[k] = type;
  a.ref.a[k] = refIdc ? 1 : 0;
  if (type === 5) {
    a.key.a[k] = 1;
    S.cvs++;
    S.prevMsb = 0;
    S.prevLsb = 0;
    S.decodeInCvs = 0;
    if (S.pendingParams) S.paramSetsBeforeKeys++;
  } else if (S.cvs < 0) S.cvs = 0;
  S.pendingParams = false;
  a.cvs.a[k] = S.cvs;
  try {
    const r = new Bits(win, q + 1, Math.min(win.length, q + LOOK));
    r.ue(); // first_mb_in_slice
    const st = r.ue() % 5;
    a.pic.a[k] = [PIC.P, PIC.B, PIC.I, PIC.S, PIC.S][st];
    const pps = S.state.ppsById.get(r.ue());
    const sps = pps && S.state.spsById.get(pps.sps_id);
    if (!pps || !sps) throw OUT;
    if (sps.separate_colour_plane) r.bits(2);
    r.bits(sps.log2_max_frame_num); // frame_num
    if (!sps.frame_mbs_only && r.bit()) r.bit(); // field_pic_flag, bottom_field_flag
    if (type === 5) r.ue(); // idr_pic_id
    let poc;
    if (sps.poc_type === 0) {
      const lsb = r.bits(sps.log2_max_poc_lsb);
      const max = 2 ** sps.log2_max_poc_lsb;
      let msb;
      if (lsb < S.prevLsb && S.prevLsb - lsb >= max / 2) msb = S.prevMsb + max;
      else if (lsb > S.prevLsb && lsb - S.prevLsb > max / 2) msb = S.prevMsb - max;
      else msb = S.prevMsb;
      poc = msb + lsb;
      if (refIdc) {
        S.prevMsb = msb;
        S.prevLsb = lsb;
      }
    } else {
      // POC types 1 and 2: with type 2 the display order is the decoding order.
      poc = S.decodeInCvs * 2;
      if (sps.poc_type === 1) S.pocMissing = true;
    }
    a.poc.a[k] = poc;
  } catch {
    S.pocMissing = true;
  }
  S.decodeInCvs++;
}

// ------------------------------------------------------------ MPEG-1/2 video

function mpeg2Unit(S, win, q, offset) {
  // win[q] is the start code's value; the header's fields start at win[q + 1].
  if (q + 7 >= win.length) return;
  const code = win[q];
  count(S, code, offset);
  // A picture's data runs until the next sequence header, GOP header or picture header.
  const startsAu = S.seenVcl && (code === 0xb3 || code === 0xb8 || code === 0x00);
  if (S.cur < 0 || startsAu) newAu(S, offset);
  const a = S.au;
  const k = S.cur;
  if (code === 0xb3) {
    // horizontal_size (12 bits), vertical_size (12), aspect_ratio_information (4),
    // frame_rate_code (4), bit_rate_value (18, in units of 400 bit/s)
    const rate = win[q + 4] & 15;
    const bitRate = ((win[q + 5] << 10) | (win[q + 6] << 2) | (win[q + 7] >> 6)) * 400;
    S.seq ??= { width: (win[q + 1] << 4) | (win[q + 2] >> 4), height: ((win[q + 2] & 15) << 8) | win[q + 3], aspect: win[q + 4] >> 4, rate, bitRate };
    S.pendingParams = true;
  } else if (code === 0xb8) {
    S.gop++;
    // time_code (25 bits), then closed_gop
    S.gopClosed = (win[q + 4] >> 6) & 1;
    S.pendingParams = true;
  } else if (code === 0x00) {
    S.seenVcl = true;
    const temporalRef = (win[q + 1] << 2) | (win[q + 2] >> 6);
    const t = (win[q + 2] >> 3) & 7;
    a.pic.a[k] = t === 1 || t === 4 ? PIC.I : t === 2 ? PIC.P : t === 3 ? PIC.B : PIC.UNKNOWN;
    a.ref.a[k] = t === 3 ? 0 : 1;
    a.nal.a[k] = t;
    if (a.pic.a[k] === PIC.I && S.pendingParams) {
      a.key.a[k] = 1;
      S.paramSetsBeforeKeys++;
    }
    S.pendingParams = false;
    a.cvs.a[k] = Math.max(0, S.gop);
    a.poc.a[k] = temporalRef;
  }
}

// ------------------------------------------------------------ results

function finish(S, end) {
  const a = S.au;
  const n = a.off.n;
  const offsets = a.off.done();
  const sizes = new Uint32Array(n);
  for (let i = 0; i < n; i++) sizes[i] = (i + 1 < n ? offsets[i + 1] : end) - offsets[i];
  const cvs = a.cvs.done();
  const poc = a.poc.done();
  // Display order: by coded video sequence, then picture order count (or temporal reference).
  const order = new Uint32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  let reordered = false;
  if (!S.pocMissing) {
    order.sort((x, y) => cvs[x] - cvs[y] || (poc[x] - poc[y]) || x - y);
    for (let k = 0; k < n; k++) {
      if (order[k] !== k) {
        reordered = true;
        break;
      }
    }
  }
  const rank = new Uint32Array(n);
  for (let k = 0; k < n; k++) rank[order[k]] = k;
  return {
    codec: S.codec,
    count: n,
    offsets,
    sizes,
    key: a.key.done(),
    pic: a.pic.done(),
    ref: a.ref.done(),
    nal: a.nal.done(),
    cvs,
    poc,
    rank,
    reordered,
    pocMissing: S.pocMissing,
    counts: S.counts,
    firstOffsets: S.firstOffsets,
    units: S.units,
    first: S.first,
    state: S.state,
    seq: S.seq,
    paramSetsBeforeKeys: S.paramSetsBeforeKeys,
    end,
  };
}

/** Frame rate as [ticks per second, ticks per frame], and where it came from. */
export function frameRateOf(scan) {
  if (scan.codec === 'mpeg2v') {
    const r = scan.seq && MPEG2_RATES[scan.seq.rate];
    if (r) return { timescale: r[0], duration: r[1], fps: r[0] / r[1], source: 'the sequence header', detail: `frame_rate_code ${scan.seq.rate} = ${r[0]}/${r[1]}` };
  } else {
    for (const sps of scan.state.spsById.values()) {
      const v = sps.vui;
      if (v?.fps && v.num_units_in_tick && v.time_scale) {
        const ticks = scan.codec === 'avc' ? 2 * v.num_units_in_tick : v.num_units_in_tick;
        const detail = scan.codec === 'avc'
          ? `time_scale ${v.time_scale} ÷ (2 × num_units_in_tick ${v.num_units_in_tick})`
          : `time_scale ${v.time_scale} ÷ num_units_in_tick ${v.num_units_in_tick}`;
        return { timescale: v.time_scale, duration: ticks, fps: v.time_scale / ticks, source: 'the VUI timing in the SPS', detail };
      }
    }
  }
  return { timescale: 90000, duration: 3600, fps: 25, source: null };
}
