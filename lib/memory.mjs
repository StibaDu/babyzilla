// Cross-session memory search — BM25 over ContextPack modules.
//
// `recall` is exact but needs a handle; trigger matching needs the author's
// keyword list. Neither answers "which session dealt with ECONNRESET?".
// This module ranks the distilled memory that already exists on disk —
// session modules and the project library — with Okapi BM25. It is
// read-only, dependency-free and model-free: no embeddings, no network.
//
// Raw tool pages are deliberately out of scope. They are 59MB of bytes, not
// distilled facts; the module is the thing worth finding again. The CLI is
// invoked on demand, so indexing costs zero prompt tokens when unused.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { dirSlug, fmt } from "./distill.mjs";

const K1 = 1.2;
const B = 0.75;
export const DEFAULT_LIMIT = 5;
export const DEFAULT_MAX_CHARS = 1200;
const DEFAULT_SNIPPET_CHARS = 180;
// Keep a single hit readable even when the caller asks for a tiny cap.
const MIN_RENDER_CHARS = 240;
// Journal heads are already truncated by the plugin; cap image/base64 noise.
const JOURNAL_HEAD_CHARS = 600;

const WORD_RE = /[\p{L}\p{N}_]+/gu;
const CJK_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

/**
 * Split text into BM25 terms. Latin identifiers stay whole (`ECONNRESET`,
 * `pages_mjs`); CJK runs also emit bigrams so a two-character query can match
 * without a dictionary. Single characters are kept: they carry little weight
 * after IDF, and dropping them would make `grep -n C` unfindable.
 */
export function tokenize(text) {
  const out = [];
  for (const match of String(text ?? "").toLowerCase().matchAll(WORD_RE)) {
    const token = match[0];
    if (!CJK_RE.test(token)) { out.push(token); continue; }
    const chars = Array.from(token);
    for (let i = 0; i < chars.length; i++) {
      out.push(chars[i]);
      if (i + 1 < chars.length) out.push(chars[i] + chars[i + 1]);
    }
  }
  return out;
}

function contentHash(text) {
  return crypto.createHash("sha1").update(text).digest("hex");
}

function moduleFile(base, mod) {
  if (typeof mod.path === "string" && path.isAbsolute(mod.path)) return mod.path;
  const file = mod.file || (mod.path ? path.basename(mod.path) : "");
  return file ? path.join(base, file) : null;
}

function readModule(base, mod) {
  const file = moduleFile(base, mod);
  if (!file) return null;
  try {
    return { path: file, text: fs.readFileSync(file, "utf8") };
  } catch {
    return null;
  }
}

/** Modules that describe a single turn are stale by the next session. */
function searchableModule(mod) {
  if (!mod || typeof mod !== "object") return false;
  if (mod.kind === "anchor") return false;
  if (mod.name === "recovered") return false;
  return true;
}

function makeDoc({ source, sessionID, projectDir, project, mod, file, text }) {
  return {
    source,
    sessionID: sessionID ?? null,
    projectDir: projectDir ?? null,
    project: project ?? (projectDir ? dirSlug(projectDir) : "unknown"),
    name: mod.name || path.basename(file, ".md"),
    kind: mod.kind || "",
    hot: mod.hot === true,
    tokens: Number(mod.tokens) || 0,
    triggers: Array.isArray(mod.triggers) ? mod.triggers.filter((t) => typeof t === "string") : [],
    created: mod.created || null,
    path: file,
    text,
  };
}

/**
 * A tab that never compacted has no modules. Its journal still records what
 * the tools did (target, status, a truncated head), so an open-tab search can
 * fall back to that instead of silently omitting the session.
 */
function readJournalDocuments(base, sessionID) {
  const file = path.join(base, "journal.jsonl");
  let raw;
  try { raw = fs.readFileSync(file, "utf8"); } catch { return []; }
  const docs = [];
  const lines = raw.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    const head = typeof entry.head === "string" ? entry.head : "";
    if (!head) continue;
    const tool = typeof entry.tool === "string" && entry.tool ? entry.tool : "journal";
    const status = typeof entry.status === "string" ? entry.status : "";
    docs.push({
      source: "journal",
      sessionID,
      projectDir: null,
      project: "unknown",
      name: `${tool}${status ? `-${status}` : ""}`,
      kind: "journal",
      hot: false,
      tokens: Number(entry.tokens) || 0,
      triggers: [],
      created: Number.isFinite(entry.t) ? new Date(entry.t).toISOString() : null,
      path: file,
      text: `${tool} ${status}\n${head.slice(0, JOURNAL_HEAD_CHARS)}`.trim(),
      line: i + 1,
    });
  }
  return docs;
}

/**
 * Read every searchable module under `root`. `projectDir` restricts both the
 * session packs and the library to that directory; without it, all projects
 * are searched (the useful default for "where did we deal with X?").
 */
export function collectMemoryDocuments(root, { projectDir = null, sessionIDs = null, includeLibrary = true } = {}) {
  const wantProject = projectDir ? path.resolve(projectDir) : null;
  const wanted = Array.isArray(sessionIDs) && sessionIDs.length ? new Set(sessionIDs) : null;
  const docs = [];
  const stats = {
    documents: 0, sessions: 0, projects: 0, skipped: 0, duplicates: 0, journals: 0, shortTerm: 0,
    scope: wanted ? "open" : "all", requestedSessions: wanted ? wanted.size : 0,
  };
  const seen = new Set();
  const foundSessions = new Set();
  const indexed = new Set();
  const projects = new Set();

  const push = (doc) => {
    const hash = contentHash(doc.text);
    if (seen.has(hash)) { stats.duplicates++; return; }
    seen.add(hash);
    docs.push(doc);
    stats.documents++;
    if (doc.source === "journal") stats.journals++;
    if (doc.source === "short-term") stats.shortTerm++;
    if (doc.sessionID) foundSessions.add(doc.sessionID);
    if (doc.project) projects.add(doc.project);
  };

  let sessionDirs = [];
  try {
    sessionDirs = fs.readdirSync(path.join(root, "sessions"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(root, "sessions", entry.name));
  } catch { /* no packs yet */ }

  sessionDirs.sort((a, b) => {
    const ca = readJson(path.join(a, "index.json"))?.created ?? "";
    const cb = readJson(path.join(b, "index.json"))?.created ?? "";
    return String(cb).localeCompare(String(ca));
  });

  for (const base of sessionDirs) {
    const idx = readJson(path.join(base, "index.json"));
    if (!idx || !Array.isArray(idx.modules)) continue;
    const sessionProject = typeof idx.projectDir === "string" && idx.projectDir ? idx.projectDir : null;
    if (wantProject && (!sessionProject || path.resolve(sessionProject) !== wantProject)) continue;
    const sessionID = idx.sessionID || path.basename(base);
    if (wanted && !wanted.has(sessionID)) continue;
    indexed.add(sessionID);
    for (const mod of idx.modules) {
      if (!searchableModule(mod)) continue;
      const read = readModule(base, mod);
      if (!read) { stats.skipped++; continue; }
      push(makeDoc({
        source: "session", sessionID, projectDir: sessionProject,
        project: sessionProject ? dirSlug(sessionProject) : "unknown",
        mod: { ...mod, created: idx.created ?? null }, file: read.path, text: read.text,
      }));
    }
    // Retired revisions are memory too: searchable, labeled, never attached.
    for (const row of Array.isArray(idx.shortTerm) ? idx.shortTerm : []) {
      if (!row || typeof row.path !== "string") continue;
      if (row.kind === "anchor" || row.name === "recovered") continue;
      const file = path.isAbsolute(row.path) ? row.path : path.join(base, row.path);
      let text;
      try { text = fs.readFileSync(file, "utf8"); } catch { stats.skipped++; continue; }
      push({
        ...makeDoc({
          source: "short-term", sessionID, projectDir: sessionProject,
          project: sessionProject ? dirSlug(sessionProject) : "unknown",
          mod: {
            name: row.name, kind: row.kind, tokens: row.tokens,
            triggers: row.triggers, hot: false, created: row.at,
          },
          file, text,
        }),
        retired: true,
        seq: row.seq,
      });
    }
  }

  // Tab-scoped fallback: a session that has not compacted still has a journal.
  // Do not guess a project for it when --project is in force.
  if (wanted && !wantProject) {
    for (const sessionID of wanted) {
      if (indexed.has(sessionID)) continue;
      for (const doc of readJournalDocuments(path.join(root, "sessions", sessionID), sessionID)) {
        push(doc);
      }
    }
  }

  let libDirs = [];
  // Library rows do not carry their source session, so they cannot be scoped
  // to the open tabs. A tab-scoped search therefore searches packs only.
  if (includeLibrary && !wanted) {
    try {
      libDirs = fs.readdirSync(path.join(root, "library"), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch { /* no library yet */ }
  }
  if (wantProject) {
    const slug = dirSlug(wantProject);
    libDirs = libDirs.filter((name) => name === slug);
  }
  for (const slug of libDirs) {
    const base = path.join(root, "library", slug);
    const idx = readJson(path.join(base, "index.json"));
    if (!idx) continue;
    for (const mod of Array.isArray(idx.modules) ? idx.modules : []) {
      if (!searchableModule(mod)) continue;
      const read = readModule(base, mod);
      if (!read) { stats.skipped++; continue; }
      push(makeDoc({
        source: "library", sessionID: null,
        projectDir: idx.projectDir ?? (wantProject || null),
        project: slug, mod: { ...mod, created: idx.updated ?? idx.created ?? null },
        file: read.path, text: read.text,
      }));
    }
    for (const row of Array.isArray(idx.shortTerm) ? idx.shortTerm : []) {
      if (!row || typeof row.path !== "string") continue;
      if (row.kind === "anchor" || row.name === "recovered") continue;
      const file = path.isAbsolute(row.path) ? row.path : path.join(base, row.path);
      let text;
      try { text = fs.readFileSync(file, "utf8"); } catch { stats.skipped++; continue; }
      push({
        ...makeDoc({
          source: "short-term", sessionID: null,
          projectDir: idx.projectDir ?? (wantProject || null),
          project: slug,
          mod: {
            name: row.name, kind: row.kind, tokens: row.tokens,
            triggers: row.triggers, hot: false, created: row.at,
          },
          file, text,
        }),
        retired: true,
        seq: row.seq,
      });
    }
  }

  stats.sessions = foundSessions.size;
  stats.projects = projects.size;
  return { docs, stats };
}

function docTokens(doc) {
  const title = [doc.name, doc.kind, ...doc.triggers].filter(Boolean).join(" ");
  // The title and triggers are a deliberate summary of the module. Repeating
  // them gives a title hit more weight than the same word buried in prose.
  return tokenize(`${title} ${title} ${doc.text}`);
}

function bestSnippet(text, terms, maxChars = DEFAULT_SNIPPET_CHARS) {
  const lines = String(text).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const wanted = new Set(terms);
  let best = 0;
  let bestScore = -1;
  for (let i = 0; i < lines.length; i++) {
    let score = 0;
    for (const token of tokenize(lines[i])) if (wanted.has(token)) score++;
    if (score > bestScore) { bestScore = score; best = i; }
  }
  const picked = lines.slice(best, best + 2).join(" ").replace(/\s+/g, " ").trim();
  if (picked.length <= maxChars) return picked;
  return Array.from(picked).slice(0, maxChars - 1).join("").trimEnd() + "…";
}

/**
 * Okapi BM25 over a document list. Exported separately so tests can rank
 * hand-built documents without touching the filesystem.
 */
export function rankDocuments(docs, query, { limit = DEFAULT_LIMIT, snippetChars = DEFAULT_SNIPPET_CHARS } = {}) {
  const queryTerms = [...new Set(tokenize(query))];
  if (!queryTerms.length) return [];

  const prepared = docs.map((doc) => {
    const tokens = docTokens(doc);
    const tf = new Map();
    for (const token of tokens) tf.set(token, (tf.get(token) ?? 0) + 1);
    return { doc, tokens, tf };
  });

  const count = prepared.length;
  const avgLen = count ? prepared.reduce((sum, item) => sum + item.tokens.length, 0) / count : 0;
  const df = new Map();
  for (const term of queryTerms) {
    let n = 0;
    for (const item of prepared) if (item.tf.has(term)) n++;
    df.set(term, n);
  }

  const ranked = [];
  for (const item of prepared) {
    let score = 0;
    for (const term of queryTerms) {
      const frequency = item.tf.get(term) ?? 0;
      if (!frequency) continue;
      const n = df.get(term) ?? 0;
      const idf = Math.log(1 + (count - n + 0.5) / (n + 0.5));
      const norm = 1 - B + B * (avgLen ? item.tokens.length / avgLen : 0);
      score += idf * (frequency * (K1 + 1)) / (frequency + K1 * norm);
    }
    if (score <= 0) continue;
    const { text, ...meta } = item.doc;
    ranked.push({
      ...meta,
      score: Math.round(score * 1000) / 1000,
      snippet: bestSnippet(text, queryTerms, snippetChars),
    });
  }

  ranked.sort((a, b) =>
    b.score - a.score ||
    String(b.created ?? "").localeCompare(String(a.created ?? "")) ||
    a.name.localeCompare(b.name));
  return ranked.slice(0, Math.max(1, Number(limit) || DEFAULT_LIMIT));
}

/** Search session modules plus the project library. Never reads the page store. */
export function searchMemory(root, query, {
  projectDir = null,
  sessionIDs = null,
  includeLibrary = true,
  limit = DEFAULT_LIMIT,
  snippetChars = DEFAULT_SNIPPET_CHARS,
} = {}) {
  const q = String(query ?? "").trim();
  if (!q) throw new Error("memory search needs a query");
  const { docs, stats } = collectMemoryDocuments(root, { projectDir, sessionIDs, includeLibrary });
  const hits = rankDocuments(docs, q, { limit, snippetChars });
  return { query: q, hits, stats };
}

function citation(hit) {
  const where = hit.source === "library"
    ? `library ${hit.project}`
    : hit.source === "short-term"
      ? hit.sessionID
        ? `session ${hit.sessionID} · short-term${hit.seq ? ` #${hit.seq}` : ""}`
        : `library ${hit.project} · short-term${hit.seq ? ` #${hit.seq}` : ""}`
      : `session ${hit.sessionID ?? "unknown"}`;
  const line = hit.source === "journal" && hit.line ? ` · line ${hit.line}` : "";
  return `[${where}] ${hit.name} · ${hit.kind || "module"} · ${fmt(hit.tokens)} tok${
    hit.created ? ` · ${String(hit.created).slice(0, 10)}` : ""
  }${line}`;
}

/** Render a compact, capped answer: header, one block per hit, and a read path. */
export function renderMemory(result, { maxChars = DEFAULT_MAX_CHARS } = {}) {
  const cap = Math.max(MIN_RENDER_CHARS, Number(maxChars) || DEFAULT_MAX_CHARS);
  const { query, hits, stats } = result;
  const scope = stats.scope === "open"
    ? `${stats.sessions} of ${stats.requestedSessions} open sessions`
    : `${stats.sessions} sessions`;
  const corpus = stats.journals || stats.shortTerm ? `${stats.documents} entries` : `${stats.documents} modules`;
  const noun = stats.journals || stats.shortTerm ? "entry" : "module";
  const header = hits.length
    ? `memory: ${hits.length} hit${hits.length === 1 ? "" : "s"} for "${query}" · ${corpus} / ${scope}`
    : `memory: no ${noun} matches "${query}" · ${corpus} / ${scope}`;
  if (!hits.length) return header + "\n";

  const blocks = [header];
  hits.forEach((hit, index) => {
    blocks.push(`${index + 1}. ${citation(hit)}`);
    blocks.push(`   read ${hit.path}`);
    if (hit.snippet) blocks.push(`   ${hit.snippet}`);
    blocks.push("");
  });
  const text = blocks.join("\n").replace(/\n+$/, "") + "\n";
  if (text.length <= cap) return text;
  const cut = text.lastIndexOf("\n", cap - 1);
  return (cut > 0 ? text.slice(0, cut) : text.slice(0, cap - 2)) + "\n";
}
