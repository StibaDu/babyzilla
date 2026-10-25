// Self-tuning analysis prompt + output parsing.
//
// One cheap model call turns recorded telemetry into at most one bounded knob
// change. Everything the model sees is real recorded data; everything it may
// change is a numeric knob inside a hard clamp. Prompts, contract text, model
// routing and compression algorithms are out of reach by construction — the
// caller validates the parsed answer against the knob table before applying.
//
// This module is stdlib-only and contains no model transport: the caller passes
// its own `call(prompt)` (the plugin wires ctx-driven session generation, the
// CLI can wire anything). Keeping transport out means tests run without network
// and the analysis contract is testable in isolation.

// Fixed instructions block. The output contract isexact: one JSON object, one
// line, nothing else — parseAnalysis relies on it.
export const SELF_LEARN_INSTRUCTIONS = `You are the self-tuning analyst for BabyZilla, an OpenCode plugin that compresses tool output to reduce cost.

Objective: reduce price-weighted cost without degrading task quality.

Protected invariants (never trade cost for these):
- Marker/task retrieval must stay perfect (quality gate in bench runs).
- Recall round-trips must not grow: a recall means compression hid something the agent then had to re-fetch.
- Duplicate tool calls must not grow: the agent re-running the same step usually means it lost the earlier result.

Respond with EXACTLY ONE JSON object on ONE line, nothing else:
{"noop":true,"rationale":"<one short sentence>"} — no change needed
{"knob":"<name>","to":<number>,"rationale":"<one short sentence>"} — propose one knob change

Rules:
- Only knobs from the KNOBS table provided below.
- New value must be inside [min, max].
- Prefer small steps over revolutions; explain the evidence in the rationale.
- If the recent evidence is thin or contradictory, answer noop.`;

// Compact the recorded data into the prompt. Deliberately tiny numbers, no
// chains-of-anything — the model is steering one knob, not writing plans.
export function buildAnalysisPrompt({ summary, knobs, clamps, noiseFloorPct = null }) {
  const k = [];
  for (const [name, spec] of Object.entries(clamps)) {
    k.push(`  ${name}: current=${knobs[name] ?? "config-default"} min=${spec.min} max=${spec.max}${spec.int ? " int" : ""}`);
  }
  const sessions = (summary.sessions ?? []).slice(-8).map((s) => {
    const t = s.tokens ?? {};
    const parts = [
      `sid=${String(s.sid ?? "").slice(0, 14)}`,
      `turns=${s.turns ?? 0}`,
      `requests=${s.requests ?? 0}`,
      `inK=${Math.round((t.input ?? 0) / 1000)}`,
      `cacheK=${Math.round((t.cached ?? 0) / 1000)}`,
      `outK=${Math.round((t.output ?? 0) / 1000)}`,
    ];
    if (s.cost != null) parts.push(`cost=$${Number(s.cost).toFixed(4)}`);
    if (s.resets) parts.push(`resets=${s.resets}`);
    if (s.recalls) parts.push(`recalls=${s.recalls}`);
    if (s.repeats?.length) parts.push(`dup=${s.repeats.slice(0, 2).map((r) => `${r.tool}x${r.n}`).join(",")}`);
    if (s.compress?.length) parts.push(`paged=${s.compress.slice(0, 3).map((r) => `${r.tool}:${fmtCd(r)}`).join(",")}`);
    if (s.distills?.length) parts.push(`distill=sess:${s.distills.length},fed~${Math.round((s.distills[0].fed ?? 0) / 1000)}K`);
    if (s.model) parts.push(`model=${s.model}`);
    return "  " + parts.join(" ");
  });
  const ledger = (summary.ledger ?? []).slice(-8).map((e) =>
    `  ${e.ts ?? ""} ${e.kind ?? "?"}${e.knob ? ` knob=${e.knob} from=${e.from} to=${e.to}` : ""}${e.why ? ` why=${String(e.why).slice(0, 90)}` : ""}${e.reason ? ` reason=${String(e.reason).slice(0, 90)}` : ""}`,
  );
  return [
    SELF_LEARN_INSTRUCTIONS,
    "",
    `KNOBS (clamp list, current values):`,
    k.join("\n"),
    "",
    `Noise floor (paired A/B delta that is indistinguishable from luck): ${noiseFloorPct == null ? "unknown — be conservative" : `${noiseFloorPct}%`}`,
    "",
    "RECENT SESSIONS (oldest first):",
    sessions.length ? sessions.join("\n") : "  (none recorded yet)",
    "",
    "RECENT AUTOTUNE LEDGER (oldest first):",
    ledger.length ? ledger.join("\n") : "  (empty)",
    "",
    "Answer now: one JSON object, one line.",
  ].join("\n");
}

function fmtCd(c) {
  const saved = (c.saved ?? 0) / 1000;
  return `${c.n ?? 1}x-${saved >= 10 ? Math.round(saved) : saved.toFixed(1)}K`;
}

// Parse the analyst's answer. Returns
//   { ok: true, kind: "noop",    rationale } |
//   { ok: true, kind: "proposal", knob, to, rationale } |
//   { ok: false, reason } — unparseable or shape-invalid (caller logs and
//                            records it; it must never be silently dropped).
export function parseAnalysis(text) {
  const raw = String(text ?? "");
  let obj = null;
  try {
    obj = JSON.parse(raw.trim());
  } catch {
    const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(raw);
    const braces = /\{[\s\S]*\}/.exec(fenced ? fenced[1] : raw);
    if (braces) {
      try { obj = JSON.parse(braces[0]); } catch { /* fallthrough */ }
    }
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    return { ok: false, reason: `not a JSON object (head: ${raw.slice(0, 160).replace(/\s+/g, " ")})` };
  }
  const rationale = typeof obj.rationale === "string" ? obj.rationale.slice(0, 300) : "";
  if (obj.noop === true) return { ok: true, kind: "noop", rationale };
  const knob = typeof obj.knob === "string" ? obj.knob : null;
  const to = obj.to;
  if (!knob) return { ok: false, reason: "missing knob" };
  if (typeof to !== "number" || !Number.isFinite(to)) return { ok: false, reason: `missing numeric 'to' for knob ${knob}` };
  if (typeof obj.noop !== "undefined" && obj.noop !== false) return { ok: false, reason: "ambiguous noop with knob" };
  return { ok: true, kind: "proposal", knob, to, rationale };
}

// Normalize a model reference the same way index.js does, so both composable
// callers agree on {providerID, id} or null.
export function normalizeModelRef(m) {
  if (!m) return null;
  const providerID = m.providerID;
  const id = m.id ?? m.modelID;
  return providerID && id ? { providerID, id } : null;
}
