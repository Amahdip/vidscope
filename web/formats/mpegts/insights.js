// File insights for transport streams: the checks a video engineer would run
// with a TS analyser (TR 101 290 style): clock and table timing, continuity,
// padding overhead, stream inventory, A/V alignment and decoder buffering.

import { fmtInt, fmtNum, fmtBitrate, fmtDuration, hex, pct } from '../../core/util.js';
import { NULL_PID, PCR_HZ, PTS_HZ, WRAP_33, hexPid, tableIdInfo, SERVICE_TYPES } from './tables.js';
import { describeProgram } from './program.js';
import { fmtMs, fmtTs, fmtUtc, unwrap } from './text.js';

const PCR_WRAP = WRAP_33 * 300;

const q = (s) => `"${String(s).replace(/"/g, '\\"')}"`;
const M2TS_EXTRA = (L) => (L.size === 192 ? '; M2TS adds 4 bytes per packet' : L.size === 204 ? '; the 16 parity bytes per packet add 8.5%' : '');

/** PCR (27 MHz) of `pcrPid` interpolated at a packet index, or NaN. */
function pcrAt(stats, pcrPid, index) {
  const p = stats.pcr.get(pcrPid);
  if (!p || !p.idxArr?.length) return NaN;
  const idx = p.idxArr;
  const val = p.valArr;
  const n = idx.length;
  if (n === 1) return NaN;
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (idx[mid] <= index) lo = mid;
    else hi = mid - 1;
  }
  let a = Math.min(lo, n - 2);
  // Do not interpolate across a PCR jump.
  if (val[a + 1] <= val[a]) a = Math.max(0, a - 1);
  const span = idx[a + 1] - idx[a];
  const rate = span > 0 ? (val[a + 1] - val[a]) / span : 0;
  if (!(rate > 0) || rate > PCR_HZ) return NaN;
  return val[a] + (index - idx[a]) * rate;
}

function intervals(times) {
  let max = 0;
  let sum = 0;
  let n = 0;
  let maxAt = -1;
  for (let i = 1; i < times.length; i++) {
    const d = times[i] - times[i - 1];
    if (!Number.isFinite(d) || d < 0) continue;
    sum += d;
    n++;
    if (d > max) {
      max = d;
      maxAt = i;
    }
  }
  return { max, avg: n ? sum / n : 0, n, maxAt };
}

export async function insights(doc) {
  const out = [];
  const L = doc.layout;
  const model = doc.model;
  const stats = doc.stats;
  const name = doc.name;
  const add = (o) => out.push(o);

  // ================================================================ Overview
  const programs = [...model.programs.values()];
  const facts = [
    ['packet size', `${L.size} bytes${L.size === 192 ? (L.syncOffset ? ' (4-byte TP_extra_header + 188)' : ' (188 + 4-byte trailer)') : L.size === 204 ? ' (188 + 16 parity bytes)' : ''}`],
    ['packets', fmtInt(L.count)],
    ['programs', fmtInt(programs.length)],
    ['elementary streams', fmtInt(doc.tracks.length)],
  ];
  if (doc.summary.duration) facts.push(['duration', fmtDuration(doc.summary.duration)]);
  const muxRate = stats ? muxBitrate(doc) : null;
  if (muxRate) facts.push(['transport bitrate (from the PCR)', fmtBitrate(muxRate.rate)]);
  const system = model.dvb ? 'DVB service information (SDT/NIT/EIT) is present' : model.atsc ? 'ATSC PSIP tables are present' : L.size === 192 && L.syncOffset ? 'Blu-ray / AVCHD (BDAV) layout' : 'only the MPEG-2 program tables (no DVB or ATSC service information)';
  add({
    level: 'info',
    group: 'Overview',
    title: L.size === 188 ? 'MPEG-2 transport stream' : L.label,
    text: `A sequence of ${fmtInt(L.count)} packets of ${L.size} bytes with ${fmtInt(programs.length)} program${programs.length === 1 ? '' : 's'}; ${system}.${L.size === 192 && L.syncOffset ? ' Each packet is preceded by a 4-byte arrival timestamp (M2TS), used by Blu-ray players to reproduce the recording’s timing.' : ''}${L.size === 204 ? ' Every packet carries 16 extra Reed-Solomon parity bytes from the DVB channel coder: this is a raw capture, not a file meant for playback.' : ''}`,
    facts,
  });
  if (!stats) {
    add({ level: 'info', group: 'Overview', title: 'Full scan pending', text: 'Timing, continuity and bitrate checks need every packet. They appear once Vidscope has read the whole file.' });
  }
  for (const p of programs) {
    const streams = p.streams ?? [];
    const f = [['program_number', String(p.number)], ['PMT PID', hexPid(p.pmtPid)], ['PCR PID', p.pcrPid === undefined ? '—' : p.pcrPid === NULL_PID ? 'none (0x1FFF)' : hexPid(p.pcrPid)]];
    for (const s of streams) {
      const t = doc.tracksByPid.get(s.pid);
      const how = t?.how ?? s.how;
      f.push([hexPid(s.pid), `${t?.codecName ?? s.codecName}${how && !how.startsWith('stream_type') ? ` (${how})` : ''} · stream_type 0x${s.type.toString(16).padStart(2, '0')}`]);
    }
    const svc = model.sdt?.services?.find((x) => x.id === p.number);
    add({
      level: p.pmt ? 'info' : 'warn',
      group: 'Overview',
      title: describeProgram(model, p.number).replace(/^program/, 'Program'),
      text: p.pmt ? `${streams.length} elementary stream${streams.length === 1 ? '' : 's'}${svc?.type !== undefined ? `, service type ${SERVICE_TYPES[svc.type] ?? svc.type}` : ''}.` : 'The PAT lists this program but its PMT was not found, so its streams are unknown.',
      facts: f,
    });
  }
  if (L.first > 0) {
    add({ level: 'warn', group: 'Layout', title: 'File starts in the middle of a packet', text: `The first ${fmtInt(L.first)} bytes are the tail of a packet cut off at the start (typical of recordings of live streams). Demuxers skip them.`, offset: 0 });
  }
  const tail = L.first + L.count * L.size;
  if (tail < doc.size) {
    add({ level: 'warn', group: 'Layout', title: 'File ends with an incomplete packet', text: `${fmtInt(doc.size - tail)} bytes after the last complete packet: the file was probably truncated or is still being written.`, offset: tail });
  }
  if (!model.pat) {
    add({ level: 'bad', group: 'Integrity', title: 'No Program Association Table', text: `No PAT (PID 0x0000) was found${stats ? '' : ' at the start of the file'}. Without it a receiver cannot find the programs; players have to guess from the PIDs.` });
  }

  // ================================================================ Tracks
  const types = new Map();
  for (const t of doc.tracks) {
    const k = `0x${t.streamType.toString(16).padStart(2, '0')}`;
    const e = types.get(k) ?? { name: t.typeName, pids: [] };
    e.pids.push(hexPid(t.pid));
    types.set(k, e);
  }
  if (types.size) {
    add({
      level: 'info',
      group: 'Tracks',
      title: 'Stream types present',
      text: 'stream_type in the PMT tells a demuxer which decoder to use. Values from 0x80 are private and mean different things in ATSC, Blu-ray or HLS streams; 0x06 relies on descriptors.',
      facts: [...types].map(([k, e]) => [k, `${e.name} — ${e.pids.join(', ')}`]),
    });
  }
  for (const t of doc.tracks) {
    if (t.how?.startsWith('guessed')) {
      add({ level: 'warn', group: 'Tracks', title: `${t.label}: codec not signalled`, text: `The PMT declares stream_type 0x${t.streamType.toString(16).padStart(2, '0')} without a descriptor that names the codec; Vidscope recognised ${t.codecName.replace(' (detected from the payload)', '')} from the payload bytes. Strict players may ignore this stream.` });
    }
    if (t.encrypted) add({ level: 'info', group: 'Tracks', title: `${t.label}: HLS SAMPLE-AES`, text: 'The stream_type marks this stream as encrypted with HLS sample encryption: frame headers are readable but the media data is not.' });
  }

  // ================================================================ Metadata
  if (model.sdt?.services?.length) {
    add({
      level: 'info',
      group: 'Metadata',
      title: 'Service names (SDT)',
      text: 'The DVB Service Description Table gives each program the name and provider shown in channel lists.',
      facts: model.sdt.services.map((s) => [`service ${s.id}`, `${s.name !== undefined ? q(s.name) : '(no name)'}${s.provider ? ` from ${q(s.provider)}` : ''}${s.type !== undefined ? ` — ${SERVICE_TYPES[s.type] ?? `type 0x${s.type.toString(16)}`}` : ''}`]),
    });
  }
  if (model.nit?.networkName) add({ level: 'info', group: 'Metadata', title: 'Network name (NIT)', text: q(model.nit.networkName) });
  if (model.time?.utc) add({ level: 'info', group: 'Metadata', title: 'Broadcast time (TDT/TOT)', text: `The stream carries the UTC time ${fmtUtc(model.time.utc)}: when it was broadcast or recorded.` });
  const langs = doc.tracks.filter((t) => t.language).map((t) => [t.label, t.language]);
  if (langs.length) add({ level: 'info', group: 'Metadata', title: 'Languages', text: 'From ISO 639 language (or subtitling/teletext) descriptors in the PMT.', facts: langs });
  if (model.scte35.length) {
    const kinds = new Map();
    for (const c of model.scte35) kinds.set(c.info.commandName, (kinds.get(c.info.commandName) ?? 0) + 1);
    add({
      level: 'info',
      group: 'Metadata',
      title: `${fmtInt(model.scte35.length)} SCTE-35 cue message${model.scte35.length === 1 ? '' : 's'}`,
      text: `Splice information for ad insertion or content boundaries. Packagers turn them into HLS tags (#EXT-X-DATERANGE with SCTE35-OUT/IN, or #EXT-X-CUE-OUT/IN) and DASH events.${model.scte35.some((c) => c.repeat) ? ' Identical cues are repeated: encoders resend a cue several times before its splice point so it survives packet loss.' : ''}`,
      facts: [...kinds].map(([k, v]) => [k, fmtInt(v)]).concat(model.scte35.slice(0, 5).map((c) => [hex(c.offset), c.info.summary ?? c.info.commandName])),
      offset: model.scte35[0].offset,
    });
  }

  if (!stats) return out;

  // ================================================================ Integrity
  const states = stats.states;
  if (stats.syncLosses.length) {
    add({
      level: 'bad',
      group: 'Integrity',
      title: `Lost packet sync ${fmtInt(stats.syncLosses.length)} time${stats.syncLosses.length === 1 ? '' : 's'}`,
      text: `${fmtInt(stats.lostBytes)} bytes do not form packets (the sync byte 0x47 does not repeat every ${L.size} bytes there). This happens when files are concatenated at arbitrary bytes, truncated in the middle, or damaged. TR 101 290 counts it as TS_sync_loss (priority 1).`,
      facts: stats.syncLosses.slice(0, 8).map((s) => [hex(s.from), `${fmtInt(s.to - s.from)} bytes skipped`]),
      offset: stats.syncLosses[0].from,
    });
  }
  if (stats.ccErrorCount) {
    const per = [];
    for (const ps of states) if (ps && ps.ccErrors) per.push([ps.pid, ps.ccErrors]);
    const first = [...stats.ccErrors.entries()].slice(0, 6);
    add({
      level: 'bad',
      group: 'Integrity',
      title: `${fmtInt(stats.ccErrorCount)} continuity counter error${stats.ccErrorCount === 1 ? '' : 's'}`,
      text: 'The 4-bit continuity_counter of a PID skipped values: packets were lost (or reordered) between the encoder and this file, so the frames or tables they carried are damaged. TR 101 290 Continuity_count_error (priority 1). Typical causes: packet loss on UDP/IP, a bad satellite/cable signal, or cutting and joining files.',
      facts: per.map(([pid, n]) => [hexPid(pid), `${fmtInt(n)} error${n === 1 ? '' : 's'} (${doc.roleOf(pid)?.short ?? 'unknown PID'})`]).concat(first.map(([off, e]) => [hex(off), `PID ${hexPid(e.pid)}: expected ${e.expected}, got ${e.got}`])),
      offset: first[0]?.[0],
      cmd: `ffmpeg -v error -i ${q(name)} -map 0 -f null -`,
    });
  } else if (stats.packets) {
    add({ level: 'good', group: 'Integrity', title: 'No continuity counter errors', text: 'Every PID’s continuity_counter increments without gaps: no packets were lost.' });
  }
  let dups = 0;
  for (const ps of states) if (ps) dups += ps.dups;
  if (dups) add({ level: 'info', group: 'Integrity', title: `${fmtInt(dups)} duplicate packet${dups === 1 ? '' : 's'}`, text: 'A packet may be sent twice in a row with the same continuity_counter (for robustness); decoders drop the copy.' });
  if (stats.teiPackets) {
    add({
      level: 'bad',
      group: 'Integrity',
      title: `${fmtInt(stats.teiPackets)} packet${stats.teiPackets === 1 ? '' : 's'} flagged as corrupt`,
      text: 'transport_error_indicator is set: the demodulator could not correct bit errors in these packets (TR 101 290 Transport_error). Expect artefacts in the frames they belong to.',
      facts: stats.teiFirst.slice(0, 6).map((o) => ['at', hex(o)]),
      offset: stats.teiFirst[0],
    });
  }
  if (model.crcErrors.length) {
    add({
      level: 'bad',
      group: 'Integrity',
      title: `${fmtInt(model.crcErrors.length)} table section${model.crcErrors.length === 1 ? '' : 's'} with a bad CRC`,
      text: 'Receivers ignore sections whose CRC_32 does not match (TR 101 290 CRC_error), as if the table were missing.',
      facts: model.crcErrors.slice(0, 6).map((e) => [hex(e.offset), `${tableIdInfo(e.tableId).short} on PID ${hexPid(e.pid)}`]),
      offset: model.crcErrors[0].offset,
    });
  }
  let badAf = 0;
  let afc0 = 0;
  let noStart = 0;
  let truncated = 0;
  let excess = 0;
  let orphan = 0;
  for (const ps of states) {
    if (!ps) continue;
    badAf += ps.badAf;
    afc0 += ps.afc0;
    noStart += ps.noStartCode;
    truncated += ps.truncatedPes;
    excess += ps.excess;
    orphan += ps.orphan;
  }
  if (badAf || afc0) add({ level: 'bad', group: 'Integrity', title: 'Malformed packet headers', text: `${badAf ? `${fmtInt(badAf)} packet${badAf === 1 ? ' has' : 's have'} an adaptation_field_length that does not fit the packet. ` : ''}${afc0 ? `${fmtInt(afc0)} packet${afc0 === 1 ? ' uses' : 's use'} the reserved adaptation_field_control value 00 and must be discarded.` : ''}` });
  if (noStart || truncated || excess) {
    const f = [];
    if (noStart) f.push(['no PES start code after a unit start', fmtInt(noStart)]);
    if (truncated) f.push(['shorter than PES_packet_length', fmtInt(truncated)]);
    if (excess) f.push(['bytes beyond PES_packet_length', fmtInt(excess)]);
    add({ level: 'warn', group: 'Integrity', title: 'PES packet problems', text: 'Some PES packets do not match their headers: data was lost, or the multiplexer wrote inconsistent lengths.', facts: f });
  }
  if (orphan) add({ level: 'info', group: 'Integrity', title: 'Stream joined mid-frame', text: `${fmtInt(orphan)} payload bytes arrive before the first PES packet start of their PID: the file begins in the middle of frames. Players skip them.` });
  if (stats.leftoverAudioBytes) add({ level: 'info', group: 'Integrity', title: 'Incomplete audio frame at the end', text: `${fmtInt(stats.leftoverAudioBytes)} bytes at the end of an audio stream do not form a complete frame.` });
  if (stats.scrambled) {
    add({
      level: 'warn',
      group: 'Integrity',
      title: `${pct(stats.scrambled, stats.packets, 1)} of packets are scrambled`,
      text: `${fmtInt(stats.scrambled)} packets have transport_scrambling_control ≠ 0: their payload is encrypted by a conditional-access system and cannot be decoded (or analysed) without the keys.`,
      facts: states.filter((ps) => ps?.scrambled).slice(0, 8).map((ps) => [hexPid(ps.pid), `${fmtInt(ps.scrambled)} packets`]),
    });
  }

  // ================================================================ Layout
  const nullShare = stats.packets ? stats.nullPackets / stats.packets : 0;
  const aligned = L.size === 192 && L.syncOffset === 4 && doc.size % 6144 === 0;
  if (stats.nullPackets && aligned && nullShare < 0.05) {
    add({
      level: 'info',
      group: 'Layout',
      title: `${fmtInt(stats.nullPackets)} null packets complete the last Aligned Unit`,
      text: 'Blu-ray (BDAV) files are made of Aligned Units of 32 source packets (6,144 bytes), so muxers pad the end with null packets. This file is an exact number of Aligned Units.',
      facts: [['Aligned Units', fmtInt(doc.size / 6144)], ['null packets', fmtInt(stats.nullPackets)]],
    });
  } else if (stats.nullPackets) {
    add({
      level: nullShare > 0.2 ? 'warn' : 'info',
      group: 'Layout',
      title: `${pct(stats.nullPackets, stats.packets, 1)} null packets (padding)`,
      text: `${fmtInt(stats.nullPackets)} packets on PID 0x1FFF (${fmtInt(stats.nullPackets * L.size)} bytes) carry nothing. They pad a constant-bitrate multiplex (broadcast, IPTV) to its fixed rate; in a file for storage or HTTP streaming they are wasted space${nullShare > 0.2 ? ' — here a large share of the file' : ''}. FFmpeg drops them when remuxing without -muxrate.`,
      facts: [['null packets', fmtInt(stats.nullPackets)], ['share of the file', pct(stats.nullPackets * L.size, doc.size, 2)]],
      cmd: `ffmpeg -i ${q(name)} -map 0 -c copy without-null-packets.ts`,
    });
  } else {
    add({ level: 'info', group: 'Layout', title: 'No null packets', text: 'The multiplex has no padding: a variable-bitrate TS, as produced for files and HTTP streaming (HLS).' });
  }
  if (muxRate) {
    add({
      level: 'info',
      group: 'Layout',
      title: muxRate.cbr ? `Constant bitrate multiplex: ${fmtBitrate(muxRate.rate)}` : `Variable bitrate multiplex, ${fmtBitrate(muxRate.rate)} on average`,
      text: muxRate.cbr ? 'The number of bytes between PCRs matches the PCR time everywhere: packets are sent at a constant rate, as broadcast and IPTV require.' : 'The byte rate between successive PCRs varies: packets are written as fast as the content needs, not at a fixed rate. Fine for files and HLS; a broadcast or UDP output would need -muxrate.',
      facts: [['rate from PCR', fmtBitrate(muxRate.rate)], ['local rate range', `${fmtBitrate(muxRate.min)} – ${fmtBitrate(muxRate.max)}`]],
    });
  }
  // Overhead: everything that is not elementary-stream payload.
  let esBytes = 0;
  for (const t of doc.tracks) if (t.pes) for (let i = 0; i < t.pes.count; i++) esBytes += t.pes.sizes[i];
  if (esBytes) {
    const overhead = doc.size - esBytes;
    const nullBytes = stats.nullPackets * L.size;
    const structural = overhead - nullBytes;
    const f = [['elementary stream bytes', fmtInt(esBytes)], ['overhead bytes', fmtInt(overhead)]];
    if (nullBytes) f.push(['of which null packets', `${fmtInt(nullBytes)} (${pct(nullBytes, doc.size, 1)} of the file)`], ['overhead without null packets', pct(structural, doc.size - nullBytes, 1)]);
    add({
      level: structural / (doc.size - nullBytes) > 0.25 ? 'warn' : 'info',
      group: 'Layout',
      title: `Container overhead ${pct(overhead, doc.size, 1)}${nullBytes ? ` (${pct(structural, doc.size - nullBytes, 1)} without null packets)` : ''}`,
      text: `Packet headers, adaptation fields (PCR, stuffing), PES headers, tables${nullBytes ? ' and null packets' : ''} take ${fmtInt(overhead)} bytes; ${fmtInt(esBytes)} bytes are audio/video data. Transport streams usually spend 3–10% on structure, more than MP4, because every 188-byte packet repeats a 4-byte header, tables are repeated, and the last packet of each PES packet is padded with stuffing${M2TS_EXTRA(L)}.`,
      facts: f,
    });
  }
  // PIDs no table describes
  const undescribed = [];
  for (const ps of states) {
    if (!ps || !ps.packets || ps.pid === NULL_PID) continue;
    if (doc.roleOf(ps.pid)) continue;
    undescribed.push(ps);
  }
  if (undescribed.length) {
    add({
      level: 'warn',
      group: 'Layout',
      title: `${undescribed.length} PID${undescribed.length === 1 ? '' : 's'} not described by any table`,
      text: 'Packets on PIDs that neither the PAT/PMT nor a fixed assignment explains. Players ignore them. They may be leftovers of a remux, private data, or streams of a PMT version that is not in this file (TR 101 290 calls unreferenced PIDs a priority-3 error).',
      facts: undescribed.slice(0, 12).map((ps) => [hexPid(ps.pid), `${fmtInt(ps.packets)} packet${ps.packets === 1 ? '' : 's'}${ps.pusi ? `, ${fmtInt(ps.pusi)} unit starts` : ''}`]),
      offset: undescribed[0].first,
    });
  }
  // Per-PID bitrate
  const dur = muxRate?.seconds || doc.summary.duration;
  if (dur) {
    const rows = [];
    for (const ps of states) {
      if (!ps || !ps.packets) continue;
      rows.push([hexPid(ps.pid), `${fmtBitrate((ps.packets * 188 * 8) / dur)} · ${pct(ps.packets, stats.packets, 1)} — ${doc.roleOf(ps.pid)?.short ?? 'unreferenced'}`]);
    }
    add({ level: 'info', group: 'Layout', title: 'Bitrate per PID', text: 'Transport-level rate of each PID (188-byte packets, headers included) over the duration measured with the PCR.', facts: rows.slice(0, 24) });
  }
  const pcrOnly = [...model.pcrPids()].filter((pid) => !doc.tracksByPid.has(pid));
  for (const pid of pcrOnly) {
    const ps = states[pid];
    add({ level: 'info', group: 'Layout', title: `Dedicated PCR PID ${hexPid(pid)}`, text: `The program clock travels on its own PID (${fmtInt(ps?.packets ?? 0)} packets) instead of inside the video PID. Common in broadcast; it costs a little bandwidth but lets the PCR be sent on a precise schedule.` });
  }

  // ================================================================ Timing: PCR
  for (const p of stats.pcr.values()) {
    const progs = programs.filter((x) => x.pcrPid === p.pid).map((x) => x.number);
    const who = `${hexPid(p.pid)}${progs.length ? ` (program ${progs.join(', ')})` : ''}`;
    if (p.intervals < 1) {
      add({ level: 'info', group: 'Timing', title: `Only ${fmtInt(p.n)} PCR on ${who}`, text: 'Not enough PCR values to measure their spacing.' });
      continue;
    }
    const maxMs = (p.max / PCR_HZ) * 1000;
    const avgMs = (p.sum / p.intervals / PCR_HZ) * 1000;
    const level = maxMs > 100 ? 'bad' : maxMs > 40 ? 'warn' : 'good';
    add({
      level,
      group: 'Timing',
      title: `PCR every ${fmtNum(avgMs, 1)} ms (max ${fmtNum(maxMs, 1)} ms) on ${who}`,
      text: level === 'bad'
        ? `The program clock reference must arrive at least every 100 ms (ISO/IEC 13818-1); here ${fmtInt(p.over100)} gap${p.over100 === 1 ? ' is' : 's are'} longer (TR 101 290 PCR_repetition_error). Decoders may lose clock lock, causing audio/video drift or buffer problems in hardware receivers.`
        : level === 'warn'
          ? `Within the 100 ms limit of ISO/IEC 13818-1, but DVB (ETSI TS 101 154) asks for at most 40 ms; ${fmtInt(p.over40)} interval${p.over40 === 1 ? ' exceeds' : 's exceed'} it. Software players do not mind; strict broadcast equipment may flag it.`
          : 'Within both the 100 ms limit of ISO/IEC 13818-1 and the 40 ms recommended by DVB: decoders can keep their 27 MHz clock locked to the encoder.',
      facts: [['PCR values', fmtInt(p.n)], ['average interval', fmtMs(avgMs / 1000, 2)], ['maximum interval', `${fmtMs(maxMs / 1000, 2)}${p.maxAtOff >= 0 ? ` (at ${hex(p.maxAtOff)})` : ''}`], ['minimum interval', fmtMs(p.min / PCR_HZ, 2)], ['intervals > 40 ms', fmtInt(p.over40)], ['intervals > 100 ms', fmtInt(p.over100)]],
      offset: level !== 'good' ? p.maxAtOff : undefined,
      cmd: level !== 'good' ? `ffmpeg -i ${q(name)} -map 0 -c copy -pcr_period 20 fixed-pcr.ts` : undefined,
    });
    if (p.jumps || p.discontinuities) {
      add({
        level: p.jumps ? 'warn' : 'info',
        group: 'Timing',
        title: `PCR discontinuities on ${who}`,
        text: `${p.discontinuities ? `${fmtInt(p.discontinuities)} signalled with discontinuity_indicator (a legitimate time-base change, e.g. at a splice). ` : ''}${p.jumps ? `${fmtInt(p.jumps)} unsignalled jump${p.jumps === 1 ? '' : 's'} (backwards or larger than 10 s): the clock restarts without warning, typical of files joined together. TR 101 290 PCR_discontinuity_indication_error.` : ''}`,
        facts: p.jumpOffsets.slice(0, 6).map((o) => ['jump at', hex(o)]),
        offset: p.jumpOffsets[0],
      });
    }
  }
  if (!stats.pcr.size && doc.tracks.length) add({ level: 'bad', group: 'Timing', title: 'No PCR in the stream', text: 'No adaptation field carries a PCR, so a hardware decoder cannot recover the encoder clock. Software players fall back to the PTS values.' });

  // Durations
  const pcrDur = muxRate?.seconds;
  const ptsDur = doc.summary.duration;
  if (pcrDur || ptsDur) {
    const f = [];
    if (ptsDur) f.push(['from PTS (first frame → end of last frame)', fmtDuration(ptsDur)]);
    if (pcrDur) f.push(['from the PCR (first to last PCR)', fmtDuration(pcrDur)]);
    for (const t of doc.tracks) if (t.duration) f.push([t.label, `${fmtDuration(t.duration)} from ${fmtTs(t.startPts)}`]);
    add({ level: 'info', group: 'Timing', title: 'Duration', text: 'A transport stream has no duration field: it is measured from the timestamps. PCR and PTS durations differ slightly because the PCR runs ahead of the presentation times by the decoder buffering delay.', facts: f });
  }

  // A/V start offset per program
  for (const p of programs) {
    const vids = doc.tracks.filter((t) => t.program === p.number && t.kind === 'video' && Number.isFinite(t.startPts));
    const auds = doc.tracks.filter((t) => t.program === p.number && t.kind === 'audio' && Number.isFinite(t.startPts));
    if (!vids.length || !auds.length) continue;
    const v = vids[0];
    const f = [];
    let worst = 0;
    for (const a of auds) {
      const d = unwrap(a.startPts - v.startPts, 0, WRAP_33) / PTS_HZ;
      if (Math.abs(d) > Math.abs(worst)) worst = d;
      f.push([`${a.label} − ${v.label}`, `${d >= 0 ? '+' : ''}${fmtNum(d * 1000, 1)} ms`]);
    }
    const lvl = Math.abs(worst) > 0.5 ? 'warn' : 'info';
    add({
      level: lvl,
      group: 'Timing',
      title: `Audio starts ${fmtNum(Math.abs(worst) * 1000, 0)} ms ${worst >= 0 ? 'after' : 'before'} video${programs.length > 1 ? ` (program ${p.number})` : ''}`,
      text: `Players align audio and video by PTS, so this offset is how long ${worst >= 0 ? 'the picture plays before sound starts' : 'sound plays before the first picture'}. Small offsets (tens of ms) are normal: audio frames and video frames do not start at the same instant.${lvl === 'warn' ? ' This one is large: check the source or the encoder delay.' : ''}`,
      facts: f,
      cmd: `ffprobe -v error -show_entries stream=index,codec_name,start_time -of compact ${q(name)}`,
    });
  }

  // Decoder buffering: DTS relative to the arrival time (PCR) of the PES packet
  for (const t of doc.tracks) {
    if (!t.pes?.count || t.sections || t.pcrPid === undefined) continue;
    const pc = stats.pcr.get(t.pcrPid);
    if (!pc || pc.n < 2) continue;
    let minStart = Infinity;
    let firstDelay = NaN;
    let late = 0;
    let firstLate = -1;
    const pes = t.pes;
    for (let j = 0; j < pes.count; j++) {
      const dts = pes.dts[j];
      if (!(dts >= 0)) continue;
      const arrive = pcrAt(stats, t.pcrPid, pes.index[j]);
      if (!Number.isFinite(arrive)) continue;
      const lastIdx = pes.esEnd[j] > 0 ? Math.floor((pes.esEnd[j] - 1 - L.first) / L.size) : pes.index[j];
      const arriveEnd = pcrAt(stats, t.pcrPid, lastIdx);
      const d = unwrap(dts * 300 - arrive, 0, PCR_WRAP) / PCR_HZ;
      const dEnd = Number.isFinite(arriveEnd) ? unwrap(dts * 300 - arriveEnd, 0, PCR_WRAP) / PCR_HZ : d;
      if (Number.isNaN(firstDelay)) firstDelay = d;
      if (d < minStart) minStart = d;
      if (dEnd < 0) {
        late++;
        if (firstLate < 0) firstLate = pes.offsets[j];
      }
    }
    if (!Number.isFinite(minStart)) continue;
    if (late) {
      add({
        level: 'bad',
        group: 'Timing',
        title: `${t.label}: ${fmtInt(late)} frame${late === 1 ? ' arrives' : 's arrive'} after ${late === 1 ? 'its' : 'their'} decode time`,
        text: 'The last byte of these PES packets reaches the decoder (by the PCR clock) after the DTS at which they must be decoded: the decoder buffer underflows and a hardware decoder has to skip or freeze. The multiplexer sent the data too late; raising the mux delay or bitrate fixes it.',
        facts: [['first late PES at', hex(firstLate)], ['frames checked', fmtInt(pes.count)]],
        offset: firstLate,
      });
    } else {
      add({
        level: 'info',
        group: 'Timing',
        title: `${t.label}: decoded ${fmtNum(firstDelay * 1000, 0)} ms after arrival`,
        text: 'How long the first frame waits in the decoder buffer between arriving (PCR time of its first packet) and its DTS. This is the start-up delay the multiplexer chose (FFmpeg’s -muxdelay defaults to 0.7 s); every frame here arrives before its decode time.',
        facts: [['first frame', fmtMs(firstDelay, 1)], ['smallest margin', fmtMs(minStart, 1)]],
      });
    }
  }

  // Timestamp discontinuities and PTS spacing (TR 101 290 PTS_error: more than 700 ms between PTS values)
  const jumps = doc.tracks.filter((t) => states[t.pid]?.tsJumps);
  if (jumps.length) {
    add({
      level: 'warn',
      group: 'Timing',
      title: `Timestamps jump in ${jumps.length} stream${jumps.length === 1 ? '' : 's'}`,
      text: 'The decode timestamps go backwards (or leap by more than a minute) without the 33-bit wrap explaining it: the time base restarts, as when recordings are joined or an encoder restarts. Players must detect the jump to keep audio and video in sync; durations are therefore summed frame by frame here.',
      facts: jumps.map((t) => [t.label, `${fmtInt(states[t.pid].tsJumps)} jump${states[t.pid].tsJumps === 1 ? '' : 's'}, first at ${hex(states[t.pid].tsJumpAt[0])}`]),
      offset: states[jumps[0].pid].tsJumpAt[0],
    });
  }
  for (const t of doc.tracks) {
    const ps = states[t.pid];
    if (!ps || !ps.maxPtsGap || t.sections || t.kind === 'subtitle' || t.kind === 'data') continue;
    const gap = ps.maxPtsGap / PTS_HZ;
    if (gap > 0.7) {
      add({ level: 'warn', group: 'Timing', title: `${t.label}: ${fmtNum(gap * 1000, 0)} ms without a PTS`, text: 'ISO/IEC 13818-1 requires a presentation timestamp at least every 700 ms (TR 101 290 PTS_error). Longer gaps mean missing data or a stream that was paused.', offset: ps.maxPtsGapAt });
    }
  }

  // PSI/SI repetition
  const psiRows = [];
  for (const o of stats.psi.values()) {
    const times = [];
    const pcrPid = doc.timeline?.pid;
    for (let i = 0; i < o.idxArr.length; i++) times.push(pcrAt(stats, pcrPid, o.idxArr[i]) / PCR_HZ);
    const iv = intervals(times);
    psiRows.push({ o, iv, count: o.idxArr.length });
  }
  const checkPsi = (match, label, limit, desc, cmd, fast = 0) => {
    for (const row of psiRows.filter(match)) {
      const who = row.o.program !== undefined ? `${label} of program ${row.o.program}` : label;
      if (row.count < 2) {
        add({ level: 'info', group: 'Timing', title: `${who}: sent once`, text: `Only one ${label} section in this file, so its repetition rate cannot be measured. ${desc}`, offset: row.o.offArr[0] });
        continue;
      }
      if (!row.iv.n) {
        add({ level: 'info', group: 'Timing', title: `${who}: ${fmtInt(row.count)} sections`, text: `Without a PCR there is no clock to measure how often the ${label} is repeated. ${desc}` });
        continue;
      }
      const max = row.iv.max;
      const lvl = max > limit ? 'bad' : fast && max > fast * 1.1 ? 'info' : 'good';
      add({
        level: lvl,
        group: 'Timing',
        title: `${who} every ${fmtMs(row.iv.avg, 0)} (max ${fmtMs(max, 0)})`,
        text: `${desc} ${lvl === 'bad' ? `The longest gap exceeds ${fmtMs(limit, 0)}, the limit TR 101 290 uses.` : lvl === 'info' ? `Within the ${fmtMs(limit, 0)} limit of TR 101 290, but slower than the ~${fmtMs(fast, 0)} many operators use for fast channel changes.` : `Within the ${fmtMs(limit, 0)} limit of TR 101 290.`}`,
        facts: [['sections', fmtInt(row.count)], ['average interval', fmtMs(row.iv.avg, 1)], ['maximum interval', fmtMs(max, 1)]],
        offset: lvl === 'bad' && row.iv.maxAt >= 0 ? row.o.offArr[row.iv.maxAt] : undefined,
        cmd: lvl === 'bad' || (lvl === 'info' && fast) ? cmd : undefined,
      });
    }
  };
  checkPsi((r) => r.o.tableId === 0x00, 'PAT', 0.5, 'A receiver cannot start decoding before it has seen the PAT and then the PMT, so their repetition sets the minimum channel-change time.', `ffmpeg -i ${q(name)} -map 0 -c copy -pat_period 0.1 out.ts`, 0.1);
  checkPsi((r) => r.o.tableId === 0x02, 'PMT', 0.5, 'The PMT follows the PAT in the tune-in sequence.', `ffmpeg -i ${q(name)} -map 0 -c copy -pat_period 0.1 out.ts`, 0.1);
  checkPsi((r) => r.o.tableId === 0x42, 'SDT', 2, 'DVB expects the SDT of the actual transport stream at least every 2 seconds.', `ffmpeg -i ${q(name)} -map 0 -c copy -sdt_period 0.5 out.ts`);
  checkPsi((r) => r.o.tableId === 0x40, 'NIT', 10, 'DVB expects the NIT at least every 10 seconds.');
  const silent = model.events.filter((e) => e.type === 'pmt-silent');
  if (silent.length) {
    add({
      level: 'bad',
      group: 'Integrity',
      title: `PMT changed ${fmtInt(silent.length)} time${silent.length === 1 ? '' : 's'} without a new version_number`,
      text: 'The list of streams (or the PCR PID) of a program changes while version_number stays the same. Set-top boxes only re-read a table when its version changes, so they keep decoding with the old stream map. Typical of files joined byte-for-byte (cat a.ts b.ts), where each part was muxed independently.',
      facts: silent.slice(0, 6).map((e) => [hex(e.offset), `program ${e.program}, version ${e.version}: streams ${e.before.replace(/(\d+):(\d+)/g, (m, t, p) => `0x${Number(t).toString(16)}@${hexPid(Number(p))}`)} → ${e.after.replace(/(\d+):(\d+)/g, (m, t, p) => `0x${Number(t).toString(16)}@${hexPid(Number(p))}`)}`]),
      offset: silent[0].offset,
    });
  }
  const versions = model.events.filter((e) => e.type === 'pmt-version' || e.type === 'pat-version');
  if (versions.length) {
    add({
      level: 'info',
      group: 'Timing',
      title: `${versions.length} table version change${versions.length === 1 ? '' : 's'}`,
      text: 'The PAT or a PMT changes during the file (new version_number): streams were added, removed or re-mapped, for example at a program boundary or an ad splice. Players must re-read the tables and may reinitialise their decoders there.',
      facts: versions.slice(0, 8).map((e) => [hex(e.offset), e.type === 'pat-version' ? `PAT v${e.from} → v${e.to}` : `PMT of program ${e.program}: v${e.from} → v${e.to}`]),
      offset: versions[0].offset,
    });
  }

  // ================================================================ Encoding
  for (const t of doc.tracks) {
    const s = t.samples;
    if (!s?.count) continue;
    if (t.kind === 'video') {
      const keys = [];
      let keyNoRai = 0;
      let raiNoKey = 0;
      for (let i = 0; i < s.count; i++) {
        if (s.key[i]) keys.push(i);
        if (s.key[i] && !s.rai[i]) keyNoRai++;
        if (!s.key[i] && s.rai[i]) raiNoKey++;
      }
      if (!keys.length) {
        add({ level: 'warn', group: 'Encoding', title: `${t.label}: no key frame`, text: 'No frame in this file starts with an IDR/IRAP picture, so a player cannot start decoding cleanly: expect a grey or corrupted picture until a key frame arrives.' });
      } else {
        let maxGap = 0;
        let sumGap = 0;
        for (let i = 1; i < keys.length; i++) {
          const g = (s.dts[keys[i]] - s.dts[keys[i - 1]]) / PTS_HZ;
          sumGap += g;
          if (g > maxGap) maxGap = g;
        }
        const avg = keys.length > 1 ? sumGap / (keys.length - 1) : null;
        add({
          level: maxGap > 10 ? 'warn' : 'info',
          group: 'Encoding',
          title: `${t.label}: ${fmtInt(keys.length)} key frame${keys.length === 1 ? '' : 's'}${avg ? `, one every ${fmtNum(avg, 2)} s` : ''}`,
          text: `Key frames are where decoding, seeking and HLS/DASH segments can start. ${keys[0] ? `The first key frame is frame ${fmtInt(keys[0] + 1)}: the ${fmtInt(keys[0])} frame${keys[0] === 1 ? '' : 's'} before it cannot be decoded on their own.` : 'The file starts with a key frame.'}${maxGap > 10 ? ' Gaps over 10 s make seeking slow and segments long.' : ''}`,
          facts: [['key frames', fmtInt(keys.length)], ['longest gap', maxGap ? `${fmtNum(maxGap, 2)} s` : '—']],
        });
      }
      if (keyNoRai && t.family) {
        add({ level: 'warn', group: 'Encoding', title: `${t.label}: ${fmtInt(keyNoRai)} key frame${keyNoRai === 1 ? '' : 's'} without random_access_indicator`, text: 'These PES packets start with a key frame but their first packet does not set random_access_indicator in the adaptation field. Segmenters and players that look for the flag (instead of parsing the video) will not find these entry points.' });
      }
      if (raiNoKey && t.family) {
        add({ level: 'info', group: 'Encoding', title: `${t.label}: random_access_indicator on ${fmtInt(raiNoKey)} non-IDR frame${raiNoKey === 1 ? '' : 's'}`, text: 'The multiplexer marks these frames as random access points although they are not IDR/IRAP pictures (for example open-GOP I-frames). Decoding can start there, but some leading frames may be undecodable.' });
      }
      if (s.cto) add({ level: 'info', group: 'Encoding', title: `${t.label}: B-frames (PTS ≠ DTS)`, text: 'Frames are sent in decoding order, which differs from display order: PES headers carry both a DTS and a PTS.' });
    } else if (t.framing && t.pes?.count) {
      const per = s.count / t.pes.count;
      add({ level: 'info', group: 'Encoding', title: `${t.label}: ${fmtNum(per, 1)} frames per PES packet`, text: 'Audio frames are small, so multiplexers pack several into one PES packet to reduce overhead; only the first frame starting in each PES packet gets a PTS, the others are timed by counting samples (Vidscope, like FFmpeg, interpolates them).', facts: [['frames', fmtInt(s.count)], ['PES packets', fmtInt(t.pes.count)]] });
    }
  }
  return out;
}

/** Transport bitrate from the PCR of the busiest PCR PID, and whether it is constant. */
function muxBitrate(doc) {
  const tl = doc.timeline;
  if (!tl || tl.idx.length < 2) return null;
  const { idx, val } = tl;
  const n = idx.length;
  // Sum of the regular intervals: stays right across PCR jumps.
  const busiest = doc.stats.pcr.get(tl.pid);
  const seconds = (busiest?.jumps ? busiest.sum : val[n - 1] - val[0]) / PCR_HZ;
  if (!(seconds > 0)) return null;
  const rate = ((idx[n - 1] - idx[0]) * 188 * 8) / seconds;
  let min = Infinity;
  let max = 0;
  for (let i = 1; i < n; i++) {
    const dp = idx[i] - idx[i - 1];
    const dt = (val[i] - val[i - 1]) / PCR_HZ;
    if (dp < 8 || !(dt > 0)) continue;
    const r = (dp * 188 * 8) / dt;
    if (r < min) min = r;
    if (r > max) max = r;
  }
  if (!Number.isFinite(min)) {
    min = rate;
    max = rate;
  }
  const cbr = (max - min) / rate < 0.02;
  return { rate, min, max, cbr, seconds };
}

