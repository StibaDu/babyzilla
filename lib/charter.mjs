// Session charter: the stable "what this session is" header.
//
// Added to every request's system parts (never the persisted transcript), like
// grounding. It is built from the pack's hot modules and index.json, so its
// bytes change only at compaction — the provider can cache the prefix.
//
// A tab with no pack gets a thin charter built from its title and its *first*
// journal step. The first step is used rather than the latest because the
// journal is append-only: the first one is stable forever, while "latest"
// would change on every tool call and bust the prompt cache each time.

import fs from "node:fs";
import path from "node:path";
import { sessionTitle } from "./session-tabs.mjs";

export const CHARTER_MARK = "[babyzilla:charter]";
export const DEFAULT_CHARTER_MAX_CHARS = 1200;
const MIN_CHARTER_CHARS = 500;

function read(file) {
  try { return fs.readFileSync(file, "utf8"); } catch { return null; }
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

function oneLine(text, max) {
  const clean = String(text ?? "").replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  return Array.from(clean).slice(0, Math.max(0, max - 1)).join("").trimEnd() + "…";
}

function excerpt(text, max) {
  const clean = String(text ?? "").trim();
  if (!clean || max <= 0) return "";
  if (clean.length <= max) return clean;
  let cut = clean.slice(0, max);
  const line = cut.lastIndexOf("\n");
  if (line > max * 0.5) {
    cut = cut.slice(0, line);
  } else {
    const stop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("; "));
    if (stop > max * 0.5) cut = cut.slice(0, stop + 1);
  }
  return cut.trimEnd() + "…";
}

function firstHeading(text) {
  const match = /^#{1,3}\s+(.+)$/m.exec(String(text ?? ""));
  return match ? oneLine(match[1].replace(/[*_`]/g, ""), 100) : null;
}

function moduleText(base, mod) {
  const file = typeof mod?.path === "string" && path.isAbsolute(mod.path)
    ? mod.path
    : path.join(base, mod?.file ?? "");
  return read(file);
}

function firstJournalEntry(base) {
  const file = path.join(base, "journal.jsonl");
  let raw = null;
  try {
    // The plugin caps a journal head at 1200 chars, so the first entry lives
    // well inside 8KB. Read only the head of a potentially 2000-line file.
    const fd = fs.openSync(file, "r");
    try {
      const buffer = Buffer.alloc(8192);
      const read = fs.readSync(fd, buffer, 0, buffer.length, 0);
      raw = buffer.subarray(0, read).toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch { return null; }
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (typeof entry?.head !== "string" || !entry.head) continue;
      return {
        tool: typeof entry.tool === "string" && entry.tool ? entry.tool : "tool",
        status: typeof entry.status === "string" ? entry.status : "",
        head: oneLine(entry.head, 180),
      };
    } catch { /* skip a torn line */ }
  }
  return null;
}

function composeFull({ about, state, decisions, short, base, snapshot, maxChars }) {
  const cap = Math.max(MIN_CHARTER_CHARS, Number(maxChars) || DEFAULT_CHARTER_MAX_CHARS);
  const header = `${CHARTER_MARK} Session memory — distilled at the last compaction and updated only then. Newer turns below outrank it; if a detail you need is not here, read the module files; do not guess.`;
  const aboutLine = `About: ${oneLine(about, 140)}`;
  const snapshotLine = snapshot ? `Snapshot: ${snapshot}` : "";
  const superseded = short > 0
    ? `Superseded: ${short} retired ${short === 1 ? "fact" : "facts"} · inspect: babyzilla memory history`
    : "";
  const modulesLine = `Modules: ${base} (index.json lists every path)`;
  const fixed = [header, aboutLine, snapshotLine, superseded, modulesLine].filter(Boolean).join("\n");
  const remaining = Math.max(0, cap - fixed.length - 3);
  const stateLine = state
    ? `State:\n${excerpt(state, Math.floor(remaining * 0.6))}`
    : "";
  const decisionsLine = decisions
    ? `Decisions:\n${excerpt(decisions, Math.max(0, remaining - stateLine.length - 1))}`
    : "";
  let text = [header, aboutLine, snapshotLine, stateLine, decisionsLine, superseded, modulesLine]
    .filter(Boolean).join("\n");
  if (text.length > cap) text = excerpt(text, cap);
  return { text, kind: "full", title: about, shortTerm: short };
}

function composeThin({ about, step, base, maxChars }) {
  const cap = Math.max(320, Number(maxChars) || DEFAULT_CHARTER_MAX_CHARS);
  const header = `${CHARTER_MARK} Session memory — thin: no ContextPack yet. The journal is the durable trace; read it before asserting session history.`;
  const aboutLine = about ? `About: ${oneLine(about, 140)}` : "";
  const stepLine = step
    ? `Opening step: ${step.tool}${step.status ? ` ${step.status}` : ""} — ${step.head}`
    : "";
  const journalLine = step ? `Journal: ${path.join(base, "journal.jsonl")}` : "";
  let text = [header, aboutLine, stepLine, journalLine].filter(Boolean).join("\n");
  if (text.length > cap) text = excerpt(text, cap);
  return { text, kind: "thin", title: about || null, shortTerm: 0 };
}

/**
 * Build the charter for one session. Returns null when there is neither a pack
 * nor a tab title/journal to orient from, so a headless session stays untouched.
 */
export function buildCharter({ root, sessionID, title = null, maxChars = DEFAULT_CHARTER_MAX_CHARS } = {}) {
  if (!root || !sessionID) return null;
  const base = path.join(root, "sessions", sessionID);
  const index = readJson(path.join(base, "index.json"));
  const tabTitle = title || sessionTitle(sessionID) || null;

  if (index && Array.isArray(index.modules) && index.modules.length) {
    const stateMod = index.modules.find((mod) => mod.kind === "state" && mod.name !== "recovered")
      ?? index.modules.find((mod) => mod.kind === "state");
    const state = stateMod ? moduleText(base, stateMod) : null;
    const decisions = index.modules
      .filter((mod) => mod.kind === "decisions" && mod.name !== "recovered")
      .map((mod) => moduleText(base, mod))
      .filter(Boolean)
      .join("\n\n");
    const about = tabTitle || firstHeading(state ?? "") || `session ${sessionID}`;
    const short = Array.isArray(index.shortTerm) ? index.shortTerm.length : 0;
    const snapshot = index.created ? String(index.created).slice(0, 10) : null;
    return composeFull({ about, state, decisions, short, base, snapshot, maxChars });
  }

  const step = firstJournalEntry(base);
  if (!tabTitle && !step) return null;
  return composeThin({ about: tabTitle, step, base, maxChars });
}

/** Add the charter once; a second context hook pass must not duplicate it. */
export function addCharterToSystem(system, text) {
  if (!Array.isArray(system) || !text) return false;
  for (const part of system) {
    if (typeof part?.text === "string" && part.text.includes(CHARTER_MARK)) return false;
  }
  system.push({ type: "text", text });
  return true;
}
