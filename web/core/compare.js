// Comparing a source video with its converted versions (profiles, renditions): what each file
// is, what the conversion changed or lost, whether key frames line up across the versions (what
// adaptive streaming needs), and which frame each version shows at a given moment.

import { frameTypes, analyzeFrames, frameRate, ptsOf, displayOrder, AUTO_SCAN_BYTES } from './frames.js';
import { bitrateSeries, rateStats, bitsPerPixel, rateControlGuess, frameSize } from './bitrate.js';
import { fmtInt, fmtNum, fmtBitrate, fmtDuration, humanBytes, plural } from './util.js';

/** Codecs without B-frames: they reorder with hidden (alt-ref) frames, or not at all. */
const NO_B = new Set(['av1', 'vp9', 'vp8', 'h263s', 'vp6', 'vp6a']);

/** Words in file names that name a version rather than the content ("720p", "5MB", "low"...). */
const VERSION_WORDS = /^(\d{3,4}p?|\d{3,4}x\d{3,4}|\d+(\.\d+)?(k|m|g)b?(ps)?|[48]k|2k|uhd|fhd|hd|sd|qhd|low|lo|mid|medium|high|hi|src|source|orig|original|master|mezz|mezzanine|out|output|converted|encoded|transcoded|final|profile\d*|v\d+|x26[45]|h26[45]|hevc|avc|av1|vp9|\d+)$/i;

/** The part of a file name that names the content, for grouping versions of the same video. */
export function contentStem(name) {
  const base = name.replace(/\.[^.]{1,5}$/, '').toLowerCase();
  const words = base.split(/[\s._\-+()[\]]+/).filter(Boolean);
  const kept = words.filter((w) => !VERSION_WORDS.test(w));
  return (kept.length ? kept : words).join(' ');
}

/** Seconds a track spans, from its first decode time to the end of its last frame. */
function trackSeconds(t) {
  const s = t.samples;
  if (!s?.count) return t.duration ?? 0;
  const ts = t.timescale || s.timescale || 1;
  const last = s.count - 1;
  return (s.dts[last] + (s.durations?.[last] ?? 0) - s.dts[0]) / ts;
}

/** Average bits per second of a track. */
function trackRate(t) {
  const s = t.samples;
  if (!s?.count) return t.bitrate ?? null;
  let bytes = 0;
  for (let i = 0; i < s.count; i++) bytes += s.sizes[i];
  const sec = trackSeconds(t);
  return sec > 0 ? (bytes * 8) / sec : null;
}

/** Everything the comparison needs about one file, from its opened Doc. */
export async function summarize(doc, { onProgress } = {}) {
  if (doc.loadSamples) await doc.loadSamples(onProgress);
  const video = doc.tracks.find((t) => t.kind === 'video' && t.samples?.count) ?? null;
  const item = {
    doc,
    name: doc.name,
    video,
    audio: doc.tracks.filter((t) => t.kind === 'audio'),
    subs: doc.tracks.filter((t) => t.kind === 'subtitle'),
    duration: doc.summary.duration || null,
  };
  if (!item.duration) item.duration = doc.tracks.reduce((m, t) => Math.max(m, trackSeconds(t)), 0) || null;
  if (!video) return item;
  const ft = frameTypes(doc, video);
  if (ft.ctx && !ft.complete && ft.scanBytes <= AUTO_SCAN_BYTES) {
    const off = onProgress ? ft.onChange((f) => onProgress(f.scanned, f.count, 'reading frame types')) : null;
    await ft.ensure();
    off?.();
  }
  item.ft = ft;
  item.frames = analyzeFrames(ft);
  const s = video.samples;
  const ts = video.timescale || s.timescale || 1;
  // Presentation times from the first frame shown, so that versions with different start
  // offsets (B-frame delay, edit lists, MPEG-TS clocks) line up.
  const { order, rank } = displayOrder(video);
  let start = Infinity;
  for (let i = 0; i < s.count; i++) start = Math.min(start, ptsOf(s, i));
  const times = new Float64Array(s.count);
  for (let k = 0; k < s.count; k++) times[k] = (ptsOf(s, order[k]) - start) / ts;
  item.start = start / ts;
  item.times = times; // display order
  item.order = order;
  item.rank = rank;
  const keys = [];
  for (let k = 0; k < s.count; k++) if (!s.key || s.key[order[k]]) keys.push(times[k]);
  item.keyTimes = Float64Array.from(keys);
  const fr = frameRate(video);
  item.fps = fr ? niceFps(fr) : null;
  item.size = frameSize(video);
  const seconds = trackSeconds(video);
  item.rate = rateStats(bitrateSeries([video], 1).series[0].bits, 1, seconds);
  item.bpp = bitsPerPixel(video, item.rate.avg);
  item.guess = rateControlGuess(item.rate, seconds);
  item.avgFrame = item.frames.totalBytes / s.count;
  item.encoder = await encoderString(doc, video);
  return item;
}

/** The x264/x265 settings string an encoder left in the first frame's SEI, if any. */
async function encoderString(doc, t) {
  try {
    const d = await doc.detailAt(t.samples.offsets[0]);
    const walk = (fields) => {
      for (const f of fields ?? []) {
        if (typeof f.value === 'string' && /^x26[45]\b/.test(f.value)) return f.value.replace(/\0+$/, '');
        const inner = walk(f.children);
        if (inner) return inner;
      }
      return null;
    };
    for (const u of d?.units ?? []) {
      const found = walk(u.fields);
      if (found) return found;
    }
  } catch {
    // this format has no frame details
  }
  return null;
}

/** "x264 core 164 · crf 23 · keyint 250": the version and the options that matter most. */
export function encoderSummary(str) {
  if (!str) return null;
  const who = str.split(' - ').slice(0, 2).join(' ').replace(/[:[].*$/, '').trim();
  const opts = new Map();
  const m = /options:\s*(.*)$/s.exec(str);
  for (const part of (m?.[1] ?? '').split(/\s+/)) {
    const eq = part.indexOf('=');
    if (eq > 0) opts.set(part.slice(0, eq).replace(/-/g, '_'), part.slice(eq + 1));
  }
  const rc = opts.get('rc');
  const bits = [];
  if (rc === 'crf' || (!rc && opts.has('crf'))) bits.push(`crf ${opts.get('crf')}`);
  else if (rc === 'cqp' || rc === 'cq') bits.push(`qp ${opts.get('qp') ?? '?'}`);
  else if (opts.has('bitrate')) bits.push(`${rc === 'cbr' ? 'CBR' : 'ABR'} ${opts.get('bitrate')} kb/s`);
  if (opts.has('vbv_maxrate') && opts.get('vbv_maxrate') !== '0') bits.push(`maxrate ${opts.get('vbv_maxrate')} / bufsize ${opts.get('vbv_bufsize')}`);
  if (opts.has('keyint')) bits.push(`keyint ${opts.get('keyint')}`);
  if (opts.has('bframes')) bits.push(`bframes ${opts.get('bframes')}`);
  if (opts.has('ref')) bits.push(`ref ${opts.get('ref')}`);
  return { who, text: [who, ...bits].join(' · '), options: opts };
}

/**
 * Whether track b is a copy of track a (remuxed, not re-encoded): the same number of frames
 * with exactly the same sizes. null when either track is missing or has no frame table.
 */
export function copiedTrack(a, b) {
  const sa = a?.samples;
  const sb = b?.samples;
  if (!sa?.count || !sb?.count) return null;
  if (sa.count !== sb.count) return false;
  for (let i = 0; i < sa.count; i++) if (sa.sizes[i] !== sb.sizes[i]) return false;
  return true;
}

// ------------------------------------------------------------ side-by-side properties

const prop = (t, re) => (t?.props ?? []).find(([k]) => re.test(k))?.[1] ?? null;
const propRow = (t, re) => {
  const v = prop(t, re);
  return v ? { text: v } : null;
};
const change = (a, b) => {
  const r = b ? Math.abs(a - b) / b : 0;
  return r >= 0.0005 ? `${a >= b ? '+' : '−'}${fmtNum(r * 100, r < 0.1 ? 1 : 0)} %` : null;
};

/** Common frame rates: a rate measured from rounded timestamps (29.999) snaps to the one it is. */
const RATES = [24000 / 1001, 24, 25, 30000 / 1001, 30, 48, 50, 60000 / 1001, 60, 100, 120000 / 1001, 120];

export function niceFps(fps) {
  for (const r of RATES) if (Math.abs(fps - r) / r < 2e-4) return r;
  return fps;
}

/** "30 fps", "29.97 fps", "23.976 fps". */
export function fpsText(fps) {
  const r = Math.round(fps * 1000) / 1000;
  return `${Number.isInteger(r) ? fmtInt(r) : String(r)} fps`;
}
const lang = (t) => {
  const v = prop(t, /^language$/);
  return v && !/^und\b/.test(v) ? v.replace(/ — .*$/, '') : null;
};

/** Names of video codec families, the same whatever the container calls the codec. */
const VIDEO_NAMES = { avc: 'H.264 / AVC', hevc: 'H.265 / HEVC', av1: 'AV1', vp9: 'VP9', vp8: 'VP8', mpeg2v: 'MPEG-2 Video', mpeg4v: 'MPEG-4 Part 2', h263s: 'Sorenson H.263', vp6: 'VP6', vp6a: 'VP6 with alpha' };

export function videoCodecName(it) {
  const fam = it.ft?.family ?? it.video?.family;
  return VIDEO_NAMES[fam] ?? it.video?.codecName ?? null;
}

/** The audio codec, named the same in every container ("AAC" in MKV is "MPEG-4 Audio (AAC)" in MP4). */
export function audioCodecName(t) {
  if (!t) return null;
  const cs = t.codecString ?? '';
  const name = t.codecName ?? '';
  const aac = /^mp4a\.40\.(\d+)$/.exec(cs);
  if (aac) return { 2: 'AAC LC', 5: 'HE-AAC', 29: 'HE-AAC v2' }[aac[1]] ?? 'AAC';
  if (/\bAAC\b/.test(name)) return 'AAC';
  if (/Layer II\b/.test(name)) return 'MP2';
  if (/\bMP3\b|Layer III/.test(name)) return 'MP3';
  if (/^ec-3$/.test(cs) || /^E-AC-3/.test(name)) return 'E-AC-3';
  if (/^ac-3$/.test(cs) || /^AC-3/.test(name)) return 'AC-3';
  if (/^opus$/i.test(cs) || /^Opus/.test(name)) return 'Opus';
  if (/^flac$/i.test(cs) || /^FLAC/.test(name)) return 'FLAC';
  if (/^vorbis$/i.test(cs) || /^Vorbis/.test(name)) return 'Vorbis';
  if (/^PCM/.test(name)) return 'PCM';
  return name || null;
}

function trackCounts(it) {
  const parts = [];
  const nv = it.doc.tracks.filter((t) => t.kind === 'video').length;
  if (nv) parts.push(plural(nv, 'video', 'video'));
  if (it.audio.length) parts.push(plural(it.audio.length, 'audio', 'audio'));
  if (it.subs.length) parts.push(plural(it.subs.length, 'subtitle'));
  return parts.join(', ') || 'none';
}

function fastStart(doc) {
  if (doc.format.id !== 'isobmff') return null;
  const kids = doc.root.children ?? [];
  if (kids.some((n) => n.type === 'moof')) return 'fragmented (moof)';
  const moov = kids.findIndex((n) => n.type === 'moov');
  const mdat = kids.findIndex((n) => n.type === 'mdat');
  if (moov < 0 || mdat < 0) return null;
  return moov < mdat ? 'yes: moov before mdat' : 'no: moov after mdat';
}

function gopRow(it) {
  const g = it.frames?.gop;
  if (!g) return null;
  if (it.ft?.intraOnly) return { text: 'every frame is a key frame' };
  if (g.count <= 1) return { text: g.count ? 'a single key frame' : 'no key frame' };
  if (g.fixed) return { text: `${fmtInt(g.minFrames)} frames (${fmtNum(g.avgSeconds, 2)} s), fixed`, value: g.avgSeconds };
  return { text: `${fmtInt(g.minFrames)}–${fmtInt(g.maxFrames)} frames (varies)`, value: g.avgSeconds };
}

function bRow(it) {
  const f = it.frames;
  if (!f?.classified) return null;
  if (NO_B.has(it.ft.family)) return { text: f.hidden ? 'none (hidden alt-ref frames instead)' : 'none (not in this codec)' };
  return { text: f.maxB ? `up to ${f.maxB} in a row${f.refB ? ', B-pyramid' : ''}` : 'none' };
}

function mixRow(it) {
  const f = it.frames;
  if (!f?.classified) return null;
  const T = f.types;
  const n = f.classified;
  const p = (x) => `${fmtNum((x / n) * 100, x / n < 0.1 ? 1 : 0)} %`;
  const parts = [`I ${p(T.I.count)}`, `P ${p(T.P.count + T.p.count)}`];
  if (T.B.count + T.b.count || !NO_B.has(it.ft.family)) parts.push(`B ${p(T.B.count + T.b.count)}`);
  if (T.S.count) parts.push(`S ${p(T.S.count)}`);
  if (T['='].count) parts.push(`shown again ${p(T['='].count)}`);
  return { text: parts.join(' · ') };
}

function tracksList(list, name = (t) => t.codecName) {
  if (!list.length) return null;
  return { text: list.map((t) => `${name(t)}${lang(t) ? ` (${lang(t)})` : ''}`).join(', ') };
}

/**
 * Rows of the side-by-side table. `get(item)` returns { text, value?, title? } or null when the
 * file has no such thing; `head` rows make the "what changed" summary; `miss: 'na'` rows show a
 * missing value as unknown instead of lost, for properties that not every format or codec
 * parser reports (a missing colour description may just be one that was not read).
 */
const ROWS = [
  { group: 'File', label: 'container', head: true, tip: 'The file format that wraps the streams. Changing only the container (remuxing, -c copy) leaves the video and audio untouched.', get: (it) => ({ text: it.doc.summary.label }) },
  { group: 'File', label: 'file size', tip: 'Bytes on disk. For the same content, size follows the average bitrate: size = bitrate × duration.', get: (it) => ({ text: humanBytes(it.doc.size), value: it.doc.size }) },
  { group: 'File', label: 'duration', head: true, near: 0.005, tip: 'How long the file plays. A version shorter or longer than its source was trimmed, or lost or gained frames. Containers count the end slightly differently, so a few milliseconds of difference mean nothing.', get: (it) => (it.duration ? { text: fmtDuration(it.duration), value: it.duration } : null) },
  { group: 'File', label: 'overall bitrate', tip: 'All tracks together: file size × 8 ÷ duration.', get: (it) => (it.duration ? { text: fmtBitrate((it.doc.size * 8) / it.duration), value: (it.doc.size * 8) / it.duration } : null) },
  { group: 'File', label: 'tracks', head: true, tip: 'How many video, audio and subtitle tracks the file has. Conversions often drop subtitles and extra audio languages unless told to keep them (-map 0).', get: (it) => ({ text: trackCounts(it) }) },
  { group: 'File', label: 'fast start', head: true, miss: 'na', tip: 'MP4 only: whether the index (moov) comes before the media data (mdat), so a player can start before the whole file has downloaded. FFmpeg puts it at the end unless told -movflags +faststart.', get: (it) => { const v = fastStart(it.doc); return v ? { text: v } : null; } },
  { group: 'File', label: 'encryption', head: true, tip: 'Whether the media is encrypted (DRM). Encrypted frames can still be counted and sized, but not decoded without the key.', get: (it) => { const t = it.doc.tracks.find((x) => prop(x, /^encryption$/)); return t ? { text: prop(t, /^encryption$/).replace(/, KID .*$/, '') } : null; } },

  { group: 'Video', label: 'codec', head: true, tip: 'The compression format of the video. Converting to another codec (H.264 → HEVC, AV1...) changes how efficiently bits are used and which devices can play the file.', get: (it) => (it.video ? { text: videoCodecName(it), title: it.video.codecName } : null) },
  { group: 'Video', label: 'profile / level', head: true, miss: 'na', tip: 'The profile says which coding tools the encoder may use; the level caps resolution, frame rate and bitrate. Lower profiles and levels play on more devices.', get: (it) => propRow(it.video, /^profile/) },
  { group: 'Video', label: 'codec string', miss: 'na', tip: 'The RFC 6381 codec string that players and HLS/DASH manifests use to check they can decode the stream (avc1.64001F = H.264 High profile, level 3.1).', get: (it) => (it.video?.codecString ? { text: it.video.codecString } : null) },
  { group: 'Video', label: 'resolution', head: true, tip: 'Picture size in pixels. Lower profiles of a ladder shrink it: halving the width and height leaves a quarter of the pixels.', get: (it) => (it.size ? { text: `${it.size.width}×${it.size.height}`, value: it.size.width * it.size.height } : null) },
  { group: 'Video', label: 'rotation', head: true, tip: 'Phones record in one orientation and store how to rotate the picture. A conversion that drops this flag, or rotates the pixels instead, shows up here.', get: (it) => propRow(it.video, /^rotation$/) },
  { group: 'Video', label: 'frame rate', head: true, tip: 'Frames per second. Most conversions keep it; some halve it for small profiles (60 → 30) to save bits.', get: (it) => (it.fps ? { text: fpsText(it.fps), value: it.fps } : null) },
  { group: 'Video', label: 'chroma / bit depth', head: true, miss: 'na', tip: 'Chroma subsampling (4:2:0 keeps colour at a quarter of the resolution) and bits per sample. HDR needs 10-bit; converting to 8-bit loses precision and can cause banding.', get: (it) => propRow(it.video, /^chroma \/ depth$/) },
  { group: 'Video', label: 'scan', head: true, miss: 'na', tip: 'Interlaced video stores two half-pictures (fields) per frame, as TV did. Streaming converts it to progressive (deinterlacing).', get: (it) => propRow(it.video, /^scan$/) },
  { group: 'Video', label: 'colour', head: true, miss: 'na', tip: 'Colour primaries, transfer function and matrix: how the numbers map to real colours. A change here (PQ or HLG → BT.709) means HDR was converted to SDR, and a missing value means the colour tags were dropped.', get: (it) => propRow(it.video, /^colou?r$/) },
  { group: 'Video', label: 'HDR mastering', head: true, miss: 'na', tip: 'The brightness range of the display the HDR video was graded on. Converting to SDR drops it.', get: (it) => propRow(it.video, /^mastering display$/) },
  { group: 'Video', label: 'frames', tip: 'How many pictures the video has. Different counts for the same duration mean a frame-rate change or dropped frames.', get: (it) => (it.video ? { text: fmtInt(it.video.samples.count), value: it.video.samples.count } : null) },
  { group: 'Video', label: 'video bitrate', head: true, tip: 'Average bits per second of the video track alone. In a ladder, each step down usually uses roughly half to two thirds of the bits of the step above.', get: (it) => (it.rate ? { text: fmtBitrate(it.rate.avg), value: it.rate.avg } : null) },
  { group: 'Video', label: 'peak bitrate (1 s)', tip: 'The most bits used in any one second. Streaming profiles cap it (-maxrate, -bufsize) so players on a given connection keep up.', get: (it) => (it.rate ? { text: fmtBitrate(it.rate.peak), value: it.rate.peak } : null) },
  { group: 'Video', label: 'bits per pixel', tip: 'Bitrate ÷ (width × height × fps): bits spent per pixel. It compares profiles of different sizes; small profiles usually need more bits per pixel to look acceptable, because each pixel carries more detail.', get: (it) => (it.bpp ? { text: fmtNum(it.bpp, 3), value: it.bpp } : null) },
  { group: 'Video', label: 'rate control (guess)', tip: 'How the encoder seems to have spent its bits, judging from the bitrate curve: constant, capped, or quality-based (CRF). The encoder row says for sure when the settings are stored.', get: (it) => (it.guess ? { text: it.guess.label } : null) },
  { group: 'Video', label: 'encoder', miss: 'na', tip: 'The encoder and its main settings, when it stored them in the stream (x264 and x265 do, in an SEI message in the first frame).', get: (it) => { const e = encoderSummary(it.encoder); return e ? { text: e.text, title: it.encoder } : null; } },
  { group: 'Video', label: 'GOP', head: true, tip: 'Frames from one key frame to the next. Streaming profiles use a fixed GOP that divides the segment length (2 s is common), the same in every profile, so that players can switch between profiles at segment boundaries.', get: gopRow },
  { group: 'Video', label: 'open GOPs', tip: 'GOPs whose first frames refer to the previous GOP. They save a few bits, but many packagers and players expect closed GOPs at segment boundaries.', get: (it) => (it.frames && (it.frames.gop.open || it.frames.gop.closed) ? { text: it.frames.gop.open ? plural(it.frames.gop.open, 'open GOP') : 'none', value: it.frames.gop.open } : null) },
  { group: 'Video', label: 'B-frames', head: true, tip: 'The longest run of B-frames between reference frames, and whether some B-frames are references themselves (B-pyramid). Baseline profile and low-latency settings use none; AV1 and VP9 have no B-frames but hide future frames (alt-ref) instead.', get: bRow },
  { group: 'Video', label: 'hidden frames', miss: 'na', tip: 'AV1 and VP9 frames that are decoded but never shown: usually a future picture (alternate reference, "alt-ref") that the frames around it are predicted from, which does the job of B-frames. They travel inside the packet of a shown frame.', get: (it) => (it.frames?.classified && NO_B.has(it.ft.family) ? { text: plural(it.frames.hidden, 'hidden frame') } : null) },
  { group: 'Video', label: 'frame types', tip: 'The share of I-, P- and B-frames. The mix mostly depends on encoder settings, not on the resolution.', get: mixRow },
  { group: 'Video', label: 'I-frame share of bytes', tip: 'How much of the video\'s bytes go to I-frames. At low bitrates key frames take a bigger share, which is one reason small profiles need relatively more bits.', get: (it) => (it.frames?.types.I.count ? { text: `${fmtNum((it.frames.types.I.bytes / it.frames.totalBytes) * 100, 1)} %` } : null) },

  { group: 'Audio', label: 'audio tracks', head: true, tip: 'Audio tracks, with their codec and language. Conversions often re-encode audio to AAC, and keep only the first audio track unless told otherwise.', get: (it) => tracksList(it.audio, audioCodecName) },
  { group: 'Audio', label: 'channels', head: true, tip: 'Mono, stereo, 5.1... Streaming profiles often mix surround down to stereo (-ac 2).', get: (it) => propRow(it.audio[0], /^channels$/) },
  { group: 'Audio', label: 'sample rate', head: true, tip: 'Audio samples per second: 44.1 kHz (CD) or 48 kHz (video) typically.', get: (it) => propRow(it.audio[0], /^sample rate$/) },
  { group: 'Audio', label: 'audio bitrate', head: true, tip: 'Average bits per second of the first audio track. 96–160 kb/s is typical for stereo AAC in streaming.', get: (it) => { const r = it.audio[0] ? trackRate(it.audio[0]) : null; return r ? { text: fmtBitrate(r), value: r } : null; } },

  { group: 'Other', label: 'subtitles', head: true, tip: 'Subtitle tracks, with their format and language. MP4 cannot hold most subtitle formats (SRT, ASS, PGS), so converting to MP4 often loses them.', get: (it) => tracksList(it.subs) },
];

/**
 * The side-by-side table: [{ group, label, tip, head, cells: [{ text, note?, title?, state }] }].
 * A cell's state says how it relates to the reference: 'ref', 'same', 'changed', 'lost',
 * 'gained' or 'na' (not known for this file).
 */
export function compareRows(items, ref) {
  const out = [];
  for (const row of ROWS) {
    const vals = items.map((it) => (it && !it.error ? row.get(it) : null));
    if (vals.every((v) => !v)) continue;
    const r = vals[ref];
    const cells = vals.map((v, k) => {
      if (k === ref) return { text: v?.text ?? '—', title: v?.title, state: 'ref' };
      if (!items[k] || items[k].error) return { text: '', state: 'na' };
      if (!v) return { text: '—', state: r && row.miss !== 'na' ? 'lost' : 'na' };
      if (!r) return { text: v.text, title: v.title, state: row.miss === 'na' ? 'na' : 'gained' };
      if (v.text === r.text) return { text: v.text, title: v.title, state: 'same' };
      // Within the row's tolerance: the same for practical purposes (container rounding).
      if (row.near && v.value !== undefined && r.value && Math.abs(v.value - r.value) / r.value <= row.near) return { text: v.text, title: v.title, state: 'same', near: true };
      return { text: v.text, title: v.title, state: 'changed', note: v.value !== undefined && r.value ? change(v.value, r.value) : null };
    });
    out.push({ group: row.group, label: row.label, tip: row.tip, head: !!row.head, cells });
  }
  return out;
}

/** What changed from the reference to file k, as short lines: [{ label, from, to, note, state }]. */
export function changesFor(rows, ref, k) {
  const out = [];
  for (const r of rows) {
    if (!r.head) continue;
    const c = r.cells[k];
    if (c.state === 'changed' || c.state === 'lost' || c.state === 'gained') out.push({ label: r.label, from: r.cells[ref].text, to: c.text, note: c.note, state: c.state });
  }
  return out;
}

// ------------------------------------------------------------ key frames

/** Half a frame of the fastest file: key frames closer than this count as the same moment. */
function tolerance(items) {
  let tol = Infinity;
  for (const it of items) if (it?.fps) tol = Math.min(tol, 0.5 / it.fps);
  return Number.isFinite(tol) ? tol : 0.02;
}

function hasNear(arr, t, tol) {
  let lo = 0;
  let hi = arr.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < t - tol) lo = mid + 1;
    else if (arr[mid] > t + tol) hi = mid - 1;
    else return true;
  }
  return false;
}

/**
 * How well key frames line up across the converted versions (every file but the reference):
 * what adaptive streaming needs, since a player switches between versions at key frames.
 * Also how many of each file's key frames are at a moment the reference has one.
 */
export function keyAlignment(items, ref) {
  const tol = tolerance(items);
  const vids = items.map((it, k) => ({ it, k })).filter(({ it }) => it?.keyTimes?.length);
  const others = vids.filter(({ k }) => k !== ref);
  const refKeys = items[ref]?.keyTimes ?? null;
  const per = items.map((it, k) => {
    if (!it?.keyTimes?.length) return null;
    const mine = it.keyTimes;
    const peers = others.filter((o) => o.k !== k);
    const odd = new Uint8Array(mine.length); // no key frame at that moment in some other version
    let alignedAll = 0;
    let withRef = 0;
    for (let i = 0; i < mine.length; i++) {
      const t = mine[i];
      if (peers.every((o) => hasNear(o.it.keyTimes, t, tol))) alignedAll++;
      else if (k !== ref) odd[i] = 1;
      if (k !== ref && refKeys && hasNear(refKeys, t, tol)) withRef++;
    }
    return { keys: mine.length, alignedAll, withRef, odd };
  });
  const versions = others.map(({ k }) => per[k]);
  return { tol, per, versions: versions.length, aligned: versions.length > 1 && versions.every((p) => p.alignedAll === p.keys) };
}

/**
 * Segment lengths every version could be cut into: for each length, how many segment
 * boundaries miss a key frame in some version (0 means the files can be cut there).
 */
export function segmentFit(items, ref, lengths = [2, 4, 6, 10]) {
  const tol = tolerance(items);
  const list = items.filter((it, k) => k !== ref && it?.keyTimes?.length);
  if (!list.length) return [];
  let dur = Infinity;
  for (const it of list) dur = Math.min(dur, it.duration ?? it.times[it.times.length - 1]);
  return lengths.map((len) => {
    let bounds = 0;
    let missing = 0;
    let first = null;
    for (let t = len; t < dur - tol; t += len) {
      bounds++;
      if (!list.every((it) => hasNear(it.keyTimes, t, tol))) {
        missing++;
        if (first === null) first = t;
      }
    }
    return { len, bounds, missing, first };
  });
}

// ------------------------------------------------------------ bitrate over time

/** A time slice that gives at most about `max` slices over `seconds`. */
export function sliceFor(seconds, max = 200) {
  for (const b of [0.25, 0.5, 1, 2, 5, 10, 30, 60, 300]) if (seconds / b <= max) return b;
  return 600;
}

/** Bits per slice of presentation time (from each file's first frame): Float64Array(n). */
export function bitsOverTime(it, bin, n) {
  const out = new Float64Array(n);
  const s = it.video?.samples;
  if (!s) return out;
  for (let k = 0; k < s.count; k++) {
    const b = Math.floor(it.times[k] / bin);
    if (b >= 0 && b < n) out[b] += s.sizes[it.order[k]] * 8;
  }
  return out;
}

// ------------------------------------------------------------ the frame shown at a moment

/**
 * Index (decoding order) of the frame a file shows at time t (seconds from its first frame).
 * Times within a millisecond count as the same moment: files with different timescales round the
 * same frame time differently (3.066667 s at 1/15360 s is 3.066688 s at 1/16000 s).
 */
export function frameAtTime(it, t) {
  const times = it.times;
  if (!times?.length) return -1;
  if (t < times[0]) return it.order[0];
  let lo = 0;
  let hi = times.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (times[mid] <= t + 1e-3) lo = mid;
    else hi = mid - 1;
  }
  return it.order[lo];
}

/** The GOP (from analyzeFrames) that frame i (decoding order) belongs to. */
export function gopOf(it, i) {
  const gops = it.frames?.gops;
  if (!gops?.length) return null;
  let lo = 0;
  let hi = gops.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (gops[mid].start <= i) lo = mid;
    else hi = mid - 1;
  }
  return { index: lo, gop: gops[lo] };
}

/** Everything about frame i of a file, for the microscope. */
export function frameFacts(it, i) {
  const s = it.video.samples;
  const k = it.rank[i];
  const g = gopOf(it, i);
  return {
    i,
    display: k,
    time: it.times[k],
    size: s.sizes[i],
    key: !s.key || !!s.key[i],
    type: it.ft.have[i] ? it.ft.type[i] : 0,
    flags: it.ft.have[i] ? it.ft.flags[i] : 0,
    known: !!it.ft.have[i],
    gopIndex: g?.index ?? -1,
    gop: g?.gop ?? null,
    // Frames a decoder has to decode, from the GOP's key frame, before it can show this one.
    decodeFrom: g ? i - g.gop.start + 1 : null,
    sinceKey: g ? it.times[k] - it.times[it.rank[g.gop.start]] : null,
    vsAverage: it.avgFrame ? s.sizes[i] / it.avgFrame : null,
  };
}

/** Frames of file `it` around display position k: [{ i, k }] in display order. */
export function framesAround(it, k, before = 12, after = 12) {
  const n = it.times.length;
  const a = Math.max(0, Math.min(k - before, n - before - after - 1));
  const b = Math.min(n, a + before + after + 1);
  const out = [];
  for (let j = a; j < b; j++) out.push({ i: it.order[j], k: j });
  return out;
}
