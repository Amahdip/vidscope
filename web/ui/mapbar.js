// Map bar: breadcrumb of the current level, the level's children drawn to scale,
// and one equal-width card per child so tiny boxes are visible and clickable too.

import { h, clear } from './dom.js';
import { fmtInt, hex, humanSize, pct, hexDigits } from '../core/util.js';

const MAX_CARDS = 400;

export class Mapbar {
  constructor(el, app) {
    this.el = el;
    this.app = app;
    this.build();
    app.store.subscribe((s, ch) => {
      if (['doc', 'level', 'sel', 'loading', 'docVersion'].some((k) => ch.has(k))) this.render();
    });
    new ResizeObserver(() => this.renderScale()).observe(this.bar);
    this.render();
  }

  build() {
    this.crumbs = h('div', { class: 'crumbs' });
    this.progress = h('div', { class: 'progress', hidden: true }, h('i'));
    this.mini = h('div', { class: 'mini', title: 'The whole file; the outline marks the part shown below', onclick: (e) => this.miniClick(e) });
    this.bar = h('div', { class: 'scalebar' });
    this.axis = h('div', { class: 'axis' });
    this.parts = h('div', { class: 'parts' });
    this.el.append(
      this.crumbs,
      this.progress,
      h('div', { class: 'maprow' }, h('div', { class: 'maplabel' }, 'To', h('br'), 'scale'), h('div', null, this.mini, this.bar, this.axis)),
      h('div', { class: 'maprow' }, h('div', { class: 'maplabel', style: { paddingTop: '6px' } }, 'Every', h('br'), 'part'), this.parts),
    );
  }

  render() {
    const s = this.app.store.get();
    this.renderProgress(s);
    if (!s.doc) return;
    this.renderCrumbs(s);
    this.renderMini(s);
    this.renderScale();
    this.renderCards(s);
  }

  renderProgress(s) {
    const l = s.loading;
    this.progress.hidden = !l;
    if (l) this.progress.firstChild.style.width = `${Math.round((l.total ? l.done / l.total : 0) * 100)}%`;
  }

  unitWord(n, top) {
    const [one, many] = this.app.store.get().doc.unit;
    return `${fmtInt(n)} ${top ? 'top-level ' : 'child '}${n === 1 ? one : many}`;
  }

  renderCrumbs(s) {
    const { doc, level } = s;
    clear(this.crumbs);
    const chain = [doc.root, ...level.path()];
    chain.forEach((n, i) => {
      if (i) this.crumbs.append(h('span', { class: 'chev' }, '›'));
      this.crumbs.append(h('button', {
        class: `crumb${n === level ? ' current' : ''}`,
        onclick: () => this.app.store.set({ level: n }),
        title: n.parent ? `${n.name} at ${hex(n.offset)}` : 'The whole file',
      }, n.parent ? n.type : doc.name));
    });
    const kids = level.children?.length ?? 0;
    let samples = null;
    if (!kids && level.parent && doc.sampleIndex) {
      let n = 0;
      const tracks = new Set();
      const idx = doc.sampleIndex;
      for (let k = idx.firstEndingAfter(level.bodyOffset); k < idx.count && idx.starts[k] < level.end; k++) {
        n++;
        tracks.add(idx.track[k]);
      }
      if (n) samples = `${fmtInt(n)} samples of ${tracks.size} track${tracks.size === 1 ? '' : 's'}`;
    }
    const what = level.lazy ? 'contents not loaded yet'
      : samples ?? (!kids && level === doc.root ? 'no structure recognised' : this.unitWord(kids, level === doc.root));
    const info = `${fmtInt(level.size)} bytes, ${what}`;
    this.crumbs.append(h('span', { class: 'info' }, info));
    if (s.loading?.phase) this.crumbs.append(h('span', { class: 'info' }, `· ${s.loading.phase} ${Math.round((s.loading.done / s.loading.total) * 100)}%`));
  }

  /** Pixel runs for children of `node` across `width` px, merging runs thinner than `min` px. */
  runs(node, width, min) {
    const out = [];
    const kids = node.children ?? [];
    const scale = width / Math.max(1, node.size);
    let pos = node.offset;
    const pushGap = (a, b) => {
      if (b > a) out.push({ gap: true, start: a, end: b, x0: (a - node.offset) * scale, x1: (b - node.offset) * scale });
    };
    let group = null;
    const flush = () => {
      if (group) {
        out.push(group);
        group = null;
      }
    };
    for (const c of kids) {
      if (c.offset > pos) {
        flush();
        pushGap(pos, c.offset);
      }
      const x0 = (c.offset - node.offset) * scale;
      const x1 = (c.end - node.offset) * scale;
      if (x1 - x0 < min) {
        if (!group || x0 - group.x1 > 0.5) {
          flush();
          group = { nodes: [c], start: c.offset, end: c.end, x0, x1 };
        } else {
          group.nodes.push(c);
          group.end = c.end;
          group.x1 = x1;
        }
        if (group.x1 - group.x0 >= min) flush();
      } else {
        flush();
        out.push({ nodes: [c], start: c.offset, end: c.end, x0, x1 });
      }
      pos = Math.max(pos, c.end);
    }
    flush();
    pushGap(pos, node.end);
    return out;
  }

  renderMini(s) {
    const { doc, level } = s;
    clear(this.mini);
    const w = this.mini.clientWidth || 800;
    for (const run of this.runs(doc.root, w, 1)) {
      if (run.gap) continue;
      const cat = run.nodes.length === 1 ? run.nodes[0].category : dominant(run.nodes);
      this.mini.append(h('i', { class: `k-${cat}`, style: { left: `${run.x0}px`, width: `${Math.max(1, run.x1 - run.x0)}px` } }));
    }
    if (level !== doc.root) {
      const x0 = (level.offset / doc.size) * w;
      const x1 = (level.end / doc.size) * w;
      this.mini.append(h('div', { class: 'win', style: { left: `${x0 - 1}px`, width: `${Math.max(3, x1 - x0 + 2)}px` } }));
    }
  }

  miniClick(e) {
    const doc = this.app.store.get().doc;
    if (!doc) return;
    const r = this.mini.getBoundingClientRect();
    const off = Math.floor(((e.clientX - r.left) / r.width) * doc.size);
    const top = doc.root.children?.find((c) => off >= c.offset && off < c.end);
    if (top) this.app.select(top, { from: 'map' });
  }

  /** Samples of a payload drawn to scale, coloured by track: shows how tracks are interleaved. */
  renderSamples(doc, level, sel) {
    const w = this.bar.clientWidth || 800;
    const hgt = this.bar.clientHeight || 42;
    const a = level.bodyOffset;
    const span = Math.max(1, level.end - a);
    const runs = doc.overlay(a, level.end) ?? [];
    const cv = h('canvas', { style: { width: '100%', height: '100%', display: 'block', cursor: 'pointer' } });
    this.bar.append(cv);
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(hgt * dpr);
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const css = getComputedStyle(document.documentElement);
    // Per pixel column, the track that owns most of its bytes.
    const cols = Array.from({ length: Math.ceil(w) }, () => new Map());
    for (const r of runs) {
      let x0 = ((r.start - a) / span) * w;
      const x1 = ((r.end - a) / span) * w;
      while (x0 < x1) {
        const xi = Math.floor(x0);
        const next = Math.min(x1, xi + 1);
        const m = cols[Math.min(xi, cols.length - 1)];
        m.set(r.track, (m.get(r.track) ?? 0) + (next - x0));
        x0 = next;
      }
    }
    cols.forEach((m, x) => {
      let best = -1;
      let most = 0;
      for (const [t, v] of m) if (v > most) [best, most] = [t, v];
      if (best < 0) return;
      g.fillStyle = css.getPropertyValue(`--t${best % 6}`).trim();
      g.globalAlpha = 0.35 + 0.65 * Math.min(1, most);
      g.fillRect(x, 0, 1, hgt);
    });
    g.globalAlpha = 1;
    if (sel?.detail?.range) {
      const x = ((sel.detail.range[0] - a) / span) * w;
      g.fillStyle = css.getPropertyValue('--text').trim();
      g.fillRect(Math.max(0, x - 1), 0, 2, hgt);
    }
    const offsetAt = (e) => {
      const r = cv.getBoundingClientRect();
      return Math.min(level.end - 1, Math.floor(a + ((e.clientX - r.left) / r.width) * span));
    };
    cv.addEventListener('click', (e) => this.app.selectByte(offsetAt(e), { from: 'map' }));
    cv.addEventListener('mousemove', (e) => {
      const o = offsetAt(e);
      const run = doc.overlay(o, o + 1)?.[0];
      const t = run ? doc.tracks[run.track] : null;
      cv.dataset.tip = t ? `${t.label} · sample ${fmtInt(run.sample + 1)}\nat ${hex(o)} · click to inspect` : `${hex(o)}: not part of any sample`;
    });
    return runs;
  }

  renderScale() {
    const s = this.app.store.get();
    const { doc, level, sel } = s;
    if (!doc || !level) return;
    clear(this.bar);
    if (!level.children?.length && level.parent && doc.overlay) {
      this.renderSamples(doc, level, sel);
      clear(this.axis);
      const d = hexDigits(doc.size);
      this.axis.append(h('span', null, hex(level.bodyOffset, d)), h('span', null, `${level.pathString()}: samples to scale, coloured by track`), h('span', null, hex(level.end, d)));
      return;
    }
    const w = this.bar.clientWidth || 800;
    const selected = sel?.node;
    for (const run of this.runs(level, w, 3)) {
      const width = Math.max(1, run.x1 - run.x0);
      let seg;
      if (run.gap) {
        const isHeader = level !== doc.root && run.start === level.offset;
        seg = h('div', {
          class: 'segm gap',
          style: { left: `${run.x0}px`, width: `${width}px` },
          'data-tip': `${isHeader ? `${level.type} header and fields` : 'bytes outside any child'}\n${fmtInt(run.end - run.start)} bytes at ${hex(run.start)}`,
          onclick: () => (level.parent ? this.app.select(level, { from: 'map' }) : this.app.selectByte(run.start, { from: 'map' })),
        });
        if (width > 60) seg.append(h('span', null, isHeader ? 'header' : 'gap'));
      } else if (run.nodes.length === 1) {
        const n = run.nodes[0];
        const share = n.size / level.size;
        seg = h('div', {
          class: `segm k-${n.category}${selected && (selected === n || isInside(selected, n)) ? ' sel' : ''}`,
          style: { left: `${run.x0}px`, width: `${width}px` },
          'data-tip': `${n.type} — ${n.name}\n${humanSize(n.size)} · ${pct(n.size, level.size)} of ${level.parent ? level.type : 'the file'}\nat ${hex(n.offset)}${n.hasChildren() ? '\ndouble-click to zoom in' : ''}`,
          onclick: () => this.app.select(n, { from: 'map' }),
          ondblclick: () => this.app.zoom(n),
        });
        if (width > 40) {
          seg.append(h('span', null, n.type));
          if (width > 64) seg.append(h('small', null, `${(share * 100).toFixed(share < 0.001 ? 3 : 1)}%`));
        }
        if (n.hasChildren() && width > 18) seg.append(h('span', { class: 'zoom' }, '⌄'));
      } else {
        const bytes = run.end - run.start;
        const types = summarizeTypes(run.nodes);
        seg = h('div', {
          class: `segm k-${dominant(run.nodes)}`,
          style: { left: `${run.x0}px`, width: `${width}px` },
          'data-tip': `${fmtInt(run.nodes.length)} small parts: ${types}\n${humanSize(bytes)} at ${hex(run.start)}`,
          onclick: () => this.app.select(run.nodes[0], { from: 'map' }),
        });
        if (width > 60) seg.append(h('span', null, `×${fmtInt(run.nodes.length)}`));
      }
      this.bar.append(seg);
    }
    clear(this.axis);
    const d = hexDigits(doc.size);
    this.axis.append(
      h('span', null, hex(level.offset, d)),
      h('span', null, level === doc.root ? 'whole file' : `${level.pathString()} — ${humanSize(level.size)}`),
      h('span', null, hex(level.end, d)),
    );
  }

  renderCards(s) {
    const { doc, level, sel } = s;
    clear(this.parts);
    const kids = level.children ?? [];
    if (!kids.length && level.parent && doc.payloadInfo?.(level)) {
      // Zoomed into a payload: one card per track that has samples in it.
      const info = doc.payloadInfo(level);
      for (const [label, value] of info.rows) {
        const t = doc.tracks.find((x) => x.label === label);
        this.parts.append(h('button', {
          class: 'card',
          style: { background: t ? `var(--t${t.index % 6})` : 'var(--bg-3)', color: t ? 'var(--on-fill)' : 'var(--text-2)' },
          onclick: () => t && this.app.selectSample(t, t.samples.offsets.findIndex((o) => o >= level.bodyOffset)),
        }, h('div', { class: 't' }, label), h('div', { class: 'm' }, value)));
      }
      return;
    }
    if (!kids.length) {
      this.parts.append(h('div', { class: 'card more' }, level.lazy ? 'double-click the box in the tree to load its contents' : 'no child boxes: see the hex view'));
      return;
    }
    const selected = sel?.node;
    for (const n of kids.slice(0, MAX_CARDS)) {
      const on = selected && (selected === n || isInside(selected, n));
      this.parts.append(h('button', {
        class: `card k-${n.category}${on ? ' sel' : ''}`,
        onclick: () => this.app.select(n, { from: 'map' }),
        ondblclick: () => this.app.zoom(n),
        'data-tip': `${n.type} — ${n.name}${n.label ? ` · ${n.label}` : ''}\n${fmtInt(n.size)} bytes at ${hex(n.offset)}${n.hasChildren() ? '\ndouble-click to zoom in' : ''}`,
      }, h('div', { class: 't' }, n.type), h('div', { class: 'm' }, `${humanSize(n.size)} · ${pct(n.size, level.size)}`)));
    }
    if (kids.length > MAX_CARDS) {
      this.parts.append(h('div', { class: 'card more' }, `+${fmtInt(kids.length - MAX_CARDS)} more`));
    }
    const selCard = this.parts.querySelector('.card.sel');
    if (selCard && doc) selCard.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
}

function isInside(node, ancestor) {
  for (let p = node.parent; p; p = p.parent) if (p === ancestor) return true;
  return false;
}

function dominant(nodes) {
  const by = new Map();
  for (const n of nodes) by.set(n.category, (by.get(n.category) ?? 0) + n.size);
  let best = 'unknown';
  let max = -1;
  for (const [k, v] of by) if (v > max) [best, max] = [k, v];
  return best;
}

function summarizeTypes(nodes) {
  const counts = new Map();
  for (const n of nodes) counts.set(n.type, (counts.get(n.type) ?? 0) + 1);
  return [...counts].slice(0, 6).map(([t, c]) => (c > 1 ? `${t}×${c}` : t)).join(', ') + (counts.size > 6 ? '…' : '');
}
