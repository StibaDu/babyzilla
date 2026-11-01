// Cross-session memory search — BM25 over module files, no model, no network.
// The fixtures mirror the real data layout: sessions/<id>/index.json + modules,
// library/<slug>/index.json + lib-*.md.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { searchMemory, renderMemory, rankDocuments, tokenize } from "../lib/memory.mjs";

const tmpRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), "bz-memory-"));

function rows(modules) {
  return modules.map(({ content, ...mod }) => mod);
}

function seedSession(root, { id, projectDir = null, created = "2026-10-01T00:00:00.000Z", modules }) {
  const dir = path.join(root, "sessions", id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "index.json"), JSON.stringify({
    sessionID: id, created, projectDir, modules: rows(modules),
  }));
  for (const mod of modules) fs.writeFileSync(path.join(dir, mod.file), mod.content);
  return dir;
}

function seedJournal(root, id, entries) {
  const dir = path.join(root, "sessions", id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "journal.jsonl"), entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  return dir;
}

function seedLibrary(root, slug, modules, projectDir = null) {
  const dir = path.join(root, "library", slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "index.json"), JSON.stringify({
    projectDir, modules: rows(modules),
  }));
  for (const mod of modules) fs.writeFileSync(path.join(dir, mod.file), mod.content);
  return dir;
}

const mod = (name, kind, file, tokens, triggers, content) =>
  ({ name, kind, file, tokens, triggers, content });

test("memory search finds the session that carried the term and cites its module", () => {
  const root = tmpRoot();
  try {
    seedSession(root, {
      id: "ses_gateway",
      created: "2026-10-20T10:00:00.000Z",
      modules: [mod("errors-gateway", "errors", "errors-gateway.md", 120, ["gateway", "econnreset"],
        "# gateway\n\nECONNRESET from the upstream gateway; fixed by keeping the socket alive.\n")],
    });
    seedSession(root, {
      id: "ses_database",
      created: "2026-10-21T10:00:00.000Z",
      modules: [mod("decisions-db", "decisions", "decisions-db.md", 80, ["sqlite", "wal"],
        "# database\n\nUse WAL mode for the local cache.\n")],
    });

    const result = searchMemory(root, "gateway econnreset");
    assert.equal(result.hits.length, 1, "the database session must not match");
    assert.equal(result.hits[0].sessionID, "ses_gateway");
    assert.equal(result.hits[0].name, "errors-gateway");
    assert.match(result.hits[0].snippet, /ECONNRESET/);
    assert.ok(fs.existsSync(result.hits[0].path), "citation path must resolve");
    assert.equal(result.stats.sessions, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("BM25 weights a repeated rare term above a passing mention", () => {
  const hits = rankDocuments([
    { name: "mentioned", kind: "topic", triggers: [], tokens: 10, path: "/a", text: "retry once. filler filler filler filler filler." },
    { name: "repeated", kind: "topic", triggers: [], tokens: 10, path: "/b", text: "retry retry retry. filler filler filler filler." },
  ], "retry");
  assert.equal(hits[0].name, "repeated");
  assert.ok(hits[0].score > hits[1].score);
});

test("--project restricts sessions and library to one project slug", () => {
  const root = tmpRoot();
  try {
    seedSession(root, {
      id: "ses_alpha", projectDir: "/work/proj-a",
      modules: [mod("topic-alpha", "topic", "topic-alpha.md", 20, ["kestrel"], "KESTREL alpha session")],
    });
    seedSession(root, {
      id: "ses_beta", projectDir: "/work/proj-b",
      modules: [mod("topic-beta", "topic", "topic-beta.md", 20, ["kestrel"], "KESTREL beta session")],
    });
    seedLibrary(root, "proj-a", [mod("errors-alpha", "errors", "lib-errors-alpha.md", 30, ["kestrel"], "KESTREL alpha library")], "/work/proj-a");
    seedLibrary(root, "proj-b", [mod("errors-beta", "errors", "lib-errors-beta.md", 30, ["kestrel"], "KESTREL beta library")], "/work/proj-b");

    const result = searchMemory(root, "kestrel", { projectDir: "/work/proj-a" });
    assert.ok(result.hits.length >= 2);
    for (const hit of result.hits) {
      assert.notEqual(hit.project, "proj-b");
      if (hit.sessionID) assert.equal(hit.sessionID, "ses_alpha");
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("rendered output honours --max-chars and still names a read path", () => {
  const root = tmpRoot();
  try {
    for (let i = 0; i < 5; i++) {
      seedSession(root, {
        id: `ses_k${i}`, created: `2026-10-0${i + 1}T00:00:00.000Z`,
        modules: [mod(`errors-k${i}`, "errors", `errors-k${i}.md`, 100, ["kestrel"],
          `KESTREL failure ${i}: a long explanatory line that should be trimmed before the next hit.`)],
      });
    }
    const text = renderMemory(searchMemory(root, "kestrel", { limit: 5 }), { maxChars: 300 });
    assert.ok(text.length <= 300, `rendered ${text.length} chars`);
    assert.match(text, /^memory: 5 hits/);
    assert.match(text, /read /);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a query with no matching term says so instead of inventing a hit", () => {
  const root = tmpRoot();
  try {
    seedSession(root, {
      id: "ses_quiet",
      modules: [mod("topic-quiet", "topic", "topic-quiet.md", 10, ["kestrel"], "nothing relevant")],
    });
    const result = searchMemory(root, "qqzzxx");
    assert.deepEqual(result.hits, []);
    const text = renderMemory(result);
    assert.match(text, /no module matches "qqzzxx"/);
    assert.match(text, /1 modules \/ 1 sessions/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("missing module files are skipped, not fatal", () => {
  const root = tmpRoot();
  try {
    seedSession(root, {
      id: "ses_missing",
      modules: [
        mod("errors-gone", "errors", "errors-gone.md", 10, ["kestrel"], "unused"),
        mod("errors-here", "errors", "errors-here.md", 10, ["kestrel"], "KESTREL still here"),
      ],
    });
    fs.rmSync(path.join(root, "sessions", "ses_missing", "errors-gone.md"));
    const result = searchMemory(root, "kestrel");
    assert.equal(result.hits.length, 1);
    assert.equal(result.stats.skipped, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("CJK terms match through character bigrams", () => {
  const root = tmpRoot();
  try {
    seedSession(root, {
      id: "ses_cjk",
      modules: [mod("topic-connection", "topic", "topic-connection.md", 20, ["接続"],
        "接続がタイムアウトしたため、再試行を追加した。")],
    });
    const result = searchMemory(root, "接続");
    assert.equal(result.hits.length, 1);
    assert.equal(result.hits[0].sessionID, "ses_cjk");
    assert.ok(tokenize("接続").includes("接続"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("identical promoted modules are one hit, not two", () => {
  const root = tmpRoot();
  try {
    const text = "KESTREL shared memory text";
    seedSession(root, {
      id: "ses_dup", projectDir: "/work/dup",
      modules: [mod("errors-dup", "errors", "errors-dup.md", 10, ["kestrel"], text)],
    });
    seedLibrary(root, "dup", [mod("errors-dup", "errors", "lib-errors-dup.md", 10, ["kestrel"], text)], "/work/dup");
    const result = searchMemory(root, "kestrel");
    assert.equal(result.hits.length, 1);
    assert.ok(result.stats.duplicates >= 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("sessionIDs scopes the corpus to open packs and leaves the library out", () => {
  const root = tmpRoot();
  try {
    seedSession(root, {
      id: "ses_open",
      modules: [mod("errors-open", "errors", "errors-open.md", 10, ["kestrel"], "KESTREL open pack")],
    });
    seedSession(root, {
      id: "ses_closed",
      modules: [mod("errors-closed", "errors", "errors-closed.md", 10, ["kestrel"], "KESTREL closed pack")],
    });
    seedLibrary(root, "proj", [mod("errors-lib", "errors", "lib-errors-lib.md", 10, ["kestrel"], "KESTREL library")]);
    const scoped = searchMemory(root, "kestrel", { sessionIDs: ["ses_open"], includeLibrary: false });
    assert.deepEqual(scoped.hits.map((hit) => hit.sessionID), ["ses_open"]);
    assert.equal(scoped.stats.scope, "open");
    assert.equal(scoped.stats.requestedSessions, 1);
    assert.equal(scoped.stats.sessions, 1);

    const all = searchMemory(root, "kestrel");
    assert.equal(all.hits.length, 3, "all scope still sees packs and the library");
    assert.equal(all.stats.scope, "all");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a tab without a pack falls back to its journal", () => {
  const root = tmpRoot();
  try {
    seedSession(root, {
      id: "ses_packed",
      modules: [mod("errors-open", "errors", "errors-open.md", 10, ["wormcoil"], "Wormcoil in the packed tab")],
    });
    seedJournal(root, "ses_unpacked", [
      { t: 1793216310603, tool: "execute", status: "completed", tokens: 39, head: "Wormcoil Engine is missing from the deck." },
      { t: 1793216432632, tool: "write", status: "completed", tokens: 36, head: "Created deine-mutter-commander-deck.md" },
    ]);
    const result = searchMemory(root, "wormcoil", {
      sessionIDs: ["ses_packed", "ses_unpacked"], includeLibrary: false,
    });
    assert.equal(result.stats.requestedSessions, 2);
    assert.equal(result.stats.sessions, 2, "both open tabs are represented");
    assert.equal(result.stats.journals, 2, "both journal rows are in the corpus");
    const journal = result.hits.find((hit) => hit.source === "journal");
    assert.ok(journal, "the unpacked tab's journal must be searchable");
    assert.equal(journal.sessionID, "ses_unpacked");
    assert.match(journal.snippet, /Wormcoil/);
    assert.match(renderMemory(result), /entries/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("CLI: open tabs are the default scope; --all searches history and library", () => {
  const root = tmpRoot();
  try {
    seedSession(root, {
      id: "ses_cli_open",
      modules: [mod("errors-cli", "errors", "errors-cli.md", 10, ["kestrel"], "KESTREL from the open tab")],
    });
    seedSession(root, {
      id: "ses_cli_closed",
      modules: [mod("errors-closed", "errors", "errors-closed.md", 10, ["kestrel"], "KESTREL from a closed session")],
    });
    seedLibrary(root, "proj", [mod("errors-lib", "errors", "lib-errors-lib.md", 10, ["kestrel"], "KESTREL from the library")]);

    const tabs = path.join(root, "tabs.json");
    fs.writeFileSync(tabs, JSON.stringify({
      global: { tabs: [] },
      cwd: { "/": { tabs: [{ sessionID: "ses_cli_open", title: "fixture" }] } },
    }));
    const bin = fileURLToPath(new URL("../bin/babyzilla.mjs", import.meta.url));
    const env = {
      ...process.env,
      BABYZILLA_ROOT: root,
      BABYZILLA_NO_UPDATE_CHECK: "1",
      BABYZILLA_TABS: tabs,
      OPENCODE_SESSION_ID: "ses_cli_open",
    };

    const open = spawnSync(process.execPath, [bin, "memory", "search", "kestrel", "--json"], { encoding: "utf8", env });
    assert.equal(open.status, 0, open.stderr);
    const opened = JSON.parse(open.stdout);
    assert.equal(opened.query, "kestrel");
    assert.equal(opened.stats.scope, "open");
    assert.equal(opened.stats.requestedSessions, 1);
    assert.deepEqual(opened.hits.map((hit) => hit.sessionID), ["ses_cli_open"]);
    assert.equal(opened.hits[0].text, undefined, "JSON carries metadata, not the whole module");
    assert.equal(opened.open.sessions, 1);
    assert.equal(opened.open.file, path.resolve(tabs));

    const all = spawnSync(process.execPath, [bin, "memory", "search", "kestrel", "--all", "--json"], { encoding: "utf8", env });
    assert.equal(all.status, 0, all.stderr);
    const history = JSON.parse(all.stdout);
    assert.equal(history.stats.scope, "all");
    assert.equal(history.open, null);
    assert.ok(history.hits.some((hit) => hit.sessionID === "ses_cli_closed"));
    assert.ok(history.hits.some((hit) => hit.source === "library"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("retired revisions are searchable and labelled short-term", () => {
  const root = tmpRoot();
  try {
    const dir = seedSession(root, {
      id: "ses_history",
      modules: [mod("state-now", "state", "00-state.md", 20, ["gateway"], "CURRENT gateway state\n")],
    });
    fs.mkdirSync(path.join(dir, "short"), { recursive: true });
    fs.writeFileSync(path.join(dir, "short", "0001-00-state.md"), "OLD gateway state from last week\n");
    const index = JSON.parse(fs.readFileSync(path.join(dir, "index.json"), "utf8"));
    index.shortTerm = [{
      name: "00-state", kind: "state", seq: 1, at: "2026-10-20T10:00:00Z", tokens: 9,
      path: "short/0001-00-state.md", replacedBy: "00-state.md", triggers: ["gateway"], hot: true,
    }];
    fs.writeFileSync(path.join(dir, "index.json"), JSON.stringify(index, null, 2));

    const result = searchMemory(root, "gateway");
    assert.equal(result.stats.shortTerm, 1);
    const retired = result.hits.find((hit) => hit.source === "short-term");
    assert.ok(retired, "the retired revision must be in the corpus");
    assert.equal(retired.seq, 1);
    assert.match(retired.snippet, /OLD gateway state/);
    assert.match(renderMemory(result), /short-term #1/);
    assert.match(renderMemory(result), /entries/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
