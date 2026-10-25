// A pet's voice: the dino is a caveman, an anime girl is not.
//
// The invariants matter more than the words: every voice must answer every mood,
// must never rewrite the model's sentence (except the caveman, whose whole joke
// is the rewrite), and must never roar.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { VOICES, VOICE_IDS, resolveVoice } from "../lib/pet-voice.mjs";
import { thought } from "../lib/pet-thought.mjs";

const MOODS = ["angry", "confused", "bored", "smug", "tease", "flat"];

test("voices: every pet answers every mood, short and punctuated", () => {
  assert.ok(VOICE_IDS.length >= 7, `${VOICE_IDS.length} voices`);
  for (const id of VOICE_IDS) {
    for (const mood of MOODS) {
      const pool = VOICES[id].moods[mood];
      assert.ok(pool, `${id} has ${mood}`);
      assert.ok(pool.open.length && pool.close.length, `${id}/${mood} has openers and asides`);
      // the same line may lead and trail (a grunt can do both); it may not repeat
      // inside one role, which would just cut the variety in half
      assert.equal(new Set(pool.open).size, pool.open.length, `${id}/${mood} openers repeat`);
      assert.equal(new Set(pool.close).size, pool.close.length, `${id}/${mood} asides repeat`);
      const all = [...pool.open, ...pool.close];
      for (const line of all) {
        assert.ok(line.length <= 34, `${id}/${mood} too long: ${line}`);
        assert.match(line, /[.!?]$/, `${id}/${mood} unpunctuated: ${line}`);
      }
    }
  }
});

test("voices: only the dino talks like a caveman", () => {
  const sentence = "The user keeps asking for a smaller bubble and I should check the cache.";
  const dino = thought(sentence, { voice: "caveman" });
  assert.match(dino.text, /human/i, "the dino calls its human a human");
  for (const id of ["plain", "deepseek", "doubao", "gemini", "chatgpt", "claude"]) {
    const said = thought(sentence, { voice: id });
    // no word-level rewrite at all: the model's own sentence survives
    assert.doesNotMatch(said.text, /human|Human/, `${id}: ${said.text}`);
    assert.match(said.text, /The user keeps asking/, `${id} keeps the model's words`);
  }
});

test("voices: the aside comes from that pet's own table", () => {
  const sentence = "The parser is broken again and the user asked twice already.";
  for (const id of VOICE_IDS) {
    const said = thought(sentence, { voice: id });
    const pool = VOICES[id].moods[said.mood];
    assert.ok([...pool.open, ...pool.close].includes(said.aside), `${id}: ${said.aside}`);
  }
  // same thought, different characters
  const lines = new Set(VOICE_IDS.map((id) => thought(sentence, { voice: id }).text));
  assert.ok(lines.size >= 6, `${lines.size} distinct voices`);
});

test("voices: Rawr belongs to the creature, not to the format", () => {
  const many = Array.from({ length: 400 }, (_, i) => `The cache is stale and the user asked again ${i} times.`);
  for (const id of ["plain", "deepseek", "doubao", "gemini", "chatgpt", "claude"]) {
    assert.ok(!many.some((s) => thought(s, { voice: id }).rawr), `${id} never roars`);
  }
  assert.ok(many.some((s) => thought(s, { voice: "caveman" }).rawr), "the dino still roars");
});

test("voices: a pack's voice follows the config, and unknown packs speak plainly", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bz-voice-"));
  // no config at all: the built-in creature, who is a little monster
  assert.equal(resolveVoice(dir).id, "caveman");

  const write = (pack, voice) => {
    fs.mkdirSync(path.join(dir, "packs", pack), { recursive: true });
    fs.writeFileSync(path.join(dir, "packs", pack, "pack.json"),
      JSON.stringify(voice === undefined ? {} : { voice }));
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ pack }));
  };

  write("doubao", "doubao");
  assert.equal(resolveVoice(dir).id, "doubao");
  // a pack that declares nothing is someone else's character
  write("anon", undefined);
  assert.equal(resolveVoice(dir).id, "plain");
  // a pack that declares nonsense must not crash a turn
  write("silly", "party");
  assert.equal(resolveVoice(dir).id, "plain");
  // a pack that was removed while it was active
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ pack: "gone" }));
  assert.equal(resolveVoice(dir).id, "plain");
});
