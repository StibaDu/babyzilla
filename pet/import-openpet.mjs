// Import a whole folder of pet packages as BabyZilla packs.
//
//   node pet/import-openpet.mjs --repo ~/src/openpet-ai-girls
//   node pet/import-openpet.mjs --repo https://github.com/AwesomeHou/openpet-ai-girls.git
//
// Each subfolder with a `pet.json` becomes one pack in
// `~/.opencode/pet/packs/<id>`, and each gets its own voice: the dino is the only
// caveman in the house. Everything about building one pack lives in
// `pet/pet-package.mjs`, so this file is just the loop and the cast list.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { findPackages, installPetPackage } from "./pet-package.mjs";

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

const outRoot = String(arg("out", path.join(os.homedir(), ".opencode/pet/packs"))).replace(/^~/, process.env.HOME);
const size = Number(arg("size", 112));
const scale = Number(arg("scale", 2));
const license = String(arg("license", "OpenPet AI Girls (AwesomeHou/openpet-ai-girls) — personal use per its README"));

/** Characters this repo ships, and the voice each one speaks with. */
const voicesFor = {
  deepseek: "deepseek",
  doubao: "doubao",
  gemini: "gemini",
  chatgpt: "chatgpt",
  claude: "claude",
};

const remote = /^(https?:|git@)/.test(String(repoArg)) || /\.git$/.test(String(repoArg));
const temp = remote ? fs.mkdtempSync(path.join(os.tmpdir(), "bz-openpet-")) : null;
try {
  const dir = remote ? temp : path.resolve(String(repoArg));
  if (remote) execFileSync("git", ["clone", "--depth", "1", "-q", String(repoArg), dir], { stdio: "inherit" });

  const packages = findPackages(dir);
  if (!packages.length) {
    console.error(`no pet.json folders in ${dir}`);
    process.exit(1);
  }

  const built = [];
  for (const pkg of packages) {
    const meta = JSON.parse(fs.readFileSync(path.join(pkg, "pet.json"), "utf8"));
    const id = String(meta.id ?? path.basename(pkg));
    try {
      built.push(installPetPackage(pkg, {
        outRoot,
        size,
        scale,
        voice: voicesFor[id] ?? null,
        source: String(repoArg),
        license,
      }));
    } catch (error) {
      console.error(`skip ${id}: ${error.message}`);
    }
  }

  for (const p of built) {
    console.log(`  ${p.id.padEnd(10)} ${p.label.padEnd(10)} voice=${p.voice.padEnd(9)} ${p.frames} frames → ${p.dir}`);
  }
  console.log(`${built.length} pets installed. Switch with: babyzilla pet use <id>`);
} finally {
  if (temp) fs.rmSync(temp, { recursive: true, force: true });
}
