// Price integrity: the table must be able to prove itself against the bill.
// Two mechanisms, both regression-tested here:
//   hydrateFromOpencodeModels() — overlay prices from OpenCode's own catalog
//   auditPrices()               — recover the rate OpenCode actually charged
//                                 and flag drift from our table
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PRICES, hydrateFromOpencodeModels, auditPrices, priceRow } from "../lib/cost.mjs";

let DatabaseSync = null;
try {
  ({ DatabaseSync } = await import("node:sqlite"));
} catch { /* older Node — the audit test is skipped below */ }

function catalog(obj) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "babyzilla-cat-"));
  const file = path.join(dir, "models.json");
  fs.writeFileSync(file, JSON.stringify(obj));
  return { dir, file };
}

test("hydrate overlays prices from the opencode catalog", () => {
  const { dir, file } = catalog({
    "ollama-cloud": {
      models: {
        "made-up-model": { cost: { input: 2, output: 8, cache_read: 0.2 } },
        "no-price-model": { cost: {} },
      },
    },
  });
  try {
    assert.equal(PRICES["made-up-model"], undefined);
    assert.equal(hydrateFromOpencodeModels({ file }), 1, "only rows with input+output count");
    assert.deepEqual(PRICES["made-up-model"], [2, 0.2, 8]);
    assert.equal(PRICES["no-price-model"], undefined, "incomplete cost rows are skipped");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    delete PRICES["made-up-model"];
  }
});

test("hydrate tolerates a missing or broken catalog", () => {
  assert.equal(hydrateFromOpencodeModels({ file: "/nonexistent/models.json" }), 0);
  const { dir, file } = catalog({ "ollama-cloud": { models: null } });
  try {
    assert.equal(hydrateFromOpencodeModels({ file }), 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function messageDb({ model, cost, input, cache, output }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "babyzilla-audit-"));
  const dbPath = path.join(dir, "opencode.db");
  const db = new DatabaseSync(dbPath);
  db.exec(`create table session_message (
    id text primary key, session_id text, type text, seq integer,
    time_created integer, time_updated integer, data text)`);
  const ins = db.prepare("insert into session_message values (?,?,?,?,?,?,?)");
  ins.run("m1", "ses_1", "assistant", 1, 0, 0, JSON.stringify({
    model: { id: model, providerID: "ollama-cloud" },
    cost,
    tokens: { input, output, cache: { read: cache } },
  }));
  db.close();
  return { dir, dbPath };
}

test("audit recovers the charged rate and flags drift", { skip: !DatabaseSync && "node:sqlite needs Node >= 22.5" }, () => {
  // glm-5.2 table = 1.40 in / 0.26 cached / 4.40 out. Bill at 2x input.
  const model = "glm-5.2";
  const t = priceRow(model);
  const inTok = 1_000_000;
  const cacheTok = 2_000_000;
  const outTok = 100_000;
  const billedAt = (k) => (
    inTok * t.input * k + cacheTok * t.cached * k + outTok * t.output * k
  ) / 1e6;

  const exact = messageDb({ model, cost: billedAt(1), input: inTok, cache: cacheTok, output: outTok });
  try {
    const [row] = auditPrices({ dbPath: exact.dbPath });
    assert.equal(row.status, "ok");
    assert.ok(Math.abs(row.ratio - 1) < 0.01, `ratio ${row.ratio}`);
  } finally {
    fs.rmSync(exact.dir, { recursive: true, force: true });
  }

  const doubled = messageDb({ model, cost: billedAt(2), input: inTok, cache: cacheTok, output: outTok });
  try {
    const [row] = auditPrices({ dbPath: doubled.dbPath });
    assert.equal(row.status, "mismatch");
    assert.ok(Math.abs(row.ratio - 2) < 0.02, `expected 2x drift, got ${row.ratio}`);
    assert.ok(Math.abs(row.billed.input - t.input * 2) < 0.01, "billed input should be recovered");
  } finally {
    fs.rmSync(doubled.dir, { recursive: true, force: true });
  }
});

test("audit reports unpriced models instead of guessing", { skip: !DatabaseSync && "node:sqlite needs Node >= 22.5" }, () => {
  const d = messageDb({ model: "totally-unknown", cost: 0.5, input: 1000, cache: 0, output: 100 });
  try {
    const [row] = auditPrices({ dbPath: d.dbPath });
    assert.equal(row.status, "no-price");
    assert.equal(row.billed, null);
  } finally {
    fs.rmSync(d.dir, { recursive: true, force: true });
  }
});
