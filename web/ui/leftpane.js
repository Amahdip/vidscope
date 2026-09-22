// Left pane: STRUCTURE / TRACKS / GLOSSARY tabs.

import { h } from './dom.js';
import { TreeView } from './tree.js';
import { TracksView } from './tracks.js';
import { GlossaryView } from './glossary.js';

const TABS = [
  ['structure', 'Structure'],
  ['tracks', 'Tracks'],
  ['glossary', 'Glossary'],
];

export class LeftPane {
  constructor(el, app) {
    this.app = app;
    this.buttons = TABS.map(([id, label]) => h('button', { class: 'tab', role: 'tab', 'data-tab': id, onclick: () => app.store.set({ leftTab: id }) }, label));
    this.bodies = Object.fromEntries(TABS.map(([id]) => [id, h('div', { class: 'tabbody', role: 'tabpanel' })]));
    el.append(h('div', { class: 'tabs', role: 'tablist' }, this.buttons), ...Object.values(this.bodies));
    this.tree = new TreeView(this.bodies.structure, app);
    this.tracks = new TracksView(this.bodies.tracks, app);
    this.glossary = new GlossaryView(this.bodies.glossary, app);
    app.store.subscribe((s, ch) => {
      if (ch.has('leftTab') || ch.has('doc') || ch.has('samplesReady')) this.render();
    });
    this.render();
  }

  render() {
    const s = this.app.store.get();
    for (const b of this.buttons) {
      const on = b.dataset.tab === s.leftTab;
      b.setAttribute('aria-selected', String(on));
      if (b.dataset.tab === 'tracks') {
        const n = s.doc?.tracks?.length ?? 0;
        b.replaceChildren('Tracks', n ? h('span', { class: 'badge' }, String(n)) : '');
      }
    }
    for (const [id, body] of Object.entries(this.bodies)) body.hidden = id !== s.leftTab;
    if (s.leftTab === 'structure') this.tree.paint(true);
    if (s.leftTab === 'tracks') this.tracks.render();
    if (s.leftTab === 'glossary') this.glossary.render();
  }
}
