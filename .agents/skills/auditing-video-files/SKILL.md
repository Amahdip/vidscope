---
name: auditing-video-files
description: Runs Vidscope's standards audit (vidscope audit) on video files, URLs or a ladder of renditions, with a service's expectations, and reads the report correctly, including what it did not check. Use when asked whether files follow HLS/Apple, H.264, colour, loudness or ladder conventions, or to explain an audit finding.
---

# Auditing video files

```bash
node bin/vidscope.js audit movie-1080p.mp4 movie-720p.mp4 movie-360p.mp4 --md -
```

## Inputs

- Local files or `http(s)` URLs. URLs are read with range requests: the index, then a budget
  of frame data (`--budget`, 32 MB per URL by default, a comma list per input), so a long
  file costs megabytes, not a download. `--header "K: V"` for URLs that need one.
- Renditions of one content (`name-720p.mp4`, `name-360p.mp4`) are grouped into a ladder
  automatically; `--ladder` forces one ladder, `--no-ladder` none.
- Media files only. An HLS playlist or DASH manifest is refused as "not audited" (exit 3);
  audit the renditions it points at.

## What the service intends

Without expectations the rules judge only what the standards say. Add the service's own
contract with `--expect k=v,...` or `--expect-file profile.json` (keys: `gop`, `gopMax`,
`fpsMax`, `fpsMin`, `peakRatio`, `segments`, `colour`, `audio.*`, `loudness`, and an
`overlay` of severities and level caps). A key the engine does not know is refused.

## Measurements

`--measure` runs FFmpeg for loudness and true peak; with `--source <original>` also PSNR and
SSIM. Without it those rules, and A/V sync, appear under "Not checked in this run": they
were not measured, which is not the same as passing.

## Reading the report

- Each finding has a level (pass, warn, fail, info, skip) and, if it is a finding, a severity
  (CRITICAL, WARNING, INFO). A profile's overlay can raise a warning to CRITICAL: the finding
  is the same, the service has said it matters more.
- "Checks passed" is passed ÷ checks with a verdict; information and unchecked checks are
  counted apart. Always report the not-checked list with the verdict.
- Every finding names its source and clause, the measured and expected values, the byte
  offset it is about, the usual cause and the FFmpeg fix. Quote the numbers, not the verdict.
- `--json` (schema: `docs/audit-report.schema.json`) and `--sarif` for machines. Exit code:
  2 critical, 1 warning, 3 an input could not be audited, 64 usage, 70 FFmpeg missing.

## Limits to state when they matter

The audit reads container and codec structure and sampled frame headers. It does not decode
every frame (a corrupt payload with valid structure passes), does not read playlists (declared
BANDWIDTH, AVERAGE-BANDWIDTH), and cannot judge picture quality without the source. Say so
rather than implying a clean bill of health.
