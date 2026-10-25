// The prefix-cache contract. Providers discount a prompt prefix only when it is
// byte-identical to the previous request, so compression must be a pure
// function of each part's own content:
//
//   1. position-independent: same part, same decision wherever it sits
//   2. monotone: once compressed, never reverts as history grows
//   3. byte-stable: identical replacement text at every later request
//
// Breaking any of these converts 2%-priced cached input into full-price input,
// which is how "45% fewer tokens" became "4% more credits" in bench/RESULTS.md.
import { test } from "node:test";
import assert from "node:assert/strict";
import { selectStableParts, compressToolResult, estTokens } from "../lib/text.mjs";

function big(n, tag = "L") {
  return Array.from({ length: n }, (_, i) => `${tag}${i}: alpha beta gamma delta epsilon ${"x".repeat(40)}`).join("\n");
}

function part(text, id) {
  return { id, type: "tool", name: "read", state: { status: "completed", output: text } };
}

function messages(parts) {
  return [
    { role: "user", content: [{ type: "text", text: "go" }] },
    ...parts.map((p) => ({ role: "assistant", content: [p] })),
  ];
}

const OPTS = { toolResultMinTokens: 4000, toolResultHeadLines: 5, toolResultTailLines: 5 };

test("selection ignores position: a part is decided on its own size", () => {
  const bigPart = part(big(400), "big");
  const smallPart = part(big(20), "small");

  const early = selectStableParts(messages([bigPart, smallPart]), OPTS);
  const late = selectStableParts(messages([smallPart, part(big(300), "filler"), bigPart]), OPTS);

  assert.deepEqual(early.map((p) => p.id), ["big"]);
  assert.ok(late.some((p) => p.id === "big"), "big part must be selected wherever it sits");
  assert.ok(!late.some((p) => p.id === "small"), "small part must never be selected");
});

test("selection is monotone as the conversation grows", () => {
  const parts = [part(big(400), "a"), part(big(20), "b"), part(big(500), "c")];
  const seen = [new Set(), new Set(), new Set()];
  for (let n = 1; n <= parts.length; n++) {
    for (const p of selectStableParts(messages(parts.slice(0, n)), OPTS)) seen[n - 1].add(p.id);
  }
  for (let n = 1; n < parts.length; n++) {
    for (const id of seen[n - 1]) {
      assert.ok(seen[n].has(id), `${id} was compressed then reverted at step ${n + 1}`);
    }
  }
});

test("replacement bytes are identical at every later request", () => {
  // Same original text, arriving at a different position in history, must
  // produce byte-identical compressed output — otherwise every request with a
  // new tool result invalidates the whole cached prefix.
  const text = big(400);
  const first = part(text, "x");
  const later = part(text, "x");

  compressToolResult(first, OPTS, null, "deadbeefdeadbeef");
  compressToolResult(later, OPTS, null, "deadbeefdeadbeef");

  assert.equal(first.state.output, later.state.output);
  assert.ok(first.state.output.includes("[ContextPack]"));
  assert.ok(first.state.output.includes("babyzilla recall deadbeefdeadbeef"));
  assert.ok(estTokens(first.state.output) < estTokens(text) * 0.75);
});

test("compressing twice is a no-op (idempotent, so history stays frozen)", () => {
  const p = part(big(400), "y");
  const opts = { ...OPTS, toolResultMinTokens: 100 };
  assert.equal(compressToolResult(p, opts, null, "feedfacefeedface"), 1);
  const once = p.state.output;
  assert.equal(compressToolResult(p, opts, null, "feedfacefeedface"), 0);
  assert.equal(p.state.output, once);
});

// The production path: API-shaped parts (result.value) rewritten by the
// `context` hook. Same bytes in must produce same bytes out on every request,
// otherwise the provider cache misses and the "saving" costs money.
test("applyStableCompression is deterministic and idempotent on API parts", async () => {
  const { applyStableCompression } = await import("../lib/text.mjs");
  const text = big(400);
  const mk = () => [
    { role: "user", content: [{ type: "text", text: "go" }] },
    { role: "assistant", content: [{ type: "tool-result", name: "read", result: { type: "text", value: text } }] },
  ];
  const opts = { toolResultMinTokens: 4000, toolResultHeadLines: 5, toolResultTailLines: 5 };
  const ref = () => "abcdabcdabcdabcd";

  const a = mk();
  const b = mk();
  const s1 = applyStableCompression(a, opts, ref);
  const s2 = applyStableCompression(b, opts, ref);
  assert.equal(s1.parts, 1);
  assert.equal(a[1].content[0].result.value, b[1].content[0].result.value);
  assert.ok(s1.after < s1.before);

  // Second pass over already-rewritten history must be a no-op.
  const again = applyStableCompression(a, opts, ref);
  assert.equal(again.parts, 0);
  assert.equal(a[1].content[0].result.value, b[1].content[0].result.value);
});

test("a part compressed early keeps identical bytes after later results arrive", async () => {
  const { applyStableCompression } = await import("../lib/text.mjs");
  const opts = { toolResultMinTokens: 4000, toolResultHeadLines: 5, toolResultTailLines: 5 };
  const ref = () => "beadbeadbeadbead";
  const messages = [
    { role: "user", content: [{ type: "text", text: "go" }] },
    { role: "assistant", content: [{ type: "tool-result", name: "read", result: { type: "text", value: big(400, "first") } }] },
  ];
  applyStableCompression(messages, opts, ref);
  const first = messages[1].content[0].result.value;

  // Later turns append; the already-sent part must not change at all.
  messages.push({ role: "user", content: [{ type: "text", text: "next" }] });
  messages.push({ role: "assistant", content: [{ type: "tool-result", name: "read", result: { type: "text", value: big(500, "second") } }] });
  applyStableCompression(messages, opts, ref);
  assert.equal(messages[1].content[0].result.value, first, "early part must stay byte-identical");
  assert.ok(messages[3].content[0].result.value.includes("[ContextPack]"));
});
