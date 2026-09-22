// Walks the box tree. Top-level boxes are found with small async reads (so a
// 100 GB file costs a handful of reads); every box with fields is then read
// once and parsed from memory. mdat and other opaque payloads are never loaded.

import { Node } from '../../core/model.js';
import { FieldReader, ParseError } from '../../core/fields.js';
import { fourcc, isPrintableFourcc, fmtInt, hex } from '../../core/util.js';
import { BOXES, readFullHeader } from './boxes.js';
import { sampleEntryDef, CONFIG_IN_ENTRY } from './entries.js';
import { ilstItemDef, qtTextAtomDef, trefTypeDef, irefTypeDef, trackGroupDef, entityGroupDef } from './meta.js';
import { resolveDef } from './registry.js';

const MAX_IN_MEMORY = 64 * 1024 * 1024; // containers up to this size are read in one go
const NEVER_READ = new Set(['mdat', 'free', 'skip', 'wide', 'junk', 'JUNK']);

const TERMINATOR = {
  id: 'terminator',
  name: 'Terminator',
  cat: 'free',
  spec: 'QT',
  desc: 'An empty box with type 0 that QuickTime uses to end a list of atoms (for example inside wave).',
};

/** Vidscope's own definition for a box, taking its parent into account. */
function lookupOwn(type, parentType, ctx, typeNum) {
  if (typeNum === 0) return TERMINATOR;
  switch (parentType) {
    case 'stsd':
      return sampleEntryDef(type, ctx);
    case 'ilst':
      return ilstItemDef(type, ctx, typeNum);
    case 'tref':
      return trefTypeDef(type);
    case 'iref':
      return irefTypeDef(type);
    case 'trgr':
      return trackGroupDef(type);
    case 'grpl':
      return entityGroupDef(type);
    case 'udta':
      if (type.startsWith('©')) return qtTextAtomDef(type);
      break;
    default:
      break;
  }
  if (CONFIG_IN_ENTRY[type] && ctx.entry && parentType === ctx.entry.fourcc) return CONFIG_IN_ENTRY[type];
  return BOXES[type] ?? null;
}

/**
 * Read a box header at u8[pos]. `limit` is the absolute end of the enclosing
 * space (parent or file). Returns {type, typeNum, size, declared, headerSize, fields, error?, truncated?}.
 */
function readHeader(u8, base, pos, bufEnd, limit) {
  const abs = base + pos;
  const r = new FieldReader(u8, base, { start: pos, end: bufEnd });
  const out = { fields: r.out };
  try {
    const size32 = r.u32('size', { role: 'header' });
    const typeNum = r.dv.getUint32(r.pos);
    const type = r.fourcc('type', {
      role: 'header',
      desc: 'The four-character box type. Every box in the file is identified this way, and a reader skips types it does not know by jumping over the size above.',
    });
    let size = size32;
    let headerSize = 8;
    const sizeField = r.out[0];
    if (size32 === 1) {
      size = r.u64('largesize', {
        role: 'header',
        desc: 'The real size as a 64-bit number. Used when a box is 4 GB or larger, in which case the 32-bit size field holds 1.',
      });
      headerSize = 16;
      sizeField.display = '1 (the size follows as a 64-bit largesize)';
    } else if (size32 === 0) {
      size = limit - abs;
      sizeField.display = `0 (box extends to the end of the ${abs === 0 || limit === Infinity ? 'file' : 'enclosing space'})`;
    }
    if (type === 'uuid') {
      r.uuid('usertype', { role: 'header', desc: 'A 16-byte UUID naming this private box type.' });
      headerSize += 16;
    }
    out.type = type;
    out.typeNum = typeNum;
    out.headerSize = headerSize;
    out.declared = size;
    if (size32 !== 0 && size32 !== 1) {
      sizeField.display = `${fmtInt(size32)} bytes`;
    }
    sizeField.desc = `Total size of this box including the header. The next box starts at offset ${fmtInt(abs + size)}.`;
    if (size < headerSize) {
      out.error = `Box '${type}' at ${hex(abs)} declares size ${fmtInt(size)}, smaller than its own header`;
      return out;
    }
    if (!isPrintableFourcc(u8, pos + 4) && typeNum !== 0 && size32 !== 0 && (typeNum >>> 24) !== 0) {
      out.suspicious = true;
    }
    if (abs + size > limit) {
      out.truncated = true;
      size = limit - abs;
    }
    out.size = size;
  } catch (e) {
    if (!(e instanceof ParseError)) throw e;
    out.error = e.message;
  }
  return out;
}

function makeNode(ctx, parent, hdr, abs) {
  const own = lookupOwn(hdr.type, parent.type, ctx, hdr.typeNum);
  const def = resolveDef(hdr.type, parent.type, own);
  const node = new Node({
    type: hdr.type,
    name: def.name,
    kind: 'box',
    offset: abs,
    size: hdr.size,
    headerSize: hdr.headerSize,
    category: def.cat,
    def,
  });
  node.fields = hdr.fields;
  if (hdr.truncated) {
    node.warn(`Declares ${fmtInt(hdr.declared)} bytes but only ${fmtInt(hdr.size)} remain in its ${parent.parent ? `parent '${parent.type}'` : 'file'}${parent.parent ? '' : ' (the file is truncated)'}.`);
  }
  if (def.parents && !parentAllowed(def.parents, parent)) {
    const expected = def.parents.map((p) => (p === 'file' ? 'the top level' : p.length === 4 ? `'${p}'` : `a ${p}`));
    node.warn(`Found ${parent.parent ? `inside '${parent.type}'` : 'at the top level'}, but the specification places '${hdr.type}' in ${expected.join(', ')}.`);
  }
  parent.add(node);
  ctx.count++;
  return node;
}

// Parent names in the conformance data are 4CCs, 'file', '*' or sample entry classes.
const ENTRY_CLASSES = { SampleEntry: '', VisualSampleEntry: 'visual:', AudioSampleEntry: 'audio:' };

function parentAllowed(parents, parent) {
  if (parents.includes('*')) return true;
  if (parent.type === 'wave') return true; // QuickTime's free-form audio settings container
  if (!parent.parent) return parents.includes('file');
  if (parents.includes(parent.type)) return true;
  const id = parent.def?.id ?? '';
  const isEntry = parent.parent?.type === 'stsd';
  for (const p of parents) {
    if (p in ENTRY_CLASSES && isEntry && id.startsWith(ENTRY_CLASSES[p])) return true;
    if (p === 'RestrictedSampleEntry' && parent.type === 'resv') return true;
  }
  return false;
}

/** QuickTime meta boxes have no version/flags; ISO ones do. */
function metaIsQuickTime(u8, p, end) {
  if (end - p < 8) return false;
  const size = new DataView(u8.buffer, u8.byteOffset + p, 4).getUint32(0);
  return size >= 8 && size <= end - p && fourcc(u8, p + 4) === 'hdlr';
}

function parseBody(ctx, node, u8, base, start, end) {
  const d = node.def;
  const r = new FieldReader(u8, base, { start, end, out: node.fields });
  try {
    let full = d.full;
    if (node.type === 'meta' && metaIsQuickTime(u8, start, end)) {
      full = false;
      node.data.quicktime = true;
    }
    if (full) readFullHeader(r, node, d);
    if (d.parse) d.parse(r, node, ctx);
    if (d.container) {
      parseBoxesSync(ctx, node, u8, base, r.pos, end);
    } else if (d.parse && r.pos < end) {
      const left = end - r.pos;
      const zero = u8.subarray(r.pos, end).every((b) => b === 0);
      r.bytes('trailing bytes', left, {
        desc: zero ? 'Zero bytes after the last field.' : 'Bytes after the last field that the box definition does not account for.',
      });
      if (!zero) node.warn(`${fmtInt(left)} unexpected bytes after the last field.`);
    }
  } catch (e) {
    if (e instanceof ParseError) node.warn(e.message);
    else {
      node.warn(`Vidscope could not parse this box: ${e.message}`);
      if (ctx.strict) throw e;
    }
  }
}

function trailing(ctx, parent, u8, base, pos, end) {
  const n = end - pos;
  if (n <= 0) return;
  const zero = u8.subarray(pos, end).every((b) => b === 0);
  if (zero && parent.parent) {
    // QuickTime ends some atom lists with a 32-bit zero, and FFmpeg pads a few entries.
    parent.fields.push({
      name: n === 4 ? 'terminator' : 'padding',
      type: n === 4 ? 'uint32' : 'bytes',
      offset: base + pos,
      size: n,
      value: 0,
      display: n === 4 ? '0' : `${n} zero bytes`,
      desc: n === 4 ? 'A 32-bit zero that QuickTime allows at the end of a list of atoms (e.g. in udta).' : 'Zero bytes after the last child box, too short to be a box.',
    });
    return;
  }
  const node = new Node({ type: zero ? 'padding' : 'garbage', name: zero ? 'Zero padding' : 'Unparsed bytes', kind: 'region', offset: base + pos, size: n, category: zero ? 'free' : 'unknown' });
  node.def = { name: node.name, cat: node.category, desc: zero ? 'Zero bytes too short to be a box.' : 'Bytes that do not form a valid box.' };
  node.warn(`${fmtInt(n)} byte${n === 1 ? '' : 's'} left over after the last box${zero ? ' (all zero)' : ''}.`);
  parent.add(node);
}

function garbage(ctx, parent, abs, end, msg) {
  const node = new Node({ type: 'garbage', name: 'Unparsed bytes', kind: 'region', offset: abs, size: end - abs, category: 'unknown' });
  node.def = { name: 'Unparsed bytes', cat: 'unknown', desc: 'Bytes that do not form a valid box, so everything from here on is unreadable as boxes.' };
  node.warn(msg);
  parent.add(node);
  ctx.warnings.push({ offset: abs, msg });
}

export function parseBoxesSync(ctx, parent, u8, base, start, end) {
  let pos = start;
  while (pos < end) {
    if (end - pos < 8) {
      trailing(ctx, parent, u8, base, pos, end);
      return;
    }
    const hdr = readHeader(u8, base, pos, end, base + end);
    if (hdr.error) {
      garbage(ctx, parent, base + pos, base + end, hdr.error);
      return;
    }
    if (hdr.suspicious && parent.parent) {
      garbage(ctx, parent, base + pos, base + end, `Bytes at ${hex(base + pos)} don't look like a box header (type ${hdr.type}).`);
      return;
    }
    const node = makeNode(ctx, parent, hdr, base + pos);
    parseBody(ctx, node, u8, base, pos + hdr.headerSize, pos + hdr.size);
    pos += hdr.size;
  }
}

/** Parse boxes in [start, end) of the file with async reads. */
export async function parseBoxesAsync(ctx, parent, start, end, onProgress) {
  let pos = start;
  while (pos < end) {
    const left = end - pos;
    if (left < 8) {
      const tail = await ctx.source.read(pos, left);
      trailing(ctx, parent, tail, pos, 0, tail.length);
      break;
    }
    const head = ctx.source.peek ? await ctx.source.peek(pos, Math.min(left, 32)) : await ctx.source.read(pos, Math.min(left, 32));
    const hdr = readHeader(head, pos, 0, head.length, end);
    if (hdr.error) {
      garbage(ctx, parent, pos, end, hdr.error);
      break;
    }
    if (hdr.suspicious) {
      garbage(ctx, parent, pos, end, `Bytes at ${hex(pos)} don't look like a box header (type ${hdr.type}), so the rest of the file can't be read as boxes.`);
      break;
    }
    const own = lookupOwn(hdr.type, parent.type, ctx, hdr.typeNum);
    const known = own && (own.parse || own.container);
    if (NEVER_READ.has(hdr.type) || !known) {
      makeNode(ctx, parent, hdr, pos);
    } else if (own.container && hdr.size > MAX_IN_MEMORY) {
      const node = makeNode(ctx, parent, hdr, pos);
      const prefix = await ctx.source.read(pos, Math.min(hdr.size, hdr.headerSize + 64));
      const r = new FieldReader(prefix, pos, { start: hdr.headerSize, end: prefix.length, out: node.fields });
      if (own.full) readFullHeader(r, node, own);
      if (own.parse) own.parse(r, node, ctx);
      await parseBoxesAsync(ctx, node, pos + r.pos, pos + hdr.size);
    } else {
      const buf = ctx.source.peek && hdr.size <= 64 * 1024 ? await ctx.source.peek(pos, hdr.size) : await ctx.source.read(pos, hdr.size);
      const node = makeNode(ctx, parent, hdr, pos);
      const avail = Math.min(buf.length, hdr.size);
      parseBody(ctx, node, buf, pos, hdr.headerSize, avail);
    }
    pos += hdr.size;
    if (onProgress) onProgress(pos, ctx.source.size);
  }
}
