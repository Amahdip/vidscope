// Shown when no file is open: drop zone, files the server offers, and how to run it.

import { h, clear } from './dom.js';
import { humanSize } from '../core/util.js';

const FORMATS = ['MP4', 'MOV', 'M4A', 'fMP4 / CMAF', 'HEIF / AVIF', 'MKV', 'WebM', 'MPEG-TS', 'M2TS', 'AVI', 'WAV', 'FLV'];

export class Welcome {
  constructor(el, app) {
    this.el = el;
    this.app = app;
    app.store.subscribe((s, ch) => {
      if (['files', 'doc', 'error', 'loading', 'server', 'lastCompare'].some((k) => ch.has(k))) this.render();
    });
    this.render();
  }

  render() {
    const s = this.app.store.get();
    if (s.doc) return;
    clear(this.el);
    const zone = h('div', {
      class: 'dropzone',
      role: 'button',
      tabindex: '0',
      onclick: () => document.getElementById('filepick').click(),
      onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') document.getElementById('filepick').click(); },
      ondragover: (e) => { e.preventDefault(); zone.classList.add('over'); },
      ondragleave: () => zone.classList.remove('over'),
    }, h('b', null, s.loading ? `Opening ${s.loading.name}…` : 'Drop a video file here, or click to choose one'),
    h('span', null, 'It is parsed right here in your browser. Nothing is uploaded, and only the bytes being looked at are read.'));
    const box = h('div', { class: 'box' },
      h('h1', null, 'See the bytes inside video files'),
      h('p', { class: 'sub' }, 'Vidscope maps every byte of a container to the box, field or sample it belongs to, and explains what it is for.'),
      zone,
      h('div', { class: 'formats' }, FORMATS.map((f) => h('span', { class: 'chip' }, f))));
    if (s.error) box.append(h('div', { class: 'err' }, s.error));
    box.append(h('div', { class: 'wcompare' },
      h('button', { class: 'btn', onclick: () => this.app.pickCompare(), 'data-tip': 'Put a source video next to the versions converted from it (720p, 480p...): what each conversion changed, the bitrate ladder, key frame alignment, and the frame each version shows at any moment.' }, 'Compare versions of a video…'),
      s.lastCompare ? h('button', { class: 'btn', onclick: () => this.app.backToCompare() }, `Back to the comparison (${s.lastCompare.keys.length} files)`) : null,
      h('span', null, 'the source next to its converted profiles, down to single frames')));
    const files = s.files;
    if (files.length) {
      const list = h('div', { class: 'files' }, h('h4', null, s.server ? 'Files from the command line' : 'Files'));
      let dir = null;
      for (const f of files) {
        if ((f.dir ?? '') !== dir) {
          dir = f.dir ?? '';
          if (dir) list.append(h('div', { class: 'fdir', title: dir }, h('bdi', null, dir)));
        }
        list.append(h('div', { class: 'frow2', role: 'button', tabindex: '0', onclick: () => this.app.openEntry(f), onkeydown: (e) => { if (e.key === 'Enter') this.app.openEntry(f); } },
          h('span', { class: 'n' }, f.name), h('span', { class: 's' }, humanSize(f.size))));
      }
      box.append(list);
    }
    box.append(h('div', { class: 'cli' }, s.server
      ? ['Serve more files with ', h('code', null, 'vidscope ~/Movies/clip.mp4 ~/Videos'), ', or open a path from the file menu.']
      : ['Run ', h('code', null, 'node bin/vidscope.js <files or folders>'), ' to browse files from disk without choosing them one by one.']));
    this.el.append(box);
  }
}
