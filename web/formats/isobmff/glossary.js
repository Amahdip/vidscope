// Glossary for ISO-BMFF files: Vidscope's box descriptions plus every code
// registered at mp4ra.org (boxes, codecs, brands, handlers).

import { BOXES } from './boxes.js';
import { REGISTRY, specTitle, mp4raUrl, conformanceUrl } from './registry.js';
import { CODEC_NAMES } from '../../codecs/index.js';

const MP4_CONCEPTS = [
  ['box', 'Box (atom)', 'The building block of ISO-BMFF files. Every box starts with a 4-byte size and a 4-byte type, followed by its contents, which may be other boxes. A reader that does not know a type skips it using the size. QuickTime calls boxes atoms.'],
  ['FullBox', 'FullBox', 'A box whose contents start with a 1-byte version and 3 bytes of flags. The version usually switches fields between 32 and 64 bits; the flags say which optional fields are present.'],
  ['largesize', 'largesize (64-bit box size)', 'When a box is 4 GB or larger its 32-bit size field holds 1 and the real size follows as a 64-bit largesize, making the header 16 bytes.'],
  ['brand', 'Brand', 'A four-character code in ftyp naming a specification the file conforms to (isom, mp41, avc1, qt, cmfc...). Readers accept a file if they support any of its compatible brands.'],
  ['handler', 'Handler', 'The hdlr box of a track says what kind of media it holds (\'vide\', \'soun\', \'subt\'...), which decides how the rest of the track is read.'],
  ['sample-entry', 'Sample entry', 'An entry in stsd that describes a track’s codec. Its type is the codec’s four-character code (avc1, hvc1, mp4a, Opus...) and it contains the codec configuration (avcC, esds...).'],
  ['sample-table', 'Sample tables', 'The boxes inside stbl that index every sample: stts (durations), ctts (composition offsets), stss (key frames), stsz (sizes), stsc (samples per chunk) and stco/co64 (chunk offsets). From them a player can find and time any sample without reading the media.'],
  ['chunk', 'Chunk', 'A run of consecutive samples of one track stored back to back in mdat. stsc says how many samples each chunk holds and stco where each chunk starts.'],
  ['edit-list', 'Edit list', 'The elst box maps the track’s media time onto the movie timeline: it can delay a track, skip its beginning (encoder delay) or cut it into pieces.'],
  ['fragment', 'Movie fragment', 'A moof box and the mdat that follows it. The moof indexes only the samples of that fragment, with trun boxes instead of the stbl sample tables.'],
];

const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

let cached = null;

function staticEntries() {
  if (cached) return cached;
  const list = [];
  const seen = new Set();
  const add = (e) => {
    const k = `${e.cat}:${e.term}`;
    if (seen.has(k)) return;
    seen.add(k);
    list.push(e);
  };
  for (const [term, name, desc] of MP4_CONCEPTS) add({ term, name, desc, cat: 'concept' });
  for (const [type, def] of Object.entries(BOXES)) {
    add({
      term: type,
      name: def.name,
      desc: def.desc,
      more: def.more,
      cat: 'box',
      kcat: def.cat,
      spec: def.spec ? `${specTitle(def.spec)}${def.sec ? ` § ${def.sec}` : ''}` : null,
      url: mp4raUrl('boxes'),
      conformance: REGISTRY.ffc.boxes[type] ? conformanceUrl(type) : null,
    });
  }
  for (const cat of ['boxes', 'boxes-qt', 'boxes-udta', 'sample-entry-boxes', 'item-properties']) {
    for (const [code, [desc, spec]] of Object.entries(REGISTRY.reg[cat] ?? {})) {
      add({ term: code, name: cap(desc), desc: `Registered at mp4ra.org as "${desc}" (${spec}).`, cat: 'box', kcat: 'meta', spec: specTitle(spec), url: mp4raUrl(cat), registryOnly: true });
    }
  }
  for (const cat of ['codecs', 'codecs-qt']) {
    for (const [code, [desc, spec, handler]] of Object.entries(REGISTRY.reg[cat] ?? {})) {
      add({ term: code, name: CODEC_NAMES[code] ?? cap(desc), desc: `Sample entry (codec) code: ${desc}${handler ? `, for ${handler.toLowerCase()} tracks` : ''} (${spec}).`, cat: 'codec', kcat: 'codec', spec: specTitle(spec), url: mp4raUrl(cat) });
    }
  }
  for (const [code, [desc, spec]] of Object.entries(REGISTRY.reg.brands ?? {})) {
    add({ term: code, name: cap(desc), desc: `Brand: ${desc} (${spec}).`, cat: 'brand', kcat: 'type', spec: specTitle(spec), url: mp4raUrl('brands') });
  }
  for (const [code, [desc, spec]] of Object.entries(REGISTRY.reg.handlers ?? {})) {
    add({ term: code, name: cap(desc), desc: `Handler type: ${desc} (${spec}).`, cat: 'handler', kcat: 'header', spec: specTitle(spec), url: mp4raUrl('handlers') });
  }
  cached = list;
  return list;
}

export function glossary() {
  return staticEntries();
}
