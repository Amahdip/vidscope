// FILE INSIGHTS tab: what the format parser concluded about the file, plus the encoding
// findings every container shares (core/encoding.js).

import { h, clear, copyText, icon } from './dom.js';
import { hex } from '../core/util.js';
import { frameInsights } from '../core/frames.js';
import { encodingInsights } from '../core/encoding.js';

const ICONS = { good: '✓', info: 'i', warn: '!', bad: '✕' };
const ORDER = ['Overview', 'Encoding', 'Layout', 'Tracks', 'Timing', 'Metadata', 'Integrity'];

export class InsightsView {
  constructor(el, app) {
    this.el = el;
    this.app = app;
    this.doc = null;
    this.items = null;
    this.version = -1;
    this.seq = 0;
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
    const my = ++this.seq;
    this.doc = doc;
    clear(this.el);
    this.el.append(h('div', { class: 'empty-state' }, 'Analysing the file…'));
    try {
      // The format's own findings, plus the GOP, frame-type and encoding findings shared by every format.
      const quiet = (p) => p.catch((e) => {
        console.error(e);
        return [];
      });
      const [items, frames, shared] = await Promise.all([doc.insights(), quiet(frameInsights(doc)), quiet(encodingInsights(doc))]);
      if (this.doc !== doc || my !== this.seq) return;
      // A format may already report the same finding in its own words.
      const titles = new Set(items.map((i) => i.title));
      this.items = [...items, ...frames.filter((i) => !titles.has(i.title)), ...shared];
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

  /**
   * One finding. Besides title/text/facts/cmd/node/offset, optional fields: `tip` (hover text of
   * the title), `beginner` (a fuller explanation shown in Beginner mode), `list` (short notes),
   * facts as [k, v, tip], `rows` (see row()), `groupTips` and `closed` (row groups), `cmdParts`
   * ([[text, tip]] spelling out `cmd` with an explanation per part) and `offsetLabel`.
   */
  card(i) {
    const c = h('div', { class: `icard ${i.level}` },
      h('div', { class: 'it' }, h('span', { class: 'ic' }, ICONS[i.level] ?? '·'), h('span', { 'data-tip': i.tip }, i.title)));
    if (i.text) c.append(h('div', { class: 'ix' }, i.text));
    if (i.beginner) c.append(h('div', { class: 'ix beginner-only' }, i.beginner));
    if (i.list?.length) c.append(h('ul', { class: 'ilist' }, i.list.map((x) => h('li', null, x))));
    if (i.facts?.length) c.append(h('dl', { class: 'kv' }, i.facts.flatMap(([k, v, tip]) => [h('dt', { 'data-tip': tip }, k), h('dd', { 'data-tip': tip }, String(v))])));
    if (i.rows?.length) c.append(this.rows(i));
    if (i.cmd) {
      c.append(h('pre', { class: 'code' }, i.cmdParts ? i.cmdParts.map(([t, tip]) => (tip ? h('span', { class: 'cp', 'data-tip': tip }, t) : t)) : i.cmd));
    }
    const acts = [];
    if (i.node) acts.push(h('button', { class: 'btn', onclick: () => this.app.select(i.node, { from: 'insights' }) }, `show ${i.node.type}`));
    if (i.offset !== undefined) acts.push(h('button', { class: 'btn', 'data-tip': i.offsetLabel ? `Select the bytes at ${hex(i.offset, 1)} in the hex view` : null, onclick: () => this.app.selectByte(i.offset, { from: 'insights' }) }, i.offsetLabel ?? `go to ${hex(i.offset, 1)}`));
    if (i.cmd) acts.push(h('button', { class: 'btn copy', onclick: () => copyText(i.cmd) }, icon('copy'), ' copy command'));
    if (acts.length) c.append(h('div', { class: 'acts' }, acts));
    return c;
  }

  /** Rows grouped under collapsible headings; rows marked `advanced` are hidden in Beginner mode. */
  rows(i) {
    const wrap = h('div', { class: 'irows' });
    const groups = new Map();
    for (const r of i.rows) {
      const g = r.group ?? '';
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(r);
    }
    for (const [g, rows] of groups) {
      const list = rows.map((r) => this.row(r));
      if (!g) {
        wrap.append(...list);
        continue;
      }
      const essential = rows.filter((r) => !r.advanced).length;
      wrap.append(h('details', { class: `rgroup${essential ? '' : ' advanced'}`, open: !i.closed?.includes(g) },
        h('summary', null, h('span', { 'data-tip': i.groupTips?.[g] }, g),
          h('span', { class: 'rc advanced' }, String(rows.length)), h('span', { class: 'rc beginner-only' }, String(essential))),
        list));
    }
    return wrap;
  }

  /**
   * A row: { k, v, limit?, text?, note?, status?: good|warn|bad|info, ktip?, vtip?, ltip?,
   * more?: [[label, text, code?]], advanced? }. Rows with `more` expand on click; `note` is a
   * plain-language line shown in Beginner mode; a value with a `limit` gets a line of its own.
   */
  row(r) {
    const value = h('span', { class: 'rv', 'data-tip': r.vtip }, r.v);
    const head = [
      r.status ? h('span', { class: `rs ${r.status}` }, ICONS[r.status]) : null,
      h('span', { class: 'rk', 'data-tip': r.ktip }, r.k),
      r.limit ? h('span', { class: 'rvl' }, value, h('span', { class: 'rl', 'data-tip': r.ltip }, r.limit)) : value,
      r.text ? h('span', { class: 'rt' }, r.text) : null,
      r.note ? h('span', { class: `rn beginner-only${r.status ? ' ind' : ''}` }, r.note) : null,
    ];
    const cls = `irow${r.advanced ? ' advanced' : ''}`;
    if (!r.more?.length) return h('div', { class: cls }, h('div', { class: 'rh' }, head));
    return h('details', { class: cls },
      h('summary', { class: 'rh' }, head),
      h('div', { class: 'rb' }, r.more.map(([label, text, code]) => h('p', null, label ? h('b', null, `${label}: `) : null, code ? h('code', null, text) : text))));
  }
}
