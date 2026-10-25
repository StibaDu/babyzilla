// One OpenPets / Codex pet package → one BabyZilla pack.
//
// A package is a folder with `pet.json` and a spritesheet. The atlas is 8 columns
// wide and every cell is 192x208: V1 sheets carry 9 rows (the standard
// animations), V2 sheets carry 11 (the same nine, plus sixteen look-direction
// cells this app has no use for — they are cropped away, not mangled).
//
//   node pet/pet-package.mjs <dir|zip|url> [--as <name>] [--voice <id>]
//
// Everything else about a pack — size, expressions, voice, attribution — is
// settled here, so `pet add`, `pet/import-openpet.mjs` and a hand-run build all
// produce the same artefact.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { decodePng } from "./png.mjs";
import { houseVoice, VOICES } from "../lib/pet-voice.mjs";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The nine standard rows of an OpenPets/Codex atlas, top to bottom. */
export const ROWS = ["idle", "walk", "walkleft", "wave", "jump", "sad", "wait", "run", "review"];

export const FPS = { idle: 6, walk: 12, walkleft: 12, wave: 8, jump: 12, sad: 6, wait: 6, run: 14, review: 4 };

/**
 * Where each expression id lands in a nine-animation atlas. These sheets have a
 * body but no face, so the closest *posture* is used: a pet without faces still
 * reacts instead of freezing on idle.
 */
export const EXPRESSIONS = {
  thinking: "review", listening: "review", retrieve: "review", recall: "review",
  "tool-read": "review", "tool-grep": "review", "tool-list": "review", "tool-webfetch": "review",
  "tool-websearch": "review", "tool-lsp": "review", "tool-mcp": "review", "tool-todo": "review",
  compressing: "run", "ship-it": "run", "self-tune": "run", determined: "run", typing: "run",
  "tool-task": "run",
  celebrate: "jump", "shell-ok": "jump", "pack-created": "jump", party: "jump",
  "tool-edit": "jump", "tool-write": "jump", "tool-bash": "jump", "tool-imagegen": "jump",
  wave: "wave", ping: "wave", poke: "wave", "update-available": "wave",
  "shell-fail": "sad", oops: "sad", conflict: "sad", "model-error": "sad", offline: "sad",
  "rate-limited": "sad", "budget-full": "sad",
  waiting: "wait", "tool-question": "wait", "subagent-wait": "wait", "budget-low": "wait",
};

/** The folder inside `dir` that holds a pet.json, if any (one level down in zips). */
export function findPackageRoot(dir) {
  if (fs.existsSync(path.join(dir, "pet.json"))) return dir;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const inner = path.join(dir, entry.name);
    if (fs.existsSync(path.join(inner, "pet.json"))) return inner;
  }
  return null;
}

/** Every pet package under a folder (the shape a community repo usually has). */
export function findPackages(dir) {
  const found = [];
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return found; }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const inner = path.join(dir, entry.name);
    if (fs.existsSync(path.join(inner, "pet.json"))) found.push(inner);
  }
  return found;
}

/** sips turns whatever the author shipped into the PNG the builder decodes. */
function toPng(sheet, workDir) {
  if (/\.png$/i.test(sheet)) return sheet;
  const png = path.join(workDir, `sheet-${process.pid}.png`);
  try {
    execFileSync("/usr/bin/sips", ["-s", "format", "png", sheet, "--out", png], { stdio: "ignore" });
  } catch {
    throw new Error(`cannot read ${path.basename(sheet)} — the package needs a webp or PNG atlas`);
  }
  return png;
}

/**
 * Union of the opaque pixels of the nine animation rows, clamped to one cell, so
 * a tall character never loses its feet and a wide one never borrows a frame from
 * the column beside it.
 */
export function characterCrop(sheet, cellW, cellH) {
  const rows = Math.min(9, Math.floor(sheet.height / cellH));
  const limit = rows * cellH;
  let x0 = cellW, y0 = cellH, x1 = -1, y1 = -1;
  for (let y = 0; y < limit; y++) {
    for (let x = 0; x < sheet.width; x++) {
      if (sheet.data[(y * sheet.width + x) * 4 + 3] < 24) continue;
      const cx = x % cellW;
      const cy = y % cellH;
      if (cx < x0) x0 = cx;
      if (cy < y0) y0 = cy;
      if (cx > x1) x1 = cx;
      if (cy > y1) y1 = cy;
    }
  }
  if (x1 < x0 || y1 < y0) return { x: 0, y: 0, w: cellW, h: cellH };
  const pad = 2;
  const x = Math.max(0, x0 - pad);
  const y = Math.max(0, y0 - pad);
  return { x, y, w: Math.min(cellW - x, x1 - x0 + 1 + pad * 2), h: Math.min(cellH - y, y1 - y0 + 1 + pad * 2) };
}

/** Download to a file. Kept separate so `pet add` can report bytes on failure. */
export async function download(url, dest) {
  const res = await fetch(url, { headers: { "user-agent": "babyzilla (+https://github.com/StibaDu/babyzilla)" } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(dest, buffer);
  return buffer.length;
}

export function unzip(archive, dest) {
  fs.mkdirSync(dest, { recursive: true });
  try {
    execFileSync("/usr/bin/unzip", ["-o", "-q", archive, "-d", dest], { stdio: "ignore" });
  } catch {
    // unzip refuses some archives ditto reads happily; try the system copy tool
    execFileSync("/usr/bin/ditto", ["-x", "-k", archive, dest], { stdio: "ignore" });
  }
}

/**
 * Build a pack from a package folder that already exists on disk.
 *
 * Returns a summary; throws (never exits) so a batch import can skip a broken pet
 * and carry on with the rest.
 */
export function installPetPackage(root, {
  outRoot,
  size = 112,
  scale = 2,
  voice = null,
  name = null,
  label = null,
  source = null,
  license = null,
  workDir = null,
} = {}) {
  const meta = JSON.parse(fs.readFileSync(path.join(root, "pet.json"), "utf8"));
  const id = String(name ?? meta.id ?? path.basename(root)).trim();
  const display = String(label ?? meta.displayName ?? id);
  if (!id) throw new Error("the package has no id");
  if (!outRoot) throw new Error("installPetPackage needs outRoot");

  const sheetName = String(meta.spritesheetPath ?? "spritesheet.webp");
  const sheet = path.join(root, sheetName);
  if (!fs.existsSync(sheet)) throw new Error(`no spritesheet at ${sheetName}`);
  if (/\.svg$/i.test(sheet)) throw new Error("SVG atlases need a rasteriser — find this pet as webp or PNG");

  const work = workDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "bz-pet-"));
  try {
    const img = decodePng(fs.readFileSync(toPng(sheet, work)));
    const cellW = Math.floor(img.width / 8);
    const cellH = Math.round((cellW * 208) / 192);
    const rows = cellH ? Math.floor(img.height / cellH) : 0;
    if (cellW < 8 || rows < ROWS.length) {
      throw new Error(`not an OpenPets/Codex atlas: ${img.width}x${img.height} (${cellW}x${cellH} cells, ${rows} rows)`);
    }
    const crop = characterCrop(img, cellW, cellH);
    const wanted = voice ?? houseVoice(id);
    const picked = VOICES[wanted] ? wanted : "plain";
    const out = path.join(outRoot, id);

    execFileSync(process.execPath, [
      path.join(ROOT, "pet/pack.mjs"),
      "--sheet", sheet,
      "--name", id,
      "--label", display,
      "--cell", `${cellW}x${cellH}`,
      "--crop", `${crop.x},${crop.y},${crop.w},${crop.h}`,
      "--cols", "8",
      "--rows", ROWS.join(","),
      "--resize", String(size),
      "--scale", String(scale),
      "--voice", picked,
      "--license", String(license ?? "unknown"),
      "--fps", Object.entries(FPS).map(([k, v]) => `${k}:${v}`).join(","),
      "--out", out,
    ], { stdio: "ignore" });

    const packFile = path.join(out, "pack.json");
    const pack = JSON.parse(fs.readFileSync(packFile, "utf8"));
    pack.expressions = Object.fromEntries(
      Object.entries(EXPRESSIONS).filter(([, anim]) => pack.animations[anim]?.length),
    );
    if (meta.description) pack.description = meta.description;
    pack.voice = picked;
    pack.source = source ?? sheetName;
    // where the art came from is part of the artefact, not a note in a chat log
    pack.atlas = { sheet: `${img.width}x${img.height}`, cell: `${cellW}x${cellH}`, rows, version: rows > ROWS.length ? 2 : 1 };
    fs.writeFileSync(packFile, JSON.stringify(pack, null, 2) + "\n");

    return {
      id,
      label: display,
      voice: picked,
      dir: out,
      rows,
      frames: Object.values(pack.animations).reduce((n, frames) => n + frames.length, 0),
    };
  } finally {
    if (!workDir) fs.rmSync(work, { recursive: true, force: true });
  }
}

/**
 * Install from a folder, a zip, a zip URL, or a git URL.
 *
 * Returns one summary per pet found — a community repo can hold several.
 */
export async function installPetSource(input, opts = {}) {
  const temp = opts.tempDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "bz-import-"));
  const cleanup = !opts.tempDir;
  try {
    let dir = String(input).replace(/^~/, process.env.HOME ?? "~");
    if (/^(https?:\/\/|git@)/.test(dir) && !/\.zip$/i.test(dir)) {
      execFileSync("/usr/bin/git", ["clone", "--depth", "1", "-q", dir, path.join(temp, "repo")], { stdio: "ignore" });
      dir = path.join(temp, "repo");
    } else if (/^https?:\/\//i.test(dir) || /\.zip$/i.test(dir)) {
      const file = path.join(temp, "pet.zip");
      if (/^https?:\/\//i.test(dir)) await download(dir, file);
      else fs.copyFileSync(dir, file);
      unzip(file, path.join(temp, "unzipped"));
      dir = path.join(temp, "unzipped");
    }

    const roots = [findPackageRoot(dir), ...findPackages(dir)].filter(Boolean);
    const unique = [...new Set(roots)];
    if (!unique.length) throw new Error(`no pet.json found in ${input}`);

    return unique.map((root) => installPetPackage(root, { ...opts, workDir: temp }));
  } finally {
    if (cleanup) fs.rmSync(temp, { recursive: true, force: true });
  }
}

// `node pet/pet-package.mjs <dir|zip|url>` — the same thing from the shell.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2);
  const arg = (name, fallback = null) => {
    const i = args.indexOf(`--${name}`);
    if (i === -1) return fallback;
    const v = args[i + 1];
    return v && !v.startsWith("--") ? v : true;
  };
  const withValue = new Set(["voice", "as", "out", "size", "scale"]);
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) { if (withValue.has(args[i].slice(2))) i++; continue; }
    positional.push(args[i]);
  }
  const input = positional[0];
  if (!input) {
    console.error("usage: node pet/pet-package.mjs <dir|zip|url> [--as <name>] [--voice <id>] [--size 112] [--scale 2] [--out <packs dir>]");
    process.exit(2);
  }
  const outRoot = String(arg("out", path.join(os.homedir(), ".opencode/pet/packs"))).replace(/^~/, process.env.HOME ?? "~");
  const results = await installPetSource(input, {
    outRoot,
    name: arg("as") && arg("as") !== true ? String(arg("as")) : null,
    voice: arg("voice") && arg("voice") !== true ? String(arg("voice")) : null,
    size: Number(arg("size", 112)),
    scale: Number(arg("scale", 2)),
    source: String(input),
    license: "OpenPets catalog — art belongs to its author",
  });
  for (const r of results) console.log(`${r.id}: ${r.label} voice=${r.voice} ${r.frames} frames → ${r.dir}`);
}
