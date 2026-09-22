// STRUCTURE tab: the box/element tree, virtualised so huge files stay fast.

import { h } from './dom.js';
import { humanSize, hex, fmtInt } from '../core/util.js';
import { ensureChildren } from '../core/model.js';

const ROW = 24;
const AUTO_EXPAND_ROWS = 420;

export class TreeView {
  constructor(el, app) {
    this.app = app;
    this.el = el;
    this.expanded = new Set();
    this.loading = new Set();
    this.rows = [];
    this.pool = new Map();
    this.box = h('div', { class: 'tree', tabindex: '0', role: 'tree', 'aria-label': 'File structure' });
    this.spacer = h('div', { class: 'spacer' });
    this.box.append(this.spacer);
    el.append(this.box);
    el.addEventListener('scroll', () => this.paint());
    new ResizeObserver(() => this.paint()).observe(el);
    this.box.addEventListener('click', (e) => this.onClick(e));
    this.box.addEventListener('dblclick', (e) => this.onDblClick(e));
    this.box.addEventListener('keydown', (e) => this.onKey(e));
    app.store.subscribe((s, ch) => {
      if (ch.has('doc')) this.reset(s.doc);
      else if (ch.has('docVersion')) this.rebuild();
      if (ch.has('sel') || ch.has('mode')) this.paint(true);
    });
  }

  reset(doc) {
    this.expanded.clear();
    this.pool.forEach((r) => r.remove());
    this.pool.clear();
    this.doc = doc;
    if (doc) this.autoExpand(doc.root);
    this.rebuild();
    this.el.scrollTop = 0;
  }

  /** Expand level by level while the tree stays reasonably small. */
  autoExpand(root) {
    let frontier = [root];
    let total = root.children?.length ?? 0;
    this.expanded.add(root.id);
    for (let depth = 0; depth < 12 && frontier.length; depth++) {
      const next = [];
      for (const n of frontier) for (const c of n.children ?? []) if (c.children?.length && !c.lazy) next.push(c);
      const add = next.reduce((sum, c) => sum + c.children.length, 0);
      if (total + add > AUTO_EXPAND_ROWS) break;
      for (const c of next) this.expanded.add(c.id);
      total += add;
      frontier = next;
    }
  }

  rebuild() {
    this.rows = [];
    const root = this.doc?.root;
    if (root) {
      const walk = (n, depth) => {
        for (const c of n.children ?? []) {
          this.rows.push({ node: c, depth });
          if (this.expanded.has(c.id) && c.children) walk(c, depth + 1);
        }
      };
      walk(root, 0);
    }
    this.index = new Map(this.rows.map((r, i) => [r.node.id, i]));
    this.spacer.style.height = `${this.rows.length * ROW + 8}px`;
    this.paint(true);
  }

  paint(force = false) {
    const top = this.el.scrollTop;
    const height = this.el.clientHeight || 600;
    const first = Math.max(0, Math.floor(top / ROW) - 10);
    const last = Math.min(this.rows.length, Math.ceil((top + height) / ROW) + 10);
    const s = this.app.store.get();
    const selected = s.sel?.node;
    const mode = s.mode;
    const keep = new Set();
    for (let i = first; i < last; i++) {
      const { node, depth } = this.rows[i];
      keep.add(node.id);
      let row = this.pool.get(node.id);
      const key = `${i}|${node === selected}|${this.expanded.has(node.id)}|${this.loading.has(node.id)}|${mode}|${node.label}|${node.children?.length ?? 0}`;
      if (!row) {
        row = h('div', { class: 'trow', role: 'treeitem' });
        row.dataset.id = node.id;
        this.pool.set(node.id, row);
        this.spacer.append(row);
      } else if (!force && row.dataset.key === key) continue;
      row.dataset.key = key;
      row.dataset.idx = i;
      row.style.top = `${i * ROW}px`;
      row.style.paddingLeft = `${6 + depth * 16}px`;
      row.className = `trow k-${node.category}${node === selected ? ' sel' : ''}`;
      row.setAttribute('aria-selected', String(node === selected));
      const hasKids = node.hasChildren();
      const open = this.expanded.has(node.id);
      if (hasKids) row.setAttribute('aria-expanded', String(open));
      else row.removeAttribute('aria-expanded');
      const caret = h('span', { class: `caret${open ? ' open' : ''}${this.loading.has(node.id) ? ' busy' : ''}`, 'data-caret': '1' }, hasKids ? (this.loading.has(node.id) ? '◌' : '▶') : '');
      const parts = [caret, h('span', { class: 'ty' }, node.type)];
      if (mode === 'raw') parts.push(h('span', { class: 'off' }, hex(node.offset, 1)));
      parts.push(h('span', { class: 'sz', 'data-num': node.size }, humanSize(node.size)));
      if (mode === 'beginner' && node.name) parts.push(h('span', { class: 'fn' }, node.name));
      if (node.label && mode !== 'beginner') parts.push(h('span', { class: 'lb' }, node.label));
      if (node.warnings.length) parts.push(h('span', { class: 'wn', 'data-tip': node.warnings.join('\n') }, '⚠'));
      row.replaceChildren(...parts);
    }
    for (const [id, row] of this.pool) {
      if (!keep.has(id)) {
        row.remove();
        this.pool.delete(id);
      }
    }
  }

  nodeFromEvent(e) {
    const row = e.target.closest('.trow');
    if (!row) return null;
    return this.rows[Number(row.dataset.idx)]?.node ?? null;
  }

  async toggle(node, open = !this.expanded.has(node.id)) {
    if (!node.hasChildren()) return;
    if (open) {
      if (node.lazy) {
        this.loading.add(node.id);
        this.paint(true);
        await ensureChildren(node);
        this.loading.delete(node.id);
        this.doc?.recount?.();
        this.app.store.set({ docVersion: this.app.store.get().docVersion + 1 });
      }
      this.expanded.add(node.id);
    } else {
      this.expanded.delete(node.id);
    }
    this.rebuild();
  }

  onClick(e) {
    const node = this.nodeFromEvent(e);
    if (!node) return;
    this.box.focus({ preventScroll: true });
    if (e.target.closest('[data-caret]')) {
      this.toggle(node);
      return;
    }
    this.app.select(node, { from: 'tree' });
  }

  onDblClick(e) {
    const node = this.nodeFromEvent(e);
    if (node && !e.target.closest('[data-caret]')) this.toggle(node);
  }

  onKey(e) {
    const sel = this.app.store.get().sel?.node;
    const i = sel ? this.index.get(sel.id) : undefined;
    const go = (j) => {
      const r = this.rows[j];
      if (r) this.app.select(r.node, { from: 'tree' });
      if (r) this.scrollTo(j);
    };
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        go(i === undefined ? 0 : i + 1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        go(i === undefined ? 0 : i - 1);
        break;
      case 'ArrowRight':
        e.preventDefault();
        if (sel?.hasChildren()) {
          if (!this.expanded.has(sel.id)) this.toggle(sel, true);
          else if (i !== undefined) go(i + 1);
        }
        break;
      case 'ArrowLeft':
        e.preventDefault();
        if (sel && this.expanded.has(sel.id)) this.toggle(sel, false);
        else if (sel?.parent?.parent) {
          this.app.select(sel.parent, { from: 'tree' });
          this.reveal(sel.parent);
        }
        break;
      case 'Enter':
        e.preventDefault();
        if (sel) this.app.zoom(sel);
        break;
      default:
        return;
    }
    e.stopPropagation();
  }

  scrollTo(i) {
    const top = i * ROW;
    const h0 = this.el.clientHeight;
    if (top < this.el.scrollTop + ROW) this.el.scrollTop = Math.max(0, top - ROW * 3);
    else if (top > this.el.scrollTop + h0 - ROW * 2) this.el.scrollTop = top - h0 + ROW * 4;
  }

  /** Expand the ancestors of a node and scroll it into view. */
  reveal(node) {
    if (!node || !this.doc) return;
    let changed = false;
    for (let p = node.parent; p && p.parent; p = p.parent) {
      if (!this.expanded.has(p.id)) {
        this.expanded.add(p.id);
        changed = true;
      }
    }
    if (changed || !this.index.has(node.id)) this.rebuild();
    const i = this.index.get(node.id);
    if (i !== undefined) this.scrollTo(i);
  }

  stats() {
    return `${fmtInt(this.rows.length)} rows`;
  }
}
