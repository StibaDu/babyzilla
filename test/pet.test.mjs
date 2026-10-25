// The pet is data-driven, so most of it can be verified without a desktop:
// the expression catalogue, the signal mapping, the event bridge, the CLI, and
// the sprites themselves.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { EXPRESSIONS, byId, CATEGORIES } from "../pet/expressions.mjs";
import {
  TOOL_EXPRESSION, toolExpression, outcomeExpression, compactionExpression,
  budgetExpression, updateExpression, errorExpression, sessionSummary,
} from "../lib/pet-map.mjs";
import { decodePng } from "../pet/png.mjs";
import { analyze } from "../pet/pixelate.mjs";

const run = promisify(execFile);
const BIN = fileURLToPath(new URL("../bin/babyzilla.mjs", import.meta.url));
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SPRITES = path.join(ROOT, "assets/pet/sprites");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "bz-pet-"));

const MOTIONS = new Set(["bob", "pop", "shake", "float", "still"]);

test("catalogue: 100 unique, well-formed expressions", () => {
  assert.equal(EXPRESSIONS.length, 100);
  assert.equal(new Set(EXPRESSIONS.map((e) => e.id)).size, 100);
  for (const e of EXPRESSIONS) {
    assert.match(e.id, /^[a-z0-9-]+$/, `${e.id} is kebab-case`);
    assert.ok(e.label?.length, `${e.id} has a label`);
    assert.ok(CATEGORIES.includes(e.cat), `${e.id} has a known category`);
    assert.ok(MOTIONS.has(e.motion), `${e.id} motion ${e.motion}`);
    assert.ok(e.delta.length > 12, `${e.id} has a usable art delta`);
    for (const line of e.lines) {
      assert.ok(line.length <= 90, `${e.id} line fits a 3-line bubble: ${line}`);
    }
  }
  // every category is populated
  for (const cat of CATEGORIES) {
    assert.ok(EXPRESSIONS.some((e) => e.cat === cat), `${cat} has expressions`);
  }
});

test("mapping: every referenced expression exists", () => {
  const ids = new Set(EXPRESSIONS.map((e) => e.id));
  for (const [tool, expr] of Object.entries(TOOL_EXPRESSION)) {
    assert.ok(ids.has(expr), `${tool} -> ${expr}`);
  }
  const samples = [
    toolExpression("read"), toolExpression("bash", { command: "git push" }),
    toolExpression("bash", { command: "node --test test/" }), toolExpression("task"),
    toolExpression("unknown-tool"),
  ];
  for (const id of samples) assert.ok(byId[id], id);
  for (const o of [outcomeExpression({ name: "bash", ok: false }), outcomeExpression({ name: "bash", ok: true })]) {
    if (o) assert.ok(byId[o.id], o.id);
  }
  for (const phase of ["start", "end"]) {
    const c = compactionExpression(phase);
    assert.ok(c && byId[c.id], phase);
  }
  assert.ok(byId[budgetExpression(96).id]);
  assert.ok(byId[budgetExpression(82).id]);
  assert.equal(budgetExpression(40), null);
  const u = updateExpression("9.9.9", "0.14.0");
  assert.equal(u.id, "update-available");
  assert.match(u.say, /9\.9\.9/);
  assert.equal(errorExpression("429 Too Many Requests").id, "rate-limited");
  assert.equal(errorExpression("fetch failed").id, "offline");
});

test("mapping: tool names are classified, not dumped raw", () => {
  assert.equal(toolExpression("read"), "tool-read");
  assert.equal(toolExpression("bash", { command: "git push origin main" }), "ship-it");
  assert.equal(toolExpression("bash", { command: "node --test" }), "determined");
  assert.equal(toolExpression("bash", { command: "babyzilla stats" }), "self-tune");
  assert.equal(toolExpression("task"), "subagent-wait");
  assert.equal(toolExpression("nonsense"), "typing");
  assert.equal(outcomeExpression({ name: "bash", ok: false }).id, "shell-fail");
  assert.equal(outcomeExpression({ name: "read", ok: true }), null, "silent success");
  assert.equal(outcomeExpression({ name: "bash", ok: true, ms: 60_000 }).id, "celebrate");
  assert.match(sessionSummary({ savedTokens: 12_000, tools: 9 }), /12k/);
  assert.equal(sessionSummary({ savedTokens: 10 }), null);
});

test("bridge: appends valid JSONL, rotates, and never throws", async () => {
  const dir = tmp();
  process.env.BABYZILLA_PET_STATE = dir;
  const pet = await import(`../lib/pet.mjs?bridge=${Date.now()}`);
  const events = path.join(dir, "events.jsonl");

  assert.equal(pet.expr("wave", 1.5), true);
  pet.say("hello");
  pet.busy(true);
  const lines = fs.readFileSync(events, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.length, 3);
  assert.deepEqual({ kind: lines[0].kind, id: lines[0].id, hold: lines[0].hold }, { kind: "expr", id: "wave", hold: 1.5 });
  assert.equal(lines[1].text, "hello");
  assert.equal(lines[2].on, true);
  assert.ok(lines.every((l) => typeof l.t === "number"));

  // rotation keeps the file from growing forever
  fs.writeFileSync(events, "x".repeat(600 * 1024));
  pet.expr("idle");
  assert.ok(fs.existsSync(`${events}.1`), "rotated");
  assert.ok(fs.statSync(events).size < 1024, "fresh file after rotation");

  // a bad state dir must not throw into a hook
  process.env.BABYZILLA_PET_STATE = "/dev/null/nope";
  assert.doesNotThrow(() => pet.expr("idle"));
  process.env.BABYZILLA_PET_STATE = dir;
});

test("cli: pet list, emit and status", async () => {
  const dir = tmp();
  const env = { ...process.env, BABYZILLA_PET_STATE: dir, BABYZILLA_NO_UPDATE_CHECK: "1" };

  const list = await run(process.execPath, [BIN, "pet", "list"], { env });
  assert.equal((list.stdout.match(/^ {2}[a-z0-9-]+ {2,}/gm) ?? []).length, 100);
  assert.match(list.stdout, /100 expressions/);

  const emit = await run(process.execPath, [BIN, "pet", "emit", "party", "--say", "ship it"], { env });
  assert.match(emit.stdout, /emitted party/);
  const lines = fs.readFileSync(path.join(dir, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines[0].id, "party");
  assert.equal(lines[1].text, "ship it");

  const status = await run(process.execPath, [BIN, "pet", "status"], { env });
  assert.match(status.stdout, /BabyZilla pet/);
  assert.match(status.stdout, /events\s+/);

  await assert.rejects(run(process.execPath, [BIN, "pet", "emit", "not-a-real-face"], { env }), (e) => e.code === 2);
});

test("sprites: 64×64, palette-locked, transparent border, shared baseline", (t) => {
  const files = fs.existsSync(SPRITES)
    ? fs.readdirSync(SPRITES).filter((f) => f.endsWith(".png") && !f.startsWith("_")) : [];
  if (files.length < 10) return t.skip(`only ${files.length} sprites built yet`);

  const baselines = new Set();
  for (const file of files) {
    const img = decodePng(fs.readFileSync(path.join(SPRITES, file)));
    const s = analyze(img);
    assert.equal(img.width, 64, `${file} width`);
    assert.equal(img.height, 64, `${file} height`);
    assert.ok(s.colors <= 16, `${file} uses ${s.colors} colours`);
    assert.ok(s.borderClean, `${file} has ink on the border`);
    assert.ok(s.opaquePct > 12 && s.opaquePct < 80, `${file} covers ${s.opaquePct}%`);
    baselines.add(s.bbox.y1);
  }
  // every sprite stands on the same line, so the pet does not jitter
  assert.ok(baselines.size <= 2, `baselines drift: ${[...baselines].join(", ")}`);
});

test("cli: status reports a running pet (pgrep is wired, not swallowed)", async (t) => {
  if (process.platform === "win32") return t.skip("pgrep is macOS/POSIX only");
  // A decoy process whose argv contains the app name: status must name its pid.
  // This regressed once because `execFileSync` was used but never imported and
  // the resulting ReferenceError was swallowed by a bare `catch`, which made
  // status say "not running" forever and made install skip killing stale pets.
  const decoy = spawn("bash", ["-c", "exec -a BabyZillaPet-fake sleep 10"], { stdio: "ignore" });
  t.after(() => { try { decoy.kill(); } catch {} });
  const env = { ...process.env, BABYZILLA_PET_STATE: tmp(), BABYZILLA_NO_UPDATE_CHECK: "1" };

  let out = "";
  for (let i = 0; i < 20; i++) {
    out = (await run(process.execPath, [BIN, "pet", "status"], { env })).stdout;
    if (out.includes(String(decoy.pid))) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.match(out, /app\s+running \(pid [\d, ]+\)/, out);
  assert.ok(out.includes(String(decoy.pid)), `status names the running pid:\n${out}`);
});

test("install: copies sprites, data and gallery into the state dir", async (t) => {
  const sprites = fs.existsSync(SPRITES) ? fs.readdirSync(SPRITES).filter((f) => f.endsWith(".png") && !f.startsWith("_")) : [];
  if (!sprites.length) return t.skip("no sprites built yet");
  const dir = tmp();
  const env = { ...process.env, BABYZILLA_PET_STATE: dir, BABYZILLA_NO_UPDATE_CHECK: "1" };
  const res = await run(process.execPath, [BIN, "pet", "install", "--no-build", "--no-start"], { env });
  assert.match(res.stdout, /installed/);
  const installed = fs.readdirSync(path.join(dir, "sprites")).filter((f) => f.endsWith(".png"));
  assert.equal(installed.length, sprites.length, "every built sprite is installed");
  const data = JSON.parse(fs.readFileSync(path.join(dir, "pet-data.json"), "utf8"));
  assert.equal(data.expressions.length, 100);
  for (const asset of ["gallery.html", "gallery.css", "gallery-data.js"]) {
    assert.ok(fs.existsSync(path.join(dir, asset)), `${asset} installed`);
  }
  // the gallery must not depend on fetch(), which file:// blocks
  assert.ok(!fs.readFileSync(path.join(dir, "gallery.html"), "utf8").includes("fetch("));
  assert.ok(fs.readFileSync(path.join(dir, "gallery-data.js"), "utf8").includes("window.PET_DATA"));
});

test("install: never kills a pet that belongs to another state dir", async (t) => {
  if (process.platform === "win32") return t.skip("posix signals");
  // Regression: install used to `pkill -f BabyZillaPet`, so running the test
  // suite killed the pet the user was actually looking at.
  const decoy = spawn("bash", ["-c", "exec -a BabyZillaPet-fake sleep 10"], { stdio: "ignore" });
  t.after(() => { try { decoy.kill(); } catch {} });
  await new Promise((r) => setTimeout(r, 200));
  const env = { ...process.env, BABYZILLA_PET_STATE: tmp(), BABYZILLA_NO_UPDATE_CHECK: "1" };
  await run(process.execPath, [BIN, "pet", "install", "--no-build", "--no-start"], { env });
  assert.doesNotThrow(() => process.kill(decoy.pid, 0), "the pet in the other state dir is still alive");
});

test("data file: matches the catalogue", (t) => {
  const file = path.join(ROOT, "assets/pet/pet-data.json");
  if (!fs.existsSync(file)) return t.skip("pet-data.json not built");
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(data.expressions.length, 100);
  assert.equal(data.size, 64);
  for (const e of data.expressions) {
    assert.ok(byId[e.id], `${e.id} in catalogue`);
    assert.ok(MOTIONS.has(e.motion));
  }
});
