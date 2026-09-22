// WAV chunk definitions: fmt, data, fact, and the metadata chunks found in
// broadcast and music production files (bext, cue, smpl, inst, id3, levl, iXML...),
// plus RF64/BW64 (ds64) for files over 4 GB.

import { FieldReader, ParseError } from '../../core/fields.js';
import { fmtInt, fmtNum, fmtDuration, decodeText } from '../../core/util.js';
import { chunk, list, form, zstr, text } from './chunks.js';
import { parseWaveFormat } from './formats.js';

const WAV_MORE = 'A WAV file is one RIFF chunk of form \'WAVE\': a \'fmt \' chunk describing the audio (codec, channels, sample rate, bits) and a \'data\' chunk with the samples, plus optional metadata chunks (LIST INFO, bext, cue ...). The RIFF size is 32-bit, so a WAV file cannot exceed 4 GB (many readers even stop at 2 GB); RF64 and BW64 lift the limit by moving the sizes to a ds64 chunk.';

form('WAVE', {
  name: 'RIFF \'WAVE\' (WAV file)',
  cat: 'type',
  spec: 'RIFF',
  desc: 'The RIFF chunk that makes up a WAV file: its form type \'WAVE\' says it holds a \'fmt \' chunk describing the audio and a \'data\' chunk with the samples.',
  more: WAV_MORE,
});

form('RF64:WAVE', {
  name: 'RF64 \'WAVE\' (64-bit WAV)',
  cat: 'type',
  spec: 'RF64',
  desc: 'An RF64 file (EBU Tech 3306): a WAV whose 32-bit sizes are set to 0xFFFFFFFF, with the real 64-bit sizes of the file and the data chunk in the ds64 chunk that must come first.',
  more: 'RF64 exists because a 32-bit RIFF size limits WAV to 4 GB: about 6.2 hours of 48 kHz 16-bit stereo, 4.1 hours at 24-bit, and much less for multichannel recordings. Readers that do not know RF64 see an unknown RIFF variant and refuse the file, which is safer than reading garbage sizes.',
});

form('BW64:WAVE', {
  name: 'BW64 \'WAVE\' (Broadcast Wave 64)',
  cat: 'type',
  spec: 'BW64',
  desc: 'A BW64 file (ITU-R BS.2088): the RF64 layout with an ID of its own, used for long recordings and for object-based audio with ADM metadata (axml, chna).',
  more: WAV_MORE,
});

form('RIFX:WAVE', {
  name: 'RIFX \'WAVE\' (big-endian WAV)',
  cat: 'type',
  spec: 'RIFF',
  desc: 'A RIFX file: RIFF with all numbers stored big-endian (most significant byte first). Rare; some old Mac and workstation software wrote it.',
});

// ------------------------------------------------------------ fmt / data / fact

chunk('fmt ', {
  name: 'Format (fmt )',
  cat: 'codec',
  spec: 'WAVEFORMATEX',
  desc: 'Describes the audio in the data chunk: codec (wFormatTag), channels, sample rate, data rate, block size and bits per sample (a WAVEFORMATEX structure).',
  more: 'For PCM everything a player needs is here: the data chunk is just interleaved samples (little-endian integers, or floats for format 3). 16 bytes is the old PCMWAVEFORMAT; 18 adds cbSize; 40 is WAVE_FORMAT_EXTENSIBLE, which adds the speaker layout (dwChannelMask), the valid bits per sample and the real format as a GUID. Microsoft asks for the extensible form whenever there are more than two channels or more than 16 bits per sample.',
  parse(r, node, ctx) {
    const a = parseWaveFormat(r);
    ctx.fmt = a;
    ctx.fmtNode = node;
    node.data.summary = a.summary;
    if (a.tag === 0xfffe) {
      node.def = { ...node.def, specTitle: 'Microsoft: WAVEFORMATEXTENSIBLE structure (mmreg.h)', specHref: 'https://learn.microsoft.com/en-us/windows/win32/api/mmreg/ns-mmreg-waveformatextensible' };
    }
  },
  tolerateTrailing: true,
});

chunk('data', {
  name: 'Audio data (data)',
  cat: 'media',
  spec: 'RIFF',
  opaque: true,
  desc: 'The audio itself. For PCM it is a plain run of sample frames: one sample per channel, channels interleaved (left, right, left, right...), no headers and no timestamps.',
  more: 'Time is implied by position: byte n of the data is at n / nAvgBytesPerSec seconds, and the duration is the data size divided by the byte rate. A reader can seek anywhere with simple arithmetic, rounding to a multiple of nBlockAlign. Compressed formats (ADPCM, MP3...) store their frames or blocks back to back. Click inside to see the decoded sample values at that position.',
  after(node, ctx) {
    ctx.dataNode = node;
  },
});

chunk('fact', {
  name: 'Fact chunk (fact)',
  cat: 'header',
  spec: 'RIFF',
  desc: 'The number of samples (per channel) in the file. Required for compressed formats, where the length cannot be computed from the data size.',
  more: 'For ADPCM, MP3 or other compressed data, the byte count does not give an exact sample count, so the writer stores it here; players use it for the exact duration. PCM files do not need it (FFmpeg still writes one for floating-point PCM).',
  parse(r, node, ctx) {
    const n = r.u32('dwSampleLength', {
      key: true,
      display: (v) => (ctx.fmt?.sampleRate ? `${fmtInt(v)} samples → ${fmtDuration(v / ctx.fmt.sampleRate)}` : `${fmtInt(v)} samples`),
      desc: 'Length of the audio in sample frames (samples per channel).',
    });
    ctx.factSamples = n;
    node.data.summary = `${fmtInt(n)} samples`;
  },
  tolerateTrailing: true,
});

// ------------------------------------------------------------ RF64

chunk('ds64', {
  name: 'RF64 sizes (ds64)',
  cat: 'header',
  spec: 'RF64',
  desc: 'The real, 64-bit sizes of the RIFF chunk and the data chunk (whose 32-bit size fields say 0xFFFFFFFF), plus the sample count.',
  more: 'It must be the first chunk of an RF64/BW64 file so a reader learns the sizes before it needs them. The optional table gives 64-bit sizes for any other chunk larger than 4 GB.',
  parse(r, node, ctx) {
    const riff = r.u64('riffSize', { key: true, unit: 'bytes', desc: 'Size of the RF64 chunk (the file size minus 8).' });
    const data = r.u64('dataSize', { key: true, unit: 'bytes', desc: 'Size of the data chunk.' });
    const samples = r.u64('sampleCount', { unit: 'samples', desc: 'Number of samples per channel (the 64-bit version of the fact chunk).' });
    const n = r.u32('tableLength', { desc: 'Number of entries in the table of other large chunks.' });
    const table = new Map();
    for (let i = 0; i < n && r.remaining >= 12; i++) {
      r.group(`table[${i}]`, (g) => {
        const id = r.fourcc('chunkId');
        const size = r.u64('chunkSize', { unit: 'bytes' });
        table.set(id, size);
        g.display = `'${id}' = ${fmtInt(size)} bytes`;
      });
    }
    ctx.ds64 = {
      riffSize: riff,
      dataSize: data,
      sampleCount: samples,
      table,
      sizeOf(id) {
        if (id === 'data') return data;
        if (id === 'RF64' || id === 'BW64') return riff;
        return table.get(id);
      },
    };
    node.data.summary = `data ${fmtInt(data)} bytes, ${fmtInt(samples)} samples`;
  },
  tolerateTrailing: true,
});

// ------------------------------------------------------------ Broadcast Wave

chunk('bext', {
  name: 'Broadcast audio extension (bext)',
  cat: 'meta',
  spec: 'BWF',
  maxRead: 1 << 20,
  desc: 'Broadcast Wave (BWF) metadata: a description, who made the recording and when, the time of day of the first sample (for synchronising with video), and a coding history.',
  more: 'BWF is the standard exchange format in radio, TV and film sound. TimeReference counts samples since midnight, so an editor can place the file on a timeline next to picture shot at the same time. Version 1 added a SMPTE UMID (a unique material identifier), version 2 the EBU R 128 loudness values. CodingHistory is free text, one line per processing step, e.g. "A=PCM,F=48000,W=24,M=stereo,T=...".',
  parse(r, node, ctx) {
    const b = {};
    const str = (name, n, desc, key) => {
      const v = r.str(name, n, { encoding: 'latin1', desc, key });
      return v;
    };
    b.description = str('Description', 256, 'Free text describing the sound (256 characters, NUL-padded).', true);
    b.originator = str('Originator', 32, 'Name of the organisation or device that created the file.', true);
    b.originatorReference = str('OriginatorReference', 32, 'Unique reference assigned by the originator.');
    b.date = str('OriginationDate', 10, 'Date of creation, yyyy:mm:dd (or yyyy-mm-dd).', true);
    b.time = str('OriginationTime', 8, 'Time of creation, hh:mm:ss.', true);
    const lo = r.u32('TimeReferenceLow', { desc: 'Low 32 bits of TimeReference.' });
    const hi = r.u32('TimeReferenceHigh', { desc: 'High 32 bits of TimeReference.' });
    b.timeReference = hi * 2 ** 32 + lo;
    const rate = ctx.fmt?.sampleRate;
    const f = r.out[r.out.length - 2];
    f.note = `TimeReference = ${fmtInt(b.timeReference)} samples since midnight${rate ? ` → ${fmtDuration(b.timeReference / rate)} at ${fmtInt(rate)} Hz` : ''}`;
    b.version = r.u16('Version', { key: true, desc: 'BWF version: 0 (original), 1 (adds UMID), 2 (adds loudness values).' });
    const umid = r.bytes('UMID', 64, { desc: 'SMPTE 330M Unique Material Identifier (version 1 and later); all zero if not used.' });
    b.umid = umid.some((x) => x !== 0);
    const lufs = (name, desc) => r.i16(name, {
      display: (v) => (b.version >= 2 && v !== 0x7fff ? `${v} → ${fmtNum(v / 100, 2)}` : `${v}${b.version < 2 ? ' (not used before version 2)' : ' (not set)'}`),
      desc,
    });
    b.loudness = lufs('LoudnessValue', 'Integrated loudness in LUFS × 100 (EBU R 128), version 2.');
    lufs('LoudnessRange', 'Loudness range in LU × 100, version 2.');
    lufs('MaxTruePeakLevel', 'Maximum true peak in dBTP × 100, version 2.');
    lufs('MaxMomentaryLoudness', 'Highest momentary loudness in LUFS × 100, version 2.');
    lufs('MaxShortTermLoudness', 'Highest short-term loudness in LUFS × 100, version 2.');
    r.skip(Math.min(180, r.remaining), 'Reserved', { desc: '180 reserved bytes, zero.' });
    if (r.remaining > 0) {
      b.codingHistory = zstr(r, 'CodingHistory', { desc: 'Free text: the processing steps the audio went through, one line each (A=algorithm, F=sample rate, W=word length, M=mode, T=text).' });
    }
    ctx.bext = b;
    node.data.bext = b;
    node.data.summary = [b.description, b.originator, `${b.date} ${b.time}`.trim()].filter(Boolean).join(' · ');
  },
});

chunk('cart', {
  name: 'Cart chunk (cart)',
  cat: 'meta',
  opaque: true,
  desc: 'AES46 / "CartChunk" metadata used by radio automation systems: title, artist, cue ID, start and end dates, intro and segue timing markers.',
});

// ------------------------------------------------------------ markers and loops

chunk('cue ', {
  name: 'Cue points (cue )',
  cat: 'meta',
  spec: 'MMSPEC',
  desc: 'Markers: named positions in the audio (for example the start of each take, or loop points). Labels and notes for them live in a LIST \'adtl\'.',
  more: 'dwPosition is the sample position of the marker. dwName is the ID that labl/note chunks in LIST adtl refer to.',
  parse(r, node, ctx) {
    const n = r.u32('dwCuePoints', { key: true, desc: 'Number of cue points.' });
    const rate = ctx.fmt?.sampleRate;
    const t = r.table('points', Math.min(n, Math.floor(r.remaining / 24)), 24, [
      { name: 'dwName', type: 'u32', desc: 'ID of the cue point (referenced by labl, note, ltxt and smpl loops).' },
      { name: 'dwPosition', type: 'u32', display: (v) => (rate ? `${fmtInt(v)} (${fmtDuration(v / rate)})` : fmtInt(v)), desc: 'Sample position of the cue point.' },
      { name: 'fccChunk', type: 'fourcc', desc: 'Chunk that holds the cue point: \'data\' (or \'slnt\' in a wave list).' },
      { name: 'dwChunkStart', type: 'u32', desc: 'Position of that chunk (0 for a plain data chunk).' },
      { name: 'dwBlockStart', type: 'u32', desc: 'Position of the block containing the cue (for compressed data).' },
      { name: 'dwSampleOffset', type: 'u32', desc: 'Sample offset of the cue point within the block.' },
    ], { desc: 'One 24-byte entry per cue point.' });
    ctx.cues = t;
    node.data.summary = `${fmtInt(t.count)} cue point${t.count === 1 ? '' : 's'}`;
  },
});

list('adtl', {
  name: 'Associated data list (adtl)',
  cat: 'meta',
  spec: 'MMSPEC',
  desc: 'Text attached to cue points: labels (labl), notes (note) and labelled text regions (ltxt).',
});

const cueText = (what) => ({
  cat: 'meta',
  spec: 'MMSPEC',
  parse(r, node) {
    const id = r.u32('dwName', { key: true, desc: 'ID of the cue point this text belongs to.' });
    const v = zstr(r, 'text', { key: true });
    node.label = `cue ${id}: ${v}`.slice(0, 60);
  },
  desc: `A ${what} attached to a cue point (by its ID).`,
});
chunk('labl', { name: 'Cue label (labl)', ...cueText('label') }, { inList: 'adtl' });
chunk('note', { name: 'Cue note (note)', ...cueText('comment') }, { inList: 'adtl' });
chunk('ltxt', {
  name: 'Labelled text (ltxt)',
  cat: 'meta',
  spec: 'MMSPEC',
  desc: 'Text associated with a region of the audio that starts at a cue point and lasts dwSampleLength samples.',
  parse(r, node) {
    const id = r.u32('dwName', { key: true });
    r.u32('dwSampleLength', { unit: 'samples' });
    r.fourcc('dwPurpose', { desc: 'What the text is, e.g. \'scrp\' (script) or \'capt\' (caption).' });
    r.u16('wCountry');
    r.u16('wLanguage');
    r.u16('wDialect');
    r.u16('wCodePage');
    const v = r.remaining > 0 ? zstr(r, 'text') : '';
    node.label = `cue ${id}${v ? `: ${v}` : ''}`.slice(0, 60);
  },
}, { inList: 'adtl' });

const LOOP_TYPES = { 0: 'forward', 1: 'alternating (ping-pong)', 2: 'backward' };

chunk('smpl', {
  name: 'Sampler (smpl)',
  cat: 'meta',
  spec: 'MMSPEC',
  desc: 'Settings for playing the sound in a sampler: the MIDI note it was recorded at, tuning, and loop points.',
  more: 'Used by sample libraries and samplers: dwMIDIUnityNote is the note at which the sample plays at its original pitch, and each loop gives a start and end sample position and how often to repeat.',
  parse(r, node, ctx) {
    r.u32('dwManufacturer', { desc: 'MIDI manufacturer ID of the intended sampler; 0 = any.' });
    r.u32('dwProduct');
    r.u32('dwSamplePeriod', { unit: 'ns', desc: 'Duration of one sample in nanoseconds (1e9 / sample rate).' });
    r.u32('dwMIDIUnityNote', { key: true, desc: 'MIDI note (0–127) that plays the sample at its recorded pitch; 60 = middle C.' });
    r.u32('dwMIDIPitchFraction', { desc: 'Fine tuning above the unity note, as a fraction of a semitone (0x80000000 = half a semitone).' });
    r.u32('dwSMPTEFormat', { enum: { 0: 'none', 24: '24 fps', 25: '25 fps', 29: '30 fps drop-frame', 30: '30 fps' } });
    r.u32('dwSMPTEOffset', { display: (v) => `0x${v.toString(16).padStart(8, '0')}` });
    const n = r.u32('cSampleLoops', { key: true });
    const extra = r.u32('cbSamplerData', { unit: 'bytes' });
    const rate = ctx.fmt?.sampleRate;
    const pos = (v) => (rate ? `${fmtInt(v)} (${fmtDuration(v / rate)})` : fmtInt(v));
    const t = r.table('loops', Math.min(n, Math.floor(r.remaining / 24)), 24, [
      { name: 'dwIdentifier', type: 'u32', desc: 'Cue point ID of the loop.' },
      { name: 'dwType', type: 'u32', enum: LOOP_TYPES },
      { name: 'dwStart', type: 'u32', display: pos, desc: 'First sample of the loop.' },
      { name: 'dwEnd', type: 'u32', display: pos, desc: 'Last sample of the loop.' },
      { name: 'dwFraction', type: 'u32', desc: 'Fine-tuning of the loop end, as a fraction of a sample.' },
      { name: 'dwPlayCount', type: 'u32', display: (v) => (v ? `${fmtInt(v)} times` : '0 (loop forever)') },
    ]);
    if (extra && r.remaining > 0) r.bytes('samplerData', Math.min(extra, r.remaining), { desc: 'Manufacturer-specific sampler data.' });
    node.data.summary = `${fmtInt(t.count)} loop${t.count === 1 ? '' : 's'}`;
  },
});

chunk('inst', {
  name: 'Instrument (inst)',
  cat: 'meta',
  spec: 'MMSPEC',
  desc: 'How to map the sample onto a keyboard: its base note, fine tuning, gain and the key and velocity range it covers.',
  parse(r) {
    r.u8('bUnshiftedNote', { key: true, desc: 'MIDI note at which the sample plays at its recorded pitch.' });
    r.i8('chFineTune', { unit: 'cents' });
    r.i8('chGain', { unit: 'dB' });
    r.u8('bLowNote');
    r.u8('bHighNote');
    r.u8('bLowVelocity');
    r.u8('bHighVelocity');
  },
});

chunk('acid', {
  name: 'ACID loop info (acid)',
  cat: 'meta',
  opaque: true,
  desc: 'Tempo, beat count and root note for loop-based music software (Sony/Magix ACID and others). The layout is not publicly specified, so Vidscope does not decode it.',
});

chunk('plst', {
  name: 'Playlist (plst)',
  cat: 'meta',
  spec: 'MMSPEC',
  desc: 'The order in which segments (between cue points) should be played.',
  parse(r) {
    const n = r.u32('dwSegments');
    r.table('segments', Math.min(n, Math.floor(r.remaining / 12)), 12, [
      { name: 'dwName', type: 'u32', desc: 'Cue point ID where the segment starts.' },
      { name: 'dwLength', type: 'u32', desc: 'Length in samples.' },
      { name: 'dwLoops', type: 'u32', desc: 'Number of times to play it.' },
    ]);
  },
});

// ------------------------------------------------------------ peaks, XML, ADM

chunk('levl', {
  name: 'Peak envelope (levl)',
  cat: 'meta',
  spec: 'BWF',
  maxRead: 16 << 20,
  desc: 'Pre-computed peak levels (EBU Tech 3285 supplement 3) so an editor can draw the waveform without reading all the audio.',
  more: 'Each peak value summarises dwBlockSize sample frames (256 by default): the positive and, optionally, negative peak of each block, per channel.',
  parse(r, node, ctx) {
    r.u32('dwVersion');
    const fmt = r.u32('dwFormat', { enum: { 1: 'unsigned 8-bit peak values', 2: 'unsigned 16-bit peak values' } });
    const ppv = r.u32('dwPointsPerValue', { enum: { 1: 'positive peak only', 2: 'positive and negative peak' } });
    const block = r.u32('dwBlockSize', { unit: 'sample frames', desc: 'Number of audio frames summarised by one peak value.' });
    const ch = r.u32('dwPeakChannels');
    const frames = r.u32('dwNumPeakFrames', { desc: 'Number of peak frames (one value per channel and point each).' });
    r.u32('dwPosPeakOfPeaks', { display: (v) => (v === 0xffffffff ? 'unknown' : `${fmtInt(v)} (sample frame of the loudest peak)`) });
    const off = r.u32('dwOffsetToPeaks', { unit: 'bytes', desc: 'Where the peak data starts. FFmpeg writes 128: the 8-byte chunk header plus this 120-byte structure, so Vidscope counts it from the chunk ID.' });
    r.str('strTimestamp', 28, { encoding: 'latin1', desc: 'When the peak data was computed, "yyyy:mm:dd:hh:mm:ss:uuu".' });
    if (r.remaining >= 60) r.skip(60, 'reserved');
    const gap = node.offset + off - r.abs;
    if (gap > 0 && r.remaining > gap) r.skip(gap, 'reserved');
    const bytes = (fmt === 2 ? 2 : 1) * (ppv || 1) * (ch || 1);
    if (bytes && r.remaining > 0) {
      const n = Math.min(frames, Math.floor(r.remaining / bytes));
      r.bytes('peak_envelope_data', n * bytes, { desc: `${fmtInt(n)} peak frames of ${bytes} bytes (${ch} channel${ch === 1 ? '' : 's'} × ${ppv} point${ppv === 1 ? '' : 's'} × ${fmt === 2 ? '16' : '8'} bits).` });
    }
    node.data.summary = `${fmtInt(frames)} peak frames, one per ${fmtInt(block)} samples${ctx.fmt?.sampleRate ? ` (${fmtNum((block / ctx.fmt.sampleRate) * 1000, 2)} ms)` : ''}`;
  },
  tolerateTrailing: true,
});

function xmlChunk(id, name, desc) {
  chunk(id, {
    name,
    cat: 'meta',
    maxRead: 4 << 20,
    desc,
    parse(r, node) {
      const v = text(r.u.subarray(r.pos, r.end)).replace(/\0+$/, '');
      r.bytes('xml', r.remaining, { display: `"${v.slice(0, 160).replace(/\s+/g, ' ')}${v.length > 160 ? '…' : ''}"`, desc: 'The XML document (shown shortened).' });
      const root = /<([A-Za-z_][\w:.-]*)[\s>]/.exec(v.replace(/<\?[^>]*\?>/g, ''));
      node.data.summary = `${fmtInt(v.length)} characters of XML${root ? `, root <${root[1]}>` : ''}`;
    },
  });
}
xmlChunk('iXML', 'iXML production metadata (iXML)', 'Location-recording metadata as XML (the iXML specification): scene, take, track names, timecode, and notes from the recorder.');
xmlChunk('axml', 'XML metadata (axml)', 'XML metadata (EBU Tech 3285 supplement 5), typically the Audio Definition Model (ADM, ITU-R BS.2076) describing the channels, objects and scenes of immersive audio.');

chunk('chna', {
  name: 'Channel allocation (chna)',
  cat: 'meta',
  spec: 'BW64',
  desc: 'Links each audio track (channel) of the file to its ADM description in axml, for object-based and immersive audio.',
  parse(r, node) {
    const tracks = r.u16('numTracks');
    const uids = r.u16('numUIDs');
    const t = r.table('audioIDs', Math.min(uids, Math.floor(r.remaining / 40)), 40, [
      { name: 'trackIndex', type: 'u16', desc: '1-based track (channel) number; 0 = unused slot.' },
      { name: 'UID', type: 'bytes', size: 12, display: (v) => `"${decodeText(v, 'latin1')}"`, desc: 'audioTrackUID, e.g. ATU_00000001.' },
      { name: 'trackRef', type: 'bytes', size: 14, display: (v) => `"${decodeText(v, 'latin1')}"`, desc: 'audioTrackFormat (or audioChannelFormat) ID in the ADM.' },
      { name: 'packRef', type: 'bytes', size: 11, display: (v) => `"${decodeText(v, 'latin1')}"`, desc: 'audioPackFormat ID in the ADM.' },
      { name: 'pad', type: 'u8' },
    ]);
    node.data.summary = `${tracks} tracks, ${t.count} IDs`;
  },
  tolerateTrailing: true,
});

// ------------------------------------------------------------ ID3

const ID3_TEXT_ENC = { 0: 'ISO-8859-1', 1: 'UTF-16 with BOM', 2: 'UTF-16BE', 3: 'UTF-8' };

function id3Text(u8, enc) {
  if (enc === 1) {
    if (u8[0] === 0xfe && u8[1] === 0xff) return decodeText(u8.subarray(2), 'utf-16be');
    if (u8[0] === 0xff && u8[1] === 0xfe) return decodeText(u8.subarray(2), 'utf-16le');
    return decodeText(u8, 'utf-16le');
  }
  if (enc === 2) return decodeText(u8, 'utf-16be');
  if (enc === 3) return decodeText(u8, 'utf-8');
  return decodeText(u8, 'latin1');
}

function syncsafe(u8, p) {
  return ((u8[p] & 0x7f) << 21) | ((u8[p + 1] & 0x7f) << 14) | ((u8[p + 2] & 0x7f) << 7) | (u8[p + 3] & 0x7f);
}

const ID3_DEF = {
  name: 'ID3 tag (id3 )',
  cat: 'meta',
  spec: 'ID3',
  desc: 'An ID3v2 tag (the MP3 metadata format) embedded in a WAV chunk: title, artist, album, cover art...',
  more: 'Not part of the original WAV specification, but written by many audio editors and read by most players. The tag keeps its own layout: a 10-byte header with a "synchsafe" size (7 bits per byte), then frames with a four-character ID (TIT2 title, TPE1 artist, TALB album, APIC picture...).',
  maxRead: 16 << 20,
  parse(r, node) {
    // ID3 is big-endian whatever the RIFF byte order.
    const b = new FieldReader(r.u, r.base, { start: r.pos, end: r.end, out: r.out, le: false });
    try {
      b.str('file identifier', 3, { expect: 'ID3', encoding: 'latin1' });
      const major = b.u8('version major', { display: (v) => `${v} (ID3v2.${v})` });
      b.u8('version revision');
      const flags = b.u8('flags', { display: (v) => `0x${v.toString(16).padStart(2, '0')}${v & 0x40 ? ' (extended header)' : ''}${v & 0x80 ? ' (unsynchronised)' : ''}` });
      const size = syncsafe(b.u, b.pos);
      b.bytes('size', 4, { display: `${fmtInt(size)} bytes (synchsafe: 7 bits per byte)`, desc: 'Size of the tag after this header, stored as four 7-bit groups so it can never contain a false MPEG sync pattern.' });
      const end = Math.min(b.end, b.pos + size);
      if (flags & 0x40 && b.pos + 4 <= end) {
        const ext = major >= 4 ? syncsafe(b.u, b.pos) : b.dv.getUint32(b.pos) + 4;
        b.bytes('extended header', Math.min(ext, end - b.pos));
      }
      const titles = [];
      let n = 0;
      while (b.pos + 10 <= end && n < 128) {
        if (b.u[b.pos] === 0) {
          b.bytes('padding', end - b.pos, { desc: 'Zero padding reserved for editing the tag in place.' });
          break;
        }
        const id = decodeText(b.u.subarray(b.pos, b.pos + 4), 'latin1');
        const fsize = major >= 4 ? syncsafe(b.u, b.pos + 4) : b.dv.getUint32(b.pos + 4);
        if (!/^[A-Z0-9]{4}$/.test(id) || fsize > end - b.pos - 10) break;
        b.group(id, (g) => {
          b.str('frame ID', 4, { encoding: 'latin1' });
          b.bytes('size', 4, { display: `${fmtInt(fsize)} bytes${major >= 4 ? ' (synchsafe)' : ''}` });
          b.u16('flags', { display: (v) => `0x${v.toString(16).padStart(4, '0')}` });
          if (id[0] === 'T' && fsize >= 1) {
            const enc = b.u8('encoding', { enum: ID3_TEXT_ENC });
            const v = id3Text(b.u.subarray(b.pos, b.pos + fsize - 1), enc).replace(/\0+$/, '').replace(/\0/g, ' / ');
            b.bytes('text', fsize - 1, { display: `"${v}"` });
            g.display = `"${v}"`;
            titles.push(`${id}=${v}`);
          } else {
            b.bytes('data', fsize);
            g.display = `${fmtInt(fsize)} bytes`;
          }
        });
        n++;
      }
      node.data.summary = titles.join(', ').slice(0, 120) || `ID3v2.${major}`;
      if (b.pos < b.end) b.bytes('rest', b.end - b.pos);
    } catch (e) {
      if (!(e instanceof ParseError)) throw e;
      node.warn(e.message);
    }
    r.pos = r.end;
  },
};
chunk('id3 ', ID3_DEF);
chunk('ID3 ', ID3_DEF);

chunk('DISP', {
  name: 'Display (DISP)',
  cat: 'meta',
  opaque: true,
  desc: 'Clipboard-style data to display for the file (a title as text, or an icon), from the 1991 RIFF specification.',
});

chunk('PEAK', {
  name: 'Peak chunk (PEAK)',
  cat: 'meta',
  opaque: true,
  desc: 'Peak level and its position for each channel, written by some audio applications (Apple Core Audio, Sound Designer). Vidscope does not decode it.',
});

chunk('minf', { name: 'ProTools info (minf)', cat: 'meta', opaque: true, desc: 'Private metadata written by Avid Pro Tools.' });
chunk('elm1', { name: 'ProTools info (elm1)', cat: 'meta', opaque: true, desc: 'Private metadata written by Avid Pro Tools.' });
chunk('regn', { name: 'ProTools regions (regn)', cat: 'meta', opaque: true, desc: 'Private region list written by Avid Pro Tools.' });
chunk('umid', { name: 'Material identifier (umid)', cat: 'meta', opaque: true, desc: 'A SMPTE UMID identifying the recording (some broadcast recorders).' });

