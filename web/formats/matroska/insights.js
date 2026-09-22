// File Insights for Matroska / WebM: layout, seeking (SeekHead, Cues), Clusters,
// timing, WebM compliance, integrity (CRC-32, damage) and metadata.

import { walk } from '../../core/model.js';
import { fmtInt, fmtNum, fmtDate, humanBytes, quote, plural } from '../../core/util.js';
import { clock, fmtNs, tickName, dateFromNs, crcHex, hexId, readHeader, readUint } from './ebml.js';
import { BY_ID } from './elements.js';
import { isWebmCodec, NEEDS_PRIVATE } from './codecs.js';
import { lowerBound } from './samples.js';
import { languageName } from './values.js';

const LEVEL1 = new Set(['SeekHead', 'Info', 'Tracks', 'Cluster', 'Cues', 'Attachments', 'Chapters', 'Tags']);

function writerOf(app) {
  if (!app) return null;
  if (/^Lavf/.test(app)) return 'FFmpeg (libavformat)';
  if (/mkvmerge|mkvpropedit|mkvtoolnix/i.test(app)) return 'MKVToolNix';
  if (/libebml|libmatroska/.test(app)) return 'MKVToolNix / libmatroska';
  if (/^Chrome/.test(app)) return 'Chrome (MediaRecorder)';
  if (/QTmuxingAppLibWebM|QTwritingAppLibWebM/.test(app)) return 'a libwebm-based recorder (e.g. Firefox MediaRecorder)';
  if (/libwebm/.test(app)) return 'libwebm';
  if (/GStreamer/i.test(app)) return 'GStreamer';
  if (/HandBrake/i.test(app)) return 'HandBrake';
  if (/OBS/.test(app)) return 'OBS Studio';
  if (/Firefox|Mozilla/.test(app)) return 'Firefox (MediaRecorder)';
  return null;
}

function val(node, name) {
  return node?.children?.find((c) => c.type === name)?.data.value;
}

/** Cue points read straight from the bytes of a (large, not yet opened) Cues element. */
async function rawCuePoints(doc, cues, out) {
  const u8 = await doc.source.read(cues.bodyOffset, Math.min(cues.bodySize, 64 << 20));
  const walk = (s, e, fn) => {
    for (let p = s; p < e;) {
      const h = readHeader(u8, p, e);
      if (h.error || h.unknown) return;
      const ds = p + h.headerSize;
      const de = Math.min(ds + h.size, e);
      fn(h.id, ds, de);
      p = de;
    }
  };
  const uint = (ds, de) => (de - ds <= 8 ? readUint(u8, ds, de - ds).value : undefined);
  walk(0, u8.length, (id, s, e) => {
    if (id !== 0xbb) return;
    let time;
    const tps = [];
    walk(s, e, (cid, cs, ce) => {
      if (cid === 0xb3) time = uint(cs, ce);
      else if (cid === 0xb7) {
        const tp = {};
        walk(cs, ce, (tid, ts, te) => {
          if (tid === 0xf7) tp.track = uint(ts, te);
          else if (tid === 0xf1) tp.cluster = uint(ts, te);
          else if (tid === 0xf0) tp.rel = uint(ts, te);
          else if (tid === 0x5378) tp.block = uint(ts, te);
        });
        tps.push(tp);
      }
    });
    for (const tp of tps) out.push({ node: cues, time, ...tp });
  });
}

/** Cue points from the Cues nodes (or from the bytes of Cues that were not opened). */
async function cuePoints(doc, seg) {
  const out = [];
  for (const cues of seg.cues) {
    if (cues.lazy) {
      await rawCuePoints(doc, cues, out);
      continue;
    }
    for (const cp of cues.childrenOf('CuePoint')) {
      const time = val(cp, 'CueTime');
      for (const tp of cp.childrenOf('CueTrackPositions')) {
        out.push({ node: cp, time, track: val(tp, 'CueTrack'), cluster: val(tp, 'CueClusterPosition'), rel: val(tp, 'CueRelativePosition'), block: val(tp, 'CueBlockNumber') });
      }
    }
  }
  return out;
}

/** Check each cue point against the Clusters and the frame tables. */
function checkCues(doc, seg, cues) {
  const bad = [];
  let ok = 0;
  let exact = 0;
  const clusterAt = new Map(seg.clusters.map((c) => [c.offset, c]));
  for (const c of cues) {
    const abs = seg.dataStart + (c.cluster ?? -1e15);
    const cl = clusterAt.get(abs);
    const t = seg.trackByNumber.get(c.track);
    if (!cl) {
      bad.push(`${clock((c.time * seg.timestampScale) / 1e9)}: CueClusterPosition ${fmtInt(c.cluster ?? 0)} (offset ${fmtInt(abs)}) is not the start of a Cluster`);
      continue;
    }
    if (!t) {
      bad.push(`${clock((c.time * seg.timestampScale) / 1e9)}: track ${c.track} does not exist`);
      continue;
    }
    const s = t.samples;
    if (!s || !s.count) {
      ok++;
      continue;
    }
    let i = -1;
    if (c.rel !== undefined) {
      const blockPos = cl.bodyOffset + c.rel;
      const k = lowerBound(s.block, s.count, blockPos);
      if (k < s.count && s.block[k] === blockPos) i = k;
      else {
        bad.push(`${clock((c.time * seg.timestampScale) / 1e9)}: CueRelativePosition ${fmtInt(c.rel)} does not point at a block of ${t.short}`);
        continue;
      }
    } else {
      // No relative position: look for the frame with this timestamp inside the Cluster.
      const from = lowerBound(s.offsets, s.count, cl.offset);
      for (let k = from; k < s.count && s.offsets[k] < cl.end; k++) {
        if (s.pts[k] === c.time) {
          i = k;
          break;
        }
      }
      if (i < 0) {
        bad.push(`${clock((c.time * seg.timestampScale) / 1e9)}: no ${t.short} frame with this time in the Cluster at ${fmtInt(cl.offset)}`);
        continue;
      }
    }
    if (s.pts[i] !== c.time) {
      bad.push(`${clock((c.time * seg.timestampScale) / 1e9)}: the block it points at is at ${clock(s.pts[i] / s.timescale)}`);
      continue;
    }
    if (t.kind === 'video' && !s.key[i]) {
      bad.push(`${clock((c.time * seg.timestampScale) / 1e9)}: points at a ${t.short} frame that is not a key frame`);
      continue;
    }
    ok++;
    exact++;
  }
  return { ok, bad, exact };
}

export async function insights(doc) {
  const out = [];
  const add = (level, group, title, text, extra = {}) => out.push({ level, group, title, text, ...extra });
  const ctx = doc.ctx;
  const h = ctx.header;
  const seg = ctx.segments[0];
  const webm = h?.docType === 'webm';
  const scan = doc.scan;
  const name = webm ? 'WebM' : 'Matroska';

  // ------------------------------------------------------------ Overview
  if (!h) {
    add(ctx.bare ? 'warn' : 'bad', 'Overview', 'No EBML header', ctx.bare
      ? 'The file starts directly with top-level elements (such as Clusters), without an EBML header, Info or Tracks. It is probably a media segment of a WebM/Matroska stream (DASH, HLS or Media Source Extensions), which needs the matching initialization segment to be played.'
      : 'A Matroska file must start with an EBML header declaring its DocType; this one does not, so players may refuse it.');
  } else {
    const facts = [
      ['DocType', `"${h.docType}"`], ['DocTypeVersion', String(h.docTypeVersion)], ['DocTypeReadVersion', String(h.docTypeReadVersion)],
      ['EBMLVersion / ReadVersion', `${h.version} / ${h.readVersion}`], ['EBMLMaxIDLength', String(h.maxIdLength)], ['EBMLMaxSizeLength', String(h.maxSizeLength)],
    ];
    add('info', 'Overview', `${name} file: Matroska v${h.docTypeVersion} elements, readable by v${h.docTypeReadVersion} players`,
      `DocTypeVersion says which Matroska version the writer used (the highest version of any element in the file); DocTypeReadVersion is the minimum a player needs. ${h.docTypeReadVersion < h.docTypeVersion ? `A v${h.docTypeReadVersion} player can play this file and simply skip newer elements (such as CueRelativePosition, Colour or CodecDelay from v4).` : ''}`,
      { facts, node: h.node });
    // Elements newer than the declared DocTypeVersion.
    let maxVer = 1;
    let maxEl = null;
    for (const n of walk(doc.root)) {
      const v = n.data.el?.minver;
      if (v && v > maxVer && v < 5) {
        maxVer = v;
        maxEl = n.data.el.name;
      }
    }
    if (scan && scan.blocks > scan.groups && maxVer < 2) {
      maxVer = 2;
      maxEl = 'SimpleBlock';
    }
    if (maxVer > h.docTypeVersion) {
      add('warn', 'Integrity', `DocTypeVersion ${h.docTypeVersion} is too low: ${maxEl} needs v${maxVer}`, `DocTypeVersion must be at least the highest Matroska version of any element in the file. Some players use it to decide which elements to expect.`, { node: h.node });
    }
    if (h.docType !== 'matroska' && h.docType !== 'webm') add('bad', 'Overview', `Unexpected DocType "${h.docType}"`, 'Matroska players expect "matroska" or "webm".', { node: h.node });
  }
  if (ctx.segments.length > 1) {
    add('info', 'Overview', `${ctx.segments.length} Segments in one file`, 'The file is an EBML stream: several complete documents (EBML header + Segment) one after another, as produced by concatenating files or by live streams that restart their Segment. Many players only read the first one.', { facts: ctx.segments.map((s, i) => [`Segment ${i + 1}`, `offset ${fmtInt(s.node.offset)}, ${s.tracks.length} tracks, ${s.clusters.length} Clusters`]) });
  }
  if (seg?.info) {
    const mux = val(seg.info, 'MuxingApp');
    const wr = val(seg.info, 'WritingApp');
    const who = writerOf(wr) ?? writerOf(mux);
    const date = val(seg.info, 'DateUTC');
    const facts = [['MuxingApp', mux ?? '—'], ['WritingApp', wr ?? '—']];
    if (date !== undefined) facts.push(['DateUTC', fmtDate(dateFromNs(date))]);
    add('info', 'Overview', who ? `Written by ${who}` : `Written by ${wr ?? mux ?? 'an unknown program'}`, 'MuxingApp names the library that wrote the Matroska structure, WritingApp the application. Knowing the writer explains many details: FFmpeg writes CRC-32s in Matroska (not WebM) files and a DURATION tag per track, MKVToolNix writes statistics tags, browsers recording with MediaRecorder write live-style files without Cues or Duration.', { facts, node: seg.info });
  }

  if (!seg) return out;
  const level1 = seg.level1;
  const bare = !!seg.bare;

  // ------------------------------------------------------------ Layout
  if (!bare) {
    const order = [];
    for (const n of seg.node.children ?? []) {
      const last = order[order.length - 1];
      if (last && last.type === n.type && n.type === 'Cluster') last.count++;
      else order.push({ type: n.type, count: 1, node: n });
    }
    const text = order.map((o) => (o.count > 1 ? `${fmtInt(o.count)} ${o.type}s` : o.type)).join(' → ');
    const firstCluster = seg.clusters[0];
    const before = (type) => {
      const n = level1.find((x) => x.type === type);
      return n && (!firstCluster || n.offset < firstCluster.offset);
    };
    const seekHeadFirst = seg.seekHeads.length && (!firstCluster || seg.seekHeads[0].offset < firstCluster.offset);
    const ok = (before('Info') && before('Tracks')) || seekHeadFirst;
    add(ok ? 'good' : 'warn', 'Layout', ok ? 'Metadata before the media' : 'Info or Tracks come after the media', `Top-level elements in file order: ${text}. ${ok ? 'Info and Tracks come before the first Cluster, so a player knows the codecs before it meets the first frame and can start playing (or streaming over HTTP) straight away.' : 'RFC 9559 § 6.1 requires Info and Tracks before the first Cluster, or a SeekHead before the first Cluster that points to them; otherwise a player has to read the whole file before it can decode anything.'}`, {
      facts: order.slice(0, 16).map((o) => [o.type, o.count > 1 ? `${fmtInt(o.count)} elements from ${fmtInt(o.node.offset)}` : `offset ${fmtInt(o.node.offset)}, ${humanBytes(o.node.size)}`]),
    });
  }
  // SeekHead
  if (!bare) {
    const seeks = seg.seekHeads.flatMap((sh) => sh.childrenOf('Seek'));
    const targets = new Map(level1.map((n) => [n.offset, n]));
    const bad = [];
    const listed = new Set();
    for (const s of seeks) {
      const id = val(s, 'SeekID');
      const pos = val(s, 'SeekPosition');
      const abs = seg.dataStart + (pos ?? 0);
      const n = targets.get(abs);
      const want = BY_ID.get(id)?.name ?? (id !== undefined ? hexId(id) : '?');
      if (!n) bad.push([want, `points to offset ${fmtInt(abs)}, where no top-level element starts`]);
      else if (n.data.id !== id) bad.push([want, `points to offset ${fmtInt(abs)}, which holds ${n.type}`]);
      else listed.add(n);
    }
    const missing = level1.filter((n) => LEVEL1.has(n.type) && n.type !== 'Cluster' && n !== seg.seekHeads[0] && !listed.has(n));
    if (!seg.seekHeads.length) {
      const late = level1.filter((n) => ['Cues', 'Tags', 'Chapters', 'Attachments'].includes(n.type) && seg.clusters.length && n.offset > seg.clusters[0].offset);
      add(late.length ? 'warn' : 'info', 'Layout', 'No SeekHead', `Without a SeekHead a player cannot know where the top-level elements are. ${late.length ? `This file has ${late.map((n) => n.type).join(', ')} after the media, which a player can only find by reading through all the Clusters.` : 'Here everything a player needs comes before the media, so it does little harm.'}${webm ? ' WebM muxers should always write one.' : ''}`);
    } else if (bad.length) {
      add('bad', 'Layout', `${bad.length} SeekHead entr${bad.length === 1 ? 'y is' : 'ies are'} wrong`, 'Players trust the SeekHead to find Cues, Tags, Chapters and Attachments. A wrong entry usually comes from editing a file without updating the index: seeking or metadata may silently stop working.', { facts: bad, node: seg.seekHeads[0], cmd: 'mkvmerge -o fixed.mkv input.mkv' });
    } else {
      add(missing.length ? 'warn' : 'good', 'Layout', missing.length ? `SeekHead does not list ${missing.map((n) => n.type).join(', ')}` : `SeekHead: all ${seeks.length} entries point to the right elements`, missing.length ? 'RFC 9559 § 6.3 says the SeekHead(s) must list every top-level element (apart from the first SeekHead). A player that relies on the index may not find the missing ones without scanning the file.' : 'The index at the start of the Segment lists every non-Cluster top-level element at its exact position, so a player can jump straight to the Cues, Tags or Chapters.', { node: seg.seekHeads[0], facts: seeks.map((s) => [BY_ID.get(val(s, 'SeekID'))?.name ?? '?', `offset ${fmtInt(seg.dataStart + (val(s, 'SeekPosition') ?? 0))}`]) });
    }
  }
  // Void
  {
    let bytes = 0;
    let count = 0;
    let afterSeekHead = null;
    for (const n of walk(seg.node)) {
      if (n.type !== 'Void') continue;
      bytes += n.size;
      count++;
      const prev = n.parent?.children?.[n.parent.children.indexOf(n) - 1];
      if (prev?.type === 'SeekHead') afterSeekHead = n;
    }
    if (count) {
      add('info', 'Layout', `${fmtInt(bytes)} bytes of Void padding in ${count} element${count > 1 ? 's' : ''}`, `Void elements are reserved space that players skip. ${afterSeekHead ? `The ${fmtInt(afterSeekHead.size)}-byte Void right after the SeekHead leaves room for the index to grow (to list Tags or Chapters added later) without moving the media, as RFC 9559 § 25.2 recommends.` : 'Writers leave them to be able to rewrite or grow elements in place.'}`, { node: afterSeekHead ?? undefined });
    }
  }
  // Unknown sizes / live
  {
    const unknownClusters = seg.clusters.filter((c) => c.data.unknownSize).length;
    if ((seg.unknownSize && !bare) || unknownClusters) {
      const parts = [];
      if (seg.unknownSize && !bare) parts.push('the Segment');
      if (unknownClusters) parts.push(`${fmtInt(unknownClusters)} Cluster${unknownClusters > 1 ? 's' : ''}`);
      add('warn', 'Layout', `Live-style file: ${parts.join(' and ')} of unknown size`, 'A live muxer (browser MediaRecorder, a streaming encoder, FFmpeg with -live 1) writes elements before knowing how big they will be and marks their size as unknown (all value bits set). Readers then find where an element ends by looking for the first element that cannot be inside it, which means reading every block: seeking and duration are slow or unavailable. Remuxing writes real sizes, a Duration and Cues.', { node: seg.node, cmd: `ffmpeg -i input.${webm ? 'webm' : 'mkv'} -c copy output.${webm ? 'webm' : 'mkv'}` });
    }
  }
  if (seg.truncated) {
    add('bad', 'Integrity', 'The file is truncated', `The Segment declares ${fmtInt(seg.truncated)} more bytes than the file contains: the end of the file is missing (an interrupted download or recording). The last Cluster is cut and the Cues, if they were at the end, are lost.`, { node: seg.node, cmd: `ffmpeg -i input.mkv -c copy repaired.mkv` });
  }
  for (const g of ctx.garbage.slice(0, 4)) {
    add('bad', 'Integrity', `${fmtInt(g.size)} unreadable bytes at offset ${fmtInt(g.offset)}`, g.msg, { offset: g.offset });
  }

  // ------------------------------------------------------------ Cues (seeking)
  const cueNodes = seg.cues;
  const cues = cueNodes.length ? await cuePoints(doc, seg) : [];
  if (!cueNodes.length && !bare) {
    add('warn', 'Layout', 'No Cues: seeking needs a scan', `Without the Cues index a player can only seek by guessing a byte position and searching for the next Cluster, which is slow over a network and imprecise.${webm ? ' The WebM guidelines tell players to disable seeking in files without Cues.' : ''} This is normal for live recordings; remuxing adds the index.`, { cmd: `ffmpeg -i input.${webm ? 'webm' : 'mkv'} -c copy output.${webm ? 'webm' : 'mkv'}` });
  } else if (cueNodes.length) {
    const c = cueNodes[0];
    const front = seg.clusters.length && c.offset < seg.clusters[0].offset;
    const tracks = [...new Set(cues.map((x) => x.track))].map((n) => seg.trackByNumber.get(n)?.short ?? `track ${n}`);
    const rel = cues.filter((x) => x.rel !== undefined).length;
    add('good', 'Layout', `Cues ${front ? 'before the Clusters' : 'after the Clusters'}: ${plural(cues.length, 'seek point')}`, `${front ? 'The index comes before the media, so a player streaming over HTTP can seek anywhere with a single request.' : 'The index was written at the end, once all positions were known (the usual choice); the SeekHead tells players where it is, and they read it when the user first seeks.'} ${rel ? `${rel === cues.length ? 'Every cue point also gives' : `${fmtInt(rel)} of the cue points also give`} the block's position inside its Cluster (CueRelativePosition), so a player can jump straight to the frame.` : 'No CueRelativePosition: players must read from the start of the Cluster to find the frame.'}`, {
      node: c,
      facts: [['cue points', fmtInt(cues.length)], ['tracks indexed', tracks.join(', ')], ['size', humanBytes(c.size)]],
      cmd: webm && !front ? 'ffmpeg -i input.webm -c copy -cues_to_front 1 output.webm' : undefined,
    });
    if (scan) {
      const r = checkCues(doc, seg, cues);
      if (r.bad.length) {
        add('bad', 'Integrity', `${fmtInt(r.bad.length)} of ${plural(cues.length, 'cue point')} ${r.bad.length === 1 ? 'is' : 'are'} wrong`, 'Seeking to these times will land in the wrong place, start on a frame that cannot be decoded alone, or fail. This happens when a file is edited without rebuilding its index.', { facts: r.bad.slice(0, 8).map((b, i) => [`#${i + 1}`, b]), node: c, cmd: 'mkvmerge -o fixed.mkv input.mkv' });
      } else if (cues.length) {
        add('good', 'Integrity', cues.length === 1 ? 'The cue point points at the right frame' : `All ${fmtInt(cues.length)} cue points point at the right frames`, 'Every cue point names a Cluster that exists and a frame of the right track with exactly the cue\'s timestamp; video cue points land on key frames.', { node: c });
      }
      for (const t of seg.tracks) {
        if (t.kind !== 'video' || !t.samples?.count) continue;
        const indexed = new Set(cues.filter((x) => x.track === t.id).map((x) => x.time));
        let keys = 0;
        let covered = 0;
        for (let i = 0; i < t.samples.count; i++) {
          if (!t.samples.key[i]) continue;
          keys++;
          if (indexed.has(t.samples.pts[i])) covered++;
        }
        if (keys && covered < keys) {
          add('info', 'Layout', `${t.short}: ${fmtInt(covered)} of ${fmtInt(keys)} key frames are in the Cues`, 'RFC 9559 § 22.1 recommends indexing every video key frame; seeking to an unindexed key frame means starting from an earlier one and decoding forward.');
        }
      }
    }
  }

  // ------------------------------------------------------------ Clusters
  if (scan && scan.clusters.length) {
    const cl = scan.clusters;
    let sumDur = 0;
    let maxDur = 0;
    let maxSize = 0;
    let sumSize = 0;
    let startKey = 0;
    let withVideo = 0;
    for (const c of cl) {
      const st = c.stats;
      sumSize += c.size;
      maxSize = Math.max(maxSize, c.size);
      if (st.firstVideoKey !== null) {
        withVideo++;
        if (st.firstVideoKey) startKey++;
      }
    }
    // Duration of a Cluster: from its timestamp to the next Cluster's (the last one: to the end of the media).
    const scale = seg.timestampScale;
    const endTicks = doc.tracks.reduce((m, t) => Math.max(m, t.endPts ?? -Infinity), -Infinity);
    for (let i = 0; i < cl.length; i++) {
      const a = cl[i].ts ?? 0;
      const b = i + 1 < cl.length ? cl[i + 1].ts ?? a : Number.isFinite(endTicks) ? endTicks : a;
      const d = Math.max(0, b - a);
      sumDur += d;
      maxDur = Math.max(maxDur, d);
    }
    const avgDur = (sumDur / cl.length) * scale / 1e9;
    const avgSize = sumSize / cl.length;
    const big = avgDur > 5 || avgSize > 5 * 1024 * 1024;
    add(big ? 'warn' : 'info', 'Layout', cl.length === 1 ? `1 Cluster of ${fmtNum(avgDur, 2)} s and ${humanBytes(Math.round(avgSize))}` : `${fmtInt(cl.length)} Clusters, ${fmtNum(avgDur, 2)} s and ${humanBytes(Math.round(avgSize))} on average`, `Clusters are the unit of seeking: a player jumps to the start of a Cluster and reads from there. RFC 9559 § 25.1 recommends at most 5 seconds or 5 MB per Cluster; ${big ? 'these are larger, so seeking reads more data than needed.' : 'these are within that.'} The largest is ${fmtNum((maxDur * scale) / 1e9, 2)} s / ${humanBytes(maxSize)}.`, {
      facts: [['Clusters', fmtInt(cl.length)], ['average duration', `${fmtNum(avgDur, 3)} s`], ['longest', `${fmtNum((maxDur * scale) / 1e9, 3)} s`], ['average size', humanBytes(Math.round(avgSize))], ['largest', humanBytes(maxSize)], ['blocks', fmtInt(scan.blocks)]],
    });
    if (withVideo) {
      const all = startKey === withVideo;
      add(all ? 'good' : webm ? 'warn' : 'info', 'Layout', all ? 'Every Cluster starts with a video key frame' : `${fmtInt(startKey)} of ${fmtInt(withVideo)} Clusters start with a video key frame`, all ? 'A player that seeks to a Cluster can start decoding video immediately, without reading back to an earlier key frame.' : `Seeking to a Cluster that does not start with a key frame means decoding from an earlier Cluster (or skipping frames until the next key frame).${webm ? ' The WebM guidelines ask for key frames at the beginning of Clusters.' : ''}`);
    }
    if (scan.relMax > 30000 || scan.relMin < -30000) {
      add('info', 'Timing', 'Block timestamps close to the 16-bit limit', `Block timestamps are signed 16-bit offsets from the Cluster Timestamp (−32,768 to 32,767 ticks). This file uses offsets from ${scan.relMin} to ${scan.relMax}: Clusters are about as long as they can be.`);
    }
  }
  // Block types
  if (scan && scan.blocks) {
    const groups = scan.groups;
    add('info', 'Layout', groups ? `${plural(scan.blocks - groups, 'SimpleBlock')} and ${plural(groups, 'BlockGroup')}` : `All ${plural(scan.blocks, 'block')} are SimpleBlocks`, groups ? 'BlockGroups are used when a frame needs extra information: a BlockDuration (subtitles, the last audio frames), references (ReferenceBlock) or BlockAdditions. Everything else uses the more compact SimpleBlock.' : 'SimpleBlock is the compact form: a few bytes per frame (element ID and size, track number, 16-bit timestamp, flags with a keyframe bit). No frame needs a BlockGroup (no BlockDuration, references or additions).');
  }

  // ------------------------------------------------------------ Tracks
  if (bare && doc.tracks.some((t) => t.placeholder)) {
    const ph = doc.tracks.filter((t) => t.placeholder);
    add('info', 'Tracks', `Blocks for ${ph.length} track${ph.length > 1 ? 's' : ''} without a TrackEntry`, 'This fragment carries frames for track numbers whose codecs are described in the stream\'s initialization segment (EBML header, Info and Tracks), which is not part of this file. Vidscope lists the frames but cannot decode them.', { facts: ph.map((t) => [t.short, `${fmtInt(t.samples?.count ?? 0)} frames`]) });
  }
  for (const t of doc.tracks) {
    if (t.placeholder) continue;
    if (!t.codec) add('bad', 'Tracks', `${t.short} has no CodecID`, 'Without a CodecID players cannot decode the track.', { node: t.node });
    if (t.codec && NEEDS_PRIVATE.has(t.codec) && !t.cpNode) add('bad', 'Tracks', `${t.short} (${t.codecName}) has no CodecPrivate`, `${t.codecName} cannot be decoded without its initialisation data in CodecPrivate.`, { node: t.node });
    if (t.cp?.error) add('warn', 'Tracks', `${t.short}: CodecPrivate could not be fully decoded`, t.cp.error, { node: t.cpNode });
    if (!t.languageExplicit && t.kind !== 'video') add('info', 'Tracks', `${t.short} has no Language element, so it is officially English`, 'The Language element defaults to "eng", so a track without it is English as far as players are concerned. Writers that do not know the language should write "und".', { node: t.node });
    for (const e of t.encodings) {
      if (e.type === 0 && e.compAlgo === 3) add('warn', 'Tracks', `${t.short} uses header stripping`, `The first ${e.stripped ? e.stripped.length : '?'} bytes of every frame were removed and stored once in ContentCompSettings. It saves a little space, but many players and hardware decoders do not support it and fail to play the track.`, { node: e.node, cmd: `mkvmerge -o output.mkv --compression ${t.id - 1}:none input.mkv` });
      else if (e.type === 0) add('info', 'Tracks', `${t.short} is compressed (${e.text})`, 'Frames are compressed with a general-purpose algorithm and must be decompressed before decoding; players without support cannot play the track.', { node: e.node });
      else add('info', 'Tracks', `${t.short} is encrypted (${e.text})`, 'Frames are encrypted; players need the key (for example through Encrypted Media Extensions for WebM).', { node: e.node });
    }
    const s = t.samples;
    if (!s) continue;
    if (t.kind === 'video' && t.gop) {
      const g = t.gop;
      if (g.count > 1) {
        const long = g.maxSeconds > 10;
        add(long ? 'warn' : 'info', 'Tracks', `${t.short}: a key frame every ${fmtNum(g.avgSeconds, 2)} s`, `Key frames are where decoding (and seeking) can start. ${fmtInt(g.count)} key frames, every ${fmtNum(g.avgFrames, 1)} frames on average; the longest gap is ${fmtInt(g.maxFrames)} frames (${fmtNum(g.maxSeconds, 2)} s).${long ? ' Long gaps make seeking slow or imprecise.' : ''}`, { node: t.node });
      } else if (g.count === 1) {
        add('info', 'Tracks', `${t.short}: a single key frame`, 'Only the first frame is a key frame: seeking anywhere else means decoding from the start (or showing corrupt pictures).', { node: t.node });
      }
    }
    if (s.cto) {
      const first = Array.from(s.pts.subarray(0, 6), (v) => fmtInt(v)).join(', ');
      add('info', 'Tracks', `${t.short}: frames are stored in decode order (B-frames)`, `Matroska stores only presentation timestamps, so with B-frames the block timestamps jump back and forth in file order (here ${first}… ticks). Decoders reorder the frames; decode times are not stored and Vidscope derives them.`, { node: t.node });
    }
    if (t.lacing) {
      const L = t.lacing;
      const laced = L.xiph + L.ebml + L.fixed;
      if (laced) {
        const kinds = [L.xiph && `${fmtInt(L.xiph)} Xiph`, L.ebml && `${fmtInt(L.ebml)} EBML`, L.fixed && `${fmtInt(L.fixed)} fixed-size`].filter(Boolean).join(', ');
        add('info', 'Tracks', `${t.short} uses lacing: ${kinds}`, `Lacing packs several frames into one block to save the per-block overhead (element header, track number, timestamp, flags): ${fmtInt(laced)} of ${fmtInt(L.blocks)} blocks hold up to ${L.maxFrames} frames. Only the first frame of a lace has a stored timestamp; the others follow at the frame duration (DefaultDuration).`, { node: t.node });
      }
    }
    if (t.kind === 'audio' && t.codec === 'A_OPUS') {
      const ok = t.codecDelay && t.seekPreRoll;
      add(ok ? 'good' : 'warn', 'Tracks', ok ? `${t.short}: Opus CodecDelay and SeekPreRoll are set` : `${t.short}: Opus without ${!t.codecDelay ? 'CodecDelay' : 'SeekPreRoll'}`, ok ? `CodecDelay (${fmtNs(t.codecDelay)}) tells players how much decoded audio to drop at the start (the encoder's pre-skip) and SeekPreRoll (${fmtNs(t.seekPreRoll)}) how far before a seek point to start decoding, so audio is sample-accurate and glitch-free after seeking.` : 'The Opus mapping requires CodecDelay (the pre-skip in nanoseconds) and recommends SeekPreRoll = 80 ms; without them the start of the audio is not trimmed correctly and seeking may produce glitches.', { node: t.node });
    }
    if (t.codecDelay && t.codec !== 'A_OPUS') {
      add('info', 'Timing', `${t.short}: CodecDelay ${fmtNs(t.codecDelay)} (encoder priming)`, `The first ${fmtNs(t.codecDelay)} of decoded audio are encoder priming samples: CodecDelay is subtracted from every block timestamp of this track, so they play before time zero and are dropped. FFmpeg writes it for codecs with a known encoder delay (here ${t.codecName}).`, { node: t.node });
    }
    if (t.kind === 'video' && !t.defaultDuration && s.count > 1) {
      add('info', 'Tracks', `${t.short} has no DefaultDuration`, 'DefaultDuration gives the frame duration (and so the frame rate). Without it players work the frame rate out from the timestamps, which are rounded to the TimestampScale.', { node: t.node });
    }
    const first = s.count ? s.pts.reduce((m, v) => Math.min(m, v), Infinity) : 0;
    if (first < 0) {
      add('info', 'Timing', `${t.short} starts at ${clock(first / s.timescale)}`, 'The first frames have negative timestamps (Cluster Timestamp plus a negative block offset). Writers do this to keep encoder priming samples before time zero: players decode those frames but do not play them. RFC 9559 § 11.2 says frame timestamps should not be negative.', { node: t.node });
    }
  }
  if (scan?.unknownTracks.size) {
    add('bad', 'Integrity', 'Blocks for tracks that do not exist', `Some blocks name a track number that no TrackEntry has; players ignore them.`, { facts: [...scan.unknownTracks].map(([n, c]) => [`track ${n}`, `${fmtInt(c)} blocks`]) });
  }
  if (scan && doc.tracks.length && doc.tracks.every((t) => !t.lacing || !(t.lacing.xiph + t.lacing.ebml + t.lacing.fixed))) {
    add('info', 'Tracks', 'No lacing', 'Every block holds exactly one frame. Lacing (several small frames per block, with Xiph, EBML or fixed-size lace headers) saves a few bytes per frame for audio; FFmpeg never uses it, mkvmerge uses it for some audio codecs.');
  }
  // Languages and default tracks
  {
    const real = doc.tracks.filter((t) => !t.placeholder);
    const und = real.filter((t) => t.languageExplicit && (t.language === 'und' || t.language === 'zxx' || t.language === 'mis'));
    if (und.length) add('info', 'Tracks', `${und.map((t) => t.short).join(', ')}: language undetermined ("${und[0].language}")`, 'Players choose audio and subtitle tracks by comparing their language with the user\'s preferences; without a real language code they cannot, and they fall back to the default flag or the track order.', { node: und[0].node });
    if (real.length && !real.some((t) => t.flags.default)) add('info', 'Tracks', 'No track has the default flag', 'FlagDefault is 0 on every track, so players pick the tracks on their own (usually the first of each type). FFmpeg writes FlagDefault = 0 unless the input marked a track as default.');
  }
  for (const kind of ['audio', 'subtitle']) {
    const list = doc.tracks.filter((t) => t.kind === kind);
    if (list.length > 1 && !list.some((t) => t.flags.default)) {
      add('info', 'Tracks', `No ${kind} track is marked as default`, `Several ${kind} tracks and none has FlagDefault set: players fall back to their own rules (language preference, first track) to pick one.`);
    }
  }

  // ------------------------------------------------------------ Encoding: WebM compliance, HDR
  {
    const nonWebmCodecs = doc.tracks.filter((t) => !isWebmCodec(t.codec));
    const nonWebmEls = new Map();
    for (const n of walk(doc.root)) {
      const el = n.data.el;
      if (el && !el.webm && el.rfc === 9559 && !el.global) nonWebmEls.set(el.name, n);
    }
    if (webm) {
      const problems = [];
      for (const t of nonWebmCodecs) problems.push([t.short, `${t.codec} (${t.codecName}) is not a WebM codec`]);
      for (const [nm] of nonWebmEls) problems.push([nm, 'not part of the WebM element set']);
      if (seg.timestampScale !== 1e6) problems.push(['TimestampScale', `${fmtInt(seg.timestampScale)} (WebM asks for 1,000,000)`]);
      for (const t of doc.tracks) if (t.video && t.video.displayUnit) problems.push([t.short, 'DisplayUnit is not pixels']);
      add(nonWebmCodecs.length ? 'bad' : problems.length ? 'warn' : 'good', 'Encoding', problems.length ? `Not fully WebM-compliant: ${problems.length} issue${problems.length > 1 ? 's' : ''}` : 'WebM: every codec and element is allowed', problems.length ? 'The DocType says WebM, but the file uses things outside WebM. Browsers may refuse unknown codecs; extra elements are usually ignored.' : `WebM allows only VP8, VP9 and AV1 video, Vorbis and Opus audio and WebVTT text, and a subset of Matroska elements. This file stays within them (${doc.tracks.map((t) => t.codec).join(', ')}).`, { facts: problems.slice(0, 12) });
    } else if (doc.tracks.length && !nonWebmCodecs.length) {
      add('info', 'Encoding', 'All codecs are WebM codecs', `Every track (${doc.tracks.map((t) => t.codec).join(', ')}) uses a codec WebM allows, so the file could be remuxed to WebM for browsers without re-encoding.`, { cmd: 'ffmpeg -i input.mkv -c copy output.webm' });
    }
    for (const t of doc.tracks) {
      const c = t.video?.colour;
      if (!c) continue;
      if (c.transfer === 16 || c.transfer === 18) {
        const facts = [['transfer', c.transfer === 16 ? 'PQ (SMPTE ST 2084)' : 'HLG']];
        if (c.maxCLL !== null) facts.push(['MaxCLL / MaxFALL', `${c.maxCLL} / ${c.maxFALL ?? '?'} cd/m²`]);
        if (c.mastering?.lumMax) facts.push(['mastering display', `${fmtNum(c.mastering.lumMax, 1)} / ${fmtNum(c.mastering.lumMin ?? 0, 4)} cd/m²`]);
        add('info', 'Encoding', `${t.short}: ${c.transfer === 16 ? 'HDR10 (PQ)' : 'HLG'} signalled in the container`, 'The Colour element marks the track as HDR. Players use it (and the static metadata) to switch the display to HDR or to tone-map; it should agree with the colour information in the video bitstream.', { facts, node: t.node });
      }
    }
  }

  // ------------------------------------------------------------ Timing
  {
    const scale = seg.timestampScale;
    const ddur = doc.tracks.filter((t) => t.defaultDuration && t.defaultDuration % scale);
    add('info', 'Timing', `Timestamps count ${tickName(scale)} ticks`, `TimestampScale is ${fmtInt(scale)} ns: every Cluster and block timestamp is a whole number of ${tickName(scale)} ticks.${ddur.length ? ` Frame durations that are not whole ticks (${ddur.map((t) => `${t.short}: ${fmtNs(t.defaultDuration)}`).join(', ')}) are rounded, so timestamps jitter by up to half a tick.` : ''}`, { node: seg.info ?? undefined });
    const dNode = seg.info?.child('Duration');
    const measured = doc.tracks.reduce((m, t) => Math.max(m, t.endPts !== undefined ? (t.endPts - Math.min(0, t.firstPts ?? 0)) / t.timescale : 0), 0);
    if (!dNode && !bare) {
      add('warn', 'Timing', 'No Duration', `Info has no Duration, so players cannot show the length or draw a seek bar without scanning the file${measured ? ` (the frames last ${clock(measured)})` : ''}. Typical of live recordings; remuxing adds it.`, { node: seg.info ?? undefined, cmd: `ffmpeg -i input.${webm ? 'webm' : 'mkv'} -c copy output.${webm ? 'webm' : 'mkv'}` });
    } else if (dNode && scan && measured) {
      const d = (dNode.data.value * scale) / 1e9;
      const off = Math.abs(d - measured);
      if (off > Math.max(1, measured * 0.02)) add('warn', 'Timing', `Duration says ${clock(d)} but the frames last ${clock(measured)}`, 'The Duration in Info does not match the media. Players show the wrong length and seek bar positions.', { node: dNode });
      else add('good', 'Timing', `Duration ${clock(d)} matches the media`, `The Duration element agrees with the last frame's end time (${clock(measured)}).`, { node: dNode });
    }
    if (scan) {
      const starts = doc.tracks.filter((t) => t.samples?.count && (t.kind === 'audio' || t.kind === 'video')).map((t) => [t, (t.firstPts - (t.samples.codecDelay || 0)) / t.timescale]);
      if (starts.length > 1) {
        const min = Math.min(...starts.map((x) => x[1]));
        const max = Math.max(...starts.map((x) => x[1]));
        if (max - min > 0.1) add('info', 'Timing', `Tracks start ${fmtNum((max - min) * 1000, 0)} ms apart`, 'The first frames of the audio and video tracks do not play at the same time; players keep them in sync by timestamp, but some editors or streaming tools may shift them.', { facts: starts.map(([t, s]) => [t.short, clock(s)]) });
      }
    }
  }

  // ------------------------------------------------------------ Integrity
  {
    let checked = 0;
    let bad = [];
    for (const n of walk(doc.root)) {
      if (n.type !== 'CRC-32' || n.data.crcOk === undefined) continue;
      if (n.parent?.type === 'Cluster' && scan) continue; // counted by the scan below
      checked++;
      if (!n.data.crcOk) bad.push(n);
    }
    let clusterChecked = 0;
    const clusterBad = [];
    if (scan) {
      clusterChecked = scan.crc.checked;
      clusterBad.push(...scan.crc.bad);
    }
    const total = checked + clusterChecked;
    if (bad.length || clusterBad.length) {
      const facts = [...bad.map((n) => [n.parent.type, `offset ${fmtInt(n.parent.offset)}: stored ${crcHex(n.data.crc)}, computed ${crcHex(n.data.crcComputed)}`]), ...clusterBad.slice(0, 8).map((b) => [`Cluster #${b.index + 1}`, `offset ${fmtInt(b.offset)}: stored ${crcHex(b.stored)}, computed ${crcHex(b.computed)}`])];
      add('bad', 'Integrity', `CRC-32 mismatch in ${bad.length + clusterBad.length} element${bad.length + clusterBad.length > 1 ? 's' : ''}`, 'The checksum stored at the start of these elements does not match their contents: the bytes were damaged (disk or transfer error) or edited by a tool that did not update the checksum. Players may ignore the damaged elements.', { facts, node: bad[0]?.parent });
    } else if (total) {
      add('good', 'Integrity', `${fmtInt(total)} CRC-32 checksums verified: all match`, `The elements that carry a CRC-32 (${scan ? 'including every Cluster' : 'the top-level metadata; Clusters are checked when the frame tables are built'}) are byte-for-byte intact.${scan?.crc.skipped ? ` ${fmtInt(scan.crc.skipped)} Clusters were not checked (over the verification budget).` : ''}`);
    } else {
      add('info', 'Integrity', 'No CRC-32 checksums', `This file does not use CRC-32 elements, so damage inside an element cannot be detected. They are optional; FFmpeg writes them in Matroska files but not in WebM.`);
    }
    const warned = [];
    for (const n of walk(doc.root)) if (n.warnings.length && n.type !== 'garbage') warned.push(n);
    if (warned.length) {
      add('warn', 'Integrity', `${fmtInt(warned.length)} element${warned.length > 1 ? 's' : ''} with problems`, 'Vidscope found elements that break the specification; they are marked in the tree.', { facts: warned.slice(0, 10).map((n) => [`${n.type} @ ${fmtInt(n.offset)}`, n.warnings[0]]), node: warned[0] });
    }
    if (ctx.unknown.size) {
      add('info', 'Integrity', `${ctx.unknown.size} unknown element ID${ctx.unknown.size > 1 ? 's' : ''}`, 'Elements whose IDs are not in the Matroska specification. Players skip them using their size, which is what lets EBML formats grow; they may be a writer\'s private extension.', { facts: [...ctx.unknown].slice(0, 10).map(([id, c]) => [hexId(id), `${fmtInt(c)}×`]) });
    }
    if (scan?.problems.length) {
      add('warn', 'Integrity', `${fmtInt(scan.problems.length)} problem${scan.problems.length > 1 ? 's' : ''} while reading the blocks`, 'Some blocks could not be read completely.', { facts: scan.problems.slice(0, 10).map((p, i) => [`#${i + 1}`, p]) });
    }
  }

  // ------------------------------------------------------------ Metadata
  {
    const title = seg.info ? val(seg.info, 'Title') : undefined;
    if (title) add('info', 'Metadata', `Title: ${quote(title, 80)}`, 'The Title element of Info, shown by players as the name of the file.', { node: seg.info.child('Title') });
    const editions = seg.node.findAll('EditionEntry');
    if (editions.length) {
      const atoms = editions.flatMap((e) => e.childrenOf('ChapterAtom'));
      const facts = atoms.slice(0, 20).map((a) => [clock((val(a, 'ChapterTimeStart') ?? 0) / 1e9), a.find('ChapString')?.data.value ?? '(untitled)']);
      const ordered = editions.some((e) => val(e, 'EditionFlagOrdered'));
      add('info', 'Metadata', `${fmtInt(atoms.length)} chapter${atoms.length === 1 ? '' : 's'} in ${editions.length} edition${editions.length > 1 ? 's' : ''}${ordered ? ' (ordered)' : ''}`, `Chapters let viewers jump to named points. Their times are stored in nanoseconds, independent of TimestampScale.${ordered ? ' Ordered chapters also define the playback order, which few players outside the MKVToolNix ecosystem support.' : ''}`, { facts, node: seg.node.find('Chapters') });
    }
    const tags = seg.node.findAll('Tag');
    if (tags.length) {
      const names = new Map();
      for (const s of seg.node.findAll('SimpleTag')) {
        const nm = val(s, 'TagName');
        if (nm) names.set(nm, (names.get(nm) ?? 0) + 1);
      }
      add('info', 'Metadata', `${fmtInt(tags.length)} tag${tags.length === 1 ? '' : 's'}: ${[...names.keys()].slice(0, 6).join(', ')}`, 'Tags carry free-form metadata for the whole file or for specific tracks, chapters or attachments (by UID). Names are conventions such as TITLE, ARTIST or ENCODER; Matroska has no per-track duration element, so FFmpeg writes the length of each track as a DURATION tag.', { facts: [...names].slice(0, 12).map(([k, v]) => [k, `${v}×`]), node: seg.node.find('Tags') });
    }
    const files = seg.node.findAll('AttachedFile');
    if (files.length) {
      const facts = files.slice(0, 12).map((f) => [val(f, 'FileName') ?? '?', `${val(f, 'FileMediaType') ?? '?'}, ${humanBytes(f.child('FileData')?.bodySize ?? 0)}`]);
      const fonts = files.filter((f) => /font|ttf|otf/i.test(`${val(f, 'FileMediaType')} ${val(f, 'FileName')}`)).length;
      add('info', 'Metadata', `${fmtInt(files.length)} attachment${files.length > 1 ? 's' : ''}${fonts ? ` (${fonts} font${fonts > 1 ? 's' : ''})` : ''}`, `Files stored inside the Matroska file. ${fonts ? 'Fonts are attached for styled (ASS/SSA) subtitles, so they render the same on every system.' : 'Cover art named cover.jpg or cover.png is shown by some players and file managers.'}`, { facts, node: seg.node.find('Attachments') });
    }
    for (const t of doc.tracks) {
      if (t.language && t.language !== 'und' && !languageName(t.language) && !/^[a-z]{2,3}(-|$)/i.test(t.language)) {
        add('warn', 'Metadata', `${t.short}: unusual language code "${t.language}"`, 'Language should be an ISO 639-2 code (like "eng") or, in LanguageBCP47, a BCP 47 tag (like "en-US").', { node: t.node });
      }
    }
  }
  return out;
}
