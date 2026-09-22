// Sample entries (the codec descriptions inside stsd) and codec configuration boxes.

import { fmtInt, fmtNum, fmtHz, fmtBitrate, ratio, decodeText } from '../../core/util.js';
import { BOXES } from './boxes.js';
import { reg } from './registry.js';
import { CODEC_NAMES, codecFamily } from '../../codecs/index.js';
import { parseAvcC, profileName as avcProfileName, levelName as avcLevelName } from '../../codecs/h264.js';
import { parseHvcC, PROFILES as HEVC_PROFILES, levelName as hevcLevelName } from '../../codecs/h265.js';
import { parseAv1C, levelName as av1LevelName } from '../../codecs/av1.js';
import { parseVpcC } from '../../codecs/vp9.js';
import { parseEsds, aacName } from '../../codecs/mpeg4audio.js';
import { parseDOps, parseDac3, parseDec3, parseFlacMetadata, parseAlacConfig } from '../../codecs/audio.js';
import { COLOUR_PRIMARIES, TRANSFER_CHARACTERISTICS, MATRIX_COEFFICIENTS, colourSummary } from '../../codecs/color.js';

const def = (type, d) => {
  BOXES[type] = { spec: 'ISO', ...d };
};

// ------------------------------------------------------------------ sample entries

const VISUAL = new Set([
  'avc1', 'avc2', 'avc3', 'avc4', 'hvc1', 'hev1', 'hvc2', 'hev2', 'hvc3', 'hev3', 'dvh1', 'dvhe', 'dva1', 'dvav', 'dav1',
  'av01', 'vp08', 'vp09', 'vp10', 'mp4v', 's263', 'h263', 'jpeg', 'mjpa', 'mjpb', 'mjp2', 'png ', 'apch', 'apcn', 'apcs',
  'apco', 'ap4h', 'ap4x', 'aprh', 'aprn', 'dvc ', 'dvcp', 'dvpp', 'dv5n', 'dv5p', 'dvh2', 'dvh3', 'dvh5', 'dvh6', 'dvhp',
  'dvhq', 'AVdn', 'AVdh', 'raw ', 'rle ', 'encv', 'resv', 'vvc1', 'vvi1', 'evc1', 'apv1', 'hvt1', 'lhv1', 'lhe1', 'uncv',
  'avcp', 'j2ki', 'mjpg', 'vc-1', 'mp2v', 'xdvc', 'xd54', 'xd55', 'xd5b', 'xd5c', 'xd5d', 'xd5e', 'xd5f', 'xdv4', 'xdv5',
  'xdv6', 'xdv7', 'xdv8', 'xdv9', 'xdva', 'xdvb', 'xdvc', 'xdvd', 'xdve', 'xdvf', 'Hap1', 'Hap5', 'HapY', 'cvid', 'SVQ3', 'SVQ1',
]);
const AUDIO = new Set([
  'mp4a', 'ac-3', 'ec-3', 'ac-4', 'Opus', 'fLaC', 'alac', 'samr', 'sawb', 'sawp', 'lpcm', 'ipcm', 'fpcm', 'twos', 'sowt',
  'in24', 'in32', 'fl32', 'fl64', 'NONE', 'ulaw', 'alaw', '.mp3', 'mp3 ', 'mha1', 'mha2', 'mhm1', 'mhm2', 'dtsc', 'dtsh',
  'dtsl', 'dtse', 'dtsx', 'mlpa', 'enca', 'iamf', 'ima4', 'MAC3', 'MAC6', 'QDM2', 'Qclp', 'agsm', 'spex', 'sevc', 'sqcp',
]);
const TEXT = new Set(['tx3g', 'wvtt', 'stpp', 'sbtt', 'stxt', 'c608', 'c708', 'text', 'mett', 'metx', 'urim', 'mebx', 'tmcd', 'camm', 'gpmd', 'enct', 'encm']);

export function codecDisplayName(type) {
  return CODEC_NAMES[type] ?? CODEC_NAMES[type.trim()] ?? (reg('codecs', type) ?? reg('codecs-qt', type))?.[0] ?? null;
}

function sampleEntryHeader(r) {
  r.skip(6, 'reserved', { desc: 'Six reserved bytes that start every sample entry.' });
  return r.u16('data_reference_index', { desc: '1-based index into dref: where this entry’s samples are stored. 1 = this file.' });
}

function visualEntry(r, n, ctx) {
  sampleEntryHeader(r);
  r.u16('pre_defined', { desc: 'Zero in ISO files (QuickTime: version).' });
  r.skip(2, 'reserved', { desc: 'Zero in ISO files (QuickTime: revision level).' });
  r.bytes('pre_defined', 12, { reserved: true, desc: 'Zero in ISO files. QuickTime puts a vendor code and temporal/spatial quality here.' });
  const w = r.u16('width', { key: true, unit: 'pixels', desc: 'Coded width of the pictures, in pixels.' });
  const h = r.u16('height', { key: true, unit: 'pixels', desc: 'Coded height of the pictures, in pixels.' });
  r.fixed('horizresolution', 4, 16, { unsigned: true, desc: 'Pixels per inch; always 72 dpi.' });
  r.fixed('vertresolution', 4, 16, { unsigned: true });
  r.u32('reserved', { reserved: true, desc: 'Zero (QuickTime: data size).' });
  r.u16('frame_count', { desc: 'Frames per sample; 1 for normal video.' });
  // A fixed 32-byte field holding a Pascal string: a length byte, then up to 31 characters.
  r.need(32, 'compressorname');
  const len = Math.min(r.u[r.pos], 31);
  const name = decodeText(r.u.subarray(r.pos + 1, r.pos + 1 + len));
  r.bytes('compressorname', 32, {
    display: name ? `"${name}"` : '(empty)',
    desc: 'Name of the encoder or codec, informative only: a 32-byte field holding a length byte then up to 31 characters.',
  });
  r.u16('depth', { display: (v) => (v === 0x18 ? '24 (0x0018): colour, no alpha' : v === 0x20 ? '32: colour with alpha' : `${v}`), desc: '0x0018 means colour images with no alpha.' });
  r.i16('pre_defined', { desc: 'Always -1 (QuickTime: colour table ID, -1 = none).' });
  n.data.entry = { kind: 'video', fourcc: n.type, width: w, height: h, compressor: name };
  ctx.entry = n.data.entry;
  n.data.summary = `${w}×${h}${name ? ` "${name}"` : ''}`;
}

function audioEntry(r, n, ctx) {
  sampleEntryHeader(r);
  const version = r.u16('version', {
    desc: 'Zero in ISO files. In QuickTime files, 1 or 2 selects the extended sound description layouts.',
  });
  r.u16('revision', { reserved: true });
  r.u32('vendor', { reserved: true });
  let channels = r.u16('channelcount', { key: true, desc: 'Number of audio channels (codec config may override: AAC uses its channelConfiguration).' });
  const bits = r.u16('samplesize', { unit: 'bits', desc: 'Bits per sample for uncompressed audio; 16 by convention for compressed codecs.' });
  r.u16('pre_defined', { desc: 'Zero in ISO files (QuickTime: compression ID, -2 for version 2).' });
  r.u16('reserved', { reserved: true, desc: 'Zero (QuickTime: packet size).' });
  let rate = r.fixed('samplerate', 4, 16, {
    unsigned: true,
    key: true,
    display: (v) => `${fmtNum(v, 3)} Hz`,
    desc: 'Sample rate in 16.16 fixed point, so rates above 65535 Hz do not fit here (the codec config gives the real rate).',
  });
  if (ctx.isQT && version === 1) {
    r.u32('samplesPerPacket');
    r.u32('bytesPerPacket');
    r.u32('bytesPerFrame');
    r.u32('bytesPerSample');
  } else if (ctx.isQT && version === 2) {
    r.u32('sizeOfStructOnly');
    rate = r.f64('audioSampleRate', { key: true, unit: 'Hz' });
    channels = r.u32('numAudioChannels', { key: true });
    r.u32('always7F000000', { reserved: true });
    r.u32('constBitsPerChannel');
    r.u32('formatSpecificFlags');
    r.u32('constBytesPerAudioPacket');
    r.u32('constLPCMFramesPerAudioPacket');
  }
  n.data.entry = { kind: 'audio', fourcc: n.type, channels, sampleRate: rate, bits };
  ctx.entry = n.data.entry;
  n.data.summary = `${channels} ch, ${fmtHz(rate)}`;
}

/** True when the reader is at something that looks like a box header. */
export function looksLikeBox(r) {
  if (r.remaining < 8) return false;
  const size = r.dv.getUint32(r.pos);
  if (size < 8 || size > r.remaining) return false;
  for (let k = 4; k < 8; k++) {
    const c = r.u[r.pos + k];
    if (!((c >= 0x20 && c < 0x7f) || c === 0xa9)) return false;
  }
  return true;
}

function genericEntry(r, n, ctx) {
  sampleEntryHeader(r);
  n.data.entry = { kind: ctx.handler === 'vide' ? 'video' : ctx.handler === 'soun' ? 'audio' : 'data', fourcc: n.type };
  ctx.entry = n.data.entry;
  // Unknown codec: keep any child boxes, otherwise show the rest as codec data.
  if (r.remaining > 0 && !looksLikeBox(r)) {
    r.rest('codec-specific data', { desc: 'Fields specific to this codec, which Vidscope does not decode.' });
  }
}

const VISUAL_DEF = {
  cat: 'codec',
  sec: '12.1.3',
  container: true,
  desc: 'Visual sample entry: which video codec the track uses, the coded picture size, and the codec’s configuration box.',
  more: 'The fixed fields are mostly historic (resolution 72 dpi, depth 24). What matters is the codec (this box’s type), width/height, and the configuration box inside (avcC, hvcC, av1C...) plus optional pasp, colr and btrt.',
  parse: visualEntry,
};

const AUDIO_DEF = {
  cat: 'codec',
  sec: '12.2.3',
  container: true,
  desc: 'Audio sample entry: which audio codec the track uses, its channel count and sample rate, and the codec’s configuration box.',
  more: 'For AAC the esds box inside holds the authoritative configuration (object type, sample rate, channels); the fixed fields here are often generic.',
  parse: audioEntry,
};

export function sampleEntryDef(type, ctx) {
  const name = codecDisplayName(type);
  if (VISUAL.has(type) || (!AUDIO.has(type) && !TEXT.has(type) && ctx.handler === 'vide')) {
    return { ...VISUAL_DEF, id: `visual:${type}`, name: `${name ?? 'Video'} sample entry` };
  }
  if (AUDIO.has(type) || (!TEXT.has(type) && ctx.handler === 'soun')) {
    return { ...AUDIO_DEF, id: `audio:${type}`, name: `${name ?? 'Audio'} sample entry` };
  }
  if (TEXT_DEFS[type]) return { ...TEXT_DEFS[type], id: `text:${type}`, name: `${name ?? type} sample entry` };
  return {
    cat: 'codec',
    container: true,
    id: `generic:${type}`,
    name: `${name ?? `'${type}'`} sample entry`,
    desc: 'A sample entry for a codec Vidscope does not decode; the common header is shown and the rest is left as bytes.',
    parse: genericEntry,
  };
}

const TEXT_DEFS = {
  tx3g: {
    cat: 'codec',
    spec: '3GPP',
    container: true,
    desc: '3GPP timed text (the "mov_text" subtitle format): default text box, style and font table.',
    parse(r, n, ctx) {
      sampleEntryHeader(r);
      r.u32('displayFlags');
      r.i8('horizontal-justification', { enum: { 0: 'left', 1: 'centre', '-1': 'right' } });
      r.i8('vertical-justification', { enum: { 0: 'top', 1: 'centre', '-1': 'bottom' } });
      r.bytes('background-color-rgba', 4);
      r.group('default-text-box', () => {
        r.i16('top');
        r.i16('left');
        r.i16('bottom');
        r.i16('right');
      });
      r.group('default-style', () => {
        r.u16('startChar');
        r.u16('endChar');
        r.u16('font-ID');
        r.u8('face-style-flags');
        r.u8('font-size');
        r.bytes('text-color-rgba', 4);
      });
      n.data.entry = { kind: 'subtitle', fourcc: n.type };
      ctx.entry = n.data.entry;
    },
  },
  wvtt: { cat: 'codec', spec: 'ISO-Text', container: true, desc: 'WebVTT subtitles: the config box holds the WEBVTT file header.', parse: (r, n, ctx) => { sampleEntryHeader(r); n.data.entry = { kind: 'subtitle', fourcc: 'wvtt' }; ctx.entry = n.data.entry; } },
  stpp: {
    cat: 'codec',
    spec: 'ISO-Text',
    container: true,
    desc: 'TTML (XML) subtitles, as used by DASH and broadcast.',
    parse(r, n, ctx) {
      sampleEntryHeader(r);
      r.cstr('namespace', { key: true });
      if (r.remaining) r.cstr('schema_location');
      if (r.remaining) r.cstr('auxiliary_mime_types');
      n.data.entry = { kind: 'subtitle', fourcc: 'stpp' };
      ctx.entry = n.data.entry;
    },
  },
  text: {
    cat: 'codec',
    spec: 'QT',
    container: true,
    desc: 'QuickTime text sample entry: display flags, justification, colours, default text box and font. FFmpeg uses a text track like this for chapter titles.',
    parse(r, n, ctx) {
      sampleEntryHeader(r);
      r.u32('displayFlags', { display: (v) => `0x${v.toString(16).padStart(8, '0')}` });
      r.i32('textJustification', { enum: { 0: 'left', 1: 'centre', '-1': 'right' } });
      r.bytes('bgColor', 6, { desc: 'Background colour as three 16-bit RGB values.' });
      r.group('defaultTextBox', () => {
        r.i16('top');
        r.i16('left');
        r.i16('bottom');
        r.i16('right');
      });
      r.skip(8, 'reserved');
      r.u16('fontNumber');
      r.u16('fontFace');
      r.u8('reserved', { reserved: true });
      r.u16('reserved', { reserved: true });
      r.bytes('foreColor', 6, { desc: 'Text colour as three 16-bit RGB values.' });
      if (r.remaining > 0 && !looksLikeBox(r)) r.pstr('textName');
      n.data.entry = { kind: 'subtitle', fourcc: 'text' };
      ctx.entry = n.data.entry;
    },
  },
  c608: { cat: 'codec', spec: 'QT', desc: 'CEA-608 closed captions (QuickTime caption track).', parse: (r, n, ctx) => { sampleEntryHeader(r); n.data.entry = { kind: 'subtitle', fourcc: 'c608' }; ctx.entry = n.data.entry; } },
  tmcd: {
    cat: 'codec',
    spec: 'QT',
    container: true,
    desc: 'Timecode sample entry: how to count timecode (timescale, frame duration, drop-frame). Each sample is a 32-bit frame number.',
    parse(r, n, ctx) {
      sampleEntryHeader(r);
      r.u32('reserved', { reserved: true });
      const flags = r.u32('flags', { display: (v) => `0x${v.toString(16)}${v & 1 ? ' (drop frame)' : ''}${v & 2 ? ' (24-hour max)' : ''}${v & 4 ? ' (negative allowed)' : ''}${v & 8 ? ' (counter)' : ''}` });
      const ts = r.u32('timescale', { key: true });
      const fd = r.u32('frame_duration', { key: true });
      const nf = r.u8('number_of_frames', { desc: 'Frames per second, rounded (e.g. 30 for 29.97).' });
      r.u8('reserved', { reserved: true });
      n.data.entry = { kind: 'timecode', fourcc: 'tmcd', timescale: ts, frameDuration: fd, frames: nf, dropFrame: !!(flags & 1) };
      ctx.entry = n.data.entry;
      n.data.summary = `${fmtNum(ts / fd, 3)} fps${flags & 1 ? ', drop frame' : ''}`;
    },
  },
  mett: {
    cat: 'codec',
    desc: 'Text-based timed metadata.',
    container: true,
    parse(r, n, ctx) {
      sampleEntryHeader(r);
      r.cstr('content_encoding');
      if (r.remaining) r.cstr('mime_format', { key: true });
      n.data.entry = { kind: 'data', fourcc: 'mett' };
      ctx.entry = n.data.entry;
    },
  },
  metx: {
    cat: 'codec',
    desc: 'XML timed metadata.',
    container: true,
    parse(r, n, ctx) {
      sampleEntryHeader(r);
      r.cstr('content_encoding');
      if (r.remaining) r.cstr('namespace', { key: true });
      if (r.remaining) r.cstr('schema_location');
      n.data.entry = { kind: 'data', fourcc: 'metx' };
      ctx.entry = n.data.entry;
    },
  },
};

// ------------------------------------------------------------------ codec configuration

function attach(ctx, n, key, info) {
  n.data.config = info;
  if (ctx.entry) ctx.entry[key] = info;
}

def('avcC', {
  name: 'AVC Configuration Box',
  cat: 'codec',
  spec: 'NALu Video',
  desc: 'H.264 decoder setup: profile, level, the NAL length size, and the SPS and PPS parameter sets a decoder needs before the first frame.',
  more: 'The SPS (sequence parameter set) holds the resolution, chroma format, bit depth and VUI (colour, frame rate). The PPS (picture parameter set) holds entropy-coding settings. With avc1 these live only here; with avc3 they may also appear in the samples.',
  parse(r, n, ctx) {
    const info = parseAvcC(r, ctx.entry?.fourcc && /^avc|dva/.test(ctx.entry.fourcc) ? ctx.entry.fourcc : 'avc1');
    attach(ctx, n, 'avc', info);
    const sps = info.sps[0];
    n.data.summary = `${avcProfileName(info.profile, info.compat)}@L${avcLevelName(info.level, info.compat, info.profile)}${sps ? `, ${sps.width}×${sps.height}` : ''}`;
  },
});

def('hvcC', {
  name: 'HEVC Configuration Box',
  cat: 'codec',
  spec: 'NALu Video',
  desc: 'H.265 decoder setup: profile, tier and level, chroma format, bit depth, NAL length size and the VPS, SPS and PPS parameter sets.',
  parse(r, n, ctx) {
    const info = parseHvcC(r, ctx.entry?.fourcc && /^(hvc|hev|dvh)/.test(ctx.entry.fourcc) ? ctx.entry.fourcc : 'hvc1');
    attach(ctx, n, 'hevc', info);
    n.data.summary = `${HEVC_PROFILES[info.profile_idc] ?? info.profile_idc}@L${hevcLevelName(info.level_idc)}${info.tier ? ' High tier' : ''}, ${info.bit_depth_luma}-bit`;
  },
});

def('av1C', {
  name: 'AV1 Codec Configuration Box',
  cat: 'codec',
  spec: 'AV1-ISOBMFF',
  sec: '2.3',
  desc: 'AV1 decoder setup: profile, level, tier, bit depth and chroma subsampling, followed by the sequence header OBU.',
  syntax: 'class AV1CodecConfigurationBox extends Box(\'av1C\') {\n    AV1CodecConfigurationRecord av1Config;\n}\n\naligned(8) class AV1CodecConfigurationRecord {\n    unsigned int(1) marker = 1;\n    unsigned int(7) version = 1;\n    unsigned int(3) seq_profile;\n    unsigned int(5) seq_level_idx_0;\n    unsigned int(1) seq_tier_0;\n    unsigned int(1) high_bitdepth;\n    unsigned int(1) twelve_bit;\n    unsigned int(1) monochrome;\n    unsigned int(1) chroma_subsampling_x;\n    unsigned int(1) chroma_subsampling_y;\n    unsigned int(2) chroma_sample_position;\n    unsigned int(3) reserved = 0;\n    unsigned int(1) initial_presentation_delay_present;\n    if (initial_presentation_delay_present) {\n        unsigned int(4) initial_presentation_delay_minus_one;\n    } else {\n        unsigned int(4) reserved = 0;\n    }\n    unsigned int(8) configOBUs[];\n}',
  parse(r, n, ctx) {
    const info = parseAv1C(r);
    attach(ctx, n, 'av1', info);
    n.data.summary = `profile ${info.seq_profile}, level ${av1LevelName(info.seq_level_idx_0)}, ${info.twelve_bit ? 12 : info.high_bitdepth ? 10 : 8}-bit`;
  },
});

def('vpcC', {
  name: 'VP Codec Configuration Box',
  cat: 'codec',
  spec: 'VPxx',
  sec: '2.2',
  full: true,
  desc: 'VP8/VP9 decoder setup: profile, level, bit depth, chroma subsampling and colour description.',
  syntax: 'class VPCodecConfigurationBox extends FullBox(\'vpcC\', version = 1, 0) {\n    VPCodecConfigurationRecord() vpcConfig;\n}\n\naligned(8) class VPCodecConfigurationRecord {\n    unsigned int(8)  profile;\n    unsigned int(8)  level;\n    unsigned int(4)  bitDepth;\n    unsigned int(3)  chromaSubsampling;\n    unsigned int(1)  videoFullRangeFlag;\n    unsigned int(8)  colourPrimaries;\n    unsigned int(8)  transferCharacteristics;\n    unsigned int(8)  matrixCoefficients;\n    unsigned int(16) codecIntializationDataSize;\n    unsigned int(8)  codecIntializationData[];\n}',
  parse(r, n, ctx) {
    const info = parseVpcC(r, ctx.entry?.fourcc ?? 'vp09');
    attach(ctx, n, 'vp', info);
    n.data.summary = `profile ${info.profile}, ${info.bitDepth}-bit`;
  },
});

def('esds', {
  name: 'Elementary Stream Descriptor Box',
  cat: 'codec',
  spec: 'MP4v2',
  full: true,
  desc: 'MPEG-4 decoder setup: the codec (objectTypeIndication), buffer size and bitrates, and for AAC the AudioSpecificConfig (profile, sample rate, channels).',
  more: 'It nests descriptors: ES_Descriptor → DecoderConfigDescriptor → DecoderSpecificInfo, each with a tag and a variable-length size. For AAC the 2+ bytes of DecoderSpecificInfo are what a decoder really needs.',
  syntax: 'aligned(8) class ESDBox extends FullBox(\'esds\', version = 0, 0) {\n    ES_Descriptor ES;\n}\n\nclass ES_Descriptor extends BaseDescriptor : bit(8) tag=ES_DescrTag {\n    bit(16) ES_ID;\n    bit(1) streamDependenceFlag;\n    bit(1) URL_Flag;\n    bit(1) OCRstreamFlag;\n    bit(5) streamPriority;\n    if (streamDependenceFlag) bit(16) dependsOn_ES_ID;\n    if (URL_Flag) { bit(8) URLlength; bit(8) URLstring[URLlength]; }\n    if (OCRstreamFlag) bit(16) OCR_ES_Id;\n    DecoderConfigDescriptor decConfigDescr;\n    SLConfigDescriptor slConfigDescr;\n    ...\n}\n\nclass DecoderConfigDescriptor extends BaseDescriptor : bit(8) tag=DecoderConfigDescrTag {\n    bit(8) objectTypeIndication;\n    bit(6) streamType;\n    bit(1) upStream;\n    const bit(1) reserved=1;\n    bit(24) bufferSizeDB;\n    bit(32) maxBitrate;\n    bit(32) avgBitrate;\n    DecoderSpecificInfo decSpecificInfo[0 .. 1];\n    ...\n}',
  parse(r, n, ctx) {
    const info = parseEsds(r);
    attach(ctx, n, 'esds', info);
    n.data.summary = info.asc ? `${aacName(info.asc)}, ${fmtHz(info.asc.extSampleRate || info.asc.sampleRate)}, ${info.asc.channels || '?'} ch` : info.codec ?? '';
  },
});

def('dOps', {
  name: 'Opus Specific Box',
  cat: 'codec',
  spec: 'Opus',
  sec: '4.3.2',
  desc: 'Opus decoder setup: channel count, pre-skip (encoder delay), original sample rate and channel mapping.',
  syntax: 'class OpusSpecificBox extends Box(\'dOps\') {\n    unsigned int(8)  Version = 0;\n    unsigned int(8)  OutputChannelCount;\n    unsigned int(16) PreSkip;\n    unsigned int(32) InputSampleRate;\n    signed int(16)   OutputGain;\n    unsigned int(8)  ChannelMappingFamily;\n    if (ChannelMappingFamily != 0) {\n        ChannelMappingTable(OutputChannelCount);\n    }\n}',
  parse(r, n, ctx) {
    const info = parseDOps(r);
    attach(ctx, n, 'opus', info);
    n.data.summary = `${info.channels} ch, pre-skip ${info.preSkip}`;
  },
});

def('dac3', {
  name: 'AC-3 Specific Box',
  cat: 'codec',
  spec: 'ETSI AC-3',
  sec: 'F.4',
  desc: 'AC-3 (Dolby Digital) setup: sample rate, channel layout and bitrate.',
  syntax: 'class AC3SpecificBox extends Box(\'dac3\') {\n    unsigned int(2) fscod;\n    unsigned int(5) bsid;\n    unsigned int(3) bsmod;\n    unsigned int(3) acmod;\n    unsigned int(1) lfeon;\n    unsigned int(5) bit_rate_code;\n    unsigned int(5) reserved = 0;\n}',
  parse(r, n, ctx) {
    const info = parseDac3(r);
    attach(ctx, n, 'ac3', info);
    n.data.summary = `${info.layout}, ${fmtBitrate(info.bitrate)}`;
  },
});

def('dec3', {
  name: 'E-AC-3 Specific Box',
  cat: 'codec',
  spec: 'ETSI AC-3',
  sec: 'F.6',
  desc: 'E-AC-3 (Dolby Digital Plus) setup: data rate and the layout of each substream. Also flags Dolby Atmos (joint object coding).',
  parse(r, n, ctx) {
    const info = parseDec3(r);
    attach(ctx, n, 'ec3', info);
    n.data.summary = `${info.layout ?? ''}${info.atmos ? ', Atmos' : ''}, ${fmtBitrate(info.bitrate)}`;
  },
});

def('dfLa', {
  name: 'FLAC Specific Box',
  cat: 'codec',
  spec: 'FLAC',
  full: true,
  desc: 'FLAC decoder setup: the FLAC metadata blocks, starting with STREAMINFO (sample rate, channels, bit depth).',
  parse(r, n, ctx) {
    const info = parseFlacMetadata(r);
    attach(ctx, n, 'flac', info);
    n.data.summary = `${fmtHz(info.sampleRate)}, ${info.channels} ch, ${info.bitsPerSample}-bit`;
  },
});

// 'alac' is both the sample entry type and the name of its config box.
const ALAC_CONFIG = {
  name: 'ALAC Specific Box',
  cat: 'codec',
  spec: 'QT',
  full: true,
  desc: 'Apple Lossless decoder setup: frame length, bit depth, channels and sample rate.',
  parse(r, n, ctx) {
    const info = parseAlacConfig(r);
    attach(ctx, n, 'alac', info);
    n.data.summary = `${fmtHz(info.sampleRate)}, ${info.channels} ch, ${info.bitDepth}-bit`;
  },
};
export const CONFIG_IN_ENTRY = { alac: ALAC_CONFIG };

def('pasp', {
  name: 'Pixel Aspect Ratio Box',
  cat: 'codec',
  sec: '12.1.4',
  desc: 'The shape of each pixel. 1:1 means square pixels; anamorphic video (e.g. 1440×1080 shown as 16:9) uses other ratios.',
  parse(r, n, ctx) {
    const h = r.u32('hSpacing', { key: true, desc: 'Relative width of a pixel.' });
    const v = r.u32('vSpacing', { key: true, desc: 'Relative height of a pixel.' });
    if (ctx.entry) ctx.entry.pasp = [h, v];
    n.data.summary = `${h}:${v}${h === v ? ' (square pixels)' : ''}`;
  },
});

def('clap', {
  name: 'Clean Aperture Box',
  cat: 'codec',
  sec: '12.1.4',
  desc: 'The part of the picture meant to be shown, cutting off edges that may hold junk (common in broadcast video).',
  parse(r) {
    r.u32('cleanApertureWidthN');
    r.u32('cleanApertureWidthD');
    r.u32('cleanApertureHeightN');
    r.u32('cleanApertureHeightD');
    r.i32('horizOffN');
    r.u32('horizOffD');
    r.i32('vertOffN');
    r.u32('vertOffD');
  },
});

def('colr', {
  name: 'Colour Information Box',
  cat: 'codec',
  sec: '12.1.5',
  desc: 'How to interpret the pixel values as colours: primaries, transfer function and matrix (e.g. BT.709 for HD, BT.2020 + PQ for HDR10), or an ICC profile.',
  more: 'When this is missing or wrong, players guess (usually BT.709 for HD), which makes colours look washed out or too saturated.',
  syntax: 'class ColourInformationBox extends Box(\'colr\') {\n    unsigned int(32) colour_type;\n    if (colour_type == \'nclx\') {\n        unsigned int(16) colour_primaries;\n        unsigned int(16) transfer_characteristics;\n        unsigned int(16) matrix_coefficients;\n        unsigned int(1)  full_range_flag;\n        unsigned int(7)  reserved = 0;\n    }\n    else if (colour_type == \'rICC\') { ICC_profile; }\n    else if (colour_type == \'prof\') { ICC_profile; }\n}',
  parse(r, n, ctx) {
    const type = r.fourcc('colour_type', { key: true, enum: { nclx: 'on-screen colours (ISO/IEC 23091-2)', nclc: 'on-screen colours (QuickTime)', rICC: 'restricted ICC profile', prof: 'unrestricted ICC profile' } });
    if (type === 'nclx' || type === 'nclc') {
      const p = r.u16('colour_primaries', { key: true, enum: COLOUR_PRIMARIES });
      const t = r.u16('transfer_characteristics', { key: true, enum: TRANSFER_CHARACTERISTICS });
      const m = r.u16('matrix_coefficients', { key: true, enum: MATRIX_COEFFICIENTS });
      let full;
      if (type === 'nclx' && r.remaining) {
        full = r.flag('full_range_flag', { desc: '0 = limited (video) range, 1 = full range.' });
        r.bits(7, 'reserved', { reserved: true });
      }
      const info = { primaries: p, transfer: t, matrix: m, full };
      if (ctx.entry) ctx.entry.colr = info;
      n.data.config = info;
      n.data.summary = colourSummary(p, t, m) + (full ? ', full range' : '');
    } else if (r.remaining) {
      r.rest('ICC_profile', { desc: 'An embedded ICC colour profile.' });
      n.data.summary = 'ICC profile';
    }
  },
});

def('btrt', {
  name: 'Bit Rate Box',
  cat: 'codec',
  sec: '8.5.2.2',
  desc: 'The decoder buffer size and the maximum and average bitrate of the stream.',
  parse(r, n, ctx) {
    r.u32('bufferSizeDB', { unit: 'bytes' });
    const max = r.u32('maxBitrate', { display: (v) => `${fmtInt(v)} (${fmtBitrate(v)})` });
    const avg = r.u32('avgBitrate', { key: true, display: (v) => `${fmtInt(v)} (${fmtBitrate(v)})` });
    if (ctx.entry) ctx.entry.btrt = { max, avg };
    n.data.summary = `avg ${fmtBitrate(avg)}, max ${fmtBitrate(max)}`;
  },
});

def('fiel', {
  name: 'Field Handling',
  cat: 'codec',
  spec: 'QT',
  desc: 'Whether the video is progressive (1 field) or interlaced (2 fields), and in which order the fields come.',
  parse(r, n) {
    const f = r.u8('fields', { key: true, enum: { 1: 'progressive', 2: 'interlaced' } });
    r.u8('detail', { enum: { 0: 'progressive', 1: 'top field first', 6: 'bottom field first', 9: 'top field first (interleaved)', 14: 'bottom field first (interleaved)' } });
    n.data.summary = f === 2 ? 'interlaced' : 'progressive';
  },
});

def('gama', { name: 'Gamma Level', cat: 'codec', spec: 'QT', desc: 'The gamma the video was encoded with (QuickTime).', parse: (r) => r.fixed('gamma', 4, 16, { unsigned: true }) });

def('mdcv', {
  name: 'Mastering Display Colour Volume Box',
  cat: 'codec',
  desc: 'HDR metadata: the colour primaries and luminance range of the display the content was graded on.',
  parse(r, n) {
    const names = ['G', 'B', 'R'];
    for (let c = 0; c < 3; c++) {
      r.u16(`display_primaries_x[${c}] (${names[c]})`, { display: (v) => `${v} → ${fmtNum(v * 0.00002, 4)}` });
      r.u16(`display_primaries_y[${c}] (${names[c]})`, { display: (v) => `${v} → ${fmtNum(v * 0.00002, 4)}` });
    }
    r.u16('white_point_x', { display: (v) => `${v} → ${fmtNum(v * 0.00002, 4)}` });
    r.u16('white_point_y', { display: (v) => `${v} → ${fmtNum(v * 0.00002, 4)}` });
    const max = r.u32('max_display_mastering_luminance', { key: true, display: (v) => `${v} → ${fmtNum(v / 10000, 4)} cd/m²` });
    const min = r.u32('min_display_mastering_luminance', { display: (v) => `${v} → ${fmtNum(v / 10000, 4)} cd/m²` });
    n.data.summary = `${fmtNum(min / 10000, 4)}–${fmtNum(max / 10000, 0)} cd/m²`;
  },
});

def('clli', {
  name: 'Content Light Level Box',
  cat: 'codec',
  desc: 'HDR metadata: MaxCLL (the brightest pixel) and MaxFALL (the brightest average frame), in cd/m².',
  parse(r, n) {
    const a = r.u16('max_content_light_level', { key: true, unit: 'cd/m²' });
    const b = r.u16('max_pic_average_light_level', { key: true, unit: 'cd/m²' });
    n.data.summary = `MaxCLL ${a}, MaxFALL ${b}`;
  },
});

def('SmDm', {
  name: 'SMPTE 2086 Mastering Display Metadata',
  cat: 'codec',
  spec: 'VPxx',
  full: true,
  desc: 'HDR mastering display metadata in the VP9/WebM style (16.16 fixed point chromaticities).',
  parse(r) {
    for (const c of ['R', 'G', 'B']) {
      r.fixed(`primary${c}ChromaticityX`, 2, 16, { unsigned: true });
      r.fixed(`primary${c}ChromaticityY`, 2, 16, { unsigned: true });
    }
    r.fixed('whitePointChromaticityX', 2, 16, { unsigned: true });
    r.fixed('whitePointChromaticityY', 2, 16, { unsigned: true });
    r.fixed('luminanceMax', 4, 8, { unsigned: true, key: true });
    r.fixed('luminanceMin', 4, 14, { unsigned: true });
  },
});

def('CoLL', {
  name: 'Content Light Level (VP)',
  cat: 'codec',
  spec: 'VPxx',
  full: true,
  desc: 'MaxCLL and MaxFALL for VP9 HDR content.',
  parse(r) {
    r.u16('maxCLL', { key: true, unit: 'cd/m²' });
    r.u16('maxFALL', { key: true, unit: 'cd/m²' });
  },
});

function dolbyVision(r, n, ctx) {
  r.u8('dv_version_major');
  r.u8('dv_version_minor');
  const profile = r.bits(7, 'dv_profile', { key: true, desc: 'Dolby Vision profile, e.g. 5 (single layer, IPT), 8.1 (HDR10-compatible base layer).' });
  const level = r.bits(6, 'dv_level', { key: true });
  r.flag('rpu_present_flag', { desc: 'Reference processing unit: the dynamic metadata.' });
  r.flag('el_present_flag', { desc: 'An enhancement layer is present.' });
  r.flag('bl_present_flag', { desc: 'A base layer is present.' });
  const compat = r.bits(4, 'dv_bl_signal_compatibility_id', { enum: { 0: 'none', 1: 'HDR10', 2: 'SDR', 4: 'HLG', 6: 'Ultra HD Blu-ray' } });
  r.bits(28, 'reserved', { reserved: true });
  if (r.remaining) r.rest('reserved', { reserved: true });
  if (ctx.entry) ctx.entry.dolbyVision = { profile, level, compat };
  n.data.summary = `profile ${profile}${compat ? `.${compat}` : ''}, level ${level}`;
}

def('dvcC', { name: 'Dolby Vision Configuration', cat: 'codec', spec: 'Dolby Vision', desc: 'Dolby Vision setup: profile, level and which layers (base, enhancement, metadata) are present.', parse: dolbyVision });
def('dvvC', { name: 'Dolby Vision Configuration (profile 8+)', cat: 'codec', spec: 'Dolby Vision', desc: 'Dolby Vision setup for profiles above 7.', parse: dolbyVision });
def('dvwC', { name: 'Dolby Vision Configuration (profile 10+)', cat: 'codec', spec: 'Dolby Vision', desc: 'Dolby Vision setup for AV1-based profiles.', parse: dolbyVision });

def('chan', {
  name: 'Audio Channel Layout',
  cat: 'codec',
  spec: 'QT',
  full: true,
  desc: 'Which speaker each audio channel feeds (Core Audio channel layout).',
  parse(r) {
    r.u32('mChannelLayoutTag', { display: (v) => `0x${v.toString(16)} (layout ${v >>> 16}, ${v & 0xffff} channels)` });
    r.u32('mChannelBitmap');
    const n = r.u32('mNumberChannelDescriptions');
    r.table('descriptions', n, 20, [
      { name: 'mChannelLabel', type: 'u32' },
      { name: 'mChannelFlags', type: 'u32' },
      { name: 'mCoordinates[0]', type: 'f32' },
      { name: 'mCoordinates[1]', type: 'f32' },
      { name: 'mCoordinates[2]', type: 'f32' },
    ]);
  },
});

def('wave', {
  name: 'Sound Decompression Parameters',
  cat: 'codec',
  spec: 'QT',
  container: true,
  desc: 'QuickTime container for audio codec settings (frma, esds, enda...). It ends with an 8-byte terminator box.',
});

def('enda', {
  name: 'Endianness',
  cat: 'codec',
  spec: 'QT',
  desc: 'Byte order of PCM samples: 1 = little-endian.',
  parse: (r) => r.u16('littleEndian', { enum: { 0: 'big-endian', 1: 'little-endian' } }),
});

def('srat', {
  name: 'Sampling Rate Box',
  cat: 'codec',
  full: true,
  sec: '12.2.3',
  desc: 'The real sample rate when it does not fit the 16-bit samplerate field of the audio sample entry.',
  parse: (r) => r.u32('sampling_rate', { key: true, unit: 'Hz' }),
});

def('damr', {
  name: 'AMR Specific Box',
  cat: 'codec',
  spec: '3GPP',
  desc: 'AMR decoder setup: encoder vendor, allowed modes and frames per sample.',
  parse(r) {
    r.fourcc('vendor');
    r.u8('decoder_version');
    r.u16('mode_set', { display: (v) => `0x${v.toString(16)}` });
    r.u8('mode_change_period');
    r.u8('frames_per_sample');
  },
});

def('st3d', {
  name: 'Stereoscopic 3D Video Box',
  cat: 'codec',
  spec: 'Spherical V2',
  full: true,
  desc: 'How the two eyes of stereoscopic video are packed into each frame.',
  parse: (r) => r.u8('stereo_mode', { key: true, enum: { 0: 'monoscopic', 1: 'top-bottom', 2: 'left-right', 3: 'stereo custom' } }),
});

def('sv3d', { name: 'Spherical Video Box', cat: 'codec', spec: 'Spherical V2', container: true, desc: '360° video: the projection used to map the sphere onto the frame.' });
def('svhd', { name: 'Spherical Video Header', cat: 'codec', spec: 'Spherical V2', full: true, desc: 'Name of the tool that wrote the spherical metadata.', parse: (r) => r.cstr('metadata_source') });
def('proj', { name: 'Projection Box', cat: 'codec', spec: 'Spherical V2', container: true, desc: 'The spherical projection (equirectangular, cubemap...) and its pose.' });
def('prhd', {
  name: 'Projection Header',
  cat: 'codec',
  spec: 'Spherical V2',
  full: true,
  desc: 'Initial viewing direction: yaw, pitch and roll.',
  parse(r) {
    r.fixed('pose_yaw_degrees', 4, 16);
    r.fixed('pose_pitch_degrees', 4, 16);
    r.fixed('pose_roll_degrees', 4, 16);
  },
});
def('equi', { name: 'Equirectangular Projection', cat: 'codec', spec: 'Spherical V2', full: true, desc: 'Equirectangular 360° projection, with optional cropping bounds.' });
def('cbmp', { name: 'Cubemap Projection', cat: 'codec', spec: 'Spherical V2', full: true, desc: 'Cubemap 360° projection.' });

def('vttC', { name: 'WebVTT Configuration', cat: 'codec', spec: 'ISO-Text', desc: 'The WebVTT file header (the "WEBVTT" line and any style blocks).', parse: (r, n) => { n.data.summary = r.str('config', r.remaining, { key: true }); } });
def('vlab', { name: 'WebVTT Source Label', cat: 'codec', spec: 'ISO-Text', desc: 'A label identifying the source of the WebVTT text.', parse: (r) => r.str('source_label', r.remaining) });
def('ftab', {
  name: 'Font Table Box',
  cat: 'codec',
  spec: '3GPP',
  desc: 'Fonts that 3GPP timed-text samples can refer to by ID.',
  parse(r) {
    const n = r.u16('entry_count');
    for (let i = 0; i < n && r.remaining > 2; i++) {
      r.group(`font[${i}]`, () => {
        r.u16('font-ID');
        r.pstr('font');
      });
    }
  },
});

export function entryKind(type) {
  if (VISUAL.has(type)) return 'video';
  if (AUDIO.has(type)) return 'audio';
  return null;
}

export { codecFamily, ratio };
