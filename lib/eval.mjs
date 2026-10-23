// Offline pack evaluation: does a pack still contain the things the next
// agent needs, and is it small?
//
// A distiller is a lossy function; the only way to know whether a given pack
// is good is to measure it against the transcript it replaced. Everything
// here is deterministic (token overlap, not embeddings, not a model), so the
// score is comparable across runs, models and days.
//
// Metrics mirror how document-retrieval systems are scored — recall of the
// citations and of the load-bearing facts, plus one hard gate: the newest
// exchange must survive.

import { estTokens } from "./text.mjs";
import { lastExchange } from "./anchor.mjs";

const STOP = new Set(("the and for that with this from your have were was are but not you can all any our out use only" +
  " into than then them they there here when what which while will would should could about after before because" +
  " file line code test tests pass fails failed more less most much such same other also just like over under").split(" "));

export function normalize(s) {
  return String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
}

const PATH_RE = /(?:^|[\s`"'(])((?:~\/|\.{1,2}\/|\/)?[\w.@-]+(?:\/[\w.@-]+)*\.[a-z0-9]{1,8})(?::(\d+))?(?=[\s`"'),.;]|$)/g;
const URL_RE = /\bhttps?:\/\/[^\s)`"']+/g;

/** File paths, path:line pointers and URLs mentioned in the transcript. */
export function extractPointers(text, { limit = 60 } = {}) {
  const seen = new Set();
  const out = [];
  for (const m of String(text || "").matchAll(PATH_RE)) {
    const rel = m[1];
    if (!rel.includes("/") && !m[2]) continue; // bare "index.js" is too ambiguous to score
    const key = m[2] ? `${rel}:${m[2]}` : rel;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
    if (out.length >= limit) return out;
  }
  for (const m of String(text || "").matchAll(URL_RE)) {
    const url = m[0].replace(/[.,;]+$/, "");
    if (seen.has(url)) continue;
    seen.add(url);
    out.push(url);
    if (out.length >= limit) return out;
  }
  return out;
}

const SIGNAL = /\b(error|failed|failure|fails?|fix|fixed|decided|decision|because|must|never|instead|next|todo|blocked|bug)\b/i;

/** The load-bearing lines of a transcript: decisions, failures, next steps. */
export function extractFacts(text, { limit = 40, minChars = 40, maxChars = 700 } = {}) {
  const seen = new Set();
  const out = [];
  const lines = String(text || "").split(/\n/);
  for (let i = lines.length - 1; i >= 0; i--) { // newest first: that is the working set
    const raw = lines[i].trim().replace(/^[-*>\d.]+[)\s]+/, "");
    if (raw.length < minChars || raw.length > maxChars) continue;
    if (/^\[tool /.test(raw) || /^\[ContextPack\]/.test(raw)) continue;
    if (!SIGNAL.test(raw)) continue;
    const key = normalize(raw).slice(0, 70);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(raw);
    if (out.length >= limit) break;
  }
  return out;
}

/** Everything a pack is scored against, derived from the transcript alone. */
export function extractProbes(transcript) {
  const messages = Array.isArray(transcript) ? transcript : parseTranscript(transcript);
  const { asks, reply } = lastExchange(messages);
  return {
    pointers: extractPointers(typeof transcript === "string" ? transcript : messages.map((m) => JSON.stringify(m.content ?? "")).join("\n")),
    facts: extractFacts(typeof transcript === "string" ? transcript : messages.map((m) => JSON.stringify(m.content ?? "")).join("\n")),
    ask: asks.at(-1) ?? "",
    reply,
  };
}

/** Turn the `### USER / ### ASSISTANT` transcript format back into messages. */
export function parseTranscript(text) {
  const out = [];
  const re = /^### ([A-Z]+)\n/gm;
  const marks = [...String(text ?? "").matchAll(re)];
  for (let i = 0; i < marks.length; i++) {
    const role = marks[i][1].toLowerCase();
    const start = marks[i].index + marks[i][0].length;
    const end = i + 1 < marks.length ? marks[i + 1].index : text.length;
    const body = text.slice(start, end).trim();
    if (body) out.push({ role, content: body });
  }
  return out;
}

const words = (s) => normalize(s).match(/[a-z0-9_./:-]{4,}/g) ?? [];

/** Share of a probe's content words that the pack still contains. */
export function overlap(probe, packNorm) {
  const w = [...new Set(words(probe))].filter((x) => !STOP.has(x));
  if (!w.length) return 0;
  let hit = 0;
  for (const x of w) if (packNorm.includes(x)) hit++;
  return hit / w.length;
}

const tail = (s, n) => (s.length <= n ? s : s.slice(-n));

/**
 * Score one pack against its transcript.
 *
 * questionKept is deliberately binary: a pack that lost the newest exchange
 * has lost the thread, no matter how well it summarised everything else.
 */
export function scorePack({ packText, probes, packTokens = null, rawTokens = 0, thresholds = {} } = {}) {
  const packNorm = normalize(packText);
  const tokens = packTokens ?? estTokens(packText);
  const factMin = thresholds.fact ?? 0.6;
  const askMin = thresholds.ask ?? 0.5;

  const pointers = probes?.pointers ?? [];
  const facts = probes?.facts ?? [];
  const pointerHits = pointers.filter((p) => packNorm.includes(normalize(p)));
  const factHits = facts.filter((f) => overlap(f, packNorm) >= factMin);

  const askTail = tail(probes?.ask ?? "", 400);
  const replyTail = tail(probes?.reply ?? "", 400);
  const askOk = askTail ? overlap(askTail, packNorm) >= askMin : true;
  const replyOk = replyTail ? overlap(replyTail, packNorm) >= askMin : true;

  const pointerRecall = pointers.length ? pointerHits.length / pointers.length : 1;
  const factRecall = facts.length ? factHits.length / facts.length : 1;
  const questionKept = askOk && replyOk ? 1 : 0;
  const ratio = rawTokens > 0 ? tokens / rawTokens : 0;
  const budget = ratio <= 0.15 ? 1 : Math.max(0, 1 - (ratio - 0.15) / 0.35);
  const quality = 0.5 * factRecall + 0.3 * pointerRecall + 0.2 * questionKept;
  const score = Math.round(100 * (0.85 * quality + 0.15 * budget));

  return {
    score,
    quality: round(quality),
    factRecall: round(factRecall),
    pointerRecall: round(pointerRecall),
    questionKept,
    facts: `${factHits.length}/${facts.length}`,
    pointers: `${pointerHits.length}/${pointers.length}`,
    tokens,
    ratio: round(ratio),
    missingFacts: facts.filter((f) => !factHits.includes(f)).slice(0, 3),
    missingPointers: pointers.filter((p) => !pointerHits.includes(p)).slice(0, 3),
    askKept: askOk,
    replyKept: replyOk,
  };
}

const round = (n) => Math.round(n * 1000) / 1000;

/**
 * Best-of-N: render each candidate, score it, keep the winner.
 * Ties break toward the smaller pack.
 */
export function selectPack(candidates, { transcript, rawTokens = 0, render = renderModules } = {}) {
  const probes = extractProbes(transcript);
  const scores = [];
  for (const c of candidates) {
    const text = render(c.modules);
    scores.push({ name: c.name, modules: c.modules, text, ...scorePack({ packText: text, probes, rawTokens }) });
  }
  scores.sort((a, b) => b.score - a.score || a.tokens - b.tokens);
  return { winner: scores[0] ?? null, scores, probes };
}

/** A pack rendered the way it is shown to the agent. */
export function renderModules(mods) {
  return (mods ?? [])
    .map((m) => `## ${m.name || m.kind}\n${m.content ?? ""}`.trim())
    .join("\n\n");
}

/**
 * Facts the pack dropped, as a module of verbatim source lines.
 *
 * The lines are copied from the transcript, never paraphrased: a recovery
 * module that invents a decision is worse than a pack that omits it.
 */
export function missingFactsModule(packText, transcript, { limit = 8 } = {}) {
  const packNorm = normalize(packText);
  const missing = extractFacts(transcript).filter((f) => overlap(f, packNorm) < 0.6).slice(0, limit);
  if (missing.length < 2) return null;
  const content = missing.map((f) => `- ${f}`).join("\n");
  return { kind: "state", name: "recovered", triggers: ["recovered", "facts"], content, tokens: estTokens(content) };
}

export function formatEval(r) {
  const pct = (n) => `${Math.round(n * 100)}%`;
  return [
    `score ${r.score}/100`,
    `facts ${r.facts} (${pct(r.factRecall)})`,
    `pointers ${r.pointers} (${pct(r.pointerRecall)})`,
    `last exchange ${r.questionKept ? "kept" : "LOST"}`,
    `size ${r.tokens} tok (${pct(r.ratio)} of raw)`,
  ].join(" · ");
}
