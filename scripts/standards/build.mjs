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

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { allRules, SPECS } from '../../web/core/audit.js';
import { SOURCES, RULES, GAPS } from './notes.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');

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
  const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  const data = {
    version,
    checked: '28 September 2026',
    sources: ORDER.filter((k) => rules.some((r) => r.spec === k)).map((k) => ({ key: k, name: SPECS[k].name, url: SPECS[k].url, ...SOURCES[k], count: rules.filter((r) => r.spec === k).length })),
    rules: [...rules].sort((p, q) => ORDER.indexOf(p.spec) - ORDER.indexOf(q.spec) || byCite(cite(p), cite(q)) || p.id.localeCompare(q.id)).map((r) => ({ id: r.id, title: r.title, scope: r.scope, category: r.category, severity: r.severity, spec: r.spec, clause: r.clause, cite: cite(r), ...RULES[r.id] })),
    gaps: GAPS,
  };
  const tpl = fs.readFileSync(path.join(HERE, 'template.html'), 'utf8');
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
