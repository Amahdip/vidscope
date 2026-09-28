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

const pageData = (html) => JSON.parse(html.split('<script type="application/json" id="data">')[1].split('</script>')[0]);

test('every rule, source and gap reads in Farsi too, with signs kept on the left of their numbers', () => {
  const d = pageData(buildStandards());
  for (const r of d.rules) assert.ok(r.fa.req && r.fa.check, `${r.id} has a Farsi note`);
  for (const s of d.sources) assert.ok(s.fa.note && s.fa.edition && s.fa.access, `${s.key} has a Farsi note`);
  for (const g of d.gaps) assert.equal(g.fa.items.length, g.items.length, `${g.area} has every item in Farsi`);
  const loud = d.rules.find((r) => r.id === 'loudness').fa.req;
  assert.match(loud, /‎−23 LUFS/, 'a left-to-right mark holds −23 together in a right-to-left line');
  assert.doesNotMatch(d.rules.find((r) => r.id === 'level-holds').fa.req, /A‎-1/, 'a hyphen inside a name is left alone');
});

test('an English note that changes without its Farsi stops the build', async () => {
  const { RULES } = await import('../scripts/standards/notes.mjs');
  const before = RULES.codec.req;
  RULES.codec.req = `${before} Changed.`;
  try {
    assert.throws(() => buildStandards(), /notes\.fa\.mjs is out of step: Farsi made from an older English text .*rule codec \(of: '[0-9a-f]{8}'\)/);
  } finally {
    RULES.codec.req = before;
  }
  assert.doesNotThrow(() => buildStandards());
});
