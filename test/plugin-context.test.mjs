// Integration probe: load the real plugin with a fake ctx and exercise the
// per-request context hook with a Kimi-K3-sized message list. No model calls,
// no filesystem writes — just the wiring that makes Layer 1b effective.
import test from "node:test";
import assert from "node:assert/strict";
import plugin from "../index.js";
import { estimateMessagesTokens } from "../lib/text.mjs";

async function loadPlugin(options = {}) {
  // Calibration samples go to BABYZILLA_ROOT, which these tests do not
  // sandbox — a fake session must not land in the user's ledger.
  options = { calibrate: false, ...options };
  const handlers = new Map();
  const compactCalls = [];
  const ctx = {
    options,
    tool: { hook: async () => {} },
    session: {
      hook: async (name, fn) => { handlers.set(name, fn); },
      context: async () => [],
      get: async () => ({}),
      generate: async () => ({}),
      synthetic: async () => {},
      compact: async (input) => { compactCalls.push(input); },
    },
    command: { transform: async () => {} },
    generate: { text: async () => "" },
  };
  await plugin.setup(ctx);
  return { handlers, ctx, compactCalls };
}

const numbered = (n) => Array.from({ length: n }, (_, i) => `${i + 1}:   step(${i});`).join("\n");

test("plugin registers a context hook", async () => {
  const { handlers } = await loadPlugin();
  assert.ok(handlers.has("context"));
  assert.ok(handlers.has("compaction"));
  assert.ok(handlers.has("prompt"));
});

test("context hook asks OpenCode to compact proactively on a 1M-token model", async () => {
  const { handlers, compactCalls } = await loadPlugin();
  const bulk = numbered(8000);
  const messages = [{ id: "u0", role: "user", content: [{ type: "text", text: "task" }] }];
  for (let i = 0; i < 26; i++) {
    messages.push({
      id: `m${i}`, role: "assistant", content: [
        { type: "tool-result", id: `c${i}`, name: "read", result: { type: "text", value: bulk } },
      ],
    });
  }
  // A real request starts a turn with the user's message; proactive compaction
  // is deferred to that boundary (never mid-tool-loop).
  messages.push({ id: "u1", role: "user", content: [{ type: "text", text: "continue" }] });
  await handlers.get("context")({
    sessionID: "ses_proactive",
    messages,
    model: { id: "kimi-k3", limit: { context: 1_048_576 } },
  });
  assert.deepEqual(compactCalls, [{ sessionID: "ses_proactive", delivery: "queue" }]);
});

test("context hook caps a 1M-token Kimi K3 session by >90% and keeps the last result", async () => {
  // Budget rewriting is the legacy path; prefix-stable mode is the default
  // (see stable-select.test.mjs) and is asserted separately below.
  const { handlers } = await loadPlugin({ stablePrefix: false });
  const bulk = numbered(8000); // ~39K tokens per result
  const messages = [{ id: "u0", role: "user", content: [{ type: "text", text: "long-horizon task" }] }];
  for (let i = 0; i < 26; i++) {
    messages.push({
      id: `m${i}`, role: "assistant", content: [
        { type: "reasoning", text: "thought ".repeat(2000) },
        { type: "tool-call", id: `c${i}`, name: "read", input: { filePath: `/tmp/f${i}` } },
        { type: "tool-result", id: `c${i}`, name: "read", result: { type: "text", value: bulk } },
      ],
    });
  }
  messages.push({ id: "u1", role: "user", content: [{ type: "text", text: "continue" }] });

  const before = estimateMessagesTokens(messages);
  await handlers.get("context")({ messages, model: { id: "kimi-k3" } });
  const after = estimateMessagesTokens(messages);

  assert.ok(before > 1_000_000, `fixture should be ~1M tokens, got ${before}`);
  assert.ok(after < before * 0.1, `expected >90% reduction, got ${Math.round((1 - after / before) * 100)}%`);
  const lastResult = messages.at(-2).content.find((p) => p.type === "tool-result");
  assert.match(lastResult.result.value, /^1:   step\(0\);/);
  assert.doesNotMatch(lastResult.result.value, /older tool output elided/);
});

test("context hook fits an 8K local model", async () => {
  const { handlers } = await loadPlugin({ stablePrefix: false });
  const bulk = numbered(2000);
  const messages = [{ id: "u0", role: "user", content: [{ type: "text", text: "task" }] }];
  for (let i = 0; i < 8; i++) messages.push({ id: `m${i}`, role: "assistant", content: [{ type: "tool-result", id: `c${i}`, name: "read", result: { type: "text", value: bulk } }] });
  await handlers.get("context")({ sessionID: "ses_small", messages, model: { id: "local-8k", limit: { context: 8192 } } });
  assert.ok(estimateMessagesTokens(messages) <= 4096);
});

test("prefix-stable mode: a second request resends the same bytes for old parts", async () => {
  const { handlers } = await loadPlugin(); // stablePrefix defaults to true
  const bulk = numbered(8000);
  const messages = [{ id: "u0", role: "user", content: [{ type: "text", text: "task" }] }];
  for (let i = 0; i < 6; i++) {
    messages.push({ id: `m${i}`, role: "assistant", content: [{ type: "tool-result", id: `c${i}`, name: "read", result: { type: "text", value: bulk } }] });
  }
  const model = { id: "kimi-k3", limit: { context: 1_000_000 } };
  await handlers.get("context")({ sessionID: "ses_stable", messages, model });
  const afterFirst = JSON.stringify(messages);

  // A new tool result arrives; every already-sent part must keep its exact bytes,
  // which is what keeps the provider's cached prefix valid.
  messages.push({ id: "m6", role: "assistant", content: [{ type: "tool-result", id: "c6", name: "read", result: { type: "text", value: numbered(300) } }] });
  const prefixBefore = JSON.stringify(messages.slice(0, -1));
  await handlers.get("context")({ sessionID: "ses_stable", messages, model });
  const prefixAfter = JSON.stringify(messages.slice(0, -1));

  assert.equal(prefixAfter, prefixBefore, "prefix must be byte-identical between requests");
  assert.ok(estimateMessagesTokens(messages) < estimateMessagesTokens([{ role: "user", content: [{ type: "text", text: "x" }] }, ...messages.slice(1).map((m) => ({ ...m, content: m.content.map((c) => ({ ...c, result: { type: "text", value: bulk } })) }))]),
    "compression must have shrunk the big results");
  assert.ok(!afterFirst.includes(bulk), "the huge result should be paged out on first sight");
});

test("prefix-stable mode still fires as an overflow valve near the window", async () => {
  const { handlers } = await loadPlugin();
  const bulk = numbered(8000);
  const messages = [{ id: "u0", role: "user", content: [{ type: "text", text: "task" }] }];
  for (let i = 0; i < 26; i++) {
    messages.push({ id: `m${i}`, role: "assistant", content: [{ type: "tool-result", id: `c${i}`, name: "read", result: { type: "text", value: bulk } }] });
  }
  const before = estimateMessagesTokens(messages);
  // Window set so the prompt exceeds 90% of it: the valve must trip.
  await handlers.get("context")({ sessionID: "ses_stable2", messages, model: { id: "kimi-k3", limit: { context: Math.round(before / 1.05) } } });
  const after = estimateMessagesTokens(messages);
  assert.ok(after < before * 0.5, `overflow valve should shrink the request, got ${Math.round((1 - after / before) * 100)}%`);
});
