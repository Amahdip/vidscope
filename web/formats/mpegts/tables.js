// Code tables for MPEG transport streams: PIDs, stream types, PES stream IDs,
// table IDs and descriptor tags. Sources: ISO/IEC 13818-1 (ITU-T H.222.0),
// ETSI EN 300 468 (DVB SI), ATSC A/52 and A/65, ANSI/SCTE 35, and the de-facto
// Blu-ray (HDMV) assignments that FFmpeg and other demuxers follow.

import { HEX2 } from '../../core/util.js';

export const SYNC_BYTE = 0x47;
export const TS_SIZE = 188;
export const NULL_PID = 0x1fff;
export const PTS_HZ = 90000;
export const PCR_HZ = 27000000;
export const WRAP_33 = 2 ** 33;

export const H222 = {
  specTitle: 'ISO/IEC 13818-1 (MPEG-2 Systems) / ITU-T H.222.0',
  specHref: 'https://www.itu.int/rec/T-REC-H.222.0',
};
export const EN300468 = {
  specTitle: 'ETSI EN 300 468 (DVB Service Information)',
  specHref: 'https://www.etsi.org/deliver/etsi_en/300400_300499/300468/',
};
export const TR101290_LINK = {
  label: 'TR 101 290',
  url: 'https://www.etsi.org/deliver/etsi_tr/101200_101299/101290/',
  title: 'ETSI TR 101 290: measurement guidelines for DVB systems (the standard list of transport stream checks)',
};
export const H222_LINK = { label: 'H.222.0', url: 'https://www.itu.int/rec/T-REC-H.222.0', title: 'ITU-T H.222.0 | ISO/IEC 13818-1 (MPEG-2 Systems)' };
export const EN300468_LINK = { label: 'EN 300 468', url: 'https://www.etsi.org/deliver/etsi_en/300400_300499/300468/', title: 'ETSI EN 300 468: DVB Service Information' };
export const SCTE35_LINK = { label: 'SCTE-35', url: 'https://en.wikipedia.org/wiki/SCTE-35', title: 'ANSI/SCTE 35: Digital Program Insertion Cueing Message' };
export const M2TS_LINK = { label: 'M2TS', url: 'https://en.wikipedia.org/wiki/.m2ts', title: 'BDAV MPEG-2 transport stream (.m2ts, .mts)' };

export const hex2 = (v) => `0x${HEX2[v & 0xff]}`;
/** Display of fixed or reserved bit fields as binary digits. */
export const bin = (n) => (v) => `'${v.toString(2).padStart(n, '0')}'`;
export const hexPid = (pid) => `0x${pid.toString(16).toUpperCase().padStart(4, '0')}`;

// ------------------------------------------------------------------ PIDs

/** PIDs with a fixed meaning (ISO/IEC 13818-1 Table 2-3, EN 300 468 Table 1, ATSC A/65). */
export const FIXED_PIDS = {
  0x0000: { short: 'PAT', name: 'Program Association Table', psi: true },
  0x0001: { short: 'CAT', name: 'Conditional Access Table', psi: true },
  0x0002: { short: 'TSDT', name: 'Transport Stream Description Table', psi: true },
  0x0003: { short: 'IPMP', name: 'IPMP Control Information Table', psi: true },
  0x0010: { short: 'NIT', name: 'DVB Network Information Table (NIT, ST)', psi: true, dvb: true },
  0x0011: { short: 'SDT', name: 'DVB Service Description / Bouquet Association Table (SDT, BAT, ST)', psi: true, dvb: true },
  0x0012: { short: 'EIT', name: 'DVB Event Information Table (EIT, ST, CIT)', psi: true, dvb: true },
  0x0013: { short: 'RST', name: 'DVB Running Status Table (RST, ST)', psi: true, dvb: true },
  0x0014: { short: 'TDT', name: 'DVB Time and Date / Time Offset Table (TDT, TOT, ST)', psi: true, dvb: true },
  0x0015: { short: 'NetSync', name: 'DVB network synchronization', dvb: true },
  0x0016: { short: 'RNT', name: 'DVB Resolution provider Notification Table', psi: true, dvb: true },
  0x001c: { short: 'inband', name: 'DVB inband signalling', dvb: true },
  0x001d: { short: 'measure', name: 'DVB measurement', dvb: true },
  0x001e: { short: 'DIT', name: 'DVB Discontinuity Information Table', psi: true, dvb: true },
  0x001f: { short: 'SIT', name: 'DVB Selection Information Table', psi: true, dvb: true },
  0x1ffb: { short: 'PSIP', name: 'ATSC PSIP base PID (MGT, VCT, RRT, STT)', psi: true },
  0x1fff: { short: 'null', name: 'Null packets (stuffing)' },
};

export function fixedPidName(pid) {
  const f = FIXED_PIDS[pid];
  if (f) return f.name;
  if (pid >= 0x0004 && pid <= 0x000f) return 'reserved by ISO/IEC 13818-1';
  if (pid >= 0x0017 && pid <= 0x001b) return 'reserved by DVB for future SI';
  return null;
}

// ------------------------------------------------------------------ stream types

/**
 * stream_type in the PMT (ISO/IEC 13818-1 Table 2-34 for 0x00–0x7F; 0x80+ are
 * user private and depend on the system: ATSC/SCTE, Blu-ray (HDMV) or HLS).
 * { name, codec, kind, family? } — codec is a short ffprobe-style codec name.
 */
export const STREAM_TYPES = {
  0x01: { name: 'MPEG-1 video (ISO/IEC 11172-2)', codec: 'mpeg1video', kind: 'video', family: 'mpeg2v' },
  0x02: { name: 'MPEG-2 video (ITU-T H.262 | ISO/IEC 13818-2)', codec: 'mpeg2video', kind: 'video', family: 'mpeg2v' },
  0x03: { name: 'MPEG-1 audio (ISO/IEC 11172-3)', codec: 'mp2', kind: 'audio', family: 'mpa' },
  0x04: { name: 'MPEG-2 audio (ISO/IEC 13818-3)', codec: 'mp2', kind: 'audio', family: 'mpa' },
  0x05: { name: 'private sections (ISO/IEC 13818-1)', codec: 'private_sections', kind: 'data', sections: true },
  0x06: { name: 'PES packets with private data', codec: 'private', kind: 'data' },
  0x07: { name: 'MHEG (ISO/IEC 13522)', codec: 'mheg', kind: 'data' },
  0x08: { name: 'DSM-CC (ISO/IEC 13818-1 Annex A)', codec: 'dsmcc', kind: 'data' },
  0x09: { name: 'ITU-T H.222.1', codec: 'h222_1', kind: 'data' },
  0x0a: { name: 'DSM-CC type A: multi-protocol encapsulation (ISO/IEC 13818-6)', codec: 'dsmcc_a', kind: 'data', sections: true },
  0x0b: { name: 'DSM-CC type B: U-N messages / data carousel (ISO/IEC 13818-6)', codec: 'dsmcc_b', kind: 'data', sections: true },
  0x0c: { name: 'DSM-CC type C: stream descriptors (ISO/IEC 13818-6)', codec: 'dsmcc_c', kind: 'data', sections: true },
  0x0d: { name: 'DSM-CC type D: sections (ISO/IEC 13818-6)', codec: 'dsmcc_d', kind: 'data', sections: true },
  0x0e: { name: 'auxiliary data (ISO/IEC 13818-1)', codec: 'auxiliary', kind: 'data' },
  0x0f: { name: 'AAC audio with ADTS transport syntax (ISO/IEC 13818-7)', codec: 'aac', kind: 'audio', family: 'adts' },
  0x10: { name: 'MPEG-4 Visual (ISO/IEC 14496-2)', codec: 'mpeg4', kind: 'video', family: 'mpeg4v' },
  0x11: { name: 'MPEG-4 audio with LATM/LOAS transport syntax (ISO/IEC 14496-3)', codec: 'aac_latm', kind: 'audio', family: 'latm' },
  0x12: { name: 'MPEG-4 SL-packetized or FlexMux stream in PES packets', codec: 'mpeg4_sl', kind: 'data' },
  0x13: { name: 'MPEG-4 SL-packetized or FlexMux stream in sections', codec: 'mpeg4_sl', kind: 'data', sections: true },
  0x14: { name: 'DSM-CC synchronized download protocol', codec: 'dsmcc_sdp', kind: 'data' },
  0x15: { name: 'metadata in PES packets', codec: 'metadata', kind: 'data' },
  0x16: { name: 'metadata in metadata_sections', codec: 'metadata', kind: 'data', sections: true },
  0x17: { name: 'metadata in a DSM-CC data carousel', codec: 'metadata', kind: 'data', sections: true },
  0x18: { name: 'metadata in a DSM-CC object carousel', codec: 'metadata', kind: 'data', sections: true },
  0x19: { name: 'metadata in the DSM-CC synchronized download protocol', codec: 'metadata', kind: 'data' },
  0x1a: { name: 'MPEG-2 IPMP stream', codec: 'ipmp', kind: 'data' },
  0x1b: { name: 'H.264 / AVC video (ITU-T H.264 | ISO/IEC 14496-10)', codec: 'h264', kind: 'video', family: 'avc' },
  0x1c: { name: 'MPEG-4 audio without extra transport syntax (DST, ALS, SLS)', codec: 'mpeg4audio', kind: 'audio' },
  0x1d: { name: 'MPEG-4 text (ISO/IEC 14496-17)', codec: 'mov_text', kind: 'subtitle' },
  0x1e: { name: 'auxiliary video stream (ISO/IEC 23002-3)', codec: 'aux_video', kind: 'video' },
  0x1f: { name: 'SVC video sub-bitstream of an AVC stream', codec: 'h264_svc', kind: 'video' },
  0x20: { name: 'MVC video sub-bitstream of an AVC stream', codec: 'h264_mvc', kind: 'video' },
  0x21: { name: 'JPEG 2000 video (ITU-T T.800 | ISO/IEC 15444-1)', codec: 'jpeg2000', kind: 'video' },
  0x22: { name: 'additional view MPEG-2 video (stereoscopic 3D)', codec: 'mpeg2video', kind: 'video', family: 'mpeg2v' },
  0x23: { name: 'additional view H.264 video (stereoscopic 3D)', codec: 'h264', kind: 'video', family: 'avc' },
  0x24: { name: 'H.265 / HEVC video (ITU-T H.265 | ISO/IEC 23008-2)', codec: 'hevc', kind: 'video', family: 'hevc' },
  0x25: { name: 'HEVC temporal video subset', codec: 'hevc', kind: 'video', family: 'hevc' },
  0x26: { name: 'MVCD video sub-bitstream of an AVC stream', codec: 'h264_mvcd', kind: 'video' },
  0x27: { name: 'timeline and external media information (TEMI)', codec: 'temi', kind: 'data' },
  0x28: { name: 'HEVC enhancement sub-partition (H.265 Annex G)', codec: 'hevc', kind: 'video' },
  0x29: { name: 'HEVC temporal enhancement sub-partition (H.265 Annex G)', codec: 'hevc', kind: 'video' },
  0x2a: { name: 'HEVC enhancement sub-partition (H.265 Annex H)', codec: 'hevc', kind: 'video' },
  0x2b: { name: 'HEVC temporal enhancement sub-partition (H.265 Annex H)', codec: 'hevc', kind: 'video' },
  0x2c: { name: 'green access units in sections', codec: 'green', kind: 'data', sections: true },
  0x2d: { name: 'MPEG-H 3D Audio, MHAS main stream (ISO/IEC 23008-3)', codec: 'mpegh_3d_audio', kind: 'audio' },
  0x2e: { name: 'MPEG-H 3D Audio, MHAS auxiliary stream', codec: 'mpegh_3d_audio', kind: 'audio' },
  0x2f: { name: 'quality access units in sections', codec: 'quality', kind: 'data', sections: true },
  0x30: { name: 'media orchestration access units in sections', codec: 'media_orchestration', kind: 'data', sections: true },
  0x31: { name: 'HEVC motion-constrained tile set substream', codec: 'hevc', kind: 'video' },
  0x32: { name: 'JPEG XS video (ISO/IEC 21122-2)', codec: 'jpegxs', kind: 'video' },
  0x33: { name: 'H.266 / VVC video (ITU-T H.266 | ISO/IEC 23090-3)', codec: 'vvc', kind: 'video' },
  0x34: { name: 'VVC temporal video subset', codec: 'vvc', kind: 'video' },
  0x35: { name: 'MPEG-5 EVC video (ISO/IEC 23094-1)', codec: 'evc', kind: 'video' },
  0x7f: { name: 'IPMP stream', codec: 'ipmp', kind: 'data' },
};

/** User-private stream types as used by ATSC / SCTE (the default for 0x80+). */
const ATSC_TYPES = {
  0x80: { name: 'DigiCipher II video (user private)', codec: 'mpeg2video', kind: 'video', family: 'mpeg2v' },
  0x81: { name: 'AC-3 audio (ATSC A/52)', codec: 'ac3', kind: 'audio', family: 'ac3' },
  0x82: { name: 'SCTE 27 subtitles (user private)', codec: 'scte27', kind: 'subtitle' },
  0x86: { name: 'SCTE-35 splice information (ad insertion cues)', codec: 'scte_35', kind: 'data', sections: true },
  0x87: { name: 'E-AC-3 audio (ATSC A/52)', codec: 'eac3', kind: 'audio', family: 'eac3' },
  0x8a: { name: 'DTS audio (user private)', codec: 'dts', kind: 'audio' },
  0xc1: { name: 'AC-3 audio with HLS SAMPLE-AES encryption', codec: 'ac3', kind: 'audio', encrypted: true },
  0xc2: { name: 'E-AC-3 audio with HLS SAMPLE-AES encryption', codec: 'eac3', kind: 'audio', encrypted: true },
  0xcf: { name: 'AAC (ADTS) audio with HLS SAMPLE-AES encryption', codec: 'aac', kind: 'audio', encrypted: true },
  0xd1: { name: 'Dirac video (user private)', codec: 'dirac', kind: 'video' },
  0xd2: { name: 'AVS2 video (user private)', codec: 'avs2', kind: 'video' },
  0xd4: { name: 'AVS3 video (user private)', codec: 'avs3', kind: 'video' },
  0xdb: { name: 'H.264 video with HLS SAMPLE-AES encryption', codec: 'h264', kind: 'video', encrypted: true },
  0xea: { name: 'VC-1 video (SMPTE 421M, user private)', codec: 'vc1', kind: 'video' },
};

/** Blu-ray (HDMV) assignments, used when the PMT carries registration 'HDMV' or the file is M2TS. */
const HDMV_TYPES = {
  0x80: { name: 'Blu-ray LPCM audio', codec: 'pcm_bluray', kind: 'audio' },
  0x81: { name: 'Blu-ray AC-3 (Dolby Digital) audio', codec: 'ac3', kind: 'audio', family: 'ac3' },
  0x82: { name: 'Blu-ray DTS audio', codec: 'dts', kind: 'audio' },
  0x83: { name: 'Blu-ray Dolby TrueHD audio', codec: 'truehd', kind: 'audio' },
  0x84: { name: 'Blu-ray E-AC-3 (Dolby Digital Plus) audio', codec: 'eac3', kind: 'audio', family: 'eac3' },
  0x85: { name: 'Blu-ray DTS-HD High Resolution audio', codec: 'dts', kind: 'audio' },
  0x86: { name: 'Blu-ray DTS-HD Master Audio', codec: 'dts', kind: 'audio' },
  0x90: { name: 'Blu-ray PGS (presentation graphics) subtitles', codec: 'hdmv_pgs_subtitle', kind: 'subtitle' },
  0x91: { name: 'Blu-ray IG (interactive graphics) menus', codec: 'hdmv_ig', kind: 'data' },
  0x92: { name: 'Blu-ray text subtitles', codec: 'hdmv_text_subtitle', kind: 'subtitle' },
  0xa1: { name: 'Blu-ray secondary E-AC-3 audio', codec: 'eac3', kind: 'audio', family: 'eac3' },
  0xa2: { name: 'Blu-ray secondary DTS-HD audio', codec: 'dts', kind: 'audio' },
  0xea: { name: 'Blu-ray VC-1 video', codec: 'vc1', kind: 'video' },
};

/** Look up a stream_type; `hdmv` selects the Blu-ray meaning of 0x80+. */
export function streamTypeInfo(type, hdmv = false) {
  if (type < 0x80) {
    if (STREAM_TYPES[type]) return STREAM_TYPES[type];
    if (type === 0) return { name: 'reserved (0x00)', codec: 'unknown', kind: 'data' };
    return { name: `reserved by ISO/IEC 13818-1 (${hex2(type)})`, codec: 'unknown', kind: 'data' };
  }
  const t = (hdmv ? HDMV_TYPES[type] : null) ?? ATSC_TYPES[type];
  if (t) return t;
  return { name: `user private (${hex2(type)})`, codec: 'unknown', kind: 'data' };
}

/** Codec identified from a registration descriptor's format_identifier. */
export const REGISTRATION_CODECS = {
  'AC-3': { codec: 'ac3', kind: 'audio', family: 'ac3', name: 'AC-3 (Dolby Digital)' },
  EAC3: { codec: 'eac3', kind: 'audio', family: 'eac3', name: 'E-AC-3 (Dolby Digital Plus)' },
  'AC-4': { codec: 'ac4', kind: 'audio', name: 'AC-4' },
  DTS1: { codec: 'dts', kind: 'audio', name: 'DTS (512-sample frames)' },
  DTS2: { codec: 'dts', kind: 'audio', name: 'DTS (1024-sample frames)' },
  DTS3: { codec: 'dts', kind: 'audio', name: 'DTS (2048-sample frames)' },
  BSSD: { codec: 's302m', kind: 'audio', name: 'SMPTE 302M (AES3 PCM)' },
  HEVC: { codec: 'hevc', kind: 'video', family: 'hevc', name: 'H.265 / HEVC' },
  'VVC ': { codec: 'vvc', kind: 'video', name: 'H.266 / VVC' },
  AV01: { codec: 'av1', kind: 'video', name: 'AV1' },
  'VC-1': { codec: 'vc1', kind: 'video', name: 'VC-1' },
  drac: { codec: 'dirac', kind: 'video', name: 'Dirac' },
  Opus: { codec: 'opus', kind: 'audio', name: 'Opus' },
  KLVA: { codec: 'smpte_klv', kind: 'data', name: 'SMPTE 336M KLV metadata' },
  'ID3 ': { codec: 'timed_id3', kind: 'data', name: 'ID3 timed metadata' },
  VANC: { codec: 'smpte_2038', kind: 'data', name: 'SMPTE 2038 ancillary data' },
  CUEI: { codec: 'scte_35', kind: 'data', name: 'SCTE-35 cue messages' },
};

/** Well-known registration format_identifiers (SMPTE-RA and de-facto). */
export const FORMAT_IDENTIFIERS = {
  'AC-3': 'Dolby AC-3 (ATSC A/52)', EAC3: 'Dolby E-AC-3', 'AC-4': 'Dolby AC-4', HDMV: 'Blu-ray (HDMV) transport stream',
  HDPR: 'Blu-ray (HDMV) private', CUEI: 'SCTE-35 cue messages (splice information)', GA94: 'ATSC',
  HEVC: 'H.265 / HEVC video', AV01: 'AV1 video (AOM carriage of AV1 in MPEG-2 TS)', 'VC-1': 'SMPTE VC-1 video',
  BSSD: 'SMPTE 302M AES3 audio', KLVA: 'SMPTE KLV metadata', 'ID3 ': 'ID3 timed metadata', Opus: 'Opus audio',
  DTS1: 'DTS audio', DTS2: 'DTS audio', DTS3: 'DTS audio', drac: 'Dirac video', VANC: 'SMPTE 2038 ancillary data',
  SCTE: 'SCTE', 'VVC ': 'H.266 / VVC video', apad: 'Apple (HLS) audio setup information', 'mp4a': 'MPEG-4 audio',
};

/** Display names for the short codec identifiers. */
export const CODEC_DISPLAY = {
  mpeg1video: 'MPEG-1 Video', mpeg2video: 'MPEG-2 Video (H.262)', mp1: 'MPEG-1 Audio Layer I', mp2: 'MPEG Audio Layer II',
  mp3: 'MPEG Audio Layer III (MP3)', aac: 'AAC (ADTS)', aac_latm: 'AAC (LATM/LOAS)', mpeg4: 'MPEG-4 Part 2 Visual',
  h264: 'H.264 / AVC', hevc: 'H.265 / HEVC', vvc: 'H.266 / VVC', ac3: 'AC-3 (Dolby Digital)', eac3: 'E-AC-3 (Dolby Digital Plus)',
  ac4: 'AC-4', dts: 'DTS', truehd: 'Dolby TrueHD', pcm_bluray: 'Blu-ray LPCM', s302m: 'SMPTE 302M PCM', opus: 'Opus',
  av1: 'AV1', vc1: 'VC-1', dirac: 'Dirac', jpeg2000: 'JPEG 2000', jpegxs: 'JPEG XS', evc: 'MPEG-5 EVC',
  scte_35: 'SCTE-35 splice information', dvb_subtitle: 'DVB subtitles (bitmap)', dvb_teletext: 'DVB teletext',
  hdmv_pgs_subtitle: 'Blu-ray PGS subtitles', hdmv_text_subtitle: 'Blu-ray text subtitles', hdmv_ig: 'Blu-ray interactive graphics',
  smpte_klv: 'KLV metadata', timed_id3: 'ID3 timed metadata', smpte_2038: 'SMPTE 2038 ancillary data', scte27: 'SCTE 27 subtitles',
  mov_text: 'MPEG-4 timed text', private: 'private data', private_sections: 'private sections', metadata: 'metadata',
  mpegh_3d_audio: 'MPEG-H 3D Audio', unknown: 'unknown',
};

export function codecDisplay(codec) {
  return CODEC_DISPLAY[codec] ?? codec;
}

// ------------------------------------------------------------------ PES stream IDs

/** stream_id of a PES packet (ISO/IEC 13818-1 Table 2-22). */
export function streamIdName(id) {
  if (id >= 0xc0 && id <= 0xdf) return `MPEG audio stream ${id - 0xc0}`;
  if (id >= 0xe0 && id <= 0xef) return `MPEG video stream ${id - 0xe0}`;
  switch (id) {
    case 0xbc: return 'program_stream_map';
    case 0xbd: return 'private_stream_1 (AC-3, DTS, subtitles, …)';
    case 0xbe: return 'padding_stream';
    case 0xbf: return 'private_stream_2';
    case 0xf0: return 'ECM stream (conditional access)';
    case 0xf1: return 'EMM stream (conditional access)';
    case 0xf2: return 'DSM-CC stream';
    case 0xf3: return 'ISO/IEC 13522 (MHEG) stream';
    case 0xf4: return 'H.222.1 type A';
    case 0xf5: return 'H.222.1 type B';
    case 0xf6: return 'H.222.1 type C';
    case 0xf7: return 'H.222.1 type D';
    case 0xf8: return 'H.222.1 type E';
    case 0xf9: return 'ancillary_stream';
    case 0xfa: return 'MPEG-4 SL-packetized stream';
    case 0xfb: return 'MPEG-4 FlexMux stream';
    case 0xfc: return 'metadata stream';
    case 0xfd: return 'extended_stream_id';
    case 0xfe: return 'reserved data stream';
    case 0xff: return 'program_stream_directory';
    default: return 'reserved';
  }
}

/** PES packets of these streams have no optional header (flags, PTS...): just data bytes. */
export function pesHasOptionalHeader(id) {
  return !(id === 0xbc || id === 0xbe || id === 0xbf || id === 0xf0 || id === 0xf1 || id === 0xff || id === 0xf2 || id === 0xf8);
}

// ------------------------------------------------------------------ table IDs

export const TABLE_IDS = {
  0x00: ['PAT', 'program_association_section'],
  0x01: ['CAT', 'conditional_access_section'],
  0x02: ['PMT', 'TS_program_map_section'],
  0x03: ['TSDT', 'TS_description_section'],
  0x04: ['SDS', 'ISO/IEC 14496 scene description section'],
  0x05: ['ODS', 'ISO/IEC 14496 object descriptor section'],
  0x06: ['MDS', 'metadata_section'],
  0x07: ['IPMP', 'IPMP control information section'],
  0x3a: ['DSM-CC', 'DSM-CC multiprotocol encapsulation'],
  0x3b: ['DSM-CC', 'DSM-CC U-N messages (DSI/DII)'],
  0x3c: ['DSM-CC', 'DSM-CC download data messages (DDB)'],
  0x3d: ['DSM-CC', 'DSM-CC stream descriptors'],
  0x3e: ['DSM-CC', 'DSM-CC private data'],
  0x40: ['NIT', 'network_information_section – actual network'],
  0x41: ['NIT', 'network_information_section – other network'],
  0x42: ['SDT', 'service_description_section – actual transport stream'],
  0x46: ['SDT', 'service_description_section – other transport stream'],
  0x4a: ['BAT', 'bouquet_association_section'],
  0x4e: ['EIT', 'event_information_section – actual TS, present/following'],
  0x4f: ['EIT', 'event_information_section – other TS, present/following'],
  0x70: ['TDT', 'time_date_section'],
  0x71: ['RST', 'running_status_section'],
  0x72: ['ST', 'stuffing_section'],
  0x73: ['TOT', 'time_offset_section'],
  0x74: ['AIT', 'application information section (HbbTV / MHP)'],
  0x7e: ['DIT', 'discontinuity_information_section'],
  0x7f: ['SIT', 'selection_information_section'],
  0xc7: ['MGT', 'ATSC master guide table'],
  0xc8: ['TVCT', 'ATSC terrestrial virtual channel table'],
  0xc9: ['CVCT', 'ATSC cable virtual channel table'],
  0xca: ['RRT', 'ATSC rating region table'],
  0xcb: ['EIT', 'ATSC event information table'],
  0xcc: ['ETT', 'ATSC extended text table'],
  0xcd: ['STT', 'ATSC system time table'],
  0xfc: ['SCTE-35', 'splice_info_section (SCTE 35)'],
  0xff: ['stuffing', 'stuffing (0xFF: no more sections in this packet)'],
};

export function tableIdInfo(id) {
  const t = TABLE_IDS[id];
  if (t) return { short: t[0], name: t[1] };
  if (id >= 0x50 && id <= 0x5f) return { short: 'EIT', name: 'event_information_section – actual TS, schedule' };
  if (id >= 0x60 && id <= 0x6f) return { short: 'EIT', name: 'event_information_section – other TS, schedule' };
  if (id >= 0x08 && id <= 0x3f) return { short: 'reserved', name: 'reserved by ISO/IEC 13818-1' };
  if (id >= 0x80 && id <= 0xfe) return { short: 'private', name: 'user-defined (private) section' };
  return { short: 'section', name: 'section' };
}

// ------------------------------------------------------------------ descriptors

/** descriptor_tag names: ISO/IEC 13818-1 (0x00–0x3F), DVB EN 300 468 (0x40–0x7F), common private ones above. */
export const DESCRIPTOR_TAGS = {
  0x02: 'video_stream_descriptor', 0x03: 'audio_stream_descriptor', 0x04: 'hierarchy_descriptor',
  0x05: 'registration_descriptor', 0x06: 'data_stream_alignment_descriptor', 0x07: 'target_background_grid_descriptor',
  0x08: 'video_window_descriptor', 0x09: 'CA_descriptor', 0x0a: 'ISO_639_language_descriptor',
  0x0b: 'system_clock_descriptor', 0x0c: 'multiplex_buffer_utilization_descriptor', 0x0d: 'copyright_descriptor',
  0x0e: 'maximum_bitrate_descriptor', 0x0f: 'private_data_indicator_descriptor', 0x10: 'smoothing_buffer_descriptor',
  0x11: 'STD_descriptor', 0x12: 'IBP_descriptor', 0x13: 'DSM-CC carousel_identifier_descriptor',
  0x14: 'DSM-CC association_tag_descriptor', 0x15: 'DSM-CC deferred_association_tags_descriptor',
  0x1b: 'MPEG-4_video_descriptor', 0x1c: 'MPEG-4_audio_descriptor', 0x1d: 'IOD_descriptor', 0x1e: 'SL_descriptor',
  0x1f: 'FMC_descriptor', 0x20: 'external_ES_ID_descriptor', 0x21: 'MuxCode_descriptor', 0x22: 'FmxBufferSize_descriptor',
  0x23: 'multiplexbuffer_descriptor', 0x24: 'content_labeling_descriptor', 0x25: 'metadata_pointer_descriptor',
  0x26: 'metadata_descriptor', 0x27: 'metadata_STD_descriptor', 0x28: 'AVC_video_descriptor', 0x29: 'IPMP_descriptor',
  0x2a: 'AVC_timing_and_HRD_descriptor', 0x2b: 'MPEG-2_AAC_audio_descriptor', 0x2c: 'FlexMuxTiming_descriptor',
  0x2d: 'MPEG-4_text_descriptor', 0x2e: 'MPEG-4_audio_extension_descriptor', 0x2f: 'auxiliary_video_stream_descriptor',
  0x30: 'SVC_extension_descriptor', 0x31: 'MVC_extension_descriptor', 0x32: 'J2K_video_descriptor',
  0x33: 'MVC_operation_point_descriptor', 0x34: 'MPEG2_stereoscopic_video_format_descriptor',
  0x35: 'stereoscopic_program_info_descriptor', 0x36: 'stereoscopic_video_info_descriptor',
  0x37: 'transport_profile_descriptor', 0x38: 'HEVC_video_descriptor', 0x39: 'VVC_video_descriptor',
  0x3a: 'EVC_video_descriptor', 0x3f: 'extension_descriptor',
  0x40: 'network_name_descriptor', 0x41: 'service_list_descriptor', 0x42: 'stuffing_descriptor',
  0x43: 'satellite_delivery_system_descriptor', 0x44: 'cable_delivery_system_descriptor', 0x45: 'VBI_data_descriptor',
  0x46: 'VBI_teletext_descriptor', 0x47: 'bouquet_name_descriptor', 0x48: 'service_descriptor',
  0x49: 'country_availability_descriptor', 0x4a: 'linkage_descriptor', 0x4b: 'NVOD_reference_descriptor',
  0x4c: 'time_shifted_service_descriptor', 0x4d: 'short_event_descriptor', 0x4e: 'extended_event_descriptor',
  0x4f: 'time_shifted_event_descriptor', 0x50: 'component_descriptor', 0x51: 'mosaic_descriptor',
  0x52: 'stream_identifier_descriptor', 0x53: 'CA_identifier_descriptor', 0x54: 'content_descriptor',
  0x55: 'parental_rating_descriptor', 0x56: 'teletext_descriptor', 0x57: 'telephone_descriptor',
  0x58: 'local_time_offset_descriptor', 0x59: 'subtitling_descriptor', 0x5a: 'terrestrial_delivery_system_descriptor',
  0x5b: 'multilingual_network_name_descriptor', 0x5c: 'multilingual_bouquet_name_descriptor',
  0x5d: 'multilingual_service_name_descriptor', 0x5e: 'multilingual_component_descriptor',
  0x5f: 'private_data_specifier_descriptor', 0x60: 'service_move_descriptor', 0x61: 'short_smoothing_buffer_descriptor',
  0x62: 'frequency_list_descriptor', 0x63: 'partial_transport_stream_descriptor', 0x64: 'data_broadcast_descriptor',
  0x65: 'scrambling_descriptor', 0x66: 'data_broadcast_id_descriptor', 0x67: 'transport_stream_descriptor',
  0x68: 'DSNG_descriptor', 0x69: 'PDC_descriptor', 0x6a: 'AC-3_descriptor', 0x6b: 'ancillary_data_descriptor',
  0x6c: 'cell_list_descriptor', 0x6d: 'cell_frequency_link_descriptor', 0x6e: 'announcement_support_descriptor',
  0x6f: 'application_signalling_descriptor', 0x70: 'adaptation_field_data_descriptor', 0x71: 'service_identifier_descriptor',
  0x72: 'service_availability_descriptor', 0x73: 'default_authority_descriptor', 0x74: 'related_content_descriptor',
  0x75: 'TVA_id_descriptor', 0x76: 'content_identifier_descriptor', 0x77: 'time_slice_fec_identifier_descriptor',
  0x78: 'ECM_repetition_rate_descriptor', 0x79: 'S2_satellite_delivery_system_descriptor', 0x7a: 'enhanced_AC-3_descriptor',
  0x7b: 'DTS_descriptor', 0x7c: 'AAC_descriptor', 0x7d: 'XAIT_location_descriptor', 0x7e: 'FTA_content_management_descriptor',
  0x7f: 'extension_descriptor',
};

/** Private descriptor tags whose meaning depends on the system; named only as hints. */
export const PRIVATE_DESCRIPTOR_HINTS = {
  0x81: 'AC-3 audio descriptor (ATSC A/52)', 0x83: 'logical channel number descriptor (NorDig/EACEM, private)',
  0x86: 'caption service descriptor (ATSC A/65)', 0x87: 'content advisory descriptor (ATSC A/65)',
  0x88: 'HDMV copy control descriptor (Blu-ray)', 0x8a: 'cue identifier descriptor (SCTE 35)',
  0xa0: 'extended channel name descriptor (ATSC A/65)', 0xa1: 'service location descriptor (ATSC A/65)',
  0xcc: 'E-AC-3 audio descriptor (ATSC A/52)',
};

export function descriptorName(tag) {
  return DESCRIPTOR_TAGS[tag] ?? PRIVATE_DESCRIPTOR_HINTS[tag] ?? (tag >= 0x80 && tag <= 0xfe ? 'user-private descriptor' : 'reserved descriptor');
}

// ------------------------------------------------------------------ misc enums

export const SCRAMBLING = {
  0: 'not scrambled',
  1: 'user-defined (1)',
  2: 'scrambled with the even key (DVB)',
  3: 'scrambled with the odd key (DVB)',
};

export const AFC = {
  0: 'reserved (invalid)',
  1: 'payload only',
  2: 'adaptation field only, no payload',
  3: 'adaptation field followed by payload',
};

export const SERVICE_TYPES = {
  0x01: 'digital television', 0x02: 'digital radio sound', 0x03: 'teletext', 0x04: 'NVOD reference', 0x05: 'NVOD time-shifted',
  0x06: 'mosaic', 0x07: 'FM radio', 0x08: 'DVB SRM', 0x0a: 'advanced codec digital radio sound', 0x0b: 'H.264/AVC mosaic',
  0x0c: 'data broadcast', 0x0d: 'common interface', 0x0e: 'RCS map', 0x0f: 'RCS FLS', 0x10: 'DVB MHP',
  0x11: 'MPEG-2 HD digital television', 0x16: 'H.264/AVC SD digital television', 0x17: 'H.264/AVC SD NVOD time-shifted',
  0x18: 'H.264/AVC SD NVOD reference', 0x19: 'H.264/AVC HD digital television', 0x1a: 'H.264/AVC HD NVOD time-shifted',
  0x1b: 'H.264/AVC HD NVOD reference', 0x1c: 'H.264/AVC frame-compatible plano-stereoscopic HD television',
  0x1f: 'HEVC digital television', 0x20: 'HEVC UHD digital television',
};

export const RUNNING_STATUS = { 0: 'undefined', 1: 'not running', 2: 'starts in a few seconds', 3: 'pausing', 4: 'running', 5: 'service off-air' };

export const AUDIO_TYPES = { 0: 'undefined (normal audio)', 1: 'clean effects', 2: 'hearing impaired', 3: 'visual impaired commentary' };

export const ALIGNMENT_TYPES_VIDEO = {
  1: 'slice, or video access unit', 2: 'video access unit', 3: 'GOP or SEQ', 4: 'SEQ',
};
export const ALIGNMENT_TYPES_AUDIO = { 1: 'syncword' };

export const CA_SYSTEMS = [
  [0x0100, 0x01ff, 'Canal+ / SECA (Mediaguard)'], [0x0500, 0x05ff, 'Viaccess'], [0x0600, 0x06ff, 'Irdeto'],
  [0x0900, 0x09ff, 'NDS / Synamedia (VideoGuard)'], [0x0b00, 0x0bff, 'Conax'], [0x0d00, 0x0dff, 'Cryptoworks'],
  [0x0e00, 0x0eff, 'PowerVu'], [0x1700, 0x17ff, 'BetaCrypt'], [0x1800, 0x18ff, 'Nagravision'],
  [0x2600, 0x26ff, 'BISS'], [0x4ae0, 0x4ae1, 'DRE-Crypt'], [0x5581, 0x5581, 'Bulcrypt'], [0x4a02, 0x4a02, 'Tongfang'],
];

export function caSystemName(id) {
  for (const [a, b, n] of CA_SYSTEMS) if (id >= a && id <= b) return n;
  return null;
}

export const SPLICE_COMMANDS = {
  0x00: 'splice_null', 0x04: 'splice_schedule', 0x05: 'splice_insert', 0x06: 'time_signal',
  0x07: 'bandwidth_reservation', 0xff: 'private_command',
};

export const SPLICE_DESCRIPTORS = { 0x00: 'avail_descriptor', 0x01: 'DTMF_descriptor', 0x02: 'segmentation_descriptor', 0x03: 'time_descriptor', 0x04: 'audio_descriptor' };

export const SUBTITLING_TYPES = {
  0x01: 'EBU teletext subtitles', 0x02: 'associated EBU teletext', 0x03: 'VBI data',
  0x10: 'DVB subtitles (normal, no aspect ratio)', 0x11: 'DVB subtitles (normal, 4:3)', 0x12: 'DVB subtitles (normal, 16:9)',
  0x13: 'DVB subtitles (normal, 2.21:1)', 0x14: 'DVB subtitles (normal, HD)', 0x15: 'DVB subtitles (normal, plano-stereoscopic)',
  0x20: 'DVB subtitles (hard of hearing, no aspect ratio)', 0x21: 'DVB subtitles (hard of hearing, 4:3)',
  0x22: 'DVB subtitles (hard of hearing, 16:9)', 0x23: 'DVB subtitles (hard of hearing, 2.21:1)',
  0x24: 'DVB subtitles (hard of hearing, HD)', 0x25: 'DVB subtitles (hard of hearing, plano-stereoscopic)',
};

export const TELETEXT_TYPES = {
  0x01: 'initial teletext page', 0x02: 'teletext subtitle page', 0x03: 'additional information page',
  0x04: 'programme schedule page', 0x05: 'teletext subtitle page for hearing impaired people',
};
