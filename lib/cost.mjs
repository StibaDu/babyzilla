// Provider-side spend, from OpenCode's own usage records.
//
// BabyZilla's request stats count *message* tokens (an estimate). This module
// reports what the provider actually billed: input, cached input, output and
// cost, straight from ~/.local/share/opencode/opencode.db.
//
// Prices are USD per million tokens (https://ollama.com/pricing, standard
// rates). Off-peak Ollama Cloud rates are roughly half; treat these numbers as
// an upper bound.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/** USD per million tokens: [input, cachedInput, output]. */
export const PRICES = {
  "deepseek-v4.1-flash": [0.30, 0.006, 1.20],
  "deepseek-v4.1-pro": [1.32, 0.044, 3.96],
  "deepseek-v4-flash": [0.44, 0.014, 1.32],
  "deepseek-v4-pro": [1.32, 0.044, 3.96],
  "deepseek-v3.1": [0.44, 0.014, 1.32],
  "glm-5.3": [1.40, 0.26, 4.40],
  "glm-5.3-flash": [0.15, 0.03, 0.50],
  "glm-5.2": [1.40, 0.26, 4.40],
  "glm-5.1": [1.00, 0.20, 3.20],
  "kimi-k3": [3.00, 0.30, 15.00],
  "kimi-k2.7-code": [0.95, 0.19, 4.00],
  "kimi-k2.6": [0.95, 0.16, 4.00],
  "minimax-m3": [0.60, 0.12, 2.40],
  "minimax-m2.7": [0.30, 0.06, 1.20],
  "mistral-large-3": [0.50, 0.50, 1.50],
  "nemotron-3-nano": [0.06, 0.06, 0.24],
  gemma4: [0.14, 0.05, 0.40],
  // Rows added 2026-10-25 from ollama.com/search?c=cloud (input/output verbatim;
  // cached-input rates estimated per vendor family, see lib/modeldb.json facts).
  // NOTE: ollama cloud publishes no per-token price for `beam` (free with paid
  // plan / usage credits), so it is intentionally absent → priceFor → null.
  "minimax-m3.1-flash": [0.15, 0.03, 0.60],
  "mistral-large-4": [0.68, 0.68, 2.09],
  "muse-spark-open": [1.25, 0.125, 4.25],
  "gpt-oss:120b": [0.15, 0.014, 0.60],
  "gpt-oss:20b": [0.07, 0.035, 0.30],
  clef: [0.24, 0, 0],
};

export function defaultDbPath() {
  if (process.env.OPENCODE_DB) return process.env.OPENCODE_DB;
  const dataHome = process.env.XDG_DATA_HOME ||
    (process.platform === "win32" && process.env.LOCALAPPDATA) ||
    path.join(os.homedir(), ".local", "share");
  return path.join(dataHome, "opencode", "opencode.db");
}

function priceFor(model) {
  const id = String(model || "").replace(/^[^/]+\//, "");
  if (PRICES[id]) return PRICES[id];
  // Unknown variants (`:1017`, `-free`, `#high`) still share the base model.
  const base = id.replace(/[:#].*$/, "").replace(/-free$/, "");
  if (PRICES[base]) return PRICES[base];
  const hit = Object.keys(PRICES)
    .filter((k) => id.startsWith(k))
    .sort((a, b) => b.length - a.length)[0];
  return hit ? PRICES[hit] : null;
}

const num = (v) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);

/** Estimated USD for one usage record. Returns null when the model is unknown. */
export function estimateCost(usage, model) {
  const p = priceFor(model);
  if (!p) return null;
  const input = num(usage.input);
  const cached = num(usage.cacheRead);
  const output = num(usage.output);
  return (input * p[0] + cached * p[1] + output * p[2]) / 1_000_000;
}

export function priceRow(model) {
  const p = priceFor(model);
  return p ? { input: p[0], cached: p[1], output: p[2] } : null;
}

export function openDb(dbPath) {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require("node:sqlite"));
  } catch {
    throw new Error("`babyzilla cost` needs Node >= 22.5 (node:sqlite)");
  }
  return new DatabaseSync(dbPath, { readOnly: true });
}

export function hasTable(db, name) {
  try {
    return !!db.prepare("select 1 from sqlite_master where type='table' and name=?").get(name);
  } catch {
    return false;
  }
}

/**
 * Provider usage grouped by session.
 *
 * `filter` is an optional session-id prefix. Results are ordered by estimated
 * cost (or recorded cost when the model has no price row).
 */
export function sessionCosts({ dbPath = defaultDbPath(), filter = null, limit = 50 } = {}) {
  if (!fs.existsSync(dbPath)) throw new Error(`no OpenCode database at ${dbPath}`);
  const db = openDb(dbPath);
  try {
    const table = hasTable(db, "session_v2") ? "session_v2" : hasTable(db, "session") ? "session" : null;
    if (!table) throw new Error(`no session usage table in ${dbPath} — this OpenCode version is not supported`);
    const rows = db
      .prepare(
        `select id, parent_id, agent, model, cost,
                tokens_input, tokens_output, tokens_reasoning,
                tokens_cache_read, tokens_cache_write
           from ${table}
          where (tokens_input + tokens_output + tokens_cache_read) > 0
            and (? is null or id like ? || '%')
          order by time_updated desc`,
      )
      .all(filter, filter);

    const sessions = rows.map((r) => {
      let model = null;
      try {
        model = JSON.parse(r.model || "null");
      } catch {
        model = null;
      }
      const modelId = model?.id || null;
      const provider = model?.providerID || null;
      const usage = {
        input: r.tokens_input,
        output: r.tokens_output,
        reasoning: r.tokens_reasoning,
        cacheRead: r.tokens_cache_read,
        cacheWrite: r.tokens_cache_write,
      };
      const prompt = num(usage.input) + num(usage.cacheRead);
      const est = estimateCost(usage, modelId);
      return {
        sessionID: r.id,
        parentID: r.parent_id || null,
        agent: r.agent || null,
        model: modelId ? (provider ? `${provider}/${modelId}` : modelId) : "unknown",
        recordedCost: num(r.cost),
        estimatedCost: est,
        usage,
        promptTokens: prompt,
        cacheHitPct: prompt ? (num(usage.cacheRead) / prompt) * 100 : 0,
        outputSharePct: prompt + num(usage.output)
          ? (num(usage.output) / (prompt + num(usage.output))) * 100
          : 0,
        priced: est !== null,
      };
    });

    sessions.sort(
      (a, b) =>
        (b.estimatedCost ?? b.recordedCost) - (a.estimatedCost ?? a.recordedCost) ||
        b.promptTokens - a.promptTokens,
    );
    return sessions.slice(0, Math.max(1, limit));
  } finally {
    db.close();
  }
}

export function totals(sessions) {
  const t = {
    sessions: sessions.length,
    input: 0,
    cached: 0,
    output: 0,
    prompt: 0,
    estimatedCost: 0,
    recordedCost: 0,
    unpriced: 0,
  };
  for (const s of sessions) {
    t.input += s.usage.input;
    t.cached += s.usage.cacheRead;
    t.output += s.usage.output;
    t.prompt += s.promptTokens;
    t.recordedCost += s.recordedCost;
    if (s.estimatedCost === null) t.unpriced++;
    else t.estimatedCost += s.estimatedCost;
  }
  t.cacheHitPct = t.prompt ? (t.cached / t.prompt) * 100 : 0;
  return t;
}
