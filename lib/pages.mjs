// Content-addressed page store for elided context.
//
// When the prompt compactor replaces tool output with a one-line pointer, the
// exact bytes are written here first. `babyzilla recall <hash>` reads them
// back, so paging is reversible for every tool — including shell commands
// whose output cannot be re-fetched by path.
//
// Layout: <root>/pages/<first two hex chars>/<hash>.txt
// The hash is stable for identical text, so spilling the same result twice is
// a no-op. Pages are pruned by `babyzilla prune` with the session packs.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const PAGE_HASH_LEN = 16;

export function pageHash(text) {
  return crypto.createHash("sha256").update(String(text)).digest("hex").slice(0, PAGE_HASH_LEN);
}

export function pagePath(root, hash) {
  const h = String(hash);
  return path.join(root, "pages", h.slice(0, 2), `${h}.txt`);
}

/** Write `text` and return its handle. Never throws (best effort). */
export function writePage(root, text) {
  try {
    const hash = pageHash(text);
    const file = pagePath(root, hash);
    if (!fs.existsSync(file)) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, String(text));
    }
    return hash;
  } catch {
    return null;
  }
}

/** Read a page back. Returns null when the hash is unknown or malformed. */
export function readPage(root, hash) {
  if (!/^[0-9a-f]{16}$/.test(String(hash))) return null;
  const file = pagePath(root, hash);
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/** Remove pages older than `cutoffSecs`. Returns the number removed. */
export function prunePages(root, cutoffSecs, now = Date.now() / 1000) {
  const dir = path.join(root, "pages");
  let removed = 0;
  let shards = [];
  try { shards = fs.readdirSync(dir); } catch { return 0; }
  for (const shard of shards) {
    const sdir = path.join(dir, shard);
    let files = [];
    try { files = fs.readdirSync(sdir); } catch { continue; }
    for (const f of files) {
      const file = path.join(sdir, f);
      try {
        const st = fs.statSync(file);
        if (st.mtimeMs / 1000 < now - cutoffSecs) {
          fs.unlinkSync(file);
          removed++;
        }
      } catch { /* ignore */ }
    }
    try { if (fs.readdirSync(sdir).length === 0) fs.rmdirSync(sdir); } catch { /* ignore */ }
  }
  return removed;
}
