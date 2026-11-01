// Open-tab discovery — the scope for `babyzilla memory search` by default.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readSessionTabs, sessionTitle } from "../lib/session-tabs.mjs";

function tabsFile(data) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bz-tabs-"));
  const file = path.join(dir, "tabs.json");
  fs.writeFileSync(file, JSON.stringify(data));
  return { dir, file };
}

const tab = (id) => ({ sessionID: id, title: id });

test("the workspace containing cwd wins, longest path first", () => {
  const { dir, file } = tabsFile({
    global: { tabs: [] },
    cwd: {
      "/": { tabs: [tab("ses_root")] },
      "/Users/me": { tabs: [tab("ses_a"), tab("ses_b"), tab("ses_c")] },
      "/Users/me/project": { tabs: [tab("ses_project")] },
    },
  });
  try {
    const deep = readSessionTabs({ file, cwd: "/Users/me/project/src", sessionID: null });
    assert.equal(deep.workspace, "/Users/me/project");
    assert.deepEqual(deep.sessions.map((s) => s.id), ["ses_project"]);

    const workspace = readSessionTabs({ file, cwd: "/Users/me/other", sessionID: null });
    assert.equal(workspace.workspace, "/Users/me");
    assert.deepEqual(workspace.sessions.map((s) => s.id), ["ses_a", "ses_b", "ses_c"]);

    const root = readSessionTabs({ file, cwd: "/", sessionID: null });
    assert.equal(root.workspace, "/");
    assert.deepEqual(root.sessions.map((s) => s.id), ["ses_root"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("global tabs are included once; drafts without a sessionID are ignored", () => {
  const { dir, file } = tabsFile({
    global: { tabs: [tab("ses_global"), tab("ses_a")] },
    cwd: { "/work": { tabs: [tab("ses_a"), tab("ses_b"), { draftID: "draft" }] } },
  });
  try {
    const result = readSessionTabs({ file, cwd: "/work", sessionID: null });
    assert.deepEqual(result.sessions.map((s) => s.id), ["ses_global", "ses_a", "ses_b"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a missing or torn tab file means no open sessions, not a crash", () => {
  const missing = readSessionTabs({ file: "/definitely/not/here/tabs.json", cwd: "/work", sessionID: null });
  assert.deepEqual(missing.sessions, []);
  assert.equal(missing.open, false);

  const { dir, file } = tabsFile({});
  try {
    fs.writeFileSync(file, "{not json");
    assert.deepEqual(readSessionTabs({ file, cwd: "/work", sessionID: null }).sessions, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("one workspace is used even when cwd is outside it", () => {
  const { dir, file } = tabsFile({ cwd: { "/work": { tabs: [tab("ses_a")] } } });
  try {
    const result = readSessionTabs({ file, cwd: "/elsewhere", sessionID: null });
    assert.equal(result.workspace, "/work");
    assert.deepEqual(result.sessions.map((s) => s.id), ["ses_a"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the current OpenCode session picks its tab strip even from another cwd", () => {
  const { dir, file } = tabsFile({
    cwd: {
      "/Users/me": { tabs: [tab("ses_a"), tab("ses_b")] },
      "/elsewhere": { tabs: [tab("ses_z")] },
    },
  });
  try {
    const result = readSessionTabs({ file, cwd: "/elsewhere", sessionID: "ses_b" });
    assert.equal(result.workspace, "/Users/me");
    assert.deepEqual(result.sessions.map((s) => s.id), ["ses_a", "ses_b"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("sessionTitle finds a title in any workspace, not just the selected one", () => {
  const { dir, file } = tabsFile({
    global: { tabs: [tab("ses_global")] },
    cwd: {
      "/work/a": { tabs: [{ sessionID: "ses_a", title: "Idea A" }] },
      "/work/b": { tabs: [{ sessionID: "ses_b", title: "Idea B" }] },
    },
  });
  try {
    assert.equal(sessionTitle("ses_a", { file }), "Idea A");
    assert.equal(sessionTitle("ses_b", { file }), "Idea B");
    assert.equal(sessionTitle("ses_missing", { file }), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
