// EBML (RFC 8794) primitives: variable-size integers (VINTs), element headers,
// typed values and the CRC-32 used by Matroska.
//
// Every EBML element is: Element ID (VINT, marker kept) + Data Size (VINT,
// marker removed) + Data. The length of a VINT is the number of leading zero
// bits of its first byte plus one: 1xxxxxxx is 1 byte, 01xxxxxx 2 bytes, ...
// 00000001 8 bytes. A size whose value bits are all 1 means "unknown size".

import { fmtInt, fmtNum, HEX2 } from '../../core/util.js';

/** Length in bytes of a VINT whose first byte is b (1..8); 0 when b is 0 (longer than 8 bytes). */
export function vintLength(b) {
  return b ? Math.clz32(b) - 23 : 0;
}

/**
 * Read a VINT at u8[p]. Returns {len, value, unknown} (value = VINT_DATA with the
 * length marker removed; unknown = every value bit set), or null when the first
 * byte is 0 or the VINT runs past `end`.
 */
export function readVint(u8, p, end) {
  if (p >= end) return null;
  const b = u8[p];
  const len = vintLength(b);
  if (!len || p + len > end) return null;
  const mask = 0xff >> len;
  let v = b & mask;
  let ones = v === mask;
  for (let i = 1; i < len; i++) {
    const x = u8[p + i];
    v = v * 256 + x;
    if (x !== 0xff) ones = false;
  }
  return { len, value: v, unknown: ones };
}

/** Largest value a VINT of `len` bytes can hold (all-ones is reserved for "unknown"). */
export function vintMax(len) {
  return 2 ** (7 * len) - 2;
}

/** Shortest VINT length able to store `v` as a size. */
export function minVintLength(v) {
  let len = 1;
  while (len < 8 && v > vintMax(len)) len++;
  return len;
}

/** Signed VINT used by EBML lacing: the unsigned value minus 2^(7n-1) - 1. */
export function signedVint(value, len) {
  return value - (2 ** (7 * len - 1) - 1);
}

/**
 * Read an element header at u8[p]: {id, idLen, size, sizeLen, unknown, headerSize}
 * or {error, errorAt}. `maxId`/`maxSize` come from EBMLMaxIDLength/EBMLMaxSizeLength.
 */
export function readHeader(u8, p, end, maxId = 4, maxSize = 8) {
  if (p >= end) return { error: 'no bytes left for an element header', errorAt: p };
  const b = u8[p];
  const idLen = vintLength(b);
  if (!idLen || idLen > maxId) {
    return { error: `byte 0x${HEX2[b]} cannot start an element ID (it would be ${idLen ? `${idLen} bytes` : 'longer than 8 bytes'}; IDs are at most ${maxId})`, errorAt: p };
  }
  if (p + idLen > end) return { error: 'the element ID runs past the end of the data', errorAt: p, truncated: true };
  let id = 0;
  for (let i = 0; i < idLen; i++) id = id * 256 + u8[p + i];
  if (idLen === 1 && b === 0xff) return { error: 'ID 0xFF is reserved (all value bits set)', errorAt: p };
  const s = readVint(u8, p + idLen, end);
  if (!s) {
    const sb = u8[p + idLen];
    if (p + idLen >= end || (sb && p + idLen + vintLength(sb) > end)) {
      return { error: 'the element size runs past the end of the data', errorAt: p + idLen, truncated: true, id, idLen };
    }
    return { error: `byte 0x${HEX2[sb]} cannot start an element size (a zero first byte would mean a size longer than 8 bytes)`, errorAt: p + idLen, id, idLen };
  }
  if (s.len > maxSize) {
    return { error: `the size is ${s.len} bytes long but EBMLMaxSizeLength allows ${maxSize}`, errorAt: p + idLen, id, idLen };
  }
  return { id, idLen, size: s.unknown ? null : s.value, sizeLen: s.len, unknown: s.unknown, headerSize: idLen + s.len };
}

/** True when an ID breaks RFC 8794 § 5 rules (value bits all 0 / all 1, or not the shortest encoding). */
export function idProblem(id, len) {
  const data = id - 2 ** (8 * len - len); // remove the marker bit
  const bits = 7 * len;
  if (len === 1 && id === 0x80) return null; // legal in Matroska (RFC 9559 § 4.2)
  if (data === 0) return 'its value bits are all zero';
  if (data === 2 ** bits - 1) return 'its value bits are all one (reserved)';
  if (len > 1 && data < 2 ** (7 * (len - 1)) - 1) return `it could be written in ${len - 1} byte${len > 2 ? 's' : ''} (IDs must use the shortest form)`;
  return null;
}

export function hexId(id) {
  return `0x${id.toString(16).toUpperCase().padStart(2, '0')}`;
}

function bin8(b) {
  return b.toString(2).padStart(8, '0');
}

/** "0110 0000" style binary of the first byte with the length marker set apart: "01|100000". */
export function markerBits(b, len) {
  const s = bin8(b);
  return `${s.slice(0, len)}|${s.slice(len)}`;
}

function hexOf(u8, p, n) {
  let s = '';
  for (let i = 0; i < n; i++) s += HEX2[u8[p + i]];
  return s;
}

// ------------------------------------------------------------------ header fields

export const ID_DESC = 'Element ID: says what this element is. It is a variable-size integer (VINT): the number of leading 0 bits in the first byte, plus one, gives its length (1xxxxxxx = 1 byte, 01xxxxxx = 2, 001xxxxx = 3, 0001xxxx = 4). Unlike sizes, IDs are quoted with that length marker included, so the bytes you see are the ID itself (1A 45 DF A3 is the EBML header). Frequent elements get 1-byte IDs to save space (SimpleBlock is A3); top-level elements get 4-byte IDs, which rarely appear by chance and help a reader resynchronise after damage.';

export const SIZE_DESC = 'Element data size: how many bytes of data follow this header, as a VINT. Its length is read from the first byte like the ID (1xxxxxxx = 1 byte … 00000001 = 8 bytes) and the value is what remains once that length marker is removed: 0x84 means 4, 0x40 86 means 134. Writers may use more bytes than needed, for example to reserve room to rewrite the size later. A size whose value bits are all 1 (FF, 7F FF, … 01 FF FF FF FF FF FF FF) means "unknown size": live streams use it because they cannot go back and fill the size in; the element then ends where the next element that cannot be inside it begins.';

/** The Element ID header field. */
export function idField(u8, base, p, hdr, name) {
  const b = u8[p];
  const len = hdr.idLen;
  const lead = len - 1;
  return {
    name: 'ID',
    type: 'element ID',
    offset: base + p,
    size: len,
    value: hdr.id,
    display: `${hexId(hdr.id)}${name ? ` → ${name}` : ' (unknown element)'}`,
    role: 'header',
    desc: ID_DESC,
    note: `${len}-byte ID: the first byte 0x${HEX2[b]} = ${markerBits(b, len)} has ${lead === 0 ? 'its marker in the top bit' : `${lead} leading zero bit${lead > 1 ? 's' : ''} before the marker`}, so the ID is ${len} byte${len > 1 ? 's' : ''} long.`,
  };
}

/** The Data Size header field. */
export function sizeField(u8, base, p, hdr) {
  const at = p + hdr.idLen;
  const len = hdr.sizeLen;
  const b = u8[at];
  const bytes = hexOf(u8, at, len);
  const bits = len <= 2 ? `${markerBits(b, len)}${len === 2 ? ` ${bin8(u8[at + 1])}` : ''}` : `${markerBits(b, len)} …`;
  let display;
  let note;
  if (hdr.unknown) {
    display = `unknown (0x${bytes}: all value bits set)`;
    note = `${len}-byte VINT with every value bit set to 1: the size is unknown, so this element ends at the first following element that cannot be one of its children.`;
  } else {
    display = `${fmtInt(hdr.size)} byte${hdr.size === 1 ? '' : 's'}`;
    note = `0x${bytes} = ${bits}: marker in bit ${len} → ${len}-byte VINT; removing the marker leaves ${fmtInt(hdr.size)}.`;
    const min = minVintLength(hdr.size);
    if (min < len) note += ` ${min} byte${min > 1 ? 's' : ''} would have been enough: writers pad sizes like this to be able to rewrite them in place later.`;
  }
  return {
    name: 'size',
    type: 'vint',
    offset: base + at,
    size: len,
    value: hdr.unknown ? null : hdr.size,
    display,
    role: 'header',
    desc: SIZE_DESC,
    note,
  };
}

// ------------------------------------------------------------------ values

/** Unsigned big-endian integer of n bytes (0..8). Returns {value, big?} (big: exact decimal string when > 2^53). */
export function readUint(u8, p, n) {
  let v = 0;
  for (let i = 0; i < n; i++) v = v * 256 + u8[p + i];
  if (v <= Number.MAX_SAFE_INTEGER) return { value: v };
  let b = 0n;
  for (let i = 0; i < n; i++) b = (b << 8n) | BigInt(u8[p + i]);
  return { value: Number(b), big: b };
}

/** Two's complement big-endian integer of n bytes (0..8). */
export function readInt(u8, p, n) {
  if (n === 0) return { value: 0 };
  if (n <= 6) {
    let v = 0;
    for (let i = 0; i < n; i++) v = v * 256 + u8[p + i];
    if (u8[p] & 0x80) v -= 2 ** (8 * n);
    return { value: v };
  }
  let b = 0n;
  for (let i = 0; i < n; i++) b = (b << 8n) | BigInt(u8[p + i]);
  if (u8[p] & 0x80) b -= 1n << BigInt(8 * n);
  const value = Number(b);
  return Number.isSafeInteger(value) ? { value } : { value, big: b };
}

/** IEEE float of 0, 4 or 8 bytes; null for other lengths. */
export function readFloat(u8, p, n) {
  const dv = new DataView(u8.buffer, u8.byteOffset + p, n);
  if (n === 0) return 0;
  if (n === 4) return dv.getFloat32(0);
  if (n === 8) return dv.getFloat64(0);
  return null;
}

const utf8 = new TextDecoder('utf-8');
const latin1 = new TextDecoder('latin1');

/** String/UTF-8 value: everything up to the first NUL (RFC 8794 § 13). */
export function readText(u8, p, n, ascii) {
  let e = p;
  const end = p + n;
  while (e < end && u8[e] !== 0) e++;
  const raw = u8.subarray(p, e);
  const text = ascii ? latin1.decode(raw) : utf8.decode(raw);
  let bad = false;
  if (ascii) {
    for (let i = 0; i < raw.length; i++) {
      if (raw[i] < 0x20 || raw[i] > 0x7e) {
        bad = true;
        break;
      }
    }
  }
  return { text, padded: end - e, nonAscii: bad };
}

/** Date: signed nanoseconds since 2001-01-01T00:00:00 UTC. */
export const EPOCH_2001 = Date.UTC(2001, 0, 1);

export function dateFromNs(ns) {
  const d = new Date(EPOCH_2001 + ns / 1e6);
  return Number.isNaN(d.getTime()) ? null : d;
}

// ------------------------------------------------------------------ CRC-32

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** IEEE CRC-32 (the zlib/PNG one) of u8[start, end); pass a previous result to continue it. */
export function crc32(u8, start, end, prev = 0) {
  let c = (prev ^ 0xffffffff) >>> 0;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function crcHex(v) {
  return `0x${(v >>> 0).toString(16).toUpperCase().padStart(8, '0')}`;
}

// ------------------------------------------------------------------ time helpers

/** Human time for nanoseconds: "40 ms", "21.333 ms", "2.5 s", "1:02:03.500". */
export function fmtNs(ns) {
  if (ns === null || ns === undefined || !Number.isFinite(ns)) return '—';
  const a = Math.abs(ns);
  if (a === 0) return '0';
  if (a < 1e3) return `${fmtNum(ns, 0)} ns`;
  if (a < 1e6) return `${fmtNum(ns / 1e3, 3)} µs`;
  if (a < 1e9) return `${fmtNum(ns / 1e6, 3)} ms`;
  if (a < 60e9) return `${fmtNum(ns / 1e9, 3)} s`;
  return clock(ns / 1e9);
}

/** 7457.867 -> "2:04:17.867"; always shows minutes. */
export function clock(sec) {
  if (sec === null || sec === undefined || !Number.isFinite(sec)) return '—';
  const neg = sec < 0;
  let s = Math.abs(sec);
  // Round to the millisecond first so 59.9996 does not print as 0:60.000.
  s = Math.round(s * 1000) / 1000;
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  s -= m * 60;
  const ss = s.toFixed(3).padStart(6, '0');
  return `${neg ? '-' : ''}${h ? `${h}:${String(m).padStart(2, '0')}` : m}:${ss}`;
}

/** "1 ms" style name for a TimestampScale (nanoseconds per tick). */
export function tickName(scale) {
  if (!scale) return '?';
  if (scale % 1e9 === 0) return `${fmtInt(scale / 1e9)} s`;
  if (scale % 1e6 === 0) return `${fmtInt(scale / 1e6)} ms`;
  if (scale % 1e3 === 0) return `${fmtInt(scale / 1e3)} µs`;
  return `${fmtInt(scale)} ns`;
}
