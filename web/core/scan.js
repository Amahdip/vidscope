// Helpers for formats whose frame list comes from walking long runs of small
// headers (RIFF chunks, FLV tags): growable typed arrays, a sorted index of
// frames for the hex view, and a windowed reader that bypasses the block cache.

/** A typed array that grows as values are pushed. */
export class Grow {
  constructor(Type, initial = 1024) {
    this.Type = Type;
    this.a = new Type(initial);
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

  get(i) {
    return this.a[i];
  }

  done() {
    return this.a.slice(0, this.n);
  }
}

/**
 * Every frame of every track sorted by file offset, so the hex view and
 * detailAt() can find the frame that owns a byte with a binary search.
 * Zero-length frames (AVI drop-frame placeholders) are left out.
 */
export class FrameIndex {
  constructor(tracks) {
    const lists = tracks.filter((t) => t.samples && t.samples.count);
    let total = 0;
    for (const t of lists) total += t.samples.count;
    this.starts = new Float64Array(total);
    this.ends = new Float64Array(total);
    this.track = new Uint16Array(total);
    this.sample = new Uint32Array(total);
    let w = 0;
    const sorted = lists.every((t) => {
      const o = t.samples.offsets;
      for (let i = 1; i < t.samples.count; i++) if (o[i] < o[i - 1]) return false;
      return true;
    });
    if (sorted) {
      // K-way merge of the per-track lists (each already in file order).
      const pos = new Uint32Array(lists.length);
      for (;;) {
        let best = -1;
        let bestOff = Infinity;
        for (let k = 0; k < lists.length; k++) {
          const s = lists[k].samples;
          while (pos[k] < s.count && s.sizes[pos[k]] === 0) pos[k]++;
          if (pos[k] < s.count && s.offsets[pos[k]] < bestOff) {
            bestOff = s.offsets[pos[k]];
            best = k;
          }
        }
        if (best < 0) break;
        const s = lists[best].samples;
        const i = pos[best]++;
        this.starts[w] = s.offsets[i];
        this.ends[w] = s.offsets[i] + s.sizes[i];
        this.track[w] = lists[best].index;
        this.sample[w] = i;
        w++;
      }
    } else {
      const keys = new Float64Array(total);
      const who = new Uint32Array(total);
      const idx = new Uint32Array(total);
      let n = 0;
      lists.forEach((t, k) => {
        const s = t.samples;
        for (let i = 0; i < s.count; i++) {
          if (!s.sizes[i]) continue;
          keys[n] = s.offsets[i];
          who[n] = k;
          idx[n] = i;
          n++;
        }
      });
      const order = new Uint32Array(n);
      for (let k = 0; k < n; k++) order[k] = k;
      order.sort((a, b) => keys[a] - keys[b] || a - b);
      for (const k of order) {
        const t = lists[who[k]];
        const i = idx[k];
        this.starts[w] = t.samples.offsets[i];
        this.ends[w] = t.samples.offsets[i] + t.samples.sizes[i];
        this.track[w] = t.index;
        this.sample[w] = i;
        w++;
      }
    }
    this.count = w;
  }

  /** Index of the frame containing `offset`, or -1. */
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

  /** First frame whose end is after `offset`. */
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
    if (ans > 0 && this.ends[ans - 1] > offset) return ans - 1;
    return ans;
  }

  /** Runs for the hex view overlay inside [a, b). */
  runs(a, b, unitCache) {
    const out = [];
    for (let k = this.firstEndingAfter(a); k < this.count && this.starts[k] < b; k++) {
      const start = this.starts[k];
      const t = this.track[k];
      const i = this.sample[k];
      out.push({
        start: Math.max(a, start),
        end: Math.min(b, this.ends[k]),
        track: t,
        sample: i,
        part: i & 1,
        first: start >= a,
        sampleStart: start,
        units: unitCache?.get(`${t}:${i}`) ?? null,
      });
    }
    return out;
  }
}

/**
 * Reads a file in large windows (which bypass the block cache) so a
 * walk over hundreds of thousands of small headers costs a few big reads.
 */
export class WindowReader {
  constructor(source, windowSize = 4 << 20) {
    this.source = source;
    this.size = windowSize;
    this.base = 0;
    this.u8 = new Uint8Array(0);
    this.bytesRead = 0;
  }

  /** Bytes [pos, pos+n) (clamped at EOF); returns {u8, i} with u8[i] the byte at pos. */
  async at(pos, n) {
    if (pos < this.base || pos + n > this.base + this.u8.length) {
      const want = Math.max(n, this.size);
      this.u8 = await this.source.read(pos, want);
      this.base = pos;
      this.bytesRead += this.u8.length;
    }
    return { u8: this.u8, i: pos - this.base, avail: this.base + this.u8.length - pos };
  }
}

export function u32le(u8, p) {
  return (u8[p] | (u8[p + 1] << 8) | (u8[p + 2] << 16)) + u8[p + 3] * 0x1000000;
}

export function u32be(u8, p) {
  return u8[p] * 0x1000000 + ((u8[p + 1] << 16) | (u8[p + 2] << 8) | u8[p + 3]);
}

export function u24be(u8, p) {
  return (u8[p] << 16) | (u8[p + 1] << 8) | u8[p + 2];
}

/** True for four bytes that are printable ASCII (a plausible FOURCC). */
export function printable4(u8, p) {
  for (let k = 0; k < 4; k++) {
    const c = u8[p + k];
    if (c === undefined || c < 0x20 || c > 0x7e) return false;
  }
  return true;
}

/** A FOURCC stored as a little-endian number (as walkers keep them) back to text. */
export function fccFromNum(v) {
  return String.fromCharCode(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
}

/** Median of a numeric list (copy sorted). */
export function median(values) {
  if (!values.length) return 0;
  const s = Float64Array.from(values).sort();
  const m = s.length >> 1;
  return s.length & 1 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Yield to the event loop now and then during long loops. */
export function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
