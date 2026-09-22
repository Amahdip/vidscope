// VP8/VP9: codec configuration (vpcC) and frame headers.
// References: VP Codec ISO Media File Format Binding § 2.2; VP9 Bitstream spec § 6.2.

import { FieldReader, ParseError } from '../core/fields.js';
import { COLOUR_PRIMARIES, TRANSFER_CHARACTERISTICS, MATRIX_COEFFICIENTS } from './color.js';

const CHROMA = { 0: '4:2:0 vertical', 1: '4:2:0 colocated', 2: '4:2:2', 3: '4:4:4' };
const COLOR_SPACES = { 0: 'unknown', 1: 'BT.601', 2: 'BT.709', 3: 'SMPTE-170', 4: 'SMPTE-240', 5: 'BT.2020', 6: 'reserved', 7: 'sRGB' };

export function parseVpcC(r, fourcc = 'vp09') {
  const c = {};
  c.profile = r.u8('profile', { key: true, desc: 'VP9 profile: 0 = 8-bit 4:2:0, 1 = 8-bit 4:2:2/4:4:4, 2 = 10/12-bit 4:2:0, 3 = 10/12-bit 4:2:2/4:4:4.' });
  c.level = r.u8('level', { display: (v) => `${v} → level ${(v / 10).toFixed(1)}` });
  c.bitDepth = r.bits(4, 'bitDepth', { key: true, unit: 'bits' });
  c.chroma = r.bits(3, 'chromaSubsampling', { enum: CHROMA });
  c.fullRange = r.flag('videoFullRangeFlag');
  c.primaries = r.u8('colourPrimaries', { enum: COLOUR_PRIMARIES });
  c.transfer = r.u8('transferCharacteristics', { enum: TRANSFER_CHARACTERISTICS });
  c.matrix = r.u8('matrixCoefficients', { enum: MATRIX_COEFFICIENTS });
  const n = r.u16('codecIntializationDataSize', { desc: 'Must be 0 for VP8 and VP9.' });
  if (n) r.bytes('codecIntializationData', n);
  c.codec = `${fourcc}.${String(c.profile).padStart(2, '0')}.${String(c.level).padStart(2, '0')}.${String(c.bitDepth).padStart(2, '0')}`;
  return c;
}

/** Split a VP9 sample into frames using the superframe index, if there is one. */
export function vp9Frames(u8, start, end) {
  const last = u8[end - 1];
  if ((last & 0xe0) === 0xc0) {
    const frames = (last & 7) + 1;
    const bytes = ((last >> 3) & 3) + 1;
    const indexSize = 2 + bytes * frames;
    if (end - start >= indexSize && u8[end - indexSize] === last) {
      const out = [];
      let p = start;
      let q = end - indexSize + 1;
      for (let i = 0; i < frames; i++) {
        let size = 0;
        for (let k = 0; k < bytes; k++) size += u8[q + k] * 256 ** k;
        q += bytes;
        out.push({ start: p, end: Math.min(p + size, end - indexSize) });
        p += size;
      }
      return { frames: out, index: { start: end - indexSize, end } };
    }
  }
  return { frames: [{ start, end }], index: null };
}

/** Parse the start of a VP9 uncompressed header. */
export function parseVp9Frame(u8, start, end, base, out) {
  const r = new FieldReader(u8, base, { start, end, out });
  const f = {};
  try {
    r.bits(2, 'frame_marker', { expect: 2 });
    const lo = r.flag('profile_low_bit');
    const hi = r.flag('profile_high_bit');
    f.profile = (hi << 1) + lo;
    if (f.profile === 3) r.flag('reserved_zero', { reserved: true });
    if (r.flag('show_existing_frame')) {
      r.bits(3, 'frame_to_show_map_idx');
      f.summary = 'show existing frame';
      return f;
    }
    f.key = r.bits(1, 'frame_type', { key: true, enum: { 0: 'KEY_FRAME', 1: 'NON_KEY_FRAME' } }) === 0;
    f.show = r.flag('show_frame');
    r.flag('error_resilient_mode');
    if (f.key) {
      r.u8('frame_sync_code[0]', { expect: 0x49 });
      r.u8('frame_sync_code[1]', { expect: 0x83 });
      r.u8('frame_sync_code[2]', { expect: 0x42 });
      if (f.profile >= 2) r.flag('ten_or_twelve_bit');
      const cs = r.bits(3, 'color_space', { enum: COLOR_SPACES });
      if (cs !== 7) {
        r.flag('color_range');
        if (f.profile === 1 || f.profile === 3) {
          r.flag('subsampling_x');
          r.flag('subsampling_y');
          r.flag('reserved_zero', { reserved: true });
        }
      } else if (f.profile === 1 || f.profile === 3) {
        r.flag('reserved_zero', { reserved: true });
      }
      f.width = r.bits(16, 'frame_width_minus_1', { key: true, display: (v) => `${v} → ${v + 1}` }) + 1;
      f.height = r.bits(16, 'frame_height_minus_1', { key: true, display: (v) => `${v} → ${v + 1}` }) + 1;
    }
    f.summary = `${f.key ? `key frame ${f.width}×${f.height}` : 'inter frame'}${f.show ? '' : ' (hidden)'}`;
  } catch (e) {
    if (!(e instanceof ParseError)) throw e;
    f.error = e.message;
  } finally {
    const hdrEnd = r.bit ? r.pos + 1 : r.pos;
    if (hdrEnd < end) {
      out.push({ name: 'compressed data', type: 'bytes', offset: base + hdrEnd, size: end - hdrEnd, value: null, display: `${end - hdrEnd} bytes`, role: 'payload', desc: 'The rest of the uncompressed header and the compressed frame.' });
    }
  }
  return f;
}

/** VP8 frame tag (RFC 6386 § 9.1). */
export function parseVp8Frame(u8, start, end, base, out) {
  const r = new FieldReader(u8, base, { start, end, out, le: true });
  const f = {};
  try {
    const tag = r.u24('frame_tag', { desc: 'Bit 0: 0 = key frame; bits 1-3: version; bit 4: show_frame; bits 5-23: size of the first partition.' });
    f.key = (tag & 1) === 0;
    f.show = (tag >> 4) & 1;
    if (f.key) {
      r.bytes('start_code', 3, { desc: 'Always 9D 01 2A on key frames.' });
      const w = r.u16('horizontal_size_code');
      const h = r.u16('vertical_size_code');
      f.width = w & 0x3fff;
      f.height = h & 0x3fff;
    }
    f.summary = f.key ? `key frame ${f.width}×${f.height}` : 'inter frame';
  } catch (e) {
    if (!(e instanceof ParseError)) throw e;
    f.error = e.message;
  }
  if (r.pos < end) out.push({ name: 'compressed data', type: 'bytes', offset: base + r.pos, size: end - r.pos, value: null, display: `${end - r.pos} bytes`, role: 'payload' });
  return f;
}
