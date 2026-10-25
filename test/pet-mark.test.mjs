// The status mark: one badge that says what the last turn needs from you, and
// keeps saying it until you decide something. These tests cover the three things
// that can go wrong — reading an ending wrong, losing the badge on a restart, and
// forgetting to take it down when the human answers.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import plugin from "../index.js";
import { MARKS, classifyTurn, lastAnswer, readMark, writeMark } from "../lib/pet-mark.mjs";

const events = (dir) => {
  const file = path.join(dir, "events.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
};

/**
 * The plugin with every hook it registers captured, plus a pet state dir.
 * `answer` is what the fake transcript ends with, `events` the fake server stream.
 */
async function loadPlugin(dir, { answer = null, events = [] } = {}) {
  const hooks = new Map();
  const ctx = {
    options: {},
    tool: { hook: async (name, fn) => { hooks.set(name, fn); } },
    session: {
      hook: async (name, fn) => { hooks.set(name, fn); },
      context: async () => (answer
        ? [{ role: "assistant", content: [{ type: "reasoning", text: "hmm" }, { type: "text", text: answer() }] }]
        : []),
      get: async () => ({}),
      generate: async () => ({}),
      synthesis: async () => {},
      synthetic: async () => {},
      compact: async () => {},
    },
    event: { subscribe: () => events },
    command: { transform: async () => {} },
    generate: { text: async () => "" },
  };
  const before = process.env.BABYZILLA_PET_STATE;
  const updates = process.env.BABYZILLA_NO_UPDATE_CHECK;
  process.env.BABYZILLA_PET_STATE = dir;
  process.env.BABYZILLA_NO_UPDATE_CHECK = "1";
  try {
    await plugin.setup(ctx);
  } finally {
    if (before === undefined) delete process.env.BABYZILLA_PET_STATE;
    else process.env.BABYZILLA_PET_STATE = before;
    if (updates === undefined) delete process.env.BABYZILLA_NO_UPDATE_CHECK;
    else process.env.BABYZILLA_NO_UPDATE_CHECK = updates;
  }
  return hooks;
}

const settle = async (want) => {
  for (let i = 0; i < 60; i++) {
    if (want()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
};

const idle = (sessionID) => ({ type: "session.idle", properties: { sessionID } });

test("mark: a question is the only thing read into the ending", () => {
  assert.equal(classifyTurn("Done. Want me to ship it?"), "question");
  assert.equal(classifyTurn("Ready — say the word?"), "question");
  assert.equal(classifyTurn('All green, right?"'), "question");
  assert.equal(classifyTurn("Shipped as v0.28.0."), "done");
  // a question mark in the middle is the model thinking, not asking its human
  assert.equal(classifyTurn("I asked myself: why? Then I fixed it."), "done");
  assert.equal(classifyTurn(""), "done");
  assert.equal(classifyTurn(null), "done");
});

test("mark: the newest answer is read from either message shape", () => {
  const content = [
    { role: "user", content: [{ type: "text", text: "go" }] },
    { role: "assistant", content: [{ type: "reasoning", text: "hmm" }, { type: "text", text: "Want me to dig?" }] },
  ];
  assert.equal(lastAnswer(content), "Want me to dig?");
  assert.equal(classifyTurn(lastAnswer(content)), "question");
  // parts[] is the other shape a host sends, and the reasoning is not the answer
  const parts = [{ type: "assistant", parts: [{ type: "reasoning", text: "hmm" }, { type: "text", text: "Done." }] }];
  assert.equal(lastAnswer(parts), "Done.");
  assert.equal(lastAnswer([]), "");
  assert.equal(lastAnswer(null), "");
});

test("mark: written atomically, read back, and a broken file means nothing", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bz-mark-"));
  assert.equal(readMark(dir), null);
  for (const kind of MARKS) {
    assert.equal(writeMark(dir, kind), true);
    assert.equal(readMark(dir), kind);
  }
  writeMark(dir, null);
  assert.equal(readMark(dir), null);
  // an unknown value is not a mark: a hand-edited file must not invent a badge
  fs.writeFileSync(path.join(dir, "mark.json"), JSON.stringify({ mark: "party" }));
  assert.equal(readMark(dir), null);
  fs.writeFileSync(path.join(dir, "mark.json"), "{not json");
  assert.equal(readMark(dir), null);
  // atomic means no half-written temp files are left lying around
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith(".tmp")), []);
});

test("mark: the human's next prompt clears the badge", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bz-mark-prompt-"));
  process.env.BABYZILLA_PET_STATE = dir;
  try {
    writeMark(dir, "question");
    const hooks = await loadPlugin(dir);
    await hooks.get("prompt")({ sessionID: "ses_mark", prompt: { text: "yes, ship it", files: [] } });
    // whatever the badge was waiting for, a prompt *is* the decision
    assert.equal(readMark(dir), null);
    assert.equal(events(dir).filter((e) => e.kind === "mark").pop()?.mark, null);
    // even a prompt with no text (an image, a paste) counts
    writeMark(dir, "question");
    await hooks.get("prompt")({ sessionID: "ses_mark", prompt: { text: "", files: [] } });
    assert.equal(readMark(dir), null);
  } finally {
    delete process.env.BABYZILLA_PET_STATE;
  }
});

test("mark: a turn that ends on a question holds up ? until the human answers", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bz-mark-idle-"));
  process.env.BABYZILLA_PET_STATE = dir;
  // the answer changes between the two turn ends the fake stream reports
  let answer = "Shipped as v0.28.0.";
  // the stream is gated: an idle event only means something after a human prompt
  let releaseFirst, releaseSecond;
  const first = new Promise((r) => { releaseFirst = r; });
  const second = new Promise((r) => { releaseSecond = r; });
  const stream = (async function* () {
    await first;
    yield idle("ses_turn");
    await second;
    yield idle("ses_turn");
  })();
  try {
    const hooks = await loadPlugin(dir, { answer: () => answer, events: stream });
    const prompt = hooks.get("prompt");
    await prompt({ sessionID: "ses_turn", prompt: { text: "do the thing", files: [] } });
    assert.equal(readMark(dir), null);
    releaseFirst();
    await settle(() => readMark(dir) != null);
    // the turn ended on a statement
    assert.equal(readMark(dir), "done");
    assert.equal(events(dir).filter((e) => e.kind === "mark").pop()?.mark, "done");

    // the human decides something: the badge goes away, whatever it was
    await prompt({ sessionID: "ses_turn", prompt: { text: "and now the other thing", files: [] } });
    assert.equal(readMark(dir), null);

    answer = "Want me to ship it?";
    releaseSecond();
    await settle(() => readMark(dir) != null);
    assert.equal(readMark(dir), "question");
    assert.equal(events(dir).filter((e) => e.kind === "mark").pop()?.mark, "question");
  } finally {
    delete process.env.BABYZILLA_PET_STATE;
  }
});

test("mark: a failed tool raises the badge, a later success takes it back", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bz-mark-tool-"));
  process.env.BABYZILLA_PET_STATE = dir;
  try {
    const hooks = await loadPlugin(dir);
    const after = hooks.get("execute.after");
    assert.ok(after, "the plugin must register the tool outcome hook");
    await after({ sessionID: "ses_mark2", tool: "bash", result: "", error: { message: "exit 1" }, status: "error" });
    assert.equal(readMark(dir), "error");
    assert.equal(events(dir).filter((e) => e.kind === "mark").pop()?.mark, "error");
    // a later success in the same turn is the dino's cue that it was dealt with
    await after({ sessionID: "ses_mark2", tool: "bash", result: "ok", status: "completed" });
    assert.equal(events(dir).filter((e) => e.kind === "mark").pop()?.mark, null);
  } finally {
    delete process.env.BABYZILLA_PET_STATE;
  }
});
