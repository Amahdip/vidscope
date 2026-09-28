---
name: inspecting-video-files
description: Answers questions about what is inside a video file (container structure, where the index is, tracks and codecs, frame types and GOPs, encoder settings, timing problems) with Vidscope's dump script and viewer. Use when asked why a file behaves a certain way, where a box or frame sits in the bytes, or to compare a file with how it was converted.
---

# Inspecting video files

Vidscope reads the file the way a demuxer and a decoder's header parsers do, and records
every value with its byte position. Use it to answer from the bytes, then check against
FFmpeg when it matters.

## From the command line

```bash
node scripts/dump.mjs clip.mp4                       # the structure tree
node scripts/dump.mjs clip.mp4 --tracks --insights   # tracks, codecs, and what stands out
node scripts/dump.mjs clip.mp4 --fields --depth 3    # every field of the top levels
node scripts/dump.mjs clip.mp4 --sample 0:0          # track 0, sample 0: its bytes and NAL units
```

Insights name the notable things: index before or after the media (fast start), key-frame
interval, B-frames, edit lists and audio priming, variable frame rate, HDR, encryption, the
encoder and its settings, and integrity problems, each with the FFmpeg command that fixes it.

## In the viewer

```bash
node bin/vidscope.js clip.mp4 other.mkv --no-open
```

Links keep state: `?file=2#0x28` opens the second file at byte 0x28; `?compare=1,2,3` opens
the Compare view with the first file as the reference. Useful tabs: Bytes (hex coloured by
structure), Frames (types and GOPs), Bitrate (per second, VBV check) and Audit in the centre;
Structure, Tracks and Glossary on the left; Inspector, File insights (encoder settings, rate
control, levels) and Commands (ffprobe and ffmpeg filled in for the file) on the right.
Guided mode adds plain-language notes; Expert mode shows values and offsets only.

## Checking against FFmpeg

```bash
ffprobe -v error -show_entries packet=pts_time,dts_time,size,flags -select_streams v:0 -of csv clip.mp4
ffprobe -v error -show_frames -select_streams v:0 -show_entries frame=pict_type,key_frame -of csv clip.mp4
```

Vidscope's tests hold its sample offsets, sizes, times and key flags equal to `ffprobe`'s, so
a disagreement is worth reporting as a bug with both outputs.
