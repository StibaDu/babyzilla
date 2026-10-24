// Carry-in (v0.7.6) — hook-level tests against a sandboxed BABYZILLA_ROOT.
// The plugin caches ROOT per module evaluation, so the env must be set before
// the dynamic import; the sibling file's static import must stay untouched.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "bz-carryin-"));
process.env.BABYZILLA_ROOT = path.join(root, "ctx");
const { default: plugin } = await import("../index.js");
const { dirSlug } = await import("../lib/distill.mjs");

const ROOT = process.env.BABYZILLA_ROOT;
const project = path.join(root, "project-a");
const libSlug = dirSlug(project);
const libDir = path.join(ROOT, "library", libSlug);

async function seedLibrary(hot = true) {
  await fs.mkdir(libDir, { recursive: true });
  await fs.writeFile(path.join(libDir, "00-state.md"), "# 00-state\n\nCARRYIN-STATE-MARKER ships.\n");
  await fs.writeFile(path.join(libDir, "decisions-x.md"), "# decisions\n\n- CARRYIN-DECISION-MARKER.\n");
  await fs.writeFile(path.join(libDir, "tool-git.md"), "# tool-git\n\n#1 · git status · ok · 90 tok · recall x\n");
  const modules = [
    { name: "00-state", kind: "state", hot, file: "00-state.md", tokens: 40 },
    { name: "decisions-x", kind: "decisions", hot, file: "decisions-x.md", tokens: 30 },
    { name: "tool-git", kind: "tool", file: "tool-git.md", tokens: 120 },
  ];
  await fs.writeFile(
    path.join(libDir, "index.json"),
    JSON.stringify({ projectDir: project, updated: new Date().toISOString(), modules }),
  );
}

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

test("carry-in: first prompt attaches hot modules trigger-free, once only", async () => {
  await seedLibrary();
  const promptHook = await loadPlugin({ carryIn: true });
  const sid = "ses_carryin_once";
  const ev = { sessionID: sid, prompt: { text: "ok go", files: [] } };
  await promptHook(ev);

  const names = ev.prompt.files.map((f) => path.basename(f.uri));
  assert.deepEqual(names.sort(), ["00-state.md", "decisions-x.md"], "carry set = hot state+decisions; tool rows stay keyword-gated");
  await fs.access(path.join(ROOT, "sessions", sid, ".carryin"));
  assert.ok(true, "the once-only stamp must exist");

  const ev2 = { sessionID: sid, prompt: { text: "follow-up ask", files: [] } };
  await promptHook(ev2);
  assert.equal(ev2.prompt.files.length, 0, "stamp blocks re-carry on later prompts");
});

test("carry-in off / library empty: prompt hook stays a no-op, never throws", async () => {
  await fs.rm(libDir, { recursive: true, force: true });
  const promptHook = await loadPlugin({ carryIn: true });
  const ev = { sessionID: "ses_carryin_nolib", prompt: { text: "anything", files: [] } };
  await promptHook(ev);
  assert.equal(ev.prompt.files.length, 0);

  const promptHookOff = await loadPlugin({ carryIn: false });
  await seedLibrary();
  const ev2 = { sessionID: "ses_carryin_off", prompt: { text: "ok go", files: [] } };
  await promptHookOff(ev2);
  assert.equal(ev2.prompt.files.length, 0, "opt-in is off by default — nothing attaches");
  await fs.rm(root, { recursive: true, force: true });
});
