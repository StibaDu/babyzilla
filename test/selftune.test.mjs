// The self-tuning loop's contracts, without touching the network or the bench:
//
//   · only numeric, clamped, allowlisted knobs can ever be applied
//   · every proposal → provisional apply → keep/revert transition is written
//     to state.json + ledger.jsonl (nothing happens silently)
//   · a bench verdict is judged on marker success, work parity and a paired
//     cost delta above the measured noise floor
//   · live quality signals (recall storms) revert a provisional knob without
//     waiting for a bench
//
// All file IO is sandboxed under a temp BABYZILLA-style root; the DB lookup is
// pointed at a nonexistent path so no host database is read.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  KNOBS, MAX_STEP_PCT,
  readState, writeState, appendLedger, emptyState,
  clampValue, validProposal, allowlistFor, applyOverrides,
  createSelftune, buildSummaryData, noteRecallRendered,
  judgeVerify, verifyPlan, noiseFloor, resolveVerify, manualRevert,
} from "../lib/selftune.mjs";
import { SELF_LEARN_INSTRUCTIONS, buildAnalysisPrompt, parseAnalysis } from "../lib/analyze.mjs";

let TMP;
function freshRoot() {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), "bz-selftune-"));
  return TMP;
}
const stFile = (root) => path.join(root, "selftune", "state.json");
const ledger = (root) => {
  try { return fs.readFileSync(path.join(root, "selftune", "ledger.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); }
  catch { return []; }
};

let seed = 42_000;
const nextSid = () => `ses_test${(seed++).toString(36)}`;

beforeEach(() => {
  delete process.env.BABYZILLA_SELFTUNE_DISABLE;
  freshRoot();
});
afterEach(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* win file locks */ }
});

const OPTS_BASE = () => ({
  stableMinTokens: 2000,
  toolResultHeadLines: 40,
  distillBudgetDefault: 16_000,
  selfLearn: true,
});

// ── knob validation ─────────────────────────────────────────────────────────

test("clamps hold proposals inside absolute bounds and coerce ints", () => {
  assert.equal(clampValue("stableMinTokens", 100), KNOBS.stableMinTokens.min);
  assert.equal(clampValue("stableMinTokens", 99_000), KNOBS.stableMinTokens.max);
  assert.equal(clampValue("stableMinTokens", 1800.6), 1801);
  assert.equal(clampValue("not-a-knob", 5), null);
  assert.equal(clampValue("stableMinTokens", "2000"), null, "strings are not values");
});

test("validProposal: unknown knob, non-allowlisted knob, oversized step, then ok", () => {
  const allow = allowlistFor({});
  assert.ok(!allow.includes("requestBudgetTokens"), "the hard budget must not be auto-tunable");
  const ok = validProposal({ knob: "stableMinTokens", to: 1800 }, { allow, from: 2000 });
  assert.deepEqual(ok, { ok: true, value: 1800 });
  const unknown = validProposal({ knob: "requestTargetRatio", to: 0.1 }, { allow, from: 0.08 });
  assert.ok(!unknown.ok);
  const excluded = validProposal({ knob: "stableMinTokens", to: 1800 }, { allow: ["toolResultHeadLines"], from: 2000 });
  assert.ok(!excluded.ok);
  const big = validProposal({ knob: "stableMinTokens", to: 2000 - Math.ceil(2000 * (MAX_STEP_PCT / 100)) - 1 }, { allow, from: 2000 });
  assert.ok(!big.ok, "a step beyond the cap must be rejected");
});

test("applyOverrides merges verified/nested knobs onto live options and is idempotent", () => {
  const opts = OPTS_BASE();
  const st = emptyState();
  st.knobs = { stableMinTokens: 1800, toolResultHeadLines: 50 };
  applyOverrides(opts, st);
  assert.equal(opts.stableMinTokens, 1800);
  assert.equal(opts.toolResultHeadLines, 50);
  const logLines = [];
  const again = applyOverrides(opts, st, (m) => logLines.push(m));
  assert.equal(again.length, 0, "re-applying the same values is a no-op");
  assert.equal(logLines.length, 0);
});

// ── analysis contract ───────────────────────────────────────────────────────

test("parseAnalysis accepts the exact contract and rejects everything else", () => {
  const p = parseAnalysis('{"knob":"stableMinTokens","to":1800,"rationale":"2K cluster keeps re-billing"}');
  assert.deepEqual(p, { ok: true, kind: "proposal", knob: "stableMinTokens", to: 1800, rationale: "2K cluster keeps re-billing" });
  const n = parseAnalysis('```json\n{"noop":true,"rationale":"evidence thin"}\n```');
  assert.deepEqual(n, { ok: true, kind: "noop", rationale: "evidence thin" });
  const embedded = parseAnalysis('my answer:\n{"knob":"toolResultHeadLines","to":50, "rationale":"" }');
  assert.ok(embedded.ok && embedded.knob === "toolResultHeadLines");
  const bad = parseAnalysis("I would suggest raising stableMinTokens…");
  assert.ok(!bad.ok);
  const noTo = parseAnalysis('{"knob":"stableMinTokens","rationale":"forgot the number"}');
  assert.ok(!noTo.ok);
  const unknown = parseAnalysis('{"knob":"requestModel","to":1}');
  assert.ok(unknown.ok, "parse stays format-level; the knob table rejects this one later");
});

test("the analysis prompt carries knobs+clamps+sessions and demands one-line JSON", () => {
  const prompt = buildAnalysisPrompt({
    summary: {
      sessions: [{ sid: nextSid(), turns: 12, requests: 20, tokens: { input: 90, cached: 130, output: 9 }, cost: 0.021, resets: 1, recalls: 2, repeats: [{ tool: "read", n: 2, head: "x" }], compress: [{ tool: "read", n: 5, saved: 5000 }], model: "ollama-cloud/deepseek-v4.1-flash" }],
      ledger: [{ kind: "apply", knob: "stableMinTokens", from: 2000, to: 1800 }],
    },
    knobs: { stableMinTokens: 2000 },
    clamps: { stableMinTokens: KNOBS.stableMinTokens },
    noiseFloorPct: 2.5,
  });
  assert.ok(prompt.includes("stableMinTokens: current=2000 min=800 max=6000"));
  assert.ok(prompt.includes("Noise floor") && prompt.includes("2.5%"));
  assert.ok(prompt.includes("cost=$0.0210") && prompt.includes("recalls=2") && prompt.includes("paged=read:5x-5.0K"));
  assert.ok(prompt.includes('{"noop":true'));
  assert.ok((prompt.match(/Respond with EXACTLY ONE JSON object/g) ?? []).length === 1);
  assert.ok(SELF_LEARN_INSTRUCTIONS.length > 200);
});

// ── the cycle end-to-end with a fake model ──────────────────────────────────

function seedSessions(root, n) {
  fs.mkdirSync(path.join(root, "selftune"), { recursive: true });
  const lines = [];
  for (let i = 0; i < n; i++) {
    lines.push(JSON.stringify({
      t: Date.now() - (n - i) * 3600_000, sid: nextSid(), turns: 10 + i, requests: 5,
      tokens: { input: 10_000, cached: 90_000, output: 1_000 }, cost: 0.004 + i * 0.001,
      resets: i % 2, recalls: 0, repeats: [], compress: [{ tool: "read", n: 4, saved: 3000 }],
    }));
  }
  fs.writeFileSync(path.join(root, "selftune", "sessions.jsonl"), lines.join("\n") + "\n");
}

function makeInstance(root, opts = {}) {
  const options = { ...OPTS_BASE(), ...opts };
  const logs = [];
  const inst = createSelftune({
    root,
    opts: options,
    log: (m) => logs.push(String(m)),
    dbPath: path.join(root, "does-not-exist.db"), // cost lookup bails: no host DB
    repoDir: path.dirname(TMP),
  });
  return { inst, options, logs };
}

async function pendingCycleResult(root, callText) {
  seedSessions(root, 4);
  writeState(root, { ...emptyState(), lastTs: {} });
  return callText;
}

test("cycle: valid proposal is applied provisionally (state + options + ledger)", async () => {
  const callText = await pendingCycleResult(TMP, () => '{"knob":"stableMinTokens","to":1800,"rationale":"steady-state 2-4K tail"}');
  const { inst, options, logs } = makeInstance(TMP);
  const res = await inst.maybeCycle({ sessionID: nextSid(), callText });
  assert.equal(res.status, "applied", `status=${res.status} reason=${res.reason}`);
  assert.equal(res.knob, "stableMinTokens");
  assert.equal(options.stableMinTokens, 1800, "the running plugin sees the change immediately");
  const st = readState(TMP);
  assert.equal(st.knobs.stableMinTokens, 1800);
  assert.equal(st.pending?.to, 1800);
  assert.equal(st.counts.applied, 1);
  assert.ok(ledger(TMP).some((e) => e.kind === "apply" && e.knob === "stableMinTokens" && e.provisional === true));
  assert.ok(logs.some((l) => l.includes("applied stableMinTokens 2000 → 1800")));
});

test("cycle: noop and unparseable output are recorded, never silently dropped", async () => {
  await pendingCycleResult(TMP, null);
  const { inst } = makeInstance(TMP);
  const noop = await inst.maybeCycle({ sessionID: nextSid(), callText: () => '{"noop":true,"rationale":"not enough signal"}' });
  assert.equal(noop.status, "noop");
  assert.ok(ledger(TMP).some((e) => e.kind === "noop" && e.reason === undefined));

  const stAfterNoop = readState(TMP);
  stAfterNoop.lastTs = {}; // re-arm the interval gate
  writeState(TMP, stAfterNoop);

  const fail = await inst.maybeCycle({ sessionID: nextSid(), callText: () => "absolutely not JSON" });
  assert.equal(fail.status, "analysis-failed");
  assert.ok(ledger(TMP).some((e) => e.kind === "analysis-fail"));
  assert.equal(readState(TMP).pending, null);
});

test("cycle: out-of-bounds or oversized proposals are rejected before apply", async () => {
  await pendingCycleResult(TMP, null);
  const { inst } = makeInstance(TMP);
  const res = await inst.maybeCycle({ sessionID: nextSid(), callText: () => '{"knob":"stableMinTokens","to":250,"rationale":"why not tiny"}' });
  assert.equal(res.status, "rejected");
  const st = readState(TMP);
  assert.equal(st.pending, null);
  assert.ok(ledger(TMP).some((e) => e.kind === "proposal-rejected" && e.reason.includes("cap")));
  assert.ok(!st.knobs.stableMinTokens, "no knob leaked into state");
});

test("cycle: trigger gates (sessions count, interval, env freeze) all hold", async () => {
  seedSessions(TMP, 2);
  const { inst } = makeInstance(TMP);
  // 2 finalized sessions < selfLearnSessions(4): the analysis must not run
  const r1 = await inst.maybeCycle({ sessionID: nextSid(), callText: () => '{"noop":true}' });
  assert.equal(r1.status, "skip");
  assert.equal(r1.reason, "few-sessions");

  // interval gate: last analysis just happened — skip even with sessions
  const st = readState(TMP);
  st.lastTs.analysis = Date.now();
  writeState(TMP, st);
  seedSessions(TMP, 3);
  const r2 = await inst.maybeCycle({ sessionID: nextSid(), callText: () => '{"noop":true}' });
  assert.equal(r2.status, "skip");
  assert.equal(r2.reason, "interval");

  // env freeze beats everything
  process.env.BABYZILLA_SELFTUNE_DISABLE = "1";
  const r3 = await inst.maybeCycle({ sessionID: nextSid(), callText: () => '{"noop":true}' });
  assert.equal(r3.reason, "env-disabled");
  delete process.env.BABYZILLA_SELFTUNE_DISABLE;
});

test("cycle: while pending, no analysis runs; due pending schedules a verify", async () => {
  await pendingCycleResult(TMP, null);
  const { inst, logs } = makeInstance(TMP);
  const st = readState(TMP);
  const knob = "stableMinTokens";
  st.knobs[knob] = 1800;
  st.pending = { knob, from: 2000, to: 1800, proposalTs: Date.now(), appliedTs: Date.now() - 2 * 3600_000, rationale: "test" };
  writeState(TMP, st);

  // pending applies only 24h+ after apply — inside the grace window: wait
  const r1 = await inst.maybeCycle({ sessionID: nextSid(), callText: () => '{"knob":"stableMinTokens","to":1600}' });
  assert.equal(r1.status, "pending-await-verify");

  // 30h+ after apply, but a verify ran 3 days ago — 7-day throttle blocks
  const s2 = readState(TMP);
  s2.lastTs.verify = Date.now() - 3 * 86400_000;
  s2.pending.appliedTs = Date.now() - 30 * 3600_000;
  writeState(TMP, s2);
  const r2 = await inst.maybeCycle({ sessionID: nextSid(), callText: () => '{"noop":true}' });
  assert.equal(r2.status, "pending-await-verify");

  // last verify 8 days ago → now a background bench is scheduled
  const s3 = readState(TMP);
  s3.lastTs.verify = Date.now() - 8 * 86400_000;
  writeState(TMP, s3);
  const r3 = await inst.maybeCycle({ sessionID: nextSid(), callText: () => '{"noop":true}' });
  assert.equal(r3.status, "verify-scheduled");
  assert.ok(ledger(TMP).some((e) => e.kind === "verify-scheduled"));
  assert.ok(logs.some((l) => l.includes("verification bench spawned")));
  // scheduling did not disturb the pending proposal
  assert.ok(readState(TMP).pending);
});

// ── bench verdict judging ───────────────────────────────────────────────────

const mk = (n, cost, hit = true) => ({ hitOff: hit, hitOn: hit, off: { n, sum: { cost } }, on: { n, sum: { cost: cost * 0.9 } } });

test("judgeVerify: pass needs marker, parity, and a cost win beyond the noise floor", () => {
  const good = judgeVerify({ results: [mk(6, 0.02), mk(6, 0.03)] }, 1.0);
  assert.ok(good.ok, `expected pass, got ${good.reason}`);
  assert.ok(good.pct < 0);
  const noMarker = judgeVerify({ results: [mk(6, 0.02, false)] }, 1.0);
  assert.ok(!noMarker.ok && noMarker.reason.includes("marker"));
  const mismatch = judgeVerify({
    results: [
      { hitOff: true, hitOn: true, off: { n: 6, sum: { cost: 0.02 } }, on: { n: 6, sum: { cost: 0.01 } } },
      { hitOff: true, hitOn: true, off: { n: 6, sum: { cost: 0.02 } }, on: { n: 5, sum: { cost: 0.009 } } },
    ],
  }, 1.0);
  assert.ok(!mismatch.ok && mismatch.reason.includes("work mismatch"), "bail-outs must not read as savings");
  const unpriced = judgeVerify({ results: [mk(6, 0)] }, null);
  assert.ok(unpriced.unpriced, "free-model legs cannot yield a verdict");
  const withinFloor = judgeVerify({ results: [mk(6, 0.02)] }, 15.0);
  assert.ok(!withinFloor.ok && withinFloor.reason.includes("floor"), "deltas inside noise are not wins");
});

test("resolveVerify: keep on pass, revert on fail, defer on unpriced", async () => {
  const root = freshRoot();
  writeState(root, {
    ...emptyState(),
    knobs: { stableMinTokens: 1800 },
    pending: { knob: "stableMinTokens", from: 2000, to: 1800, proposalTs: Date.now(), appliedTs: Date.now() },
  });
  await resolveVerify({ root, verdict: { results: [mk(6, 0.02), mk(6, 0.03)] } });
  let st = readState(root);
  assert.equal(st.pending, null);
  assert.equal(st.counts.kept, 1);
  assert.equal(st.knobs.stableMinTokens, 1800, "kept knob stays applied");
  assert.ok(ledger(root).some((e) => e.kind === "keep"));

  const root2 = freshRoot();
  writeState(root2, {
    ...emptyState(),
    knobs: { stableMinTokens: 1800 },
    pending: { knob: "stableMinTokens", from: 2000, to: 1800, proposalTs: Date.now(), appliedTs: Date.now() },
  });
  await resolveVerify({ root: root2, verdict: { results: [mk(6, 0.02, false)] } }); // marker miss
  st = readState(root2);
  assert.equal(st.pending, null);
  assert.equal(st.counts.reverted, 1);
  assert.equal(st.knobs.stableMinTokens, 2000, "failed verify restores the prior value");
  assert.ok(ledger(root2).some((e) => e.kind === "revert"));

  const root3 = freshRoot();
  writeState(root3, {
    ...emptyState(),
    pending: { knob: "stableMinTokens", from: 2000, to: 1800, proposalTs: Date.now(), appliedTs: Date.now() },
  });
  await resolveVerify({ root: root3, verdict: { results: [{ hitOff: true, hitOn: true, off: { n: 6, sum: { cost: 0.02 } }, on: { n: 6, sum: { cost: 0.03 } } }] } }); // on leg more expensive → plain fail
  st = readState(root3);
  assert.equal(st.knobs.stableMinTokens, 2000);

  const root4 = freshRoot();
  writeState(root4, {
    ...emptyState(),
    pending: { knob: "stableMinTokens", from: 2000, to: 1800, proposalTs: Date.now(), appliedTs: Date.now() },
  });
  const defer = await resolveVerify({ root: root4, verdict: { results: [mk(6, 0)] } }); // unpriced legs
  assert.ok(defer.unpriced);
  st = readState(root4);
  assert.ok(st.pending, "an unpriced bench must not revert live evidence");
  assert.equal(st.counts.verifyErrors, 1);
});

test("verifyPlan puts other overrides on both legs and diverges only the pending knob", () => {
  writeState(TMP, {
    ...emptyState(),
    knobs: { stableMinTokens: 1800, toolResultHeadLines: 50 },
    pending: { knob: "stableMinTokens", from: 2000, to: 1800, proposalTs: Date.now(), appliedTs: Date.now() },
  });
  const { setoffs, sets } = verifyPlan(TMP);
  assert.deepEqual(setoffs, [["toolResultHeadLines", 50], ["stableMinTokens", 2000]]);
  assert.deepEqual(sets, [["toolResultHeadLines", 50], ["stableMinTokens", 1800]]);
});

test("noise floor formula and manual revert", async () => {
  assert.equal(noiseFloor({ noise: null }), 1.0);
  assert.equal(noiseFloor({ noise: { aaDeltaPct: 2.0 } }), 3.5);

  const root = freshRoot();
  writeState(root, {
    ...emptyState(),
    knobs: { stableMinTokens: 1800 },
    pending: { knob: "stableMinTokens", from: 2000, to: 1800, proposalTs: Date.now(), appliedTs: Date.now() },
  });
  const r = manualRevert(root);
  assert.ok(r.ok && r.knob === "stableMinTokens" && r.to === 2000);
  assert.equal(readState(root).pending, null);
  assert.ok(ledger(root).some((e) => e.kind === "manual-revert"));
  const none = manualRevert(root);
  assert.equal(none.ok, false);
});

// ── telemetry & emergency revert ────────────────────────────────────────────

test("finalize closes a session record with repeats, paging, distill and recall counts", async () => {
  const { inst } = makeInstance(TMP);
  const sid = nextSid();
  inst.noteToolUse(sid, "read", "alpha beta same");
  inst.noteToolUse(sid, "read", "alpha beta same"); // duplicate
  inst.noteToolUse(sid, "read", "different content");
  inst.noteCompression(sid, "read", 6000, 2500);
  inst.noteCompression(sid, "read", 6000, 2500); // re-derivation bucket
  inst.noteDistill(sid, 9000, 40_000);
  noteRecallRendered(TMP, "abc123");
  const rec = await inst.finalize(sid);
  assert.ok(rec, "record returned");
  assert.equal(rec.turns, 0, "turns counted by onPrompt");
  assert.equal(rec.requests, undefined, "no DB → no billing fields at all (not zeros)");
  assert.equal(rec.recalls, 1);
  assert.deepEqual(rec.repeats.map((r) => r.n), [2], "the duplicate call is visible");
  assert.deepEqual(rec.compress, [{ tool: "read", n: 2, saved: 3500 }]);
  assert.equal(rec.distills?.[0].fed, 9000);
  const stored = JSON.parse(fs.readFileSync(path.join(TMP, "selftune", "sessions.jsonl"), "utf8"));
  assert.equal(stored.sid, sid);
});

test("onPrompt finalizes the previous session and counts turns per session", async () => {
  const { inst } = makeInstance(TMP);
  const a = nextSid(), b = nextSid();
  inst.noteToolUse(a, "bash", "npm test");
  await inst.onPrompt({ sid: a, model: null, callText: () => '{"noop":true}' });
  await inst.onPrompt({ sid: a, model: null, callText: () => '{"noop":true}' });
  await inst.onPrompt({ sid: b, model: null, callText: () => '{"noop":true}' });
  const rows = fs.readFileSync(path.join(TMP, "selftune", "sessions.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(rows.length, 1, "session A closed when session B first prompts");
  assert.equal(rows[0].sid, a);
  assert.equal(rows[0].turns, 2);
});

test("emergency revert fires on a recall storm while a knob is provisional", async () => {
  const root = freshRoot();
  writeState(root, {
    ...emptyState(),
    knobs: { stableMinTokens: 1800 },
    pending: { knob: "stableMinTokens", from: 2000, to: 1800, proposalTs: Date.now(), appliedTs: Date.now() },
    baseline: { recallsPerTurn: 0, sampleTurns: 50, updatedTs: new Date().toISOString() },
  });
  for (let i = 0; i < 4; i++) noteRecallRendered(root, `h${i}`); // 4 ≥ floor 3
  const { inst } = makeInstance(root);
  const sid = nextSid();
  await inst.onPrompt({ sid, model: null, callText: () => '{"noop":true}' });
  const st = readState(root);
  assert.equal(st.pending, null);
  assert.equal(st.counts.emergency, 1);
  assert.equal(st.knobs.stableMinTokens, 2000);
  assert.ok(ledger(root).some((e) => e.kind === "emergency-revert"));

  // and normal-load sessions never trigger it: 1 recall is below any floor
  const root2 = freshRoot();
  writeState(root2, {
    ...emptyState(),
    pending: { knob: stableKnob(), from: 2000, to: 1800, proposalTs: Date.now(), appliedTs: Date.now() },
  });
  noteRecallRendered(root2, "one");
  const inst2 = makeInstance(root2).inst;
  await inst2.onPrompt({ sid: nextSid(), model: null, callText: () => '{"noop":true}' });
  assert.ok(readState(root2).pending, "a single recall must not pull the plug");
});

test("summary data feeds the analyst last-eight sessions and recent ledger", async () => {
  seedSessions(TMP, 12);
  appendLedger(TMP, { kind: "apply", knob: "stableMinTokens", from: 2000, to: 1800 });
  appendLedger(TMP, { kind: "noop" });
  const s = buildSummaryData(TMP, { sessionsLimit: 4, ledgerLimit: 2 });
  assert.equal(s.sessions.length, 4);
  assert.ok(s.sessions.every((x) => x.turns > 0));
  assert.equal(s.ledger.length, 2);
  assert.equal(s.ledger.at(-1).kind, "noop");
});

function stableKnob() { return "stableMinTokens"; }
