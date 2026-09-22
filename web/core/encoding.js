// Encoding findings shared by every container: the x264/x265 settings of the first frame
// explained, the rate control, a command that reproduces the encode, the codec level check and
// bits per pixel. The File insights tab merges these with the format's own insights().
//
// Everything is read from doc.tracks (the SPS and codec configuration each format attaches,
// its frame table, frame rate and bitrate) and from doc.detailAt() for the first frame's SEI, so
// no format needs code of its own.

import { fmtInt, fmtNum, fmtBitrate } from './util.js';
import { codecFamily } from '../codecs/index.js';
import { profileName as avcProfileName } from '../codecs/h264.js';
import { PROFILES as HEVC_PROFILES } from '../codecs/h265.js';
import { parseX26x, explainOptions, rateControl, reproduceCommand, CATEGORIES } from '../codecs/encoders.js';
import { checkLevel, peakBitrate } from '../codecs/levels.js';

const AV1_PROFILES = { 0: 'Main', 1: 'High', 2: 'Professional' };

/** Insights for the Encoding group of every video track. */
export async function encodingInsights(doc) {
  const out = [];
  const videos = doc.tracks.filter((t) => t.kind === 'video');
  for (const t of videos) {
    // Frame tables that need a full scan are not there yet: the view re-renders when they are.
    if (doc.loadSamples && !t.samples) continue;
    const v = videoInfo(doc, t);
    const name = videos.length > 1 ? `${t.label}: ` : '';
    try {
      const sei = await encoderSei(doc, t, v);
      if (sei) out.push(...settingsInsights(doc, t, v, sei, name));
    } catch (e) {
      console.error(e);
    }
    const lvl = levelInsight(t, v);
    if (lvl) out.push(lvl);
    const bpp = bppInsight(t, v, name);
    if (bpp) out.push(bpp);
  }
  return out;
}

// ------------------------------------------------------------------ what the tracks tell

/** The numbers of a video track, whatever the container. */
export function videoInfo(doc, t) {
  const props = Object.fromEntries(t.props ?? []);
  const sps = t.sps ?? null;
  const cs = t.codecString ?? '';
  let family = t.sampleCfg?.family || t.family || t.codecInfo?.family || codecFamily(t.codec) || codecFamily(t.fourcc) || null;
  if (!family) family = /^av01\./.test(cs) ? 'av1' : /^vp09\./.test(cs) ? 'vp9' : /^(avc[1-4])\./.test(cs) ? 'avc' : /^(hvc|hev)1\./.test(cs) ? 'hevc' : null;
  const v = { family, sps, props, codecString: cs || null };
  // picture size: the SPS knows best, then the container
  const size = /(\d+)\s*×\s*(\d+)/.exec(props['coded size'] ?? '');
  v.width = sps?.width ?? (size ? Number(size[1]) : null);
  v.height = sps?.height ?? (size ? Number(size[2]) : null);
  v.codedWidth = sps?.coded_width ?? v.width;
  v.codedHeight = sps?.coded_height ?? v.height;
  // frame rate: measured by the container, else declared
  const s = t.samples;
  let fps = Number.isFinite(t.fps) && t.fps > 0 ? t.fps : null;
  if (!fps && s?.count > 1 && t.duration > 0) fps = s.count / t.duration;
  if (!fps) {
    const fr = /([\d.]+)\s*fps/.exec(props['frame rate'] ?? '');
    if (fr) fps = Number(fr[1]);
  }
  if (!fps && sps?.vui?.fps) fps = sps.vui.fps;
  v.fps = fps || null;
  v.bitrate = t.bitrate > 0 ? t.bitrate : null;
  v.duration = t.duration ?? null;
  v.frames = frameTimes(t, v.fps);
  // profile and level: from the SPS, else from the codec string
  if (family === 'avc') {
    const m = /^avc[1-4]\.([0-9A-F]{2})([0-9A-F]{2})([0-9A-F]{2})$/i.exec(cs);
    const [profile, compat, level] = sps ? [sps.profile_idc, sps.compat, sps.level_idc] : m ? [1, 2, 3].map((i) => parseInt(m[i], 16)) : [];
    if (profile !== undefined) {
      Object.assign(v, { profile, level, constraintSet3: !!(compat & 0x10), refs: sps?.max_num_ref_frames, dpb: sps?.vui?.max_dec_frame_buffering });
      v.profileName = `${avcProfileName(profile, compat)} profile`;
    }
  } else if (family === 'hevc') {
    const m = /^(?:hvc1|hev1)\.[A-C]?(\d+)\.[0-9A-F]+\.([LH])(\d+)/i.exec(cs);
    const [profile, tier, level] = sps ? [sps.profile_idc, sps.tier ? 1 : 0, sps.level_idc] : m ? [Number(m[1]), m[2].toUpperCase() === 'H' ? 1 : 0, Number(m[3])] : [];
    if (profile !== undefined) {
      Object.assign(v, { profile, level, tier, dpb: sps?.max_dec_pic_buffering });
      v.profileName = `${HEVC_PROFILES[profile] ?? profile} profile`;
    }
  } else if (family === 'av1') {
    const m = /^av01\.(\d)\.(\d\d)([MH])\.(\d\d)/.exec(cs);
    if (m) Object.assign(v, { profile: Number(m[1]), level: Number(m[2]), tier: m[3] === 'H' ? 1 : 0, depth: Number(m[4]) });
    v.profileName = v.profile !== undefined ? `${AV1_PROFILES[v.profile] ?? v.profile} profile` : null;
  } else if (family === 'vp9') {
    const m = /^vp09\.(\d\d)\.(\d\d)\.(\d\d)/.exec(cs);
    if (m) Object.assign(v, { profile: Number(m[1]), level: Number(m[2]), depth: Number(m[3]) });
    v.profileName = v.profile !== undefined ? `Profile ${v.profile}` : null;
  }
  if (sps) {
    v.depth = sps.bit_depth_luma;
    v.chroma = sps.chroma_format_idc;
  }
  return v;
}

/** Frame sizes (bytes) and decode times (seconds, never decreasing), in decode order. */
function frameTimes(t, fps) {
  const s = t.samples;
  if (!s?.count || !s.sizes) return null;
  const ts = s.timescale || t.timescale || 0;
  const n = s.count;
  const times = new Float64Array(n);
  let prev = -Infinity;
  for (let i = 0; i < n; i++) {
    let x = ts && s.dts ? s.dts[i] / ts : NaN;
    if (!Number.isFinite(x)) x = i && Number.isFinite(prev) ? prev + 1 / (fps || 25) : i / (fps || 25);
    if (x < prev) x = prev;
    times[i] = x;
    prev = x;
  }
  return { sizes: s.sizes, times };
}

// ------------------------------------------------------------------ encoder settings

function findField(fields, name) {
  for (const f of fields ?? []) {
    if (f.name === name) return f;
    const x = findField(f.children, name);
    if (x) return x;
  }
  return null;
}

const isEncoderText = (f) => f && typeof f.value === 'string' && /options:/.test(f.value) && /x26[45]/.test(f.value);

/** Nodes and their descendants (to a small depth), for fields decoded inside a configuration record. */
function* nodesBelow(n, depth = 6) {
  if (!n) return;
  yield n;
  if (depth) for (const c of n.children ?? []) yield* nodesBelow(c, depth - 1);
}

/**
 * The x264/x265 SEI text. With global headers (MP4, Matroska, FLV) x265 puts it in the codec
 * configuration record next to the parameter sets; x264, and x265 in MPEG-TS, put it in the first
 * frame, which every format decodes through detailAt().
 */
export async function encoderSei(doc, t, v = videoInfo(doc, t)) {
  if (v.family !== 'avc' && v.family !== 'hevc') return null;
  for (const top of [t.entryNode, t.cpNode, t.node]) {
    for (const n of nodesBelow(top)) {
      const f = findField(n.fields, 'user_data_payload');
      if (isEncoderText(f)) return { text: f.value, offset: f.offset, where: `the codec configuration (${n.type})` };
    }
  }
  const s = t.samples;
  if (!s?.count || !s.offsets) return null;
  const tries = [0];
  const firstKey = s.key ? s.key.indexOf(1) : -1;
  if (firstKey > 0) tries.push(firstKey);
  for (const i of tries) {
    const d = await doc.detailAt(s.offsets[i]).catch(() => null);
    for (const u of d?.units ?? []) {
      const f = findField(u.fields, 'user_data_payload');
      if (isEncoderText(f)) return { text: f.value, offset: f.offset ?? u.offset, where: i ? `frame ${fmtInt(i + 1)} (the first key frame)` : 'the first frame' };
    }
  }
  return null;
}

const ENCODER_WHAT = {
  x264: 'x264 is the most widely used H.264 encoder (it is FFmpeg\'s libx264).',
  x265: 'x265 is a widely used HEVC encoder (it is FFmpeg\'s libx265).',
};

function settingsInsights(doc, t, v, sei, name) {
  const parsed = parseX26x(sei.text);
  if (!parsed.encoder || !parsed.options.length) return [];
  const out = [];
  const enc = parsed.encoder;
  const rows = explainOptions(parsed, { fps: v.fps });
  const essential = rows.filter((r) => r.essential).length;
  const where = sei.where;
  out.push({
    level: 'info',
    group: 'Encoding',
    title: `${name}Encoder settings: ${parsed.label}`,
    tip: `${ENCODER_WHAT[enc]}\nIt wrote its version and every option it ran with into an SEI message (supplemental enhancement information: side data a decoder does not need) in ${where}.`,
    text: `${enc} stored its version and all ${fmtInt(rows.length)} options it ran with as text inside ${where}. Each row explains one; click a row for what it does, what this file's value means, the trade-off and how to set it with FFmpeg.`,
    beginner: `An encoder is the program that compressed this video. Its options balance picture quality, file size and encoding speed. Beginner mode shows the ${essential} essential options; Detailed mode shows all ${fmtInt(rows.length)}. "Show the SEI text" selects those bytes in the hex view, where you can read them.`,
    facts: [
      ['encoder', parsed.label, ENCODER_WHAT[enc]],
      parsed.version ? ['version', parsed.version, enc === 'x264' ? 'x264 counts versions by its API ("core") and source revision.' : 'The x265 release and its build number.'] : null,
      ['options', `${fmtInt(rows.length)} (${essential} essential)`, 'How many options the encoder recorded. The essential ones are shown in Beginner mode.'],
    ].filter(Boolean),
    rows: rows.map((r) => ({
      group: r.catName,
      k: r.key,
      ktip: `${r.name}\n${r.what}`,
      v: r.raw === r.key ? 'on' : r.raw.startsWith('no-') && r.value === '0' ? 'off' : r.value,
      vtip: r.meaning ? `${r.name}\nThis file: ${r.meaning}` : `${r.name}\n${r.generic ? 'Vidscope describes this option only in general terms: hover the name, or click the row.' : r.what}`,
      text: r.name,
      note: r.meaning,
      more: [
        ['What it does', r.what],
        r.meaning ? ['In this file', r.meaning] : null,
        r.tradeoff ? ['Trade-off', r.tradeoff] : null,
        r.ff ? ['With FFmpeg', r.ff, true] : null,
        r.machine ? ['Note', 'This describes the computer that encoded, not the video.'] : null,
      ].filter(Boolean),
      advanced: !r.essential,
    })),
    groupTips: Object.fromEntries(CATEGORIES.map(([, n, d]) => [n, d])),
    closed: enc === 'x265' ? [CATEGORIES.find(([id]) => id === 'misc')[1]] : [],
    offset: sei.offset,
    offsetLabel: 'show the SEI text',
  });

  const rc = rateControl(parsed, v.bitrate);
  if (rc) {
    const facts = rc.facts.slice();
    const peak = v.frames ? peakBitrate(v.frames.sizes, v.frames.times, 1) : null;
    if (peak && (rc.maxrate || rc.bitrate)) facts.push(['busiest second', fmtBitrate(peak), `The most data in any one second of this file${rc.maxrate ? `; VBV allows short peaks above ${fmtInt(rc.maxrate)} kbit/s as long as the buffer absorbs them` : ''}.`]);
    out.push({
      level: 'info',
      group: 'Encoding',
      title: `${name}Rate control: ${rc.short}`,
      tip: 'Rate control decides how many bits each frame gets, and so the balance between quality, file size and bandwidth.',
      text: rc.sentence,
      beginner: 'Rate control is how an encoder decides how many bits each frame gets. Constant quality (CRF) lets the file size follow the content; a bitrate target (ABR, CBR, two-pass) fixes the size instead; VBV caps short peaks so that a player\'s connection and buffer keep up. The glossary explains each term.',
      facts,
    });
  }

  const repro = reproduceCommand(parsed, { fps: v.fps, depth: v.depth, chroma: v.chroma, format: doc.format?.id });
  if (repro) {
    out.push({
      level: 'info',
      group: 'Encoding',
      title: `${name}Reproduce this encode with FFmpeg`,
      tip: 'An FFmpeg command that encodes a source with the same encoder settings. Hover any part of it to see what it does.',
      text: repro.notes[0],
      beginner: `FFmpeg is the free command-line tool most encoding runs through; ${enc === 'x264' ? 'libx264' : 'libx265'} is the ${enc} encoder inside it. A preset is a named bundle of speed-versus-compression settings. Hover any part of the command below to see what it does.`,
      list: repro.notes.slice(1),
      cmd: repro.cmd,
      cmdParts: repro.parts,
    });
  }
  return out;
}

// ------------------------------------------------------------------ level check

function levelName(v, res) {
  if (!res?.signalled) return null;
  return [v.profileName, res.signalled.tier ? `${res.signalled.tier} tier` : null, `level ${res.signalled.name}`].filter(Boolean).join(', ');
}

const LEVEL_WHAT = 'A level is a promise to the player: this stream never needs more than a given picture size, frame rate, bitrate and memory. Devices say which levels they can decode, so they can accept or refuse a stream before decoding it.';

function levelInsight(t, v) {
  if (!['avc', 'hevc', 'av1', 'vp9'].includes(v.family) || !v.codedWidth || !v.codedHeight) return null;
  const res = checkLevel({
    codec: v.family,
    width: v.family === 'avc' || v.family === 'hevc' ? v.codedWidth : v.width,
    height: v.family === 'avc' || v.family === 'hevc' ? v.codedHeight : v.height,
    fps: v.fps,
    bitrate: v.bitrate,
    frames: v.frames,
    profile: v.profile,
    level: v.level,
    tier: v.tier,
    constraintSet3: v.constraintSet3,
    refs: v.refs,
    dpb: v.dpb,
  });
  if (!res) return null;
  const lname = levelName(v, res);
  const lowest = res.lowest ? `level ${res.lowest.name}` : 'no level';
  const failed = res.limits.filter((l) => l.pass === false && !l.soft);
  let level = 'info';
  let title;
  let text;
  if (res.unconstrained) {
    title = `${t.label}: ${lname}, no level limits`; // AV1 level 31 / HEVC level 8.5
    text = res.notes.join(' ');
  } else if (res.signalled && res.pass === true) {
    level = 'good';
    title = `${t.label}: fits its level (${lname})`;
    text = `Every limit of ${res.name} level ${res.signalled.name} that Vidscope can measure holds.${res.lowest && res.lowest.name !== res.signalled.name ? ` The stream would also fit ${lowest}: it signals more than it needs, which is allowed, but players decide from the signalled level, so a device limited to ${lowest} may refuse it.` : ' It is also the lowest level the stream fits.'}`;
  } else if (res.signalled && res.pass === false) {
    level = 'bad';
    title = `${t.label}: breaks its level (${lname})`;
    text = `${failed.map((l) => l.label.toLowerCase()).join(', ')} ${failed.length === 1 ? 'is' : 'are'} above the limit of level ${res.signalled.name}. A player that trusts the level may stutter or fail. ${res.lowest ? `The lowest level that fits is ${res.lowest.name}.` : 'The stream fits no level of the table.'}`;
  } else {
    title = `${t.label}: no level signalled, fits ${lowest}`;
    text = `${res.notes.join(' ') || 'No level is signalled.'} ${res.lowest ? `The lowest level whose limits all hold is ${res.lowest.name}; the rows compare the stream with it.` : ''}`.trim();
  }
  const specOf = {
    avc: 'ITU-T H.264 Table A-1',
    hevc: 'ITU-T H.265 Tables A.8 and A.9',
    av1: 'AV1 specification, Annex A.3',
    vp9: 'WebM project VP9 levels',
  }[v.family];
  const facts = [];
  if (res.signalled) facts.push(['signalled', lname, `Where it is stored: ${v.family === 'avc' || v.family === 'hevc' ? 'the SPS (level_idc) and the codec configuration box' : v.family === 'av1' ? 'the sequence header (seq_level_idx) and the av1C configuration' : 'the vpcC or CodecPrivate configuration'}; it also appears in the codec string.`]);
  if (v.codecString) facts.push(['codec string', v.codecString, 'The RFC 6381 codec string (shown in the Tracks tab): players and manifests read the profile and level from it.']);
  facts.push(['lowest level that fits', res.lowest ? res.lowest.name : 'none', 'The lowest level whose limits all hold for this stream, checked in order from the smallest.']);
  if (res.notes.length && res.signalled && !res.unconstrained) facts.push(['note', res.notes.join(' '), null]);
  return {
    level,
    group: 'Encoding',
    title,
    tip: `${LEVEL_WHAT}\nLimits from ${specOf}.`,
    text,
    beginner: `${LEVEL_WHAT} A profile says which coding tools the stream may use; the level caps how demanding it is. Each row compares one limit with this file; hover a name, value or limit for more.`,
    facts,
    rows: res.limits.map((l) => ({
      k: l.label,
      ktip: l.text,
      v: l.display,
      vtip: `${l.label} of this file${['rate', 'peak', 'bitrate', 'buffer', 'cpb'].includes(l.id) ? ', measured from its frame table' : ''}.${l.pass === false ? l.soft ? ' Above the limit for a moment: allowed if the buffer absorbs it.' : ' Above the limit.' : l.pass ? ' Within the limit.' : ''}`,
      limit: l.max === null || l.max === undefined ? l.maxDisplay : `≤ ${l.maxDisplay}`,
      ltip: res.against ? `The limit of level ${res.against}, the lowest level this stream fits (${specOf}).` : `The limit of level ${res.signalled?.name ?? '?'} (${specOf}).`,
      status: l.pass === null ? null : l.pass ? 'good' : l.soft ? 'warn' : 'bad',
      note: l.text,
      advanced: !!l.advanced,
    })),
    node: t.node,
  };
}

// ------------------------------------------------------------------ bits per pixel

function bppInsight(t, v, name) {
  if (!v.bitrate || !v.width || !v.height || !v.fps) return null;
  const pps = v.width * v.height * v.fps;
  const bpp = v.bitrate / pps;
  const perFrame = v.bitrate / v.fps / 8;
  return {
    level: 'info',
    group: 'Encoding',
    title: `${name}${fmtNum(bpp, bpp < 0.1 ? 3 : 2)} bits per pixel`,
    tip: 'Bits per pixel = bitrate ÷ (width × height × frame rate): the average number of bits spent on each pixel of each frame.',
    text: `On average the encoder spent ${fmtNum(bpp, 3)} bits on each pixel of each frame. Bits per pixel puts bitrates of different resolutions and frame rates on one scale, so encodes of similar content can be compared.`,
    beginner: 'It is not a quality score. Newer codecs such as HEVC and AV1 need fewer bits than H.264 for a similar picture; larger frames usually need fewer bits per pixel, because detail spreads over more pixels and neighbouring pixels are more alike; and fast motion, film grain and fine texture cost far more bits than a static talking head or animation. Compare it between encodes of the same kind of content, codec and resolution.',
    facts: [
      ['video bitrate', fmtBitrate(v.bitrate), 'The video track\'s bytes × 8 ÷ its duration.'],
      ['picture size', `${v.width} × ${v.height}`, 'The displayed size in pixels (after any cropping).'],
      ['frame rate', `${fmtNum(v.fps, 3)} fps`, 'Frames per second, measured from the frame timestamps where possible.'],
      ['pixels per second', fmtInt(Math.round(pps)), 'Width × height × frame rate: the number of pixels the encoder had to describe each second.'],
      ['average frame', `${fmtInt(Math.round(perFrame))} bytes`, 'Bitrate ÷ frame rate. Key frames are much larger and B-frames much smaller than this: the sample-size chart in the Tracks tab shows each frame.'],
      ['calculation', `${fmtInt(Math.round(v.bitrate))} ÷ (${v.width} × ${v.height} × ${fmtNum(v.fps, 3)}) = ${fmtNum(bpp, 4)}`, 'Bits per second divided by pixels per second.'],
    ],
    node: t.node,
  };
}

