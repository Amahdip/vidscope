// Glossary for FLV: the structures Vidscope shows in the tree (cat 'box',
// term = the node type) and the concepts a newcomer needs (cat 'concept').

const ERTMP = 'https://github.com/veovera/enhanced-rtmp';

const box = (term, name, kcat, desc, more, url) => ({ term, name, cat: 'box', kcat, desc, more, url });
const concept = (term, name, desc, more, url) => ({ term, name, cat: 'concept', desc, more, url });

const ENTRIES = [
  box('header', 'FLV header', 'type',
    'The 9-byte file header: "FLV", version 1, two flags (audio present, video present) and DataOffset, the header size.',
    'The flags are hints; players still discover the streams from the tags.'),
  box('PreviousTagSize0', 'PreviousTagSize0', 'header',
    'The 4-byte zero that starts the FLV body, before the first tag.'),
  box('script', 'Script data tag (TagType 18)', 'meta',
    'A tag holding AMF0 values: a name (usually "onMetaData") and a value (an ECMA array of properties).',
    'Also used for cue points (onCuePoint), captions (onTextData) and other messages sent over RTMP.'),
  box('video', 'Video tag (TagType 9)', 'media',
    'One video frame, a decoder configuration, or an end-of-sequence marker, behind a 1-byte (5 for AVC) video tag header.'),
  box('audio', 'Audio tag (TagType 8)', 'media',
    'Audio data (one AAC frame, MP3 frames...) or the AAC configuration, behind a 1-byte (2 for AAC) audio tag header.'),
  box('tags', 'Group of tags', 'media',
    'Not part of the file: Vidscope groups consecutive tags so that files with hundreds of thousands of tags stay browsable.'),
  concept('FLV tag', 'FLV tag',
    'The unit of an FLV file: an 11-byte header (TagType, DataSize, Timestamp, TimestampExtended, StreamID), the data, then a 4-byte PreviousTagSize.',
    'Tags are the RTMP messages of a live stream written to disk one after the other, which is why FLV is still the format of RTMP ingest (OBS, streaming platforms) even though Flash Player is gone.'),
  concept('PreviousTagSize', 'PreviousTagSize (back-pointer)',
    'The 32-bit value after each tag giving the size of that tag (11 + DataSize).',
    'It lets a reader walk the file backwards from the end, and a mismatch is the simplest way to detect corruption or lost sync.'),
  concept('Timestamp', 'Timestamp and TimestampExtended',
    'A tag\'s time in milliseconds: 24 bits in Timestamp plus 8 upper bits in TimestampExtended, forming a signed 32-bit value. For video it is the decoding time (DTS).',
    'Millisecond resolution means frame times are rounded (40 ms at 25 fps, 33/34 ms at 29.97 fps). Without the extension byte timestamps would wrap after 4 h 39 min.'),
  concept('StreamID', 'StreamID', 'A 24-bit field that is always 0 in FLV files; it comes from the RTMP message stream ID.'),
  concept('AMF0', 'Action Message Format 0',
    'The binary serialisation of ActionScript values used in script tags: a type marker (0 number, 1 boolean, 2 string, 3 object, 8 ECMA array, 10 strict array...) followed by the value, big-endian.',
    'Numbers are always 64-bit doubles, so even integers like width and filesize are stored as floating point.'),
  concept('onMetaData', 'onMetaData',
    'The script tag at the start of an FLV with duration, width, height, framerate, codec IDs, data rates, file size, encoder name and optionally a keyframes index.',
    'The muxer writes it (often after the fact, by rewriting the start of the file); nothing validates it, so it can disagree with the stream.'),
  concept('keyframes', 'keyframes index (onMetaData)',
    'An object with two arrays, filepositions and times, listing every key frame. Not in the FLV specification but added by yamdi, flvtool2 or FFmpeg (-flvflags add_keyframe_index).',
    'It lets a player seek in an HTTP progressive download by requesting the file from a key frame\'s byte position, the way Flash players used "?start=" URLs.'),
  concept('SoundFormat', 'SoundFormat, SoundRate, SoundSize, SoundType',
    'The first byte of audio data: codec (2 MP3, 10 AAC, 11 Speex, 4–6 Nellymoser...), sample rate (5.5/11/22/44 kHz), 8/16-bit and mono/stereo.',
    'For AAC these bits are fixed (44 kHz, 16-bit, stereo) and ignored; the real values are in the AudioSpecificConfig.'),
  concept('AACPacketType', 'AACPacketType', 'The second byte of an AAC audio tag: 0 = AAC sequence header (the AudioSpecificConfig), 1 = a raw AAC frame.'),
  concept('AAC sequence header', 'AAC sequence header', 'The audio tag with AACPacketType 0 that carries the 2+ byte AudioSpecificConfig (profile, sample rate, channels) before the first AAC frame.'),
  concept('FrameType', 'FrameType', 'The upper 4 bits of the first video data byte: 1 key frame (decoding can start here), 2 inter frame, 3 disposable inter frame (H.263), 4 generated key frame, 5 video info / command frame.', 'It is the only key-frame information in an FLV; seeking relies on it.'),
  concept('CodecID', 'CodecID', 'The lower 4 bits of the first video data byte: 2 Sorenson H.263, 3 Screen video, 4 On2 VP6, 5 VP6 with alpha, 6 Screen video 2, 7 AVC (H.264). Newer codecs use Enhanced RTMP FourCCs instead.'),
  concept('AVCPacketType', 'AVCPacketType', 'After FrameType/CodecID in AVC tags: 0 = AVC sequence header (AVCDecoderConfigurationRecord), 1 = NAL units of a frame, 2 = end of sequence.'),
  concept('CompositionTime', 'CompositionTime',
    'A signed 24-bit millisecond offset in AVC (and HEVC) video tags: presentation time = tag timestamp + CompositionTime.',
    'It is the FLV equivalent of MP4\'s ctts, needed when B-frames make display order differ from decoding order.'),
  concept('AVC sequence header', 'AVC sequence header',
    'The video tag with AVCPacketType 0 holding the AVCDecoderConfigurationRecord (SPS, PPS, NAL length size), the same record as an MP4 avcC box.',
    'It must precede the first frame; a live encoder sends a new one when its parameters change.'),
  concept('Enhanced RTMP', 'Enhanced RTMP / Enhanced FLV',
    'The 2023 extension (Veovera, adopted by FFmpeg, OBS and YouTube) that brings HEVC, AV1, VP9, and later Opus, FLAC, AC-3 and multitrack audio to RTMP and FLV.',
    'Video tags set IsExHeader (the top bit of the first byte), then a 3-bit FrameType, a 4-bit PacketType (SequenceStart, CodedFrames, CodedFramesX, SequenceEnd, Metadata...) and a FourCC (hvc1, av01, vp09). Audio uses SoundFormat 9 with a FourCC.', ERTMP),
  concept('Sorenson Spark', 'Sorenson Spark (H.263)', 'The video codec of Flash Player 6 (CodecID 2): a variant of H.263. Obsolete; not supported by browsers.'),
  concept('VP6', 'On2 VP6', 'The video codec of Flash Player 8 (CodecID 4, or 5 with an alpha channel). Obsolete.'),
  concept('Nellymoser', 'Nellymoser Asao', 'A low-bitrate speech codec used by Flash for microphone input (SoundFormat 4–6). Obsolete.'),
  concept('F4V', 'FLV vs F4V', 'F4V (Flash Player 9.0.115+) is an MP4 (ISO-BMFF) file, not FLV: same era and players, entirely different structure.'),
];

export function glossary() {
  return ENTRIES;
}
