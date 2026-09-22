// The FFmpeg command catalogue: shell quoting, the mapping from Vidscope's tracks to FFmpeg's
// streams and timeline, and every command run for real against the samples (ffprobe as is,
// ffmpeg with -t 1, ffplay through ffmpeg and, when possible, through ffplay itself).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { open, sample, haveSample, haveFfprobe, SAMPLES } from './helpers.mjs';
import {
  COMMANDS, GROUPS, TERMS, buildContext, renderEntry, commandText, contextSummary, commandById,
  shq, shellPath, filePath, filterValue, streamMap, fileStart, framePts, fmtClock,
} from '../web/core/commands.js';

// ------------------------------------------------------------------ helpers

function have(bin) {
  try {
    execFileSync('sh', ['-c', `command -v ${bin}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
const FFMPEG = have('ffmpeg') && haveFfprobe();
const FFPLAY = FFMPEG && have('ffplay');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'vidscope-commands-'));
process.on('exit', () => fs.rmSync(TMP, { recursive: true, force: true }));
let dirs = 0;
const freshDir = (label) => {
  const d = path.join(TMP, `${++dirs}-${label.replace(/[^\w.-]+/g, '_')}`);
  fs.mkdirSync(d);
  return d;
};

/** Run a shell command line; resolves { code, stdout, stderr } (stdin closed, so ffmpeg never waits for a key). */
function sh(cmd, { cwd = TMP, env = {}, timeout = 120000, shell = 'sh' } = {}) {
  return new Promise((resolve) => {
    const p = spawn(shell, ['-c', cmd], { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => { stdout += d; });
    p.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => p.kill('SIGKILL'), timeout);
    p.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code: signal ? `killed (${signal})` : code, stdout, stderr });
    });
  });
}

/** Run a program without a shell; resolves { code, stdout, stderr }. */
function exec(bin, args, { cwd = TMP } = {}) {
  return new Promise((resolve) => {
    const p = spawn(bin, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [];
    let stderr = '';
    p.stdout.on('data', (d) => out.push(d));
    p.stderr.on('data', (d) => { stderr += d; });
    p.on('close', (code) => resolve({ code, stdout: Buffer.concat(out).toString(), stderr }));
  });
}

/** Map over items with at most n running at once. */
async function pool(items, n, fn) {
  const out = [];
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const k = next++;
      out[k] = await fn(items[k], k);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

/** What this FFmpeg build has: filters, encoders, configure flags. */
let buildCache = null;
function build() {
  if (buildCache) return buildCache;
  const filters = new Set();
  const encoders = new Set();
  for (const l of execFileSync('ffmpeg', ['-hide_banner', '-filters']).toString().split('\n')) {
    const m = /^ [T.][S.] (\S+)/.exec(l);
    if (m) filters.add(m[1]);
  }
  for (const l of execFileSync('ffmpeg', ['-hide_banner', '-encoders']).toString().split('\n')) {
    const m = /^ [VASD][F.][S.][X.][B.][D.] (\S+)/.exec(l);
    if (m) encoders.add(m[1]);
  }
  const conf = execFileSync('ffmpeg', ['-hide_banner', '-buildconf']).toString();
  buildCache = { filters, encoders, conf };
  return buildCache;
}

/** Why an entry cannot run with this FFmpeg build, or null. */
function missing(needs) {
  const b = build();
  for (const n of needs) {
    if (n.filter && !b.filters.has(n.filter)) return `needs the ${n.filter} filter, which this FFmpeg lacks (configure ${n.build ?? 'it'})`;
    if (n.encoder && !b.encoders.has(n.encoder)) return `needs the ${n.encoder} encoder, which this FFmpeg lacks`;
    if (n.filter === 'drawtext' && !b.conf.includes('--enable-libfontconfig')) return 'drawtext needs fontconfig to find its default font (--enable-libfontconfig)';
  }
  return null;
}

// Opened documents, shared by the tests (a promise each, so concurrent tests open a file once).
const docs = new Map();
function docFor(name) {
  if (!docs.has(name)) {
    docs.set(name, (async () => {
      const d = await open(name);
      if (d.loadSamples) await d.loadSamples();
      return d;
    })());
  }
  return docs.get(name);
}

/**
 * A non-key frame about a third of the way into a track (or the first frame). `early` picks one in
 * the first half second instead, for commands that run with -t 1 and seek after -i.
 */
function pickFrame(t, { early = false } = {}) {
  const s = t.samples;
  const from = early ? Math.min(3, s.count - 1) : Math.floor(s.count / 3);
  for (let i = from; i < s.count; i++) if (s.sizes[i] > 0 && (!s.key || !s.key[i])) return i;
  return 0;
}

/** The selection the app would hold after clicking a frame of this track. */
async function selectFrame(d, t, i) {
  const off = t.samples.offsets[i];
  const node = d.nodeAt(off);
  return { node, offset: off, detail: await d.detailAt(off, node) };
}

/** A context for a sample, as the app builds it for a file served from `dir`, with a frame of `kind` selected. */
async function contextFor(name, { encoder = 'x264', kind = 'video', frame, dir = SAMPLES, early = false } = {}) {
  const d = await docFor(name);
  const t = d.tracks.find((x) => x.kind === kind && x.samples?.count) ?? d.tracks.find((x) => x.samples?.count);
  const sel = t ? await selectFrame(d, t, frame ?? pickFrame(t, { early })) : null;
  return buildContext({ doc: d, entry: { kind: 'server', name, dir }, sel, encoder });
}

/** Token list -> words: glued pieces joined, with the first piece's role and ff. */
function words(tokens) {
  const out = [];
  for (const x of tokens) {
    if (x.glue && out.length) out[out.length - 1].t += x.t;
    else out.push({ t: x.t, role: x.role, ff: x.ff });
  }
  return out;
}

/** An ffmpeg line with -t 1 before every input, so each run reads at most one second. */
function oneSecond(tokens) {
  return tokens.flatMap((x) => (x.t === '-i' ? [{ t: '-t' }, { t: '1' }, x] : [x]));
}

/** Remove the quotes shq added (test names only need the simple case). */
function unq(s) {
  return s.startsWith("'") && s.endsWith("'") ? s.slice(1, -1) : s;
}

/** The option names a tool accepts, from its -h full (per-stream suffixes like :v are stripped before lookup). */
const optionCache = {};
function options(tool) {
  if (!optionCache[tool]) {
    const set = new Set();
    for (const l of execFileSync(tool, ['-hide_banner', '-h', 'full'], { maxBuffer: 64 << 20 }).toString().split('\n')) {
      const m = /^\s*(-[\w-]+)(?:\[:<\w+>\])?[\s<]/.exec(`${l} `);
      if (m) set.add(m[1]);
    }
    optionCache[tool] = set;
  }
  return optionCache[tool];
}

/** The FFmpeg-tool segments of a line (between |, && and >), each as its words. */
function segments(tokens) {
  const segs = [[]];
  for (const w of words(tokens)) {
    if (['|', '&&', '>'].includes(w.t)) segs.push([]);
    else segs[segs.length - 1].push(w);
  }
  return segs.filter((s) => ['ffmpeg', 'ffprobe', 'ffplay'].includes(s[0]?.t));
}

// Samples each entry is run against (the first one that exists and applies is required).
const DEFAULT_SAMPLES = {
  ffprobe: ['h264-aac.mp4', 'h264-aac.mkv', 'h264-aac.ts', 'vp9-opus.webm'],
  ffmpeg: ['h264-aac.mp4', 'h264-aac.mkv'],
  ffplay: ['h264-aac.mp4'],
};
const SAMPLES_FOR = {
  'probe-chapters': ['h264-aac-subs-chapters.mp4', 'h264-aac.mkv'],
  'probe-programs': ['mpegts-2programs-dvb.ts', 'h264-aac.ts'],
  'probe-hdr': ['hevc-10bit-hdr.mp4', 'matroska-hevc-hdr.mkv', 'h264-aac.mp4'],
  'probe-bitrate': ['h264-aac.mp4', 'h264-aac.ts', 'aac.m4a'],
  'fix-remux': ['h264-aac.mp4', 'h264-aac.mkv', 'h264-aac.ts', 'h264-aac.flv', 'mpeg4-mp3.avi', 'matroska-vp8-vorbis.webm', 'pcm.wav', 'aac.m4a'],
  'fix-faststart': ['h264-aac.mp4', 'h264-aac-subs-chapters.mp4', 'h264-aac.mov', 'h264-aac.mkv'],
  'fix-frame': ['h264-aac.mp4', 'h264-aac.ts'],
  'fix-audio': ['h264-aac.mp4', 'vp9-opus.webm', 'h264-ac3.mp4', 'h264-eac3.mp4', 'matroska-flac-ass.mkv', 'matroska-vp8-vorbis.webm', 'mpeg4-mp3.avi', 'pcm.wav'],
  'fix-subs': ['h264-aac.mkv', 'h264-aac-subs-chapters.mp4', 'matroska-flac-ass.mkv'],
  'fix-hvc1': ['hevc-aac.mp4', 'matroska-hevc-hdr.mkv'],
  'fix-annexb': ['h264-aac.mp4', 'hevc-aac.mp4', 'av1-opus.mp4', 'vp9-opus.webm', 'h264-aac.ts', 'mpegts-mpeg2-mp2-cbr.ts', 'mpeg4-mp3.avi'],
  'fix-strip': ['h264-aac.mp4', 'h264-aac.mkv', 'h264-aac.ts'],
  'fix-rotate': ['h264-aac.mp4', 'h264-aac.mkv'],
  'fix-concat': ['h264-aac.mp4', 'h264-aac.ts'],
  'fix-hls': ['h264-aac.mp4', 'h264-aac.ts', 'h264-aac.mkv'],
  'fix-dash': ['h264-aac.mp4', 'h264-aac.mkv'],
  'fix-loudnorm': ['h264-aac.mp4', 'aac.m4a', 'vp9-opus.webm'],
  'fix-cut-copy': ['h264-aac.mp4', 'h264-aac.ts', 'h264-aac.mkv'],
  'measure-ebur128': ['h264-aac.mp4', 'pcm.wav'],
  'measure-silence': ['h264-aac.mp4', 'pcm.wav'],
  'measure-signalstats': ['h264-aac.mp4'],
  'play-track': ['h264-aac.mp4', 'matroska-mpeg4-mp3-ac3.mkv'],
  'play-live': ['h264-aac.mp4'],
};
// Encoding commands run with both encoders.
const ENCODES = new Set(['fix-gop', 'fix-forcekf', 'fix-crf', 'fix-capped', 'fix-2pass', 'fix-cbr', 'fix-cut-exact']);

// ------------------------------------------------------------------ the catalogue itself

test('commands: catalogue entries are complete and consistent', () => {
  const ids = new Set();
  const groups = new Set(GROUPS.map((g) => g.id));
  for (const e of COMMANDS) {
    assert.ok(!ids.has(e.id), `duplicate id ${e.id}`);
    ids.add(e.id);
    assert.ok(groups.has(e.group), `${e.id}: group`);
    assert.ok(typeof e.title === 'string' && e.title.length > 3, `${e.id}: title`);
    for (const k of ['purpose', 'when']) assert.ok(typeof e[k] === 'string' && e[k].length > 20, `${e.id}: ${k}`);
    assert.ok(['ffprobe', 'ffplay', 'ffmpeg'].includes(e.tool), `${e.id}: tool`);
    assert.ok(e.view && ['tracks', 'frame', 'node', 'structure', 'insights'].includes(e.view.to) && e.view.label, `${e.id}: view`);
    if (e.uses) assert.ok(commandById(e.uses), `${e.id}: uses ${e.uses}`);
  }
  // Every group has commands; Beginner mode leads with a handful of essentials.
  for (const g of GROUPS) assert.ok(COMMANDS.some((e) => e.group === g.id), `group ${g.id} is empty`);
  const essentials = COMMANDS.filter((e) => e.essential).length;
  assert.ok(essentials >= 4 && essentials <= 10, `${essentials} essential commands`);
  // The best-known commands the catalogue promises.
  for (const id of ['probe-packets', 'probe-keyframes', 'probe-count', 'probe-gop', 'probe-frametypes', 'probe-bitrate', 'probe-hdr', 'probe-chapters',
    'probe-programs', 'probe-hexdump', 'probe-error', 'play-frametype', 'play-mvs', 'play-iframes', 'play-showinfo', 'play-section', 'play-showmode',
    'play-scopes', 'play-compare', 'play-live', 'play-sync', 'fix-remux', 'fix-faststart', 'fix-gop', 'fix-crf', 'fix-capped', 'fix-2pass', 'fix-cbr',
    'fix-hls', 'fix-dash', 'fix-cut-copy', 'fix-cut-exact', 'fix-frame', 'fix-thumbs', 'fix-loudnorm', 'fix-rotate', 'fix-subs', 'fix-strip',
    'fix-concat', 'measure-quality', 'measure-vmaf', 'measure-ebur128', 'measure-idet', 'measure-black', 'measure-silence', 'measure-crop']) {
    assert.ok(ids.has(id), `missing ${id}`);
  }
  assert.ok(TERMS.length > 20);
});

test('commands: every token explains itself, and references resolve', { skip: !haveSample('h264-aac.mp4') && 'run npm run samples' }, async () => {
  const names = fs.readdirSync(SAMPLES).filter((n) => !n.startsWith('.'));
  for (const encoder of ['x264', 'x265']) {
    // Every sample (audio only, no tracks at all, several programs…), with and without a selection.
    const contexts = [buildContext({ encoder })];
    for (const name of names) {
      const d = await docFor(name);
      contexts.push(buildContext({ doc: d, entry: { kind: 'server', name, dir: SAMPLES }, encoder }));
      if (d.tracks.some((t) => t.samples?.count)) contexts.push(await contextFor(name, { encoder }));
    }
    for (const c of contexts) {
      for (const e of COMMANDS) {
        const r = renderEntry(e, c);
        assert.ok(r.lines.length >= 1, `${e.id}: no command`);
        for (const l of r.lines) {
          for (const x of l.tokens) assert.ok(typeof x.tip === 'string' && x.tip.length > 3, `${e.id}: token ${x.t} has no explanation`);
          assert.equal(l.text, commandText(l.tokens));
          assert.ok(!/undefined|NaN|\[object/.test(l.text + l.tokens.map((x) => x.tip).join(' ')), `${e.id}: undefined in "${l.text}"`);
        }
        const prose = [e.purpose, e.when, ...r.look, ...(e.output?.marks ?? []).flat(), e.output?.text ?? ''].join(' ');
        for (const [, id] of prose.matchAll(/\[\[([\w-]+)\]\]/g)) assert.ok(commandById(id), `${e.id}: reference to unknown command ${id}`);
        assert.ok(!/undefined|NaN/.test(prose), `${e.id}: undefined in the prose`);
        // Example outputs mark substrings that really are in the example.
        for (const [s] of e.output?.marks ?? []) assert.ok(e.output.lines.some((l) => l.includes(s)), `${e.id}: mark "${s}" not in the example`);
      }
    }
  }
});

// ------------------------------------------------------------------ shell quoting

test('commands: shq leaves safe words alone and quotes the rest', () => {
  assert.equal(shq('clip.mp4'), 'clip.mp4');
  assert.equal(shq('a/b-c_d@e%f+g,h:i=j.mp4'), 'a/b-c_d@e%f+g,h:i=j.mp4');
  assert.equal(shq('my clip.mp4'), "'my clip.mp4'");
  assert.equal(shq("it's.mp4"), "'it'\\''s.mp4'");
  assert.equal(shq(''), "''");
  assert.equal(shq('=cmd'), "'=cmd'", 'zsh expands a leading =');
  for (const s of ['$HOME', '`id`', 'a*', 'a?', '[a]', '{a,b}', '~', '!x', 'a;b', 'a|b', 'a&b', 'a>b', 'a\\b', '#x', 'a\nb']) {
    assert.ok(shq(s).startsWith("'"), `${JSON.stringify(s)} is quoted`);
  }
});

const NASTY = ['plain.mp4', 'with space.mp4', "it's.mp4", 'say "hi".mp4', '$HOME.mp4', '`id`.mp4', 'back\\slash.mp4', 'bang!.mp4',
  '*.mp4', '[1].mp4', '{a,b}.mp4', '~user.mp4', '=cmd.mp4', 'semi;colon.mp4', 'pipe|x.mp4', 'amp&x.mp4', 'tab\tx.mp4', 'new\nline.mp4',
  '-dash.mp4', 'héllo wörld.mp4', "'", '', '#hash'];

for (const shell of ['sh', 'bash', 'zsh']) {
  test(`commands: quoted words survive ${shell} unchanged`, { skip: !have(shell) && `${shell} not installed` }, () => {
    // -f: skip the user's startup files; zsh's = expansion and globbing are on by default.
    const out = execFileSync(shell, ['-c', `printf '%s\\0' ${NASTY.map(shq).join(' ')}`], { env: { ...process.env, ENV: '' } }).toString();
    assert.deepEqual(out.split('\0').slice(0, -1), NASTY);
  });
}

test('commands: file paths from the server, ~ and dropped files', () => {
  const home = filePath({ kind: 'server', name: 'my clip.mp4', dir: '~/Movies' });
  assert.equal(shellPath(home), "~/'Movies/my clip.mp4'");
  assert.equal(shellPath(filePath({ kind: 'server', name: 'clip.mp4', dir: '~/Movies' })), '~/Movies/clip.mp4');
  assert.equal(shellPath(filePath({ kind: 'server', name: 'clip.mp4', dir: '~' })), '~/clip.mp4');
  assert.equal(shellPath(filePath({ kind: 'server', name: 'a b.mp4', dir: '/data/in' })), "'/data/in/a b.mp4'");
  const dropped = filePath({ kind: 'local', name: 'clip.mp4', dir: 'local file' });
  assert.equal(dropped.known, false);
  assert.equal(shellPath(dropped), 'clip.mp4');
  assert.equal(shellPath(filePath(null, '-x.mp4')), './-x.mp4', 'a leading - would read as an option');
  assert.equal(shellPath(filePath(null, 'a:b.mp4')), './a:b.mp4', 'a colon would read as a protocol');
  // The shell expands the ~ it leaves unquoted.
  const out = execFileSync('sh', ['-c', `printf '%s' ${shellPath(home)}`]).toString();
  assert.equal(out, path.join(os.homedir(), 'Movies/my clip.mp4'));
});

test('commands: times for -ss round down, so that the frame itself is not skipped', () => {
  assert.equal(fmtClock(4.12), '00:00:04.120');
  assert.equal(fmtClock(1001 / 30000), '00:00:00.033', 'a 29.97 fps frame at 33.37 ms: 0.034 would skip it');
  assert.equal(fmtClock(3723.5), '01:02:03.500');
  assert.equal(fmtClock(-0.02), '00:00:00.000');
});

test('commands: filter graph escaping follows the FFmpeg documentation', () => {
  // The example of the "Notes on filtergraph escaping" section, second level.
  assert.equal(filterValue("this is a 'string': may contain one, or more, special characters"),
    "this is a \\\\\\'string\\\\\\'\\\\: may contain one\\, or more\\, special characters");
  assert.equal(filterValue('/Users/me/My Movies/clip.mp4'), '/Users/me/My Movies/clip.mp4');
});

test('commands: nasty file names work in movie= graphs, concat lists and plain arguments', { skip: !FFMPEG || !haveSample('h264-aac.mp4') }, async () => {
  const dir = freshDir('nasty');
  const name = "it's a \"test\" [1], x; 50% $HOME:y!.mp4";
  fs.copyFileSync(sample('h264-aac.mp4'), path.join(dir, name));
  const d = await docFor('h264-aac.mp4');
  const c = buildContext({ doc: d, entry: { kind: 'server', name, dir } });
  const run = async (id) => {
    const r = renderEntry(commandById(id), c);
    const cwd = freshDir(id);
    for (const l of r.lines) {
      const tokens = l.tool === 'ffmpeg' ? oneSecond(l.tokens) : l.tokens;
      const res = await sh(commandText(tokens), { cwd });
      assert.equal(res.code, 0, `${id}: ${commandText(tokens)}\n${res.stderr}`);
    }
  };
  await run('probe-json');
  await run('measure-signalstats');
  await run('fix-concat');
  await run('fix-remux');
  // The same through ~ when the folder is inside the home folder.
  if (dir.startsWith(os.homedir() + path.sep)) {
    const c2 = buildContext({ doc: d, entry: { kind: 'server', name, dir: `~${dir.slice(os.homedir().length)}` } });
    const r = renderEntry(commandById('measure-signalstats'), c2);
    assert.match(r.text, /\$HOME/);
    const res = await sh(r.text, { cwd: dir });
    assert.equal(res.code, 0, res.stderr);
  }
});

// ------------------------------------------------------------------ Vidscope's tracks as FFmpeg sees them

const ALL = fs.existsSync(SAMPLES) ? fs.readdirSync(SAMPLES).filter((n) => !n.startsWith('.')).sort() : [];
const LETTER = { video: 'v', audio: 'a', subtitle: 's', data: 'd', attachment: 't' };

/** ffprobe's streams and format for a sample (async, so samples are probed in parallel). */
async function probe(name) {
  const r = await exec('ffprobe', ['-v', 'quiet', '-show_streams', '-show_format', '-of', 'json', sample(name)]);
  return JSON.parse(r.stdout);
}

test('commands: stream specifiers match ffprobe’s stream order in every sample', { skip: (!haveFfprobe() || !ALL.length) && 'needs ffprobe and npm run samples' }, async () => {
  await pool(ALL, 8, async (name) => {
    const d = await docFor(name);
    const { streams } = await probe(name);
    const seen = {};
    const specs = streams.map((s) => {
      const l = LETTER[s.codec_type] ?? '?';
      seen[l] = (seen[l] ?? 0) + 1;
      return `${l}:${seen[l] - 1}`;
    });
    const map = streamMap(d);
    d.tracks.forEach((t, i) => {
      const m = map[i];
      assert.ok(m, `${name}: ${t.label} has no FFmpeg stream`);
      assert.equal(m.spec, specs[m.index], `${name}: ${t.label}`);
      if (d.format.id === 'mpegts') assert.equal(parseInt(streams[m.index].id, 16), t.pid, `${name}: ${t.label} PID`);
    });
  });
});

test('commands: file start and frame times match ffprobe', { skip: (!haveFfprobe() || !ALL.length) && 'needs ffprobe and npm run samples' }, async () => {
  await pool(ALL, 8, async (name) => {
    const d = await docFor(name);
    const info = await probe(name);
    assert.ok(Math.abs(fileStart(d) - Number(info.format.start_time ?? 0)) < 0.0015, `${name}: start ${fileStart(d)} vs ${info.format.start_time}`);
    const map = streamMap(d);
    for (const [k, t] of d.tracks.entries()) {
      if (!t.samples?.count || !map[k]) continue;
      const { stdout } = await exec('ffprobe', ['-v', 'quiet', '-select_streams', String(map[k].index), '-show_entries', 'packet=pts_time,size', '-of', 'csv=p=0', sample(name)]);
      const pk = stdout.trim().split('\n').filter(Boolean).map((l) => l.split(','));
      // FFmpeg skips zero-byte AVI chunks, discards MP4 chapter samples and trims samples outside an edit list.
      const mine = [];
      for (let i = 0; i < t.samples.count; i++) if (t.samples.sizes[i] > 0) mine.push(i);
      if (pk.length !== mine.length) continue;
      mine.forEach((i, j) => {
        if (pk[j][0] === 'N/A') return;
        assert.ok(Math.abs(framePts(d, t, i) - Number(pk[j][0])) < 0.0011, `${name}: ${t.label} frame ${i}: ${framePts(d, t, i)} vs ${pk[j][0]}`);
      });
    }
  });
});

test('commands: the context follows the selection', { skip: !haveSample('matroska-mpeg4-mp3-ac3.mkv') && 'run npm run samples' }, async () => {
  const d = await docFor('matroska-mpeg4-mp3-ac3.mkv');
  const none = buildContext({ doc: d, entry: { kind: 'server', name: d.name, dir: SAMPLES } });
  assert.equal(none.stream.spec, 'v:0', 'defaults to the first video track');
  assert.equal(none.streamFrom, 'default');
  assert.equal(none.time, null);
  // Selecting the TrackEntry of the second audio track (the Tracks tab's "show" button).
  const ac3 = d.tracks[2];
  const byNode = buildContext({ doc: d, entry: null, sel: { node: ac3.node.children[0] } });
  assert.equal(byNode.stream.spec, 'a:1');
  assert.equal(byNode.streamFrom, 'selected');
  assert.equal(byNode.audio.spec, 'a:1');
  // Clicking a frame of it.
  const byFrame = buildContext({ doc: d, sel: await selectFrame(d, ac3, 10) });
  assert.equal(byFrame.stream.spec, 'a:1');
  assert.equal(byFrame.streamFrom, 'frame');
  assert.equal(byFrame.frame.i, 10);
  assert.match(byFrame.time, /^00:00:0\d\.\d{3}$/);
  // Dropped files only have a name; unknown values become placeholders.
  assert.equal(byNode.path.known, false);
  const bare = buildContext({});
  const gop = renderEntry(commandById('fix-gop'), bare).lines[0].tokens.filter((x) => x.ph).map((x) => x.t);
  assert.deepEqual(gop, ['GOP', 'GOP']);
  const frame = renderEntry(commandById('fix-frame'), none).lines[0].tokens.find((x) => x.role === 'time');
  assert.equal(frame.t, 'TIME');
  assert.ok(frame.ph);
  const items = contextSummary(none);
  assert.ok(items.some((x) => x.label === 'time' && x.missing));
  assert.ok(items.some((x) => x.label === 'stream' && x.value.startsWith('v:0 = ')));
});

// Seeking with -ss to the time Vidscope computed must give exactly the selected frame: every
// container family, MPEG-TS (seeking after -i) included. Not AVI with H.264: AVI stores no
// presentation times, so with B-frames the frame shown at a time is FFmpeg's guess.
const SEEK_SAMPLES = ['h264-aac.mp4', 'h264-aac-dash-sidx.mp4', 'h264-aac.mov', 'hevc-aac.mp4', 'av1-opus.mp4', 'h264-aac.mkv', 'matroska-live.webm',
  'vp9-opus.webm', 'h264-aac.ts', 'hevc-ac3.ts', 'mpegts-h264-aac.m2ts', 'mpegts-2programs-dvb.ts', 'mpegts-mpeg2-mp2-cbr.ts', 'h264-aac.flv',
  'flv-h264-mp3-keyframes.flv', 'mpeg4-mp3.avi', 'riff-mjpeg-ac3.avi'];

test('commands: -ss at the selected frame’s time extracts exactly that frame', { skip: !FFMPEG && 'needs ffmpeg' }, async () => {
  const cases = [];
  for (const name of SEEK_SAMPLES.filter(haveSample)) {
    const d = await docFor(name);
    const t = d.tracks.find((x) => x.kind === 'video');
    const s = t.samples;
    for (const i of [pickFrame(t), Math.floor((s.count * 3) / 4), s.count - 2]) if (s.sizes[i] > 0) cases.push([name, d, t, i]);
  }
  const md5 = (o) => o.stdout.trim().split('\n').filter((l) => !l.startsWith('#')).pop()?.split(',').pop()?.trim();
  await pool(cases, 8, async ([name, d, t, i]) => {
    const c = buildContext({ doc: d, entry: { kind: 'server', name, dir: SAMPLES }, sel: await selectFrame(d, t, i) });
    const cwd = freshDir(`seek-${name}-${i}`);
    const r = renderEntry(commandById('fix-frame'), c);
    const res = await sh(r.text, { cwd });
    assert.equal(res.code, 0, `${name}: ${r.text}\n${res.stderr}`);
    const png = unq(r.lines[0].tokens.find((x) => x.role === 'output').t);
    const got = await sh(`ffmpeg -v error -i ${shq(png)} -f framemd5 -`, { cwd });
    // Reference: decode everything and take the frame at the same position in display order.
    const ref = await sh(`ffmpeg -v error -i ${shq(sample(name))} -map 0:v:0 -vf "select=eq(n\\,${c.frame.display})" -frames:v 1 -pix_fmt rgb24 -f framemd5 -`, { cwd });
    assert.ok(md5(got), `${name}: no frame extracted`);
    assert.equal(md5(got), md5(ref), `${name}: sample ${i} (display ${c.frame.display}, -ss ${r.lines[0].tokens.find((x) => x.role === 'time').t}) is not the frame FFmpeg extracted`);
  });
});

// ------------------------------------------------------------------ running every command

/** Contexts an entry runs in: [label, context]. */
async function contextsFor(e) {
  const names = (SAMPLES_FOR[e.id] ?? DEFAULT_SAMPLES[e.tool]).filter(haveSample);
  const out = [];
  for (const name of names) {
    const encoders = ENCODES.has(e.id) ? ['x264', 'x265'] : ['x264'];
    for (const encoder of encoders) {
      const c = await contextFor(name, { encoder, kind: e.id === 'play-track' && name.includes('mp3-ac3') ? 'audio' : 'video', early: true });
      if (!renderEntry(e, c).reason) out.push([`${name}${encoders.length > 1 ? ` ${encoder}` : ''}`, c]);
    }
  }
  return out;
}

/** Run an entry's lines in `cwd`: ffmpeg with -t 1, ffprobe as is, ffplay translated for ffmpeg. */
async function runEntry(e, c, cwd) {
  const r = renderEntry(e, c);
  const results = [];
  for (const l of r.lines) {
    let tokens = l.tokens;
    if (l.tool === 'ffmpeg') {
      // A live stream goes to a file instead of the network, for the next step to play.
      tokens = oneSecond(tokens.map((x) => (x.role === 'output' && x.t.includes('udp:') ? { ...x, t: 'live.ts' } : x)));
      const cmd = commandText(tokens);
      const res = await sh(cmd, { cwd });
      assert.equal(res.code, 0, `${e.id}: ${cmd}\n${res.stderr.slice(-2000)}`);
      for (const w of words(tokens)) {
        if (w.role !== 'output' || w.t.includes('udp:')) continue;
        assert.ok(fs.existsSync(path.join(cwd, unq(w.t))), `${e.id}: ${w.t} was not written`);
      }
      results.push(res);
    } else if (l.tool === 'ffprobe') {
      const cmd = commandText(tokens);
      const res = await sh(cmd, { cwd });
      assert.equal(res.code, 0, `${e.id}: ${cmd}\n${res.stderr}`);
      assert.ok((res.stdout + res.stderr).trim().length > 0, `${e.id}: no output from ${cmd}`);
      if (/ -v error /.test(cmd)) assert.equal(res.stderr.trim(), '', `${e.id}: errors from ${cmd}`);
      results.push(res);
    } else {
      // ffplay: its input options and filter graph, run through ffmpeg into the null muxer.
      const ws = words(tokens);
      const inOpts = [];
      const outOpts = [];
      let input = null;
      for (const w of ws.slice(1)) {
        if (w.role === 'input') input = w.t.includes('udp:') ? 'live.ts' : w.t;
        else if (w.ff === 'in') inOpts.push(w.t);
        else if (w.ff === 'out') outOpts.push(w.t);
        else assert.equal(w.ff, 'play', `${e.id}: ffplay option ${w.t} is not classified`);
      }
      assert.ok(input, `${e.id}: no input`);
      const cmd = `ffmpeg -hide_banner -v error ${inOpts.join(' ')} -t 1 -i ${input} ${outOpts.join(' ')} -f null -`;
      const res = await sh(cmd, { cwd });
      assert.equal(res.code, 0, `${e.id}: ${cmd}\n${res.stderr}`);
      assert.equal(res.stderr.trim(), '', `${e.id}: errors from ${cmd}`);
      results.push(res);
      if (FFPLAY) {
        // The real player, without a screen or a sound card, for one second.
        const play = ws.filter((w) => w.role !== 'limit').map((w) => (w.role === 'input' && w.t.includes('udp:') ? 'live.ts' : w.t));
        play.splice(1, 0, '-loglevel error -autoexit -t 1');
        const p = await sh(play.join(' '), { cwd, env: { SDL_VIDEODRIVER: 'dummy', SDL_AUDIODRIVER: 'dummy' }, timeout: 30000 });
        assert.equal(p.code, 0, `${e.id}: ${play.join(' ')}\n${p.stderr}`);
        const errors = p.stderr.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').split(/[\r\n]+/).filter((x) => /error|invalid|unable|failed|not found|no such/i.test(x));
        assert.deepEqual(errors, [], `${e.id}: ffplay reported problems`);
      }
    }
  }
  return results;
}

for (const g of GROUPS) {
  test(`commands: every ${g.title} command runs`, { skip: (!FFMPEG || !haveSample('h264-aac.mp4')) && 'needs ffmpeg and npm run samples', concurrency: 6 }, async (t) => {
    await Promise.all(COMMANDS.filter((x) => x.group === g.id).map((e) => t.test(e.id, async (st) => {
      const contexts = await contextsFor(e);
      assert.ok(contexts.length, `${e.id}: no sample to run it on`);
      for (const [label, c] of contexts) {
        const why = missing(renderEntry(e, c).needs);
        if (why) {
          st.skip(`${e.id}: ${why}`);
          return;
        }
        const cwd = freshDir(`${e.id}-${label}`);
        if (e.uses) await runEntry(commandById(e.uses), c, cwd);
        await runEntry(e, c, cwd);
      }
    })));
  });
}

test('commands: every option exists in this FFmpeg (even for commands that cannot run here)', { skip: (!FFMPEG || !haveSample('h264-aac.mp4')) && 'needs ffmpeg' }, async () => {
  for (const encoder of ['x264', 'x265']) {
    const c = await contextFor('h264-aac.mp4', { encoder });
    for (const e of COMMANDS) {
      for (const l of renderEntry(e, c).lines) {
        for (const seg of segments(l.tokens)) {
          const tool = seg[0].t;
          if (tool === 'ffplay' && !FFPLAY) continue;
          const known = options(tool);
          for (const w of seg.slice(1)) {
            if (!/^-[a-z]/i.test(w.t) || w.t === '-i') continue; // values, paths, the null output "-"; -i is not listed
            const name = w.t.replace(/:.*$/, '');
            const ok = known.has(name) || (name.startsWith('-no') && known.has(`-${name.slice(3)}`));
            assert.ok(ok, `${e.id}: ${tool} has no option ${w.t}`);
          }
        }
      }
    }
  }
});

test('commands: close the sample files', async () => {
  for (const d of docs.values()) await (await d)._close();
  docs.clear();
});
