// FLV tags. Every tag is an 11-byte header (type, data size, timestamp,
// stream ID), the tag data, then a 4-byte PreviousTagSize. The data of audio
// and video tags starts with a small codec header; script tags hold AMF0 values.
// References: Adobe Flash Video File Format Specification v10.1 (Annex E),
// Enhanced RTMP (veovera/enhanced-rtmp) for the FourCC ex-headers.

import { Node } from '../../core/model.js';
import { FieldReader, ParseError } from '../../core/fields.js';
import { fmtInt, fmtDuration, fmtHz } from '../../core/util.js';
import { parseAvcC, profileName as avcProfile, levelName as avcLevel } from '../../codecs/h264.js';
import { parseHvcC, PROFILES as HEVC_PROFILES, levelName as hevcLevel } from '../../codecs/h265.js';
import { parseAv1C } from '../../codecs/av1.js';
import { parseVpcC } from '../../codecs/vp9.js';
import { parseAudioSpecificConfig, aacName, CHANNEL_CONFIG } from '../../codecs/mpeg4audio.js';
import { parseOpusHead } from '../../codecs/audio.js';
import { readAmf } from './amf.js';
import { channelMaskText } from '../riff/tables.js';

export const SPEC = { specTitle: 'Adobe Flash Video File Format Specification, version 10.1 (Annex E: FLV)', specHref: null };
export const SPEC_ERTMP = { specTitle: 'Enhanced RTMP (Veovera Software Organization)', specHref: 'https://github.com/veovera/enhanced-rtmp' };

export const TAG_TYPES = { 8: 'audio', 9: 'video', 18: 'script data' };

export const SOUND_FORMATS = {
  0: 'Linear PCM, platform endian', 1: 'ADPCM', 2: 'MP3', 3: 'Linear PCM, little endian', 4: 'Nellymoser 16 kHz mono',
  5: 'Nellymoser 8 kHz mono', 6: 'Nellymoser', 7: 'G.711 A-law', 8: 'G.711 µ-law', 9: 'ExHeader (Enhanced RTMP)',
  10: 'AAC', 11: 'Speex', 14: 'MP3 8 kHz', 15: 'device-specific sound',
};
const SOUND_RATES = { 0: '5.5 kHz', 1: '11 kHz', 2: '22 kHz', 3: '44 kHz' };
export const FRAME_TYPES = {
  1: 'key frame (seekable)', 2: 'inter frame (non-seekable)', 3: 'disposable inter frame (H.263 only)',
  4: 'generated key frame (server use only)', 5: 'video info / command frame',
};
export const CODEC_IDS = {
  1: 'JPEG (unused)', 2: 'Sorenson H.263', 3: 'Screen video', 4: 'On2 VP6', 5: 'On2 VP6 with alpha channel',
  6: 'Screen video version 2', 7: 'AVC (H.264)', 12: 'HEVC (non-standard CodecID used by some CDNs)',
};
const AVC_PACKET = { 0: 'AVC sequence header', 1: 'AVC NALU (a frame)', 2: 'AVC end of sequence' };
const AAC_PACKET = { 0: 'AAC sequence header', 1: 'AAC raw (a frame)' };
export const VIDEO_PACKET = {
  0: 'SequenceStart (decoder configuration)', 1: 'CodedFrames', 2: 'SequenceEnd', 3: 'CodedFramesX (no composition time)',
  4: 'Metadata (AMF)', 5: 'MPEG2TSSequenceStart', 6: 'Multitrack', 7: 'ModEx',
};
export const AUDIO_PACKET = { 0: 'SequenceStart', 1: 'CodedFrames', 2: 'SequenceEnd', 4: 'MultichannelConfig', 5: 'Multitrack', 7: 'ModEx' };
export const VIDEO_FOURCC = { avc1: 'H.264 / AVC', hvc1: 'H.265 / HEVC', av01: 'AV1', vp09: 'VP9', vp08: 'VP8', vvc1: 'H.266 / VVC' };
export const AUDIO_FOURCC = { Opus: 'Opus', fLaC: 'FLAC', 'ac-3': 'AC-3', 'ec-3': 'E-AC-3', '.mp3': 'MP3', mp4a: 'AAC' };

const VIDEO_FAMILY = { avc1: 'avc', hvc1: 'hevc', av01: 'av1', vp09: 'vp9', vp08: 'vp8' };
const AUDIO_FAMILY = { Opus: 'opus', mp4a: 'aac', '.mp3': 'mp3', 'ac-3': 'ac3' };
const LEGACY_VIDEO = { 7: 'avc', 12: 'hevc' };
const LEGACY_AUDIO = { 2: 'mp3', 14: 'mp3', 10: 'aac' };

export const i24 = (u8, p) => {
  const v = (u8[p] << 16) | (u8[p + 1] << 8) | u8[p + 2];
  return v & 0x800000 ? v - 0x1000000 : v;
};

const fcc = (u8, p) => String.fromCharCode(u8[p], u8[p + 1], u8[p + 2], u8[p + 3]);

/**
 * What the first bytes of a tag's data say (used by the scan and by the tree).
 * `p` indexes the first data byte in u8; `n` = data bytes available there.
 */
export function codecHeader(type, u8, p, n, dataSize) {
  const h = { type, headerLen: 0, isFrame: false, key: false, cts: 0 };
  if (type === 18) {
    h.kind = 'script';
    return h;
  }
  if (n < 1 || dataSize < 1) {
    h.kind = type === 9 ? 'video' : type === 8 ? 'audio' : 'other';
    h.empty = true;
    return h;
  }
  const b = u8[p];
  if (type === 9) {
    h.kind = 'video';
    if (b & 0x80) {
      h.enhanced = true;
      h.frameType = (b >> 4) & 7;
      h.packetType = b & 15;
      h.fourcc = n >= 5 ? fcc(u8, p + 1) : '????';
      h.family = VIDEO_FAMILY[h.fourcc] ?? null;
      h.codec = h.fourcc;
      h.headerLen = 5;
      const pt = h.packetType;
      if (pt === 1 && (h.fourcc === 'avc1' || h.fourcc === 'hvc1')) {
        h.headerLen = 8;
        h.cts = n >= 8 ? i24(u8, p + 5) : 0;
        h.hasCts = true;
      }
      h.isFrame = (pt === 1 || pt === 3) && h.frameType !== 5;
      h.isConfig = pt === 0 || pt === 5;
      h.isEnd = pt === 2;
      h.isMeta = pt === 4;
      h.unsupported = pt === 6 || pt === 7;
    } else {
      h.frameType = b >> 4;
      h.codecId = b & 15;
      h.family = LEGACY_VIDEO[h.codecId] ?? null;
      h.codec = `codec ${h.codecId}`;
      if (h.frameType === 5) {
        h.headerLen = 1;
        h.command = true;
      } else if (h.codecId === 7 || h.codecId === 12) {
        h.packetType = n >= 2 ? u8[p + 1] : 1;
        h.cts = n >= 5 ? i24(u8, p + 2) : 0;
        h.hasCts = true;
        h.headerLen = 5;
        h.isFrame = h.packetType === 1;
        h.isConfig = h.packetType === 0;
        h.isEnd = h.packetType === 2;
      } else if (h.codecId === 4 || h.codecId === 5) {
        h.headerLen = 2;
        h.isFrame = true;
      } else {
        h.headerLen = 1;
        h.isFrame = true;
      }
    }
    h.key = h.frameType === 1;
  } else if (type === 8) {
    h.kind = 'audio';
    h.soundFormat = b >> 4;
    h.key = true;
    if (h.soundFormat === 9) {
      h.enhanced = true;
      h.packetType = b & 15;
      h.fourcc = n >= 5 ? fcc(u8, p + 1) : '????';
      h.family = AUDIO_FAMILY[h.fourcc] ?? null;
      h.codec = h.fourcc;
      h.headerLen = 5;
      h.isFrame = h.packetType === 1;
      h.isConfig = h.packetType === 0;
      h.isEnd = h.packetType === 2;
      h.isMeta = h.packetType === 4;
      h.unsupported = h.packetType === 5 || h.packetType === 7;
    } else {
      h.family = LEGACY_AUDIO[h.soundFormat] ?? null;
      h.codec = `format ${h.soundFormat}`;
      h.rate = (b >> 2) & 3;
      h.size16 = (b >> 1) & 1;
      h.stereo = b & 1;
      if (h.soundFormat === 10) {
        h.packetType = n >= 2 ? u8[p + 1] : 1;
        h.headerLen = 2;
        h.isFrame = h.packetType === 1;
        h.isConfig = h.packetType === 0;
      } else {
        h.headerLen = 1;
        h.isFrame = true;
      }
    }
  } else {
    h.kind = 'other';
  }
  if (h.isFrame && dataSize <= h.headerLen) {
    h.isFrame = false;
    h.empty = true;
  }
  return h;
}

/** Short codec name for a codec header. */
export function codecName(h) {
  if (h.kind === 'video') {
    if (h.enhanced) return VIDEO_FOURCC[h.fourcc] ?? `'${h.fourcc}'`;
    return CODEC_IDS[h.codecId] ?? `CodecID ${h.codecId}`;
  }
  if (h.kind === 'audio') {
    if (h.enhanced) return AUDIO_FOURCC[h.fourcc] ?? `'${h.fourcc}'`;
    return SOUND_FORMATS[h.soundFormat] ?? `SoundFormat ${h.soundFormat}`;
  }
  return 'script';
}

// ------------------------------------------------------------ definitions shown in the inspector

const TAG_MORE = 'Tags follow each other in decoding order, audio and video interleaved by time. The 11-byte header gives the tag type, the size of its data and a millisecond timestamp (24 bits plus an 8-bit extension). After the data comes PreviousTagSize, the size of the tag that just ended (11 + DataSize), so a reader can also walk the file backwards and check that it is still in sync.';

export const DEFS = {
  header: {
    ...SPEC,
    name: 'FLV header',
    cat: 'type',
    desc: 'The file header: the signature "FLV", the version (1), flags saying whether audio and video tags are present, and the size of the header.',
    more: 'The two flags are only hints written by the muxer; players still discover the streams from the tags themselves. DataOffset is 9 for version 1: the body starts right after the header with PreviousTagSize0.',
  },
  pts0: {
    ...SPEC,
    name: 'PreviousTagSize0',
    cat: 'header',
    desc: 'Always 0: the "size of the previous tag" before the first tag. The body of an FLV file is PreviousTagSize0, then tag 1, PreviousTagSize1, tag 2, PreviousTagSize2...',
  },
  script: {
    ...SPEC,
    name: 'Script data tag',
    cat: 'meta',
    desc: 'A script tag: values encoded in AMF0, the serialisation format of ActionScript. The first tag of almost every FLV is onMetaData, with the duration, picture size, codecs and bitrates of the file.',
    more: 'Players read onMetaData before playing: Flash used duration for the progress bar, width and height to size the player, and a keyframes object (when a tool added one) to seek in a progressive download. The values are written by the muxer and nothing checks them, so they can disagree with the stream; the File Insights tab compares them with the tags. Other script tags (onCuePoint, onTextData, onFI...) carry cue points, captions or timecode.',
  },
  video: {
    ...SPEC,
    name: 'Video tag',
    cat: 'media',
    desc: 'A video tag: one compressed video frame, preceded by a small header with the frame type (key or inter frame) and the codec.',
    more: `${TAG_MORE} For AVC the header also has AVCPacketType and CompositionTime (the presentation-time offset needed for B-frames), and the NAL units that follow are length-prefixed as in MP4, not start-coded as in a raw H.264 stream. Enhanced RTMP (2023) sets the top bit of the first byte (IsExHeader) and names the codec with a FourCC (hvc1, av01, vp09...), which is how FLV carries HEVC, AV1 and VP9.`,
  },
  videoConfig: {
    ...SPEC,
    name: 'Video tag: decoder configuration',
    cat: 'codec',
    desc: 'The decoder configuration of the video stream (for AVC the AVCDecoderConfigurationRecord with the SPS and PPS; for Enhanced RTMP codecs the hvcC, av1C or vpcC record). It has no picture and must come before the first frame.',
    more: 'This is the same record as the codec configuration box of an MP4 file (avcC, hvcC...). An encoder sends a new one when its parameters change, for example when a live stream switches resolution; frames after it are decoded with the new configuration.',
  },
  videoEnd: {
    ...SPEC,
    name: 'Video tag: end of sequence',
    cat: 'codec',
    desc: 'Marks the end of the video sequence (AVC end of sequence / Enhanced RTMP SequenceEnd). It carries no picture; FFmpeg writes one at the end of AVC files.',
  },
  videoMeta: {
    ...SPEC_ERTMP,
    name: 'Video tag: metadata',
    cat: 'meta',
    desc: 'Enhanced RTMP video metadata (PacketType 4): AMF-encoded values that describe the video, such as colorInfo (colour primaries, transfer characteristics, HDR mastering data).',
  },
  videoCommand: {
    ...SPEC,
    name: 'Video tag: command frame',
    cat: 'meta',
    desc: 'A video info / command frame (FrameType 5): no picture, just a one-byte command used by servers around client-side seeking.',
  },
  audio: {
    ...SPEC,
    name: 'Audio tag',
    cat: 'media',
    desc: 'An audio tag: compressed audio (one AAC frame, or one or more MP3 frames), preceded by a one-byte header with the codec (SoundFormat), sample rate, sample size and channels.',
    more: `${TAG_MORE} For AAC the rate/size/channel bits are fixed (44 kHz, 16-bit, stereo) and meaningless: the real configuration is the AudioSpecificConfig sent once in an AAC sequence header (AACPacketType 0). Enhanced RTMP uses SoundFormat 9 to announce an extended header with a FourCC (Opus, fLaC, ac-3, ec-3, mp4a).`,
  },
  audioConfig: {
    ...SPEC,
    name: 'Audio tag: decoder configuration',
    cat: 'codec',
    desc: 'The decoder configuration of the audio stream: for AAC the AudioSpecificConfig (profile, sample rate, channels); for Enhanced RTMP Opus the OpusHead. It carries no sound and must come before the first frame.',
  },
  audioMeta: {
    ...SPEC_ERTMP,
    name: 'Audio tag: multichannel configuration',
    cat: 'meta',
    desc: 'Enhanced RTMP MultichannelConfig: the channel count and the speaker layout (channel order and mask) of the audio.',
  },
  other: {
    ...SPEC,
    name: 'Unknown tag',
    cat: 'unknown',
    desc: 'A tag type the FLV specification does not define (only 8 audio, 9 video and 18 script data exist). It may be damage, or a private extension; players skip it using DataSize.',
  },
};

function tagDef(h) {
  if (h.kind === 'script') return DEFS.script;
  if (h.kind === 'video') {
    if (h.isConfig) return DEFS.videoConfig;
    if (h.isEnd) return DEFS.videoEnd;
    if (h.isMeta) return DEFS.videoMeta;
    if (h.command) return DEFS.videoCommand;
    return h.enhanced ? { ...DEFS.video, ...SPEC_ERTMP } : DEFS.video;
  }
  if (h.kind === 'audio') {
    if (h.isConfig) return DEFS.audioConfig;
    if (h.isMeta) return DEFS.audioMeta;
    return h.enhanced ? { ...DEFS.audio, ...SPEC_ERTMP } : DEFS.audio;
  }
  return DEFS.other;
}

// ------------------------------------------------------------ fields

function msDisplay(v) {
  return `${fmtInt(v)} ms (${fmtDuration(v / 1000)})`;
}

function tagHeaderFields(r) {
  r.bits(2, 'Reserved', { role: 'header', reserved: true, desc: 'Reserved for Flash Media Server; 0 in files.' });
  const filter = r.flag('Filter', { role: 'header', desc: '1 = the tag is encrypted (an EncryptionHeader and FilterParams come before the data). 0 in practically every file.' });
  const type = r.bits(5, 'TagType', { role: 'header', key: true, enum: TAG_TYPES, desc: '8 = audio, 9 = video, 18 = script data (AMF0).' });
  const dataSize = r.u24('DataSize', {
    role: 'header',
    key: true,
    unit: 'bytes',
    desc: 'Length of the tag data after this 11-byte header. The whole tag is 11 + DataSize bytes, and the PreviousTagSize after it must repeat that number.',
  });
  const ts24 = r.u24('Timestamp', {
    role: 'header',
    key: true,
    display: msDisplay,
    desc: 'Time of the tag in milliseconds (lower 24 bits). For video this is the decoding time; with B-frames the presentation time adds CompositionTime.',
  });
  const ext = r.u8('TimestampExtended', {
    role: 'header',
    desc: 'The upper 8 bits of the timestamp. Together they form a signed 32-bit millisecond value; 24 bits alone wrap after 4 h 39 min.',
  });
  const ts = ((ext << 24) | ts24) | 0;
  if (ext) r.out[r.out.length - 1].note = `timestamp = ${ext} × 2^24 + ${fmtInt(ts24)} = ${msDisplay(ts)}`;
  r.u24('StreamID', { role: 'header', expect: 0, desc: 'Always 0 in FLV files (it comes from RTMP message stream IDs).' });
  return { filter, type, dataSize, ts };
}

function videoHeaderFields(r, h) {
  if (h.enhanced) {
    r.group('VideoTagHeader', (g) => {
      r.flag('IsExHeader', { desc: 'Enhanced RTMP: 1 = an extended header follows with a FourCC instead of the 4-bit CodecID.' });
      r.bits(3, 'FrameType', { key: true, enum: FRAME_TYPES, desc: '1 = key frame: decoding can start here. 2 = inter frame. 5 = command / metadata.' });
      r.bits(4, 'PacketType', { key: true, enum: VIDEO_PACKET, desc: 'What the data is: the decoder configuration, coded frames, the end of the sequence, or metadata.' });
      r.fourcc('VideoFourCc', { key: true, display: (v) => `'${v}' — ${VIDEO_FOURCC[v] ?? 'unknown'}`, desc: 'The codec, as the same FourCC MP4 uses (hvc1, av01, vp09, avc1).' });
      if (h.hasCts) {
        r.i24('CompositionTime', { key: true, unit: 'ms', desc: 'Presentation time minus decoding time, in milliseconds (non-zero with B-frames).' });
      }
      g.display = `${VIDEO_FOURCC[h.fourcc] ?? h.fourcc}, ${VIDEO_PACKET[h.packetType] ?? h.packetType}${h.frameType === 1 ? ', key frame' : ''}`;
    }, { desc: 'The Enhanced RTMP extended video header.' });
    return;
  }
  r.group('VideoTagHeader', (g) => {
    r.bits(4, 'FrameType', { key: true, enum: FRAME_TYPES, desc: '1 = key frame (a player can start decoding or seek here), 2 = inter frame, 5 = video info / command frame.' });
    r.bits(4, 'CodecID', { key: true, enum: CODEC_IDS, desc: 'The codec: 2 = Sorenson H.263, 4 = VP6, 7 = AVC (H.264).' });
    if (h.command) {
      r.u8('VideoCommand', { enum: { 0: 'start of client-side seeking video frame sequence', 1: 'end of client-side seeking video frame sequence' } });
    } else if (h.codecId === 7 || h.codecId === 12) {
      r.u8('AVCPacketType', { key: true, enum: AVC_PACKET, desc: '0 = the decoder configuration (AVCDecoderConfigurationRecord), 1 = NAL units of a frame, 2 = end of sequence.' });
      r.i24('CompositionTime', { key: true, unit: 'ms', desc: 'Presentation time minus decoding time in milliseconds (the MP4 ctts offset). Non-zero when B-frames reorder the pictures; 0 for configuration tags.' });
    } else if (h.codecId === 4 || h.codecId === 5) {
      r.bits(4, 'HorizontalAdjustment', { desc: 'VP6: pixels to crop from the right of the decoded picture.' });
      r.bits(4, 'VerticalAdjustment', { desc: 'VP6: pixels to crop from the bottom.' });
    }
    g.display = `${CODEC_IDS[h.codecId] ?? `CodecID ${h.codecId}`}, ${FRAME_TYPES[h.frameType] ?? `FrameType ${h.frameType}`}${h.packetType !== undefined && (h.codecId === 7 || h.codecId === 12) ? `, ${AVC_PACKET[h.packetType] ?? h.packetType}` : ''}`;
  }, { desc: 'The video tag header: frame type and codec, plus AVC packet type and composition time for H.264.' });
}

function audioHeaderFields(r, h) {
  r.group('AudioTagHeader', (g) => {
    r.bits(4, 'SoundFormat', { key: true, enum: SOUND_FORMATS, desc: 'The codec: 2 = MP3, 10 = AAC, 9 = Enhanced RTMP extended header.' });
    if (h.enhanced) {
      r.bits(4, 'AudioPacketType', { key: true, enum: AUDIO_PACKET });
      r.fourcc('AudioFourCc', { key: true, display: (v) => `'${v}' — ${AUDIO_FOURCC[v] ?? 'unknown'}` });
      g.display = `${AUDIO_FOURCC[h.fourcc] ?? h.fourcc}, ${AUDIO_PACKET[h.packetType] ?? h.packetType}`;
      return;
    }
    r.bits(2, 'SoundRate', { enum: SOUND_RATES, desc: h.soundFormat === 10 ? 'Always 3 (44 kHz) for AAC; the real rate is in the AudioSpecificConfig.' : 'Sample rate (only four values can be expressed; 48 kHz audio cannot be described here).' });
    r.flag('SoundSize', { enum: { 0: '8-bit', 1: '16-bit' }, desc: 'Bits per sample of the decoded audio.' });
    r.flag('SoundType', { enum: { 0: 'mono', 1: 'stereo' }, desc: h.soundFormat === 10 ? 'Always 1 for AAC; the channel count is in the AudioSpecificConfig.' : 'Mono or stereo.' });
    if (h.soundFormat === 10) r.u8('AACPacketType', { key: true, enum: AAC_PACKET, desc: '0 = AudioSpecificConfig (sent once), 1 = one raw AAC frame.' });
    g.display = `${SOUND_FORMATS[h.soundFormat] ?? h.soundFormat}${h.soundFormat === 10 ? `, ${AAC_PACKET[h.packetType] ?? h.packetType}` : `, ${SOUND_RATES[h.rate]}, ${h.size16 ? 16 : 8}-bit, ${h.stereo ? 'stereo' : 'mono'}`}`;
  }, { desc: 'The audio tag header: codec, sample rate, sample size and channels (plus AACPacketType for AAC).' });
}

/** Decoder configuration inside a config tag. Returns {family, lengthSize?, state?, info, summary}. */
function configFields(r, h) {
  const cfg = { family: h.family };
  const n = r.remaining;
  if (n <= 0) return cfg;
  // Where the record's bytes are, for a decoder (WebCodecs wants the avcC/hvcC/av1C bytes).
  cfg.record = [r.abs, r.abs + n];
  try {
    if (h.kind === 'video') {
      if (h.family === 'avc') {
        r.group('AVCDecoderConfigurationRecord', (g) => {
          const a = parseAvcC(r, 'avc1');
          cfg.lengthSize = a.lengthSize;
          cfg.state = { spsById: new Map(a.spsById), ppsById: new Map(a.ppsById) };
          cfg.sps = a.sps[0];
          cfg.codecString = a.codec;
          cfg.profile = `${avcProfile(a.profile, a.compat)}@L${avcLevel(a.level, a.compat, a.profile)}`;
          g.display = a.sps[0]?.summary ?? cfg.profile;
          cfg.summary = g.display;
        }, { desc: 'The AVC decoder configuration record (the same structure as the avcC box in MP4): profile, level, NAL length size, SPS and PPS.' });
      } else if (h.family === 'hevc') {
        r.group('HEVCDecoderConfigurationRecord', (g) => {
          const a = parseHvcC(r, 'hvc1');
          cfg.lengthSize = a.lengthSize;
          cfg.state = { spsById: new Map(a.spsById), ppsById: new Map(a.ppsById) };
          cfg.sps = a.sps[0];
          cfg.codecString = a.codec;
          cfg.profile = `${HEVC_PROFILES[a.profile_idc] ?? a.profile_idc}@L${hevcLevel(a.level_idc)}${a.tier ? ' High' : ''}`;
          g.display = a.sps[0]?.summary ?? cfg.profile;
          cfg.summary = g.display;
        }, { desc: 'The HEVC decoder configuration record (as in an MP4 hvcC box): profile, tier, level, NAL length size, VPS, SPS and PPS.' });
      } else if (h.family === 'av1') {
        r.group('AV1CodecConfigurationRecord', (g) => {
          const a = parseAv1C(r);
          cfg.state = { seq: a.seq };
          cfg.codecString = a.codec;
          cfg.profile = `profile ${a.seq_profile}`;
          g.display = a.codec;
          cfg.summary = a.codec;
        }, { desc: 'The AV1 codec configuration record (as in an MP4 av1C box), usually with the sequence header OBU.' });
      } else if (h.family === 'vp9' || h.family === 'vp8') {
        r.group('VPCodecConfigurationRecord', (g) => {
          if (r.remaining >= 12 && r.u[r.pos] === 1 && r.u[r.pos + 1] === 0 && r.u[r.pos + 2] === 0 && r.u[r.pos + 3] === 0) {
            r.u8('version', { desc: 'FullBox version, as in the MP4 vpcC box (FFmpeg writes the box payload).' });
            r.u24('flags');
          }
          const a = parseVpcC(r, h.fourcc);
          cfg.codecString = a.codec;
          cfg.profile = `profile ${a.profile}`;
          g.display = a.codec;
          cfg.summary = a.codec;
        }, { desc: 'The VP codec configuration record (as in an MP4 vpcC box): profile, level, bit depth and colour.' });
      }
    } else if (h.kind === 'audio') {
      if (h.family === 'aac') {
        r.group('AudioSpecificConfig', (g) => {
          try {
            const a = parseAudioSpecificConfig(r);
            cfg.asc = a;
            cfg.codecString = `mp4a.40.${a.firstAot}`;
            cfg.profile = aacName(a);
            g.display = `${aacName(a)}, ${fmtHz(a.extSampleRate || a.sampleRate)}, ${CHANNEL_CONFIG[a.channelConfig] ?? a.channelConfig}`;
            cfg.summary = g.display;
          } finally {
            if (r.bit) r.align('padding');
          }
        }, { desc: 'The MPEG-4 AudioSpecificConfig: AAC profile (object type), sample rate and channel configuration.' });
      } else if (h.family === 'opus') {
        r.group('OpusHead', (g) => {
          const a = parseOpusHead(r);
          cfg.opus = a;
          g.display = `${a.channels} channel${a.channels === 1 ? '' : 's'}, pre-skip ${a.preSkip}`;
          cfg.summary = `Opus, ${g.display}`;
        }, { desc: 'The Opus identification header (as in Ogg and Matroska): channel count, pre-skip and input sample rate.' });
      }
    }
  } catch (e) {
    if (!(e instanceof ParseError)) throw e;
    cfg.error = e.message;
  }
  if (r.remaining > 0 && r.bit === 0) r.rest('configuration data', { desc: 'Configuration bytes Vidscope does not decode for this codec.' });
  return cfg;
}

function multichannelFields(r) {
  const order = r.u8('AudioChannelOrder', { enum: { 0: 'Unspecified', 1: 'Native (speaker mask)', 2: 'Custom (explicit mapping)' } });
  const n = r.u8('channelCount');
  if (order === 1 && r.remaining >= 4) {
    r.u32('AudioChannelMask', { display: (m) => `0x${(m >>> 0).toString(16).padStart(8, '0')} → ${channelMaskText(m)}`, desc: 'One bit per speaker position; the low bits follow the same order as the WAVE channel mask (FL, FR, FC, LFE...).' });
  } else if (order === 2) {
    r.bytes('AudioChannelMapping', Math.min(n, r.remaining), { desc: 'The speaker of each channel, one byte per channel.' });
  }
}

/**
 * Parse the tag at u8[pos] (the buffer must hold at least the 11-byte header)
 * into a Node under `parent`. `prev` is the PreviousTagSize value when the
 * buffer does not contain it (from the scan). Returns {node, h, ts, config?, meta?}.
 */
export function tagNode(ctx, parent, u8, base, pos, bufEnd, extra = {}) {
  const abs = base + pos;
  const fields = [];
  const r = new FieldReader(u8, base, { start: pos, end: bufEnd, out: fields });
  const th = tagHeaderFields(r);
  const dataStart = pos + 11;
  const dataEnd = Math.min(bufEnd, dataStart + th.dataSize);
  const fileEnd = ctx.source.size;
  const h = codecHeader(th.type, u8, dataStart, dataEnd - dataStart, th.dataSize);
  h.filter = th.filter;
  const out = { h, ts: th.ts };
  const tagEnd = abs + 11 + th.dataSize;
  const hasPts = tagEnd + 4 <= fileEnd;
  const node = new Node({
    type: th.type === 9 ? 'video' : th.type === 8 ? 'audio' : th.type === 18 ? 'script' : `tag ${th.type}`,
    kind: 'tag',
    offset: abs,
    size: Math.min(fileEnd, tagEnd + (hasPts ? 4 : 0)) - abs,
    headerSize: 11,
  });
  const def = tagDef(h);
  node.def = def;
  node.name = def.name;
  node.category = def.cat;
  node.fields = fields;
  node.data.ts = th.ts;
  node.data.h = h;
  if (tagEnd > fileEnd) node.warn(`DataSize says ${fmtInt(th.dataSize)} bytes but the file ends ${fmtInt(tagEnd - fileEnd)} bytes earlier: the file is truncated.`);
  r.end = dataEnd;
  try {
    if (th.filter) {
      node.warn('This tag is encrypted (Filter = 1); its data is not decoded.');
    } else if (h.kind === 'video' && !h.empty) {
      videoHeaderFields(r, h);
      if (h.isConfig) out.config = configFields(r, h);
      else if (h.isMeta) {
        const name = readAmf(r, 'name');
        out.meta = { name, value: r.remaining > 0 ? readAmf(r, 'value') : null };
      } else if (h.command && r.remaining > 0) r.rest('command data');
    } else if (h.kind === 'audio' && !h.empty) {
      audioHeaderFields(r, h);
      if (h.isConfig) out.config = configFields(r, h);
      else if (h.isMeta && h.packetType === 4) multichannelFields(r);
    } else if (h.kind === 'script') {
      const name = readAmf(r, 'name', { desc: 'The name of the script call, usually "onMetaData".' });
      let value = null;
      const values = [];
      while (r.remaining > 0) {
        if (r.remaining < 3 && r.u.subarray(r.pos, r.end).every((b) => b === 0)) break;
        values.push(readAmf(r, values.length ? `value ${values.length + 1}` : 'value'));
      }
      value = values[0] ?? null;
      out.meta = { name, value, values };
      node.label = typeof name === 'string' ? name : 'script';
    }
  } catch (e) {
    if (!(e instanceof ParseError)) throw e;
    node.warn(e.message);
  }
  if (!h.isFrame && r.pos < dataEnd && r.bit === 0) {
    r.bytes(h.kind === 'script' ? 'trailing bytes' : 'data', dataEnd - r.pos, { desc: 'Tag data Vidscope does not decode.' });
  }
  // PreviousTagSize
  const want = 11 + th.dataSize;
  let prev = null;
  if (hasPts) {
    const p = tagEnd - base;
    if (p + 4 <= u8.length) prev = new DataView(u8.buffer, u8.byteOffset + p, 4).getUint32(0);
    else if (extra.prev !== undefined) prev = extra.prev;
    if (prev !== null) {
      fields.push({
        name: 'PreviousTagSize',
        type: 'uint32',
        offset: tagEnd,
        size: 4,
        value: prev,
        display: prev === want ? `${fmtInt(prev)} ✓ (= 11 + DataSize)` : `${fmtInt(prev)} ✗ (should be 11 + DataSize = ${fmtInt(want)})`,
        desc: 'Size of the tag that just ended (11 + DataSize). It lets a reader walk the file backwards and detect that it has lost sync: a mismatch means the tag or this field is corrupt.',
        key: prev !== want,
      });
      if (prev !== want) node.warn(`PreviousTagSize is ${fmtInt(prev)} but this tag is ${fmtInt(want)} bytes (11 + DataSize).`);
    }
  }
  out.prev = prev;
  node.data.summary = tagSummary(h, th, out);
  if (!node.label) node.label = tagLabel(h, th, out, extra);
  parent.add(node);
  out.node = node;
  return out;
}

function tagSummary(h, th, out) {
  const t = `${fmtDuration(th.ts / 1000)}`;
  if (h.kind === 'script') return `${out.meta?.name ?? 'script'} (AMF0)`;
  if (h.kind === 'video') {
    if (h.isConfig) return `${codecName(h)} decoder configuration${out.config?.summary ? `: ${out.config.summary}` : ''}`;
    if (h.isEnd) return `${codecName(h)} end of sequence at ${t}`;
    if (h.isMeta) return `video metadata${out.meta?.name ? ` "${out.meta.name}"` : ''}`;
    if (h.command) return 'command frame';
    return `${codecName(h)} ${h.key ? 'key' : 'inter'} frame, ${fmtInt(th.dataSize - h.headerLen)} bytes, DTS ${t}${h.cts ? `, PTS ${fmtDuration((th.ts + h.cts) / 1000)}` : ''}`;
  }
  if (h.kind === 'audio') {
    if (h.isConfig) return `${codecName(h)} decoder configuration${out.config?.summary ? `: ${out.config.summary}` : ''}`;
    if (h.isMeta) return 'multichannel configuration';
    return `${codecName(h)} audio, ${fmtInt(Math.max(0, th.dataSize - h.headerLen))} bytes at ${t}`;
  }
  return `tag type ${th.type}`;
}

function tagLabel(h, th, out, extra) {
  const t = fmtDuration(th.ts / 1000);
  const num = extra.frame !== undefined ? `#${fmtInt(extra.frame + 1)} · ` : '';
  const name = h.kind === 'video' ? (h.enhanced ? h.fourcc : { 7: 'AVC', 2: 'H.263', 4: 'VP6', 5: 'VP6A', 3: 'Screen', 6: 'Screen2', 12: 'HEVC' }[h.codecId] ?? `codec ${h.codecId}`)
    : h.kind === 'audio' ? (h.enhanced ? h.fourcc : { 10: 'AAC', 2: 'MP3', 14: 'MP3', 11: 'Speex', 0: 'PCM', 3: 'PCM', 1: 'ADPCM', 7: 'A-law', 8: 'µ-law' }[h.soundFormat] ?? 'Nellymoser') : '';
  if (h.isConfig) return `${name} sequence header`;
  if (h.isEnd) return `${name} end of sequence`;
  if (h.isMeta) return h.kind === 'video' ? `${name} metadata` : `${name} channel config`;
  if (h.command) return 'command frame';
  if (h.empty) return `${name} (empty) · ${t}`;
  if (h.kind === 'video') return `${num}${name} ${h.key ? 'key frame' : 'frame'} · ${t}`;
  if (h.kind === 'audio') return `${num}${name} · ${t}`;
  return `type ${th.type}`;
}

/** The FLV file header and PreviousTagSize0 as nodes. Returns {dataOffset, audio, video, version, error?}. */
export function headerNodes(ctx, root, u8) {
  const out = {};
  const n = Math.min(u8.length, 9);
  const node = new Node({ type: 'header', name: 'FLV header', kind: 'header', offset: 0, size: n, headerSize: n, category: 'type', def: DEFS.header });
  const r = new FieldReader(u8, 0, { start: 0, end: u8.length, out: node.fields });
  try {
    r.str('Signature', 3, { encoding: 'latin1', expect: 'FLV', key: true, desc: 'The bytes "FLV" (0x46 0x4C 0x56).' });
    out.version = r.u8('Version', { key: true, desc: 'File version: 1 for every FLV file (Enhanced RTMP keeps version 1).' });
    r.bits(5, 'TypeFlagsReserved', { reserved: true, desc: 'Must be 0.' });
    out.audio = r.flag('TypeFlagsAudio', { key: true, desc: 'Audio tags are present (a hint).' });
    r.bits(1, 'TypeFlagsReserved', { reserved: true, desc: 'Must be 0.' });
    out.video = r.flag('TypeFlagsVideo', { key: true, desc: 'Video tags are present (a hint).' });
    out.dataOffset = r.u32('DataOffset', { unit: 'bytes', desc: 'Size of this header: 9 in version 1. The body (PreviousTagSize0 and the tags) starts here.' });
  } catch (e) {
    if (!(e instanceof ParseError)) throw e;
    out.error = e.message;
    node.warn(e.message);
  }
  if (out.dataOffset !== undefined && out.dataOffset !== 9) {
    node.warn(`DataOffset is ${out.dataOffset}; FLV version 1 headers are 9 bytes.`);
    if (out.dataOffset > 9 && out.dataOffset <= u8.length) {
      node.size = out.dataOffset;
      r.bytes('extra header bytes', out.dataOffset - 9);
    }
  }
  node.data.summary = `version ${out.version ?? '?'}, ${[out.video ? 'video' : null, out.audio ? 'audio' : null].filter(Boolean).join(' + ') || 'no streams flagged'}`;
  root.add(node);
  out.node = node;
  const at = Math.max(9, out.dataOffset ?? 9);
  if (u8.length >= at + 4) {
    const p0 = new Node({ type: 'PreviousTagSize0', name: 'PreviousTagSize0', kind: 'field', offset: at, size: 4, category: 'header', def: DEFS.pts0 });
    const v = new DataView(u8.buffer, u8.byteOffset + at, 4).getUint32(0);
    p0.fields.push({ name: 'PreviousTagSize0', type: 'uint32', offset: at, size: 4, value: v, display: v === 0 ? '0 ✓' : `${fmtInt(v)} (should be 0)`, desc: DEFS.pts0.desc, key: true });
    if (v !== 0) p0.warn(`PreviousTagSize0 is ${fmtInt(v)}; it should be 0.`);
    root.add(p0);
    out.bodyStart = at + 4;
  } else {
    out.bodyStart = u8.length;
  }
  return out;
}

