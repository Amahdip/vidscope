// Chunk definitions: what each RIFF chunk is (plain-language description for
// the inspector) and how to read its fields. AVI chunks are added by
// avi-chunks.js and WAV chunks by wav-chunks.js.
//
// A definition has: name, cat (colour family), desc, more, spec (key of SPECS),
// sec, syntax, and optionally:
//   parse(r, node, ctx)  reads the fields after the chunk header
//   container            the data holds sub-chunks (after parse)
//   lazy(ctx)            returns an async loader for the children (movi)
//   opaque               never read the data (media payloads, JUNK)
//   peek                 with opaque: bytes of data to hand to parse()
//   maxRead              largest chunk whose fields are decoded
//   after(node, ctx)     called once the chunk (and its children) are done

import { decodeText, fmtInt } from '../../core/util.js';
import { INFO_TAGS } from './tables.js';

export const SPECS = {
  RIFF: {
    title: 'Microsoft: Resource Interchange File Format (RIFF)',
    href: 'https://learn.microsoft.com/en-us/windows/win32/xaudio2/resource-interchange-file-format--riff-',
  },
  MMSPEC: { title: 'IBM/Microsoft: Multimedia Programming Interface and Data Specifications 1.0 (1991)', href: null },
  AVI: { title: 'Microsoft: AVI RIFF File Reference', href: 'https://learn.microsoft.com/en-us/windows/win32/directshow/avi-riff-file-reference' },
  AVIMAINHEADER: { title: 'Microsoft: AVIMAINHEADER structure (aviriff.h)', href: 'https://learn.microsoft.com/en-us/windows/win32/api/aviriff/ns-aviriff-avimainheader' },
  AVISTREAMHEADER: { title: 'Microsoft: AVISTREAMHEADER structure (aviriff.h)', href: 'https://learn.microsoft.com/en-us/windows/win32/api/aviriff/ns-aviriff-avistreamheader' },
  AVIOLDINDEX: { title: 'Microsoft: AVIOLDINDEX structure (aviriff.h)', href: 'https://learn.microsoft.com/en-us/windows/win32/api/aviriff/ns-aviriff-avioldindex' },
  BITMAPINFOHEADER: { title: 'Microsoft: BITMAPINFOHEADER structure (wingdi.h)', href: 'https://learn.microsoft.com/en-us/windows/win32/api/wingdi/ns-wingdi-bitmapinfoheader' },
  WAVEFORMATEX: { title: 'Microsoft: WAVEFORMATEX structure (mmreg.h)', href: 'https://learn.microsoft.com/en-us/windows/win32/api/mmreg/ns-mmreg-waveformatex' },
  WAVEFORMATEXTENSIBLE: { title: 'Microsoft: WAVEFORMATEXTENSIBLE structure (mmreg.h)', href: 'https://learn.microsoft.com/en-us/windows/win32/api/mmreg/ns-mmreg-waveformatextensible' },
  ODML: { title: 'OpenDML AVI File Format Extensions, version 1.02 (OpenDML AVI M-JPEG File Format Subcommittee, 1996)', href: null },
  BWF: { title: 'EBU Tech 3285: Specification of the Broadcast Wave Format (BWF)', href: 'https://tech.ebu.ch/docs/tech/tech3285.pdf' },
  RF64: { title: 'EBU Tech 3306: RF64, an extended File Format for Audio', href: null },
  BW64: { title: 'Recommendation ITU-R BS.2088: Long-form file format for the international exchange of audio programme materials with metadata (BW64)', href: null },
  ID3: { title: 'ID3 tag version 2.3 / 2.4 (id3.org)', href: null },
};

const REGISTRY = new Map(); // key -> def
const LISTS = new Map(); // list type -> def
const FORMS = new Map(); // RIFF form type -> def
const IN_LIST = new Map(); // `${listType}/${id}` -> def

function finish(def) {
  const spec = SPECS[def.spec];
  if (spec) {
    def.specTitle = def.specTitle ?? spec.title;
    def.specHref = def.specHref ?? spec.href;
  }
  if (def.sec && !def.section) def.section = def.sec;
  return def;
}

/** Register a chunk by ID (optionally only inside one list type). */
export function chunk(id, def, { inList } = {}) {
  const d = finish({ type: id, ...def });
  if (inList) for (const l of [].concat(inList)) IN_LIST.set(`${l}/${id}`, d);
  else REGISTRY.set(id, d);
  return d;
}

export function list(type, def) {
  const d = finish({ type, container: true, ...def });
  LISTS.set(type, d);
  return d;
}

export function form(type, def) {
  const d = finish({ type, container: true, ...def });
  FORMS.set(type, d);
  return d;
}

// Resolvers for chunk IDs that follow a pattern (movi media chunks, ix##...).
const RESOLVERS = [];
export function resolver(fn) {
  RESOLVERS.push(fn);
}

const cache = new Map();

/** The definition for a chunk, given its ID, list type and parent node. */
export function lookupDef(ctx, id, listType, parent) {
  const parentList = parent?.data?.listType ?? null;
  if (id === 'RIFF' || id === 'RF64' || id === 'BW64' || id === 'RIFX') {
    const f = FORMS.get(`${id}:${listType}`) ?? FORMS.get(listType);
    if (f) return f;
    return cached(`form:${id}:${listType}`, () => finish({
      type: id,
      name: `${id} '${listType ?? '?'}' file`,
      cat: 'type',
      container: true,
      spec: 'RIFF',
      desc: `A RIFF file of form '${listType ?? '?'}': one big chunk whose form type says how to interpret the chunks inside. Vidscope decodes the AVI and WAVE forms in detail; for other forms it shows the chunk structure.`,
    }));
  }
  if (id === 'LIST') {
    const l = LISTS.get(`${parentList}/${listType}`) ?? LISTS.get(listType);
    if (l) return l;
    return cached(`list:${listType}`, () => finish({
      type: listType,
      name: `LIST '${listType ?? '?'}'`,
      cat: 'unknown',
      container: true,
      spec: 'RIFF',
      desc: `A LIST chunk of type '${listType ?? '?'}': a group of sub-chunks that Vidscope has no description for.`,
      more: 'A LIST chunk holds a four-character list type followed by sub-chunks. Readers that do not know the list type skip the whole list.',
    }));
  }
  const inList = IN_LIST.get(`${parentList}/${id}`);
  if (inList) return inList;
  if (parentList === 'INFO' && id !== 'JUNK') return infoDef(id);
  for (const fn of RESOLVERS) {
    const d = fn(ctx, id, parentList, parent);
    if (d) return d;
  }
  const d = REGISTRY.get(id);
  if (d) return d;
  return cached(`unknown:${id}`, () => finish({
    type: id,
    name: `'${id}' chunk`,
    cat: 'unknown',
    opaque: true,
    spec: 'RIFF',
    desc: `A chunk with ID '${id}' that Vidscope has no description for. Readers skip unknown chunks using ckSize, so it does not affect playback.`,
  }));
}

function cached(key, make) {
  let d = cache.get(key);
  if (!d) {
    d = make();
    cache.set(key, d);
  }
  return d;
}

/** The record the inspector shows (a definition is already in that shape). */
export function nodeDef(def) {
  return def;
}

// ------------------------------------------------------------ text helpers

/** Decode text that is usually ASCII/UTF-8 but may be Latin-1 in old files. */
export function text(u8) {
  const t = decodeText(u8, 'utf-8');
  return t.includes('\uFFFD') ? decodeText(u8, 'latin1') : t;
}

/** A NUL-terminated string filling the rest of the reader (RIFF ZSTR). */
export function zstr(r, name, o = {}) {
  const start = r.pos;
  let e = start;
  while (e < r.end && r.u[e] !== 0) e++;
  const value = text(r.u.subarray(start, e));
  const n = r.end - start;
  if (n <= 0) return '';
  r.bytes(name, n, {
    ...o,
    display: `"${value}"${e < r.end - 1 ? ` + ${fmtInt(r.end - e)} NUL/padding bytes` : ''}`,
  });
  const f = r.out[r.out.length - 1];
  f.type = 'ZSTR';
  f.value = value;
  return value;
}

// ------------------------------------------------------------ generic chunks

chunk('JUNK', {
  name: 'JUNK (filler)',
  cat: 'free',
  spec: 'AVI',
  opaque: true,
  peek: 64,
  desc: 'Filler: a chunk whose contents mean nothing. Readers skip it.',
  more: 'Writers use JUNK to align data (for example so that movi, or each frame, starts on a 2048-byte CD-ROM sector boundary) and to reserve room in the headers that can be rewritten later without moving the media. FFmpeg reserves space in every strl for an OpenDML super index and at the end of hdrl for the OpenDML "odml" header; that space is turned into real \'indx\' and \'LIST odml\' chunks only if the file grows past the 1 GB RIFF limit.',
  parse(r, node, ctx) {
    junkPlaceholder(r, node, ctx);
  },
});
REGISTRY.set('junk', REGISTRY.get('JUNK'));

chunk('PAD ', {
  name: 'PAD (filler)',
  cat: 'free',
  spec: 'RIFF',
  opaque: true,
  desc: 'Padding: a filler chunk, like JUNK, used to align the next chunk (often the data chunk) to a sector boundary.',
});

chunk('FLLR', {
  name: 'FLLR (filler)',
  cat: 'free',
  opaque: true,
  desc: 'Filler written by some professional recorders (a JUNK equivalent); readers skip it.',
});

/** Recognise the header placeholders FFmpeg (and others) leave inside JUNK. */
function junkPlaceholder(r, node, ctx) {
  const u = r.u;
  const p = r.pos;
  const n = r.end - p;
  const fcc = (i) => (n >= i + 4 ? String.fromCharCode(u[p + i], u[p + i + 1], u[p + i + 2], u[p + i + 3]) : '');
  if (n >= 12 && fcc(0) === 'odml' && fcc(4) === 'dmlh') {
    node.data.placeholder = 'odml';
    node.label = 'reserved: odml header';
    node.data.summary = 'Space reserved for an OpenDML \'odml\' list (inactive)';
    r.fourcc('reserved listType', { desc: 'The list type an OpenDML writer will use if it turns this JUNK into LIST \'odml\'. While the ID is still JUNK, readers ignore it.' });
    r.fourcc('reserved ckID', { desc: 'The dmlh chunk prepared inside the placeholder.' });
    r.u32('reserved ckSize', { unit: 'bytes' });
    return;
  }
  if (n >= 12 && u[p] === 4 && u[p + 1] === 0 && (u[p + 3] === 0 || u[p + 3] === 1) && /^(\d\d|ix)(dc|db|wb|tx|\d\d)$/.test(fcc(8))) {
    node.data.placeholder = 'indx';
    node.label = 'reserved: super index';
    node.data.summary = 'Space reserved for an OpenDML super index (inactive)';
    r.u16('reserved wLongsPerEntry', { desc: 'Header of the AVISUPERINDEX the writer prepared here. It becomes a real \'indx\' chunk only if the file needs OpenDML indexes (over 1 GB).' });
    r.u8('reserved bIndexSubType');
    r.u8('reserved bIndexType');
    r.u32('reserved nEntriesInUse');
    r.fourcc('reserved dwChunkId');
    return;
  }
  void ctx;
}

// ------------------------------------------------------------ INFO

list('INFO', {
  name: 'INFO list (metadata)',
  cat: 'meta',
  spec: 'MMSPEC',
  desc: 'Metadata stored as short text chunks: title (INAM), artist (IART), comments (ICMT), creation date (ICRD), the software that wrote the file (ISFT)...',
  more: 'The INFO list comes from the 1991 RIFF specification and works the same way in AVI and WAV. Each sub-chunk holds a NUL-terminated string. Players show few of these fields; tools like MediaInfo and FFmpeg read them as tags.',
  after(node) {
    const tags = (node.children ?? []).filter((c) => c.data.text !== undefined).map((c) => `${c.type}=${c.data.text}`);
    if (tags.length) node.data.summary = tags.join(', ').slice(0, 120);
  },
});

function infoDef(id) {
  return cached(`info:${id}`, () => {
    const [name, desc] = INFO_TAGS[id] ?? [`'${id}' tag`, 'An INFO tag Vidscope has no description for.'];
    return finish({
      type: id,
      name: `${id} — ${name}`,
      cat: 'meta',
      spec: 'MMSPEC',
      desc: `${desc} Stored as a NUL-terminated string.`,
      parse(r, node) {
        const v = zstr(r, 'text', { key: true, desc: 'The text, terminated by a NUL byte (ZSTR).' });
        node.data.text = v;
        node.label = v.length > 40 ? `${v.slice(0, 40)}…` : v;
      },
    });
  });
}

// ------------------------------------------------------------ helpers for AVI chunk IDs

/** Stream number and type of a movi chunk ID like '00dc' or '01wb', or null. */
export function mediaChunkInfo(id) {
  if (!id || id.length !== 4) return null;
  const d0 = id.charCodeAt(0) - 48;
  const d1 = id.charCodeAt(1) - 48;
  if (d0 < 0 || d0 > 9 || d1 < 0 || d1 > 9) return null;
  const tt = id.slice(2);
  if (!/^[a-z]{2}$/.test(tt)) return null;
  return { stream: d0 * 10 + d1, twocc: tt };
}

/** Stream number of an OpenDML standard index chunk ('ix00' or '00ix'). */
export function ixStream(id) {
  let m = /^ix(\d\d)$/.exec(id);
  if (m) return Number(m[1]);
  m = /^(\d\d)ix$/.exec(id);
  return m ? Number(m[1]) : null;
}

export const STREAM_KIND = { vids: 'video', auds: 'audio', txts: 'subtitle', mids: 'data', iavs: 'video', dats: 'data' };
