// What each source says (in our words, never quoted), what the audit checks, and how strong the
// source's wording is. Checked against the texts on 2026-09-28 where the source could be read.
export const SOURCES = {
  hlsAuth: { short: 'Apple HLS spec', edition: 'Current web edition', access: 'Free', checked: 'text', note: 'Every cited item was read against the current text. Items are numbered by section (1 video, 2 audio, 7 segments, 8 media playlists, 9 multivariant playlists).' },
  rfc8216: { short: 'RFC 8216', edition: 'August 2017', access: 'Free', checked: 'text', note: 'Read: §3 (media segments), §4.1 (segment bit rates), §4.3.3.1 (target duration), §4.3.4.2 (BANDWIDTH, AVERAGE-BANDWIDTH, CODECS, RESOLUTION, FRAME-RATE), §6.2.1 (server duties), §6.2.4 (variant streams), §7 (versions).' },
  priming: { short: 'Apple TN2258', edition: 'Archived technical note', access: 'Free', checked: 'text', note: 'Read: AAC encoders add priming samples (commonly 2112); if playback does not trim them, audio runs behind the video.' },
  r128: { short: 'EBU R 128', edition: 'R 128 (2023), R 128 s2 (2023)', access: 'Free', checked: 'text', note: 'Read: R 128 recommendations (h) target level and (m) true peak; R 128 s2 recommendation (g) for streaming.' },
  bt1359: { short: 'ITU-R BT.1359-1', edition: '1998', access: 'Free', checked: 'text', note: 'Read: detectability and acceptability thresholds for sound leading or lagging the picture.' },
  h264: { short: 'ITU-T H.264', edition: 'Current ITU edition', access: 'Free from ITU', checked: 'unread', note: 'Not re-read: ITU refused automated downloads today. Clause numbers come from the standard\'s long-stable structure (Annex A levels, A.2.1 Baseline, Annex C HRD, 7.4.2.1.1 cropping). Please open the PDF and confirm.' },
  h273: { short: 'ITU-T H.273', edition: 'Current ITU edition', access: 'Free from ITU', checked: 'unread', note: 'Not re-read: ITU refused automated downloads today. The tables of colour primaries, transfer characteristics and matrix coefficients are the ones FFmpeg and every encoder use.' },
  isobmff: { short: 'ISO/IEC 14496-12', edition: '2022', access: 'ISO', checked: 'unread', note: 'Not re-read: ISO\'s site does not serve the text to a script. Section numbers (4.3 file type, 8.3.2 track header, 8.6.6 edit list) come from the standard\'s structure.' },
  practice: { short: 'Common practice', edition: '—', access: '—', checked: 'practice', note: 'Not a standard. Streaming-industry practice (Apple\'s ladder notes, encoder vendors, Streaming Learning Center), shown as such so the audit never passes it off as a requirement.' },
};

// norm: the source's own strength for what the rule checks. 'Defines' = the source defines the
// thing but sets no requirement on it; the severity is then our judgement, and says so.
export const RULES = {
  'fast-start': { norm: 'Practice', req: 'No standard requires it. For progressive download, a player reading the MP4 over HTTP needs the index (moov) before the media data; otherwise it must fetch the whole file first.', check: 'In an unfragmented MP4, moov starts before mdat. Fails (critical) when it comes after.' },
  interleaved: { norm: 'Practice', req: 'Audio and video samples stored close together, so a player reading from the start has both. The MP4 format itself allows any layout.', check: 'How far apart audio and video chunks sit; warns when they are poorly interleaved.' },
  'edit-list': { norm: 'Defines', req: 'Defines the edit list, which maps media time to presentation time. Several edits are allowed, but many players and packagers only handle one.', check: 'Warns when a track\'s edit list has more than one entry.' },
  integrity: { norm: 'Defines', req: 'Defines the sample tables that locate and time every sample.', check: 'Counts, offsets, sizes and times agree with the media data. Fails (critical) on a structural error.' },
  'one-video-track': { norm: 'Practice', req: 'A rendition file carries exactly one video track; players take the first and ignore the rest.', check: 'No video track fails; more than one warns.' },
  'has-audio': { norm: 'Service', req: 'Only when the service\'s profile requires audio in every rendition.', check: 'Fails when a rendition has no audio and the profile requires it; otherwise information.' },
  'track-durations': { norm: 'Adapted', req: 'Apple 8.3 says audio and video playlists must cover the same duration of content. The audit adapts this to the audio and video tracks inside each file and grades it as a warning, since a few hundred milliseconds at the end is common and harmless.', check: 'Track lengths within 0.1 s pass; up to 0.5 s warns; more fails (as a warning).' },
  codec: { norm: 'MUST', req: 'Video must be H.264, HEVC, Dolby Vision or AV1.', check: 'H.264, HEVC and AV1 pass; any other codec fails (critical).' },
  profile: { norm: 'MUST · SHOULD', req: 'H.264 must be at most High Profile, Level 5.2 (1.3b), and High should be used in preference to Main or Baseline (1.4).', check: 'High passes; Main or Baseline warns; anything above High (High 10, 4:2:2, 4:4:4) fails (critical).' },
  'level-holds': { norm: 'MUST', req: 'A stream must stay within every limit of the level it signals: frame size, macroblock rate, bit rate and buffer (Table A-1).', check: 'Recomputes each limit from the file; fails (critical) if any is exceeded.' },
  'level-minimal': { norm: 'SHOULD', req: 'Content should not signal a higher level than its resolution and frame rate need, so older devices are not shut out.', check: 'Compares the signalled level with the lowest that fits; warns when higher.' },
  'level-policy': { norm: 'Service', req: 'The service\'s own level cap per rendition size, set in its profile for device reach. Not a standard.', check: 'Fails (critical) when a rendition signals a level above the cap for its size and frame rate.' },
  'level-cap': { norm: 'MUST', req: 'H.264 must be at most High Profile, Level 5.2.', check: 'Fails (critical) above Level 5.2.' },
  'even-size': { norm: 'MUST', req: 'With 4:2:0 chroma, H.264 crops in steps of two samples, so an odd width or height cannot be coded exactly.', check: 'Fails (critical) on an odd width or height.' },
  'square-pixels': { norm: 'Practice', req: 'Streaming renditions use square pixels (sample aspect 1:1), so every player scales them the same way.', check: 'Warns when the stream signals non-square pixels.' },
  'fps-range': { norm: 'SHALL NOT', req: 'Frame rates above 60 fps shall not be used.', check: 'Fails (critical) above 60 fps; warns outside the service\'s own frame-rate range.' },
  'fps-constant': { norm: 'SHOULD', req: 'VOD should use a natural frame rate (1.18); a frame-rate change inside a stream must be marked as a discontinuity (8.14), which a single file cannot express.', check: 'Warns when frame durations vary (variable frame rate).' },
  'gop-fixed': { norm: 'SHOULD', req: 'Segments should have a nominal duration (7.6), and must start with an IDR (7.4; checked by the key-frame rule). A fixed key-frame interval is how an encoder makes equal segments possible.', check: 'Finds the usual GOP; passes when every GOP matches, notes a few short GOPs (chunk joins) as information, warns when the interval varies widely.' },
  'gop-length': { norm: 'SHOULD', req: 'Key frames (IDRs) should be present every two seconds.', check: 'With no interval set by the service, warns above 2 s. With the service\'s own interval (for example 5 s), fails when the usual interval differs from it.' },
  'gop-max': { norm: 'MUST', req: 'Segments must start with an IDR (7.4) and must not run more than 0.5 s over the target duration (7.7), so no GOP may be longer than that.', check: 'Only with the service\'s longest allowed GOP: fails (critical) when a GOP is longer.' },
  'closed-gop': { norm: 'SHOULD', req: 'Each segment should carry what a decoder needs to decode it; a segment of H.264 should contain an IDR.', check: 'From sampled frames: warns when frames after a key frame refer back to the previous GOP (open GOP).' },
  'key-is-idr': { norm: 'MUST', req: 'Video segments must start with an IDR frame.', check: 'From sampled frames: every key frame in the index is an IDR; fails (critical) otherwise.' },
  'b-frames': { norm: 'MUST', req: 'Baseline profile allows only I and P slices.', check: 'Fails (critical) when a Baseline stream has B-frames; otherwise describes the B-frame structure.' },
  'peak-ratio': { norm: 'SHOULD', req: 'For VOD, the peak bit rate should be no more than 200 % of the average. RFC 8216 measures the peak per segment.', check: 'Cuts the video into segments as a packager would and compares the busiest segment with the average; warns above the ratio (default 2).' },
  vbv: { norm: 'Practice', req: 'Streaming encoders cap the peak rate (capped CRF: maxrate and bufsize) so a rendition\'s bandwidth is predictable.', check: 'Reads the encoder settings stored in the stream; warns when no cap was set.' },
  'vbv-holds': { norm: 'Defines', req: 'Annex C defines the hypothetical reference decoder: a stream delivered at its rate never empties the decoder buffer. The audit applies it to the maxrate and bufsize the encoder wrote into the stream.', check: 'Simulates the buffer at those settings; fails (critical) on an underflow.' },
  scenecut: { norm: 'Practice', req: 'In a fixed-GOP ladder, scene-cut key frames are switched off so key frames fall only on the grid.', check: 'Only when the service sets a GOP: notes when scene-cut detection is on.' },
  'bits-per-pixel': { norm: 'Practice', req: 'Bits per pixel per frame as a rough quality guide; very low values suggest blocking.', check: 'Warns below 0.03 (0.02 for HEVC) under a bitrate target or a cap the encoder hit; information under CRF, where few bits mean a simple picture.' },
  'colour-signalled': { norm: 'Defines · SHOULD', req: 'H.273 defines the codes for colour primaries, transfer and matrix (2 means unspecified); Apple asks for one colour space per stream (1.21). No standard makes signalling mandatory; the audit treats it as critical because players otherwise guess and colours shift.', check: 'Fails (critical) when the colour description is missing or unspecified.' },
  'hdr-consistent': { norm: 'MUST', req: 'HDR HEVC must be HDR10, HLG or Dolby Vision (Apple 1.7); the PQ and HLG transfers go with BT.2020 primaries and matrix.', check: 'When the transfer says PQ or HLG: fails (critical) unless BT.2020 primaries, matrix and 10-bit samples go with it.' },
  'colour-consistent': { norm: 'Defines', req: 'Primaries and matrix come as a pair: BT.709 with BT.709, BT.2020 with BT.2020.', check: 'Fails (critical) when they are mixed.' },
  'colour-expected': { norm: 'SHOULD · Service', req: 'Streams should use a single colour space (1.21); the service names which one in its profile.', check: 'Only with the service\'s expected colour: fails when a rendition carries another.' },
  range: { norm: 'Defines', req: 'Defines the full-range flag. Streaming video is normally limited (TV) range.', check: 'Warns on full range.' },
  depth: { norm: 'MUST', req: 'H.264 must be at most High Profile, which is 8-bit; 10-bit H.264 (High 10) is beyond it.', check: 'Fails (critical) on H.264 above 8 bits.' },
  brands: { norm: 'Defines', req: 'Defines the file-type box, where a file names the specifications it follows.', check: 'Information; warns when no ISO base brand is present; fails when a CMAF brand sits on an unfragmented file.' },
  'display-aspect': { norm: 'Defines', req: 'Defines the track header\'s display width and height.', check: 'Warns when the display size disagrees with the coded size and pixel aspect.' },
  'hdr-metadata': { norm: 'SHOULD', req: 'HDR10 should carry the mastering display colour volume and content light level information.', check: 'Warns when the mdcv/clli boxes are missing (SEI messages in the stream are not read).' },
  fragments: { norm: 'MUST', req: 'In fMP4 each fragment\'s decode time must follow on from the previous one (Apple 7.3); media must be continuous across segments (RFC 8216 §3).', check: 'Fails (critical) on a sequence gap, a decode time going back, or a moof without its mdat.' },
  'audio-codec': { norm: 'Defines', req: 'Apple lists the supported audio codecs (2.2 stereo, 2.5 multichannel) and requires stereo AAC or HE-AAC to be provided (2.3). The audit prefers AAC in every rendition; another listed codec is a warning, not a broken requirement.', check: 'AAC passes, other codecs warn; with the service\'s codec set, anything else fails.' },
  'audio-rate': { norm: 'Practice', req: 'No Apple item names a sample rate; 44.1 and 48 kHz are what every device decodes.', check: 'Warns on other rates; with the service\'s rate set, fails on any other.' },
  'audio-channels': { norm: 'MUST', req: 'Multichannel audio must be delivered as separate audio streams, not muxed into video renditions.', check: 'Fails (critical) above two channels in a rendition; warns above the service\'s own limit.' },
  'audio-bitrate': { norm: 'Practice', req: 'AAC-LC needs roughly 48 kbit/s per channel to sound clean; Apple\'s table lists 32–160 kbit/s for stereo AAC (2.9).', check: 'Warns below the per-channel minimum (48 kbit/s by default; the service may set its own).' },
  'audio-priming': { norm: 'Guidance', req: 'AAC encoders put priming samples before the sound (commonly 2112); unless playback trims them, audio lags the video. MP4 trims them with an edit list.', check: 'Passes when the audio edit list skips the priming; warns when it starts at 0 or is missing.' },
  loudness: { norm: 'Recommends', req: 'R 128 sets −23 LUFS (±1 LU) for programmes; its streaming supplement allows −20 to −16 LUFS where platforms do not normalise. The target itself comes from the service profile.', check: 'With a loudness measurement: fails outside the profile\'s target and tolerance. Without one it is listed as not measured, never as a pass.' },
  'true-peak': { norm: 'Recommends', req: 'A programme\'s true peak should not exceed −1 dBTP.', check: 'With a measurement: fails above the ceiling (−1 dBTP by default). Without one it is listed as not measured.' },
  'av-sync': { norm: 'Recommends', req: 'Viewers notice sound leading by about 45 ms or lagging by about 125 ms, and object beyond 90 ms lead or 185 ms lag. The audit treats going past what viewers accept as critical, because they see and hear it.', check: 'With a sync measurement: warns past noticeable, fails (critical) past acceptable. Without one it is listed as not measured.' },
  'decode-integrity': { norm: 'Practice', req: 'Every frame of every track decodes without an error. No clause of the codec standards is cited: a damaged payload breaks their syntax in ways a decoder reports, and viewers see it, so the audit treats it as critical.', check: 'On request, decodes every video and audio frame with FFmpeg, single-threaded; fails (critical) with the number of damaged frames, when the first ones are shown and a jump to their bytes. Encrypted tracks are not decoded. Without the decode it is listed as not measured.' },
  quality: { norm: 'Practice', req: 'Fidelity to the source, measured with PSNR, SSIM or VMAF.', check: 'With a measurement against the source: warns below PSNR 30 dB, SSIM 0.9 or VMAF 70. Without the source it is listed as not measured.' },
  'idr-aligned': { norm: 'SHOULD · MUST', req: 'All variants should have segment boundaries at the same points in time (8.22; a MUST for AirPlay 2 TVs), each segment starting with an IDR (7.4).', check: 'Every key frame of every rendition has a key frame at the same moment in all the others; fails (critical) otherwise.' },
  'segment-lengths': { norm: 'MUST · SHOULD', req: 'Every segment, rounded, must fit within the target duration (RFC 8216 §4.3.3.1). Apple asks for 6 s targets (7.5) and no segment more than 0.5 s over the target (7.7).', check: 'Cuts each rendition as a packager would for each segment length the service uses: passes when one fits exactly, warns with the segments that run long, fails (critical) when renditions would be cut at different moments.' },
  'frame-rates': { norm: 'MAY', req: 'Variants may have different frame rates.', check: 'Information: lists the frame rates across renditions.' },
  'same-audio': { norm: 'SHOULD', req: 'Variants should carry the same encoded audio bitstream, so switching between them is inaudible.', check: 'Warns when codec, sample rate or channel count differ across renditions.' },
  'bitrate-steps': { norm: 'Practice', req: 'Adjacent renditions about 1.5–2× apart in bit rate, cheaper as they get smaller.', check: 'Fails when a smaller rendition has a higher bit rate; notes steps outside 1.4–2.6×.' },
  'label-matches-size': { norm: 'Practice', req: 'A rendition named NNNp belongs to that size tier, as players and YouTube use the names: its short side is at most NNN, and it does not fit the tier below\'s 16:9 frame (a 1920×800 film is 1080p).', check: 'Warns when a picture is larger than its name, or small enough for the tier below.' },
// ---- HLS presentations (playlist scope)
  'hls-reachable': { norm: 'MUST', req: 'Every segment a playlist lists must be available for immediate download.', check: 'Fetches every playlist and asks for every segment\'s size; fails (critical) on any that do not answer.' },
  'hls-bandwidth': { norm: 'MUST', req: 'BANDWIDTH is the peak segment bit rate: the busiest run of segments lasting 0.5 to 1.5 target durations (RFC 8216). For VOD, Apple requires the measured peak within 10 % of it.', check: 'Measures every segment\'s size and computes the peak exactly as the RFC defines it; fails (critical) when it is more than 10 % above or below BANDWIDTH.' },
  'hls-average-bandwidth': { norm: 'MUST', req: 'Apple requires AVERAGE-BANDWIDTH on every variant (RFC 8216 makes it optional), and for VOD the measured average within 10 % of it.', check: 'Fails (critical) when it is missing, or more than 10 % off the average of every segment.' },
  'hls-codecs': { norm: 'MUST · SHOULD', req: 'Apple requires CODECS on every variant; RFC 8216 says it must list every format the segments carry.', check: 'Opens a few segments per variant and compares their codec strings with CODECS: fails (critical) when missing or naming another profile or level, warns when only the constraint flags differ.' },
  'hls-resolution': { norm: 'MUST', req: 'Apple requires RESOLUTION on every variant with video.', check: 'Fails (critical) when missing; warns when it differs from the pictures in the segments.' },
  'hls-frame-rate': { norm: 'MUST', req: 'Apple requires FRAME-RATE on every variant with video; RFC 8216 defines it as the maximum frame rate, to three decimals.', check: 'Fails (critical) when missing; warns when it differs from the segments by more than 1 %.' },
  'hls-segment-durations': { norm: 'MUST', req: 'Every EXTINF, rounded, must be at most TARGETDURATION (RFC 8216); Apple forbids segments more than 0.5 s over it.', check: 'Fails (critical) listing the segments that break either.' },
  'hls-target-duration': { norm: 'SHOULD', req: 'Target durations should be 6 seconds.', check: 'Warns on any other target, unless the service\'s profile names that segment length.' },
  'hls-same-target': { norm: 'MUST', req: 'Every media playlist of the variants must have the same target duration (RFC 8216 §6.2.4, Apple 8.2).', check: 'Fails (critical) when targets differ across variants.' },
  'hls-aligned': { norm: 'SHOULD · MUST', req: 'All variants should have segment boundaries at the same times (a MUST for AirPlay 2 TVs).', check: 'Compares the running sum of EXTINF across variants; fails (critical) at the first boundary that differs by more than 50 ms.' },
  'hls-same-duration': { norm: 'MUST', req: 'Audio and video playlists must contain the same duration of content; VOD playlists must cover the same time range.', check: 'Fails (critical) when playlist durations differ by more than 50 ms.' },
  'hls-playlist-type': { norm: 'MUST', req: 'VOD media playlists must carry EXT-X-PLAYLIST-TYPE:VOD.', check: 'Fails (critical) when a finished playlist (ENDLIST) is not marked VOD.' },
  'hls-iframes': { norm: 'MUST', req: 'I-frame playlists must be provided so players can show pictures while scrubbing and scanning.', check: 'Fails (critical) when the multivariant playlist lists none.' },
  'hls-starts-idr': { norm: 'MUST', req: 'Video segments must start with an IDR frame.', check: 'Opens the first, middle and last segment of each playlist; fails (critical) when one does not start with a key frame.' },
  'hls-independent': { norm: 'SHOULD', req: 'When segments start with an IDR, the multivariant playlist should carry EXT-X-INDEPENDENT-SEGMENTS.', check: 'Warns when the probed segments start with key frames but the tag is missing.' },
  'hls-version': { norm: 'MUST', req: 'A playlist must declare an EXT-X-VERSION that covers the tags it uses (decimal durations need 3, byte ranges 4, EXT-X-MAP 6); PROGRAM-ID was removed in version 6.', check: 'Fails (critical) when a playlist uses tags beyond its declared version, or ones its version removed.' },
  levels: { norm: 'SHOULD', req: 'Some H.264 variants should be at most High Profile, Level 4.1, for the widest device reach.', check: 'Lists the levels down the ladder; warns when no H.264 rendition is at 4.1 or below.' },
};

// Apple items (and other requirements) the audit does not check. The audit reads the rendition
// files; playlists, captions and trick play are made elsewhere in the delivery chain.
export const GAPS = [
  { area: 'Video', items: [
    ['1.10', 'SHOULD', 'Parameter sets stored in the sample description (avc1, hvc1) rather than in the samples (avc3, hev1).', 'Readable from the file; a candidate rule.'],
    ['1.14', 'MUST', 'Interlaced sources must be deinterlaced.', 'Partly readable (interlace flags in the stream); a candidate rule.'],
    ['1.18', 'SHOULD', 'VOD uses a natural frame rate from the supported list (23.976 to 60 fps).', 'The audit checks only the 60 fps ceiling.'],
    ['1.33', 'SHOULD', 'All variants have identical aspect ratios.', 'Readable across a ladder; a candidate rule.'],
  ] },
  { area: 'Audio', items: [
    ['2.3', 'MUST', 'Stereo AAC (or HE-AAC) provided for the content.', 'The audit checks each file, not that some rendition carries stereo.'],
    ['2.18–2.23', 'SHOULD', 'Loudness information carried with the audio (a loudness box, or AAC programme reference level).', 'Not read; a candidate rule.'],
    ['2.4', 'SHOULD NOT', 'No HE-AAC above 64 kbit/s.', 'Not checked.'],
  ] },
  { area: 'Playlists', items: [
    ['6.2', 'SHOULD', 'Dense I-frame renditions at one frame per second.', 'The audit checks that I-frame playlists exist, not their density.'],
    ['7.6 · 8.1', 'SHOULD / MUST', 'Segments nominally 6 s; EXTINF sums within one frame of the real content duration.', 'Durations are read from the playlists, not measured in every segment.'],
    ['9.16', 'MUST', 'VIDEO-RANGE on HDR variants.', 'Not checked yet; the probed segments carry the transfer to compare with.'],
    ['DASH', '—', 'MPD manifests and their segments.', 'Refused as not audited.'],
  ] },
  { area: 'Accessibility', items: [
    ['4.x · 5.x', 'SHOULD / MUST', 'Captions and subtitles, and how they are declared.', 'Not checked.'],
  ] },
  { area: 'Beyond the files', items: [
    ['H.264 · H.273', '—', 'Full bitstream conformance, as a reference decoder would verify it.', 'The audit checks levels, profiles, VUI and timing; with the full decode it also finds damage FFmpeg\'s decoders report, which is not every conformance rule.'],
    ['—', '—', 'Picture quality against the original upload.', 'Needs the source; available on the command line (--measure --source).'],
  ] },
];

import { FA_RULES, FA_SOURCES } from './notes.fa.mjs';
for (const [k, noteFa] of Object.entries(FA_SOURCES)) {
  if (SOURCES[k]) SOURCES[k].noteFa = noteFa;
}
for (const [id, fa] of Object.entries(FA_RULES)) {
  if (RULES[id]) {
    RULES[id].reqFa = fa.req;
    RULES[id].checkFa = fa.check;
  }
}
