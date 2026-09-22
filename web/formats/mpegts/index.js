// MPEG transport streams (ISO/IEC 13818-1): .ts, .m2ts/.mts (BDAV, 192-byte
// packets) and 204-byte captures. A file holds millions of 188-byte packets, so
// the tree is built from lazy groups of packets; the program structure comes
// from a scan of the first packets, and the frame list from loadSamples().

import { Node, fieldsAt } from '../../core/model.js';
import { FieldReader, ParseError } from '../../core/fields.js';
import { Doc } from '../../core/doc.js';
import { fmtInt, fmtNum, fmtDuration, fmtBitrate, hex } from '../../core/util.js';
import { parseSample } from '../../codecs/index.js';
import { detectLayout } from './layout.js';
import { ProgramModel, describeProgram } from './program.js';
import { initialScan, tailScan, fullScan, framingOf } from './scan.js';
import { buildPacketNode, tsHeader, pesHeader } from './packet.js';
import { GROUP, REGIONS, sectionDef } from './defs.js';
import { readSection } from './psi.js';
import { SYNC_BYTE, NULL_PID, PTS_HZ, PCR_HZ, hexPid, codecDisplay, streamIdName } from './tables.js';
import { eac3Unit, mpeg2Units, latmUnit, ac3Sync } from './es.js';
import { fmtTs, fmtPcrTime, unwrap } from './text.js';
import { insights } from './insights.js';
import { glossary } from './glossary.js';

const LEAF = 4096; // packets per group
const SUPER = 256; // groups per super-group, used when there are very many packets
const MAX_FRAME_READ = 16 * 1024 * 1024;

const KIND_LABEL = { video: 'Video', audio: 'Audio', subtitle: 'Subtitle', data: 'Data' };

function probe(head, source) {
  const L = detectLayout(head, source?.size ?? head.length);
  if (!L) return 0;
  if (L.matches >= 8) return L.first === 0 ? 95 : 85;
  if (L.matches === L.possible && L.matches >= 3) return 70;
  if (L.matches === L.possible && L.matches >= 2) return 25;
  return 0;
}

class TsDoc extends Doc {
  constructor(o) {
    super(o);
    this.unitCache = new Map();
    this.samplesLoaded = false;
    this.stats = null;
    this._roles = null;
  }

  // ---------------------------------------------------------------- roles & tracks

  /** What a PID carries: { kind, short, label, psi?, pes?, family?, track? } or null. */
  roleOf(pid) {
    if (!this._roles || this._rolesRev !== this.model.revision) this._buildRoles();
    return this._roles.get(pid) ?? this._describe(pid);
  }

  _describe(pid) {
    const r = this.model.describePid(pid);
    if (r) this._roles.set(pid, r);
    return r;
  }

  _buildRoles() {
    this._roles = new Map();
    this._rolesRev = this.model.revision;
    for (const s of this.model.streams()) this.trackForStream(s);
    for (const t of this.tracks) {
      const pcr = this.model.pcrPids().has(t.pid);
      this._roles.set(t.pid, {
        kind: t.sections ? (t.codec === 'scte_35' ? 'scte35' : 'sections') : t.kind,
        short: t.label,
        label: `${t.label} (${t.codecName}${t.program !== undefined ? `, program ${t.program}` : ''})${pcr ? ', carries the PCR' : ''}`,
        pes: !t.sections,
        psi: !!t.sections,
        family: t.family,
        track: t,
        category: t.codec === 'scte_35' ? 'meta' : 'media',
      });
    }
  }

  /** The track for an elementary stream of the PMT, created on first use. */
  trackForStream(s) {
    let t = this.tracksByPid.get(s.pid);
    if (t) return t;
    const sn = this.init?.sniffed?.get(s.pid);
    const codec = sn?.codec ?? s.codec;
    const family = sn?.family ?? s.family ?? null;
    const kind = sn ? 'audio' : s.kind;
    const n = (this.kindCount[kind] = (this.kindCount[kind] ?? 0) + 1);
    const prog = this.model.programs.get(s.program);
    t = {
      id: s.pid,
      index: this.tracks.length,
      pid: s.pid,
      kind,
      codec,
      codecName: codecDisplay(codec) + (sn ? ' (detected from the payload)' : ''),
      label: `${KIND_LABEL[kind] ?? 'Data'} ${n} – ${codec}`,
      program: s.program,
      pcrPid: prog?.pcrPid,
      streamType: s.type,
      typeName: s.typeName,
      how: sn ? 'guessed from the payload (the PMT does not say)' : s.how,
      family,
      framing: framingOf(family),
      sections: !!s.sections,
      descriptors: s.descriptors ?? [],
      language: s.descriptors?.find((d) => d.tag === 0x0a)?.langs?.[0]?.code ?? s.descriptors?.find((d) => d.tag === 0x59)?.subtitles?.[0]?.lang ?? null,
      config: this.init?.configs?.get(s.pid) ?? null,
      node: this.groupAt(this.init?.firstOffset?.get(s.pid) ?? this.layout.first),
      offset: this.init?.firstOffset?.get(s.pid) ?? null,
      encrypted: !!s.encrypted,
    };
    const cfg = t.config;
    if (cfg?.codecString) t.codecString = cfg.codecString;
    if (cfg?.profile) t.profile = cfg.profile;
    if (cfg?.sps) t.sps = cfg.sps;
    t.sampleCfg = sampleCfgFor(t);
    t.props = this.trackProps(t);
    this.tracks.push(t);
    this.tracksByPid.set(t.pid, t);
    this._roles?.delete(t.pid);
    if (this._roles) this._rolesRev = -1;
    return t;
  }

  trackProps(t) {
    const p = [];
    p.push(['PID', `${hexPid(t.pid)} (${t.pid})`]);
    if (t.program !== undefined) p.push(['program', describeProgram(this.model, t.program)]);
    p.push(['stream_type', `0x${t.streamType.toString(16).padStart(2, '0').toUpperCase()} — ${t.typeName}`]);
    p.push(['codec', `${t.codecName}${t.how && !t.how.startsWith('stream_type') ? ` (from the ${t.how})` : ''}`]);
    if (t.codecString) p.push(['codec string', t.codecString]);
    for (const [k, v] of t.config?.props ?? []) p.push([k, v]);
    if (t.language) p.push(['language', t.language]);
    const ds = t.descriptors.map((d) => d.summary ?? d.name);
    if (ds.length) p.push(['descriptors', ds.join('; ')]);
    if (t.pcrPid === t.pid) p.push(['PCR', 'this PID carries the program clock (PCR)']);
    if (t.encrypted) p.push(['encryption', 'HLS SAMPLE-AES (per the stream_type)']);
    const st = this.stats?.states?.[t.pid];
    const s = t.samples;
    if (s) {
      const pes = t.pes;
      if (pes) p.push(['PES packets', fmtInt(pes.count)]);
      p.push([t.sections ? 'sections' : t.framing ? 'frames' : 'samples', `${fmtInt(s.count)}${t.framing ? ' (split from the PES packets like FFmpeg’s parser)' : ''}`]);
      if (t.kind === 'video' && s.count) {
        let k = 0;
        for (let i = 0; i < s.count; i++) k += s.key[i];
        p.push(['key frames', `${fmtInt(k)}${k ? ` (every ${fmtNum(s.count / k, 1)} frames on average)` : ''}`]);
        if (t.fps) p.push(['frame rate', `${fmtNum(t.fps, 3)} fps (from DTS spacing)`]);
      }
      if (t.startPts !== undefined) p.push(['first PTS', fmtTs(t.startPts)]);
      if (t.duration) p.push(['duration', fmtDuration(t.duration)]);
      if (t.bytes) p.push(['media bytes', `${fmtInt(t.bytes)} (${((t.bytes / this.size) * 100).toFixed(2)}% of file)`]);
      if (t.bitrate) p.push(['average bitrate', fmtBitrate(t.bitrate)]);
      if (s.cto) p.push(['reordering', 'yes (PTS ≠ DTS: B-frames)']);
    }
    if (st) {
      p.push(['TS packets', `${fmtInt(st.packets)} (${((st.packets / (this.stats.packets || 1)) * 100).toFixed(2)}% of all packets)`]);
      if (st.ccErrors) p.push(['continuity errors', fmtInt(st.ccErrors)]);
      if (st.scrambled) p.push(['scrambled packets', fmtInt(st.scrambled)]);
    }
    return p;
  }

  // ---------------------------------------------------------------- tree helpers

  /** The top-level node (group or region) containing `offset`. */
  groupAt(offset) {
    const kids = this.root.children ?? [];
    for (const c of kids) if (offset >= c.offset && offset < c.end) return c;
    return kids[0] ?? this.root;
  }

  packetContext(ccTracking = true) {
    return {
      L: this.layout,
      roleOf: (pid) => this.roleOf(pid),
      psiCtx: { hdmv: this.model.hdmv, dvb: this.model.dvb },
      pending: new Map(),
      cc: ccTracking ? new Map() : null,
      ccErrors: this.stats?.ccErrors ?? null,
      frameIndex: this.samplesLoaded ? (t, off) => (t?.samples ? this.sampleAt(t, off) : undefined) : null,
      frameKey: this.samplesLoaded ? (t, off) => {
        if (!t?.samples) return undefined;
        const i = this.sampleAt(t, off);
        return i >= 0 && t.samples.offsets[i] === off ? t.samples.key[i] : undefined;
      } : null,
    };
  }

  async loadGroup(g) {
    const L = this.layout;
    const S = L.size;
    const u8 = await this.source.read(g.offset, g.size);
    const ctx = this.packetContext();
    let p = 0;
    let index = g.data.firstIndex;
    while (p + S <= u8.length) {
      if (u8[p + L.syncOffset] !== SYNC_BYTE) {
        let q = p + 1;
        for (; q + L.syncOffset < u8.length; q++) {
          if (u8[q + L.syncOffset] !== SYNC_BYTE) continue;
          const nx = q + L.syncOffset + S;
          if (nx >= u8.length || u8[nx] === SYNC_BYTE) break;
        }
        const e = Math.min(u8.length, q);
        g.add(regionNode('junk', g.offset + p, e - p, p === 0
          ? `No packet starts at the beginning of this group: these ${fmtInt(e - p)} bytes are damaged, or the end of a packet that began in the previous group (after a sync loss earlier in the file, packets no longer line up with the fixed-size groups).`
          : `${fmtInt(e - p)} bytes where the sync byte 0x47 does not repeat every ${S} bytes.`));
        index += Math.round((e - p) / S);
        p = e;
        continue;
      }
      g.add(buildPacketNode(ctx, u8, p, g.offset + p, index));
      p += S;
      index++;
    }
    if (p < u8.length) g.add(regionNode('junk', g.offset + p, u8.length - p, 'The start of a packet that continues in the next group, or damaged bytes.'));
    this.recount();
  }

  // ---------------------------------------------------------------- samples

  async loadSamples(onProgress) {
    if (this._loading) return this._loading;
    this._loading = (async () => {
      const res = await fullScan(this, onProgress);
      this.stats = res.stats;
      for (const t of this.tracks) {
        t.samples = res.samples.get(t) ?? { count: 0, timescale: 90000, offsets: new Float64Array(0), ends: new Float64Array(0), sizes: new Uint32Array(0), dts: new Float64Array(0), pts: new Float64Array(0), durations: new Float64Array(0), key: new Uint8Array(0), cto: null, pesIndex: new Uint32Array(0), firstInPes: new Uint8Array(0), rai: new Uint8Array(0), placed: 0, problems: [] };
        t.pes = res.pes.get(t) ?? null;
        derive(t, this);
      }
      this.samplesLoaded = true;
      this.timeline = buildTimeline(this.stats);
      this.summary.duration = durationOf(this) ?? this.summary.duration;
      for (const t of this.tracks) t.props = this.trackProps(t);
      this._roles = null;
      this.labelGroups();
      this.unitCache.clear();
    })();
    return this._loading;
  }

  /** Time (27 MHz, from the PCR) at a packet index, or NaN. */
  pcrAtIndex(i) {
    const tl = this.timeline;
    if (!tl) return NaN;
    const { idx, val } = tl;
    const n = idx.length;
    if (n === 0) return NaN;
    if (n === 1) return val[0] + (i - idx[0]) * tl.ticksPerPacket;
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (idx[mid] <= i) lo = mid;
      else hi = mid - 1;
    }
    let a = lo;
    if (a >= n - 1) a = n - 2;
    const b = a + 1;
    const span = idx[b] - idx[a];
    const rate = span > 0 ? (val[b] - val[a]) / span : tl.ticksPerPacket;
    return val[a] + (i - idx[a]) * (rate > 0 && rate < PCR_HZ ? rate : tl.ticksPerPacket);
  }

  labelGroups() {
    const t0 = this.timeline?.val?.[0];
    if (t0 === undefined) return;
    const visit = (list) => {
      for (const g of list ?? []) {
        if (g.type !== 'packets') continue;
        const a = this.pcrAtIndex(g.data.firstIndex);
        const b = this.pcrAtIndex(g.data.lastIndex);
        if (Number.isFinite(a) && Number.isFinite(b)) g.label = `${fmtDuration(Math.max(0, a - t0) / PCR_HZ)}–${fmtDuration(Math.max(0, b - t0) / PCR_HZ)}`;
        if (g.data.super) visit(g.children);
      }
    };
    visit(this.root.children);
  }

  /** Index of the sample of track t whose byte range contains `offset`, or -1. */
  sampleAt(t, offset) {
    const s = t.samples;
    if (!s || !s.count) return -1;
    let lo = 0;
    let hi = s.count - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (s.offsets[mid] <= offset) {
        ans = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return ans >= 0 && offset < s.ends[ans] ? ans : -1;
  }

  /**
   * Collect the bytes of sample i of track t from the packets it spans (at most `max` of them);
   * returns { bytes, chunks }.
   */
  async frameBytes(t, i, max = MAX_FRAME_READ) {
    const s = t.samples;
    const L = this.layout;
    const S = L.size;
    const start = s.offsets[i];
    const end = s.ends[i];
    const size = s.sizes[i];
    const want = Math.min(size, max, MAX_FRAME_READ);
    const first = L.first + Math.floor((start - L.first) / S) * S;
    const last = L.first + Math.ceil((end - L.first) / S) * S; // end of the packet holding the last byte
    const span = await this.source.read(first, Math.min(last - first, Math.ceil((want / 184) + 2) * S));
    const out = new Uint8Array(want);
    const chunks = [];
    let w = 0;
    for (let p = 0; p + S <= span.length && w < out.length; p += S) {
      if (span[p + L.syncOffset] !== SYNC_BYTE) continue;
      const h = tsHeader(span, p, L);
      if (h.pid !== t.pid || h.tsc || h.payload >= h.end) continue;
      let a = h.payload;
      if (h.pusi) {
        const ph = pesHeader(span, a, h.end);
        if (ph) a = Math.min(h.end, ph.hdrEnd);
      }
      const fa = first + a;
      const fb = first + h.end;
      const lo = Math.max(fa, start);
      const hi = Math.min(fb, end);
      if (hi <= lo) continue;
      const n = Math.min(hi - lo, out.length - w);
      out.set(span.subarray(lo - first, lo - first + n), w);
      chunks.push({ es: w, file: lo, len: n });
      w += n;
    }
    return { bytes: out.subarray(0, w), chunks };
  }

  get framesContiguous() {
    return false;
  }

  async frameHead(t, i, n) {
    return (await this.frameBytes(t, i, n)).bytes;
  }

  async frameUnits(t, i) {
    const key = `${t.index}:${i}`;
    const hit = this.unitCache.get(key);
    if (hit) return hit;
    let units = [];
    let error = null;
    const fam = t.family;
    if (fam && t.samples.sizes[i] <= MAX_FRAME_READ) {
      const { bytes, chunks } = await this.frameBytes(t, i);
      const n = bytes.length;
      try {
        if (fam === 'avc' || fam === 'hevc' || fam === 'adts' || fam === 'mpa' || fam === 'ac3') {
          const res = parseSample(t.sampleCfg, bytes, 0, n, 0);
          units = res.units;
          error = res.error ?? null;
        } else if (fam === 'eac3') {
          for (let p = 0; p < n;) {
            const sy = ac3Sync(bytes, p, n);
            const e = sy ? Math.min(n, p + sy.len) : n;
            units.push(eac3Unit(bytes, p, e, 0));
            p = e;
          }
        } else if (fam === 'mpeg2v') units = mpeg2Units(bytes, 0, n, 0);
        else if (fam === 'latm') units = [latmUnit(bytes, 0, n, 0)];
      } catch (e) {
        error = e.message;
      }
      remapUnits(units, chunks);
    }
    if (error) units.error = error;
    if (this.unitCache.size > 512) this.unitCache.delete(this.unitCache.keys().next().value);
    this.unitCache.set(key, units);
    return units;
  }

  // ---------------------------------------------------------------- hex view

  /** Runs of frames inside packet payloads within [a, b), for the hex view. */
  overlay(a, b) {
    if (!this.samplesLoaded) return null;
    const L = this.layout;
    const S = L.size;
    const k0 = Math.max(0, Math.floor((a - L.first) / S));
    const k1 = Math.min(L.count, Math.ceil((b - L.first) / S));
    if (k1 <= k0) return null;
    const base = L.first + k0 * S;
    const u8 = this.source.readSync(base, (k1 - k0) * S);
    if (!u8) return null;
    const out = [];
    for (let k = k0; k < k1; k++) {
      const p = (k - k0) * S;
      if (p + S > u8.length) break;
      if (u8[p + L.syncOffset] !== SYNC_BYTE) continue;
      const h = tsHeader(u8, p, L);
      if (h.tsc || h.payload >= h.end || h.pid === NULL_PID) continue;
      const t = this.tracksByPid.get(h.pid);
      if (!t || !t.samples?.count || t.sections) continue;
      let es = h.payload;
      if (h.pusi) {
        const ph = pesHeader(u8, es, h.end);
        if (ph) es = Math.min(h.end, ph.hdrEnd);
      }
      let pos = Math.max(a, base + es);
      const stop = Math.min(b, base + h.end);
      while (pos < stop) {
        const i = this.sampleAt(t, pos);
        const s = t.samples;
        if (i < 0) {
          // Not in a frame: skip to the next frame start inside this payload, if any.
          const nx = nextSampleStart(s, pos);
          if (nx < 0 || nx >= stop) break;
          pos = nx;
          continue;
        }
        const e = Math.min(stop, s.ends[i]);
        const nextStart = i + 1 < s.count ? s.offsets[i + 1] : Infinity;
        const runEnd = Math.min(e, nextStart > pos ? nextStart : e);
        out.push({ start: pos, end: runEnd, track: t.index, sample: i, part: i & 1, first: pos === s.offsets[i], sampleStart: s.offsets[i], units: this.unitCache.get(`${t.index}:${i}`) ?? null });
        pos = runEnd;
      }
    }
    return out;
  }

  /** Parse (and cache) the codec units of the frames overlapping [a, b). True if anything new was parsed. */
  async ensureUnits(a, b) {
    if (!this.samplesLoaded) return false;
    const runs = this.overlay(a, b) ?? [];
    let changed = false;
    let n = 0;
    for (const r of runs) {
      const key = `${r.track}:${r.sample}`;
      if (this.unitCache.has(key)) continue;
      if (n++ >= 64) break;
      await this.frameUnits(this.tracks[r.track], r.sample);
      changed = true;
    }
    return changed;
  }

  // ---------------------------------------------------------------- details

  async detailAt(offset) {
    const L = this.layout;
    const S = L.size;
    if (offset < L.first) return regionDetail('leading', 0, L.first);
    const k = Math.floor((offset - L.first) / S);
    if (k >= L.count) return regionDetail('trailing', L.first + L.count * S, this.size);
    const pktOff = L.first + k * S;
    const u8 = await this.source.read(pktOff, S);
    if (u8.length < S) return null;
    const h = tsHeader(u8, 0, L);
    if (!h.sync) {
      return { kind: 'packet', title: `No packet at ${hex(pktOff)}`, range: [pktOff, pktOff + S], rows: [], text: 'The sync byte 0x47 is missing where this packet should start: the stream lost alignment here. Open the packet group in the tree to see where packets resume.' };
    }
    const role = this.roleOf(h.pid);
    const rel = offset - pktOff;
    let es = h.payload;
    let ph = null;
    if (h.pusi && !h.tsc && h.payload < h.end && role?.pes !== false) {
      ph = pesHeader(u8, h.payload, h.end);
      if (ph && role?.pes) es = Math.min(h.end, ph.hdrEnd);
    }
    const t = role?.track;
    if (t && role.pes && !h.tsc && rel >= es && rel < h.end && this.samplesLoaded) return this.frameDetail(t, offset, k, h);
    if (role?.psi && !h.tsc && rel >= h.payload + (h.pusi ? 1 : 0) && rel < h.end) {
      const d = await this.sectionDetail(offset, k, h);
      if (d) return d;
    }
    return this.packetDetail(offset, k, pktOff, h, role, ph, es);
  }

  /**
   * The complete table section containing `offset`, reassembled from the packets of its PID
   * (a section can span several packets). Fields keep their file offsets.
   */
  async sectionDetail(offset, k, h) {
    const L = this.layout;
    const S = L.size;
    const pid = h.pid;
    const WINDOW = 2048;
    const k0 = Math.max(0, k - WINDOW);
    const k1 = Math.min(L.count, k + WINDOW);
    const base = L.first + k0 * S;
    const u8 = await this.source.read(base, (k1 - k0) * S);
    // The payload bytes of this PID (pointer fields removed), with the file offset of each byte.
    const chunks = [];
    const starts = [];
    let len = 0;
    for (let p = 0; p + S <= u8.length; p += S) {
      if (u8[p + L.syncOffset] !== SYNC_BYTE) continue;
      const x = tsHeader(u8, p, L);
      if (x.pid !== pid || x.tsc || x.payload >= x.end) continue;
      let a = x.payload;
      if (x.pusi) {
        starts.push(len + u8[a]);
        a++;
      }
      if (a < x.end) {
        chunks.push({ at: len, file: base + a, u8: u8.subarray(a, x.end) });
        len += x.end - a;
      }
    }
    if (!starts.length || !len) return null;
    const stream = new Uint8Array(len);
    const map = new Float64Array(len);
    let target = -1;
    for (const c of chunks) {
      stream.set(c.u8, c.at);
      for (let i = 0; i < c.u8.length; i++) map[c.at + i] = c.file + i;
      if (offset >= c.file && offset < c.file + c.u8.length) target = c.at + (offset - c.file);
    }
    if (target < 0) return null;
    // Walk the sections from the first section start in the window.
    let pos = starts[0];
    let si = 0;
    while (pos < len) {
      if (stream[pos] === 0xff || pos + 3 > len) {
        while (si < starts.length && starts[si] <= pos) si++;
        if (si >= starts.length) break;
        pos = starts[si];
        continue;
      }
      const end = pos + 3 + (((stream[pos + 1] & 0x0f) << 8) | stream[pos + 2]);
      if (target >= pos && target < end) {
        const fields = [];
        const r = new FieldReader(stream, 0, { start: pos, end: Math.min(end, len), map, out: fields });
        let info;
        try {
          info = readSection(r, { hdmv: this.model.hdmv, dvb: this.model.dvb });
        } catch (e) {
          if (!(e instanceof ParseError)) throw e;
          info = { short: 'section', summary: e.message };
        }
        const first = map[pos];
        const last = map[Math.min(end, len) - 1] + 1;
        const packets = Math.round((last - first) / S) + 1;
        const def = sectionDef(info.tableId);
        const rows = [
          ['table', `${info.short} — ${def.name}`],
          ['PID', `${hexPid(pid)} (${this.roleOf(pid)?.label ?? 'table PID'})`],
          ['length', `${fmtInt(end - pos)} bytes${packets > 1 ? `, spread over ${packets} packets` : ''}`],
        ];
        if (info.version !== undefined) rows.push(['version', `${info.version}${info.current === 0 ? ' (next, not yet valid)' : ''}`]);
        if (info.sectionNumber !== undefined) rows.push(['section', `${info.sectionNumber} of 0–${info.lastSectionNumber}`]);
        if (info.crcOk !== undefined) rows.push(['CRC_32', info.crcOk ? 'valid' : 'does not match: receivers discard this section']);
        if (end > len) rows.push(['complete', 'no: the rest of the section is outside the bytes read']);
        const unit = { title: `${info.short} section`, offset: first, size: last - first, summary: info.summary ?? def.name, fields };
        return {
          kind: 'section',
          title: `${def.name}${info.summary ? ` · ${info.summary}` : ''}`,
          subtitle: `${info.short} on PID ${hexPid(pid)}`,
          range: [first, last],
          rows,
          units: [unit],
          text: packets > 1 ? 'This section is longer than one packet: Vidscope joined its pieces from consecutive packets of the same PID. Field offsets point into the file, so a field that straddles two packets also spans the header between them.' : def.desc,
          hit: { unit: 0, fields: fieldsAt({ fields, _leaves: null }, offset) },
        };
      }
      pos = end;
    }
    return null;
  }

  packetDetail(offset, k, pktOff, h, role, ph, es) {
    const L = this.layout;
    const rel = offset - pktOff;
    const rows = [
      ['packet', `#${fmtInt(k)} at ${fmtInt(pktOff)} (${hex(pktOff)})`],
      ['PID', `${hexPid(h.pid)} (${h.pid}) — ${role?.label ?? (h.pid === NULL_PID ? 'null packets' : 'not described by any table')}`],
      ['continuity_counter', String(h.cc)],
      ['payload_unit_start', h.pusi ? 'yes: a PES packet or section starts here' : 'no'],
    ];
    if (h.afLen >= 0) rows.push(['adaptation field', `${h.afLen + 1} bytes${h.pcr >= 0 ? `, PCR ${fmtPcrTime(h.pcr)}` : ''}${h.rai ? ', random access' : ''}${h.disc ? ', discontinuity' : ''}`]);
    if (h.tsc) rows.push(['scrambling', 'payload encrypted']);
    if (ph) {
      rows.push(['PES header', `${streamIdName(ph.streamId)}${ph.pts >= 0 ? `, PTS ${fmtTs(ph.pts)}` : ''}${ph.dts >= 0 ? `, DTS ${fmtTs(ph.dts)}` : ''}`]);
    }
    let where = 'the 4-byte packet header';
    const hdrStart = L.syncOffset;
    if (rel < hdrStart) where = 'the TP_extra_header (M2TS arrival timestamp)';
    else if (rel < hdrStart + 4) where = 'the 4-byte packet header';
    else if (h.afLen >= 0 && rel < hdrStart + 5 + h.afLen) where = 'the adaptation field';
    else if (rel >= hdrStart + 188) where = L.size === 204 ? 'the Reed-Solomon parity bytes' : 'the trailer';
    else if (h.pid === NULL_PID) where = 'the payload of a null packet (stuffing, ignored)';
    else if (h.tsc) where = 'the encrypted payload';
    else if (role?.psi && h.pusi && rel === h.payload) where = 'the pointer_field: how many bytes of the previous section come before the first new one';
    else if (role?.psi) where = 'a PSI/SI section (see the fields of the section node)';
    else if (ph && rel < es) where = 'the PES packet header';
    else if (role?.pes) where = this.samplesLoaded ? 'PES payload' : 'PES payload (frame boundaries appear once the whole file has been scanned)';
    else where = 'the payload of an unreferenced PID';
    rows.push(['this byte', where]);
    return { kind: 'packet', title: `Packet ${fmtInt(k)} · ${role?.short ?? hexPid(h.pid)}`, subtitle: role?.label, range: [pktOff, pktOff + L.size], rows };
  }

  async frameDetail(t, offset, k, h) {
    const s = t.samples;
    const i = this.sampleAt(t, offset);
    const L = this.layout;
    const pktOff = L.first + k * L.size;
    if (i < 0) {
      return {
        kind: 'gap',
        title: `Not part of any frame · ${t.label}`,
        text: 'These payload bytes of the PID belong to no complete frame: data before the first PES packet start (the file begins mid-stream), bytes between audio frames that are not a valid frame, or the incomplete end of the file.',
        range: [pktOff + h.payload, pktOff + h.end],
        rows: [['packet', `#${fmtInt(k)}`], ['PID', hexPid(t.pid)]],
      };
    }
    const units = await this.frameUnits(t, i);
    const pi = s.pesIndex[i];
    const pes = t.pes;
    const rows = [
      ['track', `${t.label} (PID ${hexPid(t.pid)})`],
      [t.framing || t.kind === 'video' ? 'frame' : 'sample', `${fmtInt(i + 1)} of ${fmtInt(s.count)}`],
    ];
    if (pes && pi < pes.count) {
      rows.push(['PES packet', `#${fmtInt(pi + 1)} of ${fmtInt(pes.count)}, header in packet #${fmtInt(pes.index[pi])} at ${hex(pes.offsets[pi])}${t.framing ? `; ${s.firstInPes[i] ? 'first frame starting in it' : 'not its first frame'}` : ''}`]);
    }
    const spanPackets = Math.ceil((s.ends[i] - s.offsets[i]) / L.size);
    rows.push(['bytes', `${fmtInt(s.sizes[i])} bytes of ${t.codecName}, spread over ~${fmtInt(spanPackets)} packet${spanPackets === 1 ? '' : 's'} (${hex(s.offsets[i])}–${hex(s.ends[i])})`]);
    const pts = s.pts[i];
    const dts = s.dts[i];
    rows.push(['PTS', Number.isFinite(pts) ? `${fmtTs(pts)}${t.framing && !s.firstInPes[i] ? ' (interpolated: no PES header for this frame)' : ''}` : 'none']);
    if (Number.isFinite(dts) && dts !== pts) rows.push(['DTS', fmtTs(dts)]);
    if (s.durations[i]) rows.push(['duration', `${fmtNum(s.durations[i], 3)} ticks (${fmtNum((s.durations[i] / PTS_HZ) * 1000, 3)} ms)`]);
    if (t.kind === 'video') rows.push(['key frame', s.key[i] ? 'yes (decoding can start here)' : 'no']);
    if (s.rai[i]) rows.push(['random_access_indicator', 'set on the packet that starts this PES']);
    rows.push(['this packet', `#${fmtInt(k)}, CC ${h.cc}${h.pusi ? ', PES start' : ''}`]);
    const d = {
      kind: 'sample',
      title: `${t.framing || t.kind === 'video' ? 'Frame' : 'Sample'} ${fmtInt(i + 1)} · ${t.label}`,
      subtitle: t.codecName,
      range: [s.offsets[i], s.ends[i]],
      rows,
      units,
      track: t,
      sample: i,
      text: t.family ? 'In a transport stream a frame is spread over many packets: Vidscope reassembles the payload bytes of this PID to decode it. Unit and field offsets point into the file; a field that straddles two packets also spans the packet header between them.' : 'Vidscope does not look inside frames of this codec; the payload bytes are shown as one block.',
    };
    const u = units.findIndex((x) => offset >= x.offset && offset < x.offset + x.size);
    if (u >= 0) d.hit = { unit: u, fields: fieldsAt({ fields: units[u].fields, _leaves: null }, offset) };
    return d;
  }

  async insights() {
    return insights(this);
  }

  glossary() {
    return glossary(this);
  }
}

// ------------------------------------------------------------------ helpers

function sampleCfgFor(t) {
  const f = t.family;
  if (f === 'avc' || f === 'hevc') {
    const st = t.config?.state;
    return { family: f, annexB: true, state: { spsById: new Map(st?.spsById ?? []), ppsById: new Map(st?.ppsById ?? []) } };
  }
  if (f === 'adts') return { family: 'aac', adts: true };
  if (f === 'mpa') return { family: 'mp3' };
  if (f === 'ac3') return { family: 'ac3' };
  if (f === 'eac3' || f === 'mpeg2v' || f === 'latm') return { family: f };
  return { family: null };
}

function nextSampleStart(s, pos) {
  let lo = 0;
  let hi = s.count - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (s.offsets[mid] > pos) {
      ans = mid;
      hi = mid - 1;
    } else lo = mid + 1;
  }
  return ans >= 0 ? s.offsets[ans] : -1;
}

/** Map offsets from reassembled-frame indices back to file offsets. */
function remapUnits(units, chunks) {
  if (!chunks.length) return;
  const at = (i) => {
    let lo = 0;
    let hi = chunks.length - 1;
    let ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (chunks[mid].es <= i) {
        ans = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    const c = chunks[ans];
    return c.file + Math.min(i - c.es, c.len);
  };
  const fix = (o) => {
    const a = at(o.offset);
    const b = o.size > 0 ? at(o.offset + o.size - 1) + 1 : a;
    o.esOffset = o.offset;
    o.esSize = o.size;
    o.offset = a;
    o.size = b - a;
  };
  const visit = (fields) => {
    for (const f of fields) {
      if (f.offset !== undefined) fix(f);
      if (f.children) visit(f.children);
    }
  };
  for (const u of units) {
    fix(u);
    visit(u.fields ?? []);
  }
}

function regionNode(kind, offset, size, warning) {
  const def = REGIONS[kind];
  const n = new Node({ type: kind === 'leading' ? 'partial packet' : kind === 'trailing' ? 'partial packet' : 'unsynced bytes', name: def.name, kind: 'region', offset, size, category: def.cat, def });
  if (warning) n.warn(warning);
  return n;
}

function regionDetail(kind, a, b) {
  const def = REGIONS[kind];
  return { kind: 'gap', title: def.name, text: def.desc, range: [a, b], rows: [] };
}

/** Per-track numbers derived from the samples. */
function derive(t, doc) {
  const s = t.samples;
  if (!s || !s.count) return;
  let bytes = 0;
  let minPts = Infinity;
  let maxEnd = -Infinity;
  for (let i = 0; i < s.count; i++) {
    bytes += s.sizes[i];
    const p = s.pts[i];
    if (Number.isFinite(p)) {
      if (p < minPts) minPts = p;
      if (p + s.durations[i] > maxEnd) maxEnd = p + s.durations[i];
    }
  }
  t.bytes = bytes;
  let total = 0;
  for (let i = 0; i < s.count; i++) total += s.durations[i];
  t.tsJumps = doc.stats?.states?.[t.pid]?.tsJumps ?? 0;
  if (Number.isFinite(minPts)) {
    t.startPts = minPts;
    t.endPts = maxEnd;
    // The sum of frame durations stays right when timestamps jump (joined files).
    t.duration = (t.tsJumps ? total : maxEnd - minPts) / PTS_HZ;
    if (t.duration > 0) t.bitrate = (bytes * 8) / t.duration;
  }
  if (t.kind === 'video' && s.count > 1) {
    let first = NaN;
    let last = NaN;
    for (let i = 0; i < s.count; i++) {
      if (Number.isFinite(s.dts[i])) {
        if (!Number.isFinite(first)) first = s.dts[i];
        last = s.dts[i];
      }
    }
    if (last > first) t.fps = ((s.count - 1) * PTS_HZ) / (last - first);
  }
}

function durationOf(doc) {
  let start = Infinity;
  let end = -Infinity;
  if (doc.tracks.some((t) => t.tsJumps)) return Math.max(0, ...doc.tracks.map((t) => t.duration ?? 0)) || null;
  for (const t of doc.tracks) {
    if (t.sections || !Number.isFinite(t.startPts)) continue;
    start = Math.min(start, t.startPts);
    end = Math.max(end, t.endPts);
  }
  return end > start ? (end - start) / PTS_HZ : null;
}

/** PCR samples of the busiest PCR PID, for mapping packet indices to time. */
function buildTimeline(stats) {
  let best = null;
  for (const p of stats.pcr.values()) if (!best || p.n > best.n) best = p;
  if (!best || !best.n) return null;
  const idx = best.idxArr;
  const val = best.valArr;
  let ticksPerPacket = 0;
  if (idx.length > 1 && idx[idx.length - 1] > idx[0]) ticksPerPacket = (val[val.length - 1] - val[0]) / (idx[idx.length - 1] - idx[0]);
  return { pid: best.pid, idx, val, ticksPerPacket };
}

// ------------------------------------------------------------------ open

async function open(source, { onProgress } = {}) {
  const head = await source.read(0, Math.min(source.size, 64 * 1024));
  const root = new Node({ type: source.name, name: source.name, kind: 'file', offset: 0, size: source.size, category: 'file' });
  const L = detectLayout(head, source.size);
  const doc = new TsDoc({ source, format: FORMAT, root });
  doc.tracksByPid = new Map();
  doc.kindCount = {};
  if (!L) {
    doc.layout = { size: 188, syncOffset: 0, trailer: 0, first: 0, count: 0, label: 'MPEG-TS' };
    doc.model = new ProgramModel();
    root.add(regionNode('junk', 0, source.size, 'No run of sync bytes (0x47 every 188, 192 or 204 bytes) was found.'));
    doc.warnings.push({ msg: 'No transport stream packets found.' });
    doc.summary = { label: 'MPEG-TS', anatomy: 'MPEG-TS anatomy', duration: null, unitCount: 0 };
    return doc;
  }
  doc.layout = L;
  const hdmv = L.size === 192 && L.syncOffset === 4;
  doc.model = new ProgramModel({ hdmv });

  // Tree: leading partial packet, lazy groups of packets, trailing bytes.
  if (L.first > 0) root.add(regionNode('leading', 0, L.first, `The file starts ${fmtInt(L.first)} byte${L.first === 1 ? '' : 's'} into a packet.`));
  const groups = Math.ceil(L.count / LEAF);
  const mkGroup = (g) => {
    const a = g * LEAF;
    const b = Math.min(L.count, a + LEAF) - 1;
    const n = new Node({ type: 'packets', name: `Packets ${fmtInt(a)}–${fmtInt(b)}`, kind: 'group', offset: L.first + a * L.size, size: (b - a + 1) * L.size, category: 'media', def: GROUP });
    n.data.firstIndex = a;
    n.data.lastIndex = b;
    n.data.summary = `${fmtInt(b - a + 1)} packets of ${L.size} bytes`;
    n.lazy = (node) => doc.loadGroup(node);
    return n;
  };
  if (groups <= 1024) {
    for (let g = 0; g < groups; g++) root.add(mkGroup(g));
  } else {
    for (let sg = 0; sg * SUPER < groups; sg++) {
      const g0 = sg * SUPER;
      const g1 = Math.min(groups, g0 + SUPER) - 1;
      const a = g0 * LEAF;
      const b = Math.min(L.count, (g1 + 1) * LEAF) - 1;
      const n = new Node({ type: 'packets', name: `Packets ${fmtInt(a)}–${fmtInt(b)}`, kind: 'group', offset: L.first + a * L.size, size: (b - a + 1) * L.size, category: 'media', def: GROUP });
      n.data.firstIndex = a;
      n.data.lastIndex = b;
      n.data.super = true;
      n.data.summary = `${fmtInt(g1 - g0 + 1)} groups, ${fmtInt(b - a + 1)} packets`;
      n.lazy = async (node) => {
        for (let g = g0; g <= g1; g++) node.add(mkGroup(g));
        if (doc.samplesLoaded) doc.labelGroups();
        doc.recount();
      };
      root.add(n);
    }
  }
  const tail = L.first + L.count * L.size;
  if (tail < source.size) root.add(regionNode('trailing', tail, source.size - tail, `${fmtInt(source.size - tail)} bytes after the last complete packet.`));

  // Program structure from the first packets.
  const init = await initialScan(source, L, doc.model, { onProgress });
  init.firstOffset = new Map();
  for (const [pid, v] of init.firstPts) init.firstOffset.set(pid, v.offset);
  doc.init = init;
  if (!doc.model.pat) doc.warnings.push({ msg: `No PAT found in the first ${fmtInt(init.packets)} packets: the program structure is unknown.` });
  else if (!doc.model.complete) doc.warnings.push({ msg: 'Some PMTs listed in the PAT were not found at the start of the file.' });
  for (const s of doc.model.streams()) doc.trackForStream(s);

  // Duration estimate from the first and last timestamps (refined by loadSamples).
  const tailInfo = await tailScan(source, L, 0);
  doc.tailInfo = tailInfo;
  let start = Infinity;
  let end = -Infinity;
  for (const t of doc.tracks) {
    const a = init.firstPts.get(t.pid);
    const b = tailInfo.lastPts.get(t.pid);
    if (!a || !b || t.sections) continue;
    const bb = unwrap(b.pts, a.pts);
    start = Math.min(start, a.pts);
    end = Math.max(end, bb);
  }
  let duration = end > start ? (end - start) / PTS_HZ : null;
  if (!duration) {
    for (const [pid, a] of init.firstPcr) {
      const b = tailInfo.lastPcr.get(pid);
      if (b && b.pcr > a.pcr) duration = Math.max(duration ?? 0, (b.pcr - a.pcr) / PCR_HZ);
    }
  }
  doc.summary = {
    label: L.label,
    anatomy: `${L.size === 192 && L.syncOffset ? 'M2TS' : 'MPEG-TS'} anatomy`,
    duration,
    unitCount: L.count,
  };
  return doc;
}

const FORMAT = {
  id: 'mpegts',
  name: 'MPEG-TS',
  unit: ['packet', 'packets'],
  probe,
  open,
};

export default FORMAT;
