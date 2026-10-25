// The 2.x cost levers, each pinned by the property that makes it safe:
//  - char-window (dump-shaped outputs) must be deterministic and profitable
//  - the size gate must not page out what an agent acts on immediately
//  - reset telemetry distinguishes provider evictions from our own rewrites
//  - the distiller budget is capped instead of deriving 48K per compaction
import { test } from "node:test";
import assert from "node:assert/strict";
import { compressToolText, applyStableCompression, estTokens, toolPartText } from "../lib/text.mjs";
import { cacheResets } from "../lib/cost.mjs";
import { distillInputBudget } from "../lib/distill.mjs";

// One huge line, like a minified JSON dump: no line-structure to keep.
function dump(chars, seed = "x") {
  const n = Math.ceil(chars / 24);
  const events = [];
  for (let i = 0; i < n; i++) {
    events.push(`{"seq":${i},"drift":${((i * 7919) % 977) / 7},"note":"${seed}${(i * 31) % 100}"}`);
  }
  return `{"events":[${events.join(",")}]}`;
}

const lineBlock = (n, len = 60) =>
  Array.from({ length: n }, (_, i) => `${String(i).padStart(4, "0")}: step(${i}); ${"y".repeat(Math.max(0, len - 15))}`).join("\n");

test("a single-line dump is compressed by the character window", () => {
  const text = dump(120_000);
  const out = compressToolText(text, { headLines: 40, tailLines: 20 });
  assert.ok(out, "was null before the char-window fallback — the live 2%-saving bug");
  assert.ok(
    estTokens(out) < estTokens(text) * 0.2,
    `should cut by >80% of tokens, got ${estTokens(out)} of ${estTokens(text)}`,
  );
  assert.ok(out.startsWith("{\"events\":[{\"seq\":0,"), "head window preserved");
  assert.ok(out.includes("chars folded — not truncation"), "fold note present");
  assert.ok(!out.includes("[ContextPack]"), "marker not inline — the footer belongs to the caller");
});

test("char-window output is byte-stable across invocations", () => {
  const text = dump(80_000);
  const a = compressToolText(text, { headLines: 40, tailLines: 20 });
  const b = compressToolText(text, { headLines: 40, tailLines: 20 });
  assert.equal(a, b);
});

test("kept lines that are themselves huge dumps get folded", () => {
  // 400 normal lines; line 10 sits inside the head-window keep set and is a
  // 60KB single-line blob that matches no structural regex. It must survive
  // (kept) but folded, so a "kept" region can no longer smuggle bulk through.
  const arr = lineBlock(400).split("\n");
  arr[10] = "0010: " + dump(60_000, "blob");
  const text = arr.join("\n");
  const out = compressToolText(text, { headLines: 40, tailLines: 20 });
  assert.ok(out);
  assert.ok(out.includes("0010:"), "line kept");
  assert.ok(out.includes("chars folded — not truncation"), "the blob inside the line got folded");
  assert.ok(
    estTokens(out) < estTokens(text) * 0.35,
    `too big: ${estTokens(out)} of ${estTokens(text)}`,
  );
});

test("small text stays null; anything returned still saves", () => {
  assert.equal(compressToolText(lineBlock(4, 80), { headLines: 40, tailLines: 20 }), null, "tiny text untouched");
  const small = dump(9_000);
  const out = compressToolText(small, { headLines: 40, tailLines: 20 });
  if (out) assert.ok(estTokens(out) < estTokens(small) * 0.8, "any returned rewrite must still save");
});

test("applyStableCompression pages a dump result and stays byte-stable", () => {
  const opts = { toolResultMinTokens: 2000, toolResultHeadLines: 40, toolResultTailLines: 20 };
  const mk = () => [
    { role: "user", content: [{ type: "text", text: "go" }] },
    { role: "assistant", content: [{ type: "tool-result", name: "read", result: { type: "text", value: dump(100_000) } }] },
  ];
  const ref = () => "00000000deadbeef";
  const messages = mk().concat([
    { role: "assistant", content: [{ type: "tool-result", name: "read", result: { type: "text", value: dump(100_000, "z") } }] },
  ]);
  applyStableCompression(messages, opts, ref);
  const first = toolPartText(messages[1].content[0]);
  assert.ok(first.includes("[ContextPack]"), "footer with recall handle present");
  const frozen = first;
  applyStableCompression(messages, opts, ref);
  assert.equal(toolPartText(messages[1].content[0]), frozen, "already-sent part kept byte-identical");
});

test("cacheResets counts every request that re-bills after an eviction", () => {
  const growing = [1, 4, 9, 14, 19].map((k) => ({ cache: k * 1000, in: 5000 }));
  assert.deepEqual(cacheResets(growing), { count: 0, wasted: 0 });
  // The eviction and the next cold request both re-bill uncached input, so
  // both count — the metric is wasted money, not the eviction event alone.
  const withReset = [...growing, { cache: 1500, in: 36_600 }, { cache: 4000, in: 8000 }];
  assert.deepEqual(cacheResets(withReset), { count: 2, wasted: 44_600 });
  assert.deepEqual(cacheResets([]), { count: 0, wasted: 0 });
  assert.deepEqual(cacheResets(null), { count: 0, wasted: 0 });
});

test("distill budget: new 16K default caps big windows, small windows still clamp", () => {
  assert.equal(
    distillInputBudget({ windowTokens: 1_000_000, defaultBudget: 16_000 }), 16_000,
    "48K→16K: one compaction no longer bills 48K uncached",
  );
  assert.equal(
    distillInputBudget({ windowTokens: 20_000, defaultBudget: 16_000 }), 8_000,
    "40%-of-window clamp preserved",
  );
  assert.equal(
    distillInputBudget({ explicit: 48_000, windowTokens: 1_000_000, defaultBudget: 16_000 }), 48_000,
    "explicit distillBudgetTokens override wins",
  );
});
