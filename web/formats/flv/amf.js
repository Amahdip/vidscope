// AMF0 (Action Message Format, version 0): the serialisation Flash used for
// script data. FLV stores onMetaData and other script tags as AMF0 values:
// a one-byte type marker followed by the value, all big-endian.
// Reference: Adobe, "Action Message Format -- AMF 0" (2007) and the
// SCRIPTDATA section of the FLV specification.

import { ParseError } from '../../core/fields.js';
import { fmtInt, fmtNum, fmtDuration, decodeText, fmtDate } from '../../core/util.js';

export const AMF0 = {
  0: 'Number (double)', 1: 'Boolean', 2: 'String', 3: 'Object', 4: 'MovieClip (reserved)', 5: 'Null',
  6: 'Undefined', 7: 'Reference', 8: 'ECMA array', 9: 'Object end', 10: 'Strict array', 11: 'Date',
  12: 'Long string', 13: 'Unsupported', 14: 'RecordSet (reserved)', 15: 'XML document', 16: 'Typed object',
  17: 'AVM+ (switch to AMF3)',
};

const MAX_DEPTH = 12;
const MAX_ITEMS = 100000;
const MAX_FIELD_ITEMS = 2000;

const VIDEO_CODEC_IDS = { 2: 'Sorenson H.263', 3: 'Screen video', 4: 'On2 VP6', 5: 'On2 VP6 with alpha', 6: 'Screen video v2', 7: 'AVC (H.264)', 12: 'HEVC (non-standard)' };
const AUDIO_CODEC_IDS = { 0: 'Linear PCM, platform endian', 1: 'ADPCM', 2: 'MP3', 3: 'Linear PCM, little endian', 4: 'Nellymoser 16 kHz', 5: 'Nellymoser 8 kHz', 6: 'Nellymoser', 7: 'G.711 A-law', 8: 'G.711 µ-law', 10: 'AAC', 11: 'Speex', 14: 'MP3 8 kHz', 15: 'device-specific' };

function fourccOfNumber(v) {
  if (!Number.isInteger(v) || v < 0x20202020 || v > 0x7e7e7e7e) return null;
  const s = String.fromCharCode((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
  return /^[\x20-\x7e]{4}$/.test(s) ? s : null;
}

/** How a well-known onMetaData number reads to a person. */
export function metaDisplay(key, v) {
  if (typeof v !== 'number') return null;
  switch (key) {
    case 'duration': case 'lasttimestamp': case 'lastkeyframetimestamp':
      return `${fmtNum(v, 3)} s (${fmtDuration(v)})`;
    case 'width': case 'height': return `${fmtNum(v, 2)} pixels`;
    case 'framerate': case 'videoframerate': return `${fmtNum(v, 3)} frames/s`;
    case 'videodatarate': case 'audiodatarate': return `${fmtNum(v, 3)} kb/s`;
    case 'filesize': case 'datasize': case 'videosize': case 'audiosize': return `${fmtInt(v)} bytes`;
    case 'audiosamplerate': return `${fmtInt(v)} Hz`;
    case 'audiosamplesize': return `${fmtInt(v)} bits`;
    case 'lastkeyframelocation': return `byte ${fmtInt(v)}`;
    case 'videocodecid': {
      const f = fourccOfNumber(v);
      return f ? `${fmtInt(v)} → '${f}' (Enhanced RTMP FourCC)` : `${fmtInt(v)} → ${VIDEO_CODEC_IDS[v] ?? 'unknown codec ID'}`;
    }
    case 'audiocodecid': {
      const f = fourccOfNumber(v);
      return f ? `${fmtInt(v)} → '${f}' (Enhanced RTMP FourCC)` : `${fmtInt(v)} → ${AUDIO_CODEC_IDS[v] ?? 'unknown codec ID'}`;
    }
    default: return null;
  }
}

const META_DESC = {
  duration: 'Length of the file in seconds, written by the muxer (after the fact, so a live-recorded file may say 0).',
  width: 'Width of the video in pixels.',
  height: 'Height of the video in pixels.',
  framerate: 'Frame rate in frames per second.',
  videodatarate: 'Video bitrate in kilobits per second.',
  audiodatarate: 'Audio bitrate in kilobits per second.',
  videocodecid: 'Video CodecID as in the video tags (7 = AVC), or a FourCC number for Enhanced RTMP codecs.',
  audiocodecid: 'Audio SoundFormat as in the audio tags (10 = AAC, 2 = MP3), or a FourCC number for Enhanced RTMP codecs.',
  audiosamplerate: 'Audio sample rate in Hz.',
  audiosamplesize: 'Bits per audio sample.',
  stereo: 'True for stereo audio.',
  encoder: 'Software that wrote the file.',
  filesize: 'Total file size in bytes, as the muxer saw it.',
  keyframes: 'Seek index added by tools such as yamdi, flvtool2 or FFmpeg (-flvflags add_keyframe_index): the file position and time of every key frame, so a player can seek in a progressive download without scanning the file.',
  filepositions: 'Byte offset of each key frame tag.',
  times: 'Time of each key frame, in seconds.',
  canSeekToEnd: 'True when the last video frame is a key frame.',
  hasKeyframes: 'True when a keyframes index is present.',
  lasttimestamp: 'Timestamp of the last tag, in seconds.',
  lastkeyframetimestamp: 'Timestamp of the last key frame, in seconds.',
  lastkeyframelocation: 'File position of the last key frame.',
};

/**
 * Read one AMF0 value, recording its fields. Returns the decoded JS value
 * (objects and ECMA arrays as plain objects, strict arrays as arrays).
 */
export function readAmf(r, name, o = {}, depth = 0) {
  if (depth > MAX_DEPTH) throw new ParseError('AMF0 data nested too deeply', r.abs);
  const key = o.key ?? name;
  let value;
  r.group(name, (g) => {
    const marker = r.u8('type', { enum: AMF0, desc: 'AMF0 type marker: which kind of value follows.' });
    value = readBody(r, marker, depth, key, g);
  }, { desc: o.desc ?? META_DESC[key] });
  return value;
}

function amfString(r, name, long = false) {
  const len = long ? r.u32(`${name} length`, { unit: 'bytes' }) : r.u16(`${name} length`, { unit: 'bytes' });
  r.need(len, name);
  const v = decodeText(r.u.subarray(r.pos, r.pos + len), 'utf-8');
  if (len) r.bytes(name, len, { display: `"${v.length > 200 ? `${v.slice(0, 200)}…` : v}"` });
  return v;
}

function readBody(r, marker, depth, key, g) {
  if (depth > MAX_DEPTH) throw new ParseError('AMF0 data nested too deeply', r.abs);
  switch (marker) {
    case 0: {
      const v = r.f64('value', { display: (x) => metaDisplay(key, x) ?? fmtNum(x, 6), desc: META_DESC[key] });
      g.display = metaDisplay(key, v) ?? fmtNum(v, 6);
      return v;
    }
    case 1: {
      const v = !!r.u8('value', { display: (x) => (x ? 'true' : 'false') });
      g.display = String(v);
      return v;
    }
    case 2: case 12: case 15: {
      const v = amfString(r, 'value', marker !== 2);
      g.display = `"${v.length > 80 ? `${v.slice(0, 80)}…` : v}"`;
      return v;
    }
    case 3: case 8: case 16: {
      if (marker === 16) amfString(r, 'class name');
      if (marker === 8) r.u32('approximate count', { desc: 'Number of properties the writer announces; readers rely on the end marker instead.' });
      const obj = {};
      let n = 0;
      while (r.remaining >= 3) {
        if (r.u[r.pos] === 0 && r.u[r.pos + 1] === 0 && r.u[r.pos + 2] === 9) {
          r.group('end', () => {
            r.u16('empty name');
            r.u8('type', { enum: AMF0 });
          }, { desc: 'Object end: an empty property name followed by marker 9.' });
          break;
        }
        if (n++ > MAX_ITEMS) throw new ParseError('too many AMF0 properties', r.abs);
        const nameLen = r.dv.getUint16(r.pos);
        const prop = decodeText(r.u.subarray(r.pos + 2, r.pos + 2 + nameLen), 'utf-8');
        r.group(prop || '(empty name)', (pg) => {
          amfString(r, 'name');
          const m = r.u8('type', { enum: AMF0 });
          obj[prop] = readBody(r, m, depth + 1, prop, pg);
        }, { desc: META_DESC[prop] });
      }
      g.display = `${marker === 8 ? 'ECMA array' : 'object'}, ${Object.keys(obj).length} properties`;
      return obj;
    }
    case 10: {
      const count = r.u32('count', { desc: 'Number of values that follow.' });
      // Arrays of numbers (keyframes.times / filepositions) can be huge: show them as a table.
      let allNumbers = count > 0 && r.remaining >= count * 9;
      for (let i = 0; allNumbers && i < count; i++) if (r.u[r.pos + i * 9] !== 0) allNumbers = false;
      if (allNumbers) {
        const arr = new Float64Array(count);
        for (let i = 0; i < count; i++) arr[i] = r.dv.getFloat64(r.pos + i * 9 + 1);
        r.table('values', count, 9, [
          { name: 'type', type: 'u8', enum: { 0: 'Number' } },
          { name: 'value', type: 'f64', display: (x) => metaDisplay(key === 'times' ? 'duration' : key === 'filepositions' ? 'lastkeyframelocation' : key, x) ?? fmtNum(x, 6) },
        ], { desc: 'Each value is a type marker (0 = Number) and an 8-byte big-endian double.' });
        g.display = `${fmtInt(count)} numbers`;
        return arr;
      }
      const out = [];
      for (let i = 0; i < count && r.remaining > 0; i++) {
        if (i >= MAX_FIELD_ITEMS) {
          r.rest('more values', { desc: `The remaining ${fmtInt(count - i)} values are not listed.` });
          break;
        }
        out.push(readAmf(r, `[${i}]`, { key }, depth + 1));
      }
      g.display = `${fmtInt(count)} values`;
      return out;
    }
    case 11: {
      const ms = r.f64('milliseconds', { desc: 'Milliseconds since 1970-01-01 UTC.' });
      r.i16('timezone', { unit: 'minutes', desc: 'Time-zone offset; should be 0 and is ignored by readers.' });
      const d = new Date(ms);
      g.display = Number.isNaN(d.getTime()) ? String(ms) : fmtDate(d);
      return d;
    }
    case 7: {
      const v = r.u16('index', { desc: 'Refers to an earlier object in the same message by its index.' });
      g.display = `reference #${v}`;
      return { ref: v };
    }
    case 5: case 6: case 13: case 9:
      g.display = AMF0[marker];
      return null;
    case 17:
      if (r.remaining > 0) r.rest('AMF3 data', { desc: 'An AMF3-encoded value, which Vidscope does not decode.' });
      g.display = 'AMF3 value';
      return null;
    default:
      throw new ParseError(`unknown AMF0 type marker ${marker}`, r.abs);
  }
}

