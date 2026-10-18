// Pure distillation pipeline: pre-trim, prompt construction, module parsing,
// and summary rendering.
//
// No filesystem, no logging, no model calls — so every step of Layer 1 can be
// unit tested without loading the plugin.

import { estTokens } from "./text.mjs";

export const TOOL_RESULT_HEAD_CHARS = 1600;
export const TOOL_RESULT_TAIL_CHARS = 200;
export const USER_BUDGET_TOKENS = 48_000; // transcript budget fed to the distiller

/**
 * Pick the transcript budget for one distillation call.
 *
 * The distiller prompt also carries the instructions and the model's reply, so
 * a fixed 48K transcript does not fit small-window models (8K-32K local
 * models). When the window is known, keep the transcript at ~40% of it; when
 * it is not, fall back to the historical 48K.
 */
export function distillInputBudget({ windowTokens = 0, explicit = 0, defaultBudget = USER_BUDGET_TOKENS } = {}) {
  if (Number(explicit) > 0) return Math.max(1000, Math.floor(Number(explicit)));
  const limit = Math.max(0, Number(windowTokens) || 0);
  if (!limit) return defaultBudget;
  return Math.max(1000, Math.min(defaultBudget, Math.floor(limit * 0.4)));
}

export function fmt(n) {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n);
}

export function slug(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "module";
}

export function dirSlug(p) {
  const last = String(p).replace(/^[/\\]+|[/\\]+$/g, "").split(/[\\\/]/).pop();
  return last ? slug(last) : "root";
}

export function trimTo(text, maxChars) {
  return text.length <= maxChars ? text : text.slice(0, maxChars).replace(/\s+\S*$/, "") + "\n[... truncated ...]";
}

// Pre-trim the transcript so the distiller call fits a large-but-finite window:
// full text for user/assistant turns, head+tail for tool output.
export function reduceForDistill(text, budgetTokens, { headChars = TOOL_RESULT_HEAD_CHARS, tailChars = TOOL_RESULT_TAIL_CHARS } = {}) {
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
    if (isTool && p.length > headChars + tailChars) {
      piece = p.slice(0, headChars) + "\n[... trimmed ...]\n" + p.slice(-tailChars);
    }
    if (keptTokens + estTokens(piece) > budgetTokens && kept.length > 0) { dropped += t; continue; }
    kept.unshift(piece);
    keptTokens += estTokens(piece);
  }
  if (dropped > 0) kept.unshift(`[... ${dropped} tokens of older tool output omitted by ContextPack pre-trim ...]`);
  return { text: kept.join("\n\n"), dropped, rawTokens: est };
}

export const DISTILL_INSTRUCTIONS = `You are a ContextPack distiller. Convert the session transcript into compact "context modules" so an AI agent can continue this work with no information loss.

HARD RULES:
- Preserve VERBATIM: every decision + its rationale, the current work state, next steps, exact error messages, key numbers, file paths, URLs, important identifiers.
- Every fact must carry a pointer: file:line, command, tool name, or URL.
- Preserve the CURRENT TASK's working set: the files and commands being worked on, the latest failing test/error text, and open questions. Never summarize these into generalities; quote the exact strings.
- If two facts conflict, keep both and mark the conflict instead of silently picking one. If something is uncertain, say so.
- DROP raw tool output, repeated file contents, process chatter, and dead ends — but keep ONE line per notable failure explaining what failed and why.
- Older raw text is recoverable from the session database, so a module may say "full output: babyzilla recall <call-id>" instead of quoting it. Never invent a call-id.
- Aim for ~8% of the transcript's size: terse markdown, no prose padding, but never fewer facts than the next agent needs to continue alone.

OUTPUT FORMAT — newline-delimited JSON. Each line is ONE complete JSON object (no fences, no blank lines, no thinking, no commentary):
{"kind":"state","name":"00-state","triggers":["kw"],"content":"markdown with \\n escapes"}
Then optionally more lines for other modules:
{"kind":"decisions|code|tool|errors|topic","name":"kebab-slug","triggers":["kw1","kw2"],"content":"markdown"}

- The FIRST line must be the single "state" module (name "00-state"): current goal, status/progress, what is in flight, precise next steps, open questions.
- Optionally 0-3 "decisions", 0-4 "code", 0-3 "tool", 0-4 "errors", 0-3 "topic". Skip empty categories.
- "content" is terse markdown; keep \\n escaped inside the JSON string; max ~40 lines per module.
- "triggers": 3-8 lowercase words that a person's NEXT message about this topic would plausibly contain.`;

export function distillationPrompt(prevPack, reduced) {
  let prior = "";
  if (prevPack?.modules?.length) {
    const hot = prevPack.modules.filter((m) => m.hot);
    prior = `PRIOR COMPACTED CONTEXT from earlier compactions (carry forward anything still relevant; re-emit still-relevant cold modules with unchanged content):\n${hot.map((m) => m.content).join("\n\n")}\n\n--- TRANSCRIPT OF NEW WORK SINCE ---\n`;
  }
  return `${prior}${reduced}`;
}

export function parseModules(raw) {
  if (!raw) throw new Error("empty distiller response");
  let t = String(raw).replace(/<think>[\s\S]*?<\/think>/g, "").replace(/```(?:json)?/g, "");
  const a = t.indexOf("{");
  const b = t.lastIndexOf("}");
  const arrA = t.indexOf("[");
  const arrB = t.lastIndexOf("]");
  // A top-level array only counts when it opens before the first object —
  // otherwise the "[" belongs to prose (e.g. "[ContextPack] … {json}").
  const hasArray = arrA >= 0 && arrB > arrA && (a < 0 || arrA < a);
  if (a < 0 && !hasArray) throw new Error("no JSON found in distiller response");
  // JSONL tolerant parsing: one module object per output line. A truncated
  // tail only loses trailing modules instead of corrupting the whole pack.
  const mods = [];
  if (hasArray) {
    try {
      const arr = JSON.parse(t.slice(arrA, arrB + 1));
      if (Array.isArray(arr)) mods.push(...arr);
    } catch { /* fall through */ }
  }
  if (!mods.length && a >= 0 && b > a) {
    try {
      const single = JSON.parse(t.slice(a, b + 1));
      if (Array.isArray(single?.modules)) mods.push(...single.modules);
      else if (Array.isArray(single)) mods.push(...single);
    } catch { /* fall through to line parsing */ }
  }
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

export function moduleFileFor(mod) {
  if (mod.kind === "state") return "00-state.md";
  return `${mod.kind}-${mod.name}.md`;
}

export function buildSummary(pack, stats) {
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
