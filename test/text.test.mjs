// Pure-helper tests — no plugin load, no filesystem, no model calls.
import test from "node:test";
import assert from "node:assert/strict";
import { estTokens, compressToolText, compressToolResult, routeDistill, selectCompressibleParts } from "../lib/text.mjs";

// ── estTokens ───────────────────────────────────────────────────────────────

test("estTokens rounds up at 4 chars/token and treats empty as zero", () => {
  assert.equal(estTokens(""), 0);
  assert.equal(estTokens(null), 0);
  assert.equal(estTokens("abcd"), 1);
  assert.equal(estTokens("abcde"), 2);
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

test("routeDistill surfaces the second error when both routes fail", async () => {
  await assert.rejects(
    routeDistill({
      viaText: boom("first"),
      viaSession: boom("second"),
      preferSession: false,
      onError: () => {},
    }),
    /second/,
  );
});
