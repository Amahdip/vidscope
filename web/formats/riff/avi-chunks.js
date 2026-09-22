// AVI chunk definitions: headers (hdrl, avih, strl, strh, strf...), the
// OpenDML extensions (indx, ix##, odml/dmlh, vprp), the legacy idx1 index and
// the media chunks inside movi.

import { fmtInt, fmtNum, fmtBitrate, fmtDuration, hex, isPrintableFourcc } from '../../core/util.js';
import { chunk, list, form, resolver, zstr, mediaChunkInfo, ixStream } from './chunks.js';
import { parseBitmapInfoHeader, parseWaveFormat } from './formats.js';
import { AVIF, AVISF, AVIIF, STREAM_TYPES, CHUNK_TWOCC, flagsText, videoCodec } from './tables.js';
import { moviLoader } from './movi.js';

// ------------------------------------------------------------ RIFF forms

const AVI_MORE = 'RIFF (Resource Interchange File Format, IBM and Microsoft, 1991) stores everything as chunks: a four-character code, a 32-bit little-endian size and the data, padded to an even length. An AVI file is one RIFF chunk of form \'AVI \' holding the headers (LIST hdrl), the media (LIST movi) and usually an index (idx1). Because sizes are 32-bit, and many readers treated them as signed, one RIFF chunk is limited to 2 GB; OpenDML ("AVI 2.0") files keep the first RIFF under about 1 GB for old players and continue in extra RIFF \'AVIX\' chunks.';

form('AVI ', {
  name: 'RIFF \'AVI \' (AVI file)',
  cat: 'type',
  spec: 'AVI',
  desc: 'The RIFF chunk that makes up an AVI file: its form type \'AVI \' says the chunks inside follow the AVI layout (headers in hdrl, media in movi, an optional idx1 index).',
  more: AVI_MORE,
});

form('AVIX', {
  name: 'RIFF \'AVIX\' (OpenDML continuation)',
  cat: 'type',
  spec: 'ODML',
  desc: 'An OpenDML continuation: an extra RIFF chunk that holds more movie data once the first RIFF \'AVI \' chunk has reached its size limit. It contains only a movi list.',
  more: 'Writers start a new RIFF \'AVIX\' about every gigabyte. Old (AVI 1.0) players stop at the end of the first RIFF chunk, so they play only the beginning of the file. The frames in AVIX chunks are found through the OpenDML indexes (the indx super index in each strl pointing at ix## chunks), because the legacy idx1 index only covers the first RIFF.',
});

// ------------------------------------------------------------ hdrl / avih

list('hdrl', {
  name: 'Header list (hdrl)',
  cat: 'header',
  spec: 'AVI',
  desc: 'The AVI headers: the main AVI header (avih), then one stream list (strl) per stream, and optionally the OpenDML extended header (odml).',
  more: 'A player reads hdrl before it touches any media, to learn how many streams there are, which codecs they use, their frame rates and picture sizes. It must be the first chunk inside RIFF \'AVI \'.',
});

chunk('avih', {
  name: 'Main AVI header (avih)',
  cat: 'header',
  spec: 'AVIMAINHEADER',
  desc: 'Global numbers for the whole file (MainAVIHeader): frame period, total frames, number of streams, suggested buffer size, picture size, and flags such as "has an index".',
  more: 'Most of these values are informative. Players take the exact timing of each stream from its strh (dwRate / dwScale) and the real frame count from the index. dwTotalFrames only counts the frames in the first RIFF chunk; OpenDML files store the full count in odml/dmlh. Of the flags, AVIF_HASINDEX (an idx1 exists) and AVIF_MUSTUSEINDEX (chunk order in movi is not playback order) matter to readers.',
  syntax: 'typedef struct _avimainheader {\n    FOURCC fcc;                   // \'avih\'\n    DWORD  cb;                    // size of the structure minus 8\n    DWORD  dwMicroSecPerFrame;\n    DWORD  dwMaxBytesPerSec;\n    DWORD  dwPaddingGranularity;\n    DWORD  dwFlags;\n    DWORD  dwTotalFrames;\n    DWORD  dwInitialFrames;\n    DWORD  dwStreams;\n    DWORD  dwSuggestedBufferSize;\n    DWORD  dwWidth;\n    DWORD  dwHeight;\n    DWORD  dwReserved[4];\n} AVIMAINHEADER;',
  parse(r, node, ctx) {
    const m = {};
    m.usPerFrame = r.u32('dwMicroSecPerFrame', {
      key: true,
      display: (v) => (v ? `${fmtInt(v)} µs → ${fmtNum(1e6 / v, 3)} frames/s` : '0 (not set)'),
      desc: 'Time between video frames in microseconds (40,000 = 25 fps). Informative only: the exact rate is dwRate / dwScale in the video stream\'s strh.',
    });
    m.maxBytesPerSec = r.u32('dwMaxBytesPerSec', {
      display: (v) => `${fmtInt(v)} bytes/s (${fmtBitrate(v * 8)})`,
      desc: 'Approximate maximum data rate the system must sustain to play the file. A hint, and often inaccurate.',
    });
    r.u32('dwPaddingGranularity', { unit: 'bytes', desc: 'Data is padded to multiples of this many bytes (2048 aligned chunks to CD-ROM sectors). Usually 0.' });
    m.flags = r.u32('dwFlags', {
      key: true,
      display: (v) => flagsText(v, AVIF),
      desc: 'AVIF_HASINDEX (0x10): an idx1 index follows movi. AVIF_MUSTUSEINDEX (0x20): use the index, not the physical order of the chunks, to determine playback order. AVIF_ISINTERLEAVED (0x100): the streams are interleaved. AVIF_TRUSTCKTYPE (0x800): commented "use CKType to find key frames" in the Windows headers; set by most modern writers, FFmpeg included. AVIF_WASCAPTUREFILE (0x10000): a pre-allocated capture file. AVIF_COPYRIGHTED (0x20000).',
    });
    m.totalFrames = r.u32('dwTotalFrames', {
      key: true,
      desc: 'Number of video frames in the first RIFF chunk (the whole file unless it is an OpenDML file; then odml/dmlh has the total).',
    });
    r.u32('dwInitialFrames', { desc: 'For interleaved files, the number of frames stored before the first video frame (audio sent ahead so it can be buffered). 0 for non-interleaved files.' });
    m.streams = r.u32('dwStreams', { key: true, desc: 'Number of streams; there is one strl list per stream.' });
    m.suggestedBuffer = r.u32('dwSuggestedBufferSize', {
      unit: 'bytes',
      desc: 'Buffer size a reader should allocate: large enough for the largest chunk (or rec list). If it is too small, players reallocate during playback.',
    });
    m.width = r.u32('dwWidth', { key: true, unit: 'pixels', desc: 'Width of the movie in pixels.' });
    m.height = r.u32('dwHeight', { key: true, unit: 'pixels', desc: 'Height of the movie in pixels.' });
    if (r.remaining >= 16) r.skip(16, 'dwReserved[4]');
    ctx.avih = m;
    node.data.avih = m;
    node.data.summary = `${m.streams} stream${m.streams === 1 ? '' : 's'}, ${m.width}×${m.height}, ${m.usPerFrame ? `${fmtNum(1e6 / m.usPerFrame, 3)} fps, ` : ''}${fmtInt(m.totalFrames)} frames`;
  },
});

// ------------------------------------------------------------ strl

list('strl', {
  name: 'Stream list (strl)',
  cat: 'track',
  spec: 'AVI',
  desc: 'Describes one stream (video, audio, subtitles...). Its position among the strl lists is the stream number used in the chunk IDs: the first strl is stream 00, whose frames are stored in chunks named \'00dc\', \'00wb\'...',
  more: 'Inside: strh (stream header: type, codec handler, clock), strf (format: BITMAPINFOHEADER or WAVEFORMATEX), and optionally strd (codec settings), strn (stream name), indx (OpenDML super index) and vprp (video properties).',
  parse(r, node, ctx) {
    const s = { index: ctx.streams.length, node };
    ctx.streams.push(s);
    ctx.cur = s;
    node.data.stream = s;
  },
  after(node, ctx) {
    const s = node.data.stream;
    if (ctx.cur === s) ctx.cur = null;
    const kind = STREAM_TYPES[s.type] ?? (s.type ? `'${s.type}'` : '?');
    node.label = `stream ${String(s.index).padStart(2, '0')} · ${kind}`;
  },
});

const QUALITY = (v) => (v === 0xffffffff ? '-1 (default quality)' : `${fmtInt(v)} (of 10,000)`);

chunk('strh', {
  name: 'Stream header (strh)',
  cat: 'header',
  spec: 'AVISTREAMHEADER',
  desc: 'The stream\'s type (vids, auds, txts...), codec handler and clock: dwRate / dwScale is the number of frames (or audio blocks) per second and dwLength the stream length in those units.',
  more: 'AVI has no per-frame timestamps. Time is implied by position: frame n of a stream is presented at (dwStart + n) × dwScale / dwRate seconds. A frame the encoder skipped must therefore still be stored, as an empty chunk, and B-frames (stored in a different order than they are shown) do not fit the model, which is why MPEG-4 ASP encoders used the "packed bitstream" hack. For audio, dwSampleSize > 0 means time comes from the byte count (PCM, CBR audio); dwSampleSize = 0 means each chunk is one block or frame (VBR audio).',
  syntax: 'typedef struct _avistreamheader {\n    FOURCC fcc;          // \'strh\'\n    DWORD  cb;\n    FOURCC fccType;      // \'vids\', \'auds\', \'txts\', \'mids\'\n    FOURCC fccHandler;\n    DWORD  dwFlags;\n    WORD   wPriority;\n    WORD   wLanguage;\n    DWORD  dwInitialFrames;\n    DWORD  dwScale;\n    DWORD  dwRate;       // dwRate / dwScale == samples/second\n    DWORD  dwStart;\n    DWORD  dwLength;\n    DWORD  dwSuggestedBufferSize;\n    DWORD  dwQuality;\n    DWORD  dwSampleSize;\n    struct { short left, top, right, bottom; } rcFrame;\n} AVISTREAMHEADER;',
  parse(r, node, ctx) {
    const s = ctx.cur ?? { index: -1 };
    s.strh = node;
    s.type = r.fourcc('fccType', {
      key: true,
      display: (v) => `'${v}' — ${STREAM_TYPES[v] ?? 'unknown stream type'}`,
      desc: 'Stream type: \'vids\' video, \'auds\' audio, \'txts\' subtitles/text, \'mids\' MIDI, \'iavs\' interleaved DV.',
    });
    const hAt = r.pos;
    const printable = isPrintableFourcc(r.u, hAt);
    if (printable) {
      s.handler = r.fourcc('fccHandler', {
        display: (v) => `'${v}'${videoCodec(v) ? ` — ${videoCodec(v).name}` : ''}`,
        desc: 'For video, the codec (FOURCC) that should decode the stream; the BITMAPINFOHEADER biCompression in strf is what decoders actually use. For audio it is usually 0.',
      });
    } else {
      s.handler = null;
      r.u32('fccHandler', { display: (v) => `${fmtInt(v)} (not a FOURCC)`, desc: 'For audio streams this is usually 0 (FFmpeg writes 1): the codec is given by wFormatTag in strf.' });
    }
    s.flags = r.u32('dwFlags', { display: (v) => flagsText(v, AVISF), desc: 'AVISF_DISABLED (0x1): the stream should not play by default. AVISF_VIDEO_PALCHANGES (0x10000): the palette changes during playback.' });
    s.priority = r.u16('wPriority', { desc: 'With several streams of the same type (e.g. audio in different languages), the one with the highest priority is the default.' });
    s.language = r.u16('wLanguage', { desc: 'Language of the stream as a Windows language identifier (LANGID). Usually 0.' });
    s.initialFrames = r.u32('dwInitialFrames', { desc: 'How far audio is stored ahead of the video in interleaved files, in frames (about 0.75 s is typical).' });
    s.scale = r.u32('dwScale', { key: true, desc: 'Time unit of the stream, together with dwRate: one frame (or audio block) lasts dwScale / dwRate seconds.' });
    s.rate = r.u32('dwRate', {
      key: true,
      display: (v) => (s.scale ? `${fmtInt(v)} → ${fmtNum(v / s.scale, 6)} ${s.type === 'auds' ? 'blocks' : 'frames'}/s` : fmtInt(v)),
      desc: 'dwRate / dwScale = frames per second for video (25/1, 30000/1001...). For audio it is blocks per second: the sample rate for PCM, or frames per second for VBR MP3 (48000/1152).',
    });
    const secs = (units) => (s.rate ? (units * s.scale) / s.rate : null);
    s.start = r.u32('dwStart', {
      display: (v) => (v ? `${fmtInt(v)} → starts at ${fmtDuration(secs(v))}` : '0'),
      desc: 'Start time of the stream in dwScale/dwRate units. Usually 0; a positive value delays the stream relative to the others.',
    });
    s.length = r.u32('dwLength', {
      key: true,
      display: (v) => (s.rate ? `${fmtInt(v)} → ${fmtDuration(secs(v))}` : fmtInt(v)),
      desc: 'Length of the stream in dwScale/dwRate units: frames for video, blocks (or bytes / dwSampleSize) for audio.',
    });
    s.bufferSize = r.u32('dwSuggestedBufferSize', { unit: 'bytes', desc: 'Size of the largest chunk of this stream, as a buffer-size hint for readers. 0 = unknown.' });
    s.quality = r.u32('dwQuality', { display: QUALITY, desc: 'Encoding quality from 0 to 10,000; -1 means the codec default. Informative.' });
    s.sampleSize = r.u32('dwSampleSize', {
      key: true,
      display: (v) => (v ? `${fmtInt(v)} bytes (fixed-size samples: time comes from the byte count)` : '0 (variable size: each chunk is one sample)'),
      desc: 'Size of one sample when all samples have the same size (PCM: one sample frame, nBlockAlign). 0 when sizes vary (video, VBR audio): then every chunk holds exactly one frame or block.',
    });
    if (r.remaining >= 8) {
      r.group('rcFrame', (g) => {
        const l = r.i16('left');
        const t = r.i16('top');
        const rt = r.i16('right');
        const b = r.i16('bottom');
        g.display = `(${l}, ${t}) – (${rt}, ${b})`;
        s.rcFrame = [l, t, rt, b];
      }, { desc: 'Where this stream is drawn inside the movie rectangle (avih dwWidth × dwHeight). Used for text streams or several video streams; usually the full frame or all zero.' });
    }
    const rate = s.scale ? s.rate / s.scale : 0;
    const what = s.type === 'vids' ? `${fmtNum(rate, 3)} fps` : s.type === 'auds' ? `${fmtNum(rate, 3)} blocks/s` : `${fmtNum(rate, 3)}/s`;
    node.data.summary = `${s.type}${s.handler && s.handler.trim() ? ` '${s.handler}'` : ''}, ${what}, length ${fmtInt(s.length)}${s.rate ? ` (${fmtDuration(secs(s.length))})` : ''}`;
  },
});

chunk('strf', {
  name: 'Stream format (strf)',
  cat: 'codec',
  spec: 'AVI',
  desc: 'The stream\'s format: a BITMAPINFOHEADER for video, a WAVEFORMATEX for audio. This is where the codec and its setup data are declared.',
  more: 'For video, biCompression names the codec and the picture size; codec setup data (MPEG-4 VOL header, H.264 parameter sets...) may follow the 40-byte header. For audio, wFormatTag names the codec (0x0001 PCM, 0x0055 MP3, 0x2000 AC-3...) with the sample rate, channels and data rate; an extension may follow (cbSize bytes).',
  parse(r, node, ctx) {
    const s = ctx.cur ?? {};
    s.strf = node;
    if (s.type === 'vids') {
      node.name = 'Stream format (strf): BITMAPINFOHEADER';
      node.def = { ...node.def, name: node.name, specTitle: 'Microsoft: BITMAPINFOHEADER structure (wingdi.h)', specHref: 'https://learn.microsoft.com/en-us/windows/win32/api/wingdi/ns-wingdi-bitmapinfoheader' };
      r.group('BITMAPINFOHEADER', (g) => {
        s.video = parseBitmapInfoHeader(r);
        g.display = `${s.video.width}×${Math.abs(s.video.height)}, ${s.video.codecName}`;
      }, { desc: 'The Windows bitmap header, reused by AVI to describe video frames: picture size, bits per pixel and the codec (biCompression).' });
      node.data.summary = `${s.video?.codecName ?? '?'}, ${s.video?.width}×${Math.abs(s.video?.height ?? 0)}`;
    } else if (s.type === 'auds') {
      node.name = 'Stream format (strf): WAVEFORMATEX';
      node.def = { ...node.def, name: node.name, specTitle: 'Microsoft: WAVEFORMATEX structure (mmreg.h)', specHref: 'https://learn.microsoft.com/en-us/windows/win32/api/mmreg/ns-mmreg-waveformatex' };
      r.group(r.remaining >= 18 ? 'WAVEFORMATEX' : 'PCMWAVEFORMAT', (g) => {
        s.audio = parseWaveFormat(r);
        g.display = s.audio.summary;
      }, { desc: 'The Windows audio format header: codec (wFormatTag), channels, sample rate, data rate and block size, then a codec-specific extension of cbSize bytes.' });
      node.data.summary = s.audio?.summary;
    } else if (s.type === 'iavs' && r.remaining >= 32) {
      node.name = 'Stream format (strf): DVINFO';
      r.group('DVINFO', () => {
        r.u32('dwDVAAuxSrc', { desc: 'Audio auxiliary data (AAUX source pack) of the first audio block.' });
        r.u32('dwDVAAuxCtl');
        r.u32('dwDVAAuxSrc1', { desc: 'AAUX source pack of the second audio block.' });
        r.u32('dwDVAAuxCtl1');
        r.u32('dwDVVAuxSrc', { desc: 'Video auxiliary data (VAUX source pack).' });
        r.u32('dwDVVAuxCtl');
        r.skip(8, 'dwDVReserved[2]');
      }, { desc: 'DV stream settings for an interleaved DV (type 1) stream, where each chunk holds a complete DV frame with its audio.' });
    } else if (r.remaining > 0) {
      r.rest('format data', { desc: 'Format data for a stream type Vidscope does not decode.' });
    }
  },
  tolerateTrailing: true,
});

chunk('strd', {
  name: 'Stream data (strd)',
  cat: 'codec',
  spec: 'AVI',
  desc: 'Codec driver settings for the stream. The format is private to the codec; most files have none.',
  parse(r, node, ctx) {
    if (ctx.cur) ctx.cur.strd = node;
    if (r.remaining > 0) r.rest('codec data', { desc: 'Opaque data passed to the codec driver when the stream is opened.' });
  },
});

chunk('strn', {
  name: 'Stream name (strn)',
  cat: 'meta',
  spec: 'AVI',
  desc: 'A human-readable name for the stream (for example a language or commentary track title), as a NUL-terminated string.',
  parse(r, node, ctx) {
    const v = zstr(r, 'name', { key: true });
    if (ctx.cur) ctx.cur.name = v;
    node.label = v;
  },
});

const VIDEO_FORMAT_TOKEN = {
  0: 'FORMAT_UNKNOWN', 1: 'FORMAT_PAL_SQUARE', 2: 'FORMAT_PAL_CCIR_601', 3: 'FORMAT_NTSC_SQUARE', 4: 'FORMAT_NTSC_CCIR_601',
};
const VIDEO_STANDARD = { 0: 'STANDARD_UNKNOWN', 1: 'STANDARD_PAL', 2: 'STANDARD_NTSC', 3: 'STANDARD_SECAM' };

chunk('vprp', {
  name: 'Video properties (vprp)',
  cat: 'header',
  spec: 'ODML',
  desc: 'OpenDML video properties: the video standard, refresh rate, frame aspect ratio and, per field, the valid picture area.',
  more: 'Added by OpenDML for professional capture. The most useful value today is dwFrameAspectRatio, the display aspect ratio of the whole frame (16:9, 4:3), which is how an AVI can signal anamorphic video.',
  parse(r, node, ctx) {
    r.u32('VideoFormatToken', { enum: VIDEO_FORMAT_TOKEN, desc: 'Video format (PAL/NTSC, square or CCIR-601 pixels); 0 = unknown.' });
    r.u32('VideoStandard', { enum: VIDEO_STANDARD });
    r.u32('dwVerticalRefreshRate', { unit: 'Hz', desc: 'Field or frame refresh rate (e.g. 25, 30).' });
    r.u32('dwHTotalInT', { desc: 'Total width including blanking, in pixels.' });
    r.u32('dwVTotalInLines', { desc: 'Total height including blanking, in lines.' });
    const ar = r.u32('dwFrameAspectRatio', {
      key: true,
      display: (v) => `0x${v.toString(16).padStart(8, '0')} → ${v >>> 16}:${v & 0xffff}`,
      desc: 'Display aspect ratio of the frame: the high 16 bits are the width part, the low 16 bits the height part (16:9 is 0x00100009).',
    });
    r.u32('dwFrameWidthInPixels', { unit: 'pixels' });
    r.u32('dwFrameHeightInLines', { unit: 'lines' });
    const n = r.u32('nbFieldPerFrame', { desc: '1 for progressive video, 2 for interlaced (one description per field follows).' });
    for (let i = 0; i < n && r.remaining >= 32; i++) {
      r.group(`FieldInfo[${i}]`, () => {
        r.u32('CompressedBMHeight');
        r.u32('CompressedBMWidth');
        r.u32('ValidBMHeight');
        r.u32('ValidBMWidth');
        r.u32('ValidBMXOffset');
        r.u32('ValidBMYOffset');
        r.u32('VideoXOffsetInT');
        r.u32('VideoYValidStartLine');
      }, { desc: 'Size of the stored field and the part of it that holds valid picture.' });
    }
    if (ctx.cur) ctx.cur.aspect = [ar >>> 16, ar & 0xffff];
    node.data.summary = `aspect ${ar >>> 16}:${ar & 0xffff}, ${n} field${n === 1 ? '' : 's'} per frame`;
  },
});

// ------------------------------------------------------------ OpenDML indexes

const INDEX_TYPE = { 0: 'AVI_INDEX_OF_INDEXES (super index)', 1: 'AVI_INDEX_OF_CHUNKS (standard index)', 0x80: 'AVI_INDEX_IS_DATA' };
const INDEX_SUBTYPE = { 0: 'frames (default)', 1: 'AVI_INDEX_2FIELD (fields indexed separately)' };

function indexHeader(r, which) {
  const h = {};
  h.longsPerEntry = r.u16('wLongsPerEntry', { desc: 'Size of one entry in 4-byte units: 4 for a super index (16-byte entries), 2 for a standard index (8 bytes), 3 for a field index.' });
  h.subType = r.u8('bIndexSubType', { enum: INDEX_SUBTYPE });
  h.type = r.u8('bIndexType', { key: true, enum: INDEX_TYPE, desc: 'What the entries point to: other index chunks (super index) or media chunks (standard index).' });
  h.entries = r.u32('nEntriesInUse', { key: true, desc: `Number of valid entries. The chunk may be larger than needed: writers reserve room for more${which === 'indx' ? ' (FFmpeg reserves 256)' : ''}.` });
  h.chunkId = r.fourcc('dwChunkId', { key: true, desc: 'ID of the chunks this index covers, e.g. \'00dc\'.' });
  return h;
}

/** Standard-index entries (AVISTDINDEX / AVIFIELDINDEX) as a lazily decoded table. */
function stdIndexTable(r, h, base) {
  const size = h.longsPerEntry * 4 || 8;
  const cols = [
    { name: 'dwOffset', type: 'u32', display: (v) => `${fmtInt(v)} → data at ${fmtInt(base + v)}`, desc: 'Offset of the chunk data (not the chunk header) relative to qwBaseOffset.' },
    { name: 'dwSize', type: 'u32', display: (v) => `${fmtInt(v & 0x7fffffff)} bytes${v & 0x80000000 ? ', delta frame' : ', key frame'}`, desc: 'Size of the data in the low 31 bits; bit 31 set means the frame is NOT a key frame (a delta frame).' },
  ];
  if (size >= 12) cols.push({ name: 'dwOffsetField2', type: 'u32', desc: 'Offset of the second field of the frame.' });
  const fit = Math.floor(r.remaining / size);
  return r.table('aIndex', Math.min(h.entries, fit), size, cols, { desc: 'One entry per chunk of the stream, in order.' });
}

chunk('indx', {
  name: 'OpenDML super index (indx)',
  cat: 'index',
  spec: 'ODML',
  desc: 'The OpenDML index of one stream: a list of index chunks (ix##) spread through the movi lists, one per RIFF chunk. It replaces idx1 for files over 1 GB.',
  more: 'Each entry gives the file position (64-bit), size and duration of one standard index chunk of this stream (ix## where ## is the stream number, usually one per movi list), which in turn lists the frames. Unlike idx1 the offsets are 64-bit, so the index can address any position in files larger than 4 GB, and each part is small enough to load on demand. dwDuration is in the stream\'s dwScale/dwRate units, so a player can jump to the right part of the index for a seek.',
  syntax: 'typedef struct _avisuperindex {\n    FOURCC fcc;              // \'indx\'\n    UINT   cb;\n    WORD   wLongsPerEntry;   // 4\n    BYTE   bIndexSubType;    // 0\n    BYTE   bIndexType;       // AVI_INDEX_OF_INDEXES\n    DWORD  nEntriesInUse;\n    DWORD  dwChunkId;\n    DWORD  dwReserved[3];\n    struct { DWORDLONG qwOffset; DWORD dwSize; DWORD dwDuration; } aIndex[];\n} AVISUPERINDEX;',
  maxRead: 64 << 20,
  tolerateTrailing: true,
  parse(r, node, ctx) {
    const h = indexHeader(r, 'indx');
    const s = ctx.cur;
    if (h.type === 0) {
      r.skip(12, 'dwReserved[3]');
      const t = r.table('aIndex', Math.min(h.entries, Math.floor(r.remaining / 16)), 16, [
        { name: 'qwOffset', type: 'u64', ref: 'offset', display: (v) => `${fmtInt(v)} (${hex(v)})`, desc: 'File offset of the ix## chunk (its header).' },
        { name: 'dwSize', type: 'u32', display: (v) => `${fmtInt(v)} bytes`, desc: 'Size of the ix## chunk.' },
        { name: 'dwDuration', type: 'u32', desc: 'Time covered by that index chunk, in stream units (frames, or samples for audio).' },
      ], { desc: 'One entry per standard index chunk (usually one per RIFF chunk).' });
      h.table = t;
      if (r.remaining > 0) {
        const zero = r.u.subarray(r.pos, r.end).every((b) => b === 0);
        r.bytes('unused entries', r.remaining, { reserved: true, desc: zero ? 'Room reserved for more entries (all zero).' : 'Room reserved for more entries.' });
      }
      node.data.summary = `super index of '${h.chunkId}': ${fmtInt(t.count)} index chunk${t.count === 1 ? '' : 's'}`;
    } else if (h.type === 1) {
      h.baseOffset = r.u64('qwBaseOffset', { ref: 'offset', desc: 'All entry offsets are relative to this file position.' });
      r.u32('dwReserved3', { reserved: true });
      h.table = stdIndexTable(r, h, h.baseOffset);
      node.data.summary = `standard index of '${h.chunkId}' (in strl): ${fmtInt(h.table.count)} entries`;
    }
    node.data.index = h;
    if (s) s.indx = { node, ...h };
    node.label = node.data.summary ?? '';
  },
});

list('odml', {
  name: 'OpenDML header list (odml)',
  cat: 'header',
  spec: 'ODML',
  desc: 'OpenDML extended header list. Its presence marks an "AVI 2.0" (OpenDML) file; it holds dmlh with the real total frame count.',
  after(node, ctx) {
    ctx.odml = node;
  },
});

chunk('dmlh', {
  name: 'OpenDML extended header (dmlh)',
  cat: 'header',
  spec: 'ODML',
  desc: 'The extended AVI header: the total number of video frames in the whole file, across all RIFF chunks.',
  more: 'avih dwTotalFrames only counts the frames of the first RIFF chunk (so that AVI 1.0 players see a consistent file). dwTotalFrames here counts every frame. The rest of the chunk is reserved (dwFuture).',
  parse(r, node, ctx) {
    const n = r.u32('dwTotalFrames', { key: true, desc: 'Total number of video frames in the file, in all RIFF chunks.' });
    ctx.dmlhTotalFrames = n;
    if (r.remaining > 0) r.skip(r.remaining, 'dwFuture', { desc: 'Reserved for future use (61 DWORDs in the specification).' });
    node.data.summary = `${fmtInt(n)} frames in total`;
  },
});

// ------------------------------------------------------------ movi / rec / idx1

list('movi', {
  name: 'Movie data (movi)',
  cat: 'media',
  spec: 'AVI',
  lazy: (ctx) => moviLoader(ctx),
  after(node, ctx) {
    ctx.movis.push(node);
  },
  desc: 'The media: every frame of every stream, each in its own chunk named after its stream number and type (\'00dc\' = stream 0 compressed video, \'01wb\' = stream 1 audio).',
  more: 'Streams are interleaved in time (roughly one video frame followed by the matching audio) so that a player reading sequentially has what it needs. Chunks may be grouped in \'rec \' lists, and OpenDML files also put their ix## index chunks here. There can be hundreds of thousands of chunks, so Vidscope lists them only when you open this list, in groups.',
});

list('rec ', {
  name: 'Record list (rec )',
  cat: 'media',
  spec: 'AVI',
  desc: 'A record: groups chunks that should be read in one go, typically one video frame and the audio that goes with it.',
  more: 'From the CD-ROM era, when a player read one record per seek. The idx1 index may point at the record as a whole (flag AVIIF_LIST) as well as at the chunks inside it.',
});

chunk('idx1', {
  name: 'Legacy AVI index (idx1)',
  cat: 'index',
  spec: 'AVI',
  maxRead: 256 << 20,
  desc: 'The AVI 1.0 index: one 16-byte entry per chunk in movi, with the chunk ID, flags (key frame or not), position and size. It sits after movi, at the end of the first RIFF chunk.',
  more: 'Without an index a player can only play from the start: to seek it would have to read every chunk header in movi. idx1 gives the position of every frame and marks key frames (AVIIF_KEYFRAME), which is what makes seeking fast. dwChunkOffset is normally relative to the movi list (to the position of its \'movi\' FOURCC), but some writers stored absolute file offsets, so readers check which interpretation lands on a real chunk. Offsets are 32-bit and idx1 only covers the first RIFF chunk, which is why OpenDML files add indx/ix## indexes. (aviriff.h calls the same structure AVIOLDINDEX, with fields dwChunkId, dwFlags, dwOffset and dwSize.)',
  syntax: 'typedef struct _AVIINDEXENTRY {\n    DWORD ckid;           // chunk ID, e.g. \'00dc\'\n    DWORD dwFlags;        // AVIIF_KEYFRAME, AVIIF_LIST, AVIIF_NO_TIME...\n    DWORD dwChunkOffset;  // position of the chunk header\n    DWORD dwChunkLength;  // size of the chunk data\n} AVIINDEXENTRY;          // \'idx1\' holds an array of these',
  parse(r, node, ctx) {
    const n = Math.floor(r.remaining / 16);
    const t = r.table('entries', n, 16, [
      { name: 'ckid', type: 'fourcc', desc: 'ID of the indexed chunk (\'00dc\', \'01wb\', \'rec \'...).' },
      { name: 'dwFlags', type: 'u32', display: (v) => flagsText(v, AVIIF), desc: 'AVIIF_KEYFRAME (0x10): a key frame, decoding can start here. AVIIF_LIST (0x1): the entry points at a \'rec \' list. AVIIF_NO_TIME (0x100): the chunk does not advance time (e.g. a palette change).' },
      {
        name: 'dwChunkOffset',
        type: 'u32',
        display: (v) => (ctx.idx1Base !== undefined && ctx.idx1Base !== null ? `${fmtInt(v)} → chunk at ${fmtInt(ctx.idx1Base + v)}${ctx.idx1Base ? '' : ' (absolute)'}` : fmtInt(v)),
        desc: 'Position of the chunk header: relative to the \'movi\' FOURCC of the movi list (usual), or an absolute file offset (some old writers).',
      },
      { name: 'dwChunkLength', type: 'u32', display: (v) => `${fmtInt(v)} bytes`, desc: 'Size of the chunk data (without the 8-byte header).' },
    ], { desc: 'One AVIINDEXENTRY per chunk, normally in file order.' });
    if (r.remaining > 0) r.bytes('trailing bytes', r.remaining, { desc: 'Bytes after the last complete 16-byte entry.' });
    ctx.idx1 = { node, table: t };
    node.data.table = t;
    node.data.summary = `${fmtInt(t.count)} entries`;
  },
});

// ------------------------------------------------------------ chunks inside movi

const mediaDefs = new Map();

function mediaDef(twocc) {
  let d = mediaDefs.get(twocc);
  if (d) return d;
  const what = CHUNK_TWOCC[twocc] ?? 'stream data';
  const isVideo = twocc === 'dc' || twocc === 'db';
  d = {
    type: `##${twocc}`,
    name: `${what[0].toUpperCase()}${what.slice(1)} ('##${twocc}')`,
    cat: 'media',
    opaque: true,
    specTitle: 'Microsoft: AVI RIFF File Reference',
    specHref: 'https://learn.microsoft.com/en-us/windows/win32/directshow/avi-riff-file-reference',
    desc: `A ${what} chunk. Its ID is the stream number (two digits) followed by a two-letter type: 'dc' compressed video, 'db' uncompressed video, 'wb' audio, 'pc' palette change.`,
    more: isVideo
      ? 'The data is one video frame exactly as the codec produced it, with nothing added by AVI: no timestamp, no key-frame flag (those come from the position in the stream and from the index). An empty chunk (size 0) is a dropped frame: it holds the place of a frame so the timing of the following frames stays right.'
      : twocc === 'wb'
        ? 'The data is audio exactly as the codec produced it: PCM samples, or one or more compressed frames. For PCM and CBR audio (dwSampleSize > 0) the chunk boundaries are arbitrary; time is counted in bytes.'
        : twocc === 'pc'
          ? 'AVIPALCHANGE: new palette entries for 8-bit paletted video, applied from the next frame.'
          : 'Data of a stream Vidscope does not describe in detail.',
  };
  mediaDefs.set(twocc, d);
  return d;
}

const IX_DEF = {
  type: 'ix##',
  name: 'OpenDML standard index (ix##)',
  cat: 'index',
  specTitle: 'OpenDML AVI File Format Extensions, version 1.02 (OpenDML AVI M-JPEG File Format Subcommittee, 1996)',
  specHref: null,
  maxRead: 64 << 20,
  tolerateTrailing: true,
  desc: 'A part of the OpenDML index of one stream: the position, size and key-frame flag of each of its chunks in this movi list. The strl\'s indx super index points here.',
  more: 'Offsets are 32-bit but relative to the 64-bit qwBaseOffset (the movi list they belong to), and they point at the chunk data, not the header. Bit 31 of dwSize is set for delta (non-key) frames. Writers usually put one ix## per stream at the end of each movi list.',
  syntax: 'typedef struct _avistdindex {\n    FOURCC    fcc;             // \'ix00\'\n    UINT      cb;\n    WORD      wLongsPerEntry;  // 2\n    BYTE      bIndexSubType;   // 0\n    BYTE      bIndexType;      // AVI_INDEX_OF_CHUNKS\n    DWORD     nEntriesInUse;\n    DWORD     dwChunkId;\n    DWORDLONG qwBaseOffset;\n    DWORD     dwReserved3;\n    struct { DWORD dwOffset; DWORD dwSize; } aIndex[];\n} AVISTDINDEX;',
  parse(r, node) {
    const h = indexHeader(r, 'ix');
    h.baseOffset = r.u64('qwBaseOffset', { ref: 'offset', display: (v) => `${fmtInt(v)} (${hex(v)})`, desc: 'Base position for the entry offsets: usually the position of the movi list this index covers.' });
    r.u32('dwReserved3', { reserved: true });
    h.table = stdIndexTable(r, h, h.baseOffset);
    if (r.remaining > 0) r.bytes('unused entries', r.remaining, { reserved: true, desc: 'Room reserved for more entries.' });
    node.data.index = h;
    node.data.summary = `index of '${h.chunkId}': ${fmtInt(h.table.count)} entries`;
    node.label = node.data.summary;
  },
};

resolver((ctx, id, parentList) => {
  if (parentList !== 'movi' && parentList !== 'rec ') return null;
  if (ixStream(id) !== null) return IX_DEF;
  const m = mediaChunkInfo(id);
  if (m) return mediaDef(m.twocc);
  return null;
});

