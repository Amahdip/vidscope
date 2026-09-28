// HLS playlists (RFC 8216): parse a multivariant ("master") or media playlist, and measure a
// presentation the way a player would meet it: every media playlist, the size of every segment,
// and a few segments opened with Vidscope's own parsers to see what they really hold. Fetching is
// left to the caller (`io` below), so this runs in Node and in a browser alike.
//
//   io.text(url)          -> the playlist text
//   io.size(url, range)   -> bytes of a segment (range: { offset, length } of EXT-X-BYTERANGE)
//   io.bytes(url, range)  -> the segment's bytes, for the few that are probed

import { openDocument } from '../formats/index.js';
import { BytesSource } from './source.js';
import { videoInfo } from './encoding.js';
import { frameRate } from './frames.js';

// ------------------------------------------------------------------ parsing

/** An attribute list ("BANDWIDTH=1280000,CODECS="avc1.4d401e,mp4a.40.2"") -> { NAME: value }. */
export function parseAttributes(text) {
  const out = {};
  for (const m of String(text).matchAll(/([A-Z0-9-]+)=("[^"]*"|[^,]*)/g)) out[m[1]] = m[2].startsWith('"') ? m[2].slice(1, -1) : m[2];
  return out;
}

const num = (v) => (v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);

function streamInf(a) {
  const res = /^(\d+)x(\d+)$/.exec(a.RESOLUTION ?? '');
  return {
    bandwidth: num(a.BANDWIDTH),
    averageBandwidth: num(a['AVERAGE-BANDWIDTH']),
    codecs: a.CODECS ? a.CODECS.split(',').map((s) => s.trim()).filter(Boolean) : null,
    resolution: res ? { width: Number(res[1]), height: Number(res[2]) } : null,
    frameRate: num(a['FRAME-RATE']),
    videoRange: a['VIDEO-RANGE'] ?? null,
    audio: a.AUDIO ?? null,
    programId: a['PROGRAM-ID'] ?? null,
  };
}

/** "n[@o]" -> { length, offset }; without @o the range follows the previous one of the same file. */
function byteRange(text, previousEnd) {
  const m = /^(\d+)(?:@(\d+))?$/.exec(String(text).trim());
  if (!m) return null;
  return { length: Number(m[1]), offset: m[2] !== undefined ? Number(m[2]) : (previousEnd ?? 0) };
}

/**
 * Parse a playlist. A multivariant playlist gives `variants`, `iframes` and `media`; a media
 * playlist gives `segments` and its timing tags. `needsVersion` is the protocol version its
 * contents require (RFC 8216 §7).
 */
export function parsePlaylist(text, url) {
  const resolve = (uri) => {
    try {
      return new URL(uri, url).href;
    } catch {
      return uri;
    }
  };
  const lines = String(text).replace(/^﻿/, '').split(/\r?\n/);
  const pl = {
    url, header: lines[0]?.trim() === '#EXTM3U', version: null, independentSegments: false,
    variants: [], iframes: [], media: [], segments: [],
    targetDuration: null, mediaSequence: 0, playlistType: null, endList: false, iframesOnly: false,
    encrypted: false, programId: false, allowCache: false, floatDurations: false, byteRanges: false, map: false, keyIv: false, keyFormat: false,
  };
  let stream = null;
  let seg = {};
  let map = null;
  const lastEnd = new Map(); // uri -> end of its previous byte range
  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;
    if (!line.startsWith('#')) {
      if (stream) {
        pl.variants.push({ ...stream, uri: line, url: resolve(line) });
        stream = null;
      } else {
        if (seg.range && seg.range.offset === null) seg.range.offset = lastEnd.get(line) ?? 0;
        if (seg.range) lastEnd.set(line, seg.range.offset + seg.range.length);
        pl.segments.push({ duration: seg.duration ?? null, range: seg.range ?? null, discontinuity: !!seg.discontinuity, uri: line, url: resolve(line), map, line: i + 1 });
        seg = {};
      }
      return;
    }
    if (!line.startsWith('#EXT')) return; // a comment
    const colon = line.indexOf(':');
    const tag = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? '' : line.slice(colon + 1);
    switch (tag) {
      case '#EXT-X-VERSION': pl.version = num(value); break;
      case '#EXT-X-INDEPENDENT-SEGMENTS': pl.independentSegments = true; break;
      case '#EXT-X-STREAM-INF': {
        const a = parseAttributes(value);
        if (a['PROGRAM-ID'] !== undefined) pl.programId = true;
        stream = { ...streamInf(a), line: i + 1 };
        break;
      }
      case '#EXT-X-I-FRAME-STREAM-INF': {
        const a = parseAttributes(value);
        if (a['PROGRAM-ID'] !== undefined) pl.programId = true;
        pl.iframes.push({ ...streamInf(a), uri: a.URI ?? null, url: a.URI ? resolve(a.URI) : null, line: i + 1 });
        break;
      }
      case '#EXT-X-MEDIA': {
        const a = parseAttributes(value);
        pl.media.push({ type: a.TYPE ?? null, groupId: a['GROUP-ID'] ?? null, name: a.NAME ?? null, language: a.LANGUAGE ?? null, channels: a.CHANNELS ?? null, uri: a.URI ?? null, url: a.URI ? resolve(a.URI) : null, line: i + 1 });
        break;
      }
      case '#EXT-X-TARGETDURATION': pl.targetDuration = num(value); break;
      case '#EXT-X-MEDIA-SEQUENCE': pl.mediaSequence = num(value) ?? 0; break;
      case '#EXT-X-PLAYLIST-TYPE': pl.playlistType = value.trim(); break;
      case '#EXT-X-ENDLIST': pl.endList = true; break;
      case '#EXT-X-I-FRAMES-ONLY': pl.iframesOnly = true; break;
      case '#EXT-X-ALLOW-CACHE': pl.allowCache = true; break;
      case '#EXT-X-DISCONTINUITY': seg.discontinuity = true; break;
      case '#EXTINF': {
        const d = value.split(',')[0].trim();
        seg.duration = num(d);
        if (d.includes('.')) pl.floatDurations = true;
        break;
      }
      case '#EXT-X-BYTERANGE': {
        const m = /^(\d+)(?:@(\d+))?$/.exec(value.trim());
        seg.range = m ? { length: Number(m[1]), offset: m[2] !== undefined ? Number(m[2]) : null } : null;
        pl.byteRanges = true;
        break;
      }
      case '#EXT-X-MAP': {
        const a = parseAttributes(value);
        map = a.URI ? { url: resolve(a.URI), range: a.BYTERANGE ? byteRange(a.BYTERANGE, 0) : null } : null;
        pl.map = true;
        break;
      }
      case '#EXT-X-KEY': {
        const a = parseAttributes(value);
        if (a.METHOD && a.METHOD !== 'NONE') pl.encrypted = true;
        if (a.IV) pl.keyIv = true;
        if (a.KEYFORMAT || a.KEYFORMATVERSIONS) pl.keyFormat = true;
        break;
      }
      default:
        break;
    }
  });
  pl.kind = pl.variants.length || pl.iframes.length ? 'master' : 'media';
  // RFC 8216 §7: the lowest EXT-X-VERSION the playlist's contents allow.
  let need = 1;
  if (pl.keyIv) need = Math.max(need, 2);
  if (pl.floatDurations) need = Math.max(need, 3);
  if (pl.byteRanges || pl.iframesOnly) need = Math.max(need, 4);
  if (pl.keyFormat || pl.map) need = Math.max(need, 5);
  if (pl.map && !pl.iframesOnly) need = Math.max(need, 6);
  pl.needsVersion = need;
  return pl;
}

// ------------------------------------------------------------------ rates

/**
 * The peak segment bit rate (RFC 8216 §4.1): the largest bit rate of any run of consecutive
 * segments lasting 0.5 to 1.5 target durations. Only runs of measured segments count, so when
 * sizes were sampled the result is a lower bound.
 */
export function peakSegmentRate(segments, target) {
  let best = null;
  for (let i = 0; i < segments.length; i++) {
    let bits = 0;
    let seconds = 0;
    for (let j = i; j < segments.length; j++) {
      const s = segments[j];
      if (s.size == null || !(s.duration > 0)) break;
      bits += s.size * 8;
      seconds += s.duration;
      if (seconds > 1.5 * target + 1e-9) break;
      if (seconds >= 0.5 * target - 1e-9 && (!best || bits / seconds > best.rate)) best = { rate: bits / seconds, start: i, count: j - i + 1, seconds };
    }
  }
  return best;
}

/** The average segment bit rate (RFC 8216 §4.1): all segment bits over the playlist's duration. */
export function averageSegmentRate(segments) {
  let bits = 0;
  let seconds = 0;
  for (const s of segments) {
    if (s.size == null || !(s.duration > 0)) continue;
    bits += s.size * 8;
    seconds += s.duration;
  }
  return seconds > 0 ? bits / seconds : null;
}

/** A URL without its query (signed links carry tokens that must not end up in reports). */
export function redact(url) {
  try {
    const u = new URL(url);
    if (u.protocol === 'file:') return decodeURIComponent(u.pathname);
    return `${u.origin}${u.pathname}${u.search ? '?…' : ''}`;
  } catch {
    return String(url).replace(/\?.*$/, '?…');
  }
}

// ------------------------------------------------------------------ probing

/** What a segment really holds, read by Vidscope's parsers. */
export async function probeSegment(bytes, name = 'segment') {
  try {
    const doc = await openDocument(new BytesSource(bytes, name));
    if (doc.format?.id === 'raw') return { error: 'not a media segment Vidscope reads' };
    if (doc.loadSamples) await doc.loadSamples();
    const v = doc.tracks.find((t) => t.kind === 'video');
    const a = doc.tracks.find((t) => t.kind === 'audio');
    const out = { format: doc.format?.id ?? null, video: null, audio: null };
    if (v) {
      const vi = videoInfo(doc, v);
      const s = v.samples;
      out.video = {
        codec: v.codecString ?? null,
        width: vi.width ?? null,
        height: vi.height ?? null,
        fps: s?.count > 1 ? frameRate(v) : null,
        frames: s?.count ?? 0,
        keyFirst: s?.count ? (s.key ? !!s.key[0] : true) : null,
        transfer: vi.sps?.vui?.transfer ?? null,
      };
    }
    if (a) out.audio = { codec: a.codecString ?? null, channels: a.channels ?? a.entry?.channels ?? null, sampleRate: a.sampleRate ?? a.entry?.sampleRate ?? null };
    return out;
  } catch (e) {
    return { error: String(e?.message ?? e) };
  }
}

// ------------------------------------------------------------------ measuring

async function pool(items, limit, fn) {
  let next = 0;
  const run = async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
}

/** A variant's name: the rendition name in its URI (…-360p.mp4/chunk.m3u8), else its picture height. */
function variantLabel(v, i) {
  let path = v.uri ?? '';
  try {
    path = new URL(v.url).pathname;
  } catch {
    // keep the URI as written
  }
  const named = [...path.matchAll(/(\d{3,4})p(?![a-z])/gi)].pop()?.[1];
  if (named) return `${named}p`;
  return v.resolution ? `${Math.min(v.resolution.width, v.resolution.height)}p` : `variant ${i + 1}`;
}

/** Indices to measure: all of them, or `max` spread evenly over the playlist. */
function pick(n, max) {
  if (n <= max) return Array.from({ length: n }, (_, i) => i);
  const out = new Set();
  for (let k = 0; k < max; k++) out.add(Math.round((k * (n - 1)) / (max - 1)));
  return [...out];
}

/**
 * Fetch and measure a presentation from its multivariant or media playlist. Returns
 * { url, master, playlists: [{ role, variant, url, label, parsed, segments, sized, peak, average,
 * probes, error }], requests }. Options: maxSegments (per playlist, sizes beyond it are sampled
 * evenly), probes (segments opened per playlist: first, middle, last), concurrency.
 */
export async function measureHls(url, io, { maxSegments = 2000, probes = 3, concurrency = 8, onProgress } = {}) {
  let requests = 0;
  const text = async (u) => {
    requests++;
    return io.text(u);
  };
  const top = parsePlaylist(await text(url), url);
  const out = { url, master: top.kind === 'master' ? top : null, playlists: [], requests: 0 };
  const entries = top.kind === 'master'
    ? [
      ...top.variants.map((v, i) => ({ role: 'variant', variant: i, url: v.url, label: variantLabel(v, i) })),
      ...top.media.filter((m) => m.url).map((m) => ({ role: 'rendition', group: m.groupId, type: m.type, url: m.url, label: `${(m.type ?? 'media').toLowerCase()} ${m.name ?? m.groupId ?? ''}`.trim() })),
      ...top.iframes.filter((f) => f.url).map((f, i) => ({ role: 'iframe', variant: i, url: f.url, label: `I-frame ${f.resolution ? `${Math.min(f.resolution.width, f.resolution.height)}p` : i + 1}` })),
    ]
    : [{ role: 'variant', variant: null, url, label: 'media playlist', parsed: top }];
  for (const e of entries) {
    const pl = { ...e, parsed: null, segments: [], sized: 0, sampled: false, peak: null, average: null, probes: [], error: null };
    out.playlists.push(pl);
    try {
      pl.parsed = e.parsed ?? parsePlaylist(await text(e.url), e.url);
    } catch (err) {
      pl.error = `the playlist could not be read: ${err.message ?? err}`;
      continue;
    }
    const segs = pl.parsed.segments.map((s) => ({ duration: s.duration, url: s.url, range: s.range, map: s.map, size: null, error: null }));
    pl.segments = segs;
    const which = pick(segs.length, maxSegments);
    pl.sampled = which.length < segs.length;
    await pool(which, concurrency, async (i) => {
      const s = segs[i];
      if (s.range) {
        s.size = s.range.length;
        return;
      }
      try {
        requests++;
        s.size = await io.size(s.url, null);
      } catch (err) {
        s.error = String(err?.message ?? err);
      }
    });
    pl.sized = segs.filter((s) => s.size != null).length;
    onProgress?.(pl.label, pl.sized, segs.length);
    const target = pl.parsed.targetDuration ?? Math.max(0, ...segs.map((s) => s.duration ?? 0));
    pl.peak = peakSegmentRate(segs, target);
    pl.average = averageSegmentRate(segs);
    if (e.role !== 'iframe' && probes > 0 && segs.length) {
      const at = [...new Set([0, Math.floor((segs.length - 1) / 2), segs.length - 1])].slice(0, probes);
      for (const i of at) {
        const s = segs[i];
        try {
          requests++;
          let bytes = await io.bytes(s.url, s.range);
          if (s.map) {
            requests++;
            const init = await io.bytes(s.map.url, s.map.range);
            const both = new Uint8Array(init.length + bytes.length);
            both.set(init);
            both.set(bytes, init.length);
            bytes = both;
          }
          pl.probes.push({ index: i, ...(await probeSegment(bytes, `segment ${i + 1}`)) });
        } catch (err) {
          pl.probes.push({ index: i, error: String(err?.message ?? err) });
        }
      }
    }
  }
  out.requests = requests;
  return out;
}
