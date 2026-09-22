// Matroska and WebM (EBML): .mkv, .mka, .mks, .mk3d, .webm.
// Specifications: RFC 8794 (EBML), RFC 9559 (Matroska), the WebM container guidelines
// and the Matroska codec mappings (draft-ietf-cellar-codec).

import { Node, walk } from '../../core/model.js';
import { Doc } from '../../core/doc.js';
import { fieldsAt } from '../../core/model.js';
import { fmtInt, fmtNum, hex, quote, decodeText } from '../../core/util.js';
import { parseSample } from '../../codecs/index.js';
import { readHeader, readText, clock, fmtNs } from './ebml.js';
import { createContext, parseFile, labelTree, lowerClusterIndex } from './parse.js';
import { buildTracks, trackProps } from './tracks.js';
import { scanClusters } from './samples.js';
import { LACING } from './blocks.js';
import { insights } from './insights.js';
import { glossary } from './glossary.js';

const MAX_FRAME_READ = 16 * 1024 * 1024;

function probe(head) {
  if (head.length < 4) return 0;
  if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) {
    const hdr = readHeader(head, 0, head.length);
    if (hdr.error) return 40;
    const end = Math.min(head.length, hdr.headerSize + (hdr.size ?? 0));
    for (let p = hdr.headerSize; p < end;) {
      const h = readHeader(head, p, end);
      if (h.error || h.unknown) break;
      if (h.id === 0x4282) {
        const t = readText(head, p + h.headerSize, Math.min(h.size, end - p - h.headerSize), true).text;
        return t === 'matroska' || t === 'webm' ? 100 : 30;
      }
      p += h.headerSize + h.size;
    }
    return 70;
  }
  // A bare stream of Clusters (e.g. a WebM media segment of a DASH or MSE stream).
  const hdr = readHeader(head, 0, head.length);
  if (!hdr.error && (hdr.id === 0x1f43b675 || hdr.id === 0x18538067)) {
    const c = readHeader(head, hdr.headerSize, head.length);
    if (!c.error && (c.id === 0xe7 || c.id === 0xbf || c.id === 0x114d9b74 || c.id === 0x1549a966)) return 60;
  }
  return 0;
}

function textUnits(bytes, start, ass) {
  const text = decodeText(bytes).replace(/\0+$/, '');
  const fields = [];
  if (ass) {
    const names = ['ReadOrder', 'Layer', 'Style', 'Name', 'MarginL', 'MarginR', 'MarginV', 'Effect', 'Text'];
    let p = 0;
    for (let k = 0; k < names.length && p <= bytes.length; k++) {
      let e = k < names.length - 1 ? bytes.indexOf(0x2c, p) : bytes.length;
      if (e < 0) e = bytes.length;
      const v = decodeText(bytes.subarray(p, e));
      fields.push({ name: names[k], type: 'text', offset: start + p, size: e - p, value: v, display: quote(v, 300), key: names[k] === 'Text' || names[k] === 'Style' });
      p = e + 1;
    }
  } else {
    fields.push({ name: 'text', type: 'utf-8', offset: start, size: bytes.length, value: text, display: quote(text.replace(/\r?\n/g, ' ↵ '), 400), key: true, desc: 'The subtitle text. In Matroska, SRT subtitles keep only the text: the timing is the block timestamp and BlockDuration.' });
  }
  return [{ title: ass ? 'ASS/SSA dialogue event' : 'subtitle text', offset: start, size: bytes.length, summary: quote(ass ? fields[fields.length - 1]?.value ?? text : text, 80), fields }];
}

class MkvDoc extends Doc {
  constructor(o) {
    super(o);
    this.unitCache = new Map();
    this.frameIndex = null;
    this.scan = null;
  }

  /** Scan every Cluster once and fill the tracks' frame tables. */
  loadSamples(onProgress) {
    if (!this._samples) {
      this._samples = (async () => {
        const sc = await scanClusters(this, onProgress);
        this.scan = sc;
        this.sampleIndex = this.frameIndex; // same interface as the ISO-BMFF SampleIndex
        for (const t of this.tracks) t.props = trackProps(t, this);
        if (!this.summary.duration) {
          const d = this.tracks.reduce((m, t) => Math.max(m, t.duration ?? 0), 0);
          this.summary.duration = d || null;
        }
        let outside = 0;
        for (const n of walk(this.root)) if (n !== this.root && !n.parent?.closest?.('Cluster')) outside++;
        this.summary.unitCount = outside + sc.elements;
        this._insights = null;
        return this.tracks;
      })();
    }
    return this._samples;
  }

  /** Frame runs inside [a, b) for the hex view. */
  overlay(a, b) {
    const idx = this.frameIndex;
    const out = [];
    if (idx && idx.count) {
      for (let k = idx.firstEndingAfter(a); k < idx.count && idx.starts[k] < b; k++) {
        const start = idx.starts[k];
        const end = idx.ends[k];
        if (end <= start) continue;
        const i = idx.sample[k];
        out.push({ start: Math.max(a, start), end: Math.min(b, end), track: idx.track[k], sample: i, part: i & 1, first: start >= a, sampleStart: start, units: this.unitCache.get(start) ?? null });
      }
      return out;
    }
    // Before the scan: frames of the Clusters that are already open.
    for (const seg of this.ctx.segments) {
      const cls = seg.clusters;
      for (let j = lowerClusterIndex(cls, a); j < cls.length && cls[j].offset < b; j++) {
        const cl = cls[j];
        if (!cl.children) continue;
        let n = 0;
        for (const c of cl.children) {
          if (c.end <= a || c.offset >= b) continue;
          const bn = c.type === 'SimpleBlock' ? c : c.type === 'BlockGroup' ? c.child('Block') : null;
          const blk = bn?.data.block;
          if (!blk?.abs) continue;
          const t = seg.trackByNumber.get(blk.track);
          if (!t) continue;
          for (let f = 0; f < blk.abs.length; f += 2) {
            const start = blk.abs[f];
            const end = start + blk.abs[f + 1];
            n++;
            if (end <= a || start >= b || end <= start) continue;
            out.push({ start: Math.max(a, start), end: Math.min(b, end), track: t.index, sample: null, part: n & 1, first: start >= a, sampleStart: start, units: this.unitCache.get(start) ?? null });
          }
        }
      }
    }
    return out.length ? out : null;
  }

  /** Parse (and cache) the codec units of the frames overlapping [a, b). */
  async ensureUnits(a, b) {
    const runs = this.overlay(a, b) ?? [];
    let changed = false;
    let n = 0;
    for (const r of runs) {
      if (n++ >= 64) break;
      if (this.unitCache.has(r.sampleStart)) continue;
      const f = await this.frameAt(r.sampleStart);
      if (!f) continue;
      if (f.end - f.start > 4 * 1024 * 1024) {
        this.unitCache.set(f.start, []);
        continue;
      }
      await this.frameUnits(f.t, f.start, f.end - f.start);
      changed = true;
    }
    return changed;
  }

  async frameUnits(t, start, size) {
    const hit = this.unitCache.get(start);
    if (hit) return hit;
    const cfg = t.sampleCfg;
    let units = [];
    if (cfg?.family && size > 0) {
      const bytes = await this.source.read(start, Math.min(size, MAX_FRAME_READ));
      if (cfg.family === 'text') units = textUnits(bytes, start, cfg.ass);
      else {
        const res = parseSample(cfg, bytes, 0, bytes.length, start);
        units = res.units;
        if (res.error) units.error = res.error;
      }
    }
    if (this.unitCache.size > 1024) this.unitCache.delete(this.unitCache.keys().next().value);
    this.unitCache.set(start, units);
    return units;
  }

  /** The frame containing `offset`: from the frame tables, or from the (lazily read) block. */
  async frameAt(offset) {
    const idx = this.frameIndex;
    if (idx && idx.count) {
      const k = idx.find(offset);
      if (k < 0) return null;
      const t = this.tracks[idx.track[k]];
      return { t, i: idx.sample[k], start: idx.starts[k], end: idx.ends[k] };
    }
    const node = await this.nodeAtDeep(offset);
    const b = node?.data.block;
    if (!b?.abs) return null;
    const t = node.data.seg?.trackByNumber.get(b.track);
    if (!t) return null;
    for (let j = 0; j < b.abs.length; j += 2) {
      const start = b.abs[j];
      const end = start + b.abs[j + 1];
      if (offset >= start && offset < end) return { t, i: null, start, end, node, lace: j / 2, block: b };
    }
    return null;
  }

  detailRows(f) {
    const t = f.t;
    const s = t.samples;
    const scale = t.seg.timestampScale;
    const rows = [['track', `${t.label} (track number ${t.id})`]];
    if (f.i !== null && s) {
      const i = f.i;
      rows.push(['frame', `${fmtInt(i + 1)} of ${fmtInt(s.count)}`]);
      rows.push(['offset', `${fmtInt(f.start)} (${hex(f.start)})`]);
      rows.push(['size', `${fmtInt(f.end - f.start)} bytes`]);
      const lacing = (s.flags[i] >> 2) & 3;
      rows.push(['block', `${s.flags[i] & 16 ? 'Block (in a BlockGroup)' : 'SimpleBlock'} at ${fmtInt(s.block[i])} (${hex(s.block[i])}), in Cluster #${fmtInt(s.cluster[i] + 1)}`]);
      if (s.laceCount[i] > 1) rows.push(['lacing', `frame ${s.lace[i] + 1} of ${s.laceCount[i]} (${LACING[lacing]})`]);
      rows.push(['timestamp', `${fmtNum(s.pts[i], 3)} ticks → ${clock(s.pts[i] / s.timescale)}${s.laceCount[i] > 1 && s.lace[i] > 0 ? ' (derived: only the first frame of a lace has a stored timestamp)' : ''}`]);
      if (s.cto) rows.push(['decode time', `${fmtNum(s.dts[i], 3)} ticks → ${clock(s.dts[i] / s.timescale)} (derived: Matroska stores presentation times only)`]);
      if (s.codecDelay) rows.push(['played at', `${clock((s.pts[i] - s.codecDelay) / s.timescale)} (timestamp minus CodecDelay ${fmtNs(t.codecDelay)})`]);
      rows.push(['duration', `${fmtNum(s.durations[i], 3)} ticks (${fmtNs(s.durations[i] * scale)})`]);
      rows.push(['key frame', s.key[i] ? 'yes: decoding can start here' : 'no: needs earlier frames']);
      if (s.flags[i] & 1) rows.push(['invisible', 'yes: decoded but not shown']);
      if (s.flags[i] & 2) rows.push(['discardable', 'yes: may be dropped when the player is late']);
    } else {
      const b = f.block;
      const ts = f.node.parent?.type === 'Cluster' ? f.node.parent.data.timestamp : f.node.parent?.parent?.data.timestamp;
      rows.push(['offset', `${fmtInt(f.start)} (${hex(f.start)})`]);
      rows.push(['size', `${fmtInt(f.end - f.start)} bytes`]);
      rows.push(['block', `${f.node.type} at ${fmtInt(f.node.offset)} (${hex(f.node.offset)})`]);
      if (b.count > 1) rows.push(['lacing', `frame ${f.lace + 1} of ${b.count} (${LACING[b.lacing]})`]);
      if (ts !== undefined && ts !== null) rows.push(['block timestamp', `${fmtInt(ts + b.rel)} ticks → ${clock(((ts + b.rel) * scale) / 1e9)}`]);
      rows.push(['key frame', b.key ? 'yes: decoding can start here' : 'no']);
      rows.push(['frame number', 'known once the frame tables are built (they load in the background)']);
    }
    return rows;
  }

  async detailAt(offset) {
    const f = await this.frameAt(offset);
    if (!f) return null;
    const t = f.t;
    const units = await this.frameUnits(t, f.start, f.end - f.start);
    let text = null;
    if (!t.sampleCfg?.family) {
      if (t.compressed) text = `This track uses content compression (${t.compressed.text}): frames are stored transformed, so Vidscope shows them as opaque bytes.${t.compressed.compAlgo === 3 ? ' With header stripping, the bytes in ContentCompSettings must be put back at the start of every frame before decoding.' : ''}`;
      else if (t.encrypted) text = `This track is encrypted (${t.encrypted.text}); the frames cannot be parsed without the key.`;
      else text = 'Vidscope does not look inside frames of this codec; the bytes are shown as one opaque block.';
    }
    const d = {
      kind: 'sample',
      title: `Frame ${f.i !== null ? fmtInt(f.i + 1) : ''}${f.i !== null ? ' · ' : ''}${t.label}`,
      subtitle: t.codecName,
      range: [f.start, f.end],
      rows: this.detailRows(f),
      units,
      track: t,
      sample: f.i,
      text,
    };
    const u = units.findIndex((x) => offset >= x.offset && offset < x.offset + x.size);
    if (u >= 0) d.hit = { unit: u, fields: fieldsAt({ fields: units[u].fields, _leaves: null }, offset) };
    return d;
  }

  async insights() {
    return insights(this);
  }

  glossary() {
    return glossary(this);
  }
}

function summarize(doc, ctx) {
  const h = ctx.header;
  const webm = h?.docType === 'webm';
  const seg = ctx.segments[0];
  let label = webm ? 'WebM' : 'Matroska';
  if (ctx.bare) label = 'Matroska / WebM fragment (no header)';
  else if (!webm && !doc.tracks.some((t) => t.kind === 'video') && doc.tracks.some((t) => t.kind === 'audio')) label = 'Matroska audio';
  let duration = null;
  if (seg?.info) {
    const d = seg.info.child('Duration')?.data.value;
    if (typeof d === 'number' && d > 0) duration = (d * seg.timestampScale) / 1e9;
  }
  return { label, anatomy: `${label} anatomy`, duration };
}

async function open(source, { onProgress } = {}) {
  const root = new Node({ type: source.name, name: source.name, kind: 'file', offset: 0, size: source.size, category: 'file' });
  const doc = new MkvDoc({ source, format: FORMAT, root });
  const ctx = createContext(source, doc);
  doc.ctx = ctx;
  await parseFile(ctx, root, onProgress);
  buildTracks(doc, ctx);
  labelTree(root);
  doc.summary = summarize(doc, ctx);
  return doc;
}

const FORMAT = {
  id: 'matroska',
  name: 'Matroska / WebM',
  unit: ['element', 'elements'],
  probe,
  open,
};

export default FORMAT;
