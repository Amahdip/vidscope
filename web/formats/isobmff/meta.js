// Metadata (udta, meta, ilst, keys), HEIF items and Common Encryption boxes.

import { fmtInt, fmtDuration, decodeText, uuidString, hexBytes } from '../../core/util.js';
import { BOXES, language } from './boxes.js';
import { reg } from './registry.js';

const def = (type, d) => {
  BOXES[type] = { spec: 'ISO', ...d };
};

// ------------------------------------------------------------------ user data / metadata

def('udta', {
  name: 'User Data Box',
  cat: 'meta',
  sec: '8.10.1',
  container: true,
  desc: 'Free-form information about the movie or track: title, copyright, encoder, chapters and similar.',
  more: 'Players ignore what they don’t understand here. MP4 files usually keep iTunes-style tags in udta › meta › ilst; QuickTime files often use ©-prefixed text atoms directly in udta.',
});

def('meta', {
  name: 'Meta Box',
  cat: 'meta',
  sec: '8.11.1',
  full: true,
  container: true,
  desc: 'A metadata container. Its hdlr says what is inside: \'mdir\' for iTunes-style tags, \'mdta\' for QuickTime metadata keys, \'pict\' for HEIF images.',
});

def('ilst', {
  name: 'Metadata Item List',
  cat: 'meta',
  spec: 'iTunes',
  container: true,
  desc: 'The iTunes-style tags (title, artist, encoder, cover art...), one box per tag, each holding a \'data\' box with the value.',
  syntax: 'aligned(8) class MetadataItemListBox extends Box(\'ilst\') {\n    MetadataItemBox items[];   // box type = tag name (e.g. \'©nam\'),\n                               // or a 1-based index into \'keys\'\n}\n\naligned(8) class MetadataItemBox extends Box(tag) {\n    DataBox value;             // \'data\'\n}',
});

export const ILST_NAMES = {
  '©nam': 'Title', '©ART': 'Artist', aART: 'Album artist', '©alb': 'Album', '©gen': 'Genre', gnre: 'Genre (ID3 index)',
  '©day': 'Date / year', '©too': 'Encoding tool', '©cmt': 'Comment', '©wrt': 'Composer', '©grp': 'Grouping', '©lyr': 'Lyrics',
  desc: 'Description', ldes: 'Long description', cprt: 'Copyright', trkn: 'Track number', disk: 'Disc number', tmpo: 'Tempo (BPM)',
  cpil: 'Part of a compilation', covr: 'Cover art', stik: 'Media kind', tvsh: 'TV show', tven: 'TV episode ID', tvsn: 'TV season',
  tves: 'TV episode', tvnn: 'TV network', sonm: 'Sort name', soar: 'Sort artist', soal: 'Sort album', soaa: 'Sort album artist',
  soco: 'Sort composer', sosn: 'Sort show', pgap: 'Gapless playback', hdvd: 'HD video', rtng: 'Content rating', purd: 'Purchase date',
  '©enc': 'Encoded by', '©xyz': 'GPS location', catg: 'Category', keyw: 'Keywords', purl: 'Podcast URL', egid: 'Episode GUID',
  pcst: 'Podcast', '©st3': 'Subtitle', '©swr': 'Software', '©mak': 'Camera make', '©mod': 'Camera model', '----': 'Custom tag',
  '©inf': 'Information', '©req': 'Requirements', '©src': 'Source', '©dir': 'Director', '©prd': 'Producer', '©fmt': 'Format',
};

const DATA_TYPES = {
  0: 'binary / implicit', 1: 'UTF-8 text', 2: 'UTF-16 text', 3: 'S/JIS text', 4: 'UTF-8 sort key', 5: 'UTF-16 sort key',
  13: 'JPEG image', 14: 'PNG image', 21: 'signed integer', 22: 'unsigned integer', 23: 'float32', 24: 'float64', 27: 'BMP image',
  28: 'QuickTime metadata atom', 65: 'int8', 66: 'int16', 67: 'int32', 70: 'point (2 × float32)', 71: 'dimensions',
  72: 'rectangle', 74: 'int64', 75: 'uint8', 76: 'uint16', 77: 'uint32', 78: 'uint64', 79: 'affine transform',
};

export function ilstItemDef(type, ctx) {
  let name = ILST_NAMES[type];
  if (!name && /^\\x00\\x00/.test(type)) {
    // QuickTime 'mdta' metadata: the item type is a 1-based index into the keys box.
    const idx = type.split('\\x').filter(Boolean).reduce((v, h) => v * 256 + parseInt(h.slice(0, 2), 16), 0);
    name = ctx.metaKeys?.[idx - 1] ? `key ${idx}: ${ctx.metaKeys[idx - 1]}` : `key ${idx}`;
  }
  return {
    id: `ilst:${type}`,
    name: name ? `${name} (tag)` : `Metadata tag '${type}'`,
    cat: 'meta',
    spec: 'iTunes',
    container: true,
    desc: name ? `The "${name}" metadata tag. Its value is in the data box inside.` : 'A metadata tag. Its value is in the data box inside.',
  };
}

def('data', {
  name: 'Metadata Value',
  cat: 'meta',
  spec: 'iTunes',
  desc: 'The value of a metadata tag, with a type indicator (UTF-8 text, integer, JPEG/PNG image...) and a locale.',
  parse(r, n) {
    r.u8('type_set', { desc: 'Which type table is used; 0 = the well-known types.' });
    const type = r.u24('type', { key: true, enum: DATA_TYPES });
    r.u32('locale', { desc: 'Country and language of the value; 0 = default.' });
    const item = n.parent?.type;
    let summary = '';
    if (type === 1 || type === 4) {
      const s = r.str('value', r.remaining, { key: true });
      summary = s;
    } else if (type === 2 || type === 5) {
      const s = r.str('value', r.remaining, { key: true, encoding: 'utf-16be' });
      summary = s;
    } else if ((item === 'trkn' || item === 'disk') && r.remaining >= 6) {
      r.u16('reserved', { reserved: true });
      const a = r.u16('number', { key: true });
      const b = r.u16('total', { key: true });
      if (r.remaining) r.rest('reserved', { reserved: true });
      summary = `${a} of ${b}`;
    } else if ((type === 21 || type === 22 || type === 0) && r.remaining <= 8 && r.remaining > 0) {
      const len = r.remaining;
      const v = type === 21 && len <= 4 ? [0, 'i8', 'i16', 'i24', 'i32'][len] : null;
      summary = String(v ? r[v]('value', { key: true }) : r.uN(len, 'value', { key: true }));
    } else if (type === 13 || type === 14 || type === 27) {
      r.rest('value', { display: `${['', 'JPEG', 'PNG'][type - 12] || 'BMP'} image, ${fmtInt(r.remaining)} bytes`, key: true });
      summary = `${type === 13 ? 'JPEG' : type === 14 ? 'PNG' : 'BMP'} image`;
    } else if (r.remaining) {
      r.rest('value');
    }
    n.data.value = summary;
    n.data.summary = summary.length > 60 ? `${summary.slice(0, 60)}…` : summary;
    if (n.parent) n.parent.data.summary = n.data.summary;
  },
});

def('mean', { name: 'Tag Namespace', cat: 'meta', spec: 'iTunes', full: true, desc: 'Namespace of a custom (----) tag, e.g. "com.apple.iTunes".', parse: (r, n) => { n.data.summary = r.str('meaning', r.remaining); } });
def('name', {
  name: 'Name',
  cat: 'meta',
  spec: 'iTunes',
  full: true,
  desc: 'The name of a custom (----) metadata tag.',
  parse: (r, n) => { n.data.summary = r.str('name', r.remaining, { key: true }); },
});

def('keys', {
  name: 'Metadata Keys',
  cat: 'meta',
  spec: 'QT',
  full: true,
  desc: 'QuickTime metadata keys: the names (e.g. "com.apple.quicktime.make") of the tags in the ilst that follows, which refers to them by index.',
  parse(r, n, ctx) {
    const count = r.u32('entry_count');
    const keys = [];
    for (let i = 0; i < count && r.remaining >= 8; i++) {
      r.group(`key[${i + 1}]`, (g) => {
        const size = r.u32('key_size', { unit: 'bytes' });
        r.fourcc('key_namespace', { enum: { mdta: 'reverse-DNS key' }, enumUnknown: false });
        const k = r.str('key_value', Math.max(0, size - 8), { key: true });
        keys.push(k);
        g.display = k;
      });
    }
    ctx.metaKeys = keys;
    n.data.summary = `${keys.length} keys`;
  },
});

export function qtTextAtomDef(type) {
  const reg1 = reg('boxes-udta', type) ?? reg('boxes-qt', type);
  return {
    id: `qttext:${type}`,
    name: `${ILST_NAMES[type] ?? (reg1 ? reg1[0] : `'${type}'`)} (QuickTime text)`,
    cat: 'meta',
    spec: 'QT',
    desc: 'A QuickTime user-data text item: one or more strings, each with a 16-bit length and a language code.',
    parse(r, n) {
      let i = 0;
      const texts = [];
      while (r.remaining >= 4) {
        const len = r.dv.getUint16(r.pos);
        if (len > r.remaining - 4) break;
        r.group(`text[${i++}]`, () => {
          r.u16('size', { unit: 'bytes' });
          r.u16('language', { display: (v) => (v < 0x400 ? `${v} (Macintosh code)` : `0x${v.toString(16)}`) });
          texts.push(r.str('text', len, { key: true }));
        });
      }
      if (r.remaining) r.rest('data');
      n.data.value = texts.join(' / ');
      n.data.summary = n.data.value.length > 60 ? `${n.data.value.slice(0, 60)}…` : n.data.value;
    },
  };
}

def('chpl', {
  name: 'Chapter List (Nero)',
  cat: 'meta',
  spec: 'Nero',
  full: true,
  desc: 'Chapter start times and titles, in the format first used by Nero and still written by FFmpeg.',
  parse(r, n) {
    if (n.data.version === 1) r.u32('reserved', { reserved: true });
    const count = r.u8('chapter_count', { key: true });
    const chapters = [];
    for (let i = 0; i < count && r.remaining >= 9; i++) {
      r.group(`chapter[${i}]`, (g) => {
        const t = r.u64('start_time', { display: (v) => `${fmtInt(v)} → ${fmtDuration(v / 1e7)}`, desc: 'Start time in 100-nanosecond units.' });
        const len = r.u8('title_length');
        const title = r.str('title', len, { key: true });
        chapters.push({ t: t / 1e7, title });
        g.display = `${fmtDuration(t / 1e7)} ${title}`;
      });
    }
    n.data.chapters = chapters;
    n.data.summary = `${chapters.length} chapters`;
  },
});

// ------------------------------------------------------------------ track references

export function trefTypeDef(type) {
  const r1 = reg('track-references', type) ?? reg('track-references-qt', type);
  return {
    id: `tref:${type}`,
    name: `Track reference '${type}'${r1 ? ` (${r1[0]})` : ''}`,
    cat: 'track',
    desc: r1 ? `This track ${r1[0].replace(/^./, (c) => c.toLowerCase())}: the tracks listed below.` : 'Links this track to the tracks listed below.',
    parse(r, n) {
      const ids = [];
      let i = 0;
      while (r.remaining >= 4) ids.push(r.u32(`track_IDs[${i++}]`, { key: true }));
      n.data.ids = ids;
      n.data.summary = `→ track ${ids.join(', ')}`;
    },
  };
}

export function trackGroupDef(type) {
  return {
    id: `trgr:${type}`,
    name: `Track group '${type}'`,
    cat: 'track',
    full: true,
    desc: 'Tracks with the same track_group_id belong together.',
    parse: (r) => r.u32('track_group_id', { key: true }),
  };
}

// ------------------------------------------------------------------ HEIF / items

def('pitm', {
  name: 'Primary Item Box',
  cat: 'meta',
  full: true,
  sec: '8.11.4',
  desc: 'Which item is the main one; in a HEIF/AVIF image, the picture to show.',
  parse(r, n) {
    n.data.item = n.data.version === 0 ? r.u16('item_ID', { key: true }) : r.u32('item_ID', { key: true });
    n.data.summary = `item ${n.data.item}`;
  },
});

def('iloc', {
  name: 'Item Location Box',
  cat: 'meta',
  full: true,
  sec: '8.11.3',
  desc: 'Where each item’s data is: one or more extents (offset + length) in this file or in idat.',
  parse(r, n) {
    const v = n.data.version;
    const offSize = r.bits(4, 'offset_size', { unit: 'bytes' });
    const lenSize = r.bits(4, 'length_size', { unit: 'bytes' });
    const baseSize = r.bits(4, 'base_offset_size', { unit: 'bytes' });
    const idxSize = v === 1 || v === 2 ? r.bits(4, 'index_size', { unit: 'bytes' }) : (r.bits(4, 'reserved', { reserved: true }), 0);
    const count = v < 2 ? r.u16('item_count') : r.u32('item_count');
    for (let i = 0; i < count && r.remaining > 0; i++) {
      r.group(`item[${i}]`, (g) => {
        const id = v < 2 ? r.u16('item_ID', { key: true }) : r.u32('item_ID', { key: true });
        let method = 0;
        if (v === 1 || v === 2) {
          r.bits(12, 'reserved', { reserved: true });
          method = r.bits(4, 'construction_method', { enum: { 0: 'file offset', 1: 'idat offset', 2: 'item offset' } });
        }
        r.u16('data_reference_index');
        r.uN(baseSize, 'base_offset');
        const ec = r.u16('extent_count');
        let total = 0;
        for (let e = 0; e < ec; e++) {
          r.group(`extent[${e}]`, () => {
            if (idxSize) r.uN(idxSize, 'extent_index');
            r.uN(offSize, 'extent_offset', method === 0 ? { ref: 'offset' } : undefined);
            total += r.uN(lenSize, 'extent_length', { unit: 'bytes' });
          });
        }
        g.display = `item ${id}: ${ec} extent${ec === 1 ? '' : 's'}, ${fmtInt(total)} bytes`;
      });
    }
  },
});

def('iinf', {
  name: 'Item Information Box',
  cat: 'meta',
  full: true,
  sec: '8.11.6',
  container: true,
  desc: 'One infe entry per item: its ID, type and name.',
  parse(r, n) {
    n.data.count = n.data.version === 0 ? r.u16('entry_count') : r.u32('entry_count');
  },
});

def('infe', {
  name: 'Item Info Entry',
  cat: 'meta',
  full: true,
  sec: '8.11.6',
  desc: 'An item’s ID, type (\'hvc1\'/\'av01\' coded image, \'grid\', \'Exif\', \'mime\'...) and name.',
  parse(r, n) {
    const v = n.data.version;
    if (v >= 2) {
      const id = v === 2 ? r.u16('item_ID', { key: true }) : r.u32('item_ID', { key: true });
      r.u16('item_protection_index');
      const type = r.fourcc('item_type', { key: true, display: (t) => `'${t}'${reg('item-types', t) ? ` — ${reg('item-types', t)[0]}` : ''}` });
      const name = r.remaining ? r.cstr('item_name') : '';
      if (type === 'mime' && r.remaining) {
        r.cstr('content_type', { key: true });
        if (r.remaining) r.cstr('content_encoding');
      } else if (type === 'uri ' && r.remaining) r.cstr('item_uri_type');
      n.data.summary = `#${id} '${type}'${name ? ` "${name}"` : ''}`;
    } else {
      const id = r.u16('item_ID', { key: true });
      r.u16('item_protection_index');
      r.cstr('item_name');
      if (r.remaining) r.cstr('content_type');
      if (r.remaining) r.cstr('content_encoding');
      n.data.summary = `#${id}`;
    }
  },
});

def('iref', {
  name: 'Item Reference Box',
  cat: 'meta',
  full: true,
  sec: '8.11.12',
  container: true,
  desc: 'Relations between items, e.g. a thumbnail (\'thmb\'), the tiles of a grid image (\'dimg\') or an alpha plane (\'auxl\').',
  parse(r, n, ctx) {
    ctx.irefVersion = n.data.version;
  },
});

export function irefTypeDef(type) {
  const r1 = reg('item-references', type);
  return {
    id: `iref:${type}`,
    name: `Item reference '${type}'${r1 ? ` (${r1[0]})` : ''}`,
    cat: 'meta',
    desc: 'Links one item to others.',
    parse(r, n, ctx) {
      const big = ctx.irefVersion === 1;
      const from = big ? r.u32('from_item_ID', { key: true }) : r.u16('from_item_ID', { key: true });
      const count = r.u16('reference_count');
      const to = [];
      for (let i = 0; i < count && r.remaining >= (big ? 4 : 2); i++) to.push(big ? r.u32(`to_item_ID[${i}]`) : r.u16(`to_item_ID[${i}]`));
      n.data.summary = `${from} → ${to.join(', ')}`;
    },
  };
}

def('iprp', { name: 'Item Properties Box', cat: 'meta', sec: '8.11.14', container: true, desc: 'Item properties (ipco) and which items use them (ipma).' });
def('ipco', { name: 'Item Property Container', cat: 'meta', sec: '8.11.14', container: true, desc: 'The property boxes (sizes, codec configs, rotation...) that ipma refers to by 1-based index.' });

def('ipma', {
  name: 'Item Property Association',
  cat: 'meta',
  full: true,
  sec: '8.11.14',
  desc: 'For each item, which properties (by index into ipco) apply, and which of them a reader must understand ("essential").',
  parse(r, n) {
    const count = r.u32('entry_count');
    const wide = n.data.flags & 1;
    for (let i = 0; i < count && r.remaining > 0; i++) {
      r.group(`entry[${i}]`, (g) => {
        const id = n.data.version < 1 ? r.u16('item_ID', { key: true }) : r.u32('item_ID', { key: true });
        const ac = r.u8('association_count');
        const props = [];
        for (let k = 0; k < ac; k++) {
          const ess = r.flag(`essential[${k}]`);
          const idx = r.bits(wide ? 15 : 7, `property_index[${k}]`);
          props.push(`${idx}${ess ? '!' : ''}`);
        }
        g.display = `item ${id}: properties ${props.join(', ')}`;
      });
    }
  },
});

def('ispe', {
  name: 'Image Spatial Extents',
  cat: 'meta',
  full: true,
  spec: 'HEIF',
  sec: '6.5.3',
  desc: 'The width and height of an image item, in pixels.',
  parse(r, n) {
    const w = r.u32('image_width', { key: true, unit: 'pixels' });
    const h = r.u32('image_height', { key: true, unit: 'pixels' });
    n.data.summary = `${w}×${h}`;
  },
});

def('pixi', {
  name: 'Pixel Information',
  cat: 'meta',
  full: true,
  spec: 'HEIF',
  sec: '6.5.6',
  desc: 'Number of channels and bits per channel of an image item.',
  parse(r, n) {
    const c = r.u8('num_channels');
    const bits = [];
    for (let i = 0; i < c; i++) bits.push(r.u8(`bits_per_channel[${i}]`));
    n.data.summary = bits.join('/') + ' bits';
  },
});

def('irot', {
  name: 'Image Rotation',
  cat: 'meta',
  spec: 'HEIF',
  sec: '6.5.10',
  desc: 'Rotate the image anticlockwise by angle × 90°.',
  parse(r, n) {
    r.bits(6, 'reserved', { reserved: true });
    const a = r.bits(2, 'angle', { key: true, display: (v) => `${v} → ${v * 90}° anticlockwise` });
    n.data.summary = `${a * 90}°`;
  },
});

def('imir', {
  name: 'Image Mirroring',
  cat: 'meta',
  spec: 'HEIF',
  sec: '6.5.12',
  desc: 'Mirror the image about a vertical or horizontal axis.',
  parse(r) {
    r.bits(7, 'reserved', { reserved: true });
    r.bits(1, 'axis', { enum: { 0: 'vertical axis (left-right flip)', 1: 'horizontal axis (top-bottom flip)' } });
  },
});

def('auxC', {
  name: 'Auxiliary Type Property',
  cat: 'meta',
  full: true,
  spec: 'HEIF',
  sec: '6.5.8',
  desc: 'What an auxiliary image is: an alpha plane, a depth map...',
  parse(r, n) {
    n.data.summary = r.cstr('aux_type', { key: true });
    if (r.remaining) r.rest('aux_subtype');
  },
});

def('grpl', { name: 'Groups List Box', cat: 'meta', sec: '8.18.3', container: true, desc: 'Groups of entities (items or tracks), such as alternatives or stereo pairs.' });

export function entityGroupDef(type) {
  const r1 = reg('entity-groups', type);
  return {
    id: `grpl:${type}`,
    name: `Entity group '${type}'${r1 ? ` (${r1[0]})` : ''}`,
    cat: 'meta',
    full: true,
    desc: 'A group of items or tracks.',
    parse(r) {
      r.u32('group_id');
      const n = r.u32('num_entities_in_group');
      for (let i = 0; i < n && r.remaining >= 4; i++) r.u32(`entity_id[${i}]`);
    },
  };
}

// ------------------------------------------------------------------ protection (CENC)

export const DRM_SYSTEMS = {
  'edef8ba9-79d6-4ace-a3c8-27dcd51d21ed': 'Widevine (Google)',
  '9a04f079-9840-4286-ab92-e65be0885f95': 'PlayReady (Microsoft)',
  '94ce86fb-07ff-4f43-adb8-93d2fa968ca2': 'FairPlay (Apple)',
  '1077efec-c0b2-4d02-ace3-3c1e52e2fb4b': 'W3C Common PSSH (ClearKey)',
  'e2719d58-a985-b3c9-781a-b030af78d30e': 'ClearKey (DASH-IF)',
  '5e629af5-38da-4063-8977-97ffbd9902d4': 'Marlin',
  'adb41c24-2dbf-4a6d-958b-4457c0d27b95': 'Nagra',
  '80a6be7e-1448-4c37-9e70-d5aebe04c8d2': 'Irdeto',
  'f239e769-efa3-4850-9c16-a903c6932efb': 'Adobe Primetime',
};

def('sinf', {
  name: 'Protection Scheme Information Box',
  cat: 'protect',
  sec: '8.12.1',
  container: true,
  desc: 'Present when a track is encrypted: the original codec (frma), the protection scheme (schm) and the key details (schi › tenc).',
  more: 'Encrypted tracks rename their sample entry to encv/enca so that players which cannot decrypt fail cleanly instead of decoding garbage.',
});

def('frma', {
  name: 'Original Format Box',
  cat: 'protect',
  sec: '8.12.2',
  desc: 'The codec the sample entry had before it was renamed to encv/enca for encryption (e.g. \'avc1\').',
  parse(r, n, ctx) {
    const f = r.fourcc('data_format', { key: true });
    if (ctx.entry) ctx.entry.originalFormat = f;
    n.data.summary = `'${f}'`;
  },
});

def('schm', {
  name: 'Scheme Type Box',
  cat: 'protect',
  full: true,
  sec: '8.12.5',
  desc: 'Which protection scheme is used: \'cenc\' (AES-CTR, full-sample) or \'cbcs\' (AES-CBC with a 1:9 pattern, used by HLS/FairPlay), among others.',
  parse(r, n, ctx) {
    const s = r.fourcc('scheme_type', { key: true, display: (v) => `'${v}'${reg('schemes', v) ? ` — ${reg('schemes', v)[0]}` : ''}` });
    r.u32('scheme_version', { display: (v) => `0x${v.toString(16).padStart(8, '0')}` });
    if (n.data.flags & 1 && r.remaining) r.cstr('scheme_uri');
    if (ctx.entry) ctx.entry.scheme = s;
    n.data.summary = `'${s}'`;
  },
});

def('schi', { name: 'Scheme Information Box', cat: 'protect', sec: '8.12.6', container: true, desc: 'Scheme-specific data, such as tenc for Common Encryption.' });

def('tenc', {
  name: 'Track Encryption Box',
  cat: 'protect',
  full: true,
  spec: 'CENC',
  sec: '8.2',
  desc: 'Encryption defaults for the track: whether samples are encrypted, the IV size and the default key ID (KID).',
  parse(r, n, ctx) {
    r.u8('reserved', { reserved: true });
    if (n.data.version === 0) r.u8('reserved', { reserved: true });
    else {
      r.bits(4, 'default_crypt_byte_block', { desc: 'Pattern encryption: encrypt this many 16-byte blocks...' });
      r.bits(4, 'default_skip_byte_block', { desc: '...then leave this many in the clear.' });
    }
    const prot = r.u8('default_isProtected', { key: true, enum: { 0: 'not encrypted', 1: 'encrypted' } });
    const iv = r.u8('default_Per_Sample_IV_Size', { unit: 'bytes', desc: '8 or 16 bytes of IV per sample, or 0 when a constant IV is used (cbcs).' });
    const kid = r.uuid('default_KID', { key: true, display: (v) => v.replace(/-/g, ''), desc: 'Key ID: which content key decrypts this track. Licence servers map KIDs to keys.' });
    if (prot === 1 && iv === 0 && r.remaining) {
      const cs = r.u8('default_constant_IV_size', { unit: 'bytes' });
      r.bytes('default_constant_IV', cs);
    }
    (ctx.tenc ||= {})[ctx.trackId ?? 0] = { ivSize: iv, kid };
    if (ctx.entry) ctx.entry.kid = kid;
    n.data.summary = `KID ${kid.replace(/-/g, '')}`;
  },
});

def('pssh', {
  name: 'Protection System Specific Header Box',
  cat: 'protect',
  full: true,
  spec: 'CENC',
  sec: '8.1',
  desc: 'Data for one DRM system (Widevine, PlayReady, FairPlay...): typically the key IDs and licence hints that system needs.',
  more: 'The SystemID says which DRM the data is for. In a browser, the player passes this box to that DRM through EME (Encrypted Media Extensions) to request a licence.',
  parse(r, n) {
    const sys = r.uuid('SystemID', { key: true, display: (v) => `${v}${DRM_SYSTEMS[v] ? ` — ${DRM_SYSTEMS[v]}` : ''}` });
    if (n.data.version > 0) {
      const kc = r.u32('KID_count');
      for (let i = 0; i < kc && r.remaining >= 16; i++) r.uuid(`KID[${i}]`, { display: (v) => v.replace(/-/g, '') });
    }
    const size = r.u32('DataSize', { unit: 'bytes' });
    if (size) r.bytes('Data', size, { desc: 'System-specific data (e.g. a Widevine protobuf or a PlayReady header object).' });
    n.data.system = DRM_SYSTEMS[sys] ?? sys;
    n.data.summary = DRM_SYSTEMS[sys] ?? sys;
  },
});

def('senc', {
  name: 'Sample Encryption Box',
  cat: 'protect',
  full: true,
  spec: 'CENC',
  sec: '7.2',
  flags: { 2: 'UseSubSampleEncryption' },
  desc: 'Per-sample encryption details: each sample’s IV and, for video, which byte ranges stay in the clear (NAL headers) and which are encrypted.',
  parse(r, n, ctx) {
    const count = r.u32('sample_count', { key: true });
    const iv = ctx.tenc?.[ctx.trackId ?? 0]?.ivSize ?? ctx.tenc?.[0]?.ivSize ?? 8;
    const sub = n.data.flags & 2;
    for (let i = 0; i < Math.min(count, 1000) && r.remaining > 0; i++) {
      r.group(`sample[${i}]`, (g) => {
        if (iv) r.bytes('InitializationVector', iv, { display: (v) => hexBytes(v) });
        if (sub) {
          const sc = r.u16('subsample_count');
          const t = r.table('subsamples', sc, 6, [
            { name: 'BytesOfClearData', type: 'u16' },
            { name: 'BytesOfProtectedData', type: 'u32' },
          ]);
          g.display = `${t.count} subsample${t.count === 1 ? '' : 's'}`;
        }
      });
    }
    if (r.remaining) r.rest('more_samples');
    n.data.summary = `${fmtInt(count)} samples`;
  },
});

export { DATA_TYPES, decodeText, uuidString, language };
