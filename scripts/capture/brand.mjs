// Renders the logo lock-ups and the social preview from docs/brand/mark.svg:
//   docs/brand/logo-dark.png   for dark backgrounds (light wordmark)
//   docs/brand/logo-light.png  for light backgrounds (dark wordmark)
//   docs/brand/social-preview.png  1280×640, for the repository's social preview
//
//   node scripts/capture/brand.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from './cdp.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(ROOT, 'docs/brand');
const mark = fs.readFileSync(path.join(OUT, 'mark.svg'), 'utf8');
const overview = `data:image/webp;base64,${fs.readFileSync(path.join(ROOT, 'docs/images/overview.webp')).toString('base64')}`;
const FONT = '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@500;700;800&family=IBM+Plex+Sans:wght@400;500&display=swap">';

const lockup = (ink, accent) => `<!doctype html><meta charset="utf-8">${FONT}
<style>html,body{margin:0;background:transparent}
.l{display:inline-flex;align-items:center;gap:26px;padding:8px}
.l svg{width:112px;height:112px;display:block}
.w{font:800 92px/1 'JetBrains Mono',ui-monospace,monospace;letter-spacing:-0.035em;color:${ink}}
.w span{color:${accent}}</style>
<div class="l" id="l">${mark}<div class="w">vid<span>scope</span></div></div>`;

const social = `<!doctype html><meta charset="utf-8">${FONT}
<style>html,body{margin:0;width:1280px;height:640px;background:#0b0f14;overflow:hidden}
.bg{position:absolute;inset:0;background:radial-gradient(900px 500px at 85% 20%,rgba(88,166,255,.16),transparent 60%),radial-gradient(700px 400px at 10% 100%,rgba(94,224,160,.10),transparent 60%)}
.copy{position:absolute;left:84px;top:96px;width:520px}
.brand{display:flex;align-items:center;gap:18px}
.brand svg{width:72px;height:72px}
.brand b{font:800 58px/1 'JetBrains Mono',monospace;letter-spacing:-0.035em;color:#e6edf3}
.brand b span{color:#58a6ff}
h1{margin:44px 0 0;text-wrap:balance;font:500 44px/1.15 'IBM Plex Sans',system-ui,sans-serif;color:#e6edf3;letter-spacing:-0.01em}
p{margin:22px 0 0;font:400 22px/1.45 'IBM Plex Sans',system-ui,sans-serif;color:#9aa7b4}
.tags{margin-top:34px;display:flex;flex-wrap:wrap;gap:10px}
.tags i{font:500 17px/1 'JetBrains Mono',monospace;font-style:normal;color:#c9d4df;border:1px solid #2a3542;border-radius:7px;padding:9px 12px;background:#10161e}
.shot{position:absolute;left:660px;top:92px;width:760px;border-radius:14px;border:1px solid #2a3542;box-shadow:0 30px 80px rgba(0,0,0,.55)}</style>
<div class="bg"></div>
<img class="shot" src="${overview}">
<div class="copy">
  <div class="brand">${mark}<b>vid<span>scope</span></b></div>
  <h1>See the bytes inside video files</h1>
  <p>Every box, frame and NAL unit, explained. Audits against HLS, H.264 and EBU R 128. In the browser; nothing is uploaded.</p>
  <div class="tags"><i>MP4</i><i>MKV/WebM</i><i>MPEG-TS</i><i>AVI</i><i>FLV</i></div>
</div>`;

const chrome = await launch();
try {
  for (const [name, ink, accent] of [['logo-dark', '#e6edf3', '#58a6ff'], ['logo-light', '#0b0f14', '#1f6fd6']]) {
    const p = await chrome.page({ width: 900, height: 200, scale: 2 });
    await p.goto(`data:text/html;base64,${Buffer.from(lockup(ink, accent)).toString('base64')}`, 1500);
    const box = await p.eval(`(() => { const b = document.getElementById('l').getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height, scale: 1 }; })()`);
    fs.writeFileSync(path.join(OUT, `${name}.png`), await p.shot({ clip: box, transparent: true }));
    await p.close();
  }
  const p = await chrome.page({ width: 1280, height: 640, scale: 1 });
  await p.goto(`data:text/html;base64,${Buffer.from(social).toString('base64')}`, 2000);
  fs.writeFileSync(path.join(OUT, 'social-preview.png'), await p.shot());
  await p.close();
  console.log('wrote docs/brand/logo-dark.png, logo-light.png, social-preview.png');
} finally {
  await chrome.close();
}
