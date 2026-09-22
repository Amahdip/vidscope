// Builds the element tree. At open() Vidscope reads the EBML header and every
// top-level element of the Segment except the insides of Clusters (and of large
// Cues), which are read when the node is opened. Elements of unknown size end at
// the first element that cannot be one of their descendants (RFC 8794 § 6.2).

import { Node } from '../../core/model.js';
import { fmtInt, hex } from '../../core/util.js';
import {
  readHeader, idField, sizeField, readUint, readInt, readFloat, readText, crc32, crcHex, hexId, idProblem,
} from './ebml.js';
import { BY_ID, BY_NAME, isChildOf, isDescendantOf, nodeDef, UNKNOWN_DEF, GARBAGE_DEF } from './elements.js';
import { present, presentBinary } from './values.js';
import { blockFields } from './blocks.js';
import { parseCodecPrivate } from './codecs.js';
import { labelNode } from './labels.js';

/** Size limits; tests may lower them to exercise the large-file paths. */
export const LIMITS = {
  inMemory: 16 << 20, // top-level masters up to this size are read in one go
  leafMax: 1 << 20, // leaf values bigger than this are not read (FileData of big attachments)
  cuesLazy: 256 << 10, // Cues bigger than this are parsed when opened
  clusterRead: 32 << 20, // clusters up to this size are read in one go
  unknownScan: 32 << 20, // bytes read at open() to find the ends of unknown-size elements
  resync: 8 << 20, // how far to search for the next top-level element after damage
  chunk: 4 << 20, // sequential read size for scans
};

const EL = (n) => BY_NAME.get(n);
const E_EBML = EL('EBML');
const E_SEGMENT = EL('Segment');

// Top-level IDs used to resynchronise after damage (4-byte IDs are unlikely to appear by chance).
const SYNC_IDS = [0x1f43b675, 0x1c53bb6b, 0x1254c367, 0x114d9b74, 0x1549a966, 0x1654ae6b, 0x1043a770, 0x1941a469, 0x1a45dfa3, 0x18538067];

// Mandatory children without a default value, by parent name (RFC 9559 elements only).
const MANDATORY = new Map();
for (const el of BY_NAME.values()) {
  if (!el.mandatory || el.default !== undefined || el.global || el.historic || el.v5 || el.notInRfc || !el.parent) continue;
  if (!MANDATORY.has(el.parent)) MANDATORY.set(el.parent, []);
  MANDATORY.get(el.parent).push(el);
}

/** Sequential reader for scans: keeps one large chunk of the file in memory. */
export class ChunkReader {
  constructor(source, chunk = LIMITS.chunk) {
    this.source = source;
    this.chunk = chunk;
    this.buf = null;
    this.base = 0;
    this.bytesRead = 0;
  }

  /** Make [pos, pos + n) available (clamped at EOF); returns the index of pos in this.buf, or -1 at EOF. */
  async at(pos, n) {
    const b = this.buf;
    const want = Math.min(n, this.source.size - pos);
    if (want <= 0) return -1;
    if (b && pos >= this.base && pos + want <= this.base + b.length) return pos - this.base;
    const len = Math.min(Math.max(want, this.chunk), this.source.size - pos);
    this.buf = await this.source.read(pos, len);
    this.base = pos;
    this.bytesRead += this.buf.length;
    return 0;
  }
}

export function createContext(source, doc) {
  return {
    source,
    doc,
    maxId: 4,
    maxSize: 8,
    headers: [],
    header: null,
    segments: [],
    seg: null,
    count: 0,
    bare: false,
    crc: { checked: 0, ok: 0, bad: [], unverified: 0 },
    unknownBudget: LIMITS.unknownScan,
    garbage: [],
    unknown: new Map(), // unknown element IDs -> count
  };
}

function newSegment(ctx, node, dataStart, end, unknownSize) {
  return {
    index: ctx.segments.length,
    node,
    dataStart,
    end,
    unknownSize,
    timestampScale: 1e6,
    info: null,
    tracksNodes: [],
    trackEntries: [],
    level1: [],
    clusters: [],
    groups: [],
    cues: [],
    seekHeads: [],
    trackByNumber: new Map(),
    trackByUid: new Map(),
    tracks: [],
  };
}

/** Display context for values.js. */
export function valueContext(seg) {
  return {
    scale: seg?.timestampScale ?? 1e6,
    segData: seg?.dataStart,
    track: seg ? (n) => seg.trackByNumber.get(n) : undefined,
    trackByUid: seg ? (u) => seg.trackByUid.get(String(u)) : undefined,
  };
}

// ------------------------------------------------------------------ nodes

function makeNode(ctx, parent, hdr, abs, el, u8, p) {
  const node = new Node({
    type: el ? el.name : hexId(hdr.id),
    name: el ? el.title : 'Unknown element',
    kind: 'element',
    offset: abs,
    size: hdr.headerSize + hdr.dataSize,
    headerSize: hdr.headerSize,
    category: el ? el.cat : 'unknown',
    def: el ? nodeDef(el) : UNKNOWN_DEF,
  });
  node.fields.push(idField(u8, abs - p, p, hdr, el?.name), sizeField(u8, abs - p, p, hdr));
  node.data.el = el ?? null;
  node.data.id = hdr.id;
  node.data.seg = ctx.seg;
  if (hdr.unknown) node.data.unknownSize = true;
  if (!el) {
    ctx.unknown.set(hdr.id, (ctx.unknown.get(hdr.id) ?? 0) + 1);
    const problem = idProblem(hdr.id, hdr.idLen);
    if (problem) node.warn(`${hexId(hdr.id)} is not a valid EBML ID: ${problem}.`);
  } else if (!el.global) {
    const pel = parent.data?.el;
    const ok = pel ? isChildOf(el, pel) : el.parent === '' || (ctx.bare && el.parent === 'Segment');
    if (!ok) {
      node.warn(`Found ${pel ? `inside ${pel.name}` : 'at the top level of the file'}, but the specification places ${el.name} ${el.parent ? `inside ${el.parent}` : 'at the top level'}.`);
    }
    if (el.once && pel) {
      const seen = (parent.data.seen ??= new Set());
      if (seen.has(el.name)) node.warn(`${el.name} may appear only once in ${pel.name}; readers use the first one.`);
      seen.add(el.name);
    }
  }
  if (hdr.unknown && el && !el.unknownSizeAllowed) node.warn(`${el.name} has an unknown size, which the specification only allows for Segment and Cluster.`);
  parent.add(node);
  ctx.count++;
  return node;
}

function garbage(ctx, parent, start, end, msg) {
  if (end <= start) return null;
  const node = new Node({ type: 'garbage', name: 'Unparsed bytes', kind: 'region', offset: start, size: end - start, category: 'unknown', def: GARBAGE_DEF });
  node.warn(msg);
  parent.add(node);
  ctx.garbage.push({ offset: start, size: end - start, msg });
  ctx.doc.warnings.push({ offset: start, msg });
  return node;
}

/** 1 leftover byte at the end of a master: record it on the parent. */
function tail(ctx, parent, u8, base, p, end) {
  const n = end - p;
  const zero = u8.subarray(p, end).every((b) => b === 0);
  parent.fields.push({
    name: zero ? 'padding' : 'leftover bytes',
    type: 'bytes',
    offset: base + p,
    size: n,
    value: u8.subarray(p, end),
    display: `${n} byte${n > 1 ? 's' : ''}${zero ? ' (zero)' : ''}`,
    reserved: zero,
    desc: 'Bytes at the end of the element that are too short to be an element (an element needs at least a 1-byte ID and a 1-byte size).',
  });
  if (!zero) parent.warn(`${n} byte${n > 1 ? 's' : ''} after the last child element are not an element.`);
}

// ------------------------------------------------------------------ leaf values

export function applyValue(node) {
  const el = node.data.el;
  const f = node.data.valueField;
  if (!el || !f) return;
  const p = present(el, node.data.value, valueContext(node.data.seg), { big: node.data.big, empty: node.data.empty });
  f.display = p.display;
  node.label = p.label ?? '';
  if (p.note) f.note = node.data.padNote ? `${p.note} ${node.data.padNote}` : p.note;
  else if (node.data.padNote) f.note = node.data.padNote;
  node.data.summary = `${el.name} = ${p.display}`;
  if (p.abs !== undefined) {
    let j = node.data.jumpField;
    if (!j) {
      j = { name: 'points to (file offset)', type: 'computed', offset: f.offset, size: 0, ref: 'offset', desc: 'The file offset this Segment position refers to: the Segment\'s data start plus the stored value. Positions in Matroska are relative to the Segment so that the Segment can be copied into another file unchanged.' };
      node.fields.push(j);
      node.data.jumpField = j;
    }
    j.value = p.abs;
    j.display = `${fmtInt(p.abs)} (${hex(p.abs)})`;
  }
}

function pushBytes(node, name, u8, base, s, n, o = {}) {
  const f = { name, type: 'binary', offset: base + s, size: n, value: u8.subarray(s, s + n), display: o.display ?? `${fmtInt(n)} bytes`, ...o };
  node.fields.push(f);
  return f;
}

function checkRange(node, el, v) {
  if (typeof v !== 'number' || !el.range) return;
  const r = el.range;
  if (r === 'not 0' && v === 0) node.warn(`${el.name} must not be 0.`);
  else if (r === '0-1' && v !== 0 && v !== 1) node.warn(`${el.name} must be 0 or 1 (found ${v}).`);
  else if (r === '> 0' && !(v > 0)) node.warn(`${el.name} must be greater than 0.`);
}

function parseLeaf(ctx, node, el, u8, base, s, e) {
  const n = e - s;
  if (!el) {
    if (n > 0) pushBytes(node, 'data', u8, base, s, n, { desc: 'The data of an element Vidscope does not know.' });
    return;
  }
  if (el.type === 'b') {
    parseBinary(ctx, node, el, u8, base, s, e);
    return;
  }
  let value;
  let big;
  if ((el.type === 'u' || el.type === 'i' || el.type === 'd') && n > 8) {
    node.warn(`${el.name} is ${n} bytes long; integers and dates are at most 8 bytes.`);
    pushBytes(node, el.name, u8, base, s, n);
    return;
  }
  switch (el.type) {
    case 'u':
      ({ value, big } = readUint(u8, s, n));
      break;
    case 'i':
    case 'd':
      ({ value, big } = readInt(u8, s, n));
      if (el.type === 'd' && n !== 0 && n !== 8) node.warn(`A date must be 0 or 8 bytes long; this one is ${n}.`);
      break;
    case 'f':
      value = readFloat(u8, s, n);
      if (value === null) {
        node.warn(`A float must be 0, 4 or 8 bytes long; this one is ${n}.`);
        pushBytes(node, el.name, u8, base, s, n);
        return;
      }
      break;
    default: {
      const t = readText(u8, s, n, el.type === 's');
      value = t.text;
      if (t.padded) node.data.padNote = `${t.padded} NUL byte${t.padded > 1 ? 's' : ''} end the text: writers pad strings like this to be able to change them in place later.`;
      if (t.nonAscii) node.warn(`${el.name} is an ASCII string but contains bytes outside 0x20–0x7E.`);
    }
  }
  if (n === 0) {
    node.data.empty = true;
    value = el.default ?? (el.type === 's' || el.type === '8' ? '' : 0);
  }
  node.data.value = value;
  if (big !== undefined) node.data.big = big;
  const f = { name: el.name, type: el.typeName, offset: base + s, size: n, value, display: '', key: true };
  if (big !== undefined) f.big = big.toString();
  node.fields.push(f);
  node.data.valueField = f;
  applyValue(node);
  checkRange(node, el, value);
}

function parseBinary(ctx, node, el, u8, base, s, e, dataEnd = e) {
  const n = dataEnd - s;
  switch (el.name) {
    case 'SimpleBlock':
    case 'Block': {
      const L = blockFields(u8, base, s, e, dataEnd, el.name === 'SimpleBlock', node.fields);
      if (L.error) node.warn(`${el.name}: ${L.error}.`);
      node.data.block = L;
      return;
    }
    case 'CRC-32': {
      if (n !== 4) node.warn(`CRC-32 must be 4 bytes long; this one is ${n}.`);
      const v = n >= 4 ? (u8[s] | (u8[s + 1] << 8) | (u8[s + 2] << 16) | (u8[s + 3] << 24)) >>> 0 : null;
      node.data.crc = v;
      node.fields.push({ name: 'CRC-32', type: 'uint32 (little-endian)', offset: base + s, size: n, value: v, display: v === null ? '—' : `${crcHex(v)} (not checked yet)`, key: true });
      node.data.valueField = node.fields[node.fields.length - 1];
      node.label = v === null ? '' : crcHex(v);
      return;
    }
    case 'Void': {
      let zero = null;
      if (n <= 65536 && e <= u8.length) zero = u8.subarray(s, e).every((b) => b === 0);
      node.fields.push({ name: 'reserved space', type: 'binary', offset: base + s, size: n, value: null, display: `${fmtInt(n)} bytes${zero === true ? ' (all zero)' : zero === false ? ' (not all zero: old data left in place)' : ''}`, reserved: true, desc: 'Ignored bytes. Only their count matters: it is space a writer can reuse later without moving the rest of the file.' });
      return;
    }
    case 'CodecPrivate':
      node.data.raw = { u8, base, s, e };
      pushBytes(node, 'CodecPrivate', u8, base, s, n, { key: true });
      return;
    default: {
      if (e > u8.length || n > (LIMITS.leafMax * 16)) {
        node.fields.push({ name: el.name, type: 'binary', offset: base + s, size: n, value: null, display: `${fmtInt(n)} bytes (not loaded)`, key: true });
        return;
      }
      const p = presentBinary(el, u8, s, n);
      const f = pushBytes(node, el.name, u8, base, s, n, { display: p.display, key: true });
      if (p.value !== undefined) {
        f.value = p.value;
        node.data.value = p.value;
      }
      node.label = p.label ?? '';
    }
  }
}

/** A binary leaf too big to read at open: header only. SimpleBlock/Block read their first bytes. */
async function bigLeaf(ctx, node, el) {
  const s = node.bodyOffset;
  const n = node.bodySize;
  if (el && (el.name === 'SimpleBlock' || el.name === 'Block')) {
    const head = await ctx.source.read(s, Math.min(n, 64 * 1024));
    parseBinary(ctx, node, el, head, s, 0, head.length, n);
    return;
  }
  node.fields.push({ name: el ? el.name : 'data', type: el ? el.typeName : 'binary', offset: s, size: n, value: null, display: `${fmtInt(n)} bytes (not loaded)`, key: true });
}

// ------------------------------------------------------------------ masters

/** Find where an unknown-size element of type `el` whose data starts at u8[start] ends. */
function findEndSync(ctx, el, u8, start, end) {
  let p = start;
  while (p < end) {
    const hdr = readHeader(u8, p, end, ctx.maxId, ctx.maxSize);
    if (hdr.error) return p;
    const cel = BY_ID.get(hdr.id);
    if (cel && !isDescendantOf(cel, el)) return p;
    if (hdr.unknown) {
      if (!cel || cel.type !== 'm') return p;
      p = findEndSync(ctx, cel, u8, p + hdr.headerSize, end);
      continue;
    }
    p += hdr.headerSize + hdr.size;
  }
  return Math.min(p, end);
}

/** Async version for large or top-level elements; returns null when the scan budget runs out. */
async function findEndAsync(ctx, el, start, end, cr, budget = ctx.unknownBudget) {
  let p = start;
  const before = cr.bytesRead;
  while (p < end) {
    if (cr.bytesRead - before > budget) return null;
    const i = await cr.at(p, 16);
    if (i < 0) return p;
    const hdr = readHeader(cr.buf, i, cr.buf.length, ctx.maxId, ctx.maxSize);
    if (hdr.error) return p;
    const cel = BY_ID.get(hdr.id);
    if (cel && !isDescendantOf(cel, el)) return p;
    if (hdr.unknown) {
      if (!cel || cel.type !== 'm') return p;
      const sub = await findEndAsync(ctx, cel, p + hdr.headerSize, end, cr, budget - (cr.bytesRead - before));
      if (sub === null) return null;
      p = sub;
      continue;
    }
    p += hdr.headerSize + hdr.size;
  }
  return Math.min(p, end);
}

/** Parse the children of a master whose data is u8[start, end) (file offset of u8[0] = base). */
export function parseChildren(ctx, parent, u8, base, start, end) {
  let p = start;
  let first = true;
  while (p < end) {
    if (end - p < 2) {
      tail(ctx, parent, u8, base, p, end);
      break;
    }
    const hdr = readHeader(u8, p, end, ctx.maxId, ctx.maxSize);
    if (hdr.error) {
      garbage(ctx, parent, base + p, base + end, `Bytes at ${hex(base + p)} are not a valid element: ${hdr.error}. The rest of ${parent.type} cannot be read.`);
      break;
    }
    const el = BY_ID.get(hdr.id);
    let dataSize;
    const s = p + hdr.headerSize;
    if (hdr.unknown) {
      if (el && el.type !== 'm') {
        garbage(ctx, parent, base + p, base + end, `${el.name} at ${hex(base + p)} has an unknown size, which only master elements may have.`);
        break;
      }
      dataSize = findEndSync(ctx, el ?? E_SEGMENT, u8, s, end) - s;
    } else {
      dataSize = hdr.size;
    }
    let declared = null;
    if (s + dataSize > end) {
      declared = dataSize;
      dataSize = Math.max(0, end - s);
    }
    hdr.dataSize = dataSize;
    const node = makeNode(ctx, parent, hdr, base + p, el, u8, p);
    if (declared !== null) {
      node.warn(`Declares ${fmtInt(declared)} bytes of data but only ${fmtInt(dataSize)} remain in ${parent.type === 'garbage' ? 'the parent' : parent.type}${parent.parent ? '' : ' (the file is truncated)'}.`);
    }
    if (el?.name === 'CRC-32' && !first) node.warn('A CRC-32 must be the first element of its parent; readers may ignore this one.');
    if (el?.type === 'm') {
      parseChildren(ctx, node, u8, base, s, s + dataSize);
      finalizeMaster(ctx, node, u8, base);
    } else {
      parseLeaf(ctx, node, el, u8, base, s, s + dataSize);
    }
    p = s + dataSize;
    first = false;
  }
}

/** Children of a master too big to read at once: walk headers with small reads. */
async function parseChildrenAsync(ctx, parent, start, end) {
  const cr = new ChunkReader(ctx.source, 64 * 1024);
  let p = start;
  while (p < end) {
    if (end - p < 2) break;
    const head = await (ctx.source.peek ? ctx.source.peek(p, Math.min(end - p, 64)) : ctx.source.read(p, Math.min(end - p, 64)));
    const hdr = readHeader(head, 0, head.length, ctx.maxId, ctx.maxSize);
    if (hdr.error) {
      garbage(ctx, parent, p, end, `Bytes at ${hex(p)} are not a valid element: ${hdr.error}.`);
      break;
    }
    const el = BY_ID.get(hdr.id);
    let dataSize = hdr.size;
    if (hdr.unknown) {
      const f = await findEndAsync(ctx, el ?? E_SEGMENT, p + hdr.headerSize, end, cr, Infinity);
      dataSize = (f ?? end) - (p + hdr.headerSize);
    }
    let declared = null;
    if (p + hdr.headerSize + dataSize > end) {
      declared = dataSize;
      dataSize = Math.max(0, end - p - hdr.headerSize);
    }
    hdr.dataSize = dataSize;
    const node = makeNode(ctx, parent, hdr, p, el, head, 0);
    if (declared !== null) node.warn(`Declares ${fmtInt(declared)} bytes of data but only ${fmtInt(dataSize)} remain in ${parent.type}.`);
    if (el?.type === 'm') await loadMaster(ctx, node);
    else if (dataSize <= LIMITS.leafMax) {
      const u8 = await ctx.source.read(p, hdr.headerSize + dataSize);
      parseLeaf(ctx, node, el, u8, p, hdr.headerSize, Math.min(u8.length, hdr.headerSize + dataSize));
    } else {
      await bigLeaf(ctx, node, el);
    }
    p = node.end;
  }
}

/** Read and parse the children of a master node (in memory when it is small enough). */
export async function loadMaster(ctx, node) {
  const saved = ctx.seg;
  ctx.seg = node.data.seg ?? ctx.seg;
  try {
    if (node.bodySize <= LIMITS.inMemory) {
      const u8 = await ctx.source.read(node.bodyOffset, node.bodySize);
      parseChildren(ctx, node, u8, node.bodyOffset, 0, u8.length);
      finalizeMaster(ctx, node, u8, node.bodyOffset);
    } else {
      await parseChildrenAsync(ctx, node, node.bodyOffset, node.end);
      finalizeMaster(ctx, node, null, 0);
    }
  } finally {
    ctx.seg = saved;
  }
}

function childNode(node, name) {
  return node.children?.find((c) => c.type === name) ?? null;
}

/** Value of a direct child leaf, or the schema default. */
export function childValue(node, name, dflt) {
  const c = childNode(node, name);
  if (c && c.data.value !== undefined) return c.data.value;
  const el = BY_NAME.get(name);
  return el?.default !== undefined ? el.default : dflt;
}

function verifyCrc(ctx, node, u8, base) {
  const first = node.children?.[0];
  const crcNode = node.children?.find((c) => c.type === 'CRC-32');
  if (!crcNode || crcNode.data.crc === null || crcNode.data.crc === undefined) return;
  const f = crcNode.data.valueField;
  const from = crcNode.end - base;
  const to = node.end - base;
  if (!u8 || from < 0 || to > u8.length || crcNode !== first) {
    ctx.crc.unverified++;
    if (f) f.display = `${crcHex(crcNode.data.crc)} (not verified${crcNode !== first ? ': not the first child' : ''})`;
    return;
  }
  const computed = crc32(u8, from, to);
  const ok = computed === crcNode.data.crc;
  ctx.crc.checked++;
  crcNode.data.crcOk = ok;
  crcNode.data.crcComputed = computed;
  if (ok) {
    ctx.crc.ok++;
    f.display = `${crcHex(crcNode.data.crc)} ✓ matches the ${fmtInt(to - from)} bytes that follow`;
    crcNode.label = `${crcHex(crcNode.data.crc)} ✓`;
  } else {
    ctx.crc.bad.push({ node, offset: node.offset, stored: crcNode.data.crc, computed });
    f.display = `${crcHex(crcNode.data.crc)} ✗ the data gives ${crcHex(computed)}`;
    crcNode.label = `${crcHex(crcNode.data.crc)} ✗`;
    crcNode.warn(`CRC-32 mismatch: stored ${crcHex(crcNode.data.crc)}, but the ${fmtInt(to - from)} bytes of ${node.type} data after it give ${crcHex(computed)}. The element was damaged or edited without updating its checksum.`);
    node.warn(`Its CRC-32 does not match its contents (stored ${crcHex(crcNode.data.crc)}, computed ${crcHex(computed)}).`);
  }
}

/** After a master's children are parsed: checksum, mandatory children, codec setup, labels. */
export function finalizeMaster(ctx, node, u8, base) {
  const el = node.data.el;
  if (u8) verifyCrc(ctx, node, u8, base);
  if (!el) return;
  const must = MANDATORY.get(el.name);
  if (must) {
    for (const m of must) {
      if (!childNode(node, m.name)) node.warn(`Missing ${m.name}, which the specification requires in every ${el.name}.`);
    }
  }
  switch (el.name) {
    case 'EBML': {
      const h = {
        node,
        docType: childValue(node, 'DocType', null),
        docTypeVersion: childValue(node, 'DocTypeVersion', 1),
        docTypeReadVersion: childValue(node, 'DocTypeReadVersion', 1),
        version: childValue(node, 'EBMLVersion', 1),
        readVersion: childValue(node, 'EBMLReadVersion', 1),
        maxIdLength: childValue(node, 'EBMLMaxIDLength', 4),
        maxSizeLength: childValue(node, 'EBMLMaxSizeLength', 8),
      };
      ctx.headers.push(h);
      ctx.header ??= h;
      ctx.maxId = Math.min(8, Math.max(1, h.maxIdLength || 4));
      ctx.maxSize = Math.min(8, Math.max(1, h.maxSizeLength || 8));
      if (h.docType && h.docType !== 'matroska' && h.docType !== 'webm') node.warn(`DocType "${h.docType}" is neither "matroska" nor "webm".`);
      if (h.maxIdLength !== 4) node.warn(`EBMLMaxIDLength is ${h.maxIdLength}; Matroska requires 4.`);
      if (h.docTypeReadVersion > h.docTypeVersion) node.warn('DocTypeReadVersion is higher than DocTypeVersion.');
      break;
    }
    case 'Info': {
      const seg = node.data.seg;
      if (seg && !seg.info) {
        seg.info = node;
        seg.timestampScale = childValue(node, 'TimestampScale', 1e6) || 1e6;
      }
      break;
    }
    case 'TrackEntry': {
      const cp = childNode(node, 'CodecPrivate');
      const codecId = childValue(node, 'CodecID', null);
      if (cp?.data.raw) {
        const { u8: b, base: bb, s, e } = cp.data.raw;
        cp.fields.length = 2; // keep ID and size
        const info = parseCodecPrivate(codecId, b, bb, s, e, cp.fields);
        cp.data.info = info;
        cp.data.raw = null;
        if (info.summary) {
          cp.label = info.summary;
          cp.data.summary = info.summary;
        }
        if (info.error) cp.warn(`Could not fully decode the codec configuration: ${info.error}.`);
      }
      node.data.seg?.trackEntries.push(node);
      break;
    }
    case 'Tracks':
      node.data.seg?.tracksNodes.push(node);
      break;
    case 'SeekHead':
      node.data.seg?.seekHeads.push(node);
      break;
    case 'BlockGroup': {
      const b = childNode(node, 'Block');
      if (b?.data.block) b.data.block.key = !childNode(node, 'ReferenceBlock');
      break;
    }
    default:
      break;
  }
  labelNode(node);
}

// ------------------------------------------------------------------ top level

/** Look for the next plausible top-level element after damage. */
async function resync(ctx, from, end) {
  const limit = Math.min(end, from + LIMITS.resync);
  const cr = new ChunkReader(ctx.source, 1 << 20);
  for (let p = from; p < limit;) {
    const i = await cr.at(p, Math.min(1 << 20, limit - p + 16));
    if (i < 0) return null;
    const u8 = cr.buf;
    const stop = Math.min(u8.length - 4, limit - cr.base);
    for (let k = i; k < stop; k++) {
      const b = u8[k];
      if (b !== 0x1f && b !== 0x1c && b !== 0x12 && b !== 0x11 && b !== 0x15 && b !== 0x16 && b !== 0x10 && b !== 0x19 && b !== 0x1a && b !== 0x18) continue;
      const id = ((b << 24) | (u8[k + 1] << 16) | (u8[k + 2] << 8) | u8[k + 3]) >>> 0;
      if (!SYNC_IDS.includes(id)) continue;
      const hdr = readHeader(u8, k, u8.length, ctx.maxId, ctx.maxSize);
      if (hdr.error) continue;
      const at = cr.base + k;
      if (!hdr.unknown && at + hdr.headerSize + hdr.size > ctx.source.size + 16) continue;
      // The first child must look like an element too.
      const c = readHeader(u8, k + hdr.headerSize, u8.length, ctx.maxId, ctx.maxSize);
      if (c.error || (!BY_ID.has(c.id) && hdr.size !== 0)) continue;
      return at;
    }
    p = cr.base + Math.max(i + 1, stop);
  }
  return null;
}

function peekClusterTimestamp(ctx, u8, p, end) {
  for (let k = 0; k < 4 && p < end; k++) {
    const hdr = readHeader(u8, p, end, ctx.maxId, ctx.maxSize);
    if (hdr.error || hdr.unknown) return null;
    if (hdr.id === 0xe7) {
      if (p + hdr.headerSize + hdr.size > end || hdr.size > 8) return null;
      return readUint(u8, p + hdr.headerSize, hdr.size).value;
    }
    if (hdr.id !== 0xbf && hdr.id !== 0xec) return null;
    p += hdr.headerSize + hdr.size;
  }
  return null;
}

function setupCluster(ctx, seg, node, head, headerSize) {
  node.data.index = seg.clusters.length;
  seg.clusters.push(node);
  const ts = peekClusterTimestamp(ctx, head, headerSize, head.length);
  if (ts !== null) node.data.timestamp = ts;
  if (node.bodySize > 0) node.lazy = (n) => loadCluster(ctx, n);
  labelNode(node);
}

/** Lazy loader of a Cluster's contents. */
export async function loadCluster(ctx, node) {
  const saved = ctx.seg;
  ctx.seg = node.data.seg;
  try {
    if (node.bodySize <= LIMITS.clusterRead) {
      const u8 = await ctx.source.read(node.bodyOffset, node.bodySize);
      parseChildren(ctx, node, u8, node.bodyOffset, 0, u8.length);
      finalizeMaster(ctx, node, u8, node.bodyOffset);
    } else {
      await parseChildrenAsync(ctx, node, node.bodyOffset, node.end);
      finalizeMaster(ctx, node, null, 0);
    }
    node.data.loaded = true;
    const ts = childValue(node, 'Timestamp', null);
    if (ts !== null) node.data.timestamp = ts;
    checkClusterLinks(node);
    labelTree(node);
  } finally {
    ctx.seg = saved;
    ctx.doc.recount();
  }
}

/** Position and PrevSize are resynchronisation aids: check them against the real layout. */
function checkClusterLinks(node) {
  const seg = node.data.seg;
  if (!seg || seg.bare) return;
  const pos = node.children?.find((c) => c.type === 'Position');
  if (pos && typeof pos.data.value === 'number' && seg.dataStart + pos.data.value !== node.offset) {
    pos.warn(`Position says this Cluster is at Segment position ${fmtInt(pos.data.value)} (file offset ${fmtInt(seg.dataStart + pos.data.value)}), but it starts at ${fmtInt(node.offset)}.`);
  }
  const prev = node.children?.find((c) => c.type === 'PrevSize');
  const i = node.data.index;
  if (prev && typeof prev.data.value === 'number' && i > 0) {
    const p = seg.clusters[i - 1];
    if (p && p.size !== prev.data.value) prev.warn(`PrevSize is ${fmtInt(prev.data.value)} bytes, but the previous Cluster is ${fmtInt(p.size)} bytes long.`);
  }
}

/** Recompute value displays and labels of a subtree (post-order), e.g. once tracks are known. */
export function labelTree(node) {
  for (const c of node.children ?? []) labelTree(c);
  if (node.data.valueField && node.data.el && node.data.el.type !== 'b') applyValue(node);
  labelNode(node);
}

const GROUP_DEF = {
  name: 'Clusters of unknown size (not yet scanned)',
  cat: 'fragment',
  desc: 'The rest of this live-recorded Segment. Its Clusters have unknown sizes, so the only way to find where each one ends is to read through them; Vidscope does that when you open this group (or when it builds the frame tables) instead of at load time.',
  more: 'Live muxers (browser MediaRecorder, streaming encoders) write each Cluster before knowing its size and mark the size as unknown (all value bits set). A reader then has to walk every block to find the next Cluster. Remuxing the file (for example with ffmpeg -c copy) writes real sizes, Cues and a Duration.',
};

/** Walk the top-level elements of a Segment (or of a bare stream) in [start, end). Returns where it stopped. */
async function parseLevel1(ctx, seg, parent, start, end, o = {}) {
  const src = ctx.source;
  const cr = o.cr ?? new ChunkReader(src, LIMITS.chunk);
  let p = start;
  while (p < end) {
    if (end - p < 2) {
      const t = await src.read(p, end - p);
      tail(ctx, parent, t, p, 0, t.length);
      p = end;
      break;
    }
    const head = await (src.peek ? src.peek(p, Math.min(end - p, 64)) : src.read(p, Math.min(end - p, 64)));
    const hdr = readHeader(head, 0, head.length, ctx.maxId, ctx.maxSize);
    if (hdr.error) {
      const next = await resync(ctx, p + 1, end);
      garbage(ctx, parent, p, next ?? end, `Bytes at ${hex(p)} are not a valid element (${hdr.error}). ${next !== null ? `Vidscope skipped ${fmtInt(next - p)} bytes to the next top-level element at ${hex(next)}.` : 'No further top-level element was found, so the rest cannot be read.'}`);
      if (next === null) {
        p = end;
        break;
      }
      p = next;
      continue;
    }
    const el = BY_ID.get(hdr.id);
    if (el && (el === E_EBML || el === E_SEGMENT) && parent !== ctx.doc.root) {
      if (o.unknownParent) return p; // a new EBML document ends an unknown-size Segment
    }
    // Top-level elements always have 4-byte IDs (RFC 9559 § 4.4): anything else here is damage.
    if ((el && !el.global && el.parent !== 'Segment' && el !== E_EBML && el !== E_SEGMENT) || (!el && hdr.idLen < 4)) {
      const next = await resync(ctx, p + 1, end);
      garbage(ctx, parent, p, next ?? end, `Bytes at ${hex(p)} do not start a top-level element (${el ? `they read as ${el.name}, which belongs inside ${el.parent}` : `a ${hdr.idLen}-byte ID, but top-level IDs are 4 bytes`}). ${next !== null ? `Vidscope skipped ${fmtInt(next - p)} bytes to the next top-level element at ${hex(next)}.` : 'No further top-level element was found, so the rest cannot be read.'}`);
      if (next === null) {
        p = end;
        break;
      }
      p = next;
      continue;
    }
    const s = p + hdr.headerSize;
    let dataSize = hdr.size;
    if (hdr.unknown) {
      const found = el?.type === 'm' || !el ? await findEndAsync(ctx, el ?? E_SEGMENT, s, end, cr, o.budget ?? ctx.unknownBudget) : s;
      if (found === null) {
        // Too much to scan now: leave the rest of the Segment as one lazy group.
        const g = new Node({ type: 'Clusters…', name: GROUP_DEF.name, kind: 'group', offset: p, size: end - p, category: 'fragment', def: GROUP_DEF });
        g.data.el = E_SEGMENT;
        g.data.seg = seg;
        g.data.group = true;
        g.label = 'unknown sizes: opened on demand';
        g.lazy = async (n) => {
          const saved = ctx.seg;
          ctx.seg = seg;
          try {
            await parseLevel1(ctx, seg, n, n.offset, n.end, { budget: Infinity, unknownParent: o.unknownParent });
            labelTree(n);
          } finally {
            ctx.seg = saved;
            ctx.doc.recount();
          }
        };
        parent.add(g);
        seg.groups.push(g);
        p = end;
        break;
      }
      dataSize = found - s;
    }
    let declared = null;
    if (s + dataSize > end) {
      declared = dataSize;
      dataSize = Math.max(0, end - s);
    }
    hdr.dataSize = dataSize;
    const node = makeNode(ctx, parent, hdr, p, el, head, 0);
    if (declared !== null) {
      node.warn(`Declares ${fmtInt(declared)} bytes of data but only ${fmtInt(dataSize)} remain${parent === ctx.doc.root || end === src.size ? ': the file is truncated' : ` in the ${parent.type}`}.`);
    }
    seg.level1.push(node);
    const name = el?.name;
    if (name === 'Cluster') {
      setupCluster(ctx, seg, node, head, hdr.headerSize);
    } else if (name === 'Cues') {
      seg.cues.push(node);
      if (dataSize > LIMITS.cuesLazy) {
        node.lazy = async (n) => {
          await loadMaster(ctx, n);
          labelTree(n);
          ctx.doc.recount();
        };
        node.label = `${Math.round(dataSize / 1024)} KiB: opened on demand`;
      } else {
        await loadMaster(ctx, node);
      }
    } else if (name === 'Void') {
      node.fields.push({ name: 'reserved space', type: 'binary', offset: s, size: dataSize, value: null, display: `${fmtInt(dataSize)} bytes`, reserved: true, desc: 'Ignored bytes. Only their count matters: it is space a writer can reuse later without moving the rest of the file.' });
    } else if (el?.type === 'm' || (!el && dataSize > LIMITS.leafMax)) {
      if (el) await loadMaster(ctx, node);
      else await bigLeaf(ctx, node, null);
    } else if (dataSize <= LIMITS.leafMax) {
      const u8 = await src.read(p, hdr.headerSize + dataSize);
      parseLeaf(ctx, node, el, u8, p, hdr.headerSize, Math.min(u8.length, hdr.headerSize + dataSize));
      if (name === 'CRC-32') node.warn('RFC 9559 says the Segment should not have a CRC-32 (it would cover the whole file); Vidscope does not verify it.');
    } else {
      await bigLeaf(ctx, node, el);
    }
    p = node.end;
    if (o.onProgress) o.onProgress(p, src.size);
  }
  return p;
}

async function parseSegment(ctx, root, p, hdr, head, onProgress) {
  const src = ctx.source;
  const s = p + hdr.headerSize;
  let end = hdr.unknown ? src.size : s + hdr.size;
  let truncated = 0;
  if (end > src.size) {
    truncated = end - src.size;
    end = src.size;
  }
  hdr.dataSize = end - s;
  const node = makeNode(ctx, root, hdr, p, E_SEGMENT, head, 0);
  const seg = newSegment(ctx, node, s, end, hdr.unknown);
  node.data.seg = seg;
  ctx.seg = seg;
  ctx.segments.push(seg);
  if (truncated) {
    node.warn(`Declares ${fmtInt(hdr.size)} bytes of data but the file ends ${fmtInt(truncated)} bytes earlier: the file is truncated.`);
    seg.truncated = truncated;
  }
  const stop = await parseLevel1(ctx, seg, node, s, end, { unknownParent: hdr.unknown, onProgress });
  if (hdr.unknown && stop < end) {
    node.size = stop - p;
    seg.end = stop;
  }
  return node.end;
}

/** Parse the whole file into `root`. */
export async function parseFile(ctx, root, onProgress) {
  const src = ctx.source;
  let p = 0;
  while (p < src.size) {
    if (src.size - p < 2) {
      const t = await src.read(p, src.size - p);
      tail(ctx, root, t, p, 0, t.length);
      break;
    }
    const head = await (src.peek ? src.peek(p, Math.min(src.size - p, 64)) : src.read(p, Math.min(src.size - p, 64)));
    const hdr = readHeader(head, 0, head.length, ctx.maxId, ctx.maxSize);
    if (hdr.error) {
      const next = await resync(ctx, p + 1, src.size);
      garbage(ctx, root, p, next ?? src.size, `Bytes at ${hex(p)} are not a valid element (${hdr.error}).${next !== null ? ` The next recognisable element starts at ${hex(next)}.` : ''}`);
      if (next === null) break;
      p = next;
      continue;
    }
    const el = BY_ID.get(hdr.id);
    if (el === E_EBML) {
      const s = p + hdr.headerSize;
      const size = hdr.unknown ? Math.min(src.size - s, 4096) : Math.min(hdr.size, src.size - s);
      if (!hdr.unknown && hdr.size > 1 << 20) {
        garbage(ctx, root, p, src.size, `The EBML header declares ${fmtInt(hdr.size)} bytes, which is not plausible.`);
        break;
      }
      const u8 = await src.read(p, hdr.headerSize + size);
      let dataSize = size;
      if (hdr.unknown) dataSize = findEndSync(ctx, E_EBML, u8, hdr.headerSize, u8.length) - hdr.headerSize;
      hdr.dataSize = dataSize;
      const node = makeNode(ctx, root, hdr, p, el, u8, 0);
      if (hdr.unknown) node.warn('The EBML header has an unknown size, which is not allowed.');
      if (!hdr.unknown && hdr.size > size) node.warn('The EBML header runs past the end of the file.');
      parseChildren(ctx, node, u8, p, hdr.headerSize, hdr.headerSize + dataSize);
      finalizeMaster(ctx, node, u8, p);
      p = node.end;
    } else if (el === E_SEGMENT) {
      if (!ctx.headers.length) root.warn('The Segment is not preceded by an EBML header.');
      p = await parseSegment(ctx, root, p, hdr, head, onProgress);
    } else if (el && (el.parent === 'Segment' || el.global) && !ctx.segments.length) {
      // No EBML header or Segment: a bare stream of top-level elements, such as a WebM media segment.
      ctx.bare = true;
      const seg = newSegment(ctx, root, 0, src.size, true);
      seg.bare = true;
      ctx.seg = seg;
      ctx.segments.push(seg);
      p = await parseLevel1(ctx, seg, root, p, src.size, { onProgress });
    } else {
      const s = p + hdr.headerSize;
      const dataSize = hdr.unknown ? src.size - s : Math.min(hdr.size, src.size - s);
      hdr.dataSize = dataSize;
      const node = makeNode(ctx, root, hdr, p, el, head, 0);
      if (el?.type === 'm' && dataSize <= LIMITS.inMemory) await loadMaster(ctx, node);
      else if (dataSize <= LIMITS.leafMax) {
        const u8 = await src.read(p, hdr.headerSize + dataSize);
        parseLeaf(ctx, node, el, u8, p, hdr.headerSize, Math.min(u8.length, hdr.headerSize + dataSize));
      } else await bigLeaf(ctx, node, el);
      p = node.end;
    }
  }
}

/** Index of the first Cluster (sorted by offset) that ends after `offset`. */
export function lowerClusterIndex(clusters, offset) {
  let lo = 0;
  let hi = clusters.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (clusters[mid].end <= offset) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
