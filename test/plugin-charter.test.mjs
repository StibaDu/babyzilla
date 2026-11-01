// Integration: the real plugin adds the charter to event.system, once, with
// stable bytes across requests. A temp BABYZILLA_ROOT keeps real packs out.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "bz-plugin-charter-"));
process.env.BABYZILLA_ROOT = root;
process.env.BABYZILLA_LOG = "0";
process.env.BABYZILLA_TABS = path.join(root, "tabs.json");
process.env.BABYZILLA_SELFTUNE_DISABLE = "1";
const { default: plugin } = await import("../index.js");
const { CHARTER_MARK } = await import("../lib/charter.mjs");

after(() => {
  try {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  } catch {
    // Windows can still hold a log handle; a temp directory is disposable.
  }
});

function writeTabs(sessions) {
  fs.writeFileSync(process.env.BABYZILLA_TABS, JSON.stringify({
    global: { tabs: [] },
    cwd: { "/work": { tabs: sessions } },
  }));
}

function writePack(sessionID, { state, shortTerm = [] } = {}) {
  const base = path.join(root, "sessions", sessionID);
  fs.mkdirSync(base, { recursive: true });
  const stateFile = path.join(base, "00-state.md");
  fs.writeFileSync(stateFile, state);
  fs.writeFileSync(path.join(base, "index.json"), JSON.stringify({
    sessionID,
    created: "2026-10-29T10:00:00Z",
    modules: [{ name: "00-state", kind: "state", file: "00-state.md", path: stateFile, tokens: 10, triggers: [], hot: true }],
    shortTerm,
  }));
  return base;
}

async function loadPlugin(options = {}) {
  const contextHooks = [];
  const ctx = {
    options: { calibrate: false, grounding: false, pet: false, checkUpdates: false, ...options },
    tool: { hook: async () => {} },
    session: {
      hook: async (name, fn) => { if (name === "context") contextHooks.push(fn); },
      context: async () => [],
      get: async () => ({ directory: "/work" }),
      generate: async () => ({}),
      synthetic: async () => {},
      compact: async () => {},
    },
    command: { transform: async () => {} },
    generate: { text: async () => "" },
  };
  await plugin.setup(ctx);
  return contextHooks;
}

async function run(hooks, event) {
  for (const hook of hooks) await hook(event);
  return event;
}

test("the plugin adds a full charter, with stable bytes on the next request", async () => {
  writeTabs([{ sessionID: "ses_charter", title: "Charter session" }]);
  writePack("ses_charter", { state: "# Charter state\n- the deck is 78 cards" });
  const hooks = await loadPlugin({ charter: true });

  const first = await run(hooks, { sessionID: "ses_charter", system: [], messages: [], model: { id: "test" } });
  const charter = first.system.find((part) => part.text?.includes(CHARTER_MARK));
  assert.ok(charter, "the charter must reach event.system");
  assert.match(charter.text, /About: Charter session/);
  assert.match(charter.text, /the deck is 78 cards/);

  const second = await run(hooks, { sessionID: "ses_charter", system: [], messages: [], model: { id: "test" } });
  assert.equal(
    second.system.find((part) => part.text?.includes(CHARTER_MARK))?.text,
    charter.text,
    "same pack -> byte-identical charter",
  );
});

test("charter:false leaves the request untouched", async () => {
  writeTabs([{ sessionID: "ses_charter", title: "Charter session" }]);
  const hooks = await loadPlugin({ charter: false });
  const event = await run(hooks, { sessionID: "ses_charter", system: [], messages: [], model: { id: "test" } });
  assert.equal(event.system.some((part) => part.text?.includes(CHARTER_MARK)), false);
});

test("a tab without a pack gets a thin charter from its first journal step", async () => {
  writeTabs([
    { sessionID: "ses_charter", title: "Charter session" },
    { sessionID: "ses_thin", title: "Unpacked idea" },
  ]);
  const base = path.join(root, "sessions", "ses_thin");
  fs.mkdirSync(base, { recursive: true });
  fs.writeFileSync(path.join(base, "journal.jsonl"),
    JSON.stringify({ t: 1, tool: "write", status: "completed", tokens: 4, head: "wrote the first draft" }) + "\n");
  const hooks = await loadPlugin({ charter: true });
  const event = await run(hooks, { sessionID: "ses_thin", system: [], messages: [], model: { id: "test" } });
  const charter = event.system.find((part) => part.text?.includes(CHARTER_MARK));
  assert.ok(charter);
  assert.match(charter.text, /About: Unpacked idea/);
  assert.match(charter.text, /Opening step: write completed — wrote the first draft/);
});
