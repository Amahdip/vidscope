// COMPARE page: a source video next to the versions converted from it (profiles, renditions).
// What each conversion changed or lost, the bitrate ladder, whether key frames line up across the
// versions, and a microscope that shows, for any moment, the frame each version shows then.
// Every number explains itself on hover.

import { h, clear } from './dom.js';
import { showTip, hideTip } from './tooltip.js';
import { loadPref, savePref } from './store.js';
import { chipClass } from './frames.js';
import { openDocument } from '../formats/index.js';
import { cancelFrameScans } from '../core/frames.js';
import { frameLabel, explainFrame } from '../codecs/frametype.js';
import { fmtInt, fmtNum, fmtDuration, fmtBitrate, humanBytes, humanSize, plural } from '../core/util.js';
import {
  summarize, compareRows, changesFor, keyAlignment, segmentFit, sliceFor, bitsOverTime,
  frameAtTime, frameFacts, framesAround, contentStem, copiedTrack, fpsText, videoCodecName,
} from '../core/compare.js';

const LANE_H = 46;

const STATE_TIPS = {
  same: 'Same as the reference',
  changed: 'Different from the reference',
  lost: 'The reference has this, this file does not: the conversion dropped it',
  gained: 'This file has something the reference does not',
  na: 'Not known for this file',
};

const LEARN = [
  ['What is a bitrate ladder?', 'Streaming services encode each video several times: a ladder of versions (also called renditions or profiles), from high resolution and bitrate down to small and cheap. An HLS or DASH player measures the network and picks the best version it can download in time, switching between them every few seconds. Each step down typically uses about half to two thirds of the bitrate of the step above. Per-title encoding chooses the ladder for each video from its complexity: a cartoon needs far fewer bits than a football match.'],
  ['Why key frames must line up', 'A player can only switch to another version where that version can be decoded from scratch: at a key frame. HLS and DASH cut every version into segments of a few seconds that each start with a key frame, and players switch at segment boundaries. If the key frames of different versions sit at different moments, the segments do not line up, and switching shows a jump or a stall. So ladder encodes use a fixed GOP (FFmpeg: -g 48 -keyint_min 48 is 2 s at 24 fps) and no extra key frames at scene cuts (x264: -sc_threshold 0), or force key frames at fixed times (-force_key_frames "expr:gte(t,n_forced*2)").'],
  ['Why the small versions get more bits per pixel', 'Shrinking the picture removes pixels, not detail: each pixel of a 360p frame stands for a 3×3 block of the 1080p frame, so it changes more from frame to frame and costs more bits to code. Fixed costs (headers, key frames, motion vectors) also weigh more at low bitrates. Bits per pixel therefore rises as the resolution falls; a ladder that kept it constant would starve its small versions.'],
  ['What a conversion can lose', 'Whatever the command does not ask to keep. By default FFmpeg keeps one video and one audio track (-map 0 keeps them all), cannot put most subtitle formats into MP4, applies a phone video\'s rotation to the pixels when re-encoding, and mixes surround sound to stereo when told -ac 2. Colour tags and HDR metadata can be dropped by filters and some encoders. The table marks each difference: ✕ lost, + new.'],
  ['Copied or re-encoded?', 'Converting can mean two things. Remuxing (-c copy) moves the same compressed frames into another container: nothing is decoded, quality is untouched and every frame keeps its exact size. Transcoding decodes and encodes again, and every generation loses a little quality. Vidscope compares frame sizes: when every frame has the same size, the stream was copied.'],
  ['Measuring quality', 'Bitrate and resolution say how much data a version uses, not how good it looks. Quality metrics compare each version\'s decoded frames with the source: PSNR (in dB, simple), SSIM (structure) and VMAF (Netflix\'s 0–100 score, trained on viewers\' opinions). With an FFmpeg built with libvmaf, this scales a version back to the source size and prints its VMAF:\nffmpeg -i 720p.mp4 -i source.mp4 -lavfi "[0:v]scale=1920:1080:flags=bicubic[d];[d][1:v]libvmaf" -f null -'],
  ['Making a ladder with FFmpeg', 'One command per version, with the same GOP settings in each so that key frames line up:\nffmpeg -i source.mp4 -c:v libx264 -preset slow -crf 23 -maxrate 3M -bufsize 6M -vf scale=-2:720 -g 48 -keyint_min 48 -sc_threshold 0 -c:a aac -b:a 128k -movflags +faststart 720p.mp4\nChange the scale, -maxrate and -bufsize for each step. -crf with -maxrate is "capped CRF": constant quality, with the peaks held down for streaming.'],
];

const CMP_TIPS = {
  ladder: 'Each version\'s average video bitrate, with its highest 1-second peak as a tick. Between rows: how the bitrate compares with the step above.',
  timeline: 'For each version: its video bitrate over time (bars) and its key frames (orange lines). The same scenes should be hard in every version, so the bars should rise and fall together.',
  scope: 'Pick a moment: each version shows its own frame for it. The same picture can be an I-frame in one version and a B-frame in another, and its size shows how each encoder spent its bits there.',
};

export class CompareView {
  constructor(el, app) {
    this.el = el;
    this.app = app;
    this.slots = new Map(); // entry key -> { key, entry, item, error, progress }
    this.t = 0;
    this.onlyDiff = !!loadPref('compareOnlyDiff', false);
    this.sameScale = false;
    this.lanes = [];
    this.pending = 0;
    el.classList.add('cmp');
    app.store.subscribe((s, ch) => {
      if (ch.has('compare')) this.sync();
      else if (s.compare && ch.has('mode')) this.render();
      if (s.compare && ch.has('theme')) this.draw();
    });
    new ResizeObserver(() => this.draw()).observe(el);
  }

  get state() {
    return this.app.store.get().compare;
  }

  /** Whether doc is one of the documents opened for the comparison (kept for going back). */
  holds(doc) {
    for (const sl of this.slots.values()) if (sl.item?.doc === doc) return true;
    return false;
  }

  /** Open the files being compared, forget the ones that are not any more. */
  sync() {
    const cmp = this.state;
    hideTip();
    if (!cmp) {
      clear(this.el);
      return;
    }
    for (const [key, slot] of this.slots) {
      if (cmp.keys.includes(key)) continue;
      if (slot.item?.doc && slot.item.doc !== this.app.store.get().doc) cancelFrameScans(slot.item.doc);
      this.slots.delete(key);
    }
    for (const key of cmp.keys) if (!this.slots.has(key)) this.load(key);
    this.render();
  }

  async load(key) {
    const entry = this.app.store.get().files.find((f) => f.key === key);
    const slot = { key, entry, item: null, error: null, progress: { phase: 'opening', done: 0, total: entry?.size ?? 0 } };
    this.slots.set(key, slot);
    if (!entry) {
      slot.error = 'This file is no longer in the file list.';
      slot.progress = null;
      return;
    }
    try {
      const doc = await openDocument(this.app.sourceFor(entry), { onProgress: (d, t) => this.progress(slot, 'opening', d, t) });
      const item = await summarize(doc, { onProgress: (d, t, phase) => this.progress(slot, phase ?? 'indexing frames', d, t) });
      item.entry = entry;
      slot.item = item;
    } catch (e) {
      console.error(e);
      slot.error = e.message;
    }
    slot.progress = null;
    if (this.slots.get(key) === slot) this.scheduleRender();
  }

  progress(slot, phase, done, total) {
    slot.progress = { phase, done, total };
    const bar = slot.bar;
    if (!bar?.isConnected) return;
    bar.firstChild.style.width = `${total ? Math.min(100, (done / total) * 100) : 0}%`;
    bar.title = `${phase}…`;
    if (slot.phaseEl) slot.phaseEl.textContent = `${phase}…`;
  }

  scheduleRender() {
    if (this.pending) return;
    this.pending = requestAnimationFrame(() => {
      this.pending = 0;
      this.render();
    });
  }

  /** The compared slots in display order: the reference first, then the biggest pictures and bitrates. */
  ordered() {
    const cmp = this.state;
    const refKey = cmp.keys.includes(cmp.ref) ? cmp.ref : cmp.keys[0];
    const slots = cmp.keys.map((k) => this.slots.get(k)).filter(Boolean);
    const ref = slots.find((s) => s.key === refKey);
    const px = (s) => (s.item?.size ? s.item.size.width * s.item.size.height : 0);
    const others = slots.filter((s) => s !== ref).sort((a, b) => px(b) - px(a) || (b.item?.rate?.avg ?? 0) - (a.item?.rate?.avg ?? 0));
    return ref ? [ref, ...others] : others;
  }

  render() {
    const cmp = this.state;
    if (!cmp) return;
    const scroll = this.el.scrollTop;
    clear(this.el);
    hideTip();
    this.lanes = [];
    this.scopeCards = null;
    const s = this.app.store.get();
    const slots = this.ordered();
    this.shown = slots;
    const items = slots.map((sl) => sl.item);
    this.items = items;
    const loading = slots.filter((sl) => !sl.item && !sl.error).length;

    const head = h('div', { class: 'cmphead' },
      h('h2', null, 'Compare versions'),
      h('span', { class: 'dim' }, `${plural(slots.length, 'file')}${loading ? ` · opening ${loading}…` : ''}`),
      h('div', { class: 'cmpbtns' },
        h('button', { class: 'btn', onclick: () => this.app.pickCompare(), 'data-tip': 'Add or remove files, or choose another reference' }, 'Change files…'),
        h('button', { class: 'btn', onclick: () => this.app.closeCompare(), 'data-tip': 'Back to the byte viewer (the file menu can bring the comparison back)' }, 'Close')));
    const body = h('div', { class: 'cmpbody' });
    if (s.mode !== 'raw') {
      body.append(h('p', { class: 'prose lead cmpintro' }, s.mode === 'beginner'
        ? 'Streaming services convert every video into several versions (renditions, or profiles): smaller pictures and lower bitrates for slower networks and smaller screens. Here you can see what each conversion did: resolution, bitrate, codec settings, key frames, audio and subtitles, down to the single frame each version shows at a given moment. The first file is the reference, usually the source; every other file is compared with it. Hover over anything for an explanation.'
        : 'The first file is the reference (usually the source); every other version is compared with it. Hover over any label or number for an explanation.'));
    }
    body.append(this.cards(slots));
    if (!loading && items.some(Boolean)) {
      const rows = compareRows(items, 0);
      if (slots.length > 1 && items[0]) body.append(this.changes(rows, items));
      body.append(this.table(rows, slots));
      const vids = items.filter((it) => it?.video);
      if (vids.length) {
        body.append(this.ladder(items));
        body.append(this.timeline(items));
        body.append(this.scope(items));
      }
      if (s.mode !== 'raw') {
        const learn = h('div', { class: 'flearn cmplearn' }, h('h4', null, 'Learn'));
        LEARN.forEach(([title, text], k) => learn.append(h('details', { class: 'fgroup', open: s.mode === 'beginner' && k < 2 ? '' : null }, h('summary', null, title), prose(text))));
        body.append(learn);
      }
    } else if (loading) {
      body.append(h('div', { class: 'empty-state' }, 'Opening the files… the comparison appears when every file has been read.'));
    }
    this.el.append(head, body);
    this.el.scrollTop = scroll;
    this.draw();
  }

  // ------------------------------------------------------------ files

  cards(slots) {
    const out = h('div', { class: 'cmpcards' });
    slots.forEach((sl, k) => {
      const it = sl.item;
      const name = sl.entry?.name ?? sl.key;
      const card = h('div', { class: `cmpcard${k === 0 ? ' ref' : ''}` });
      const top = h('div', { class: 'cch' },
        h('b', { class: 'cn', title: name }, h('bdi', null, name)),
        k === 0
          ? h('span', { class: 'chip on', 'data-tip': 'The reference: every other file is compared with this one. Usually the source the others were made from.' }, 'reference')
          : h('button', { class: 'chip', onclick: () => this.app.store.set({ compare: { ...this.state, ref: sl.key } }), 'data-tip': 'Compare every other file with this one' }, 'make reference'));
      card.append(top);
      if (it) {
        const v = it.video;
        const facts = [it.doc.summary.label];
        if (it.size) facts.push(`${it.size.width}×${it.size.height}`);
        if (it.fps) facts.push(fpsText(it.fps));
        if (v) facts.push(videoCodecName(it));
        card.append(h('div', { class: 'ccf' }, facts.join(' · ')),
          h('div', { class: 'ccf dim' }, [humanBytes(it.doc.size), it.duration ? fmtDuration(it.duration) : null, it.rate ? `video ${fmtBitrate(it.rate.avg)}` : null].filter(Boolean).join(' · ')));
        card.append(h('div', { class: 'cca' },
          h('button', { class: 'chip', onclick: () => this.app.inspectCompared(sl.entry, it.doc), 'data-tip': 'Open this file in the byte viewer, with its Frames and Bitrate views. The file menu brings you back here.' }, 'inspect'),
          slots.length > 1 ? h('button', { class: 'chip', onclick: () => this.remove(sl.key), 'data-tip': 'Leave this file out of the comparison' }, 'remove') : null));
      } else if (sl.error) {
        card.append(h('div', { class: 'ccf bad' }, `Could not open: ${sl.error}`),
          h('div', { class: 'cca' }, h('button', { class: 'chip', onclick: () => this.remove(sl.key) }, 'remove')));
      } else {
        const p = sl.progress ?? { phase: 'opening', done: 0, total: 0 };
        sl.bar = h('div', { class: 'progress', title: `${p.phase}…` }, h('i', { style: { width: `${p.total ? Math.min(100, (p.done / p.total) * 100) : 0}%` } }));
        sl.phaseEl = h('div', { class: 'ccf dim' }, `${p.phase}…`);
        card.append(sl.phaseEl, sl.bar);
      }
      out.append(card);
    });
    out.append(h('button', { class: 'cmpcard add', onclick: () => this.app.pickCompare(), 'data-tip': 'Add another version, or a file from this computer' }, '+ add a file'));
    return out;
  }

  remove(key) {
    const cmp = this.state;
    const keys = cmp.keys.filter((k) => k !== key);
    if (!keys.length) this.app.closeCompare();
    else this.app.store.set({ compare: { keys, ref: keys.includes(cmp.ref) ? cmp.ref : keys[0] } });
  }

  // ------------------------------------------------------------ what changed

  changes(rows, items) {
    const out = h('div', { class: 'cmpsec' }, h('h4', null, 'What each conversion did'));
    const grid = h('div', { class: 'cmpchg' });
    const ref = items[0];
    items.forEach((it, k) => {
      if (!k || !it) return;
      const card = h('div', { class: 'chgcard' }, h('div', { class: 'cch' }, h('b', { class: 'cn', title: it.name }, h('bdi', null, it.name))));
      const list = h('ul', { class: 'chglist' });
      const vCopy = copiedTrack(ref.video, it.video);
      if (vCopy === true) list.append(h('li', { class: 'copy', 'data-tip': 'Every video frame has exactly the same size as in the reference: the video was copied (remuxed, -c:v copy), not encoded again. Its quality is identical.' }, h('b', null, '= video copied'), ' bit for bit, not re-encoded'));
      else if (it.video && ref.video) list.append(h('li', { class: 'enc', 'data-tip': 'The frame sizes differ from the reference: the video was decoded and encoded again (transcoded). Every re-encode loses a little quality; this version\'s settings decide how much.' }, h('b', null, '≠ video re-encoded')));
      const aCopy = copiedTrack(ref.audio[0], it.audio[0]);
      if (aCopy === true) list.append(h('li', { class: 'copy', 'data-tip': 'The audio frames have the same sizes as in the reference: the audio was copied (-c:a copy).' }, h('b', null, '= audio copied')));
      const ch = changesFor(rows, 0, k);
      for (const c of ch) {
        if (c.state === 'lost') list.append(h('li', { class: 'lost', 'data-tip': `The reference has ${c.label} "${c.from}"; this file has none.` }, h('b', null, `✕ ${c.label} lost`), h('span', { class: 'dim' }, ` (was ${c.from})`)));
        else if (c.state === 'gained') list.append(h('li', { class: 'gained', 'data-tip': `This file has ${c.label} that the reference does not.` }, h('b', null, `+ ${c.label}`), `: ${c.to}`));
        else list.append(h('li', null, h('b', null, c.label), ': ', h('span', { class: 'dim' }, c.from), ' → ', c.to, c.note ? h('span', { class: 'note2' }, ` (${c.note})`) : null));
      }
      if (!ch.length) list.append(h('li', { class: 'dim' }, 'None of the main properties changed.'));
      card.append(list);
      grid.append(card);
    });
    out.append(grid);
    return out;
  }

  // ------------------------------------------------------------ side by side

  table(rows, slots) {
    const n = slots.length;
    const shown = this.onlyDiff ? rows.filter((r) => r.cells.some((c) => c.state === 'changed' || c.state === 'lost' || c.state === 'gained')) : rows;
    const toggle = h('label', { class: 'cmptog', 'data-tip': 'Hide the rows where every file matches the reference' },
      h('input', { type: 'checkbox', checked: this.onlyDiff ? '' : null, onchange: (e) => { this.onlyDiff = e.target.checked; savePref('compareOnlyDiff', this.onlyDiff); this.render(); } }), 'only differences');
    const grid = h('div', { class: 'cmptbl', role: 'table', 'aria-label': 'Properties of each file, side by side', style: { gridTemplateColumns: `minmax(150px, 190px) repeat(${n}, minmax(150px, 1fr))` } });
    grid.append(h('div', { class: 'ch corner', role: 'columnheader' }, ''));
    slots.forEach((sl, k) => grid.append(h('div', { class: `ch${k === 0 ? ' ref' : ''}`, role: 'columnheader', title: sl.entry?.name ?? '' }, h('bdi', null, sl.entry?.name ?? sl.key), k === 0 ? h('span', { class: 'dim' }, ' · reference') : null)));
    let group = null;
    for (const r of shown) {
      if (r.group !== group) {
        group = r.group;
        grid.append(h('div', { class: 'cg', role: 'row', style: { gridColumn: `1 / span ${n + 1}` } }, group));
      }
      grid.append(h('div', { class: 'cl', role: 'rowheader', 'data-tip': r.tip }, r.label));
      r.cells.forEach((c, k) => {
        const tip = [c.title, c.state !== 'ref' ? (c.near ? 'About the same as the reference: containers round this slightly differently' : STATE_TIPS[c.state]) : null].filter(Boolean).join('\n\n');
        grid.append(h('div', { class: `cc s-${c.state}`, role: 'cell', 'data-tip': tip || null },
          c.state === 'lost' ? h('span', { class: 'mk' }, '✕ lost') : c.state === 'gained' ? h('span', { class: 'mk' }, '+ ') : null,
          c.state === 'lost' ? null : c.text,
          c.note ? h('span', { class: 'nt' }, c.note) : null,
          k && c.state === 'changed' && !c.note ? h('span', { class: 'nt' }, 'changed') : null));
      });
    }
    if (!shown.length) grid.append(h('div', { class: 'cc s-same', style: { gridColumn: `1 / span ${n + 1}` } }, 'Every file matches the reference.'));
    return h('div', { class: 'cmpsec' }, h('div', { class: 'cmpsh' }, h('h4', null, 'Side by side'), toggle), h('div', { class: 'cmpscroll' }, grid));
  }

  // ------------------------------------------------------------ bitrate ladder

  ladder(items) {
    const rows = items.map((it, k) => ({ it, k })).filter(({ it }) => it?.rate);
    rows.sort((a, b) => b.it.rate.avg - a.it.rate.avg);
    let max = 0;
    for (const { it } of rows) max = Math.max(max, it.rate.peak, it.rate.avg);
    const list = h('div', { class: 'ladder', role: 'list', 'aria-label': 'Average video bitrate of each file' });
    rows.forEach(({ it, k }, j) => {
      if (j) {
        const above = rows[j - 1].it;
        const r = it.rate.avg / above.rate.avg;
        list.append(h('div', { class: 'lstep', 'data-tip': `${it.name} uses ${fmtNum(r * 100, 0)} % of the video bitrate of ${above.name}.${it.size && above.size ? ` Its pictures have ${fmtNum(((it.size.width * it.size.height) / (above.size.width * above.size.height)) * 100, 0)} % of the pixels.` : ''}` }, h('span'), h('span', null, `${times(r)} the bitrate of the step above`), h('span')));
      }
      const tip = [`${it.name}`, `average ${fmtBitrate(it.rate.avg)}, highest second ${fmtBitrate(it.rate.peak)}`,
        it.size ? `${it.size.width}×${it.size.height}${it.fps ? ` at ${fpsText(it.fps)}` : ''}` : null,
        it.bpp ? `${fmtNum(it.bpp, 3)} bits per pixel` : null].filter(Boolean).join('\n');
      list.append(h('div', { class: `lrow${k === 0 ? ' ref' : ''}`, role: 'listitem', 'data-tip': tip },
        h('div', { class: 'll' }, h('bdi', null, it.size ? `${it.size.height}p` : '—'), h('span', { class: 'dim' }, ` ${it.name}`)),
        h('div', { class: 'lbar' },
          h('i', { style: { width: `${(it.rate.avg / max) * 100}%` } }),
          h('b', { style: { left: `${(it.rate.peak / max) * 100}%` } })),
        h('div', { class: 'lv' }, fmtBitrate(it.rate.avg), h('span', { class: 'dim' }, it.bpp ? ` · ${fmtNum(it.bpp, 3)} bpp` : ''))));
    });
    return h('div', { class: 'cmpsec' },
      h('div', { class: 'cmpsh' }, h('h4', { 'data-tip': CMP_TIPS.ladder }, 'Bitrate ladder'),
        h('span', { class: 'legend dim' }, h('i', { class: 'lgbar' }), 'average', h('i', { class: 'lgtick' }), 'peak second')),
      list);
  }

  // ------------------------------------------------------------ timeline: bitrate and key frames

  timeline(items) {
    const ka = keyAlignment(items, 0);
    this.ka = ka;
    this.span = 0;
    for (const it of items) if (it?.times?.length) this.span = Math.max(this.span, it.duration ?? 0, it.times[it.times.length - 1]);
    const sec = h('div', { class: 'cmpsec' });
    const scaleSeg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Bitrate scale' },
      [[false, 'own scale', 'Each version\'s bars fill its lane: compare the shapes (where the hard scenes are)'], [true, 'same scale', 'One scale for every lane: compare the amounts']].map(([v, label, tip]) => h('button', {
        'aria-pressed': String(this.sameScale === v),
        'data-tip': tip,
        onclick: () => {
          this.sameScale = v;
          for (const b of scaleSeg.children) b.setAttribute('aria-pressed', String(b.textContent === label));
          this.draw();
        },
      }, label)));
    sec.append(h('div', { class: 'cmpsh' }, h('h4', { 'data-tip': CMP_TIPS.timeline }, 'Key frames and bitrate over time'), scaleSeg));
    const lanes = h('div', { class: 'lanes' });
    items.forEach((it, k) => {
      if (!it?.video) return;
      const cv = h('canvas', { class: 'lane', role: 'img', 'aria-label': `${it.name}: video bitrate over time and key frames` });
      const p = ka.per[k];
      const note = p ? (k === 0 ? plural(p.keys, 'key frame') : `${plural(p.keys, 'key frame')}${ka.versions > 1 ? `, ${fmtInt(p.alignedAll)} aligned` : ''}`) : '';
      lanes.append(h('div', { class: 'lname', title: it.name }, h('bdi', null, it.name), h('span', { class: 'dim' }, note)), cv);
      const lane = { it, k, cv };
      this.lanes.push(lane);
      cv.addEventListener('pointermove', (e) => showTip(e.clientX, e.clientY, this.laneTip(lane, e)));
      cv.addEventListener('pointerleave', hideTip);
      cv.addEventListener('click', (e) => this.setTime(this.timeAt(cv, e)));
    });
    lanes.append(h('div'), h('div', { class: 'lcap' }, h('span', null, '0'), h('span', null, 'time from each file\'s first frame · click a lane to look at that moment below'), h('span', null, fmtDuration(this.span, false))));
    sec.append(lanes);
    sec.append(this.alignVerdict(items, ka));
    return sec;
  }

  alignVerdict(items, ka) {
    const out = h('div', { class: 'verdict' });
    const others = items.map((it, k) => ({ it, k })).filter(({ it, k }) => k && it?.keyTimes?.length);
    const all = others.length === 2 ? 'both' : `all ${others.length}`;
    if (others.length >= 2 && others.every(({ it }) => it.keyTimes.length <= 1)) {
      out.append(h('div', { class: 'bad' }, h('b', null, '✕ One key frame per version'), `: each converted version has a key frame only at the start. A player could not switch between them after the first frame, and they cannot be cut into streaming segments. Streaming versions need a key frame every few seconds, at the same moments in every version (FFmpeg: -g, or -force_key_frames).`));
    } else if (others.length >= 2) {
      if (ka.aligned) {
        out.append(h('div', { class: 'ok' }, h('b', null, '✓ Key frames line up'), ` in ${all} converted versions: every key frame of each version has one at the same moment in the others, so a player can switch versions at any of them.`));
      } else {
        const worst = others.map(({ it, k }) => ({ it, p: ka.per[k] })).sort((a, b) => (b.p.keys - b.p.alignedAll) - (a.p.keys - a.p.alignedAll))[0];
        out.append(h('div', { class: 'bad' }, h('b', null, '✕ Key frames do not line up'), ` across the converted versions: ${fmtInt(worst.p.keys - worst.p.alignedAll)} of the ${plural(worst.p.keys, 'key frame')} in ${worst.it.name} have no key frame at the same moment in every other version (marked ▲). Segments cut at those points would not line up, so a player could not switch versions there cleanly. Encoding every version with the same fixed GOP and no scene-cut key frames fixes it.`));
      }
      const fit = segmentFit(items, 0);
      if (fit.length && fit.some((f) => f.bounds)) {
        out.append(h('div', { class: 'segfit' }, h('span', { class: 'dim', 'data-tip': 'HLS and DASH cut every version into segments that start with a key frame. A segment length works when every version has a key frame at every segment boundary.' }, 'segment lengths that work:'),
          fit.filter((f) => f.bounds).map((f) => h('span', {
            class: `chip ${f.missing ? 'no' : 'ok'}`,
            'data-tip': f.missing ? `${f.len} s segments: ${fmtInt(f.missing)} of ${plural(f.bounds, 'boundary', 'boundaries')} have no key frame in some version (the first at ${fmtDuration(f.first, false)}).` : `${f.len} s segments: every version has a key frame at all ${plural(f.bounds, 'boundary', 'boundaries')}.`,
          }, `${f.len} s ${f.missing ? '✕' : '✓'}`))));
      }
    } else if (others.length === 1 && items[0]?.keyTimes?.length) {
      const { it, k } = others[0];
      const p = ka.per[k];
      out.append(h('div', { class: 'info' }, `${fmtInt(p.withRef)} of the ${plural(p.keys, 'key frame')} in ${it.name} are at a moment where the reference has a key frame too. For streaming, what matters is that the converted versions line up with each other: add more versions to check.`));
    }
    return out;
  }

  timeAt(cv, e) {
    const r = cv.getBoundingClientRect();
    return Math.max(0, Math.min(this.span, ((e.clientX - r.left) / r.width) * this.span));
  }

  laneTip(lane, e) {
    const { it, cv } = lane;
    const t = this.timeAt(cv, e);
    const bin = lane.bin ?? 1;
    const b = Math.floor(t / bin);
    const lines = [it.name, `${fmtDuration(b * bin, false)} – ${fmtDuration((b + 1) * bin, false)}: ${fmtBitrate((lane.bits?.[b] ?? 0) / bin)}`];
    const tol = Math.max(this.ka.tol, (this.span / cv.clientWidth) * 3);
    for (const kt of it.keyTimes) {
      if (Math.abs(kt - t) <= tol) {
        lines.push(`key frame at ${fmtDuration(kt)}`);
        break;
      }
    }
    const i = frameAtTime(it, t);
    if (i >= 0) {
      const f = frameFacts(it, i);
      lines.push(`frame shown at ${fmtDuration(t)}: ${f.known ? frameLabel(it.ft.family, f.type, f.flags) : 'frame'}, ${humanBytes(f.size)}`);
    }
    lines.push('click to look at this moment in the microscope');
    return lines.join('\n');
  }

  // ------------------------------------------------------------ microscope

  scope(items) {
    const ref = items.find((it) => it?.video);
    this.scopeRef = ref;
    const step = ref.fps ? 1 / ref.fps : 0.04;
    this.t = Math.min(this.t, this.span);
    this.slider = h('input', { type: 'range', min: '0', max: String(this.span), step: String(step), value: String(this.t), 'aria-label': 'Moment to look at, in seconds', oninput: (e) => this.setTime(Number(e.target.value), { fromSlider: true }) });
    this.tOut = h('b', { class: 'mst' });
    const btn = (label, tip, fn) => h('button', { class: 'btn', 'data-tip': tip, onclick: fn }, label);
    const ctl = h('div', { class: 'msctl' },
      btn('◀ key', `Previous key frame of ${ref.name}`, () => this.stepKey(-1)),
      btn('◀ frame', `Previous frame of ${ref.name}`, () => this.stepFrame(-1)),
      this.slider,
      btn('frame ▶', `Next frame of ${ref.name}`, () => this.stepFrame(1)),
      btn('key ▶', `Next key frame of ${ref.name}`, () => this.stepKey(1)),
      this.tOut);
    this.scopeCards = h('div', { class: 'mscards' });
    const sec = h('div', { class: 'cmpsec' }, h('h4', { 'data-tip': CMP_TIPS.scope }, 'Microscope: the frame each version shows at one moment'), ctl, this.scopeCards);
    this.renderScope();
    return sec;
  }

  setTime(t, { fromSlider = false } = {}) {
    this.t = Math.max(0, Math.min(this.span, t));
    if (!fromSlider && this.slider) this.slider.value = String(this.t);
    this.renderScope();
    this.draw();
  }

  stepFrame(dir) {
    const it = this.scopeRef;
    const k = it.rank[frameAtTime(it, this.t)];
    const j = Math.max(0, Math.min(it.times.length - 1, k + dir));
    this.setTime(it.times[j]);
  }

  stepKey(dir) {
    const kt = this.scopeRef.keyTimes;
    const eps = 1e-6;
    let next = null;
    if (dir > 0) next = kt.find((x) => x > this.t + eps) ?? null;
    else for (let j = kt.length - 1; j >= 0; j--) if (kt[j] < this.t - eps) { next = kt[j]; break; }
    if (next !== null) this.setTime(next);
  }

  renderScope() {
    const items = this.items;
    const cards = this.scopeCards;
    if (!cards) return;
    clear(cards);
    this.tOut.textContent = fmtDuration(this.t);
    const ref = items[0];
    const refFrame = ref?.video ? frameFacts(ref, frameAtTime(ref, this.t)) : null;
    items.forEach((it, k) => {
      if (!it?.video) return;
      const i = frameAtTime(it, this.t);
      const f = frameFacts(it, i);
      const fam = it.ft.family;
      const last = it.times[it.times.length - 1];
      const ended = this.t > last + (it.fps ? 1 / it.fps : 0.05);
      const label = f.known ? frameLabel(fam, f.type, f.flags) : 'frame (type not read)';
      const letter = f.known ? (it.ft.letter(i) || '?') : '·';
      const card = h('div', { class: `mscard${k === 0 ? ' ref' : ''}${ended ? ' ended' : ''}` },
        h('div', { class: 'cch' }, h('b', { class: 'cn', title: it.name }, h('bdi', null, it.name)), h('span', { class: 'dim' }, it.size ? `${it.size.width}×${it.size.height}` : '')),
        ended ? h('div', { class: 'msend', 'data-tip': 'This version is shorter than the moment you are looking at: it shows nothing any more. Below is its last frame.' }, `ended at ${fmtDuration(last)}: its last frame`) : null,
        h('div', { class: 'msty', 'data-tip': f.known ? explainFrame(fam, f.type, f.flags) : 'The frame type of this file was not read.' },
          h('span', { class: `fl ${chipClass(f.type, f.flags)}${f.key ? ' key' : ''}` }, letter), label, f.key ? h('span', { class: 'dim' }, ' · key frame') : null));
      const kv = h('dl', { class: 'kv' });
      const row = (k2, v, tip) => kv.append(h('dt', { 'data-tip': tip }, k2), h('dd', null, v));
      row('shown at', `${fmtDuration(f.time)} · frame ${fmtInt(f.display + 1)} of ${fmtInt(it.times.length)}`, 'When this frame appears on screen, from the first frame of the file, and its place in display order.');
      row('stored', `#${fmtInt(f.i + 1)} in decoding order${f.i !== f.display ? ` (${f.i > f.display ? `${fmtInt(f.i - f.display)} later` : `${fmtInt(f.display - f.i)} earlier`} than shown)` : ''}`, 'Frames are stored in decoding order. With B-frames, a frame the others refer to is stored before the B-frames that are shown ahead of it.');
      const vsRef = k && refFrame ? ` · ${times(f.size / Math.max(1, refFrame.size))} the reference's` : '';
      row('size', `${humanBytes(f.size)} · ${times(f.vsAverage)} this file's average${vsRef}`, 'The bytes of this one frame, compared with the average frame of the same file and with the frame the reference shows at this moment.');
      if (f.gop) {
        row('GOP', `${fmtInt(f.gopIndex + 1)} of ${fmtInt(it.frames.gops.length)} · ${plural(f.gop.frames, 'frame')}`, 'The group of pictures this frame belongs to: from one key frame to the next.');
        row('to show it', f.key ? 'decode it on its own' : `decode ${plural(f.decodeFrom, 'frame')}, from the key frame ${secs(Math.max(0, f.sinceKey))} earlier`, 'A player that seeks here starts at the key frame before it and decodes every frame up to this one (in decoding order). Long GOPs make seeking slower.');
      }
      card.append(kv);
      const strip = h('div', { class: 'fgchips msstrip', 'aria-label': 'Frames around this one, in display order' });
      for (const { i: j, k: kk } of framesAround(it, f.display, 8, 8)) {
        const known = !!it.ft.have[j];
        const ty = known ? it.ft.type[j] : 0;
        const fl = known ? it.ft.flags[j] : 0;
        const key = !it.video.samples.key || !!it.video.samples.key[j];
        strip.append(h('span', {
          class: `fl ${chipClass(ty, fl)}${key ? ' key' : ''}${j === i ? ' sel' : ''}`,
          'data-tip': `${known ? frameLabel(it.ft.family, ty, fl) : 'frame'} · ${humanBytes(it.video.samples.sizes[j])}\nshown at ${fmtDuration(it.times[kk])}\nclick to look at this moment`,
          onclick: () => this.setTime(it.times[kk]),
        }, known ? it.ft.letter(j) || '?' : '·'));
      }
      card.append(strip, h('div', { class: 'cca' },
        h('button', { class: 'chip', onclick: () => this.app.inspectCompared(it.entry, it.doc, { track: it.video, sample: i }), 'data-tip': 'Open this frame in the byte viewer: its bytes, its NAL units or OBUs, and the Frames view' }, 'inspect this frame')));
      cards.append(card);
    });
  }

  // ------------------------------------------------------------ drawing

  draw() {
    if (!this.lanes.length) return;
    const css = getComputedStyle(document.documentElement);
    const col = (n) => css.getPropertyValue(n).trim();
    const colors = { bar: col('--br-1'), key: col('--viz-key'), odd: col('--bad'), base: col('--viz-base'), cursor: col('--text'), text: col('--text-3'), bg: col('--bg') };
    const font = `10.5px ${col('--mono') || 'monospace'}`;
    let shared = 0;
    for (const lane of this.lanes) {
      const w = lane.cv.clientWidth;
      if (!w) continue;
      const bin = sliceFor(this.span, Math.max(10, Math.floor(w / 5)));
      if (lane.bin !== bin) {
        lane.bin = bin;
        lane.bits = bitsOverTime(lane.it, bin, Math.max(1, Math.ceil(this.span / bin)));
      }
      let m = 0;
      for (const b of lane.bits) m = Math.max(m, b);
      lane.max = m;
      shared = Math.max(shared, m);
    }
    for (const lane of this.lanes) {
      const { cv, it, k } = lane;
      const w = cv.clientWidth;
      if (!w || !lane.bits) continue;
      const dpr = window.devicePixelRatio || 1;
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(LANE_H * dpr);
      const g = cv.getContext('2d');
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      const top = 12;
      const base = LANE_H - 1;
      const max = (this.sameScale ? shared : lane.max) || 1;
      const x = (t) => (t / this.span) * w;
      g.fillStyle = colors.base;
      g.fillRect(0, base, w, 1);
      // Bitrate bars.
      const bw = Math.max(1, x(lane.bin) - (x(lane.bin) >= 4 ? 1 : 0));
      g.fillStyle = colors.bar;
      g.globalAlpha = 0.8;
      lane.bits.forEach((bits, b) => {
        const hh = ((base - top) * bits) / max;
        if (hh > 0) g.fillRect(x(b * lane.bin), base - hh, bw, hh);
      });
      g.globalAlpha = 1;
      // Key frames: a line each; ones with no match in some other version get a marker.
      const odd = this.ka?.per[k]?.odd;
      it.keyTimes.forEach((kt, j) => {
        const px = Math.round(x(kt)) + 0.5;
        const bad = odd?.[j];
        g.fillStyle = bad ? colors.odd : colors.key;
        g.fillRect(px - (bad ? 1 : 0.5), top - 4, bad ? 2 : 1, base - top + 4);
        if (bad) {
          g.beginPath();
          g.moveTo(px - 4, 7);
          g.lineTo(px + 4, 7);
          g.lineTo(px, 0);
          g.closePath();
          g.fill();
        }
      });
      // The moment the microscope looks at.
      g.fillStyle = colors.cursor;
      g.fillRect(Math.round(x(this.t)), 0, 1, LANE_H);
      // The scale, on a patch of background so that key frame markers cannot hide it.
      const label = `top ${fmtBitrate(max / lane.bin)}`;
      g.font = font;
      const tw = g.measureText(label).width;
      g.fillStyle = colors.bg;
      g.fillRect(w - tw - 6, 0, tw + 6, 12);
      g.fillStyle = colors.text;
      g.textBaseline = 'top';
      g.textAlign = 'right';
      g.fillText(label, w - 2, 0);
    }
  }
}

/** "×0.45", "×12", "×0.0039": a ratio with enough digits to be told apart from zero. */
function times(r) {
  if (!Number.isFinite(r)) return '×?';
  if (r >= 10) return `×${fmtNum(r, 0)}`;
  if (r >= 0.1) return `×${fmtNum(r, 2)}`;
  return `×${r ? r.toPrecision(2) : 0}`;
}

const secs = (x) => `${fmtNum(x, x < 10 ? 2 : 1)} s`;

/** A paragraph of Learn text; lines starting with "ffmpeg" become code. */
function prose(text) {
  const out = h('div', { class: 'prose' });
  for (const line of text.split('\n')) out.append(/^ffmpeg /.test(line) ? h('pre', { class: 'cmd' }, line) : h('p', null, line));
  return out;
}

// ------------------------------------------------------------ picking files

/**
 * The dialog for choosing what to compare: the reference and its versions. Suggests groups of
 * files whose names differ only in version words (1080p, 5MB, low...).
 */
export function openComparePicker(app) {
  const s = app.store.get();
  const cur = s.compare;
  const chosen = new Set(cur?.keys ?? (s.current ? [s.current.key] : []));
  let ref = cur?.ref ?? s.current?.key ?? null;
  let filter = '';
  const overlay = h('div', { class: 'help cmppick', onclick: (e) => { if (e.target === overlay) close(); } });
  const box = h('div', { role: 'dialog', 'aria-label': 'Choose files to compare' });
  overlay.append(box);
  const localPick = h('input', { type: 'file', multiple: true, hidden: true });
  localPick.addEventListener('change', () => {
    if (!localPick.files?.length) return;
    for (const e of app.addLocalFiles(localPick.files, { open: false })) chosen.add(e.key);
    localPick.value = '';
    render();
  });

  function close() {
    overlay.remove();
    window.removeEventListener('keydown', onKey, true);
  }
  function onKey(e) {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  }
  window.addEventListener('keydown', onKey, true);

  let listScroll = 0;
  function render() {
    const files = app.store.get().files;
    const typing = document.activeElement?.classList.contains('pfilter');
    if (ref && !chosen.has(ref)) ref = null;
    if (!ref && chosen.size) {
      // The biggest file is most likely the source.
      ref = [...chosen].map((k) => files.find((f) => f.key === k)).filter(Boolean).sort((a, b) => b.size - a.size)[0]?.key ?? null;
    }
    clear(box);
    box.append(h('h3', null, 'Compare versions of a video'),
      h('p', { class: 'prose' }, 'Tick the source and the versions converted from it. The reference (●) is the file the others are compared with, usually the source.'));
    // Files in one folder whose names differ only in version words (720p, 5MB...).
    const groups = new Map();
    for (const f of files) {
      const id = `${f.dir ?? ''}\u0000${contentStem(f.name)}`;
      if (!groups.has(id)) groups.set(id, []);
      groups.get(id).push(f);
    }
    const mine = (list) => (list.some((f) => f.key === s.current?.key) ? 1 : 0);
    const sugg = [...groups.values()].filter((list) => list.length >= 2 && list.length <= 16)
      .sort((a, b) => mine(b) - mine(a) || b.length - a.length)
      .slice(0, 8);
    if (sugg.length) {
      box.append(h('div', { class: 'psugg' }, h('span', { class: 'dim' }, 'Look like versions of one video:'),
        sugg.map((list) => h('button', {
          class: 'chip',
          'data-tip': `${list[0].dir ?? ''}\n${list.map((f) => f.name).join('\n')}`,
          onclick: () => {
            chosen.clear();
            for (const f of list) chosen.add(f.key);
            ref = null;
            render();
          },
        }, `${contentStem(list[0].name)}${list[0].dir ? ` · ${list[0].dir.split('/').pop()}` : ''} (${list.length})`))));
    }
    const search = h('input', { type: 'search', class: 'pfilter', placeholder: 'filter files', value: filter, 'aria-label': 'Filter files by name' });
    search.addEventListener('input', () => {
      filter = search.value;
      renderList();
    });
    const list = h('div', { class: 'plist', role: 'list', onscroll: () => { listScroll = list.scrollTop; } });
    function renderList() {
      clear(list);
      const q = filter.trim().toLowerCase();
      // The chosen files first, then every other file by folder.
      const picked = [...chosen].map((k) => files.find((f) => f.key === k)).filter(Boolean);
      if (picked.length) list.append(h('div', { class: 'fdir chosen' }, 'chosen'));
      picked.forEach((f) => list.append(fileRow(f, true)));
      let dir = null;
      for (const f of files) {
        if (chosen.has(f.key) || (q && !f.name.toLowerCase().includes(q))) continue;
        if ((f.dir ?? '') !== dir) {
          dir = f.dir ?? '';
          if (dir) list.append(h('div', { class: 'fdir', title: dir }, h('bdi', null, dir)));
        }
        list.append(fileRow(f, false));
      }
      if (!list.children.length) list.append(h('div', { class: 'empty-state' }, files.length ? 'No file matches.' : 'No files yet: add some from this computer.'));
    }
    function fileRow(f, on) {
      return h('div', { class: `prow${on ? ' on' : ''}`, role: 'listitem' },
        h('label', { class: 'pn' }, h('input', {
          type: 'checkbox',
          checked: on ? '' : null,
          onchange: (e) => {
            if (e.target.checked) chosen.add(f.key);
            else chosen.delete(f.key);
            render();
          },
        }), h('span', { title: `${f.dir ? `${f.dir}/` : ''}${f.name}` }, f.name)),
        h('span', { class: 's' }, humanSize(f.size)),
        on ? h('button', {
          class: `pref${ref === f.key ? ' on' : ''}`,
          'aria-pressed': String(ref === f.key),
          'data-tip': ref === f.key ? 'The reference: the others are compared with it' : 'Make this the reference',
          onclick: () => {
            ref = f.key;
            render();
          },
        }, ref === f.key ? '● reference' : '○ reference') : h('span'));
    }
    renderList();
    const go = h('button', {
      class: 'btn primary',
      disabled: chosen.size < 2 ? '' : null,
      title: chosen.size < 2 ? 'Choose at least two files' : null,
      onclick: () => {
        const keys = [...chosen].filter((k) => files.some((f) => f.key === k));
        if (!keys.length) return;
        close();
        app.openCompare(keys, ref && keys.includes(ref) ? ref : keys[0]);
      },
    }, chosen.size >= 2 ? `Compare ${chosen.size} files` : 'Compare');
    box.append(search, list, h('div', { class: 'pfoot' },
      h('button', { class: 'btn', onclick: () => localPick.click(), 'data-tip': 'Add video files from this computer. They are read in your browser, never uploaded.' }, '+ files from this computer…'),
      h('span', { class: 'dim' }, `${chosen.size} chosen`),
      h('button', { class: 'btn', onclick: close }, 'Cancel'), go), localPick);
    list.scrollTop = listScroll;
    if (typing) search.focus();
  }
  render();
  document.body.append(overlay);
  box.querySelector('.pfilter')?.focus();
}
