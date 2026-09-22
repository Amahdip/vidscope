// Vidscope UI: state, file loading, selection and wiring of the panes.

import { createStore, loadPref, savePref } from './ui/store.js';
import { openDocument } from './formats/index.js';
import { BlobSource, HttpSource } from './core/source.js';
import { fieldsAt, ensureChildren } from './core/model.js';
import { parseOffset, hex } from './core/util.js';
import { installTips, setTipFileSize, hideTip } from './ui/tooltip.js';
import { h, toast } from './ui/dom.js';
import { Topbar } from './ui/topbar.js';
import { Mapbar } from './ui/mapbar.js';
import { LeftPane } from './ui/leftpane.js';
import { HexView } from './ui/hexview.js';
import { RightPane } from './ui/rightpane.js';
import { Welcome } from './ui/welcome.js';

const store = createStore({
  files: [],
  current: null,
  doc: null,
  docVersion: 0, // bumps when a doc changes in place (lazy children, samples loaded)
  loading: null,
  error: null,
  server: null,
  mode: loadPref('mode', 'detailed'),
  theme: loadPref('theme', 'auto'),
  level: null,
  sel: null,
  leftTab: loadPref('leftTab', 'structure'),
  rightTab: 'inspector',
  samplesReady: false,
});

let seq = 0;
let localCount = 0;

/** Byte range a field hit covers (a single cell for table entries). */
export function hitRange(hit) {
  const f = hit.f;
  if (f.type === 'table' && hit.entry !== undefined) {
    const start = f.offset + hit.entry * f.entrySize;
    if (hit.cols && hit.cols.length) {
      const c = f.columns[hit.cols[0]];
      return [start + c.off, start + c.off + c.size];
    }
    return [start, start + f.entrySize];
  }
  return [f.offset, f.offset + Math.max(1, f.size)];
}

function levelFor(node, doc, current) {
  if (!node || !doc) return doc?.root ?? null;
  if (node === current || node.parent === current) return current;
  return node.parent ?? doc.root;
}

const app = {
  store,
  get doc() {
    return store.get().doc;
  },

  // ------------------------------------------------------------ files

  async loadServerFiles() {
    try {
      const [info, files] = await Promise.all([
        fetch('api/info').then((r) => (r.ok ? r.json() : null)),
        fetch('api/files').then((r) => (r.ok ? r.json() : null)),
      ]);
      if (!info || !files) throw new Error('no server');
      const entries = files.map((f) => ({ ...f, kind: 'server', key: `s${f.id}` }));
      store.set({ server: info, files: [...entries, ...store.get().files.filter((f) => f.kind === 'local')] });
    } catch {
      store.set({ server: null });
    }
  },

  addLocalFiles(fileList) {
    const added = [];
    for (const file of fileList) {
      const entry = { kind: 'local', key: `l${++localCount}`, name: file.name, size: file.size, file, dir: 'local file' };
      added.push(entry);
    }
    if (!added.length) return;
    store.set({ files: [...store.get().files, ...added] });
    this.openEntry(added[0]);
  },

  async openPath(path) {
    const res = await fetch('api/open', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Vidscope': '1' },
      body: JSON.stringify({ path }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
    await this.loadServerFiles();
    const entry = store.get().files.find((f) => f.kind === 'server' && f.id === body.id);
    if (entry) await this.openEntry(entry);
  },

  async openEntry(entry, { hash } = {}) {
    const my = ++seq;
    hideTip();
    store.set({ current: entry, loading: { name: entry.name, done: 0, total: entry.size }, error: null });
    const raw = entry.kind === 'server'
      ? new HttpSource(`api/files/${entry.id}/data`, entry.size, entry.name)
      : new BlobSource(entry.file, entry.name);
    let lastTick = 0;
    try {
      const doc = await openDocument(raw, {
        onProgress: (done, total) => {
          const now = performance.now();
          if (now - lastTick < 80 || my !== seq) return;
          lastTick = now;
          store.set({ loading: { name: entry.name, done, total } });
        },
      });
      if (my !== seq) return;
      setTipFileSize(doc.size);
      store.set({ doc, loading: null, level: doc.root, sel: null, samplesReady: !doc.loadSamples, docVersion: 0 });
      document.title = `${entry.name} — Vidscope`;
      this.updateUrl(entry);
      if (doc.loadSamples) {
        doc.loadSamples((done, total) => {
          if (my === seq) store.set({ loading: { name: entry.name, done, total, phase: 'indexing frames' } });
        }).then(() => {
          if (my !== seq) return;
          doc.recount?.();
          store.set({ samplesReady: true, loading: null, docVersion: store.get().docVersion + 1 });
        }, (e) => {
          if (my !== seq) return;
          store.set({ loading: null });
          toast(`Could not index frames: ${e.message}`);
        });
      }
      const target = hash ?? location.hash;
      const off = target ? parseOffset(target.replace(/^#/, '').replace(/^off=/, ''), doc.size) : null;
      if (off !== null) await this.selectByte(off, { from: 'url' });
    } catch (e) {
      if (my !== seq) return;
      console.error(e);
      store.set({ loading: null, error: e.message, doc: null });
    }
  },

  updateUrl(entry) {
    const url = new URL(location.href);
    if (entry?.kind === 'server') url.searchParams.set('file', entry.id);
    else url.searchParams.delete('file');
    history.replaceState(null, '', url);
  },

  pushHash(offset) {
    const url = new URL(location.href);
    url.hash = offset === null || offset === undefined ? '' : hex(offset, 1).toLowerCase();
    history.replaceState(null, '', url);
  },

  // ------------------------------------------------------------ selection

  select(node, { from = 'tree', scroll = true } = {}) {
    const s = store.get();
    if (!node || !s.doc) return;
    seq++;
    store.set({ sel: { node, from, offset: null, hits: [], field: null, detail: null, range: null }, level: levelFor(node, s.doc, s.level), rightTab: 'inspector' });
    if (scroll && from !== 'hex') this.hex?.reveal(node.offset, node);
    if (from !== 'tree') this.left?.tree.reveal(node);
    this.pushHash(node.offset);
  },

  async selectByte(offset, { from = 'hex' } = {}) {
    const s = store.get();
    const doc = s.doc;
    if (!doc) return;
    const my = ++seq;
    let node = doc.nodeAt(offset);
    if (node.lazy) {
      node = await doc.nodeAtDeep(offset);
      doc.recount?.();
      store.set({ docVersion: store.get().docVersion + 1 });
    }
    const hits = fieldsAt(node, offset);
    let detail = null;
    if (!hits.length) {
      try {
        detail = await doc.detailAt(offset, node);
      } catch (e) {
        console.error(e);
      }
    }
    if (my !== seq) return;
    let range = null;
    if (hits.length) range = hitRange(hits[0]);
    else if (detail?.hit?.fields?.length) range = hitRange(detail.hit.fields[0]);
    else if (detail?.units && detail.hit) {
      const u = detail.units[detail.hit.unit];
      range = [u.offset, u.offset + u.size];
    } else if (detail?.range) range = detail.range;
    const cur = store.get();
    store.set({
      sel: { node, from, offset, hits, field: null, detail, range },
      level: levelFor(node, doc, cur.level),
      rightTab: 'inspector',
    });
    if (from !== 'hex') this.hex?.reveal(offset);
    this.left?.tree.reveal(node);
    this.pushHash(offset);
  },

  /** Select a field of the selected node (from the inspector). */
  selectField(node, hit) {
    const s = store.get();
    seq++;
    const range = hitRange(hit);
    store.set({ sel: { ...(s.sel ?? {}), node, field: hit, range, from: 'inspector' } });
    this.hex?.reveal(range[0]);
  },

  /** Highlight an arbitrary range inside the current selection (units, table rows...). */
  selectRange(range, extra = {}) {
    const s = store.get();
    store.set({ sel: { ...(s.sel ?? {}), ...extra, range, from: 'inspector' } });
    this.hex?.reveal(range[0]);
  },

  async selectSample(track, i) {
    const s = track.samples;
    if (!s || i < 0 || i >= s.count) return;
    await this.selectByte(s.offsets[i], { from: 'tracks' });
  },

  async zoom(node) {
    if (!node) return;
    if (node.lazy) {
      await ensureChildren(node);
      store.get().doc?.recount?.();
      store.set({ docVersion: store.get().docVersion + 1 });
    }
    const doc = store.get().doc;
    // A payload with samples in it (mdat) can be zoomed too: the map then shows its samples.
    const hasSamples = !node.children?.length && doc?.overlay?.(node.bodyOffset, node.end)?.length;
    if ((node.children && node.children.length) || hasSamples) store.set({ level: node });
  },

  async goto(input) {
    const doc = store.get().doc;
    if (!doc) return false;
    const off = parseOffset(input, doc.size);
    if (off === null) return false;
    await this.selectByte(off, { from: 'goto' });
    return true;
  },

  setMode(mode) {
    savePref('mode', mode);
    store.set({ mode });
  },

  setTheme(theme) {
    savePref('theme', theme);
    store.set({ theme });
  },

  clearSelection() {
    seq++;
    store.set({ sel: null });
    this.pushHash(null);
  },

  step(dir) {
    const sel = store.get().sel;
    const doc = store.get().doc;
    if (!doc) return;
    const node = sel?.node;
    if (!node || !node.parent) {
      const first = doc.root.children?.[0];
      if (first) this.select(first, { from: 'key' });
      return;
    }
    const sibs = node.parent.children;
    const i = sibs.indexOf(node);
    const next = sibs[i + dir];
    if (next) this.select(next, { from: 'key' });
  },
};

window.vidscope = app; // handy in the devtools console

// ------------------------------------------------------------ theme and mode

function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === 'auto') delete root.dataset.theme;
  else root.dataset.theme = theme;
}

function applyMode(mode) {
  document.body.classList.remove('mode-beginner', 'mode-detailed', 'mode-raw');
  document.body.classList.add(`mode-${mode}`);
}

// ------------------------------------------------------------ drag and drop, keys

function installDragDrop() {
  const overlay = document.getElementById('drop');
  let depth = 0;
  window.addEventListener('dragenter', (e) => {
    if (![...(e.dataTransfer?.types ?? [])].includes('Files')) return;
    depth++;
    overlay.hidden = false;
  });
  window.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (!depth) overlay.hidden = true;
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    depth = 0;
    overlay.hidden = true;
    if (e.dataTransfer?.files?.length) app.addLocalFiles(e.dataTransfer.files);
  });
  const pick = document.getElementById('filepick');
  pick.addEventListener('change', () => {
    if (pick.files?.length) app.addLocalFiles(pick.files);
    pick.value = '';
  });
}

function showHelp() {
  const rows = [
    ['click a byte', 'identify it: field, box, sample'],
    ['g  or  /', 'go to offset (decimal, 0x hex, 50%, 12M, -1k from the end)'],
    ['f', 'find text (mdat, x264) or hex bytes (00 00 01); Enter finds the next'],
    ['↑ ↓ ← →', 'move the byte cursor (hex view focused)'],
    ['PgUp PgDn', 'scroll the hex view by a page'],
    ['[  ]', 'previous / next box at the same level'],
    ['u', 'select the parent box'],
    ['Enter', 'zoom the map into the selected box'],
    ['Backspace', 'zoom the map out'],
    ['1 2 3', 'Beginner / Detailed / Raw'],
    ['Esc', 'clear the selection'],
  ];
  const overlay = h('div', { class: 'help', onclick: (e) => { if (e.target === overlay) overlay.remove(); } },
    h('div', null,
      h('h3', null, 'Keyboard'),
      h('dl', { class: 'kv' }, rows.flatMap(([k, v]) => [h('dt', null, k), h('dd', null, v)])),
      h('p', { class: 'prose' }, 'Drop any file onto the window to open it. Files are parsed in your browser and never uploaded.')));
  document.body.append(overlay);
  const close = (e) => {
    if (e.key === 'Escape' || e.key === '?') {
      overlay.remove();
      window.removeEventListener('keydown', close, true);
      e.stopPropagation();
    }
  };
  window.addEventListener('keydown', close, true);
}
app.showHelp = showHelp;

function installKeys() {
  window.addEventListener('keydown', (e) => {
    const tag = e.target?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.metaKey || e.ctrlKey || e.altKey) return;
    const s = store.get();
    switch (e.key) {
      case 'g':
      case '/':
        e.preventDefault();
        document.querySelector('.goto')?.focus();
        break;
      case 'f':
        e.preventDefault();
        document.querySelector('.find')?.focus();
        break;
      case '?':
        showHelp();
        break;
      case 'Escape':
        app.clearSelection();
        break;
      case '1': app.setMode('beginner'); break;
      case '2': app.setMode('detailed'); break;
      case '3': app.setMode('raw'); break;
      case '[': app.step(-1); break;
      case ']': app.step(1); break;
      case 'u':
        if (s.sel?.node?.parent?.parent) app.select(s.sel.node.parent, { from: 'key' });
        break;
      case 'Enter':
        if (s.sel?.node && e.target === document.body) app.zoom(s.sel.node);
        break;
      case 'Backspace':
        if (s.level?.parent) {
          e.preventDefault();
          store.set({ level: s.level.parent });
        }
        break;
      default:
        break;
    }
  });
}

// ------------------------------------------------------------ resizable panes

function installSplitters() {
  const panes = document.getElementById('panes');
  const small = window.innerWidth < 1440;
  const defaults = small ? { left: 250, right: 380 } : { left: 300, right: 440 };
  const widths = loadPref('paneWidths', { ...defaults });
  const apply = () => {
    panes.style.setProperty('--left-w', `${widths.left}px`);
    panes.style.setProperty('--right-w', `${widths.right}px`);
  };
  apply();
  for (const side of ['left', 'right']) {
    const pane = document.getElementById(side);
    const handle = h('div', { class: `splitter ${side}`, role: 'separator', 'aria-orientation': 'vertical', 'data-tip': 'Drag to resize · double-click to reset' });
    pane.append(handle);
    handle.addEventListener('dblclick', () => {
      widths[side] = defaults[side];
      apply();
      savePref('paneWidths', widths);
      window.dispatchEvent(new Event('resize'));
    });
    handle.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      const startX = e.clientX;
      const start = widths[side];
      const move = (ev) => {
        const dx = ev.clientX - startX;
        const max = Math.max(260, window.innerWidth - 460 - (side === 'left' ? widths.right : widths.left));
        widths[side] = Math.round(Math.min(max, Math.max(200, side === 'left' ? start + dx : start - dx)));
        apply();
      };
      const up = () => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        savePref('paneWidths', widths);
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
    });
  }
}

// ------------------------------------------------------------ boot

async function boot() {
  applyTheme(store.get().theme);
  applyMode(store.get().mode);
  installTips();
  store.subscribe((s, changed) => {
    if (changed.has('theme')) applyTheme(s.theme);
    if (changed.has('mode')) applyMode(s.mode);
    if (changed.has('leftTab')) savePref('leftTab', s.leftTab);
    const empty = !s.doc;
    document.getElementById('app').classList.toggle('empty', empty);
    document.getElementById('welcome').hidden = !empty;
  });

  app.topbar = new Topbar(document.getElementById('topbar'), app);
  app.mapbar = new Mapbar(document.getElementById('mapbar'), app);
  app.left = new LeftPane(document.getElementById('left'), app);
  app.hex = new HexView(document.getElementById('center'), app);
  app.right = new RightPane(document.getElementById('right'), app);
  app.welcome = new Welcome(document.getElementById('welcome'), app);
  document.getElementById('app').classList.add('empty');
  document.getElementById('welcome').hidden = false;

  installDragDrop();
  installKeys();
  installSplitters();

  await app.loadServerFiles();
  const files = store.get().files;
  const want = new URL(location.href).searchParams.get('file');
  const entry = files.find((f) => f.kind === 'server' && String(f.id) === want) ?? (want === null ? files[0] : null);
  if (entry) await app.openEntry(entry);
}

boot();
