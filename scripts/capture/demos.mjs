// Records the README demos: headless Chrome drives the viewer while frames are captured, and
// FFmpeg turns them into GIFs in docs/images/.
//
//   node scripts/capture/demos.mjs [anatomy frames compare audit overview]
//
// The demos with real pictures use the 10-second Big Buck Bunny clips (Blender Foundation,
// CC BY 3.0): Big_Buck_Bunny_1080_10s_5MB.mp4 and its 720 and 360 versions, in $BBB_DIR
// (default ~/projects/sample-videos/mp4). The audit demo uses npm run samples.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { launch, sleep } from './cdp.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(ROOT, 'docs/images');
const BBB = process.env.BBB_DIR ?? path.join(os.homedir(), 'projects/sample-videos/mp4');
const CLIPS = ['1080_10s_5MB', '720_10s_2MB', '360_10s_1MB'].map((s) => path.join(BBB, `Big_Buck_Bunny_${s}.mp4`));
const WIDTH = 1280;
const HEIGHT = 720;
const FPS = 12;

// ------------------------------------------------------------------ the viewer

async function serve(files, port) {
  const proc = spawn(process.execPath, [path.join(ROOT, 'bin/vidscope.js'), ...files, '--port', String(port), '--no-open'], { stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    await sleep(150);
    try {
      if ((await fetch(`http://127.0.0.1:${port}/`)).ok) return proc;
    } catch {
      // not up yet
    }
  }
  proc.kill();
  throw new Error('the viewer did not start');
}

// ------------------------------------------------------------------ pointer, input, recording

const POINTER = `(() => {
  if (document.getElementById('__demo_pointer')) return;
  const d = document.createElement('div');
  d.id = '__demo_pointer';
  d.style.cssText = 'position:fixed;left:0;top:0;width:24px;height:24px;z-index:2147483647;pointer-events:none;transform:translate(-60px,-60px)';
  d.innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24"><path d="M3 2l15 9-6.5 1.6L15 20l-3 1.4-3.6-7.2L3 18z" fill="#fff" stroke="#0b0f14" stroke-width="1.4" stroke-linejoin="round"/></svg><span style="position:absolute;left:-14px;top:-14px;width:28px;height:28px;border-radius:50%;border:2px solid #58a6ff;opacity:0"></span>';
  document.body.appendChild(d);
})()`;

function demoPage(page) {
  let x = WIDTH / 2;
  let y = HEIGHT / 2;
  const place = (px, py) => page.eval(`(() => { const d = document.getElementById('__demo_pointer'); if (d) d.style.transform = 'translate(${px}px, ${py}px)'; })()`);
  const d = {
    async open(url, settle = 2500) {
      await page.goto(url, settle);
      await page.eval(POINTER);
      await place(x, y);
    },
    /** Glide the pointer to a point or to the centre of an element, easing in and out. */
    async move(to, ms = 700) {
      const target = typeof to === 'string' ? await page.center(to) : to;
      const steps = Math.max(2, Math.round((ms / 1000) * 40));
      const [x0, y0] = [x, y];
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
        x = x0 + (target.x - x0) * e;
        y = y0 + (target.y - y0) * e;
        await page.mouse('mouseMoved', x, y);
        await place(x, y);
        await sleep(ms / steps / 2);
      }
    },
    async click(to, ms) {
      if (to) await d.move(to, ms);
      await page.eval(`(() => { const r = document.querySelector('#__demo_pointer span'); r.animate([{ opacity: 0.9, transform: 'scale(0.4)' }, { opacity: 0, transform: 'scale(1.3)' }], { duration: 450 }); })()`);
      await page.mouse('mousePressed', x, y);
      await page.mouse('mouseReleased', x, y);
    },
    /** Scroll the element an expression returns, smoothly. */
    async scroll(element, by, ms = 900) {
      const steps = Math.round((ms / 1000) * 30);
      for (let i = 0; i < steps; i++) {
        await page.eval(`${element}.scrollBy(0, ${by / steps})`);
        await sleep(ms / steps);
      }
    },
    hold: (ms) => sleep(ms),
    eval: (expr) => page.eval(expr),
    until: (expr, ms) => page.until(expr, ms),
  };
  return d;
}

/** Captures frames while `script` runs, then writes docs/images/<name>.gif. */
async function record(page, name, script, { width = 960 } = {}) {
  const frames = [];
  let on = true;
  const loop = (async () => {
    while (on) {
      const t = Date.now();
      frames.push({ t, buf: await page.shot({ format: 'jpeg', quality: 90 }) });
      await sleep(Math.max(0, 1000 / FPS - (Date.now() - t)));
    }
  })();
  try {
    await script();
  } finally {
    on = false;
    await loop;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `vidscope-${name}-`));
  const list = [];
  frames.forEach((f, i) => {
    const file = path.join(dir, `f${String(i).padStart(5, '0')}.jpg`);
    fs.writeFileSync(file, f.buf);
    const next = frames[i + 1]?.t ?? f.t + 1500; // the last frame holds a moment
    list.push(`file '${file}'`, `duration ${((next - f.t) / 1000).toFixed(3)}`);
  });
  list.push(`file '${path.join(dir, `f${String(frames.length - 1).padStart(5, '0')}.jpg`)}'`);
  fs.writeFileSync(path.join(dir, 'list.txt'), `${list.join('\n')}\n`);
  const out = path.join(OUT, `${name}.gif`);
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', path.join(dir, 'list.txt'),
    '-vf', `fps=${FPS},scale=${width}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=160:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`,
    '-loop', '0', out]);
  fs.rmSync(dir, { recursive: true, force: true });
  const mb = fs.statSync(out).size / 1048576;
  console.log(`${path.relative(ROOT, out)}: ${frames.length} frames, ${mb.toFixed(1)} MB`);
  if (mb > 4) console.warn(`  ${name}.gif is over 4 MB: shorten the holds`);
}

// ------------------------------------------------------------------ the demos

/** The scrolling element inside the centre pane's open tab (an expression). */
const SCROLLER = `(() => { const root = document.querySelector('#center .cbody:not([hidden])'); return [root, ...root.querySelectorAll('*')].find((e) => e.scrollHeight > e.clientHeight + 4 && /auto|scroll/.test(getComputedStyle(e).overflowY)) ?? root; })()`;

const DEMOS = {
  // A file's anatomy: the map, the tree, a frame's bytes and what the inspector says about them.
  async anatomy(d, page, base) {
    await d.open(`${base}/?file=1`);
    await record(page, 'demo-anatomy', async () => {
      await d.hold(900);
      await d.click('.card.k-index', 800);
      await d.hold(1300);
      await d.move('.trow.k-track', 600);
      await d.click(null);
      await d.hold(1100);
      await d.click('.crumbs .crumb', 800);
      await d.hold(700);
      await d.click('.card.k-media', 700);
      await d.hold(1100);
      await d.click('.hrow:nth-child(9) .hx .b:nth-child(7)', 900);
      await d.hold(2600);
    });
  },

  // Every frame typed from its own header, grouped into GOPs; values under the pointer.
  async frames(d, page, base) {
    await d.open(`${base}/?file=1`);
    await d.eval(`window.vidscope.store.set({ centerTab: 'frames' })`);
    await d.until(`document.querySelector('.fmain')?.getBoundingClientRect().width > 0`);
    await d.eval(`document.querySelector('.fmain').scrollIntoView({ block: 'center' })`);
    await d.hold(1200);
    await record(page, 'demo-frames', async () => {
      await d.hold(700);
      const box = await d.eval(`(() => { const b = document.querySelector('.fmain').getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; })()`);
      await d.move({ x: box.x + box.w * 0.08, y: box.y + box.h * 0.55 }, 800);
      await d.move({ x: box.x + box.w * 0.55, y: box.y + box.h * 0.6 }, 2600);
      await d.hold(900);
      await d.move({ x: box.x + box.w * 0.92, y: box.y + box.h * 0.5 }, 1600);
      await d.hold(1500);
    });
  },

  // Three conversions of one film, side by side down to the pixel.
  async compare(d, page, base) {
    await d.open(`${base}/?compare=1,2,3`, 4000);
    await d.eval(`[...document.querySelectorAll('#compare button')].find((b) => b.textContent.trim() === 'Decode the pictures').scrollIntoView({ block: 'center' })`);
    await d.hold(400);
    await record(page, 'demo-compare', async () => {
      await d.hold(600);
      await d.click(await d.eval(`(() => { const b = [...document.querySelectorAll('#compare button')].find((e) => e.textContent.trim() === 'Decode the pictures').getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`), 700);
      await d.until(`[...document.querySelectorAll('.pxfull')].length >= 3`, 30000);
      await d.hold(600);
      await d.eval(`document.querySelector('.pxfull').scrollIntoView({ block: 'center', behavior: 'smooth' })`);
      await d.hold(1300);
      const b = await d.eval(`(() => { const r = document.querySelector('.pxfull').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);
      await d.move({ x: b.x + b.w * 0.25, y: b.y + b.h * 0.7 }, 900);
      await d.click(null);
      await d.hold(700);
      await d.move({ x: b.x + b.w * 0.62, y: b.y + b.h * 0.45 }, 2200);
      await d.click(null);
      await d.hold(2200);
    });
  },

  // The Audit tab: the verdict, what to fix, and one finding opened.
  async audit(d, page, base) {
    await d.open(`${base}/?file=1`);
    await d.eval(`window.vidscope.store.set({ centerTab: 'audit' })`);
    await d.until(`!!document.querySelector('.averdict')`, 30000);
    await d.hold(800);
    await record(page, 'demo-audit', async () => {
      await d.hold(1500);
      await d.click('.afix-list .arow summary', 900);
      await d.hold(600);
      await d.scroll(SCROLLER, 190, 1000);
      await d.hold(3200);
      await d.scroll(SCROLLER, 330, 1400);
      await d.hold(1800);
    });
  },
};

// ------------------------------------------------------------------ stills

/** docs/images/overview.webp: the whole viewer with a video frame selected (README, social preview). */
async function overview(chrome, port) {
  const server = await serve([path.join(ROOT, 'samples/h264-aac.mp4')], port);
  const page = await chrome.page({ width: 1440, height: 900, scale: 2, colorScheme: 'dark' });
  try {
    await page.goto(`http://127.0.0.1:${port}/?file=1#0x20b8`, 3500);
    fs.writeFileSync(path.join(OUT, 'overview.webp'), await page.shot({ format: 'webp', quality: 92 }));
    console.log('docs/images/overview.webp');
  } finally {
    await page.close();
    server.kill();
  }
}

// ------------------------------------------------------------------ run

const want = process.argv.slice(2).length ? process.argv.slice(2) : [...Object.keys(DEMOS), 'overview'];
const haveBbb = CLIPS.every((f) => fs.existsSync(f));
const chrome = await launch({ port: 9571 });
let port = 8891;
try {
  for (const name of want) {
    if (name === 'overview') {
      await overview(chrome, port++);
      continue;
    }
    const files = name === 'audit' ? [path.join(ROOT, 'samples/h264-aac.mp4')] : CLIPS;
    if (name !== 'audit' && !haveBbb) {
      console.warn(`${name}: skipped, the Big Buck Bunny clips are not in ${BBB} (set BBB_DIR)`);
      continue;
    }
    const server = await serve(files, port++);
    const page = await chrome.page({ width: WIDTH, height: HEIGHT, colorScheme: 'dark' });
    try {
      await DEMOS[name](demoPage(page), page, `http://127.0.0.1:${port - 1}`);
    } finally {
      await page.close();
      server.kill();
    }
  }
} finally {
  await chrome.close();
}
