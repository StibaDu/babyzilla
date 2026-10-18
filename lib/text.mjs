// Pure text helpers shared by the plugin and the test suite.
//
// Everything here is side-effect free: no filesystem, no logging, no model
// calls. That keeps the behaviour testable without loading the plugin (whose
// module-level code touches ~/.opencode/contextpacks).

/** Rough token estimate used throughout BabyZilla (4 chars ≈ 1 token). */
export function estTokens(s) {
  if (!s) return 0;
  return Math.ceil(String(s).length / 4);
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
export function compressToolResult(event, opts, onCompressed) {
  const parts = Array.isArray(event?.result?.content) ? event.result.content : null;
  if (!parts) return 0;
  let rewritten = 0;
  for (const part of parts) {
    if (!part || typeof part.text !== "string") continue;
    const before = estTokens(part.text);
    if (before < opts.toolResultMinTokens) continue;
    const compressed = compressToolText(part.text, {
      headLines: opts.toolResultHeadLines,
      tailLines: opts.toolResultTailLines,
    });
    if (!compressed) continue;
    const after = estTokens(compressed);
    part.text = `${compressed}\n\n[ContextPack] ${fmt(before)} → ${fmt(after)} tokens (${Math.max(0, Math.round((1 - after / before) * 100))}% smaller). Elided spans can be read verbatim with offset/limit.`;
    rewritten++;
    onCompressed?.(event?.tool ?? "?", before, after);
  }
  return rewritten;
}

function fmt(n) {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n);
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
