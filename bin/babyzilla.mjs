#!/usr/bin/env node
// BabyZilla CLI — inspect ContextPack session data.
// Zero dependencies, node:stdlib only. Same core logic as the Rust
// `lowfat pack` companion; data lives in ~/.opencode/contextpacks/.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { sessionCosts, totals, defaultDbPath, openDb, hasTable, auditPrices } from "../lib/cost.mjs";
import { readPage, prunePages } from "../lib/pages.mjs";
import { extractProbes, scorePack, missingFactsModule } from "../lib/eval.mjs";
import { loadDB, explain as explainModels } from "../lib/modeldb.mjs";

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

Environment:
  BABYZILLA_ROOT=<dir>              data root (default ~/.opencode/contextpacks)
  OPENCODE_DB=<path>                OpenCode database for babyzilla cost/recall
`;

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
      case "--help": case "-h": case "help": case "": out(HELP); break;
      case "--version": case "-V": {
        const { version } = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
        out(`babyzilla ${version}\n`);
        break;
      }
      default: out(`unknown command: ${cmd}\n\n${HELP}`); process.exitCode = 2;
    }
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