// Audio codec configurations used by ISO-BMFF and Matroska, plus frame headers
// for streams that carry them in-band (MP3, AC-3).

import { FieldReader, ParseError } from '../core/fields.js';
import { fmtInt, fmtNum } from '../core/util.js';

// ---------------------------------------------------------------- Opus

/** OpusSpecificBox payload ('dOps', Opus in ISOBMFF § 4.3.2). Big-endian. */
export function parseDOps(r) {
  const o = {};
  r.u8('Version', { expect: 0 });
  o.channels = r.u8('OutputChannelCount', { key: true });
  o.preSkip = r.u16('PreSkip', {
    display: (v) => `${fmtInt(v)} samples (${fmtNum((v / 48000) * 1000, 2)} ms at 48 kHz)`,
    desc: 'Samples to discard from the start of the decoded output (encoder delay).',
  });
  o.inputRate = r.u32('InputSampleRate', { unit: 'Hz', desc: 'Sample rate of the original input. Opus always decodes at 48 kHz.' });
  r.i16('OutputGain', { display: (v) => `${v} → ${fmtNum(v / 256, 2)} dB` });
  o.family = r.u8('ChannelMappingFamily', { enum: { 0: 'mono/stereo', 1: 'Vorbis channel order (up to 8)', 2: 'ambisonics', 255: 'discrete' } });
  if (o.family !== 0 && r.remaining >= 2) {
    r.u8('StreamCount');
    r.u8('CoupledCount');
    r.bytes('ChannelMapping', Math.min(o.channels, r.remaining));
  }
  return o;
}

/** OpusHead (Matroska CodecPrivate, Ogg), little-endian, RFC 7845 § 5.1. */
export function parseOpusHead(r) {
  const o = {};
  r.str('magic', 8, { expect: 'OpusHead' });
  r.u8('version');
  o.channels = r.u8('channel_count', { key: true });
  const le = r.le;
  r.le = true;
  o.preSkip = r.u16('pre_skip', { display: (v) => `${fmtInt(v)} samples (${fmtNum((v / 48000) * 1000, 2)} ms)` });
  o.inputRate = r.u32('input_sample_rate', { unit: 'Hz' });
  r.i16('output_gain', { display: (v) => `${v} → ${fmtNum(v / 256, 2)} dB` });
  r.le = le;
  o.family = r.u8('channel_mapping_family');
  if (o.family !== 0 && r.remaining >= 2) {
    r.u8('stream_count');
    r.u8('coupled_count');
    r.bytes('channel_mapping', Math.min(o.channels, r.remaining));
  }
  return o;
}

// ---------------------------------------------------------------- AC-3 / E-AC-3

export const AC3_FSCOD = { 0: '48 kHz', 1: '44.1 kHz', 2: '32 kHz', 3: 'reserved' };
const AC3_RATES = [48000, 44100, 32000];
export const AC3_ACMOD = {
  0: '1+1 (dual mono)', 1: '1/0 (C)', 2: '2/0 (L R)', 3: '3/0 (L C R)', 4: '2/1 (L R S)',
  5: '3/1 (L C R S)', 6: '2/2 (L R SL SR)', 7: '3/2 (L C R SL SR)',
};
const AC3_CHANNELS = [2, 1, 2, 3, 3, 4, 4, 5];
const AC3_BITRATES = [32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384, 448, 512, 576, 640];
const BSMOD = {
  0: 'main audio (complete)', 1: 'main audio (music and effects)', 2: 'associated (visually impaired)',
  3: 'associated (hearing impaired)', 4: 'associated (dialogue)', 5: 'associated (commentary)',
  6: 'associated (emergency)', 7: 'associated (voice over) / karaoke',
};

/** AC3SpecificBox ('dac3'), ETSI TS 102 366 Annex F.4. */
export function parseDac3(r) {
  const c = {};
  const fscod = r.bits(2, 'fscod', { key: true, enum: AC3_FSCOD });
  c.sampleRate = AC3_RATES[fscod];
  r.bits(5, 'bsid', { desc: 'Bitstream identification: 8 for AC-3.' });
  r.bits(3, 'bsmod', { enum: BSMOD });
  const acmod = r.bits(3, 'acmod', { key: true, enum: AC3_ACMOD, desc: 'Audio coding mode: the main channel layout.' });
  const lfe = r.flag('lfeon', { desc: 'Low-frequency effects (subwoofer) channel present.' });
  c.channels = AC3_CHANNELS[acmod] + lfe;
  c.layout = `${AC3_ACMOD[acmod]}${lfe ? ' + LFE' : ''}`;
  const brc = r.bits(5, 'bit_rate_code', { display: (v) => `${v} → ${AC3_BITRATES[v] ?? '?'} kb/s` });
  c.bitrate = (AC3_BITRATES[brc] ?? 0) * 1000;
  r.bits(5, 'reserved', { reserved: true });
  return c;
}

/** EC3SpecificBox ('dec3'), ETSI TS 102 366 Annex F.6. */
export function parseDec3(r) {
  const c = { substreams: [] };
  c.bitrate = r.bits(13, 'data_rate', { unit: 'kb/s' }) * 1000;
  const n = r.bits(3, 'num_ind_sub', { display: (v) => `${v} → ${v + 1} independent substream${v ? 's' : ''}` }) + 1;
  for (let i = 0; i < n; i++) {
    r.group(`independent_substream[${i}]`, (g) => {
      const fscod = r.bits(2, 'fscod', { enum: AC3_FSCOD });
      r.bits(5, 'bsid', { desc: '16 for E-AC-3.' });
      r.bits(1, 'reserved', { reserved: true });
      r.flag('asvc');
      r.bits(3, 'bsmod', { enum: BSMOD });
      const acmod = r.bits(3, 'acmod', { enum: AC3_ACMOD });
      const lfe = r.flag('lfeon');
      r.bits(3, 'reserved', { reserved: true });
      const dep = r.bits(4, 'num_dep_sub');
      if (dep > 0) r.bits(9, 'chan_loc');
      else r.bits(1, 'reserved', { reserved: true });
      const sub = { sampleRate: AC3_RATES[fscod], channels: AC3_CHANNELS[acmod] + lfe, layout: `${AC3_ACMOD[acmod]}${lfe ? ' + LFE' : ''}`, dependent: dep };
      c.substreams.push(sub);
      g.display = sub.layout;
    });
  }
  if (r.bitsLeft >= 16) {
    r.bits(7, 'reserved', { reserved: true });
    if (r.flag('flag_ec3_extension_type_a', { desc: 'Set for Dolby Atmos (joint object coding).' })) {
      c.atmos = true;
      r.u8('complexity_index_type_a', { desc: 'Number of objects the Atmos decoder must render.' });
    }
  }
  const s0 = c.substreams[0];
  if (s0) {
    c.sampleRate = s0.sampleRate;
    c.channels = s0.channels;
    c.layout = s0.layout;
  }
  return c;
}

// ---------------------------------------------------------------- FLAC

const FLAC_BLOCKS = { 0: 'STREAMINFO', 1: 'PADDING', 2: 'APPLICATION', 3: 'SEEKTABLE', 4: 'VORBIS_COMMENT', 5: 'CUESHEET', 6: 'PICTURE' };

/** FLAC metadata blocks (dfLa box body after version/flags, or Matroska CodecPrivate after 'fLaC'). */
export function parseFlacMetadata(r) {
  const info = {};
  let last = 0;
  let i = 0;
  while (!last && r.remaining >= 4 && i < 64) {
    r.group(`metadata_block[${i++}]`, (g) => {
      last = r.flag('last_metadata_block_flag');
      const type = r.bits(7, 'block_type', { enum: FLAC_BLOCKS });
      const len = r.u24('length', { unit: 'bytes' });
      g.display = FLAC_BLOCKS[type] ?? `type ${type}`;
      r.bounded(len, () => {
        if (type === 0 && len >= 34) {
          r.u16('min_block_size', { unit: 'samples' });
          r.u16('max_block_size', { unit: 'samples' });
          r.u24('min_frame_size', { unit: 'bytes' });
          r.u24('max_frame_size', { unit: 'bytes' });
          info.sampleRate = r.bits(20, 'sample_rate', { key: true, unit: 'Hz' });
          info.channels = r.bits(3, 'channels_minus1', { key: true, display: (v) => `${v} → ${v + 1} channels` }) + 1;
          info.bitsPerSample = r.bits(5, 'bits_per_sample_minus1', { display: (v) => `${v} → ${v + 1} bits` }) + 1;
          info.totalSamples = r.bits(36, 'total_samples', { display: (v) => (v ? `${fmtInt(v)} samples` : 'unknown') });
          r.bytes('md5', 16, { desc: 'MD5 of the unencoded audio, for verifying a decode.' });
        } else if (len) {
          r.rest('data');
        }
      });
    });
  }
  return info;
}

// ---------------------------------------------------------------- ALAC

export function parseAlacConfig(r) {
  const c = {};
  r.u32('frameLength', { unit: 'samples' });
  r.u8('compatibleVersion');
  c.bitDepth = r.u8('bitDepth', { key: true, unit: 'bits' });
  r.u8('pb');
  r.u8('mb');
  r.u8('kb');
  c.channels = r.u8('numChannels', { key: true });
  r.u16('maxRun');
  r.u32('maxFrameBytes', { unit: 'bytes' });
  c.bitrate = r.u32('avgBitRate', { unit: 'b/s' });
  c.sampleRate = r.u32('sampleRate', { key: true, unit: 'Hz' });
  return c;
}

// ---------------------------------------------------------------- MPEG audio (MP3)

const MPA_BITRATES = {
  // [version][layer] tables in kb/s, index 1..14
  1: {
    1: [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
    2: [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
    3: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  },
  2: {
    1: [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
    2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
    3: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  },
};
const MPA_RATES = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

/** MPEG-1/2/2.5 audio frame header (4 bytes). */
export function parseMpegAudioHeader(u8, start, end, base, out) {
  const r = new FieldReader(u8, base, { start, end, out });
  const h = {};
  try {
    r.bits(11, 'frame_sync', { display: (v) => `0x${v.toString(16).toUpperCase()} (all ones)`, expect: 0x7ff });
    const ver = r.bits(2, 'version', { enum: { 0: 'MPEG-2.5', 1: 'reserved', 2: 'MPEG-2', 3: 'MPEG-1' } });
    const layerBits = r.bits(2, 'layer', { enum: { 0: 'reserved', 1: 'Layer III', 2: 'Layer II', 3: 'Layer I' } });
    h.layer = 4 - layerBits;
    r.flag('protection_bit', { desc: '0 = a 16-bit CRC follows the header.' });
    const table = MPA_BITRATES[ver === 3 ? 1 : 2]?.[h.layer];
    const bri = r.bits(4, 'bitrate_index', { display: (v) => `${v} → ${table?.[v] ?? '?'} kb/s` });
    h.bitrate = (table?.[bri] ?? 0) * 1000;
    const sri = r.bits(2, 'sampling_rate_index', { display: (v) => `${v} → ${fmtInt(MPA_RATES[ver]?.[v] ?? 0)} Hz` });
    h.sampleRate = MPA_RATES[ver]?.[sri] ?? 0;
    const pad = r.flag('padding_bit');
    r.flag('private_bit');
    h.mode = r.bits(2, 'channel_mode', { enum: { 0: 'stereo', 1: 'joint stereo', 2: 'dual channel', 3: 'mono' } });
    r.bits(2, 'mode_extension');
    r.flag('copyright');
    r.flag('original');
    r.bits(2, 'emphasis');
    if (h.bitrate && h.sampleRate) {
      h.frameLength = h.layer === 1
        ? (Math.floor((12 * h.bitrate) / h.sampleRate) + pad) * 4
        : Math.floor(((h.layer === 3 && ver !== 3 ? 72 : 144) * h.bitrate) / h.sampleRate) + pad;
    }
    h.summary = `${['', 'Layer I', 'Layer II', 'MP3'][h.layer]} ${h.bitrate / 1000} kb/s ${fmtInt(h.sampleRate)} Hz`;
  } catch (e) {
    if (!(e instanceof ParseError)) throw e;
    h.error = e.message;
  }
  return h;
}

/** E-AC-3 syncframe header (ETSI TS 102 366 Annex E, bsi()). */
export function parseEac3Header(u8, start, end, base, out) {
  const r = new FieldReader(u8, base, { start, end, out });
  const h = {};
  try {
    r.u16('syncword', { display: (v) => `0x${v.toString(16).toUpperCase()}`, expect: 0x0b77 });
    const strm = r.bits(2, 'strmtyp', { enum: { 0: 'independent substream', 1: 'dependent substream', 2: 'independent (AC-3 converted)', 3: 'reserved' } });
    r.bits(3, 'substreamid');
    const frmsiz = r.bits(11, 'frmsiz', { display: (v) => `${v} → ${(v + 1) * 2} bytes per frame` });
    const fscod = r.bits(2, 'fscod', { enum: AC3_FSCOD });
    let blocks = 6;
    if (fscod === 3) r.bits(2, 'fscod2');
    else blocks = [1, 2, 3, 6][r.bits(2, 'numblkscod', { display: (v) => `${v} → ${[1, 2, 3, 6][v]} audio blocks (${[1, 2, 3, 6][v] * 256} samples)` })];
    const acmod = r.bits(3, 'acmod', { enum: AC3_ACMOD });
    const lfe = r.flag('lfeon');
    h.bsid = r.bits(5, 'bsid', { desc: '16 for E-AC-3.' });
    r.bits(5, 'dialnorm', { display: (v) => `${v} → -${v || 31} dBFS dialogue level` });
    h.sampleRate = AC3_RATES[fscod] ?? 0;
    h.summary = `E-AC-3 ${['independent', 'dependent', 'independent', '?'][strm]}, ${AC3_ACMOD[acmod]}${lfe ? ' + LFE' : ''}, ${blocks * 256} samples, ${(frmsiz + 1) * 2} bytes`;
  } catch (e) {
    if (!(e instanceof ParseError)) throw e;
    h.error = e.message;
  }
  return h;
}

/** AC-3 syncinfo + start of BSI (ETSI TS 102 366 § 5.3). */
export function parseAc3Header(u8, start, end, base, out) {
  const r = new FieldReader(u8, base, { start, end, out });
  const h = {};
  try {
    r.u16('syncword', { display: (v) => `0x${v.toString(16).toUpperCase()}`, expect: 0x0b77 });
    r.u16('crc1');
    const fscod = r.bits(2, 'fscod', { enum: AC3_FSCOD });
    r.bits(6, 'frmsizecod');
    h.bsid = r.bits(5, 'bsid', { desc: '8 = AC-3; 16 = E-AC-3 (the layout of the header differs).' });
    r.bits(3, 'bsmod', { enum: BSMOD });
    const acmod = r.bits(3, 'acmod', { enum: AC3_ACMOD });
    h.sampleRate = AC3_RATES[fscod];
    h.summary = `AC-3 ${AC3_ACMOD[acmod]} ${fmtInt(h.sampleRate)} Hz`;
  } catch (e) {
    if (!(e instanceof ParseError)) throw e;
    h.error = e.message;
  }
  return h;
}
