// Matroska codec IDs (V_…, A_…, S_…) and their CodecPrivate formats.
// Codec mappings: draft-ietf-cellar-codec (Matroska codec specifications).

import { FieldReader, ParseError } from '../../core/fields.js';
import { fmtInt, fmtNum, quote, decodeText, HEX2 } from '../../core/util.js';
import { parseAvcC, profileName as avcProfileName, levelName as avcLevelName } from '../../codecs/h264.js';
import { parseHvcC, PROFILES as HEVC_PROFILES, levelName as hevcLevelName } from '../../codecs/h265.js';
import { parseAv1C, levelName as av1LevelName } from '../../codecs/av1.js';
import { parseAudioSpecificConfig, aacName, CHANNEL_CONFIG } from '../../codecs/mpeg4audio.js';
import { parseOpusHead, parseFlacMetadata, parseAlacConfig } from '../../codecs/audio.js';

// family: which parseSample() parser splits the frames; cp: CodecPrivate format; webm: allowed in WebM.
const C = (name, kind, o = {}) => ({ name, kind, ...o });

export const CODECS = {
  'V_MPEG4/ISO/AVC': C('H.264 / AVC', 'video', { family: 'avc', cp: 'avcC' }),
  'V_MPEGH/ISO/HEVC': C('H.265 / HEVC', 'video', { family: 'hevc', cp: 'hvcC' }),
  'V_MPEGI/ISO/VVC': C('H.266 / VVC', 'video', { cp: 'opaque' }),
  V_AV1: C('AV1', 'video', { family: 'av1', cp: 'av1C', webm: true }),
  V_VP8: C('VP8', 'video', { family: 'vp8', webm: true }),
  V_VP9: C('VP9', 'video', { family: 'vp9', cp: 'vp9', webm: true }),
  V_MPEG1: C('MPEG-1 Video', 'video'),
  V_MPEG2: C('MPEG-2 Video', 'video'),
  'V_MPEG4/ISO/SP': C('MPEG-4 Part 2 Simple Profile (DivX 4)', 'video'),
  'V_MPEG4/ISO/ASP': C('MPEG-4 Part 2 Advanced Simple Profile (DivX 5, Xvid)', 'video'),
  'V_MPEG4/ISO/AP': C('MPEG-4 Part 2 Advanced Profile', 'video'),
  'V_MPEG4/MS/V3': C('Microsoft MPEG-4 v3 (DivX 3)', 'video'),
  'V_MS/VFW/FOURCC': C('Video for Windows codec (AVI compatibility)', 'video', { cp: 'bih' }),
  V_QUICKTIME: C('QuickTime video', 'video'),
  V_PRORES: C('Apple ProRes', 'video', { cp: 'prores' }),
  V_THEORA: C('Theora', 'video', { cp: 'xiph' }),
  'V_REAL/RV10': C('RealVideo 1.0', 'video'),
  'V_REAL/RV20': C('RealVideo G2', 'video'),
  'V_REAL/RV30': C('RealVideo 8', 'video'),
  'V_REAL/RV40': C('RealVideo 9/10', 'video'),
  V_UNCOMPRESSED: C('Uncompressed video', 'video'),
  V_FFV1: C('FFV1 (lossless)', 'video'),
  V_MJPEG: C('Motion JPEG', 'video'),
  V_JPEG2000: C('JPEG 2000', 'video'),
  V_DIRAC: C('Dirac', 'video'),
  V_AVS2: C('AVS2', 'video'),
  V_AVS3: C('AVS3', 'video'),
  V_CAVS: C('AVS1 (CAVS)', 'video'),
  A_AAC: C('AAC', 'audio', { family: 'aac', cp: 'asc' }),
  'A_AAC/MPEG2/LC': C('AAC LC (MPEG-2)', 'audio', { family: 'aac' }),
  'A_AAC/MPEG2/LC/SBR': C('HE-AAC (MPEG-2)', 'audio', { family: 'aac' }),
  'A_AAC/MPEG2/MAIN': C('AAC Main (MPEG-2)', 'audio', { family: 'aac' }),
  'A_AAC/MPEG2/SSR': C('AAC SSR (MPEG-2)', 'audio', { family: 'aac' }),
  'A_AAC/MPEG4/LC': C('AAC LC', 'audio', { family: 'aac' }),
  'A_AAC/MPEG4/LC/SBR': C('HE-AAC', 'audio', { family: 'aac' }),
  'A_AAC/MPEG4/LTP': C('AAC LTP', 'audio', { family: 'aac' }),
  'A_AAC/MPEG4/MAIN': C('AAC Main', 'audio', { family: 'aac' }),
  'A_AAC/MPEG4/SSR': C('AAC SSR', 'audio', { family: 'aac' }),
  A_AC3: C('AC-3 (Dolby Digital)', 'audio', { family: 'ac3' }),
  'A_AC3/BSID9': C('AC-3 (Dolby Digital, bsid 9)', 'audio'),
  'A_AC3/BSID10': C('AC-3 (Dolby Digital, bsid 10)', 'audio'),
  A_EAC3: C('E-AC-3 (Dolby Digital Plus)', 'audio'),
  A_TRUEHD: C('Dolby TrueHD', 'audio'),
  A_MLP: C('Meridian Lossless Packing', 'audio'),
  A_DTS: C('DTS', 'audio'),
  'A_DTS/EXPRESS': C('DTS Express', 'audio'),
  'A_DTS/LOSSLESS': C('DTS-HD Master Audio', 'audio'),
  A_FLAC: C('FLAC', 'audio', { cp: 'flac' }),
  A_ALAC: C('Apple Lossless (ALAC)', 'audio', { cp: 'alac' }),
  A_OPUS: C('Opus', 'audio', { family: 'opus', cp: 'opus', webm: true }),
  A_VORBIS: C('Vorbis', 'audio', { cp: 'xiph', webm: true }),
  'A_MPEG/L1': C('MPEG Audio Layer I', 'audio', { family: 'mp3' }),
  'A_MPEG/L2': C('MPEG Audio Layer II (MP2)', 'audio', { family: 'mp3' }),
  'A_MPEG/L3': C('MP3', 'audio', { family: 'mp3' }),
  'A_PCM/INT/LIT': C('PCM (little-endian integer)', 'audio'),
  'A_PCM/INT/BIG': C('PCM (big-endian integer)', 'audio'),
  'A_PCM/FLOAT/IEEE': C('PCM (IEEE float)', 'audio'),
  'A_MS/ACM': C('ACM audio codec (AVI compatibility)', 'audio', { cp: 'wfx' }),
  A_TTA1: C('True Audio (TTA)', 'audio'),
  A_WAVPACK4: C('WavPack 4', 'audio'),
  'A_ATRAC/AT1': C('Sony ATRAC1', 'audio'),
  'A_REAL/14_4': C('RealAudio 1 (14.4)', 'audio'),
  'A_REAL/28_8': C('RealAudio 2 (28.8)', 'audio'),
  'A_REAL/COOK': C('RealAudio Cook', 'audio'),
  'A_REAL/SIPR': C('RealAudio Sipro', 'audio'),
  'A_REAL/RALF': C('RealAudio Lossless', 'audio'),
  'A_REAL/ATRC': C('RealAudio ATRAC3', 'audio'),
  A_QUICKTIME: C('QuickTime audio', 'audio'),
  'A_QUICKTIME/QDMC': C('QDesign Music', 'audio'),
  'A_QUICKTIME/QDM2': C('QDesign Music 2', 'audio'),
  'S_TEXT/UTF8': C('SRT / plain UTF-8 text subtitles', 'subtitle', { family: 'text' }),
  'S_TEXT/ASCII': C('Plain ASCII text subtitles', 'subtitle', { family: 'text' }),
  'S_TEXT/SSA': C('SubStation Alpha subtitles', 'subtitle', { family: 'text', cp: 'text', ass: true }),
  'S_TEXT/ASS': C('Advanced SubStation Alpha subtitles', 'subtitle', { family: 'text', cp: 'text', ass: true }),
  'S_TEXT/WEBVTT': C('WebVTT subtitles', 'subtitle', { family: 'text', cp: 'text' }),
  'S_TEXT/USF': C('Universal Subtitle Format', 'subtitle', { family: 'text', cp: 'text' }),
  S_VOBSUB: C('VobSub (DVD bitmap subtitles)', 'subtitle', { cp: 'text' }),
  'S_HDMV/PGS': C('PGS (Blu-ray bitmap subtitles)', 'subtitle'),
  'S_HDMV/TEXTST': C('HDMV text subtitles', 'subtitle'),
  S_DVBSUB: C('DVB subtitles', 'subtitle'),
  S_ARIBSUB: C('ARIB STD-B24 subtitles', 'subtitle'),
  S_KATE: C('Kate (karaoke and text)', 'subtitle', { cp: 'xiph' }),
  'S_IMAGE/BMP': C('Bitmap subtitles', 'subtitle'),
  'D_WEBVTT/SUBTITLES': C('WebVTT subtitles (WebM)', 'subtitle', { family: 'text', webm: true }),
  'D_WEBVTT/CAPTIONS': C('WebVTT captions (WebM)', 'subtitle', { family: 'text', webm: true }),
  'D_WEBVTT/DESCRIPTIONS': C('WebVTT descriptions (WebM)', 'subtitle', { family: 'text', webm: true }),
  'D_WEBVTT/METADATA': C('WebVTT metadata (WebM)', 'data', { family: 'text', webm: true }),
  B_VOBBTN: C('DVD menu buttons', 'data'),
};

export function codecInfo(id) {
  if (!id) return null;
  const hit = CODECS[id];
  if (hit) return hit;
  // Unknown sub-variants: fall back to the longest known prefix (A_AAC/..., V_REAL/...).
  let best = null;
  for (const k of Object.keys(CODECS)) if (id.startsWith(`${k}/`) && (!best || k.length > best.length)) best = k;
  if (best) return { ...CODECS[best], name: `${CODECS[best].name} (${id})` };
  if (id.startsWith('V_')) return { name: `unknown video codec ${id}`, kind: 'video', unknown: true };
  if (id.startsWith('A_')) return { name: `unknown audio codec ${id}`, kind: 'audio', unknown: true };
  if (id.startsWith('S_')) return { name: `unknown subtitle codec ${id}`, kind: 'subtitle', unknown: true };
  return null;
}

/** Codecs WebM allows (WebM container guidelines + AV1-in-WebM). */
export function isWebmCodec(id) {
  return !!CODECS[id]?.webm;
}

// Codecs that cannot be decoded without CodecPrivate.
export const NEEDS_PRIVATE = new Set(['V_MPEG4/ISO/AVC', 'V_MPEGH/ISO/HEVC', 'V_AV1', 'A_AAC', 'A_OPUS', 'A_VORBIS', 'A_FLAC', 'A_ALAC', 'V_MS/VFW/FOURCC', 'A_MS/ACM', 'V_THEORA']);

// ------------------------------------------------------------------ CodecPrivate parsers

const VP9_FEATURES = { 1: 'profile', 2: 'level', 3: 'bit depth', 4: 'chroma subsampling' };
const VP9_CHROMA = { 0: '4:2:0 (vertical siting)', 1: '4:2:0 (co-located with luma)', 2: '4:2:2', 3: '4:4:4' };
const WAVE_TAGS = {
  0x0001: 'PCM', 0x0002: 'Microsoft ADPCM', 0x0003: 'IEEE float', 0x0006: 'A-law', 0x0007: 'µ-law', 0x0011: 'IMA ADPCM',
  0x0050: 'MPEG-1 Layer I/II', 0x0055: 'MP3', 0x0092: 'AC-3 (SPDIF)', 0x00ff: 'AAC', 0x0160: 'WMA v1', 0x0161: 'WMA v2',
  0x0162: 'WMA Pro', 0x0163: 'WMA Lossless', 0x1610: 'AAC (ADTS)', 0x2000: 'AC-3', 0x2001: 'DTS', 0xf1ac: 'FLAC', 0xfffe: 'WAVE_FORMAT_EXTENSIBLE',
};
const PRORES = {
  ap4x: 'ProRes 4444 XQ', ap4h: 'ProRes 4444', apch: 'ProRes 422 HQ', apcn: 'ProRes 422', apcs: 'ProRes 422 LT',
  apco: 'ProRes 422 Proxy', aprh: 'ProRes RAW HQ', aprn: 'ProRes RAW',
};

function xiphSize(r, name) {
  const start = r.pos;
  let s = 0;
  const parts = [];
  for (;;) {
    r.need(1, name);
    const b = r.u[r.pos++];
    s += b;
    parts.push(b);
    if (b !== 255) break;
  }
  r.record(name, 'Xiph lacing', start, r.pos - start, s, {
    display: `${fmtInt(s)} bytes${parts.length > 1 ? ` (${parts.join(' + ')})` : ''}`,
    desc: 'Xiph-style size: bytes are added up while they are 255; the first byte below 255 ends the number.',
  });
  return s;
}

function vorbisIdentification(r, info) {
  r.u8('packet_type', { expect: 1, display: (v) => `${v} (identification header)` });
  r.str('signature', 6, { expect: 'vorbis' });
  const le = r.le;
  r.le = true;
  r.u32('vorbis_version', { expect: 0 });
  info.channels = r.u8('audio_channels', { key: true });
  info.sampleRate = r.u32('audio_sample_rate', { key: true, unit: 'Hz' });
  r.i32('bitrate_maximum', { display: (v) => (v > 0 ? `${fmtInt(v)} b/s` : `${v} (not set)`) });
  info.bitrate = r.i32('bitrate_nominal', { display: (v) => (v > 0 ? `${fmtInt(v)} b/s` : `${v} (not set)`) });
  r.i32('bitrate_minimum', { display: (v) => (v > 0 ? `${fmtInt(v)} b/s` : `${v} (not set)`) });
  r.le = le;
  r.u8('blocksizes', { display: (v) => `${v}: short blocks ${2 ** (v & 15)}, long blocks ${2 ** (v >> 4)} samples`, desc: 'Two 4-bit exponents: blocksize_0 in the low nibble, blocksize_1 in the high nibble.' });
  r.u8('framing_flag', { expect: 1 });
}

function vorbisComment(r, info) {
  r.u8('packet_type', { expect: 3, display: (v) => `${v} (comment header)` });
  r.str('signature', 6, { expect: 'vorbis' });
  const le = r.le;
  r.le = true;
  const n = r.u32('vendor_length', { unit: 'bytes' });
  info.vendor = r.str('vendor_string', n, { key: true });
  const count = r.u32('user_comment_list_length');
  for (let i = 0; i < count && i < 64 && r.remaining >= 4; i++) {
    r.group(`comment[${i}]`, (g) => {
      const len = r.u32('length', { unit: 'bytes' });
      g.display = quote(r.str('comment', len));
    });
  }
  r.le = le;
  if (r.remaining > 0) r.rest('rest of comment header');
}

function theoraIdentification(r, info) {
  r.u8('header_type', { display: (v) => `0x${HEX2[v]} (identification header)` });
  r.str('signature', 6, { expect: 'theora' });
  r.u8('VMAJ');
  r.u8('VMIN');
  r.u8('VREV');
  r.u16('FMBW', { display: (v) => `${v} macroblocks → ${v * 16} px` });
  r.u16('FMBH', { display: (v) => `${v} macroblocks → ${v * 16} px` });
  info.width = r.u24('PICW', { key: true, unit: 'px' });
  info.height = r.u24('PICH', { key: true, unit: 'px' });
  r.u8('PICX');
  r.u8('PICY');
  const n = r.u32('FRN');
  const d = r.u32('FRD', { display: (v) => `${v} → ${v ? fmtNum(n / v, 3) : '?'} fps` });
  info.fps = d ? n / d : null;
  if (r.remaining > 0) r.rest('rest of identification header');
}

function xiphHeaders(r, codecId, info) {
  const count = r.u8('packet_count_minus1', { display: (v) => `${v} → ${v + 1} header packets`, desc: 'Number of header packets minus one (2 for Vorbis and Theora: identification, comment, setup).' }) + 1;
  const sizes = [];
  for (let i = 0; i < count - 1; i++) sizes.push(xiphSize(r, `header_size[${i}]`));
  const names = ['identification header', 'comment header', 'setup header'];
  for (let i = 0; i < count && r.remaining > 0; i++) {
    const size = i < count - 1 ? sizes[i] : r.remaining;
    r.bounded(size, () => {
      r.group(names[i] ?? `header[${i}]`, (g) => {
        try {
          if (codecId === 'A_VORBIS' && i === 0) vorbisIdentification(r, info);
          else if (codecId === 'A_VORBIS' && i === 1) vorbisComment(r, info);
          else if (codecId === 'V_THEORA' && i === 0) theoraIdentification(r, info);
          if (r.remaining > 0) r.rest(i === 2 ? 'codebooks and modes' : 'data', { desc: i === 2 ? 'The setup header: codebooks and decoder configuration. It is large and opaque; decoders need it before the first audio packet.' : undefined });
        } catch (e) {
          if (!(e instanceof ParseError)) throw e;
          g.error = e.message;
        }
        if (codecId === 'A_VORBIS' && i === 0 && info.sampleRate) g.display = `${info.channels} ch, ${fmtInt(info.sampleRate)} Hz`;
        if (codecId === 'A_VORBIS' && i === 1 && info.vendor) g.display = quote(info.vendor);
        if (i === 2) g.display = `${fmtInt(size)} bytes`;
      });
    });
  }
}

function vp9Features(r, info) {
  let i = 0;
  while (r.remaining >= 2) {
    r.group(`feature[${i++}]`, (g) => {
      const id = r.u8('ID', { enum: VP9_FEATURES, desc: 'Feature ID (the top bit is reserved and must be 0).' });
      const len = r.u8('length', { unit: 'bytes' });
      if (len === 1) {
        const v = r.u8('value', {
          key: true,
          display: (x) => (id === 2 ? `${x} → level ${(x / 10).toFixed(1)}` : id === 4 ? `${x} → ${VP9_CHROMA[x] ?? '?'}` : id === 3 ? `${x} bits` : String(x)),
        });
        if (id === 1) info.profile = v;
        if (id === 2) info.level = v;
        if (id === 3) info.bitDepth = v;
        if (id === 4) info.chroma = v;
        g.display = `${VP9_FEATURES[id] ?? `feature ${id}`} = ${id === 2 ? (v / 10).toFixed(1) : id === 4 ? VP9_CHROMA[v] ?? v : v}`;
      } else {
        r.bytes('value', len);
      }
    });
  }
}

function bitmapInfoHeader(r, info) {
  r.le = true;
  r.u32('biSize', { unit: 'bytes', desc: 'Size of this structure (40 for a plain BITMAPINFOHEADER); codec-specific data may follow.' });
  info.width = r.i32('biWidth', { key: true, unit: 'px' });
  info.height = r.i32('biHeight', { key: true, unit: 'px' });
  r.u16('biPlanes', { expect: 1 });
  r.u16('biBitCount', { unit: 'bits per pixel' });
  info.fourcc = r.fourcc('biCompression', { key: true, desc: 'The FourCC of the Video for Windows codec (e.g. XVID, DIVX, H264, WMV3).' });
  r.u32('biSizeImage', { unit: 'bytes' });
  r.i32('biXPelsPerMeter');
  r.i32('biYPelsPerMeter');
  r.u32('biClrUsed');
  r.u32('biClrImportant');
  if (r.remaining > 0) r.rest('codec extra data', { desc: 'Codec-specific data that followed the header in the AVI stream format chunk.' });
  r.le = false;
}

function waveFormatEx(r, info) {
  r.le = true;
  info.formatTag = r.u16('wFormatTag', { key: true, display: (v) => `0x${v.toString(16).padStart(4, '0')} — ${WAVE_TAGS[v] ?? 'unknown format'}` });
  info.channels = r.u16('nChannels', { key: true });
  info.sampleRate = r.u32('nSamplesPerSec', { key: true, unit: 'Hz' });
  r.u32('nAvgBytesPerSec', { display: (v) => `${fmtInt(v)} (${fmtInt(v * 8)} b/s)` });
  r.u16('nBlockAlign', { unit: 'bytes' });
  r.u16('wBitsPerSample', { unit: 'bits' });
  if (r.remaining >= 2) {
    const cb = r.u16('cbSize', { unit: 'bytes', desc: 'Number of extra format bytes that follow.' });
    if (info.formatTag === 0xfffe && cb >= 22 && r.remaining >= 22) {
      r.u16('wValidBitsPerSample', { unit: 'bits' });
      r.u32('dwChannelMask', { display: (v) => `0x${v.toString(16).padStart(8, '0')}` });
      r.uuid('SubFormat');
    }
    if (r.remaining > 0) r.rest('extra format data');
  }
  r.le = false;
}

function describeAvc(a) {
  return `${avcProfileName(a.profile, a.compat)}@L${avcLevelName(a.level, a.compat, a.profile)}, ${a.sps.length} SPS, ${a.pps.length} PPS, ${a.lengthSize}-byte NAL lengths`;
}

function describeHevc(h) {
  return `${HEVC_PROFILES[h.profile_idc] ?? `profile ${h.profile_idc}`}@L${hevcLevelName(h.level_idc)}${h.tier ? ' High tier' : ''}, ${h.lengthSize}-byte NAL lengths`;
}

/**
 * Parse a CodecPrivate payload u8[start, end) (file offset of u8[0] = base) for `codecId`,
 * recording fields into `out`. Returns what the track needs: {avc|hevc|av1|asc|opus|flac|vp9|...,
 * summary, error?}.
 */
export function parseCodecPrivate(codecId, u8, base, start, end, out) {
  const info = {};
  const ci = codecInfo(codecId);
  const r = new FieldReader(u8, base, { start, end, out });
  try {
    switch (ci?.cp) {
      case 'avcC':
        r.group('AVCDecoderConfigurationRecord', (g) => {
          info.avc = parseAvcC(r, 'avc1');
          g.display = describeAvc(info.avc);
        }, { desc: 'The ISO/IEC 14496-15 avcC record, exactly as in an MP4 avcC box: profile, level, NAL length size, then the SPS and PPS the decoder needs before the first frame.' });
        info.summary = describeAvc(info.avc);
        break;
      case 'hvcC':
        r.group('HEVCDecoderConfigurationRecord', (g) => {
          info.hevc = parseHvcC(r, 'hvc1');
          g.display = describeHevc(info.hevc);
        }, { desc: 'The ISO/IEC 14496-15 hvcC record, exactly as in an MP4 hvcC box: profile, tier, level, NAL length size and arrays of VPS/SPS/PPS/SEI NAL units.' });
        info.summary = describeHevc(info.hevc);
        break;
      case 'av1C':
        r.group('AV1CodecConfigurationRecord', (g) => {
          info.av1 = parseAv1C(r);
          g.display = `profile ${info.av1.seq_profile}, level ${av1LevelName(info.av1.seq_level_idx_0)}`;
        }, { desc: 'The av1C record of the AV1 ISOBMFF binding: profile, level, bit depth and chroma format, usually followed by the sequence header OBU.' });
        info.summary = `AV1 profile ${info.av1.seq_profile}, level ${av1LevelName(info.av1.seq_level_idx_0)}`;
        break;
      case 'asc':
        r.group('AudioSpecificConfig', (g) => {
          try {
            info.asc = parseAudioSpecificConfig(r);
            g.display = `${aacName(info.asc)}, ${fmtInt(info.asc.extSampleRate || info.asc.sampleRate)} Hz, ${CHANNEL_CONFIG[info.asc.channelConfig] ?? info.asc.channelConfig}`;
          } finally {
            if (r.bit) r.align('padding');
          }
        }, { desc: 'The MPEG-4 AudioSpecificConfig: audio object type (2 = AAC LC), sampling frequency and channel configuration. It is the same structure as in an MP4 esds box, without the descriptor wrapping.' });
        if (info.asc) info.summary = `${aacName(info.asc)}, ${fmtInt(info.asc.extSampleRate || info.asc.sampleRate)} Hz`;
        break;
      case 'opus':
        r.group('OpusHead', (g) => {
          info.opus = parseOpusHead(r);
          g.display = `${info.opus.channels} ch, pre-skip ${info.opus.preSkip}`;
        }, { desc: 'The Opus identification header (RFC 7845 § 5.1), little-endian: channel count, pre-skip (encoder delay, also given by CodecDelay), original input rate, output gain and channel mapping.' });
        info.summary = `Opus, ${info.opus.channels} ch, pre-skip ${info.opus.preSkip} samples`;
        break;
      case 'flac':
        r.str('signature', 4, { expect: 'fLaC', desc: 'The FLAC stream marker "fLaC", followed by the metadata blocks (STREAMINFO first).' });
        r.group('metadata blocks', (g) => {
          info.flac = parseFlacMetadata(r);
          g.display = info.flac.sampleRate ? `${fmtInt(info.flac.sampleRate)} Hz, ${info.flac.channels} ch, ${info.flac.bitsPerSample}-bit` : '';
        });
        if (info.flac.sampleRate) info.summary = `FLAC ${fmtInt(info.flac.sampleRate)} Hz, ${info.flac.channels} ch, ${info.flac.bitsPerSample}-bit`;
        break;
      case 'alac':
        r.group('ALACSpecificConfig', (g) => {
          info.alac = parseAlacConfig(r);
          g.display = `${fmtInt(info.alac.sampleRate)} Hz, ${info.alac.channels} ch, ${info.alac.bitDepth}-bit`;
        }, { desc: 'ALAC\'s "magic cookie": frame length, bit depth, tuning parameters, channels and sample rate.' });
        break;
      case 'xiph':
        info.xiph = {};
        xiphHeaders(r, codecId, info.xiph);
        if (codecId === 'A_VORBIS' && info.xiph.sampleRate) info.summary = `Vorbis ${fmtInt(info.xiph.sampleRate)} Hz, ${info.xiph.channels} ch${info.xiph.vendor ? `, ${info.xiph.vendor}` : ''}`;
        break;
      case 'vp9':
        info.vp9 = {};
        vp9Features(r, info.vp9);
        if (info.vp9.profile !== undefined) info.summary = `VP9 profile ${info.vp9.profile}${info.vp9.level ? `, level ${(info.vp9.level / 10).toFixed(1)}` : ''}${info.vp9.bitDepth ? `, ${info.vp9.bitDepth}-bit` : ''}`;
        break;
      case 'bih':
        info.bih = {};
        bitmapInfoHeader(r, info.bih);
        info.summary = `BITMAPINFOHEADER '${info.bih.fourcc}', ${info.bih.width}×${Math.abs(info.bih.height)}`;
        break;
      case 'wfx':
        info.wfx = {};
        waveFormatEx(r, info.wfx);
        info.summary = `WAVEFORMATEX ${WAVE_TAGS[info.wfx.formatTag] ?? `0x${info.wfx.formatTag.toString(16)}`}, ${fmtInt(info.wfx.sampleRate)} Hz, ${info.wfx.channels} ch`;
        break;
      case 'prores': {
        const cc = r.fourcc('fourcc', { key: true, display: (v) => `'${v}' — ${PRORES[v] ?? 'unknown ProRes flavour'}` });
        info.summary = PRORES[cc] ?? `ProRes '${cc}'`;
        break;
      }
      case 'text': {
        const text = decodeText(u8.subarray(start, end)).replace(/\0+$/, '');
        r.bytes('header text', end - start, {
          display: quote(text.replace(/\r?\n/g, ' ↵ '), 400),
          desc: 'Text the subtitle decoder needs before the first cue: for ASS/SSA the [Script Info] and [V4+ Styles] sections, for WebVTT the file header, for VobSub the .idx palette and size.',
        });
        info.text = text;
        info.summary = `${fmtInt(end - start)} bytes of header text`;
        break;
      }
      default:
        if (end > start) {
          r.bytes('CodecPrivate', end - start, { desc: 'Codec initialisation data. Vidscope does not decode it for this codec.' });
        }
        break;
    }
    if (r.pos < end && !r.bit) {
      r.rest('trailing bytes', { desc: 'Bytes after the end of the codec configuration.' });
    }
  } catch (e) {
    if (!(e instanceof ParseError)) throw e;
    info.error = e.message;
    if (r.bit) r.align();
    if (r.pos < end) r.rest('unparsed bytes', { desc: 'Bytes Vidscope could not decode.' });
  }
  return info;
}
