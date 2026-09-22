// Helpers for NAL-unit video (H.264, H.265): emulation prevention and framing.

import { FieldReader } from '../core/fields.js';

/**
 * Strip emulation-prevention bytes (the 0x03 in 00 00 03) from u8[start, end)
 * to get the RBSP, keeping a map from each RBSP byte back to its file offset so
 * parsed fields still point at the right bytes.
 */
export function toRbsp(u8, start, end, base) {
  const n = Math.max(0, end - start);
  const out = new Uint8Array(n);
  const map = new Float64Array(n);
  let w = 0;
  let zeros = 0;
  for (let i = start; i < end; i++) {
    const b = u8[i];
    if (zeros >= 2 && b === 3) {
      zeros = 0;
      continue;
    }
    out[w] = b;
    map[w] = base + i;
    w++;
    zeros = b === 0 ? zeros + 1 : 0;
  }
  return { rbsp: out.subarray(0, w), map: map.subarray(0, w), removed: n - w };
}

/** A FieldReader over the RBSP of u8[start, end), recording into `out`. */
export function rbspReader(u8, start, end, base, out) {
  const { rbsp, map, removed } = toRbsp(u8, start, end, base);
  const r = new FieldReader(rbsp, 0, { map, out });
  r.epb = removed;
  return r;
}

/** True while there is payload before the rbsp_stop_one_bit. */
export function moreRbspData(r) {
  if (r.pos >= r.end) return false;
  let last = r.end - 1;
  while (last > r.pos && r.u[last] === 0) last--;
  const b = r.u[last];
  if (b === 0) return false;
  // Position of the stop bit (the lowest set bit of the last non-zero byte).
  let stopBit = 7;
  while (stopBit > 0 && !((b >> (7 - stopBit)) & 1)) stopBit--;
  const here = r.pos * 8 + r.bit;
  const stop = last * 8 + stopBit;
  return here < stop;
}

/** Split a sample of length-prefixed NAL units (AVCC/HVCC framing). */
export function splitLengthPrefixed(u8, start, end, lengthSize) {
  const units = [];
  let p = start;
  while (p + lengthSize <= end) {
    let len = 0;
    for (let k = 0; k < lengthSize; k++) len = len * 256 + u8[p + k];
    const s = p + lengthSize;
    const e = Math.min(end, s + len);
    units.push({ prefix: p, start: s, end: e, declared: len, truncated: s + len > end });
    if (len === 0 && lengthSize < 4) break;
    p = s + len;
  }
  return { units, trailing: Math.max(0, end - Math.max(p, start)) };
}

/** Split an Annex B byte stream on 00 00 01 / 00 00 00 01 start codes. */
export function splitAnnexB(u8, start, end) {
  const units = [];
  let i = start;
  let current = null;
  while (i + 2 < end) {
    if (u8[i] === 0 && u8[i + 1] === 0 && u8[i + 2] === 1) {
      const scStart = i > start && u8[i - 1] === 0 ? i - 1 : i;
      if (current) {
        let e = scStart;
        // Trailing zero bytes belong to the next start code, not this NAL.
        while (e > current.start && u8[e - 1] === 0) e--;
        current.end = e;
        units.push(current);
      }
      current = { prefix: scStart, start: i + 3, end };
      i += 3;
    } else {
      i++;
    }
  }
  if (current) {
    current.end = end;
    units.push(current);
  }
  return units;
}
