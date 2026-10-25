// Sprite build orchestrator.
//
//   node pet/build.mjs master [--seed N] [--extra "prompt suffix"]
//   node pet/build.mjs locomotion [--force] [--strength 0.5]
//   node pet/build.mjs expressions [--only a,b,c] [--force] [--strength 0.5] [--batch 10]
//   node pet/build.mjs sheet
//   node pet/build.mjs process <raw.png> [--out <sprite.png>]
//
// Generation is resumable: an id whose sprite already exists is skipped unless
// --force. Every run is recorded in pet/manifest.json with its seed and the
// exact prompt, so any sprite can be reproduced byte-for-byte.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { decodePng, encodePng } from "./png.mjs";
import { pixelate, resizeBox, analyze } from "./pixelate.mjs";
import { EXPRESSIONS, byId } from "./expressions.mjs";
import { masterPrompt, expressionPrompt, locomotionPrompt, walkPrompt, sidePrompt, LOCOMOTION, seedFor } from "./prompts.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const RAW = path.join(ROOT, "assets/pet/raw");
const SPRITES = path.join(ROOT, "assets/pet/sprites");
const MANIFEST = path.join(HERE, "manifest.json");

const MODEL = process.env.BABYZILLA_PET_MODEL || "Runpod/FLUX.2-klein-4B-mflux-4bit";
const BASE_MODEL = process.env.BABYZILLA_PET_BASE_MODEL || "flux2-klein-4b";
const SIZE = Number(process.env.BABYZILLA_PET_SIZE || 64);
const W = Number(process.env.BABYZILLA_PET_WIDTH || 512);

const args = process.argv.slice(2);
const cmd = args[0];
const flag = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = args[i + 1];
  return v && !v.startsWith("--") ? v : true;
};
const has = (name) => args.includes(`--${name}`);

for (const dir of [RAW, SPRITES]) fs.mkdirSync(dir, { recursive: true });

const manifest = fs.existsSync(MANIFEST) ? JSON.parse(fs.readFileSync(MANIFEST, "utf8")) : { model: MODEL, size: SIZE, items: {} };
const saveManifest = () => fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");

function runMflux({ prompt, out, seed, ref = null, strength = 0.45 }) {
  const a = [
    "--model", MODEL,
    "--base-model", BASE_MODEL,
    "--steps", String(seed ? 4 : 4),
    "--width", String(W),
    "--height", String(W),
    "--seed", String(seed),
    "--prompt", `${prompt}. No text, no watermark, single character only, full body, no gradient background.`,
    "--output", out,
  ];
  if (ref) a.push("--image-path", ref, "--image-strength", String(strength));
  return new Promise((resolve, reject) => {
    const child = spawn("mflux-generate-flux2", a, { stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    child.stderr.on("data", (d) => { err += d.toString(); if (err.length > 8000) err = err.slice(-8000); });
    child.stdout.on("data", (d) => { err += d.toString(); if (err.length > 8000) err = err.slice(-8000); });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0) return reject(new Error(`mflux exited ${code}\n${err.slice(-1500)}`));
      if (!fs.existsSync(out)) return reject(new Error(`mflux produced no file at ${out}\n${err.slice(-800)}`));
      resolve();
    });
  });
}

function processSprite(rawPath, outPath) {
  const img = decodePng(fs.readFileSync(rawPath));
  const { img: sprite, stats } = pixelate(img, { size: SIZE, outline: true });
  fs.writeFileSync(outPath, encodePng(sprite.width, sprite.height, sprite.data));
  return stats;
}

async function generate({ id, prompt, seed, ref, strength, force }) {
  const rawPath = path.join(RAW, `${id}.png`);
  const spritePath = path.join(SPRITES, `${id}.png`);
  if (!force && fs.existsSync(spritePath) && fs.existsSync(rawPath)) {
    process.stdout.write(`  · ${id} (cached)\n`);
    return { cached: true };
  }
  const t0 = Date.now();
  await runMflux({ prompt, out: rawPath, seed, ref, strength });
  const stats = processSprite(rawPath, spritePath);
  const ms = Date.now() - t0;
  manifest.items[id] = {
    seed, prompt, ref: ref ? path.relative(ROOT, ref) : null, strength: ref ? strength : null,
    raw: path.relative(ROOT, rawPath), sprite: path.relative(ROOT, spritePath),
    stats, ms, at: new Date().toISOString(),
  };
  saveManifest();
  process.stdout.write(`  ✓ ${id}  ${(ms / 1000).toFixed(1)}s  ${stats.colors} colours  ${stats.opaquePct}% ink\n`);
  return { stats, ms };
}

/** One retry, then keep going: a single bad roll must not kill a 100-image batch. */
const failures = [];
async function attempt(job) {
  for (let i = 0; i < 2; i++) {
    try {
      return await generate(job);
    } catch (e) {
      if (i === 0) { process.stdout.write(`  ~ ${job.id} retry (${String(e.message).split("\n")[0]})\n`); continue; }
      failures.push({ id: job.id, error: String(e.message).split("\n")[0] });
      process.stdout.write(`  ✗ ${job.id} FAILED\n`);
    }
  }
}

async function main() {
  if (cmd === "master") {
    const seed = Number(flag("seed") ?? seedFor("master"));
    const extra = flag("extra");
    const prompt = masterPrompt() + (extra && extra !== true ? `, ${extra}` : "");
    const rawPath = path.join(RAW, "master.png");
    const spritePath = path.join(SPRITES, "master.png");
    await runMflux({ prompt, out: rawPath, seed });
    const stats = processSprite(rawPath, spritePath);
    manifest.master = { seed, prompt, stats, at: new Date().toISOString() };
    saveManifest();
    console.log(`master → ${path.relative(ROOT, spritePath)}  ${stats.colors} colours  ${stats.opaquePct}% ink`);
    return;
  }

  if (cmd === "process") {
    const file = args[1];
    const out = flag("out") || file.replace(/\.png$/, `-${SIZE}.png`);
    const stats = processSprite(file, out);
    console.log(JSON.stringify(stats, null, 1));
    return;
  }

  if (cmd === "locomotion") {
    // No reference image: the reference is exactly what pins the legs. Same
    // seed as the master keeps the character design stable while the pose moves.
    const force = has("force");
    const seed = manifest.master?.seed ?? 7;
    const only = flag("only");
    const filter = only && only !== true ? new Set(String(only).split(",")) : null;
    const master = path.join(RAW, "master.png");
    for (const frame of LOCOMOTION) {
      if (filter && !filter.has(frame.id) && !filter.has(`loco-${frame.id}`)) continue;
      if (frame.side) {
        await attempt({ id: `loco-${frame.id}`, prompt: sidePrompt(frame.delta), seed, ref: null, strength: null, force });
      } else if (frame.walk) {
        // condition on the master: same character, different legs
        await attempt({ id: `loco-${frame.id}`, prompt: walkPrompt(frame.delta), seed, ref: master, strength: 0.55, force });
      } else {
        await attempt({ id: `loco-${frame.id}`, prompt: locomotionPrompt(frame.delta), seed, ref: null, strength: null, force });
      }
    }
    return;
  }

  if (cmd === "expressions") {
    const ref = path.join(RAW, "master.png");
    const strength = Number(flag("strength") ?? 0.45);
    const force = has("force");
    const only = flag("only");
    const batch = Number(flag("batch") ?? 0);
    let list = EXPRESSIONS;
    if (only && only !== true) {
      const ids = String(only).split(",").map((s) => s.trim());
      list = ids.map((id) => {
        const e = byId[id];
        if (!e) throw new Error(`unknown expression id: ${id}`);
        return e;
      });
    }
    if (batch) {
      const from = Number(flag("from") ?? 0);
      list = list.slice(from, from + batch);
    }
    console.log(`${list.length} expression(s), ref=master.png, strength=${strength}`);
    for (const e of list) {
      await attempt({ id: e.id, prompt: expressionPrompt(e.delta), seed: seedFor(e.id), ref, strength, force });
    }
    return;
  }

  if (cmd === "reprocess") {
    // Re-run the pixelation pipeline over existing raws: no generation, so
    // palette/shadow/outline changes can be applied to the whole set cheaply.
    const raws = fs.readdirSync(RAW).filter((f) => f.endsWith(".png") && !f.startsWith("_"));
    const only = flag("only");
    const filter = only && only !== true ? new Set(String(only).split(",")) : null;
    let n = 0;
    for (const file of raws) {
      const id = file.replace(/\.png$/, "");
      if (filter && !filter.has(id) && !filter.has(`loco-${id}`)) continue;
      const stats = processSprite(path.join(RAW, file), path.join(SPRITES, file));
      n++;
      if (stats.colors > 16 || !stats.borderClean) process.stdout.write(`  ! ${id}: ${stats.colors} colours, border ${stats.borderClean ? "ok" : "dirty"}\n`);
    }
    console.log(`reprocessed ${n} sprite(s)`);
    return;
  }

  if (cmd === "data") {
    // What the app needs at runtime: ids, motion class, speech lines.
    const out = path.join(ROOT, "assets/pet/pet-data.json");
    const payload = {
      size: SIZE,
      expressions: EXPRESSIONS.map((e) => ({ id: e.id, label: e.label, cat: e.cat, motion: e.motion, lines: e.lines })),
    };
    fs.writeFileSync(out, JSON.stringify(payload, null, 2) + "\n");
    // A file:// page cannot fetch() its own data, so the gallery gets a script.
    fs.writeFileSync(path.join(ROOT, "assets/pet/gallery-data.js"),
      `// generated by pet/build.mjs — do not edit\nwindow.PET_DATA = ${JSON.stringify(payload)};\n`);
    const missing = EXPRESSIONS.filter((e) => !fs.existsSync(path.join(SPRITES, `${e.id}.png`)));
    console.log(`pet-data.json: ${EXPRESSIONS.length} expressions, ${missing.length} sprites still missing`);
    return;
  }

  if (cmd === "sheet") {
    await makeSheet();
    return;
  }

  console.log(`usage:
  node pet/build.mjs master [--seed N] [--extra "..."]
  node pet/build.mjs locomotion [--force] [--strength 0.5]
  node pet/build.mjs expressions [--only a,b] [--force] [--strength 0.45] [--batch 10] [--from N]
  node pet/build.mjs data
  node pet/build.mjs sheet
  node pet/build.mjs process <raw.png> [--out out.png]`);
}

/** Contact sheet: every processed sprite on one labelled grid, 4× scale. */
async function makeSheet() {
  const SCALE = 4;
  const COLS = 10;
  const files = fs.readdirSync(SPRITES).filter((f) => f.endsWith(".png") && !f.startsWith("_")).sort();
  if (!files.length) throw new Error("no sprites yet");
  const cell = SIZE * SCALE + 8;
  const rows = Math.ceil(files.length / COLS);
  const width = COLS * cell;
  const height = rows * cell;
  const canvas = { width, height, data: Buffer.alloc(width * height * 4) };
  // checkerboard background so transparency is obvious
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dark = (Math.floor(x / 8) + Math.floor(y / 8)) % 2 === 0;
      const i = (y * width + x) * 4;
      const v = dark ? 44 : 58;
      canvas.data[i] = v; canvas.data[i + 1] = v + 2; canvas.data[i + 2] = v + 8; canvas.data[i + 3] = 255;
    }
  }
  files.forEach((file, n) => {
    const img = decodePng(fs.readFileSync(path.join(SPRITES, file)));
    const big = resizeBox(img, SIZE * SCALE, SIZE * SCALE);
    const cx = (n % COLS) * cell + 4;
    const cy = Math.floor(n / COLS) * cell + 4;
    for (let y = 0; y < big.height; y++) {
      for (let x = 0; x < big.width; x++) {
        const s = (y * big.width + x) * 4;
        if (!big.data[s + 3]) continue;
        const d = ((cy + y) * width + (cx + x)) * 4;
        canvas.data[d] = big.data[s];
        canvas.data[d + 1] = big.data[s + 1];
        canvas.data[d + 2] = big.data[s + 2];
        canvas.data[d + 3] = 255;
      }
    }
  });
  const out = path.join(ROOT, "assets/pet/sheets/contact.png");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, encodePng(width, height, canvas.data));
  console.log(`${files.length} sprites → ${path.relative(ROOT, out)} (${width}×${height})`);
  // report anything that would look wrong in the app
  for (const file of files) {
    const img = decodePng(fs.readFileSync(path.join(SPRITES, file)));
    const s = analyze(img);
    if (s.colors > 16 || !s.borderClean) console.log(`  ! ${file}: ${s.colors} colours, border ${s.borderClean ? "ok" : "touches edge"}`);
  }
}

main()
  .then(() => {
    if (failures.length) {
      console.log(`\n${failures.length} failed:`);
      for (const f of failures) console.log(`  ${f.id}: ${f.error}`);
      process.exitCode = 1;
    }
  })
  .catch((e) => {
    console.error(e?.stack ?? e?.message ?? e);
    process.exit(1);
  });
