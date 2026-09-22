// Centre pane: BYTES (the hex view) / FRAMES (frame types and GOPs) / BITRATE tabs.

import { h } from './dom.js';
import { HexView } from './hexview.js';
import { FramesView } from './frames.js';
import { BitrateView } from './bitrate.js';

const TABS = [
  ['bytes', 'Bytes', 'Every byte of the file in hexadecimal, coloured by the structure it belongs to. Click a byte to identify it.'],
  ['frames', 'Frames', 'Every frame of the video: its type (I, P or B), its size, and the GOPs (groups of pictures) the frames form.'],
  ['bitrate', 'Bitrate', 'How many bits per second each track uses over time, its average and peaks, and whether a player receiving it at a given speed would keep up.'],
];

export class CenterPane {
  constructor(el, app) {
    this.app = app;
    this.buttons = TABS.map(([id, label, tip]) => h('button', { class: 'tab', role: 'tab', 'data-tab': id, 'data-tip': tip, onclick: () => app.store.set({ centerTab: id }) }, label));
    this.bodies = Object.fromEntries(TABS.map(([id]) => [id, h('div', { class: 'cbody', role: 'tabpanel' })]));
    el.append(h('div', { class: 'tabs', role: 'tablist' }, this.buttons), ...Object.values(this.bodies));
    this.hex = new HexView(this.bodies.bytes, app);
    this.frames = new FramesView(this.bodies.frames, app);
    this.bitrate = new BitrateView(this.bodies.bitrate, app);
    app.store.subscribe((s, ch) => {
      if (ch.has('centerTab') || ch.has('doc')) this.render();
    });
    this.render();
  }

  render() {
    const s = this.app.store.get();
    for (const b of this.buttons) b.setAttribute('aria-selected', String(b.dataset.tab === s.centerTab));
    for (const [id, body] of Object.entries(this.bodies)) body.hidden = id !== s.centerTab;
  }
}
