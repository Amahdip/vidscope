// SimpleBlock / Block structure (RFC 9559 § 10): track number (VINT), signed 16-bit
// timestamp relative to the Cluster, a flags byte, optional lacing header, frames.

import { FieldReader } from '../../core/fields.js';
import { fmtInt } from '../../core/util.js';
import { readVint, signedVint, markerBits } from './ebml.js';

export const LACING = { 0: 'no lacing', 1: 'Xiph lacing', 2: 'fixed-size lacing', 3: 'EBML lacing' };
export const LACING_SHORT = { 0: 'none', 1: 'Xiph', 2: 'fixed', 3: 'EBML' };

/**
 * Lay out a block whose data is u8[p, dataEnd) (header bytes must be in u8[p, end)).
 * Returns {track, trackLen, rel, flags, lacing, key, invisible, discardable, count,
 * headerEnd, frames: [start0, size0, start1, size1, ...] (local indexes), lace?, error?}.
 * `lace` (when detailed) describes the coded sizes for field recording.
 */
export function blockLayout(u8, p, end, dataEnd = end, detailed = false) {
  const t = readVint(u8, p, end);
  if (!t) return { error: 'the track number is not a valid VINT' };
  let q = p + t.len;
  if (q + 3 > end) return { error: 'the block is too short for its header (track number, timestamp and flags)', track: t.value, trackLen: t.len };
  const rel = (((u8[q] << 8) | u8[q + 1]) << 16) >> 16;
  const flags = u8[q + 2];
  q += 3;
  const lacing = (flags >> 1) & 3;
  const L = {
    track: t.value, trackLen: t.len, rel, flags, lacing,
    key: (flags & 0x80) !== 0, invisible: (flags & 0x08) !== 0, discardable: (flags & 0x01) !== 0,
    headerEnd: q, count: 1, frames: null, lace: null, error: null,
  };
  if (!lacing) {
    L.frames = [q, dataEnd - q];
    return L;
  }
  if (q >= end) {
    L.error = 'the lace header is missing';
    L.frames = [q, Math.max(0, dataEnd - q)];
    return L;
  }
  const n = u8[q] + 1;
  const lace = detailed ? { countAt: q, sizes: [] } : null;
  q++;
  const sizes = new Array(n);
  let used = 0;
  try {
    if (lacing === 1) {
      for (let i = 0; i < n - 1; i++) {
        const at = q;
        let s = 0;
        let b;
        do {
          if (q >= end) throw new Error('the Xiph lace sizes run past the end of the block');
          b = u8[q++];
          s += b;
        } while (b === 255);
        sizes[i] = s;
        used += s;
        if (lace) lace.sizes.push({ at, len: q - at, value: s });
      }
    } else if (lacing === 3) {
      let prev = 0;
      for (let i = 0; i < n - 1; i++) {
        const v = readVint(u8, q, end);
        if (!v) throw new Error('an EBML lace size is not a valid VINT');
        const s = i === 0 ? v.value : prev + signedVint(v.value, v.len);
        if (s < 0) throw new Error(`EBML lace size ${i} is negative`);
        if (lace) lace.sizes.push({ at: q, len: v.len, value: s, raw: v.value, delta: i === 0 ? null : s - prev });
        sizes[i] = s;
        used += s;
        prev = s;
        q += v.len;
      }
    } else {
      const total = dataEnd - q;
      const each = Math.floor(total / n);
      if (total % n) L.error = `fixed-size lacing: ${fmtInt(total)} bytes do not split evenly into ${n} frames`;
      for (let i = 0; i < n - 1; i++) {
        sizes[i] = each;
        used += each;
      }
    }
  } catch (e) {
    L.error = e.message;
    L.headerEnd = q;
    L.frames = [q, Math.max(0, dataEnd - q)];
    L.lace = lace;
    return L;
  }
  const last = dataEnd - q - used;
  if (last < 0) {
    L.error = `the laced frame sizes add up to ${fmtInt(used)} bytes but only ${fmtInt(dataEnd - q)} are left`;
    L.headerEnd = q;
    L.frames = [q, Math.max(0, dataEnd - q)];
    L.lace = lace;
    return L;
  }
  sizes[n - 1] = last;
  const frames = new Array(2 * n);
  let off = q;
  for (let i = 0; i < n; i++) {
    frames[2 * i] = off;
    frames[2 * i + 1] = sizes[i];
    off += sizes[i];
  }
  L.headerEnd = q;
  L.count = n;
  L.frames = frames;
  L.lace = lace;
  return L;
}

const TRACK_DESC = 'Which track this block belongs to: the TrackNumber of a TrackEntry, coded as a VINT like element sizes (0x81 = 1000 0001 → track 1).';
const TIME_DESC = 'Timestamp of the (first) frame relative to the Cluster Timestamp, as a signed 16-bit number of track ticks (TimestampScale units). Negative values are allowed. For video with B-frames this is the presentation time, so it jumps back and forth in decode order.';
const KEY_DESC = 'Set when the block contains only key frames: frames that decode without any other frame, where playback can start after a seek.';
const INV_DESC = 'Invisible: decode the frame but do not show it (e.g. VP8/VP9 alternate reference frames).';
const LACING_DESC = 'How several frames are packed into this block: 00 none (one frame), 01 Xiph (sizes as sums of bytes up to 255), 11 EBML (first size as a VINT, then signed differences), 10 fixed-size (all frames equal, no sizes stored).';
const DISC_DESC = 'Discardable: the frames can be dropped if the player is too slow, without breaking later frames (e.g. non-reference B-frames).';

/**
 * Record the header fields of a SimpleBlock (simple = true) or Block whose data is
 * u8[s, dataEnd) at file offset base + s, into `out`. Returns the layout with absolute
 * frame offsets in `L.abs` ([start, size, ...]).
 */
export function blockFields(u8, base, s, end, dataEnd, simple, out) {
  const L = blockLayout(u8, s, end, dataEnd, true);
  if (L.trackLen) {
    out.push({
      name: 'track number',
      type: 'vint',
      offset: base + s,
      size: L.trackLen,
      value: L.track,
      display: String(L.track),
      key: true,
      desc: TRACK_DESC,
      note: `0x${u8[s].toString(16).toUpperCase().padStart(2, '0')} = ${markerBits(u8[s], L.trackLen)}: ${L.trackLen}-byte VINT, value ${L.track}.`,
    });
  }
  if (L.error && L.rel === undefined) return L;
  const q = s + L.trackLen;
  out.push({
    name: 'timestamp',
    type: 'int16',
    offset: base + q,
    size: 2,
    value: L.rel,
    display: `${L.rel >= 0 ? '+' : ''}${L.rel} ticks`,
    key: true,
    desc: TIME_DESC,
  });
  const r = new FieldReader(u8, base, { start: q + 2, end: q + 3, out });
  if (simple) {
    r.flag('keyframe', { key: true, desc: KEY_DESC });
    r.bits(3, 'reserved', { reserved: true, display: (v) => String(v), desc: 'Reserved, must be 0.' });
  } else {
    r.bits(4, 'reserved', { reserved: true, display: (v) => String(v), desc: 'Reserved, must be 0. A Block has no keyframe flag: a BlockGroup without ReferenceBlock is a key frame.' });
  }
  r.flag('invisible', { desc: INV_DESC });
  r.bits(2, 'lacing', { key: true, enum: { 0: 'no lacing', 1: 'Xiph', 2: 'fixed-size', 3: 'EBML' }, desc: LACING_DESC });
  if (simple) r.flag('discardable', { desc: DISC_DESC });
  else r.bits(1, 'unused', { reserved: true, display: (v) => String(v), desc: 'Not used in a Block.' });
  if (L.lace) {
    out.push({
      name: 'frame count − 1',
      type: 'uint8',
      offset: base + L.lace.countAt,
      size: 1,
      value: L.count - 1,
      display: `${L.count - 1} → ${L.count} frames in this lace`,
      desc: 'Lacing header: the number of frames packed in the block, minus one. The size of every frame except the last follows; the last frame takes the remaining bytes.',
    });
    L.lace.sizes.forEach((z, i) => {
      let display;
      let desc;
      if (L.lacing === 1) {
        display = `${fmtInt(z.value)} bytes${z.len > 1 ? ` (${Array.from(u8.subarray(z.at, z.at + z.len)).join(' + ')})` : ''}`;
        desc = 'Xiph lacing: frame size written as bytes that are added up while they are 255.';
      } else if (i === 0) {
        display = `${fmtInt(z.value)} bytes`;
        desc = 'EBML lacing: the first frame size, as an unsigned VINT.';
      } else {
        display = `${z.delta >= 0 ? '+' : ''}${fmtInt(z.delta)} → ${fmtInt(z.value)} bytes`;
        desc = 'EBML lacing: the difference from the previous frame size, as a signed VINT (the stored value minus 2^(7n−1) − 1 for an n-byte VINT).';
      }
      out.push({ name: `frame ${i} size`, type: L.lacing === 1 ? 'Xiph lacing' : 'vint', offset: base + z.at, size: z.len, value: z.value, display, desc });
    });
    // Sizes that are not stored: every frame of a fixed-size lace, and the last frame of any lace.
    if (L.frames && L.count > 1) {
      const at = base + L.headerEnd;
      if (L.lacing === 2) {
        out.push({ name: 'frame size (each)', type: 'computed', offset: at, size: 0, value: L.frames[1], display: `${fmtInt(L.frames[1])} bytes × ${L.count} frames`, desc: 'Fixed-size lacing stores no sizes: every frame is (block data after the lace header) ÷ (frame count) bytes.' });
      } else {
        const last = L.frames[2 * L.count - 1];
        out.push({ name: `frame ${L.count - 1} size`, type: 'computed', offset: at, size: 0, value: last, display: `${fmtInt(last)} bytes (not stored: what remains of the block)`, desc: 'The last frame of a lace has no stored size: it takes all the bytes left after the other frames.' });
      }
    }
  }
  if (L.frames) {
    const abs = new Array(L.frames.length);
    for (let i = 0; i < L.frames.length; i += 2) {
      abs[i] = base + L.frames[i];
      abs[i + 1] = L.frames[i + 1];
    }
    L.abs = abs;
  }
  return L;
}
