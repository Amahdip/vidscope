// TRACKS tab: every track with its codec details, a frame-size chart and a frame list.

import { h, clear } from './dom.js';
import { fmtInt, fmtDuration, fmtBitrate, fmtNum, hex, humanSize } from '../core/util.js';
import { showTip, hideTip } from './tooltip.js';
import { frameTypes, AUTO_SCAN_BYTES } from '../core/frames.js';
import { frameLabel } from '../codecs/frametype.js';
import { paint, chipClass } from './frames.js';

const ROW = 22;
const CHART_H = 112;

export class TracksView {
  constructor(el, app) {
    this.el = el;
    this.app = app;
    this.open = new Set();
    this.charts = [];
    this.unsubs = [];
    app.store.subscribe((s, ch) => {
      if (ch.has('doc')) this.open = new Set(s.doc?.tracks?.length === 1 ? [0] : []);
      if ((ch.has('doc') || ch.has('samplesReady') || ch.has('theme')) && s.leftTab === 'tracks') this.render();
      else if (ch.has('sel') && s.leftTab === 'tracks') this.charts.forEach((c) => c.draw());
    });
    new ResizeObserver(() => this.charts.forEach((c) => c.draw())).observe(el);
  }

  render() {
    const s = this.app.store.get();
    clear(this.el);
    this.charts = [];
    this.unsubs.forEach((u) => u());
    this.unsubs = [];
    const doc = s.doc;
    if (!doc) return;
    const wrap = h('div', { class: 'trk' });
    if (!doc.tracks.length) {
      wrap.append(h('div', { class: 'empty-state' }, 'This file has no tracks (for example a HEIF/AVIF still image, or a segment without an index).'));
    }
    doc.tracks.forEach((t, i) => wrap.append(this.card(t, i, s)));
    this.el.append(wrap);
  }

  card(t, i, s) {
    const props = Object.fromEntries(t.props ?? []);
    const summary = [props['coded size'] ?? props['display size'], props['frame rate'], props['sample rate'], props.channels, t.duration ? fmtDuration(t.duration) : null, t.bitrate ? fmtBitrate(t.bitrate) : null]
      .filter(Boolean).join(' · ');
    const open = this.open.has(i);
    const card = h('div', { class: `tcard k-${kindCat(t.kind)}` });
    card.append(h('div', {
      class: 'th',
      role: 'button',
      tabindex: '0',
      'aria-expanded': String(open),
      onclick: () => this.toggle(i, t),
      onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.toggle(i, t); } },
    },
    h('div', { class: 'tt' }, h('span', { class: 'kind' }, t.label), h('span', null, t.codecName), t.codecString ? h('span', { class: 'cs' }, t.codecString) : null),
    summary ? h('div', { class: 'ts' }, summary) : null));
    if (open) {
      const body = h('div', { class: 'tb2' });
      body.append(h('dl', { class: 'kv' }, (t.props ?? []).flatMap(([k, v]) => [h('dt', null, k), h('dd', null, v)])));
      if (t.samples?.count) {
        const ft = t.kind === 'video' ? frameTypes(s.doc, t) : null;
        const chart = new FrameChart(t, this.app, ft?.supported ? ft : null);
        this.charts.push(chart);
        body.append(chart.el);
        const list = this.sampleList(t, s, ft?.supported ? ft : null);
        body.append(list);
        if (ft?.ctx && !ft.complete) {
          // Colour the chart and fill the type column as frame headers are read.
          let queued = false;
          this.unsubs.push(ft.onChange(() => {
            if (queued) return;
            queued = true;
            requestAnimationFrame(() => {
              queued = false;
              chart.draw();
              list.repaint?.();
            });
          }));
          if (ft.scanBytes <= AUTO_SCAN_BYTES) ft.ensure();
        }
      } else if (this.app.store.get().doc.loadSamples && !s.samplesReady) {
        body.append(h('p', { class: 'prose' }, 'Indexing frames…'));
      } else {
        body.append(h('p', { class: 'prose' }, 'No samples are indexed for this track.'));
      }
      body.append(h('div', { class: 'chips' }, h('button', { class: 'chip', onclick: () => this.app.select(t.node, { from: 'tracks' }) }, `show ${t.node.type} in the structure`)));
      card.append(body);
      requestAnimationFrame(() => this.charts.forEach((c) => c.draw()));
    }
    return card;
  }

  toggle(i, t) {
    if (this.open.has(i)) this.open.delete(i);
    else this.open.add(i);
    this.render();
    if (this.open.has(i)) this.app.select(t.node, { from: 'tracks', scroll: false });
  }

  sampleList(t, s, ft) {
    const sm = t.samples;
    const ts = t.timescale || 1;
    const hasPts = !!sm.cto;
    const cols = ['#', 'offset', 'size', hasPts ? 'decode' : 'time', hasPts ? 'display' : null, ft ? 'type' : 'key'].filter(Boolean);
    const template = `52px 92px 72px 84px ${hasPts ? '84px ' : ''}${ft ? '44px' : '34px'}`;
    const selIdx = s.sel?.detail?.track === t ? s.sel.detail.sample : -1;
    const wrap = h('div', { class: 'tbl slist' });
    wrap.append(h('div', { class: 'thead', style: { gridTemplateColumns: template } }, cols.map((c) => h('div', c === 'type' ? { 'data-tip': 'Frame type: I (complete picture), P (predicted from earlier frames), B (also uses a later frame; lower-case b = no other frame refers to it). A line above the letter marks a key frame.' } : null, c))));
    const body = h('div', { class: 'tbody' });
    body.style.height = `${Math.min(sm.count, 12) * ROW + 2}px`;
    const spacer = h('div', { style: { position: 'relative', height: `${sm.count * ROW}px` } });
    body.append(spacer);
    const paint = () => {
      const first = Math.max(0, Math.floor(body.scrollTop / ROW) - 4);
      const last = Math.min(sm.count, first + Math.ceil(body.clientHeight / ROW) + 10);
      spacer.replaceChildren();
      for (let i = first; i < last; i++) {
        const key = !sm.key || sm.key[i];
        const cells = [
          h('div', { class: 'ix' }, String(i + 1)),
          h('div', { 'data-num': sm.offsets[i] }, hex(sm.offsets[i], 1)),
          h('div', null, fmtInt(sm.sizes[i])),
          h('div', null, fmtDuration(sm.dts[i] / ts)),
        ];
        if (hasPts) cells.push(h('div', null, fmtDuration((sm.dts[i] + sm.cto[i]) / ts)));
        if (ft) {
          const known = ft.have[i] && ft.type[i];
          cells.push(h('div', { 'data-tip': known ? `${frameLabel(ft.family, ft.type[i], ft.flags[i])}${key ? '\nkey frame: decoding can start here' : ''}` : key ? 'key frame' : 'type not read yet' },
            known ? h('span', { class: `fl ${chipClass(ft.type[i], ft.flags[i])}${key ? ' key' : ''}` }, ft.letter(i)) : key ? '●' : '·'));
        } else cells.push(h('div', { 'aria-label': key ? 'key frame' : '' }, key ? '●' : ''));
        spacer.append(h('div', { class: `trw${i === selIdx ? ' sel' : ''}`, style: { top: `${i * ROW}px`, gridTemplateColumns: template }, onclick: () => this.app.selectSample(t, i) }, cells));
      }
    };
    body.addEventListener('scroll', paint);
    wrap.repaint = paint;
    wrap.append(body);
    wrap.append(h('div', { class: 'tfoot' }, `${fmtInt(sm.count)} samples in decoding order · ${ft ? 'I/P/B frame type' : '● key frame'} · click one to see its bytes`));
    requestAnimationFrame(() => {
      if (selIdx >= 0) body.scrollTop = Math.max(0, selIdx * ROW - ROW * 3);
      paint();
    });
    return wrap;
  }
}

function kindCat(kind) {
  return { video: 'media', audio: 'type', subtitle: 'table', timecode: 'header', data: 'meta' }[kind] ?? 'unknown';
}

/** Frame sizes in decoding order: one column per frame, or per pixel bin when there are many. */
class FrameChart {
  constructor(track, app, ft = null) {
    this.t = track;
    this.app = app;
    this.ft = ft;
    this.focus = -1;
    this.canvas = h('canvas', {
      tabindex: '0',
      role: 'img',
      'aria-label': `Size of each sample of ${track.label}, in decoding order; key frames highlighted. The table below lists every sample.`,
    });
    const s = track.samples;
    const ts = track.timescale || 1;
    const legend = ft
      ? h('div', { class: 'chips' },
        h('span', { class: 'legend', 'data-tip': 'I-frame: a complete picture' }, h('i', { style: { background: 'var(--ft-i)' } }), 'I'),
        h('span', { class: 'legend', 'data-tip': 'P-frame: predicted from earlier frames' }, h('i', { style: { background: 'var(--ft-p)' } }), 'P'),
        h('span', { class: 'legend', 'data-tip': 'B-frame: also uses a later frame (paler: no other frame refers to it)' }, h('i', { style: { background: 'var(--ft-b)' } }), 'B'),
        h('button', { class: 'chip', 'data-tip': 'Open the Frames view: GOPs, decoding and display order, and explanations', onclick: () => app.store.set({ centerTab: 'frames' }) }, 'Frames view'))
      : h('div', { class: 'chips' },
        h('span', { class: 'legend' }, h('i', { style: { background: 'var(--viz-frame)' } }), 'frames'),
        track.kind === 'video' ? h('span', { class: 'legend' }, h('i', { style: { background: 'var(--viz-key)' } }), 'key frames') : null);
    this.el = h('div', { class: 'chart' },
      h('div', { class: 'cap' }, h('span', null, `Sample size, ${fmtInt(s.count)} samples`)),
      legend,
      this.canvas,
      h('div', { class: 'cap' }, h('span', null, `#1 · ${fmtDuration(s.dts[0] / ts)}`), h('span', null, 'decoding order →'), h('span', null, `#${fmtInt(s.count)} · ${fmtDuration(s.dts[s.count - 1] / ts)}`)));
    this.canvas.addEventListener('pointermove', (e) => this.onMove(e));
    this.canvas.addEventListener('pointerleave', () => {
      this.hover = -1;
      hideTip();
      this.draw();
    });
    this.canvas.addEventListener('click', (e) => {
      const b = this.binAt(e);
      if (b) this.app.selectSample(this.t, b.best);
    });
    this.canvas.addEventListener('keydown', (e) => this.onKey(e));
    this.canvas.addEventListener('blur', () => hideTip());
    this.hover = -1;
  }

  bins(width) {
    const s = this.t.samples;
    const n = s.count;
    const perSample = n <= width / 3;
    const nb = perSample ? n : Math.max(1, Math.floor(width / 2));
    const out = [];
    let max = 1;
    for (let b = 0; b < nb; b++) {
      const a = perSample ? b : Math.floor((b * n) / nb);
      const z = perSample ? b + 1 : Math.max(a + 1, Math.floor(((b + 1) * n) / nb));
      let m = 0;
      let best = a;
      let key = false;
      for (let i = a; i < z; i++) {
        if (s.sizes[i] > m) {
          m = s.sizes[i];
          best = i;
        }
        if (s.key && s.key[i]) key = true;
      }
      if (!s.key) key = false;
      out.push({ a, z, max: m, best, key });
      if (m > max) max = m;
    }
    return { out, max, perSample };
  }

  draw() {
    const cv = this.canvas;
    const w = cv.clientWidth;
    if (!w) return;
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(CHART_H * dpr);
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const css = getComputedStyle(document.documentElement);
    const col = (n) => css.getPropertyValue(n).trim();
    const top = 16;
    const base = CHART_H - 1;
    const { out, max, perSample } = this.bins(w);
    this.layout = { out, perSample, w };
    const colW = w / out.length;
    const barW = Math.max(1, Math.min(24, colW - (colW >= 4 ? 2 : 0)));
    const ft = this.ft;
    const fcol = ft ? { '--ft-i': col('--ft-i'), '--ft-p': col('--ft-p'), '--ft-b': col('--ft-b'), '--ft-o': col('--ft-o') } : null;
    // recessive chrome: a hairline at the maximum, the baseline, and the max label in muted ink
    g.fillStyle = col('--viz-grid');
    g.fillRect(0, top, w, 1);
    g.fillStyle = col('--viz-base');
    g.fillRect(0, base, w, 1);
    g.fillStyle = col('--text-3');
    g.font = `11px ${col('--mono') || 'monospace'}`;
    g.textBaseline = 'bottom';
    g.fillText(`max ${humanSize(max)}`, 2, top - 3);
    const sel = this.app.store.get().sel;
    const selIdx = sel?.detail?.track === this.t ? sel.detail.sample : -1;
    out.forEach((b, i) => {
      const x = i * colW + (colW - barW) / 2;
      const hgt = Math.max(1, ((base - top) * b.max) / max);
      g.globalAlpha = this.hover >= 0 && this.hover !== i ? 0.55 : 1;
      g.fillStyle = b.key ? col('--viz-key') : col('--viz-frame');
      if (ft && ft.have[b.best] && ft.type[b.best]) {
        const [c, alpha] = paint(ft.type[b.best], ft.flags[b.best]);
        g.fillStyle = fcol[c];
        g.globalAlpha *= alpha;
      }
      if (barW >= 8) {
        roundTop(g, x, base - hgt, barW, hgt, 4);
      } else {
        g.fillRect(x, base - hgt, barW, hgt);
      }
      if (selIdx >= b.a && selIdx < b.z) {
        g.globalAlpha = 1;
        g.fillStyle = col('--text');
        g.fillRect(x + barW / 2 - 1, top - 1, 2, 6);
      }
    });
    g.globalAlpha = 1;
  }

  binAt(e) {
    if (!this.layout) return null;
    const r = this.canvas.getBoundingClientRect();
    const i = Math.floor(((e.clientX - r.left) / r.width) * this.layout.out.length);
    return this.layout.out[i] ? { ...this.layout.out[i], i } : null;
  }

  tipFor(b) {
    const s = this.t.samples;
    const ts = this.t.timescale || 1;
    const i = b.best;
    const ft = this.ft;
    const type = ft && ft.have[i] && ft.type[i] ? ` · ${frameLabel(ft.family, ft.type[i], ft.flags[i])}` : '';
    const lines = [`${fmtInt(s.sizes[i])} bytes${type}`, `sample ${fmtInt(i + 1)}${!s.key || s.key[i] ? ' · key frame' : ''}`, `${fmtDuration(s.dts[i] / ts)} decode time`];
    if (b.z - b.a > 1) lines.push(`largest of samples ${fmtInt(b.a + 1)}–${fmtInt(b.z)}`);
    return lines.join('\n');
  }

  onMove(e) {
    const b = this.binAt(e);
    if (!b) return;
    if (b.i !== this.hover) {
      this.hover = b.i;
      this.draw();
    }
    showTip(e.clientX, e.clientY, this.tipFor(b));
  }

  onKey(e) {
    if (!this.layout) return;
    const n = this.layout.out.length;
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      e.stopPropagation();
      this.focus = Math.max(0, Math.min(n - 1, (this.focus < 0 ? 0 : this.focus) + (e.key === 'ArrowRight' ? 1 : -1)));
      this.hover = this.focus;
      this.draw();
      const r = this.canvas.getBoundingClientRect();
      const b = { ...this.layout.out[this.focus], i: this.focus };
      showTip(r.left + ((this.focus + 0.5) / n) * r.width, r.top + 10, this.tipFor(b));
    } else if (e.key === 'Enter' && this.focus >= 0) {
      e.preventDefault();
      this.app.selectSample(this.t, this.layout.out[this.focus].best);
    }
  }
}

function roundTop(g, x, y, w, hgt, r) {
  const rr = Math.min(r, w / 2, hgt);
  g.beginPath();
  g.moveTo(x, y + hgt);
  g.lineTo(x, y + rr);
  g.quadraticCurveTo(x, y, x + rr, y);
  g.lineTo(x + w - rr, y);
  g.quadraticCurveTo(x + w, y, x + w, y + rr);
  g.lineTo(x + w, y + hgt);
  g.closePath();
  g.fill();
}

export { fmtNum };
