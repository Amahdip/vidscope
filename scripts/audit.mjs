// `vidscope audit`: check files or URLs against the audit rules, alone and as ladders.
//
// Files are read from disk; URLs are read with HTTP range requests, only the bytes the rules
// need (the index in full, a budget of frame data). With ffmpeg installed, --measure adds
// loudness and, given --source, fidelity to the source.

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openDocument } from '../web/formats/index.js';
import { HttpSource } from '../web/core/source.js';
import { NodeFileSource } from './node-source.mjs';
import { auditFile, auditLadder, auditMarkdown, tally, allRules, DEFAULT_EXPECT, SPECS } from '../web/core/audit.js';
import { contentStem } from '../web/core/compare.js';

const run = promisify(execFile);

export const HELP = `vidscope audit - check files against streaming standards

Usage
  vidscope audit [options] <file-or-url>...

  Files that are renditions of one content (movie-1080p.mp4, movie-720p.mp4, ...) are audited
  together as a ladder: aligned key frames, segment lengths, bitrate steps, one audio.

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
  --budget <MB>          frame data to read per file (default: 32 for URLs, all for files)
  --measure              run ffmpeg: loudness (ebur128) and, with --source, PSNR/SSIM
  --source <file|url>    the source the inputs were converted from, for --measure
  --rules                list the rules and exit
  --quiet                no summary on stderr
  -h, --help             this help

Exit code: 2 when any check is CRITICAL, 1 when any is a WARNING, 3 when an input could not
be audited (the other inputs still are), 64 for a usage error, 70 when ffmpeg was asked for
but could not run.
`;

/** Merge b into a: nested plain objects merge, everything else is replaced. */
export function mergeExpect(a, b) {
  for (const [k, v] of Object.entries(b ?? {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && a[k] && typeof a[k] === 'object' && !Array.isArray(a[k])) mergeExpect(a[k], v);
    else a[k] = v;
  }
  return a;
}

function parseArgs(argv) {
  const o = { inputs: [], headers: {}, json: null, md: null, sarif: null, expect: {}, ladder: null, budget: null, measure: false, source: null, rules: false, quiet: false, help: false };
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
      case '--expect': mergeExpect(o.expect, parseExpect(val())); break;
      case '--expect-file': mergeExpect(o.expect, JSON.parse(fs.readFileSync(val(), 'utf8'))); break;
      case '--ladder': o.ladder = true; break;
      case '--no-ladder': o.ladder = false; break;
      case '--header': {
        const h = val();
        const k = h.indexOf(':');
        if (k <= 0) throw new Error(`--header wants "Name: value", got ${h}`);
        o.headers[h.slice(0, k).trim()] = h.slice(k + 1).trim();
        break;
      }
      case '--budget': {
        const mb = Number(val());
        if (!Number.isFinite(mb) || mb < 0) throw new Error('--budget wants a number of megabytes');
        o.budget = mb * 1048576;
        break;
      }
      case '--measure': o.measure = true; break;
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
  let ffmpegMissing = false;
  for (const input of o.inputs) {
    const t0 = Date.now();
    let src = null;
    try {
      src = await openInput(input, o);
      const doc = await openDocument(src);
      const budget = o.budget ?? (isUrl(input) ? 32 * 1048576 : 0);
      const measured = {};
      const skipped = [];
      let res = await auditFile(doc, o.expect, { payloadBudget: budget });
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
        res.checks.push(...skipped);
        for (const s of skipped) log(`${input}: ${s.title.toLowerCase()}: ${s.text}`);
      }
      res.input = input;
      res.ms = Date.now() - t0;
      res.facts.bytesRead = src.stats?.bytes ?? doc.source?.stats?.bytes ?? null;
      res.facts.requests = src.stats?.requests ?? null;
      results.push(res);
      log(`${input}: ${summaryLine(res.checks)}${res.facts.bytesRead ? `, ${(res.facts.bytesRead / 1048576).toFixed(1)} MB read` : ''} in ${res.ms} ms`);
    } catch (e) {
      const message = String(e?.message ?? e);
      results.push({ input, file: isUrl(input) ? input.split('/').pop() : path.basename(input), error: message, ms: Date.now() - t0, facts: { name: path.basename(input) }, checks: [], item: null });
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
  return { results, ladders, ffmpegMissing };
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

function summaryLine(checks) {
  const t = tally(checks);
  return `${t.fail} failed (${t.critical} critical), ${t.warn} warnings, ${t.pass} passed`;
}

export function toReport({ results, ladders }, o) {
  const all = [...results.flatMap((r) => r.checks), ...ladders.flatMap((l) => l.checks)];
  return {
    tool: { name: 'vidscope', command: 'audit', version: readVersion() },
    generated: new Date().toISOString(),
    expect: mergeExpect(structuredClone(DEFAULT_EXPECT), o.expect),
    summary: { ...tally(all), errors: results.filter((r) => r.error).length },
    files: results.map((r) => ({ input: r.input, file: r.file, ms: r.ms, ...(r.error ? { error: r.error } : {}), facts: r.facts, checks: r.checks })),
    ladders: ladders.map((l) => ({ files: l.files, inputs: l.inputs, checks: l.checks })),
    specs: SPECS,
  };
}

function readVersion() {
  try {
    return JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  } catch {
    return null;
  }
}

/** A URI for SARIF: the URL itself, or a file: URL of the path given. */
const sarifUri = (input) => (isUrl(input) ? input : pathToFileURL(path.resolve(input)).href);

/** SARIF 2.1.0: one result per warning or failure, the input as the artifact, the byte offset as the region. */
export function toSarif(report) {
  const rules = allRules();
  const results = [];
  const emit = (inputs, c) => {
    if (!c.severity) return;
    results.push({
      ruleId: c.id,
      level: c.severity === 'CRITICAL' ? 'error' : c.severity === 'WARNING' ? 'warning' : 'note',
      message: { text: `${c.title}. ${c.text}${c.remedy ? ` Fix: ${c.remedy.fix}` : ''}` },
      locations: inputs.map((input) => ({ physicalLocation: { artifactLocation: { uri: sarifUri(input) }, ...(inputs.length === 1 && c.offset !== undefined ? { region: { byteOffset: c.offset } } : {}) } })),
      properties: { value: c.value, expected: c.expected, spec: SPECS[c.spec]?.name, clause: c.clause },
    });
  };
  for (const f of report.files) for (const c of f.checks) emit([f.input ?? f.file], c);
  for (const l of report.ladders) for (const c of l.checks) emit(l.inputs ?? l.files, c);
  return {
    version: '2.1.0',
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    runs: [{
      tool: { driver: { name: 'vidscope audit', version: report.tool.version ?? '0', rules: rules.map((r) => ({ id: r.id, name: r.title, shortDescription: { text: r.title }, helpUri: SPECS[r.spec]?.url, properties: { category: r.category, severity: r.severity, clause: r.clause } })) } },
      results,
    }],
  };
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
  const title = `Vidscope audit of ${out.results.length === 1 ? out.results[0].file : `${out.results.length} files`}`;
  if (o.json) await write(o.json, JSON.stringify(report, null, 2));
  if (o.md) await write(o.md, auditMarkdown(out.results, out.ladders, { title }));
  if (o.sarif) await write(o.sarif, JSON.stringify(toSarif(report), null, 2));
  if (!o.quiet && !o.md && !o.json && !o.sarif) await write('-', auditMarkdown(out.results, out.ladders, { title }));
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
