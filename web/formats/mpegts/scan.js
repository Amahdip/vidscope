// Scans over the packets of a transport stream.
//
//   initialScan  at open(): the first packets only, until the PAT, every PMT
//                (and the SDT) are known and each stream's codec configuration
//                was seen. Cheap even for huge files.
//   tailScan     at open(): the last packets, for the last PCR/PTS (duration).
//   fullScan     loadSamples(): every packet, streamed with large reads. It
//                reassembles PES packets per PID into frames (samples) and
//                collects the statistics behind the insights.

import { walkPackets } from './layout.js';
import { tsHeader, pesHeader, readPcr } from './packet.js';
import { SectionAssembler } from './psi.js';
import { NULL_PID, PCR_HZ, WRAP_33 } from './tables.js';
import { probeConfig, sniffAudio, videoKeyInfo, FRAME_SYNC } from './es.js';
import { unwrap } from './text.js';

const PCR_WRAP = WRAP_33 * 300;

/** Family used to split an audio stream into frames (null = one sample per PES packet). */
export function framingOf(family) {
  if (family === 'adts' || family === 'ac3' || family === 'eac3' || family === 'mpa' || family === 'latm') return family;
  return null;
}

const PROBEABLE = new Set(['avc', 'hevc', 'mpeg2v', 'adts', 'ac3', 'eac3', 'mpa', 'latm']);

// ------------------------------------------------------------------ initial scan

/**
 * Read the start of the file until the program structure is known.
 * Fills `model` (ProgramModel). Returns { packets, bytes, complete, configs, sniffed, firstPcr, firstPts, pidCounts }.
 */
export async function initialScan(source, L, model, { maxPackets = 60000, onProgress } = {}) {
  const asm = new Map();
  const configs = new Map();
  const sniffed = new Map();
  const capture = new Map();
  const firstPcr = new Map();
  const firstPts = new Map();
  const pidCounts = new Map();
  let packets = 0;
  const limitPackets = Math.min(L.count, maxPackets);

  const assembler = (pid) => {
    let a = asm.get(pid);
    if (!a) {
      a = new SectionAssembler((bytes, off) => model.onSection(pid, bytes, off));
      asm.set(pid, a);
    }
    return a;
  };
  let byPid = new Map();
  let rev = -1;
  const streamOf = (pid) => {
    if (rev !== model.revision) {
      byPid = new Map(model.streams().map((s) => [s.pid, s]));
      rev = model.revision;
    }
    return byPid.get(pid) ?? null;
  };
  const finishCapture = (pid, c, s) => {
    if (!c.len) return;
    const buf = new Uint8Array(c.len);
    let w = 0;
    for (const part of c.parts) {
      buf.set(part, w);
      w += part.length;
    }
    let family = s.family;
    if (!family && (s.codec === 'private' || s.codec === 'unknown')) {
      const sn = sniffAudio(buf, 0, buf.length);
      if (sn) {
        sniffed.set(pid, sn);
        family = sn.family;
      }
    }
    if (family && PROBEABLE.has(family)) {
      const cfg = probeConfig(family, buf, 0, buf.length);
      if (cfg) configs.set(pid, cfg);
    }
    c.tries++;
    c.parts = [];
    c.len = 0;
  };

  const shouldStop = () => {
    if (packets >= limitPackets) return true;
    if (!model.complete) return false;
    for (const s of model.streams()) {
      if (!s.pes) continue;
      const needs = (s.family && PROBEABLE.has(s.family)) || s.codec === 'private' || s.codec === 'unknown';
      if (!needs || configs.has(s.pid) || sniffed.has(s.pid)) continue;
      const c = capture.get(s.pid);
      if (c && c.tries >= 12) continue;
      if (!pidCounts.has(s.pid) && packets > 20000) continue; // the PID does not occur
      return false;
    }
    if (pidCounts.has(0x11) && !model.sdt && packets < 20000) return false;
    return true;
  };

  await walkPackets(source, L, L.first, L.first + limitPackets * L.size, (u8, p, off) => {
    packets++;
    const h = tsHeader(u8, p, L);
    pidCounts.set(h.pid, (pidCounts.get(h.pid) ?? 0) + 1);
    if (h.pcr >= 0 && !firstPcr.has(h.pid)) firstPcr.set(h.pid, { pcr: h.pcr, offset: off });
    if (h.pid === NULL_PID || h.tsc || h.payload >= h.end) return;
    if (model.isSectionPid(h.pid)) {
      assembler(h.pid).push(u8, h.payload, h.end, h.pusi, off + (h.payload - p), 0);
      return;
    }
    const s = streamOf(h.pid);
    if (!s || !s.pes) return;
    let c = capture.get(h.pid);
    if (h.pusi) {
      const ph = pesHeader(u8, h.payload, h.end);
      if (ph && ph.pts >= 0 && !firstPts.has(h.pid)) firstPts.set(h.pid, { pts: ph.pts, dts: ph.dts >= 0 ? ph.dts : ph.pts, offset: off });
      if (configs.has(h.pid)) return;
      if (!c) {
        c = { parts: [], len: 0, tries: 0, active: false };
        capture.set(h.pid, c);
      } else if (c.active) finishCapture(h.pid, c, s);
      if (configs.has(h.pid) || c.tries >= 12) {
        c.active = false;
        return;
      }
      c.active = !!ph;
      if (ph && ph.hdrEnd < h.end) {
        c.parts.push(u8.slice(ph.hdrEnd, h.end));
        c.len += h.end - ph.hdrEnd;
      }
      return;
    }
    if (!c || !c.active) return;
    const limit = s.kind === 'video' ? 256 * 1024 : 8 * 1024;
    if (c.len >= limit) {
      finishCapture(h.pid, c, s);
      c.active = false;
      return;
    }
    c.parts.push(u8.slice(h.payload, h.end));
    c.len += h.end - h.payload;
  }, { shouldStop, chunkBytes: 256 * 1024, onProgress });

  // Streams whose last capture was still open when the scan stopped.
  for (const [pid, c] of capture) {
    if (c.active && !configs.has(pid)) {
      const s = streamOf(pid);
      if (s) finishCapture(pid, c, s);
    }
  }
  return {
    packets,
    bytes: packets * L.size,
    complete: packets >= L.count,
    configs,
    sniffed,
    firstPcr,
    firstPts,
    pidCounts,
  };
}

// ------------------------------------------------------------------ tail scan

/** Last PCR per PID and last PTS per PID, from the end of the file. */
export async function tailScan(source, L, fromPacket, maxPackets = 12000) {
  const lastPcr = new Map();
  const lastPts = new Map();
  const startPacket = Math.max(fromPacket, L.count - maxPackets);
  if (startPacket >= L.count) return { lastPcr, lastPts };
  await walkPackets(source, L, L.first + startPacket * L.size, L.first + L.count * L.size, (u8, p, off) => {
    const h = tsHeader(u8, p, L);
    if (h.pcr >= 0) lastPcr.set(h.pid, { pcr: h.pcr, offset: off });
    if (h.pusi && !h.tsc && h.payload < h.end) {
      const ph = pesHeader(u8, h.payload, h.end);
      if (ph && ph.pts >= 0) {
        const prev = lastPts.get(h.pid);
        const v = ph.pts;
        if (!prev || unwrap(v, prev.pts) > prev.pts) lastPts.set(h.pid, { pts: prev ? unwrap(v, prev.pts) : v, offset: off });
      }
    }
  }, { chunkBytes: 1024 * 1024 });
  return { lastPcr, lastPts };
}

// ------------------------------------------------------------------ growable arrays

class Grow {
  constructor(Type, n = 256) {
    this.Type = Type;
    this.a = new Type(n);
    this.n = 0;
  }

  push(v) {
    if (this.n === this.a.length) {
      const b = new this.Type(this.a.length * 2);
      b.set(this.a);
      this.a = b;
    }
    this.a[this.n++] = v;
  }

  get last() {
    return this.a[this.n - 1];
  }

  done() {
    return this.a.slice(0, this.n);
  }
}

// ------------------------------------------------------------------ audio framing

/**
 * Splits the byte stream of one PID into codec frames across PES packets,
 * like FFmpeg's parsers: each frame knows the file offset of its first and
 * last byte, and the PES packet it starts in.
 */
class Framer {
  constructor(family, onFrame) {
    this.sync = FRAME_SYNC[family];
    this.family = family;
    this.onFrame = onFrame;
    this.buf = new Uint8Array(1 << 16);
    this.len = 0;
    this.pos = 0;
    // segments: buffer index where each appended chunk starts, its file offset and PES index
    this.segStart = [];
    this.segOff = [];
    this.segPes = [];
    this.skipped = 0;
    this.resyncs = 0;
    this.state = {}; // codec state kept between frames (LATM configuration)
  }

  push(u8, a, b, fileOff, pes) {
    const n = b - a;
    if (this.len + n > this.buf.length) this._compact(n);
    this.buf.set(u8.subarray(a, b), this.len);
    this.segStart.push(this.len);
    this.segOff.push(fileOff);
    this.segPes.push(pes);
    this.len += n;
    this._frames();
  }

  _seg(i) {
    // Last segment starting at or before buffer index i (segments are few: binary search).
    let lo = 0;
    let hi = this.segStart.length - 1;
    let ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.segStart[mid] <= i) {
        ans = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return ans;
  }

  fileOffset(i) {
    const k = this._seg(i);
    return this.segOff[k] + (i - this.segStart[k]);
  }

  _frames() {
    const minHeader = 7;
    let lostAt = -1;
    while (this.len - this.pos >= minHeader) {
      const info = this.sync(this.buf, this.pos, this.len, this.state);
      if (!info || info.len <= 0) {
        if (lostAt < 0) lostAt = this.pos;
        this.pos++;
        this.skipped++;
        continue;
      }
      if (lostAt >= 0) {
        this.resyncs++;
        lostAt = -1;
      }
      if (this.pos + info.len > this.len) break;
      const k = this._seg(this.pos);
      const start = this.segOff[k] + (this.pos - this.segStart[k]);
      const end = this.fileOffset(this.pos + info.len - 1) + 1;
      this.onFrame(start, end, info.len, this.segPes[k], info);
      this.pos += info.len;
    }
  }

  _compact(extra) {
    // Drop consumed bytes (and the segments that are fully consumed).
    const keepFrom = this.pos;
    const k = this._seg(keepFrom);
    const rest = this.len - keepFrom;
    let size = this.buf.length;
    while (rest + extra > size) size *= 2;
    if (size === this.buf.length) this.buf.copyWithin(0, keepFrom, this.len);
    else {
      const nb = new Uint8Array(size);
      nb.set(this.buf.subarray(keepFrom, this.len));
      this.buf = nb;
    }
    const ss = [];
    const so = [];
    const sp = [];
    for (let i = k; i < this.segStart.length; i++) {
      const st = this.segStart[i] - keepFrom;
      ss.push(Math.max(0, st));
      so.push(st < 0 ? this.segOff[i] - st : this.segOff[i]);
      sp.push(this.segPes[i]);
    }
    this.segStart = ss;
    this.segOff = so;
    this.segPes = sp;
    this.len = rest;
    this.pos = 0;
  }

  /** Bytes left over at the end (an incomplete last frame). */
  get leftover() {
    return this.len - this.pos;
  }
}

// ------------------------------------------------------------------ full scan

const KIND_NONE = 0;
const KIND_SECTIONS = 1;
const KIND_ES = 2;

function newPidState(pid) {
  return {
    pid, kind: KIND_NONE, track: null, packets: 0, payload: 0, pusi: 0, afOnly: 0, scrambled: 0, tei: 0, rai: 0,
    disc: 0, pcrs: 0, cc: -1, dupRun: 0, dups: 0, ccErrors: 0, badAf: 0, afc0: 0, first: -1, last: -1,
    asm: null, pes: null, framer: null, noStartCode: 0, orphan: 0, excess: 0, truncatedPes: 0, pesCount: 0,
    lastTs: null, maxPtsGap: 0, maxPtsGapAt: -1, prevDts: null, tsJumps: 0, tsJumpAt: [], headBuf: null,
  };
}

/**
 * Scan every packet. `doc` provides: source, layout (L), model (ProgramModel),
 * tracks (with .pid, .kind, .family, .framing) and trackForStream(stream) to add
 * tracks for streams discovered during the scan. Returns { stats, samples: Map(track -> table), pes: Map(track -> table) }.
 */
export async function fullScan(doc, onProgress) {
  const L = doc.layout;
  const model = doc.model;
  model.resetCounts();
  const S = L.size;
  const so = L.syncOffset;
  const states = new Array(8192);
  const trackState = new Map(); // track -> builders
  const stats = {
    packets: 0,
    nullPackets: 0,
    syncLosses: [],
    lostBytes: 0,
    ccErrors: new Map(), // packet offset -> { pid, expected, got, lost }
    ccErrorCount: 0,
    teiPackets: 0,
    teiFirst: [],
    pcr: new Map(), // pid -> pcr state
    psi: new Map(), // key -> { pid, tableId, program?, idx: Grow }
    scrambled: 0,
    states,
    sectionsSeen: 0,
  };

  const pcrState = (pid) => {
    let s = stats.pcr.get(pid);
    if (!s) {
      s = { pid, n: 0, last: -1, lastIndex: -1, lastOff: -1, first: -1, firstOff: -1, firstIndex: -1, min: Infinity, max: 0, sum: 0, intervals: 0, over100: 0, over40: 0, maxAtOff: -1, jumps: 0, discontinuities: 0, idx: new Grow(Float64Array, 1024), val: new Grow(Float64Array, 1024), off: new Grow(Float64Array, 1024), jumpOffsets: [] };
      stats.pcr.set(pid, s);
    }
    return s;
  };

  const psiOcc = (key, pid, tableId, program) => {
    let o = stats.psi.get(key);
    if (!o) {
      o = { key, pid, tableId, program, idx: new Grow(Float64Array, 256), off: new Grow(Float64Array, 256) };
      stats.psi.set(key, o);
    }
    return o;
  };

  const builders = (t) => {
    let b = trackState.get(t);
    if (!b) {
      b = {
        offsets: new Grow(Float64Array), ends: new Grow(Float64Array), sizes: new Grow(Uint32Array), pts: new Grow(Float64Array),
        dts: new Grow(Float64Array), key: new Grow(Uint8Array), rai: new Grow(Uint8Array), pesIndex: new Grow(Uint32Array),
        first: new Grow(Uint8Array), samplesPer: new Grow(Float64Array),
        pes: {
          offsets: new Grow(Float64Array), index: new Grow(Float64Array), esStart: new Grow(Float64Array), esEnd: new Grow(Float64Array),
          sizes: new Grow(Uint32Array), pts: new Grow(Float64Array), dts: new Grow(Float64Array), packets: new Grow(Uint32Array), rai: new Grow(Uint8Array),
        },
        lastFramePes: -1, exactPts: NaN, keyFrames: 0,
      };
      trackState.set(t, b);
    }
    return b;
  };

  // --- roles: which PIDs carry sections and which carry PES of a track
  const assign = () => {
    for (const s of model.streams()) {
      const t = doc.trackForStream(s);
      const ps = states[s.pid] ?? (states[s.pid] = newPidState(s.pid));
      if (s.sections) {
        if (ps.kind !== KIND_SECTIONS) {
          ps.kind = KIND_SECTIONS;
          ps.asm = makeAssembler(ps);
        }
        ps.track = t;
      } else if (ps.kind !== KIND_ES || ps.track !== t) {
        ps.kind = KIND_ES;
        ps.track = t;
        ps.framer = t?.framing ? new Framer(t.framing, (a, b, n, pesIdx, info) => onFrame(ps, a, b, n, pesIdx, info)) : null;
      }
    }
    const section = [0, 1, 2, 0x10, 0x11, 0x12, 0x13, 0x14, 0x1ffb, ...model.pmtPids.keys(), ...model.ecmPids.keys(), ...model.emmPids.keys()];
    if (model.nitPid !== null) section.push(model.nitPid);
    for (const pid of section) {
      const ps = states[pid] ?? (states[pid] = newPidState(pid));
      if (ps.kind === KIND_ES) continue;
      if (ps.kind !== KIND_SECTIONS) {
        ps.kind = KIND_SECTIONS;
        ps.asm = makeAssembler(ps);
      }
    }
  };

  function makeAssembler(ps) {
    return new SectionAssembler((bytes, off, index) => {
      stats.sectionsSeen++;
      const tableId = bytes[0];
      if (tableId === 0xff) return;
      const program = tableId === 0x02 && bytes.length > 5 ? (bytes[3] << 8) | bytes[4] : undefined;
      const key = tableId === 0x02 ? `pmt:${program}` : `${ps.pid}:${tableId}`;
      const o = psiOcc(key, ps.pid, tableId, program);
      o.idx.push(index);
      o.off.push(off);
      const before = model.streams().length;
      const pmtCount = model.pmtPids.size;
      const info = model.onSection(ps.pid, bytes, off);
      if (info && (tableId === 0x00 || tableId === 0x02 || tableId === 0x01)) {
        if (model.streams().length !== before || model.pmtPids.size !== pmtCount || tableId !== 0x00) assign();
      }
      if (ps.track) {
        // Section-based elementary stream (SCTE-35, private sections): one sample per section.
        const b = builders(ps.track);
        const t90 = currentTime90(ps.track.pcrPid);
        b.offsets.push(off);
        b.ends.push(off + bytes.length);
        b.sizes.push(bytes.length);
        b.pts.push(t90);
        b.dts.push(t90);
        b.key.push(1);
        b.rai.push(0);
        b.pesIndex.push(b.offsets.n - 1);
        b.first.push(1);
        b.samplesPer.push(0);
      }
    });
  }

  const currentTime90 = (pcrPid) => {
    const p = stats.pcr.get(pcrPid) ?? stats.pcr.values().next().value;
    return p && p.last >= 0 ? Math.floor(p.last / 300) : NaN;
  };

  // --- frames
  function onFrame(ps, start, end, size, pesIdx, info) {
    const t = ps.track;
    const b = builders(t);
    const pesPts = b.pes.pts;
    // E-AC-3 dependent substreams belong to the preceding independent frame.
    if (info.dependent && b.offsets.n > 0) {
      b.ends.a[b.ends.n - 1] = end;
      b.sizes.a[b.sizes.n - 1] += size;
      return;
    }
    const firstInPes = pesIdx !== b.lastFramePes;
    let pts;
    if (firstInPes && pesIdx < pesPts.n && pesPts.a[pesIdx] >= 0) pts = pesPts.a[pesIdx];
    else if (Number.isFinite(b.exactPts)) pts = b.exactPts;
    else pts = NaN;
    b.lastFramePes = pesIdx;
    const dur = info.rate ? (info.samples * 90000) / info.rate : NaN;
    b.exactPts = Number.isFinite(pts) && Number.isFinite(dur) ? pts + dur : NaN;
    const shown = Number.isFinite(pts) ? Math.round(pts) : NaN;
    b.offsets.push(start);
    b.ends.push(end);
    b.sizes.push(size);
    b.pts.push(shown);
    b.dts.push(shown);
    b.key.push(1);
    b.rai.push(firstInPes && pesIdx < b.pes.rai.n ? b.pes.rai.a[pesIdx] : 0);
    b.pesIndex.push(pesIdx);
    b.first.push(firstInPes ? 1 : 0);
    b.samplesPer.push(dur);
  }

  // --- PES packets
  function startPes(ps, hdr, pktOff, index, rai) {
    const t = ps.track;
    const b = builders(t);
    let pts = -1;
    let dts = -1;
    if (hdr.pts >= 0) {
      pts = unwrap(hdr.pts, ps.lastTs);
      dts = hdr.dts >= 0 ? unwrap(hdr.dts, pts) : pts;
      if (ps.prevDts !== null) {
        // Decode times only move forward: a gap is a stretch without timestamps,
        // a step back (or a huge leap) is a discontinuity of the time base.
        const d = dts - ps.prevDts;
        if (d < -45000 || d > 90000 * 60) {
          ps.tsJumps++;
          if (ps.tsJumpAt.length < 20) ps.tsJumpAt.push(pktOff);
        } else if (d > ps.maxPtsGap) {
          ps.maxPtsGap = d;
          ps.maxPtsGapAt = pktOff;
        }
      }
      ps.prevDts = dts;
      ps.lastTs = dts;
    }
    const pes = {
      pktOff, index, pts, dts, rai: rai ? 1 : 0, esFirst: -1, esEnd: -1, size: 0, packets: 1,
      remaining: -1, hdr: null, hdrLen: 0, idx: b.pes.offsets.n, keyDone: false, key: false, keyFound: false, headLen: 0, nextCheck: 1, scrambled: hdr.scrambled,
    };
    b.pes.offsets.push(pktOff);
    b.pes.index.push(index);
    b.pes.pts.push(pts);
    b.pes.dts.push(dts);
    b.pes.rai.push(pes.rai);
    ps.pesCount++;
    return pes;
  }

  function esBytes(ps, u8, a, bEnd, fileA) {
    const pes = ps.pes;
    let b = bEnd;
    if (pes.remaining >= 0) {
      if (pes.remaining === 0) {
        ps.excess += b - a;
        return;
      }
      if (b - a > pes.remaining) {
        ps.excess += b - a - pes.remaining;
        b = a + pes.remaining;
      }
      pes.remaining -= b - a;
    }
    if (b <= a) return;
    if (pes.esFirst < 0) pes.esFirst = fileA;
    pes.esEnd = fileA + (b - a);
    pes.size += b - a;
    const t = ps.track;
    if (!t) return;
    if (ps.framer) {
      ps.framer.push(u8, a, b, fileA, pes.idx);
    } else if (t.kind === 'video' && t.family && !pes.keyDone) {
      let hb = ps.headBuf;
      if (!hb) hb = ps.headBuf = new Uint8Array(64 * 1024);
      const take = Math.min(b - a, hb.length - pes.headLen);
      hb.set(u8.subarray(a, a + take), pes.headLen);
      pes.headLen += take;
      if (pes.headLen >= pes.nextCheck || pes.headLen >= hb.length) {
        const k = videoKeyInfo(t.family, hb, 0, pes.headLen);
        if (k.found || pes.headLen >= hb.length) {
          pes.keyDone = true;
          pes.key = k.key;
          pes.keyFound = k.found;
        } else pes.nextCheck = pes.headLen * 2;
      }
    }
  }

  function finishPes(ps) {
    const pes = ps.pes;
    ps.pes = null;
    if (!pes) return;
    const t = ps.track;
    if (pes.remaining > 0) ps.truncatedPes++;
    if (!t) return;
    const b = builders(t);
    b.pes.esStart.push(pes.esFirst);
    b.pes.esEnd.push(pes.esEnd);
    b.pes.sizes.push(pes.size);
    b.pes.packets.push(pes.packets);
    if (ps.framer || pes.size === 0) return;
    // One sample per PES packet (video, subtitles, data, audio that is not split).
    let key = 1;
    if (t.kind === 'video') {
      if (!pes.keyDone && t.family && ps.headBuf && pes.headLen) {
        const k = videoKeyInfo(t.family, ps.headBuf, 0, pes.headLen);
        pes.key = k.key;
        pes.keyFound = k.found;
      }
      key = pes.keyFound ? (pes.key ? 1 : 0) : pes.rai;
    }
    b.offsets.push(pes.esFirst);
    b.ends.push(pes.esEnd);
    b.sizes.push(pes.size);
    b.pts.push(pes.pts >= 0 ? pes.pts : NaN);
    b.dts.push(pes.dts >= 0 ? pes.dts : NaN);
    b.key.push(key);
    b.rai.push(pes.rai);
    b.pesIndex.push(pes.idx);
    b.first.push(1);
    b.samplesPer.push(NaN);
  }

  function esPayload(ps, u8, a, b, pusi, fileA, pktOff, index, rai) {
    if (pusi) {
      if (ps.pes) finishPes(ps);
      ps.pusi++;
      const hdr = pesHeader(u8, a, b);
      if (!hdr) {
        ps.noStartCode++;
        return;
      }
      const pes = startPes(ps, hdr, pktOff, index, rai);
      ps.pes = pes;
      if (hdr.split) {
        // The PES header continues in the next packet: collect it first.
        pes.hdr = new Uint8Array(9 + 255);
        pes.hdr.set(u8.subarray(a, b));
        pes.hdrLen = b - a;
        return;
      }
      if (hdr.length) pes.remaining = hdr.length - (hdr.hdrEnd - (a + 6));
      esBytes(ps, u8, hdr.hdrEnd, b, fileA + (hdr.hdrEnd - a));
      return;
    }
    const pes = ps.pes;
    if (!pes) {
      ps.orphan += b - a;
      return;
    }
    pes.packets++;
    if (pes.hdr) {
      // Complete a split PES header.
      let q = a;
      const need = () => (pes.hdrLen >= 9 ? 9 + pes.hdr[8] : 9);
      while (q < b && pes.hdrLen < need()) pes.hdr[pes.hdrLen++] = u8[q++];
      if (pes.hdrLen < need()) return;
      const hdr = pesHeader(pes.hdr, 0, pes.hdrLen);
      pes.hdr = null;
      if (hdr && hdr.pts >= 0) {
        const t = ps.track;
        const bld = builders(t);
        pes.pts = unwrap(hdr.pts, ps.lastTs);
        pes.dts = hdr.dts >= 0 ? unwrap(hdr.dts, pes.pts) : pes.pts;
        ps.lastTs = pes.dts;
        bld.pes.pts.a[pes.idx] = pes.pts;
        bld.pes.dts.a[pes.idx] = pes.dts;
      }
      if (hdr && hdr.length) pes.remaining = hdr.length - (hdr.hdrEnd - 6);
      esBytes(ps, u8, q, b, fileA + (q - a));
      return;
    }
    esBytes(ps, u8, a, b, fileA);
  }

  function onPcr(ps, raw, index, off, disc) {
    ps.pcrs++;
    const s = pcrState(ps.pid);
    const v = s.last >= 0 ? unwrap(raw, s.last, PCR_WRAP) : raw;
    if (s.first < 0) {
      s.first = v;
      s.firstOff = off;
      s.firstIndex = index;
    }
    if (disc) s.discontinuities++;
    if (s.last >= 0 && !disc) {
      const d = v - s.last;
      if (d <= 0 || d > PCR_HZ * 10) {
        s.jumps++;
        if (s.jumpOffsets.length < 50) s.jumpOffsets.push(off);
      } else {
        s.intervals++;
        s.sum += d;
        if (d < s.min) s.min = d;
        if (d > s.max) {
          s.max = d;
          s.maxAtOff = off;
        }
        if (d > PCR_HZ / 10) s.over100++;
        if (d > PCR_HZ * 0.04) s.over40++;
      }
    }
    s.n++;
    s.last = v;
    s.lastIndex = index;
    s.lastOff = off;
    s.idx.push(index);
    s.val.push(v);
    s.off.push(off);
  }

  assign();

  const onPacket = (u8, p, off, index) => {
    const s = p + so;
    const b1 = u8[s + 1];
    const b3 = u8[s + 3];
    const pid = ((b1 & 0x1f) << 8) | u8[s + 2];
    stats.packets++;
    let ps = states[pid];
    if (!ps) ps = states[pid] = newPidState(pid);
    ps.packets++;
    if (ps.first < 0) ps.first = off;
    ps.last = off;
    if (b1 & 0x80) {
      ps.tei++;
      stats.teiPackets++;
      if (stats.teiFirst.length < 20) stats.teiFirst.push(off);
    }
    if (pid === NULL_PID) {
      stats.nullPackets++;
      return;
    }
    const afc = (b3 >> 4) & 3;
    const cc = b3 & 15;
    const end = s + 188;
    let pay = s + 4;
    let disc = 0;
    let rai = 0;
    if (afc & 2) {
      const len = u8[s + 4];
      if (len > 0) {
        const f = u8[s + 5];
        disc = f & 0x80;
        rai = f & 0x40;
        if (disc) ps.disc++;
        if (rai) ps.rai++;
        if (f & 0x10 && len >= 7) onPcr(ps, readPcr(u8, s + 6), index, off, disc);
      }
      pay = s + 5 + len;
      if (len > 183 || (afc === 3 && len > 182)) {
        ps.badAf++;
        pay = end;
      }
    }
    if (afc === 0) {
      ps.afc0++;
      return;
    }
    // Continuity counter (ISO/IEC 13818-1 § 2.4.3.3): +1 per packet with payload, unchanged otherwise.
    let lost = false;
    let dup = false;
    if (ps.cc >= 0 && !disc) {
      if (afc & 1) {
        const exp = (ps.cc + 1) & 15;
        if (cc === ps.cc) {
          if (ps.dupRun >= 1) ccError(ps, off, exp, cc);
          else dup = true;
          ps.dupRun++;
        } else {
          if (cc !== exp) {
            ccError(ps, off, exp, cc);
            lost = true;
          }
          ps.dupRun = 0;
        }
      } else if (cc !== ps.cc) ccError(ps, off, ps.cc, cc);
    }
    ps.cc = cc;
    if (!(afc & 1)) {
      ps.afOnly++;
      return;
    }
    if (pay >= end) return;
    if (dup) {
      ps.dups++;
      return;
    }
    if (b3 >> 6) {
      ps.scrambled++;
      stats.scrambled++;
      if (ps.pes && ps.kind === KIND_ES) ps.pes.scrambled = 1;
      return;
    }
    const pusi = b1 & 0x40;
    ps.payload += end - pay;
    if (ps.kind === KIND_ES) {
      if (lost && ps.pes) ps.pes.damaged = true;
      esPayload(ps, u8, pay, end, pusi, off + (pay - p), off, index, rai);
    } else if (ps.kind === KIND_SECTIONS) {
      ps.asm.push(u8, pay, end, pusi, off + (pay - p), index, lost);
    } else if (pusi) {
      ps.pusi++;
    }
  };

  function ccError(ps, off, expected, got) {
    ps.ccErrors++;
    stats.ccErrorCount++;
    if (stats.ccErrors.size < 20000) stats.ccErrors.set(off, { pid: ps.pid, expected, got, lost: (got - expected + 16) & 15 });
  }

  await walkPackets(doc.source, L, L.first, L.first + L.count * S, onPacket, {
    onProgress,
    onLost: (a, b) => {
      stats.lostBytes += b - a;
      if (stats.syncLosses.length < 1000) stats.syncLosses.push({ from: a, to: b });
    },
  });

  // Flush the PES packets that were open at the end of the file.
  let leftover = 0;
  for (const ps of states) {
    if (!ps) continue;
    if (ps.kind === KIND_ES && ps.pes) finishPes(ps);
    if (ps.framer) leftover += ps.framer.leftover;
  }
  stats.leftoverAudioBytes = leftover;

  // Build the sample tables.
  const samples = new Map();
  const pes = new Map();
  for (const [t, b] of trackState) {
    const n = b.offsets.n;
    const dts = b.dts.done();
    const ptsArr = b.pts.done();
    const durations = new Float64Array(n);
    const per = b.samplesPer.done();
    let anyCto = false;
    const cto = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      const d = ptsArr[i] - dts[i];
      if (Number.isFinite(d) && d !== 0) {
        cto[i] = d;
        anyCto = true;
      }
    }
    if (t.framing || t.sections) {
      for (let i = 0; i < n; i++) durations[i] = Number.isFinite(per[i]) ? per[i] : 0;
      if (t.sections) for (let i = 0; i + 1 < n; i++) durations[i] = Math.max(0, dts[i + 1] - dts[i]);
    } else {
      // Video and other PES-level samples: the distance to the next decode time.
      let lastGood = 0;
      for (let i = 0; i < n; i++) {
        const d = i + 1 < n ? dts[i + 1] - dts[i] : NaN;
        if (Number.isFinite(d) && d > 0 && d < 90000 * 10) {
          durations[i] = d;
          lastGood = d;
        } else durations[i] = lastGood;
      }
    }
    samples.set(t, {
      count: n,
      timescale: 90000,
      offsets: b.offsets.done(),
      ends: b.ends.done(),
      sizes: b.sizes.done(),
      dts,
      pts: ptsArr,
      cto: anyCto ? cto : null,
      durations,
      key: b.key.done(),
      rai: b.rai.done(),
      pesIndex: b.pesIndex.done(),
      firstInPes: b.first.done(),
      placed: n,
      problems: [],
      source: t.framing ? `frames split from PES packets (${t.framing})` : t.sections ? 'sections' : 'PES packets',
    });
    pes.set(t, {
      count: b.pes.offsets.n,
      offsets: b.pes.offsets.done(),
      index: b.pes.index.done(),
      esStart: b.pes.esStart.done(),
      esEnd: b.pes.esEnd.done(),
      sizes: b.pes.sizes.done(),
      pts: b.pes.pts.done(),
      dts: b.pes.dts.done(),
      packets: b.pes.packets.done(),
      rai: b.pes.rai.done(),
    });
  }
  for (const [, p] of stats.pcr) {
    p.idxArr = p.idx.done();
    p.valArr = p.val.done();
    p.offArr = p.off.done();
    delete p.idx;
    delete p.val;
    delete p.off;
  }
  for (const [, o] of stats.psi) {
    o.idxArr = o.idx.done();
    o.offArr = o.off.done();
    delete o.idx;
    delete o.off;
  }
  return { stats, samples, pes };
}
