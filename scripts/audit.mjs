// `vidscope audit`: check files or URLs against the audit rules, alone and as ladders.
//
// Files are read from disk; URLs are read with HTTP range requests, only the bytes the rules
// need (the index in full, a budget of frame data). With ffmpeg installed, --measure adds
// loudness and, given --source, fidelity to the source.

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { openDocument } from '../web/formats/index.js';
import { HttpSource } from '../web/core/source.js';
import { NodeFileSource } from './node-source.mjs';
import { auditFile, auditLadder, auditMarkdown, tally, allRules, DEFAULT_EXPECT, SPECS } from '../web/core/audit.js';
import { contentStem } from '../web/core/compare.js';

const run = promisify(execFile);

export const HELP = `vidscope audit - check files against streaming standards

Usage
  vidscope audit [options] <file-or-url>...

  Files that are versions of one content (movie-1080p.mp4, movie-720p.mp4, ...) are audited
  together as a ladder: aligned key frames, segment lengths, bitrate steps, one audio.

Options
  --json <file|->        write the JSON report (schema: docs/audit-report.schema.json)
  --md <file|->          write the Markdown report
  --sarif <file>         write a SARIF 2.1.0 log (for code-scanning style dashboards)
  --expect <k=v,...>     what the service intends, e.g. gop=5,fpsMax=60,peakRatio=2,
                         colour=1/1/1,audio.codec="AAC LC",audio.sampleRate=44100,
                         audio.channelsMax=2,loudness=-16,loudnessTolerance=1,truePeak=-1,
                         segments=5/10
  --expect-file <json>   the same, from a JSON file
  --ladder               audit every input as one ladder (default: group by name)
  --no-ladder            never group
  --header "K: V"        HTTP header for URL inputs (repeatable)
  --budget <MB>          frame data to read per file (default: 32 for URLs, all for files)
  --measure              run ffmpeg: loudness (ebur128) and, with --source, PSNR/SSIM
  --source <file|url>    the source the inputs were converted from, for --measure
  --rules                list the rules and exit
  --quiet                no summary on stdout
  -h, --help             this help

Exit code: 2 when any check is CRITICAL, 1 when any is a WARNING, else 0.
`;

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
      case '--expect': Object.assign(o.expect, parseExpect(val())); break;
      case '--expect-file': Object.assign(o.expect, JSON.parse(fs.readFileSync(val(), 'utf8'))); break;
      case '--ladder': o.ladder = true; break;
      case '--no-ladder': o.ladder = false; break;
      case '--header': {
        const h = val();
        const k = h.indexOf(':');
        if (k < 0) throw new Error(`--header wants "Name: value", got ${h}`);
        o.headers[h.slice(0, k).trim()] = h.slice(k + 1).trim();
        break;
      }
      case '--budget': o.budget = Number(val()) * 1048576; break;
      case '--measure': o.measure = true; break;
      case '--source': o.source = val(); break;
      case '--rules': o.rules = true; break;
      case '--quiet': o.quiet = true; break;
      default:
        if (a.startsWith('-')) throw new Error(`unknown option ${a}`);
        o.inputs.push(a);
    }
  }
  return o;
}

/** "gop=5,colour=1/1/1,audio.codec=AAC LC" -> an expectation object. */
export function parseExpect(text) {
  const ex = {};
  for (const part of text.split(/,(?=[a-zA-Z.]+=)/)) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    let value = part.slice(eq + 1).trim().replace(/^"|"$/g, '');
    if (key === 'colour') {
      const [p, t, m] = value.split('/').map(Number);
      ex.colour = { primaries: p, transfer: t, matrix: m };
      continue;
    }
    if (key === 'segments') {
      ex.segments = value.split('/').map(Number);
      continue;
    }
    if (key === 'loudness') {
      ex.loudness = { ...(ex.loudness ?? {}), integrated: Number(value) };
      continue;
    }
    if (key === 'loudnessTolerance') {
      ex.loudness = { ...(ex.loudness ?? {}), tolerance: Number(value) };
      continue;
    }
    if (key === 'truePeak') {
      ex.loudness = { ...(ex.loudness ?? {}), truePeakMax: Number(value) };
      continue;
    }
    if (/^-?\d+(\.\d+)?$/.test(value)) value = Number(value);
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

/** Integrated loudness and true peak with ffmpeg's ebur128 filter. */
async function measureLoudness(input, headers) {
  const args = ['-v', 'info', '-nostdin'];
  if (isUrl(input) && Object.keys(headers).length) args.push('-headers', Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join(''));
  args.push('-i', input, '-vn', '-af', 'ebur128=peak=true', '-f', 'null', '-');
  const { stderr } = await run('ffmpeg', args, { maxBuffer: 64 << 20 }).catch((e) => ({ stderr: e.stderr ?? '' }));
  const tail = stderr.slice(stderr.lastIndexOf('Integrated loudness'));
  const i = /I:\s*(-?[\d.]+) LUFS/.exec(tail);
  const tp = /Peak:\s*(-?[\d.]+) dBFS/.exec(tail);
  if (!i) return null;
  return { integrated: Number(i[1]), truePeak: tp ? Number(tp[1]) : undefined };
}

/** PSNR and SSIM of the luma plane against the source scaled to the input's size. */
async function measureQuality(input, source, headers, width, height) {
  const hdr = isUrl(input) && Object.keys(headers).length ? ['-headers', Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join('')] : [];
  const out = {};
  for (const [filter, re, key] of [['psnr', /average:([\d.]+)/, 'psnr'], ['ssim', /All:([\d.]+)/, 'ssim']]) {
    const args = ['-v', 'info', '-nostdin', ...hdr, '-i', input, '-i', source, '-filter_complex', `[1:v]scale=${width}:${height}:flags=bicubic[ref];[0:v][ref]${filter}`, '-f', 'null', '-'];
    const { stderr } = await run('ffmpeg', args, { maxBuffer: 64 << 20 }).catch((e) => ({ stderr: e.stderr ?? '' }));
    const m = re.exec(stderr);
    if (m) out[key] = Number(m[1]);
  }
  return Object.keys(out).length ? out : null;
}

export async function auditInputs(o, log = () => {}) {
  const results = [];
  for (const input of o.inputs) {
    const src = await openInput(input, o);
    const doc = await openDocument(src);
    const budget = o.budget ?? (isUrl(input) ? 32 * 1048576 : 0);
    const measured = {};
    const t0 = Date.now();
    const res = await auditFile(doc, o.expect, { payloadBudget: budget });
    if (o.measure) {
      const l = await measureLoudness(input, o.headers);
      if (l) measured.loudness = l;
      if (o.source && res.facts.video) {
        const q = await measureQuality(input, o.source, o.headers, res.facts.video.width, res.facts.video.height);
        if (q) measured.quality = q;
      }
      if (Object.keys(measured).length) Object.assign(res, await auditFile(doc, o.expect, { payloadBudget: budget, measured }));
    }
    res.input = input;
    res.ms = Date.now() - t0;
    res.facts.bytesRead = src.stats?.bytes ?? doc.source?.stats?.bytes ?? null;
    res.facts.requests = src.stats?.requests ?? null;
    results.push(res);
    log(`${input}: ${summaryLine(res.checks)}${res.facts.bytesRead ? `, ${(res.facts.bytesRead / 1048576).toFixed(1)} MB read` : ''} in ${res.ms} ms`);
    if (src.close) await src.close();
  }
  // Ladders: every input as one, or grouped by content name.
  const ladders = [];
  if (results.length >= 2 && o.ladder !== false) {
    const groups = new Map();
    for (const r of results) {
      const key = o.ladder ? 'all' : contentStem(r.file);
      groups.get(key)?.push(r) ?? groups.set(key, [r]);
    }
    for (const [key, group] of groups) if (group.length >= 2) ladders.push({ key, ...auditLadder(group, o.expect) });
  }
  return { results, ladders };
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
    expect: { ...DEFAULT_EXPECT, ...o.expect },
    summary: tally(all),
    files: results.map((r) => ({ input: r.input, file: r.file, ms: r.ms, facts: r.facts, checks: r.checks })),
    ladders: ladders.map((l) => ({ files: l.files, checks: l.checks })),
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

/** SARIF 2.1.0: one result per warning or failure, the file as the artifact, the byte offset as the region. */
export function toSarif(report) {
  const rules = allRules();
  const results = [];
  const emit = (fileName, c) => {
    if (!c.severity) return;
    results.push({
      ruleId: c.id,
      level: c.severity === 'CRITICAL' ? 'error' : c.severity === 'WARNING' ? 'warning' : 'note',
      message: { text: `${c.title}. ${c.text}${c.remedy ? ` Fix: ${c.remedy.fix}` : ''}` },
      locations: [{ physicalLocation: { artifactLocation: { uri: fileName }, region: c.offset !== undefined ? { byteOffset: c.offset } : undefined } }],
      properties: { value: c.value, expected: c.expected, spec: SPECS[c.spec]?.name, clause: c.clause },
    });
  };
  for (const f of report.files) for (const c of f.checks) emit(f.file, c);
  for (const l of report.ladders) for (const c of l.checks) emit(l.files.join(' + '), c);
  return {
    version: '2.1.0',
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    runs: [{
      tool: { driver: { name: 'vidscope audit', version: report.tool.version ?? '0', rules: rules.map((r) => ({ id: r.id, name: r.title, shortDescription: { text: r.title }, helpUri: SPECS[r.spec]?.url, properties: { category: r.category, severity: r.severity, clause: r.clause } })) } },
      results,
    }],
  };
}

function write(target, text) {
  if (target === '-') process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
  else fs.writeFileSync(target, text);
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
    process.stdout.write(HELP);
    return 0;
  }
  if (o.rules) {
    for (const r of allRules()) process.stdout.write(`${r.id.padEnd(22)} ${r.scope.padEnd(6)} ${r.severity.padEnd(8)} ${r.category.padEnd(9)} ${r.title}  [${SPECS[r.spec]?.name ?? r.spec}${r.clause ? `, ${r.clause}` : ''}]\n`);
    return 0;
  }
  if (!o.inputs.length) {
    process.stderr.write(HELP);
    return 64;
  }
  const log = o.quiet ? () => {} : (s) => process.stderr.write(`${s}\n`);
  const out = await auditInputs(o, log);
  const report = toReport(out, o);
  if (o.json) write(o.json, JSON.stringify(report, null, 2));
  if (o.md) write(o.md, auditMarkdown(out.results, out.ladders[0] ?? null, { title: `Vidscope audit of ${out.results.length === 1 ? out.results[0].file : `${out.results.length} files`}` }));
  if (o.sarif) write(o.sarif, JSON.stringify(toSarif(report), null, 2));
  if (!o.quiet && !o.md && !o.json) process.stdout.write(auditMarkdown(out.results, out.ladders[0] ?? null));
  const t = report.summary;
  return t.critical ? 2 : t.warning ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (e) => {
    process.stderr.write(`${e.stack ?? e}\n`);
    process.exit(70);
  });
}
