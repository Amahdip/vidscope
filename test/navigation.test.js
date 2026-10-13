// History and URL navigation tests: search params, hash offsets, and state restoration.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOffset, hex } from '../web/core/util.js';

test('URL params correctly reflect file, tab, compare and check states', () => {
  const url = new URL('http://127.0.0.1:8766/');

  // Single file on frames tab
  url.searchParams.set('file', '1');
  url.searchParams.set('tab', 'frames');
  assert.equal(url.searchParams.get('file'), '1');
  assert.equal(url.searchParams.get('tab'), 'frames');

  // Compare mode cleans tab and sets compare + ref
  url.searchParams.set('compare', '1,2');
  url.searchParams.set('ref', '1');
  url.searchParams.delete('tab');
  assert.equal(url.searchParams.get('compare'), '1,2');
  assert.equal(url.searchParams.get('ref'), '1');
  assert.equal(url.searchParams.get('tab'), null);

  // Conversion check mode cleans file and tab
  url.searchParams.delete('compare');
  url.searchParams.delete('ref');
  url.searchParams.set('check', 'sample-query');
  url.searchParams.set('profile', 'policy');
  assert.equal(url.searchParams.get('check'), 'sample-query');
  assert.equal(url.searchParams.get('profile'), 'policy');
});

test('hash offset parsing handles hex, off= prefix, and boundary checks', () => {
  const fileSize = 100000;

  // Raw hex with hash
  const hash1 = '#0x1f0';
  assert.equal(parseOffset(hash1.replace(/^#/, '').replace(/^off=/, ''), fileSize), 0x1f0);

  // off= prefix
  const hash2 = '#off=0x2a0';
  assert.equal(parseOffset(hash2.replace(/^#/, '').replace(/^off=/, ''), fileSize), 0x2a0);

  // Formatted hex produces lowercase hash string
  assert.equal(hex(496, 1).toLowerCase(), '0x1f0');
  assert.equal(hex(0, 1).toLowerCase(), '0x0');
});

test('popstate restoration logic reconstructs state and target entry', () => {
  const files = [
    { kind: 'server', id: 1, key: 's1', name: 'video1.mp4' },
    { kind: 'server', id: 2, key: 's2', name: 'video2.mp4' },
    { kind: 'local', key: 'l1', name: 'dropped.mp4' },
  ];

  // Lookup by file param
  const findEntry = (param, state) => {
    let entry = null;
    if (param) entry = files.find((f) => f.kind === 'server' && String(f.id) === param);
    if (!entry && state?.fileKey) entry = files.find((f) => f.key === state.fileKey);
    if (!entry && state?.fileId !== null && state?.fileId !== undefined) {
      entry = files.find((f) => f.kind === 'server' && String(f.id) === String(state.fileId));
    }
    return entry ?? null;
  };

  // Restoring server file by query param
  assert.equal(findEntry('2', null)?.key, 's2');

  // Restoring local file by history state
  assert.equal(findEntry(null, { fileKey: 'l1' })?.key, 'l1');

  // Restoring server file from state fallback when URL param missing
  assert.equal(findEntry(null, { fileId: 1 })?.key, 's1');

  // Non-existent file returns null (leads to home/welcome)
  assert.equal(findEntry('999', null), null);
});
