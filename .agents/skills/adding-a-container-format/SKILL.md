---
name: adding-a-container-format
description: Adds a new container or stream format parser to Vidscope (web/formats/<format>/), with its node tree, fields, tracks, samples, frame types, insights and tests against FFmpeg. Use when asked to support a new file type (Ogg, MXF, MPEG-PS, ASF...), or to extend what an existing parser reads.
---

# Adding a container format

The full guide is [docs/FORMATS.md](../../../docs/FORMATS.md): the format module, the `Doc`,
nodes, fields, tracks and samples, frame types, details inside payloads, insights, glossary,
debugging and tests. Read the sections you need; this skill is the order of work and the
checks that matter.

## Order of work

1. **Samples first.** Add commands to `scripts/make-samples.sh` that make small files of the
   format with FFmpeg (a few seconds, several codecs, the edge cases: fragmented, damaged,
   live). Run `npm run samples`. If FFmpeg cannot write the format, find a small file with a
   clear licence and say so in the pull request.
2. **Probe and open.** A `web/formats/<id>/index.js` exporting `{ id, name, unit, probe, open }`,
   registered in `web/formats/index.js`. `probe(head)` returns a confidence from the first
   bytes; keep it strict so it never claims another format's files.
3. **Structure.** Build the node tree with `FieldReader`: every field with its byte (and bit)
   range, its meaning in one plain sentence, and the specification section. Payloads become
   nodes with lazy children, so a large file opens by reading only its index.
4. **Tracks and samples.** Fill `track.samples` (offsets, sizes, dts/pts, key flags) so the
   Frames, Bitrate and Compare views and the audit work without format-specific code.
5. **Insights.** What a person should know about this file (index position, damage, timing
   problems), each with the FFmpeg command that fixes it when there is one.

## Checks before the pull request

- `node scripts/dump.mjs samples/<file> --tracks --insights` prints what you built.
- Tests in `test/<format>.test.js`: every sample's offset, size, timestamps and key flag equal
  `ffprobe -show_packets` (`probePackets` in `test/helpers.mjs`), and `checkInvariants(doc)`
  holds (children inside parents, no overlaps, fields inside their nodes).
- A damaged sample (truncated, a corrupted size field) opens with a warning, never a hang:
  bound every loop by the bytes left.
- Open the samples in the viewer (`node bin/vidscope.js samples`) and click through the map,
  the tree and a frame's bytes.
- Add the format to the README's format table and to `CHANGELOG.md`.
