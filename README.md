# Vidscope

See the bytes inside video files. Vidscope maps every byte of a container
(MP4/MOV, Matroska/WebM, MPEG-TS, AVI/WAV, FLV) to the box, element, field, table entry or
media frame it belongs to, and explains in plain words what it is for.

## Quick start

You need [Node.js](https://nodejs.org) 18 or newer. Nothing else gets installed.

```bash
npx github:Amahdip/vidscope ~/Movies
```

This downloads Vidscope, starts a small server on your computer and opens
http://127.0.0.1:8766 in your browser, listing the videos in `~/Movies`. Give it a file or a
folder (`-r` includes sub-folders), or no path at all and drop files onto the page.

To keep a copy or change the code:

```bash
git clone https://github.com/Amahdip/vidscope.git
cd vidscope
node bin/vidscope.js ~/Movies
```

No video at hand? `npm run samples` makes about 50 short test files in every format with
FFmpeg, and `npm start` opens them.

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
- **Compare versions**: a source next to the versions converted from it (the profiles of a
  bitrate ladder, a remux, another codec). What each conversion changed or lost (resolution,
  bitrate, codec settings, GOP, colour, audio channels, subtitles...), whether the video was
  copied or re-encoded, the ladder's bitrates and bits per pixel, whether key frames line up
  across the versions and which segment lengths would work, and a microscope that shows, for
  any moment, the frame each version shows then: its type, size, GOP and what a decoder must
  decode first. A **pixel microscope** decodes those pictures in the browser (WebCodecs: H.264,
  HEVC, AV1, VP9, VP8), shows them side by side with one magnifier on the same spot of each,
  down to single pixels, a difference view against the reference, and PSNR and SSIM computed as
  FFmpeg's psnr and ssim filters do. Pick the files from the file menu or the start page; a
  comparison of files from the command line can be bookmarked (`?compare=3,4,5`).
- **Tracks** with codec strings (`avc1.64001E`, `hvc1.2.4.L63.90`, `av01.0.01M.08`, `mp4a.40.2`...), a
  frame-size chart with key frames, and a frame list that jumps to each frame's bytes.
- **Commands**: the best-known ffprobe, ffplay and ffmpeg commands to inspect (streams, packets,
  frame types, GOP pattern, bitrate per second, HDR metadata, hex dumps), watch (frame types, motion
  vectors, scopes, side-by-side, low latency), fix (remux, fast start, fixed GOPs, CRF, capped CRF,
  2-pass and CBR with x264 or x265, HLS and DASH, exact cuts, loudness, rotation) and measure
  (PSNR, SSIM, VMAF, EBU R128, interlacing, black, silence, crop). Every token is explained on hover,
  and the commands are filled in for the open file: its path, the selected track as a stream
  specifier (`v:0`, `a:1`) and the selected frame's time for `-ss`, so the same packets, frame types
  and bytes Vidscope shows can be seen through FFmpeg.
- **Glossary** of concepts and of the open format's structures (every registered 4CC for
  MP4, the Matroska elements, TS packets and tables, RIFF chunks, FLV tags), marking
  what is present in the open file.
- **Beginner / Detailed / Raw** levels of explanation, dark and light themes.

Everything is parsed in the browser. The server only hands out byte ranges, so opening a
multi-gigabyte file reads just its headers and index (usually a few megabytes), and the hex
view reads only what is on screen. Dropped files are never uploaded.

## Running it

There are no dependencies and no build step: `bin/vidscope.js` serves the `web/` folder and
the byte ranges of the files you name.

```bash
node bin/vidscope.js ~/Movies/clip.mp4 ~/Videos
```

Folders are scanned for media files (`-r` to recurse). With no arguments you can drop files
onto the page, or open a path from the file menu. In a clone, `npm link` installs a
`vidscope` command.

Options: `--port <n>` (default 8766; the next free port is used if taken), `--host <addr>`
(default 127.0.0.1), `--no-open`, `-r/--recursive`.

`npm run samples` writes about 50 short files covering every format and most codecs to
`samples/` (the tests use them too); `npm start` serves that folder.

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
web/core/                byte sources with a block cache, FieldReader, the node tree, Doc,
                         the FFmpeg command catalogue (commands.js)
web/codecs/              codec configurations and bitstream headers (H.264, HEVC, AV1, VP9, audio...)
web/formats/<format>/    one directory per container; see docs/FORMATS.md
web/ui/                  map, tree, hex view, inspector, insights, commands, tracks, glossary, compare
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
inside their parents, no overlaps, fields inside their boxes), and cover the server. They also
run every command of the Commands tab against the samples (ffmpeg for one second, ffplay's filter
graphs through ffmpeg and, when `ffplay` is installed, in a headless ffplay), check that `-ss`
at a selected frame's time extracts exactly that frame, and skip commands that need parts your
FFmpeg build lacks (such as libvmaf).

```bash
node scripts/dump.mjs samples/h264-aac.mp4 --fields --tracks --insights --sample 0:0
```

prints the tree, fields, tracks, insights and a sample's NAL units without the UI.
Adding a container format is described in [docs/FORMATS.md](docs/FORMATS.md).

## License

[MIT](LICENSE)
