// ContextPack — session context compressor & module loader for OpenCode V2.
//
// Replaces OpenCode's native compaction summary with an AI-distilled set of
// "context modules" (state / decisions / code / tool / errors / topic),
// persisted under ~/.opencode/contextpacks/<sessionID>/. The raw transcript
// in OpenCode's database is never touched — packs are additive.
//
// Integration points (OpenCode >= 2.0.16):
//   ctx.tool.hook("execute.after")  -> per-session usage journal (stats source)
//   ctx.session.hook("compaction")  -> distill & swap the compaction summary
//   ctx.session.hook("prompt")      -> trigger-keyword module auto-loading
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

import { exec as execCb } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execAsync = promisify(execCb);

const ROOT = path.join(os.homedir(), ".opencode", "contextpacks");
const JOURNAL_LIMIT_ENTRIES = 2000;
// Compaction re-entrancy: sid → expiry ms. Two queued compaction events (or a
// re-registered hook after a config reload) must not distill the same session
// concurrently; a conservative TTL covers abnormal aborts.
const compactionInFlight = new Map();
// Tool results are the bulk of a session. Pre-trim them so the distiller call
// fits comfortably even when the session just overflowed its context window.
const TOOL_RESULT_HEAD_CHARS = 1600;
const TOOL_RESULT_TAIL_CHARS = 200;
const USER_BUDGET_TOKENS = 48_000; // transcript budget fed to the distiller

log("contextpack module loaded, data dir:", ROOT);

const defaults = {
  // null -> use the session's own model for distillation.
  distillModel: null,
  // max cold modules attached to one prompt + their combined token budget.
  maxAttach: 2,
  attachBudgetTokens: 6000,
  // promote tool-* modules of a project into the cross-session library.
  library: true,
  // below this many estimated transcript tokens, native compaction is fine.
  minRawTokens: 4000,
  // layer 2: rewrite shell commands through the `lowfat` binary before
  // execution, so tool output enters the context pre-compressed.
  toolCompression: true,
};

function log(...args) {
  console.warn("[contextpack]", ...args);
  // console output is not captured by the background service — mirror to a file
  fs.appendFile(path.join(ROOT, "debug.log"), `[${new Date().toISOString()}] ${args.map((a) => (typeof a === "string" ? a : safeStr(a))).join(" ")}\n`).catch(() => {});
}

function safeStr(v) { try { return JSON.stringify(v); } catch { return "[unserializable]"; } }

function estTokens(s) {
  if (!s) return 0;
  return Math.ceil(String(s).length / 4);
}

function slug(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "module";
}

function dirSlug(p) {
  return slug(String(p).replace(/^[/\\]+|[/\\]+$/g, "").split(/[\\\/]/).pop() || p) || "root";
}

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

// Pre-trim the transcript so the distiller call fits a large-but-finite window:
// full text for user/assistant turns, head+tail for tool output.
function reduceForDistill(text, budgetTokens) {
  const est = estTokens(text);
  if (est <= budgetTokens) return { text, dropped: 0, rawTokens: est };
  const paras = text.split(/\n\n/);
  // paragraphs that look like tool blocks (start with "[tool") get trimmed hard
  const kept = [];
  let keptTokens = 0;
  let dropped = 0;
  for (let i = paras.length - 1; i >= 0; i--) { // newest first
    const p = paras[i];
    const t = estTokens(p);
    const isTool = p.startsWith("[tool");
    let piece = p;
    if (isTool && p.length > TOOL_RESULT_HEAD_CHARS + TOOL_RESULT_TAIL_CHARS) {
      piece = p.slice(0, TOOL_RESULT_HEAD_CHARS) + "\n[... trimmed ...]\n" + p.slice(-TOOL_RESULT_TAIL_CHARS);
    }
    if (keptTokens + estTokens(piece) > budgetTokens && kept.length > 0) { dropped += t; continue; }
    kept.unshift(piece);
    keptTokens += estTokens(piece);
  }
  if (dropped > 0) kept.unshift(`[... ${dropped} tokens of older tool output omitted by ContextPack pre-trim ...]`);
  return { text: kept.join("\n\n"), dropped, rawTokens: est };
}

// ---------------------------------------------------------------------------
// Distiller
// ---------------------------------------------------------------------------

const DISTILL_INSTRUCTIONS = `You are a ContextPack distiller. Convert the session transcript into compact "context modules" so an AI agent can continue this work with no information loss.

HARD RULES:
- Preserve VERBATIM: every decision + its rationale, the current work state, next steps, exact error messages, key numbers, file paths, URLs, important identifiers.
- Every fact must carry a pointer: file:line, command, tool name, or URL.
- DROP raw tool output, repeated file contents, process chatter, and dead ends — but keep ONE line per notable failure explaining what failed and why.
- Be aggressive: total output should be ~4% of the transcript's size. Terse markdown, no prose padding.

OUTPUT FORMAT — newline-delimited JSON. Each line is ONE complete JSON object (no fences, no blank lines, no thinking, no commentary):
{"kind":"state","name":"00-state","triggers":["kw"],"content":"markdown with \\n escapes"}
Then optionally more lines for other modules:
{"kind":"decisions|code|tool|errors|topic","name":"kebab-slug","triggers":["kw1","kw2"],"content":"markdown"}

- The FIRST line must be the single "state" module (name "00-state"): current goal, status/progress, what is in flight, precise next steps, open questions.
- Optionally 0-3 "decisions", 0-4 "code", 0-3 "tool", 0-4 "errors", 0-3 "topic". Skip empty categories.
- "content" is terse markdown; keep \\n escaped inside the JSON string; max ~40 lines per module.
- "triggers": 3-8 lowercase words that a person's NEXT message about this topic would plausibly contain.`;

function distillationPrompt(prevPack, reduced) {
  let prior = "";
  if (prevPack?.modules?.length) {
    const hot = prevPack.modules.filter((m) => m.hot);
    prior = `PRIOR COMPACTED CONTEXT from earlier compactions (carry forward anything still relevant; re-emit still-relevant cold modules with unchanged content):\n${hot.map((m) => m.content).join("\n\n")}\n\n--- TRANSCRIPT OF NEW WORK SINCE ---\n`;
  }
  return `${prior}${reduced}`;
}

function parseModules(raw) {
  if (!raw) throw new Error("empty distiller response");
  let t = String(raw).replace(/<think>[\s\S]*?<\/think>/g, "").replace(/```(?:json)?/g, "");
  const a = t.indexOf("{");
  const b = t.lastIndexOf("}");
  if (a < 0 || b <= a) throw new Error("no JSON found in distiller response");
  // JSONL tolerant parsing: one module object per output line. A truncated
  // tail only loses trailing modules instead of corrupting the whole pack.
  const mods = [];
  try {
    const single = JSON.parse(t.slice(a, b + 1));
    if (Array.isArray(single?.modules)) mods.push(...single.modules);
  } catch { /* fall through to line parsing */ }
  if (!mods.length) {
    for (const line of t.split(/\n/)) {
      const la = line.indexOf("{");
      const lb = line.lastIndexOf("}");
      if (la < 0 || lb <= la) continue;
      try {
        const o = JSON.parse(line.slice(la, lb + 1));
        if (o && typeof o === "object" && !Array.isArray(o) && o.kind) mods.push(o);
      } catch { /* skip malformed line */ }
    }
  }
  if (!mods.length) throw new Error("no parseable module lines in distiller response");
  return mods
    .slice(0, 14)
    .map((m) => ({
      kind: ["state", "decisions", "code", "tool", "errors", "topic"].includes(m?.kind) ? m.kind : "topic",
      name: slug(m?.name || m?.kind),
      triggers: (Array.isArray(m?.triggers) ? m.triggers : []).map((s) => String(s).toLowerCase()).filter(Boolean).slice(0, 8),
      content: String(m?.content ?? ""),
    }))
    .filter((m) => m.content.trim());
}

function moduleFileFor(mod) {
  if (mod.kind === "state") return "00-state.md";
  return `${mod.kind}-${mod.name}.md`;
}

function normalizeModel(m) {
  if (!m) return null;
  const providerID = m.providerID;
  const id = m.id ?? m.modelID;
  return providerID && id ? { providerID, id } : null;
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

function trimTo(text, maxChars) {
  return text.length <= maxChars ? text : text.slice(0, maxChars).replace(/\s+\S*$/, "") + "\n[... truncated ...]";
}

function buildSummary(pack, stats) {
  const { modules, files } = pack;
  const state = modules.find((m) => m.kind === "state");
  const decisions = modules.filter((m) => m.kind === "decisions");
  const cold = modules.filter((m) => m.kind !== "state" && m.kind !== "decisions");

  const parts = [];
  parts.push(`[ContextPack] Session context compressed ${stats.savedPct}% (raw ~${fmt(stats.rawTokens)} tokens → pack ~${fmt(stats.packTokens)} tokens, ${modules.length} modules).`);
  if (state) parts.push(`## CURRENT STATE\n${trimTo(state.content, 6000)}`);
  if (decisions.length) {
    parts.push(`## DECISIONS (already made — do not relitigate)\n${decisions.map((m) => trimTo(m.content, 1200)).join("\n\n")}`);
  }
  if (cold.length) {
    parts.push("## MODULES ON DISK (auto-attached to your prompts when triggers match; otherwise read the file first, then work)");
    parts.push(cold.map((m) => {
      const f = files[m.name];
      const tg = m.triggers.slice(0, 6).join(", ");
      return `- file://${f} (~${fmt(estTokens(m.content))} tok; kind ${m.kind}; triggers: ${tg})`;
    }).join("\n"));
    parts.push("For any task matching a trigger above, read that module before acting. Work only from the pack + referenced files; do not re-read the historical transcript.");
  }
  return parts.join("\n\n");
}

function fmt(n) { return n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n); }

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
// Library (cross-session packs)
// ---------------------------------------------------------------------------

async function libraryIndex(dir) {
  return (await readJson(path.join(ROOT, "library", dirSlug(dir), "index.json"))) ?? { modules: [] };
}

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
  const tools = modules.filter((m) => m.kind === "tool" || m.kind === "errors");
  if (!tools.length) return;

  const lib = path.join(ROOT, "library", dirSlug(projectDir));
  await fs.mkdir(lib, { recursive: true });
  const existing = await readJson(path.join(lib, "index.json")) ?? { modules: [] };
  if (!Array.isArray(existing.modules)) existing.modules = [];
  for (const m of tools) {
    const file = `lib-${m.name}.md`;
    await fs.writeFile(path.join(lib, file), m.content);
    const prev = existing.modules.find((x) => x.name === m.name);
    const entry = { name: m.name, kind: m.kind, file, tokens: estTokens(m.content), triggers: m.triggers, hot: false };
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

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function resolveLowfatBinary() {
  try {
    const { stdout } = await execAsync("command -v lowfat");
    const onPath = stdout.trim();
    if (onPath) return onPath;
  } catch { /* not on PATH */ }
  const candidates = [
    path.join(os.homedir(), ".local", "bin", "lowfat"),
    path.join(os.homedir(), ".cargo", "bin", "lowfat"),
    "/usr/local/bin/lowfat",
  ];
  for (const candidate of candidates) {
    try {
      await execAsync(`test -x ${shellQuote(candidate)}`);
      return candidate;
    } catch { /* not here */ }
  }
  return null;
}

export default {
  id: "contextpack",
  setup: async (ctx) => {
    const opts = { ...defaults, ...(ctx.options ?? {}) };

    // ---- journal capture (stats + raw bulk record) -------------------------
    if (typeof ctx.tool?.hook === "function") {
      await ctx.tool.hook("execute.after", (event) => {
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
              const { stdout } = await execAsync(`${shellQuote(lowfatBinary)} rewrite ${shellQuote(command)}`);
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

          log(`compaction fired: session=${event?.sessionID} model=${safeStr(event?.model)?.slice(0, 80)} msgs=${(event?.messages ?? []).length}`);
          const model = normalizeModel(opts.distillModel) ?? normalizeModel(event?.model);
          if (!model) throw new Error("no model available for distillation");

          const extracted = transcriptText(event?.messages);
          const rawTokens = estTokens(extracted.text);
          log(`compaction: ${fmt(rawTokens)} raw tokens`);
          if (rawTokens < opts.minRawTokens) {
            log("compaction: transcript below minRawTokens — letting native compaction run");
            return;
          }
          const reduced = reduceForDistill(extracted.text, USER_BUDGET_TOKENS);

          const prevIdx = await readIndex(event.sessionID);
          const prevPack = prevIdx && (await readModules(prevIdx));
          const prompt = distillationPrompt(prevPack, reduced.text);
          log(`distilling with ${model.providerID}/${model.id} (fed ~${fmt(estTokens(reduced.text))} tokens of ${fmt(rawTokens)})…`);
          let modules = null;
          for (let attempt = 1; attempt <= 2 && !modules; attempt++) {
            const retryNote = attempt > 1 ? "\n\nIMPORTANT: your previous reply was not parseable. Output ONLY newline-delimited JSON objects per line, exactly as instructed. No thinking, no fences." : "";
            const out = await ctx.generate.text({ model, prompt: DISTILL_INSTRUCTIONS + "\n\n" + prompt + retryNote });
            try {
              modules = parseModules(out.text);
            } catch (e) {
              if (attempt === 2) throw e;
              log(`distill parse failed (attempt ${attempt}) — raw head: ${(out?.text ?? "").slice(0, 400).replace(/\n/g, " ⏎ ")}`);
            }
          }

          if (!modules.some((m) => m.kind === "state")) throw new Error("distiller produced no state module");

          // de-dupe: last state wins; unique names
          const seen = new Set();
          const uniq = [];
          for (const m of modules) {
            if (m.kind === "state") m.name = "00-state";
            const key = `${m.kind}/${m.name}`;
            if (seen.has(key)) continue;
            seen.add(key);
            uniq.push(m);
          }

          const d = await packDir(event.sessionID);
          await fs.mkdir(d, { recursive: true });
          const files = {};
          for (const m of uniq) {
            const file = moduleFileFor(m);
            await fs.writeFile(path.join(d, file), m.content);
            files[m.name] = path.join(d, file);
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

          const packTokens = uniq.reduce((n, m) => n + estTokens(m.content), 0);
          const summaryStats = { rawTokens, packTokens, savedPct: Math.max(0, Math.round((1 - packTokens / rawTokens) * 100)) };

          await fs.writeFile(path.join(d, "index.json"), JSON.stringify({
            sessionID: event.sessionID,
            created: new Date().toISOString(),
            model,
            projectDir,
            stats: summaryStats,
            rawTranscriptTokens: rawTokens,
            modules: uniq.map((m) => ({
              name: m.name, kind: m.kind, file: moduleFileFor(m), path: files[m.name],
              tokens: estTokens(m.content), triggers: m.triggers,
              hot: m.kind === "state" || m.kind === "decisions",
            })),
          }, null, 2));

          // cross-session library promotion (tool knowledge outlives sessions)
          if (opts.library && projectDir) {
            try {
              await promoteToLibrary(event.sessionID, uniq, projectDir);
            } catch (e) { log("library promotion skipped:", e?.message); }
          }

          event.result = {
            summary: buildSummary({ modules: uniq, files }, summaryStats),
            metadata: { contextpack: { ...summaryStats, files: uniq.length, model } },
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
          let idx = await readIndex(sid);
          if (!idx && opts.library) {
            // no session pack yet — try the project's library pack
            try {
              if (typeof ctx.session?.get === "function") {
                const info = await ctx.session.get({ sessionID: sid });
                const dir = info?.directory ?? info?.location?.directory ?? info?.project?.directory;
                if (dir) idx = await libraryIndex(dir);
              }
            } catch { /* library lookup optional */ }
          }
          if (!idx?.modules?.length) {
            log(`prompt hook: no modules to attach (session=${sid.slice(0, 14)}…, pack=${idx ? "empty" : "none"})`);
            return;
          }

          const matched = matchModules(idx, text);
          log(`prompt hook: session=${sid.slice(0, 14)}… candidates=${matched.length}${idx.projectDir ? ` (library for ${idx.projectDir.slice(0, 30)})` : ""}`);
          let budget = opts.attachBudgetTokens;
          const picked = [];
          for (const m of matched) {
            if (picked.length >= opts.maxAttach || m.tokens > budget) continue;
            picked.push(m);
            budget -= m.tokens;
          }
          for (const m of picked) {
            const p = m.path ?? `${ROOT}/sessions/${sid}/${m.file}`;
            prompt.files.push({ uri: `file://${p}` });
          }
          if (picked.length) log(`prompt hook: attached ${picked.map((m) => m.file).join(", ")} by trigger match`);
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
              if (!idx) {
                await ctx.session.synthetic({ sessionID, text: "[ContextPack] No pack for this session yet. It will be created at the next compaction (automatic when the context runs full); you can also read existing packs under " + ROOT + "/sessions/<sessionID>/." });
                return;
              }
              const journal = await readJournalStats(sessionID);
              const lines = [
                "[ContextPack] pack for this session:",
                `· distill model: ${idx.model?.providerID ?? "?"}/${idx.model?.id ?? "?"} at ${idx.created}`,
                `· stats: raw ~${fmt(idx.rawTranscriptTokens)} tok → pack ~${fmt(idx.stats.packTokens)} tok (${idx.stats.savedPct}% smaller)`,
                `· journal: ${journal.entries} tool results captured (~${fmt(journal.tokens)} raw tokens observed)`,
                "· modules:",
                ...idx.modules.map((m) => `${m.hot ? "  ● hot" : "  ○ cold"} ${m.file}  ~${fmt(m.tokens)} tok  triggers: ${m.triggers.join(", ") || "—"}`),
              ];
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