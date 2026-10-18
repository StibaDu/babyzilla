// Pure-helper tests — no plugin load, no filesystem, no model calls.
import test from "node:test";
import assert from "node:assert/strict";
import { estTokens, compressToolText, compressToolResult, routeDistill, selectCompressibleParts, compactMessagesForRequest, compressTextBlock } from "../lib/text.mjs";

// ── estTokens ───────────────────────────────────────────────────────────────

test("estTokens rounds up at 4 chars/token and treats empty as zero", () => {
  assert.equal(estTokens(""), 0);
  assert.equal(estTokens(null), 0);
  assert.equal(estTokens("abcd"), 1);
  assert.equal(estTokens("abcde"), 2);
});

test("estTokens counts non-ASCII text at ~1 token per character", () => {
  // 8 CJK chars ≈ 8 tokens, not 2.
  assert.equal(estTokens("\u4f60\u597d\u4e16\u754c\u4f60\u597d\u4e16\u754c"), 8);
  // Mixed text keeps the ASCII part at 4 chars/token.
  assert.equal(estTokens("abcd\u4f60\u597d"), 3);
});

// ── compressToolText ────────────────────────────────────────────────────────

const numbered = (n) => Array.from({ length: n }, (_, i) => `${i + 1}:   step(${i});`).join("\n");

test("compressToolText leaves short input untouched", () => {
  assert.equal(compressToolText(numbered(50), { headLines: 40, tailLines: 20 }), null);
});

test("compressToolText keeps head and tail and elides the middle", () => {
  const out = compressToolText(numbered(300), { headLines: 10, tailLines: 5 });
  assert.ok(out, "expected a compression");
  assert.match(out, /^1:   step\(0\);/);
  assert.match(out, /\n10:   step\(9\);/);
  assert.match(out, /\n300:   step\(299\);/);
  assert.match(out, /285 lines elided by ContextPack — not truncation/);
  assert.ok(out.split("\n").length < 60, "should be far shorter than 300 lines");
});

test("compressToolText keeps structural lines from the elided middle", () => {
  const lines = Array.from({ length: 300 }, (_, i) => `${i + 1}:   step(${i});`);
  lines[149] = "150: export function important() {";
  lines[150] = "151: class Widget {";
  const out = compressToolText(lines.join("\n"), { headLines: 10, tailLines: 5 });
  assert.ok(out);
  assert.match(out, /150: export function important\(\) \{/);
  assert.match(out, /151: class Widget \{/);
});

test("compressToolText keeps diagnostic and TODO lines", () => {
  const lines = Array.from({ length: 300 }, (_, i) => `${i + 1}:   step(${i});`);
  lines[199] = "200: [ERROR] FATAL: kernel panic";
  lines[200] = "201: TODO: remove this hack";
  lines[201] = "202: ERR-4471-BADGE rejected";
  const out = compressToolText(lines.join("\n"), { headLines: 10, tailLines: 5 });
  assert.ok(out);
  assert.match(out, /\[ERROR\] FATAL: kernel panic/);
  assert.match(out, /TODO: remove this hack/);
  assert.match(out, /ERR-4471-BADGE rejected/);
});

test("compressToolText refuses a rewrite that saves under 15%", () => {
  // 100 lines, 90 structural: the elision would not pay off.
  const lines = Array.from({ length: 100 }, (_, i) => `${i + 1}: export const v${i} = ${i};`);
  const out = compressToolText(lines.join("\n"), { headLines: 2, tailLines: 2 });
  assert.equal(out, null);
});

test("compressToolText preserves line numbers after elision", () => {
  const out = compressToolText(numbered(200), { headLines: 5, tailLines: 5 });
  assert.ok(out);
  const keptNumbers = out
    .split("\n")
    .map((l) => /^(\d+):/.exec(l)?.[1])
    .filter(Boolean)
    .map(Number);
  // first five and last five, in order
  assert.deepEqual(keptNumbers, [1, 2, 3, 4, 5, 196, 197, 198, 199, 200]);
});

// ── compressToolResult ──────────────────────────────────────────────────────

const longText = (n) => Array.from({ length: n }, (_, i) => `${i + 1}:   step(${i});`).join("\n");
const opts = { toolResultMinTokens: 1200, toolResultHeadLines: 10, toolResultTailLines: 5 };

test("compressToolResult rewrites a large part in place", () => {
  const event = { tool: "read", result: { content: [{ type: "text", text: longText(400) }] } };
  const seen = [];
  const n = compressToolResult(event, opts, (...args) => seen.push(args));
  assert.equal(n, 1);
  const text = event.result.content[0].text;
  assert.match(text, /elided by ContextPack — not truncation/);
  assert.match(text, /\[ContextPack\] 1\.\dK → \d+\w? tokens/);
  assert.equal(seen.length, 1);
  assert.equal(seen[0][0], "read");
});

test("compressToolResult leaves small results untouched", () => {
  const event = { tool: "read", result: { content: [{ type: "text", text: longText(40) }] } };
  assert.equal(compressToolResult(event, opts), 0);
  assert.equal(event.result.content[0].text, longText(40));
});

test("compressToolResult ignores events without a content array", () => {
  assert.equal(compressToolResult({ tool: "read", result: {} }, opts), 0);
  assert.equal(compressToolResult({}, opts), 0);
});

test("compressToolResult only rewrites the large parts of a mixed result", () => {
  const small = "short output";
  const big = longText(400);
  const event = { tool: "grep", result: { content: [{ type: "text", text: small }, { type: "text", text: big }, { type: "text" }] } };
  assert.equal(compressToolResult(event, opts), 1);
  assert.equal(event.result.content[0].text, small);
  assert.match(event.result.content[1].text, /elided by ContextPack/);
  assert.equal(event.result.content[2].text, undefined);
});

test("compressToolResult is idempotent", () => {
  const event = { tool: "read", result: { content: [{ type: "text", text: longText(400) }] } };
  assert.equal(compressToolResult(event, opts), 1);
  const once = event.result.content[0].text;
  assert.equal(compressToolResult(event, opts), 0);
  assert.equal(event.result.content[0].text, once);
});

// ── selectCompressibleParts ─────────────────────────────────────────────────

const toolPart = (id, text) => ({ type: "tool", id, name: "read", state: { content: [{ type: "text", text }] } });
const assistant = (...parts) => ({ type: "assistant", content: parts });

test("selectCompressibleParts protects the most recent results", () => {
  const messages = [
    { type: "user", text: "hi" },
    assistant(toolPart("a", "A"), toolPart("b", "B"), toolPart("c", "C")),
  ];
  const picked = selectCompressibleParts(messages, 2);
  assert.deepEqual(picked.map((p) => p.id), ["a"]);
});

test("selectCompressibleParts skips parts that are already compressed", () => {
  const messages = [assistant(
    toolPart("a", "A"),
    toolPart("b", "B\n\n[ContextPack] compressed"),
    toolPart("c", "C"),
  )];
  const picked = selectCompressibleParts(messages, 1);
  assert.deepEqual(picked.map((p) => p.id), ["a"]);
});

test("selectCompressibleParts ignores non-tool and text parts", () => {
  const messages = [
    { type: "user", text: "hi" },
    assistant({ type: "text", text: "thinking" }, { type: "tool", id: "x" }),
  ];
  assert.deepEqual(selectCompressibleParts(messages, 0), []);
});

test("selectCompressibleParts can restrict to specific tools", () => {
  const messages = [assistant(
    { type: "tool", id: "s", name: "shell", state: { content: [{ type: "text", text: "sh" }] } },
    toolPart("r", "R"),
  )];
  assert.deepEqual(selectCompressibleParts(messages, 0, new Set(["read"])).map((p) => p.id), ["r"]);
});

test("selectCompressibleParts with protectRecent 0 returns all eligible parts", () => {
  const messages = [assistant(toolPart("a", "A"), toolPart("b", "B"))];
  assert.deepEqual(selectCompressibleParts(messages, 0).map((p) => p.id), ["a", "b"]);
  assert.deepEqual(selectCompressibleParts(null, 1), []);
});

// ── routeDistill ────────────────────────────────────────────────────────────

const ok = (value) => async () => value;
const boom = (msg) => async () => { throw new Error(msg); };

test("routeDistill uses the session-less route first by default", async () => {
  let sessionCalls = 0;
  const out = await routeDistill({
    viaText: ok("text"),
    viaSession: async () => { sessionCalls++; return "session"; },
    preferSession: false,
  });
  assert.equal(out, "text");
  assert.equal(sessionCalls, 0);
});

test("routeDistill falls back to the session route when the text route fails", async () => {
  const errors = [];
  const out = await routeDistill({
    viaText: boom("free tier"),
    viaSession: ok("session"),
    preferSession: false,
    onError: (route, err) => errors.push([route, err.message]),
  });
  assert.equal(out, "session");
  assert.deepEqual(errors, [["text", "free tier"]]);
});

test("routeDistill prefers the session route when asked", async () => {
  let textCalls = 0;
  const out = await routeDistill({
    viaText: async () => { textCalls++; return "text"; },
    viaSession: ok("session"),
    preferSession: true,
  });
  assert.equal(out, "session");
  assert.equal(textCalls, 0);
});

test("routeDistill falls back to the text route when the session route fails", async () => {
  const errors = [];
  const out = await routeDistill({
    viaText: ok("text"),
    viaSession: boom("no session"),
    preferSession: true,
    onError: (route, err) => errors.push([route, err.message]),
  });
  assert.equal(out, "text");
  assert.deepEqual(errors, [["session", "no session"]]);
});

test("routeDistill does not fall back when allowFallback is false", async () => {
  let sessionCalls = 0;
  await assert.rejects(
    routeDistill({
      viaText: boom("strict"),
      viaSession: async () => { sessionCalls++; return "session"; },
      preferSession: false,
      allowFallback: false,
    }),
    /strict/,
  );
  assert.equal(sessionCalls, 0);
});

// ── Layer 1b: per-request compaction ───────────────────────────────────────

test("compressTextBlock keeps a head and tail with a marker", () => {
  const text = "A".repeat(5000) + "TAIL";
  const out = compressTextBlock(text, { headChars: 100, tailChars: 20 });
  assert.ok(out);
  assert.ok(out.startsWith("A".repeat(100)));
  assert.match(out, /\d+ chars elided by ContextPack/);
  assert.ok(out.endsWith("TAIL"));
  assert.equal(compressTextBlock("short"), null);
});

const numberedText = (n) => Array.from({ length: n }, (_, i) => `${i + 1}:   step(${i});`).join("\n");
const llmToolResult = (id, text) => ({
  type: "tool-result", id, name: "read", result: { type: "text", value: text },
});
const llmAssistant = (...parts) => ({ id: `msg-${Math.random()}`, role: "assistant", content: parts });
const llmUser = (text) => ({ id: `msg-${Math.random()}`, role: "user", content: [{ type: "text", text }] });

test("compactMessagesForRequest is a no-op under the budget", () => {
  const messages = [llmUser("hi"), llmAssistant({ type: "text", text: "small" })];
  const stats = compactMessagesForRequest(messages, { requestBudgetTokens: 45_000 });
  assert.equal(stats.saved, 0);
  assert.equal(stats.before, stats.after);
});

test("compactMessagesForRequest compresses old tool output but protects recent messages", () => {
  const big = numberedText(4000);
  const old = llmAssistant(llmToolResult("a", big));
  const recent = llmAssistant(llmToolResult("b", big));
  const messages = [llmUser("task"), old, recent];
  const stats = compactMessagesForRequest(messages, {
    requestBudgetTokens: 10_000, requestMinTokens: 1000, requestProtectRecent: 1,
    toolResultHeadLines: 10, toolResultTailLines: 5, requestPartMinTokens: 100,
  });
  assert.ok(stats.saved > 0);
  assert.match(old.content[0].result.value, /elided by ContextPack/);
  assert.doesNotMatch(recent.content[0].result.value, /older tool output elided/);
  assert.match(recent.content[0].result.value, /1:   step\(0\)/, "newest message keeps structural content");
  assert.equal(messages[0].content[0].text, "task", "user turns are never rewritten");
});

test("compactMessagesForRequest reaches a hard budget and saves >90% on a huge window", () => {
  const bulk = numberedText(4000); // ~5K tokens each
  const messages = [llmUser("long task")];
  for (let i = 0; i < 120; i++) messages.push(llmAssistant(llmToolResult(`t${i}`, bulk)));
  const stats = compactMessagesForRequest(messages, {
    requestBudgetTokens: 45_000, requestMinTokens: 1000, requestProtectRecent: 6,
    requestHardProtect: 1,
    toolResultHeadLines: 10, toolResultTailLines: 5, requestPartMinTokens: 100,
  });
  assert.ok(stats.after <= 45_000, `after ${stats.after} should be within budget`);
  assert.ok(stats.savedPct >= 90, `expected >=90% saved, got ${stats.savedPct}%`);
  assert.ok(stats.parts > 100);
});

test("compactMessagesForRequest uses the target ratio for medium contexts", () => {
  const bulk = numberedText(800); // ~3.9K tokens each
  const messages = [llmUser("task")];
  for (let i = 0; i < 8; i++) messages.push(llmAssistant(llmToolResult(`t${i}`, bulk)));
  // ~31K in → ratio budget 10% ≈ 3.1K, floored to 5K → roughly 84% smaller.
  const stats = compactMessagesForRequest(messages, {
    requestBudgetTokens: 45_000, requestTargetRatio: 0.1, requestMinBudgetTokens: 5_000,
    requestMinTokens: 1000, requestProtectRecent: 6, requestHardProtect: 1,
    toolResultHeadLines: 5, toolResultTailLines: 2, requestPartMinTokens: 100,
  });
  assert.ok(stats.savedPct >= 70, `got ${stats.savedPct}%`);
  assert.ok(stats.after <= 5_000, `after ${stats.after}`);
});

test("compactMessagesForRequest is idempotent across calls", () => {
  const bulk = numberedText(4000);
  const messages = [llmUser("task")];
  for (let i = 0; i < 20; i++) messages.push(llmAssistant(llmToolResult(`t${i}`, bulk)));
  const opts = {
    requestBudgetTokens: 10_000, requestMinTokens: 1000, requestProtectRecent: 2,
    toolResultHeadLines: 5, toolResultTailLines: 2, requestPartMinTokens: 100,
  };
  const first = compactMessagesForRequest(messages, opts);
  assert.ok(first.saved > 0);
  const snapshot = JSON.stringify(messages);
  const second = compactMessagesForRequest(messages, opts);
  assert.equal(second.saved, 0);
  assert.equal(JSON.stringify(messages), snapshot);
});

test("compactMessagesForRequest elides old reasoning and attachments, never signed reasoning", () => {
  const messages = [
    llmUser("task"),
    llmAssistant(
      { type: "reasoning", text: "x".repeat(20_000) },
      { type: "reasoning", text: "signed", encrypted: "SIG" },
      { type: "media", filename: "shot.png", media: {} },
      { type: "text", text: "done" },
    ),
    llmAssistant({ type: "tool-result", id: "z", name: "read", result: { type: "text", value: "recent" } }),
  ];
  compactMessagesForRequest(messages, {
    requestBudgetTokens: 1000, requestTargetRatio: 0, requestMinTokens: 100, requestProtectRecent: 1,
    requestElideReasoning: true, requestElideAttachments: true,
  });
  const parts = messages[1].content;
  // Paged-out reasoning is announced once, then blanked to save tokens.
  assert.match(parts[0].text, /reasoning elided|^$/);
  assert.equal(parts[1].text, "signed", "encrypted reasoning must be preserved");
  assert.equal(parts[2].type, "text");
  assert.match(parts[2].text, /attachment elided/);
});

test("compactMessagesForRequest also handles the OpenCode API tool shape", () => {
  const apiPart = { type: "tool", id: "x", name: "read", state: { content: [{ type: "text", text: numberedText(3000) }] } };
  const messages = [llmUser("task"), { type: "assistant", content: [apiPart] }, llmUser("latest")];
  const stats = compactMessagesForRequest(messages, {
    requestBudgetTokens: 1000, requestMinTokens: 100, requestProtectRecent: 1,
    toolResultHeadLines: 5, toolResultTailLines: 2, requestPartMinTokens: 100,
  });
  assert.ok(stats.saved > 0);
  assert.match(apiPart.state.content[0].text, /ContextPack/);
});


test("compactMessagesForRequest clamps the budget to a small model window", () => {
  const messages = [llmUser("task")];
  for (let i = 0; i < 8; i++) {
    messages.push(llmAssistant({ type: "tool-result", id: `c${i}`, name: "read", result: { type: "text", value: numberedText(4000) } }));
  }
  messages.push(llmUser("latest"));
  const stats = compactMessagesForRequest(messages, {
    requestBudgetTokens: 45_000, requestMinTokens: 20_000, requestTargetRatio: 0,
    requestProtectRecent: 1, modelContext: 8000, requestMaxPromptRatio: 0.5,
  });
  assert.ok(stats.before > 4000);
  assert.ok(stats.after <= 4000, `after=${stats.after} must fit half of an 8K window`);
});

test("compactMessagesForRequest handles persisted tool parts (state.output)", () => {
  const persisted = { type: "tool", tool: "bash", state: { status: "completed", input: {}, output: numberedText(3000) } };
  const messages = [llmUser("task"), { type: "assistant", content: [persisted] }, llmUser("latest")];
  const stats = compactMessagesForRequest(messages, {
    requestBudgetTokens: 1000, requestMinTokens: 100, requestProtectRecent: 1,
    toolResultHeadLines: 5, toolResultTailLines: 2, requestPartMinTokens: 100,
  });
  assert.ok(stats.saved > 0);
  assert.match(persisted.state.output, /ContextPack/);
});

test("selectCompressibleParts accepts both tool shapes and role-based messages", () => {
  const apiPart = { type: "tool", name: "read", state: { content: [{ type: "text", text: "a" }] } };
  const persisted = { type: "tool", tool: "bash", state: { status: "completed", output: "b" } };
  const parts = selectCompressibleParts([
    { role: "assistant", content: [apiPart, persisted] },
  ], 0);
  assert.deepEqual(parts, [apiPart, persisted]);
});

test("compactMessagesForRequest compresses string-content messages", () => {
  const long = Array.from({ length: 4000 }, (_, i) => `line ${i}`).join("\n");
  const messages = [
    { id: "u", role: "user", content: "task" },
    { id: "a", role: "assistant", content: long },
    { id: "t", role: "tool", content: long },
    { id: "u2", role: "user", content: "now" },
  ];
  const stats = compactMessagesForRequest(messages, {
    requestBudgetTokens: 1000, requestTargetRatio: 0, requestMinTokens: 100,
    requestProtectRecent: 1, requestPartMinTokens: 100,
  });
  assert.ok(stats.saved > 0);
  assert.ok(messages[1].content.length < long.length);
});

// ── recovery handles, savings gate and turn protection ──────────────────────

test("elision markers carry a recall handle for the exact original text", () => {
  const bulk = numberedText(4000);
  const old = { id: "msg_old", role: "assistant", content: [
    { type: "tool-result", id: "call_abc", name: "read", result: { type: "text", value: bulk } },
  ] };
  const messages = [
    llmUser("task"),
    old,
    llmAssistant({ type: "tool-result", id: "call_new", name: "read", result: { type: "text", value: bulk } }),
  ];
  compactMessagesForRequest(messages, {
    requestBudgetTokens: 1000, requestTargetRatio: 0, requestMinTokens: 100,
    requestProtectRecent: 1, requestPartMinTokens: 100, requestProtectTurns: false,
  });
  assert.match(old.content[0].result.value, /babyzilla recall msg_old/);
});

test("a rewrite that saves less than requestMinSavingsPct is rolled back", () => {
  const bulk = numberedText(4000);
  const messages = [llmUser("task")];
  for (let i = 0; i < 10; i++) messages.push(llmAssistant({ type: "tool-result", id: `c${i}`, name: "read", result: { type: "text", value: bulk } }));
  const before = JSON.stringify(messages);
  // The achievable saving (~20%) is below a 60% gate, so the rewrite must be
  // rolled back rather than shipped as a cache-invalidating no-op.
  const stats = compactMessagesForRequest(messages, {
    requestBudgetTokens: 100_000, requestTargetRatio: 0, requestMinTokens: 100,
    requestProtectRecent: 6, requestPartMinTokens: 100, requestMinSavingsPct: 60,
  });
  assert.equal(stats.saved, 0);
  assert.equal(stats.skipped, "below-min-savings");
  assert.equal(JSON.stringify(messages), before, "rolled-back messages are byte-identical");
});

test("the current turn's output is not elided to pointers", () => {
  const bulk = numberedText(4000);
  const messages = [llmUser("task")];
  for (let i = 0; i < 6; i++) messages.push(llmAssistant({ type: "tool-result", id: `c${i}`, name: "read", result: { type: "text", value: bulk } }));
  compactMessagesForRequest(messages, {
    requestBudgetTokens: 1000, requestTargetRatio: 0, requestMinTokens: 100,
    requestProtectTurns: true, requestTurnProtectTokens: 1_000_000,
    requestProtectRecent: 1, requestPartMinTokens: 100, requestMinSavingsPct: 0,
  });
  for (const m of messages.slice(1)) {
    assert.doesNotMatch(m.content[0].result.value, /older tool output elided/);
  }
});

test("selectCompressibleParts can protect the whole current turn", () => {
  const messages = [
    { type: "user", text: "hi" },
    assistant(toolPart("a", "A"), toolPart("b", "B")),
  ];
  assert.deepEqual(selectCompressibleParts(messages, 0, null, { protectTurn: true }), []);
  assert.deepEqual(selectCompressibleParts(messages, 0, null, { protectTurn: false }).map((p) => p.id), ["a", "b"]);
});

test("selectCompressibleParts compresses superseded duplicates first", () => {
  const readA = (id, at, file = "/tmp/x.js") => ({
    type: "tool", id, name: "read",
    state: { input: { filePath: file }, content: [{ type: "text", text: `body ${at}` }] },
  });
  const messages = [assistant(readA("old", 1), readA("new", 2), readA("other", 3, "/tmp/y.js"))];
  const picked = selectCompressibleParts(messages, 1, null, { dedupe: true });
  assert.deepEqual(picked.map((p) => p.id), ["old"]);
});

test("elided text is paged and the marker carries its recall handle", () => {
  const pages = new Map();
  const pageRef = (text) => {
    const h = `h${pages.size + 1}`;
    pages.set(h, text);
    return h;
  };
  const bulk = numberedText(4000);
  const old = llmAssistant({ type: "tool-result", id: "a", name: "bash", result: { type: "text", value: bulk } });
  const messages = [llmUser("task"), old, llmAssistant({ type: "text", text: "done" })];
  compactMessagesForRequest(messages, {
    requestBudgetTokens: 2000, requestTargetRatio: 0, requestMinTokens: 100,
    requestProtectRecent: 1, requestProtectTurns: false, requestPartMinTokens: 100,
    requestMinSavingsPct: 0, pageRef,
  });
  const handle = /babyzilla recall (h\d+)/.exec(old.content[0].result.value)?.[1];
  assert.ok(handle, "marker names a recall handle");
  assert.equal(pages.get(handle), bulk, "page stores the exact original text");
});
