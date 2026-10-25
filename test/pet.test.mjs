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
import { caveman, gist, latestThought, readMood, thought, voice } from "../lib/pet-thought.mjs";
import {
  TOOL_EXPRESSION, toolExpression, outcomeExpression, compactionExpression,
  budgetExpression, updateExpression, errorExpression, sessionSummary,
} from "../lib/pet-map.mjs";
import { decodePng, encodePng } from "../pet/png.mjs";
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

test("thoughts: the dino says what it makes of its human, in caveman", () => {
  // the sentence about the human wins over the sentence about the code
  assert.equal(
    gist("I need to check the parser. The user keeps asking for a smaller bubble."),
    "Human keep ask for smaller bubble",
  );
  assert.equal(gist("The user wants me to make the pet talk. I'll add a bubble next."), "Human want me make pet talk");
  assert.equal(gist("The cache is stale. The human asked for this twice already."), "Human ask for this twice already");
  // with nothing about the human, it is still one blunt line about the work
  assert.equal(gist("The tests are failing because the cache is stale."), "Test fail because cache stale");
  // emoji the bubble font cannot draw never reach it
  assert.equal(gist("Fix the 🐛 bug in the parser"), "Fix bug in parser");
  // verbatim is still there for the raw quote
  assert.equal(
    gist("The tests are failing because the cache is stale.", { style: "verbatim" }),
    "The tests are failing because the cache is stale",
  );
  // long lines break on a word and admit the cut
  const long = gist("The quick brown fox jumps over the lazy dog and then keeps running past the fence into the field beyond", { max: 40 });
  assert.ok(long.length <= 40, `clipped to ${long.length}: ${long}`);
  assert.match(long, /…$/);
  assert.ok(!/\s…$/.test(long), "no dangling space before the ellipsis");
  // nothing worth saying
  assert.equal(gist("```\nonly code\n```"), null);
  assert.equal(gist("   "), null);
  assert.equal(gist(null), null);
  assert.equal(gist("Sure."), null);
});

test("thoughts: caveman mechanics, including what it must not eat", () => {
  assert.equal(caveman("I should read the parser before the pack"), "me read parser before pack");
  assert.equal(caveman("It is not working yet, but I found the reason"), "not work yet, but me found reason");
  // the human is the subject, not "they"
  assert.equal(caveman("They asked for this twice"), "human ask for this twice");
  // "do" is a real verb, not only an auxiliary
  assert.equal(caveman("Then I do it"), "me do");
  // unknown verbs are left as written rather than mangled ("retir", "stor")
  assert.equal(caveman("The retired mark was stored in config.json"), "retire mark store in config.json");
  assert.equal(caveman("the a an"), "the a an");
});

test("thoughts: the mood is read off the words, never invented", () => {
  let said = thought("The parser is broken again and the user asked twice already.");
  assert.equal(said.mood, "angry");
  // the content is still the model's sentence, reduced...
  assert.match(said.text, /Parser broken again and human ask twice already/);
  // ...and only the aside is the pet's, taken from that mood's own pool
  assert.ok([...voice.angry.open, ...voice.angry.close].includes(said.aside), said.aside);

  assert.equal(readMood("The parser is broken again"), "angry");
  assert.equal(readMood("The user keeps asking for a smaller bubble"), "bored");
  assert.equal(readMood("Hmm, the cache is stale"), "confused");
  assert.equal(readMood("The tests pass now"), "smug");
  assert.equal(readMood("The user wants a bigger pet"), "tease");
  // no evidence, no mood: the dino does not perform feelings it cannot back up
  assert.equal(readMood("I should read the code first"), null);
  said = thought("I should read the code first.", { random: () => 0.5 });
  assert.equal(said.mood, null);
  // ...but it still has a voice: a neutral aside, never a made-up feeling
  assert.ok([...voice.flat.open, ...voice.flat.close].includes(said.aside), said.aside);
  assert.match(said.text, /Me read code first/);
});

test("thoughts: asides lead as well as trail, and never stack on a grunt", () => {
  const moods = {
    angry: "The parser is broken again and the user asked twice.",
    bored: "The user keeps asking for a smaller bubble again.",
    confused: "Hmm, wait, the cache is stale.",
    smug: "The tests pass now.",
    tease: "The user wants a bigger pet.",
    flat: "I should read the code first.",
  };
  const lead = [];
  const trail = [];
  for (const [mood, sentence] of Object.entries(moods)) {
    // fixed rolls: this test is about placement, not about the two rare paths
    const said = thought(sentence, { random: () => 0.5 });
    const where = said.text.startsWith(`${said.aside} `) ? "lead" : "trail";
    if (where === "lead") lead.push(mood); else trail.push(mood);
    // placement is one axis, mood is the other: a leading aside must be an opener
    if (where === "lead") assert.ok(voice[mood].open.includes(said.aside), said.aside);
    else assert.ok(voice[mood].close.includes(said.aside), said.aside);
    // and the thought itself is never swallowed by its own attitude
    assert.ok(said.text.length <= 95, `${said.text.length}: ${said.text}`);
  }
  assert.ok(lead.length > 0 && trail.length > 0, `all one placement: ${lead}/${trail}`);
  // a sentence that already opens with a grunt never gets a second one in front
  const grunt = thought("Hmm, wait, the cache is stale.", { random: () => 0.5 });
  assert.ok(voice.confused.close.includes(grunt.aside), grunt.aside);
  // every aside fits a bubble on its own
  for (const [mood, pool] of Object.entries(voice)) {
    for (const line of [...pool.open, ...pool.close]) {
      assert.ok(line.length <= 34, `${mood}: ${line}`);
      assert.match(line, /[.!?]$/, `${mood}: ${line}`);
    }
    assert.equal(new Set([...pool.open, ...pool.close]).size, pool.open.length + pool.close.length, `${mood}: duplicate aside`);
  }
});

test("thoughts: Rawr is rare, the aside cannot be clipped away, and some lines stay bare", () => {
  // deterministic by default: same sentence, same answer, so nothing flakes
  const a = thought("Hmm, the cache is stale.");
  assert.equal(a.text, thought("Hmm, the cache is stale.").text);
  // a caller may force the roar (which is the only randomness there is)
  assert.equal(thought("Hmm, the cache is stale.", { random: () => 0.001 }).text, "Rawr! Hmm cache stale");
  assert.equal(thought("Hmm, the cache is stale.", { random: () => 0.9 }).rawr, false);
  // one thought in nine says nothing extra, so the voice does not become a formula
  const rolls = [0.9, 0.01];
  const bare = thought("Hmm, the cache is stale.", { random: () => rolls.shift() });
  assert.equal(bare.aside, null);
  assert.equal(bare.text, gist("Hmm, the cache is stale."));
  // a long thought clips its body, never its attitude
  const long = thought("The parser is broken again and the user asked twice already and the whole thing is still failing", { max: 60 });
  assert.ok(long.text.length <= 60, `${long.text.length}: ${long.text}`);
  assert.ok(long.text.endsWith(` ${long.aside}`), long.text);
  assert.ok([...voice.angry.open, ...voice.angry.close].includes(long.aside), long.aside);
  // verbatim is a quote: the persona keeps its opinions out of it
  assert.equal(thought("The user keeps asking.", { style: "verbatim" }).text, "The user keeps asking");
  assert.equal(thought("The user keeps asking.", { style: "verbatim" }).aside, null);
});

test("thoughts: only the newest assistant reasoning is used", () => {
  const messages = [
    { role: "user", content: [{ type: "text", text: "hi" }] },
    { role: "assistant", content: [{ type: "reasoning", text: "old thought" }, { type: "text", text: "done" }] },
    { role: "user", content: [{ type: "text", text: "next" }] },
    { role: "assistant", content: [{ type: "reasoning", text: "new thought" }, { type: "tool-call" }] },
  ];
  assert.equal(latestThought(messages), "new thought");
  // signed/encrypted reasoning has no text: do not fall back to a stale thought
  assert.equal(latestThought([...messages, { role: "assistant", content: [{ type: "reasoning", text: "" }] }]), null);
  // parts[] is the other shape a host may send
  assert.equal(latestThought([{ role: "assistant", parts: [{ type: "reasoning", reasoning: "via parts" }] }]), "via parts");
  assert.equal(latestThought([]), null);
  assert.equal(latestThought(null), null);
});

test("thoughts: the CLI can make it think, and the bridge tags the kind", async () => {
  const dir = tmp();
  const env = { ...process.env, BABYZILLA_PET_STATE: dir, BABYZILLA_NO_UPDATE_CHECK: "1" };
  const out = await run(process.execPath, [BIN, "pet", "think", "read", "the", "parser"], { env });
  // caveman by default, exactly as the dino says it in a session
  assert.match(out.stdout, /thought: .*Read parser/);
  assert.doesNotMatch(out.stdout, /the parser/, "caveman drops the article");
  const lines = fs.readFileSync(path.join(dir, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines[0].kind, "think");
  assert.match(lines[0].text, /Read parser/);
  // --raw keeps the words as typed
  const exact = await run(process.execPath, [BIN, "pet", "think", "--raw", "read", "the", "parser"], { env });
  assert.match(exact.stdout, /thought: read the parser/);
});

test("cli: pet remove deletes a pet you are not wearing, and install restores it", async () => {
  const dir = tmp();
  const env = { ...process.env, BABYZILLA_PET_STATE: dir, BABYZILLA_NO_UPDATE_CHECK: "1" };
  const cli = (...args) => run(process.execPath, [BIN, ...args], { env });
  await cli("pet", "install", "--no-build", "--no-start");
  assert.ok(fs.existsSync(path.join(dir, "sprites", "idle.png")), "sprites installed");

  // never delete the art the app is drawing from
  await assert.rejects(cli("pet", "remove", "babyzilla"), (e) => e.code === 2 && /refusing/.test(e.stdout));

  // stand up a second pet and wear it
  const pack = path.join(dir, "packs", "fakey");
  fs.mkdirSync(path.join(pack, "sprites"), { recursive: true });
  fs.writeFileSync(path.join(pack, "pack.json"), JSON.stringify({
    kind: "pack", name: "fakey", label: "Fakey", size: 48, animations: { idle: ["idle-1"] },
  }));
  fs.copyFileSync(path.join(dir, "sprites", "idle.png"), path.join(pack, "sprites", "idle-1.png"));
  await cli("pet", "use", "fakey");

  const removed = await cli("pet", "remove", "babyzilla");
  assert.match(removed.stdout, /removed BabyZilla \(built-in\)/);
  assert.equal(fs.readdirSync(path.join(dir, "sprites")).filter((f) => f.endsWith(".png")).length, 0, "no built-in art left");
  assert.ok(!fs.existsSync(path.join(dir, "pet-data.json")));

  const list = await cli("pet", "packs");
  assert.doesNotMatch(list.stdout, /BabyZilla \(built-in\)/, "the listing hides it");
  assert.match(list.stdout, /removed: babyzilla/, "and says how to get it back");

  await assert.rejects(cli("pet", "use", "babyzilla"), (e) => e.code === 2 && /was removed/.test(e.stdout));

  // The app owns config.json and re-encodes it from its own struct, so a removal
  // recorded there would vanish on the next drag. It must live in its own file.
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({
    scale: 3, chattiness: "normal", muted: false, followCursor: true, pack: "fakey",
  }));
  assert.doesNotMatch((await cli("pet", "packs")).stdout, /BabyZilla \(built-in\)/, "the app's save must not undo the removal");

  // an install must not quietly bring it back — that would undo a decision
  const reinstalled = await cli("pet", "install", "--no-build", "--no-start");
  assert.match(reinstalled.stdout, /skipped\s+babyzilla/);
  assert.equal(fs.readdirSync(path.join(dir, "sprites")).filter((f) => f.endsWith(".png")).length, 0, "still gone");
  assert.doesNotMatch((await cli("pet", "packs")).stdout, /BabyZilla \(built-in\)/, "still hidden");

  const restored = await cli("pet", "restore", "babyzilla");
  assert.match(restored.stdout, /restored babyzilla/);
  assert.ok(fs.existsSync(path.join(dir, "sprites", "idle.png")), "restore puts the art back");
  const again = await cli("pet", "packs");
  assert.match(again.stdout, /BabyZilla \(built-in\)/);
  assert.doesNotMatch(again.stdout, /removed:/);
});

test("pack animations: a nod and a sway from the pack's own pixels, plus the sheet row it missed", async () => {
  const dir = tmp();
  const packDir = path.join(dir, "pack");
  fs.mkdirSync(path.join(packDir, "sprites"), { recursive: true });
  // a small stand-in character: body above, feet on row 44-45
  const canvas = 48;
  const data = Buffer.alloc(canvas * canvas * 4);
  for (let y = 18; y <= 45; y++) {
    for (let x = 12; x <= 36; x++) {
      const i = (y * canvas + x) * 4;
      const leg = y > 40 && (x < 16 || x > 32);
      if (leg || y <= 40) {
        data[i] = 120; data[i + 1] = 160; data[i + 2] = 90; data[i + 3] = 255;
      }
    }
  }
  fs.writeFileSync(path.join(packDir, "sprites", "idle-1.png"), encodePng(canvas, canvas, data));
  fs.writeFileSync(path.join(packDir, "pack.json"), JSON.stringify({
    kind: "pack", name: "demo", label: "Demo", size: canvas,
    animations: { idle: ["idle-1"] }, fps: { idle: 6 },
  }));

  const cli = (...args) => run(process.execPath, [fileURLToPath(new URL("../pet/pack-animations.mjs", import.meta.url)), ...args], { env: process.env });
  const first = await cli("--pack", packDir);
  assert.match(first.stdout, /frames written: nod, sway, shake, stretch, turn, lean, bounce, slump/);

  const after = JSON.parse(fs.readFileSync(path.join(packDir, "pack.json"), "utf8"));
  assert.deepEqual(after.animations.nod, ["nod-1", "nod-2", "nod-3"]);
  assert.deepEqual(after.animations.sway, ["sway-1", "sway-2", "sway-3"]);
  assert.equal(after.animations.dash, undefined, "no sheet, no dash");
  assert.equal(after.expressions.thinking, "nod");
  assert.equal(after.expressions.celebrate, "sway");
  assert.equal(after.expressions["shell-fail"], "shake");
  assert.equal(after.expressions["tool-question"], "turn");
  assert.equal(after.expressions["tool-task"], "stretch");
  assert.equal(after.expressions["tool-read"], "lean");
  assert.equal(after.expressions["tool-edit"], "bounce");
  assert.equal(after.expressions["budget-full"], "slump");
  for (const id of ["nod-1", "nod-2", "nod-3", "sway-1", "sway-2", "sway-3", "shake-1", "shake-4", "stretch-1", "turn-1", "turn-3", "turn-4"]) {
    assert.ok(fs.existsSync(path.join(packDir, "sprites", `${id}.png`)), `${id} written`);
  }
  // derived poses keep the feet on the baseline and the same palette
  const frame = (id) => decodePng(fs.readFileSync(path.join(packDir, "sprites", `${id}.png`)));
  const bottom = (img) => {
    for (let y = img.height - 1; y >= 0; y--) {
      for (let x = 0; x < img.width; x++) if (img.data[(y * img.width + x) * 4 + 3]) return y;
    }
    return -1;
  };
  assert.equal(bottom(frame("nod-1")), 45, "a nod squashes toward the feet, it does not float");
  assert.equal(bottom(frame("sway-3")), 45, "a sway keeps its feet planted");
  assert.equal(bottom(frame("stretch-2")), 45, "a stretch grows upward from the feet");
  assert.equal(bottom(frame("lean-2")), 45, "a lean tips the body, not the feet");
  // a hop is the one pose allowed to leave the ground, and it comes back down
  assert.ok(bottom(frame("bounce-3")) < 45, "a bounce lifts off");
  assert.equal(bottom(frame("bounce-1")), 45, "and it starts from the floor");
  // a turn is the character squeezed edge-on, then mirrored: same character, other side
  const width = (img) => {
    let min = img.width, max = -1;
    for (let y = 0; y < img.height; y++) {
      for (let x = 0; x < img.width; x++) {
        if (img.data[(y * img.width + x) * 4 + 3]) { min = Math.min(min, x); max = Math.max(max, x); }
      }
    }
    return max - min + 1;
  };
  assert.ok(width(frame("turn-2")) < width(frame("turn-1")), "edge-on is narrower than facing forward");
  assert.deepEqual(frame("turn-4").data, frame("turn-2").data, "the turn closes the loop instead of snapping");
  assert.notDeepEqual(frame("turn-3").data, frame("turn-1").data, "mirrored is a different pose");

  // a sheet's unused row becomes an animation, copied cell-relative
  const sheet = { width: 320, height: 96, data: Buffer.alloc(320 * 96 * 4) };
  for (let i = 0; i < 320 * 96; i++) { sheet.data[i * 4 + 3] = 255; }
  for (let c = 6; c < 10; c++) {
    for (let y = 2 * 32; y < 2 * 32 + 24; y++) {
      for (let x = c * 32 + 4; x < c * 32 + 4 + 24; x++) {
        const i = (y * sheet.width + x) * 4;
        sheet.data[i] = 200; sheet.data[i + 1] = 60 + c; sheet.data[i + 2] = 90;
      }
    }
  }
  const sheetPath = path.join(dir, "sheet.png");
  fs.writeFileSync(sheetPath, encodePng(sheet.width, sheet.height, sheet.data));
  const second = await cli("--pack", packDir, "--sheet", sheetPath, "--row", "2", "--from-col", "6");
  assert.match(second.stdout, /dash, nod, sway, shake, stretch, turn, lean, bounce, slump/);
  const withDash = JSON.parse(fs.readFileSync(path.join(packDir, "pack.json"), "utf8"));
  assert.equal(withDash.animations.dash.length, 4);
  assert.equal(withDash.expressions.compressing, "dash");

  const removed = await cli("--pack", packDir, "--remove");
  assert.match(removed.stdout, /removed 32 frames/);
  const back = JSON.parse(fs.readFileSync(path.join(packDir, "pack.json"), "utf8"));
  assert.equal(back.animations.nod, undefined);
  assert.equal(back.expressions, undefined, "the map goes with the animations");
  assert.equal(fs.readdirSync(path.join(packDir, "sprites")).join(","), "idle-1.png");
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

test("app: every sprite it asks for exists", (t) => {
  // The Swift app names sprites as string literals; a typo would silently fall
  // back to idle and look like a bug in the animation, not in the art.
  const swift = fs.readFileSync(path.join(ROOT, "apps/pet/PetApp.swift"), "utf8");
  const ids = new Set(swift.match(/"loco-[a-z0-9-]+"/g)?.map((s) => s.slice(1, -1)) ?? []);
  assert.ok(ids.size > 0, "the app references locomotion frames");
  const built = new Set(fs.existsSync(SPRITES)
    ? fs.readdirSync(SPRITES).filter((f) => f.endsWith(".png")).map((f) => f.slice(0, -4)) : []);
  const missing = [...ids].filter((id) => !built.has(id));
  assert.deepEqual(missing, [], `missing locomotion sprites: ${missing.join(", ")}`);
  // and the catalogue the app renders from agrees with the art
  const data = JSON.parse(fs.readFileSync(path.join(ROOT, "assets/pet/pet-data.json"), "utf8"));
  const absent = data.expressions.filter((e) => !built.has(e.id)).map((e) => e.id);
  assert.deepEqual(absent, [], `expressions with no sprite: ${absent.join(", ")}`);
});

test("pack builder: a sheet becomes coherent, complete animations", async (t) => {
  // Build a synthetic 6x3 sheet from the repo's own master sprite, so the test
  // exercises pet/pack.mjs without shipping third-party art.
  const master = path.join(SPRITES, "master.png");
  if (!fs.existsSync(master)) return t.skip("no master sprite");
  const cell = 32, cols = 6, rows = 3;
  const sheet = { width: cell * cols, height: cell * rows, data: Buffer.alloc(cell * cols * cell * rows * 4) };
  const src = decodePng(fs.readFileSync(master));
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      // take the *centre* of the master so the synthetic character sits inside
      // its cell the way a real sheet's does
      for (let y = 0; y < cell; y++) {
        for (let x = 0; x < cell; x++) {
          const sx = x + Math.max(0, (src.width - cell) / 2);
          const sy = y + Math.max(0, (src.height - cell) / 2);
          if (sx >= src.width || sy >= src.height) continue;
          const s = (sy * src.width + sx) * 4;
          const d = ((r * cell + y) * sheet.width + (c * cell + x)) * 4;
          for (let k = 0; k < 4; k++) sheet.data[d + k] = src.data[s + k];
        }
      }
    }
  }
  const dir = tmp();
  const sheetPath = path.join(dir, "sheet.png");
  fs.writeFileSync(sheetPath, encodePng(sheet.width, sheet.height, sheet.data));
  const out = path.join(dir, "pack");
  await run(process.execPath, [path.join(ROOT, "pet/pack.mjs"), "--sheet", sheetPath, "--name", "testpack",
    "--label", "Test Pack", "--cell", String(cell), "--crop", "4,4,24,24", "--rows", "idle,walk,jump",
    "--cols", String(cols), "--upscale", "2", "--out", out], { env: { ...process.env, BABYZILLA_NO_UPDATE_CHECK: "1" } });

  let pack = JSON.parse(fs.readFileSync(path.join(out, "pack.json"), "utf8"));
  assert.equal(pack.size, 48, "24px crop at 2x");
  for (const anim of ["idle", "walk", "jump"]) {
    assert.equal(pack.animations[anim].length, cols, `${anim} has every column`);
    for (const frame of pack.animations[anim]) {
      const img = decodePng(fs.readFileSync(path.join(out, "sprites", `${frame}.png`)));
      assert.equal(img.width, pack.size);
      assert.equal(img.height, pack.size);
    }
  }

  // Authoring expressions on the grid must produce usable animations and a map
  // that answers for every expression id the app can receive.
  await run(process.execPath, [path.join(ROOT, "pet/pack-expressions.mjs"), "--pack", out],
    { env: { ...process.env, BABYZILLA_NO_UPDATE_CHECK: "1" } });
  pack = JSON.parse(fs.readFileSync(path.join(out, "pack.json"), "utf8"));
  for (const face of ["blink", "happy", "angry", "surprised", "hurt"]) {
    assert.ok(pack.animations[face]?.length >= 2, `${face} animation exists`);
    for (const frame of pack.animations[face]) {
      const img = decodePng(fs.readFileSync(path.join(out, "sprites", `${frame}.png`)));
      assert.equal(img.width, pack.size, `${frame} keeps the canvas`);
      let ink = 0;
      for (let i = 3; i < img.data.length; i += 4) if (img.data[i]) ink++;
      assert.ok(ink > 20, `${frame} is not empty`);
    }
    assert.ok(pack.fps?.[face] > 0, `${face} has a frame rate`);
  }
  assert.equal(Object.keys(pack.expressions).length, EXPRESSIONS.length, "every expression id is mapped");
  for (const e of EXPRESSIONS) {
    const anim = pack.expressions[e.id];
    assert.ok(pack.animations[anim], `${e.id} -> ${anim} exists`);
  }
  // the interesting faces must actually be reachable, not just present
  const used = new Set(Object.values(pack.expressions));
  for (const face of ["blink", "happy", "angry", "surprised", "hurt"]) {
    assert.ok(used.has(face), `some expression selects ${face}`);
  }
  // a dropped face must not leave frames behind
  const frames = fs.readdirSync(path.join(out, "sprites")).map((f) => f.replace(/\.png$/, ""));
  const declared = new Set(Object.values(pack.animations).flat());
  assert.deepEqual(frames.filter((f) => !declared.has(f)), [], "no orphan frames");

  // --remove must return the pack to exactly the animations its artist drew
  const before = pack.animations.idle.concat(pack.animations.walk, pack.animations.jump);
  await run(process.execPath, [path.join(ROOT, "pet/pack-expressions.mjs"), "--pack", out, "--remove"],
    { env: { ...process.env, BABYZILLA_NO_UPDATE_CHECK: "1" } });
  pack = JSON.parse(fs.readFileSync(path.join(out, "pack.json"), "utf8"));
  assert.deepEqual(Object.keys(pack.animations).sort(), ["idle", "jump", "walk"], "only the artist's animations remain");
  assert.equal(pack.expressions, undefined, "the expression map is gone");
  const after = fs.readdirSync(path.join(out, "sprites")).map((f) => f.replace(/\.png$/, "")).sort();
  assert.deepEqual(after, [...before].sort(), "the original frames are untouched, the faces are gone");
  assert.deepEqual(pack.fps, { idle: 6, walk: 12, jump: 12 }, "frame rates are the pack's own again");

  // and it is idempotent: running it twice is not an error
  await run(process.execPath, [path.join(ROOT, "pet/pack-expressions.mjs"), "--pack", out, "--remove"],
    { env: { ...process.env, BABYZILLA_NO_UPDATE_CHECK: "1" } });
  pack = JSON.parse(fs.readFileSync(path.join(out, "pack.json"), "utf8"));
  assert.deepEqual(Object.keys(pack.animations).sort(), ["idle", "jump", "walk"]);
});

test("cli: pet packs lists the built-in pet, and use rejects unknown names", async () => {
  const env = { ...process.env, BABYZILLA_PET_STATE: tmp(), BABYZILLA_NO_UPDATE_CHECK: "1" };
  const packs = await run(process.execPath, [BIN, "pet", "packs"], { env });
  assert.match(packs.stdout, /babyzilla\s+BabyZilla \(built-in\)/);
  const bad = run(process.execPath, [BIN, "pet", "use", "not-a-pack"], { env });
  await assert.rejects(bad, (e) => e.code === 2);
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
