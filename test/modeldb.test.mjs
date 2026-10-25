// Test the model knowledge base: data integrity, lane picks, catalog compat,
// and price delegation to lib/cost.mjs (single source of truth for money).
import test from "node:test";
import assert from "node:assert/strict";
import { loadDB, pickLanes, catalogCompat, priceForId, explain, isStale, dbPath } from "../lib/modeldb.mjs";
import { readFileSync } from "node:fs";

const db = loadDB();

test("modeldb: JSON is valid, ids unique, required fields present", () => {
  const raw = JSON.parse(readFileSync(dbPath, "utf8"));
  assert.ok(raw.meta.version >= 1 && raw.meta.fetched);
  const ids = Object.keys(raw).filter((k) => k !== "meta");
  assert.ok(ids.length >= 20, `expected ~22 catalog entries, got ${ids.length}`);
  for (const id of ids) {
    const m = raw[id];
    assert.ok(m.caps && typeof m.caps.text === "boolean", `${id}: caps.text required`);
    for (const k of Object.keys(m.caps)) assert.ok(["text", "tools", "thinking", "vision", "audio", "decision"].includes(k), `${id}: unknown cap ${k}`);
    assert.ok(m.context === null || (Number.isInteger(m.context) && m.context > 0), `${id}: bad context`);
    assert.ok(!("released" in m) || /^\d{4}-\d{2}-\d{2}$/.test(m.released), `${id}: released must be YYYY-MM-DD`);
    assert.ok(Array.isArray(m.facts) && m.facts.length >= 1, `${id}: facts required`);
    assert.ok(Array.isArray(m.useFor), `${id}: useFor required`);
    assert.ok(Array.isArray(m.avoidFor), `${id}: avoidFor required`);
  }
});

test("modeldb: every documented cloud id from /api/tags style list is covered", () => {
  const both = loadDB({});
  const have = new Set(both.models.map((m) => m.id));
  for (const id of [
    "beam", "glm-5.2", "glm-5.3", "glm-5.3-flash", "gemma4:31b",
    "minimax-m2.7", "minimax-m3.1-flash", "muse-spark-open",
    "kimi-k3", "kimi-k2.7-code", "kimi-k2.6", "deepseek-v4.1-flash", "deepseek-v4-pro:0813",
    "mistral-large-4", "mistral-large-3:675b", "nemotron-3-ultra", "nemotron-3-super",
    "nemotron-3-nano:30b", "clef:27b", "gpt-oss:120b", "gpt-oss:20b",
  ]) {
    assert.ok(have.has(id), `missing entry for ${id}`);
  }
});

test("modeldb: prices delegate to cost.mjs PRICES with variant fallback", () => {
  assert.deepEqual(priceForId("glm-5.3-flash"), [0.15, 0.03, 0.5]);
  assert.deepEqual(priceForId("deepseek-v4.1-flash:1017"), priceForId("deepseek-v4.1-flash"));
  assert.deepEqual(priceForId("gemma4:31b"), priceForId("gemma4"));
  assert.deepEqual(priceForId("minimax-m3.1-flash"), [0.15, 0.015, 0.6], "m3.1 must NOT inherit m3 pricing");
  assert.equal(priceForId("beam"), null, "beam is free-with-plan, no per-token price");
  assert.equal(priceForId("totally-unknown-model"), null);
});

test("modeldb: pickLanes returns a pick for every lane, descending rank order", () => {
  const picks = pickLanes(db);
  const laneNames = picks.map((p) => p.lane);
  assert.ok(laneNames.includes("main.standard") && laneNames.includes("flash") && laneNames.includes("vision.standard"));
  for (const p of picks) {
    if (!p.id) continue; // embed lane has no ranks
    assert.ok(db.models.some((m) => m.id === p.id), `lane ${p.lane} picked unknown id ${p.id}`);
  }
  const main = picks.find((p) => p.lane === "main.standard");
  assert.equal(main.id, "glm-5.2", "standing decision: glm-5.2 stays main default");
  const budget = picks.find((p) => p.lane === "main.budget");
  assert.equal(budget.id, "beam");
});

test("modeldb: pickLanes degrades when a model is unavailable", () => {
  const ids = db.models.filter((m) => m.id !== "glm-5.2" && m.id !== "beam").map((m) => m.id);
  const small = { meta: db.meta, models: db.models.filter((m) => ids.includes(m.id)) };
  const picks = pickLanes(small);
  assert.equal(picks.find((p) => p.lane === "main.standard").id, "glm-5.3", "proven pick gone → newest GLM");
  const empty = { meta: db.meta, models: [] };
  assert.ok(pickLanes(empty).every((p) => p.id === null), "empty catalog → every lane null");
  const embed = pickLanes(empty).find((p) => p.lane === "embed");
  assert.equal(embed.id, null);
});

test("modeldb: catalogCompat flags both directions", () => {
  const ids = ["glm-5.2", "gemma4:31b", "brand-new-model"];
  const c = catalogCompat(db, ids);
  assert.ok(c.missingInDB.includes("brand-new-model"));
  assert.ok(!c.missingInDB.includes("glm-5.2"));
  assert.ok(c.notInCatalog.includes("beam"), "beam known but not offered by this fake host");
});

test("modeldb: explainer renders table and lane text without crashing", () => {
  const text = explain(db, {});
  assert.ok(text.includes("MODEL") && text.includes("free*") && text.includes("db fetched"));
  const lanes = explain(db, { lanes: true });
  assert.ok(lanes.includes("main.standard") && lanes.includes("distill.standard"));
  const json = explain(db, { json: true });
  assert.equal(typeof json, "object");
  assert.ok(json.models.length === db.models.length);
});

test("modeldb: staleness windows off the fetched date", () => {
  assert.equal(isStale({ meta: { fetched: "2999-01-01" } }), false);
  assert.equal(isStale({ meta: { fetched: "2006-01-01" } }), true);
});
