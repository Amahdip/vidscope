// Box lookup: combines BinaryView's own box definitions (parsers and plain-language
// descriptions) with the MP4 Registration Authority data (every registered 4CC)
// and the MPEG conformance framework's syntax, parents, versions and flags.

import data from './registry-data.js';

export const REGISTRY = data;

const SPEC_TITLES = {
  ISO: 'ISO/IEC 14496-12 (ISO base media file format)',
  '14496-12': 'ISO/IEC 14496-12 (ISO base media file format)',
  'NALu Video': 'ISO/IEC 14496-15 (NAL unit structured video in ISOBMFF)',
  '14496-15': 'ISO/IEC 14496-15 (NAL unit structured video in ISOBMFF)',
  MP4v2: 'ISO/IEC 14496-14 (MP4 file format)',
  '14496-14': 'ISO/IEC 14496-14 (MP4 file format)',
  MP4v1: 'ISO/IEC 14496-1 (MPEG-4 Systems)',
  'MPEG-4': 'ISO/IEC 14496-1 (MPEG-4 Systems)',
  'ISO-Text': 'ISO/IEC 14496-30 (Timed text in ISOBMFF)',
  '14496-30': 'ISO/IEC 14496-30 (Timed text in ISOBMFF)',
  HEIF: 'ISO/IEC 23008-12 (HEIF image file format)',
  '23008-12': 'ISO/IEC 23008-12 (HEIF image file format)',
  MIAF: 'ISO/IEC 23000-22 (MIAF)',
  CENC: 'ISO/IEC 23001-7 (Common encryption)',
  DASH: 'ISO/IEC 23009-1 (MPEG-DASH)',
  CMAF: 'ISO/IEC 23000-19 (CMAF)',
  QT: 'Apple QuickTime File Format',
  iTunes: 'Apple iTunes metadata',
  'AV1-ISOBMFF': 'AV1 Codec ISO Media File Format Binding',
  AVIF: 'AV1 Image File Format (AVIF)',
  VPxx: 'VP Codec ISO Media File Format Binding',
  Opus: 'Encapsulation of Opus in ISOBMFF',
  FLAC: 'Encapsulation of FLAC in ISOBMFF',
  'ETSI AC-3': 'ETSI TS 102 366 (AC-3 / E-AC-3), Annex F',
  'ETSI AC-4': 'ETSI TS 103 190 (AC-4)',
  'Dolby Vision': 'Dolby Vision streams within ISOBMFF',
  '3GPP': '3GPP TS 26.244 (3GP file format)',
  'Event Message': 'ISO/IEC 23001-18 (Event message track format)',
  PIFF: 'Microsoft Protected Interoperable File Format',
  'Spherical V2': 'Google Spherical Video V2 RFC',
  'MPEG-H': 'ISO/IEC 23008-3 (MPEG-H 3D Audio)',
};

export function specTitle(name) {
  if (!name) return '';
  return SPEC_TITLES[name] ?? data.specs[name]?.d ?? name;
}

export function specUrl(name) {
  return data.specs[name]?.url || null;
}

const MP4RA_PAGES = {
  boxes: 'boxes', 'boxes-qt': 'boxes', 'boxes-udta': 'boxes', brands: 'brands', codecs: 'codecs',
  'codecs-qt': 'codecs', 'sample-entry-boxes': 'sample-entry-boxes', handlers: 'handlers',
  'track-references': 'track-references', 'track-references-qt': 'track-references', 'track-groups': 'track-groups',
  'track-selection': 'track-selection', 'sample-groups': 'sample-groups', 'entity-groups': 'entity-groups',
  schemes: 'schemes', oti: 'object-types', 'stream-types': 'object-types', 'item-types': 'items',
  'item-properties': 'item-properties', 'item-references': 'item-references', 'color-types': 'color-types',
  'data-references': 'data-references', 'aux-info-types': 'aux-info-types', 'checksum-types': 'checksum-types',
  'key-namespaces': 'key-namespaces', 'multiview-attributes': 'multiview-attributes', 'uncv-profiles': 'uncv-profiles',
};

export function mp4raUrl(cat) {
  return `https://mp4ra.org/registered-types/${MP4RA_PAGES[cat] ?? 'boxes'}`;
}

export function conformanceUrl(code) {
  return `${data.sources.conformance}/?query=${encodeURIComponent(`="${code}"`)}`;
}

/** Registry entry [description, specification, extra?] for a code in a category. */
export function reg(cat, code) {
  return data.reg[cat]?.[code] ?? null;
}

/** First registry hit across categories, as {cat, desc, spec, extra}. */
export function regAny(code, cats) {
  for (const cat of cats) {
    const e = data.reg[cat]?.[code];
    if (e) return { cat, desc: e[0], spec: e[1], extra: e[2] };
  }
  return null;
}

export function ffc(kind, code) {
  return data.ffc[kind]?.[code] ?? null;
}

export function brandInfo(code) {
  const e = reg('brands', code);
  return e ? { desc: e[0], spec: e[1] } : null;
}

export function handlerInfo(code) {
  const e = reg('handlers', code);
  return e ? e[0] : null;
}

const capitalize = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

// Which registry tables describe a box, depending on where it sits.
const CONTEXT_TABLES = {
  stsd: { reg: ['codecs', 'codecs-qt'], ffc: 'codecs' },
  tref: { reg: ['track-references', 'track-references-qt'], ffc: 'track-references' },
  iref: { reg: ['item-references'], ffc: 'item-references' },
  ipco: { reg: ['item-properties', 'boxes', 'sample-entry-boxes'], ffc: 'item-properties' },
  trgr: { reg: ['track-groups'], ffc: 'track-groups' },
  grpl: { reg: ['entity-groups'], ffc: 'entity-groups' },
  udta: { reg: ['boxes-udta', 'boxes', 'boxes-qt', 'unlisted'], ffc: 'boxes' },
};
const DEFAULT_TABLES = { reg: ['boxes', 'boxes-qt', 'sample-entry-boxes', 'boxes-udta', 'item-properties', 'unlisted'], ffc: 'boxes' };

const cache = new Map();

/**
 * Resolve the description record for a box of `type` inside `parentType`.
 * `own` is BinaryView's definition (may be null for boxes it only knows from the registry).
 */
export function resolveDef(type, parentType, own) {
  const key = `${parentType}\0${type}\0${own ? own.id ?? own.name : ''}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const tables = CONTEXT_TABLES[parentType] ?? DEFAULT_TABLES;
  const registered = regAny(type, tables.reg) ?? (tables === DEFAULT_TABLES ? null : regAny(type, DEFAULT_TABLES.reg));
  // The conformance data describes MPEG boxes. When BinaryView's definition comes from another
  // specification (QuickTime 'keys', iTunes tags...), a same-named MPEG entry is a different box.
  const foreign = own?.spec && data.specs[own.spec] && !data.specs[own.spec].mpeg;
  const syntax = foreign ? null : ffc(tables.ffc, type) ?? ffc('boxes', type) ?? (parentType === 'stsd' ? ffc('codecs', type) : null);
  const specName = own?.spec ?? registered?.spec ?? (syntax ? syntax.spec : null);
  const def = {
    ...own,
    type,
    name: own?.name ?? (registered ? capitalize(registered.desc) : syntax ? capitalize(syntax.d) : 'Unknown box'),
    cat: own?.cat ?? (registered || syntax ? 'meta' : 'unknown'),
    desc: own?.desc ?? (registered ? `${capitalize(registered.desc)}.` : syntax ? `${capitalize(syntax.d)}.` : null),
    registered,
    syntax: own?.syntax ?? syntax?.syntax ?? null,
    boxClass: syntax?.type ?? null,
    parents: syntax?.in ?? null,
    parentsLabel: syntax?.inLabel ?? null,
    versions: syntax?.v ?? null,
    flagDefs: syntax?.flags ?? null,
    specName,
    specTitle: specTitle(specName),
    specHref: specUrl(specName),
    section: own?.sec ?? null,
    known: !!own,
  };
  def.links = [];
  if (registered) def.links.push({ label: 'registry', url: mp4raUrl(registered.cat), title: `mp4ra.org: ${registered.desc} (${registered.spec})` });
  else if (own) def.links.push({ label: 'registry', url: mp4raUrl(parentType === 'stsd' ? 'codecs' : 'boxes'), title: 'mp4ra.org' });
  if (syntax || data.specs[specName]?.mpeg) def.links.push({ label: 'conformance', url: conformanceUrl(type), title: 'MPEG File Format Conformance Framework' });
  cache.set(key, def);
  return def;
}
