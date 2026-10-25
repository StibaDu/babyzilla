#!/usr/bin/env node
// Live A/B: measure what BabyZilla's request-time compression actually saves
// against the very same task with the plugin absent from the config.
//
// Both legs run the real `opencode run` against a real model. The only
// difference is XDG_CONFIG_HOME: the "off" leg gets a copy of the user's
// config with the plugin entry stripped, so system prompt, agents, MCP and
// credentials stay constant and the plugin is the single variable.
//
// Measurement comes from OpenCode's own per-request accounting in its DB,
// not from BabyZilla's counters, so the numbers are not self-reported.

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cacheResets } from "../lib/cost.mjs";

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? def : args[i + 1];
};

const MODEL = opt("model", "ollama-cloud/deepseek-v4.1-flash:1017");
const NFILES = Number(opt("files", 10));
const KB = Number(opt("kb", 14));
// `--dump 1` makes each file one enormous line of JSON: the shape that used to
// defeat line-based compression entirely (few huge lines → no lines to drop).
const DUMP = opt("dump", null) === "1";
const WORK = opt("work", path.join(os.tmpdir(), `bz-ab-${Date.now()}`));
const CONFIG_SRC = path.join(os.homedir(), ".config", "opencode");
const REPO = path.resolve(new URL("..", import.meta.url).pathname);

// ── fixture ────────────────────────────────────────────────────────────────
// Deterministic pseudo-random prose: identical bytes in both legs, no shared
// cache between them, and enough bulk that context growth dominates cost.
function lcg(seed) {
  let s = seed >>> 0;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
}

function makeFiles() {
  const rnd = lcg(20261025);
  const words = [
    "sweep", "sector", "drone", "signal", "thermal", "uplink", "beacon",
    "drift", "canopy", "ridge", "trough", "cadence", "nominal", "degraded",
  ];
  const species = ["OSPREY", "HERON", "CURLEW", "SHRIKE", "PETREL", "AVOCET", "TERN"];
  const markerAt = 1 + Math.floor(rnd() * NFILES);
  const marker = `KESTREL-${1000 + Math.floor(rnd() * 9000)}`;
  const files = [];
  const bytes = KB * 1024;
  for (let i = 1; i <= NFILES; i++) {
    const id = String(i).padStart(2, "0");
    const lines = [];
    let size = 0;
    let seq = 0;
    while (size < bytes) {
      seq++;
      const line =
        `2026-10-${String(1 + (seq % 28)).padStart(2, "0")}T` +
        `${String(seq % 24).padStart(2, "0")}:${String((seq * 7) % 60).padStart(2, "0")}:` +
        `${String((seq * 13) % 60).padStart(2, "0")}Z ` +
        `level=${seq % 17 === 0 ? "warn" : "info"} unit=alpha-${i} seq=${String(seq).padStart(6, "0")} ` +
        `species=${species[(seq + i) % species.length]} ` +
        `latency_ms=${(20 + rnd() * 400).toFixed(1)} ` +
        `drift=${(rnd() * 2 - 1).toFixed(4)} ` +
        `note=${words[(seq * 3 + i) % words.length]}-${words[(seq + i) % words.length]} ` +
        `checksum=${Math.floor(rnd() * 1e9).toString(36)}`;
      lines.push(line);
      size += line.length + 1;
    }
    // The one retrievable fact, buried at 60% of the file so it cannot be
    // read off the head of a truncated tool result.
    if (i === markerAt) {
      const at = Math.floor(lines.length * 0.6);
      lines.splice(
        at,
        0,
        `2026-10-14T03:11:07Z level=warn unit=alpha-${i} note=rare detect ` +
        `species=${marker} confirmed by two independent passes over sector 9.`,
      );
    }
    // Dump mode: one line per file, as if the tool returned minified JSON —
    // the shape that motivated the character-window compressor.
    const body = DUMP
      ? `${JSON.stringify({ file: id, format: "jsonl-minified", events: lines })}\n`
      : lines.join("\n") + "\n";
    files.push({ id, body });
  }
  return { files, marker, markerFile: String(markerAt).padStart(2, "0") };
}

const { files, marker, markerFile } = makeFiles();

function materialize(dir) {
  const survey = path.join(dir, "survey");
  fs.mkdirSync(survey, { recursive: true });
  for (const f of files) fs.writeFileSync(path.join(survey, `${f.id}.txt`), f.body);
}

// ── config isolation ───────────────────────────────────────────────────────
function makeOffConfig() {
  const dir = path.join(WORK, "cfgoff", "opencode");
  fs.mkdirSync(dir, { recursive: true });
  // Copy everything that shapes the request (instructions, agents, commands)
  // so the only delta is the plugin.
  for (const entry of fs.readdirSync(CONFIG_SRC)) {
    if (["node_modules", "plugins", "plugins-disabled", "opencode.db"].includes(entry)) continue;
    if (entry.endsWith(".db") || entry.startsWith("opencode.jsonc.bak")) continue;
    fs.cpSync(path.join(CONFIG_SRC, entry), path.join(dir, entry), { recursive: true });
  }
  const cfgPath = path.join(dir, "opencode.jsonc");
  const raw = fs.readFileSync(cfgPath, "utf8");
  const stripped = stripPlugins(raw);
  fs.writeFileSync(cfgPath, stripped);
  return dir;
}

// Same isolation, but keep the plugin and inject option overrides — used to
// sweep policy knobs (requestBudgetTokens) without touching the live config.
function makeOnConfig(overrides) {
  const dir = path.join(WORK, "cfg" + Object.values(overrides).join("-"), "opencode");
  fs.mkdirSync(dir, { recursive: true });
  for (const entry of fs.readdirSync(CONFIG_SRC)) {
    if (["node_modules", "plugins", "plugins-disabled", "opencode.db"].includes(entry)) continue;
    if (entry.endsWith(".db") || entry.startsWith("opencode.jsonc.bak")) continue;
    fs.cpSync(path.join(CONFIG_SRC, entry), path.join(dir, entry), { recursive: true });
  }
  const cfgPath = path.join(dir, "opencode.jsonc");
  let raw = fs.readFileSync(cfgPath, "utf8");
  for (const [k, v] of Object.entries(overrides)) {
    // Override an existing option line, else append it after "options": {.
    const re = new RegExp(`("${k}"\\s*:\\s*)[^,\\n}]+`);
    raw = re.test(raw)
      ? raw.replace(re, `$1${JSON.stringify(v)}`)
      : raw.replace(/"options"\s*:\s*\{/, `"options": {\n        "${k}": ${JSON.stringify(v)},`);
  }
  fs.writeFileSync(cfgPath, raw);
  return dir;
}

// Remove the "plugins": [...] block by brace matching, preserving everything
// else (comments included) verbatim.
function stripPlugins(src) {
  const key = src.search(/"plugins"\s*:/);
  if (key === -1) return src;
  let i = src.indexOf("[", key);
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let j = i; j < src.length; j++) {
    const ch = src[j];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "[") depth++;
    else if (ch === "]") {
      depth--;
      if (depth === 0) return src.slice(0, key) + '"plugins": []' + src.slice(j + 1);
    }
  }
  throw new Error("could not parse plugins array");
}

// ── legs ───────────────────────────────────────────────────────────────────
const PROMPT =
  `Survey the log files in ./survey. There are exactly ${files.length}: ` +
  `read ${files.map((f) => `${f.id}.txt`).join(", ")} — ` +
  `in numeric order, exactly one \`read\` call per step, and print just the file id ` +
  `after each read. Every one of the ${files.length} files must be read; do not stop ` +
  `early and do not answer before the last file is read. Do not re-read a file and do ` +
  `not use grep, shell, or glob. Final answer, one line: FINAL <file id> — <the exact ` +
  `KESTREL-<n> token> — "<the sentence it appears in>".`;

const DBG = path.join(process.env.BABYZILLA_ROOT || path.join(os.homedir(), ".opencode", "contextpacks"), "debug.log");
const logLines = () => {
  try { return fs.readFileSync(DBG, "utf8").split("\n").length; } catch { return 0; }
};

let REP = 1;
function runLeg(label, cwd, env) {
  const out = path.join(WORK, `${label}-rep${REP}.jsonl`);
  const before = logLines();
  const t0 = Date.now();
  const r = spawnSync(
    "opencode",
    ["run", "--standalone=true", "-m", MODEL, "--auto", "--format", "json", PROMPT],
    {
      cwd,
      // OpenCode resolves the project from PWD, not the process cwd.
      env: { ...process.env, ...env, PWD: cwd, INIT_CWD: cwd },
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
    },
  );
  fs.writeFileSync(out, r.stdout || "");
  if (r.status !== 0) {
    console.error(`  ${label}: exit ${r.status}\n${(r.stderr || "").slice(-800)}`);
  }
  const sid = /"sessionID":"(ses_[^"]+)"/.exec(r.stdout || "")?.[1] ?? null;
  const text = [...(r.stdout || "").matchAll(/"type":"text"[^}]*"text":"((?:[^"\\]|\\.)*)"/g)]
    .map((m) => m[1]).join(" ");
  const compacted = logLines() - before;
  console.log(
    `  ${label.padEnd(3)} ${String(Math.round((Date.now() - t0) / 1000)).padStart(4)}s  ` +
    `${sid ?? "NO SESSION"}  pluginLog=${compacted > 0 ? `${compacted} lines` : "silent"}`,
  );
  return { sid, text, out, compacted };
}

// ── measurement ────────────────────────────────────────────────────────────
function measure(sid) {
  const script = `
import { openDb, defaultDbPath } from ${JSON.stringify(path.join(REPO, "lib", "cost.mjs"))};
const db = openDb(defaultDbPath(), { readonly: true });
const rows = db.prepare("select data from session_message where session_id=? order by seq").all(process.argv[1]);
const reqs = [];
for (const r of rows) {
  const d = JSON.parse(r.data);
  if (!d.tokens || !d.tokens.output) continue;
  reqs.push({ in: d.tokens.input||0, cache: d.tokens.cache?.read||0, out: d.tokens.output||0, cost: d.cost||0 });
}
const sum = {};
for (const k of ["in","cache","out","cost"]) sum[k] = reqs.reduce((a,r)=>a+r[k],0);
console.log(JSON.stringify({ reqs, sum, peak: Math.max(0,...reqs.map(r=>r.in+r.cache)), n: reqs.length }));
`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", script, sid], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr);
  return JSON.parse(r.stdout);
}

// ── main ───────────────────────────────────────────────────────────────────
fs.mkdirSync(WORK, { recursive: true });
const cfgOffDir = makeOffConfig();
const BUDGET = Number(opt("budget", 0));
const AA = opt("aa", null) === "1";
const RATIO = opt("ratio", null);
const OVER = {};
if (BUDGET) OVER.requestBudgetTokens = BUDGET;
if (RATIO !== null) OVER.requestTargetRatio = Number(RATIO);
const cfgOnDir = Object.keys(OVER).length ? makeOnConfig(OVER) : null;

const REPS = Number(opt("reps", 1));
console.log(`\nfixture  ${NFILES} files x ${KB}KB${DUMP ? " (single-line JSON dumps)" : ""} · marker ${marker} in ${markerFile}.txt`);
console.log(`model    ${MODEL}`);
console.log(`reps     ${REPS}`);
console.log(`on-opts  ${JSON.stringify(OVER)}`);
console.log(`work     ${WORK}\n`);

const results = [];
for (let rep = 1; rep <= REPS; rep++) {
  REP = rep;
  if (REPS > 1) console.log(`rep ${rep}/${REPS}`);
  const dirOff = path.join(WORK, `r${rep}-off`);
  const dirOn = path.join(WORK, `r${rep}-on`);
  materialize(dirOff);
  materialize(dirOn);

  // Alternate leg order so provider warming/drift cannot masquerade as an
  // effect of the plugin itself.
  const order = rep % 2 === 1 ? ["off", "on"] : ["on", "off"];
  const run = {};
  for (const leg of order) {
    run[leg] =
      leg === "off"
        ? runLeg("off", dirOff, { XDG_CONFIG_HOME: path.dirname(cfgOffDir) })
        : runLeg("on", dirOn, AA
            ? { XDG_CONFIG_HOME: path.dirname(cfgOffDir) }
            : cfgOnDir ? { XDG_CONFIG_HOME: path.dirname(cfgOnDir) } : {});
  }
  const off = run.off;
  const on = run.on;
  const mOff = measure(off.sid);
  const mOn = measure(on.sid);
  results.push({ rep, off: mOff, on: mOn, hitOff: off.text.includes(marker), hitOn: on.text.includes(marker), dupOff: dupReads(off), dupOn: dupReads(on) });
  if (REPS > 1) console.log("");
}

const prompts = (m) => m.sum.in + m.sum.cache;
const fmt = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n));
const med = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};
const nOkOff = results.filter((r) => r.hitOff).length;
const nOkOn = results.filter((r) => r.hitOn).length;

const row = (name, pick, dp = 0) => {
  const a = med(results.map((r) => pick(r.off)));
  const b = med(results.map((r) => pick(r.on)));
  const delta = a === 0 ? "-" : `${(((b - a) / a) * 100).toFixed(1)}%`;
  const f = (n) => (dp ? n.toFixed(dp) : fmt(n));
  console.log(`  ${name.padEnd(22)} ${f(a).padStart(8)} ${f(b).padStart(8)} ${delta.padStart(9)}`);
};

// Success-conditioned medians: a leg that bailed early looks cheap only
// because it did less work, so cost rows are reported both ways.
const allRow = (name, pick, dp = 0) => {
  const a = med(results.filter((r) => r.hitOff).map((r) => pick(r.off)));
  const b = med(results.filter((r) => r.hitOn).map((r) => pick(r.on)));
  const delta = !a ? "-" : `${(((b - a) / a) * 100).toFixed(1)}%`;
  const f = (n) => (dp ? n.toFixed(dp) : fmt(n));
  console.log(`  ${name.padEnd(22)} ${f(a).padStart(8)} ${f(b).padStart(8)} ${delta.padStart(9)}`);
};

console.log(`                        plugin OFF    ON   delta${REPS > 1 ? "  (medians)" : ""}`);
row("requests", (m) => m.n);
row("prompt tokens", (m) => prompts(m));
row("  cached", (m) => m.sum.cache);
row("  uncached", (m) => m.sum.in);
row("output tokens", (m) => m.sum.out);
row("peak request ctx", (m) => m.peak);
row("cost ($)", (m) => m.sum.cost, 4);
row("cost per request ($)", (m) => m.sum.cost / m.n, 5);
row("tokens per request", (m) => prompts(m) / m.n);
// Provider-side prefix evictions: our prefixes are byte-stable, so a drop in
// cached-read between requests is the provider dropping its end. Visible here
// so we stop attributing it to the plugin (and stop tuning against it).
row("cache resets", (m) => cacheResets(m.reqs).count);
row("wasted on resets", (m) => cacheResets(m.reqs).wasted);

console.log(`\nsuccess-only medians (task completed: off ${nOkOff}/${REPS}, on ${nOkOn}/${REPS})`);
allRow("requests", (m) => m.n);
allRow("prompt tokens", (m) => prompts(m));
allRow("cost ($)", (m) => m.sum.cost, 4);
allRow("cost per request ($)", (m) => m.sum.cost / m.n, 5);

if (REPS > 1) {
  console.log("\nper-rep (prompt tokens off → on, $ off → on)");
  for (const r of results) {
    console.log(
      `  r${r.rep}  ${fmt(prompts(r.off)).padStart(7)} → ${fmt(prompts(r.on)).padStart(7)}   ` +
      `$${r.off.sum.cost.toFixed(4)} → $${r.on.sum.cost.toFixed(4)}   ` +
      `steps ${r.off.n} → ${r.on.n}   marker ${r.hitOff ? "ok" : "MISS"}/${r.hitOn ? "ok" : "MISS"}`,
    );
  }
}

console.log("\ncorrectness / recovery work");
for (const r of results) {
  console.log(
    `  r${r.rep}  marker off=${r.hitOff ? "found" : "MISS"} on=${r.hitOn ? "found" : "MISS"}   ` +
    `duplicate reads off=${r.dupOff} on=${r.dupOn}`,
  );
}
console.log(`  artefacts: ${WORK}\n`);

function dupReads(leg) {
  const seen = new Map();
  let dup = 0;
  for (const line of fs.readFileSync(leg.out, "utf8").split("\n")) {
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    const p = d.part;
    if (p?.type !== "tool" || p.tool !== "read" || p.state?.status !== "completed") continue;
    const key = JSON.stringify(p.state.input ?? {});
    if (seen.has(key)) dup++;
    seen.set(key, true);
  }
  return dup;
}
