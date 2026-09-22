// Stream formats stored in AVI 'strf' and WAV 'fmt ' chunks:
// BITMAPINFOHEADER (video) and WAVEFORMATEX with its extensions (audio).
// All little-endian (the FieldReader is created with { le: true }).

import { ParseError } from '../../core/fields.js';
import { fmtInt, fmtBitrate, fmtHz } from '../../core/util.js';
import { parseAudioSpecificConfig, aacName, CHANNEL_CONFIG } from '../../codecs/mpeg4audio.js';
import { parseAvcC } from '../../codecs/h264.js';
import {
  BI_COMPRESSION, videoCodec, FORMAT_TAGS, formatTagName, audioCodec, channelMaskText, channelMaskCount, channelLayoutName,
  guidString, subFormatInfo,
} from './tables.js';

// ------------------------------------------------------------ video

/**
 * BITMAPINFOHEADER (wingdi.h), then codec extradata or a palette.
 * Returns {width, height, bitCount, compression, fourcc, codecName, family, sizeImage, extradata}.
 */
export function parseBitmapInfoHeader(r) {
  const v = {};
  const start = r.pos;
  const biSize = r.u32('biSize', {
    unit: 'bytes',
    desc: 'Size of this header. 40 for a plain BITMAPINFOHEADER; AVI writers (FFmpeg among them) often add the size of the codec data that follows, so a larger value is normal here.',
  });
  v.width = r.i32('biWidth', { key: true, unit: 'pixels', desc: 'Width of the picture in pixels.' });
  v.height = r.i32('biHeight', {
    key: true,
    display: (h) => (h < 0 ? `${fmtInt(h)} → ${fmtInt(-h)} pixels, rows stored top-down` : `${fmtInt(h)} pixels`),
    desc: 'Height of the picture in pixels. For uncompressed RGB a positive height means the rows are stored bottom-up (the first row in the file is the bottom of the picture, a Windows DIB convention); a negative height means top-down. Compressed formats use a positive height.',
  });
  r.u16('biPlanes', { expect: 1, desc: 'Number of colour planes; always 1.' });
  v.bitCount = r.u16('biBitCount', {
    unit: 'bits per pixel',
    desc: 'Bits per pixel of the decoded picture: 24 or 32 for RGB, 16 for 4:2:2 YUV, 12 for 4:2:0 YUV. Compressed codecs usually state the depth they decode to.',
  });
  const cAt = r.pos;
  const numeric = r.u32(null);
  r.pos = cAt;
  let compression;
  if (numeric < 256) {
    compression = r.u32('biCompression', {
      key: true,
      display: (x) => `${x} — ${BI_COMPRESSION[x] ?? 'unknown numeric compression'}`,
      desc: 'How the picture data is coded. Small numbers are the Windows bitmap types (0 = uncompressed RGB); anything else is a FOURCC naming the codec.',
    });
    v.fourcc = numeric === 0 ? 'RGB ' : null;
    v.codecName = numeric === 0 ? 'Uncompressed RGB' : BI_COMPRESSION[numeric] ?? `compression ${numeric}`;
  } else {
    compression = r.fourcc('biCompression', {
      key: true,
      display: (x) => `'${x}' — ${videoCodec(x)?.name ?? 'a codec Vidscope does not know'}`,
      desc: 'The codec, as a FOURCC. Players pick a decoder from this value (the strh fccHandler is only a hint and often differs in case, e.g. \'xvid\' vs \'XVID\').',
    });
    v.fourcc = compression;
    v.codecName = videoCodec(compression)?.name ?? `'${compression}'`;
  }
  v.compression = compression;
  v.family = videoCodec(v.fourcc)?.family ?? null;
  v.sizeImage = r.u32('biSizeImage', {
    unit: 'bytes',
    desc: 'Size of one decoded or uncompressed frame in bytes. May be 0 for uncompressed RGB; for compressed video it is only a buffer-size hint.',
  });
  r.i32('biXPelsPerMeter', { desc: 'Horizontal resolution of the target device in pixels per metre. Usually 0 (meaningless for video).' });
  r.i32('biYPelsPerMeter', { desc: 'Vertical resolution of the target device. Usually 0.' });
  const clrUsed = r.u32('biClrUsed', { desc: 'Number of palette entries actually used (0 = the maximum for biBitCount when a palette is present).' });
  r.u32('biClrImportant', { desc: 'Number of palette entries required to display the picture; 0 = all.' });
  const extra = r.end - r.pos;
  if (biSize > 40 && biSize - 40 > extra + 1) {
    // biSize claims more data than the chunk holds.
    v.sizeMismatch = `biSize says ${biSize} bytes but the chunk holds ${r.end - start}`;
  }
  if (extra > 0) {
    const paletted = numeric === 0 && v.bitCount <= 8;
    if (paletted) {
      const n = Math.min(Math.floor(extra / 4), clrUsed || 1 << v.bitCount);
      r.table('palette', n, 4, [
        { name: 'blue', type: 'u8' }, { name: 'green', type: 'u8' }, { name: 'red', type: 'u8' }, { name: 'reserved', type: 'u8' },
      ], { desc: 'Colour table (RGBQUAD entries: blue, green, red, reserved) for 8-bit or smaller paletted video.' });
      if (r.remaining > 0) r.rest('trailing bytes');
    } else {
      v.extradata = { offset: r.abs, start: r.pos, bytes: r.u.subarray(r.pos, r.end) };
      extradataFields(r, v);
    }
  }
  return v;
}

/** Codec setup data after the BITMAPINFOHEADER. */
function extradataFields(r, v) {
  const u = r.u;
  const p = r.pos;
  const n = r.end - p;
  if (v.family === 'avc' && u[p] === 1 && n >= 7) {
    r.group('AVCDecoderConfigurationRecord', (g) => {
      try {
        v.avcC = parseAvcC(r, 'avc1');
        g.display = `${v.avcC.sps[0]?.summary ?? 'avcC'}`;
      } catch (e) {
        if (!(e instanceof ParseError)) throw e;
        g.error = e.message;
      }
    }, { desc: 'H.264 decoder configuration (avcC) stored as codec extradata: the NAL units in this stream are then length-prefixed instead of using start codes.' });
    if (r.remaining > 0) r.rest('trailing bytes');
    return;
  }
  const annexB = n >= 4 && u[p] === 0 && u[p + 1] === 0 && (u[p + 2] === 1 || (u[p + 2] === 0 && u[p + 3] === 1));
  r.rest('codec extradata', {
    desc: annexB
      ? 'Codec setup data that follows the header, here in start-code form (00 00 01): for MPEG-4 Part 2 the Visual Object Sequence and Video Object Layer headers, for H.264 the SPS/PPS. Decoders need it before the first frame; most streams repeat it in the first key frame too.'
      : 'Codec-specific setup data that follows the 40-byte header (its size is counted in biSize).',
  });
  v.extradataAnnexB = annexB;
}

// ------------------------------------------------------------ audio

const MP3_FLAGS = { 0: 'MPEGLAYER3_FLAG_PADDING_ISO (padding as the standard says)', 1: 'MPEGLAYER3_FLAG_PADDING_ON (every frame padded)', 2: 'MPEGLAYER3_FLAG_PADDING_OFF (no frame padded)' };

/**
 * WAVEFORMATEX (mmreg.h) or the older 16-byte PCMWAVEFORMAT, plus the
 * extension selected by wFormatTag. Returns a description of the format.
 */
export function parseWaveFormat(r) {
  const a = {};
  const size = r.end - r.pos;
  a.tag = r.u16('wFormatTag', {
    key: true,
    display: (t) => `0x${t.toString(16).toUpperCase().padStart(4, '0')} — ${formatTagName(t)}`,
    desc: 'The audio codec. 0x0001 is integer PCM, 0x0003 float PCM, 0x0055 MP3, 0xFFFE means "see SubFormat in the extension" (WAVE_FORMAT_EXTENSIBLE).',
  });
  a.channels = r.u16('nChannels', { key: true, desc: 'Number of channels (interleaved sample by sample for PCM).' });
  a.sampleRate = r.u32('nSamplesPerSec', { key: true, display: (v) => `${fmtInt(v)} Hz`, desc: 'Sample rate: sample frames per second for PCM; for compressed formats the rate of the decoded audio.' });
  a.byteRate = r.u32('nAvgBytesPerSec', {
    display: (v) => `${fmtInt(v)} bytes/s (${fmtBitrate(v * 8)})`,
    desc: 'Average data rate. For PCM it must equal nSamplesPerSec × nBlockAlign; for compressed audio it is the (average) bitrate / 8, which players use to estimate duration and to seek.',
  });
  a.blockAlign = r.u16('nBlockAlign', {
    unit: 'bytes',
    desc: 'Block alignment: the smallest unit of data a reader may cut at. For PCM it is one sample frame = nChannels × wBitsPerSample / 8. For ADPCM it is the size of one compressed block.',
  });
  a.bits = r.u16('wBitsPerSample', {
    unit: 'bits',
    desc: 'Bits per sample for PCM (8, 16, 24, 32). For compressed formats it is often 0 or the decoded depth.',
  });
  a.pcmWaveFormat = size < 18;
  if (size >= 18) {
    a.cbSize = r.u16('cbSize', {
      unit: 'bytes',
      desc: 'Size of the format-specific extension that follows. 0 for plain PCM; 22 for WAVE_FORMAT_EXTENSIBLE; 12 for MP3.',
    });
    const ext = Math.min(a.cbSize, r.remaining);
    if (a.cbSize > r.remaining) a.cbSizeProblem = `cbSize says ${a.cbSize} bytes but only ${r.remaining} follow`;
    if (ext > 0) r.bounded(ext, () => waveFormatExtension(r, a));
  }
  a.codec = audioCodec(a.subTag ?? a.tag);
  a.pcm = !!a.codec.pcm;
  a.summary = audioSummary(a);
  return a;
}

function waveFormatExtension(r, a) {
  switch (a.tag) {
    case 0xfffe: {
      r.group('WAVEFORMATEXTENSIBLE', (g) => {
        if (a.bits) {
          a.validBits = r.u16('wValidBitsPerSample', {
            unit: 'bits',
            desc: 'Bits of precision actually used in each sample; may be smaller than the container size wBitsPerSample (e.g. 20 valid bits in 24-bit containers).',
          });
        } else {
          a.samplesPerBlock = r.u16('wSamplesPerBlock', { desc: 'Samples per compressed block (used when wBitsPerSample is 0).' });
        }
        a.channelMask = r.u32('dwChannelMask', {
          key: true,
          display: (m) => `0x${(m >>> 0).toString(16).toUpperCase().padStart(8, '0')} → ${channelMaskText(m)}`,
          desc: 'Which loudspeaker each channel feeds, one bit per position in a fixed order (FL, FR, FC, LFE, BL, BR, FLC, FRC, BC, SL, SR, then the top positions). The channels in the data appear in that bit order.',
        });
        if (r.remaining >= 16) {
          const guid = guidString(r.u, r.pos);
          const info = subFormatInfo(guid);
          a.subFormat = guid;
          a.subTag = info.tag ?? undefined;
          a.ambisonic = info.ambisonic;
          r.bytes('SubFormat', 16, {
            key: true,
            display: `{${guid}} — ${info.text}`,
            desc: 'A GUID naming the real format. For the standard formats it is the format tag embedded in the base GUID xxxxxxxx-0000-0010-8000-00AA00389B71 (KSDATAFORMAT_SUBTYPE_PCM, _IEEE_FLOAT...).',
          });
        }
        g.display = `${channelMaskText(a.channelMask ?? 0)}${a.subTag !== undefined ? `, ${FORMAT_TAGS[a.subTag] ?? ''}` : ''}`;
      }, { desc: 'The extension that WAVE_FORMAT_EXTENSIBLE (0xFFFE) adds: valid bits, speaker positions and the real format as a GUID. Required for more than two channels or more than 16 bits per sample.' });
      break;
    }
    case 0x0055: {
      r.group('MPEGLAYER3WAVEFORMAT', (g) => {
        r.u16('wID', { enum: { 0: 'MPEGLAYER3_ID_UNKNOWN', 1: 'MPEGLAYER3_ID_MPEG', 2: 'MPEGLAYER3_ID_CONSTANTFRAMESIZE' } });
        const fl = r.u32('fdwFlags', { enum: MP3_FLAGS, desc: 'How frames are padded to reach the exact bitrate.' });
        a.mp3BlockSize = r.u16('nBlockSize', { unit: 'bytes', desc: 'Size of one block (for CBR streams, the frame size in bytes). Some writers put 1152 here regardless.' });
        r.u16('nFramesPerBlock', { desc: 'MP3 frames per block; 1.' });
        a.codecDelay = r.u16('nCodecDelay', { unit: 'samples', desc: 'Encoder delay (priming samples) the decoder should drop at the start.' });
        g.display = `${['padding ISO', 'padding on', 'padding off'][fl] ?? `flags ${fl}`}, block ${a.mp3BlockSize}, codec delay ${a.codecDelay} samples`;
      }, { desc: 'MP3-specific fields (mmreg.h MPEGLAYER3WAVEFORMAT).' });
      break;
    }
    case 0x0050: {
      r.group('MPEG1WAVEFORMAT', () => {
        r.u16('fwHeadLayer', { display: (v) => `0x${v.toString(16)} (${[v & 1 ? 'Layer I' : '', v & 2 ? 'Layer II' : '', v & 4 ? 'Layer III' : ''].filter(Boolean).join(', ') || 'none'})` });
        r.u32('dwHeadBitrate', { display: (v) => fmtBitrate(v) });
        r.u16('fwHeadMode', { display: (v) => `0x${v.toString(16)} (${[v & 1 ? 'stereo' : '', v & 2 ? 'joint stereo' : '', v & 4 ? 'dual channel' : '', v & 8 ? 'mono' : ''].filter(Boolean).join(', ') || '?'})` });
        r.u16('fwHeadModeExt');
        r.u16('wHeadEmphasis');
        r.u16('fwHeadFlags');
        r.u32('dwPTSLow');
        r.u32('dwPTSHigh');
      }, { desc: 'MPEG-1 audio (Layer I/II) fields (mmreg.h MPEG1WAVEFORMAT).' });
      break;
    }
    case 0x0011: {
      a.samplesPerBlock = r.u16('wSamplesPerBlock', {
        desc: 'Samples (per channel) decoded from one block of nBlockAlign bytes. IMA ADPCM blocks start with a small header (predictor and step index per channel) followed by 4-bit codes.',
      });
      break;
    }
    case 0x0002: {
      a.samplesPerBlock = r.u16('wSamplesPerBlock', { desc: 'Samples (per channel) decoded from one block of nBlockAlign bytes.' });
      const n = r.u16('wNumCoef', { desc: 'Number of predictor coefficient pairs that follow (7 standard ones).' });
      r.table('aCoef', n, 4, [{ name: 'iCoef1', type: 'i16' }, { name: 'iCoef2', type: 'i16' }], { desc: 'Predictor coefficient pairs (fixed point, 256 = 1.0).' });
      break;
    }
    case 0x1610: {
      r.group('HEAACWAVEINFO', () => {
        a.aacPayload = r.u16('wPayloadType', { enum: { 0: 'raw AAC', 1: 'ADTS', 2: 'ADIF', 3: 'LOAS' } });
        r.u16('wAudioProfileLevelIndication');
        r.u16('wStructType');
        r.u16('wReserved1', { reserved: true });
        r.u32('dwReserved2', { reserved: true });
      });
      if (r.remaining > 0) ascGroup(r, a);
      break;
    }
    default: {
      if (audioCodec(a.tag).family === 'aac' && r.remaining > 0) {
        ascGroup(r, a);
      } else if (r.remaining > 0) {
        r.rest('codec extradata', { desc: 'Format-specific data (cbSize bytes) Vidscope does not decode for this codec.' });
      }
    }
  }
  if (r.remaining > 0 && r.bit === 0) r.rest('trailing bytes', { desc: 'Extension bytes after the fields decoded above.' });
}

function ascGroup(r, a) {
  r.group('AudioSpecificConfig', (g) => {
    try {
      a.asc = parseAudioSpecificConfig(r);
      g.display = `${aacName(a.asc)}, ${fmtInt(a.asc.extSampleRate || a.asc.sampleRate)} Hz, ${CHANNEL_CONFIG[a.asc.channelConfig] ?? a.asc.channelConfig}`;
    } catch (e) {
      if (!(e instanceof ParseError)) throw e;
      g.error = e.message;
    } finally {
      if (r.bit) r.align('padding');
    }
  }, { desc: 'MPEG-4 AudioSpecificConfig: the AAC profile, sample rate and channel configuration a decoder needs before the first frame.' });
}

export function audioSummary(a) {
  const tag = a.subTag ?? a.tag;
  const name = audioCodec(tag).name;
  const parts = [name];
  if (a.asc) parts[0] = aacName(a.asc);
  parts.push(fmtHz(a.asc ? a.asc.extSampleRate || a.asc.sampleRate : a.sampleRate));
  const ch = a.channels;
  parts.push(a.channelMask ? `${ch} ch (${channelLayoutName(a.channelMask)})` : `${ch} ch`);
  if (a.pcm || tag === 1 || tag === 3) parts.push(`${a.validBits && a.validBits !== a.bits ? `${a.validBits}/` : ''}${a.bits}-bit${tag === 3 ? ' float' : ''}`);
  else if (a.byteRate) parts.push(fmtBitrate(a.byteRate * 8));
  return parts.join(', ');
}

/** Consistency problems of a WAVEFORMATEX, as plain sentences. */
export function waveFormatProblems(a) {
  const out = [];
  const tag = a.subTag ?? a.tag;
  if (tag === 1 || tag === 3) {
    const expectAlign = a.channels * Math.ceil(a.bits / 8);
    if (a.blockAlign !== expectAlign) out.push(`nBlockAlign is ${a.blockAlign} but ${a.channels} channel(s) × ${a.bits} bits needs ${expectAlign}.`);
    if (a.byteRate !== a.sampleRate * a.blockAlign) out.push(`nAvgBytesPerSec is ${fmtInt(a.byteRate)} but nSamplesPerSec × nBlockAlign = ${fmtInt(a.sampleRate * a.blockAlign)}.`);
    if (a.tag === 1 && (a.channels > 2 || a.bits > 16)) out.push(`${a.channels > 2 ? `${a.channels} channels` : `${a.bits}-bit samples`} should use WAVE_FORMAT_EXTENSIBLE (0xFFFE) so the channel layout and valid bits are explicit; plain 0x0001 is only unambiguous for mono/stereo up to 16 bits.`);
  }
  if (a.channelMask && channelMaskCount(a.channelMask) !== a.channels) out.push(`dwChannelMask names ${channelMaskCount(a.channelMask)} speaker positions but nChannels is ${a.channels}.`);
  if (a.cbSizeProblem) out.push(a.cbSizeProblem);
  return out;
}

