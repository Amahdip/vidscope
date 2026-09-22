// Glossary for Matroska / WebM: the concepts a newcomer needs, then every element.

import { BY_NAME, nodeDef, RFC8794, RFC9559, WEBM_URL } from './elements.js';

const CONCEPTS = [
  {
    term: 'EBML', name: 'Extensible Binary Meta Language', cat: 'type', url: RFC8794,
    desc: 'The generic binary format Matroska is built on: a tree of elements, each written as an ID, a size and data, a bit like binary XML.',
    more: 'Every EBML file starts with an EBML header element (ID 1A 45 DF A3) that names the DocType ("matroska" or "webm") and the versions a reader needs. Because every element carries its size, a reader can skip elements it does not know, which is how Matroska adds features without breaking old players.',
  },
  {
    term: 'VINT', name: 'Variable-size integer', cat: 'type', url: `${RFC8794}#section-4`,
    desc: 'The variable-length number format used for element IDs and sizes: the number of leading 0 bits in the first byte, plus one, is the length in bytes (1xxxxxxx = 1 byte, 01xxxxxx = 2 bytes, ... 00000001 = 8 bytes).',
    more: 'The first 1 bit is the "length marker". For sizes the marker is removed to get the value (0x84 = 4, 0x40 0x86 = 134); for element IDs the marker is kept as part of the ID. The same number can be written in more bytes than needed (0x82, 0x40 0x02 and 0x20 0x00 0x02 all mean 2), which writers use to reserve room for a size they will fill in later.',
  },
  {
    term: 'element ID', name: 'Element ID', cat: 'type', url: `${RFC8794}#section-5`,
    desc: 'The VINT at the start of every element that says what the element is, quoted with its length marker: 1A 45 DF A3 is the EBML header, 18 53 80 67 the Segment, A3 a SimpleBlock.',
    more: 'IDs must use their shortest form and cannot have all value bits 0 or 1. Matroska gives 1-byte IDs to elements that appear thousands of times (blocks) and 4-byte IDs to top-level elements, which rarely appear by chance and help a reader resynchronise in damaged data.',
  },
  {
    term: 'element size', name: 'Element data size', cat: 'type', url: `${RFC8794}#section-6`,
    desc: 'The VINT after the ID giving the number of bytes of data that follow the header. It lets any reader skip an element without understanding it.',
  },
  {
    term: 'unknown size', name: 'Unknown-sized element', cat: 'type', url: `${RFC8794}#section-6.2`,
    desc: 'A size whose value bits are all 1 (FF, 7F FF, ... 01 FF FF FF FF FF FF FF) means "size unknown": the element ends where the next element that cannot be inside it begins.',
    more: 'Only Segment and Cluster may have an unknown size. Live muxers use it because they write each element before knowing how big it will get (browser MediaRecorder files, live streams). Readers then have to walk through every block to find where a Cluster ends, so such files seek slowly until they are remuxed.',
  },
  {
    term: 'master element', name: 'Master element', cat: 'type', url: `${RFC8794}#section-7.7`,
    desc: 'An element whose data is a sequence of other elements (Segment, Info, TrackEntry, Cluster...), as opposed to a leaf holding a number, string, date or binary value.',
  },
  {
    term: 'element types', name: 'EBML element types', cat: 'type', url: `${RFC8794}#section-7`,
    desc: 'Leaf elements hold one value: unsigned or signed integer (0–8 bytes, big-endian), float (4 or 8 bytes), ASCII string, UTF-8 string, date (signed nanoseconds since 2001-01-01) or binary data.',
    more: 'An element with an empty value (size 0) means its default value when the schema defines one. Integers use as few bytes as needed, so the same element can be 1 byte in one file and 3 in another.',
  },
  {
    term: 'DocType', name: 'Document type', cat: 'type',
    desc: 'The name in the EBML header of the format that follows: "matroska" or "webm". Players check it before reading anything else.',
  },
  {
    term: 'WebM', name: 'WebM', cat: 'type', url: WEBM_URL,
    desc: 'The web profile of Matroska: DocType "webm", VP8/VP9/AV1 video, Vorbis/Opus audio, WebVTT text and a subset of the elements, so browsers can support all of it.',
    more: 'WebM also asks for a 1 ms TimestampScale, Cues (ideally before the Clusters), key frames at the start of Clusters and a SeekHead. A Matroska file whose codecs are all WebM codecs can be turned into WebM by remuxing.',
  },
  {
    term: 'top-level element', name: 'Top-level (level 1) element', cat: 'header', url: `${RFC9559}#section-4.5`,
    desc: 'A direct child of the Segment: SeekHead, Info, Tracks, Chapters, Cluster, Cues, Attachments or Tags. They can come in almost any order, which is why the SeekHead index exists.',
  },
  {
    term: 'Segment Position', name: 'Segment position', cat: 'index', url: `${RFC9559}#section-16`,
    desc: 'A byte offset counted from the first byte of the Segment\'s data (just after its ID and size), not from the start of the file. SeekPosition, CueClusterPosition and Cluster Position are Segment positions.',
    more: 'Relative positions mean a Segment can be copied into another file (after a different EBML header, for example) without rewriting its index.',
  },
  {
    term: 'lacing', name: 'Lacing', cat: 'media', url: `${RFC9559}#section-10.3`,
    desc: 'Packing several frames of the same track into one SimpleBlock or Block to save the per-block overhead. Used for small audio frames; never needed for video.',
    more: 'Three schemes code the frame sizes after the block header: Xiph lacing (each size as bytes added up while they are 255), EBML lacing (the first size as a VINT, then signed differences) and fixed-size lacing (all frames equal, no sizes stored). The last frame takes the remaining bytes. Only the first frame\'s timestamp is stored; the others follow at the frame duration.',
  },
  {
    term: 'Xiph lacing', name: 'Xiph lacing', cat: 'media', url: `${RFC9559}#section-10.3.2`,
    desc: 'Frame sizes written as a series of bytes that are added up while they are 255: 500 is FF F5 (255 + 245). Inherited from Ogg; efficient for small frames.',
  },
  {
    term: 'EBML lacing', name: 'EBML lacing', cat: 'media', url: `${RFC9559}#section-10.3.3`,
    desc: 'The first frame size as a VINT, then each following size as the signed difference from the previous one (a VINT minus 2^(7n−1) − 1), compact when frames have similar sizes.',
  },
  {
    term: 'fixed-size lacing', name: 'Fixed-size lacing', cat: 'media', url: `${RFC9559}#section-10.3.4`,
    desc: 'All frames in the block have the same size, so only the frame count is stored: size = (block data size) / count.',
  },
  {
    term: 'key frame', name: 'Key frame (random access point)', cat: 'media', url: `${RFC9559}#section-10.4`,
    desc: 'A frame that can be decoded without any other frame, so playback can start there. In a SimpleBlock it is the keyframe flag; a Block in a BlockGroup is a key frame when the group has no ReferenceBlock.',
  },
  {
    term: 'block header', name: 'Block header', cat: 'media', url: `${RFC9559}#section-10.1`,
    desc: 'The start of every SimpleBlock and Block: the track number (a VINT, usually 1 byte), a signed 16-bit timestamp relative to the Cluster Timestamp, and a flags byte (keyframe, invisible, lacing, discardable).',
  },
  {
    term: 'Segment ticks', name: 'Segment and track ticks', cat: 'header', url: `${RFC9559}#section-11.1`,
    desc: 'The units of Matroska timestamps: Cluster and block timestamps, Cues and Duration count TimestampScale nanoseconds (1 ms by default). DefaultDuration, CodecDelay, SeekPreRoll, DiscardPadding and chapter times are always in plain nanoseconds ("Matroska ticks").',
  },
  {
    term: 'presentation timestamp', name: 'Presentation timestamp (PTS)', cat: 'media', url: `${RFC9559}#section-11.2`,
    desc: 'Block timestamps are presentation times: when the first frame of the block must be shown. With B-frames, frames are stored in decode order, so the block timestamps go back and forth; Matroska stores no decode timestamps.',
  },
  {
    term: 'codec mapping', name: 'Codec mapping', cat: 'codec', url: 'https://datatracker.ietf.org/doc/draft-ietf-cellar-codec/',
    desc: 'For each CodecID, how frames are stored in blocks and what CodecPrivate contains, defined by the Matroska codec specifications. For example V_MPEG4/ISO/AVC stores length-prefixed H.264 NAL units with the avcC record in CodecPrivate.',
  },
  {
    term: 'header stripping', name: 'Header stripping (ContentCompAlgo 3)', cat: 'protect',
    desc: 'A content encoding that removes the bytes common to the start of every frame and stores them once in ContentCompSettings. Players must put them back before decoding; many do not support it.',
  },
  {
    term: 'live stream', name: 'Live Matroska stream', cat: 'fragment', url: `${RFC9559}#section-23.2`,
    desc: 'Matroska written as it is recorded: the Segment (and often each Cluster) has an unknown size, and there is no Duration, no Cues and usually no SeekHead. Remuxing turns it into a normal seekable file.',
  },
  {
    term: 'linked segments', name: 'Linked Segments', cat: 'header', url: `${RFC9559}#section-17`,
    desc: 'Several Segments (files) played as one presentation, identified by SegmentUUID, PrevUUID/NextUUID (hard linking) or by chapters that point into other Segments (medium linking, ordered chapters).',
  },
  {
    term: 'ordered chapters', name: 'Ordered chapters', cat: 'meta', url: `${RFC9559}#section-20.1.3`,
    desc: 'An edition with EditionFlagOrdered set: its chapters define what is played and in which order, possibly from other linked files (used to share openings between episodes).',
  },
  {
    term: 'Matroska file extensions', name: '.mkv, .mka, .mks, .mk3d, .webm', cat: 'type',
    desc: '.mkv for video, .mka for audio only, .mks for subtitles only, .mk3d for stereoscopic video, .webm for WebM. The extension is a convention: the structure is the same.',
  },
];

export function glossary() {
  const out = CONCEPTS.map((c) => ({ ...c }));
  const seen = new Set(out.map((c) => c.term.toLowerCase()));
  for (const el of BY_NAME.values()) {
    if (el.historic || seen.has(el.name.toLowerCase())) continue;
    const d = nodeDef(el);
    out.push({ term: el.name, name: el.title, desc: el.desc, more: el.more ?? undefined, cat: el.cat, url: d.specHref });
  }
  return out;
}
