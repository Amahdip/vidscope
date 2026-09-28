// `vidscope audit`: check files or URLs against the audit rules, alone and as ladders.
//
// Files are read from disk; URLs are read with HTTP range requests, only the bytes the rules
// need (the index in full, a budget of frame data). With ffmpeg installed, --measure adds
// loudness and, given --source, fidelity to the source.

import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openDocument } from '../web/formats/index.js';
import { HttpSource } from '../web/core/source.js';
import { NodeFileSource } from './node-source.mjs';
import { auditFile, auditLadder, auditPlaylist, auditMarkdown, tally, allRules, SPECS, mergeExpect, validateExpect, buildReport, toSarif as sarifOf } from '../web/core/audit.js';
import { contentStem } from '../web/core/compare.js';
import { measureHls, redact } from '../web/core/hls.js';

const run = promisify(execFile);

export const HELP = `vidscope audit - check files against streaming standards

Usage
  vidscope audit [options] <file-or-url>...

  Files that are renditions of one content (movie-1080p.mp4, movie-720p.mp4, ...) are audited
  together as a ladder: aligned key frames, segment lengths, bitrate steps, one audio.
  An HLS playlist (a file or URL starting with #EXTM3U) is audited as a presentation: every
  media playlist, the size of every segment, and a few segments opened, against what the
  playlists declare (BANDWIDTH, AVERAGE-BANDWIDTH, CODECS, RESOLUTION, FRAME-RATE, durations).

Options
  --json <file|->        write the JSON report (schema: docs/audit-report.schema.json)
  --md <file|->          write the Markdown report
  --sarif <file|->       write a SARIF 2.1.0 log (for code-scanning style dashboards)
  --expect <k=v,...>     what the service intends, e.g. gop=5,fpsMax=60,peakRatio=2,
                         colour=1/1/1,audio.codec="AAC LC",audio.sampleRate=44100,
                         audio.required=true,loudness=-16,loudnessTolerance=1,truePeak=-1,
                         segments=5/10 (repeatable; later values merge over earlier ones)
  --expect-file <json>   the same, from a JSON file
  --ladder               audit every input as one ladder (default: group renditions by name)
  --no-ladder            never group
  --header "K: V"        HTTP header for URL inputs and a URL --source (repeatable)
  --segments <n>         HLS: segment sizes to measure per playlist (default 2000; beyond it
                         they are spread evenly and the measured peak is a lower bound)
  --probes <n>           HLS: segments per playlist opened to see what they hold (default 3)
  --budget <MB[,MB...]>  frame data to read per input, in order (the last value repeats;
                         default: 32 for URLs, all for files), e.g. 32,32,8,8,8,8 for a ladder
  --digest               SHA-256 of the index and of every byte range read, in facts.digest
  --measure              run ffmpeg: loudness (ebur128) and, with --source, PSNR/SSIM
  --decode               decode every frame with ffmpeg and report damage (reads the whole file)
  --source <file|url>    the source the inputs were converted from, for --measure
  --rules                list the rules and exit
  --quiet                no summary on stderr
  -h, --help             this help

Exit code: 2 when any check is CRITICAL, 1 when any is a WARNING, 3 when an input could not
be audited (the other inputs still are), 64 for a usage error, 70 when ffmpeg was asked for
but could not run.
`;

export { mergeExpect, validateExpect };

function parseArgs(argv) {
  const o = { inputs: [], headers: {}, json: null, md: null, sarif: null, expect: {}, ladder: null, budget: null, digest: false, measure: false, source: null, rules: false, quiet: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      return argv[++i];
    };
    switch (a) {
      case '-h': case '--help': o.help = true; break;
      case '--json': o.json = val(); break;
      case '--md': o.md = val(); break;
      case '--sarif': o.sarif = val(); break;
      case '--expect': mergeExpect(o.expect, validateExpect(parseExpect(val()))); break;
      case '--expect-file': mergeExpect(o.expect, validateExpect(JSON.parse(fs.readFileSync(val(), 'utf8')))); break;
      case '--ladder': o.ladder = true; break;
      case '--no-ladder': o.ladder = false; break;
      case '--header': {
        const h = val();
        const k = h.indexOf(':');
        if (k <= 0) throw new Error(`--header wants "Name: value", got ${h}`);
        o.headers[h.slice(0, k).trim()] = h.slice(k + 1).trim();
        break;
      }
      case '--segments': o.segments = Number(val()); break;
      case '--probes': o.probes = Number(val()); break;
      case '--budget': {
        const list = val().split(',').map((x) => Number(x.trim()));
        if (!list.length || list.some((mb) => !Number.isFinite(mb) || mb < 0)) throw new Error('--budget wants megabytes, one value or a comma list');
        o.budget = list.map((mb) => mb * 1048576);
        break;
      }
      case '--digest': o.digest = true; break;
      case '--measure': o.measure = true; break;
      case '--decode': o.decode = true; break;
      case '--source': o.source = val(); break;
      case '--rules': o.rules = true; break;
      case '--quiet': o.quiet = true; break;
      default:
        if (a.startsWith('-') && a !== '-') throw new Error(`unknown option ${a}`);
        o.inputs.push(a);
    }
  }
  const toStdout = [o.json, o.md, o.sarif].filter((t) => t === '-').length;
  if (toStdout > 1) throw new Error('only one report can go to standard output (-)');
  return o;
}

/** "gop=5,colour=1/1/1,audio.codec=AAC LC,audio.required=true" -> an expectation object. */
export function parseExpect(text) {
  const ex = {};
  for (const part of text.split(/,(?=\s*[a-zA-Z.]+=)/)) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    let value = part.slice(eq + 1).trim().replace(/^"|"$/g, '');
    if (!key) continue;
    if (key === 'colour') {
      const [p, t, m] = value.split('/').map(Number);
      if ([p, t, m].some((x) => !Number.isInteger(x))) throw new Error(`colour wants primaries/transfer/matrix as numbers, got ${value}`);
      ex.colour = { primaries: p, transfer: t, matrix: m };
      continue;
    }
    if (key === 'segments') {
      ex.segments = value.split('/').map(Number);
      if (ex.segments.some((x) => !(x > 0))) throw new Error(`segments wants lengths in seconds, got ${value}`);
      continue;
    }
    const loud = { loudness: 'integrated', loudnessTolerance: 'tolerance', truePeak: 'truePeakMax' }[key];
    if (loud) {
      const n = Number(value);
      if (Number.isNaN(n)) throw new Error(`${key} wants a number, got ${value}`);
      ex.loudness = { ...(ex.loudness ?? {}), [loud]: n };
      continue;
    }
    if (value === 'true' || value === 'false') value = value === 'true';
    else if (value !== '' && !Number.isNaN(Number(value))) value = Number(value);
    const keys = key.split('.');
    let at = ex;
    for (const k of keys.slice(0, -1)) at = at[k] ??= {};
    at[keys[keys.length - 1]] = value;
  }
  return ex;
}

const isUrl = (s) => /^https?:\/\//i.test(s);

async function openInput(input, o) {
  if (isUrl(input)) return HttpSource.open(input, { headers: o.headers });
  return NodeFileSource.open(input);
}

/** ffmpeg's -headers value: every header on its own CRLF line. */
const headerArg = (headers) => Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join('');

async function ffmpeg(args) {
  try {
    const { stderr } = await run('ffmpeg', ['-v', 'info', '-nostdin', ...args], { maxBuffer: 64 << 20 });
    return { ok: true, stderr };
  } catch (e) {
    if (e.code === 'ENOENT') return { ok: false, missing: true, stderr: 'ffmpeg is not installed or not on PATH' };
    return { ok: false, stderr: String(e.stderr ?? e.message ?? e).split('\n').filter(Boolean).slice(-4).join(' | ') };
  }
}

/** Run a command and hand each line of its output to a callback; stop() ends it early. */
function spawnLines(cmd, args, { stdout, stderr, timeoutMs = 30 * 60000 } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      resolve({ code: null, missing: e.code === 'ENOENT', error: String(e.message ?? e) });
      return;
    }
    let stopped = false;
    const stop = () => {
      stopped = true;
      child.kill('SIGKILL');
    };
    const timer = setTimeout(() => {
      stopped = 'timeout';
      child.kill('SIGKILL');
    }, timeoutMs);
    const feed = (stream, fn) => {
      let rest = '';
      stream.setEncoding('utf8');
      stream.on('data', (chunk) => {
        const parts = (rest + chunk).split(/\r?\n/);
        rest = parts.pop();
        for (const l of parts) if (l) fn?.(l, stop);
      });
      stream.on('end', () => rest && fn?.(rest, stop));
    };
    feed(child.stdout, stdout);
    feed(child.stderr, stderr);
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: null, missing: e.code === 'ENOENT', error: String(e.message ?? e) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stopped });
    });
  });
}

// A line from a decoder (not from the demuxer or the muxer): FFmpeg names the decoder, or says
// a decoded frame came out corrupt.
const DECODER_LINE = /corrupt decoded frame|\[dec:|^\[(h264|hevc|av1|libdav1d|vp[89]|mpeg[124]\w*|mjpeg|aac|mp3\w*|mp2\w*|opus|e?ac3|flac|vorbis|alac|dca|truehd|pcm_\w+)\b/;
const bare = (l) => l.replace(/ @ 0x[0-9a-f]+/g, '').replace(/^\[vist#[^\]]*\] /, '').trim();
let ffmpegVersion;

/**
 * Decode every video and audio frame with FFmpeg. A clean file prints nothing at -v warning;
 * on damage, a second pass with one decoder thread and showinfo finds when the damaged frames
 * are shown. Returns { tool, frames, errors, corruptFrames, messages, container, at, firstAt, ms }
 * or { error, missing }.
 */
async function decodeAll(input, headers, { locate = 10, timeoutMs = 30 * 60000 } = {}) {
  const hdr = isUrl(input) && Object.keys(headers).length ? ['-headers', headerArg(headers)] : [];
  const t0 = Date.now();
  if (ffmpegVersion === undefined) {
    const v = await run('ffmpeg', ['-hide_banner', '-version']).catch(() => null);
    ffmpegVersion = v ? /version (\S+)/.exec(v.stdout)?.[1] ?? null : null;
  }
  let frames = 0;
  let errors = 0;
  let corruptFrames = 0;
  const messages = new Map(); // decoder message -> count
  const container = new Map();
  // One decoder thread: with frame threads FFmpeg's decoders sometimes let a damaged frame
  // through without flagging it (1 run in 6 on a test file); single-threaded they never did.
  const p1 = await spawnLines('ffmpeg', ['-hide_banner', '-nostdin', '-v', 'warning', '-progress', 'pipe:1', '-stats_period', '5', '-threads', '1', ...hdr, '-i', input, '-map', '0:v?', '-map', '0:a?', '-f', 'null', '-'], {
    timeoutMs,
    stdout: (l) => {
      const m = /^frame=(\d+)/.exec(l);
      if (m) frames = Number(m[1]);
    },
    stderr: (l) => {
      const b = bare(l);
      if (DECODER_LINE.test(l)) {
        errors++;
        if (/corrupt decoded frame/.test(l)) corruptFrames++;
        if (messages.size < 50 || messages.has(b)) messages.set(b, (messages.get(b) ?? 0) + 1);
      } else if (container.size < 20) container.set(b, (container.get(b) ?? 0) + 1);
    },
  });
  if (p1.missing) return { error: 'ffmpeg is not installed or not on PATH', missing: true };
  if (p1.stopped === 'timeout') return { error: `the decode took longer than ${Math.round(timeoutMs / 60000)} minutes` };
  if (p1.code !== 0 && !errors) return { error: [...container.keys()].slice(-2).join(' | ') || `ffmpeg exited with ${p1.code}` };
  const at = [];
  if (errors) {
    // Where: with one decoder thread, FFmpeg reports a damaged frame just before the filter shows
    // it. When it flags damaged frames, those are what is located (the decoder's own messages
    // about concealing come a frame or two earlier); otherwise any decoder message.
    const marks = corruptFrames ? /corrupt decoded frame/ : DECODER_LINE;
    let pending = false;
    await spawnLines('ffmpeg', ['-hide_banner', '-nostdin', '-v', 'info', '-threads', '1', ...hdr, '-i', input, '-map', '0:v:0', '-vf', 'showinfo=checksum=0', '-f', 'null', '-'], {
      timeoutMs,
      stderr: (l, stop) => {
        if (marks.test(l)) pending = true;
        else if (pending && /Parsed_showinfo/.test(l)) {
          const m = /pts_time:\s*(-?[\d.]+)/.exec(l);
          if (m) {
            if (at[at.length - 1] !== Number(m[1])) at.push(Number(m[1]));
            pending = false;
            if (at.length >= locate) stop();
          }
        }
      },
    });
  }
  const list = (m) => [...m].map(([text, count]) => (count > 1 ? `${text} (×${count})` : text));
  return { tool: ffmpegVersion ? `FFmpeg ${ffmpegVersion}` : 'FFmpeg', frames, errors, corruptFrames, messages: list(messages).slice(0, 8), container: list(container).slice(0, 5), at, firstAt: at[0] ?? null, ms: Date.now() - t0 };
}

/** Integrated loudness and true peak with ffmpeg's ebur128 filter. */
async function measureLoudness(input, headers) {
  const args = [];
  if (isUrl(input) && Object.keys(headers).length) args.push('-headers', headerArg(headers));
  args.push('-i', input, '-vn', '-af', 'ebur128=peak=true', '-f', 'null', '-');
  const r = await ffmpeg(args);
  if (!r.ok) return { error: r.stderr, missing: r.missing };
  const tail = r.stderr.slice(r.stderr.lastIndexOf('Integrated loudness'));
  const i = /I:\s*(-?[\d.]+) LUFS/.exec(tail);
  const tp = /Peak:\s*(-?[\d.]+) dBFS/.exec(tail);
  if (!i) return { error: /Output file is empty|does not contain any stream|Stream map .* matches no streams/.test(r.stderr) ? 'no audio stream' : 'ffmpeg printed no loudness' };
  return { integrated: Number(i[1]), truePeak: tp ? Number(tp[1]) : undefined };
}

/** PSNR and SSIM of the luma plane against the source scaled to the input's size. */
async function measureQuality(input, source, headers, width, height) {
  const hdr = Object.keys(headers).length ? ['-headers', headerArg(headers)] : [];
  const out = {};
  let error = null;
  for (const [filter, re, key] of [['psnr', /average:([\d.]+)/, 'psnr'], ['ssim', /All:([\d.]+)/, 'ssim']]) {
    const args = [...(isUrl(input) ? hdr : []), '-i', input, ...(isUrl(source) ? hdr : []), '-i', source, '-filter_complex', `[1:v]scale=${width}:${height}:flags=bicubic[ref];[0:v][ref]${filter}`, '-f', 'null', '-'];
    const r = await ffmpeg(args);
    if (!r.ok) {
      error = r.stderr;
      if (r.missing) return { error, missing: true };
      continue;
    }
    const m = re.exec(r.stderr);
    if (m) out[key] = Number(m[1]);
  }
  return Object.keys(out).length ? out : { error: error ?? 'ffmpeg printed no psnr/ssim' };
}

const skip = (id, category, title, text) => ({ id, category, level: 'skip', title, text, spec: 'practice', clause: null });

/** Audit every input; a failure on one input is recorded and the others still run. */
export async function auditInputs(o, log = () => {}) {
  const results = [];
  const playlists = [];
  let ffmpegMissing = false;
  for (const [index, input] of o.inputs.entries()) {
    const t0 = Date.now();
    let src = null;
    try {
      src = await openInput(input, o);
      const doc = await openDocument(src);
      const budget = o.budget ? o.budget[Math.min(index, o.budget.length - 1)] : isUrl(input) ? 32 * 1048576 : 0;
      const measured = {};
      const skipped = [];
      let res = await auditFile(doc, o.expect, { payloadBudget: budget });
      if (o.decode && !res.unsupported) {
        log(`${isUrl(input) ? input.replace(/\?.*$/, '?…') : input}: decoding every frame`);
        const encrypted = doc.tracks.some((t) => t.encrypted || t.encryption);
        const d = encrypted ? { error: 'the samples are encrypted: decoding them needs the key' } : await decodeAll(input, o.headers);
        if (d.missing) ffmpegMissing = true;
        measured.decode = d;
        if (!o.measure) res = await auditFile(doc, o.expect, { payloadBudget: budget, measured });
      }
      if (o.measure) {
        const l = await measureLoudness(input, o.headers);
        if (l.error) {
          if (l.missing) ffmpegMissing = true;
          skipped.push(skip('loudness', 'Audio', 'Loudness not measured', l.error));
        } else measured.loudness = l;
        if (o.source && res.facts.video) {
          const q = await measureQuality(input, o.source, o.headers, res.facts.video.width, res.facts.video.height);
          if (q.error) {
            if (q.missing) ffmpegMissing = true;
            skipped.push(skip('quality', 'Video', 'Fidelity not measured', q.error));
          } else measured.quality = q;
        }
        if (Object.keys(measured).length) res = await auditFile(doc, o.expect, { payloadBudget: budget, measured });
        // A measurement that failed says why, in place of the plain "not measured".
        res.checks = res.checks.filter((c) => !(c.level === 'skip' && skipped.some((s) => s.id === c.id)));
        res.checks.push(...skipped);
        for (const s of skipped) log(`${input}: ${s.title.toLowerCase()}: ${s.text}`);
      }
      if (res.unsupported && /HLS playlist/i.test(res.unsupported)) {
        const url = isUrl(input) ? input : pathToFileURL(path.resolve(input)).href;
        const shown = isUrl(input) ? redact(input) : input;
        const m = await measureHls(url, hlsIo(o), {
          maxSegments: o.segments ?? 2000,
          probes: o.probes ?? 3,
          onProgress: (label, n, total) => log(`${shown}: ${label}: ${n} of ${total} segment sizes`),
        });
        const a = auditPlaylist(m, o.expect);
        playlists.push({ input, file: res.file, ms: Date.now() - t0, facts: a.facts, checks: a.checks });
        log(`${shown}: ${summaryLine(a.checks)}, ${m.requests} requests in ${Date.now() - t0} ms`);
        continue;
      }
      if (res.unsupported) {
        const message = `not audited: ${res.unsupported}${/playlist|manifest/i.test(res.unsupported) ? ' (DASH manifests are not audited yet; give the renditions)' : ''}`;
        results.push({ input, file: res.file, error: message, reason: 'unsupported', ms: Date.now() - t0, facts: res.facts, checks: res.checks, item: null });
        log(`${input}: ${message}`);
        continue;
      }
      res.input = input;
      res.ms = Date.now() - t0;
      res.facts.bytesRead = src.stats?.bytes ?? doc.source?.stats?.bytes ?? null;
      res.facts.requests = src.stats?.requests ?? null;
      if (o.digest) res.facts.digest = await digests(doc, res.facts);
      results.push(res);
      log(`${input}: ${summaryLine(res.checks)}${res.facts.bytesRead ? `, ${(res.facts.bytesRead / 1048576).toFixed(1)} MB read` : ''} in ${res.ms} ms`);
    } catch (e) {
      const message = String(e?.message ?? e);
      const reason = e?.code === 'NO_RANGE_SUPPORT' ? 'unavailable:no-range' : e?.code === 'ENOENT' ? 'unavailable:missing' : /HTTP 40[34]|HTTP 410/.test(message) ? 'unavailable:missing' : 'error';
      results.push({ input, file: isUrl(input) ? input.split('/').pop() : path.basename(input), error: message, reason, ms: Date.now() - t0, facts: { name: path.basename(input) }, checks: [], item: null });
      log(`${input}: could not be audited: ${message}`);
    } finally {
      if (src?.close) await src.close().catch(() => {});
    }
  }
  // Ladders: every input as one, or renditions of one content grouped by folder and name.
  const ladders = [];
  const ok = results.filter((r) => !r.error && r.item);
  if (ok.length >= 2 && o.ladder !== false) {
    const groups = new Map();
    for (const r of ok) {
      const key = o.ladder ? 'all' : ladderKey(r.input);
      if (!key) continue;
      groups.get(key)?.push(r) ?? groups.set(key, [r]);
    }
    for (const [key, group] of groups) {
      if (group.length < 2) continue;
      ladders.push({ key, inputs: group.map((r) => r.input), ...auditLadder(group, o.expect) });
      if (!o.ladder) log(`ladder: ${group.map((r) => r.file).join(' + ')}`);
    }
  }
  return { results, ladders, playlists, ffmpegMissing };
}

// A name is a rendition of some content when it carries a size, quality or version token;
// "movie-1.mp4" and "movie-2.mp4" are two movies, not two renditions.
const RENDITION = /(\d{3,4}p(?![a-z])|\d{3,4}x\d{3,4}|\d+(?:\.\d+)?\s*[mk]b(?:ps|\/s)?|\b(?:low|med|medium|high|hq|lq|mq|sd|hd|fhd|uhd|4k|source|orig|original|remux|copy|akuma)\b)/i;

/** The ladder an input belongs to: its folder and content name, or null when it is not a rendition. */
export function ladderKey(input) {
  const name = isUrl(input) ? decodeURIComponent(new URL(input).pathname.split('/').pop() ?? '') : path.basename(input);
  const dir = isUrl(input) ? new URL(input).pathname.replace(/[^/]*$/, '') : path.dirname(path.resolve(input));
  if (!RENDITION.test(name.replace(/\.\w+$/, ''))) return null;
  return `${dir}|${contentStem(name)}`;
}

/**
 * SHA-256 of the index (the moov box) and of each byte range of frame data the audit read,
 * so that two reads of the same file, from two nodes or an hour apart, can be compared.
 */
export async function digests(doc, facts) {
  const { createHash } = await import('node:crypto');
  const sha = (u8) => createHash('sha256').update(u8).digest('hex');
  const out = {};
  if (facts.index) out.index = sha(await doc.source.read(facts.index.offset, facts.index.size));
  const ranges = facts.payload?.ranges ?? [];
  if (ranges.length) out.ranges = [];
  for (const [from, to] of ranges) out.ranges.push({ from, to, sha256: sha(await doc.source.read(from, to - from)) });
  return out;
}

function summaryLine(checks) {
  const t = tally(checks);
  return `${t.fail} failed (${t.critical} critical), ${t.warn} warnings, ${t.pass} passed`;
}

export function toReport(out, o) {
  return buildReport(out, { expect: o.expect, version: readVersion() });
}

function readVersion() {
  try {
    return JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  } catch {
    return null;
  }
}

/**
 * How the HLS audit reaches playlists and segments: file: URLs from disk, anything else over
 * HTTP with the --header values. A segment's size comes from a HEAD request, or from a one-byte
 * range request when the server answers HEAD without a length.
 */
function hlsIo(o) {
  const headers = o.headers ?? {};
  const local = (url) => url.startsWith('file:');
  const get = async (url, init = {}) => {
    const res = await fetch(url, { ...init, headers: { ...headers, ...(init.headers ?? {}) }, redirect: 'follow', signal: AbortSignal.timeout(30000) });
    if (!res.ok && res.status !== 206) {
      res.body?.cancel().catch(() => {});
      throw new Error(`HTTP ${res.status}`);
    }
    return res;
  };
  return {
    async text(url) {
      return local(url) ? fs.readFileSync(fileURLToPath(url), 'utf8') : (await get(url)).text();
    },
    async size(url) {
      if (local(url)) return fs.statSync(fileURLToPath(url)).size;
      const head = await get(url, { method: 'HEAD' }).catch(() => null);
      const n = Number(head?.headers.get('content-length'));
      if (head && n > 0) return n;
      const r = await get(url, { headers: { Range: 'bytes=0-0' } });
      r.body?.cancel().catch(() => {});
      const total = /\/(\d+)$/.exec(r.headers.get('content-range') ?? '');
      if (total) return Number(total[1]);
      const len = Number(r.headers.get('content-length'));
      if (r.status === 200 && len > 0) return len;
      throw new Error('the server gave no size');
    },
    async bytes(url, range) {
      if (local(url)) {
        const all = fs.readFileSync(fileURLToPath(url));
        return new Uint8Array(range ? all.subarray(range.offset, range.offset + range.length) : all);
      }
      const r = await get(url, range ? { headers: { Range: `bytes=${range.offset}-${range.offset + range.length - 1}` } } : {});
      return new Uint8Array(await r.arrayBuffer());
    },
  };
}

/** A URI for SARIF: the URL itself, or a file: URL of the path given. */
const sarifUri = (input) => (isUrl(input) ? input : pathToFileURL(path.resolve(input)).href);

/** SARIF 2.1.0, with file: URLs for paths and the URL itself for URL inputs. */
export function toSarif(report) {
  return sarifOf(report, { uriFor: sarifUri });
}

/** Write a report to a file, or to standard output; resolves once the bytes are handed to the OS. */
function write(target, text) {
  const body = text.endsWith('\n') ? text : `${text}\n`;
  if (target !== '-') {
    fs.writeFileSync(target, body);
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => process.stdout.write(body, (e) => (e ? reject(e) : resolve())));
}

export async function main(argv) {
  let o;
  try {
    o = parseArgs(argv);
  } catch (e) {
    process.stderr.write(`${e.message}\n${HELP}`);
    return 64;
  }
  if (o.help) {
    await write('-', HELP);
    return 0;
  }
  if (o.rules) {
    await write('-', allRules().map((r) => `${r.id.padEnd(22)} ${r.scope.padEnd(6)} ${r.severity.padEnd(8)} ${r.category.padEnd(9)} ${r.title}  [${SPECS[r.spec]?.name ?? r.spec}${r.clause ? `, ${r.clause}` : ''}]`).join('\n'));
    return 0;
  }
  if (!o.inputs.length) {
    process.stderr.write(HELP);
    return 64;
  }
  const log = o.quiet ? () => {} : (s) => process.stderr.write(`${s}\n`);
  const out = await auditInputs(o, log);
  const report = toReport(out, o);
  const named = [...out.results.map((r) => r.file), ...out.playlists.map((p) => p.file)];
  const title = `Vidscope audit of ${named.length === 1 ? named[0] : `${named.length} inputs`}`;
  if (o.json) await write(o.json, JSON.stringify(report, null, 2));
  if (o.md) await write(o.md, auditMarkdown(out.results, out.ladders, { title, playlists: out.playlists }));
  if (o.sarif) await write(o.sarif, JSON.stringify(toSarif(report), null, 2));
  if (!o.quiet && !o.md && !o.json && !o.sarif) await write('-', auditMarkdown(out.results, out.ladders, { title, playlists: out.playlists }));
  const t = report.summary;
  if (out.ffmpegMissing) return 70;
  if (t.errors) return 3;
  return t.critical ? 2 : t.warning ? 1 : 0;
}

if (process.argv[1] && fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  }, (e) => {
    process.stderr.write(`${e.stack ?? e}\n`);
    process.exitCode = 70;
  });
}
