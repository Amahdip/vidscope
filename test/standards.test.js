// The standards register (web/standards.html) lists exactly the rules the engine runs: a rule
// without a note in scripts/standards/notes.mjs, or a page not rebuilt after a rule changed,
// fails here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { allRules } from '../web/core/audit.js';
import { buildStandards } from '../scripts/standards/build.mjs';

test('every rule has a note, and web/standards.html is up to date', () => {
  const html = buildStandards();
  for (const r of allRules()) assert.ok(html.includes(`"id":"${r.id}"`), `${r.id} is in the register`);
  assert.equal(fs.readFileSync(new URL('../web/standards.html', import.meta.url), 'utf8'), html, 'web/standards.html is stale: run node scripts/standards/build.mjs');
});
