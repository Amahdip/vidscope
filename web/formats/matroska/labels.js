// Short annotations shown next to elements in the tree ("#3 · 0:08.000 · 212 blocks",
// "Opening · 0:00.000–0:02.000") and one-line summaries for the inspector.

import { fmtInt, fmtHz, fmtNum, quote } from '../../core/util.js';
import { clock, fmtNs, hexId, tickName } from './ebml.js';
import { BY_ID } from './elements.js';
import { LACING_SHORT } from './blocks.js';
import { colourSummary } from '../../codecs/color.js';
import { uidHex } from './values.js';

function child(node, name) {
  return node.children?.find((c) => c.type === name) ?? null;
}

function kids(node, name) {
  return node.children?.filter((c) => c.type === name) ?? [];
}

function val(node, name) {
  return child(node, name)?.data.value;
}

function scaleOf(node) {
  return node.data.seg?.timestampScale ?? 1e6;
}

export function trackShort(seg, n) {
  return seg?.trackByNumber.get(n)?.short ?? `track ${n}`;
}

/** The Cluster node starting exactly at `offset` (Clusters are sorted by offset). */
export function clusterAt(seg, offset) {
  const cls = seg.clusters;
  let lo = 0;
  let hi = cls.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const o = cls[mid].offset;
    if (o === offset) return cls[mid];
    if (o < offset) lo = mid + 1;
    else hi = mid - 1;
  }
  return null;
}

function clusterOf(node) {
  for (let n = node.parent; n; n = n.parent) if (n.type === 'Cluster') return n;
  return null;
}

/** Label and timestamp display of a SimpleBlock or Block. */
function labelBlock(node, group) {
  const b = node.data.block;
  if (!b || b.track === undefined) return;
  const seg = node.data.seg;
  const cl = clusterOf(node);
  const scale = scaleOf(node);
  const ts = cl?.data.timestamp;
  const tsField = node.fields.find((f) => f.name === 'timestamp');
  let when = '';
  if (ts !== undefined && ts !== null && b.rel !== undefined) {
    const abs = ts + b.rel;
    when = clock((abs * scale) / 1e9);
    if (tsField) {
      tsField.display = `${b.rel >= 0 ? '+' : ''}${b.rel} ticks → ${when}`;
      tsField.note = `Cluster Timestamp ${fmtInt(ts)} + ${b.rel} = ${fmtInt(abs)} ticks × ${tickName(scale)} = ${clock((abs * scale) / 1e9)}${b.rel < 0 && abs >= 0 ? ' (a negative offset: this frame is shown before the Cluster\'s base time, typical of B-frames)' : ''}${abs < 0 ? ' — negative: decoded but not shown' : ''}.`;
    }
    b.pts = abs;
  }
  const tr = seg?.trackByNumber.get(b.track);
  const tf = node.fields.find((f) => f.name === 'track number');
  if (tf) tf.display = `${b.track}${tr ? ` → ${tr.label}` : ' (no TrackEntry has this number)'}`;
  const key = b.key;
  const parts = [trackShort(seg, b.track)];
  if (when) parts.push(when);
  if (key) parts.push('key');
  if (b.invisible) parts.push('invisible');
  if (b.count > 1) parts.push(`${b.count} frames (${LACING_SHORT[b.lacing]} lacing)`);
  const label = parts.join(' · ');
  const bytes = b.abs ? b.abs.reduce((s, v, i) => (i & 1 ? s + v : s), 0) : 0;
  node.data.summary = `${tr ? tr.label : `track ${b.track}`}${when ? ` at ${when}` : ''}${key ? ', key frame' : ''}${b.count > 1 ? `, ${b.count} laced frames` : ''}: ${fmtInt(bytes)} bytes of frame data`;
  if (group) return label;
  node.label = label;
  return label;
}

const COMP = { 0: 'zlib', 1: 'bzlib', 2: 'lzo1x', 3: 'header stripping' };
const ENC = { 0: 'not encrypted', 1: 'DES', 2: '3DES', 3: 'Twofish', 4: 'Blowfish', 5: 'AES' };
const MODES = { 1: 'CTR', 2: 'CBC' };

export function describeEncoding(node) {
  const type = val(node, 'ContentEncodingType') ?? 0;
  if (type === 0) {
    const c = child(node, 'ContentCompression');
    const algo = c ? val(c, 'ContentCompAlgo') ?? 0 : 0;
    const settings = c ? child(c, 'ContentCompSettings') : null;
    return `compression: ${COMP[algo] ?? `algorithm ${algo}`}${algo === 3 && settings ? ` (${settings.bodySize} bytes)` : ''}`;
  }
  const e = child(node, 'ContentEncryption');
  const algo = e ? val(e, 'ContentEncAlgo') ?? 0 : 0;
  const aes = e ? child(e, 'ContentEncAESSettings') : null;
  const mode = aes ? val(aes, 'AESSettingsCipherMode') : null;
  return `encryption: ${ENC[algo] ?? `algorithm ${algo}`}${mode ? `-${MODES[mode] ?? mode}` : ''}`;
}

export function labelNode(node) {
  const el = node.data.el;
  if (!el) return;
  const seg = node.data.seg;
  switch (el.name) {
    case 'EBML': {
      const dt = val(node, 'DocType');
      node.label = `${dt ?? '?'} v${val(node, 'DocTypeVersion') ?? 1} (read v${val(node, 'DocTypeReadVersion') ?? 1})`;
      node.data.summary = `DocType "${dt}", written with Matroska v${val(node, 'DocTypeVersion') ?? 1}, readable by v${val(node, 'DocTypeReadVersion') ?? 1} readers`;
      break;
    }
    case 'Segment':
      if (node.data.unknownSize) node.label = 'unknown size (live stream)';
      break;
    case 'SeekHead':
      node.label = `${kids(node, 'Seek').length} entries`;
      break;
    case 'Seek': {
      const id = val(node, 'SeekID');
      const pos = val(node, 'SeekPosition');
      const e = id !== undefined ? BY_ID.get(id) : null;
      node.label = `${e ? e.name : id !== undefined ? hexId(id) : '?'}${pos !== undefined && seg ? ` @ ${fmtInt(seg.dataStart + pos)}` : ''}`;
      break;
    }
    case 'Info': {
      const title = val(node, 'Title');
      const d = val(node, 'Duration');
      const scale = val(node, 'TimestampScale') ?? 1e6;
      node.label = [title ? quote(title, 40) : null, d !== undefined ? clock((d * scale) / 1e9) : 'no duration', `${tickName(scale)} ticks`].filter(Boolean).join(' · ');
      break;
    }
    case 'Tracks': {
      const n = kids(node, 'TrackEntry').length;
      node.label = `${n} track${n === 1 ? '' : 's'}`;
      break;
    }
    case 'TrackEntry':
      if (node.data.track) node.label = node.data.track.label;
      break;
    case 'Video': {
      const w = val(node, 'PixelWidth');
      const h = val(node, 'PixelHeight');
      const dw = val(node, 'DisplayWidth');
      const dh = val(node, 'DisplayHeight');
      node.label = `${w ?? '?'}×${h ?? '?'}${dw && dh && (dw !== w || dh !== h) ? ` shown as ${dw}×${dh}` : ''}`;
      break;
    }
    case 'Audio': {
      const f = val(node, 'SamplingFrequency') ?? 8000;
      const out = val(node, 'OutputSamplingFrequency');
      const ch = val(node, 'Channels') ?? 1;
      node.label = `${fmtHz(out ?? f)}, ${ch} ch${val(node, 'BitDepth') ? `, ${val(node, 'BitDepth')}-bit` : ''}`;
      break;
    }
    case 'Colour': {
      const p = val(node, 'Primaries') ?? 2;
      const t = val(node, 'TransferCharacteristics') ?? 2;
      const m = val(node, 'MatrixCoefficients') ?? 2;
      const range = val(node, 'Range');
      const parts = [];
      if (p !== 2 || t !== 2 || m !== 2) parts.push(colourSummary(p, t, m));
      else parts.push('primaries, transfer and matrix unspecified');
      if (range === 1) parts.push('limited range');
      else if (range === 2) parts.push('full range');
      node.label = parts.join(', ');
      break;
    }
    case 'MasteringMetadata': {
      const max = val(node, 'LuminanceMax');
      const min = val(node, 'LuminanceMin');
      if (max !== undefined) node.label = `${fmtNum(max, 1)} / ${fmtNum(min ?? 0, 4)} cd/m²`;
      break;
    }
    case 'ContentEncoding':
      node.label = describeEncoding(node);
      break;
    case 'ContentEncodings':
      node.label = kids(node, 'ContentEncoding').map(describeEncoding).join('; ');
      break;
    case 'Cluster': {
      const ts = node.data.timestamp;
      const parts = [`#${fmtInt((node.data.index ?? 0) + 1)}`];
      if (ts !== undefined && ts !== null) parts.push(clock((ts * scaleOf(node)) / 1e9));
      if (node.data.unknownSize) parts.push('unknown size');
      if (node.children) {
        const blocks = node.children.filter((c) => c.type === 'SimpleBlock' || c.type === 'BlockGroup').length;
        parts.push(`${fmtInt(blocks)} block${blocks === 1 ? '' : 's'}`);
      }
      node.label = parts.join(' · ');
      break;
    }
    case 'SimpleBlock':
      labelBlock(node, false);
      break;
    case 'Block':
      labelBlock(node, false);
      break;
    case 'BlockGroup': {
      const b = child(node, 'Block');
      if (!b) break;
      const text = labelBlock(b, true);
      const dur = val(node, 'BlockDuration');
      const refs = kids(node, 'ReferenceBlock').length;
      node.label = `${text ?? ''}${dur !== undefined ? ` · lasts ${fmtNs(dur * scaleOf(node))}` : ''}${refs ? ` · ${refs} ref${refs > 1 ? 's' : ''}` : ''}`;
      if (b.data.summary) node.data.summary = b.data.summary + (dur !== undefined ? `, lasts ${fmtNs(dur * scaleOf(node))}` : '');
      break;
    }
    case 'BlockMore':
      node.label = `ID ${val(node, 'BlockAddID') ?? 1}`;
      break;
    case 'Cues': {
      const n = kids(node, 'CuePoint').length;
      if (node.children) node.label = `${fmtInt(n)} cue point${n === 1 ? '' : 's'}`;
      break;
    }
    case 'CuePoint': {
      const t = val(node, 'CueTime');
      const tracks = kids(node, 'CueTrackPositions').map((c) => trackShort(seg, val(c, 'CueTrack')));
      node.label = `${t !== undefined ? clock((t * scaleOf(node)) / 1e9) : '?'} · ${tracks.join(', ')}`;
      break;
    }
    case 'CueTrackPositions': {
      const pos = val(node, 'CueClusterPosition');
      const rel = val(node, 'CueRelativePosition');
      const relNode = child(node, 'CueRelativePosition');
      if (relNode && pos !== undefined && rel !== undefined && seg) {
        const cl = clusterAt(seg, seg.dataStart + pos);
        const f = relNode.data.valueField;
        if (cl && f) {
          const abs = cl.bodyOffset + rel;
          f.display = `${fmtInt(rel)} bytes into the Cluster's data → file offset ${fmtInt(abs)}`;
          f.note = `The Cluster at ${fmtInt(cl.offset)} has a ${cl.headerSize}-byte header, so its data starts at ${fmtInt(cl.bodyOffset)}; + ${fmtInt(rel)} = ${fmtInt(abs)}.`;
          let j = relNode.data.jumpField;
          if (!j) {
            j = { name: 'points to (file offset)', type: 'computed', offset: f.offset, size: 0, ref: 'offset', desc: 'The file offset of the SimpleBlock or BlockGroup this cue point refers to.' };
            relNode.fields.push(j);
            relNode.data.jumpField = j;
          }
          j.value = abs;
          j.display = `${fmtInt(abs)} (0x${abs.toString(16).toUpperCase().padStart(8, '0')})`;
        }
      }
      node.label = `${trackShort(seg, val(node, 'CueTrack'))} → Cluster @ ${pos !== undefined && seg ? fmtInt(seg.dataStart + pos) : '?'}${rel !== undefined ? ` + ${fmtInt(rel)}` : ''}`;
      break;
    }
    case 'Chapters': {
      const n = kids(node, 'EditionEntry').length;
      node.label = `${n} edition${n === 1 ? '' : 's'}`;
      break;
    }
    case 'EditionEntry': {
      const n = kids(node, 'ChapterAtom').length;
      const flags = [];
      if (val(node, 'EditionFlagDefault')) flags.push('default');
      if (val(node, 'EditionFlagOrdered')) flags.push('ordered');
      if (val(node, 'EditionFlagHidden')) flags.push('hidden');
      node.label = `${n} chapter${n === 1 ? '' : 's'}${flags.length ? ` · ${flags.join(', ')}` : ''}`;
      break;
    }
    case 'ChapterAtom': {
      const d = child(node, 'ChapterDisplay');
      const title = d ? val(d, 'ChapString') : null;
      const s = val(node, 'ChapterTimeStart');
      const e = val(node, 'ChapterTimeEnd');
      node.label = `${title ? quote(title, 40) : '(untitled)'} · ${s !== undefined ? clock(s / 1e9) : '?'}${e !== undefined ? `–${clock(e / 1e9)}` : ''}${val(node, 'ChapterFlagHidden') ? ' · hidden' : ''}`;
      break;
    }
    case 'ChapterDisplay': {
      const s = val(node, 'ChapString');
      const lang = val(node, 'ChapLanguageBCP47') ?? val(node, 'ChapLanguage');
      node.label = `${s !== undefined ? quote(s, 40) : ''}${lang ? ` (${lang})` : ''}`;
      break;
    }
    case 'Tags': {
      const n = kids(node, 'Tag').length;
      node.label = `${n} tag${n === 1 ? '' : 's'}`;
      break;
    }
    case 'Targets':
      node.label = describeTargets(node);
      break;
    case 'Tag': {
      const t = child(node, 'Targets');
      const names = kids(node, 'SimpleTag').map((s) => val(s, 'TagName')).filter(Boolean);
      node.label = `${t ? describeTargets(t) : 'whole file'} · ${names.slice(0, 4).join(', ')}${names.length > 4 ? '…' : ''}`;
      break;
    }
    case 'SimpleTag': {
      const name = val(node, 'TagName');
      const s = val(node, 'TagString');
      const b = child(node, 'TagBinary');
      node.label = `${name ?? '?'} = ${s !== undefined ? quote(s, 48) : b ? `${fmtInt(b.bodySize)} bytes` : '(no value)'}`;
      break;
    }
    case 'Attachments': {
      const n = kids(node, 'AttachedFile').length;
      node.label = `${n} file${n === 1 ? '' : 's'}`;
      break;
    }
    case 'AttachedFile': {
      const name = val(node, 'FileName');
      const type = val(node, 'FileMediaType');
      const data = child(node, 'FileData');
      node.label = `${name ?? '?'}${type ? ` · ${type}` : ''}${data ? ` · ${fmtInt(data.bodySize)} bytes` : ''}`;
      break;
    }
    default:
      break;
  }
}

function describeTargets(node) {
  const seg = node.data.seg;
  const level = val(node, 'TargetTypeValue') ?? 50;
  const type = val(node, 'TargetType');
  const parts = [];
  for (const c of kids(node, 'TagTrackUID')) {
    const v = c.data.value;
    if (!v) parts.push('all tracks');
    else {
      const t = seg?.trackByUid.get(String(c.data.big ?? v));
      parts.push(t ? t.short : `track UID ${uidHex(v, c.data.big)}`);
    }
  }
  for (const c of kids(node, 'TagEditionUID')) parts.push(`edition ${uidHex(c.data.value, c.data.big)}`);
  for (const c of kids(node, 'TagChapterUID')) parts.push(`chapter ${uidHex(c.data.value, c.data.big)}`);
  for (const c of kids(node, 'TagAttachmentUID')) parts.push(`attachment ${uidHex(c.data.value, c.data.big)}`);
  const what = parts.length ? parts.join(', ') : 'whole file';
  return `${what}${type ? ` (${type})` : level !== 50 ? ` (level ${level})` : ''}`;
}
