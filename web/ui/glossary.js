// GLOSSARY tab: concepts plus every structure the format defines, searchable,
// with what is actually present in the open file marked.

import { h, clear } from './dom.js';
import { fmtInt } from '../core/util.js';
import { walk } from '../core/model.js';
import { conceptEntries } from '../core/glossary.js';

const FILTERS = [
  ['file', 'in this file'],
  ['all', 'all'],
  ['concept', 'concepts'],
  ['box', 'structures'],
  ['codec', 'codecs'],
  ['brand', 'brands'],
];
const LIMIT = 250;

export class GlossaryView {
  constructor(el, app) {
    this.el = el;
    this.app = app;
    this.filter = 'file';
    this.query = '';
    this.open = new Set();
    this.doc = null;
    this.input = h('input', {
      type: 'search',
      placeholder: 'Search terms, e.g. stsz, keyframe, hvc1',
      'aria-label': 'Search the glossary',
      oninput: () => {
        this.query = this.input.value.trim().toLowerCase();
        if (this.query && this.filter === 'file') this.filter = 'all';
        this.paint();
      },
    });
    this.filters = h('div', { class: 'gfilters' });
    this.list = h('div');
    el.append(h('div', { class: 'gl' }, this.input, this.filters, this.list));
    app.store.subscribe((s, ch) => {
      if (ch.has('doc')) this.doc = null;
      if ((ch.has('doc') || ch.has('docVersion')) && s.leftTab === 'glossary') this.render();
    });
  }

  prepare(doc) {
    this.doc = doc;
    const nodesByType = new Map();
    for (const n of walk(doc.root)) {
      if (!n.parent) continue;
      if (!nodesByType.has(n.type)) nodesByType.set(n.type, []);
      nodesByType.get(n.type).push(n);
    }
    this.nodesByType = nodesByType;
    const present = new Set(nodesByType.keys());
    for (const t of doc.tracks ?? []) {
      present.add(t.codec);
      present.add(t.fourcc);
      if (t.handler) present.add(t.handler);
    }
    for (const n of nodesByType.get('ftyp') ?? []) {
      present.add(n.data.major);
      for (const b of n.data.brands ?? []) present.add(b);
    }
    this.present = present;
    const format = doc.glossary?.() ?? [];
    this.entries = [...conceptEntries(), ...format];
  }

  render() {
    const doc = this.app.store.get().doc;
    if (!doc) {
      clear(this.list);
      return;
    }
    if (this.doc !== doc) this.prepare(doc);
    this.paint();
  }

  inFile(e) {
    if (e.cat === 'concept') return 0;
    if (e.cat === 'box' || e.cat === 'codec') return this.nodesByType.get(e.term)?.length ?? (this.present.has(e.term) ? 1 : 0);
    return this.present.has(e.term) ? 1 : 0;
  }

  paint() {
    if (!this.entries) return;
    clear(this.filters);
    for (const [id, label] of FILTERS) {
      this.filters.append(h('button', { class: 'btn', 'aria-pressed': String(this.filter === id), onclick: () => { this.filter = id; this.paint(); } }, label));
    }
    const q = this.query;
    let items = this.entries.filter((e) => {
      if (this.filter === 'file' && !this.inFile(e)) return false;
      if (this.filter !== 'all' && this.filter !== 'file' && e.cat !== this.filter) return false;
      if (!q) return true;
      return e.term.toLowerCase().includes(q) || e.name?.toLowerCase().includes(q) || e.desc?.toLowerCase().includes(q);
    });
    if (q) {
      const rank = (e) => (e.term.toLowerCase() === q ? 0 : e.term.toLowerCase().startsWith(q) ? 1 : e.name?.toLowerCase().includes(q) ? 2 : 3);
      items = items.sort((a, b) => rank(a) - rank(b) || (b.registryOnly ? 0 : 1) - (a.registryOnly ? 0 : 1));
    }
    clear(this.list);
    this.list.append(h('div', { class: 'gcount' }, `${fmtInt(items.length)} term${items.length === 1 ? '' : 's'}${items.length > LIMIT ? `; showing the first ${LIMIT}, search to narrow down` : ''}`));
    for (const e of items.slice(0, LIMIT)) this.list.append(this.item(e));
    if (!items.length) this.list.append(h('div', { class: 'empty-state' }, 'Nothing matches.'));
  }

  item(e) {
    const key = `${e.cat}:${e.term}`;
    const n = this.inFile(e);
    const open = this.open.has(key);
    const div = h('div', { class: `gitem${e.kcat ? ` k-${e.kcat}` : ''}` },
      h('div', { class: 'gh', onclick: () => { if (open) this.open.delete(key); else this.open.add(key); this.paint(); } },
        h('span', { class: 'gt' }, e.term),
        h('span', { class: 'gn' }, e.name ?? ''),
        n ? h('span', { class: 'gin' }, e.cat === 'box' || e.cat === 'codec' ? `in file ×${fmtInt(n)}` : 'in file') : null));
    if (open) {
      const body = h('div', { class: 'gb' });
      if (e.desc) body.append(h('p', { class: 'prose lead' }, e.desc));
      if (e.more) body.append(h('p', { class: 'prose' }, e.more));
      const refs = [];
      if (e.spec) refs.push(`§ ${e.spec}`);
      const links = [];
      if (e.url) links.push(h('a', { href: e.url, target: '_blank', rel: 'noopener' }, '↗ registry'));
      if (e.conformance) links.push(h('a', { href: e.conformance, target: '_blank', rel: 'noopener' }, '↗ conformance'));
      if (refs.length || links.length) body.append(h('div', { class: 'spec' }, refs.join(' '), ...links.flatMap((l) => [' ', l])));
      const nodes = this.nodesByType.get(e.term);
      if (nodes?.length) {
        body.append(h('div', { class: 'chips' }, nodes.slice(0, 12).map((node, i) => h('button', { class: 'chip', onclick: () => this.app.select(node, { from: 'glossary' }) }, nodes.length > 1 ? `#${i + 1} ${node.parent?.type ?? ''}` : `show in file`)),
          nodes.length > 12 ? h('span', { class: 'chip' }, `+${fmtInt(nodes.length - 12)}`) : null));
      }
      div.append(body);
    }
    return div;
  }
}
