// Pure-helper tests — no plugin load, no filesystem, no model calls.
import test from "node:test";
import assert from "node:assert/strict";
import { estTokens, compressToolText, compressToolResult, routeDistill, selectCompressibleParts, compactMessagesForRequest, compressTextBlock, requestBudget } from "../lib/text.mjs";

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

test("string content compresses, except the assistant reply", () => {
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
  assert.ok(messages[1].content.includes("line 3999"), "reply tail kept");
  assert.ok(messages[2].content.length < long.length, "tool text still compresses");
});

// ── recovery handles, savings gate and turn protection ──────────────────────

test("ledger rows advertise a recall handle only for real page hashes", () => {
  const bulk = numberedText(800);
  const fresh = () => {
    const messages = [llmUser("task")];
    for (let i = 0; i < 10; i++) {
      messages.push(llmAssistant({
        type: "tool-result", id: `call_${i}`, name: "read",
        result: { type: "text", value: bulk },
        state: { input: { filePath: `/tmp/f${i}.js` }, status: "completed" },
      }));
    }
    return messages;
  };
  const opts = {
    requestBudgetTokens: 900, requestTargetRatio: 0, requestMinTokens: 100,
    requestProtectRecent: 1, requestPartMinTokens: 100, requestProtectTurns: false,
    requestLedgerKeepRecent: 1, requestLedgerKeepTokens: 0,
  };

  const messages = fresh();
  compactMessagesForRequest(messages, opts);
  const noStore = messages[1].content[0].result.value;
  assert.match(noStore, /· read ·/);
  assert.doesNotMatch(noStore, /recall/);

  // With a page store, the handle is the content hash the CLI resolves.
  const messages2 = fresh();
  compactMessagesForRequest(messages2, { ...opts, pageRef: () => "0123456789abcdef" });
  assert.match(messages2[1].content[0].result.value, /recall 0123456789abcdef/);
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

// ── Layer 3: deterministic turn ledger ──────────────────────────────────────

test("old tool steps collapse to deterministic ledger rows", () => {
  const bulk = numberedText(4000);
  const messages = [llmUser("task")];
  for (let i = 0; i < 30; i++) {
    const bash = i % 2 === 1;
    messages.push({
      id: `a${i}`, role: "assistant", content: [
        { type: "tool-call", id: `c${i}`, name: bash ? "bash" : "read", input: bash ? { command: `npm test -- ${i}` } : { filePath: `/tmp/f${i}.js` } },
      ],
    });
    messages.push({
      id: `t${i}`, role: "tool", content: [
        {
          type: "tool-result", id: `c${i}`, name: bash ? "bash" : "read",
          result: { type: "text", value: bulk },
          metadata: bash ? { exit: 1 } : undefined,
        },
      ],
    });
  }
  compactMessagesForRequest(messages, {
    requestBudgetTokens: 5000, requestTargetRatio: 0, requestMinTokens: 100,
    requestProtectRecent: 1, requestProtectTurns: false, requestPartMinTokens: 100,
    requestMinSavingsPct: 0,
    requestLedger: true, requestLedgerKeepRecent: 5, requestLedgerMinTokens: 10,
    pageRef: () => "h1",
  });
  // Step 1 is the first read; rows carry tool, target, size and a recall handle.
  assert.match(messages[2].content[0].result.value, /#1 · read · \/tmp\/f0\.js · ok · .*recall h1/);
  // Step 2 is bash with metadata.exit=1.
  assert.match(messages[4].content[0].result.value, /#2 · bash · npm test -- 1 · exit 1 · .*recall h1/);
  // The newest results stay byte-for-byte verbatim.
  assert.match(messages.at(-1).content[0].result.value, /1:   step\(0\)/);
});

test("ledger can be disabled, falling back to head+tail", () => {
  const bulk = numberedText(4000);
  const messages = [llmUser("task")];
  for (let i = 0; i < 10; i++) {
    messages.push(llmAssistant({ type: "tool-result", id: `c${i}`, name: "read", result: { type: "text", value: bulk } }));
  }
  compactMessagesForRequest(messages, {
    requestBudgetTokens: 1000, requestTargetRatio: 0, requestMinTokens: 100,
    requestProtectRecent: 1, requestProtectTurns: false, requestPartMinTokens: 100,
    requestMinSavingsPct: 0, requestLedger: false,
  });
  assert.match(messages[1].content[0].result.value, /older tool output elided/);
  assert.doesNotMatch(messages[1].content[0].result.value, /· read ·/);
});

test("huge historical user messages are condensed, the live one is not", () => {
  const blob = `<conversation-checkpoint>\n${"filler text about the past. ".repeat(9000)}\nNever touch production.\n${"more filler ".repeat(3000)}\n</conversation-checkpoint>`;
  const live = "ok cool, go";
  const messages = [
    llmUser(blob),
    { id: "a1", role: "assistant", content: [{ type: "text", text: "done" }] },
    llmUser(live),
  ];
  compactMessagesForRequest(messages, {
    requestBudgetTokens: 5000, requestTargetRatio: 0, requestMinTokens: 100,
    requestProtectRecent: 1, requestProtectTurns: false, requestMinSavingsPct: 0,
    requestCompressUserBulk: true, requestUserBulkMinTokens: 2000,
    pageRef: () => "h9",
  });
  assert.match(messages[0].content[0].text, /historical user context condensed/);
  assert.match(messages[0].content[0].text, /Never touch production\./);
  assert.match(messages[0].content[0].text, /recall h9/);
  assert.equal(messages[2].content[0].text, live);
});

test("bulk user condensation is off by default at the library layer", () => {
  const blob = "line ".repeat(20000);
  const messages = [llmUser(blob), llmUser("live")];
  compactMessagesForRequest(messages, {
    requestBudgetTokens: 1000, requestTargetRatio: 0, requestMinTokens: 100,
    requestProtectRecent: 1, requestProtectTurns: false, requestMinSavingsPct: 0,
    requestCompressUserBulk: false,
  });
  assert.equal(messages[0].content[0].text, blob);
});

test("requestBudget applies the documented 8% ratio, 12K floor and 45K hard cap", () => {
  // 100K request: 8% = 8K, raised to the 12K floor.
  assert.equal(requestBudget({ before: 100_000, opts: {} }).budget, 12_000);
  // 400K request: 8% = 32K, still under the 45K hard cap.
  assert.equal(requestBudget({ before: 400_000, opts: {} }).budget, 32_000);
  // 1M request: 8% would be 80K, the hard cap wins.
  assert.equal(requestBudget({ before: 1_000_000, opts: {} }).hardCap, 45_000);
  assert.equal(requestBudget({ before: 1_000_000, opts: {} }).budget, 45_000);
  // A prompt cap (model window) beats everything else.
  assert.equal(requestBudget({ before: 95_000, maxPrompt: 20_000, opts: {} }).hardCap, 20_000);
  // Explicit budget is the escape hatch, including below the floor.
  assert.equal(requestBudget({ before: 90_000, opts: { requestBudgetTokens: 5_000 } }).budget, 5_000);
});

test("ledger rows never advertise a recall handle that cannot resolve", () => {
  const parts = [];
  for (let i = 0; i < 8; i++) {
    parts.push({ role: "assistant", content: [{ type: "tool-call", id: `call_${i}`, name: "read", input: { filePath: `/tmp/f${i}.js` } }] });
    parts.push({ role: "tool", content: [{ type: "tool-result", id: `call_${i}`, name: "read", result: { type: "text", value: numberedText(400) } }] });
  }
  const messages = [...parts, { role: "user", content: [{ type: "text", text: "carry on" }] }];
  compactMessagesForRequest(messages, {
    requestBudgetTokens: 2000, requestTargetRatio: 0, requestMinTokens: 100,
    requestProtectRecent: 1, requestProtectTurns: false, requestMinSavingsPct: 0,
    requestLedgerKeepRecent: 2, requestPartMinTokens: 100,
  });
  const text = messages.filter((m) => m.role === "tool").map((m) => m.content[0].result.value).join("\n");
  assert.match(text, /#\d+ · read · \/tmp\/f\d\.js/);
  assert.doesNotMatch(text, /recall i\d/);
});

test("an assistant reply is never rewritten, even under budget pressure", () => {
  // The reply ends with the question the next user turn answers.
  const question = "Want me to add crawlable links to the landing pages and deploy?";
  const long = "Analysis of the landing pages. ".repeat(400);
  const messages = [
    { role: "user", content: "do people actually use the site?" },
    { role: "assistant", content: [{ type: "text", text: `${long}\n\n${question}` }] },
    { role: "user", content: "yes" },
  ];
  const opts = {
    requestBudgetTokens: 1_200,
    requestMinTokens: 100,
    requestProtectRecent: 0,
    requestHardProtect: 2,
    requestMinSavingsPct: 0,
    requestLedger: false,
  };
  compactMessagesForRequest(messages, opts);
  assert.ok(messages[1].content[0].text.length < long.length);
  assert.ok(messages[1].content[0].text.includes(question));
});

test("a tool result in an assistant message still compresses", () => {
  const tool = "  10: const a = 1;\n".repeat(300);
  const messages = [
    { role: "user", content: "read it" },
    {
      role: "assistant",
      content: [
        { type: "text", text: "Reading the file now to see how it works." },
        { type: "tool", name: "read", state: { status: "completed", input: { filePath: "a.mjs" }, output: tool } },
      ],
    },
    { role: "user", content: "and now?" },
  ];
  const opts = {
    requestBudgetTokens: 1_200,
    requestMinTokens: 100,
    requestProtectRecent: 0,
    requestHardProtect: 1,
    requestMinSavingsPct: 0,
    requestLedger: false,
  };
  compactMessagesForRequest(messages, opts);
  assert.equal(messages[1].content[0].text, "Reading the file now to see how it works.");
  assert.ok(messages[1].content[1].state.output.length < tool.length);
});

test("the question in the assistant reply survives the next request", () => {
  const long = "analysis paragraph. ".repeat(400);
  const q = "Want me to add crawlable links and deploy?";
  const messages = [
    { role: "user", content: "is anyone visiting?" },
    { role: "assistant", content: [{ type: "text", text: long + "\n\n" + q }] },
    { role: "user", content: "yes" },
  ];
  compactMessagesForRequest(messages, {
    requestBudgetTokens: 500,
    requestMinTokens: 100,
    requestProtectRecent: 0,
    requestHardProtect: 1,
    requestMinSavingsPct: 0,
    requestLedger: false,
  });
  assert.ok(messages[1].content[0].text.includes(q), "the question must survive");
});

// ── selectCompressibleParts: eager page-out by size ─────────────────────────

const tp = (tool, chars) => ({
  type: "tool", callID: `c_${tool}_${chars}`, tool,
  state: { status: "completed", output: "x".repeat(chars) },
});
const eagerMsg = (...parts) => ({ role: "assistant", content: parts });

test("eager gate: any tool over eagerMinTokens becomes compressible", () => {
  const a = tp("read", 40_000), b = tp("shell", 50_000);
  const one = selectCompressibleParts([eagerMsg(a, b)], 1, null, { eagerMinTokens: 8_000 });
  assert.deepEqual(one, [a]); // newest result stays verbatim…
  const all = selectCompressibleParts([eagerMsg(a, b)], 0, null, { eagerMinTokens: 8_000 });
  assert.deepEqual(all, [a, b]); // window 0: both, regardless of tool name
});

test("eager gate: results under the threshold stay inline", () => {
  // 8-9K chars ≈ 2-2.3K estimated tokens: under the 8K gate by design.
  const out = selectCompressibleParts([eagerMsg(tp("shell", 8_000), tp("execute", 9_000))], 0, null, { eagerMinTokens: 8_000 });
  assert.deepEqual(out, []); // routine outputs stay verbatim…
});

test("eager gate: only the protected-newest window is a victim", () => {
  const older = tp("read", 40_000), newest = tp("shell", 50_000);
  const out = selectCompressibleParts([eagerMsg(older, newest)], 1, null, { eagerMinTokens: 8_000 });
  assert.deepEqual(out, [older]); // newest stays verbatim in both modes
  const legacy = selectCompressibleParts([eagerMsg(older, newest)], 1, new Set(["read"]), { eagerMinTokens: 0 });
  assert.deepEqual(legacy, [older]); // allowlist still applies; eager adds nothing for it
});
