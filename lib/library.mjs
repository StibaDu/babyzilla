// Cross-session library index.
//
// Library indexes store only a file basename, because the module files live
// next to the index. Callers need absolute paths (the prompt hook attaches them
// to the next prompt), so resolve them here — this is the bug that used to
// point every library module at `sessions/<id>/<file>`, where no file exists.

import { promises as fs } from "node:fs";
import path from "node:path";
import { dirSlug } from "./distill.mjs";

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
