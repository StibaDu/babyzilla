// Integration: the loop guard is the mid-loop counterpart to proactive
// compaction. It must fire only when a tool loop is both long and large, and
// must not request a second compaction while the first is cooling down.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "bz-loop-guard-"));
process.env.BABYZILLA_ROOT = root;
process.env.BABYZILLA_LOG = "0";
process.env.BABYZILLA_TABS = path.join(root, "tabs.json");
process.env.BABYZILLA_SELFTUNE_DISABLE = "1";
const { default: plugin } = await import("../index.js");

after(() => {
  try {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  } catch {
    // Windows can still hold a log handle; a temp directory is disposable.
  }
});

async function loadPlugin(options = {}) {
  const contextHooks = [];
  const compactions = [];
  const ctx = {
    options: {
      calibrate: false,
      grounding: false,
      charter: false,
      pet: false,
      checkUpdates: false,
      // Isolate the guard: no proactive compaction competing with it.
      proactiveCompaction: false,
      ...options,
    },
    tool: { hook: async () => {} },
    session: {
      hook: async (name, fn) => { if (name === "context") contextHooks.push(fn); },
      context: async () => [],
      get: async () => ({ directory: "/work" }),
      generate: async () => ({}),
      synthetic: async () => {},
      compact: async (args) => { compactions.push(args); },
    },
    command: { transform: async () => {} },
    generate: { text: async () => "" },
  };
  await plugin.setup(ctx);
  return { contextHooks, compactions };
}

async function run(hooks, event) {
  for (const hook of hooks) await hook(event);
  return event;
}

function loopMessages(assistantTurns, { userLast = false } = {}) {
  const messages = [{ role: "user", content: "start the task" }];
  for (let i = 0; i < assistantTurns; i += 1) {
    messages.push({ role: "assistant", content: `step ${i} ${"x".repeat(80)}` });
  }
  if (userLast) messages.push({ role: "user", content: "next instruction" });
  return messages;
}

function eventFor(sessionID, messages) {
  return {
    sessionID,
    system: [],
    messages,
    model: { id: "test-model", limit: { context: 1_000_000 } },
  };
}

test("a long, large tool loop requests one queued compaction", async () => {
  const { contextHooks, compactions } = await loadPlugin({
    loopGuardTurns: 3,
    loopGuardMinTokens: 1,
    loopGuardCooldownMs: 60_000,
  });
  await run(contextHooks, eventFor("ses_loop_trigger", loopMessages(4)));
  assert.equal(compactions.length, 1);
  assert.deepEqual(compactions[0], { sessionID: "ses_loop_trigger", delivery: "queue" });
});

test("the cooldown prevents a second compaction in the same loop", async () => {
  const { contextHooks, compactions } = await loadPlugin({
    loopGuardTurns: 3,
    loopGuardMinTokens: 1,
    loopGuardCooldownMs: 60_000,
  });
  await run(contextHooks, eventFor("ses_loop_cooldown", loopMessages(4)));
  await run(contextHooks, eventFor("ses_loop_cooldown", loopMessages(8)));
  assert.equal(compactions.length, 1);
});

test("a fresh user turn clears the cooldown for the next loop", async () => {
  const { contextHooks, compactions } = await loadPlugin({
    loopGuardTurns: 3,
    loopGuardMinTokens: 1,
    loopGuardCooldownMs: 60_000,
  });
  await run(contextHooks, eventFor("ses_loop_new_task", loopMessages(4)));
  await run(contextHooks, eventFor("ses_loop_new_task", loopMessages(0, { userLast: true })));
  await run(contextHooks, eventFor("ses_loop_new_task", loopMessages(4)));
  assert.equal(compactions.length, 2);
});

test("loopGuard:false leaves a long loop alone", async () => {
  const { contextHooks, compactions } = await loadPlugin({
    loopGuard: false,
    loopGuardTurns: 3,
    loopGuardMinTokens: 1,
  });
  await run(contextHooks, eventFor("ses_loop_disabled", loopMessages(12)));
  assert.equal(compactions.length, 0);
});

test("a user message resets the guard", async () => {
  const { contextHooks, compactions } = await loadPlugin({
    loopGuardTurns: 3,
    loopGuardMinTokens: 1,
  });
  await run(contextHooks, eventFor("ses_loop_user", loopMessages(8, { userLast: true })));
  assert.equal(compactions.length, 0);
});

test("a short loop does not trigger even when it is large enough", async () => {
  const { contextHooks, compactions } = await loadPlugin({
    loopGuardTurns: 20,
    loopGuardMinTokens: 1,
  });
  await run(contextHooks, eventFor("ses_loop_short", loopMessages(5)));
  assert.equal(compactions.length, 0);
});

test("a long loop below the token floor does not trigger", async () => {
  const { contextHooks, compactions } = await loadPlugin({
    loopGuardTurns: 1,
    loopGuardMinTokens: 1_000_000,
  });
  await run(contextHooks, eventFor("ses_loop_small", loopMessages(6)));
  assert.equal(compactions.length, 0);
});

test("the guard yields to a proactive compaction request made in the same turn", async () => {
  const { contextHooks, compactions } = await loadPlugin({
    proactiveCompaction: true,
    proactiveCompactAtTurnBoundary: false,
    proactiveCompactRatio: 0,
    proactiveCompactMinTokens: 1,
    loopGuardTurns: 3,
    loopGuardMinTokens: 1,
    loopGuardCooldownMs: 60_000,
  });
  await run(contextHooks, eventFor("ses_loop_proactive", loopMessages(4)));
  assert.equal(compactions.length, 1);
});
