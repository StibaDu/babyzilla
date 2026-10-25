// Bring generated art *back* into a pack's grid: key the chroma background,
// scale to the pack's pixel scale, quantise to the pack's own palette, and place
// the result on the same baseline as the frames it has to sit beside.
//
// The point is that a pack has a look — 7 colours, 30x28 pixels, feet on row 45 —
// and anything added later has to obey it exactly or the new frames read as a
// different game.
import fs from "node:fs";

import { decodePng } from "./png.mjs";

/** Palette of a pack: every opaque colour used by its frames, most common first. */
export function packPalette(frames) {
  const counts = new Map();
  for (const img of frames) {
    for (let i = 0; i < img.width * img.height; i++) {
      if (!img.data[i * 4 + 3]) continue;
      const key = (img.data[i * 4] << 16) | (img.data[i * 4 + 1] << 8) | img.data[i * 4 + 2];
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([key]) => ({
    r: (key >> 16) & 255, g: (key >> 8) & 255, b: key & 255,
  }));
}

/** Transparent wherever the pixel is close to the chroma magenta. */
export function keyChroma(img, { tolerance = 90 } = {}) {
  const out = { width: img.width, height: img.height, data: Buffer.from(img.data) };
  for (let i = 0; i < img.width * img.height; i++) {
    const r = out.data[i * 4], g = out.data[i * 4 + 1], b = out.data[i * 4 + 2];
    // magenta-ish: red and blue high, green low
    if (r > 120 && b > 120 && g < r - 60 && g < b - 60) out.data[i * 4 + 3] = 0;
    else if (Math.abs(r - 255) + Math.abs(g) + Math.abs(b - 255) < tolerance) out.data[i * 4 + 3] = 0;
  }
  return out;
}

export function bbox(img) {
  let x0 = img.width, y0 = img.height, x1 = -1, y1 = -1;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      if (!img.data[(y * img.width + x) * 4 + 3]) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/** Area-average downscale: keeps edges from aliasing before quantisation. */
export function resizeArea(img, w, h) {
  const out = { width: w, height: h, data: Buffer.alloc(w * h * 4) };
  const sx = img.width / w, sy = img.height / h;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let yy = Math.floor(y * sy); yy < Math.max(Math.floor(y * sy) + 1, Math.floor((y + 1) * sy)); yy++) {
        for (let xx = Math.floor(x * sx); xx < Math.max(Math.floor(x * sx) + 1, Math.floor((x + 1) * sx)); xx++) {
          if (xx >= img.width || yy >= img.height) continue;
          const i = (yy * img.width + xx) * 4;
          const alpha = img.data[i + 3] / 255;
          r += img.data[i] * alpha; g += img.data[i + 1] * alpha; b += img.data[i + 2] * alpha; a += alpha; n++;
        }
      }
      const i = (y * w + x) * 4;
      if (a > 0.35 && n) {
        out.data[i] = Math.round(r / a); out.data[i + 1] = Math.round(g / a); out.data[i + 2] = Math.round(b / a);
        out.data[i + 3] = 255;
      }
    }
  }
  return out;
}

/** Nearest colour in the pack palette, so new frames cannot introduce a shade. */
export function quantizeTo(img, palette) {
  const out = { width: img.width, height: img.height, data: Buffer.from(img.data) };
  for (let i = 0; i < img.width * img.height; i++) {
    if (!out.data[i * 4 + 3]) continue;
    const r = out.data[i * 4], g = out.data[i * 4 + 1], b = out.data[i * 4 + 2];
    let best = palette[0], bestD = Infinity;
    for (const p of palette) {
      const d = (p.r - r) ** 2 + (p.g - g) ** 2 + (p.b - b) ** 2;
      if (d < bestD) { bestD = d; best = p; }
    }
    out.data[i * 4] = best.r; out.data[i * 4 + 1] = best.g; out.data[i * 4 + 2] = best.b;
  }
  return out;
}

/** Put a character into the pack canvas: same width, feet on the pack's foot row. */
export function placeInCanvas(char, { canvas = 48, footRow = 45, centerX = 24 } = {}) {
  const out = { width: canvas, height: canvas, data: Buffer.alloc(canvas * canvas * 4) };
  const box = bbox(char);
  if (!box) return out;
  const ox = Math.round(centerX - box.w / 2) - box.x;
  const oy = footRow - (box.y + box.h - 1);
  for (let y = 0; y < char.height; y++) {
    for (let x = 0; x < char.width; x++) {
      const s = (y * char.width + x) * 4;
      if (!char.data[s + 3]) continue;
      const dx = x + ox, dy = y + oy;
      if (dx < 0 || dy < 0 || dx >= canvas || dy >= canvas) continue;
      const d = (dy * canvas + dx) * 4;
      for (let k = 0; k < 4; k++) out.data[d + k] = char.data[s + k];
    }
  }
  return out;
}

/**
 * One shot: keyed, cropped, scaled to the pack's character height, quantised and
 * placed. `height` is the character height in pack pixels (30x28 for this pack).
 */
export function toPackFrame(raw, { palette, height = 28, canvas = 48, footRow = 45 }) {
  const keyed = keyChroma(raw);
  const box = bbox(keyed);
  if (!box) throw new Error("nothing left after keying");
  const crop = { width: box.w, height: box.h, data: Buffer.alloc(box.w * box.h * 4) };
  for (let y = 0; y < box.h; y++) {
    for (let x = 0; x < box.w; x++) {
      const s = ((box.y + y) * raw.width + (box.x + x)) * 4;
      const d = (y * crop.width + x) * 4;
      for (let k = 0; k < 4; k++) crop.data[d + k] = keyed.data[s + k];
    }
  }
  const scaled = resizeArea(crop, Math.max(4, Math.round((box.w / box.h) * height)), height);
  const quantised = quantizeTo(scaled, palette);
  return placeInCanvas(quantised, { canvas, footRow });
}

export const load = (file) => decodePng(fs.readFileSync(file));
