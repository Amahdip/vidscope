// The local server: file listing, byte ranges, and the guards that keep it local.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ROOT } from './helpers.mjs';

let proc;
let base;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vidscope-test-'));
const bytes = Buffer.from(Array.from({ length: 1000 }, (_, i) => i & 0xff));

before(async () => {
  fs.writeFileSync(path.join(dir, 'a.mp4'), bytes);
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'not media');
  proc = spawn(process.execPath, [path.join(ROOT, 'bin/vidscope.js'), '--no-open', '--port', '0', dir], { stdio: ['ignore', 'pipe', 'pipe'] });
  base = await new Promise((resolve, reject) => {
    let out = '';
    proc.stdout.on('data', (d) => {
      out += d;
      const m = /http:\/\/127\.0\.0\.1:(\d+)\//.exec(out);
      if (m) resolve(`http://127.0.0.1:${m[1]}`);
    });
    proc.on('exit', (code) => reject(new Error(`server exited ${code}: ${out}`)));
  });
});

after(() => {
  proc?.kill();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('lists only media files from a folder', async () => {
  const files = await (await fetch(`${base}/api/files`)).json();
  assert.deepEqual(files.map((f) => f.name), ['a.mp4']);
  assert.equal(files[0].size, 1000);
});

test('serves byte ranges', async () => {
  const r = await fetch(`${base}/api/files/1/data`, { headers: { Range: 'bytes=10-19' } });
  assert.equal(r.status, 206);
  assert.equal(r.headers.get('content-range'), 'bytes 10-19/1000');
  assert.deepEqual([...new Uint8Array(await r.arrayBuffer())], [...bytes.subarray(10, 20)]);
  const tail = await fetch(`${base}/api/files/1/data`, { headers: { Range: 'bytes=-5' } });
  assert.deepEqual([...new Uint8Array(await tail.arrayBuffer())], [...bytes.subarray(995)]);
  const bad = await fetch(`${base}/api/files/1/data`, { headers: { Range: 'bytes=5000-6000' } });
  assert.equal(bad.status, 416);
});

test('serves the UI and refuses paths outside it', async () => {
  const index = await fetch(`${base}/`);
  assert.equal(index.status, 200);
  assert.match(await index.text(), /Vidscope/);
  const escape = await fetch(`${base}/..%2f..%2fpackage.json`);
  assert.notEqual(escape.status, 200);
});

test('rejects other Host names (DNS rebinding)', async () => {
  const http = await import('node:http');
  const port = new URL(base).port;
  const status = await new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port, path: '/api/files', headers: { Host: 'evil.example:80' } }, (res) => resolve(res.statusCode));
  });
  assert.equal(status, 403);
});

test('opening paths needs the custom header', async () => {
  const r = await fetch(`${base}/api/open`, { method: 'POST', body: JSON.stringify({ path: dir }) });
  assert.equal(r.status, 403);
});
