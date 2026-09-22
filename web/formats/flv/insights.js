// File insights for FLV: onMetaData compared with the actual stream (duration,
// picture size, frame rate, file size, keyframes index), codecs, timestamp
// monotonicity and gaps, interleaving, and PreviousTagSize consistency.

import { walk } from '../../core/model.js';
import { fmtInt, fmtNum, fmtBitrate, fmtDuration, hex } from '../../core/util.js';
import { headOf } from './scan.js';
import { codecName, CODEC_IDS, SOUND_FORMATS } from './tags.js';
import { metaDisplay } from './amf.js';

const q = (s) => `"${String(s).replace(/"/g, '\\"')}"`;
const fixName = (name, suffix) => name.replace(/(\.\w+)?$/, `-${suffix}$1`);

export async function insights(doc) {
  const out = [];
  try {
    await doc.loadSamples();
    overview(doc, out);
    metadata(doc, out);
    await codecs(doc, out);
    timing(doc, out);
    integrity(doc, out);
  } catch (e) {
    out.push({ level: 'warn', group: 'Integrity', title: 'Analysis stopped early', text: `Vidscope could not finish analysing this file: ${e.message}` });
  }
  return out;
}

function tagCounts(scan) {
  const c = { script: 0, video: 0, audio: 0, other: 0, config: 0, frames: 0, empty: 0, command: 0, meta: 0, encrypted: 0, unsupported: 0 };
  for (let k = 0; k < scan.count; k++) {
    const t = scan.types[k];
    if (t === 18) c.script++;
    else if (t === 9) c.video++;
    else if (t === 8) c.audio++;
    else c.other++;
    if (scan.flags[k]) {
      c.encrypted++;
      continue;
    }
    if (t === 8 || t === 9) {
      const h = headOf(scan, k);
      if (h.isConfig) c.config++;
      else if (h.isFrame) c.frames++;
      else if (h.command) c.command++;
      else if (h.isMeta) c.meta++;
      else if (h.unsupported) c.unsupported++;
      else if (h.empty) c.empty++;
    }
  }
  return c;
}

function overview(doc, out) {
  const scan = doc.scan;
  const c = tagCounts(scan);
  doc._counts = c;
  const v = doc.tracks.find((t) => t.kind === 'video');
  const a = doc.tracks.find((t) => t.kind === 'audio');
  out.push({
    level: 'info', group: 'Overview', title: doc.enhanced ? 'FLV with Enhanced RTMP codecs' : 'FLV (Flash Video) file',
    text: `A 9-byte header followed by ${fmtInt(scan.count)} tags, each with a millisecond timestamp and a back-pointer (PreviousTagSize). FLV has no index: to find the frames a reader walks the tags one by one${doc.meta?.keyframes ? ', unless it uses the keyframes table in onMetaData' : ''}.${doc.enhanced ? ' Some tags use the Enhanced RTMP extended header (a FourCC instead of a codec number), which is how FLV carries HEVC, AV1, VP9 or Opus.' : ''}`,
    facts: [
      ['video', v ? `${v.codecName}${v.sps ? `, ${v.sps.width}×${v.sps.height}` : ''}` : 'none'],
      ['audio', a ? a.codecName : 'none'],
      ['duration', fmtDuration(doc.summary.duration)],
      ['tags', `${fmtInt(c.video)} video, ${fmtInt(c.audio)} audio, ${fmtInt(c.script)} script${c.other ? `, ${fmtInt(c.other)} of unknown type` : ''}`],
      ['frames', `${fmtInt(c.frames)} (plus ${fmtInt(c.config)} decoder configuration tag${c.config === 1 ? '' : 's'})`],
      ['header flags', `${doc.header.video ? 'video' : ''}${doc.header.video && doc.header.audio ? ' + ' : ''}${doc.header.audio ? 'audio' : ''}${!doc.header.video && !doc.header.audio ? 'none' : ''}`],
    ],
  });
}

function near(a, b, abs, rel = 0) {
  return Math.abs(a - b) <= Math.max(abs, Math.abs(b) * rel);
}

function metadata(doc, out) {
  const m = doc.meta;
  const scan = doc.scan;
  const metaTag = scan.scripts.find((s) => s.name === 'onMetaData');
  const node = [...walk(doc.root)].find((n) => n.type === 'script' && n.label === 'onMetaData');
  if (!m) {
    out.push({
      level: 'warn', group: 'Metadata', title: 'No onMetaData',
      text: 'The file has no onMetaData script tag, so a player learns the duration, picture size and codecs only by reading the stream. Flash players could not show a progress bar or size the player in advance. FFmpeg writes onMetaData when it remuxes.',
      cmd: `ffmpeg -i ${q(doc.name)} -c copy ${q(fixName(doc.name, 'meta'))}`,
    });
    return;
  }
  if (metaTag && metaTag.index !== 0) out.push({ level: 'info', group: 'Metadata', title: 'onMetaData is not the first tag', text: `It is tag #${metaTag.index + 1}. Players read the metadata when they reach it; placing it first lets them size the player and show the duration immediately.` });
  const v = doc.tracks.find((t) => t.kind === 'video');
  const a = doc.tracks.find((t) => t.kind === 'audio');
  const rows = [];
  const bad = [];
  const soft = [];
  const cmp = (key, metaVal, actual, show, ok, nominal = false) => {
    if (metaVal === undefined || metaVal === null) return;
    rows.push([key, `${show(metaVal)} (stream: ${actual === undefined || actual === null ? '—' : show(actual)})`]);
    if (actual !== undefined && actual !== null && !ok) (nominal ? soft : bad).push(`${key} says ${show(metaVal)} but the stream has ${show(actual)}`);
  };
  const dur = doc.summary.duration;
  if (typeof m.duration === 'number') cmp('duration', m.duration, dur, (x) => fmtDuration(x), dur === null || near(m.duration, dur, 0.5, 0.02));
  if (v?.sps) {
    cmp('width', m.width, v.sps.width, (x) => `${fmtNum(x, 2)} px`, m.width === undefined || m.width === v.sps.width);
    cmp('height', m.height, v.sps.height, (x) => `${fmtNum(x, 2)} px`, m.height === undefined || m.height === v.sps.height);
  }
  if (v?.fps && typeof m.framerate === 'number') cmp('framerate', m.framerate, v.fps, (x) => `${fmtNum(x, 3)} fps`, near(m.framerate, v.fps, 0.05, 0.01), true);
  if (typeof m.filesize === 'number') cmp('filesize', m.filesize, doc.size, (x) => `${fmtInt(x)} bytes`, m.filesize === doc.size);
  if (v && typeof m.videodatarate === 'number' && v.bitrate) cmp('videodatarate', m.videodatarate, v.bitrate / 1000, (x) => `${fmtNum(x, 1)} kb/s`, m.videodatarate === 0 || near(m.videodatarate, v.bitrate / 1000, 50, 0.25), true);
  if (a && typeof m.audiodatarate === 'number' && a.bitrate) cmp('audiodatarate', m.audiodatarate, a.bitrate / 1000, (x) => `${fmtNum(x, 1)} kb/s`, m.audiodatarate === 0 || near(m.audiodatarate, a.bitrate / 1000, 16, 0.25), true);
  if (v && typeof m.videocodecid === 'number') {
    const actual = v.h.enhanced ? fourccNumber(v.h.fourcc) : v.h.codecId;
    cmp('videocodecid', m.videocodecid, actual, (x) => metaDisplay('videocodecid', x) ?? String(x), m.videocodecid === actual);
  }
  if (a && typeof m.audiocodecid === 'number') {
    const actual = a.h.enhanced ? fourccNumber(a.h.fourcc) : a.h.soundFormat;
    cmp('audiocodecid', m.audiocodecid, actual, (x) => metaDisplay('audiocodecid', x) ?? String(x), m.audiocodecid === actual);
  }
  if (a?.asc && typeof m.audiosamplerate === 'number') {
    const rate = a.asc.extSampleRate || a.asc.sampleRate;
    cmp('audiosamplerate', m.audiosamplerate, rate, (x) => `${fmtInt(x)} Hz`, m.audiosamplerate === rate);
  }
  if (m.encoder) rows.push(['encoder', String(m.encoder)]);
  if (bad.length) {
    out.push({ level: 'warn', group: 'Metadata', title: 'onMetaData disagrees with the stream', text: `${bad.join('; ')}. The metadata is written by the muxer and never checked; players that trust it show a wrong duration or size, or seek to wrong positions.${soft.length ? ` Also: ${soft.join('; ')}.` : ''}`, facts: rows, node });
  } else if (soft.length) {
    out.push({ level: 'info', group: 'Metadata', title: 'onMetaData: nominal rates differ from the stream', text: `${soft.join('; ')}. Data and frame rates in onMetaData are usually the encoder's targets rather than measurements, so small differences are common; the essential values (duration, size, codecs) match.`, facts: rows, node });
  } else {
    out.push({ level: 'good', group: 'Metadata', title: 'onMetaData matches the stream', text: 'The values in onMetaData agree with what Vidscope measured in the tags.', facts: rows, node });
  }
  if (typeof m.videodatarate === 'number' && m.videodatarate === 0 && v) out.push({ level: 'info', group: 'Metadata', title: 'videodatarate is 0', text: 'The encoder did not know the video bitrate when the metadata was written (typical for constant-quality encoding); the measured average is ' + fmtBitrate(v.bitrate ?? 0) + '.' });
  keyframesIndex(doc, out, m, node);
  const others = scan.scripts.filter((s) => s.kind === 'script' && s.name !== 'onMetaData');
  if (others.length) {
    const names = [...new Set(others.map((s) => String(s.name)))];
    out.push({ level: 'info', group: 'Metadata', title: `${others.length} other script tag${others.length === 1 ? '' : 's'}`, text: `Besides onMetaData the file has ${names.map((n) => `"${n}"`).join(', ')} script tags (cue points, captions, timecode or server messages).`, offset: others[0].offset });
  }
}

function fourccNumber(f) {
  return ((f.charCodeAt(0) << 24) | (f.charCodeAt(1) << 16) | (f.charCodeAt(2) << 8) | f.charCodeAt(3)) >>> 0;
}

function keyframesIndex(doc, out, m, node) {
  const kf = m.keyframes;
  const v = doc.tracks.find((t) => t.kind === 'video');
  if (!kf || typeof kf !== 'object') {
    if (v) {
      out.push({
        level: 'info', group: 'Metadata', title: 'No keyframes index',
        text: 'onMetaData has no "keyframes" object (filepositions and times of every key frame). Without it, a player downloading the file over plain HTTP cannot jump to a position it has not downloaded yet: it must read the tags up to that point. Tools such as yamdi and flvtool2 add the index, and so can FFmpeg.',
        cmd: `ffmpeg -i ${q(doc.name)} -c copy -flvflags add_keyframe_index ${q(fixName(doc.name, 'seekable'))}`,
      });
    }
    return;
  }
  const pos = kf.filepositions;
  const times = kf.times;
  const n = Math.min(pos?.length ?? 0, times?.length ?? 0);
  if (!n) {
    out.push({ level: 'warn', group: 'Metadata', title: 'Empty keyframes index', text: 'onMetaData has a keyframes object but no usable filepositions / times arrays.', node });
    return;
  }
  const scan = doc.scan;
  const byOffset = new Map();
  for (let k = 0; k < scan.count; k++) if (scan.types[k] === 9) byOffset.set(scan.offs[k], k);
  let wrong = 0;
  let firstWrong = null;
  for (let i = 0; i < n; i++) {
    const k = byOffset.get(pos[i]);
    let ok = k !== undefined;
    if (ok) {
      const h = headOf(scan, k);
      ok = h.key && Math.abs(scan.ts[k] / 1000 - times[i]) < 0.0015;
    }
    if (!ok) {
      wrong++;
      if (firstWrong === null) firstWrong = i;
    }
  }
  const keyCount = v?.keyframes ?? 0;
  if (!wrong) {
    out.push({ level: 'good', group: 'Metadata', title: `keyframes index verified (${fmtInt(n)} entries)`, text: `Every entry of onMetaData.keyframes points at a video key frame tag with the right time${keyCount && keyCount !== n ? ` (the stream has ${fmtInt(keyCount)} key frames; the index lists ${fmtInt(n)})` : ''}. Players can seek in a progressive download with it.`, node });
  } else {
    out.push({ level: 'warn', group: 'Metadata', title: `keyframes index is wrong (${fmtInt(wrong)} of ${fmtInt(n)} entries)`, text: `Entry ${firstWrong + 1} (position ${fmtInt(pos[firstWrong])}, time ${fmtNum(times[firstWrong], 3)} s) does not point at a key frame tag with that time. The file was probably edited after the index was written; players that use it will seek to garbage.`, node, offset: Number.isFinite(pos[firstWrong]) && pos[firstWrong] < doc.size ? pos[firstWrong] : undefined });
  }
}

async function codecs(doc, out) {
  for (const t of doc.tracks) {
    const h = t.h;
    const s = t.samples;
    if (t.kind === 'video') {
      if (h.enhanced) {
        out.push({ level: 'info', group: 'Encoding', title: `${t.label}: ${t.codecName} via Enhanced RTMP`, text: `The video uses the Enhanced RTMP extended header with FourCC '${h.fourcc}'${t.profile ? ` (${t.profile})` : ''}. Readers written before Enhanced RTMP (2023) see an unknown codec and cannot play it; recent FFmpeg, OBS and major streaming ingests support it.` });
      } else if (h.codecId === 7) {
        out.push({ level: 'good', group: 'Encoding', title: `${t.label}: H.264${t.profile ? ` ${t.profile}` : ''}`, text: `AVC video${t.sps ? `, ${t.sps.width}×${t.sps.height}` : ''}${t.codecString ? `, codec string ${t.codecString}` : ''}. The NAL units in the tags are length-prefixed (${t.sampleCfg.lengthSize ?? 4} bytes), with SPS and PPS in the AVC sequence header.` });
      } else {
        out.push({ level: 'info', group: 'Encoding', title: `${t.label}: legacy Flash codec`, text: `${CODEC_IDS[h.codecId] ?? `CodecID ${h.codecId}`} is a codec of the Flash Player era. Browsers and most modern devices cannot decode it; re-encode to H.264 for playback today.`, cmd: `ffmpeg -i ${q(doc.name)} -c:v libx264 -c:a aac ${q(doc.name.replace(/(\.\w+)?$/, '.mp4'))}` });
      }
      if ((h.family === 'avc' || h.family === 'hevc' || h.family === 'av1' || h.family === 'vp9') && !t.configs.length && s?.count) {
        out.push({ level: 'bad', group: 'Encoding', title: `${t.label}: no decoder configuration`, text: 'There are frames but no sequence header (decoder configuration) tag, so a decoder has no SPS/PPS and cannot start. This happens when a recording is cut out of a live stream without its header.' });
      } else if (t.configs.length > 1) {
        out.push({ level: 'info', group: 'Encoding', title: `${t.label}: ${t.configs.length} decoder configurations`, text: 'The video sequence header is sent more than once: the encoding parameters (resolution, profile) may change mid-stream, as when a live encoder adapts. Decoders must re-initialise at each one.', offset: t.configs[1].offset });
      }
      if (s?.count) {
        if (!s.key[0]) out.push({ level: 'warn', group: 'Encoding', title: `${t.label}: does not start with a key frame`, text: 'The first video frame is an inter frame: players show garbage or nothing until the first key frame.', offset: s.tags[0] });
        const keys = [];
        for (let i = 0; i < s.count; i++) if (s.key[i]) keys.push(s.dts[i]);
        if (keys.length > 1) {
          let max = 0;
          for (let i = 1; i < keys.length; i++) max = Math.max(max, keys[i] - keys[i - 1]);
          const avg = (keys[keys.length - 1] - keys[0]) / (keys.length - 1);
          out.push({ level: max > 10000 ? 'warn' : 'info', group: 'Encoding', title: `${t.label}: key frame every ${fmtNum(avg / 1000, 2)} s`, text: `${fmtInt(keys.length)} key frames, on average ${fmtNum(avg / 1000, 2)} s apart (at most ${fmtNum(max / 1000, 2)} s). Seeking lands on a key frame, and live players joining the stream wait for the next one.${max > 10000 ? ' Gaps over 10 s make seeking coarse and slow joins.' : ''}` });
        } else if (keys.length === 1 && s.count > 1) {
          const long = (s.dts[s.count - 1] - s.dts[0]) > 10000;
          out.push({ level: long ? 'warn' : 'info', group: 'Encoding', title: `${t.label}: a single key frame`, text: `Only the first frame is a key frame${long ? '' : ' (normal for a clip shorter than the encoder\'s key frame interval)'}: seeking must decode from it, and a player joining the stream later cannot start.` });
        }
        if (s.cto) {
          let neg = 0;
          for (let i = 0; i < s.count; i++) if (s.cto[i] < 0) neg++;
          out.push({ level: neg ? 'warn' : 'info', group: 'Encoding', title: `${t.label}: B-frames (CompositionTime)`, text: `Frames are stored in decoding order; CompositionTime gives each frame's presentation time offset (PTS = timestamp + CompositionTime).${neg ? ` ${neg} frames have a negative offset, which some players mishandle.` : ''}` });
        }
      }
    } else if (t.kind === 'audio') {
      if (h.enhanced) {
        out.push({ level: 'info', group: 'Encoding', title: `${t.label}: ${t.codecName} via Enhanced RTMP`, text: `The audio uses the Enhanced RTMP extended header (SoundFormat 9) with FourCC '${h.fourcc}'. Only readers that know Enhanced RTMP (v2 for audio) can play it.` });
      } else if (h.soundFormat === 10) {
        out.push({ level: 'good', group: 'Encoding', title: `${t.label}: ${t.profile ?? 'AAC'}`, text: `AAC audio${t.asc ? `, ${fmtInt(t.asc.extSampleRate || t.asc.sampleRate)} Hz, ${t.asc.channels || '?'} channel${t.asc.channels === 1 ? '' : 's'}` : ''}. The SoundRate/SoundSize/SoundType bits of AAC tags are fixed (44 kHz, 16-bit, stereo) and ignored: the real values are in the AudioSpecificConfig of the AAC sequence header.` });
        if (!t.configs.length && t.samples?.count) out.push({ level: 'bad', group: 'Encoding', title: `${t.label}: no AAC sequence header`, text: 'AAC frames without an AudioSpecificConfig cannot be decoded: the decoder does not know the profile, sample rate or channel layout.' });
      } else if (h.soundFormat === 2 || h.soundFormat === 14) {
        const rate = t.mpa?.sampleRate ?? 0;
        const flagged = [5512.5, 11025, 22050, 44100][h.rate];
        const odd = rate && ![5512, 5513, 11025, 22050, 44100].includes(rate);
        out.push({ level: 'info', group: 'Encoding', title: `${t.label}: MP3${rate ? ` ${fmtInt(rate)} Hz` : ''}`, text: `MP3 audio; each tag holds whole MP3 frames with their own headers. The tag header says ${fmtNum(flagged / 1000, 3)} kHz${odd ? `, but the frames are ${fmtInt(rate)} Hz: SoundRate can only express 5.5, 11, 22 and 44 kHz, so other rates are approximated and decoders rely on the MP3 frame headers` : rate ? ', which matches the MP3 frame headers' : ''}.` });
      } else {
        out.push({ level: 'info', group: 'Encoding', title: `${t.label}: ${SOUND_FORMATS[h.soundFormat] ?? codecName(h)}`, text: 'A codec of the Flash Player era (Nellymoser, Speex, ADPCM or raw PCM). Modern players rarely support it.' });
      }
    }
  }
}

function timing(doc, out) {
  for (const t of doc.tracks) {
    const s = t.samples;
    if (!s || s.count < 2) continue;
    let back = 0;
    let firstBack = -1;
    let dup = 0;
    let gap = 0;
    let gapAt = -1;
    const med = s.durations[s.count - 1] || 1;
    for (let i = 1; i < s.count; i++) {
      const d = s.dts[i] - s.dts[i - 1];
      if (d < 0) {
        back++;
        if (firstBack < 0) firstBack = i;
      } else if (d === 0 && t.kind === 'video') dup++;
      if (d > gap) {
        gap = d;
        gapAt = i;
      }
    }
    if (back) {
      out.push({ level: 'warn', group: 'Timing', title: `${t.label}: timestamps go backwards ${fmtInt(back)} time${back === 1 ? '' : 's'}`, text: `Tag timestamps of this track should never decrease (they are decoding times). The first jump back is at frame ${fmtInt(firstBack + 1)} (${fmtDuration(s.dts[firstBack - 1] / 1000)} → ${fmtDuration(s.dts[firstBack] / 1000)}). This usually comes from joining recordings or a restarted encoder; players may stall or drop frames.`, offset: s.tags[firstBack] });
    } else {
      out.push({ level: 'good', group: 'Timing', title: `${t.label}: timestamps increase monotonically`, text: `${fmtInt(s.count)} frames from ${fmtDuration(s.dts[0] / 1000)} to ${fmtDuration(s.dts[s.count - 1] / 1000)}.` });
    }
    if (dup) out.push({ level: 'info', group: 'Timing', title: `${t.label}: ${fmtInt(dup)} repeated timestamps`, text: 'Consecutive frames with the same timestamp. With millisecond resolution this happens at high frame rates, or when a muxer could not compute proper times.' });
    if (gap > Math.max(1000, med * 10)) out.push({ level: 'warn', group: 'Timing', title: `${t.label}: gap of ${fmtNum(gap / 1000, 2)} s`, text: `Between frames ${fmtInt(gapAt)} and ${fmtInt(gapAt + 1)} the timestamps jump from ${fmtDuration(s.dts[gapAt - 1] / 1000)} to ${fmtDuration(s.dts[gapAt] / 1000)}: a hole in the recording (for example a dropped connection).`, offset: s.tags[gapAt] });
    if (s.dts[s.count - 1] > 0xffffff) out.push({ level: 'info', group: 'Timing', title: `${t.label}: extended timestamps`, text: 'Timestamps exceed 2^24 ms (4 h 39 min), so TimestampExtended carries their upper 8 bits. Old readers that ignore it wrap around to 0.' });
  }
  const starts = doc.tracks.filter((t) => t.samples?.count).map((t) => [t.label, t.samples.dts[0]]);
  if (starts.length > 1) {
    const min = Math.min(...starts.map((x) => x[1]));
    const max = Math.max(...starts.map((x) => x[1]));
    if (max - min > 0) out.push({ level: max - min > 500 ? 'warn' : 'info', group: 'Timing', title: `Streams start ${fmtInt(max - min)} ms apart`, text: `${starts.map(([l, ts]) => `${l} starts at ${fmtInt(ts)} ms`).join('; ')}. A small offset is normal: muxers shift all timestamps so that none is negative, and B-frame delay or AAC priming then shows up as a start offset.` });
  }
  interleave(doc, out);
}

function interleave(doc, out) {
  const scan = doc.scan;
  const v = doc.tracks.find((t) => t.kind === 'video' && t.samples?.count);
  const a = doc.tracks.find((t) => t.kind === 'audio' && t.samples?.count);
  if (!v || !a) return;
  let lastV = null;
  let lastA = null;
  let worst = 0;
  let at = 0;
  for (let k = 0; k < scan.count; k++) {
    const type = scan.types[k];
    if (type === 9) lastV = scan.ts[k];
    else if (type === 8) lastA = scan.ts[k];
    else continue;
    if (lastV === null || lastA === null) continue;
    const d = Math.abs(lastV - lastA);
    if (d > worst) {
      worst = d;
      at = scan.offs[k];
    }
  }
  if (worst <= 1000) out.push({ level: 'good', group: 'Layout', title: 'Audio and video are interleaved', text: `Tags of both streams alternate closely: at any point of the file their timestamps are at most ${fmtInt(worst)} ms apart, as streaming (RTMP, HTTP progressive download) requires.`, offset: at });
  else out.push({ level: 'warn', group: 'Layout', title: `Poor interleaving (${fmtNum(worst / 1000, 2)} s)`, text: `At ${hex(at)} one stream is ${fmtNum(worst / 1000, 2)} s ahead of the other in the file. A player reading the file in order must buffer that much, and live playback stalls.`, offset: at });
}

function integrity(doc, out) {
  const scan = doc.scan;
  let bad = 0;
  let first = -1;
  let missing = 0;
  for (let k = 0; k < scan.count; k++) {
    if (scan.prev[k] < 0) {
      missing++;
      continue;
    }
    if (scan.prev[k] !== 11 + scan.sizes[k]) {
      bad++;
      if (first < 0) first = k;
    }
  }
  if (bad) {
    out.push({ level: 'warn', group: 'Integrity', title: `${fmtInt(bad)} PreviousTagSize mismatch${bad === 1 ? '' : 'es'}`, text: `After tag #${first + 1} (at ${hex(scan.offs[first])}) PreviousTagSize is ${fmtInt(scan.prev[first])} but the tag is ${fmtInt(11 + scan.sizes[first])} bytes. Each PreviousTagSize must repeat 11 + DataSize of the tag before it; readers use it to walk backwards and to detect corruption. A mismatch means the tag or the field was damaged or badly written.`, offset: scan.offs[first] + 11 + scan.sizes[first] });
  } else if (scan.count) {
    out.push({ level: 'good', group: 'Integrity', title: 'Every PreviousTagSize matches', text: `All ${fmtInt(scan.count - missing)} back-pointers equal 11 + DataSize of the tag before them, so the file can be walked in both directions.` });
  }
  for (const g of scan.garbage) {
    out.push({ level: 'bad', group: 'Integrity', title: `Unreadable bytes at ${hex(g.start)}`, text: `${fmtInt(g.end - g.start)} bytes do not form a valid tag${g.resynced ? `; Vidscope found the next valid tag at ${hex(g.end)} (whose PreviousTagSize checks out) and continued there, as FFmpeg does` : ' and no valid tag follows'}. The file is damaged here.`, offset: g.start });
  }
  if (scan.truncated) {
    const k = scan.truncated.index;
    out.push({ level: 'bad', group: 'Integrity', title: 'The last tag is cut off', text: `Tag #${k + 1} at ${hex(scan.offs[k])} declares ${fmtInt(scan.sizes[k])} bytes of data but the file ends ${fmtInt(scan.truncated.missing)} bytes short: the recording or download was interrupted.`, offset: scan.offs[k] });
  }
  const pts0 = [...walk(doc.root)].find((n) => n.type === 'PreviousTagSize0');
  if (pts0?.warnings.length) out.push({ level: 'warn', group: 'Integrity', title: 'PreviousTagSize0 is not 0', text: pts0.warnings[0], node: pts0 });
  const hv = doc.tracks.some((t) => t.kind === 'video');
  const ha = doc.tracks.some((t) => t.kind === 'audio');
  const flagProblems = [];
  if (doc.header.video && !hv) flagProblems.push('the header flags video but there is no video tag');
  if (!doc.header.video && hv) flagProblems.push('there are video tags but TypeFlagsVideo is 0');
  if (doc.header.audio && !ha) flagProblems.push('the header flags audio but there is no audio tag');
  if (!doc.header.audio && ha) flagProblems.push('there are audio tags but TypeFlagsAudio is 0');
  if (flagProblems.length) out.push({ level: 'info', group: 'Integrity', title: 'Header flags do not match the tags', text: `${flagProblems.join('; ')}. Players normally rely on the tags, but some use the flags to decide whether to wait for a stream.`, node: doc.header.node });
  if (doc.header.dataOffset !== undefined && doc.header.dataOffset !== 9) out.push({ level: 'warn', group: 'Integrity', title: `DataOffset is ${doc.header.dataOffset}`, text: 'FLV version 1 headers are 9 bytes long.', node: doc.header.node });
  const c = doc._counts ?? tagCounts(scan);
  if (c.encrypted) out.push({ level: 'info', group: 'Integrity', title: `${fmtInt(c.encrypted)} encrypted tags`, text: 'Tags with the Filter bit set are encrypted (Adobe Access / FMS). Their contents cannot be decoded without the key.' });
  if (c.other) out.push({ level: 'warn', group: 'Integrity', title: `${fmtInt(c.other)} tags of unknown type`, text: 'Only tag types 8 (audio), 9 (video) and 18 (script) exist. The others are skipped by players.' });
  if (c.unsupported) out.push({ level: 'info', group: 'Integrity', title: `${fmtInt(c.unsupported)} multitrack / ModEx tags`, text: 'Enhanced RTMP v2 packet types (Multitrack or ModEx) that Vidscope does not decode.' });
  if (scan.end < doc.size && !scan.garbage.some((g) => g.end >= doc.size)) out.push({ level: 'info', group: 'Integrity', title: 'Bytes after the last tag', text: `${fmtInt(doc.size - scan.end)} bytes follow the last complete tag.`, offset: scan.end });
}
