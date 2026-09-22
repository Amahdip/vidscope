// Glossary for RIFF files (AVI and WAV): the chunks Vidscope shows in the tree
// (cat 'box', term = the chunk's type in the tree) and the concepts a newcomer
// needs (cat 'concept').

import { SPECS } from './chunks.js';

const AVI = SPECS.AVI.href;
const WFX = SPECS.WAVEFORMATEX.href;
const WFXE = SPECS.WAVEFORMATEXTENSIBLE.href;
const BIH = SPECS.BITMAPINFOHEADER.href;
const BWF = SPECS.BWF.href;
const RIFF = SPECS.RIFF.href;

const box = (term, name, kcat, desc, more, url) => ({ term, name, cat: 'box', kcat, desc, more, url });
const concept = (term, name, desc, more, url) => ({ term, name, cat: 'concept', desc, more, url });

const COMMON = [
  concept('RIFF chunk', 'Chunk (ckID, ckSize, data, pad)',
    'The only building block of a RIFF file: a four-character ID, a 32-bit size (little-endian), the data, and one pad byte if the size is odd.',
    'Readers walk a RIFF file chunk by chunk and skip the IDs they do not know using ckSize. Sizes never include the 8-byte header or the pad byte. Two chunk IDs hold other chunks: RIFF (the whole file) and LIST.', RIFF),
  concept('LIST', 'LIST chunk',
    'A chunk that groups other chunks. Its data starts with a four-character list type (hdrl, strl, movi, INFO...) followed by sub-chunks.',
    'Vidscope shows a LIST by its list type (hdrl, movi...) because that is what identifies it; the chunk ID itself is always \'LIST\'.', RIFF),
  concept('FOURCC (RIFF)', 'Four-character codes in RIFF',
    'RIFF names everything with four ASCII bytes: chunk IDs (\'avih\', \'fmt \'), list and form types (\'movi\', \'WAVE\'), and codecs (\'H264\', \'XVID\', \'MJPG\' in a BITMAPINFOHEADER).',
    'Spaces are significant: \'fmt \', \'rec \' and \'AVI \' end with a space. Codec FOURCCs in AVI are compared case-insensitively by most players but are not standardised: the same codec may appear as XVID, xvid or FMP4.'),
  concept('pad byte', 'Word alignment',
    'Every RIFF chunk starts on an even offset. When a chunk\'s size is odd, one pad byte (normally 0) follows it and is not counted in ckSize.',
    'Writers that forget the pad byte, or readers that forget to skip it, lose sync at the next chunk. Vidscope shows the pad as a field of the chunk and warns when it is missing.'),
  concept('form type', 'RIFF form type',
    'The four-character code after the RIFF header that says what the file is: \'AVI \' for video, \'WAVE\' for audio, \'AVIX\' for an OpenDML continuation (also \'WEBP\', \'RMID\' for other RIFF-based formats).'),
  box('RIFF', 'RIFF chunk (the file)', 'type',
    'The outer chunk that makes up the file, with its form type (AVI , AVIX, WAVE).',
    'Its size should be the file size minus 8. RF64 and BW64 files use the IDs \'RF64\'/\'BW64\' with size 0xFFFFFFFF and give the real size in ds64.', RIFF),
  box('INFO', 'INFO list (metadata)', 'meta',
    'Text metadata chunks: INAM (title), IART (artist), ICMT (comment), ICRD (date), ISFT (software)...',
    'Each is a NUL-terminated string. FFmpeg writes ISFT with its library version (Lavf...).'),
  box('JUNK', 'JUNK (filler)', 'free',
    'A chunk to skip: padding for alignment, or space reserved so headers can grow without moving the media.',
    'FFmpeg reserves JUNK in AVI headers for OpenDML indexes and fills it only when the file grows past 1 GB.', AVI),
];

const AVI_ENTRIES = [
  box('hdrl', 'Header list', 'header', 'The AVI headers: avih, then one strl per stream, then optionally odml.', 'Players read it before any media to learn the streams, codecs, frame rates and sizes.', AVI),
  box('avih', 'Main AVI header (MainAVIHeader)', 'header', 'File-wide values: frame period, total frames of the first RIFF, stream count, buffer size, picture size and flags (AVIF_HASINDEX...).', 'Mostly informative: stream timing comes from strh and the frame list from the index.', SPECS.AVIMAINHEADER.href),
  box('strl', 'Stream list', 'track', 'One per stream, in stream-number order: the n-th strl describes the frames stored in chunks named \'nn..\'.', 'Holds strh, strf and optionally strd, strn, indx and vprp.', AVI),
  box('strh', 'Stream header (AVISTREAMHEADER)', 'header', 'Stream type (vids, auds, txts), codec handler and clock: dwRate / dwScale units per second, dwStart and dwLength in those units.', 'Frame n of a stream is presented at (dwStart + n) × dwScale / dwRate seconds; this is the only timing information AVI has.', SPECS.AVISTREAMHEADER.href),
  box('strf', 'Stream format', 'codec', 'A BITMAPINFOHEADER for video or a WAVEFORMATEX for audio, possibly followed by codec setup data.', 'This is where the codec is declared: biCompression (a FOURCC) for video, wFormatTag for audio.', AVI),
  box('strd', 'Stream data', 'codec', 'Codec driver settings stored with the stream (opaque, codec-specific). Rare.', null, AVI),
  box('strn', 'Stream name', 'meta', 'A NUL-terminated display name for the stream.', null, AVI),
  box('vprp', 'Video properties header', 'header', 'OpenDML video properties: video standard, refresh rate, frame aspect ratio and the valid area of each field.', 'dwFrameAspectRatio is how an AVI signals the display aspect ratio (16:9 or 4:3).'),
  box('indx', 'OpenDML super index', 'index', 'Per-stream index of index chunks: the 64-bit position, size and duration of each ix## chunk.', 'It replaces idx1 for files beyond 1 GB and lets a player load only the part of the index it needs.'),
  box('ix00', 'OpenDML standard index (ix##)', 'index', 'The frame positions (relative to a 64-bit base), sizes and key-frame flags of one stream within one movi list.', 'Bit 31 of each size marks a delta (non-key) frame. The ## is the stream number: ix00, ix01...'),
  box('odml', 'OpenDML header list', 'header', 'Marks an OpenDML (AVI 2.0) file and holds dmlh.'),
  box('dmlh', 'Extended AVI header', 'header', 'dwTotalFrames for the whole file (avih only counts the first RIFF chunk).'),
  box('movi', 'Movie data list', 'media', 'All the media, one chunk per frame: \'00dc\' (stream 0 compressed video), \'01wb\' (stream 1 audio)... OpenDML files also store their ix## indexes here.', 'Chunks are interleaved by time so a player reading in order gets audio and video together.', AVI),
  box('rec ', 'Record list', 'media', 'Groups chunks that should be read in one operation (a video frame and its audio).', 'A CD-ROM era optimisation, rarely used today.', AVI),
  box('idx1', 'Legacy AVI index (AVIOLDINDEX)', 'index', 'One 16-byte entry per chunk in movi: chunk ID, flags (AVIIF_KEYFRAME), offset and size.', 'Offsets are relative to the \'movi\' list (usually) or absolute (some old files). It only covers the first RIFF chunk and 32-bit positions.', SPECS.AVIOLDINDEX.href),
  box('00dc', 'Compressed video frame (##dc)', 'media', 'One video frame of stream 00 exactly as the codec produced it. Uncompressed frames use ##db, palette changes ##pc.', 'An empty (0-byte) chunk is a dropped frame that keeps the timing of the following frames.', AVI),
  box('01wb', 'Audio chunk (##wb)', 'media', 'Audio data of stream 01: PCM samples or compressed frames.', 'For PCM and CBR audio the chunk boundaries are arbitrary; time is counted in bytes (dwSampleSize).', AVI),
  concept('AVIX', 'RIFF AVIX (OpenDML continuation)', 'The extra RIFF chunks that follow the first RIFF \'AVI \' chunk in an OpenDML file. Each holds one movi list (about 1 GB).', 'AVI 1.0 players stop at the end of the first RIFF chunk and so play only the beginning of the file.'),
  concept('OpenDML', 'OpenDML AVI extensions (AVI 2.0)', 'The 1996 extensions that let AVI exceed 1–2 GB: RIFF \'AVIX\' continuation chunks, 64-bit super indexes (indx) and standard indexes (ix##), the odml/dmlh header and vprp video properties.', 'Written by capture tools, VirtualDub and FFmpeg once a file passes about 1 GB.'),
  concept('BITMAPINFOHEADER', 'BITMAPINFOHEADER', 'The Windows bitmap header AVI reuses to describe video: width, height (negative = top-down rows), bits per pixel and biCompression, the codec FOURCC (0 = uncompressed RGB).', 'biSize can be larger than 40 when codec setup data (MPEG-4 VOL, H.264 SPS/PPS, a palette) follows.', BIH),
  concept('WAVEFORMATEX', 'WAVEFORMATEX', 'The Windows audio format header used by WAV \'fmt \' and AVI audio \'strf\': format tag, channels, sample rate, byte rate, block align, bits per sample, then cbSize bytes of codec-specific extension.', 'PCMWAVEFORMAT is the older 16-byte version without cbSize; WAVEFORMATEXTENSIBLE (tag 0xFFFE) adds the channel mask and a SubFormat GUID.', WFX),
  concept('dwScale/dwRate', 'Stream clock (dwRate / dwScale)', 'The rate of an AVI stream as a fraction: dwRate / dwScale units per second. 25/1 is 25 fps, 30000/1001 is NTSC 29.97 fps; for audio it is blocks per second (the sample rate for PCM).'),
  concept('dwSampleSize', 'Fixed or variable sample size', 'In strh: the size of one sample when all have the same size (PCM: nBlockAlign), and then time is computed from byte counts; 0 when sizes vary (video, VBR audio), and then each chunk is one sample.'),
  concept('AVIIF_KEYFRAME', 'Key-frame flag (0x10)', 'The idx1 flag that marks a chunk as a key frame. It is the only place an AVI records key frames (in OpenDML indexes the equivalent is bit 31 of the size being clear).'),
  concept('drop frame', 'Empty chunk / dropped frame', 'A video chunk with size 0. Because AVI has no timestamps, a frame that was dropped or repeated must still take its place in the stream, or all later frames would play early.'),
  concept('packed bitstream', 'Packed bitstream (DivX/Xvid)', 'A hack to store MPEG-4 ASP B-frames in AVI: a P-frame and the following B-frame are packed into one chunk and the next chunk holds a tiny "N-VOP" placeholder.', 'AVI timing is one frame per chunk in storage order, which cannot express reordering. FFmpeg\'s mpeg4_unpack_bframes filter undoes the packing.'),
  concept('VBR MP3 in AVI', 'Variable-bitrate MP3 in AVI', 'AVI audio timing assumes a constant byte rate. VBR MP3 works only with the convention of one MP3 frame per chunk (dwSampleSize 0, nBlockAlign = 1152), popularised by VirtualDub and Nandub; otherwise players drift out of sync.'),
  concept('AVI timing', 'Time in AVI', 'AVI has no timestamps: a frame\'s time is its index in its stream × dwScale / dwRate. Consequences: dropped frames need empty chunks, B-frames need hacks (packed bitstream) or players that rebuild the order, and FFmpeg reports H.264-in-AVI frames without PTS.'),
];

const WAV_ENTRIES = [
  box('fmt ', 'Format chunk', 'codec', 'The WAVEFORMATEX describing the audio in data: codec, channels, sample rate, byte rate, block size, bits per sample.', 'Must come before data for streaming readers.', WFX),
  box('data', 'Audio data chunk', 'media', 'The samples: for PCM a plain run of interleaved sample frames, no headers, no timestamps.', 'Duration = data size ÷ nAvgBytesPerSec; a position in bytes converts to time by the same division.'),
  box('fact', 'Fact chunk', 'header', 'The sample count (per channel) of compressed audio, whose duration cannot be computed from the byte count.'),
  box('bext', 'Broadcast audio extension', 'meta', 'Broadcast Wave metadata: description, originator, date and time, TimeReference (samples since midnight), UMID, loudness (version 2) and coding history.', 'The time reference places the recording on a time-of-day timeline so it can be synchronised with picture.', BWF),
  box('ds64', 'RF64 size chunk', 'header', 'The 64-bit sizes of the file and the data chunk in RF64/BW64 files, where the 32-bit fields hold 0xFFFFFFFF.'),
  box('cue ', 'Cue points', 'meta', 'Named markers at sample positions (take starts, loop points).'),
  box('adtl', 'Associated data list', 'meta', 'Labels (labl), notes (note) and labelled text regions (ltxt) attached to cue points.'),
  box('smpl', 'Sampler chunk', 'meta', 'MIDI unity note, tuning and loop points for samplers.'),
  box('inst', 'Instrument chunk', 'meta', 'Base note, fine tuning, gain, and key/velocity range for mapping the sample onto a keyboard.'),
  box('levl', 'Peak envelope', 'meta', 'Pre-computed peak levels (EBU Tech 3285 supplement 3) for drawing waveforms quickly.'),
  box('iXML', 'iXML metadata', 'meta', 'Production metadata from location recorders as XML: scene, take, track names, timecode.'),
  box('axml', 'XML metadata (axml)', 'meta', 'XML metadata, usually the Audio Definition Model (ADM) for immersive audio.'),
  box('chna', 'Channel allocation', 'meta', 'Links each channel of the file to its ADM description.'),
  box('id3 ', 'ID3 tag', 'meta', 'An ID3v2 tag (MP3-style metadata) stored in a chunk. Not part of the WAV specification, but widely read.'),
  concept('WAVE_FORMAT_EXTENSIBLE', 'WAVE_FORMAT_EXTENSIBLE (0xFFFE)', 'The fmt extension that adds wValidBitsPerSample, dwChannelMask (speaker positions) and a SubFormat GUID naming the real format.', 'Required by Microsoft for more than two channels or more than 16 bits per sample, so the layout and precision are explicit.', WFXE),
  concept('channel mask', 'dwChannelMask (speaker positions)', 'One bit per loudspeaker position (FL, FR, FC, LFE, BL, BR, FLC, FRC, BC, SL, SR, then top positions). Channels in the data appear in the order of the bits that are set: 0x3F is 5.1 (FL FR FC LFE BL BR).', null, WFXE),
  concept('PCM', 'PCM (pulse-code modulation)', 'Uncompressed audio: each sample is a number (8-bit unsigned, 16/24/32-bit signed integers, or 32/64-bit floats), channels interleaved sample by sample.'),
  concept('nBlockAlign', 'Block align / sample frame', 'The smallest unit of audio data. For PCM it is one sample frame (one sample for every channel): channels × bytes per sample. Positions in the data must be multiples of it.'),
  concept('ADPCM', 'ADPCM', 'Adaptive differential PCM (IMA, Microsoft): about 4 bits per sample, stored in independent blocks of nBlockAlign bytes that start with a small uncompressed header.'),
  concept('RF64', 'RF64 / BW64', 'WAV variants for files over 4 GB (EBU Tech 3306 and ITU-R BS.2088): the RIFF and data sizes are set to 0xFFFFFFFF and the real 64-bit sizes are in ds64.'),
  concept('BWF', 'Broadcast Wave Format', 'A WAV file with a bext chunk (EBU Tech 3285): the exchange format of radio, TV and film sound.', null, BWF),
];

export function glossary(doc) {
  const form = doc?.ctx?.form;
  if (form === 'WAVE') return [...COMMON, ...WAV_ENTRIES, ...AVI_ENTRIES.filter((e) => e.cat === 'concept' && /WAVEFORMATEX/.test(e.term))];
  return [...COMMON, ...AVI_ENTRIES, ...WAV_ENTRIES];
}
