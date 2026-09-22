// Comparing decoded pictures pixel by pixel, for the Compare view's pixel microscope: luma (Y)
// planes, scaling one plane to another's size, PSNR and SSIM computed the way FFmpeg's psnr and
// ssim filters compute them, and a picture of the differences.
//
// A luma plane is { w, h, y: Uint8Array(w * h) }: 8-bit samples, row after row.

/** A luma plane from RGBA pixels (canvas ImageData), with the BT.709 weights, in video range. */
export function lumaFromRGBA(data, w, h) {
  const y = new Uint8Array(w * h);
  for (let i = 0, p = 0; i < y.length; i++, p += 4) {
    // Full-range RGB to limited-range Y (16-235), the range decoded video uses.
    y[i] = Math.round(16 + (219 / 255) * (0.2126 * data[p] + 0.7152 * data[p + 1] + 0.0722 * data[p + 2]));
  }
  return { w, h, y };
}

/**
 * Resize a luma plane to w × h: bilinear when enlarging, with pixel centres aligned (what FFmpeg's
 * scale=...:flags=bilinear gives), and area averaging when shrinking, so that fine detail is
 * averaged instead of skipped.
 */
export function resizeLuma(src, w, h) {
  if (src.w === w && src.h === h) return src;
  if (w < src.w && h < src.h) return shrinkLuma(src, w, h);
  const out = new Uint8Array(w * h);
  const sx = src.w / w;
  const sy = src.h / h;
  const xs0 = new Int32Array(w);
  const xs1 = new Int32Array(w);
  const fx = new Float32Array(w);
  for (let x = 0; x < w; x++) {
    const p = Math.max(0, Math.min(src.w - 1, (x + 0.5) * sx - 0.5));
    xs0[x] = Math.floor(p);
    xs1[x] = Math.min(src.w - 1, xs0[x] + 1);
    fx[x] = p - xs0[x];
  }
  const s = src.y;
  for (let yy = 0; yy < h; yy++) {
    const p = Math.max(0, Math.min(src.h - 1, (yy + 0.5) * sy - 0.5));
    const y0 = Math.floor(p);
    const y1 = Math.min(src.h - 1, y0 + 1);
    const fy = p - y0;
    const r0 = y0 * src.w;
    const r1 = y1 * src.w;
    const o = yy * w;
    for (let x = 0; x < w; x++) {
      const a = s[r0 + xs0[x]] + (s[r0 + xs1[x]] - s[r0 + xs0[x]]) * fx[x];
      const b = s[r1 + xs0[x]] + (s[r1 + xs1[x]] - s[r1 + xs0[x]]) * fx[x];
      out[o + x] = Math.round(a + (b - a) * fy);
    }
  }
  return { w, h, y: out };
}

/** Area-average a luma plane down to w × h: each output pixel is the mean of what it covers. */
function shrinkLuma(src, w, h) {
  const out = new Uint8Array(w * h);
  const sx = src.w / w;
  const sy = src.h / h;
  for (let y = 0; y < h; y++) {
    const y0 = y * sy;
    const y1 = y0 + sy;
    for (let x = 0; x < w; x++) {
      const x0 = x * sx;
      const x1 = x0 + sx;
      let sum = 0;
      let area = 0;
      for (let yy = Math.floor(y0); yy < Math.ceil(y1) && yy < src.h; yy++) {
        const fy = Math.min(yy + 1, y1) - Math.max(yy, y0);
        const row = yy * src.w;
        for (let xx = Math.floor(x0); xx < Math.ceil(x1) && xx < src.w; xx++) {
          const f = fy * (Math.min(xx + 1, x1) - Math.max(xx, x0));
          sum += src.y[row + xx] * f;
          area += f;
        }
      }
      out[y * w + x] = Math.round(sum / area);
    }
  }
  return { w, h, y: out };
}

/** Mean squared error between two planes of the same size. */
export function mse(a, b) {
  const n = a.y.length;
  let se = 0;
  for (let i = 0; i < n; i++) {
    const d = a.y[i] - b.y[i];
    se += d * d;
  }
  return se / n;
}

/** PSNR of b against a in dB, as FFmpeg's psnr filter reports psnr_y (Infinity when identical). */
export function psnr(a, b) {
  const m = mse(a, b);
  return m === 0 ? Infinity : 10 * Math.log10((255 * 255) / m);
}

/**
 * SSIM of b against a, as FFmpeg's ssim filter reports Y (the x264 algorithm): 8×8 windows every
 * 4 pixels, each from four 4×4 blocks, averaged. 1 means identical.
 */
export function ssim(a, b) {
  const W = a.w >> 2;
  const H = a.h >> 2;
  if (W < 2 || H < 2) return null;
  const C1 = Math.floor(0.01 * 0.01 * 255 * 255 * 64 + 0.5);
  const C2 = Math.floor(0.03 * 0.03 * 255 * 255 * 64 * 63 + 0.5);
  // Sums over each 4×4 block of one row of blocks: s1, s2, ss (a² + b²), s12.
  const rowSums = (by) => {
    const r = new Float64Array(W * 4);
    for (let bx = 0; bx < W; bx++) {
      let s1 = 0;
      let s2 = 0;
      let ss = 0;
      let s12 = 0;
      for (let dy = 0; dy < 4; dy++) {
        const o = (by * 4 + dy) * a.w + bx * 4;
        for (let dx = 0; dx < 4; dx++) {
          const p = a.y[o + dx];
          const q = b.y[o + dx];
          s1 += p;
          s2 += q;
          ss += p * p + q * q;
          s12 += p * q;
        }
      }
      r[bx * 4] = s1;
      r[bx * 4 + 1] = s2;
      r[bx * 4 + 2] = ss;
      r[bx * 4 + 3] = s12;
    }
    return r;
  };
  let total = 0;
  let prev = rowSums(0);
  for (let by = 1; by < H; by++) {
    const cur = rowSums(by);
    for (let bx = 0; bx < W - 1; bx++) {
      const k = bx * 4;
      const s1 = prev[k] + prev[k + 4] + cur[k] + cur[k + 4];
      const s2 = prev[k + 1] + prev[k + 5] + cur[k + 1] + cur[k + 5];
      const ss = prev[k + 2] + prev[k + 6] + cur[k + 2] + cur[k + 6];
      const s12 = prev[k + 3] + prev[k + 7] + cur[k + 3] + cur[k + 7];
      const vars = ss * 64 - s1 * s1 - s2 * s2;
      const covar = s12 * 64 - s1 * s2;
      total += ((2 * s1 * s2 + C1) * (2 * covar + C2)) / ((s1 * s1 + s2 * s2 + C1) * (vars + C2));
    }
    prev = cur;
  }
  return total / ((W - 1) * (H - 1));
}

/**
 * The absolute difference of two planes of the same size as RGBA pixels for a canvas: black where
 * they agree, brighter where they differ (the difference is multiplied by `gain` so that small
 * errors show). Also returns the largest difference and the share of pixels that differ by more
 * than 8 levels.
 */
export function diffImage(a, b, gain = 4) {
  const n = a.y.length;
  const rgba = new Uint8ClampedArray(n * 4);
  let max = 0;
  let big = 0;
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const d = Math.abs(a.y[i] - b.y[i]);
    if (d > max) max = d;
    if (d > 8) big++;
    const v = Math.min(255, d * gain);
    rgba[p] = v;
    rgba[p + 1] = v;
    rgba[p + 2] = v;
    rgba[p + 3] = 255;
  }
  return { rgba, w: a.w, h: a.h, max, bigShare: big / n };
}

/** Whether two picture sizes have the same shape (so that one can be scaled onto the other). */
export function sameAspect(w1, h1, w2, h2) {
  return Math.abs(w1 / h1 - w2 / h2) / (w1 / h1) < 0.01;
}

/**
 * Compare picture b (a version) with picture a (the reference): scale b's luma to a's size when
 * they differ, then PSNR, SSIM and the difference picture. null when their shapes differ.
 */
export function comparePictures(a, b) {
  if (!a?.luma || !b?.luma) return null;
  if (!sameAspect(a.luma.w, a.luma.h, b.luma.w, b.luma.h)) return { error: 'different picture shapes' };
  const scaled = resizeLuma(b.luma, a.luma.w, a.luma.h);
  return {
    psnr: psnr(a.luma, scaled),
    ssim: ssim(a.luma, scaled),
    scaled: scaled === b.luma ? false : b.luma.w < a.luma.w ? 'up' : 'down',
    diff: () => diffImage(a.luma, scaled),
  };
}
