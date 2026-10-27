// Grounding — the "don't guess, verify" instruction.
//
// Two layers, both cheap to verify without a model:
//   1. `groundSystem` is pure: it appends one system part, at most once.
//   2. The plugin registers a hook that calls it for every request, and that
//      hook must survive odd events and must not be gated behind compression.
//
// Same isolation pattern as the other plugin tests: BABYZILLA_ROOT is set before
// the dynamic import, and node --test gives each file its own process.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { GROUNDING_MARK, GROUNDING_TEXT, groundSystem } from "../lib/grounding.mjs";

// ── the pure part ───────────────────────────────────────────────────────────

test("grounding: appends one system part and reports the change", () => {
  const system = [{ type: "text", text: "You are opencode." }];
  assert.equal(groundSystem(system), true);
  assert.equal(system.length, 2);
  assert.equal(system[1].type, "text");
  assert.equal(system[1].text, GROUNDING_TEXT);
  assert.ok(system[1].text.startsWith(GROUNDING_MARK), "the marker leads, so duplicates are findable");
});

test("grounding: never adds the instruction twice", () => {
  const system = [];
  assert.equal(groundSystem(system), true);
  assert.equal(groundSystem(system), false);
  assert.equal(system.length, 1, "a second call must not stack a second instruction");
});

test("grounding: the marker is found even if a host re-wrapped the part", () => {
  // A host that splits or prefixes system text still must not get two copies.
  const system = [{ type: "text", text: `Policy header.\n${GROUNDING_TEXT}` }];
  assert.equal(groundSystem(system), false);
});

test("grounding: a request without a system array is left alone", () => {
  for (const odd of [undefined, null, "text", {}, 42]) {
    assert.equal(groundSystem(odd), false, `no throw and no change for ${String(odd)}`);
  }
});

test("grounding: the instruction names the failure modes, without a speech act it cannot keep", () => {
  assert.match(GROUNDING_TEXT, /not certain/i);
  assert.match(GROUNDING_TEXT, /verify it/i);
  assert.match(GROUNDING_TEXT, /[Nn]ever present a guess as a fact/);
  assert.match(GROUNDING_TEXT, /estimate/i, "estimates are labelled, not banned");
  assert.match(GROUNDING_TEXT, /premise looks wrong/i);
  assert.match(GROUNDING_TEXT, /check what you can check yourself/i);
  assert.doesNotMatch(GROUNDING_TEXT, /always be (?:truthful|correct)/i,
    "an instruction must not promise something a model cannot guarantee");
});

// ── the hook ────────────────────────────────────────────────────────────────

const root = await fs.mkdtemp(path.join(os.tmpdir(), "bz-grounding-"));
process.env.BABYZILLA_ROOT = path.join(root, "ctx");
const { default: plugin } = await import("../index.js");

/** Every handler registered for a hook name, in registration order. */
async function load(options = {}) {
  const handlers = new Map();
  await plugin.setup({
    options,
    tool: { hook: async () => {} },
    session: {
      hook: async (name, fn) => {
        if (!handlers.has(name)) handlers.set(name, []);
        handlers.get(name).push(fn);
      },
      context: async () => [],
    },
    client: { app: { info: async () => ({ directory: root }) } },
  });
  return handlers;
}

async function runContext(handlers, event) {
  for (const fn of handlers.get("context") ?? []) await fn(event);
  return event;
}

test("grounding: the context hook adds the instruction to every request", async () => {
  const handlers = await load();
  assert.ok((handlers.get("context") ?? []).length >= 1, "a context hook is registered");
  const event = await runContext(handlers, {
    sessionID: "ses_g1",
    model: { id: "test-model", limit: { context: 128000 } },
    system: [{ type: "text", text: "You are opencode." }],
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  });
  const parts = event.system.filter((p) => String(p?.text ?? "").includes(GROUNDING_MARK));
  assert.equal(parts.length, 1, "exactly one grounding part, however many hooks ran");
});

test("grounding: it is not gated behind request compression", async () => {
  const handlers = await load({ requestCompression: false });
  const event = await runContext(handlers, {
    sessionID: "ses_g2",
    system: [{ type: "text", text: "You are opencode." }],
    messages: [],
  });
  assert.equal(
    event.system.filter((p) => String(p?.text ?? "").includes(GROUNDING_MARK)).length,
    1,
    "turning compression off must not turn honesty off",
  );
});

test("grounding: it can be disabled explicitly", async () => {
  const handlers = await load({ grounding: false });
  const event = await runContext(handlers, {
    sessionID: "ses_g3",
    system: [{ type: "text", text: "You are opencode." }],
    messages: [],
  });
  assert.equal(event.system.length, 1);
});

test("grounding: a malformed event never breaks the request", async () => {
  const handlers = await load();
  for (const event of [{}, { system: null }, { system: "nope" }]) {
    await runContext(handlers, event); // must not throw
  }
});
