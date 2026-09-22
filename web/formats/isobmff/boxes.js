// ISO-BMFF box definitions: what each box is, and how to read its fields.
//
// A definition has:
//   name, cat (colour family), spec (mp4ra specification name), sec (section),
//   desc (one plain sentence), more (the details), full (FullBox: version+flags),
//   flags ({bit: name}), container (child boxes follow the fields),
//   parse(r, node, ctx) reading the body with a FieldReader.

import { fmtInt, fmtNum, fmtDuration, fmtDate, date1904, hex, fourcc as fourccOf, HEX2 } from '../../core/util.js';
import { brandInfo, handlerInfo, reg } from './registry.js';

// ------------------------------------------------------------------ helpers

export function durationDisplay(ts) {
  return (v) => {
    if (v === 0xffffffff || v >= 2 ** 64 - 1) return `${fmtInt(v)} (all ones: duration unknown)`;
    if (!ts) return fmtInt(v);
    return `${fmtInt(v)} → ${fmtDuration(v / ts)}`;
  };
}

export function durationNote(v, ts) {
  if (!ts || v === 0xffffffff) return undefined;
  return `${fmtInt(v)} units / ${fmtInt(ts)} units-per-second = ${fmtNum(v / ts, 3)} s → ${fmtDuration(v / ts)}`;
}

function timeField(r, name, big, ts, o = {}) {
  const f = big ? r.u64(name, o) : r.u32(name, o);
  const rec = r.out[r.out.length - 1];
  rec.display = durationDisplay(ts)(f);
  const note = durationNote(f, ts);
  if (note) rec.note = note;
  return f;
}

function dateField(r, name, big, o = {}) {
  const v = big ? r.u64(name, o) : r.u32(name, o);
  const rec = r.out[r.out.length - 1];
  rec.display = v ? `${fmtInt(v)} → ${fmtDate(date1904(v))}` : '0 (not set)';
  rec.note = 'Seconds since midnight, 1 January 1904, UTC (the classic Mac OS epoch).';
  return v;
}

function unpackLang(v) {
  const s = String.fromCharCode(((v >> 10) & 31) + 0x60, ((v >> 5) & 31) + 0x60, (v & 31) + 0x60);
  return /^[a-z]{3}$/.test(s) ? s : null;
}

export function langDisplay(v) {
  if (v < 0x400) return `${v} (Macintosh language code${v === 0 ? ': English' : ''})`;
  const s = unpackLang(v);
  if (!s) return `0x${v.toString(16)} (not a valid language code; QuickTime uses 0x7fff for "unspecified")`;
  return `0x${v.toString(16)} → '${s}'${s === 'und' ? ' (undetermined)' : ''}`;
}

export function langCode(v) {
  if (v < 0x400) return v === 0 ? 'eng' : null;
  return unpackLang(v);
}

function language(r, o = {}) {
  r.bits(1, 'pad', { reserved: true });
  const v = r.bits(15, 'language', {
    display: langDisplay,
    desc: 'ISO 639-2/T language code packed as three 5-bit letters (each letter minus 0x60). \'und\' means undetermined.',
    ...o,
  });
  return v;
}

export function describeMatrix(m) {
  const [a, b, , c, d, , x, y] = m;
  const close = (p, q) => Math.abs(p - q) < 1e-4;
  const t = x || y ? `, translated (${fmtNum(x, 2)}, ${fmtNum(y, 2)})` : '';
  if (close(a, 1) && close(b, 0) && close(c, 0) && close(d, 1)) return x || y ? `translate (${fmtNum(x, 2)}, ${fmtNum(y, 2)})` : 'identity (no transformation)';
  if (close(a, 0) && close(b, 1) && close(c, -1) && close(d, 0)) return `rotate 90° clockwise${t}`;
  if (close(a, -1) && close(b, 0) && close(c, 0) && close(d, -1)) return `rotate 180°${t}`;
  if (close(a, 0) && close(b, -1) && close(c, 1) && close(d, 0)) return `rotate 90° counter-clockwise${t}`;
  if (close(a, -1) && close(b, 0) && close(c, 0) && close(d, 1)) return `mirror horizontally${t}`;
  if (close(a, 1) && close(b, 0) && close(c, 0) && close(d, -1)) return `mirror vertically${t}`;
  return `scale/rotate [${[a, b, c, d].map((v) => fmtNum(v, 3)).join(', ')}]${t}`;
}

export function matrixRotation(m) {
  if (!m) return 0;
  const [a, b, , c, d] = m;
  if (Math.abs(a) < 1e-4 && b > 0.99 && c < -0.99 && Math.abs(d) < 1e-4) return 90;
  if (a < -0.99 && d < -0.99) return 180;
  if (Math.abs(a) < 1e-4 && b < -0.99 && c > 0.99 && Math.abs(d) < 1e-4) return 270;
  return 0;
}

function matrix(r) {
  const vals = [];
  r.group('matrix', (g) => {
    const names = ['a', 'b', 'u', 'c', 'd', 'v', 'x', 'y', 'w'];
    for (let i = 0; i < 9; i++) vals.push(r.fixed(`${names[i]}`, 4, i % 3 === 2 ? 30 : 16, { reserved: false }));
    g.display = describeMatrix(vals);
  }, {
    desc: 'Transformation applied when the video is displayed: a 3×3 matrix [a b u; c d v; x y w] where a, b, c, d, x, y are 16.16 fixed point and u, v, w are 2.30. The identity matrix means "show as coded". Phones store portrait video as landscape frames plus a 90° rotation here.',
  });
  return vals;
}

export function sampleFlagsDisplay(v) {
  const leading = (v >>> 26) & 3;
  const dependsOn = (v >>> 24) & 3;
  const isDependedOn = (v >>> 22) & 3;
  const nonSync = (v >>> 16) & 1;
  const parts = [nonSync ? 'non-sync' : 'sync (random access point)'];
  if (dependsOn === 1) parts.push('depends on other samples');
  else if (dependsOn === 2) parts.push('does not depend on others (I-frame)');
  if (isDependedOn === 2) parts.push('not used as a reference (disposable)');
  if (leading) parts.push(['', 'leading, dependent', 'not leading', 'leading, decodable'][leading]);
  return `0x${(v >>> 0).toString(16).padStart(8, '0')} → ${parts.join(', ')}`;
}

const SAMPLE_FLAGS_DESC = 'Per-sample flags: is_leading(2), sample_depends_on(2), sample_is_depended_on(2), sample_has_redundancy(2), padding(3), sample_is_non_sync_sample(1), degradation_priority(16). A sample without the non-sync bit is a key frame.';

function flagNames(v, names) {
  const set = Object.entries(names).filter(([bit]) => v & Number(bit)).map(([, n]) => n);
  return `0x${v.toString(16).padStart(6, '0')}${set.length ? ` (${set.join(' | ')})` : ''}`;
}

export function readFullHeader(r, node, def) {
  const version = r.u8('version', {
    role: 'header',
    desc: 'Version of this box’s layout. For many boxes version 1 switches time and offset fields from 32 to 64 bits.',
  });
  const flags = r.u24('flags', {
    role: 'header',
    display: (v) => (def?.flags ? flagNames(v, def.flags) : `0x${v.toString(16).padStart(6, '0')}`),
    desc: def?.flagsDesc ?? '24 bits of box-specific flags.',
  });
  node.data.version = version;
  node.data.flags = flags;
  return { version, flags };
}

function brandDisplay(v) {
  const b = brandInfo(v);
  return b ? `'${v}' — ${b.desc}` : `'${v}'`;
}

function entryCount(r, name = 'entry_count', o = {}) {
  return r.u32(name, { desc: 'Number of entries in the table that follows.', ...o });
}

// Summaries shown in the tree next to the box and at the top of the inspector.
function plural(n, s) {
  if (n === 1) return `${fmtInt(n)} ${s}`;
  return `${fmtInt(n)} ${s.endsWith('y') ? `${s.slice(0, -1)}ies` : `${s}s`}`;
}

// ------------------------------------------------------------------ definitions

export const BOXES = {};
const def = (type, d) => {
  BOXES[type] = { spec: 'ISO', ...d };
};

// ---- file level

function typeBoxParse(r, node, ctx, isSegment) {
  const major = r.fourcc('major_brand', {
    key: true,
    display: brandDisplay,
    desc: 'The specification the file was primarily written for. Look it up at mp4ra.org/registered-types/brands.',
  });
  r.u32('minor_version', { desc: 'Version of the major brand. Informative only; players must not reject a file because of it.' });
  const brands = [];
  r.group('compatible_brands', (g) => {
    let i = 0;
    while (r.remaining >= 4) brands.push(r.fourcc(`[${i++}]`, { display: brandDisplay }));
    g.display = brands.map((b) => `'${b}'`).join(' ');
  }, { desc: 'Every specification this file conforms to. A reader that supports any one of them can play the file.' });
  node.data.major = major;
  node.data.brands = brands;
  node.data.summary = `${major}${brands.length ? ` · ${brands.join(', ')}` : ''}`;
  if (!isSegment) ctx.brands = { major, compatible: brands };
  if (major === 'qt  ') ctx.isQT = true;
}

def('ftyp', {
  name: 'File Type Box',
  cat: 'type',
  sec: '4.3',
  desc: 'Declares what kind of file this is. It comes first so that a reader can decide, before parsing anything else, whether it understands the file.',
  more: 'major_brand names the specification the file was written for and compatible_brands lists every specification it also conforms to; a player should accept the file if it supports any one of them. A file that does not start with ftyp is either an old-style QuickTime movie or damaged.',
  parse: (r, n, ctx) => typeBoxParse(r, n, ctx, false),
});

def('styp', {
  name: 'Segment Type Box',
  cat: 'type',
  sec: '8.16.2',
  desc: 'Like ftyp, but at the start of a media segment: one piece of an adaptive stream (DASH or HLS) rather than a whole file.',
  more: 'A segment is typically 2–10 seconds: styp, optionally sidx, then moof+mdat pairs. Brands such as \'msdh\' and \'msix\' say which DASH segment rules apply.',
  parse: (r, n, ctx) => typeBoxParse(r, n, ctx, true),
});

def('mdat', {
  name: 'Media Data Box',
  cat: 'media',
  sec: '8.1.1',
  desc: 'The media itself: the compressed audio and video bytes. Usually almost the whole file.',
  more: 'mdat has no internal structure. Where one sample (a video frame, an audio packet) starts and ends is only known from the sample tables in moov (stsz, stsc, stco) or from the trun boxes of movie fragments. Without those indexes the media is an opaque run of bytes.',
});

def('idat', {
  name: 'Item Data Box',
  cat: 'media',
  sec: '8.11.11',
  desc: 'Holds the data of small metadata items (see iloc with construction_method 1) inside the meta box.',
});

def('free', {
  name: 'Free Space Box',
  cat: 'free',
  sec: '8.1.2',
  desc: 'Free space. Its contents mean nothing and a reader skips it.',
  more: 'Writers leave free space so metadata can grow later without moving the media, and leave it behind when they move or shrink another box. Deleting a free box does not change the media.',
});
BOXES.skip = { ...BOXES.free, name: 'Free Space Box (skip)' };

def('wide', {
  name: 'Wide Placeholder Box',
  cat: 'free',
  spec: 'QT',
  desc: 'An 8-byte placeholder QuickTime writers put just before mdat.',
  more: 'If the media grows past 4 GB, the writer overwrites wide+mdat headers with a single 16-byte mdat header using a 64-bit size, without moving any data.',
  syntax: 'aligned(8) class WideBox extends Box(\'wide\') {\n    // no fields: reserves 8 bytes for a later 64-bit mdat header\n}',
});

def('pdin', {
  name: 'Progressive Download Information Box',
  cat: 'header',
  full: true,
  sec: '8.1.3',
  desc: 'Pairs of download rate and the initial delay needed to play the file without stalling.',
  parse(r) {
    const n = Math.floor(r.remaining / 8);
    r.table('entries', n, 8, [
      { name: 'rate', type: 'u32', display: (v) => `${fmtInt(v)} bytes/s` },
      { name: 'initial_delay', type: 'u32', display: (v) => `${fmtInt(v)} ms` },
    ]);
  },
});

def('uuid', {
  name: 'User Extension Box',
  cat: 'unknown',
  sec: '4.2',
  desc: 'A box whose type is a 16-byte UUID instead of a four-character code. Vendors use it for private extensions.',
  more: 'Readers skip uuid boxes they don’t recognise. Known ones include PIFF/Smooth Streaming boxes (tfxd, tfrf, sample encryption) and XMP metadata.',
});

// ---- movie

def('moov', {
  name: 'Movie Box',
  cat: 'index',
  sec: '8.2.1',
  container: true,
  desc: 'The index of the file. It holds no media: it describes the tracks, their timing, their codecs and, crucially, where each sample sits inside mdat.',
  more: 'Everything a player needs before it can decode the first frame is in here. Its position matters: if moov comes before mdat ("fast start"), playback can begin while the file downloads; if it comes after, the player has to fetch the end of the file first.',
});

def('mvhd', {
  name: 'Movie Header Box',
  cat: 'header',
  full: true,
  sec: '8.2.2',
  desc: 'File-wide timing: the movie timescale, the overall duration and the preferred playback rate and volume.',
  more: 'Durations at movie level (mvhd, tkhd and edit lists) count in this timescale. The duration equals that of the longest track; in a fragmented file it is often 0 because the length was unknown when the header was written.',
  parse(r, n, ctx) {
    const v1 = n.data.version === 1;
    dateField(r, 'creation_time', v1, { desc: 'When the presentation was created.' });
    dateField(r, 'modification_time', v1, { desc: 'When it was last modified.' });
    const ts = r.u32('timescale', {
      key: true,
      unit: 'units per second',
      desc: 'How many time units make one second for the movie-level durations. 1000 means milliseconds.',
    });
    ctx.movieTimescale = ts;
    const dur = timeField(r, 'duration', v1, ts, {
      key: true,
      desc: 'Length of the whole presentation, in movie timescale units. Divide by the timescale to get seconds.',
    });
    n.data.timescale = ts;
    n.data.duration = dur;
    r.fixed('rate', 4, 16, { desc: 'Preferred playback rate; 1.0 is normal speed.' });
    r.fixed('volume', 2, 8, { desc: 'Preferred volume; 1.0 is full volume.' });
    r.skip(2, 'reserved');
    r.skip(8, 'reserved');
    n.data.matrix = matrix(r);
    r.skip(24, 'pre_defined', { desc: 'Zero in ISO files. QuickTime stores preview/poster/selection times here.' });
    n.data.nextTrackId = r.u32('next_track_ID', { desc: 'A track ID larger than any in use, for adding a new track.' });
    n.data.summary = `${fmtDuration(ts ? dur / ts : 0)} @ ${fmtInt(ts)}/s`;
  },
});

def('iods', {
  name: 'Object Descriptor Box',
  cat: 'header',
  full: true,
  spec: 'MP4v2',
  desc: 'Initial object descriptor from MPEG-4 Systems. Legacy: modern players ignore it.',
});

// ---- track

def('trak', {
  name: 'Track Box',
  cat: 'track',
  sec: '8.3.1',
  container: true,
  desc: 'One track: a single stream such as video, audio or subtitles, with its own timing and sample index.',
  more: 'There is one trak per stream. Everything about the track (dimensions, language, codec, the table of its samples) lives inside it.',
  parse(r, n, ctx) {
    ctx.handler = null;
    ctx.mediaTimescale = 0;
    ctx.entry = null;
    ctx.trackId = null;
  },
});

def('tkhd', {
  name: 'Track Header Box',
  cat: 'header',
  full: true,
  sec: '8.3.2',
  flags: { 1: 'enabled', 2: 'in_movie', 4: 'in_preview', 8: 'size_is_aspect_ratio' },
  flagsDesc: 'Bit 0: track enabled. Bit 1: used in the presentation. Bit 2: used in previews. Bit 3: width/height give only an aspect ratio.',
  desc: 'The track’s ID, duration, layer, volume, transformation matrix and display size.',
  more: 'width and height are the display size in pixels (16.16 fixed point), after pixel aspect ratio and the matrix are applied, which can differ from the coded size in the sample entry.',
  parse(r, n, ctx) {
    const v1 = n.data.version === 1;
    dateField(r, 'creation_time', v1);
    dateField(r, 'modification_time', v1);
    n.data.trackId = r.u32('track_ID', { key: true, desc: 'Unique, non-zero ID of this track in the file. Other boxes (tref, trex, tfhd) refer to tracks by this number.' });
    ctx.trackId = n.data.trackId;
    r.skip(4, 'reserved');
    n.data.duration = timeField(r, 'duration', v1, ctx.movieTimescale, { desc: 'Track length in the movie timescale (from mvhd), after edit lists.' });
    r.skip(8, 'reserved');
    r.i16('layer', { desc: 'Front-to-back order for visual tracks; lower numbers are closer to the viewer.' });
    r.i16('alternate_group', { desc: 'Tracks with the same non-zero group are alternatives (e.g. languages); only one plays at a time.' });
    r.fixed('volume', 2, 8, { desc: '1.0 for audio tracks, 0 for others.' });
    r.skip(2, 'reserved');
    n.data.matrix = matrix(r);
    n.data.width = r.fixed('width', 4, 16, { key: true, unsigned: true, display: undefined, desc: 'Display width in pixels (16.16 fixed point).' });
    n.data.height = r.fixed('height', 4, 16, { key: true, unsigned: true, desc: 'Display height in pixels (16.16 fixed point).' });
    n.data.summary = `track ${n.data.trackId}${n.data.width ? `, ${fmtNum(n.data.width, 2)}×${fmtNum(n.data.height, 2)}` : ''}`;
  },
});

def('tref', {
  name: 'Track Reference Box',
  cat: 'track',
  sec: '8.3.3',
  container: true,
  desc: 'Links from this track to other tracks, e.g. to its chapter track, timecode track or the video a subtitle belongs to.',
});

def('trgr', {
  name: 'Track Group Box',
  cat: 'track',
  sec: '8.3.4',
  container: true,
  desc: 'Groups of tracks that belong together, such as the views of a stereoscopic video.',
});

def('edts', {
  name: 'Edit Box',
  cat: 'track',
  sec: '8.6.5',
  container: true,
  desc: 'Holds the edit list that maps the track’s media timeline onto the movie timeline.',
});

def('elst', {
  name: 'Edit List Box',
  cat: 'table',
  full: true,
  sec: '8.6.6',
  desc: 'Which parts of the track’s media are played, and when.',
  more: 'Each entry maps a stretch of the movie timeline (segment_duration, movie timescale) to a start point in the media (media_time, media timescale). media_time -1 is an empty edit: a delay. Encoders use an edit list to hide codec start-up delay, such as AAC priming samples or the B-frame delay of video, so audio and video line up. Players that ignore edit lists show an A/V offset.',
  parse(r, n, ctx) {
    const v1 = n.data.version === 1;
    const count = entryCount(r);
    const ts = ctx.movieTimescale;
    const t = r.table('entries', count, v1 ? 20 : 12, [
      { name: 'segment_duration', type: v1 ? 'u64' : 'u32', display: (v) => durationDisplay(ts)(v), desc: 'Length of this edit in the movie timescale.' },
      { name: 'media_time', type: v1 ? 'i64' : 'i32', display: (v) => (v === -1 ? '-1 (empty edit: nothing plays)' : `${fmtInt(v)} (media timescale)`), desc: 'Where in the media this edit starts; -1 means an empty edit.' },
      { name: 'media_rate_integer', type: 'i16', desc: 'Playback rate for this edit; 1 is normal, 0 is a dwell (freeze frame).' },
      { name: 'media_rate_fraction', type: 'i16' },
    ]);
    n.data.table = t;
    n.data.summary = plural(t.count, 'edit');
  },
});

// ---- media

def('mdia', {
  name: 'Media Box',
  cat: 'track',
  sec: '8.4.1',
  container: true,
  desc: 'Everything about the track’s media: its timescale and language, its handler (video, audio...) and the media information.',
});

def('mdhd', {
  name: 'Media Header Box',
  cat: 'header',
  full: true,
  sec: '8.4.2',
  desc: 'The track’s own timescale (ticks per second), its duration in those ticks, and its language.',
  more: 'Every timestamp and duration of this track’s samples (stts, ctts, trun) counts in this timescale. Video tracks often use 90000 or a multiple of the frame rate; audio tracks usually use their sample rate.',
  parse(r, n, ctx) {
    const v1 = n.data.version === 1;
    dateField(r, 'creation_time', v1);
    dateField(r, 'modification_time', v1);
    const ts = r.u32('timescale', { key: true, unit: 'units per second', desc: 'Ticks per second for this track’s media timeline.' });
    ctx.mediaTimescale = ts;
    n.data.timescale = ts;
    n.data.duration = timeField(r, 'duration', v1, ts, { key: true, desc: 'Length of the media in its own timescale, before edit lists.' });
    n.data.language = langCode(language(r));
    r.u16('pre_defined', { desc: 'Zero in ISO files (QuickTime: playback quality).' });
    n.data.summary = `${fmtDuration(ts ? n.data.duration / ts : 0)} @ ${fmtInt(ts)}/s${n.data.language && n.data.language !== 'und' ? `, ${n.data.language}` : ''}`;
  },
});

const HANDLERS = {
  vide: 'Video', soun: 'Audio', hint: 'Hint (streaming instructions)', meta: 'Timed metadata', text: 'Text (QuickTime)',
  subt: 'Subtitles', sbtl: 'Subtitles (QuickTime/Apple)', tmcd: 'Timecode', clcp: 'Closed captions', pict: 'Picture (HEIF image item)',
  mdir: 'iTunes metadata', mdta: 'QuickTime metadata keys', odsm: 'MPEG-4 object descriptor stream', sdsm: 'MPEG-4 scene description',
  auxv: 'Auxiliary video', alis: 'QuickTime alias (data handler)', url: 'URL data handler', camm: 'Camera motion metadata',
};

export function handlerName(t) {
  return HANDLERS[t] ?? handlerInfo(t) ?? 'unknown';
}

def('hdlr', {
  name: 'Handler Reference Box',
  cat: 'header',
  full: true,
  sec: '8.4.3',
  desc: 'Declares what kind of media the track holds: \'vide\' video, \'soun\' audio, \'subt\'/\'text\' subtitles, \'meta\' metadata and so on.',
  more: 'The handler decides how everything below it is read, for example which kind of sample entry stsd contains. Inside a meta box it declares the metadata format instead (\'mdir\' iTunes tags, \'mdta\' QuickTime keys, \'pict\' HEIF images). The name is a human-readable label some tools show as the track title.',
  parse(r, n, ctx) {
    const pre = r.fourcc('pre_defined', {
      display: (v) => (v === '\\x00\\x00\\x00\\x00' ? '0' : `'${v}'${v === 'mhlr' ? ' — QuickTime media handler' : v === 'dhlr' ? ' — QuickTime data handler' : ''}`),
      desc: 'Zero in ISO files. QuickTime stores the component type here (\'mhlr\' media handler, \'dhlr\' data handler).',
    });
    const type = r.fourcc('handler_type', { key: true, display: (v) => `'${v}' — ${handlerName(v)}`, desc: 'The kind of media or metadata this handler is for.' });
    r.skip(12, 'reserved', { desc: 'Zero in ISO files (QuickTime: component manufacturer, flags and flags mask).' });
    // ISO: NUL-terminated UTF-8. QuickTime: a Pascal string (length byte first).
    let name = '';
    if (r.remaining > 0) {
      const first = r.u[r.pos];
      const qtStyle = (pre === 'mhlr' || pre === 'dhlr' || ctx.isQT) && first === r.remaining - 1;
      name = qtStyle ? r.pstr('name', { desc: 'Human-readable name (QuickTime Pascal string: a length byte then the text).' })
        : r.cstr('name', { desc: 'Human-readable name of the track type, NUL-terminated UTF-8.' });
    }
    n.data.handler = type;
    n.data.name = name;
    const parent = n.parent?.type;
    if (parent === 'mdia') ctx.handler = type;
    n.data.summary = `${type} — ${handlerName(type)}${name ? ` "${name}"` : ''}`;
  },
});

def('elng', {
  name: 'Extended Language Tag',
  cat: 'header',
  full: true,
  sec: '8.4.6',
  desc: 'A BCP-47 language tag (e.g. "en-US", "zh-Hant") that is more precise than the 3-letter code in mdhd.',
  parse(r, n) {
    n.data.language = r.cstr('extended_language', { key: true });
  },
});

def('minf', {
  name: 'Media Information Box',
  cat: 'track',
  sec: '8.4.4',
  container: true,
  desc: 'The media-specific header, the data references and the sample table of the track.',
});

def('vmhd', {
  name: 'Video Media Header Box',
  cat: 'header',
  full: true,
  sec: '12.1.2',
  desc: 'Marks a video track. Its fields (a QuickTime drawing mode and colour) are almost always zero.',
  parse(r) {
    r.u16('graphicsmode', { enum: { 0: 'copy', 0x40: 'dither copy', 0x100: 'alpha', 0x24: 'transparent' }, desc: 'How the video is composed on screen; 0 = copy (opaque).' });
    r.u16('opcolor[0] (red)');
    r.u16('opcolor[1] (green)');
    r.u16('opcolor[2] (blue)');
  },
});

def('smhd', {
  name: 'Sound Media Header Box',
  cat: 'header',
  full: true,
  sec: '12.2.2',
  desc: 'Marks an audio track. Holds the stereo balance, which is almost always 0 (centre).',
  parse(r) {
    r.fixed('balance', 2, 8, { desc: '-1.0 is full left, 1.0 full right, 0 centre.' });
    r.skip(2, 'reserved');
  },
});

def('hmhd', {
  name: 'Hint Media Header Box',
  cat: 'header',
  full: true,
  sec: '12.4.2',
  desc: 'Statistics for a hint track (instructions a streaming server uses to packetise the media for RTP).',
  parse(r) {
    r.u16('maxPDUsize', { unit: 'bytes' });
    r.u16('avgPDUsize', { unit: 'bytes' });
    r.u32('maxbitrate', { unit: 'b/s' });
    r.u32('avgbitrate', { unit: 'b/s' });
    r.skip(4, 'reserved');
  },
});

def('nmhd', { name: 'Null Media Header Box', cat: 'header', full: true, sec: '8.4.5.2', desc: 'Media header for tracks that are neither audio nor video, such as timed metadata.' });
def('sthd', { name: 'Subtitle Media Header Box', cat: 'header', full: true, sec: '12.6.2', desc: 'Marks a subtitle track (handler \'subt\').' });

def('gmhd', {
  name: 'Base Media Information Header',
  cat: 'header',
  spec: 'QT',
  container: true,
  desc: 'QuickTime media header used by tracks that are not audio or video, such as timecode and text tracks.',
});

def('gmin', {
  name: 'Base Media Info',
  cat: 'header',
  spec: 'QT',
  full: true,
  desc: 'QuickTime drawing mode, colour and balance for a base media track.',
  parse(r) {
    r.u16('graphicsmode');
    r.u16('opcolor[0]');
    r.u16('opcolor[1]');
    r.u16('opcolor[2]');
    r.fixed('balance', 2, 8);
    r.skip(2, 'reserved');
  },
});

def('tcmi', {
  name: 'Timecode Media Information',
  cat: 'header',
  spec: 'QT',
  full: true,
  desc: 'How a QuickTime timecode track should be drawn if shown: font, size and colours.',
  parse(r) {
    r.u16('text_font');
    r.u16('text_face');
    r.u16('text_size');
    r.skip(2, 'reserved');
    r.bytes('text_color', 6);
    r.bytes('background_color', 6);
    if (r.remaining) r.pstr('font_name');
  },
});

def('dinf', {
  name: 'Data Information Box',
  cat: 'track',
  sec: '8.7.1',
  container: true,
  desc: 'Says where the track’s media data lives (almost always: in this same file).',
});

def('dref', {
  name: 'Data Reference Box',
  cat: 'header',
  full: true,
  sec: '8.7.2',
  container: true,
  desc: 'A table of places the media can be found. An entry with flag 1 means "in this file", the normal case.',
  more: 'Samples refer to an entry through the data_reference_index of their sample entry. External references (media in another file or at a URL) are rare today.',
  parse(r) {
    entryCount(r);
  },
});

def('url ', {
  name: 'Data Entry URL Box',
  cat: 'header',
  full: true,
  sec: '8.7.2',
  flags: { 1: 'self-contained' },
  flagsDesc: 'Flag 1 (self-contained): the media data is in the same file as this box, and no URL follows.',
  desc: 'A data reference. With flags = 1 the media is in this same file and there is no URL.',
  parse(r, n) {
    if (!(n.data.flags & 1) && r.remaining > 0) r.cstr('location', { desc: 'URL of the file holding the media.' });
    n.data.summary = n.data.flags & 1 ? 'media is in this file' : 'external media';
  },
});

def('urn ', {
  name: 'Data Entry URN Box',
  cat: 'header',
  full: true,
  sec: '8.7.2',
  desc: 'A data reference that names a resource by URN, optionally with a location.',
  parse(r) {
    r.cstr('name');
    if (r.remaining) r.cstr('location');
  },
});

def('alis', {
  name: 'Alias Data Reference',
  cat: 'header',
  spec: 'QT',
  full: true,
  flags: { 1: 'self-contained' },
  desc: 'QuickTime data reference in Mac alias format. Flag 1 means the media is in this file.',
});

// ---- sample table

def('stbl', {
  name: 'Sample Table Box',
  cat: 'track',
  sec: '8.5.1',
  container: true,
  desc: 'The index of every sample in the track: what codec (stsd), when each sample plays (stts, ctts), how big it is (stsz), where it is (stsc, stco) and which samples are key frames (stss).',
});

def('stsd', {
  name: 'Sample Description Box',
  cat: 'codec',
  full: true,
  sec: '8.5.2',
  container: true,
  desc: 'The codec of the track and its setup, as one or more sample entries (for example avc1 holding an avcC).',
  more: 'A decoder is initialised from here before the first sample. Most tracks have exactly one entry; samples point at theirs through the sample_description_index in stsc (or tfhd/trex in fragments).',
  parse(r) {
    entryCount(r, 'entry_count', { desc: 'Number of sample entries (codec descriptions) that follow.' });
  },
});

def('stts', {
  name: 'Decoding Time to Sample Box',
  cat: 'table',
  full: true,
  sec: '8.6.1.2',
  desc: 'The duration of every sample, run-length coded. Adding them up gives each sample’s decoding time.',
  more: 'Each entry says "the next sample_count samples each last sample_delta ticks" (in the mdhd timescale). A track with a constant frame rate has a single entry.',
  parse(r, n, ctx) {
    const count = entryCount(r);
    const ts = ctx.mediaTimescale;
    const t = r.table('entries', count, 8, [
      { name: 'sample_count', type: 'u32', desc: 'Number of consecutive samples with this duration.' },
      { name: 'sample_delta', type: 'u32', display: (v) => (ts ? `${fmtInt(v)} ticks (${fmtNum((v / ts) * 1000, 3)} ms)` : fmtInt(v)), desc: 'Duration of each of those samples, in media timescale ticks.' },
    ]);
    n.data.table = t;
    let samples = 0;
    let ticks = 0;
    for (let i = 0; i < t.count; i++) {
      const c = t.dv.getUint32(t.rel + i * 8);
      samples += c;
      ticks += c * t.dv.getUint32(t.rel + i * 8 + 4);
    }
    n.data.samples = samples;
    n.data.ticks = ticks;
    n.data.summary = t.count === 1 ? `${fmtInt(samples)} samples × ${fmtInt(t.dv.getUint32(t.rel + 4))} ticks` : `${plural(t.count, 'entry')}, ${fmtInt(samples)} samples`;
  },
});

def('ctts', {
  name: 'Composition Time to Sample Box',
  cat: 'table',
  full: true,
  sec: '8.6.1.3',
  desc: 'How far each sample’s display time is from its decoding time. Needed when frames are decoded in a different order than they are shown (B-frames).',
  more: 'Presentation time = decoding time + sample_offset. Entries are run-length coded like stts. Version 1 allows negative offsets, which lets the first frame show at time 0 without an edit list.',
  parse(r, n, ctx) {
    const count = entryCount(r);
    const ts = ctx.mediaTimescale;
    const t = r.table('entries', count, 8, [
      { name: 'sample_count', type: 'u32' },
      { name: 'sample_offset', type: n.data.version === 1 ? 'i32' : 'u32', display: (v) => (ts ? `${fmtInt(v)} ticks (${fmtNum((v / ts) * 1000, 3)} ms)` : fmtInt(v)) },
    ]);
    n.data.table = t;
    n.data.summary = plural(t.count, 'entry');
  },
});

def('cslg', {
  name: 'Composition to Decode Box',
  cat: 'table',
  full: true,
  sec: '8.6.1.4',
  desc: 'A summary of the composition offsets: the smallest and largest, and the shift that keeps decode times ahead of display times.',
  parse(r, n) {
    const big = n.data.version === 1;
    const f = big ? 'i64' : 'i32';
    r[f]('compositionToDTSShift');
    r[f]('leastDecodeToDisplayDelta');
    r[f]('greatestDecodeToDisplayDelta');
    r[f]('compositionStartTime');
    r[f]('compositionEndTime');
  },
});

def('stss', {
  name: 'Sync Sample Box',
  cat: 'table',
  full: true,
  sec: '8.6.2',
  desc: 'The list of samples that are random-access points (key frames). A player can only start decoding, or seek to, one of these.',
  more: 'If stss is missing, every sample is a sync sample, which is normal for audio. The gap between entries is the keyframe interval (GOP length); long gaps make seeking slow and imprecise.',
  parse(r, n) {
    const count = entryCount(r);
    const t = r.table('entries', count, 4, [{ name: 'sample_number', type: 'u32', desc: '1-based number of a key-frame sample.' }]);
    n.data.table = t;
    n.data.summary = plural(t.count, 'key frame');
  },
});

def('stps', {
  name: 'Partial Sync Sample Box',
  cat: 'table',
  full: true,
  spec: 'QT',
  desc: 'QuickTime: samples that are open-GOP random access points (e.g. MPEG-2 or HEVC CRA frames).',
  parse(r, n) {
    const count = entryCount(r);
    n.data.table = r.table('entries', count, 4, [{ name: 'sample_number', type: 'u32' }]);
  },
});

def('stsh', {
  name: 'Shadow Sync Sample Box',
  cat: 'table',
  full: true,
  sec: '8.6.3',
  desc: 'Alternative sync samples that can stand in for a non-sync sample when seeking.',
  parse(r) {
    const count = entryCount(r);
    r.table('entries', count, 8, [{ name: 'shadowed_sample_number', type: 'u32' }, { name: 'sync_sample_number', type: 'u32' }]);
  },
});

const SDTP_COLS = [
  { name: 'is_leading', type: 'bits', size: 1, bits: [0, 2], enum: { 0: 'unknown', 1: 'leading, depends on previous', 2: 'not leading', 3: 'leading, decodable' } },
  { name: 'sample_depends_on', type: 'bits', size: 1, bits: [2, 2], enum: { 0: 'unknown', 1: 'depends on others', 2: 'independent (I)', 3: 'reserved' } },
  { name: 'sample_is_depended_on', type: 'bits', size: 1, bits: [4, 2], enum: { 0: 'unknown', 1: 'referenced', 2: 'not referenced (disposable)', 3: 'reserved' } },
  { name: 'sample_has_redundancy', type: 'bits', size: 1, bits: [6, 2], last: true, enum: { 0: 'unknown', 1: 'redundant coding', 2: 'no redundant coding', 3: 'reserved' } },
];

def('sdtp', {
  name: 'Independent and Disposable Samples Box',
  cat: 'table',
  full: true,
  sec: '8.6.4',
  desc: 'One byte per sample saying whether it depends on other samples and whether other samples depend on it.',
  more: 'Lets a player drop frames that nothing references (such as non-reference B-frames) when it needs to catch up or play fast.',
  parse(r, n) {
    n.data.table = r.table('samples', r.remaining, 1, SDTP_COLS);
    n.data.summary = plural(n.data.table.count, 'sample');
  },
});

def('stsz', {
  name: 'Sample Size Box',
  cat: 'table',
  full: true,
  sec: '8.7.3.2',
  desc: 'The size in bytes of every sample. When all samples have the same size, a single sample_size replaces the table.',
  parse(r, n) {
    const fixed = r.u32('sample_size', { display: (v) => (v ? `${fmtInt(v)} bytes (every sample)` : '0 (sizes vary; a table follows)'), desc: 'If non-zero, every sample has this size and there is no table.' });
    const count = r.u32('sample_count', { key: true, desc: 'Number of samples in the track.' });
    n.data.fixed = fixed;
    n.data.count = count;
    if (!fixed) {
      const t = r.table('entry_size', count, 4, [{ name: 'size', type: 'u32', display: (v) => `${fmtInt(v)} bytes` }], { desc: 'Size of each sample, in order.' });
      n.data.table = t;
      let total = 0;
      let max = 0;
      for (let i = 0; i < t.count; i++) {
        const s = t.dv.getUint32(t.rel + i * 4);
        total += s;
        if (s > max) max = s;
      }
      n.data.total = total;
      n.data.summary = `${fmtInt(count)} samples, avg ${fmtInt(count ? total / count : 0)} B, max ${fmtInt(max)} B`;
    } else {
      n.data.total = fixed * count;
      n.data.summary = `${fmtInt(count)} samples × ${fmtInt(fixed)} B`;
    }
  },
});

def('stz2', {
  name: 'Compact Sample Size Box',
  cat: 'table',
  full: true,
  sec: '8.7.3.3',
  desc: 'Sample sizes packed into 4, 8 or 16 bits each.',
  parse(r, n) {
    r.skip(3, 'reserved');
    const bits = r.u8('field_size', { unit: 'bits' });
    const count = r.u32('sample_count', { key: true });
    n.data.fieldSize = bits;
    n.data.count = count;
    if (bits === 16) n.data.table = r.table('entry_size', count, 2, [{ name: 'size', type: 'u16' }]);
    else if (bits === 8) n.data.table = r.table('entry_size', count, 1, [{ name: 'size', type: 'u8' }]);
    else if (bits === 4) {
      n.data.table = r.table('entry_size_pairs', Math.ceil(count / 2), 1, [
        { name: 'size[2i]', type: 'bits', size: 1, bits: [0, 4] },
        { name: 'size[2i+1]', type: 'bits', size: 1, bits: [4, 4], last: true },
      ]);
    }
  },
});

def('stsc', {
  name: 'Sample To Chunk Box',
  cat: 'table',
  full: true,
  sec: '8.7.4',
  desc: 'How samples are grouped into chunks: runs of consecutive samples stored back to back in mdat.',
  more: 'Each entry says "from chunk first_chunk on, every chunk holds samples_per_chunk samples", until the next entry’s first_chunk. Together with stco (where each chunk starts) and stsz (how big each sample is) this gives the file position of every sample.',
  parse(r, n) {
    const count = entryCount(r);
    const t = r.table('entries', count, 12, [
      { name: 'first_chunk', type: 'u32', desc: '1-based index of the first chunk this entry applies to.' },
      { name: 'samples_per_chunk', type: 'u32' },
      { name: 'sample_description_index', type: 'u32', desc: 'Which stsd entry (1-based) describes these samples.' },
    ]);
    n.data.table = t;
    n.data.summary = plural(t.count, 'entry');
  },
});

function chunkOffsets(big) {
  return (r, n) => {
    const count = entryCount(r, 'entry_count', { desc: 'Number of chunks.' });
    const t = r.table('chunk_offset', count, big ? 8 : 4, [
      { name: 'offset', type: big ? 'u64' : 'u32', ref: 'offset', display: (v) => `${fmtInt(v)} (${hex(v)})`, desc: 'Absolute file position where the chunk starts (inside mdat).' },
    ]);
    n.data.table = t;
    n.data.summary = plural(t.count, 'chunk');
  };
}

def('stco', {
  name: 'Chunk Offset Box',
  cat: 'table',
  full: true,
  sec: '8.7.5',
  desc: 'The file position where each chunk begins, as 32-bit offsets.',
  more: 'These are absolute positions in the file, so they point straight into mdat. That is why moving mdat, for example when moov is moved to the front for fast start, means rewriting every entry.',
  parse: chunkOffsets(false),
});

def('co64', {
  name: 'Chunk Large Offset Box',
  cat: 'table',
  full: true,
  sec: '8.7.5',
  desc: 'Chunk positions as 64-bit offsets, needed once the file passes 4 GB.',
  parse: chunkOffsets(true),
});

def('padb', {
  name: 'Padding Bits Box',
  cat: 'table',
  full: true,
  sec: '8.7.6',
  desc: 'For samples whose length in bits is not a multiple of 8: how many padding bits each one has.',
  parse(r) {
    const count = r.u32('sample_count');
    r.table('entries', Math.ceil(count / 2), 1, [
      { name: 'pad1', type: 'bits', size: 1, bits: [1, 3] },
      { name: 'pad2', type: 'bits', size: 1, bits: [5, 3], last: true },
    ]);
  },
});

def('stdp', {
  name: 'Degradation Priority Box',
  cat: 'table',
  full: true,
  sec: '8.5.3',
  desc: 'A priority per sample, for dropping less important samples first.',
  parse(r) {
    r.table('priority', Math.floor(r.remaining / 2), 2, [{ name: 'priority', type: 'u16' }]);
  },
});

def('subs', {
  name: 'Sub-Sample Information Box',
  cat: 'table',
  full: true,
  sec: '8.7.7',
  desc: 'Splits samples into sub-samples (such as NAL units or tiles), with a size and priority for each.',
  parse(r, n) {
    const count = entryCount(r);
    const big = n.data.version === 1;
    for (let i = 0; i < Math.min(count, 200); i++) {
      r.group(`entry[${i}]`, () => {
        r.u32('sample_delta');
        const sc = r.u16('subsample_count');
        for (let k = 0; k < sc; k++) {
          r.group(`subsample[${k}]`, () => {
            if (big) r.u32('subsample_size');
            else r.u16('subsample_size');
            r.u8('subsample_priority');
            r.u8('discardable');
            r.u32('codec_specific_parameters');
          });
        }
      });
    }
    if (r.remaining) r.rest('more_entries', { desc: 'Further entries (not expanded here).' });
  },
});

def('saiz', {
  name: 'Sample Auxiliary Information Sizes Box',
  cat: 'protect',
  full: true,
  sec: '8.7.8',
  desc: 'Sizes of per-sample side data, usually the encryption IV and subsample map of each sample.',
  parse(r, n) {
    if (n.data.flags & 1) {
      r.fourcc('aux_info_type');
      r.u32('aux_info_type_parameter');
    }
    const def0 = r.u8('default_sample_info_size', { display: (v) => (v ? `${v} bytes (all samples)` : '0 (sizes vary; a table follows)') });
    const count = r.u32('sample_count');
    if (!def0) r.table('sample_info_size', count, 1, [{ name: 'size', type: 'u8' }]);
  },
});

def('saio', {
  name: 'Sample Auxiliary Information Offsets Box',
  cat: 'protect',
  full: true,
  sec: '8.7.9',
  desc: 'Where the per-sample side data described by saiz is stored (inside a moof, offsets count from the moof).',
  parse(r, n) {
    if (n.data.flags & 1) {
      r.fourcc('aux_info_type');
      r.u32('aux_info_type_parameter');
    }
    const count = entryCount(r);
    r.table('offset', count, n.data.version === 1 ? 8 : 4, [{ name: 'offset', type: n.data.version === 1 ? 'u64' : 'u32' }]);
  },
});

const SAMPLE_GROUPS = {
  roll: 'audio pre-roll', prol: 'pre-roll', rap: 'random access point', seig: 'CENC key info', sync: 'sync NAL types',
  tele: 'temporal level', tscl: 'temporal layer', stsa: 'step-wise temporal sub-layer access', alst: 'alternative startup',
  rash: 'rate share', scif: 'scalability info', drap: 'dependent random access point', sap: 'stream access point',
};

function sgpdEntry(r, type, len, ctx) {
  const start = r.pos;
  switch (type) {
    case 'roll':
    case 'prol':
      r.i16('roll_distance', { desc: 'How many samples before (negative) or after this one must be decoded for correct output. AAC typically uses -1: decode one packet before the one you want.' });
      break;
    case 'rap ':
      r.flag('num_leading_samples_known');
      r.bits(7, 'num_leading_samples');
      break;
    case 'sync':
      r.bits(2, 'reserved', { reserved: true });
      r.bits(6, 'NAL_unit_type');
      break;
    case 'tele':
      r.flag('level_independently_decodable');
      r.bits(7, 'reserved', { reserved: true });
      break;
    case 'seig':
      r.u8('reserved', { reserved: true });
      r.bits(4, 'crypt_byte_block');
      r.bits(4, 'skip_byte_block');
      r.u8('isProtected');
      r.u8('Per_Sample_IV_Size');
      r.uuid('KID', { display: (v) => v, desc: 'Key ID of the content key for these samples.' });
      break;
    default:
      if (len) r.bytes('description', len);
  }
  if (len && r.pos - start < len) r.bytes('rest', len - (r.pos - start));
  void ctx;
}

def('sgpd', {
  name: 'Sample Group Description Box',
  cat: 'table',
  full: true,
  sec: '8.9.3',
  desc: 'Properties that groups of samples share, such as \'roll\' (audio pre-roll) or \'seig\' (encryption key per group of samples).',
  parse(r, n, ctx) {
    const type = r.fourcc('grouping_type', { key: true, display: (v) => `'${v}' — ${SAMPLE_GROUPS[v.trim()] ?? reg('sample-groups', v)?.[0] ?? 'unknown'}` });
    const v = n.data.version;
    let defLen = 0;
    if (v >= 1) defLen = r.u32('default_length', { unit: 'bytes' });
    if (v >= 2) r.u32('default_group_description_index');
    const count = entryCount(r);
    for (let i = 0; i < Math.min(count, 500) && r.remaining > 0; i++) {
      r.group(`entry[${i}]`, () => {
        let len = defLen;
        if (v >= 1 && defLen === 0) len = r.u32('description_length');
        sgpdEntry(r, type, len, ctx);
      });
    }
    if (r.remaining) r.rest('more_entries');
    n.data.summary = `'${type}' × ${count}`;
  },
});

def('sbgp', {
  name: 'Sample To Group Box',
  cat: 'table',
  full: true,
  sec: '8.9.2',
  desc: 'Assigns runs of samples to an entry of the matching sgpd.',
  parse(r, n) {
    const type = r.fourcc('grouping_type', { key: true, display: (v) => `'${v}' — ${SAMPLE_GROUPS[v.trim()] ?? 'unknown'}` });
    if (n.data.version === 1) r.u32('grouping_type_parameter');
    const count = entryCount(r);
    r.table('entries', count, 8, [
      { name: 'sample_count', type: 'u32' },
      { name: 'group_description_index', type: 'u32', display: (v) => (v ? `${v}` : '0 (not in any group)') },
    ]);
    n.data.summary = `'${type}' × ${count}`;
  },
});

// ---- fragments

def('mvex', {
  name: 'Movie Extends Box',
  cat: 'fragment',
  sec: '8.8.1',
  container: true,
  desc: 'Announces that the movie continues in movie fragments (moof boxes) and gives their default values.',
});

def('mehd', {
  name: 'Movie Extends Header Box',
  cat: 'fragment',
  full: true,
  sec: '8.8.2',
  desc: 'The total duration of the fragmented movie, including all fragments, if it was known.',
  parse(r, n, ctx) {
    timeField(r, 'fragment_duration', n.data.version === 1, ctx.movieTimescale);
  },
});

def('trex', {
  name: 'Track Extends Box',
  cat: 'fragment',
  full: true,
  sec: '8.8.3',
  desc: 'Default sample description, duration, size and flags for a track’s fragments. Each fragment can override them.',
  parse(r, n) {
    n.data.trackId = r.u32('track_ID', { key: true });
    n.data.sdi = r.u32('default_sample_description_index');
    n.data.duration = r.u32('default_sample_duration');
    n.data.size = r.u32('default_sample_size');
    n.data.sampleFlags = r.u32('default_sample_flags', { display: sampleFlagsDisplay, desc: SAMPLE_FLAGS_DESC });
    n.data.summary = `track ${n.data.trackId}`;
  },
});

def('moof', {
  name: 'Movie Fragment Box',
  cat: 'fragment',
  sec: '8.8.4',
  container: true,
  desc: 'The index for the samples in the mdat that follows it. A fragmented MP4 is a series of moof+mdat pairs.',
  more: 'Unlike moov, which indexes the whole file up front, each moof describes only its own piece of media. That is what lets a file be written and streamed while it is still being produced: DASH, HLS with CMAF, live recording.',
});

def('mfhd', {
  name: 'Movie Fragment Header Box',
  cat: 'fragment',
  full: true,
  sec: '8.8.5',
  desc: 'The sequence number of this fragment; it goes up by one with every fragment.',
  parse(r, n) {
    n.data.seq = r.u32('sequence_number', { key: true });
    n.data.summary = `#${n.data.seq}`;
  },
});

def('traf', {
  name: 'Track Fragment Box',
  cat: 'fragment',
  sec: '8.8.6',
  container: true,
  desc: 'The part of a movie fragment that belongs to one track.',
});

def('tfhd', {
  name: 'Track Fragment Header Box',
  cat: 'fragment',
  full: true,
  sec: '8.8.7',
  flags: {
    0x1: 'base-data-offset-present', 0x2: 'sample-description-index-present', 0x8: 'default-sample-duration-present',
    0x10: 'default-sample-size-present', 0x20: 'default-sample-flags-present', 0x10000: 'duration-is-empty', 0x20000: 'default-base-is-moof',
  },
  flagsDesc: 'Which optional fields follow, plus: duration-is-empty (no samples), default-base-is-moof (data offsets count from the start of the moof).',
  desc: 'Which track this fragment is for, where its data starts, and default sample values for this fragment.',
  parse(r, n, ctx) {
    const f = n.data.flags;
    n.data.trackId = r.u32('track_ID', { key: true });
    ctx.trackId = n.data.trackId;
    if (f & 0x1) n.data.baseDataOffset = r.u64('base_data_offset', { ref: 'offset', display: (v) => `${fmtInt(v)} (${hex(v)})` });
    if (f & 0x2) n.data.sdi = r.u32('sample_description_index');
    if (f & 0x8) n.data.duration = r.u32('default_sample_duration');
    if (f & 0x10) n.data.size = r.u32('default_sample_size');
    if (f & 0x20) n.data.sampleFlags = r.u32('default_sample_flags', { display: sampleFlagsDisplay, desc: SAMPLE_FLAGS_DESC });
    n.data.summary = `track ${n.data.trackId}`;
  },
});

def('tfdt', {
  name: 'Track Fragment Decode Time Box',
  cat: 'fragment',
  full: true,
  sec: '8.8.12',
  desc: 'The decoding time of the fragment’s first sample, in the track’s timescale.',
  more: 'It lets a player place a fragment on the timeline without having seen the fragments before it, which is what makes seeking in live and segmented streams work.',
  parse(r, n) {
    n.data.time = n.data.version === 1 ? r.u64('baseMediaDecodeTime', { key: true }) : r.u32('baseMediaDecodeTime', { key: true });
    n.data.summary = `t=${fmtInt(n.data.time)}`;
  },
});

def('trun', {
  name: 'Track Fragment Run Box',
  cat: 'fragment',
  full: true,
  sec: '8.8.8',
  flags: {
    0x1: 'data-offset-present', 0x4: 'first-sample-flags-present', 0x100: 'sample-duration-present',
    0x200: 'sample-size-present', 0x400: 'sample-flags-present', 0x800: 'sample-composition-time-offsets-present',
  },
  flagsDesc: 'Which optional fields and per-sample columns are present. Absent values come from tfhd, then trex.',
  desc: 'The samples of this fragment: how many, where their data starts, and per-sample duration, size, flags and composition offset.',
  more: 'Only the columns selected by the flags are stored. For example, a video run often has sizes and composition offsets per sample but takes durations and flags from the defaults.',
  parse(r, n) {
    const f = n.data.flags;
    const count = r.u32('sample_count', { key: true });
    if (f & 0x1) n.data.dataOffset = r.i32('data_offset', { desc: 'Where this run’s data starts, relative to the base data offset (usually the start of the moof).' });
    if (f & 0x4) n.data.firstFlags = r.u32('first_sample_flags', { display: sampleFlagsDisplay, desc: 'Overrides the flags of the first sample only, typically to mark it as a key frame.' });
    const cols = [];
    if (f & 0x100) cols.push({ name: 'sample_duration', type: 'u32' });
    if (f & 0x200) cols.push({ name: 'sample_size', type: 'u32', display: (v) => `${fmtInt(v)} bytes` });
    if (f & 0x400) cols.push({ name: 'sample_flags', type: 'u32', display: sampleFlagsDisplay });
    if (f & 0x800) cols.push({ name: 'sample_composition_time_offset', type: n.data.version === 0 ? 'u32' : 'i32' });
    n.data.count = count;
    if (cols.length) n.data.table = r.table('samples', count, cols.length * 4, cols);
    n.data.summary = plural(count, 'sample');
  },
});

def('mfra', {
  name: 'Movie Fragment Random Access Box',
  cat: 'fragment',
  sec: '8.8.9',
  container: true,
  desc: 'An index at the end of a fragmented file listing the random access points of each track.',
});

def('tfra', {
  name: 'Track Fragment Random Access Box',
  cat: 'fragment',
  full: true,
  sec: '8.8.10',
  desc: 'Time → fragment position entries for one track, pointing at the moof that holds each random access point.',
  parse(r, n) {
    const big = n.data.version === 1;
    r.u32('track_ID', { key: true });
    r.bits(26, 'reserved', { reserved: true });
    const lt = r.bits(2, 'length_size_of_traf_num', { display: (v) => `${v} → ${v + 1} bytes` }) + 1;
    const lr = r.bits(2, 'length_size_of_trun_num', { display: (v) => `${v} → ${v + 1} bytes` }) + 1;
    const ls = r.bits(2, 'length_size_of_sample_num', { display: (v) => `${v} → ${v + 1} bytes` }) + 1;
    const count = r.u32('number_of_entry');
    r.table('entries', count, (big ? 16 : 8) + lt + lr + ls, [
      { name: 'time', type: big ? 'u64' : 'u32' },
      { name: 'moof_offset', type: big ? 'u64' : 'u32', ref: 'offset', display: (v) => `${fmtInt(v)} (${hex(v)})` },
      { name: 'traf_number', type: 'uN', size: lt },
      { name: 'trun_number', type: 'uN', size: lr },
      { name: 'sample_number', type: 'uN', size: ls },
    ]);
  },
});

def('mfro', {
  name: 'Movie Fragment Random Access Offset Box',
  cat: 'fragment',
  full: true,
  sec: '8.8.11',
  desc: 'The size of the enclosing mfra box, so a reader can find mfra by reading the last bytes of the file.',
  parse(r) {
    r.u32('parent_size', { unit: 'bytes' });
  },
});

def('sidx', {
  name: 'Segment Index Box',
  cat: 'fragment',
  full: true,
  sec: '8.16.3',
  desc: 'A table of subsegments (usually one per fragment) with their byte sizes and durations, so a player can seek inside a segment without downloading all of it.',
  more: 'DASH players fetch the sidx first, then request exactly the byte ranges they need. referenced_size values add up from the first byte after the sidx (plus first_offset).',
  parse(r, n) {
    const big = n.data.version === 1;
    r.u32('reference_ID', { desc: 'The track this index is for.' });
    const ts = r.u32('timescale', { unit: 'units per second' });
    r[big ? 'u64' : 'u32']('earliest_presentation_time', { display: (v) => durationDisplay(ts)(v) });
    r[big ? 'u64' : 'u32']('first_offset', { unit: 'bytes', desc: 'Distance from the end of this box to the first referenced byte.' });
    r.u16('reserved', { reserved: true });
    const count = r.u16('reference_count');
    r.table('references', count, 12, [
      { name: 'reference_type', type: 'bits', size: 4, bits: [0, 1], enum: { 0: 'media', 1: 'another sidx' } },
      { name: 'referenced_size', type: 'bits', size: 4, bits: [1, 31], last: true, display: (v) => `${fmtInt(v)} bytes` },
      { name: 'subsegment_duration', type: 'u32', display: (v) => durationDisplay(ts)(v) },
      { name: 'starts_with_SAP', type: 'bits', size: 4, bits: [0, 1] },
      { name: 'SAP_type', type: 'bits', size: 4, bits: [1, 3] },
      { name: 'SAP_delta_time', type: 'bits', size: 4, bits: [4, 28], last: true },
    ]);
    n.data.summary = plural(count, 'reference');
  },
});

def('ssix', {
  name: 'Subsegment Index Box',
  cat: 'fragment',
  full: true,
  sec: '8.16.4',
  desc: 'Maps levels (for example, I-frames only) to byte ranges inside each subsegment, for trick play.',
  parse(r) {
    const count = r.u32('subsegment_count');
    for (let i = 0; i < Math.min(count, 200); i++) {
      r.group(`subsegment[${i}]`, () => {
        const ranges = r.u32('range_count');
        r.table('ranges', ranges, 4, [{ name: 'level', type: 'u8' }, { name: 'range_size', type: 'u24' }]);
      });
    }
  },
});

def('prft', {
  name: 'Producer Reference Time Box',
  cat: 'fragment',
  full: true,
  sec: '8.16.5',
  desc: 'Pairs a wall-clock time (NTP) with a media time, so players can measure live latency.',
  parse(r, n) {
    r.u32('reference_track_ID');
    r.u64('ntp_timestamp', {
      display: (v) => {
        const secs = Math.floor(v / 2 ** 32) - 2208988800;
        return `${fmtInt(v)} → ${fmtDate(new Date(secs * 1000))}`;
      },
      desc: 'Wall-clock time in NTP format (seconds since 1900 in the top 32 bits).',
    });
    if (n.data.version === 0) r.u32('media_time');
    else r.u64('media_time');
  },
});

def('emsg', {
  name: 'Event Message Box',
  cat: 'fragment',
  full: true,
  spec: 'DASH',
  sec: '5.10.3.3',
  desc: 'An in-band event for the player, such as an ad marker (SCTE-35), ID3 metadata or a manifest update, identified by a scheme URI.',
  syntax: 'aligned(8) class DASHEventMessageBox extends FullBox(\'emsg\', version, flags = 0) {\n    if (version==0) {\n        string scheme_id_uri;\n        string value;\n        unsigned int(32) timescale;\n        unsigned int(32) presentation_time_delta;\n        unsigned int(32) event_duration;\n        unsigned int(32) id;\n    } else if (version==1) {\n        unsigned int(32) timescale;\n        unsigned int(64) presentation_time;\n        unsigned int(32) event_duration;\n        unsigned int(32) id;\n        string scheme_id_uri;\n        string value;\n    }\n    unsigned int(8) message_data[];\n}',
  parse(r, n) {
    let scheme;
    if (n.data.version === 0) {
      scheme = r.cstr('scheme_id_uri', { key: true });
      r.cstr('value');
      r.u32('timescale');
      r.u32('presentation_time_delta');
      r.u32('event_duration');
      r.u32('id');
    } else {
      r.u32('timescale');
      r.u64('presentation_time');
      r.u32('event_duration');
      r.u32('id');
      scheme = r.cstr('scheme_id_uri', { key: true });
      r.cstr('value');
    }
    if (r.remaining) r.rest('message_data');
    n.data.summary = scheme;
  },
});

def('mere', { name: 'Metabox Relation Box', cat: 'meta', full: true, sec: '8.11.8', desc: 'Describes how two meta boxes relate.' });

def('kind', {
  name: 'Track Kind Box',
  cat: 'header',
  full: true,
  sec: '8.10.4',
  desc: 'A role for the track from a named scheme, e.g. "main", "commentary" or "captions".',
  parse(r) {
    r.cstr('schemeURI');
    if (r.remaining) r.cstr('value', { key: true });
  },
});

def('tsel', {
  name: 'Track Selection Box',
  cat: 'header',
  full: true,
  sec: '8.10.3',
  desc: 'How this track differs from its alternatives (codec, bitrate, language...), to help a player choose.',
  parse(r) {
    r.i32('switch_group');
    let i = 0;
    while (r.remaining >= 4) r.fourcc(`attribute_list[${i++}]`);
  },
});

def('cprt', {
  name: 'Copyright Box',
  cat: 'meta',
  full: true,
  sec: '8.10.2',
  desc: 'A copyright notice, with its language.',
  parse(r, n) {
    language(r);
    n.data.summary = r.cstr('notice', { key: true });
  },
});

export { HANDLERS, SAMPLE_FLAGS_DESC, language, matrix, timeField, dateField, entryCount, flagNames, HEX2, fourccOf };
