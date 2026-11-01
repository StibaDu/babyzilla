// Session charter — the stable orientation header built from a pack (or the
// thin title/journal version before the first compaction).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildCharter, addCharterToSystem, CHARTER_MARK } from "../lib/charter.mjs";

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "bz-charter-"));
}

function writeModule(base, file, content) {
  fs.writeFileSync(path.join(base, file), content);
  return path.join(base, file);
}

test("a full charter carries title, state, decisions and the retired count", () => {
  const root = tmpRoot();
  try {
    const base = path.join(root, "sessions", "ses_charter");
    fs.mkdirSync(base, { recursive: true });
    const state = writeModule(base, "00-state.md", "# MTG deck\n- 78 cards final\n- proxies allowed");
    const decisions = writeModule(base, "decisions-1.md", "- Removed Wormcoil Engine\n- Keep proxies under €5");
    fs.writeFileSync(path.join(base, "index.json"), JSON.stringify({
      sessionID: "ses_charter",
      created: "2026-10-29T10:00:00Z",
      projectDir: "/Users/me/mtg",
      modules: [
        { name: "00-state", kind: "state", file: "00-state.md", path: state, tokens: 20, triggers: [], hot: true },
        { name: "1", kind: "decisions", file: "decisions-1.md", path: decisions, tokens: 20, triggers: [], hot: true },
      ],
      shortTerm: [
        { name: "00-state", kind: "state", seq: 1, at: "2026-10-28T10:00:00Z", tokens: 10, path: "short/0001-00-state.md", replacedBy: "00-state.md" },
        { name: "00-state", kind: "state", seq: 2, at: "2026-10-29T10:00:00Z", tokens: 10, path: "short/0002-00-state.md", replacedBy: "00-state.md" },
      ],
    }));

    const charter = buildCharter({ root, sessionID: "ses_charter", title: "MTG Commander Deck" });
    assert.equal(charter.kind, "full");
    assert.match(charter.text, /About: MTG Commander Deck/);
    assert.match(charter.text, /Snapshot: 2026-10-29/);
    assert.match(charter.text, /78 cards final/);
    assert.match(charter.text, /Removed Wormcoil Engine/);
    assert.match(charter.text, /Superseded: 2 retired facts/);
    assert.match(charter.text, /index\.json lists every path/);
    assert.ok(charter.text.length <= 1200, `charter should fit the cap, got ${charter.text.length}`);
    assert.equal(charter.shortTerm, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the character cap wins over the state/decisions sizes", () => {
  const root = tmpRoot();
  try {
    const base = path.join(root, "sessions", "ses_long");
    fs.mkdirSync(base, { recursive: true });
    const state = writeModule(base, "00-state.md", `# Long\n${"- a state line that keeps going and going\n".repeat(200)}`);
    const decisions = writeModule(base, "decisions-1.md", `- decision\n`.repeat(200));
    fs.writeFileSync(path.join(base, "index.json"), JSON.stringify({
      modules: [
        { name: "00-state", kind: "state", file: "00-state.md", path: state, tokens: 1000, hot: true },
        { name: "1", kind: "decisions", file: "decisions-1.md", path: decisions, tokens: 1000, hot: true },
      ],
    }));
    const charter = buildCharter({ root, sessionID: "ses_long", title: "Long idea", maxChars: 600 });
    assert.ok(charter.text.length <= 600, `expected <=600 chars, got ${charter.text.length}`);
    assert.match(charter.text, /About: Long idea/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a tab without a pack gets a stable thin charter from its first journal step", () => {
  const root = tmpRoot();
  try {
    const base = path.join(root, "sessions", "ses_thin");
    fs.mkdirSync(base, { recursive: true });
    fs.writeFileSync(path.join(base, "journal.jsonl"), [
      JSON.stringify({ t: 1, tool: "write", status: "completed", tokens: 12, head: "first step wrote the idea file" }),
      JSON.stringify({ t: 2, tool: "edit", status: "completed", tokens: 4, head: "later step changed something" }),
    ].join("\n"));

    const first = buildCharter({ root, sessionID: "ses_thin", title: "Quick test" });
    const second = buildCharter({ root, sessionID: "ses_thin", title: "Quick test" });
    assert.equal(first.kind, "thin");
    assert.match(first.text, /About: Quick test/);
    assert.match(first.text, /Opening step: write completed — first step wrote the idea file/);
    assert.doesNotMatch(first.text, /later step/);
    assert.equal(second.text, first.text, "thin charter bytes must not drift between requests");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the title comes from OpenCode's tab strip when no title is passed", () => {
  const root = tmpRoot();
  const previous = process.env.BABYZILLA_TABS;
  try {
    fs.writeFileSync(path.join(root, "tabs.json"), JSON.stringify({
      global: { tabs: [] },
      cwd: { "/work": { tabs: [{ sessionID: "ses_tab", title: "Idea tab" }] } },
    }));
    process.env.BABYZILLA_TABS = path.join(root, "tabs.json");
    const charter = buildCharter({ root, sessionID: "ses_tab" });
    assert.equal(charter.kind, "thin");
    assert.match(charter.text, /About: Idea tab/);
  } finally {
    if (previous === undefined) delete process.env.BABYZILLA_TABS;
    else process.env.BABYZILLA_TABS = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("no pack, no title and no journal means no charter", () => {
  const root = tmpRoot();
  const previous = process.env.BABYZILLA_TABS;
  try {
    process.env.BABYZILLA_TABS = path.join(root, "missing-tabs.json");
    assert.equal(buildCharter({ root, sessionID: "ses_missing" }), null);
  } finally {
    if (previous === undefined) delete process.env.BABYZILLA_TABS;
    else process.env.BABYZILLA_TABS = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the charter is added once and carries its marker", () => {
  const system = [];
  assert.equal(addCharterToSystem(system, `${CHARTER_MARK} first`), true);
  assert.equal(addCharterToSystem(system, `${CHARTER_MARK} second`), false);
  assert.equal(system.length, 1);
  assert.match(system[0].text, /\[babyzilla:charter\]/);
});
