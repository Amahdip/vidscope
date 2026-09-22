// FieldReader reads values out of a byte buffer and records each one as a
// "field": a name, a type, the exact file position it came from and a display
// string. Parsers are written as a sequence of reads, and the recorded fields
// become what the inspector lists and what the hex view colours.
//
// A field looks like:
//   { name, type, offset, size, value, display, desc?, key?, reserved?, role?,
//     bitOffset?, bitSize?, children? (struct), ...table props (table) }
// `offset`/`size` are absolute file positions in bytes. Bit fields also carry
// bitOffset (0 = most significant bit of the first byte) and bitSize.

import { fourcc as fourccStr, fmtInt, fmtNum, hexBytes, quote, decodeText, uuidString, HEX2 } from './util.js';

export class ParseError extends Error {
  constructor(message, offset) {
    super(message);
    this.name = 'ParseError';
    this.offset = offset;
  }
}

const TYPE_SIZES = { u8: 1, i8: 1, u16: 2, i16: 2, u24: 3, i24: 3, u32: 4, i32: 4, u64: 8, i64: 8, f32: 4, f64: 8, fourcc: 4 };
const TYPE_NAMES = {
  u8: 'uint8', i8: 'int8', u16: 'uint16', i16: 'int16', u24: 'uint24', i24: 'int24', u32: 'uint32',
  i32: 'int32', u64: 'uint64', i64: 'int64', f32: 'float32', f64: 'float64', fourcc: 'fourcc',
};

export function typeLabel(t) {
  return TYPE_NAMES[t] || t;
}

/** Default display string for a value of a given field type. */
export function formatValue(type, v, o) {
  if (o) {
    if (typeof o.display === 'function') return o.display(v);
    if (typeof o.display === 'string') return o.display;
    if (o.enum) {
      const name = o.enum[v];
      const shown = type === 'fourcc' ? `'${v}'` : fmtValue(type, v);
      return name !== undefined ? `${shown} — ${name}` : `${shown}${o.enumUnknown === false ? '' : ' — unknown'}`;
    }
    if (o.unit) return `${fmtValue(type, v)} ${o.unit}`;
  }
  return fmtValue(type, v);
}

function fmtValue(type, v) {
  if (v === null || v === undefined) return '—';
  if (type === 'fourcc') return `'${v}'`;
  if (type === 'flag') return v ? '1 (yes)' : '0 (no)';
  if (typeof v === 'string') return quote(v);
  if (v instanceof Uint8Array) return v.length ? hexBytes(v, 24) : '(empty)';
  if (typeof v === 'number') return Number.isInteger(v) ? fmtInt(v) : fmtNum(v, 6);
  if (typeof v === 'bigint') return v.toLocaleString('en-US');
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  return String(v);
}

const OPT_KEYS = ['desc', 'key', 'reserved', 'role', 'ref', 'unit', 'note', 'expect', 'enum', 'hidden', 'kind', 'tip'];

function applyOpts(f, o) {
  if (!o) return;
  for (const k of OPT_KEYS) if (o[k] !== undefined) f[k] = o[k];
  if (o.expect !== undefined && f.value !== o.expect && typeof f.value === typeof o.expect) {
    f.mismatch = true;
  }
}

export class FieldReader {
  /**
   * @param {Uint8Array} bytes
   * @param {number} base absolute file offset of bytes[0]
   * @param {{start?: number, end?: number, le?: boolean, map?: ArrayLike<number>}} [o]
   *   map: optional local-index -> absolute-offset table, used for RBSP where
   *   emulation-prevention bytes were removed.
   */
  constructor(bytes, base = 0, o = {}) {
    this.u = bytes;
    this.dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.base = base;
    this.pos = o.start ?? 0;
    this.end = Math.min(o.end ?? bytes.length, bytes.length);
    this.le = !!o.le;
    this.map = o.map || null;
    this.bit = 0;
    this.out = o.out || [];
  }

  // ---------- positions ----------

  absAt(i) {
    if (!this.map) return this.base + i;
    if (i < this.map.length) return this.map[i];
    return this.map[this.map.length - 1] + (i - this.map.length + 1);
  }

  get abs() {
    return this.absAt(this.pos);
  }

  get remaining() {
    return this.end - this.pos;
  }

  get eof() {
    return this.pos >= this.end;
  }

  /** Absolute size in the file of the local byte span [a, b). */
  spanSize(a, b) {
    if (b <= a) return 0;
    return this.absAt(b - 1) - this.absAt(a) + 1;
  }

  need(n, name) {
    if (this.bit) throw new Error(`internal: byte read of ${name} at bit ${this.bit}`);
    if (this.pos + n > this.end) {
      throw new ParseError(`Not enough data for ${name}: needs ${n} bytes, ${Math.max(0, this.end - this.pos)} left`, this.abs);
    }
  }

  // ---------- recording ----------

  record(name, type, start, len, value, o) {
    const f = { name, type, offset: this.absAt(start), size: this.spanSize(start, start + len), value };
    applyOpts(f, o);
    if (o && o.silent) return f;
    f.display = formatValue(type, value, o);
    this.out.push(f);
    return f;
  }

  _num(name, t, o) {
    const n = TYPE_SIZES[t];
    // Bitstream syntax (SPS, VUI...) has u(8)/u(16)/u(32) fields at any bit position.
    if (this.bit && (t === 'u8' || t === 'u16' || t === 'u24' || t === 'u32')) {
      return this.bits(n * 8, name, { ...o, type: TYPE_NAMES[t] });
    }
    this.need(n, name);
    const p = this.pos;
    const dv = this.dv;
    const le = this.le;
    let v;
    switch (t) {
      case 'u8': v = dv.getUint8(p); break;
      case 'i8': v = dv.getInt8(p); break;
      case 'u16': v = dv.getUint16(p, le); break;
      case 'i16': v = dv.getInt16(p, le); break;
      case 'u24': v = le ? dv.getUint16(p, true) + dv.getUint8(p + 2) * 65536 : dv.getUint16(p) * 256 + dv.getUint8(p + 2); break;
      case 'i24': {
        const u = le ? dv.getUint16(p, true) + dv.getUint8(p + 2) * 65536 : dv.getUint16(p) * 256 + dv.getUint8(p + 2);
        v = u >= 0x800000 ? u - 0x1000000 : u;
        break;
      }
      case 'u32': v = dv.getUint32(p, le); break;
      case 'i32': v = dv.getInt32(p, le); break;
      case 'f32': v = dv.getFloat32(p, le); break;
      case 'f64': v = dv.getFloat64(p, le); break;
      default: break;
    }
    let big;
    if (t === 'u64' || t === 'i64') {
      big = t === 'u64' ? dv.getBigUint64(p, le) : dv.getBigInt64(p, le);
      v = Number(big);
    }
    let f;
    if (name !== null) {
      const opts = big !== undefined && !Number.isSafeInteger(v) && !(o && o.display) ? { ...o, display: big.toLocaleString('en-US') } : o;
      f = this.record(name, t, p, n, v, opts);
      if (big !== undefined && !Number.isSafeInteger(v)) f.big = big.toString();
    }
    this.pos += n;
    return v;
  }

  u8(name, o) { return this._num(name, 'u8', o); }
  i8(name, o) { return this._num(name, 'i8', o); }
  u16(name, o) { return this._num(name, 'u16', o); }
  i16(name, o) { return this._num(name, 'i16', o); }
  u24(name, o) { return this._num(name, 'u24', o); }
  i24(name, o) { return this._num(name, 'i24', o); }
  u32(name, o) { return this._num(name, 'u32', o); }
  i32(name, o) { return this._num(name, 'i32', o); }
  u64(name, o) { return this._num(name, 'u64', o); }
  i64(name, o) { return this._num(name, 'i64', o); }
  f32(name, o) { return this._num(name, 'f32', o); }
  f64(name, o) { return this._num(name, 'f64', o); }

  /** Unsigned integer of 1, 2, 3, 4 or 8 bytes (for size-parameterised fields). */
  uN(bytes, name, o) {
    switch (bytes) {
      case 0: return 0;
      case 1: return this.u8(name, o);
      case 2: return this.u16(name, o);
      case 3: return this.u24(name, o);
      case 4: return this.u32(name, o);
      case 8: return this.u64(name, o);
      default: {
        this.need(bytes, name);
        let v = 0;
        for (let i = 0; i < bytes; i++) v = v * 256 + this.u[this.pos + i];
        if (name !== null) this.record(name, `uint${bytes * 8}`, this.pos, bytes, v, o);
        this.pos += bytes;
        return v;
      }
    }
  }

  /** Signed fixed point stored in `bytes` bytes with `frac` fractional bits (16.16, 8.8, 2.30 ...). */
  fixed(name, bytes, frac, o = {}) {
    const intBits = bytes * 8 - frac;
    this.need(bytes, name);
    const p = this.pos;
    const raw = bytes === 4 ? this.dv.getInt32(p, this.le) : bytes === 2 ? this.dv.getInt16(p, this.le) : this.dv.getInt8(p);
    const unsignedRaw = o.unsigned ? (bytes === 4 ? this.dv.getUint32(p, this.le) : bytes === 2 ? this.dv.getUint16(p, this.le) : this.dv.getUint8(p)) : raw;
    const v = unsignedRaw / 2 ** frac;
    const type = `fixed${intBits}.${frac}`;
    if (name !== null) {
      this.record(name, type, p, bytes, v, { ...o, display: o.display ?? `${fmtNum(v, 5)}  (raw ${fmtInt(unsignedRaw)})` });
    }
    this.pos += bytes;
    return v;
  }

  fourcc(name, o) {
    this.need(4, name);
    const v = fourccStr(this.u, this.pos);
    if (name !== null) this.record(name, 'fourcc', this.pos, 4, v, o);
    this.pos += 4;
    return v;
  }

  bytes(name, n, o) {
    n = Math.max(0, Math.min(n, this.end - this.pos));
    this.need(n, name);
    const v = this.u.subarray(this.pos, this.pos + n);
    if (name !== null && n > 0) this.record(name, 'bytes', this.pos, n, v, o);
    this.pos += n;
    return v;
  }

  /** The rest of the buffer as one opaque field. */
  rest(name = 'data', o) {
    if (this.bit) this.align();
    if (this.remaining <= 0) return new Uint8Array(0);
    return this.bytes(name, this.remaining, o);
  }

  uuid(name, o) {
    this.need(16, name);
    const raw = this.u.subarray(this.pos, this.pos + 16);
    const v = uuidString(raw);
    if (name !== null) this.record(name, 'uuid', this.pos, 16, v, o);
    this.pos += 16;
    return v;
  }

  /** Fixed-length string field; trailing NULs are trimmed from the value. */
  str(name, n, o = {}) {
    n = Math.min(n, this.end - this.pos);
    this.need(n, name);
    const raw = this.u.subarray(this.pos, this.pos + n);
    let end = raw.length;
    while (end > 0 && raw[end - 1] === 0) end--;
    const v = decodeText(raw.subarray(0, end), o.encoding || 'utf-8');
    if (name !== null) this.record(name, 'string', this.pos, n, v, o);
    this.pos += n;
    return v;
  }

  /** NUL-terminated string (terminator consumed; missing terminator reads to the end). */
  cstr(name, o = {}) {
    if (this.bit) this.align();
    let e = this.pos;
    while (e < this.end && this.u[e] !== 0) e++;
    const v = decodeText(this.u.subarray(this.pos, e), o.encoding || 'utf-8');
    const len = Math.min(e + 1, this.end) - this.pos;
    if (name !== null) this.record(name, 'cstring', this.pos, len, v, o);
    this.pos += len;
    return v;
  }

  /** Pascal string: one length byte then that many characters. */
  pstr(name, o = {}) {
    this.need(1, name);
    const n = Math.min(this.u[this.pos], this.end - this.pos - 1);
    const v = decodeText(this.u.subarray(this.pos + 1, this.pos + 1 + n), o.encoding || 'utf-8');
    if (name !== null) this.record(name, 'pstring', this.pos, n + 1, v, o);
    this.pos += n + 1;
    return v;
  }

  skip(n, name = 'reserved', o) {
    n = Math.min(n, this.end - this.pos);
    if (n <= 0) return;
    const allZero = this.u.subarray(this.pos, this.pos + n).every((b) => b === 0);
    if (name !== null) {
      this.record(name, 'bytes', this.pos, n, this.u.subarray(this.pos, this.pos + n), {
        reserved: true,
        desc: allZero ? 'Reserved; must be zero.' : 'Reserved bytes (not all zero here).',
        ...o,
      });
    }
    this.pos += n;
  }

  // ---------- bits (most significant bit first) ----------

  bits(n, name, o) {
    if (n === 0) return 0;
    const startByte = this.pos;
    const startBit = this.bit;
    let v = 0;
    for (let i = 0; i < n; i++) {
      if (this.pos >= this.end) {
        throw new ParseError(`Not enough data for ${name ?? 'bits'}: needs ${n} bits`, this.absAt(Math.min(this.pos, this.end - 1)));
      }
      v = v * 2 + ((this.u[this.pos] >> (7 - this.bit)) & 1);
      if (++this.bit === 8) {
        this.bit = 0;
        this.pos++;
      }
    }
    if (name !== null) {
      const lastByte = this.bit === 0 ? this.pos - 1 : this.pos;
      const type = o?.type ?? (n === 1 && !(o && o.enum) ? 'flag' : `bits(${n})`);
      const f = this.record(name, type, startByte, lastByte - startByte + 1, v, o);
      f.bitOffset = startBit;
      f.bitSize = n;
    }
    return v;
  }

  flag(name, o) {
    return this.bits(1, name, o);
  }

  align(name = null) {
    if (this.bit) {
      const n = 8 - this.bit;
      this.bits(n, name, name ? {
        reserved: true,
        type: `bits(${n})`,
        display: (v) => v.toString(2).padStart(n, '0'),
        desc: 'Padding to the next byte boundary. In an RBSP this is the stop bit (1) followed by zeros.',
      } : undefined);
    }
  }

  get bitPos() {
    return this.pos * 8 + this.bit;
  }

  get bitsLeft() {
    return (this.end - this.pos) * 8 - this.bit;
  }

  /** Exp-Golomb unsigned, ue(v) (H.264/H.265). */
  ue(name, o) {
    const startByte = this.pos;
    const startBit = this.bit;
    let zeros = 0;
    while (this.bits(1, null) === 0) {
      if (++zeros > 31) throw new ParseError(`Invalid Exp-Golomb code for ${name}`, this.abs);
    }
    const v = zeros ? 2 ** zeros - 1 + this.bits(zeros, null) : 0;
    if (name !== null) {
      const lastByte = this.bit === 0 ? this.pos - 1 : this.pos;
      const f = this.record(name, 'ue(v)', startByte, lastByte - startByte + 1, v, o);
      f.bitOffset = startBit;
      f.bitSize = zeros * 2 + 1;
    }
    return v;
  }

  /** Exp-Golomb signed, se(v). */
  se(name, o) {
    const startByte = this.pos;
    const startBit = this.bit;
    const k = this.ue(null);
    const v = k === 0 ? 0 : k & 1 ? (k + 1) / 2 : -(k / 2);
    if (name !== null) {
      const lastByte = this.bit === 0 ? this.pos - 1 : this.pos;
      const f = this.record(name, 'se(v)', startByte, lastByte - startByte + 1, v, o);
      f.bitOffset = startBit;
      f.bitSize = (this.pos - startByte) * 8 + this.bit - startBit;
    }
    return v;
  }

  /** AV1 leb128 (little-endian base 128). */
  leb128(name, o) {
    const start = this.pos;
    let v = 0;
    for (let i = 0; i < 8; i++) {
      this.need(1, name);
      const b = this.u[this.pos++];
      v += (b & 0x7f) * 2 ** (7 * i);
      if (!(b & 0x80)) break;
    }
    if (name !== null) this.record(name, 'leb128', start, this.pos - start, v, o);
    return v;
  }

  /** MPEG-4 descriptor size: up to four bytes of 7 bits, continuation in the top bit. */
  expandableSize(name, o) {
    const start = this.pos;
    let v = 0;
    for (let i = 0; i < 4; i++) {
      this.need(1, name);
      const b = this.u[this.pos++];
      v = v * 128 + (b & 0x7f);
      if (!(b & 0x80)) break;
    }
    if (name !== null) this.record(name, 'size(v)', start, this.pos - start, v, o);
    return v;
  }

  // ---------- structure ----------

  /** Collect the fields recorded by fn() under one named struct field. */
  group(name, fn, o = {}) {
    const f = { name, type: 'struct', offset: this.abs, size: 0, children: [] };
    applyOpts(f, o);
    if (o.display) f.display = o.display;
    this.out.push(f);
    const saved = this.out;
    const startPos = this.pos;
    this.out = f.children;
    try {
      const r = fn(f);
      return r === undefined ? f : r;
    } finally {
      this.out = saved;
      const endPos = this.bit ? this.pos + 1 : this.pos;
      f.offset = this.absAt(startPos);
      f.size = this.spanSize(startPos, endPos);
    }
  }

  /** Run fn with the reader limited to the next n bytes, then continue after them. */
  bounded(n, fn) {
    const start = this.pos;
    const stop = Math.min(this.end, start + Math.max(0, n));
    const savedEnd = this.end;
    this.end = stop;
    try {
      return fn(this);
    } finally {
      this.end = savedEnd;
      this.bit = 0;
      this.pos = stop;
    }
  }

  /**
   * A lazily-decoded table of fixed-size entries (sample tables can have
   * hundreds of thousands of rows). Columns: {name, type, off?, size?, bits?, desc?, display?, enum?, ref?}
   * `bits: [first, count]` extracts bits (MSB first) from the column's bytes.
   */
  table(name, count, entrySize, columns, o = {}) {
    if (this.bit) this.align();
    const fit = entrySize > 0 ? Math.floor(Math.max(0, this.end - this.pos) / entrySize) : 0;
    const n = Math.max(0, Math.min(count, fit));
    // Bit columns share their bytes with neighbours; only the one marked `last`
    // (or any non-bit column) moves the running offset forward.
    let off = 0;
    const cols = columns.map((c) => {
      const size = c.size ?? TYPE_SIZES[c.type] ?? 0;
      const at = c.off ?? off;
      off = !c.bits || c.last ? at + size : at;
      return { ...c, off: at, size };
    });
    const t = {
      name,
      type: 'table',
      offset: this.abs,
      size: this.spanSize(this.pos, this.pos + n * entrySize),
      value: n,
      count: n,
      declared: count,
      entrySize,
      columns: cols,
      dv: this.dv,
      u: this.u,
      rel: this.pos,
      le: this.le,
    };
    applyOpts(t, o);
    t.display = o.display ?? `${fmtInt(n)} ${n === 1 ? 'entry' : 'entries'} × ${entrySize} bytes`;
    if (n < count) t.truncated = true;
    this.out.push(t);
    this.pos += n * entrySize;
    return t;
  }
}

/** Decode one table cell. */
export function cell(t, i, c) {
  const col = t.columns[c];
  const p = t.rel + i * t.entrySize + col.off;
  const dv = t.dv;
  const le = t.le;
  switch (col.type) {
    case 'u8': return dv.getUint8(p);
    case 'i8': return dv.getInt8(p);
    case 'u16': return dv.getUint16(p, le);
    case 'i16': return dv.getInt16(p, le);
    case 'u24': return le ? dv.getUint16(p, true) + dv.getUint8(p + 2) * 65536 : dv.getUint16(p) * 256 + dv.getUint8(p + 2);
    case 'u32': return dv.getUint32(p, le);
    case 'i32': return dv.getInt32(p, le);
    case 'u64': return Number(dv.getBigUint64(p, le));
    case 'i64': return Number(dv.getBigInt64(p, le));
    case 'f32': return dv.getFloat32(p, le);
    case 'f64': return dv.getFloat64(p, le);
    case 'fourcc': return fourccStr(t.u, p);
    case 'bytes': return t.u.subarray(p, p + col.size);
    case 'uN': {
      let v = 0;
      if (le) for (let k = col.size - 1; k >= 0; k--) v = v * 256 + t.u[p + k];
      else for (let k = 0; k < col.size; k++) v = v * 256 + t.u[p + k];
      return v;
    }
    case 'bits': {
      let v = 0;
      for (let k = 0; k < col.size; k++) v = v * 256 + t.u[p + k];
      const total = col.size * 8;
      const [first, count] = col.bits;
      return Math.floor(v / 2 ** (total - first - count)) % 2 ** count;
    }
    default: return undefined;
  }
}

export function cellDisplay(t, i, c) {
  const col = t.columns[c];
  const v = cell(t, i, c);
  if (col.display) return col.display(v, i, t);
  if (col.enum) {
    const name = col.enum[v];
    const shown = col.type === 'fourcc' ? `'${v}'` : fmtValue(col.type, v);
    return name !== undefined ? `${shown} (${name})` : shown;
  }
  if (col.type === 'bytes') return hexBytes(v, 16);
  return fmtValue(col.type, v);
}

export function cellBytes(t, i, c) {
  const col = t.columns[c];
  const p = t.rel + i * t.entrySize + col.off;
  return t.u.subarray(p, p + col.size);
}

/** Every value in one column, as a typed array when numeric. */
export function column(t, c) {
  if (typeof c === 'string') c = t.columns.findIndex((x) => x.name === c);
  if (c < 0) return null;
  const col = t.columns[c];
  if (col.type === 'fourcc' || col.type === 'bytes') {
    return Array.from({ length: t.count }, (_, i) => cell(t, i, c));
  }
  const Arr = col.type === 'u64' || col.type === 'i64' || col.type === 'f64' ? Float64Array
    : col.type.startsWith('i') ? Int32Array : col.type === 'f32' ? Float32Array : Uint32Array;
  const out = new Arr(t.count);
  if (col.type === 'u32' && !t.le) {
    for (let i = 0, p = t.rel + col.off; i < t.count; i++, p += t.entrySize) out[i] = t.dv.getUint32(p);
  } else {
    for (let i = 0; i < t.count; i++) out[i] = cell(t, i, c);
  }
  return out;
}

/** Find a field by name in a list (searching struct children too). */
export function findField(fields, name) {
  for (const f of fields) {
    if (f.name === name) return f;
    if (f.children) {
      const x = findField(f.children, name);
      if (x) return x;
    }
  }
  return null;
}

export function fieldValue(fields, name, fallback) {
  const f = findField(fields, name);
  return f ? f.value : fallback;
}

/** Raw bytes of a field for display, given the file bytes it came from. */
export function hexOfBytes(u8) {
  return Array.from(u8, (b) => HEX2[b]).join(' ');
}
