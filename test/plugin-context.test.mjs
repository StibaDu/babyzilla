// Integration probe: load the real plugin with a fake ctx and exercise the
// per-request context hook with a Kimi-K3-sized message list. No model calls,
// no filesystem writes — just the wiring that makes Layer 1b effective.
import test from "node:test";
import assert from "node:assert/strict";
import plugin from "../index.js";
import { estimateMessagesTokens } from "../lib/text.mjs";

async function loadPlugin(options = {}) {
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
  await handlers.get("context")({
    sessionID: "ses_proactive",
    messages,
    model: { id: "kimi-k3", limit: { context: 1_048_576 } },
  });
  assert.deepEqual(compactCalls, [{ sessionID: "ses_proactive", delivery: "queue" }]);
});

test("context hook caps a 1M-token Kimi K3 session by >90% and keeps the last result", async () => {
  const { handlers } = await loadPlugin();
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
