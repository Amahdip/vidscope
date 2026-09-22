// Packet layout: detect the packet size (188, 192 or 204 bytes) and where the
// first complete packet starts from the periodicity of the 0x47 sync byte, and
// walk the packets of a byte range with large reads, resynchronising after
// damage.

import { SYNC_BYTE, TS_SIZE } from './tables.js';

/**
 * { size, syncOffset, trailer, first, count, matches, label }
 *   size        bytes per packet unit (188, 192 or 204)
 *   syncOffset  bytes before the sync byte inside a unit (4 for BDAV M2TS)
 *   trailer     bytes after the 188-byte TS packet inside a unit (16 for 204, 4 for 192 with a trailer)
 *   first       file offset of the first complete unit
 */
export function detectLayout(head, fileSize = head.length) {
  let best = null;
  const limit = Math.min(head.length, 204 * 2 + 4);
  for (let pos = 0; pos < limit; pos++) {
    if (head[pos] !== SYNC_BYTE) continue;
    for (const size of [188, 192, 204]) {
      let n = 0;
      const max = Math.min(64, Math.floor((head.length - pos - 1) / size) + 1);
      while (n < max && head[pos + n * size] === SYNC_BYTE) n++;
      if (n < max) {
        // A mismatch before the end of the head: accept only long runs.
        if (n < 8) continue;
      }
      const better = !best || n > best.matches || (n === best.matches && best.size !== 188 && size === 188);
      if (better) best = { size, pos, matches: n, possible: max };
    }
    if (best && best.matches >= 32) break;
  }
  if (!best) return null;
  const { size, pos } = best;
  let syncOffset = 0;
  let trailer = size - TS_SIZE;
  if (size === 192 && pos !== 0) {
    // BDAV: 4-byte TP_extra_header before each packet.
    syncOffset = 4;
    trailer = 0;
  }
  let first = pos - syncOffset;
  if (first < 0) first += size;
  const count = Math.max(0, Math.floor((fileSize - first) / size));
  let label = 'MPEG-TS';
  if (size === 192) label = syncOffset ? 'M2TS / BDAV (192-byte packets)' : 'MPEG-TS (192-byte packets, 4-byte trailer)';
  if (size === 204) label = 'MPEG-TS (204-byte packets with Reed-Solomon parity)';
  return { size, syncOffset, trailer, first, count, matches: best.matches, possible: best.possible, label };
}

/** Is there a packet start at u8[p] (sync at p + syncOffset, confirmed by `need` more packets when the bytes are there)? */
export function syncAt(u8, p, L, need = 2) {
  if (u8[p + L.syncOffset] !== SYNC_BYTE) return false;
  for (let k = 1; k <= need; k++) {
    const q = p + L.syncOffset + k * L.size;
    if (q >= u8.length) break;
    if (u8[q] !== SYNC_BYTE) return false;
  }
  return true;
}

/** First index q ≥ from where packets start again (3 sync bytes in a row), or -1. */
export function findSync(u8, from, end, L) {
  for (let q = from; q + L.syncOffset < end; q++) {
    if (u8[q + L.syncOffset] !== SYNC_BYTE) continue;
    if (q + L.syncOffset + 2 * L.size >= end) return -1; // not enough bytes to confirm
    if (u8[q + L.syncOffset + L.size] === SYNC_BYTE && u8[q + L.syncOffset + 2 * L.size] === SYNC_BYTE) return q;
  }
  return -1;
}

/**
 * Walk every packet unit in the file range [start, end) with large reads.
 * onPacket(u8, p, fileOffset, index) is called synchronously for each unit
 * whose sync byte is present; onLost(fromOffset, toOffset) for skipped bytes.
 * Returns the number of packets visited.
 */
export async function walkPackets(source, L, start, end, onPacket, { onLost, onProgress, chunkBytes = 4 * 1024 * 1024, shouldStop } = {}) {
  const S = L.size;
  const per = Math.max(4, Math.floor(chunkBytes / S));
  let pos = start;
  let index = 0;
  let lostFrom = -1;
  while (pos + S <= end) {
    const want = Math.min(end - pos, per * S);
    const u8 = await source.read(pos, want);
    if (u8.length < S) break;
    const atEnd = u8.length < want || pos + u8.length >= end;
    let p = 0;
    let stop = false;
    while (p + S <= u8.length) {
      if (lostFrom < 0 && u8[p + L.syncOffset] === SYNC_BYTE) {
        onPacket(u8, p, pos + p, index++);
        p += S;
        continue;
      }
      // Sync lost (or still lost): resume only where 3 sync bytes in a row confirm it.
      if (lostFrom < 0) lostFrom = pos + p;
      const q = findSync(u8, pos + p === lostFrom ? p + 1 : p, u8.length, L);
      if (q < 0) {
        if (atEnd) stop = true;
        // Not in this buffer: keep the tail (it may hold the next sync) and read on.
        else p = Math.max(p + 1, u8.length - 3 * S);
        break;
      }
      onLost?.(lostFrom, pos + q);
      lostFrom = -1;
      p = q;
    }
    if (stop || p === 0) break;
    pos += p;
    if (onProgress) onProgress(pos - start, end - start);
    if (shouldStop?.()) break;
    if (atEnd && lostFrom < 0) break;
  }
  if (lostFrom >= 0) onLost?.(lostFrom, end);
  return index;
}
