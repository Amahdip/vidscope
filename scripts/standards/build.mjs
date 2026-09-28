// Builds the standards register (web/standards.html): every rule of the audit engine with the
// standard and item it cites, what the source says (notes.mjs, in our own words) and what the
// audit checks. The rule list comes from the engine itself, so the page cannot miss a rule; a
// rule without a note fails the build (and the tests).
//
//   node scripts/standards/build.mjs            writes web/standards.html
//   node scripts/standards/build.mjs --stdout   prints it (for publishing elsewhere)
//
// Served by the viewer it is a read-only reference; opened in Claude (an artifact with a shared
// store) it also records reviews: Confirm, Question or Disagree on each rule.
//
// The page reads in English or Farsi. The Farsi is in notes.fa.mjs; each translation names the
// English it was made from (`of`), so an English note that changes stops the build until its
// Farsi is updated too.

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { allRules, SPECS } from '../../web/core/audit.js';
import { SOURCES, RULES, GAPS } from './notes.mjs';
import { FA_UI, FA_CHECKED, FA_SOURCES, FA_RULES, FA_GAPS } from './notes.fa.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');

/** The first 8 hex digits of the SHA-256 of an English text: the text a translation was made from. */
export const englishOf = (...texts) => createHash('sha256').update(texts.join('\n')).digest('hex').slice(0, 8);

// In a right-to-left paragraph a sign before a number lands on the wrong side ("23−", "3§");
// a left-to-right mark in front keeps "−23" and "§3" together.
const bidi = (s) => s.replace(/(^|[^\w\u200e])([−\-±+§])(?=\d)/gu, '$1\u200e$2');

/** Every English note, and every key the page uses, has a Farsi made from the current English. */
function checkFarsi(rules, tpl) {
  const missing = [];
  const stale = [];
  const extra = [];
  const compare = (what, fa, ...english) => {
    if (!fa) missing.push(what);
    else if (fa.of !== englishOf(...english)) stale.push(`${what} (of: '${englishOf(...english)}')`);
  };
  for (const r of rules) compare(`rule ${r.id}`, FA_RULES[r.id], RULES[r.id].req, RULES[r.id].check);
  for (const [k, s] of Object.entries(SOURCES)) compare(`source ${k}`, FA_SOURCES[k], s.edition, s.access, s.note);
  for (const g of GAPS) {
    if (!FA_GAPS[g.area]) missing.push(`gap area ${g.area}`);
    for (const [item, , what, why] of g.items) compare(`gap ${g.area} ${item}`, FA_GAPS[g.area]?.items[item], what, why);
    for (const item of Object.keys(FA_GAPS[g.area]?.items ?? {})) if (!g.items.some(([i]) => i === item)) extra.push(`gap ${g.area} ${item}`);
  }
  extra.push(...Object.keys(FA_RULES).filter((id) => !rules.some((r) => r.id === id)).map((id) => `rule ${id}`));
  extra.push(...Object.keys(FA_SOURCES).filter((k) => !SOURCES[k]).map((k) => `source ${k}`));
  extra.push(...Object.keys(FA_GAPS).filter((a) => !GAPS.some((g) => g.area === a)).map((a) => `gap area ${a}`));
  // The page's words: data-t and data-t-ph in the markup, and the keys of its EN table.
  const en = /const EN = \{([\s\S]*?)\n {2}\};/.exec(tpl)?.[1] ?? '';
  const keys = new Set([...tpl.matchAll(/data-t(?:-ph)?="([\w-]+)"/g), ...en.matchAll(/'([\w-]+)':/g)].map((m) => m[1]));
  for (const k of keys) if (FA_UI[k] == null) missing.push(`page text ${k}`);
  for (const k of Object.keys(FA_UI)) if (!keys.has(k)) extra.push(`page text ${k}`);
  const parts = [];
  if (missing.length) parts.push(`no Farsi for ${missing.join(', ')}`);
  if (stale.length) parts.push(`Farsi made from an older English text (update the Farsi, then its of): ${stale.join(', ')}`);
  if (extra.length) parts.push(`Farsi for things that no longer exist: ${extra.join(', ')}`);
  if (parts.length) throw new Error(`scripts/standards/notes.fa.mjs is out of step: ${parts.join('; ')}`);
}

export function buildStandards() {
  const rules = allRules();
  const missing = rules.filter((r) => !RULES[r.id]).map((r) => r.id);
  const extra = Object.keys(RULES).filter((id) => !rules.some((r) => r.id === id));
  if (missing.length || extra.length) throw new Error(`scripts/standards/notes.mjs is out of step with the engine: ${missing.length ? `no note for ${missing.join(', ')}` : ''}${missing.length && extra.length ? '; ' : ''}${extra.length ? `notes for rules that no longer exist: ${extra.join(', ')}` : ''}`);
  const ORDER = ['hlsAuth', 'rfc8216', 'h264', 'h273', 'isobmff', 'priming', 'r128', 'bt1359', 'practice'];
  const CITE = { 'hdr-consistent': 'BT.2100', 'colour-consistent': 'Tables 2, 4', range: 'Range flag', integrity: 'Sample tables' };
  const cite = (r) => {
    if (CITE[r.id]) return CITE[r.id];
    if (r.spec === 'practice') return '—';
    const m = /^(§[\d.]+|\d+(?:\.\d+){2,}|\d+\.\d+[a-z]?|[A-Z]\.[\d.]+|Annex [A-Z]|Tables? [\d–]+|R 128 \([a-z]\))/.exec(r.clause ?? '');
    if (m) return m[1];
    if (r.spec === 'priming') return 'TN2258';
    if (r.spec === 'bt1359') return 'Rec. 2';
    return '—';
  };
  // Within a source, in the order of its own numbering; rules without a number last.
  const collator = new Intl.Collator('en', { numeric: true });
  const byCite = (a, b) => (a === '—') - (b === '—') || collator.compare(a.replace(/^§/, ''), b.replace(/^§/, ''));
  const tpl = fs.readFileSync(path.join(HERE, 'template.html'), 'utf8');
  checkFarsi(rules, tpl);
  const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  const data = {
    version,
    checked: '28 September 2026',
    sources: ORDER.filter((k) => rules.some((r) => r.spec === k)).map((k) => {
      const fa = FA_SOURCES[k];
      return { key: k, name: SPECS[k].name, url: SPECS[k].url, ...SOURCES[k], count: rules.filter((r) => r.spec === k).length, fa: { edition: bidi(fa.edition), access: bidi(fa.access), note: bidi(fa.note) } };
    }),
    rules: [...rules].sort((p, q) => ORDER.indexOf(p.spec) - ORDER.indexOf(q.spec) || byCite(cite(p), cite(q)) || p.id.localeCompare(q.id)).map((r) => ({ id: r.id, title: r.title, scope: r.scope, category: r.category, severity: r.severity, spec: r.spec, clause: r.clause, cite: cite(r), ...RULES[r.id], fa: { req: bidi(FA_RULES[r.id].req), check: bidi(FA_RULES[r.id].check) } })),
    gaps: GAPS.map((g) => ({ ...g, fa: { area: FA_GAPS[g.area].area, items: g.items.map(([item]) => [bidi(FA_GAPS[g.area].items[item].what), bidi(FA_GAPS[g.area].items[item].why)]) } })),
    fa: { checked: FA_CHECKED, ui: Object.fromEntries(Object.entries(FA_UI).map(([k, v]) => [k, bidi(v)])) },
  };
  return tpl.replace('/*DATA*/', () => JSON.stringify(data).replace(/</g, '\\u003c'));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const html = buildStandards();
  if (process.argv.includes('--stdout')) process.stdout.write(html);
  else {
    fs.writeFileSync(path.join(ROOT, 'web/standards.html'), html);
    console.log('wrote web/standards.html');
  }
}
