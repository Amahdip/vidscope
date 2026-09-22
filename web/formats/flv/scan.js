// The full walk over an FLV file's tags. FLV has no index (unless a tool added
// a keyframes object to onMetaData), so finding every frame means reading every
// tag header. This is done once, in the background (loadSamples), with large
// sequential reads; the tree's tag groups and the frame tables are built from it.

import { Node } from '../../core/model.js';
import { Grow, WindowReader, u32be, u24be, tick } from '../../core/scan.js';
import { codecHeader, tagNode } from './tags.js';

const MAX_RESYNC = 4 << 20;
const MAX_SMALL_TAG = 4 << 20;

function plausible(u8, i) {
  const b = u8[i];
  return (b & 0xc0) === 0 && u8[i + 8] === 0 && u8[i + 9] === 0 && u8[i + 10] === 0;
}

/** Look for the next position that holds a tag whose PreviousTagSize matches. */
async function resync(ctx, wr, from, size) {
  const limit = Math.min(size - 15, from + MAX_RESYNC);
  for (let c = from; c <= limit; c++) {
    const { u8, i, avail } = await wr.at(c, 11);
    if (avail < 11) return null;
    const t = u8[i] & 0x1f;
    if ((t !== 8 && t !== 9 && t !== 18) || !plausible(u8, i)) continue;
    const d = u24be(u8, i + 1);
    const end = c + 11 + d;
    if (end + 4 > size) continue;
    const q = await wr.at(end, 4);
    if (u32be(q.u8, q.i) === 11 + d) return c;
    await wr.at(c, 11);
  }
  return null;
}

/**
 * Walk every tag from `start`. Returns per-tag arrays plus the garbage ranges,
 * the decoder configurations and the script data found on the way.
 */
export async function scanTags(ctx, start, onProgress) {
  const size = ctx.source.size;
  const wr = new WindowReader(ctx.source, 4 << 20);
  const offs = new Grow(Float64Array);
  const types = new Grow(Uint8Array);
  const dsz = new Grow(Uint32Array);
  const tss = new Grow(Int32Array);
  const prevs = new Grow(Float64Array);
  const heads = new Grow(Uint8Array, 8192);
  const flags = new Grow(Uint8Array);
  const garbage = [];
  const configs = [];
  const scripts = [];
  const scratch = new Node({ type: 'scratch', offset: 0, size });
  let pos = start;
  let truncated = null;
  let n = 0;
  while (pos + 11 <= size) {
    const { u8, i, avail } = await wr.at(pos, 11 + 16);
    if (avail < 11) break;
    const type = u8[i] & 0x1f;
    const dataSize = u24be(u8, i + 1);
    const known = type === 8 || type === 9 || type === 18;
    let ok = plausible(u8, i) && (known || pos + 11 + dataSize + 4 <= size);
    if (ok && !known) {
      const q = await wr.at(pos + 11 + dataSize, 4);
      ok = u32be(q.u8, q.i) === 11 + dataSize;
    }
    if (!ok) {
      const next = await resync(ctx, wr, pos + 1, size);
      garbage.push({ start: pos, end: next ?? size, resynced: next !== null });
      if (next === null) {
        pos = size;
        break;
      }
      pos = next;
      continue;
    }
    const again = await wr.at(pos, 11 + 16);
    const v = again.u8;
    const j = again.i;
    const ts = ((v[j + 7] << 24) | u24be(v, j + 4)) | 0;
    offs.push(pos);
    types.push(type);
    dsz.push(dataSize);
    tss.push(ts);
    flags.push((v[j] >> 5) & 1);
    const k = offs.n - 1;
    for (let b = 0; b < 8; b++) heads.push(dataSize > b && again.avail > 11 + b ? v[j + 11 + b] : 0);
    const tagEnd = pos + 11 + dataSize;
    if (tagEnd > size) {
      truncated = { index: k, missing: tagEnd - size };
      prevs.push(-1);
      pos = size;
      break;
    }
    let prev = -1;
    if (tagEnd + 4 <= size) {
      const q = await wr.at(tagEnd, 4);
      prev = u32be(q.u8, q.i);
    }
    prevs.push(prev);
    const filter = (v[j] >> 5) & 1;
    const h = codecHeader(type, v, j + 11, Math.min(8, again.avail - 11, dataSize), dataSize);
    if (!filter && !h.isFrame && (h.isConfig || h.isMeta || h.kind === 'script') && dataSize <= MAX_SMALL_TAG) {
      const buf = await ctx.source.read(pos, 11 + dataSize);
      const res = tagNode(ctx, scratch, buf, pos, 0, buf.length, {});
      scratch.children = null;
      if (res.config) configs.push({ index: k, offset: pos, kind: h.kind, h, cfg: res.config });
      if (res.meta) scripts.push({ index: k, offset: pos, kind: h.kind, name: res.meta.name, value: res.meta.value, values: res.meta.values, ts });
    }
    pos = tagEnd + (prev >= 0 ? 4 : 0);
    if (++n % 5000 === 0) {
      if (onProgress) onProgress(pos, size);
      await tick();
    }
  }
  if (onProgress) onProgress(size, size);
  return {
    count: offs.n,
    offs: offs.done(),
    types: types.done(),
    sizes: dsz.done(),
    ts: tss.done(),
    flags: flags.done(),
    prev: prevs.done(),
    heads: heads.done(),
    end: pos,
    garbage,
    truncated,
    configs,
    scripts,
    bytesRead: wr.bytesRead,
  };
}

/** Codec header of tag k from the scan's saved first data bytes. */
export function headOf(scan, k) {
  return codecHeader(scan.types[k], scan.heads, k * 8, Math.min(8, scan.sizes[k]), scan.sizes[k]);
}
