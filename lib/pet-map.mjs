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

// ── what the result says ────────────────────────────────────────────────────
// A tool name is a category; the text is the event. These rules read a result
// the way a person glancing at the terminal would: a failing test is not the
// same as a missing file, and "grep found nothing" is not a crash.
//
// Only signals that change what the pet should *do* live here. Anything else
// stays silent, because a pet that comments on every result is wallpaper.

const SEARCH = new Set(["grep", "glob", "list"]);

const NO_SPACE = /\b(?:ENOSPC|no space left on device|disk (?:is )?full)\b/i;
const NO_PERMISSION = /\b(?:EACCES|EPERM|permission denied|operation not permitted|read-only file system)\b/i;
const NO_FILE = /\b(?:ENOENT|no such file or directory|command not found|is not recognized as an internal or external command|could not find file)\b/i;
const NETWORK = /\b(?:ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|fetch failed|could not resolve host|network is unreachable)\b/i;

const TEST_COMMAND = /\b(?:jest|vitest|pytest|rspec|phpunit|cargo\s+test|go\s+test|node\s+--test)\b|\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b/i;
// A summary line, not the word "test" somewhere in a log.
const TEST_MARKERS = /(?:^|\n)\s*(?:ℹ\s*(?:pass|fail)\s+\d+|Tests:\s|Test Suites:\s|# (?:tests|pass|fail)\b|--- FAIL:|✖\s|not ok \d+)/;

const BUILD_FAILED = /\b(?:error TS\d+|compilation failed|build failed|npm ERR!|ELIFECYCLE)\b/;
const PUSH_REJECTED = /(?:!\s*\[rejected\]|non-fast-forward|protected branch|failed to push some refs)/i;

function number(re, text) {
  const m = text.match(re);
  return m ? Number(m[1]) : null;
}

/** A test summary, in the shapes the common runners print. */
function testResult(text) {
  const failed = number(/\bfail(?:ed|ing|s)?\s*[:=]?\s*(\d+)\b/i, text)
    ?? number(/\b(\d+)\s+fail(?:ed|ing|s)?\b/i, text);
  const passed = number(/\bpass(?:ed|ing|es)?\s*[:=]?\s*(\d+)\b/i, text)
    ?? number(/\b(\d+)\s+pass(?:ed|ing|es)?\b/i, text);
  // A runner that prints no count still fails loudly.
  const hardFail = /(?:^|\n)\s*(?:--- FAIL:|FAIL\s|✖\s|not ok \d+|AssertionError)/.test(text);
  if ((failed ?? 0) > 0 || hardFail) return { id: "test-fail", n: failed };
  if ((passed ?? 0) > 0 || /\b(?:all tests? passed|0 failing|0 failed)\b/i.test(text)) {
    return { id: "test-pass", n: passed };
  }
  return null;
}

/**
 * The reaction the *output* deserves, or null when the ordinary outcome rule
 * should speak. `ok` is the exit status, not the verdict: a runner can print
 * failing tests and still exit 0, and that is exactly the case worth reading.
 */
export function contentReaction({ name, input, ok = true, output = "", error = "", language = "en" } = {}) {
  const key = String(name ?? "").toLowerCase();
  const out = String(output ?? "");
  const err = String(error ?? "");
  const command = String(input?.command ?? "");
  // An error message is evidence; a file's *contents* are not. Reading a script
  // that mentions ENOENT must not make the pet say "no such file", and a grep for
  // the word is a search result, not a crash. So the probe is the error text plus
  // a command's own output — never the body of a read, never a search's hits.
  const searchy = /\b(?:grep|rg|ag|ack|find|fd|which|whereis|locate)\b/.test(command);
  const head = `${err}\n${key === "bash" || key === "shell" ? (searchy ? "" : out.slice(0, 8000)) : ""}`;

  if (NO_SPACE.test(head)) return { id: "disk-full", hold: 2.4, say: line(language, "diskFull") };
  if (NO_PERMISSION.test(head)) return { id: "permission-denied", hold: 2.2, say: line(language, "permissionDenied") };
  if (NO_FILE.test(head)) return { id: "notfound", hold: 2.0, say: line(language, "missingFile") };
  if (NETWORK.test(head)) return { id: "offline", hold: 2.6, say: line(language, "offline") };

  if ((key === "bash" || key === "shell") && (TEST_COMMAND.test(command) || TEST_MARKERS.test(head))) {
    const t = testResult(head);
    if (t?.id === "test-fail") return { id: "test-fail", hold: 2.6, say: line(language, "testsFail", t.n) };
    if (t?.id === "test-pass") return { id: "test-pass", hold: 2.2, say: line(language, "testsPass", t.n) };
  }

  if (PUSH_REJECTED.test(head)) return { id: "conflict", hold: 2.2, say: line(language, "pushRejected") };
  if ((key === "bash" || key === "shell") && BUILD_FAILED.test(head)) return { id: "oops", hold: 2.0 };

  // A search that found nothing is a shrug, not a failure — even when grep's
  // exit code 1 is all the tool reports.
  const exitOnly = /^(?:command failed with exit code \d+|exit code \d+|exit status \d+)\W*$/i.test(err.trim());
  const empty = !out.trim() || /no (?:matches|results|files) found|0 matches|no files? matched/i.test(out);
  if (SEARCH.has(key) && empty && (ok || exitOnly)) return { id: "shrug", hold: 1.8, say: line(language, "nothingFound") };

  if (ok && out.length > 120_000) return { id: "stack-overflow", hold: 2.4, say: line(language, "hugeOutput") };
  return null;
}

// ── what it just said ───────────────────────────────────────────────────────
// The thought bubble already has a mood; the body should wear it too, or the
// pet is a face that talks without moving.

export const MOOD_EXPRESSION = {
  angry: "conflict",
  confused: "confused",
  bored: "bored",
  smug: "proud",
  tease: "tilt-head",
};

export function moodExpression(mood, { rawr = false } = {}) {
  if (rawr) return { id: "roar", hold: 1.2 };
  const id = MOOD_EXPRESSION[mood];
  return id ? { id, hold: 1.4 } : null;
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
