// More animations for a pack, without inventing a different character.
//
// Two sources, both faithful to the art:
//   1. frames the artist already drew but the pack never imported (the sheet's
//      fourth row on this pack), copied cell-relative so they still line up;
//   2. poses derived from the pack's own idle frame by geometry — a nod is a
//      squash toward the feet, a sway is a shear that leaves the feet planted,
//      a shake is a tremble, a turn is a squeeze through edge-on to mirrored.
//
// Nothing here paints new art, so the palette, the 2x pixel blocks and the
// baseline cannot drift:
//
//   node pet/pack-animations.mjs --pack ~/.opencode/pet/packs/lil-dino \
//     --sheet "$HOME/Downloads/PACK - Lil Dino Free/PACK - Lil Dino Free.png" \
//     --cell 32 --crop 4,0,24,24 --upscale 2 --row 2 --from-col 6
//
//   node pet/pack-animations.mjs --pack ~/.opencode/pet/packs/lil-dino --remove
import fs from "node:fs";
import path from "node:path";

import { decodePng, encodePng } from "./png.mjs";
import { packPalette, quantizeTo } from "./pack-art.mjs";

const args = process.argv.slice(2);
const arg = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = args[i + 1];
  return v && !v.startsWith("--") ? v : true;
};

const packDir = path.resolve(String(arg("pack") ?? "").replace(/^~/, process.env.HOME));
if (!packDir || !fs.existsSync(path.join(packDir, "pack.json"))) {
  console.error("usage: node pet/pack-animations.mjs --pack <dir> [--sheet <png> --cell 32 --crop x,y,w,h --upscale 2 --row 2 --from-col 6] [--remove]");
  process.exit(2);
}

const pack = JSON.parse(fs.readFileSync(path.join(packDir, "pack.json"), "utf8"));
pack.animations = pack.animations ?? {};
const sprites = path.join(packDir, "sprites");
const canvas = Number(pack.size ?? 48);
const footRow = Number(arg("foot", 45));

/** Animations this tool owns; everything else in the pack is the artist's. */
const SIZES = { dash: 4, nod: 3, sway: 3, shake: 4, stretch: 3, turn: 4, lean: 4, bounce: 4, slump: 3 };

/** Which states each animation answers, so the pack shows more than idle. */
const EXPRESSIONS = {
  // busy, moving
  dash: ["compressing", "ship-it", "self-tune", "determined"],
  // paying attention to the human
  nod: ["thinking", "listening", "retrieve", "recall", "tool-todo"],
  // turning to face the human, because it needs an answer
  turn: ["tool-question", "waiting"],
  // something went wrong
  shake: ["shell-fail", "oops", "conflict", "model-error", "offline", "rate-limited"],
  // waiting on something slow, so it stretches instead of standing still
  stretch: ["tool-task", "subagent-wait"],
  // reading or searching: it tips towards whatever it is looking at
  lean: ["tool-read", "tool-grep", "tool-list", "tool-webfetch", "tool-websearch", "tool-lsp", "tool-mcp"],
  // hands on the keyboard, doing the work
  bounce: ["tool-edit", "tool-write", "tool-bash", "tool-imagegen", "typing"],
  // the context is filling up and the pet is being squashed by it
  slump: ["budget-low", "budget-full"],
  // pleased with itself
  sway: ["celebrate", "shell-ok", "pack-created", "update-available"],
};

const FPS = { dash: 12, nod: 8, sway: 8, shake: 14, stretch: 5, turn: 7, lean: 5, bounce: 12, slump: 3 };

function ownedFrames() {
  return Object.entries(SIZES).flatMap(([name, count]) =>
    Array.from({ length: count }, (_, i) => `${name}-${i + 1}`));
}

function remove() {
  let gone = 0;
  for (const id of ownedFrames()) {
    const file = path.join(sprites, `${id}.png`);
    if (fs.existsSync(file)) { fs.rmSync(file); gone++; }
  }
  for (const name of Object.keys(SIZES)) {
    delete pack.animations?.[name];
    delete pack.fps?.[name];
  }
  if (pack.expressions) {
    for (const [id, anim] of Object.entries(pack.expressions)) {
      if (SIZES[anim]) delete pack.expressions[id];
    }
    if (!Object.keys(pack.expressions).length) delete pack.expressions;
  }
  fs.writeFileSync(path.join(packDir, "pack.json"), `${JSON.stringify(pack, null, 2)}\n`);
  console.log(`removed ${gone} frames: ${Object.keys(SIZES).join(", ")}`);
}

if (args.includes("--remove")) {
  remove();
  process.exit(0);
}

const base = decodePng(fs.readFileSync(path.join(sprites, `${pack.animations?.idle?.[0] ?? "idle-1"}.png`)));
const palette = packPalette(
  fs.readdirSync(sprites)
    .filter((f) => f.endsWith(".png") && !Object.keys(SIZES).some((n) => f.startsWith(`${n}-`)))
    .map((f) => decodePng(fs.readFileSync(path.join(sprites, f)))),
);

const px = (img, x, y) => {
  if (x < 0 || y < 0 || x >= img.width || y >= img.height) return [0, 0, 0, 0];
  const i = (y * img.width + x) * 4;
  return [img.data[i], img.data[i + 1], img.data[i + 2], img.data[i + 3]];
};

/** Nearest-neighbour resample: a pose, not a repaint. */
function resample(img, map) {
  const out = { width: canvas, height: canvas, data: Buffer.alloc(canvas * canvas * 4) };
  for (let y = 0; y < canvas; y++) {
    for (let x = 0; x < canvas; x++) {
      const [sx, sy] = map(x, y);
      const [r, g, b, a] = px(img, Math.round(sx), Math.round(sy));
      const i = (y * canvas + x) * 4;
      out.data[i] = r; out.data[i + 1] = g; out.data[i + 2] = b; out.data[i + 3] = a;
    }
  }
  return out;
}

/**
 * Feet stay on `footRow`; the body above them scales toward it.
 * Below 1 the body squashes (and widens); above 1 it stretches (and narrows).
 */
function squash(img, factor) {
  const cx = canvas / 2;
  return resample(img, (x, y) => [
    cx + (x - cx) * factor,
    footRow - (footRow - y) / factor,
  ]);
}

/** Lean: rows above the feet slide sideways, proportional to their height. */
function shear(img, peak) {
  const top = Number(arg("top", 18));
  return resample(img, (x, y) => {
    const t = Math.max(0, Math.min(1, (footRow - y) / Math.max(1, footRow - top)));
    return [x - peak * t, y];
  });
}

/** A tremble: the whole sprite jerks sideways, feet and all. */
function shift(img, dx) {
  return resample(img, (x, y) => [x - dx, y]);
}

/** A hop: the whole sprite leaves its baseline for a frame or two. */
function lift(img, dy) {
  return resample(img, (x, y) => [x, y + dy]);
}

/** Narrower only: what a body looks like when it turns edge-on. */
function scaleX(img, factor) {
  const cx = canvas / 2;
  return resample(img, (x, y) => [cx + (x - cx) * factor, y]);
}

function mirror(img) {
  return resample(img, (x, y) => [canvas - 1 - x, y]);
}

// ---- the artist's unused row -------------------------------------------------
function importSheetRows() {
  const sheetPath = arg("sheet");
  if (!sheetPath) return null;
  const sheet = decodePng(fs.readFileSync(String(sheetPath).replace(/^~/, process.env.HOME)));
  const cell = Number(arg("cell", 32));
  const [ox, oy, cw, ch] = String(arg("crop", "4,0,24,24")).split(",").map(Number);
  const up = Number(arg("upscale", 2));
  const row = Number(arg("row", 2));
  const fromCol = Number(arg("from-col", 6));
  const count = SIZES.dash;

  const frames = [];
  for (let i = 0; i < count; i++) {
    const x0 = (fromCol + i) * cell + ox;
    const y0 = row * cell + oy;
    // cell-relative, never re-aligned: a run that rises in the sheet still rises
    const frame = { width: canvas, height: canvas, data: Buffer.alloc(canvas * canvas * 4) };
    for (let y = 0; y < ch * up; y++) {
      for (let x = 0; x < cw * up; x++) {
        const [r, g, b, a] = px(sheet, x0 + Math.floor(x / up), y0 + Math.floor(y / up));
        const i = (y * canvas + x) * 4;
        frame.data[i] = r; frame.data[i + 1] = g; frame.data[i + 2] = b; frame.data[i + 3] = a;
      }
    }
    frames.push(quantizeTo(frame, palette));
  }
  return frames;
}

// ---- poses, each one geometry on the artist's own pixels ---------------------
const BUILT = {
  // the body dipping toward its feet, not the sprite falling
  nod: () => [0.94, 1.0, 0.97].map((f) => squash(base, f)),
  // feet planted, head leaning
  sway: () => [-2, 0, 2].map((p) => shear(base, p)),
  // the jerky "no, that broke" tremble
  shake: () => [2, -2, 2, -2].map((dx) => shift(base, dx)),
  // reaching up: waiting on something slow without standing still
  stretch: () => [1.0, 1.07, 1.03].map((f) => squash(base, f)),
  // edge-on squeeze then mirrored: it turns to face its human
  turn: () => [base, scaleX(base, 1.9), mirror(base), scaleX(base, 1.9)],
  // tipping forward towards the thing it is reading, then settling back
  lean: () => [0, 2, 2, 1].map((p) => shear(base, p)),
  // crouch, then up and down: hands on the keyboard
  bounce: () => [squash(base, 0.95), lift(base, 2), lift(base, 4), lift(base, 2)],
  // sagging under a full context, slowly, like a deflating balloon
  slump: () => [0.97, 0.93, 0.95].map((f) => squash(base, f)),
};

// ---- write ------------------------------------------------------------------
const written = [];
const dash = importSheetRows();
if (dash) {
  dash.forEach((frame, i) => {
    const id = `dash-${i + 1}`;
    fs.writeFileSync(path.join(sprites, `${id}.png`), encode(frame));
    written.push(id);
  });
  pack.animations.dash = dash.map((_, i) => `dash-${i + 1}`);
}

for (const [name, build] of Object.entries(BUILT)) {
  const frames = build();
  frames.forEach((frame, i) => {
    const id = `${name}-${i + 1}`;
    fs.writeFileSync(path.join(sprites, `${id}.png`), encode(quantizeTo(frame, palette)));
    written.push(id);
  });
  pack.animations[name] = frames.map((_, i) => `${name}-${i + 1}`);
}

pack.fps = { ...(pack.fps ?? {}) };
for (const [name, fps] of Object.entries(FPS)) if (pack.animations[name]) pack.fps[name] = fps;

pack.expressions = { ...(pack.expressions ?? {}) };
for (const [anim, ids] of Object.entries(EXPRESSIONS)) {
  if (!pack.animations[anim]) continue;
  for (const id of ids) pack.expressions[id] = anim;
}

fs.writeFileSync(path.join(packDir, "pack.json"), `${JSON.stringify(pack, null, 2)}\n`);
console.log(`${written.length} frames written: ${Object.keys(SIZES).filter((n) => pack.animations[n]).join(", ")}`);

function encode(img) { return encodePng(img.width, img.height, img.data); }
