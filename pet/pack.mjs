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
import path from "node:path";
import { fileURLToPath } from "node:url";

import { decodePng, encodePng } from "./png.mjs";

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
  console.error("usage: node pet/pack.mjs --sheet <png> --name <id> --label <name> --cell 32 --crop x,y,w,h --rows idle,walk,jump [--cols 6] [--upscale 2]");
  process.exit(2);
}

const name = String(arg("name") ?? "pack");
const label = String(arg("label") ?? name);
const cell = Number(arg("cell", 32));
const cols = Number(arg("cols", 6));
const upscale = Number(arg("upscale", 2));
const rows = String(arg("rows", "idle")).split(",").map((r) => r.trim()).filter(Boolean);
const [cx, cy, cw, ch] = String(arg("crop", `0,0,${cell},${cell}`)).split(",").map(Number);
const outDir = path.resolve(ROOT, String(arg("out", `assets/pet/packs/${name}`)));

const sheet = decodePng(fs.readFileSync(String(sheetPath).replace(/^~/, process.env.HOME)));
const width = Number(arg("width", Math.min(sheet.width, cols * cell)) / cell) * 0; // unused, kept explicit
void width;
const gridCols = Math.max(1, Math.floor(Math.min(sheet.width, cols * cell) / cell));
const gridRows = Math.floor(sheet.height / cell);

if (rows.length > gridRows) {
  console.error(`sheet has ${gridRows} rows of ${cell}px, but ${rows.length} animations were named`);
  process.exit(1);
}

fs.mkdirSync(path.join(outDir, "sprites"), { recursive: true });

/** Copy one cell region, scaled by nearest neighbour so pixels stay square. */
function cropCell(row, col) {
  const w = cw * upscale, h = ch * upscale;
  const data = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const sx = col * cell + cx + Math.floor(x / upscale);
      const sy = row * cell + cy + Math.floor(y / upscale);
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
    const img = cropCell(r, c);
    let opaque = 0;
    for (let i = 3; i < img.data.length; i += 4) if (img.data[i]) opaque++;
    if (opaque === 0) continue;
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
  size: Math.max(cw, ch) * upscale,
  // file name only: a pack ships without leaking the builder's directory layout
  source: path.basename(String(sheetPath)),
  // the pack author keeps their art rights; this records where it came from
  license: arg("license") && arg("license") !== true ? String(arg("license")) : "unknown",
  animations,
  // The sheet's idle is a slow breath and its walk is a six-beat stride.
  fps: { idle: Number(arg("idle-fps", 6)), walk: Number(arg("walk-fps", 12)), jump: Number(arg("jump-fps", 12)) },
  defaultScale: Number(arg("scale", 3)),
};

fs.writeFileSync(path.join(outDir, "pack.json"), JSON.stringify(pack, null, 2) + "\n");

const counts = Object.entries(animations).map(([k, v]) => `${k}:${v.length}`).join(" ");
console.log(`${label}: ${counts} @ ${pack.size}px → ${path.relative(ROOT, outDir)}`);
