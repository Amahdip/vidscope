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
  priming: { name: 'Apple: audio priming, handling encoder delay in AAC', url: 'https://developer.apple.com/documentation/quicktime-file-format/audio_priming_-_handling_encoder_delay_in_aac' },
  bt1359: { name: 'ITU-R BT.1359, relative timing of sound and vision', url: 'https://www.itu.int/rec/R-REC-BT.1359' },
  r128: { name: 'EBU R 128, loudness normalisation', url: 'https://tech.ebu.ch/publications/r128' },
  practice: { name: 'Common encoding practice (Apple ladder, Netflix, Streaming Learning Center)', url: 'https://streaminglearningcenter.com' },
};

/**
 * Expectations a service can set on its outputs. Everything is optional.
 *   gop: seconds between key frames (exact); gopMax: the longest allowed
 *   fpsMax, fpsMin: the frame-rate range; peakRatio: busiest second ÷ average, at most
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

/** Register a rule; returns it. Rules run in registration order. */
export function defineRule(def) {
  (def.scope === 'ladder' ? LADDER_RULES : RULES).push(def);
  return def;
}

/** Every rule, for documentation and for a rule matrix. */
export function allRules() {
  return [...RULES, ...LADDER_RULES].map((r) => ({ id: r.id, scope: r.scope ?? 'file', category: r.category, severity: r.severity, spec: r.spec, clause: r.clause ?? null, title: r.title, remedy: remedyFor(r.id) }));
}

const pass = (title, text, extra) => ({ level: 'pass', title, text, ...extra });
const warn = (title, text, extra) => ({ level: 'warn', title, text, ...extra });
const fail = (title, text, extra) => ({ level: 'fail', title, text, ...extra });
const info = (title, text, extra) => ({ level: 'info', title, text, ...extra });

// ====================================================================== container

defineRule({
  id: 'fast-start', category: 'Container', severity: 'critical', spec: 'hlsAuth', clause: 'progressive playback; ISO 14496-12 §8.1',
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
  id: 'interleaved', category: 'Container', severity: 'warning', spec: 'isobmff', clause: '§8.7 chunk interleaving',
  title: 'Audio and video chunks alternate',
  applies: (c) => !!c.insight(/^(Poorly interleaved|Interleaved)/),
  check: (c) => {
    const i = c.insight(/^(Poorly interleaved|Interleaved)/);
    return i.level === 'warn' ? warn(i.title, 'Chunks far apart force a player to read far ahead or to seek; remux to interleave.', { offset: i.offset }) : pass(i.title, 'A player needs no large read-ahead.');
  },
});

defineRule({
  id: 'edit-list', category: 'Container', severity: 'warning', spec: 'isobmff', clause: '§8.6.6 edit lists',
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
  id: 'one-video-track', category: 'Container', severity: 'critical', spec: 'hlsAuth', clause: 'one video track per rendition',
  title: 'Exactly one video track',
  applies: () => true,
  check: (c) => (c.videos.length === 1 ? pass('One video track', 'As a rendition should.') : c.videos.length ? warn(`${c.videos.length} video tracks`, 'A rendition carries exactly one video track; players pick the first and ignore the rest.') : fail('No video track', 'Nothing to play.')),
});

defineRule({
  id: 'has-audio', category: 'Container', severity: 'critical', spec: 'hlsAuth', clause: 'audio in every variant',
  title: 'Audio is present',
  applies: (c) => c.audios.length === 0,
  check: (c) => (c.ex.audio?.required ? fail('No audio track', 'The service expects every rendition to carry audio.') : info('No audio track', 'A silent rendition; sources without sound produce these.')),
});

defineRule({
  id: 'track-durations', category: 'Container', severity: 'warning', spec: 'hlsAuth', clause: 'variant consistency',
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
  id: 'codec', category: 'Video', severity: 'warning', spec: 'hlsAuth', clause: '1.1 video codecs',
  title: 'An HLS video codec',
  applies: (c) => !!c.v,
  check: (c) => (['avc', 'hevc'].includes(c.vi.family) ? pass(videoCodecName(c.it), 'Decodable by every HLS client.') : warn(`${videoCodecName(c.it)}: not an HLS codec for Apple devices`, 'Apple clients play H.264 and HEVC; other codecs need separate renditions.')),
});

defineRule({
  id: 'profile', category: 'Video', severity: 'critical', spec: 'hlsAuth', clause: '1.3 H.264 profiles',
  title: 'A supported H.264 profile',
  applies: (c) => c.vi.family === 'avc' && c.vi.profile !== undefined,
  check: (c) => {
    const p = c.vi.profile;
    if (p === 77 || p === 100) return pass(c.vi.profileName, 'Main and High are the profiles the specification allows for HD.', { offset: c.entryOffset });
    if (p === 66) return warn(c.vi.profileName, 'Baseline suits old phones only; Main or High decodes everywhere and compresses better.', { offset: c.entryOffset });
    return fail(c.vi.profileName, 'Only Baseline, Main and High profile are decoded by HLS clients (High 10 and 4:2:2 are not).', { offset: c.entryOffset });
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
  id: 'level-minimal', category: 'Video', severity: 'info', spec: 'h264', clause: 'Annex A; device capability gating',
  title: 'The level is the lowest that fits',
  applies: (c) => c.lvl?.signalled && c.lvl.lowest && !c.lvl.unconstrained,
  check: (c) => {
    const name = c.lvl.signalled.name;
    const where = LEVEL_SPEC[c.vi.family] ?? LEVEL_SPEC.avc;
    if (c.lvl.lowest.name === name) return pass(`Level ${name} is the lowest that fits`, 'No device is shut out needlessly.', { value: name, ...where });
    return info(`Level ${name} signalled, ${c.lvl.lowest.name} would do`, 'Devices refuse streams above the level they decode; a higher level than needed shuts some out.', { value: name, expected: c.lvl.lowest.name, offset: c.entryOffset, ...where });
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
  id: 'level-cap', category: 'Video', severity: 'warning', spec: 'hlsAuth', clause: '1.4 H.264 up to level 4.2',
  title: 'H.264 level at most 4.2',
  applies: (c) => c.vi.family === 'avc' && c.vi.level !== undefined,
  check: (c) => (c.vi.level <= 42 ? pass(`Level ${c.lvl?.signalled?.name ?? c.vi.level / 10}`, 'Within what Apple devices must decode.') : warn(`Level ${c.vi.level / 10} is above 4.2`, 'Apple devices are only required to decode H.264 up to level 4.2 (1080p60).', { offset: c.entryOffset })),
});

defineRule({
  id: 'even-size', category: 'Video', severity: 'critical', spec: 'h264', clause: '4:2:0 chroma',
  title: 'Even picture dimensions',
  applies: (c) => c.vi.width && c.vi.height,
  check: (c) => (c.vi.width % 2 === 0 && c.vi.height % 2 === 0 ? pass(`${c.vi.width}×${c.vi.height}`, 'Even dimensions, as 4:2:0 chroma requires.') : fail(`${c.vi.width}×${c.vi.height}: odd dimension`, 'Odd dimensions cannot be represented in 4:2:0 without cropping.')),
});

defineRule({
  id: 'square-pixels', category: 'Video', severity: 'warning', spec: 'hlsAuth', clause: '1.9 pixel aspect',
  title: 'Square pixels',
  applies: (c) => Array.isArray(c.vi.sps?.vui?.sar),
  check: (c) => {
    const [w, h] = c.vi.sps.vui.sar;
    return w === h || !w || !h ? pass('Square pixels', 'Displayed as encoded.') : warn(`Pixel aspect ${w}:${h}`, 'Non-square pixels are mis-scaled by some players; scale to square pixels when encoding.', { value: `${w}:${h}`, offset: c.entryOffset });
  },
});

defineRule({
  id: 'fps-range', category: 'Video', severity: 'warning', spec: 'hlsAuth', clause: '1.7 frame rate',
  title: 'Frame rate within the ladder range',
  applies: (c) => !!c.it.fps,
  check: (c) => {
    const fps = c.it.fps;
    if (c.ex.fpsMax && fps > c.ex.fpsMax + 0.01) return warn(`${fmtNum(fps, 3)} fps, above ${c.ex.fpsMax}`, 'Frame rates above the ladder maximum cost bits and decoder capability for no visible gain.', { value: fps, expected: `≤ ${c.ex.fpsMax}` });
    if (c.ex.fpsMin && fps < c.ex.fpsMin) return warn(`${fmtNum(fps, 3)} fps, below ${c.ex.fpsMin}`, 'Very low frame rates play as a slideshow.', { value: fps, expected: `≥ ${c.ex.fpsMin}` });
    return pass(`${fmtNum(fps, 3)} fps`, 'Within the expected range.', { value: fps });
  },
});

defineRule({
  id: 'fps-constant', category: 'Video', severity: 'warning', spec: 'hlsAuth', clause: '1.7 constant frame rate',
  title: 'Constant frame rate',
  applies: (c) => !!c.v && c.v.vfr !== undefined,
  check: (c) => (c.v.vfr ? warn('Variable frame rate', 'Renditions should have a constant frame rate; variable timing breaks segment alignment and the FRAME-RATE attribute.') : pass('Constant frame rate', 'Every frame lasts the same time.')),
});

defineRule({
  id: 'gop-fixed', category: 'Video', severity: 'warning', spec: 'hlsAuth', clause: '1.8 key frames at a fixed interval',
  title: 'A fixed key-frame interval',
  applies: (c) => c.gop && c.gop.count >= 2,
  check: (c) => {
    const g = c.gop;
    // Key-frame positions come from the sample tables, whatever the payload budget.
    return g.fixed
      ? pass(`Key frame every ${fmtInt(g.avgFrames)} frames (${fmtNum(g.avgSeconds, 2)} s)`, 'Segments of equal length can be cut at every key frame.', { value: g.avgSeconds })
      : warn(`Key-frame interval varies: ${fmtNum(g.minSeconds, 2)}–${fmtNum(g.maxSeconds, 2)} s`, 'Uneven intervals give uneven segments and break alignment across renditions.', { value: [g.minSeconds, g.maxSeconds], offset: c.gopOffset(g.maxSeconds) });
  },
});

defineRule({
  id: 'gop-length', category: 'Video', severity: 'warning', spec: 'hlsAuth', clause: '1.8 key frame every 2 s',
  title: 'The key-frame interval the service intends',
  applies: (c) => c.gop && c.gop.count >= 2,
  check: (c) => {
    const g = c.gop;
    if (c.ex.gop) {
      const off = Math.abs(g.avgSeconds - c.ex.gop);
      return (off <= 0.05 ? pass : fail)(`Key-frame interval ${fmtNum(g.avgSeconds, 3)} s, expected ${c.ex.gop} s`, off <= 0.05 ? 'As the service intends.' : 'The interval does not match the ladder contract.', { value: g.avgSeconds, expected: c.ex.gop });
    }
    if (g.avgSeconds > 2.05) return info(`Key-frame interval ${fmtNum(g.avgSeconds, 2)} s`, 'Apple recommends a key frame every 2 s so that 6 s segments can be cut and switching stays quick; longer intervals mean longer segments and slower start-up.', { value: g.avgSeconds });
    return pass(`Key-frame interval ${fmtNum(g.avgSeconds, 2)} s`, 'Within Apple\'s recommendation.', { value: g.avgSeconds });
  },
});

defineRule({
  id: 'gop-max', category: 'Video', severity: 'critical', spec: 'rfc8216', clause: '§3.1 segments cut at key frames',
  title: 'No key-frame interval longer than allowed',
  applies: (c) => c.gop && c.gop.count >= 2 && c.ex.gopMax,
  check: (c) => (c.gop.maxSeconds <= c.ex.gopMax + 0.05 ? pass(`Longest interval ${fmtNum(c.gop.maxSeconds, 2)} s`, 'Every segment can be cut on time.', { value: c.gop.maxSeconds }) : fail(`Longest key-frame interval ${fmtNum(c.gop.maxSeconds, 2)} s, allowed ${c.ex.gopMax} s`, 'A packager cannot cut a segment inside a GOP.', { value: c.gop.maxSeconds, expected: c.ex.gopMax, offset: c.gopOffset(c.gop.maxSeconds) })),
});

defineRule({
  id: 'closed-gop', category: 'Video', severity: 'warning', spec: 'cmaf', clause: '§7.3.3 fragments start with SAP type 1 or 2',
  title: 'Closed GOPs',
  applies: (c) => c.an?.classified > 0 && c.gop && c.gop.count >= 1,
  check: (c) => (c.gop.open ? warn(`${plural(c.gop.open, 'open GOP')}${c.sampled}`, 'Frames after a key frame reference the previous GOP, so a segment cut there cannot be decoded on its own.', { value: c.gop.open }) : pass(`Closed GOPs${c.sampled}`, 'Every segment cut at a key frame decodes on its own.')),
});

defineRule({
  id: 'key-is-idr', category: 'Video', severity: 'critical', spec: 'rfc8216', clause: '§3.1; ISO 14496-12 sync samples',
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
  id: 'b-frames', category: 'Video', severity: 'critical', spec: 'h264', clause: 'Baseline profile constraints',
  title: 'B-frames only where the profile allows',
  applies: (c) => c.an?.classified > 0 && c.an.maxB > 0,
  check: (c) => (c.vi.family === 'avc' && c.vi.profile === 66 ? fail(`B-frames in Baseline profile${c.sampled}`, 'Baseline profile forbids B-frames.') : info(`Up to ${plural(c.an.maxB, 'B-frame')} in a row${c.an.refB ? ', B-pyramid' : ''}${c.sampled}`, 'B-frames improve compression; players handle them.', { value: c.an.maxB })),
});

defineRule({
  id: 'peak-ratio', category: 'Video', severity: 'warning', spec: 'hlsAuth', clause: '1.15 peak bit rate ≤ 200 % of average (VOD)',
  title: 'Peaks stay near the average',
  applies: (c) => c.it.rate?.avg > 0 && c.it.duration >= 3,
  check: (c) => {
    const r = c.it.rate;
    const title = `Busiest second ${fmtBitrate(r.peak)}, ${fmtNum(r.ratio, 2)}× the average of ${fmtBitrate(r.avg)}`;
    return r.ratio <= c.ex.peakRatio
      ? pass(title, 'Peaks stay within the allowed ratio, so the advertised bandwidth is honest.', { value: r.ratio, expected: `≤ ${c.ex.peakRatio}` })
      : warn(title, 'HLS advertises the peak (BANDWIDTH); a rendition whose peaks run far above its average stalls on links sized for its average.', { value: r.ratio, expected: `≤ ${c.ex.peakRatio}`, offset: c.v.samples.offsets[c.peakSample] });
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
    return c.it.bpp < low ? warn(`${fmtNum(c.it.bpp, 3)} bits per pixel`, 'Very few bits per pixel: expect visible blocking on motion.', { value: c.it.bpp }) : info(`${fmtNum(c.it.bpp, 3)} bits per pixel`, '0.05–0.15 is usual for H.264 at this kind of resolution.', { value: c.it.bpp });
  },
});

defineRule({
  id: 'colour-signalled', category: 'Colour', severity: 'critical', spec: 'h273', clause: 'colour_primaries / transfer_characteristics / matrix_coefficients; HLS spec 1.11',
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
  id: 'hdr-consistent', category: 'Colour', severity: 'critical', spec: 'h273', clause: 'BT.2100 signalling; HLS spec 1.12 HDR',
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
  id: 'colour-expected', category: 'Colour', severity: 'warning', spec: 'practice', clause: 'one colour description across the catalogue',
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
  id: 'depth', category: 'Video', severity: 'warning', spec: 'hlsAuth', clause: '1.3 8-bit H.264',
  title: '8-bit samples for H.264',
  applies: (c) => c.vi.family === 'avc' && c.vi.depth,
  check: (c) => (c.vi.depth > 8 ? warn(`${c.vi.depth}-bit H.264`, 'H.264 above 8 bits (High 10) is not decoded by most hardware.', { offset: c.entryOffset }) : pass('8-bit 4:2:0', 'Decoded by every device.')),
});

defineRule({
  id: 'brands', category: 'Container', severity: 'info', spec: 'isobmff', clause: '§4.3 file type box; CMAF §7.2 brands',
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
  id: 'hdr-metadata', category: 'Colour', severity: 'warning', spec: 'hlsAuth', clause: '1.12 HDR10 needs mastering display and content light level metadata',
  title: 'HDR10 static metadata present',
  applies: (c) => c.colour && c.colour.transfer === 16 && c.v?.entryNode?.children,
  check: (c) => {
    const kids = c.v.entryNode.children ?? [];
    const has = (t) => kids.some((n) => n.type === t);
    const mdcv = has('mdcv') || has('SmDm');
    const clli = has('clli') || has('CoLL');
    return mdcv && clli
      ? pass('Mastering display and content light level metadata present', 'HDR10 players can map the picture to their display.')
      : warn(`HDR10 without ${[!mdcv ? 'mastering display (mdcv)' : null, !clli ? 'content light level (clli)' : null].filter(Boolean).join(' or ')} metadata`, 'Without static metadata a display tone-maps blindly; Apple requires both boxes for HDR10 renditions.', { offset: c.entryOffset });
  },
});

defineRule({
  id: 'fragments', category: 'Container', severity: 'critical', spec: 'cmaf', clause: '§7.3 fragment sequence, decode time continuity, moof+mdat pairing',
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
  id: 'audio-codec', category: 'Audio', severity: 'warning', spec: 'hlsAuth', clause: '2.1 audio codecs',
  title: 'An HLS audio codec',
  applies: (c) => !!c.a,
  check: (c) => {
    const name = c.audio.codec;
    if (c.ex.audio?.codec && name !== c.ex.audio.codec) return fail(`${name}, expected ${c.ex.audio.codec}`, 'Not the codec the service standardises on.', { value: name, expected: c.ex.audio.codec });
    return /AAC/.test(name) ? pass(name, 'AAC is the audio codec every HLS client decodes.') : warn(name, 'HLS clients for Apple devices expect AAC (or AC-3/E-AC-3 for surround).', { value: name });
  },
});

defineRule({
  id: 'audio-rate', category: 'Audio', severity: 'warning', spec: 'hlsAuth', clause: '2.3 sample rate',
  title: 'A usual sample rate',
  applies: (c) => c.audio?.sampleRate,
  check: (c) => {
    const rate = c.audio.sampleRate;
    if (c.ex.audio?.sampleRate) return (rate === c.ex.audio.sampleRate ? pass : fail)(`${fmtInt(rate)} Hz`, rate === c.ex.audio.sampleRate ? 'As the service intends.' : `Expected ${fmtInt(c.ex.audio.sampleRate)} Hz.`, { value: rate, expected: c.ex.audio.sampleRate });
    return rate === 48000 || rate === 44100 ? pass(`${fmtInt(rate)} Hz`, '44.1 and 48 kHz decode everywhere.', { value: rate }) : warn(`${fmtInt(rate)} Hz`, 'Unusual sample rates are resampled by players.', { value: rate });
  },
});

defineRule({
  id: 'audio-channels', category: 'Audio', severity: 'warning', spec: 'hlsAuth', clause: '2.4 stereo for the main renditions',
  title: 'Stereo or mono',
  applies: (c) => c.audio?.channels,
  check: (c) => {
    const n = c.audio.channels;
    const max = c.ex.audio?.channelsMax ?? 2;
    return n <= max ? pass(plural(n, 'channel'), 'Every device plays it.', { value: n }) : warn(plural(n, 'channel'), 'More than two channels need a surround-capable rendition and a stereo fallback.', { value: n, expected: `≤ ${max}` });
  },
});

defineRule({
  id: 'audio-bitrate', category: 'Audio', severity: 'warning', spec: 'practice', clause: 'AAC-LC bit rate per channel',
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
  id: 'audio-priming', category: 'Audio', severity: 'warning', spec: 'priming', clause: 'edit list for the encoder delay',
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
    return media > 0
      ? pass(`Edit list skips the first ${fmtNum(ms, 1)} ms (encoder priming)`, 'The encoder delay is removed, so audio and video start together.', { value: ms, offset: elst.offset })
      : warn('No edit list for the encoder priming', 'AAC encoders add 1024–2112 samples of delay; without an edit list audio plays 20–50 ms late against the video. Files remuxed from MPEG-TS lose this information.', { value: 0, offset: elst?.offset ?? c.a.node.offset });
  },
});

// ====================================================================== measured (from the caller: ffmpeg ebur128, psnr, a sync probe)

defineRule({
  id: 'loudness', category: 'Audio', severity: 'warning', spec: 'r128', clause: 'integrated loudness target',
  title: 'Integrated loudness on target',
  applies: (c) => c.measured.loudness?.integrated !== undefined,
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
  id: 'true-peak', category: 'Audio', severity: 'warning', spec: 'r128', clause: 'maximum true peak −1 dBTP',
  title: 'True peak below the ceiling',
  applies: (c) => c.measured.loudness?.truePeak !== undefined,
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
  check: (c) => {
    const { psnr, ssim, vmaf } = c.measured.quality;
    const parts = [psnr !== undefined ? `PSNR ${fmtNum(psnr, 1)} dB` : null, ssim !== undefined ? `SSIM ${fmtNum(ssim, 3)}` : null, vmaf !== undefined ? `VMAF ${fmtNum(vmaf, 1)}` : null].filter(Boolean);
    const bad = (psnr !== undefined && psnr < 30) || (ssim !== undefined && ssim < 0.9) || (vmaf !== undefined && vmaf < 70);
    return (bad ? warn : info)(`Against the source: ${parts.join(', ')}`, bad ? 'Low fidelity for this resolution: check the conversion path (colour, deinterlacing, scaling).' : 'Measured on the luma plane against the source scaled to this size.', { value: psnr ?? ssim ?? vmaf });
  },
});

// ====================================================================== ladder

/** Half a frame of the slowest rendition, plus a millisecond of timescale rounding. */
function keyTolerance(items) {
  let fps = Infinity;
  for (const it of items) if (it.fps) fps = Math.min(fps, it.fps);
  return (Number.isFinite(fps) ? 0.5 / fps : 0.02) + 0.001;
}

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
  id: 'idr-aligned', scope: 'ladder', category: 'Ladder', severity: 'critical', spec: 'hlsAuth', clause: '1.8 / RFC 8216 §6.2.4 aligned variants',
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
  id: 'segment-lengths', scope: 'ladder', category: 'Ladder', severity: 'critical', spec: 'rfc8216', clause: '§4.3.3.1 target duration',
  title: 'A segment length fits every rendition',
  applies: (l) => l.items.length >= 2 && l.results.every((r) => r.facts.video?.gop > 0),
  check: (l) => {
    // A segment length works when it is a whole number of GOPs in every rendition; a GOP of
    // 120 frames at 23.976 fps is 5.005 s and still cuts 5 s segments (the playlist says 5.005).
    const good = l.ex.segments.filter((len) => l.results.every((r) => {
      const gop = r.facts.video.gop;
      const n = Math.round(len / gop);
      return n >= 1 && Math.abs(n * gop - len) <= Math.max(0.5 / (r.facts.video.fps || 25), 0.01 * len);
    }));
    return good.length
      ? pass(`Segments of ${good.map((s) => `${s} s`).join(', ')} fit the key frames`, 'Any of these target durations can be packaged without splitting a GOP.', { value: good })
      : fail(`No segment length of ${l.ex.segments.join('/')} s fits the key frames`, 'The packager will have to use uneven or long segments.', { expected: l.ex.segments, value: l.results.map((r) => Math.round(r.facts.video.gop * 1000) / 1000) });
  },
});

defineRule({
  id: 'frame-rates', scope: 'ladder', category: 'Ladder', severity: 'info', spec: 'hlsAuth', clause: '1.7 frame rates across renditions',
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
  id: 'same-audio', scope: 'ladder', category: 'Ladder', severity: 'warning', spec: 'hlsAuth', clause: '2.5 identical audio in all variants',
  title: 'The same audio in every rendition',
  applies: (l) => l.results.some((r) => r.facts.audio),
  check: (l) => {
    const audio = l.results.map((r) => (r.facts.audio ? `${r.facts.audio.codec} ${r.facts.audio.sampleRate} Hz ${r.facts.audio.channels} ch` : 'none'));
    const set = [...new Set(audio)];
    return set.length === 1
      ? pass(`Same audio in every rendition (${audio[0]})`, 'Rendition switches are inaudible.', { value: set })
      : warn(`Audio differs across renditions: ${set.join(' / ')}`, 'Apple requires the audio of all variants to be identical in codec, channels and sample rate; a switch from mono to stereo is audible.', { value: set });
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
    const off = [];
    for (const r of l.results) {
      const m = label(r.file);
      const { width: w, height: h } = r.facts.video ?? {};
      if (m && w && h && Number(m) !== Math.min(w, h)) off.push(`${r.file}: labelled ${m}p, is ${w}×${h}`);
    }
    return off.length ? warn(off.join('; '), 'A rendition name that does not match the picture size misleads players, manifests and people.', { value: off }) : pass('Rendition names match their sizes', 'What the name says is what the file holds.');
  },
});

defineRule({
  id: 'levels', scope: 'ladder', category: 'Ladder', severity: 'info', spec: 'h264', clause: 'Annex A',
  title: 'Levels down the ladder',
  applies: (l) => l.byHeight.length >= 1,
  check: (l) => info(`Levels: ${l.byHeight.map((r) => `${r.facts.video.height}p level ${r.facts.video.levelName ?? '?'}`).join(', ')}`, 'What each rendition asks of a decoder.'),
});

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
    video: v ? { codec: videoCodecName(it), width: vi.width, height: vi.height, fps: it.fps, profile: vi.profileName ?? null, level: vi.level ?? null, levelName: c.lvl?.signalled?.name ?? null, depth: vi.depth ?? null, bitrate: it.rate?.avg ?? null, peak: it.rate?.peak ?? null, gop: c.gop?.avgSeconds ?? null, bpp: it.bpp ?? null, colour: c.colour?.text ?? null, timescale: v.timescale ?? null } : null,
    audio: c.audio,
    encoder: c.parsed ? { label: c.parsed.label, version: c.parsed.version, crf: c.rc?.crf ?? null, maxrate: c.rc?.maxrate ?? null, bufsize: c.rc?.bufsize ?? null, keyint: c.parsed.get('keyint') ?? null } : null,
  };
  return { file: doc.name, facts, checks, item: it };
}

function finish(rule, res, overlay = null) {
  // A check may name a more specific source than its rule (the level tables of the codec at hand).
  const out = { id: rule.id, category: rule.category, level: res.level, title: res.title, text: res.text, spec: res.spec ?? rule.spec, clause: res.clause ?? rule.clause ?? null };
  // A service may promote or demote a rule's severity (expect.overlay.severity[id]).
  const severity = overlay?.severity?.[rule.id] ?? rule.severity;
  if (res.level === 'warn' || res.level === 'fail') out.severity = severity === 'critical' && res.level === 'fail' ? 'CRITICAL' : severity === 'info' ? 'INFO' : 'WARNING';
  for (const k of ['value', 'expected', 'offset']) if (res[k] !== undefined) out[k] = res[k];
  if (out.severity) {
    const rem = remedyFor(rule.id);
    if (rem) out.remedy = rem;
  }
  return out;
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

/** Counts by level, and a compliance figure: passed ÷ (passed + failed), warnings aside. */
export function tally(checks) {
  const t = { pass: 0, warn: 0, fail: 0, info: 0, skip: 0, critical: 0, warning: 0 };
  for (const c of checks) {
    t[c.level] = (t[c.level] ?? 0) + 1;
    if (c.severity === 'CRITICAL') t.critical++;
    else if (c.severity === 'WARNING') t.warning++;
  }
  t.compliance = t.pass + t.fail ? t.pass / (t.pass + t.fail) : null;
  return t;
}

/** A Markdown report of the audited files and their ladders (one, several, or none). */
export function auditMarkdown(results, ladders = null, { title = 'Vidscope audit' } = {}) {
  const list = Array.isArray(ladders) ? ladders : ladders ? [ladders] : [];
  const lines = [`# ${title}`, ''];
  const mark = { pass: '✓', warn: '⚠', fail: '✗', info: 'ℹ', skip: '–' };
  const all = [...results.flatMap((r) => r.checks), ...list.flatMap((l) => l.checks ?? [])];
  const t = tally(all);
  lines.push(`${plural(results.length, 'file')}: ${t.fail} failed (${t.critical} critical), ${t.warn} warnings, ${t.pass} passed${t.compliance !== null ? `; ${fmtNum(t.compliance * 100, 1)} % of the pass/fail checks pass` : ''}.`, '');
  const line = (c) => `- ${mark[c.level]} **${c.title}** — ${c.text}${c.remedy ? `\n  - fix: ${c.remedy.fix}` : ''} _(${SPECS[c.spec]?.name ?? c.spec}${c.clause ? `, ${c.clause}` : ''})_`;
  for (const l of list) {
    if (!l.checks?.length) continue;
    lines.push(list.length > 1 || l.files?.length ? `## Ladder: ${(l.files ?? []).join(', ')}` : '## Ladder', '');
    for (const c of l.checks) lines.push(line(c));
    lines.push('');
  }
  const order = ['fail', 'warn', 'pass', 'info', 'skip'];
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
