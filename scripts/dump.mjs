#!/usr/bin/env node
// Print what Vidscope sees in a file, without the UI.
//
//   node scripts/dump.mjs <file> [--fields] [--tracks] [--insights] [--sample T:N] [--depth N]

import { openDocument } from '../web/formats/index.js';
import { ensureChildren } from '../web/core/model.js';
import { cellDisplay } from '../web/core/fields.js';
import { fmtInt, hex, humanSize } from '../web/core/util.js';
import { NodeFileSource } from './node-source.mjs';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const file = args.find((a, i) => !a.startsWith('--') && !['--depth', '--sample'].includes(args[i - 1]));
if (!file) {
  console.error('usage: node scripts/dump.mjs <file> [--fields] [--tracks] [--insights] [--sample T:N] [--depth N] [--expand]');
  process.exit(2);
}
const maxDepth = Number(opt('--depth') ?? 99);

function printFields(fields, indent) {
  for (const f of fields) {
    const pad = ' '.repeat(indent);
    const bits = f.bitSize !== undefined ? ` bits ${f.bitOffset}+${f.bitSize}` : '';
    console.log(`${pad}· ${f.name} = ${f.display ?? ''}  [${f.type} @${f.offset} +${f.size}${bits}]${f.role === 'header' ? ' (header)' : ''}`);
    if (f.note) console.log(`${pad}    ${f.note}`);
    if (f.children) printFields(f.children, indent + 2);
    if (f.type === 'table') {
      for (let i = 0; i < Math.min(f.count, 4); i++) {
        console.log(`${pad}    [${i}] ${f.columns.map((c, ci) => `${c.name}=${cellDisplay(f, i, ci)}`).join(', ')}`);
      }
      if (f.count > 4) console.log(`${pad}    … ${fmtInt(f.count - 4)} more`);
    }
  }
}

async function printNode(n, depth) {
  if (flag('--expand') && n.lazy) await ensureChildren(n);
  const pad = '  '.repeat(depth);
  const summary = n.data.summary ? ` — ${n.data.summary}` : '';
  const label = n.label ? ` [${n.label}]` : '';
  console.log(`${pad}${n.type} @${n.offset} (${hex(n.offset)}) ${humanSize(n.size)} (${fmtInt(n.size)}) · ${n.name}${label}${summary}`);
  for (const w of n.warnings) console.log(`${pad}  ! ${w}`);
  if (flag('--fields')) printFields(n.fields, depth * 2 + 4);
  if (depth >= maxDepth) return;
  for (const c of n.children ?? []) await printNode(c, depth + 1);
}

const src = await NodeFileSource.open(file);
const t0 = performance.now();
const doc = await openDocument(src);
const ms = performance.now() - t0;
console.log(`${doc.name}: ${doc.summary.label}, ${fmtInt(doc.size)} bytes, ${fmtInt(doc.nodeCount)} ${doc.unit[1]}, duration ${doc.summary.duration ?? '—'} s (parsed in ${ms.toFixed(1)} ms)`);
for (const w of doc.warnings) console.log(`! ${w.msg ?? w}`);
if (doc.loadSamples && (flag('--tracks') || flag('--insights') || opt('--sample'))) await doc.loadSamples();
for (const c of doc.root.children ?? []) await printNode(c, 0);

if (flag('--tracks')) {
  for (const t of doc.tracks) {
    console.log(`\n${t.label}`);
    for (const [k, v] of t.props) console.log(`  ${k.padEnd(18)} ${v}`);
    if (t.samples?.problems?.length) console.log(`  problems: ${t.samples.problems.join('; ')}`);
  }
}

if (flag('--insights')) {
  console.log('\nInsights');
  for (const i of await doc.insights()) {
    console.log(`  [${i.level}] ${i.group ? `${i.group}: ` : ''}${i.title}`);
    if (i.text) console.log(`      ${i.text}`);
    for (const [k, v] of i.facts ?? []) console.log(`      ${k}: ${v}`);
    if (i.cmd) console.log(`      $ ${i.cmd}`);
  }
}

const sampleArg = opt('--sample');
if (sampleArg) {
  const [ti, si] = sampleArg.split(':').map(Number);
  const t = doc.tracks[ti];
  if (!t?.samples || !(si >= 0 && si < t.samples.count)) {
    console.error(`\nno sample ${sampleArg}: ${t ? `track ${ti} has ${t.samples ? `${t.samples.count} samples` : 'no frame table'}` : `there are ${doc.tracks.length} tracks`}`);
    process.exit(1);
  }
  const d = await doc.detailAt(t.samples.offsets[si]);
  if (!d) {
    console.error(`\nno detail for the bytes of sample ${sampleArg}`);
    process.exit(1);
  }
  console.log(`\n${d.title}`);
  for (const [k, v] of d.rows) console.log(`  ${k.padEnd(18)} ${v}`);
  for (const u of d.units ?? []) {
    console.log(`  ${u.title} @${u.offset} +${u.size}: ${u.summary}`);
    if (flag('--fields')) printFields(u.fields, 6);
  }
}
await src.close();
