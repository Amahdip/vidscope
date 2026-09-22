// Descriptions of every structure Vidscope shows for a transport stream:
// what it is (desc) and why it matters (more), with the specification it
// comes from.

import { H222, EN300468, H222_LINK, EN300468_LINK, TR101290_LINK, SCTE35_LINK, M2TS_LINK } from './tables.js';

const iso = (section, extra = {}) => ({ ...H222, section, links: [H222_LINK], ...extra });
const dvb = (section, extra = {}) => ({ ...EN300468, section, links: [EN300468_LINK], ...extra });

const PACKET_SYNTAX = `transport_packet() {
  sync_byte                        8   0x47
  transport_error_indicator        1
  payload_unit_start_indicator     1
  transport_priority               1
  PID                             13
  transport_scrambling_control     2
  adaptation_field_control         2
  continuity_counter               4
  if (adaptation_field_control == '10' || '11') adaptation_field()
  if (adaptation_field_control == '01' || '11') data_byte ... (to 188 bytes)
}`;

const PACKET_MORE = 'A transport stream has no file header and no index: it is simply a sequence of these packets, which is why a TS can be cut, joined or picked up from the middle of a broadcast. The 13-bit PID says which stream a packet belongs to; the PAT (PID 0) and the PMTs map PIDs to programs and codecs. Audio and video are cut into PES packets, and each PES packet is spread over as many transport packets as needed: payload_unit_start_indicator marks the packet where a new PES packet (or PSI section) begins, and continuity_counter (0–15, per PID) lets a receiver notice lost packets. The 4-byte header costs about 2% of the bitrate.';

export const PACKET = {
  name: 'Transport Stream Packet',
  cat: 'media',
  desc: 'One fixed-size 188-byte unit of the transport stream: a 4-byte header naming the stream (PID) it belongs to, an optional adaptation field, and up to 184 bytes of payload.',
  more: PACKET_MORE,
  syntax: PACKET_SYNTAX,
  ...iso('2.4.3.2'),
};

const variant = (o) => ({ ...PACKET, ...o, more: o.more ? `${o.more}\n\n${PACKET_MORE}` : PACKET_MORE });

export const PACKET_DEFS = {
  pesStart: variant({
    name: 'Transport Packet – start of a PES packet',
    desc: 'A packet whose payload begins a new PES packet (payload_unit_start_indicator = 1): it carries the PES header with the timestamps, followed by the first bytes of an audio or video frame.',
    more: 'Decoders can only start decoding a stream at such a packet, and for video only when the frame it starts is a key frame; the adaptation field of that packet usually sets random_access_indicator to say so.',
  }),
  pesCont: variant({
    name: 'Transport Packet – PES continuation',
    desc: 'A packet that carries the next 184 (or fewer) bytes of the PES packet started in an earlier packet with the same PID.',
    more: 'The bytes are simply appended to the PES packet being reassembled. If the continuity counter skips a value, a packet was lost and the frame being reassembled is damaged.',
  }),
  psi: variant({
    name: 'Transport Packet – PSI/SI section',
    cat: 'table',
    desc: 'A packet carrying a table section (PAT, PMT, SDT...) that describes the stream rather than audio or video.',
    more: 'Tables are sent as sections: a pointer_field in the first payload byte (when payload_unit_start_indicator = 1) says where the first new section starts; a section longer than one packet continues in the next packets of the same PID. Tables repeat continuously so a receiver can tune in at any time.',
  }),
  pat: variant({
    name: 'Transport Packet – PAT',
    cat: 'table',
    desc: 'A packet on PID 0x0000 carrying the Program Association Table: the entry point that lists every program in the stream and the PID of each program’s PMT.',
    more: 'A receiver that tunes in reads nothing else until it has a PAT, then the PMT it points to. Encoders therefore repeat it often (typically every 100 ms); TR 101 290 counts a gap above 0.5 s as a priority-1 error.',
  }),
  pmt: variant({
    name: 'Transport Packet – PMT',
    cat: 'table',
    desc: 'A packet carrying a Program Map Table: the list of elementary streams (PIDs, codecs, languages) that make up one program, and the PID carrying its clock (PCR).',
    more: 'Without the PMT a decoder does not know which PIDs are video or audio, or which codec they use. It is repeated like the PAT (TR 101 290 PMT_error: more than 0.5 s between sections).',
  }),
  si: variant({
    name: 'Transport Packet – DVB service information',
    cat: 'table',
    desc: 'A packet carrying DVB service information (SDT, NIT, EIT, TDT/TOT...): channel names, network details, the programme guide or the time of day.',
    more: 'These tables are not needed to decode audio and video, but set-top boxes use them to build channel lists and EPGs. EN 300 468 defines them; ISO/IEC 13818-1 only needs PAT, PMT and CAT.',
  }),
  scte35: variant({
    name: 'Transport Packet – SCTE-35 cue',
    cat: 'meta',
    desc: 'A packet carrying an SCTE-35 splice_info_section: a cue that tells downstream equipment where an ad break or program boundary is.',
    more: 'Ad-insertion servers and packagers (HLS/DASH) read these cues to splice ads at frame-accurate points or to mark content boundaries.',
    links: [H222_LINK, SCTE35_LINK],
  }),
  afOnly: variant({
    name: 'Transport Packet – adaptation field only',
    cat: 'header',
    desc: 'A packet with an adaptation field and no payload: it exists to deliver a PCR (the program clock) or to pad the stream.',
    more: 'Multiplexers send such packets on the PCR PID when no media packet is due but the clock reference must still arrive on time (at most every 100 ms, 40 ms in DVB).',
  }),
  null: variant({
    name: 'Null Packet',
    cat: 'free',
    desc: 'A stuffing packet on PID 0x1FFF. Its payload carries no information and every receiver discards it.',
    more: 'Constant-bitrate transports (broadcast, satellite, IPTV multicasts) must deliver exactly N bits per second, so the multiplexer fills unused capacity with null packets. They are also where re-multiplexers insert new data. In a file meant for streaming over HTTP they are pure overhead.',
  }),
  scrambled: variant({
    name: 'Transport Packet – scrambled payload',
    cat: 'protect',
    desc: 'A packet whose payload is encrypted (transport_scrambling_control ≠ 0). Only the header and adaptation field are readable; the payload needs the keys delivered by the conditional-access system.',
    more: 'DVB-CSA and similar systems encrypt the payload of transport packets; the ECMs (on a PID given by a CA_descriptor in the PMT) carry the control words that alternate between the even and odd key.',
  }),
  unknown: variant({
    name: 'Transport Packet – unreferenced PID',
    cat: 'unknown',
    desc: 'A packet on a PID that no PAT/PMT entry (and no well-known PID assignment) describes, so its content cannot be interpreted reliably.',
    more: 'Players ignore such PIDs. They can be leftovers of a remux, private data, or streams whose PMT was not seen yet (for example when a recording starts after the PMT changed).',
  }),
  noSync: {
    name: 'Invalid packet (sync byte missing)',
    cat: 'unknown',
    desc: 'The byte where this packet should start is not the sync byte 0x47, so the stream has lost packet alignment here.',
    more: 'Real receivers declare sync loss after a few bad sync bytes (TR 101 290 TS_sync_loss) and search for a new sequence of 0x47 bytes 188 bytes apart. Truncated downloads, bad concatenation or a storage error typically cause this.',
    ...H222,
    links: [H222_LINK, TR101290_LINK],
  },
};

export const ADAPTATION_FIELD = {
  name: 'Adaptation Field',
  cat: 'header',
  desc: 'Optional extension of the packet header that carries timing and signalling: the PCR clock, the random-access and discontinuity flags, splicing information, and stuffing bytes.',
  more: 'The PCR (Program Clock Reference) is the heartbeat of a transport stream: a 27 MHz clock sample that lets the decoder lock its own clock to the encoder’s, so that PTS/DTS values mean the same instant on both sides. random_access_indicator = 1 announces that the next PES packet of this PID starts at a point where decoding can begin (a key frame, or an audio frame). The adaptation field also pads packets: when fewer than 184 payload bytes are left for the last packet of a PES packet, the muxer grows the adaptation field with 0xFF stuffing bytes so the packet still has 188 bytes.',
  syntax: `adaptation_field() {
  adaptation_field_length                8
  if (adaptation_field_length > 0) {
    discontinuity_indicator              1
    random_access_indicator              1
    elementary_stream_priority_indicator 1
    PCR_flag  OPCR_flag  splicing_point_flag
    transport_private_data_flag  adaptation_field_extension_flag
    if (PCR_flag)  program_clock_reference_base 33, reserved 6, _extension 9
    if (OPCR_flag) original_program_clock_reference_base 33, reserved 6, _extension 9
    if (splicing_point_flag) splice_countdown 8
    if (transport_private_data_flag) length 8, private_data_byte ...
    if (adaptation_field_extension_flag) adaptation_field_extension()
    stuffing_byte ... (0xFF)
  }
}`,
  ...iso('2.4.3.4'),
};

export const PES_HEADER = {
  name: 'PES Packet Header',
  cat: 'header',
  desc: 'The header of a Packetized Elementary Stream packet: which stream this is (stream_id), how long the packet is, and the timestamps (PTS/DTS) of the frame it carries.',
  more: 'Every audio frame and video picture reaches the decoder inside a PES packet. PTS (presentation time stamp) says when the frame must be shown or heard; DTS (decode time stamp) says when it must be decoded, and is only present when it differs from the PTS — that is, for video with B-frames, where pictures are sent out of display order. Both count a 90 kHz clock on 33 bits (the counter wraps after about 26.5 hours) and are measured against the program’s PCR. PES_packet_length may be 0 for video in a transport stream, meaning "until the next PES packet starts".',
  syntax: `PES_packet() {
  packet_start_code_prefix   24   0x000001
  stream_id                   8
  PES_packet_length          16
  '10'  PES_scrambling_control 2  PES_priority 1  data_alignment_indicator 1
  copyright 1  original_or_copy 1  PTS_DTS_flags 2  ESCR_flag 1  ES_rate_flag 1
  DSM_trick_mode_flag 1  additional_copy_info_flag 1  PES_CRC_flag 1  PES_extension_flag 1
  PES_header_data_length      8
  PTS / DTS / ESCR / ... optional fields, then stuffing (0xFF)
  PES_packet_data_byte ...
}`,
  ...iso('2.4.3.6'),
};

const SECTION_MORE = 'Sections share one header: table_id, section_length, and (in the long form) an identifier, version_number, current_next_indicator and section numbers, with a CRC_32 at the end. A receiver keeps the last version it has seen and only re-reads a table when its version changes.';

export const SECTION_DEFS = {
  0x00: {
    name: 'Program Association Section (PAT)',
    cat: 'table',
    desc: 'The table of contents of the transport stream: for each program number, the PID on which that program’s PMT is sent (program 0 points to the NIT instead).',
    more: `It is always on PID 0x0000, so it is the first thing a receiver looks for. Its transport_stream_id identifies the multiplex. ${SECTION_MORE}`,
    ...iso('2.4.4.3'),
  },
  0x01: {
    name: 'Conditional Access Section (CAT)',
    cat: 'table',
    desc: 'Lists the conditional-access systems used in the stream and the PIDs of their EMMs (the messages that deliver subscription rights to smart cards).',
    more: `Always on PID 0x0001. Only present when something is scrambled. ${SECTION_MORE}`,
    ...iso('2.4.4.6'),
  },
  0x02: {
    name: 'Program Map Section (PMT)',
    cat: 'table',
    desc: 'Describes one program: its clock PID (PCR_PID), program-level descriptors, and for each elementary stream the stream_type (codec), the PID and descriptors such as language.',
    more: `This is where a demuxer learns what each PID contains. stream_type values 0x00–0x7F are defined by ISO/IEC 13818-1; 0x80–0xFF are private and interpreted according to the system (ATSC, Blu-ray, HLS), which is why registration descriptors exist. ${SECTION_MORE}`,
    ...iso('2.4.4.8'),
  },
  0x40: {
    name: 'Network Information Section (NIT)',
    cat: 'table',
    desc: 'DVB table describing the delivery network: its name and the transport streams it carries, with tuning parameters (frequency, modulation...).',
    more: `Receivers use it for automatic channel scans. Its PID is given by program 0 of the PAT (0x0010 in DVB). ${SECTION_MORE}`,
    ...dvb('5.2.1'),
  },
  0x42: {
    name: 'Service Description Section (SDT)',
    cat: 'table',
    desc: 'DVB table giving each service (program) a name, a provider name and a type (TV, radio...): what channel lists show.',
    more: `Sent on PID 0x0011; table_id 0x42 describes this transport stream, 0x46 others. DVB expects it at least every 2 s. ${SECTION_MORE}`,
    ...dvb('5.2.3'),
  },
  0x4a: {
    name: 'Bouquet Association Section (BAT)',
    cat: 'table',
    desc: 'DVB table grouping services into commercial bouquets (packages), possibly across networks.',
    more: `Shares PID 0x0011 with the SDT. ${SECTION_MORE}`,
    ...dvb('5.2.2'),
  },
  eit: {
    name: 'Event Information Section (EIT)',
    cat: 'table',
    desc: 'DVB electronic programme guide data: the events (programmes) of a service with start time, duration, title and description.',
    more: `table_id 0x4E/0x4F carry the present and following events ("now/next"), 0x50–0x6F the schedule for the coming days. Sent on PID 0x0012. ${SECTION_MORE}`,
    ...dvb('5.2.4'),
  },
  0x70: {
    name: 'Time and Date Section (TDT)',
    cat: 'table',
    desc: 'DVB table with the current UTC date and time, from which receivers set their clock.',
    more: 'A short section without CRC on PID 0x0014, sent at least every 30 s.',
    ...dvb('5.2.5'),
  },
  0x73: {
    name: 'Time Offset Section (TOT)',
    cat: 'table',
    desc: 'DVB table with the current UTC time plus local time offsets (time zones, daylight saving changes).',
    more: 'Sent on PID 0x0014 next to the TDT.',
    ...dvb('5.2.6'),
  },
  0xfc: {
    name: 'Splice Information Section (SCTE-35)',
    cat: 'meta',
    desc: 'An SCTE-35 cue message: tells ad-insertion and packaging equipment where to splice (start or end an ad break) or where a segment of content begins.',
    more: 'splice_insert carries an event ID, whether the splice leaves or returns to the network, and a PTS time (plus pts_adjustment); time_signal with segmentation descriptors is the modern form. Cues are sent ahead of the splice point.',
    specTitle: 'ANSI/SCTE 35 (Digital Program Insertion Cueing Message)',
    links: [SCTE35_LINK],
  },
  generic: {
    name: 'Section',
    cat: 'table',
    desc: 'A table section that Vidscope recognises by its table_id but does not decode in detail.',
    more: SECTION_MORE,
    ...iso('2.4.4'),
  },
};

export function sectionDef(tableId) {
  if (SECTION_DEFS[tableId]) return SECTION_DEFS[tableId];
  if (tableId === 0x41) return SECTION_DEFS[0x40];
  if (tableId === 0x46) return SECTION_DEFS[0x42];
  if (tableId >= 0x4e && tableId <= 0x6f) return SECTION_DEFS.eit;
  return SECTION_DEFS.generic;
}

export const GROUP = {
  name: 'Packet group',
  cat: 'media',
  desc: 'A run of consecutive transport packets. The format has no such grouping: Vidscope groups packets so that files with millions of them stay navigable, and only reads a group when you open it.',
  more: 'A transport stream is a flat sequence of 188-byte packets; programs, PES packets and tables are interleaved inside it rather than stored in separate places. The label shows the playback time the group covers, measured with the PCR once the whole file has been scanned.',
};

export const REGIONS = {
  leading: {
    name: 'Partial packet at the start',
    cat: 'unknown',
    desc: 'Bytes before the first complete packet: the file starts in the middle of a transport packet.',
    more: 'Recordings of live streams and files cut at an arbitrary byte begin like this. Demuxers skip ahead to the first sync byte (0x47) that repeats every packet length; Vidscope does the same.',
    ...H222,
  },
  trailing: {
    name: 'Partial packet at the end',
    cat: 'unknown',
    desc: 'Bytes after the last complete packet: the file ends in the middle of a transport packet (it was probably truncated or is still being written).',
    more: 'The incomplete packet is ignored by demuxers; a frame it belonged to is usually lost.',
    ...H222,
  },
  junk: {
    name: 'Unsynchronised bytes',
    cat: 'unknown',
    desc: 'Bytes where no valid packet starts: the regular pattern of sync bytes (0x47 every packet) is broken here.',
    more: 'After a sync loss, a demuxer searches for the next position where 0x47 repeats at the packet interval and resumes there. Everything in between is lost (TR 101 290 TS_sync_loss / Sync_byte_error).',
    ...H222,
    links: [H222_LINK, TR101290_LINK],
  },
};

export const M2TS_HEADER_DESC = 'BDAV / M2TS (Blu-ray, AVCHD) puts a 4-byte TP_extra_header in front of every 188-byte packet: 2 bits of copy permission and a 30-bit arrival_time_stamp from a 27 MHz clock, which tells a player exactly when each packet arrived so it can reproduce the original timing of a variable-bitrate recording.';
export const M2TS_LINKS = [H222_LINK, M2TS_LINK];
