# Vidscope

See the bytes inside video files. Vidscope maps every byte of a container
(MP4/MOV, Matroska/WebM, MPEG-TS, AVI/WAV, FLV) to the box, element, field, table entry or
media frame it belongs to, and explains in plain words what it is for.

- **To-scale map** of the file and of any box you zoom into, plus one card per part so
  even 8-byte boxes are clickable.
- **Structure tree** of every box, element, chunk, packet or tag, with track labels and
  warnings.
- **Hex view** over the whole file (any size), coloured by structure: headers, parsed
  fields, table entries, and inside media payloads (`mdat`, Clusters, `movi`, TS packets,
  FLV tags) the frames of each track, down to the NAL units (length prefixes underlined).
- **Inspector**: click any byte to see the field it belongs to as hex, decimal and binary
  (bit fields highlighted), its type and byte range, what it means, and where it sits.
  Boxes show their fields, tables (virtualised, with offsets you can jump to), the
  specification section, links to the [MP4 Registration Authority](https://mp4ra.org) and
  the [MPEG conformance framework](https://mpeggroup.github.io/FileFormatConformance), and
  the official syntax with allowed parents, versions and flags.
- **Frames and NAL units**: a byte inside a media payload resolves to its frame (track,
  index, decode/presentation time, key frame, and the chunk, fragment, Cluster or PES packet
  it came in), and the frame is split into NAL units / OBUs / audio frames with decoded
  headers: SPS/PPS/VPS, SEI (x264 settings, HDR metadata, captions), slice headers.
- **File insights**: fast start or not (with the FFmpeg command that fixes it),
  fragmentation, interleaving, keyframe interval, B-frames, edit lists and audio priming,
  variable frame rate, HDR, encryption, the encoder and its settings, metadata, chapters, and
  integrity problems. Per format: Matroska Cues, SeekHead and CRC-32s; TS timing (PCR,
  PAT/PMT repetition, continuity counters); AVI indexes; FLV metadata against the tags.
- **Frames view**: every frame of a video track as an I-, P- or B-frame (with IDR and open-GOP
  entry frames, B-frames that are references, hidden VP9/AV1 frames), sized and coloured in a
  zoomable chart, grouped into GOPs, and shown in decoding order next to display order. The
  types are read from each frame's slice or frame header and match what FFmpeg's decoders
  report, for H.264, HEVC, AV1, VP9, VP8, MPEG-2, MPEG-4 Part 2, Sorenson and VP6 in every
  container. Tooltips and short notes explain GOPs, open and closed GOPs, B-pyramids and why the
  key frame interval matters for streaming.
- **Bitrate view**: bits per second of every track over time (stacked), average and peaks, bits
  per pixel, a guess at the rate control (constant, capped or quality-based), and a decoder
  buffer (VBV) check that shows whether a viewer receiving the stream at a given `-maxrate` and
  `-bufsize` would keep up, and which frame would stall.
- **Tracks** with codec strings (`avc1.64001E`, `hvc1.2.4.L63.90`, `av01.0.01M.08`, `mp4a.40.2`...), a
  frame-size chart with key frames, and a frame list that jumps to each frame's bytes.
- **Glossary** of concepts and of the open format's structures (every registered 4CC for
  MP4, the Matroska elements, TS packets and tables, RIFF chunks, FLV tags), marking
  what is present in the open file.
- **Beginner / Detailed / Raw** levels of explanation, dark and light themes.

Everything is parsed in the browser. The server only hands out byte ranges, so opening a
multi-gigabyte file reads just its headers and index (usually a few megabytes), and the hex
view reads only what is on screen. Dropped files are never uploaded.

## Run it

Requires Node.js 18 or newer. No dependencies and no build step.

```bash
node bin/vidscope.js ~/Movies/clip.mp4 ~/Videos
```

This serves the UI at http://127.0.0.1:8766 and opens it. Folders are scanned for media
files (`-r` to recurse). With no arguments you can drop files onto the page, or open a
path from the file menu. `npm link` installs a `vidscope` command.

To try it on generated test files (needs FFmpeg):

```bash
npm run samples
```

```bash
npm start
```

`npm run samples` writes about 50 short files covering every format and most codecs to
`samples/` (the tests use them too).

Options: `--port <n>` (default 8766; the next free port is used if taken), `--host <addr>`
(default 127.0.0.1), `--no-open`, `-r/--recursive`.

The server binds to localhost, answers only requests addressed to localhost (a DNS
rebinding guard), and only serves the files you named.

### Keyboard

| Key | Action |
| --- | --- |
| click a byte | identify it |
| `g` or `/` | go to offset: `1234`, `0x4D2`, `4D2h`, `1.5M`, `50%`, `-1k` (from the end) |
| `f` | find text (`mdat`, `x264`) or hex bytes (`00 00 01`); Enter finds the next match |
| arrows, PgUp/PgDn, Home/End | move the byte cursor (hex view focused) |
| `[` `]` | previous / next box at the same level |
| `u` | parent box |
| Enter / Backspace | zoom the map in / out |
| `1` `2` `3` | Beginner / Detailed / Raw |
| `?` | all shortcuts |

The URL keeps the file and selected offset (`?file=2#0x28`), so views can be shared
between people looking at the same files.

## Formats

| Format | What Vidscope reads |
| --- | --- |
| MP4, MOV, M4A, 3GP, fMP4/CMAF, HEIF/AVIF (ISO-BMFF) | 140+ box types with every field, sample entries for about 100 codecs and their configurations (avcC, hvcC, av1C, vpcC, esds, dOps, dac3, dec3, dfLa...), sample tables and fragments, iTunes/QuickTime metadata, HEIF items, Common Encryption; every sample located and split into NAL units / OBUs |
| Matroska, WebM (MKV, MKA, WebM) | All 273 elements of RFC 8794 / RFC 9559 with descriptions and section links, EBML variable-length integers decoded bit by bit, unknown-size (live) Segments and Clusters, CRC-32 checks, Block and SimpleBlock headers with Xiph/EBML/fixed lacing, CodecPrivate (avcC, hvcC, av1C, Vorbis/Theora headers, BITMAPINFOHEADER, WAVEFORMATEX), Cues, chapters, tags, attachments, subtitles (SRT, ASS); resynchronises after damaged bytes |
| MPEG transport stream (TS, M2TS/MTS, 188/192/204-byte packets) | Packet headers, adaptation fields (PCR, splice countdown, private data), PES headers (PTS/DTS), PSI/SI tables (PAT, PMT, CAT, NIT, BAT, SDT, EIT, TDT/TOT, SCTE-35) with CRC-32 checks and about 40 descriptors; frames reassembled across packets and split (ADTS, LATM, AC-3, E-AC-3, MPEG audio), with key frame detection |
| AVI, OpenDML, WAV, BWF, RF64 (RIFF) | hdrl, stream headers and formats, idx1 and OpenDML indexes, `movi` chunks (grouped, loaded lazily), AVIs without an index (scanned); WAV fmt/WAVE_FORMAT_EXTENSIBLE, bext, cue, smpl, iXML, ds64 and more, with the PCM sample frame or ADPCM block under the cursor decoded |
| FLV | Header, tags and PreviousTagSize checks, onMetaData (AMF0, including keyframe index arrays), AVC/HEVC/AV1/VP9 and AAC/Opus configuration records including Enhanced RTMP; resynchronises after damage |
| Anything else | Shown as bytes with the hex view and find; the signature is identified (MPEG-PS, Ogg, MXF, ASF, raw H.264/HEVC/AAC/MP3 streams, images...) |

Codec bitstreams: H.264 (SPS with VUI and HRD, PPS, SEI, slice headers), H.265 (VPS, SPS
with VUI, PPS, SEI, slice headers), AV1 (sequence and frame headers, OBUs), VP8/VP9 frame
headers, MPEG-4 Part 2 and MPEG-2 video headers, AAC (AudioSpecificConfig, ADTS, LATM), Opus,
AC-3/E-AC-3, FLAC, ALAC, MP3.

## How it fits together

```
bin/vidscope.js          local server: static UI + byte ranges of the files you pass
web/core/                byte sources with a block cache, FieldReader, the node tree, Doc
web/codecs/              codec configurations and bitstream headers (H.264, HEVC, AV1, VP9, audio...)
web/formats/<format>/    one directory per container; see docs/FORMATS.md
web/ui/                  map, tree, hex view, inspector, insights, tracks, glossary
scripts/dump.mjs         print what Vidscope sees, from the command line
```

Parsers record every value together with its exact byte (and bit) position through
`FieldReader`, so the inspector and the hex view always agree on which bytes a field
occupies. Emulation-prevention bytes in NAL units are removed before parsing and each field
is mapped back to its original bytes.

The box registry (names, descriptions, specifications of every registered 4CC) and the
box syntax come from [mp4ra.org](https://mp4ra.org) and the
[MPEG File Format Conformance Framework](https://github.com/MPEGGroup/FileFormatConformance),
bundled in `web/formats/isobmff/registry-data.js`. Refresh it with `npm run registry`.

## Development

```bash
npm test
```

Tests compare every sample Vidscope locates (offset, size, timestamps, key frame flag)
with FFmpeg's demuxer through `ffprobe`, check that the node tree is consistent (children
inside their parents, no overlaps, fields inside their boxes), and cover the server.

```bash
node scripts/dump.mjs samples/h264-aac.mp4 --fields --tracks --insights --sample 0:0
```

prints the tree, fields, tracks, insights and a sample's NAL units without the UI.
Adding a container format is described in [docs/FORMATS.md](docs/FORMATS.md).

## License

[MIT](LICENSE)
