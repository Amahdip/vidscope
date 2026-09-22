// FRAMES view (centre pane): every frame of a video track with its type (I, P, B), its size,
// and the GOPs the frames form, in display or decoding order. Written for people new to
// video: every mark explains itself on hover, and short notes below explain the concepts.

import { h, clear } from './dom.js';
import { showTip, hideTip } from './tooltip.js';
import { loadPref, savePref } from './store.js';
import { fmtInt, fmtNum, fmtDuration, humanBytes, humanSize, plural } from '../core/util.js';
import { FT, FF, typeLetter, frameLabel, explainFrame, codecTypeName } from '../codecs/frametype.js';
import { frameTypes, analyzeFrames, displayOrder, gopLetters, frameRate, ptsOf, AUTO_SCAN_BYTES } from '../core/frames.js';

const MAIN_H = 200;
const OVER_H = 34;
const TOP = 22; // room above the bars for key-frame markers and letters
const MIN_SPAN = 12;
const CHIP_LIMIT = 600;

/** Chart colour (a CSS custom property) and opacity of a frame. */
export function paint(type, flags) {
  if (type === FT.I) return ['--ft-i', 1];
  if (type === FT.P) return ['--ft-p', flags & FF.NONREF ? 0.5 : 1];
  if (type === FT.B) return ['--ft-b', flags & FF.REF ? 1 : 0.5];
  return ['--ft-o', type === FT.UNKNOWN ? 0.55 : 0.9];
}

/** CSS class of a frame's letter chip. */
export function chipClass(type, flags) {
  if (type === FT.I) return 'ti';
  if (type === FT.P) return flags & FF.NONREF ? 'tp nr' : 'tp';
  if (type === FT.B) return flags & FF.REF ? 'tb' : 'tb nr';
  return 'to';
}

const TIPS = {
  frames: 'Each frame is one picture. Played one after another at the frame rate (frames per second), they make the video.',
  gop: 'A GOP (group of pictures) runs from one key frame to the next. A player can only start decoding at a key frame, so the GOP length decides how precisely it can seek, how fast a viewer joining a live stream sees a picture, and where streaming segments can be cut.',
  gops: 'Closed GOP: nothing in it refers to earlier frames, so it decodes on its own.\nOpen GOP: a few frames right after its first frame use the previous GOP, and are skipped when playback starts there.',
  bframes: 'B-frames are predicted from a frame before and a frame after them, which makes them the smallest frames. Encoders let you choose how many may follow each other (FFmpeg: -bf). In a "B-pyramid", some B-frames are themselves used as references by other B-frames.',
  ishare: 'I-frames are complete pictures, so they cost far more bytes than the frames between them. A shorter GOP means more I-frames and a bigger file for the same quality.',
  decode: 'Decoding order: the order frames are stored in the file, which is the order a decoder needs them in. With B-frames it differs from display order, because a B-frame needs the later frame it refers to first.',
  display: 'Display order: the order frames appear on screen, sorted by presentation time.',
};

const LEARN = [
  ['What are I, P and B frames?', 'Video compression saves space by not storing every picture in full. An I-frame (intra) is a complete picture, compressed on its own like a photo. A P-frame (predicted) stores only what changed since an earlier frame: which blocks moved where, plus small corrections. A B-frame (bi-directional) may also borrow from a frame that comes later, which usually makes it the smallest of the three. In the chart, the tall orange bars are I-frames; the many short bars between them are P- and B-frames.'],
  ['What is a GOP?', 'A GOP (group of pictures) is a key frame plus every frame after it up to the next key frame. A decoder can only start at a key frame, so GOPs are the units of seeking: to jump to 1:23, a player goes back to the key frame before it and decodes forward from there. Encoders let you choose the GOP length (FFmpeg: -g). Short GOPs seek faster and recover from errors sooner; long GOPs compress better. The shaded bands in the chart mark alternate GOPs.'],
  ['Decoding order and display order', 'A B-frame needs the next reference frame before it can be decoded, so the encoder writes that later frame into the file first. The file therefore stores frames in decoding order, and each frame carries a presentation time that tells the player when to show it. Switch the chart between the two orders to see frames change places; the GOP rows above show the same frames both ways.'],
  ['Open and closed GOPs', 'In a closed GOP no frame refers to anything before the GOP\'s first frame, so each GOP decodes on its own. In an open GOP, the frames stored right after the I-frame (but shown before it) may use the end of the previous GOP, so a player that starts at that I-frame must skip them. HEVC calls such entry frames CRA and the skipped frames RASL; H.264 marks them with a recovery point message. Streaming usually wants closed GOPs, so that every segment starts cleanly.'],
  ['Why the key frame interval matters for streaming', 'HLS and DASH cut a video into segments of a few seconds, and each segment must start with a key frame so a player can switch to it, for example to a lower quality when the network slows down. Streaming encodes therefore use a fixed GOP that divides the segment length: 2-second GOPs fit 2, 4 or 6-second segments. Encoders also add key frames at scene changes by default, which makes GOPs irregular; streaming encodes turn that off (x264: -sc_threshold 0) or force key frames at fixed times (-force_key_frames).'],
];

const LEARN_VPX = ['Hidden frames (VP9 and AV1)', 'VP9 and AV1 have no B-frames. Instead the encoder codes a future picture early as a hidden "alternate reference" frame: it is decoded but not shown, and the frames in between predict from it. Later that picture is shown with a tiny packet that says "show the frame you already have" (marked = in the chart). The packets that carry hidden frames are much larger than their neighbours.'];

export class FramesView {
  constructor(el, app) {
    this.el = el;
    this.app = app;
    this.doc = null;
    this.t = null;
    this.ft = null;
    this.an = null;
    this.order = loadPref('frameOrder', 'display');
    this.v0 = 0;
    this.v1 = 0;
    this.hoverK = -1;
    this.selI = -1;
    this.gopIndex = 0;
    this.unsub = null;
    this.queued = false;
    this.el.classList.add('frames');
    app.store.subscribe((s, ch) => {
      if (ch.has('doc')) this.setDoc(s.doc);
      else if (ch.has('samplesReady')) this.setDoc(s.doc, true);
      else if (ch.has('mode')) this.render();
      if (ch.has('theme')) this.draw();
      if (ch.has('sel')) this.onSel(s.sel);
      if (ch.has('centerTab') && s.centerTab === 'frames') this.onShow();
    });
    new ResizeObserver(() => this.draw()).observe(el);
  }

  get shown() {
    return this.app.store.get().centerTab === 'frames';
  }

  // ------------------------------------------------------------ document and track

  setDoc(doc, keep = false) {
    this.doc = doc;
    const vids = doc?.tracks.filter((t) => t.kind === 'video') ?? [];
    const t = keep && vids.includes(this.t) ? this.t : vids.find((x) => x.samples?.count) ?? vids[0] ?? null;
    this.setTrack(t, keep && t === this.t);
  }

  setTrack(t, keepView = false) {
    this.unsub?.();
    this.unsub = null;
    this.t = t;
    this.ft = t?.samples?.count && this.doc ? frameTypes(this.doc, t) : null;
    this.an = null;
    if (!keepView || !t?.samples) {
      this.v0 = 0;
      this.v1 = t?.samples?.count ?? 0;
      this.gopIndex = 0;
      this.selI = -1;
    }
    this.hoverK = -1;
    if (this.ft) this.unsub = this.ft.onChange(() => this.queueRefresh());
    if (this.ft && this.order === 'display' && !this.displayKnown()) this.order = 'decode';
    this.render();
    if (this.shown) this.onShow();
  }

  /** Start classifying frames when the view becomes visible. */
  onShow() {
    const ft = this.ft;
    if (!ft?.ctx || ft.complete) {
      this.draw();
      return;
    }
    if (ft.scanBytes <= AUTO_SCAN_BYTES) ft.ensure();
    else this.ensureVisible();
    this.draw();
  }

  /** Classify the frames on screen first (for files too large to scan automatically). */
  ensureVisible() {
    const ft = this.ft;
    if (!ft?.ctx || ft.complete) return;
    const a = Math.max(0, Math.floor(this.v0));
    const b = Math.min(ft.count, Math.ceil(this.v1));
    let lo = Infinity;
    let hi = -1;
    for (let k = a; k < b; k++) {
      const i = this.idxAt(k);
      if (i < lo) lo = i;
      if (i > hi) hi = i;
    }
    if (hi >= lo) ft.ensure(lo, hi + 1, { urgent: true });
  }

  queueRefresh() {
    if (this.queued) return;
    this.queued = true;
    requestAnimationFrame(() => {
      this.queued = false;
      this.refresh();
    });
  }

  displayKnown() {
    const s = this.t?.samples;
    return !!(s && (s.pts || s.cto));
  }

  idxAt(k) {
    return this.order === 'display' ? displayOrder(this.t).order[k] : k;
  }

  posOf(i) {
    return this.order === 'display' ? displayOrder(this.t).rank[i] : i;
  }

  // ------------------------------------------------------------ layout

  render() {
    clear(this.el);
    hideTip();
    const s = this.app.store.get();
    const doc = this.doc;
    if (!doc) return;
    const vids = doc.tracks.filter((t) => t.kind === 'video');
    if (!vids.length) {
      this.el.append(h('div', { class: 'empty-state' }, 'This file has no video track, so there are no frames to show.', h('br'), 'Audio and subtitle packets are listed in the Tracks tab.'));
      return;
    }
    const t = this.t;
    if (!t?.samples?.count) {
      const loading = doc.loadSamples && !s.samplesReady;
      this.el.append(h('div', { class: 'empty-state' }, loading ? 'Indexing frames… (the frame list appears when the whole file has been read)' : 'No frames are indexed for this track.'));
      return;
    }
    const mode = s.mode;
    this.statusEl = h('span', { class: 'fstatus' });
    const seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Frame order' },
      ['display', 'decode'].map((o) => h('button', {
        'aria-pressed': String(this.order === o),
        disabled: o === 'display' && !this.displayKnown() ? '' : null,
        'data-tip': o === 'display' && !this.displayKnown() ? `${TIPS.display}\n\nNot available here: ${doc.format.name} stores no presentation times, so frames can only be shown in decoding order.` : TIPS[o],
        onclick: () => this.setOrder(o),
      }, o === 'display' ? 'display order' : 'decoding order')));
    const chips = vids.length > 1 ? h('div', { class: 'chips' }, vids.map((v) => h('button', {
      class: `chip${v === t ? ' on' : ''}`,
      onclick: () => this.setTrack(v),
      'data-tip': `${v.label}\n${v.codecName}${v.samples?.count ? ` · ${fmtInt(v.samples.count)} frames` : ''}`,
    }, v.label))) : h('span', { class: 'ftrack', 'data-tip': `${t.codecName}` }, t.label);
    this.el.append(h('div', { class: 'fhead' }, chips, seg, this.statusEl));

    const body = h('div', { class: 'fbody' });
    if (mode === 'beginner') {
      body.append(h('p', { class: 'prose lead fintro' }, 'Video is compressed by storing a complete picture now and then (an I-frame) and, in between, only what changed (P- and B-frames). This view shows every frame of the video: its type, its size, and how frames are grouped into GOPs. Hover over anything for an explanation; click a frame to see its bytes.'));
    }
    this.tilesEl = h('div', { class: 'ftiles' });
    body.append(this.tilesEl);

    this.cvMain = h('canvas', { class: 'fmain', tabindex: '0', role: 'img', 'aria-label': `Size of every frame of ${t.label}, coloured by frame type. The table below lists how many frames of each type there are.` });
    this.cvOver = h('canvas', { class: 'fover', 'aria-label': 'Overview of the whole track; drag to move the zoomed view' });
    this.capL = h('span');
    this.capR = h('span');
    this.capM = h('span');
    const legend = h('div', { class: 'chips flegend' },
      legendItem('--ft-i', 1, 'I', 'I-frame: a complete picture, decodable on its own'),
      legendItem('--ft-p', 1, 'P', 'P-frame: predicted from earlier frames'),
      legendItem('--ft-b', 1, 'B', 'B-frame used as a reference by other B-frames'),
      legendItem('--ft-b', 0.5, 'b', 'B-frame that no other frame refers to: a player may drop it'),
      legendItem('--ft-o', 0.9, 'other', 'Switch frames, repeated frames (=), or frames whose type is not known (?)'),
      h('span', { class: 'legend', 'data-tip': 'Key frame starting a closed GOP (IDR / key frame): decoding can start here cleanly' }, h('span', { class: 'mk' }, '▼'), 'key frame'),
      h('span', { class: 'legend', 'data-tip': 'Key frame starting an open GOP (CRA / recovery point): decoding can start here, but a few frames after it are skipped' }, h('span', { class: 'mk' }, '▽'), 'open GOP'),
      h('span', { class: 'legend', 'data-tip': 'This packet also carries a hidden frame (VP9/AV1 alternate reference)' }, h('span', { class: 'mk' }, '○'), 'hidden frame'));
    body.append(h('div', { class: 'fchart' },
      h('div', { class: 'cap' }, h('span', null, 'Frame sizes'), h('span', { class: 'hint' }, 'scroll to zoom · drag to move · double-click to see everything · click a frame to select it')),
      legend, this.cvMain, h('div', { class: 'cap' }, this.capL, this.capM, this.capR), this.cvOver));

    this.gopEl = h('div', { class: 'fgop' });
    this.typesEl = h('div', { class: 'ftypes' });
    body.append(this.gopEl, this.typesEl);

    if (mode !== 'raw') {
      const learn = h('div', { class: 'flearn' }, h('h4', null, 'Learn'));
      const items = [...LEARN];
      if (['vp9', 'av1'].includes(this.ft?.family)) items.push(LEARN_VPX);
      items.forEach(([title, text], k) => learn.append(h('details', { class: 'fgroup', open: mode === 'beginner' && k < 2 ? '' : null }, h('summary', null, title), h('p', { class: 'prose' }, text))));
      body.append(learn);
    }
    this.el.append(body);
    this.installChart();
    this.refresh();
  }

  setOrder(o) {
    if (o === this.order) return;
    if (o === 'display' && !this.displayKnown()) return;
    this.order = o;
    savePref('frameOrder', o);
    this.v0 = 0;
    this.v1 = this.t.samples.count;
    this.render();
  }

  /** Update everything that depends on the classified frames. */
  refresh() {
    if (!this.ft || !this.statusEl) return;
    this.an = analyzeFrames(this.ft);
    this.renderStatus();
    this.renderTiles();
    this.renderGop();
    this.renderTypes();
    this.draw();
  }

  renderStatus() {
    const ft = this.ft;
    const el = this.statusEl;
    clear(el);
    if (ft.intraOnly) {
      el.append(h('span', { 'data-tip': 'The codec (for example Motion JPEG or ProRes) codes every frame on its own, so every frame is an I-frame and a key frame.' }, 'every frame is a key frame (intra-only codec)'));
    } else if (!ft.ctx) {
      el.append(h('span', { 'data-tip': 'Vidscope reads frame types for H.264, HEVC, AV1, VP9, VP8, MPEG-2, MPEG-4 Part 2, Sorenson and VP6. For this codec the chart shows frame sizes and the container\'s key frames only.' }, `frame types not readable for ${this.t.codecName}`));
    } else if (!ft.complete) {
      const p = ft.count ? Math.floor((ft.scanned / ft.count) * 100) : 0;
      el.append(h('span', { 'data-tip': 'Vidscope reads the first bytes of every frame (its slice or frame header) to find out its type.' }, `reading frame headers… ${p}%`));
      if (ft.scanBytes > AUTO_SCAN_BYTES && !ft.running) {
        el.append(h('button', { class: 'btn', onclick: () => { ft.ensure(); this.renderStatus(); }, 'data-tip': `Classify every frame. This reads about ${humanBytes(ft.scanBytes)} of the file; frames on screen are classified first anyway.` }, `classify all (${humanBytes(ft.scanBytes)})`));
      }
    } else {
      el.append(h('span', { 'data-tip': 'Every frame\'s type was read from its header.' }, `${fmtInt(ft.count)} frames classified`));
    }
  }

  renderTiles() {
    const an = this.an;
    const t = this.t;
    const g = an.gop;
    const fps = frameRate(t);
    const T = an.types;
    const n = an.classified || an.frames;
    const tiles = [];
    const tile = (value, label, tip) => tiles.push(h('div', { class: 'ftile', 'data-tip': tip }, h('b', null, value), h('span', null, label)));
    tile(fmtInt(an.frames), fps ? `frames · ${fmtNum(fps, fps % 1 ? 3 : 0)} per second` : 'frames', TIPS.frames);
    if (this.ft.intraOnly || (g.count === an.frames && an.frames > 1)) tile('1 frame', 'GOP length (intra-only)', `${TIPS.gop}\n\nHere every frame is a key frame.`);
    else if (g.count > 1) tile(g.minFrames === g.maxFrames ? `${fmtInt(g.minFrames)} frames` : `${fmtInt(g.minFrames)}–${fmtInt(g.maxFrames)}`, g.fixed ? `GOP length · ${fmtNum(g.avgSeconds, 2)} s each` : g.minFrames === g.maxFrames ? `GOP length · ${fmtNum(g.avgSeconds, 2)} s` : 'frames per GOP (it varies)', TIPS.gop);
    else tile(g.count ? 'one GOP' : 'no key frame', 'the whole track', TIPS.gop);
    if (g.closed || g.open) tile(`${fmtInt(g.closed)} / ${fmtInt(g.open)}`, 'closed / open GOPs', TIPS.gops);
    else tile(fmtInt(g.count), g.count === 1 ? 'GOP' : 'GOPs', TIPS.gop);
    const B = T.B.count + T.b.count;
    if (this.ft.supported && an.classified) {
      tile(B ? `up to ${an.maxB}` : 'none', B ? `B-frames in a row${an.refB ? ' · B-pyramid' : ''}` : 'B-frames', TIPS.bframes);
      if (T.I.count && !this.ft.intraOnly) tile(`${pctText(T.I.bytes, an.totalBytes)}`, `of the bytes are I-frames (${pctText(T.I.count, n)} of frames)`, TIPS.ishare);
    }
    this.tilesEl.replaceChildren(...tiles);
  }

  // ------------------------------------------------------------ GOP strip

  gopOf(i) {
    const gops = this.an?.gops ?? [];
    let lo = 0;
    let hi = gops.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (gops[mid].start <= i) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  renderGop() {
    const an = this.an;
    const ft = this.ft;
    const el = this.gopEl;
    clear(el);
    if (!an.gops.length) return;
    const gi = Math.min(Math.max(0, this.gopIndex), an.gops.length - 1);
    this.gopIndex = gi;
    const g = an.gops[gi];
    const t = this.t;
    const s = t.samples;
    const first = ft.have[g.start] ? frameLabel(ft.family, ft.type[g.start], ft.flags[g.start]) : 'a key frame';
    const state = g.partial ? 'incomplete: the file starts in the middle of this GOP'
      : g.closed === true ? 'closed' : g.closed === false ? 'open' : '';
    const nav = h('span', { class: 'fgnav' },
      h('button', { class: 'btn', disabled: gi === 0 ? '' : null, onclick: () => this.showGop(gi - 1), 'data-tip': 'Previous GOP' }, '←'),
      h('button', { class: 'btn', disabled: gi >= an.gops.length - 1 ? '' : null, onclick: () => this.showGop(gi + 1), 'data-tip': 'Next GOP' }, '→'));
    el.append(h('div', { class: 'fgh' },
      h('b', { 'data-tip': TIPS.gop }, `GOP ${fmtInt(gi + 1)} of ${fmtInt(an.gops.length)}`), nav,
      h('span', { class: 'dim' }, `${plural(g.frames, 'frame')} · ${fmtNum(g.seconds, 2)} s · ${humanBytes(g.bytes)}${state ? ` · ${state}` : ''} · starts with ${g.partial ? 'a frame that is not a key frame' : first} (frame ${fmtInt(g.start + 1)})`)));
    const rows = [['decoding order', 'The order these frames are stored in the file and decoded.', false]];
    if (this.displayKnown()) rows.push(['display order', 'The order the same frames are shown on screen.', true]);
    for (const [label, tip, display] of rows) {
      const list = gopLetters(ft, g, display);
      const line = h('div', { class: 'fgrow' }, h('span', { class: 'fgl', 'data-tip': tip }, label));
      const wrap = h('div', { class: 'fgchips' });
      for (const { i, letter } of list.slice(0, CHIP_LIMIT)) {
        const cls = ft.have[i] ? chipClass(ft.type[i], ft.flags[i]) : 'to';
        const pts = ptsOf(s, i) / (t.timescale || s.timescale || 1);
        wrap.append(h('span', {
          class: `fl ${cls}${i === this.selI ? ' sel' : ''}${!s.key || s.key[i] ? ' key' : ''}`,
          'data-i': i,
          'data-tip': `Frame ${fmtInt(i + 1)}: ${ft.have[i] ? frameLabel(ft.family, ft.type[i], ft.flags[i]) : 'not classified yet'}\n${fmtInt(s.sizes[i])} bytes · shown at ${fmtDuration(pts)}`,
        }, letter));
      }
      if (list.length > CHIP_LIMIT) wrap.append(h('span', { class: 'dim' }, ` … ${fmtInt(list.length - CHIP_LIMIT)} more`));
      line.append(wrap);
      el.append(line);
    }
    el.onmouseover = (e) => {
      const c = e.target.closest?.('.fl');
      el.querySelectorAll('.fl.hl').forEach((x) => x.classList.remove('hl'));
      if (c) el.querySelectorAll(`.fl[data-i="${c.dataset.i}"]`).forEach((x) => x.classList.add('hl'));
    };
    el.onclick = (e) => {
      const c = e.target.closest?.('.fl');
      if (c) this.app.selectSample(t, Number(c.dataset.i));
    };
  }

  showGop(gi) {
    const g = this.an?.gops[gi];
    if (!g) return;
    this.gopIndex = gi;
    this.renderGop();
    // Bring the GOP into view in the chart.
    const k = this.posOf(g.start);
    const span = this.v1 - this.v0;
    if (k < this.v0 || k >= this.v1) {
      this.v0 = Math.max(0, Math.min(this.t.samples.count - span, k - span * 0.1));
      this.v1 = this.v0 + span;
      this.ensureVisible();
    }
    this.draw();
  }

  // ------------------------------------------------------------ types table

  renderTypes() {
    const an = this.an;
    const ft = this.ft;
    const T = an.types;
    const n = an.frames;
    const bytes = an.totalBytes;
    const rows = [
      ['I', 'ti', 'I-frames', 'complete pictures', FT.I, FF.CLOSED],
      ['P', 'tp', 'P-frames', 'predicted from earlier frames', FT.P, FF.REF],
      ['p', 'tp nr', 'P-frames, not references', 'nothing is predicted from them', FT.P, FF.NONREF],
      ['B', 'tb', 'B-frames used as references', 'other B-frames predict from them', FT.B, FF.REF],
      ['b', 'tb nr', 'B-frames, not references', 'a player may drop them', FT.B, FF.NONREF],
      ['S', 'to', 'switch frames', 'for switching between streams', FT.S, 0],
      ['=', 'to', 'repeated frames', 'show a frame decoded earlier', FT.REPEAT, 0],
      ['?', 'to', 'not classified', ft.complete ? 'type not readable' : 'not read yet', FT.UNKNOWN, 0],
    ].filter((r) => T[r[0]]?.count);
    if (!rows.length) {
      this.typesEl.replaceChildren();
      return;
    }
    const tbl = h('div', { class: 'ftbl', role: 'table', 'aria-label': 'Frames by type' },
      h('div', { class: 'fr fhd', role: 'row' }, ['', 'type', 'frames', 'share', 'average size', 'share of bytes'].map((c) => h('div', { role: 'columnheader' }, c))));
    for (const [L, cls, name, what, type, flags] of rows) {
      const st = T[L];
      const tip = L === '?' ? 'Frames whose header has not been read yet, or whose codec Vidscope cannot classify.' : explainFrame(ft.family, type, flags);
      tbl.append(h('div', { class: 'fr', role: 'row', 'data-tip': tip },
        h('div', null, h('span', { class: `fl ${cls}` }, L)),
        h('div', null, h('b', null, name), h('span', { class: 'dim' }, ` · ${what}`)),
        h('div', null, fmtInt(st.count)),
        h('div', null, pctText(st.count, n)),
        h('div', { 'data-num': Math.round(st.bytes / st.count) }, humanBytes(Math.round(st.bytes / st.count))),
        h('div', null, pctText(st.bytes, bytes))));
    }
    this.typesEl.replaceChildren(h('h4', null, 'Frames by type'), tbl);
  }

  // ------------------------------------------------------------ selection

  onSel(sel) {
    const d = sel?.detail;
    const t = d?.track;
    if (!t || t.kind !== 'video' || d.sample === undefined || d.sample === null || !this.doc?.tracks.includes(t)) {
      if (this.selI !== -1) {
        this.selI = -1;
        if (this.an) this.renderGop();
        this.draw();
      }
      return;
    }
    if (t !== this.t) this.setTrack(t);
    this.selI = d.sample;
    if (!this.an) return;
    this.gopIndex = this.gopOf(this.selI);
    const k = this.posOf(this.selI);
    const span = this.v1 - this.v0;
    if (k < this.v0 || k >= this.v1) {
      this.v0 = Math.max(0, Math.min(this.t.samples.count - span, k - span / 2));
      this.v1 = this.v0 + span;
      this.ensureVisible();
    }
    this.renderGop();
    this.draw();
  }

  // ------------------------------------------------------------ chart

  installChart() {
    const cv = this.cvMain;
    let drag = null;
    cv.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    cv.addEventListener('pointerdown', (e) => {
      cv.setPointerCapture(e.pointerId);
      drag = { x: e.clientX, v0: this.v0, moved: false };
    });
    cv.addEventListener('pointermove', (e) => {
      if (drag && e.buttons) {
        const dx = e.clientX - drag.x;
        if (Math.abs(dx) > 3) drag.moved = true;
        if (drag.moved) {
          const span = this.v1 - this.v0;
          this.setView(drag.v0 - (dx / cv.clientWidth) * span, span);
          hideTip();
          return;
        }
      }
      this.onHover(e);
    });
    cv.addEventListener('pointerup', (e) => {
      if (drag && !drag.moved) {
        const k = this.frameAtX(e);
        if (k >= 0) this.app.selectSample(this.t, this.idxAt(k));
      }
      drag = null;
    });
    cv.addEventListener('pointerleave', () => {
      this.hoverK = -1;
      hideTip();
      this.draw();
    });
    cv.addEventListener('dblclick', () => this.setView(0, this.t.samples.count));
    cv.addEventListener('keydown', (e) => this.onKey(e));
    const over = this.cvOver;
    const jump = (e) => {
      const r = over.getBoundingClientRect();
      const n = this.t.samples.count;
      const span = this.v1 - this.v0;
      this.setView(((e.clientX - r.left) / r.width) * n - span / 2, span);
    };
    over.addEventListener('pointerdown', (e) => {
      over.setPointerCapture(e.pointerId);
      jump(e);
    });
    over.addEventListener('pointermove', (e) => {
      if (e.buttons) jump(e);
    });
  }

  setView(v0, span) {
    const n = this.t.samples.count;
    span = Math.min(n, Math.max(Math.min(MIN_SPAN, n), span));
    v0 = Math.min(n - span, Math.max(0, v0));
    this.v0 = v0;
    this.v1 = v0 + span;
    this.draw();
    clearTimeout(this.ensureTimer);
    this.ensureTimer = setTimeout(() => this.ensureVisible(), 120);
  }

  onWheel(e) {
    e.preventDefault();
    const cv = this.cvMain;
    const r = cv.getBoundingClientRect();
    const span = this.v1 - this.v0;
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      this.setView(this.v0 + (e.deltaX / r.width) * span, span);
      return;
    }
    const fx = (e.clientX - r.left) / r.width;
    const anchor = this.v0 + fx * span;
    const next = span * Math.exp(e.deltaY * (e.ctrlKey ? 0.01 : 0.0022));
    this.setView(anchor - fx * Math.min(this.t.samples.count, Math.max(MIN_SPAN, next)), next);
  }

  onKey(e) {
    const n = this.t.samples.count;
    const span = this.v1 - this.v0;
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      e.stopPropagation();
      const cur = this.selI >= 0 ? this.posOf(this.selI) : Math.floor(this.v0);
      const k = Math.min(n - 1, Math.max(0, cur + (e.key === 'ArrowRight' ? 1 : -1)));
      this.app.selectSample(this.t, this.idxAt(k));
    } else if (e.key === '+' || e.key === '=') {
      this.setView(this.v0 + span / 4, span / 2);
    } else if (e.key === '-') {
      this.setView(this.v0 - span / 2, span * 2);
    } else if (e.key === 'Home') {
      this.setView(0, span);
    } else if (e.key === 'End') {
      this.setView(n - span, span);
    }
  }

  /** Frame position under the pointer (the tallest frame when several share a pixel). */
  frameAtX(e) {
    const cv = this.cvMain;
    const r = cv.getBoundingClientRect();
    const span = this.v1 - this.v0;
    const x = e.clientX - r.left;
    const perPx = span / r.width;
    if (perPx <= 1) {
      const k = Math.floor(this.v0 + (x / r.width) * span);
      return k >= 0 && k < this.t.samples.count ? k : -1;
    }
    const a = Math.floor(this.v0 + Math.floor(x) * perPx);
    const z = Math.min(this.t.samples.count, Math.max(a + 1, Math.floor(this.v0 + (Math.floor(x) + 1) * perPx)));
    const s = this.t.samples;
    let best = -1;
    let m = -1;
    for (let k = a; k < z; k++) {
      const size = s.sizes[this.idxAt(k)];
      if (size > m) {
        m = size;
        best = k;
      }
    }
    return best;
  }

  onHover(e) {
    const k = this.frameAtX(e);
    if (k < 0) return;
    if (k !== this.hoverK) {
      this.hoverK = k;
      this.draw();
    }
    showTip(e.clientX, e.clientY, this.tipFor(this.idxAt(k)));
  }

  tipFor(i) {
    const t = this.t;
    const s = t.samples;
    const ft = this.ft;
    const ts = t.timescale || s.timescale || 1;
    const lines = [];
    const known = ft.have[i] && ft.type[i] !== FT.UNKNOWN;
    lines.push(`Frame ${fmtInt(i + 1)}: ${known ? frameLabel(ft.family, ft.type[i], ft.flags[i]) : ft.have[i] || !ft.ctx ? 'type not readable' : 'type not read yet'}`);
    lines.push(`${fmtInt(s.sizes[i])} bytes (${humanSize(s.sizes[i])})`);
    lines.push(`shown at ${fmtDuration(ptsOf(s, i) / ts)}${this.displayKnown() ? ` · decoded ${fmtInt(i + 1)}${ordinal(i + 1)}, shown ${fmtInt(displayOrder(t).rank[i] + 1)}${ordinal(displayOrder(t).rank[i] + 1)}` : ''}`);
    if (this.an) {
      const gi = this.gopOf(i);
      const g = this.an.gops[gi];
      lines.push(`GOP ${fmtInt(gi + 1)}, frame ${fmtInt(i - g.start + 1)} of ${fmtInt(g.frames)}`);
    }
    if (known && ft.family) {
      const name = codecTypeName(ft.family, ft.nal[i]);
      if (name) lines.push(`bitstream: ${name}${ft.layer[i] ? `, temporal layer ${ft.layer[i]}` : ''}`);
    }
    if (known && this.app.store.get().mode !== 'raw') lines.push('', explainFrame(ft.family, ft.type[i], ft.flags[i]));
    return lines.join('\n');
  }

  draw() {
    if (!this.cvMain?.isConnected || !this.t?.samples?.count) return;
    this.drawMain();
    this.drawOver();
  }

  drawMain() {
    const cv = this.cvMain;
    const w = cv.clientWidth;
    if (!w) return;
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(MAIN_H * dpr);
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const css = getComputedStyle(document.documentElement);
    const col = (n) => css.getPropertyValue(n).trim();
    const colors = { '--ft-i': col('--ft-i'), '--ft-p': col('--ft-p'), '--ft-b': col('--ft-b'), '--ft-o': col('--ft-o') };
    const t = this.t;
    const s = t.samples;
    const ft = this.ft;
    const n = s.count;
    const span = this.v1 - this.v0;
    const perPx = span / w;
    const base = MAIN_H - 1;
    const top = TOP;
    const a = Math.max(0, Math.floor(this.v0));
    const z = Math.min(n, Math.ceil(this.v1));
    let max = 1;
    for (let k = a; k < z; k++) max = Math.max(max, s.sizes[this.idxAt(k)]);
    const gops = this.an?.gops ?? [];
    const gopParity = (i) => this.gopOf(i) & 1;
    // GOP bands, recessive chrome and the size scale.
    g.fillStyle = col('--viz-grid');
    const band = col('--bg-2');
    if (gops.length > 1) {
      g.fillStyle = band;
      if (perPx <= 1) {
        const colW = w / span;
        for (let k = a; k < z; k++) if (gopParity(this.idxAt(k))) g.fillRect((k - this.v0) * colW, top - 4, colW + 0.5, base - top + 4);
      } else {
        for (let c = 0; c < w; c++) if (gopParity(this.idxAt(Math.min(n - 1, Math.floor(this.v0 + c * perPx))))) g.fillRect(c, top - 4, 1, base - top + 4);
      }
    }
    g.fillStyle = col('--viz-grid');
    g.fillRect(0, top, w, 1);
    g.fillStyle = col('--viz-base');
    g.fillRect(0, base, w, 1);
    g.fillStyle = col('--text-3');
    g.font = `11px ${col('--mono') || 'monospace'}`;
    g.textBaseline = 'bottom';
    g.textAlign = 'right';
    g.fillText(`tallest bar ${humanSize(max)}`, w - 2, top - 5);
    const selK = this.selI >= 0 ? this.posOf(this.selI) : -1;
    if (perPx <= 1 / 3) {
      // One bar per frame.
      const colW = w / span;
      const barW = Math.max(1, colW - (colW >= 6 ? 2 : colW >= 3 ? 1 : 0));
      for (let k = a; k < z; k++) {
        const i = this.idxAt(k);
        const x = (k - this.v0) * colW + (colW - barW) / 2;
        const hgt = Math.max(1, ((base - top) * s.sizes[i]) / max);
        const [c, alpha] = ft.have[i] ? paint(ft.type[i], ft.flags[i]) : ['--ft-o', 0.4];
        g.globalAlpha = (this.hoverK >= 0 && this.hoverK !== k ? 0.6 : 1) * alpha;
        g.fillStyle = colors[c];
        if (barW >= 8) roundTop(g, x, base - hgt, barW, hgt, 4);
        else g.fillRect(x, base - hgt, barW, hgt);
        g.globalAlpha = 1;
        const key = !s.key || s.key[i];
        const cx = x + barW / 2;
        if (key && gops.length > 1) {
          const open = this.an && gops[this.gopOf(i)]?.closed === false;
          g.fillStyle = col('--text-2');
          g.strokeStyle = col('--text-2');
          tri(g, cx, top - 16, Math.min(5, Math.max(3, barW / 2)), !open);
        }
        if (ft.flags[i] & FF.HIDDEN && barW >= 5) {
          g.strokeStyle = col('--text-2');
          g.beginPath();
          g.arc(cx, base - hgt - 6, 2.5, 0, Math.PI * 2);
          g.stroke();
        }
        if (barW >= 11 && ft.have[i]) {
          g.fillStyle = col('--text-2');
          g.textAlign = 'center';
          g.font = `10px ${col('--mono') || 'monospace'}`;
          g.fillText(typeLetter(ft.type[i], ft.flags[i]), cx, base - hgt - (ft.flags[i] & FF.HIDDEN ? 10 : 2));
        }
        if (k === selK) {
          g.fillStyle = col('--text');
          g.fillRect(cx - 1, base + 0, 2, 1);
          g.strokeStyle = col('--text');
          g.lineWidth = 1.5;
          g.strokeRect(x - 1.5, base - hgt - 1.5, barW + 3, hgt + 3);
          g.lineWidth = 1;
        }
      }
    } else {
      // Several frames per pixel: draw the largest one of each column.
      for (let c = 0; c < w; c++) {
        const k0 = Math.floor(this.v0 + c * perPx);
        const k1 = Math.min(n, Math.max(k0 + 1, Math.floor(this.v0 + (c + 1) * perPx)));
        let m = -1;
        let bi = -1;
        let key = false;
        let open = false;
        for (let k = k0; k < k1; k++) {
          const i = this.idxAt(k);
          if (s.sizes[i] > m) {
            m = s.sizes[i];
            bi = i;
          }
          if (!s.key || s.key[i]) {
            key = true;
            if (gops[this.gopOf(i)]?.closed === false) open = true;
          }
        }
        if (bi < 0) continue;
        const hgt = Math.max(1, ((base - top) * m) / max);
        const [cc, alpha] = ft.have[bi] ? paint(ft.type[bi], ft.flags[bi]) : ['--ft-o', 0.4];
        g.globalAlpha = alpha;
        g.fillStyle = colors[cc];
        g.fillRect(c, base - hgt, 1, hgt);
        g.globalAlpha = 1;
        if (key && gops.length > 1 && perPx < 40 && s.key) {
          g.fillStyle = col('--text-3');
          g.fillRect(c, top - (open ? 8 : 12), 1, open ? 4 : 8);
        }
        if (selK >= k0 && selK < k1) {
          g.fillStyle = col('--text');
          g.fillRect(c - 1, top - 4, 3, base - top + 4);
        }
      }
    }
    g.globalAlpha = 1;
    // Axis captions.
    const ts = t.timescale || s.timescale || 1;
    const first = this.idxAt(a);
    const last = this.idxAt(Math.max(a, z - 1));
    this.capL.textContent = `${this.order === 'display' ? 'shown' : 'frame'} #${fmtInt(a + 1)} · ${fmtDuration(ptsOf(s, first) / ts)}`;
    this.capM.textContent = `${this.order === 'display' ? 'display order' : 'decoding order'} →`;
    this.capR.textContent = `#${fmtInt(z)} · ${fmtDuration(ptsOf(s, last) / ts)}`;
  }

  drawOver() {
    const cv = this.cvOver;
    const w = cv.clientWidth;
    if (!w) return;
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(OVER_H * dpr);
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const css = getComputedStyle(document.documentElement);
    const col = (n) => css.getPropertyValue(n).trim();
    const colors = { '--ft-i': col('--ft-i'), '--ft-p': col('--ft-p'), '--ft-b': col('--ft-b'), '--ft-o': col('--ft-o') };
    const s = this.t.samples;
    const ft = this.ft;
    const n = s.count;
    const perPx = n / w;
    if (!this.overMax || this.overMaxFor !== s) {
      let m = 1;
      for (let i = 0; i < n; i++) m = Math.max(m, s.sizes[i]);
      this.overMax = m;
      this.overMaxFor = s;
    }
    const max = this.overMax;
    for (let c = 0; c < w; c++) {
      const k0 = Math.floor(c * perPx);
      const k1 = Math.min(n, Math.max(k0 + 1, Math.floor((c + 1) * perPx)));
      let m = -1;
      let bi = -1;
      for (let k = k0; k < k1; k++) {
        const i = this.idxAt(k);
        if (s.sizes[i] > m) {
          m = s.sizes[i];
          bi = i;
        }
      }
      if (bi < 0) continue;
      const hgt = Math.max(1, ((OVER_H - 4) * m) / max);
      const [cc, alpha] = ft.have[bi] ? paint(ft.type[bi], ft.flags[bi]) : ['--ft-o', 0.4];
      g.globalAlpha = alpha * 0.8;
      g.fillStyle = colors[cc];
      g.fillRect(c, OVER_H - hgt, Math.max(1, w / n), hgt);
    }
    g.globalAlpha = 1;
    // The zoomed window.
    const x0 = (this.v0 / n) * w;
    const x1 = (this.v1 / n) * w;
    g.fillStyle = col('--accent-bg');
    g.fillRect(x0, 0, Math.max(2, x1 - x0), OVER_H);
    g.strokeStyle = col('--accent');
    g.lineWidth = 1;
    g.strokeRect(x0 + 0.5, 0.5, Math.max(2, x1 - x0) - 1, OVER_H - 1);
  }
}

function legendItem(color, alpha, label, tip) {
  return h('span', { class: 'legend', 'data-tip': tip }, h('i', { style: { background: `var(${color})`, opacity: String(alpha) } }), label);
}

function pctText(a, b) {
  if (!b) return '–';
  const p = (a / b) * 100;
  return `${fmtNum(p, p < 10 ? 1 : 0)} %`;
}

function ordinal(n) {
  const t = n % 100;
  if (t >= 11 && t <= 13) return 'th';
  return ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th';
}

function tri(g, x, y, r, filled) {
  g.beginPath();
  g.moveTo(x - r, y);
  g.lineTo(x + r, y);
  g.lineTo(x, y + r * 1.4);
  g.closePath();
  if (filled) g.fill();
  else g.stroke();
}

function roundTop(g, x, y, w, hgt, r) {
  const rr = Math.min(r, w / 2, hgt);
  g.beginPath();
  g.moveTo(x, y + hgt);
  g.lineTo(x, y + rr);
  g.quadraticCurveTo(x, y, x + rr, y);
  g.lineTo(x + w - rr, y);
  g.quadraticCurveTo(x + w, y, x + w, y + rr);
  g.lineTo(x + w, y + hgt);
  g.closePath();
  g.fill();
}
