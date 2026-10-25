#!/usr/bin/env node
// Detached self-tuning verifier — spawned by the plugin with stdio ignored
// and detached from the OpenCode process, so a verification run survives the
// user closing the session mid-run. Responsibilities:
//
//   1. optionally refresh the A/A noise floor first (identical configs both
//      legs — every delta it finds is provider noise, not signal),
//   2. run the bench plugin-vs-plugin: OFF leg carries the pre-apply values,
//      ON leg the provisional proposal (built from state.json, so the plugin
//      never has to pass knob values through the spawn argv),
//   3. apply the verdict: keep or revert, ledger + state written here.
//
// Failures exit non-zero but stay quiet (stdio is ignored); the plugin-side
// state machine retries via the normal scheduling path.

import { verifyPlan, runVerify, runNoise, resolveVerify, refreshBaseline, appendLedger, readState } from "../lib/selftune.mjs";
import path from "node:path";

function arg(name, def = null) {
  const argv = process.argv.slice(2);
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? def : argv[i + 1];
}

const root = path.resolve(arg("root") ?? path.join(process.env.HOME ?? "", ".opencode", "contextpacks"));
const repo = path.resolve(arg("repo") ?? path.resolve(new URL("..", import.meta.url).pathname));
const reps = Number(arg("reps", 2)) || 2;
const withNoise = process.argv.includes("--with-noise");

try {
  // A/A first when the floor is unmeasured — the verify judge then runs
  // against a real noise number instead of the conservative default.
  if (withNoise) {
    const n = runNoise({ root, repo, reps: 4 });
    appendLedger(root, { kind: "noise-refresh", ok: n.ok, pct: n.pct ?? null });
  }
  const st = readState(root);
  if (!st.pending) {
    appendLedger(root, { kind: "verify-stray", reason: "child found no pending proposal" });
    process.exit(0);
  }
  const plan = verifyPlan(root);
  const run = runVerify({ root, repo, reps, setoffs: plan.setoffs, sets: plan.sets });
  await resolveVerify({ root, verdict: run.payload, log: console.error, reps });
  refreshBaseline(root, console.error);
  process.exit(0);
} catch (e) {
  // No ledger here: runVerify/resolveVerify own their state transitions, and a
  // crash before any of them ran must not fabricate events.
  console.error(String(e?.stack ?? e));
  process.exit(1);
}
