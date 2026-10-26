// Build a pet *pack* from a third-party sprite sheet.
//
// A pack is a different look for the same pet: the app keeps its reactions,
// bubbles and event bridge, and only swaps the art. Packs declare their own
// animations (idle / walk / jump) instead of a sprite per expression, which is
// what a hand-drawn sheet can actually provide.
//
//   node pet/pack.mjs --sheet ~/Downloads/pack.png --name lil-dino \
//     --label "Lil Dino" --cell 32 --crop 4,0,24,24 \
//     --rows idle,walk,jump --cols 6 --upscale 2
//
// Frames are copied cell-relative (never re-aligned), so a jump that rises in
// the sheet still rises in the app.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { decodePng, encodePng } from "./png.mjs";
import { tool } from "../lib/tool.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

const args = process.argv.slice(2);
const arg = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = args[i + 1];
  return v && !v.startsWith("--") ? v : true;
};

const sheetPath = arg("sheet");
if (!sheetPath) {
  console.error("usage: node pet/pack.mjs --sheet <png|webp> --name <id> --label <name> --cell 32 --crop x,y,w,h --rows idle,walk,jump [--cols 6] [--upscale 2 | --resize 112] [--voice <id>] [--fps walk:12,idle:6]");
  process.exit(2);
}

const name = String(arg("name") ?? "pack");
const label = String(arg("label") ?? name);
// A cell is not always square: 192x208 atlases (OpenPet/Codex style) are taller
// than they are wide, and forcing a square cell silently reads the wrong grid.
const cellSpec = String(arg("cell", 32)).toLowerCase().split("x");
const cellW = Number(cellSpec[0]);
const cellH = Number(cellSpec[1] ?? cellSpec[0]);
const cols = Number(arg("cols", 6));
const upscale = Number(arg("upscale", 2));
// `--resize N` is for sheets drawn at 2-3x: it box-filters down to an NxN frame
// (letterboxed, so the character is never stretched) instead of nearest-upscaling.
const resize = Number(arg("resize", 0)) || 0;
const rows = String(arg("rows", "idle")).split(",").map((r) => r.trim()).filter(Boolean);
const [cx, cy, cw, ch] = String(arg("crop", `0,0,${cellW},${cellH}`)).split(",").map(Number);
const outDir = path.resolve(ROOT, String(arg("out", `assets/pet/packs/${name}`)));

const sheet = loadSheet(String(sheetPath).replace(/^~/, process.env.HOME));
const gridCols = Math.max(1, Math.min(cols, Math.floor(sheet.width / cellW)));
const gridRows = Math.floor(sheet.height / cellH);

if (rows.length > gridRows) {
  console.error(`sheet has ${gridRows} rows of ${cellW}x${cellH}px, but ${rows.length} animations were named`);
  process.exit(1);
}

/** PNG in, PNG out — anything else is converted with macOS `sips` first. */
function loadSheet(file) {
  if (/\.png$/i.test(file)) return decodePng(fs.readFileSync(file));
  const tmp = path.join(os.tmpdir(), `bz-pack-${process.pid}.png`);
  try {
    execFileSync(tool("sips"), ["-s", "format", "png", file, "--out", tmp], { stdio: "ignore" });
  } catch {
    console.error(`cannot read ${file}: pass a PNG, or install macOS sips for webp sheets`);
    process.exit(1);
  }
  const img = decodePng(fs.readFileSync(tmp));
  fs.rmSync(tmp, { force: true });
  return img;
}

/**
 * Box-filter down to a square frame of `size`, preserving aspect and centring the
 * character. Averaging is alpha-weighted, so a transparent margin does not bleed
 * black into the edges of the art.
 */
function resizeSquare(img, size) {
  const scale = Math.min(size / img.width, size / img.height);
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const out = Buffer.alloc(size * size * 4);
  const xoff = Math.floor((size - w) / 2);
  const yoff = Math.floor((size - h) / 2);
  for (let y = 0; y < h; y++) {
    const sy0 = Math.floor((y * img.height) / h);
    const sy1 = Math.max(sy0 + 1, Math.floor(((y + 1) * img.height) / h));
    for (let x = 0; x < w; x++) {
      const sx0 = Math.floor((x * img.width) / w);
      const sx1 = Math.max(sx0 + 1, Math.floor(((x + 1) * img.width) / w));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        for (let sx = sx0; sx < sx1; sx++) {
          const i = (sy * img.width + sx) * 4;
          const al = img.data[i + 3] / 255;
          r += img.data[i] * al;
          g += img.data[i + 1] * al;
          b += img.data[i + 2] * al;
          a += al;
          n++;
        }
      }
      const d = ((y + yoff) * size + (x + xoff)) * 4;
      out[d] = a ? Math.round(r / a) : 0;
      out[d + 1] = a ? Math.round(g / a) : 0;
      out[d + 2] = a ? Math.round(b / a) : 0;
      out[d + 3] = Math.round((a / n) * 255);
    }
  }
  return { width: size, height: size, data: out };
}

fs.mkdirSync(path.join(outDir, "sprites"), { recursive: true });

/** Copy one cell region, scaled by nearest neighbour so pixels stay square. */
function cropCell(row, col) {
  const w = cw * upscale, h = ch * upscale;
  const data = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const sx = col * cellW + cx + Math.floor(x / upscale);
      const sy = row * cellH + cy + Math.floor(y / upscale);
      if (sx < 0 || sy < 0 || sx >= sheet.width || sy >= sheet.height) continue;
      const s = (sy * sheet.width + sx) * 4;
      const d = (y * w + x) * 4;
      for (let k = 0; k < 4; k++) data[d + k] = sheet.data[s + k];
    }
  }
  return { width: w, height: h, data };
}

const animations = {};
for (let r = 0; r < rows.length; r++) {
  const anim = rows[r];
  const frames = [];
  for (let c = 0; c < gridCols; c++) {
    let img = cropCell(r, c);
    let opaque = 0;
    for (let i = 3; i < img.data.length; i += 4) if (img.data[i]) opaque++;
    if (opaque === 0) continue;
    if (resize > 0) img = resizeSquare(img, resize);
    const id = `${anim}-${frames.length + 1}`;
    fs.writeFileSync(path.join(outDir, "sprites", `${id}.png`), encodePng(img.width, img.height, img.data));
    frames.push(id);
  }
  animations[anim] = frames;
}

const pack = {
  kind: "pack",
  name,
  label,
  size: resize > 0 ? resize : Math.max(cw, ch) * upscale,
  // file name only: a pack ships without leaking the builder's directory layout
  source: path.basename(String(sheetPath)),
  // the pack author keeps their art rights; this records where it came from
  license: arg("license") && arg("license") !== true ? String(arg("license")) : "unknown",
  // Which personality the pet speaks with (lib/pet-voice.mjs). A pack that omits
  // it speaks plainly: its art is not ours, so neither are the dino's opinions.
  ...(arg("voice") && arg("voice") !== true ? { voice: String(arg("voice")) } : {}),
  animations,
  // The sheet's idle is a slow breath and its walk is a six-beat stride.
  fps: {
    idle: Number(arg("idle-fps", 6)),
    walk: Number(arg("walk-fps", 12)),
    jump: Number(arg("jump-fps", 12)),
    ...(arg("fps") && arg("fps") !== true
      ? Object.fromEntries(String(arg("fps")).split(",").map((pair) => pair.split(":")).filter((p) => p.length === 2)
        .map(([k, v]) => [k.trim(), Number(v)]))
      : {}),
  },
  defaultScale: Number(arg("scale", 3)),
};

fs.writeFileSync(path.join(outDir, "pack.json"), JSON.stringify(pack, null, 2) + "\n");

const counts = Object.entries(animations).map(([k, v]) => `${k}:${v.length}`).join(" ");
console.log(`${label}: ${counts} @ ${pack.size}px → ${path.relative(ROOT, outDir)}`);
