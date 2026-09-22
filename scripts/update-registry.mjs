#!/usr/bin/env node
// Regenerates web/formats/isobmff/registry-data.js from the two public references:
//
//   * the MP4 Registration Authority (https://mp4ra.org) - every registered 4CC
//     (boxes, brands, codecs, handlers, ...) with its description and specification;
//   * the MPEG File Format Conformance Framework
//     (https://mpeggroup.github.io/FileFormatConformance) - the syntax (SDL),
//     allowed parent boxes, versions and flags of each box.
//
// The result is checked in so Vidscope works offline. Run `npm run registry` to refresh.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'web/formats/isobmff/registry-data.js');

const MP4RA = 'https://raw.githubusercontent.com/mp4ra/mp4ra.github.io/HEAD/data';
const FFC = 'https://raw.githubusercontent.com/MPEGGroup/FileFormatConformance/HEAD/data/standard_features';

// mp4ra CSV file -> category key used by the app.
const MP4RA_FILES = {
  boxes: 'boxes',
  'boxes-qt': 'boxes-qt',
  'boxes-udta': 'boxes-udta',
  brands: 'brands',
  'sample-entries': 'codecs',
  'sample-entries-qt': 'codecs-qt',
  'sample-entries-boxes': 'sample-entry-boxes',
  handlers: 'handlers',
  'track-references': 'track-references',
  'track-references-qt': 'track-references-qt',
  'track-groups': 'track-groups',
  'track-selection': 'track-selection',
  'sample-groups': 'sample-groups',
  'entity-groups': 'entity-groups',
  schemes: 'schemes',
  oti: 'oti',
  'stream-types': 'stream-types',
  'item-types': 'item-types',
  'item-properties': 'item-properties',
  'item-references': 'item-references',
  'color-types': 'color-types',
  'data-references': 'data-references',
  'aux-info-types': 'aux-info-types',
  'checksum-types': 'checksum-types',
  'key-namespaces': 'key-namespaces',
  'multiview-attributes': 'multiview-attributes',
  'uncv-profiles': 'uncv-profiles',
  unlisted: 'unlisted',
};

// Conformance-framework JSON file -> category key.
const FFC_SPECS = ['14496-12', '14496-14', '14496-15', '14496-30', '23008-12'];
const FFC_FILES = {
  boxes: 'boxes',
  codecs: 'codecs',
  brands: 'brands',
  handlers: 'handlers',
  sample_groups: 'sample-groups',
  track_references: 'track-references',
  track_groups: 'track-groups',
  entity_groups: 'entity-groups',
  item_properties: 'item-properties',
  item_references: 'item-references',
};

async function get(url, optional = false) {
  const res = await fetch(url);
  if (res.status === 404 && optional) return null;
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.text();
}

// Minimal RFC 4180 CSV parser (quoted fields, doubled quotes, CRLF).
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  const [header, ...body] = rows.filter((r) => r.some((x) => x.trim() !== ''));
  return body.map((r) => Object.fromEntries(header.map((h, i) => [h.trim(), (r[i] ?? '').trim()])));
}

const code4 = (s) => s.replace(/\$20/g, ' ');
const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

function flattenContainers(list) {
  const parents = new Set();
  const labels = [];
  for (const c of list || []) {
    if (typeof c === 'string') {
      parents.add(c);
      labels.push(c);
    } else if (c && typeof c === 'object') {
      for (const [cls, codes] of Object.entries(c)) {
        for (const x of codes) parents.add(x);
        labels.push(`${codes.join(', ')} (${cls})`);
      }
    }
  }
  return { parents: [...parents], labels };
}

async function main() {
  const out = {
    generated: new Date().toISOString().slice(0, 10),
    sources: {
      mp4ra: 'https://mp4ra.org',
      conformance: 'https://mpeggroup.github.io/FileFormatConformance',
    },
    specs: {},
    reg: {},
    ffc: {},
  };

  const specs = JSON.parse(await get(`${MP4RA}/specifications.json`));
  for (const s of specs) {
    out.specs[s.specification] = { url: s.url || '', d: clean(s.description), mpeg: !!s.MPEG };
  }

  await Promise.all(Object.entries(MP4RA_FILES).map(async ([file, key]) => {
    const rows = parseCsv(await get(`${MP4RA}/${file}.csv`));
    const table = {};
    for (const r of rows) {
      if (!r.code) continue;
      const code = code4(r.code);
      const entry = [clean(r.description), clean(r.specification)];
      const extra = clean(r.handler || r.type || r.ObjectType || '');
      if (extra) entry.push(extra);
      // Keep the first registration when a code appears twice in one table.
      if (!table[code]) table[code] = entry;
    }
    out.reg[key] = table;
  }));

  for (const spec of FFC_SPECS) {
    await Promise.all(Object.entries(FFC_FILES).map(async ([file, key]) => {
      const text = await get(`${FFC}/${spec}/${file}.json`, true);
      if (!text) return;
      const json = JSON.parse(text);
      const table = (out.ffc[key] ||= {});
      for (const e of json.entries || []) {
        const code = e.fourcc;
        if (!code || table[code]) continue;
        const { parents, labels } = flattenContainers(e.containers);
        const item = { spec, d: clean(e.description) };
        if (e.type) item.type = e.type;
        if (parents.length) item.in = parents;
        if (labels.length && labels.join() !== parents.join()) item.inLabel = labels;
        if (e.versions?.length) item.v = e.versions;
        if (e.flags?.length) item.flags = e.flags.map((f) => [f.name, f.value, clean(f.description)]);
        if (e.deprecated) item.deprecated = true;
        if (e.syntax) item.syntax = String(e.syntax).replace(/\r\n/g, '\n').replace(/\t/g, '    ').trimEnd();
        table[code] = item;
      }
    }));
  }

  const body = `// Generated by scripts/update-registry.mjs on ${out.generated}. Do not edit by hand.\n`
    + '// Sources: the MP4 Registration Authority (https://mp4ra.org) and the MPEG File Format\n'
    + '// Conformance Framework (https://mpeggroup.github.io/FileFormatConformance).\n'
    + `export default ${JSON.stringify(out)};\n`;
  fs.writeFileSync(OUT, body);

  const count = (o) => Object.values(o).reduce((n, t) => n + Object.keys(t).length, 0);
  console.log(`wrote ${path.relative(ROOT, OUT)} (${(body.length / 1024).toFixed(0)} KB): `
    + `${Object.keys(out.specs).length} specifications, ${count(out.reg)} registry codes, ${count(out.ffc)} syntax entries`);
}

main().catch((e) => {
  console.error(`update-registry: ${e.message}`);
  process.exit(1);
});
