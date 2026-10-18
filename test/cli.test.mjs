// BabyZilla CLI tests — node:test, zero deps.
// Mirrors the semantics of the Rust `lowfat pack` implementation.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  loadPacks, loadPack, renderStats, renderPack, statsJson,
  scanRefs, parseRefToken, isUncertainPath, resolveFirst,
  parseDuration, prunePlan, libraryStats, renderVerify, savingsPct,
  retrieve, aggregateRequestStats,
} from "../bin/babyzilla.mjs";

// ── fixture helpers ─────────────────────────────────────────────────────────

function fakePack(root, id, created, raw, pack, modules = null, extra = {}) {
  const dir = path.join(root, "sessions", id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(dir + "/index.json", JSON.stringify({
    sessionID: id, created,
    model: { providerID: "ollama-cloud", id: "glm-5.2" },
    stats: { rawTokens: raw, packTokens: pack, savedPct: Math.round((1 - pack / raw) * 100) },
    rawTranscriptTokens: raw,
    modules,
    ...extra,
  }, null, 2));
  return dir;
}

const moduleRow = (name, file, kind, tokens, hot, p) =>
  ({ name, kind, file, tokens, hot, triggers: ["x"], path: p });

// ── load & order ────────────────────────────────────────────────────────────

test("loadPacks orders newest first and parses stats", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bz-t1-"));
  fakePack(tmp, "ses_0001", "2026-10-01T10:00:00.000Z", 1000, 100);
  fakePack(tmp, "ses_0002", "2026-10-16T10:00:00.000Z", 2000, 200);
  const packs = loadPacks(tmp);
  assert.equal(packs.length, 2);
  assert.equal(packs[0].sessionId, "ses_0002"); // newest first
  assert.equal(packs[0].rawTokens, 2000);
  assert.equal(packs[1].packTokens, 100);
  assert.equal(packs[0].model, "ollama-cloud/glm-5.2");
});

test("loadPack falls back to dir name and max() of raw token fields", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bz-t2-"));
  const dir = fakePack(tmp, "ses_x", "2026-10-16T00:00:00.000Z", 5000, 50);
  const pack = loadPack(dir);
  assert.equal(pack.sessionId, "ses_x");
  assert.equal(pack.rawTokens, 5000);
});

test("journal entries and tokens are summed", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bz-t3-"));
  const dir = fakePack(tmp, "ses_j", "2026-10-16T00:00:00.000Z", 10, 5);
  fs.writeFileSync(dir + "/journal.jsonl",
    JSON.stringify({ t: 1, tool: "ls", status: "completed", tokens: 100, head: "x" }) + "\n" +
    JSON.stringify({ t: 2, tool: "grep", status: "error", tokens: 50, head: "y" }) + "\n" +
    "{\"torn\":"); // tolerate torn tail line
  const [entries, tokens] = loadPack(dir) && (() => {
    // use the exported render to check journal numbers surface correctly
    const pack = loadPack(dir);
    return [pack.journalEntries, pack.journalTokens];
  })();
  assert.deepEqual([entries, tokens], [2, 150]);
});

// ── stats rendering ─────────────────────────────────────────────────────────

test("renderStats aggregates and shows library counts", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bz-t4-"));
  fakePack(tmp, "ses_a", "2026-10-01T10:00:00.000Z", 100_000, 8_000);
  const lib = path.join(tmp, "library", "proj");
  fs.mkdirSync(lib, { recursive: true });
  fs.writeFileSync(lib + "/index.json", JSON.stringify({ modules: [{ name: "m1" }] }));
  const out = renderStats(tmp);
  assert.match(out, /92\.0%/);
  assert.match(out, /100\.0K/);
  assert.match(out, /library/);
  assert.match(out, /\/ 1 modules/);
});

test("renderStats friendly message when empty", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bz-t5-"));
  assert.match(renderStats(tmp), /No context packs/);
});

test("statsJson contains per-session rows with savedPct", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bz-t6-"));
  fakePack(tmp, "ses_a", "2026-10-01T10:00:00.000Z", 100_000, 8_000);
  const json = statsJson(tmp);
  assert.equal(json.sessions, 1);
  assert.equal(json.savedPct, 92);
  assert.equal(json.perSession[0].savedPct, 92);
});

test("savingsPct handles zero raw", () => {
  assert.equal(savingsPct({ rawTokens: 0, packTokens: 0 }), 0);
});

test("aggregateRequestStats sums Layer 1b counters and renderStats shows them", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bz-t6b-"));
  fakePack(tmp, "ses_req", "2026-10-18T10:00:00.000Z", 1000, 100);
  fs.writeFileSync(
    path.join(tmp, "sessions", "ses_req", "request-stats.json"),
    JSON.stringify({ requests: 7, before: 700_000, after: 80_000, savedPct: 89, last: { before: 100_000, after: 11_000, savedPct: 89 } }),
  );
  const req = aggregateRequestStats(tmp);
  assert.equal(req.requests, 7);
  assert.equal(req.sessions, 1);
  assert.equal(req.savedPct, 88.6);
  const out = renderStats(tmp);
  assert.match(out, /Layer 1b/);
  assert.match(out, /7/);
  assert.equal(statsJson(tmp).requests.requests, 7);
  assert.equal(loadPack(path.join(tmp, "sessions", "ses_req")).requestStats.requests, 7);
});

// ── pointer scanning ────────────────────────────────────────────────────────

test("scanRefs basic", () => {
  const refs = scanRefs(
    "- src/auth.ts:40 → fixed\n- /Users/x/y.rs:12\n- no ref here\n- ~/conf.json:9\n- path without ext:12\n- token.md:3,");
  assert.deepEqual(refs[0], ["src/auth.ts", 40]);
  assert.deepEqual(refs[1], ["/Users/x/y.rs", 12]);
  assert.ok(refs.some(([t, l]) => t.endsWith("conf.json") && l === 9));
  assert.ok(!refs.some(([t]) => t === "ext"));
  assert.ok(refs.some(([t, l]) => t.endsWith("token.md") && l === 3));
});

test("parseRefToken rejects numbers with zero or non-digit suffixes", () => {
  assert.equal(parseRefToken("a.ts:"), null);
  assert.equal(parseRefToken("a.ts:x4"), null);
  assert.equal(parseRefToken("a.ts:0"), null); // lines are 1-based
  assert.deepEqual(parseRefToken("a.ts:7"), ["a.ts", 7]);
});

test("isUncertainPath skips bare extensions only", () => {
  assert.ok(isUncertainPath(".ts"));
  assert.ok(!isUncertainPath("src/auth.ts"));
  assert.ok(!isUncertainPath("a/.ts")); // has a path component
});

// ── resolve chain ───────────────────────────────────────────────────────────

test("resolveFirst walks projectDir → packDir → cwd and reports misses", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bz-t7-"));
  const project = path.join(tmp, "myproj");
  fs.mkdirSync(path.join(project, "src"), { recursive: true });
  fs.writeFileSync(path.join(project, "src", "auth.ts"), "a\nb\nc\n");
  const bases = [project, path.join(tmp, "packdir")];
  assert.equal(fs.existsSync(resolveFirst("src/auth.ts", bases)), true);
  assert.equal(resolveFirst("src/auth.ts", []), null); // empty bases → null
  const miss = resolveFirst("missing.rs", bases);
  assert.equal(fs.existsSync(miss), false); // falls back to last base for reporting
});

// ── verify end-to-end ───────────────────────────────────────────────────────

test("renderVerify: ok pointer counted, broken flagged, uncertain skipped", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bz-t8-"));
  const project = path.join(tmp, "myproj");
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, "auth.ts"), "a\nb\nc\n");

  const packDir = fakePack(tmp, "ses_v", "2026-10-16T00:00:00.000Z", 100, 10, [
    moduleRow("code", "code.md", "code", 10, false, ""),
  ], { projectDir: project });
  fs.writeFileSync(path.join(packDir, "code.md"),
    "fixed at auth.ts:2\nbroken at auth.ts:9\ngone at deleted.rs:1\nalso .ts:120 fragment\n");
  const idxPath = path.join(packDir, "index.json");
  const idx = JSON.parse(fs.readFileSync(idxPath, "utf8"));
  idx.modules[0].path = path.join(packDir, "code.md");
  fs.writeFileSync(idxPath, JSON.stringify(idx, null, 2));

  const out = renderVerify("ses_v", tmp);
  assert.match(out, /1\/3 ok/);          // auth.ts:2 ok; :9 stale; deleted.rs missing
  assert.match(out, /auth\.ts:9 .file has 3 lines./);
  assert.match(out, /deleted\.rs:1 .file missing./);
  assert.ok(!out.includes(".ts:120"));    // uncertain fragment skipped
  assert.ok(!out.includes("✓ all"));      // something is broken
});

test("renderVerify: all-good pack prints green summary", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bz-t9-"));
  const project = path.join(tmp, "proj");
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, "a.ts"), "x\ny\n");
  const packDir = fakePack(tmp, "ses_ok", "2026-10-16T00:00:00.000Z", 50, 5, [
    moduleRow("c", "c.md", "code", 5, false, ""),
  ], { projectDir: project });
  fs.writeFileSync(path.join(packDir, "c.md"), "see a.ts:2\n");
  const idxPath = path.join(packDir, "index.json");
  const idx = JSON.parse(fs.readFileSync(idxPath, "utf8"));
  idx.modules[0].path = path.join(packDir, "c.md");
  fs.writeFileSync(idxPath, JSON.stringify(idx, null, 2));
  const out = renderVerify("ses_ok", tmp);
  assert.match(out, /✓ all 1 pointers resolve/);
});

// ── library stats ───────────────────────────────────────────────────────────

test("libraryStats counts projects and modules", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bz-t10-"));
  const lib = path.join(tmp, "library", "p1");
  fs.mkdirSync(lib, { recursive: true });
  fs.writeFileSync(lib + "/index.json", JSON.stringify({ modules: [{ name: "a" }, { name: "b" }] }));
  assert.deepEqual(libraryStats(tmp), [1, 2]);
});

// ── prune ───────────────────────────────────────────────────────────────────

test("parseDuration accepts h/d/w/m/y and rejects junk", () => {
  assert.equal(parseDuration("30d"), 30 * 86400);
  assert.equal(parseDuration("2w"), 14 * 86400);
  assert.equal(parseDuration("3m"), 90 * 86400);
  assert.equal(parseDuration("24h"), 86400);
  assert.equal(parseDuration("1y"), 365 * 86400);
  assert.equal(parseDuration("10x"), null);
  assert.equal(parseDuration("d"), null);
  assert.equal(parseDuration("-5d"), null);
});

test("prunePlan selects only packs older than cutoff", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bz-t11-"));
  const oldDir = fakePack(tmp, "ses_old", "2026-09-01T10:00:00.000Z", 10, 5);
  const newDir = fakePack(tmp, "ses_new", "2026-10-16T10:00:00.000Z", 10, 5);
  const now = Date.now() / 1000;
  fs.utimesSync(oldDir + "/index.json", new Date((now - 40 * 86400) * 1000), new Date((now - 40 * 86400) * 1000));
  fs.utimesSync(newDir + "/index.json", new Date(now * 1000), new Date(now * 1000));
  const { removed, kept } = prunePlan(tmp, now - 30 * 86400, now);
  assert.equal(removed.length, 1);
  assert.equal(removed[0].sessionId, "ses_old");
  assert.equal(kept.length, 1);
});

// ── show ────────────────────────────────────────────────────────────────────

test("renderPack includes hot/cold markers, triggers, journal line", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bz-t12-"));
  const dir = fakePack(tmp, "ses_s", "2026-10-16T12:00:00.000Z", 72_200, 1200, [
    moduleRow("00-state", "00-state.md", "state", 316, true, path.join(os.tmpdir(), "n.md")),
    moduleRow("topic", "topic-x.md", "topic", 125, false, path.join(os.tmpdir(), "n2.md")),
  ]);
  const out = renderPack(loadPack(dir));
  assert.match(out, /98\.3%/);
  assert.match(out, /● hot/);
  assert.match(out, /○ cold/);
  assert.match(out, /tool results/);
});
// ── retrieve ────────────────────────────────────────────────────────────────

function tmpFile(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bz-ret-"));
  const file = path.join(dir, "sample.txt");
  fs.writeFileSync(file, lines.join("\n") + "\n");
  return file;
}

test("retrieve prints an exact numbered range", () => {
  const file = tmpFile(Array.from({ length: 10 }, (_, i) => `line ${i + 1}`));
  const out = retrieve(`${file}:3-5`);
  assert.match(out, /lines 3-5 of 10/);
  assert.match(out, /\n3: line 3\n4: line 4\n5: line 5\n/);
});

test("retrieve without a range starts at 1 and caps at maxLines", () => {
  const file = tmpFile(Array.from({ length: 50 }, (_, i) => `line ${i + 1}`));
  const out = retrieve(file, { maxLines: 5 });
  assert.match(out, /lines 1-5 of 50/);
  assert.match(out, /more lines/);
});

test("retrieve expands around a single line with context", () => {
  const file = tmpFile(Array.from({ length: 20 }, (_, i) => `line ${i + 1}`));
  const out = retrieve(`${file}:10`, { context: 2 });
  assert.match(out, /lines 8-12 of 20/);
});

test("retrieve accepts file:// and clamps to end of file", () => {
  const file = tmpFile(["a", "b", "c"]);
  const out = retrieve(`file://${file}:2-99`);
  assert.match(out, /lines 2-3 of 3/);
  assert.match(out, /3: c/);
});

test("retrieve rejects a missing ref or file", () => {
  assert.throws(() => retrieve(undefined), /usage: babyzilla retrieve/);
  assert.throws(() => retrieve("/definitely/not/here:1"), /ENOENT/);
});

test("the CLI runs when reached through a symlink on PATH", (t) => {
  // Windows needs developer mode/admin for symlinks and has no shebang exec;
  // the PATH install there is the npm shim, so this case does not apply.
  if (process.platform === "win32") return t.skip("POSIX symlink semantics");
  // `~/.local/bin/babyzilla -> bin/babyzilla.mjs` is the normal install. The
  // main guard must realpath argv[1], otherwise the process exits silently.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bz-link-"));
  const link = path.join(dir, "babyzilla");
  fs.symlinkSync(fileURLToPath(new URL("../bin/babyzilla.mjs", import.meta.url)), link);
  const res = spawnSync(link, ["--version"], { encoding: "utf8" });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /^babyzilla \d+\.\d+\.\d+/);
});
