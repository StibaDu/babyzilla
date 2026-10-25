// The pet narrates the model's own reasoning: the plugin's per-request context
// hook must turn the newest assistant reasoning into a `think` event, and must
// stay silent when the option is off. No model calls, no app needed.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import plugin from "../index.js";

async function loadPlugin(options, dir) {
  const handlers = new Map();
  const ctx = {
    options,
    tool: { hook: async () => {} },
    session: {
      hook: async (name, fn) => { handlers.set(name, fn); },
      context: async () => [],
      get: async () => ({}),
      generate: async () => ({}),
      synthesis: async () => {},
      synthetic: async () => {},
      compact: async () => {},
    },
    command: { transform: async () => {} },
    generate: { text: async () => "" },
  };
  const before = process.env.BABYZILLA_PET_STATE;
  process.env.BABYZILLA_PET_STATE = dir;
  const updates = process.env.BABYZILLA_NO_UPDATE_CHECK;
  process.env.BABYZILLA_NO_UPDATE_CHECK = "1";
  try {
    await plugin.setup(ctx);
  } finally {
    if (before === undefined) delete process.env.BABYZILLA_PET_STATE;
    else process.env.BABYZILLA_PET_STATE = before;
    if (updates === undefined) delete process.env.BABYZILLA_NO_UPDATE_CHECK;
    else process.env.BABYZILLA_NO_UPDATE_CHECK = updates;
  }
  return handlers;
}

const events = (dir) => {
  const file = path.join(dir, "events.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
};

const reasoningTurn = (text) => [
  { role: "user", content: [{ type: "text", text: "make the pet talk" }] },
  { role: "assistant", content: [{ type: "reasoning", text }, { type: "tool-call", name: "read" }] },
];

test("pet thoughts: the newest reasoning becomes one short think event", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bz-think-"));
  // The state dir has to be set while the hook runs, not only while setup does.
  process.env.BABYZILLA_PET_STATE = dir;
  try {
    const handlers = await loadPlugin({}, dir);
    await handlers.get("context")({
      sessionID: "ses_think",
      messages: reasoningTurn("```js\nconst x = 1;\n```\nThe user wants me to let the pet talk. I'll add a bubble next."),
      model: { id: "test-model", limit: { context: 200_000 } },
    });

    const thought = events(dir).find((e) => e.kind === "think");
    assert.ok(thought, "a think event was emitted");
    // one line, filler and code gone — the same reducer the pet uses
    assert.equal(thought.text, "Let the pet talk");
    assert.ok(thought.text.length <= 56);
  } finally {
    delete process.env.BABYZILLA_PET_STATE;
  }
});

test("pet thoughts: off means silence, and no reasoning means no event", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bz-think-off-"));
  process.env.BABYZILLA_PET_STATE = dir;
  try {
    const quiet = await loadPlugin({ petThoughts: false }, dir);
    await quiet.get("context")({
      sessionID: "ses_quiet",
      messages: reasoningTurn("The user wants me to let the pet talk."),
      model: { id: "test-model", limit: { context: 200_000 } },
    });
    assert.equal(events(dir).filter((e) => e.kind === "think").length, 0, "petThoughts:false stays quiet");

    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "bz-think-none-"));
    process.env.BABYZILLA_PET_STATE = dir2;
    const handlers = await loadPlugin({}, dir2);
    await handlers.get("context")({
      sessionID: "ses_silent",
      messages: [
        { role: "user", content: [{ type: "text", text: "hi" }] },
        { role: "assistant", content: [{ type: "text", text: "no reasoning here" }] },
      ],
      model: { id: "test-model", limit: { context: 200_000 } },
    });
    assert.equal(events(dir2).filter((e) => e.kind === "think").length, 0, "nothing to narrate");
  } finally {
    delete process.env.BABYZILLA_PET_STATE;
  }
});
