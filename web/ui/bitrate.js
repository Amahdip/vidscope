// BITRATE view (centre pane): how many bits per second each track uses over time, its average
// and peak, what that says about the encoder's rate control, and a buffer (VBV) simulation that
// makes -maxrate and -bufsize concrete. Every number explains itself on hover.

import { h, clear } from './dom.js';
import { showTip, hideTip } from './tooltip.js';
import { loadPref, savePref } from './store.js';
import { fmtInt, fmtNum, fmtDuration, fmtBitrate, humanBytes, plural } from '../core/util.js';
import { rateTracks, bitrateSeries, rateStats, bitsPerPixel, rateControlGuess, simulateVbv, frameSize } from '../core/bitrate.js';
import { frameRate } from '../core/frames.js';

const CHART_H = 200;
const VBV_H = 150;
const TOP = 20;
const COLORS = ['--br-1', '--br-2', '--br-3'];
const BINS = [[0.5, '½ s'], [1, '1 s'], [2, '2 s'], [5, '5 s']];

const TIPS = {
  avg: 'Average bitrate: all the bits of the track divided by its duration. File size = average bitrate × duration.',
  peak: 'The most bits the track used in any one time slice, as a rate. Networks and decoder buffers have to cope with the peaks, not just the average.',
  ratio: 'Peak divided by average. Close to 1 means a nearly constant bitrate; 2 or more means the bitrate follows the content.',
  bpp: 'Bits per pixel: the average bitrate divided by (width × height × frames per second). It compares encodes of different sizes: more bits per pixel usually means higher quality, but how many are needed depends on the codec (HEVC and AV1 need fewer than H.264) and on the content (sport needs more than a talking head).',
  guess: 'How the encoder seems to have managed its bitrate, judged from the shape of the curve. The encoder settings in the file (File insights) say for sure when they are stored.',
};

const LEARN = [
  ['What is bitrate?', 'Bitrate is how much data a stream uses per second, in bits per second (b/s): 5 Mb/s means five million bits, 625 KB, every second. A file\'s size is its average bitrate times its duration, summed over its tracks. Video usually takes most of it; audio is typically 64 to 320 kb/s.'],
  ['Constant, variable and constant-quality bitrate', 'With constant bitrate (CBR) the encoder spends the same bits every second, whatever the picture: simple for networks and broadcast, wasteful on easy scenes and starved on hard ones. With variable bitrate (VBR) it moves bits from easy scenes to hard ones around an average. Constant-quality modes (CRF in x264, x265 and SVT-AV1) aim for a quality level and let the bitrate go where the content needs it. Streaming services usually cap a CRF or VBR encode with a maximum rate ("capped CRF", -crf with -maxrate and -bufsize), to keep quality high while bounding the peaks.'],
  ['Peaks and the decoder buffer (VBV)', 'A player downloads at a roughly constant speed but frames arrive in bursts of different sizes, so it keeps a buffer. The encoder models that buffer as the VBV (video buffering verifier, called HRD in the standards): bits flow in at -maxrate, each frame takes its bits out when it is decoded, and the buffer holds at most -bufsize bits. If a large frame arrives when the buffer is nearly empty, it underflows: a real player would stall. The simulation below lets you try values.'],
  ['Bits per pixel', 'Dividing the bitrate by the number of pixels shown per second gives bits per pixel, a way to compare encodes of different resolutions and frame rates. It is only a rough guide: efficient codecs such as HEVC and AV1 need fewer bits per pixel than H.264, and complex content needs more than simple content.'],
  ['Bitrate ladders', 'Adaptive streaming (HLS, DASH) encodes the same video several times, at different resolutions and bitrates, and the player switches between these renditions as the network changes. The list of renditions is the bitrate ladder. Per-title encoding chooses the ladder for each video from its complexity instead of using one fixed table.'],
];

export class BitrateView {
  constructor(el, app) {
    this.el = el;
    this.app = app;
    this.doc = null;
    this.pick = 'all'; // 'all' or a track index
    this.bin = Number(loadPref('bitrateBin', 1)) || 1;
    this.hover = -1;
    this.forgetVbv();
    this.el.classList.add('frames', 'bitrate');
    app.store.subscribe((s, ch) => {
      if (ch.has('doc')) this.setDoc(s.doc);
      else if (ch.has('samplesReady') || ch.has('mode')) this.render();
      if (ch.has('theme')) this.draw();
    });
    new ResizeObserver(() => this.draw()).observe(el);
  }

  setDoc(doc) {
    this.doc = doc;
    this.pick = 'all';
    this.forgetVbv();
    this.render();
  }

  /** A result only means something with the settings that produced it: forget them together. */
  forgetVbv() {
    this.vbv = null;
    this.vbvResult = null;
  }

  tracks() {
    const all = this.doc ? rateTracks(this.doc) : [];
    return this.pick === 'all' ? all : all.filter((t) => t.index === this.pick);
  }

  video() {
    const list = this.tracks();
    return list.find((t) => t.kind === 'video') ?? null;
  }

  render() {
    clear(this.el);
    hideTip();
    const s = this.app.store.get();
    const doc = this.doc;
    if (!doc) return;
    const all = rateTracks(doc);
    if (!all.length) {
      const loading = doc.loadSamples && !s.samplesReady;
      this.el.append(h('div', { class: 'empty-state' }, loading ? 'Indexing frames… (the bitrate appears when the whole file has been read)' : 'No frames are indexed in this file, so there is no bitrate to show.'));
      return;
    }
    if (this.pick !== 'all' && !all.some((t) => t.index === this.pick)) this.pick = 'all';
    const tracks = this.tracks();
    this.data = bitrateSeries(tracks, this.bin);
    const d = this.data;
    const seconds = d.end - d.start;
    this.stats = rateStats(d.total, d.bin, seconds);

    const chips = h('div', { class: 'chips' },
      [['all', 'All tracks'], ...all.map((t) => [t.index, t.label])].map(([k, label]) => h('button', {
        class: `chip${this.pick === k ? ' on' : ''}`,
        onclick: () => {
          this.pick = k;
          this.forgetVbv();
          this.render();
        },
        'data-tip': k === 'all' ? 'Stack every track: the total is the bitrate of the whole file' : `Only ${label}`,
      }, label)));
    const seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Time slice' }, BINS.map(([b, label]) => h('button', {
      'aria-pressed': String(this.bin === b),
      'data-tip': `Add up the bits of each ${label} slice. Short slices show bursts; long slices show the trend.`,
      onclick: () => {
        this.bin = b;
        savePref('bitrateBin', b);
        this.render();
      },
    }, label)));
    this.el.append(h('div', { class: 'fhead' }, chips, h('span', { class: 'dim', 'data-tip': 'Bits are counted in the time slice where each frame is decoded, which is when a player needs them.' }, 'slice'), seg));

    const body = h('div', { class: 'fbody' });
    if (s.mode === 'beginner') {
      body.append(h('p', { class: 'prose lead fintro' }, 'Bitrate is how many bits the video (and audio) uses each second. This view adds up the size of every frame per time slice, so you can see where the encoder spent its bits: busy scenes need more, calm ones less. Hover over anything for an explanation.'));
    }
    body.append(this.tiles(tracks, seconds));
    this.cv = h('canvas', { class: 'fmain', tabindex: '0', role: 'img', 'aria-label': 'Bitrate per time slice, stacked by track. The table below lists each track\'s average and peak.' });
    this.capL = h('span');
    this.capR = h('span');
    const legend = h('div', { class: 'chips flegend' }, tracks.map((t, k) => h('span', { class: 'legend', 'data-tip': `${t.label}: ${t.codecName}` }, h('i', { style: { background: `var(${COLORS[k] ?? '--ft-o'})` } }), t.label)),
      h('span', { class: 'legend', 'data-tip': 'The average bitrate of what is shown' }, h('span', { class: 'mk' }, '┄'), 'average'));
    body.append(h('div', { class: 'fchart' },
      h('div', { class: 'cap' }, h('span', null, `Bitrate per ${BINS.find(([b]) => b === this.bin)?.[1] ?? `${this.bin} s`} slice`), h('span', { class: 'hint' }, 'hover a bar for its numbers · click it to select its first video frame')),
      legend, this.cv, h('div', { class: 'cap' }, this.capL, h('span', null, 'time (decoding) →'), this.capR)));
    body.append(this.table(tracks, seconds));
    const v = this.video();
    if (v) body.append(this.vbvPanel(v));
    if (s.mode !== 'raw') {
      const learn = h('div', { class: 'flearn' }, h('h4', null, 'Learn'));
      LEARN.forEach(([title, text], k) => learn.append(h('details', { class: 'fgroup', open: s.mode === 'beginner' && k < 2 ? '' : null }, h('summary', null, title), h('p', { class: 'prose' }, text))));
      body.append(learn);
    }
    this.el.append(body);
    this.install();
    this.draw();
  }

  tiles(tracks, seconds) {
    const st = this.stats;
    const out = h('div', { class: 'ftiles' });
    const tile = (value, label, tip) => out.append(h('div', { class: 'ftile', 'data-tip': tip }, h('b', null, value), h('span', null, label)));
    tile(fmtBitrate(st.avg), `average · ${fmtDuration(seconds, false)}`, TIPS.avg);
    tile(fmtBitrate(st.peak), `peak (${BINS.find(([b]) => b === this.bin)?.[1] ?? this.bin} slice at ${fmtDuration(this.data.start + st.peakAt * this.bin, false)})`, TIPS.peak);
    tile(`${fmtNum(st.ratio, 2)}×`, 'peak ÷ average', TIPS.ratio);
    const v = this.video();
    if (v) {
      const vs = rateStats(this.data.series[this.tracks().indexOf(v)].bits, this.bin, seconds);
      const bpp = bitsPerPixel(v, vs.avg);
      const size = frameSize(v);
      const fps = frameRate(v);
      if (bpp) tile(fmtNum(bpp, 3), `bits per pixel (${size.width}×${size.height}, ${fmtNum(fps, fps % 1 ? 2 : 0)} fps)`, TIPS.bpp);
      const g = rateControlGuess(vs, seconds);
      tile(g.label, 'rate control, judging from the curve', `${TIPS.guess}\n\n${g.text}`);
    }
    return out;
  }

  table(tracks, seconds) {
    const d = this.data;
    let bytes = 0;
    for (const t of tracks) for (let i = 0; i < t.samples.count; i++) bytes += t.samples.sizes[i];
    const tbl = h('div', { class: 'ftbl brtbl', role: 'table', 'aria-label': 'Bitrate per track' },
      h('div', { class: 'fr fhd', role: 'row' }, ['', 'track', 'average', 'peak', 'peak ÷ avg', 'share'].map((c) => h('div', { role: 'columnheader' }, c))));
    tracks.forEach((t, k) => {
      const st = rateStats(d.series[k].bits, d.bin, seconds);
      let tb = 0;
      for (let i = 0; i < t.samples.count; i++) tb += t.samples.sizes[i];
      tbl.append(h('div', { class: 'fr', role: 'row', 'data-tip': `${t.label}: ${t.codecName}\n${fmtInt(t.samples.count)} frames, ${humanBytes(tb)}` },
        h('div', null, h('i', { class: 'sw', style: { background: `var(${COLORS[k] ?? '--ft-o'})` } })),
        h('div', null, h('b', null, t.label), h('span', { class: 'dim' }, ` · ${t.codecName}`)),
        h('div', null, fmtBitrate(st.avg)),
        h('div', null, fmtBitrate(st.peak)),
        h('div', null, `${fmtNum(st.ratio, 2)}×`),
        h('div', null, bytes ? `${fmtNum((tb / bytes) * 100, 1)} %` : '–')));
    });
    return h('div', { class: 'ftypes' }, h('h4', null, 'By track'), tbl);
  }

  // ------------------------------------------------------------ VBV simulation

  vbvPanel(v) {
    const d = this.data;
    const seconds = d.end - d.start;
    const vs = rateStats(d.series[this.tracks().indexOf(v)].bits, 1, seconds);
    // Round up to two significant digits: 9,527 kb/s -> 9,600.
    const nice = (x) => {
      const e = 10 ** Math.max(0, Math.floor(Math.log10(Math.max(1, x))) - 1);
      return Math.ceil(x / e) * e;
    };
    // A typical capped setting: maxrate 1.5 × the average, bufsize twice maxrate.
    const defMax = Math.max(100, nice((vs.avg * 1.5) / 1000));
    const maxIn = h('input', { type: 'number', min: '1', step: 'any', value: String(this.vbv?.maxrate ?? defMax), 'aria-label': 'maxrate in kilobits per second' });
    const bufIn = h('input', { type: 'number', min: '1', step: 'any', value: String(this.vbv?.bufsize ?? defMax * 2), 'aria-label': 'bufsize in kilobits' });
    const initIn = h('input', { type: 'number', min: '0', max: '100', step: '1', value: String(this.vbv?.init ?? 90), 'aria-label': 'initial buffer fullness in percent' });
    this.vbvCv = h('canvas', { class: 'fvbv', role: 'img', 'aria-label': 'Decoder buffer fullness over time' });
    this.vbvOut = h('div', { class: 'vbvres' });
    const run = () => {
      this.vbv = { maxrate: Number(maxIn.value), bufsize: Number(bufIn.value), init: Number(initIn.value) };
      this.runVbv(v);
    };
    const form = h('div', { class: 'vbvform' },
      h('label', { 'data-tip': 'The rate at which bits reach the decoder, like a download speed (FFmpeg: -maxrate). Encoders promise never to need more than this over any stretch of time.' }, 'maxrate', maxIn, h('span', null, 'kb/s')),
      h('label', { 'data-tip': 'How many bits the decoder\'s buffer holds (FFmpeg: -bufsize). A bigger buffer lets the encoder spend more bits on a hard scene, at the cost of more delay. A common start is twice maxrate.' }, 'bufsize', bufIn, h('span', null, 'kbit')),
      h('label', { 'data-tip': 'How full the buffer is when the first frame is decoded (x264 calls it vbv-init; 90 % by default).' }, 'start', initIn, h('span', null, '%')),
      h('button', { class: 'btn', onclick: run, 'data-tip': 'Run the simulation with these values' }, 'check'));
    for (const i of [maxIn, bufIn, initIn]) i.addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });
    const panel = h('div', { class: 'fvbvpanel' },
      h('h4', null, 'Decoder buffer check (VBV)'),
      h('p', { class: 'prose' }, `Would ${v.label} play smoothly for a viewer who receives it at a given speed? Bits flow into the decoder's buffer at maxrate, and each frame takes its bits out when it is decoded. If a frame needs more bits than the buffer holds, the player stalls. Streaming specifications give these two numbers; try yours.`),
      form, this.vbvCv, this.vbvOut);
    requestAnimationFrame(run);
    return panel;
  }

  runVbv(v) {
    const { maxrate, bufsize, init } = this.vbv;
    if (!(maxrate > 0 && bufsize > 0)) return;
    const r = simulateVbv(v, { maxrate: maxrate * 1000, bufsize: bufsize * 1000, init: Math.min(100, Math.max(0, init)) / 100 });
    this.vbvResult = { r, v, set: this.vbv };
    const s = v.samples;
    const ts = v.timescale || s.timescale || 1;
    clear(this.vbvOut);
    if (r.underflows.length) {
      const i = r.underflows[0];
      this.vbvOut.append(h('div', { class: 'vbvbad' }, h('b', null, `✕ ${plural(r.underflows.length, 'underflow')}`),
        ` — at ${fmtInt(maxrate)} kb/s the buffer runs dry, first at ${fmtDuration(s.dts[i] / ts)} (frame ${fmtInt(i + 1)}, ${humanBytes(s.sizes[i])}). A player receiving the stream at that speed would pause there. The encoder would need a higher maxrate, a bigger bufsize, or to be told these limits (-maxrate ${fmtInt(maxrate)}k -bufsize ${fmtInt(bufsize)}k) so it keeps big frames in check.`,
        ' ', h('button', { class: 'chip', onclick: () => this.app.selectSample(v, i), 'data-tip': 'Select that frame' }, 'show that frame')));
    } else {
      this.vbvOut.append(h('div', { class: 'vbvok' }, h('b', null, '✓ no underflow'),
        ` — at ${fmtInt(maxrate)} kb/s with a ${fmtInt(bufsize)} kbit buffer, every frame's bits arrive in time. The buffer never drops below ${fmtNum((r.min / (bufsize * 1000)) * 100, 0)} %${r.fullSeconds > 0.5 ? `, and it is full for ${fmtNum(r.fullSeconds, 1)} s in total: there the encoder could have spent more bits` : ''}.`));
    }
    this.drawVbv();
  }

  // ------------------------------------------------------------ charts

  install() {
    const cv = this.cv;
    cv.addEventListener('pointermove', (e) => {
      const k = this.binAt(e);
      if (k < 0) return;
      if (k !== this.hover) {
        this.hover = k;
        this.draw();
      }
      showTip(e.clientX, e.clientY, this.tipFor(k));
    });
    cv.addEventListener('pointerleave', () => {
      this.hover = -1;
      hideTip();
      this.draw();
    });
    cv.addEventListener('click', (e) => {
      const k = this.binAt(e);
      const v = this.video() ?? this.tracks()[0];
      if (k < 0 || !v) return;
      const s = v.samples;
      const ts = v.timescale || s.timescale || 1;
      const from = this.data.start + k * this.bin;
      for (let i = 0; i < s.count; i++) {
        if (s.dts[i] / ts >= from - 1e-9) {
          this.app.selectSample(v, i);
          break;
        }
      }
    });
  }

  binAt(e) {
    const r = this.cv.getBoundingClientRect();
    const k = Math.floor(((e.clientX - r.left) / r.width) * this.data.n);
    return k >= 0 && k < this.data.n ? k : -1;
  }

  tipFor(k) {
    const d = this.data;
    const from = d.start + k * d.bin;
    const lines = [`${fmtDuration(from)} – ${fmtDuration(from + d.bin)}`, `total ${fmtBitrate(d.total[k] / d.bin)}`];
    d.series.forEach(({ track, bits }) => lines.push(`${track.label}: ${fmtBitrate(bits[k] / d.bin)}`));
    if (k === d.n - 1) lines.push('(last slice, may be partial)');
    return lines.join('\n');
  }

  draw() {
    if (!this.cv?.isConnected || !this.data?.n) return;
    const cv = this.cv;
    const w = cv.clientWidth;
    if (!w) return;
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(CHART_H * dpr);
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const css = getComputedStyle(document.documentElement);
    const col = (n) => css.getPropertyValue(n).trim();
    const d = this.data;
    const base = CHART_H - 1;
    let max = 1;
    for (let k = 0; k < d.n; k++) max = Math.max(max, d.total[k]);
    const scale = (bits) => ((base - TOP) * bits) / max;
    g.fillStyle = col('--viz-grid');
    g.fillRect(0, TOP, w, 1);
    g.fillStyle = col('--viz-base');
    g.fillRect(0, base, w, 1);
    const colW = w / d.n;
    const barW = Math.max(1, colW - (colW >= 6 ? 2 : colW >= 3 ? 1 : 0));
    const colors = d.series.map((_, k) => col(COLORS[k] ?? '--ft-o'));
    for (let k = 0; k < d.n; k++) {
      const x = k * colW + (colW - barW) / 2;
      let y = base;
      g.globalAlpha = this.hover >= 0 && this.hover !== k ? 0.6 : 1;
      d.series.forEach(({ bits }, j) => {
        const hgt = scale(bits[k]);
        if (hgt <= 0) return;
        g.fillStyle = colors[j];
        g.fillRect(x, y - hgt, barW, hgt);
        y -= hgt;
      });
    }
    g.globalAlpha = 1;
    // Average line and the scale.
    const avgY = base - scale(this.stats.avg * d.bin);
    g.strokeStyle = col('--text-2');
    g.setLineDash([5, 4]);
    g.beginPath();
    g.moveTo(0, avgY + 0.5);
    g.lineTo(w, avgY + 0.5);
    g.stroke();
    g.setLineDash([]);
    g.fillStyle = col('--text-3');
    g.font = `11px ${col('--mono') || 'monospace'}`;
    g.textBaseline = 'bottom';
    g.textAlign = 'right';
    g.fillText(`top ${fmtBitrate(max / d.bin)}`, w - 2, TOP - 4);
    g.textAlign = 'left';
    // The average's label sits on a patch of the chart's background, so bars cannot hide it.
    const avgLabel = `average ${fmtBitrate(this.stats.avg)}`;
    const labelY = Math.max(TOP + 14, avgY - 3);
    g.fillStyle = col('--bg-1');
    g.fillRect(2, labelY - 14, g.measureText(avgLabel).width + 6, 15);
    g.fillStyle = col('--text-2');
    g.fillText(avgLabel, 5, labelY);
    this.capL.textContent = fmtDuration(d.start, false);
    this.capR.textContent = fmtDuration(d.end, false);
    this.drawVbv();
  }

  drawVbv() {
    const cv = this.vbvCv;
    const res = this.vbvResult;
    if (!cv?.isConnected || !res) return;
    const w = cv.clientWidth;
    if (!w) return;
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(VBV_H * dpr);
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const css = getComputedStyle(document.documentElement);
    const col = (n) => css.getPropertyValue(n).trim();
    const { r, v, set } = res;
    const s = v.samples;
    const n = s.count;
    const cap = set.bufsize * 1000;
    const top = 16;
    const base = VBV_H - 1;
    const y = (bits) => base - ((base - top) * Math.max(0, bits)) / cap;
    g.fillStyle = col('--viz-grid');
    g.fillRect(0, top, w, 1);
    g.fillStyle = col('--viz-base');
    g.fillRect(0, base, w, 1);
    g.fillStyle = col('--text-3');
    g.font = `11px ${col('--mono') || 'monospace'}`;
    g.textBaseline = 'bottom';
    g.textAlign = 'right';
    g.fillText(`full (${fmtInt(set.bufsize)} kbit)`, w - 2, top - 2);
    g.textAlign = 'left';
    g.fillText('empty', 2, base - 2);
    // Buffer fullness before and after each frame: a saw-tooth in the video's colour.
    g.strokeStyle = col('--br-1');
    g.lineWidth = 1.5;
    g.beginPath();
    const perPx = n / w;
    if (perPx <= 1) {
      for (let i = 0; i < n; i++) {
        const x = ((i + 0.5) / n) * w;
        if (i === 0) g.moveTo(x, y(r.before[i]));
        else g.lineTo(x, y(r.before[i]));
        g.lineTo(x, y(r.level[i]));
      }
    } else {
      for (let c = 0; c < w; c++) {
        const a = Math.floor(c * perPx);
        const z = Math.min(n, Math.max(a + 1, Math.floor((c + 1) * perPx)));
        let lo = Infinity;
        let hi = -Infinity;
        for (let i = a; i < z; i++) {
          lo = Math.min(lo, r.level[i]);
          hi = Math.max(hi, r.before[i]);
        }
        if (c === 0) g.moveTo(c, y(hi));
        g.lineTo(c, y(hi));
        g.lineTo(c, y(lo));
      }
    }
    g.stroke();
    g.lineWidth = 1;
    // Underflows.
    g.fillStyle = col('--bad');
    for (const i of r.underflows) {
      const x = ((i + 0.5) / n) * w;
      g.fillRect(x - 1, base - 10, 2, 10);
    }
  }
}
