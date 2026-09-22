// Walks RIFF chunks. The top level and big containers are walked with small
// async reads; small lists (hdrl, INFO...) are read once and parsed from
// memory. Media payloads (movi, data) are never read here: movi gets its
// children lazily (see movi.js).
//
// A chunk is: ckID (FOURCC), ckSize (32-bit, little-endian in RIFF, big-endian
// in RIFX), ckSize bytes of data, then one pad byte when ckSize is odd so the
// next chunk starts on an even offset. RIFF and LIST chunks start their data
// with a second FOURCC (the form or list type) followed by sub-chunks.

import { Node } from '../../core/model.js';
import { FieldReader, ParseError } from '../../core/fields.js';
import { fmtInt, hex, fourcc as fourccOf } from '../../core/util.js';
import { printable4 } from '../../core/scan.js';
import { lookupDef, nodeDef } from './chunks.js';

const MAX_LIST_IN_MEMORY = 16 << 20;
const DEFAULT_MAX_READ = 16 << 20;
const RIFF_IDS = new Set(['RIFF', 'RF64', 'BW64', 'RIFX']);

export const isListId = (id) => id === 'LIST' || RIFF_IDS.has(id);

function sizeDisplay(ctx, id, declared, size) {
  if (declared === 0xffffffff && (ctx.ds64 || id === 'RF64' || id === 'BW64')) return '0xFFFFFFFF (-1: the real 64-bit size is in the ds64 chunk)';
  if (declared === 0xffffffff) return `0xFFFFFFFF (unknown: the writer never came back to fill it in, typical of a file written to a pipe)`;
  if (declared === 0 && isListId(id)) return '0 (not filled in by the writer)';
  let s = `${fmtInt(declared)} bytes`;
  if (size !== declared) s += ` (real size ${fmtInt(size)})`;
  if (size % 2 === 1) s += ', odd: a pad byte follows';
  return s;
}

/**
 * Read a chunk header at u8[pos]. `limit` is the absolute end of the enclosing
 * space. Returns {id, declared, size, headerSize, listType?, fields, truncated?, error?}.
 */
export function readHeader(ctx, u8, base, pos, bufEnd, limit) {
  const abs = base + pos;
  const out = { fields: [] };
  if (bufEnd - pos < 8 || limit - abs < 8) {
    out.error = 'short';
    return out;
  }
  if (!printable4(u8, pos)) {
    out.error = `The bytes at ${hex(abs)} (${fourccOf(u8, pos)}) are not a chunk ID, so the rest of the enclosing chunk cannot be read as chunks.`;
    out.bad = true;
    return out;
  }
  const r = new FieldReader(u8, base, { start: pos, end: bufEnd, out: out.fields, le: ctx.le });
  const id = r.fourcc('ckID', {
    role: 'header',
    desc: 'Chunk identifier: a four-character code (FOURCC). A reader skips chunks it does not know by jumping over ckSize bytes (plus the pad byte).',
  });
  const declared = r.u32('ckSize', {
    role: 'header',
    desc: 'Size of the chunk data in bytes. It does not count this 8-byte header, nor the pad byte that follows an odd-sized chunk.',
  });
  out.id = id;
  out.declared = declared;
  out.headerSize = 8;
  let size = declared;
  if (declared === 0xffffffff && ctx.ds64) {
    const real = ctx.ds64.sizeOf(id);
    if (real !== undefined) {
      size = real;
      out.fromDs64 = true;
    }
  }
  if (isListId(id) && bufEnd - r.pos >= 4 && limit - abs >= 12) {
    out.listType = r.fourcc(id === 'LIST' ? 'listType' : 'formType', {
      role: 'header',
      key: true,
      desc: id === 'LIST'
        ? 'What kind of list this is (hdrl, strl, movi, INFO...). The rest of the chunk is a sequence of sub-chunks.'
        : 'The form type: what kind of RIFF file this is (\'AVI \', \'AVIX\', \'WAVE\'...). The rest of the chunk is a sequence of sub-chunks.',
    });
    out.headerSize = 12;
  }
  // Streamed files leave the RIFF/LIST size at 0 or 0xFFFFFFFF: take the rest of the space.
  const avail = limit - abs - 8;
  if ((id === 'RF64' || id === 'BW64') && declared === 0xffffffff) {
    out.rf64 = true;
    size = avail;
  } else if (isListId(id) && (declared === 0xffffffff || declared === 0) && !out.fromDs64) {
    out.unknownSize = true;
    size = avail;
  }
  if (size > avail) {
    out.truncated = true;
    out.declaredEnd = abs + 8 + size;
    size = avail;
  }
  if (out.headerSize === 12 && size < 4) out.headerSize = 8 + size;
  out.size = size;
  out.fields[1].display = sizeDisplay(ctx, id, declared, size);
  return out;
}

/** Whether a pad byte follows an odd-sized chunk. `peek` = bytes starting where the pad would be. */
export function padInfo(size, padAbs, limit, peek) {
  if (size % 2 === 0 || padAbs >= limit) return { pad: 0 };
  if (peek && peek.length >= 5 && peek[0] !== 0 && printable4(peek, 0) && !printable4(peek, 1)) {
    return { pad: 0, missing: true };
  }
  return { pad: 1, value: peek?.[0] };
}

function padField(node, abs, value) {
  node.fields.push({
    name: 'pad',
    type: 'uint8',
    offset: abs,
    size: 1,
    value: value ?? 0,
    display: value === undefined || value === 0 ? '0 (pad byte)' : `${value} (a pad byte should be 0)`,
    desc: 'RIFF keeps every chunk on an even offset: a chunk whose size is odd is followed by one pad byte that ckSize does not count.',
  });
}

export function makeNode(ctx, parent, hdr, abs) {
  const def = lookupDef(ctx, hdr.id, hdr.listType, parent);
  const node = new Node({
    type: hdr.id === 'LIST' ? hdr.listType ?? 'LIST' : hdr.id,
    name: def.name,
    kind: 'chunk',
    offset: abs,
    size: hdr.size + 8,
    headerSize: hdr.headerSize,
    category: def.cat,
    def: nodeDef(def, hdr),
  });
  if (RIFF_IDS.has(hdr.id)) node.label = (hdr.listType ?? '').trim();
  node.fields = hdr.fields;
  node.data.id = hdr.id;
  node.data.listType = hdr.listType;
  node.data.declared = hdr.declared;
  node.data.bodyEnd = abs + 8 + hdr.size;
  node.data.rawDef = def;
  if (hdr.truncated) {
    node.warn(`ckSize says ${fmtInt(hdr.declared)} bytes but only ${fmtInt(hdr.size)} remain in the ${parent.parent ? `enclosing '${parent.type}'` : 'file'}${parent.parent ? '' : ' (the file is truncated or the size is wrong)'}.`);
  }
  if (hdr.unknownSize) node.warn(`ckSize is ${hdr.declared === 0 ? '0' : '0xFFFFFFFF'}: the writer never filled in the size (the file was probably written to a pipe or the recording was interrupted). Vidscope assumes the chunk runs to the end of its parent.`);
  parent.add(node);
  ctx.count++;
  return node;
}

function finishPad(ctx, node, pad) {
  if (pad.pad) {
    node.size += 1;
    padField(node, node.end - 1, pad.value);
  } else if (pad.missing) {
    node.warn('The chunk size is odd but no pad byte follows: the next chunk starts right away. Strict RIFF readers will lose sync here.');
  }
}

function parseBody(ctx, node, u8, base, start, end, partial = false) {
  const def = node.data.rawDef;
  const r = new FieldReader(u8, base, { start, end, out: node.fields, le: ctx.le });
  try {
    if (def.parse) def.parse(r, node, ctx);
    if (def.container) {
      parseSync(ctx, node, u8, base, r.pos, end);
    } else if (def.parse && r.pos < end && !partial) {
      const left = end - r.pos;
      const zero = u8.subarray(r.pos, end).every((b) => b === 0);
      r.bytes(zero ? 'padding' : 'trailing bytes', left, {
        desc: zero ? 'Zero bytes after the last field.' : 'Bytes after the last field that the structure does not account for.',
      });
      if (!zero && !def.tolerateTrailing) node.warn(`${fmtInt(left)} unexpected bytes after the last field.`);
    }
  } catch (e) {
    if (e instanceof ParseError) node.warn(e.message);
    else {
      node.warn(`Vidscope could not parse this chunk: ${e.message}`);
      if (ctx.strict) throw e;
    }
  }
}

function after(ctx, node) {
  const def = node.data.rawDef;
  if (!def.after) return;
  try {
    def.after(node, ctx);
  } catch (e) {
    node.warn(`Vidscope could not interpret this chunk: ${e.message}`);
    if (ctx.strict) throw e;
  }
}

function leftover(ctx, parent, u8, base, pos, end, why) {
  const n = end - pos;
  if (n <= 0) return;
  const zero = u8 ? u8.subarray(pos, Math.min(end, pos + 4096)).every((b) => b === 0) : false;
  const node = new Node({
    type: zero ? 'padding' : 'garbage',
    name: zero ? 'Zero padding' : 'Unparsed bytes',
    kind: 'region',
    offset: base + pos,
    size: n,
    category: zero ? 'free' : 'unknown',
  });
  node.def = {
    name: node.name,
    cat: node.category,
    desc: zero ? 'Zero bytes that do not form a chunk.' : 'Bytes that do not form a valid chunk.',
    more: zero ? 'Some writers pad the end of a list or file with zeros (for example to a sector boundary).' : 'Everything from here to the end of the enclosing chunk is unreadable as RIFF chunks. The file may be damaged, or a size field earlier in the file may be wrong.',
  };
  if (why) node.warn(why);
  else node.warn(`${fmtInt(n)} byte${n === 1 ? '' : 's'} left over after the last chunk${zero ? ' (all zero)' : ''}.`);
  parent.add(node);
  if (!zero) ctx.warnings.push({ offset: base + pos, msg: why ?? `Unparsed bytes at ${hex(base + pos)}` });
}

/** Parse the chunks in u8[start, end) (all in memory). */
export function parseSync(ctx, parent, u8, base, start, end) {
  let pos = start;
  while (pos < end) {
    if (end - pos < 8) {
      leftover(ctx, parent, u8, base, pos, end);
      return;
    }
    const hdr = readHeader(ctx, u8, base, pos, end, base + end);
    if (hdr.error) {
      leftover(ctx, parent, u8, base, pos, end, hdr.bad ? hdr.error : undefined);
      return;
    }
    const abs = base + pos;
    const node = makeNode(ctx, parent, hdr, abs);
    const bodyEnd = pos + 8 + hdr.size;
    const def = node.data.rawDef;
    if (def.lazy) {
      node.lazy = def.lazy(ctx);
    } else if (!def.opaque) {
      parseBody(ctx, node, u8, base, pos + hdr.headerSize, bodyEnd);
    } else if (def.peek) {
      parseBody(ctx, node, u8, base, pos + hdr.headerSize, Math.min(bodyEnd, pos + hdr.headerSize + def.peek), true);
    }
    const pad = padInfo(hdr.size, base + bodyEnd, base + end, u8.subarray(bodyEnd, Math.min(end, bodyEnd + 8)));
    finishPad(ctx, node, pad);
    after(ctx, node);
    pos = bodyEnd + pad.pad;
  }
}

/** Parse the chunks in [start, end) of the file with async reads. */
export async function parseAsync(ctx, parent, start, end, onProgress) {
  let pos = start;
  const src = ctx.source;
  while (pos < end) {
    const left = end - pos;
    if (left < 8) {
      const tail = await src.read(pos, left);
      leftover(ctx, parent, tail, pos, 0, tail.length);
      break;
    }
    const head = await src.read(pos, Math.min(left, 16));
    const hdr = readHeader(ctx, head, pos, 0, head.length, end);
    if (hdr.error) {
      const tail = await src.read(pos, Math.min(left, 4096));
      leftover(ctx, parent, tail, pos, 0, left, hdr.bad ? hdr.error : undefined);
      break;
    }
    const node = makeNode(ctx, parent, hdr, pos);
    const def = node.data.rawDef;
    const bodyStart = pos + hdr.headerSize;
    const bodyEnd = pos + 8 + hdr.size;
    if (def.lazy) {
      node.lazy = def.lazy(ctx);
    } else if (def.container && (hdr.size > MAX_LIST_IN_MEMORY || RIFF_IDS.has(hdr.id))) {
      if (def.parse) {
        const prefix = await src.read(pos, Math.min(hdr.size + 8, hdr.headerSize + 64));
        const r = new FieldReader(prefix, pos, { start: hdr.headerSize, end: prefix.length, out: node.fields, le: ctx.le });
        def.parse(r, node, ctx);
      }
      await parseAsync(ctx, node, bodyStart, bodyEnd, parent.parent ? undefined : onProgress);
    } else if (def.opaque) {
      if (def.peek) {
        const buf = await src.read(pos, Math.min(hdr.size + 8, hdr.headerSize + def.peek));
        parseBody(ctx, node, buf, pos, hdr.headerSize, buf.length, true);
      }
    } else if (hdr.size > (def.maxRead ?? DEFAULT_MAX_READ)) {
      node.warn(`This chunk is ${fmtInt(hdr.size)} bytes, more than Vidscope decodes (${fmtInt(def.maxRead ?? DEFAULT_MAX_READ)}); its fields are not shown.`);
    } else {
      const buf = await src.read(pos, hdr.size + 8);
      parseBody(ctx, node, buf, pos, hdr.headerSize, Math.min(buf.length, hdr.size + 8));
    }
    let pad = { pad: 0 };
    if (hdr.size % 2 === 1 && bodyEnd < end) {
      const peek = await src.read(bodyEnd, Math.min(8, end - bodyEnd));
      pad = padInfo(hdr.size, bodyEnd, end, peek);
    }
    finishPad(ctx, node, pad);
    after(ctx, node);
    pos = bodyEnd + pad.pad;
    if (onProgress) onProgress(pos, src.size);
  }
}
