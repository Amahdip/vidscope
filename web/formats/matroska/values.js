// Human-readable values of Matroska elements: "1,000,000 → 1 ms ticks",
// "4021 → 0:04.021", language names, codec names, track references...

import { fmtInt, fmtNum, fmtDate, quote, hexBytes, uuidString } from '../../core/util.js';
import { hexId, dateFromNs, fmtNs, clock, tickName } from './ebml.js';
import { BY_ID, BLOCK_ADD_ID_TYPES, PHYSICAL_EQUIV, fourccOf } from './elements.js';
import { codecInfo } from './codecs.js';

const LANGS = {
  eng: 'English', en: 'English', fre: 'French', fra: 'French', fr: 'French', ger: 'German', deu: 'German', de: 'German',
  spa: 'Spanish', es: 'Spanish', ita: 'Italian', it: 'Italian', jpn: 'Japanese', ja: 'Japanese', chi: 'Chinese',
  zho: 'Chinese', zh: 'Chinese', kor: 'Korean', ko: 'Korean', rus: 'Russian', ru: 'Russian', por: 'Portuguese',
  pt: 'Portuguese', dut: 'Dutch', nld: 'Dutch', nl: 'Dutch', swe: 'Swedish', sv: 'Swedish', nor: 'Norwegian',
  no: 'Norwegian', nob: 'Norwegian Bokmål', nb: 'Norwegian Bokmål', dan: 'Danish', da: 'Danish', fin: 'Finnish',
  fi: 'Finnish', pol: 'Polish', pl: 'Polish', tur: 'Turkish', tr: 'Turkish', ara: 'Arabic', ar: 'Arabic',
  heb: 'Hebrew', he: 'Hebrew', hin: 'Hindi', hi: 'Hindi', tha: 'Thai', th: 'Thai', vie: 'Vietnamese', vi: 'Vietnamese',
  ind: 'Indonesian', id: 'Indonesian', cze: 'Czech', ces: 'Czech', cs: 'Czech', hun: 'Hungarian', hu: 'Hungarian',
  gre: 'Greek', ell: 'Greek', el: 'Greek', rum: 'Romanian', ron: 'Romanian', ro: 'Romanian', ukr: 'Ukrainian',
  uk: 'Ukrainian', bul: 'Bulgarian', bg: 'Bulgarian', hrv: 'Croatian', hr: 'Croatian', srp: 'Serbian', sr: 'Serbian',
  slo: 'Slovak', slk: 'Slovak', sk: 'Slovak', slv: 'Slovenian', sl: 'Slovenian', cat: 'Catalan', ca: 'Catalan',
  baq: 'Basque', eus: 'Basque', eu: 'Basque', glg: 'Galician', gl: 'Galician', per: 'Persian', fas: 'Persian',
  fa: 'Persian', may: 'Malay', msa: 'Malay', ms: 'Malay', tam: 'Tamil', ta: 'Tamil', tel: 'Telugu', te: 'Telugu',
  ben: 'Bengali', bn: 'Bengali', ice: 'Icelandic', isl: 'Icelandic', is: 'Icelandic', lat: 'Latin', la: 'Latin',
  und: 'undetermined', mul: 'multiple languages', zxx: 'no linguistic content', mis: 'uncoded language',
};

export function languageName(code) {
  if (!code) return null;
  const base = String(code).split('-')[0].toLowerCase();
  return LANGS[base] ?? null;
}

/** 64-bit UIDs: "0x2BE6CDF1A6E8F593". */
export function uidHex(v, big) {
  if (big !== undefined) return `0x${BigInt(big).toString(16).toUpperCase()}`;
  if (!Number.isFinite(v)) return String(v);
  return `0x${v.toString(16).toUpperCase()}`;
}

const SCOPES = { 1: 'frames in blocks', 2: 'CodecPrivate', 4: 'the next ContentEncoding' };
const CHAP_CODECS = { 0: 'Matroska Script', 1: 'DVD menu' };

function sniffFile(u8) {
  if (!u8 || u8.length < 4) return null;
  const b = u8;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'JPEG image';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'PNG image';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'GIF image';
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b.length >= 12 && b[8] === 0x57 && b[9] === 0x45) return 'WebP image';
  if (b[0] === 0x00 && b[1] === 0x01 && b[2] === 0x00 && b[3] === 0x00) return 'TrueType font';
  if (b[0] === 0x4f && b[1] === 0x54 && b[2] === 0x54 && b[3] === 0x4f) return 'OpenType font';
  if (b[0] === 0x74 && b[1] === 0x74 && b[2] === 0x63 && b[3] === 0x66) return 'font collection';
  if (b[0] === 0x77 && b[1] === 0x4f && b[2] === 0x46 && b[3] === 0x46) return 'WOFF font';
  if (b[0] === 0x77 && b[1] === 0x4f && b[2] === 0x46 && b[3] === 0x32) return 'WOFF2 font';
  if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return 'PDF document';
  if (b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04) return 'ZIP archive';
  return null;
}

/**
 * Display, label and note for the value of element `el`.
 * c: { scale (TimestampScale), segData (Segment data start), track(n) → track, trackByUid(uid) → track }
 * Returns {display, label, note?}.
 */
export function present(el, v, c = {}, extra = {}) {
  const scale = c.scale || 1e6;
  const t = el.type;
  if (extra.empty) {
    const d = el.default !== undefined ? el.default : t === 's' || t === '8' ? '' : 0;
    const base = present(el, d, c, { ...extra, empty: false });
    return { ...base, display: `(empty) → ${base.display}`, note: el.default !== undefined ? `An empty element means the default value, ${el.default}.` : 'An empty element means 0 or an empty string.' };
  }
  const bigStr = extra.big !== undefined ? BigInt(extra.big).toLocaleString('en-US') : null;
  const num = bigStr ?? (typeof v === 'number' ? (Number.isInteger(v) ? fmtInt(v) : fmtNum(v, 6)) : String(v));
  // Enumerations and flags
  if (el.enum && (t === 'u' || t === 'i') && !el.show) {
    const name = el.enum[v];
    return { display: `${num} — ${name ?? 'unknown value'}`, label: name ?? num };
  }
  if (!el.show && el.range === '0-1' && t === 'u') {
    return { display: `${v} (${v ? 'yes' : 'no'})`, label: v ? 'yes' : 'no' };
  }
  switch (el.show) {
    case 'scale':
      return {
        display: `${num} ns → ${tickName(v)} ticks`,
        label: `${tickName(v)} ticks`,
        note: `One tick is ${fmtInt(v)} ns. A Cluster Timestamp of 2,000 means ${fmtNs(2000 * v)}.`,
      };
    case 'ticks': {
      const s = (v * scale) / 1e9;
      return { display: `${num} ticks → ${clock(s)}`, label: clock(s), note: `${num} × ${fmtInt(scale)} ns (TimestampScale) = ${fmtNs(v * scale)}` };
    }
    case 'fticks': {
      const s = (v * scale) / 1e9;
      return { display: `${fmtNum(v, 3)} ticks → ${clock(s)}`, label: clock(s), note: `${fmtNum(v, 6)} × ${fmtInt(scale)} ns (TimestampScale) = ${fmtNum(s, 6)} s` };
    }
    case 'trackticks':
      return { display: `${num} ticks → ${fmtNs(v * scale)}`, label: fmtNs(v * scale) };
    case 'reltrackticks': {
      const sign = v > 0 ? '+' : '';
      if (v === 0) return { display: '0 → references itself or an unknown frame', label: 'self/unknown' };
      return { display: `${sign}${num} ticks (${sign}${fmtNs(v * scale)}): depends on the frame ${v < 0 ? 'before' : 'after'} it by that much`, label: `${sign}${fmtNs(v * scale)}` };
    }
    case 'ns': {
      let extraText = '';
      if (el.name === 'DefaultDuration' && v > 0) extraText = ` (${fmtNum(1e9 / v, 3)} per second)`;
      return { display: `${num} ns → ${fmtNs(v)}${extraText}`, label: fmtNs(v) };
    }
    case 'nstime':
      return { display: `${num} ns → ${clock(v / 1e9)}`, label: clock(v / 1e9) };
    case 'segpos':
    case 'segpos0': {
      if (el.show === 'segpos0' && v === 0) return { display: '0 (use the track\'s CodecPrivate)', label: '0' };
      if (c.segData === undefined) return { display: num, label: num };
      const abs = c.segData + v;
      return { display: `${num} → file offset ${fmtInt(abs)}`, label: `@${fmtInt(abs)}`, note: `${num} bytes after the start of the Segment's data (file offset ${fmtInt(c.segData)}) = file offset ${fmtInt(abs)}.`, abs };
    }
    case 'relpos':
      return { display: `${num} bytes into the Cluster's data`, label: `+${num}` };
    case 'bytes':
      return { display: `${num} bytes`, label: `${num} B` };
    case 'uid': {
      const h = uidHex(v, extra.big);
      return { display: `${h} (${num})`, label: h };
    }
    case 'taguid': {
      if (v === 0) return { display: '0 (all tracks)', label: 'all tracks' };
      const h = uidHex(v, extra.big);
      const tr = c.trackByUid?.(extra.big !== undefined ? String(extra.big) : v);
      return { display: `${h}${tr ? ` → ${tr.label}` : ' (no track has this UID)'}`, label: tr ? tr.label : h };
    }
    case 'track': {
      const tr = c.track?.(v);
      return { display: `${num}${tr ? ` → ${tr.label}` : c.track ? ' (no TrackEntry has this number)' : ''}`, label: tr ? `${num} (${tr.short})` : num };
    }
    case 'lang': {
      const name = languageName(v);
      return { display: `${quote(v)}${name ? ` (${name})` : ''}`, label: v };
    }
    case 'hz':
      return { display: `${fmtNum(v, 3)} Hz`, label: `${fmtNum(v, 3)} Hz` };
    case 'px':
      return { display: `${num} px`, label: `${num} px` };
    case 'dispunit':
      return { display: num, label: num };
    case 'nits':
      return { display: `${fmtNum(v, 4)} cd/m²`, label: `${fmtNum(v, 4)} cd/m²` };
    case 'xy':
      return { display: fmtNum(v, 5), label: fmtNum(v, 4) };
    case 'deg':
      return { display: `${fmtNum(v, 3)}°`, label: `${fmtNum(v, 3)}°` };
    case 'codecid': {
      const ci = codecInfo(v);
      return { display: `${quote(v)}${ci ? ` → ${ci.name}` : ' (unknown codec ID)'}`, label: v };
    }
    case 'scope': {
      const parts = Object.entries(SCOPES).filter(([bit]) => v & Number(bit)).map(([, s]) => s);
      return { display: `${num} → ${parts.join(' + ') || 'nothing'}`, label: parts.join(' + ') || num };
    }
    case 'addidtype': {
      const name = BLOCK_ADD_ID_TYPES[v] ?? (fourccOf(v) ? `'${fourccOf(v)}'` : null);
      return { display: `${num}${name ? ` → ${name}` : ''}`, label: name ?? num };
    }
    case 'physical': {
      const name = PHYSICAL_EQUIV[v];
      return { display: `${num}${name ? ` → ${name}` : ''}`, label: name ?? num };
    }
    case 'chapcodec':
      return { display: `${num} → ${CHAP_CODECS[v] ?? 'unknown'}`, label: CHAP_CODECS[v] ?? num };
    default:
      break;
  }
  switch (t) {
    case 'u':
    case 'i':
      return { display: num, label: num };
    case 'f':
      return { display: fmtNum(v, 6), label: fmtNum(v, 4) };
    case 's':
    case '8': {
      const s = String(v);
      return { display: quote(s), label: s.length > 48 ? `${s.slice(0, 47)}…` : s };
    }
    case 'd': {
      const d = dateFromNs(v);
      return { display: `${num} ns → ${fmtDate(d)}`, label: d ? d.toISOString().slice(0, 10) : num, note: 'Nanoseconds since 2001-01-01 00:00:00 UTC (the EBML date epoch).' };
    }
    default:
      return { display: String(v), label: '' };
  }
}

/** Display for a binary element's bytes. */
export function presentBinary(el, u8, s, n, c = {}) {
  const name = el?.name;
  if (n === 0) return { display: '(empty)', label: '' };
  const bytes = u8.subarray(s, s + n);
  if (el?.show === 'uuid' && n === 16) {
    const u = uuidString(bytes);
    return { display: u, label: u.slice(0, 8) };
  }
  if (name === 'SeekID') {
    let id = 0;
    for (let i = 0; i < Math.min(n, 4); i++) id = id * 256 + u8[s + i];
    const e = BY_ID.get(id);
    return { display: `${hexId(id)} → ${e ? e.name : 'unknown element'}`, label: e ? e.name : hexId(id), value: id };
  }
  if (el?.show === 'fourcc' && n === 4) {
    const cc = String.fromCharCode(...bytes);
    return { display: `'${cc}' (${hexBytes(bytes)})`, label: cc };
  }
  if (name === 'FileData') {
    const kind = sniffFile(bytes);
    return { display: `${fmtInt(n)} bytes${kind ? ` (looks like a ${kind})` : ''}`, label: kind ?? `${fmtInt(n)} B` };
  }
  if (name === 'ContentCompSettings' || name === 'ContentEncKeyID') {
    return { display: hexBytes(bytes, 32), label: hexBytes(bytes, 8) };
  }
  if (name === 'TagBinary' || name === 'BlockAdditional' || name === 'ProjectionPrivate' || name === 'CodecState' || name === 'BlockAddIDExtraData') {
    return { display: `${fmtInt(n)} bytes: ${hexBytes(bytes, 16)}`, label: `${fmtInt(n)} B` };
  }
  return { display: hexBytes(bytes, 24), label: n <= 8 ? hexBytes(bytes, 8) : `${fmtInt(n)} B` };
}

