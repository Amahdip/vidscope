---
name: writing-audit-rules
description: Adds or changes a rule of Vidscope's audit engine (web/core/audit.js) so that it cites the right standard and item, takes its severity from that item's MUST/SHOULD wording, carries an FFmpeg remedy, and is proven by a test built with FFmpeg. Use when a new check is wanted, a finding is disputed, or a standard's text changed.
---

# Writing audit rules

A rule is `defineRule({ id, scope, category, severity, spec, clause, title, applies, check,
unmeasured? })` in `web/core/audit.js`. `check(c)` returns `pass`, `warn`, `fail` or `info`
with a title, a sentence of explanation, and optionally `value`, `expected` and `offset`.
Ladder rules (`scope: 'ladder'`) receive every rendition's result.

## 1. Find the source, and read it

The citation is the rule's authority, so verify it against today's text:

- Apple HLS authoring specification, as markdown:
  `https://docs.developer.apple.com/tutorials/data/documentation/http-live-streaming/hls-authoring-specification-for-apple-devices.md`
  (and `...-appendixes.md`). Apple renumbers items; cite the number it has now.
- RFC 8216: `https://www.rfc-editor.org/rfc/rfc8216.txt`.
- EBU R 128 and R 128 s2, ITU-R BT.1359: free PDFs.
- ITU-T H.264 / H.273 and ISO/IEC 14496-12 often refuse scripted downloads; say in the pull
  request when a clause was not re-read.

No standard behind it? Then it is practice: `spec: 'practice'`, and the text says so.

## 2. Severity follows the words

- MUST, SHALL, SHALL NOT broken: `severity: 'critical'` and `fail`.
- SHOULD, RECOMMENDED broken: `warn` (a critical rule's `warn` reports as WARNING).
- MAY, or a definition with no requirement: `info`, or a judgement the text states plainly.

A service can promote or demote a rule with `expect.overlay.severity`; keep the rule's own
severity true to the standard.

## 3. Say what was not checked

A rule that needs a measurement (loudness, sync, a source) sets `unmeasured(c)` to a reason,
so the report lists it under "Not checked in this run" instead of dropping it. Never let a
missing input read as a pass.

## 4. Remedy and wording

Add `{ cause, fix }` to `web/core/remedies.js`: the usual cause in an FFmpeg-based pipeline
and the exact option that fixes it. Titles state the finding with its numbers ("5 s segments:
2 of 137 run long (7 s at 4:55, 7.4 s at 9:57)"), not a verdict word.

## 5. The standards register

Every rule is listed in `web/standards.html`, which the supervisor of a service uses to confirm
the sources. Add to `scripts/standards/notes.mjs` what the source says (in our own words) and
what the audit checks, and the same in Farsi to `scripts/standards/notes.fa.mjs`, keeping its
wording table (MUST as «باید», SHOULD as «توصیه می‌شود»). Run `node scripts/standards/build.mjs`:
it stops on a rule without both notes, and on a Farsi note made from an older English text,
printing the `of` value to set once the Farsi is updated.

## 6. Prove it

- In `test/audit.test.js`, build the case with FFmpeg (`makeFixture`) and assert the level,
  severity and title. Include the passing case.
- Stash the rule change and run the test once: it must fail on the old code.
- If a real file prompted the rule, check the rule's claim against an independent tool (for
  segments: package with `ffmpeg -f hls` and read the playlist).
- `node bin/vidscope.js audit --rules` lists the rule with its source; update the README's
  audit section and `CHANGELOG.md`; update `docs/audit-report.schema.json` if the report's
  shape changed.
