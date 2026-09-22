// A parsed file. Formats return a Doc (usually a subclass) from open().
//
// Hooks a format can override:
//   overlay(a, b)       runs of samples/frames inside opaque payloads, for the hex view
//   detailAt(offset)    a Detail record describing bytes inside a payload (sample, NAL unit...)
//   insights()          findings for the File Insights tab
//   glossary()          format-specific glossary entries
//   frameCodec(t)       codec family and context for classifying a track's frames (I/P/B)
//   framesContiguous    false when a frame's bytes are scattered (MPEG-TS packets)
//   frameHead(t, i, n)  the first n bytes of frame i's codec data
//
// A Track (doc.tracks) looks like:
//   { id, index, kind: 'video'|'audio'|'subtitle'|'data', codec, codecName, codecString,
//     label, props: [[label, value], ...], node, samples?: SampleTable }
// A SampleTable: { count, timescale, offsets: Float64Array, sizes: Uint32Array,
//   dts: Float64Array, cto?: Int32Array, durations: Float64Array, key?: Uint8Array }
// An Insight: { level: 'good'|'info'|'warn'|'bad', group, title, text, facts?: [[k, v]], node?, offset?, cmd? }
// A Detail: { title, subtitle?, range: [start, end], rows: [[k, v]], text?, units?: [{ title,
//   offset, size, summary?, fields: Field[] }], hit?: { unit, field } }

import { nodeAt, nodeAtDeep, segments, countNodes, walk } from './model.js';

export class Doc {
  constructor({ source, format, root }) {
    this.source = source;
    this.format = format;
    this.root = root;
    this.tracks = [];
    this.warnings = [];
    this.summary = {
      label: format.name,
      anatomy: `${format.name} anatomy`,
      duration: null,
    };
    this.unit = format.unit || ['box', 'boxes'];
    this._count = null;
  }

  get size() {
    return this.source.size;
  }

  get name() {
    return this.source.name;
  }

  get nodeCount() {
    if (this._count === null) this._count = countNodes(this.root);
    return this._count;
  }

  /** Call after lazy children were loaded. */
  recount() {
    this._count = null;
  }

  nodeAt(offset) {
    return nodeAt(this.root, offset);
  }

  nodeAtDeep(offset) {
    return nodeAtDeep(this.root, offset);
  }

  segments(a, b) {
    return segments(this.root, a, b);
  }

  findById(id) {
    for (const n of walk(this.root)) if (n.id === id) return n;
    return null;
  }

  overlay() {
    return null;
  }

  async detailAt() {
    return null;
  }

  async insights() {
    return [];
  }

  glossary() {
    return [];
  }

  /**
   * What web/codecs/frametype.js needs to classify the frames of track t:
   * { family, lengthSize, annexB, state }, or null when its frames can't be read as codec data.
   */
  frameCodec(t) {
    const c = t.sampleCfg;
    const family = c?.family ?? t.family ?? null;
    return family ? { family, lengthSize: c?.lengthSize ?? 4, annexB: !!c?.annexB, encrypted: !!c?.encrypted, state: c?.state ?? null } : null;
  }

  /** True when frame i's codec data is the single run samples.offsets[i] … + sizes[i]. */
  get framesContiguous() {
    return true;
  }

  /** The first n bytes of frame i of track t. */
  frameHead(t, i, n) {
    const s = t.samples;
    return this.source.read(s.offsets[i], Math.min(s.sizes[i], n));
  }
}
