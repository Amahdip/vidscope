// Rebuild each track's samples (file offset, size, decode/presentation time,
// key frame flag) from the sample tables, or from movie fragments.

import { cell, column } from '../../core/fields.js';

/** Samples described by a trak's stbl (non-fragmented files). */
export function samplesFromStbl(trak, timescale) {
  const stbl = trak.find('stbl');
  if (!stbl) return null;
  const stsz = stbl.child('stsz') ?? stbl.child('stz2');
  const stsc = stbl.child('stsc');
  const stco = stbl.child('stco') ?? stbl.child('co64');
  const stts = stbl.child('stts');
  const ctts = stbl.child('ctts');
  const stss = stbl.child('stss');
  const problems = [];
  if (!stsz || !stsc || !stco) return null;

  const n = stsz.data.count ?? 0;
  const sizes = new Uint32Array(n);
  if (stsz.type === 'stsz') {
    if (stsz.data.fixed) sizes.fill(stsz.data.fixed);
    else if (stsz.data.table) sizes.set(column(stsz.data.table, 0).subarray(0, Math.min(n, stsz.data.table.count)));
  } else if (stsz.data.table) {
    const t = stsz.data.table;
    if (stsz.data.fieldSize === 4) {
      for (let i = 0; i < n; i++) sizes[i] = cell(t, i >> 1, i & 1);
    } else {
      sizes.set(column(t, 0).subarray(0, Math.min(n, t.count)));
    }
  }

  const chunkOffsets = stco.data.table ? column(stco.data.table, 0) : new Uint32Array(0);
  const offsets = new Float64Array(n);
  const chunk = new Uint32Array(n);
  const sdi = new Uint16Array(n);
  let s = 0;
  const st = stsc.data.table;
  const entries = st ? st.count : 0;
  for (let e = 0; e < entries && s < n; e++) {
    const first = cell(st, e, 0) - 1;
    const spc = cell(st, e, 1);
    const desc = cell(st, e, 2);
    const next = e + 1 < entries ? cell(st, e + 1, 0) - 1 : chunkOffsets.length;
    if (first < 0 || next < first) {
      problems.push(`stsc entry ${e + 1} has an invalid first_chunk`);
      break;
    }
    for (let c = first; c < next && s < n; c++) {
      let off = chunkOffsets[c] ?? 0;
      for (let k = 0; k < spc && s < n; k++) {
        offsets[s] = off;
        chunk[s] = c;
        sdi[s] = desc;
        off += sizes[s];
        s++;
      }
    }
  }
  if (s < n) problems.push(`stsc/stco place only ${s} of ${n} samples`);

  const dts = new Float64Array(n);
  const durations = new Float64Array(n);
  let t = 0;
  let i = 0;
  if (stts?.data.table) {
    const tt = stts.data.table;
    for (let e = 0; e < tt.count && i < n; e++) {
      const count = tt.dv.getUint32(tt.rel + e * 8);
      const delta = tt.dv.getUint32(tt.rel + e * 8 + 4);
      for (let k = 0; k < count && i < n; k++, i++) {
        dts[i] = t;
        durations[i] = delta;
        t += delta;
      }
    }
    if (stts.data.samples !== n) problems.push(`stts covers ${stts.data.samples} samples but stsz has ${n}`);
  }

  let cto = null;
  if (ctts?.data.table) {
    cto = new Int32Array(n);
    const ct = ctts.data.table;
    const signed = ctts.data.version === 1;
    let j = 0;
    for (let e = 0; e < ct.count && j < n; e++) {
      const count = ct.dv.getUint32(ct.rel + e * 8);
      const off = signed ? ct.dv.getInt32(ct.rel + e * 8 + 4) : ct.dv.getInt32(ct.rel + e * 8 + 4);
      for (let k = 0; k < count && j < n; k++) cto[j++] = off;
    }
  }

  let key = null;
  if (stss?.data.table) {
    key = new Uint8Array(n);
    const kt = stss.data.table;
    for (let e = 0; e < kt.count; e++) {
      const num = kt.dv.getUint32(kt.rel + e * 4);
      if (num >= 1 && num <= n) key[num - 1] = 1;
    }
  }

  return { count: n, timescale, offsets, sizes, dts, cto, durations, key, chunk, sdi, placed: s, problems, source: 'stbl' };
}

class Grow {
  constructor(Type) {
    this.Type = Type;
    this.a = new Type(1024);
    this.n = 0;
  }

  push(v) {
    if (this.n === this.a.length) {
      const b = new this.Type(this.a.length * 2);
      b.set(this.a);
      this.a = b;
    }
    this.a[this.n++] = v;
  }

  done() {
    return this.a.slice(0, this.n);
  }
}

/**
 * Samples from movie fragments (moof/traf/trun), per track ID.
 * `tracks` maps track_ID -> { timescale, trex } and receives the tables.
 */
export function samplesFromFragments(root, tracks) {
  const acc = new Map();
  const get = (id) => {
    let a = acc.get(id);
    if (!a) {
      a = { offsets: new Grow(Float64Array), sizes: new Grow(Uint32Array), dts: new Grow(Float64Array), durations: new Grow(Float64Array), cto: new Grow(Int32Array), key: new Grow(Uint8Array), frag: new Grow(Uint32Array), t: 0, anyCto: false, problems: [] };
      acc.set(id, a);
    }
    return a;
  };
  let fragIndex = 0;
  for (const moof of root.children ?? []) {
    if (moof.type !== 'moof') continue;
    let prevTrafEnd = moof.offset;
    let firstTraf = true;
    for (const traf of moof.childrenOf('traf')) {
      const tfhd = traf.child('tfhd');
      if (!tfhd) continue;
      const id = tfhd.data.trackId;
      const info = tracks.get(id) ?? {};
      const trex = info.trex ?? {};
      const a = get(id);
      const fl = tfhd.data.flags ?? 0;
      let base;
      if (tfhd.data.baseDataOffset !== undefined) base = tfhd.data.baseDataOffset;
      else if (fl & 0x20000) base = moof.offset;
      else base = firstTraf ? moof.offset : prevTrafEnd;
      firstTraf = false;
      const tfdt = traf.child('tfdt');
      if (tfdt) a.t = tfdt.data.time;
      const defDur = tfhd.data.duration ?? trex.duration ?? 0;
      const defSize = tfhd.data.size ?? trex.size ?? 0;
      const defFlags = tfhd.data.sampleFlags ?? trex.sampleFlags ?? 0;
      let pos = base;
      for (const trun of traf.childrenOf('trun')) {
        const d = trun.data;
        if (d.dataOffset !== undefined) pos = base + d.dataOffset;
        const t = d.table;
        const col = (name) => (t ? t.columns.findIndex((c) => c.name === name) : -1);
        const cDur = col('sample_duration');
        const cSize = col('sample_size');
        const cFlags = col('sample_flags');
        const cCto = col('sample_composition_time_offset');
        const count = t ? t.count : d.count ?? 0;
        for (let i = 0; i < count; i++) {
          const size = cSize >= 0 ? cell(t, i, cSize) : defSize;
          const dur = cDur >= 0 ? cell(t, i, cDur) : defDur;
          const flags = i === 0 && d.firstFlags !== undefined ? d.firstFlags : cFlags >= 0 ? cell(t, i, cFlags) : defFlags;
          const cto = cCto >= 0 ? cell(t, i, cCto) : 0;
          if (cto) a.anyCto = true;
          a.offsets.push(pos);
          a.sizes.push(size);
          a.dts.push(a.t);
          a.durations.push(dur);
          a.cto.push(cto);
          a.key.push((flags >>> 16) & 1 ? 0 : 1);
          a.frag.push(fragIndex);
          pos += size;
          a.t += dur;
        }
      }
      prevTrafEnd = pos;
    }
    fragIndex++;
  }
  const out = new Map();
  for (const [id, a] of acc) {
    out.set(id, {
      count: a.offsets.n,
      timescale: tracks.get(id)?.timescale ?? 0,
      offsets: a.offsets.done(),
      sizes: a.sizes.done(),
      dts: a.dts.done(),
      durations: a.durations.done(),
      cto: a.anyCto ? a.cto.done() : null,
      key: a.key.done(),
      frag: a.frag.done(),
      placed: a.offsets.n,
      problems: a.problems,
      source: 'fragments',
    });
  }
  return out;
}

/** Append fragment samples after any samples already listed in moov. */
export function concatSamples(a, b) {
  if (!a || !a.count) return b;
  if (!b || !b.count) return a;
  const cat = (x, y, T) => {
    if (!x && !y) return null;
    const out = new T(a.count + b.count);
    if (x) out.set(x);
    else if (T === Uint8Array) out.fill(1, 0, a.count);
    if (y) out.set(y, a.count);
    else if (T === Uint8Array) out.fill(1, a.count);
    return out;
  };
  return {
    ...a,
    count: a.count + b.count,
    offsets: cat(a.offsets, b.offsets, Float64Array),
    sizes: cat(a.sizes, b.sizes, Uint32Array),
    dts: cat(a.dts, b.dts, Float64Array),
    durations: cat(a.durations, b.durations, Float64Array),
    cto: a.cto || b.cto ? cat(a.cto ?? new Int32Array(a.count), b.cto ?? new Int32Array(b.count), Int32Array) : null,
    key: a.key || b.key ? cat(a.key, b.key, Uint8Array) : null,
    placed: a.placed + b.placed,
    problems: [...a.problems, ...b.problems],
    source: 'stbl+fragments',
  };
}

/**
 * All samples of all tracks sorted by file offset, so the hex view can find
 * which sample owns a byte in mdat with a binary search.
 */
export class SampleIndex {
  constructor(tracks) {
    const lists = tracks.filter((t) => t.samples && t.samples.count);
    let total = 0;
    for (const t of lists) total += t.samples.placed ?? t.samples.count;
    this.count = total;
    this.starts = new Float64Array(total);
    this.ends = new Float64Array(total);
    this.track = new Uint16Array(total);
    this.sample = new Uint32Array(total);
    this.tracks = lists;
    // K-way merge; each track's samples are normally already in file order.
    const pos = lists.map(() => 0);
    const counts = lists.map((t) => t.samples.placed ?? t.samples.count);
    let sorted = true;
    for (let k = 0; k < lists.length && sorted; k++) {
      const o = lists[k].samples.offsets;
      for (let i = 1; i < counts[k]; i++) {
        if (o[i] < o[i - 1]) {
          sorted = false;
          break;
        }
      }
    }
    let w = 0;
    if (sorted) {
      for (;;) {
        let best = -1;
        let bestOff = Infinity;
        for (let k = 0; k < lists.length; k++) {
          if (pos[k] < counts[k]) {
            const o = lists[k].samples.offsets[pos[k]];
            if (o < bestOff) {
              bestOff = o;
              best = k;
            }
          }
        }
        if (best < 0) break;
        const i = pos[best]++;
        const s = lists[best].samples;
        this.starts[w] = s.offsets[i];
        this.ends[w] = s.offsets[i] + s.sizes[i];
        this.track[w] = lists[best].index;
        this.sample[w] = i;
        w++;
      }
    } else {
      const all = [];
      lists.forEach((t, k) => {
        for (let i = 0; i < counts[k]; i++) all.push([t.samples.offsets[i], t.index, i, t.samples.sizes[i]]);
      });
      all.sort((x, y) => x[0] - y[0]);
      for (const [o, ti, i, size] of all) {
        this.starts[w] = o;
        this.ends[w] = o + size;
        this.track[w] = ti;
        this.sample[w] = i;
        w++;
      }
    }
  }

  /** Index of the sample containing `offset`, or -1. */
  find(offset) {
    let lo = 0;
    let hi = this.count - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.starts[mid] <= offset) {
        ans = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return ans >= 0 && offset < this.ends[ans] ? ans : -1;
  }

  /** First sample index whose end is after `offset`. */
  firstEndingAfter(offset) {
    let lo = 0;
    let hi = this.count - 1;
    let ans = this.count;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.starts[mid] <= offset) lo = mid + 1;
      else {
        ans = mid;
        hi = mid - 1;
      }
    }
    // ans = first sample starting after offset; the one before may still cover it.
    if (ans > 0 && this.ends[ans - 1] > offset) return ans - 1;
    return ans;
  }
}
