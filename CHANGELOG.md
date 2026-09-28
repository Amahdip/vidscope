# Changelog

Notable changes to Vidscope. There are no tagged releases yet; `main` is the current version.
Each entry links to the pull request with the details.

## 2026-09-28

### Added
- HLS presentations are audited from their playlist: every media playlist, every segment's size
  and a few segments opened, against BANDWIDTH (the peak segment bit rate), AVERAGE-BANDWIDTH,
  CODECS, RESOLUTION, FRAME-RATE, target durations, alignment, key frames, I-frame playlists and
  versions ([#29](https://github.com/Amahdip/vidscope/pull/29)).
- The logo in the top bar goes back to the start page ([#28](https://github.com/Amahdip/vidscope/pull/28)).
- A README with the logo, animated demos of the anatomy, Frames, Compare and Audit views,
  and badges; the images are recorded by `scripts/capture/` ([#27](https://github.com/Amahdip/vidscope/pull/27)).
- A development guide and task skills for coding agents ([#26](https://github.com/Amahdip/vidscope/pull/26)).
- A contribution guide, security policy, code of conduct, issue forms, a pull request template
  and CI that runs the tests with FFmpeg 8.1 ([#25](https://github.com/Amahdip/vidscope/pull/25)).
- A logo, used by the favicon, the top bar and the README ([#24](https://github.com/Amahdip/vidscope/pull/24)).
- `vidscope audit`: files and ladders judged against Apple's HLS authoring specification,
  RFC 8216, H.264, H.273, ISO 14496-12, EBU R 128 and ITU-R BT.1359, with severities, byte
  offsets and FFmpeg fixes; reports as Markdown, JSON and SARIF ([#16](https://github.com/Amahdip/vidscope/pull/16)).
- The Audit tab, a ladder audit in Compare, and "Check a conversion" next to an audit server
  ([#17](https://github.com/Amahdip/vidscope/pull/17), [#18](https://github.com/Amahdip/vidscope/pull/18)).
- Vidscope runs from any static host, such as GitHub Pages or Netlify ([#14](https://github.com/Amahdip/vidscope/pull/14)).

### Changed
- Explanations on hover appear only in Guided mode; the modes are named Guided, Standard and
  Expert after what they show ([#22](https://github.com/Amahdip/vidscope/pull/22)).
- Every audit citation was checked against the current standards, and severities follow them:
  a broken MUST is critical, a SHOULD a warning ([#20](https://github.com/Amahdip/vidscope/pull/20), [#21](https://github.com/Amahdip/vidscope/pull/21)).
- Segments and peak bit rates are judged the way a packager cuts them ([#19](https://github.com/Amahdip/vidscope/pull/19)).
- Audit reports list what they could not check, and the pass rate counts warnings; playlists are
  refused as outside the audit instead of failing ([#23](https://github.com/Amahdip/vidscope/pull/23)).

### Fixed
- The VBV buffer check no longer crashes when the next file opens ([#15](https://github.com/Amahdip/vidscope/pull/15)).

## 2026-09-22

### Added
- The byte-level anatomy viewer: MP4/MOV, Matroska/WebM, MPEG-TS, AVI/WAV and FLV, with the
  to-scale map, structure tree, hex view and inspector.
- Frames view: frame types and GOPs ([#1](https://github.com/Amahdip/vidscope/pull/1)).
- Bitrate view with a VBV buffer check ([#4](https://github.com/Amahdip/vidscope/pull/4)).
- Raw H.264, HEVC and MPEG-2 elementary streams ([#5](https://github.com/Amahdip/vidscope/pull/5)).
- Compare view: a source next to its converted versions ([#8](https://github.com/Amahdip/vidscope/pull/8), [#13](https://github.com/Amahdip/vidscope/pull/13)).
- Encoding explained: encoder settings, rate control, levels and a command that reproduces the
  encode ([#9](https://github.com/Amahdip/vidscope/pull/9)).
- Commands tab: ffprobe, ffplay and ffmpeg commands filled in for the open file ([#10](https://github.com/Amahdip/vidscope/pull/10)).
- Pixel microscope: decoded pictures of each version side by side ([#11](https://github.com/Amahdip/vidscope/pull/11)).
- A one-line `npx` quick start and screenshots in the README ([#2](https://github.com/Amahdip/vidscope/pull/2), [#12](https://github.com/Amahdip/vidscope/pull/12)).

### Fixed
- The copy icon on File insights cards was oversized ([#3](https://github.com/Amahdip/vidscope/pull/3)).
- Long file names pushed the top bar out of the window ([#6](https://github.com/Amahdip/vidscope/pull/6)).
- Some files stayed on "Opening…" forever ([#7](https://github.com/Amahdip/vidscope/pull/7)).
