// Calibration: how far `estTokens` (chars/4) drifts from what the provider bills.
//
// Every absolute number in BabyZilla rests on one heuristic — the per-request
// budget floor/cap, the proactive-compaction trigger, the "X% smaller" in
// `babyzilla stats`. chars/4 is right for English prose and wrong for code,
// JSON and German: same bytes, different tokenizer.
//
// Bundling a real tokenizer per provider was the alternative (see
// deepseek-recipe / `tokenizer.json`). Rejected: multi-MB asset, one model
// family only, and encoding a 100K-token context on every request costs more
// than the compression it is meant to guide. The provider already tells us the
// truth — `tokens.input + tokens.cache.read` in OpenCode's database — so this
// module measures the bias instead of guessing a replacement.
//
// Split of duties, on purpose:
//   • the request path appends one ~120-byte JSONL line (no database reads);
//   • `babyzilla calibrate` pairs those lines with billed usage offline;
//   • the plugin reads only the small `calibration.json` that command writes.
//
// The factor is `billed / estimated`: 1.3 means the provider charged 30% more
// tokens than we counted, so a 45K-token budget is 34.6K in estimate space.

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import { estTokens, estimateMessagesTokens } from "./text.mjs";

/** Where the learned factors live, relative to the pack root. */
export const CALIBRATION_FILE = "calibration.json";
/** Where request samples accumulate, relative to the pack root. */
export const LEDGER_FILE = path.join("calibration", "requests.jsonl");

/** Below this many paired requests a model keeps the default factor of 1. */
export const MIN_SAMPLES = 12;
/** A factor outside this band is more likely a pairing bug than a tokenizer. */
export const FACTOR_MIN = 0.6;
export const FACTOR_MAX = 1.8;
/** Requests smaller than this are mostly system prompt + tool schemas. */
export const MIN_EST_TOKENS = 8_000;
/** The bias we want is the bias on messages, which is what the budget governs. */
export const MIN_MESSAGE_SHARE = 0.4;
/** Ledger cap: a runaway file must not become a disk problem. */
const LEDGER_MAX_BYTES = 4 * 1024 * 1024;

export const calibrationPath = (root) => path.join(root, CALIBRATION_FILE);
export const ledgerPath = (root) => path.join(root, LEDGER_FILE);

const num = (v) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);

// ── the request side ────────────────────────────────────────────────────────

// Tool schemas are large and stable within a session, so they are stringified
// once per session rather than on every request. The key count is the cheap
// invalidation signal: MCP servers connecting mid-session change it.
const toolEstCache = new Map();

/** Estimated tokens of the tool definitions in one request. */
export function toolsEstimate(sessionID, tools) {
  if (!tools || typeof tools !== "object") return 0;
  let names;
  try {
    names = Object.keys(tools).length;
  } catch {
    return 0;
  }
  const hit = toolEstCache.get(sessionID);
  if (hit && hit.names === names) return hit.tokens;
  let tokens = 0;
  try {
    tokens = estTokens(JSON.stringify(tools));
  } catch {
    tokens = 0;
  }
  toolEstCache.set(sessionID, { names, tokens });
  return tokens;
}

/**
 * What one outgoing request is estimated to cost, split so the analysis can
 * tell a message-heavy request from one dominated by tool schemas.
 *
 * `event` is the `context` hook payload (`system`, `messages`, `tools`); these
 * are exactly the three things the provider bills as input.
 */
export function requestEstimate(event, { sessionID } = {}) {
  const system = Array.isArray(event?.system) ? event.system : [];
  let systemTokens = 0;
  for (const part of system) {
    if (typeof part === "string") systemTokens += estTokens(part);
    else if (typeof part?.text === "string") systemTokens += estTokens(part.text);
  }
  const messages = estimateMessagesTokens(event?.messages);
  const tools = toolsEstimate(sessionID ?? event?.sessionID, event?.tools);
  return { system: systemTokens, messages, tools, total: systemTokens + messages + tools };
}

/**
 * Append one sample to the ledger. Fire-and-forget by contract: a calibration
 * line is never worth a failed request, and the caller must not await it.
 */
export function recordRequest(root, row) {
  try {
    const line = JSON.stringify(row);
    if (!line || line.length > 4_000) return;
    const file = ledgerPath(root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fsp.appendFile(file, line + "\n").catch(() => {});
    rotateLedger(file);
  } catch {
    /* measurement must never reach a turn */
  }
}

// Stat at most every 512 writes: cheap, and enough to keep the file bounded.
let writesSinceCheck = 0;
function rotateLedger(file) {
  if (++writesSinceCheck < 512) return;
  writesSinceCheck = 0;
  try {
    const { size } = fs.statSync(file);
    if (size <= LEDGER_MAX_BYTES) return;
    const keep = fs.readFileSync(file, "utf8").split("\n").slice(-2_000).join("\n");
    fs.writeFileSync(file, keep.endsWith("\n") ? keep : keep + "\n");
  } catch {
    /* a broken ledger is not a broken turn */
  }
}

/** Read the ledger back. Malformed lines are skipped, not fatal. */
export function readLedger(root) {
  let text = "";
  try {
    text = fs.readFileSync(ledgerPath(root), "utf8");
  } catch {
    return [];
  }
  const rows = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (!row?.sid || !num(row.at) || !num(row.est)) continue;
    rows.push(row);
  }
  return rows;
}

// ── pairing with what the provider billed ───────────────────────────────────

/** Quantile of a sorted numeric list; `q` in [0,1]. */
function quantile(sorted, q) {
  if (!sorted.length) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/**
 * Pair each recorded estimate with the usage row the provider recorded for that
 * request.
 *
 * Within a session both sides are ordered and one-to-one, so the match is a
 * two-pointer walk with a time window. The window is what makes it robust: a
 * request that never produced a billed row (aborted, interrupted) simply leaves
 * its neighbours correctly paired instead of shifting every later sample.
 */
export function pairSamples(ledger, usage, { toleranceMs = 30_000 } = {}) {
  const bySession = new Map();
  for (const u of usage ?? []) {
    if (!u?.sid || !num(u.at) || !num(u.billed)) continue;
    if (!bySession.has(u.sid)) bySession.set(u.sid, []);
    bySession.get(u.sid).push(u);
  }
  for (const rows of bySession.values()) rows.sort((a, b) => a.at - b.at);

  const entries = [...(ledger ?? [])]
    .filter((e) => e?.sid && num(e.at) && num(e.est))
    .sort((a, b) => a.at - b.at);

  const samples = [];
  for (const entry of entries) {
    const rows = bySession.get(entry.sid);
    if (!rows?.length) continue;
    const at = Number(entry.at);
    let i = 0;
    while (i < rows.length && rows[i].at < at - toleranceMs) i++;
    const row = rows[i];
    if (!row || row.at > at + toleranceMs) continue;
    rows.splice(i, 1); // one billed row per request
    if (!num(row.billed)) continue;
    samples.push({
      sid: entry.sid,
      model: row.model || entry.model || "unknown",
      at,
      est: Number(entry.est),
      billed: Number(row.billed),
      ratio: Number(row.billed) / Number(entry.est),
      messages: num(entry.msg),
      total: num(entry.est),
    });
  }
  return samples;
}

/**
 * Turn paired samples into one factor per model.
 *
 * The filters are the honest part: a short request is dominated by the system
 * prompt and the tool schemas, so its ratio says more about them than about the
 * messages the budget governs. Samples below `minEst` or with less than
 * `minMessageShare` of their tokens in messages are counted but not used — the
 * report shows how many were skipped rather than quietly averaging them in.
 */
export function summarize(samples, {
  minSamples = MIN_SAMPLES,
  minEst = MIN_EST_TOKENS,
  minMessageShare = MIN_MESSAGE_SHARE,
  factorMin = FACTOR_MIN,
  factorMax = FACTOR_MAX,
} = {}) {
  const groups = new Map();
  let skipped = 0;
  let outliers = 0;
  for (const s of samples ?? []) {
    if (!s || !num(s.est) || !num(s.billed)) { skipped++; continue; }
    if (s.est < minEst) { skipped++; continue; }
    if (s.messages / s.est < minMessageShare) { skipped++; continue; }
    // A ratio of 5x or 0.2x is a mispair, not a tokenizer.
    if (!(s.ratio > 0.2 && s.ratio < 5)) { outliers++; continue; }
    if (!groups.has(s.model)) groups.set(s.model, []);
    groups.get(s.model).push(s.ratio);
  }

  const models = {};
  for (const [model, ratios] of groups) {
    const sorted = [...ratios].sort((a, b) => a - b);
    const median = quantile(sorted, 0.5);
    const factor = Math.round(Math.min(factorMax, Math.max(factorMin, median)) * 1_000) / 1_000;
    models[model] = {
      samples: sorted.length,
      median: Math.round(median * 1_000) / 1_000,
      p25: Math.round(quantile(sorted, 0.25) * 1_000) / 1_000,
      p90: Math.round(quantile(sorted, 0.9) * 1_000) / 1_000,
      factor,
      applied: sorted.length >= minSamples,
      clamped: factor !== Math.round(median * 1_000) / 1_000,
      needed: Math.max(0, minSamples - sorted.length),
    };
  }
  return { models, paired: (samples ?? []).length, skipped, outliers, minSamples };
}

// ── persistence ─────────────────────────────────────────────────────────────

/** Read the learned factors. A missing or broken file means "no correction". */
export function readCalibration(root) {
  try {
    const raw = JSON.parse(fs.readFileSync(calibrationPath(root), "utf8"));
    const models = {};
    for (const [k, v] of Object.entries(raw?.models ?? {})) {
      const factor = Number(v?.factor);
      if (Number.isFinite(factor) && factor > 0 && v?.applied) {
        models[k] = { ...v, factor };
      }
    }
    return { updated: raw?.updated ?? null, models };
  } catch {
    return { updated: null, models: {} };
  }
}

/** Write the factors atomically (a half-written file must never be read). */
export function writeCalibration(root, data) {
  const file = calibrationPath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  const body = {
    updated: new Date().toISOString(),
    note: "billed/estimated token ratio per model, learned by `babyzilla calibrate`",
    models: data?.models ?? {},
  };
  fs.writeFileSync(tmp, JSON.stringify(body, null, 2) + "\n");
  fs.renameSync(tmp, file);
  return body;
}

/** Drop the learned factors (the ledger is kept). */
export function resetCalibration(root) {
  try {
    fs.unlinkSync(calibrationPath(root));
    return true;
  } catch {
    return false;
  }
}

/**
 * Keep the ledger useful and small: paired samples have already been folded into
 * a factor, so only recent ones are worth re-measuring. Unpaired entries get a
 * day's grace, because the usage row is written after the response.
 */
export function pruneLedger(root, samples, { maxAgeMs = 7 * 86_400_000, unpairedGraceMs = 86_400_000 } = {}) {
  const rows = readLedger(root);
  if (!rows.length) return 0;
  const paired = new Set((samples ?? []).map((s) => `${s.sid}@${s.at}`));
  const now = Date.now();
  const keep = rows.filter((e) => {
    const age = now - (Number(e.at) || 0);
    if (age > maxAgeMs) return false;
    if (paired.has(`${e.sid}@${e.at}`)) return true;
    return age <= unpairedGraceMs;
  });
  if (keep.length === rows.length) return 0;
  try {
    const file = ledgerPath(root);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, keep.map((r) => JSON.stringify(r)).join("\n") + (keep.length ? "\n" : ""));
    fs.renameSync(tmp, file);
  } catch {
    return 0;
  }
  return rows.length - keep.length;
}

/**
 * The factor for one model id, tolerant of the shapes OpenCode uses
 * (`provider/model`, `model:variant`, `model#effort`). Unknown models get 1,
 * which is exactly the old behaviour.
 */
export function factorFor(calibration, modelID) {
  const models = calibration?.models ?? {};
  const id = String(modelID ?? "").replace(/^[^/]+\//, "");
  if (!id) return 1;
  if (models[id]?.factor) return models[id].factor;
  const base = id.replace(/[:#].*$/, "").replace(/-free$/, "");
  if (models[base]?.factor) return models[base].factor;
  // A factor learned on `model:variant` still answers for plain `model` (and
  // the other way round): variants share a tokenizer.
  for (const [k, v] of Object.entries(models)) {
    if (v?.factor && k.replace(/[:#].*$/, "").replace(/-free$/, "") === base) return v.factor;
  }
  const hit = Object.keys(models)
    .filter((k) => id.startsWith(k))
    .sort((a, b) => b.length - a.length)[0];
  return hit ? models[hit].factor : 1;
}
