// How audit results look, wherever they come from: the Audit tab (one open file), the Compare
// view (a ladder audited in the browser) and the conversion report (a ladder audited by an
// audit server). Checks have the shape web/core/audit.js gives them.

import { h, icon, copyText, toast } from './dom.js';
import { fmtNum, fmtInt, fmtBitrate, fmtDuration, hex, plural } from '../core/util.js';
import { SPECS, allRules, tally } from '../core/audit.js';

const GLYPH = { fail: '✕', warn: '!', pass: '✓', info: 'i', skip: '–' };
const CATEGORIES = ['Container', 'Video', 'Colour', 'Audio', 'Ladder'];
const RULES = new Map(allRules().map((r) => [r.id, r]));

/** The colour class of a check: its severity when it failed, else its level. */
export function tone(c) {
  if (c.level === 'fail' || c.level === 'warn') return c.severity === 'CRITICAL' ? 'bad' : c.severity === 'INFO' ? 'info' : 'warn';
  return c.level === 'pass' ? 'good' : c.level === 'skip' ? 'skip' : 'info';
}

/** Order inside a group: critical first, then warnings, notes, passes, skips. */
function rank(c) {
  const t = tone(c);
  return { bad: 0, warn: 1, info: c.level === 'info' ? 3 : 2, good: 4, skip: 5 }[t] ?? 6;
}

/** A short, readable form of a measured or expected value. */
export function fmtValue(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return Number.isInteger(v) ? fmtInt(v) : fmtNum(v, Math.abs(v) < 10 ? 3 : 1);
  if (Array.isArray(v)) return v.map(fmtValue).join(', ');
  if (typeof v === 'object') return Object.entries(v).map(([k, x]) => `${k} ${fmtValue(x)}`).join(', ');
  return String(v);
}

/** Counts that matter for a verdict: critical and warning findings, passes, notes. */
export function counts(checks) {
  const t = tally(checks);
  return { critical: t.critical, warning: t.warning, pass: t.pass, fail: t.fail, info: checks.filter((c) => c.level === 'info').length, skip: t.skip, compliance: t.compliance, total: checks.length };
}

/**
 * The verdict at the top of a report: one sentence and the four numbers under it.
 * `subject` names what was audited ("this file", "this ladder").
 */
export function scoreboard(checks, { subject = 'this file', extra = [] } = {}) {
  const n = counts(checks);
  // Nothing judged at all (a playlist, an unknown file) is not a clean result.
  const judged = n.pass + n.warning + n.critical + n.fail + n.info;
  const state = n.critical ? 'bad' : n.warning ? 'warn' : judged ? 'good' : 'skip';
  const notRun = n.skip ? `; ${plural(n.skip, 'check')} could not run` : '';
  const verdict = n.critical
    ? `${plural(n.critical, 'critical finding')} in ${subject}`
    : n.warning ? `No critical findings in ${subject}, ${plural(n.warning, 'warning')}${notRun}`
      : judged ? (n.skip ? `Every check that ran passes in ${subject}${notRun}` : `Every check passes in ${subject}`)
        : `Nothing in ${subject} could be checked`;
  const detail = n.critical
    ? 'Viewers see or hear it, a device refuses it, or a MUST of a standard is broken. Each finding below says why and how to fix it.'
    : n.warning ? 'Nothing breaks playback; the warnings cost quality, bandwidth or compatibility.'
      : judged ? (n.skip ? 'The checks that could not run are listed under "Not checked in this run".' : 'Nothing below needs attention.')
        : (checks.find((c) => c.level === 'skip')?.text ?? 'No rule applies to this file.');
  const tile = (value, label, cls, tip) => h('div', { class: `atile ${cls ?? ''}`, 'data-tip': tip }, h('b', null, value), h('span', null, label));
  return h('div', { class: 'aboard' },
    h('div', { class: `averdict ${state}` },
      h('span', { class: 'ag' }, state === 'bad' ? '✕' : state === 'warn' ? '!' : state === 'skip' ? '–' : '✓'),
      h('div', null, h('b', null, verdict), h('span', null, detail))),
    h('div', { class: 'atiles' },
      tile(fmtInt(n.critical), 'critical', n.critical ? 'bad' : null, 'Findings that break playback on real devices, are visible or audible, or break a MUST of a standard.'),
      tile(fmtInt(n.warning), 'warnings', n.warning ? 'warn' : null, 'Findings that cost quality, bandwidth or device reach, or break a SHOULD.'),
      tile(fmtInt(n.pass), 'passed', 'good', 'Checks that hold.'),
      tile(n.compliance === null ? '–' : `${fmtNum(n.compliance * 100, 1)} %`, 'checks passed', null, 'Passed ÷ checks with a verdict (passed, warnings and failures). Information, and checks that could not run, are left out.'),
      n.skip ? tile(fmtInt(n.skip), 'not checked', null, 'Checks that apply but could not run here: a measurement that was not made (loudness, sync, fidelity to the source), or a file this audit does not read. See "Not checked in this run".') : null,
      ...extra));
}

/** One line of facts about an audited file. */
export function factsLine(f) {
  if (!f) return null;
  const v = f.video;
  const a = f.audio;
  const parts = [];
  if (v) {
    parts.push(`${v.codec ?? 'video'}${v.profile ? ` ${v.profile.replace(/ profile$/, '')}` : ''}${v.levelName ? ` L${v.levelName}` : ''}`);
    if (v.width) parts.push(`${v.width}×${v.height}`);
    if (v.fps) parts.push(`${fmtNum(v.fps, 3)} fps`);
    if (v.bitrate) parts.push(fmtBitrate(v.bitrate));
    if (v.gop) parts.push(`GOP ${fmtNum(v.gop, 2)} s`);
    if (v.colour) parts.push(`colour ${v.colour}`);
  }
  if (a) parts.push(`${a.codec}${a.sampleRate ? ` ${fmtNum(a.sampleRate / 1000, 1)} kHz` : ''}${a.channels ? ` ${a.channels === 1 ? 'mono' : a.channels === 2 ? 'stereo' : `${a.channels} ch`}` : ''}${a.bitrate ? ` ${fmtBitrate(a.bitrate)}` : ''}`);
  else if (v) parts.push('no audio');
  if (f.duration) parts.push(fmtDuration(f.duration));
  if (f.payload) parts.push(`${f.payload.gopsRead} of ${f.payload.gops} GOPs read`);
  return h('div', { class: 'afacts' }, parts.map((p, i) => [i ? h('span', { class: 'sep' }, '·') : null, h('span', null, p)]));
}

/**
 * One check: a line that opens into the explanation, what was measured against what was
 * expected, the standard and clause, the usual cause and fix, and a jump to the bytes.
 */
export function checkRow(c, { onOffset, open = false, category = false } = {}) {
  const t = tone(c);
  const spec = SPECS[c.spec];
  const failed = c.level === 'fail' || c.level === 'warn';
  const head = h('summary', { class: 'ah' },
    h('span', { class: `ag ${t}` }, GLYPH[c.level] ?? '·'),
    h('span', { class: 'at' }, c.title),
    category && c.category ? h('span', { class: 'acat' }, c.category) : null,
    failed && c.severity ? h('span', { class: `asev ${t}` }, c.severity.toLowerCase()) : null,
    h('span', { class: 'aid' }, c.id));
  const body = h('div', { class: 'ab' });
  if (c.text) body.append(h('p', null, c.text));
  const kv = [];
  if (c.value !== undefined && c.value !== null && c.value !== '') kv.push(['measured', fmtValue(c.value)]);
  if (c.expected !== undefined && c.expected !== null && c.expected !== '') kv.push(['expected', fmtValue(c.expected)]);
  if (spec) kv.push(['source', h('span', null, h('a', { href: spec.url, target: '_blank', rel: 'noopener' }, spec.name), c.clause ? h('span', { class: 'dim' }, ` · ${c.clause}`) : null)]);
  const rule = RULES.get(c.id);
  if (rule && rule.title !== c.title) kv.push(['rule', `${rule.title} (${rule.severity} when it fails)`]);
  if (kv.length) body.append(h('dl', { class: 'kv' }, kv.flatMap(([k, v]) => [h('dt', null, k), h('dd', null, v)])));
  if (c.remedy && failed) {
    body.append(h('div', { class: 'afix' },
      h('div', null, h('b', null, 'Usual cause '), c.remedy.cause),
      h('div', { class: 'afixcmd' }, h('b', null, 'Fix '), h('code', null, c.remedy.fix),
        h('button', { class: 'btn copy', onclick: (e) => { e.preventDefault(); copyText(c.remedy.fix); }, 'aria-label': 'Copy the fix' }, icon('copy')))));
  }
  if (onOffset && c.offset !== undefined) {
    body.append(h('div', { class: 'acts' }, h('button', { class: 'btn', onclick: () => onOffset(c.offset) }, `show the bytes at ${hex(c.offset, 1)}`)));
  }
  return h('details', { class: `arow ${t}`, open: open ? '' : null }, head, body);
}

/**
 * The checks of one file: first "What to fix", every critical finding and warning across
 * categories ordered by severity (open when `openFailures`), then every other check grouped by
 * category with the passes folded. `filter` is a set of tones to show ('bad', 'warn', 'info',
 * 'good', 'skip').
 */
export function checkList(checks, { filter = null, onOffset, openFailures = false } = {}) {
  const wrap = h('div', { class: 'alist' });
  const show = (c) => !filter || filter.has(tone(c));
  const isFinding = (c) => c.level === 'fail' || c.level === 'warn';
  const findings = checks.filter((c) => isFinding(c) && show(c)).sort((a, b) => rank(a) - rank(b));
  let shown = findings.length;
  if (findings.length) {
    wrap.append(h('section', { class: 'agroup afix-list' },
      h('h4', null, 'What to fix', h('span', { class: 'agc' }, `${findings.length}`)),
      findings.map((c) => checkRow(c, { onOffset, open: openFailures && tone(c) === 'bad', category: true }))));
  }
  const groups = new Map();
  for (const c of checks) {
    const g = c.category ?? 'Other';
    groups.get(g)?.push(c) ?? groups.set(g, [c]);
  }
  const names = [...groups.keys()].sort((a, b) => (CATEGORIES.indexOf(a) + 1 || 99) - (CATEGORIES.indexOf(b) + 1 || 99));
  const rest = h('div', { class: 'aall' });
  for (const g of names) {
    const list = groups.get(g).slice().sort((a, b) => rank(a) - rank(b));
    const n = counts(list);
    const others = list.filter((c) => !isFinding(c) && c.level !== 'skip' && show(c));
    if (!others.length) continue;
    const notes = others.filter((c) => c.level === 'info');
    const passes = others.filter((c) => c.level !== 'info');
    const sec = h('section', { class: 'agroup' },
      h('h4', null, g,
        h('span', { class: 'agc' },
          n.critical ? h('span', { class: 'bad' }, `✕ ${n.critical}`) : null,
          n.warning ? h('span', { class: 'warn' }, `! ${n.warning}`) : null,
          h('span', { class: 'good' }, `✓ ${n.pass}`))));
    sec.append(...notes.map((c) => checkRow(c, { onOffset })));
    if (passes.length) {
      const rows = passes.map((c) => checkRow(c, { onOffset }));
      if (notes.length || findings.length) sec.append(h('details', { class: 'apass' }, h('summary', null, `${plural(passes.filter((c) => c.level === 'pass').length, 'check')} passed`), rows));
      else sec.append(...rows);
    }
    rest.append(sec);
    shown += others.length;
  }
  const skipped = checks.filter((c) => c.level === 'skip'); // coverage, not a severity: never filtered away
  if (skipped.length) {
    wrap.append(h('section', { class: 'agroup askip' },
      h('h4', null, 'Not checked in this run', h('span', { class: 'agc' }, `${skipped.length}`)),
      h('p', { class: 'prose' }, 'These checks apply to this file but could not run here, so the verdict above does not cover them.'),
      skipped.map((c) => checkRow(c, { onOffset }))));
    shown += skipped.length;
  }
  if (rest.childNodes.length) {
    if (findings.length) wrap.append(h('h3', { class: 'asub' }, 'Every other check'));
    wrap.append(rest);
  }
  if (!shown) wrap.append(h('div', { class: 'empty-state' }, 'Nothing matches the filter.'));
  return wrap;
}

/** A short label for a rendition in a matrix column: its height, else its name. */
function columnLabel(r) {
  const v = r.facts?.video;
  const m = /(\d{3,4}p)(?!.*\d{3,4}p)/.exec((r.file ?? '').replace(/\.\w+$/, ''));
  return m ? m[1] : v?.height ? `${Math.min(v.height, v.width ?? v.height)}p` : r.file;
}

/**
 * The conformance matrix of a ladder: one row per rule that fails or warns in some rendition
 * (every rule with `showAll`), one column per rendition, the ladder's own checks in the last
 * column. A cell opens that rendition's check.
 */
export function matrix(results, ladders = [], { showAll = false, onCell } = {}) {
  // Largest rendition first, as a ladder is read.
  const cols = results.filter((r) => !r.error).sort((a, b) => (Number.parseInt(columnLabel(b), 10) || 0) - (Number.parseInt(columnLabel(a), 10) || 0));
  const ladderChecks = ladders.flatMap((l) => l.checks ?? []);
  const ids = new Set();
  for (const r of cols) for (const c of r.checks) if (showAll || c.level === 'fail' || c.level === 'warn') ids.add(c.id);
  for (const c of ladderChecks) if (showAll || c.level === 'fail' || c.level === 'warn') ids.add(c.id);
  const byId = (checks, id) => checks.find((c) => c.id === id);
  const order = [...ids].sort((a, b) => {
    const worst = (id) => Math.min(...[...cols.map((r) => byId(r.checks, id)), byId(ladderChecks, id)].filter(Boolean).map(rank));
    return worst(a) - worst(b) || a.localeCompare(b);
  });
  const table = h('table', { class: 'amatrix' });
  table.append(h('thead', null, h('tr', null, h('th', null, 'rule'), cols.map((r) => h('th', { 'data-tip': r.file }, columnLabel(r))), ladderChecks.length ? h('th', null, 'ladder') : null)));
  const body = h('tbody');
  for (const id of order) {
    const rule = RULES.get(id);
    const tr = h('tr', null, h('td', { class: 'rn', 'data-tip': rule ? `${rule.title} · ${SPECS[rule.spec]?.name ?? ''}` : id }, id));
    for (const r of cols) {
      const c = byId(r.checks, id);
      tr.append(c ? h('td', { class: `ac ${tone(c)}`, 'data-tip': `${r.file}: ${c.title}`, onclick: onCell ? () => onCell(r, c) : null }, GLYPH[c.level]) : h('td', { class: 'ac na', 'data-tip': 'Not applicable to this file' }, '·'));
    }
    if (ladderChecks.length) {
      const c = byId(ladderChecks, id);
      tr.append(c ? h('td', { class: `ac ${tone(c)}`, 'data-tip': c.title }, GLYPH[c.level]) : h('td', { class: 'ac na' }, '·'));
    }
    body.append(tr);
  }
  if (!order.length) body.append(h('tr', null, h('td', { colspan: String(cols.length + 2), class: 'empty' }, 'No rule fails or warns in any rendition.')));
  table.append(body);
  return h('div', { class: 'amwrap' }, table);
}

/** Download text as a file (a report, a SARIF log). */
export function download(name, text, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  toast(`Saved ${name}`);
}

/** Copy the Markdown report, save the JSON report or the SARIF log. */
export function exportButtons({ name, markdown, report, sarif }) {
  const base = (name ?? 'audit').replace(/\.[^.]+$/, '').replace(/[^\w.-]+/g, '_');
  return h('div', { class: 'aexport' },
    h('button', { class: 'btn copy', onclick: () => copyText(markdown()), 'data-tip': 'Copy the report as Markdown, ready to paste into a ticket or a chat' }, icon('copy'), ' report'),
    h('button', { class: 'btn', onclick: () => download(`${base}.audit.json`, JSON.stringify(report(), null, 2)), 'data-tip': 'Save the JSON report (docs/audit-report.schema.json)' }, 'JSON'),
    h('button', { class: 'btn', onclick: () => download(`${base}.sarif`, JSON.stringify(sarif(), null, 2)), 'data-tip': 'Save a SARIF 2.1.0 log, for code-scanning dashboards' }, 'SARIF'));
}
