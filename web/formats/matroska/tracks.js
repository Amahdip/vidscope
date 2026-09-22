// Tracks from TrackEntry elements: kind, codec, codec configuration (for the frame
// parsers), properties for the Tracks tab.

import { fmtInt, fmtNum, fmtHz, fmtBitrate, fmtDuration, ratio } from '../../core/util.js';
import { profileName as avcProfile, levelName as avcLevel } from '../../codecs/h264.js';
import { PROFILES as HEVC_PROFILES, levelName as hevcLevel } from '../../codecs/h265.js';
import { aacName, CHANNEL_CONFIG } from '../../codecs/mpeg4audio.js';
import { colourSummary } from '../../codecs/color.js';
import { childValue } from './parse.js';
import { codecInfo } from './codecs.js';
import { fmtNs, tickName } from './ebml.js';
import { ENUMS } from './schema.js';
import { languageName, uidHex } from './values.js';
import { describeEncoding } from './labels.js';

export const KIND_LABEL = { video: 'Video', audio: 'Audio', subtitle: 'Subtitle', data: 'Data' };
const TYPE_KIND = { 1: 'video', 2: 'audio', 3: 'data', 16: 'video', 17: 'subtitle', 18: 'data', 32: 'data', 33: 'data' };

function child(node, name) {
  return node?.children?.find((c) => c.type === name) ?? null;
}

function kids(node, name) {
  return node?.children?.filter((c) => c.type === name) ?? [];
}

function videoInfo(v) {
  if (!v) return null;
  const val = (n, d) => childValue(v, n, d);
  const c = child(v, 'Colour');
  const mm = c ? child(c, 'MasteringMetadata') : null;
  const pr = child(v, 'Projection');
  return {
    pixelWidth: val('PixelWidth', null),
    pixelHeight: val('PixelHeight', null),
    displayWidth: val('DisplayWidth', null),
    displayHeight: val('DisplayHeight', null),
    displayUnit: val('DisplayUnit', 0),
    crop: { top: val('PixelCropTop', 0), bottom: val('PixelCropBottom', 0), left: val('PixelCropLeft', 0), right: val('PixelCropRight', 0) },
    interlaced: val('FlagInterlaced', 0),
    fieldOrder: child(v, 'FieldOrder') ? val('FieldOrder', 2) : null,
    stereoMode: val('StereoMode', 0),
    alphaMode: val('AlphaMode', 0),
    colour: c ? {
      matrix: childValue(c, 'MatrixCoefficients', 2),
      primaries: childValue(c, 'Primaries', 2),
      transfer: childValue(c, 'TransferCharacteristics', 2),
      range: childValue(c, 'Range', 0),
      bits: childValue(c, 'BitsPerChannel', 0),
      subH: childValue(c, 'ChromaSubsamplingHorz', null),
      subV: childValue(c, 'ChromaSubsamplingVert', null),
      maxCLL: childValue(c, 'MaxCLL', null),
      maxFALL: childValue(c, 'MaxFALL', null),
      mastering: mm ? {
        lumMax: childValue(mm, 'LuminanceMax', null),
        lumMin: childValue(mm, 'LuminanceMin', null),
        r: [childValue(mm, 'PrimaryRChromaticityX', null), childValue(mm, 'PrimaryRChromaticityY', null)],
        g: [childValue(mm, 'PrimaryGChromaticityX', null), childValue(mm, 'PrimaryGChromaticityY', null)],
        b: [childValue(mm, 'PrimaryBChromaticityX', null), childValue(mm, 'PrimaryBChromaticityY', null)],
        w: [childValue(mm, 'WhitePointChromaticityX', null), childValue(mm, 'WhitePointChromaticityY', null)],
      } : null,
    } : null,
    projection: pr ? { type: childValue(pr, 'ProjectionType', 0), yaw: childValue(pr, 'ProjectionPoseYaw', 0), pitch: childValue(pr, 'ProjectionPosePitch', 0), roll: childValue(pr, 'ProjectionPoseRoll', 0) } : null,
  };
}

function audioInfo(a) {
  if (!a) return null;
  return {
    samplingFrequency: childValue(a, 'SamplingFrequency', 8000),
    outputSamplingFrequency: childValue(a, 'OutputSamplingFrequency', null),
    channels: childValue(a, 'Channels', 1),
    bitDepth: childValue(a, 'BitDepth', null),
  };
}

function encodingsOf(entry) {
  const out = [];
  for (const e of kids(child(entry, 'ContentEncodings'), 'ContentEncoding')) {
    const type = childValue(e, 'ContentEncodingType', 0);
    const comp = child(e, 'ContentCompression');
    const enc = child(e, 'ContentEncryption');
    const settings = comp ? child(comp, 'ContentCompSettings') : null;
    out.push({
      node: e,
      order: childValue(e, 'ContentEncodingOrder', 0),
      scope: childValue(e, 'ContentEncodingScope', 1),
      type,
      compAlgo: comp ? childValue(comp, 'ContentCompAlgo', 0) : type === 0 ? 0 : null,
      stripped: settings?.fields.find((f) => f.name === 'ContentCompSettings')?.value ?? null,
      encAlgo: enc ? childValue(enc, 'ContentEncAlgo', 0) : null,
      cipherMode: enc ? childValue(child(enc, 'ContentEncAESSettings'), 'AESSettingsCipherMode', null) : null,
      text: describeEncoding(e),
    });
  }
  return out;
}

function trackFromEntry(entry, seg, index) {
  const v = (name, d) => childValue(entry, name, d);
  const codec = v('CodecID', null);
  const ci = codecInfo(codec);
  const type = v('TrackType', null);
  const kind = TYPE_KIND[type] ?? ci?.kind ?? 'data';
  const cpNode = child(entry, 'CodecPrivate');
  const cp = cpNode?.data.info ?? null;
  const uidNode = child(entry, 'TrackUID');
  const t = {
    id: v('TrackNumber', 0),
    index,
    kind,
    type,
    uid: uidNode?.data.value ?? null,
    uidBig: uidNode?.data.big !== undefined ? String(uidNode.data.big) : null,
    codec,
    codecName: ci?.name ?? codec ?? 'unknown codec',
    codecInfo: ci,
    node: entry,
    seg,
    name: v('Name', ''),
    language: child(entry, 'LanguageBCP47') ? v('LanguageBCP47', null) : v('Language', 'eng'),
    languageExplicit: !!(child(entry, 'Language') || child(entry, 'LanguageBCP47')),
    flags: {
      enabled: v('FlagEnabled', 1),
      default: v('FlagDefault', 1),
      forced: v('FlagForced', 0),
      hearingImpaired: v('FlagHearingImpaired', 0),
      visualImpaired: v('FlagVisualImpaired', 0),
      textDescriptions: v('FlagTextDescriptions', 0),
      original: v('FlagOriginal', 0),
      commentary: v('FlagCommentary', 0),
      lacing: v('FlagLacing', 1),
    },
    defaultDuration: v('DefaultDuration', null),
    codecDelay: v('CodecDelay', 0),
    seekPreRoll: v('SeekPreRoll', 0),
    trackTimestampScale: v('TrackTimestampScale', 1),
    timescale: 1e9 / seg.timestampScale,
    cp,
    cpNode,
    video: videoInfo(child(entry, 'Video')),
    audio: audioInfo(child(entry, 'Audio')),
    encodings: encodingsOf(entry),
  };
  // Codec configuration for the frame parsers.
  const cfg = { family: ci?.family ?? null };
  if (cp?.avc) {
    const a = cp.avc;
    cfg.lengthSize = a.lengthSize;
    cfg.state = { spsById: new Map(a.spsById), ppsById: new Map(a.ppsById) };
    t.codecString = a.codec;
    t.profile = `${avcProfile(a.profile, a.compat)}@L${avcLevel(a.level, a.compat, a.profile)}`;
    t.sps = a.sps[0];
  } else if (cp?.hevc) {
    const h = cp.hevc;
    cfg.lengthSize = h.lengthSize;
    cfg.state = { spsById: new Map(h.spsById), ppsById: new Map(h.ppsById) };
    t.codecString = h.codec;
    t.profile = `${HEVC_PROFILES[h.profile_idc] ?? h.profile_idc}@L${hevcLevel(h.level_idc)}${h.tier ? ' High' : ''}`;
    t.sps = h.sps[0];
  } else if (cp?.av1) {
    cfg.state = { seq: cp.av1.seq };
    t.codecString = cp.av1.codec;
    t.profile = `profile ${cp.av1.seq_profile}`;
  } else if (cp?.asc) {
    t.codecString = `mp4a.40.${cp.asc.firstAot}`;
    t.profile = aacName(cp.asc);
  } else if (cp?.vp9 && cp.vp9.profile !== undefined) {
    const f = cp.vp9;
    t.codecString = `vp09.${String(f.profile).padStart(2, '0')}.${String(f.level ?? 0).padStart(2, '0')}.${String(f.bitDepth ?? 8).padStart(2, '0')}`;
    t.profile = `profile ${f.profile}${f.level ? `, level ${(f.level / 10).toFixed(1)}` : ''}`;
  } else if (codec === 'V_VP9') t.codecString = 'vp9';
  else if (codec === 'V_VP8') t.codecString = 'vp8';
  else if (codec === 'A_OPUS') t.codecString = 'opus';
  else if (codec === 'A_VORBIS') t.codecString = 'vorbis';
  else if (codec === 'A_FLAC') t.codecString = 'flac';
  if (ci?.family === 'text') cfg.ass = !!ci.ass;
  if (t.encodings.some((e) => e.type === 0 && e.scope & 1)) {
    t.compressed = t.encodings.find((e) => e.type === 0);
    cfg.family = null;
  }
  if (t.encodings.some((e) => e.type === 1)) {
    t.encrypted = t.encodings.find((e) => e.type === 1);
    cfg.family = null;
  }
  t.sampleCfg = cfg;
  return t;
}

/** A track for blocks whose TrackEntry is elsewhere (a bare media segment without its initialization segment). */
export function placeholderTrack(doc, seg, n) {
  const t = {
    id: n, index: doc.tracks.length, kind: 'data', type: null, uid: null, uidBig: null, codec: null,
    codecName: 'unknown: no TrackEntry in this file', codecInfo: null, node: null, seg, name: '',
    language: 'und', languageExplicit: true, placeholder: true,
    flags: { enabled: 1, default: 0, forced: 0, hearingImpaired: 0, visualImpaired: 0, textDescriptions: 0, original: 0, commentary: 0, lacing: 1 },
    defaultDuration: null, codecDelay: 0, seekPreRoll: 0, trackTimestampScale: 1, timescale: 1e9 / seg.timestampScale,
    cp: null, cpNode: null, video: null, audio: null, encodings: [], sampleCfg: { family: null },
  };
  t.short = `Track ${n}`;
  t.label = `Track ${n} – no TrackEntry`;
  seg.trackByNumber.set(n, t);
  seg.tracks.push(t);
  doc.tracks.push(t);
  return t;
}

export function buildTracks(doc, ctx) {
  const tracks = [];
  const count = {};
  for (const seg of ctx.segments) {
    for (const entry of seg.trackEntries) {
      const t = trackFromEntry(entry, seg, tracks.length);
      count[t.kind] = (count[t.kind] ?? 0) + 1;
      t.short = `${KIND_LABEL[t.kind] ?? 'Track'} ${count[t.kind]}`;
      t.label = `${t.short} – ${t.codec ?? '?'}`;
      entry.data.track = t;
      entry.label = t.label;
      if (seg.trackByNumber.has(t.id)) entry.warn(`Track number ${t.id} is already used by another TrackEntry; blocks cannot tell the two apart.`);
      else seg.trackByNumber.set(t.id, t);
      if (t.uid !== null) seg.trackByUid.set(t.uidBig ?? String(t.uid), t);
      seg.tracks.push(t);
      tracks.push(t);
    }
  }
  doc.tracks = tracks;
  for (const t of tracks) t.props = trackProps(t, doc);
  return tracks;
}

function chromaName(sps) {
  return ['4:0:0', '4:2:0', '4:2:2', '4:4:4'][sps.chroma_format_idc] ?? '?';
}

export function trackProps(t, doc) {
  const p = [];
  p.push(['track number', String(t.id)]);
  if (t.placeholder) p.push(['note', 'The blocks use this track number, but the TrackEntry describing it is not in this file (it is in the initialization segment of the stream).']);
  if (t.uid !== null) p.push(['track UID', uidHex(t.uid, t.uidBig ?? undefined)]);
  p.push(['codec ID', t.codec ?? '— (missing)']);
  p.push(['codec', t.codecName]);
  if (t.codecString) p.push(['codec string', t.codecString]);
  if (t.profile) p.push(['profile', t.profile]);
  if (t.cp?.summary) p.push(['CodecPrivate', t.cp.summary]);
  const v = t.video;
  if (v) {
    const sw = t.sps?.width;
    const sh = t.sps?.height;
    p.push(['coded size', `${v.pixelWidth ?? '?'}×${v.pixelHeight ?? '?'}${sw && (sw !== v.pixelWidth || sh !== v.pixelHeight) ? ` (the SPS says ${sw}×${sh})` : ''}`]);
    const c = v.crop;
    if (c.top || c.bottom || c.left || c.right) p.push(['crop', `top ${c.top}, bottom ${c.bottom}, left ${c.left}, right ${c.right}`]);
    if (v.displayWidth && v.displayHeight) {
      const unit = v.displayUnit === 0 ? '' : ` (${ENUMS.DisplayUnit[v.displayUnit] ?? 'unit ' + v.displayUnit})`;
      p.push(['display size', `${v.displayWidth}×${v.displayHeight}${unit} → ${ratio(v.displayWidth, v.displayHeight)}`]);
    }
    if (t.defaultDuration) p.push(['frame rate', `${fmtNum(1e9 / t.defaultDuration, 3)} fps (DefaultDuration ${fmtNs(t.defaultDuration)})`]);
    else if (t.fps) p.push(['frame rate', `${fmtNum(t.fps, 3)} fps (measured)`]);
    if (t.sps) p.push(['chroma / depth', `${chromaName(t.sps)}, ${t.sps.bit_depth_luma}-bit`]);
    if (v.interlaced === 1) p.push(['scan', `interlaced${v.fieldOrder !== null ? `, ${ENUMS.FieldOrder[v.fieldOrder] ?? v.fieldOrder}` : ''}`]);
    if (v.stereoMode) p.push(['stereo 3D', ENUMS.StereoMode[v.stereoMode] ?? String(v.stereoMode)]);
    if (v.alphaMode) p.push(['alpha', 'present in BlockAdditions']);
    if (v.colour) {
      const col = v.colour;
      p.push(['colour', `${colourSummary(col.primaries, col.transfer, col.matrix)}${col.range === 2 ? ', full range' : col.range === 1 ? ', limited range' : ''}${col.bits ? `, ${col.bits}-bit` : ''}`]);
      if (col.maxCLL || col.maxFALL) p.push(['HDR light levels', `MaxCLL ${col.maxCLL ?? '?'} cd/m², MaxFALL ${col.maxFALL ?? '?'} cd/m²`]);
      if (col.mastering?.lumMax) p.push(['mastering display', `${fmtNum(col.mastering.lumMax, 1)} / ${fmtNum(col.mastering.lumMin ?? 0, 4)} cd/m²`]);
    }
    if (v.projection) {
      const pr = v.projection;
      if (pr.type) p.push(['projection', ENUMS.ProjectionType[pr.type] ?? String(pr.type)]);
      if (pr.roll) p.push(['rotation', `${fmtNum(pr.roll, 1)}° counter-clockwise (ProjectionPoseRoll)`]);
    }
  }
  const a = t.audio;
  if (a || t.kind === 'audio') {
    const asc = t.cp?.asc;
    const rate = asc ? asc.extSampleRate || asc.sampleRate : t.cp?.opus ? 48000 : t.cp?.flac?.sampleRate ?? t.cp?.xiph?.sampleRate ?? a?.outputSamplingFrequency ?? a?.samplingFrequency;
    const ch = asc?.channels || t.cp?.opus?.channels || t.cp?.flac?.channels || t.cp?.xiph?.channels || a?.channels;
    p.push(['sample rate', `${fmtHz(rate)}${a && a.samplingFrequency !== rate && !a.outputSamplingFrequency ? ` (Audio element says ${fmtHz(a.samplingFrequency)})` : ''}`]);
    p.push(['channels', asc && CHANNEL_CONFIG[asc.channelConfig] && asc.channelConfig ? CHANNEL_CONFIG[asc.channelConfig] : String(ch ?? '?')]);
    if (a?.bitDepth) p.push(['bit depth', `${a.bitDepth} bits`]);
    if (t.defaultDuration) p.push(['frame duration', `${fmtNs(t.defaultDuration)} (DefaultDuration)`]);
  }
  if (t.codecDelay) p.push(['codec delay', `${fmtNs(t.codecDelay)} (subtracted from every timestamp)`]);
  if (t.seekPreRoll) p.push(['seek pre-roll', fmtNs(t.seekPreRoll)]);
  const lang = t.language;
  const lname = languageName(lang);
  p.push(['language', `${lang}${lname ? ` (${lname})` : ''}${t.languageExplicit ? '' : ' — no Language element, so the default "eng" applies'}`]);
  if (t.name) p.push(['name', t.name]);
  const f = t.flags;
  const flags = [];
  if (f.default) flags.push('default');
  if (f.forced) flags.push('forced');
  if (!f.enabled) flags.push('disabled');
  if (f.hearingImpaired) flags.push('hearing impaired');
  if (f.visualImpaired) flags.push('visually impaired');
  if (f.textDescriptions) flags.push('text descriptions');
  if (f.original) flags.push('original language');
  if (f.commentary) flags.push('commentary');
  p.push(['flags', flags.join(', ') || 'none']);
  for (const e of t.encodings) p.push(['content encoding', e.text]);
  p.push(['timescale', `${fmtNum(t.timescale, 3)} ticks/s (TimestampScale = ${tickName(t.seg.timestampScale)})`]);
  if (t.trackTimestampScale !== 1) p.push(['track timestamp scale', fmtNum(t.trackTimestampScale, 6)]);
  const s = t.samples;
  if (s) {
    p.push(['frames', fmtInt(s.count)]);
    if (t.duration) p.push(['duration', fmtDuration(t.duration)]);
    if (t.kind === 'video' && t.keyframes !== undefined) p.push(['key frames', `${fmtInt(t.keyframes)}${t.keyframes && s.count ? ` (every ${fmtNum(s.count / t.keyframes, 1)} frames on average)` : ''}`]);
    if (t.fps && t.defaultDuration) p.push(['measured frame rate', `${fmtNum(t.fps, 3)} fps${t.vfr ? ' (variable)' : ''}`]);
    if (t.bytes) p.push(['media bytes', `${fmtInt(t.bytes)} (${((t.bytes / doc.size) * 100).toFixed(2)}% of file)`]);
    if (t.bitrate) p.push(['average bitrate', fmtBitrate(t.bitrate)]);
    if (s.cto) p.push(['reordering', 'yes: B-frames (block timestamps are presentation times, not in decode order)']);
    if (t.lacing) {
      const L = t.lacing;
      const laced = L.xiph + L.ebml + L.fixed;
      if (laced) p.push(['lacing', `${fmtInt(laced)} of ${fmtInt(L.blocks)} blocks laced (${[L.xiph && `${fmtInt(L.xiph)} Xiph`, L.ebml && `${fmtInt(L.ebml)} EBML`, L.fixed && `${fmtInt(L.fixed)} fixed`].filter(Boolean).join(', ')}), up to ${L.maxFrames} frames per block`]);
      if (L.groups) p.push(['BlockGroups', `${fmtInt(L.groups)} of ${fmtInt(L.blocks)} blocks`]);
    }
  }
  return p;
}
