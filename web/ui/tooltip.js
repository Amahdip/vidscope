// One shared tooltip. Elements opt in with data-tip="text" or data-num="123" (numbers get
// decimal / hex / size / share-of-file lines).
//
// Hover explanations belong to Guided mode only: elsewhere they would pop up over the work of
// someone who already knows what they are looking at. Outside Guided mode a control (a button,
// a link, a tab) still names itself through the browser's own, delayed title tooltip. Charts
// that show their values under the pointer call showTip themselves and are not affected.

import { fmtInt, hex, humanBytes, pct } from '../core/util.js';

const tip = () => document.getElementById('tooltip');
const DELAY = 350; // ms of hovering before an explanation appears
let fileSize = 0;
let explain = false;

export function setTipFileSize(n) {
  fileSize = n;
}

/** Hover explanations on (Guided mode) or off (Standard, Expert). */
export function setExplainTips(on) {
  explain = !!on;
  if (!explain) hideTip();
}

export function numberLines(n, { size = true } = {}) {
  const lines = [`${fmtInt(n)} (decimal)`, `${hex(n, n > 0xffffffff ? 10 : 8)} (hex)`];
  if (size && n >= 1024) lines.push(humanBytes(n));
  if (size && fileSize && n <= fileSize) lines.push(`${pct(n, fileSize)} of the file`);
  return lines.join('\n');
}

export function showTip(x, y, content) {
  const el = tip();
  if (typeof content === 'string') el.textContent = content;
  else el.replaceChildren(content);
  el.hidden = false;
  const r = el.getBoundingClientRect();
  let left = x + 14;
  let top = y + 16;
  if (left + r.width > window.innerWidth - 8) left = Math.max(8, x - r.width - 14);
  if (top + r.height > window.innerHeight - 8) top = Math.max(8, y - r.height - 12);
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
}

export function hideTip() {
  const el = tip();
  if (el) el.hidden = true;
}

const CONTROL = 'button, a[href], [role="tab"], [role="button"], [role="separator"], select, summary, label';

export function installTips() {
  document.addEventListener('mouseover', (e) => {
    const t = e.target.closest?.('[data-tip], [data-num]');
    if (!t) return;
    if (!explain) {
      // A control keeps its name as a native tooltip; explanations of values and terms wait
      // for Guided mode.
      if (t.dataset.tip && !t.hasAttribute('title') && t.matches(CONTROL)) {
        t.setAttribute('title', t.dataset.tip);
        t.dataset.tipTitle = '1';
      }
      return;
    }
    if (t.dataset.tipTitle) {
      t.removeAttribute('title');
      delete t.dataset.tipTitle;
    }
    const text = t.dataset.tip ?? numberLines(Number(t.dataset.num), { size: t.dataset.size !== '0' });
    let x = e.clientX;
    let y = e.clientY;
    let shown = false;
    const timer = setTimeout(() => {
      if (!explain || !t.isConnected) return; // the mode changed, or the element went, while waiting
      shown = true;
      showTip(x, y, text);
    }, DELAY);
    const move = (ev) => {
      x = ev.clientX;
      y = ev.clientY;
      if (shown) showTip(x, y, text);
    };
    const leave = () => {
      clearTimeout(timer);
      if (shown) hideTip();
      t.removeEventListener('mousemove', move);
      t.removeEventListener('mouseleave', leave);
    };
    t.addEventListener('mousemove', move);
    t.addEventListener('mouseleave', leave);
  });
}
