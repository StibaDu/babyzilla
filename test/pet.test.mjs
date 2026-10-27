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
import { characterCrop, installPetPackage } from "../pet/pet-package.mjs";
import { houseVoice, VOICE_IDS, poolsFor } from "../lib/pet-voice.mjs";
import {
  LANGUAGES, cavemanDe, germanMoods, isLanguage, line as langLine, readMoodDe, resolveLanguage,
} from "../lib/pet-lang.mjs";
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

test("cli: pet mark sets, reports and clears the badge", async () => {
  const dir = tmp();
  const env = { ...process.env, BABYZILLA_PET_STATE: dir, BABYZILLA_NO_UPDATE_CHECK: "1" };
  const set = await run(process.execPath, [BIN, "pet", "mark", "question"], { env });
  assert.match(set.stdout, /mark\s+question/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "mark.json"), "utf8")).mark, "question");
  // no argument reports the state rather than changing it
  const got = await run(process.execPath, [BIN, "pet", "mark"], { env });
  assert.match(got.stdout, /mark\s+question/);
  const ev = fs.readFileSync(path.join(dir, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).pop();
  assert.deepEqual({ kind: ev.kind, mark: ev.mark }, { kind: "mark", mark: "question" });
  // none clears it, in the file and in the event
  await run(process.execPath, [BIN, "pet", "mark", "none"], { env });
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "mark.json"), "utf8")).mark, null);
  // a typo is refused instead of written (execFile rejects on the exit code)
  const bad = await run(process.execPath, [BIN, "pet", "mark", "party"], { env }).catch((e) => e);
  assert.match(String(bad.stdout ?? bad.message), /unknown mark/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "mark.json"), "utf8")).mark, null);
});

test("cli: pet think speaks in the active pet's voice, and --voice previews another", async () => {
  const dir = tmp();
  const env = { ...process.env, BABYZILLA_PET_STATE: dir, BABYZILLA_NO_UPDATE_CHECK: "1" };
  const line = "The user wants me to add a bubble next";
  // no pack: the built-in creature is the caveman
  const dino = await run(process.execPath, [BIN, "pet", "think", line], { env });
  assert.match(dino.stdout, /human/i);
  assert.match(dino.stdout, /voice\s+caveman/);
  // a pack declares its voice, and the same words are no longer rewritten
  fs.mkdirSync(path.join(dir, "packs", "doubao"), { recursive: true });
  fs.writeFileSync(path.join(dir, "packs", "doubao", "pack.json"), JSON.stringify({ voice: "doubao" }));
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ pack: "doubao" }));
  const sweet = await run(process.execPath, [BIN, "pet", "think", line], { env });
  assert.match(sweet.stdout, /The user wants me to add a bubble next/);
  assert.match(sweet.stdout, /voice\s+Doubao/);
  // any voice can be previewed without switching the pet
  const gem = await run(process.execPath, [BIN, "pet", "think", "The tests pass now", "--voice", "gemini"], { env });
  assert.match(gem.stdout, /voice\s+Gemini/);
  const bad = await run(process.execPath, [BIN, "pet", "think", "x", "--voice", "party"], { env }).catch((e) => e);
  assert.match(String(bad.stdout ?? bad.message), /unknown voice/);
});

test("cli: pet install ships Lil Dino, and removing the pet you wear is refused", async () => {
  const dir = tmp();
  const env = { ...process.env, BABYZILLA_PET_STATE: dir, BABYZILLA_NO_UPDATE_CHECK: "1" };
  const cli = (...args) => run(process.execPath, [BIN, ...args], { env });
  const listing = async () => (await cli("pet", "packs")).stdout;
  await cli("pet", "install", "--no-build", "--no-start");
  assert.ok(fs.existsSync(path.join(dir, "sprites", "idle.png")), "sprites installed");

  // the pack that ships is the pet a new install wears — not the legacy art
  const shipped = path.join(dir, "packs", "lil-dino");
  assert.ok(fs.existsSync(path.join(shipped, "pack.json")), "Lil Dino shipped with the install");
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8")).pack, "lil-dino");
  assert.match(await listing(), /lil-dino\s+Lil Dino[^\n]*active/);
  assert.doesNotMatch(await listing(), /BabyZilla \(built-in\)/, "the legacy pet is not a choice");

  // never delete the pet the app is drawing
  await assert.rejects(cli("pet", "remove", "lil-dino"), (e) => e.code === 2 && /refusing/.test(e.stdout));

  // stand up a second pet and wear it
  const pack = path.join(dir, "packs", "fakey");
  fs.mkdirSync(path.join(pack, "sprites"), { recursive: true });
  fs.writeFileSync(path.join(pack, "pack.json"), JSON.stringify({
    kind: "pack", name: "fakey", label: "Fakey", size: 48, animations: { idle: ["idle-1"] },
  }));
  fs.copyFileSync(path.join(dir, "sprites", "idle.png"), path.join(pack, "sprites", "idle-1.png"));
  await cli("pet", "use", "fakey");

  const removed = await cli("pet", "remove", "lil-dino");
  assert.match(removed.stdout, /removed Lil Dino/);
  assert.ok(!fs.existsSync(shipped), "the pack is gone from disk");
  assert.match(await listing(), /removed: lil-dino/, "and says how to get it back");
  await assert.rejects(cli("pet", "use", "lil-dino"), (e) => e.code === 2 && /was removed/.test(e.stdout));

  // a reinstall must not undo the decision ...
  const reinstalled = await cli("pet", "install", "--no-build", "--no-start");
  assert.match(reinstalled.stdout, /skipped\s+lil-dino/);
  assert.ok(!fs.existsSync(shipped), "still gone");
  // ... restore is the explicit way back
  const restored = await cli("pet", "restore", "lil-dino");
  assert.match(restored.stdout, /restored lil-dino/);
  assert.ok(fs.existsSync(path.join(shipped, "pack.json")), "restore puts the pack back");
  await cli("pet", "use", "lil-dino");
  assert.match(await listing(), /lil-dino\s+Lil Dino[^\n]*active/);

  // the legacy art is still removable — it is a fallback, not a pet
  await cli("pet", "use", "fakey");
  const legacy = await cli("pet", "remove", "babyzilla");
  assert.match(legacy.stdout, /removed BabyZilla \(built-in\)/);
  assert.equal(fs.readdirSync(path.join(dir, "sprites")).filter((f) => f.endsWith(".png")).length, 0);
  assert.ok(!fs.existsSync(path.join(dir, "pet-data.json")));

  // The app owns config.json and re-encodes it from its own struct, so a removal
  // recorded there would vanish on the next drag. It must live in its own file.
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({
    scale: 3, chattiness: "normal", muted: false, followCursor: true, pack: "fakey",
  }));
  assert.match(await listing(), /removed: babyzilla/, "the app's save must not undo the removal");
});

test("cli: pet install pins node and the CLI for the app", async () => {
  const dir = tmp();
  const env = { ...process.env, BABYZILLA_PET_STATE: dir, BABYZILLA_NO_UPDATE_CHECK: "1" };
  await run(process.execPath, [BIN, "pet", "install", "--no-build", "--no-start"], { env });
  const pinned = JSON.parse(fs.readFileSync(path.join(dir, "cli.json"), "utf8"));
  // a login item has no PATH: both paths must be absolute and real
  assert.ok(path.isAbsolute(pinned.node), "node is absolute");
  assert.ok(path.isAbsolute(pinned.cli), "cli is absolute");
  assert.ok(fs.existsSync(pinned.node), "node exists");
  assert.ok(fs.existsSync(pinned.cli), "cli exists");
  assert.match(pinned.version, /^\d+\.\d+\.\d+$/);
});

test("pack: the shipped Lil Dino is a real pack with a voice", () => {
  const dir = path.join(ROOT, "assets/pet/packs/lil-dino");
  const pack = JSON.parse(fs.readFileSync(path.join(dir, "pack.json"), "utf8"));
  assert.equal(pack.kind, "pack");
  assert.equal(pack.name, "lil-dino");
  assert.equal(pack.label, "Lil Dino");
  assert.equal(pack.voice, "caveman", "the caveman is the pack's, not a hardcoded default");
  assert.equal(pack.defaultScale, 3);
  for (const name of ["idle", "walk", "jump"]) assert.ok(pack.animations[name]?.length, `${name} has frames`);
  for (const frame of Object.values(pack.animations).flat()) {
    assert.ok(fs.existsSync(path.join(dir, "sprites", `${frame}.png`)), `${frame}.png is in the repo`);
  }
  assert.ok(Object.keys(pack.expressions ?? {}).length > 10, "it can answer the expression ids");
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

test("pack builder: a non-square atlas is downscaled without stretching the art", async () => {
  // OpenPet/Codex atlases use cells that are taller than they are wide (192x208)
  // and are drawn at several times the size the app wants. A square cell would
  // read the wrong grid; a nearest upscale would only make it bigger.
  const cw = 48, ch = 52, cols = 2, rows = 2;
  const sheet = { width: cw * cols, height: ch * rows, data: Buffer.alloc(cw * cols * ch * rows * 4) };
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      // a 24x40 bar of ink, so a stretched frame is measurable
      for (let y = 0; y < 40; y++) {
        for (let x = 0; x < 24; x++) {
          const i = ((r * ch + y + 4) * sheet.width + (c * cw + x + 6)) * 4;
          sheet.data[i] = 240; sheet.data[i + 1] = 200; sheet.data[i + 2] = 60; sheet.data[i + 3] = 255;
        }
      }
    }
  }
  const dir = tmp();
  const sheetPath = path.join(dir, "atlas.png");
  fs.writeFileSync(sheetPath, encodePng(sheet.width, sheet.height, sheet.data));
  const out = path.join(dir, "pack");
  await run(process.execPath, [path.join(ROOT, "pet/pack.mjs"), "--sheet", sheetPath, "--name", "atlas",
    "--label", "Atlas", "--cell", `${cw}x${ch}`, "--crop", `0,0,${cw},${ch}`,
    "--rows", "idle,walk", "--cols", String(cols), "--resize", "32", "--voice", "gemini", "--out", out],
    { env: { ...process.env, BABYZILLA_NO_UPDATE_CHECK: "1" } });

  const pack = JSON.parse(fs.readFileSync(path.join(out, "pack.json"), "utf8"));
  assert.equal(pack.size, 32, "the canvas is the requested square");
  assert.equal(pack.voice, "gemini", "a pack records the voice it speaks with");
  assert.equal(pack.animations.idle.length, cols);
  const img = decodePng(fs.readFileSync(path.join(out, "sprites", pack.animations.idle[0] + ".png")));
  assert.equal(img.width, 32);
  assert.equal(img.height, 32);
  // ink bbox: aspect must survive the resize (24x40 in, letterboxed, never squashed)
  let x0 = 99, y0 = 99, x1 = -1, y1 = -1;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      if (img.data[(y * img.width + x) * 4 + 3] < 128) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  const aspect = (x1 - x0 + 1) / (y1 - y0 + 1);
  assert.ok(Math.abs(aspect - 24 / 40) < 0.12, `aspect ${aspect.toFixed(2)} vs 0.60`);
  assert.ok(x0 > 0, "letterboxed horizontally rather than stretched to the edges");
});

test("pet package: an 8x11 V2 atlas installs as a pack, and the glance rows are ignored", async () => {
  // The OpenPets V2 sheet is the nine standard rows plus sixteen look-direction
  // cells. Those extra rows are not animation frames: if the crop counted them,
  // every pet would be cropped to the width of the whole cell.
  const cw = 48, ch = 52, cols = 8, rows = 11;
  const sheet = { width: cw * cols, height: ch * rows, data: Buffer.alloc(cw * cols * ch * rows * 4) };
  const ink = (row, col, x, y, r, g, b) => {
    const i = (((row * ch) + y) * sheet.width + (col * cw + x)) * 4;
    sheet.data[i] = r; sheet.data[i + 1] = g; sheet.data[i + 2] = b; sheet.data[i + 3] = 255;
  };
  for (let r = 0; r < 9; r++) {
    for (let c = 0; c < cols; c++) {
      for (let y = 6; y < 42; y++) for (let x = 12; x < 32; x++) ink(r, c, x, y, 240, 200, 60);
    }
  }
  for (let r = 9; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) ink(r, c, x, y, 40, 120, 240);
    }
  }
  assert.deepEqual(characterCrop(sheet, cw, ch), { x: 10, y: 4, w: 24, h: 40 }, "crop ignores rows 9-10");

  const dir = tmp();
  const pkg = path.join(dir, "hoodie-cat");
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, "pet.json"), JSON.stringify({
    id: "hoodie-cat", displayName: "Hoodie Cat", description: "A cat in a hoodie", spritesheetPath: "spritesheet.png",
  }));
  fs.writeFileSync(path.join(pkg, "spritesheet.png"), encodePng(sheet.width, sheet.height, sheet.data));

  const result = installPetPackage(pkg, { outRoot: path.join(dir, "packs"), size: 48, scale: 2 });
  assert.equal(result.id, "hoodie-cat");
  assert.equal(result.rows, 11);
  const pack = JSON.parse(fs.readFileSync(path.join(result.dir, "pack.json"), "utf8"));
  assert.deepEqual(pack.atlas, { sheet: `${sheet.width}x${sheet.height}`, cell: `${cw}x${ch}`, rows: 11, version: 2 });
  assert.equal(pack.voice, houseVoice("hoodie-cat"), "an unknown character gets a house voice");
  assert.equal(pack.voice, "deadpan", "and this cat is pinned to the one it deserves");
  assert.equal(pack.expressions.thinking, "review", "expressions map onto bodies");
  assert.equal(pack.expressions["shell-fail"], "sad");
  assert.equal(pack.animations.walk.length, cols);
  assert.equal(pack.size, 48);
  const frame = decodePng(fs.readFileSync(path.join(result.dir, "sprites", `${pack.animations.idle[0]}.png`)));
  assert.equal(frame.width, 48);
  assert.equal(frame.height, 48);
});

test("cli: pet add installs a package from a folder, with a chosen voice", async () => {
  const dir = tmp();
  const pkg = path.join(dir, "pkg");
  fs.mkdirSync(pkg, { recursive: true });
  const cell = 24, cols = 8, rows = 9;
  const sheet = { width: cell * cols, height: Math.round(cell * 208 / 192) * rows, data: null };
  sheet.data = Buffer.alloc(sheet.width * sheet.height * 4);
  const cellH = sheet.height / rows;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      for (let y = 4; y < cellH - 4; y++) for (let x = 6; x < cell - 6; x++) {
        const i = (((r * cellH) + y) * sheet.width + (c * cell + x)) * 4;
        sheet.data[i] = 200; sheet.data[i + 1] = 120; sheet.data[i + 2] = 240; sheet.data[i + 3] = 255;
      }
    }
  }
  fs.writeFileSync(path.join(pkg, "pet.json"), JSON.stringify({ id: "test-cat", displayName: "Test Cat", spritesheetPath: "spritesheet.png" }));
  fs.writeFileSync(path.join(pkg, "spritesheet.png"), encodePng(sheet.width, sheet.height, sheet.data));

  const state = path.join(dir, "state");
  const env = { ...process.env, BABYZILLA_PET_STATE: state, BABYZILLA_NO_UPDATE_CHECK: "1" };
  const res = await run(process.execPath, [BIN, "pet", "add", pkg, "--voice", "robot"], { env });
  assert.match(res.stdout, /test-cat/);
  const pack = JSON.parse(fs.readFileSync(path.join(state, "packs", "test-cat", "pack.json"), "utf8"));
  assert.equal(pack.voice, "robot");
  assert.equal(pack.label, "Test Cat");
  // and it is a first-class pack from then on
  const packs = await run(process.execPath, [BIN, "pet", "packs"], { env });
  assert.match(packs.stdout, /test-cat/);
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

test("cli: pet packs lists what is installed, and use rejects unknown names", async () => {
  const dir = tmp();
  const env = { ...process.env, BABYZILLA_PET_STATE: dir, BABYZILLA_NO_UPDATE_CHECK: "1" };
  // the shipped pack is listed before anything is copied: it is what comes with
  // the plugin, and it is the default, so the list must not read as empty
  const empty = await run(process.execPath, [BIN, "pet", "packs"], { env });
  assert.match(empty.stdout, /lil-dino\s+Lil Dino/);
  assert.doesNotMatch(empty.stdout, /BabyZilla \\(built-in\\)/, "the legacy pet is never a choice");

  await run(process.execPath, [BIN, "pet", "install", "--no-build", "--no-start"], { env });
  const packs = await run(process.execPath, [BIN, "pet", "packs"], { env });
  assert.match(packs.stdout, /lil-dino\s+Lil Dino/);
  assert.match(packs.stdout, /more pets: babyzilla pet catalog/);
  assert.doesNotMatch(packs.stdout, /babyzilla\s+BabyZilla/);

  const bad = run(process.execPath, [BIN, "pet", "use", "not-a-pack"], { env });
  await assert.rejects(bad, (e) => e.code === 2);
});

test("lang: every voice speaks German in its own register", () => {
  const moods = ["angry", "confused", "bored", "smug", "tease", "flat"];
  for (const id of VOICE_IDS) {
    const table = germanMoods(id);
    for (const mood of moods) {
      assert.ok(table[mood]?.close?.length >= 3, `${id}/${mood} has German closers`);
      assert.ok(table[mood]?.open?.length >= 1, `${id}/${mood} has German openers`);
    }
  }
  // the dino keeps its cave; everybody else gets a register, not the dino's
  assert.notDeepEqual(germanMoods("caveman"), germanMoods("plain"));
  assert.deepEqual(germanMoods("claude"), germanMoods("doubao"), "one warm register");
  // no English aside may leak into a German bubble
  const english = /(?:Human|human|rock|Dino (?:wait|see|work)|Me |Thrilling|Nailed it)/;
  for (const id of VOICE_IDS) {
    for (const mood of moods) {
      for (const text of [...germanMoods(id)[mood].open, ...germanMoods(id)[mood].close]) {
        assert.doesNotMatch(text, english, `${id}/${mood}: ${text}`);
      }
    }
  }
});

test("lang: a German thought keeps its umlauts and reads its own mood", () => {
  const source = "Ich muss den Fehler nochmal prüfen, weil der Parser wieder kaputt ist.";
  assert.equal(readMoodDe(source), "angry");
  assert.equal(readMoodDe("Unklar, warum das nicht läuft"), "confused");
  assert.equal(readMoodDe("Fertig, jetzt klappt es"), "smug");
  const said = thought(source, { language: "de", max: 200 });
  assert.match(said.text, /prüfen/, "the umlaut survived the sanitiser");
  assert.equal(said.mood, "angry");
  assert.ok(said.aside, "a German mood gets a German aside");
  assert.match(said.aside, /[a-zäöüß]/i);
  // the German caveman drops articles, never letters
  assert.equal(cavemanDe("Ich muss die Datei in dem Ordner prüfen"), "Ich Datei in Ordner prüfen");
  // other accents fold to their base letter instead of vanishing (plain voice, so
  // the caveman transform is not the thing being tested)
  assert.match(gist("Das Café an der Straße", { language: "de", voice: "plain" }), /Cafe an der Straße/);
  assert.match(gist("The café is closed", { voice: "plain" }), /The cafe is closed/);
});

test("lang: the pet's event lines and the language resolution", () => {
  assert.equal(langLine("de", "toolFailed", "bash"), "bash fehlgeschlagen");
  assert.equal(langLine("en", "toolFailed", "bash"), "bash failed");
  assert.match(langLine("de", "compacted", 1200, 300, 75), /Zusammengefasst: 1200 → 300 tok/);
  assert.equal(budgetExpression(96, "de").say, "Ich bin voll — gleich wird gepresst.");
  assert.equal(errorExpression("fetch failed", "de").say, "Netz nicht erreichbar.");
  assert.equal(updateExpression("0.33.0", "0.32.0", "de").say, "v0.33.0 ist da (du hast v0.32.0).");
  assert.ok(isLanguage("de"));
  assert.ok(!isLanguage("fr"), "a language without a table is not offered");
  // env wins over the config, and an unknown value is ignored rather than adopted
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ language: "de" }));
  const saved = process.env.BABYZILLA_PET_LANG;
  try {
    delete process.env.BABYZILLA_PET_LANG;
    assert.equal(resolveLanguage(dir), "de");
    process.env.BABYZILLA_PET_LANG = "en";
    assert.equal(resolveLanguage(dir), "en");
    process.env.BABYZILLA_PET_LANG = "klingon";
    assert.equal(resolveLanguage(dir), "de", "a typo falls back to the config");
  } finally {
    if (saved === undefined) delete process.env.BABYZILLA_PET_LANG;
    else process.env.BABYZILLA_PET_LANG = saved;
  }
  assert.deepEqual(Object.keys(LANGUAGES).sort(), ["de", "en"]);
});

test("cli: pet lang sets the pet's language and the thought follows it", async () => {
  const dir = tmp();
  const env = { ...process.env, BABYZILLA_PET_STATE: dir, BABYZILLA_NO_UPDATE_CHECK: "1" };
  const cli = (...args) => run(process.execPath, [BIN, ...args], { env });
  assert.match((await cli("pet", "lang")).stdout, /language: en \(English\)/);
  assert.match((await cli("pet", "lang", "de")).stdout, /language: de \(Deutsch\)/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8")).language, "de");
  assert.match((await cli("pet", "status")).stdout, /language\s+Deutsch \(de\)/);
  const said = await cli("pet", "think", "Ich muss den Fehler nochmal prüfen, weil der Cache alt ist.");
  assert.match(said.stdout, /language\s+de \(Deutsch\)/);
  assert.match(said.stdout, /prüfen/);
  await assert.rejects(cli("pet", "lang", "fr"), (e) => e.code === 2 && /unknown language/.test(e.stdout));
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

// ── the app's own menu ──────────────────────────────────────────────────────
// Menus are the one surface a screenshot cannot reach, so the app prints them
// (`--menu`) in the language it is set to. That is enough to pin the wording of
// an action — it must speak about "the pet", not about one pack's art — and to
// prove the Stay put switch reflects the config rather than always reading off.

const PET_APP_BIN = path.join(os.homedir(), "Applications", "BabyZillaPet.app",
                              "Contents", "MacOS", "BabyZillaPet");

/** The built app, or null after marking the test skipped. */
function petApp(t) {
  if (process.platform !== "darwin") { t.skip("macOS app"); return null; }
  if (!fs.existsSync(PET_APP_BIN)) { t.skip("pet app not built (babyzilla pet install)"); return null; }
  return PET_APP_BIN;
}

function petAppState(config) {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(config));
  return { dir, env: { ...process.env, BABYZILLA_PET_STATE: dir, BABYZILLA_NO_UPDATE_CHECK: "1" } };
}

test("pet app: both menus say Hide/Show Pet, never the dino's name", async (t) => {
  const bin = petApp(t);
  if (!bin) return;
  const { dir, env } = petAppState({ language: "en" });
  const { stdout } = await run(bin, ["--menu"], { env, timeout: 30_000 });
  // Two menus: the pet's right-click menu and the menu bar.
  assert.equal((stdout.match(/^Hide Pet/gm) ?? []).length, 2, stdout);
  assert.equal((stdout.match(/^Stay put/gm) ?? []).length, 2, stdout);
  assert.doesNotMatch(stdout, /Dino/, "the action is about the pet, not about Lil Dino");
  assert.doesNotMatch(stdout, /^Stay put {2}\*/m, "off by default: no checkmark");

  const de = petAppState({ language: "de" });
  const german = await run(bin, ["--menu"], { env: de.env, timeout: 30_000 });
  assert.equal((german.stdout.match(/^Pet verstecken/gm) ?? []).length, 2, german.stdout);
  assert.equal((german.stdout.match(/^Stehen bleiben/gm) ?? []).length, 2, german.stdout);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(de.dir, { recursive: true, force: true });
});

test("pet app: Stay put stops a walk in progress and persists", async (t) => {
  const bin = petApp(t);
  if (!bin) return;
  const { dir, env } = petAppState({ language: "en" });
  const { stdout } = await run(bin, ["--stay-test"], { env, timeout: 30_000 });
  // The switch is wired to the state, written to config.json, and a pending
  // wander target is dropped — otherwise it finishes the stroll it started and
  // the option looks broken for the length of that walk.
  assert.match(stdout, /^initial\tstayPut=false\t/m, stdout);
  assert.match(stdout, /^on\tstayPut=true\tconfig=true\t.*target=none$/m, stdout);
  // The real question: did it stay there? The harness waits 12s — longer than
  // the 3–9s decision timer — so at least one idle decision fired.
  const onX = stdout.match(/^on\t[^\n]*\bx=([\d.]+)/m)?.[1];
  const heldX = stdout.match(/^held\t[^\n]*\bx=([\d.]+)/m)?.[1];
  assert.ok(onX && heldX, stdout);
  assert.equal(heldX, onX, "same pixel after 12s: the pet did not walk");
  assert.match(stdout, /^held\t[^\n]*target=none$/m, stdout);
  assert.match(stdout, /^off\tstayPut=false\tconfig=false$/m, stdout);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8")).stayPut, false);
  fs.rmSync(dir, { recursive: true, force: true });
});
