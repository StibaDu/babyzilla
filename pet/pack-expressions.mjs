// Add expression animations to a pack that has none, by editing its own pixels.
//
// Generated art cannot hold a 15x13 character at 512px — img2img either drifts the
// design or melts the pose — so an expressive pack is authored the way pixel pets
// always were: on the grid, one eye and one mouth at a time. Everything here is
// derived from a single frame of the pack, so the character cannot change.
//
//   node pet/pack-expressions.mjs --pack ~/.opencode/pet/packs/lil-dino
//
// Writes blink/happy/angry/surprised/hurt/sleep animations, keeps the existing
// idle/walk/jump, and records an expression map so each of the 100 expression ids
// selects the face that fits it.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { decodePng, encodePng } from "./png.mjs";
import { packPalette } from "./pack-art.mjs";
import { EXPRESSIONS } from "./expressions.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

const args = process.argv.slice(2);
const arg = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = args[i + 1];
  return v && !v.startsWith("--") ? v : true;
};

const packDir = path.resolve(String(arg("pack") ?? path.join(ROOT, "assets/pet/packs/lil-dino")).replace(/^~/, process.env.HOME));
const pack = JSON.parse(fs.readFileSync(path.join(packDir, "pack.json"), "utf8"));
const sprites = path.join(packDir, "sprites");

/** The pack's frames are 2x upscales of this grid; read and write the grid. */
const SCALE = 2;
const N = pack.size / SCALE;

// Colours are derived from the pack instead of hardcoded: roles are what the
// edits are written in (light, shade, white, mid, neutral, ink, body), so the same
// faces work on any pack whose palette has those relationships. A hardcoded table
// silently blanked every pixel it did not recognise.
const lum = (c) => 0.299 * c.r + 0.587 * c.g + 0.114 * c.b;
const sat = (c) => Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b);

function deriveRoles(frames) {
  const palette = packPalette(frames);
  if (palette.length < 3) throw new Error(`pack palette needs at least 3 colours (found ${palette.length})`);
  const byLum = [...palette].sort((a, b) => lum(a) - lum(b));
  const body = palette[0];
  return {
    body,
    light: palette[1] ?? body,
    ink: byLum[0],
    shade: byLum[1] ?? byLum[0],
    mid: byLum[2] ?? byLum[1] ?? byLum[0],
    white: byLum[byLum.length - 1],
    neutral: [...palette].sort((a, b) => sat(a) - sat(b))[0],
  };
}

const ROLE = { m: "body", L: "light", "#": "ink", d: "mid", c: "white", g: "neutral", k: "shade" };

function paletteFor(roles) {
  return Object.fromEntries(Object.entries(ROLE).map(([ch, role]) => [ch, roles[role]]));
}

function readGrid(file, roles) {
  const img = decodePng(fs.readFileSync(file));
  const hexOf = (c) => (c.r << 16) | (c.g << 8) | c.b;
  const byColour = new Map(Object.entries(paletteFor(roles)).map(([ch, c]) => [hexOf(c), ch]));
  const nearest = (r, g, b) => {
    let best = "m", bestD = Infinity;
    for (const [ch, c] of Object.entries(paletteFor(roles))) {
      const d = (c.r - r) ** 2 + (c.g - g) ** 2 + (c.b - b) ** 2;
      if (d < bestD) { bestD = d; best = ch; }
    }
    return best;
  };
  const grid = [];
  for (let y = 0; y < N; y++) {
    const row = [];
    for (let x = 0; x < N; x++) {
      const i = (y * SCALE * img.width + x * SCALE) * 4;
      if (!img.data[i + 3]) { row.push("."); continue; }
      const r = img.data[i], g = img.data[i + 1], b = img.data[i + 2];
      row.push(byColour.get((r << 16) | (g << 8) | b) ?? nearest(r, g, b));
    }
    grid.push(row);
  }
  return grid;
}

function makePng(grid, HEX) {
  const size = N * SCALE;
  const data = Buffer.alloc(size * size * 4);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const ch = grid[y][x];
      if (ch === "." || ch === "?") continue;
      const hex = HEX[ch];
      if (!hex) continue;
      const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
      for (let dy = 0; dy < SCALE; dy++) {
        for (let dx = 0; dx < SCALE; dx++) {
          const d = ((y * SCALE + dy) * size + (x * SCALE + dx)) * 4;
          data[d] = r; data[d + 1] = g; data[d + 2] = b; data[d + 3] = 255;
        }
      }
    }
  }
  return encodePng(size, size, data);
}

const clone = (g) => g.map((r) => [...r]);
const put = (g, x, y, ch) => { if (x >= 0 && y >= 0 && x < N && y < N) g[y][x] = ch; };
const rect = (g, x0, y0, x1, y1, ch) => {
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) put(g, x, y, ch);
};
/** Whole-sprite shift, in grid pixels; the pack's rows only move 1-2px. */
function shifted(grid, dx, dy) {
  const out = Array.from({ length: N }, () => Array(N).fill("."));
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const ch = grid[y][x];
      if (ch === "." || ch === "?") continue;
      put(out, x + dx, y + dy, ch);
    }
  }
  return out;
}

const frameFiles = fs.readdirSync(sprites).filter((f) => f.endsWith(".png"));
const roles = deriveRoles(frameFiles.map((f) => decodePng(fs.readFileSync(path.join(sprites, f)))));
const HEX = Object.fromEntries(Object.entries(paletteFor(roles)).map(([ch, c]) => [ch, "#" + ((c.r << 16) | (c.g << 8) | c.b).toString(16).padStart(6, "0")]));
const base = readGrid(path.join(sprites, "idle-1.png"), roles);

// ── faces ────────────────────────────────────────────────────────────────────
// Eye is the white at (13,12) with its pupil at (12,13); the grin is the tooth
// row at y=17; the mouth opens into the dark row below it at y=18.
const faces = {};

// The mouth is what carries an expression at this size; a 2x2 eye cannot. So each
// face changes the silhouette of the grin (or opens it) and adds a brow, rather
// than nudging the eye and hoping.
//
//   eye white (13,12) · pupil (12,13) · nostril (17..18,12..13)
//   tooth row  y=17, x=11..18 · mouth interior y=18, x=11..17 · head x=8..19

faces.blink = clone(base);
rect(faces.blink, 12, 12, 13, 12, "L");   // lid
rect(faces.blink, 12, 13, 13, 13, "k");   // closed slit

// A grin is a second silhouette, not a nudged line: the mouth opens two rows and
// keeps its teeth, which is unmistakably different from every other face.
faces.happy = clone(base);
put(faces.happy, 12, 13, "k");
rect(faces.happy, 11, 17, 16, 17, "c");   // teeth
rect(faces.happy, 11, 18, 16, 18, "k");   // open mouth under them
put(faces.happy, 10, 16, "k"); put(faces.happy, 17, 17, "k");

faces.angry = clone(base);
// brow low over the eye, pupil forward, teeth gone: a snarl
put(faces.angry, 11, 11, "k"); put(faces.angry, 12, 11, "k"); put(faces.angry, 13, 11, "L");
put(faces.angry, 13, 12, "k"); put(faces.angry, 12, 13, "k");
rect(faces.angry, 11, 17, 18, 17, "d");
put(faces.angry, 11, 18, "k"); put(faces.angry, 17, 18, "k");

faces.surprised = clone(base);
// wide eye and an open mouth: a hole, not a line of teeth
rect(faces.surprised, 12, 11, 13, 12, "c");
put(faces.surprised, 13, 13, "k");
rect(faces.surprised, 12, 17, 15, 18, "k");

faces.hurt = clone(base);
// one eye screwed shut, the grin broken in the middle
put(faces.hurt, 12, 12, "k"); put(faces.hurt, 13, 13, "k");
put(faces.hurt, 13, 12, "L"); put(faces.hurt, 12, 13, "L");
put(faces.hurt, 14, 17, "k"); put(faces.hurt, 16, 17, "k");

// ── animations ───────────────────────────────────────────────────────────────
// Each is the face plus a 1px beat, so it holds up when the app loops it for the
// duration of a reaction.
const animations = {
  blink: [faces.blink, faces.blink],
  happy: [faces.happy, shifted(faces.happy, 0, -1)],
  angry: [faces.angry, shifted(faces.angry, 0, -1)],
  surprised: [faces.surprised, shifted(faces.surprised, 0, -1)],
  hurt: [faces.hurt, shifted(faces.hurt, 1, 0)],
};

for (const [name, frames] of Object.entries(animations)) {
  const ids = [];
  frames.forEach((grid, i) => {
    const id = `${name}-${i + 1}`;
    fs.writeFileSync(path.join(sprites, `${id}.png`), makePng(grid, HEX));
    ids.push(id);
  });
  pack.animations[name] = ids;
}

// ── which expression gets which face ─────────────────────────────────────────
const CATEGORY = {
  // closed eyes double as the sleeping face: at this size a "sleep" variant was
  // indistinguishable from a blink, so there is no point shipping both
  blink: ["blink", "sleep", "zzz", "doze", "groggy", "yawn", "coffee", "sit"],
  happy: ["happy", "celebrate", "party", "dance", "wave", "poke", "love", "ship-it", "success", "eureka",
    "cake", "high-five", "proud", "roar", "rubber-duck", "glitch", "self-tune", "pack-created"],
  angry: ["angry", "error", "shell-fail", "stuck", "confused", "determined", "test-fail", "model-error", "budget-full"],
  surprised: ["surprised", "update-available", "eureka", "wake-startled", "budget-low", "tool-webfetch"],
  hurt: ["hurt", "oops", "segfault", "offline", "rate-limited", "conflict", "retry", "shrug"],
};
const face = {};
for (const [anim, ids] of Object.entries(CATEGORY)) for (const id of ids) face[id] = anim;

// every expression the app knows must resolve to something
const known = new Set(EXPRESSIONS.map((e) => e.id));
const map = {};
for (const e of EXPRESSIONS) map[e.id] = face[e.id] ?? "idle";
pack.expressions = map;
pack.fps = { ...(pack.fps ?? {}), blink: 6, happy: 6, angry: 10, surprised: 10, hurt: 10 };

// A face that was dropped must not leave frames behind: the app loads every PNG
// in the pack, and the installer copies them.
const keep = new Set(Object.values(pack.animations).flat());
for (const file of fs.readdirSync(sprites)) {
  if (!file.endsWith(".png")) continue;
  const id = file.slice(0, -4);
  const isFace = /^(blink|happy|angry|surprised|hurt|sleep|sad)-/.test(id);
  if (isFace && !keep.has(id)) fs.rmSync(path.join(sprites, file));
}

fs.writeFileSync(path.join(packDir, "pack.json"), JSON.stringify(pack, null, 2) + "\n");
const missing = EXPRESSIONS.filter((e) => !known.has(e.id));
void missing;
console.log(`faces: ${Object.keys(animations).join(", ")} → ${EXPRESSIONS.length} expressions mapped`);
