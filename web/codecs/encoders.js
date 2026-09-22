// Encoder settings from the SEI message x264 and x265 write into the first frame: parse the
// options string, explain every option, summarise the rate control, recognise the preset and
// build an FFmpeg command that reproduces the encode.

import { fmtInt, fmtNum, fmtBitrate } from '../core/util.js';
import { CATEGORIES, X264_OPTIONS, X265_OPTIONS, x264Partitions } from './encoder-options.js';

export { CATEGORIES, X264_OPTIONS, X265_OPTIONS };

// ------------------------------------------------------------------ parsing

/**
 * Split x265's options string into tokens, repairing the few places where x265_param2string
 * prints something that is not a plain key=value or flag (see x265 common/param.cpp).
 */
function x265Tokens(s) {
  const text = s
    .replace(/(\S)(conformance-window-offsets)/g, '$1 $2') // printed without a leading space
    .replace(/(\S)scc=(\d)/g, '$1 scc=$2') // same, in builds with screen content coding
    .replace(/(^|\s)Level 0,1,2=(\S+)/, '$1hme-search=$2') // HME: "Level 0,1,2=a,b,c"
    .replace(/(^|\s)merange L0,L1,L2=(\S+)/, '$1hme-range=$2') // HME: "merange L0,L1,L2=a,b,c"
    .replace(/sar-width : sar-height=(\S+)/, 'sar-width:sar-height=$1');
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  const out = [];
  const kv = (t) => {
    const i = t.indexOf('=');
    return i > 0 ? [t.slice(0, i), t.slice(i + 1)] : null;
  };
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === 'zones:') {
      // "zones: start-frame=A end-frame=B qp=Q" or "... bitrate-factor=F", once per zone
      const z = {};
      while (i + 1 < tokens.length && /^(start-frame|end-frame|qp|bitrate-factor)=/.test(tokens[i + 1])) {
        const [k, v] = kv(tokens[++i]);
        z[k] = v;
        if (k === 'qp' || k === 'bitrate-factor') break;
      }
      const zone = `${z['start-frame']},${z['end-frame']},${z.qp !== undefined ? `q=${z.qp}` : `b=${z['bitrate-factor']}`}`;
      const prev = out.find((o) => o.key === 'zones');
      if (prev) {
        prev.value += `/${zone}`;
        prev.raw += ` ${zone}`;
      } else out.push({ key: 'zones', value: zone, raw: `zones: ${zone}` });
      continue;
    }
    if (t === 'conformance-window-offsets' || t.startsWith('display-window=')) {
      // followed by right= bottom= (and left= top= for the display window)
      const parts = [];
      while (i + 1 < tokens.length && /^(left|top|right|bottom)=/.test(tokens[i + 1])) parts.push(tokens[++i]);
      if (t === 'conformance-window-offsets') out.push({ key: t, value: parts.join(' '), raw: `${t} ${parts.join(' ')}` });
      else {
        const v = t.slice(15);
        out.push({ key: 'display-window', value: v === '0' ? '0' : parts.map((p) => p.split('=')[1]).join(','), raw: [t, ...parts].join(' ') });
      }
      continue;
    }
    const p = kv(t);
    if (p) out.push({ key: p[0], value: p[1], raw: t });
    else if (t.startsWith('no-')) out.push({ key: t.slice(3), value: '0', raw: t });
    else out.push({ key: t, value: '1', raw: t });
  }
  return out;
}

function x264Tokens(s) {
  return s.trim().split(/\s+/).filter(Boolean).map((t) => {
    const i = t.indexOf('=');
    return i > 0 ? { key: t.slice(0, i), value: t.slice(i + 1), raw: t } : { key: t, value: '1', raw: t };
  });
}

/**
 * Parse the user-data text of an x264 or x265 SEI message ("x264 - core 165 r3222 ... - options:
 * cabac=1 ref=3 ..."). Returns { encoder: 'x264'|'x265'|null, label, version, header, options:
 * [{ key, value, raw }], get(key), has(key), facts } — `facts` is the short summary the MP4
 * insight lists.
 */
export function parseX26x(text) {
  const m = /options:\s*(.*)$/s.exec(text);
  const header = (m ? text.slice(0, m.index) : text).replace(/[\s-]+$/, '').trim();
  const encoder = /^\W*x265\b/.test(header) ? 'x265' : /^\W*x264\b/.test(header) ? 'x264' : /x265/.test(header) ? 'x265' : /x264/.test(header) ? 'x264' : null;
  const res = { encoder, header, label: header.split(' - ')[0].trim(), version: null, options: [] };
  if (encoder === 'x264') {
    const core = /core (\d+)(?: r(\d+))?(?: ([0-9a-f]{7,}))?/.exec(header);
    if (core) {
      res.core = Number(core[1]);
      res.revision = core[2] ? Number(core[2]) : null;
      res.version = `core ${core[1]}${core[2] ? ` r${core[2]}` : ''}${core[3] ? ` ${core[3]}` : ''}`;
      res.label = `x264 core ${core[1]}${core[2] ? ` r${core[2]}` : ''}`;
    }
  } else if (encoder === 'x265') {
    const b = /\(build (\d+)\)/.exec(header);
    const v = /x265 \(build \d+\) - ([^:\s]+)/.exec(header);
    if (b) res.build = Number(b[1]);
    if (v) res.version = v[1];
    const depth = /\]\s*([0-9+bit]+bit)\b/.exec(header);
    if (depth) res.depths = depth[1];
    res.label = `x265 ${res.version ?? ''}${res.build ? ` (build ${res.build})` : ''}`.replace(/\s+/g, ' ').trim();
  }
  if (m) res.options = encoder === 'x265' ? x265Tokens(m[1]) : x264Tokens(m[1]);
  const map = new Map(res.options.map((o) => [o.key, o.value]));
  res.get = (k) => map.get(k);
  res.has = (k) => map.has(k);
  res.facts = summaryFacts(res);
  return res;
}

/** The short summary of the MP4 "Encoded with" insight. */
function summaryFacts(p) {
  const facts = [['encoder', p.label]];
  const g = p.get;
  const rc = rateControl(p);
  if (rc) facts.push(['rate control', rc.short]);
  if (p.has('bframes')) facts.push(['B-frames', g('bframes')]);
  if (p.has('ref')) facts.push(['reference frames', g('ref')]);
  if (p.has('keyint')) facts.push(['max keyframe interval', `${g('keyint')} frames`]);
  const og = g('open_gop') ?? g('open-gop');
  if (og !== undefined) facts.push(['open GOP', og]);
  if (p.has('cabac')) facts.push(['entropy coder', g('cabac') === '1' ? 'CABAC' : 'CAVLC']);
  if (p.has('subme') || p.has('me')) facts.push(['motion search', `${p.encoder === 'x265' ? MOTION_265[g('me')] ?? g('me') ?? '' : g('me') ?? ''}${p.has('subme') ? `, subme ${g('subme')}` : ''}`]);
  const th = g('threads') ?? g('frame-threads');
  if (th !== undefined) facts.push([p.has('threads') ? 'threads' : 'frame threads', th]);
  return facts;
}

const MOTION_265 = { 0: 'dia', 1: 'hex', 2: 'umh', 3: 'star', 4: 'sea', 5: 'full' };

// ------------------------------------------------------------------ explanations

/**
 * Every option with its explanation: [{ key, value, raw, cat, catName, name, what, meaning,
 * tradeoff, ff, essential, generic, machine, known }] by category, essential options first, then
 * in the catalogue's order (related options together). `ctx` = { fps } (the track's frame rate,
 * used to turn frame counts into seconds).
 */
export function explainOptions(parsed, ctx = {}) {
  const table = parsed.encoder === 'x265' ? X265_OPTIONS : X264_OPTIONS;
  const c = { get: parsed.get, has: parsed.has, fps: ctx.fps ?? fpsOf(parsed), encoder: parsed.encoder };
  const order = new Map(CATEGORIES.map(([id], i) => [id, i]));
  const place = new Map(Object.keys(table).map((k, i) => [k, i]));
  const names = Object.fromEntries(CATEGORIES.map(([id, name]) => [id, name]));
  const rows = parsed.options.map((o, i) => {
    const e = table[o.key];
    const safe = (fn) => {
      try {
        return fn ? fn(o.value, c) : null;
      } catch {
        return null;
      }
    };
    if (!e) {
      return { ...o, i, cat: 'misc', catName: names.misc, name: o.key, what: `An ${parsed.encoder ?? 'encoder'} option Vidscope has no description for.`, meaning: null, tradeoff: null, ff: null, essential: false, generic: true, known: false };
    }
    return {
      ...o, i, cat: e.cat, catName: names[e.cat], name: e.name, what: e.what,
      meaning: e.generic ? null : safe(e.value) ?? null, tradeoff: e.tradeoff ?? null, ff: safe(e.ff) ?? null,
      essential: !!e.key, generic: !!e.generic, machine: !!e.machine, known: true,
    };
  });
  const rank = (r) => place.get(r.key) ?? 1e6 + r.i;
  return rows.sort((a, b) => order.get(a.cat) - order.get(b.cat) || b.essential - a.essential || rank(a) - rank(b));
}

function fpsOf(parsed) {
  const f = parsed.get('fps');
  if (!f) return null;
  const [n, d] = f.split('/').map(Number);
  return d ? n / d : n || null;
}

// ------------------------------------------------------------------ rate control

const RC_NAMES = { crf: 'CRF', 'capped-crf': 'Capped CRF', abr: 'ABR', cbr: 'CBR', '2pass': 'Two-pass', cqp: 'Constant QP', lossless: 'Lossless' };

/**
 * Rate control in one sentence plus facts: { mode, name, short, sentence, facts: [[k, v, tip]],
 * crf, qp, bitrate, maxrate, bufsize } (bitrates in kbit/s). `measured` is the track's bitrate
 * (bits/s) when known.
 */
export function rateControl(parsed, measured = null) {
  const g = parsed.get;
  const x265 = parsed.encoder === 'x265';
  const rc = g('rc');
  if (!rc) return null;
  const num = (k) => (parsed.has(k) ? Number(g(k)) : null);
  const crf = num('crf');
  const qp = num('qp');
  const bitrate = num('bitrate');
  const maxrate = num(x265 ? 'vbv-maxrate' : 'vbv_maxrate');
  const bufsize = num(x265 ? 'vbv-bufsize' : 'vbv_bufsize');
  const vbv = maxrate > 0 && bufsize > 0;
  const statRead = x265 ? num('stats-read') > 0 : rc === '2pass';
  let mode;
  if (rc === 'cqp') mode = qp === 0 || (x265 && g('lossless') === '1') ? 'lossless' : 'cqp';
  else if (x265 && g('lossless') === '1') mode = 'lossless';
  else if (statRead) mode = '2pass';
  else if (rc === 'crf') mode = vbv ? 'capped-crf' : 'crf';
  else if (rc === 'cbr') mode = 'cbr';
  else mode = 'abr';
  const kb = (v) => `${fmtInt(v)} kbit/s`;
  const buf = vbv ? `${fmtInt(bufsize)} kbit (${fmtNum(bufsize / maxrate, 2)} s at the maximum rate)` : null;
  const hard = !x265 && g('filler') === '1';
  let short;
  let sentence;
  switch (mode) {
    case 'crf':
      short = `CRF ${g('crf')} (constant quality)`;
      sentence = `Constant quality: the encoder aimed for the same visual quality everywhere (CRF ${g('crf')}), so complex scenes got more bits and simple ones fewer, and the file size was not fixed in advance.`;
      break;
    case 'capped-crf':
      short = `CRF ${g('crf')} capped at ${kb(maxrate)}`;
      sentence = `Capped CRF: CRF ${g('crf')} set the quality, but VBV (maximum ${kb(maxrate)}, buffer ${fmtInt(bufsize)} kbit) stopped the bitrate from rising above what a player's buffer can absorb — a common choice for streaming, where easy scenes stay small and hard ones are held back.`;
      break;
    case 'abr':
      short = `ABR ${kb(bitrate)}${vbv ? `, VBV max ${kb(maxrate)}` : ''}`;
      sentence = `Average bitrate in one pass: the encoder steered towards ${kb(bitrate)} as it went${vbv ? `, with VBV holding peaks to ${kb(maxrate)}` : ''}. Without seeing the rest of the video it distributes bits less well than CRF or two passes.`;
      break;
    case 'cbr':
      short = `CBR ${kb(bitrate)}`;
      sentence = `Constant bitrate: the average target and the VBV maximum rate are both ${kb(bitrate)}, with a ${fmtInt(bufsize ?? 0)} kbit buffer, so the data rate stays nearly flat — for live streaming and fixed-bandwidth links, at the cost of quality in complex scenes.${hard ? ' Filler data pads it to an exactly constant rate.' : ' Without filler data the rate can still dip below the target on easy content.'}`;
      break;
    case '2pass':
      short = `two-pass${bitrate ? ` ${kb(bitrate)}` : crf !== null ? ` CRF ${g('crf')}` : ''}`;
      sentence = `Two-pass: a first pass analysed the whole video and this pass used those statistics to ${bitrate ? `hit ${kb(bitrate)} on average` : 'place the bits'} with the best distribution of bits across scenes${vbv ? `, within a VBV maximum of ${kb(maxrate)}` : ''}.`;
      break;
    case 'cqp':
      short = `constant QP ${g('qp')}`;
      sentence = `Constant QP: every frame used a fixed quantizer (QP ${g('qp')} for P-frames, with offsets for I- and B-frames), whatever the content — useful for tests, but it wastes bits on easy scenes and gives no control of the size.`;
      break;
    default:
      short = 'lossless';
      sentence = 'Lossless: the decoded pictures are identical to the input. Files are very large.';
  }
  const facts = [['mode', RC_NAMES[mode], 'The rate-control family, see the glossary for each one.']];
  if (crf !== null && (mode === 'crf' || mode === 'capped-crf' || (mode === '2pass' && !bitrate))) facts.push(['CRF', g('crf'), 'Constant rate factor: the quality target. Lower means better quality and a bigger file.']);
  if (qp !== null && mode === 'cqp') facts.push(['QP', g('qp'), 'The fixed quantizer: the size of the rounding steps. Lower keeps more detail.']);
  if (bitrate) facts.push(['target bitrate', kb(bitrate), 'The average the encoder aimed for.']);
  if (vbv) {
    facts.push(['VBV max rate', kb(maxrate), 'The highest sustained rate VBV allows: the bandwidth the encoder assumed for the player.']);
    facts.push(['VBV buffer', buf, 'How much data the player\'s buffer holds; it absorbs short peaks above the maximum rate.']);
  }
  if (measured) {
    const dev = bitrate ? ` (${measured / 1000 >= bitrate ? '+' : ''}${fmtNum(((measured / 1000 - bitrate) / bitrate) * 100, 1)}% from the target)` : '';
    facts.push(['actual video bitrate', `${fmtBitrate(measured)}${dev}`, 'The bitrate of this file\'s video track: its bytes × 8 ÷ its duration. The sample-size chart in the Tracks tab shows how it varies from frame to frame.']);
  }
  const la = g('rc_lookahead') ?? g('rc-lookahead');
  if (la !== undefined) facts.push(['look-ahead', `${la} frames`, 'Frames analysed ahead before bits are assigned.']);
  const tree = x265 ? g('cutree') : g('mbtree');
  if (tree !== undefined) facts.push([x265 ? 'cu-tree' : 'mb-tree', tree === '1' ? 'on' : 'off', 'Gives more quality to the parts of a frame that later frames reuse as a reference.']);
  return { mode, name: RC_NAMES[mode], short, sentence, facts, crf, qp, bitrate, maxrate, bufsize };
}

// ------------------------------------------------------------------ x264 presets

const X264_DEFAULTS = {
  cabac: 1, ref: 3, deblock: 1, alpha: 0, beta: 0, intra: 0x3, inter: 0x113, me: 'hex', subme: 7, psy: 1, psyRd: 1, psyTrellis: 0,
  mixedRef: 1, meRange: 16, trellis: 1, dct8x8: 1, dzInter: 21, dzIntra: 11, fastPskip: 1, decimate: 1, bframes: 3, bAdapt: 1,
  direct: 1, weightb: 1, weightp: 2, scenecut: 40, lookahead: 40, mbtree: 1, qcomp: 0.6, ipRatio: 1.4, pbRatio: 1.3, aqMode: 1,
  aqStrength: 1, slicedThreads: 0, bPyramid: 2, chromaQpOffset: 0,
};

/** x264 common/base.c param_apply_preset(). */
export const X264_PRESETS = {
  ultrafast: { ref: 1, scenecut: 0, deblock: 0, cabac: 0, bframes: 0, intra: 0, inter: 0, dct8x8: 0, me: 'dia', subme: 0, aqMode: 0, mixedRef: 0, trellis: 0, bAdapt: 0, mbtree: 0, weightp: 0, weightb: 0, lookahead: 0 },
  superfast: { inter: 0x3, me: 'dia', subme: 1, ref: 1, mixedRef: 0, trellis: 0, mbtree: 0, weightp: 1, lookahead: 0 },
  veryfast: { subme: 2, ref: 1, mixedRef: 0, trellis: 0, weightp: 1, lookahead: 10 },
  faster: { mixedRef: 0, ref: 2, subme: 4, weightp: 1, lookahead: 20 },
  fast: { ref: 2, subme: 6, weightp: 1, lookahead: 30 },
  medium: {},
  slow: { subme: 8, ref: 5, direct: 3, trellis: 2, lookahead: 50 },
  slower: { me: 'umh', subme: 9, ref: 8, bAdapt: 2, direct: 3, inter: 0x133, trellis: 2, lookahead: 60 },
  veryslow: { me: 'umh', subme: 10, meRange: 24, ref: 16, bAdapt: 2, direct: 3, inter: 0x133, trellis: 2, bframes: 8, lookahead: 60 },
  placebo: { me: 'tesa', subme: 11, meRange: 24, ref: 16, bAdapt: 2, direct: 3, inter: 0x133, fastPskip: 0, trellis: 2, bframes: 16, lookahead: 60 },
};

/** x264 common/base.c param_apply_tune(); one psy tune may be combined with fastdecode and zerolatency. */
const X264_TUNES = {
  film: (p) => Object.assign(p, { alpha: -1, beta: -1, psyTrellis: 0.15 }),
  animation: (p) => Object.assign(p, { ref: p.ref > 1 ? p.ref * 2 : 1, alpha: 1, beta: 1, psyRd: 0.4, aqStrength: 0.6, bframes: p.bframes + 2 }),
  grain: (p) => Object.assign(p, { alpha: -2, beta: -2, psyTrellis: 0.25, decimate: 0, pbRatio: 1.1, ipRatio: 1.1, aqStrength: 0.5, dzInter: 6, dzIntra: 6, qcomp: 0.8 }),
  stillimage: (p) => Object.assign(p, { alpha: -3, beta: -3, psyRd: 2, psyTrellis: 0.7, aqStrength: 1.2 }),
  psnr: (p) => Object.assign(p, { aqMode: 0, psy: 0 }),
  ssim: (p) => Object.assign(p, { aqMode: 2, psy: 0 }),
  fastdecode: (p) => Object.assign(p, { deblock: 0, cabac: 0, weightb: 0, weightp: 0 }),
  zerolatency: (p) => Object.assign(p, { lookahead: 0, bframes: 0, slicedThreads: 1, mbtree: 0 }),
};

const X264_PRESET_NAMES = Object.keys(X264_PRESETS);
const PSY_TUNES = [null, 'film', 'animation', 'grain', 'stillimage', 'psnr', 'ssim'];

/**
 * The option values x264 prints for a preset and tune, with the adjustments x264 makes when it
 * validates them (encoder/encoder.c). Settings that follow from other options use the file's
 * values for those options (`f`), so that one changed option counts as one difference.
 */
function x264Expected(preset, tunes, f) {
  const p = { ...X264_DEFAULTS, ...X264_PRESETS[preset] };
  for (const t of tunes) X264_TUNES[t](p);
  const n = (k, d) => (f.has(k) ? Number(f.get(k)) : d);
  const keyint = f.get('keyint') === 'infinite' ? Infinity : n('keyint', 250);
  const rc = f.get('rc');
  const cqp = rc === 'cqp';
  if (cqp && n('qp', -1) === 0) {
    // lossless: x264 turns off the tools that cannot help
    Object.assign(p, { psy: 0, trellis: 0, fastPskip: 0, bframes: 0, chromaQpOffset: 0 });
    if (!p.cabac && p.subme < 6) p.dct8x8 = 0;
  }
  if (n('intra_refresh', 0)) {
    p.ref = 1;
    if (p.bPyramid === 2) p.bPyramid = 1;
  }
  if (keyint === 1) Object.assign(p, { ref: 1, weightp: 0 });
  const out = {};
  const ref = n('ref', p.ref);
  const subme = n('subme', p.subme);
  const trellis = n('trellis', p.trellis);
  const bframes = n('bframes', p.bframes);
  const dct = n('8x8dct', p.dct8x8);
  const me = f.get('me') ?? p.me;
  out.cabac = p.cabac;
  out.ref = p.ref;
  out.deblock = `${p.deblock}:${p.alpha}:${p.beta}`;
  let intra = p.intra & 0x3;
  let inter = p.inter & 0x133;
  if (!(inter & 0x10)) inter &= ~0x20;
  if (!dct) {
    inter &= ~0x2;
    intra &= ~0x2;
  }
  out.analyse = `${intra}:${inter}`;
  out.me = p.me === 'tesa' && subme <= 1 ? 'esa' : p.me;
  // subme 10 and 11 need trellis 2 and AQ; the file's trellis and AQ decide
  const aqFile = f.has('aq') ? Number(f.get('aq').split(':')[0]) : p.aqMode;
  out.subme = p.subme >= 10 && (trellis !== 2 || !aqFile) ? 9 : p.subme;
  out.psy = p.psy;
  if (p.psy) out.psy_rd = `${p.psyRd}:${p.psyTrellis}`;
  out.mixed_ref = p.mixedRef && ref > 1 ? 1 : 0;
  out.me_range = p.meRange > 16 && (me === 'dia' || me === 'hex') ? 16 : p.meRange;
  out.trellis = p.trellis;
  out['8x8dct'] = p.dct8x8;
  out.deadzone = `${p.dzInter},${p.dzIntra}`;
  out.fast_pskip = p.fastPskip;
  out.decimate = p.decimate;
  out.bframes = Math.min(p.bframes, keyint - 1);
  if (bframes) {
    out.b_pyramid = bframes <= 1 ? 0 : p.bPyramid;
    out.b_adapt = p.bAdapt;
    out.direct = subme === 0 && p.direct > 1 ? 1 : p.direct;
    out.weightb = p.weightb;
  }
  out.scenecut = p.scenecut;
  // look-ahead: clipped to the GOP length or to the duration of the VBV buffer
  const fps = f.fps || 25;
  const maxrate = Math.max(n('vbv_maxrate', 0), n('bitrate', 0));
  const bufsize = n('vbv_bufsize', 0);
  // (a second pass reads the look-ahead of the first pass back from the stats file)
  const la = Math.min(p.lookahead, Math.max(keyint, maxrate ? (bufsize / maxrate) * fps : 0));
  let mbtree = p.mbtree;
  const qcomp = n('qcomp', p.qcomp);
  if (keyint === 1 || qcomp === 1 || cqp) mbtree = 0;
  if (n('intra_refresh', 0) === 0 && keyint !== Infinity && la === 0) mbtree = 0;
  out.mbtree = mbtree;
  out.rc_lookahead = la; // printed only with mb-tree or VBV
  // weighted prediction: "fake" weights (-1) are printed as 0
  out.weightp = keyint === 1 ? 0 : Math.max(0, p.weightp);
  out.qcomp = p.qcomp;
  out.ip_ratio = p.ipRatio;
  out.pb_ratio = p.pbRatio; // printed only with B-frames and without mb-tree
  let aq = cqp ? 0 : p.aqMode;
  let strength = p.aqStrength;
  if (strength === 0) aq = 0;
  if (!aq && mbtree) {
    aq = 1;
    strength = 0;
  }
  out.aq = aq ? `${aq}:${strength}` : '0';
  const threads = n('threads', 2);
  out.sliced_threads = threads > 1 ? p.slicedThreads : 0;
  // chroma QP offset: x264 lowers it when psy-rd / psy-trellis are active (file's values decide)
  const [prd, ptr] = (f.get('psy_rd') ?? '0:0').split(':').map(Number);
  const psyOn = n('psy', p.psy);
  let cqo = p.chromaQpOffset + (f.csp444 && psyOn ? 6 : 0);
  if (psyOn && subme >= 6 && Math.round(prd * 256) > 0) cqo -= prd < 0.25 ? 1 : 2;
  if (psyOn && trellis && Math.round((ptr / 4) * 256) > 0) cqo -= ptr < 0.25 ? 1 : 2;
  out.chroma_qp_offset = cqo;
  return out;
}

/** Keys that identify an x264 preset or tune, compared when recognising the preset. */
const X264_PRESET_KEYS = [
  'cabac', 'ref', 'deblock', 'analyse', 'me', 'subme', 'psy', 'psy_rd', 'mixed_ref', 'me_range', 'trellis', '8x8dct', 'deadzone',
  'fast_pskip', 'decimate', 'bframes', 'b_pyramid', 'b_adapt', 'direct', 'weightb', 'weightp', 'scenecut', 'rc_lookahead', 'mbtree',
  'qcomp', 'ip_ratio', 'pb_ratio', 'aq', 'sliced_threads', 'chroma_qp_offset',
];

/** Compare an option value as printed with an expected value (numbers, masks, x:y lists). */
function sameValue(key, fileValue, expected) {
  if (fileValue === undefined || expected === undefined) return true;
  if (key === 'analyse') {
    const [a, b] = fileValue.split(':').map((x) => parseInt(x, 16));
    const [c, d] = String(expected).split(':').map(Number);
    return a === c && b === d;
  }
  const fa = String(fileValue).split(/[:,]/);
  const fb = String(expected).split(/[:,]/);
  if (fa.length !== fb.length) return false;
  return fa.every((x, i) => {
    const y = fb[i];
    const nx = Number(x);
    const ny = Number(y);
    return Number.isFinite(nx) && Number.isFinite(ny) ? Math.abs(nx - ny) < 0.005 : x === y;
  });
}

// ------------------------------------------------------------------ x265 presets

const X265_DEFAULTS = {
  ref: 3, bframes: 4, 'b-adapt': 2, 'rc-lookahead': 20, scenecut: 40, ctu: 64, 'min-cu-size': 8, rect: 0, amp: 0, 'tu-inter-depth': 1,
  'tu-intra-depth': 1, 'limit-tu': 0, 'rdoq-level': 0, signhide: 1, tskip: 0, 'max-merge': 3, 'limit-refs': 1, 'limit-modes': 0,
  me: 1, subme: 2, merange: 57, weightp: 1, weightb: 0, sao: 1, rd: 3, 'early-skip': 1, rskip: 1, 'fast-intra': 0, 'b-intra': 1,
  'psy-rd': 2, 'psy-rdoq': 0, 'aq-mode': 2, 'aq-strength': 1, cutree: 1, deblock: '0:0', 'b-pyramid': 1, ipratio: 1.4, pbratio: 1.3,
  qpstep: 4, 'rc-grain': 0, 'const-vbv': 0, 'qg-size': 32, 'hist-scenecut': 0,
};

/** x265 common/param.cpp x265_param_default_preset() (x265 4.x). */
export const X265_PRESETS = {
  ultrafast: { 'max-merge': 2, 'b-intra': 0, 'rc-lookahead': 5, scenecut: 0, ctu: 32, 'min-cu-size': 16, bframes: 3, 'b-adapt': 0, subme: 0, me: 0, sao: 0, signhide: 0, weightp: 0, rd: 2, ref: 1, 'limit-refs': 0, 'aq-strength': 0, 'aq-mode': 0, 'fast-intra': 1 },
  superfast: { 'max-merge': 2, 'b-intra': 0, 'rc-lookahead': 10, ctu: 32, bframes: 3, 'b-adapt': 0, subme: 1, weightp: 0, rd: 2, ref: 1, 'limit-refs': 0, 'aq-strength': 0, 'aq-mode': 0, sao: 0, 'fast-intra': 1 },
  veryfast: { 'max-merge': 2, 'limit-refs': 3, 'b-intra': 0, 'rc-lookahead': 15, 'b-adapt': 0, subme: 1, rd: 2, ref: 2, 'fast-intra': 1 },
  faster: { 'max-merge': 2, 'limit-refs': 3, 'b-intra': 0, 'rc-lookahead': 15, 'b-adapt': 0, rd: 2, ref: 2, 'fast-intra': 1 },
  fast: { 'max-merge': 2, 'limit-refs': 3, 'early-skip': 0, 'b-intra': 0, 'rc-lookahead': 15, 'b-adapt': 0, rd: 2, ref: 3, 'fast-intra': 1 },
  medium: {},
  slow: { 'limit-refs': 3, 'early-skip': 0, 'b-intra': 0, rect: 1, 'rc-lookahead': 25, rd: 4, 'rdoq-level': 2, 'psy-rdoq': 1, subme: 3, me: 3, ref: 4, 'limit-modes': 1 },
  slower: { 'early-skip': 0, weightb: 1, amp: 1, rect: 1, 'rc-lookahead': 40, bframes: 8, 'tu-inter-depth': 3, 'tu-intra-depth': 3, rd: 6, 'rdoq-level': 2, 'psy-rdoq': 1, subme: 4, 'max-merge': 4, me: 3, ref: 5, 'limit-modes': 1, 'limit-tu': 4 },
  veryslow: { 'early-skip': 0, weightb: 1, amp: 1, rect: 1, 'rc-lookahead': 40, bframes: 8, 'tu-inter-depth': 3, 'tu-intra-depth': 3, rd: 6, 'rdoq-level': 2, 'psy-rdoq': 1, subme: 4, 'max-merge': 5, me: 3, ref: 5, 'limit-refs': 0, 'limit-modes': 0, 'limit-tu': 0 },
  placebo: { 'early-skip': 0, weightb: 1, amp: 1, rect: 1, 'rc-lookahead': 60, merange: 92, bframes: 8, 'tu-inter-depth': 4, 'tu-intra-depth': 4, rd: 6, 'rdoq-level': 2, 'psy-rdoq': 1, subme: 5, 'max-merge': 5, me: 3, tskip: 1, rskip: 0, ref: 5, 'limit-refs': 0 },
};

const X265_TUNES = {
  psnr: (p) => Object.assign(p, { 'aq-strength': 0, 'psy-rd': 0, 'psy-rdoq': 0 }),
  ssim: (p) => Object.assign(p, { 'aq-mode': 2, 'psy-rd': 0, 'psy-rdoq': 0 }),
  grain: (p) => Object.assign(p, { ipratio: 1.1, pbratio: 1, cutree: 0, 'aq-mode': 0, qpstep: 1, 'rc-grain': 1, rskip: 0, 'psy-rd': 4, 'psy-rdoq': 10, sao: 0, 'const-vbv': 1 }),
  zerolatency: (p) => Object.assign(p, { 'b-adapt': 0, bframes: 0, 'rc-lookahead': 0, scenecut: 0, 'hist-scenecut': 0, cutree: 0 }),
  fastdecode: (p) => Object.assign(p, { deblock: '0', sao: 0, weightp: 0, weightb: 0, 'b-intra': 0 }),
  animation: (p) => Object.assign(p, { bframes: p.bframes + 2 >= p['rc-lookahead'] ? p.bframes : p.bframes + 2, 'psy-rd': 0.4, 'aq-strength': 0.4, deblock: '1:1' }),
};
const X265_TUNE_NAMES = [null, 'psnr', 'ssim', 'grain', 'zerolatency', 'fastdecode', 'animation'];

/** Printed x265 values of a preset and tune, with the adjustments of x265's encoder configuration. */
function x265Expected(preset, tunes, f) {
  const p = { ...X265_DEFAULTS, ...X265_PRESETS[preset] };
  for (const t of tunes) X265_TUNES[t](p);
  const n = (k, d) => (f.has(k) ? Number(f.get(k)) : d);
  const out = { ...p };
  const rc = f.get('rc');
  const bframes = n('bframes', p.bframes);
  const rd = n('rd', p.rd);
  if (!bframes) out['b-pyramid'] = 0;
  if (n('rdoq-level', p['rdoq-level']) === 0) out['psy-rdoq'] = 0;
  if (rd < 3) out.tskip = 0;
  if (rd < 2) {
    out['psy-rd'] = 0;
    out.rect = 0;
  }
  if (!n('rect', p.rect)) out.amp = 0;
  let aq = p['aq-mode'];
  let strength = p['aq-strength'];
  let cutree = p.cutree;
  if (rc === 'cqp') {
    aq = 0;
    strength = 0;
    cutree = 0;
  }
  if (aq === 0 && cutree) {
    aq = 1;
    strength = 0;
  }
  if (n('rc-lookahead', p['rc-lookahead']) === 0 && cutree && !(n('stats-read', 0) > 0)) cutree = 0;
  if (strength === 0 && !cutree) aq = 0;
  if (aq === 0 && !cutree) strength = 0;
  out['aq-mode'] = aq;
  out['aq-strength'] = strength;
  out.cutree = cutree;
  if (n('tu-inter-depth', p['tu-inter-depth']) < 2) out['limit-tu'] = 0;
  if (!bframes) delete out.pbratio;
  if (n('strict-cbr', 0)) out.pbratio = 1;
  // quantization groups: clamped to the CTU when AQ or VBV use them, else the CTU size
  const ctu = n('ctu', p.ctu);
  const minCu = n('min-cu-size', p['min-cu-size']);
  const vbv = n('vbv-bufsize', 0) > 0 && n('vbv-maxrate', 0) > 0;
  if (aq || vbv || n('aq-motion', 0)) out['qg-size'] = Math.min(ctu, Math.max(p['qg-size'], Math.max(8, minCu)));
  else out['qg-size'] = ctu;
  return out;
}

const X265_PRESET_KEYS = Object.keys(X265_DEFAULTS);

// ------------------------------------------------------------------ preset recognition

/**
 * Recognise the preset (and tune) of an x264 or x265 encode by comparing the options with what
 * each preset and tune would give. Returns { preset, tunes, exact, diffs: [{ key, file, preset }] }
 * for the closest candidate; `exact` only when every compared option matches. The preset name
 * itself is not stored in the stream.
 */
export function detectPreset(parsed, ctx = {}) {
  const x265 = parsed.encoder === 'x265';
  if (!parsed.encoder || !parsed.options.length) return null;
  const f = { get: parsed.get, has: parsed.has, fps: ctx.fps ?? fpsOf(parsed), csp444: ctx.chroma === 3 || parsed.get('input-csp') === '3' };
  const names = x265 ? Object.keys(X265_PRESETS) : X264_PRESET_NAMES;
  const keys = x265 ? X265_PRESET_KEYS : X264_PRESET_KEYS;
  const tuneSets = [];
  if (x265) for (const t of X265_TUNE_NAMES) tuneSets.push(t ? [t] : []);
  else {
    for (const psy of PSY_TUNES) {
      for (const fd of [false, true]) {
        for (const zl of [false, true]) tuneSets.push([psy, fd && 'fastdecode', zl && 'zerolatency'].filter(Boolean));
      }
    }
  }
  let best = null;
  for (const preset of names) {
    for (const tunes of tuneSets) {
      const exp = x265 ? x265Expected(preset, tunes, f) : x264Expected(preset, tunes, f);
      const diffs = [];
      for (const k of keys) {
        const fv = parsed.get(k);
        if (fv === undefined || exp[k] === undefined) continue;
        if (!sameValue(k, fv, exp[k])) diffs.push({ key: k, file: fv, preset: String(exp[k]) });
      }
      const score = diffs.length * 10 + tunes.length;
      if (!best || score < best.score) best = { preset, tunes, diffs, expected: exp, score };
    }
  }
  return { preset: best.preset, tunes: best.tunes, exact: best.diffs.length === 0, diffs: best.diffs, expected: best.expected };
}

// ------------------------------------------------------------------ reproduce with FFmpeg

/** Quote a shell word when it needs it. */
export function shellQuote(s) {
  return /^[\w.,:=+/@%-]+$/.test(s) ? s : `"${s.replace(/(["\\$`])/g, '\\$1')}"`;
}

const OUT_EXT = { isobmff: 'mp4', matroska: 'mkv', mpegts: 'ts', flv: 'flv', riff: 'avi' };

/** FFmpeg pixel format for a bit depth and chroma format (0 = 4:0:0, 1 = 4:2:0, 2 = 4:2:2, 3 = 4:4:4). */
export function pixFmt(depth = 8, chroma = 1) {
  if (chroma === 0) return depth > 8 ? `gray${depth}le` : 'gray';
  const base = { 1: 'yuv420p', 2: 'yuv422p', 3: 'yuv444p' }[chroma] ?? 'yuv420p';
  return depth > 8 ? `${base}${depth}le` : base;
}

/**
 * An FFmpeg command that encodes with the same settings. Only options the SEI records are used,
 * and only where they differ from what the chosen preset gives. `ctx` = { fps, depth, chroma,
 * format (the container id, for the output name) }; `opts` = { inputArgs, output, nullOutput }
 * replace the placeholder input and output (the tests run the command on a test pattern).
 *
 * Returns { preset, passes: [args[]], parts: [[text, tip]], cmd, notes: [text] }.
 */
export function reproduceCommand(parsed, ctx = {}, opts = {}) {
  if (parsed.encoder !== 'x264' && parsed.encoder !== 'x265') return null;
  const x265 = parsed.encoder === 'x265';
  const table = x265 ? X265_OPTIONS : X264_OPTIONS;
  const g = parsed.get;
  const fps = ctx.fps ?? fpsOf(parsed);
  const det = detectPreset(parsed, { ...ctx, fps });
  const rc = rateControl(parsed);
  if (!det || !rc) return null;
  const exp = det.expected;
  const tip = (key, extra = '') => {
    const e = table[key];
    return e ? `${e.name}\n${e.what}${extra ? `\n${extra}` : ''}` : extra;
  };
  const common = []; // [[flag, value?, tip]]
  const params = []; // [[key, value, tip]] for -x264-params / -x265-params
  const used = new Set(['rc']);
  const add = (flag, value, t) => common.push([flag, value, t]);
  const param = (key, value, t, src = key) => {
    used.add(src);
    params.push([key, value, t]);
  };

  add('-c:v', x265 ? 'libx265' : 'libx264', `Encode the video with ${parsed.encoder}${x265 ? ' (FFmpeg\'s libx265)' : ' (FFmpeg\'s libx264)'}.`);
  add('-preset', det.preset, `${det.exact ? 'The options match this preset exactly.' : `The closest preset (${det.diffs.length} option${det.diffs.length === 1 ? '' : 's'} differ; they are set explicitly).`} ${parsed.encoder} does not record the preset name.\nPresets trade encoding speed for compression: slower presets search harder and make smaller files at the same quality.`);
  if (det.tunes.length) add('-tune', det.tunes.join(','), 'A tune adjusts the psychovisual and other settings for a kind of content or use (film, animation, grain, zerolatency...). Recognised from the options it changes.');

  // rate control
  const rcKey = (k) => (x265 ? k.replace(/_/g, '-') : k);
  const vbvMax = g(rcKey('vbv_maxrate'));
  const vbvBuf = g(rcKey('vbv_bufsize'));
  used.add(rcKey('vbv_maxrate')).add(rcKey('vbv_bufsize')).add('crf').add('bitrate').add('qp');
  if (rc.mode === 'crf' || rc.mode === 'capped-crf' || (rc.mode === '2pass' && !rc.bitrate)) add('-crf', g('crf'), tip('crf', `This file: CRF ${g('crf')}.`));
  if (rc.mode === 'cqp' || rc.mode === 'lossless') add('-qp', g('qp'), tip('qp', `This file: QP ${g('qp')}.`));
  if (rc.bitrate) add('-b:v', `${g('bitrate')}k`, tip('bitrate', `This file: ${fmtInt(rc.bitrate)} kbit/s.`));
  if (Number(vbvMax) > 0 && Number(vbvBuf) > 0) {
    add('-maxrate', `${vbvMax}k`, tip(rcKey('vbv_maxrate'), `This file: ${fmtInt(Number(vbvMax))} kbit/s.`));
    add('-bufsize', `${vbvBuf}k`, tip(rcKey('vbv_bufsize'), `This file: ${fmtInt(Number(vbvBuf))} kbit.`));
  }
  const crfMax = g(rcKey('crf_max'));
  used.add(rcKey('crf_max'));
  if (crfMax !== undefined && Number(crfMax) > 0) {
    if (x265) param('crf-max', crfMax, tip('crf-max'));
    else add('-crf_max', crfMax, tip('crf_max'));
  }
  if (x265) {
    used.add('crf-min');
    if (Number(g('crf-min')) > 0) param('crf-min', g('crf-min'), tip('crf-min'));
    // FFmpeg starts the VBV buffer 3/4 full (printed 0.8) unless -rc_init_occupancy is given
    used.add('vbv-init');
    if (g('vbv-init') !== undefined && g('vbv-init') !== '0.8') param('vbv-init', g('vbv-init'), tip('vbv-init'));
  }

  // GOP
  const keyint = g('keyint');
  used.add('keyint');
  if (keyint !== undefined && keyint !== '250') {
    if (keyint === 'infinite') param('keyint', 'infinite', tip('keyint'));
    else add('-g', keyint, tip('keyint', `This file: ${keyint} frames.`));
  }
  const kmKey = x265 ? 'min-keyint' : 'keyint_min';
  used.add(kmKey);
  const kmin = g(kmKey);
  if (kmin !== undefined) {
    const k = keyint === 'infinite' ? Infinity : Number(keyint ?? 250);
    const auto = fps ? Math.max(1, x265 ? Math.min(Math.floor(fps), Math.floor(k / 10)) : Math.min(Math.floor(Math.min(k, 1e9) / 10), Math.floor(fps))) : null;
    const clipped = auto === null ? null : x265 ? auto : Math.min(Math.max(auto, 1), Math.floor(k / 2) + 1);
    if (clipped === null || Number(kmin) !== clipped) add('-keyint_min', kmin, tip(kmKey, `This file: ${kmin}${auto === null ? '' : `; the automatic value would be ${clipped}`}.`));
  }
  used.add('bframes');
  if (!sameValue('bframes', g('bframes'), exp.bframes)) add('-bf', g('bframes'), tip('bframes', `This file: ${g('bframes')}; the preset gives ${exp.bframes}.`));
  used.add('ref');
  if (!sameValue('ref', g('ref'), exp.ref)) add('-refs', g('ref'), tip('ref', `This file: ${g('ref')}; the preset gives ${exp.ref}.`));
  if (!x265 && !sameValue('scenecut', g('scenecut'), exp.scenecut)) {
    used.add('scenecut');
    add('-sc_threshold', g('scenecut'), tip('scenecut', `This file: ${g('scenecut')}.`));
  }

  // everything else that differs from the preset, as encoder parameters
  if (x265) x265Params(parsed, exp, param, used);
  else x264Params(parsed, exp, param, used);

  const depth = ctx.depth ?? (x265 ? Number(g('bitdepth')) || 8 : 8);
  const chroma = ctx.chroma ?? (x265 && g('input-csp') !== undefined ? Number(g('input-csp')) : 1);
  const pf = pixFmt(depth, chroma);
  const pixFmtFlag = ['-pix_fmt', pf, `Pixel format: ${depth}-bit ${['4:0:0', '4:2:0', '4:2:2', '4:4:4'][chroma] ?? ''}. ${x265 ? 'x265 records the bit depth and chroma format in its options.' : 'From the stream\'s SPS (x264 does not record it in its options).'}`];

  // assemble one or two passes
  const input = opts.inputArgs ?? ['-i', 'source.mov'];
  const output = opts.output ?? `output.${OUT_EXT[ctx.format] ?? 'mp4'}`;
  const paramArg = params.length ? params.map(([k, v]) => `${k}=${v}`).join(':') : null;
  const encArgs = [];
  const encParts = [];
  for (const [flag, value, t] of common) {
    encArgs.push(flag);
    encParts.push([` ${flag}`, t]);
    if (value !== undefined && value !== null) {
      encArgs.push(String(value));
      encParts.push([` ${shellQuote(String(value))}`, t]);
    }
  }
  if (paramArg) {
    const flag = x265 ? '-x265-params' : '-x264-params';
    encArgs.push(flag, paramArg);
    encParts.push([` ${flag} `, `Encoder options with no FFmpeg flag of their own, as key=value pairs separated by colons. Hover each one.`]);
    const quote = !/^[\w.,:=+/@%-]+$/.test(paramArg);
    if (quote) encParts.push(['"', null]);
    params.forEach(([k, v, t], i) => encParts.push([`${i ? ':' : ''}${k}=${quote ? v.replace(/(["\\$`])/g, '\\$1') : v}`, t]));
    if (quote) encParts.push(['"', null]);
  }
  encArgs.push(pixFmtFlag[0], pixFmtFlag[1]);
  encParts.push([` ${pixFmtFlag[0]} ${pixFmtFlag[1]}`, pixFmtFlag[2]]);
  const inputTip = 'Your original, high-quality source. Re-encoding a file that is already compressed (like this one) adds a second round of compression artefacts.';
  const passes = [];
  const parts = [];
  const pushPass = (extra, extraParts, out, outTip, prefix) => {
    passes.push([...(prefix ?? []), ...input, ...encArgs, ...extra, out]);
    if (parts.length) parts.push([' && \\\n', null]);
    parts.push(['ffmpeg', 'FFmpeg: reads, converts and writes audio and video.']);
    if (prefix) parts.push([` ${prefix.join(' ')}`, 'Overwrite the output without asking.']);
    parts.push([` ${opts.inputArgs ? opts.inputArgs.map(shellQuote).join(' ') : '-i source.mov'}`, inputTip]);
    parts.push(...encParts, ...extraParts);
    parts.push([` ${shellQuote(out)}`, outTip]);
  };
  const noAudio = [' -an', 'No audio: this command reproduces the video encode only; add your own audio settings.'];
  if (rc.mode === '2pass') {
    const nul = opts.nullOutput ?? '/dev/null';
    const passTip = (k) => `Pass ${k} of 2. ${k === 1 ? 'The first pass only analyses the video and writes statistics to a log file; its output is thrown away.' : 'The second pass reads the statistics and encodes for real.'}`;
    pushPass(['-pass', '1', '-an', '-f', 'null'], [[' -pass 1', passTip(1)], noAudio, [' -f null', 'Discard the output of the first pass.']], nul, 'Nowhere (on Windows use NUL).', ['-y']);
    pushPass(['-pass', '2', '-an'], [[' -pass 2', passTip(2)], noAudio], output, 'The new file.');
  } else {
    pushPass(['-an'], [noAudio], output, 'The new file. Its container can differ from the source.');
  }
  const notes = [];
  notes.push(`${parsed.encoder} does not store the preset name: ${det.exact ? `every option that presets control matches "${det.preset}"${det.tunes.length ? ` with tune ${det.tunes.join(', ')}` : ''}, so the command uses it.` : `no preset matches exactly. The closest is "${det.preset}"${det.tunes.length ? ` with tune ${det.tunes.join(', ')}` : ''} (${det.diffs.map((d) => `${d.key} ${d.file} instead of ${d.preset}`).join(', ')}), so the command starts from it and sets the differences explicitly.`}`);
  notes.push(`Not recorded, so not in the command: the source file and any filters (scaling, cropping, deinterlacing), the audio, the container settings, and the level${x265 ? '' : ' and profile'} the encoder was told to use.`);
  const machine = parsed.options.filter((o) => table[o.key]?.machine).map((o) => o.key);
  if (machine.length) notes.push(`Left out because they describe the computer, not the encode: ${machine.join(', ')}.`);
  const skip = x265 ? X265_REPRO_SKIP : X264_REPRO_SKIP;
  const skipped = parsed.options.filter((o) => !used.has(o.key) && !skip[o.key] && !table[o.key]?.machine && differsFromDefault(parsed.encoder, o, exp, table)).map((o) => o.key);
  if (skipped.length) notes.push(`Not reproduced (no safe way to set them from FFmpeg): ${skipped.join(', ')}.`);
  return {
    preset: det,
    passes,
    parts,
    cmd: parts.map(([t]) => t).join('').replace(/^ /, ''),
    notes,
  };
}

// Options the command never sets: they describe the input, the build or the computer, are
// derived from other options, or are rewritten by the muxer.
const X264_REPRO_SKIP = { threads: 1, lookahead_threads: 1, rc: 1, psy: 1 };
const X265_REPRO_SKIP = {
  cpuid: 1, 'frame-threads': 1, 'numa-pools': 1, pmode: 1, pme: 1, psnr: 1, ssim: 1, 'log-level': 1, csv: 1, 'csv-log-level': 1, bitdepth: 1, 'input-csp': 1,
  fps: 1, 'input-res': 1, 'total-frames': 1, rc: 1, 'stats-write': 1, 'stats-read': 1, 'repeat-headers': 1, annexb: 1, 'lookahead-slices': 1,
  'selective-sao': 1, 'conformance-window-offsets': 1, 'zone-count': 1, 'copy-pic': 1, 'max-luma': 1, 'min-luma': 1, 'chromaloc-top': 1, 'chromaloc-bottom': 1,
  'scenecut-bias': 1, 'high-tier': 1, cplxblur: 1, qblur: 1, 'slow-firstpass': 1, 'min-vbv-fullness': 1, 'max-vbv-fullness': 1,
};
/** x265 defaults of the options outside the preset tables (as printed), to tell what was changed. */
const X265_OTHER_DEFAULTS = {
  'open-gop': '1', 'gop-lookahead': '0', 'bframe-bias': '0', radl: '0', splice: '0', 'intra-refresh': '0', 'temporal-layers': '0', hme: '0',
  'analyze-src-pics': '0', 'dynamic-rd': '0.00', 'ssim-rd': '0', 'nr-intra': '0', 'nr-inter': '0', 'constrained-intra': '0',
  'strong-intra-smoothing': '1', 'temporal-mvp': '1', 'frame-dup': '0', 'tskip-fast': '0', 'cu-lossless': '0', 'splitrd-skip': '0', rdpenalty: '0',
  'rd-refine': '0', lossless: '0', cbqpoffs: '0', crqpoffs: '0', qcomp: '0.60', qpmax: '69', qpmin: '0', 'strict-cbr': '0', 'hevc-aq': '0',
  'qp-adaptation-range': '1.00', 'aq-motion': '0', 'sao-non-deblock': '0', 'limit-sao': '0', 'lowpass-dct': '0', mcstf: '0', sar: '0', overscan: '0',
  videoformat: '5', range: '0', colorprim: '2', transfer: '2', colormatrix: '2', chromaloc: '0', 'display-window': '0', cll: '0,0', hdr10: '0',
  'hdr10-opt': '0', 'dhdr10-opt': '0', aud: '0', eob: '0', eos: '0', hrd: '0', info: '1', hash: '0', slices: '1', 'vui-timing-info': '1',
  'vui-hrd-info': '1', 'log2-max-poc-lsb': '8', 'opt-qp-pps': '0', 'opt-ref-list-length-pps': '0', 'multi-pass-opt-rps': '0', 'opt-cu-delta-qp': '0',
  'idr-recovery-sei': '0', 'single-sei': '0', 'level-idc': '0', 'uhd-bd': '0', 'allow-non-conformance': '0', wpp: '1', interlace: '0', field: '0',
  'hist-scenecut': '0', 'scenecut-aware-qp': '0', sbrc: '0', 'frame-rc': '0', 'vbv-live-multi-pass': '0', 'decoder-max-rate': '0', 'max-ausize-factor': '1.0',
  'analysis-reuse-level': '0', 'analysis-save-reuse-level': '0', 'analysis-load-reuse-level': '0', 'scale-factor': '0', 'refine-intra': '0',
  'refine-inter': '0', 'refine-mv': '1', 'refine-ctu-distortion': '0', 'ctu-info': '0', 'refine-analysis-type': '0', 'dynamic-refine': '0', svt: '0',
  'max-tu-size': '32',
};

/** x264 defaults of options outside the preset tables. */
const X264_OTHER_DEFAULTS = {
  chroma_me: '1', cqm: '0', nr: '0', interlaced: '0', bluray_compat: '0', constrained_intra: '0', b_bias: '0', open_gop: '0',
  intra_refresh: '0', qpmin: '0', qpstep: '4', ratetol: '1.0', nal_hrd: 'none', filler: '0', crf_max: '0.0', cplxblur: '20.0', qblur: '0.5',
  sliced_threads: '0', stitchable: undefined, opencl: undefined,
};

function differsFromDefault(encoder, o, exp, table) {
  if (!table[o.key]) return true;
  const defs = encoder === 'x265' ? X265_OTHER_DEFAULTS : X264_OTHER_DEFAULTS;
  if (o.key in exp) return !sameValue(o.key, o.value, exp[o.key]);
  if (o.key in defs) return defs[o.key] !== undefined && !sameValue(o.key, o.value, defs[o.key]);
  if (encoder === 'x264' && o.key === 'qpmax') return !['69', '81'].includes(o.value);
  return false;
}

/** x264 options that differ from the preset, as -x264-params (param names from x264_param_parse). */
function x264Params(parsed, exp, param, used) {
  const g = parsed.get;
  const T = X264_OPTIONS;
  const t = (k, v) => `${T[k]?.name ?? k}\n${T[k]?.what ?? ''}\nThis file: ${v}.`;
  const diff = (k) => parsed.has(k) && exp[k] !== undefined && !sameValue(k, g(k), exp[k]);
  const set = (k, name, value) => param(name, value, t(k, g(k)), k);
  for (const k of ['cabac', 'trellis', '8x8dct', 'fast_pskip', 'weightb', 'weightp', 'mbtree', 'decimate', 'subme', 'me']) {
    used.add(k);
    if (diff(k)) set(k, { '8x8dct': '8x8dct', fast_pskip: 'fast-pskip', decimate: 'dct-decimate' }[k] ?? k, g(k));
  }
  used.add('mixed_ref');
  if (diff('mixed_ref') && Number(g('ref')) > 1) set('mixed_ref', 'mixed-refs', g('mixed_ref'));
  used.add('me_range');
  if (diff('me_range')) set('me_range', 'merange', g('me_range'));
  used.add('analyse');
  if (diff('analyse')) {
    const inter = g('analyse').split(':')[1] ?? '0';
    set('analyse', 'partitions', x264Partitions(inter));
  }
  used.add('deblock');
  if (diff('deblock')) {
    const [on, a, b] = g('deblock').split(':');
    if (on === '0') set('deblock', 'no-deblock', '1');
    else set('deblock', 'deblock', `${a},${b}`); // ':' would end the key=value pair
  }
  used.add('psy').add('psy_rd');
  if (parsed.has('psy') && g('psy') !== String(exp.psy)) set('psy', 'psy', g('psy'));
  if (g('psy') === '1' && diff('psy_rd')) set('psy_rd', 'psy-rd', g('psy_rd').replace(':', ','));
  used.add('aq');
  if (diff('aq')) {
    const [m, s] = g('aq').split(':');
    if (m === '0') set('aq', 'aq-mode', '0');
    else if (m === '1' && Number(s) === 0 && g('mbtree') === '1') set('aq', 'aq-strength', '0');
    else {
      set('aq', 'aq-mode', m);
      if (s !== undefined) param('aq-strength', s, t('aq', g('aq')), 'aq');
    }
  }
  used.add('deadzone');
  if (diff('deadzone')) {
    const [inter, intra] = g('deadzone').split(',');
    set('deadzone', 'deadzone-inter', inter);
    param('deadzone-intra', intra, t('deadzone', g('deadzone')), 'deadzone');
  }
  for (const [k, name] of [['b_pyramid', 'b-pyramid'], ['b_adapt', 'b-adapt'], ['direct', 'direct'], ['qcomp', 'qcomp'], ['ip_ratio', 'ipratio'], ['pb_ratio', 'pbratio'], ['sliced_threads', 'sliced-threads']]) {
    used.add(k);
    if (diff(k)) {
      const v = k === 'direct' ? { 0: 'none', 1: 'spatial', 2: 'temporal', 3: 'auto' }[g(k)] : k === 'b_pyramid' ? { 0: 'none', 1: 'strict', 2: 'normal' }[g(k)] : g(k);
      set(k, name, v);
    }
  }
  used.add('rc_lookahead');
  if (diff('rc_lookahead')) set('rc_lookahead', 'rc-lookahead', g('rc_lookahead'));
  used.add('chroma_qp_offset');
  if (diff('chroma_qp_offset')) {
    // the value to pass is before x264's own psy adjustment
    const raw = Number(g('chroma_qp_offset')) - Number(exp.chroma_qp_offset);
    if (raw) param('chroma-qp-offset', String(raw), `${T.chroma_qp_offset.name}\n${T.chroma_qp_offset.what}\nThis file: ${g('chroma_qp_offset')} after x264's adjustment of ${exp.chroma_qp_offset}, so the setting was ${raw}.`, 'chroma_qp_offset');
  }
  // options outside the presets: set when they differ from x264's defaults
  const other = [
    ['open_gop', 'open-gop'], ['b_bias', 'b-bias'], ['intra_refresh', 'intra-refresh'], ['chroma_me', 'chroma-me'], ['nr', 'nr'],
    ['constrained_intra', 'constrained-intra'], ['bluray_compat', 'bluray-compat'], ['qpmin', 'qpmin'], ['qpstep', 'qpstep'],
    ['ratetol', 'ratetol'], ['nal_hrd', 'nal-hrd'], ['filler', 'filler'], ['cplxblur', 'cplxblur'], ['qblur', 'qblur'],
    ['stitchable', 'stitchable'], ['opencl', 'opencl'],
  ];
  for (const [k, name] of other) {
    used.add(k);
    if (parsed.has(k) && X264_OTHER_DEFAULTS[k] !== undefined && !sameValue(k, g(k), X264_OTHER_DEFAULTS[k])) set(k, name, g(k));
    else if (parsed.has(k) && X264_OTHER_DEFAULTS[k] === undefined && g(k) !== '0') set(k, name, g(k));
  }
  used.add('qpmax');
  if (parsed.has('qpmax') && !['69', '81'].includes(g('qpmax'))) set('qpmax', 'qpmax', g('qpmax'));
  used.add('cqm');
  if (g('cqm') === '1') set('cqm', 'cqm', 'jvt');
  used.add('interlaced');
  if (g('interlaced') === 'tff' || g('interlaced') === 'bff') set('interlaced', g('interlaced'), '1');
  else if (g('interlaced') === 'fake') set('interlaced', 'fake-interlaced', '1');
  used.add('slices');
  if (parsed.has('slices') && g('sliced_threads') !== '1') set('slices', 'slices', g('slices'));
  for (const [k, name] of [['slices_max', 'slices-max'], ['slice_max_size', 'slice-max-size'], ['slice_max_mbs', 'slice-max-mbs'], ['slice_min_mbs', 'slice-min-mbs'], ['crop_rect', 'crop-rect'], ['mastering-display', 'mastering-display'], ['cll', 'cll'], ['frame-packing', 'frame-packing'], ['zones', 'zones']]) {
    used.add(k);
    if (parsed.has(k) && !(k === 'zones' && g(k) === '1')) set(k, name, g(k));
  }
}

/** x265 options that differ from the preset or from x265's defaults, as -x265-params. */
function x265Params(parsed, exp, param, used) {
  const g = parsed.get;
  const T = X265_OPTIONS;
  const t = (k, v) => `${T[k]?.name ?? k}\n${T[k]?.what ?? ''}\nThis file: ${v}.`;
  const set = (k, name, value) => param(name, value, t(k, g(k)), k);
  for (const k of X265_PRESET_KEYS) {
    if (k === 'bframes' || k === 'ref') continue;
    used.add(k);
    if (!parsed.has(k) || exp[k] === undefined || sameValue(k, g(k), exp[k])) continue;
    // x265 accepts the printed values back, and its adjustments leave them unchanged
    if (k === 'deblock') set(k, g(k) === '0' ? 'no-deblock' : 'deblock', g(k) === '0' ? '1' : g(k).replace(':', ','));
    else set(k, k, g(k));
  }
  // rskip is printed as on/off; mode 2 (edge density) shows as an extra rskip-edge-threshold
  used.add('rskip-edge-threshold');
  if (parsed.has('rskip-edge-threshold')) {
    set('rskip', 'rskip', '2');
    const pct = Math.round(Number(g('rskip-edge-threshold')) * 100);
    if (pct !== 5) param('rskip-edge-threshold', String(pct), t('rskip-edge-threshold', g('rskip-edge-threshold')), 'rskip-edge-threshold');
  }
  // colour and HDR
  for (const k of ['colorprim', 'transfer', 'colormatrix']) {
    used.add(k);
    if (parsed.has(k) && g(k) !== '2') set(k, k, g(k));
  }
  used.add('range');
  if (g('range') === '1') set('range', 'range', 'full');
  used.add('master-display');
  if (parsed.has('master-display')) set('master-display', 'master-display', g('master-display'));
  used.add('cll');
  if (parsed.has('cll') && g('cll') !== '0,0') set('cll', 'max-cll', g('cll'));
  used.add('chromaloc');
  if (g('chromaloc') === '1' && parsed.has('chromaloc-top')) set('chromaloc', 'chromaloc', g('chromaloc-top'));
  // square pixels (sar 1) are what FFmpeg passes for ordinary input anyway
  used.add('sar').add('sar-width:sar-height');
  if (parsed.has('sar') && !['0', '1', '255'].includes(g('sar'))) set('sar', 'sar', g('sar'));
  else if (g('sar') === '255' && parsed.has('sar-width:sar-height')) param('sar', g('sar-width:sar-height'), t('sar', g('sar-width:sar-height')), 'sar');
  used.add('display-window');
  if (parsed.has('display-window') && g('display-window') !== '0') set('display-window', 'display-window', g('display-window'));
  // everything else x265-params can set, when it differs from x265's defaults
  const settable = [
    'open-gop', 'gop-lookahead', 'bframe-bias', 'radl', 'intra-refresh', 'temporal-layers', 'hme', 'hme-search', 'hme-range', 'analyze-src-pics',
    'dynamic-rd', 'ssim-rd', 'nr-intra', 'nr-inter', 'constrained-intra', 'strong-intra-smoothing', 'temporal-mvp', 'frame-dup', 'tskip-fast',
    'cu-lossless', 'splitrd-skip', 'rdpenalty', 'rd-refine', 'lossless', 'qcomp', 'qpmax', 'qpmin', 'strict-cbr', 'hevc-aq', 'qp-adaptation-range',
    'aq-motion', 'sao-non-deblock', 'limit-sao', 'lowpass-dct', 'mcstf', 'videoformat', 'hdr10', 'hdr10-opt', 'dhdr10-opt', 'aud', 'eob', 'eos', 'hrd',
    'info', 'hash', 'slices', 'vui-timing-info', 'vui-hrd-info', 'opt-qp-pps', 'opt-ref-list-length-pps', 'multi-pass-opt-rps', 'opt-cu-delta-qp',
    'idr-recovery-sei', 'single-sei', 'uhd-bd', 'allow-non-conformance', 'wpp', 'field', 'hist-scenecut', 'scenecut-aware-qp', 'sbrc', 'max-tu-size',
    'log2-max-poc-lsb', 'max-ausize-factor', 'dup-threshold', 'vbv-end', 'vbv-end-fr-adj', 'splice',
  ];
  for (const k of settable) {
    used.add(k);
    if (!parsed.has(k) || k in exp) continue;
    const def = X265_OTHER_DEFAULTS[k];
    if (def === undefined ? g(k) === '0' : sameValue(k, g(k), def)) continue;
    if (k === 'dup-threshold' && g('frame-dup') !== '1') continue;
    set(k, k === 'splice' ? 'hrd-concat' : k, g(k));
  }
  // chroma QP offsets: x265 sets 6 by itself for 4:4:4 with psy-rd
  for (const k of ['cbqpoffs', 'crqpoffs']) {
    used.add(k);
    const auto = g('input-csp') === '3' && Number(g('psy-rd')) > 0 && g('cbqpoffs') === '6' && g('crqpoffs') === '6';
    if (parsed.has(k) && g(k) !== '0' && !auto) set(k, k, g(k));
  }
  // a forced level (with its tier)
  used.add('level-idc').add('high-tier');
  if (parsed.has('level-idc') && g('level-idc') !== '0') {
    set('level-idc', 'level-idc', g('level-idc'));
    set('high-tier', 'high-tier', g('high-tier'));
  }
  used.add('zones');
  if (parsed.has('zones')) set('zones', 'zones', g('zones'));
  used.add('interlace');
  if (parsed.has('interlace') && g('interlace') !== '0') set('interlace', 'interlace', g('interlace') === '2' ? 'bff' : 'tff');
}
