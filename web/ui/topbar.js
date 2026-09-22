// Top bar: app name, file picker, file summary, go-to-offset, mode and theme.

import { h, icon, clear } from './dom.js';
import { humanBytes, humanSize, fmtDuration, fmtInt } from '../core/util.js';

const MODES = [
  ['beginner', 'Beginner', 'Plain-language explanations; hides reserved fields'],
  ['detailed', 'Detailed', 'Every field with its explanation'],
  ['raw', 'Raw', 'Fields and bytes only, no prose'],
];

export class Topbar {
  constructor(el, app) {
    this.el = el;
    this.app = app;
    this.menu = null;
    this.build();
    app.store.subscribe((s, ch) => {
      if (['files', 'current', 'doc', 'mode', 'theme', 'loading', 'server', 'docVersion', 'samplesReady'].some((k) => ch.has(k))) this.render();
    });
    this.render();
  }

  build() {
    const app = this.app;
    this.anatomy = h('span');
    this.fileName = h('span', { class: 'name' }, 'open a file');
    this.fileBtn = h('button', { class: 'filebtn', 'aria-haspopup': 'menu', 'aria-expanded': 'false', title: 'Choose a file', onclick: () => this.toggleMenu() },
      this.fileName, h('span', { class: 'caret' }, '▾'));
    this.summary = h('div', { class: 'summary' });
    this.goto = h('input', {
      class: 'goto',
      placeholder: 'go to offset',
      spellcheck: 'false',
      autocomplete: 'off',
      'aria-label': 'Go to offset',
      title: 'Decimal (1234), hex (0x4D2), size (1.5M), share (50%) or from the end (-1k)',
      onkeydown: async (e) => {
        if (e.key === 'Enter') {
          const ok = await app.goto(this.goto.value);
          this.goto.classList.toggle('bad', !ok);
          if (ok) this.goto.blur();
        } else if (e.key === 'Escape') {
          this.goto.value = '';
          this.goto.classList.remove('bad');
          this.goto.blur();
        }
      },
      oninput: () => this.goto.classList.remove('bad'),
    });
    this.modeButtons = MODES.map(([m, label, tip]) => h('button', { 'data-mode': m, title: tip, onclick: () => app.setMode(m) }, label));
    this.themeBtn = h('button', { class: 'iconbtn', onclick: () => this.toggleTheme() });
    const helpBtn = h('button', { class: 'iconbtn', title: 'Keyboard shortcuts (?)', 'aria-label': 'Keyboard shortcuts', onclick: () => app.showHelp() }, icon('help'));
    this.el.append(
      h('div', { class: 'brand' }, h('b', null, 'Vidscope'), this.anatomy),
      this.fileBtn,
      this.summary,
      h('div', { class: 'top-right' }, this.goto, h('div', { class: 'seg', role: 'group', 'aria-label': 'Detail level' }, this.modeButtons), this.themeBtn, helpBtn),
    );
  }

  isDark() {
    const t = this.app.store.get().theme;
    if (t === 'dark') return true;
    if (t === 'light') return false;
    return !window.matchMedia('(prefers-color-scheme: light)').matches;
  }

  toggleTheme() {
    this.app.setTheme(this.isDark() ? 'light' : 'dark');
  }

  render() {
    const s = this.app.store.get();
    const doc = s.doc;
    this.anatomy.textContent = doc ? doc.summary.anatomy : 'video file anatomy';
    this.fileName.textContent = s.current ? s.current.name : s.files.length ? 'choose a file' : 'open a file';
    clear(this.summary);
    if (doc) {
      const parts = [humanBytes(doc.size), doc.summary.label];
      if (doc.summary.duration) parts.push(`duration ${fmtDuration(doc.summary.duration)}`);
      const count = doc.summary.unitCount ?? doc.nodeCount;
      parts.push(`${fmtInt(count)} ${count === 1 ? doc.unit[0] : doc.unit[1]}`);
      parts.forEach((p, i) => {
        if (i) this.summary.append(h('span', { class: 'sep' }, '·'));
        this.summary.append(p);
      });
    } else if (s.loading) {
      this.summary.append(`opening ${s.loading.name}…`);
    }
    if (s.server?.build) this.summary.append(h('span', { class: 'build' }, `build ${s.server.build}`));
    this.summary.title = this.summary.textContent;
    for (const b of this.modeButtons) b.setAttribute('aria-pressed', String(b.dataset.mode === s.mode));
    this.themeBtn.replaceChildren(icon(this.isDark() ? 'sun' : 'moon'));
    this.themeBtn.title = this.isDark() ? 'Switch to the light theme' : 'Switch to the dark theme';
    this.goto.disabled = !doc;
    if (this.menu) this.renderMenu();
  }

  toggleMenu() {
    if (this.menu) return this.closeMenu();
    this.menu = h('div', { class: 'menu', role: 'menu' });
    document.body.append(this.menu);
    const r = this.fileBtn.getBoundingClientRect();
    this.menu.style.left = `${Math.max(8, r.left)}px`;
    this.menu.style.top = `${r.bottom + 6}px`;
    this.fileBtn.setAttribute('aria-expanded', 'true');
    this.renderMenu();
    this.outside = (e) => {
      if (!this.menu?.contains(e.target) && !this.fileBtn.contains(e.target)) this.closeMenu();
    };
    this.esc = (e) => {
      if (e.key === 'Escape') this.closeMenu();
    };
    setTimeout(() => {
      document.addEventListener('mousedown', this.outside);
      document.addEventListener('keydown', this.esc);
    });
    return undefined;
  }

  closeMenu() {
    this.menu?.remove();
    this.menu = null;
    this.fileBtn.setAttribute('aria-expanded', 'false');
    document.removeEventListener('mousedown', this.outside);
    document.removeEventListener('keydown', this.esc);
  }

  renderMenu() {
    const s = this.app.store.get();
    const items = s.files.map((f) => h('div', {
      class: `item${s.current === f ? ' active' : ''}`,
      role: 'menuitem',
      onclick: () => {
        this.closeMenu();
        this.app.openEntry(f);
      },
    }, h('span', { class: 'n' }, f.name), h('span', { class: 's' }, humanSize(f.size)), h('span', { class: 'd' }, f.dir ?? '')));
    const actions = [
      h('div', { class: 'item action', role: 'menuitem', onclick: () => { this.closeMenu(); document.getElementById('filepick').click(); } },
        h('span', { class: 'n' }, 'Open a file from this computer…'), h('span', { class: 's' }, 'local')),
    ];
    if (s.server) {
      actions.push(h('div', {
        class: 'item action',
        role: 'menuitem',
        onclick: async () => {
          this.closeMenu();
          const p = window.prompt('Path of a file or folder on this machine:');
          if (!p) return;
          try {
            await this.app.openPath(p.trim());
          } catch (e) {
            window.alert(`Could not open ${p}: ${e.message}`);
          }
        },
      }, h('span', { class: 'n' }, 'Open a path on this machine…'), h('span', { class: 's' }, 'server')));
    }
    this.menu.replaceChildren(...items, items.length ? h('div', { class: 'sep' }) : null, ...actions);
  }
}
