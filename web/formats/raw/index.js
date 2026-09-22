// Fallback for files no parser recognises: the hex view still works, and the
// magic bytes at the start usually say what the file is.

import { Node } from '../../core/model.js';
import { Doc } from '../../core/doc.js';
import { hexBytes, humanBytes } from '../../core/util.js';

const ascii = (s) => Array.from(s, (c) => c.charCodeAt(0));

// [label, test(head), note]
const MAGIC = [
  ['MPEG program stream (.mpg, .vob)', (b) => starts(b, [0, 0, 1, 0xba]), 'Packs of PES packets, as on DVDs. Not yet parsed by Vidscope.'],
  ['MPEG-1/2 video elementary stream', (b) => starts(b, [0, 0, 1, 0xb3]), 'A raw video stream starting with a sequence header, without any container.'],
  ['H.264/HEVC Annex B elementary stream', (b) => starts(b, [0, 0, 0, 1]) || starts(b, [0, 0, 1]), 'Raw NAL units separated by start codes, without a container (e.g. .h264, .265).'],
  ['Ogg (Vorbis, Opus, Theora)', (b) => starts(b, ascii('OggS')), 'Ogg pages; not yet parsed by Vidscope.'],
  ['MP3 with an ID3 tag', (b) => starts(b, ascii('ID3')), 'An ID3v2 tag followed by MPEG audio frames.'],
  ['MPEG audio (MP3)', (b) => b[0] === 0xff && (b[1] & 0xe0) === 0xe0, 'MPEG audio frames without a container.'],
  ['AAC with ADTS headers', (b) => b[0] === 0xff && (b[1] & 0xf6) === 0xf0, 'Raw AAC frames, each with a 7- or 9-byte ADTS header.'],
  ['FLAC audio', (b) => starts(b, ascii('fLaC')), 'Native FLAC stream.'],
  ['Core Audio Format (CAF)', (b) => starts(b, ascii('caff')), 'Apple Core Audio file.'],
  ['MXF (Material Exchange Format)', (b) => starts(b, [0x06, 0x0e, 0x2b, 0x34]), 'SMPTE KLV-coded professional video container.'],
  ['ASF / WMV / WMA', (b) => starts(b, [0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11]), 'Microsoft Advanced Systems Format.'],
  ['RealMedia', (b) => starts(b, ascii('.RMF')), 'RealNetworks container.'],
  ['HLS playlist (M3U8)', (b) => starts(b, ascii('#EXTM3U')), 'A text playlist that points at media segments, not media itself.'],
  ['XML (e.g. a DASH manifest)', (b) => starts(b, ascii('<?xml')) || starts(b, ascii('<MPD')), 'Text markup; a DASH MPD lists the segments of a stream.'],
  ['WebVTT subtitles', (b) => starts(b, ascii('WEBVTT')) || starts(b, [0xef, 0xbb, 0xbf, ...ascii('WEBVTT')]), 'Text subtitles for the web.'],
  ['PNG image', (b) => starts(b, [0x89, 0x50, 0x4e, 0x47]), ''],
  ['JPEG image', (b) => starts(b, [0xff, 0xd8, 0xff]), ''],
  ['GIF image', (b) => starts(b, ascii('GIF8')), ''],
  ['ZIP archive', (b) => starts(b, [0x50, 0x4b, 0x03, 0x04]), ''],
  ['PDF document', (b) => starts(b, ascii('%PDF')), ''],
];

function starts(b, sig) {
  if (b.length < sig.length) return false;
  for (let i = 0; i < sig.length; i++) if (b[i] !== sig[i]) return false;
  return true;
}

export function identify(head) {
  for (const [label, test, note] of MAGIC) if (test(head)) return { label, note };
  return null;
}

class RawDoc extends Doc {
  async insights() {
    const head = await this.source.read(0, Math.min(this.size, 16));
    const guess = identify(head);
    return [
      {
        level: 'warn',
        group: 'Overview',
        title: guess ? `Looks like ${guess.label}` : 'Not a recognised container',
        text: guess
          ? `${guess.note ? `${guess.note} ` : ''}Vidscope shows its bytes, but has no parser for this format, so there is no structure to explore.`
          : 'Vidscope found no known container signature at the start of the file. You can still browse the bytes, and search them with the find box above the hex view.',
        facts: [['first bytes', hexBytes(head, 16)], ['size', humanBytes(this.size)]],
      },
    ];
  }
}

export default {
  id: 'raw',
  name: 'Unknown format',
  unit: ['byte', 'bytes'],
  probe: () => 1,
  async open(source) {
    const root = new Node({ type: source.name, name: source.name, kind: 'file', offset: 0, size: source.size, category: 'file' });
    const doc = new RawDoc({ source, format: this, root });
    const head = await source.read(0, Math.min(source.size, 16));
    const guess = identify(head);
    doc.summary = { label: guess ? `${guess.label} (not parsed)` : 'Unknown format', anatomy: 'raw bytes', duration: null, unitCount: source.size };
    return doc;
  },
};
