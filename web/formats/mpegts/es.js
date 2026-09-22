// Elementary-stream helpers for the transport stream demuxer: audio frame
// sync (to split PES payloads into frames like FFmpeg's parsers do), key-frame
// detection for video, codec configuration for the Tracks tab, and frame
// "units" for codecs the shared parsers in web/codecs do not cover.

import { FieldReader, ParseError } from '../../core/fields.js';
import { fmtInt, fmtNum, HEX2 } from '../../core/util.js';
import { splitAnnexB, toRbsp } from '../../codecs/nal.js';
import * as h264 from '../../codecs/h264.js';
import * as h265 from '../../codecs/h265.js';
import { parseAdts, parseAudioSpecificConfig, aacName, AOT, SAMPLE_RATES, CHANNEL_CONFIG } from '../../codecs/mpeg4audio.js';
import { parseMpegAudioHeader, AC3_ACMOD } from '../../codecs/audio.js';
import { colourSummary } from '../../codecs/color.js';

// ------------------------------------------------------------------ audio frame sync

const AC3_RATES = [48000, 44100, 32000];
const AC3_KBPS = [32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384, 448, 512, 576, 640];
const AC3_CHANNELS = [2, 1, 2, 3, 3, 4, 4, 5];
const EAC3_REDUCED = [24000, 22050, 16000];

/** ADTS header at u8[p]: { len, samples, rate } or null. */
export function adtsSync(u8, p, end) {
  if (p + 7 > end) return null;
  if (u8[p] !== 0xff || (u8[p + 1] & 0xf6) !== 0xf0) return null; // 12-bit sync, layer 00
  const sfi = (u8[p + 2] >> 2) & 15;
  const rate = SAMPLE_RATES[sfi];
  if (!rate) return null;
  const len = ((u8[p + 3] & 3) << 11) | (u8[p + 4] << 3) | (u8[p + 5] >> 5);
  const hdr = u8[p + 1] & 1 ? 7 : 9;
  if (len < hdr) return null;
  const blocks = (u8[p + 6] & 3) + 1;
  return { len, samples: 1024 * blocks, rate, channels: (u8[p + 2] & 1) << 2 | u8[p + 3] >> 6, aot: (u8[p + 2] >> 6) + 1 };
}

/** AC-3 or E-AC-3 sync frame at u8[p]: { len, samples, rate, eac3, dependent, ... } or null. */
export function ac3Sync(u8, p, end) {
  if (p + 6 > end) return null;
  if (u8[p] !== 0x0b || u8[p + 1] !== 0x77) return null;
  const bsid = u8[p + 5] >> 3;
  if (bsid <= 10) {
    const fscod = u8[p + 4] >> 6;
    const code = u8[p + 4] & 0x3f;
    if (fscod === 3 || code > 37) return null;
    const kbps = AC3_KBPS[code >> 1];
    const words = fscod === 0 ? kbps * 2 : fscod === 2 ? kbps * 3 : Math.floor((kbps * 96000) / 44100) + (code & 1);
    return { len: words * 2, samples: 1536, rate: AC3_RATES[fscod], eac3: false, bsid, bitrate: kbps * 1000 };
  }
  if (bsid > 16) return null;
  const strmtyp = u8[p + 2] >> 6;
  const frmsiz = ((u8[p + 2] & 7) << 8) | u8[p + 3];
  const fscod = u8[p + 4] >> 6;
  let rate;
  let blocks = 6;
  if (fscod === 3) {
    const fscod2 = (u8[p + 4] >> 4) & 3;
    if (fscod2 === 3) return null;
    rate = EAC3_REDUCED[fscod2];
  } else {
    rate = AC3_RATES[fscod];
    blocks = [1, 2, 3, 6][(u8[p + 4] >> 4) & 3];
  }
  const len = (frmsiz + 1) * 2;
  if (len < 6) return null;
  return { len, samples: 256 * blocks, rate, eac3: true, bsid, dependent: strmtyp === 1, substream: (u8[p + 2] >> 3) & 7 };
}

const MPA_KBPS = {
  1: { 1: [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448], 2: [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384], 3: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320] },
  2: { 1: [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256], 2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160], 3: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160] },
};
const MPA_RATES = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

/** MPEG-1/2/2.5 audio frame header at u8[p]: { len, samples, rate, layer } or null (free format is not splittable). */
export function mpaSync(u8, p, end) {
  if (p + 4 > end) return null;
  if (u8[p] !== 0xff || (u8[p + 1] & 0xe0) !== 0xe0) return null;
  const ver = (u8[p + 1] >> 3) & 3;
  const layer = 4 - ((u8[p + 1] >> 1) & 3);
  if (ver === 1 || layer === 4) return null;
  const bri = u8[p + 2] >> 4;
  const sri = (u8[p + 2] >> 2) & 3;
  if (bri === 0 || bri === 15 || sri === 3) return null;
  const kbps = MPA_KBPS[ver === 3 ? 1 : 2][layer][bri];
  const rate = MPA_RATES[ver][sri];
  const pad = (u8[p + 2] >> 1) & 1;
  const br = kbps * 1000;
  const len = layer === 1 ? (Math.floor((12 * br) / rate) + pad) * 4 : Math.floor(((layer === 3 && ver !== 3 ? 72 : 144) * br) / rate) + pad;
  const samples = layer === 1 ? 384 : layer === 3 && ver !== 3 ? 576 : 1152;
  return { len, samples, rate, layer, bitrate: br, mpeg1: ver === 3 };
}

/**
 * The AudioSpecificConfig in the StreamMuxConfig of a LOAS frame at u8[p], when the frame
 * carries one (useSameStreamMux = 0, audioMuxVersion = 0: it then starts at bit 16 of the
 * AudioMuxElement, right after numSubFrames, numProgram and numLayer).
 */
function latmConfig(u8, p, end) {
  if (p + 6 > end || u8[p + 3] & 0x80 || u8[p + 3] & 0x40) return null;
  try {
    return parseAudioSpecificConfig(new FieldReader(u8, 0, { start: p + 5, end, out: [] }));
  } catch (e) {
    if (!(e instanceof ParseError)) throw e;
    return null;
  }
}

/** LOAS AudioSyncStream frame (AAC in LATM) at u8[p]: { len, samples, rate } or null. `state` keeps the last configuration. */
export function latmSync(u8, p, end, state) {
  if (p + 3 > end) return null;
  if (u8[p] !== 0x56 || (u8[p + 1] & 0xe0) !== 0xe0) return null;
  const len = 3 + (((u8[p + 1] & 0x1f) << 8) | u8[p + 2]);
  if (state) {
    const asc = latmConfig(u8, p, Math.min(end, p + len));
    if (asc?.sampleRate) {
      state.rate = asc.sampleRate;
      state.samples = asc.frameLength ?? 1024;
    }
  }
  return { len, samples: state?.samples ?? 1024, rate: state?.rate ?? 0 };
}

export const FRAME_SYNC = { adts: adtsSync, ac3: ac3Sync, eac3: ac3Sync, mpa: mpaSync, latm: latmSync };

/** Guess the codec of a private stream from the first bytes of its payload. */
export function sniffAudio(u8, start, end) {
  for (let p = start; p < Math.min(end - 8, start + 64); p++) {
    const a = adtsSync(u8, p, end);
    if (a && (p + a.len + 2 > end || adtsSync(u8, p + a.len, end))) return { codec: 'aac', family: 'adts' };
    const c = ac3Sync(u8, p, end);
    if (c && (p + c.len + 2 > end || ac3Sync(u8, p + c.len, end))) return c.eac3 ? { codec: 'eac3', family: 'eac3' } : { codec: 'ac3', family: 'ac3' };
    const m = mpaSync(u8, p, end);
    if (m && m.len > 4 && p + m.len + 4 <= end && mpaSync(u8, p + m.len, end)) return { codec: m.layer === 3 ? 'mp3' : 'mp2', family: 'mpa' };
  }
  return null;
}

// ------------------------------------------------------------------ video access units

/**
 * Look at the first NAL units / start codes of a video access unit.
 * Returns { vcl: first VCL NAL type or picture type, key, recovery, sps, found }.
 * `found` is false when no picture data was seen (more bytes may be needed).
 */
export function videoKeyInfo(family, u8, start, end) {
  const res = { found: false, key: false, first: -1, recovery: false, types: [] };
  if (family === 'mpeg2v' || family === 'mpeg4v') {
    for (let i = start; i + 5 < end; i++) {
      if (u8[i] !== 0 || u8[i + 1] !== 0 || u8[i + 2] !== 1) continue;
      const code = u8[i + 3];
      if (family === 'mpeg2v' && code === 0x00) {
        const t = (u8[i + 5] >> 3) & 7;
        res.found = true;
        res.first = t;
        res.key = t === 1;
        return res;
      }
      if (family === 'mpeg4v' && code === 0xb6) {
        const t = u8[i + 4] >> 6;
        res.found = true;
        res.first = t;
        res.key = t === 0;
        return res;
      }
      i += 3;
    }
    return res;
  }
  const avc = family === 'avc';
  let i = start;
  while (i + 3 < end) {
    if (u8[i] !== 0 || u8[i + 1] !== 0 || u8[i + 2] !== 1) {
      i++;
      continue;
    }
    const h = i + 3;
    const type = avc ? u8[h] & 0x1f : (u8[h] >> 1) & 0x3f;
    if (res.types.length < 16) res.types.push(type);
    if (avc) {
      if (type >= 1 && type <= 5) {
        res.found = true;
        res.first = type;
        res.key = type === 5 || res.recovery;
        return res;
      }
      if (type === 6 && seiHasRecoveryPoint(u8, h + 1, Math.min(end, h + 4096))) res.recovery = true;
    } else if (type < 32) {
      res.found = true;
      res.first = type;
      res.key = h265.isIrap(type);
      return res;
    }
    i = h + 1;
  }
  return res;
}

/** Does this H.264 SEI NAL payload contain a recovery_point message (payloadType 6)? */
function seiHasRecoveryPoint(u8, start, end) {
  // Stop at the next start code: the SEI ends there.
  let stop = end;
  for (let i = start; i + 2 < end; i++) {
    if (u8[i] === 0 && u8[i + 1] === 0 && u8[i + 2] <= 1) {
      stop = i;
      break;
    }
  }
  const { rbsp } = toRbsp(u8, start, stop, 0);
  let p = 0;
  for (let guard = 0; guard < 32 && p + 2 <= rbsp.length; guard++) {
    let type = 0;
    while (p < rbsp.length && rbsp[p] === 0xff) type += rbsp[p++];
    if (p >= rbsp.length) break;
    type += rbsp[p++];
    let size = 0;
    while (p < rbsp.length && rbsp[p] === 0xff) size += rbsp[p++];
    if (p >= rbsp.length) break;
    size += rbsp[p++];
    if (type === 6) return true;
    p += size;
    if (p < rbsp.length && rbsp[p] === 0x80) break; // rbsp_trailing_bits
  }
  return false;
}

// ------------------------------------------------------------------ codec configuration

const FRAME_RATES = { 1: 24000 / 1001, 2: 24, 3: 25, 4: 30000 / 1001, 5: 30, 6: 50, 7: 60000 / 1001, 8: 60 };
const MPEG2_ASPECT = { 1: 'square samples (1:1)', 2: '4:3', 3: '16:9', 4: '2.21:1' };
const MPEG2_PROFILES = { 1: 'High', 2: 'Spatially Scalable', 3: 'SNR Scalable', 4: 'Main', 5: 'Simple' };
const MPEG2_LEVELS = { 4: 'High', 6: 'High 1440', 8: 'Main', 10: 'Low' };
const MPEG2_OTI = { 5: '60', 4: '61', 3: '62', 2: '63', 1: '64' };

/**
 * Codec details from the start of an elementary stream (the first PES payloads).
 * Returns { props: [[k, v]], codecString?, profile?, width?, height?, fps?, sampleRate?, channels?, state? }
 * or null when the configuration is not in these bytes (e.g. no SPS yet).
 */
export function probeConfig(family, u8, start, end) {
  try {
    if (family === 'avc' || family === 'hevc') return probeNalConfig(family, u8, start, end);
    if (family === 'mpeg2v') return probeMpeg2(u8, start, end);
    if (family === 'adts') {
      for (let p = start; p + 7 <= end; p++) {
        if (!adtsSync(u8, p, end)) continue;
        const h = parseAdts(u8, p, end, 0, []);
        const ch = h.channelConfig;
        return {
          codecString: `mp4a.40.${h.aot}`,
          profile: AOT[h.aot] ?? `object type ${h.aot}`,
          sampleRate: h.sampleRate,
          channels: ch,
          props: [
            ['profile', `${AOT[h.aot] ?? h.aot} (ADTS profile ${h.aot - 1})`],
            ['sample rate', `${fmtInt(h.sampleRate)} Hz`],
            ['channels', CHANNEL_CONFIG[ch] ?? String(ch)],
          ],
        };
      }
      return null;
    }
    if (family === 'ac3' || family === 'eac3') {
      for (let p = start; p + 8 <= end; p++) {
        const s = ac3Sync(u8, p, end);
        if (!s) continue;
        const info = ac3Details(u8, p, end);
        const props = [['sample rate', `${fmtInt(s.rate)} Hz`], ['channels', info.layout]];
        if (s.bitrate) props.push(['bitrate', `${s.bitrate / 1000} kb/s`]);
        else props.push(['bitrate', `${fmtNum((s.len * 8 * s.rate) / s.samples / 1000, 1)} kb/s (from the frame size)`]);
        props.push(['bsid', `${s.bsid} (${s.eac3 ? 'E-AC-3' : 'AC-3'})`]);
        return { codecString: s.eac3 ? 'ec-3' : 'ac-3', sampleRate: s.rate, channels: info.channels, props };
      }
      return null;
    }
    if (family === 'latm') {
      for (let p = start; p + 8 <= end; p++) {
        if (!latmSync(u8, p, end)) continue;
        const asc = latmConfig(u8, p, end);
        if (!asc) continue;
        const rate = asc.extSampleRate || asc.sampleRate;
        return {
          codecString: `mp4a.40.${asc.firstAot}`,
          profile: aacName(asc),
          sampleRate: rate,
          channels: asc.channels,
          props: [
            ['profile', `${aacName(asc)} (from the StreamMuxConfig in the LATM stream)`],
            ['sample rate', `${fmtInt(rate)} Hz`],
            ['channels', CHANNEL_CONFIG[asc.channelConfig] ?? String(asc.channelConfig)],
          ],
        };
      }
      return null;
    }
    if (family === 'mpa') {
      for (let p = start; p + 4 <= end; p++) {
        const s = mpaSync(u8, p, end);
        if (!s) continue;
        const h = parseMpegAudioHeader(u8, p, end, 0, []);
        const mode = ['stereo', 'joint stereo', 'dual channel', 'mono'][h.mode];
        return {
          codecString: s.mpeg1 ? 'mp4a.6B' : 'mp4a.69',
          layer: s.layer,
          sampleRate: s.rate,
          channels: h.mode === 3 ? 1 : 2,
          props: [
            ['format', `MPEG-${s.mpeg1 ? '1' : '2'} Audio Layer ${['', 'I', 'II', 'III'][s.layer]}`],
            ['sample rate', `${fmtInt(s.rate)} Hz`],
            ['channels', mode],
            ['bitrate', `${s.bitrate / 1000} kb/s`],
          ],
        };
      }
      return null;
    }
  } catch (e) {
    if (!(e instanceof ParseError)) throw e;
  }
  return null;
}

function probeNalConfig(family, u8, start, end) {
  const units = splitAnnexB(u8, start, end);
  const state = { spsById: new Map(), ppsById: new Map() };
  let sps = null;
  let spsUnit = null;
  const mod = family === 'avc' ? h264 : h265;
  for (const u of units) {
    const type = family === 'avc' ? u8[u.start] & 0x1f : (u8[u.start] >> 1) & 0x3f;
    if ((family === 'avc' && (type === 7 || type === 8)) || (family === 'hevc' && (type === 33 || type === 34))) {
      const res = mod.parseNalUnit(u8, u.start, u.end, 0, [], state);
      if (res.sps && !sps) {
        sps = res.sps;
        spsUnit = u;
      }
    }
  }
  if (!sps) return null;
  const out = { sps, width: sps.width, height: sps.height, fps: sps.vui?.fps, state, props: [] };
  if (family === 'avc') {
    out.codecString = h264.codecString('avc1', sps.profile_idc, sps.compat, sps.level_idc);
    out.profile = `${h264.profileName(sps.profile_idc, sps.compat)}@L${h264.levelName(sps.level_idc, sps.compat, sps.profile_idc)}`;
  } else {
    const { rbsp } = toRbsp(u8, spsUnit.start + 2, Math.min(spsUnit.end, spsUnit.start + 40), 0);
    const constraint = Array.from(rbsp.subarray(6, 12));
    out.codecString = h265.codecString('hvc1', { profile_space: sps.profile_space, profile_idc: sps.profile_idc, compat_flags: sps.compat_flags, tier: sps.tier, level_idc: sps.level_idc, constraint_bytes: constraint });
    out.profile = `${h265.PROFILES[sps.profile_idc] ?? sps.profile_idc}@L${h265.levelName(sps.level_idc)}${sps.tier ? ' High' : ''}`;
  }
  out.props.push(['profile', out.profile]);
  out.props.push(['coded size', `${sps.width}×${sps.height}`]);
  out.props.push(['chroma / depth', `${['4:0:0', '4:2:0', '4:2:2', '4:4:4'][sps.chroma_format_idc] ?? '?'}, ${sps.bit_depth_luma}-bit`]);
  if (family === 'avc' && sps.frame_mbs_only === 0) out.props.push(['scan', 'interlaced (field/MBAFF coding allowed)']);
  if (sps.vui?.sar && (sps.vui.sar[0] !== sps.vui.sar[1])) out.props.push(['pixel aspect', `${sps.vui.sar[0]}:${sps.vui.sar[1]}`]);
  if (sps.vui?.transfer !== undefined) out.props.push(['colour', `${colourSummary(sps.vui.primaries, sps.vui.transfer, sps.vui.matrix)}${sps.vui.full_range ? ', full range' : ''}`]);
  if (sps.vui?.fps) out.props.push(['frame rate (VUI)', `${fmtNum(sps.vui.fps, 3)} fps`]);
  return out;
}

function probeMpeg2(u8, start, end) {
  let seq = null;
  for (let i = start; i + 12 <= end; i++) {
    if (u8[i] !== 0 || u8[i + 1] !== 0 || u8[i + 2] !== 1) continue;
    const code = u8[i + 3];
    if (code === 0xb3) {
      const b = i + 4;
      seq = {
        width: (u8[b] << 4) | (u8[b + 1] >> 4),
        height: ((u8[b + 1] & 15) << 8) | u8[b + 2],
        aspect: u8[b + 3] >> 4,
        frc: u8[b + 3] & 15,
        bitrate: ((u8[b + 4] << 10) | (u8[b + 5] << 2) | (u8[b + 6] >> 6)) * 400,
      };
    } else if (code === 0xb5 && seq && u8[i + 4] >> 4 === 1) {
      const pl = ((u8[i + 4] & 15) << 4) | (u8[i + 5] >> 4);
      seq.profileLevel = pl;
      seq.progressive = (u8[i + 5] >> 3) & 1;
      seq.chroma = (u8[i + 5] >> 1) & 3;
      break;
    }
  }
  if (!seq) return null;
  const fps = FRAME_RATES[seq.frc];
  const props = [['coded size', `${seq.width}×${seq.height}`], ['aspect ratio', MPEG2_ASPECT[seq.aspect] ?? `code ${seq.aspect}`]];
  let profile;
  if (seq.profileLevel !== undefined && !(seq.profileLevel & 0x80)) {
    profile = `${MPEG2_PROFILES[(seq.profileLevel >> 4) & 7] ?? '?'}@${MPEG2_LEVELS[seq.profileLevel & 15] ?? '?'}`;
    props.unshift(['profile', `${profile} (MPEG-2)`]);
    props.push(['chroma', ['reserved', '4:2:0', '4:2:2', '4:4:4'][seq.chroma]]);
    props.push(['scan', seq.progressive ? 'progressive sequence' : 'interlaced (or mixed) sequence']);
  } else if (seq.profileLevel === undefined) {
    props.unshift(['profile', 'MPEG-1 (no sequence extension)']);
  }
  if (fps) props.push(['frame rate (sequence header)', `${fmtNum(fps, 3)} fps`]);
  if (seq.bitrate && seq.bitrate !== 0x3ffff * 400) props.push(['bitrate (sequence header)', `${fmtNum(seq.bitrate / 1e6, 2)} Mb/s`]);
  const oti = seq.profileLevel !== undefined ? MPEG2_OTI[(seq.profileLevel >> 4) & 7] : '6A';
  return { width: seq.width, height: seq.height, fps, profile, codecString: oti ? `mp4v.${oti}` : undefined, props };
}

/** Channel layout of an AC-3 / E-AC-3 frame. */
export function ac3Details(u8, p, end) {
  const r = new FieldReader(u8, 0, { start: p, end });
  const out = { channels: 0, layout: '?' };
  try {
    const bsid = u8[p + 5] >> 3;
    let acmod;
    let lfe;
    if (bsid <= 10) {
      // byte 5 = bsid(5) bsmod(3); byte 6 starts with acmod(3), then optional mix levels, then lfeon.
      r.pos = p + 6;
      acmod = r.bits(3, null);
      if ((acmod & 1) && acmod !== 1) r.bits(2, null); // cmixlev
      if (acmod & 4) r.bits(2, null); // surmixlev
      if (acmod === 2) r.bits(2, null); // dsurmod
      lfe = r.bits(1, null);
    } else {
      acmod = (u8[p + 4] >> 1) & 7;
      lfe = u8[p + 4] & 1;
    }
    out.channels = AC3_CHANNELS[acmod] + lfe;
    out.layout = `${AC3_ACMOD[acmod]}${lfe ? ' + LFE' : ''}`;
  } catch (e) {
    if (!(e instanceof ParseError)) throw e;
  }
  return out;
}

// ------------------------------------------------------------------ frame units not in web/codecs

const EAC3_STRMTYP = { 0: 'independent', 1: 'dependent (extra channels for the preceding frame)', 2: 'independent (converted from AC-3)', 3: 'reserved' };

/** E-AC-3 syncframe header (ETSI TS 102 366 Annex E bsi) as a frame unit. */
export function eac3Unit(u8, start, end, base) {
  const fields = [];
  const r = new FieldReader(u8, base, { start, end, out: fields });
  let summary = 'E-AC-3 frame';
  try {
    r.u16('syncword', { display: (v) => `0x${v.toString(16).toUpperCase()}`, expect: 0x0b77, role: 'header' });
    const st = r.bits(2, 'strmtyp', { enum: EAC3_STRMTYP, desc: 'Independent frames can be decoded alone; dependent substreams add channels (e.g. 7.1) to the independent frame before them.' });
    r.bits(3, 'substreamid');
    const fs = r.bits(11, 'frmsiz', { display: (v) => `${v} → ${(v + 1) * 2} bytes per frame`, desc: 'Frame size in 16-bit words, minus one.' });
    const fscod = r.bits(2, 'fscod', { enum: { 0: '48 kHz', 1: '44.1 kHz', 2: '32 kHz', 3: 'reduced rate (see fscod2)' } });
    let blocks = 6;
    if (fscod === 3) r.bits(2, 'fscod2', { enum: { 0: '24 kHz', 1: '22.05 kHz', 2: '16 kHz' } });
    else blocks = [1, 2, 3, 6][r.bits(2, 'numblkscod', { display: (v) => `${v} → ${[1, 2, 3, 6][v]} audio blocks (${[1, 2, 3, 6][v] * 256} samples)` })];
    const acmod = r.bits(3, 'acmod', { enum: AC3_ACMOD, desc: 'Audio coding mode: the main channel layout.' });
    const lfe = r.flag('lfeon', { desc: 'Low-frequency effects (subwoofer) channel present.' });
    r.bits(5, 'bsid', { desc: '16 for E-AC-3 (11–15 are also E-AC-3 compatible).' });
    r.bits(5, 'dialnorm', { display: (v) => `${v} → dialogue level −${v || 31} dBFS` });
    summary = `E-AC-3 ${EAC3_STRMTYP[st].split(' ')[0]}, ${AC3_ACMOD[acmod]}${lfe ? ' + LFE' : ''}, ${blocks * 256} samples, ${(fs + 1) * 2} bytes`;
    fields.push({ name: 'audio blocks', type: 'bytes', offset: base + r.pos + (r.bit ? 1 : 0), size: Math.max(0, end - r.pos - (r.bit ? 1 : 0)), value: null, display: `${fmtInt(end - r.pos)} bytes (rest of the bit stream information, then ${blocks} coded audio blocks)`, role: 'payload' });
  } catch (e) {
    if (!(e instanceof ParseError)) throw e;
  }
  return { title: 'E-AC-3 frame', offset: base + start, size: end - start, summary, fields };
}

const MPEG2_START_CODES = (c) => {
  if (c === 0x00) return 'picture_start_code';
  if (c >= 0x01 && c <= 0xaf) return `slice_start_code (row ${c})`;
  return { 0xb2: 'user_data_start_code', 0xb3: 'sequence_header_code', 0xb4: 'sequence_error_code', 0xb5: 'extension_start_code', 0xb7: 'sequence_end_code', 0xb8: 'group_start_code' }[c] ?? `start code 0x${HEX2[c]}`;
};

const EXTENSION_IDS = { 1: 'sequence_extension', 2: 'sequence_display_extension', 3: 'quant_matrix_extension', 4: 'copyright_extension', 5: 'sequence_scalable_extension', 7: 'picture_display_extension', 8: 'picture_coding_extension', 9: 'picture_spatial_scalable_extension', 10: 'picture_temporal_scalable_extension' };

/** Split an MPEG-1/2 video access unit on start codes and decode the headers. */
export function mpeg2Units(u8, start, end, base) {
  const units = [];
  const starts = [];
  for (let i = start; i + 3 < end; i++) {
    if (u8[i] === 0 && u8[i + 1] === 0 && u8[i + 2] === 1) {
      starts.push(i);
      i += 3;
    }
  }
  // Consecutive slices are grouped into one unit to keep the list short.
  let k = 0;
  if (starts.length && starts[0] > start) units.push({ title: 'leading bytes', offset: base + start, size: starts[0] - start, summary: 'bytes before the first start code', fields: [] });
  while (k < starts.length) {
    const s = starts[k];
    const code = u8[s + 3];
    let e = k + 1 < starts.length ? starts[k + 1] : end;
    let n = 1;
    if (code >= 0x01 && code <= 0xaf) {
      while (k + n < starts.length && u8[starts[k + n] + 3] >= 0x01 && u8[starts[k + n] + 3] <= 0xaf) n++;
      e = k + n < starts.length ? starts[k + n] : end;
    }
    const fields = [];
    const r = new FieldReader(u8, base, { start: s, end: e, out: fields });
    let title = MPEG2_START_CODES(code);
    let summary = title;
    try {
      r.bytes('start_code_prefix', 3, { display: '00 00 01', role: 'header' });
      r.u8('start_code', { display: (v) => `0x${HEX2[v]} — ${MPEG2_START_CODES(v)}`, role: 'header' });
      if (code === 0xb3) {
        title = 'sequence header';
        const w = r.bits(12, 'horizontal_size_value', { key: true, unit: 'pixels' });
        const h = r.bits(12, 'vertical_size_value', { key: true, unit: 'pixels' });
        r.bits(4, 'aspect_ratio_information', { enum: MPEG2_ASPECT });
        const frc = r.bits(4, 'frame_rate_code', { display: (v) => `${v} → ${FRAME_RATES[v] ? fmtNum(FRAME_RATES[v], 3) : 'reserved'} fps` });
        r.bits(18, 'bit_rate_value', { display: (v) => `${fmtInt(v)} × 400 b/s = ${fmtNum((v * 400) / 1e6, 2)} Mb/s` });
        r.bits(1, 'marker_bit');
        r.bits(10, 'vbv_buffer_size_value', { display: (v) => `${v} × 16 kbit` });
        r.flag('constrained_parameters_flag');
        summary = `sequence header: ${w}×${h}, ${FRAME_RATES[frc] ? fmtNum(FRAME_RATES[frc], 3) : '?'} fps`;
      } else if (code === 0xb5) {
        const id = r.bits(4, 'extension_start_code_identifier', { enum: EXTENSION_IDS });
        title = EXTENSION_IDS[id] ?? 'extension';
        if (id === 1) {
          r.u8('profile_and_level_indication', { display: (v) => `0x${HEX2[v]} → ${MPEG2_PROFILES[(v >> 4) & 7] ?? '?'}@${MPEG2_LEVELS[v & 15] ?? '?'}` });
          r.flag('progressive_sequence');
          r.bits(2, 'chroma_format', { enum: { 1: '4:2:0', 2: '4:2:2', 3: '4:4:4' } });
        } else if (id === 8) {
          r.bits(16, 'f_codes', { display: (v) => `0x${v.toString(16)}` });
          r.bits(2, 'intra_dc_precision', { display: (v) => `${v} → ${v + 8} bits` });
          const ps = r.bits(2, 'picture_structure', { enum: { 1: 'top field', 2: 'bottom field', 3: 'frame picture' } });
          r.flag('top_field_first');
          summary = `picture coding extension (${{ 1: 'top field', 2: 'bottom field', 3: 'frame' }[ps] ?? '?'})`;
        }
        if (summary === MPEG2_START_CODES(code)) summary = title;
      } else if (code === 0xb8) {
        title = 'GOP header';
        const tc = r.bits(25, 'time_code', { display: (v) => `${(v >> 19) & 31}:${String((v >> 13) & 63).padStart(2, '0')}:${String((v >> 6) & 63).padStart(2, '0')}:${String(v & 63).padStart(2, '0')}${v >> 24 ? ' (drop frame)' : ''}` });
        const closed = r.flag('closed_gop', { desc: '1 = B-pictures right after the I-picture do not reference the previous GOP.' });
        r.flag('broken_link');
        summary = `GOP ${closed ? '(closed)' : '(open)'} ${(tc >> 19) & 31}:${String((tc >> 13) & 63).padStart(2, '0')}:${String((tc >> 6) & 63).padStart(2, '0')}:${String(tc & 63).padStart(2, '0')}`;
      } else if (code === 0x00) {
        title = 'picture header';
        const tr = r.bits(10, 'temporal_reference', { desc: 'Display order of this picture within the GOP.' });
        const t = r.bits(3, 'picture_coding_type', { key: true, enum: { 1: 'I (intra)', 2: 'P (predicted)', 3: 'B (bidirectional)', 4: 'D (DC intra)' } });
        r.u16('vbv_delay');
        summary = `${['?', 'I', 'P', 'B', 'D'][t] ?? '?'}-picture, temporal_reference ${tr}`;
      } else if (code >= 0x01 && code <= 0xaf) {
        title = n > 1 ? `slices ${code}–${u8[starts[k + n - 1] + 3]}` : `slice ${code}`;
        summary = `${n} slice${n === 1 ? '' : 's'} of coded macroblocks`;
      } else if (code === 0xb2) {
        title = 'user data';
        const txt = u8.subarray(r.pos, Math.min(e, r.pos + 8));
        summary = String.fromCharCode(...txt).startsWith('GA94') ? 'user data (ATSC GA94: closed captions / bar data)' : 'user data';
      }
      if (r.bit) r.align('padding');
      if (r.pos < e) fields.push({ name: 'data', type: 'bytes', offset: base + r.pos, size: e - r.pos, value: null, display: `${fmtInt(e - r.pos)} bytes`, role: 'payload' });
    } catch (err) {
      if (!(err instanceof ParseError)) throw err;
    }
    units.push({ title, offset: base + s, size: e - s, summary, fields, key: code === 0x00 && ((u8[s + 5] >> 3) & 7) === 1 });
    k += n;
  }
  return units;
}

/** LOAS/LATM frame header (and its StreamMuxConfig, when present) as a unit. */
export function latmUnit(u8, start, end, base) {
  const fields = [];
  const r = new FieldReader(u8, base, { start, end, out: fields });
  let summary = `LATM frame, ${fmtInt(end - start)} bytes`;
  try {
    r.bits(11, 'syncword', { display: (v) => `0x${v.toString(16).toUpperCase()}`, expect: 0x2b7, role: 'header', desc: 'LOAS AudioSyncStream sync word 0x2B7.' });
    r.bits(13, 'audioMuxLengthBytes', { unit: 'bytes', role: 'header', desc: 'Length of the AudioMuxElement that follows.' });
    const same = r.flag('useSameStreamMux', { desc: '0 = a StreamMuxConfig (with the AudioSpecificConfig) follows; 1 = reuse the last one.' });
    if (!same) {
      r.group('StreamMuxConfig', (g) => {
        const v = r.flag('audioMuxVersion');
        if (v) {
          g.display = 'audioMuxVersion 1 (not decoded further)';
          return;
        }
        r.flag('allStreamsSameTimeFraming');
        r.bits(6, 'numSubFrames', { display: (x) => `${x} → ${x + 1} sub-frame${x ? 's' : ''} per frame` });
        r.bits(4, 'numProgram');
        r.bits(3, 'numLayer');
        r.group('AudioSpecificConfig', (a) => {
          const asc = parseAudioSpecificConfig(r);
          a.display = `${aacName(asc)}, ${fmtInt(asc.extSampleRate || asc.sampleRate)} Hz, ${CHANNEL_CONFIG[asc.channelConfig] ?? asc.channelConfig}`;
          g.display = a.display;
          summary = `LATM frame with config: ${a.display}`;
        });
      });
    }
    const at = r.bit ? r.pos + 1 : r.pos;
    if (at < end) fields.push({ name: 'payload', type: 'bytes', offset: base + at, size: end - at, value: null, display: `${fmtInt(end - at)} bytes`, role: 'payload', desc: 'The rest of the AudioMuxElement: remaining mux configuration bits, the payload length, then the raw AAC frame.' });
  } catch (e) {
    if (!(e instanceof ParseError)) throw e;
  }
  return { title: 'LOAS/LATM frame', offset: base + start, size: end - start, summary, fields };
}
