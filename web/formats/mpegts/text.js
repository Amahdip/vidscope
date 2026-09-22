// Small helpers: DVB text strings, DVB dates (MJD + BCD), and the display of
// 90 kHz / 27 MHz timestamps.

import { fmtInt, fmtNum, fmtDuration } from '../../core/util.js';
import { PTS_HZ, PCR_HZ, WRAP_33 } from './tables.js';

const decoders = new Map();
function decoder(label) {
  if (!decoders.has(label)) {
    let d = null;
    try {
      d = new TextDecoder(label);
    } catch {
      d = null;
    }
    decoders.set(label, d);
  }
  return decoders.get(label);
}

// First-byte selectors of the character tables (EN 300 468 Annex A).
const SINGLE_BYTE_TABLES = {
  0x01: 'iso-8859-5', 0x02: 'iso-8859-6', 0x03: 'iso-8859-7', 0x04: 'iso-8859-8', 0x05: 'iso-8859-9',
  0x06: 'iso-8859-10', 0x07: 'iso-8859-11', 0x09: 'iso-8859-13', 0x0a: 'iso-8859-14', 0x0b: 'iso-8859-15',
};

/**
 * Decode a DVB SI text field (EN 300 468 Annex A). The first byte may select a
 * character table; without one the default Latin table applies, which matches
 * ASCII for plain letters (accented letters use ISO/IEC 6937 non-spacing
 * diacritics, approximated here as Latin-1).
 * Returns { text, encoding }.
 */
export function dvbText(u8) {
  if (!u8 || !u8.length) return { text: '', encoding: 'empty' };
  let body = u8;
  let label = 'latin1';
  let encoding = 'default Latin table (ISO/IEC 6937, shown as Latin-1)';
  const first = u8[0];
  if (first < 0x20) {
    if (SINGLE_BYTE_TABLES[first]) {
      label = SINGLE_BYTE_TABLES[first];
      encoding = `${label.toUpperCase()} (selector 0x${first.toString(16).padStart(2, '0')})`;
      body = u8.subarray(1);
    } else if (first === 0x10 && u8.length >= 3) {
      const n = (u8[1] << 8) | u8[2];
      label = `iso-8859-${n}`;
      encoding = `ISO-8859-${n} (selector 0x10)`;
      body = u8.subarray(3);
    } else if (first === 0x11) {
      label = 'utf-16be';
      encoding = 'ISO/IEC 10646 BMP, UCS-2 big-endian (selector 0x11)';
      body = u8.subarray(1);
    } else if (first === 0x13) {
      label = 'gb2312';
      encoding = 'GB-2312 (selector 0x13)';
      body = u8.subarray(1);
    } else if (first === 0x12) {
      label = 'euc-kr';
      encoding = 'KS X 1001 (selector 0x12)';
      body = u8.subarray(1);
    } else if (first === 0x14) {
      label = 'big5';
      encoding = 'Big5 (selector 0x14)';
      body = u8.subarray(1);
    } else if (first === 0x15) {
      label = 'utf-8';
      encoding = 'UTF-8 (selector 0x15)';
      body = u8.subarray(1);
    } else if (first === 0x1f && u8.length >= 2) {
      encoding = `encoding_type_id 0x${u8[1].toString(16)} (selector 0x1F)`;
      body = u8.subarray(2);
    } else {
      body = u8.subarray(1);
      encoding = `reserved selector 0x${first.toString(16)}`;
    }
  }
  // Control codes (EN 300 468 Annex A): in single-byte tables 0x80–0x9F, where 0x8A is a
  // line break and 0x86/0x87 switch emphasis on/off; in UCS-2 and UTF-8 text the same codes
  // appear as U+E080–U+E09F. They are not characters, so they are removed before display.
  const twoByte = label === 'utf-16be' || label === 'utf-8';
  if (!twoByte) {
    const kept = [];
    for (const b of body) {
      if (b === 0x8a) kept.push(0x0a);
      else if (b < 0x80 || b > 0x9f) kept.push(b);
    }
    body = Uint8Array.from(kept);
  }
  let text;
  // Note: the WHATWG 'latin1' decoder is windows-1252, which equals ISO-8859-1 once 0x80–0x9F are gone.
  const d = decoder(label) ?? decoder('latin1');
  try {
    text = d.decode(body);
  } catch {
    text = decoder('latin1').decode(body);
  }
  if (twoByte) {
    let out = '';
    for (const ch of text) {
      const c = ch.codePointAt(0);
      if (c === 0xe08a) out += '\n';
      else if (c < 0xe080 || c > 0xe09f) out += ch;
    }
    text = out;
  }
  return { text, encoding };
}

/** Modified Julian Date + 24-bit BCD hh:mm:ss (the DVB UTC_time coding) → Date, or null. */
export function mjdTime(mjd, bcd) {
  if (mjd === 0xffff) return null;
  const h = bcdByte((bcd >> 16) & 0xff);
  const m = bcdByte((bcd >> 8) & 0xff);
  const s = bcdByte(bcd & 0xff);
  const ms = (mjd - 40587) * 86400000 + ((h * 60 + m) * 60 + s) * 1000;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function bcdByte(b) {
  return (b >> 4) * 10 + (b & 15);
}

/** 24-bit BCD duration hh:mm:ss → seconds. */
export function bcdDuration(bcd) {
  return (bcdByte((bcd >> 16) & 0xff) * 60 + bcdByte((bcd >> 8) & 0xff)) * 60 + bcdByte(bcd & 0xff);
}

export function fmtUtc(d) {
  return d ? d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC') : 'undefined (all ones)';
}

/** "133,200 → 0:01.480" for a 90 kHz timestamp. */
export function fmtTs(v) {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  return `${fmtInt(v)} → ${fmtDuration(v / PTS_HZ)}`;
}

/** Seconds of a 90 kHz value with 6 decimals. */
export function tsNote(v) {
  return `${fmtInt(v)} / 90,000 Hz = ${fmtNum(v / PTS_HZ, 6)} s`;
}

/** "0:01.400000" style time of a 27 MHz clock value. */
export function fmtPcrTime(v27) {
  const s = v27 / PCR_HZ;
  const whole = Math.floor(s);
  const frac = (s - whole).toFixed(6).slice(1);
  return `${fmtDuration(whole, false)}${frac}`;
}

export function fmtMs(sec, digits = 1) {
  if (sec === null || sec === undefined || !Number.isFinite(sec)) return '—';
  return `${fmtNum(sec * 1000, digits)} ms`;
}

/** The value congruent to `v` modulo `period` that is closest to `ref` (timestamp wrap-around). */
export function unwrap(v, ref, period = WRAP_33) {
  if (ref === null || ref === undefined || Number.isNaN(ref)) return v;
  return v + Math.round((ref - v) / period) * period;
}
