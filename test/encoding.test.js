// Encoder settings from the x264/x265 SEI (parsing, explanations, rate control, presets, the
// reproduce command), codec level limits and the shared encoding insights of every container.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { open, haveSample } from './helpers.mjs';
import { openDocument } from '../web/formats/index.js';
import { NodeFileSource } from '../scripts/node-source.mjs';
import { parseX26x, explainOptions, rateControl, detectPreset, reproduceCommand, X264_OPTIONS, X265_OPTIONS } from '../web/codecs/encoders.js';
import {
  H264_LEVELS, H264_BR_FACTORS, HEVC_LEVELS, HEVC_BR_FACTORS, AV1_LEVELS, AV1_PROFILE_FACTOR, VP9_LEVELS,
  checkLevel, h264Level, hevcLevel, av1Level, vp9Level, peakBitrate, bufferNeeded, maxRunBits,
} from '../web/codecs/levels.js';
import { encodingInsights, encoderSei } from '../web/core/encoding.js';
import { conceptEntries } from '../web/core/glossary.js';

// ------------------------------------------------------------------ helpers

let encoders;
function ffmpegHas(name) {
  if (encoders === undefined) {
    try {
      encoders = execFileSync('ffmpeg', ['-hide_banner', '-encoders'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    } catch {
      encoders = '';
    }
  }
  return new RegExp(`\\s${name}\\s`).test(encoders);
}
const X264 = ffmpegHas('libx264');
const X265 = ffmpegHas('libx265');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'vidscope-encoding-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const testsrc = (size, rate, duration) => ['-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=${rate}:duration=${duration}`];

/** Run FFmpeg quietly in the temporary directory (two-pass log files land there). */
function ffmpeg(args) {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args], { cwd: TMP, stdio: ['ignore', 'ignore', 'pipe'] });
}

let n = 0;
/** Encode a short test pattern and return the path. `passes` runs FFmpeg's two-pass mode. */
function encode(codec, args, { size = '160x90', rate = 25, duration = 0.4, passes = false } = {}) {
  const out = path.join(TMP, `enc-${++n}.mp4`);
  const quiet = codec === 'libx265' ? ['-x265-params', 'log-level=error'] : [];
  const base = [...testsrc(size, rate, duration), '-c:v', codec, ...args, ...(args.includes('-x265-params') ? [] : quiet)];
  if (passes) {
    ffmpeg([...base, '-pass', '1', '-an', '-f', 'null', os.devNull]);
    ffmpeg([...base, '-pass', '2', '-an', out]);
  } else ffmpeg([...base, '-an', out]);
  return out;
}

async function openPath(file) {
  const src = await NodeFileSource.open(file);
  const doc = await openDocument(src);
  if (doc.loadSamples) await doc.loadSamples();
  doc._close = () => src.close();
  return doc;
}

/** The x264/x265 SEI text of a file's first video track (found the way the UI finds it). */
async function seiOf(fileOrDoc) {
  const doc = typeof fileOrDoc === 'string' ? await openPath(fileOrDoc) : fileOrDoc;
  try {
    const t = doc.tracks.find((x) => x.kind === 'video');
    return await encoderSei(doc, t);
  } finally {
    if (typeof fileOrDoc === 'string') await doc._close();
  }
}

async function sampleSei(name) {
  const doc = await open(name);
  if (doc.loadSamples) await doc.loadSamples();
  try {
    return await seiOf(doc);
  } finally {
    await doc._close();
  }
}

// Options that describe the computer that encoded (or, for x265 repeat-headers, the container
// FFmpeg writes); a re-encode on another machine or into another container may differ.
const MACHINE = new Set(['threads', 'lookahead_threads', 'cpuid', 'frame-threads', 'numa-pools', 'total-frames', 'log-level', 'copy-pic']);

// ------------------------------------------------------------------ parsing

test('encoders: parses the x264 SEI of h264-aac.mp4', { skip: !haveSample('h264-aac.mp4') }, async () => {
  const sei = await sampleSei('h264-aac.mp4');
  assert.ok(sei, 'x264 SEI found');
  assert.match(sei.where, /first frame/);
  const p = parseX26x(sei.text);
  assert.equal(p.encoder, 'x264');
  assert.match(p.label, /^x264 core \d+ r\d+$/);
  assert.ok(p.options.length >= 40);
  // make-samples.sh: -preset veryfast -g 50 -bf 2, default CRF
  assert.equal(p.get('rc'), 'crf');
  assert.equal(p.get('crf'), '23.0');
  assert.equal(p.get('keyint'), '50');
  assert.equal(p.get('bframes'), '2');
  assert.equal(p.get('subme'), '2');
  assert.equal(p.get('ref'), '1');
  assert.equal(p.get('analyse'), '0x3:0x113');
  // the summary facts of the MP4 "Encoded with" insight
  assert.deepEqual(p.facts.find(([k]) => k === 'rate control'), ['rate control', 'CRF 23.0 (constant quality)']);
  assert.deepEqual(p.facts.find(([k]) => k === 'entropy coder'), ['entropy coder', 'CABAC']);
});

test('encoders: parses the x265 SEI of hevc-aac.mp4 (stored in hvcC)', { skip: !haveSample('hevc-aac.mp4') }, async () => {
  const sei = await sampleSei('hevc-aac.mp4');
  assert.ok(sei, 'x265 SEI found');
  assert.match(sei.where, /codec configuration \(hvcC\)/, 'with global headers x265 writes it next to the parameter sets');
  const p = parseX26x(sei.text);
  assert.equal(p.encoder, 'x265');
  assert.match(p.label, /^x265 \S+ \(build \d+\)$/);
  assert.equal(p.get('rc'), 'crf');
  assert.equal(p.get('crf'), '28.0');
  assert.equal(p.get('wpp'), '1', 'flag "wpp"');
  assert.equal(p.get('pmode'), '0', 'flag "no-pmode"');
  assert.equal(p.get('ctu'), '32', 'ultrafast');
  // x265 prints "scenecut-aware-qp=0conformance-window-offsets right=0 bottom=0" without a space
  assert.equal(p.get('scenecut-aware-qp'), '0');
  assert.match(p.get('conformance-window-offsets'), /^right=\d+ bottom=\d+$/);
  assert.equal(p.has('right'), false);
});

test('encoders: repairs the odd tokens of the x265 options string', () => {
  const text = 'x265 (build 199) - 3.5+1-f0c1022b6:[Linux][GCC 11.2.0][64 bit] 8bit - H.265/HEVC codec - Copyright 2013-2018 (c) Multicoreware, Inc - http://x265.org - options: '
    + 'cpuid=1111039 frame-threads=4 no-pmode ref=3 hme Level 0,1,2=1,2,2 merange L0,L1,L2=16,32,48 weightp display-window=1 left=0 top=0 right=8 bottom=4 '
    + 'sar=255 sar-width : sar-height=4:3 zone-count=2 zones: start-frame=0 end-frame=99 qp=20 zones: start-frame=100 end-frame=199 bitrate-factor=0.500000 '
    + 'scenecut-aware-qp=1 fwd-scenecut-window=500 bwd-nonref-qp-delta=-1.000000conformance-window-offsets right=0 bottom=8 no-mcstfscc=0 no-sbrc';
  const p = parseX26x(text);
  assert.equal(p.encoder, 'x265');
  assert.equal(p.version, '3.5+1-f0c1022b6');
  assert.equal(p.get('pmode'), '0');
  assert.equal(p.get('hme'), '1');
  assert.equal(p.get('hme-search'), '1,2,2');
  assert.equal(p.get('hme-range'), '16,32,48');
  assert.equal(p.get('display-window'), '0,0,8,4');
  assert.equal(p.get('sar-width:sar-height'), '4:3');
  assert.equal(p.get('zones'), '0,99,q=20/100,199,b=0.500000');
  assert.equal(p.get('bwd-nonref-qp-delta'), '-1.000000');
  assert.equal(p.get('conformance-window-offsets'), 'right=0 bottom=8');
  assert.equal(p.get('mcstf'), '0');
  assert.equal(p.get('scc'), '0');
  assert.equal(p.get('sbrc'), '0');
  for (const k of ['Level', 'L0,L1,L2', 'left', 'right', 'bottom', 'start-frame', 'qp', ':']) assert.equal(p.has(k), false, k);
  assert.ok(explainOptions(p).every((r) => r.known), 'every repaired option is in the catalogue');
});

// ------------------------------------------------------------------ explanations

// Options described only in general terms, on purpose: rarely used, reporting-only or
// computer-specific settings whose values Vidscope does not interpret. Adding or removing one is
// a deliberate change to this list.
const GENERIC_X264 = ['cplxblur', 'qblur', 'zones', 'crop_rect', 'slices_max', 'slice_max_size', 'slice_max_mbs', 'slice_min_mbs', 'stitchable', 'frame-packing'];
const GENERIC_X265 = [
  'cplxblur', 'qblur', 'slow-firstpass', 'min-vbv-fullness', 'max-vbv-fullness', 'vbv-end', 'vbv-end-fr-adj', 'zones', 'hevc-aq', 'qp-adaptation-range',
  'aq-motion', 'scenecut-aware-qp', 'fwd-scenecut-window', 'fwd-ref-qp-delta', 'fwd-nonref-qp-delta', 'bwd-scenecut-window', 'bwd-ref-qp-delta',
  'bwd-nonref-qp-delta', 'sbrc', 'frame-rc', 'vbv-live-multi-pass', 'decoder-max-rate', 'scenecut-bias', 'gop-lookahead', 'temporal-layers', 'splice',
  'frame-dup', 'dup-threshold', 'idr-recovery-sei', 'hme', 'hme-search', 'hme-range', 'analyze-src-pics', 'limit-tu', 'dynamic-rd', 'ssim-rd', 'tskip-fast',
  'splitrd-skip', 'rdpenalty', 'rd-refine', 'cu-lossless', 'lowpass-dct', 'mcstf', 'sao-non-deblock', 'limit-sao', 'chromaloc-top', 'chromaloc-bottom',
  'sar-width:sar-height', 'overscan', 'overscan-crop', 'display-window', 'dhdr10-opt', 'min-luma', 'max-luma', 'conformance-window-offsets', 'film-grain',
  'aom-film-grain', 'cpuid', 'numa-pools', 'pmode', 'pme', 'psnr', 'ssim', 'log-level', 'csv', 'csv-log-level', 'field', 'total-frames', 'chunk-start',
  'chunk-end', 'eob', 'eos', 'vui-timing-info', 'vui-hrd-info', 'log2-max-poc-lsb', 'opt-qp-pps', 'opt-ref-list-length-pps', 'multi-pass-opt-rps',
  'opt-cu-delta-qp', 'single-sei', 'analysis-save', 'analysis-load', 'analysis-reuse-level', 'analysis-save-reuse-level', 'analysis-load-reuse-level',
  'scale-factor', 'refine-intra', 'refine-inter', 'refine-mv', 'refine-ctu-distortion', 'refine-analysis-type', 'dynamic-refine', 'ctu-info', 'copy-pic',
  'max-ausize-factor', 'svt', 'alpha', 'num-views', 'format', 'scc',
];

test('encoders: the options left generic are exactly the listed ones', () => {
  const generic = (t) => Object.entries(t).filter(([, e]) => e.generic).map(([k]) => k).sort();
  assert.deepEqual(generic(X264_OPTIONS), [...GENERIC_X264].sort());
  assert.deepEqual(generic(X265_OPTIONS), [...GENERIC_X265].sort());
  for (const [k, e] of [...Object.entries(X264_OPTIONS), ...Object.entries(X265_OPTIONS)]) {
    assert.ok(e.name && e.what && e.cat, `${k} has a name, a description and a category`);
    if (!e.generic) assert.equal(typeof e.value, 'function', `${k} explains its value`);
  }
});

/** Option strings of the samples and of encodes that switch on the conditional options. */
async function optionStrings() {
  const out = [];
  for (const name of ['h264-aac.mp4', 'hevc-aac.mp4', 'hevc-10bit-hdr.mp4']) if (haveSample(name)) out.push((await sampleSei(name)).text);
  if (X264) {
    for (const args of [
      ['-crf', '20', '-maxrate', '500k', '-bufsize', '1000k', '-x264-params', 'nal-hrd=vbr:slices=2:open-gop=1:intra-refresh=0:mastering-display=G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(10000000,50):cll=1000,400'],
      ['-b:v', '300k', '-maxrate', '300k', '-bufsize', '600k', '-x264-params', 'nal-hrd=cbr:filler=1'],
      ['-qp', '20'],
      ['-tune', 'zerolatency'],
      ['-preset', 'superfast', '-x264-params', 'no-mbtree=1:zones=0,4,q=20:interlaced=1'],
    ]) out.push((await seiOf(encode('libx264', args, { size: '160x96' }))).text);
    out.push((await seiOf(encode('libx264', ['-b:v', '300k'], { passes: true }))).text);
  }
  if (X265) {
    for (const args of [
      ['-preset', 'ultrafast', '-crf', '26', '-maxrate', '500k', '-bufsize', '1000k'],
      ['-preset', 'ultrafast', '-qp', '30'],
    ]) out.push((await seiOf(encode('libx265', args))).text);
    // x265 turns HME off below 540 lines and frame duplication off without HRD and VBV
    const tools = ['-preset', 'ultrafast', '-maxrate', '500k', '-bufsize', '1000k', '-x265-params', 'log-level=error:hrd=1:hme=1:frame-dup=1:rskip=2:zones=0,4,q=20:display-window=0,0,8,0:sar=5\\:4:chromaloc=2:overscan=crop'];
    out.push((await seiOf(encode('libx265', tools, { size: '960x540', duration: 0.2 }))).text);
    out.push((await seiOf(encode('libx265', ['-preset', 'ultrafast', '-b:v', '300k'], { passes: true }))).text);
  }
  return out;
}

test('encoders: every option x264 and x265 write has an explanation', async () => {
  const strings = await optionStrings();
  assert.ok(strings.length >= 3, 'SEI strings to check');
  const unknown = new Set();
  const seen = { x264: new Set(), x265: new Set() };
  for (const text of strings) {
    const p = parseX26x(text);
    for (const r of explainOptions(p, { fps: 25 })) {
      seen[p.encoder].add(r.key);
      if (!r.known) unknown.add(`${p.encoder} ${r.key}`);
      else if (!r.generic) assert.ok(r.meaning, `${p.encoder} ${r.key}=${r.value} has a meaning`);
      else assert.equal(r.meaning, null);
    }
  }
  assert.deepEqual([...unknown], [], 'options without an explanation');
  if (X264) for (const k of ['vbv_maxrate', 'vbv_bufsize', 'crf_max', 'nal_hrd', 'filler', 'bitrate', 'ratetol', 'qp', 'slices', 'mastering-display', 'cll', 'zones', 'pb_ratio', 'cplxblur', 'qblur']) assert.ok(seen.x264.has(k), `x264 wrote ${k}`);
  if (X265) for (const k of ['vbv-maxrate', 'vbv-bufsize', 'vbv-init', 'crf-max', 'qp', 'bitrate', 'stats-read', 'hme-search', 'dup-threshold', 'rskip-edge-threshold', 'zones', 'display-window', 'sar-width:sar-height', 'chromaloc-top', 'overscan-crop']) assert.ok(seen.x265.has(k), `x265 wrote ${k}`);
});

// ------------------------------------------------------------------ rate control

test('encoders: detects the rate-control mode', { skip: !X264 && !X265 }, async () => {
  const cases = [];
  if (X264) {
    cases.push(['libx264', ['-crf', '21'], {}, 'crf']);
    cases.push(['libx264', ['-crf', '21', '-maxrate', '400k', '-bufsize', '800k'], {}, 'capped-crf']);
    cases.push(['libx264', ['-b:v', '300k'], {}, 'abr']);
    cases.push(['libx264', ['-b:v', '300k', '-maxrate', '450k', '-bufsize', '600k'], {}, 'abr']);
    cases.push(['libx264', ['-b:v', '300k', '-maxrate', '300k', '-bufsize', '600k'], {}, 'cbr']);
    cases.push(['libx264', ['-b:v', '300k'], { passes: true }, '2pass']);
    cases.push(['libx264', ['-qp', '22'], {}, 'cqp']);
  }
  if (X265) {
    cases.push(['libx265', ['-preset', 'ultrafast', '-crf', '26'], {}, 'crf']);
    cases.push(['libx265', ['-preset', 'ultrafast', '-crf', '26', '-maxrate', '400k', '-bufsize', '800k'], {}, 'capped-crf']);
    cases.push(['libx265', ['-preset', 'ultrafast', '-b:v', '300k'], {}, 'abr']);
    cases.push(['libx265', ['-preset', 'ultrafast', '-b:v', '300k', '-maxrate', '300k', '-bufsize', '600k'], {}, 'cbr']);
    cases.push(['libx265', ['-preset', 'ultrafast', '-b:v', '300k'], { passes: true }, '2pass']);
  }
  for (const [codec, args, opts, mode] of cases) {
    const p = parseX26x((await seiOf(encode(codec, args, opts))).text);
    const rc = rateControl(p, 300000);
    assert.equal(rc.mode, mode, `${codec} ${args.join(' ')}${opts.passes ? ' (two passes)' : ''}`);
    assert.ok(rc.sentence.length > 40 && rc.short && rc.facts.length >= 2);
  }
});

// ------------------------------------------------------------------ presets

test('encoders: recognises presets and tunes only when they match exactly', async () => {
  const slower = parseX26x('x264 - core 165 r3222 b35605a - H.264/MPEG-4 AVC codec - Copyleft 2003-2025 - http://www.videolan.org/x264.html - options: cabac=1 ref=8 deblock=1:0:0 analyse=0x3:0x133 me=umh subme=9 psy=1 psy_rd=1.00:0.00 mixed_ref=1 me_range=16 chroma_me=1 trellis=2 8x8dct=1 cqm=0 deadzone=21,11 fast_pskip=1 chroma_qp_offset=-2 threads=7 lookahead_threads=1 sliced_threads=0 nr=0 decimate=1 interlaced=0 bluray_compat=0 constrained_intra=0 bframes=3 b_pyramid=2 b_adapt=2 b_bias=0 direct=3 weightb=1 open_gop=0 weightp=2 keyint=250 keyint_min=25 scenecut=40 intra_refresh=0 rc_lookahead=60 rc=crf mbtree=1 crf=23.0 qcomp=0.60 qpmin=0 qpmax=69 qpstep=4 ip_ratio=1.40 aq=1:1.00');
  let d = detectPreset(slower, { fps: 25 });
  assert.deepEqual([d.preset, d.tunes, d.exact], ['slower', [], true]);
  const film = parseX26x('x264 - core 165 r3222 b35605a - H.264/MPEG-4 AVC codec - Copyleft 2003-2025 - http://www.videolan.org/x264.html - options: cabac=1 ref=3 deblock=1:-1:-1 analyse=0x3:0x113 me=hex subme=7 psy=1 psy_rd=1.00:0.15 mixed_ref=1 me_range=16 chroma_me=1 trellis=1 8x8dct=1 cqm=0 deadzone=21,11 fast_pskip=1 chroma_qp_offset=-3 threads=7 lookahead_threads=1 sliced_threads=0 nr=0 decimate=1 interlaced=0 bluray_compat=0 constrained_intra=0 bframes=3 b_pyramid=2 b_adapt=1 b_bias=0 direct=1 weightb=1 open_gop=0 weightp=2 keyint=250 keyint_min=25 scenecut=40 intra_refresh=0 rc_lookahead=40 rc=crf mbtree=1 crf=23.0 qcomp=0.60 qpmin=0 qpmax=69 qpstep=4 ip_ratio=1.40 aq=1:1.00');
  d = detectPreset(film, { fps: 25 });
  assert.deepEqual([d.preset, d.tunes, d.exact], ['medium', ['film'], true]);
  if (haveSample('h264-aac.mp4')) {
    // veryfast with -bf 2: no exact match, the closest preset and the one difference are named
    d = detectPreset(parseX26x((await sampleSei('h264-aac.mp4')).text), { fps: 25 });
    assert.equal(d.preset, 'veryfast');
    assert.equal(d.exact, false);
    assert.deepEqual(d.diffs, [{ key: 'bframes', file: '2', preset: '3' }]);
  }
  if (haveSample('hevc-aac.mp4')) {
    d = detectPreset(parseX26x((await sampleSei('hevc-aac.mp4')).text), { fps: 25 });
    assert.deepEqual([d.preset, d.exact], ['ultrafast', true]);
  }
});

// ------------------------------------------------------------------ reproduce

/** Run a reproduce command on 1 s of test pattern and compare the options of both encodes. */
async function reproduces(text, { size, rate, depth, chroma, label }) {
  const p = parseX26x(text);
  const out = path.join(TMP, `repro-${++n}.mp4`);
  const r = reproduceCommand(p, { fps: rate, depth, chroma, format: 'isobmff' }, { inputArgs: testsrc(size, rate, 1), output: out, nullOutput: os.devNull });
  assert.ok(r.cmd.startsWith('ffmpeg '), label);
  for (const pass of r.passes) ffmpeg(pass);
  const q = parseX26x((await seiOf(out)).text);
  const diffs = [];
  for (const k of new Set([...p.options.map((o) => o.key), ...q.options.map((o) => o.key)])) {
    if (!MACHINE.has(k) && p.get(k) !== q.get(k)) diffs.push(`${k}: ${p.get(k)} → ${q.get(k)}`);
  }
  assert.deepEqual(diffs, [], `${label}: ${r.cmd}`);
  return r;
}

test('encoders: the reproduce command re-creates the x264 options of h264-aac.mp4', { skip: !X264 || !haveSample('h264-aac.mp4') }, async () => {
  const r = await reproduces((await sampleSei('h264-aac.mp4')).text, { size: '640x360', rate: 25, depth: 8, chroma: 1, label: 'h264-aac.mp4' });
  assert.match(r.cmd, / -preset veryfast /);
  assert.match(r.cmd, / -bf 2 /);
  assert.match(r.cmd, / -g 50 /);
  assert.doesNotMatch(r.cmd, /threads/);
  assert.ok(r.notes.some((x) => /does not store the preset name/.test(x)));
});

test('encoders: the reproduce command re-creates the x265 options of the HEVC samples', { skip: !X265 }, async () => {
  if (haveSample('hevc-aac.mp4')) {
    const r = await reproduces((await sampleSei('hevc-aac.mp4')).text, { size: '640x360', rate: 25, label: 'hevc-aac.mp4' });
    assert.match(r.cmd, / -c:v libx265 -preset ultrafast -crf 28\.0 /);
  }
  if (haveSample('hevc-10bit-hdr.mp4')) {
    const r = await reproduces((await sampleSei('hevc-10bit-hdr.mp4')).text, { size: '640x360', rate: 24, label: 'hevc-10bit-hdr.mp4' });
    assert.match(r.cmd, /-pix_fmt yuv420p10le/);
    assert.match(r.cmd, /master-display=G\(13250,34500\)/);
    assert.match(r.cmd, /max-cll=1000,400/);
  }
});

test('encoders: the reproduce command handles two-pass and capped encodes', { skip: !X264 }, async () => {
  const two = await reproduces((await seiOf(encode('libx264', ['-preset', 'fast', '-b:v', '300k'], { size: '320x240', duration: 1, passes: true }))).text, { size: '320x240', rate: 25, depth: 8, chroma: 1, label: 'x264 two-pass' });
  assert.equal(two.passes.length, 2);
  assert.match(two.cmd, /-pass 1[\s\S]*&& \\\n[\s\S]*-pass 2/);
  await reproduces((await seiOf(encode('libx264', ['-preset', 'slow', '-crf', '20', '-maxrate', '600k', '-bufsize', '1200k', '-g', '48', '-keyint_min', '48', '-sc_threshold', '0', '-x264-params', 'psy-rd=0.8,0.1:deblock=-1,-1:aq-mode=3'], { size: '320x240', duration: 1 }))).text, { size: '320x240', rate: 25, depth: 8, chroma: 1, label: 'x264 capped CRF, fixed GOP, psy tweaks' });
});

// ------------------------------------------------------------------ levels

test('levels: H.264 Table A-1 and Table A-2 values', () => {
  const row = (name) => H264_LEVELS.find((l) => l.name === name);
  assert.equal(H264_LEVELS.length, 20);
  assert.deepEqual(row('1b'), { name: '1b', idc: 9, maxMBPS: 1485, maxFS: 99, maxDpbMbs: 396, maxBR: 128, maxCPB: 350 });
  assert.deepEqual(row('3'), { name: '3', idc: 30, maxMBPS: 40500, maxFS: 1620, maxDpbMbs: 8100, maxBR: 10000, maxCPB: 10000 });
  assert.deepEqual(row('3.1'), { name: '3.1', idc: 31, maxMBPS: 108000, maxFS: 3600, maxDpbMbs: 18000, maxBR: 14000, maxCPB: 14000 });
  assert.deepEqual(row('4'), { name: '4', idc: 40, maxMBPS: 245760, maxFS: 8192, maxDpbMbs: 32768, maxBR: 20000, maxCPB: 25000 });
  assert.deepEqual(row('4.1'), { name: '4.1', idc: 41, maxMBPS: 245760, maxFS: 8192, maxDpbMbs: 32768, maxBR: 50000, maxCPB: 62500 });
  assert.deepEqual(row('5.1'), { name: '5.1', idc: 51, maxMBPS: 983040, maxFS: 36864, maxDpbMbs: 184320, maxBR: 240000, maxCPB: 240000 });
  assert.deepEqual(row('6.2'), { name: '6.2', idc: 62, maxMBPS: 16711680, maxFS: 139264, maxDpbMbs: 696320, maxBR: 800000, maxCPB: 800000 });
  assert.deepEqual(H264_BR_FACTORS[100], [1250, 1500]);
  assert.deepEqual(H264_BR_FACTORS[110], [3000, 3600]);
  assert.deepEqual(H264_BR_FACTORS[122], [4000, 4800]);
  assert.deepEqual(H264_BR_FACTORS[244], [4000, 4800]);
  assert.deepEqual(H264_BR_FACTORS[77], [1000, 1200]);
  // 1080p (120 × 68 macroblocks) at level 4.1: floor(32768 / 8160) = 4 reference frames
  assert.equal(Math.floor(row('4.1').maxDpbMbs / (120 * 68)), 4);
  // level 1b: level_idc 11 with constraint_set3_flag in Baseline/Main/Extended, level_idc 9 otherwise
  assert.equal(h264Level(11, true, 66).name, '1b');
  assert.equal(h264Level(11, true, 100).name, '1.1');
  assert.equal(h264Level(9, false, 100).name, '1b');
  assert.equal(h264Level(99), null);
});

test('levels: HEVC Tables A.8 and A.9 values', () => {
  const row = (name) => HEVC_LEVELS.find((l) => l.name === name);
  assert.equal(HEVC_LEVELS.length, 13);
  assert.deepEqual(row('1'), { name: '1', idc: 30, maxLumaPs: 36864, maxCPB: [350, null], maxLumaSr: 552960, maxBR: [128, null] });
  assert.deepEqual(row('3.1'), { name: '3.1', idc: 93, maxLumaPs: 983040, maxCPB: [10000, null], maxLumaSr: 33177600, maxBR: [10000, null] });
  assert.deepEqual(row('4.1'), { name: '4.1', idc: 123, maxLumaPs: 2228224, maxCPB: [20000, 50000], maxLumaSr: 133693440, maxBR: [20000, 50000] });
  assert.deepEqual(row('5.1'), { name: '5.1', idc: 153, maxLumaPs: 8912896, maxCPB: [40000, 160000], maxLumaSr: 534773760, maxBR: [40000, 160000] });
  assert.deepEqual(row('6.2'), { name: '6.2', idc: 186, maxLumaPs: 35651584, maxCPB: [240000, 800000], maxLumaSr: 4278190080, maxBR: [240000, 800000] });
  assert.deepEqual(HEVC_BR_FACTORS[1], [1000, 1100]);
  assert.deepEqual(HEVC_BR_FACTORS[2], [1000, 1100]);
  assert.equal(hevcLevel(120).name, '4');
  for (const l of HEVC_LEVELS) assert.equal(l.idc, Math.round(Number(l.name) * 30), `level_idc of ${l.name} is 30 × the level`);
});

test('levels: AV1 Annex A and VP9 values', () => {
  assert.deepEqual(AV1_LEVELS.map((l) => l.idx), [0, 1, 4, 5, 8, 9, 12, 13, 14, 15, 16, 17, 18, 19]);
  for (const l of AV1_LEVELS) assert.equal(l.name, `${2 + (l.idx >> 2)}.${l.idx & 3}`, 'X.Y = 2 + (idx >> 2), idx & 3');
  assert.deepEqual(av1Level(0), { name: '2.0', idx: 0, maxPicSize: 147456, maxHSize: 2048, maxVSize: 1152, maxDisplayRate: 4423680, maxDecodeRate: 5529600, mainMbps: 1.5, highMbps: null });
  assert.deepEqual(av1Level(8), { name: '4.0', idx: 8, maxPicSize: 2359296, maxHSize: 6144, maxVSize: 3456, maxDisplayRate: 70778880, maxDecodeRate: 77856768, mainMbps: 12, highMbps: 30 });
  assert.deepEqual(av1Level(13), { name: '5.1', idx: 13, maxPicSize: 8912896, maxHSize: 8192, maxVSize: 4352, maxDisplayRate: 534773760, maxDecodeRate: 547430400, mainMbps: 40, highMbps: 160 });
  assert.deepEqual(av1Level(19), { name: '6.3', idx: 19, maxPicSize: 35651584, maxHSize: 16384, maxVSize: 8704, maxDisplayRate: 4278190080, maxDecodeRate: 4706009088, mainMbps: 160, highMbps: 800 });
  assert.deepEqual(AV1_PROFILE_FACTOR, { 0: 1, 1: 2, 2: 3 });
  assert.deepEqual(vp9Level(10), { name: '1', idc: 10, maxLumaSr: 829440, maxLumaPs: 36864, maxBreadth: 512, maxBR: 200, maxCPB: 400 });
  assert.deepEqual(vp9Level(31), { name: '3.1', idc: 31, maxLumaSr: 36864000, maxLumaPs: 983040, maxBreadth: 2752, maxBR: 12000, maxCPB: 10000 });
  assert.deepEqual(vp9Level(41), { name: '4.1', idc: 41, maxLumaSr: 160432128, maxLumaPs: 2228224, maxBreadth: 4160, maxBR: 30000, maxCPB: 18000 });
  assert.deepEqual(vp9Level(62), { name: '6.2', idc: 62, maxLumaSr: 4706009088, maxLumaPs: 35651584, maxBreadth: 16832, maxBR: 480000, maxCPB: null });
  assert.equal(VP9_LEVELS.filter((l) => l.maxCPB === null).length, 4, 'the CPB of 5.2 and up is not defined yet');
  // every table grows with the level
  for (const [rows, keys] of [[H264_LEVELS.filter((l) => l.name !== '1b'), ['maxMBPS', 'maxFS', 'maxDpbMbs', 'maxBR', 'maxCPB']], [HEVC_LEVELS, ['maxLumaPs', 'maxLumaSr']], [AV1_LEVELS, ['maxPicSize', 'maxDisplayRate', 'maxDecodeRate', 'mainMbps']], [VP9_LEVELS, ['maxLumaSr', 'maxLumaPs', 'maxBR']]]) {
    for (let i = 1; i < rows.length; i++) for (const k of keys) assert.ok(rows[i][k] >= rows[i - 1][k], `${rows[i].name} ${k}`);
  }
});

test('levels: peak bitrate, buffer and 4-frame CPB', () => {
  const sizes = new Uint32Array(50).fill(1000);
  const times = Float64Array.from({ length: 50 }, (_, i) => i / 25);
  assert.equal(peakBitrate(sizes, times, 1), 25 * 1000 * 8);
  assert.equal(peakBitrate(sizes.subarray(0, 10), times.subarray(0, 10), 1), null, 'shorter than the window');
  // a steady 200 kbit/s stream needs one frame of buffer at 200 kbit/s
  assert.equal(Math.round(bufferNeeded(sizes, times, 200000)), 8000);
  // one big frame: the buffer must hold it
  const big = Uint32Array.from(sizes);
  big[10] = 50000;
  assert.ok(bufferNeeded(big, times, 200000) >= 50000 * 8);
  assert.equal(maxRunBits(big, 4), (50000 + 3000) * 8);
});

test('levels: checkLevel on synthetic streams', () => {
  // 1080p60 needs H.264 level 4.2: 8160 macroblocks × 60 = 489,600 MB/s
  let r = checkLevel({ codec: 'avc', width: 1920, height: 1088, fps: 60, bitrate: 8e6, profile: 100, level: 40, refs: 4 });
  assert.equal(r.signalled.name, '4');
  assert.equal(r.pass, false);
  assert.deepEqual(r.limits.filter((l) => l.pass === false).map((l) => l.id), ['rate']);
  assert.equal(r.lowest.name, '4.2');
  // more reference frames than the DPB of level 4.1 holds at 1080p
  r = checkLevel({ codec: 'avc', width: 1920, height: 1088, fps: 30, bitrate: 8e6, profile: 100, level: 41, refs: 5 });
  assert.equal(r.limits.find((l) => l.id === 'dpb').pass, false);
  assert.equal(r.lowest.name, '5');
  // bitrate limit with the High-profile NAL factor: level 4.1 allows 50,000 × 1500 = 75 Mbit/s
  r = checkLevel({ codec: 'avc', width: 1920, height: 1088, fps: 30, bitrate: 70e6, profile: 100, level: 41 });
  assert.equal(r.limits.find((l) => l.id === 'bitrate').max, 75e6);
  assert.equal(r.pass, true);
  // HEVC 2160p60: level 5.1 (Main tier), not 5
  r = checkLevel({ codec: 'hevc', width: 3840, height: 2160, fps: 60, bitrate: 20e6, profile: 2, level: 150, tier: 0, dpb: 6 });
  assert.equal(r.pass, false);
  assert.equal(r.lowest.name, '5.1');
  // HEVC High tier: level 5.1 High allows 160,000 × 1100 bit/s
  r = checkLevel({ codec: 'hevc', width: 3840, height: 2160, fps: 30, bitrate: 100e6, profile: 2, level: 153, tier: 1 });
  assert.equal(r.limits.find((l) => l.id === 'bitrate').max, 176e6);
  assert.equal(r.signalled.tier, 'High');
  // AV1 level 31 has no limits; profile 1 doubles the bitrate
  assert.equal(checkLevel({ codec: 'av1', width: 8192, height: 8192, fps: 1, level: 31 }).unconstrained, true);
  r = checkLevel({ codec: 'av1', width: 1920, height: 1080, fps: 30, bitrate: 10e6, profile: 1, level: 8, tier: 0 });
  assert.equal(r.limits.find((l) => l.id === 'bitrate').max, 24e6);
  // VP9 without a level: only the lowest fitting level
  r = checkLevel({ codec: 'vp9', width: 1280, height: 720, fps: 30, bitrate: 2e6, level: 0 });
  assert.equal(r.signalled, null);
  assert.equal(r.lowest.name, '3.1');
});

test('levels: checkLevel on the samples', async () => {
  const cases = [
    ['h264-aac.mp4', 'avc', '3', '3'],
    ['hevc-aac.mp4', 'hevc', '2.1', '2.1'],
    ['av1-opus.mp4', 'av1', '2.1', '2.1'],
    ['flv-vp9-aac.flv', 'vp9', '2.1', '2.1'],
    ['vp9-opus.webm', 'vp9', null, '2.1'],
  ];
  for (const [name, codec, signalled, lowest] of cases) {
    if (!haveSample(name)) continue;
    const doc = await open(name);
    if (doc.loadSamples) await doc.loadSamples();
    const items = await encodingInsights(doc);
    await doc._close();
    const card = items.find((i) => /its level|no level signalled/.test(i.title));
    assert.ok(card, `${name}: level card`);
    if (signalled) {
      assert.equal(card.level, 'good', `${name}: ${card.title}`);
      assert.match(card.title, new RegExp(`level ${signalled.replace('.', '\\.')}\\)`));
    }
    assert.deepEqual(card.facts.find(([k]) => k === 'lowest level that fits').slice(0, 2), ['lowest level that fits', lowest], name);
    assert.ok(card.rows.every((r) => r.status !== 'bad'), `${name}: no limit exceeded`);
    assert.ok(card.rows.some((r) => r.k.startsWith('Bitrate')), `${name}: bitrate checked (${codec})`);
  }
});

// ------------------------------------------------------------------ insights in every container

test('encoding insights: every container', async () => {
  for (const name of ['h264-aac.mp4', 'h264-aac.mkv', 'h264-aac.ts', 'h264-aac.flv', 'h264-pcm.avi', 'riff-h264-aac.avi', 'hevc-ac3.ts', 'matroska-hevc-hdr.mkv', 'flv-hevc-opus.flv']) {
    if (!haveSample(name)) continue;
    const doc = await open(name);
    if (doc.loadSamples) await doc.loadSamples();
    const items = await encodingInsights(doc);
    const t = doc.tracks.find((x) => x.kind === 'video');
    await doc._close();
    const titles = items.map((i) => i.title);
    assert.ok(titles.some((x) => /^Encoder settings: x26[45]/.test(x)), `${name}: encoder settings (${titles.join(' | ')})`);
    assert.ok(titles.some((x) => /^Rate control: CRF/.test(x)), `${name}: rate control`);
    const repro = items.find((i) => /^Reproduce/.test(i.title));
    assert.ok(repro?.cmd && repro.cmdParts.map(([p]) => p).join('').replace(/^ /, '') === repro.cmd, `${name}: reproduce command and its parts`);
    const settings = items.find((i) => /^Encoder settings/.test(i.title));
    assert.ok(settings.rows.length > 20 && settings.rows.every((r) => r.ktip && r.vtip), `${name}: every option row explains itself on hover`);
    assert.ok(settings.offset > 0, `${name}: points at the SEI bytes`);
    assert.ok(items.some((i) => i.level === 'good' && /fits its level/.test(i.title)), `${name}: level check`);
    const bpp = items.find((i) => /bits per pixel$/.test(i.title));
    const expected = t.bitrate / (640 * 360 * 25);
    assert.ok(bpp && Math.abs(Number(bpp.title.split(' ')[0]) - expected) < 0.01, `${name}: bits per pixel ${bpp?.title} ≈ ${expected}`);
    for (const i of items) assert.ok(i.tip && (i.facts ?? []).every((f) => f[2] || f[0] === 'note'), `${name}: "${i.title}" explains its title and facts on hover`);
  }
});

test('encoding insights: bits per pixel and levels without an encoder SEI', async () => {
  for (const name of ['vp9-opus.webm', 'mpegts-mpeg2-mp2-cbr.ts', 'mpeg4-mp3.avi']) {
    if (!haveSample(name)) continue;
    const doc = await open(name);
    if (doc.loadSamples) await doc.loadSamples();
    const items = await encodingInsights(doc);
    await doc._close();
    assert.ok(!items.some((i) => /^Encoder settings/.test(i.title)), name);
    assert.ok(items.some((i) => /bits per pixel$/.test(i.title)), `${name}: bits per pixel`);
  }
});

test('encoding insights: the MP4 insight still summarises the x264 settings', { skip: !haveSample('h264-aac.mp4') }, async () => {
  const doc = await open('h264-aac.mp4');
  const items = await doc.insights();
  await doc._close();
  const enc = items.find((i) => /^Encoded with x264 core/.test(i.title));
  assert.ok(enc);
  const facts = Object.fromEntries(enc.facts);
  assert.equal(facts['rate control'], 'CRF 23.0 (constant quality)');
  assert.equal(facts['B-frames'], '2');
  assert.equal(facts['max keyframe interval'], '50 frames');
});

// ------------------------------------------------------------------ glossary

test('glossary: the encoding concepts are there', () => {
  const entries = conceptEntries();
  const terms = entries.map((e) => e.term);
  assert.equal(new Set(terms).size, terms.length, 'terms are unique');
  for (const t of ['rate-control', 'crf', 'capped-crf', 'abr', 'cbr', 'two-pass', 'vbv', 'maxrate-bufsize', 'qp', 'lookahead', 'mb-tree', 'aq', 'psy', 'profile', 'level', 'tier', 'bpp', 'preset', 'tune']) {
    const e = entries.find((x) => x.term === t);
    assert.ok(e && e.name && e.desc.length > 60 && e.cat === 'concept', t);
  }
});
