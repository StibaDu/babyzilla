// Long-term -> short-term memory: versioning, listing, revert, and library
// promotion. Everything here is deterministic; no model is involved.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createVersioner, historyEntries, revertVersion } from "../lib/history.mjs";
import { promoteModules } from "../lib/library.mjs";

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "bz-history-"));
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function seedPack(root, sessionID, { modules = [], shortTerm = [] } = {}) {
  const base = path.join(root, "sessions", sessionID);
  fs.mkdirSync(base, { recursive: true });
  fs.writeFileSync(path.join(base, "index.json"), JSON.stringify({
    sessionID, projectDir: "/work/proj", created: "2026-10-29T10:00:00Z", modules, shortTerm,
  }, null, 2));
  return base;
}

test("a differing module moves to short/ before the new bytes land", async () => {
  const root = tmpRoot();
  try {
    const base = seedPack(root, "ses_a");
    fs.writeFileSync(path.join(base, "00-state.md"), "first state");
    const versioner = await createVersioner(base, []);
    const row = await versioner.write("00-state.md", "second state", { name: "00-state", kind: "state" });
    assert.ok(row, "a changed module must produce a history row");
    assert.equal(row.seq, 1);
    assert.equal(row.path, "short/0001-00-state.md");
    assert.equal(row.replacedBy, "00-state.md");
    assert.equal(fs.readFileSync(path.join(base, "00-state.md"), "utf8"), "second state");
    assert.equal(fs.readFileSync(path.join(base, "short", "0001-00-state.md"), "utf8"), "first state");

    // Same bytes: no churn, no duplicate row.
    const again = await versioner.write("00-state.md", "second state", { name: "00-state", kind: "state" });
    assert.equal(again, null);
    assert.equal(versioner.rows.length, 1);

    // A fresh versioner, seeded from the row, continues the sequence.
    const next = await createVersioner(base, versioner.rows);
    const second = await next.write("00-state.md", "third state", { name: "00-state", kind: "state" });
    assert.equal(second.seq, 2);
    assert.equal(second.path, "short/0002-00-state.md");
    assert.equal(fs.readFileSync(path.join(base, "short", "0002-00-state.md"), "utf8"), "second state");
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("a module the new pack dropped is retired, not deleted", async () => {
  const root = tmpRoot();
  try {
    const base = seedPack(root, "ses_drop");
    fs.writeFileSync(path.join(base, "tool-old.md"), "old tool knowledge");
    const versioner = await createVersioner(base, []);
    const row = await versioner.retire("tool-old.md", { name: "old", kind: "tool" });
    assert.ok(row);
    assert.equal(row.replacedBy, null);
    assert.equal(row.reason, "dropped");
    assert.equal(fs.existsSync(path.join(base, "tool-old.md")), false);
    assert.equal(fs.readFileSync(path.join(base, "short", "0001-tool-old.md"), "utf8"), "old tool knowledge");
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("revert restores the old revision and keeps the replaced one", async () => {
  const root = tmpRoot();
  try {
    const base = seedPack(root, "ses_rev", {
      modules: [{ name: "00-state", kind: "state", file: "00-state.md", tokens: 9, triggers: ["deck"], hot: true }],
    });
    fs.writeFileSync(path.join(base, "00-state.md"), "78 cards");
    const versioner = await createVersioner(base, []);
    const row = await versioner.write("00-state.md", "79 cards", { name: "00-state", kind: "state" });
    const index = readJson(path.join(base, "index.json"));
    index.shortTerm.push(row);
    fs.writeFileSync(path.join(base, "index.json"), JSON.stringify(index, null, 2));

    const result = await revertVersion({ root, shortPath: path.join(base, row.path) });
    assert.equal(result.target, "00-state.md");
    assert.equal(fs.readFileSync(path.join(base, "00-state.md"), "utf8"), "78 cards");
    const after = readJson(path.join(base, "index.json"));
    assert.ok(after.shortTerm.find((candidate) => candidate.path === row.path)?.revertedAt);
    assert.equal(after.shortTerm.length, 2);
    const revertRow = after.shortTerm.find((candidate) => candidate.reason === "revert");
    assert.ok(revertRow);
    assert.equal(revertRow.replacedBy, "00-state.md");
    assert.equal(fs.readFileSync(path.join(base, revertRow.path), "utf8"), "79 cards");

    const listed = historyEntries({ root, sessionID: "ses_rev" });
    assert.equal(listed.length, 2);
    assert.ok(listed.every((entry) => entry.scope === "session" && entry.id === "ses_rev"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("library promotion retires the previous library copy", async () => {
  const root = tmpRoot();
  try {
    const mod = (content) => ({ name: "00-state", kind: "state", content, triggers: ["deck"], hot: true });
    await promoteModules({ root, projectDir: "/work/mtg", modules: [mod("old deck")] });
    await promoteModules({ root, projectDir: "/work/mtg", modules: [mod("new deck")] });
    const base = path.join(root, "library", "mtg");
    assert.equal(fs.readFileSync(path.join(base, "lib-00-state.md"), "utf8"), "new deck");
    const index = readJson(path.join(base, "index.json"));
    const row = index.shortTerm.find((candidate) => candidate.name === "00-state");
    assert.ok(row);
    assert.equal(row.path, "short/0001-lib-00-state.md");
    assert.equal(fs.readFileSync(path.join(base, row.path), "utf8"), "old deck");
    assert.equal(index.modules[0].tokens, 2);
    const listed = historyEntries({ root, projectDir: "/work/mtg" });
    assert.equal(listed.length, 1);
    assert.equal(listed[0].scope, "library");
    assert.equal(listed[0].id, "mtg");
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("CLI: memory history and revert operate on the short-term rows", async () => {
  const root = tmpRoot();
  try {
    const base = seedPack(root, "ses_cli", {
      modules: [{ name: "00-state", kind: "state", file: "00-state.md", tokens: 4, triggers: [], hot: true }],
    });
    fs.writeFileSync(path.join(base, "00-state.md"), "old cli state");
    const bin = fileURLToPath(new URL("../bin/babyzilla.mjs", import.meta.url));
    const env = { ...process.env, BABYZILLA_ROOT: root, BABYZILLA_NO_UPDATE_CHECK: "1" };
    const versioner = await createVersioner(base, []);
    const row = await versioner.write("00-state.md", "new cli state", { name: "00-state", kind: "state" });
    const index = readJson(path.join(base, "index.json"));
    index.shortTerm.push(row);
    fs.writeFileSync(path.join(base, "index.json"), JSON.stringify(index, null, 2));

    const history = spawnSync(process.execPath, [bin, "memory", "history", "--session", "ses_cli", "--json"], { encoding: "utf8", env });
    assert.equal(history.status, 0, history.stderr);
    const rows = JSON.parse(history.stdout);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].path, "short/0001-00-state.md");

    const revert = spawnSync(process.execPath, [bin, "memory", "revert", rows[0].rootPath, "--json"], { encoding: "utf8", env });
    assert.equal(revert.status, 0, revert.stderr);
    assert.equal(fs.readFileSync(path.join(base, "00-state.md"), "utf8"), "old cli state");
    const listed = JSON.parse(spawnSync(process.execPath, [bin, "memory", "history", "--session", "ses_cli", "--json"], { encoding: "utf8", env }).stdout);
    assert.equal(listed.length, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
