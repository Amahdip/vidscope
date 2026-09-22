// PSI / SI sections: PAT, CAT, PMT (ISO/IEC 13818-1 § 2.4.4), the DVB tables
// NIT, SDT, BAT, EIT, TDT, TOT (ETSI EN 300 468 § 5.2) and SCTE-35 splice_info.
// A section can be read from the bytes of one packet (fields are then recorded
// up to the packet end) or from a section reassembled across packets.

import { ParseError } from '../../core/fields.js';
import {
  hex2, hexPid, tableIdInfo, streamTypeInfo, SERVICE_TYPES, RUNNING_STATUS, SPLICE_COMMANDS, SPLICE_DESCRIPTORS,
} from './tables.js';
import { bin } from './tables.js';
import { readDescriptors } from './descriptors.js';
import { mjdTime, fmtUtc, bcdDuration, fmtTs, tsNote } from './text.js';
import { fmtDuration } from '../../core/util.js';

// ------------------------------------------------------------------ CRC-32

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i << 24;
    for (let k = 0; k < 8; k++) c = c & 0x80000000 ? (c << 1) ^ 0x04c11db7 : c << 1;
    t[i] = c >>> 0;
  }
  return t;
})();

/** CRC-32/MPEG-2 (polynomial 0x04C11DB7, initial value 0xFFFFFFFF, no reflection, no final XOR). */
export function crc32(u8, start = 0, end = u8.length) {
  let crc = 0xffffffff;
  for (let i = start; i < end; i++) crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ u8[i]) & 0xff]) >>> 0;
  return crc >>> 0;
}

// ------------------------------------------------------------------ helpers

const hex32 = (v) => `0x${(v >>> 0).toString(16).toUpperCase().padStart(8, '0')}`;

/** The absolute end of the last recorded leaf field (to cover the rest after a truncation). */
function lastFieldEnd(list, fallback) {
  let end = fallback;
  const visit = (fs) => {
    for (const f of fs) {
      if (f.children && f.children.length) visit(f.children);
      else if (f.size > 0 && f.offset + f.size > end) end = f.offset + f.size;
    }
  };
  visit(list);
  return end;
}

const EXT_NAMES = {
  0x00: ['transport_stream_id', 'Identifies this transport stream within the network (chosen by the operator).'],
  0x01: ['reserved', 'Not used in the CAT.'],
  0x02: ['program_number', 'Which program (service) this PMT describes; matches an entry of the PAT.'],
  0x40: ['network_id', 'Identifies the delivery network (satellite, cable or terrestrial operator).'],
  0x41: ['network_id', 'Identifies the delivery network described.'],
  0x42: ['transport_stream_id', 'The transport stream whose services are listed.'],
  0x46: ['transport_stream_id', 'The transport stream whose services are listed.'],
  0x4a: ['bouquet_id', 'Identifies the bouquet (a commercial package of services).'],
};

function extName(tableId) {
  if (EXT_NAMES[tableId]) return EXT_NAMES[tableId];
  if (tableId >= 0x4e && tableId <= 0x6f) return ['service_id', 'The service (program_number) whose events are listed.'];
  return ['table_id_extension', 'Table-specific identifier.'];
}

const VERSION_DESC = 'Incremented (modulo 32) every time the table changes. Receivers compare it with the version they already have and only re-parse the table when it differs, so forgetting to bump it hides changes from set-top boxes.';

// ------------------------------------------------------------------ section

/**
 * Read one section starting at r.pos (table_id). Fields are recorded in r.out.
 * `ctx` = { hdmv?, dvb? } interpretation hints. Returns an info object:
 * { tableId, short, name, length, start, end, complete, crcOk, crc, ... table data }.
 */
export function readSection(r, ctx = {}) {
  const startLocal = r.pos;
  const info = { start: r.absAt(startLocal) };
  const tableId = r.u8('table_id', {
    key: true,
    role: 'header',
    display: (v) => `${hex2(v)} — ${tableIdInfo(v).short} (${tableIdInfo(v).name})`,
    desc: 'Which table this section belongs to. A PID can carry several tables (PID 0x0011 carries both SDT and BAT), so the table_id, not the PID, identifies the content.',
  });
  const ti = tableIdInfo(tableId);
  info.tableId = tableId;
  info.short = ti.short;
  info.name = ti.name;
  if (tableId === 0xff) {
    info.stuffing = true;
    return info;
  }
  const ssi = r.flag('section_syntax_indicator', {
    role: 'header',
    desc: '1 = the long section format: after section_length come an identifier, version_number, current_next_indicator, section numbers, and a CRC_32 at the end.',
  });
  r.flag(tableId <= 0x03 ? "'0'" : 'private_indicator', { role: 'header', display: tableId <= 0x03 ? bin(1) : undefined, desc: tableId <= 0x03 ? 'Always 0 in PAT, CAT and PMT sections.' : 'For private and DVB tables: reserved_future_use / private_indicator.' });
  r.bits(2, 'reserved', { reserved: true, display: bin(2), role: 'header' });
  const len = r.bits(12, 'section_length', {
    key: true,
    role: 'header',
    unit: 'bytes',
    desc: 'Number of bytes that follow this field, CRC_32 included. PSI sections are limited to 1021 bytes (so a section is at most 1024 bytes); private sections may be up to 4093.',
  });
  info.length = len;
  const endLocal = r.pos + len;
  info.end = r.absAt(startLocal) + 3 + len;
  info.complete = endLocal <= r.end;
  info.ssi = ssi;
  // CRC: long sections, TOT and SCTE-35 end with a CRC_32.
  const hasCrc = ssi || tableId === 0x73 || tableId === 0xfc;
  const bodyEnd = hasCrc ? endLocal - 4 : endLocal;
  const savedEnd = r.end;
  r.end = Math.min(r.end, endLocal);
  try {
    if (ssi) {
      const [en, ed] = extName(tableId);
      info.ext = r.u16(en, { key: tableId === 0x02, role: 'header', desc: ed });
      r.bits(2, 'reserved', { reserved: true, display: bin(2), role: 'header' });
      info.version = r.bits(5, 'version_number', { key: true, role: 'header', desc: VERSION_DESC });
      info.current = r.flag('current_next_indicator', {
        role: 'header',
        enum: { 0: 'next (not valid yet)', 1: 'current (applies now)' },
        desc: '1 = this table applies now; 0 = it is sent in advance and becomes valid with the next version.',
      });
      info.sectionNumber = r.u8('section_number', { role: 'header', desc: 'Number of this section: a big table is split into several sections, numbered from 0.' });
      info.lastSectionNumber = r.u8('last_section_number', { role: 'header', desc: 'Number of the last section of this table, so a receiver knows when it has all of them.' });
    }
    const body = BODIES[tableId] ?? (tableId >= 0x4e && tableId <= 0x6f ? eitBody : null);
    if (body) body(r, info, bodyEnd, ctx);
    else if (r.pos < bodyEnd) r.bytes('section_data', bodyEnd - r.pos, { desc: 'Table content that Vidscope does not decode.' });
    if (r.pos < bodyEnd) r.bytes('unparsed', bodyEnd - r.pos, { desc: 'Bytes before the CRC that the table syntax does not account for.' });
    if (hasCrc && info.complete && len >= 4) {
      const check = crc32(r.u, startLocal, endLocal);
      info.crc = (r.u[endLocal - 4] * 2 ** 24) + (r.u[endLocal - 3] << 16 | r.u[endLocal - 2] << 8 | r.u[endLocal - 1]);
      info.crcOk = check === 0;
    }
    if (hasCrc && info.complete && endLocal - 4 >= r.pos) {
      r.pos = endLocal - 4;
      const stored = r.u32('CRC_32', {
        key: true,
        display: (v) => hex32(v),
        desc: 'CRC-32/MPEG-2 over the whole section. Receivers discard sections whose CRC fails, so a bad CRC means the table is effectively missing (TR 101 290 CRC_error).',
      });
      const f = r.out[r.out.length - 1];
      if (info.crcOk) f.display = `${hex32(stored)} ✓ matches the section`;
      else {
        const expect = crc32(r.u, startLocal, endLocal - 4);
        f.display = `${hex32(stored)} ✗ wrong (computed ${hex32(expect)})`;
        f.mismatch = true;
      }
    }
  } catch (e) {
    if (!(e instanceof ParseError)) throw e;
    info.error = e.message;
  } finally {
    r.end = savedEnd;
  }
  // Structs cut short by the end of the packet say so.
  if (!info.complete) markOpen(r.out);
  // Whatever of the section is in this buffer but not decoded (the section continues elsewhere).
  const availEnd = Math.min(endLocal, r.end);
  const coveredAbs = lastFieldEnd(r.out, r.absAt(startLocal));
  const coveredLocal = startLocal + (coveredAbs - r.absAt(startLocal));
  if (!info.complete && coveredLocal < availEnd) {
    r.bit = 0;
    r.pos = coveredLocal;
    r.bytes('section_data (continued in a later packet)', availEnd - coveredLocal, {
      desc: 'The rest of this section does not fit in this packet; it continues in the next packet of the same PID (after the next packet’s 4-byte header, without a pointer_field if no new section starts there).',
    });
  }
  r.bit = 0;
  r.pos = availEnd;
  if (!info.complete) info.truncated = true;
  return info;
}

/** Give the innermost unfinished structs (no display yet) a note that they continue elsewhere. */
function markOpen(list) {
  const last = list[list.length - 1];
  if (!last || last.type !== 'struct') return;
  if (!last.display) last.display = '… (continues in the next packet)';
  if (last.children) markOpen(last.children);
}

// ------------------------------------------------------------------ table bodies

function patBody(r, info, end) {
  info.programs = [];
  let i = 0;
  while (r.pos + 4 <= end) {
    r.group(`program[${i++}]`, (g) => {
      const num = r.u16('program_number', {
        key: true,
        display: (v) => (v === 0 ? '0 (network: the PID below carries the NIT)' : String(v)),
        desc: 'The program (called a service in DVB) this entry describes. 0 is special: its PID is the network PID where the NIT is sent.',
      });
      r.bits(3, 'reserved', { reserved: true, display: bin(3) });
      const pid = r.bits(13, num === 0 ? 'network_PID' : 'program_map_PID', {
        key: true,
        display: (v) => `${hexPid(v)} (${v})`,
        desc: num === 0 ? 'PID of the Network Information Table.' : 'The PID on which this program’s PMT is sent. A decoder reads it next to learn which PIDs carry the program’s audio and video.',
      });
      info.programs.push({ number: num, pid });
      g.display = num === 0 ? `NIT on ${hexPid(pid)}` : `program ${num} → PMT on ${hexPid(pid)}`;
    });
  }
  info.summary = `${info.programs.filter((p) => p.number).length} program${info.programs.filter((p) => p.number).length === 1 ? '' : 's'}${info.programs.length ? `: ${info.programs.map((p) => (p.number ? `${p.number} → ${hexPid(p.pid)}` : `NIT ${hexPid(p.pid)}`)).join(', ')}` : ''}`;
}

function catBody(r, info, end) {
  info.descriptors = readDescriptors(r, end - r.pos, {}, 'descriptors');
  const ca = info.descriptors.filter((d) => d.tag === 0x09);
  info.summary = ca.length ? ca.map((d) => d.summary).join('; ') : 'no CA descriptors';
}

function pmtBody(r, info, end, ctx) {
  info.program = info.ext;
  r.bits(3, 'reserved', { reserved: true, display: bin(3) });
  info.pcrPid = r.bits(13, 'PCR_PID', {
    key: true,
    display: (v) => (v === 0x1fff ? '0x1FFF (no PCR for this program)' : `${hexPid(v)} (${v})`),
    desc: 'The PID whose adaptation fields carry this program’s PCR, the clock reference every PTS and DTS of the program is measured against. Usually the video PID, sometimes a dedicated PID.',
  });
  r.bits(4, 'reserved', { reserved: true, display: bin(4) });
  const pil = r.bits(12, 'program_info_length', { unit: 'bytes', desc: 'Length of the program-level descriptors that follow.' });
  info.descriptors = readDescriptors(r, pil, ctx, 'program_info descriptors');
  const hdmv = ctx.hdmv || info.descriptors.some((d) => d.tag === 0x05 && d.format === 'HDMV');
  info.hdmv = hdmv;
  info.streams = [];
  let i = 0;
  while (r.pos + 5 <= end) {
    r.group(`elementary_stream[${i++}]`, (g) => {
      const type = r.u8('stream_type', {
        key: true,
        display: (v) => `${hex2(v)} — ${streamTypeInfo(v, hdmv).name}`,
        desc: 'The coding format of this elementary stream (ISO/IEC 13818-1 Table 2-34). Values from 0x80 are user private: their meaning depends on the system (ATSC, Blu-ray, HLS). 0x06 means "private data": the real codec is then given by a descriptor (AC-3, E-AC-3, DTS, subtitles, teletext, registration...).',
      });
      r.bits(3, 'reserved', { reserved: true, display: bin(3) });
      const pid = r.bits(13, 'elementary_PID', {
        key: true,
        display: (v) => `${hexPid(v)} (${v})`,
        desc: 'The PID of the transport packets that carry this stream.',
      });
      r.bits(4, 'reserved', { reserved: true, display: bin(4) });
      const esl = r.bits(12, 'ES_info_length', { unit: 'bytes', desc: 'Length of this stream’s descriptors.' });
      const kind = streamTypeInfo(type, hdmv).kind;
      const descriptors = readDescriptors(r, esl, { ...ctx, kind }, 'ES_info descriptors');
      info.streams.push({ type, pid, descriptors });
      const langs = descriptors.find((d) => d.tag === 0x0a)?.langs?.map((l) => l.code) ?? [];
      g.display = `${hexPid(pid)}: ${streamTypeInfo(type, hdmv).name}${langs.length ? ` [${langs.join(', ')}]` : ''}`;
    });
  }
  info.summary = `program ${info.program}: ${info.streams.length} stream${info.streams.length === 1 ? '' : 's'}, PCR on ${info.pcrPid === 0x1fff ? 'none' : hexPid(info.pcrPid)}`;
}

function sdtBody(r, info, end, ctx) {
  info.tsid = info.ext;
  info.onid = r.u16('original_network_id', { desc: 'Identifies the network that originally created the services (with transport_stream_id and service_id it forms a DVB triplet that uniquely names a service).' });
  r.u8('reserved_future_use', { reserved: true });
  info.services = [];
  let i = 0;
  while (r.pos + 5 <= end) {
    r.group(`service[${i++}]`, (g) => {
      const s = {};
      s.id = r.u16('service_id', { key: true, desc: 'The service: equal to the program_number of the program in the PAT/PMT.' });
      r.bits(6, 'reserved_future_use', { reserved: true, display: bin(6) });
      s.eitSchedule = r.flag('EIT_schedule_flag', { desc: '1 = EIT schedule (the multi-day programme guide) for this service is present in this TS.' });
      s.eitPf = r.flag('EIT_present_following_flag', { desc: '1 = EIT present/following (now and next) is present in this TS.' });
      s.running = r.bits(3, 'running_status', { enum: RUNNING_STATUS });
      s.freeCA = r.flag('free_CA_mode', { enum: { 0: 'all components in the clear', 1: 'one or more components may be scrambled' } });
      const dl = r.bits(12, 'descriptors_loop_length', { unit: 'bytes' });
      s.descriptors = readDescriptors(r, dl, { ...ctx, dvb: true }, 'descriptors');
      const sd = s.descriptors.find((d) => d.tag === 0x48);
      if (sd) {
        s.name = sd.name;
        s.provider = sd.provider;
        s.type = sd.serviceType;
      }
      info.services.push(s);
      g.display = `service ${s.id}${s.name !== undefined ? `: "${s.name}"${s.provider ? ` by "${s.provider}"` : ''}` : ''}${s.type !== undefined ? ` (${SERVICE_TYPES[s.type] ?? hex2(s.type)})` : ''}`;
    });
  }
  info.summary = info.services.map((s) => `${s.id}${s.name ? ` "${s.name}"` : ''}`).join(', ') || 'no services';
}

function nitBody(r, info, end, ctx) {
  const bouquet = info.tableId === 0x4a;
  r.bits(4, 'reserved_future_use', { reserved: true, display: bin(4) });
  const nl = r.bits(12, bouquet ? 'bouquet_descriptors_length' : 'network_descriptors_length', { unit: 'bytes' });
  info.descriptors = readDescriptors(r, nl, { ...ctx, dvb: true }, bouquet ? 'bouquet descriptors' : 'network descriptors');
  r.bits(4, 'reserved_future_use', { reserved: true, display: bin(4) });
  const tl = r.bits(12, 'transport_stream_loop_length', { unit: 'bytes' });
  const stop = Math.min(end, r.pos + tl);
  info.transportStreams = [];
  let i = 0;
  while (r.pos + 6 <= stop) {
    r.group(`transport_stream[${i++}]`, (g) => {
      const tsid = r.u16('transport_stream_id');
      const onid = r.u16('original_network_id');
      r.bits(4, 'reserved_future_use', { reserved: true, display: bin(4) });
      const dl = r.bits(12, 'transport_descriptors_length', { unit: 'bytes' });
      readDescriptors(r, dl, { ...ctx, dvb: true }, 'transport descriptors');
      info.transportStreams.push({ tsid, onid });
      g.display = `TS ${tsid} on network ${onid}`;
    });
  }
  const name = info.descriptors.find((d) => d.tag === (bouquet ? 0x47 : 0x40))?.text;
  info.networkName = name;
  info.summary = `${bouquet ? 'bouquet' : 'network'} ${info.ext}${name ? ` "${name}"` : ''}, ${info.transportStreams.length} transport stream${info.transportStreams.length === 1 ? '' : 's'}`;
}

function eitBody(r, info, end, ctx) {
  info.serviceId = info.ext;
  info.tsid = r.u16('transport_stream_id');
  info.onid = r.u16('original_network_id');
  r.u8('segment_last_section_number');
  r.u8('last_table_id', { display: (v) => hex2(v) });
  info.events = [];
  let i = 0;
  while (r.pos + 12 <= end) {
    r.group(`event[${i++}]`, (g) => {
      const ev = {};
      ev.id = r.u16('event_id');
      const mjd = r.u16('start_time_mjd', { desc: 'Start date as a Modified Julian Date (days since 17 November 1858).' });
      const t = r.u24('start_time_utc', { display: (v) => fmtUtc(mjdTime(mjd, v)), desc: 'Start time in UTC as six BCD digits hhmmss.' });
      ev.start = mjdTime(mjd, t);
      ev.duration = bcdDuration(r.u24('duration', { display: (v) => fmtDuration(bcdDuration(v), false), desc: 'Duration as six BCD digits hhmmss.' }));
      ev.running = r.bits(3, 'running_status', { enum: RUNNING_STATUS });
      r.flag('free_CA_mode');
      const dl = r.bits(12, 'descriptors_loop_length', { unit: 'bytes' });
      const ds = readDescriptors(r, dl, { ...ctx, dvb: true }, 'descriptors');
      ev.name = ds.find((d) => d.tag === 0x4d)?.name;
      info.events.push(ev);
      g.display = `${ev.name ? `"${ev.name}" ` : ''}${ev.start ? fmtUtc(ev.start) : ''} (${fmtDuration(ev.duration, false)})`;
    });
  }
  info.summary = `service ${info.serviceId}: ${info.events.map((e) => (e.name ? `"${e.name}"` : `event ${e.id}`)).join(', ') || 'no events'}`;
}

function tdtBody(r, info) {
  const mjd = r.u16('UTC_time_mjd', { key: true, desc: 'Date as a Modified Julian Date.' });
  const t = r.u24('UTC_time', { key: true, display: (v) => fmtUtc(mjdTime(mjd, v)), desc: 'Current UTC time (BCD hhmmss) at the moment the section was sent: receivers set their clock from it.' });
  info.utc = mjdTime(mjd, t);
  info.summary = fmtUtc(info.utc);
}

function totBody(r, info, end, ctx) {
  tdtBody(r, info);
  r.bits(4, 'reserved', { reserved: true, display: bin(4) });
  const dl = r.bits(12, 'descriptors_loop_length', { unit: 'bytes' });
  info.descriptors = readDescriptors(r, Math.min(dl, end - r.pos), { ...ctx, dvb: true }, 'descriptors');
}

function spliceTime(r, name = 'splice_time') {
  let t = null;
  r.group(name, (g) => {
    const spec = r.flag('time_specified_flag', { desc: '1 = a PTS time follows; 0 = "immediately" / unspecified.' });
    if (spec) {
      r.bits(6, 'reserved', { reserved: true, display: bin(6) });
      t = r.bits(33, 'pts_time', { key: true, display: fmtTs, note: undefined, desc: 'The splice time as a 33-bit 90 kHz value (add pts_adjustment to get the PTS in the stream).' });
      g.display = fmtTs(t);
    } else {
      r.bits(7, 'reserved', { reserved: true, display: bin(7) });
      g.display = 'not specified';
    }
  });
  return t;
}

function scte35Body(r, info, end) {
  r.u8('protocol_version', { expect: 0 });
  const enc = r.flag('encrypted_packet', { desc: '1 = the splice command and descriptors are encrypted.' });
  r.bits(6, 'encryption_algorithm');
  info.ptsAdjustment = r.bits(33, 'pts_adjustment', { display: fmtTs, desc: 'Offset added to every pts_time in this message (lets a splicer re-time cues without rewriting them).' });
  r.u8('cw_index');
  r.bits(12, 'tier', { display: (v) => `0x${v.toString(16)}` });
  const cl = r.bits(12, 'splice_command_length', { unit: 'bytes' });
  const type = r.u8('splice_command_type', { key: true, enum: SPLICE_COMMANDS });
  info.command = type;
  info.commandName = SPLICE_COMMANDS[type] ?? `command ${hex2(type)}`;
  if (enc) {
    if (r.pos < end) r.bytes('encrypted data', end - r.pos);
    info.summary = `${info.commandName} (encrypted)`;
    return;
  }
  const cmdEnd = cl === 0xfff ? end : Math.min(end, r.pos + cl);
  r.group(info.commandName, (g) => {
    if (type === 0x05) {
      info.eventId = r.u32('splice_event_id', { key: true });
      const cancel = r.flag('splice_event_cancel_indicator');
      r.bits(7, 'reserved', { reserved: true, display: bin(7) });
      if (!cancel) {
        info.outOfNetwork = r.flag('out_of_network_indicator', { key: true, enum: { 0: 'return to network (end of break)', 1: 'leave the network (start of an ad break)' } });
        const prog = r.flag('program_splice_flag');
        const dur = r.flag('duration_flag');
        const imm = r.flag('splice_immediate_flag');
        r.flag('event_id_compliance_flag');
        r.bits(3, 'reserved', { reserved: true, display: bin(3) });
        if (prog && !imm) info.spliceTime = spliceTime(r);
        if (!prog) {
          const n = r.u8('component_count');
          for (let i = 0; i < n; i++) {
            r.group(`component[${i}]`, () => {
              r.u8('component_tag');
              if (!imm) spliceTime(r);
            });
          }
        }
        if (dur) {
          r.group('break_duration', (bg) => {
            r.flag('auto_return');
            r.bits(6, 'reserved', { reserved: true, display: bin(6) });
            info.breakDuration = r.bits(33, 'duration', { display: fmtTs });
            bg.display = fmtDuration(info.breakDuration / 90000);
          });
        }
        r.u16('unique_program_id');
        r.u8('avail_num');
        r.u8('avails_expected');
      }
      g.display = `event ${info.eventId}${info.outOfNetwork !== undefined ? (info.outOfNetwork ? ', out of network' : ', back to network') : ''}`;
    } else if (type === 0x06) {
      info.spliceTime = spliceTime(r);
      g.display = info.spliceTime !== null ? fmtTs(info.spliceTime) : 'immediate';
    } else if (r.pos < cmdEnd) {
      r.bytes('command_data', cmdEnd - r.pos);
    }
  });
  if (r.pos < cmdEnd) r.bytes('command_remainder', cmdEnd - r.pos);
  r.pos = Math.max(r.pos, cmdEnd);
  if (r.pos + 2 <= end) {
    const dl = r.u16('descriptor_loop_length', { unit: 'bytes' });
    const stop = Math.min(end, r.pos + dl);
    let i = 0;
    while (r.pos + 2 <= stop) {
      r.group(`splice_descriptor[${i++}]`, (g) => {
        const tag = r.u8('splice_descriptor_tag', { enum: SPLICE_DESCRIPTORS });
        const len = r.u8('descriptor_length', { unit: 'bytes' });
        r.bounded(len, () => {
          if (r.remaining >= 4) r.fourcc('identifier', { desc: '\'CUEI\' for descriptors defined by SCTE 35.' });
          if (r.remaining > 0) r.rest('descriptor_data');
        });
        g.display = SPLICE_DESCRIPTORS[tag] ?? hex2(tag);
      });
    }
  }
  if (info.spliceTime !== undefined && info.spliceTime !== null) {
    const f = r.out.find((x) => x.name === info.commandName);
    if (f) f.note = `splice at ${tsNote((info.spliceTime + info.ptsAdjustment) % 2 ** 33)} (pts_time + pts_adjustment)`;
  }
  info.summary = `${info.commandName}${info.eventId !== undefined ? ` #${info.eventId}` : ''}${info.outOfNetwork ? ' (break start)' : info.outOfNetwork === 0 ? ' (break end)' : ''}`;
}

const BODIES = {
  0x00: patBody,
  0x01: catBody,
  0x02: pmtBody,
  0x40: nitBody,
  0x41: nitBody,
  0x42: sdtBody,
  0x46: sdtBody,
  0x4a: nitBody,
  0x70: tdtBody,
  0x73: totBody,
  0xfc: scte35Body,
};

// ------------------------------------------------------------------ reassembly

/**
 * Collects the sections of one PID across packets. push() is called with the
 * payload of each packet; complete sections are passed to onSection(bytes,
 * startOffset, packetIndex) where startOffset is the file offset of table_id.
 */
export class SectionAssembler {
  constructor(onSection) {
    this.onSection = onSection;
    this.buf = null;
    this.len = 0;
    this.need = 0;
    this.startOff = 0;
    this.startPacket = 0;
    this.lastCc = -1;
    this.errors = 0;
  }

  _begin(u8, p, end, off, packet) {
    // A new section starts at u8[p]; returns the index after what was consumed.
    if (u8[p] === 0xff) return end; // stuffing up to the end of the packet
    if (end - p < 3) {
      // The header itself is split: keep the bytes and wait for more.
      this.buf = new Uint8Array(4096 + 3);
      this.buf.set(u8.subarray(p, end));
      this.len = end - p;
      this.need = 0;
      this.startOff = off;
      this.startPacket = packet;
      return end;
    }
    const total = 3 + (((u8[p + 1] & 0x0f) << 8) | u8[p + 2]);
    if (p + total <= end) {
      this.onSection(u8.subarray(p, p + total), off, packet);
      return p + total;
    }
    this.buf = new Uint8Array(total);
    this.buf.set(u8.subarray(p, end));
    this.len = end - p;
    this.need = total;
    this.startOff = off;
    this.startPacket = packet;
    return end;
  }

  _append(u8, p, end) {
    // Continue the pending section with u8[p, end); returns bytes consumed.
    if (!this.buf) return 0;
    if (!this.need) {
      const take = Math.min(end - p, 3 - this.len);
      this.buf.set(u8.subarray(p, p + take), this.len);
      this.len += take;
      if (this.len < 3) return take;
      const total = 3 + (((this.buf[1] & 0x0f) << 8) | this.buf[2]);
      const nb = new Uint8Array(total);
      nb.set(this.buf.subarray(0, 3));
      this.buf = nb;
      this.need = total;
      return take + this._append(u8, p + take, end);
    }
    const take = Math.min(end - p, this.need - this.len);
    this.buf.set(u8.subarray(p, p + take), this.len);
    this.len += take;
    if (this.len >= this.need) {
      const b = this.buf;
      this.buf = null;
      this.onSection(b, this.startOff, this.startPacket);
    }
    return take;
  }

  /** Payload bytes u8[p, end) of one packet; `off` = file offset of u8[p]; `lost` = continuity broken. */
  push(u8, p, end, pusi, off, packet, lost = false) {
    if (lost && this.buf) {
      this.buf = null;
      this.errors++;
    }
    if (p >= end) return;
    if (!pusi) {
      this._append(u8, p, end);
      return;
    }
    const pointer = u8[p];
    let q = p + 1;
    const tailEnd = Math.min(end, q + pointer);
    if (this.buf) this._append(u8, q, tailEnd);
    if (this.buf) this.errors++; // the pointer_field says a new section starts before the old one ended
    this.buf = null;
    q = tailEnd;
    let guard = 0;
    while (q < end && guard++ < 64) {
      if (u8[q] === 0xff) break;
      q = this._begin(u8, q, end, off + (q - p), packet);
      if (this.buf) break;
    }
  }
}

/** A readable one-line summary for a parsed section. */
export function sectionLabel(info) {
  const v = info.version !== undefined ? ` v${info.version}` : '';
  const crc = info.crcOk === undefined ? '' : info.crcOk ? '' : ' · CRC error';
  return `${info.short}${v}${info.summary ? ` · ${info.summary}` : ''}${info.truncated ? ' · continues' : ''}${crc}`;
}

