# Vidscope development guide

Vidscope maps every byte of a video file to the structure it belongs to and explains it, and
audits files against the streaming standards. It is plain JavaScript with no dependencies and
no build step: `web/` is the whole application, `bin/vidscope.js` a small local server.

## Codebase structure

- `web/formats/<format>/`: one parser per container (isobmff, matroska, mpegts, riff, flv,
  es, raw). How to add one: [docs/FORMATS.md](docs/FORMATS.md).
- `web/codecs/`: codec configurations and bitstream headers, x264/x265 settings, level limits.
- `web/core/`: byte sources (`source.js`), `FieldReader`, the node tree and `Doc`, frames,
  bitrate, comparison, and the audit engine (`audit.js`, `remedies.js`).
- `web/ui/`: the viewer. State lives in `store.js`; `app.js` wires panes, keys and URLs.
- `scripts/`: the audit CLI (`audit.mjs`), `dump.mjs`, sample generation, image capture.
- `test/`: `node:test` suites; `helpers.mjs` finds samples and FFmpeg.

## Commands

- Samples: `npm run samples` writes about 60 test files to `samples/` with FFmpeg (the tests
  need them; they are not committed).
- Tests: `npm test`, or one suite: `node --test test/audit.test.js`, one test:
  `node --test --test-name-pattern="segment" test/audit.test.js`.
- Viewer: `node bin/vidscope.js <files or folders>` (port 8766, `--no-open`, `-r`).
- What a parser sees, without the UI: `node scripts/dump.mjs <file> --tracks --insights`.
- Audit: `node bin/vidscope.js audit <files or URLs> --md -`.
- README images: `node scripts/capture/brand.mjs`, `node scripts/capture/demos.mjs`.

## Conventions

- No dependencies, no build step, no transpiled syntax. Two-space indents, ES modules.
- Every parsed value goes through `FieldReader` with its exact byte and bit range, so the hex
  view and the inspector agree. Emulation-prevention bytes are removed and mapped back.
- Parsers treat files as hostile: bound every loop and allocation by the bytes available.
- Compare with FFmpeg, not with expectations: tests check located samples against `ffprobe`.
- A test for a fix or a rule must fail on the code before the change. Run it once against the
  old code (stash the source change) to be sure.
- Words people see are plain and concrete: real units, short sentences, no marketing. Hover
  explanations (`data-tip`) show in Guided mode only; do not put information there that
  Standard mode needs.
- Audit rules cite the current item or clause of their source and take their severity from
  it (MUST → critical, SHOULD → warning); practice is labelled `spec: 'practice'`. See the
  `writing-audit-rules` skill.
- The standards register (`web/standards.html`) is generated: edit `scripts/standards/`, then
  run `node scripts/standards/build.mjs`. Its notes exist in English and Farsi; changing an
  English note means updating its Farsi too (the build says which).

## Commits and pull requests

- One change per branch and pull request. Titles say what changes for a person using
  Vidscope ("Explanations on hover only in Guided mode"), not the code path.
- The body says the problem, the changes a person will notice, and how it was tested,
  including which tests fail without the change. Do not claim checks that were not run.
- No tool attribution lines in commits or pull requests.
- Update the README, `CHANGELOG.md` and `docs/` when behaviour they describe changes.

## Skills

Task guides live in `.agents/skills/` (also reachable as `.claude/skills/`):

- `adding-a-container-format`: a new parser, its tests against FFmpeg, and its samples.
- `writing-audit-rules`: a new or changed audit rule, its source, severity, remedy and tests.
- `auditing-video-files`: running `vidscope audit` on files, URLs or ladders and reading the
  report.
- `inspecting-video-files`: answering questions about a file with `dump.mjs` and the viewer.
- `capturing-readme-media`: regenerating the logo, social preview and README demos.
