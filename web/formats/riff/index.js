// RIFF containers: AVI (including OpenDML "AVI 2.0" files over 1 GB) and WAV
// (including RF64/BW64), plus a generic chunk view for other RIFF forms.

import { Node, fieldsAt } from '../../core/model.js';
import { Doc } from '../../core/doc.js';
import { fourcc, fmtInt, fmtNum, fmtDuration, hex } from '../../core/util.js';
import { parseSample } from '../../codecs/index.js';
import './avi-chunks.js';
import './wav-chunks.js';
import { parseAsync, isListId } from './parse.js';
import { analyzeAvi, buildSamples, scanMovis, finishTracks, inspectFirstFrames } from './avi.js';
import { analyzeWav, wavDetail } from './wav.js';
import { parseMpeg4Visual } from '../../codecs/mpeg4v.js';
import { insights } from './insights.js';
import { glossary } from './glossary.js';

const MAX_SAMPLE_READ = 16 << 20;

function probe(head) {
  if (head.length < 12) return 0;
  const id = fourcc(head, 0);
  const form = fourcc(head, 8);
  if (id === 'RIFF' && (form === 'AVI ' || form === 'WAVE' || form === 'AVIX')) return 100;
  if ((id === 'RF64' || id === 'BW64') && form === 'WAVE') return 100;
  if (id === 'RIFX' && (form === 'WAVE' || form === 'AVI ')) return 90;
  if (id === 'RIFF' && /^[\x20-\x7e]{4}$/.test(form)) return 40;
  return 0;
}

class RiffDoc extends Doc {
  constructor(o) {
    super(o);
    this.unitCache = new Map();
  }

  overlay(a, b) {
    return this.frameIndex?.count ? this.frameIndex.runs(a, b, this.unitCache) : null;
  }

  frameCodec(t) {
    const c = super.frameCodec(t);
    if (c && t.family === 'mpeg4v') c.state = t.mp4v ?? null;
    return c;
  }

  /** Parse (and cache) codec units of the frames overlapping [a, b). */
  async ensureUnits(a, b) {
    const idx = this.frameIndex;
    if (!idx || !idx.count) return false;
    let changed = false;
    for (let k = idx.firstEndingAfter(a), n = 0; k < idx.count && idx.starts[k] < b && n < 64; k++, n++) {
      const key = `${idx.track[k]}:${idx.sample[k]}`;
      if (this.unitCache.has(key)) continue;
      if (idx.ends[k] - idx.starts[k] > 4 << 20) {
        this.unitCache.set(key, []);
        continue;
      }
      await this.sampleUnits(this.tracks[idx.track[k]], idx.sample[k]);
      changed = true;
    }
    return changed;
  }

  async sampleUnits(t, i) {
    const key = `${t.index}:${i}`;
    const hit = this.unitCache.get(key);
    if (hit) return hit;
    const s = t.samples;
    const start = s.offsets[i];
    let units = [];
    if (s.sizes[i] && (t.sampleCfg?.family || t.family === 'mpeg4v')) {
      const bytes = await this.source.read(start, Math.min(s.sizes[i], MAX_SAMPLE_READ));
      if (t.family === 'mpeg4v') {
        units = parseMpeg4Visual(bytes, 0, bytes.length, start, { ...t.mp4v }).units;
      } else {
        const res = parseSample(t.sampleCfg, bytes, 0, bytes.length, start);
        units = res.units;
        if (res.error) units.error = res.error;
      }
    }
    if (this.unitCache.size > 512) this.unitCache.delete(this.unitCache.keys().next().value);
    this.unitCache.set(key, units);
    return units;
  }

  async detailAt(offset) {
    if (this.ctx.form === 'WAVE') return wavDetail(this, offset);
    const idx = this.frameIndex;
    const k = idx?.count ? idx.find(offset) : -1;
    if (k < 0) return this.gapDetail(offset);
    const t = this.tracks[idx.track[k]];
    const i = idx.sample[k];
    const s = t.samples;
    const units = await this.sampleUnits(t, i);
    const ts = s.timescale || 1;
    const c = s.clock;
    const video = t.kind === 'video';
    const rows = [
      ['stream', `${t.label}${s.chunkId ? ` (chunk ID '${s.chunkId}')` : ''}`],
      [video ? 'frame' : 'chunk', `${fmtInt(i + 1)} of ${fmtInt(s.count)}`],
      ['chunk header at', `${fmtInt(s.offsets[i] - 8)} (${hex(s.offsets[i] - 8)})`],
      ['data', `${fmtInt(s.sizes[i])} bytes at ${fmtInt(s.offsets[i])} (${hex(s.offsets[i])})`],
      ['time', `${fmtDuration(s.dts[i] / ts)} = ${fmtNum(s.dts[i] / (c?.scale || 1), 3)} × ${fmtInt(c?.scale ?? 1)}/${fmtInt(ts)} s`],
      ['duration', `${fmtNum((s.durations[i] / ts) * 1000, 3)} ms`],
    ];
    if (video) rows.push(['key frame', s.key ? (s.key[i] ? `yes (${s.source === 'scan' ? 'found by looking inside the frame' : 'flagged in the index'})` : 'no') : 'unknown']);
    rows.push(['found through', s.source === 'OpenDML' ? 'OpenDML index (ix##)' : s.source === 'idx1' ? 'idx1 index' : 'a scan of the movi list (no index)']);
    if (t.family === 'mpeg4v') {
      const vops = units.filter((u) => u.title.startsWith('VOP'));
      if (vops.length > 1) rows.push(['packed', `${vops.length} VOPs in one chunk (packed bitstream): ${vops.map((u) => u.title.slice(6)).join(' + ')}`]);
    }
    const d = {
      kind: 'sample',
      title: `${video ? 'Frame' : 'Chunk'} ${fmtInt(i + 1)} · ${t.label}`,
      subtitle: t.codecName,
      range: [s.offsets[i], s.offsets[i] + s.sizes[i]],
      rows,
      units,
      track: t,
      sample: i,
      text: units.length ? null : t.stream.audio?.pcm ? `PCM audio: ${fmtInt(Math.floor(s.sizes[i] / (t.stream.audio.blockAlign || 1)))} sample frames of ${t.stream.audio.blockAlign} bytes, channels interleaved.` : 'Vidscope does not look inside frames of this codec; the chunk data is shown as one block.',
    };
    const u = units.findIndex((x) => offset >= x.offset && offset < x.offset + x.size);
    if (u >= 0) d.hit = { unit: u, fields: fieldsAt({ fields: units[u].fields, _leaves: null }, offset) };
    return d;
  }

  gapDetail(offset) {
    const node = this.nodeAt(offset);
    const movi = node?.closest('movi');
    if (!movi) return null;
    return {
      kind: 'gap',
      title: 'Not part of any indexed frame',
      text: this.frameIndex?.count
        ? 'No index entry covers this byte: it is a chunk header, an index chunk, JUNK, or a chunk the index does not list.'
        : 'This file has no index, so Vidscope has not located the frames yet (it scans the movi list in the background).',
      range: [node.offset, node.end],
      rows: [],
    };
  }

  async insights() {
    return insights(this);
  }

  glossary() {
    return glossary(this);
  }
}

function formLabel(ctx, root) {
  const riffs = (root.children ?? []).filter((c) => isListId(c.data.id ?? ''));
  const first = riffs[0];
  if (!first) return 'RIFF (damaged)';
  const form = first.data.listType;
  if (form === 'AVI ') {
    const odml = riffs.some((r) => r.data.listType === 'AVIX') || !!ctx.odml || ctx.streams.some((s) => s.indx);
    return odml ? 'AVI (OpenDML)' : 'AVI';
  }
  if (form === 'WAVE') {
    if (first.data.id === 'RF64') return 'WAV (RF64)';
    if (first.data.id === 'BW64') return 'WAV (BW64)';
    if (first.data.id === 'RIFX') return 'WAV (RIFX, big-endian)';
    if (ctx.bext) return 'Broadcast WAV (BWF)';
    return 'WAV (RIFF)';
  }
  if (form === 'AVIX') return 'AVI (OpenDML fragment)';
  return `RIFF '${(form ?? '?').trim()}'`;
}

async function open(source, { onProgress } = {}) {
  const root = new Node({ type: source.name, name: source.name, kind: 'file', offset: 0, size: source.size, category: 'file' });
  const doc = new RiffDoc({ source, format: FORMAT, root });
  const head = await source.read(0, 12);
  const ctx = {
    source,
    doc,
    le: fourcc(head, 0) !== 'RIFX',
    warnings: doc.warnings,
    count: 0,
    streams: [],
    movis: [],
    moviWalks: new Map(),
    ixOffsets: [],
    cur: null,
  };
  doc.ctx = ctx;
  await parseAsync(ctx, root, 0, source.size, onProgress);
  const first = (root.children ?? []).find((c) => isListId(c.data.id ?? ''));
  ctx.form = first?.data.listType ?? null;
  ctx.headerCount = ctx.count;
  if (ctx.form === 'AVI ' || ctx.form === 'AVIX') {
    await analyzeAvi(doc, ctx);
    const chunks = doc.tracks.reduce((n, t) => n + (t.samples?.count ?? 0), 0) + ctx.ixOffsets.length + (ctx.index.recs ?? 0);
    doc.summary.unitCount = ctx.headerCount + chunks;
    if (!ctx.index.loaded && ctx.movis.length) {
      doc.loadSamples = async (onProgress2) => {
        const per = await scanMovis(ctx, onProgress2);
        doc.tracks.forEach((t, i) => {
          const a = per[i];
          if (a.off.n) t.samples = buildSamples(t.stream, a.off.done(), a.size.done(), a.key.done(), 'scan', a.id);
        });
        ctx.index.scanned = true;
        await inspectFirstFrames(ctx, doc);
        finishTracks(doc, ctx);
        let n = 0;
        for (const w of ctx.moviWalks.values()) n += w.count;
        doc.summary.unitCount = ctx.headerCount + n;
      };
    }
  } else if (ctx.form === 'WAVE') {
    analyzeWav(doc, ctx);
  }
  const label = formLabel(ctx, root);
  doc.summary.label = label;
  doc.summary.anatomy = `${label.replace(/ \(.*\)$/, '')} anatomy`;
  return doc;
}

const FORMAT = {
  id: 'riff',
  name: 'AVI / RIFF',
  unit: ['chunk', 'chunks'],
  probe,
  open,
};

export default FORMAT;
