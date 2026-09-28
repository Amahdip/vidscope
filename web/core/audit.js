// Audit: rules a delivery service can hold its outputs to, each with the standard it comes from,
// evaluated on what is in the file rather than on how it was made. A rule is { id, category,
// severity, spec, clause, applies(ctx), check(ctx) }; a check yields { level, title, text, value?,
// expected?, offset? } with level 'pass' | 'warn' | 'fail' | 'info' | 'skip'. Severity says what
// a failure means: 'critical' (viewers see or hear it, or playback fails on real devices, or a
// MUST is broken), 'warning' (a SHOULD, a quality or compatibility cost) or 'info'.
//
// Expectations (a fixed GOP, a sample rate, a loudness target) come from the caller, so the
// same rules serve any service; without them a rule checks only what the standards say.

import { summarize, videoCodecName, audioCodecName } from './compare.js';
import { videoInfo, encoderSei } from './encoding.js';
import { analyzeFrames } from './frames.js';
import { simulateVbv } from './bitrate.js';
import { parseX26x, rateControl } from '../codecs/encoders.js';
import { checkLevel } from '../codecs/levels.js';
import { fmtInt, fmtNum, fmtBitrate, fmtDuration, plural } from './util.js';
import { remedyFor } from './remedies.js';
import { redact } from './hls.js';
import { identify } from '../formats/raw/index.js';

/** Where each rule comes from. */
export const SPECS = {
  hlsAuth: { name: 'HLS Authoring Specification for Apple Devices', url: 'https://developer.apple.com/documentation/http-live-streaming/hls-authoring-specification-for-apple-devices' },
  rfc8216: { name: 'RFC 8216, HTTP Live Streaming', url: 'https://www.rfc-editor.org/rfc/rfc8216' },
  h264: { name: 'ITU-T H.264', url: 'https://www.itu.int/rec/T-REC-H.264' },
  h265: { name: 'ITU-T H.265', url: 'https://www.itu.int/rec/T-REC-H.265' },
  av1: { name: 'AV1 Bitstream & Decoding Process Specification', url: 'https://aomediacodec.github.io/av1-spec/' },
  vp9: { name: 'VP9 Bitstream & Decoding Process Specification', url: 'https://www.webmproject.org/vp9/' },
  h273: { name: 'ITU-T H.273, colour description', url: 'https://www.itu.int/rec/T-REC-H.273' },
  isobmff: { name: 'ISO/IEC 14496-12, ISO base media file format', url: 'https://www.iso.org/standard/83102.html' },
  cmaf: { name: 'ISO/IEC 23000-19, CMAF', url: 'https://www.iso.org/standard/85623.html' },
  priming: { name: 'Apple TN2258, AAC audio: encoder delay and synchronization', url: 'https://developer.apple.com/library/archive/technotes/tn2258/_index.html' },
  bt1359: { name: 'ITU-R BT.1359-1, relative timing of sound and vision', url: 'https://www.itu.int/rec/R-REC-BT.1359' },
  r128: { name: 'EBU R 128 (2023) and R 128 s2, loudness normalisation', url: 'https://tech.ebu.ch/publications/r128' },
  practice: { name: 'Common encoding practice, not a standard', url: 'https://streaminglearningcenter.com' },
};

/**
 * Expectations a service can set on its outputs. Everything is optional.
 *   gop: seconds between key frames (exact); gopMax: the longest allowed
 *   fpsMax, fpsMin: the frame-rate range; peakRatio: busiest segment ÷ average, at most
 *   colour: { primaries, transfer, matrix } expected in the VUI (1/1/1 for BT.709)
 *   audio: { required, codec: 'AAC LC', sampleRate, channelsMax, minBitratePerChannel }
 *   loudness: { integrated (LUFS), tolerance (LU), truePeakMax (dBTP) }, for measured loudness
 *   segments: segment lengths (s) the ladder must support
 *   overlay: { severity: { ruleId: 'critical'|'warning'|'info' }, levelCap: [{ height, fpsMax, level }] }:
 *     a service's own severities and its level cap per rendition (rule level-policy)
 */
export const DEFAULT_EXPECT = { peakRatio: 2, fpsMax: 60, segments: [2, 4, 5, 6, 10] };

// The colour description value that means "not signalled" (H.273 tables 2, 3 and 4).
const UNSPECIFIED = 2;
const HDR_TRANSFERS = { 16: 'PQ (HDR10)', 18: 'HLG' };

const RULES = [];
const LADDER_RULES = [];
const PLAYLIST_RULES = [];

/** Register a rule; returns it. Rules run in registration order. */
export function defineRule(def) {
  (def.scope === 'ladder' ? LADDER_RULES : def.scope === 'playlist' ? PLAYLIST_RULES : RULES).push(def);
  return def;
}

/** Every rule, for documentation and for a rule matrix. */
export function allRules() {
  return [...RULES, ...LADDER_RULES, ...PLAYLIST_RULES].map((r) => ({ id: r.id, scope: r.scope ?? 'file', category: r.category, severity: r.severity, spec: r.spec, clause: r.clause ?? null, title: r.title, remedy: remedyFor(r.id) }));
}

const pass = (title, text, extra) => ({ level: 'pass', title, text, ...extra });
const warn = (title, text, extra) => ({ level: 'warn', title, text, ...extra });
const fail = (title, text, extra) => ({ level: 'fail', title, text, ...extra });
const info = (title, text, extra) => ({ level: 'info', title, text, ...extra });

// ====================================================================== container

defineRule({
  id: 'fast-start', category: 'Container', severity: 'critical', spec: 'practice', clause: 'progressive download: the index (moov) before the media data, as ffmpeg -movflags +faststart writes it',
  title: 'The movie box comes before the media data',
  applies: (c) => c.mp4 && c.mp4.moov && c.mp4.mdat && !c.mp4.moof,
  check: (c) => {
    const { moov, mdat } = c.mp4;
    return moov.offset < mdat.offset
      ? pass('moov before mdat: playback can start while downloading', 'Progressive playback and on-the-fly packaging both need the index first.', { offset: moov.offset })
      : fail('moov after mdat: the whole file must arrive before playback starts', 'A player or packager reading over HTTP has to fetch the entire file before it can find the first frame.', { offset: moov.offset });
  },
});

defineRule({
  id: 'interleaved', category: 'Container', severity: 'warning', spec: 'practice', clause: 'progressive download: audio and video chunks interleaved',
  title: 'Audio and video chunks alternate',
  applies: (c) => !!c.insight(/^(Poorly interleaved|Interleaved)/),
  check: (c) => {
    const i = c.insight(/^(Poorly interleaved|Interleaved)/);
    return i.level === 'warn' ? warn(i.title, 'Chunks far apart force a player to read far ahead or to seek; remux to interleave.', { offset: i.offset }) : pass(i.title, 'A player needs no large read-ahead.');
  },
});

defineRule({
  id: 'edit-list', category: 'Container', severity: 'warning', spec: 'isobmff', clause: '§8.6.6 edit list box',
  title: 'Edit lists are simple',
  applies: (c) => c.insights.some((i) => /: \d+ edits$/.test(i.title)),
  check: (c) => {
    const e = c.insights.find((i) => /: \d+ edits$/.test(i.title));
    return warn(e.title, 'Edit lists with several entries are ignored or mishandled by many players and packagers.', { offset: e.node?.offset });
  },
});

defineRule({
  id: 'integrity', category: 'Container', severity: 'critical', spec: 'isobmff', clause: 'sample tables',
  title: 'The sample tables are consistent',
  applies: (c) => c.mp4 != null,
  check: (c) => {
    const bad = c.insights.filter((i) => i.level === 'bad');
    if (!bad.length) return pass('No structural problems', 'Every sample can be located and timed.');
    return fail(bad.map((b) => b.title).join('; '), bad[0].text?.split('. ')[0] ?? 'The index disagrees with the media.', { offset: bad[0].node?.offset ?? bad[0].offset });
  },
});

defineRule({
  id: 'one-video-track', category: 'Container', severity: 'critical', spec: 'practice', clause: 'one video track per rendition file',
  title: 'Exactly one video track',
  applies: () => true,
  check: (c) => (c.videos.length === 1 ? pass('One video track', 'As a rendition should.') : c.videos.length ? warn(`${c.videos.length} video tracks`, 'A rendition carries exactly one video track; players pick the first and ignore the rest.') : fail('No video track', 'Nothing to play.')),
});

defineRule({
  id: 'has-audio', category: 'Container', severity: 'critical', spec: 'practice', clause: 'audio in every rendition, when the service requires it',
  title: 'Audio is present',
  applies: (c) => c.audios.length === 0,
  check: (c) => (c.ex.audio?.required ? fail('No audio track', 'The service expects every rendition to carry audio.') : info('No audio track', 'A silent rendition; sources without sound produce these.')),
});

defineRule({
  id: 'track-durations', category: 'Container', severity: 'warning', spec: 'hlsAuth', clause: '8.3 audio and video cover the same duration (applied to the tracks of one file)',
  title: 'Video and audio are the same length',
  applies: (c) => c.v && c.a && c.v.duration > 0 && c.a.duration > 0,
  check: (c) => {
    const diff = Math.abs(c.v.duration - c.a.duration);
    const title = `Video and audio lengths differ by ${fmtNum(diff * 1000, 0)} ms`;
    if (diff <= 0.1) return pass(title, 'Within a frame or two.', { value: diff });
    return (diff <= 0.5 ? warn : fail)(title, 'Tracks of different lengths end playback early or leave silence; packagers may drop the tail.', { value: diff });
  },
});

// ====================================================================== video

defineRule({
  id: 'codec', category: 'Video', severity: 'critical', spec: 'hlsAuth', clause: '1.1 H.264, HEVC, Dolby Vision or AV1',
  title: 'An HLS video codec',
  applies: (c) => !!c.v,
  check: (c) => (['avc', 'hevc', 'av1'].includes(c.vi.family) ? pass(videoCodecName(c.it), c.vi.family === 'av1' ? 'An HLS codec for Apple devices, in fMP4, on devices that decode AV1.' : 'An HLS codec every Apple device decodes.') : fail(`${videoCodecName(c.it)}: not an HLS codec for Apple devices`, 'Apple devices play H.264, HEVC (and Dolby Vision) and AV1; other codecs need separate renditions.')),
});

defineRule({
  id: 'profile', category: 'Video', severity: 'critical', spec: 'hlsAuth', clause: '1.3b at most High Profile (MUST); 1.4 High in preference to Main or Baseline (SHOULD)',
  title: 'A supported H.264 profile',
  applies: (c) => c.vi.family === 'avc' && c.vi.profile !== undefined,
  check: (c) => {
    const p = c.vi.profile;
    if (p === 100) return pass(c.vi.profileName, 'High Profile, as Apple recommends.', { offset: c.entryOffset });
    if (p === 77 || p === 66) return warn(`${c.vi.profileName}: Apple recommends High`, 'Every device that decodes Main or Baseline also decodes High, and High compresses better (8×8 transforms, better entropy coding), so Apple asks for High in preference to Main or Baseline.', { offset: c.entryOffset });
    return fail(c.vi.profileName, 'Apple devices decode H.264 up to High Profile; High 10, 4:2:2 and 4:4:4 profiles are beyond it.', { offset: c.entryOffset });
  },
});

// Where each codec's level limits are written.
const LEVEL_SPEC = {
  avc: { spec: 'h264', clause: 'Annex A, Table A-1' },
  hevc: { spec: 'h265', clause: 'Annex A, Tables A.8 and A.9' },
  av1: { spec: 'av1', clause: 'Annex A.3 levels' },
  vp9: { spec: 'vp9', clause: 'Annex A levels' },
};

defineRule({
  id: 'level-holds', category: 'Video', severity: 'critical', spec: 'h264', clause: 'Annex A, Table A-1',
  title: 'The signalled level holds',
  applies: (c) => c.lvl?.signalled && !c.lvl.unconstrained,
  check: (c) => {
    const name = c.lvl.signalled.name;
    const where = LEVEL_SPEC[c.vi.family] ?? LEVEL_SPEC.avc;
    if (c.lvl.pass === false) {
      const over = c.lvl.limits.filter((l) => l.pass === false && !l.soft).map((l) => l.label.toLowerCase());
      return fail(`Breaks its level (${name}): ${over.join(', ')}`, 'A decoder that trusts the level may refuse the stream or drop frames.', { value: name, offset: c.entryOffset, ...where });
    }
    return pass(`Fits its level (${name})`, 'Every limit of the signalled level holds.', { value: name, ...where });
  },
});

defineRule({
  id: 'level-minimal', category: 'Video', severity: 'warning', spec: 'hlsAuth', clause: '1.11 no higher level than the resolution and frame rate need',
  title: 'The level is the lowest that fits',
  applies: (c) => c.lvl?.signalled && c.lvl.lowest && !c.lvl.unconstrained,
  check: (c) => {
    const name = c.lvl.signalled.name;
    const where = LEVEL_SPEC[c.vi.family] ?? LEVEL_SPEC.avc;
    if (c.lvl.lowest.name === name) return pass(`Level ${name} is the lowest that fits`, 'No device is shut out needlessly.', { value: name });
    return warn(`Level ${name} signalled, ${c.lvl.lowest.name} would do`, `Devices refuse streams above the level they decode; a higher level than needed shuts some out. The lowest level comes from ${where.clause ?? 'the level tables'}.`, { value: name, expected: c.lvl.lowest.name, offset: c.entryOffset });
  },
});

defineRule({
  id: 'level-policy', category: 'Video', severity: 'critical', spec: 'practice', clause: 'the service\'s level cap per rendition (device reach)',
  title: 'The level stays within the service\'s cap for the rendition',
  // overlay.levelCap: [{ height, fpsMax, level }] — the first entry whose height and fpsMax
  // cover the rendition sets its cap; a rendition no entry covers is not judged.
  applies: (c) => Array.isArray(c.ex.overlay?.levelCap) && c.lvl?.signalled && c.vi.height && c.it.fps,
  check: (c) => {
    const cap = c.ex.overlay.levelCap.find((e) => c.vi.height <= e.height && c.it.fps <= (e.fpsMax ?? Infinity) + 0.01);
    if (!cap) return null;
    const name = c.lvl.signalled.name;
    const over = Number(name) > Number(cap.level);
    return over
      ? fail(`Level ${name} at ${c.vi.height}p ${fmtNum(c.it.fps, 0)} fps, capped at ${cap.level}`, 'Above the level the service allows for this rendition: devices gated by level (the player\'s capability check) lose it.', { value: name, expected: `≤ ${cap.level}`, offset: c.entryOffset })
      : pass(`Level ${name} within the cap of ${cap.level} for ${c.vi.height}p ${fmtNum(c.it.fps, 0)} fps`, 'Within the service\'s device reach.', { value: name, expected: `≤ ${cap.level}` });
  },
});

defineRule({
  id: 'level-cap', category: 'Video', severity: 'critical', spec: 'hlsAuth', clause: '1.3b H.264 at most High Profile, Level 5.2',
  title: 'H.264 level at most 5.2',
  applies: (c) => c.vi.family === 'avc' && c.vi.level !== undefined,
  check: (c) => (c.vi.level <= 52 ? pass(`Level ${c.lvl?.signalled?.name ?? c.vi.level / 10}`, c.vi.level <= 41 ? 'Within Apple\'s limit (5.2), and within 4.1, the level Apple asks some variants to keep to for the widest reach.' : 'Within Apple\'s limit (5.2); keep some variants at 4.1 or below for the widest reach (see the ladder\'s levels).', { value: c.vi.level / 10 }) : fail(`Level ${c.vi.level / 10} is above 5.2`, 'Apple devices decode H.264 up to High Profile, Level 5.2.', { value: c.vi.level / 10, expected: '≤ 5.2', offset: c.entryOffset })),
});

defineRule({
  id: 'even-size', category: 'Video', severity: 'critical', spec: 'h264', clause: '7.4.2.1.1 frame cropping: 4:2:0 crops in steps of two samples',
  title: 'Even picture dimensions',
  applies: (c) => c.vi.width && c.vi.height,
  check: (c) => (c.vi.width % 2 === 0 && c.vi.height % 2 === 0 ? pass(`${c.vi.width}×${c.vi.height}`, 'Even dimensions, as 4:2:0 chroma requires.') : fail(`${c.vi.width}×${c.vi.height}: odd dimension`, 'Odd dimensions cannot be represented in 4:2:0 without cropping.')),
});

defineRule({
  id: 'square-pixels', category: 'Video', severity: 'warning', spec: 'practice', clause: 'square pixels (sample aspect 1:1) in streaming renditions',
  title: 'Square pixels',
  applies: (c) => Array.isArray(c.vi.sps?.vui?.sar),
  check: (c) => {
    const [w, h] = c.vi.sps.vui.sar;
    return w === h || !w || !h ? pass('Square pixels', 'Displayed as encoded.') : warn(`Pixel aspect ${w}:${h}`, 'Non-square pixels are mis-scaled by some players; scale to square pixels when encoding.', { value: `${w}:${h}`, offset: c.entryOffset });
  },
});

defineRule({
  id: 'fps-range', category: 'Video', severity: 'critical', spec: 'hlsAuth', clause: '1.19 no frame rate above 60 fps (SHALL NOT); the service\'s range',
  title: 'Frame rate within the ladder range',
  applies: (c) => !!c.it.fps,
  check: (c) => {
    const fps = c.it.fps;
    if (fps > 60.01) return fail(`${fmtNum(fps, 3)} fps, above 60`, 'Apple devices do not take frame rates above 60 fps.', { value: fps, expected: '≤ 60' });
    if (c.ex.fpsMax && fps > c.ex.fpsMax + 0.01) return warn(`${fmtNum(fps, 3)} fps, above ${c.ex.fpsMax}`, 'Frame rates above the ladder maximum cost bits and decoder capability for no visible gain.', { value: fps, expected: `≤ ${c.ex.fpsMax}` });
    if (c.ex.fpsMin && fps < c.ex.fpsMin) return warn(`${fmtNum(fps, 3)} fps, below ${c.ex.fpsMin}`, 'Very low frame rates play as a slideshow.', { value: fps, expected: `≥ ${c.ex.fpsMin}` });
    return pass(`${fmtNum(fps, 3)} fps`, 'Within the expected range.', { value: fps });
  },
});

defineRule({
  id: 'fps-constant', category: 'Video', severity: 'warning', spec: 'hlsAuth', clause: '1.18 frame rates; 8.14 a frame-rate change MUST be marked as a discontinuity',
  title: 'Constant frame rate',
  applies: (c) => !!c.v && c.v.vfr !== undefined,
  check: (c) => (c.v.vfr ? warn('Variable frame rate', 'Renditions should have a constant frame rate; variable timing breaks segment alignment and the FRAME-RATE attribute.') : pass('Constant frame rate', 'Every frame lasts the same time.')),
});

defineRule({
  id: 'gop-fixed', category: 'Video', severity: 'warning', spec: 'hlsAuth', clause: '7.4 segments start with an IDR; 7.6 segments of a nominal duration',
  title: 'A fixed key-frame interval',
  applies: (c) => c.gop && c.gop.count >= 2,
  check: (c) => {
    const g = c.gop;
    const sh = c.gopShape;
    // Key-frame positions come from the sample tables, whatever the payload budget.
    const every = `Key frame every ${fmtInt(sh.frames)} frames (${fmtNum(sh.seconds, 2)} s)`;
    if (!sh.odd.length) return pass(every, 'Segments of equal length can be cut at every key frame.', { value: sh.seconds });
    // A few GOPs cut short, each followed by the usual interval again, is what an encoder
    // restart leaves (a join between the chunks of a chunked encode) or a forced key frame;
    // many GOPs of other lengths is an interval that is not fixed at all.
    const few = sh.odd.length <= Math.max(2, Math.ceil(0.05 * sh.count)) && sh.odd.every((o) => o.frames < sh.frames);
    return few
      ? info(`${every}, except ${plural(sh.odd.length, 'shorter GOP')} (${listAt(sh.odd)})`, 'A GOP cut short and then the usual interval again is what an encoder restart leaves, such as a join between the chunks of a chunked encode, or a forced key frame. Players do not mind, but the key frames after it are off the grid, so a segment there runs long (see the ladder\'s segment check).', { value: sh.odd.map((o) => round3(o.seconds)), offset: c.v.samples.offsets[sh.odd[0].start] })
      : warn(`Key-frame interval varies: ${fmtNum(g.minSeconds, 2)}–${fmtNum(g.maxSeconds, 2)} s, ${sh.odd.length} of ${sh.count} GOPs differ from ${fmtNum(sh.seconds, 2)} s`, 'Uneven intervals give uneven segments and break alignment across renditions.', { value: [g.minSeconds, g.maxSeconds], offset: c.gopOffset(g.maxSeconds) });
  },
});

defineRule({
  id: 'gop-length', category: 'Video', severity: 'warning', spec: 'hlsAuth', clause: '1.13 key frames (IDRs) every two seconds',
  title: 'The key-frame interval the service intends',
  applies: (c) => c.gop && c.gop.count >= 2,
  check: (c) => {
    // The usual interval: a few short GOPs (chunk joins) would pull an average below it.
    const sec = c.gopShape.seconds;
    if (c.ex.gop) {
      const off = Math.abs(sec - c.ex.gop);
      return (off <= 0.05 ? pass : fail)(`Key-frame interval ${fmtNum(sec, 3)} s, expected ${c.ex.gop} s`, off <= 0.05 ? 'As the service intends.' : 'The interval does not match the ladder contract.', { value: sec, expected: c.ex.gop });
    }
    if (sec > 2.05) return warn(`Key-frame interval ${fmtNum(sec, 2)} s, Apple recommends 2 s`, 'Apple asks for a key frame every 2 s so that 6 s segments can be cut and switching stays quick; longer intervals mean longer segments and slower start-up.', { value: sec, expected: 2 });
    return pass(`Key-frame interval ${fmtNum(sec, 2)} s`, 'Within Apple\'s recommendation.', { value: sec });
  },
});

defineRule({
  id: 'gop-max', category: 'Video', severity: 'critical', spec: 'hlsAuth', clause: '7.4 segments start with an IDR; 7.7 no segment more than 0.5 s over the target duration',
  title: 'No key-frame interval longer than allowed',
  applies: (c) => c.gop && c.gop.count >= 2 && c.ex.gopMax,
  check: (c) => (c.gop.maxSeconds <= c.ex.gopMax + 0.05 ? pass(`Longest interval ${fmtNum(c.gop.maxSeconds, 2)} s`, 'Every segment can be cut on time.', { value: c.gop.maxSeconds }) : fail(`Longest key-frame interval ${fmtNum(c.gop.maxSeconds, 2)} s, allowed ${c.ex.gopMax} s`, 'A packager cannot cut a segment inside a GOP.', { value: c.gop.maxSeconds, expected: c.ex.gopMax, offset: c.gopOffset(c.gop.maxSeconds) })),
});

defineRule({
  id: 'closed-gop', category: 'Video', severity: 'warning', spec: 'rfc8216', clause: '§3 a segment decodes on its own (H.264: SHOULD contain an IDR)',
  title: 'Closed GOPs',
  applies: (c) => c.an?.classified > 0 && c.gop && c.gop.count >= 1,
  check: (c) => (c.gop.open ? warn(`${plural(c.gop.open, 'open GOP')}${c.sampled}`, 'Frames after a key frame reference the previous GOP, so a segment cut there cannot be decoded on its own.', { value: c.gop.open }) : pass(`Closed GOPs${c.sampled}`, 'Every segment cut at a key frame decodes on its own.')),
});

defineRule({
  id: 'key-is-idr', category: 'Video', severity: 'critical', spec: 'hlsAuth', clause: '7.4 video segments MUST start with an IDR frame',
  title: 'Every key frame is a random access point',
  applies: (c) => c.an?.classified > 0,
  check: (c) => {
    const bad = c.an.keyNotRap;
    return bad.length
      ? fail(`${plural(bad.length, 'key frame')} that is not a random access point${c.sampled}`, 'Players seek and packagers cut at key frames; a key frame that is not an IDR decodes wrongly.', { value: bad.length, offset: c.v.samples.offsets[bad[0]] })
      : pass(`Every key frame is an IDR${c.sampled}`, 'Seeking and segment cuts land on frames that decode on their own.');
  },
});

defineRule({
  id: 'b-frames', category: 'Video', severity: 'critical', spec: 'h264', clause: 'A.2.1 Baseline profile: I and P slices only',
  title: 'B-frames only where the profile allows',
  applies: (c) => c.an?.classified > 0 && c.an.maxB > 0,
  check: (c) => (c.vi.family === 'avc' && c.vi.profile === 66 ? fail(`B-frames in Baseline profile${c.sampled}`, 'Baseline profile forbids B-frames.') : info(`Up to ${plural(c.an.maxB, 'B-frame')} in a row${c.an.refB ? ', B-pyramid' : ''}${c.sampled}`, 'B-frames improve compression; players handle them.', { value: c.an.maxB })),
});

defineRule({
  id: 'peak-ratio', category: 'Video', severity: 'warning', spec: 'hlsAuth', clause: '1.30 VOD peak at most 200 % of the average; the peak per segment, as RFC 8216 §4.1 defines it',
  title: 'Peaks stay near the average',
  applies: (c) => c.it.rate?.avg > 0 && c.it.duration >= 3,
  check: (c) => {
    // HLS measures the peak over whole segments (BANDWIDTH is the busiest segment's rate), and
    // a segment starts at a key frame, so a key frame much larger than the frames after it
    // makes its own second look busy without making any segment busy.
    const r = c.it.rate;
    const len = segmentLength(c);
    const seg = len ? segmentPeak(c.v, len) : null;
    const second = `The busiest single second is ${fmtBitrate(r.peak)} (${fmtNum(r.ratio, 2)}×).`;
    if (!seg) {
      const title = `Busiest second ${fmtBitrate(r.peak)}, ${fmtNum(r.ratio, 2)}× the average of ${fmtBitrate(r.avg)}`;
      return r.ratio <= c.ex.peakRatio
        ? pass(title, 'Peaks stay within the allowed ratio, so the advertised bandwidth is honest.', { value: r.ratio, expected: `≤ ${c.ex.peakRatio}` })
        : warn(title, 'HLS advertises the peak (BANDWIDTH); a rendition whose peaks run far above its average stalls on links sized for its average.', { value: r.ratio, expected: `≤ ${c.ex.peakRatio}`, offset: c.v.samples.offsets[c.peakSample] });
    }
    const ratio = seg.rate / r.avg;
    const title = `Busiest ${fmtNum(len, 1)} s segment ${fmtBitrate(seg.rate)} (at ${fmtDuration(seg.at, false)}), ${fmtNum(ratio, 2)}× the average of ${fmtBitrate(r.avg)}`;
    return ratio <= c.ex.peakRatio
      ? pass(title, `Segment peaks stay within the allowed ratio, so the advertised bandwidth is honest. ${second}`, { value: round3(ratio), expected: `≤ ${c.ex.peakRatio}` })
      : warn(title, `HLS advertises the busiest segment (BANDWIDTH); a rendition whose segments run far above its average stalls on links sized for its average. ${second}`, { value: round3(ratio), expected: `≤ ${c.ex.peakRatio}`, offset: c.v.samples.offsets[seg.start] });
  },
});

defineRule({
  id: 'vbv', category: 'Video', severity: 'warning', spec: 'practice', clause: 'capped CRF for ABR',
  title: 'The encoder bounded the peak bitrate',
  applies: (c) => !!c.rc,
  check: (c) => {
    const rc = c.rc;
    const vbv = rc.maxrate > 0 && rc.bufsize > 0;
    return vbv
      ? pass(`VBV: maxrate ${fmtInt(rc.maxrate)} kb/s, bufsize ${fmtInt(rc.bufsize)} kbit`, 'Players can rely on the advertised bandwidth.', { value: rc.maxrate, offset: c.seiOffset })
      : warn(`${rc.short}, no VBV limit`, 'Without maxrate/bufsize the encoder may spend any number of bits on a hard second; streaming ladders cap the peak (capped CRF).', { offset: c.seiOffset });
  },
});

defineRule({
  id: 'scenecut', category: 'Video', severity: 'info', spec: 'practice', clause: 'fixed GOP for ABR',
  title: 'Scene-cut key frames off in a fixed-GOP ladder',
  applies: (c) => c.parsed && c.parsed.get('scenecut') !== undefined && c.ex.gop,
  check: (c) => (Number(c.parsed.get('scenecut')) === 0 ? pass('Scene-cut detection off', 'Key frames land only on the fixed grid.') : info(`Scene-cut key frames on (scenecut=${c.parsed.get('scenecut')})`, 'Extra key frames at scene changes make GOP lengths vary; a fixed-GOP ladder turns scene cut off.', { offset: c.seiOffset })),
});

defineRule({
  id: 'bits-per-pixel', category: 'Video', severity: 'warning', spec: 'practice', clause: 'bits per pixel per frame',
  title: 'Enough bits per pixel',
  applies: (c) => c.it.bpp > 0,
  check: (c) => {
    const low = c.vi.family === 'hevc' ? 0.02 : 0.03;
    const bpp = fmtNum(c.it.bpp, 3);
    if (c.it.bpp >= low) return info(`${bpp} bits per pixel`, '0.05–0.15 is usual for H.264 at this kind of resolution.', { value: c.it.bpp });
    // Constant quality spends what the picture needs: a simple picture (a talking head, a
    // still) gets few bits at the same quality. Only a bitrate target, or a cap the encoder
    // ran into, can starve it.
    const rc = c.rc;
    const capped = rc?.mode === 'capped-crf' && rc.maxrate > 0 && c.it.rate?.avg >= 0.8 * rc.maxrate * 1000;
    if (rc && (rc.mode === 'crf' || (rc.mode === 'capped-crf' && !capped))) {
      return info(`${bpp} bits per pixel at CRF ${rc.crf}`, 'Few bits per pixel, but the encoder aimed at a constant quality (CRF) and was not held back by a cap, so this says the picture is simple (little motion or detail), not that it was starved. Judge the quality by eye or against the source (PSNR, VMAF).', { value: c.it.bpp });
    }
    return warn(`${bpp} bits per pixel`, `Very few bits per pixel${capped ? ', with the encoder at its bitrate cap' : ''}: expect visible blocking on motion.`, { value: c.it.bpp });
  },
});

defineRule({
  id: 'colour-signalled', category: 'Colour', severity: 'critical', spec: 'h273', clause: 'Tables 2–4: colour primaries, transfer characteristics, matrix coefficients; Apple 1.21',
  title: 'The colour description is signalled',
  applies: (c) => !!c.vi.sps,
  check: (c) => {
    const col = c.colour;
    if (!col) return fail('No colour description in the bitstream', 'Without colour primaries, transfer and matrix, each player guesses: the same file looks different on different devices.', { offset: c.entryOffset });
    const unset = ['primaries', 'transfer', 'matrix'].filter((k) => col[k] === UNSPECIFIED);
    if (unset.length) return fail(`Colour ${unset.join(', ')} "unspecified" (${col.where})`, 'Value 2 means "not signalled"; players fall back to their own default and BT.709 content can render with wrong tones.', { value: col.text, offset: c.entryOffset });
    return pass(`Colour signalled: primaries ${col.primaries}, transfer ${col.transfer}, matrix ${col.matrix} (${col.where})`, 'Players know how to display the picture.', { value: col.text });
  },
});

defineRule({
  id: 'hdr-consistent', category: 'Colour', severity: 'critical', spec: 'h273', clause: 'BT.2100 PQ/HLG signalling; Apple 1.7 HDR is HDR10, HLG or Dolby Vision',
  title: 'HDR signalling is consistent with the samples',
  applies: (c) => c.colour && HDR_TRANSFERS[c.colour.transfer],
  check: (c) => {
    const col = c.colour;
    const hdr = HDR_TRANSFERS[col.transfer];
    const depth = c.vi.depth ?? 8;
    const sane = col.primaries === 9 && (col.matrix === 9 || col.matrix === 10) && depth >= 10;
    return sane
      ? info(`HDR: ${hdr}`, 'A genuine HDR rendition: SDR players need a tone-mapped version.', { value: col.text })
      : fail(`${hdr} transfer with ${depth}-bit samples, primaries ${col.primaries}, matrix ${col.matrix}`, 'HDR needs BT.2020 primaries, a BT.2020 matrix and 10-bit samples; this combination is impossible and shows as washed-out or wrongly coloured video.', { value: col.text, offset: c.entryOffset });
  },
});

defineRule({
  id: 'colour-consistent', category: 'Colour', severity: 'critical', spec: 'h273', clause: 'primaries and matrix belong together',
  title: 'Primaries and matrix agree',
  applies: (c) => c.colour && !HDR_TRANSFERS[c.colour.transfer] && c.colour.primaries !== UNSPECIFIED && c.colour.matrix !== UNSPECIFIED,
  check: (c) => {
    const col = c.colour;
    const wide = col.primaries === 9;
    const wideMatrix = col.matrix === 9 || col.matrix === 10;
    return wide === wideMatrix ? pass('Primaries and matrix agree', 'BT.709 with BT.709, or BT.2020 with BT.2020.', { value: col.text }) : fail(`Primaries ${col.primaries} with matrix ${col.matrix}`, 'BT.2020 primaries go with the BT.2020 matrix and BT.709 with BT.709; a mix means the pixels were tagged, not converted.', { value: col.text, offset: c.entryOffset });
  },
});

defineRule({
  id: 'colour-expected', category: 'Colour', severity: 'warning', spec: 'hlsAuth', clause: '1.21 a single colour space: the one the service standardises on',
  title: 'The colour description the service standardises on',
  applies: (c) => c.colour && c.ex.colour,
  check: (c) => {
    const col = c.colour;
    const want = c.ex.colour;
    const same = ['primaries', 'transfer', 'matrix'].every((k) => want[k] === undefined || want[k] === col[k]);
    const wantText = `${want.primaries ?? '·'}/${want.transfer ?? '·'}/${want.matrix ?? '·'}`;
    return same ? pass('Colour as the service intends', 'Every rendition carries the standard description.', { value: col.text }) : fail(`Colour ${col.text}, expected ${wantText}`, 'Every rendition should carry the colour description the service standardises on.', { value: col.text, expected: wantText, offset: c.entryOffset });
  },
});

defineRule({
  id: 'range', category: 'Colour', severity: 'warning', spec: 'h273', clause: 'video_full_range_flag',
  title: 'Limited (TV) range',
  applies: (c) => c.vi.sps?.vui?.full_range !== undefined,
  check: (c) => (c.vi.sps.vui.full_range ? warn('Full-range video', 'Most players and pipelines assume limited range; full range is often displayed with crushed blacks.', { offset: c.entryOffset }) : pass('Limited (TV) range', 'As players expect.')),
});

defineRule({
  id: 'depth', category: 'Video', severity: 'critical', spec: 'hlsAuth', clause: '1.3b at most High Profile, which is 8-bit (High 10 is beyond it)',
  title: '8-bit samples for H.264',
  applies: (c) => c.vi.family === 'avc' && c.vi.depth,
  check: (c) => (c.vi.depth > 8 ? fail(`${c.vi.depth}-bit H.264`, 'H.264 above 8 bits (High 10) is beyond High Profile, the most Apple devices decode, and most hardware does not decode it.', { offset: c.entryOffset }) : pass('8-bit 4:2:0', 'Decoded by every device.')),
});

defineRule({
  id: 'brands', category: 'Container', severity: 'info', spec: 'isobmff', clause: '§4.3 file type box',
  title: 'File-type brands say what the file is',
  applies: (c) => !!c.mp4?.ftyp,
  check: (c) => {
    const f = c.mp4.ftyp.data;
    const all = [...new Set([f.major, ...(f.brands ?? [])].filter(Boolean))];
    const cmaf = all.some((b) => /^cmf[c2]$/.test(b));
    const frag = !!c.mp4.moof;
    if (cmaf && !frag) return fail(`Brand ${all.find((b) => /^cmf/.test(b))} on a file that is not fragmented`, 'CMAF brands promise fragmented, single-track media; an unfragmented file wearing one misleads packagers.', { value: all, offset: c.mp4.ftyp.offset });
    if (all.some((b) => b.trim() === 'qt')) return info(`Brands ${all.map((b) => `'${b}'`).join(' ')}: a QuickTime file`, 'QuickTime movies play in Apple software and FFmpeg-based players; HLS packagers want an ISO brand.', { value: all, offset: c.mp4.ftyp.offset });
    if (!all.some((b) => /^iso[1-9m]$/.test(b) || /^mp4[12]$/.test(b)) && !cmaf) return warn(`Brands ${all.map((b) => `'${b}'`).join(' ')}: no ISO base brand`, 'Players expect isom, iso2–iso9, mp41 or mp42 (or a CMAF brand) among the compatible brands.', { value: all, offset: c.mp4.ftyp.offset });
    return info(`Brands ${all.map((b) => `'${b}'`).join(' ')}${cmaf ? ' (CMAF)' : ''}`, 'The specifications the writer claims the file follows.', { value: all, offset: c.mp4.ftyp.offset });
  },
});

defineRule({
  id: 'display-aspect', category: 'Video', severity: 'warning', spec: 'isobmff', clause: '§8.3.2 tkhd width/height against the coded size and pixel aspect',
  title: 'The track\'s display size matches the coded picture',
  applies: (c) => c.v && c.vi.width && c.vi.height && c.v.node?.child?.('tkhd')?.data?.width > 0,
  check: (c) => {
    const tk = c.v.node.child('tkhd').data;
    const [sw, sh] = Array.isArray(c.vi.sps?.vui?.sar) ? c.vi.sps.vui.sar : [1, 1];
    const par = sw && sh ? sw / sh : 1;
    const parText = par !== 1 ? ` at pixel aspect ${sw}:${sh}` : '';
    // The display matrix may swap width and height (a 90° rotation); compare the aspect either way.
    const coded = (c.vi.width * par) / c.vi.height;
    const disp = tk.width / tk.height;
    const ok = Math.abs(disp - coded) / coded < 0.02 || Math.abs(1 / disp - coded) / coded < 0.02;
    return ok
      ? pass(`Display ${fmtNum(tk.width, 0)}×${fmtNum(tk.height, 0)} matches the coded ${c.vi.width}×${c.vi.height}${parText}`, 'Players show the picture at the shape it was coded.', { value: `${tk.width}×${tk.height}` })
      : warn(`Display ${fmtNum(tk.width, 0)}×${fmtNum(tk.height, 0)} disagrees with the coded ${c.vi.width}×${c.vi.height}${parText}`, 'The container asks for one shape and the bitstream codes another: some players stretch the picture, others ignore the container.', { value: `${tk.width}×${tk.height}`, expected: `${c.vi.width}×${c.vi.height}`, offset: c.v.node.child('tkhd').offset });
  },
});

defineRule({
  id: 'hdr-metadata', category: 'Colour', severity: 'warning', spec: 'hlsAuth', clause: '1.35 HDR10: mastering display colour volume and content light level information SHOULD be present',
  title: 'HDR10 static metadata present',
  applies: (c) => c.colour && c.colour.transfer === 16 && c.v?.entryNode?.children,
  check: (c) => {
    const kids = c.v.entryNode.children ?? [];
    const has = (t) => kids.some((n) => n.type === t);
    const mdcv = has('mdcv') || has('SmDm');
    const clli = has('clli') || has('CoLL');
    return mdcv && clli
      ? pass('Mastering display and content light level metadata present', 'HDR10 players can map the picture to their display.')
      : warn(`HDR10 without ${[!mdcv ? 'mastering display (mdcv)' : null, !clli ? 'content light level (clli)' : null].filter(Boolean).join(' or ')} metadata`, 'Apple asks for the mastering display colour volume and content light level information with HDR10; without it a display tone-maps blindly. This check reads the mdcv/clli boxes of the sample entry, not SEI messages in the stream.', { offset: c.entryOffset });
  },
});

defineRule({
  id: 'fragments', category: 'Container', severity: 'critical', spec: 'hlsAuth', clause: '7.3 fMP4 decode times continue from segment to segment; RFC 8216 §3',
  title: 'Movie fragments are continuous',
  applies: (c) => c.mp4?.moofs?.length > 0,
  check: (c) => {
    const kids = c.doc.root.children ?? [];
    const problems = [];
    let prevSeq = null;
    // Decode times are continuous per track: a file with one moof per track (ffmpeg's
    // separate_moof) interleaves the tracks' moofs, each on its own clock.
    const prevTime = new Map();
    let unpaired = 0;
    for (let i = 0; i < kids.length; i++) {
      const n = kids[i];
      if (n.type !== 'moof') continue;
      if (kids[i + 1]?.type !== 'mdat') unpaired++;
      const seq = n.find?.('mfhd')?.data?.seq;
      if (seq !== undefined && prevSeq !== null && seq !== prevSeq + 1) problems.push(`sequence ${prevSeq} → ${seq} at ${n.offset}`);
      if (seq !== undefined) prevSeq = seq;
      for (const traf of n.childrenOf?.('traf') ?? n.children?.filter((x) => x.type === 'traf') ?? []) {
        const id = traf.child?.('tfhd')?.data?.trackId ?? traf.find?.('tfhd')?.data?.trackId ?? 0;
        const t = traf.child?.('tfdt')?.data?.time ?? traf.find?.('tfdt')?.data?.time;
        if (t === undefined) continue;
        if (prevTime.has(id) && t < prevTime.get(id)) problems.push(`decode time of track ${id} goes back at ${n.offset}`);
        prevTime.set(id, t);
      }
    }
    if (unpaired) problems.push(`${plural(unpaired, 'moof')} not followed by mdat`);
    return problems.length
      ? fail(`${c.mp4.moofs.length} fragments: ${problems.slice(0, 3).join('; ')}`, 'Players and packagers read fragments in order; a gap in the sequence or a decode time that goes back breaks playback at that point.', { value: problems, offset: c.mp4.moofs[0].offset })
      : pass(`${c.mp4.moofs.length} fragments in sequence, decode times continuous, each moof paired with its mdat`, 'The fragments can be played or repackaged in order.', { value: c.mp4.moofs.length });
  },
});

defineRule({
  id: 'vbv-holds', category: 'Video', severity: 'critical', spec: 'h264', clause: 'Annex C hypothetical reference decoder: no buffer underflow at the declared rate',
  title: 'The declared VBV never underflows',
  applies: (c) => c.rc && c.rc.maxrate > 0 && c.rc.bufsize > 0 && c.v?.samples?.count > 1,
  check: (c) => {
    const r = simulateVbv(c.v, { maxrate: c.rc.maxrate * 1000, bufsize: c.rc.bufsize * 1000 });
    if (r.underflows.length) return fail(`Buffer underflows ${plural(r.underflows.length, 'time')} at ${fmtInt(c.rc.maxrate)} kb/s with a ${fmtInt(c.rc.bufsize)} kbit buffer`, 'A player receiving the stream at the declared maximum rate would stall there; the encoder broke its own VBV promise.', { value: r.underflows.length, offset: c.v.samples.offsets[r.underflows[0]] });
    return pass(`Buffer never underflows at ${fmtInt(c.rc.maxrate)} kb/s with a ${fmtInt(c.rc.bufsize)} kbit buffer (never below ${fmtNum((r.min / (c.rc.bufsize * 1000)) * 100, 0)} %)`, 'The stream keeps the promise its VBV settings make.', { value: r.min / (c.rc.bufsize * 1000) });
  },
});

// ====================================================================== audio

defineRule({
  id: 'audio-codec', category: 'Audio', severity: 'warning', spec: 'hlsAuth', clause: '2.2 and 2.5 supported audio codecs; 2.3 stereo AAC MUST be provided',
  title: 'An HLS audio codec',
  applies: (c) => !!c.a,
  check: (c) => {
    const name = c.audio.codec;
    if (c.ex.audio?.codec && name !== c.ex.audio.codec) return fail(`${name}, expected ${c.ex.audio.codec}`, 'Not the codec the service standardises on.', { value: name, expected: c.ex.audio.codec });
    return /AAC/.test(name) ? pass(name, 'AAC is the audio codec every HLS client decodes.') : warn(name, 'HLS clients for Apple devices expect AAC (or AC-3/E-AC-3 for surround).', { value: name });
  },
});

defineRule({
  id: 'audio-rate', category: 'Audio', severity: 'warning', spec: 'practice', clause: '44.1 or 48 kHz',
  title: 'A usual sample rate',
  applies: (c) => c.audio?.sampleRate,
  check: (c) => {
    const rate = c.audio.sampleRate;
    if (c.ex.audio?.sampleRate) return (rate === c.ex.audio.sampleRate ? pass : fail)(`${fmtInt(rate)} Hz`, rate === c.ex.audio.sampleRate ? 'As the service intends.' : `Expected ${fmtInt(c.ex.audio.sampleRate)} Hz.`, { value: rate, expected: c.ex.audio.sampleRate });
    return rate === 48000 || rate === 44100 ? pass(`${fmtInt(rate)} Hz`, '44.1 and 48 kHz decode everywhere.', { value: rate }) : warn(`${fmtInt(rate)} Hz`, 'Unusual sample rates are resampled by players.', { value: rate });
  },
});

defineRule({
  id: 'audio-channels', category: 'Audio', severity: 'critical', spec: 'hlsAuth', clause: '9.6 multichannel audio MUST be in separate audio streams',
  title: 'Stereo or mono',
  applies: (c) => c.audio?.channels,
  check: (c) => {
    const n = c.audio.channels;
    const max = c.ex.audio?.channelsMax ?? 2;
    if (n > 2) return fail(`${plural(n, 'channel')} in the rendition`, 'Apple asks for multichannel audio in separate audio streams (with stereo AAC alongside), not muxed into a video rendition.', { value: n, expected: '≤ 2' });
    return n <= max ? pass(plural(n, 'channel'), 'Every device plays it.', { value: n }) : warn(plural(n, 'channel'), `More channels than the service expects (${max}).`, { value: n, expected: `≤ ${max}` });
  },
});

defineRule({
  id: 'audio-bitrate', category: 'Audio', severity: 'warning', spec: 'practice', clause: 'AAC-LC bit rate per channel; Apple 2.9 lists 32–160 kbit/s for stereo AAC',
  title: 'Enough bits per audio channel',
  applies: (c) => c.audio?.bitrate && c.audio.channels,
  check: (c) => {
    const per = c.audio.bitrate / c.audio.channels;
    const min = c.ex.audio?.minBitratePerChannel ?? 48000;
    const title = `${fmtBitrate(c.audio.bitrate)} for ${plural(c.audio.channels, 'channel')} (${fmtBitrate(per)} each)`;
    return per >= min ? pass(title, 'Enough bits per channel for AAC-LC.', { value: per }) : warn(title, 'AAC-LC below about 48 kb/s per channel sounds dull; HE-AAC is the usual choice at these rates.', { value: per, expected: `≥ ${fmtBitrate(min)}` });
  },
});

defineRule({
  id: 'audio-priming', category: 'Audio', severity: 'warning', spec: 'priming', clause: 'trim the encoder delay (priming); in MP4 with an edit list (ISO 14496-12 §8.6.6)',
  title: 'The AAC encoder delay is compensated',
  // MP4 signals the delay with an edit list, Matroska with CodecDelay; other containers have no
  // way to say it, so the rule stays silent there rather than blame them for it.
  applies: (c) => c.a && /AAC/.test(c.audio.codec) && ((c.doc.format?.id === 'isobmff' && typeof c.a.node?.find === 'function') || (c.doc.format?.id === 'matroska' && 'codecDelay' in c.a)),
  check: (c) => {
    if (c.doc.format.id === 'matroska') {
      const ms = (c.a.codecDelay ?? 0) / 1e6;
      return ms > 0
        ? pass(`CodecDelay ${fmtNum(ms, 1)} ms (encoder priming)`, 'Players skip the encoder delay, so audio and video start together.', { value: ms })
        : warn('No CodecDelay for the encoder priming', 'AAC encoders add 1024–2112 samples of delay; without CodecDelay audio plays 20–50 ms late against the video.', { value: 0, offset: c.a.node?.offset });
    }
    const elst = c.a.node.find('elst');
    const media = elst?.data?.table?.count ? firstMediaTime(elst.data.table) : 0;
    const ms = (media / (c.a.timescale || 1)) * 1000;
    if (media > 0) return pass(`Edit list skips the first ${fmtNum(ms, 1)} ms (encoder priming)`, 'The encoder delay is removed, so audio and video start together.', { value: ms, offset: elst.offset });
    if (!elst) return warn('No edit list for the encoder priming', 'AAC encoders put 1024–2112 samples of priming before the sound; without an edit list to skip them, audio plays 20–50 ms late against the video. Files remuxed from MPEG-TS lose this information.', { value: 0, offset: c.a.node.offset });
    return warn('The audio edit list starts at 0, so the encoder priming is played', 'AAC encoders put 1024–2112 samples of priming before the sound. This edit list does not skip them, so audio plays about 20–50 ms late against the video unless the timestamps were shifted to make up for it; a sync measurement (a flash and a beep) settles it. Files remuxed from MPEG-TS lose the priming information.', { value: 0, offset: elst.offset });
  },
});

// ====================================================================== measured (from the caller: ffmpeg ebur128, psnr, a sync probe)

defineRule({
  id: 'loudness', category: 'Audio', severity: 'warning', spec: 'r128', clause: 'R 128 (h): −23 LUFS ±1 LU; R 128 s2 (g): −20 to −16 LUFS for streams; the target comes from the profile',
  title: 'Integrated loudness on target',
  applies: (c) => c.measured.loudness?.integrated !== undefined,
  unmeasured: (c) => (c.a ? `No loudness measurement in this run${c.ex.loudness?.integrated !== undefined ? ` (the profile's target is ${c.ex.loudness.integrated} LUFS)` : ''}. Loudness needs the audio decoded: vidscope audit --measure does it with ffmpeg.` : null),
  check: (c) => {
    const i = c.measured.loudness.integrated;
    const want = c.ex.loudness;
    if (want?.integrated === undefined) return info(`${fmtNum(i, 1)} LUFS integrated`, 'Streaming services normalise between −14 and −20 LUFS; consistency across the catalogue matters more than the exact number.', { value: i });
    const tol = want.tolerance ?? 1;
    const off = Math.abs(i - want.integrated);
    return (off <= tol ? pass : fail)(`${fmtNum(i, 1)} LUFS integrated, target ${want.integrated} ± ${tol}`, off <= tol ? 'On target.' : 'Off the loudness target: viewers reach for the volume control between videos.', { value: i, expected: want.integrated });
  },
});

defineRule({
  id: 'true-peak', category: 'Audio', severity: 'warning', spec: 'r128', clause: 'R 128 (m): true peak at most −1 dBTP',
  title: 'True peak below the ceiling',
  applies: (c) => c.measured.loudness?.truePeak !== undefined,
  unmeasured: (c) => (c.a ? 'No true-peak measurement in this run. It needs the audio decoded: vidscope audit --measure does it with ffmpeg.' : null),
  check: (c) => {
    const tp = c.measured.loudness.truePeak;
    const max = c.ex.loudness?.truePeakMax ?? -1;
    return (tp <= max ? pass : fail)(`True peak ${fmtNum(tp, 1)} dBTP`, tp <= max ? 'Below the ceiling.' : `Above ${max} dBTP: the lossy decode can clip.`, { value: tp, expected: `≤ ${max}` });
  },
});

defineRule({
  id: 'av-sync', category: 'Audio', severity: 'critical', spec: 'bt1359', clause: 'sound may lead vision by 45 ms or lag it by 125 ms before viewers notice; 90 / 185 ms before they object',
  title: 'Audio and video in sync',
  applies: (c) => c.measured.sync?.audioLateMs !== undefined,
  unmeasured: (c) => (c.a && c.v ? 'No sync measurement in this run. Sync is measured on a clip with a known reference (a flash and a beep) put through the same conversion; the audio priming check covers what the file itself shows.' : null),
  check: (c) => {
    // audioLateMs > 0: the sound comes after the picture (lags); < 0: before it (leads).
    // BT.1359 tolerates a lag (sound after light, as in nature) three times more than a lead.
    const ms = c.measured.sync.audioLateMs;
    const title = `Audio ${ms >= 0 ? 'lags' : 'leads'} video by ${fmtNum(Math.abs(ms), 0)} ms`;
    if (Math.abs(ms) <= 22) return pass(title, 'Within a frame.', { value: ms });
    const detectable = ms > 125 || ms < -45;
    const objectionable = ms > 185 || ms < -90;
    return (objectionable ? fail : warn)(title, objectionable ? 'Beyond what ITU-R BT.1359 calls acceptable (+90 ms lead / −185 ms lag): viewers object.' : detectable ? 'Beyond the ITU-R BT.1359 detectability threshold (45 ms lead / 125 ms lag): attentive viewers notice.' : 'Noticeable to a careful viewer but within ITU-R BT.1359\'s detectability threshold.', { value: ms });
  },
});

defineRule({
  id: 'quality', category: 'Video', severity: 'warning', spec: 'practice', clause: 'fidelity to the source',
  title: 'Fidelity to the source',
  applies: (c) => c.measured.quality != null,
  unmeasured: (c) => (c.v ? 'No comparison with the source in this run: it needs the original upload (vidscope audit --measure --source).' : null),
  check: (c) => {
    const { psnr, ssim, vmaf } = c.measured.quality;
    const parts = [psnr !== undefined ? `PSNR ${fmtNum(psnr, 1)} dB` : null, ssim !== undefined ? `SSIM ${fmtNum(ssim, 3)}` : null, vmaf !== undefined ? `VMAF ${fmtNum(vmaf, 1)}` : null].filter(Boolean);
    const bad = (psnr !== undefined && psnr < 30) || (ssim !== undefined && ssim < 0.9) || (vmaf !== undefined && vmaf < 70);
    return (bad ? warn : info)(`Against the source: ${parts.join(', ')}`, bad ? 'Low fidelity for this resolution: check the conversion path (colour, deinterlacing, scaling).' : 'Measured on the luma plane against the source scaled to this size.', { value: psnr ?? ssim ?? vmaf });
  },
});

// ====================================================================== ladder

/** Size tiers renditions are named after (the short side of a 16:9 frame). */
const SIZE_TIERS = [144, 240, 360, 480, 540, 720, 1080, 1440, 2160, 4320];

/** Half a frame of the slowest rendition, plus a millisecond of timescale rounding. */
function keyTolerance(items) {
  let fps = Infinity;
  for (const it of items) if (it.fps) fps = Math.min(fps, it.fps);
  return (Number.isFinite(fps) ? 0.5 / fps : 0.02) + 0.001;
}

/**
 * Where a packager cuts segments of `len` seconds: at the first key frame at or after each
 * multiple of the length, counted in segments (ffmpeg's HLS muxer keeps such a running grid), so
 * a segment that ran long does not shift the ones after it unless the key frames moved.
 */
function packagerCuts(keys, len, tol) {
  const cuts = [keys[0]];
  for (let k = 1; k < keys.length; k++) if (keys[k] - keys[0] >= cuts.length * len - tol) cuts.push(keys[k]);
  return cuts;
}

/** "7.4 s at 9:57, 2 s at 4:55, and 3 more": the first few of a list of { at, seconds }. */
function listAt(items, n = 3) {
  const head = items.slice(0, n).map((o) => `${fmtNum(o.seconds, 1)} s at ${fmtDuration(o.at, false)}`).join(', ');
  return items.length > n ? `${head}, and ${items.length - n} more` : head;
}

const round3 = (x) => Math.round(x * 1000) / 1000;

function hasKeyNear(keys, t, tol) {
  let lo = 0;
  let hi = keys.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (keys[mid] < t - tol) lo = mid + 1;
    else if (keys[mid] > t + tol) hi = mid - 1;
    else return true;
  }
  return false;
}

defineRule({
  id: 'idr-aligned', scope: 'ladder', category: 'Ladder', severity: 'critical', spec: 'hlsAuth', clause: '8.22 segment boundaries at the same times in every variant (SHOULD; MUST on AirPlay 2 TVs); 7.4',
  title: 'Key frames aligned across renditions',
  applies: (l) => l.items.length >= 2 && l.items.every((it) => it.keyTimes?.length),
  check: (l) => {
    // Every rendition is a peer: each key frame of each one must have a key frame at the
    // same moment in every other one.
    const tol = keyTolerance(l.items);
    let unmatched = 0;
    let worst = 0;
    let where = null;
    for (const it of l.items) {
      let mine = 0;
      for (const t of it.keyTimes) {
        if (l.items.every((o) => o === it || hasKeyNear(o.keyTimes, t, tol))) continue;
        mine++;
        if (where === null) where = t;
      }
      unmatched += mine;
      worst = Math.max(worst, mine);
    }
    return unmatched === 0
      ? pass(`Key frames aligned across ${l.items.length} renditions`, 'A player can switch rendition at any segment boundary.', { value: 0 })
      : fail(`Key frames differ across renditions: ${plural(unmatched, 'key frame')} without a match (first at ${fmtDuration(where)})`, 'A packager cuts segments at key frames; unmatched key frames give segments that do not line up, so switching stalls or glitches.', { value: unmatched });
  },
});

defineRule({
  id: 'segment-lengths', scope: 'ladder', category: 'Ladder', severity: 'critical', spec: 'rfc8216', clause: '§4.3.3.1 target duration; Apple 7.5–7.7 (6 s target, no segment more than 0.5 s over it)',
  title: 'A segment length fits every rendition',
  applies: (l) => l.items.length >= 2 && l.items.every((it) => it.keyTimes?.length && it.times?.length),
  check: (l) => {
    // Cut every rendition the way a packager would for each segment length, and look at what
    // comes out: the same cut times in every rendition (or switching glitches), and no segment
    // longer than asked (a GOP of 120 frames at 23.976 fps is 5.005 s and still cuts 5 s
    // segments). Every key frame counts, so a short GOP anywhere in the file is seen.
    const tol = keyTolerance(l.items);
    const end = Math.max(...l.items.map((it) => it.times[it.times.length - 1] + (it.fps ? 1 / it.fps : 0)));
    const plans = l.ex.segments.map((len) => {
      const cuts = l.items.map((it) => packagerCuts(it.keyTimes, len, tol));
      const aligned = cuts.every((cs) => cs.length === cuts[0].length && cs.every((t, k) => Math.abs(t - cuts[0][k]) <= tol));
      const long = [];
      let longest = 0;
      cuts[0].forEach((t, k) => {
        const seconds = (k + 1 < cuts[0].length ? cuts[0][k + 1] : end) - t;
        longest = Math.max(longest, seconds);
        if (seconds > len + Math.max(tol, 0.01 * len)) long.push({ at: t, seconds });
      });
      return { len, aligned, long, longest, count: cuts[0].length };
    });
    const fit = plans.filter((p) => p.aligned && !p.long.length);
    if (fit.length) return pass(`Segments of ${fit.map((p) => `${p.len} s`).join(', ')} fit the key frames`, 'A packager cuts every segment of these lengths on time, at the same moment in every rendition.', { value: fit.map((p) => p.len) });
    const best = plans.filter((p) => p.aligned).sort((p, q) => p.long.length / p.count - q.long.length / q.count || p.longest / p.len - q.longest / q.len)[0];
    if (best) {
      const few = best.long.length <= best.count / 4;
      return warn(`${best.len} s segments: ${best.long.length} of ${best.count} run long (${listAt(best.long)})`, `Key frames line up across the renditions, so switching works; but ${few ? `after a shorter GOP the key frames are off the ${best.len} s grid` : `they do not fall every ${best.len} s`}, so the packager waits for the next one and those segments run long. The longest is ${fmtNum(best.longest, 1)} s, so the playlist's target duration has to grow from ${best.len} s to cover it.`, { value: round3(best.longest), expected: `≤ ${best.len} s` });
    }
    return fail(`No segment length of ${l.ex.segments.join('/')} s cuts every rendition at the same moments`, 'The key frames of the renditions do not line up, so a packager cuts their segments at different times and a player cannot switch cleanly between them.', { expected: l.ex.segments });
  },
});

defineRule({
  id: 'frame-rates', scope: 'ladder', category: 'Ladder', severity: 'info', spec: 'hlsAuth', clause: '1.31 variants MAY have different frame rates',
  title: 'Frame rates consistent across renditions',
  applies: (l) => l.items.length >= 2,
  check: (l) => {
    const set = [...new Set(l.items.map((it) => it.fps && Math.round(it.fps * 100) / 100))];
    return set.length === 1
      ? pass(`Same frame rate in every rendition (${fmtNum(set[0], 3)} fps)`, 'Switching never changes motion.', { value: set })
      : info(`Frame rates: ${set.map((f) => fmtNum(f, 3)).join(', ')} fps`, 'Lower renditions at half the frame rate are allowed; other mixes look like stutter when switching.', { value: set });
  },
});

defineRule({
  id: 'same-audio', scope: 'ladder', category: 'Ladder', severity: 'warning', spec: 'rfc8216', clause: '§6.2.4 variants SHOULD contain the same encoded audio bitstream',
  title: 'The same audio in every rendition',
  applies: (l) => l.results.some((r) => r.facts.audio),
  check: (l) => {
    const audio = l.results.map((r) => (r.facts.audio ? `${r.facts.audio.codec} ${r.facts.audio.sampleRate} Hz ${r.facts.audio.channels} ch` : 'none'));
    const set = [...new Set(audio)];
    return set.length === 1
      ? pass(`Same audio in every rendition (${audio[0]})`, 'Rendition switches are inaudible.', { value: set })
      : warn(`Audio differs across renditions: ${set.join(' / ')}`, 'RFC 8216 asks every variant to carry the same encoded audio bitstream so that switching is inaudible; a switch from mono to stereo, or between bit rates, is heard.', { value: set });
  },
});

defineRule({
  id: 'bitrate-steps', scope: 'ladder', category: 'Ladder', severity: 'warning', spec: 'practice', clause: 'adjacent renditions 1.5–2× apart',
  title: 'Bitrate steps down the ladder',
  applies: (l) => l.byHeight.length >= 2,
  check: (l) => {
    const rates = l.byHeight.map((r) => r.facts.video.bitrate).filter(Boolean);
    if (rates.length < 2) return null;
    const steps = [];
    let mono = true;
    for (let i = 1; i < rates.length; i++) {
      const ratio = rates[i - 1] / rates[i];
      steps.push(Math.round(ratio * 100) / 100);
      if (ratio < 1) mono = false;
    }
    if (!mono) return fail('A smaller rendition has a higher bitrate than a larger one', 'Players choose by bandwidth, so the ladder must get cheaper as it gets smaller.', { value: steps });
    const odd = steps.filter((s) => s < 1.4 || s > 2.6).length;
    const title = `Bitrate steps of ${steps.map((s) => `${fmtNum(s, 1)}×`).join(', ')} down the ladder`;
    return odd ? info(title, 'Apple and common practice keep adjacent renditions 1.5–2× apart; larger gaps waste bandwidth or quality when switching.', { value: steps }) : pass(title, 'Adjacent renditions 1.5–2.5× apart, as usual.', { value: steps });
  },
});

defineRule({
  id: 'label-matches-size', scope: 'ladder', category: 'Ladder', severity: 'warning', spec: 'practice', clause: 'rendition names',
  title: 'Rendition names match their picture size',
  applies: (l) => l.results.some((r) => /\d{3,4}p/i.test(r.file)),
  check: (l) => {
    // The rendition's own label is the last "NNNp" before the extension: a name that carries
    // the source size as well (clip-2160p-1080p.mp4) is judged on the 1080p.
    const label = (name) => [...name.replace(/\.\w+$/, '').matchAll(/(\d{3,4})p(?![a-z])/gi)].pop()?.[1];
    // A name is a size tier, as players and YouTube use it: the short side is at most the tier,
    // and the picture does not fit inside the tier below's 16:9 frame. A 1920×800 film is 1080p,
    // a 592×320 or a 264×142 picture keeps its 360p or 144p name.
    const within = (w, h, t) => Math.max(w, h) <= Math.round((t * 16) / 9 / 2) * 2 + 2 && Math.min(w, h) <= t;
    const off = [];
    let shaped = 0;
    for (const r of l.results) {
      const m = Number(label(r.file));
      const { width: w, height: h } = r.facts.video ?? {};
      if (!m || !w || !h) continue;
      const below = SIZE_TIERS.filter((t) => t < m).pop();
      if (Math.min(w, h) > m + 1) off.push(`${r.file}: labelled ${m}p, but ${w}×${h} is larger than ${m}p`);
      else if (below && within(w, h, below)) off.push(`${r.file}: labelled ${m}p, but ${w}×${h} fits a ${below}p frame`);
      else if (Math.min(w, h) !== m) shaped++;
    }
    if (off.length) return warn(off.join('; '), 'A rendition name that promises another size than the file holds misleads players, manifests and people.', { value: off });
    return pass('Rendition names match their size tiers', shaped ? `Each name is the tier its picture belongs to; ${plural(shaped, 'picture')} keeps the source's shape rather than the tier's exact 16:9 size, as a wide film or a cropped source does.` : 'What the name says is what the file holds.');
  },
});

defineRule({
  id: 'levels', scope: 'ladder', category: 'Ladder', severity: 'warning', spec: 'hlsAuth', clause: '1.3a some H.264 variants at most High Profile, Level 4.1',
  title: 'Levels down the ladder',
  applies: (l) => l.byHeight.length >= 1,
  check: (l) => {
    const title = `Levels: ${l.byHeight.map((r) => `${Math.min(r.facts.video.height, r.facts.video.width ?? r.facts.video.height)}p level ${r.facts.video.levelName ?? '?'}`).join(', ')}`;
    const avc = l.byHeight.filter((r) => /264|AVC/i.test(r.facts.video.codec ?? '') && r.facts.video.level);
    if (avc.length && !avc.some((r) => r.facts.video.level <= 41)) return warn(title, 'Apple asks for some H.264 variants at High Profile, Level 4.1 or below, so older devices find a rendition they decode.', { expected: '≤ 4.1 on some rendition' });
    return info(title, 'What each rendition asks of a decoder (a portrait rendition is named by its short side).');
  },
});

// ====================================================================== playlists (HLS)
//
// Rules over a measured presentation (web/core/hls.js measureHls): what the multivariant and
// media playlists declare, against the segments they list.

const pctOff = (measured, declared) => `${measured >= declared ? '+' : '−'}${fmtNum(Math.abs(measured / declared - 1) * 100, 1)} %`;
const listFew = (items, n = 3) => (items.length > n ? `${items.slice(0, n).join('; ')}; and ${items.length - n} more` : items.join('; '));

/** avc1.PPCCLL -> { profile, constraints, level }, or null. */
function avcParts(codec) {
  const m = /^avc[13]\.([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(codec ?? '');
  return m ? { profile: m[1].toLowerCase(), constraints: m[2].toLowerCase(), level: m[3].toLowerCase() } : null;
}

/** How a declared codec relates to one found in the segments: 'same', 'close' (flags differ) or 'other'. */
function codecMatch(declared, found) {
  const d = declared.toLowerCase();
  const f = found.toLowerCase();
  if (d === f) return 'same';
  const a = avcParts(d);
  const b = avcParts(f);
  if (a && b) return a.profile === b.profile && a.level === b.level ? 'close' : 'other';
  return d.split('.')[0] === f.split('.')[0] && d.split('.')[1] === f.split('.')[1] ? 'close' : 'other';
}

defineRule({
  id: 'hls-reachable', scope: 'playlist', category: 'Delivery', severity: 'critical', spec: 'rfc8216', clause: '§6.2.1 every segment a playlist lists MUST be available for download',
  title: 'Every playlist and segment can be fetched',
  applies: (p) => p.m.playlists.length > 0,
  check: (p) => {
    const bad = [];
    let sized = 0;
    let total = 0;
    for (const pl of p.m.playlists) {
      if (pl.error) {
        bad.push(`${pl.label}: ${pl.error}`);
        continue;
      }
      total += pl.segments.length;
      sized += pl.sized;
      const failed = pl.segments.filter((s) => s.error);
      if (failed.length) bad.push(`${pl.label}: ${plural(failed.length, 'segment')} failed (${failed[0].error})`);
    }
    const sampled = p.m.playlists.some((pl) => pl.sampled);
    return bad.length
      ? fail(listFew(bad), 'A player that meets a missing playlist or segment stalls or switches away; every URI a playlist lists must answer.', { value: bad })
      : pass(`${plural(p.m.playlists.length, 'playlist')} and ${fmtInt(sized)} segments fetched${sampled ? ` (sizes of ${fmtInt(sized)} of ${fmtInt(total)} segments, spread over each playlist)` : ''}`, 'Every URI answered.', { value: sized });
  },
});

defineRule({
  id: 'hls-bandwidth', scope: 'playlist', category: 'Delivery', severity: 'critical', spec: 'hlsAuth', clause: '1.27 VOD: the measured peak within 10 % of BANDWIDTH; RFC 8216 §4.3.4.2 BANDWIDTH is the peak segment bit rate',
  title: 'BANDWIDTH is the measured peak',
  applies: (p) => p.master && p.withVariant.some(({ v, pl }) => v?.bandwidth && pl.peak),
  check: (p) => {
    const off = [];
    const rows = [];
    let lowerBound = false;
    for (const { v, pl } of p.withVariant) {
      if (!v?.bandwidth || !pl.peak) continue;
      // A variant with its own audio renditions carries their peak on top of its own.
      const audio = v.audio ? Math.max(0, ...p.media.filter((m) => m.role === 'rendition' && m.group === v.audio && m.peak).map((m) => m.peak.rate)) : 0;
      const peak = pl.peak.rate + audio;
      rows.push({ variant: pl.label, declared: v.bandwidth, peak: Math.round(peak) });
      lowerBound ||= pl.sampled;
      const under = peak > v.bandwidth * 1.1;
      const over = !pl.sampled && peak < v.bandwidth / 1.1;
      if (under || over) off.push(`${pl.label} declares ${fmtBitrate(v.bandwidth)}, its segments peak at ${fmtBitrate(peak)} (${pctOff(peak, v.bandwidth)})`);
    }
    if (!off.length) return pass(`BANDWIDTH within 10 % of the measured peak on ${plural(rows.length, 'variant')}`, `Players choose variants by BANDWIDTH, and it matches what the segments need.${lowerBound ? ' Segment sizes were sampled, so the peaks are lower bounds.' : ''}`, { value: rows });
    const res = p.vod ? fail : warn;
    return res(off.join('; '), `BANDWIDTH is what a player plans its network by: a variant whose segments need more than it declares stalls on a link that "should" carry it, and one that declares far more is chosen too rarely. RFC 8216 defines it as the peak segment bit rate (any run of segments lasting 0.5 to 1.5 target durations); Apple requires it within 10 % of the measured peak for VOD.${lowerBound ? ' Sizes were sampled, so the measured peaks are lower bounds.' : ''}`, { value: rows, expected: 'within 10 % of the peak' });
  },
});

defineRule({
  id: 'hls-average-bandwidth', scope: 'playlist', category: 'Delivery', severity: 'critical', spec: 'hlsAuth', clause: '9.14 AVERAGE-BANDWIDTH MUST be present; 1.26 VOD: within 10 % of the average segment bit rate',
  title: 'AVERAGE-BANDWIDTH present and right',
  applies: (p) => p.master && p.withVariant.length > 0,
  check: (p) => {
    const missing = p.withVariant.filter(({ v }) => v && v.averageBandwidth == null).map(({ pl }) => pl.label);
    if (missing.length) return fail(`No AVERAGE-BANDWIDTH on ${missing.join(', ')}`, 'Apple requires it on every variant (RFC 8216 makes it optional): players use it to estimate what a variant costs over time, and without it they fall back to the peak.', { value: missing });
    const off = [];
    const rows = [];
    for (const { v, pl } of p.withVariant) {
      if (!pl.average || pl.sampled) continue;
      rows.push({ variant: pl.label, declared: v.averageBandwidth, average: Math.round(pl.average) });
      if (Math.abs(pl.average - v.averageBandwidth) > v.averageBandwidth * 0.1) off.push(`${pl.label} declares ${fmtBitrate(v.averageBandwidth)}, its segments average ${fmtBitrate(pl.average)} (${pctOff(pl.average, v.averageBandwidth)})`);
    }
    return off.length
      ? (p.vod ? fail : warn)(off.join('; '), 'For VOD, Apple requires the average segment bit rate within 10 % of AVERAGE-BANDWIDTH.', { value: rows, expected: 'within 10 % of the average' })
      : pass(`AVERAGE-BANDWIDTH on every variant${rows.length ? ', within 10 % of the measured average' : ''}`, rows.length ? 'Declared and measured agree.' : 'Present; the average was not measured on every segment, so it was not compared.', { value: rows });
  },
});

defineRule({
  id: 'hls-codecs', scope: 'playlist', category: 'Delivery', severity: 'critical', spec: 'hlsAuth', clause: '9.1 CODECS MUST be present; RFC 8216 §4.3.4.2 it lists every format in the segments',
  title: 'CODECS names what the segments hold',
  applies: (p) => p.master && p.withVariant.length > 0,
  check: (p) => {
    const missing = p.withVariant.filter(({ v }) => v && !v.codecs?.length).map(({ pl }) => pl.label);
    if (missing.length) return fail(`No CODECS on ${missing.join(', ')}`, 'Without CODECS a player has to download a segment to learn whether it can play the variant at all.', { value: missing });
    const wrong = [];
    const close = [];
    let compared = 0;
    for (const { v, pl } of p.withVariant) {
      const found = [...new Set(pl.probes.flatMap((x) => [x.video?.codec, x.audio?.codec]).filter(Boolean))];
      for (const f of found) {
        compared++;
        const best = v.codecs.map((d) => codecMatch(d, f)).sort((a, b) => ['same', 'close', 'other'].indexOf(a) - ['same', 'close', 'other'].indexOf(b))[0] ?? 'other';
        if (best === 'other') wrong.push(`${pl.label}: segments hold ${f}, CODECS says ${v.codecs.join(',')}`);
        else if (best === 'close') close.push(`${pl.label}: ${f} in the segments, ${v.codecs.join(',')} declared`);
      }
    }
    if (wrong.length) return fail(listFew(wrong), 'CODECS must list every format in the variant\'s segments; a player that trusts it may pick a variant it cannot decode, or skip one it can.', { value: wrong });
    if (close.length) return warn(listFew(close), 'The same codec, profile and level, but the declared string differs in its constraint flags from the one the segments carry.', { value: close });
    return pass(compared ? 'CODECS matches the formats found in the segments' : 'CODECS present on every variant', compared ? 'Every format found in the probed segments is declared.' : 'No segment could be probed to compare.');
  },
});

defineRule({
  id: 'hls-resolution', scope: 'playlist', category: 'Delivery', severity: 'critical', spec: 'hlsAuth', clause: '9.2 RESOLUTION MUST be present on a variant with video',
  title: 'RESOLUTION present and matching',
  applies: (p) => p.master && p.withVariant.some(({ pl }) => p.video(pl)),
  check: (p) => {
    const missing = p.withVariant.filter(({ v, pl }) => v && !v.resolution && p.video(pl)).map(({ pl }) => pl.label);
    if (missing.length) return fail(`No RESOLUTION on ${missing.join(', ')}`, 'Players use RESOLUTION to avoid variants larger than the screen.', { value: missing });
    const off = p.withVariant.filter(({ v, pl }) => {
      const vid = p.video(pl);
      return vid?.width && v.resolution && (vid.width !== v.resolution.width || vid.height !== v.resolution.height);
    }).map(({ v, pl }) => `${pl.label} declares ${v.resolution.width}×${v.resolution.height}, the segments are ${p.video(pl).width}×${p.video(pl).height}`);
    return off.length ? warn(listFew(off), 'RESOLUTION should describe the pictures the variant carries.', { value: off }) : pass('RESOLUTION matches the pictures in every variant', 'What the playlist promises is what the segments show.');
  },
});

defineRule({
  id: 'hls-frame-rate', scope: 'playlist', category: 'Delivery', severity: 'critical', spec: 'hlsAuth', clause: '9.15 FRAME-RATE MUST be present on a variant with video; RFC 8216 §4.3.4.2 the maximum frame rate',
  title: 'FRAME-RATE present and matching',
  applies: (p) => p.master && p.withVariant.some(({ pl }) => p.video(pl)),
  check: (p) => {
    const missing = p.withVariant.filter(({ v, pl }) => v && v.frameRate == null && p.video(pl)).map(({ pl }) => pl.label);
    if (missing.length) return fail(`No FRAME-RATE on ${missing.join(', ')}`, 'Players use FRAME-RATE to avoid variants their display or decoder cannot keep up with.', { value: missing });
    const off = p.withVariant.filter(({ v, pl }) => {
      const fps = p.video(pl)?.fps;
      return fps && v.frameRate && Math.abs(fps - v.frameRate) / fps > 0.01;
    }).map(({ v, pl }) => `${pl.label} declares ${fmtNum(v.frameRate, 3)}, the segments run at ${fmtNum(p.video(pl).fps, 3)} fps`);
    return off.length ? warn(listFew(off), 'FRAME-RATE should be the frame rate of the video, rounded to three decimals.', { value: off }) : pass('FRAME-RATE matches the video in every variant', 'Declared and measured agree.');
  },
});

defineRule({
  id: 'hls-segment-durations', scope: 'playlist', category: 'Delivery', severity: 'critical', spec: 'rfc8216', clause: '§4.3.3.1 every EXTINF, rounded, at most TARGETDURATION; Apple 7.7 no segment more than 0.5 s over it',
  title: 'Segments within the target duration',
  applies: (p) => p.media.some((pl) => pl.parsed.targetDuration != null && pl.segments.length),
  check: (p) => {
    const off = [];
    let longest = 0;
    let n = 0;
    for (const pl of p.media) {
      const t = pl.parsed.targetDuration;
      if (t == null) continue;
      pl.segments.forEach((s, i) => {
        n++;
        longest = Math.max(longest, s.duration ?? 0);
        if (s.duration != null && (Math.round(s.duration) > t || s.duration > t + 0.5)) off.push(`${pl.label} segment ${i + 1}: ${fmtNum(s.duration, 3)} s, target ${t} s`);
      });
    }
    return off.length
      ? fail(listFew(off), 'A segment longer than the target duration can stall a player that plans its buffering by it.', { value: off.length })
      : pass(`${fmtInt(n)} segments within their target duration (longest ${fmtNum(longest, 3)} s)`, 'Players can plan their buffering by TARGETDURATION.', { value: longest });
  },
});

defineRule({
  id: 'hls-target-duration', scope: 'playlist', category: 'Delivery', severity: 'warning', spec: 'hlsAuth', clause: '7.5 target durations SHOULD be 6 seconds',
  title: 'A 6-second target duration',
  applies: (p) => p.media.some((pl) => pl.parsed.targetDuration != null),
  check: (p) => {
    const ts = [...new Set(p.media.filter((pl) => pl.role !== 'iframe').map((pl) => pl.parsed.targetDuration).filter((t) => t != null))];
    if (ts.every((t) => t === 6)) return pass('Target duration 6 s', 'As Apple recommends.', { value: 6 });
    if (p.intended?.length && ts.every((t) => p.intended.includes(t))) return pass(`Target duration ${ts.join(', ')} s, as the service intends`, 'Apple recommends 6 s; the service has chosen its own length.', { value: ts });
    return warn(`Target duration ${ts.join(', ')} s, Apple recommends 6 s`, 'Longer segments mean slower start-up and switching; shorter ones more requests.', { value: ts, expected: 6 });
  },
});

defineRule({
  id: 'hls-same-target', scope: 'playlist', category: 'Delivery', severity: 'critical', spec: 'rfc8216', clause: '§6.2.4 every media playlist of the variants MUST have the same target duration; Apple 8.2',
  title: 'One target duration across the variants',
  applies: (p) => p.media.filter((pl) => pl.role !== 'iframe').length >= 2,
  check: (p) => {
    const by = p.media.filter((pl) => pl.role !== 'iframe').map((pl) => `${pl.label} ${pl.parsed.targetDuration ?? '?'} s`);
    const set = new Set(p.media.filter((pl) => pl.role !== 'iframe').map((pl) => pl.parsed.targetDuration));
    return set.size === 1 ? pass(`Target duration ${[...set][0]} s in every playlist`, 'Switching keeps the same segment timing.') : fail(`Target durations differ: ${by.join(', ')}`, 'Variants with different target durations cannot be switched between cleanly.', { value: by });
  },
});

defineRule({
  id: 'hls-aligned', scope: 'playlist', category: 'Delivery', severity: 'critical', spec: 'hlsAuth', clause: '8.22 segment boundaries at the same times in every variant (SHOULD; MUST on AirPlay 2 TVs)',
  title: 'Segment boundaries aligned across variants',
  applies: (p) => p.variants.length >= 2,
  check: (p) => {
    const edges = (pl) => {
      let t = 0;
      return pl.segments.map((s) => (t += s.duration ?? 0));
    };
    const ref = p.variants[0];
    const a = edges(ref);
    for (const pl of p.variants.slice(1)) {
      const b = edges(pl);
      const n = Math.min(a.length, b.length);
      for (let i = 0; i < n; i++) {
        if (Math.abs(a[i] - b[i]) > 0.05) return fail(`Segment ${i + 1} ends at ${fmtNum(a[i], 3)} s in ${ref.label} and at ${fmtNum(b[i], 3)} s in ${pl.label}`, 'A player switching variants between segments lands on a different moment in the new one.', { value: i + 1 });
      }
      if (a.length !== b.length) return fail(`${ref.label} has ${a.length} segments, ${pl.label} ${b.length}`, 'Variants cut into different segments cannot be switched between at every boundary.');
    }
    return pass(`${plural(a.length, 'segment')} with the same boundaries in ${plural(p.variants.length, 'variant')}`, 'A player can switch at any segment boundary.');
  },
});

defineRule({
  id: 'hls-same-duration', scope: 'playlist', category: 'Delivery', severity: 'critical', spec: 'hlsAuth', clause: '8.3 and 8.7 every playlist covers the same duration of content',
  title: 'Every playlist covers the same duration',
  applies: (p) => p.media.filter((pl) => pl.role !== 'iframe').length >= 2,
  check: (p) => {
    const d = p.media.filter((pl) => pl.role !== 'iframe').map((pl) => ({ label: pl.label, s: pl.segments.reduce((sum, x) => sum + (x.duration ?? 0), 0) }));
    const lo = Math.min(...d.map((x) => x.s));
    const hi = Math.max(...d.map((x) => x.s));
    return hi - lo <= 0.05 ? pass(`Every playlist lasts ${fmtNum(lo, 3)} s`, 'Audio and video, and every variant, end together.', { value: lo }) : fail(`Playlists last ${d.map((x) => `${x.label} ${fmtNum(x.s, 3)} s`).join(', ')}`, 'Playlists of different lengths end playback early on some variants.', { value: d });
  },
});

defineRule({
  id: 'hls-playlist-type', scope: 'playlist', category: 'Delivery', severity: 'critical', spec: 'hlsAuth', clause: '8.6 VOD media playlists MUST carry EXT-X-PLAYLIST-TYPE:VOD',
  title: 'VOD playlists say so',
  applies: (p) => p.media.some((pl) => pl.parsed.endList),
  check: (p) => {
    const missing = p.media.filter((pl) => pl.parsed.endList && pl.parsed.playlistType !== 'VOD').map((pl) => pl.label);
    return missing.length ? fail(`EXT-X-ENDLIST without EXT-X-PLAYLIST-TYPE:VOD in ${missing.join(', ')}`, 'Without the type a player keeps reloading the playlist as if it could still change.', { value: missing }) : pass('Every finished playlist is marked VOD', 'Players load each playlist once.');
  },
});

defineRule({
  id: 'hls-iframes', scope: 'playlist', category: 'Delivery', severity: 'critical', spec: 'hlsAuth', clause: '6.1 I-frame playlists MUST be provided for scrubbing and scanning',
  title: 'I-frame playlists for scrubbing',
  applies: (p) => !!p.master,
  check: (p) => (p.master.iframes.length ? pass(`${plural(p.master.iframes.length, 'I-frame playlist')}`, 'Players can show pictures while scrubbing and fast-forward smoothly.', { value: p.master.iframes.length }) : fail('No I-frame playlists (EXT-X-I-FRAME-STREAM-INF)', 'Without them, scrubbing on Apple devices shows no picture and fast-forward has to download whole segments.')),
});

defineRule({
  id: 'hls-starts-idr', scope: 'playlist', category: 'Delivery', severity: 'critical', spec: 'hlsAuth', clause: '7.4 video segments MUST start with an IDR frame',
  title: 'Segments start with a key frame',
  applies: (p) => p.media.some((pl) => pl.probes.some((x) => x.video)),
  check: (p) => {
    const bad = [];
    let n = 0;
    for (const pl of p.media) {
      for (const x of pl.probes) {
        if (!x.video) continue;
        n++;
        if (x.video.keyFirst === false) bad.push(`${pl.label} segment ${x.index + 1}`);
      }
    }
    return bad.length ? fail(`Not starting with a key frame: ${listFew(bad)}`, 'A segment that does not start with a key frame cannot be decoded on its own: switching or seeking to it shows garbage or waits for the next key frame.', { value: bad }) : pass(`${plural(n, 'probed segment')} each start with a key frame`, 'Every segment decodes on its own.', { value: n });
  },
});

defineRule({
  id: 'hls-independent', scope: 'playlist', category: 'Delivery', severity: 'warning', spec: 'hlsAuth', clause: '9.11 with segments starting at an IDR, EXT-X-INDEPENDENT-SEGMENTS SHOULD be in the multivariant playlist',
  title: 'Independent segments declared',
  applies: (p) => p.master && p.media.some((pl) => pl.probes.some((x) => x.video)) && p.media.every((pl) => pl.probes.every((x) => !x.video || x.video.keyFirst !== false)),
  check: (p) => (p.master.independentSegments ? pass('EXT-X-INDEPENDENT-SEGMENTS declared', 'Players may start and switch at any segment without looking further back.') : warn('No EXT-X-INDEPENDENT-SEGMENTS, though the segments start with key frames', 'Declaring it lets players switch at any segment without first reading the previous one.')),
});

defineRule({
  id: 'hls-version', scope: 'playlist', category: 'Delivery', severity: 'critical', spec: 'rfc8216', clause: '§7 EXT-X-VERSION MUST cover what the playlist uses; PROGRAM-ID was removed in version 6',
  title: 'EXT-X-VERSION matches the tags used',
  applies: (p) => p.m.playlists.some((pl) => pl.parsed) || !!p.master,
  check: (p) => {
    const bad = [];
    const all = [...(p.master ? [{ label: 'multivariant playlist', parsed: p.master }] : []), ...p.m.playlists.filter((pl) => pl.parsed)];
    for (const { label, parsed } of all) {
      const v = parsed.version ?? 1;
      if (v < parsed.needsVersion) bad.push(`${label}: version ${v}, its tags need ${parsed.needsVersion}`);
      if (parsed.programId && v >= 6) bad.push(`${label}: PROGRAM-ID at version ${v}`);
      if (parsed.allowCache && v >= 7) bad.push(`${label}: EXT-X-ALLOW-CACHE at version ${v}`);
    }
    return bad.length ? fail(listFew(bad), 'A client reads a playlist by the protocol version it declares; one that uses newer tags than it declares, or tags its version removed, can be misread.', { value: bad }) : pass('Every playlist declares a version that covers its tags', p.master?.programId ? 'PROGRAM-ID is still written; it is legal at this version, and was removed in version 6.' : 'Nothing is used that the declared version does not allow.');
  },
});

/**
 * Audit a presentation measured by measureHls (web/core/hls.js): the multivariant playlist's
 * declarations against the media playlists and the segments. Returns { checks, facts }.
 */
export function auditPlaylist(m, expect = {}) {
  const ex = { ...DEFAULT_EXPECT, ...expect };
  const master = m.master;
  const media = m.playlists.filter((pl) => pl.parsed && !pl.error);
  const variants = media.filter((pl) => pl.role === 'variant');
  const video = (pl) => pl.probes.find((x) => x.video)?.video ?? null;
  const p = {
    m, ex, master, media, variants, video,
    intended: expect.segments ?? null, // the service's own segment lengths, not the defaults
    withVariant: variants.map((pl) => ({ pl, v: master && pl.variant != null ? master.variants[pl.variant] : null })).filter(({ v }) => !master || v),
    vod: variants.length > 0 && variants.every((pl) => pl.parsed.playlistType === 'VOD' || pl.parsed.endList),
  };
  const checks = [];
  for (const r of PLAYLIST_RULES) {
    let res = null;
    try {
      if (r.applies(p)) res = r.check(p);
    } catch (e) {
      res = { level: 'skip', title: `${r.title}: not checked`, text: String(e?.message ?? e) };
    }
    if (res) checks.push(finish(r, res, ex.overlay));
  }
  const facts = {
    url: redact(m.url),
    requests: m.requests,
    kind: master ? 'multivariant' : 'media',
    variants: m.playlists.map((pl) => {
      const v = master && pl.role === 'variant' && pl.variant != null ? master.variants[pl.variant] : null;
      const vid = video(pl);
      return {
        label: pl.label, role: pl.role, url: redact(pl.url), error: pl.error ?? null,
        declared: v ? { bandwidth: v.bandwidth, averageBandwidth: v.averageBandwidth, codecs: v.codecs, resolution: v.resolution, frameRate: v.frameRate } : null,
        measured: {
          segments: pl.segments.length, sized: pl.sized, sampled: pl.sampled,
          targetDuration: pl.parsed?.targetDuration ?? null,
          duration: pl.segments.reduce((sum, s) => sum + (s.duration ?? 0), 0),
          peak: pl.peak ? Math.round(pl.peak.rate) : null,
          average: pl.average ? Math.round(pl.average) : null,
          video: vid ? { codec: vid.codec, width: vid.width, height: vid.height, fps: vid.fps } : null,
          audio: pl.probes.find((x) => x.audio)?.audio ?? null,
        },
      };
    }),
  };
  return { checks, facts };
}

// ====================================================================== running the rules

/** "44.1 kHz", "48,000 Hz" or "48000 / s" -> hertz; the number before the unit, nothing else. */
function rateFromText(text) {
  const m = /^\s*([\d,]+(?:\.\d+)?)\s*(k?)Hz/i.exec(text ?? '');
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ''));
  return Number.isFinite(n) && n > 0 ? Math.round(n * (m[2] ? 1000 : 1)) : null;
}

/** "2 channels: L R", "5.1", "mono", "stereo" -> a channel count. */
function channelsFromText(text) {
  const t = String(text ?? '').trim().toLowerCase();
  if (!t) return null;
  if (/^mono\b/.test(t)) return 1;
  if (/^stereo\b/.test(t)) return 2;
  const lfe = /^(\d+)\.(\d)\b/.exec(t);
  if (lfe) return Number(lfe[1]) + Number(lfe[2]);
  const n = /^(\d+)\s*(?:ch|channel)/.exec(t) ?? /^(\d+)$/.exec(t);
  return n ? Number(n[1]) : null;
}

function firstMediaTime(tbl) {
  const big = tbl.entrySize === 20;
  for (let i = 0; i < tbl.count; i++) {
    const p = tbl.rel + i * tbl.entrySize;
    const media = big ? Number(tbl.dv.getBigInt64(p + 8)) : tbl.dv.getInt32(p + 4);
    if (media >= 0) return media;
  }
  return 0;
}

/**
 * Read frame types for the whole track, or, under a byte budget, for a few windows of GOPs: the
 * first two, then GOPs spread evenly over the file. Sample tables already give key frames,
 * sizes and times; the payload is only needed for I/P/B types, open GOPs and IDR checks.
 * Returns how much of the track was covered.
 */
async function scanFrames(it, budget, onProgress) {
  const ft = it.ft;
  if (!ft?.ctx || ft.complete) return { sampled: '', gops: null, of: null };
  const s = it.video.samples;
  if (!budget || ft.scanBytes <= budget) {
    await ft.ensure();
    return { sampled: '', gops: null, of: null };
  }
  const keys = [];
  for (let i = 0; i < s.count; i++) if (!s.key || s.key[i]) keys.push(i);
  if (keys[0] !== 0) keys.unshift(0);
  keys.push(s.count);
  const gopBytes = (k) => {
    let b = 0;
    for (let i = keys[k]; i < keys[k + 1]; i++) b += s.sizes[i];
    return b;
  };
  const n = keys.length - 1;
  // A window is a GOP, or the start of one when a single GOP is bigger than what is left: the
  // IDR and the frames after it are what the open-GOP and IDR checks look at.
  const windows = new Map(); // gop index -> [from, to)
  let spent = 0;
  let full = 0;
  const take = (k) => {
    if (windows.has(k) || spent >= budget) return false;
    let to = keys[k];
    let bytes = 0;
    // GOP 0 always yields its first frame, whatever the budget; every other window stays
    // inside what is left.
    while (to < keys[k + 1] && (spent + bytes + s.sizes[to] <= budget || (k === 0 && to === keys[0]))) bytes += s.sizes[to++];
    if (to === keys[k]) return false;
    windows.set(k, [keys[k], to]);
    if (to === keys[k + 1]) full++;
    spent += bytes;
    return true;
  };
  take(0);
  if (n > 1) take(1);
  // Then evenly over the file: as many GOPs as the budget affords, spaced out, and a finer
  // pass over what is left, so a long file is sampled from beginning to end rather than
  // read from the front until the budget runs out.
  const avg = Math.max(1, ft.scanBytes / n);
  const afford = Math.max(1, Math.floor((budget - spent) / avg));
  let step = Math.max(1, Math.floor((n - 2) / afford));
  while (step >= 1 && spent < budget && windows.size < n) {
    for (let k = 2 + step - 1; k < n && spent < budget; k += step) take(k);
    if (step === 1) break;
    step = Math.floor(step / 2);
  }
  for (const [, [from, to]] of [...windows].sort((a, b) => a[0] - b[0])) await ft.ensure(from, to);
  onProgress?.(windows.size, n, 'frame types (sampled GOPs)');
  const partial = windows.size - full;
  const ranges = [...windows].sort((a, b) => a[0] - b[0]).map(([, [from, to]]) => [s.offsets[from], s.offsets[to - 1] + s.sizes[to - 1]]);
  return { sampled: ` (${full} of ${n} GOPs read${partial ? `, ${partial} more in part` : ''})`, gops: windows.size, full, of: n, ranges };
}

/**
 * Audit one open document. Options: expect (see DEFAULT_EXPECT), measured ({ loudness:
 * { integrated, truePeak }, sync: { audioLateMs }, quality: { psnr, ssim, vmaf } } from the
 * caller's ffmpeg runs), payloadBudget (bytes of frame data to read; the sample tables are
 * always read in full), onProgress.
 */
export async function auditFile(doc, expect = {}, { onProgress, measured = {}, payloadBudget = 0 } = {}) {
  if (doc.format?.id === 'raw') return unsupported(doc);
  const ex = { ...DEFAULT_EXPECT, ...expect };
  const it = await summarize(doc, { onProgress, scan: false });
  const scan = it.video ? await scanFrames(it, payloadBudget, onProgress) : { sampled: '' };
  if (it.ft) it.frames = analyzeFrames(it.ft);
  const insights = await doc.insights().catch(() => []);
  const videos = doc.tracks.filter((t) => t.kind === 'video');
  const audios = doc.tracks.filter((t) => t.kind === 'audio');
  const v = it.video;
  const a = audios[0] ?? null;
  const vi = v ? videoInfo(doc, v) : {};
  const an = it.frames ?? null;
  const c = {
    doc, it, ex, measured, insights, videos, audios, v, a, vi, an,
    sampled: scan.sampled,
    gop: an?.gop && an.gop.count >= 1 ? an.gop : null,
    gopShape: an?.gops?.length && v ? gopShape(an, v) : null,
    mp4: null, lvl: null, sei: null, parsed: null, rc: null, colour: null, audio: null,
    entryOffset: v?.entryNode?.offset ?? v?.node?.offset,
    seiOffset: undefined,
    peakSample: 0,
    insight: (re) => insights.find((i) => re.test(i.title)),
    gopOffset: (seconds) => {
      const g = an?.gops?.find((x) => x.seconds === seconds);
      return g ? v.samples.offsets[g.start] : undefined;
    },
  };
  if (doc.format?.id === 'isobmff') {
    const kids = doc.root.children ?? [];
    c.mp4 = { ftyp: kids.find((n) => n.type === 'ftyp'), moov: kids.find((n) => n.type === 'moov'), mdat: kids.find((n) => n.type === 'mdat'), moof: kids.find((n) => n.type === 'moof'), moofs: kids.filter((n) => n.type === 'moof') };
  }
  if (v) {
    c.lvl = checkLevel({ codec: vi.family, width: vi.codedWidth, height: vi.codedHeight, fps: vi.fps, bitrate: vi.bitrate, frames: vi.frames, profile: vi.profile, level: vi.level, tier: vi.tier, constraintSet3: vi.constraintSet3, refs: vi.refs, dpb: vi.dpb });
    c.sei = await encoderSei(doc, v, vi).catch(() => null);
    if (c.sei) {
      c.parsed = parseX26x(c.sei.text);
      c.rc = rateControl(c.parsed, vi.bitrate);
      c.seiOffset = c.sei.offset;
    }
    const vui = vi.sps?.vui;
    const colr = v.entry?.colr;
    if (vui && vui.primaries !== undefined) c.colour = { primaries: vui.primaries, transfer: vui.transfer, matrix: vui.matrix, where: 'SPS VUI' };
    else if (colr && colr.primaries !== undefined) c.colour = { primaries: colr.primaries, transfer: colr.transfer, matrix: colr.matrix, where: 'colr box' };
    if (c.colour) c.colour.text = `${c.colour.primaries}/${c.colour.transfer}/${c.colour.matrix}`;
    if (it.rate) c.peakSample = peakSampleIndex(v, it.rate.peakAt);
  }
  if (a) {
    const props = Object.fromEntries(a.props ?? []);
    const asc = a.entry?.esds?.asc ?? null;
    c.audio = {
      codec: audioCodecName(a),
      sampleRate: asc?.extSampleRate || asc?.sampleRate || a.entry?.sampleRate || a.sampleRate || rateFromText(props['sample rate']),
      channels: asc?.channels || a.entry?.channels || a.channels || channelsFromText(props.channels),
      bitrate: a.bitrate ?? null,
    };
  }
  const checks = [];
  for (const r of RULES) {
    let res = null;
    try {
      if (r.applies(c)) res = r.check(c);
      else if (r.unmeasured) {
        const why = r.unmeasured(c);
        if (why) res = { level: 'skip', title: `${r.title}: not measured`, text: why };
      }
    } catch (e) {
      res = { level: 'skip', title: `${r.title}: not checked`, text: String(e?.message ?? e) };
    }
    if (res) checks.push(finish(r, res, ex.overlay));
  }
  const facts = {
    name: doc.name, size: doc.size, format: doc.format?.id ?? null, duration: it.duration ?? null,
    bytesRead: doc.source?.stats?.bytes ?? null,
    payload: scan.gops != null ? { gopsRead: scan.gops, gopsFull: scan.full, gops: scan.of, ranges: scan.ranges } : null,
    index: c.mp4?.moov ? { offset: c.mp4.moov.offset, size: c.mp4.moov.size } : null,
    video: v ? { codec: videoCodecName(it), width: vi.width, height: vi.height, fps: it.fps, profile: vi.profileName ?? null, level: vi.level ?? null, levelName: c.lvl?.signalled?.name ?? null, depth: vi.depth ?? null, bitrate: it.rate?.avg ?? null, peak: it.rate?.peak ?? null, gop: c.gopShape?.seconds ?? c.gop?.avgSeconds ?? null, bpp: it.bpp ?? null, colour: c.colour?.text ?? null, timescale: v.timescale ?? null } : null,
    audio: c.audio,
    encoder: c.parsed ? { label: c.parsed.label, version: c.parsed.version, crf: c.rc?.crf ?? null, maxrate: c.rc?.maxrate ?? null, bufsize: c.rc?.bufsize ?? null, keyint: c.parsed.get('keyint') ?? null } : null,
  };
  return { file: doc.name, facts, checks, item: it };
}

/**
 * A file no parser reads (a playlist, an image, an unknown format): one statement that it was
 * not audited, rather than every rule failing on a file with no tracks. `unsupported` names it.
 */
async function unsupported(doc) {
  const head = await doc.source.read(0, Math.min(doc.size, 16)).catch(() => new Uint8Array(0));
  const guess = identify(head);
  const what = guess?.label ?? 'an unrecognised format';
  const text = /playlist|manifest/i.test(what)
    ? 'This audit reads media files. Playlists and manifests (HLS, DASH) are not audited yet: audit the renditions they point at.'
    : 'This audit reads MP4/MOV, Matroska/WebM, MPEG-TS, AVI and FLV files; this one has no parser, so no rule could be applied.';
  const check = { id: 'input', category: 'Container', level: 'skip', title: `Not audited: ${what}`, text, spec: 'practice', clause: 'audit scope' };
  const facts = { name: doc.name, size: doc.size, format: 'raw', duration: null, bytesRead: doc.source?.stats?.bytes ?? null, payload: null, index: null, video: null, audio: null, encoder: null };
  return { file: doc.name, unsupported: what, facts, checks: [check], item: null };
}

function finish(rule, res, overlay = null) {
  // A check may name a more specific source than its rule (the level tables of the codec at hand).
  const out = { id: rule.id, category: rule.category, level: res.level, title: res.title, text: res.text, spec: res.spec ?? rule.spec, clause: res.clause ?? rule.clause ?? null };
  // A service may promote or demote a rule's severity (expect.overlay.severity[id]). Without an
  // overlay a critical rule's soft finding (warn) stays a WARNING; with one, the service has
  // said what any finding of that rule means to it, and every warn or fail takes that severity.
  const set = overlay?.severity?.[rule.id];
  const severity = set ?? rule.severity;
  if (res.level === 'warn' || res.level === 'fail') {
    if (set) out.severity = set === 'critical' ? 'CRITICAL' : set === 'info' ? 'INFO' : 'WARNING';
    else out.severity = severity === 'critical' && res.level === 'fail' ? 'CRITICAL' : severity === 'info' ? 'INFO' : 'WARNING';
  }
  for (const k of ['value', 'expected', 'offset']) if (res[k] !== undefined) out[k] = res[k];
  if (out.severity) {
    const rem = remedyFor(rule.id);
    if (rem) out.remedy = rem;
  }
  return out;
}

/**
 * The usual GOP (the most common length in frames, the last GOP left out as a file usually ends
 * inside one) and the GOPs of other lengths, with where they start (seconds from the first frame).
 */
function gopShape(an, v) {
  const full = an.gops.filter((g) => !g.partial);
  const counted = full.length > 1 ? full.slice(0, -1) : full;
  if (!counted.length) return null;
  const tally = new Map();
  for (const g of counted) tally.set(g.frames, (tally.get(g.frames) ?? 0) + 1);
  let frames = 0;
  let most = 0;
  for (const [f, k] of tally) {
    if (k > most || (k === most && f > frames)) {
      frames = f;
      most = k;
    }
  }
  const usual = counted.filter((g) => g.frames === frames);
  const s = v.samples;
  const ts = v.timescale || s.timescale || 1;
  const at = (g) => (s.dts ? (s.dts[g.start] - s.dts[0]) / ts : 0);
  return {
    frames,
    seconds: usual.reduce((sum, g) => sum + g.seconds, 0) / usual.length,
    count: counted.length,
    odd: counted.filter((g) => g.frames !== frames).map((g) => ({ start: g.start, frames: g.frames, seconds: g.seconds, at: at(g) })),
  };
}

/**
 * The segment length a packager would use for this file: the shortest expected length that is
 * not shorter than the usual GOP, else the GOP itself.
 */
function segmentLength(c) {
  const gop = c.gopShape?.seconds;
  if (!gop) return c.ex.segments?.length ? Math.max(...c.ex.segments) : 6;
  const fits = (c.ex.segments ?? []).filter((len) => len >= gop - 0.05).sort((p, q) => p - q);
  return fits[0] ?? gop;
}

/**
 * The busiest segment when the video track is cut into segments of `len` seconds at key frames
 * (see packagerCuts), in bits per second, with where it starts. Segments shorter than half the
 * length are left out (RFC 8216 measures the peak over segments of 0.5–1.5 target durations).
 */
function segmentPeak(v, len) {
  const s = v.samples;
  if (!s?.dts || !s.sizes || s.count < 2) return null;
  const ts = v.timescale || s.timescale || 1;
  const time = (i) => (s.dts[i] - s.dts[0]) / ts;
  const last = s.count - 1;
  const end = time(last) + (s.durations?.[last] ?? 0) / ts;
  const tol = end / s.count / 2 + 0.001;
  let best = null;
  let from = 0;
  let bits = 0;
  let cuts = 1;
  const close = (to) => {
    const seconds = to - time(from);
    if (seconds >= len / 2 && (!best || bits / seconds > best.rate)) best = { rate: bits / seconds, at: time(from), start: from, seconds };
  };
  for (let i = 0; i < s.count; i++) {
    if (i > from && (!s.key || s.key[i]) && time(i) >= cuts * len - tol) {
      close(time(i));
      from = i;
      bits = 0;
      cuts++;
    }
    bits += s.sizes[i] * 8;
  }
  close(end);
  return best;
}

/** The first sample of the busiest second (rateStats counts seconds from the first decode time). */
function peakSampleIndex(v, peakAt) {
  const s = v.samples;
  const ts = v.timescale || s.timescale || 1;
  if (!s.dts) return 0;
  for (let i = 0; i < s.count; i++) if ((s.dts[i] - s.dts[0]) / ts >= peakAt) return i;
  return 0;
}

/** Audit a ladder: the per-file results of every version of one content, in any order. */
export function auditLadder(results, expect = {}) {
  const ex = { ...DEFAULT_EXPECT, ...expect };
  const withVideo = results.filter((r) => r.item?.video);
  const items = withVideo.map((r) => r.item);
  const byHeight = [...withVideo].sort((p, q) => (q.facts.video.height ?? 0) - (p.facts.video.height ?? 0) || (q.facts.video.bitrate ?? 0) - (p.facts.video.bitrate ?? 0));
  const l = { results, items, byHeight, ex, top: byHeight.length ? items.indexOf(byHeight[0].item) : 0 };
  const checks = [];
  for (const r of LADDER_RULES) {
    let res = null;
    try {
      if (r.applies(l)) res = r.check(l);
    } catch (e) {
      res = { level: 'skip', title: `${r.title}: not checked`, text: String(e?.message ?? e) };
    }
    if (res) checks.push(finish(r, res, ex.overlay));
  }
  return { files: results.map((r) => r.file), checks };
}

/**
 * Counts by level, and a compliance figure: passed ÷ checks with a verdict (passed, warned or
 * failed). Information and checks that could not run (skip) are left out of it and counted
 * on their own, so a report never reads 100 % while it has findings.
 */
export function tally(checks) {
  const t = { pass: 0, warn: 0, fail: 0, info: 0, skip: 0, critical: 0, warning: 0 };
  for (const c of checks) {
    t[c.level] = (t[c.level] ?? 0) + 1;
    if (c.severity === 'CRITICAL') t.critical++;
    else if (c.severity === 'WARNING') t.warning++;
  }
  const judged = t.pass + t.warn + t.fail;
  t.compliance = judged ? t.pass / judged : null;
  return t;
}

/** A Markdown report of the audited files and their ladders (one, several, or none). */
export function auditMarkdown(results, ladders = null, { title = 'Vidscope audit', playlists = [] } = {}) {
  const list = Array.isArray(ladders) ? ladders : ladders ? [ladders] : [];
  const lines = [`# ${title}`, ''];
  const mark = { pass: '✓', warn: '⚠', fail: '✗', info: 'ℹ', skip: '–' };
  const all = [...results.flatMap((r) => r.checks), ...list.flatMap((l) => l.checks ?? []), ...playlists.flatMap((p) => p.checks ?? [])];
  const t = tally(all);
  const counted = [results.length ? plural(results.length, 'file') : null, playlists.length ? plural(playlists.length, 'playlist') : null].filter(Boolean).join(' and ') || 'nothing';
  lines.push(`${counted}: ${t.fail} failed (${t.critical} critical), ${t.warn} warnings, ${t.pass} passed${t.compliance !== null ? `; ${fmtNum(t.compliance * 100, 1)} % of the checks with a verdict pass` : ''}${t.skip ? `; ${plural(t.skip, 'check')} not run (see "not measured")` : ''}.`, '');
  const line = (c) => `- ${mark[c.level]} **${c.title}** — ${c.text}${c.remedy ? `\n  - fix: ${c.remedy.fix}` : ''} _(${SPECS[c.spec]?.name ?? c.spec}${c.clause ? `, ${c.clause}` : ''})_`;
  for (const l of list) {
    if (!l.checks?.length) continue;
    lines.push(list.length > 1 || l.files?.length ? `## Ladder: ${(l.files ?? []).join(', ')}` : '## Ladder', '');
    for (const c of l.checks) lines.push(line(c));
    lines.push('');
  }
  const order = ['fail', 'warn', 'pass', 'info', 'skip'];
  for (const p of playlists) {
    lines.push(`## Playlist: ${p.file ?? p.facts?.url}`, '');
    const rows = (p.facts?.variants ?? []).filter((v) => v.role === 'variant');
    if (rows.length) {
      lines.push('| Variant | BANDWIDTH | measured peak | AVERAGE-BANDWIDTH | measured average | segments | target |', '| --- | --- | --- | --- | --- | --- | --- |');
      for (const v of rows) {
        const d = v.declared ?? {};
        const m = v.measured ?? {};
        const rate = (x) => (x == null ? '—' : fmtBitrate(x));
        lines.push(`| ${v.label} | ${rate(d.bandwidth)} | ${rate(m.peak)}${m.sampled ? ' (sampled)' : ''} | ${rate(d.averageBandwidth)} | ${rate(m.average)} | ${m.sized} of ${m.segments} | ${m.targetDuration ?? '—'} s |`);
      }
      lines.push('');
    }
    for (const lvl of order) for (const c of p.checks.filter((x) => x.level === lvl)) lines.push(line(c));
    lines.push('');
  }
  for (const r of results) {
    const f = r.facts;
    lines.push(`## ${r.file}`, '');
    if (r.error) {
      lines.push(`Could not be audited: ${r.error}`, '');
      continue;
    }
    const bits = [];
    if (f.video) bits.push(`${f.video.codec} ${f.video.width}×${f.video.height} ${f.video.fps ? `${fmtNum(f.video.fps, 3)} fps` : ''} ${f.video.profile ?? ''}${f.video.levelName ? ` level ${f.video.levelName}` : ''}`.replace(/\s+/g, ' ').trim(), `${fmtBitrate(f.video.bitrate)} average`);
    if (f.audio) bits.push(`${f.audio.codec}${f.audio.sampleRate ? ` ${fmtInt(f.audio.sampleRate)} Hz` : ''}${f.audio.channels ? ` ${plural(f.audio.channels, 'channel')}` : ''}${f.audio.bitrate ? ` ${fmtBitrate(f.audio.bitrate)}` : ''}`);
    if (f.duration) bits.push(fmtDuration(f.duration));
    if (f.bytesRead) bits.push(`${fmtNum(f.bytesRead / 1048576, 1)} MB read${f.payload ? ` (${f.payload.gopsRead} of ${f.payload.gops} GOPs)` : ''}`);
    lines.push(bits.join(' · '), '');
    for (const lvl of order) for (const c of r.checks.filter((x) => x.level === lvl)) lines.push(line(c));
    lines.push('');
  }
  lines.push('## Sources', '');
  const used = new Set(all.map((c) => c.spec));
  for (const k of Object.keys(SPECS)) if (used.has(k)) lines.push(`- ${SPECS[k].name}: ${SPECS[k].url}`);
  return lines.join('\n');
}

// The keys the rules read. A misspelt key would silently check nothing, so it is an error.
export const EXPECT_KEYS = {
  gop: 'number', gopMax: 'number', fpsMax: 'number', fpsMin: 'number', peakRatio: 'number', segments: 'array',
  colour: { primaries: 'number', transfer: 'number', matrix: 'number' },
  audio: { required: 'boolean', codec: 'string', sampleRate: 'number', channelsMax: 'number', minBitratePerChannel: 'number' },
  loudness: { integrated: 'number', tolerance: 'number', truePeakMax: 'number' },
  overlay: { severity: 'object', levelCap: 'array' },
};

/** Throw on a key the rules do not read, or a value of the wrong kind; keys starting with _ are comments. */
export function validateExpect(ex, shape = EXPECT_KEYS, path = '') {
  for (const [k, v] of Object.entries(ex ?? {})) {
    if (k.startsWith('_')) continue;
    const want = shape[k];
    const at = path ? `${path}.${k}` : k;
    if (want === undefined) throw new Error(`unknown expectation ${at} (known: ${Object.keys(shape).join(', ')})`);
    if (typeof want === 'object') {
      if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(`${at} wants an object`);
      validateExpect(v, want, at);
    } else if (want === 'array' ? !Array.isArray(v) : typeof v !== want) throw new Error(`${at} wants ${want === 'array' ? 'a list' : `a ${want}`}, got ${JSON.stringify(v)}`);
  }
  return ex;
}

/** Merge b into a: nested plain objects merge, everything else is replaced. */
export function mergeExpect(a, b) {
  for (const [k, v] of Object.entries(b ?? {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && a[k] && typeof a[k] === 'object' && !Array.isArray(a[k])) mergeExpect(a[k], v);
    else a[k] = v;
  }
  return a;
}

/**
 * The JSON report (docs/audit-report.schema.json) of audited files and ladders. Runs in the
 * browser and in Node; `version` and `generated` come from the caller.
 */
export function buildReport({ results, ladders = [], playlists = [] }, { expect = {}, version = null, generated = new Date().toISOString() } = {}) {
  const all = [...results.flatMap((r) => r.checks ?? []), ...ladders.flatMap((l) => l.checks ?? []), ...playlists.flatMap((p) => p.checks ?? [])];
  return {
    tool: { name: 'vidscope', command: 'audit', version },
    generated,
    expect: mergeExpect(structuredClone(DEFAULT_EXPECT), expect),
    summary: { ...tally(all), errors: results.filter((r) => r.error).length },
    files: results.map((r) => ({ input: r.input, file: r.file, ms: r.ms, ...(r.error ? { error: r.error, reason: r.reason } : {}), facts: r.facts, checks: r.checks ?? [] })),
    ladders: ladders.map((l) => ({ files: l.files, inputs: l.inputs, checks: l.checks })),
    playlists: playlists.map((p) => ({ input: redact(p.input), file: p.file, ms: p.ms, facts: p.facts, checks: p.checks })),
    specs: SPECS,
  };
}

/**
 * SARIF 2.1.0: one result per warning or failure, the input as the artifact, the byte offset
 * as the region. `uriFor(input)` turns an input into an artifact URI (the CLI makes file: URLs).
 */
export function toSarif(report, { uriFor = (input) => input } = {}) {
  const rules = allRules();
  const results = [];
  const emit = (inputs, c) => {
    if (!c.severity) return;
    results.push({
      ruleId: c.id,
      level: c.severity === 'CRITICAL' ? 'error' : c.severity === 'WARNING' ? 'warning' : 'note',
      message: { text: `${c.title}. ${c.text}${c.remedy ? ` Fix: ${c.remedy.fix}` : ''}` },
      locations: inputs.map((input) => ({ physicalLocation: { artifactLocation: { uri: uriFor(input) }, ...(inputs.length === 1 && c.offset !== undefined ? { region: { byteOffset: c.offset } } : {}) } })),
      properties: { value: c.value, expected: c.expected, spec: SPECS[c.spec]?.name, clause: c.clause },
    });
  };
  for (const f of report.files) for (const c of f.checks) emit([f.input ?? f.file], c);
  for (const l of report.ladders) for (const c of l.checks) emit(l.inputs ?? l.files, c);
  for (const p of report.playlists ?? []) for (const c of p.checks) emit([p.input], c);
  return {
    version: '2.1.0',
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    runs: [{
      tool: { driver: { name: 'vidscope audit', version: report.tool.version ?? '0', rules: rules.map((r) => ({ id: r.id, name: r.title, shortDescription: { text: r.title }, helpUri: SPECS[r.spec]?.url, properties: { category: r.category, severity: r.severity, clause: r.clause } })) } },
      results,
    }],
  };
}
