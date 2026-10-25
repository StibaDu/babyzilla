// Import OpenPet-style pet folders as BabyZilla packs.
//
//   node pet/import-openpet.mjs --repo ~/src/openpet-ai-girls
//   node pet/import-openpet.mjs --repo https://github.com/AwesomeHou/openpet-ai-girls.git
//
// Each folder that holds a `pet.json` and a spritesheet becomes one pack in
// `~/.opencode/pet/packs/<id>`, and each gets its own *voice*: the dino is the
// only caveman in the house.
//
// The atlas is the OpenPet / Codex convention: 8 columns, 9 rows, one animation
// per row, in this order. Cells may be non-square, and the character is cropped
// from the union of its own opaque pixels so no frame is cut.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { decodePng } from "./png.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const args = process.argv.slice(2);
const arg = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = args[i + 1];
  return v && !v.startsWith("--") ? v : true;
};

const repoArg = arg("repo");
if (!repoArg) {
  console.error("usage: node pet/import-openpet.mjs --repo <dir|git-url> [--out <packs dir>] [--size 112] [--scale 2]");
  process.exit(2);
}

const outRoot = path.resolve(String(arg("out", path.join(os.homedir(), ".opencode/pet/packs"))).replace(/^~/, process.env.HOME));
const size = Number(arg("size", 112));
const scale = Number(arg("scale", 2));

/** The nine rows an OpenPet/Codex atlas carries, top to bottom. */
const ROWS = ["idle", "walk", "walkleft", "wave", "jump", "sad", "wait", "run", "review"];
const FPS = { idle: 6, walk: 12, walkleft: 12, wave: 8, jump: 12, sad: 6, wait: 6, run: 14, review: 4 };

/**
 * Where each of the 100 expression ids lands in a nine-animation atlas. A face
 * is not available here, so the closest *body* reading is used instead.
 */
const EXPRESSIONS = {
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

/** Characters this repo ships, and the voice each one speaks with. */
const voicesFor = {
  deepseek: "deepseek",
  doubao: "doubao",
  gemini: "gemini",
  chatgpt: "chatgpt",
  claude: "claude",
};

/** A repo URL is cloned once into a temp dir; a path is used as-is. */
function resolveRepo(given) {
  const looksRemote = /^(https?:|git@)/.test(given) || /\.git$/.test(given);
  if (!looksRemote) return { dir: path.resolve(given), temp: null };
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "bz-openpet-"));
  execFileSync("git", ["clone", "--depth", "1", "-q", given, temp], { stdio: "inherit" });
  return { dir: temp, temp };
}

/** Union of the opaque pixels across the whole sheet, clamped to one cell. */
function characterCrop(sheet, cellW, cellH) {
  let x0 = cellW, y0 = cellH, x1 = 0, y1 = 0;
  for (let y = 0; y < sheet.height; y++) {
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
  if (x1 <= x0 || y1 <= y0) return { x: 0, y: 0, w: cellW, h: cellH };
  const pad = 2;
  const x = Math.max(0, x0 - pad);
  const y = Math.max(0, y0 - pad);
  return {
    x, y,
    w: Math.min(cellW - x, x1 - x0 + 1 + pad * 2),
    h: Math.min(cellH - y, y1 - y0 + 1 + pad * 2),
  };
}

const { dir, temp } = resolveRepo(String(repoArg));
try {
  const pets = fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => path.join(dir, e.name))
    .filter((d) => fs.existsSync(path.join(d, "pet.json")));

  if (!pets.length) {
    console.error(`no pet.json folders in ${dir}`);
    process.exit(1);
  }

  const built = [];
  for (const petDir of pets) {
    const meta = JSON.parse(fs.readFileSync(path.join(petDir, "pet.json"), "utf8"));
    const id = String(meta.id ?? path.basename(petDir));
    const label = String(meta.displayName ?? id);
    const sheet = path.join(petDir, String(meta.spritesheetPath ?? "spritesheet.webp"));
    if (!fs.existsSync(sheet)) {
      console.error(`skip ${id}: no spritesheet at ${sheet}`);
      continue;
    }

    // the atlas convention: 8 columns, 9 rows
    const png = path.join(os.tmpdir(), `bz-${id}-${process.pid}.png`);
    execFileSync("/usr/bin/sips", ["-s", "format", "png", sheet, "--out", png], { stdio: "ignore" });
    const img = decodePng(fs.readFileSync(png));
    fs.rmSync(png, { force: true });
    const cellW = Math.floor(img.width / 8);
    const cellH = Math.floor(img.height / 9);
    const crop = characterCrop(img, cellW, cellH);

    execFileSync(process.execPath, [
      path.join(ROOT, "pet/pack.mjs"),
      "--sheet", sheet,
      "--name", id,
      "--label", label,
      "--cell", `${cellW}x${cellH}`,
      "--crop", `${crop.x},${crop.y},${crop.w},${crop.h}`,
      "--cols", "8",
      "--rows", ROWS.join(","),
      "--resize", String(size),
      "--scale", String(scale),
      "--voice", id in voicesFor ? voicesFor[id] : "plain",
      "--license", String(arg("license", "OpenPet AI Girls (AwesomeHou/openpet-ai-girls) — personal use per its README")),
      "--fps", Object.entries(FPS).map(([k, v]) => `${k}:${v}`).join(","),
      "--out", path.join(outRoot, id),
    ], { stdio: "inherit" });

    // faces are not in this atlas: point every expression at the body that reads
    // closest, so a pet still reacts instead of freezing on idle
    const packFile = path.join(outRoot, id, "pack.json");
    const pack = JSON.parse(fs.readFileSync(packFile, "utf8"));
    const usable = Object.fromEntries(Object.entries(EXPRESSIONS).filter(([, anim]) => pack.animations[anim]?.length));
    pack.expressions = usable;
    pack.description = meta.description;
    pack.voice = id in voicesFor ? voicesFor[id] : "plain";
    fs.writeFileSync(packFile, JSON.stringify(pack, null, 2) + "\n");

    built.push({ id, label, voice: pack.voice, frames: Object.values(pack.animations).reduce((n, f) => n + f.length, 0) });
  }

  for (const p of built) {
    console.log(`  ${p.id.padEnd(10)} ${p.label.padEnd(10)} voice=${p.voice.padEnd(9)} ${p.frames} frames → ${path.join(outRoot, p.id)}`);
  }
  console.log(`${built.length} pets installed. Switch with: babyzilla pet use <id>`);
} finally {
  if (temp) fs.rmSync(temp, { recursive: true, force: true });
}
