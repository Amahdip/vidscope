// FFmpeg command lines for the open file: the best-known ffprobe, ffplay and ffmpeg commands,
// explained token by token and filled in with what Vidscope knows (the file's path, the
// selected track as a stream specifier, the selected frame's time, the frame rate).
//
// A command is a list of tokens { t, tip, ph?, ctx?, glue?, role?, ff? }: t is the text exactly as
// it is copied into a shell, tip explains it, ph marks a placeholder the reader has to replace, ctx
// a value filled in from the file or the selection, glue joins a token to the previous one without
// a space (pieces of one filter graph), role tells the tests which token is the input, an output,
// a time..., and ff how an ffplay option carries over to ffmpeg (in: input option, out: output
// option, play: ffplay only). Runs in the browser and in Node (tests).

// ------------------------------------------------------------------ shell quoting (POSIX sh)

// Characters that never need quoting in sh, bash or zsh. '=' is safe except at the start of a
// word (zsh expands =cmd to the command's path); '~' only means $HOME at the start, but is
// quoted everywhere for clarity.
const SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/;

/** A word for POSIX sh: unchanged when safe, else in single quotes (' written as '\''). */
export function shq(s) {
  const str = String(s);
  if (str !== '' && SAFE.test(str) && str[0] !== '=') return str;
  return `'${str.replace(/'/g, "'\\''")}'`;
}

/** The body of a double-quoted sh word: \ " $ ` escaped; ! closes the quotes around it (history expansion). */
function dqBody(s) {
  return String(s).replace(/[\\"$`]/g, '\\$&').replace(/!/g, `"'!'"`);
}

/** Does this text need quoting in a shell word? */
function needsQuotes(s) {
  return !(s !== '' && SAFE.test(s) && s[0] !== '=');
}

/**
 * FFmpeg filter graph escaping for a value inside a filter option (a file name): first the option
 * level (\ ' :), then the filter graph level (\ ' [ ] , ;). Ordinary paths come out unchanged.
 */
export function filterValue(s) {
  const level1 = String(s).replace(/[\\':]/g, '\\$&');
  return level1.replace(/[\\'[\],;]/g, '\\$&');
}

/** A path for the concat demuxer's list file: in single quotes, ' written as '\''. */
function concatQuote(s) {
  return `'${String(s).replace(/'/g, "'\\''")}'`;
}

// ------------------------------------------------------------------ the file's path

/**
 * Where the open file lives. Files from the Vidscope server have a folder (which may start with
 * ~ for the home folder); dropped files only have a name.
 *   { kind: 'home', rest: 'Movies/clip.mp4' }  { kind: 'abs', path: '/data/clip.mp4' }
 *   { kind: 'rel', path: 'clip.mp4' }
 */
export function filePath(entry, name) {
  const fileName = entry?.name ?? name ?? 'input.mp4';
  const dir = entry?.kind === 'server' ? entry.dir : null;
  if (!dir) return { kind: 'rel', path: fileName, name: fileName, known: false };
  if (dir === '~') return { kind: 'home', rest: fileName, name: fileName, known: true };
  if (dir.startsWith('~/')) return { kind: 'home', rest: `${dir.slice(2)}/${fileName}`, name: fileName, known: true };
  const sep = dir.endsWith('/') ? '' : '/';
  return { kind: 'abs', path: `${dir}${sep}${fileName}`, name: fileName, known: true };
}

/** The path as one shell word: ~/ stays unquoted so the shell expands it. */
export function shellPath(p) {
  if (p.kind === 'home') return needsQuotes(p.rest) ? `~/${shq(p.rest)}` : `~/${p.rest}`;
  if (p.kind === 'abs') return shq(p.path);
  // A relative name that starts with - would read as an option; one with : as a protocol (x:y.mp4).
  const rel = /^-|:/.test(p.path) ? `./${p.path}` : p.path;
  return shq(rel);
}

/** The path inside a double-quoted filter graph: filter-escaped, with $HOME for ~. */
function graphPath(p) {
  if (p.kind === 'home') return `$HOME/${dqBody(filterValue(p.rest))}`;
  const path = p.kind === 'rel' && /^-|:/.test(p.path) ? `./${p.path}` : p.path;
  return dqBody(filterValue(path));
}

/** A line of a concat list file ("file '…'") as one double-quoted shell word ($HOME expands). */
function concatLine(p) {
  if (p.kind === 'home') return `"file '$HOME/${dqBody(concatQuote(p.rest).slice(1, -1))}'"`;
  return `"${dqBody(`file ${concatQuote(p.path)}`)}"`;
}

// ------------------------------------------------------------------ tokens

/** One token (or a flag and its value) with its explanation. */
function tk(t, tip, extra) {
  return { t: String(t), tip, ...extra };
}

/**
 * One shell word made of several explained pieces (a filter graph): the word is double-quoted
 * when any piece needs it, and every piece keeps its own tooltip. Pieces are { t, tip, raw?, role? }:
 * raw text is inserted as is (already escaped, e.g. a path with $HOME). `extra` applies to the
 * whole word (role, and ff: how the tests translate an ffplay option for ffmpeg).
 */
function word(pieces, extra = {}) {
  const plain = pieces.map((p) => p.t).join('');
  const quote = pieces.some((p) => p.raw) || needsQuotes(plain);
  return pieces.map((p, i) => {
    let t = quote && !p.raw ? dqBody(p.t) : p.t;
    if (quote && i === 0) t = `"${t}`;
    if (quote && i === pieces.length - 1) t = `${t}"`;
    return { t, tip: p.tip, ph: p.ph, ctx: p.raw ? true : undefined, glue: i > 0, role: i === 0 ? extra.role : p.role ?? extra.role, ff: extra.ff };
  });
}

/** The command line as text: tokens joined by spaces, glued pieces without. */
export function commandText(tokens) {
  let s = '';
  tokens.forEach((x, i) => {
    s += (i && !x.glue ? ' ' : '') + x.t;
  });
  return s;
}

// ------------------------------------------------------------------ FFmpeg's view of the tracks

const TYPE_OF_KIND = { video: 'v', audio: 'a', subtitle: 's', data: 'd', timecode: 'd', hint: 'd' };
const TYPE_NAME = { v: 'video', a: 'audio', s: 'subtitle', d: 'data' };

/** MP4 text tracks that another track points to with a 'chap' reference hold chapter titles. */
function chapterTrackIds(doc) {
  const ids = new Set();
  for (const t of doc.tracks) {
    for (const r of t.node?.find?.('tref')?.children ?? []) if (r.type === 'chap') for (const id of r.data.ids ?? []) ids.add(id);
  }
  return ids;
}

/** Cover images FFmpeg turns into video streams before the first trak (iTunes 'covr' in a udta written before the tracks). */
function coversBeforeTracks(doc) {
  let n = 0;
  for (const c of doc.root.child?.('moov')?.children ?? []) {
    if (c.type === 'trak') break;
    for (const covr of c.findAll?.('covr') ?? []) n += covr.childrenOf('data').length || 1;
  }
  return n;
}

/**
 * How FFmpeg numbers the streams of this file, per track: { index, type, n, spec } where index is
 * FFmpeg's stream index, type v/a/s/d, n the index among streams of that type and spec the
 * type-relative stream specifier ("v:0", "a:1"). null for tracks FFmpeg does not expose.
 *
 * MP4/MOV: one stream per trak, in file order (chapter text tracks and timecode become data
 * streams); Matroska: one per TrackEntry of a type FFmpeg reads, attachments after them; MPEG-TS:
 * PMT order, one stream per PID; AVI, WAV and FLV: the order Vidscope already uses.
 */
export function streamMap(doc) {
  const fmt = doc?.format?.id;
  const out = [];
  let index = fmt === 'isobmff' ? coversBeforeTracks(doc) : 0;
  const counts = { v: fmt === 'isobmff' ? index : 0, a: 0, s: 0, d: 0 };
  const chapters = fmt === 'isobmff' ? chapterTrackIds(doc) : null;
  for (const t of doc?.tracks ?? []) {
    let type = TYPE_OF_KIND[t.kind] ?? 'd';
    if (fmt === 'matroska') {
      // FFmpeg skips tracks without a codec and track types other than video, audio, subtitle and metadata.
      if (t.placeholder || !t.codec || ![1, 2, 17, 33].includes(t.type)) {
        out.push(null);
        continue;
      }
      type = { 1: 'v', 2: 'a', 17: 's', 33: 'd' }[t.type];
    }
    if (chapters?.has(t.id) && t.kind !== 'video') type = 'd';
    const n = counts[type]++;
    out.push({ index: index++, type, n, spec: `${type}:${n}` });
  }
  return out;
}

// ------------------------------------------------------------------ FFmpeg's timeline

/** MP4 edit list: { mediaTime, empty } in track ticks (the first edit only), or null. */
function editShift(doc, t) {
  const tbl = t.node?.find?.('elst')?.data?.table;
  if (!tbl?.count) return null;
  const movieTs = doc.root.child('moov')?.child('mvhd')?.data?.timescale || 1;
  const big = tbl.entrySize === 20;
  let empty = 0;
  for (let i = 0; i < tbl.count; i++) {
    const p = tbl.rel + i * tbl.entrySize;
    const dur = big ? Number(tbl.dv.getBigUint64(p)) : tbl.dv.getUint32(p);
    const media = big ? Number(tbl.dv.getBigInt64(p + 8)) : tbl.dv.getInt32(p + 4);
    if (media === -1) {
      if (i === 0) empty = (dur / movieTs) * (t.timescale || 1);
      continue;
    }
    return { mediaTime: media, empty };
  }
  return { mediaTime: 0, empty };
}

/** Matroska CodecDelay in the track's ticks, as FFmpeg rounds it. */
function codecDelayTicks(t) {
  return t.codecDelay && t.seg?.timestampScale ? Math.round(t.codecDelay / t.seg.timestampScale) : 0;
}

/**
 * Seconds to add to a track's own timestamps to get the pts_time FFmpeg reports. MP4: negative
 * composition offsets are shifted away (FFmpeg keeps pts >= dts), then the edit list moves the
 * first edit's media_time to the start of the presentation. Matroska: the codec delay (Opus
 * pre-skip, AAC priming) is subtracted. The other containers report their timestamps as stored.
 */
function trackOffset(doc, t) {
  const s = t.samples;
  const ts = s?.timescale || t.timescale || 1;
  if (doc.format.id === 'isobmff') {
    let shift = 0;
    if (s?.cto) for (let i = 0; i < s.count; i++) if (-s.cto[i] > shift) shift = -s.cto[i];
    const e = editShift(doc, t);
    return (shift + (e ? e.empty - e.mediaTime : 0)) / ts;
  }
  if (doc.format.id === 'matroska') return -codecDelayTicks(t) / ts;
  return 0;
}

/** i -> presentation time of sample i of track t as FFmpeg reports it (pts_time), in seconds. */
function ptsOf(doc, t) {
  const s = t.samples;
  const ts = s.timescale || t.timescale || 1;
  const off = trackOffset(doc, t);
  return (i) => (s.dts[i] + (s.cto ? s.cto[i] : 0)) / ts + off;
}

/** Presentation time of sample i of track t as FFmpeg reports it (pts_time), in seconds. */
export function framePts(doc, t, i) {
  return ptsOf(doc, t)(i);
}

/** Earliest presentation time of a track in FFmpeg's timeline, in seconds (null without samples). */
function trackStart(doc, t) {
  const s = t.samples;
  if (!s?.count) return null;
  // Decode order puts the earliest picture within the first GOP; 512 frames is plenty.
  const pts = ptsOf(doc, t);
  const ts = s.timescale || t.timescale || 1;
  let min = Infinity;
  for (let i = 0; i < Math.min(s.count, 512); i++) min = Math.min(min, pts(i));
  // Audio that starts with samples to skip (encoder priming) starts where the skipping ends:
  // an MP4 edit list hides them, a Matroska CodecDelay counts them.
  if (doc.format.id === 'isobmff') {
    const e = editShift(doc, t);
    if (e) min = Math.max(min, e.empty / ts);
  }
  if (doc.format.id === 'matroska' && t.kind === 'audio') min += codecDelayTicks(t) / ts;
  return min;
}

/**
 * Where the timeline starts when a command reads only these tracks and seeks after -i. For MPEG-TS
 * (a format with timestamp discontinuities) ffmpeg moves the start to the first timestamp of the
 * streams it actually uses ("Correcting start time"); other formats start at the file's start.
 */
function outputStart(doc, tracks) {
  if (doc.format.id !== 'mpegts') return fileStart(doc);
  let min = Infinity;
  for (const t of tracks) {
    const v = t ? trackStart(doc, t) : null;
    if (v !== null && Number.isFinite(v)) min = Math.min(min, v);
  }
  return Number.isFinite(min) ? min : fileStart(doc);
}

/**
 * The file's start time as FFmpeg computes it (format start_time): the earliest audio or video
 * track, or a subtitle/data track when it starts less than a second before them. -ss counts from here.
 */
export function fileStart(doc) {
  let av = Infinity;
  let text = Infinity;
  for (const t of doc?.tracks ?? []) {
    const v = trackStart(doc, t);
    if (v === null || !Number.isFinite(v)) continue;
    if (t.kind === 'video' || t.kind === 'audio') av = Math.min(av, v);
    else text = Math.min(text, v);
  }
  if (av === Infinity || (av > text && av - text < 1)) av = text;
  return Number.isFinite(av) ? av : 0;
}

/** "00:04:07.120" for -ss (rounded down to the millisecond so the frame itself is not skipped). */
export function fmtClock(sec) {
  const ms = Math.max(0, Math.floor(sec * 1000 + 1e-6));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor(ms / 60000) % 60;
  const s = Math.floor(ms / 1000) % 60;
  const f = ms % 1000;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(f).padStart(3, '0')}`;
}

/** Frames per second of a video track: what the parser measured, its props, else its sample times. */
function frameRate(t) {
  if (Number.isFinite(t.fps) && t.fps > 0) return t.fps;
  const prop = (t.props ?? []).find(([k]) => /frame rate/i.test(k))?.[1];
  const m = prop && /^([\d.]+)\s*fps/i.exec(String(prop));
  if (m && Number(m[1]) > 0) return Number(m[1]);
  const s = t.samples;
  if (s?.count > 1) {
    const ts = s.timescale || t.timescale || 1;
    const span = (s.dts[s.count - 1] - s.dts[0]) / ts;
    if (span > 0) return (s.count - 1) / span;
  }
  return null;
}

// ------------------------------------------------------------------ context

/** "clip.final.mp4" -> { stem: 'clip.final', ext: '.mp4' } */
function splitName(name) {
  const m = /^(.+?)(\.[A-Za-z0-9]{1,5})?$/.exec(name);
  return { stem: m?.[1] ?? name, ext: m?.[2] ?? '' };
}

/** The track a selection is about: a frame's track, or the track whose box/element contains the node. */
function selectedTrack(doc, sel) {
  const d = sel?.detail;
  if (d?.track && typeof d.track === 'object' && doc.tracks.includes(d.track)) return d.track;
  for (let n = sel?.node; n && n.parent; n = n.parent) {
    // MPEG-TS "tracks" point at a group of packets that holds every PID: not a track selection.
    if (n.kind === 'group') break;
    const t = doc.tracks.find((x) => x.node === n);
    if (t) return t;
  }
  return null;
}

/** The selected frame: decode index, FFmpeg times, key frame and the key frame a copy cut would start at. */
function selectedFrame(doc, sel, start) {
  const d = sel?.detail;
  const t = d?.track;
  const s = t?.samples;
  const i = d?.sample;
  if (!s || !Number.isInteger(i) || i < 0 || i >= s.count || !doc.tracks.includes(t)) return null;
  const ptsAt = ptsOf(doc, t);
  const pts = ptsAt(i);
  // Position in display order (what ffplay's frame counter shows): frames presented earlier.
  // Zero-byte frames (dropped frames in AVI) never reach the decoder, so they do not count.
  let display = 0;
  for (let k = 0; k < s.count; k++) if (s.sizes[k] > 0 && ptsAt(k) < pts) display++;
  let kb = i;
  if (s.key) while (kb > 0 && !s.key[kb]) kb--;
  return {
    track: t,
    i,
    pts,
    rel: Math.max(0, pts - start),
    key: !s.key || !!s.key[i],
    display,
    keyBefore: { i: kb, rel: Math.max(0, ptsAt(kb) - start) },
  };
}

/**
 * Everything the commands fill in, from the open document, its file entry (the server's
 * { kind, name, dir } or a dropped file) and the selection. `encoder` picks x264 or x265 for
 * the encoding commands. Values that are not known become placeholders the reader replaces.
 */
export function buildContext({ doc = null, entry = null, sel = null, encoder = 'x264' } = {}) {
  const name = entry?.name ?? doc?.name ?? 'input.mp4';
  const path = filePath(entry, name);
  const { stem, ext } = splitName(name);
  const map = doc ? streamMap(doc) : [];
  const streams = (doc?.tracks ?? []).map((t, i) => (map[i] ? { ...map[i], track: t, label: t.label } : null));
  const first = (kind) => streams.find((s) => s && s.track.kind === kind) ?? null;
  const picked = doc ? selectedTrack(doc, sel) : null;
  const pickedStream = picked ? streams[doc.tracks.indexOf(picked)] : null;
  const stream = pickedStream ?? first('video') ?? streams.find(Boolean) ?? null;
  const start = doc ? fileStart(doc) : 0;
  const frame = doc ? selectedFrame(doc, sel, start) : null;
  const video = pickedStream?.type === 'v' ? pickedStream : first('video');
  const fps = video ? frameRate(video.track) : null;
  const c = {
    doc,
    format: doc?.format?.id ?? null,
    name,
    stem,
    ext,
    path,
    input: shellPath(path),
    streams,
    stream,
    streamFrom: pickedStream ? (frame ? 'frame' : 'selected') : stream ? 'default' : null,
    video,
    audio: pickedStream?.type === 'a' ? pickedStream : first('audio'),
    subtitle: pickedStream?.type === 's' ? pickedStream : first('subtitle'),
    frame,
    start,
    fps,
    gop: fps ? Math.round(fps * 2) : null,
    encoder: encoder === 'x265' ? 'x265' : 'x264',
  };
  c.time = frame ? fmtClock(frame.rel) : null;
  // The time for -ss after -i when the command reads only these tracks (differs from c.time in MPEG-TS).
  c.timeAfter = (tracks) => (frame ? fmtClock(Math.max(0, frame.pts - outputStart(doc, tracks.filter(Boolean)))) : null);
  return c;
}

/** Normalised codec of a track: h264, hevc, av1, vp9, aac, opus, pcm… (null when unknown). */
export function codecKey(t) {
  if (!t) return null;
  const f = t.sampleCfg?.family ?? t.family;
  const s = `${t.codec ?? ''} ${t.codecName ?? ''}`.toLowerCase();
  const byFamily = { avc: 'h264', hevc: 'hevc', av1: 'av1', vp9: 'vp9', vp8: 'vp8', mpeg4v: 'mpeg4', mpeg2v: 'mpeg2', aac: 'aac', latm: 'aac_latm', ac3: 'ac3', eac3: 'eac3', opus: 'opus', tx3g: 'mov_text' };
  if (f === 'mp3') return /layer ii\b|\bmp2\b/.test(s) ? 'mp2' : 'mp3';
  if (f === 'text') return /ssa|substation/.test(s) ? 'ass' : /webvtt/.test(s) ? 'webvtt' : 'srt';
  if (byFamily[f]) return byFamily[f];
  if (/mpeg-4 part 2|mpeg4\/iso\/asp|\bxvid|\bdivx/.test(s)) return 'mpeg4';
  if (/mpeg-2 video|mpeg2video/.test(s)) return 'mpeg2';
  if (/flac/.test(s)) return 'flac';
  if (/vorbis/.test(s)) return 'vorbis';
  if (/adpcm/.test(s)) return 'adpcm';
  if (/\bpcm\b|lpcm|sowt|twos|a_pcm/.test(s)) return 'pcm';
  if (/motion jpeg|mjpg|mjpeg/.test(s)) return 'mjpeg';
  if (/alac/.test(s)) return 'alac';
  if (/h\.263|sorenson/.test(s)) return 'h263';
  if (/\bdts\b/.test(s)) return 'dts';
  return null;
}

// Codecs FFmpeg's MP4 muxer accepts with -c copy.
const MP4_OK = new Set(['h264', 'hevc', 'av1', 'vp9', 'mpeg4', 'mpeg2', 'mjpeg', 'aac', 'mp3', 'mp2', 'ac3', 'eac3', 'opus', 'flac', 'alac']);

// ------------------------------------------------------------------ plain-language terms

/**
 * Terms the prose uses, explained on hover in the UI (the first time each appears in a block).
 * [pattern, explanation]; patterns match whole words, an optional plural s included.
 */
export const TERMS = [
  ['container', 'Container: the file format (MP4, Matroska, MPEG-TS…) that holds the streams, their timing and an index. The codec compresses each stream; the container packages them.'],
  ['codec', 'Codec: the method that compresses a stream: H.264, HEVC, AV1, VP9 for video; AAC, Opus, AC-3 for audio.'],
  ['demuxer', 'Demuxer: the part of FFmpeg that reads a container and splits it into the packets of each stream.'],
  ['muxer', 'Muxer: the part of FFmpeg that writes packets into a container.'],
  ['packet', 'Packet: one compressed frame (or a few audio frames) as stored in the file, with its timestamps and byte position. Vidscope calls it a sample or frame.'],
  ['stream specifier', 'Stream specifier: how FFmpeg names streams. v:0 is the first video stream, a:1 the second audio stream, s:0 the first subtitle stream; 0:v:0 adds the input number.'],
  ['stream', 'Stream: one sequence of video, audio, subtitles or data in a file. Vidscope calls it a track.'],
  ['PTS', 'PTS (presentation timestamp): when a frame is shown.'],
  ['DTS', 'DTS (decode timestamp): when a frame must be decoded. With B-frames it is earlier than the PTS for the frames the others depend on.'],
  ['GOP', 'GOP (group of pictures): a key frame and the frames that depend on it, up to the next key frame. Its length decides how precisely players can seek and where streaming segments can be cut.'],
  ['key frame', 'Key frame: a frame that decodes on its own (an IDR frame in H.264). Playback, seeking and stream copying can only start at one.'],
  ['I-frame', 'I-frame: intra-coded, compressed without reference to other pictures. The largest frames.'],
  ['P-frame', 'P-frame: predicted from earlier pictures; only the differences are coded.'],
  ['B-frame', 'B-frame: bi-directionally predicted, from an earlier and a later picture. The later one has to be decoded first, so frames are stored out of display order.'],
  ['CRF', 'CRF (constant rate factor): x264’s and x265’s quality target. The encoder keeps quality steady and the bitrate follows the content.'],
  ['VBV', 'VBV (video buffering verifier): a model of the decoder’s input buffer; -maxrate and -bufsize make the encoder respect it, which caps the bitrate.'],
  ['CBR', 'CBR (constant bitrate): the same number of bits every second, as broadcast and live links need.'],
  ['VBR', 'VBR (variable bitrate): more bits for complex scenes, fewer for simple ones.'],
  ['PSNR', 'PSNR (peak signal-to-noise ratio): how far the encoded pixels are from the original, in decibels. Higher is better.'],
  ['SSIM', 'SSIM (structural similarity): compares local patterns of brightness and contrast; 1 means identical.'],
  ['VMAF', 'VMAF (Video Multimethod Assessment Fusion): Netflix’s 0–100 quality score, trained on viewers’ opinions.'],
  ['LUFS', 'LUFS (loudness units relative to full scale): loudness as people hear it, measured per EBU R128 / ITU-R BS.1770. One LU is one decibel.'],
  ['HLS', 'HLS (HTTP Live Streaming): Apple’s streaming format; a playlist (.m3u8) lists short media segments that players download over HTTP.'],
  ['DASH', 'MPEG-DASH: the standard counterpart of HLS, with an XML manifest (.mpd).'],
  ['CMAF', 'CMAF (Common Media Application Format): fragmented MP4 segments that both HLS and DASH can use.'],
  ['PID', 'PID (packet identifier): the number in every 188-byte MPEG-TS packet header that says which stream or table the packet belongs to.'],
  ['PCR', 'PCR (program clock reference): the clock an MPEG-TS carries so a receiver can run at exactly the sender’s speed.'],
  ['PMT', 'PMT (program map table): lists the PIDs and stream types of one program in an MPEG-TS.'],
  ['SEI', 'SEI (supplemental enhancement information): side messages inside an H.264/HEVC stream, such as the encoder’s settings, HDR metadata or captions.'],
  ['NAL unit', 'NAL unit: the packets an H.264 or HEVC bitstream is made of (parameter sets, SEI, slices of pictures).'],
  ['Annex B', 'Annex B: the framing that puts a start code (00 00 01) before every NAL unit, used in MPEG-TS and raw .h264 files. MP4 and Matroska put a length before each unit instead.'],
  ['time base', 'Time base: the unit of a stream’s timestamps, such as 1/12800 s. Also called the timescale.'],
  ['edit list', 'Edit list: an MP4 table (elst) that maps the track’s media onto the timeline, used to hide encoder delay so that audio and video start together.'],
  ['filter graph', 'Filter graph: the chain of FFmpeg filters decoded frames pass through. Commas separate filters, semicolons separate chains, and [labels] connect them.'],
  ['remux', 'Remux: copy the compressed streams into a new container without re-encoding (-c copy). Lossless and fast.'],
  ['HDR', 'HDR (high dynamic range): video that can show much brighter highlights and more colour, with a PQ or HLG transfer function.'],
  ['SDR', 'SDR (standard dynamic range): ordinary video with the BT.709 transfer function.'],
  ['PQ', 'PQ (perceptual quantizer, SMPTE ST 2084): the HDR transfer function of HDR10 and Dolby Vision.'],
  ['HLG', 'HLG (hybrid log-gamma): the HDR transfer function made for broadcast.'],
  ['side data', 'Side data: extra records attached to a packet or a decoded frame, such as HDR metadata, motion vectors or the encoder’s SEI messages.'],
  ['fast start', 'Fast start: an MP4 with its index (moov) before the media (mdat), so playback can begin before the download finishes.'],
  ['bitrate', 'Bitrate: bits per second of compressed media. Average bitrate = size × 8 ÷ duration.'],
  ['timescale', 'Timescale: how many timestamp ticks make one second (12,800 for this MP4 video, 90,000 in MPEG-TS, 1,000 in Matroska and FLV).'],
];

// ------------------------------------------------------------------ building blocks

const TIP = {
  ffprobe: 'ffprobe: FFmpeg’s inspection tool. It opens the file with the same code FFmpeg uses to play and convert it, and prints what it finds. It never changes the file.',
  ffplay: 'ffplay: FFmpeg’s minimal player, a window without buttons. Keys: space pause, ← → seek 10 s, ↑ ↓ seek 1 min, s step one frame, f full screen, w cycle picture / audio waveform / spectrum, q quit.',
  ffmpeg: 'ffmpeg: reads one or more inputs, can decode, filter and re-encode them, and writes a new file. The input is never changed.',
  v: '-v sets the log level: how much the tool reports about its own work.',
  error: 'error: print only errors. Without it you also get the version banner and a summary of the file, mixed into the report.',
  hideBanner: '-hide_banner: skip the banner (FFmpeg’s version and build options) printed before anything else.',
  i: '-i: the next word is an input. Options before -i apply to reading that input; options after the last input apply to the output that follows them.',
  of: '-of: how the report is written (short for -output_format).',
  json: 'json: nested and easy to process in scripts (jq, Python, JavaScript). Other writers: default ([SECTION] and key=value lines), compact, csv, flat, ini, xml.',
  compact: 'compact: one line per item, key=value pairs separated by |.',
  csv: 'csv=p=0: comma-separated values, without the section name at the start of each line (p=0 turns print_section off).',
  selectStreams: '-select_streams: report only on the stream that matches the stream specifier after it.',
  showEntries: '-show_entries: print only the listed fields, written section=field,field. Asking for a section (packet, frame, stream…) is also what makes ffprobe read it.',
  pipe: '|: a pipe. The output of the command on the left becomes the input of the command on the right instead of going to the screen.',
  and: '&&: run the next command only if this one succeeded.',
  c: '-c: which codec to use. copy means no codec at all: the compressed data is copied as it is.',
  copy: 'copy: stream copy. Packets are copied without decoding or encoding: no quality loss, as fast as the disk. Only the container around them changes.',
  f: '-f: force the format (the muxer or demuxer) instead of guessing it from the file name.',
  null: 'null: a muxer that writes nothing. Everything is still decoded and filtered, so this is how to run filters that only measure.',
  dash: '-: the output “file” name; with the null muxer nothing is written anywhere.',
  vf: '-vf: a video filter graph, applied to every decoded frame before it is shown or encoded (short for -filter:v).',
  af: '-af: an audio filter graph (short for -filter:a).',
  map: '-map: choose which input stream goes into the output. Without -map, ffmpeg picks one video, one audio and one subtitle stream by itself.',
  cv: '-c:v: the codec (encoder) for the video streams (:v is a stream specifier: all video streams).',
  ca: '-c:a: the encoder for the audio streams.',
  aac: 'aac: FFmpeg’s built-in AAC encoder, the usual audio codec for MP4, HLS and DASH.',
  ba: '-b:a: audio bitrate.',
  ba128: '128k: 128 kbit/s, plenty for stereo AAC.',
  x264: 'libx264: x264, the H.264 encoder behind most online video (needs an FFmpeg built with --enable-libx264).',
  x265: 'libx265: x265, an HEVC (H.265) encoder; about the same quality as H.264 at a lower bitrate, but slower (needs --enable-libx265).',
  preset: '-preset: the encoder’s speed/efficiency trade-off, from ultrafast to veryslow. Slower presets try more ways to code each frame: the same quality in fewer bits.',
  hvc1: 'hvc1: label the HEVC track hvc1 instead of FFmpeg’s default hev1. Apple’s players only accept hvc1 (parameter sets kept in the hvcC box, not repeated in the frames).',
  tagv: '-tag:v: the four-character code written for the video track in the container (the sample entry in MP4).',
  lavfi: 'lavfi: libavfilter’s virtual input: the “file” is a filter graph, and its outputs become the streams.',
  movie: 'movie=: a source filter that opens a file inside the filter graph and outputs its video (amovie: its audio). The path is escaped for the filter graph.',
};

/** One flag followed by its value, as two tokens with their own tips. */
function flag(name, tip, value, valueTip, extra = {}) {
  return [tk(name, tip, extra), tk(value, valueTip, extra)];
}

/** The input file token. */
function input(c, extra = {}) {
  const parts = [];
  if (c.path.known) parts.push(`The open file, ${c.name}, with the folder the Vidscope server read it from.`);
  else parts.push(`The open file, ${c.name}. Vidscope only knows its name (it was opened from this computer, not through the Vidscope server), so run the command in the folder that holds it, or type the full path instead.`);
  if (c.input.startsWith('~/')) parts.push('~ is your home folder; it stays outside the quotes so that the shell expands it.');
  if (c.input.includes("'")) parts.push('The single quotes keep the name one word for the shell, whatever spaces or special characters it contains.');
  if (c.input.startsWith('./') || c.input.startsWith("'./")) parts.push('./ in front stops FFmpeg from reading a name that starts with - as an option, or one with a colon as a protocol (like http:).');
  return tk(c.input, parts.join(' '), { role: 'input', ctx: true, ...extra });
}

/** -i and the input file. */
function dashI(c) {
  return [tk('-i', TIP.i), input(c)];
}

/** A file name in the current folder as FFmpeg needs it: ./ in front of names that would read as an option (-x) or a protocol (a:b). */
function local(name) {
  return /^-|:/.test(name) ? `./${name}` : name;
}

/** An output file in the current folder. */
function out(name, tip, extra = {}) {
  return tk(shq(local(name)), `${tip} It is written to the folder you run the command in.`, { role: 'output', ...extra });
}

/** Why a stream specifier was filled in with this stream. */
function specWhy(c, s) {
  if (s && c.stream === s && c.streamFrom === 'frame') return 'the track of the frame you selected';
  if (s && c.stream === s && c.streamFrom === 'selected') return 'the track you selected';
  return `the first ${TYPE_NAME[s.type]} track; select another in the Tracks tab to change it`;
}

const SPEC_BASE = 'A stream specifier: a letter for the type (v video, a audio, s subtitles, d data) and the stream’s number among those of that type, counted from 0.';

/** A stream specifier token ("v:0"), optionally prefixed with the input number ("0:v:0" for -map). */
function spec(c, s, { input: inputNo = null, kind = 'v' } = {}) {
  const pre = inputNo === null ? '' : `${inputNo}:`;
  if (!s) {
    return tk(`${pre}${kind}:0`, `${SPEC_BASE} This file has no ${TYPE_NAME[kind]} track that FFmpeg can see, so this command does not apply to it.`, { ph: true });
  }
  const inTip = inputNo === null ? '' : `${inputNo}: is the input (the first -i is 0), then `;
  const pid = c.format === 'mpegts' && Number.isInteger(s.track.pid) ? ` In an MPEG-TS a stream can also be named by its PID: #0x${s.track.pid.toString(16)}.` : '';
  return tk(`${pre}${s.spec}`, `${inTip}${SPEC_BASE} ${s.spec} is ${s.label} (${specWhy(c, s)}); FFmpeg counts it as stream ${s.index} of the file.${pid}`, { ctx: true });
}

/**
 * The selected frame's time, or a placeholder. With `after` (the tracks a command reads, for -ss
 * after -i), MPEG-TS times count from the start of those tracks, as ffmpeg does there.
 */
function timeTok(c, { after = null } = {}) {
  const f = c.frame;
  if (f) {
    const what = `frame ${f.i + 1} of ${f.track.label} in decoding order${f.key ? ', a key frame' : ''}`;
    const text = after ? c.timeAfter(after) : c.time;
    const from = after && c.format === 'mpegts'
      ? 'counted from the first timestamp of the streams this command reads, where ffmpeg starts an MPEG-TS timeline'
      : 'counted from the start of the file';
    const avi = c.format === 'riff' && ['h264', 'hevc', 'mpeg4'].includes(codecKey(f.track))
      ? ' AVI stores no presentation times, so with B-frames FFmpeg may pick a neighbouring frame.'
      : '';
    return tk(text, `The selected frame’s presentation time (${what}), ${from}. Written hours:minutes:seconds.milliseconds; plain seconds work too.${avi}`, { ctx: true, role: 'time' });
  }
  return tk('TIME', 'Placeholder for a time. Select a frame (a row of the frame list in the Tracks tab, or a byte inside a frame in the hex view) and its time is filled in; or type one yourself: 00:01:23.456 or 83.456 (seconds).', { ph: true, role: 'time' });
}

// -ss before -i when the container has an index; after -i for MPEG-TS, where seeking in the input is unreliable.
const SS_BEFORE = '-ss before -i seeks in the input: FFmpeg jumps through the index to the key frame at or before the time, decodes from there and discards frames until the time. Fast even in a long file, and exact to the frame.';
const SS_AFTER_TS = '-ss after -i: ffmpeg decodes from the start of the file and discards frames until the time. Slower than seeking before -i, but exact in an MPEG-TS: it has no index, and seeking in the input searches its timestamps and can land on the key frame after the time.';

/** Exact seek tokens: { before, after } to place around -i (MPEG-TS seeks after -i). */
function exactSeek(c, tracks) {
  const ts = c.format === 'mpegts';
  const tokens = [tk('-ss', ts ? SS_AFTER_TS : SS_BEFORE), timeTok(c, ts ? { after: tracks } : {})];
  return ts ? { before: [], after: tokens } : { before: tokens, after: [] };
}

/** Frames in two seconds (for -g), or a placeholder. */
function gopTok(c) {
  if (c.gop) return tk(String(c.gop), `${c.gop} frames: 2 seconds at ${Number(c.fps.toFixed(3))} fps, the frame rate of ${c.video.label}.`, { ctx: true });
  return tk('GOP', 'Placeholder: the number of frames in 2 seconds (48 at 24 fps, 50 at 25, 60 at 30). Vidscope did not find the frame rate.', { ph: true });
}

/** -map for every video and audio stream the file has (subtitles and data left out). */
function avMaps(c, { first = false } = {}) {
  const out2 = [];
  const has = (type) => c.streams.some((s) => s && s.type === type);
  const which = first ? 'the first' : 'every';
  if (has('v')) out2.push(tk('-map', TIP.map), tk(first ? '0:v:0' : '0:v', `${first ? '0:v:0' : '0:v'}: ${which} video stream of input 0 (inputs are counted from 0).`));
  if (has('a')) out2.push(tk('-map', TIP.map), tk(first ? '0:a:0' : '0:a', `${first ? '0:a:0' : '0:a'}: ${which} audio stream. Subtitles, data and attachments are left out: their formats often do not fit the new container.`));
  return out2;
}

/** The encoder tokens for the chosen encoder: -c:v libx264 / libx265. */
function encoder(c) {
  return c.encoder === 'x265' ? flag('-c:v', TIP.cv, 'libx265', TIP.x265) : flag('-c:v', TIP.cv, 'libx264', TIP.x264);
}

/** -tag:v hvc1 for HEVC in MP4. */
function hvc1(c) {
  return c.encoder === 'x265' ? flag('-tag:v', TIP.tagv, 'hvc1', TIP.hvc1) : [];
}

/** AAC audio at 128 kbit/s (nothing when the file has no audio, or before a file is open). */
function aacAudio(c) {
  if (c.doc && !c.streams.some((s) => s?.type === 'a')) return [];
  return [...flag('-c:a', TIP.ca, 'aac', TIP.aac), ...flag('-b:a', TIP.ba, '128k', TIP.ba128)];
}

/** The CRF value tokens for the chosen encoder. */
function crf(c, x264 = 23, x265 = 28) {
  const v = c.encoder === 'x265' ? x265 : x264;
  const scale = c.encoder === 'x265'
    ? `${v}: x265’s default. x265 needs a higher number than x264 for the same look: 28 in x265 is about 23 in x264, in a smaller file.`
    : `${v}: ${v === 23 ? 'x264’s default' : v < 23 ? 'higher quality than the default 23' : 'lower quality than the default 23'}. 18 looks visually lossless; every +6 roughly halves the bitrate.`;
  return flag('-crf', 'Constant Rate Factor: aim for a constant quality and let the bitrate follow the content. The scale runs from 0 (lossless) to 51; lower is better and bigger.', String(v), scale);
}

/** Output file name for an encode: STEM-suffix.mp4, with -x265 for HEVC. */
function encName(c, suffix, ext = '.mp4') {
  return `${c.stem}${c.encoder === 'x265' ? '-x265' : ''}-${suffix}${ext}`;
}

/** The file the quality-based encode writes (reused by the comparison commands). */
function crfName(c) {
  return encName(c, c.encoder === 'x265' ? 'crf28' : 'crf23');
}

/** "0.000" seconds */
function sec(v) {
  return `${v.toFixed(3)} s`;
}

/** An MP4 if every video/audio stream fits MP4, else Matroska (MP4-family sources go to Matroska). */
function remuxExt(c) {
  const av = c.streams.filter((s) => s && (s.type === 'v' || s.type === 'a'));
  const video = av.some((s) => s.type === 'v');
  const fits = av.length && av.every((s) => MP4_OK.has(codecKey(s.track)));
  if (c.format !== 'isobmff' && fits) return video ? '.mp4' : '.m4a';
  return video ? '.mkv' : '.mka';
}

/** Extension of an audio-only file that holds this codec as it is. */
function audioExt(t) {
  return { aac: '.m4a', alac: '.m4a', mp3: '.mp3', mp2: '.mp2', ac3: '.ac3', eac3: '.eac3', opus: '.opus', vorbis: '.ogg', flac: '.flac', pcm: '.wav', dts: '.dts' }[codecKey(t)] ?? '.mka';
}

/** MPEG-TS carries AAC with an ADTS header on every frame; MP4-based outputs need it converted. */
function adtsBsf(c) {
  if (c.format !== 'mpegts' || codecKey(c.streams.find((s) => s?.spec === 'a:0')?.track) !== 'aac') return [];
  return flag('-bsf:a', '-bsf:a: a bitstream filter for the audio, which rewrites packets without decoding them.', 'aac_adtstoasc', 'aac_adtstoasc: remove the ADTS header MPEG-TS puts before every AAC frame and move its settings into the AudioSpecificConfig that MP4 keeps once, in the esds box. The HLS and DASH muxers do not add it by themselves.');
}

/** Not applicable without a video track. */
function needVideo(c) {
  return c.video ? null : 'This file has no video track, so this command does not apply to it.';
}

/** Not applicable without an audio track. */
function needAudio(c) {
  return c.audio ? null : 'This file has no audio track, so this command does not apply to it.';
}

/** A comma-separated field list (packet=pts_time,dts_time…) as one word with a tip per field. */
function fields(section, sectionTip, list) {
  return word([{ t: `${section}=`, tip: sectionTip }, ...list.map(([name, tip], i) => ({ t: `${i ? ',' : ''}${name}`, tip }))]);
}

// ------------------------------------------------------------------ the catalogue

export const GROUPS = [
  {
    id: 'inspect',
    tool: 'ffprobe',
    title: 'Inspect with ffprobe',
    intro: 'ffprobe reads the file the way FFmpeg’s players and converters do, and reports what it finds: the container, each stream, every packet and, if you ask, every decoded frame. It never changes the file.',
  },
  {
    id: 'watch',
    tool: 'ffplay',
    title: 'Watch with ffplay',
    intro: 'ffplay is FFmpeg’s bare-bones player. It has no buttons (space pauses, the arrows seek, s steps one frame, q quits), but any FFmpeg filter can sit between the decoder and the screen to show what the codec did.',
  },
  {
    id: 'fix',
    tool: 'ffmpeg',
    title: 'Fix and convert with ffmpeg',
    intro: 'ffmpeg always writes a new file. With -c copy it only rewrites the container (a remux: fast and lossless); with an encoder such as libx264 it decodes and compresses again, which takes time and loses a little quality each time.',
  },
  {
    id: 'measure',
    tool: 'ffmpeg',
    title: 'Measure with ffmpeg filters',
    intro: 'Filters that measure instead of change. They run over the decoded frames and print numbers; -f null - decodes everything but writes no file.',
  },
];

// Per-container meaning of ffprobe's pos (tested against Vidscope's own offsets).
const POS_NOTE = {
  isobmff: 'In an MP4, pos is exactly the offset in Vidscope’s frame list.',
  matroska: 'In Matroska, pos is where the Block’s data starts (its track number), a few bytes before the frame bytes Vidscope highlights.',
  mpegts: 'In MPEG-TS, pos is the 188-byte packet where the frame’s PES packet starts; frames that share a PES packet show N/A.',
  flv: 'In FLV, pos is the start of the tag (its 11-byte header), before the frame data.',
  riff: 'In AVI and WAV, pos is the offset in Vidscope’s frame list. FFmpeg skips zero-byte chunks (dropped frames), which Vidscope still lists.',
};

export const COMMANDS = [
  // ================================================================ inspect
  {
    id: 'probe-summary',
    group: 'inspect',
    tool: 'ffprobe',
    title: 'Quick summary',
    essential: true,
    purpose: 'The overview FFmpeg prints before any job: the container, duration, overall bitrate, and one line per stream.',
    cmd: (c) => [tk('ffprobe', TIP.ffprobe), tk('-hide_banner', TIP.hideBanner), input(c)],
    when: 'The first thing to run on any file: in a second you know what is inside and whether FFmpeg can read it at all.',
    look: () => [
      'Input #0 names the demuxer that opened the file: mov,mp4,m4a,3gp,3g2,mj2 is one reader for the whole MP4 family, matroska,webm another, mpegts a third. Vidscope identifies the container from the same first bytes.',
      'start is the first timestamp, in seconds. MP4 and Matroska usually start at 0; MPEG-TS files often start at 1.4 s or later, because a broadcast clock never starts at zero.',
      'Stream #0:0[0x1] is input 0, stream 0; the number in brackets is the MP4 track ID, or the PID in an MPEG-TS. FFmpeg’s stream specifiers count these streams per type: the first video stream is v:0.',
      'h264 (High) (avc1 / 0x31637661): codec, profile, and the four-character code stored in the file, which is the avc1 sample entry Vidscope shows inside stsd.',
      '12800 tbn is the time base: 12,800 timestamp ticks per second, the timescale Vidscope shows in the mdhd box.',
    ],
    output: {
      title: 'Example output (a 4-second 640×360 H.264/AAC MP4, metadata shortened)',
      lines: [
        "Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'h264-aac.mp4':",
        '  Metadata:',
        '    major_brand     : isom',
        '    encoder         : Lavf62.12.101',
        '  Duration: 00:00:04.00, start: 0.000000, bitrate: 804 kb/s',
        '  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(progressive), 640x360 [SAR 1:1 DAR 16:9], 698 kb/s, 25 fps, 25 tbr, 12800 tbn (default)',
        '  Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 48000 Hz, mono, fltp, 96 kb/s (default)',
      ],
      marks: [
        ['Input #0', 'The first input file (FFmpeg counts from 0).'],
        ['mov,mp4,m4a,3gp,3g2,mj2', 'The demuxer that read the file. One demuxer handles the whole ISO base media family (MP4, MOV, M4A, 3GP).'],
        ['major_brand     : isom', 'From the ftyp box, the first box of the file: the specification the file says it follows.'],
        ['encoder         : Lavf62.12.101', 'Who wrote the container: Lavf is libavformat, FFmpeg’s container library.'],
        ['Duration: 00:00:04.00', 'Duration of the longest stream.'],
        ['start: 0.000000', 'First presentation time in seconds. Seeking with -ss counts from here.'],
        ['bitrate: 804 kb/s', 'Average over the whole file: size × 8 ÷ duration, container overhead included.'],
        ['Stream #0:0', 'Input 0, stream 0. As a type-relative stream specifier this is v:0.'],
        ['[0x1]', 'The track ID from the tkhd box (in an MPEG-TS: the PID).'],
        ['(und)', 'Language: und means undetermined.'],
        ['h264 (High)', 'Codec and profile.'],
        ['(avc1 / 0x31637661)', 'The four-character code of the stsd sample entry, and the same four bytes as a hexadecimal number.'],
        ['yuv420p(progressive)', 'Pixel format: Y′CbCr with 4:2:0 chroma subsampling, 8 bits; progressive (not interlaced).'],
        ['640x360', 'Width × height in pixels.'],
        ['[SAR 1:1 DAR 16:9]', 'Sample (pixel) aspect ratio and display aspect ratio: square pixels, 16:9 picture.'],
        ['698 kb/s', 'This stream’s average bitrate.'],
        ['25 fps', 'Average frame rate.'],
        ['25 tbr', 'The frame rate FFmpeg guesses from the timestamps.'],
        ['12800 tbn', 'Time base of the stream: 12,800 ticks per second (the mdhd timescale).'],
        ['(default)', 'Disposition: the default track of its kind, the one players pick first.'],
        ['aac (LC)', 'AAC, Low Complexity profile.'],
        ['48000 Hz, mono, fltp', 'Sample rate, channel layout, and the decoder’s sample format (32-bit float, planar).'],
      ],
    },
    view: { to: 'tracks', track: 'stream', label: 'Tracks tab: the same streams' },
    tags: 'info overview mediainfo',
  },
  {
    id: 'probe-json',
    group: 'inspect',
    tool: 'ffprobe',
    title: 'Streams and container as JSON',
    purpose: 'Every property FFmpeg knows about the container and each stream, in a form scripts can read.',
    cmd: (c) => [
      tk('ffprobe', TIP.ffprobe),
      ...flag('-v', TIP.v, 'error', TIP.error),
      tk('-show_format', '-show_format: print the FORMAT section, the container as a whole: format_name, start_time, duration, size, bit_rate and the file’s tags (title, encoder…).'),
      tk('-show_streams', '-show_streams: print one STREAM section per stream: codec, profile, level, size, pixel format, frame rate, time base, bitrate, colour, language, disposition…'),
      ...flag('-of', TIP.of, 'json', TIP.json),
      input(c),
    ],
    when: 'When you need one exact value (the level, the time base, the colour primaries) or want a script to decide what to do with a file.',
    look: () => [
      'codec_name, profile and level: "level": 30 means level 3.0. mime_codec_string (avc1.64001e) is the RFC 6381 codec string Vidscope shows in the Tracks tab, where the hex digits are upper case.',
      'r_frame_rate and avg_frame_rate are equal for a constant frame rate; different values hint at variable frame rate (typical of phone recordings).',
      'time_base (1/12800) is the unit of the timestamps: start_pts and duration_ts count in it, start_time and duration are the same in seconds.',
      'nb_frames comes from the container’s own index (the MP4 stsz box). Matroska and MPEG-TS have no frame count, so it is missing there: [[probe-count]] counts them.',
      'has_b_frames above 0 means frames are reordered: the decode order differs from the display order.',
      'tags hold the language, handler_name, encoder and creation_time; disposition says default, forced, attached_pic (cover art)…',
    ],
    view: { to: 'tracks', track: 'stream', label: 'Tracks tab: codec strings and properties' },
    tags: 'metadata properties script',
  },
  {
    id: 'probe-packets',
    group: 'inspect',
    tool: 'ffprobe',
    title: 'Packets: the frame table',
    essential: true,
    purpose: 'One line per packet (a compressed frame as stored in the file) with its timestamps, size, byte position and key-frame flag: the same table as Vidscope’s frame list.',
    cmd: (c) => [
      tk('ffprobe', TIP.ffprobe),
      ...flag('-v', TIP.v, 'error', TIP.error),
      tk('-select_streams', TIP.selectStreams),
      spec(c, c.stream),
      tk('-show_entries', TIP.showEntries),
      ...fields('packet', 'packet: the PACKET section, one per compressed frame, in the order they are stored in the file (decoding order).', [
        ['pts_time', 'pts_time: presentation timestamp (PTS) in seconds, when the frame is shown.'],
        ['dts_time', 'dts_time: decode timestamp (DTS), when the frame must be decoded. It rises steadily while the PTS jumps around if there are B-frames.'],
        ['duration_time', 'duration_time: how long the frame is shown.'],
        ['size', 'size: bytes of compressed data, Vidscope’s size column.'],
        ['pos', 'pos: byte offset of the packet in the file.'],
        ['flags', 'flags: K = key frame, D = discard (stored but not meant to be shown, e.g. before the start of an edit list), C = corrupt.'],
      ]),
      ...flag('-of', TIP.of, 'compact', TIP.compact),
      input(c),
    ],
    when: 'To see exactly how a stream is stored: frame sizes, GOP structure, reordering, gaps in the timestamps.',
    look: (c) => [
      `pos is a byte offset: type it into Vidscope’s go-to box (press g) to land on the packet’s first byte. ${POS_NOTE[c.format] ?? ''}`,
      'size matches the size column of Vidscope’s frame list, frame for frame.',
      'Packets are listed in decoding order. With B-frames, pts_time jumps back and forth while dts_time rises steadily: that is the reordering Vidscope shows as separate decode and display columns.',
      'flags=K__ marks key frames (● in Vidscope). The distance between two of them is the GOP length.',
      c.format === 'isobmff' ? 'The first dts_time can be negative (−0.080 s with two B-frames): the edit list shifts decoding earlier so that the first frame is shown at exactly 0.' : null,
    ],
    output: {
      title: 'Example output (first five packets of an H.264 MP4 with B-frames)',
      lines: [
        'packet|pts_time=0.000000|dts_time=-0.080000|duration_time=0.040000|size=8322|pos=48|flags=K__',
        'packet|pts_time=0.120000|dts_time=-0.040000|duration_time=0.040000|size=4356|pos=8370|flags=___',
        'packet|pts_time=0.040000|dts_time=0.000000|duration_time=0.040000|size=2633|pos=13020|flags=___',
        'packet|pts_time=0.080000|dts_time=0.040000|duration_time=0.040000|size=2443|pos=16211|flags=___',
        'packet|pts_time=0.240000|dts_time=0.080000|duration_time=0.040000|size=4140|pos=19155|flags=___',
      ],
      marks: [
        ['pts_time=0.000000', 'The key frame is shown first, at 0.'],
        ['dts_time=-0.080000', 'Decoded 80 ms (two frames) before it is shown: the edit list moves decoding earlier to make room for the B-frames.'],
        ['size=8322', 'The key frame is the largest packet.'],
        ['pos=48', 'Byte 48: right after the ftyp and free boxes and the 8-byte mdat header. Go to 48 in Vidscope to see these bytes.'],
        ['flags=K__', 'K: a key frame.'],
        ['pts_time=0.120000', 'The second packet is shown fourth: a P-frame stored before the two B-frames that are displayed ahead of it.'],
      ],
    },
    view: { to: 'tracks', track: 'stream', label: 'Tracks tab: Vidscope’s frame list' },
    tags: 'packets timestamps pts dts offset frame list',
  },
  {
    id: 'probe-frames',
    group: 'inspect',
    tool: 'ffprobe',
    title: 'Frames: picture types and key frames',
    purpose: 'Decode the video and list every frame in display order, with its picture type (I, P or B) and whether it is a key frame.',
    applies: needVideo,
    cmd: (c) => [
      tk('ffprobe', TIP.ffprobe),
      ...flag('-v', TIP.v, 'error', TIP.error),
      tk('-select_streams', TIP.selectStreams),
      spec(c, c.video),
      tk('-show_entries', TIP.showEntries),
      ...fields('frame', 'frame: the FRAME section, one per decoded picture, in display order. The video has to be decoded, so this is slower than listing packets.', [
        ['pts_time', 'pts_time: when the frame is shown, in seconds.'],
        ['pict_type', 'pict_type: I (intra: uses no other picture), P (predicted from earlier pictures) or B (from earlier and later pictures), as the decoder found it in the slices.'],
        ['key_frame', 'key_frame: 1 for a frame decoding can start from (an IDR frame in H.264).'],
        ['pkt_pos', 'pkt_pos: byte offset of the packet this frame was decoded from: the link back to the packet list and to Vidscope’s frame list.'],
        ['pkt_size', 'pkt_size: size of that packet in bytes.'],
      ]),
      ...flag('-of', TIP.of, 'compact', TIP.compact),
      input(c),
    ],
    when: 'To see the frame types behind the GOP structure, or to find which stored packet became which picture.',
    look: () => [
      'Frames come out in display order, sorted by pts_time; pkt_pos says which packet each came from, so B-frames point back to packets stored after the P-frame they depend on.',
      'An I-frame is not always a key frame: in an open GOP, frames that follow a non-IDR I-frame can still refer to pictures before it, so FFmpeg does not mark it as a place where decoding can start cleanly.',
      'In Vidscope, go to a frame’s pkt_pos and look at its slice header: slice_type gives the same I, P or B.',
    ],
    view: { to: 'frame', track: 'video', label: 'Show the frame’s bytes and NAL units' },
    tags: 'pict_type i p b frame types decode',
  },
  {
    id: 'probe-keyframes',
    group: 'inspect',
    tool: 'ffprobe',
    title: 'Key frames only',
    purpose: 'List only the key frames and their times, fast, by telling the decoder to skip every other frame.',
    applies: needVideo,
    cmd: (c) => [
      tk('ffprobe', TIP.ffprobe),
      ...flag('-v', TIP.v, 'error', TIP.error),
      tk('-select_streams', TIP.selectStreams),
      spec(c, c.video),
      ...flag('-skip_frame', '-skip_frame: a decoder option saying which frames not to decode.', 'nokey', 'nokey: skip every frame that is not a key frame, so only key frames are decoded. Fast even on a feature film.'),
      tk('-show_entries', TIP.showEntries),
      ...fields('frame', 'frame: one line per decoded frame, which here means one per key frame.', [
        ['pts_time', 'pts_time: when the key frame is shown, in seconds.'],
        ['pict_type', 'pict_type: normally I.'],
      ]),
      ...flag('-of', TIP.of, 'csv=p=0', TIP.csv),
      input(c),
    ],
    when: 'To check the GOP length before packaging for streaming, or to find where a cut without re-encoding can start.',
    look: (c) => [
      `The gap between two times is the GOP length${c.gop ? `: 2.000 s would be ${c.gop} frames at ${Number(c.fps.toFixed(3))} fps` : ''}. HLS and DASH segments must start on key frames, so a fixed GOP that divides the segment length is what packagers want.`,
      'Uneven gaps mean the encoder added key frames at scene cuts, or used a variable GOP.',
      'Vidscope shows the same key frames as orange bars in the Tracks tab’s frame-size chart, and the interval in File insights.',
      'A trailing comma after I appears when the frame carries side data (here the encoder’s SEI); it is harmless.',
    ],
    view: { to: 'tracks', track: 'video', label: 'Tracks tab: key frames in the chart' },
    tags: 'keyframes idr gop interval seek',
  },
  {
    id: 'probe-count',
    group: 'inspect',
    tool: 'ffprobe',
    title: 'Count frames and packets',
    purpose: 'Compare the number of frames the container claims with the packets actually stored and the frames that actually decode.',
    cmd: (c) => [
      tk('ffprobe', TIP.ffprobe),
      ...flag('-v', TIP.v, 'error', TIP.error),
      tk('-select_streams', TIP.selectStreams),
      spec(c, c.stream),
      tk('-count_packets', '-count_packets: read every packet of the stream and count them (fast: nothing is decoded).'),
      tk('-count_frames', '-count_frames: decode every frame and count them (takes a while on long files).'),
      tk('-show_entries', TIP.showEntries),
      ...fields('stream', 'stream: fields of the STREAM section.', [
        ['nb_frames', 'nb_frames: the count the container states (from the MP4 stsz box); N/A where the format has none, as in Matroska and MPEG-TS.'],
        ['nb_read_packets', 'nb_read_packets: packets actually read (needs -count_packets).'],
        ['nb_read_frames', 'nb_read_frames: frames actually decoded (needs -count_frames).'],
      ]),
      ...flag('-of', TIP.of, 'default=noprint_wrappers=1', 'default=noprint_wrappers=1: the default key=value writer, without the [STREAM] and [/STREAM] lines around the values.'),
      input(c),
    ],
    when: 'When a file seems too short, stutters, or a tool reports a different length than another.',
    look: () => [
      'All three equal: the index tells the truth and every packet decodes to one frame.',
      'nb_read_packets lower than nb_frames: the file is cut short, like an interrupted download or recording.',
      'nb_read_frames lower than nb_read_packets: some packets did not decode, or the decoder dropped frames it could not use (for example before the first key frame).',
      'Vidscope counts the same packets: the Tracks tab lists one row per packet.',
    ],
    view: { to: 'tracks', track: 'stream', label: 'Tracks tab: the frame count' },
    tags: 'count nb_frames truncated',
  },
  {
    id: 'probe-gop',
    group: 'inspect',
    tool: 'ffprobe',
    title: 'The GOP pattern in one line',
    purpose: 'Print the frame types of the first 30 seconds as one line of letters (IBBPBBP…), with a space before each I-frame so that every GOP starts a new group.',
    applies: needVideo,
    cmd: (c) => [
      tk('ffprobe', TIP.ffprobe),
      ...flag('-v', TIP.v, 'error', TIP.error),
      tk('-select_streams', TIP.selectStreams),
      spec(c, c.video),
      ...flag('-read_intervals', '-read_intervals: read only part of the file.', '%+30', '%+30: nothing before the % means from the start; +30 after it means for 30 seconds.'),
      tk('-show_entries', TIP.showEntries),
      ...fields('frame', 'frame: one line per decoded frame, in display order.', [['pict_type', 'pict_type: I, P or B.']]),
      ...flag('-of', TIP.of, 'csv=p=0', TIP.csv),
      input(c),
      tk('|', TIP.pipe),
      tk('awk', 'awk: a small text-processing language found on every Unix-like system.'),
      tk('-F,', '-F,: split each line at commas (ffprobe adds a trailing comma when a frame carries side data).'),
      tk(`'{ if ($1 == "I" && NR > 1) printf " "; printf "%s", $1 } END { print "" }'`, 'The awk program: for each line (one frame) print its letter ($1) without a newline, with a space first if it is an I-frame and not the very first line (NR is the line number). END prints the final newline.'),
    ],
    when: 'To see at a glance how an encoder structured the video: GOP length, how many B-frames, whether it adapts them to the content.',
    look: () => [
      'Each group starting with I is one GOP. IBBPBBP… means two B-frames between the reference frames (-bf 2 in FFmpeg, bframes=2 in x264’s settings).',
      'Stretches with fewer B-frames (BPBP or PP) are x264 adapting to hard-to-predict motion (b-adapt).',
      'No B at all: a low-latency or Baseline-profile encode, where frames are stored in display order.',
      'The letters are in display order; the packets are stored in decoding order, where each P comes before the B-frames shown ahead of it.',
    ],
    output: {
      title: 'Example output (4 s at 25 fps, key frame every 2 s)',
      lines: ['IBBPBBPBBPBBPBPBBPBBPBBPBBPBBPBPBPBPBPBPBPBPBPBBPP IBBPBBPBBPBPBBPBBPBBPBBPBPBBPBBPBBPBPBBPBPBBPBBPBP'],
      marks: [
        ['IBBPBBPBBPBBPBPBBPBBPBBPBBPBBPBPBPBPBPBPBPBPBPBBPP', 'The first GOP: 50 frames, 2 seconds.'],
      ],
    },
    view: { to: 'tracks', track: 'video', label: 'Tracks tab: frame sizes by type' },
    tags: 'gop structure ibbp pattern',
  },
  {
    id: 'probe-frametypes',
    group: 'inspect',
    tool: 'ffprobe',
    title: 'How many I, P and B-frames',
    purpose: 'Count the frames of each picture type with two standard Unix tools, sort and uniq.',
    applies: needVideo,
    cmd: (c) => [
      tk('ffprobe', TIP.ffprobe),
      ...flag('-v', TIP.v, 'error', TIP.error),
      tk('-select_streams', TIP.selectStreams),
      spec(c, c.video),
      tk('-show_entries', TIP.showEntries),
      ...fields('frame', 'frame: one line per decoded frame.', [['pict_type', 'pict_type: I, P or B.']]),
      ...flag('-of', TIP.of, 'csv=p=0', TIP.csv),
      input(c),
      tk('|', TIP.pipe),
      tk('cut', 'cut: keep only some fields of each line.'),
      tk('-d,', '-d,: fields are separated by commas.'),
      tk('-f1', '-f1: keep the first field, the letter (dropping the trailing comma some frames get).'),
      tk('|', TIP.pipe),
      tk('sort', 'sort: sort the lines, so that equal letters end up next to each other.'),
      tk('|', TIP.pipe),
      tk('uniq', 'uniq: collapse runs of identical lines into one.'),
      tk('-c', '-c: prefix each line with how many there were.'),
    ],
    when: 'To compare encoders or settings: more B-frames usually means a smaller file at the same quality, more I-frames a larger one.',
    look: () => [
      'The number of I-frames is the number of GOPs plus any key frames the encoder added at scene cuts.',
      'A high share of B-frames (60 % here) is typical of x264’s defaults; B-frames are the cheapest frames, P-frames cost more, I-frames the most.',
      'File insights in Vidscope says whether the track uses B-frames at all.',
    ],
    output: {
      title: 'Example output',
      lines: ['     60 B', '      1 I', '     38 P'],
      marks: [['60 B', '60 B-frames out of 100.']],
    },
    view: { to: 'insights', label: 'File insights: B-frames and key frame interval' },
    tags: 'count frame types statistics sort uniq',
  },
  {
    id: 'probe-bitrate',
    group: 'inspect',
    tool: 'ffprobe',
    title: 'Bitrate second by second',
    purpose: 'Add up the packet sizes of each second of the stream to see how its bitrate varies over time.',
    cmd: (c) => [
      tk('ffprobe', TIP.ffprobe),
      ...flag('-v', TIP.v, 'error', TIP.error),
      tk('-select_streams', TIP.selectStreams),
      spec(c, c.stream),
      tk('-show_entries', TIP.showEntries),
      ...fields('packet', 'packet: one line per packet.', [
        ['pts_time', 'pts_time: when the frame is shown, in seconds.'],
        ['size', 'size: its size in bytes.'],
      ]),
      ...flag('-of', TIP.of, 'csv=p=0', TIP.csv),
      input(c),
      tk('|', TIP.pipe),
      tk('awk', 'awk: a small text-processing language found on every Unix-like system.'),
      tk('-F,', '-F,: split each line at commas: $1 is the time, $2 the size.'),
      tk(`'$1 != "N/A" { kbit[int($1)] += $2 * 8 / 1000 } END { for (s in kbit) printf "%d s: %.0f kbit/s\\n", s, kbit[s] }'`, 'The awk program: for every packet that has a time, add its size in kilobits (bytes × 8 ÷ 1000) to the bucket of its whole second, int($1). At the end, print one line per second.'),
      tk('|', TIP.pipe),
      tk('sort', 'sort: put the lines in order…'),
      tk('-n', '-n: …numerically, by the second (awk prints its buckets in no particular order).'),
    ],
    when: 'To check how steady a stream is: whether it fits a bandwidth limit, how high its peaks go, whether an encode is really constant bitrate.',
    look: () => [
      'A flat line means constant bitrate (CBR, as in broadcast and live streaming); peaks at complex or fast scenes mean variable bitrate (VBR, CRF).',
      'Seconds holding a key frame are often larger: the key frame is the biggest frame of its GOP.',
      'Compare the peaks with the -maxrate a streaming ladder allows, and with the average in the [[probe-summary]].',
      'Seconds are counted on the file’s own clock: MPEG-TS files often start at 1 s or later, so their first and last lines cover only part of a second.',
      'Vidscope’s frame-size chart in the Tracks tab shows the same bytes, frame by frame.',
    ],
    output: {
      title: 'Example output',
      lines: ['0 s: 669 kbit/s', '1 s: 675 kbit/s', '2 s: 741 kbit/s', '3 s: 708 kbit/s'],
      marks: [['2 s: 741 kbit/s', 'The second that starts with the second key frame is the largest.']],
    },
    view: { to: 'tracks', track: 'stream', label: 'Tracks tab: frame-size chart' },
    tags: 'bitrate per second graph peaks vbr cbr',
  },
  {
    id: 'probe-hdr',
    group: 'inspect',
    tool: 'ffprobe',
    title: 'Colour and HDR metadata of the first frame',
    purpose: 'Decode just the first frame and print its colour description and the side data attached to it, such as HDR10 mastering display and light level metadata.',
    applies: needVideo,
    cmd: (c) => [
      tk('ffprobe', TIP.ffprobe),
      ...flag('-v', TIP.v, 'error', TIP.error),
      tk('-select_streams', TIP.selectStreams),
      spec(c, c.video),
      ...flag('-read_intervals', '-read_intervals: read only part of the file.', '%+#1', '%+#1: from the start (nothing before the %), read one packet (# counts packets instead of seconds): enough to decode the first frame.'),
      tk('-show_entries', TIP.showEntries),
      ...word([
        { t: 'frame=', tip: 'frame: fields of the decoded frame.' },
        { t: 'pix_fmt', tip: 'pix_fmt: pixel format, e.g. yuv420p (8-bit 4:2:0) or yuv420p10le (10-bit, as HDR needs).' },
        { t: ',color_range', tip: 'color_range: tv (limited: 16–235 for 8-bit) or pc (full: 0–255).' },
        { t: ',color_space', tip: 'color_space: the matrix that turns Y′CbCr into RGB (bt709, bt2020nc…).' },
        { t: ',color_primaries', tip: 'color_primaries: which red, green and blue are meant: bt709 for HD, bt2020 for UHD and HDR.' },
        { t: ',color_transfer', tip: 'color_transfer: the transfer function: bt709 (SDR), smpte2084 (PQ: HDR10, Dolby Vision) or arib-std-b67 (HLG).' },
        { t: ':frame_side_data_list', tip: 'and the frame’s side data: extra records attached to the picture, such as the mastering display and content light level of HDR10, or the encoder’s SEI messages.' },
      ]),
      ...flag('-of', TIP.of, 'json', TIP.json),
      input(c),
    ],
    when: 'To check whether a file is really HDR, and with which metadata, before encoding or delivering it.',
    look: () => [
      'SDR HD video: bt709 primaries and transfer, tv range. HDR10: bt2020 primaries, smpte2084 transfer, and two side data records.',
      'Mastering display metadata: the colour volume of the monitor the video was graded on; max_luminance 10000000/10000 means 1,000 nits.',
      'Content light level metadata: max_content (MaxCLL, the brightest pixel) and max_average (MaxFALL, the brightest frame on average), in nits.',
      'unknown means the stream does not say; players then guess, usually bt709 for HD.',
      'Vidscope reads the same values from the bitstream: the SPS VUI (colour_primaries 9 = BT.2020, transfer 16 = PQ) and the SEI messages of the first frame.',
    ],
    output: {
      title: 'Example output (a 10-bit HEVC HDR10 file, shortened)',
      lines: [
        '"pix_fmt": "yuv420p10le",',
        '"color_range": "tv",',
        '"color_space": "bt2020nc",',
        '"color_primaries": "bt2020",',
        '"color_transfer": "smpte2084",',
        '"side_data_type": "Mastering display metadata",',
        '"max_luminance": "10000000/10000"',
        '"side_data_type": "Content light level metadata",',
        '"max_content": 1000,',
        '"max_average": 400',
      ],
      marks: [
        ['yuv420p10le', '10-bit samples, little-endian.'],
        ['smpte2084', 'PQ: this is HDR10.'],
        ['10000000/10000', 'In units of 0.0001 nits: 1,000 nits.'],
        ['"max_content": 1000', 'MaxCLL: 1,000 nits.'],
        ['"max_average": 400', 'MaxFALL: 400 nits.'],
      ],
    },
    view: { to: 'frame', track: 'video', label: 'Show the first frame’s SPS and SEI' },
    tags: 'hdr hdr10 color colour primaries transfer pq hlg mastering maxcll side data',
  },
  {
    id: 'probe-chapters',
    group: 'inspect',
    tool: 'ffprobe',
    title: 'Chapters',
    purpose: 'List the chapters with their start and end times and titles.',
    cmd: (c) => [
      tk('ffprobe', TIP.ffprobe),
      ...flag('-v', TIP.v, 'error', TIP.error),
      tk('-show_chapters', '-show_chapters: print one CHAPTER section per chapter: id, time base, start and end, and its tags (the title).'),
      ...flag('-of', TIP.of, 'compact', TIP.compact),
      input(c),
    ],
    when: 'To check the chapters of a film or a podcast, or before converting to a container that stores them differently.',
    look: () => [
      'start_time and end_time are in seconds; tag:title is the chapter’s name.',
      'An MP4 stores chapters as a text track that the video track points to (a chap reference) or in a Nero chpl box; Matroska stores them in its Chapters element. The Structure tab shows which.',
      'No output means the file has no chapters.',
    ],
    view: { to: 'structure', label: 'Structure tab: where the chapters are stored' },
    tags: 'chapters markers',
  },
  {
    id: 'probe-programs',
    group: 'inspect',
    tool: 'ffprobe',
    title: 'Programs and PIDs (MPEG-TS)',
    purpose: 'List the programs (services) of a transport stream, the PIDs of their tables and streams, and their names.',
    applies: (c) => (c.format === 'mpegts' ? null : 'Only MPEG-TS files have programs; for this file the output is empty.'),
    cmd: (c) => [
      tk('ffprobe', TIP.ffprobe),
      ...flag('-v', TIP.v, 'error', TIP.error),
      tk('-show_entries', TIP.showEntries),
      ...word([
        { t: 'program=program_num,pmt_pid,pcr_pid', tip: 'program: program_num is the service number from the PAT, pmt_pid the PID its program map table is sent on, pcr_pid the PID that carries its clock (PCR).' },
        { t: ':program_tags', tip: 'program_tags: the service name and provider (from the DVB SDT table).' },
        { t: ':program_stream=index,id,codec_name,codec_type', tip: 'program_stream: each stream of the program: FFmpeg’s index, id (the PID, in hexadecimal) and codec.' },
      ]),
      ...flag('-of', TIP.of, 'compact', TIP.compact),
      input(c),
    ],
    when: 'On broadcast recordings and multiplexes, to see which services they carry and on which PIDs.',
    look: () => [
      'One line per program, followed by its streams. id=0x100 is the PID: the number Vidscope shows on every TS packet of that stream and in the PMT.',
      'pmt_pid=4096 is 0x1000, where FFmpeg’s muxer sends the first PMT.',
      'Several programs mean several services (TV channels) in one stream; a player shows one of them.',
    ],
    view: { to: 'structure', label: 'Structure tab: PAT, PMT and packets by PID' },
    tags: 'mpeg-ts programs pid pmt pcr services',
  },
  {
    id: 'probe-hexdump',
    group: 'inspect',
    tool: 'ffprobe',
    title: 'Bytes of the first packet',
    purpose: 'Print the first packet of a stream as a hex dump: the same bytes the hex view shows, as FFmpeg’s demuxer hands them to the decoder.',
    cmd: (c) => [
      tk('ffprobe', TIP.ffprobe),
      ...flag('-v', TIP.v, 'error', TIP.error),
      tk('-select_streams', TIP.selectStreams),
      spec(c, c.stream),
      ...flag('-read_intervals', '-read_intervals: read only part of the file.', '%+#1', '%+#1: from the start, one packet.'),
      tk('-show_entries', TIP.showEntries),
      ...fields('packet', 'packet: fields of the packet.', [
        ['pos', 'pos: where the packet starts in the file.'],
        ['size', 'size: its length in bytes.'],
        ['flags', 'flags: K for a key frame.'],
        ['data', 'data: the packet’s bytes (printed only together with -show_data).'],
      ]),
      tk('-show_data', '-show_data: print the payload as a hex dump in xxd’s layout: offset within the packet, 16 bytes in hexadecimal, then the same bytes as text.'),
      input(c),
      tk('|', TIP.pipe),
      tk('head', 'head: show only the first lines…'),
      tk('-n', '-n: …this many:'),
      tk('20', '20: the packet’s fields and its first 240 bytes.'),
    ],
    when: 'To see what a codec actually stores, or to compare a packet byte for byte with what Vidscope shows.',
    look: (c) => [
      'pos is where these bytes sit in the file: press g in Vidscope and type it to see the same bytes, coloured by the NAL units they belong to.',
      'MP4 and Matroska store H.264 and HEVC with a length before each NAL unit: 00 00 02 ac is 684 bytes, then 06 starts an SEI NAL unit.',
      'MPEG-TS and raw .h264 files use start codes instead: 00 00 00 01 before each NAL unit.',
      'x264 and x265 write their version and every setting as plain text in an SEI message: it is readable in the text column, and Vidscope decodes it in the inspector.',
      c.format === 'mpegts' ? 'For MPEG-TS the dump is the frame reassembled from many 188-byte packets, without their headers: in the file these bytes are spread out.' : null,
    ],
    output: {
      title: 'Example output (first packet of an H.264 MP4)',
      lines: [
        '[PACKET]',
        'size=8322',
        'pos=48',
        'flags=K__',
        'data=',
        '00000000: 0000 02ac 0605 ffff a8dc 45e9 bde6 d948  ..........E....H',
        '00000010: b796 2cd8 20d9 23ee ef78 3236 3420 2d20  ..,. .#..x264 - ',
      ],
      marks: [
        ['0000 02ac', 'The NAL unit’s length: 0x2ac = 684 bytes (MP4’s 4-byte length prefix).'],
        ['06', 'NAL header: type 6, an SEI message.'],
        ['05', 'SEI payload type 5: user data unregistered (x264’s settings).'],
        ['x264 - ', 'The start of x264’s settings string.'],
      ],
    },
    view: { to: 'frame', track: 'stream', sample: 'first', label: 'Show the first packet in the hex view' },
    tags: 'hex dump bytes data nal',
  },
  {
    id: 'probe-error',
    group: 'inspect',
    tool: 'ffprobe',
    title: 'Does FFmpeg accept the file?',
    purpose: 'A yes-or-no check: the container name and duration if FFmpeg can open the file, a structured error if it cannot.',
    cmd: (c) => [
      tk('ffprobe', TIP.ffprobe),
      ...flag('-v', TIP.v, 'error', TIP.error),
      tk('-show_error', '-show_error: if the file cannot be opened, print an ERROR section with the error code and message.'),
      tk('-show_entries', TIP.showEntries),
      ...fields('format', 'format: the container.', [
        ['format_name', 'format_name: the demuxer that recognised the file.'],
        ['duration', 'duration: in seconds.'],
      ]),
      input(c),
    ],
    when: 'In scripts and upload checks: the exit status is non-zero when the file cannot be opened.',
    look: () => [
      '[FORMAT] with a format_name: FFmpeg recognised the container.',
      '[ERROR] code=-1094995529 (Invalid data found when processing input): the bytes do not look like any format FFmpeg reads, or the header is damaged. Vidscope still shows the bytes and what it can recognise.',
      'code=-2: no such file.',
      'Opening is not decoding: to check every frame, use [[measure-decode]].',
    ],
    view: { to: 'insights', label: 'File insights: integrity' },
    tags: 'check validate error broken',
  },

  // ================================================================ watch
  {
    id: 'play-frametype',
    group: 'watch',
    tool: 'ffplay',
    title: 'Frame type and number on the picture',
    essential: true,
    purpose: 'Play the video with each frame’s picture type (I, P or B) and number written in the corner, to watch the GOP structure go by.',
    applies: needVideo,
    needs: [{ filter: 'drawtext', build: '--enable-libfreetype', why: 'drawtext draws text with the FreeType library; without a fontfile= option it also needs fontconfig (--enable-libfontconfig) to find a font.' }],
    cmd: (c) => [
      tk('ffplay', TIP.ffplay),
      ...(c.video && c.video.n > 0 ? flag('-vst', '-vst: which video stream to show (a stream specifier).', c.video.spec, `${c.video.spec}: ${c.video.label}.`, { ff: 'play' }) : []),
      tk('-vf', TIP.vf, { ff: 'out' }),
      ...word([
        { t: 'drawtext=', tip: 'drawtext: write text on every frame. It needs an FFmpeg built with FreeType; the default font is found through fontconfig.' },
        { t: "text='%{pict_type} %{n}'", tip: "text: %{pict_type} expands to the frame’s picture type (I, P or B) and %{n} to its number (0, 1, 2… in display order). The single quotes keep the space inside the value." },
        { t: ':fontsize=48', tip: 'fontsize: 48 pixels high.' },
        { t: ':fontcolor=white', tip: 'fontcolor: white text…' },
        { t: ':box=1:boxcolor=black@0.6:boxborderw=8', tip: '…on a black box at 60 % opacity (@0.6), 8 pixels larger than the text, so it stays readable on any picture.' },
        { t: ':x=16:y=16', tip: 'x, y: position of the text’s top-left corner, in pixels from the top-left of the picture.' },
      ], { role: 'graph', ff: 'out' }),
      input(c),
    ],
    when: 'To learn to recognise frame types: pause, step through a GOP, and see which frames look softer (B-frames get fewer bits).',
    look: (c) => [
      'Press space to pause and s to step one frame at a time: the letters follow the GOP pattern (I B B P B B P…).',
      c.frame?.track === c.video?.track && c.frame ? `The selected frame is number ${c.frame.display} in display order (${c.time}): pause near that time and step to it.` : null,
      'The numbers count frames as they are shown. Vidscope’s Tracks list counts them as they are stored (decoding order), where each P-frame comes before the B-frames shown ahead of it.',
      'The fix for “no font found”: add :fontfile=/path/to/a/font.ttf to the filter.',
    ],
    output: {
      title: 'What you will see',
      text: 'A window playing the video, with “I 0”, “B 1”, “B 2”, “P 3”… in its top-left corner. The window title is the file name; q or Esc closes it.',
    },
    view: { to: 'tracks', track: 'video', label: 'Tracks tab: the same frames in decoding order' },
    tags: 'overlay text pict_type frame number gop drawtext',
  },
  {
    id: 'play-mvs',
    group: 'watch',
    tool: 'ffplay',
    title: 'Motion vectors',
    purpose: 'Draw the motion vectors the decoder finds: arrows showing where each block of the picture was copied from.',
    applies: (c) => {
      if (!c.video) return needVideo(c);
      const k = codecKey(c.video.track);
      return k && !['h264', 'mpeg2', 'mpeg4', 'h263'].includes(k) ? `This file’s video is ${c.video.track.codecName}: its decoder does not export motion vectors, so no arrows appear (it works with H.264, MPEG-2 and MPEG-4 Part 2).` : null;
    },
    cmd: (c) => [
      tk('ffplay', TIP.ffplay),
      ...flag('-flags2', '-flags2: extra decoder flags.', '+export_mvs', '+export_mvs: ask the decoder to attach each frame’s motion vectors to it as side data. Supported by the H.264, MPEG-2, MPEG-4 Part 2 and H.263 decoders, not by HEVC, VP9 or AV1.', { ff: 'in' }),
      tk('-vf', TIP.vf, { ff: 'out' }),
      ...word([
        { t: 'codecview=', tip: 'codecview: draw what the decoder exported on top of the picture.' },
        { t: 'mv=pf+bf+bb', tip: 'mv: which vectors to draw: pf = forward-predicted vectors of P-frames, bf = forward vectors of B-frames, bb = backward vectors of B-frames.' },
      ], { role: 'graph', ff: 'out' }),
      input(c),
    ],
    when: 'To see how motion compensation works: what the encoder found moving, and where it gave up and coded blocks from scratch.',
    look: () => [
      'Each arrow shows where a block was taken from in the reference picture: long arrows mean fast motion.',
      'I-frames have no arrows: they use no other picture.',
      'Blocks without an arrow in a P- or B-frame were coded without prediction (something new appeared) or skipped (nothing changed).',
    ],
    view: { to: 'frame', track: 'video', label: 'Show the frame’s slices' },
    tags: 'motion vectors codecview export_mvs prediction',
  },
  {
    id: 'play-iframes',
    group: 'watch',
    tool: 'ffplay',
    title: 'Only the I-frames',
    purpose: 'Show only the intra-coded frames: the picture changes at each I-frame and holds until the next.',
    applies: needVideo,
    cmd: (c) => [
      tk('ffplay', TIP.ffplay),
      tk('-vf', TIP.vf, { ff: 'out' }),
      ...word([
        { t: 'select=', tip: 'select: pass only the frames for which the expression is true (not zero).' },
        { t: "'eq(pict_type,I)'", tip: 'eq(a,b) is 1 when a equals b: here when the picture type is I. The single quotes keep the comma from splitting the filter graph.' },
      ], { role: 'graph', ff: 'out' }),
      input(c),
    ],
    when: 'To see the GOP length as time, and where the encoder put extra key frames (at scene cuts).',
    look: () => [
      'The time between two changes is the GOP length.',
      'A change that comes early, at a cut, is a scene-cut key frame; [[fix-gop]] turns them off for streaming.',
    ],
    view: { to: 'tracks', track: 'video', label: 'Tracks tab: key frames in the chart' },
    tags: 'select intra keyframes',
  },
  {
    id: 'play-showinfo',
    group: 'watch',
    tool: 'ffplay',
    title: 'Every frame’s details as it plays',
    purpose: 'Log one line per frame while it plays: number, timestamps, picture type, key-frame flag, checksums and side data.',
    applies: needVideo,
    cmd: (c) => [
      tk('ffplay', TIP.ffplay),
      tk('-vf', TIP.vf, { ff: 'out' }),
      tk('showinfo', 'showinfo: pass frames unchanged and log a line for each: n (number), pts and pts_time, fmt (pixel format), s (size), i (P progressive, T or B interlaced), iskey, type (I, P or B), checksums, and any side data (SEI, HDR metadata, captions).', { role: 'graph', ff: 'out' }),
      input(c),
    ],
    when: 'To match what you see with timestamps and frame types, or to find which frames carry SEI or HDR metadata.',
    look: () => [
      'iskey:1 type:I marks the key frames.',
      'pts_time is the same presentation time as in the [[probe-packets]] list and Vidscope’s display column.',
      '“side data” lines show SEI user data (the encoder’s settings), mastering display and content light level metadata, and captions.',
      'The same filter works without a window: ffmpeg -i FILE -vf showinfo -f null -',
    ],
    output: {
      title: 'Example line (shortened)',
      lines: ['[Parsed_showinfo_0 @ 0x…] n:   0 pts:      0 pts_time:0       duration:    512 duration_time:0.04    fmt:yuv420p cl:left sar:1/1 s:640x360 i:P iskey:1 type:I checksum:3536EF59'],
      marks: [
        ['n:   0', 'Frame number, in display order.'],
        ['pts:      0', 'Presentation timestamp in time-base ticks (1/12800 s here).'],
        ['duration:    512', '512 ticks = 0.04 s: one frame at 25 fps.'],
        ['i:P', 'P: progressive (T or B would mean interlaced, top or bottom field first).'],
        ['iskey:1 type:I', 'A key frame, and an I-frame.'],
        ['checksum:3536EF59', 'Checksum of the decoded picture: equal checksums mean identical pictures.'],
      ],
    },
    view: { to: 'frame', track: 'video', label: 'Show the selected frame' },
    tags: 'showinfo log frame info checksum',
  },
  {
    id: 'play-section',
    group: 'watch',
    tool: 'ffplay',
    title: 'Play from the selected frame, three times',
    purpose: 'Start playback at a given time, play a few seconds, loop, and close the window at the end.',
    cmd: (c) => [
      tk('ffplay', TIP.ffplay),
      tk('-ss', '-ss: start position, counted from the start of the file. ffplay jumps to a key frame near it; it does not decode up to the exact frame the way ffmpeg does.', { ff: 'in' }),
      { ...timeTok(c), ff: 'in' },
      ...flag('-t', '-t: how long to play.', '3', '3: three seconds.', { ff: 'play', role: 'limit' }),
      ...flag('-loop', '-loop: how many times to play (0 means forever).', '3', '3: three times.', { ff: 'play', role: 'limit' }),
      tk('-autoexit', '-autoexit: close the window when playback ends, instead of staying on the last frame.', { ff: 'play' }),
      input(c),
    ],
    when: 'To look closely at one moment: a glitch, a cut, a sync problem.',
    look: () => [
      'While playing: ← and → seek 10 s, ↑ and ↓ one minute, Page Up and Page Down to the next or previous chapter (or 10 minutes); a right-click in the window jumps to that fraction of the file.',
      'Space pauses; s then steps one frame at a time.',
    ],
    view: { to: 'frame', track: 'stream', label: 'Show the selected frame' },
    tags: 'seek loop autoexit ss play section',
  },
  {
    id: 'play-track',
    group: 'watch',
    tool: 'ffplay',
    title: 'Play the selected track',
    purpose: 'Choose which audio, video or subtitle stream ffplay plays, instead of the one it would pick itself.',
    applies: (c) => (c.stream && ['v', 'a', 's'].includes(c.stream.type) ? null : 'Select a video, audio or subtitle track (in the Tracks tab) to fill this in.'),
    cmd: (c) => {
      const s = c.stream;
      const opt = { v: '-vst', a: '-ast', s: '-sst' }[s?.type] ?? '-ast';
      const what = { v: 'video', a: 'audio', s: 'subtitle' }[s?.type] ?? 'audio';
      return [
        tk('ffplay', TIP.ffplay),
        tk(opt, `${opt}: which ${what} stream to play (a stream specifier). Without it ffplay picks the “best” one: usually the default track, or the one with the most channels or pixels.`, { ff: 'play' }),
        { ...spec(c, s, { kind: s?.type ?? 'a' }), ff: 'play' },
        input(c),
      ];
    },
    when: 'For files with several languages, commentary tracks or subtitle tracks: FFmpeg’s a:1 is the second audio track of the Tracks tab.',
    look: () => [
      'Press a to switch to the next audio stream while playing, v for video and t for subtitles.',
    ],
    view: { to: 'tracks', track: 'stream', label: 'Tracks tab: pick a track' },
    tags: 'audio track language select stream ast vst sst',
  },
  {
    id: 'play-showmode',
    group: 'watch',
    tool: 'ffplay',
    title: 'Audio waveform or spectrum',
    purpose: 'Show the sound instead of the picture: its waveform, or a running frequency analysis.',
    applies: needAudio,
    cmd: (c) => [
      tk('ffplay', TIP.ffplay),
      ...flag('-showmode', '-showmode: what the window shows: 0 the video, 1 the audio waveform, 2 the audio spectrum (a real discrete Fourier transform, RDFT).', '1', '1: the waveform.', { ff: 'play' }),
      input(c),
    ],
    when: 'To check audio at a glance: silence, clipping, channel balance, or the frequency cut-off of a lossy codec.',
    look: () => [
      'Press w to cycle between the video, the waveform and the spectrum while playing.',
      'Silence is a flat line; clipping shows as the waveform hitting the top and bottom.',
      'In the spectrum, lossy encoders cut the highest frequencies: a sharp edge near 16 kHz is typical of AAC at low bitrates.',
    ],
    view: { to: 'tracks', track: 'audio', label: 'Tracks tab: the audio track' },
    tags: 'audio waveform spectrum rdft showmode',
  },
  {
    id: 'play-audio-filters',
    group: 'watch',
    tool: 'ffplay',
    title: 'Waveform and spectrum with filters',
    purpose: 'Build your own audio display with the showwaves and showspectrum filters: here a waveform above a scrolling spectrogram, while the audio plays.',
    applies: needAudio,
    cmd: (c) => [
      tk('ffplay', TIP.ffplay),
      ...flag('-f', TIP.f, 'lavfi', TIP.lavfi, { ff: 'in' }),
      ...word([
        { t: 'amovie=', tip: TIP.movie },
        { t: graphPath(c.path), raw: true, tip: 'The open file, escaped for the filter graph ($HOME stands for ~).' },
        { t: ',asplit=3[out1][a][b]', tip: 'asplit copies the audio three times: out1 is played, a and b feed the two displays.' },
        { t: ';[a]showwaves=size=1024x200:mode=line[w]', tip: 'showwaves turns the audio into video: a 1024×200 waveform drawn with lines.' },
        { t: ';[b]showspectrum=size=1024x400:slide=scroll[s]', tip: 'showspectrum draws a spectrogram: time scrolls from right to left, frequency goes up, loudness is colour.' },
        { t: ';[w][s]vstack[out0]', tip: 'vstack puts the waveform above the spectrum. With lavfi the outputs named out0, out1… become the streams: out0 is shown, out1 is heard.' },
      ], { role: 'input', ff: 'in' }),
    ],
    when: 'When -showmode is not enough: other sizes and scales (showspectrum scale=log), colours, or saving the display as a video with ffmpeg.',
    look: () => [
      'The same graph works in ffmpeg to render the display into a video file (ffmpeg -f lavfi -i "…" out.mp4).',
    ],
    view: { to: 'tracks', track: 'audio', label: 'Tracks tab: the audio track' },
    tags: 'showwaves showspectrum spectrogram lavfi amovie',
  },
  {
    id: 'play-scopes',
    group: 'watch',
    tool: 'ffplay',
    title: 'Video scopes: waveform, vectorscope, histogram',
    purpose: 'Show the picture with the three scopes colourists and broadcast engineers use, in a 2×2 grid.',
    applies: needVideo,
    cmd: (c) => [
      tk('ffplay', TIP.ffplay),
      tk('-vf', TIP.vf, { ff: 'out' }),
      ...word([
        { t: 'split=4[a][b][c][d]', tip: 'split copies each frame four times: one for the picture and one for each scope.' },
        { t: ';[a]scale=480:270[p]', tip: 'The picture, scaled to a quarter of a 960×540 window.' },
        { t: ';[b]waveform=graticule=green:flags=numbers,scale=480:270[w]', tip: 'waveform: for each column of the picture, the brightness (luma) of its pixels, from 0 at the bottom to 255 at the top. The graticule draws reference lines with their values.' },
        { t: ';[c]vectorscope=mode=color3:graticule=green,scale=480:270[v]', tip: 'vectorscope: every pixel placed by its colour (Cb across, Cr up): saturation grows outwards from the centre, hue is the angle. The graticule marks the colour-bar targets.' },
        { t: ';[d]histogram,scale=480:270[h]', tip: 'histogram: how many pixels have each level, for each component (Y, U, V).' },
        { t: ';[p][w][v][h]xstack=inputs=4:layout=0_0|w0_0|0_h0|w0_h0', tip: 'xstack tiles the four in a 2×2 grid; layout gives each input’s position (w0 and h0 are the width and height of the first input).' },
      ], { role: 'graph', ff: 'out' }),
      input(c),
    ],
    when: 'To judge exposure and colour objectively: crushed blacks, clipped highlights, oversaturated colours, illegal levels.',
    look: () => [
      'Waveform: 8-bit video in limited (tv) range should stay between 16 and 235; values outside are clipped by most displays.',
      'Vectorscope: skin tones fall along a line between red and yellow; points beyond the targets are oversaturated.',
      'Histogram: a pile at the left edge means crushed blacks, at the right edge clipped highlights.',
    ],
    view: { to: 'frame', track: 'video', label: 'Show the selected frame' },
    tags: 'waveform vectorscope histogram scopes levels xstack',
  },
  {
    id: 'play-brng',
    group: 'watch',
    tool: 'ffplay',
    title: 'Highlight out-of-range pixels',
    purpose: 'Mark the pixels whose values are outside the broadcast range, which TVs clip.',
    applies: needVideo,
    cmd: (c) => [
      tk('ffplay', TIP.ffplay),
      tk('-vf', TIP.vf, { ff: 'out' }),
      ...word([
        { t: 'signalstats=', tip: 'signalstats: measures each frame (lowest, average and highest luma, saturation, temporal outliers…) and can mark problem pixels.' },
        { t: 'out=brng', tip: 'out=brng: highlight the pixels outside the broadcast range (luma below 16 or above 235 for 8-bit), in yellow.' },
      ], { role: 'graph', ff: 'out' }),
      input(c),
    ],
    when: 'Before delivering to broadcast, or to see why a picture looks clipped on a TV but not on a computer.',
    look: () => [
      'Yellow pixels would be clipped on a TV or by a limited-range decoder.',
      '[[measure-signalstats]] prints the same statistics for every frame.',
    ],
    view: { to: 'frame', track: 'video', label: 'Show the selected frame' },
    tags: 'signalstats broadcast range brng legal levels',
  },
  {
    id: 'play-compare',
    group: 'watch',
    tool: 'ffplay',
    title: 'Original and encode side by side',
    purpose: 'Play two files next to each other in one window: the open file and the encode made by [[fix-crf]].',
    applies: needVideo,
    uses: 'fix-crf',
    cmd: (c) => [
      tk('ffplay', TIP.ffplay),
      ...flag('-f', TIP.f, 'lavfi', TIP.lavfi, { ff: 'in' }),
      ...word([
        { t: 'movie=', tip: TIP.movie },
        { t: graphPath(c.path), raw: true, tip: 'The open file (the original) on the left, escaped for the filter graph.' },
        { t: ',scale=-2:540[a]', tip: 'scale both pictures to 540 lines (width -2: keep the aspect ratio, rounded to an even number), because hstack needs equal heights.' },
        { t: ';movie=', tip: TIP.movie },
        { t: dqBody(filterValue(local(crfName(c)))), raw: true, tip: `${crfName(c)}: the encode made by “Quality-based encode (CRF)” in the Fix group, in the current folder, on the right.`, role: 'input2' },
        { t: ',scale=-2:540[b]', tip: 'The same size as the left side.' },
        { t: ';[a][b]hstack', tip: 'hstack puts the two pictures side by side.' },
      ], { role: 'input', ff: 'in' }),
    ],
    when: 'To judge an encode with your own eyes before trusting a number.',
    look: () => [
      'Pause (space) on detailed or fast-moving frames and step (s): encoding artefacts show as blocking, smeared texture and banding in gradients.',
      'For numbers instead of eyes: [[measure-quality]] and [[measure-vmaf]].',
    ],
    view: { to: 'tracks', track: 'video', label: 'Tracks tab: the original’s video' },
    tags: 'compare side by side hstack encode original',
  },
  {
    id: 'play-live',
    group: 'watch',
    tool: 'ffplay',
    title: 'Watch a live stream with low latency',
    purpose: 'Send the open file as a live stream over UDP with ffmpeg, then watch it with ffplay set up for the lowest delay.',
    applies: needVideo,
    needs: (c) => [{ encoder: 'libx264' }],
    cmd: (c) => [
      {
        note: '1. In one terminal, send the file in real time, encoded the way a live encoder would (no B-frames):',
        tool: 'ffmpeg',
        tokens: [
          tk('ffmpeg', TIP.ffmpeg),
          tk('-re', '-re: read the input at its own speed (real time) instead of as fast as possible, like a camera or a broadcast feed.'),
          ...dashI(c),
          ...flag('-c:v', TIP.cv, 'libx264', TIP.x264),
          ...flag('-preset', TIP.preset, 'veryfast', 'veryfast: cheap enough to encode in real time.'),
          ...flag('-tune', '-tune: settings tuned for a kind of content or use.', 'zerolatency', 'zerolatency: no B-frames and no look-ahead, so every frame can be sent as soon as it is encoded.'),
          ...flag('-g', '-g: at most this many frames between key frames.', c.gop ? String(c.gop) : '50', c.gop ? `${c.gop}: a key frame every 2 seconds, so a viewer who tunes in waits at most that long.` : '50: a key frame every 50 frames (2 s at 25 fps), so a viewer who tunes in waits at most that long.'),
          ...aacAudio(c),
          ...flag('-f', TIP.f, 'mpegts', 'mpegts: MPEG transport stream, the container of broadcast and live links: a receiver can join at any packet.'),
          tk(shq('udp://127.0.0.1:1234?pkt_size=1316'), 'Send over UDP to this computer, port 1234. pkt_size=1316 puts seven 188-byte TS packets in each datagram, the usual size for TS over UDP. Quoted because ? is special to the shell.', { role: 'output' }),
        ],
      },
      {
        note: '2. In a second terminal, watch it:',
        tokens: [
          tk('ffplay', TIP.ffplay),
          ...flag('-fflags', '-fflags: demuxer flags.', 'nobuffer', 'nobuffer: do not buffer packets while analysing the stream; show them as soon as possible.', { ff: 'in' }),
          ...flag('-flags', '-flags: decoder flags.', 'low_delay', 'low_delay: output each frame as soon as it is decoded instead of holding frames back for reordering. Safe only without B-frames, which is why the sender uses -tune zerolatency.', { ff: 'in' }),
          tk('-framedrop', '-framedrop: drop video frames that are late instead of falling further behind (on by default unless video is the master clock; this forces it on).', { ff: 'play' }),
          tk(shq('udp://127.0.0.1:1234'), 'Listen on UDP port 1234 of this computer.', { role: 'input' }),
        ],
      },
    ],
    when: 'To test a live chain (encoder, network, player) and see what the latency flags buy you.',
    look: () => [
      'Start either one first: with MPEG-TS the player picks the stream up at the next key frame, every 2 seconds here.',
      'Without the three flags ffplay buffers for a few seconds before it starts; with them the delay is a fraction of a second on this computer.',
      'Over the internet use SRT or RTMP instead of UDP (SRT needs an FFmpeg built with --enable-libsrt).',
    ],
    view: { to: 'tracks', track: 'video', label: 'Tracks tab: the source’s video' },
    tags: 'live udp low latency nobuffer low_delay framedrop zerolatency mpegts',
  },
  {
    id: 'play-sync',
    group: 'watch',
    tool: 'ffplay',
    title: 'Status line and A/V sync',
    purpose: 'Watch ffplay’s status line while it plays: the playback clock, how far audio and video are apart, dropped frames and queue sizes.',
    cmd: (c) => [
      tk('ffplay', TIP.ffplay),
      tk('-stats', '-stats: show the status line (on by default; -nostats hides it).', { ff: 'play' }),
      ...flag('-sync', '-sync: the master clock the other streams follow (mostly a debugging option).', 'audio', 'audio: video frames are shown when the sound reaches their time, as in most players (the default). video makes the audio follow the video; ext follows an external clock, as for some live sources.', { ff: 'play' }),
      input(c),
    ],
    when: 'When audio and video drift apart, or playback stutters: the numbers tell you which side is late.',
    look: () => [
      'The first number is the playback clock in seconds.',
      'A-V is the difference between the audio and video clocks, in seconds: within ±0.05 it is invisible.',
      'fd counts frames dropped to stay in sync: it rises when decoding is too slow.',
      'aq, vq and sq are the audio, video and subtitle packet queues: an empty vq while playing means the demuxer cannot read fast enough.',
    ],
    output: {
      title: 'Example status line',
      lines: ['   1.16 A-V: -0.032 fd=   0 aq=    0KB vq=    0KB sq=    0B'],
      marks: [
        ['1.16', 'Playback clock: 1.16 s.'],
        ['A-V: -0.032', 'Audio 32 ms behind video: in sync for the eye.'],
        ['fd=   0', 'No frames dropped.'],
        ['aq=    0KB vq=    0KB sq=    0B', 'Queued packets: audio, video, subtitles.'],
      ],
    },
    view: { to: 'tracks', track: 'stream', label: 'Tracks tab: timestamps of each track' },
    tags: 'sync av status stats clock drift',
  },

  // ================================================================ fix
  {
    id: 'fix-remux',
    group: 'fix',
    tool: 'ffmpeg',
    title: 'Change the container, keep the streams (remux)',
    essential: true,
    purpose: 'Copy the video and audio into a different container without re-encoding: it takes seconds, and no quality is lost.',
    applies: (c) => (c.streams.some((s) => s && (s.type === 'v' || s.type === 'a')) ? null : 'This file has no video or audio track to copy.'),
    cmd: (c) => {
      const ext = remuxExt(c);
      const kind = { '.mp4': 'MP4', '.m4a': 'M4A (MP4 audio)', '.mkv': 'Matroska', '.mka': 'Matroska audio' }[ext];
      const name = ext.toLowerCase() === c.ext.toLowerCase() ? `${c.stem}-remux${ext}` : `${c.stem}${ext}`;
      const why = c.format === 'isobmff'
        ? 'An MP4 goes into Matroska here, to show the same frames in another structure.'
        : ext === '.mp4' || ext === '.m4a' ? 'Every stream of this file fits in MP4, the most widely playable container.' : 'Not every stream of this file fits in MP4, so Matroska, which takes almost any codec.';
      return [tk('ffmpeg', TIP.ffmpeg), ...dashI(c), ...avMaps(c), ...flag('-c', TIP.c, 'copy', TIP.copy), out(name, `${ext}: the extension chooses the container, ${kind}. ${why}`)];
    },
    when: 'When a device or site rejects a container (MKV, TS, FLV, AVI) but would accept the codecs inside it in another one, usually MP4.',
    look: () => [
      'In the Stream mapping lines, (copy) next to each stream means nothing is decoded or encoded.',
      'Open the new file in Vidscope and compare: the same frames byte for byte (same sizes, same NAL units), in another structure. MP4’s moov, trak, stsz and stco boxes become Matroska’s Segment, Tracks, Clusters and Cues, or the other way round.',
      'The time base changes with the container: 1k tbn in Matroska (milliseconds), 12800 or 90k in MP4.',
      'If ffmpeg says a codec is “not currently supported in container”, that stream cannot go into the new container: pick another one, or re-encode that stream.',
    ],
    output: {
      title: 'Example output (MP4 to Matroska, shortened)',
      lines: [
        'Stream mapping:',
        '  Stream #0:0 -> #0:0 (copy)',
        '  Stream #0:1 -> #0:1 (copy)',
        "Output #0, matroska, to 'h264-aac.mkv':",
        '  Stream #0:0(und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(progressive), 640x360 [SAR 1:1 DAR 16:9], q=2-31, 698 kb/s, 25 fps, 25 tbr, 1k tbn (default)',
        '[out#0/matroska @ 0x…] video:341KiB audio:47KiB subtitle:0KiB other streams:0KiB global headers:0KiB muxing overhead: 0.763376%',
        'frame=  100 fps=0.0 q=-1.0 Lsize=     391KiB time=00:00:03.92 bitrate= 817.8kbits/s speed= 961x',
      ],
      marks: [
        ['Stream #0:0 -> #0:0 (copy)', 'Input 0’s stream 0 becomes the output’s stream 0, copied.'],
        ['Output #0, matroska', 'The muxer, chosen from the .mkv extension.'],
        ['1k tbn', 'Matroska’s time base: 1/1000 s. The MP4 had 12,800 ticks per second.'],
        ['muxing overhead: 0.763376%', 'The container’s own bytes, on top of the media data.'],
        ['speed= 961x', '961 times faster than real time: copying is cheap.'],
      ],
    },
    view: { to: 'structure', label: 'Structure tab: the container you are leaving' },
    tags: 'remux convert container copy mkv mp4 lossless',
  },
  {
    id: 'fix-faststart',
    group: 'fix',
    tool: 'ffmpeg',
    title: 'Fast start: move the index to the front',
    essential: true,
    purpose: 'Rewrite an MP4 so that its index (the moov box) comes before the media data, letting playback start while the file is still downloading.',
    applies: (c) => {
      if (c.format === 'isobmff') return null;
      const av = c.streams.filter((s) => s && (s.type === 'v' || s.type === 'a'));
      if (av.length && av.every((s) => MP4_OK.has(codecKey(s.track)))) return 'This file is not an MP4: the command copies its video and audio into one, with the index at the front.';
      return 'This file is not an MP4, and some of its streams cannot be copied into one.';
    },
    cmd: (c) => {
      // An MP4-family file keeps its own flavour (a MOV stays a MOV, with its timecode track).
      const same = c.format === 'isobmff' && /^\.(mp4|m4v|m4a|m4b|mov|3gp|3g2|f4v)$/i.test(c.ext);
      const ext = same ? c.ext.toLowerCase() : '.mp4';
      return [
        tk('ffmpeg', TIP.ffmpeg),
        ...dashI(c),
        ...(same ? [tk('-map', TIP.map), tk('0', '0: every stream of input 0, including subtitles, chapters and timecode.')] : avMaps(c)),
        ...flag('-c', TIP.c, 'copy', TIP.copy),
        tk('-movflags', '-movflags: options of the MP4/MOV muxer, the part of FFmpeg that writes the container.'),
        tk('+faststart', '+faststart: after writing, move the moov box (where every frame is, and when to show it) in front of mdat (the frames). A player then knows the whole layout from the first bytes and can start while the rest downloads. The + adds the flag to the defaults.'),
        out(`${c.stem}-faststart${ext}`, `The new ${ext === '.mov' ? 'MOV' : ext === '.mp4' ? 'MP4' : ext.slice(1).toUpperCase()} file.`),
      ];
    },
    when: 'Before putting an MP4 on a website or a CDN for progressive download: browsers can start playback without reading the end of the file first.',
    look: () => [
      'In Vidscope, the Structure tab and the map of the new file show moov before mdat, and File insights says the file is fast start.',
      'The size barely changes: only the order of the boxes, plus the chunk offsets in stco/co64, which are rewritten to point at the moved data.',
      'ffmpeg writes the file first and then moves moov in a second pass (it says so), so it needs room for a second copy on the disk.',
    ],
    output: {
      title: 'Example output (shortened)',
      lines: [
        'Stream mapping:',
        '  Stream #0:0 -> #0:0 (copy)',
        '  Stream #0:1 -> #0:1 (copy)',
        "Output #0, mp4, to 'h264-aac-faststart.mp4':",
        '[mp4 @ 0x…] Starting second pass: moving the moov atom to the beginning of the file',
        'frame=  100 fps=0.0 q=-1.0 Lsize=     393KiB time=00:00:03.92 bitrate= 820.6kbits/s speed= 118x',
      ],
      marks: [
        ['(copy)', 'Stream copy: nothing is decoded or encoded.'],
        ['Starting second pass: moving the moov atom to the beginning of the file', 'The fast start pass: FFmpeg calls boxes “atoms”, their QuickTime name.'],
        ['Lsize=     393KiB', 'Size of the written file.'],
      ],
    },
    view: { to: 'node', type: 'moov', label: 'Structure: this file’s moov box' },
    tags: 'faststart moov progressive download web streaming',
  },
  {
    id: 'fix-frame',
    group: 'fix',
    tool: 'ffmpeg',
    title: 'Save the selected frame as an image',
    essential: true,
    purpose: 'Decode one frame, exactly the one at the selected time, and save it as a PNG image.',
    applies: needVideo,
    cmd: (c) => {
      const name = c.frame ? `${c.stem}-${c.frame.rel.toFixed(3)}s.png` : `${c.stem}-frame.png`;
      const ss = exactSeek(c, [c.video?.track]);
      return [
        tk('ffmpeg', TIP.ffmpeg),
        ...ss.before,
        ...dashI(c),
        ...ss.after,
        tk('-map', TIP.map),
        spec(c, c.video, { input: 0 }),
        ...flag('-frames:v', '-frames:v: stop after this many video frames.', '1', '1: a single frame.'),
        ...flag('-update', '-update: write one image file instead of a numbered sequence (without it ffmpeg warns that the name has no %03d-style pattern).', '1', '1: on.'),
        out(name, '.png: a lossless image, so you see exactly what the decoder produced. Use .jpg for a smaller file.'),
      ];
    },
    when: 'To grab a still, or to look at one frame closely (artefacts, colours, interlacing) outside a player.',
    look: (c) => [
      c.frame && c.frame.track === c.video?.track && !c.frame.key
        ? `The selected frame is not a key frame, so FFmpeg decodes from the key frame at ${fmtClock(c.frame.keyBefore.rel)} (sample ${c.frame.keyBefore.i + 1}) up to it: a P- or B-frame cannot be decoded on its own.`
        : null,
      c.frame && c.frame.track === c.video?.track ? 'The image shows the frame whose bytes Vidscope highlights in the hex view.' : null,
      'ffmpeg converts the decoded Y′CbCr picture to RGB for the PNG (rgb24 in its output).',
    ],
    output: {
      title: 'Example output (shortened)',
      lines: [
        'Stream mapping:',
        '  Stream #0:0 -> #0:0 (h264 (native) -> png (native))',
        "Output #0, image2, to 'h264-aac-2.520s.png':",
        '  Stream #0:0(und): Video: png, rgb24(pc, gbr/unknown/unknown, progressive), 640x360 [SAR 1:1 DAR 16:9]',
        'frame=    1 fps=0.0 q=-0.0 Lsize=N/A time=00:00:00.04 bitrate=N/A speed=0.611x',
      ],
      marks: [
        ['h264 (native) -> png (native)', 'Decoded by FFmpeg’s own H.264 decoder, encoded by its PNG encoder.'],
        ['image2', 'The image muxer: writes pictures as files.'],
        ['rgb24(pc', 'Converted to 8-bit RGB, full range (pc).'],
        ['frame=    1', 'One frame written.'],
      ],
    },
    view: { to: 'frame', track: 'video', label: 'Show the frame in the hex view' },
    tags: 'screenshot still image png thumbnail extract frame',
  },
  {
    id: 'fix-thumbs',
    group: 'fix',
    tool: 'ffmpeg',
    title: 'Key-frame contact sheet',
    purpose: 'Decode only the key frames and tile the first twelve into one image: a quick visual table of contents.',
    applies: needVideo,
    cmd: (c) => [
      tk('ffmpeg', TIP.ffmpeg),
      ...flag('-skip_frame', '-skip_frame, before -i: a decoder option for this input.', 'nokey', 'nokey: decode only key frames, which is much faster than decoding everything.'),
      ...dashI(c),
      tk('-map', TIP.map),
      spec(c, c.video, { input: 0 }),
      tk('-vf', TIP.vf),
      ...word([
        { t: 'scale=320:-2', tip: 'scale: each thumbnail 320 pixels wide; -2 keeps the aspect ratio, rounded to an even number.' },
        { t: ',tile=4x3', tip: 'tile: put 12 frames in a 4×3 grid, as one image.' },
      ], { role: 'graph' }),
      ...flag('-fps_mode', '-fps_mode: how frame timing is handled at the output (it replaces the deprecated -vsync).', 'vfr', 'vfr: pass frames through with their own timestamps; do not duplicate frames to fill the gaps between key frames.'),
      ...flag('-frames:v', '-frames:v: stop after this many output frames.', '1', '1: one sheet, the first 12 key frames.'),
      ...flag('-update', '-update: write one image file instead of a numbered sequence.', '1', '1: on.'),
      out(`${c.stem}-keyframes.png`, 'The contact sheet.'),
    ],
    when: 'To see what a file contains without playing it, or which pictures a player shows first after each seek.',
    look: (c) => [
      `Each tile is one key frame; twelve tiles cover twelve GOPs${c.gop ? ` (24 s with 2-second GOPs)` : ''}.`,
      'For every key frame as its own file, drop -frames:v 1 and -update 1 and name the output keyframe-%03d.png.',
    ],
    view: { to: 'tracks', track: 'video', label: 'Tracks tab: the key frames' },
    tags: 'thumbnails contact sheet tile keyframes skip_frame fps_mode',
  },
  {
    id: 'fix-gop',
    group: 'fix',
    tool: 'ffmpeg',
    title: 'Fixed GOP for streaming',
    purpose: 'Re-encode with a key frame exactly every 2 seconds and none in between, so that HLS and DASH segments of 2, 4 or 6 seconds all start on a key frame.',
    applies: needVideo,
    needs: (c) => [{ encoder: c.encoder === 'x265' ? 'libx265' : 'libx264' }],
    cmd: (c) => [
      tk('ffmpeg', TIP.ffmpeg),
      ...dashI(c),
      ...encoder(c),
      ...flag('-preset', TIP.preset, 'medium', 'medium: the default balance.'),
      ...crf(c),
      tk('-g', '-g: the longest allowed distance between key frames, in frames (the GOP length).'),
      gopTok(c),
      tk('-keyint_min', '-keyint_min: the shortest allowed distance between key frames. Set to the GOP length, it forbids extra key frames in between (x264 caps it at half the GOP plus one; with scene-cut detection off that no longer matters).'),
      gopTok(c),
      ...(c.encoder === 'x265'
        ? flag('-x265-params', '-x265-params: settings passed straight to x265, name=value separated by colons (libx265 ignores -sc_threshold).', 'scenecut=0:open-gop=0', 'scenecut=0 turns off the extra key frames x265 adds at scene cuts; open-gop=0 makes every GOP closed, so each segment decodes on its own.')
        : flag('-sc_threshold', '-sc_threshold: how different a frame must be to count as a scene cut, where x264 would add a key frame.', '0', '0: never: no scene-cut key frames, so the pattern stays regular.')),
      ...hvc1(c),
      ...aacAudio(c),
      out(encName(c, 'gop2s'), 'The re-encoded file.'),
    ],
    when: 'Before packaging for adaptive streaming, where every rendition of a ladder must switch at the same moments.',
    look: (c) => [
      `Check the result with [[probe-keyframes]]: key frames at 0, 2, 4… seconds${c.gop ? `, every ${c.gop} frames` : ''}.`,
      'In Vidscope the orange key-frame bars of the Tracks chart are evenly spaced, and File insights reports the interval.',
      c.encoder === 'x265'
        ? 'x265 writes its settings into the first frame (an SEI message): look for keyint, min-keyint, scenecut=0 and no-open-gop.'
        : 'x264 writes its settings into the first frame (an SEI message that Vidscope decodes): look for keyint, keyint_min and scenecut=0.',
    ],
    view: { to: 'tracks', track: 'video', label: 'Tracks tab: key frames now' },
    tags: 'gop keyint keyframes streaming hls dash abr segments sc_threshold',
  },
  {
    id: 'fix-forcekf',
    group: 'fix',
    tool: 'ffmpeg',
    title: 'Key frames every 2 seconds, by the clock',
    purpose: 'Force a key frame every 2 seconds of time rather than every N frames, which also works when the frame rate varies.',
    applies: needVideo,
    needs: (c) => [{ encoder: c.encoder === 'x265' ? 'libx265' : 'libx264' }],
    cmd: (c) => [
      tk('ffmpeg', TIP.ffmpeg),
      ...dashI(c),
      ...encoder(c),
      ...crf(c),
      tk('-force_key_frames', '-force_key_frames: make these frames key frames, whatever else the encoder decides.'),
      ...word([
        { t: 'expr:', tip: 'expr: an expression evaluated for every frame; a key frame is forced where it is true.' },
        { t: 'gte(t,n_forced*2)', tip: 'gte(a,b) is true when a ≥ b. t is the frame’s time in seconds and n_forced the number of key frames forced so far, so this is true at 0, 2, 4… seconds.' },
      ]),
      ...hvc1(c),
      ...aacAudio(c),
      out(encName(c, 'kf2s'), 'The re-encoded file.'),
    ],
    when: 'For variable frame rate sources (phone and screen recordings), where a GOP counted in frames is not a fixed time.',
    look: () => [
      'The encoder may still add key frames at scene cuts; add -sc_threshold 0 (x264) or -x265-params scenecut=0 (x265) for a strictly regular pattern.',
      '[[probe-keyframes]] shows the result.',
    ],
    view: { to: 'tracks', track: 'video', label: 'Tracks tab: key frames now' },
    tags: 'force_key_frames expression keyframes vfr',
  },
  {
    id: 'fix-crf',
    group: 'fix',
    tool: 'ffmpeg',
    title: 'Quality-based encode (CRF)',
    essential: true,
    purpose: 'Re-encode at a constant quality and let the bitrate follow the content: the simplest good encode.',
    applies: needVideo,
    needs: (c) => [{ encoder: c.encoder === 'x265' ? 'libx265' : 'libx264' }],
    cmd: (c) => [
      tk('ffmpeg', TIP.ffmpeg),
      ...dashI(c),
      ...encoder(c),
      ...flag('-preset', TIP.preset, 'slow', 'slow: somewhat better compression than the default medium, for more encoding time.'),
      ...crf(c),
      ...hvc1(c),
      ...aacAudio(c),
      out(crfName(c), 'The encode. The comparison commands (side by side, PSNR/SSIM, VMAF) reuse this file.'),
    ],
    when: 'For files you keep or share, where a steady quality matters more than hitting an exact size.',
    look: () => [
      'x264 ends with a summary per frame type: how many I, P and B-frames, their average QP (quantiser: lower means more bits and better quality) and average size.',
      'The bitrate is whatever the content needed (kb/s at the end): check how it varies with [[probe-bitrate]].',
      'Compare with the original by eye ([[play-compare]]) or with numbers ([[measure-quality]], [[measure-vmaf]]).',
      'The encoder’s settings are stored in the first frame’s SEI: Vidscope shows rc=crf crf=23.0 there.',
    ],
    output: {
      title: 'Example output with x264 (shortened)',
      lines: [
        '  Stream #0:0 -> #0:0 (h264 (native) -> h264 (libx264))',
        '[libx264 @ 0x…] profile High, level 3.0, 4:2:0, 8-bit',
        'frame=  100 fps=0.0 q=-1.0 Lsize=     396KiB time=00:00:03.92 bitrate= 827.3kbits/s speed=6.02x',
        '[libx264 @ 0x…] frame I:1     Avg QP:18.56  size:  7870',
        '[libx264 @ 0x…] frame P:30    Avg QP:24.87  size:  4818',
        '[libx264 @ 0x…] frame B:69    Avg QP:29.69  size:  2707',
        '[libx264 @ 0x…] kb/s:678.42',
      ],
      marks: [
        ['h264 (native) -> h264 (libx264)', 'Decoded by FFmpeg’s H.264 decoder, encoded by x264: a transcode.'],
        ['profile High, level 3.0', 'The profile and level x264 chose; Vidscope shows them as the codec string avc1.64001E.'],
        ['speed=6.02x', 'Encoding ran six times faster than real time.'],
        ['frame I:1     Avg QP:18.56  size:  7870', 'One I-frame: the lowest QP (most bits per pixel) and the largest size.'],
        ['frame B:69    Avg QP:29.69  size:  2707', '69 B-frames: the highest QP and the smallest size. They are the cheapest frames.'],
        ['kb/s:678.42', 'The video bitrate this content needed at CRF 23.'],
      ],
    },
    view: { to: 'tracks', track: 'video', label: 'Tracks tab: the original, to compare' },
    tags: 'crf encode x264 x265 quality constant rate factor preset',
  },
  {
    id: 'fix-capped',
    group: 'fix',
    tool: 'ffmpeg',
    title: 'Capped CRF: quality with a bitrate ceiling',
    purpose: 'Encode at a constant quality, but never above a peak bitrate: easy scenes get CRF quality, hard ones are held to the cap.',
    applies: needVideo,
    needs: (c) => [{ encoder: c.encoder === 'x265' ? 'libx265' : 'libx264' }],
    cmd: (c) => [
      tk('ffmpeg', TIP.ffmpeg),
      ...dashI(c),
      ...encoder(c),
      ...flag('-preset', TIP.preset, 'slow', 'slow: better compression than the default medium.'),
      ...crf(c),
      ...flag('-maxrate', '-maxrate: the peak bitrate the encoder may reach (checked through the VBV buffer model).', '3M', '3M: 3 Mbit/s. Scenes that would need more get lower quality instead.'),
      ...flag('-bufsize', '-bufsize: the size of that buffer, in bits: how long the rate may run above the cap before it has to come down.', '6M', '6M: 6 Mbit, two seconds at the peak rate. A smaller buffer holds the rate more tightly.'),
      ...hvc1(c),
      ...aacAudio(c),
      out(encName(c, 'capped'), 'The encode.'),
    ],
    when: 'For streaming, where the bitrate must stay under what viewers’ connections can carry, but simple content should not waste bits.',
    look: () => [
      'Check the peaks with [[probe-bitrate]]: averaged over two seconds they stay under 3 Mbit/s.',
      'Easy content comes out well below the cap: this is why capped CRF is a simple form of per-title encoding.',
    ],
    view: { to: 'tracks', track: 'video', label: 'Tracks tab: frame sizes' },
    tags: 'capped crf maxrate bufsize vbv per-title',
  },
  {
    id: 'fix-2pass',
    group: 'fix',
    tool: 'ffmpeg',
    title: 'Two-pass encode to a target bitrate',
    purpose: 'Analyse the whole video first, then encode it at an exact average bitrate, spending the bits where they matter most.',
    applies: needVideo,
    needs: (c) => [{ encoder: c.encoder === 'x265' ? 'libx265' : 'libx264' }],
    cmd: (c) => [
      {
        note: '1. First pass: analyse (no file is written besides the statistics):',
        tokens: [
          tk('ffmpeg', TIP.ffmpeg),
          ...dashI(c),
          ...encoder(c),
          ...flag('-preset', TIP.preset, 'slow', 'slow: use the same preset in both passes.'),
          ...flag('-b:v', '-b:v: the target average video bitrate.', '2M', '2M: 2 Mbit/s over the whole file.'),
          ...flag('-pass', '-pass: which pass this is.', '1', '1: analyse the video and write statistics to ffmpeg2pass-0.log (and a .mbtree or .cutree file) in the current folder. The video itself is thrown away.'),
          tk('-an', '-an: no audio in this pass; it is not needed.'),
          ...flag('-f', TIP.f, 'null', TIP.null),
          tk('-', TIP.dash),
        ],
      },
      {
        note: '2. Second pass: encode, using the statistics:',
        tokens: [
          tk('ffmpeg', TIP.ffmpeg),
          ...dashI(c),
          ...encoder(c),
          ...flag('-preset', TIP.preset, 'slow', 'slow: the same preset as the first pass.'),
          ...flag('-b:v', '-b:v: the target average video bitrate.', '2M', '2M: the same target as the first pass.'),
          ...flag('-pass', '-pass: which pass this is.', '2', '2: read the statistics and distribute the bits: more for complex scenes, fewer for simple ones, hitting the average exactly.'),
          ...hvc1(c),
          ...aacAudio(c),
          out(encName(c, '2pass'), 'The encode.'),
        ],
      },
    ],
    when: 'When the size is fixed (a disc, an upload limit, a bandwidth budget) and the quality should be as good as possible within it.',
    look: () => [
      'The size is predictable: bitrate × duration. 2 Mbit/s for 60 s is 15 MB of video.',
      'Run both commands in the same folder: the second reads the log the first one wrote.',
      'CRF is simpler when the size may vary; two-pass is how you hit a size exactly.',
    ],
    view: { to: 'tracks', track: 'video', label: 'Tracks tab: frame sizes' },
    tags: 'two-pass 2pass bitrate target size abr',
  },
  {
    id: 'fix-cbr',
    group: 'fix',
    tool: 'ffmpeg',
    title: 'Constant bitrate for live and broadcast',
    purpose: 'Encode at a steady bitrate that a fixed-rate link can carry, padding with filler data when the picture needs fewer bits.',
    applies: needVideo,
    needs: (c) => [{ encoder: c.encoder === 'x265' ? 'libx265' : 'libx264' }],
    cmd: (c) => [
      tk('ffmpeg', TIP.ffmpeg),
      ...dashI(c),
      ...encoder(c),
      ...flag('-preset', TIP.preset, 'veryfast', 'veryfast: a typical live preset.'),
      ...flag('-b:v', '-b:v: the target bitrate.', '2M', '2M: 2 Mbit/s…'),
      ...flag('-maxrate', '-maxrate: the peak bitrate.', '2M', '2M: …and never more.'),
      ...flag('-bufsize', '-bufsize: the VBV buffer, in bits.', '2M', '2M: one second at the target rate, so the rate cannot vary much even over short spans.'),
      ...(c.encoder === 'x265'
        ? flag('-x265-params', '-x265-params: settings passed straight to x265.', 'strict-cbr=1:hrd=1', 'strict-cbr=1 keeps the rate tightly on target (quality varies instead); hrd=1 writes the buffer parameters into the stream.')
        : flag('-nal-hrd', '-nal-hrd: signal the stream’s buffer model (HRD) in the bitstream.', 'cbr', 'cbr: declare constant bitrate and add filler data whenever a frame needs fewer bits, so the rate stays exactly constant.')),
      tk('-g', '-g: the GOP length in frames.'),
      gopTok(c),
      ...aacAudio(c),
      out(encName(c, 'cbr', '.ts'), '.ts: MPEG-TS, the container of broadcast and live links (x264’s filler data is not allowed in MP4).'),
    ],
    when: 'For broadcast, satellite and live contribution links, which carry a fixed number of bits per second.',
    look: () => [
      '[[probe-bitrate]] on the result shows a flat line.',
      'x264 writes rc=cbr, nal_hrd=cbr and filler=1 into the settings SEI of the first frame, which Vidscope decodes.',
      'Quality now varies with the content: complex scenes look worse. That is the price of a predictable rate.',
    ],
    view: { to: 'tracks', track: 'video', label: 'Tracks tab: frame sizes' },
    tags: 'cbr constant bitrate broadcast live hrd filler',
  },
  {
    id: 'fix-hls',
    group: 'fix',
    tool: 'ffmpeg',
    title: 'Package for HLS',
    purpose: 'Cut the file into short segments with a playlist, as Apple’s HTTP Live Streaming serves them, without re-encoding.',
    applies: (c) => {
      if (!c.video) return needVideo(c);
      const bad = [c.video, c.audio].filter(Boolean).filter((s) => !MP4_OK.has(codecKey(s.track)));
      return bad.length ? `${bad.map((s) => s.track.codecName).join(' and ')} cannot be copied into fragmented MP4 segments: re-encode first ([[fix-gop]]).` : null;
    },
    cmd: (c) => {
      const dir = `${c.stem}-hls`;
      return [
        tk('mkdir', 'mkdir: make the output folder first (ffmpeg does not create folders)…'),
        tk('-p', '-p: …without an error if it already exists.'),
        tk(shq(dir), 'The folder that will hold the playlist and the segments.', { role: 'output' }),
        tk('&&', TIP.and),
        tk('ffmpeg', TIP.ffmpeg),
        ...dashI(c),
        ...avMaps(c, { first: true }),
        ...flag('-c', TIP.c, 'copy', 'copy: no re-encoding, so segments can only start at the key frames already in the file. Regular key frames ([[fix-gop]]) give regular segments.'),
        ...adtsBsf(c),
        ...flag('-f', TIP.f, 'hls', 'hls: the HLS muxer, which writes a playlist (.m3u8) and the media segments.'),
        ...flag('-hls_time', '-hls_time: the target segment length in seconds. A segment ends at the first key frame after it, so it is at least this long.', '4', '4: four seconds.'),
        ...flag('-hls_playlist_type', '-hls_playlist_type: what kind of playlist.', 'vod', 'vod: a finished playlist listing every segment, ending with EXT-X-ENDLIST (event would be a live playlist that only grows).'),
        ...flag('-hls_segment_type', '-hls_segment_type: the segment format.', 'fmp4', 'fmp4: fragmented MP4 (CMAF) segments with an init.mp4 that holds the moov. The default, mpegts, writes .ts segments.'),
        tk('-hls_segment_filename', '-hls_segment_filename: how to name the segments.'),
        tk(shq(`${dir}/seg_%03d.m4s`), '%03d is replaced by the segment number: seg_000.m4s, seg_001.m4s…'),
        out(`${dir}/index.m3u8`, 'The playlist players open.'),
      ];
    },
    when: 'To publish on-demand video for Safari, iOS, smart TVs and the HLS players of the web (hls.js, Shaka, Video.js).',
    look: () => [
      'index.m3u8 lists the segments with their durations (#EXTINF) and points to init.mp4 with #EXT-X-MAP.',
      'Open init.mp4 in Vidscope: a moov with empty sample tables and an mvex box. Open a .m4s segment: moof and mdat pairs, the fragments.',
      'Test it with ffplay on the .m3u8 file, or with any HLS player served over HTTP.',
    ],
    view: { to: 'structure', label: 'Structure tab: the source’s layout' },
    tags: 'hls m3u8 segments streaming apple fmp4 cmaf package',
  },
  {
    id: 'fix-dash',
    group: 'fix',
    tool: 'ffmpeg',
    title: 'Package for DASH',
    purpose: 'Write an MPEG-DASH manifest and segments from the file, without re-encoding.',
    applies: (c) => {
      if (!c.video) return needVideo(c);
      const bad = [c.video, c.audio].filter(Boolean).filter((s) => !MP4_OK.has(codecKey(s.track)));
      return bad.length ? `${bad.map((s) => s.track.codecName).join(' and ')} cannot be copied into MP4 segments: re-encode first.` : null;
    },
    cmd: (c) => {
      const dir = `${c.stem}-dash`;
      return [
        tk('mkdir', 'mkdir: make the output folder first (ffmpeg does not create folders)…'),
        tk('-p', '-p: …without an error if it already exists.'),
        tk(shq(dir), 'The folder that will hold the manifest and the segments.', { role: 'output' }),
        tk('&&', TIP.and),
        tk('ffmpeg', TIP.ffmpeg),
        ...dashI(c),
        ...avMaps(c, { first: true }),
        ...flag('-c', TIP.c, 'copy', 'copy: no re-encoding; segments start at the existing key frames.'),
        ...adtsBsf(c),
        ...flag('-f', TIP.f, 'dash', 'dash: the DASH muxer: an MPD manifest plus an init segment and media segments for each stream.'),
        ...flag('-seg_duration', '-seg_duration: the target segment length in seconds.', '4', '4: four seconds (at least; segments end at a key frame).'),
        ...flag('-use_template', '-use_template: describe the segment names with a pattern ($Number$) instead of listing each one.', '1', '1: on (the default, written out to show it).'),
        ...flag('-use_timeline', '-use_timeline: add a SegmentTimeline with each segment’s exact duration, since segments cut at key frames vary.', '1', '1: on (also the default).'),
        out(`${dir}/manifest.mpd`, 'The manifest players open.'),
      ];
    },
    when: 'For players built on MPEG-DASH: Android’s ExoPlayer, dash.js, Shaka Player, smart TVs.',
    look: () => [
      'manifest.mpd has one AdaptationSet per stream, with the codec strings (avc1.64001E, mp4a.40.2) that Vidscope shows in the Tracks tab.',
      'init-stream0.m4s holds the moov, chunk-stream0-00001.m4s the fragments: the same CMAF structure as HLS in fMP4, which is why one set of segments can serve both.',
    ],
    view: { to: 'tracks', track: 'video', label: 'Tracks tab: codec strings' },
    tags: 'dash mpd segments streaming cmaf package',
  },
  {
    id: 'fix-cut-copy',
    group: 'fix',
    tool: 'ffmpeg',
    title: 'Cut a clip without re-encoding',
    purpose: 'Copy 10 seconds starting at the selected time, without decoding anything: instant, lossless, but it can only start at a key frame.',
    applies: (c) => (c.streams.some(Boolean) ? null : 'This file has no tracks to cut.'),
    cmd: (c) => [
      tk('ffmpeg', TIP.ffmpeg),
      tk('-ss', '-ss before -i: seek in the input, through the index, to the key frame at or before the time. With -c copy nothing is decoded, so the clip starts at that key frame, not exactly at the time.'),
      timeTok(c),
      ...dashI(c),
      ...flag('-t', '-t: the duration of the clip.', '10', '10: ten seconds.'),
      ...flag('-c', TIP.c, 'copy', TIP.copy),
      out(`${c.stem}-cut${c.ext.toLowerCase() || '.mkv'}`, 'The clip, in the same container as the original.'),
    ],
    when: 'For quick trims and excerpts where starting a fraction of a second early does not matter.',
    look: (c) => [
      c.frame && !c.frame.key
        ? `The selected frame is not a key frame: the clip will start at the key frame at ${fmtClock(c.frame.keyBefore.rel)} (sample ${c.frame.keyBefore.i + 1}), ${sec(c.frame.rel - c.frame.keyBefore.rel)} earlier.`
        : c.frame ? 'The selected frame is a key frame, so the clip starts exactly there.' : null,
      'Why the position of -ss matters: before -i, FFmpeg seeks with the index (fast) and a copy starts at the key frame before the time. After -i, it reads and discards everything before the time (slow), and a copy then waits for the next key frame: the video starts later instead.',
      c.format === 'mpegts' ? 'An MPEG-TS has no index: FFmpeg finds the key frame by searching timestamps and can land on the one after the time.' : null,
      'To start exactly at a frame that is not a key frame, re-encode: [[fix-cut-exact]].',
    ],
    view: { to: 'tracks', track: 'video', label: 'Tracks tab: where the key frames are' },
    tags: 'cut trim clip excerpt ss copy keyframe',
  },
  {
    id: 'fix-cut-exact',
    group: 'fix',
    tool: 'ffmpeg',
    title: 'Cut exactly at the selected frame (re-encode)',
    purpose: 'Start the clip exactly at the selected frame by decoding from the key frame before it and encoding again.',
    applies: needVideo,
    needs: (c) => [{ encoder: c.encoder === 'x265' ? 'libx265' : 'libx264' }],
    cmd: (c) => {
      const firstAudio = c.streams.find((s) => s?.spec === 'a:0')?.track;
      const ss = exactSeek(c, [c.streams.find((s) => s?.spec === 'v:0')?.track, firstAudio]);
      if (c.format !== 'mpegts') ss.before[0].tip = `${SS_BEFORE} (Putting -ss after -i for accuracy is advice from before FFmpeg 2.1.)`;
      return [
        tk('ffmpeg', TIP.ffmpeg),
        ...ss.before,
        ...dashI(c),
        ...ss.after,
        ...flag('-t', '-t: the duration of the clip.', '10', '10: ten seconds.'),
        ...avMaps(c, { first: true }),
        ...encoder(c),
        ...crf(c, 18, 22),
        ...hvc1(c),
        ...aacAudio(c),
        out(encName(c, 'cut-exact'), 'The clip.'),
      ];
    },
    when: 'For edits that must start on a precise frame.',
    look: () => [
      'The clip’s first frame is exactly the selected frame, now encoded as a key frame.',
      'Re-encoding costs time and a little quality (hence the high-quality CRF); [[fix-cut-copy]] costs neither but can only cut at key frames.',
    ],
    view: { to: 'frame', track: 'video', label: 'Show the selected frame' },
    tags: 'cut trim exact frame accurate re-encode',
  },
  {
    id: 'fix-loudnorm',
    group: 'fix',
    tool: 'ffmpeg',
    title: 'Normalise loudness (EBU R128)',
    purpose: 'Adjust the audio to a standard loudness, as streaming services and broadcasters require, and copy the video untouched.',
    applies: needAudio,
    cmd: (c) => {
      const ext = c.video ? (MP4_OK.has(codecKey(c.video.track)) ? '.mp4' : '.mkv') : '.m4a';
      return [
        tk('ffmpeg', TIP.ffmpeg),
        ...dashI(c),
        ...(c.video ? [tk('-map', TIP.map), spec(c, c.video, { input: 0 })] : []),
        tk('-map', TIP.map),
        spec(c, c.audio, { input: 0, kind: 'a' }),
        tk('-af', TIP.af),
        ...word([
          { t: 'loudnorm=', tip: 'loudnorm: measures loudness the way people perceive it (EBU R128) and adjusts the gain, compressing gently if needed, to hit a target.' },
          { t: 'I=-16', tip: 'I: integrated (whole-programme) loudness target: -16 LUFS, common for streaming and podcasts. Broadcast uses -23 LUFS in Europe and -24 in the US.' },
          { t: ':TP=-1.5', tip: 'TP: true-peak ceiling, -1.5 dBTP: headroom so that lossy encoding does not clip.' },
          { t: ':LRA=11', tip: 'LRA: target loudness range (the dynamics), in LU.' },
        ]),
        ...flag('-ar', '-ar: audio sample rate of the output.', '48000', '48000: in this dynamic mode loudnorm upsamples to 192 kHz to find the true peaks, and outputs that rate; resample back to 48 kHz.'),
        ...(c.video ? flag('-c:v', TIP.cv, 'copy', 'copy: the video is copied untouched.') : []),
        ...flag('-c:a', TIP.ca, 'aac', TIP.aac),
        ...flag('-b:a', TIP.ba, '192k', '192k: 192 kbit/s, generous, since the audio is re-encoded.'),
        out(`${c.stem}-loudnorm${ext}`, 'The normalised file.'),
      ];
    },
    when: 'Before publishing, so that your audio is neither much louder nor much quieter than everything around it.',
    look: () => [
      'Measure before and after with [[measure-ebur128]]: the integrated loudness should read about -16 LUFS.',
      'This single pass adjusts dynamically. For the most transparent result run loudnorm twice: first with print_format=json added to measure, then with measured_I, measured_TP, measured_LRA and measured_thresh set to the numbers it printed (linear normalisation).',
    ],
    view: { to: 'tracks', track: 'audio', label: 'Tracks tab: the audio track' },
    tags: 'loudness loudnorm ebu r128 lufs normalize audio level',
  },
  {
    id: 'fix-rotate',
    group: 'fix',
    tool: 'ffmpeg',
    title: 'Set the rotation without re-encoding',
    purpose: 'Change the rotation stored in the file’s metadata; the pixels stay as they are and players rotate the picture when they show it.',
    applies: (c) => {
      if (!c.video) return needVideo(c);
      return MP4_OK.has(codecKey(c.video.track)) ? null : `${c.video.track.codecName} cannot be copied into MP4.`;
    },
    cmd: (c) => [
      tk('ffmpeg', TIP.ffmpeg),
      ...flag('-display_rotation', '-display_rotation, before -i: replace the input video’s rotation with this many degrees, counter-clockwise (0 removes a rotation). With -c copy it is written as the track’s display matrix.', '90', '90: a quarter turn counter-clockwise, as for a phone held upright.'),
      ...dashI(c),
      ...avMaps(c),
      ...flag('-c', TIP.c, 'copy', TIP.copy),
      out(`${c.stem}-rotated.mp4`, 'The new MP4; the rotation goes into the matrix of its tkhd box.'),
    ],
    when: 'When a phone video plays sideways, or a rotation flag is wrong: fixing the metadata is instant and lossless.',
    look: (c) => {
      const rot = (c.video?.track?.props ?? []).find(([k]) => k === 'rotation')?.[1];
      return [
        rot ? `This track currently says: ${rot}.` : 'This track has no rotation now.',
        'Vidscope shows the new matrix in the tkhd box, and “rotation 90° counter-clockwise” in the Tracks tab.',
        'Players that ignore the matrix still show the video unrotated. To rotate the pixels themselves, re-encode: ffmpeg applies the rotation automatically when it re-encodes such a file.',
      ];
    },
    view: { to: 'tracks', track: 'video', label: 'Tracks tab: the rotation' },
    tags: 'rotate rotation display matrix portrait sideways',
  },
  {
    id: 'fix-subs',
    group: 'fix',
    tool: 'ffmpeg',
    title: 'Extract the subtitles',
    purpose: 'Save a subtitle track as a SubRip (.srt) text file.',
    applies: (c) => {
      if (!c.subtitle) return 'This file has no subtitle track.';
      const k = codecKey(c.subtitle.track);
      return ['srt', 'ass', 'webvtt', 'mov_text'].includes(k) ? null : `${c.subtitle.track.codecName} may be image-based; only text subtitles can become SRT.`;
    },
    cmd: (c) => [
      tk('ffmpeg', TIP.ffmpeg),
      ...dashI(c),
      tk('-map', TIP.map),
      spec(c, c.subtitle, { input: 0, kind: 's' }),
      out(`${c.stem}.srt`, '.srt: SubRip text. FFmpeg converts from the stored format (mov_text in MP4, SRT or ASS in Matroska, WebVTT) to SRT. Image-based subtitles (DVD, Blu-ray, DVB) cannot become text.'),
    ],
    when: 'To edit, translate or upload subtitles separately, or to check their timing.',
    look: () => [
      'Each cue: a number, start --> end, and the text.',
      'The times come from the subtitle packets’ timestamps, which Vidscope lists for the subtitle track in the Tracks tab.',
      'Styling is lost when converting ASS (fonts, positions) to SRT; keep .ass as the output name to preserve it.',
    ],
    view: { to: 'tracks', track: 'subtitle', label: 'Tracks tab: the subtitle track' },
    tags: 'subtitles srt extract captions',
  },
  {
    id: 'fix-strip',
    group: 'fix',
    tool: 'ffmpeg',
    title: 'Remove subtitles, data and metadata',
    purpose: 'Keep only the video and audio, without the file’s tags, chapters, subtitles or data tracks.',
    applies: (c) => (c.streams.some((s) => s && (s.type === 'v' || s.type === 'a')) ? null : 'This file has no video or audio track to keep.'),
    cmd: (c) => [
      tk('ffmpeg', TIP.ffmpeg),
      ...dashI(c),
      ...avMaps(c),
      ...flag('-c', TIP.c, 'copy', TIP.copy),
      ...flag('-map_metadata', '-map_metadata: which input’s metadata to copy.', '-1', '-1: none: no title, comment, creation time or encoder tags.'),
      ...flag('-map_chapters', '-map_chapters: which input’s chapters to copy.', '-1', '-1: none.'),
      ...flag('-fflags', '-fflags: muxer flags.', '+bitexact', '+bitexact: do not write FFmpeg’s own encoder tag (Lavf…) or anything else that depends on the FFmpeg version.'),
      out(`${c.stem}-clean${c.ext.toLowerCase() || '.mkv'}`, 'The cleaned file, in the same container.'),
    ],
    when: 'Before sharing a file whose tags may reveal more than you want (camera, location, software), or to drop tracks a player chokes on.',
    look: () => [
      'ffprobe -show_format on the result lists only the tags the container always has, such as major_brand.',
      'In Vidscope, the udta/meta/ilst boxes (MP4) or the Tags elements (Matroska) are gone.',
      'Each track’s handler name and language stay: the muxer writes those itself.',
    ],
    view: { to: 'structure', label: 'Structure tab: where the metadata was' },
    tags: 'strip metadata tags privacy remove subtitles chapters',
  },
  {
    id: 'fix-concat',
    group: 'fix',
    tool: 'ffmpeg',
    title: 'Join files (concat demuxer)',
    purpose: 'Join files one after the other into one, without re-encoding: here the open file twice, as an example.',
    applies: (c) => (c.streams.some(Boolean) ? null : 'This file has no tracks to join.'),
    cmd: (c) => {
      const list = `${c.stem}-list.txt`;
      return [
        {
          note: '1. Write the list of files to join, one per line:',
          tokens: [
            tk('printf', 'printf: print text; here, each following argument on its own line.'),
            tk(`'%s\\n'`, '%s\\n: the format: the argument, then a new line.'),
            tk(concatLine(c.path), `A line of the list: file, then the path in single quotes. ${c.path.known ? 'The full path; -safe 0 below allows it.' : 'A relative path is read from the folder of the list file.'}${c.path.kind === 'home' ? ' $HOME stands for your home folder (~ is not expanded inside quotes).' : ''} Here the open file, as an example: list your own files instead.`, { ctx: true }),
            tk(concatLine(c.path), 'The same file again, so the result is twice as long.', { ctx: true }),
            tk('>', '>: write the output into a file instead of the screen.'),
            tk(shq(list), 'The list file, in the current folder.', { role: 'output' }),
          ],
        },
        {
          note: '2. Join them:',
          tokens: [
            tk('ffmpeg', TIP.ffmpeg),
            ...flag('-f', TIP.f, 'concat', 'concat: the concat demuxer reads a list of files and plays them one after another as a single input.'),
            ...flag('-safe', '-safe: in safe mode (the default) the list may only contain simple relative names.', '0', '0: allow absolute paths and any characters.'),
            tk('-i', TIP.i),
            tk(shq(local(list)), 'The list file written by step 1.'),
            ...flag('-c', TIP.c, 'copy', 'copy: nothing is re-encoded, so every file must have the same codecs and settings (size, frame rate, sample rate).'),
            out(`${c.stem}-joined${c.ext.toLowerCase() || '.mkv'}`, 'The joined file.'),
          ],
        },
      ];
    },
    when: 'To join the parts of a recording, or clips cut from the same encode.',
    look: () => [
      'The result lasts as long as the parts together; the timestamps continue across the joins.',
      'Files with different codecs or sizes need the concat filter instead, which re-encodes: -filter_complex "[0:v][0:a][1:v][1:a]concat=n=2:v=1:a=1".',
      'In Vidscope the joined file has the same tracks with twice as many frames.',
    ],
    view: { to: 'tracks', track: 'stream', label: 'Tracks tab: frame counts' },
    tags: 'concat join merge append list',
  },
  {
    id: 'fix-audio',
    group: 'fix',
    tool: 'ffmpeg',
    title: 'Extract the audio without re-encoding',
    purpose: 'Copy one audio track into a file of its own, in the container that matches its codec.',
    applies: needAudio,
    cmd: (c) => {
      const ext = audioExt(c.audio?.track);
      return [
        tk('ffmpeg', TIP.ffmpeg),
        ...dashI(c),
        tk('-map', TIP.map),
        spec(c, c.audio, { input: 0, kind: 'a' }),
        ...flag('-c', TIP.c, 'copy', TIP.copy),
        out(`${c.stem}-audio${ext}`, `${ext}: the usual file type for ${c.audio?.track.codecName ?? 'this codec'}, so the frames can be copied as they are.`),
      ];
    },
    when: 'To get the soundtrack, a podcast or a commentary track out of a video, bit for bit.',
    look: () => [
      'Open the new file in Vidscope and compare the frame sizes with the original track: they are identical.',
      'An AAC track goes into .m4a (an MP4 audio file); a raw .aac would get an ADTS header before every frame instead.',
    ],
    view: { to: 'tracks', track: 'audio', label: 'Tracks tab: the audio track' },
    tags: 'extract audio soundtrack m4a copy',
  },
  {
    id: 'fix-hvc1',
    group: 'fix',
    tool: 'ffmpeg',
    title: 'Retag HEVC as hvc1 for Apple players',
    purpose: 'Rewrite an HEVC MP4 with the hvc1 sample entry that QuickTime, Safari and iOS require, without re-encoding.',
    applies: (c) => (codecKey(c.video?.track) === 'hevc' ? null : 'Only for HEVC video; this file’s video is not HEVC.'),
    cmd: (c) => [
      tk('ffmpeg', TIP.ffmpeg),
      ...dashI(c),
      ...avMaps(c),
      ...flag('-c', TIP.c, 'copy', TIP.copy),
      ...flag('-tag:v', TIP.tagv, 'hvc1', 'hvc1: the parameter sets (VPS, SPS, PPS) live only in the hvcC box. FFmpeg’s default, hev1, also allows them inside the frames; Apple’s players refuse hev1.'),
      out(`${c.stem}-hvc1.mp4`, 'The retagged MP4.'),
    ],
    when: 'When an HEVC file plays everywhere except on Apple devices.',
    look: () => [
      'In Vidscope, the stsd box of the new file holds an hvc1 sample entry, and File insights no longer warns about hev1.',
      'It is only a label: the frames are unchanged, so it works when they carry no parameter sets of their own, as with FFmpeg’s and most encoders’ output.',
    ],
    view: { to: 'insights', label: 'File insights: the hev1 warning' },
    tags: 'hevc hvc1 hev1 apple quicktime safari ios tag',
  },
  {
    id: 'fix-annexb',
    group: 'fix',
    tool: 'ffmpeg',
    title: 'Extract the raw video bitstream',
    purpose: 'Write the video without any container: for H.264 and HEVC, as an Annex B stream with start codes.',
    applies: (c) => {
      if (!c.video) return needVideo(c);
      return ['h264', 'hevc', 'av1', 'vp9', 'vp8', 'mpeg2', 'mpeg4'].includes(codecKey(c.video.track)) ? null : `Vidscope does not know a raw format for ${c.video.track.codecName}.`;
    },
    cmd: (c) => {
      const k = codecKey(c.video?.track) ?? 'h264';
      const raw = {
        h264: ['h264_mp4toannexb', 'h264', '.h264'],
        hevc: ['hevc_mp4toannexb', 'hevc', '.hevc'],
        av1: [null, 'obu', '.obu'],
        vp9: [null, 'ivf', '.ivf'],
        vp8: [null, 'ivf', '.ivf'],
        mpeg2: [null, 'mpeg2video', '.m2v'],
        mpeg4: [null, 'm4v', '.m4v'],
      }[k] ?? ['h264_mp4toannexb', 'h264', '.h264'];
      return [
        tk('ffmpeg', TIP.ffmpeg),
        ...dashI(c),
        tk('-map', TIP.map),
        spec(c, c.video, { input: 0 }),
        ...flag('-c', TIP.c, 'copy', TIP.copy),
        ...(raw[0] ? flag('-bsf:v', '-bsf:v: a bitstream filter for the video: it rewrites packets without decoding them.', raw[0], `${raw[0]}: replace MP4’s 4-byte length prefixes with 00 00 00 01 start codes and put the parameter sets from the codec configuration box in front of each key frame (Annex B framing). ffmpeg would add it by itself for this output; it is written out to show it.`) : []),
        ...flag('-f', TIP.f, raw[1], { h264: 'h264: raw H.264, no container at all.', hevc: 'hevc: raw HEVC, no container.', obu: 'obu: AV1 as a plain sequence of OBUs (the “low overhead” format).', ivf: 'ivf: the minimal IVF container (a 32-byte header, then each frame with its size and timestamp).', mpeg2video: 'mpeg2video: a raw MPEG-2 video elementary stream.', m4v: 'm4v: a raw MPEG-4 Part 2 elementary stream.' }[raw[1]]),
        out(`${c.stem}${raw[2]}`, 'The raw bitstream.'),
      ];
    },
    when: 'To feed a reference decoder or an analyser, or to see the codec’s own framing without a container around it.',
    look: (c) => {
      const k = codecKey(c.video?.track);
      return [
        k === 'h264' || k === 'hevc' ? 'Open the result in Vidscope: it is identified as a raw stream, and the hex view shows start codes (00 00 00 01) where the MP4 had lengths.' : 'Open the result in Vidscope: it shows the file as bytes with the format identified.',
        k === 'vp9' || k === 'vp8' ? 'IVF keeps a timestamp for every frame.' : 'A raw stream has no timestamps: when reading it back, give the frame rate (-framerate 25 before -i).',
      ];
    },
    view: { to: 'frame', track: 'video', label: 'Show a frame’s NAL units' },
    tags: 'raw bitstream annex b h264_mp4toannexb bsf elementary stream obu ivf',
  },

  // ================================================================ measure
  {
    id: 'measure-quality',
    group: 'measure',
    tool: 'ffmpeg',
    title: 'PSNR and SSIM: encode against original',
    purpose: 'Compare an encode with its source, frame by frame, and print two classic quality scores.',
    applies: needVideo,
    uses: 'fix-crf',
    cmd: (c) => [
      tk('ffmpeg', TIP.ffmpeg),
      tk('-i', TIP.i),
      tk(shq(local(crfName(c))), `${crfName(c)}: the encode made by “Quality-based encode (CRF)” in the Fix group (any encode of this file at the same size works). First input: the one being judged.`, { role: 'input2' }),
      ...dashI(c),
      tk('-lavfi', '-lavfi: a filter graph with several inputs (same as -filter_complex). [0:v] is the first input’s video, [1:v] the second’s.'),
      ...word([
        { t: '[0:v]settb=AVTB,setpts=PTS-STARTPTS[main]', tip: 'The encode’s video, with a common time base and timestamps starting at 0, so that frames are paired by time even if the two files start differently.' },
        { t: ';[1:v]settb=AVTB,setpts=PTS-STARTPTS,split[ref1][ref2]', tip: 'The original, the same way, split in two: one copy per metric.' },
        { t: ';[main][ref1]psnr[main2]', tip: 'psnr: peak signal-to-noise ratio in decibels, per plane (Y, U, V) and averaged. It passes the first input through, to the next filter.' },
        { t: ';[main2][ref2]ssim', tip: 'ssim: structural similarity, from 0 to 1 (identical).' },
      ], { role: 'graph' }),
      ...flag('-f', TIP.f, 'null', TIP.null),
      tk('-', TIP.dash),
    ],
    when: 'To compare encoder settings with numbers: two encodes of the same source, the one with higher scores kept more detail.',
    look: () => [
      'PSNR average above 40 dB is excellent, 35–40 good, below 30 visibly degraded (rules of thumb for 8-bit video).',
      'SSIM All close to 1 means little visible difference; below about 0.95 artefacts usually show (again a rule of thumb).',
      'Both compare pixels; they miss what viewers notice (like lost film grain). [[measure-vmaf]] was trained on viewers’ opinions.',
      'Add :stats_file=psnr.log after psnr to get one line per frame and find the worst moments.',
    ],
    output: {
      title: 'Example output (a CRF 30 encode of the sample)',
      lines: [
        '[Parsed_ssim_6 @ 0x…] SSIM Y:0.979708 (16.926741) U:0.981358 (17.295112) V:0.988217 (19.287468) All:0.981401 (17.305144)',
        '[Parsed_psnr_5 @ 0x…] PSNR y:38.224663 u:37.029399 v:36.979631 average:37.778732 min:36.617210 max:39.534263',
      ],
      marks: [
        ['All:0.981401', 'Overall SSIM: close to 1.'],
        ['(17.305144)', 'The same SSIM expressed in decibels.'],
        ['average:37.778732', 'Average PSNR over all frames: good.'],
        ['min:36.617210', 'The worst frame.'],
      ],
    },
    view: { to: 'tracks', track: 'video', label: 'Tracks tab: the original video' },
    tags: 'psnr ssim quality metric compare encode',
  },
  {
    id: 'measure-vmaf',
    group: 'measure',
    tool: 'ffmpeg',
    title: 'VMAF: encode against original',
    purpose: 'Score an encode from 0 to 100 with Netflix’s VMAF, the metric streaming services use to build their bitrate ladders.',
    applies: needVideo,
    uses: 'fix-crf',
    needs: [{ filter: 'libvmaf', build: '--enable-libvmaf', why: 'The libvmaf filter needs FFmpeg built with Netflix’s VMAF library.' }],
    cmd: (c) => [
      tk('ffmpeg', TIP.ffmpeg),
      tk('-i', TIP.i),
      tk(shq(local(crfName(c))), `${crfName(c)}: the encode made by “Quality-based encode (CRF)”. libvmaf takes the distorted video first…`, { role: 'input2' }),
      ...dashI(c),
      tk('-lavfi', '-lavfi: a filter graph with several inputs (same as -filter_complex).'),
      ...word([
        { t: '[0:v]settb=AVTB,setpts=PTS-STARTPTS[main]', tip: 'The encode, with timestamps starting at 0.' },
        { t: ';[1:v]settb=AVTB,setpts=PTS-STARTPTS[ref]', tip: '…and the reference (the original) second.' },
        { t: ';[main][ref]libvmaf=', tip: 'libvmaf: compute VMAF for each frame and print the pooled score (needs FFmpeg built with --enable-libvmaf).' },
        { t: 'log_fmt=json', tip: 'log_fmt: write the per-frame scores as JSON…' },
        { t: `:log_path=${filterValue(local(`${c.stem}-vmaf.json`))}`, tip: `…to ${c.stem}-vmaf.json in the current folder.` },
      ], { role: 'graph' }),
      ...flag('-f', TIP.f, 'null', TIP.null),
      tk('-', TIP.dash),
    ],
    when: 'To decide how low a bitrate can go before viewers notice, or to compare encoders fairly.',
    look: () => [
      'VMAF score: about 93 and above is usually indistinguishable from the source when watched on a TV; around 6 points is one just-noticeable difference.',
      'The default model (vmaf_v0.6.1) assumes 1080p on a TV: for smaller encodes, scale both inputs to 1920×1080 first (add ,scale=1920:1080 after each setpts).',
      'The JSON log has a score per frame: the lowest ones show where the encode struggles.',
      'Check that this FFmpeg has it: ffmpeg -hide_banner -filters | grep vmaf.',
    ],
    view: { to: 'tracks', track: 'video', label: 'Tracks tab: the original video' },
    tags: 'vmaf quality netflix metric ladder',
  },
  {
    id: 'measure-ebur128',
    group: 'measure',
    tool: 'ffmpeg',
    title: 'Loudness (EBU R128)',
    purpose: 'Measure the programme loudness, loudness range and true peak of an audio track, as broadcasters and streaming services specify them.',
    applies: needAudio,
    cmd: (c) => [
      tk('ffmpeg', TIP.ffmpeg),
      tk('-nostats', '-nostats: no progress line, so the summary is easy to read.'),
      ...dashI(c),
      tk('-map', TIP.map),
      spec(c, c.audio, { input: 0, kind: 'a' }),
      tk('-af', TIP.af),
      ...word([
        { t: 'ebur128=', tip: 'ebur128: the EBU R128 loudness meter.' },
        { t: 'peak=true', tip: 'peak=true: also measure the true peak, between the samples, where a digital-to-analogue converter would reconstruct it.' },
        { t: ':framelog=quiet', tip: 'framelog=quiet: skip the measurement printed every 100 ms and keep only the summary.' },
      ], { role: 'graph' }),
      ...flag('-f', TIP.f, 'null', TIP.null),
      tk('-', TIP.dash),
    ],
    when: 'Before delivery, to check the audio against a loudness specification.',
    look: () => [
      'I (integrated loudness) is the value to compare with a target: -23 LUFS for EBU R128 broadcast, -24 LKFS for ATSC A/85 in the US, about -14 to -16 LUFS for streaming and web video.',
      'LRA (loudness range) is the dynamics in LU: 5 or less for pop music, 15 or more for a film.',
      'A true peak above -1 dBTP risks clipping once the audio goes through a lossy encoder.',
      '[[fix-loudnorm]] brings a file to a target.',
    ],
    output: {
      title: 'Example output',
      lines: [
        '[Parsed_ebur128_0 @ 0x…] Summary:',
        '  Integrated loudness:',
        '    I:         -21.8 LUFS',
        '    Threshold: -31.8 LUFS',
        '  Loudness range:',
        '    LRA:         0.0 LU',
        '  True peak:',
        '    Peak:      -16.3 dBFS',
      ],
      marks: [
        ['I:         -21.8 LUFS', 'Integrated loudness of the whole file.'],
        ['Threshold: -31.8 LUFS', 'Quieter passages below this gate are left out of the average.'],
        ['LRA:         0.0 LU', 'No dynamics at all: the sample is a steady sine tone.'],
        ['Peak:      -16.3 dBFS', 'The highest true peak.'],
      ],
    },
    view: { to: 'tracks', track: 'audio', label: 'Tracks tab: the audio track' },
    tags: 'loudness ebur128 lufs lra true peak audio level',
  },
  {
    id: 'measure-idet',
    group: 'measure',
    tool: 'ffmpeg',
    title: 'Interlaced or progressive?',
    purpose: 'Analyse the pictures to guess whether the video was shot interlaced, and in which field order.',
    applies: needVideo,
    cmd: (c) => [
      tk('ffmpeg', TIP.ffmpeg),
      tk('-nostats', '-nostats: no progress line.'),
      ...dashI(c),
      tk('-map', TIP.map),
      spec(c, c.video, { input: 0 }),
      tk('-vf', TIP.vf),
      tk('idet', 'idet: compares each frame’s two fields (the odd and the even lines) and counts how many frames look interlaced top field first (TFF), bottom field first (BFF) or progressive.', { role: 'graph' }),
      ...flag('-frames:v', '-frames:v: stop after this many frames.', '500', '500: enough for a verdict (20 s at 25 fps).'),
      ...flag('-f', TIP.f, 'null', TIP.null),
      tk('-', TIP.dash),
    ],
    when: 'Before encoding for the web: interlaced material must be deinterlaced (with the yadif or bwdif filter) first.',
    look: () => [
      'Read the Multi frame detection line: large TFF or BFF counts mean interlaced, a large Progressive count progressive.',
      'It is a statistical guess from the pixels: fine detail and fast motion can fool it. Check what the stream declares too: ffprobe’s field_order, and in Vidscope the H.264 SPS, where frame_mbs_only_flag = 1 means progressive only.',
    ],
    output: {
      title: 'Example output (the lines to read)',
      lines: [
        '[Parsed_idet_0 @ 0x…] Repeated Fields: Neither:   100 Top:     0 Bottom:     0',
        '[Parsed_idet_0 @ 0x…] Single frame detection: TFF:    45 BFF:    40 Progressive:    15 Undetermined:     0',
        '[Parsed_idet_0 @ 0x…] Multi frame detection: TFF:    45 BFF:    40 Progressive:    15 Undetermined:     0',
      ],
      marks: [
        ['Repeated Fields', 'Fields repeated by 3:2 pulldown (film converted to 29.97 fps).'],
        ['Multi frame detection', 'The more reliable verdict, over several frames.'],
        ['TFF:    45 BFF:    40', 'Here the busy synthetic test pattern fools idet: the stream itself says progressive.'],
      ],
    },
    view: { to: 'frame', track: 'video', label: 'Show a frame’s SPS' },
    tags: 'interlace deinterlace idet field order tff bff progressive',
  },
  {
    id: 'measure-black',
    group: 'measure',
    tool: 'ffmpeg',
    title: 'Find black frames',
    purpose: 'Log every stretch of (almost) black picture: fades, slates, ad breaks, missing video.',
    applies: needVideo,
    cmd: (c) => [
      tk('ffmpeg', TIP.ffmpeg),
      tk('-nostats', '-nostats: no progress line.'),
      ...dashI(c),
      tk('-map', TIP.map),
      spec(c, c.video, { input: 0 }),
      tk('-vf', TIP.vf),
      ...word([
        { t: 'blackdetect=', tip: 'blackdetect: logs each black stretch with its start, end and duration.' },
        { t: 'd=0.5', tip: 'd: at least 0.5 seconds long.' },
        { t: ':pix_th=0.10', tip: 'pix_th: a pixel counts as black below 10 % brightness.' },
      ], { role: 'graph' }),
      ...flag('-f', TIP.f, 'null', TIP.null),
      tk('-', TIP.dash),
    ],
    when: 'To find where to cut, where ads were, or whether a transfer lost its picture.',
    look: () => [
      'Lines black_start:… black_end:… black_duration:… in seconds.',
      'No such line: no black stretch that long.',
    ],
    output: {
      title: 'Example line',
      lines: ['[blackdetect @ 0x…] black_start:0 black_end:2 black_duration:2'],
      marks: [['black_start:0 black_end:2 black_duration:2', 'Black from 0 to 2 seconds.']],
    },
    view: { to: 'tracks', track: 'video', label: 'Tracks tab: the video track' },
    tags: 'black detect blackdetect fade slate',
  },
  {
    id: 'measure-silence',
    group: 'measure',
    tool: 'ffmpeg',
    title: 'Find silence',
    purpose: 'Log every stretch of silence in an audio track.',
    applies: needAudio,
    cmd: (c) => [
      tk('ffmpeg', TIP.ffmpeg),
      tk('-nostats', '-nostats: no progress line.'),
      ...dashI(c),
      tk('-map', TIP.map),
      spec(c, c.audio, { input: 0, kind: 'a' }),
      tk('-af', TIP.af),
      ...word([
        { t: 'silencedetect=', tip: 'silencedetect: logs where each silence starts and ends.' },
        { t: 'noise=-50dB', tip: 'noise: anything quieter than -50 dB counts as silence.' },
        { t: ':d=0.5', tip: 'd: at least 0.5 seconds long.' },
      ], { role: 'graph' }),
      ...flag('-f', TIP.f, 'null', TIP.null),
      tk('-', TIP.dash),
    ],
    when: 'To find gaps, dropouts or missing audio, or where a programme really starts and ends.',
    look: () => [
      'Lines silence_start: …, then silence_end: … | silence_duration: …, in seconds.',
      'No such line: no silence that long.',
    ],
    output: {
      title: 'Example lines',
      lines: ['[silencedetect @ 0x…] silence_start: 0', '[silencedetect @ 0x…] silence_end: 1.000021 | silence_duration: 1.000021'],
      marks: [['silence_duration: 1.000021', 'One second of silence.']],
    },
    view: { to: 'tracks', track: 'audio', label: 'Tracks tab: the audio track' },
    tags: 'silence detect silencedetect gap dropout',
  },
  {
    id: 'measure-crop',
    group: 'measure',
    tool: 'ffmpeg',
    title: 'Detect black bars (crop)',
    purpose: 'Find the part of the picture that is not black borders, and get a crop to remove them.',
    applies: needVideo,
    cmd: (c) => [
      tk('ffmpeg', TIP.ffmpeg),
      tk('-nostats', '-nostats: no progress line.'),
      ...dashI(c),
      tk('-map', TIP.map),
      spec(c, c.video, { input: 0 }),
      tk('-vf', TIP.vf),
      ...word([
        { t: 'cropdetect=', tip: 'cropdetect: finds the area that is not (almost) black and suggests a crop for it.' },
        { t: 'round=2', tip: 'round: make the sizes multiples of 2. The default, 16, would suggest cutting 8 lines off a 360-line picture that has no bars at all.' },
      ], { role: 'graph' }),
      ...flag('-frames:v', '-frames:v: stop after this many frames.', '250', '250: ten seconds at 25 fps.'),
      ...flag('-f', TIP.f, 'null', TIP.null),
      tk('-', TIP.dash),
    ],
    when: 'Before encoding letterboxed or pillarboxed material: black bars cost bits and look wrong on other screens.',
    look: () => [
      'Every line ends with crop=w:h:x:y; the last lines, after the picture has settled, are the most reliable.',
      'Apply it when re-encoding with -vf crop=w:h:x:y.',
    ],
    output: {
      title: 'Example line',
      lines: ['[Parsed_cropdetect_0 @ 0x…] x1:0 x2:639 y1:0 y2:359 w:640 h:360 x:0 y:0 pts:15360 t:1.200000 limit:0.094118 crop=640:360:0:0'],
      marks: [['crop=640:360:0:0', 'The whole 640×360 picture: no black bars.']],
    },
    view: { to: 'tracks', track: 'video', label: 'Tracks tab: the picture size' },
    tags: 'crop cropdetect letterbox black bars',
  },
  {
    id: 'measure-decode',
    group: 'measure',
    tool: 'ffmpeg',
    title: 'Decode everything and report errors',
    purpose: 'Decode every frame of the file and print only the errors: the most thorough integrity check FFmpeg offers.',
    cmd: (c) => [
      tk('ffmpeg', TIP.ffmpeg),
      ...flag('-v', TIP.v, 'error', 'error: print only errors, so a clean file prints nothing at all.'),
      ...dashI(c),
      ...flag('-f', TIP.f, 'null', TIP.null),
      tk('-', TIP.dash),
    ],
    when: 'After a transfer, a recording or a conversion, to be sure every frame decodes.',
    look: () => [
      'No output means the video and audio streams decoded without a single error.',
      'Typical errors: “error while decoding MB x y” (damaged picture data), “Invalid NAL unit size” or “corrupt input packet” (damaged container), “non monotonically increasing dts” (broken timestamps).',
      'Compare with Vidscope’s File insights (Integrity): CRC errors, continuity-counter gaps in MPEG-TS, sample tables pointing outside the file.',
      'Add -xerror to stop at the first error with a non-zero exit status (for scripts).',
    ],
    view: { to: 'insights', label: 'File insights: integrity' },
    tags: 'integrity check errors corrupt decode validate',
  },
  {
    id: 'measure-signalstats',
    group: 'measure',
    tool: 'ffprobe',
    title: 'Brightness and colour statistics per frame',
    purpose: 'Print the lowest, average and highest brightness, the saturation and the share of out-of-range pixels for every frame.',
    applies: needVideo,
    cmd: (c) => [
      tk('ffprobe', TIP.ffprobe),
      ...flag('-v', TIP.v, 'error', TIP.error),
      ...flag('-f', TIP.f, 'lavfi', TIP.lavfi),
      ...word([
        { t: 'movie=', tip: TIP.movie },
        { t: graphPath(c.path), raw: true, tip: 'The open file, escaped for the filter graph ($HOME stands for ~).' },
        { t: ',signalstats=stat=brng', tip: 'signalstats: measure every frame and attach the results to it as tags; stat=brng also counts the pixels outside the broadcast range.' },
      ], { role: 'input' }),
      tk('-show_entries', TIP.showEntries),
      ...word([
        { t: 'frame=pts_time', tip: 'frame: the time of each frame…' },
        { t: ':frame_tags=', tip: '…and these of its tags:' },
        { t: 'lavfi.signalstats.YMIN', tip: 'YMIN: the lowest luma value of the frame (0–255 for 8-bit).' },
        { t: ',lavfi.signalstats.YAVG', tip: 'YAVG: the average luma: the overall brightness.' },
        { t: ',lavfi.signalstats.YMAX', tip: 'YMAX: the highest luma value.' },
        { t: ',lavfi.signalstats.SATAVG', tip: 'SATAVG: the average saturation.' },
        { t: ',lavfi.signalstats.BRNG', tip: 'BRNG: the share of pixels outside the broadcast range (0.02 = 2 %).' },
      ]),
      ...flag('-of', TIP.of, 'csv=p=0', TIP.csv),
    ],
    when: 'For quality control of masters and archive transfers: levels, flashes, black sections, illegal values.',
    look: () => [
      'Columns: time, YMIN, YAVG, YMAX, SATAVG, BRNG.',
      '8-bit video in limited range should stay between 16 and 235: YMIN near 0 or YMAX near 255 means values TVs clip, and BRNG counts them.',
      'A sudden jump in YAVG marks a cut or a flash; YAVG stuck near 16, a black section.',
      '[[play-brng]] shows the out-of-range pixels on the picture.',
    ],
    output: {
      title: 'Example output',
      lines: ['0.000000,19,125.074,225,113.082,0.0221701,', '0.040000,7,125.165,221,112.858,0.0211415', '0.080000,0,125.282,221,112.705,0.0207552'],
      marks: [
        ['0.0221701', 'BRNG: 2.2 % of the pixels are outside 16–235.'],
        ['0.080000,0,', 'YMIN 0: some pixels are fully black, below the legal 16.'],
      ],
    },
    view: { to: 'frame', track: 'video', label: 'Show the selected frame' },
    tags: 'signalstats levels qc ymin ymax brng saturation qctools',
  },
];

/** The catalogue entry with this id. */
export function commandById(id) {
  return COMMANDS.find((e) => e.id === id) ?? null;
}

// ------------------------------------------------------------------ rendering

/**
 * An entry filled in for a context: { lines: [{ note, tool, tokens, text }], text, look, reason,
 * needs }. `reason` says why the command does not apply to this file (null when it does).
 */
export function renderEntry(e, c) {
  const raw = e.cmd(c);
  const steps = raw.length && raw[0] && raw[0].tokens ? raw : [{ tokens: raw }];
  const lines = steps.map((s) => {
    const tokens = s.tokens.flat(Infinity).filter(Boolean);
    return { note: s.note ?? null, tool: s.tool ?? e.tool, tokens, text: commandText(tokens) };
  });
  const look = (typeof e.look === 'function' ? e.look(c) : e.look ?? []).filter(Boolean);
  const needs = typeof e.needs === 'function' ? e.needs(c) : e.needs ?? [];
  return { entry: e, lines, text: lines.map((l) => l.text).join('\n'), look, reason: e.applies?.(c) ?? null, needs };
}

/** Replace [[id]] references with the referenced command's title (for plain text). */
export function refTitles(text) {
  return String(text).replace(/\[\[([\w-]+)\]\]/g, (m, id) => commandById(id)?.title ?? id);
}

/**
 * What the context filled in, for the line above the commands:
 * [{ label, value, tip, missing? }].
 */
export function contextSummary(c) {
  const items = [];
  items.push(c.path.known
    ? { label: 'file', value: c.name, tip: `The open file’s full path, from the Vidscope server:\n${c.input}` }
    : { label: 'file', value: `${c.name} (folder unknown)`, tip: 'Only the name is known (the file was opened from this computer, not through the Vidscope server): run the commands in the folder that holds it.', missing: true });
  if (c.stream) {
    const from = c.streamFrom === 'frame' ? 'the track of the selected frame' : c.streamFrom === 'selected' ? 'the selected track' : 'nothing selected: the first video track';
    items.push({ label: 'stream', value: `${c.stream.spec} = ${c.stream.label}`, tip: `Commands that work on one stream use ${c.stream.spec} (${from}). Select another track in the Tracks tab to change it.` });
  }
  if (c.frame) {
    items.push({ label: 'time', value: `${c.time} = frame ${c.frame.i + 1}${c.frame.key ? ' (key frame)' : ''}`, tip: `The selected frame: frame ${c.frame.i + 1} of ${c.frame.track.label} in decoding order (the order of the Tracks list), shown ${c.frame.rel.toFixed(3)} s after the start of the file. Commands with -ss start there.` });
  } else {
    items.push({ label: 'time', value: 'select a frame', tip: 'Select a frame (a row of the frame list in the Tracks tab, or a byte inside a frame in the hex view) to fill in -ss.', missing: true });
  }
  if (c.fps) items.push({ label: 'frame rate', value: `${Number(c.fps.toFixed(3))} fps → -g ${c.gop}`, tip: `${c.gop} frames make a 2-second GOP at this frame rate.` });
  return items;
}
