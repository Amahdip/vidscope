// ISO base media file format: MP4, MOV, M4A, 3GP, fragmented MP4/CMAF, HEIF/AVIF.

import { Node, fieldsAt } from '../../core/model.js';
import { Doc } from '../../core/doc.js';
import { fourcc, fmtInt, fmtNum, fmtDuration, hex } from '../../core/util.js';
import { parseSample } from '../../codecs/index.js';
import './boxes.js';
import './entries.js';
import './meta.js';
import { parseBoxesAsync } from './parse.js';
import { analyze } from './analyze.js';
import { insights } from './insights.js';
import { glossary } from './glossary.js';

const TOP_LEVEL = new Set(['ftyp', 'styp', 'moov', 'mdat', 'free', 'skip', 'wide', 'pnot', 'sidx', 'moof', 'emsg', 'prft', 'uuid', 'meta', 'junk', 'pdin', 'mfra']);

function probe(head) {
  if (head.length < 8) return 0;
  const size = new DataView(head.buffer, head.byteOffset, 8).getUint32(0);
  const type = fourcc(head, 4);
  if (type === 'ftyp' && size >= 8) return 100;
  if (TOP_LEVEL.has(type) && (size === 0 || size === 1 || size >= 8)) return 80;
  return 0;
}

const MAX_SAMPLE_READ = 16 * 1024 * 1024;

class Mp4Doc extends Doc {
  constructor(o) {
    super(o);
    this.unitCache = new Map();
  }

  /** Sample runs inside [a, b) for the hex view: {start, end, track, sample, part, first, units?}. */
  overlay(a, b) {
    const idx = this.sampleIndex;
    if (!idx || !idx.count) return null;
    const out = [];
    for (let k = idx.firstEndingAfter(a); k < idx.count && idx.starts[k] < b; k++) {
      const start = idx.starts[k];
      const end = idx.ends[k];
      const t = idx.track[k];
      const i = idx.sample[k];
      out.push({ start: Math.max(a, start), end: Math.min(b, end), track: t, sample: i, part: i & 1, first: start >= a, sampleStart: start, units: this.unitCache.get(`${t}:${i}`) ?? null });
    }
    return out;
  }

  /** Parse (and cache) the codec units of the samples overlapping [a, b). Returns true if anything new was parsed. */
  async ensureUnits(a, b) {
    const idx = this.sampleIndex;
    if (!idx || !idx.count) return false;
    let changed = false;
    for (let k = idx.firstEndingAfter(a), n = 0; k < idx.count && idx.starts[k] < b && n < 64; k++, n++) {
      const key = `${idx.track[k]}:${idx.sample[k]}`;
      if (this.unitCache.has(key)) continue;
      const size = idx.ends[k] - idx.starts[k];
      if (size > 4 * 1024 * 1024) {
        this.unitCache.set(key, []);
        continue;
      }
      await this.sampleUnits(idx.track[k], idx.sample[k]);
      changed = true;
    }
    return changed;
  }

  async sampleUnits(trackIndex, i) {
    const key = `${trackIndex}:${i}`;
    const hit = this.unitCache.get(key);
    if (hit && hit.length) return hit;
    const t = this.tracks[trackIndex];
    const s = t.samples;
    const start = s.offsets[i];
    const size = s.sizes[i];
    if (!t.sampleCfg?.family) {
      this.unitCache.set(key, []);
      return [];
    }
    const bytes = await this.source.read(start, Math.min(size, MAX_SAMPLE_READ));
    const res = parseSample(t.sampleCfg, bytes, 0, bytes.length, start);
    const units = res.units;
    if (res.error) units.error = res.error;
    if (this.unitCache.size > 512) this.unitCache.delete(this.unitCache.keys().next().value);
    this.unitCache.set(key, units);
    return units;
  }

  sampleDetailRows(t, i) {
    const s = t.samples;
    const ts = t.timescale || 1;
    const dts = s.dts[i];
    const pts = dts + (s.cto ? s.cto[i] : 0);
    const rows = [
      ['track', `${t.label} (ID ${t.id})`],
      ['sample', `${fmtInt(i + 1)} of ${fmtInt(s.count)}`],
      ['offset', `${fmtInt(s.offsets[i])} (${hex(s.offsets[i])})`],
      ['size', `${fmtInt(s.sizes[i])} bytes`],
      ['decode time', `${fmtInt(dts)} → ${fmtDuration(dts / ts)}`],
    ];
    if (s.cto) rows.push(['presentation time', `${fmtInt(pts)} → ${fmtDuration(pts / ts)} (offset ${fmtInt(s.cto[i])})`]);
    rows.push(['duration', `${fmtInt(s.durations[i])} ticks (${fmtNum((s.durations[i] / ts) * 1000, 3)} ms)`]);
    rows.push(['key frame', !s.key || s.key[i] ? 'yes (sync sample: decoding can start here)' : 'no']);
    if (s.chunk) rows.push(['chunk', `#${fmtInt(s.chunk[i] + 1)}`]);
    if (s.frag) rows.push(['fragment', `moof #${fmtInt(s.frag[i] + 1)}`]);
    return rows;
  }

  async detailAt(offset) {
    const idx = this.sampleIndex;
    if (!idx) return null;
    const k = idx.find(offset);
    if (k < 0) {
      const node = this.nodeAt(offset);
      if (node.type !== 'mdat') return null;
      return {
        kind: 'gap',
        title: 'Not part of any sample',
        text: 'No sample table points at this byte. It may be padding, data from a track that was removed, or bytes the sample tables forgot.',
        range: this.gapAround(offset, node),
        rows: [],
      };
    }
    const t = this.tracks[idx.track[k]];
    const i = idx.sample[k];
    const units = await this.sampleUnits(t.index, i);
    const s = t.samples;
    const d = {
      kind: 'sample',
      title: `Sample ${fmtInt(i + 1)} · ${t.label}`,
      subtitle: t.codecName,
      range: [s.offsets[i], s.offsets[i] + s.sizes[i]],
      rows: this.sampleDetailRows(t, i),
      units,
      track: t,
      sample: i,
      text: t.sampleCfg?.family
        ? null
        : 'Vidscope does not look inside samples of this codec; the bytes are shown as one opaque block.',
    };
    const u = units.findIndex((x) => offset >= x.offset && offset < x.offset + x.size);
    if (u >= 0) {
      const hits = fieldsAt({ fields: units[u].fields, _leaves: null }, offset);
      d.hit = { unit: u, fields: hits };
    }
    return d;
  }

  /** What an mdat holds: samples per track, and bytes no sample uses. */
  payloadInfo(node) {
    const idx = this.sampleIndex;
    if (node.type !== 'mdat' || !idx?.count) return null;
    const per = new Map();
    let used = 0;
    for (let k = idx.firstEndingAfter(node.bodyOffset); k < idx.count && idx.starts[k] < node.end; k++) {
      const t = idx.track[k];
      const size = idx.ends[k] - idx.starts[k];
      const e = per.get(t) ?? { n: 0, bytes: 0 };
      e.n++;
      e.bytes += size;
      per.set(t, e);
      used += size;
    }
    const rows = [...per].map(([t, e]) => [this.tracks[t].label, `${fmtInt(e.n)} samples, ${fmtInt(e.bytes)} bytes`]);
    const free = node.size - node.headerSize - used;
    rows.push(['not in any sample', `${fmtInt(Math.max(0, free))} bytes`]);
    return { title: 'What is inside', rows, text: 'mdat itself has no structure: these numbers come from the sample tables, which say where every sample lies. Click any byte in the hex view to see its sample.' };
  }

  gapAround(offset, mdat) {
    const idx = this.sampleIndex;
    const k = idx.firstEndingAfter(offset);
    const end = k < idx.count ? Math.min(idx.starts[k], mdat.end) : mdat.end;
    const prev = k > 0 ? idx.ends[k - 1] : mdat.bodyOffset;
    return [Math.max(prev, mdat.bodyOffset), end];
  }

  async insights() {
    return insights(this);
  }

  glossary() {
    return glossary(this);
  }
}

async function open(source, { onProgress } = {}) {
  const root = new Node({ type: source.name, name: source.name, kind: 'file', offset: 0, size: source.size, category: 'file' });
  const doc = new Mp4Doc({ source, format: FORMAT, root });
  const ctx = { source, count: 0, warnings: doc.warnings, isQT: false, brands: null, movieTimescale: 0, mediaTimescale: 0, handler: null, entry: null };
  const head = await source.read(0, Math.min(source.size, 64));
  if (head.length >= 12 && fourcc(head, 4) === 'ftyp' && fourcc(head, 8) === 'qt  ') ctx.isQT = true;
  if (head.length >= 8 && fourcc(head, 4) !== 'ftyp' && fourcc(head, 4) !== 'styp') ctx.isQT = true;
  await parseBoxesAsync(ctx, root, 0, source.size, onProgress);
  analyze(doc, ctx);
  doc.ctx = ctx;
  return doc;
}

const FORMAT = {
  id: 'isobmff',
  name: 'MP4 / ISO-BMFF',
  unit: ['box', 'boxes'],
  primer: [
    'An MP4 file is a list of boxes. Every box starts with 8 bytes: a 4-byte size and a 4-byte type such as \'moov\'. In the hex view they are the blue (size) and purple (type) bytes. Boxes can contain other boxes.',
    'Three boxes matter most. ftyp says what kind of file this is. mdat holds the compressed audio and video, usually almost the whole file, with no structure of its own. moov is the index: the tracks, their codecs, and tables that say exactly where each frame sits inside mdat and when it plays.',
    'Try this: click the moov card above, then a trak in the tree, then any byte inside mdat to see which frame it belongs to.',
  ],
  probe,
  open,
};

export default FORMAT;
