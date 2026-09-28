# Contributing to Vidscope

Thanks for helping. Vidscope explains video files byte by byte, so the bar for a change is that
what it shows is right, and says so plainly.

## Set up

You need [Node.js](https://nodejs.org) 18 or newer, and [FFmpeg](https://ffmpeg.org) for the
test files and the tests. There are no dependencies to install and no build step.

```bash
git clone https://github.com/Amahdip/vidscope.git
cd vidscope
npm run samples      # about 60 short test files in samples/, made with FFmpeg
npm start            # the viewer on http://127.0.0.1:8766 with those files
npm test             # the test suite
```

`web/` is the whole application, served as it is. Edit a file, reload the page.

## Where things are

| Path | What it holds |
| --- | --- |
| `bin/vidscope.js` | the local server and the `vidscope` command |
| `web/formats/<format>/` | one parser per container; [docs/FORMATS.md](docs/FORMATS.md) explains how to add one |
| `web/codecs/` | codec configurations, bitstream headers, encoder settings, level limits |
| `web/core/` | byte sources, the field reader, frames, bitrate, comparison, the audit engine |
| `web/ui/` | the viewer's panes and views |
| `scripts/` | the audit CLI, `dump.mjs`, sample generation, capture of the README images |
| `test/` | `node:test` suites; most compare Vidscope with `ffprobe` |
| `.agents/skills/` | task guides for coding agents (also reachable as `.claude/skills/`) |

## Making a change

- One change per pull request, on its own branch, with a title that says what changes for a
  person using Vidscope.
- Add or change a test for anything that can be tested. A good test fails without the change:
  run it against the old code once to be sure.
- Keep the code free of dependencies and of a build step. Plain modern JavaScript, two-space
  indents, and comments that say why rather than what.
- Write the words people see the way a knowledgeable colleague would say them: short, concrete
  sentences, the real units, no marketing.

### Parsers

Every value a parser reads is recorded with its exact byte (and bit) range through
`FieldReader`, so the hex view and the inspector always agree. Compare what you locate with
FFmpeg: the existing tests check every sample's offset, size, time and key-frame flag against
`ffprobe`.

### Audit rules

A rule is only as good as its source. When adding or changing one in `web/core/audit.js`:

- cite the standard and the item or clause it comes from, checked against the current text
  (Apple renumbers its HLS authoring specification; cite the number it has today);
- let the severity follow the source: a broken MUST is critical, a SHOULD a warning; a rule that
  is common practice rather than a standard says so (`spec: 'practice'`);
- add the usual cause and the FFmpeg change that fixes it to `web/core/remedies.js`;
- build the case with FFmpeg in a test, and make sure the test fails without the rule.

## Reporting problems

Open an issue with the file or its `ffprobe` output if you can share them. Security problems go
through the private channel in [SECURITY.md](SECURITY.md).

By contributing you agree that your contribution is licensed under the [MIT license](LICENSE),
and to follow the [code of conduct](CODE_OF_CONDUCT.md).
