// Integration: a real second compaction versions the modules it replaces, in
// the session pack and in the project library. A temp BABYZILLA_ROOT keeps the
// user's packs out of the test.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "bz-plugin-history-"));
process.env.BABYZILLA_ROOT = root;
process.env.BABYZILLA_SELFTUNE_DISABLE = "1";
const { default: plugin } = await import("../index.js");

after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

async function loadPlugin() {
  const handlers = new Map();
  let round = 0;
  const ctx = {
    options: { calibrate: false, grounding: false, charter: false, pet: false, library: true },
    tool: { hook: async () => {} },
    session: {
      hook: async (name, fn) => { handlers.set(name, fn); },
      context: async () => [],
      get: async () => ({ directory: "/work/proj" }),
      synthetic: async () => {},
      compact: async () => { throw new Error("test: native compaction must not run"); },
    },
    command: { transform: async () => {} },
    generate: {
      text: async () => {
        round++;
        return {
          text: JSON.stringify([
            { kind: "state", name: "00-state", triggers: ["deck"], content: `State round ${round}` },
            { kind: "decisions", name: "keep", triggers: ["keep"], content: `Decision round ${round}` },
          ]),
        };
      },
    },
  };
  await plugin.setup(ctx);
  return handlers;
}

function compactionEvent(sessionID) {
  const bulk = "context line — ".repeat(4000); // > minRawTokens when estimated
  return {
    sessionID,
    model: { providerID: "test", id: "test-model" },
    messages: [
      { role: "user", content: [{ type: "text", text: `build the deck ${bulk}` }] },
      { role: "assistant", content: [{ type: "text", text: `deck built ${bulk}` }] },
    ],
  };
}

test("the second compaction retires the modules it replaces", async () => {
  const sid = "ses_bz_history";
  const handlers = await loadPlugin();
  const first = compactionEvent(sid);
  await handlers.get("compaction")(first);
  assert.ok(first.result?.summary, "first compaction must produce a pack");

  const pack = path.join(root, "sessions", sid);
  const firstIndex = JSON.parse(fs.readFileSync(path.join(pack, "index.json"), "utf8"));
  assert.equal(firstIndex.shortTerm.length, 0, "the first pack has no predecessor");
  assert.equal(fs.readFileSync(path.join(pack, "00-state.md"), "utf8"), "State round 1");

  const second = compactionEvent(sid);
  await handlers.get("compaction")(second);
  assert.ok(second.result?.summary, "second compaction must produce a pack");

  const index = JSON.parse(fs.readFileSync(path.join(pack, "index.json"), "utf8"));
  const stateRow = index.shortTerm.find((row) => row.replacedBy === "00-state.md");
  const decisionRow = index.shortTerm.find((row) => row.replacedBy === "decisions-keep.md");
  assert.ok(stateRow, "the old state must be in short-term memory");
  assert.ok(decisionRow, "the old decisions must be in short-term memory");
  assert.equal(fs.readFileSync(path.join(pack, stateRow.path), "utf8"), "State round 1");
  assert.equal(fs.readFileSync(path.join(pack, "00-state.md"), "utf8"), "State round 2");

  // The project library has the same history, because promotion goes through
  // the same versioned write.
  const library = path.join(root, "library", "proj");
  const libraryIndex = JSON.parse(fs.readFileSync(path.join(library, "index.json"), "utf8"));
  assert.ok(libraryIndex.shortTerm.some((row) => row.replacedBy === "lib-00-state.md"));
  assert.equal(fs.readFileSync(path.join(library, "lib-00-state.md"), "utf8"), "State round 2");
});
