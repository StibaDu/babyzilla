// Prompt-hook integration: once a session has its own pack, the project
// library is still a candidate — but only as a replacement. The old selection
// is the ceiling, so these tests assert the prompt never grows.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "bz-memory-attach-"));
process.env.BABYZILLA_ROOT = path.join(root, "ctx");
process.env.BABYZILLA_NO_UPDATE_CHECK = "1";
const { default: plugin } = await import("../index.js");
const { dirSlug } = await import("../lib/distill.mjs");

const ROOT = process.env.BABYZILLA_ROOT;
const project = path.join(root, "project-a");
const sid = "ses_memory_attach";
const libDir = path.join(ROOT, "library", dirSlug(project));

after(() => fs.rm(root, { recursive: true, force: true }));

async function seed() {
  const sessionDir = path.join(ROOT, "sessions", sid);
  await fs.mkdir(sessionDir, { recursive: true });
  await fs.writeFile(path.join(sessionDir, "index.json"), JSON.stringify({
    sessionID: sid,
    created: "2026-10-20T10:00:00.000Z",
    projectDir: project,
    modules: [
      { name: "errors-current", kind: "errors", file: "errors-current.md", tokens: 50, triggers: ["gateway", "econnreset"] },
      { name: "topic-current", kind: "topic", file: "topic-current.md", tokens: 50, triggers: ["ledger"] },
    ],
  }));
  await fs.writeFile(path.join(sessionDir, "errors-current.md"), "# current errors\n");
  await fs.writeFile(path.join(sessionDir, "topic-current.md"), "# current topic\n");

  await fs.mkdir(libDir, { recursive: true });
  await fs.writeFile(path.join(libDir, "index.json"), JSON.stringify({
    projectDir: project,
    updated: "2026-10-19T10:00:00.000Z",
    modules: [
      { name: "errors-old", kind: "errors", file: "lib-errors-old.md", tokens: 40, triggers: ["gateway", "econnreset"] },
      { name: "topic-old", kind: "topic", file: "lib-topic-old.md", tokens: 30, triggers: ["kestrel"] },
    ],
  }));
  await fs.writeFile(path.join(libDir, "lib-errors-old.md"), "# library errors\n");
  await fs.writeFile(path.join(libDir, "lib-topic-old.md"), "# library topic\n");
}

async function loadPromptHook(options = {}) {
  const handlers = new Map();
  await plugin.setup({
    options: { library: true, carryIn: false, calibrate: false, ...options },
    tool: { hook: async () => {} },
    session: {
      hook: async (name, fn) => { handlers.set(name, fn); },
      synthetic: async () => {},
    },
    client: { app: { info: async () => ({ directory: project }) } },
  });
  return handlers.get("prompt");
}

const basenames = (event) => event.prompt.files.map((file) =>
  path.basename(decodeURIComponent(new URL(file.uri).pathname)));

test("a matching library row replaces a session row without growing the prompt", async () => {
  await seed();
  const promptHook = await loadPromptHook();
  const event = { sessionID: sid, prompt: { text: "gateway econnreset", files: [] } };
  await promptHook(event);

  assert.deepEqual(basenames(event), ["lib-errors-old.md"]);
  const sessionOnly = 50; // errors-current matched before the merge
  const merged = 40;
  assert.ok(merged <= sessionOnly, `${merged} must not exceed ${sessionOnly}`);
  assert.ok(!basenames(event).includes("errors-current.md"), "the session row was displaced");
});

test("a prompt with no session match attaches nothing, even when the library matches", async () => {
  const promptHook = await loadPromptHook();
  const event = { sessionID: sid, prompt: { text: "kestrel", files: [] } };
  await promptHook(event);
  assert.deepEqual(event.prompt.files, [], "zero-to-one would increase prompt tokens");
});

test("library off keeps the session-only selection unchanged", async () => {
  const promptHook = await loadPromptHook({ library: false });
  const event = { sessionID: sid, prompt: { text: "ledger", files: [] } };
  await promptHook(event);
  assert.deepEqual(basenames(event), ["topic-current.md"]);
});
