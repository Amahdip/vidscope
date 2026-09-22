// Core helpers: the field reader, offsets parsing and the block cache.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FieldReader, ParseError, cell } from '../web/core/fields.js';
import { parseOffset, fmtDuration, humanSize, pct } from '../web/core/util.js';
import { CachedSource, BytesSource } from '../web/core/source.js';
import { toRbsp } from '../web/codecs/nal.js';
import { Node, segments, fieldsAt } from '../web/core/model.js';

test('FieldReader records positions of bytes and bits', () => {
  const r = new FieldReader(new Uint8Array([0x00, 0x00, 0x01, 0x00, 0b10110000]), 100);
  assert.equal(r.u24('a'), 1);
  assert.equal(r.u8('b'), 0);
  assert.equal(r.bits(1, 'c'), 1);
  assert.equal(r.bits(2, 'd'), 1);
  const [a, , c, d] = r.out;
  assert.deepEqual([a.offset, a.size], [100, 3]);
  assert.deepEqual([c.offset, c.bitOffset, c.bitSize], [104, 0, 1]);
  assert.deepEqual([d.offset, d.bitOffset, d.bitSize], [104, 1, 2]);
  assert.throws(() => r.u32('too far'), ParseError);
});

test('Exp-Golomb codes', () => {
  // 1 | 010 | 011 | 00100 -> ue 0, 1, 2, 3
  const r = new FieldReader(new Uint8Array([0b10100110, 0b01000000]));
  assert.deepEqual([r.ue('a'), r.ue('b'), r.ue('c'), r.ue('d')], [0, 1, 2, 3]);
  const s = new FieldReader(new Uint8Array([0b01001110, 0])); // 010 | 011 | 1 -> se +1, -1, 0
  assert.deepEqual([s.se('a'), s.se('b'), s.se('c')], [1, -1, 0]);
});

test('unaligned byte-sized fields are read bitwise', () => {
  const r = new FieldReader(new Uint8Array([0b10000000, 0b01111111, 0b10000000]));
  r.flag('x');
  assert.equal(r.u8('y'), 0);
  assert.equal(r.u8('z'), 0xff);
});

test('tables decode cells lazily', () => {
  const bytes = new Uint8Array([0, 0, 0, 5, 0, 0, 2, 0, 0, 0, 0, 7, 0, 0, 1, 0]);
  const r = new FieldReader(bytes, 0);
  const t = r.table('entries', 2, 8, [{ name: 'count', type: 'u32' }, { name: 'delta', type: 'u32' }]);
  assert.equal(cell(t, 1, 0), 7);
  assert.equal(cell(t, 0, 1), 512);
});

test('emulation prevention bytes are removed and mapped back', () => {
  const { rbsp, map, removed } = toRbsp(new Uint8Array([0x67, 0x00, 0x00, 0x03, 0x01, 0xff]), 0, 6, 1000);
  assert.deepEqual([...rbsp], [0x67, 0x00, 0x00, 0x01, 0xff]);
  assert.deepEqual([...map], [1000, 1001, 1002, 1004, 1005]);
  assert.equal(removed, 1);
});

test('parseOffset understands the formats the go-to box accepts', () => {
  assert.equal(parseOffset('0x28', 1000), 40);
  assert.equal(parseOffset('40', 1000), 40);
  assert.equal(parseOffset('1k', 1e9), 1024);
  assert.equal(parseOffset('50%', 1000), 500);
  assert.equal(parseOffset('-10', 1000), 990);
  assert.equal(parseOffset('28h', 1000), 40);
  assert.equal(parseOffset('nonsense!', 1000), null);
});

test('formatting', () => {
  assert.equal(fmtDuration(7457.867), '2:04:17.867');
  assert.equal(humanSize(111779326), '106.6 M');
  assert.equal(pct(32, 115907270), '<0.01%');
});

test('CachedSource assembles reads across blocks and serves them synchronously', async () => {
  const data = Uint8Array.from({ length: 300 }, (_, i) => i & 0xff);
  const src = new CachedSource(new BytesSource(data), { blockSize: 64, maxBytes: 64 * 20 });
  assert.equal(src.readSync(60, 10), null);
  const got = await src.read(60, 10);
  assert.deepEqual([...got], [...data.subarray(60, 70)]);
  assert.deepEqual([...src.readSync(60, 10)], [...data.subarray(60, 70)]);
  assert.equal((await src.read(290, 50)).length, 10);
});

test('segments split bytes by node, header field and payload', () => {
  const root = new Node({ type: 'file', offset: 0, size: 20 });
  const box = root.add(new Node({ type: 'box', offset: 0, size: 12, headerSize: 8 }));
  box.fields = [
    { name: 'size', type: 'u32', offset: 0, size: 4, role: 'header' },
    { name: 'type', type: 'fourcc', offset: 4, size: 4, role: 'header' },
  ];
  const segs = segments(root, 0, 20);
  assert.deepEqual(segs.map((s) => [s.start, s.end, s.node.type, s.role]), [[0, 4, 'box', 'hdr'], [4, 8, 'box', 'hdr'], [8, 12, 'box', 'pay'], [12, 20, 'file', 'pay']]);
  assert.equal(fieldsAt(box, 5)[0].f.name, 'type');
});
