// `babyzilla recall` — resolve an elision handle back to the exact original
// text in the OpenCode database. Uses a throwaway SQLite database.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { recall } from "../bin/babyzilla.mjs";

// node:sqlite shipped in Node 22.5; keep the rest of the suite runnable on 18/20.
let DatabaseSync = null;
try {
  ({ DatabaseSync } = await import("node:sqlite"));
} catch { /* older Node — the database test is skipped below */ }

const skip = DatabaseSync ? false : "node:sqlite unavailable (Node < 22.5)";

function tempDb(parts) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "babyzilla-recall-"));
  const dbPath = path.join(dir, "opencode.db");
  const db = new DatabaseSync(dbPath);
  db.exec(`create table part (
    id text primary key, message_id text not null, session_id text not null,
    time_created integer not null, time_updated integer not null, data text not null)`);
  const insert = db.prepare("insert into part values (?,?,?,?,?,?)");
  parts.forEach((p, i) => {
    insert.run(
      p.id, p.message_id ?? "msg_1", p.session_id ?? "ses_1",
      1_000 + i, 1_000 + i, JSON.stringify(p.data),
    );
  });
  db.close();
  return { dir, dbPath };
}

test("recall returns the exact tool output behind a callID", { skip }, () => {
  const { dir, dbPath } = tempDb([
    {
      id: "prt_1",
      data: { type: "tool", tool: "bash", callID: "call_abc", state: { status: "completed", output: "alpha\nbeta\ngamma" } },
    },
  ]);
  try {
    const out = recall("call_abc", { dbPath });
    assert.match(out, /Recall call_abc \(bash, session ses_1/);
    assert.match(out, /1: alpha/);
    assert.match(out, /3: gamma/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("recall slices a line range", { skip }, () => {
  const { dir, dbPath } = tempDb([
    { id: "prt_1", data: { type: "tool", tool: "bash", callID: "call_abc", state: { output: "a\nb\nc\nd" } } },
  ]);
  try {
    const out = recall("call_abc:2-3", { dbPath });
    assert.match(out, /lines 2-3 of 4/);
    assert.match(out, /2: b\n3: c/);
    assert.doesNotMatch(out, /1: a/);
    assert.match(out, /1 more line/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("recall resolves a message id to all of its parts", { skip }, () => {
  const { dir, dbPath } = tempDb([
    { id: "prt_1", message_id: "msg_9", data: { type: "tool", tool: "read", callID: "call_r", state: { content: [{ type: "text", text: "file body" }] } } },
    { id: "prt_2", message_id: "msg_9", data: { type: "text", text: "assistant prose" } },
  ]);
  try {
    const out = recall("msg_9", { dbPath });
    assert.match(out, /file body/);
    assert.match(out, /assistant prose/);
    assert.match(out, /read \(prt_1\)/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("recall reports unknown handles instead of inventing text", { skip }, () => {
  const { dir, dbPath } = tempDb([
    { id: "prt_1", data: { type: "tool", tool: "bash", callID: "call_abc", state: { output: "x" } } },
  ]);
  try {
    assert.throws(() => recall("call_nope", { dbPath }), /no part matches call_nope/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
