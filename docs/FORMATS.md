# Adding a container format

Every format lives in `web/formats/<id>/` and is registered in `web/formats/index.js`.
The UI knows nothing about specific formats: it renders whatever tree of nodes and
fields a parser produces. `web/formats/isobmff/` (MP4/MOV) is the reference implementation.

All code is plain ES modules with no dependencies and no build step. The same modules
run in the browser and in Node (tests, `scripts/dump.mjs`), so parsers must not use
DOM or Node APIs.

## The format module

```js
// web/formats/<id>/index.js
export default {
  id: 'matroska',
  name: 'Matroska / WebM',            // default label; doc.summary.label can refine it per file
  unit: ['element', 'elements'],       // shown in the header: "57 elements"
  primer: ['Short paragraphs a newcomer reads before clicking anything: how the format is built.'],
  probe(head, source) { return 0..100 },   // head = first ≤64 KiB of the file
  async open(source, { onProgress }) { return doc },
};
```

`source` is a `CachedSource` (`web/core/source.js`): `source.size`, `source.name`,
`await source.read(offset, length)` → `Uint8Array` (clamped at EOF; do not modify it).
Reads are cached in 256 KiB blocks, so many small reads are cheap. Never read the
whole file for large files: read headers, and load big containers lazily.
`onProgress(bytesDone, totalBytes)` may be called while parsing.

## The document

`open()` returns a `Doc` (`web/core/doc.js`), usually a subclass:

```js
class MkvDoc extends Doc {
  overlay(a, b) {}        // optional: frame runs inside opaque payloads for the hex view
  async detailAt(offset) {} // optional: describe the bytes at offset (e.g. a frame and its NAL units)
  async ensureUnits(a, b) {} // optional: decode the codec units of frames in [a, b) for the overlay
  async loadSamples(onProgress) {} // optional: build frame tables that need a full scan
  async insights() {}     // findings for the File Insights tab
  glossary() {}           // format-specific glossary terms
  payloadInfo(node) {}    // optional: { title, rows: [[k, v]], text } describing an opaque payload
}
const doc = new MkvDoc({ source, format: FORMAT, root });
doc.summary = { label: 'WebM', anatomy: 'WebM / Matroska anatomy', duration: 12.5 /* s or null */ };
doc.tracks = [...];
doc.sampleIndex = ...;    // optional, see "Tracks and samples"
```

Optional: `doc.summary.unitCount` overrides the count shown in the header (use it
when most units are loaded lazily, e.g. `Math.floor(size / 188)` TS packets).

## Nodes

`new Node({ type, name, kind, offset, size, headerSize, category, def })` from `web/core/model.js`.

- `type`: the short code shown everywhere (fourcc, element name, chunk id, `packet`).
- `offset`/`size`: absolute byte range, header included. Children must be sorted by
  offset, must not overlap, and must lie inside the parent. Bytes of a node not covered
  by children or fields are shown as that node's payload.
- `headerSize`: bytes of the node's own header.
- `category`: colour family, one of `type free media index track header table codec fragment meta protect unknown`.
- `label`: short annotation shown next to the node in the tree (e.g. `Video 1 – V_MPEG4/ISO/AVC`).
- `data.summary`: one-line summary shown at the top of the inspector.
- `fields`: the parsed fields (see below). Header fields get `role: 'header'`; the inspector
  lists them under "Header" and the hex view highlights them.
- `warnings`: `node.warn('text')` for anything malformed. Never throw out of `open()` for a bad file:
  record the problem and keep going.
- `lazy`: `async (node) => { ... node.add(child) ... }` for children that are expensive to
  enumerate (Matroska clusters, AVI `movi`, groups of TS packets). The UI calls it when the node is
  expanded or when the hex view shows its bytes. Call `doc.recount()` afterwards if you track counts.
- `def`: the description the inspector shows:

```js
{
  name: 'Segment Information',        // friendly name ("mdhd — Media Header Box")
  cat: 'header',
  desc: 'One plain sentence: what this is.',
  more: 'Details: what the fields mean, why it matters, common pitfalls.',
  specTitle: 'RFC 9559 (Matroska)', section: '5.1.2',
  specHref: 'https://www.rfc-editor.org/rfc/rfc9559',
  links: [{ label: 'registry', url: 'https://www.matroska.org/technical/elements.html', title: '…' }],
  syntax: 'optional pseudo-code of the structure',
}
```

Write `desc`/`more` for people who know video but not this format's internals. Explain
why a thing matters (seeking, sync, compatibility), not only what the bits are. Be accurate;
no invented section numbers.

## Fields

Use `FieldReader` (`web/core/fields.js`) to read and record fields in one go:

```js
const r = new FieldReader(bytes, absoluteOffsetOfBytes0, { start, end, out: node.fields, le: false });
r.u8/u16/u24/u32/u64/i8…/f32/f64(name, opts)   r.fourcc(name, opts)   r.bytes(name, n, opts)
r.str(name, n, opts)  r.cstr(name, opts)  r.pstr(name, opts)  r.uuid(name, opts)  r.skip(n, name)
r.bits(n, name, opts)  r.flag(name, opts)  r.ue/se(name, opts)  r.leb128(name)  r.uN(bytes, name)
r.group(name, fn, opts)     // nest fields into a struct
r.table(name, count, entrySize, columns, opts)  // huge fixed-size tables, decoded lazily
r.bounded(n, fn)            // limit reads to the next n bytes, then skip to their end
```

Useful `opts`: `desc` (explanation, shown in Detailed mode), `key: true` (important;
shown first in Beginner mode), `reserved: true`, `role: 'header'`, `unit: 'bytes'`,
`enum: {value: 'name'}`, `display: (v) => 'custom text'`, `note` (extra computed explanation),
`ref: 'offset'` (the value is a file offset the UI can jump to).
Pass `name = null` to read without recording. Reading past `end` throws `ParseError`;
catch it per node and record a warning.

When a stored value is not itself a file offset but points to one (Matroska's SeekPosition and
CueClusterPosition are relative to the Segment), add a computed field after it with `size: 0`,
`type: 'computed'`, the absolute offset as its value and `ref: 'offset'`. It occupies no bytes, so
the hex view ignores it, and the inspector shows it with a "jump to" link.

Little-endian formats (RIFF/AVI/WAV): pass `{ le: true }`.

## Tracks and samples

```js
{ id, index, kind: 'video'|'audio'|'subtitle'|'data', codec, codecName, codecString?,
  label: 'Video 1 – h264', props: [['coded size', '640×360'], ...], node,
  samples?: { count, timescale, offsets: Float64Array, sizes: Uint32Array, dts: Float64Array,
              cto?: Int32Array, durations: Float64Array, key?: Uint8Array },
  sampleCfg?: { family: 'avc'|'hevc'|'av1'|'vp9'|'vp8'|'aac'|'mp3'|'ac3'|'eac3'|'opus'|'tx3g'|'tmcd',
                lengthSize?, state?, annexB?, adts? } }
```

`node` is required: the Tracks tab's "show" button selects it (the `trak`, TrackEntry, `strl`
list, or PMT entry that describes the track).

`samples.offsets[i]` is the first byte of frame `i`. In most containers a frame is one contiguous
run of `sizes[i]` bytes. In MPEG-TS it is spread over many packets, so `sizes[i]` counts only the
frame's own bytes and `samples.ends[i]` gives the byte after its last one. Formats may add their own
arrays next to these (TS adds `pts`, `pesIndex`, `firstInPes` and `rai`, plus a `track.pes` table);
the UI ignores arrays it does not know.

When the frame list needs a scan of the whole file (Matroska clusters, TS packets, FLV tags,
an AVI without idx1), keep `open()` fast and implement `async loadSamples(onProgress)` on the doc:
it fills `track.samples` (and anything else that needs the full scan). The UI calls it once, in the
background, after the first render and refreshes the Tracks tab, hex overlay and insights when it
resolves. Tests call it explicitly. `web/core/scan.js` has helpers for such walks: `Grow` (a
typed array that grows as you push), `FrameIndex` (frames of all tracks sorted by offset) and
`WindowReader` (reads in large windows that bypass the block cache).

`doc.sampleIndex` merges the frames of all tracks in file order:
`{ count, starts, ends, track, sample, find(offset), firstEndingAfter(offset) }` (see `SampleIndex`
in `web/formats/isobmff/samples.js`, or `FrameIndex`). The breadcrumb uses it to say how many
frames a payload holds, and `overlay`/`detailAt`/`ensureUnits` usually look frames up in it.

`web/codecs/` already parses codec configurations and frames: `parseAvcC`, `parseHvcC`,
`parseAv1C`, `parseVpcC` (pass a FieldReader positioned at the record),
`parseEsds`/`parseAudioSpecificConfig`, `parseDOps`/`parseOpusHead`, `parseFlacMetadata`,
`parseMpegAudioHeader`, `parseAc3Header`, `parseEac3Header`, `parseAdts`, `parseMpeg4Visual`
(MPEG-4 Part 2 headers), and `parseSample(cfg, bytes, start, end, base)` which splits a frame into
NAL units / OBUs / audio frames with decoded headers. Codec names: `CODEC_NAMES`.

## Details inside payloads

`detailAt(offset)` returns a record the inspector renders:

```js
{ kind: 'sample', title: 'Frame 12 · Video 1 – h264', subtitle: 'H.264 / AVC',
  range: [start, end], rows: [['track', '1'], ['timestamp', '0:00.480'], ...],
  units: [{ title: 'NAL 0 · SEI', offset, size, summary, fields }],   // from parseSample
  hit: { unit, fields } }   // which unit/fields contain `offset` (use fieldsAt from model.js)
```

Only `kind: 'sample'` records list `units`; other kinds (MPEG-TS uses `'packet'` for a packet's
header fields and `'section'` for a PSI table rebuilt from several packets) are shown with their
`title`, `rows` and `text`. When a frame is reassembled from scattered bytes (TS), parse the joined
buffer, then map every unit and field back to file offsets; keep the positions in the joined buffer
as `esOffset`/`esSize` if you need them.

`overlay(a, b)` returns `[{ start, end, track, sample, part, first, units? }]` so the hex view
can tint frames per track inside payloads. When a run has no `units` yet, the hex view calls
`ensureUnits(a, b)` for the rows on screen: decode (and cache) the units of the frames overlapping
`[a, b)` and resolve `true` if anything new was decoded, so the view repaints. Cap the work per
call (the MP4 reference decodes at most 64 frames and skips frames over 4 MiB).

## Insights

`insights()` returns `[{ level: 'good'|'info'|'warn'|'bad', group, title, text, facts?: [[k, v]], node?, offset?, cmd? }]`.
Groups used so far: `Overview`, `Layout`, `Tracks`, `Encoding`, `Timing`, `Integrity`, `Metadata`.
`cmd` is an optional shell command that fixes or inspects the issue (e.g. an FFmpeg command line).

## Glossary

`glossary()` returns `[{ term, name, desc, more?, cat?, url? }]`: the elements/structures of the
format plus the concepts a newcomer needs (e.g. EBML, VINT, lacing, cues for Matroska).

## Debugging

`node scripts/dump.mjs <file> [--fields] [--tracks] [--insights] [--expand] [--sample T:N]` prints
the tree exactly as the UI will see it (`--expand` loads lazy children, `--sample 0:5` shows the
detail of track 0's sample 5).

## Tests

Add `test/<id>.test.js` (Node's built-in test runner). Use `test/helpers.mjs`: `open(name)`,
`checkInvariants(doc)`, and `probePackets(name)` / `probeStreams(name)` to compare frame offsets,
sizes, timestamps and key flags with FFmpeg's demuxer. Sample files come from
`scripts/make-samples.sh` (`npm run samples`). Run `npm test`.
