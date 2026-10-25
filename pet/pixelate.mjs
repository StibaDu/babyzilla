// Turn a generated 1024² illustration into a 64² 16-colour sprite:
// chroma-key the magenta background, box-downscale, quantise, align on a
// shared baseline. Everything is pure JS over an RGBA buffer (see png.mjs).
import { PALETTE, INK, nearest } from "./palette.mjs";

const dist2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;

function sample(img, x, y) {
  const i = (y * img.width + x) * 4;
  return [img.data[i], img.data[i + 1], img.data[i + 2], img.data[i + 3]];
}

/** Estimate the background colour from the four corners (median-ish). */
export function backgroundColor(img) {
  const pts = [];
  const r = 6;
  for (const [cx, cy] of [[0, 0], [img.width - 1, 0], [0, img.height - 1], [img.width - 1, img.height - 1]]) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const x = Math.min(img.width - 1, Math.max(0, cx + dx));
        const y = Math.min(img.height - 1, Math.max(0, cy + dy));
        const p = sample(img, x, y);
        pts.push(p);
      }
    }
  }
  const median = (k) => pts.map((p) => p[k]).sort((a, b) => a - b)[pts.length >> 1];
  return [median(0), median(1), median(2)];
}

const isMagenta = (p) => p[0] > 170 && p[2] > 170 && p[1] < 130 && p[0] - p[1] > 60 && p[2] - p[1] > 60;

/**
 * Flood fill from the border. Only pixels connected to the frame edge become
 * transparent, so magenta-ish details inside the character survive.
 */
export function keyBackground(img, { tolerance = 90 } = {}) {
  const { width: w, height: h, data } = img;
  const bg = backgroundColor(img);
  const tol2 = tolerance * tolerance;
  const seen = new Uint8Array(w * h);
  const stack = [];
  const push = (x, y) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const idx = y * w + x;
    if (seen[idx]) return;
    seen[idx] = 1;
    const i = idx * 4;
    const p = [data[i], data[i + 1], data[i + 2]];
    if (dist2(p, bg) <= tol2 || isMagenta(p)) {
      data[i + 3] = 0;
      stack.push(x, y);
    }
  };
  for (let x = 0; x < w; x++) { push(x, 0); push(x, h - 1); }
  for (let y = 0; y < h; y++) { push(0, y); push(w - 1, y); }
  while (stack.length) {
    const y = stack.pop();
    const x = stack.pop();
    push(x + 1, y); push(x - 1, y); push(x, y + 1); push(x, y - 1);
  }
  // Kill the 1px fringe: pixels that are still nearly background and touch it.
  const fringe = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (data[i + 3] === 0) continue;
      let touches = false;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        if (data[(ny * w + nx) * 4 + 3] === 0) { touches = true; break; }
      }
      if (!touches) continue;
      const p = [data[i], data[i + 1], data[i + 2]];
      if (dist2(p, bg) <= tol2 * 2.4 || isMagenta(p)) fringe.push(i);
    }
  }
  for (const i of fringe) data[i + 3] = 0;
  return img;
}

export function bbox(img) {
  let x0 = img.width, y0 = img.height, x1 = -1, y1 = -1;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      if (img.data[(y * img.width + x) * 4 + 3] > 8) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return null;
  return { x0, y0, x1, y1, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

export function crop(img, box) {
  const out = { width: box.w, height: box.h, data: Buffer.alloc(box.w * box.h * 4) };
  for (let y = 0; y < box.h; y++) {
    for (let x = 0; x < box.w; x++) {
      const s = ((box.y0 + y) * img.width + (box.x0 + x)) * 4;
      const d = (y * box.w + x) * 4;
      out.data[d] = img.data[s];
      out.data[d + 1] = img.data[s + 1];
      out.data[d + 2] = img.data[s + 2];
      out.data[d + 3] = img.data[s + 3];
    }
  }
  return out;
}

/** Area-average downscale in premultiplied space (box filter). */
export function resizeBox(img, tw, th) {
  const out = { width: tw, height: th, data: Buffer.alloc(tw * th * 4) };
  const sx = img.width / tw;
  const sy = img.height / th;
  for (let y = 0; y < th; y++) {
    const y0 = Math.floor(y * sy);
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
    for (let x = 0; x < tw; x++) {
      const x0 = Math.floor(x * sx);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const i = (yy * img.width + xx) * 4;
          const al = img.data[i + 3] / 255;
          r += img.data[i] * al;
          g += img.data[i + 1] * al;
          b += img.data[i + 2] * al;
          a += al;
          n++;
        }
      }
      const d = (y * tw + x) * 4;
      if (a > 0) {
        out.data[d] = Math.round(r / a);
        out.data[d + 1] = Math.round(g / a);
        out.data[d + 2] = Math.round(b / a);
      }
      out.data[d + 3] = Math.round((a / n) * 255);
    }
  }
  return out;
}

/** Hard alpha + map every pixel to the locked palette. */
export function quantize(img, { alphaCut = 110 } = {}) {
  const out = { width: img.width, height: img.height, data: Buffer.alloc(img.data.length) };
  for (let i = 0; i < img.data.length; i += 4) {
    if (img.data[i + 3] < alphaCut) continue; // stays fully transparent
    const { color } = nearest(img.data[i], img.data[i + 1], img.data[i + 2]);
    out.data[i] = color.rgb[0];
    out.data[i + 1] = color.rgb[1];
    out.data[i + 2] = color.rgb[2];
    out.data[i + 3] = 255;
  }
  return out;
}

/** 1px ink outline drawn outside the silhouette (keeps sprites readable). */
export function outline(img, color = INK) {
  const { width: w, height: h } = img;
  const out = { width: w, height: h, data: Buffer.from(img.data) };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (img.data[i + 3]) continue;
      let near = false;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        if (img.data[(ny * w + nx) * 4 + 3]) { near = true; break; }
      }
      if (!near) continue;
      out.data[i] = color[0];
      out.data[i + 1] = color[1];
      out.data[i + 2] = color[2];
      out.data[i + 3] = 255;
    }
  }
  return out;
}

/**
 * Fit into `size`, then land it on a fixed baseline: bottom-centre at
 * (size/2, size-bottomMargin). A stable baseline is what stops the pet from
 * jittering between expressions.
 */
export function place(img, size = 64, { bottomMargin = 2, maxExtent = 58 } = {}) {
  const scale = Math.min(maxExtent / img.width, maxExtent / img.height, 1);
  let sprite = img;
  if (scale < 1) {
    const tw = Math.max(1, Math.round(img.width * scale));
    const th = Math.max(1, Math.round(img.height * scale));
    sprite = quantize(resizeBox(img, tw, th));
  }
  const out = { width: size, height: size, data: Buffer.alloc(size * size * 4) };
  const ox = Math.round((size - sprite.width) / 2);
  const oy = size - bottomMargin - sprite.height;
  for (let y = 0; y < sprite.height; y++) {
    for (let x = 0; x < sprite.width; x++) {
      const ty = oy + y;
      const tx = ox + x;
      if (tx < 0 || ty < 0 || tx >= size || ty >= size) continue;
      const s = (y * sprite.width + x) * 4;
      if (!sprite.data[s + 3]) continue;
      const d = (ty * size + tx) * 4;
      out.data[d] = sprite.data[s];
      out.data[d + 1] = sprite.data[s + 1];
      out.data[d + 2] = sprite.data[s + 2];
      out.data[d + 3] = 255;
    }
  }
  return out;
}

/**
 * Keep the character, drop detached debris. Flux sometimes paints a ground
 * shadow that survives the chroma key as a red patch under the feet; it is not
 * connected to the body, so labelling components removes it without touching
 * the sprite (or a flame that is close enough in size).
 */
export function keepMainComponents(img, { minShare = 0.05, minArea = 6 } = {}) {
  const { width: w, height: h, data } = img;
  const label = new Int32Array(w * h).fill(-1);
  const areas = [];
  const stack = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      if (label[idx] !== -1 || !data[idx * 4 + 3]) continue;
      const id = areas.length;
      let area = 0;
      stack.push(idx);
      label[idx] = id;
      while (stack.length) {
        const cur = stack.pop();
        area++;
        const cx = cur % w;
        const cy = (cur - cx) / w;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = cx + dx, ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const ni = ny * w + nx;
          if (label[ni] !== -1 || !data[ni * 4 + 3]) continue;
          label[ni] = id;
          stack.push(ni);
        }
      }
      areas.push(area);
    }
  }
  if (areas.length <= 1) return img;
  const largest = Math.max(...areas);
  const keep = new Set();
  areas.forEach((area, id) => {
    if (area === largest || area >= Math.max(minArea, largest * minShare)) keep.add(id);
  });
  const out = { width: w, height: h, data: Buffer.from(data) };
  for (let i = 0; i < label.length; i++) {
    if (label[i] !== -1 && !keep.has(label[i])) out.data[i * 4 + 3] = 0;
  }
  return out;
}

/**
 * Ground shadow removal. Flux often paints a soft contact shadow; the chroma key
 * cannot see it (it is a dark red blend, not background) and it touches the feet,
 * so component cleanup keeps it. It is always the mouth/blush red family sitting
 * in the bottom band, where a mouth can never legitimately be.
 */
export function dropGroundShadow(img, { fromY = img.height - 14, colors = ["mouth", "blush"] } = {}) {
  const hexes = new Set(PALETTE.filter((p) => colors.includes(p.name)).map((p) => p.hex.toLowerCase()));
  const out = { width: img.width, height: img.height, data: Buffer.from(img.data) };
  for (let y = Math.max(0, fromY); y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const i = (y * img.width + x) * 4;
      if (!out.data[i + 3]) continue;
      const hex = "#" + [out.data[i], out.data[i + 1], out.data[i + 2]].map((v) => v.toString(16).padStart(2, "0")).join("");
      if (hexes.has(hex)) out.data[i + 3] = 0;
    }
  }
  return out;
}

export function analyze(img) {
  const colors = new Set();
  let opaque = 0;
  for (let i = 0; i < img.data.length; i += 4) {
    if (!img.data[i + 3]) continue;
    opaque++;
    colors.add(`${img.data[i]},${img.data[i + 1]},${img.data[i + 2]}`);
  }
  const box = bbox(img);
  let borderClean = true;
  const edge = (x, y) => img.data[(y * img.width + x) * 4 + 3];
  for (let x = 0; x < img.width; x++) if (edge(x, 0) || edge(x, img.height - 1)) borderClean = false;
  for (let y = 0; y < img.height; y++) if (edge(0, y) || edge(img.width - 1, y)) borderClean = false;
  return {
    colors: colors.size,
    opaquePct: Math.round((opaque / (img.width * img.height)) * 1000) / 10,
    bbox: box,
    borderClean,
  };
}

/** Whole pipeline for one generated image. */
export function pixelate(img, { size = 64, tolerance = 90, outline: ink = false } = {}) {
  const keyed = keyBackground(img, { tolerance });
  const box = bbox(keyed);
  if (!box) throw new Error("empty sprite after background removal");
  const cleaned = keepMainComponents(crop(keyed, box));
  const cropBox = bbox(cleaned);
  if (!cropBox) throw new Error("sprite empty after component cleanup");
  const cropped = crop(cleaned, cropBox);
  const tall = Math.max(cropped.width, cropped.height);
  const target = Math.min(128, Math.max(size, Math.round((size * 1.6))));
  const scale = target / tall;
  const small = resizeBox(cropped, Math.max(1, Math.round(cropped.width * scale)), Math.max(1, Math.round(cropped.height * scale)));
  let flat = quantize(small);
  if (ink) flat = outline(flat);
  const placed = dropGroundShadow(place(flat, size), { fromY: size - 14 });
  // dropping the shadow can leave a detached dark rim: remove small debris
  const final = keepMainComponents(placed, { minShare: 0.03, minArea: 4 });
  return { img: final, stats: analyze(final) };
}

export const PALETTE_SIZE = PALETTE.length;
