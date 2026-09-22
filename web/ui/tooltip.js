// One shared tooltip. Elements opt in with data-tip="text" or data-num="123" (numbers get
// decimal / hex / size / share-of-file lines).

import { fmtInt, hex, humanBytes, pct } from '../core/util.js';

const tip = () => document.getElementById('tooltip');
let fileSize = 0;

export function setTipFileSize(n) {
  fileSize = n;
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

export function installTips() {
  document.addEventListener('mouseover', (e) => {
    const t = e.target.closest?.('[data-tip], [data-num]');
    if (!t) return;
    const text = t.dataset.tip ?? numberLines(Number(t.dataset.num), { size: t.dataset.size !== '0' });
    showTip(e.clientX, e.clientY, text);
    const move = (ev) => showTip(ev.clientX, ev.clientY, text);
    const leave = () => {
      hideTip();
      t.removeEventListener('mousemove', move);
      t.removeEventListener('mouseleave', leave);
    };
    t.addEventListener('mousemove', move);
    t.addEventListener('mouseleave', leave);
  });
}
