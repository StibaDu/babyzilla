// ModelDB — the local knowledge base for every model on Ollama Cloud.
//
// Data lives in lib/modeldb.json (see docs/MODELDB.md for the human-facing
// textbook). Numbers (USD/1M) are NOT duplicated here — lib/cost.mjs's PRICES
// stays the single source of truth for money, exactly like for `babyzilla cost`.
//
// Deliberately runtime-optional: nothing in index.js imports this yet. It is
// consumed by the `babyzilla models` CLI and can be imported by any agent that
// wants to reason about lane choices:
//
//   import { loadDB, pickLanes, explain, catalogCompat } from "babyzilla/modeldb";
//
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { PRICES } from "./cost.mjs";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
export const dbPath = path.join(moduleDir, "modeldb.json");
export const overridesPath = () =>
  path.join(os.homedir(), ".config", "babyzilla", "modeldb.overrides.json");

const STALE_DAYS = 30;
export const CAPS = new Set(["text", "tools", "thinking", "vision", "audio", "decision"]);

/** Resolve USD/1M [in, cachedIn, out] for any id incl. variants, mirroring
 *  lib/cost.mjs's variant-stripping ("glm-5.3-flash:2" → glm-5.3-flash). */
export function priceForId(id) {
  const key = String(id || "").replace(/^[^/]+\//, "");
  if (PRICES[key]) return PRICES[key];
  const base = key.replace(/[:#].*$/, "").replace(/-free$/, "");
  if (PRICES[base]) return PRICES[base];
  const hit = Object.keys(PRICES).find((k) => key.startsWith(k));
  return hit ? PRICES[hit] : null;
}

function mergeOverrides(topLevel, overPath) {
  if (!existsSync(overPath)) return;
  try {
    const over = JSON.parse(readFileSync(overPath, "utf8"));
    for (const [id, patch] of Object.entries(over || {})) {
      if (!topLevel[id] || typeof patch !== "object") continue;
      Object.assign(topLevel[id], patch);
    }
  } catch {
    // Overrides are optional; a broken overrides file must not break the DB load.
  }
}

/** Overlay authoritative limits/caps/prices from OpenCode's own catalog for
 *  the ids it covers. The shipped JSON carries the *knowledge* (use cases,
 *  verified behaviour, prices fallback); this carries the *numbers*, because
 *  the same metadata drives the host's billing. Ids absent from the cache
 *  (newest models) keep the shipped values — `catalogCompat()` reports those.
 *  Returns { hydrated, source } for the CLI footer. */
export function hydrateFromOpencodeModels(models, { file } = {}) {
  const cache = file ?? path.join(
    process.env.XDG_CACHE_HOME || (process.platform === "win32"
      ? (process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"))
      : path.join(os.homedir(), ".cache")),
    "opencode", "models.json");
  let catalog;
  try {
    catalog = JSON.parse(readFileSync(cache, "utf8"))?.["ollama-cloud"]?.models;
  } catch {
    return { hydrated: 0, source: null };
  }
  if (!catalog || typeof catalog !== "object") return { hydrated: 0, source: null };
  let n = 0;
  for (const m of models) {
    const hit = catalog[m.id] ?? catalog[m.id.replace(/[:#].*$/, "")];
    if (!hit) continue;
    const c = hit.cost;
    if (c?.input != null && c?.output != null) {
      m.price = [c.input, c.cache_read ?? c.input, c.output];
    }
    const lim = hit.limit;
    if (lim?.context) m.context = lim.context;
    if (lim?.output) m.maxOutput = lim.output;
    const mods = hit.modalities?.input;
    if (Array.isArray(mods)) {
      m.caps = { ...(m.caps || {}), text: mods.includes("text"), vision: mods.includes("image") };
    }
    if (typeof hit.tool_call === "boolean") m.caps = { ...(m.caps || {}), tools: hit.tool_call };
    if (typeof hit.reasoning === "boolean") m.caps = { ...(m.caps || {}), thinking: hit.reasoning };
    m.source = "opencode-cache";
    n++;
  }
  return { hydrated: n, source: cache };
}

/** Load the DB (with optional user overrides merged by id from
 *  ~/.config/babyzilla/modeldb.overrides.json) and hydrate numbers from
 *  OpenCode's catalog. Returns { meta, models: [], hydrated }. */
export function loadDB({ overrides, hydrate = true } = {}) {
  const db = JSON.parse(readFileSync(dbPath, "utf8"));
  mergeOverrides(db, overrides || overridesPath());
  const models = Object.entries(db)
    .filter(([k, v]) => k !== "meta" && v && typeof v === "object")
    .map(([id, v]) => ({ id, ...v, price: priceForId(id) }));
  const h = hydrate ? hydrateFromOpencodeModels(models) : { hydrated: 0, source: null };
  return { meta: db.meta, models, hydrated: h.hydrated, source: h.source };
}

export function isStale(db) {
  const d = new Date(`${db.meta.fetched}T12:00:00Z`).getTime();
  return d < Date.now() - STALE_DAYS * 864e5;
}

const DEFAULT_LANES = [
  {
    name: "main.standard",
    ranks: [
      { id: "glm-5.2", why: "proven main lane (standing decision until Beam head-to-head)" },
      { id: "glm-5.3", why: "newest GLM flagship" },
      { id: "beam", why: "free heavy-lifter" },
      { id: "minimax-m3.1-flash", why: "cheap multimodal agentic" },
    ],
  },
  {
    name: "main.budget",
    ranks: [
      { id: "beam", why: "501B-class reasoning, free on the plan, 1M ctx" },
      { id: "nemotron-3-ultra", why: "cheap input for long-context agentic loops" },
    ],
  },
  {
    name: "main.premium",
    ranks: [
      { id: "kimi-k3", why: "most capable multimodal agent on the index" },
      { id: "muse-spark-open", why: "816B multimodal flagship" },
    ],
  },
  {
    name: "flash",
    ranks: [
      { id: "glm-5.3-flash", why: "cheapest 1M thinking+tools (vision as a bonus)" },
      { id: "minimax-m3.1-flash", why: "agentic flash with vision" },
      { id: "nemotron-3-nano:30b", why: "cheapest output of any thinking model" },
    ],
  },
  {
    name: "flash.inheavy",
    ranks: [
      { id: "nemotron-3-super", why: "cheapest input tokens ($0.015) with thinking" },
      { id: "nemotron-3-ultra", why: "next-cheap input, still reasoning" },
    ],
  },
  {
    name: "vision.standard",
    ranks: [
      { id: "gemma4:31b", why: "only general-purpose vision chat model, cheap (Low usage)" },
      { id: "glm-5.3-flash", why: "multimodal fallback with 1M ctx" },
      { id: "minimax-m3.1-flash", why: "multimodal fallback" },
    ],
  },
  {
    name: "vision.premium",
    ranks: [
      { id: "kimi-k3", why: "top multimodal reasoning" },
      { id: "muse-spark-open", why: "native multimodal flagship" },
      { id: "kimi-k2.7-code", why: "vision + coding focus" },
    ],
  },
  {
    name: "distill.standard",
    ranks: [
      { id: "glm-5.3-flash", why: "cheap, smart, long context" },
      { id: "minimax-m3.1-flash", why: "same class" },
      { id: "nemotron-3-super", why: "cheapest summarizer: read much, write short" },
    ],
  },
  {
    name: "special.decision",
    ranks: [{ id: "clef:27b", why: "typed-question decision API (systemone), not standard chat" }],
  },
  {
    name: "embed",
    ranks: [], // no embedding models served on ollama cloud (2026-10-25)
  },
];

/** Approved lane picks with reasons. Model ranks degrade in order until one
 *  exists in `db`. Passing a tailored `lanes` list customizes the policy. */
export function pickLanes(db, { lanes = DEFAULT_LANES } = {}) {
  const have = new Set(db.models.map((m) => m.id));
  return lanes.map((lane) => {
    const hit = lane.ranks.find((r) => have.has(r.id));
    return hit
      ? { lane: lane.name, id: hit.id, why: hit.why }
      : { lane: lane.name, id: null, why: "no preferred model present in catalog" };
  });
}

/** Cross-check the DB against the host's available model ids. */
export function catalogCompat(db, ids) {
  const have = new Set(db.models.map((m) => m.id));
  const known = new Set(Array.isArray(ids) ? ids : []);
  return {
    missingInDB: [...known].filter((x) => !have.has(x)),
    notInCatalog: [...have].filter((x) => !known.has(x)),
  };
}

function capsBadges(m) {
  return [
    m.caps?.text ? "T" : "",
    m.caps?.thinking ? "K" : "",
    m.caps?.tools ? "G" : "",
    m.caps?.vision ? "V" : "",
  ].filter(Boolean).join("");
}

/** CLI text: `babyzilla models` → table, `--lanes` → lane picks, `--json` → data. */
export function explain(db, { json = false, lanes: wantLanes = false } = {}) {
  const picks = pickLanes(db);
  const stale = isStale(db);
  if (json) return { lanes: picks, models: db.models, stale };
  let out = "";
  if (wantLanes) {
    out += "Lane picks (ranks degrade by what the host catalog offers):\n\n";
    for (const l of picks) {
      out += `  ${l.lane.padEnd(17)} ${String(l.id ?? "(none)").padEnd(24)} ${l.why}\n`;
    }
    out += "\n";
  }
  const rows = db.models.map((m) => {
    const p = m.price
      ? `$${m.price[0].toFixed(2)}/$${m.price[2].toFixed(2)}`
      : (m.free ? "free*" : "?");
    return [m.id, capsBadges(m), m.context ? `${Math.round(m.context / 1024)}K` : "?", m.usage || "-", p];
  });
  const w = [0, 0, 0, 0, 0].map((_, i) => Math.max(...rows.map((r) => String(r[i]).length), 5));
  out += ["MODEL", "CAPS", "CTX", "USAGE", "$IN/$OUT"].map((h, i) => h.padEnd(w[i])).join("  ") + "\n";
  for (const r of rows) out += r.map((c, i) => String(c).padEnd(w[i])).join("  ") + "\n";
  out += "\ncaps: T=text K=thinking G=tools V=vision · * = free with paid plan/usage credits\n";
  out += `db fetched ${db.meta.fetched}${stale ? " (STALE — refresh per docs/MODELDB.md)" : ""}`;
  out += db.hydrated
    ? ` · ${db.hydrated} model(s) hydrated from OpenCode's catalog\n`
    : " · offline table only (no ~/.cache/opencode/models.json)\n";
  return out;
}
