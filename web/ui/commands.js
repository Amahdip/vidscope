// COMMANDS tab: the best-known ffprobe, ffplay and ffmpeg commands, explained token by token and
// filled in for the open file and the current selection (track, frame).

import { h, clear, copyText, icon } from './dom.js';
import { loadPref, savePref } from './store.js';
import { GROUPS, COMMANDS, TERMS, buildContext, renderEntry, contextSummary, commandById } from '../core/commands.js';

const TOOL_TIP = {
  ffprobe: 'ffprobe: inspects a file and prints what FFmpeg finds in it. It never changes the file.',
  ffplay: 'ffplay: FFmpeg’s minimal player, controlled with the keyboard.',
  ffmpeg: 'ffmpeg: converts, re-encodes, repackages or measures; it always writes a new file.',
};

// One regex for every glossary term, longest first ("stream specifier" before "stream").
const TERM_LIST = [...TERMS].sort((a, b) => b[0].length - a[0].length);
const TERM_RE = new RegExp(`\\b(${TERM_LIST.map(([t]) => t.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')).join('|')})(e?s)?\\b`, 'gi');

/** The explanation of a term, if this match is one (acronyms match only in capitals). */
function termTip(match) {
  const lower = match.toLowerCase();
  for (const [t, tip] of TERM_LIST) {
    if (t.toLowerCase() !== lower) continue;
    if (t === t.toUpperCase() && match !== t) return null;
    return tip;
  }
  return null;
}

/** A tip without the token repeated at its start ("error: print only errors" -> "Print only errors"). */
function tipBody(tok) {
  const plain = tok.t.replace(/^["']+|["']+$/g, '');
  const name = plain.replace(/^[,;:]+|[=:,]+$/g, '');
  for (const p of [tok.t, plain, name]) {
    if (p && tok.tip.startsWith(`${p}: `)) {
      const rest = tok.tip.slice(p.length + 2);
      // Capitalise ordinary words, not names such as x264 or yuv420p.
      return /^[a-z]+\b(?![\d-])/.test(rest) ? rest.charAt(0).toUpperCase() + rest.slice(1) : rest;
    }
  }
  return tok.tip;
}

export class CommandsView {
  constructor(el, app) {
    this.el = el;
    this.app = app;
    this.query = '';
    this.encoder = loadPref('cmdEncoder', 'x264');
    this.showAll = false;
    this.open = new Set(); // open <details>, by key, kept across re-renders
    this.tab = app.store.get().rightTab;
    this.leaving = false;
    app.store.subscribe((s, ch) => {
      if (ch.has('rightTab')) {
        const prev = this.tab;
        this.tab = s.rightTab;
        // Selecting a track or a frame switches the right pane to the Inspector; while this tab is
        // open, stay here instead so the commands follow the selection.
        if (prev === 'commands' && s.rightTab === 'inspector' && ch.has('sel') && !this.leaving) {
          app.store.set({ rightTab: 'commands' });
          return;
        }
      }
      if (ch.has('doc')) {
        this.showAll = false;
        this.el.scrollTop = 0;
      }
      // The right pane renders this tab when it is shown; here, only changes while it is open.
      if (s.rightTab === 'commands' && !ch.has('rightTab') && ['doc', 'sel', 'samplesReady', 'docVersion', 'mode', 'current'].some((k) => ch.has(k))) this.render();
    });
  }

  /** Run an app action that should leave this tab (a link to another view). */
  async leave(fn) {
    this.leaving = true;
    try {
      await fn();
    } finally {
      this.leaving = false;
    }
  }

  context() {
    const s = this.app.store.get();
    return buildContext({ doc: s.doc, entry: s.current, sel: s.sel, encoder: this.encoder });
  }

  render({ force = false } = {}) {
    const s = this.app.store.get();
    // One render per state: a selection can reach this view twice (through the store and the pane).
    if (s === this.rendered && !force) return;
    this.rendered = s;
    const scroll = this.el.scrollTop;
    const focused = document.activeElement === this.search;
    clear(this.el);
    if (!s.doc) return;
    const c = this.context();
    const mode = s.mode;
    const wrap = h('div', { class: 'cmds' });
    wrap.append(this.contextBar(c));
    wrap.append(this.toolbar());
    if (mode !== 'raw') wrap.append(this.primer(mode));

    const q = this.query.trim().toLowerCase();
    if (q) {
      const words = q.split(/\s+/);
      const hits = COMMANDS.filter((e) => {
        const r = renderEntry(e, c);
        const hay = [e.title, e.purpose, e.when, e.tags ?? '', r.text, ...r.look].join(' ').toLowerCase();
        return words.every((w) => hay.includes(w));
      });
      wrap.append(h('div', { class: 'gcount' }, `${hits.length} command${hits.length === 1 ? '' : 's'} match “${this.query.trim()}”`));
      for (const e of hits) wrap.append(this.card(e, c, mode));
      if (!hits.length) wrap.append(h('div', { class: 'empty-state' }, 'No command matches. Try words like keyframes, hls, loudness, bitrate or rotate.'));
    } else if (mode === 'beginner' && !this.showAll) {
      wrap.append(h('h4', null, 'Start here'));
      wrap.append(h('p', { class: 'prose' }, 'A few essential commands, explained step by step: what each part does, and what you will see when you run it.'));
      for (const e of COMMANDS.filter((x) => x.essential)) wrap.append(this.card(e, c, mode, { expand: true }));
      wrap.append(h('div', { class: 'acts cmore' }, h('button', { class: 'btn', onclick: () => { this.showAll = true; this.render({ force: true }); } }, `Show all ${COMMANDS.length} commands`)));
    } else {
      for (const g of GROUPS) {
        const list = COMMANDS.filter((e) => e.group === g.id);
        // Commands that do not apply to this file (video commands for a WAV…) go last, folded.
        const na = list.filter((e) => e.applies?.(c));
        wrap.append(h('h4', { class: 'cgroup' }, h('span', null, g.title), h('span', { class: 'count' }, String(list.length))));
        wrap.append(h('p', { class: 'prose' }, this.rich(g.intro)));
        if (g.id === 'fix' && mode !== 'raw') wrap.append(this.encoderSwitch());
        for (const e of list) if (!na.includes(e)) wrap.append(this.card(e, c, mode));
        if (na.length) {
          wrap.append(this.details(`na:${g.id}`, false, 'csect cna',
            h('summary', null, `Not for this file`, h('span', { class: 'count' }, String(na.length))),
            na.map((e) => this.card(e, c, mode))));
        }
      }
    }
    this.el.append(wrap);
    this.el.scrollTop = scroll;
    if (focused) {
      this.search.focus();
      this.search.setSelectionRange(this.search.value.length, this.search.value.length);
    }
  }

  // ------------------------------------------------------------ top of the tab

  contextBar(c) {
    const bar = h('div', { class: 'cmd-ctx' }, h('span', { class: 'cxl' }, 'Filled in:'));
    for (const it of contextSummary(c)) {
      bar.append(h('span', { class: `cx${it.missing ? ' miss' : ''}`, 'data-tip': it.tip }, h('b', null, it.label), ' ', it.value));
    }
    return bar;
  }

  toolbar() {
    this.search = h('input', {
      type: 'search',
      value: this.query,
      placeholder: 'Search commands: keyframes, hls, loudness, rotate…',
      'aria-label': 'Search the commands',
      oninput: () => {
        this.query = this.search.value;
        this.render({ force: true });
      },
    });
    return h('div', { class: 'cmd-tools' }, this.search);
  }

  encoderSwitch() {
    const opts = [['x264', 'H.264 · libx264', 'Encode with x264 (H.264): plays everywhere.'], ['x265', 'HEVC · libx265', 'Encode with x265 (HEVC): smaller files at the same quality; slower, and not every device plays it.']];
    return h('div', { class: 'cenc' },
      h('span', { class: 'cxl' }, 'Encoder for the encoding commands:'),
      h('div', { class: 'seg', role: 'group', 'aria-label': 'Encoder' }, opts.map(([id, label, tip]) => h('button', {
        'aria-pressed': String(this.encoder === id),
        'data-tip': tip,
        onclick: () => {
          this.encoder = id;
          savePref('cmdEncoder', id);
          this.render({ force: true });
        },
      }, label))));
  }

  primer(mode) {
    const det = this.details('primer', mode === 'beginner', 'cprimer',
      h('summary', null, 'How to read these commands'),
      h('p', { class: 'prose' }, 'Copy a command and paste it into a terminal (Terminal on macOS). FFmpeg’s three programs must be installed: ffprobe inspects, ffplay plays, ffmpeg converts.'),
      h('p', { class: 'prose' }, 'Order matters: ffmpeg [options for the input] -i input [options for the output] output. An option applies to the next input or output written after it.'),
      h('p', { class: 'prose' }, this.rich('Streams are named with stream specifiers: v:0 is the first video stream, a:1 the second audio stream; in -map 0:v:0 the leading 0 is the input.')),
      h('p', { class: 'prose' }, 'Hover over any part of a command to see what it does. ', h('span', { class: 'tok ctx' }, 'Underlined'), ' parts come from the open file and your selection; ', h('span', { class: 'tok ph' }, 'PLACEHOLDERS'), ' are for you to fill in.'),
      h('p', { class: 'prose' }, 'Select a track (Tracks tab) or a frame (its frame list, or a byte inside it in the hex view) and the commands follow; the Inspector tab still shows what you selected.'),
      h('p', { class: 'prose' }, 'Commands that write files put them in the folder you run them in. The open file is never changed.'));
    return det;
  }

  /** A <details> whose open state, once the reader changes it, survives re-renders. */
  details(key, openByDefault, cls, summary, ...children) {
    const open = this.open.has(key) || (openByDefault && !this.open.has(`!${key}`));
    const det = h('details', { class: cls, open }, summary, ...children);
    summary.addEventListener('click', () => {
      // The click toggles it after this handler: record the state it is going to.
      const opening = !det.open;
      this.open.delete(opening ? `!${key}` : key);
      this.open.add(opening ? key : `!${key}`);
    });
    return det;
  }

  // ------------------------------------------------------------ one command

  card(e, c, mode, { expand = false } = {}) {
    const r = renderEntry(e, c);
    const seen = new Set(); // glossary terms already explained in this card
    const card = h('div', { class: `ccard${r.reason ? ' na' : ''}`, id: `cmd-${e.id}` });
    const head = h('div', { class: 'ch' },
      h('span', { class: 'ct' }, e.title),
      e.essential && mode !== 'beginner' ? h('span', { class: 'chip ess', 'data-tip': 'One of the essential commands Beginner mode starts with.' }, 'essential') : null,
      h('span', { class: 'chip tool', 'data-tip': TOOL_TIP[e.tool] }, e.tool));
    for (const n of r.needs) {
      if (!n.filter) continue;
      head.append(h('span', { class: 'chip need', 'data-tip': `${n.why ?? ''} Check yours with: ffmpeg -hide_banner -filters | grep ${n.filter}` }, `needs ${n.filter}${n.build ? ` (${n.build})` : ''}`));
    }
    card.append(head);
    card.append(h('p', { class: 'prose cp' }, this.rich(e.purpose, seen)));
    if (r.reason) card.append(h('div', { class: 'cnote' }, this.rich(r.reason, seen)));
    if (e.uses) card.append(h('div', { class: 'cnote uses' }, 'Uses the file made by ', this.ref(e.uses), ': run that one first.'));

    r.lines.forEach((l, li) => {
      if (l.note) card.append(h('div', { class: 'cstep' }, l.note));
      const pre = h('pre', { class: 'code cline', 'aria-label': `Command: ${l.text}` });
      l.tokens.forEach((x, ti) => {
        if (ti && !x.glue) pre.append(' ');
        const next = l.tokens[ti + 1];
        const kind = tokKind(x, next);
        // Short words never break inside (-show_entries would otherwise wrap after its dash).
        const nw = !x.glue && !next?.glue && x.t.length <= 40 ? ' nw' : '';
        pre.append(h('span', { class: `tok${kind ? ` ${kind}` : ''}${nw}${x.ph ? ' ph' : ''}${x.ctx ? ' ctx' : ''}`, 'data-i': `${li}.${ti}`, 'data-tip': x.tip }, x.t));
      });
      card.append(h('div', { class: 'ccode' }, pre,
        h('button', { class: 'btn copy', 'data-tip': 'Copy this command', 'aria-label': 'Copy this command', onclick: () => copyText(l.text) }, icon('copy'))));
    });

    // What each part does: one row per token, highlighted together with the token on hover.
    const parts = this.details(`${e.id}:parts`, expand, 'csect cparts', h('summary', null, 'What each part does', h('span', { class: 'count' }, String(r.lines.reduce((n, l) => n + l.tokens.length, 0)))));
    r.lines.forEach((l, li) => {
      if (r.lines.length > 1) parts.append(h('div', { class: 'pstep' }, `Step ${li + 1}`));
      l.tokens.forEach((x, ti) => {
        parts.append(h('div', { class: `prow${x.glue ? ' piece' : ''}`, 'data-i': `${li}.${ti}` },
          h('code', { class: `${x.ph ? 'ph' : ''}${x.ctx ? ' ctx' : ''}` }, x.t),
          h('span', null, this.rich(tipBody(x), seen))));
      });
    });
    card.append(parts);

    const look = this.details(`${e.id}:look`, expand, 'csect clook', h('summary', null, 'When to use it · what to look for'));
    look.append(h('p', { class: 'prose' }, this.rich(e.when, seen)));
    if (r.look.length) look.append(h('ul', { class: 'clist' }, r.look.map((t) => h('li', null, this.rich(t, seen)))));
    card.append(look);

    if (e.output) card.append(this.output(e, expand, seen));

    const acts = h('div', { class: 'acts' });
    const target = this.viewTarget(e, c);
    acts.append(h('button', { class: 'chip view', disabled: !target, 'data-tip': target ? 'Open this view in Vidscope' : 'Not available for this file', onclick: () => this.go(e, c) }, `→ ${e.view.label}`));
    card.append(acts);

    // Hovering a token lights up its explanation, and the other way round.
    const light = (i, on) => {
      for (const n of card.querySelectorAll(`[data-i="${i}"]`)) n.classList.toggle('hl', on);
    };
    card.addEventListener('mouseover', (ev) => {
      const t = ev.target.closest?.('[data-i]');
      if (t && card.contains(t)) light(t.dataset.i, true);
    });
    card.addEventListener('mouseout', (ev) => {
      const t = ev.target.closest?.('[data-i]');
      if (t && card.contains(t)) light(t.dataset.i, false);
    });
    return card;
  }

  /** "What you'll see": an example output, its notable parts explained on hover. */
  output(e, expand, seen) {
    const o = e.output;
    const det = this.details(`${e.id}:out`, expand, 'csect cout', h('summary', null, 'What you will see'));
    if (o.title) det.append(h('div', { class: 'cotitle' }, o.title));
    if (o.text) det.append(h('p', { class: 'prose' }, this.rich(o.text, seen)));
    if (o.lines?.length) {
      const pre = h('pre', { class: 'code cexample' });
      for (const line of o.lines) {
        pre.append(...markLine(line, o.marks ?? []), '\n');
      }
      det.append(pre);
      if (o.marks?.length) det.append(h('div', { class: 'spec' }, 'Hover over the highlighted parts for what they mean.'));
    }
    return det;
  }

  // ------------------------------------------------------------ text with links

  /** A command's title as a link that scrolls to its card. */
  ref(id) {
    const e = commandById(id);
    return h('a', { class: 'cref', href: `#cmd-${id}`, onclick: (ev) => { ev.preventDefault(); this.jump(id); } }, e?.title ?? id);
  }

  /** Prose with [[id]] references as links and the first mention of each glossary term explained on hover. */
  rich(text, seen = new Set()) {
    const out = [];
    for (const part of String(text).split(/(\[\[[\w-]+\]\])/)) {
      const m = /^\[\[([\w-]+)\]\]$/.exec(part);
      if (m) {
        out.push(this.ref(m[1]));
        continue;
      }
      let last = 0;
      for (const hit of part.matchAll(TERM_RE)) {
        const tip = termTip(hit[1]);
        const key = hit[1].toLowerCase();
        if (!tip || seen.has(key)) continue;
        seen.add(key);
        if (hit.index > last) out.push(part.slice(last, hit.index));
        out.push(h('span', { class: 'term', 'data-tip': tip }, hit[0]));
        last = hit.index + hit[0].length;
      }
      if (last < part.length) out.push(part.slice(last));
    }
    return out;
  }

  /** Scroll to a command's card (showing the whole catalogue if needed) and flash it. */
  jump(id) {
    const find = () => this.el.querySelector(`#cmd-${CSS.escape(id)}`);
    if (!find()) {
      this.query = '';
      this.showAll = true;
      this.render({ force: true });
    }
    const card = find();
    if (!card) return;
    card.scrollIntoView({ block: 'start', behavior: 'smooth' });
    card.classList.remove('flash');
    void card.offsetWidth;
    card.classList.add('flash');
  }

  // ------------------------------------------------------------ links to the other views

  /** The track a view link is about. */
  viewTrack(e, c) {
    const v = e.view;
    const s = v.track === 'video' ? c.video : v.track === 'audio' ? c.audio : v.track === 'subtitle' ? c.subtitle : c.stream;
    return s?.track ?? null;
  }

  viewTarget(e, c) {
    const doc = this.app.store.get().doc;
    const v = e.view;
    if (v.to === 'tracks') return this.viewTrack(e, c) ?? (doc.tracks.length ? doc.tracks[0] : null);
    if (v.to === 'frame') return this.viewTrack(e, c)?.samples?.count ? true : null;
    if (v.to === 'node') return doc.root.find(v.type);
    return true;
  }

  go(e, c) {
    const app = this.app;
    const doc = app.store.get().doc;
    const v = e.view;
    const track = this.viewTrack(e, c);
    if (v.to === 'tracks') {
      const tv = app.left?.tracks;
      const i = doc.tracks.indexOf(track ?? doc.tracks[0]);
      if (tv?.open && i >= 0) tv.open.add(i);
      if (app.store.get().leftTab === 'tracks') tv?.render();
      else app.store.set({ leftTab: 'tracks' });
    } else if (v.to === 'frame' && track?.samples?.count) {
      // The selected frame when it belongs to this track, else (or when the command reads the first packet) the first one.
      const i = v.sample !== 'first' && c.frame?.track === track ? c.frame.i : 0;
      this.leave(() => app.selectSample(track, i));
    } else if (v.to === 'node') {
      const n = doc.root.find(v.type);
      if (n) this.leave(() => app.select(n, { from: 'commands' }));
    } else if (v.to === 'structure') {
      app.store.set({ leftTab: 'structure' });
    } else if (v.to === 'insights') {
      app.store.set({ rightTab: 'insights' });
    }
  }
}

/** Colour class of a token: the program, an option, a file name, or a shell operator. */
function tokKind(x, next) {
  if (['ffmpeg', 'ffprobe', 'ffplay'].includes(x.t)) return 'k-tool';
  if (['|', '&&', '>'].includes(x.t)) return 'k-op';
  const oneWord = !x.glue && !next?.glue;
  if (oneWord && ['input', 'input2', 'output'].includes(x.role)) return 'k-file';
  if (oneWord && /^-[a-zA-Z]/.test(x.t)) return 'k-flag';
  return '';
}

/** A line of example output with the marked substrings wrapped in hoverable spans. */
function markLine(line, marks) {
  const hits = [];
  for (const [s, tip] of marks) {
    const at = line.indexOf(s);
    if (at >= 0 && !hits.some((x) => at < x.end && at + s.length > x.at)) hits.push({ at, end: at + s.length, tip });
  }
  hits.sort((a, b) => a.at - b.at);
  const out = [];
  let pos = 0;
  for (const x of hits) {
    if (x.at > pos) out.push(line.slice(pos, x.at));
    out.push(h('span', { class: 'omark', 'data-tip': x.tip }, line.slice(x.at, x.end)));
    pos = x.end;
  }
  if (pos < line.length) out.push(line.slice(pos));
  return out;
}
