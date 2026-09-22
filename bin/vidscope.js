#!/usr/bin/env node
// Vidscope local server.
//
// Serves the web UI and random-access byte ranges of the media files named on
// the command line. Everything is parsed in the browser; the server only hands
// out bytes. It binds to 127.0.0.1 and only serves files you listed.

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB_DIR = path.join(ROOT, 'web');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

const MEDIA_EXTS = new Set([
  '.mp4', '.m4v', '.m4a', '.m4b', '.m4s', '.m4p', '.mov', '.qt', '.3gp', '.3g2', '.mj2', '.f4v', '.f4a',
  '.cmfv', '.cmfa', '.cmft', '.heic', '.heif', '.avif', '.ismv', '.isma', '.mp4v', '.dash', '.cr3',
  '.mkv', '.mka', '.mks', '.mk3d', '.webm', '.weba',
  '.ts', '.m2ts', '.mts', '.m2t', '.tsv', '.trp',
  '.avi', '.wav', '.flv',
  // Shown as raw bytes with a best-guess identification until a parser exists.
  '.mpg', '.mpeg', '.vob', '.m2v', '.mpv', '.m1v', '.ps', '.evo', '.wmv', '.wma', '.asf', '.wtv', '.dvr-ms',
  '.ogv', '.ogg', '.oga', '.opus', '.mxf', '.rm', '.rmvb', '.swf', '.dv', '.ivf', '.y4m', '.obu',
  '.h264', '.264', '.avc', '.h265', '.265', '.hevc', '.mjpeg', '.mjpg', '.aac', '.mp3', '.ac3', '.ec3',
  '.flac', '.caf', '.aif', '.aiff',
]);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

const HELP = `Vidscope ${pkg.version} - see the bytes inside video files

Usage
  vidscope [options] <file-or-folder>...

  Folders are scanned for media files (mp4, mov, mkv, webm, ts, avi, flv, ...).
  With no arguments the UI still opens; drop files onto the page to inspect them.

Options
  -p, --port <n>     port to listen on (default 8766; the next free port is used if taken)
      --host <addr>  interface to bind (default 127.0.0.1)
  -r, --recursive    scan folders recursively
      --no-open      don't open a browser window
  -h, --help         show this help
`;

function parseArgs(argv) {
  const opts = { port: 8766, host: '127.0.0.1', open: true, recursive: false, paths: [], help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.indexOf('=');
    const key = a.startsWith('--') && eq > 0 ? a.slice(0, eq) : a;
    const inline = a.startsWith('--') && eq > 0 ? a.slice(eq + 1) : undefined;
    const value = () => {
      if (inline !== undefined) return inline;
      if (i + 1 >= argv.length) throw new Error(`${key} needs a value`);
      return argv[++i];
    };
    switch (key) {
      case '-h': case '--help': opts.help = true; break;
      case '-p': case '--port': opts.port = Number(value()); break;
      case '--host': opts.host = value(); break;
      case '-r': case '--recursive': opts.recursive = true; break;
      case '--open': opts.open = true; break;
      case '--no-open': opts.open = false; break;
      default:
        if (a.startsWith('-') && a !== '-') throw new Error(`Unknown option ${a}`);
        opts.paths.push(a);
    }
  }
  if (!Number.isInteger(opts.port) || opts.port < 0 || opts.port > 65535) throw new Error('Invalid port');
  return opts;
}

function tildify(p) {
  const home = os.homedir();
  return p === home ? '~' : p.startsWith(home + path.sep) ? '~' + p.slice(home.length) : p;
}

async function collectFiles(inputs, recursive) {
  const files = [];
  const seen = new Set();
  const addFile = async (p) => {
    const abs = path.resolve(p);
    if (seen.has(abs)) return;
    const st = await fsp.stat(abs);
    if (!st.isFile()) return;
    seen.add(abs);
    files.push({ path: abs, name: path.basename(abs), size: st.size, mtime: st.mtimeMs });
  };
  const addDir = async (dir) => {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (e) {
      console.warn(`  skipped ${tildify(dir)}: ${e.code || e.message}`);
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (recursive) await addDir(p);
      } else if (e.isFile() && MEDIA_EXTS.has(path.extname(e.name).toLowerCase())) {
        await addFile(p);
      }
    }
  };
  for (const input of inputs) {
    let st;
    try {
      st = await fsp.stat(input);
    } catch {
      console.warn(`  skipped ${input}: not found`);
      continue;
    }
    if (st.isDirectory()) await addDir(path.resolve(input));
    else await addFile(input);
  }
  return files;
}

// A short content hash of the UI, shown in the header so you can tell builds apart.
function buildHash() {
  const h = crypto.createHash('sha1');
  const walk = (dir) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else {
        h.update(path.relative(WEB_DIR, p));
        h.update(fs.readFileSync(p));
      }
    }
  };
  walk(WEB_DIR);
  return h.digest('hex').slice(0, 10);
}

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    'Cache-Control': 'no-store',
  });
  res.end(data);
}

function sendText(res, status, text) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

async function serveFileBytes(req, res, file) {
  let st;
  try {
    st = await fsp.stat(file.path);
  } catch {
    return sendText(res, 404, 'File is gone');
  }
  const size = st.size;
  file.size = size;
  let start = 0;
  let end = size - 1;
  let status = 200;
  const range = req.headers.range;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (!m || (m[1] === '' && m[2] === '')) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` });
      return res.end();
    }
    if (m[1] === '') {
      start = Math.max(0, size - Number(m[2]));
    } else {
      start = Number(m[1]);
      if (m[2] !== '') end = Math.min(Number(m[2]), size - 1);
    }
    if (start >= size || start > end) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` });
      return res.end();
    }
    status = 206;
  }
  const length = size === 0 ? 0 : end - start + 1;
  const headers = {
    'Content-Type': 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    'Content-Length': length,
    'Cache-Control': 'no-store',
  };
  if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  res.writeHead(status, headers);
  if (req.method === 'HEAD' || length === 0) return res.end();
  const stream = fs.createReadStream(file.path, { start, end });
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

async function serveStatic(req, res, pathname) {
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    return sendText(res, 400, 'Bad path');
  }
  if (rel === '/' || rel === '') rel = '/index.html';
  const abs = path.normalize(path.join(WEB_DIR, rel));
  if (abs !== WEB_DIR && !abs.startsWith(WEB_DIR + path.sep)) return sendText(res, 403, 'Forbidden');
  let data;
  try {
    const st = await fsp.stat(abs);
    if (!st.isFile()) return sendText(res, 404, 'Not found');
    data = await fsp.readFile(abs);
  } catch {
    return sendText(res, 404, 'Not found');
  }
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream',
    'Content-Length': data.length,
    'Cache-Control': 'no-cache',
  });
  res.end(req.method === 'HEAD' ? undefined : data);
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('Body too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function fileInfo(f, i) {
  return { id: i + 1, name: f.name, size: f.size, dir: tildify(path.dirname(f.path)), mtime: f.mtime };
}

function createServer(state) {
  return http.createServer(async (req, res) => {
    try {
      // Refuse requests addressed to other host names (DNS-rebinding guard).
      const host = String(req.headers.host || '').toLowerCase();
      const hostname = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
      if (!state.allowedHosts.has(hostname)) return sendText(res, 403, 'Forbidden host');

      const url = new URL(req.url, 'http://localhost');
      const p = url.pathname;

      if (req.method === 'POST' && p === '/api/open') {
        // Add a file or folder by path. The custom header forces a CORS preflight,
        // which this server never approves, so other web pages cannot call it.
        if (req.headers['x-vidscope'] !== '1') return sendText(res, 403, 'Missing header');
        const body = JSON.parse(await readBody(req));
        const target = String(body.path || '').replace(/^~(?=$|\/)/, os.homedir());
        if (!target) return sendJson(res, 400, { error: 'No path given' });
        const before = state.files.length;
        const found = await collectFiles([target], false);
        const known = new Set(state.files.map((f) => f.path));
        for (const f of found) if (!known.has(f.path)) state.files.push(f);
        if (!found.length) return sendJson(res, 404, { error: `No media files at ${target}` });
        const firstNew = state.files.findIndex((f) => f.path === found[0].path);
        return sendJson(res, 200, { added: state.files.length - before, id: firstNew + 1, files: state.files.map(fileInfo) });
      }

      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { Allow: 'GET, HEAD, POST' });
        return res.end();
      }
      if (p === '/api/info') {
        return sendJson(res, 200, { name: 'Vidscope', version: pkg.version, build: state.build, files: state.files.length });
      }
      if (p === '/api/files') return sendJson(res, 200, state.files.map(fileInfo));
      const m = /^\/api\/files\/(\d+)\/data$/.exec(p);
      if (m) {
        const file = state.files[Number(m[1]) - 1];
        if (!file) return sendText(res, 404, 'No such file');
        return serveFileBytes(req, res, file);
      }
      return serveStatic(req, res, p);
    } catch (e) {
      if (!res.headersSent) sendText(res, 500, String(e && e.message || e));
      else res.destroy();
    }
  });
}

function listen(server, host, port, attempts = 25) {
  return new Promise((resolve, reject) => {
    const tryPort = (p, left) => {
      const onError = (err) => {
        server.removeListener('listening', onListening);
        if (err.code === 'EADDRINUSE' && left > 0 && port !== 0) tryPort(p + 1, left - 1);
        else reject(err);
      };
      const onListening = () => {
        server.removeListener('error', onError);
        resolve(server.address().port);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(p, host);
    };
    tryPort(port, attempts);
  });
}

function openBrowser(url) {
  const [cmd, args] = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
      : ['xdg-open', [url]];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  } catch {
    // Opening a browser is a convenience only.
  }
}

function humanBytes(n) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return i === 0 ? `${v} B` : `${v.toFixed(1)} ${units[i]}`;
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`vidscope: ${e.message}\n\n${HELP}`);
    process.exit(2);
  }
  if (opts.help) {
    console.log(HELP);
    return;
  }

  const files = await collectFiles(opts.paths, opts.recursive);
  const state = {
    files,
    build: buildHash(),
    allowedHosts: new Set(['127.0.0.1', 'localhost', '::1', opts.host.toLowerCase()]),
  };
  const server = createServer(state);
  const port = await listen(server, opts.host, opts.port);
  const shownHost = opts.host.includes(':') ? `[${opts.host}]` : opts.host;
  const url = `http://${shownHost}:${port}/`;

  console.log(`Vidscope ${pkg.version} (build ${state.build})`);
  console.log(`  ${url}`);
  if (files.length) {
    console.log(`  ${files.length} file${files.length === 1 ? '' : 's'}:`);
    const w = String(files.length).length;
    const nameW = Math.min(40, Math.max(...files.map((f) => f.name.length)));
    let dir = null;
    for (const [i, f] of files.entries()) {
      const d = path.dirname(f.path);
      if (d !== dir) {
        dir = d;
        console.log(`    ${tildify(d)}`);
      }
      console.log(`      ${String(i + 1).padStart(w)}  ${f.name.padEnd(nameW)}  ${humanBytes(f.size)}`);
    }
  } else {
    console.log('  no files given - drop files onto the page, or run: vidscope <file-or-folder>');
  }
  console.log('  Ctrl+C to stop');
  if (opts.open) openBrowser(url);
}

main().catch((e) => {
  console.error(`vidscope: ${e.message}`);
  process.exit(1);
});
