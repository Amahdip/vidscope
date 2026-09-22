// PIXEL MICROSCOPE (a section of the Compare page): the picture each version shows at the chosen
// moment, decoded here in the browser, side by side; a magnifier that shows the same spot of every
// picture pixel by pixel; the difference from the reference; and PSNR and SSIM, computed as
// FFmpeg's psnr and ssim filters do.

import { h, clear } from './dom.js';
import { showTip, hideTip } from './tooltip.js';
import { loadPref, savePref } from './store.js';
import { canDecode, decoderSetup, FrameDecoder } from '../core/decode.js';
import { comparePictures } from '../core/pixels.js';
import { frameAtTime } from '../core/compare.js';
import { frameLabel } from '../codecs/frametype.js';
import { fmtNum, fmtInt } from '../core/util.js';

const ZOOMS = [2, 4, 8, 16, 32];

const TIPS = {
  section: 'Every version\'s picture at the moment chosen above, decoded here in your browser (WebCodecs) the way a player does after a seek: from the key frame before it, frame by frame. Nothing is uploaded.',
  picture: 'The pictures as decoded.',
  diff: 'How far each version\'s picture is from the reference\'s: black where they match, brighter where they differ (differences × 4 on the luma, the brightness). Smaller versions are scaled up to the reference\'s size first, the way quality metrics compare them. Blur from scaling shows at edges; compression artifacts show as blocks and noise.',
  zoom: 'How much the magnifier enlarges the reference. A version with fewer pixels shows bigger blocks for the same spot: each of its pixels covers several of the reference\'s.',
  psnr: 'PSNR (peak signal-to-noise ratio) compares the luma of this picture with the reference\'s, pixel by pixel, after scaling this one to the reference\'s size (bilinear). Higher is closer. As a rough guide, above about 45 dB differences are very hard to see, 35 to 45 dB is good streaming quality, and below 30 dB artifacts are usually visible. FFmpeg: -lavfi "[0:v]scale=W:H:flags=bilinear[a];[a][1:v]psnr"',
  ssim: 'SSIM (structural similarity) compares local patterns (brightness, contrast and structure in 8×8 windows) rather than single pixels, which is closer to what the eye notices. 1 means identical; above about 0.95 is usually good. Computed like FFmpeg\'s ssim filter.',
  approx: 'This browser gave back only the picture\'s display colours (a hardware-decoded frame, for example 10-bit HDR), not the decoded luma values, so these numbers are approximate. For HDR, the colours also went through conversion to the screen.',
};

export class PixelScope {
  constructor(view) {
    this.view = view;
    this.on = false;
    this.mode = loadPref('pixelMode', 'picture') === 'diff' ? 'diff' : 'picture';
    this.zoom = ZOOMS.includes(Number(loadPref('pixelZoom', 8))) ? Number(loadPref('pixelZoom', 8)) : 8;
    this.focus = { x: 0.5, y: 0.5 };
    this.decoders = new Map(); // doc -> Promise<FrameDecoder | { error }>
    this.state = new Map(); // doc -> { pic, error, progress, cmp, diffCanvas }
    this.cards = [];
    this.seq = 0;
    this.timer = 0;
  }

  /** The section of the Compare page; rebuilt whenever the page is. */
  section(items) {
    this.items = items;
    this.cards = [];
    // Measurements are against the reference: a new reference means measuring again.
    const refDoc = items[0]?.doc ?? null;
    if (refDoc !== this.refDoc) {
      this.refDoc = refDoc;
      for (const st of this.state.values()) {
        st.cmp = null;
        st.diffCanvas = null;
      }
    }
    const sec = h('div', { class: 'cmpsec pxsec' });
    const seg = (options, current, pick, label) => h('div', { class: 'seg', role: 'group', 'aria-label': label }, options.map(([v, text, tip]) => h('button', {
      'aria-pressed': String(current === v),
      'data-tip': tip,
      onclick: () => pick(v),
    }, text)));
    const head = h('div', { class: 'cmpsh' }, h('h4', { 'data-tip': TIPS.section }, 'Pixel microscope: the pictures at this moment'));
    if (this.on) {
      head.append(
        seg([['picture', 'pictures', TIPS.picture], ['diff', 'difference', TIPS.diff]], this.mode, (m) => {
          this.mode = m;
          savePref('pixelMode', m);
          this.refreshButtons(sec);
          this.paintAll();
        }, 'What to show'),
        seg(ZOOMS.map((z) => [z, `${z}×`, TIPS.zoom]), this.zoom, (z) => {
          this.zoom = z;
          savePref('pixelZoom', z);
          this.refreshButtons(sec);
          this.paintAll();
        }, 'Magnification'),
        h('span', { class: 'dim hint' }, 'click or drag on a picture to move the magnifier'));
    }
    sec.append(head);
    const vids = items.map((it, k) => ({ it, k })).filter(({ it }) => it?.video);
    if (!canDecode()) {
      sec.append(h('p', { class: 'prose' }, 'This browser cannot decode video itself (it has no WebCodecs). Chrome, Edge and Safari 16.4 or later can.'));
      return sec;
    }
    if (!this.on) {
      sec.append(h('p', { class: 'prose' }, 'See what each version actually looks like at this moment: the pictures are decoded here in your browser, side by side, with a magnifier that shows the same spot of every version pixel by pixel, a difference view, and PSNR and SSIM against the reference.'),
        h('button', { class: 'btn primary', onclick: () => this.start(), 'data-tip': 'Decode the frame each version shows at this moment. Long GOPs take a moment: decoding starts at the key frame before it.' }, 'Decode the pictures'));
      return sec;
    }
    if (this.view.app.store.get().mode !== 'raw') {
      sec.append(h('p', { class: 'prose' }, 'Each picture is decoded from the key frame before it, as a player does after a seek. Click or drag on a picture to move the magnifier: every version shows the same spot, pixel by pixel. Switch to "difference" to see what each conversion changed, and hover over PSNR and SSIM for what the numbers mean.'));
    }
    const grid = h('div', { class: 'pxgrid' });
    for (const { it, k } of vids) grid.append(this.card(it, k));
    sec.append(grid);
    requestAnimationFrame(() => {
      this.paintAll();
      this.update(true);
    });
    return sec;
  }

  refreshButtons(sec) {
    const segs = sec.querySelectorAll('.cmpsh .seg');
    segs[0]?.querySelectorAll('button').forEach((b, i) => b.setAttribute('aria-pressed', String(['picture', 'diff'][i] === this.mode)));
    segs[1]?.querySelectorAll('button').forEach((b, i) => b.setAttribute('aria-pressed', String(ZOOMS[i] === this.zoom)));
  }

  start() {
    this.on = true;
    this.view.render();
  }

  card(it, k) {
    const full = h('canvas', { class: 'pxfull', 'aria-label': `The picture of ${it.name} at this moment` });
    const box = h('div', { class: 'pxbox' });
    const pic = h('div', { class: 'pxpic' }, full, box);
    const zoom = h('canvas', { class: 'pxzoom', 'aria-label': `The magnified spot of ${it.name}` });
    const meta = h('span', { class: 'dim' });
    const met = h('div', { class: 'pxmet' });
    const el = h('div', { class: `pxcard${k === 0 ? ' ref' : ''}` },
      h('div', { class: 'cch' }, h('b', { class: 'cn', title: it.name }, h('bdi', null, it.name)), meta),
      pic, zoom, met);
    const card = { it, k, el, full, box, zoom, meta, met };
    this.cards.push(card);
    const move = (e) => {
      const r = full.getBoundingClientRect();
      if (!r.width) return;
      this.focus = { x: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), y: Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)) };
      this.paintZooms();
    };
    pic.addEventListener('pointerdown', (e) => {
      pic.setPointerCapture(e.pointerId);
      move(e);
    });
    pic.addEventListener('pointermove', (e) => {
      if (e.buttons) move(e);
    });
    zoom.addEventListener('pointermove', (e) => showTip(e.clientX, e.clientY, this.pixelTip(card, e)));
    zoom.addEventListener('pointerleave', hideTip);
    this.status(card);
    return el;
  }

  stateFor(it) {
    let st = this.state.get(it.doc);
    if (!st) this.state.set(it.doc, (st = { pic: null, error: null, progress: null, cmp: null, diffCanvas: null }));
    return st;
  }

  decoderFor(it) {
    let d = this.decoders.get(it.doc);
    if (!d) {
      d = decoderSetup(it.doc, it.video).then((setup) => (setup.error ? setup : new FrameDecoder(it.doc, it.video, setup)));
      this.decoders.set(it.doc, d);
    }
    return d;
  }

  /** Decode what the current moment needs (soon, so that dragging the slider does not queue work). */
  update(now = false) {
    if (!this.on || !this.cards.length) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.run(), now ? 0 : 150);
  }

  async run() {
    const my = ++this.seq;
    const stale = () => my !== this.seq;
    const t = this.view.t;
    await Promise.all(this.cards.map(async (card) => {
      const { it } = card;
      const st = this.stateFor(it);
      const dec = await this.decoderFor(it);
      if (stale()) return;
      if (dec.error) {
        st.error = dec.error;
        this.status(card);
        return;
      }
      const i = frameAtTime(it, t);
      if (st.pic?.index === i && !st.error) return;
      st.progress = [0, dec.cost(i)];
      this.status(card);
      try {
        const pic = await dec.picture(i, {
          stale,
          onProgress: (done, total) => {
            if (stale()) return;
            st.progress = [done, total];
            this.status(card);
          },
        });
        if (!pic || stale()) return;
        st.pic = pic;
        st.error = null;
      } catch (e) {
        if (stale()) return;
        console.error(e);
        st.error = `Could not decode this frame: ${e.message}`;
        st.pic = null;
      }
      st.progress = null;
      st.cmp = null;
      st.diffCanvas = null;
      this.paintFull(card);
      this.paintZoom(card);
      this.status(card);
    }));
    if (stale()) return;
    this.measure();
    this.paintAll();
  }

  /** PSNR and SSIM of every version against the reference (the first file). */
  measure() {
    const ref = this.cards.find((c) => c.k === 0);
    const refPic = ref ? this.stateFor(ref.it).pic : null;
    for (const card of this.cards) {
      const st = this.stateFor(card.it);
      if (card.k === 0 || !st.pic || !refPic) {
        st.cmp = null;
        continue;
      }
      if (!st.cmp) st.cmp = comparePictures(refPic, st.pic);
    }
  }

  // ------------------------------------------------------------ drawing

  paintAll() {
    for (const card of this.cards) {
      this.paintFull(card);
      this.status(card);
    }
    this.paintZooms();
  }

  paintZooms() {
    for (const card of this.cards) this.paintZoom(card);
  }

  /** What a card shows: its picture, or its difference from the reference. */
  source(card) {
    const st = this.stateFor(card.it);
    if (this.mode === 'diff' && card.k !== 0 && st.cmp?.diff) {
      if (!st.diffCanvas) {
        const d = st.cmp.diff();
        const cv = document.createElement('canvas');
        cv.width = d.w;
        cv.height = d.h;
        cv.getContext('2d').putImageData(new ImageData(d.rgba, d.w, d.h), 0, 0);
        st.diffCanvas = cv;
        st.diffStats = d;
      }
      return { img: st.diffCanvas, w: st.diffCanvas.width, h: st.diffCanvas.height, diff: true };
    }
    if (!st.pic) return null;
    return { img: st.pic.bitmap, w: st.pic.width, h: st.pic.height, diff: false };
  }

  paintFull(card) {
    const src = this.source(card);
    const cv = card.full;
    if (!src) {
      cv.width = 16;
      cv.height = 9;
      cv.getContext('2d').clearRect(0, 0, 16, 9);
      return;
    }
    if (cv.width !== src.w || cv.height !== src.h) {
      cv.width = src.w;
      cv.height = src.h;
    }
    cv.getContext('2d').drawImage(src.img, 0, 0);
  }

  /** The part of a card's source that the magnifier shows: [sx, sy, sw, sh] in its own pixels. */
  region(card, src, cw, ch) {
    const ref = this.cards.find((c) => c.k === 0);
    const refPic = ref ? this.stateFor(ref.it).pic : null;
    const refW = src.diff ? src.w : refPic?.width ?? src.w;
    // The reference is enlarged `zoom` times; other pictures show the same spot, so their own
    // pixels are enlarged more or less depending on their size.
    const sw = Math.min(src.w, (cw / this.zoom) * (src.w / refW));
    const sh = Math.min(src.h, sw * (ch / cw));
    const sx = Math.max(0, Math.min(src.w - sw, this.focus.x * src.w - sw / 2));
    const sy = Math.max(0, Math.min(src.h - sh, this.focus.y * src.h - sh / 2));
    return [sx, sy, sw, sh];
  }

  paintZoom(card) {
    const cv = card.zoom;
    const cw = cv.clientWidth;
    const ch = cv.clientHeight;
    if (!cw || !ch) return;
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(cw * dpr);
    cv.height = Math.round(ch * dpr);
    const g = cv.getContext('2d');
    g.clearRect(0, 0, cv.width, cv.height);
    const src = this.source(card);
    card.box.hidden = !src;
    if (!src) return;
    const [sx, sy, sw, sh] = this.region(card, src, cw, ch);
    // Whole source pixels, so that each one becomes a clean block.
    const x0 = Math.floor(sx);
    const y0 = Math.floor(sy);
    const x1 = Math.min(src.w, Math.ceil(sx + sw));
    const y1 = Math.min(src.h, Math.ceil(sy + sh));
    const scale = cv.width / sw;
    g.imageSmoothingEnabled = false;
    g.drawImage(src.img, x0, y0, x1 - x0, y1 - y0, (x0 - sx) * scale, (y0 - sy) * (cv.height / sh), (x1 - x0) * scale, (y1 - y0) * (cv.height / sh));
    // A pixel grid once pixels are big enough to tell apart.
    if (scale >= 12 * dpr) {
      g.strokeStyle = 'rgba(0, 0, 0, 0.35)';
      g.lineWidth = 1;
      g.beginPath();
      for (let x = x0; x <= x1; x++) {
        const px = Math.round((x - sx) * scale) + 0.5;
        g.moveTo(px, 0);
        g.lineTo(px, cv.height);
      }
      const sy2 = cv.height / sh;
      for (let y = y0; y <= y1; y++) {
        const py = Math.round((y - sy) * sy2) + 0.5;
        g.moveTo(0, py);
        g.lineTo(cv.width, py);
      }
      g.stroke();
    }
    card.region = { sx, sy, sw, sh, src };
    Object.assign(card.box.style, { left: `${(sx / src.w) * 100}%`, top: `${(sy / src.h) * 100}%`, width: `${(sw / src.w) * 100}%`, height: `${(sh / src.h) * 100}%` });
  }

  pixelTip(card, e) {
    const reg = card.region;
    const st = this.stateFor(card.it);
    if (!reg || !st.pic) return 'Nothing decoded yet';
    const r = card.zoom.getBoundingClientRect();
    const x = Math.floor(reg.sx + ((e.clientX - r.left) / r.width) * reg.sw);
    const y = Math.floor(reg.sy + ((e.clientY - r.top) / r.height) * reg.sh);
    const lines = [];
    if (reg.src.diff) {
      const d = st.diffCanvas.getContext('2d').getImageData(x, y, 1, 1).data[0];
      lines.push(`pixel ${x}, ${y} of the reference's grid`, `difference ${d >= 255 ? '≥ 64' : fmtInt(Math.round(d / 4))} (luma levels, 0 = same)`);
    } else {
      const L = st.pic.luma;
      const lx = Math.min(L.w - 1, Math.floor((x * L.w) / st.pic.width));
      const ly = Math.min(L.h - 1, Math.floor((y * L.h) / st.pic.height));
      lines.push(`pixel ${x}, ${y} of ${st.pic.width}×${st.pic.height}`, `luma Y = ${L.y[ly * L.w + lx]}${st.pic.lumaExact ? '' : ' (approximate)'} (16 = black, 235 = white in video range)`);
    }
    return lines.join('\n');
  }

  status(card) {
    const st = this.stateFor(card.it);
    const it = card.it;
    const i = st.pic?.index;
    clear(card.meta);
    if (st.pic) {
      const ft = it.ft;
      const type = ft?.have[i] ? frameLabel(ft.family, ft.type[i], ft.flags[i]) : 'frame';
      card.meta.append(`${st.pic.width}×${st.pic.height} · ${type}`);
    }
    clear(card.met);
    if (st.error) {
      card.met.append(h('span', { class: 'bad' }, st.error));
      return;
    }
    if (st.progress) {
      const [done, total] = st.progress;
      card.met.append(h('span', { class: 'dim', 'data-tip': 'A frame can only be decoded after the frames it refers to, so decoding starts at the key frame before it. Long GOPs mean longer waits: the same happens in a player after a seek.' },
        total > 1 ? `decoding ${fmtInt(done)} / ${fmtInt(total)} frames from the key frame…` : 'decoding…'));
      return;
    }
    if (!st.pic) return;
    if (card.k === 0) {
      card.met.append(h('span', { class: 'dim', 'data-tip': 'The other versions are measured against this picture.' }, 'reference'));
      return;
    }
    const c = st.cmp;
    if (!c) {
      card.met.append(h('span', { class: 'dim' }, 'no reference picture to compare with'));
      return;
    }
    if (c.error) {
      card.met.append(h('span', { class: 'dim', 'data-tip': 'The pictures have different shapes (aspect ratios), so pixels cannot be matched up.' }, 'different picture shape: not comparable'));
      return;
    }
    const refCard = this.cards.find((x) => x.k === 0);
    const approx = !st.pic.lumaExact || !(refCard && this.stateFor(refCard.it).pic?.lumaExact);
    const parts = [
      h('span', { class: 'm', 'data-tip': TIPS.psnr }, 'PSNR ', h('b', null, Number.isFinite(c.psnr) ? `${fmtNum(c.psnr, 2)} dB` : 'identical')),
      h('span', { class: 'sep' }, ' · '),
      h('span', { class: 'm', 'data-tip': TIPS.ssim }, 'SSIM ', h('b', null, c.ssim === null ? '–' : c.ssim.toFixed(4))),
      c.scaled ? h('span', { class: 'dim', 'data-tip': c.scaled === 'up' ? 'This version has fewer pixels than the reference, so it was scaled up to the reference\'s size before comparing, as quality metrics do.' : 'This version has more pixels than the reference, so it was scaled down to the reference\'s size (averaging) before comparing.' }, ` · scaled ${c.scaled} from ${st.pic.width}×${st.pic.height}`) : null,
      approx ? h('span', { class: 'dim', 'data-tip': TIPS.approx }, ' · approximate') : null,
      this.mode === 'diff' && st.diffStats ? h('div', { class: 'dim', 'data-tip': 'The largest difference between two matching pixels, and how many pixels differ by more than 8 levels of luma (out of 219).' }, `largest difference ${st.diffStats.max} · ${fmtNum(st.diffStats.bigShare * 100, 1)} % of pixels differ by more than 8`) : null,
    ];
    card.met.append(...parts.filter(Boolean));
  }

  /** Forget the decoders of files no longer compared. */
  prune(docs) {
    for (const [doc, d] of this.decoders) {
      if (docs.has(doc)) continue;
      d.then((x) => x.close?.());
      this.decoders.delete(doc);
      this.state.delete(doc); // its pictures belonged to the decoder's cache, closed with it
    }
  }

  /** Stop and free everything (the comparison was closed). */
  reset() {
    this.seq++;
    this.on = false;
    this.prune(new Set());
  }
}

