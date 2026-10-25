#!/usr/bin/env node
// Deterministic verification bench for the self-tuning loop.
//
// Why this exists: the live A/B harness measures dollars, and on a multi-turn
// agentic task that number is dominated by provider cache hits — identical
// configurations produced a 24.6% A/A "noise floor" (see bench/RESULTS.md), so
// no knob small enough to be safe could ever clear the gate. But every knob the
// tuner may move changes *prompt bytes*, and that is a pure function of the
// transcript and the knobs. This bench therefore replays a fixed transcript
// through the real compression pipeline (lib/text.mjs, the same functions the
// plugin calls) and reports exactly what changes — deterministically, with no
// model calls and no credits.
//
// What it can prove: fewer prompt bytes, same recoverability, protected content
// untouched, and a stable prefix across turns.
// What it cannot prove: that the model's answers stay as good. That is why the
// keep rule also requires recoverability + a drift cap, and why a live recall
// storm still reverts a provisional knob without waiting for any bench.
//
// Usage:
//   node bench/replay.mjs                      # defaults
//   node bench/replay.mjs --set stableMinTokens=1500
//   node bench/replay.mjs --json-out /tmp/r.json
// Prints a `##REPLAY-JSON## {...}` payload on stdout.

import fs from "node:fs";
import path from "node:path";
import { defaults } from "../lib/defaults.mjs";
import {
  applyStableCompression,
  compactMessagesForRequest,
  toolPartText,
} from "../lib/text.mjs";

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? def : args[i + 1];
};
const pairs = (name) => {
  const out = {};
  let i = 0;
  while ((i = args.indexOf(`--${name}`, i)) !== -1) {
    const pair = args[i + 1];
    i += 2;
    if (!pair || pair.startsWith("--")) continue;
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    const k = pair.slice(0, eq);
    let v = pair.slice(eq + 1);
    try { v = JSON.parse(v); } catch { /* keep string */ }
    if (typeof v === "string" && v !== "" && !Number.isNaN(Number(v))) v = Number(v);
    out[k] = v;
  }
  return out;
};

const sets = pairs("set");
const opts = { ...defaults, ...sets };
const jsonOut = opt("json-out", null);

// ── deterministic corpus ───────────────────────────────────────────────────
// Shapes matter more than volume: routine reads (6K), log dumps (12-15K),
// single-line JSON dumps (20-30K), a repeated read, and a turn boundary so the
// recent-turn protection has something to protect. Sizes are in estimated
// tokens; the generator below produces ~4 chars per ASCII token.
const WORDS = [
  "context", "prefix", "cache", "token", "recall", "module", "session",
  "budget", "window", "ledger", "handler", "request", "stream", "offset",
  "cursor", "payload", "schema", "parser", "router", "digest",
];

function lcg(seed) {
  let s = seed >>> 0;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
}

function words(tokens, seed) {
  const rnd = lcg(seed);
  const out = [];
  const n = Math.round((tokens * 4) / 7);
  for (let i = 0; i < n; i++) out.push(WORDS[Math.floor(rnd() * WORDS.length)]);
  return out.join(" ");
}

/** Line-shaped output: what read/shell/grep actually return. */
function lines(tokens, seed, { numbered = true } = {}) {
  const body = words(tokens, seed);
  const per = 80;
  const out = [];
  let i = 0;
  for (let ln = 1; i < body.length; ln++) {
    const chunk = body.slice(i, i + per);
    i += per;
    out.push(numbered ? `${String(ln).padStart(4, " ")}  ${chunk}` : chunk);
  }
  return out.join("\n");
}

/** One enormous line: the dump shape that defeats line-based trimming. */
function singleLine(tokens, seed) {
  const body = words(tokens, seed).replace(/ /g, '"');
  return `[${body}]`;
}

const toolResult = (id, name, output, input = null) => ({
  role: "assistant",
  content: [{
    type: "tool",
    id,
    name,
    state: { status: "completed", input: input ?? { path: `src/part-${id}.ts` }, output },
  }],
});

const assistantText = (text) => ({ role: "assistant", content: [{ type: "text", text }] });
const userText = (m) => (m?.content ?? [])
  .filter((p) => p?.type === "text" && typeof p.text === "string")
  .map((p) => p.text).join("");
const userMessage = (text) => ({ role: "user", content: [{ type: "text", text }] });

export function buildCorpus() {
  return [
    // A historical paste above the 32K bulk-user gate: this is the residual
    // bulk that survives arrival-time compression and keeps Layer 1b engaged,
    // so `requestMinSavingsPct` is actually observable.
    { kind: "user", message: userMessage(`Earlier CI log for context:\n\n${lines(40_000, 10)}`) },
    // Turn 1: the task itself.
    { kind: "user", message: userMessage("Refactor the pagination layer; keep the API.") },
    { kind: "tool", message: toolResult("t1", "read", lines(6_500, 21), { path: "src/pagination.ts" }) },
    { kind: "tool", message: toolResult("t2", "shell", lines(12_000, 22), { command: "npm test -- --reporter=line" }) },
    { kind: "tool", message: toolResult("t3", "execute", singleLine(30_000, 23), { code: "JSON.stringify(rows)" }) },
    { kind: "tool", message: toolResult("t4", "read", lines(6_500, 21), { path: "src/pagination.ts" }) }, // repeat
    { kind: "tool", message: toolResult("t5", "grep", lines(8_000, 24), { pattern: "offset" }) },
    { kind: "text", message: assistantText("Pagination is offset-based in three places; extracting a cursor adapter.") },
    // Turn 2: streaming request, then more bulk.
    { kind: "user", message: userMessage("Now make it streaming and keep the offset path as a fallback.") },
    { kind: "tool", message: toolResult("t6", "read", lines(2_500, 25), { path: "src/stream.ts" }) },
    { kind: "tool", message: toolResult("t7", "shell", lines(15_000, 26), { command: "npm run bench -- --reporter=verbose" }) },
    { kind: "tool", message: toolResult("t8", "read", lines(9_000, 27), { path: "src/cursor.ts" }) },
    { kind: "tool", message: toolResult("t9", "execute", singleLine(20_000, 28), { code: "rows.map(String)" }) },
    { kind: "tool", message: toolResult("t10", "shell", lines(6_000, 29), { command: "git diff --stat" }) },
    { kind: "tool", message: toolResult("t11", "read", lines(5_000, 30), { path: "src/adapter.ts" }) },
    // The 1.5-2.5K band: routine results whose fate is decided by
    // `stableMinTokens` (the difference between 1500 and 2000 lives here).
    { kind: "tool", message: toolResult("t12", "read", lines(1_600, 31), { path: "src/ids.ts" }) },
    { kind: "tool", message: toolResult("t13", "grep", lines(1_800, 32), { pattern: "cursor" }) },
    { kind: "tool", message: toolResult("t14", "read", lines(2_400, 33), { path: "src/limits.ts" }) },
  ];
}

// ── replay ─────────────────────────────────────────────────────────────────
export function runReplay(optOverrides = {}) {
  const o = { ...defaults, ...optOverrides };
  const messages = [];
  const pages = new Map();
  let pageSeq = 0;
  const pageRef = (text) => {
    const ref = `replay${++pageSeq}`;
    pages.set(ref, text);
    return ref;
  };

  const corpus = buildCorpus();
  let peak = 0;
  let peakStep = -1;
  let total = 0;
  let stableParts = 0;
  let requestParts = 0;
  let requestSavings = 0;
  let recoverable = true;
  let prefixStable = true;
  let liveUserKeepsEnds = true;

  for (let i = 0; i < corpus.length; i++) {
    const step = corpus[i];
    messages.push(step.message);

    if (o.toolResultCompression !== false && o.stablePrefix === true) {
      const res = applyStableCompression(messages, o, pageRef);
      stableParts += res.parts;
      // Recoverability: anything rewritten must carry a handle or the "exact
      // spans" promise, and a rewritten part may never be empty.
      for (const m of messages) {
        for (const p of m.content ?? []) {
          if (p?.type !== "tool" && p?.type !== "tool-result") continue;
          const t = toolPartText(p);
          if (!t) { recoverable = false; continue; }
          if (t.includes("[ContextPack]") && !/recall |retrieve /.test(t)) recoverable = false;
        }
      }
      // Prefix stability: a second arrival pass must be a no-op (already-sent
      // bytes are never rewritten), or the provider cache is invalidated.
      const snapshot = messages.map((m) => m.content?.map((p) => toolPartText(p)).join("\u0000"));
      const again = applyStableCompression(messages, o, pageRef);
      const post = messages.map((m) => m.content?.map((p) => toolPartText(p)).join("\u0000"));
      if (again.parts !== 0 || snapshot.join("\u0001") !== post.join("\u0001")) prefixStable = false;
    }

    // Per-request view: Layer 1b on a snapshot, as the context hook does.
    const view = structuredClone(messages);
    const stats = compactMessagesForRequest(view, { ...o, pageRef });
    requestParts += stats.parts;
    requestSavings += stats.saved;
    if (stats.after > peak) { peak = stats.after; peakStep = i; }
    total += stats.after;

    // The *live* user message may be head+tail compressed by the budget
    // valve, but the ask and the closing instruction must survive: a rewrite
    // that drops either end has deleted what the agent was asked to do.
    let liveUser = -1;
    for (let j = 0; j < messages.length; j++) if (messages[j]?.role === "user") liveUser = j;
    if (liveUser >= 0) {
      const before = userText(messages[liveUser]);
      const after = userText(view[liveUser]);
      if (before && after !== before) {
        const head = before.slice(0, 200);
        const tail = before.slice(-200);
        if (!after.includes(head) || !after.includes(tail)) liveUserKeepsEnds = false;
      }
    }
  }

  const joined = messages.map((m) => JSON.stringify(m)).join("\n");
  const markers = (joined.match(/\[ContextPack\]/g) ?? []).length;

  return {
    opts: optOverrides,
    steps: corpus.length,
    peak,
    peakStep,
    total,
    stableParts,
    requestParts,
    requestSavedTokens: requestSavings,
    markers,
    guards: { recoverable, prefixStable, liveUserKeepsEnds },
    pageRefs: pages.size,
  };
}

const result = runReplay(sets);
const payload = { model: "deterministic-replay", sets, ...result };
if (jsonOut) {
  fs.mkdirSync(path.dirname(path.resolve(jsonOut)), { recursive: true });
  fs.writeFileSync(jsonOut, JSON.stringify(payload, null, 2));
}
console.log(`\nreplay  ${result.steps} steps · peak ${result.peak} tok · total ${result.total} tok`);
console.log(`        stable parts ${result.stableParts} · request parts ${result.requestParts} · markers ${result.markers}`);
console.log(`        guards  ${JSON.stringify(result.guards)}\n`);
console.log(`##REPLAY-JSON## ${JSON.stringify(payload)}`);
