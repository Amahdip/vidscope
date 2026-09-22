// What the PSI/SI tables say about the stream: programs, their PMTs and
// elementary streams, service names, CA systems. Fed with complete sections by
// the scanners; used to build tracks and to know what every PID carries.

import { FieldReader, ParseError } from '../../core/fields.js';
import {
  NULL_PID, FIXED_PIDS, streamTypeInfo, REGISTRATION_CODECS, codecDisplay, caSystemName,
} from './tables.js';
import { readSection } from './psi.js';

export class ProgramModel {
  constructor({ hdmv = false } = {}) {
    this.hdmv = hdmv; // Blu-ray semantics for stream types 0x80+ (M2TS files)
    this.pat = null;
    this.programs = new Map(); // program_number -> { number, pmtPid, pmt, pcrPid, streams, descriptors, name, provider, serviceType, versions }
    this.pmtPids = new Map(); // pid -> [program numbers]
    this.nitPid = null;
    this.sdt = null;
    this.nit = null;
    this.cat = null;
    this.time = null;
    this.emmPids = new Map(); // pid -> CA system id
    this.ecmPids = new Map();
    this.dvb = false;
    this.atsc = false;
    this.sectionCounts = new Map(); // `${pid}:${tableId}` -> count
    this.last = new Map(); // key -> bytes of the last section seen (to skip identical repeats)
    this.lastInfo = new Map(); // key -> the parsed info of that section
    this.events = []; // { type: 'version', ... } changes worth reporting
    this.crcErrors = [];
    this.scte35 = [];
    this.revision = 0; // bumped whenever programs or streams change
  }

  /** Forget the per-occurrence records before a scan of the whole file (the tables themselves are kept). */
  resetCounts() {
    this.sectionCounts.clear();
    this.events = [];
    this.crcErrors = [];
    this.scte35 = [];
    this.last.clear();
    this.lastInfo.clear();
    this.seenPatVersion = undefined;
    for (const p of this.programs.values()) {
      p.seenVersion = undefined;
      p.versions = [];
    }
  }

  /** Is this PID known to carry sections (PSI/SI)? */
  isSectionPid(pid) {
    if (pid === 0 || pid === 1 || pid === 2) return true;
    if (this.pmtPids.has(pid)) return true;
    if (pid === this.nitPid) return true;
    if (pid >= 0x10 && pid <= 0x14) return true;
    if (pid === 0x1ffb) return true;
    if (this.emmPids.has(pid) || this.ecmPids.has(pid)) return true;
    for (const p of this.programs.values()) {
      for (const s of p.streams ?? []) if (s.pid === pid && s.sections) return true;
    }
    return false;
  }

  get complete() {
    if (!this.pat) return false;
    for (const p of this.pat.programs) if (p.number && !this.programs.get(p.number)?.pmt) return false;
    return true;
  }

  /**
   * A complete section arrived on `pid` (bytes start at table_id, `off` = its file offset).
   * Returns the parsed info, or null when the section repeats the previous one byte for byte.
   */
  onSection(pid, bytes, off) {
    const tableId = bytes[0];
    const ck = `${pid}:${tableId}`;
    this.sectionCounts.set(ck, (this.sectionCounts.get(ck) ?? 0) + 1);
    if (tableId === 0xff) return null;
    const key = `${ck}:${bytes.length > 5 ? (bytes[3] << 8) | bytes[4] : 0}:${bytes.length > 6 ? bytes[6] : 0}`;
    const prev = this.last.get(key);
    if (prev && prev.length === bytes.length && prev.every((b, i) => b === bytes[i])) {
      // A repeat: tables are re-sent continuously. Cues and CRC errors still count every time.
      const pinfo = this.lastInfo.get(key);
      if (tableId === 0xfc && this.scte35.length < 1000) this.scte35.push({ pid, offset: off, info: pinfo, repeat: true });
      if (pinfo?.crcOk === false && this.crcErrors.length < 200) this.crcErrors.push({ pid, tableId, offset: off });
      return null;
    }
    this.last.set(key, bytes.slice());
    let info;
    try {
      info = readSection(new FieldReader(bytes, off, { out: [] }), { hdmv: this.hdmv, dvb: this.dvb });
    } catch (e) {
      if (!(e instanceof ParseError)) throw e;
      return null;
    }
    info.pid = pid;
    this.lastInfo.set(key, info);
    if (info.crcOk === false) {
      if (this.crcErrors.length < 200) this.crcErrors.push({ pid, tableId, offset: off });
      return info;
    }
    if (info.current === 0) return info; // a "next" table: not applicable yet
    switch (tableId) {
      case 0x00: this._pat(info, off); break;
      case 0x01: this._cat(info); break;
      case 0x02: this._pmt(pid, info, off); break;
      case 0x40: this.nit = info; this.dvb = true; break;
      case 0x42: this._sdt(info); break;
      case 0x46: case 0x4a: this.dvb = true; break;
      case 0x70: case 0x73: this.time = info; this.dvb = true; break;
      case 0xfc: if (this.scte35.length < 1000) this.scte35.push({ pid, offset: off, info }); break;
      default:
        if (tableId >= 0x4e && tableId <= 0x6f) this.dvb = true;
        if (tableId >= 0xc7 && tableId <= 0xcd) this.atsc = true;
        break;
    }
    return info;
  }

  _pat(info, off) {
    this.revision++;
    const names = this.sdt;
    if (this.seenPatVersion !== undefined && this.seenPatVersion !== info.version) this.events.push({ type: 'pat-version', from: this.seenPatVersion, to: info.version, offset: off });
    this.seenPatVersion = info.version;
    this.pat = { tsid: info.ext, version: info.version, programs: info.programs ?? [] };
    for (const p of this.pat.programs) {
      if (p.number === 0) {
        this.nitPid = p.pid;
        continue;
      }
      const list = this.pmtPids.get(p.pid) ?? [];
      if (!list.includes(p.number)) list.push(p.number);
      this.pmtPids.set(p.pid, list);
      const prog = this.programs.get(p.number);
      if (!prog) this.programs.set(p.number, { number: p.number, pmtPid: p.pid, pmt: null, streams: [], descriptors: [], versions: [] });
      else prog.pmtPid = p.pid;
    }
    if (names) this._sdt(names);
  }

  _cat(info) {
    this.cat = info;
    for (const d of info.descriptors ?? []) if (d.tag === 0x09) this.emmPids.set(d.caPid, d.caSystem);
  }

  _pmt(pid, info, off) {
    this.revision++;
    let prog = this.programs.get(info.program);
    if (!prog) {
      prog = { number: info.program, pmtPid: pid, pmt: null, streams: [], descriptors: [], versions: [] };
      this.programs.set(info.program, prog);
    }
    if (prog.seenVersion !== undefined && prog.seenVersion !== info.version) this.events.push({ type: 'pmt-version', program: info.program, from: prog.seenVersion, to: info.version, offset: off });
    else if (prog.seenVersion !== undefined && prog.pmt) {
      // Same version_number but different content: receivers that trust the version miss the change.
      const before = (prog.pmt.streams ?? []).map((x) => `${x.type}:${x.pid}`).join(',');
      const after = (info.streams ?? []).map((x) => `${x.type}:${x.pid}`).join(',');
      if (before !== after || prog.pmt.pcrPid !== info.pcrPid) this.events.push({ type: 'pmt-silent', program: info.program, version: info.version, offset: off, before, after });
    }
    prog.seenVersion = info.version;
    prog.pmt = info;
    prog.pmtPid = pid;
    prog.pcrPid = info.pcrPid;
    prog.descriptors = info.descriptors ?? [];
    prog.hdmv = this.hdmv || !!info.hdmv;
    prog.versions.push({ version: info.version, offset: off });
    const known = new Map(prog.streams.map((s) => [s.pid, s]));
    prog.streams = (info.streams ?? []).map((s) => {
      const res = resolveStream(s, prog);
      const old = known.get(s.pid);
      return { ...s, ...res, program: prog.number, firstSeen: old?.firstSeen ?? off };
    });
    for (const d of prog.descriptors) if (d.tag === 0x09) this.ecmPids.set(d.caPid, d.caSystem);
    for (const s of prog.streams) for (const d of s.descriptors) if (d.tag === 0x09) this.ecmPids.set(d.caPid, d.caSystem);
  }

  _sdt(info) {
    this.dvb = true;
    this.sdt = info;
    for (const s of info.services ?? []) {
      const prog = this.programs.get(s.id);
      if (prog) {
        prog.name = s.name;
        prog.provider = s.provider;
        prog.serviceType = s.type;
      }
    }
  }

  /** Service name for a program (from the SDT), if any. */
  serviceName(number) {
    const p = this.programs.get(number);
    if (p?.name !== undefined) return p.name;
    return this.sdt?.services?.find((s) => s.id === number)?.name;
  }

  /** Every elementary stream of every program, first appearance order, one entry per PID. */
  streams() {
    const out = [];
    const seen = new Set();
    const order = this.pat ? this.pat.programs.filter((p) => p.number).map((p) => p.number) : [];
    for (const n of this.programs.keys()) if (!order.includes(n)) order.push(n);
    for (const n of order) {
      const p = this.programs.get(n);
      for (const s of p?.streams ?? []) {
        if (seen.has(s.pid)) continue;
        seen.add(s.pid);
        out.push(s);
      }
    }
    return out;
  }

  /** PCR PIDs of all programs. */
  pcrPids() {
    const s = new Set();
    for (const p of this.programs.values()) if (p.pcrPid !== undefined && p.pcrPid !== NULL_PID) s.add(p.pcrPid);
    return s;
  }

  /** What a PID carries, for labels: { kind, short, label, psi?, pes?, dvbSi? } (tracks are attached later). */
  describePid(pid) {
    if (pid === 0) return { kind: 'pat', short: 'PAT', label: 'Program Association Table', psi: true };
    if (pid === NULL_PID) return { kind: 'null', short: 'null', label: 'null packets (stuffing)' };
    if (pid === 1) return { kind: 'cat', short: 'CAT', label: 'Conditional Access Table', psi: true };
    const pm = this.pmtPids.get(pid);
    if (pm) return { kind: 'pmt', short: 'PMT', label: `Program Map Table of program${pm.length > 1 ? 's' : ''} ${pm.join(', ')}`, psi: true, programs: pm };
    if (pid === this.nitPid) return { kind: 'nit', short: 'NIT', label: 'Network Information Table', psi: true, dvbSi: true };
    if (this.ecmPids.has(pid)) return { kind: 'ecm', short: 'ECM', label: `ECMs (conditional access${caSystemName(this.ecmPids.get(pid)) ? `, ${caSystemName(this.ecmPids.get(pid))}` : ''})`, psi: true };
    if (this.emmPids.has(pid)) return { kind: 'emm', short: 'EMM', label: `EMMs (conditional access${caSystemName(this.emmPids.get(pid)) ? `, ${caSystemName(this.emmPids.get(pid))}` : ''})`, psi: true };
    for (const p of this.programs.values()) {
      if (p.pcrPid === pid && !p.streams.some((s) => s.pid === pid)) return { kind: 'pcr', short: 'PCR', label: `PCR of program ${p.number} (clock only)` };
    }
    const f = FIXED_PIDS[pid];
    if (f) return { kind: f.short.toLowerCase(), short: f.short, label: f.name, psi: !!f.psi, dvbSi: !!f.dvb };
    return null;
  }
}

/** Decide what codec an elementary stream carries: stream_type, then descriptors, then registration. */
export function resolveStream(s, prog) {
  const hdmv = !!prog?.hdmv;
  const st = streamTypeInfo(s.type, hdmv);
  const has = (tag) => s.descriptors.find((d) => d.tag === tag);
  const reg = has(0x05)?.format ?? prog?.descriptors?.find((d) => d.tag === 0x05 && d.format !== 'HDMV' && d.format !== 'CUEI' && d.format !== 'GA94')?.format;
  let res = { codec: st.codec, kind: st.kind, family: st.family, how: `stream_type 0x${s.type.toString(16).padStart(2, '0')}`, sections: !!st.sections, encrypted: !!st.encrypted };
  const priv = s.type === 0x06 || (s.type >= 0x80 && st.codec === 'unknown');
  if (priv) {
    if (has(0x6a)) res = { codec: 'ac3', kind: 'audio', family: 'ac3', how: 'AC-3 descriptor (0x6A)' };
    else if (has(0x7a)) res = { codec: 'eac3', kind: 'audio', family: 'eac3', how: 'enhanced AC-3 descriptor (0x7A)' };
    else if (has(0x7b)) res = { codec: 'dts', kind: 'audio', how: 'DTS descriptor (0x7B)' };
    else if (has(0x59)) res = { codec: 'dvb_subtitle', kind: 'subtitle', how: 'subtitling descriptor (0x59)' };
    else if (has(0x56) || has(0x46)) res = { codec: 'dvb_teletext', kind: 'subtitle', how: 'teletext descriptor' };
    else if (has(0x7f)?.ext === 0x15) res = { codec: 'ac4', kind: 'audio', how: 'AC-4 descriptor (DVB extension 0x15)' };
    else if (has(0x7c)) res = { codec: 'aac', kind: 'audio', family: 'adts', how: 'AAC descriptor (0x7C)' };
    else if (reg && REGISTRATION_CODECS[reg]) {
      const rc = REGISTRATION_CODECS[reg];
      res = { codec: rc.codec, kind: rc.kind, family: rc.family, how: `registration descriptor '${reg}'`, sections: rc.codec === 'scte_35' };
    }
  } else if (reg && REGISTRATION_CODECS[reg] && st.codec === 'unknown') {
    const rc = REGISTRATION_CODECS[reg];
    res = { codec: rc.codec, kind: rc.kind, family: rc.family, how: `registration descriptor '${reg}'` };
  }
  if (s.type === 0x15 || s.type === 0x06) {
    const md = has(0x26);
    if (md?.format === 'ID3 ') res = { codec: 'timed_id3', kind: 'data', how: 'metadata descriptor \'ID3 \'' };
    if (md?.format === 'KLVA') res = { codec: 'smpte_klv', kind: 'data', how: 'metadata descriptor \'KLVA\'' };
  }
  if (res.codec === 'scte_35') res.sections = true;
  res.codecName = codecDisplay(res.codec);
  res.typeName = st.name;
  res.pes = !res.sections;
  return res;
}

export function describeProgram(model, number) {
  const svc = model.sdt?.services?.find((s) => s.id === number);
  const p = model.programs.get(number);
  const name = p?.name ?? svc?.name;
  const provider = p?.provider ?? svc?.provider;
  return `program ${number}${name ? ` “${name}”${provider ? ` from ${provider}` : ''}` : ''}`;
}

