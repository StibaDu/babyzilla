import test from "node:test";
import assert from "node:assert/strict";
import {
  extractProbes,
  extractPointers,
  scorePack,
  selectPack,
  missingFactsModule,
  renderModules,
} from "../lib/eval.mjs";

const mod = (name, kind, content, hot = false) => ({ name, kind, content, hot });

const transcript = [
  "### USER",
  "the plugin drops my question. fix src/index.js:120 and keep the recall handle.",
  "",
  "### ASSISTANT",
  "Decision: never compact assistant prose. See lib/text.mjs:88. Want me to tag v0.7.3?",
  "",
  "### USER",
  "yes",
].join("\n");

test("pointers are pulled out of the transcript", () => {
  const p = extractPointers(transcript);
  assert.ok(p.includes("src/index.js:120"));
  assert.ok(p.includes("lib/text.mjs:88"));
});

test("probes carry the newest exchange", () => {
  const probes = extractProbes(transcript);
  assert.match(probes.ask, /yes/);
  assert.match(probes.reply, /tag v0\.7\.3/);
  assert.ok(probes.facts.length > 0);
});

test("a pack that keeps the decision and the pointers scores well", () => {
  const packText = renderModules([
    mod("state", "state", "Decision: never compact assistant prose; dropping the question broke the thread."),
    mod("files", "files", "src/index.js:120 lib/text.mjs:88 tag v0.7.3"),
  ]);
  const probes = extractProbes(transcript);
  const s = scorePack({ packText, probes, rawTokens: 5000 });
  assert.ok(s.score > 50, `score ${s.score}`);
  assert.ok(s.pointerRecall > 0.9);
  assert.ok(s.ratio < 0.2);
});

test("a pack that loses the exchange is flagged, not silently accepted", () => {
  const packText = "## state\nunrelated chatter about the weather";
  const s = scorePack({ packText, probes: extractProbes(transcript), rawTokens: 5000 });
  assert.equal(s.questionKept, 0);
  assert.equal(s.askKept, false);
});

test("best-of-N picks the pack that keeps the pointers", () => {
  const good = [mod("state", "state", "Decision: never compact assistant prose. Tag v0.7.3?"), mod("files", "files", "src/index.js:120 lib/text.mjs:88")];
  const thin = [mod("state", "state", "We talked about the plugin for a while.")];
  const picked = selectPack([{ name: "thin", modules: thin }, { name: "good", modules: good }], { transcript, rawTokens: 5000 });
  assert.equal(picked.winner.name, "good");
});

test("the recovery module copies lines, never invents them", () => {
  const packText = renderModules([mod("state", "state", "nothing relevant here")]);
  const m = missingFactsModule(packText, transcript);
  assert.ok(m, "expected a recovery module");
  assert.equal(m.kind, "state");
  assert.equal(m.name, "recovered");
  for (const line of m.content.split("\n")) {
    const body = line.replace(/^- /, "").trim();
    if (body) assert.ok(transcript.includes(body), `invented line: ${body}`);
  }
});

test("nothing missing means no recovery module", () => {
  const full = renderModules([mod("state", "state", transcript)]);
  assert.equal(missingFactsModule(full, transcript), null);
});
