// File insights for ISO-BMFF: layout, encoding, tracks, integrity and metadata.

import { fmtInt, fmtNum, fmtDuration, fmtBitrate, humanBytes, humanSize, pct, hex, fmtDate, date1904 } from '../../core/util.js';
import { walk } from '../../core/model.js';
import { brandInfo } from './registry.js';
import { ILST_NAMES } from './meta.js';
import { DRM_SYSTEMS } from './meta.js';
import { TRANSFER_CHARACTERISTICS } from '../../codecs/color.js';

const WRITERS = [
  [/^VideoHandler$|^SoundHandler$/, 'FFmpeg / libavformat'],
  [/^Core Media/, 'Apple (AVFoundation / Core Media)'],
  [/^ISO Media file produced by Google/, 'Google / YouTube'],
  [/GPAC/, 'GPAC / MP4Box'],
  [/Bento4/, 'Bento4'],
  [/L-SMASH/, 'L-SMASH'],
  [/Mainconcept|MainConcept/, 'MainConcept'],
  [/^Alias Data Handler$|^Apple (Video|Sound) Media Handler$/, 'Apple QuickTime'],
];

function findField(fields, name) {
  for (const f of fields ?? []) {
    if (f.name === name) return f;
    const x = findField(f.children, name);
    if (x) return x;
  }
  return null;
}

/** Encoder settings from the SEI of the first video sample (x264 / x265 write them there). */
async function encoderSei(doc) {
  for (const t of doc.tracks) {
    if (t.kind !== 'video' || !t.samples?.count || !['avc', 'hevc'].includes(t.sampleCfg?.family)) continue;
    const units = await doc.sampleUnits(t.index, 0);
    for (const u of units) {
      const f = findField(u.fields, 'user_data_payload');
      if (f && typeof f.value === 'string' && /x26[45]|options:/.test(f.value)) return { track: t, text: f.value, unit: u };
    }
  }
  return null;
}

function parseX26x(text) {
  const facts = [];
  const head = text.split(' - ')[0];
  const core = /core (\d+)(?: r(\d+))?/.exec(text);
  facts.push(['encoder', core ? `x264 core ${core[1]}${core[2] ? ` r${core[2]}` : ''}` : head.trim()]);
  const opts = new Map();
  const m = /options: (.*)$/s.exec(text);
  if (m) {
    for (const kv of m[1].trim().split(/\s+/)) {
      const i = kv.indexOf('=');
      if (i > 0) opts.set(kv.slice(0, i), kv.slice(i + 1));
      else opts.set(kv, '1');
    }
  }
  const rc = opts.get('rc');
  if (rc === 'crf' || opts.has('crf')) facts.push(['rate control', `CRF ${opts.get('crf')} (constant quality)`]);
  else if (rc === 'abr' || rc === 'cbr' || opts.has('bitrate')) facts.push(['rate control', `${(rc ?? 'abr').toUpperCase()} ${opts.get('bitrate') ?? ''} kb/s`]);
  else if (rc) facts.push(['rate control', rc]);
  if (opts.has('bframes')) facts.push(['B-frames', opts.get('bframes')]);
  if (opts.has('ref')) facts.push(['reference frames', opts.get('ref')]);
  if (opts.has('keyint')) facts.push(['max keyframe interval', `${opts.get('keyint')} frames`]);
  if (opts.has('open_gop') || opts.has('open-gop')) facts.push(['open GOP', opts.get('open_gop') ?? opts.get('open-gop')]);
  if (opts.has('cabac')) facts.push(['entropy coder', opts.get('cabac') === '1' ? 'CABAC' : 'CAVLC']);
  if (opts.has('subme') || opts.has('me')) facts.push(['motion search', `${opts.get('me') ?? ''}${opts.has('subme') ? `, subme ${opts.get('subme')}` : ''}`]);
  if (opts.has('threads')) facts.push(['threads', opts.get('threads')]);
  return { facts, options: opts.size };
}

function interleaving(doc) {
  const tracks = doc.tracks.filter((t) => t.samples?.count && t.samples.chunk && t.timescale && (t.kind === 'video' || t.kind === 'audio'));
  if (tracks.length < 2) return null;
  const chunks = [];
  for (const t of tracks) {
    const s = t.samples;
    let last = -1;
    for (let i = 0; i < s.count; i++) {
      if (s.chunk[i] !== last) {
        last = s.chunk[i];
        chunks.push({ off: s.offsets[i], t: s.dts[i] / t.timescale, track: t.index });
      }
    }
  }
  chunks.sort((a, b) => a.off - b.off);
  const lastT = new Map();
  let maxDrift = 0;
  let where = 0;
  for (const c of chunks) {
    lastT.set(c.track, c.t);
    if (lastT.size === tracks.length) {
      const ts = [...lastT.values()];
      const d = Math.max(...ts) - Math.min(...ts);
      if (d > maxDrift) {
        maxDrift = d;
        where = c.off;
      }
    }
  }
  const dur = Math.max(...tracks.map((t) => t.duration ?? 0));
  return { maxDrift, where, chunks: chunks.length, perChunk: dur && chunks.length ? (dur * tracks.length) / chunks.length : 0 };
}

export async function insights(doc) {
  const out = [];
  const add = (level, group, title, text, extra = {}) => out.push({ level, group, title, text, ...extra });
  const root = doc.root;
  const top = root.children ?? [];
  const ftyp = root.child('ftyp') ?? root.child('styp');
  const moov = root.child('moov');
  const mdats = root.childrenOf('mdat');
  const moofs = root.childrenOf('moof');
  const byType = new Map();
  for (const n of walk(root)) {
    if (!n.parent) continue;
    if (!byType.has(n.type)) byType.set(n.type, []);
    byType.get(n.type).push(n);
  }

  // ---------------------------------------------------------------- overview
  if (ftyp) {
    const major = ftyp.data.major;
    const b = brandInfo(major);
    add('info', 'Overview', `${doc.summary.label}, major brand '${major}'`, b ? `${b.desc} (${b.spec}).` : 'This brand is not in the mp4ra.org registry.', {
      facts: [
        ['major brand', `'${major}'${b ? ` — ${b.desc}` : ''}`],
        ['compatible', (ftyp.data.brands ?? []).map((x) => `'${x}'`).join(' ') || '—'],
      ],
      node: ftyp,
    });
  } else if (moov) {
    add('info', 'Overview', 'No ftyp box', 'The file starts without a file type box. That is normal for old QuickTime movies but unusual for MP4; some players identify files by it.', { node: top[0] });
  }

  const mvhd = moov?.child('mvhd');
  if (doc.summary.duration) {
    const facts = [['duration', fmtDuration(doc.summary.duration)], ['overall bitrate', fmtBitrate((doc.size * 8) / doc.summary.duration)]];
    if (mvhd?.data.timescale) facts.push(['movie timescale', `${fmtInt(mvhd.data.timescale)} / s`]);
    const created = mvhd ? date1904(findField(mvhd.fields, 'creation_time')?.value) : null;
    if (created) facts.push(['created', fmtDate(created)]);
    add('info', 'Overview', `${fmtDuration(doc.summary.duration)} long, ${fmtBitrate((doc.size * 8) / doc.summary.duration)} overall`, null, { facts, node: mvhd });
  }

  // Who wrote it
  const writerFacts = [];
  const tool = [...(byType.get('©too') ?? []), ...(byType.get('©swr') ?? [])][0];
  if (tool?.data.summary) writerFacts.push(['encoding tool tag', tool.data.summary]);
  const handlerNames = doc.tracks.map((t) => t.name).filter(Boolean);
  for (const [re, who] of WRITERS) {
    if (handlerNames.some((n) => re.test(n))) {
      writerFacts.push(['track handler names suggest', who]);
      break;
    }
  }
  const compressor = doc.tracks.find((t) => t.entry?.compressor)?.entry.compressor;
  if (compressor) writerFacts.push(['compressor name', compressor]);
  const sei = await encoderSei(doc).catch(() => null);
  if (sei) {
    const parsed = parseX26x(sei.text);
    writerFacts.push(...parsed.facts);
  }
  if (writerFacts.length) {
    add('info', 'Encoding', sei ? `Encoded with ${writerFacts.find(([k]) => k === 'encoder')?.[1] ?? 'x264/x265'}` : 'Who wrote this file', sei
      ? 'x264 and x265 store their exact version and every option they were run with in an SEI message in the first frame. Vidscope decoded it.'
      : 'Clues left by the software that wrote the file.', { facts: writerFacts, offset: sei ? sei.unit.offset : undefined });
  }

  // ---------------------------------------------------------------- layout
  if (moov && mdats.length && !moofs.length) {
    const firstMdat = mdats[0];
    if (moov.offset > firstMdat.offset) {
      add('warn', 'Layout', 'moov is at the end: no fast start', `The index (moov, ${humanSize(moov.size)}) comes after the media data. A player streaming this file over HTTP has to fetch the end of the file before it can show the first frame. Moving moov to the front fixes that without re-encoding.`, {
        node: moov,
        cmd: `ffmpeg -i "${doc.name}" -c copy -movflags +faststart "${doc.name.replace(/(\.\w+)$/, '-faststart$1')}"`,
      });
    } else {
      add('good', 'Layout', 'Fast start: moov before mdat', 'The index comes first, so playback can begin while the file is still downloading.', { node: moov });
    }
  }
  if (moofs.length) {
    const initEnd = moofs[0].offset;
    const durs = doc.tracks.map((t) => t.duration ?? 0);
    const dur = Math.max(0, ...durs);
    add('info', 'Layout', `Fragmented: ${fmtInt(moofs.length)} fragment${moofs.length === 1 ? '' : 's'}`, 'The media is split into movie fragments (moof + mdat pairs), each with its own small index. This is the layout used by DASH, HLS with fMP4/CMAF and live recording, and it survives a recording being cut off.', {
      facts: [
        ['initialization data', `${humanSize(initEnd)} (everything before the first moof)`],
        ['fragments', fmtInt(moofs.length)],
        dur ? ['average fragment', `${fmtNum(dur / moofs.length, 2)} s`] : null,
        root.child('sidx') ? ['segment index', 'sidx present (byte-range seeking for DASH)'] : ['segment index', 'no sidx'],
        root.child('mfra') ? ['random access index', 'mfra at the end of the file'] : null,
      ].filter(Boolean),
      node: moofs[0],
    });
  }
  if (moov) {
    const share = moov.size / doc.size;
    const level = share > 0.08 ? 'warn' : 'info';
    add(level, 'Layout', `Index size: ${humanSize(moov.size)} (${pct(moov.size, doc.size)} of the file)`, share > 0.08
      ? 'The movie box is unusually large compared with the media. Very short samples (e.g. uncompressed audio packets) or many tracks make the sample tables big, and a player must load all of it before playing.'
      : 'The movie box (the index: tracks, codecs and sample tables) is small compared with the media, as it should be.', { node: moov });
  }
  const free = [...(byType.get('free') ?? []), ...(byType.get('skip') ?? [])];
  const freeBytes = free.reduce((n, f) => n + f.size, 0);
  if (freeBytes > 1024) add('info', 'Layout', `${humanSize(freeBytes)} of free space`, 'Padding the writer reserved so that metadata can grow without rewriting the file. It can be removed safely.', { node: free[0] });

  const il = interleaving(doc);
  if (il) {
    if (il.maxDrift > 2) {
      add('warn', 'Layout', `Poorly interleaved: audio and video up to ${fmtNum(il.maxDrift, 1)} s apart`, 'Audio and video chunks are far apart in the file, so a player must read ahead a lot (or seek back and forth) to keep them in sync. That hurts progressive download and slow disks.', {
        facts: [['chunks', fmtInt(il.chunks)], ['worst drift at', hex(il.where)]],
        offset: il.where,
        cmd: `ffmpeg -i "${doc.name}" -c copy -movflags +faststart "${doc.name.replace(/(\.\w+)$/, '-remux$1')}"`,
      });
    } else {
      add('good', 'Layout', `Interleaved: tracks stay within ${fmtNum(il.maxDrift, 2)} s of each other`, `Chunks alternate between tracks (about ${fmtNum(il.perChunk, 2)} s of media per chunk), so reading the file front to back delivers audio and video together.`, { facts: [['chunks', fmtInt(il.chunks)]] });
    }
  }

  // Bytes of mdat not referenced by any sample
  if (mdats.length && doc.sampleIndex?.count) {
    let payload = 0;
    for (const m of mdats) payload += m.size - m.headerSize;
    let used = 0;
    for (const t of doc.tracks) if (t.bytes) used += t.bytes;
    const gap = payload - used;
    if (gap > 16) {
      add(gap > payload * 0.01 ? 'warn' : 'info', 'Integrity', `${humanSize(gap)} of media data not used by any sample`, 'No sample table points at these bytes of mdat. They can be padding, data from a removed track, or damage. Click in mdat in the hex view to find them (they show as "not part of any sample").', { node: mdats[0] });
    } else if (gap >= 0) {
      add('good', 'Integrity', 'Every media byte belongs to a sample', 'The sample tables account for all of the media data, with nothing unreferenced.', { node: mdats[0] });
    }
  }

  // 64-bit
  if (byType.has('co64') || top.some((n) => n.headerSize === 16 && n.type !== 'uuid')) {
    add('info', 'Layout', 'Uses 64-bit offsets', 'Large-file support: chunk offsets (co64) or box sizes (largesize) are 64-bit, needed beyond 4 GB.', { node: byType.get('co64')?.[0] });
  }

  // ---------------------------------------------------------------- tracks
  for (const t of doc.tracks) {
    const s = t.samples;
    const props = Object.fromEntries(t.props);
    const bits = [props.profile, props['coded size'], props['frame rate'], props['sample rate'], props.channels, t.duration ? fmtDuration(t.duration) : null, t.bitrate ? fmtBitrate(t.bitrate) : null].filter(Boolean);
    add('info', 'Tracks', `${t.label}: ${t.codecName}`, bits.join(' · '), { node: t.node, facts: t.codecString ? [['codec string', t.codecString]] : undefined });

    if (t.kind === 'video' && s?.count > 1) {
      // Key frame intervals and GOPs are reported for every format by web/core/frames.js.
      if (s.cto) add('info', 'Tracks', `${t.label}: uses B-frames`, 'Frames are stored in decoding order, which differs from display order. ctts (or trun) holds each frame’s composition offset, and an edit list usually hides the resulting start delay.', { node: t.node.find('ctts') ?? t.node });
      if (t.vfr) add('info', 'Timing', `${t.label}: variable frame rate`, 'Frame durations differ (stts has several entries). Common for phone and screen recordings; some editors and older players assume a constant rate and drift.', { node: t.node.find('stts') });
    }

    // Edit lists
    const elst = t.node.find('elst');
    if (elst?.data.table && elst.data.table.count) {
      const tbl = elst.data.table;
      const mt = [];
      for (let i = 0; i < tbl.count; i++) {
        const big = tbl.entrySize === 20;
        const p = tbl.rel + i * tbl.entrySize;
        const dur = big ? Number(tbl.dv.getBigUint64(p)) : tbl.dv.getUint32(p);
        const media = big ? Number(tbl.dv.getBigInt64(p + 8)) : tbl.dv.getInt32(p + 4);
        mt.push({ dur, media });
      }
      const ts = t.timescale;
      const empty = mt.filter((e) => e.media === -1);
      if (mt.length > 2 || (mt.length === 2 && !empty.length)) {
        add('warn', 'Timing', `${t.label}: ${mt.length} edits`, 'This edit list cuts the media into several pieces. Editors create these; many players and tools support only a single edit and show the full media instead.', { node: elst });
      } else if (empty.length) {
        const movieTs = moov?.child('mvhd')?.data.timescale || 1;
        add('info', 'Timing', `${t.label}: starts ${fmtNum((empty[0].dur / movieTs) * 1000, 1)} ms late`, 'An empty edit delays the track on the timeline, usually to keep it in sync with another track.', { node: elst });
      } else if (mt[0] && mt[0].media > 0 && ts) {
        const ms = (mt[0].media / ts) * 1000;
        const aac = t.kind === 'audio' && t.codec === 'mp4a';
        add('info', 'Timing', `${t.label}: skips the first ${fmtNum(ms, 2)} ms of its media`, aac
          ? `The edit list starts playback ${fmtInt(mt[0].media)} samples in, to hide the AAC encoder’s priming samples (silence the encoder adds at the start). Players that ignore edit lists play it and drift out of sync.`
          : 'The edit list starts playback after the start of the media, usually to hide the decoding delay that B-frames introduce, so that the first frame shows at time 0.', { node: elst });
      }
    }

    if (t.fourcc === 'hev1' || t.fourcc === 'dvhe') {
      add('warn', 'Tracks', `${t.label}: tagged '${t.fourcc}', which Apple players reject`, 'With hev1 the parameter sets may appear inside the samples. QuickTime, Safari and iOS only play HEVC tagged hvc1 (parameter sets only in hvcC). Retagging needs no re-encode if the samples carry no in-band parameter sets.', {
        node: t.entryNode,
        cmd: `ffmpeg -i "${doc.name}" -c copy -tag:v hvc1 "${doc.name.replace(/(\.\w+)$/, '-hvc1$1')}"`,
      });
    }
    const c = t.entry?.colr ?? t.sps?.vui;
    if (c && (c.transfer === 16 || c.transfer === 18)) {
      add('info', 'Tracks', `${t.label}: HDR (${c.transfer === 16 ? 'PQ / HDR10' : 'HLG'})`, `The transfer function is ${TRANSFER_CHARACTERISTICS[c.transfer]}. Displays without HDR support need tone mapping.`, { node: t.entryNode });
    }
    if (t.encrypted) {
      add('info', 'Tracks', `${t.label}: encrypted (${t.entry.scheme ?? 'CENC'})`, `The samples are encrypted; the original codec is '${t.codec}'. Without the key only the container structure and clear headers are readable.`, { node: t.entryNode, facts: t.entry.kid ? [['key ID', t.entry.kid.replace(/-/g, '')]] : undefined });
    }
    for (const p of s?.problems ?? []) add('bad', 'Integrity', `${t.label}: ${p}`, 'The sample tables disagree with each other, so some samples cannot be located or timed correctly.', { node: t.node.find('stbl') });

    if (s?.count) {
      let beyond = 0;
      for (let i = 0; i < s.count; i++) if (s.offsets[i] + s.sizes[i] > doc.size) beyond++;
      if (beyond) add('bad', 'Integrity', `${t.label}: ${fmtInt(beyond)} samples lie past the end of the file`, 'The index points beyond the last byte: the file was cut short (an interrupted download or recording).', { node: t.node });
    }
  }

  // A/V start and duration alignment
  const av = doc.tracks.filter((t) => (t.kind === 'video' || t.kind === 'audio') && t.duration);
  if (av.length >= 2) {
    const d = av.map((t) => t.duration);
    const diff = Math.max(...d) - Math.min(...d);
    if (diff > 0.25) add('info', 'Timing', `Track lengths differ by ${fmtNum(diff, 2)} s`, `${av.map((t) => `${t.label} ${fmtDuration(t.duration)}`).join(', ')}. Players show the longest; the shorter track ends early.`);
  }

  // ---------------------------------------------------------------- metadata
  const ilst = byType.get('ilst')?.[0];
  const tags = [];
  for (const n of ilst?.children ?? []) if (n.data.summary) tags.push([ILST_NAMES[n.type] ?? n.name.replace(/ \(tag\)$/, '').replace(/^key \d+: /, ''), n.data.summary]);
  for (const n of byType.get('udta') ?? []) for (const c of n.children ?? []) if (c.type.startsWith('©') && c.data.summary && c.def?.id?.startsWith('qttext')) tags.push([ILST_NAMES[c.type] ?? c.type, c.data.summary]);
  if (tags.length) add('info', 'Metadata', `${tags.length} metadata tag${tags.length === 1 ? '' : 's'}`, null, { facts: tags.slice(0, 16), node: ilst ?? byType.get('udta')?.[0] });
  const chpl = byType.get('chpl')?.[0];
  if (chpl?.data.chapters?.length) add('info', 'Metadata', `${chpl.data.chapters.length} chapters (Nero chpl)`, null, { facts: chpl.data.chapters.slice(0, 12).map((c) => [fmtDuration(c.t), c.title]), node: chpl });
  const chapTrack = doc.tracks.find((t) => t.node.parent && doc.tracks.some((o) => o.node.find('tref')?.children?.some((r) => r.type === 'chap' && r.data.ids?.includes(t.id))));
  if (chapTrack) add('info', 'Metadata', `${chapTrack.label} holds chapter titles`, 'A QuickTime-style chapter track: another track points to it with a \'chap\' track reference, and each sample is one chapter title.', { node: chapTrack.node });
  const pssh = byType.get('pssh') ?? [];
  if (pssh.length) add('info', 'Metadata', `DRM: ${[...new Set(pssh.map((p) => p.data.system))].join(', ')}`, 'pssh boxes carry licence-acquisition data for each DRM system that can decrypt this file.', { node: pssh[0] });

  // ---------------------------------------------------------------- integrity
  const warned = [];
  for (const n of walk(root)) for (const w of n.warnings) warned.push([n, w]);
  for (const [n, w] of warned.slice(0, 12)) add(/truncated|past the end|don't look like/.test(w) ? 'bad' : 'warn', 'Integrity', `${n.type} at ${hex(n.offset, 1)}`, w, { node: n });
  if (warned.length > 12) add('warn', 'Integrity', `${warned.length - 12} more warnings`, 'Look for ⚠ marks in the structure tree.');
  if (!warned.length) add('good', 'Integrity', 'No structural problems found', 'Every box has a valid size and type, fits inside its parent and parses completely.');
  const unknown = [...byType.entries()].filter(([, nodes]) => nodes[0].def && !nodes[0].def.known && !nodes[0].def.registered && nodes[0].kind === 'box');
  if (unknown.length) add('info', 'Integrity', `${unknown.length} unregistered box type${unknown.length === 1 ? '' : 's'}`, 'Types that are neither registered at mp4ra.org nor known to Vidscope. Readers skip boxes they do not understand, so this is normally harmless.', { facts: unknown.slice(0, 10).map(([t, nodes]) => [t, `${nodes.length}× at ${hex(nodes[0].offset, 1)}`]), node: unknown[0][1][0] });

  return out;
}

export { DRM_SYSTEMS, humanBytes };
