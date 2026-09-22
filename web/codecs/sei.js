// SEI (supplemental enhancement information) messages shared by H.264 and H.265.

import { ParseError } from '../core/fields.js';
import { moreRbspData } from './nal.js';
import { decodeText, fmtNum } from '../core/util.js';

export const SEI_TYPES_AVC = {
  0: 'buffering_period', 1: 'pic_timing', 2: 'pan_scan_rect', 3: 'filler_payload',
  4: 'user_data_registered_itu_t_t35', 5: 'user_data_unregistered', 6: 'recovery_point',
  7: 'dec_ref_pic_marking_repetition', 8: 'spare_pic', 9: 'scene_info', 10: 'sub_seq_info',
  11: 'sub_seq_layer_characteristics', 12: 'sub_seq_characteristics', 13: 'full_frame_freeze',
  14: 'full_frame_freeze_release', 15: 'full_frame_snapshot', 16: 'progressive_refinement_segment_start',
  17: 'progressive_refinement_segment_end', 18: 'motion_constrained_slice_group_set',
  19: 'film_grain_characteristics', 20: 'deblocking_filter_display_preference', 21: 'stereo_video_info',
  22: 'post_filter_hint', 23: 'tone_mapping_info', 45: 'frame_packing_arrangement',
  47: 'display_orientation', 137: 'mastering_display_colour_volume', 144: 'content_light_level_info',
  147: 'alternative_transfer_characteristics', 148: 'ambient_viewing_environment',
};

export const SEI_TYPES_HEVC = {
  0: 'buffering_period', 1: 'pic_timing', 2: 'pan_scan_rect', 3: 'filler_payload',
  4: 'user_data_registered_itu_t_t35', 5: 'user_data_unregistered', 6: 'recovery_point',
  9: 'scene_info', 15: 'picture_snapshot', 16: 'progressive_refinement_segment_start',
  17: 'progressive_refinement_segment_end', 19: 'film_grain_characteristics', 22: 'post_filter_hint',
  23: 'tone_mapping_info', 45: 'frame_packing_arrangement', 47: 'display_orientation', 56: 'green_metadata',
  128: 'structure_of_pictures_info', 129: 'active_parameter_sets', 130: 'decoding_unit_info',
  131: 'temporal_sub_layer_zero_index', 132: 'decoded_picture_hash', 133: 'scalable_nesting',
  134: 'region_refresh_info', 135: 'no_display', 136: 'time_code', 137: 'mastering_display_colour_volume',
  138: 'segmented_rect_frame_packing_arrangement', 139: 'temporal_motion_constrained_tile_sets',
  140: 'chroma_resampling_filter_hint', 141: 'knee_function_info', 142: 'colour_remapping_info',
  143: 'deinterlaced_field_identification', 144: 'content_light_level_info',
  145: 'dependent_rap_indication', 146: 'coded_region_completion', 147: 'alternative_transfer_characteristics',
  148: 'ambient_viewing_environment', 149: 'content_colour_volume',
};

const KNOWN_UUIDS = {
  'dc45e9bd-e6d9-48b7-962c-d820d923eeef': 'x264 encoder settings',
  '2ca2de09-b517-47db-bb55-a4fe7fc2fc4e': 'x265 encoder settings',
  '17ee8c60-f84d-11d9-8cd6-0800200c9a66': 'MainConcept encoder info',
  '47564adc-5c4c-433f-94ef-c5113cd143a8': 'Apple / VideoToolbox',
  'b49ffcba-cec3-4f13-b8ed-fb8bbdeee4de': 'NVIDIA encoder info',
};

const T35_COUNTRY = { 0xb5: 'United States', 0x26: 'China', 0x00: 'Japan', 0xb4: 'United Kingdom' };
const T35_PROVIDER = { 0x0031: 'ATSC', 0x002f: 'DirecTV', 0x003c: 'Samsung (HDR10+)', 0x003b: 'Dolby', 0x0004: 'Dolby (Vision metadata)' };

/** Read one ff-escaped SEI number (payloadType or payloadSize) as a single field. */
function seiNumber(r, name, o) {
  const start = r.pos;
  let v = 0;
  for (;;) {
    r.need(1, name);
    const b = r.u[r.pos++];
    v += b;
    if (b !== 0xff) break;
  }
  r.record(name, 'sei(v)', start, r.pos - start, v, o);
  return v;
}

/**
 * Parse sei_rbsp(): a list of sei_message()s. Returns [{type, name, size}].
 * `hevc` switches the payload-type name table and the recovery_point syntax.
 */
export function parseSeiRbsp(r, hevc = false) {
  const names = hevc ? SEI_TYPES_HEVC : SEI_TYPES_AVC;
  const messages = [];
  let i = 0;
  while (moreRbspData(r) && i < 256) {
    const msg = {};
    r.group(`sei_message[${i}]`, (g) => {
      msg.type = seiNumber(r, 'payloadType', {
        enum: names,
        key: true,
        desc: 'Which kind of SEI message follows. Values of 255 or more are written as a run of 0xFF bytes plus a final byte.',
      });
      msg.name = names[msg.type] ?? `payload type ${msg.type}`;
      msg.size = seiNumber(r, 'payloadSize', { unit: 'bytes', desc: 'Length of this message’s payload.' });
      g.display = msg.name;
      r.bounded(msg.size, () => {
        try {
          seiPayload(r, msg, hevc);
        } catch (e) {
          if (!(e instanceof ParseError)) throw e;
          msg.error = e.message;
        }
        if (r.remaining > 0) r.rest('payload_remainder', { desc: 'Payload bytes not decoded here.' });
      });
    });
    messages.push(msg);
    i++;
  }
  return messages;
}

function seiPayload(r, msg, hevc) {
  switch (msg.type) {
    case 5: {
      const uuid = r.uuid('uuid_iso_iec_11578', {
        display: (v) => (KNOWN_UUIDS[v] ? `${v} — ${KNOWN_UUIDS[v]}` : v),
        desc: 'A UUID that says who wrote this private data. Encoders use it to leave their name and settings in the stream.',
      });
      msg.uuid = uuid;
      const data = r.u.subarray(r.pos, r.end);
      let n = data.length;
      while (n > 0 && data[n - 1] === 0) n--;
      const printable = n > 0 && data.subarray(0, n).every((b) => b === 9 || b === 10 || b === 13 || (b >= 0x20 && b < 0x7f));
      if (printable) {
        msg.text = decodeText(data.subarray(0, n));
        r.str('user_data_payload', data.length, {
          key: true,
          display: msg.text.length > 160 ? `"${msg.text.slice(0, 160)}…"` : `"${msg.text}"`,
          desc: 'Free-form text from the encoder. x264 writes its version and every option it was run with here.',
        });
      } else if (data.length) {
        r.rest('user_data_payload', { desc: 'Private binary data.' });
      }
      msg.summary = KNOWN_UUIDS[uuid] ?? 'private data';
      break;
    }
    case 6: {
      if (hevc) {
        const poc = r.se('recovery_poc_cnt', { desc: 'How many pictures (in output order) after this one the decoder needs before the picture is fully correct again.' });
        r.flag('exact_match_flag', { desc: 'Whether decoding from here reproduces the pictures exactly.' });
        r.flag('broken_link_flag', { desc: 'Set when pictures near this point may show artefacts because of an edit.' });
        msg.summary = `recover after ${poc} pictures`;
      } else {
        const cnt = r.ue('recovery_frame_cnt', { desc: 'Frames to decode after this point before output is correct. 0 means this is a clean random-access point even without an IDR.' });
        r.flag('exact_match_flag', { desc: 'Whether decoding from here reproduces the pictures exactly.' });
        r.flag('broken_link_flag', { desc: 'Set when pictures near this point may show artefacts because of an edit.' });
        r.bits(2, 'changing_slice_group_idc');
        msg.summary = `recover after ${cnt} frames`;
      }
      break;
    }
    case 4: {
      const country = r.u8('itu_t_t35_country_code', { enum: T35_COUNTRY, desc: 'ITU-T T.35 country of the organisation defining the data.' });
      if (country === 0xff) r.u8('itu_t_t35_country_code_extension_byte');
      const provider = r.u16('itu_t_t35_provider_code', { display: (v) => `0x${v.toString(16).padStart(4, '0')}${T35_PROVIDER[v] ? ` — ${T35_PROVIDER[v]}` : ''}` });
      msg.summary = T35_PROVIDER[provider] ?? 'registered user data';
      if (provider === 0x0031 && r.remaining >= 5) {
        const ident = r.fourcc('user_identifier', { desc: "'GA94' marks ATSC A/53 data, usually closed captions (CEA-608/708)." });
        if (ident === 'GA94') {
          const code = r.u8('user_data_type_code', { enum: { 3: 'cc_data (closed captions)', 6: 'bar_data' } });
          if (code === 3) {
            r.flag('process_em_data_flag');
            r.flag('process_cc_data_flag');
            r.flag('additional_data_flag');
            const count = r.bits(5, 'cc_count', { desc: 'Number of 3-byte caption packets that follow.' });
            r.u8('em_data', { reserved: true });
            r.table('cc_data', count, 3, [
              { name: 'marker_bits', type: 'bits', size: 1, bits: [0, 5] },
              { name: 'cc_valid', type: 'bits', size: 1, bits: [5, 1] },
              { name: 'cc_type', type: 'bits', size: 1, bits: [6, 2], last: true, enum: { 0: 'NTSC field 1 (CEA-608)', 1: 'NTSC field 2', 2: 'DTVCC data', 3: 'DTVCC start' } },
              { name: 'cc_data_1', type: 'u8' },
              { name: 'cc_data_2', type: 'u8' },
            ], { desc: 'Caption byte pairs; CEA-608 bytes carry 7 data bits plus odd parity.' });
            msg.summary = `closed captions (${count} packets)`;
          }
        }
      } else if (provider === 0x003c) {
        msg.summary = 'HDR10+ dynamic metadata (SMPTE ST 2094-40)';
      }
      break;
    }
    case 137: {
      const names = ['G', 'B', 'R'];
      for (let c = 0; c < 3; c++) {
        r.u16(`display_primaries_x[${c}]`, { display: (v) => `${v} → x=${fmtNum(v * 0.00002, 4)} (${names[c]})` });
        r.u16(`display_primaries_y[${c}]`, { display: (v) => `${v} → y=${fmtNum(v * 0.00002, 4)} (${names[c]})` });
      }
      r.u16('white_point_x', { display: (v) => `${v} → x=${fmtNum(v * 0.00002, 4)}` });
      r.u16('white_point_y', { display: (v) => `${v} → y=${fmtNum(v * 0.00002, 4)}` });
      const max = r.u32('max_display_mastering_luminance', { key: true, display: (v) => `${v} → ${fmtNum(v * 0.0001, 4)} cd/m²` });
      const min = r.u32('min_display_mastering_luminance', { display: (v) => `${v} → ${fmtNum(v * 0.0001, 4)} cd/m²` });
      msg.summary = `mastering display ${fmtNum(min * 0.0001, 4)}–${fmtNum(max * 0.0001, 0)} cd/m²`;
      break;
    }
    case 144: {
      const cll = r.u16('max_content_light_level', { key: true, unit: 'cd/m²', desc: 'MaxCLL: the brightest pixel in the whole stream.' });
      const fall = r.u16('max_pic_average_light_level', { unit: 'cd/m²', desc: 'MaxFALL: the brightest frame on average.' });
      msg.summary = `MaxCLL ${cll}, MaxFALL ${fall}`;
      break;
    }
    case 147:
      r.u8('preferred_transfer_characteristics', { desc: 'Transfer function to prefer over the one in the VUI (used by HLG streams that signal BT.2020 for compatibility).' });
      break;
    default:
      break;
  }
}
