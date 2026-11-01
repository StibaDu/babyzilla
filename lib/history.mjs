// Long-term / short-term memory: retired module revisions.
//
// The distilled pack is overwritten at every compaction. The previous bytes are
// not deleted: they move to <base>/short/NNNN-<file> and get a row in the
// base's index.json, so a wrong turn is reversible without a model call.
//
// This is deliberately deterministic. Nothing is summarised, diffed or asked of
// a model: the old file either differs or it does not, and only bytes that
// existed on disk are kept. A revert is itself versioned — restoring an old
// revision retires the current one first, so going back and forth never loses a
// state.

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { estTokens } from "./text.mjs";
import { dirSlug } from "./distill.mjs";

export const SHORT_DIR = "short";
const SEQ_WIDTH = 4;

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

/**
 * One versioner per base directory (a session pack or a library project).
 * It allocates sequence numbers in memory, so a compaction that retires several
 * modules at once cannot hand the same number to two of them.
 */
export async function createVersioner(base, shortTerm = []) {
  let seq = 0;
  for (const row of Array.isArray(shortTerm) ? shortTerm : []) {
    seq = Math.max(seq, Number(row?.seq) || 0);
  }
  // Orphan files from an interrupted index write still reserve their number.
  try {
    for (const name of await fsp.readdir(path.join(base, SHORT_DIR))) {
      const match = /^(\d+)-/.exec(name);
      if (match) seq = Math.max(seq, Number(match[1]) || 0);
    }
  } catch { /* no short-term directory yet */ }

  const rows = [];

  const retireBytes = async (file, content, meta = {}) => {
    const shortDir = path.join(base, SHORT_DIR);
    await fsp.mkdir(shortDir, { recursive: true });
    const number = ++seq;
    const baseName = path.basename(file);
    const shortName = `${String(number).padStart(SEQ_WIDTH, "0")}-${baseName}`;
    await fsp.writeFile(path.join(shortDir, shortName), content);
    const row = {
      name: meta.name ?? baseName.replace(/\.md$/, "").replace(/^lib-/, ""),
      kind: meta.kind ?? "",
      seq: number,
      at: new Date().toISOString(),
      tokens: estTokens(content),
      path: path.posix.join(SHORT_DIR, shortName),
      replacedBy: meta.replacedBy !== undefined ? meta.replacedBy : baseName,
      reason: meta.reason ?? "replaced",
      triggers: Array.isArray(meta.triggers)
        ? meta.triggers.filter((trigger) => typeof trigger === "string")
        : [],
      hot: meta.hot === true,
    };
    rows.push(row);
    return row;
  };

  return {
    rows,
    /** Write a module; if the file differs, retire the old bytes first. */
    async write(file, content, meta = {}) {
      const target = path.join(base, file);
      let old = null;
      try { old = await fsp.readFile(target, "utf8"); } catch { /* first write */ }
      if (old === null) {
        await fsp.mkdir(path.dirname(target), { recursive: true });
        await fsp.writeFile(target, content);
        return null;
      }
      if (old === content) return null;
      const row = await retireBytes(file, old, {
        ...meta,
        replacedBy: file,
        reason: meta.reason ?? "replaced",
      });
      await fsp.writeFile(target, content);
      return row;
    },
    /** A module the new pack dropped: keep its bytes, remove the current file. */
    async retire(file, meta = {}) {
      const target = path.join(base, file);
      let old = null;
      try { old = await fsp.readFile(target, "utf8"); } catch { return null; }
      const row = await retireBytes(file, old, { ...meta, replacedBy: null, reason: meta.reason ?? "dropped" });
      await fsp.rm(target, { force: true });
      return row;
    },
  };
}

/** Every retired revision, newest first, for `babyzilla memory history`. */
export function historyEntries({ root, sessionID = null, projectDir = null, all = false } = {}) {
  const entries = [];
  const seen = new Set();
  const collect = (scope, id, base, project = null) => {
    const index = readJson(path.join(base, "index.json"));
    for (const row of index?.shortTerm ?? []) {
      if (!row || typeof row.path !== "string") continue;
      const absPath = path.join(base, row.path);
      if (seen.has(absPath)) continue;
      seen.add(absPath);
      entries.push({
        scope,
        id,
        projectDir: project ?? index?.projectDir ?? null,
        ...row,
        absPath,
        rootPath: path.relative(root, absPath).split(path.sep).join("/"),
      });
    }
  };

  if (sessionID) collect("session", sessionID, path.join(root, "sessions", sessionID));
  if (projectDir) {
    const slug = dirSlug(projectDir);
    collect("library", slug, path.join(root, "library", slug), projectDir);
  }
  if (all || (!sessionID && !projectDir)) {
    try {
      for (const entry of fs.readdirSync(path.join(root, "sessions"), { withFileTypes: true })) {
        if (entry.isDirectory()) collect("session", entry.name, path.join(root, "sessions", entry.name));
      }
    } catch { /* no sessions */ }
    try {
      for (const entry of fs.readdirSync(path.join(root, "library"), { withFileTypes: true })) {
        if (entry.isDirectory()) collect("library", entry.name, path.join(root, "library", entry.name));
      }
    } catch { /* no library */ }
  }

  entries.sort((a, b) => String(b.at ?? "").localeCompare(String(a.at ?? "")));
  return entries;
}

/**
 * Restore a retired revision into its current slot. The content being replaced
 * is retired first, so a revert can itself be reverted. Returns the row and the
 * new short-term row (if any).
 */
export async function revertVersion({ root, shortPath, dryRun = false } = {}) {
  const abs = path.isAbsolute(shortPath)
    ? path.resolve(shortPath)
    : path.resolve(root, shortPath);
  const rel = path.relative(root, abs);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error("revert expects a file inside the memory root");
  }
  const parts = rel.split(path.sep);
  let base = null;
  if (parts.length === 4 && parts[0] === "sessions" && parts[2] === SHORT_DIR) {
    base = path.join(root, "sessions", parts[1]);
  } else if (parts.length === 4 && parts[0] === "library" && parts[2] === SHORT_DIR) {
    base = path.join(root, "library", parts[1]);
  }
  if (!base) {
    throw new Error("revert expects <root>/sessions/<id>/short/<file> or <root>/library/<slug>/short/<file>");
  }

  const index = readJson(path.join(base, "index.json")) ?? { modules: [] };
  if (!Array.isArray(index.modules)) index.modules = [];
  if (!Array.isArray(index.shortTerm)) index.shortTerm = [];
  const rowRel = path.relative(base, abs).split(path.sep).join("/");
  const row = index.shortTerm.find((candidate) => candidate.path === rowRel);
  if (!row) throw new Error(`no short-term row for ${rowRel}`);

  const content = await fsp.readFile(abs, "utf8");
  const targetFile = row.replacedBy ?? path.basename(abs).replace(/^\d+-/, "");
  const target = path.join(base, targetFile);
  let current = null;
  try { current = await fsp.readFile(target, "utf8"); } catch { /* dropped module */ }
  if (dryRun) {
    return { base, target: targetFile, row, retired: null, changed: current !== content };
  }

  const versioner = await createVersioner(base, index.shortTerm);
  const retired = await versioner.write(targetFile, content, {
    name: row.name,
    kind: row.kind,
    triggers: row.triggers,
    hot: row.hot,
    reason: "revert",
  });

  row.revertedAt = new Date().toISOString();
  index.shortTerm.push(...versioner.rows);
  const file = path.basename(targetFile);
  const mod = index.modules.find((candidate) =>
    candidate.file === file || (candidate.name === row.name && (!candidate.file || candidate.file === file)));
  if (mod) {
    mod.tokens = estTokens(content);
  } else {
    index.modules.push({
      name: row.name,
      kind: row.kind,
      file,
      tokens: estTokens(content),
      triggers: Array.isArray(row.triggers) ? row.triggers : [],
      hot: row.hot === true || row.kind === "state" || row.kind === "decisions",
    });
  }
  index.updated = new Date().toISOString();
  await fsp.writeFile(path.join(base, "index.json"), JSON.stringify(index, null, 2));
  return { base, target: targetFile, row, retired, changed: current !== content };
}
