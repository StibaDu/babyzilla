// Integration probe for the compaction handler itself — the seam the 134
// green tests never touched: v0.7.3 built the visible summary from the
// pre-assembled module list, so the anchor was written to the pack dir but
// never shown to the next reply. These tests load the real plugin with a
// canned distiller and assert on what actually leaves the hook.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import plugin from "../index.js";
import { assemblePack } from "../lib/pack.mjs";
import { anchorModule } from "../lib/anchor.mjs";

const PACK_ROOT = path.join(os.homedir(), ".opencode", "contextpacks", "sessions");

async function loadPlugin(options = {}) {
  options = { calibrate: false, ...options }; // no fake samples in the real root
  const handlers = new Map();
  const distillPrompts = [];
  const ctx = {
    options,
    tool: { hook: async () => {} },
    session: {
      hook: async (name, fn) => { handlers.set(name, fn); },
      context: async () => [],
      get: async () => ({}),
      synthetic: async () => {},
      compact: async () => { throw new Error("test: native compaction must not run"); },
    },
    command: { transform: async () => {} },
    // The "distiller": always answers with a canned module list.
    generate: {
      text: async ({ prompt } = {}) => {
        distillPrompts.push(String(prompt ?? ""));
        return { text: JSON.stringify([
          { kind: "state", name: "00-state", triggers: ["ship", "anchor"], content: "Frozen state: the ship is ready." },
          { kind: "decisions", name: "keep-verbatim", triggers: ["verbatim"], content: "Do not paraphrase the last exchange." },
        ]) };
      },
    },
  };
  await plugin.setup(ctx);
  return { handlers, ctx, distillPrompts };
}

const pad = (chars) => "padding line — ".repeat(Math.ceil(chars / 15));

test("compaction hook: the summary shows the verbatim exchange and the model's hot modules", async () => {
  const sid = "ses_bz_fix_summary";
  await fs.rm(path.join(PACK_ROOT, sid), { recursive: true, force: true });
  try {
    const { handlers } = await loadPlugin();
    // Production shape: the compaction event ends with the user's newest
    // request; the reply it answers sits before it. >4000 estimated tokens
    // so minRawTokens does not bail, distinctive tails on both halves.
    const reply = `${pad(15000)} Shall I proceed with REPLY-VERBATIM-TAIL-Z8X3?`;
    const ask = `${pad(15000)} FINAL INSTRUCTION: keep-ASK-VERBATIM-TAIL-7Q4K`;
    const event = {
      sessionID: sid,
      model: { providerID: "test", id: "test-model" },
      messages: [
        { id: "u0", role: "user", content: [{ type: "text", text: "set up the release pipeline" }] },
        { id: "a0", role: "assistant", content: [{ type: "text", text: reply }] },
        { id: "u1", role: "user", content: [{ type: "text", text: ask }] },
      ],
    };
    await handlers.get("compaction")(event);

    const summary = event.result?.summary ?? "";
    assert.match(summary, /## YOUR LAST EXCHANGE \(verbatim\)/, "anchor section missing from the summary");
    assert.ok(summary.includes("REPLY-VERBATIM-TAIL-Z8X3"), "the reply's tail (the pending question) was cut from the summary");
    assert.ok(summary.includes("keep-ASK-VERBATIM-TAIL-7Q4K"), "the ask's tail was cut from the summary");
    assert.match(summary, /## CURRENT STATE/);
    assert.match(summary, /Frozen state: the ship is ready\./, "hot module content missing from the summary");
    assert.match(summary, /Do not paraphrase the last exchange\./, "decisions content missing from the summary");
    assert.equal(event.result?.metadata?.contextpack?.files, 3, "anchor + 2 model modules expected");

    const dir = path.join(PACK_ROOT, sid);
    const names = (await fs.readdir(dir)).sort();
    assert.deepEqual(names, ["00-anchors.md", "00-state.md", "decisions-keep-verbatim.md", "index.json"]);
    const anchorFile = await fs.readFile(path.join(dir, "00-anchors.md"), "utf8");
    assert.ok(anchorFile.includes("REPLY-VERBATIM-TAIL-Z8X3"));
  } finally {
    await fs.rm(path.join(PACK_ROOT, sid), { recursive: true, force: true });
  }
});

test("assemblePack keeps the anchor even when the anchorless pack wins on a tie", () => {
  const transcript = "tweak the loader why the loader done";
  const parsed = [{ kind: "state", name: "00-state", triggers: ["loader"], content: "Loader tasks only." }];
  const { chosen, forced } = assemblePack({
    parsed, sourceMessages: [
      { role: "assistant", content: "done, why the loader" },
      { role: "user", content: "tweak the loader" },
    ], transcript, rawTokens: 200,
  });
  assert.ok(chosen.some((m) => m.kind === "anchor"), "tie-breaking toward the smaller pack dropped the anchor");
  assert.equal(forced, true, "the anchor should be re-attached, not left to scoring");
  assert.equal(chosen.length, 2);
});

test("anchor budget keeps the reply's tail when both halves fill the budget", () => {
  const reply = `${pad(2400)} Shall I ship? KEEP-REPLY-TAIL-Q5W9?`;
  const ask = `${pad(2400)} KEEP-ASK-HEAD`;
  const anchor = anchorModule([
    { role: "assistant", content: reply },
    { role: "user", content: ask },
  ]);
  assert.ok(anchor, "anchor expected");
  const bound = 2400 + 64;
  assert.ok(anchor.content.length <= bound, `anchor content ${anchor.content.length} exceeds bound ${bound}`);
  assert.ok(anchor.content.includes("KEEP-REPLY-TAIL-Q5W9"), "the reply's ending was trimmed away");
  assert.ok(anchor.content.includes("###"), "structured heading lost");
});

test("huge transcript skips the ranking but still carries the anchor", () => {
  const parsed = [{ kind: "state", name: "00-state", triggers: ["big"], content: "Big transcript." }];
  const big = "x".repeat(600_000);
  const { chosen, picked, forced } = assemblePack({
    parsed,
    sourceMessages: [{ role: "assistant", content: "done" }, { role: "user", content: `summarize ${big}` }],
    transcript: big, rawTokens: 150_000, evalMaxChars: 1000,
  });
  assert.equal(picked, null, "scoring must not run on a huge transcript");
  assert.equal(forced, false, "huge path already includes the anchor");
  assert.ok(chosen.some((m) => m.kind === "anchor"));
});

test("distillAnchors:false and distillRecovered:false disable their modules", () => {
  const parsed = [{ kind: "state", name: "00-state", triggers: ["x"], content: "State." }];
  const a = assemblePack({ parsed, sourceMessages: [{ role: "user", content: "hi" }], transcript: "hi", opts: { distillAnchors: false } });
  assert.equal(a.chosen.some((m) => m.kind === "anchor"), false);
  const b = assemblePack({
    parsed, sourceMessages: [{ role: "user", content: "hi" }], transcript: "hi",
    opts: { evalMaxChars: 0, distillRecovered: true },
  });
  assert.equal(b.missing, null, "recovery must be skipped when scoring is skipped");
});
