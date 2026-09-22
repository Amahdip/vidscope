// Right pane: INSPECTOR / FILE INSIGHTS tabs.

import { h } from './dom.js';
import { InspectorView } from './inspector.js';
import { InsightsView } from './insights.js';

const TABS = [
  ['inspector', 'Inspector'],
  ['insights', 'File insights'],
];

export class RightPane {
  constructor(el, app) {
    this.app = app;
    this.buttons = TABS.map(([id, label]) => h('button', { class: 'tab', role: 'tab', 'data-tab': id, onclick: () => app.store.set({ rightTab: id }) }, label));
    this.bodies = Object.fromEntries(TABS.map(([id]) => [id, h('div', { class: 'tabbody', role: 'tabpanel' })]));
    el.append(h('div', { class: 'tabs', role: 'tablist' }, this.buttons), ...Object.values(this.bodies));
    this.inspector = new InspectorView(this.bodies.inspector, app);
    this.insights = new InsightsView(this.bodies.insights, app);
    app.store.subscribe((s, ch) => {
      if (ch.has('rightTab') || ch.has('doc')) this.render();
    });
    this.render();
  }

  render() {
    const s = this.app.store.get();
    for (const b of this.buttons) b.setAttribute('aria-selected', String(b.dataset.tab === s.rightTab));
    for (const [id, body] of Object.entries(this.bodies)) body.hidden = id !== s.rightTab;
    if (s.rightTab === 'insights') this.insights.render();
  }
}
