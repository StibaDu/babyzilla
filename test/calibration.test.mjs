// Token calibration — the measured gap between chars/4 and provider billing.
//
// Three layers, each verifiable without a model:
//   1. the request side records what it *thinks* the request costs;
//   2. the pairing matches those rows to what the provider *billed*;
//   3. the factor only moves a threshold once enough samples back it.
//
// The end-to-end test builds a real OpenCode-shaped SQLite table, so the query
// and the arithmetic are both exercised — no mocks of the thing under test.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  FACTOR_MAX, MIN_SAMPLES, calibrationPath, factorFor, ledgerPath, pairSamples,
  pruneLedger, readCalibration, readLedger, recordRequest, requestEstimate,
  resetCalibration, summarize, toolsEstimate, writeCalibration,
} from "../lib/calibration.mjs";
import { compactMessagesForRequest, estForReal, estimateMessagesTokens, requestBudget } from "../lib/text.mjs";
import { calibrate, renderCalibration, usageRows } from "../bin/babyzilla.mjs";

const tmpRoot = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `bz-cal-${tag}-`));

// ── the request side ────────────────────────────────────────────────────────

test("requestEstimate splits system, messages and tools", () => {
  const event = {
    system: [{ type: "text", text: "s".repeat(400) }],
    messages: [{ role: "user", content: [{ type: "text", text: "m".repeat(800) }] }],
    tools: { read: { description: "t".repeat(400), input: { type: "object" } } },
  };
  const est = requestEstimate(event, { sessionID: "ses_est" });
  assert.equal(est.system, 100);
  assert.equal(est.messages, 200);
  assert.ok(est.tools > 100, "tool schemas are counted, not ignored");
  assert.equal(est.total, est.system + est.messages + est.tools);
});

test("requestEstimate caches the tool estimate per session and re-reads it when tools change", () => {
  const tools = { read: { description: "x".repeat(400) } };
  const first = toolsEstimate("ses_cache", tools);
  assert.ok(first > 0);
  // Same key count, different content: the cache is a fast path, not a diff.
  assert.equal(toolsEstimate("ses_cache", { ...tools }), first);
  // A different tool set has a different key count and must be re-measured.
  const grown = { ...tools, write: { description: "y".repeat(4000) } };
  assert.ok(toolsEstimate("ses_cache", grown) > first * 2);
});

test("requestEstimate survives a malformed event", () => {
  for (const odd of [undefined, null, {}, { system: "no", messages: 5, tools: "no" }]) {
    const est = requestEstimate(odd);
    assert.equal(est.total, 0);
  }
});

test("recordRequest appends JSONL and readLedger skips broken lines", async () => {
  const root = tmpRoot("ledger");
  recordRequest(root, { at: 1000, sid: "ses_a", model: "m", sys: 10, msg: 2000, tools: 0, est: 2010 });
  recordRequest(root, { at: 2000, sid: "ses_a", model: "m", sys: 10, msg: 3000, tools: 0, est: 3010 });
  // A row with no session/time/estimate is not a sample.
  recordRequest(root, { nonsense: true });
  await until(() => readLedger(root).length >= 2);
  fs.appendFileSync(ledgerPath(root), "not json\n");
  const rows = readLedger(root);
  assert.equal(rows.length, 2);
  assert.equal(rows[1].est, 3010);
});

// appendFile is fire-and-forget by design; tests wait for the write, not for a guess.
const flush = () => new Promise((r) => setTimeout(r, 50));
async function until(check, ms = 3_000) {
  const started = Date.now();
  while (Date.now() - started < ms) {
    if (check()) return true;
    await flush();
  }
  return check();
}

// ── pairing ─────────────────────────────────────────────────────────────────

const ledgerRow = (at, sid, est, extra = {}) => ({ at, sid, est, msg: est, sys: 0, tools: 0, ...extra });
const usageRow = (at, sid, billed, model = "m") => ({ at, sid, billed, model });

test("pairSamples pairs each request with the usage row the provider wrote", () => {
  const samples = pairSamples(
    [ledgerRow(1_000, "s1", 10_000), ledgerRow(2_000, "s1", 20_000)],
    [usageRow(1_100, "s1", 13_000), usageRow(2_100, "s1", 26_000)],
  );
  assert.equal(samples.length, 2);
  assert.deepEqual(samples.map((s) => s.ratio), [1.3, 1.3]);
});

test("pairSamples: an aborted request does not shift every later sample", () => {
  // The middle request never produced a billed row (it was interrupted). A naive
  // index pairing would compare request 1 to row 2 and be wrong forever after.
  const samples = pairSamples(
    [ledgerRow(1_000, "s1", 10_000), ledgerRow(20_000, "s1", 10_000), ledgerRow(40_000, "s1", 10_000)],
    [usageRow(1_100, "s1", 13_000), usageRow(40_100, "s1", 26_000)],
  );
  assert.equal(samples.length, 2);
  assert.deepEqual(samples.map((s) => s.ratio), [1.3, 2.6]);
});

test("pairSamples ignores rows outside the window and other sessions", () => {
  assert.equal(pairSamples([ledgerRow(1_000, "s1", 10_000)], [usageRow(999_000, "s1", 1)]).length, 0);
  assert.equal(pairSamples([ledgerRow(1_000, "s1", 10_000)], [usageRow(1_100, "s2", 13_000)]).length, 0);
  assert.equal(pairSamples([], []).length, 0);
});

test("pairSamples is order-independent", () => {
  const samples = pairSamples(
    [ledgerRow(5_000, "s1", 10_000), ledgerRow(1_000, "s1", 10_000)],
    [usageRow(5_100, "s1", 11_000), usageRow(1_100, "s1", 13_000)],
  );
  assert.deepEqual(samples.map((s) => s.ratio), [1.3, 1.1]);
});

// ── the factor ──────────────────────────────────────────────────────────────

test("summarize takes the median per model and leaves thin evidence unapplied", () => {
  const ratios = [1.3, 1.32, 1.28, 1.31, 1.35, 1.29, 1.33, 1.3, 1.27, 1.34, 1.31, 1.3];
  const samples = ratios.map((r, i) => ({
    model: "thick", est: 10_000, billed: 10_000 * r, ratio: r, messages: 9_000, total: 10_000,
  }));
  samples.push({ model: "thin", est: 10_000, billed: 13_000, ratio: 1.3, messages: 9_000, total: 10_000 });
  const s = summarize(samples);
  assert.equal(s.models.thick.samples, 12);
  assert.equal(s.models.thick.applied, true);
  assert.ok(s.models.thick.factor >= 1.3 && s.models.thick.factor <= 1.31, `median ${s.models.thick.factor}`);
  assert.equal(s.models.thin.applied, false);
  assert.equal(s.models.thin.needed, MIN_SAMPLES - 1);
});

test("summarize skips requests dominated by system prompt and tool schemas", () => {
  const small = { model: "m", est: 3_000, billed: 6_000, ratio: 2, messages: 2_900, total: 3_000 };
  const toolHeavy = { model: "m", est: 50_000, billed: 100_000, ratio: 2, messages: 5_000, total: 50_000 };
  const good = { model: "m", est: 50_000, billed: 65_000, ratio: 1.3, messages: 40_000, total: 50_000 };
  const s = summarize([small, toolHeavy, good]);
  assert.equal(s.models.m.samples, 1, "only the message-dominated sample counts");
  assert.equal(s.skipped, 2);
});

test("summarize clamps and counts gross mismatches as outliers", () => {
  const wild = { model: "m", est: 10_000, billed: 90_000, ratio: 9, messages: 9_000, total: 10_000 };
  const many = Array.from({ length: 12 }, () => ({
    model: "m", est: 10_000, billed: 10_000 * 2.5, ratio: 2.5, messages: 9_000, total: 10_000,
  }));
  const s = summarize([wild, ...many]);
  assert.equal(s.outliers, 1);
  assert.equal(s.models.m.factor, FACTOR_MAX, "clamped, not trusted at 2.5");
  assert.equal(s.models.m.clamped, true);
});

test("factorFor tolerates every id shape OpenCode uses", () => {
  const cal = { models: { "deepseek-v4.1-flash": { factor: 1.34, applied: true } } };
  assert.equal(factorFor(cal, "deepseek-v4.1-flash"), 1.34);
  assert.equal(factorFor(cal, "ollama-cloud/deepseek-v4.1-flash"), 1.34);
  assert.equal(factorFor(cal, "deepseek-v4.1-flash:1017"), 1.34);
  assert.equal(factorFor(cal, "deepseek-v4.1-flash#high"), 1.34);
  assert.equal(factorFor(cal, "kimi-k3"), 1);
  assert.equal(factorFor({}, "anything"), 1);
  assert.equal(factorFor(null, null), 1);
});

test("readCalibration round-trips and refuses to apply unmeasured models", () => {
  const root = tmpRoot("round");
  writeCalibration(root, {
    models: {
      applied: { factor: 1.25, samples: 20, applied: true },
      provisional: { factor: 1.4, samples: 3, applied: false },
    },
  });
  const cal = readCalibration(root);
  assert.equal(cal.models.applied.factor, 1.25);
  assert.equal(cal.models.provisional, undefined, "3 samples must not move a threshold");
  assert.equal(factorFor(cal, "applied"), 1.25);
  assert.ok(fs.existsSync(calibrationPath(root)));
  assert.equal(resetCalibration(root), true);
  assert.equal(factorFor(readCalibration(root), "applied"), 1);
});

test("pruneLedger keeps paired samples and recent unpaired ones only", () => {
  const root = tmpRoot("prune");
  const now = Date.now();
  const rows = [
    { at: now - 60_000, sid: "s1", est: 10_000 },                    // paired, recent
    { at: now - 8 * 86_400_000, sid: "s1", est: 10_000 },            // paired, ancient
    { at: now - 2 * 86_400_000, sid: "s2", est: 10_000 },            // unpaired, stale
    { at: now - 60_000, sid: "s3", est: 10_000 },                    // unpaired, fresh
  ];
  fs.mkdirSync(path.dirname(ledgerPath(root)), { recursive: true });
  fs.writeFileSync(ledgerPath(root), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const samples = [{ sid: "s1", at: rows[0].at }, { sid: "s1", at: rows[1].at }];
  assert.equal(pruneLedger(root, samples), 2);
  const kept = readLedger(root);
  assert.deepEqual(kept.map((r) => r.sid).sort(), ["s1", "s3"]);
});

test("readCalibration ignores a corrupt file instead of throwing", () => {
  const root = tmpRoot("corrupt");
  fs.writeFileSync(calibrationPath(root), "{ not json");
  assert.deepEqual(readCalibration(root).models, {});
});

// ── the factor actually moves the thresholds ────────────────────────────────

test("estForReal converts provider tokens into estimate space", () => {
  assert.equal(estForReal(45_000, 1), 45_000);
  assert.equal(estForReal(45_000, 1.25), 36_000);
  assert.equal(estForReal(45_000, 0), 45_000, "a broken factor must not be a divisor");
  assert.equal(estForReal(45_000, Number.NaN), 45_000);
  assert.equal(estForReal(Infinity, 1.3), Infinity);
});

test("requestBudget scales the cap and floor by the measured factor", () => {
  const plain = requestBudget({ before: 100_000, opts: {} });
  assert.equal(plain.hardCap, 45_000);
  assert.equal(plain.factor, 1);
  const corrected = requestBudget({ before: 100_000, opts: { tokenFactor: 1.5 } });
  assert.equal(corrected.hardCap, 30_000);
  assert.equal(corrected.minBudget, 8_000);
});

test("a measured factor compresses a request the default would let through", () => {
  // 10 messages × ~1.7K estimated tokens ≈ 17K: above the 20K "don't bother"
  // floor? No — that is the point. With a factor of 1.5 the floor is 13.3K
  // provider tokens, so the same request is one the provider would really charge
  // more than 20K for, and it gets compressed.
  const messages = [];
  for (let i = 0; i < 10; i++) {
    messages.push({
      id: `m${i}`,
      role: "assistant",
      content: [{ type: "tool-result", id: `c${i}`, name: "read", result: { type: "text", value: "a".repeat(6_800) } }],
    });
  }
  const plain = structuredClone(messages);
  const plainStats = compactMessagesForRequest(plain, { stablePrefix: false });
  assert.ok(plainStats.before > 16_000 && plainStats.before < 20_000, `fixture is ${plainStats.before}`);
  assert.equal(plainStats.saved, 0, "under the default floor: left alone");

  const corrected = structuredClone(messages);
  const fixedStats = compactMessagesForRequest(corrected, { stablePrefix: false, tokenFactor: 1.5 });
  assert.ok(fixedStats.saved > 0, "the provider really would have charged more than the floor");
});

// ── end to end: real SQLite table, real ledger ──────────────────────────────

function makeDb(file, rows) {
  const db = new DatabaseSync(file);
  db.exec("create table session_message (id text, session_id text, type text, seq integer, time_created integer, time_updated integer, data text)");
  const insert = db.prepare("insert into session_message (id, session_id, type, seq, time_created, data) values (?, ?, ?, ?, ?, ?)");
  rows.forEach((r, i) => {
    insert.run(`msg_${i}`, r.sid, "assistant", i, r.at, JSON.stringify({
      model: { id: r.model, providerID: "test" },
      tokens: { input: r.billed - r.cached, output: 100, cache: { read: r.cached } },
    }));
  });
  db.close();
}

test("calibrate pairs the ledger with billed usage and writes the factor", async () => {
  const root = tmpRoot("e2e");
  const dbPath = path.join(root, "opencode.db");
  const base = Date.now() - 60_000;
  const rows = [];
  for (let i = 0; i < 14; i++) {
    const at = base + i * 5_000;
    recordRequest(root, { at, sid: "ses_e2e", model: "deepseek-v4.1-flash:1017", sys: 2_000, msg: 40_000, tools: 8_000, est: 50_000 });
    rows.push({ at: at + 400, sid: "ses_e2e", model: "deepseek-v4.1-flash:1017", billed: 65_000, cached: 30_000 });
  }
  makeDb(dbPath, rows);
  await until(() => readLedger(root).length >= 14);

  const dry = calibrate({ root, dbPath, dry: true });
  assert.ok(dry.samples >= 13, `paired ${dry.samples} of ${dry.ledger}`);
  assert.equal(dry.models["deepseek-v4.1-flash:1017"].factor, 1.3);
  assert.equal(fs.existsSync(calibrationPath(root)), false, "--dry must not write");

  const real = calibrate({ root, dbPath });
  assert.equal(real.dry, false);
  assert.equal(readCalibration(root).models["deepseek-v4.1-flash:1017"].factor, 1.3);
  assert.equal(factorFor(readCalibration(root), "deepseek-v4.1-flash"), 1.3);
  assert.match(renderCalibration(real), /×1\.30/);
});

test("calibrate says so instead of inventing a factor from nothing", () => {
  const root = tmpRoot("empty");
  const r = calibrate({ root, dbPath: path.join(root, "missing.db") });
  assert.equal(r.samples, 0);
  assert.deepEqual(r.models, {});
  assert.match(renderCalibration(r), /No samples recorded yet/);
});

test("usageRows reads input+cache as the billed prompt, and tolerates junk", () => {
  const root = tmpRoot("usage");
  const dbPath = path.join(root, "opencode.db");
  const db = new DatabaseSync(dbPath);
  db.exec("create table session_message (id text, session_id text, type text, seq integer, time_created integer, time_updated integer, data text)");
  const insert = db.prepare("insert into session_message values (?, ?, ?, ?, ?, ?, ?)");
  insert.run("a", "s1", "assistant", 0, 5000, 0, JSON.stringify({ model: { id: "m" }, tokens: { input: 900, cache: { read: 100 } } }));
  insert.run("b", "s1", "assistant", 1, 6000, 0, "{ not json");
  insert.run("c", "s1", "user", 2, 7000, 0, JSON.stringify({ text: "hi" }));
  insert.run("d", "s1", "assistant", 3, 8000, 0, JSON.stringify({ model: { id: "m" }, tokens: { input: 0, cache: { read: 0 } } }));
  db.close();

  const rows = usageRows({ dbPath });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].billed, 1000, "input is the uncached part, cache.read the prefix");
  assert.equal(rows[0].model, "m");
  assert.deepEqual(usageRows({ dbPath: path.join(root, "nope.db") }), []);
});

// ── plugin wiring ───────────────────────────────────────────────────────────

// Sandboxed root: the recorder must never write into a developer's real
// contextpacks directory when the suite runs.
const pluginRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bz-cal-plugin-"));
process.env.BABYZILLA_ROOT = path.join(pluginRoot, "ctx");
const { default: plugin } = await import("../index.js");

async function loadPlugin(options = {}) {
  const handlers = new Map();
  await plugin.setup({
    options,
    tool: { hook: async () => {} },
    session: {
      hook: async (name, fn) => {
        if (!handlers.has(name)) handlers.set(name, []);
        handlers.get(name).push(fn);
      },
      context: async () => [],
    },
    client: { app: { info: async () => ({ directory: pluginRoot }) } },
  });
  return handlers;
}

test("the plugin records one sample per request, with system and tools counted", async () => {
  const handlers = await loadPlugin();
  const compressionHook = handlers.get("context").at(-1);
  const event = {
    sessionID: "ses_wire",
    model: { id: "deepseek-v4.1-flash:1017", limit: { context: 128_000 } },
    system: [{ type: "text", text: "s".repeat(400) }],
    tools: { read: { description: "t".repeat(400) } },
    messages: [{ role: "user", content: [{ type: "text", text: "m".repeat(800) }] }],
  };
  await compressionHook(event);
  await until(() => readLedger(process.env.BABYZILLA_ROOT).some((r) => r.sid === "ses_wire"));
  const rows = readLedger(process.env.BABYZILLA_ROOT).filter((r) => r.sid === "ses_wire");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].sys, 100);
  assert.equal(rows[0].msg, 200);
  assert.ok(rows[0].tools > 0);
  assert.equal(rows[0].est, rows[0].sys + rows[0].msg + rows[0].tools);
  assert.equal(rows[0].model, "deepseek-v4.1-flash:1017");
});

test("the sample describes the payload after compression, not before it", async () => {
  const handlers = await loadPlugin();
  const compressionHook = handlers.get("context").at(-1);
  const messages = [{ role: "user", content: [{ type: "text", text: "task" }] }];
  for (let i = 0; i < 8; i++) {
    messages.push({
      role: "assistant",
      content: [{ type: "tool-result", id: `c${i}`, name: "read", result: { type: "text", value: numbered(4000) } }],
    });
  }
  const event = { sessionID: "ses_wire2", model: { id: "m", limit: { context: 200_000 } }, messages };
  const before = (await import("../lib/text.mjs")).estimateMessagesTokens(event.messages);
  await compressionHook(event);
  const after = (await import("../lib/text.mjs")).estimateMessagesTokens(event.messages);
  assert.ok(after < before, "the fixture must actually be compressed");
  await until(() => readLedger(process.env.BABYZILLA_ROOT).some((r) => r.sid === "ses_wire2"));
  const row = readLedger(process.env.BABYZILLA_ROOT).find((r) => r.sid === "ses_wire2");
  assert.equal(row.msg, after, "recording the pre-compression size would inflate every ratio");
});

function numbered(n) {
  return Array.from({ length: n }, (_, i) => `${i + 1}:   step(${i});`).join("\n");
}

test("the learned factor is what the compression hook actually uses", async () => {
  // Same 17K fixture as the unit test above, but through the plugin: the
  // written calibration.json must reach compactMessagesForRequest unchanged.
  writeCalibration(process.env.BABYZILLA_ROOT, {
    models: { m: { factor: 1.5, samples: 20, applied: true } },
  });
  const handlers = await loadPlugin({ stablePrefix: false });
  const hook = handlers.get("context").at(-1);
  const messages = [];
  for (let i = 0; i < 10; i++) {
    messages.push({
      role: "assistant",
      content: [{ type: "tool-result", id: `c${i}`, name: "read", result: { type: "text", value: "a".repeat(6_800) } }],
    });
  }
  const event = { sessionID: "ses_factor", model: { id: "m", limit: { context: 200_000 } }, messages };
  const before = estimateMessagesTokens(event.messages);
  assert.ok(before > 16_000 && before < 20_000, `fixture is ${before}`);
  await hook(event);
  assert.ok(estimateMessagesTokens(event.messages) < before, "×1.5 puts it over the factored floor");
  resetCalibration(process.env.BABYZILLA_ROOT);
});
