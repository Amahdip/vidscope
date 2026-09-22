// Codec names and per-sample parsing shared by all container formats.

import { FieldReader, ParseError } from '../core/fields.js';
import { fmtInt } from '../core/util.js';
import { splitLengthPrefixed, splitAnnexB } from './nal.js';
import * as h264 from './h264.js';
import * as h265 from './h265.js';
import { parseObus } from './av1.js';
import { vp9Frames, parseVp9Frame, parseVp8Frame } from './vp9.js';
import { parseMpegAudioHeader, parseAc3Header, parseEac3Header } from './audio.js';
import { parseAdts } from './mpeg4audio.js';

export const CODEC_NAMES = {
  avc1: 'H.264 / AVC', avc2: 'H.264 / AVC', avc3: 'H.264 / AVC (parameter sets in-band)', avc4: 'H.264 / AVC (parameter sets in-band)',
  hvc1: 'H.265 / HEVC', hev1: 'H.265 / HEVC (parameter sets in-band)', hvc2: 'H.265 / HEVC', hev2: 'H.265 / HEVC',
  dvh1: 'Dolby Vision (HEVC)', dvhe: 'Dolby Vision (HEVC, in-band)', dva1: 'Dolby Vision (AVC)', dvav: 'Dolby Vision (AVC, in-band)',
  dav1: 'Dolby Vision (AV1)', vvc1: 'H.266 / VVC', vvi1: 'H.266 / VVC (in-band)', evc1: 'MPEG-5 EVC', apv1: 'APV',
  av01: 'AV1', vp08: 'VP8', vp09: 'VP9', vp10: 'VP10', mp4v: 'MPEG-4 Part 2 Visual', s263: 'H.263', h263: 'H.263',
  jpeg: 'Motion JPEG', mjpa: 'Motion JPEG A', mjpb: 'Motion JPEG B', mjp2: 'Motion JPEG 2000', png: 'PNG',
  apch: 'Apple ProRes 422 HQ', apcn: 'Apple ProRes 422', apcs: 'Apple ProRes 422 LT', apco: 'Apple ProRes 422 Proxy',
  ap4h: 'Apple ProRes 4444', ap4x: 'Apple ProRes 4444 XQ', aprh: 'Apple ProRes RAW HQ', aprn: 'Apple ProRes RAW',
  'dvc ': 'DV (NTSC)', dvcp: 'DV (PAL)', dvpp: 'DVCPRO (PAL)', dv5n: 'DVCPRO50 (NTSC)', dv5p: 'DVCPRO50 (PAL)',
  dvh2: 'DVCPRO HD', dvh3: 'DVCPRO HD', dvh5: 'DVCPRO HD', dvh6: 'DVCPRO HD', dvhp: 'DVCPRO HD', dvhq: 'DVCPRO HD',
  AVdn: 'Avid DNxHD', AVdh: 'Avid DNxHR', 'raw ': 'Uncompressed', rle: 'Animation (RLE)', 'rle ': 'Animation (RLE)',
  hvt1: 'HEVC tile track', lhv1: 'Layered HEVC', lhe1: 'Layered HEVC', mp4s: 'MPEG-4 Systems', uncv: 'Uncompressed video',
  mp4a: 'MPEG-4 Audio (AAC)', 'ac-3': 'AC-3 (Dolby Digital)', 'ec-3': 'E-AC-3 (Dolby Digital Plus)', 'ac-4': 'AC-4',
  Opus: 'Opus', opus: 'Opus', fLaC: 'FLAC', flac: 'FLAC', alac: 'Apple Lossless (ALAC)', samr: 'AMR-NB', sawb: 'AMR-WB',
  sawp: 'AMR-WB+', lpcm: 'Linear PCM', ipcm: 'Integer PCM', fpcm: 'Floating-point PCM', twos: 'PCM (big-endian)',
  sowt: 'PCM (little-endian)', in24: 'PCM 24-bit', in32: 'PCM 32-bit', fl32: 'PCM float32', fl64: 'PCM float64',
  NONE: 'PCM', ulaw: 'µ-law', alaw: 'A-law', '.mp3': 'MP3', 'mp3 ': 'MP3', mha1: 'MPEG-H 3D Audio', mha2: 'MPEG-H 3D Audio',
  mhm1: 'MPEG-H 3D Audio', mhm2: 'MPEG-H 3D Audio', dtsc: 'DTS', dtsh: 'DTS-HD', dtsl: 'DTS-HD Master Audio', dtse: 'DTS Express',
  dtsx: 'DTS:X', mlpa: 'Dolby TrueHD', iamf: 'IAMF (immersive audio)', ima4: 'IMA ADPCM', 'ms\x00\x11': 'IMA ADPCM',
  tx3g: '3GPP timed text', wvtt: 'WebVTT', stpp: 'TTML (XML subtitles)', sbtt: 'Text subtitles', stxt: 'Simple text',
  c608: 'CEA-608 captions', c708: 'CEA-708 captions', text: 'QuickTime text', tmcd: 'Timecode', mett: 'Text metadata',
  metx: 'XML metadata', urim: 'URI metadata', mebx: 'Boxed metadata', camm: 'Camera motion metadata', gpmd: 'GoPro metadata',
  'rtp ': 'RTP hint', 'srtp': 'SRTP hint', encv: 'Encrypted video', enca: 'Encrypted audio', encs: 'Encrypted systems',
  enct: 'Encrypted text', encm: 'Encrypted metadata', resv: 'Restricted video',
};

/** Family key used to pick a sample parser. */
export function codecFamily(fourcc) {
  if (!fourcc) return null;
  if (/^(avc[1-4]|dva1|dvav)$/.test(fourcc)) return 'avc';
  if (/^(hvc[1-3]|hev[1-3]|dvh1|dvhe|lhv1|lhe1)$/.test(fourcc)) return 'hevc';
  if (fourcc === 'av01' || fourcc === 'dav1') return 'av1';
  if (fourcc === 'vp09') return 'vp9';
  if (fourcc === 'vp08') return 'vp8';
  if (fourcc === 'mp4a') return 'aac';
  if (fourcc === '.mp3' || fourcc === 'mp3 ') return 'mp3';
  if (fourcc === 'ac-3') return 'ac3';
  if (fourcc === 'ec-3') return 'eac3';
  if (fourcc === 'tx3g' || fourcc === 'text') return 'tx3g';
  if (fourcc === 'tmcd') return 'tmcd';
  if (fourcc === 'Opus' || fourcc === 'opus') return 'opus';
  return null;
}

/** Only the NAL header is in the clear in Common Encryption subsample schemes. */
function encryptedNal(family, u8, start, end, base, fields) {
  const r = new FieldReader(u8, base, { start, end, out: fields });
  r.bits(1, 'forbidden_zero_bit');
  let type;
  if (family === 'avc') {
    r.bits(2, 'nal_ref_idc');
    type = r.bits(5, 'nal_unit_type', { key: true, enum: h264.NAL_TYPES });
  } else {
    type = r.bits(6, 'nal_unit_type', { key: true, enum: h265.NAL_TYPES });
    r.bits(6, 'nuh_layer_id');
    r.bits(3, 'nuh_temporal_id_plus1');
  }
  if (r.pos < end) {
    fields.push({ name: 'payload (encrypted)', type: 'bytes', offset: base + r.pos, size: end - r.pos, value: null, display: `${(end - r.pos).toLocaleString('en-US')} bytes`, role: 'payload', desc: 'Common Encryption keeps NAL headers readable but encrypts the payload (from a subsample boundary on), so its fields cannot be decoded without the key.' });
  }
  const mod = family === 'avc' ? h264 : h265;
  const name = mod.NAL_TYPES[type] ?? `type ${type}`;
  return { type, name, short: (family === 'avc' ? h264.NAL_SHORT[type] : null) ?? name.split(' ')[0], summary: `${name} (payload encrypted)` };
}

function timecode(frame, fps, drop) {
  let f = frame;
  if (drop && (fps === 30 || fps === 60)) {
    // Drop-frame: skip frame numbers 0-1 (or 0-3 at 60) at the start of each minute except every tenth.
    const d = fps === 30 ? 2 : 4;
    const perMin = fps * 60 - d;
    const per10 = perMin * 10 + d;
    const tens = Math.floor(f / per10);
    const rem = f % per10;
    f += d * 9 * tens;
    if (rem > d) f += d * Math.floor((rem - d) / perMin);
  }
  const ff = f % fps;
  const secs = Math.floor(f / fps);
  const pad = (v) => String(v).padStart(2, '0');
  return `${pad(Math.floor(secs / 3600))}:${pad(Math.floor(secs / 60) % 60)}:${pad(secs % 60)}${drop ? ';' : ':'}${pad(ff)}`;
}

const OPUS_MODES = (cfg) => {
  if (cfg < 12) return ['SILK', ['NB', 'MB', 'WB'][cfg >> 2], [10, 20, 40, 60][cfg & 3]];
  if (cfg < 16) return ['Hybrid', cfg < 14 ? 'SWB' : 'FB', [10, 20][cfg & 1]];
  const c = cfg - 16;
  return ['CELT', ['NB', 'WB', 'SWB', 'FB'][c >> 2], [2.5, 5, 10, 20][c & 3]];
};

/**
 * Split a sample into its codec units (NAL units, OBUs, frames) and decode
 * their headers. `cfg` is {family, lengthSize?, state?, annexB?}.
 * Returns {units: [{title, offset, size, summary, fields, key?}], note?}.
 */
export function parseSample(cfg, u8, start, end, base) {
  const units = [];
  const family = cfg?.family;
  try {
    if (family === 'avc' || family === 'hevc') {
      const mod = family === 'avc' ? h264 : h265;
      const state = cfg.state ?? (cfg.state = { spsById: new Map(), ppsById: new Map() });
      const nal = cfg.annexB ? { units: splitAnnexB(u8, start, end), trailing: 0 } : splitLengthPrefixed(u8, start, end, cfg.lengthSize || 4);
      nal.units.forEach((u, i) => {
        const fields = [];
        if (cfg.annexB) {
          fields.push({ name: 'start_code', type: 'bytes', offset: base + u.prefix, size: u.start - u.prefix, value: u8.subarray(u.prefix, u.start), display: u.start - u.prefix === 4 ? '00 00 00 01' : '00 00 01', role: 'header', desc: 'Annex B start code: marks where a NAL unit begins in a byte stream.' });
        } else {
          const ls = u.start - u.prefix;
          fields.push({
            name: 'NALUnitLength',
            type: `uint${ls * 8}`,
            offset: base + u.prefix,
            size: ls,
            value: u.declared,
            display: `${fmtInt(u.declared)} bytes${u.truncated ? ' (runs past the end of the sample!)' : ''}`,
            role: 'header',
            desc: 'Length of the NAL unit that follows. In MP4/MKV each NAL unit is prefixed by its length ("AVCC" framing) instead of the 00 00 01 start codes of a raw stream.',
          });
        }
        const res = cfg.encrypted ? encryptedNal(family, u8, u.start, u.end, base, fields) : mod.parseNalUnit(u8, u.start, u.end, base, fields, state);
        const key = family === 'avc' ? res.type === 5 : h265.isIrap(res.type);
        units.push({
          title: `NAL ${i} · ${res.short}`,
          offset: base + u.prefix,
          size: u.end - u.prefix,
          summary: res.summary + (res.error ? ` (${res.error})` : ''),
          fields,
          key,
          kind: res.type,
        });
      });
      if (nal.trailing > 0 && !cfg.annexB) {
        units.push({ title: 'trailing bytes', offset: base + end - nal.trailing, size: nal.trailing, summary: 'bytes after the last complete NAL unit', fields: [] });
      }
    } else if (family === 'av1') {
      const out = [];
      const { units: obus } = parseObus(u8, start, end, base, out, cfg.state ?? (cfg.state = {}));
      obus.forEach((o, i) => {
        units.push({ title: `OBU ${i} · ${o.name}`, offset: o.offset, size: o.size, summary: o.summary, fields: out[i]?.children ?? [], key: o.frame?.frame_type === 0 && o.frame?.show_frame });
      });
    } else if (family === 'vp9') {
      const { frames, index } = vp9Frames(u8, start, end);
      frames.forEach((f, i) => {
        const fields = [];
        const res = parseVp9Frame(u8, f.start, f.end, base, fields);
        units.push({ title: frames.length > 1 ? `frame ${i}` : 'frame', offset: base + f.start, size: f.end - f.start, summary: res.summary, fields, key: res.key });
      });
      if (index) units.push({ title: 'superframe index', offset: base + index.start, size: index.end - index.start, summary: `${frames.length} frames packed in one sample`, fields: [] });
    } else if (family === 'vp8') {
      const fields = [];
      const res = parseVp8Frame(u8, start, end, base, fields);
      units.push({ title: 'frame', offset: base + start, size: end - start, summary: res.summary, fields, key: res.key });
    } else if (family === 'aac') {
      const fields = [];
      if (cfg.adts) {
        const h = parseAdts(u8, start, end, base, fields);
        units.push({ title: 'ADTS frame', offset: base + start, size: end - start, summary: h.summary, fields });
      } else {
        const r = new FieldReader(u8, base, { start, end, out: fields });
        r.bits(3, 'id_syn_ele', {
          enum: { 0: 'SCE (single channel)', 1: 'CPE (channel pair)', 2: 'CCE (coupling)', 3: 'LFE', 4: 'DSE (data)', 5: 'PCE (program config)', 6: 'FIL (fill)', 7: 'END' },
          desc: 'The first syntactic element of the raw AAC frame. Everything after it is Huffman-coded spectral data.',
        });
        fields.push({ name: 'raw_data_block', type: 'bytes', offset: base + start, size: end - start, value: null, display: `${fmtInt(end - start)} bytes`, role: 'payload', desc: 'One raw AAC frame (1024 or 960 samples per channel). MP4 stores AAC without ADTS headers; the configuration lives in esds.' });
        units.push({ title: 'AAC frame', offset: base + start, size: end - start, summary: `raw AAC frame, ${fmtInt(end - start)} bytes`, fields });
      }
    } else if (family === 'mp3') {
      const fields = [];
      const h = parseMpegAudioHeader(u8, start, end, base, fields);
      units.push({ title: 'MPEG audio frame', offset: base + start, size: end - start, summary: h.summary, fields });
    } else if (family === 'eac3') {
      let p = start;
      let i = 0;
      while (p + 6 <= end && i < 16) {
        const fields = [];
        const hd = parseEac3Header(u8, p, end, base, fields);
        const frm = ((((u8[p + 2] & 7) << 8) | u8[p + 3]) + 1) * 2;
        const e = Math.min(end, p + frm);
        units.push({ title: `E-AC-3 frame ${i}`, offset: base + p, size: e - p, summary: hd.summary, fields });
        if (hd.error || frm <= 0) break;
        p = e;
        i++;
      }
    } else if (family === 'tx3g') {
      const fields = [];
      const r = new FieldReader(u8, base, { start, end, out: fields });
      const len = r.u16('text_length', { unit: 'bytes', desc: 'Length of the UTF-8 text that follows; 0 means no subtitle is shown during this sample.' });
      const text = len ? r.str('text', Math.min(len, r.remaining), { key: true, desc: 'The subtitle text. Style and position modifier boxes may follow it.' }) : '';
      if (r.remaining > 0) r.rest('modifier boxes', { desc: 'Text sample modifiers (styl, hlit, krok, tbox...) that change style or position.' });
      units.push({ title: 'text sample', offset: base + start, size: end - start, summary: len ? `"${text.slice(0, 80)}"` : '(empty: clears the subtitle)', fields });
    } else if (family === 'tmcd') {
      const fields = [];
      const r = new FieldReader(u8, base, { start, end, out: fields });
      const n = r.u32('frame_number', { key: true, desc: 'The timecode of the first frame, counted in frames. The timecode sample entry says how many frames make a second and whether drop-frame counting is used.' });
      const fps = cfg.tmcd?.frames || 25;
      const tc = timecode(n, fps, cfg.tmcd?.dropFrame);
      fields[0].display = `${n.toLocaleString('en-US')} → ${tc}`;
      units.push({ title: 'timecode sample', offset: base + start, size: end - start, summary: `starts at ${tc}`, fields });
    } else if (family === 'ac3') {
      const fields = [];
      const h = parseAc3Header(u8, start, end, base, fields);
      units.push({ title: 'AC-3 frame', offset: base + start, size: end - start, summary: h.summary, fields });
    } else if (family === 'opus') {
      const fields = [];
      const r = new FieldReader(u8, base, { start, end, out: fields });
      const cfgv = r.bits(5, 'config', { display: (v) => { const [m, bw, ms] = OPUS_MODES(v); return `${v} → ${m}, ${bw}, ${ms} ms frames`; } });
      r.flag('s', { enum: { 0: 'mono', 1: 'stereo' } });
      const c = r.bits(2, 'c', { enum: { 0: '1 frame', 1: '2 equal frames', 2: '2 frames of different size', 3: 'any number of frames' } });
      const [m, bw, ms] = OPUS_MODES(cfgv);
      units.push({ title: 'Opus packet', offset: base + start, size: end - start, summary: `${m} ${bw}, ${ms} ms × ${[1, 2, 2, 'n'][c]}`, fields });
    }
  } catch (e) {
    if (!(e instanceof ParseError)) throw e;
    return { units, error: e.message };
  }
  return { units };
}
