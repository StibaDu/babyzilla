#!/usr/bin/env node
// BabyZilla CLI — inspect ContextPack session data.
// Zero dependencies, node:stdlib only. Same core logic as the Rust
// `lowfat pack` companion; data lives in ~/.opencode/contextpacks/.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

// `babyzilla pet status | head` closes the pipe; a stack trace is not an answer
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (error) => { if (error.code === "EPIPE") process.exit(0); });
}
import { sessionCosts, totals, defaultDbPath, openDb, hasTable, auditPrices } from "../lib/cost.mjs";
import { readPage, prunePages } from "../lib/pages.mjs";
import { extractProbes, scorePack, missingFactsModule } from "../lib/eval.mjs";
import { loadDB, explain as explainModels } from "../lib/modeldb.mjs";
import {
  checkForUpdate, readUpdateCache, shouldNotify, markNotified, renderUpdateNotice,
  applyUpdate, disabled as updatesDisabled, UPDATE_INTERVAL_MS, RETRY_AFTER_MS,
} from "../lib/updates.mjs";
import {
  inspectConfig, planSetup, probe, applyConfig, locateConfig, configCandidates,
} from "../lib/setup.mjs";
import { emit as petEmit, petDir as petStateDir, eventsPath } from "../lib/pet.mjs";
import { thought as thoughtLine } from "../lib/pet-thought.mjs";
import { MARKS, readMark, writeMark } from "../lib/pet-mark.mjs";
import { VOICES, VOICE_IDS, resolveVoice } from "../lib/pet-voice.mjs";
import { LANGUAGES, isLanguage, resolveLanguage } from "../lib/pet-lang.mjs";
import { catalog as petCatalog, pickPets, findPet, isRemoteSource } from "../lib/pet-catalog.mjs";
import { installPetSource } from "../pet/pet-package.mjs";
import { tool } from "../lib/tool.mjs";
import { EXPRESSIONS, byId as expressionById } from "../pet/expressions.mjs";
import {
  renderStatus, runVerify as runVerifyBench, runReplayBench, verifyPlan, resolveVerify, runNoise,
  refreshBaseline, manualRevert, readState as readSelftuneState, noteRecallRendered,
  buildSummaryData,
} from "../lib/selftune.mjs";

// ── colors & formatting ─────────────────────────────────────────────────────

const BOLD = "\x1b[1m", DIM = "\x1b[2m", RESET = "\x1b[0m";
const GREEN = "\x1b[32m", CYAN = "\x1b[36m", YELLOW = "\x1b[33m", RED = "\x1b[31m";
const NO_COLOR = !process.stdout.isTTY || !!process.env.NO_COLOR;
const c = (code) => (NO_COLOR ? "" : code);

const fmtTokens = (n) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M`
  : n >= 1_000 ? `${(n / 1_000).toFixed(1)}K`
  : String(n);

const savingsColor = (pct) =>
  pct >= 70 ? c(GREEN) : pct >= 40 ? c(YELLOW) : "";

// ── data resolution ─────────────────────────────────────────────────────────

export function packRoot() {
  const env = process.env.BABYZILLA_ROOT;
  if (env) return path.resolve(env);
  return path.join(os.homedir(), ".opencode", "contextpacks");
}

const sessionsRoot = (root) => path.join(root, "sessions");
const libraryRoot = (root) => path.join(root, "library");

// ── pack model ──────────────────────────────────────────────────────────────

const asNum = (v) =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;

/** Parse index.json + journal.jsonl inside a session pack directory. */
export function loadPack(dir) {
  let idx;
  try {
    idx = JSON.parse(fs.readFileSync(path.join(dir, "index.json"), "utf8"));
  } catch {
    return null;
  }
  const sessionId = idx.sessionID || path.basename(dir);
  const pid = idx.model?.providerID ?? "", mid = idx.model?.id ?? "";
  const model = mid ? (pid ? `${pid}/${mid}` : mid) : "unknown";
  const rawTokens = Math.max(asNum(idx.stats?.rawTokens), asNum(idx.rawTranscriptTokens));
  const modules = Array.isArray(idx.modules)
    ? idx.modules.map((m) => ({
        file: m.file || m.path?.split("/").pop() || "",
        kind: m.kind || "",
        tokens: asNum(m.tokens),
        hot: m.hot === true,
        triggers: Array.isArray(m.triggers) ? m.triggers.filter((t) => typeof t === "string") : [],
        path: m.path || "",
      }))
    : [];
  const [journalEntries, journalTokens] = readJournal(dir);
  return {
    sessionId, dir, created: String(idx.created || ""), model,
    projectDir: typeof idx.projectDir === "string" && idx.projectDir ? idx.projectDir : null,
    rawTokens, packTokens: asNum(idx.stats?.packTokens),
    modules, journalEntries, journalTokens,
    requestStats: readRequestStats(dir),
  };
}

export const savingsPct = (p) => (p.rawTokens === 0 ? 0 : (1 - p.packTokens / p.rawTokens) * 100);

function readJournal(dir) {
  let raw;
  try { raw = fs.readFileSync(path.join(dir, "journal.jsonl"), "utf8"); } catch { return [0, 0]; }
  let entries = 0, tokens = 0;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try { const o = JSON.parse(line); entries++; tokens += asNum(o.tokens); }
    catch { /* tolerate a torn final line */ }
  }
  return [entries, tokens];
}

/** Layer 1b counters written by the plugin on every capped request. */
function readRequestStats(dir) {
  try {
    const r = JSON.parse(fs.readFileSync(path.join(dir, "request-stats.json"), "utf8"));
    const requests = asNum(r.requests);
    if (!requests) return null;
    return { requests, before: asNum(r.before), after: asNum(r.after), savedPct: asNum(r.savedPct) };
  } catch { return null; }
}

export function aggregateRequestStats(root = packRoot()) {
  let dirents = [];
  try { dirents = fs.readdirSync(sessionsRoot(root), { withFileTypes: true }); } catch { /* none */ }
  let sessions = 0, requests = 0, before = 0, after = 0;
  for (const d of dirents) {
    if (!d.isDirectory()) continue;
    const r = readRequestStats(path.join(sessionsRoot(root), d.name));
    if (!r) continue;
    sessions++; requests += r.requests; before += r.before; after += r.after;
  }
  return { sessions, requests, before, after, savedPct: before ? Math.round10((1 - after / before) * 100, 1) : 0 };
}

/** All session packs under root, newest first (created RFC3339 sorts lexically). */
export function loadPacks(root) {
  let dirents = [];
  try { dirents = fs.readdirSync(sessionsRoot(root), { withFileTypes: true }); } catch { return []; }
  const packs = [];
  for (const d of dirents) {
    if (!d.isDirectory()) continue;
    const dir = path.join(sessionsRoot(root), d.name);
    if (!fs.existsSync(path.join(dir, "index.json"))) continue;
    const pack = loadPack(dir);
    if (pack) packs.push(pack);
  }
  packs.sort((a, b) => b.created.localeCompare(a.created));
  return packs;
}

export function libraryStats(root) {
  let dirents = [];
  try { dirents = fs.readdirSync(libraryRoot(root), { withFileTypes: true }); } catch { return [0, 0]; }
  let projects = 0, modules = 0;
  for (const d of dirents) {
    if (!d.isDirectory()) continue;
    try {
      const idx = JSON.parse(fs.readFileSync(path.join(libraryRoot(root), d.name, "index.json"), "utf8"));
      projects++;
      modules += Array.isArray(idx.modules) ? idx.modules.length : 0;
    } catch { /* unreadable rows don't count */ }
  }
  return [projects, modules];
}

// ── show ────────────────────────────────────────────────────────────────────

export function renderPack(p) {
  const s = [];
  const line = () => "  " + c(DIM) + "─".repeat(21) + c(RESET);
  s.push(`\n  ${c(BOLD)}contextpack${c(RESET)} ${c(DIM)}${p.sessionId}${c(RESET)}`);
  s.push(line());
  const col = savingsColor(savingsPct(p));
  s.push(`  ${c(DIM)}raw${c(RESET)}     ${c(BOLD)}${fmtTokens(p.rawTokens)}${c(RESET)} ${c(DIM)}tok${c(RESET)}`);
  s.push(`  ${c(DIM)}pack${c(RESET)}    ${c(BOLD)}${fmtTokens(p.packTokens)}${c(RESET)} ${c(DIM)}tok${c(RESET)}`);
  s.push(`  ${c(DIM)}saved${c(RESET)}   ${col}${c(BOLD)}${fmtTokens(Math.max(0, p.rawTokens - p.packTokens))}${c(RESET)} ${c(DIM)}tok${c(RESET)}  ${col}${c(BOLD)}${savingsPct(p).toFixed(1)}%${c(RESET)}`);
  s.push("");
  s.push(`  ${c(DIM)}distilled${c(RESET)} ${c(BOLD)}${p.created}${c(RESET)} ${c(DIM)}with${c(RESET)} ${c(BOLD)}${p.model}${c(RESET)}`);
  s.push(`  ${c(DIM)}journal${c(RESET)}  ${c(BOLD)}${p.journalEntries}${c(RESET)} ${c(DIM)}tool results, ~${fmtTokens(p.journalTokens)} raw tok observed${c(RESET)}`);
  if (p.requestStats?.requests) {
    s.push(`  ${c(DIM)}requests${c(RESET)} ${c(BOLD)}${p.requestStats.requests}${c(RESET)} ${c(DIM)}capped · ~${fmtTokens(p.requestStats.before)} → ~${fmtTokens(p.requestStats.after)} tok (${c(GREEN)}${c(BOLD)}${p.requestStats.savedPct}%${c(RESET)} ${c(DIM)}smaller, Layer 1b)${c(RESET)}`);
  }
  s.push("");
  s.push(`  ${c(BOLD)}modules${c(RESET)}`);
  s.push(line());
  for (const m of p.modules) {
    const dot = m.hot ? `${c(GREEN)}● hot${c(RESET)}` : `${c(CYAN)}○ cold${c(RESET)}`;
    const trig = m.triggers.length ? m.triggers.join(", ") : "—";
    s.push(`  ${dot}  ${c(CYAN)}${m.file.padEnd(40)}${c(RESET)} ${c(DIM)}~${String(m.tokens).padStart(6)}${c(RESET)} ${c(DIM)}tok${c(RESET)}  ${c(DIM)}triggers: ${trig}${c(RESET)}`);
  }
  s.push(`\n  ${c(DIM)}${p.dir}${c(RESET)}`);
  return s.join("\n") + "\n";
}

export function show(sessionId, root = packRoot()) {
  let pack;
  if (sessionId) {
    pack = loadPack(path.join(sessionsRoot(root), sessionId));
    if (!pack) throw new Error(`no pack for session ${sessionId} under ${sessionsRoot(root)}`);
  } else {
    pack = loadPacks(root)[0];
    if (!pack) throw new Error(`no session packs under ${sessionsRoot(root)}`);
  }
  return renderPack(pack);
}

// ── eval ────────────────────────────────────────────────────────────────────

/** The session's prose, as the distiller first saw it. */
export function sessionTranscript(sessionId, { dbPath = defaultDbPath() } = {}) {
  if (!fs.existsSync(dbPath)) return "";
  const db = openDb(dbPath);
  try {
    if (!hasTable(db, "part") || !hasTable(db, "message")) return "";
    const roles = new Map();
    for (const r of db.prepare("select id, json_extract(data,'$.role') as role from message where session_id = ?").all(sessionId)) {
      roles.set(r.id, r.role || "user");
    }
    const rows = db.prepare(
      `select message_id, data from part
        where session_id = ? and json_extract(data,'$.type') = 'text'
        order by time_created asc, id asc`,
    ).all(sessionId);
    const out = [];
    let cur = null;
    for (const r of rows) {
      let d; try { d = JSON.parse(r.data); } catch { continue; }
      const t = typeof d.text === "string" ? d.text.trim() : "";
      if (!t) continue;
      if (cur !== r.message_id) {
        out.push(`### ${String(roles.get(r.message_id) || "user").toUpperCase()}`);
        cur = r.message_id;
      }
      out.push(t);
    }
    return out.join("\n\n");
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
}

function moduleText(dir, m) {
  const p = m.path && fs.existsSync(m.path) ? m.path : path.join(dir, m.file || "");
  try { return fs.readFileSync(p, "utf8"); } catch { return ""; }
}

/** Score the newest pack (or one session's) against the transcript it replaced. */
export function evalPack(sessionId, { root = packRoot(), dbPath = defaultDbPath() } = {}) {
  const dir = sessionId ? path.join(sessionsRoot(root), sessionId) : loadPacks(root)[0]?.dir;
  if (!dir) throw new Error(`no session packs under ${sessionsRoot(root)}`);
  const pack = loadPack(dir);
  if (!pack) throw new Error(`no pack index in ${dir}`);
  const packText = pack.modules.map((m) => `## ${m.kind || m.file}\n${moduleText(dir, m)}`.trim()).join("\n\n");
  const transcript = sessionTranscript(pack.sessionId, { dbPath });
  if (!transcript) throw new Error(`no transcript for ${pack.sessionId} in ${dbPath}`);
  const probes = extractProbes(transcript);
  const score = scorePack({ packText, probes, rawTokens: pack.rawTokens });
  const recovered = missingFactsModule(packText, transcript);
  return { sessionId: pack.sessionId, score, recovered, packText, pack };
}

export function renderEval(r) {
  const s = [];
  const col = r.score.score >= 70 ? GREEN : r.score.score >= 40 ? YELLOW : RED;
  s.push(`  ${c(BOLD)}pack eval${c(RESET)} ${c(DIM)}${r.sessionId}${c(RESET)}`);
  s.push(`  ${col}score ${r.score.score}/100${c(RESET)} · facts ${r.score.facts} (${Math.round(r.score.factRecall * 100)}%) · pointers ${r.score.pointers} (${Math.round(r.score.pointerRecall * 100)}%)`);
  s.push(`  last exchange ${r.score.questionKept ? "kept" : c(RED) + "LOST" + c(RESET)} · ${r.score.tokens} tok (${Math.round(r.score.ratio * 100)}% of ${r.pack.rawTokens})`);
  if (r.score.missingPointers.length) s.push(`  ${c(DIM)}missing pointers: ${r.score.missingPointers.join(", ")}${c(RESET)}`);
  if (r.score.missingFacts.length) s.push(`  ${c(DIM)}missing facts:${c(RESET)} ${r.score.missingFacts.map((f) => `"${f.slice(0, 60)}"`).join(" · ")}`);
  if (r.recovered) s.push(`  ${c(YELLOW)}would append${c(RESET)} ${r.recovered.name}.md (${r.recovered.tokens} tok, ${r.recovered.content.split("\n").length} lines)`);
  return s.join("\n") + "\n";
}

// ── stats ───────────────────────────────────────────────────────────────────

export function statsPayload(root = packRoot()) {
  return loadPacks(root);
}

export function renderStats(root = packRoot()) {
  const packs = loadPacks(root);
  const req = aggregateRequestStats(root);
  if (!packs.length && !req.requests) {
    return `  ${c(DIM)}No context packs. They are written by BabyZilla at compaction.${c(RESET)}\n`;
  }
  const s = [];
  const raw = packs.reduce((n, p) => n + p.rawTokens, 0);
  const pack = packs.reduce((n, p) => n + p.packTokens, 0);
  const pct = raw === 0 ? 0 : (1 - pack / raw) * 100;
  const col = savingsColor(pct);
  const [libProjects, libModules] = libraryStats(root);
  s.push(`  ${c(BOLD)}context packs${c(RESET)} ${c(DIM)}(session context, BabyZilla)${c(RESET)}`);
  s.push("  " + c(DIM) + "─".repeat(20) + c(RESET));
  let head = `  ${c(DIM)}sessions${c(RESET)} ${c(BOLD)}${packs.length}${c(RESET)}`;
  if (libProjects > 0) head += `  ${c(DIM)}· library${c(RESET)} ${c(BOLD)}${libProjects}${c(RESET)} ${c(DIM)}projects / ${libModules} modules${c(RESET)}`;
  s.push(head);
  s.push(`  ${c(DIM)}raw${c(RESET)}     ${c(BOLD)}${fmtTokens(raw)}${c(RESET)} ${c(DIM)}tok → context${c(RESET)} ${c(BOLD)}${fmtTokens(pack)}${c(RESET)} ${c(DIM)}tok  (${col}${c(BOLD)}${pct.toFixed(1)}%${c(RESET)} ${c(DIM)}smaller${c(RESET)})`);
  if (req.requests) {
    const rcol = savingsColor(req.savedPct);
    s.push(`  ${c(DIM)}requests${c(RESET)} ${c(BOLD)}${req.requests}${c(RESET)} ${c(DIM)}capped across ${req.sessions} sessions · ~${fmtTokens(req.before)} → ~${fmtTokens(req.after)} tok (${rcol}${c(BOLD)}${req.savedPct.toFixed(1)}%${c(RESET)} ${c(DIM)}smaller, Layer 1b)${c(RESET)}`);
  }
  s.push("");
  const maxRaw = Math.max(...packs.map((p) => p.rawTokens), 1);
  for (const p of packs.slice(0, 10)) {
    const width = Math.max(1, Math.round((p.rawTokens / maxRaw) * 14));
    s.push([
      `  ${c(CYAN)}${p.sessionId.slice(0, 34).padEnd(34)}${c(RESET)}`,
      `${c(DIM)}${fmtTokens(p.rawTokens).padStart(6)}${c(RESET)} ${c(DIM)}tok${c(RESET)}`,
      `${c(GREEN)}${"█".repeat(width)}${c(RESET)}`,
      `${c(DIM)}${String(p.modules.length).padStart(3)} modules${c(RESET)}`,
    ].join("  "));
  }
  s.push("");
  return s.join("\n") + "\n";
}

const money = (n) =>
  n >= 1000 ? `$${(n / 1000).toFixed(1)}K`
  : n >= 1 ? `$${n.toFixed(2)}`
  : n > 0 ? `$${n.toFixed(3)}`
  : "$0";

export function renderCost({ filter = null, limit = 20 } = {}) {
  const rows = sessionCosts({ filter, limit });
  if (!rows.length) return `  ${c(DIM)}No provider usage recorded.${c(RESET)}\n`;
  const t = totals(rows);
  const s = [];
  s.push(`  ${c(BOLD)}provider spend${c(RESET)} ${c(DIM)}(OpenCode usage · est=list prices · db=provider-recorded)${c(RESET)}`);
  s.push("  " + c(DIM) + "─".repeat(20) + c(RESET));
  s.push(`  ${c(DIM)}${"session".padEnd(12)}${"agent".padEnd(7)}${"model".padEnd(30)}${"input".padStart(9)}${"cached".padStart(9)}${"output".padStart(8)}${"hit".padStart(7)}${"est".padStart(10)}${"db".padStart(10)}${c(RESET)}`);
  for (const r of rows) {
    s.push([
      `${c(CYAN)}  ${r.sessionID.slice(0, 10).padEnd(12)}${c(RESET)}`,
      `${c(DIM)}${(r.agent || "-").slice(0, 6).padEnd(7)}${c(RESET)}`,
      `${(r.model || "?").replace(/^[^/]+\//, "").slice(0, 29).padEnd(30)}`,
      `${c(DIM)}${fmtTokens(r.usage.input).padStart(9)}${c(RESET)}`,
      `${c(DIM)}${fmtTokens(r.usage.cacheRead).padStart(9)}${c(RESET)}`,
      `${c(DIM)}${fmtTokens(r.usage.output).padStart(8)}${c(RESET)}`,
      `${c(DIM)}${`${r.cacheHitPct.toFixed(0)}%`.padStart(7)}${c(RESET)}`,
      `${(r.estimatedCost === null ? "-" : money(r.estimatedCost)).padStart(10)}`,
      `${money(r.recordedCost).padStart(10)}`,
    ].join(" "));
  }
  s.push("");
  s.push(`  ${c(DIM)}${t.sessions} sessions · cache hit ${t.cacheHitPct.toFixed(1)}% · est ${money(t.estimatedCost)} · provider ${money(t.recordedCost)}${c(RESET)}`);
  s.push("");
  return s.join("\n") + "\n";
}

export function statsJson(root = packRoot()) {
  const packs = loadPacks(root);
  const [libProjects, libModules] = libraryStats(root);
  return {
    root,
    sessions: packs.length,
    rawTokens: packs.reduce((n, p) => n + p.rawTokens, 0),
    packTokens: packs.reduce((n, p) => n + p.packTokens, 0),
    savedPct: Math.round10(aggregatePct(packs), 1),
    requests: aggregateRequestStats(root),
    library: { projects: libProjects, modules: libModules },
    perSession: packs.map((p) => ({
      sessionID: p.sessionId, created: p.created,
      rawTokens: p.rawTokens, packTokens: p.packTokens,
      savedPct: Math.round10(savingsPct(p), 1), modules: p.modules.length,
    })),
  };
}

export const aggregatePct = (packs) => {
  const raw = packs.reduce((n, p) => n + p.rawTokens, 0);
  const pack = packs.reduce((n, p) => n + p.packTokens, 0);
  return raw === 0 ? 0 : (1 - pack / raw) * 100;
};

Math.round10 = (x, dp) => Math.round(x * 10 ** dp) / 10 ** dp;

// ── verify ──────────────────────────────────────────────────────────────────

const isTokenChar = (ch) =>
  (ch >= "0" && ch <= "9") || (ch >= "A" && ch <= "Z") || (ch >= "a" && ch <= "z") ||
  ch === "_" || ch === "." || ch === "/" || ch === "~" || ch === "-";

/** Extract `path.ext:<digits>` pointers (`src/auth.ts:40`, `~/conf.json:9`). */
export function scanRefs(content) {
  const out = [];
  const chars = [...content];
  let i = 0;
  while (i < chars.length) {
    if (isTokenChar(chars[i])) {
      let j = i;
      while (j < chars.length && isTokenChar(chars[j])) j++;
      // token run ended at j; a pointer needs ':<digits>' right after
      if (chars[j] === ":" && /[0-9]/.test(chars[j + 1] ?? "")) {
        let k = j + 1;
        while (k < chars.length && /[0-9]/.test(chars[k])) k++;
        const after = chars[k] ?? "";
        if (!isTokenChar(after)) {
          const ref = parseRefToken(chars.slice(i, k).join(""));
          if (ref) { out.push(ref); i = k; continue; }
        }
      }
      i = j;
    } else {
      i++;
    }
  }
  return out;
}

export function parseRefToken(token) {
  const colon = token.lastIndexOf(":");
  if (colon < 1) return null;
  const p = token.slice(0, colon), num = token.slice(colon + 1);
  if (!p.includes(".")) return null;
  if (!/^\d+$/.test(num)) return null;
  const line = parseInt(num, 10);
  return line >= 1 ? [p, line] : null;
}

/** Bare-extension fragments like `.ts` are distiller shorthand — skip, don't flag. */
export const isUncertainPath = (t) => t.startsWith(".") && !t.includes("/");

/** Resolve against base-dir chain [projectDir, packDir, cwd]; absolute/~ direct. */
export function resolveFirst(token, bases, home = os.homedir()) {
  if (token.startsWith("~")) return path.join(home, token.slice(1));
  if (path.isAbsolute(token)) return token;
  if (!bases.length) return null;
  for (const base of bases) {
    const cand = path.join(base, token);
    try { if (fs.statSync(cand).isFile()) return cand; } catch { /* next base */ }
  }
  return path.join(bases[bases.length - 1], token);
}

const lineCount = (file) => {
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch { return null; }
  const parts = text.split("\n");
  return text.endsWith("\n") ? parts.length - 1 : parts.length;
};

export function verifyPack(p, home = os.homedir()) {
  const bases = [p.projectDir, p.dir, process.cwd()].filter(Boolean);
  const reports = [];
  for (const m of p.modules) {
    let content;
    try { content = fs.readFileSync(m.path, "utf8"); } catch { continue; }
    const refs = scanRefs(content);
    if (!refs.length) continue;
    const report = { module: m.file, ok: 0, broken: [] };
    for (const [token, line] of refs) {
      if (isUncertainPath(token)) continue;
      const file = resolveFirst(token, bases, home);
      if (!file) { report.broken.push(`${token}:${line} (unresolvable)`); continue; }
      let isFile = false;
      try { isFile = fs.statSync(file).isFile(); } catch { /* missing */ }
      if (!isFile) { report.broken.push(`${token}:${line} (file missing)`); continue; }
      const lines = lineCount(file);
      if (lines !== null && line >= 1 && line <= lines) report.ok++;
      else if (lines !== null) report.broken.push(`${token}:${line} (file has ${lines} lines)`);
      else report.broken.push(`${token}:${line} (unreadable)`);
    }
    reports.push(report);
  }
  return reports;
}

export function renderAudit(rows) {
  const s = [];
  s.push(`  ${c(BOLD)}price audit${c(RESET)} ${c(DIM)}(table vs. what the provider actually billed)${c(RESET)}`);
  s.push("  " + c(DIM) + "─".repeat(20) + c(RESET));
  if (!rows.length) return s.join("\n") + `\n  ${c(DIM)}no recorded spend yet${c(RESET)}\n`;
  const bad = rows.filter((r) => r.status === "mismatch");
  for (const r of rows) {
    const mark = r.status === "ok" ? `${c(GREEN)}✓${c(RESET)}`
      : r.status === "mismatch" ? `${c(YELLOW)}✗${c(RESET)}`
      : `${c(DIM)}·${c(RESET)}`;
    const ratio = r.ratio == null ? "—" : `${r.ratio.toFixed(2)}x`;
    const rate = (v) => `$${v < 0.01 ? v.toFixed(3) : v.toFixed(2)}`;
    const table = r.table ? `${rate(r.table.input)}/${rate(r.table.cached)}/${rate(r.table.output)}` : "—";
    const billed = r.billed ? `${rate(r.billed.input)}/${rate(r.billed.cached)}/${rate(r.billed.output)}` : "—";
    s.push(
      `  ${mark} ${r.model.replace(/^[^/]+\//, "").padEnd(26)} ` +
      `${c(DIM)}spent${c(RESET)} $${r.spent.toFixed(2).padStart(7)}  ` +
      `${c(DIM)}table${c(RESET)} ${table.padEnd(22)} ${c(DIM)}billed${c(RESET)} ${billed.padEnd(22)} ${c(DIM)}${ratio}${c(RESET)}`,
    );
  }
  s.push(bad.length
    ? `\n  ${c(YELLOW)}${bad.length} model(s) drift${c(RESET)} ${c(DIM)}— prices are in/cached/out USD per 1M tokens${c(RESET)}`
    : `\n  ${c(GREEN)}✓${c(RESET)} every model with recorded spend reconciles with its price row`);
  return s.join("\n") + "\n";
}

export function renderVerify(target, root = packRoot()) {
  const packs = target
    ? [loadPack(path.join(sessionsRoot(root), target)) ?? (() => { throw new Error(`no pack for session ${target}`); })()]
    : loadPacks(root);
  if (!packs.length) return `  ${c(DIM)}No context packs to verify.${c(RESET)}\n`;
  const s = [];
  s.push(`  ${c(BOLD)}pointer verification${c(RESET)} ${c(DIM)}(path:line refs inside module content)${c(RESET)}`);
  s.push("  " + c(DIM) + "─".repeat(20) + c(RESET));
  let totalOk = 0, totalBroken = 0;
  for (const p of packs) {
    for (const report of verifyPack(p)) {
      totalOk += report.ok;
      totalBroken += report.broken.length;
      if (report.broken.length) {
        s.push(`  ${c(YELLOW)}✗${c(RESET)} ${c(CYAN)}${report.module}${c(RESET)} ${c(DIM)}${report.ok}/${report.ok + report.broken.length} ok${c(RESET)}`);
        for (const b of report.broken) s.push(`      ${c(DIM)}- ${b}${c(RESET)}`);
      }
    }
  }
  s.push(totalBroken === 0
    ? `  ${c(GREEN)}✓${c(RESET)} all ${c(BOLD)}${totalOk}${c(RESET)} pointers resolve`
    : `\n  ${c(DIM)}${totalOk} ok${c(RESET)}, ${c(YELLOW)}${totalBroken}${c(RESET)} ${c(DIM)}broken — modules may reference moved/deleted files${c(RESET)}`);
  s.push("");
  return s.filter(Boolean).join("\n") + "\n";
}

// ── prune ───────────────────────────────────────────────────────────────────

/** "90d" | "2w" | "3m" | "1y" | "24h" → seconds. */
export function parseDuration(str) {
  const m = /^(\d+)([hdwmy])$/.exec(str);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  const mult = { h: 3600, d: 86400, w: 7 * 86400, m: 30 * 86400, y: 365 * 86400 };
  return n * mult[m[2]];
}

export const modifiedSecs = (file) => {
  try { return Math.floor(fs.statSync(file).mtimeMs / 1000); } catch { return null; }
};

export function prunePlan(root = packRoot(), cutoffSecs, now = Date.now() / 1000) {
  const removed = [], kept = [];
  for (const p of loadPacks(root)) {
    const ts = modifiedSecs(path.join(p.dir, "index.json"));
    ((ts !== null && ts < cutoffSecs) ? removed : kept).push(p);
  }
  return { removed, kept, now };
}

export function renderPrune(root = packRoot(), olderThan, dryRun) {
  const secs = parseDuration(olderThan);
  if (secs === null) throw new Error(`bad duration '${olderThan}' (try 30d, 2w, 3m)`);
  const now = Date.now() / 1000;
  const { removed, kept } = prunePlan(root, now - secs, now);
  const s = [];
  for (const p of removed) {
    const days = Math.floor((now - (modifiedSecs(path.join(p.dir, "index.json")) ?? now)) / 86400);
    if (dryRun) s.push(`  ${c(YELLOW)}would remove${c(RESET)} ${c(CYAN)}${p.sessionId}${c(RESET)} ${c(DIM)}(${days} days old)${c(RESET)}`);
    else {
      fs.rmSync(p.dir, { recursive: true, force: true });
      s.push(`  ${c(GREEN)}removed${c(RESET)} ${c(CYAN)}${p.sessionId}${c(RESET)}`);
    }
  }
  s.push("");
  if (!dryRun) {
    const pages = prunePages(root, secs, now);
    if (pages) s.push(`  ${c(GREEN)}removed${c(RESET)} ${pages} page${pages === 1 ? "" : "s"} (elided-output store)`);
  }
  s.push(`  ${c(DIM)}${dryRun ? `${removed.length} old, ${kept.length} kept (dry run — pass without --dry-run to delete)` : `removed ${removed.length}, ${kept.length} kept (OpenCode sessions untouched)`}${c(RESET)}`);
  s.push("");
  return s.join("\n") + "\n";
}

// ── CLI entry ───────────────────────────────────────────────────────────────

// ── retrieve ────────────────────────────────────────────────────────────────

/**
 * Print an exact, numbered line range from a file.
 *
 *   retrieve("src/app.js")            → first `maxLines` lines
 *   retrieve("src/app.js:120")        → line 120 (± context)
 *   retrieve("src/app.js:120-160")    → lines 120..160
 *   retrieve("file:///abs/path:5-9")  → same, file:// accepted
 *
 * This is the CLI counterpart of the read tool's offset/limit: it lets an
 * agent (or a human) pull back a span that ContextPack elided, without
 * re-reading the whole file.
 */
export function retrieve(ref, { cwd = process.cwd(), maxLines = 400, context = 0 } = {}) {
  if (!ref) throw new Error("usage: babyzilla retrieve <path>[:<start>[-<end>]] [--context N] [--max-lines N]");
  const raw = String(ref);
  let spec = raw.replace(/^file:\/\//, "");
  // file:///C:/... leaves a leading slash that path.resolve would mangle on Windows.
  if (process.platform === "win32" && /^\/[A-Za-z]:[\\/]/.test(spec)) spec = spec.slice(1);
  let start = null;
  let end = null;
  const m = /^(.*?):(\d+)(?:-(\d+))?$/.exec(spec);
  if (m) {
    spec = m[1];
    start = Number(m[2]);
    end = m[3] ? Number(m[3]) : start;
  }
  const file = path.resolve(cwd, spec);
  const lines = fs.readFileSync(file, "utf8").split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  let a;
  let b;
  if (start === null) {
    a = 1;
    b = Math.min(lines.length, Math.max(1, maxLines));
  } else {
    a = Math.max(1, start - context);
    b = Math.min(lines.length, Math.max(end, start) + context);
    if (b >= a && b - a + 1 > maxLines) b = a + maxLines - 1;
  }
  const out = [`Read file ${file}, lines ${a}-${b} of ${lines.length}`];
  for (let i = a; i <= b; i++) out.push(`${i}: ${lines[i - 1]}`);
  if (b < lines.length) {
    out.push(`[... ${lines.length - b} more lines — pass :${b + 1}-${Math.min(lines.length, b + maxLines)} for the next span ...]`);
  }
  return out.join("\n") + "\n";
}

// ── recall ──────────────────────────────────────────────────────────────────
//
// The request compactor replaces bulk tool output with a one-line pointer, but
// never deletes it: the raw text is still in the OpenCode database (the plugin
// only mutates the outgoing request). This command resolves a tool-call id from
// a marker back to that exact text — for every tool, not just file reads.
//
//   recall("call_abc")                 → the result, first `maxLines` lines
//   recall("call_abc:120-180")         → lines 120..180
//   recall("prt_…") / recall("msg_…")  → look up by part or message id
export function recall(ref, { dbPath = defaultDbPath(), maxLines = 200 } = {}) {
  if (!ref) throw new Error("usage: babyzilla recall <call-id|part-id|message-id>[:<start>[-<end>]] [--max-lines N]");
  const raw = String(ref);
  let id = raw;
  let start = null;
  let end = null;
  const m = /^(.*?):(\d+)(?:-(\d+))?$/.exec(raw);
  if (m) {
    id = m[1];
    start = Number(m[2]);
    end = m[3] ? Number(m[3]) : start;
  }
  // A content hash from the page store is checked first: it works even when the
  // tool result never reached the database (or the DB was rotated).
  const page = readPage(packRoot(), id);
  if (page) noteRecallRendered(packRoot(), id); // recall-rate telemetry
  if (page !== null) {
    const lines = page.split("\n");
    if (lines.length && lines[lines.length - 1] === "") lines.pop();
    let a;
    let b;
    if (start === null) {
      a = 1;
      b = Math.min(lines.length, Math.max(1, maxLines));
    } else {
      a = Math.max(1, start);
      b = Math.min(lines.length, Math.max(end, start));
      if (b - a + 1 > maxLines) b = a + maxLines - 1;
    }
    const out = [`Recall page ${id} (${lines.length} lines, showing ${a}-${b})`];
    for (let i = a; i <= b; i++) out.push(`${i}: ${lines[i - 1]}`);
    if (b < lines.length) {
      out.push(`[... ${lines.length - b} more lines — pass :${b + 1}-${Math.min(lines.length, b + maxLines)} for the next span ...]`);
    }
    return out.join("\n") + "\n";
  }

  if (!fs.existsSync(dbPath)) throw new Error(`no OpenCode database at ${dbPath}`);
  const db = openDb(dbPath);
  try {
    if (!hasTable(db, "part")) throw new Error(`no part table in ${dbPath} — this OpenCode version is not supported`);
    // A message id resolves to every part of that message: the request shape
    // does not preserve the database callID, but message ids are stable.
    let row = null;
    let text = "";
    let tool = "?";
    let sessionID = null;
    if (/^msg[_-]/.test(id)) {
      const rows = db
        .prepare(
          `select id, message_id, session_id, data
             from part
            where message_id = ?
            order by time_created asc`,
        )
        .all(id);
      if (!rows.length) throw new Error(`no message matches ${id}`);
      sessionID = rows[0].session_id;
      const chunks = [];
      for (const r of rows) {
        let d = null;
        try { d = JSON.parse(r.data); } catch { d = null; }
        const t = partText(d);
        if (!t) continue;
        const label = d?.tool ?? d?.name ?? d?.type ?? "part";
        chunks.push(`── ${label} (${r.id}) ──\n${t}`);
      }
      text = chunks.join("\n\n");
      tool = "message";
    } else {
      row = db
        .prepare(
          `select id, message_id, session_id, data
             from part
            where json_extract(data,'$.callID') = ?
               or id = ?
            order by time_created desc
            limit 1`,
        )
        .get(id, id);
      if (!row) throw new Error(`no part matches ${id}`);
      let data = null;
      try { data = JSON.parse(row.data); } catch { data = null; }
      text = partText(data);
      tool = data?.tool ?? data?.name ?? data?.type ?? "?";
      sessionID = row.session_id;
    }
    if (!text) throw new Error(`part ${id} has no readable text`);

    const lines = text.split("\n");
    if (lines.length && lines[lines.length - 1] === "") lines.pop();
    let a;
    let b;
    if (start === null) {
      a = 1;
      b = Math.min(lines.length, Math.max(1, maxLines));
    } else {
      a = Math.max(1, start);
      b = Math.min(lines.length, Math.max(end, start));
      if (b - a + 1 > maxLines) b = a + maxLines - 1;
    }
    const out = [
      `Recall ${id} (${tool}, session ${sessionID}, lines ${a}-${b} of ${lines.length})`,
    ];
    for (let i = a; i <= b; i++) out.push(`${i}: ${lines[i - 1]}`);
    if (b < lines.length) {
      out.push(`[... ${lines.length - b} more lines — pass :${b + 1}-${Math.min(lines.length, b + maxLines)} for the next span ...]`);
    }
    return out.join("\n") + "\n";
  } finally {
    db.close();
  }
}

/** The human-readable text of a stored part, across OpenCode shapes. */
function partText(data) {
  if (!data || typeof data !== "object") return "";
  const state = data.state ?? {};
  if (typeof state.output === "string" && state.output) return state.output;
  if (typeof state.error === "string" && state.error) return state.error;
  for (const holder of [state.content, data.result?.content, data.result?.value, data.content]) {
    if (typeof holder === "string" && holder) return holder;
    if (!Array.isArray(holder)) continue;
    const text = holder
      .map((c) => (typeof c === "string" ? c : typeof c?.text === "string" ? c.text : ""))
      .filter(Boolean)
      .join("\n");
    if (text) return text;
  }
  if (typeof data.text === "string") return data.text;
  if (data.state?.input && typeof data.state.input === "object") {
    return JSON.stringify(data.state.input, null, 2);
  }
  return "";
}

const HELP = `babyzilla ${"— inspect ContextPack session data"}

Usage:
  babyzilla show [sessionID]        one pack's stats & module index (default: newest)
  babyzilla stats [--json]          aggregate savings across all packs
  babyzilla cost [sessionID] [--limit N] [--json]
                                    provider-side spend from the OpenCode database
  babyzilla verify [sessionID]      check path:line pointers still resolve
  babyzilla models [--lanes] [--json]
                                    Ollama Cloud model knowledge base: caps,
                                    context, pricing, and default lane picks
  babyzilla recall <call-id|part-id|message-id>[:<start>[-<end>]] [--max-lines N]
                                    print the original text behind an elision marker
  babyzilla retrieve <path>[:<start>[-<end>]] [--context N] [--max-lines N]
                                    print an exact, numbered line range
  babyzilla eval [<session-id>] [--json] [--db <path>]
                                    score a pack against the transcript it replaced
  babyzilla prune [--older-than 2w] [--dry-run]
                                    remove old session packs (sessions untouched)
  babyzilla update [--check] [--yes] [--json]
                                    daily update check (cached 24h); with consent
                                    runs 'git pull --ff-only' on a checkout
  babyzilla pet [status|install|list|emit|gallery]
                                    desktop pet: install the app, list the 100
                                    expressions, emit one for testing
  babyzilla setup [--yes] [--dry-run] [--check] [--json] [--config PATH]
                                    guided setup: registers the plugin and grants
                                    the permissions it needs (recall, pack reads);
                                    writes a backup and only touches its own keys
  babyzilla selftune [status|verify|noise|revert|baseline] [--live] [--reps N] [--json]
                                    self-tuning loop state; verify replays the pipeline
                                    deterministically against the pending proposal
                                    (--live runs the dollar bench instead); noise
                                    refreshes the live A/A floor; revert undoes the
                                    pending knob

Environment:
  BABYZILLA_ROOT=<dir>              data root (default ~/.opencode/contextpacks)
  OPENCODE_DB=<path>                OpenCode database for babyzilla cost/recall
`;

function writeOne(file, text, exists) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!exists) {
    fs.writeFileSync(file, text, { mode: 0o600 });
    return { file, backup: null };
  }
  const res = applyConfig({ file, text });
  return { file, backup: res.backup };
}

const PET_APP = path.join(os.homedir(), "Applications", "BabyZillaPet.app");
const PET_LOGIN = path.join(os.homedir(), "Library", "LaunchAgents", "dev.babyzilla.pet.plist");
const PET_APP_DIR = () => petStateDir();

function petRunning() {
  const pids = new Set();
  for (const pattern of ["BabyZillaPet", "bzpet"]) {
    try {
      const out = execFileSync(tool("pgrep"), ["-f", pattern], { encoding: "utf8" });
      for (const line of out.trim().split("\n")) if (line) pids.add(line);
    } catch (e) {
      // pgrep exits 1 when nothing matches, which is the normal case. Anything
      // else must be visible: a swallowed ReferenceError here reported "not
      // running" forever and made `pet install` skip killing stale pets.
      if (e?.status !== 1) process.stderr.write(`pet: process check failed (${e?.message ?? e})\n`);
    }
  }
  return [...pids];
}

/**
 * The pet writes its pid into the state dir. Killing by that file (and checking
 * the command) instead of `pkill -f BabyZillaPet` means an install or a test run
 * in a temporary state dir cannot take down the pet the user is looking at.
 */
function petPidAlive() {
  try {
    const pid = Number(fs.readFileSync(path.join(petStateDir(), "pet.pid"), "utf8").trim());
    if (!Number.isInteger(pid) || pid <= 1) return null;
    const cmd = execFileSync(tool("ps"), ["-p", String(pid), "-o", "command="], { encoding: "utf8" }).trim();
    return /BabyZillaPet|bzpet/.test(cmd) ? pid : null;
  } catch { return null; }
}

function petStop() {
  const pids = new Set();
  const own = petPidAlive();
  if (own) pids.add(own);
  // For the real state dir also clear strays whose pid file was lost (a crashed
  // or --capture instance leaves one). A test or a temp state only ever stops
  // its own pid, which is what keeps `node --test` from killing the user's pet.
  if (!process.env.BABYZILLA_PET_STATE) {
    for (const pid of petRunning()) pids.add(Number(pid));
  }
  try { fs.rmSync(path.join(petStateDir(), "pet.pid"), { force: true }); } catch {}
  for (const pid of pids) { try { process.kill(pid); } catch {} }
  return pids.size ? [...pids][0] : null;
}

function petConfigFile() { return path.join(petStateDir(), "config.json"); }

function readPetConfig() {
  try { return JSON.parse(fs.readFileSync(petConfigFile(), "utf8")); } catch { return {}; }
}

function writePetConfig(cfg) {
  fs.mkdirSync(petStateDir(), { recursive: true });
  fs.writeFileSync(petConfigFile(), JSON.stringify(cfg, null, 2) + "\n");
}

/** Packs shipped with the plugin plus any installed in the state dir. */
function listPacks() {
  const out = [];
  const seen = new Set();
  const roots = [path.join(repoRoot(), "assets", "pet", "packs"), path.join(petStateDir(), "packs")];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || seen.has(entry.name)) continue;
      try {
        const pack = JSON.parse(fs.readFileSync(path.join(root, entry.name, "pack.json"), "utf8"));
        seen.add(entry.name);
        out.push({ id: entry.name, ...pack, installed: root.startsWith(petStateDir()) });
      } catch { /* not a pack */ }
    }
  }
  return out;
}

function petStart() {
  const binary = path.join(PET_APP, "Contents", "MacOS", "BabyZillaPet");
  if (!fs.existsSync(binary)) return null;
  const child = spawn(binary, [], { detached: true, stdio: "ignore" });
  let failed = null;
  child.on("error", (e) => { failed = e; });
  child.unref();
  // Wait for it to appear: "spawned" and "running" are not the same thing, and
  // the old code reported success even when the child died on launch.
  // macOS can take a few seconds to start a freshly rebuilt binary (Gatekeeper),
  // so poll long enough that a slow start is not reported as a failure.
  const deadline = Date.now() + 9000;
  while (Date.now() < deadline) {
    const pid = petPidAlive() ?? (petRunning()[0] ? Number(petRunning()[0]) : null);
    if (pid) return pid;
    if (failed) return null;
    execFileSync(tool("sleep"), ["0.15"]);
  }
  return null;
}

/**
 * Removed pets live in their own file, not in config.json. The app owns that file
 * and re-encodes it from a fixed struct, so a `retired` key there is silently
 * dropped on the next drag or scale change — which brought the built-in art back
 * on the following install.
 */
function petRetiredFile() { return path.join(petStateDir(), "retired.json"); }

function readRetired() {
  const list = [];
  try {
    for (const name of JSON.parse(fs.readFileSync(petRetiredFile(), "utf8"))?.pets ?? []) list.push(name);
  } catch { /* nothing retired yet */ }
  // migrate a mark left in config.json by an earlier version
  try {
    const cfg = readPetConfig();
    if (Array.isArray(cfg.retired) && cfg.retired.length) {
      for (const name of cfg.retired) if (!list.includes(name)) list.push(name);
      delete cfg.retired;
      writePetConfig(cfg);
      writeRetired(new Set(list));
    }
  } catch { /* a broken config is not worth failing reads over */ }
  return new Set(list);
}

function writeRetired(set) {
  const pets = [...set].sort();
  fs.mkdirSync(petStateDir(), { recursive: true });
  if (!pets.length) { fs.rmSync(petRetiredFile(), { force: true }); return; }
  fs.writeFileSync(petRetiredFile(), `${JSON.stringify({ pets }, null, 2)}\n`);
}

function petInstall({ login = false, build = true } = {}) {
  const root = repoRoot();
  const src = path.join(root, "apps", "pet");
  const swift = ["main.swift", "PetApp.swift", "PetBrowser.swift", "PixelFont.swift", "L10n.swift"].map((f) => path.join(src, f));
  for (const f of swift) if (!fs.existsSync(f)) throw new Error(`missing source ${f}`);
  const macos = path.join(PET_APP, "Contents", "MacOS");
  fs.mkdirSync(macos, { recursive: true });
  fs.mkdirSync(path.join(PET_APP, "Contents", "Resources"), { recursive: true });
  const binary = path.join(macos, "BabyZillaPet");
  if (build) {
    const res = spawnSync("swiftc", ["-swift-version", "5", "-O", "-o", binary, ...swift], { encoding: "utf8" });
    if (res.status !== 0) {
      throw new Error(`swiftc failed:\n${(res.stderr || res.stdout || "").slice(-1200)}\n\nInstall Xcode command line tools: xcode-select --install`);
    }
  }
  fs.writeFileSync(path.join(PET_APP, "Contents", "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>BabyZillaPet</string>
  <key>CFBundleIdentifier</key><string>dev.babyzilla.pet</string>
  <key>CFBundleExecutable</key><string>BabyZillaPet</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${pkgVersion()}</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
`);

  // runtime assets live next to the events file, so the app and the gallery
  // always see the same set even after the bundle is rebuilt
  fs.mkdirSync(petStateDir(), { recursive: true });
  // An install must not resurrect a pet the user removed: `retired` is a decision,
  // not a missing file to repair. `pet restore <name>` is the way back.
  const retired = readRetired();
  const skipped = [];
  const spritesOut = path.join(petStateDir(), "sprites");
  fs.mkdirSync(spritesOut, { recursive: true });
  const spriteDir = path.join(root, "assets", "pet", "sprites");
  let copied = 0;
  if (retired.has("babyzilla")) {
    skipped.push("babyzilla");
  } else {
    for (const file of fs.readdirSync(spriteDir)) {
      if (!file.endsWith(".png") || file.startsWith("_")) continue;
      fs.copyFileSync(path.join(spriteDir, file), path.join(spritesOut, file));
      copied++;
    }
    fs.copyFileSync(path.join(root, "assets", "pet", "pet-data.json"), path.join(petStateDir(), "pet-data.json"));
  }

  // alternate looks: each pack is a directory with pack.json and sprites/
  const packsIn = path.join(root, "assets", "pet", "packs");
  let packs = 0;
  if (fs.existsSync(packsIn)) {
    for (const pack of fs.readdirSync(packsIn, { withFileTypes: true })) {
      if (!pack.isDirectory()) continue;
      if (retired.has(pack.name)) { skipped.push(pack.name); continue; }
      const from = path.join(packsIn, pack.name);
      const to = path.join(petStateDir(), "packs", pack.name);
      fs.mkdirSync(path.join(to, "sprites"), { recursive: true });
      fs.copyFileSync(path.join(from, "pack.json"), path.join(to, "pack.json"));
      for (const file of fs.readdirSync(path.join(from, "sprites"))) {
        if (!file.endsWith(".png")) continue;
        fs.copyFileSync(path.join(from, "sprites", file), path.join(to, "sprites", file));
      }
      packs++;
    }
  }
  // The pet that ships: a new install opens as the dino, not the legacy art.
  // An existing explicit choice is left alone — this is a default, not a decision.
  const dino = path.join(petStateDir(), "packs", "lil-dino", "pack.json");
  if (!retired.has("lil-dino") && fs.existsSync(dino)) {
    const cfg = readPetConfig();
    if (!cfg.pack) {
      cfg.pack = "lil-dino";
      // its art is 48px, not the legacy 64: without the pack's own scale the dino
      // opens as a speck in the corner of a window sized for the old sprites
      try {
        const scale = JSON.parse(fs.readFileSync(dino, "utf8")).defaultScale;
        if (Number.isInteger(scale) && !cfg.scale) cfg.scale = scale;
      } catch { /* a broken pack.json is not a reason to fail an install */ }
      writePetConfig(cfg);
    }
  }

  // The app has no PATH of its own (a login item, not a shell), so it cannot find
  // `node` or this script by name. Pin both, the same way lowfat pins its binary:
  // absolute at install time, read back later.
  try {
    fs.writeFileSync(path.join(petStateDir(), "cli.json"), `${JSON.stringify({
      node: process.execPath,
      cli: path.resolve(process.argv[1] ?? ""),
      version: pkgVersion(),
    }, null, 2)}\n`);
  } catch { /* a read-only state dir is not a reason to fail an install */ }

  const gallery = path.join(petStateDir(), "gallery.html");
  for (const asset of ["gallery.html", "gallery.css", "gallery-data.js"]) {
    const srcFile = path.join(root, "assets", "pet", asset);
    if (fs.existsSync(srcFile)) fs.copyFileSync(srcFile, path.join(petStateDir(), asset));
  }

  if (login) {
    fs.mkdirSync(path.dirname(PET_LOGIN), { recursive: true });
    fs.writeFileSync(PET_LOGIN, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>dev.babyzilla.pet</string>
  <key>ProgramArguments</key><array><string>${path.join(macos, "BabyZillaPet")}</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><false/>
</dict>
</plist>
`);
  }
  return { app: PET_APP, binary, sprites: copied, packs, login, skipped };
}

/** `pet restore <name>`: undo a removal by copying that pet's assets back. */
function petRestore(name) {
  const root = repoRoot();
  const retired = readRetired();
  retired.delete(name);
  writeRetired(retired);

  if (name === "babyzilla") {
    const src = path.join(root, "assets", "pet");
    const out = path.join(petStateDir(), "sprites");
    fs.mkdirSync(out, { recursive: true });
    let n = 0;
    for (const file of fs.readdirSync(path.join(src, "sprites"))) {
      if (!file.endsWith(".png") || file.startsWith("_")) continue;
      fs.copyFileSync(path.join(src, "sprites", file), path.join(out, file));
      n++;
    }
    fs.copyFileSync(path.join(src, "pet-data.json"), path.join(petStateDir(), "pet-data.json"));
    return n;
  }

  const from = path.join(root, "assets", "pet", "packs", name);
  if (!fs.existsSync(from)) throw new Error(`no bundled pack called ${name}`);
  const to = path.join(petStateDir(), "packs", name);
  fs.mkdirSync(path.join(to, "sprites"), { recursive: true });
  fs.copyFileSync(path.join(from, "pack.json"), path.join(to, "pack.json"));
  let n = 0;
  for (const file of fs.readdirSync(path.join(from, "sprites"))) {
    if (!file.endsWith(".png")) continue;
    fs.copyFileSync(path.join(from, "sprites", file), path.join(to, "sprites", file));
    n++;
  }
  return n;
}

function petEmitLine(event) {
  petEmit(event);
}

function pkgVersion() {
  return JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
}

function repoRoot() {
  try { return path.dirname(path.dirname(fs.realpathSync(fileURLToPath(import.meta.url)))); }
  catch { return path.dirname(path.dirname(fileURLToPath(import.meta.url))); }
}

/** Detached, silent refresh: never adds latency to the command being run. */
function kickUpdateCheck() {
  try {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "_update-check"], {
      detached: true, stdio: "ignore", env: process.env,
    });
    child.unref();
  } catch { /* no update check is never an error */ }
}

/** One pass over the cached verdict: refresh in the background, mention once a day. */
function maybeUpdateNotice(cmd, rest, out) {
  if (cmd === "update" || cmd === "_update-check" || updatesDisabled()) return;
  if (rest.includes("--json")) return;
  const root = packRoot();
  const cache = readUpdateCache(root);
  const stale = cache?.ok !== true || Date.now() - (cache.ts ?? 0) > UPDATE_INTERVAL_MS;
  const backoff = Date.now() - (cache?.failTs ?? 0) < RETRY_AFTER_MS;
  if (stale && !backoff) kickUpdateCheck();
  if (!process.stdout.isTTY) return;
  if (!shouldNotify(cache, Date.now(), "cliNoticeTs")) return;
  out(`\n${renderUpdateNotice(cache)}\n`);
  markNotified(root, Date.now(), "cliNoticeTs");
}

async function ask(question, fallback = true) {
  if (!process.stdin.isTTY) return fallback;
  const readline = await import("node:readline/promises");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const hint = fallback ? "[Y/n]" : "[y/N]";
    const answer = (await rl.question(`${question} ${hint} `)).trim().toLowerCase();
    if (!answer) return fallback;
    return answer === "y" || answer === "yes";
  } catch {
    process.stdout.write("\n");
    return fallback;
  } finally {
    rl.close();
  }
}

const mark = (ok) => (ok ? `${c(GREEN)}✓${c(RESET)}` : `${c(YELLOW)}!${c(RESET)}`);

function renderProbes(checks) {
  const lines = [`\n${c(BOLD)}checks${c(RESET)}`];
  for (const chk of checks) lines.push(`  ${mark(chk.ok)} ${chk.id.padEnd(12)} ${c(DIM)}${chk.detail}${c(RESET)}`);
  return lines.join("\n") + "\n";
}

function renderSetup({ file, exists, info, plan, checks, wrote, next }) {
  const lines = [];
  lines.push(`${c(BOLD)}BabyZilla setup${c(RESET)}`);
  lines.push(`  config      ${file}${exists ? "" : ` ${c(DIM)}(will be created)${c(RESET)}`}`);
  lines.push(`  data root   ${packRoot()}`);
  lines.push(`  plugin      ${info.registered ? info.plugin.spec : `${c(YELLOW)}not registered${c(RESET)}`}`);
  lines.push(`  recall      ${info.permission.recallAllowed ? "allowed" : `bash ${info.permission.recallEffect === "unset" ? "asks per call" : info.permission.recallEffect}`}`);
  lines.push(`  pack reads  ${info.permission.externalAllowed ? "allowed" : "external_directory asks"}`);
  lines.push(`  self-tune   ${info.options.selfLearn === false ? "off" : "on"}${info.options.selfLearn === undefined ? " (default)" : ""}`);
  lines.push(`  updates     ${info.options.checkUpdates === false ? "off" : "daily check on"}`);
  if (plan?.changes?.length) {
    lines.push(`\n${c(BOLD)}planned changes${c(RESET)}`);
    for (const ch of plan.changes) lines.push(`  · ${ch.detail}`);
  } else if (plan) {
    lines.push(`\n${c(GREEN)}config already complete${c(RESET)}`);
  }
  for (const w of plan?.warnings ?? []) lines.push(`  ${mark(false)} ${w}`);
  for (const m of plan?.manual ?? []) lines.push(`  ${mark(false)} ${m}`);
  if (checks?.length) lines.push(renderProbes(checks));
  if (wrote) lines.push(`${c(GREEN)}wrote${c(RESET)} ${wrote.file} ${c(DIM)}(backup: ${wrote.backup ?? "none — new file"})${c(RESET)}`);
  if (next?.length) lines.push(`\n${c(BOLD)}next${c(RESET)}\n${next.map((n) => `  · ${n}`).join("\n")}`);
  return lines.join("\n") + "\n";
}

async function confirm(question) {
  if (!process.stdin.isTTY) return false;
  const readline = await import("node:readline/promises");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(question)).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } catch {
    // EOF or Ctrl-C while asking is a "no", not a crash.
    process.stdout.write("\n");
    return false;
  } finally {
    rl.close();
  }
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const out = (x) => process.stdout.write(x);
  try {
    switch (cmd ?? "") {
      case "show": out(show(rest[0] || undefined)); break;
      case "stats": out(rest.includes("--json") ? JSON.stringify(statsJson(), null, 2) + "\n" : renderStats()); break;
      case "cost": {
        const filter = rest[0] && !rest[0].startsWith("--") ? rest[0] : null;
        const limit = rest.includes("--limit") ? Number(rest[rest.indexOf("--limit") + 1]) : 20;
        out(rest.includes("--json")
          ? JSON.stringify({ sessions: sessionCosts({ filter, limit }) }, null, 2) + "\n"
          : renderCost({ filter, limit }));
        break;
      }
      case "verify": out(renderVerify(rest[0] || undefined)); break;
      case "models": {
        if (rest.includes("--audit")) {
          const rows = auditPrices();
          out(renderAudit(rows));
          break;
        }
        const db = loadDB({});
        out(rest.includes("--json")
          ? JSON.stringify(explainModels(db, { json: true }), null, 2) + "\n" + "\n"
          : explainModels(db, { lanes: rest.includes("--lanes") }));
        break;
      }
      case "eval": {
        const sid = rest[0] && !rest[0].startsWith("--") ? rest[0] : undefined;
        const dbPath = rest.includes("--db") ? rest[rest.indexOf("--db") + 1] : undefined;
        const r = evalPack(sid, dbPath ? { dbPath } : {});
        out(rest.includes("--json") ? JSON.stringify({ sessionId: r.sessionId, ...r.score }, null, 2) + "\n" : renderEval(r));
        break;
      }
      case "recall": {
        const ref = rest[0] && !rest[0].startsWith("--") ? rest[0] : undefined;
        const maxLines = rest.includes("--max-lines") ? Number(rest[rest.indexOf("--max-lines") + 1]) : 200;
        const dbPath = rest.includes("--db") ? rest[rest.indexOf("--db") + 1] : undefined;
        out(recall(ref, { maxLines, ...(dbPath ? { dbPath } : {}) }));
        break;
      }
      case "retrieve": {
        const ref = rest[0] && !rest[0].startsWith("--") ? rest[0] : undefined;
        const maxLines = rest.includes("--max-lines") ? Number(rest[rest.indexOf("--max-lines") + 1]) : 400;
        const ctxLines = rest.includes("--context") ? Number(rest[rest.indexOf("--context") + 1]) : 0;
        out(retrieve(ref, { maxLines, context: ctxLines }));
        break;
      }
      case "prune": {
        const older = rest.includes("--older-than") ? rest[rest.indexOf("--older-than") + 1] : "2w";
        out(renderPrune(undefined, older, rest.includes("--dry-run")));
        break;
      }
      case "selftune": {
        const sub = (rest.find((r) => !r.startsWith("--")) ?? "status").toLowerCase();
        const reps = rest.includes("--reps") ? Number(rest[rest.indexOf("--reps") + 1]) : 2;
        const root = packRoot();
        const repo = path.dirname(path.dirname(fs.realpathSync(new URL(import.meta.url).pathname)));
        const asJson = rest.includes("--json");
        if (sub === "status") {
          out(asJson
            ? JSON.stringify({ state: readSelftuneState(root), summary: buildSummaryData(root) }, null, 2) + "\n"
            : renderStatus(root) + "\n");
          break;
        }
        if (sub === "verify") {
          const plan = verifyPlan(root);
          if (!plan.pending) { out("nothing pending — nothing to verify\n"); break; }
          const pending = plan.pending;
          if (rest.includes("--live")) {
            // Dollar bench: honest about task quality, too noisy for small
            // knobs (see bench/RESULTS.md), and it spends credits.
            out(`verifying ${pending.knob} ${pending.from} → ${pending.to} (reps=${reps}, live bench, marker-gated)…\n`);
            const runR = runVerifyBench({ root, repo, reps, setoffs: plan.setoffs, sets: plan.sets });
            void Promise.resolve(resolveVerify({ root, verdict: runR.payload, log: console.error, reps })).then((judged) => {
              out(`verdict: ${judged.ok ? "PASS — kept" : "FAIL — reverted"} — ${judged.reason}\n`);
              process.exitCode = judged.ok ? 0 : 1;
            });
          } else {
            // Deterministic replay: exact prompt-byte comparison, no credits.
            out(`replaying ${pending.knob} ${pending.from} → ${pending.to} (deterministic pipeline, no model calls)…\n`);
            const res = runReplayBench({ repo, setoffs: plan.setoffs, sets: plan.sets });
            void Promise.resolve(resolveVerify({
              root,
              verdict: { kind: "replay", base: res?.base ?? null, prop: res?.prop ?? null, knob: pending.knob, to: pending.to },
              log: console.error,
            })).then((judged) => {
              out(`verdict: ${judged.ok ? "PASS — kept" : "FAIL — reverted"} — ${judged.reason}\n`);
              if (judged.peakPct != null) {
                const peakWord = judged.peakPct >= 0
                  ? `${judged.peakPct.toFixed(1)}% smaller`
                  : `${Math.abs(judged.peakPct).toFixed(1)}% larger`;
                out(`         prompt tokens ${judged.totalPct.toFixed(1)}% fewer, peak ${peakWord}\n`);
              }
              process.exitCode = judged.ok ? 0 : 1;
            });
          }
          break;
        }
        if (sub === "noise") {
          // 4 reps: an A/A floor needs BOTH leg orders, and one aborted leg
          // invalidates its rep, so two reps are too often unbalanced.
          const noiseReps = rest.includes("--reps") ? reps : 4;
          out(`A/A baseline refresh (reps=${noiseReps}, identical configs both legs)…\n`);
          const n = runNoise({ root, repo, reps: noiseReps });
          out(n.ok ? `noise = ${n.pct.toFixed(2)}% → floor ${n.floor.toFixed(2)}%\n` : `noise run failed: ${n.reason}\n`);
          process.exitCode = n.ok ? 0 : 1;
          break;
        }
        if (sub === "revert") {
          const r = manualRevert(root);
          out(r.ok ? `reverted ${r.knob} → ${r.to}\n` : `${r.reason}\n`);
          process.exitCode = r.ok ? 0 : 1;
          break;
        }
        if (sub === "baseline") {
          const b = refreshBaseline(root);
          out(b ? `baseline recalls/turn = ${b.recallsPerTurn.toFixed(3)} over ${b.sampleTurns} turns\n` : "no sessions recorded yet\n");
          break;
        }
        out(`unknown selftune subcommand: ${sub} (status | verify | noise | revert | baseline)\n`);
        process.exitCode = 2;
        break;
      }
      case "setup": {
        const asJson = rest.includes("--json");
        const assumeYes = rest.includes("--yes") || rest.includes("-y");
        const dryRun = rest.includes("--dry-run");
        const checkOnly = rest.includes("--check");
        const explicit = rest.includes("--config") ? rest[rest.indexOf("--config") + 1] : null;
        void (async () => {
          const file = explicit ? path.resolve(explicit) : (locateConfig() ?? configCandidates()[0]);
          const exists = fs.existsSync(file);
          let text = exists
            ? fs.readFileSync(file, "utf8")
            : '{\n  "$schema": "https://opencode.ai/config.json"\n}\n';
          const info = inspectConfig(text);
          const root = packRoot();

          const answers = {
            registerPlugin: assumeYes ? true : null,
            allowRecall: !rest.includes("--no-recall"),
            allowExternal: !rest.includes("--no-external"),
            selfLearn: null,
            checkUpdates: null,
          };

          if (!assumeYes && !checkOnly && process.stdin.isTTY) {
            out(`${c(BOLD)}BabyZilla setup${c(RESET)} ${c(DIM)}${file}${c(RESET)}\n\n`);
            if (!info.registered) answers.registerPlugin = await ask("Register BabyZilla in this config?", true);
            if (!info.permission.recallAllowed) {
              answers.allowRecall = await ask(
                `Allow \`babyzilla recall\`/\`retrieve\` without approval? (${info.permission.recallEffect === "unset" ? "bash currently asks per call" : `bash is ${info.permission.recallEffect}`})`,
                true,
              );
            }
            if (!info.permission.externalAllowed) {
              answers.allowExternal = await ask("Allow the agent to read the pack directory directly?", true);
            }
            answers.selfLearn = await ask("Keep the self-tuning loop enabled?", info.options.selfLearn !== false);
            answers.checkUpdates = await ask("Check for updates daily?", info.options.checkUpdates !== false);
          }

          const plan = checkOnly ? null : planSetup({ text, root, answers });
          const checks = probe({ root });

          // Writing requires an explicit path: --yes, or an interactive TTY
          // confirmation. `--json` never prompts and never writes on its own.
          let wrote = null;
          let declined = false;
          if (plan?.changed && !dryRun) {
            if (assumeYes) {
              wrote = writeOne(file, plan.text, exists);
            } else if (!asJson && process.stdin.isTTY) {
              if (await ask("Write these changes?", true)) wrote = writeOne(file, plan.text, exists);
              else declined = true;
            }
          }

          const next = wrote ? ["restart opencode so the plugin reloads"] : [];
          if (process.platform === "darwin" && !process.env.BABYZILLA_PET_STATE) {
            next.push("optional: babyzilla pet install (a 16-bit pet that reacts to this session)");
          }
          if (asJson) {
            out(JSON.stringify({
              config: { file, exists },
              detected: {
                registered: info.registered,
                spec: info.plugin?.spec ?? null,
                recallAllowed: info.permission.recallAllowed,
                recallEffect: info.permission.recallEffect,
                externalAllowed: info.permission.externalAllowed,
                permissionForm: info.permission.form,
                options: info.options,
              },
              plan: plan ? { changes: plan.changes, warnings: plan.warnings, manual: plan.manual } : null,
              wrote,
              probes: checks,
              next,
            }, null, 2) + "\n");
            return;
          }

          out(renderSetup({ file, exists, info, plan, checks, wrote, next }));

          if (checkOnly) return;
          if (!plan.changed) return;
          if (dryRun) {
            out(`\n${c(DIM)}--dry-run: nothing written. Re-run without it to apply.${c(RESET)}\n`);
            return;
          }
          if (declined) { out("not written\n"); return; }
          if (!wrote) {
            out(`\n${c(DIM)}nothing written (no TTY). Re-run with --yes to apply.${c(RESET)}\n`);
          }
        })().catch((e) => {
          out(`${c(YELLOW)}setup error:${c(RESET)} ${e?.message ?? e}\n`);
          process.exitCode = 1;
        });
        break;
      }
      case "pet": {
        const sub = rest.find((a) => !a.startsWith("-")) ?? "status";
        if (sub === "help" || rest.includes("--help") || rest.includes("-h")) {
          out(`babyzilla pet <command>

  install [--login] [--no-start] [--no-build]   build + install the macOS app
  start | stop                                   run or stop the pet
  status                                         running? which pet? how much art?
  packs                                          list pets: built-in + installed packs
  catalog [--search <text>] [--featured] [--originals] [--limit n] [--json]
                                                 browse the OpenPets catalog (1300+ pets)
  add <id|zip|url> [--voice <id>] [--as <name>]  install a pet as a pack
  add --originals | --featured [--search <text>] install a whole slice of the catalog
  use <pack|babyzilla>                           switch pet (restarts it if running)
  remove <pack|babyzilla>                        delete a pet you do not use
  restore <pack|babyzilla>                       copy a removed pet's art back
  list                                           all 100 expressions
  mark [done|question|error|none]                the status badge (no arg: show it)
  emit <id> [--hold 2] [--say "text"]            make it react right now
  think "text" [--voice <id>] | say "text"      a thought (quiet bubble) or a spoken line
  chat [--close]                                 open the chat log (what it said, kept)
  gallery                                        open the sprite field guide

A pack is a second look built from a sprite sheet; see docs/PET.md.
`);
          return;
        }
        if (sub === "install") {
          try {
            const res = petInstall({ login: rest.includes("--login"), build: !rest.includes("--no-build") });
            out(`${c(GREEN)}installed${c(RESET)} ${res.app}\n`);
            out(`  binary   ${res.binary}\n  sprites  ${res.sprites} → ${petStateDir()}/sprites\n`);
            if (res.login) out(`  login    ${PET_LOGIN}\n`);
            // Never resurrect a removed pet: install says so and points at restore.
            if (res.skipped?.length) {
              out(`  skipped  ${res.skipped.join(", ")} ${c(DIM)}(removed — babyzilla pet restore <name>)${c(RESET)}\n`);
            }
            petStop();
            if (!rest.includes("--no-start")) {
              const pid = petStart();
              if (pid) out(`${c(GREEN)}running${c(RESET)} pid ${pid} (right-click the pet for size, mute, quit)\n`);
              else {
                out(`${c(YELLOW)}could not start the pet${c(RESET)} — run: ${res.binary} in Terminal to see why\n`);
                process.exitCode = 1;
              }
            }
            return;
          } catch (e) { out(`${c(YELLOW)}pet install failed:${c(RESET)} ${e.message}\n`); process.exitCode = 1; return; }
        }
        if (sub === "catalog") {
          void (async () => {
            try {
              const { pets, cached } = await petCatalog({ fresh: rest.includes("--fresh") });
              const found = pickPets(pets, {
                search: rest.includes("--search") ? rest[rest.indexOf("--search") + 1] : null,
                featured: rest.includes("--featured"),
                originals: rest.includes("--originals"),
                category: rest.includes("--category") ? rest[rest.indexOf("--category") + 1] : null,
                limit: rest.includes("--limit") ? Number(rest[rest.indexOf("--limit") + 1]) : (rest.includes("--json") ? 0 : 25),
              });
              if (rest.includes("--json")) { out(JSON.stringify(found) + "\n"); return; }
              const have = new Set(listPacks().filter((entry) => entry.installed).map((entry) => entry.id));
              for (const pet of found) {
                const mark = have.has(pet.id) ? `${c(GREEN)}+${c(RESET)}` : " ";
                const flags = [pet.original ? "original" : null, pet.featured ? "featured" : null, pet.v2 ? "v2" : null].filter(Boolean).join(" ");
                out(`${mark} ${pet.id.padEnd(30)} ${pet.label.padEnd(22)} ${String(pet.category ?? "").padEnd(8)}${flags ? `${c(DIM)}${flags}${c(RESET)}` : ""}\n`);
              }
              out(`${c(DIM)}${found.length} of ${pets.length} pets${cached ? " (cached)" : ""} — babyzilla pet add <id>${c(RESET)}\n`);
            } catch (e) {
              out(`${c(YELLOW)}catalog unavailable:${c(RESET)} ${e.message}\n`);
              process.exitCode = 1;
            }
          })();
          return;
        }
        if (sub === "add") {
          const withValue = new Set(["voice", "as", "search", "category", "limit"]);
          const positional = [];
          for (let i = 0; i < rest.length; i++) {
            if (rest[i].startsWith("--")) { if (withValue.has(rest[i].slice(2))) i++; continue; }
            if (rest[i] !== "add") positional.push(rest[i]);
          }
          const asked = rest.includes("--voice") ? rest[rest.indexOf("--voice") + 1] : null;
          if (asked && !VOICES[asked]) {
            out(`unknown voice ${asked} — try: ${VOICE_IDS.join(", ")}\n`);
            process.exitCode = 2;
            return;
          }
          void (async () => {
            try {
              const packsDir = path.join(petStateDir(), "packs");
              fs.mkdirSync(packsDir, { recursive: true });
              const have = new Set(listPacks().filter((entry) => entry.installed).map((entry) => entry.id));
              const force = rest.includes("--force");
              const done = [];
              const failed = [];
              const sources = [];

              const batch = rest.includes("--originals") || rest.includes("--featured")
                || (rest.includes("--search") && !positional.length);
              if (batch) {
                const { pets } = await petCatalog({ fresh: rest.includes("--fresh") });
                const slice = pickPets(pets, {
                  search: rest.includes("--search") ? rest[rest.indexOf("--search") + 1] : null,
                  featured: rest.includes("--featured"),
                  originals: rest.includes("--originals"),
                  category: rest.includes("--category") ? rest[rest.indexOf("--category") + 1] : null,
                });
                for (const pet of slice) {
                  if (!pet.zip) { failed.push(`${pet.id}: the catalog has no zip for it`); continue; }
                  if (have.has(pet.id) && !force) continue;
                  sources.push({ label: pet.id, source: pet.zip, voice: asked });
                }
                if (!sources.length) { out(`nothing to do: every pet in that slice is already installed (--force to rebuild)\n`); return; }
                out(`${sources.length} to install…\n`);
              } else if (positional.length) {
                for (const one of positional) {
                  const clean = String(one).replace(/^~/, process.env.HOME ?? "~");
                  if (isRemoteSource(one) || fs.existsSync(clean)) { sources.push({ label: one, source: clean, voice: asked }); continue; }
                  const { pets } = await petCatalog();
                  const pet = findPet(pets, one);
                  if (!pet?.zip) throw new Error(`no pet "${one}" in the catalog — try: babyzilla pet catalog --search ${one}`);
                  if (have.has(pet.id) && !force) { out(`${pet.id} is already installed (--force to rebuild)\n`); continue; }
                  sources.push({ label: pet.id, source: pet.zip, voice: asked });
                }
              } else {
                out(`usage: babyzilla pet add <id|zip|url> [--voice <id>] [--as <name>] | --originals | --featured\n`);
                process.exitCode = 2;
                return;
              }

              // four at a time: enough to hide the latency, gentle on the catalog
              let next = 0;
              const worker = async () => {
                while (next < sources.length) {
                  const job = sources[next++];
                  try {
                    const results = await installPetSource(job.source, {
                      outRoot: packsDir,
                      size: 112,
                      scale: 2,
                      voice: job.voice,
                      name: rest.includes("--as") ? rest[rest.indexOf("--as") + 1] : null,
                      source: job.source,
                      license: "OpenPets catalog — art belongs to its owner",
                    });
                    for (const result of results) {
                      done.push(result);
                      out(`  ${c(GREEN)}+${c(RESET)} ${result.id.padEnd(26)} ${result.label.padEnd(20)} ${c(DIM)}voice=${result.voice} ${result.frames} frames${c(RESET)}\n`);
                    }
                  } catch (e) {
                    failed.push(`${job.label}: ${e.message}`);
                  }
                }
              };
              await Promise.all(Array.from({ length: Math.min(4, sources.length) }, worker));

              if (failed.length) for (const line of failed) out(`  ${c(YELLOW)}skip${c(RESET)} ${line}\n`);
              if (!done.length) { process.exitCode = failed.length ? 1 : 0; return; }
              out(`${done.length} pet${done.length === 1 ? "" : "s"} installed${failed.length ? `, ${failed.length} skipped` : ""}`);
              const fresh = done.map((entry) => entry.id);
              out(done.length === 1
                ? ` — switch with: babyzilla pet use ${fresh[0]}\n`
                : ` — babyzilla pet packs, then pet use <id>\n`);
              process.exitCode = failed.length && !done.length ? 1 : 0;
            } catch (e) {
              out(`${c(YELLOW)}pet add failed:${c(RESET)} ${e.message}\n`);
              process.exitCode = 1;
            }
          })();
          return;
        }
        if (sub === "lang" || sub === "language") {
          const wanted = rest[rest.indexOf(sub) + 1];
          if (!wanted) {
            const now = resolveLanguage(petStateDir());
            out(`language: ${now} (${LANGUAGES[now].label})\n`);
            out(`  ${c(DIM)}change with: babyzilla pet lang ${now === "en" ? "de" : "en"}${c(RESET)}\n`);
            return;
          }
          if (!isLanguage(wanted)) {
            out(`${c(YELLOW)}unknown language${c(RESET)} ${wanted} — try: ${Object.keys(LANGUAGES).join(", ")}\n`);
            process.exitCode = 2;
            return;
          }
          const cfg = readPetConfig();
          cfg.language = wanted;
          writePetConfig(cfg);
          out(`language: ${wanted} (${LANGUAGES[wanted].label})\n`);
          petEmitLine({ kind: "lang", language: wanted });
          return;
        }
        if (sub === "chat") {
          const on = !rest.includes("--close");
          petEmit({ kind: "chat", on });
          // the app writes last-chat.json when the window is actually up
          const ackFile = path.join(petStateDir(), "last-chat.json");
          let ack = null;
          for (const deadline = Date.now() + 1400; Date.now() < deadline;) {
            try {
              const got = JSON.parse(fs.readFileSync(ackFile, "utf8"));
              if (got?.open === on) { ack = got; break; }
            } catch { /* not written yet */ }
            try { execFileSync(tool("sleep"), ["0.1"]); } catch { /* keep polling */ }
          }
          out(ack
            ? `chat ${on ? "open" : "closed"} — ${ack.lines} line${ack.lines === 1 ? "" : "s"} held\n`
            : `chat ${on ? "open" : "closed"} — no pet answered (is it running?)\n`);
          return;
        }
        if (sub === "think" || sub === "say") {
          const text = rest.slice(rest.indexOf(sub) + 1).filter((a) => !a.startsWith("--")).join(" ").trim();
          if (!text) { out(`usage: babyzilla pet ${sub} "text"\n`); process.exitCode = 2; return; }
          // what you test should be what the dino says: caveman by default,
          // exactly as in a session. --raw keeps the words as typed.
          const raw = rest.includes("--raw") || rest.includes("--verbatim");
          // the CLI goes through the same reducer as a live thought, mood tag and
          // all — in the voice of the pet that is actually running
          const asked = rest.includes("--voice") ? rest[rest.indexOf("--voice") + 1] : null;
          if (asked && !VOICES[asked]) {
            out(`unknown voice ${asked} — try: ${VOICE_IDS.join(", ")}\n`);
            process.exitCode = 2;
            return;
          }
          const voice = asked ?? resolveVoice(petStateDir()).id;
          const language = resolveLanguage(petStateDir());
          const reduced = sub === "think" && !raw ? thoughtLine(text, { voice, language }) : null;
          const line = reduced?.text ?? text;
          petEmitLine({ kind: sub, text: line });
          out(`${sub === "think" ? "thought" : "said"}: ${line}\n`);
          if (sub === "think") {
            out(`  ${c(DIM)}voice     ${VOICES[voice]?.label ?? voice}${c(RESET)}\n`);
            out(`  ${c(DIM)}language  ${language} (${LANGUAGES[language].label})${c(RESET)}\n`);
          }
          // Proof, not faith: the app writes last-bubble.json when a bubble is on
          // screen, so this can tell "no pet running" from "pet was busy".
          const ackFile = path.join(petStateDir(), "last-bubble.json");
          let ack = null;
          for (const deadline = Date.now() + 1400; Date.now() < deadline;) {
            try {
              const got = JSON.parse(fs.readFileSync(ackFile, "utf8"));
              if (got?.text === line) { ack = got; break; }
            } catch { /* not written yet */ }
            try { execFileSync(tool("sleep"), ["0.1"]); } catch { /* keep polling */ }
          }
          if (ack) {
            const dwell = typeof ack.hold === "number" ? ` for ${ack.hold.toFixed(1)}s` : "";
            out(`  ${c(GREEN)}shown${c(RESET)} at ${new Date(ack.t).toLocaleTimeString()}${dwell} (${ack.thought ? "thought" : "speech"})\n`);
          }
          else if (!petPidAlive()) out(`  ${c(YELLOW)}not running${c(RESET)} — babyzilla pet start\n`);
          else out(`  ${c(YELLOW)}not shown yet${c(RESET)} — another bubble is up; it is in the chat log (babyzilla pet chat)\n`);
          return;
        }
        if (sub === "mark") {
          const arg = rest[rest.indexOf(sub) + 1];
          // A mark is state, not an event: it stays until the human decides, so
          // the CLI writes the same file the plugin does and the app reads.
          if (!arg || arg.startsWith("-")) {
            const cur = readMark(petStateDir());
            out(`mark      ${cur ?? "none"}${cur ? "" : " (nothing waiting)"}\n`);
            return;
          }
          const kind = ["none", "off", "clear"].includes(arg) ? null : arg;
          if (kind !== null && !MARKS.includes(kind)) {
            out(`unknown mark ${arg} — try: done | question | error | none\n`);
            process.exitCode = 2;
            return;
          }
          const ok = writeMark(petStateDir(), kind);
          petEmitLine({ kind: "mark", mark: kind });
          out(`mark      ${kind ?? "none"}${ok ? "" : ` ${c(YELLOW)}(could not write mark.json)${c(RESET)}`}\n`);
          // Ask the app, not the file: the badge is only real if it is on screen.
          const ackFile = path.join(petStateDir(), "last-mark.json");
          let ack = null;
          for (const deadline = Date.now() + 1400; Date.now() < deadline;) {
            try {
              const got = JSON.parse(fs.readFileSync(ackFile, "utf8"));
              if ((got?.mark ?? null) === kind) { ack = got; break; }
            } catch { /* not written yet */ }
            try { execFileSync(tool("sleep"), ["0.1"]); } catch { /* keep polling */ }
          }
          if (ack) out(`  ${c(GREEN)}shown${c(RESET)} at ${new Date(ack.t).toLocaleTimeString()}${ack.shown ? "" : " (pet is hidden)"}\n`);
          else if (!petPidAlive()) out(`  ${c(YELLOW)}not running${c(RESET)} — babyzilla pet start\n`);
          else out(`  ${c(YELLOW)}stored${c(RESET)} — the pet will pick it up (old app build?)\n`);
          return;
        }
        if (sub === "emit") {
          const id = rest[rest.indexOf("emit") + 1];
          const sayAt = rest.indexOf("--say");
          const line = sayAt !== -1 ? rest[sayAt + 1] : null;
          if (!id || id.startsWith("-")) {
            if (!line) {
              out("usage: babyzilla pet emit <expression-id> [--hold 2] [--say \"text\"]\n");
              process.exitCode = 2;
              return;
            }
          } else {
            if (!expressionById[id]) {
              out(`${c(YELLOW)}unknown expression${c(RESET)} ${id} — try: babyzilla pet list\n`);
              process.exitCode = 2;
              return;
            }
            // face first, then the bubble: the pet should be wearing the
            // expression by the time it speaks
            petEmitLine({ kind: "expr", id, hold: Number(rest[rest.indexOf("--hold") + 1]) || 2 });
          }
          if (line) petEmitLine({ kind: "say", text: line });
          if (id && !id.startsWith("-")) out(`emitted ${id}\n`);
          return;
        }
        if (sub === "start" || sub === "stop") {
          if (sub === "stop") {
            const pid = petStop();
            out(pid ? `stopped ${pid}\n` : "pet was not running\n");
            return;
          }
          if (petPidAlive()) { out(`already running (pid ${petPidAlive()})\n`); return; }
          if (!fs.existsSync(PET_APP)) { out("no app installed — babyzilla pet install\n"); process.exitCode = 1; return; }
          const pid = petStart();
          out(pid ? `started pid ${pid}\n` : "could not start\n");
          if (!pid) process.exitCode = 1;
          return;
        }

        if (sub === "remove" || sub === "retire") {
          const name = rest[rest.indexOf(sub) + 1];
          if (!name) { out(`usage: babyzilla pet ${sub} <pack|babyzilla>\n`); process.exitCode = 2; return; }
          const cfg = readPetConfig();
          const active = cfg.pack ?? "babyzilla";
          const builtin = name === "babyzilla" || name === "default";
          const id = builtin ? "babyzilla" : name;
          const pack = builtin ? null : listPacks().find((p) => p.id === name);
          if (!builtin && !pack) {
            out(`${c(YELLOW)}unknown pet${c(RESET)} ${name} — try: babyzilla pet packs\n`);
            process.exitCode = 2;
            return;
          }
          if (active === id) {
            // Deleting the art the app is drawing from would leave a blank window
            // on the next launch; make switching the explicit step it should be.
            out(`${c(YELLOW)}refusing${c(RESET)}: ${id} is the pet on screen — switch first: babyzilla pet use <other>\n`);
            process.exitCode = 2;
            return;
          }
          writeRetired(new Set([...readRetired(), id]));
          let gone = 0;
          if (builtin) {
            const dir = path.join(petStateDir(), "sprites");
            for (const file of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
              if (!file.endsWith(".png")) continue;
              fs.rmSync(path.join(dir, file));
              gone++;
            }
            fs.rmSync(path.join(petStateDir(), "pet-data.json"), { force: true });
          } else {
            const dir = path.join(petStateDir(), "packs", id);
            if (fs.existsSync(dir)) { fs.rmSync(dir, { recursive: true, force: true }); gone = 1; }
          }
          out(`removed ${builtin ? "BabyZilla (built-in)" : pack.label}${gone ? "" : ` ${c(DIM)}(was not installed)${c(RESET)}`}\n`);
          out(`  ${c(DIM)}restore with: babyzilla pet restore ${id}${c(RESET)}\n`);
          return;
        }

        if (sub === "restore") {
          const name = rest[rest.indexOf("restore") + 1] ?? "babyzilla";
          const id = name === "default" ? "babyzilla" : name;
          const bundled = id === "babyzilla"
            || fs.existsSync(path.join(repoRoot(), "assets", "pet", "packs", id, "pack.json"));
          if (!bundled) {
            out(`${c(YELLOW)}no bundled pet called${c(RESET)} ${id} — a pack from a sheet is reinstalled with pet/pack.mjs\n`);
            process.exitCode = 2;
            return;
          }
          try {
            const frames = petRestore(id);
            out(`restored ${id} (${frames} frames)\n`);
          } catch (e) { out(`${c(YELLOW)}restore failed:${c(RESET)} ${e.message}\n`); process.exitCode = 1; }
          return;
        }

        if (sub === "packs" || sub === "use") {
          const packs = listPacks();
          const cfgNow = readPetConfig();
          const retired = readRetired();
          const dinoOnDisk = packs.some((p) => p.id === "lil-dino");
          const active = cfgNow.pack ?? (dinoOnDisk ? "lil-dino" : "babyzilla");
          if (sub === "packs") {
            for (const p of packs) {
              if (retired.has(p.id)) continue;
              const anims = Object.entries(p.animations ?? {}).map(([k, v]) => `${k} ${v.length}`).join(", ");
              out(`  ${p.id.padEnd(16)} ${p.label} ${c(DIM)}${anims}${c(RESET)}${active === p.id ? `  ${c(GREEN)}active${c(RESET)}` : ""}\n`);
            }
            const listed = packs.filter((p) => !retired.has(p.id)).length;
            out(`\nswitch with: babyzilla pet use <name>\n`);
            if (!listed) {
              out(`${c(DIM)}no pets installed — babyzilla pet install ships Lil Dino, and pet catalog has 1300+ more${c(RESET)}\n`);
            } else {
              out(`${c(DIM)}more pets: babyzilla pet catalog, then pet add <id>${c(RESET)}\n`);
            }
            if (retired.size) {
              out(`${c(DIM)}removed: ${[...retired].join(", ")} — babyzilla pet restore <name> brings it back${c(RESET)}\n`);
            }
            return;
          }
          const name = rest[rest.indexOf("use") + 1];
          if (!name) { out("usage: babyzilla pet use <pack|babyzilla>\n"); process.exitCode = 2; return; }
          const cfg = readPetConfig();
          const wanted = name === "default" ? "babyzilla" : name;
          if (readRetired().has(wanted)) {
            out(`${c(YELLOW)}${wanted} was removed${c(RESET)} — restore it: babyzilla pet restore ${wanted}\n`);
            process.exitCode = 2;
            return;
          }
          if (name === "babyzilla" || name === "default") {
            delete cfg.pack;
            writePetConfig(cfg);
            out(`pet: BabyZilla (built-in)\n`);
          } else {
            const pack = packs.find((p) => p.id === name);
            if (!pack) {
              out(`${c(YELLOW)}unknown pack${c(RESET)} ${name} — try: babyzilla pet packs\n`);
              process.exitCode = 2;
              return;
            }
            cfg.pack = name;
            if (pack.defaultScale) cfg.scale = pack.defaultScale;
            writePetConfig(cfg);
            out(`pet: ${pack.label}\n`);
          }
          // only relaunch a pet that was already up: switching while closed
          // should not start one behind the user's back
          const wasRunning = petStop();
          if (wasRunning) {
            const pid = petStart();
            if (pid) out(`${c(GREEN)}restarted${c(RESET)} pid ${pid}\n`);
            else { out(`${c(YELLOW)}could not restart the pet${c(RESET)}\n`); process.exitCode = 1; }
          }
          return;
        }

        if (sub === "list") {
          let last = "";
          for (const e of EXPRESSIONS) {
            if (e.cat !== last) { out(`\n${c(BOLD)}${e.cat}${c(RESET)}\n`); last = e.cat; }
            out(`  ${e.id.padEnd(18)} ${e.label}\n`);
          }
          out(`\n${EXPRESSIONS.length} expressions\n`);
          return;
        }
        if (sub === "gallery") {
          const file = path.join(petStateDir(), "gallery.html");
          if (!fs.existsSync(file)) { out("no gallery installed — run: babyzilla pet install\n"); process.exitCode = 1; return; }
          execFileSync(tool("open"), [file]);
          out(`opened ${file}\n`);
          return;
        }
        // status
        const own = petPidAlive();
        const pids = own ? [String(own)] : petRunning();
        const spriteDir = path.join(petStateDir(), "sprites");
        const files = fs.existsSync(spriteDir)
          ? new Set(fs.readdirSync(spriteDir).filter((f) => f.endsWith(".png")).map((f) => f.slice(0, -4))) : new Set();
        const covered = EXPRESSIONS.filter((e) => files.has(e.id)).length;
        const loco = [...files].filter((f) => f.startsWith("loco-")).length;
        let lastEvent = "none";
        try {
          const lines = fs.readFileSync(eventsPath(), "utf8").trim().split("\n");
          const last = JSON.parse(lines[lines.length - 1]);
          lastEvent = `${new Date(last.t).toLocaleTimeString()} ${last.kind}${last.id ? ` ${last.id}` : ""}`;
        } catch { /* no events yet */ }
        out(`${c(BOLD)}BabyZilla pet${c(RESET)}\n`);
        out(`  app       ${pids.length ? `${c(GREEN)}running${c(RESET)} (pid ${pids.join(", ")})` : `${c(YELLOW)}not running${c(RESET)} — babyzilla pet install`}\n`);
        out(`  installed ${pids.length || fs.existsSync(PET_APP) ? PET_APP : `${c(DIM)}no${c(RESET)}`}\n`);
        const activePack = readPetConfig().pack;
        const packLabel = activePack ? (listPacks().find((p) => p.id === activePack)?.label ?? activePack) : "BabyZilla";
        out(`  pet       ${packLabel}${activePack ? ` ${c(DIM)}(pack)${c(RESET)}` : ""}\n`);
        if (!activePack) out(`  sprites   ${covered}/${EXPRESSIONS.length} expressions${loco ? ` + ${loco} locomotion frames` : ""}\n`);
        out(`  events    ${eventsPath()}\n  last      ${lastEvent}\n`);
        out(`  mark      ${readMark(petStateDir()) ?? `${c(DIM)}none${c(RESET)}`}\n`);
        const activeVoice = resolveVoice(petStateDir());
        out(`  voice     ${activeVoice.label} ${c(DIM)}(${activeVoice.id})${c(RESET)}\n`);
        const lang = resolveLanguage(petStateDir());
        out(`  language  ${LANGUAGES[lang].label} ${c(DIM)}(${lang})${c(RESET)}\n`);
        out(`  config    ${path.join(petStateDir(), "config.json")}\n`);
        return;
      }
      case "update": {
        const checkOnly = rest.includes("--check");
        const assumeYes = rest.includes("--yes") || rest.includes("-y");
        const asJson = rest.includes("--json");
        const current = pkgVersion();
        const repo = repoRoot();
        void (async () => {
          const res = await checkForUpdate({ root: packRoot(), current, force: true });
          if (asJson) out(JSON.stringify({ ...res, repo }, null, 2) + "\n");
          if (!res?.ok) {
            if (!asJson) {
              out(`could not check for updates${res?.error ? ` (${res.error})` : ""} — try again later\n`);
            }
            process.exitCode = 1;
            return;
          }
          if (!res.newer) {
            if (!asJson) out(`babyzilla ${current} is current (latest v${res.latest})\n`);
            return;
          }
          if (!asJson) out(`update available: v${current} → v${res.latest}\n  ${res.url}\n`);
          if (checkOnly) return;
          let yes = assumeYes;
          if (!yes) {
            if (!process.stdin.isTTY) {
              if (!asJson) out(`\nrun \`babyzilla update --yes\` to update, or: git -C ${repo} pull --ff-only\n`);
              return;
            }
            yes = await confirm("Update now? [y/N] ");
          }
          if (!yes) { if (!asJson) out("not updating\n"); return; }
          if (!asJson) out("updating…\n");
          const done = await applyUpdate({ repo });
          if (done.ok) {
            const moved = done.before && done.after && done.before !== done.after;
            out(moved
              ? `updated ${done.before} → ${done.after} — restart opencode to load it\n`
              : `already at ${done.after ?? current} (git pull found nothing new) — restart opencode if you just updated\n`);
          } else if (done.kind === "git") {
            out(`update failed: ${done.reason}\n`);
            process.exitCode = 1;
          } else {
            out(`this copy is not a git checkout — update it with:\n  ${done.commands.join("\n  ")}\n`);
            process.exitCode = 1;
          }
        })();
        break;
      }
      case "_update-check": {
        // Detached refresh target: quiet, self-throttling, exits when done.
        void checkForUpdate({ root: packRoot(), current: pkgVersion() }).catch(() => {});
        break;
      }
      case "--help": case "-h": case "help": case "": out(HELP); break;
      case "--version": case "-V": out(`babyzilla ${pkgVersion()}\n`); break;
      default: out(`unknown command: ${cmd}\n\n${HELP}`); process.exitCode = 2;
    }
    maybeUpdateNotice(cmd ?? "", rest, out);
  } catch (e) {
    out(`${c(YELLOW)}error:${c(RESET)} ${e.message}\n`);
    process.exitCode = 1;
  }
}

// run only when executed directly (importable for tests).
// realpath both sides: the bin is normally reached through a symlink on PATH
// (~/.local/bin/babyzilla), and argv[1] keeps the link path.
if (process.argv[1]) {
  let self = path.resolve(process.argv[1]);
  try { self = fs.realpathSync(self); } catch { /* keep the resolved path */ }
  if (import.meta.url === pathToFileURL(self).href) main();
}