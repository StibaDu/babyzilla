// Pure-helper tests — no plugin load, no filesystem, no model calls.
import test from "node:test";
import assert from "node:assert/strict";
import { estTokens, compressToolText, routeDistill } from "../lib/text.mjs";

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
