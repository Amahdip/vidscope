// Formatting and small helpers shared by parsers and UI.

export const HEX2 = Array.from({ length: 256 }, (_, i) => i.toString(16).toUpperCase().padStart(2, '0'));

const nf0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

export function fmtInt(n) {
  if (n === null || n === undefined) return '—';
  if (typeof n === 'bigint') return n.toLocaleString('en-US');
  if (!Number.isFinite(n)) return String(n);
  return nf0.format(n);
}

export function fmtNum(n, digits = 3) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  if (!Number.isFinite(n)) return String(n);
  return n.toLocaleString('en-US', { maximumFractionDigits: digits });
}

/** 0x-prefixed upper-case hex, zero padded to `width` digits. */
export function hex(n, width = 8) {
  if (typeof n === 'bigint') return '0x' + n.toString(16).toUpperCase().padStart(width, '0');
  if (n < 0) return '-0x' + Math.trunc(-n).toString(16).toUpperCase().padStart(width, '0');
  return '0x' + Math.trunc(n).toString(16).toUpperCase().padStart(width, '0');
}

export function hexDigits(size) {
  return size > 0xFFFFFFFF ? 10 : 8;
}

/** "06 A9 9D FE" */
export function hexBytes(u8, max = 48) {
  if (!u8) return '';
  const n = Math.min(u8.length, max);
  let s = '';
  for (let i = 0; i < n; i++) s += (i ? ' ' : '') + HEX2[u8[i]];
  if (u8.length > max) s += ` … (${fmtInt(u8.length)} bytes)`;
  return s;
}

/** "00000000 00100000" */
export function binBytes(u8, max = 8) {
  const n = Math.min(u8.length, max);
  let s = '';
  for (let i = 0; i < n; i++) s += (i ? ' ' : '') + u8[i].toString(2).padStart(8, '0');
  if (u8.length > max) s += ' …';
  return s;
}

/** Compact binary size used in the tree and cards: "32 B", "4.9 K", "106.6 M". */
export function humanSize(n) {
  if (n < 1024) return `${n} B`;
  const units = ['K', 'M', 'G', 'T'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

/** Longer form for headlines: "110.54 MB". */
export function humanBytes(n) {
  if (n < 1024) return `${n} bytes`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(2)} ${units[i]}`;
}

export function pct(part, whole, digits = 2) {
  if (!whole) return '—';
  const p = (part / whole) * 100;
  const min = 10 ** -digits;
  if (p > 0 && p < min) return `<${min}%`;
  return `${p.toFixed(digits)}%`;
}

/** 7457.867 -> "2:04:17.867" (hours only when needed). */
export function fmtDuration(sec, ms = true) {
  if (sec === null || sec === undefined || !Number.isFinite(sec)) return '—';
  const neg = sec < 0;
  let s = Math.abs(sec);
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  s -= m * 60;
  let secStr = ms ? s.toFixed(3).padStart(6, '0') : String(Math.floor(s)).padStart(2, '0');
  if (secStr.startsWith('60')) secStr = ms ? '59.999' : '59';
  const body = h ? `${h}:${String(m).padStart(2, '0')}:${secStr}` : `${m}:${secStr}`;
  return (neg ? '-' : '') + body;
}

export function fmtBitrate(bps) {
  if (!Number.isFinite(bps) || bps <= 0) return '—';
  if (bps >= 1e6) return `${(bps / 1e6).toFixed(2)} Mb/s`;
  if (bps >= 1e3) return `${(bps / 1e3).toFixed(1)} kb/s`;
  return `${Math.round(bps)} b/s`;
}

export function fmtHz(hz) {
  if (!hz) return '—';
  return hz >= 1000 ? `${fmtNum(hz / 1000, 3)} kHz` : `${fmtNum(hz, 3)} Hz`;
}

/** Four-character code with non-printable bytes escaped; 0xA9 shows as the © used by QuickTime tags. */
export function fourcc(u8, i = 0) {
  let s = '';
  for (let k = 0; k < 4; k++) {
    const c = u8[i + k];
    if (c === undefined) break;
    if (c >= 0x20 && c < 0x7f) s += String.fromCharCode(c);
    else if (c === 0xa9) s += '©';
    else s += `\\x${HEX2[c]}`;
  }
  return s;
}

export function isPrintableFourcc(u8, i = 0) {
  for (let k = 0; k < 4; k++) {
    const c = u8[i + k];
    if (!((c >= 0x20 && c < 0x7f) || c === 0xa9)) return false;
  }
  return true;
}

export function asciiChar(b) {
  return b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.';
}

const utf8Decoder = new TextDecoder('utf-8');
const latin1Decoder = new TextDecoder('latin1');
const utf16beDecoder = (() => {
  try {
    return new TextDecoder('utf-16be');
  } catch {
    return null;
  }
})();
const utf16leDecoder = new TextDecoder('utf-16le');

export function decodeText(u8, encoding = 'utf-8') {
  if (!u8 || !u8.length) return '';
  if (encoding === 'latin1') return latin1Decoder.decode(u8);
  if (encoding === 'utf-16be') {
    if (utf16beDecoder) return utf16beDecoder.decode(u8);
    const swapped = new Uint8Array(u8.length & ~1);
    for (let i = 0; i + 1 < u8.length; i += 2) {
      swapped[i] = u8[i + 1];
      swapped[i + 1] = u8[i];
    }
    return utf16leDecoder.decode(swapped);
  }
  if (encoding === 'utf-16le') return utf16leDecoder.decode(u8);
  return utf8Decoder.decode(u8);
}

/** Quote a string for display, escaping control characters. */
export function quote(s, max = 200) {
  let t = String(s);
  if (t.length > max) t = t.slice(0, max) + '…';
  // eslint-disable-next-line no-control-regex
  return '"' + t.replace(/[\x00-\x1f\x7f]/g, (c) => `\\x${HEX2[c.charCodeAt(0)]}`) + '"';
}

export function uuidString(u8) {
  const h = Array.from(u8.subarray(0, 16), (b) => HEX2[b].toLowerCase()).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

// Seconds between 1904-01-01 (QuickTime/MP4 epoch) and 1970-01-01.
const EPOCH_1904 = 2082844800;

export function date1904(secs) {
  if (!secs) return null;
  const d = new Date((secs - EPOCH_1904) * 1000);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function fmtDate(d) {
  if (!d) return '—';
  return d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
}

export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

export function gcd(a, b) {
  a = Math.abs(a);
  b = Math.abs(b);
  while (b) [a, b] = [b, a % b];
  return a;
}

/** "16:9" style ratio when it reduces nicely, else a decimal. */
export function ratio(w, h) {
  if (!w || !h) return '—';
  const g = gcd(w, h);
  const a = w / g;
  const b = h / g;
  return a <= 64 && b <= 64 ? `${a}:${b}` : (w / h).toFixed(3);
}

/**
 * Parse user input for "go to offset": decimal, 0x hex, "1A h", with k/M/G suffixes,
 * percentages of the file ("50%"), or negative values counted from the end.
 */
export function parseOffset(input, size) {
  let s = String(input).trim().replace(/[,_\s]/g, '');
  if (!s) return null;
  let fromEnd = false;
  if (s.startsWith('-')) {
    fromEnd = true;
    s = s.slice(1);
  }
  let v;
  if (/^\d+(\.\d+)?%$/.test(s)) {
    v = Math.floor((parseFloat(s) / 100) * size);
  } else if (/^0x[0-9a-f]+$/i.test(s)) {
    v = parseInt(s.slice(2), 16);
  } else if (/^\$?[0-9a-f]+h$/i.test(s)) {
    v = parseInt(s.replace(/^\$/, '').slice(0, -1), 16);
  } else if (/^\d+(\.\d+)?[kmg]i?b?$/i.test(s)) {
    const m = /^(\d+(?:\.\d+)?)([kmg])/i.exec(s);
    const mult = { k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[m[2].toLowerCase()];
    v = Math.floor(parseFloat(m[1]) * mult);
  } else if (/^\d+$/.test(s)) {
    v = parseInt(s, 10);
  } else if (/^[0-9a-f]+$/i.test(s)) {
    v = parseInt(s, 16);
  } else {
    return null;
  }
  if (!Number.isFinite(v)) return null;
  if (fromEnd) v = size - v;
  return clamp(v, 0, Math.max(0, size - 1));
}

export function debounce(fn, ms) {
  let t = 0;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

/** Coalesce calls into one per animation frame. */
export function rafThrottle(fn) {
  let queued = false;
  let lastArgs = null;
  return (...args) => {
    lastArgs = args;
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      fn(...lastArgs);
    });
  };
}

export function plural(n, one, many = one + 's') {
  return `${fmtInt(n)} ${n === 1 ? one : many}`;
}
