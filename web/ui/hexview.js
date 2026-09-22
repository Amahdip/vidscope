// The hex view. It scrolls virtually over the whole file (any size), colours each
// byte by the box, field and sample that owns it, and identifies bytes on hover/click.

import { h, clear } from './dom.js';
import { HEX2, hex, fmtInt, hexDigits, asciiChar, humanSize, clamp } from '../core/util.js';
import { leafFields, fieldPath, ensureChildren } from '../core/model.js';
import { showTip, hideTip } from './tooltip.js';

const BPR = 16;
const TRACK_COLORS = 6;

const isSizeName = (n) => /size|length/i.test(n);
const isTypeName = (n) => /^(type|id|ckid|fourcc|tag|tagtype|sync|signature|ebml ?id|element ?id)/i.test(n);

export class HexView {
  constructor(el, app) {
    this.app = app;
    this.el = el;
    this.doc = null;
    this.top = 0;
    this.rowsN = 0;
    this.cells = [];
    this.hover = null;
    this.pending = null;
    this.wheelAcc = 0;
    this.unitsRequested = new Set();
    this.build();
    app.store.subscribe((s, ch) => {
      if (ch.has('doc')) this.setDoc(s.doc);
      else if (ch.has('sel') || ch.has('docVersion') || ch.has('samplesReady')) this.render();
      if (ch.has('theme')) this.drawMap();
      if (ch.has('samplesReady') || ch.has('doc')) this.renderFoot();
    });
    new ResizeObserver(() => this.layout()).observe(this.rowsEl);
  }

  build() {
    this.btnUp = h('button', { class: 'btn', title: 'Previous page (PgUp)', onclick: () => this.page(-1) }, '↑ page');
    this.btnDn = h('button', { class: 'btn', title: 'Next page (PgDn)', onclick: () => this.page(1) }, '↓ page');
    this.rangeEl = h('span', { class: 'range' });
    this.findEl = h('input', {
      class: 'find',
      type: 'search',
      placeholder: 'find text or hex',
      spellcheck: 'false',
      'aria-label': 'Find bytes (text such as mdat, or hex such as 00 00 01)',
      title: 'Text (mdat, x264) or hex (00 00 01, 0x6D646174). Enter finds the next match.',
      onkeydown: (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          this.find(this.findEl.value);
        } else if (e.key === 'Escape') {
          this.findEl.value = '';
          this.findStatus.textContent = '';
          this.rowsEl.focus();
        }
      },
    });
    this.findStatus = h('span', { class: 'findst' });
    this.rowsEl = h('div', { class: 'hexrows', tabindex: '0', role: 'grid', 'aria-label': 'Hex view of the file' });
    this.canvas = h('canvas');
    this.thumb = h('div', { class: 'thumb' });
    this.map = h('div', { class: 'hexmap', 'data-tip': 'The whole file, top to bottom.\nClick or drag to scroll.' }, this.canvas, this.thumb);
    this.foot = h('div', { class: 'hexfoot' });
    this.el.append(
      h('div', { class: 'hexbar' }, this.btnUp, this.btnDn, this.rangeEl, h('span', { class: 'hint' }, 'click any byte to identify it'), this.findEl, this.findStatus),
      h('div', { class: 'hexwrap' }, this.rowsEl, this.map),
      this.foot,
    );
    this.rowsEl.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    this.rowsEl.addEventListener('mousemove', (e) => this.onMove(e));
    this.rowsEl.addEventListener('mouseleave', () => this.setHover(null));
    this.rowsEl.addEventListener('mousedown', (e) => this.onDown(e));
    this.rowsEl.addEventListener('keydown', (e) => this.onKey(e));
    this.map.addEventListener('mousedown', (e) => this.onMapDown(e));
  }

  setDoc(doc) {
    this.doc = doc;
    this.top = 0;
    this.hover = null;
    this.unitsRequested.clear();
    this.digits = doc ? hexDigits(doc.size) : 8;
    this.cells.forEach((c) => c.off.classList.toggle('wide', this.digits > 8));
    this.drawMap();
    this.render();
  }

  // ------------------------------------------------------------ layout

  layout() {
    const rowH = parseFloat(getComputedStyle(this.rowsEl).getPropertyValue('--row')) || 22;
    this.rowH = rowH;
    const n = Math.max(1, Math.floor((this.rowsEl.clientHeight - 12) / rowH));
    if (n !== this.rowsN) {
      this.rowsN = n;
      clear(this.rowsEl);
      this.cells = [];
      for (let r = 0; r < n; r++) {
        const off = h('span', { class: `o${this.digits > 8 ? ' wide' : ''}` });
        const hx = h('span', { class: 'hx' });
        const as = h('span', { class: 'as' });
        const b = [];
        const a = [];
        for (let i = 0; i < BPR; i++) {
          const bs = document.createElement('span');
          bs._r = r;
          bs._i = i;
          b.push(bs);
          hx.append(bs);
          const ac = document.createElement('span');
          ac._r = r;
          ac._i = i;
          a.push(ac);
          as.append(ac);
        }
        const row = h('div', { class: 'hrow', role: 'row' }, off, hx, as);
        this.rowsEl.append(row);
        this.cells.push({ row, off, b, a });
      }
    }
    this.drawMap();
    this.render();
  }

  /** Hide the ASCII column when offset + hex + ASCII would not fit the pane. */
  fitAscii() {
    const cell = this.cells[0];
    if (!cell) return;
    const em = parseFloat(getComputedStyle(this.rowsEl).fontSize) || 13;
    const need = cell.off.offsetWidth + cell.b[0].parentNode.offsetWidth + 20 + 16 * 0.72 * em + 18;
    this.rowsEl.classList.toggle('no-ascii', need > this.rowsEl.clientWidth);
  }

  get span() {
    return this.rowsN * BPR;
  }

  maxTop() {
    const size = this.doc?.size ?? 0;
    return Math.max(0, Math.ceil(size / BPR) * BPR - this.span);
  }

  scrollTo(top) {
    const t = clamp(Math.floor(top / BPR) * BPR, 0, this.maxTop());
    if (t === this.top) return;
    this.top = t;
    // Whatever was under the pointer has moved.
    this.hover = null;
    hideTip();
    this.render();
  }

  page(dir) {
    this.scrollTo(this.top + dir * this.span);
  }

  /** Bring an offset (and ideally the whole node) into view. */
  reveal(offset, node) {
    if (!this.doc) return;
    const visible = offset >= this.top && offset < this.top + this.span - BPR;
    if (visible && !node) {
      this.render();
      return;
    }
    if (visible && node && node.offset >= this.top) {
      this.render();
      return;
    }
    const lead = Math.min(8, Math.floor(this.rowsN / 4)) * BPR;
    this.scrollTo(Math.floor(offset / BPR) * BPR - lead);
    this.render();
  }

  // ------------------------------------------------------------ rendering

  render() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.paint();
    });
  }

  paint() {
    const doc = this.doc;
    if (!doc || !this.cells.length) return;
    this.fitAscii();
    const size = doc.size;
    const start = this.top;
    const len = Math.max(0, Math.min(this.span, size - start));
    const end = start + len;
    this.rangeEl.textContent = `${hex(start, this.digits)} — ${hex(end, this.digits)} of ${fmtInt(size)} bytes`;
    this.btnUp.disabled = start <= 0;
    this.btnDn.disabled = end >= size;
    this.updateThumb();

    const bytes = doc.source.readSync(start, len);
    if (!bytes || bytes.length < len) this.fetch(start, len);
    const cls = this.classes(start, end);
    const s = this.app.store.get();
    const sel = s.sel;
    const nodeRange = sel?.node && sel.node.parent ? [sel.node.offset, sel.node.end] : null;
    const range = sel?.range;
    const cursor = sel?.offset ?? null;
    const hv = this.hover?.range;

    for (let r = 0; r < this.cells.length; r++) {
      const cell = this.cells[r];
      const rowOff = start + r * BPR;
      const inFile = rowOff < size;
      cell.off.textContent = inFile ? hex(rowOff, this.digits).slice(2) : '';
      for (let i = 0; i < BPR; i++) {
        const o = rowOff + i;
        const k = o - start;
        const b = cell.b[i];
        const a = cell.a[i];
        if (o >= size) {
          b.className = `b${i === 8 ? ' gap8' : ''} none`;
          b.textContent = '  ';
          a.className = 'a none';
          a.textContent = ' ';
          continue;
        }
        let c = cls[k] ?? '';
        if (nodeRange && o >= nodeRange[0] && o < nodeRange[1]) c += ' in';
        if (range && o >= range[0] && o < range[1]) c += ' sel';
        if (hv && o >= hv[0] && o < hv[1]) c += ' hv';
        if (o === cursor) c += ' cur';
        if (bytes && k < bytes.length) {
          const v = bytes[k];
          b.textContent = HEX2[v];
          a.textContent = asciiChar(v);
        } else {
          b.textContent = '··';
          a.textContent = '·';
          c += ' load';
        }
        b.className = `b${i === 8 ? ' gap8' : ''} ${c}`;
        a.className = `a ${c}`;
      }
    }
  }

  fetch(start, len) {
    const key = `${start}:${len}`;
    if (this.pending === key) return;
    this.pending = key;
    this.doc.source.read(start, len).then(() => {
      if (this.pending === key) this.pending = null;
      this.render();
      this.doc?.source.prefetch?.(start + len, this.span * 2);
    }, () => {
      this.pending = null;
    });
  }

  /** CSS classes for each byte of [a, b): structure, header fields, samples. */
  classes(a, b) {
    const doc = this.doc;
    const out = new Array(b - a);
    const segs = doc.segments(a, b);
    this.loadVisibleLazy(segs);
    for (const sg of segs) {
      const cat = sg.node.category;
      let c = `k-${cat}`;
      if (sg.role === 'hdr') {
        const nm = sg.leaf.f.name;
        c += isSizeName(nm) ? ' hs' : isTypeName(nm) ? ' ht' : ' hh';
      } else if (sg.role === 'fld') c += sg.part & 1 ? ' fd p1' : ' fd';
      else if (sg.role === 'tbl') c += sg.part & 1 ? ' tb p1' : ' tb';
      else c += ' py';
      for (let o = sg.start; o < sg.end; o++) out[o - a] = c;
    }
    const ov = doc.overlay?.(a, b);
    if (ov && ov.length) {
      let missing = false;
      for (const run of ov) {
        const t = ` t${run.track % TRACK_COLORS} smp${run.part ? ' s1' : ''}`;
        for (let o = run.start; o < run.end; o++) {
          const k = o - a;
          if (!out[k] || out[k].endsWith(' py')) out[k] = t + (o === run.sampleStart ? ' sf' : '');
        }
        if (run.units) {
          for (const [s, e, uc] of unitRuns(run.units)) {
            for (let o = Math.max(s, run.start); o < Math.min(e, run.end); o++) out[o - a] += uc;
          }
        } else missing = true;
      }
      if (missing && doc.ensureUnits) this.requestUnits(a, b);
    }
    return out;
  }

  /** Load the children of lazy containers (clusters, packet groups...) that are on screen. */
  loadVisibleLazy(segs) {
    const todo = [];
    for (const sg of segs) {
      const n = sg.node;
      if (n.lazy && !n._loading && n.size <= 64 * 1024 * 1024 && !todo.includes(n)) todo.push(n);
    }
    if (!todo.length) return;
    Promise.all(todo.map((n) => ensureChildren(n))).then(() => {
      if (this.doc !== this.app.store.get().doc) return;
      this.doc.recount?.();
      this.app.store.set({ docVersion: this.app.store.get().docVersion + 1 });
    });
  }

  requestUnits(a, b) {
    const key = `${a}:${b}`;
    if (this.unitsRequested.has(key)) return;
    this.unitsRequested.add(key);
    if (this.unitsRequested.size > 2000) this.unitsRequested.clear();
    this.doc.ensureUnits(a, b).then((changed) => {
      if (changed) this.render();
    }).catch(() => {});
  }

  // ------------------------------------------------------------ minimap

  colors() {
    const cs = getComputedStyle(document.documentElement);
    const get = (n) => cs.getPropertyValue(n).trim();
    return {
      bg: get('--bg-1'),
      cat: (c) => get(`--f-${c}`) || get('--f-unknown'),
    };
  }

  drawMap() {
    const doc = this.doc;
    const cv = this.canvas;
    const w = this.map.clientWidth;
    const hgt = this.map.clientHeight;
    if (!w || !hgt) return;
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(hgt * dpr);
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const col = this.colors();
    g.fillStyle = col.bg;
    g.fillRect(0, 0, w, hgt);
    if (!doc) return;
    const scale = hgt / Math.max(1, doc.size);
    const drawNode = (n, depth) => {
      const y0 = n.offset * scale;
      const y1 = Math.max(y0 + 1, n.end * scale);
      g.globalAlpha = depth ? 0.95 : 0.55;
      g.fillStyle = col.cat(n.category);
      g.fillRect(depth ? 3 : 0, y0, depth ? w - 3 : w, y1 - y0);
    };
    for (const n of doc.root.children ?? []) {
      drawNode(n, 0);
      if ((n.end - n.offset) * scale > 6) for (const c of n.children ?? []) if ((c.end - c.offset) * scale >= 1) drawNode(c, 1);
    }
    g.globalAlpha = 1;
    this.updateThumb();
  }

  updateThumb() {
    const doc = this.doc;
    if (!doc) return;
    const hgt = this.map.clientHeight;
    const y0 = (this.top / Math.max(1, doc.size)) * hgt;
    const y1 = (Math.min(doc.size, this.top + this.span) / Math.max(1, doc.size)) * hgt;
    this.thumb.style.top = `${Math.min(hgt - 3, y0)}px`;
    this.thumb.style.height = `${Math.max(3, y1 - y0)}px`;
  }

  onMapDown(e) {
    if (!this.doc) return;
    e.preventDefault();
    const r = this.map.getBoundingClientRect();
    const go = (ev) => {
      const f = clamp((ev.clientY - r.top) / r.height, 0, 1);
      this.scrollTo(f * this.doc.size - this.span / 2);
    };
    go(e);
    const up = () => {
      window.removeEventListener('mousemove', go);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', go);
    window.addEventListener('mouseup', up);
  }

  // ------------------------------------------------------------ interaction

  offsetFromEvent(e) {
    const t = e.target;
    if (t._r === undefined) return null;
    const o = this.top + t._r * BPR + t._i;
    return this.doc && o < this.doc.size ? o : null;
  }

  onWheel(e) {
    if (!this.doc) return;
    e.preventDefault();
    const px = e.deltaMode === 1 ? e.deltaY * this.rowH : e.deltaMode === 2 ? e.deltaY * this.rowH * this.rowsN : e.deltaY;
    this.wheelAcc += px;
    const rows = Math.trunc(this.wheelAcc / this.rowH);
    if (rows) {
      this.wheelAcc -= rows * this.rowH;
      this.scrollTo(this.top + rows * BPR);
    }
  }

  onDown(e) {
    const o = this.offsetFromEvent(e);
    this.rowsEl.focus({ preventScroll: true });
    if (o === null) return;
    e.preventDefault();
    this.app.selectByte(o, { from: 'hex' });
  }

  onMove(e) {
    const o = this.offsetFromEvent(e);
    if (o === null) {
      this.setHover(null);
      hideTip();
      return;
    }
    if (this.hover?.offset !== o) this.setHover(o);
    showTip(e.clientX, e.clientY, this.describe(o));
  }

  setHover(o) {
    if (o === null) {
      if (this.hover) {
        this.hover = null;
        this.render();
      }
      return;
    }
    const doc = this.doc;
    const seg = doc.segments(o, o + 1)[0];
    let range = null;
    if (seg?.leaf) {
      const f = seg.leaf.f;
      range = f.type === 'table' ? [f.offset + seg.entry * f.entrySize, f.offset + (seg.entry + 1) * f.entrySize] : [f.offset, f.offset + f.size];
    } else {
      const run = doc.overlay?.(o, o + 1)?.[0];
      if (run) {
        const u = run.units?.find((x) => o >= x.offset && o < x.offset + x.size);
        range = u ? [u.offset, u.offset + u.size] : null;
      }
    }
    this.hover = { offset: o, range, seg };
    this.render();
  }

  describe(o) {
    const doc = this.doc;
    const bytes = doc.source.readSync(o, 1);
    const v = bytes?.[0];
    const lines = [`${hex(o, this.digits)}  (${fmtInt(o)})`];
    if (v !== undefined) lines.push(`byte 0x${HEX2[v]} = ${v}${v >= 0x20 && v < 0x7f ? ` '${String.fromCharCode(v)}'` : ''}`);
    const seg = this.hover?.seg ?? doc.segments(o, o + 1)[0];
    if (seg) {
      const path = seg.node.parent ? seg.node.pathString() : 'file';
      if (seg.leaf) {
        const hit = { f: seg.leaf.f, parents: seg.leaf.parents, entry: seg.entry };
        lines.push(`${path} › ${fieldPath(hit)}`);
        if (seg.leaf.f.type !== 'table' && seg.leaf.f.display) lines.push(`= ${truncate(seg.leaf.f.display, 90)}`);
      } else {
        lines.push(`${path} (${seg.node.name || seg.node.type}) payload`);
        const run = doc.overlay?.(o, o + 1)?.[0];
        if (run) {
          const t = doc.tracks?.[run.track];
          lines.push(`sample ${fmtInt(run.sample + 1)} of ${t ? t.label : `track ${run.track}`}`);
          const u = run.units?.find((x) => o >= x.offset && o < x.offset + x.size);
          if (u) lines.push(`${u.title}: ${truncate(u.summary ?? '', 80)}`);
        }
      }
    }
    return lines.join('\n');
  }

  onKey(e) {
    if (!this.doc) return;
    const cur = this.app.store.get().sel?.offset ?? this.top;
    let next = null;
    switch (e.key) {
      case 'ArrowRight': next = cur + 1; break;
      case 'ArrowLeft': next = cur - 1; break;
      case 'ArrowDown': next = cur + BPR; break;
      case 'ArrowUp': next = cur - BPR; break;
      case 'PageDown': this.page(1); e.preventDefault(); return;
      case 'PageUp': this.page(-1); e.preventDefault(); return;
      case 'Home': next = 0; break;
      case 'End': next = this.doc.size - 1; break;
      default: return;
    }
    e.preventDefault();
    e.stopPropagation();
    next = clamp(next, 0, this.doc.size - 1);
    if (next < this.top) this.scrollTo(next - (next % BPR));
    else if (next >= this.top + this.span) this.scrollTo(next - (next % BPR) - this.span + BPR);
    this.app.selectByte(next, { from: 'hex' });
  }

  // ------------------------------------------------------------ search

  /** Parse "mdat", "00 00 01" or "0x6D646174" into bytes. */
  static pattern(input) {
    const t = input.trim();
    if (!t) return null;
    const hexOnly = t.replace(/^0x/i, '').replace(/\s+/g, '');
    const looksHex = /^0x/i.test(t) || (/^([0-9a-f]{2})(\s+[0-9a-f]{2})+$/i.test(t));
    if (looksHex && /^[0-9a-f]+$/i.test(hexOnly) && hexOnly.length % 2 === 0) {
      return Uint8Array.from(hexOnly.match(/../g), (x) => parseInt(x, 16));
    }
    const text = t.replace(/^"(.*)"$/, '$1');
    return new TextEncoder().encode(text);
  }

  async find(input) {
    const doc = this.doc;
    const pat = HexView.pattern(input);
    if (!doc || !pat || !pat.length) return;
    const my = (this.findSeq = (this.findSeq ?? 0) + 1);
    const size = doc.size;
    const from = (this.app.store.get().sel?.offset ?? this.top - 1) + 1;
    const CHUNK = 1024 * 1024;
    const status = (t) => {
      if (my === this.findSeq) this.findStatus.textContent = t;
    };
    let scanned = 0;
    for (const [a, b] of [[from, size], [0, Math.min(from + pat.length - 1, size)]]) {
      for (let pos = a; pos < b; pos += CHUNK) {
        if (my !== this.findSeq) return;
        const len = Math.min(CHUNK + pat.length - 1, b - pos);
        const bytes = await doc.source.read(pos, len);
        const hit = indexOfBytes(bytes, pat);
        if (hit >= 0) {
          const at = pos + hit;
          status(`at ${hex(at, 1)}${a === 0 && from > 0 ? ' (wrapped)' : ''}`);
          await this.app.selectByte(at, { from: 'search' });
          this.app.selectRange([at, at + pat.length]);
          return;
        }
        scanned += len;
        if (scanned > 8 * CHUNK) status(`searching… ${Math.round((scanned / size) * 100)}%`);
      }
    }
    status('not found');
  }

  renderFoot() {
    const s = this.app.store.get();
    const doc = s.doc;
    clear(this.foot);
    if (!doc) return;
    const item = (cls, label, tip) => h('span', { class: `legend ${cls}`, 'data-tip': tip }, h('i'), label);
    this.foot.append(
      h('span', { class: 'legend', 'data-tip': 'The size field of each box or element header' }, h('i', { style: { background: 'var(--c-media)' } }), 'size'),
      h('span', { class: 'legend', 'data-tip': 'The type / ID field of each header' }, h('i', { style: { background: 'var(--c-index)' } }), 'type'),
      item('k-header', 'parsed fields', 'Bytes decoded into fields; neighbouring fields alternate in brightness'),
      h('span', { class: 'legend', 'data-tip': 'Bytes no parser describes (e.g. media data)' }, h('i', { style: { background: 'var(--text-3)' } }), 'payload'),
    );
    const tracks = (doc.tracks ?? []).filter((t) => t.samples && t.samples.count);
    for (const t of tracks.slice(0, 6)) {
      this.foot.append(h('span', { class: 'legend', 'data-tip': `Samples of ${t.label} inside the media data. Underlined bytes are NAL/OBU length prefixes.` }, h('i', { style: { background: `var(--t${t.index % TRACK_COLORS})` } }), t.label));
    }
    if (!s.samplesReady && doc.loadSamples) this.foot.append(h('span', null, 'indexing frames…'));
  }
}

function indexOfBytes(hay, needle) {
  const first = needle[0];
  const last = hay.length - needle.length;
  for (let i = hay.indexOf(first); i >= 0 && i <= last; i = hay.indexOf(first, i + 1)) {
    let k = 1;
    while (k < needle.length && hay[i + k] === needle[k]) k++;
    if (k === needle.length) return i;
  }
  return -1;
}

function truncate(s, n) {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/** [start, end, class] runs for the decoded parts of codec units (cached on the units array). */
function unitRuns(units) {
  if (units._runs) return units._runs;
  const runs = [];
  units.forEach((u, i) => {
    const alt = i & 1 ? ' u1' : '';
    for (const L of leafFields({ fields: u.fields, _leaves: null })) {
      const f = L.f;
      if (f.role === 'payload') continue;
      runs.push([f.offset, f.offset + f.size, f.role === 'header' ? ` ul${alt}` : ` uf${alt}`]);
    }
  });
  units._runs = runs;
  return runs;
}

export { humanSize };
