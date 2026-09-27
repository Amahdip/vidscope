// What usually causes each audit finding in a transcoding pipeline, and the FFmpeg change that
// fixes it. Generic: the causes are the ones seen in any ffmpeg-based converter, the fixes are
// ready to try. A service can layer its own notes (which file, which flag) on top by rule id.

export const REMEDIES = {
  'fast-start': {
    cause: 'The MP4 was written without +faststart, or a later tool appended a new moov.',
    fix: 'ffmpeg -i in.mp4 -c copy -movflags +faststart out.mp4 (or add -movflags +faststart to the muxing step).',
  },
  interleaved: {
    cause: 'Audio and video were muxed from separate files with large chunk sizes, or one track was appended after the other.',
    fix: 'Remux with ffmpeg -c copy -movflags +faststart; keep the muxer\'s default interleaving (do not raise -max_interleave_delta).',
  },
  'edit-list': {
    cause: 'The source\'s edit list was copied through, or an editor left several edits.',
    fix: 'Re-encode or remux with -ignore_editlist 1 on the input so the output gets a single, clean edit list.',
  },
  'track-durations': {
    cause: 'Audio and video were encoded separately and muxed with -shortest, or one track lost its tail in a chunked encode.',
    fix: 'Encode audio and video from the same trimmed source (-t on the input), and avoid -shortest at mux time; check that chunk concatenation keeps every packet.',
  },
  profile: {
    cause: 'The encoder was asked for Baseline, or for a profile the ladder does not need.',
    fix: '-profile:v main for renditions up to 720p, -profile:v high above (H.264).',
  },
  'level-holds': {
    cause: 'A level was forced with -level that the picture size, frame rate or bitrate exceeds.',
    fix: 'Drop -level so x264 picks the level, or raise it to the level the stream needs (e.g. -level 4.2 for 1080p60).',
  },
  'level-minimal': {
    cause: 'A fixed -level higher than the rendition needs, or a rate/refs setting that pushed x264 to a higher level.',
    fix: 'Let x264 choose (no -level), or set -level to the lowest that fits; devices are gated by the signalled level.',
  },
  'level-cap': {
    cause: 'Frame rate or size beyond what level 4.2 allows.',
    fix: 'Cap the ladder at 1080p60: -r 60 and 1920x1080 for the top rung, or provide a separate HEVC rendition for more.',
  },
  'even-size': {
    cause: 'A scale filter produced an odd dimension when keeping the aspect ratio.',
    fix: 'scale=w=...:h=-2 (or force_divisible_by=2) so both dimensions stay even.',
  },
  'square-pixels': {
    cause: 'The source sample aspect ratio was kept through the encode.',
    fix: 'Add setsar=1 after scaling to the display size: scale=W:H,setsar=1.',
  },
  'fps-max': {
    cause: 'The source frame rate was kept on every rendition.',
    fix: 'Per rendition: -r 30 (or fps=30 in the filter chain) for small rungs; keep the source rate only where it pays.',
  },
  'fps-constant': {
    cause: 'Variable frame-rate input passed through without a constant output rate.',
    fix: '-r <rate> on the output (or -fps_mode cfr) and -vsync/genpts on the input; measure the source with ffprobe -show_entries frame=pts_time first.',
  },
  'gop-fixed': {
    cause: 'Scene-cut detection inserts extra key frames, or keyint_min is below keyint.',
    fix: '-g N -keyint_min N -sc_threshold 0 (x264) with N = seconds × frame rate; for x265 add -x265-params scenecut=0.',
  },
  'gop-length': {
    cause: 'The -g value does not match the intended segment length, or the frame rate used for the calculation was wrong.',
    fix: 'Compute N from the measured output frame rate: -g $(seconds × fps) -keyint_min $(seconds × fps).',
  },
  'gop-max': { cause: 'Scene-cut key frames or a wrong -g value.', fix: '-g N -keyint_min N -sc_threshold 0 with N = max segment seconds × fps.' },
  'closed-gop': {
    cause: 'Open GOPs from -x264-params open-gop=1, or from B-frames referencing across an I-frame that is not an IDR.',
    fix: 'Do not enable open-gop; with -sc_threshold 0 and keyint = keyint_min every key frame is an IDR and the GOP is closed.',
  },
  'key-is-idr': {
    cause: 'Key frames that are recovery points or non-IDR I-frames (open GOP, periodic intra refresh).',
    fix: 'Disable intra refresh (-intra-refresh 0) and open GOP; use -force_key_frames only with IDR-capable settings.',
  },
  'peak-ratio': {
    cause: 'CRF without a VBV cap: hard seconds get as many bits as they want.',
    fix: 'Capped CRF: -crf <q> -maxrate <1.5×target> -bufsize <2×maxrate> per rendition; advertise the measured peak as BANDWIDTH.',
  },
  vbv: {
    cause: 'No -maxrate/-bufsize, or both set to 0.',
    fix: '-maxrate <kbps>k -bufsize <2×kbps>k per rendition (x264 writes vbv_maxrate/vbv_bufsize into the SEI so tools can verify it).',
  },
  scenecut: { cause: 'x264 scene-cut detection left on.', fix: '-sc_threshold 0 (x264) or -x265-params scenecut=0.' },
  'bits-per-pixel': {
    cause: 'CRF too high for the resolution, or a bitrate cap too low for the content.',
    fix: 'Lower the CRF by 1–2 for that rendition, or raise its -maxrate; check with a per-title measurement (PSNR/VMAF).',
  },
  'colour-signalled': {
    cause: 'libx264 writes colour into the SPS only when the frames it receives carry colour properties; -color_primaries/-color_trc/-colorspace on the output are not applied when the input is untagged.',
    fix: 'Tag the frames before the encoder: -vf setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709 (after any conversion), or pass -x264-params colorprim=bt709:transfer=bt709:colormatrix=bt709.',
  },
  'colour-consistent': {
    cause: 'Pixels were tagged with a different colour space than they were converted to (a scale without a matrix conversion, or setparams on unconverted frames).',
    fix: 'Convert, then tag: zscale=m=709:p=709:t=709 (or colorspace=all=bt709) before setparams/encoder flags.',
  },
  'hdr-consistent': {
    cause: 'An HDR (BT.2020/PQ or HLG) source was encoded to 8-bit BT.709 without tone mapping; the transfer tag was copied but the pixels were not converted.',
    fix: 'HDR to SDR: -vf zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p (or libplacebo=tonemapping=...), then tag BT.709; detect HDR from ffprobe color_transfer (smpte2084/arib-std-b67) and color_space (bt2020nc/bt2020c), not from a bit-depth guess.',
  },
  'colour-expected': { cause: 'The source colour tags were passed through instead of being normalised.', fix: 'Convert and tag every rendition to the service standard (see colour-consistent).' },
  range: { cause: 'Full-range input flagged through.', fix: '-vf scale=out_range=tv (or zscale=r=tv) and -color_range tv.' },
  depth: { cause: '10-bit input encoded with a 10-bit pixel format.', fix: '-pix_fmt yuv420p for H.264 renditions.' },
  'audio-codec': { cause: 'The source audio codec was copied, or a non-AAC encoder was chosen.', fix: '-c:a aac (or libfdk_aac) -profile:a aac_low.' },
  'audio-codec-expected': { cause: 'A different AAC flavour than the service standard.', fix: '-c:a libfdk_aac -profile:a aac_low (AAC-LC) or aac_he (HE-AAC) consistently.' },
  'audio-rate': { cause: 'The source sample rate was kept, or a fixed rate that differs from the standard.', fix: '-ar 48000 (or 44100) on every rendition.' },
  'audio-channels': { cause: 'Surround source copied through.', fix: '-ac 2 for the stereo renditions; keep surround only in a dedicated rendition.' },
  'audio-bitrate': { cause: 'Bit rate per channel set too low for AAC-LC.', fix: '≥ 64 kb/s per channel for AAC-LC (stereo 128 kb/s), or switch to HE-AAC below 64 kb/s per channel.' },
  'audio-priming': {
    cause: 'The AAC was carried through MPEG-2 TS (ADTS) and remuxed to MP4 with -c copy: the encoder delay is not signalled, so audio starts late.',
    fix: 'Encode audio straight to MP4/M4A (the mp4 muxer writes the edit list for the encoder delay), or mux from the encoder in one step; if TS is unavoidable, add -af "adelay=-<delay>" / trim the first 2048 samples and check sync with a flash-and-beep clip.',
  },
  loudness: {
    cause: 'Normalisation only applied to outliers, or applied with wrong measured values.',
    fix: 'Two-pass loudnorm on every asset: measure with loudnorm=print_format=json, then loudnorm=I=-16:TP=-1:LRA=11:measured_I=..:measured_TP=..:measured_LRA=..:measured_thresh=..:linear=true.',
  },
  'true-peak': { cause: 'Peaks above the ceiling left untouched because the integrated loudness was within the window.', fix: 'Apply loudnorm (tp=-1) or alimiter=limit=-1dB to every asset, not only to loud or quiet ones.' },
  'av-sync': { cause: 'Audio encoder delay not compensated, or asetpts/aresample resetting audio timestamps.', fix: 'See audio-priming; keep -af aresample=async=1 minimal and do not reset audio pts (asetpts=N/SR/TB) unless the source timestamps are broken.' },
  quality: { cause: 'A conversion step that changed the picture: a deinterlacer on progressive content, wrong colour conversion, or too high a CRF.', fix: 'Compare against the source with ffmpeg -filter_complex psnr/ssim per rendition; gate deinterlacing on field_order in {tt,bb,tb,bt}; use yadif=deint=interlaced.' },
  'idr-aligned': {
    cause: 'Renditions encoded in separate runs with scene-cut on, or with different frame rates, so key frames fall on different frames.',
    fix: 'Encode every rendition from one decode with the same -g/-keyint_min/-sc_threshold 0 and the same -r; or use -force_key_frames expr:gte(t,n_forced*N).',
  },
  'segment-lengths': { cause: 'The key-frame interval does not divide the intended segment length.', fix: 'Choose -g so that segment seconds × fps is a multiple of it (2 s GOP for 6 s segments; 5 s for 5/10 s segments).' },
  'frame-rates': { cause: 'Some renditions at half rate, others at full.', fix: 'Either keep one rate, or halve it only for the lowest renditions (-r 30 below 720p on 60 fps content).' },
  'same-audio': { cause: 'Different audio bit rates or channel counts per video rendition.', fix: 'One audio encode shared by every rendition (or a separate audio rendition group in the playlist).' },
  'bitrate-steps': { cause: 'CRF per rendition without a target, so bitrates land wherever the content takes them.', fix: 'Capped CRF with per-rendition -maxrate to shape the ladder into 1.5–2× steps.' },
  'label-matches-size': { cause: 'The ladder logic keeps the source size on a rung named after a smaller constraint.', fix: 'Name renditions after their actual height (or width for portrait), after scaling.' },
};

/** The remedy for a rule, if any. */
export function remedyFor(id) {
  return REMEDIES[id] ?? null;
}
