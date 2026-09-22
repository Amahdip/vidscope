// The Matroska element dictionary: the exact schema (schema.js) plus Vidscope's
// plain-language descriptions, display hints and colour categories.

import { ROWS, ENUMS } from './schema.js';
import { hexId } from './ebml.js';

export const RFC9559 = 'https://www.rfc-editor.org/rfc/rfc9559';
export const RFC8794 = 'https://www.rfc-editor.org/rfc/rfc8794';
export const REGISTRY_URL = 'https://www.matroska.org/technical/elements.html';
export const WEBM_URL = 'https://www.webmproject.org/docs/container/';

const TYPE_NAMES = { m: 'master', u: 'uinteger', i: 'integer', f: 'float', s: 'string', 8: 'utf-8', d: 'date', b: 'binary' };
const TYPE_LABEL = {
  m: 'master (contains other elements)', u: 'unsigned integer', i: 'signed integer', f: 'float', s: 'ASCII string',
  8: 'UTF-8 string', d: 'date', b: 'binary',
};

const HISTORIC = 'Historic element listed in RFC 9559 Appendix A: it was defined in early Matroska versions but is not used by current files, and readers may ignore it.';

// Descriptions by element name. title: friendly name; cat: colour family (default: from the parent);
// show: how to display the value (see values.js); more: the details.
const D = {
  // ------------------------------------------------------------ EBML header (RFC 8794)
  EBML: {
    title: 'EBML Header', cat: 'type',
    desc: 'The first element of every Matroska and WebM file. It says which EBML-based format follows (DocType "matroska" or "webm") and which versions a reader needs.',
    more: 'A Matroska file is an EBML document: a tree of elements, each written as ID, size and data. This header plays the role of an XML declaration: a reader checks DocType and DocTypeReadVersion before going further. Several EBML documents may follow each other in one file (an EBML stream); each new EBML header starts a new document with its own Segment.',
  },
  EBMLVersion: { title: 'EBML Version', desc: 'Version of the EBML rules the file was written with. Always 1: RFC 8794 defines EBML version 1.' },
  EBMLReadVersion: { title: 'EBML Read Version', desc: 'Minimum EBML version a reader must support to read the file. Always 1.' },
  EBMLMaxIDLength: { title: 'EBML Max ID Length', desc: 'Longest element ID in the file, in bytes. Matroska requires 4, so every ID is 1 to 4 bytes long.' },
  EBMLMaxSizeLength: {
    title: 'EBML Max Size Length',
    desc: 'Longest element size field in the file, in bytes (1 to 8). With the usual 8, sizes up to 2^56 − 2 bytes can be written.',
  },
  DocType: {
    title: 'Document Type',
    desc: 'The format of the document: "matroska" for Matroska (.mkv, .mka, .mk3d, .mks) or "webm" for WebM, the web-oriented subset of Matroska.',
    more: 'WebM is Matroska restricted to a few codecs (VP8, VP9 and AV1 video, Vorbis and Opus audio, WebVTT text) and to a subset of elements, so that browsers can support all of it. The WebM guidelines tell demuxers to open only files whose DocType is "webm".',
  },
  DocTypeVersion: {
    title: 'Document Type Version',
    desc: 'The highest Matroska version of any element used in the file. For example a file with SimpleBlocks needs at least 2, one with CueRelativePosition or Colour needs 4.',
  },
  DocTypeReadVersion: {
    title: 'Document Type Read Version',
    desc: 'The minimum Matroska version a player must support to play the file, possibly ignoring some features. Usually 2: elements from later versions (such as CueRelativePosition) only help and can be skipped by older players.',
  },
  DocTypeExtension: { title: 'DocType Extension', desc: 'Declares an extension that adds extra elements to this DocType and version. Rarely used; readers may know the extension or ignore it.' },
  DocTypeExtensionName: { title: 'DocType Extension Name', desc: 'The name of the DocType extension.' },
  DocTypeExtensionVersion: { title: 'DocType Extension Version', desc: 'The version of the DocType extension.' },
  'CRC-32': {
    title: 'CRC-32 checksum', cat: 'protect',
    desc: 'A checksum of the rest of its parent element: the IEEE CRC-32 (the one zlib and PNG use) of every byte of the parent\'s data that follows this element, stored little-endian.',
    more: 'When present it must be the first child of its parent. RFC 9559 recommends one in every top-level element (not in the Segment itself). If it does not match, the element was damaged or edited without updating the checksum, and a reader may ignore its contents. Vidscope recomputes it whenever it reads the parent: ✓ means the bytes are intact.',
  },
  Void: {
    title: 'Void (padding)', cat: 'free',
    desc: 'Filler whose content is ignored. Writers use Void to reserve room (after the SeekHead, or for Cues to be written at the front later) and to blank out an element that was removed or shrunk, so that nothing else has to move.',
    more: 'RFC 9559 recommends a Void right after the first SeekHead, so that the index can later grow to include Tags, Chapters or Attachments without rewriting the file. A tag editor that shrinks the Tags element also leaves a Void behind.',
  },

  // ------------------------------------------------------------ Segment and SeekHead
  Segment: {
    title: 'Segment', cat: 'header',
    desc: 'The root element that holds everything else: metadata, tracks, the media data (Clusters), the seek index (Cues), chapters, tags and attachments.',
    more: 'All positions stored inside a Segment (SeekPosition, CueClusterPosition, Cluster Position) count bytes from the first byte of the Segment\'s data, just after its header, not from the start of the file. Muxers usually give the Segment an 8-byte size so they can fill it in after writing everything; a live stream leaves it unknown (all value bits set) and the Segment then runs to the end of the file.',
  },
  SeekHead: {
    title: 'Seek Head (index of top-level elements)', cat: 'index',
    desc: 'An index of where the other top-level elements (Info, Tracks, Cues, Tags, Chapters...) are, so a player can jump straight to them instead of reading through the whole file.',
    more: 'Matroska allows top-level elements in almost any order, and Cues and Tags are often written after the media, at the end of the file. The SeekHead should be the first element of the Segment and list every other top-level element (a second SeekHead may list the Clusters). Entries that point to the wrong place after a file was edited are a classic cause of slow startup or of chapters and tags that players do not find.',
  },
  Seek: { title: 'Seek entry', desc: 'One index entry: the ID of a top-level element and its position in the Segment.' },
  SeekID: { title: 'Seek ID', desc: 'The element ID of the indexed element, stored as its raw ID bytes (for example 15 49 A9 66 for Info).', show: 'seekid' },
  SeekPosition: { title: 'Seek Position', desc: 'Where the indexed element starts, in bytes from the start of the Segment\'s data (not from the start of the file).', show: 'segpos' },

  // ------------------------------------------------------------ Info
  Info: {
    title: 'Segment Information', cat: 'header',
    desc: 'General information about the Segment: the timestamp unit (TimestampScale), the duration, the title, the creation date and the programs that wrote the file.',
    more: 'Info is the only mandatory top-level element. TimestampScale is the value that matters most: every Cluster and block timestamp in the file is multiplied by it to get nanoseconds.',
  },
  SegmentUUID: {
    title: 'Segment UUID', show: 'uuid',
    desc: 'A random 128-bit identifier of this Segment. It matters when Segments are linked together, for example a recording split across several files or ordered chapters that play parts of another file.',
  },
  SegmentFilename: { title: 'Segment Filename', desc: 'A filename for this Segment, for information only.' },
  PrevUUID: { title: 'Previous Segment UUID', show: 'uuid', desc: 'Identifier of the previous Segment when several files are hard-linked into one continuous presentation.' },
  PrevFilename: { title: 'Previous Filename', desc: 'Filename of the previous linked Segment, for display; PrevUUID is authoritative.' },
  NextUUID: { title: 'Next Segment UUID', show: 'uuid', desc: 'Identifier of the next Segment when several files are hard-linked into one continuous presentation.' },
  NextFilename: { title: 'Next Filename', desc: 'Filename of the next linked Segment, for display; NextUUID is authoritative.' },
  SegmentFamily: { title: 'Segment Family', show: 'uuid', desc: 'A 128-bit identifier shared by all the Segments of a linked set.' },
  ChapterTranslate: { title: 'Chapter Translate', desc: 'Maps this Segment to the value a chapter codec (Matroska Script or DVD menus) uses to refer to it.' },
  ChapterTranslateID: { title: 'Chapter Translate ID', desc: 'The value the chapter codec uses for this Segment; its format depends on the chapter codec.' },
  ChapterTranslateCodec: { title: 'Chapter Translate Codec', desc: 'The chapter codec this mapping is for (same values as ChapProcessCodecID: 0 Matroska Script, 1 DVD menu).', show: 'chapcodec' },
  ChapterTranslateEditionUID: { title: 'Chapter Translate Edition UID', desc: 'An edition this mapping applies to; without it the mapping applies to every edition using that chapter codec.', show: 'uid' },
  TimestampScale: {
    title: 'Timestamp Scale', show: 'scale',
    desc: 'The length of one timestamp tick, in nanoseconds. Cluster and block timestamps, Cues and the Duration are counted in these ticks.',
    more: 'The default 1,000,000 makes one tick a millisecond, which is what most files use (WebM asks for it). Because block timestamps are 16-bit offsets from their Cluster\'s timestamp, the tick size also limits a Cluster to 32,767 ticks (about 32.8 s at 1 ms). A smaller scale gives finer timestamps, useful for sample-accurate audio, at the cost of shorter Clusters. With 1 ms ticks, 29.97 fps video cannot be timed exactly: timestamps are rounded to the nearest millisecond.',
  },
  Duration: {
    title: 'Duration', show: 'fticks',
    desc: 'The length of the Segment in TimestampScale ticks, stored as a float (4021.0 × 1 ms = 4.021 s).',
    more: 'Players use it to draw the seek bar before reading the whole file. Live recordings, such as browser MediaRecorder WebM files, usually have no Duration (and no Cues), which is why they show no length until they are remuxed.',
  },
  DateUTC: { title: 'Date (UTC)', desc: 'When the file was muxed, as nanoseconds since 2001-01-01 00:00:00 UTC.' },
  Title: { title: 'Title', desc: 'The title of the whole Segment, which players show as the file title.' },
  MuxingApp: {
    title: 'Muxing Application',
    desc: 'The library that wrote the Matroska structure, with its version: "Lavf…" is FFmpeg\'s libavformat, "libebml … + libmatroska …" is used by MKVToolNix, "Chrome" by Chrome\'s MediaRecorder, "QTmuxingAppLibWebM…" by libwebm-based recorders such as Firefox\'s.',
  },
  WritingApp: { title: 'Writing Application', desc: 'The application that created the file, with its version (for example "mkvmerge v80.0 (\'…\') 64-bit" or "Lavf62.12.101").' },

  // ------------------------------------------------------------ Cluster
  Cluster: {
    title: 'Cluster', cat: 'fragment',
    desc: 'A group of consecutive blocks (the actual audio, video and subtitle frames) that share one base timestamp. Clusters make up almost the whole file.',
    more: 'Each block stores its time as a signed 16-bit offset from the Cluster Timestamp, so a new Cluster must start at least every 32,767 ticks (about 32.8 s at 1 ms per tick); RFC 9559 recommends at most 5 seconds or 5 MB per Cluster. Seeking works at Cluster granularity: Cues point to the start of a Cluster, which is why muxers usually start a new Cluster at a video key frame. Vidscope reads a Cluster\'s contents only when you open it.',
  },
  Timestamp: {
    title: 'Cluster Timestamp', show: 'ticks',
    desc: 'The base time of this Cluster in TimestampScale ticks. Each block\'s own 16-bit timestamp is added to it.',
    more: 'It should be the first child of the Cluster (or the second, after a CRC-32) so that a player knows it before reading any block. Historically this element was called "Timecode".',
  },
  SilentTracks: { title: 'Silent Tracks', desc: `Listed tracks that have no data in this part of the stream. ${HISTORIC}` },
  SilentTrackNumber: { title: 'Silent Track Number', desc: `A track without data in this part of the stream. ${HISTORIC}`, show: 'track' },
  Position: {
    title: 'Cluster Position', show: 'segpos',
    desc: 'The Cluster\'s own position in the Segment (from the start of the Segment\'s data), which can help a reader resynchronise in a damaged file. Only defined up to Matroska v4.',
  },
  PrevSize: { title: 'Previous Cluster Size', show: 'bytes', desc: 'The size in bytes of the previous Cluster, so that a player can step backwards through the file (for example to play in reverse).' },
  SimpleBlock: {
    title: 'Simple Block', cat: 'media',
    desc: 'One frame (or several laced frames) of one track: a small header with the track number, a 16-bit timestamp relative to the Cluster and a flags byte, followed by the frame data. Most frames of modern files are stored this way.',
    more: 'Header: the track number as a VINT (usually one byte: 0x81 is track 1), a signed 16-bit timestamp added to the Cluster Timestamp, and flags: keyframe (the frame can be decoded on its own, so playback can start here), invisible (decode but do not show), lacing (several frames packed in one block, with their sizes coded after the header) and discardable (may be dropped when the player is late). Unlike a BlockGroup it cannot carry a duration or references, so subtitles, which need a duration, usually use BlockGroups.',
  },
  BlockGroup: {
    title: 'Block Group', cat: 'media',
    desc: 'A Block plus extra information about it: its duration, which other frames it depends on (ReferenceBlock), a new codec state or discard padding.',
    more: 'A frame in a BlockGroup is a key frame when the group has no ReferenceBlock. Muxers use BlockGroups when a frame needs a BlockDuration (subtitles, the last audio frame) or another extra; otherwise they use the smaller SimpleBlock.',
  },
  Block: {
    title: 'Block', cat: 'media',
    desc: 'The frame data of a BlockGroup: track number, 16-bit relative timestamp, flags and the frame(s). Like a SimpleBlock, but without keyframe and discardable flags: the BlockGroup\'s ReferenceBlocks say whether it is a key frame.',
  },
  BlockVirtual: { title: 'Block Virtual', cat: 'media', desc: `A block without data. ${HISTORIC}` },
  BlockAdditions: {
    title: 'Block Additions', cat: 'media',
    desc: 'Extra data attached to the Block, such as the alpha channel of VP8/VP9 video with transparency, WebVTT comments or dynamic HDR metadata (ITU-T T.35).',
  },
  BlockMore: { title: 'Block More', cat: 'media', desc: 'One piece of additional data: an ID saying what it is (BlockAddID) and the data itself (BlockAdditional).' },
  BlockAdditional: { title: 'Block Additional', cat: 'media', desc: 'The additional data, interpreted according to BlockAddID.' },
  BlockAddID: {
    title: 'Block Add ID', cat: 'media',
    desc: 'Says how to interpret BlockAdditional: 1 means "defined by the codec" (for example the VP9 alpha channel); other values refer to a BlockAdditionMapping of the track.',
  },
  BlockDuration: {
    title: 'Block Duration', show: 'trackticks',
    desc: 'How long the Block lasts, in track ticks. Needed for subtitles (how long a line stays on screen) and for a track\'s last frame; otherwise the duration comes from DefaultDuration or from the next block.',
  },
  ReferencePriority: { title: 'Reference Priority', desc: 'Cache priority of a frame that other frames reference; 0 means no frame references it. Rarely used.' },
  ReferenceBlock: {
    title: 'Reference Block', show: 'reltrackticks',
    desc: 'Says that this frame depends on another frame, given as a timestamp offset from this Block in track ticks. Its presence means the frame is not a key frame.',
    more: 'Writers often store a single reference (such as −40 for "the previous frame") rather than all of them. The value 0 means the frame references itself or an unknown frame: it is used for intra-only frames that are nevertheless not safe places to start decoding.',
  },
  ReferenceVirtual: { title: 'Reference Virtual', desc: `Segment position of the data of a virtual block. ${HISTORIC}`, show: 'segpos' },
  CodecState: { title: 'Codec State', desc: 'New codec initialisation data that applies from this block on, replacing CodecPrivate. Private to the codec and rarely used.' },
  DiscardPadding: {
    title: 'Discard Padding', show: 'ns',
    desc: 'Duration of padding in this audio block to throw away when playing, in nanoseconds: a positive value trims the end of the block, a negative value its start. Opus in WebM uses it on the last packet to end the audio at the exact sample.',
  },
  Slices: { title: 'Slices', desc: `Slice (time slice) descriptions of the Block. ${HISTORIC}` },
  TimeSlice: { title: 'Time Slice', desc: `Timing information about part of the Block. ${HISTORIC}` },
  LaceNumber: { title: 'Lace Number', desc: `Reverse number of a frame in the lace. ${HISTORIC}` },
  FrameNumber: { title: 'Frame Number', desc: `Number of the frame to generate from a lace. ${HISTORIC}` },
  BlockAdditionID: { title: 'Block Addition ID', desc: `ID of a BlockAdditional (0 = the main Block). ${HISTORIC}` },
  Delay: { title: 'Delay', desc: `Delay to apply to part of the Block, in track ticks. ${HISTORIC}` },
  SliceDuration: { title: 'Slice Duration', desc: `Duration of part of the Block, in track ticks. ${HISTORIC}` },
  ReferenceFrame: { title: 'Reference Frame', desc: `DivX trick-play information about the last reference frame. ${HISTORIC}` },
  ReferenceOffset: { title: 'Reference Offset', desc: `Offset of the previous trick-play BlockGroup. ${HISTORIC}` },
  ReferenceTimestamp: { title: 'Reference Timestamp', desc: `Timestamp of the BlockGroup pointed to by ReferenceOffset. ${HISTORIC}` },
  EncryptedBlock: { title: 'Encrypted Block', cat: 'media', desc: `A SimpleBlock whose data is encrypted or signed. ${HISTORIC}` },

  // ------------------------------------------------------------ Tracks
  Tracks: {
    title: 'Tracks', cat: 'track',
    desc: 'The list of tracks (video, audio, subtitles...) with everything a player needs to decode each of them: codec, codec configuration, language, picture size, sample rate...',
  },
  TrackEntry: {
    title: 'Track Entry', cat: 'track',
    desc: 'The description of one track: its number (which blocks refer to), its type, codec, codec configuration and properties.',
    more: 'Blocks name their track by TrackNumber. TrackUID is a random 64-bit identifier used by Tags and Chapters to target the track; it is meant to survive remuxing, while the number may change. CodecID names the codec and CodecPrivate carries its setup data (for H.264, the avcC record with the SPS and PPS).',
  },
  TrackNumber: { title: 'Track Number', show: 'track', desc: 'The number that blocks use to say which track they belong to: the VINT at the start of every SimpleBlock and Block. Usually 1, 2, 3...' },
  TrackUID: { title: 'Track UID', show: 'uid', desc: 'A random 64-bit identifier of the track, used by Tags and Chapters to refer to it. It is meant to stay the same when the file is remuxed, unlike TrackNumber.' },
  TrackType: {
    title: 'Track Type',
    desc: 'The kind of data in the track: 1 video, 2 audio, 17 subtitle; more rarely 3 complex, 16 logo, 18 buttons, 32 control, 33 metadata.',
  },
  FlagEnabled: { title: 'Enabled flag', desc: 'Whether the track is usable (1). Players should ignore a disabled track.' },
  FlagDefault: {
    title: 'Default flag',
    desc: 'Whether the player may choose this track automatically (1 = eligible). Players combine it with the user\'s language preferences to pick the audio and subtitle tracks at startup.',
  },
  FlagForced: {
    title: 'Forced flag',
    desc: 'For subtitles: 1 means the player should show this track even when subtitles are off, if its language matches — used for translations of foreign-language dialogue or on-screen text.',
  },
  FlagHearingImpaired: { title: 'Hearing-impaired flag', desc: 'Set to 1 when the track is suitable for people with hearing impairments (for example subtitles with sound descriptions).' },
  FlagVisualImpaired: { title: 'Visually-impaired flag', desc: 'Set to 1 when the track is suitable for people with visual impairments (for example audio description).' },
  FlagTextDescriptions: { title: 'Text descriptions flag', desc: 'Set to 1 when the track contains text descriptions of the video content.' },
  FlagOriginal: { title: 'Original language flag', desc: 'Set to 1 when the track is in the content\'s original language.' },
  FlagCommentary: { title: 'Commentary flag', desc: 'Set to 1 when the track contains commentary.' },
  FlagLacing: { title: 'Lacing flag', desc: 'Whether blocks of this track may use lacing (several frames in one block). 0 forbids it.' },
  MinCache: { title: 'Min Cache', desc: `Minimum number of frames a player should cache. ${HISTORIC}` },
  MaxCache: { title: 'Max Cache', desc: `Maximum cache size needed for referenced frames. ${HISTORIC}` },
  DefaultDuration: {
    title: 'Default Duration', show: 'ns',
    desc: 'The duration of one frame in nanoseconds when all frames of the track last the same, e.g. 40,000,000 ns = 40 ms = 25 fps. Players use it to time frames and to work out the timestamps of laced frames.',
    more: 'For video it effectively states the frame rate; for audio it is the duration of one codec frame (1,024 AAC samples at 48 kHz = 21.333 ms). Unlike block timestamps it is in nanoseconds, not in TimestampScale ticks. It is only a default: a BlockDuration overrides it for one block.',
  },
  DefaultDecodedFieldDuration: {
    title: 'Default Decoded Field Duration', show: 'ns',
    desc: 'The time between two successive fields at the decoder output, in nanoseconds (half the frame period for progressive video). Useful for interlaced and telecined video.',
  },
  TrackTimestampScale: {
    title: 'Track Timestamp Scale',
    desc: 'A factor applied to this track\'s block timestamps (default 1.0). Only defined up to Matroska v3, and most players ignore values other than 1.0.',
  },
  TrackOffset: { title: 'Track Offset', desc: `A value to add to the track's block timestamps, in nanoseconds. ${HISTORIC}`, show: 'ns' },
  MaxBlockAdditionID: { title: 'Max Block Addition ID', desc: 'The highest BlockAddID used in this track\'s BlockAdditions; 0 means the track has none.' },
  BlockAdditionMapping: {
    title: 'Block Addition Mapping',
    desc: 'Declares a kind of per-frame additional data (BlockAdditions) that the track uses, or extra data for the whole track, such as a Dolby Vision configuration (dvcC).',
  },
  BlockAddIDValue: { title: 'Block Add ID Value', desc: 'The BlockAddID value this mapping describes.' },
  BlockAddIDName: { title: 'Block Add ID Name', desc: 'A human-readable name for this kind of additional data.' },
  BlockAddIDType: {
    title: 'Block Add ID Type', show: 'addidtype',
    desc: 'Registered identifier of the kind of additional data: 4 = ITU-T T.35 metadata (HDR10+), 121 = SMPTE ST 12-1 timecode, and four-character codes such as \'dvcC\'/\'dvvC\' for Dolby Vision configurations.',
  },
  BlockAddIDExtraData: { title: 'Block Add ID Extra Data', desc: 'Data for the whole track that goes with this mapping, such as the Dolby Vision configuration record.' },
  Name: { title: 'Track Name', desc: 'A human-readable name for the track, such as "Director\'s commentary" or "English SDH".' },
  Language: {
    title: 'Language', show: 'lang',
    desc: 'The track language as an ISO 639-2 code ("eng", "fre", "und" for undetermined). Ignored when LanguageBCP47 is present.',
    more: 'The default value is "eng": a track without any Language element is officially English. Writers that do not know the language should write "und".',
  },
  LanguageBCP47: { title: 'Language (BCP 47)', show: 'lang', desc: 'The track language as a BCP 47 tag ("en-US", "pt-BR", "zh-Hant"), preferred since Matroska v4. When present, Language is ignored.' },
  CodecID: {
    title: 'Codec ID', cat: 'codec', show: 'codecid',
    desc: 'The codec of the track as a Matroska codec string: V_MPEG4/ISO/AVC (H.264), V_VP9, A_AAC, A_OPUS, S_TEXT/UTF8 (SRT subtitles)... The prefix gives the kind: V_ video, A_ audio, S_ subtitle.',
    more: 'The CodecID also fixes how frames are stored in blocks and what CodecPrivate contains. For H.264 and HEVC, frames are length-prefixed NAL units and CodecPrivate holds the avcC/hvcC record; for AAC, frames are raw AAC (no ADTS headers) and CodecPrivate holds the AudioSpecificConfig.',
  },
  CodecPrivate: {
    title: 'Codec Private Data', cat: 'codec',
    desc: 'The codec\'s initialisation data, needed before the first frame can be decoded: the avcC record with the H.264 SPS/PPS, the AAC AudioSpecificConfig, the OpusHead, the three Vorbis headers...',
    more: 'Its format depends on the CodecID. When it is missing or wrong the track usually cannot be decoded at all, even though every frame is intact.',
  },
  CodecName: { title: 'Codec Name', cat: 'codec', desc: 'A human-readable name of the codec, for information only.' },
  AttachmentLink: { title: 'Attachment Link', show: 'uid', desc: 'The FileUID of an attachment this track needs, typically a font used by ASS/SSA subtitles. Only defined up to Matroska v3.' },
  CodecSettings: { title: 'Codec Settings', cat: 'codec', desc: `A description of the encoder settings. ${HISTORIC}` },
  CodecInfoURL: { title: 'Codec Info URL', cat: 'codec', desc: `A URL with information about the codec. ${HISTORIC}` },
  CodecDownloadURL: { title: 'Codec Download URL', cat: 'codec', desc: `A URL to download the codec. ${HISTORIC}` },
  CodecDecodeAll: { title: 'Codec Decode All', cat: 'codec', desc: `Whether the codec can decode damaged data. Old muxers still write it. ${HISTORIC}` },
  TrackOverlay: { title: 'Track Overlay', desc: `A track to use when this one has a gap. ${HISTORIC}`, show: 'track' },
  CodecDelay: {
    title: 'Codec Delay', cat: 'codec', show: 'ns',
    desc: 'Delay built into the codec, in nanoseconds: how much decoded audio to throw away at the start (for Opus, the encoder "pre-skip"). It must be subtracted from every block timestamp of the track to get the time a frame is actually played.',
  },
  SeekPreRoll: {
    title: 'Seek Pre-Roll', cat: 'codec', show: 'ns',
    desc: 'How much audio must be decoded before a seek point for the output to be correct again, in nanoseconds (80 ms for Opus). Players seek that much earlier and discard the result.',
  },
  TrackTranslate: { title: 'Track Translate', desc: 'Maps this track to the value a chapter codec (Matroska Script or DVD menus) uses to refer to it.' },
  TrackTranslateTrackID: { title: 'Track Translate Track ID', desc: 'The value the chapter codec uses for this track.' },
  TrackTranslateCodec: { title: 'Track Translate Codec', desc: 'The chapter codec this mapping is for (0 Matroska Script, 1 DVD menu).', show: 'chapcodec' },
  TrackTranslateEditionUID: { title: 'Track Translate Edition UID', show: 'uid', desc: 'An edition this mapping applies to.' },
  Video: {
    title: 'Video settings', cat: 'codec',
    desc: 'Picture properties of a video track: coded size, display size and aspect ratio, cropping, interlacing, stereo 3D, colour and HDR metadata, projection.',
  },
  FlagInterlaced: { title: 'Interlaced flag', desc: 'Whether the frames are interlaced: 1 interlaced, 2 progressive, 0 undetermined.' },
  FieldOrder: { title: 'Field Order', desc: 'The field order of interlaced video: top field first (tff) or bottom field first (bff), with the fields stored separately or interleaved.' },
  StereoMode: { title: 'Stereo Mode', desc: 'How a stereoscopic (3D) picture is packed: side by side, top-bottom, checkerboard, anaglyph... 0 means ordinary 2D video.' },
  AlphaMode: { title: 'Alpha Mode', desc: 'Whether BlockAdditions with BlockAddID 1 carry an alpha (transparency) channel, as in VP8/VP9 WebM videos with transparency.' },
  OldStereoMode: { title: 'Old Stereo Mode', desc: 'An incorrect variant of StereoMode written by old libmatroska versions; only valid in files up to Matroska v2.' },
  PixelWidth: { title: 'Pixel Width', show: 'px', desc: 'Width of the coded frames in pixels, before any cropping.' },
  PixelHeight: { title: 'Pixel Height', show: 'px', desc: 'Height of the coded frames in pixels, before any cropping.' },
  PixelCropBottom: { title: 'Pixel Crop Bottom', show: 'px', desc: 'Rows of pixels to hide at the bottom of the coded frame when displaying it. Cropping is applied before scaling to the display size.' },
  PixelCropTop: { title: 'Pixel Crop Top', show: 'px', desc: 'Rows of pixels to hide at the top of the coded frame when displaying it.' },
  PixelCropLeft: { title: 'Pixel Crop Left', show: 'px', desc: 'Columns of pixels to hide on the left of the coded frame when displaying it.' },
  PixelCropRight: { title: 'Pixel Crop Right', show: 'px', desc: 'Columns of pixels to hide on the right of the coded frame when displaying it.' },
  DisplayWidth: {
    title: 'Display Width', show: 'dispunit',
    desc: 'Width to show the (cropped) frame at, in DisplayUnit (pixels by default). Together with DisplayHeight it sets the display aspect ratio: 720×576 coded and 1024×576 displayed is anamorphic 16:9.',
  },
  DisplayHeight: { title: 'Display Height', show: 'dispunit', desc: 'Height to show the (cropped) frame at, in DisplayUnit (pixels by default).' },
  DisplayUnit: { title: 'Display Unit', desc: 'The unit of DisplayWidth and DisplayHeight: 0 pixels, 1 centimetres, 2 inches, 3 only the display aspect ratio. WebM only allows pixels.' },
  AspectRatioType: { title: 'Aspect Ratio Type', desc: `How the aspect ratio may be changed. ${HISTORIC}` },
  UncompressedFourCC: { title: 'Uncompressed FourCC', show: 'fourcc', desc: 'The pixel format of uncompressed video (V_UNCOMPRESSED) as a FourCC, like biCompression in AVI files.' },
  GammaValue: { title: 'Gamma Value', desc: `The gamma of the video. ${HISTORIC}` },
  FrameRate: { title: 'Frame Rate', desc: `An informative frame rate; DefaultDuration is used instead. ${HISTORIC}` },
  Colour: {
    title: 'Colour', cat: 'codec',
    desc: 'How to interpret the pixel values: matrix coefficients, primaries, transfer function, range, chroma subsampling and siting, plus HDR metadata. The code points are those of ITU-T H.273, as in the video bitstream.',
    more: 'Players use it to convert to RGB correctly. For HDR10 expect Primaries 9 (BT.2020), TransferCharacteristics 16 (PQ) and MatrixCoefficients 9, with MaxCLL/MaxFALL and MasteringMetadata; HLG uses TransferCharacteristics 18. When the container and the bitstream disagree, players differ in which one they trust.',
  },
  MatrixCoefficients: { title: 'Matrix Coefficients', desc: 'Matrix used to convert between RGB and YCbCr (H.273 table 4): 1 BT.709, 6 BT.601 (SMPTE 170M), 9 BT.2020 non-constant luminance, 2 unspecified.' },
  BitsPerChannel: { title: 'Bits Per Channel', desc: 'Decoded bits per colour channel (8, 10, 12...); 0 means unspecified.' },
  ChromaSubsamplingHorz: { title: 'Chroma Subsampling Horizontal', desc: 'Horizontal chroma subsampling, as the number of chroma pixels removed for each one kept: 1 for 4:2:0 and 4:2:2, 0 for 4:4:4.' },
  ChromaSubsamplingVert: { title: 'Chroma Subsampling Vertical', desc: 'Vertical chroma subsampling: 1 for 4:2:0, 0 for 4:2:2 and 4:4:4.' },
  CbSubsamplingHorz: { title: 'Cb Subsampling Horizontal', desc: 'Extra horizontal subsampling of the Cb channel only, added to ChromaSubsamplingHorz (for unusual formats such as 4:2:1).' },
  CbSubsamplingVert: { title: 'Cb Subsampling Vertical', desc: 'Extra vertical subsampling of the Cb channel only, added to ChromaSubsamplingVert.' },
  ChromaSitingHorz: { title: 'Chroma Siting Horizontal', desc: 'Where chroma samples sit horizontally relative to the luma samples: 1 co-sited with the left one, 2 half-way.' },
  ChromaSitingVert: { title: 'Chroma Siting Vertical', desc: 'Where chroma samples sit vertically relative to the luma samples: 1 co-sited with the top one, 2 half-way.' },
  Range: { title: 'Colour Range', desc: 'The value range of the pixels: 1 broadcast (limited, 16–235 for 8-bit luma), 2 full (0–255), 3 defined by the matrix and transfer characteristics, 0 unspecified.' },
  TransferCharacteristics: { title: 'Transfer Characteristics', desc: 'The transfer function of the video (H.273 table 3): 1 BT.709 (SDR), 16 SMPTE ST 2084 (PQ, used by HDR10), 18 ARIB STD-B67 (HLG), 2 unspecified.' },
  Primaries: { title: 'Colour Primaries', desc: 'The colour primaries (H.273 table 2): 1 BT.709, 9 BT.2020 (the wide gamut used by HDR), 12 P3-D65 (Display P3), 2 unspecified.' },
  MaxCLL: { title: 'Max Content Light Level', show: 'nits', desc: 'Maximum Content Light Level: the brightest single pixel of the whole video, in cd/m² (nits). Part of the HDR10 static metadata.' },
  MaxFALL: { title: 'Max Frame-Average Light Level', show: 'nits', desc: 'Maximum Frame-Average Light Level: the brightest frame on average, in cd/m². Part of the HDR10 static metadata.' },
  MasteringMetadata: {
    title: 'Mastering Display Metadata',
    desc: 'The SMPTE ST 2086 description of the display the content was graded on: its primaries, white point and luminance range. Part of the HDR10 static metadata; TVs use it for tone mapping.',
  },
  PrimaryRChromaticityX: { title: 'Red Primary x', show: 'xy', desc: 'CIE 1931 x chromaticity of the mastering display\'s red primary.' },
  PrimaryRChromaticityY: { title: 'Red Primary y', show: 'xy', desc: 'CIE 1931 y chromaticity of the mastering display\'s red primary.' },
  PrimaryGChromaticityX: { title: 'Green Primary x', show: 'xy', desc: 'CIE 1931 x chromaticity of the mastering display\'s green primary.' },
  PrimaryGChromaticityY: { title: 'Green Primary y', show: 'xy', desc: 'CIE 1931 y chromaticity of the mastering display\'s green primary.' },
  PrimaryBChromaticityX: { title: 'Blue Primary x', show: 'xy', desc: 'CIE 1931 x chromaticity of the mastering display\'s blue primary.' },
  PrimaryBChromaticityY: { title: 'Blue Primary y', show: 'xy', desc: 'CIE 1931 y chromaticity of the mastering display\'s blue primary.' },
  WhitePointChromaticityX: { title: 'White Point x', show: 'xy', desc: 'CIE 1931 x chromaticity of the mastering display\'s white point (0.3127 for D65).' },
  WhitePointChromaticityY: { title: 'White Point y', show: 'xy', desc: 'CIE 1931 y chromaticity of the mastering display\'s white point (0.3290 for D65).' },
  LuminanceMax: { title: 'Maximum Luminance', show: 'nits', desc: 'Peak luminance of the mastering display in cd/m² (for example 1000).' },
  LuminanceMin: { title: 'Minimum Luminance', show: 'nits', desc: 'Minimum luminance of the mastering display in cd/m² (for example 0.005).' },
  Projection: {
    title: 'Projection',
    desc: 'How to render 360° or VR video (equirectangular, cubemap, mesh) and how to rotate the picture: with an ordinary rectangular projection, ProjectionPoseRoll rotates the video like a phone\'s orientation flag.',
  },
  ProjectionType: { title: 'Projection Type', desc: 'The projection: 0 rectangular (ordinary video), 1 equirectangular (360°), 2 cubemap, 3 mesh.' },
  ProjectionPrivate: { title: 'Projection Private', desc: 'Data specific to the projection, in the same format as the matching ISOBMFF box (equi, cbmp or mshp) of the Spherical Video V2 specification.' },
  ProjectionPoseYaw: { title: 'Projection Pose Yaw', show: 'deg', desc: 'Yaw rotation in degrees (clockwise around the up axis), applied first.' },
  ProjectionPosePitch: { title: 'Projection Pose Pitch', show: 'deg', desc: 'Pitch rotation in degrees (counter-clockwise around the right axis), applied after yaw.' },
  ProjectionPoseRoll: {
    title: 'Projection Pose Roll', show: 'deg',
    desc: 'Roll rotation in degrees (counter-clockwise around the forward axis). With a rectangular projection this simply rotates the picture for display: 90 means turn it 90° counter-clockwise.',
  },
  Audio: { title: 'Audio settings', cat: 'codec', desc: 'Audio properties of the track: sampling frequency, number of channels and bit depth.' },
  SamplingFrequency: {
    title: 'Sampling Frequency', show: 'hz',
    desc: 'The sampling rate in Hz (8000 when absent). For HE-AAC it is the core AAC rate; OutputSamplingFrequency then gives the rate after SBR.',
  },
  OutputSamplingFrequency: { title: 'Output Sampling Frequency', show: 'hz', desc: 'The real output sampling rate when it differs from SamplingFrequency, as with HE-AAC where SBR doubles the rate.' },
  Channels: { title: 'Channels', desc: 'The number of audio channels (1 when absent).' },
  ChannelPositions: { title: 'Channel Positions', desc: `Horizontal angles of the channels. ${HISTORIC}` },
  BitDepth: { title: 'Bit Depth', desc: 'Bits per sample; mostly meaningful for PCM.' },
  Emphasis: { title: 'Emphasis', desc: 'Pre-emphasis applied to the audio (for example CD emphasis), which players must undo. Added in Matroska v5, after RFC 9559.' },
  TrackOperation: {
    title: 'Track Operation',
    desc: 'Builds a virtual track out of other tracks: combining the left-eye and right-eye planes into a 3D track, or joining the blocks of several tracks.',
  },
  TrackCombinePlanes: { title: 'Track Combine Planes', desc: 'The video plane tracks to combine into this 3D track.' },
  TrackPlane: { title: 'Track Plane', desc: 'One video plane track to combine.' },
  TrackPlaneUID: { title: 'Track Plane UID', show: 'uid', desc: 'The TrackUID of the track holding this plane.' },
  TrackPlaneType: { title: 'Track Plane Type', desc: 'The kind of plane: 0 left eye, 1 right eye, 2 background.' },
  TrackJoinBlocks: { title: 'Track Join Blocks', desc: 'The tracks whose blocks are joined to make this virtual track.' },
  TrackJoinUID: { title: 'Track Join UID', show: 'uid', desc: 'The TrackUID of a track whose blocks are joined.' },
  TrickTrackUID: { title: 'Trick Track UID', show: 'uid', desc: `DivX trick-play (smooth fast forward/rewind) track. ${HISTORIC}` },
  TrickTrackSegmentUID: { title: 'Trick Track Segment UID', show: 'uuid', desc: `Segment of the DivX trick-play track. ${HISTORIC}` },
  TrickTrackFlag: { title: 'Trick Track Flag', desc: `Whether this is a DivX trick-play track. ${HISTORIC}` },
  TrickMasterTrackUID: { title: 'Trick Master Track UID', show: 'uid', desc: `The video track a DivX trick-play track belongs to. ${HISTORIC}` },
  TrickMasterTrackSegmentUID: { title: 'Trick Master Track Segment UID', show: 'uuid', desc: `Segment of the DivX master track. ${HISTORIC}` },
  ContentEncodings: {
    title: 'Content Encodings', cat: 'protect',
    desc: 'Transformations applied to the track\'s data that must be undone before decoding: compression (zlib or header stripping) or encryption.',
    more: 'Header stripping (ContentCompAlgo 3) removes bytes that are identical at the start of every frame, such as a sync word, and stores them once in ContentCompSettings; old mkvmerge versions used it by default for some codecs, and players without support for it cannot decode such tracks. Encryption is how WebM carries protected media for Encrypted Media Extensions (AES-CTR).',
  },
  ContentEncoding: { title: 'Content Encoding', cat: 'protect', desc: 'One transformation (compression or encryption) and its settings.' },
  ContentEncodingOrder: { title: 'Content Encoding Order', desc: 'The order in which several encodings are undone: the one with the highest order first.' },
  ContentEncodingScope: { title: 'Content Encoding Scope', show: 'scope', desc: 'What the encoding applies to, as bit flags: 1 the frames in blocks, 2 CodecPrivate, 4 the next ContentEncoding.' },
  ContentEncodingType: { title: 'Content Encoding Type', desc: 'The kind of transformation: 0 compression, 1 encryption.' },
  ContentCompression: { title: 'Content Compression', desc: 'The compression settings.' },
  ContentCompAlgo: { title: 'Compression Algorithm', desc: 'The compression algorithm: 0 zlib, 1 bzlib, 2 lzo1x, 3 header stripping.' },
  ContentCompSettings: { title: 'Compression Settings', desc: 'Settings for the decompressor. For header stripping: the bytes removed from the start of every frame, which a player must put back before decoding.' },
  ContentEncryption: { title: 'Content Encryption', desc: 'The encryption settings (algorithm, key ID). How keys are obtained is outside Matroska; WebM uses this for Encrypted Media Extensions.' },
  ContentEncAlgo: { title: 'Encryption Algorithm', desc: 'The encryption algorithm: 0 not encrypted, 1 DES, 2 3DES, 3 Twofish, 4 Blowfish, 5 AES. WebM encryption uses AES.' },
  ContentEncKeyID: { title: 'Encryption Key ID', desc: 'Identifier of the key the data was encrypted with: the key ID a player sends to the licence server.' },
  ContentEncAESSettings: { title: 'AES Settings', desc: 'Settings of the AES encryption.' },
  AESSettingsCipherMode: { title: 'AES Cipher Mode', desc: 'The AES mode: 1 AES-CTR (the WebM encryption scheme), 2 AES-CBC.' },
  ContentSignature: { title: 'Content Signature', desc: `A cryptographic signature of the contents. ${HISTORIC}` },
  ContentSigKeyID: { title: 'Signature Key ID', desc: `ID of the private key used to sign. ${HISTORIC}` },
  ContentSigAlgo: { title: 'Signature Algorithm', desc: `The signature algorithm. ${HISTORIC}` },
  ContentSigHashAlgo: { title: 'Signature Hash Algorithm', desc: `The hash algorithm of the signature. ${HISTORIC}` },

  // ------------------------------------------------------------ Cues
  Cues: {
    title: 'Cues (seek index)', cat: 'index',
    desc: 'The seek index: a list of cue points, each giving a time and the position of the Cluster (and optionally the block) holding a key frame at that time. Players use it to seek without reading through the file.',
    more: 'Muxers usually write the Cues after the last Cluster, when all positions are known, and list them in the SeekHead; WebM recommends putting them before the Clusters so a browser can seek over HTTP with a single request. Without Cues a player has to guess a byte position and scan for Clusters, which is slow and imprecise; the WebM guidelines even tell players to disable seeking in files without Cues.',
  },
  CuePoint: { title: 'Cue Point', desc: 'One seek point: a time, and where to find the matching key frame for one or more tracks.' },
  CueTime: { title: 'Cue Time', show: 'ticks', desc: 'The time of the seek point, in TimestampScale ticks.' },
  CueTrackPositions: { title: 'Cue Track Positions', desc: 'Where to find the frame at CueTime for one track.' },
  CueTrack: { title: 'Cue Track', show: 'track', desc: 'The track number this position is for.' },
  CueClusterPosition: { title: 'Cue Cluster Position', show: 'segpos', desc: 'Position of the Cluster that holds the frame, in bytes from the start of the Segment\'s data.' },
  CueRelativePosition: {
    title: 'Cue Relative Position', show: 'relpos',
    desc: 'Position of the SimpleBlock or BlockGroup inside that Cluster, in bytes from the start of the Cluster\'s data, so a player can jump straight to the block.',
  },
  CueDuration: { title: 'Cue Duration', show: 'ticks', desc: 'The duration of the referenced block in ticks; mainly used for subtitle cues.' },
  CueBlockNumber: { title: 'Cue Block Number', desc: 'Which block of the Cluster the cue refers to (1 = the first).' },
  CueCodecState: { title: 'Cue Codec State', show: 'segpos0', desc: 'Segment position of a CodecState needed to decode from this point; 0 means the track\'s CodecPrivate is enough.' },
  CueReference: { title: 'Cue Reference', desc: 'Other blocks this seek point depends on.' },
  CueRefTime: { title: 'Cue Reference Time', show: 'ticks', desc: 'Timestamp of a block this seek point depends on, in ticks.' },
  CueRefCluster: { title: 'Cue Reference Cluster', show: 'segpos', desc: `Cluster of a referenced block. ${HISTORIC}` },
  CueRefNumber: { title: 'Cue Reference Number', desc: `Number of a referenced block in its Cluster. ${HISTORIC}` },
  CueRefCodecState: { title: 'Cue Reference Codec State', show: 'segpos0', desc: `Codec state of a referenced block. ${HISTORIC}` },

  // ------------------------------------------------------------ Attachments
  Attachments: {
    title: 'Attachments', cat: 'meta',
    desc: 'Files stored inside the Matroska file, typically fonts needed by ASS/SSA subtitles and cover art.',
    more: 'Fonts are attached so that styled subtitles render the same everywhere. Cover art named cover.jpg or cover.png (and small_cover, cover_land variants) is shown by some players and file managers. Players must never execute attachments.',
  },
  AttachedFile: { title: 'Attached File', desc: 'One attached file: its name, media type, description, unique ID and data.' },
  FileDescription: { title: 'File Description', desc: 'A human-friendly description of the attached file.' },
  FileName: { title: 'File Name', desc: 'The file name of the attachment, such as "cover.jpg" or "arial.ttf".' },
  FileMediaType: { title: 'File Media Type', desc: 'The media (MIME) type of the attachment, such as image/jpeg or font/ttf.' },
  FileData: { title: 'File Data', desc: 'The bytes of the attached file.' },
  FileUID: { title: 'File UID', show: 'uid', desc: 'A random identifier of the attachment, used by Tags and by a track\'s AttachmentLink.' },
  FileReferral: { title: 'File Referral', desc: `A value tracks could use to refer to the attachment. ${HISTORIC}` },
  FileUsedStartTime: { title: 'File Used Start Time', show: 'ticks', desc: `When a DivX font attachment comes into use. ${HISTORIC}` },
  FileUsedEndTime: { title: 'File Used End Time', show: 'ticks', desc: `When a DivX font attachment stops being used. ${HISTORIC}` },

  // ------------------------------------------------------------ Chapters
  Chapters: {
    title: 'Chapters', cat: 'meta',
    desc: 'Chapter markers and menus: one or more editions, each a list of chapters with start and end times and titles, possibly in several languages.',
    more: 'Ordered chapters (EditionFlagOrdered) go further: they define the playback order and can pull in parts of other, linked files, for example to share an opening sequence between episodes.',
  },
  EditionEntry: { title: 'Edition', desc: 'One edition: a complete set of chapters. A file can offer several, such as a theatrical cut and a director\'s cut.' },
  EditionUID: { title: 'Edition UID', show: 'uid', desc: 'A random identifier of the edition, used by Tags.' },
  EditionFlagHidden: { title: 'Edition Hidden flag', desc: 'Whether the edition is hidden from the user interface. Defined in the Matroska schema but not in RFC 9559.' },
  EditionFlagDefault: { title: 'Edition Default flag', desc: 'Whether this edition is the one to use by default.' },
  EditionFlagOrdered: { title: 'Edition Ordered flag', desc: 'Whether the chapters define the playback order (ordered chapters): only the listed time ranges are played, in the listed order.' },
  EditionDisplay: { title: 'Edition Display', desc: 'A name for the edition in some languages. Added in Matroska v5, after RFC 9559.' },
  EditionString: { title: 'Edition String', desc: 'The name of the edition.' },
  EditionLanguageIETF: { title: 'Edition Language', show: 'lang', desc: 'A language of the edition name, as a BCP 47 tag.' },
  ChapterAtom: { title: 'Chapter', desc: 'One chapter: its start and end times, titles and flags. Chapters can be nested to make sub-chapters.' },
  ChapterUID: { title: 'Chapter UID', show: 'uid', desc: 'A random identifier of the chapter, used by Tags.' },
  ChapterStringUID: { title: 'Chapter String UID', desc: 'A string identifier of the chapter, for example a WebVTT cue identifier.' },
  ChapterTimeStart: { title: 'Chapter Start', show: 'nstime', desc: 'Start time of the chapter, in nanoseconds (not scaled by TimestampScale).' },
  ChapterTimeEnd: { title: 'Chapter End', show: 'nstime', desc: 'End time of the chapter in nanoseconds; the end time itself is not part of the chapter.' },
  ChapterFlagHidden: { title: 'Chapter Hidden flag', desc: 'Whether the chapter is hidden from the user interface.' },
  ChapterFlagEnabled: { title: 'Chapter Enabled flag', desc: 'Whether the chapter is enabled; a disabled chapter is skipped during playback. Defined in the Matroska schema but not in RFC 9559.' },
  ChapterSegmentUUID: { title: 'Chapter Segment UUID', show: 'uuid', desc: 'The SegmentUUID of another Segment (file) to play during this chapter (medium linking).' },
  ChapterSkipType: { title: 'Chapter Skip Type', desc: 'What kind of content the chapter is (opening credits, recap, preview, advertisement...), so players can offer to skip it. Added in Matroska v5, after RFC 9559.' },
  ChapterSegmentEditionUID: { title: 'Chapter Segment Edition UID', show: 'uid', desc: 'Which edition of the linked Segment to play.' },
  ChapterPhysicalEquiv: {
    title: 'Chapter Physical Equivalent', show: 'physical',
    desc: 'The physical level this chapter corresponds to when a file mirrors a disc: 70 set, 60 medium (CD, DVD), 50 side, 40 layer, 30 session, 20 track, 10 index.',
  },
  ChapterTrack: { title: 'Chapter Tracks', desc: 'The tracks the chapter applies to; without it, the chapter applies to all tracks. Defined in the Matroska schema but not in RFC 9559.' },
  ChapterTrackUID: { title: 'Chapter Track UID', show: 'uid', desc: 'The UID of a track this chapter applies to.' },
  ChapterDisplay: { title: 'Chapter Display', desc: 'The chapter title in one language.' },
  ChapString: { title: 'Chapter Title', desc: 'The chapter title shown to the user.' },
  ChapLanguage: { title: 'Chapter Language', show: 'lang', desc: 'Language of the chapter title (ISO 639-2, "eng" when absent). Ignored when ChapLanguageBCP47 is present.' },
  ChapLanguageBCP47: { title: 'Chapter Language (BCP 47)', show: 'lang', desc: 'Language of the chapter title as a BCP 47 tag; takes precedence over ChapLanguage.' },
  ChapCountry: { title: 'Chapter Country', desc: 'A country for the chapter title, as a two-letter region code.' },
  ChapProcess: { title: 'Chapter Process', desc: 'Commands to run when the chapter plays (Matroska Script or DVD menu commands).' },
  ChapProcessCodecID: { title: 'Chapter Process Codec', desc: 'The chapter codec: 0 Matroska Script, 1 DVD menu.' },
  ChapProcessPrivate: { title: 'Chapter Process Private', desc: 'Data for the chapter codec (for DVD menus, the DVD level information).' },
  ChapProcessCommand: { title: 'Chapter Process Command', desc: 'One command and when to run it.' },
  ChapProcessTime: { title: 'Chapter Process Time', desc: 'When to run the command: 0 during the whole chapter, 1 before the chapter plays, 2 after it.' },
  ChapProcessData: { title: 'Chapter Process Data', desc: 'The command itself, for example binary DVD cell commands.' },

  // ------------------------------------------------------------ Tags
  Tags: {
    title: 'Tags', cat: 'meta',
    desc: 'Metadata tags (title, artist, encoder, languages, statistics...), each applying to the whole file or to specific tracks, editions, chapters or attachments.',
    more: 'Tag names are conventions (TITLE, ARTIST, ENCODER, DURATION, COMMENT...) rather than a closed list. Matroska has no per-track duration element, so FFmpeg stores the length of each track in a DURATION tag; mkvmerge writes statistics tags such as BPS, DURATION, NUMBER_OF_FRAMES and NUMBER_OF_BYTES.',
  },
  Tag: { title: 'Tag', desc: 'One group of tags and the target it applies to.' },
  Targets: {
    title: 'Targets',
    desc: 'What the tags apply to: a level (TargetTypeValue, e.g. 50 for a movie or album) and optionally specific tracks, editions, chapters or attachments by UID. When empty, the tags describe the whole Segment.',
  },
  TargetTypeValue: {
    title: 'Target Type Value',
    desc: 'The logical level of the target: 70 collection, 60 season/volume, 50 movie/album/episode (the default), 40 part, 30 track/song/chapter, 20 scene/movement, 10 shot.',
  },
  TargetType: { title: 'Target Type', desc: 'An informative name for the level, such as "MOVIE", "ALBUM" or "CHAPTER".' },
  TagTrackUID: { title: 'Tag Track UID', show: 'taguid', desc: 'The TrackUID of a track the tags apply to (0 means all tracks).' },
  TagEditionUID: { title: 'Tag Edition UID', show: 'uid', desc: 'The EditionUID of an edition the tags apply to.' },
  TagChapterUID: { title: 'Tag Chapter UID', show: 'uid', desc: 'The ChapterUID of a chapter the tags apply to.' },
  TagAttachmentUID: { title: 'Tag Attachment UID', show: 'uid', desc: 'The FileUID of an attachment the tags apply to.' },
  TagBlockAddIDValue: { title: 'Tag Block Add ID Value', desc: 'The BlockAddIDValue of the Block Addition Mapping the tags apply to. Added in Matroska v5, after RFC 9559.' },
  SimpleTag: { title: 'Simple Tag', desc: 'One tag: a name (TagName) and a value (TagString or TagBinary) in a language. Simple tags can be nested to add detail, such as a TITLE with its SORT_WITH.' },
  TagName: { title: 'Tag Name', desc: 'The name of the tag, by convention in capitals: TITLE, ARTIST, ENCODER, DURATION, COMMENT...' },
  TagLanguage: { title: 'Tag Language', show: 'lang', desc: 'The language of the tag value (ISO 639-2, "und" when absent). Ignored when TagLanguageBCP47 is present.' },
  TagLanguageBCP47: { title: 'Tag Language (BCP 47)', show: 'lang', desc: 'The language of the tag value as a BCP 47 tag; takes precedence over TagLanguage.' },
  TagDefault: { title: 'Tag Default flag', desc: 'Whether this is the default (original-language) version of the tag.' },
  TagDefaultBogus: { title: 'Tag Default (bogus ID)', desc: `A variant of TagDefault with a wrong ID, written by some old muxers. ${HISTORIC}` },
  TagString: { title: 'Tag String', desc: 'The tag value as text.' },
  TagBinary: { title: 'Tag Binary', desc: 'The tag value as binary data (for example a picture or a checksum).' },
};

// Colour family of each subtree (an element takes the category of the closest ancestor listed here).
const SUBTREE_CAT = {
  EBML: 'type', SeekHead: 'index', Info: 'header', Cluster: 'fragment', BlockGroup: 'fragment', Block: 'media',
  BlockAdditions: 'media', Tracks: 'track', Video: 'codec', Audio: 'codec', ContentEncodings: 'protect', Cues: 'index',
  Attachments: 'meta', Chapters: 'meta', Tags: 'meta', TrackOperation: 'track',
};

// ------------------------------------------------------------------ build the tables

export const BY_ID = new Map();
export const BY_NAME = new Map();

function camelTitle(name) {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
}

for (const row of ROWS) {
  const [name, id, t, parent, flags, sec, def, range, extra] = row;
  const d = D[name] ?? {};
  const el = {
    name,
    id,
    type: t,
    typeName: TYPE_NAMES[t],
    parent,
    mandatory: flags.includes('m'),
    once: flags.includes('1'),
    webm: flags.includes('w'),
    unknownSizeAllowed: flags.includes('u'),
    recursive: flags.includes('r'),
    historic: flags.includes('x'),
    v5: flags.includes('5'),
    notInRfc: flags.includes('n'),
    section: sec || null,
    rfc: /^11\./.test(sec) ? 8794 : sec ? 9559 : null,
    default: def,
    range: range ?? null,
    minver: extra?.minver ?? null,
    maxver: extra?.maxver ?? null,
    length: extra?.length ?? null,
    enum: ENUMS[name] ?? null,
    title: d.title ?? camelTitle(name),
    desc: d.desc ?? null,
    more: d.more ?? null,
    show: d.show ?? null,
    cat: d.cat ?? null,
    global: parent === '*',
  };
  BY_ID.set(id, el);
  BY_NAME.set(name, el);
}

// Categories: inherited from the parent chain.
for (const el of BY_NAME.values()) {
  if (el.cat) continue;
  let p = el.parent;
  let cat = null;
  for (let guard = 0; p && guard < 12; guard++) {
    if (SUBTREE_CAT[p]) {
      cat = SUBTREE_CAT[p];
      break;
    }
    p = BY_NAME.get(p)?.parent;
  }
  el.cat = cat ?? SUBTREE_CAT[el.name] ?? 'unknown';
}

/** EBML path of an element, e.g. \Segment\Info\TimestampScale. */
export function elementPath(el) {
  if (el.global) return `\\(any parent)\\${el.name}`;
  const parts = [];
  for (let e = el, guard = 0; e && guard < 16; guard++) {
    parts.unshift(e.recursive ? `+${e.name}` : e.name);
    e = e.parent ? BY_NAME.get(e.parent) : null;
  }
  return `\\${parts.join('\\')}`;
}

/** True when `child` may appear directly inside `parent` (global elements and recursion included). */
export function isChildOf(child, parent) {
  if (!child) return true; // unknown IDs do not end an unknown-size element
  if (child.global) return true;
  if (!parent) return !child.parent;
  if (child.parent === parent.name) return true;
  return child.recursive && child.name === parent.name;
}

/** True when an element with this definition may be inside `parent` somewhere (for unknown-size ends). */
export function isDescendantOf(child, parent) {
  if (!child || child.global) return true;
  for (let p = child.parent, guard = 0; p && guard < 16; guard++) {
    if (p === parent.name) return true;
    p = BY_NAME.get(p)?.parent;
  }
  return false;
}

function occurrence(el) {
  const parts = [];
  parts.push(el.mandatory ? 'mandatory' : 'optional');
  if (el.once) parts.push('at most once');
  else if (!el.global) parts.push('may repeat');
  return parts.join(', ');
}

function syntaxOf(el) {
  const lines = [];
  lines.push(`${el.name}  ID ${hexId(el.id)}  ${TYPE_LABEL[el.type]}`);
  lines.push(`path     ${elementPath(el)}`);
  lines.push(`occurs   ${occurrence(el)}${el.recursive ? ', recursive (may contain itself)' : ''}`);
  if (el.default !== undefined) lines.push(`default  ${el.default}`);
  if (el.range) lines.push(`range    ${el.range}`);
  if (el.length) lines.push(`length   ${el.length} bytes`);
  if (el.minver || el.maxver !== null) {
    lines.push(`versions ${el.minver ? `from Matroska v${el.minver}` : ''}${el.minver && el.maxver !== null ? ', ' : ''}${el.maxver !== null ? (el.maxver === 0 ? 'never part of a Matroska version' : `up to Matroska v${el.maxver}`) : ''}`);
  }
  if (el.enum) lines.push(`values   ${Object.entries(el.enum).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
  if (el.rfc === 9559 || el.v5 || el.notInRfc) lines.push(`WebM     ${el.webm ? 'yes' : 'not part of WebM'}`);
  if (el.type === 'm' && el.unknownSizeAllowed) lines.push('unknown size allowed (live streams)');
  return lines.join('\n');
}

const defCache = new Map();

/** The inspector description of an element (shared by all its nodes). */
export function nodeDef(el) {
  if (!el) return UNKNOWN_DEF;
  let d = defCache.get(el.name);
  if (d) return d;
  const desc = el.desc ?? `The ${el.name} element.`;
  d = {
    name: el.title,
    cat: el.cat,
    desc,
    more: el.more ?? undefined,
    specTitle: el.rfc === 8794 ? 'RFC 8794 (EBML)' : el.rfc === 9559 ? 'RFC 9559 (Matroska)' : el.v5 ? 'Matroska schema (v5, after RFC 9559)' : 'Matroska schema (not in RFC 9559)',
    section: el.section ?? undefined,
    specHref: el.rfc === 8794
      ? `${RFC8794}#section-${el.section}`
      : el.rfc === 9559
        ? `${RFC9559}#${el.section.startsWith('A.') ? 'appendix' : 'section'}-${el.section}`
        : REGISTRY_URL,
    links: [{ label: 'registry', url: REGISTRY_URL, title: `matroska.org: ${el.name} (${hexId(el.id)})` }],
    syntax: syntaxOf(el),
    id: el.name,
    ebmlId: hexId(el.id),
    ebmlType: el.typeName,
  };
  if (el.webm && el.rfc === 9559) d.links.push({ label: 'WebM', url: WEBM_URL, title: 'WebM container guidelines' });
  defCache.set(el.name, d);
  return d;
}

export const UNKNOWN_DEF = {
  name: 'Unknown element',
  cat: 'unknown',
  desc: 'An element whose ID is not in the Matroska specification. Readers skip unknown elements using their size, which is what makes EBML formats extensible.',
  more: 'It may be a private extension of the program that wrote the file, an element from a newer specification, or damaged data that happens to look like an element header.',
  specTitle: 'RFC 8794 (EBML)',
  section: '11.1',
  specHref: `${RFC8794}#section-11.1`,
  links: [{ label: 'registry', url: REGISTRY_URL, title: 'matroska.org element list' }],
};

export const GARBAGE_DEF = {
  name: 'Unparsed bytes',
  cat: 'unknown',
  desc: 'Bytes that do not form a valid element here, so Vidscope could not read them as EBML.',
  more: 'This happens in damaged or truncated files, or when an element declares a wrong size. Players usually skip ahead looking for the next Cluster ID (1F 43 B6 75) to resynchronise.',
};

/** Four-letter code of a 32-bit number, or null when not printable. */
export function fourccOf(v) {
  if (!Number.isInteger(v) || v < 0x20202020 || v > 0x7e7e7e7e) return null;
  let s = '';
  for (let k = 3; k >= 0; k--) {
    const c = Math.floor(v / 256 ** k) % 256;
    if (c < 0x20 || c > 0x7e) return null;
    s += String.fromCharCode(c);
  }
  return s;
}

export const BLOCK_ADD_ID_TYPES = {
  0: 'use BlockAddIDValue', 1: 'opaque data', 4: 'ITU-T T.35 metadata (e.g. HDR10+)', 121: 'SMPTE ST 12-1 timecode',
  0x61766345: 'Dolby Vision enhancement-layer AVC configuration (avcE)', 0x68766345: 'Dolby Vision enhancement-layer HEVC configuration (hvcE)',
  0x64766343: 'Dolby Vision configuration (dvcC)', 0x64767643: 'Dolby Vision configuration (dvvC)', 0x64767743: 'Dolby Vision configuration (dvwC)',
  0x6d766343: 'MVC configuration (mvcC)',
};

export const PHYSICAL_EQUIV = { 70: 'set / package', 60: 'medium (CD, DVD, tape...)', 50: 'side', 40: 'layer', 30: 'session', 20: 'track', 10: 'index' };
