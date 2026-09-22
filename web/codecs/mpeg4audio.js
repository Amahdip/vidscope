// MPEG-4 systems descriptors (esds) and MPEG-4 audio configuration.
// References: ISO/IEC 14496-1 § 7.2.6 (descriptors), ISO/IEC 14496-3 § 1.6.2.1
// (AudioSpecificConfig), ISO/IEC 14496-14 § 5.6 (ESDBox), ISO/IEC 13818-7 (ADTS).

import { FieldReader, ParseError } from '../core/fields.js';
import { HEX2, fmtBitrate, fmtInt } from '../core/util.js';

export const DESCRIPTOR_TAGS = {
  0x01: 'ObjectDescriptor', 0x02: 'InitialObjectDescriptor', 0x03: 'ES_Descriptor',
  0x04: 'DecoderConfigDescriptor', 0x05: 'DecoderSpecificInfo', 0x06: 'SLConfigDescriptor',
  0x0e: 'ES_ID_Inc', 0x0f: 'ES_ID_Ref', 0x10: 'MP4_IOD', 0x11: 'MP4_OD',
};

export const OBJECT_TYPES = {
  0x01: 'Systems 14496-1', 0x02: 'Systems 14496-1 (v2)', 0x03: 'Interaction stream', 0x05: 'AFX stream',
  0x06: 'Font data', 0x07: 'Synthesized texture', 0x08: 'Streaming text', 0x20: 'MPEG-4 Visual (Part 2)',
  0x21: 'H.264 / AVC', 0x22: 'H.264 parameter sets', 0x23: 'H.265 / HEVC', 0x40: 'MPEG-4 Audio (AAC and friends)',
  0x60: 'MPEG-2 Video Simple', 0x61: 'MPEG-2 Video Main', 0x62: 'MPEG-2 Video SNR', 0x63: 'MPEG-2 Video Spatial',
  0x64: 'MPEG-2 Video High', 0x65: 'MPEG-2 Video 4:2:2', 0x66: 'MPEG-2 AAC Main', 0x67: 'MPEG-2 AAC LC',
  0x68: 'MPEG-2 AAC SSR', 0x69: 'MPEG-2 Audio (Part 3, MP3)', 0x6a: 'MPEG-1 Video', 0x6b: 'MPEG-1 Audio (MP3)',
  0x6c: 'JPEG', 0x6d: 'PNG', 0x6e: 'JPEG 2000', 0xa3: 'VC-1', 0xa4: 'Dirac', 0xa5: 'AC-3', 0xa6: 'E-AC-3',
  0xa9: 'DTS', 0xad: 'Opus', 0xdd: 'Vorbis (non-standard)', 0xe1: 'QCELP',
};

export const STREAM_TYPES = {
  0x01: 'ObjectDescriptorStream', 0x02: 'ClockReferenceStream', 0x03: 'SceneDescriptionStream',
  0x04: 'VisualStream', 0x05: 'AudioStream', 0x06: 'MPEG7Stream', 0x07: 'IPMPStream',
  0x08: 'ObjectContentInfoStream', 0x09: 'MPEGJStream', 0x0a: 'InteractionStream', 0x0b: 'IPMPToolStream',
  0x0c: 'FontDataStream', 0x0d: 'StreamingText',
};

export const AOT = {
  1: 'AAC Main', 2: 'AAC LC', 3: 'AAC SSR', 4: 'AAC LTP', 5: 'SBR (HE-AAC)', 6: 'AAC Scalable', 7: 'TwinVQ',
  8: 'CELP', 9: 'HVXC', 12: 'TTSI', 13: 'Main synthesis', 14: 'Wavetable synthesis', 15: 'General MIDI',
  16: 'Algorithmic synthesis', 17: 'ER AAC LC', 19: 'ER AAC LTP', 20: 'ER AAC Scalable', 21: 'ER TwinVQ',
  22: 'ER BSAC', 23: 'ER AAC LD', 24: 'ER CELP', 25: 'ER HVXC', 26: 'ER HILN', 27: 'ER Parametric',
  28: 'SSC', 29: 'PS (HE-AAC v2)', 30: 'MPEG Surround', 32: 'MPEG-1/2 Layer 1', 33: 'MPEG-1/2 Layer 2',
  34: 'MPEG-1/2 Layer 3 (MP3)', 35: 'DST', 36: 'ALS', 37: 'SLS', 38: 'SLS non-core', 39: 'ER AAC ELD',
  40: 'SMR Simple', 41: 'SMR Main', 42: 'USAC', 43: 'SAOC', 44: 'LD MPEG Surround', 45: 'USAC (2)',
};

export const SAMPLE_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

export const CHANNEL_CONFIG = {
  0: 'defined in the codec-specific config', 1: '1 channel: C', 2: '2 channels: L R', 3: '3 channels: C L R',
  4: '4 channels: C L R Cs', 5: '5 channels: C L R Ls Rs', 6: '5.1: C L R Ls Rs LFE', 7: '7.1: C L R Ls Rs Lc Rc LFE',
  11: '6.1', 12: '7.1 (rear)', 13: '22.2', 14: '7.1 (top front)',
};
const CHANNEL_COUNT = { 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 8, 11: 7, 12: 8, 13: 24, 14: 8 };

const GA_TYPES = new Set([1, 2, 3, 4, 6, 7, 17, 19, 20, 21, 22, 23]);

/** Human name for an MPEG-4 audio configuration, e.g. "HE-AAC v2" or "AAC LC". */
export function aacName(asc) {
  if (!asc) return 'AAC';
  if (asc.ps === 1) return 'HE-AAC v2 (AAC LC + SBR + PS)';
  if (asc.sbr === 1) return 'HE-AAC (AAC LC + SBR)';
  return AOT[asc.aot] ?? `audio object type ${asc.aot}`;
}

function audioObjectType(r, name) {
  const t = r.bits(5, name, { enum: AOT, key: true, desc: 'Audio object type: which MPEG-4 audio tool codes the stream. 2 = AAC LC, the common case.' });
  if (t === 31) return 32 + r.bits(6, `${name}Ext`, { display: (v) => `${v} → object type ${32 + v}` });
  return t;
}

function samplingFrequency(r, name) {
  const idx = r.bits(4, `${name}Index`, {
    key: true,
    display: (v) => (v === 15 ? '15 → explicit 24-bit rate follows' : `${v} → ${fmtInt(SAMPLE_RATES[v] ?? 0)} Hz`),
  });
  if (idx === 15) return r.bits(24, name, { unit: 'Hz' });
  return SAMPLE_RATES[idx] ?? 0;
}

/** AudioSpecificConfig from a bit reader positioned at its first bit. */
export function parseAudioSpecificConfig(r) {
  const a = { sbr: -1, ps: -1 };
  a.aot = audioObjectType(r, 'audioObjectType');
  a.firstAot = a.aot; // what RFC 6381 codec strings use (mp4a.40.<n>)
  a.sampleRate = samplingFrequency(r, 'samplingFrequency');
  a.channelConfig = r.bits(4, 'channelConfiguration', { key: true, enum: CHANNEL_CONFIG });
  a.channels = CHANNEL_COUNT[a.channelConfig] ?? 0;
  if (a.aot === 5 || a.aot === 29) {
    a.sbr = 1;
    if (a.aot === 29) a.ps = 1;
    a.extSampleRate = samplingFrequency(r, 'extensionSamplingFrequency');
    a.aot = audioObjectType(r, 'audioObjectType (core)');
    if (a.aot === 22) r.bits(4, 'extensionChannelConfiguration');
  }
  if (GA_TYPES.has(a.aot)) {
    r.group('GASpecificConfig', () => {
      a.frameLength = r.flag('frameLengthFlag', { display: (v) => (v ? '1 → 960-sample frames' : '0 → 1024-sample frames') }) ? 960 : 1024;
      if (r.flag('dependsOnCoreCoder')) r.bits(14, 'coreCoderDelay');
      const ext = r.flag('extensionFlag');
      if (a.channelConfig === 0) {
        a.pce = true;
        throw new ParseError('program_config_element() is not decoded', r.abs);
      }
      if (a.aot === 6 || a.aot === 20) r.bits(3, 'layerNr');
      if (ext) {
        if (a.aot === 22) {
          r.bits(5, 'numOfSubFrame');
          r.bits(11, 'layer_length');
        }
        if (a.aot === 17 || a.aot === 19 || a.aot === 20 || a.aot === 23) {
          r.flag('aacSectionDataResilienceFlag');
          r.flag('aacScalefactorDataResilienceFlag');
          r.flag('aacSpectralDataResilienceFlag');
        }
        r.flag('extensionFlag3');
      }
    });
  }
  // Backward-compatible (explicit) SBR / PS signalling after the core config.
  if (a.sbr !== 1 && r.bitsLeft >= 16) {
    const save = { pos: r.pos, bit: r.bit, n: r.out.length };
    const sync = r.bits(11, 'syncExtensionType', { display: (v) => `0x${v.toString(16)}` });
    if (sync === 0x2b7) {
      const ext = audioObjectType(r, 'extensionAudioObjectType');
      if (ext === 5) {
        a.sbr = r.flag('sbrPresentFlag');
        if (a.sbr) {
          a.extSampleRate = samplingFrequency(r, 'extensionSamplingFrequency');
          if (r.bitsLeft >= 12) {
            if (r.bits(11, 'syncExtensionType', { display: (v) => `0x${v.toString(16)}` }) === 0x548) a.ps = r.flag('psPresentFlag');
          }
        }
      }
    } else {
      r.pos = save.pos;
      r.bit = save.bit;
      r.out.length = save.n;
    }
  }
  return a;
}

/**
 * ESDBox payload (after version/flags): one ES_Descriptor. Returns
 * {oti, streamType, maxBitrate, avgBitrate, asc, codec}.
 */
export function parseEsds(r) {
  const info = {};
  let guard = 0;
  while (r.remaining >= 2 && guard++ < 8) descriptor(r, info, 0);
  if (info.oti === 0x40 && info.asc) info.codec = `mp4a.40.${info.asc.firstAot}`;
  else if (info.oti !== undefined) info.codec = `mp4a.${HEX2[info.oti]}`;
  return info;
}

function descriptor(r, info, depth) {
  if (depth > 6) return;
  const tagAt = r.pos;
  const tag = r.u8(null);
  r.pos = tagAt;
  const name = DESCRIPTOR_TAGS[tag] ?? `descriptor 0x${HEX2[tag]}`;
  r.group(name, (g) => {
    r.u8('tag', { display: (v) => `0x${HEX2[v]} (${name})` });
    const size = r.expandableSize('size', { unit: 'bytes', desc: 'Descriptor length, coded 7 bits per byte with the top bit meaning "more bytes follow".' });
    r.bounded(size, () => {
      try {
        descriptorBody(r, tag, info, depth, g);
      } catch (e) {
        if (!(e instanceof ParseError)) throw e;
        g.error = e.message;
      }
      if (r.remaining > 0 && r.bit === 0) r.rest('unparsed', { desc: 'Descriptor bytes not decoded here.' });
    });
  });
}

function descriptorBody(r, tag, info, depth, g) {
  switch (tag) {
    case 0x03: {
      r.u16('ES_ID', { desc: 'Elementary stream ID; 0 inside MP4 files.' });
      const dep = r.flag('streamDependenceFlag');
      const url = r.flag('URL_Flag');
      const ocr = r.flag('OCRstreamFlag');
      r.bits(5, 'streamPriority');
      if (dep) r.u16('dependsOn_ES_ID');
      if (url) {
        const n = r.u8('URLlength');
        r.str('URLstring', n);
      }
      if (ocr) r.u16('OCR_ES_Id');
      while (r.remaining >= 2) descriptor(r, info, depth + 1);
      break;
    }
    case 0x04: {
      info.oti = r.u8('objectTypeIndication', {
        key: true,
        display: (v) => `0x${HEX2[v]} — ${OBJECT_TYPES[v] ?? 'unknown'}`,
        desc: 'The codec, as an MPEG-4 object type (registered at mp4ra.org). 0x40 = MPEG-4 audio, whose exact type is in the DecoderSpecificInfo.',
      });
      info.streamType = r.bits(6, 'streamType', { enum: STREAM_TYPES });
      r.flag('upStream');
      r.bits(1, 'reserved', { reserved: true });
      info.bufferSize = r.u24('bufferSizeDB', { unit: 'bytes', desc: 'Decoder buffer size needed for this stream.' });
      info.maxBitrate = r.u32('maxBitrate', { display: (v) => `${fmtInt(v)} (${fmtBitrate(v)})`, desc: 'Peak bitrate over any one-second window.' });
      info.avgBitrate = r.u32('avgBitrate', { display: (v) => (v ? `${fmtInt(v)} (${fmtBitrate(v)})` : '0 (variable bitrate / not given)') });
      g.display = OBJECT_TYPES[info.oti] ?? `object type 0x${HEX2[info.oti]}`;
      while (r.remaining >= 2) descriptor(r, info, depth + 1);
      break;
    }
    case 0x05: {
      if (info.oti === 0x40 || info.oti === 0x66 || info.oti === 0x67 || info.oti === 0x68) {
        r.group('AudioSpecificConfig', (a) => {
          try {
            info.asc = parseAudioSpecificConfig(r);
            a.display = `${aacName(info.asc)}, ${fmtInt(info.asc.extSampleRate || info.asc.sampleRate)} Hz, ${CHANNEL_CONFIG[info.asc.channelConfig] ?? info.asc.channelConfig}`;
            g.display = a.display;
          } finally {
            if (r.bit) r.align('padding');
          }
        });
      }
      if (r.remaining > 0) r.rest('decoderSpecificInfo');
      break;
    }
    case 0x06:
      r.u8('predefined', { enum: { 0: 'custom', 1: 'null SL packet header', 2: 'reserved for use in MP4 files' } });
      break;
    default:
      break;
  }
}

/** ADTS header (AAC in MPEG-TS and raw .aac files), from the sync word. */
export function parseAdts(u8, start, end, base, out) {
  const r = new FieldReader(u8, base, { start, end, out });
  const h = {};
  try {
    r.bits(12, 'syncword', { display: (v) => `0x${v.toString(16).toUpperCase()}`, expect: 0xfff });
    r.flag('ID', { enum: { 0: 'MPEG-4', 1: 'MPEG-2' } });
    r.bits(2, 'layer');
    const noCrc = r.flag('protection_absent');
    h.aot = r.bits(2, 'profile_ObjectType', { display: (v) => `${v} → ${AOT[v + 1] ?? 'unknown'}` }) + 1;
    const sfi = r.bits(4, 'sampling_frequency_index', { display: (v) => `${v} → ${fmtInt(SAMPLE_RATES[v] ?? 0)} Hz` });
    h.sampleRate = SAMPLE_RATES[sfi];
    r.flag('private_bit');
    h.channelConfig = r.bits(3, 'channel_configuration', { enum: CHANNEL_CONFIG });
    r.flag('original_copy');
    r.flag('home');
    r.flag('copyright_identification_bit');
    r.flag('copyright_identification_start');
    h.frameLength = r.bits(13, 'aac_frame_length', { unit: 'bytes', desc: 'Length of this ADTS frame including the header.' });
    r.bits(11, 'adts_buffer_fullness');
    h.blocks = r.bits(2, 'number_of_raw_data_blocks_in_frame') + 1;
    if (!noCrc) r.u16('crc_check');
    h.headerSize = r.pos - start;
    h.summary = `ADTS ${AOT[h.aot] ?? ''} ${fmtInt(h.sampleRate)} Hz, ${h.frameLength} bytes`;
  } catch (e) {
    if (!(e instanceof ParseError)) throw e;
    h.error = e.message;
  }
  return h;
}
