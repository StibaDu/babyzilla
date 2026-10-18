// Page store: the exact original of every elided block, addressed by content
// hash. Recall must round-trip byte-for-byte and pruning must not touch fresh
// pages.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pageHash, writePage, readPage, prunePages } from "../lib/pages.mjs";

const tmpRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), "babyzilla-pages-"));

test("writePage/readPage round-trip exact bytes", () => {
  const root = tmpRoot();
  const text = "line 1\nline 2\n\tindented\n\u4f60\u597d\n";
  const hash = writePage(root, text);
  assert.match(hash, /^[0-9a-f]{16}$/);
  assert.equal(readPage(root, hash), text);
  assert.equal(hash, pageHash(text), "handle is the content hash");
});

test("identical text reuses one page", () => {
  const root = tmpRoot();
  const a = writePage(root, "same");
  const b = writePage(root, "same");
  assert.equal(a, b);
  assert.equal(fs.readdirSync(path.join(root, "pages", a.slice(0, 2))).length, 1);
});

test("readPage returns null for unknown or missing pages", () => {
  const root = tmpRoot();
  assert.equal(readPage(root, "0000000000000000"), null);
});

test("prunePages removes only pages older than the cutoff", () => {
  const root = tmpRoot();
  const old = writePage(root, "old");
  const fresh = writePage(root, "fresh");
  const file = path.join(root, "pages", old.slice(0, 2), `${old}.txt`);
  const past = Date.now() / 1000 - 90 * 86400;
  fs.utimesSync(file, past, past);
  const removed = prunePages(root, 30 * 86400);
  assert.equal(removed, 1);
  assert.equal(readPage(root, old), null);
  assert.equal(readPage(root, fresh), "fresh");
});
