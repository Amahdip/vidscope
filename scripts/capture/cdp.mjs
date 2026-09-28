// A small Chrome DevTools Protocol driver for the capture scripts: headless Chrome, pages,
// synthetic input, screenshots. No dependencies; Chrome is found at $CHROME or the usual places.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CANDIDATES = [
  process.env.CHROME,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);

export async function launch({ port = 9555 } = {}) {
  const bin = CANDIDATES.find((p) => fs.existsSync(p));
  if (!bin) throw new Error('Chrome not found: set CHROME to its executable');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'vidscope-capture-'));
  const proc = spawn(bin, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run', '--hide-scrollbars', '--force-color-profile=srgb', '--font-render-hinting=none', 'about:blank'], { stdio: 'ignore' });
  for (let i = 0; i < 75; i++) {
    await sleep(200);
    try {
      await fetch(`http://127.0.0.1:${port}/json/version`);
      return {
        port,
        page: (opts) => openPage(port, opts),
        close: async () => {
          const exited = new Promise((r) => proc.once('exit', r));
          proc.kill();
          await Promise.race([exited, sleep(5000)]);
          fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
        },
      };
    } catch {
      // not up yet
    }
  }
  proc.kill();
  throw new Error('Chrome did not start');
}

async function openPage(port, { width = 1280, height = 720, scale = 1, colorScheme = 'dark' } = {}) {
  const t = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0;
  const pending = new Map();
  const listeners = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { r, j } = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) j(new Error(m.error.message));
      else r(m.result);
      return;
    }
    for (const l of listeners) l(m);
  };
  const send = (method, params = {}) => new Promise((r, j) => {
    const i = ++id;
    pending.set(i, { r, j });
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: false });
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: colorScheme }] });
  const page = {
    send,
    async goto(url, settle = 1000) {
      const loaded = new Promise((r) => listeners.push((m) => { if (m.method === 'Page.loadEventFired') r(); }));
      await send('Page.navigate', { url });
      await Promise.race([loaded, sleep(15000)]);
      await sleep(settle);
    },
    async eval(expr) {
      const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
      return r.result.value;
    },
    async until(expr, ms = 20000) {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        if (await page.eval(expr).catch(() => false)) return true;
        await sleep(150);
      }
      throw new Error(`timed out waiting for ${expr}`);
    },
    /** The centre of the first element matching a selector, in CSS pixels. */
    async center(selector) {
      const r = await page.eval(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; e.scrollIntoView({ block: 'nearest' }); const b = e.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);
      if (!r) throw new Error(`no element ${selector}`);
      return r;
    },
    mouse: (type, x, y, extra = {}) => send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: type === 'mouseMoved' ? 0 : 1, ...extra }),
    wheel: (x, y, deltaY) => send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY }),
    key: async (key) => {
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key, text: key.length === 1 ? key : undefined });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key });
    },
    async shot({ format = 'png', quality, clip, transparent = false } = {}) {
      if (transparent) await send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
      const r = await send('Page.captureScreenshot', { format, quality, clip, captureBeyondViewport: !!clip });
      if (transparent) await send('Emulation.setDefaultBackgroundColorOverride', {});
      return Buffer.from(r.data, 'base64');
    },
    close: async () => { try { await send('Page.close'); } catch { /* gone */ } ws.close(); },
  };
  return page;
}
