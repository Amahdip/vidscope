// Descriptors: the tag-length-value records that PSI/SI tables use to attach
// details to a program, an elementary stream, a service or an event.
// ISO/IEC 13818-1 § 2.6 defines tags 0x00–0x3F, ETSI EN 300 468 defines the
// DVB ones (0x40–0x7F); 0x80–0xFE are private and interpreted by context.

import { ParseError } from '../../core/fields.js';
import { fmtInt, fmtNum, fmtBitrate } from '../../core/util.js';
import { PROFILES as AVC_PROFILES, levelName as avcLevel } from '../../codecs/h264.js';
import { PROFILES as HEVC_PROFILES, levelName as hevcLevel } from '../../codecs/h265.js';
import {
  hex2, hexPid, descriptorName, FORMAT_IDENTIFIERS, AUDIO_TYPES, ALIGNMENT_TYPES_VIDEO, ALIGNMENT_TYPES_AUDIO,
  SERVICE_TYPES, SUBTITLING_TYPES, TELETEXT_TYPES, caSystemName,
} from './tables.js';
import { bin } from './tables.js';
import { dvbText, mjdTime, fmtUtc, bcdByte } from './text.js';

const FRAME_RATE_CODES = { 1: '23.976', 2: '24', 3: '25', 4: '29.97', 5: '30', 6: '50', 7: '59.94', 8: '60' };

const AC3_SERVICE_TYPES = {
  0: 'complete main', 1: 'music and effects', 2: 'visually impaired', 3: 'hearing impaired',
  4: 'dialogue', 5: 'commentary', 6: 'emergency', 7: 'voice over / karaoke',
};
const AC3_CHANNEL_TYPES = {
  0: 'mono', 1: '1+1 (dual mono)', 2: '2 channels (stereo)', 3: '2-channel Dolby Surround', 4: 'more than 2 channels',
  5: 'more than 5.1 channels', 6: 'multiple independent substreams', 7: 'reserved',
};

function ac3ComponentType(v) {
  const enh = v >> 7;
  const full = (v >> 6) & 1;
  const svc = (v >> 3) & 7;
  const ch = v & 7;
  return `${hex2(v)} → ${enh ? 'E-AC-3' : 'AC-3'}, ${full ? 'full service' : 'partial service'}, ${AC3_SERVICE_TYPES[svc]}, ${AC3_CHANNEL_TYPES[ch]}`;
}

const DVB_EXTENSION_TAGS = {
  0x00: 'image_icon_descriptor', 0x04: 'T2_delivery_system_descriptor', 0x06: 'supplementary_audio_descriptor',
  0x0e: 'DTS-HD_audio_stream_descriptor', 0x15: 'AC-4_descriptor', 0x19: 'audio_preselection_descriptor',
  0x20: 'TTML_subtitling_descriptor',
};

/** Read a 3-letter ISO 639-2 code. */
function lang(r, name = 'ISO_639_language_code', o = {}) {
  const v = r.str(name, 3, {
    encoding: 'latin1',
    desc: 'Three-letter ISO 639-2 language code, e.g. "eng", "fra", "deu". Players use it to pick the audio or subtitle language.',
    ...o,
  });
  return v;
}

/** A DVB text field preceded by its length byte (EN 300 468 Annex A text coding). */
function dvbString(r, lenName, name, o = {}) {
  const n = r.u8(lenName, { unit: 'bytes' });
  const start = r.pos;
  const bytes = r.u.subarray(start, Math.min(start + n, r.end));
  const { text, encoding } = dvbText(bytes);
  if (n > 0) {
    r.bytes(name, n, {
      display: JSON.stringify(text),
      note: `character coding: ${encoding}`,
      ...o,
    });
    const f = r.out[r.out.length - 1];
    f.type = 'string';
    f.value = text;
  }
  return text;
}

/** Text that fills the rest of the descriptor (no length byte). */
function dvbRest(r, name, o = {}) {
  if (r.remaining <= 0) return '';
  const bytes = r.u.subarray(r.pos, r.end);
  const { text, encoding } = dvbText(bytes);
  r.bytes(name, bytes.length, { display: JSON.stringify(text), note: `character coding: ${encoding}`, ...o });
  const f = r.out[r.out.length - 1];
  f.type = 'string';
  f.value = text;
  return text;
}

// ------------------------------------------------------------------ bodies

const BODIES = {
  // ---- ISO/IEC 13818-1
  0x02(r, d) {
    r.flag('multiple_frame_rate_flag', { desc: '1 = the frame rate may change within the stream.' });
    const frc = r.bits(4, 'frame_rate_code', { display: (v) => `${v} → ${FRAME_RATE_CODES[v] ?? 'reserved'} fps` });
    const m1 = r.flag('MPEG_1_only_flag', { desc: '1 = the stream is MPEG-1 video only.' });
    r.flag('constrained_parameter_flag');
    r.flag('still_picture_flag', { desc: '1 = the stream contains only still pictures.' });
    if (!m1 && r.remaining >= 2) {
      r.u8('profile_and_level_indication', { display: (v) => `${hex2(v)} → ${mpeg2ProfileLevel(v)}` });
      r.bits(2, 'chroma_format', { enum: { 1: '4:2:0', 2: '4:2:2', 3: '4:4:4' } });
      r.flag('frame_rate_extension_flag');
      r.bits(5, 'reserved', { reserved: true, display: bin(5) });
    }
    d.summary = `video stream, ${FRAME_RATE_CODES[frc] ?? '?'} fps`;
  },
  0x03(r, d) {
    r.flag('free_format_flag', { desc: '1 = free-format bitrate (bitrate_index 0) is used.' });
    const id = r.flag('ID', { enum: { 0: 'MPEG-2 lower sampling frequencies', 1: 'MPEG-1 / normal sampling frequencies' } });
    const layer = r.bits(2, 'layer', { enum: { 1: 'Layer III', 2: 'Layer II', 3: 'Layer I' } });
    r.flag('variable_rate_audio_indicator');
    r.bits(3, 'reserved', { reserved: true, display: bin(3) });
    d.summary = `audio stream, ${['?', 'Layer III', 'Layer II', 'Layer I'][layer]}${id ? '' : ' (LSF)'}`;
  },
  0x05(r, d) {
    const v = r.fourcc('format_identifier', {
      key: true,
      display: (x) => `'${x}'${FORMAT_IDENTIFIERS[x] ? ` — ${FORMAT_IDENTIFIERS[x]}` : ''}`,
      desc: 'A four-character code registered with the SMPTE Registration Authority that says which private format the stream (or the whole program) uses. Demuxers rely on it for codecs that have no stream_type of their own, e.g. \'AC-3\', \'EAC3\', \'HEVC\', \'Opus\', \'KLVA\', \'CUEI\' (SCTE-35) or \'HDMV\' (Blu-ray).',
    });
    d.format = v;
    if (r.remaining > 0) r.rest('additional_identification_info');
    d.summary = `registration '${v}'`;
  },
  0x06(r, d, ctx) {
    const video = ctx.kind === 'video';
    const v = r.u8('alignment_type', {
      display: (x) => `${x} → ${(video ? ALIGNMENT_TYPES_VIDEO : ALIGNMENT_TYPES_AUDIO)[x] ?? 'reserved'}`,
      desc: 'Guarantees what each PES packet starts with when data_alignment_indicator is set: for video 2 = a whole access unit (frame), for audio 1 = a sync word. Remuxers and segmenters use it to cut the stream cleanly.',
    });
    d.alignment = v;
    d.summary = `data alignment: ${(video ? ALIGNMENT_TYPES_VIDEO : ALIGNMENT_TYPES_AUDIO)[v] ?? v}`;
  },
  0x09(r, d) {
    const sys = r.u16('CA_system_ID', {
      key: true,
      display: (v) => `0x${v.toString(16).toUpperCase().padStart(4, '0')}${caSystemName(v) ? ` — ${caSystemName(v)}` : ''}`,
      desc: 'Which conditional-access (encryption) system is used. Assigned by DVB (ETSI TS 101 162).',
    });
    r.bits(3, 'reserved', { reserved: true, display: bin(3) });
    const pid = r.bits(13, 'CA_PID', {
      key: true,
      display: (v) => `${hexPid(v)} (${v})`,
      desc: 'The PID carrying the ECMs (keys for this program/stream, when in the PMT) or EMMs (entitlements, when in the CAT).',
    });
    if (r.remaining > 0) r.rest('private_data_byte');
    d.caSystem = sys;
    d.caPid = pid;
    d.summary = `CA system 0x${sys.toString(16).toUpperCase()}${caSystemName(sys) ? ` (${caSystemName(sys)})` : ''} on PID ${hexPid(pid)}`;
  },
  0x0a(r, d) {
    d.langs = [];
    let i = 0;
    while (r.remaining >= 4) {
      r.group(`language[${i++}]`, (g) => {
        const code = lang(r, 'ISO_639_language_code', { key: true });
        const at = r.u8('audio_type', { enum: AUDIO_TYPES, desc: 'Purpose of the audio: 0 = normal, 1 = clean effects (no dialogue), 2 = for the hearing impaired, 3 = audio description for the visually impaired.' });
        d.langs.push({ code, audioType: at });
        g.display = `${code}${at ? ` (${AUDIO_TYPES[at] ?? at})` : ''}`;
      });
    }
    d.summary = `language: ${d.langs.map((l) => l.code).join(', ')}`;
  },
  0x0b(r, d) {
    r.flag('external_clock_reference_indicator');
    r.bits(1, 'reserved', { reserved: true, display: bin(1) });
    const i = r.bits(6, 'clock_accuracy_integer', { desc: 'With the exponent: clock accuracy = integer × 10^−exponent ppm; 0 means the default 30 ppm.' });
    const e = r.bits(3, 'clock_accuracy_exponent');
    r.bits(5, 'reserved', { reserved: true, display: bin(5) });
    const ppm = i ? i * 10 ** -e : 30;
    d.summary = `system clock accuracy ${fmtNum(ppm, 4)} ppm`;
  },
  0x0c(r, d) {
    r.flag('bound_valid_flag');
    r.bits(15, 'LTW_offset_lower_bound');
    r.bits(1, 'reserved', { reserved: true, display: bin(1) });
    r.bits(15, 'LTW_offset_upper_bound');
    d.summary = 'multiplex buffer utilization';
  },
  0x0d(r, d) {
    const v = r.fourcc('copyright_identifier');
    if (r.remaining > 0) r.rest('additional_copyright_info');
    d.summary = `copyright '${v}'`;
  },
  0x0e(r, d) {
    r.bits(2, 'reserved', { reserved: true, display: bin(2) });
    const v = r.bits(22, 'maximum_bitrate', {
      key: true,
      display: (x) => `${fmtInt(x)} × 50 bytes/s = ${fmtBitrate(x * 400)}`,
      desc: 'Upper bound of the bitrate (in units of 50 bytes per second) over the whole program or stream, including transport overhead. Useful to size multiplexes and buffers.',
    });
    d.maxBitrate = v * 400;
    d.summary = `maximum bitrate ${fmtBitrate(v * 400)}`;
  },
  0x0f(r, d) {
    const v = r.fourcc('private_data_indicator');
    d.summary = `private data '${v}'`;
  },
  0x10(r, d) {
    r.bits(2, 'reserved', { reserved: true, display: bin(2) });
    const leak = r.bits(22, 'sb_leak_rate', { display: (x) => `${fmtInt(x)} × 400 b/s = ${fmtBitrate(x * 400)}` });
    r.bits(2, 'reserved', { reserved: true, display: bin(2) });
    const size = r.bits(22, 'sb_size', { unit: 'bytes' });
    d.summary = `smoothing buffer ${fmtInt(size)} bytes at ${fmtBitrate(leak * 400)}`;
  },
  0x11(r, d) {
    r.bits(7, 'reserved', { reserved: true, display: bin(7) });
    r.flag('leak_valid_flag', { desc: '1 = the transport buffer is emptied with the "leak" method of the T-STD model.' });
    d.summary = 'STD buffer model';
  },
  0x12(r, d) {
    r.flag('closed_gop_flag');
    r.flag('identical_gop_flag');
    const n = r.bits(14, 'max_gop_length', { unit: 'pictures' });
    d.summary = `max GOP ${n} pictures`;
  },
  0x1b(r, d) {
    const v = r.u8('MPEG-4_visual_profile_and_level', { display: (x) => hex2(x) });
    d.summary = `MPEG-4 visual profile/level ${hex2(v)}`;
  },
  0x1c(r, d) {
    const v = r.u8('MPEG-4_audio_profile_and_level', { display: (x) => hex2(x) });
    d.summary = `MPEG-4 audio profile/level ${hex2(v)}`;
  },
  0x26(r, d) {
    const app = r.u16('metadata_application_format', { display: (v) => (v === 0xffff ? '0xFFFF (identifier follows)' : `0x${v.toString(16)}`) });
    let id = null;
    if (app === 0xffff) id = r.fourcc('metadata_application_format_identifier');
    const fmt = r.u8('metadata_format', { display: (v) => (v === 0xff ? '0xFF (identifier follows)' : hex2(v)) });
    let fid = null;
    if (fmt === 0xff) fid = r.fourcc('metadata_format_identifier', { key: true, desc: '\'ID3 \' marks ID3 timed metadata (as used by HLS), \'KLVA\' SMPTE KLV.' });
    r.u8('metadata_service_id');
    r.bits(3, 'decoder_config_flags');
    r.flag('DSM-CC_flag');
    r.bits(4, 'reserved', { reserved: true, display: bin(4) });
    d.format = fid ?? id;
    d.summary = `metadata${fid ? ` '${fid}'` : ''}`;
  },
  0x28(r, d) {
    const p = r.u8('profile_idc', { key: true, display: (v) => `${v} — ${AVC_PROFILES[v] ?? 'unknown'}` });
    let compat = 0;
    for (let i = 0; i <= 5; i++) compat |= r.flag(`constraint_set${i}_flag`) << (7 - i);
    r.bits(2, 'AVC_compatible_flags');
    const l = r.u8('level_idc', { key: true, display: (v) => `${v} — level ${avcLevel(v, compat, p)}` });
    r.flag('AVC_still_present', { desc: '1 = the stream may contain AVC still pictures.' });
    r.flag('AVC_24_hour_picture_flag', { desc: '1 = some pictures have presentation times more than 24 hours after their decode time.' });
    r.flag('Frame_Packing_SEI_not_present_flag', { desc: '1 = no frame-packing (stereoscopic 3D) SEI messages are present.' });
    r.bits(5, 'reserved', { reserved: true, display: bin(5) });
    d.avc = { profile: p, level: l, compat };
    d.summary = `AVC ${AVC_PROFILES[p] ?? p}@L${avcLevel(l, compat, p)}`;
  },
  0x2a(r, d) {
    r.flag('hrd_management_valid_flag', { desc: '1 = the buffering period SEI messages drive the T-STD decoder model.' });
    r.bits(6, 'reserved', { reserved: true, display: bin(6) });
    const pt = r.flag('picture_and_timing_info_present');
    if (pt) {
      const k90 = r.flag('90kHz_flag', { desc: '1 = the AVC time base is 90 kHz, otherwise N/K below give the ratio.' });
      r.bits(7, 'reserved', { reserved: true, display: bin(7) });
      if (!k90) {
        r.u32('N');
        r.u32('K');
      }
      r.u32('num_units_in_tick');
    }
    r.flag('fixed_frame_rate_flag');
    r.flag('temporal_poc_flag');
    r.flag('picture_to_display_conversion_flag');
    r.bits(5, 'reserved', { reserved: true, display: bin(5) });
    d.summary = 'AVC timing and HRD';
  },
  0x2b(r, d) {
    r.u8('MPEG-2_AAC_profile', { enum: { 0: 'Main', 1: 'LC', 2: 'SSR' } });
    r.u8('MPEG-2_AAC_channel_configuration');
    r.u8('MPEG-2_AAC_additional_information', { enum: { 0: 'AAC data only', 1: 'AAC + bandwidth extension (SBR)' } });
    d.summary = 'MPEG-2 AAC audio';
  },
  0x38(r, d) {
    const space = r.bits(2, 'profile_space');
    const tier = r.flag('tier_flag', { enum: { 0: 'Main tier', 1: 'High tier' } });
    const p = r.bits(5, 'profile_idc', { key: true, enum: HEVC_PROFILES });
    r.bits(32, 'profile_compatibility_indication', { display: (v) => `0x${v.toString(16).padStart(8, '0')}` });
    r.flag('progressive_source_flag');
    r.flag('interlaced_source_flag');
    r.flag('non_packed_constraint_flag');
    r.flag('frame_only_constraint_flag');
    r.bits(44, 'copied_44bits', { desc: 'The remaining general constraint flags, copied from the SPS profile_tier_level().' });
    const l = r.u8('level_idc', { key: true, display: (v) => `${v} → level ${hevcLevel(v)}` });
    const tl = r.flag('temporal_layer_subset_flag');
    r.flag('HEVC_still_present_flag');
    r.flag('HEVC_24hr_picture_present_flag');
    r.flag('sub_pic_hrd_params_not_present_flag');
    r.bits(2, 'reserved', { reserved: true, display: bin(2) });
    r.bits(2, 'HDR_WCG_idc', { enum: { 0: 'SDR', 1: 'WCG only', 2: 'HDR and WCG', 3: 'no indication' }, desc: 'Newer editions of H.222.0 use these two bits to announce HDR / wide colour gamut content.' });
    if (tl && r.remaining >= 2) {
      r.bits(3, 'temporal_id_min');
      r.bits(5, 'reserved', { reserved: true, display: bin(5) });
      r.bits(3, 'temporal_id_max');
      r.bits(5, 'reserved', { reserved: true, display: bin(5) });
    }
    d.hevc = { profile_space: space, tier, profile: p, level: l };
    d.summary = `HEVC ${HEVC_PROFILES[p] ?? p}@L${hevcLevel(l)}${tier ? ' High' : ''}`;
  },
  0x3f(r, d) {
    const t = r.u8('extension_descriptor_tag', { display: (v) => hex2(v) });
    if (r.remaining > 0) r.rest('extension_data');
    d.summary = `extension ${hex2(t)}`;
  },

  // ---- DVB (EN 300 468)
  0x40(r, d) {
    d.text = dvbRest(r, 'network_name', { key: true });
    d.summary = `network "${d.text}"`;
  },
  0x41(r, d) {
    d.services = [];
    let i = 0;
    while (r.remaining >= 3) {
      r.group(`service[${i++}]`, (g) => {
        const id = r.u16('service_id');
        const t = r.u8('service_type', { enum: SERVICE_TYPES });
        d.services.push({ id, type: t });
        g.display = `service ${id} (${SERVICE_TYPES[t] ?? hex2(t)})`;
      });
    }
    d.summary = `${d.services.length} service${d.services.length === 1 ? '' : 's'}`;
  },
  0x43(r, d) {
    const f = r.u32('frequency', { display: (v) => `${bcdDigits(v, 8, 3)} GHz (BCD)` });
    r.u16('orbital_position', { display: (v) => `${bcdDigits(v, 4, 3)}° (BCD)` });
    r.flag('west_east_flag', { enum: { 0: 'west', 1: 'east' } });
    r.bits(2, 'polarization', { enum: { 0: 'linear horizontal', 1: 'linear vertical', 2: 'circular left', 3: 'circular right' } });
    r.bits(2, 'roll_off');
    r.flag('modulation_system', { enum: { 0: 'DVB-S', 1: 'DVB-S2' } });
    r.bits(2, 'modulation_type', { enum: { 0: 'auto', 1: 'QPSK', 2: '8PSK', 3: '16-QAM' } });
    r.bits(28, 'symbol_rate', { display: (v) => `${bcdDigits(v, 7, 3)} Msymbol/s (BCD)` });
    r.bits(4, 'FEC_inner');
    d.summary = `satellite ${bcdDigits(f, 8, 3)} GHz`;
  },
  0x44(r, d) {
    const f = r.u32('frequency', { display: (v) => `${bcdDigits(v, 8, 4)} MHz (BCD)` });
    r.bits(12, 'reserved_future_use', { reserved: true, display: bin(12) });
    r.bits(4, 'FEC_outer');
    r.u8('modulation', { enum: { 1: '16-QAM', 2: '32-QAM', 3: '64-QAM', 4: '128-QAM', 5: '256-QAM' } });
    r.bits(28, 'symbol_rate', { display: (v) => `${bcdDigits(v, 7, 3)} Msymbol/s (BCD)` });
    r.bits(4, 'FEC_inner');
    d.summary = `cable ${bcdDigits(f, 8, 4)} MHz`;
  },
  0x47(r, d) {
    d.text = dvbRest(r, 'bouquet_name', { key: true });
    d.summary = `bouquet "${d.text}"`;
  },
  0x48(r, d) {
    d.serviceType = r.u8('service_type', {
      key: true,
      display: (v) => `${hex2(v)} — ${SERVICE_TYPES[v] ?? 'reserved / user defined'}`,
      desc: 'What kind of service this is (TV, radio, HD, HEVC...). Receivers use it to sort channel lists.',
    });
    d.provider = dvbString(r, 'service_provider_name_length', 'service_provider_name', { key: true, desc: 'The broadcaster or operator, as shown in channel lists.' });
    d.name = dvbString(r, 'service_name_length', 'service_name', { key: true, desc: 'The channel name shown to viewers.' });
    d.summary = `service "${d.name}" by "${d.provider}"`;
  },
  0x49(r, d) {
    const f = r.flag('country_availability_flag', { enum: { 0: 'not available in', 1: 'available in' } });
    r.bits(7, 'reserved_future_use', { reserved: true, display: bin(7) });
    const cs = [];
    while (r.remaining >= 3) cs.push(lang(r, 'country_code', { desc: 'ISO 3166 alpha-3 country code.' }));
    d.summary = `${f ? 'available in' : 'not available in'} ${cs.join(', ')}`;
  },
  0x4a(r, d) {
    r.u16('transport_stream_id');
    r.u16('original_network_id');
    r.u16('service_id');
    const t = r.u8('linkage_type', { display: (v) => hex2(v) });
    if (r.remaining > 0) r.rest('private_data_byte');
    d.summary = `linkage type ${hex2(t)}`;
  },
  0x4d(r, d) {
    const l = lang(r);
    d.name = dvbString(r, 'event_name_length', 'event_name', { key: true });
    d.text = dvbString(r, 'text_length', 'text');
    d.summary = `"${d.name}" (${l})`;
  },
  0x4e(r, d) {
    r.bits(4, 'descriptor_number');
    r.bits(4, 'last_descriptor_number');
    lang(r);
    const n = r.u8('length_of_items', { unit: 'bytes' });
    if (n) r.bytes('items', Math.min(n, r.remaining));
    d.text = dvbString(r, 'text_length', 'text');
    d.summary = 'extended event text';
  },
  0x50(r, d) {
    r.bits(4, 'stream_content_ext');
    const sc = r.bits(4, 'stream_content', { enum: { 1: 'MPEG-2 video', 2: 'MPEG-1 Layer 2 audio', 3: 'subtitles / teletext', 4: 'AC-3 audio', 5: 'H.264/AVC video', 6: 'HE-AAC audio', 7: 'DTS audio', 9: 'HEVC video / AC-4 / other' } });
    r.u8('component_type', { display: (v) => hex2(v) });
    r.u8('component_tag');
    const l = lang(r);
    d.text = dvbRest(r, 'text');
    d.summary = `component (${sc}) ${l}`;
  },
  0x52(r, d) {
    d.componentTag = r.u8('component_tag', { desc: 'Tag that other tables (EIT component descriptors, DSM-CC carousels) use to refer to this stream.' });
    d.summary = `component tag ${d.componentTag}`;
  },
  0x53(r, d) {
    const ids = [];
    while (r.remaining >= 2) ids.push(r.u16('CA_system_id', { display: (v) => `0x${v.toString(16).toUpperCase()}${caSystemName(v) ? ` — ${caSystemName(v)}` : ''}` }));
    d.summary = `CA systems ${ids.map((v) => `0x${v.toString(16)}`).join(', ')}`;
  },
  0x54(r, d) {
    let i = 0;
    while (r.remaining >= 2) {
      r.group(`content[${i++}]`, () => {
        r.bits(4, 'content_nibble_level_1', { enum: CONTENT_NIBBLES });
        r.bits(4, 'content_nibble_level_2');
        r.u8('user_byte');
      });
    }
    d.summary = 'content genre';
  },
  0x55(r, d) {
    const out = [];
    while (r.remaining >= 4) {
      const c = lang(r, 'country_code', { desc: 'ISO 3166 alpha-3 country code.' });
      const v = r.u8('rating', { display: (x) => (x >= 1 && x <= 0x0f ? `${x} → minimum age ${x + 3}` : `${x} (${x ? 'broadcaster defined' : 'undefined'})`) });
      out.push(`${c}: ${v >= 1 && v <= 15 ? v + 3 : '?'}+`);
    }
    d.summary = `parental rating ${out.join(', ')}`;
  },
  0x56(r, d) {
    d.teletext = [];
    let i = 0;
    while (r.remaining >= 5) {
      r.group(`page[${i++}]`, (g) => {
        const l = lang(r, 'ISO_639_language_code', { key: true });
        const t = r.bits(5, 'teletext_type', { enum: TELETEXT_TYPES });
        const mag = r.bits(3, 'teletext_magazine_number');
        const page = r.u8('teletext_page_number', { display: (v) => `0x${v.toString(16).padStart(2, '0')}` });
        d.teletext.push({ lang: l, type: t });
        g.display = `${l} page ${mag || 8}${page.toString(16).padStart(2, '0')} (${TELETEXT_TYPES[t] ?? t})`;
      });
    }
    d.summary = `teletext ${d.teletext.map((x) => x.lang).join(', ')}`;
  },
  0x58(r, d) {
    let i = 0;
    while (r.remaining >= 13) {
      r.group(`offset[${i++}]`, () => {
        lang(r, 'country_code');
        r.bits(6, 'country_region_id');
        r.bits(1, 'reserved', { reserved: true, display: bin(1) });
        const pol = r.flag('local_time_offset_polarity', { enum: { 0: 'ahead of UTC (+)', 1: 'behind UTC (−)' } });
        r.u16('local_time_offset', { display: (v) => `${pol ? '−' : '+'}${bcdByte(v >> 8)}:${String(bcdByte(v & 0xff)).padStart(2, '0')}` });
        const mjd = r.u16('time_of_change_mjd', { desc: 'Date as a Modified Julian Date.' });
        r.u24('time_of_change_utc', { display: (v) => fmtUtc(mjdTime(mjd, v)) });
        r.u16('next_time_offset', { display: (v) => `${bcdByte(v >> 8)}:${String(bcdByte(v & 0xff)).padStart(2, '0')}` });
      });
    }
    d.summary = 'local time offset';
  },
  0x59(r, d) {
    d.subtitles = [];
    let i = 0;
    while (r.remaining >= 8) {
      r.group(`subtitle[${i++}]`, (g) => {
        const l = lang(r, 'ISO_639_language_code', { key: true });
        const t = r.u8('subtitling_type', { enum: SUBTITLING_TYPES });
        r.u16('composition_page_id', { desc: 'Page of the DVB subtitle stream that carries this language’s subtitles.' });
        r.u16('ancillary_page_id', { desc: 'Page with data shared between languages (e.g. logos).' });
        d.subtitles.push({ lang: l, type: t });
        g.display = `${l} (${SUBTITLING_TYPES[t] ?? hex2(t)})`;
      });
    }
    d.summary = `subtitles ${d.subtitles.map((x) => x.lang).join(', ')}`;
  },
  0x5a(r, d) {
    const f = r.u32('centre_frequency', { display: (v) => `${fmtInt(v)} × 10 Hz = ${fmtNum(v / 1e5, 3)} MHz` });
    r.bits(3, 'bandwidth', { enum: { 0: '8 MHz', 1: '7 MHz', 2: '6 MHz', 3: '5 MHz' } });
    r.flag('priority');
    r.flag('Time_Slicing_indicator');
    r.flag('MPE-FEC_indicator');
    r.bits(2, 'reserved_future_use', { reserved: true, display: bin(2) });
    r.bits(2, 'constellation', { enum: { 0: 'QPSK', 1: '16-QAM', 2: '64-QAM' } });
    r.bits(3, 'hierarchy_information');
    r.bits(3, 'code_rate-HP_stream', { enum: { 0: '1/2', 1: '2/3', 2: '3/4', 3: '5/6', 4: '7/8' } });
    r.bits(3, 'code_rate-LP_stream', { enum: { 0: '1/2', 1: '2/3', 2: '3/4', 3: '5/6', 4: '7/8' } });
    r.bits(2, 'guard_interval', { enum: { 0: '1/32', 1: '1/16', 2: '1/8', 3: '1/4' } });
    r.bits(2, 'transmission_mode', { enum: { 0: '2k', 1: '8k', 2: '4k' } });
    r.flag('other_frequency_flag');
    if (r.remaining >= 4) r.u32('reserved_future_use', { reserved: true });
    d.summary = `terrestrial ${fmtNum(f / 1e5, 3)} MHz`;
  },
  0x5f(r, d) {
    const v = r.u32('private_data_specifier', { display: (x) => `0x${x.toString(16).padStart(8, '0')}`, desc: 'Says whose private descriptors follow (registered in ETSI TS 101 162), so tags 0x80–0xFE can be interpreted.' });
    d.pds = v;
    d.summary = `private data specifier 0x${v.toString(16)}`;
  },
  0x66(r, d) {
    const v = r.u16('data_broadcast_id', { display: (x) => `0x${x.toString(16).padStart(4, '0')}` });
    if (r.remaining > 0) r.rest('id_selector_byte');
    d.summary = `data broadcast 0x${v.toString(16)}`;
  },
  0x6a(r, d) {
    const flags = ac3Flags(r, false);
    ac3Optional(r, flags);
    d.codec = 'ac3';
    d.summary = 'AC-3 (DVB)';
  },
  0x7a(r, d) {
    const flags = ac3Flags(r, true);
    ac3Optional(r, flags);
    d.codec = 'eac3';
    d.summary = 'E-AC-3 (DVB)';
  },
  0x7b(r, d) {
    r.bits(4, 'sample_rate_code', { enum: { 1: '8 kHz', 2: '16 kHz', 3: '32 kHz', 6: '11.025 kHz', 7: '22.05 kHz', 8: '44.1 kHz', 11: '12 kHz', 12: '24 kHz', 13: '48 kHz' } });
    r.bits(6, 'bit_rate_code');
    r.bits(7, 'nblks', { display: (v) => `${v} → ${(v + 1) * 32} samples per frame` });
    r.bits(14, 'fsize', { display: (v) => `${v} → ${v + 1} bytes per frame` });
    r.bits(6, 'surround_mode');
    r.flag('lfe_flag');
    r.bits(2, 'extended_surround_flag');
    d.codec = 'dts';
    d.summary = 'DTS (DVB)';
  },
  0x7c(r, d) {
    r.u8('profile_and_level', { display: (v) => hex2(v), desc: 'MPEG-4 audio profile and level indication (e.g. 0x51 = HE-AAC level 2).' });
    if (r.remaining > 0) {
      const tf = r.flag('AAC_type_flag');
      r.flag('SAOC_DE_flag');
      r.bits(6, 'reserved_zero_future_use', { reserved: true, display: bin(6) });
      if (tf && r.remaining > 0) r.u8('AAC_type', { display: (v) => hex2(v) });
    }
    d.codec = 'aac';
    d.summary = 'AAC (DVB)';
  },
  0x7f(r, d) {
    const t = r.u8('descriptor_tag_extension', { display: (v) => `${hex2(v)} — ${DVB_EXTENSION_TAGS[v] ?? (v >= 0x80 ? 'user defined' : 'reserved / other')}` });
    d.ext = t;
    if (t === 0x15) d.codec = 'ac4';
    if (r.remaining > 0) r.rest('selector_byte');
    d.summary = DVB_EXTENSION_TAGS[t] ?? `extension ${hex2(t)}`;
  },

  // ---- private tags interpreted by context (ATSC / SCTE)
  0x81(r, d, ctx) {
    if (ctx.dvb) return;
    r.bits(3, 'sample_rate_code', { enum: { 0: '48 kHz', 1: '44.1 kHz', 2: '32 kHz' } });
    r.bits(5, 'bsid');
    r.bits(6, 'bit_rate_code');
    r.bits(2, 'surround_mode');
    r.bits(3, 'bsmod');
    r.bits(4, 'num_channels');
    r.flag('full_svc');
    if (r.remaining > 0) r.rest('additional_bytes');
    d.codec = 'ac3';
    d.summary = 'AC-3 audio (ATSC)';
  },
  0x86(r, d, ctx) {
    if (ctx.dvb) return;
    r.bits(3, 'reserved', { reserved: true, display: bin(3) });
    const n = r.bits(5, 'number_of_services');
    for (let i = 0; i < n && r.remaining >= 6; i++) {
      r.group(`service[${i}]`, (g) => {
        const l = lang(r, 'language');
        const digital = r.flag('digital_cc', { enum: { 0: 'CEA-608 (line 21)', 1: 'CEA-708 (digital)' } });
        r.bits(1, 'reserved', { reserved: true, display: bin(1) });
        if (digital) r.bits(6, 'caption_service_number');
        else {
          r.bits(5, 'reserved', { reserved: true, display: bin(5) });
          r.flag('line21_field');
        }
        r.flag('easy_reader');
        r.flag('wide_aspect_ratio');
        r.bits(14, 'reserved', { reserved: true, display: bin(14) });
        g.display = `${l} ${digital ? '708' : '608'}`;
      });
    }
    d.summary = `${n} caption service${n === 1 ? '' : 's'}`;
  },
  0x8a(r, d) {
    const t = r.u8('cue_stream_type', { enum: { 0: 'splice_insert, splice_null, splice_schedule', 1: 'all commands', 2: 'segmentation', 3: 'tiered splicing', 4: 'tiered segmentation' } });
    d.summary = `SCTE-35 cue stream type ${t}`;
  },
};

const CONTENT_NIBBLES = {
  1: 'movie / drama', 2: 'news / current affairs', 3: 'show / game show', 4: 'sports', 5: 'children’s / youth',
  6: 'music / ballet / dance', 7: 'arts / culture', 8: 'social / political / economics', 9: 'education / science',
  10: 'leisure / hobbies', 11: 'special characteristics', 12: 'adult', 15: 'user defined',
};

function mpeg2ProfileLevel(v) {
  if (v & 0x80) return 'escape (special profile, e.g. 4:2:2 or multiview)';
  const p = { 1: 'High', 2: 'Spatially Scalable', 3: 'SNR Scalable', 4: 'Main', 5: 'Simple' }[(v >> 4) & 7] ?? 'reserved';
  const l = { 4: 'High', 6: 'High 1440', 8: 'Main', 10: 'Low' }[v & 15] ?? 'reserved';
  return `${p} profile @ ${l} level`;
}

function bcdDigits(v, digits, intDigits) {
  let s = '';
  for (let i = digits - 1; i >= 0; i--) s += Math.floor(v / 16 ** i) % 16;
  return `${String(Number(s.slice(0, intDigits)))}.${s.slice(intDigits)}`;
}

function ac3Flags(r, enhanced) {
  const f = {};
  f.component_type = r.flag('component_type_flag');
  f.bsid = r.flag('bsid_flag');
  f.mainid = r.flag('mainid_flag');
  f.asvc = r.flag('asvc_flag');
  if (enhanced) {
    r.flag('mixinfoexists', { desc: '1 = the stream carries mixing metadata for audio description.' });
    f.substream1 = r.flag('substream1_flag');
    f.substream2 = r.flag('substream2_flag');
    f.substream3 = r.flag('substream3_flag');
  } else {
    r.bits(4, 'reserved', { reserved: true, display: bin(4) });
  }
  return f;
}

function ac3Optional(r, f) {
  if (f.component_type) r.u8('component_type', { display: ac3ComponentType, desc: 'Service type and channel configuration of the AC-3 stream.' });
  if (f.bsid) r.u8('bsid', { desc: 'Bit stream identification: 8 = AC-3, 16 = E-AC-3.' });
  if (f.mainid) r.u8('mainid', { desc: 'Identifies the main audio service this one belongs to.' });
  if (f.asvc) r.u8('asvc', { desc: 'Associated services.' });
  if (f.substream1) r.u8('substream1');
  if (f.substream2) r.u8('substream2');
  if (f.substream3) r.u8('substream3');
  if (r.remaining > 0) r.rest('additional_info_byte');
}

// ------------------------------------------------------------------ loop

const LOOP_DESC = 'Descriptors: tag-length-value records that attach extra information (language, codec details, registration, bitrate...). A reader skips the tags it does not know by their length.';

/**
 * Read a descriptor loop of `len` bytes into a struct field called `name`.
 * `ctx` = { kind?: 'video'|'audio'|..., dvb?: boolean }. Returns the parsed descriptors.
 */
export function readDescriptors(r, len, ctx = {}, name = 'descriptors') {
  const list = [];
  if (len <= 0) return list;
  // Private tags (0x80–0xFE) follow DVB rules once a private_data_specifier has been seen;
  // otherwise the ATSC/SCTE meaning is the common one.
  const local = { ...ctx };
  r.group(name, (g) => {
    r.bounded(len, () => {
      while (r.remaining >= 2) {
        const tag = r.u[r.pos];
        const dlen = r.u[r.pos + 1];
        const d = { tag, length: dlen, name: descriptorName(tag) };
        list.push(d);
        r.group(d.name, (dg) => {
          r.u8('descriptor_tag', { display: (v) => `${hex2(v)} — ${d.name}` });
          r.u8('descriptor_length', { unit: 'bytes' });
          if (dlen > r.remaining) d.truncated = true;
          r.bounded(dlen, () => {
            const body = BODIES[tag];
            if (body) {
              try {
                body(r, d, local);
              } catch (e) {
                if (!(e instanceof ParseError)) throw e;
                d.error = e.message;
              }
            }
            if (r.bit) r.align('padding');
            if (r.remaining > 0) r.rest(body && d.summary ? 'additional_bytes' : 'descriptor_data', { desc: body ? 'Bytes after the fields decoded above.' : 'This descriptor is not decoded by Vidscope.' });
          });
          dg.display = d.summary ?? d.name;
        });
        if (tag === 0x5f) local.dvb = true;
      }
      if (r.remaining > 0) r.rest('trailing_byte', { desc: 'Too short to be a descriptor.' });
    });
    g.display = list.length ? list.map((d) => d.summary ?? d.name).join('; ') : '(none)';
  }, { desc: LOOP_DESC });
  return list;
}

/** Find the first descriptor with this tag. */
export function findDescriptor(list, tag) {
  return list?.find((d) => d.tag === tag) ?? null;
}

