// Layer 1 (distillation) tests — pure, no plugin load.
import test from "node:test";
import assert from "node:assert/strict";
import {
  fmt, slug, dirSlug, trimTo,
  reduceForDistill, distillationPrompt, parseModules, moduleFileFor, buildSummary,
  DISTILL_INSTRUCTIONS, USER_BUDGET_TOKENS, distillInputBudget,
  TOOL_RESULT_HEAD_CHARS, TOOL_RESULT_TAIL_CHARS,
} from "../lib/distill.mjs";
import { estTokens } from "../lib/text.mjs";

// ── formatting helpers ──────────────────────────────────────────────────────

test("fmt renders thousands compactly", () => {
  assert.equal(fmt(999), "999");
  assert.equal(fmt(1500), "1.5K");
  assert.equal(fmt(48000), "48.0K");
});

test("slug is filesystem-safe, bounded, and never empty", () => {
  assert.equal(slug("My Mod!"), "my-mod");
  assert.equal(slug(""), "module");
  assert.equal(slug("a".repeat(200)).length, 60);
});

test("dirSlug uses the last path component", () => {
  assert.equal(dirSlug("/Users/me/projects/bz-battle"), "bz-battle");
  assert.equal(dirSlug("/Users/me/projects/bz-battle/"), "bz-battle");
  assert.equal(dirSlug("/"), "root");
});

test("trimTo cuts at a word boundary and marks truncation", () => {
  assert.equal(trimTo("short", 100), "short");
  const out = trimTo("alpha beta gamma delta", 12);
  assert.ok(out.length <= 12 + "\n[... truncated ...]".length);
  assert.match(out, /\[\.\.\. truncated \.\.\.\]$/);
});

// ── reduceForDistill ────────────────────────────────────────────────────────

const para = (label, chars = 4000) => `[tool ${label}] ` + "x".repeat(chars);

test("reduceForDistill passes a transcript under budget through untouched", () => {
  const text = "hello world";
  const out = reduceForDistill(text, 100);
  assert.deepEqual(out, { text, dropped: 0, rawTokens: estTokens(text) });
});

test("reduceForDistill drops older paragraphs and reports the dropped tokens", () => {
  const newest = para("newest");
  const older = para("older");
  const text = [older, newest].join("\n\n");
  const out = reduceForDistill(text, 500);
  assert.match(out.text, /\[tool newest\]/);
  assert.doesNotMatch(out.text, /\[tool older\]/);
  assert.ok(out.dropped > 0);
  assert.match(out.text, /tokens of older tool output omitted by ContextPack pre-trim/);
});

test("reduceForDistill trims long tool blocks to head+tail", () => {
  const big = `[tool big] ` + "y".repeat(TOOL_RESULT_HEAD_CHARS + TOOL_RESULT_TAIL_CHARS + 5000);
  const out = reduceForDistill(big, 50);
  assert.match(out.text, /\[\.\.\. trimmed \.\.\.\]/);
  assert.ok(out.text.length < big.length);
});

test("reduceForDistill always keeps the newest paragraph", () => {
  const newest = para("only", 8000);
  const out = reduceForDistill(newest, 10);
  assert.match(out.text, /\[tool only\]/);
});

// ── distillationPrompt ──────────────────────────────────────────────────────

test("distillationPrompt includes only hot modules from a prior pack", () => {
  const prev = { modules: [
    { hot: true, content: "PRIOR-HOT" },
    { hot: false, content: "PRIOR-COLD" },
  ] };
  const out = distillationPrompt(prev, "NEW-WORK");
  assert.match(out, /PRIOR-HOT/);
  assert.doesNotMatch(out, /PRIOR-COLD/);
  assert.match(out, /NEW-WORK/);
  assert.match(out, /TRANSCRIPT OF NEW WORK SINCE/);
});

test("distillationPrompt without a prior pack is just the transcript", () => {
  assert.equal(distillationPrompt(null, "NEW-WORK"), "NEW-WORK");
  assert.equal(distillationPrompt({ modules: [] }, "NEW-WORK"), "NEW-WORK");
});

test("DISTILL_INSTRUCTIONS demands JSONL and a state module", () => {
  assert.match(DISTILL_INSTRUCTIONS, /newline-delimited JSON/);
  assert.match(DISTILL_INSTRUCTIONS, /"state"/);
  assert.match(DISTILL_INSTRUCTIONS, /file:line/);
});

test("USER_BUDGET_TOKENS is the documented 48K window", () => {
  assert.equal(USER_BUDGET_TOKENS, 48_000);
});

// ── parseModules ────────────────────────────────────────────────────────────

test("parseModules reads one JSON module per line", () => {
  const raw = [
    '{"kind":"state","name":"00-state","triggers":["Goal","next steps"],"content":"current state"}',
    '{"kind":"decisions","name":"Design Choices","triggers":["jsonl"],"content":"we chose JSONL"}',
  ].join("\n");
  const mods = parseModules(raw);
  assert.equal(mods.length, 2);
  assert.deepEqual(mods[0], {
    kind: "state", name: "00-state", triggers: ["goal", "next steps"], content: "current state",
  });
  assert.equal(mods[1].kind, "decisions");
  assert.equal(mods[1].name, "design-choices");
});

test("parseModules accepts a single {modules:[...]} object", () => {
  const raw = JSON.stringify({ modules: [
    { kind: "state", name: "00-state", triggers: ["a"], content: "s" },
    { kind: "topic", name: "t", triggers: ["b"], content: "body" },
  ] });
  assert.equal(parseModules(raw).length, 2);
});

test("parseModules accepts a top-level array", () => {
  const raw = JSON.stringify([
    { kind: "state", name: "00-state", triggers: ["a"], content: "s" },
    { kind: "topic", name: "t", triggers: ["b"], content: "body" },
  ]);
  const mods = parseModules(raw);
  assert.equal(mods.length, 2);
  assert.equal(mods[0].kind, "state");
  assert.equal(mods[1].name, "t");
});

test("parseModules accepts a pretty-printed array", () => {
  const raw = JSON.stringify([
    { kind: "state", name: "00-state", triggers: ["a"], content: "s" },
    { kind: "code", name: "hooks", triggers: ["b"], content: "body" },
  ], null, 2);
  const mods = parseModules(raw);
  assert.equal(mods.length, 2);
  assert.equal(mods[1].kind, "code");
});

test("parseModules ignores a prose [ before a {modules} object", () => {
  const raw = "[ContextPack] note\n" + JSON.stringify({ modules: [
    { kind: "state", name: "00-state", triggers: [], content: "s" },
  ] });
  const mods = parseModules(raw);
  assert.equal(mods.length, 1);
  assert.equal(mods[0].content, "s");
});

test("parseModules strips think blocks and code fences", () => {
  const raw = " thinkinginternal reasoning with {braces}</think>\n```json\n" +
    '{"kind":"state","name":"00-state","triggers":["x"],"content":"ok"}\n```';
  const mods = parseModules(raw);
  assert.equal(mods.length, 1);
  assert.equal(mods[0].content, "ok");
});

test("parseModules tolerates a truncated tail", () => {
  const raw = '{"kind":"state","name":"00-state","triggers":["x"],"content":"kept"}\n' +
    '{"kind":"topic","name":"broken","content":"unterminated';
  const mods = parseModules(raw);
  assert.equal(mods.length, 1);
  assert.equal(mods[0].content, "kept");
});

test("parseModules maps unknown kinds to topic and clamps triggers", () => {
  const raw = JSON.stringify({ modules: [
    { kind: "bogus", name: "X", triggers: ["A", "B", "C", "D", "E", "F", "G", "H", "I"], content: "c" },
  ] });
  const mods = parseModules(raw);
  assert.equal(mods[0].kind, "topic");
  assert.equal(mods[0].triggers.length, 8);
  assert.ok(mods[0].triggers.every((t) => t === t.toLowerCase()));
});

test("parseModules drops empty modules and caps at 14", () => {
  const lines = [];
  for (let i = 0; i < 20; i++) {
    lines.push(JSON.stringify({ kind: "topic", name: `t${i}`, triggers: [], content: `body ${i}` }));
  }
  lines.push(JSON.stringify({ kind: "topic", name: "empty", triggers: [], content: "   " }));
  const mods = parseModules(lines.join("\n"));
  assert.equal(mods.length, 14);
  assert.ok(mods.every((m) => m.content.trim()));
});

test("parseModules rejects empty and JSON-free responses", () => {
  assert.throws(() => parseModules(""), /empty distiller response/);
  assert.throws(() => parseModules("no objects here"), /no JSON found/);
  assert.throws(() => parseModules("{ not json"), /no JSON found|no parseable module/);
});

// ── moduleFileFor / buildSummary ────────────────────────────────────────────

test("moduleFileFor gives state a stable filename", () => {
  assert.equal(moduleFileFor({ kind: "state", name: "00-state" }), "00-state.md");
  assert.equal(moduleFileFor({ kind: "code", name: "hook-shapes" }), "code-hook-shapes.md");
});

test("buildSummary renders state, decisions, and cold module pointers", () => {
  const modules = [
    { kind: "state", name: "00-state", content: "CURRENT", triggers: [] },
    { kind: "decisions", name: "design", content: "DECIDED", triggers: [] },
    { kind: "code", name: "hooks", content: "CODE", triggers: ["hook", "api"] },
  ];
  // files is keyed by the filename on disk: kinds share names.
  const files = { "00-state.md": "/p/00-state.md", "decisions-design.md": "/p/decisions-design.md", "code-hooks.md": "/p/code-hooks.md" };
  const out = buildSummary({ modules, files }, { rawTokens: 10_000, packTokens: 1_000, savedPct: 90 });
  assert.match(out, /compressed 90%/);
  assert.match(out, /raw ~10\.0K tokens → pack ~1\.0K tokens, 3 modules/);
  assert.match(out, /## CURRENT STATE\nCURRENT/);
  assert.match(out, /## DECISIONS[\s\S]*DECIDED/);
  assert.match(out, /file:\/\/\/p\/code-hooks\.md/);
  assert.match(out, /triggers: hook, api/);
});

test("moduleFileFor gives anchor and recovered stable, sorted filenames", () => {
  assert.equal(moduleFileFor({ kind: "anchor", name: "last" }), "00-anchors.md");
  assert.equal(moduleFileFor({ kind: "state", name: "recovered" }), "00-recovered.md");
});

test("buildSummary leads with the anchor, then state", () => {
  const modules = [
    { kind: "state", name: "00-state", content: "CURRENT", triggers: [] },
    { kind: "anchor", name: "last", content: "### The request\nwant me to ship it?", triggers: [] },
  ];
  const out = buildSummary({ modules, files: {} }, { rawTokens: 100, packTokens: 10, savedPct: 90 });
  assert.match(out, /## YOUR LAST EXCHANGE[\s\S]*want me to ship it\?/);
  assert.ok(out.indexOf("YOUR LAST EXCHANGE") < out.indexOf("CURRENT STATE"));
  // The anchor is never a cold pointer: it is small and always relevant.
  assert.doesNotMatch(out, /MODULES ON DISK[\s\S]*00-anchors/);
});

test("buildSummary omits sections it has no modules for", () => {
  const out = buildSummary({ modules: [{ kind: "state", name: "00-state", content: "S", triggers: [] }], files: {} },
    { rawTokens: 100, packTokens: 10, savedPct: 90 });
  assert.doesNotMatch(out, /## DECISIONS/);
  assert.doesNotMatch(out, /## MODULES ON DISK/);
});

test("distillInputBudget follows the distiller window and caps at 48K", () => {
  assert.equal(distillInputBudget({ windowTokens: 8000 }), 3200);
  assert.equal(distillInputBudget({ windowTokens: 1_048_576 }), USER_BUDGET_TOKENS);
  assert.equal(distillInputBudget({ windowTokens: 0 }), USER_BUDGET_TOKENS);
  assert.equal(distillInputBudget({ windowTokens: 8000, explicit: 9000 }), 9000);
  assert.equal(distillInputBudget({}), USER_BUDGET_TOKENS);
});
