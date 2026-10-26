// Signal → expression mapping. Pure functions, no IO, so the whole behavioural
// table is testable without running opencode or the pet.
//
// Rules that keep the pet from becoming noise:
//   - tool calls are the bulk of the traffic, so they map to a small set and
//     are throttled by the caller;
//   - only "interesting" outcomes speak (failures, compaction, budget, update);
//   - every expression id here must exist in pet/expressions.mjs.

import { line } from "./pet-lang.mjs";

export const TOOL_EXPRESSION = {
  read: "tool-read",
  view: "tool-read",
  glob: "tool-grep",
  grep: "tool-grep",
  list: "tool-list",
  edit: "tool-edit",
  write: "tool-write",
  patch: "tool-edit",
  multiedit: "tool-edit",
  bash: "tool-bash",
  shell: "tool-bash",
  webfetch: "tool-webfetch",
  websearch: "tool-websearch",
  task: "tool-task",
  image: "tool-imagegen",
  generate_image: "tool-imagegen",
  lsp: "tool-lsp",
  mcp: "tool-mcp",
  todo: "tool-todo",
  todowrite: "tool-todo",
  question: "tool-question",
  retrieve: "retrieve",
  recall: "recall",
};

/** Long-running tools get a "waiting" face instead of a busy one. */
const SLOW = new Set(["task", "webfetch", "websearch", "image", "generate_image", "mcp"]);

export function toolExpression(name, input) {
  const key = String(name ?? "").toLowerCase();
  if (SLOW.has(key)) return "subagent-wait";
  if (key === "bash" || key === "shell") {
    const cmd = String(input?.command ?? "");
    if (/\bgit\s+(push|commit|tag)\b/.test(cmd)) return "ship-it";
    if (/\btest|\bjest|\bvitest|\bpytest|\bnode --test/.test(cmd)) return "determined";
    if (/\bbabyzilla\b/.test(cmd)) return "self-tune";
    return "tool-bash";
  }
  return TOOL_EXPRESSION[key] ?? "typing";
}

/** After a tool finishes. `ok` false → a real reaction, not a mood. */
export function outcomeExpression({ name, ok, ms } = {}) {
  const key = String(name ?? "").toLowerCase();
  if (!ok) {
    if (key === "bash" || key === "shell") return { id: "shell-fail", hold: 2.2 };
    return { id: "oops", hold: 2.0 };
  }
  if (key === "bash" || key === "shell") {
    // A slow command that succeeded deserves a beat of celebration.
    return { id: ms > 20000 ? "celebrate" : "shell-ok", hold: ms > 20000 ? 1.8 : 0.9 };
  }
  return null; // silent success: the next tool call replaces the face anyway
}

export function compactionExpression(phase) {
  if (phase === "start") return { id: "compressing", hold: 12 };
  if (phase === "end") return { id: "pack-created", hold: 2.4 };
  if (phase === "fallback") return { id: "conflict", hold: 2.2 };
  return null;
}

export function budgetExpression(pct, language = "en") {
  if (pct >= 95) return { id: "budget-full", hold: 3, say: line(language, "budgetFull") };
  if (pct >= 80) return { id: "budget-low", hold: 2.6, say: line(language, "budgetLow", pct) };
  return null;
}

export function updateExpression(latest, current, language = "en") {
  return { id: "update-available", hold: 3, say: line(language, "update", latest, current) };
}

export function errorExpression(message, language = "en") {
  const text = String(message ?? "");
  if (/rate.?limit|429/i.test(text)) return { id: "rate-limited", hold: 3, say: line(language, "rateLimited") };
  if (/offline|ENOTFOUND|ECONNREFUSED|fetch failed/i.test(text)) return { id: "offline", hold: 3, say: line(language, "offline") };
  return { id: "model-error", hold: 2.6 };
}

/** Only these ids are allowed to speak on their own. */
export function lineFor(id, expressionsById = {}) {
  const lines = expressionsById[id]?.lines ?? [];
  return lines.length ? lines[Math.floor(Math.random() * lines.length)] : null;
}

export function sessionSummary({ savedTokens, tools }) {
  if (!savedTokens || savedTokens < 2000) return null;
  return `Session so far: ~${Math.round(savedTokens / 1000)}k tokens paged out${tools ? ` across ${tools} tool calls` : ""}.`;
}
