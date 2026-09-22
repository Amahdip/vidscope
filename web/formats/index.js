// Format registry: every supported container, tried in order of probe score.

import { CachedSource } from '../core/source.js';
import isobmff from './isobmff/index.js';
import matroska from './matroska/index.js';
import mpegts from './mpegts/index.js';
import riff from './riff/index.js';
import flv from './flv/index.js';
import raw from './raw/index.js';

// raw matches anything with the lowest score, so unknown files still open in the hex view.
export const FORMATS = [isobmff, matroska, mpegts, riff, flv, raw];

/** Detect the format of a source and parse it into a Doc. */
export async function openDocument(rawSource, { onProgress } = {}) {
  // Every read has a fixed cost (an HTTP request, or a trip to the browser's file
  // reader), so fetch 256 KB blocks: walking a fragmented file then costs one read
  // per few fragments instead of one per fragment.
  const source = rawSource instanceof CachedSource ? rawSource : new CachedSource(rawSource, { blockSize: 256 * 1024 });
  const head = await source.read(0, Math.min(source.size, 64 * 1024));
  let best = null;
  let bestScore = 0;
  for (const f of FORMATS) {
    const score = f.probe(head, source);
    if (score > bestScore) {
      best = f;
      bestScore = score;
    }
  }
  if (!best) {
    const err = new Error('Vidscope does not recognise this file format.');
    err.code = 'UNKNOWN_FORMAT';
    throw err;
  }
  return best.open(source, { onProgress });
}
