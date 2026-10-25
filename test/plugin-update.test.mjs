// Daily update notice at the hook level: one synthetic note per day, only when
// the cached verdict says a newer release exists.
//
// Sandboxed ROOT (same pattern as plugin-carryin / plugin-vision-route); the
// background network check points at a dead local port so tests never touch
// GitHub and the failure path is the one being exercised.
import test, { before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// test/run.mjs disables the feature for the suite; this file is the one that
// exercises it, against a dead local port instead of GitHub.
delete process.env.BABYZILLA_NO_UPDATE_CHECK;

const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "bz-upd-plugin-"));
process.env.BABYZILLA_ROOT = path.join(sandbox, "ctx");
process.env.BABYZILLA_UPDATE_URL = "http://127.0.0.1:9/latest";
const { default: plugin } = await import("../index.js");

const ROOT = process.env.BABYZILLA_ROOT;
const cacheFile = path.join(ROOT, "update.json");

async function seed(overrides = {}) {
  await fs.mkdir(ROOT, { recursive: true });
  const cache = {
    ts: Date.now(),
    ok: true,
    current: "0.11.2",
    latest: "0.99.0",
    url: "https://example.test/rel",
    newer: true,
    error: null,
    ...overrides,
  };
  await fs.writeFile(cacheFile, JSON.stringify(cache, null, 2) + "\n");
  return cache;
}

async function loadPlugin(options = {}) {
  const handlers = new Map();
  const synthetic = [];
  await plugin.setup({
    options,
    tool: { hook: async () => {} },
    session: {
      hook: async (name, fn) => { handlers.set(name, fn); },
      synthetic: async (input) => { synthetic.push(input); return { ok: true }; },
    },
    client: { app: { info: async () => ({ directory: path.join(sandbox, "project") }) } },
  });
  return { promptHook: handlers.get("prompt"), synthetic };
}

const prompt = (sid = "ses_upd1") => ({ sessionID: sid, prompt: { text: "hello there", files: [] } });

test("a newer cached release produces exactly one note, then stays quiet all day", async () => {
  await seed();
  const { promptHook, synthetic } = await loadPlugin();
  assert.equal(typeof promptHook, "function");

  await promptHook(prompt());
  assert.equal(synthetic.length, 1, "one note on the first prompt of the day");
  assert.match(synthetic[0].text, /\[babyzilla update\]/);
  assert.match(synthetic[0].text, /v0\.99\.0/);
  assert.match(synthetic[0].text, /installed 0\.11\.2/);
  assert.match(synthetic[0].text, /ask whether they want to update/i);
  assert.equal(synthetic[0].sessionID, "ses_upd1");

  // A second prompt (and a second session) the same day must not nag.
  await promptHook(prompt("ses_upd1"));
  await promptHook(prompt("ses_upd2"));
  assert.equal(synthetic.length, 1);

  const cache = JSON.parse(await fs.readFile(cacheFile, "utf8"));
  assert.ok(cache.noticedTs > 0, "the notice stamp is persisted");
});

test("an offline background check never hides a known update", async () => {
  // Stale by a day: this is the run where setup actually tries the network.
  await seed({ ts: Date.now() - 25 * 3600_000 });
  const { promptHook, synthetic } = await loadPlugin();
  // Give the fire-and-forget check (dead port, connection refused) time to fail.
  await new Promise((r) => setTimeout(r, 300));
  const cache = JSON.parse(await fs.readFile(cacheFile, "utf8"));
  assert.ok(cache.failTs > 0, "the failure was recorded");
  assert.equal(cache.newer, true, "the last good verdict survived");

  await promptHook(prompt("ses_upd3"));
  assert.equal(synthetic.length, 1);
});

test("no note when the cached verdict says current", async () => {
  await seed({ latest: "0.11.2", newer: false });
  const { promptHook, synthetic } = await loadPlugin();
  await promptHook(prompt("ses_upd4"));
  assert.equal(synthetic.length, 0);
});

test("checkUpdates:false silences the note and the check", async () => {
  await seed();
  const { promptHook, synthetic } = await loadPlugin({ checkUpdates: false });
  await promptHook(prompt("ses_upd5"));
  assert.equal(synthetic.length, 0);
});

test("BABYZILLA_NO_UPDATE_CHECK=1 is an absolute kill switch", async () => {
  await seed();
  process.env.BABYZILLA_NO_UPDATE_CHECK = "1";
  try {
    const { promptHook, synthetic } = await loadPlugin();
    await promptHook(prompt("ses_upd6"));
    assert.equal(synthetic.length, 0);
  } finally {
    delete process.env.BABYZILLA_NO_UPDATE_CHECK;
  }
});

before(async () => {
  await fs.mkdir(ROOT, { recursive: true });
});
