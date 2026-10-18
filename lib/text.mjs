// Pure text helpers shared by the plugin and the test suite.
//
// Everything here is side-effect free: no filesystem, no logging, no model
// calls. That keeps the behaviour testable without loading the plugin (whose
// module-level code touches ~/.opencode/contextpacks).

/**
 * Rough token estimate used throughout BabyZilla.
 *
 * ASCII text averages ~4 chars per token, but CJK, Cyrillic, emoji and other
 * non-ASCII text tokenize at roughly one token per character. Using 4 chars
 * per token everywhere would undercount such requests by 3-4x and could
 * overflow the window of a small model, so wide characters are counted at 1
 * token each. This is a heuristic, not a tokenizer — it errs on the safe side.
 */
export function estTokens(s) {
  if (!s) return 0;
  const str = String(s);
  if (!/[^\x00-\x7f]/.test(str)) return Math.ceil(str.length / 4);
  // UTF-16 code units: a surrogate pair (emoji) counts as 2, which is close
  // to the 2-3 tokens most models spend on it.
  const wide = str.length - str.replace(/[^\x00-\x7f]/g, "").length;
  return Math.ceil((str.length - wide) / 4 + wide);
}

// Lines that carry the shape of a file and are worth keeping verbatim.
const STRUCT_LINE_RE = /^\s*(?:\d+:\s*)?(?:export|import|from\b|class\b|def\b|async def|function\b|async function|interface\b|type\b|struct\b|impl\b|enum\b|mod\b|module\b|namespace\b|package\b|use\b|fn\b|func\b|const\b|let\b|var\b|public\b|private\b|protected\b|static\b|@|#include|##|###|####)/;
const DIAG_LINE_RE = /(?:\b(?:ERROR|FATAL|CRITICAL|WARN(?:ING)?|Exception|Traceback|panic|segfault|failed|failure)\b|\bERR[-_]?\d|\b[A-Z]{2,}[-_]\d{2,})/i;
const TODO_LINE_RE = /\b(?:TODO|FIXME|XXX|HACK)\b/;

/**
 * Compress a line-numbered tool result.
 *
 * Keeps the first `headLines`, the last `tailLines`, and every structural,
 * diagnostic, or TODO line; everything else is replaced by an elision marker
 * that preserves the original line numbering.
 *
 * Returns `null` when the input is too short or the rewrite would not save at
 * least ~15% of the lines — callers should leave the result untouched then.
 */
export function compressToolText(text, { headLines, tailLines }) {
  if (typeof text !== "string" || !text) return null;
  const lines = text.split("\n");
  if (lines.length < headLines + tailLines + 20) return null;
  const keep = new Set();
  for (let i = 0; i < Math.min(headLines, lines.length); i++) keep.add(i);
  for (let i = Math.max(0, lines.length - tailLines); i < lines.length; i++) keep.add(i);
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (STRUCT_LINE_RE.test(l) || DIAG_LINE_RE.test(l) || TODO_LINE_RE.test(l)) keep.add(i);
  }
  const out = [];
  let omitted = 0;
  for (let i = 0; i < lines.length; i++) {
    if (keep.has(i)) {
      if (omitted) {
        out.push(`[... ${omitted} line${omitted === 1 ? "" : "s"} elided by ContextPack — not truncation ...]`);
        omitted = 0;
      }
      out.push(lines[i]);
    } else omitted++;
  }
  if (omitted) out.push(`[... ${omitted} lines elided by ContextPack — not truncation ...]`);
  // Only rewrite when it actually saves meaningful space.
  if (out.length >= lines.length * 0.85) return null;
  return out.join("\n");
}

/**
 * Rewrite the model-visible parts of a tool result in place.
 *
 * `event.result.content[]` is what OpenCode sends to the model (verified: a
 * mutation here is honoured). Returns the number of parts rewritten.
 * `onCompressed(tool, before, after)` is an optional observer for logging.
 */
export function compressToolResult(event, opts, onCompressed, ref = null) {
  // The live session can hand back either shape:
  //   { result: { content: [{type:"text", text}] } }   (API shape)
  //   { state:  { output: "..." } }                     (persisted shape)
  // Normalise to a list of settable text slots; the rewrite is identical.
  let slots;
  if (Array.isArray(event?.result?.content)) slots = event.result.content;
  else if (event?.state && typeof event.state.output === "string") slots = [event.state];
  else if (Array.isArray(event?.state?.content)) slots = event.state.content;
  else return 0;
  let rewritten = 0;
  for (const part of slots) {
    const key = slots === event?.state ? "output" : "text";
    if (!part || typeof part[key] !== "string") continue;
    if (part[key].includes("[ContextPack]")) continue;
    const before = estTokens(part[key]);
    if (before < opts.toolResultMinTokens) continue;
    const compressed = compressToolText(part[key], {
      headLines: opts.toolResultHeadLines,
      tailLines: opts.toolResultTailLines,
    });
    if (!compressed) continue;
    const after = estTokens(compressed);
    const handle = ref ? ` Full output: \`babyzilla recall ${ref}\`.` : " Exact spans: `babyzilla retrieve <path>:<start>-<end>`.";
    part[key] = `${compressed}\n\n[ContextPack] ${fmt(before)} → ${fmt(after)} tokens (${Math.max(0, Math.round((1 - after / before) * 100))}% smaller).${handle}`;
    rewritten++;
    onCompressed?.(event?.tool ?? event?.name ?? "?", before, after);
  }
  return rewritten;
}

function fmt(n) {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n);
}

/**
 * Hand a text back to the caller's page store and return its handle.
 *
 * `pageRef` is provided by the plugin (content-addressed disk pages, readable
 * with `babyzilla recall <hash>`); pure-helper callers can omit it.
 */
function pageHandle(opts, text, fallback = null) {
  try {
    const h = typeof opts?.pageRef === "function" ? opts.pageRef(text) : null;
    if (h) return h;
  } catch { /* spilling must never break compaction */ }
  return fallback || null;
}

// ── Layer 1b: per-request message compaction ────────────────────────────────
//
// Layer 1 only runs when OpenCode compacts. Models with a huge window (Kimi K3
// ships 1M tokens) may never reach that point, so the plugin would have zero
// effect no matter how good the distiller is. OpenCode v2 exposes
// `session.hook("context")`, which receives the exact `messages` array of every
// outgoing request; mutating it there is honoured by the runtime (the built-in
// plan-mode plugin does the same thing).
//
// This layer enforces a hard per-request budget:
//   1. compress old tool output / assistant prose / reasoning in place;
//   2. if still above budget, elide the oldest parts down to one-line pointers.
// Recent messages (and every user message) stay verbatim, and parts already
// carrying the ContextPack marker are never rewritten twice.

export const CONTEXT_MARKER = "[ContextPack]";
const CONTEXT_ELIDE_RE = /\[ContextPack\]/;

/**
 * A one-line pointer that replaces bulk when the hard cap is reached.
 *
 * `ref` is the tool-call id of the part (or a message id for plain text). It
 * makes the marker actionable: the exact original text is one cheap call away
 * (`babyzilla recall <ref>`), for *every* tool — not just file reads.
 */
function elisionMarker(kind, tokens, ref, announce) {
  const handle = ref
    ? `Exact text: \`babyzilla recall ${ref}\` (add :start-end for a span).`
    : "File-backed text can be re-fetched by path and line range; a shell result can be re-run.";
  let note = "";
  if (announce && !announce.done) {
    announce.done = true;
    note = " This is paging, not deletion: the current task's files stay verbatim.";
  }
  if (kind === "tool") {
    return `${CONTEXT_MARKER} ~${fmt(tokens)} tokens of older tool output elided.${note} ${handle}`;
  }
  if (kind === "reasoning") return "";
  if (kind === "attachment") return `${CONTEXT_MARKER} older attachment elided (re-attach if needed).`;
  return `${CONTEXT_MARKER} ~${fmt(tokens)} tokens of older ${kind} elided.${ref ? ` ${handle}` : ""}`;
}

/**
 * Trim a prose block to a head + marker + tail.
 * Returns null when the block is already small enough to leave alone.
 */
export function compressTextBlock(text, { headChars = 1600, tailChars = 300 } = {}) {
  if (typeof text !== "string" || text.length <= headChars + tailChars + 200) return null;
  const omitted = text.length - headChars - tailChars;
  return `${text.slice(0, headChars)}\n[... ${omitted} chars elided by ContextPack — not truncation ...]\n${text.slice(-tailChars)}`;
}

/** Text accessors for every message/part shape OpenCode can hand us. */
function textRefs(part) {
  const refs = [];
  if (!part || typeof part !== "object") return refs;

  if (typeof part.text === "string") {
    refs.push({
      kind: part.type === "reasoning" ? "reasoning" : "text",
      get: () => part.text,
      set: (v) => { part.text = v; },
    });
  }

  // AI SDK tool result: {type:"tool-result", output:{type:"text", value}}
  // OpenCode LLM shape:  {type:"tool-result", result:{type:"text"|"error", value}}
  //                      {type:"tool-result", result:{type:"content", value:[…]}}
  if (part.type === "tool-result") {
    for (const holder of [part.output, part.result]) {
      if (typeof holder === "string") {
        const isResult = holder === part.result;
        refs.push({
          kind: "tool",
          get: () => holder,
          set: (v) => { if (isResult) part.result = v; else part.output = v; },
        });
        continue;
      }
      if (!holder || typeof holder !== "object") continue;
      if (typeof holder.value === "string") {
        refs.push({ kind: "tool", get: () => holder.value, set: (v) => { holder.value = v; } });
      } else if (Array.isArray(holder.value)) {
        for (const c of holder.value) {
          if (c?.type === "text" && typeof c.text === "string") {
            refs.push({ kind: "tool", get: () => c.text, set: (v) => { c.text = v; } });
          }
        }
      }
    }
  }

  // Persisted OpenCode shape: {type:"tool", state:{status,input,output}}
  // (the API shape above uses state.content instead).
  if (part.type === "tool" && part.state && typeof part.state === "object") {
    if (typeof part.state.output === "string") {
      refs.push({ kind: "tool", get: () => part.state.output, set: (v) => { part.state.output = v; } });
    }
    if (typeof part.state.error === "string") {
      refs.push({ kind: "tool", get: () => part.state.error, set: (v) => { part.state.error = v; } });
    }
    for (const c of part.state.content ?? []) {
      if (c?.type === "text" && typeof c.text === "string") {
        refs.push({ kind: "tool", get: () => c.text, set: (v) => { c.text = v; } });
      }
    }
  }

  // Note: the request shape's part id is *not* the database callID, so the
  // recall handle is the message id (stable in both places), provided by the
  // caller. `partRefOf` is kept for persisted shapes that do carry one.
  const ref = partRefOf(part);
  if (ref) for (const r of refs) r.ref ??= ref;
  return refs;
}

/** The id a tool part is known by in the session database. */
export function partRefOf(part) {
  if (!part || typeof part !== "object") return null;
  for (const k of ["callID", "toolCallId", "toolCallID", "id"]) {
    const v = part[k] ?? part.state?.[k];
    if (typeof v === "string" && v) return v;
  }
  return null;
}

/** Rough token count of a message list (text + tool-call arguments). */
export function estimateMessagesTokens(messages) {
  let n = 0;
  for (const m of Array.isArray(messages) ? messages : []) {
    if (typeof m?.text === "string") n += estTokens(m.text);
    if (typeof m?.content === "string") n += estTokens(m.content);
    if (!Array.isArray(m?.content)) continue;
    for (const p of m.content) {
      for (const r of textRefs(p)) n += estTokens(r.get());
      // Tool arguments are part of the payload too (write/edit payloads can be
      // large). Count them so the budget reflects the real request size.
      const input = p?.type === "tool-call" ? p.input : p?.type === "tool" ? p.state?.input : null;
      if (input && typeof input === "object") {
        try { n += estTokens(JSON.stringify(input)); } catch { /* circular */ }
      }
    }
  }
  return n;
}

/** Compress large string fields of old tool-call arguments (write/edit payloads). */
function compactInputFields(input, opts) {
  const limit = opts.requestInputMinChars ?? 4000;
  const head = opts.requestInputHeadChars ?? 1200;
  const tail = opts.requestInputTailChars ?? 300;
  let n = 0;
  for (const key of ["content", "newString", "oldString", "patch", "diff", "text", "body"]) {
    const v = input[key];
    if (typeof v !== "string" || v.length <= limit) continue;
    if (CONTEXT_ELIDE_RE.test(v)) continue;
    input[key] = `${v.slice(0, head)}\n[... ${v.length - head - tail} chars elided by ContextPack ...]\n${v.slice(-tail)}`;
    n++;
  }
  return n;
}

/** Shrink old tool arguments to a short, still-readable form. */
function elideInput(input, limit = 200) {
  const out = {};
  let changed = false;
  for (const [k, v] of Object.entries(input)) {
    if (typeof v === "string" && v.length > limit) {
      out[k] = `${v.slice(0, limit)}…`;
      changed = true;
    } else {
      out[k] = v;
    }
  }
  return changed ? out : null;
}

/** Compress one old part. Returns the number of refs rewritten. */
// The same persisted messages are reloaded on every agent step, so the same
// (large) strings would be re-split every step. Cache the rewrite by stable
// message id + part/ref index + length; values are immutable once persisted.
const compressCache = new Map();
const COMPRESS_CACHE_MAX = 4000;

function cacheKey(prefix, refIndex, text, opts) {
  if (!prefix) return null;
  // length + a cheap edge fingerprint guards against index collisions when a
  // message has no stable id.
  const fp = `${text.length}:${text.slice(0, 24)}:${text.slice(-24)}`;
  return `${prefix}:${refIndex}:${fp}:${opts.toolResultHeadLines ?? 40}:${opts.toolResultTailLines ?? 20}:${opts.requestHeadChars ?? 1600}:${opts.requestTailChars ?? 300}`;
}

function compactPart(part, opts, keyPrefix, { safe = false, announce = null, msgId = null } = {}) {
  if (!part || typeof part !== "object") return 0;
  let rewritten = 0;

  // Attachments (images/files) are pure token cost once the model has moved on.
  if (["file", "image", "media"].includes(part.type)) {
    if (!opts.requestElideAttachments) return 0;
    const label = part.filename ?? part.name ?? part.mediaType ?? part.type;
    part.type = "text";
    part.text = `${CONTEXT_MARKER} older attachment elided: ${label}`;
    for (const k of ["media", "data", "uri", "url", "mime", "mediaType", "filename", "source"]) delete part[k];
    return 1;
  }

  // Tool arguments are sent on every request too. Old write/edit payloads can
  // be tens of KB; keep their head/tail and elide the middle. Never do this to
  // the current turn: the agent may copy an `oldString` out of its own history.
  if (!safe && opts.requestCompressInputs !== false) {
    const input = part.type === "tool-call" ? part.input : part.type === "tool" ? part.state?.input : null;
    if (input && typeof input === "object" && !Array.isArray(input)) {
      rewritten += compactInputFields(input, opts);
    }
  }

  let refIndex = -1;
  for (const ref of textRefs(part)) {
    refIndex++;
    const text = ref.get();
    if (typeof text !== "string" || !text) continue;
    if (CONTEXT_ELIDE_RE.test(text)) continue; // idempotent

    if (ref.kind === "reasoning") {
      // Never mutate signed/encrypted reasoning: providers replay it verbatim.
      if (!opts.requestElideReasoning) continue;
      if (safe) continue; // current-turn working memory stays intact
      if (part.encrypted !== undefined || part.providerMetadata !== undefined || part.signature !== undefined) continue;
      const md = part.metadata;
      if (md && typeof md === "object" && (md.signature !== undefined || md.encrypted !== undefined || md.redacted !== undefined)) continue;
      if (announce && !announce.done) {
        announce.done = true;
        ref.set(`${CONTEXT_MARKER} older reasoning elided (paged out, not deleted).`);
      } else {
        ref.set("");
      }
      rewritten++;
      continue;
    }

    if (estTokens(text) < (opts.requestPartMinTokens ?? 800)) continue;

    const key = cacheKey(keyPrefix, refIndex, text, opts);
    const cached = key ? compressCache.get(key) : undefined;
    if (cached !== undefined) {
      ref.set(cached);
      rewritten++;
      continue;
    }

    // Line-numbered tool output compresses best with structure preserved.
    const structural = compressToolText(text, {
      headLines: opts.toolResultHeadLines ?? 40,
      tailLines: opts.toolResultTailLines ?? 20,
    });
    let next = structural;
    if (!next) next = compressTextBlock(text, {
      headChars: opts.requestHeadChars ?? 1600,
      tailChars: opts.requestTailChars ?? 300,
    });
    // Structural compression can lose to plain head/tail; take the shorter one.
    if (structural) {
      const plain = compressTextBlock(text, {
        headChars: opts.requestHeadChars ?? 1600,
        tailChars: opts.requestTailChars ?? 300,
      });
      if (plain && plain.length < structural.length) next = plain;
    }
    if (!next) continue;
    if (next.length >= text.length * 0.85) continue;
    const handleRef = pageHandle(opts, text, msgId ?? ref.ref);
    const handle = ref.kind === "tool" && handleRef ? ` · exact: babyzilla recall ${handleRef}` : "";
    const replaced = `${next}\n\n${CONTEXT_MARKER} ${fmt(estTokens(text))} → ${fmt(estTokens(next))} tokens (${Math.max(0, Math.round((1 - estTokens(next) / estTokens(text)) * 100))}% smaller)${handle}.`;
    if (key) {
      if (compressCache.size >= COMPRESS_CACHE_MAX) {
        compressCache.delete(compressCache.keys().next().value);
      }
      compressCache.set(key, replaced);
    }
    ref.set(replaced);
    rewritten++;
  }
  return rewritten;
}

/**
 * Enforce a hard token budget on the messages of one outgoing request.
 *
 * `messages` is mutated in place. Returns stats:
 * `{ before, after, saved, savedPct, parts, messages }`.
 */
export function compactMessagesForRequest(messages, opts = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const before = estimateMessagesTokens(list);
  // Respect the model's own window: a 45K cap or a 20K "don't bother" floor
  // would be larger than the whole window of a small local model (8K-32K).
  const windowTokens = Math.max(0, Number(opts.modelContext) || 0);
  const maxPrompt = windowTokens
    ? Math.max(500, Math.floor(windowTokens * (opts.requestMaxPromptRatio ?? 0.5)))
    : Infinity;
  const hardCap = Math.max(1, Math.min(opts.requestBudgetTokens ?? 45_000, maxPrompt));
  const minBudget = Math.max(1, Math.min(opts.requestMinBudgetTokens ?? 12_000, hardCap));
  const ratio = opts.requestTargetRatio ?? 0.1;
  const ratioBudget = ratio > 0 ? Math.ceil(before * ratio) : hardCap;
  const budget = ratio > 0 ? Math.min(hardCap, Math.max(minBudget, ratioBudget)) : hardCap;
  const minTokens = Math.max(0, Math.min(opts.requestMinTokens ?? 20_000, maxPrompt));
  const protectRecent = Math.max(0, opts.requestProtectRecent ?? 6);
  const stats = { before, after: before, saved: 0, savedPct: 0, parts: 0, messages: list.length };

  if (!list.length || before < minTokens || before <= budget) return stats;

  // A rewrite that saves a few percent still invalidates the provider's prompt
  // cache and churns the agent's view, so it must pay for itself. Work on a
  // snapshot and commit only when the saving clears `requestMinSavingsPct`.
  const minSavingsPct = Math.max(0, Number(opts.requestMinSavingsPct ?? 12));
  let snapshot = null;
  if (minSavingsPct > 0) {
    try { snapshot = structuredClone(list); } catch { snapshot = null; }
  }
  const announce = { done: false };

  // Never rewrite the newest messages: that is what the agent is working from.
  // If the protected tail itself blows the budget we widen the window (oldest
  // recent messages first) but always keep the final exchange intact.
  const hardProtect = Math.min(Math.max(0, opts.requestHardProtect ?? 0), list.length);

  // Protect the current turn's working set, not just the last N messages. An
  // agentic turn can contain hundreds of tool results; protecting only 6
  // messages elides files the agent read minutes ago and is still editing.
  // Protect the newest `requestTurnProtectTokens` of the turn (capped by the
  // budget), so long turns degrade gracefully instead of losing everything.
  let turnStart = list.length;
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i];
    if (["user", "system", "developer"].includes(m?.role) || ["user", "system", "developer"].includes(m?.type)) {
      turnStart = i + 1;
      break;
    }
  }
  let turnProtectFrom = list.length;
  if (opts.requestProtectTurns !== false && turnStart < list.length) {
    turnProtectFrom = turnStart;
    const cap = Math.max(0, Number(opts.requestTurnProtectTokens ?? Math.min(40_000, hardCap)));
    let acc = 0;
    for (let i = list.length - 1; i >= turnStart; i--) {
      acc += estimateMessagesTokens([list[i]]);
      if (acc > cap) { turnProtectFrom = i + 1; break; }
    }
  }

  const eligible = (i) => {
    const m = list[i];
    if (!m || typeof m !== "object") return false;
    if (i >= turnProtectFrom) return false;
    // User/system turns (including the compaction checkpoint) are authoritative.
    if (["user", "system", "developer"].includes(m.role) || ["user", "system", "developer", "compaction"].includes(m.type)) return false;
    return true;
  };

  const compactMessage = (i, safe = false, force = false) => {
    if (!force && !eligible(i)) return 0;
    const m = list[i];
    if (typeof m.content === "string") {
      if (CONTEXT_ELIDE_RE.test(m.content) || estTokens(m.content) < (opts.requestPartMinTokens ?? 800)) return 0;
      const next = compressTextBlock(m.content, {
        headChars: opts.requestHeadChars ?? 1600,
        tailChars: opts.requestTailChars ?? 300,
      });
      if (!next || next.length >= m.content.length * 0.85) return 0;
      m.content = `${next}\n\n${CONTEXT_MARKER} message text compressed`;
      return 1;
    }
    if (!Array.isArray(m.content)) return 0;
    const mid = list[i].id ?? `i${i}`;
    let n = 0;
    for (let pi = 0; pi < list[i].content.length; pi++) {
      n += compactPart(list[i].content[pi], opts, `${mid}:${pi}`, { safe, announce, msgId: mid });
    }
    return n;
  };

  const compressRange = (end) => {
    for (let i = 0; i < end; i++) stats.parts += compactMessage(i);
  };

  // Phase 1 — structural compression of everything older than the protected tail.
  let end = Math.max(0, list.length - protectRecent);
  compressRange(end);
  let after = estimateMessagesTokens(list);

  // Phase 1b — still over budget: structurally compress the protected working
  // set (oldest first). This is the safety valve that keeps a small window
  // fittable; it never blanks reasoning or rewrites edit payloads (`safe`).
  for (let i = Math.min(turnProtectFrom, end); i < list.length && after > budget; i++) {
    end = i + 1;
    const n = compactMessage(i, true, true);
    if (n > 0) {
      stats.parts += n;
      after = estimateMessagesTokens(list);
    }
  }

  // Phase 2 — still too large: replace the oldest bulk with one-line pointers,
  // and shrink old tool arguments to their first line.
  if (after > budget) {
    outer:
    for (let i = 0; i < list.length - hardProtect; i++) {
      if (!eligible(i)) continue;
      if (typeof list[i].content === "string") {
        const text = list[i].content;
        if (CONTEXT_ELIDE_RE.test(text) && text.length < 400) continue;
        const tokens = estTokens(text);
        if (tokens < (opts.requestElideMinTokens ?? 200) && !CONTEXT_ELIDE_RE.test(text)) continue;
        list[i].content = elisionMarker("text", tokens, pageHandle(opts, text, list[i].id), announce);
        stats.parts++;
        after = estimateMessagesTokens(list);
        if (after <= budget) break outer;
        continue;
      }
      if (!Array.isArray(list[i].content)) continue;
      for (const part of list[i].content) {
        // Old tool arguments (write/edit payloads, long shell commands) can be
        // the largest remaining item once results are pointers.
        if (opts.requestElideInputs !== false) {
          const input = part?.type === "tool-call" ? part.input : part?.type === "tool" ? part.state?.input : null;
          if (input && typeof input === "object" && !Array.isArray(input)) {
            const shrunk = elideInput(input);
            if (shrunk) {
              if (part.type === "tool-call") part.input = shrunk;
              else part.state.input = shrunk;
              stats.parts++;
              after = estimateMessagesTokens(list);
              if (after <= budget) break outer;
            }
          }
        }
        for (const ref of textRefs(part)) {
          const text = ref.get();
          if (typeof text !== "string" || !text) continue;
          if (CONTEXT_ELIDE_RE.test(text) && text.length < 400) continue;
          const tokens = estTokens(text);
          if (tokens < (opts.requestElideMinTokens ?? 200) && !CONTEXT_ELIDE_RE.test(text)) continue;
          ref.set(elisionMarker(ref.kind, tokens, pageHandle(opts, text, list[i].id ?? ref.ref), announce));
          stats.parts++;
          after = estimateMessagesTokens(list);
          if (after <= budget) break outer;
        }
      }
    }
  }

  stats.after = after;
  stats.saved = Math.max(0, before - after);
  stats.savedPct = before ? Math.round((stats.saved / before) * 100) : 0;

  // Too little gain: put the original text back. A 2% rewrite is not worth a
  // cache miss or a changed view for the agent.
  if (snapshot && stats.saved > 0 && stats.savedPct < minSavingsPct && after <= maxPrompt) {
    list.length = 0;
    list.push(...snapshot);
    stats.after = before;
    stats.saved = 0;
    stats.savedPct = 0;
    stats.parts = 0;
    stats.skipped = "below-min-savings";
  }
  return stats;
}

/**
 * Pick the tool parts that are safe to compress from a live session context.
 *
 * The most recent `protectRecent` results stay verbatim — they are the ones
 * the agent is actively working from, and compressing them causes re-reads.
 * Parts that already carry the ContextPack footer are skipped (idempotent).
 *
 * `options.protectTurn` (default true) also skips everything in the current
 * user turn: a turn can contain hundreds of tool results, and compressing them
 * mid-task is what makes the agent re-read files it already has. Previous
 * turns are compressed on the first tool completion of the next turn.
 * `options.dedupe` (default true) lets an older result be compressed when a
 * newer result for the same tool + path/command exists: that is redundancy,
 * not access.
 */
export function selectCompressibleParts(messages, protectRecent = 1, tools = null, options = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const allowed = tools instanceof Set ? tools : null;
  let lastUser = -1;
  for (let i = 0; i < list.length; i++) {
    const m = list[i];
    if (["user", "system", "developer"].includes(m?.role) || ["user", "system", "developer"].includes(m?.type)) lastUser = i;
  }
  const entries = [];
  for (let mi = 0; mi < list.length; mi++) {
    const m = list[mi];
    if (!Array.isArray(m?.content)) continue;
    if (["user", "system", "developer"].includes(m.role) || ["user", "system", "developer", "compaction"].includes(m.type)) continue;
    if (options.protectTurn === true && lastUser >= 0 && mi > lastUser) continue;
    for (const p of m.content) {
      if (p?.type !== "tool") continue;
      const hasText = Array.isArray(p.state?.content) || typeof p.state?.output === "string";
      if (!hasText) continue;
      if (allowed && !allowed.has(String(p.name ?? p.tool ?? "").toLowerCase())) continue;
      entries.push({ part: p, at: entries.length });
    }
  }
  // Older duplicates of the same read/command are pure redundancy: compress
  // them first. The newest view of a file stays behind `protectRecent`.
  if (options.dedupe !== false) {
    const latest = new Map();
    for (const e of entries) {
      const sig = toolSignature(e.part);
      if (sig) latest.set(sig, e.at);
    }
    for (const e of entries) {
      const sig = toolSignature(e.part);
      if (sig) e.superseded = latest.get(sig) !== e.at;
    }
  }
  const tailCount = Math.max(0, protectRecent);
  const protectedTail = new Set(entries.slice(entries.length - tailCount).map((e) => e.at));
  // The newest view of each file/command is never rewritten: it is the one the
  // agent edits against. Superseded duplicates are compressed instead.
  for (const e of entries) if (e.superseded === false) protectedTail.add(e.at);
  const ordered = entries
    .filter((e) => !protectedTail.has(e.at))
    .map((e, i) => ({ e, i }))
    .sort((a, b) => (a.e.superseded === b.e.superseded ? a.i - b.i : a.e.superseded ? -1 : 1))
    .map((x) => x.e);
  return ordered.map((e) => e.part).filter((p) => {
    const text = Array.isArray(p.state?.content)
      ? p.state.content.map((c) => c?.text ?? "").join("")
      : p.state?.output ?? "";
    return !text.includes("[ContextPack]");
  });
}

/** Signature of a tool call: two results with the same signature are the same view. */
function toolSignature(part) {
  if (!part || typeof part !== "object") return null;
  const name = String(part.name ?? part.tool ?? "").toLowerCase();
  const input = part.state?.input ?? part.input;
  if (!input || typeof input !== "object") return null;
  const target = input.filePath ?? input.path ?? input.command ?? input.pattern ?? input.query ?? input.url ?? "";
  if (!target) return null;
  const range = input.offset != null || input.limit != null ? `:${input.offset ?? 0}-${input.limit ?? ""}` : "";
  return `${name}:${String(target).slice(0, 200)}${range}`;
}

/**
 * Route one distillation call between the session-less (`generate.text`) and
 * the session-scoped (`session.generate`) APIs.
 *
 * `preferSession` picks the first route; the other is tried on error unless
 * `allowFallback` is false. Errors are reported through `onError(route, err)`
 * so callers can log without this module knowing about logging.
 */
export async function routeDistill({ viaText, viaSession, preferSession, allowFallback = true, onError }) {
  const first = preferSession ? viaSession : viaText;
  if (!allowFallback) return first();
  const second = preferSession ? viaText : viaSession;
  try {
    return await first();
  } catch (e) {
    onError?.(preferSession ? "session" : "text", e);
    return second();
  }
}
