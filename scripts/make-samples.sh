#!/bin/sh
# Generates small test files in samples/ with FFmpeg (a few seconds each).
# Used by the tests, and handy for exploring Vidscope: npm start
set -e
cd "$(dirname "$0")/.."
command -v ffmpeg >/dev/null 2>&1 || { echo "make-samples: ffmpeg is required" >&2; exit 1; }
mkdir -p samples
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

FF="ffmpeg -hide_banner -loglevel error -y"
export SVT_LOG=1 # keep the SVT-AV1 encoder quiet
V="-f lavfi -i testsrc2=size=640x360:rate=25:duration=4"
A="-f lavfi -i sine=frequency=440:sample_rate=48000:duration=4"
V2="-f lavfi -i testsrc2=size=640x360:rate=25:duration=2"
VS="-f lavfi -i testsrc2=size=320x240:rate=25:duration=2"
A1="-f lavfi -i sine=frequency=440:sample_rate=48000:duration=1"
A2="-f lavfi -i sine=frequency=440:sample_rate=48000:duration=2"
A44="-f lavfi -i sine=frequency=440:sample_rate=44100:duration=2"
H264="-c:v libx264 -preset veryfast -profile:v high -pix_fmt yuv420p -g 50 -bf 2"
AAC="-c:a aac -b:a 96k"

made=0
failed=""
ok() {
  made=$((made + 1))
  printf '  %s\n' "$1"
}
fail() {
  failed="$failed $1"
  rm -f "samples/$1"
}
run() {
  name=$1
  shift
  if $FF "$@" "samples/$name" </dev/null; then ok "$name"; else fail "$name"; fi
}
# The muxer writes to a pipe, so it cannot go back to fill in sizes or write an index.
run_piped() {
  name=$1
  shift
  if $FF "$@" pipe:1 </dev/null >"samples/$name"; then ok "$name"; else fail "$name"; fi
}

printf '1\n00:00:00,500 --> 00:00:02,000\nHello from Vidscope\n\n2\n00:00:02,200 --> 00:00:03,800\nSecond subtitle\n' > "$TMP/subs.srt"
printf '1\n00:00:00,300 --> 00:00:01,200\n{\\b1}Bold{\\b0} line\n\n2\n00:00:01,400 --> 00:00:01,900\nSecond line\n' > "$TMP/styled.srt"
printf ';FFMETADATA1\ntitle=Vidscope chapters\n\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=2000\ntitle=Opening\n\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=2000\nEND=4000\ntitle=Ending\n' > "$TMP/chapters.txt"
$FF -f lavfi -i color=c=red:s=64x64 -frames:v 1 "$TMP/cover.png" </dev/null || true

echo "Writing samples/:"
# MP4 family
run h264-aac.mp4 $V $A $H264 $AAC -metadata title="Vidscope sample" -metadata comment="made by make-samples.sh"
run h264-aac-faststart.mp4 $V $A $H264 $AAC -movflags +faststart
run h264-aac-fragmented.mp4 $V $A $H264 -g 25 $AAC -movflags frag_keyframe+empty_moov+default_base_moof
run h264-aac-dash-sidx.mp4 $V $A $H264 -g 25 $AAC -movflags frag_keyframe+empty_moov+default_base_moof+global_sidx+cmaf
run hevc-aac.mp4 $V $A -c:v libx265 -preset ultrafast -tag:v hvc1 -x265-params log-level=error $AAC
run hevc-10bit-hdr.mp4 -f lavfi -i testsrc2=size=640x360:rate=24:duration=2 -c:v libx265 -preset ultrafast -tag:v hvc1 -pix_fmt yuv420p10le \
  -color_primaries bt2020 -color_trc smpte2084 -colorspace bt2020nc \
  -x265-params "log-level=error:hdr10=1:colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc:master-display=G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(10000000,50):max-cll=1000,400"
run av1-opus.mp4 $V $A -c:v libsvtav1 -preset 12 -c:a libopus -b:a 64k
run h264-ac3.mp4 $V $A $H264 -c:a ac3 -b:a 192k
run h264-eac3.mp4 $V $A $H264 -c:a eac3 -b:a 192k
run h264-cenc.mp4 $V $A $H264 $AAC -encryption_scheme cenc-aes-ctr -encryption_key 76a6c65c5ea762046bd749a2e632ccbb -encryption_kid a7e61c373e219033c21091fa607bf3b8
# Stream copy keeps the rotation as tkhd matrix metadata (re-encoding would rotate the pixels).
run h264-rotated.mp4 -display_rotation 90 -i samples/h264-aac.mp4 -c copy -an
run h264-aac-subs-chapters.mp4 $V $A -i "$TMP/subs.srt" -i "$TMP/chapters.txt" -map 0:v -map 1:a -map 2:s -map_metadata 3 -map_chapters 3 $H264 $AAC -c:s mov_text
run h264-aac.mov $V $A $H264 $AAC -timecode 01:00:00:00
run aac.m4a $A $AAC -metadata title="Sine wave" -metadata artist="Vidscope" -metadata album="Samples" -metadata track="3/12"
run still.avif -f lavfi -i testsrc2=size=320x240 -frames:v 1 -c:v libaom-av1 -still-picture 1 -f avif

# Matroska / WebM
run h264-aac.mkv $V $A -i "$TMP/subs.srt" -i "$TMP/chapters.txt" -map 0:v -map 1:a -map 2:s -map_chapters 3 $H264 $AAC -c:s srt -metadata title="Vidscope Matroska sample"
run vp9-opus.webm $V $A -c:v libvpx-vp9 -deadline realtime -cpu-used 8 -b:v 500k -c:a libopus -b:a 64k
# Live mode: Segment and Clusters of unknown size, no Cues.
run matroska-live.webm -i samples/vp9-opus.webm -c copy -live 1
run matroska-hevc-hdr.mkv -i samples/hevc-10bit-hdr.mp4 -c copy
run matroska-av1-opus.mkv -i samples/av1-opus.mp4 -c copy
run matroska-vp8-vorbis.webm $VS $A44 -c:v libvpx -b:v 300k -c:a libvorbis
run matroska-mpeg4-mp3-ac3.mkv $VS $A2 -map 0:v -map 1:a -map 1:a -c:v mpeg4 -q:v 5 -c:a:0 libmp3lame -b:a:0 128k -c:a:1 ac3 -b:a:1 192k
run matroska-flac-ass.mkv $A2 -i "$TMP/styled.srt" -attach "$TMP/cover.png" -metadata:s:t mimetype=image/png -metadata:s:t filename=cover.png \
  -map 0:a -map 1:s -c:a flac -c:s ass

# MPEG transport streams
run h264-aac.ts $V $A $H264 $AAC -f mpegts
run hevc-ac3.ts $V $A -c:v libx265 -preset ultrafast -x265-params log-level=error -c:a ac3 -f mpegts
# 192-byte packets (a 4-byte timestamp before each packet), as on Blu-ray and AVCHD.
run mpegts-h264-aac.m2ts -i samples/h264-aac.ts -c copy -f mpegts -mpegts_m2ts_mode 1
# Constant bitrate: the muxer pads with null packets.
run mpegts-mpeg2-mp2-cbr.ts -f lavfi -i testsrc2=size=640x360:rate=25:duration=3 -f lavfi -i sine=frequency=440:sample_rate=48000:duration=3 \
  -c:v mpeg2video -q:v 5 -g 12 -bf 2 -c:a mp2 -b:a 128k -metadata:s:a:0 language=eng -f mpegts -muxrate 3000000
run mpegts-2programs-dvb.ts $VS $A2 -f lavfi -i testsrc=size=320x240:rate=25:duration=2 -f lavfi -i sine=frequency=880:sample_rate=44100:duration=2 \
  -map 0:v -map 1:a -map 2:v -map 3:a -c:v libx264 -preset veryfast -g 25 -c:a:0 eac3 -b:a:0 96k -c:a:1 ac3 -b:a:1 96k \
  -metadata:s:a:0 language=eng -metadata:s:a:1 language=fra \
  -program program_num=1:title=First:st=0:st=1 -program program_num=2:title=Second:st=2:st=3 -mpegts_flags system_b -f mpegts
# 20 audio tracks, so the PMT no longer fits in one packet.
MAPS=""
META=""
i=0
for l in eng fra deu spa ita nld por swe nor dan fin pol ces hun ron ell tur rus ukr jpn; do
  MAPS="$MAPS -map 1:a"
  META="$META -metadata:s:a:$i language=$l"
  i=$((i + 1))
done
run mpegts-20-audio-langs.ts -f lavfi -i testsrc2=size=320x240:rate=25:duration=1 $A1 -map 0:v $MAPS \
  -c:v libx264 -preset veryfast -pix_fmt yuv420p -g 25 -c:a mp2 -b:a 64k $META -f mpegts
run mpegts-h264-aac-latm.ts $VS $A44 -c:v libx264 -preset veryfast -pix_fmt yuv420p -c:a aac -b:a 96k -mpegts_flags latm -f mpegts

# AVI and WAV (RIFF)
run mpeg4-mp3.avi $V $A -c:v mpeg4 -q:v 5 -c:a libmp3lame -b:a 128k
run h264-pcm.avi $V $A $H264 -c:a pcm_s16le
run_piped riff-noindex.avi -i samples/mpeg4-mp3.avi -c copy -f avi
run riff-h264-aac.avi $V2 $A2 $H264 $AAC
run riff-mjpeg-ac3.avi $V2 $A2 -c:v mjpeg -q:v 5 -c:a ac3 -b:a 192k
run pcm.wav $A -c:a pcm_s16le
run riff-float51.wav $A1 -af "pan=5.1|c0=c0|c1=c0|c2=c0|c3=c0|c4=c0|c5=c0" -c:a pcm_f32le
run riff-bwf.wav $A1 -c:a pcm_s24le -write_bext 1 -metadata description="Vidscope test tone" -metadata originator="Vidscope" \
  -metadata originator_reference="VS0001" -metadata origination_date="2026-09-22" -metadata origination_time="12:34:56" \
  -metadata time_reference=172800000 -metadata coding_history="A=PCM,F=48000,W=24,M=mono,T=Vidscope"
run riff-rf64.wav $A1 -c:a pcm_s16le -rf64 always
run riff-mp3.wav $A1 -c:a libmp3lame -b:a 128k -f wav
run riff-adpcm.wav $A1 -c:a adpcm_ima_wav
run riff-peak.wav $A1 -c:a pcm_s16le -write_peak on

# FLV (the HEVC, VP9, AV1 and Opus ones use Enhanced RTMP tags)
run h264-aac.flv $V $A $H264 $AAC
run flv-h264-mp3-keyframes.flv $V $A -c:v libx264 -g 25 -c:a libmp3lame -ar 44100 -flvflags add_keyframe_index
run flv-hevc-opus.flv $V2 $A2 -c:v libx265 -preset ultrafast -x265-params log-level=error -c:a libopus -b:a 64k
run flv-vp9-aac.flv $V2 $A2 -c:v libvpx-vp9 -deadline realtime -cpu-used 8 -c:a aac
run flv-av1-aac.flv $V2 $A2 -c:v libsvtav1 -preset 12 -c:a aac
run flv-sorenson-mp3.flv $V2 $A2 -c:v flv -c:a libmp3lame -ar 44100

# A small bitrate ladder, converted from one source the way streaming services do (Compare view).
# The versions share a 1 s GOP with no scene-cut key frames, so their key frames line up; the
# -g 40 one does not. The remux copies the source's video and audio without re-encoding.
run ladder-source.mkv $V $A -i "$TMP/subs.srt" -map 0:v -map 1:a -map 2:s -c:v libx264 -preset veryfast -crf 18 -pix_fmt yuv420p -g 100 \
  -c:a aac -b:a 192k -ac 6 -c:s srt
LADDER="-c:v libx264 -preset veryfast -pix_fmt yuv420p -g 25 -keyint_min 25 -sc_threshold 0 -c:a aac -ac 2 -sn -movflags +faststart"
run ladder-270p.mp4 -i samples/ladder-source.mkv $LADDER -vf scale=-2:270 -crf 26 -maxrate 500k -bufsize 1000k -b:a 96k
run ladder-180p.mp4 -i samples/ladder-source.mkv $LADDER -vf scale=-2:180 -crf 28 -maxrate 250k -bufsize 500k -b:a 64k
run ladder-180p-gop40.mp4 -i samples/ladder-source.mkv $LADDER -vf scale=-2:180 -crf 28 -g 40 -keyint_min 40 -b:a 64k
run ladder-remux.mp4 -i samples/ladder-source.mkv -map 0:v -map 0:a -c copy

echo "Done: $made files in samples/"
if [ -n "$failed" ]; then
  echo "Skipped (your FFmpeg build lacks an encoder or muxer):$failed"
fi
