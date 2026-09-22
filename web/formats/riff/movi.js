// The movi list can hold hundreds of thousands of chunks, so its children are
// created only when the list is opened (or the hex view shows its bytes).
//
// Listing chunks means reading every chunk header. When an index is available
// Vidscope uses it to pick group boundaries (every GROUP-th indexed chunk) so
// nothing but a handful of headers is read up front; each group then walks its
// own byte range when it is opened. Without an index the whole list is walked
// once with large sequential reads.

import { Node } from '../../core/model.js';
import { fmtInt, fmtDuration, hex } from '../../core/util.js';
import { Grow, WindowReader, printable4, u32le, u32be, fccFromNum, tick } from '../../core/scan.js';
import { readHeader, makeNode, parseSync, padInfo } from './parse.js';
import { lookupDef } from './chunks.js';

const GROUP = 500;
const LIST = 0x5453494c; // 'LIST' as a little-endian number

/**
 * Walk the chunk headers in [start, end). Returns parallel arrays of the
 * top-level chunks: offset, declared size (clamped), pad (0/1), id and list type.
 * `visit(offset, id, size, listType, wr)` is awaited for each chunk while the
 * window still holds its bytes.
 */
export async function walkChunks(ctx, start, end, wr = new WindowReader(ctx.source), visit = null) {
  const offs = new Grow(Float64Array);
  const sizes = new Grow(Float64Array);
  const pads = new Grow(Uint8Array);
  const ids = new Grow(Uint32Array);
  const lists = new Grow(Uint32Array);
  let pos = start;
  let stop = null;
  let n = 0;
  while (pos + 8 <= end) {
    const { u8, i, avail } = await wr.at(pos, 12);
    if (avail < 8) break;
    if (!printable4(u8, i)) {
      stop = { at: pos, why: `The bytes at ${hex(pos)} are not a chunk ID; the rest of this list cannot be read as chunks.` };
      break;
    }
    const id = u32le(u8, i);
    let size = ctx.le ? u32le(u8, i + 4) : u32be(u8, i + 4);
    let truncated = false;
    if (pos + 8 + size > end) {
      size = end - pos - 8;
      truncated = true;
    }
    let pad = 0;
    if (size % 2 === 1 && pos + 8 + size < end) {
      const pk = await wr.at(pos + 8 + size, 8);
      pad = padInfo(size, pos + 8 + size, end, pk.u8.subarray(pk.i, pk.i + Math.min(8, pk.avail))).pad;
    }
    const listType = id === LIST && avail >= 12 && size >= 4 ? u32le(u8, i + 8) : 0;
    offs.push(pos);
    sizes.push(size);
    pads.push(pad);
    ids.push(id);
    lists.push(listType);
    if (visit) await visit(pos, id, size, listType, wr);
    pos += 8 + size + pad;
    if (truncated) break;
    if (++n % 50000 === 0) await tick();
  }
  return {
    count: offs.n,
    offs: offs.done(),
    sizes: sizes.done(),
    pads: pads.done(),
    ids: ids.done(),
    lists: lists.done(),
    end: pos,
    stop,
    bytesRead: wr.bytesRead,
  };
}

/** Sorted chunk-header offsets inside `movi` known from the index, or null. */
function indexedOffsets(ctx, movi) {
  const doc = ctx.doc;
  if (!doc || ctx.hasRecLists) return null;
  const start = movi.offset + movi.headerSize;
  const end = movi.data.bodyEnd;
  const all = [];
  for (const t of doc.tracks) {
    const s = t.samples;
    if (!s || !s.count || !s.fromIndex) continue;
    for (let i = 0; i < s.count; i++) {
      const o = s.offsets[i] - 8;
      if (o >= start && o < end) all.push(o);
    }
  }
  for (const o of ctx.ixOffsets ?? []) if (o >= start && o < end) all.push(o);
  if (all.length <= GROUP) return null;
  const sorted = Float64Array.from(all).sort();
  const out = [];
  for (let k = 0; k < sorted.length; k++) if (!k || sorted[k] !== sorted[k - 1]) out.push(sorted[k]);
  return out;
}

export function moviLoader(ctx) {
  return async (movi) => {
    const start = movi.offset + movi.headerSize;
    const end = movi.data.bodyEnd;
    const known = indexedOffsets(ctx, movi);
    if (known && (await boundariesLookValid(ctx, known))) {
      const bounds = [];
      for (let k = 0; k < known.length; k += GROUP) bounds.push(known[k]);
      if (bounds[0] > start) bounds.unshift(start);
      bounds.push(end);
      for (let g = 0; g + 1 < bounds.length; g++) {
        const a = bounds[g];
        const b = bounds[g + 1];
        if (b <= a) continue;
        addGroup(ctx, movi, a, b, null, `from indexed chunk #${fmtInt(g * GROUP + 1)}`);
      }
      finishGroups(ctx, movi);
      return;
    }
    const w = await walkChunks(ctx, start, end);
    ctx.moviWalks.set(movi, w);
    if (w.count <= GROUP * 2) {
      await addChunks(ctx, movi, w, 0, w.count, end);
    } else {
      for (let k = 0; k < w.count; k += GROUP) {
        const last = Math.min(w.count, k + GROUP);
        const a = w.offs[k];
        const b = last < w.count ? w.offs[last] : w.end;
        addGroup(ctx, movi, a, b, { w, from: k, to: last }, `#${fmtInt(k + 1)}–#${fmtInt(last)}`);
      }
      finishGroups(ctx, movi);
    }
    tail(ctx, movi, w, end);
    ctx.doc?.recount();
  };
}

/** Spot-check a few group boundaries (each check costs a block read); groups walk their own range anyway. */
async function boundariesLookValid(ctx, known) {
  const groups = Math.ceil(known.length / GROUP);
  const step = Math.max(1, Math.floor(groups / 12));
  for (let g = 0; g < groups; g += step) {
    const h = await ctx.source.read(known[g * GROUP], 8);
    if (h.length < 8 || !printable4(h, 0)) return false;
  }
  return true;
}

/** Bytes after the last chunk of a list (garbage or zero padding). */
function tail(ctx, parent, w, end) {
  if (w.end >= end) return;
  const node = new Node({
    type: w.stop ? 'garbage' : 'padding',
    name: w.stop ? 'Unparsed bytes' : 'Leftover bytes',
    kind: 'region',
    offset: w.end,
    size: end - w.end,
    category: 'unknown',
  });
  node.def = {
    name: node.name,
    cat: 'unknown',
    desc: 'Bytes at the end of the list that do not form a complete chunk.',
    more: 'Either the file is damaged here, or a size field is wrong. Players that walk the chunks sequentially lose sync at this point; with an index they can still find the frames.',
  };
  node.warn(w.stop?.why ?? `${fmtInt(end - w.end)} bytes left over after the last chunk.`);
  parent.add(node);
}

function groupTimes(ctx, a, b) {
  const doc = ctx.doc;
  const v = doc?.tracks.find((t) => t.kind === 'video' && t.samples?.count) ?? doc?.tracks.find((t) => t.samples?.count);
  if (!v) return '';
  const s = v.samples;
  let lo = 0;
  let hi = s.count;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (s.offsets[mid] < a) lo = mid + 1;
    else hi = mid;
  }
  const first = lo;
  let last = first;
  while (last + 1 < s.count && s.offsets[last + 1] < b) last++;
  if (first >= s.count || s.offsets[first] >= b) return '';
  const ts = s.timescale || 1;
  return `${fmtDuration(s.dts[first] / ts)}–${fmtDuration(s.dts[last] / ts)}`;
}

function addGroup(ctx, movi, a, b, walk, label) {
  const g = new Node({ type: 'chunks', name: 'Group of movi chunks', kind: 'group', offset: a, size: b - a, category: 'media' });
  g.def = {
    name: 'Group of movi chunks',
    cat: 'media',
    desc: 'A run of consecutive chunks of the movi list. Vidscope groups them because a movi list can hold hundreds of thousands of chunks; the grouping is not part of the file.',
  };
  g.data.walk = walk;
  g.data.labelPrefix = label;
  g.lazy = async (node) => {
    let w = node.data.walk?.w;
    let from = node.data.walk?.from ?? 0;
    let to = node.data.walk?.to;
    if (!w) {
      w = await walkChunks(ctx, node.offset, node.end);
      from = 0;
      to = w.count;
    }
    await addChunks(ctx, node, w, from, to, node.end);
    if (!node.data.walk) tail(ctx, node, w, node.end);
    ctx.doc?.recount();
  };
  movi.add(g);
}

function finishGroups(ctx, movi) {
  const groups = movi.children ?? [];
  for (const g of groups) {
    if (g.type !== 'chunks') continue;
    const times = groupTimes(ctx, g.offset, g.end);
    g.label = [g.data.labelPrefix, times].filter(Boolean).join(' · ');
  }
  movi.data.summary = `${fmtInt(groups.length)} groups of up to ${GROUP} chunks`;
}

const HDR = new Uint8Array(12);

/** Create chunk nodes for walk entries [from, to) under `parent`. */
async function addChunks(ctx, parent, w, from, to, limit) {
  for (let k = from; k < to; k++) {
    const off = w.offs[k];
    const size = w.sizes[k];
    const id = w.ids[k];
    const isList = id === LIST;
    const def = isList ? {} : lookupDef(ctx, fccFromNum(id), null, parent);
    if (isList || !def.opaque) {
      // Small structural chunks (rec lists, ix## indexes): read and parse them fully.
      const want = Math.min(8 + size + w.pads[k], 8 + (def.maxRead ?? 16 << 20), limit - off);
      const buf = await ctx.source.read(off, want);
      parseSync(ctx, parent, buf, off, 0, buf.length);
      const node = parent.children[parent.children.length - 1];
      if (node && node.offset === off && node.size < 8 + size + w.pads[k]) {
        node.size = 8 + size + w.pads[k];
        node.warn(`Only the first ${fmtInt(want)} bytes of this ${fmtInt(size)}-byte chunk are decoded.`);
      }
      if (node && isList) labelList(ctx, node);
      continue;
    }
    // Media chunk: rebuild the 8-byte header from the walk instead of reading it.
    HDR[0] = id & 0xff;
    HDR[1] = (id >>> 8) & 0xff;
    HDR[2] = (id >>> 16) & 0xff;
    HDR[3] = (id >>> 24) & 0xff;
    const declared = size;
    if (ctx.le) {
      HDR[4] = declared & 0xff;
      HDR[5] = (declared >>> 8) & 0xff;
      HDR[6] = (declared >>> 16) & 0xff;
      HDR[7] = (declared >>> 24) & 0xff;
    } else {
      HDR[7] = declared & 0xff;
      HDR[6] = (declared >>> 8) & 0xff;
      HDR[5] = (declared >>> 16) & 0xff;
      HDR[4] = (declared >>> 24) & 0xff;
    }
    const hdr = readHeader(ctx, HDR.slice(0, 8), off, 0, 8, limit);
    if (hdr.error) continue;
    const node = makeNode(ctx, parent, hdr, off);
    if (w.pads[k]) {
      node.size += 1;
      node.fields.push({
        name: 'pad', type: 'uint8', offset: node.end - 1, size: 1, value: 0, display: '(pad byte)',
        desc: 'RIFF keeps every chunk on an even offset: a chunk whose size is odd is followed by one pad byte that ckSize does not count.',
      });
    }
    ctx.labelMedia?.(node);
    if ((k - from) % 5000 === 4999) await tick();
  }
}

function labelList(ctx, node) {
  if (node.type === 'rec ') {
    const kids = node.children ?? [];
    node.label = `${kids.length} chunk${kids.length === 1 ? '' : 's'}: ${kids.map((c) => c.type).join(' ')}`.slice(0, 80);
    for (const c of kids) ctx.labelMedia?.(c);
  }
}

