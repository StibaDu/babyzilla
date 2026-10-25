// Headless / cold-project safety: the prompt hook must return quietly when
// there is no session index to attach from. It used to throw
// "null is not an object (evaluating 'idx.modules')" on every prompt in such
// sessions (e.g. `opencode run --standalone`), which the plugin logged as a
// non-fatal hook failure.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "bz-noindex-"));
process.env.BABYZILLA_ROOT = path.join(root, "ctx");
const { default: plugin } = await import("../index.js");

const project = path.join(root, "cold-project");
await fs.mkdir(project, { recursive: true });

function loadPlugin(options = {}) {
  const handlers = new Map();
  return plugin
    .setup({
      options,
      tool: { hook: async () => {} },
      session: { hook: async (name, fn) => { handlers.set(name, fn); } },
      client: { app: { info: async () => ({ directory: project }) } },
    })
    .then(() => handlers.get("prompt"));
}

test("no index, library off: prompt hook returns without throwing", async () => {
  const promptHook = await loadPlugin({ library: false, carryIn: false });
  const ev = {
    sessionID: "ses_noindex_1",
    model: { providerID: "ollama-cloud", id: "glm-5.2" },
    prompt: { text: "read the files in survey/ and tell me the KESTREL code", files: [] },
  };
  // Must not reject: a rejected hook aborts the attach path for the session.
  await assert.doesNotReject(() => promptHook(ev));
});

test("no index, library on but empty: prompt hook returns without throwing", async () => {
  const promptHook = await loadPlugin({ library: true, carryIn: true });
  const ev = {
    sessionID: "ses_noindex_2",
    model: { providerID: "ollama-cloud", id: "glm-5.2" },
    prompt: { text: "summarise this repo", files: [] },
  };
  await assert.doesNotReject(() => promptHook(ev));
});
