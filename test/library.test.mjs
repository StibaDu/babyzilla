// Library index tests — the regression guard for the path bug fixed in 0.3.0.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { libraryIndex } from "../lib/library.mjs";

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "bz-lib-"));
}

function writeLibrary(root, dir, modules) {
  const base = path.join(root, "library", dir);
  fs.mkdirSync(base, { recursive: true });
  fs.writeFileSync(path.join(base, "index.json"), JSON.stringify({ modules }));
  return base;
}

test("libraryIndex resolves basenames to absolute paths next to the index", async () => {
  const root = tmpRoot();
  const base = writeLibrary(root, "bz-battle", [{ name: "a", file: "lib-a.md", tokens: 10 }]);
  fs.writeFileSync(path.join(base, "lib-a.md"), "content");

  const idx = await libraryIndex("/Users/me/projects/bz-battle", root);
  assert.equal(idx.modules.length, 1);
  assert.equal(idx.modules[0].path, path.join(base, "lib-a.md"));
  assert.ok(fs.existsSync(idx.modules[0].path), "resolved path must exist");
});

test("libraryIndex keeps an explicit absolute path", async () => {
  const root = tmpRoot();
  writeLibrary(root, "proj", [{ name: "a", file: "lib-a.md", path: "/custom/place/lib-a.md" }]);
  const idx = await libraryIndex("/x/proj", root);
  assert.equal(idx.modules[0].path, "/custom/place/lib-a.md");
});

test("libraryIndex returns an empty module list when there is no index", async () => {
  const idx = await libraryIndex("/x/never-seen", tmpRoot());
  assert.deepEqual(idx, { modules: [] });
});

test("libraryIndex isolates projects by their directory slug", async () => {
  const root = tmpRoot();
  writeLibrary(root, "alpha", [{ name: "a", file: "lib-a.md" }]);
  writeLibrary(root, "beta", [{ name: "b", file: "lib-b.md" }]);
  assert.equal((await libraryIndex("/work/alpha", root)).modules[0].file, "lib-a.md");
  assert.equal((await libraryIndex("/work/beta", root)).modules[0].file, "lib-b.md");
});
