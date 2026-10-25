// ContextPack — session context compressor & module loader for OpenCode V2.
//
// Replaces OpenCode's native compaction summary with an AI-distilled set of
// "context modules" (state / decisions / code / tool / errors / topic),
// persisted under ~/.opencode/contextpacks/<sessionID>/. The raw transcript
// in OpenCode's database is never touched — packs are additive.
//
// Integration points (OpenCode >= 2.0.16):
//   ctx.session.hook("context")     -> per-request token budget (Layer 1b)
//   ctx.tool.hook("execute.after")  -> per-session usage journal (stats source)
//   ctx.session.hook("compaction")  -> distill & swap the compaction summary
//   ctx.session.hook("prompt")      -> module auto-loading (trigger keywords,
//                                      plus opt-in carry-in on the first prompt)
//   ctx.command.transform           -> /contextpack inspector command
//   ctx.generate.text               -> distillation call (no session context)
//
// Design rules:
//   - AI distills MEANING (one call at compaction time), lowfat-style rules
//     apply to bulk: tool dumps are pre-trimmed before they reach the model.
//   - Hot modules (state, decisions) live in the summary. Cold modules live on
//     disk, referenced by absolute path; future prompts attach them natively.
//   - Every hook body is wrapped: any failure logs and leaves the event
//     untouched, so OpenCode falls back to its normal compaction.

import { exec as execCb, execFile as execFileCb } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { estTokens, compressToolText, compressToolResult, routeDistill, selectCompressibleParts, compactMessagesForRequest } from "./lib/text.mjs";
import { writePage, pageHash } from "./lib/pages.mjs";
import {
  fmt, dirSlug,
  TOOL_RESULT_HEAD_CHARS, TOOL_RESULT_TAIL_CHARS,
  reduceForDistill, distillInputBudget, DISTILL_INSTRUCTIONS, distillationPrompt,
  parseModules, moduleFileFor, buildSummary,
} from "./lib/distill.mjs";
import { libraryIndex } from "./lib/library.mjs";
import { anchorModule, ANCHOR_KIND } from "./lib/anchor.mjs";
import { renderModules } from "./lib/eval.mjs";
import { assemblePack } from "./lib/pack.mjs";

const execAsync = promisify(execCb);
const execFileAsync = promisify(execFileCb);

// Same override the bin honors, so tests and tooling can sandbox the data dir.
const ROOT = process.env.BABYZILLA_ROOT || path.join(os.homedir(), ".opencode", "contextpacks");
const JOURNAL_LIMIT_ENTRIES = 2000;
// Tools whose results are safe to compress at the source. Shell output is
// already handled by lowfat, so re-compressing it would only lose structure.
const COMPRESSIBLE_TOOLS = new Set(["read", "grep", "glob", "list"]);
// Module kinds that are still useful to a later session of the same project
// (see promoteToLibrary). Anchors are per-session turn snapshots and
// `recovered` holds the last exchange's rescued facts — both are stale by
// the time the next session opens, so they stay out. state/decisions keep
// their hot flag on promotion and become the carry-in set for new sessions;
// tool/errors stay cold and attach by keyword as before.
const CARRY_KINDS = new Set(["state", "decisions", "tool", "errors"]);
// Among the promoted kinds, these two are the hot core a new session carries
// in on its first prompt (trigger-free). tool/errors stay cold.
const CARRY_CORE = new Set(["state", "decisions"]);

// Vision auto-routing (v0.7.7): historically the main session model was
// assumed text-only, so image work was always delegated to the `vision`
// subagent (which reads the image file itself). BabyZilla spots image intent
// on every prompt — attached image files, concrete image paths in the text,
// or picture wording — verifies the paths actually exist, then sends one
// synthetic note that tells the main model to delegate with the exact paths.
// Since v0.9.0 the session model's catalog entry is checked first: a model
// that accepts image input reads the pixels itself and no note is sent.
// Unknown identity/shape keeps the delegation route (conservative).
// Without this the model gets a "short note in place of the attachment" and
// starts guessing at pixels.
const IMAGE_FILE_EXT = /\.(png|jpe?g|webp|gif|bmp|tiff?|heic|heif|avif)$/i;
// Wording that implies pixels without a path in sight. Deliberately concrete;
// "vision" alone must not trigger rhapsodic speeches about the routing feature.
const VISION_INTENT_WORDS =
  /\b(?:screenshots?|screencaps?|screen\s?grabs?|attached\s+(?:image|photo|picture|screenshot|diagram|mockup)|image\s+attached|photo\s+attached|the\s+(?:image|photo|picture|screenshot|mockup|diagram|figure|chart|render)|this\s+(?:image|photo|picture|screenshot|mockup|diagram|figure|chart|render)|look\s+at\s+(?:the\s+|this\s+)?(?:image|photo|picture|screenshot|mockup|diagram|figure|chart)|ui\s+mockups?|wireframes?|flow\s?charts?|what\s+does\s+the\s+(?:image|screenshot|mockup|diagram)|what\s+do\s+you\s+see)\b/i;
// Compaction re-entrancy: sid → expiry ms. Two queued compaction events (or a
// re-registered hook after a config reload) must not distill the same session
// concurrently; a conservative TTL covers abnormal aborts.
const compactionInFlight = new Map();
// sessions for which BabyZilla already requested a proactive compaction, so a
// 1M-token model does not get a /compact every single step.
const proactiveRequested = new Map();
// Sessions that already got the one-time compression contract note.
const contractSent = new Set();

// What the model is told when paging first happens. The point is to make the
// rules predictable: the agent should plan around compression, not discover it.
const CONTRACT_NOTE = [
  "[ContextPack] Compression contract for this session:",
  "· Older tool output is paged out of the prompt, never deleted. A `[ContextPack]` marker carries a `babyzilla recall <id>` handle that prints the exact original text (add `:start-end` for a span).",
  "· The current user turn and the newest messages are sent verbatim; the newest result per file/command is kept.",
  "· Never reuse line numbers or file contents taken from a marker or a pack — re-read before editing.",
  "· Old steps appear as ledger rows (`#12 · bash · npm test · exit 1 · 3.1K tok · recall …`): that is the index of what was tried, not the content.",
  "· Prefer parallel tool calls where possible: every sequential step resends the whole request.",
  "· This is why a long session keeps working instead of overflowing: same facts, smaller working set.",
].join("\n");

// Tool results are the bulk of a session. Pre-trim them so the distiller call
// fits comfortably even when the session just overflowed its context window.
log("contextpack module loaded, data dir:", ROOT);

const defaults = {
  // null -> use the session's own model for distillation.
  distillModel: null,
  // how to route the distillation call:
  //   "auto"    -> try the session-less call first (the unchanged legacy path)
  //                and only fall back to the session-scoped call when it is
  //                rejected. Every working provider stays byte-identical while
  //                gated ones (OpenCode's free tier) now succeed via fallback.
  //   "session" -> try the session-scoped call first (uses the session's own
  //                model), falling back to the session-less call.
  //   "text"    -> session-less only, no fallback (strict legacy behaviour).
  distillVia: "auto",
  // max cold modules attached to one prompt + their combined token budget.
  maxAttach: 2,
  attachBudgetTokens: 6000,
  // promote tool-* modules of a project into the cross-session library.
  library: true,
  // opt-in: on the first prompt of a new session, carry modules over from the
  // project's own distillation history instead of starting cold. Applies
  // carryKindAllowlist to what may cross a session boundary and shares the
  // attach budget with cold modules, never exceeding it. Turn OFF to keep the
  // old behavior where only keyword matches from the library could attach.
  carryIn: false,
  // vision auto-routing: when a prompt attaches images, names image paths, or
  // contains picture wording, verify the paths and send one routing note that
  // makes the main model delegate the visual work to `visionAgent`. Skipped
  // automatically when the session model's catalog entry confirms image
  // input — the user's selected model decides. Safe as a default: sessions
  // without that agent profile only get a debug-log line, never a note.
  visionRoute: true,
  // agent profile that receives routed image tasks. Create it as
  // ~/.config/opencode/agents/vision.md with a vision-capable model.
  visionAgent: "vision",
  // below this many estimated transcript tokens, native compaction is fine.
  minRawTokens: 4000,
  // layer 2: rewrite shell commands through the `lowfat` binary before
  // execution, so tool output enters the context pre-compressed.
  toolCompression: true,
  // layer 2b: compress large tool results (read/grep/glob) at the source,
  // before they are persisted and resent on every later turn. This is the
  // per-request gap Headroom had in the head-to-head.
  toolResultCompression: true,
  // A read of a 60-line file costs ~1K tokens; compressing that saves nothing
  // and costs a re-read. Only bulk results are worth rewriting.
  toolResultMinTokens: 4000,
  // eager gate for tools OUTSIDE the allowlist: any tool result estimated at
  // this many tokens or more is paged out, whichever tool produced it. The
  // audit of 48 real sessions showed 20.7% of journaled tool tokens come from
  // shell/execute and MCP dumps — classes the name-allowlist never covered.
  // null disables; 8000 catches the ugly tail (p90 reads are 61K) without
  // paging routine output (median shell result ≈ 590 tokens).
  toolResultEagerTokens: 8000,
  toolResultHeadLines: 40,
  toolResultTailLines: 20,
  // keep this many of the most recent tool results verbatim — the agent is
  // working from them, so compressing them causes re-reads.
  toolResultProtectRecent: 3,
  // never compress results from the current user turn (they become eligible on
  // the next turn); keeps the agent's working set intact mid-task.
  toolResultProtectTurn: true,
  // Layer 1b: hard per-request budget. Unlike Layer 1 (which waits for
  // OpenCode's compaction), this runs on every outgoing request, so models
  // with huge windows (Kimi K3: 1M tokens) are covered too. Once the message
  // list exceeds `requestBudgetTokens`, older tool output, assistant prose,
  // reasoning and attachments are compressed in place; if that is not enough,
  // the oldest parts are reduced to one-line pointers. Recent messages and all
  // user turns stay verbatim.
  requestCompression: true,
  // max estimated tokens for the message list of one request (not counting
  // the system prompt or tool definitions).
  requestBudgetTokens: 45_000,
  // Largest transcript worth scanning for the facts a pack left out. Above
  // this the scan is skipped: a multi-MB history costs more to score than the
  // recovered module saves.
  evalMaxChars: 400_000,
  // Keep the last request and the reply it answers verbatim in every pack, and
  // append what the distiller dropped. Both are cheap; both are on by default.
  distillAnchors: true,
  distillRecovered: true,
  // aim for this fraction of the incoming context (0 = disabled). With 0.08 a
  // 160K request is cut to ~13K (>90% smaller); the hard cap above still
  // applies to 1M-token windows, and the floor below prevents over-compression.
  requestTargetRatio: 0.08,
  // never shrink a request below this, even when the ratio says so.
  requestMinBudgetTokens: 10_000,
  // below this, leave the request alone even if the budget is smaller.
  requestMinTokens: 20_000,
  // never let one request exceed this fraction of the model's context window
  // (system prompt and tool schemas are not counted, so leave headroom).
  requestMaxPromptRatio: 0.5,
  // transcript tokens fed to the distiller; 0 = derive from the model window
  // (40% of it, capped at 48K). Set explicitly for a pinned small distiller.
  distillBudgetTokens: 0,
  // newest N messages are always sent verbatim.
  requestProtectRecent: 6,
  // protect the newest N tokens of the current user turn as well. A turn can
  // contain hundreds of tool results; a message count of 6 covers only a few.
  // Capped by the request budget, so small windows still compress.
  requestProtectTurns: true,
  requestTurnProtectTokens: 40_000,
  // skip a rewrite that saves less than this share of the request: a few
  // percent is not worth a cache miss or a changed view for the agent.
  requestMinSavingsPct: 12,
  // even when the protected tail alone exceeds the budget, the final N
  // messages are shielded from elision (they may still be head+tail
  // compressed). 0 = shield none; user turns are always protected.
  requestHardProtect: 2,
  // parts below this size are not worth rewriting.
  requestPartMinTokens: 800,
  // in the hard-budget phase, even small parts are worth paging once the
  // alternative is sending them verbatim; the marker costs ~35 tokens.
  requestElideMinTokens: 200,
  // Layer 3 — collapse old tool steps into deterministic ledger rows
  // (#step · tool · target · exit · size · recall). No model call, no drift;
  // the newest `requestLedgerKeepRecent` results stay byte-for-byte.
  requestLedger: true,
  requestLedgerKeepRecent: 5,
  requestLedgerKeepTokens: 8_000,
  requestLedgerMinTokens: 60,
  // A huge historical user message (pasted transcript, injected checkpoint,
  // log dump) is bulk, not an instruction. Condense it to opening + constraint
  // lines + closing, with a recall handle. The live user message is untouched.
  requestCompressUserBulk: true,
  requestUserBulkMinTokens: 32_000,
  requestUserKeepTokens: 4_000,
  requestUserHeadChars: 4_000,
  requestUserTailChars: 1_000,
  // elide old image/file attachments (re-attach if the model needs them).
  requestElideAttachments: true,
  // blank out old reasoning text — never for signed/encrypted reasoning.
  requestElideReasoning: true,
  // tell the model, once per session, how paging works and how to recover text.
  requestContract: true,
  // Layer 1c: ask OpenCode to compact when the model's own auto-compaction
  // would not fire for a very long time (e.g. 1M-token Kimi K3).
  proactiveCompaction: true,
  // only compact at a turn boundary: compacting mid-task replaces the working
  // set the agent is still using.
  proactiveCompactAtTurnBoundary: true,
  // fraction of the model's context window that triggers it.
  proactiveCompactRatio: 0.35,
  // absolute floor so small-window models are untouched.
  proactiveCompactMinTokens: 120_000,
  // minimum gap between two proactive compactions for the same session.
  proactiveCompactCooldownMs: 10 * 60_000,
};

function log(...args) {
  console.warn("[contextpack]", ...args);
  // console output is not captured by the background service — mirror to a file
  fs.appendFile(path.join(ROOT, "debug.log"), `[${new Date().toISOString()}] ${args.map((a) => (typeof a === "string" ? a : safeStr(a))).join(" ")}\n`).catch(() => {});
}

function safeStr(v) { try { return JSON.stringify(v); } catch { return "[unserializable]"; } }

// Tool-result compression (read / grep / glob)
//
// Tool results are the bulk of a session and are resent on every later turn.
// Headroom compressed them on the wire; we compress them at the source. The
// rewrite keeps a head, a tail, and every structural or diagnostic line, and
// leaves line numbers intact so the agent can re-read an exact range.
// (`compressToolResult`, `compressToolText` and `estTokens` live in
// lib/text.mjs so they are unit testable without loading this module.)

async function readJson(file) {
  try { return JSON.parse(await fs.readFile(file, "utf8")); } catch { return null; }
}

// ---------------------------------------------------------------------------
// Transcript extraction — Message shapes vary; pull text defensively.
// ---------------------------------------------------------------------------

function partText(p) {
  if (typeof p === "string") return p;
  if (!p || typeof p !== "object") return "";
  return p.text ?? p.content ?? "";
}

// Extract a linear human-readable transcript from OpenCode session messages.
// The compaction hook delivers provider-normalized (AI SDK style) messages:
//   {role:"user"|"assistant"|"tool", content:[{type:"text"|"reasoning"|"tool-call"|"tool-result",...}]}
// where tool results are role:"tool" messages with {type:"tool-result", toolName, output}.
// Other surfaces may use API shapes (type:"assistant" + content[{type:"tool",state:...}]). Both handled.
function transcriptText(messages) {
  const lines = [];
  let toolCount = 0, userCount = 0, assistantCount = 0;

  for (const m of messages || []) {
    const role = m?.role ?? m?.type ?? "user";
    const chunks = [];

    const content = m?.content;
    if (typeof content === "string" && content) chunks.push(content);
    if (Array.isArray(content)) {
      for (const c of content) {
        if (c?.type === "text" && typeof c.text === "string") {
          chunks.push(c.text);
        } else if (typeof c?.text === "string" && c.text && c?.type !== "reasoning") {
          chunks.push(c.text);
        } else if (c?.type === "tool-call") {
          // the call result follows in the tool message; skip here
        } else if (c?.type === "tool-result" || role === "tool") {
          const name = c?.toolName ?? c?.toolCallId ?? "tool";
          toolCount++;
          const out = toolResultOutputText(c);
          chunks.push(`[tool ${name}] ${out}`);
        } else if (c?.type === "tool") {
          // API-shaped tool part
          const name = c?.name ?? c?.tool ?? "tool";
          toolCount++;
          chunks.push(`[tool ${name}] ${toolBlockText(c.state)}`);
        }
        // reasoning: skip (internal thinking)
      }
    }

    if (typeof m?.text === "string" && m.text) chunks.push(m.text);
    if (role === "compaction" && (m.summary || m.recent)) {
      chunks.push(`(prior compaction, summary)\n${m.summary ?? ""}`);
    }

    if (Array.isArray(m?.parts)) {
      for (const p of m.parts) {
        const pt = p?.type ?? (typeof p === "string" ? "text" : "");
        if (pt === "text") {
          const t = partText(p);
          if (t) chunks.push(t);
        } else {
          const name = p?.tool ?? p?.toolName ?? p?.toolID ?? pt;
          const state = p?.state ?? p;
          const out = toolBlockText(state);
          toolCount++;
          chunks.push(`[tool ${name}] ${out}`);
        }
      }
    }

    const body = chunks.join("\n\n");
    if (!body) continue;
    if (role === "user") userCount++;
    if (role === "assistant") assistantCount++;
    lines.push(`### ${String(role).toUpperCase()}\n${body}`);
  }

  if (!lines.length) log("warning: extracted 0 lines from", (messages || []).length, "messages");
  log(`transcript extracted: ${lines.length} parts (user:${userCount} assistant:${assistantCount} tool:${toolCount})`);
  return { text: lines.join("\n\n"), toolCount };
}

function toolResultOutputText(c) {
  const o = c?.output ?? c?.result ?? c?.text ?? c?.value;
  if (typeof o === "string") return o;
  if (Array.isArray(o)) return o.map((x) => x?.text ?? x?.value ?? "").filter(Boolean).join("\n");
  if (o?.value != null) return typeof o.value === "string" ? o.value : safeStr(o.value);
  if (o?.text != null) return typeof o.text === "string" ? o.text : safeStr(o.text);
  try {
    const s = safeStr(o ?? {});
    return s === "{}" ? "" : s.slice(0, 1200);
  } catch { return ""; }
}

function toolBlockText(state) {
  const texts = [];
  for (const c of state?.content ?? []) {
    if (c?.type === "text" && typeof c.text === "string") texts.push(c.text);
  }
  const err = state?.error?.message ?? (state?.error ? safeStr(state.error) : "");
  const joined = texts.join("\n");
  return (joined || err || "").slice(0, TOOL_RESULT_HEAD_CHARS + TOOL_RESULT_TAIL_CHARS);
}

function deepText(v, depth) {
  if (depth > 6 || v == null) return "";
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.map((x) => deepText(x, depth + 1)).filter(Boolean).join("\n");
  if (typeof v !== "object") return "";
  for (const k of ["text", "content", "output"]) {
    if (typeof v[k] === "string") return v[k];
  }
  return deepText(Object.values(v), depth + 1);
}

function normalizeModel(m) {
  if (!m) return null;
  const providerID = m.providerID;
  const id = m.id ?? m.modelID;
  return providerID && id ? { providerID, id } : null;
}

// Best-effort lookup of another model's window (used when `distillModel` is
// pinned). Hosts without a catalog API simply return 0 and the caller falls
// back to the session model's window.
function modelWindow(ctx, model) {
  try {
    const rec = ctx?.catalog?.model?.get?.(model.providerID, model.id);
    return Number(rec?.limit?.context ?? rec?.limit?.input) || 0;
  } catch {
    return 0;
  }
}

// Best-effort identity of the model the current prompt runs under. The
// compaction event carries `event.model`; prompt events depend on the host,
// so several carriers are probed. Absent identity -> null, and callers stay
// conservative (treat the session model as text-only).
function sessionModelIdentity(event) {
  return (
    normalizeModel(event?.model) ??
    normalizeModel(event?.message?.model) ??
    normalizeModel(event?.prompt?.model)
  );
}

// Best-effort image-input check for a catalogued model. Deliberately
// conservative: no catalog, unknown shape, or an ambiguous capability shape
// all report false, so the vision-agent note is still sent when in doubt.
// A false "false" costs one harmless delegation note; a false "true" would
// leave a text-only model staring at a placeholder.
function modelSeesImages(ctx, model) {
  if (!model) return false;
  try {
    const rec = ctx?.catalog?.model?.get?.(model.providerID, model.id);
    const caps = rec?.capabilities ?? rec;
    const input = caps?.input ?? caps?.capabilities?.input;
    if (Array.isArray(input)) {
      return input.some((v) => /^image/.test(String(v).toLowerCase()));
    }
    if (caps?.attachment === true || rec?.attachment === true) return true;
  } catch {}
  return false;
}

// Route distillation text generation.
//
// `ctx.generate.text` is intentionally session-less, but some provider-side
// gates reject session-less calls — OpenCode's free tier answers them with
// "free tier can only be used from within OpenCode", which used to force the
// native-compaction fallback. `ctx.session.generate` carries the session
// identity and is accepted, so it is used as a fallback (or, if opted in, as
// the primary route). The legacy session-less call stays first by default, so
// providers that already work are unaffected.
async function distillText(ctx, { sessionID, model, prompt, preferSession, allowFallback = true }) {
  const canSession = typeof ctx.session?.generate === "function" && !!sessionID;
  const canText = typeof ctx.generate?.text === "function";
  const viaSession = async () => {
    if (!canSession) throw new Error("session-scoped generate unavailable");
    return (await ctx.session.generate({ sessionID, prompt }))?.text;
  };
  const viaText = async () => {
    if (!canText) throw new Error("generate.text unavailable");
    return (await ctx.generate.text({ model, prompt }))?.text;
  };
  return routeDistill({
    viaSession,
    viaText,
    preferSession,
    allowFallback,
    onError: (route, e) => log(`distillation call failed (${route}), retrying via the other route:`, e?.message ?? e),
  });
}

// Ask OpenCode for a real compaction once the context is a fraction of the
// model's window. On 1M-token models OpenCode's own threshold is so high that
// it effectively never fires; this keeps sessions bounded and gives Layer 1 a
// chance to replace the summary with a pack.
function maybeRequestCompaction(ctx, event, stats, opts) {
  try {
    if (opts.proactiveCompaction === false) return;
    if (typeof ctx.session?.compact !== "function") return;
    const sessionID = event?.sessionID;
    if (!sessionID || !stats?.before) return;
    // Compacting mid-tool-loop wipes the working set the agent is still using.
    // Wait for a turn boundary (the request that starts with a user message).
    if (opts.proactiveCompactAtTurnBoundary !== false) {
      const last = Array.isArray(event?.messages) ? event.messages.at(-1) : null;
      if (last && last.role !== "user" && last.type !== "user") return;
    }
    if ((compactionInFlight.get(sessionID) ?? 0) > Date.now()) return;
    const limit = Number(event?.model?.limit?.context) || 0;
    const ratio = opts.proactiveCompactRatio ?? 0.35;
    const threshold = Math.max(opts.proactiveCompactMinTokens ?? 120_000, Math.round(limit * ratio));
    if (stats.before < threshold) return;
    const now = Date.now();
    if (now - (proactiveRequested.get(sessionID) ?? 0) < (opts.proactiveCompactCooldownMs ?? 600_000)) return;
    proactiveRequested.set(sessionID, now);
    log(`proactive compaction requested: ${fmt(stats.before)} tok ≥ ${fmt(threshold)} (model=${event?.model?.id ?? "?"})`);
    void Promise.resolve(ctx.session.compact({ sessionID, delivery: "queue" })).catch((e) => log("proactive compaction failed:", e?.message ?? e));
  } catch (e) {
    log("proactive compaction skipped:", e?.message ?? e);
  }
}

// ---------------------------------------------------------------------------
// Pack IO
// ---------------------------------------------------------------------------

async function packDir(sessionID) { return path.join(ROOT, "sessions", sessionID); }

async function readIndex(sessionID) {
  const d = await packDir(sessionID);
  return readJson(path.join(d, "index.json"));
}

async function writeJournal(sessionID, entry) {
  const d = await packDir(sessionID);
  await fs.mkdir(d, { recursive: true });
  const file = path.join(d, "journal.jsonl");
  let lines = [];
  try {
    const cur = await fs.readFile(file, "utf8");
    lines = cur ? cur.split("\n").filter(Boolean) : [];
  } catch { /* new journal */ }
  lines.push(JSON.stringify(entry));
  if (lines.length > JOURNAL_LIMIT_ENTRIES) lines = lines.slice(-JOURNAL_LIMIT_ENTRIES);
  await fs.writeFile(file, lines.join("\n") + "\n");
}

// ---------------------------------------------------------------------------
// Summary construction
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Trigger matching
// ---------------------------------------------------------------------------

function normalizeTriggerText(text) {
  return ` ${String(text).toLowerCase().replace(/[^a-z0-9]+/g, " ")} `;
}

function matchModules(idx, userText) {
  const hay = normalizeTriggerText(userText);
  const scored = [];
  for (const m of idx.modules || []) {
    if (m.hot) continue; // state/decisions already in context
    let hits = 0;
    for (const t of m.triggers || []) {
      if (hay.includes(` ${t} `) || (t.includes(" ") && t.split(" ").every((w) => hay.includes(` ${w} `)))) hits++;
    }
    if (hits) scored.push({ m, hits });
  }
  scored.sort((x, y) => y.hits - x.hits || x.m.tokens - y.m.tokens);
  return scored.map((s) => s.m);
}

// ---------------------------------------------------------------------------
// Vision routing
// ---------------------------------------------------------------------------

// Image references in the prompt text: shell-style tokens (quoted or not),
// tilde-expanded, trailing punctuation stripped. Verified against the
// filesystem below — a guessed path must never reach the spawn prompt.
function imagePathsInText(text) {
  const found = [];
  for (const raw of String(text).split(/[\s"'`]+/)) {
    let tok = raw.replace(/^[([{<]+/, "").replace(/[)\]>,.;:!?]+$/, "");
    if (!tok || tok.length > 400) continue;
    if (!IMAGE_FILE_EXT.test(tok)) continue;
    let p = tok;
    if (p.startsWith("~/") || p === "~") p = path.join(os.homedir(), p.slice(1));
    if (!path.isAbsolute(p)) continue; // relative refs are ambiguous per cwd
    found.push(p);
  }
  return found;
}

function imagePathsInFiles(files) {
  const found = [];
  for (const f of files ?? []) {
    const uri = typeof f === "string" ? f : f?.uri;
    if (!uri) continue;
    try {
      const u = new URL(uri);
      if (u.protocol !== "file:") continue;
      // fileURLToPath handles POSIX paths and Windows drive letters/unnamed
      // host forms on every platform; a malformed file URL is not a path.
      let p;
      try {
        p = fileURLToPath(u);
      } catch {
        continue;
      }
      // IMAGE_FILE_EXT on the decoded name keeps "Screenshot 2026-10-25 at
      // 13.43.25.png" warm.
      if (IMAGE_FILE_EXT.test(p)) found.push(p);
    } catch {}
  }
  return found;
}

// Returns { targets, intent }:
//   targets — unique verified image paths (attachment URIs always count even
//             when the workspace cannot stat them; text paths must exist).
//   intent  — picture wording present but nothing verifiable to hand over.
async function visionTargets(text, files) {
  const waiting = [
    ...imagePathsInFiles(files).map((p) => ({ p, verified: true })),
    ...imagePathsInText(text).map((p) => ({ p, verified: null })),
  ];
  const seen = new Set();
  const targets = [];
  for (const { p, verified } of waiting) {
    if (seen.has(p)) continue;
    seen.add(p);
    if (verified === true) { targets.push(p); continue; }
    try { await fs.access(p); targets.push(p); } catch {}
  }
  const intent = targets.length === 0 && VISION_INTENT_WORDS.test(text);
  return { targets, intent };
}

async function visionAgentAvailable(ctx, agentID) {
  try {
    const agents = await ctx.agent?.list?.();
    if (!Array.isArray(agents) || !agents.length) return true; // unknown -> assume ok
    const ids = new Set(agents.map((a) => a?.id ?? a?.name).filter(Boolean));
    return ids.has(agentID);
  } catch {
    return true;
  }
}

async function sendVisionRouteNote(ctx, sessionID, paths) {
  if (typeof ctx.session?.synthetic !== "function") return false;
  const list = paths.map((p) => `- ${p}`).join("\n");
  const note =
    `[babyzilla vision-route] This prompt involves image content the current session model cannot see ` +
    `(text-only model; images are replaced by a placeholder note in its request). Delegate the visual work ` +
    `to the vision subagent in your next step, passing these exact file path(s) in the subagent prompt so it ` +
    `can read and describe the pixels itself:\n${list}\n` +
    `Do not guess at image content from filenames or wording.`;
  try {
    await ctx.session.synthetic({ sessionID, text: note });
    return true;
  } catch (e) {
    log("vision-route note failed:", e?.message ?? e);
    return false;
  }
}

// Prompts that already name the vision subagent need no router nudge.
function explicitVisionDelegate(text) {
  return /\bvision\b[^\n]{0,40}\bsubagent/i.test(text) || /\bsubagent\b[^\n]{0,40}\bvision\b/i.test(text);
}

// ---------------------------------------------------------------------------
// Library (cross-session packs)
// ---------------------------------------------------------------------------

async function promoteToLibrary(sessionID, modules, projectDir) {
  if (!projectDir || projectDir === os.homedir()) return;
  // Temp/test locations must not pollute the cross-session library (realpath
  // of $TMPDIR on macOS carries a /private prefix).
  const tmpdir = os.tmpdir();
  if (
    projectDir === tmpdir ||
    projectDir.startsWith(tmpdir + path.sep) ||
    projectDir.startsWith("/tmp/") ||
    projectDir.startsWith("/private/tmp/") ||
    projectDir.startsWith("/private/var/folders/")
  ) return;

  // Only promote when there is actually something to promote — an empty
  // library row would skew `lowfat pack stats` project counts.
  const isCarry = (m) => CARRY_KINDS.has(m.kind) && m.name !== "recovered";
  const carry = modules.filter(isCarry);
  if (!carry.length) return;

  const lib = path.join(ROOT, "library", dirSlug(projectDir));
  await fs.mkdir(lib, { recursive: true });
  const existing = await readJson(path.join(lib, "index.json")) ?? { modules: [] };
  if (!Array.isArray(existing.modules)) existing.modules = [];
  for (const m of carry) {
    const file = `lib-${m.name}.md`;
    await fs.writeFile(path.join(lib, file), m.content);
    const prev = existing.modules.find((x) => x.name === m.name);
    // state/decisions stay hot: the carry-in layer attaches them on the next
    // session's first prompt without a keyword match. Everything else is
    // cold — trigger-matched only, exactly like the pre-0.7.6 library.
    const entry = {
      name: m.name,
      kind: m.kind,
      file,
      tokens: estTokens(m.content),
      triggers: m.triggers,
      hot: CARRY_CORE.has(m.kind) && !!m.hot,
    };
    if (prev) Object.assign(prev, entry); else existing.modules.push(entry);
  }
  existing.projectDir = projectDir;
  existing.updated = new Date().toISOString();
  await fs.writeFile(path.join(lib, "index.json"), JSON.stringify(existing, null, 2));
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

// Layer 2 helpers (lowfat integration) — adapted from lowfat's v2 plugin
// (github.com/zdk/lowfat by zdk — Apache-2.0).

// Lowfat is optional: when it is missing, Layer 2 is skipped and everything
// else keeps working. Resolution must not assume a POSIX shell — Windows
// hosts have neither `command -v` nor `test -x`.
async function resolveLowfatBinary() {
  const win = process.platform === "win32";
  const exe = win ? "lowfat.exe" : "lowfat";
  try {
    const { stdout } = await execAsync(win ? "where lowfat" : "command -v lowfat");
    const onPath = stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
    if (onPath) return onPath;
  } catch { /* not on PATH */ }
  const candidates = [
    path.join(os.homedir(), ".local", "bin", exe),
    path.join(os.homedir(), ".cargo", "bin", exe),
    "/usr/local/bin/lowfat",
    "/opt/homebrew/bin/lowfat",
  ];
  if (win) {
    if (process.env.LOCALAPPDATA) candidates.push(path.join(process.env.LOCALAPPDATA, "Programs", "lowfat", exe));
    candidates.push(path.join(os.homedir(), "scoop", "shims", exe));
  }
  for (const candidate of candidates) {
    try {
      const st = await fs.stat(candidate);
      if (!st.isFile()) continue;
      if (!win && (st.mode & 0o111) === 0) continue;
      return candidate;
    } catch { /* not here */ }
  }
  return null;
}

// Extract the model-visible text of a tool part, whatever shape it has.
function textOfPart(part) {
  const st = part?.state ?? {};
  if (typeof st.output === "string" && st.output) return st.output;
  const content = Array.isArray(st.content) ? st.content
    : Array.isArray(part?.result?.content) ? part.result.content
    : null;
  if (content) {
    const text = content.map((c) => (typeof c?.text === "string" ? c.text : "")).join("");
    if (text) return text;
  }
  if (typeof part?.result?.value === "string") return part.result.value;
  return "";
}

// Compress tool results from the live session context, protecting the most
// recent one(s). Runs on every tool completion, so it must stay cheap and
// idempotent: parts that already carry the ContextPack footer are skipped.
async function compressOlderToolResults(ctx, sessionID, opts) {
  if (typeof ctx.session?.context !== "function" || !sessionID) return 0;
  const messages = await ctx.session.context({ sessionID });
  const targets = selectCompressibleParts(messages, opts.toolResultProtectRecent ?? 3, COMPRESSIBLE_TOOLS, {
    protectTurn: opts.toolResultProtectTurn !== false,
    dedupe: true,
    eagerMinTokens: opts.toolResultEagerTokens ?? null,
  });
  // The request shape carries no message ids, so the recall handle is a
  // content hash of the exact original text, written to the page store.
  let n = 0;
  for (const part of targets) {
    // Allowlisted tools keep their own (lower) threshold; everything else is
    // held to the eager gate it was selected by.
    const name = String(part.name ?? part.tool ?? "").toLowerCase();
    const min = COMPRESSIBLE_TOOLS.has(name)
      ? (opts.toolResultMinTokens ?? 4000)
      : (opts.toolResultEagerTokens ?? opts.toolResultMinTokens ?? 4000);
    const ref = writePage(ROOT, textOfPart(part), { sessionID });
    n += compressToolResult(part, { ...opts, toolResultMinTokens: min }, (tool, before, after) =>
      log(`tool result compressed: ${tool} ${fmt(before)}→${fmt(after)} tok`), ref);
  }
  return n;
}

export default {
  id: "contextpack",
  setup: async (ctx) => {
    const opts = { ...defaults, ...(ctx.options ?? {}) };

    // ---- journal capture (stats + raw bulk record) -------------------------
    if (typeof ctx.tool?.hook === "function") {
      await ctx.tool.hook("execute.after", async (event) => {
        try {
          const toolName = event?.tool ?? event?.toolName ?? event?.name ?? "?";
          const sid = event?.sessionID;
          if (!sid) return;
          const out = typeof event?.result === "string" ? event.result : deepText(event?.result, 0);
          const err = event?.error?.message ?? (event?.error ? String(event.error) : "");
          void writeJournal(sid, {
            t: Date.now(),
            tool: toolName,
            status: event?.status ?? "completed",
            tokens: estTokens(out || err),
            head: (out || err || "").slice(0, 1200),
          }).catch(() => {});
        } catch { /* journal must never affect execution */ }
        // compress large tool results, but never the most recent one(s):
        // the agent is actively working from those, and compressing them
        // causes the re-reads we saw in the head-to-head.
        if (opts.toolResultCompression) {
          try {
            let compressed = 0;
            if (typeof ctx.session?.context === "function" && event?.sessionID) {
              compressed = await compressOlderToolResults(ctx, event.sessionID, opts);
            }
            // No context API (older runtime): fall back to compressing in place.
            if (!compressed && typeof ctx.session?.context !== "function") {
              const toolName = String(event?.tool ?? event?.toolName ?? event?.name ?? "").toLowerCase();
              if (COMPRESSIBLE_TOOLS.has(toolName)) {
                compressToolResult(event, opts, (tool, before, after) =>
                  log(`tool result compressed: ${tool} ${fmt(before)}→${fmt(after)} tok`));
              }
            }
          } catch (e) { log("tool result compression skipped:", e?.message ?? e); }
        }
      });
    } else {
      log("tool.hook unavailable — journal capture disabled");
    }

    // ---- layer 2: command-output compression (lowfat) ----------------------
    // Adapted from the lowfat v2 tool-hook plugin
    // (github.com/zdk/lowfat by zdk — Apache-2.0). Rewrites shell commands
    // through `lowfat rewrite` before execution so tool output enters the
    // context pre-compressed. Skips silently when the binary is absent.
    if (opts.toolCompression !== false && typeof ctx.tool?.hook === "function") {
      const lowfatBinary = await resolveLowfatBinary();
      if (lowfatBinary) {
        await ctx.tool.hook("execute.before", async (a) => {
          try {
            if (a?.tool !== "shell" && a?.tool !== "bash") return;
            const command = a?.input?.command;
            if (typeof command !== "string" || !command) return;
            if (/\|\s*lowfat\b/.test(command)) return; // already rewritten
            let out = "";
            try {
              const { stdout } = await execFileAsync(lowfatBinary, ["rewrite", command], { maxBuffer: 8 * 1024 * 1024 });
              out = stdout.trim();
            } catch (err) {
              out = String(err?.stdout ?? "").trim();
            }
            if (out && out !== command) {
              a.input = { ...a.input, command: out };
            }
          } catch { /* rewrite must never break execution */ }
        });
        log(`layer 2 active: shell rewrites via ${lowfatBinary}`);
      } else {
        log("layer 2 skipped: lowfat binary not found on PATH or ~/.local/bin (see AGENT-INSTALL.md)");
      }
    }

    // ---- per-request context budget (works without compaction) ------------
    // OpenCode v2 runs `context` hooks for every primary request, handing over
    // the exact `messages` array. Mutating it here is honoured by the runtime
    // (the built-in plan-mode plugin uses the same mechanism). This is what
    // makes BabyZilla effective on huge-window models like Kimi K3 (1M), where
    // native compaction — and therefore Layer 1 — may never fire.
    if (typeof ctx.session?.hook === "function" && opts.requestCompression !== false) {
      await ctx.session.hook("context", async (event) => {
        try {
          const messages = event?.messages;
          if (!Array.isArray(messages) || !messages.length) return;
          const stats = compactMessagesForRequest(messages, {
            ...opts,
            modelContext: Number(event?.model?.limit?.context ?? event?.model?.limit?.input) || undefined,
            // Persist the exact bytes of anything paged out, so the marker's
            // `babyzilla recall <hash>` handle is always true.
            pageRef: (text) => writePage(ROOT, text, { sessionID: event?.sessionID }),
          });
          if (stats.saved > 0) {
            log(`request compacted: ${fmt(stats.before)} → ${fmt(stats.after)} tok (${stats.savedPct}% smaller, ${stats.parts} parts, model=${event?.model?.id ?? "?"})`);
            if (stats.before > 200_000) {
              const byRole = {};
              for (const m of messages) {
                const r = m?.role ?? m?.type ?? "?";
                byRole[r] = (byRole[r] ?? 0) + estTokens(JSON.stringify(m?.content ?? m?.text ?? ""));
              }
              log(`after split: ${Object.entries(byRole).map(([k, v]) => `${k}=${fmt(v)}`).join(" ")}`);
            }
            void recordRequestStats(event?.sessionID, stats);
            // Explain the deal once per session, so the agent can plan around
            // paging instead of discovering it marker by marker.
            if (opts.requestContract !== false && event?.sessionID && !contractSent.has(event.sessionID)) {
              contractSent.add(event.sessionID);
              if (typeof ctx.session?.synthetic === "function") {
                void Promise.resolve(ctx.session.synthetic({ sessionID: event.sessionID, text: CONTRACT_NOTE }))
                  .catch((e) => log("contract note skipped:", e?.message ?? e));
              }
            }
          } else if (stats.skipped) {
            log(`request left untouched: ${fmt(stats.before)} tok (${stats.skipped})`);
            const big = [];
            for (const m of messages) {
              for (const p of m?.content ?? []) {
                const raw = p?.result?.value ?? p?.text ?? p?.state?.output ?? p?.input ?? "";
                big.push({ role: m.role ?? m.type, type: p?.type, tok: estTokens(typeof raw === "string" ? raw : JSON.stringify(raw)) });
              }
            }
            big.sort((a, b) => b.tok - a.tok);
            log(`skip diagnostics: ${big.slice(0, 4).map((p) => `${p.role}/${p.type}=${fmt(p.tok)}`).join(" ")}`);
          }
          maybeRequestCompaction(ctx, event, stats, opts);
        } catch (e) {
          // Never break a request: any partial rewrite is text-only, so the
          // messages remain structurally valid and the request still runs.
          log("request compression skipped:", e?.message ?? e);
        }
      });
    }

    // ---- compaction replacement ------------------------------------------
    if (typeof ctx.session?.hook === "function") {
      await ctx.session.hook("compaction", async (event) => {
        let owned = false; // only the event that set the lock clears it
        try {
          if (event?.result) {
            log("compaction: result already set by an earlier hook — yielding");
            return;
          }
          const inflightUntil = compactionInFlight.get(event?.sessionID) ?? 0;
          if (inflightUntil > Date.now()) {
            log("compaction: distillation already in flight for this session — skipping duplicate event");
            return;
          }
          compactionInFlight.set(event.sessionID, Date.now() + 120_000);
          owned = true;

          log(`compaction fired: session=${event?.sessionID} reason=${event?.reason ?? "?"} model=${safeStr(event?.model)?.slice(0, 80)} msgs=${(event?.messages ?? []).length}`);
          const model = normalizeModel(opts.distillModel) ?? normalizeModel(event?.model);
          if (!model) throw new Error("no model available for distillation");

          let extracted = transcriptText(event?.messages);
          let sourceMessages = Array.isArray(event?.messages) ? event.messages : [];
          let rawTokens = estTokens(extracted.text);
          // Some manual/free-tier compactions pass a single synthetic message
          // (the compaction instruction) instead of the transcript. Pull the
          // live session context in that case so distillation has real input.
          if (rawTokens < opts.minRawTokens && typeof ctx.session?.context === "function") {
            try {
              const live = await ctx.session.context({ sessionID: event.sessionID });
              const alt = transcriptText(live);
              const altTokens = estTokens(alt.text);
              if (altTokens > rawTokens) {
                log(`compaction: event had only ${fmt(rawTokens)} tok; using live context (${fmt(altTokens)} tok)`);
                extracted = alt;
                sourceMessages = live;
                rawTokens = altTokens;
              }
            } catch (e) {
              log("compaction: live-context fallback failed:", e?.message ?? e);
            }
          }
          log(`compaction: ${fmt(rawTokens)} raw tokens`);
          if (rawTokens < opts.minRawTokens) {
            log("compaction: transcript below minRawTokens — letting native compaction run");
            return;
          }
          const pinned = normalizeModel(opts.distillModel);
          const distillWindow =
            (pinned && modelWindow(ctx, pinned)) ||
            Number(event?.model?.limit?.context ?? event?.model?.limit?.input) ||
            0;
          const reduced = reduceForDistill(extracted.text, distillInputBudget({
            windowTokens: distillWindow,
            explicit: opts.distillBudgetTokens,
          }));

          const prevIdx = await readIndex(event.sessionID);
          const prevPack = prevIdx && (await readModules(prevIdx));
          const prompt = distillationPrompt(prevPack, reduced.text);
          log(`distilling with ${model.providerID}/${model.id} (fed ~${fmt(estTokens(reduced.text))} tokens of ${fmt(rawTokens)})…`);
          let modules = null;
          for (let attempt = 1; attempt <= 2 && !modules; attempt++) {
            const retryNote = attempt > 1 ? "\n\nIMPORTANT: your previous reply was not parseable. Output ONLY newline-delimited JSON objects per line, exactly as instructed. No thinking, no fences." : "";
            const mode = opts.distillVia ?? "auto";
            const preferSession = mode === "session" || (mode === "auto" && model?.providerID === "opencode");
            const allowFallback = mode !== "text";
            const out = { text: await distillText(ctx, { sessionID: event.sessionID, model, prompt: DISTILL_INSTRUCTIONS + "\n\n" + prompt + retryNote, preferSession, allowFallback }) };
            try {
              modules = parseModules(out.text);
            } catch (e) {
              if (attempt === 2) throw e;
              log(`distill parse failed (attempt ${attempt}) — raw head: ${(out?.text ?? "").slice(0, 400).replace(/\n/g, " ⏎ ")}`);
            }
          }

          if (!modules.some((m) => m.kind === "state")) throw new Error("distiller produced no state module");

          // Assemble the final pack: de-dupe, guarantee the anchor,
          // best-of-N ranking, recovery — one pure seam, one place to test.
          const { chosen, picked, missing } = assemblePack({
            parsed: modules,
            sourceMessages,
            transcript: extracted.text,
            rawTokens,
            opts,
          });

          log(`pack: ${picked ? `${picked.winner?.name} ${picked.winner?.score}/100` : "anchor-only"}${missing ? " + facts" : ""} (${fmt(estTokens(renderModules(chosen)))} tok, ${chosen.length} modules)`);

          const d = await packDir(event.sessionID);
          await fs.mkdir(d, { recursive: true });
          const files = {};
          for (const m of chosen) {
            const file = moduleFileFor(m);
            await fs.writeFile(path.join(d, file), m.content);
            files[moduleFileFor(m)] = path.join(d, file);
          }

          // project dir: needed verifiably by `lowfat pack verify` (relative
          // path:line pointers resolve against it) and used for the library.
          let projectDir = null;
          if (typeof ctx.session?.get === "function") {
            try {
              const info = await ctx.session.get({ sessionID: event.sessionID });
              projectDir = info?.directory ?? info?.location?.directory ?? info?.project?.directory ?? null;
            } catch (e) { log("session info lookup skipped:", e?.message); }
          }

          const packTokens = chosen.reduce((n, m) => n + estTokens(m.content), 0);
          const summaryStats = { rawTokens, packTokens, savedPct: Math.max(0, Math.round((1 - packTokens / rawTokens) * 100)) };

          await fs.writeFile(path.join(d, "index.json"), JSON.stringify({
            sessionID: event.sessionID,
            created: new Date().toISOString(),
            model,
            projectDir,
            stats: summaryStats,
            rawTranscriptTokens: rawTokens,
            modules: chosen.map((m) => ({
              name: m.name, kind: m.kind, file: moduleFileFor(m), path: files[moduleFileFor(m)],
              tokens: estTokens(m.content), triggers: m.triggers,
              hot: m.kind === "state" || m.kind === "decisions" || m.kind === ANCHOR_KIND || m.name === "recovered",
            })),
          }, null, 2));

          // cross-session library promotion (tool knowledge outlives sessions)
          if (opts.library && projectDir) {
            try {
              await promoteToLibrary(event.sessionID, chosen, projectDir);
            } catch (e) { log("library promotion skipped:", e?.message); }
          }

          event.result = {
            summary: buildSummary({ modules: chosen, files }, summaryStats),
            metadata: { contextpack: { ...summaryStats, files: chosen.length, model } },
          };
          log(`compaction swapped: raw ${fmt(rawTokens)} tok → pack ${fmt(packTokens)} tok (${summaryStats.savedPct}% smaller)`);
        } catch (e) {
          log("compaction distillation failed — falling back to native compaction:", e?.message ?? e);
        } finally {
          if (owned) compactionInFlight.delete(event?.sessionID);
        }
      });

      // ---- autonomous module loading on prompt -----------------------------
      await ctx.session.hook("prompt", async (event) => {
        try {
          const sid = event?.sessionID;
          const prompt = event?.prompt;
          const text = typeof prompt?.text === "string" ? prompt.text : "";
          if (!sid || !text || !prompt) {
            log(`prompt hook: bail (keys: ${Object.keys(event ?? {}).join(",")}, sid=${sid ?? "MISSING"}, text.length=${text.length})`);
            return;
          }
          prompt.files ??= [];
          if (!Array.isArray(prompt.files)) return;
          // Vision auto-routing (opt-out via visionRoute:false): before any
          // module machinery — image prompts need the nudge even when the
          // pack would bail. One synthetic note per prompt, never a loop.
          if (opts.visionRoute !== false && !explicitVisionDelegate(text)) {
            const { targets, intent } = await visionTargets(text, prompt.files);
            if (targets.length) {
              // Capability check first: if the user's selected session model
              // can read images itself, delegation would be noise. Only a
              // confirmed image-capable catalog entry suppresses the note —
              // unknown identity or shape keeps the old routing.
              const current = sessionModelIdentity(event);
              if (current && modelSeesImages(ctx, current)) {
                log(`vision-route: session model ${current.providerID}/${current.id} accepts image input — reading pixels directly, no delegation note`);
              } else if (await visionAgentAvailable(ctx, opts.visionAgent)) {
                const sent = await sendVisionRouteNote(ctx, sid, targets);
                log(`vision-route: ${targets.length} path(s) -> ${opts.visionAgent} (note ${sent ? "sent" : "SKIPPED — no session.synthetic"})`);
              } else {
                log(`vision-route: image path(s) found but agent "${opts.visionAgent}" not configured — skipped`);
              }
            } else if (intent) {
              log("vision-route: picture wording but no verifiable image path — no note");
            }
          }
          let projectDir = null;
          try {
            const info = await ctx.client.app.info();
            projectDir = info?.directory ?? info?.location?.directory ?? info?.project?.directory ?? null;
          } catch {}
          let idx = await readIndex(sid);
          // Library fallback + carry-in: on a session's first prompt we attach
          // the project library's hot modules trigger-free (any wording opens
          // warm — that is the point). A stamp file marks the session so the
          // carry fires once; every later prompt goes through keyword match.
          let carried = null;
          if (!idx?.modules?.length && opts.carryIn && projectDir && sid) {
            const stamp = path.join(ROOT, "sessions", sid, ".carryin");
            const [lib, stamped] = await Promise.all([
              libraryIndex(projectDir, ROOT).catch(() => null),
              fs.access(stamp).then(() => true, () => false),
            ]);
            const hot = (lib?.modules ?? []).filter((m) => m.hot && CARRY_CORE.has(m.kind));
            if (hot.length && !stamped) {
              carried = hot;
              idx = { projectDir, modules: hot };
              await fs.mkdir(path.join(ROOT, "sessions", sid), { recursive: true });
              await fs.writeFile(stamp, new Date().toISOString() + "\n");
              log(`prompt hook: carry-in ${hot.length} hot module(s) from library ${dirSlug(projectDir)}`);
            }
          }
          if (!idx?.modules?.length && !carried && opts.library && projectDir) {
            // v0.7.5 behavior: keyword-matched attach from the project library
            // (also covers prompt 2+ of a carry-in session before distill).
            idx = await libraryIndex(projectDir, ROOT).catch(() => null);
            if (!idx?.modules?.length) {
              log(`prompt hook: no modules to attach (session=${sid.slice(0, 14)}…, pack=${idx ? "empty" : "none"})`);
              return;
            }
          }

          // No index and no project library (headless `opencode run`, or a dir
          // with no library yet): nothing to attach, and `idx` stays null — so
          // return before the keyword gate, which assumes an index.
          if (!idx?.modules?.length) {
            log(`prompt hook: no index to attach from (session=${sid.slice(0, 14)}…, projectDir=${projectDir ? "yes" : "none"})`);
            return;
          }

          // Carried context skips the keyword gate entirely — the whole point
          // is that any first prompt (even "ok go") opens the project warm.
          const matched = carried ? idx.modules : matchModules(idx, text);
          log(`prompt hook: session=${sid.slice(0, 14)}… candidates=${matched.length}${idx.projectDir ? ` (library for ${idx.projectDir.slice(0, 30)})` : ""}`);
          let budget = opts.attachBudgetTokens;
          const picked = [];
          for (const m of matched) {
            if (picked.length >= opts.maxAttach || m.tokens > budget) continue;
            picked.push(m);
            budget -= m.tokens;
          }
          for (const m of picked) {
            const p = m.path ?? path.join(ROOT, "sessions", sid, m.file);
            // A stale or deleted module must never abort the user's turn: OpenCode
            // rejects the whole prompt when an attachment cannot be read.
            try { await fs.access(p); } catch {
              log(`prompt hook: skipping missing module file ${m.file} (${p})`);
              continue;
            }
            prompt.files.push({ uri: pathToFileURL(p).href });
          }
          if (picked.length) {
            log(`prompt hook: attached ${picked.map((m) => m.file).join(", ")}${carried ? " (carry-in)" : " by trigger match"}`);
            // Module prose often carries line counts captured when the pack was
            // made; those drift as files change. Tell the model explicitly.
            // Carried modules additionally get a scope label so the model
            // never mistakes a previous session's state for this one's.
            if (typeof ctx.session?.synthetic === "function") {
              const captured = idx.updated ?? idx.created;
              const label = carried
                ? " [carry-in] These modules describe the project's previous sessions — background only. Decisions and state reflect the last session, not this one."
                : "";
              try {
                await ctx.session.synthetic({
                  sessionID: sid,
                  text: `[ContextPack] attached ${picked.length} module(s) captured ${captured ?? "earlier"}.${label} Line counts and file sizes inside them may be stale — verify exact content with the read tool (offset/limit) or \`babyzilla retrieve <path>:<start>-<end>\` before relying on numbers.`,
                });
                log("prompt hook: freshness note sent");
              } catch (e) { log("attach freshness note skipped:", e?.message ?? e); }
            }
          }
        } catch (e) {
          log("prompt hook failed (non-fatal):", e?.message ?? e);
        }
      });
    } else {
      log("session.hook unavailable — compaction swap & auto-loading disabled");
    }

    // ---- /contextpack inspector command ------------------------------------
    try {
      await ctx.command.transform((editor) => {
        editor.add({
          name: "contextpack",
          description: "Show ContextPack stats and module index for this session",
          execute: async ({ sessionID }) => {
            try {
              const idx = await readIndex(sessionID);
              const req = await readRequestStats(sessionID);
              if (!idx) {
                if (req?.requests) {
                  await ctx.session.synthetic({
                    sessionID,
                    text: [
                      "[ContextPack] no pack yet (compaction has not run), but Layer 1b is active:",
                      `· request budget: ${req.requests} requests, ~${fmt(req.before)} → ~${fmt(req.after)} tok (${req.savedPct}% smaller)`,
                      `· last request: ~${fmt(req.last?.before ?? 0)} → ~${fmt(req.last?.after ?? 0)} tok (${req.last?.savedPct ?? 0}% smaller)`,
                      `· pack modules will appear here after the next compaction; files live under ${ROOT}/sessions/${sessionID}/`,
                    ].join("\n"),
                  });
                  return;
                }
                await ctx.session.synthetic({ sessionID, text: "[ContextPack] No pack for this session yet. It will be created at the next compaction (automatic when the context runs full); you can also read existing packs under " + ROOT + "/sessions/<sessionID>/." });
                return;
              }
              const journal = await readJournalStats(sessionID);
              const lines = [
                "[ContextPack] pack for this session:",
                `· distill model: ${idx.model?.providerID ?? "?"}/${idx.model?.id ?? "?"} at ${idx.created}`,
                `· stats: raw ~${fmt(idx.rawTranscriptTokens)} tok → pack ~${fmt(idx.stats.packTokens)} tok (${idx.stats.savedPct}% smaller)`,
                `· journal: ${journal.entries} tool results captured (~${fmt(journal.tokens)} raw tokens observed)`,
              ];
              if (req?.requests) {
                lines.push(`· request budget: ${req.requests} requests, ~${fmt(req.before)} → ~${fmt(req.after)} tok (${req.savedPct}% smaller; last ~${fmt(req.last?.before ?? 0)} → ~${fmt(req.last?.after ?? 0)})`);
              }
              lines.push(
                "· modules:",
                ...idx.modules.map((m) => `${m.hot ? "  ● hot" : "  ○ cold"} ${m.file}  ~${fmt(m.tokens)} tok  triggers: ${m.triggers.join(", ") || "—"}`),
              );
              await ctx.session.synthetic({ sessionID, text: lines.join("\n") });
            } catch (e) {
              await ctx.session.synthetic({ sessionID, text: `[ContextPack] inspector failed: ${e?.message ?? e}` });
            }
          },
        });
      });
    } catch (e) { log("command registration unavailable:", e?.message ?? e); }

    log("plugin ready", Object.keys(opts).length ? `(options: ${JSON.stringify(opts)})` : "");
  },
};

async function readModules(idx) {
  if (!idx?.modules?.length) return null;
  const modules = [];
  for (const m of idx.modules) {
    if (!m.hot) continue; // cold modules are not carried; their files remain
    try {
      const content = await fs.readFile(m.path ?? m.file, "utf8");
      modules.push({ kind: m.kind === "state" ? "state" : "decisions", name: m.name, triggers: m.triggers, content });
    } catch { /* missing file — ignore */ }
  }
  return modules.length ? { modules } : null;
}

async function readJournalStats(sessionID) {
  try {
    const raw = await fs.readFile(path.join(await packDir(sessionID), "journal.jsonl"), "utf8");
    const lines = raw.split("\n").filter(Boolean);
    let tokens = 0;
    for (const l of lines) { try { tokens += JSON.parse(l).tokens ?? 0; } catch { /* skip */ } }
    return { entries: lines.length, tokens };
  } catch { return { entries: 0, tokens: 0 }; }
}

// Layer 1b savings, accumulated per session so `babyzilla stats` and
// `/contextpack` can show that requests are being capped even when native
// compaction never runs (Kimi K3 and other 1M-token models).
function requestStatsPath(sessionID) {
  return path.join(ROOT, "sessions", sessionID, "request-stats.json");
}

async function readRequestStats(sessionID) {
  return readJson(requestStatsPath(sessionID));
}

async function recordRequestStats(sessionID, stats) {
  if (!sessionID || !stats?.saved) return;
  try {
    const file = requestStatsPath(sessionID);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const prev = await readJson(file);
    const before = (prev?.before ?? 0) + stats.before;
    const after = (prev?.after ?? 0) + stats.after;
    await fs.writeFile(file, JSON.stringify({
      requests: (prev?.requests ?? 0) + 1,
      before,
      after,
      savedPct: before ? Math.round((1 - after / before) * 100) : 0,
      last: { before: stats.before, after: stats.after, savedPct: stats.savedPct, at: Date.now() },
    }, null, 2));
  } catch { /* stats must never affect a request */ }
}