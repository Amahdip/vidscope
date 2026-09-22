// WAV: one audio track described by 'fmt ', stored in 'data'. The duration is
// implied by the data size and the byte rate (or by fact / ds64 for compressed
// and 64-bit files). detailAt() decodes the sample frame (or ADPCM block, or
// MP3 frame) at any byte of the data chunk.

import { FieldReader } from '../../core/fields.js';
import { fmtInt, fmtNum, fmtHz, fmtBitrate, fmtDuration, hex } from '../../core/util.js';
import { parseMpegAudioHeader } from '../../codecs/audio.js';
import { aacName } from '../../codecs/mpeg4audio.js';
import { channelMaskText, SPEAKERS, FORMAT_TAGS } from './tables.js';

/** Duration and sizes of the audio, from the most reliable source available. */
export function wavTiming(ctx) {
  const a = ctx.fmt;
  const data = ctx.dataNode;
  const out = { dataStart: null, dataSize: 0, declared: 0 };
  if (data) {
    out.dataStart = data.bodyOffset;
    out.dataSize = data.data.bodyEnd - data.bodyOffset;
    out.declared = ctx.ds64 && data.data.declared === 0xffffffff ? ctx.ds64.dataSize : data.data.declared;
  }
  if (!a) return out;
  const tag = a.subTag ?? a.tag;
  const pcm = tag === 1 || tag === 3 || tag === 6 || tag === 7;
  if (pcm && a.blockAlign && a.sampleRate) {
    out.frames = Math.floor(out.dataSize / a.blockAlign);
    out.duration = out.frames / a.sampleRate;
    out.source = 'data size ÷ (nSamplesPerSec × nBlockAlign)';
  } else if (ctx.ds64?.sampleCount && a.sampleRate) {
    out.frames = ctx.ds64.sampleCount;
    out.duration = out.frames / a.sampleRate;
    out.source = 'ds64 sampleCount ÷ nSamplesPerSec';
  } else if (ctx.factSamples && a.sampleRate) {
    out.frames = ctx.factSamples;
    out.duration = out.frames / a.sampleRate;
    out.source = 'fact dwSampleLength ÷ nSamplesPerSec';
  } else if (a.byteRate) {
    out.duration = out.dataSize / a.byteRate;
    out.source = 'data size ÷ nAvgBytesPerSec (approximate for compressed audio)';
  }
  return out;
}

export function analyzeWav(doc, ctx) {
  const a = ctx.fmt;
  const timing = wavTiming(ctx);
  doc.wav = timing;
  if (!a) {
    doc.summary.duration = null;
    return;
  }
  const tag = a.subTag ?? a.tag;
  const codecName = a.asc ? aacName(a.asc) : a.codec.name;
  const t = {
    id: 0,
    index: 0,
    kind: 'audio',
    codec: `0x${a.tag.toString(16).padStart(4, '0')}`,
    codecName,
    label: `Audio 1 – ${codecName}`,
    node: ctx.dataNode ?? ctx.fmtNode,
    sampleCfg: { family: a.codec.family },
    timescale: a.sampleRate,
    duration: timing.duration ?? null,
  };
  const p = [];
  const hex4 = (v) => `0x${v.toString(16).toUpperCase().padStart(4, '0')}`;
  p.push(['format', a.tag === 0xfffe
    ? `${a.subTag !== undefined ? FORMAT_TAGS[a.subTag] ?? hex4(a.subTag) : 'unknown SubFormat'} (WAVE_FORMAT_EXTENSIBLE${a.subTag !== undefined ? `, SubFormat ${hex4(a.subTag)}` : ''})${a.ambisonic ? ', Ambisonic B-format' : ''}`
    : `${FORMAT_TAGS[a.tag] ?? 'unknown'} (wFormatTag ${hex4(a.tag)})`]);
  p.push(['sample rate', fmtHz(a.sampleRate)]);
  p.push(['channels', `${a.channels}${a.channelMask !== undefined ? ` (${channelMaskText(a.channelMask)})` : a.channels <= 2 ? ` (${a.channels === 1 ? 'mono' : 'stereo'}, implied)` : ' (no channel mask: layout unknown)'}`]);
  if (tag === 1 || tag === 3) {
    p.push(['sample format', `${a.validBits && a.validBits !== a.bits ? `${a.validBits} valid bits in ` : ''}${a.bits}-bit ${tag === 3 ? 'IEEE float' : a.bits === 8 ? 'unsigned integer' : 'signed integer'}, little-endian${ctx.le ? '' : ' (RIFX: big-endian)'}`]);
  } else if (a.bits) {
    p.push(['bits per sample', String(a.bits)]);
  }
  p.push(['block align', `${a.blockAlign} bytes${tag === 1 || tag === 3 ? ' (one sample frame)' : ''}`]);
  p.push(['data rate', `${fmtInt(a.byteRate)} bytes/s (${fmtBitrate(a.byteRate * 8)})`]);
  if (a.samplesPerBlock) p.push(['samples per block', fmtInt(a.samplesPerBlock)]);
  if (timing.dataStart !== null) p.push(['audio data', `${fmtInt(timing.dataSize)} bytes at ${fmtInt(timing.dataStart)} (${hex(timing.dataStart)})`]);
  if (timing.frames !== undefined) p.push(['sample frames', fmtInt(timing.frames)]);
  if (timing.duration !== undefined) p.push(['duration', `${fmtDuration(timing.duration)} (${timing.source})`]);
  if (ctx.bext) {
    const b = ctx.bext;
    if (b.originator) p.push(['originator', b.originator]);
    if (b.date || b.time) p.push(['recorded', `${b.date} ${b.time}`.trim()]);
    if (a.sampleRate) p.push(['time reference', `${fmtDuration(b.timeReference / a.sampleRate)} after midnight (${fmtInt(b.timeReference)} samples)`]);
    if (b.version >= 2 && b.loudness !== 0x7fff && b.loudness) p.push(['loudness', `${fmtNum(b.loudness / 100, 2)} LUFS`]);
  }
  t.props = p;
  if (ctx.dataNode) ctx.dataNode.data.summary = `${fmtInt(timing.dataSize)} bytes${timing.duration !== undefined ? ` → ${fmtDuration(timing.duration)}` : ''}`;
  doc.tracks = [t];
  if (t.node) t.node.label = t.label;
  doc.summary.duration = timing.duration ?? null;
}

// ------------------------------------------------------------ detail inside data

function sampleValue(dv, p, bits, float, le) {
  if (float) return bits === 64 ? dv.getFloat64(p, le) : dv.getFloat32(p, le);
  switch (bits) {
    case 8: return dv.getUint8(p) - 128;
    case 16: return dv.getInt16(p, le);
    case 24: {
      const v = le ? dv.getUint8(p) | (dv.getUint8(p + 1) << 8) | (dv.getUint8(p + 2) << 16) : (dv.getUint8(p) << 16) | (dv.getUint8(p + 1) << 8) | dv.getUint8(p + 2);
      return v & 0x800000 ? v - 0x1000000 : v;
    }
    case 32: return dv.getInt32(p, le);
    default: return null;
  }
}

function channelNames(a) {
  const names = [];
  if (a.channelMask) {
    for (let b = 0; b < SPEAKERS.length && names.length < a.channels; b++) if (a.channelMask & (1 << b)) names.push(SPEAKERS[b][0]);
  } else if (a.channels === 2) names.push('L', 'R');
  else if (a.channels === 1) names.push('mono');
  while (names.length < a.channels) names.push(`ch ${names.length + 1}`);
  return names;
}

/** The sample frame, ADPCM block or MP3 frame at `offset` in the data chunk. */
export async function wavDetail(doc, offset) {
  const ctx = doc.ctx;
  const a = ctx.fmt;
  const w = doc.wav;
  if (!a || w?.dataStart === null || offset < w.dataStart || offset >= w.dataStart + w.dataSize) return null;
  const tag = a.subTag ?? a.tag;
  const rel = offset - w.dataStart;
  if ((tag === 1 || tag === 3) && a.blockAlign && a.bits) {
    const frame = Math.floor(rel / a.blockAlign);
    const start = w.dataStart + frame * a.blockAlign;
    const bytes = await doc.source.read(start, a.blockAlign);
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const bps = Math.ceil(a.bits / 8);
    const names = channelNames(a);
    const float = tag === 3;
    const fields = [];
    const vals = [];
    for (let c = 0; c < a.channels && (c + 1) * bps <= bytes.length; c++) {
      const v = sampleValue(dv, c * bps, a.bits, float, ctx.le);
      const full = float ? 1 : 2 ** (a.bits - 1);
      const dbfs = v ? 20 * Math.log10(Math.abs(v) / full) : -Infinity;
      vals.push(`${names[c]} ${float ? fmtNum(v, 6) : fmtInt(v)}`);
      fields.push({
        name: names[c],
        type: float ? `float${a.bits}` : a.bits === 8 ? 'uint8' : `int${a.bits}`,
        offset: start + c * bps,
        size: bps,
        value: v,
        display: `${float ? fmtNum(v, 6) : fmtInt(v)}${Number.isFinite(dbfs) ? ` (${fmtNum(dbfs, 1)} dBFS)` : ' (silence)'}`,
        desc: `Sample of channel ${c + 1} (${names[c]})${a.bits === 8 ? '; 8-bit PCM is unsigned, 128 is silence (shown here minus 128)' : ''}.`,
        key: true,
      });
    }
    const unit = { title: `Sample frame ${fmtInt(frame)}`, offset: start, size: a.blockAlign, summary: vals.join(', '), fields };
    const d = {
      kind: 'sample',
      title: `Sample frame ${fmtInt(frame)} · ${doc.tracks[0]?.label ?? 'audio'}`,
      subtitle: doc.tracks[0]?.codecName,
      range: [start, start + a.blockAlign],
      rows: [
        ['position', `byte ${fmtInt(rel)} of the data (${hex(offset)})`],
        ['sample frame', `${fmtInt(frame)} of ${fmtInt(w.frames ?? 0)} (= byte ${fmtInt(rel)} ÷ nBlockAlign ${a.blockAlign})`],
        ['time', `${fmtDuration(frame / a.sampleRate)} (frame ÷ ${fmtInt(a.sampleRate)} Hz)`],
        ['values', vals.join(', ')],
      ],
      units: [unit],
      text: 'PCM has no frames or headers: each sample frame holds one sample per channel, channels interleaved. Vidscope decodes the frame under the cursor.',
    };
    const c = Math.floor((offset - start) / bps);
    if (c < fields.length) d.hit = { unit: 0, fields: [{ f: fields[c], parents: [] }] };
    return d;
  }
  if ((tag === 0x11 || tag === 0x02) && a.blockAlign > 4) return adpcmDetail(doc, a, w, rel, tag);
  if (tag === 0x55 || tag === 0x50) return mp3Detail(doc, a, w, offset);
  return {
    kind: 'gap',
    title: 'Audio data',
    range: [w.dataStart, w.dataStart + w.dataSize],
    rows: [['codec', doc.tracks[0]?.codecName ?? '?'], ['position', `byte ${fmtInt(rel)} of the data`]],
    text: 'Vidscope does not decode the frames of this audio format.',
  };
}

async function adpcmDetail(doc, a, w, rel, tag) {
  const block = Math.floor(rel / a.blockAlign);
  const start = w.dataStart + block * a.blockAlign;
  const size = Math.min(a.blockAlign, w.dataStart + w.dataSize - start);
  const bytes = await doc.source.read(start, size);
  const fields = [];
  const r = new FieldReader(bytes, start, { out: fields, le: true });
  const names = channelNames(a);
  try {
    if (tag === 0x11) {
      for (let c = 0; c < a.channels; c++) {
        r.group(`header ${names[c]}`, () => {
          r.i16('sample', { desc: 'The first decoded sample of the block, stored uncompressed: the predictor starts from here.' });
          r.u8('step_index', { desc: 'Index (0–88) into the IMA step-size table for the first 4-bit code.' });
          r.u8('reserved', { reserved: true });
        });
      }
      r.rest('4-bit codes', { desc: `ADPCM codes, 4 bits per sample; channels interleaved in groups of 4 bytes (8 samples) for stereo. The block decodes to ${fmtInt(a.samplesPerBlock ?? 0)} samples per channel.` });
    } else {
      for (let c = 0; c < a.channels; c++) r.u8(`bPredictor ${names[c]}`, { desc: 'Which of the coefficient pairs in fmt this block uses.' });
      for (let c = 0; c < a.channels; c++) r.i16(`iDelta ${names[c]}`, { desc: 'Initial quantisation step.' });
      for (let c = 0; c < a.channels; c++) r.i16(`iSamp1 ${names[c]}`, { desc: 'Second sample of the block, uncompressed.' });
      for (let c = 0; c < a.channels; c++) r.i16(`iSamp2 ${names[c]}`, { desc: 'First sample of the block, uncompressed.' });
      r.rest('4-bit codes', { desc: 'ADPCM codes, 4 bits per sample, channels interleaved nibble by nibble.' });
    }
  } catch {
    // A short last block: show what there is.
  }
  const spb = a.samplesPerBlock || 0;
  return {
    kind: 'sample',
    title: `ADPCM block ${fmtInt(block)} · ${doc.tracks[0]?.label ?? 'audio'}`,
    subtitle: doc.tracks[0]?.codecName,
    range: [start, start + size],
    rows: [
      ['block', `${fmtInt(block)} (${fmtInt(a.blockAlign)} bytes each)`],
      ['time', spb ? `${fmtDuration((block * spb) / a.sampleRate)} (${fmtInt(spb)} samples per block)` : '—'],
    ],
    units: [{ title: `Block ${fmtInt(block)}`, offset: start, size, summary: `${fmtInt(size)} bytes`, fields }],
    text: 'ADPCM audio is cut into fixed-size blocks (nBlockAlign bytes). Each block starts with a small header per channel so it can be decoded on its own, which is what makes seeking possible.',
  };
}

async function mp3Detail(doc, a, w, offset) {
  const from = Math.max(w.dataStart, offset - 4608);
  const bytes = await doc.source.read(from, offset - from + 4);
  for (let p = offset - from; p >= 0; p--) {
    if (bytes[p] !== 0xff || (bytes[p + 1] & 0xe0) !== 0xe0) continue;
    const fields = [];
    const h = parseMpegAudioHeader(bytes, p, bytes.length, from, fields);
    if (!h.frameLength || h.error) continue;
    if (from + p + h.frameLength <= offset) continue;
    return {
      kind: 'sample',
      title: `MPEG audio frame · ${doc.tracks[0]?.label ?? 'audio'}`,
      subtitle: h.summary,
      range: [from + p, from + p + h.frameLength],
      rows: [['frame starts at', `${fmtInt(from + p)} (${hex(from + p)})`], ['frame length', `${fmtInt(h.frameLength)} bytes`], ['bitrate', fmtBitrate(h.bitrate)]],
      units: [{ title: 'MPEG audio frame', offset: from + p, size: h.frameLength, summary: h.summary, fields }],
    };
  }
  return null;
}
