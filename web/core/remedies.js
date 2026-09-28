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
    cause: 'The encoder was asked for Baseline or Main, or for a profile above High (High 10, 4:2:2).',
    fix: '-profile:v high on every H.264 rendition (Apple asks for High in preference to Main or Baseline); 8-bit 4:2:0 input (-pix_fmt yuv420p) keeps x264 within High.',
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
    cause: 'Frame rate, size or bit rate beyond what level 5.2 allows.',
    fix: 'Keep H.264 renditions within Level 5.2 (and some at 4.1 or below, e.g. up to 1080p30): lower the frame rate or size of the top rung, or provide it in HEVC.',
  },
  'even-size': {
    cause: 'A scale filter produced an odd dimension when keeping the aspect ratio.',
    fix: 'scale=w=...:h=-2 (or force_divisible_by=2) so both dimensions stay even.',
  },
  'square-pixels': {
    cause: 'The source sample aspect ratio was kept through the encode.',
    fix: 'Add setsar=1 after scaling to the display size: scale=W:H,setsar=1.',
  },
  codec: {
    cause: 'The source codec was copied, or a codec chosen that HLS clients for Apple devices do not decode.',
    fix: '-c:v libx264 (or libx265 with -tag:v hvc1) for the HLS renditions; AV1 only in fMP4 and alongside H.264; keep VP9 for separate DASH/WebM renditions.',
  },
  'b-frames': {
    cause: 'B-frames enabled while Baseline profile was requested.',
    fix: '-profile:v main (or high) when B-frames are wanted; -bf 0 for a Baseline rendition.',
  },
  'fps-range': {
    cause: 'The source frame rate was kept on every rendition.',
    fix: 'Per rendition: -r 30 (or fps=30 in the filter chain) for small rungs; keep the source rate only where it pays.',
  },
  'fps-constant': {
    cause: 'Variable frame-rate input passed through without a constant output rate.',
    fix: '-r <rate> on the output (or -fps_mode cfr) and -vsync/genpts on the input; measure the source with ffprobe -show_entries frame=pts_time first.',
  },
  'gop-fixed': {
    cause: 'Scene-cut detection inserts extra key frames, keyint_min is below keyint, or a chunked encode restarts the GOP at every chunk join.',
    fix: '-g N -keyint_min N -sc_threshold 0 (x264) with N = seconds × frame rate; for x265 add -x265-params scenecut=0. In a chunked encode, start every chunk on a multiple of the GOP length so the grid carries on across the joins.',
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
  'audio-rate': { cause: 'The source sample rate was kept, or a fixed rate that differs from the standard.', fix: '-ar 48000 (or 44100) on every rendition.' },
  'audio-channels': { cause: 'Surround source copied through.', fix: '-ac 2 for the stereo renditions; keep surround only in a dedicated rendition.' },
  'audio-bitrate': { cause: 'Bit rate per channel set too low for AAC-LC.', fix: '≥ 48 kb/s per channel for AAC-LC (96 kb/s stereo; 128 kb/s is the usual choice), or HE-AAC (-profile:a aac_he) below that.' },
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
  'segment-lengths': {
    cause: 'The key-frame interval does not divide the intended segment length, or a GOP cut short (a chunk join in a chunked encode, a forced key frame) moves the key frames after it off the grid.',
    fix: 'Choose -g so that segment seconds × fps is a multiple of it (2 s GOP for 6 s segments; 5 s for 5/10 s segments), and cut chunks of a chunked encode on multiples of the GOP length (or force key frames on the whole file\'s grid with -force_key_frames and each chunk\'s start offset).',
  },
  'frame-rates': { cause: 'Some renditions at half rate, others at full.', fix: 'Either keep one rate, or halve it only for the lowest renditions (-r 30 below 720p on 60 fps content).' },
  'same-audio': { cause: 'Different audio bit rates or channel counts per video rendition.', fix: 'One audio encode shared by every rendition (or a separate audio rendition group in the playlist).' },
  'bitrate-steps': { cause: 'CRF per rendition without a target, so bitrates land wherever the content takes them.', fix: 'Capped CRF with per-rendition -maxrate to shape the ladder into 1.5–2× steps.' },
  'label-matches-size': { cause: 'The ladder logic keeps the source size on a rung named after a smaller constraint.', fix: 'Name renditions after their actual height (or width for portrait), after scaling.' },
  'hls-reachable': {
    cause: 'Segments removed or not yet written, a packager or origin error, or signed URLs that expire before the playlist does.',
    fix: 'Check the origin and CDN logs for the failing URIs; keep every segment a published playlist lists available, and give signed links a lifetime longer than the playlist\'s.',
  },
  'hls-bandwidth': {
    cause: 'BANDWIDTH written from a file\'s average or nominal bit rate, or from video alone without audio and container overhead.',
    fix: 'Compute it from the packaged segments: the largest bit rate of any run of segments lasting 0.5 to 1.5 target durations, audio renditions included (FFmpeg\'s HLS muxer does this with -master_pl_name; Apple\'s mediastreamvalidator reports the measured peak).',
  },
  'hls-average-bandwidth': {
    cause: 'The multivariant playlist is written without AVERAGE-BANDWIDTH, or with a value that is not measured.',
    fix: 'Write AVERAGE-BANDWIDTH as the total segment bits divided by the playlist\'s duration (FFmpeg\'s -master_pl_name writes it).',
  },
  'hls-codecs': {
    cause: 'CODECS written from a fixed table instead of from the stream, or left out.',
    fix: 'Derive it from each rendition\'s configuration (avcC/hvcC bytes: ffprobe -show_streams gives profile and level) and list every format the variant\'s segments carry, audio included.',
  },
  'hls-resolution': { cause: 'RESOLUTION left out, or taken from the rendition\'s name instead of its pictures.', fix: 'Write RESOLUTION=<width>x<height> from the encoded pictures of each variant.' },
  'hls-frame-rate': { cause: 'The playlist writer does not know the frame rate (FFmpeg\'s HLS muxer omits it).', fix: 'Add FRAME-RATE=<fps, three decimals> to every video variant, from the stream.' },
  'hls-segment-durations': {
    cause: 'Key frames further apart than the segment length, so the packager has to wait for the next one; or TARGETDURATION set from the requested length rather than the longest segment.',
    fix: 'Encode with a GOP that divides the segment length (-g, -keyint_min, -sc_threshold 0) and set TARGETDURATION to the longest EXTINF rounded to the nearest integer.',
  },
  'hls-target-duration': { cause: 'A segment length other than Apple\'s 6 s.', fix: '-hls_time 6 with a 2 s GOP (or a GOP that divides 6 s).' },
  'hls-same-target': { cause: 'Variants packaged separately with different segment lengths or GOPs.', fix: 'Package every variant with the same -hls_time and the same key-frame interval.' },
  'hls-aligned': { cause: 'Renditions encoded separately, or with scene-cut key frames, so their segment boundaries differ.', fix: 'Encode every rendition from one decode with the same -g/-keyint_min/-sc_threshold 0, and package them with the same segment length.' },
  'hls-same-duration': { cause: 'Renditions cut from differently trimmed sources, or an audio track longer than the video.', fix: 'Encode every rendition from the same trimmed source (-t on the input), and trim audio to the video.' },
  'hls-playlist-type': { cause: 'The VOD playlist is written without its type.', fix: '-hls_playlist_type vod (or add #EXT-X-PLAYLIST-TYPE:VOD).' },
  'hls-iframes': {
    cause: 'The packager writes no I-frame playlists.',
    fix: 'Generate I-frame playlists (EXT-X-I-FRAME-STREAM-INF) with the packager, ideally dense ones at one frame per second (Apple 6.2); most packagers, Apple\'s mediafilesegmenter among them, can write them.',
  },
  'hls-starts-idr': { cause: 'Segments cut where there is no key frame, or key frames that are not IDRs (open GOP, recovery points).', fix: 'Force key frames at every segment start: -g N -keyint_min N -sc_threshold 0 with N dividing the segment length, and no open GOP.' },
  'hls-independent': { cause: 'The multivariant playlist does not say that segments start with an IDR.', fix: '-hls_flags independent_segments (or add #EXT-X-INDEPENDENT-SEGMENTS to the multivariant playlist).' },
  'hls-version': { cause: 'EXT-X-VERSION written as a constant, not from the tags the playlist uses.', fix: 'Declare the lowest version that covers the tags (3 for decimal EXTINF, 4 for BYTERANGE, 6 for EXT-X-MAP), and drop PROGRAM-ID from version 6 on.' },
};

/** The remedy for a rule, if any. */
export function remedyFor(id) {
  return REMEDIES[id] ?? null;
}
