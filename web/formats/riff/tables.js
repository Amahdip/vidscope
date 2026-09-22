// Lookup tables for RIFF files: video FOURCCs, WAVE format tags, speaker
// positions, RIFF INFO tags. Values come from the Microsoft headers (mmreg.h,
// ksmedia.h, vfw.h), the Multimedia Programming Interface and Data
// Specifications 1.0 (RIFF, INFO list) and the codec tags FFmpeg reads.

import { HEX2 } from '../../core/util.js';

// ------------------------------------------------------------ video FOURCCs

const V = (names, name, family = null) => names.split(' ').map((n) => [n, { name, family }]);

export const VIDEO_FOURCCS = new Map([
  ...V('H264 h264 X264 x264 AVC1 avc1 DAVC VSSH', 'H.264 / AVC', 'avc'),
  ...V('HEVC hevc H265 h265 HVC1 hvc1 HEV1 hev1', 'H.265 / HEVC', 'hevc'),
  ...V('FMP4 fmp4', 'MPEG-4 Part 2 (FFmpeg)', 'mpeg4v'),
  ...V('XVID xvid XviD', 'MPEG-4 Part 2 (Xvid)', 'mpeg4v'),
  ...V('DIVX divx DX50 dx50', 'MPEG-4 Part 2 (DivX 4/5)', 'mpeg4v'),
  ...V('MP4V mp4v M4S2 m4s2 3IV2 3iv2 RMP4 SEDG UMP4 WV1F', 'MPEG-4 Part 2', 'mpeg4v'),
  ...V('DIV3 div3 MP43 mp43 DIV4 div4 AP41 COL1', 'Microsoft MPEG-4 v3 (DivX ;-) 3, not ISO MPEG-4)'),
  ...V('MP42 mp42 DIV2 div2', 'Microsoft MPEG-4 v2'),
  ...V('MPG4 mpg4 DIV1 div1', 'Microsoft MPEG-4 v1'),
  ...V('MJPG mjpg AVRn dmb1 AVDJ JPGL', 'Motion JPEG'),
  ...V('mpg1 MPG1 PIM1', 'MPEG-1 video'),
  ...V('mpg2 MPG2 MPEG mpeg PIM2 MMES', 'MPEG-2 video'),
  ...V('WMV1 wmv1', 'Windows Media Video 7'),
  ...V('WMV2 wmv2', 'Windows Media Video 8'),
  ...V('WMV3 wmv3', 'Windows Media Video 9 (VC-1 Simple/Main)'),
  ...V('WVC1 wvc1 WMVA', 'VC-1 Advanced Profile'),
  ...V('VP80', 'VP8', 'vp8'),
  ...V('VP90', 'VP9', 'vp9'),
  ...V('AV01 av01', 'AV1', 'av1'),
  ...V('VP60 VP61 VP62 VP6F', 'On2 VP6'),
  ...V('VP30 VP31', 'On2 VP3'),
  ...V('dvsd DVSD dv25 dvhd dvsl dvcs CDVC CDVH dv50 DV50', 'DV'),
  ['dvc ', { name: 'DV', family: null }],
  ...V('HFYU', 'HuffYUV (lossless)'),
  ...V('FFVH', 'FFmpeg HuffYUV (lossless)'),
  ...V('FFV1', 'FFV1 (lossless)'),
  ...V('LAGS', 'Lagarith (lossless)'),
  ...V('UYVY Y422 UYNV HDYC', 'Uncompressed YUV 4:2:2 (UYVY)'),
  ...V('YUY2 YUYV YUNV V422', 'Uncompressed YUV 4:2:2 (YUY2)'),
  ...V('YV12', 'Uncompressed YUV 4:2:0 (YV12)'),
  ...V('I420 IYUV', 'Uncompressed YUV 4:2:0 (I420)'),
  ...V('NV12', 'Uncompressed YUV 4:2:0 (NV12)'),
  ...V('v210', 'Uncompressed 10-bit YUV 4:2:2 (v210)'),
  ...V('cvid', 'Cinepak'),
  ...V('IV31 IV32', 'Intel Indeo 3'),
  ...V('IV41', 'Intel Indeo 4'),
  ...V('IV50', 'Intel Indeo 5'),
  ...V('MSVC msvc CRAM cram WHAM wham', 'Microsoft Video 1'),
  ...V('mrle', 'Microsoft RLE'),
  ...V('tscc TSCC', 'TechSmith Screen Capture'),
  ...V('FLV1', 'Sorenson Spark (H.263 variant)'),
  ...V('H263 h263 U263 M263', 'H.263'),
  ...V('SVQ1', 'Sorenson Video 1'),
  ...V('theo', 'Theora'),
  ...V('MPNG PNG1', 'PNG'),
  ['png ', { name: 'PNG', family: null }],
  ...V('CFHD', 'GoPro CineForm'),
  ...V('Hap1 Hap5 HapY HapM', 'HAP'),
  ...V('DXSB DXSA', 'DivX subtitles (bitmap)'),
  ...V('MSZH ZLIB', 'LCL (lossless)'),
  ['RGB ', { name: 'Uncompressed RGB', family: null }],
]);

/** biCompression values that are numbers rather than FOURCCs. */
export const BI_COMPRESSION = {
  0: 'BI_RGB (uncompressed RGB)',
  1: 'BI_RLE8 (8-bit run-length)',
  2: 'BI_RLE4 (4-bit run-length)',
  3: 'BI_BITFIELDS (RGB with colour masks)',
  4: 'BI_JPEG',
  5: 'BI_PNG',
};

export function videoCodec(fourcc) {
  if (!fourcc) return null;
  return VIDEO_FOURCCS.get(fourcc) ?? VIDEO_FOURCCS.get(fourcc.toUpperCase()) ?? VIDEO_FOURCCS.get(fourcc.toLowerCase()) ?? null;
}

// ------------------------------------------------------------ WAVE format tags

export const FORMAT_TAGS = {
  0x0000: 'unknown',
  0x0001: 'PCM (integer samples)',
  0x0002: 'Microsoft ADPCM',
  0x0003: 'IEEE floating-point PCM',
  0x0005: 'IBM CVSD',
  0x0006: 'A-law (G.711)',
  0x0007: 'µ-law (G.711)',
  0x0008: 'DTS',
  0x0009: 'DRM',
  0x000a: 'Windows Media Audio 9 Voice',
  0x0010: 'OKI ADPCM',
  0x0011: 'IMA ADPCM (DVI)',
  0x0012: 'MediaSpace ADPCM',
  0x0013: 'Sierra ADPCM',
  0x0014: 'G.723 ADPCM',
  0x0020: 'Yamaha ADPCM',
  0x0022: 'DSP Group TrueSpeech',
  0x0031: 'GSM 6.10',
  0x0040: 'G.721 ADPCM',
  0x0050: 'MPEG-1 Audio Layer I/II',
  0x0055: 'MPEG Audio Layer III (MP3)',
  0x0061: 'Duck DK4 IMA ADPCM',
  0x0062: 'Duck DK3 IMA ADPCM',
  0x0092: 'Dolby AC-3 over S/PDIF (IEC 61937)',
  0x00ff: 'AAC (raw, configuration in the format extension)',
  0x0160: 'Windows Media Audio 1',
  0x0161: 'Windows Media Audio 2 (WMA)',
  0x0162: 'Windows Media Audio 9 Professional',
  0x0163: 'Windows Media Audio 9 Lossless',
  0x0164: 'WMA Pro over S/PDIF',
  0x0200: 'Creative ADPCM',
  0x0270: 'Sony ATRAC3',
  0x1600: 'AAC in ADTS frames',
  0x1602: 'AAC in LOAS/LATM',
  0x1610: 'HE-AAC',
  0x2000: 'AC-3 (Dolby Digital)',
  0x2001: 'DTS',
  0x566f: 'Vorbis',
  0x674f: 'Ogg Vorbis (mode 1)',
  0x6750: 'Ogg Vorbis (mode 2)',
  0x6751: 'Ogg Vorbis (mode 3)',
  0x676f: 'Ogg Vorbis (mode 1+)',
  0x6770: 'Ogg Vorbis (mode 2+)',
  0x6771: 'Ogg Vorbis (mode 3+)',
  0x4143: 'AAC (non-standard tag)',
  0x706d: 'AAC (non-standard tag)',
  0xa106: 'AAC (non-standard tag)',
  0xf1ac: 'FLAC',
  0xfffe: 'WAVE_FORMAT_EXTENSIBLE (see SubFormat)',
  0xffff: 'experimental / development',
};

/** Short codec name and parser family for a WAVE format tag. */
export function audioCodec(tag) {
  switch (tag) {
    case 0x0001: return { name: 'PCM', family: null, pcm: true };
    case 0x0003: return { name: 'PCM float', family: null, pcm: true };
    case 0x0006: return { name: 'A-law', family: null };
    case 0x0007: return { name: 'µ-law', family: null };
    case 0x0002: return { name: 'MS ADPCM', family: null, adpcm: true };
    case 0x0011: return { name: 'IMA ADPCM', family: null, adpcm: true };
    case 0x0050: return { name: 'MPEG audio (Layer I/II)', family: 'mp3' };
    case 0x0055: return { name: 'MP3', family: 'mp3' };
    case 0x00ff: case 0x706d: case 0xa106: case 0x4143: case 0x1610: return { name: 'AAC', family: 'aac' };
    case 0x1600: return { name: 'AAC (ADTS)', family: 'aac', adts: true };
    case 0x2000: return { name: 'AC-3', family: 'ac3' };
    case 0x0092: return { name: 'AC-3 (IEC 61937 bursts)', family: null };
    case 0x2001: case 0x0008: return { name: 'DTS', family: null };
    case 0xf1ac: return { name: 'FLAC', family: null };
    case 0x0161: case 0x0160: case 0x0162: case 0x0163: return { name: 'WMA', family: null };
    default: return { name: FORMAT_TAGS[tag] ?? `format 0x${tag.toString(16).padStart(4, '0')}`, family: null };
  }
}

export function formatTagName(tag) {
  return FORMAT_TAGS[tag] ?? 'not a registered tag Vidscope knows';
}

// ------------------------------------------------------------ speaker positions

export const SPEAKERS = [
  ['FL', 'front left'], ['FR', 'front right'], ['FC', 'front centre'], ['LFE', 'low-frequency effects'],
  ['BL', 'back left'], ['BR', 'back right'], ['FLC', 'front left of centre'], ['FRC', 'front right of centre'],
  ['BC', 'back centre'], ['SL', 'side left'], ['SR', 'side right'], ['TC', 'top centre'],
  ['TFL', 'top front left'], ['TFC', 'top front centre'], ['TFR', 'top front right'], ['TBL', 'top back left'],
  ['TBC', 'top back centre'], ['TBR', 'top back right'],
];

const LAYOUTS = {
  0x4: 'mono', 0x3: 'stereo', 0x7: '3.0', 0x103: '3.0 (back)', 0x33: 'quad', 0x603: 'quad (side)', 0x107: '4.0',
  0x37: '5.0 (back)', 0x607: '5.0 (side)', 0x3f: '5.1 (back)', 0x60f: '5.1 (side)', 0x13f: '6.1',
  0x70f: '6.1 (side)', 0x63f: '7.1', 0xff: '7.1 (wide)', 0x2d63f: '7.1.4',
};

/** "FL FR FC LFE BL BR (5.1 (back))" */
export function channelMaskText(mask) {
  if (!mask) return '0 (no positions assigned: the order of the channels is up to the player)';
  const names = [];
  for (let b = 0; b < SPEAKERS.length; b++) if (mask & (1 << b)) names.push(SPEAKERS[b][0]);
  if (mask & 0x80000000) names.push('ALL');
  const other = mask & 0x7ffc0000;
  if (other) names.push(`reserved bits 0x${other.toString(16)}`);
  const layout = LAYOUTS[mask >>> 0];
  return `${names.join(' ')}${layout ? ` (${layout})` : ''}`;
}

/** "5.1 (back)" for a known layout, else the speaker list. */
export function channelLayoutName(mask) {
  const layout = LAYOUTS[mask >>> 0];
  if (layout) return layout;
  return channelMaskText(mask).replace(/ \(.*\)$/, '');
}

export function channelMaskCount(mask) {
  let n = 0;
  for (let b = 0; b < SPEAKERS.length; b++) if (mask & (1 << b)) n++;
  return n;
}

// ------------------------------------------------------------ GUIDs

/** Microsoft GUID layout: Data1-3 little-endian, Data4 as stored. */
export function guidString(u8, p = 0) {
  const h = (i) => HEX2[u8[p + i]];
  return `${h(3)}${h(2)}${h(1)}${h(0)}-${h(5)}${h(4)}-${h(7)}${h(6)}-${h(8)}${h(9)}-${h(10)}${h(11)}${h(12)}${h(13)}${h(14)}${h(15)}`;
}

/** Describe a WAVEFORMATEXTENSIBLE SubFormat GUID. Returns {tag?, text}. */
export function subFormatInfo(guid) {
  const g = guid.toUpperCase();
  const m = /^0000([0-9A-F]{4})-0000-0010-8000-00AA00389B71$/.exec(g);
  if (m) {
    const tag = parseInt(m[1], 16);
    return { tag, text: `KSDATAFORMAT_SUBTYPE for format tag 0x${m[1]}: ${FORMAT_TAGS[tag] ?? 'unknown format'}` };
  }
  if (g === '00000001-0721-11D3-8644-C8C1CA000000') return { tag: 1, ambisonic: true, text: 'Ambisonic B-format, integer PCM' };
  if (g === '00000003-0721-11D3-8644-C8C1CA000000') return { tag: 3, ambisonic: true, text: 'Ambisonic B-format, floating-point PCM' };
  return { tag: null, text: 'a GUID Vidscope does not know' };
}

// ------------------------------------------------------------ INFO list

export const INFO_TAGS = {
  IARL: ['Archival location', 'Where the subject of the file is archived.'],
  IART: ['Artist', 'The artist of the original subject.'],
  ICMS: ['Commissioned', 'Who commissioned the subject.'],
  ICMT: ['Comments', 'General comments about the file.'],
  ICOP: ['Copyright', 'Copyright information.'],
  ICRD: ['Creation date', 'When the subject was created, conventionally YYYY-MM-DD.'],
  ICRP: ['Cropped', 'Whether and how the image was cropped.'],
  IDIM: ['Dimensions', 'Size of the original subject.'],
  IDPI: ['Dots per inch', 'Resolution used to digitise the subject.'],
  IENG: ['Engineer', 'Who worked on the file.'],
  IGNR: ['Genre', 'Genre of the subject.'],
  IKEY: ['Keywords', 'Keywords separated by semicolons.'],
  ILGT: ['Lightness', 'Lightness settings used when digitising.'],
  IMED: ['Medium', 'Original medium of the subject (e.g. film, record).'],
  INAM: ['Name / title', 'The title of the subject.'],
  IPLT: ['Palette setting', 'Number of colours requested when digitising.'],
  IPRD: ['Product', 'The product the subject was originally intended for (e.g. the album).'],
  ISBJ: ['Subject', 'What the file is about.'],
  ISFT: ['Software', 'The software that wrote the file (FFmpeg writes "Lavf" and its version).'],
  ISHP: ['Sharpness', 'Sharpness settings used when digitising.'],
  ISRC: ['Source', 'Who supplied the subject.'],
  ISRF: ['Source form', 'The original form of the material (e.g. slide, VHS).'],
  ITCH: ['Technician', 'Who digitised the subject.'],
  ITRK: ['Track number', 'Track number (a common extension, not in the original list).'],
  IPRT: ['Part', 'Part number (a common extension).'],
  ILNG: ['Language', 'Language (a common extension used by some AVI writers).'],
  ISMP: ['SMPTE time code', 'SMPTE time code of the digitisation start point (OpenDML).'],
  IDIT: ['Digitisation time', 'When the file was digitised (OpenDML): date and time as text.'],
  IENC: ['Encoded by', 'Who or what encoded the file (common extension).'],
  ISTR: ['Starring', 'Performers (common extension).'],
  IWRI: ['Written by', 'Writer (common extension).'],
  IPRO: ['Produced by', 'Producer (common extension).'],
  IEDT: ['Edited by', 'Editor (common extension).'],
  ICNT: ['Country', 'Country (common extension).'],
  IRTD: ['Rating', 'Rating (common extension).'],
};

// ------------------------------------------------------------ AVI flags

export const AVIF = {
  0x00000010: 'AVIF_HASINDEX',
  0x00000020: 'AVIF_MUSTUSEINDEX',
  0x00000100: 'AVIF_ISINTERLEAVED',
  0x00000800: 'AVIF_TRUSTCKTYPE',
  0x00010000: 'AVIF_WASCAPTUREFILE',
  0x00020000: 'AVIF_COPYRIGHTED',
};

export const AVISF = {
  0x00000001: 'AVISF_DISABLED',
  0x00010000: 'AVISF_VIDEO_PALCHANGES',
};

export const AVIIF = {
  0x00000001: 'AVIIF_LIST',
  0x00000010: 'AVIIF_KEYFRAME',
  0x00000020: 'AVIIF_FIRSTPART',
  0x00000040: 'AVIIF_LASTPART',
  0x00000100: 'AVIIF_NO_TIME',
};

export function flagsText(v, names, width = 8) {
  const set = [];
  let known = 0;
  for (const [bit, name] of Object.entries(names)) {
    const b = Number(bit);
    known |= b;
    if ((v & b) === b && b) set.push(name);
  }
  const rest = (v & ~known) >>> 0;
  if (rest) set.push(`0x${rest.toString(16)}`);
  return `0x${(v >>> 0).toString(16).toUpperCase().padStart(width, '0')}${set.length ? ` (${set.join(' | ')})` : ' (none)'}`;
}

export const STREAM_TYPES = {
  vids: 'video',
  auds: 'audio',
  txts: 'text / subtitles',
  mids: 'MIDI',
  iavs: 'interleaved audio + video (DV type 1)',
  dats: 'data',
};

export const CHUNK_TWOCC = {
  db: 'uncompressed video frame',
  dc: 'compressed video frame',
  pc: 'palette change',
  wb: 'audio data',
  tx: 'text / subtitle',
  sb: 'subtitle (DivX)',
  st: 'subtitle',
};
