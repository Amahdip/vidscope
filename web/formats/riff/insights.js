// File insights for AVI and WAV: what an engineer would check with a RIFF
// analyser. AVI: index and seeking, OpenDML and the 1 GB RIFF limit,
// interleaving, key-frame interval, B-frames without timestamps (packed
// bitstream), VBR audio, header consistency. WAV: format, PCM parameters,
// duration, channel layout, broadcast metadata, truncation.

import { walk } from '../../core/model.js';
import { fmtInt, fmtNum, fmtBitrate, fmtDuration, fmtHz, hex, humanBytes, pct } from '../../core/util.js';
import { parseSample } from '../../codecs/index.js';
import { parseMpegAudioHeader } from '../../codecs/audio.js';
import { parseMpeg4Visual } from '../../codecs/mpeg4v.js';
import { waveFormatProblems } from './formats.js';
import { channelMaskText, FORMAT_TAGS, INFO_TAGS, AVIF, flagsText } from './tables.js';
import { isListId } from './parse.js';

const GB = 1024 ** 3;
const q = (s) => `"${String(s).replace(/"/g, '\\"')}"`;

export async function insights(doc) {
  const ctx = doc.ctx;
  const out = [];
  try {
    if (ctx.form === 'AVI ' || ctx.form === 'AVIX') await aviInsights(doc, ctx, out);
    else if (ctx.form === 'WAVE') wavInsights(doc, ctx, out);
    else genericInsights(doc, ctx, out);
    integrity(doc, ctx, out);
  } catch (e) {
    out.push({ level: 'warn', group: 'Integrity', title: 'Analysis stopped early', text: `Vidscope could not finish analysing this file: ${e.message}` });
  }
  return out;
}

// ------------------------------------------------------------ shared

function riffNodes(doc) {
  return (doc.root.children ?? []).filter((c) => isListId(c.data.id ?? ''));
}

function integrity(doc, ctx, out) {
  const riffs = riffNodes(doc);
  const first = riffs[0];
  if (first) {
    const declared = first.data.declared;
    if (first.data.id === 'RIFF' || first.data.id === 'RIFX') {
      if (declared === 0xffffffff || declared === 0) {
        out.push({
          level: 'warn', group: 'Integrity', title: 'RIFF size not filled in',
          text: `The RIFF chunk size is ${declared === 0 ? '0' : '0xFFFFFFFF'}: the writer never went back to fill it in (typical of a file written to a pipe, or a recording that was interrupted). Strict readers reject the file; Vidscope assumes the chunk runs to the end of the file.`,
          node: first,
          cmd: `ffmpeg -i ${q(doc.name)} -c copy -map 0 ${q(doc.name.replace(/(\.\w+)?$/, '-fixed$1'))}`,
        });
      } else if (first.offset + 8 + declared > doc.size) {
        const missing = first.offset + 8 + declared - doc.size;
        out.push({
          level: 'bad', group: 'Integrity', title: 'The file is truncated',
          text: `The RIFF header announces ${fmtInt(declared + 8)} bytes but the file has ${fmtInt(doc.size)}: ${humanBytes(missing)} are missing at the end. The download or copy was probably interrupted${ctx.form === 'AVI ' ? '; the idx1 index, written last, may be missing too' : ''}.`,
          node: first,
        });
      }
    }
    const lastEnd = riffs[riffs.length - 1].end;
    const tail = (doc.root.children ?? []).filter((c) => c.offset >= lastEnd);
    const extra = tail.reduce((n, c) => n + c.size, 0);
    if (extra > 0 && !tail.some((c) => c.data.id)) {
      out.push({ level: 'info', group: 'Integrity', title: 'Bytes after the RIFF chunk', text: `${fmtInt(extra)} bytes follow the last RIFF chunk. Players ignore them; they can be padding, a tag appended by another tool, or the remains of a longer file.`, offset: lastEnd });
    }
  }
  const warned = [];
  for (const n of walk(doc.root)) if (n.warnings.length && n.parent) warned.push(n);
  if (warned.length) {
    out.push({
      level: warned.some((n) => n.type === 'garbage') ? 'bad' : 'warn',
      group: 'Integrity',
      title: `${fmtInt(warned.length)} chunk${warned.length === 1 ? '' : 's'} with problems`,
      text: warned.slice(0, 6).map((n) => `${n.pathString()} at ${hex(n.offset)}: ${n.warnings[0]}`).join(' — ') + (warned.length > 6 ? ' — …' : ''),
      node: warned[0],
    });
  } else {
    out.push({ level: 'good', group: 'Integrity', title: 'Chunk structure is consistent', text: 'Every chunk that Vidscope read has a valid ID and a size that fits its parent, and odd-sized chunks are followed by their pad byte.' });
  }
}

function infoTags(doc, out) {
  const info = [];
  for (const n of walk(doc.root)) if (n.parent?.type === 'INFO' && n.data.text !== undefined) info.push([`${n.type} (${INFO_TAGS[n.type]?.[0] ?? 'tag'})`, n.data.text]);
  if (info.length) {
    out.push({ level: 'info', group: 'Metadata', title: 'INFO tags', text: 'Text metadata in the LIST INFO chunk.', facts: info.slice(0, 20), node: [...walk(doc.root)].find((n) => n.type === 'INFO') });
  }
}

function genericInsights(doc, ctx, out) {
  out.push({ level: 'info', group: 'Overview', title: `RIFF file of form '${(ctx.form ?? '?').trim()}'`, text: 'Vidscope shows the chunk structure of this RIFF form but has no specific knowledge of its contents (it decodes AVI and WAV).' });
}

// ------------------------------------------------------------ AVI

async function aviInsights(doc, ctx, out) {
  const riffs = riffNodes(doc);
  const odml = doc.summary.label.includes('OpenDML');
  const tracks = doc.tracks;
  const video = tracks.filter((t) => t.kind === 'video');
  const audio = tracks.filter((t) => t.kind === 'audio');
  const facts = [
    ['streams', tracks.map((t) => t.label).join(', ') || 'none'],
    ['duration', fmtDuration(doc.summary.duration)],
    ['RIFF chunks', `${riffs.length} (${riffs.map((r) => `'${r.data.listType}'`).join(', ')})`],
    ['index', ctx.index.kind === 'none' ? (ctx.index.scanned ? 'none (frames found by scanning)' : 'none') : ctx.index.kind],
  ];
  if (ctx.avih) facts.push(['main header', `${ctx.avih.width}×${ctx.avih.height}, ${fmtInt(ctx.avih.totalFrames)} frames, flags ${flagsText(ctx.avih.flags, AVIF, 4)}`]);
  out.push({
    level: 'info', group: 'Overview', title: odml ? 'AVI 2.0 (OpenDML) file' : 'AVI file',
    text: `A RIFF file of form 'AVI ' with ${tracks.length} stream${tracks.length === 1 ? '' : 's'}. AVI stores each frame in its own chunk inside the movi list and has no timestamps: a frame's time is its position in its stream × dwScale/dwRate.`,
    facts,
  });

  indexInsights(doc, ctx, out);
  openDmlInsights(doc, ctx, out, riffs);
  junkInsights(doc, ctx, out);
  interleaving(doc, out);
  for (const t of video) await videoInsights(doc, ctx, t, out);
  for (const t of audio) await audioInsights(doc, ctx, t, out);
  headerChecks(doc, ctx, out);
  infoTags(doc, out);
}

function indexInsights(doc, ctx, out) {
  const flags = ctx.avih?.flags ?? 0;
  const idx1 = ctx.idx1?.node;
  const kind = ctx.index.kind;
  if (kind === 'none') {
    out.push({
      level: 'bad', group: 'Layout', title: 'No index',
      text: `The file has neither an idx1 chunk nor OpenDML indexes. A player can only play it from the start: to seek (or even to know the duration) it has to read every chunk header in movi, and many players simply refuse to seek. ${ctx.index.scanned ? 'Vidscope found the frames by scanning the whole movi list. ' : ''}FFmpeg writes no index when its output is not seekable (a pipe or a live stream); remuxing rebuilds one.`,
      cmd: `ffmpeg -i ${q(doc.name)} -c copy -map 0 ${q(doc.name.replace(/(\.\w+)?$/, '-indexed$1'))}`,
      node: ctx.movis[0],
    });
    if (flags & 0x10) out.push({ level: 'warn', group: 'Layout', title: 'AVIF_HASINDEX set without an index', text: 'The main header says an index exists (AVIF_HASINDEX) but there is none.', node: ctx.avih && [...walk(doc.root)].find((n) => n.type === 'avih') });
    return;
  }
  if (kind === 'idx1') {
    const info = ctx.idx1Info;
    const n = ctx.idx1.table.count;
    out.push({
      level: 'good', group: 'Layout', title: 'Indexed (idx1)',
      text: `The legacy index lists ${fmtInt(n)} chunks with their position, size and key-frame flag, so players can seek directly to any key frame. Its offsets are ${info?.absolute ? 'absolute file positions (an old convention some writers used)' : 'relative to the movi list, as the specification recommends'}${info && !info.verified ? '; Vidscope could not confirm which convention applies, so frame positions may be wrong' : ''}.`,
      node: idx1,
    });
    if (info && !info.verified) out.push({ level: 'warn', group: 'Integrity', title: 'idx1 does not match the chunks', text: 'The idx1 offsets land on no chunk with the expected ID under either convention (relative to movi or absolute). The index is probably damaged; players that trust it will seek to wrong positions.', node: idx1 });
    if (!(flags & 0x10)) out.push({ level: 'info', group: 'Layout', title: 'Index present but AVIF_HASINDEX not set', text: 'The main header does not announce the idx1 index. Most players look for it anyway.' });
    if (ctx.index.recs) out.push({ level: 'info', group: 'Layout', title: 'Chunks grouped in rec lists', text: `${fmtInt(ctx.index.recs)} index entries point at 'rec ' lists: each record groups the chunks to read in one go (a CD-ROM era optimisation).` });
  } else {
    out.push({
      level: 'good', group: 'Layout', title: 'Indexed (OpenDML)',
      text: `Every stream has an OpenDML super index (indx) pointing at ${fmtInt(ctx.ixOffsets.length)} standard index chunks (ix##). Unlike idx1 they use 64-bit positions and cover every RIFF chunk, so seeking works in files of any size.${ctx.idx1 ? ' There is also a legacy idx1 for the first RIFF chunk, for AVI 1.0 players.' : ''}`,
      node: ctx.streams.find((s) => s.indx)?.indx?.node,
    });
  }
  if (ctx.index.problems?.length) out.push({ level: 'warn', group: 'Integrity', title: 'Index problems', text: ctx.index.problems.slice(0, 5).join('; ') });
  if (flags & 0x20) out.push({ level: 'info', group: 'Layout', title: 'AVIF_MUSTUSEINDEX', text: 'The header says the physical order of chunks is not the playback order: players must follow the index.' });
}

function openDmlInsights(doc, ctx, out, riffs) {
  const avix = riffs.filter((r) => r.data.listType === 'AVIX');
  if (avix.length || ctx.odml) {
    const total = ctx.dmlhTotalFrames;
    const first = ctx.avih?.totalFrames;
    out.push({
      level: 'info', group: 'Layout', title: `OpenDML: ${riffs.length} RIFF chunk${riffs.length === 1 ? '' : 's'}`,
      text: `The file uses the OpenDML ("AVI 2.0") extensions${avix.length ? `: after the first RIFF 'AVI ' chunk come ${avix.length} RIFF 'AVIX' continuation chunk${avix.length === 1 ? '' : 's'}` : ''}. An AVI 1.0 player only reads the first RIFF chunk${first !== undefined && total ? `, so it sees ${fmtInt(first)} of the ${fmtInt(total)} frames (avih dwTotalFrames vs odml dmlh dwTotalFrames)` : ''}.`,
      facts: riffs.map((r) => [`RIFF '${r.data.listType}' at ${hex(r.offset)}`, humanBytes(r.size)]),
    });
  } else if (doc.size > GB) {
    out.push({
      level: 'warn', group: 'Layout', title: 'Larger than 1 GB without OpenDML',
      text: `The file is ${humanBytes(doc.size)} but uses a single RIFF chunk. RIFF sizes are 32-bit and many readers treat them as signed, so AVI 1.0 files over 1–2 GB are unreliable; writers are expected to switch to OpenDML (RIFF 'AVIX' continuation chunks) at about 1 GB.`,
    });
  } else {
    out.push({ level: 'good', group: 'Layout', title: 'Plain AVI 1.0 layout', text: `One RIFF chunk of ${humanBytes(riffs[0]?.size ?? 0)}, well under the 1 GB limit where OpenDML extensions become necessary.` });
  }
}

function junkInsights(doc, ctx, out) {
  const junk = [];
  for (const n of walk(doc.root)) if (n.type === 'JUNK' || n.type === 'junk') junk.push(n);
  if (!junk.length) return;
  const bytes = junk.reduce((s, n) => s + n.size, 0);
  const reserved = junk.filter((n) => n.data.placeholder);
  out.push({
    level: 'info', group: 'Layout', title: `${fmtInt(bytes)} bytes of JUNK`,
    text: `${junk.length} JUNK chunk${junk.length === 1 ? '' : 's'} (${pct(bytes, doc.size)} of the file). JUNK is filler that readers skip.${reserved.length ? ` ${reserved.length} of them hold inactive OpenDML structures: the writer (FFmpeg does this) reserved room for a super index per stream and for the odml header, to be switched on only if the file grew past 1 GB. Since it did not, they stay JUNK.` : ' Writers use it to align data to sector boundaries or to leave room for headers to be rewritten later.'}`,
    node: junk[0],
  });
}

/** How far apart in time the streams are at the same point of the file. */
function interleaving(doc, out) {
  const idx = doc.frameIndex;
  const tracks = doc.tracks.filter((t) => t.samples?.count && (t.kind === 'video' || t.kind === 'audio'));
  if (!idx || tracks.length < 2 || !idx.count) return;
  const last = new Map();
  let worst = 0;
  let worstAt = 0;
  for (let k = 0; k < idx.count; k++) {
    const t = doc.tracks[idx.track[k]];
    const s = t.samples;
    const time = s.dts[idx.sample[k]] / (s.timescale || 1);
    last.set(t.index, time);
    if (last.size < tracks.length) continue;
    let lo = Infinity;
    let hi = -Infinity;
    for (const v of last.values()) {
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    if (hi - lo > worst) {
      worst = hi - lo;
      worstAt = idx.starts[k];
    }
  }
  if (last.size < tracks.length) {
    out.push({ level: 'warn', group: 'Layout', title: 'Streams are not interleaved', text: 'One stream only starts after another has ended in the file. A player reading the file in order must jump back and forth between two distant places (slow over a network or from a disc).' });
    return;
  }
  const flags = doc.ctx.avih?.flags ?? 0;
  if (worst <= 1) {
    out.push({ level: 'good', group: 'Layout', title: 'Well interleaved', text: `Audio and video chunks follow each other closely: at any point of the file the streams are at most ${fmtNum(worst * 1000, 0)} ms apart, so reading the file in order delivers both together.${flags & 0x100 ? '' : ' (AVIF_ISINTERLEAVED is not set in the header, though.)'}`, offset: worstAt });
  } else {
    out.push({ level: worst > 5 ? 'warn' : 'info', group: 'Layout', title: `Interleaving depth ${fmtNum(worst, 2)} s`, text: `At ${hex(worstAt)} one stream is ${fmtNum(worst, 2)} s ahead of another in the file. Players must buffer that much of one stream, or seek back and forth, to play them together; streaming or disc playback can stutter.`, offset: worstAt });
  }
}

async function readFrame(doc, t, i, max = 1 << 20) {
  const s = t.samples;
  return doc.source.read(s.offsets[i], Math.min(s.sizes[i], max));
}

async function videoInsights(doc, ctx, t, out) {
  const s = t.samples;
  if (!s || !s.count) return;
  // Key frame intervals and GOPs are reported for every format by web/core/frames.js.
  if (t.emptyChunks) {
    out.push({ level: 'info', group: 'Timing', title: `${t.label}: ${fmtInt(t.emptyChunks)} empty chunk${t.emptyChunks === 1 ? '' : 's'}`, text: `Zero-byte '${t.chunkPrefix}dc' chunks are placeholders for frames that were dropped or repeated. Because AVI has no timestamps, a missing frame must still occupy a position in the stream, or everything after it would play early.` });
  }
  if (t.family === 'mpeg4v') await mpeg4Insights(doc, t, out);
  if (t.family === 'avc' || t.family === 'hevc') await annexBInsights(doc, t, out);
  const sb = t.stream.bufferSize;
  if (sb && t.maxChunk > sb) out.push({ level: 'info', group: 'Tracks', title: `${t.label}: dwSuggestedBufferSize too small`, text: `The largest chunk is ${fmtInt(t.maxChunk)} bytes but the stream header suggests a ${fmtInt(sb)}-byte buffer. Players that trust it reallocate during playback.` });
}

async function mpeg4Insights(doc, t, out) {
  const s = t.samples;
  let packed = 0;
  let nvops = 0;
  let b = 0;
  let checked = 0;
  const userData = new Set(t.mp4v?.userData ?? []);
  for (let i = 0; i < s.count && checked < 60; i++) {
    if (!s.sizes[i]) continue;
    checked++;
    const bytes = await readFrame(doc, t, i, 256 << 10);
    const res = parseMpeg4Visual(bytes, 0, bytes.length, s.offsets[i], { ...t.mp4v });
    const vops = res.vops;
    if (vops.length > 1) packed++;
    for (const v of vops) {
      if (!v.coded) nvops++;
      if (v.type === 'B') b++;
    }
    for (const u of res.userData) userData.add(u);
  }
  const divxPacked = [...userData].some((u) => /^DivX\d+(Build|b)\d+p/.test(u));
  if (packed || divxPacked) {
    out.push({
      level: 'warn', group: 'Encoding', title: `${t.label}: packed bitstream`,
      text: `${packed ? `${packed} of the first ${checked} frames hold more than one VOP` : 'The encoder marked the stream as packed (a "p" at the end of the DivX user data)'}. This DivX/Xvid hack squeezes a B-frame into the chunk of the frame before it and stores an empty "N-VOP" in the next chunk, because AVI's one-frame-per-chunk timing cannot express B-frame reordering. Standalone players and MP4 muxers dislike it; FFmpeg can undo it.`,
      cmd: `ffmpeg -i ${q(doc.name)} -c copy -bsf:v mpeg4_unpack_bframes ${q(doc.name.replace(/(\.\w+)?$/, '-unpacked$1'))}`,
    });
  } else if (b) {
    out.push({ level: 'info', group: 'Encoding', title: `${t.label}: B-frames`, text: `${b} B-VOPs in the first ${checked} frames, stored one per chunk in decoding order. AVI has no presentation timestamps, so players must infer the display order from the frame types.` });
  } else if (checked) {
    out.push({ level: 'good', group: 'Encoding', title: `${t.label}: no B-frames`, text: `The frames checked are I/P VOPs only${t.mp4v?.lowDelay ? ' and the VOL header says low_delay' : ''}: decoding order equals display order, which is what AVI's timing model assumes.` });
  }
  if (nvops) out.push({ level: 'info', group: 'Encoding', title: `${t.label}: ${nvops} not-coded VOPs`, text: 'N-VOPs (vop_coded = 0) repeat the previous picture. They are the tiny placeholder frames left by packed bitstream or by an encoder that skipped a frame.' });
}

async function annexBInsights(doc, t, out) {
  const s = t.samples;
  const types = { I: 0, P: 0, B: 0 };
  let checked = 0;
  const cfg = { ...t.sampleCfg, state: { spsById: new Map(t.sampleCfg.state?.spsById ?? []), ppsById: new Map(t.sampleCfg.state?.ppsById ?? []) } };
  for (let i = 0; i < s.count && checked < 40; i++) {
    if (!s.sizes[i]) continue;
    checked++;
    const bytes = await readFrame(doc, t, i, 512 << 10);
    const res = parseSample(cfg, bytes, 0, bytes.length, s.offsets[i]);
    const slice = res.units.find((u) => (t.family === 'avc' ? u.kind === 1 || u.kind === 5 : u.kind < 32));
    const m = slice && /\b([IPB])-slice/.exec(slice.summary);
    if (m) types[m[1]]++;
  }
  const reorder = t.sps?.vui?.max_num_reorder_frames;
  if (types.B || reorder > 0) {
    out.push({
      level: 'info', group: 'Encoding', title: `${t.label}: B-frames without timestamps`,
      text: `${types.B ? `${types.B} of the first ${checked} frames are B-frames` : `The SPS allows ${reorder} reordered frames`}. AVI stores one time per chunk position (the decoding order) and no presentation time, so a player has to rebuild the display order itself; FFmpeg reports these frames without PTS. MP4 or Matroska store both timestamps.`,
      cmd: `ffmpeg -fflags +genpts -i ${q(doc.name)} -c copy ${q(doc.name.replace(/(\.\w+)?$/, '.mkv'))}`,
    });
  }
  if (t.problems?.length) out.push({ level: 'warn', group: 'Encoding', title: `${t.label}: unexpected bitstream`, text: t.problems.join('; ') });
}

async function audioInsights(doc, ctx, t, out) {
  const s = t.samples;
  const a = t.stream.audio ?? {};
  const c = s?.clock;
  if (a.pcm) {
    out.push({ level: 'info', group: 'Tracks', title: `${t.label}: PCM ${a.bits}-bit ${fmtHz(a.sampleRate)} ${a.channels} ch`, text: `Uncompressed audio: ${fmtBitrate(a.byteRate * 8)}. dwSampleSize is ${t.stream.sampleSize}, so time is derived from the byte count and chunks can be cut anywhere on a ${a.blockAlign}-byte boundary.` });
    for (const p of waveFormatProblems(a)) out.push({ level: 'warn', group: 'Tracks', title: `${t.label}: inconsistent format`, text: p });
  }
  if (t.family === 'mp3' && s?.count) {
    const rates = new Set();
    const n = Math.min(40, s.count);
    for (let k = 0; k < n; k++) {
      const i = Math.floor((k * (s.count - 1)) / Math.max(1, n - 1));
      if (!s.sizes[i]) continue;
      const bytes = await doc.source.read(s.offsets[i], Math.min(s.sizes[i], 8));
      const h = parseMpegAudioHeader(bytes, 0, bytes.length, s.offsets[i], []);
      if (h.bitrate) rates.add(h.bitrate);
    }
    const vbr = rates.size > 1;
    const perFrame = t.stream.sampleSize === 0;
    out.push({
      level: vbr && !perFrame ? 'warn' : 'info',
      group: 'Tracks',
      title: `${t.label}: ${vbr ? 'VBR' : 'CBR'} MP3${perFrame ? ', one frame per chunk' : ''}`,
      text: vbr
        ? `The MP3 frames use ${rates.size} different bitrates (${[...rates].sort((x, y) => x - y).map((r) => r / 1000).join(', ')} kb/s). AVI's audio model assumes a constant byte rate; VBR MP3 only works with the "one frame per chunk" convention (dwSampleSize 0, nBlockAlign = samples per frame), ${perFrame ? 'which this file uses' : 'which this file does not use: players that compute time from byte counts will drift out of sync with the video'}.`
        : `All frames checked use ${[...rates].map((r) => r / 1000).join(', ')} kb/s. ${perFrame ? 'Each chunk holds one MP3 frame (dwSampleSize 0, nBlockAlign ' + a.blockAlign + '), the convention that also allows VBR.' : 'Time is computed from the byte count (dwSampleSize > 0), which is only correct for constant bitrate.'}`,
    });
    if (a.codecDelay) out.push({ level: 'info', group: 'Timing', title: `${t.label}: encoder delay ${a.codecDelay} samples`, text: `MPEGLAYER3WAVEFORMAT says the encoder added ${a.codecDelay} samples (${fmtNum((a.codecDelay / a.sampleRate) * 1000, 1)} ms) of priming at the start. AVI has no way to skip them, so the audio plays that much late unless the player uses this value.` });
  }
  if (t.family === 'aac') {
    out.push({ level: 'info', group: 'Tracks', title: `${t.label}: AAC in AVI`, text: `AVI predates AAC and has no official mapping for it. This file uses format tag 0x${(a.tag ?? 0).toString(16).padStart(4, '0')} with ${a.asc ? 'the AudioSpecificConfig in the format extension' : t.sampleCfg.adts ? 'ADTS headers on every frame' : 'raw frames'}; FFmpeg and VLC play it, many hardware players do not.` });
  }
  if (c && c.fixed) out.push({ level: 'warn', group: 'Timing', title: `${t.label}: invalid dwScale / dwRate`, text: 'The stream header has a zero scale or rate, so its timing is undefined. Vidscope guessed a rate from the format; players will do the same, differently.' });
}

function headerChecks(doc, ctx, out) {
  const m = ctx.avih;
  const v = doc.tracks.find((t) => t.kind === 'video' && t.samples);
  if (m && v) {
    const c = v.samples.clock;
    const fromStrh = (c.scale / c.rate) * 1e6;
    if (m.usPerFrame && Math.abs(m.usPerFrame - fromStrh) > 1.5) {
      out.push({ level: 'info', group: 'Timing', title: 'avih and strh disagree on the frame rate', text: `avih dwMicroSecPerFrame is ${fmtInt(m.usPerFrame)} µs (${fmtNum(1e6 / m.usPerFrame, 3)} fps) but the video stream header gives ${fmtNum(c.rate / c.scale, 3)} fps. Players use the stream header.` });
    }
    const frames = v.samples.count;
    const total = ctx.dmlhTotalFrames ?? m.totalFrames;
    if (!m.totalFrames && frames) out.push({ level: 'info', group: 'Integrity', title: 'avih dwTotalFrames is 0', text: `The main header does not give the number of frames (the writer could not come back to fill it in); the stream has ${fmtInt(frames)}.` });
    if (total && Math.abs(total - frames) > 1 && !ctx.dmlhTotalFrames) {
      out.push({ level: 'warn', group: 'Integrity', title: 'Frame count mismatch', text: `The main header says ${fmtInt(total)} frames but the index lists ${fmtInt(frames)} video chunks.` });
    }
    if (m.width && v.stream.video?.width && (m.width !== v.stream.video.width || m.height !== Math.abs(v.stream.video.height))) {
      out.push({ level: 'info', group: 'Tracks', title: 'Picture size mismatch', text: `avih says ${m.width}×${m.height}, the video format says ${v.stream.video.width}×${Math.abs(v.stream.video.height)}.` });
    }
  }
  for (const t of doc.tracks) {
    const s = t.samples;
    if (!s || !s.count) continue;
    const c = s.clock;
    let units = 0;
    if (c.mode === 'bytes') units = Math.floor(t.bytes / c.sampleSize);
    else if (c.mode === 'blocks') {
      for (let i = 0; i < s.count; i++) units += Math.ceil(s.sizes[i] / c.block);
    } else units = s.count;
    const len = t.stream.length;
    if (len === 0x40000000) {
      out.push({ level: 'info', group: 'Timing', title: `${t.label}: dwLength is a placeholder`, text: `The stream header says 1,073,741,824 (2^30) units: FFmpeg writes this value when its output is not seekable and it cannot come back to store the real length. The chunks add up to ${fmtInt(units)} units (${fmtDuration((units * c.scale) / c.rate)}).` });
    } else if (len && Math.abs(units - len) > Math.max(2, len * 0.01)) {
      out.push({ level: 'info', group: 'Timing', title: `${t.label}: dwLength differs from the data`, text: `The stream header says ${fmtInt(len)} units (${fmtDuration((len * c.scale) / c.rate)}) but the chunks add up to ${fmtInt(units)} (${fmtDuration((units * c.scale) / c.rate)}).` });
    }
    if (t.stream.start) out.push({ level: 'info', group: 'Timing', title: `${t.label}: starts late`, text: `dwStart = ${fmtInt(t.stream.start)} units: this stream begins ${fmtDuration((t.stream.start * c.scale) / c.rate)} after the others.` });
  }
  const ends = doc.tracks.filter((t) => t.end).map((t) => [t.label, t.end]);
  if (ends.length > 1) {
    const max = Math.max(...ends.map((e) => e[1]));
    const min = Math.min(...ends.map((e) => e[1]));
    if (max - min > 0.5) out.push({ level: 'info', group: 'Timing', title: 'Streams end at different times', text: ends.map(([l, e]) => `${l} ends at ${fmtDuration(e)}`).join('; ') + '.' });
  }
}

// ------------------------------------------------------------ WAV

function wavInsights(doc, ctx, out) {
  const a = ctx.fmt;
  const w = doc.wav ?? {};
  const riff = riffNodes(doc)[0];
  if (!a) {
    out.push({ level: 'bad', group: 'Overview', title: 'No fmt chunk', text: 'A WAV file must describe its audio in a \'fmt \' chunk; without it the data cannot be interpreted.' });
    return;
  }
  const tag = a.subTag ?? a.tag;
  out.push({
    level: 'info', group: 'Overview', title: doc.summary.label,
    text: `${a.summary}. ${a.pcm ? 'Uncompressed PCM: the data chunk is a plain run of interleaved samples.' : 'Compressed audio in a WAV container.'}`,
    facts: [
      ['format', `${FORMAT_TAGS[tag] ?? `0x${tag.toString(16)}`}${a.tag === 0xfffe ? ' (WAVE_FORMAT_EXTENSIBLE)' : ''}`],
      ['sample rate', fmtHz(a.sampleRate)],
      ['channels', `${a.channels}${a.channelMask ? ` (${channelMaskText(a.channelMask)})` : ''}`],
      ['bits per sample', a.validBits && a.validBits !== a.bits ? `${a.validBits} valid in ${a.bits}` : String(a.bits)],
      ['duration', w.duration !== undefined ? fmtDuration(w.duration) : '—'],
      ['audio data', `${fmtInt(w.dataSize)} bytes`],
    ],
  });
  // Encoding
  const problems = waveFormatProblems(a);
  for (const p of problems) out.push({ level: 'warn', group: 'Encoding', title: 'Inconsistent fmt chunk', text: p, node: ctx.fmtNode });
  if ((tag === 1 || tag === 3) && !problems.length) {
    const range = tag === 3 ? 'floating point, so levels above 0 dBFS survive processing' : `${a.validBits || a.bits} bits give about ${fmtInt(Math.round(6.02 * (a.validBits || a.bits)))} dB of dynamic range`;
    out.push({ level: 'good', group: 'Encoding', title: `PCM ${a.bits}-bit ${tag === 3 ? 'float' : 'integer'}, parameters consistent`, text: `Each sample frame is ${a.blockAlign} bytes (${a.channels} channel${a.channels === 1 ? '' : 's'} × ${a.bits / 8} bytes) and nAvgBytesPerSec = ${fmtInt(a.sampleRate)} × ${a.blockAlign} = ${fmtInt(a.byteRate)} bytes/s. ${range[0].toUpperCase()}${range.slice(1)}.`, node: ctx.fmtNode });
  }
  if (w.duration !== undefined) {
    out.push({ level: 'info', group: 'Timing', title: `Duration ${fmtDuration(w.duration)}`, text: `Computed from ${w.source}: ${w.frames !== undefined ? `${fmtInt(w.frames)} sample frames at ${fmtHz(a.sampleRate)}` : `${fmtInt(w.dataSize)} bytes at ${fmtInt(a.byteRate)} bytes/s`}. WAV has no timestamps: every position in the data maps to a time by simple division.` });
  }
  if (a.tag === 0xfffe) {
    out.push({ level: 'good', group: 'Encoding', title: 'WAVE_FORMAT_EXTENSIBLE', text: `The format uses the extensible header: the speaker layout is explicit (${channelMaskText(a.channelMask ?? 0)}) and the real format is named by the SubFormat GUID.`, node: ctx.fmtNode });
  } else if (a.channels > 2) {
    out.push({ level: 'warn', group: 'Encoding', title: 'Multichannel audio without a channel mask', text: `${a.channels} channels with a plain WAVEFORMATEX: nothing says which channel feeds which speaker, so players guess (usually FL FR FC LFE BL BR). Re-writing the file with WAVE_FORMAT_EXTENSIBLE makes the layout explicit; FFmpeg's WAV muxer does that for more than two channels.`, cmd: `ffmpeg -i ${q(doc.name)} -c copy ${q(doc.name.replace(/(\.\w+)?$/, '-ext$1'))}` });
  }
  if (!a.pcm && tag !== 6 && tag !== 7) {
    out.push({ level: 'info', group: 'Encoding', title: `Compressed audio in WAV (${a.codec.name})`, text: 'WAV can hold compressed formats, but most software expects PCM in a .wav file; MP3 or AAC are better kept in their own containers. Compressed WAV needs a fact chunk for an exact duration.' });
    if (!ctx.factSamples && !ctx.ds64) out.push({ level: 'warn', group: 'Timing', title: 'No fact chunk', text: 'Compressed WAV files should carry a fact chunk with the sample count; without it the duration is only estimated from the byte rate.' });
  }
  if (ctx.factSamples && w.dataSize && a.sampleRate && !a.pcm && a.byteRate) {
    const real = w.dataSize / (ctx.factSamples / a.sampleRate);
    if (Math.abs(real - a.byteRate) / real > 0.05) {
      out.push({ level: 'warn', group: 'Encoding', title: 'nAvgBytesPerSec does not match the data', text: `The header announces ${fmtInt(a.byteRate)} bytes/s, but ${fmtInt(w.dataSize)} bytes for ${fmtDuration(ctx.factSamples / a.sampleRate)} of audio (fact) is ${fmtInt(Math.round(real))} bytes/s. Players that compute the duration or seek positions from nAvgBytesPerSec will get them wrong (here ${fmtDuration(w.dataSize / a.byteRate)} instead of ${fmtDuration(ctx.factSamples / a.sampleRate)}).`, node: ctx.fmtNode });
    }
  }
  // Layout
  const kids = riff?.children ?? [];
  const fmtAt = kids.findIndex((c) => c.type === 'fmt ');
  const dataAt = kids.findIndex((c) => c.type === 'data');
  if (dataAt >= 0 && fmtAt > dataAt) out.push({ level: 'warn', group: 'Layout', title: 'fmt comes after data', text: 'Streaming readers need the format before the samples; many only work when \'fmt \' precedes \'data\'.', node: ctx.fmtNode });
  if (dataAt < 0) out.push({ level: 'bad', group: 'Layout', title: 'No data chunk', text: 'The file has no audio data.' });
  if (dataAt >= 0 && dataAt < kids.length - 1) {
    const after = kids.slice(dataAt + 1).map((c) => c.type.trim());
    out.push({ level: 'info', group: 'Layout', title: 'Chunks after the audio data', text: `${after.join(', ')} come${after.length === 1 ? 's' : ''} after the data chunk. That is legal and common for metadata written at the end of a recording, but readers that stop at the data chunk will not see ${after.length === 1 ? 'it' : 'them'}.` });
  }
  if (riff?.data.id === 'RF64' || riff?.data.id === 'BW64') {
    out.push({ level: 'info', group: 'Layout', title: `${riff.data.id}: 64-bit sizes`, text: `The RIFF and data sizes are 0xFFFFFFFF and the real sizes are in ds64 (riffSize ${fmtInt(ctx.ds64?.riffSize ?? 0)}, dataSize ${fmtInt(ctx.ds64?.dataSize ?? 0)}). Readers that do not support ${riff.data.id} will reject the file${doc.size < 4 * GB ? ', which is unnecessary at this size (under 4 GB)' : ''}.` });
    if (ctx.ds64 && riff.offset + 8 + ctx.ds64.riffSize !== doc.size) out.push({ level: 'warn', group: 'Integrity', title: 'ds64 riffSize does not match the file', text: `ds64 says the RF64 chunk is ${fmtInt(ctx.ds64.riffSize)} bytes; the file implies ${fmtInt(doc.size - 8)}.` });
  } else if (doc.size > 2 * GB) {
    out.push({ level: doc.size > 4 * GB ? 'bad' : 'warn', group: 'Layout', title: 'Beyond the RIFF size limit', text: `The file is ${humanBytes(doc.size)}. RIFF sizes are 32-bit (4 GB) and many readers treat them as signed (2 GB). Long recordings should use RF64 or BW64.` });
  }
  // Integrity: truncated data
  if (ctx.dataNode && w.declared > w.dataSize) {
    const missing = w.declared - w.dataSize;
    out.push({ level: 'bad', group: 'Integrity', title: 'Audio data is truncated', text: `The data chunk declares ${fmtInt(w.declared)} bytes but only ${fmtInt(w.dataSize)} are in the file: ${humanBytes(missing)}${a.byteRate ? ` (${fmtDuration(missing / a.byteRate)} of audio)` : ''} are missing.`, node: ctx.dataNode });
  }
  if (w.dataSize && a.blockAlign && (a.pcm || a.codec.adpcm) && w.dataSize % a.blockAlign) out.push({ level: 'info', group: 'Integrity', title: 'Partial block at the end', text: `The data size is not a multiple of nBlockAlign (${a.blockAlign}): the last ${w.dataSize % a.blockAlign} bytes do not form a complete sample frame.` });
  // Metadata
  if (ctx.bext) {
    const b = ctx.bext;
    const facts = [['description', b.description || '—'], ['originator', b.originator || '—'], ['reference', b.originatorReference || '—'], ['date / time', `${b.date} ${b.time}`.trim() || '—'], ['version', String(b.version)]];
    if (a.sampleRate) facts.push(['time reference', `${fmtInt(b.timeReference)} samples = ${fmtDuration(b.timeReference / a.sampleRate)} after midnight`]);
    if (b.version >= 2) facts.push(['loudness', b.loudness === 0x7fff ? 'not set' : `${fmtNum(b.loudness / 100, 2)} LUFS`]);
    if (b.codingHistory) facts.push(['coding history', b.codingHistory.replace(/\r?\n/g, ' | ')]);
    out.push({ level: 'info', group: 'Metadata', title: 'Broadcast Wave (bext)', text: 'Broadcast metadata (EBU Tech 3285). The time reference places the first sample on a time-of-day timeline, which is how editors line up separately recorded sound with picture.', facts, node: [...walk(doc.root)].find((n) => n.type === 'bext') });
  }
  if (ctx.cues?.count) out.push({ level: 'info', group: 'Metadata', title: `${ctx.cues.count} cue point${ctx.cues.count === 1 ? '' : 's'}`, text: 'Markers in the audio (cue chunk), often named in a LIST adtl.', node: [...walk(doc.root)].find((n) => n.type === 'cue ') });
  infoTags(doc, out);
  for (const n of walk(doc.root)) {
    if (n.type === 'id3 ' || n.type === 'ID3 ') out.push({ level: 'info', group: 'Metadata', title: 'ID3 tag', text: `An ID3v2 tag is embedded in the file${n.data.summary ? `: ${n.data.summary}` : ''}.`, node: n });
    if (n.type === 'iXML' || n.type === 'axml') out.push({ level: 'info', group: 'Metadata', title: `${n.type} metadata`, text: n.data.summary ?? 'XML metadata.', node: n });
  }
}
