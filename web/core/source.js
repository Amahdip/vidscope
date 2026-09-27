// Random access to a file's bytes without loading the whole file.
//
// A "raw" source only needs `size`, `name` and `readRaw(offset, length)`.
// CachedSource wraps one with a block cache so parsers and the hex view can
// make many small reads cheaply, and so the hex view can render synchronously
// whenever the bytes it needs are already cached.

export class BlobSource {
  constructor(blob, name) {
    this.blob = blob;
    this.size = blob.size;
    this.name = name ?? blob.name ?? 'file';
  }

  async readRaw(offset, length) {
    const buf = await this.blob.slice(offset, offset + length).arrayBuffer();
    return new Uint8Array(buf);
  }
}

export class HttpSource {
  /**
   * Byte ranges of a URL. `headers` go on every request (a token, a proxy hint); a read that
   * fails or hangs is retried a few times, because one lost request must not fail an audit
   * that has already read most of a file.
   */
  constructor(url, size, name, { headers = {}, retries = 3, timeoutMs = 30000 } = {}) {
    this.url = url;
    this.size = size;
    this.name = name;
    this.headers = headers;
    this.retries = retries;
    this.timeoutMs = timeoutMs;
    this.stats = { requests: 0, bytes: 0, retries: 0 };
  }

  /**
   * Open a URL: the size comes from the Content-Range of a one-byte range request (every
   * server that supports ranges answers it), else from Content-Length of a HEAD.
   */
  static async open(url, { headers = {}, name, retries, timeoutMs } = {}) {
    const opts = { headers: { ...headers, Range: 'bytes=0-0' } };
    const res = await fetch(url, opts);
    let size = null;
    const cr = res.headers.get('content-range');
    const m = cr && /\/(\d+)\s*$/.exec(cr);
    if (res.status === 206 && m) size = Number(m[1]);
    else if (res.ok) {
      // No range support: Content-Length of the whole file, and every read will fetch it all.
      const len = res.headers.get('content-length');
      if (len) size = Number(len);
    }
    if (res.body?.cancel) await res.body.cancel().catch(() => {});
    if (size === null) {
      const head = await fetch(url, { method: 'HEAD', headers });
      const len = head.headers.get('content-length');
      if (!head.ok || !len) throw new Error(`HTTP ${head.status}: cannot find the size of ${url}`);
      size = Number(len);
    }
    const base = name ?? decodeURIComponent(new URL(url).pathname.split('/').pop() || 'remote');
    return new HttpSource(url, size, base, { headers, retries, timeoutMs });
  }

  async readRaw(offset, length) {
    // A server that ignored Range once will ignore it again: keep the body it sent and
    // serve every later read from it rather than download the file for each read.
    if (this.whole) return this.whole.subarray(offset, offset + length);
    const last = offset + length - 1;
    let lastError = null;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      const ctl = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = ctl ? setTimeout(() => ctl.abort(), this.timeoutMs) : null;
      try {
        this.stats.requests++;
        const res = await fetch(this.url, { headers: { ...this.headers, Range: `bytes=${offset}-${last}` }, signal: ctl?.signal });
        if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status} while reading bytes ${offset}-${last}`);
        if (!res.ok) {
          const err = new Error(`HTTP ${res.status} while reading bytes ${offset}-${last}`);
          err.fatal = true;
          throw err;
        }
        const buf = new Uint8Array(await res.arrayBuffer());
        this.stats.bytes += buf.length;
        // A server that ignores Range answers 200 with the whole file.
        if (res.status === 200) {
          this.whole = buf;
          this.stats.wholeFile = true;
          return buf.subarray(offset, offset + length);
        }
        return buf;
      } catch (e) {
        lastError = e;
        if (e.fatal || attempt === this.retries) break;
        this.stats.retries++;
        await new Promise((r) => setTimeout(r, 250 * 2 ** attempt));
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    throw lastError;
  }
}

/** A source over bytes already in memory (tests, small files). */
export class BytesSource {
  constructor(bytes, name = 'bytes') {
    this.bytes = bytes;
    this.size = bytes.length;
    this.name = name;
  }

  async readRaw(offset, length) {
    return this.bytes.subarray(offset, offset + length);
  }
}

export class CachedSource {
  constructor(inner, { blockSize = 64 * 1024, maxBytes = 96 * 1024 * 1024 } = {}) {
    this.inner = inner;
    this.size = inner.size;
    this.name = inner.name;
    this.bs = blockSize;
    this.maxBlocks = Math.max(16, Math.floor(maxBytes / blockSize));
    this.blocks = new Map(); // block index -> Uint8Array, kept in LRU order
    this.pending = new Map(); // block index -> Promise<Uint8Array>
    this.loose = []; // small unaligned windows from peek(), newest last
    this.stats = { reads: 0, bytes: 0 };
  }

  /**
   * Read a few header bytes while walking a list of elements. When the walk moves
   * through elements smaller than a block, the previous block is cached and a block
   * read covers the next few headers too. When elements are larger (clusters or
   * fragments of megabytes), only the bytes asked for (at least 4 KiB, at most
   * 64 KiB) are fetched, so listing a long file reads kilobytes per element.
   */
  async peek(offset, length) {
    const [start, end] = this._span(offset, length);
    if (end <= start) return new Uint8Array(0);
    const cached = this.readSync(start, end - start) ?? this._looseHit(start, end);
    if (cached) return cached;
    // The previous block is cached: we are walking through small elements, and one
    // block read will cover the next few headers too.
    const i = Math.floor(start / this.bs);
    if (length > 64 * 1024 || this.blocks.has(i - 1) || this.pending.has(i - 1)) return this.read(start, end - start);
    const n = Math.min(this.size - start, Math.max(end - start, 4096));
    const u8 = await this.inner.readRaw(start, n);
    this.stats.reads++;
    this.stats.bytes += u8.length;
    this.loose.push({ start, u8 });
    if (this.loose.length > 64) this.loose.shift();
    return u8.subarray(0, end - start);
  }

  _looseHit(start, end) {
    for (let k = this.loose.length - 1; k >= 0; k--) {
      const w = this.loose[k];
      if (start >= w.start && end <= w.start + w.u8.length) return w.u8.subarray(start - w.start, end - w.start);
    }
    return null;
  }

  _get(i) {
    const b = this.blocks.get(i);
    if (b) {
      this.blocks.delete(i);
      this.blocks.set(i, b);
    }
    return b;
  }

  _put(i, b) {
    this.blocks.set(i, b);
    while (this.blocks.size > this.maxBlocks) this.blocks.delete(this.blocks.keys().next().value);
  }

  block(i) {
    const cached = this._get(i);
    if (cached) return Promise.resolve(cached);
    let p = this.pending.get(i);
    if (!p) {
      const start = i * this.bs;
      const len = Math.min(this.bs, this.size - start);
      p = this.inner.readRaw(start, len).then(
        (u8) => {
          this.pending.delete(i);
          this._put(i, u8);
          this.stats.reads++;
          this.stats.bytes += u8.length;
          return u8;
        },
        (err) => {
          this.pending.delete(i);
          throw err;
        },
      );
      this.pending.set(i, p);
    }
    return p;
  }

  _span(offset, length) {
    const start = Math.max(0, Math.floor(offset));
    const end = Math.min(this.size, start + Math.max(0, Math.floor(length)));
    return [start, end];
  }

  /** Read [offset, offset+length), clamped to the file. Returned bytes must not be modified. */
  async read(offset, length) {
    const [start, end] = this._span(offset, length);
    if (end <= start) return new Uint8Array(0);
    const loose = end - start <= 64 * 1024 ? this._looseHit(start, end) : null;
    if (loose) return loose;
    const first = Math.floor(start / this.bs);
    const last = Math.floor((end - 1) / this.bs);
    if (last - first >= 16) {
      // Large reads bypass the cache so they don't evict everything else.
      this.stats.reads++;
      this.stats.bytes += end - start;
      return this.inner.readRaw(start, end - start);
    }
    if (first === last) {
      const b = await this.block(first);
      const o = start - first * this.bs;
      return b.subarray(o, o + (end - start));
    }
    const parts = [];
    for (let i = first; i <= last; i++) parts.push(this.block(i));
    return this._assemble(start, end, first, await Promise.all(parts));
  }

  /** Like read(), but only from cache; returns null when any block is missing. */
  readSync(offset, length) {
    const [start, end] = this._span(offset, length);
    if (end <= start) return new Uint8Array(0);
    const first = Math.floor(start / this.bs);
    const last = Math.floor((end - 1) / this.bs);
    const parts = [];
    for (let i = first; i <= last; i++) {
      const b = this._get(i);
      if (!b) return null;
      parts.push(b);
    }
    if (parts.length === 1) {
      const o = start - first * this.bs;
      return parts[0].subarray(o, o + (end - start));
    }
    return this._assemble(start, end, first, parts);
  }

  /** Warm the cache for a range without waiting. */
  prefetch(offset, length) {
    const [start, end] = this._span(offset, length);
    if (end <= start) return Promise.resolve();
    const first = Math.floor(start / this.bs);
    const last = Math.floor((end - 1) / this.bs);
    const ps = [];
    for (let i = first; i <= last && i - first < 64; i++) ps.push(this.block(i));
    return Promise.all(ps).then(() => {});
  }

  _assemble(start, end, first, parts) {
    const out = new Uint8Array(end - start);
    let w = 0;
    for (let k = 0; k < parts.length; k++) {
      const bStart = (first + k) * this.bs;
      const s = Math.max(start, bStart) - bStart;
      const e = Math.min(end, bStart + parts[k].length) - bStart;
      if (e > s) {
        out.set(parts[k].subarray(s, e), w);
        w += e - s;
      }
    }
    return w === out.length ? out : out.subarray(0, w);
  }
}
