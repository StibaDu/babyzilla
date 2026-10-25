// Vision auto-routing (v0.8.0) — hook-level tests against a sandboxed BABYZILLA_ROOT.
// Same isolation pattern as plugin-carryin: env set before the dynamic import;
// node --test gives each file its own process, so the cached ROOT stays ours.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "bz-vision-"));
process.env.BABYZILLA_ROOT = path.join(root, "ctx");
const { default: plugin } = await import("../index.js");

const ROOT = process.env.BABYZILLA_ROOT;
const project = path.join(root, "project-a");
const shotDir = path.join(root, "shots");

async function seedImage(name) {
  await fs.mkdir(shotDir, { recursive: true });
  const p = path.join(shotDir, name);
  // Minimal valid PNG header bytes — existence is all the router checks.
  await fs.writeFile(p, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  return p;
}

function loadPlugin(options = {}, { agents, synthFails } = {}) {
  const handlers = new Map();
  const syntheticCalls = [];
  return plugin
    .setup({
      options,
      tool: { hook: async () => {} },
      session: {
        hook: async (name, fn) => {
          handlers.set(name, fn);
        },
        synthetic: async (input) => {
          if (synthFails) throw new Error("synthetic unavailable");
          syntheticCalls.push(input);
          return { ok: true };
        },
      },
      client: { app: { info: async () => ({ directory: project }) } },
      ...(agents !== undefined
        ? { agent: { list: async () => agents } }
        : {}),
    })
    .then(() => ({ promptHook: handlers.get("prompt"), syntheticCalls }));
}

test("vision-route: image path in text triggers a delegation note", async () => {
  const p = await seedImage("chart-tokens.png");
  const { promptHook, syntheticCalls } = await loadPlugin();
  const ev = { sessionID: "ses_v1", prompt: { text: `look at ${p} and summarize`, files: [] } };
  await promptHook(ev);
  assert.equal(syntheticCalls.length, 1, "exactly one synthetic note");
  const note = syntheticCalls[0].text;
  assert.match(note, /\[babyzilla vision-route\]/);
  assert.ok(note.includes(p), "the note carries the exact path the model cannot guess");
  assert.equal(ev.prompt.files.length, 0, "no module attach — pure routing nudge");
});

test("vision-route: file attachment (file URL) triggers without wording", async () => {
  const p = await seedImage("Screenshot 2026-10-25 at 13.43.25.png");
  const { promptHook, syntheticCalls } = await loadPlugin();
  const ev = {
    sessionID: "ses_v2",
    prompt: { text: "what is this?", files: [{ uri: `file://${p}` }] },
  };
  await promptHook(ev);
  assert.equal(syntheticCalls.length, 1);
  assert.ok(syntheticCalls[0].text.includes(p));
});

test("vision-route: nonexistent path in text is NOT routed (no guessed paths in prompts)", async () => {
  const { promptHook, syntheticCalls } = await loadPlugin();
  const ev = {
    sessionID: "ses_v3",
    prompt: { text: `look at ${shotDir}/nope-missing.png`, files: [] },
  };
  await promptHook(ev);
  assert.equal(syntheticCalls.length, 0, "unverifiable path must never reach the spawn prompt");
});

test("vision-route: explicit delegation wording suppresses the note", async () => {
  const p = await seedImage("already-routed.png");
  const { promptHook, syntheticCalls } = await loadPlugin();
  const ev = {
    sessionID: "ses_v4",
    prompt: { text: `use the vision subagent on ${p}`, files: [] },
  };
  await promptHook(ev);
  assert.equal(syntheticCalls.length, 0, "caller already named the delegate");
});

test("vision-route: opt-out via visionRoute:false", async () => {
  const p = await seedImage("off-switch.png");
  const { promptHook, syntheticCalls } = await loadPlugin({ visionRoute: false });
  const ev = { sessionID: "ses_v5", prompt: { text: `read ${p}`, files: [] } };
  await promptHook(ev);
  assert.equal(syntheticCalls.length, 0);
});

test("vision-route: no vision agent catalogued -> no note, no throw", async () => {
  const p = await seedImage("no-agent.png");
  const { promptHook, syntheticCalls } = await loadPlugin({}, { agents: [{ id: "build" }, { id: "plan" }] });
  const ev = { sessionID: "ses_v6", prompt: { text: `inspect ${p}`, files: [] } };
  await promptHook(ev);
  assert.equal(syntheticCalls.length, 0);
});

test("vision-route: session.synthetic missing (older host) -> no throw", async () => {
  const p = await seedImage("old-host.png");
  const handlers = new Map();
  await plugin.setup({
    options: {},
    tool: { hook: async () => {} },
    session: { hook: async (name, fn) => handlers.set(name, fn) },
    client: { app: { info: async () => ({ directory: project }) } },
    agent: { list: async () => [{ id: "vision" }] },
  });
  const promptHook = handlers.get("prompt");
  const ev = { sessionID: "ses_v7", prompt: { text: `look at ${p}`, files: [] } };
  await promptHook(ev); // must not reject
  assert.ok(true, "bails silently when synthetic is unavailable");
});
after(() => fs.rm(root, { recursive: true, force: true }));
