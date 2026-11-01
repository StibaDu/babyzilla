// Cross-session library index.
//
// Library indexes store only a file basename, because the module files live
// next to the index. Callers need absolute paths (the prompt hook attaches them
// to the next prompt), so resolve them here — this is the bug that used to
// point every library module at `sessions/<id>/<file>`, where no file exists.

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { dirSlug } from "./distill.mjs";
import { estTokens } from "./text.mjs";
import { createVersioner } from "./history.mjs";

// Module kinds that survive a session boundary. state/decisions keep their hot
// flag and become the carry-in set for new sessions; tool/errors stay cold and
// attach by keyword.
export const CARRY_KINDS = new Set(["state", "decisions", "tool", "errors"]);
export const CARRY_CORE = new Set(["state", "decisions"]);

async function readJson(file) {
  try { return JSON.parse(await fs.readFile(file, "utf8")); } catch { return null; }
}

export async function libraryIndex(dir, root) {
  const base = path.join(root, "library", dirSlug(dir));
  const idx = (await readJson(path.join(base, "index.json"))) ?? { modules: [] };
  if (Array.isArray(idx.modules)) {
    idx.modules = idx.modules.map((m) => (m.path ? m : { ...m, path: path.join(base, m.file) }));
  }
  return idx;
}

// ---------------------------------------------------------------------------
// Trigger scoring + token-safe attachment
// ---------------------------------------------------------------------------
//
// A session pack and the project library are two halves of the same memory.
// Once a session has its own modules, the library used to be ignored until
// the next session (index.js only consulted it while `idx.modules` was
// empty). Merging them is useful, but never at the cost of a larger prompt:
// library rows may only replace rows this prompt would already have carried.

/** Same normalization the prompt hook has always used for triggers. */
export function normalizeTriggerText(text) {
  return ` ${String(text).toLowerCase().replace(/[^a-z0-9]+/g, " ")} `;
}

/** Identity of a module across a session pack and its promoted library copy. */
export function moduleKey(mod) {
  const file = mod?.file || mod?.path || "";
  const name = mod?.name || path.basename(file, ".md");
  return `${mod?.kind || ""}\0${String(name).replace(/^lib-/, "")}`;
}

/** Trigger matches, best first. Hot modules are already in the summary. */
export function scoreModules(idx, userText) {
  const hay = normalizeTriggerText(userText);
  const scored = [];
  for (const mod of idx?.modules ?? []) {
    if (mod.hot) continue;
    let hits = 0;
    for (const trigger of mod.triggers ?? []) {
      if (
        hay.includes(` ${trigger} `) ||
        (trigger.includes(" ") && trigger.split(" ").every((word) => hay.includes(` ${word} `)))
      ) hits++;
    }
    if (hits) scored.push({ m: mod, hits });
  }
  scored.sort((a, b) => b.hits - a.hits || (Number(a.m.tokens) || 0) - (Number(b.m.tokens) || 0));
  return scored;
}

/** Merge library candidates after the session's own, deduped by module identity. */
export function mergeScored(sessionScored, libraryScored) {
  const seen = new Set(sessionScored.map(({ m }) => moduleKey(m)));
  const merged = sessionScored.slice();
  for (const scored of libraryScored) {
    const key = moduleKey(scored.m);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push({ ...scored, fromLibrary: true });
  }
  merged.sort((a, b) =>
    b.hits - a.hits ||
    (Number(a.m.tokens) || 0) - (Number(b.m.tokens) || 0) ||
    (a.fromLibrary ? 1 : 0) - (b.fromLibrary ? 1 : 0));
  return merged;
}

/** Greedy pick under the existing per-prompt attach caps. */
export function pickScored(scored, { maxAttach = 2, budgetTokens = 6000 } = {}) {
  const limit = Math.max(0, Number(maxAttach) || 0);
  let budget = Math.max(0, Number(budgetTokens) || 0);
  const picked = [];
  for (const { m } of scored) {
    const cost = Number(m.tokens) || 0;
    if (picked.length >= limit || cost > budget) continue;
    picked.push(m);
    budget -= cost;
  }
  return picked;
}

/** Drop the lowest-ranked rows until the result costs no more than before. */
export function capToOld(picked, oldPicked) {
  const out = picked.slice();
  const oldTokens = oldPicked.reduce((sum, m) => sum + (Number(m.tokens) || 0), 0);
  let tokens = out.reduce((sum, m) => sum + (Number(m.tokens) || 0), 0);
  while (out.length && (out.length > oldPicked.length || tokens > oldTokens)) {
    const removed = out.pop();
    tokens -= Number(removed.tokens) || 0;
  }
  return out;
}

/**
 * Plan one prompt's attachments. `picked` is guaranteed to contain no more
 * modules and no more estimated tokens than the session-only selection.
 * When the session has no trigger match, the old total is zero and a library
 * row cannot be added — strict token neutrality means no free attachments.
 */
export function planAttach({ session, library, text, maxAttach, budgetTokens }) {
  const sessionScored = scoreModules(session, text);
  const oldPicked = pickScored(sessionScored, { maxAttach, budgetTokens });
  const libraryScored = library?.modules?.length ? scoreModules(library, text) : [];
  const merged = mergeScored(sessionScored, libraryScored);
  const picked = capToOld(pickScored(merged, { maxAttach, budgetTokens }), oldPicked);
  return { sessionScored, libraryScored, merged, oldPicked, picked };
}

/**
 * Promote a session pack's durable modules into the project library. A module
 * whose bytes differ from the library copy first retires that copy into
 * `library/<slug>/short/`, so project memory has the same revert path as a
 * session pack. Identical bytes write nothing (no churn, no duplicate rows).
 */
export async function promoteModules({ root, projectDir, modules }) {
  if (!projectDir || projectDir === os.homedir()) return { rows: [] };
  // Temp/test locations must not pollute the cross-session library (realpath
  // of $TMPDIR on macOS carries a /private prefix).
  const tmpdir = os.tmpdir();
  if (
    projectDir === tmpdir ||
    projectDir.startsWith(tmpdir + path.sep) ||
    projectDir.startsWith("/tmp/") ||
    projectDir.startsWith("/private/tmp/") ||
    projectDir.startsWith("/private/var/folders/")
  ) return { rows: [] };

  const carry = (modules ?? []).filter((mod) => CARRY_KINDS.has(mod.kind) && mod.name !== "recovered");
  if (!carry.length) return { rows: [] };

  const lib = path.join(root, "library", dirSlug(projectDir));
  await fs.mkdir(lib, { recursive: true });
  const existing = (await readJson(path.join(lib, "index.json"))) ?? { modules: [] };
  if (!Array.isArray(existing.modules)) existing.modules = [];
  if (!Array.isArray(existing.shortTerm)) existing.shortTerm = [];
  const versioner = await createVersioner(lib, existing.shortTerm);

  for (const mod of carry) {
    const file = `lib-${mod.name}.md`;
    const hot = CARRY_CORE.has(mod.kind) && !!mod.hot;
    await versioner.write(file, mod.content, {
      name: mod.name,
      kind: mod.kind,
      triggers: mod.triggers,
      hot,
    });
    const entry = {
      name: mod.name,
      kind: mod.kind,
      file,
      tokens: estTokens(mod.content),
      triggers: mod.triggers,
      hot,
    };
    const prev = existing.modules.find((candidate) => candidate.name === mod.name);
    if (prev) Object.assign(prev, entry); else existing.modules.push(entry);
  }

  existing.shortTerm.push(...versioner.rows);
  existing.projectDir = projectDir;
  existing.updated = new Date().toISOString();
  await fs.writeFile(path.join(lib, "index.json"), JSON.stringify(existing, null, 2));
  return { rows: versioner.rows };
}
