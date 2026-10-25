// Provider-side spend, from OpenCode's own usage records.
//
// BabyZilla's request stats count *message* tokens (an estimate). This module
// reports what the provider actually billed: input, cached input, output and
// cost, straight from ~/.local/share/opencode/opencode.db.
//
// Prices are USD per million tokens. `PRICES` is the offline fallback; on
// startup it is overlaid with the `ollama-cloud` block of OpenCode's own
// catalog (~/.cache/opencode/models.json), which is the same metadata the host
// bills against — so estimates follow upstream instead of drifting.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/** USD per million tokens: [input, cachedInput, output].
 *
 *  Source of truth: the `ollama-cloud` block of OpenCode's own catalog
 *  (`~/.cache/opencode/models.json`), which is also what the host bills
 *  against. `hydrateFromOpencodeModels()` overlays it at load time when
 *  present; this table is the offline fallback and must agree with it.
 *  Rows marked "billed" were verified against recorded session costs. */
export const PRICES = {
  "deepseek-v4.1-flash": [0.15, 0.003, 0.60], // billed: was 2x too high
  "deepseek-v4.1-pro": [1.32, 0.044, 3.96],
  "deepseek-v4-flash": [0.22, 0.007, 0.66], // billed: was 2x too high
  "deepseek-v4-pro": [0.66, 0.022, 1.98], // billed: was 2x too high
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
  // Added 2026-10-25 when the cloud list was scraped; corrected against
  // OpenCode's catalog (the scrape under/overstated several by 2x).
  // NOTE: ollama cloud publishes no per-token price for `beam` (free with paid
  // plan / usage credits), so it is intentionally absent → priceFor → null.
  "minimax-m3.1-flash": [0.15, 0.015, 0.60], // billed: cache rate was 2x too high
  "mistral-large-4": [1.36, 0.14, 4.18], // billed: was 2x too low
  "muse-spark-open": [1.25, 0.125, 4.25],
  "nemotron-3-ultra": [0.10, 0.10, 3.00],
  "nemotron-3-super": [0.015, 0.015, 0.60],
  "qwen3.5:397b": [0.60, 0.60, 3.60],
  "gpt-oss:120b": [0.15, 0.014, 0.60],
  "gpt-oss:20b": [0.07, 0.035, 0.30],
  clef: [0.24, 0, 0],
};

/** Overlay prices from OpenCode's own catalog when it is readable, so the
 *  table above can never silently drift from what the host actually bills.
 *  Returns the number of rows overlaid; 0 when the cache is absent. */
export function hydrateFromOpencodeModels({ file } = {}) {
  const cache = file ?? path.join(
    process.env.XDG_CACHE_HOME || (process.platform === "win32"
      ? (process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"))
      : path.join(os.homedir(), ".cache")),
    "opencode", "models.json");
  let models;
  try {
    models = JSON.parse(fs.readFileSync(cache, "utf8"))?.["ollama-cloud"]?.models;
  } catch {
    return 0;
  }
  if (!models || typeof models !== "object") return 0;
  let n = 0;
  for (const [id, v] of Object.entries(models)) {
    const c = v?.cost;
    if (!c || c.input == null || c.output == null) continue;
    PRICES[id] = [c.input, c.cache_read ?? c.input, c.output];
    n++;
  }
  return n;
}

hydrateFromOpencodeModels();

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

/** Scale check: with the table's *structure* (cache and output priced relative
 *  to input) held fixed, solve the one free scale factor that explains the
 *  recorded spend. k≈1 → the table matches the bill. A wrong absolute price
 *  lands on k≈2 or k≈0.5; a wrong cache ratio shows up as k drift whenever
 *  cached tokens dominate (which is the normal case for agent sessions).
 *  A full 3-parameter fit is deliberately NOT used: input/cached/output grow
 *  together across sessions, so it is collinear and returns noise. */
function fitScale(rows, table) {
  const rCache = table[1] / table[0];
  const rOut = table[2] / table[0];
  let num = 0;
  let den = 0;
  for (const row of rows) {
    const x = (row.input + rCache * row.cache + rOut * row.output) / 1e6;
    num += x * row.cost;
    den += x * x;
  }
  if (!(den > 0)) return null;
  const k = num / den;
  return Number.isFinite(k) && k > 0 ? k : null;
}

/** Self-check: does the price table still match what the provider billed?
 *  Returns per-model rows flagged `ok` | `mismatch` | `no-price` | `no-data`. */
export function auditPrices({ dbPath = defaultDbPath(), tolerance = 0.15, minSpend = 0.01 } = {}) {
  if (!fs.existsSync(dbPath)) throw new Error(`no OpenCode database at ${dbPath}`);
  const db = openDb(dbPath);
  const agg = new Map();
  try {
    // Per-request rows are the only sound basis: the aggregated `session`
    // table counts tokens differently from the cost it records, so fitting
    // against it yields noise (k≈0.1 for every model).
    const table = ["session_message", "message_part", "session_v2", "session"]
      .find((t) => hasTable(db, t));
    if (!table) throw new Error(`no usage table in ${dbPath}`);
    const rows = table === "session_message" || table === "message_part"
      ? db.prepare(`select session_id, data from ${table}`).all()
          .map((r) => {
            try {
              return JSON.parse(r.data);
            } catch {
              return null;
            }
          })
          .filter((d) => d && d.model && d.tokens && d.cost)
          .map((d) => ({
            model: d.model,
            cost: d.cost,
            input: num(d.tokens.input),
            cache: num(d.tokens.cache?.read),
            output: num(d.tokens.output),
          }))
      : db.prepare(`select model, cost, tokens_input as input, tokens_cache_read as cache, tokens_output as output from ${table}`)
          .all()
          .map((r) => {
            let model = null;
            try {
              model = JSON.parse(r.model || "null");
            } catch {}
            return { model, cost: r.cost, input: num(r.input), cache: num(r.cache), output: num(r.output) };
          });
    for (const r of rows) {
      if (!r.model?.id || !r.cost) continue;
      const key = `${r.model.providerID || "?"}/${r.model.id}`;
      const a = agg.get(key) || { id: r.model.id, cost: 0, input: 0, cache: 0, output: 0, rows: [] };
      a.cost += r.cost;
      a.input += r.input;
      a.cache += r.cache;
      a.output += r.output;
      a.rows.push({ input: r.input, cache: r.cache, output: r.output, cost: r.cost });
      agg.set(key, a);
    }
  } finally {
    db.close();
  }

  const out = [];
  for (const [key, a] of agg) {
    if (a.cost < minSpend) continue;
    const table = priceFor(a.id);
    const implied = table ? fitScale(a.rows, table) : null;
    const ratio = table && implied != null ? implied / table[0] : null;
    const status = !table ? "no-price"
      : ratio == null ? "no-data"
      : Math.abs(ratio - 1) <= tolerance ? "ok" : "mismatch";
    out.push({
      model: key,
      spent: a.cost,
      input: a.input,
      cache: a.cache,
      output: a.output,
      table: table ? { input: table[0], cached: table[1], output: table[2] } : null,
      billed: implied == null
        ? null
        : {
            input: implied,
            cached: implied * (table[1] / table[0]),
            output: implied * (table[2] / table[0]),
          },
      ratio,
      status,
    });
  }
  return out.sort((x, y) => y.spent - x.spent);
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
