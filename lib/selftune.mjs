// Self-tuning loop for BabyZilla (v0.10).
//
// The plugin already turned context compression into a measurable objective:
// billed input tokens, subject to task quality and recall round-trips. This
// module closes the loop on that objective:
//
//   1. Telemetry   — per-session records under <ROOT>/selftune/sessions.jsonl
//                    (DB-billed tokens/cost, cache resets, recall counts,
//                    duplicate calls, paging volume, distill diet). No model.
//   2. Analysis    — one cheap model call (session-scoped generate, free-tier
//                    safe) proposes at most one bounded knob change.
//   3. Apply       — numeric knobs only, hard clamps, visible ledger entry,
//                    live-merged into the running options.
//   4. Verify      — the existing bench (bench/ab-live.mjs) becomes the
//                    acceptance gate: plugin-vs-plugin A/B with the baseline
//                    knobs on one leg and the proposal on the other. Marker
//                    must be found in every leg, work must match, and the
//                    paired cost delta must exceed the measured A/A noise
//                    floor. Pass -> keep, fail -> revert.
//
// Trust properties: every decision lands in <ROOT>/selftune/ledger.jsonl and
// is mirrored to the debug log; prompts/contract text/routing/algorithms are
// structurally out of reach; `BABYZILLA_SELFTUNE_DISABLE=1` (set by the bench
// itself) freezes everything, so bench children never recurse into the tuner.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildAnalysisPrompt, parseAnalysis } from "./analyze.mjs";

export const SELF_DIR_NAME = "selftune";

export const selftuneDir = (root) => path.join(root, SELF_DIR_NAME);

// The knobs the analyst may touch, with absolute bounds. A proposal outside a
// bound is rejected before it is ever applied; the model is steered, not
// trusted. Algorithms, prompts, contract text and routing live elsewhere and
// are intentionally absent from this table.
export const KNOBS = {
  stableMinTokens: { min: 800, max: 6000, int: true },
  toolResultHeadLines: { min: 10, max: 60, int: true },
  toolResultTailLines: { min: 5, max: 60, int: true },
  toolResultMinTokens: { min: 1200, max: 12000, int: true },
  toolResultEagerTokens: { min: 4000, max: 30000, int: true },
  distillBudgetDefault: { min: 8000, max: 48000, int: true },
  requestMinSavingsPct: { min: 5, max: 30, int: true },
};

// A single proposal may not move a knob by more than this share of its current
// value — revolutions must be argued for in code review, not discovered by a
// model call.
export const MAX_STEP_PCT = 35;

export function emptyState() {
  return {
    version: 1,
    // active overrides: knob -> clamped value (includes a pending proposal)
    knobs: {},
    // proposal currently applied but not yet verified
    pending: null, // { knob, from, to, proposalTs, appliedTs, rationale }
    history: [], // ring of {ts, kind, knob?, from?, to?, why?}
    counts: { proposals: 0, applied: 0, kept: 0, reverted: 0, emergency: 0, verifyErrors: 0 },
    // quality baseline for the emergency revert: recalls per turn
    baseline: null, // { recallsPerTurn, sampleTurns, updatedTs }
    // measured A/A noise; null until the first A/A run lands
    noise: null, // { aaDeltaPct, samples: [pct,...], updatedTs }
    lastTs: {}, // { analysis, verify }
  };
}

// ── state & ledger IO ────────────────────────────────────────────────────────

export function readState(root) {
  const file = path.join(selftuneDir(root), "state.json");
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    return { ...emptyState(), ...raw, counts: { ...emptyState().counts, ...(raw.counts ?? {}) } };
  } catch {
    return emptyState();
  }
}

// Write via tmp+rename so a crash or a concurrent reader never sees a torn
// file. Concurrent writers are possible (plugin process vs detached verify
// child); last rename wins, which is safe for every field but event ordering —
// the canonical decision history is ledger.jsonl, which is append-only.
export function writeState(root, st) {
  fs.mkdirSync(selftuneDir(root), { recursive: true });
  const file = path.join(selftuneDir(root), "state.json");
  const tmp = file + ".tmp-" + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(st, null, 2));
  fs.renameSync(tmp, file);
  return st;
}

export function appendLedger(root, entry) {
  fs.mkdirSync(selftuneDir(root), { recursive: true });
  fs.appendFileSync(
    path.join(selftuneDir(root), "ledger.jsonl"),
    JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n",
  );
}

const readJsonl = (file, limit = Infinity) => {
  let lines;
  try {
    lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
  const out = [];
  for (const l of lines.slice(-limit)) {
    try { out.push(JSON.parse(l)); } catch { /* skip corrupt line */ }
  }
  return out;
};

// A pending verdict fails (or the user pulls the plug): unset pending, restore
// the pre-apply value, record history + ledger. Returns { st, pend } or false.
// Module-level so the verify path (which has no live options handle) can use
// it; the plugin-process wrapper below adds the live-options unwind.
export function revertPendingState(root, why, kind = "revert") {
  const st = readState(root);
  const pend = st.pending;
  if (!pend) return null;
  st.pending = null;
  st.counts[kind === "emergency-revert" ? "emergency" : "reverted"]++;
  st.history.push({ ts: new Date().toISOString(), kind, knob: pend.knob, from: pend.to, to: pend.from, why: String(why).slice(0, 200) });
  if (st.history.length > 60) st.history = st.history.slice(-60);
  if (pend.from === undefined) delete st.knobs[pend.knob];
  else st.knobs[pend.knob] = pend.from;
  writeState(root, st);
  appendLedger(root, { kind, knob: pend.knob, from: pend.to, to: pend.from, why: String(why).slice(0, 200) });
  return { st, pend };
}

// ── knob validation ─────────────────────────────────────────────────────────

export function clampValue(knob, v) {
  const spec = KNOBS[knob];
  if (!spec || typeof v !== "number" || !Number.isFinite(v)) return null;
  let n = Math.max(spec.min, Math.min(spec.max, v));
  if (spec.int) n = Math.round(n);
  return n;
}

export function allowlistFor(opts) {
  if (Array.isArray(opts?.selfLearnKnobs) && opts.selfLearnKnobs.length) {
    return opts.selfLearnKnobs.filter((k) => KNOBS[k]);
  }
  return Object.keys(KNOBS);
}

// Validate a parsed model proposal without touching state. Returns
// { ok: true, value } or { ok: false, reason }. `from` is the live value the
// proposal was measured against; the step cap keeps the tuning loop small
// enough for the bench to arbitrate cleanly.
export function validProposal(proposal, { allow, from }) {
  const { knob, to } = proposal;
  if (!KNOBS[knob]) return { ok: false, reason: `knob '${knob}' is not tunable` };
  if (allow && !allow.includes(knob)) return { ok: false, reason: `knob '${knob}' excluded by selfLearnKnobs` };
  const value = clampValue(knob, to);
  if (value === null) return { ok: false, reason: `value ${to} is not a usable number` };
  const base = Math.abs(Number(from) || 0);
  const step = base > 0 ? (Math.abs(value - from) / base) * 100 : 0;
  const capped = base === 0 ? Number.isFinite(to) : step <= MAX_STEP_PCT;
  if (!capped) {
    return { ok: false, reason: `step from ${from} to ${value} exceeds the ${MAX_STEP_PCT}% cap` };
  }
  return { ok: true, value };
}

// Merge persisted overrides onto a live options object. Called at plugin
// setup (so a restart re-applies) and right after an apply (so the running
// process picks the change up without a restart). Bench children never call
// this — BABYZILLA_SELFTUNE_DISABLE freezes overrides too, so bench legs are
// always plain config as given.
export function applyOverrides(opts, st, log = () => {}) {
  const applied = [];
  for (const [knob, value] of Object.entries(st.knobs ?? {})) {
    if (!KNOBS[knob] || value === undefined) continue;
    const before = opts[knob];
    if (before === value) continue;
    opts[knob] = value;
    applied.push(`${knob}: ${before} → ${value}`);
  }
  if (applied.length) log(`selftune: overrides applied (${applied.join(", ")})`);
  return applied;
}

// ── telemetry ───────────────────────────────────────────────────────────────

// CLI-side note when a recall page is actually read back. Failures are silent:
// a missing counter must never break a recall.
export function noteRecallRendered(root, hash) {
  try {
    fs.mkdirSync(selftuneDir(root), { recursive: true });
    fs.appendFileSync(
      path.join(selftuneDir(root), "recalls.jsonl"),
      JSON.stringify({ t: Date.now(), hash: String(hash ?? "").slice(0, 64) }) + "\n",
    );
  } catch { /* telemetry only */ }
}

// Per-request billing rows for one session, straight from OpenCode's own DB —
// the same source the bench trusts. node:sqlite is loaded lazily so hosts
// without it keep working; failure merely drops cost fields from the record.
async function dbSessionMetrics(sid, dbPath) {
  let openMod;
  try {
    openMod = await import("./cost.mjs");
  } catch {
    return null;
  }
  try {
    const { openDb, defaultDbPath, hasTable, cacheResets } = openMod;
    const dbFile = dbPath ?? defaultDbPath();
    if (!fs.existsSync(dbFile)) return null;
    const db = openDb(dbFile, { readonly: true });
    if (!hasTable(db, "session_message")) return null;
    const rows = db.prepare("select data from session_message where session_id=? order by seq").all(sid);
    const reqs = [];
    for (const r of rows) {
      let d;
      try { d = JSON.parse(r.data); } catch { continue; }
      if (!d.tokens || !d.tokens.output) continue;
      reqs.push({ in: d.tokens.input || 0, cache: d.tokens.cache?.read || 0, out: d.tokens.output || 0, cost: d.cost || 0 });
    }
    db.close?.();
    if (!reqs.length) {
      return { requests: 0, tokens: { input: 0, cached: 0, output: 0 }, cost: null, resets: 0, wasted: 0 };
    }
    const sum = { in: 0, cache: 0, out: 0, cost: 0 };
    for (const r of reqs) { sum.in += r.in; sum.cache += r.cache; sum.out += r.out; sum.cost += r.cost; }
    const resets = cacheResets(reqs);
    return {
      requests: reqs.length,
      tokens: { input: sum.in, cached: sum.cache, output: sum.out },
      cost: sum.cost || null,
      resets: resets.count,
      wasted: resets.wasted,
    };
  } catch {
    return null;
  }
}

// Factory: one instance per plugin process, wired to the live options object
// so applies and reverts take effect immediately.
export function createSelftune({ root, opts, log = console.error, repoDir = null, callForText = null, dbPath = null }) {
  const repo = repoDir ?? path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const verifyChild = path.join(repo, "bench", "verify-child.mjs");
  const dataDb = dbPath; // tests sandbox this; null = OpenCode's real DB
  const num = (v, def) => {
    const n = Number(opts?.[v]);
    return Number.isFinite(n) && n > 0 ? n : def;
  };

  // ── in-memory accumulators ────────────────────────────────────────────────
  let current = null; // { sid, started, last, turns, model }
  let cycleInFlight = false;
  const ct = new Map(); // sid -> { started, turns }
  const tools = new Map(); // sid -> Map(key -> n)   duplicate-call proxy
  const compress = new Map(); // sid -> Map(bucket -> {tool, n, before, after})
  const distills = new Map(); // sid -> [{fed, raw}]

  const ensureMaps = (sid) => {
    if (!tools.has(sid)) tools.set(sid, new Map());
    if (!compress.has(sid)) compress.set(sid, new Map());
    if (!distills.has(sid)) distills.set(sid, []);
  };

  const subHead = (s) => String(s ?? "").replace(/\s+/g, " ").slice(0, 160);

  function noteToolUse(sid, tool, text) {
    try {
      ensureMaps(sid);
      const m = tools.get(sid);
      const key = `${String(tool).toLowerCase()}·${subHead(text)}`;
      m.set(key, (m.get(key) ?? 0) + 1);
      if (m.size > 5000) m.delete(m.keys().next().value);
    } catch { /* telemetry only */ }
  }

  function noteCompression(sid, tool, before, after) {
    try {
      ensureMaps(sid);
      const m = compress.get(sid);
      // Bucket by (tool, size/500): the execute.after path re-derives already
      // paged parts on every later tool completion, so identical before/after
      // pairs repeat — bucketing keeps them one row instead of inflating the
      // episode count. Re-derivation volume itself stays visible via n.
      const key = `${tool}|${Math.round(before / 500)}`;
      const prev = m.get(key) ?? { tool, n: 0, before: 0, after: 0 };
      m.set(key, { tool, n: prev.n + 1, before: prev.before || before, after: prev.after || after });
    } catch { /* telemetry only */ }
  }

  function noteDistill(sid, fed, raw) {
    try {
      ensureMaps(sid);
      distills.get(sid).push({ fed, raw });
    } catch { /* telemetry only */ }
  }

  function topRepeats(sid) {
    const m = tools.get(sid);
    if (!m) return [];
    const rows = [...m.entries()].filter(([, n]) => n > 1);
    rows.sort((a, b) => b[1] - a[1]);
    return rows.slice(0, 3).map(([key, n]) => {
      const idx = key.indexOf("·");
      return { tool: key.slice(0, idx), n, head: key.slice(idx + 1) };
    });
  }

  function compressRows(sid) {
    const m = compress.get(sid);
    if (!m) return [];
    return [...m.values()]
      .sort((a, b) => b.before - a.before)
      .slice(0, 4)
      .map((r) => ({ tool: r.tool, n: r.n, saved: Math.max(0, r.before - r.after) }));
  }

  function recallsSince(since) {
    return readJsonl(path.join(selftuneDir(root), "recalls.jsonl")).filter((r) => (r.t ?? 0) >= since).length;
  }

  async function finalize(sid) {
    if (!sid || (!tools.has(sid) && !compress.has(sid) && !distills.has(sid))) return null;
    const cur = ct.get(sid) ?? { started: Date.now(), turns: 0 };
    let metric = null;
    try { metric = await dbSessionMetrics(sid, dataDb ?? undefined); } catch { /* db optional */ }
    const rec = {
      t: Date.now(),
      sid,
      started: cur.started,
      turns: cur.turns,
      model: current?.sid === sid ? (current.model ?? null) : null,
      ...(metric ? {
        requests: metric.requests,
        tokens: metric.tokens,
        cost: metric.cost,
        resets: metric.resets,
        wasted: metric.wasted,
      } : {}),
      recalls: recallsSince(cur.started),
      repeats: topRepeats(sid),
      compress: compressRows(sid),
      ...(distills.get(sid)?.length ? { distills: distills.get(sid).slice(-4) } : {}),
    };
    try {
      fs.mkdirSync(selftuneDir(root), { recursive: true });
      fs.appendFileSync(path.join(selftuneDir(root), "sessions.jsonl"), JSON.stringify(rec) + "\n");
    } catch { /* telemetry only */ }
    tools.delete(sid);
    compress.delete(sid);
    distills.delete(sid);
    // NOTE: current/ct are not reset here — they belong to whichever session
    // is live. If the finished sid is seen again, ensureMaps()/of() re-seed.
    return rec;
  }

  // internal: seed current-session pointer (name kept short: "of")
  function of(sid) {
    if (!current || current.sid !== sid) {
      current = { sid, started: Date.now(), last: Date.now(), turns: 0, model: null };
    }
    if (!ct.has(sid)) ct.set(sid, { started: current.started, turns: 0 });
    return current;
  }

  function revertPending(why, kind = "revert") {
    const out = revertPendingState(root, why, kind);
    if (!out) return null;
    if (opts) applyOverrides(opts, out.st); // live process unwinds immediately
    log(`selftune: ${kind} ${out.pend.knob} → ${out.pend.from} (${why})`);
    return out;
  }

  // ── emergency revert: live quality signals while a knob is provisional ─────
  function emergencyRevertIfNeeded(sid) {
    const st = readState(root);
    if (!st.pending) return null;
    const info = ct.get(sid);
    const started = info?.started ?? Date.now();
    const turns = Math.max(1, info?.turns ?? 1);
    const recalls = recallsSince(started);
    // Floor scales with how much work this session has done so a long session
    // is not reverted because a dump-heavy task legitimately re-reads.
    const floor = Math.max(3, Math.ceil(2.5 * (st.baseline?.recallsPerTurn ?? 0.2) * turns));
    if (recalls < floor) return null;
    const out = revertPending(`${recalls} recalls in ${turns} turns (allowed ${floor})`, "emergency-revert");
    return out ? { recalls, turns, floor } : null;
  }

  // ── the analysis cycle ────────────────────────────────────────────────────
  async function maybeCycle({ sessionID, model, callText }) {
    const why = disabledReason(opts);
    if (why) return { status: "skip", reason: why };
    if (cycleInFlight || !callText || typeof callText !== "function") {
      return { status: "skip", reason: "inflight-or-no-caller" };
    }
    cycleInFlight = true;
    try {
      const now = Date.now();
      const sessionsNeeded = num("selfLearnSessions", 4);
      const interval = num("selfLearnIntervalHours", 20) * 3600_000;
      const verifyGap = num("selfLearnVerifyDays", 7) * 86400_000;
      const verifyGrace = num("selfLearnVerifyGraceHours", 24) * 3600_000;
      const st = readState(root);
      const pend = st.pending;

      // (a) A provisional knob is out there — it comes home or gets reverted
      //     by a bench run before any new analysis runs.
      if (pend) {
        const enoughLiveExperience = now - pend.appliedTs >= verifyGrace;
        const throttleOk = now - (st.lastTs?.verify ?? 0) >= verifyGap;
        if (enoughLiveExperience && throttleOk) {
          scheduleVerify(st, now);
          return { status: "verify-scheduled" };
        }
        return { status: "pending-await-verify" };
      }

      // (b) Not enough new sessions since the last analysis, or too soon.
      // Quick subagent round-trips (turns < 3) don't count as experience.
      if (now - (st.lastTs?.analysis ?? 0) < interval) return { status: "skip", reason: "interval" };
      const sessions = readJsonl(path.join(selftuneDir(root), "sessions.jsonl"), 400);
      const sinceCount = sessions.filter((s) => (s.t ?? 0) > (st.lastTs?.analysis ?? 0) && (s.turns ?? 0) >= 3).length;
      if (sinceCount < sessionsNeeded) return { status: "skip", reason: "few-sessions", have: sinceCount };

      // (c) Call the analyst, validate, apply provisionally.
      st.lastTs.analysis = now;
      writeState(root, st);
      const summary = buildSummaryData(root, { sessionsLimit: 8, ledgerLimit: 10 });
      const allow = allowlistFor(opts);
      const clampTable = {};
      for (const k of allow) clampTable[k] = KNOBS[k];
      const prompt = buildAnalysisPrompt({
        summary,
        knobs: Object.fromEntries(allow.map((k) => [k, opts[k]])),
        clamps: clampTable,
        noiseFloorPct: st.noise?.aaDeltaPct ?? null,
      });
      let text = null;
      try {
        text = await callText({ prompt });
      } catch (e) {
        appendLedger(root, { kind: "analysis-fail", reason: `call failed: ${e?.message ?? e}` });
        log("selftune: analysis call failed:", e?.message ?? e);
        return { status: "analysis-failed" };
      }
      const parsed = parseAnalysis(text);
      if (!parsed.ok) {
        appendLedger(root, { kind: "analysis-fail", reason: parsed.reason });
        log(`selftune: analysis unparseable — ${parsed.reason}`);
        return { status: "analysis-failed", reason: parsed.reason };
      }
      if (parsed.kind === "noop") {
        appendLedger(root, { kind: "noop", rationale: parsed.rationale });
        log(`selftune: analyst says noop — ${parsed.rationale}`);
        return { status: "noop", rationale: parsed.rationale };
      }
      const from = opts[parsed.knob];
      const { ok, value, reason } = validProposal(parsed, { allow, from });
      if (!ok) {
        appendLedger(root, { kind: "proposal-rejected", knob: parsed.knob, from, to: parsed.to, reason });
        log(`selftune: proposal rejected — ${reason}`);
        return { status: "rejected", reason };
      }
      st.knobs[parsed.knob] = value;
      st.pending = { knob: parsed.knob, from, to: value, proposalTs: now, appliedTs: now, rationale: parsed.rationale };
      st.counts.proposals++;
      st.counts.applied++;
      st.history.push({ ts: new Date().toISOString(), kind: "apply", knob: parsed.knob, from, to: value, why: parsed.rationale });
      if (st.history.length > 60) st.history = st.history.slice(-60);
      writeState(root, st);
      appendLedger(root, { kind: "apply", knob: parsed.knob, from, to: value, why: parsed.rationale, provisional: true });
      if (opts) applyOverrides(opts, st);
      log(`selftune: applied ${parsed.knob} ${from} → ${value} (provisional; rationale: ${parsed.rationale})`);
      return { status: "applied", knob: parsed.knob, from, to: value };
    } finally {
      cycleInFlight = false;
    }
  }

  function scheduleVerify(st, now) {
    st.lastTs.verify = now;
    writeState(root, st);
    const withNoise = !Array.isArray(st.noise?.samples) || st.noise.samples.length < 2;
    appendLedger(root, { kind: "verify-scheduled", reps: 2, withNoise });
    const child = spawn(
      process.execPath,
      [
        verifyChild,
        "--root", root,
        "--repo", repo,
        "--reps", "2",
        ...(withNoise ? ["--with-noise"] : []),
      ],
      { detached: true, stdio: "ignore", env: { ...process.env, BABYZILLA_SELFTUNE_CHILD: "1" } },
    );
    child.unref();
    log(`selftune: verification bench spawned in background (reps=2, marker-gated${withNoise ? ", A/A first" : ""})`);
  }

  // ── prompt hook entry point ───────────────────────────────────────────────
  async function onPrompt({ sid, model, callText }) {
    try {
      // Session switch: close the previous session's record (DB billing
      // included) before its accumulators are replaced. Subagent round-trips
      // flip sessionIDs frequently — each becomes its own record, which is
      // exactly what the trigger count wants to measure.
      if (current && current.sid && current.sid !== sid &&
          (tools.has(current.sid) || compress.has(current.sid) || distills.has(current.sid))) {
        await finalize(current.sid);
      }
      const cur = of(sid);
      cur.turns++;
      cur.last = Date.now();
      if (model && !cur.model) cur.model = model;
      const info = ct.get(sid) ?? { started: cur.started, turns: 0 };
      info.turns = cur.turns;
      ct.set(sid, info);
      const emergency = emergencyRevertIfNeeded(sid);
      if (emergency) return { status: "emergency-revert", emergency };
      void maybeCycle({ sessionID: sid, model, callText }).catch((e) =>
        log("selftune cycle skipped:", e?.message ?? e),
      );
      return { status: "ok" };
    } catch (e) {
      log("selftune onPrompt skipped:", e?.message ?? e);
      return { status: "error", reason: e?.message };
    }
  }

  async function flush(sid) {
    return finalize(sid);
  }

  return {
    noteToolUse, noteCompression, noteDistill, onPrompt, finalize: flush,
    emergencyRevertIfNeeded, maybeCycle,
    disabled: () => disabledReason(opts),
    get pending() { return readState(root).pending; },
    root, repo,
  };
}

export function disabledReason(opts) {
  if (process.env.BABYZILLA_SELFTUNE_DISABLE === "1") return "env-disabled";
  if (opts?.selfLearn === false) return "selfLearn-off";
  return null;
}

// Aggregate view fed to the analyst.
export function buildSummaryData(root, { sessionsLimit = 8, ledgerLimit = 12 } = {}) {
  return {
    sessions: readJsonl(path.join(selftuneDir(root), "sessions.jsonl"), 400).slice(-sessionsLimit),
    ledger: readJsonl(path.join(selftuneDir(root), "ledger.jsonl"), 200).slice(-ledgerLimit),
  };
}

// ── bench-driven verification ───────────────────────────────────────────────

const MED = (xs) => {
  if (!xs?.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

// Judge one bench JSON payload. OFF = baseline knobs (live values), ON = the
// provisional proposal. Acceptance needs all three bars:
//   · marker found in every leg of every rep (quality floor),
//   · equal step counts per rep (no bail-outs pretending to be savings),
//   · paired cost delta negative and beyond the measured noise floor.
// Costs are paired per rep (identical reps run back to back), which is the
// honest whisker against drift — medians of unpaired legs invited the 174%
// phantom we once measured.
export function judgeVerify(json, noiseFloorPct = null) {
  const reps = json?.results ?? [];
  if (!reps.length) return { ok: false, reason: "no bench results" };
  // The baseline leg missing its marker cannot be evidence against the
  // proposal — that is the instrument failing (provider error, rate limit,
  // aborted run), so it defers instead of reverting a live knob.
  const offMiss = reps.some((r) => !r.hitOff);
  if (offMiss) {
    return {
      ok: false,
      defer: true,
      reason: "baseline (OFF) leg missed the marker — bench instrument failure, not a verdict",
      markerOk: false,
    };
  }
  const markerOk = reps.every((r) => r.hitOn);
  if (!markerOk) return { ok: false, reason: "marker MISS", markerOk: false };
  const parity = reps.every((r) => r.off.n === r.on.n);
  if (!parity) return { ok: false, reason: "work mismatch (step counts differ)", markerOk: true };
  // Identical fixtures make the second leg of a pair read the first leg's
  // prompt cache, so a single-order run cannot separate the knob from warm-up.
  // Only enforced when the payload carries order metadata.
  if (reps.every((r) => typeof r.order === "string")) {
    const orders = new Set(reps.map((r) => r.order));
    if (orders.size < 2) {
      return {
        ok: false,
        defer: true,
        reason: `unbalanced leg order (${[...orders].join(", ")}) — prompt-cache warm-up cannot cancel; rerun with --reps 2`,
        markerOk: true,
        parity: true,
      };
    }
  }
  const baseCost = MED(reps.map((r) => r.off.sum.cost));
  if (!(baseCost > 0)) {
    return { ok: false, unpriced: true, reason: "bench legs recorded zero cost (free model) — bench priced data required", markerOk: true };
  }
  const floor = Math.max(1.0, noiseFloorPct ?? 0) + 0.5;
  const dCosts = reps.map((r) => r.on.sum.cost - r.off.sum.cost);
  const delta = MED(dCosts);
  const pct = (delta / baseCost) * 100;
  const ok = delta < 0 && Math.abs(pct) >= floor;
  return {
    ok,
    unpriced: false,
    reason: ok
      ? `on leg is ${Math.abs(pct).toFixed(1)}% cheaper (floor ${floor.toFixed(1)}%)`
      : `delta ${pct.toFixed(1)}% vs floor ${floor.toFixed(1)}%${delta >= 0 ? " — not cheaper" : " — inside noise"}`,
    pct, delta, baseCost, floor, markerOk: true, parity: true,
  };
}

function parseBenchPayload(stdout, jsonOut) {
  if (jsonOut && fs.existsSync(jsonOut)) {
    try { return JSON.parse(fs.readFileSync(jsonOut, "utf8")); } catch { /* fall back */ }
  }
  const m = /##BENCH-JSON##\s*(\{.*\})/.exec(stdout ?? "");
  if (m) {
    try { return JSON.parse(m[1]); } catch { /* invalid */ }
  }
  return null;
}

// Run the bench synchronously (used by the CLI and by the detached child):
// both legs plugin-present; `setoffs` inject the baseline values, `sets` the
// proposal. A/A mode passes no overrides at all — byte-identical configs.
export function runVerify({ root, repo, reps = 2, setoffs = [], sets = [] }) {
  const bench = path.join(repo, "bench", "ab-live.mjs");
  const dir = selftuneDir(root);
  fs.mkdirSync(dir, { recursive: true });
  const jsonOut = path.join(dir, `verify-${Date.now()}.json`);
  const args = [bench, "--reps", String(reps), "--both-plugins", "1", "--json-out", jsonOut];
  for (const [k, v] of setoffs) args.push("--setoff", `${k}=${v}`);
  for (const [k, v] of sets) args.push("--set", `${k}=${v}`);
  const r = spawnSync(process.execPath, args, {
    encoding: "utf8", maxBuffer: 256 * 1024 * 1024, timeout: 40 * 60_000,
  });
  return {
    payload: parseBenchPayload(r.stdout, jsonOut),
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    status: r.status,
    jsonOut,
  };
}

// Recompute the A/A noise floor: identical configs on both legs (plugin
// present everywhere, no overrides) — any delta is provider noise, and the
// tuner refuses to act on deltas at or below the measured level.
//
// Only reps where both legs actually finished the same work may contribute:
// a leg that aborted (provider error, rate limit, crash) records a couple of
// requests and a fraction of the cost, and scoring it once produced a 44%
// "noise" floor from a 2-request leg — which would have frozen the tuner for
// as long as that sample stayed in the median.
//
// Order balance is equally load-bearing. Identical fixtures mean the second
// leg of a pair reads the first leg's prompt cache (96K → 52K uncached input
// in the first real run), so a single-order run reports ~40% "savings" that
// are pure warm-up. The estimate is therefore the mean of the per-order
// means: with both orders present the warm-up cancels.
export function noiseSample(payload) {
  const all = payload?.results ?? [];
  if (!all.length) return { ok: false, reason: "no bench results" };
  const rows = all.filter((r) => r?.hitOff && r?.hitOn && r.off?.n > 0 && r.off.n === r.on.n);
  if (!rows.length) {
    return {
      ok: false,
      reason: `no valid A/A rep (${all.length} run — a leg missed the marker or did different work)`,
    };
  }
  if (rows.some((r) => typeof r.order !== "string")) {
    return { ok: false, reason: "leg-order metadata missing — rerun with the current bench" };
  }
  const groups = new Map();
  for (const r of rows) {
    if (!groups.has(r.order)) groups.set(r.order, []);
    groups.get(r.order).push(r);
  }
  if (groups.size < 2) {
    return {
      ok: false,
      reason: `unbalanced leg order (${[...groups.keys()].join(", ")}) — prompt-cache warm-up cannot cancel`,
    };
  }
  const base = MED(rows.map((r) => r.off.sum.cost));
  const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const perOrder = [...groups.values()].map((g) => mean(g.map((r) => r.on.sum.cost - r.off.sum.cost)));
  const delta = mean(perOrder);
  let pct = 0;
  if (base > 0) pct = Math.abs((delta / base) * 100);
  else pct = Math.abs(delta * 1e6) || 0;
  return { ok: true, pct, reps: rows.length, skipped: all.length - rows.length, delta };
}

export function runNoise({ root, repo, reps = 4 }) {
  const res = runVerify({ root, repo, reps });
  const sample = noiseSample(res.payload);
  if (!sample.ok) return { ok: false, reason: sample.reason, payload: res.payload ?? null };
  const pct = sample.pct;
  const st = readState(root);
  st.noise ??= { samples: [], aaDeltaPct: null };
  st.noise.samples = [...(st.noise.samples ?? []), Number(pct.toFixed(2))].slice(-6);
  st.noise.aaDeltaPct = st.noise.samples.length ? MED(st.noise.samples) : null;
  st.noise.updatedTs = new Date().toISOString();
  writeState(root, st);
  appendLedger(root, { kind: "noise", pct, samples: st.noise.samples.length, reps: sample.reps });
  return { ok: true, pct, floor: noiseFloor(st), reps: sample.reps, skipped: sample.skipped };
}

export function noiseFloor(st) {
  return Math.max(1.0, (st.noise?.aaDeltaPct ?? 0) * 1.5 + 0.5);
}

// Baseline/proposal leg values for a verify run, derived from state: every
// currently overridden knob rides BOTH legs (that is live baseline), and the
// pending knob is the only difference (from on OFF, to on ON). Deriving from
// state.json keeps the spawn argv tiny and means the plugin never has to pass
// knob values through the command line.
export function verifyPlan(root) {
  const st = readState(root);
  const setoffs = [];
  const sets = [];
  for (const [k, v] of Object.entries(st.knobs ?? {})) {
    if (st.pending && k === st.pending.knob) continue;
    setoffs.push([k, v]);
    sets.push([k, v]);
  }
  if (st.pending) {
    setoffs.push([st.pending.knob, st.pending.from]);
    sets.push([st.pending.knob, st.pending.to]);
  }
  return { setoffs, sets, pending: st.pending };
}

// The detached child calls this with the bench payload: applies the verdict,
// updates state + ledger. Verify failure = revert pending; unpriced or
// missing payloads leave pending untouched and retry later.
export async function resolveVerify({ root, verdict, log = () => {}, reps = 2 }) {
  const st = readState(root);
  if (!verdict) {
    st.counts.verifyErrors++;
    st.lastTs.verify = Date.now() - (7 - 1) * 86400_000; // retry tomorrow-ish
    writeState(root, st);
    appendLedger(root, { kind: "verify-error", reps });
    log("selftune: verification produced no payload — will retry");
    return { ok: false, reason: "no-payload" };
  }
  const judged = judgeVerify(verdict, st.noise?.aaDeltaPct);
  if (!st.pending) {
    appendLedger(root, { kind: "verify-stray", ok: judged.ok, pct: judged.pct ?? null, reason: judged.reason });
    return judged;
  }
  // Unpriced/zero-cost legs and a failed baseline leg are instrument
  // problems, not quality verdicts — never let them revert a live knob that
  // used real evidence.
  if (!verdict?.results?.length || judged.unpriced || judged.defer) {
    st.counts.verifyErrors++;
    st.lastTs.verify = Date.now() - (7 - 1) * 86400_000;
    writeState(root, st);
    appendLedger(root, { kind: "verify-deferred", reason: judged.reason, pct: judged.pct ?? null });
    log(`selftune: verify deferred — ${judged.reason}`);
    return judged;
  }
  const pend = st.pending;
  if (judged.ok) {
    st.pending = null;
    st.counts.kept++;
    st.history.push({
      ts: new Date().toISOString(), kind: "keep", knob: pend.knob, from: pend.from, to: pend.to,
      why: `bench: ${judged.reason}`,
    });
    if (st.history.length > 60) st.history = st.history.slice(-60);
    writeState(root, st);
    appendLedger(root, { kind: "keep", knob: pend.knob, to: pend.to, why: judged.reason, pct: judged.pct });
    log(`selftune: KEEP ${pend.knob}=${pend.to} — ${judged.reason}`);
  } else {
    const out = revertPendingState(root, `bench verdict: ${judged.reason}`, "revert");
    if (out) log(`selftune: revert ${out.pend.knob} → ${out.pend.from} (bench verdict: ${judged.reason})`);
  }
  return judged;
}

// One baseline refresh for the emergency-revert threshold: median recalls per
// turn over the recorded sessions.
export function refreshBaseline(root, log = () => {}) {
  const rows = readJsonl(path.join(selftuneDir(root), "sessions.jsonl"), 100);
  const turns = rows.reduce((a, r) => a + (r.turns ?? 0), 0);
  const recalls = rows.reduce((a, r) => a + (r.recalls ?? 0), 0);
  if (!turns) return null;
  const st = readState(root);
  st.baseline = { recallsPerTurn: recalls / turns, sampleTurns: turns, updatedTs: new Date().toISOString() };
  writeState(root, st);
  log(`selftune: baseline recalls/turn = ${st.baseline.recallsPerTurn.toFixed(3)} over ${turns} turns`);
  return st.baseline;
}

// Manual revert from the CLI — the live plugin process re-reads state.json on
// its next restart, so no cross-process messaging is needed here.
export function manualRevert(root) {
  const st = readState(root);
  const pend = st.pending;
  if (!pend) return { ok: false, reason: "nothing pending" };
  if (pend.from === undefined) delete st.knobs[pend.knob];
  else st.knobs[pend.knob] = pend.from;
  st.pending = null;
  st.counts.reverted++;
  st.history.push({
    ts: new Date().toISOString(), kind: "manual-revert", knob: pend.knob, from: pend.to, to: pend.from,
    why: "manual revert via CLI",
  });
  if (st.history.length > 60) st.history = st.history.slice(-60);
  writeState(root, st);
  appendLedger(root, { kind: "manual-revert", knob: pend.knob, from: pend.to, to: pend.from });
  return { ok: true, knob: pend.knob, to: pend.from };
}

// ── status rendering (CLI) ──────────────────────────────────────────────────

export function renderStatus(root) {
  const st = readState(root);
  const dir = selftuneDir(root);
  const lines = [];
  lines.push("selftune state");
  const knobs = Object.entries(st.knobs ?? {});
  lines.push(`  knobs: ${knobs.length ? knobs.map(([k, v]) => `${k}=${v}`).join(", ") : "(none — all config values)"}`);
  if (st.pending) {
    lines.push(`  pending: ${st.pending.knob} ${st.pending.from} → ${st.pending.to} (applied ${new Date(st.pending.appliedTs).toISOString().slice(0, 16)})`);
    lines.push(`    rationale: ${st.pending.rationale}`);
  } else {
    lines.push("  pending: none");
  }
  lines.push(`  counts: ${JSON.stringify(st.counts)}`);
  lines.push(`  noise floor: ${st.noise?.aaDeltaPct == null ? "unmeasured" : `${st.noise.aaDeltaPct}% (samples: ${st.noise.samples?.length ?? 0})`}`);
  lines.push(`  baseline recalls/turn: ${st.baseline?.recallsPerTurn != null ? st.baseline.recallsPerTurn.toFixed(3) : "unmeasured"}`);
  lines.push(`  last analysis: ${st.lastTs?.analysis ? new Date(st.lastTs.analysis).toISOString() : "never"}`);
  lines.push(`  last verify: ${st.lastTs?.verify ? new Date(st.lastTs.verify).toISOString() : "never"}`);
  lines.push(`  dir: ${dir}`);
  return lines.join("\n");
}
