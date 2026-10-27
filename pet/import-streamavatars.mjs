// Import Stream Avatars avatar packages as local BabyZilla packs.
//
//   node pet/import-streamavatars.mjs --zip ~/"…/premade/littlewalker.zip"
//   node pet/import-streamavatars.mjs --zip ~/"…/StreamingAssets"/*.zip
//   node pet/import-streamavatars.mjs --dir /tmp/unpacked-avatar --only littlewalker
//
// A Stream Avatars avatar is a zip with three things:
//
//   data.txt             JSON: cell size, the animation list *in order*, and the
//                        per-frame pivot of every gear layer (hats, held items)
//   avatars/<name>.png   one grid: rows are animations, columns are frames
//   gear/<set>/*.png     overlay art: the same grid, or one cell, or a strip
//
// That grid is exactly what `pet/pack.mjs` reads (`--cell`, `--cols`, `--rows`),
// so the sprite half of a pack is a single call to it. This file adds the half a
// sheet alone cannot carry: the gear layers and their pivots, plus an
// `expressions` map for the postures the avatar does have.
//
// **These are paid Steam assets.** Everything this writes stays in the pet state
// dir — an `--out` inside the repository is refused, because "personal use" and
// "shipped in a release" are not the same permission. `pack.json` records the
// licence line so a pack never loses where it came from.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

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
// `--zip a.zip b.zip` and `--zip dir/*.zip` both mean every archive up to the
// next flag: a shell expands the glob into one argument per file.
const all = (name) => {
  const out = [];
  args.forEach((a, i) => {
    if (a !== `--${name}`) return;
    for (let j = i + 1; j < args.length && !args[j].startsWith("--"); j++) out.push(args[j]);
  });
  return out;
};

/** Where packs live. The only directory this importer is allowed to write to. */
export function packsRoot() {
  const state = process.env.BABYZILLA_PET_STATE ?? path.join(os.homedir(), ".opencode/pet");
  return path.join(path.resolve(state), "packs");
}

const LICENSE = "Stream Avatars (Steam) — personal use only, not redistributable";

/** Display names the raw ids get wrong (all lowercase, no spaces). */
const TITLES = {
  bluemon: "Blue Mon",
  caracabat: "Caracabat",
  fatsack: "Fat Sack",
  littlewalker: "Little Walker",
  block_man: "Block Man",
  blackwidow: "Black Widow",
  blackpanther: "Black Panther",
  captainamerica: "Captain America",
  drstrange: "Doctor Strange",
  ironman: "Iron Man",
  scarlettwitch: "Scarlet Witch",
  starlord: "Star-Lord",
  wintersoldier: "Winter Soldier",
  rocket: "Rocket",
  mantis: "Mantis",
  groot: "Groot",
  hulk: "Hulk",
  thor: "Thor",
};

/** Gear folders, in the order a menu should read them. */
const GROUPS = {
  b_hats: "Hats",
  littlehats: "Hats",
  b_heads: "Heads",
  b_hair: "Hair",
  b_face: "Faces",
  littlemasks: "Masks",
  b_emote: "Emotes",
  b_back: "Back",
  b_mainhand: "Main hand",
  b_offhand: "Off hand",
  b_chairs: "Chairs",
  stuff: "Items",
};

/** Frame rate to fall back on when a sheet does not state one. */
const FPS = { idle: 6, walk: 12, jump: 12, sit: 6, stand: 6, dance: 8 };

/** The animations the app drives by name; a row's own label never renames them. */
const DRIVEN = new Set(["idle", "walk", "jump"]);

/** Row labels that say nothing: `custom1`, `custom2`, … are placeholders. */
const placeholder = (name) => !name || /^custom\d*$/i.test(name) || /^(none|default)$/i.test(name);

/**
 * Postures for the expressions a face-less avatar cannot draw. A pet that sits
 * while it waits reads as patient; one that keeps hopping reads as deaf.
 */
const POSTURES = {
  sit: ["sit", "doze", "zzz", "sleep", "bored-waiting", "waiting-approval"],
  dance: ["party", "dance", "celebrate"],
};

/**
 * A row the sheet bothered to name says what it means: a `wave` row is a wave,
 * a `clap` is applause, a `sleep` row really is sleep. These win over the
 * postures above, which only guess from the body.
 */
const NAMED = {
  dance: ["party", "dance", "celebrate"],
  wave: ["wave"],
  clap: ["success", "ship-it"],
  sleep: ["sleep", "zzz", "doze"],
};

export function labelFor(id) {
  const outfit = /_outfit$/.test(id);
  const base = id.replace(/_outfit$/, "");
  const name = TITLES[base] ?? base.split(/[_\s]+/).filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
  return outfit ? `${name} (outfit)` : name;
}

export function groupFor(set) {
  return GROUPS[set] ?? set.replace(/^[a-z]_/, "").replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

/** PNG dimensions from the IHDR chunk — enough to classify a gear layer. */
export function pngSize(buf) {
  if (buf.length < 24 || buf.toString("ascii", 1, 4) !== "PNG") throw new Error("not a PNG");
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/**
 * What a gear PNG is, from its dimensions alone. Stream Avatars packs three
 * shapes in this folder and they must not be read as each other:
 *
 *   grid    the avatar's own sheet (384x608) — one cell per animation frame
 *   strip   several cells wide, one cell tall (448x32 = 14 frames) — self-animating
 *   single  one cell on its own canvas (48x48 hair on a 32px avatar)
 */
export function classifyGear(size, avatar) {
  const { width: w, height: h } = size;
  if (w === avatar.sheetW && h === avatar.sheetH) {
    return { mode: "grid", cellW: avatar.cellW, cellH: avatar.cellH, cols: avatar.cols, rows: avatar.rows };
  }
  const n = w / h;
  if (Number.isInteger(n) && n >= 1) {
    return { mode: n > 1 ? "strip" : "single", cellW: h, cellH: h, cols: n, rows: 1 };
  }
  // 32x33 hats exist: one cell, a pixel taller than the avatar's own.
  if (w <= h * 1.3) return { mode: "single", cellW: w, cellH: h, cols: 1, rows: 1 };
  return null;
}

/** Round to a tenth and drop the trailing ".0": pivots are whole source pixels. */
function pivotValue(list) {
  return list.map(([x, y]) => [Math.round(x * 10) / 10, Math.round(y * 10) / 10]);
}

/** True when any frame of any animation carries an offset. */
function anyOffset(animsOf) {
  return Object.values(animsOf).some((frames) => frames.some(([x, y]) => x || y));
}

/**
 * Turn one unpacked avatar folder into a pack. Returns a summary; throws so a
 * batch of fifteen archives can report one bad avatar and keep the rest.
 */
export function installAvatar(dir, { outRoot, name = null, upscale = 0, scale = 0, only = null, source = null } = {}) {
  const dataFile = path.join(dir, "data.txt");
  if (!fs.existsSync(dataFile)) throw new Error("no data.txt — not a Stream Avatars avatar");
  const data = JSON.parse(fs.readFileSync(dataFile, "utf8"));
  const avatars = data?.avatar ?? {};
  const keys = Object.keys(avatars).filter((k) => fs.existsSync(path.join(dir, "avatars", `${k}.png`)));
  if (!keys.length) throw new Error("data.txt describes no avatar with a sheet in avatars/");

  const installed = [];
  for (const key of keys) {
    if (only && !only.includes(key)) continue;
    const av = avatars[key];
    const sheetPath = path.join(dir, "avatars", `${key}.png`);
    const sheet = pngSize(fs.readFileSync(sheetPath));
    const cellW = Number(av.width);
    const cellH = Number(av.height);
    if (!cellW || !cellH) throw new Error(`${key}: data.txt has no cell size`);

    // Rows are animations *in declaration order*, and an animation with no
    // frames has no row — the sheet only carries rows that were drawn.
    const anims = Object.entries(av.animationData ?? {})
      .map(([anim, v]) => ({
        anim,
        frames: (v.frameData ?? []).length,
        customName: v.customName,
        fps: v.framesPerSecond,
      }))
      .filter((a) => a.frames > 0);
    if (!anims.length) throw new Error(`${key}: no animation frames`);
    // A sheet often names its own rows: `custom2` labelled "wave" plays as
    // `wave`, not as the sheet's internal key. Placeholder labels and the three
    // animations the app drives by name keep their row key.
    const taken = new Set(anims.map((a) => a.anim));
    for (const a of anims) {
      const named = String(a.customName ?? "").trim().toLowerCase().replace(/\s+/g, "-");
      const usable = /^[a-z][a-z0-9_-]*$/.test(named) && !placeholder(named) && !DRIVEN.has(a.anim) && !taken.has(named);
      a.id = usable ? named : a.anim;
      taken.add(a.id);
    }
    const cols = Math.min(
      Math.max(...anims.map((a) => a.frames)),
      Math.floor(sheet.width / cellW),
    );
    const rows = Math.floor(sheet.height / cellH);
    if (rows < anims.length) throw new Error(`${key}: sheet has ${rows} rows for ${anims.length} animations`);

    const id = name ?? key;
    const square = cellW === cellH;
    // A 32px avatar at 1x is a thumbnail on a 1440px screen; 2-3x puts every
    // imported pet at the size Lil Dino ships at (~64px cells).
    const autoUpscale = square ? Math.max(1, Math.round(64 / cellW)) : 1;
    const up = Math.max(1, Number(upscale) || autoUpscale);
    const size = square ? cellW * up : Math.max(cellW, cellH);
    const shown = Math.max(1, Number(scale) || (size <= 80 ? 2 : 1));

    // The sheet states a frame rate per row (9 for nearly every avatar, 17 for
    // the fast emotes); only a sheet that omits one falls back to the defaults.
    const fps = Object.fromEntries(
      anims.map((a) => [a.id, Number(a.fps) || (FPS[a.id] ?? FPS[a.anim] ?? 8)]),
    );
    const out = path.join(outRoot, id);
    // Never eat someone else's pet: a catalog id like `thor` may already exist.
    // Only a pack this importer wrote may be replaced.
    const existing = path.join(out, "pack.json");
    if (fs.existsSync(existing)) {
      let prior = null;
      try { prior = JSON.parse(fs.readFileSync(existing, "utf8")); } catch { /* a broken dir is fair game */ }
      if (prior && prior.imported !== "streamavatars") {
        throw new Error(`${id} is already installed from somewhere else — move ${out} aside first`);
      }
    }
    fs.rmSync(out, { recursive: true, force: true });

    const packArgs = [
      path.join(ROOT, "pet/pack.mjs"),
      "--sheet", sheetPath,
      "--name", id,
      "--label", labelFor(key),
      "--cell", square ? String(cellW) : `${cellW}x${cellH}`,
      "--cols", String(cols),
      "--rows", anims.map((a) => a.id).join(","),
      "--scale", String(shown),
      "--license", LICENSE,
      "--fps", Object.entries(fps).map(([k, v]) => `${k}:${v}`).join(","),
      "--out", out,
    ];
    // Square cells keep their pixels (nearest); 70x74 hero sheets are box-filtered
    // square, because the app draws packs into a square window.
    if (square) packArgs.push("--upscale", String(up));
    else packArgs.push("--resize", String(size));
    // Its own summary line would repeat the table this script prints.
    execFileSync(process.execPath, packArgs, { stdio: ["ignore", "ignore", "inherit"] });

    const packFile = path.join(out, "pack.json");
    const pack = JSON.parse(fs.readFileSync(packFile, "utf8"));
    pack.source = `${source ?? path.basename(dir)} → avatars/${key}.png`;
    pack.imported = "streamavatars";
    pack.atlas = { sheet: `${sheet.width}x${sheet.height}`, cell: `${cellW}x${cellH}`, cols, rows, animations: anims.length };

    const expressions = {};
    for (const [anim, ids] of Object.entries({ ...POSTURES, ...NAMED })) {
      if (!pack.animations[anim]?.length) continue;
      for (const expr of ids) expressions[expr] = anim;
    }
    if (Object.keys(expressions).length) pack.expressions = expressions;

    const gear = importGear(dir, out, av, { cellW, cellH, cols, rows, sheetW: sheet.width, sheetH: sheet.height }, anims);
    if (gear) pack.gear = gear;

    fs.writeFileSync(packFile, `${JSON.stringify(pack, null, 2)}\n`);
    installed.push({
      id,
      label: pack.label,
      frames: Object.values(pack.animations).reduce((n, f) => n + f.length, 0),
      gear: gear?.items.length ?? 0,
      skipped: gear?.skipped ?? 0,
      dir: out,
    });
  }
  if (!installed.length) throw new Error(only ? `no avatar named ${only.join(",")}` : "nothing to install");
  return installed;
}

/**
 * Copy the overlay art and the pivots that place it. Pivots stay in *source*
 * pixels: the app scales them with the sprite, so a 2x pack still lines up.
 */
function importGear(dir, out, av, avatar, anims) {
  const gearDir = path.join(dir, "gear");
  if (!fs.existsSync(gearDir)) return null;

  const items = [];
  let skipped = 0;
  for (const set of fs.readdirSync(gearDir).sort()) {
    const setDir = path.join(gearDir, set);
    if (!fs.statSync(setDir).isDirectory()) continue;
    for (const file of fs.readdirSync(setDir).sort()) {
      if (!file.toLowerCase().endsWith(".png")) continue;
      const src = path.join(setDir, file);
      const size = pngSize(fs.readFileSync(src));
      const shape = classifyGear(size, avatar);
      if (!shape) { skipped++; continue; }
      const base = file.replace(/\.png$/i, "");
      const rel = path.join("gear", set, file);
      fs.mkdirSync(path.join(out, "gear", set), { recursive: true });
      fs.copyFileSync(src, path.join(out, rel));
      items.push({
        id: `${set}/${base}`,
        label: base.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase()),
        group: groupFor(set),
        set,
        file: rel.split(path.sep).join("/"),
        cellW: shape.cellW,
        cellH: shape.cellH,
        cols: shape.cols,
        rows: shape.rows,
        mode: shape.mode,
        ...(shape.mode === "strip" ? { fps: 8 } : {}),
      });
    }
  }
  if (!items.length) return skipped ? { avatarW: avatar.cellW, avatarH: avatar.cellH, rows: anims.map((a) => a.id), items: [], skipped } : null;

  const pivots = {};
  const unique = {};
  // Pivots are stored under the *pack's* animation name, so a row renamed from
  // `custom2` to `wave` still places its hat on the wave frames.
  for (const { anim, id } of anims) {
    const frames = av.animationData?.[anim]?.frameData ?? [];
    frames.forEach((frame, i) => {
      for (const [set, xy] of Object.entries(frame.gearPivot ?? {})) {
        pivots[set] ??= {};
        pivots[set][id] ??= [];
        pivots[set][id][i] = [Number(xy.x) || 0, Number(xy.y) || 0];
      }
      for (const [set, per] of Object.entries(frame.uniquePivot ?? {})) {
        for (const [gid, xy] of Object.entries(per ?? {})) {
          if (typeof xy !== "object" || xy === null) continue;
          const key = `${set}/${gid}`;
          unique[key] ??= {};
          unique[key][id] ??= [];
          unique[key][id][i] = [Number(xy.x) || 0, Number(xy.y) || 0];
        }
      }
    });
  }
  const clean = (table) => Object.fromEntries(
    Object.entries(table)
      .map(([k, animsOf]) => [k, Object.fromEntries(Object.entries(animsOf).map(([a, list]) => [a, pivotValue(list)]))])
      .filter(([, animsOf]) => anyOffset(animsOf)),
  );

  return {
    avatarW: avatar.cellW,
    avatarH: avatar.cellH,
    rows: anims.map((a) => a.id),
    ...(Object.keys(clean(pivots)).length ? { pivots: clean(pivots) } : {}),
    ...(Object.keys(clean(unique)).length ? { unique: clean(unique) } : {}),
    items,
    ...(skipped ? { skipped } : {}),
  };
}

/** A refusal, not a warning: the licence is the reason this script exists. */
export function assertLocal(outRoot) {
  const root = path.resolve(outRoot);
  const allowed = path.resolve(packsRoot());
  const rel = path.relative(allowed, root);
  const inside = rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  if (!inside) {
    throw new Error(
      `refusing to write to ${root}\n` +
      `Stream Avatars art is paid Steam content: it may live in your pet state dir ` +
      `(${allowed}), never in the repository or a release.`,
    );
  }
}

function main() {
  const zips = all("zip");
  const dirs = all("dir");
  if (!zips.length && !dirs.length) {
    console.error("usage: node pet/import-streamavatars.mjs --zip <avatar.zip> [--zip …] [--dir <unpacked>] [--only id,id] [--upscale N] [--scale N] [--out <packs dir>]");
    process.exit(2);
  }

  const outRoot = path.resolve(String(arg("out", packsRoot())).replace(/^~/, process.env.HOME ?? "~"));
  const only = arg("only") && arg("only") !== true ? String(arg("only")).split(",").map((s) => s.trim()).filter(Boolean) : null;
  const upscale = Number(arg("upscale", 0)) || 0;
  const scale = Number(arg("scale", 0)) || 0;

  try {
    assertLocal(outRoot);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }

  const temps = [];
  try {
    const sources = [];
    for (const zip of zips) {
      const temp = fs.mkdtempSync(path.join(os.tmpdir(), "bz-sa-"));
      temps.push(temp);
      try {
        execFileSync(tool("unzip"), ["-o", "-q", path.resolve(zip.replace(/^~/, process.env.HOME ?? "~")), "-d", temp], { stdio: "ignore" });
      } catch {
        throw new Error(`cannot unzip ${zip}`);
      }
      sources.push({ label: path.basename(zip), dir: temp });
    }
    for (const dir of dirs) sources.push({ label: path.basename(dir), dir: path.resolve(dir.replace(/^~/, process.env.HOME ?? "~")) });

    let total = 0;
    for (const source of sources) {
      try {
        const built = installAvatar(source.dir, { outRoot, only, upscale, scale, source: source.label });
        for (const p of built) {
          total++;
          const gearNote = p.gear ? ` gear=${p.gear}${p.skipped ? ` (+${p.skipped} unsupported)` : ""}` : "";
          console.log(`  ${p.id.padEnd(16)} ${p.label.padEnd(22)} ${String(p.frames).padStart(3)} frames${gearNote}`);
        }
      } catch (error) {
        console.error(`skip ${source.label}: ${error.message}`);
      }
    }
    if (!total) process.exit(1);
    console.log(`${total} pets installed in ${outRoot}. Wear one with: babyzilla pet use <id>`);
  } finally {
    for (const temp of temps) fs.rmSync(temp, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
