// Provider-cost accounting — pure math plus a throwaway SQLite database.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { estimateCost, priceRow, sessionCosts, totals } from "../lib/cost.mjs";

// node:sqlite shipped in Node 22.5; keep the rest of the suite runnable on 18/20.
let DatabaseSync = null;
try {
  ({ DatabaseSync } = await import("node:sqlite"));
} catch { /* older Node — the database test is skipped below */ }

test("estimateCost uses input, cached and output rates", () => {
  const usage = { input: 1_000_000, cacheRead: 1_000_000, output: 1_000_000 };
  const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);
  close(estimateCost(usage, "deepseek-v4.1-flash"), 0.3 + 0.006 + 1.2);
  close(estimateCost(usage, "ollama-cloud/glm-5.2"), 1.4 + 0.26 + 4.4);
});

test("estimateCost accepts variants, providers and unknown names", () => {
  const usage = { input: 1_000_000, output: 0, cacheRead: 0 };
  assert.equal(estimateCost(usage, "deepseek-v4.1-flash:1017"), 0.3);
  assert.equal(estimateCost(usage, "ollama-cloud/deepseek-v4.1-flash"), 0.3);
  assert.equal(estimateCost(usage, "some-model"), null);
});

test("priceRow exposes a named shape", () => {
  assert.deepEqual(priceRow("glm-5.3-flash"), { input: 0.15, cached: 0.03, output: 0.5 });
  assert.equal(priceRow("nope"), null);
});

function tempDb(rows) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "babyzilla-cost-"));
  const dbPath = path.join(dir, "opencode.db");
  const db = new DatabaseSync(dbPath);
  db.exec(`create table session_v2 (
    id text primary key, parent_id text, agent text, model text, cost real,
    tokens_input integer, tokens_output integer, tokens_reasoning integer,
    tokens_cache_read integer, tokens_cache_write integer, time_updated integer)`);
  const insert = db.prepare(`insert into session_v2 values (?,?,?,?,?,?,?,?,?,?,?)`);
  for (const r of rows) {
    insert.run(
      r.id, r.parent_id ?? null, r.agent ?? null, JSON.stringify(r.model ?? null),
      r.cost ?? 0, r.input ?? 0, r.output ?? 0, r.reasoning ?? 0,
      r.cacheRead ?? 0, 0, r.time ?? 0,
    );
  }
  db.close();
  return { dir, dbPath };
}

test("sessionCosts groups usage, sorts by cost and filters by prefix", { skip: !DatabaseSync && "node:sqlite needs Node >= 22.5" }, () => {
  const { dir, dbPath } = tempDb([
    {
      id: "ses_aaa111", agent: "build", model: { id: "glm-5.2", providerID: "ollama-cloud" },
      input: 1_000_000, cacheRead: 1_000_000, output: 100_000, cost: 2,
    },
    {
      id: "ses_bbb222", agent: "plan", model: { id: "deepseek-v4.1-flash:1017", providerID: "ollama-cloud" },
      input: 2_000_000, cacheRead: 10_000_000, output: 500_000, cost: 1,
    },
  ]);
  try {
    const all = sessionCosts({ dbPath });
    assert.equal(all.length, 2);
    assert.equal(all[0].sessionID, "ses_aaa111");
    assert.equal(all[0].cacheHitPct, 50);
    assert.equal(all[0].priced, true);

    const t = totals(all);
    assert.equal(t.input, 3_000_000);
    assert.equal(t.cached, 11_000_000);
    assert.equal(t.output, 600_000);
    assert.equal(t.recordedCost, 3);
    assert.equal(t.estimatedCost, all[0].estimatedCost + all[1].estimatedCost);

    const one = sessionCosts({ dbPath, filter: "ses_bbb" });
    assert.equal(one.length, 1);
    assert.equal(one[0].agent, "plan");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
