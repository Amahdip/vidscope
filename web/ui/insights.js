// FILE INSIGHTS tab: what the format parser concluded about the file.

import { h, clear, copyText, icon } from './dom.js';
import { hex } from '../core/util.js';
import { frameInsights } from '../core/frames.js';

const ICONS = { good: '✓', info: 'i', warn: '!', bad: '✕' };
const ORDER = ['Overview', 'Encoding', 'Layout', 'Tracks', 'Timing', 'Metadata', 'Integrity'];

export class InsightsView {
  constructor(el, app) {
    this.el = el;
    this.app = app;
    this.doc = null;
    this.items = null;
    this.version = -1;
    app.store.subscribe((s, ch) => {
      if (ch.has('doc') || ch.has('samplesReady')) {
        this.items = null;
        if (s.rightTab === 'insights') this.render();
      }
    });
  }

  async render() {
    const s = this.app.store.get();
    const doc = s.doc;
    if (!doc) {
      clear(this.el);
      return;
    }
    if (this.items && this.doc === doc) {
      this.paint();
      return;
    }
    this.doc = doc;
    clear(this.el);
    this.el.append(h('div', { class: 'empty-state' }, 'Analysing the file…'));
    try {
      // The format's own findings, plus GOP and frame-type findings shared by every format.
      const [items, frames] = await Promise.all([
        doc.insights(),
        frameInsights(doc).catch((e) => {
          console.error(e);
          return [];
        }),
      ]);
      if (this.doc !== doc) return;
      // A format may already report the same finding in its own words.
      const titles = new Set(items.map((i) => i.title));
      this.items = [...items, ...frames.filter((i) => !titles.has(i.title))];
    } catch (e) {
      console.error(e);
      this.items = [{ level: 'bad', group: 'Integrity', title: 'Could not analyse the file', text: e.message }];
    }
    this.paint();
  }

  paint() {
    clear(this.el);
    const wrap = h('div', { class: 'ins' });
    const items = this.items ?? [];
    const counts = { bad: 0, warn: 0 };
    for (const i of items) if (i.level in counts) counts[i.level]++;
    wrap.append(h('div', { class: 'chips' },
      h('span', { class: 'chip' }, `${items.length} findings`),
      counts.bad ? h('span', { class: 'chip', style: { color: 'var(--bad)' } }, `${counts.bad} problems`) : null,
      counts.warn ? h('span', { class: 'chip', style: { color: 'var(--warn)' } }, `${counts.warn} warnings`) : null,
      !counts.bad && !counts.warn ? h('span', { class: 'chip ok' }, 'no problems found') : null));
    const groups = new Map();
    for (const i of items) {
      const g = i.group ?? 'Other';
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(i);
    }
    const names = [...groups.keys()].sort((a, b) => (ORDER.indexOf(a) + 1 || 99) - (ORDER.indexOf(b) + 1 || 99));
    for (const g of names) {
      wrap.append(h('h4', null, g));
      for (const i of groups.get(g)) wrap.append(this.card(i));
    }
    if (this.doc.loadSamples && !this.app.store.get().samplesReady) {
      wrap.append(h('p', { class: 'prose' }, 'Frames are still being indexed; findings that need them will appear when that finishes.'));
    }
    this.el.append(wrap);
  }

  card(i) {
    const c = h('div', { class: `icard ${i.level}` },
      h('div', { class: 'it' }, h('span', { class: 'ic' }, ICONS[i.level] ?? '·'), h('span', null, i.title)));
    if (i.text) c.append(h('div', { class: 'ix' }, i.text));
    if (i.facts?.length) c.append(h('dl', { class: 'kv' }, i.facts.flatMap(([k, v]) => [h('dt', null, k), h('dd', null, String(v))])));
    if (i.cmd) {
      c.append(h('pre', { class: 'code' }, i.cmd));
    }
    const acts = [];
    if (i.node) acts.push(h('button', { class: 'btn', onclick: () => this.app.select(i.node, { from: 'insights' }) }, `show ${i.node.type}`));
    if (i.offset !== undefined) acts.push(h('button', { class: 'btn', onclick: () => this.app.selectByte(i.offset, { from: 'insights' }) }, `go to ${hex(i.offset, 1)}`));
    if (i.cmd) acts.push(h('button', { class: 'btn copy', onclick: () => copyText(i.cmd) }, icon('copy'), ' copy command'));
    if (acts.length) c.append(h('div', { class: 'acts' }, acts));
    return c;
  }
}
