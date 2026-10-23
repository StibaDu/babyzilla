// The last exchange, kept verbatim.
//
// A pack replaces the transcript, so the one thing it must never lose is the
// newest thing that was said: the user's request and the reply that led to it
// (usually the question the user is now answering). A distiller can drop that
// — it is one paragraph among thousands — so it is rebuilt deterministically
// here and attached to every pack instead of being asked for.
//
// Pure: no filesystem, no model calls. `bases` is passed in when a caller
// wants the resolvable-pointer section; without it no pointers are claimed.

import { estTokens } from "./text.mjs";

export const ANCHOR_KIND = "anchor";
export const ANCHOR_NAME = "anchors";
/**
 * Shared budget (chars) for the load-bearing exchange parts. The reply takes
 * the mathematically-larger share on purpose: its tail is the question the
 * next turn answers. Splitting the budget HERE is what keeps that tail —
 * applying a cap after composition (as the summary renderer did to v0.7.3)
 * head-truncates it away instead.
 */
export const ANCHOR_MAX_CHARS = 1800;
/** The kept request before the current one: continuity, not primary. */
const ANCHOR_PREV_MAX_CHARS = 600;
/**
 * Upper bound on what anchorModule() can produce. The summary renderer
 * derives its render cap from this so the two sides keep tracking each
 * other when the budgets change; the slack covers module framing (###
 * headers, separators), the tool list, the pointer section and the trim
 * markers trimExchange adds per part.
 */
export const ANCHOR_MAX_CONTENT_CHARS = ANCHOR_MAX_CHARS + ANCHOR_PREV_MAX_CHARS + 1024;

/** Text-only extraction: tool payloads and reasoning are not conversation. */
export function messageText(m) {
  const out = [];
  const push = (s) => { if (typeof s === "string" && s.trim()) out.push(s); };
  if (typeof m?.content === "string") push(m.content);
  if (typeof m?.text === "string") push(m.text);
  if (Array.isArray(m?.content)) {
    for (const c of m.content) {
      if (c?.type === "text") push(c.text);
      else if (typeof c?.text === "string" && !c.type) push(c.text);
    }
  }
  if (Array.isArray(m?.parts)) {
    for (const p of m.parts) {
      if (typeof p === "string") push(p);
      else if (p?.type === "text") push(p.text);
    }
  }
  return out.join("\n\n").trim();
}

const roleOf = (m) => m?.role ?? m?.type ?? "";

/** Tool names in the newest assistant turn: what was run, not what it returned. */
export function replyTools(messages, limit = 8) {
  const list = Array.isArray(messages) ? messages : [];
  let at = -1;
  for (let i = list.length - 1; i >= 0; i--) {
    if (roleOf(list[i]) === "assistant") { at = i; break; }
  }
  if (at < 0) return [];
  const parts = Array.isArray(list[at]?.parts) ? list[at].parts
    : Array.isArray(list[at]?.content) ? list[at].content : [];
  const names = [];
  for (const p of parts) {
    if (!p || typeof p !== "object") continue;
    const name = p.type === "tool" ? p.name ?? p.toolName ?? p.tool : p.type === "tool-call" ? p.name ?? p.toolName : "";
    if (name && !names.includes(name)) names.push(name);
    if (names.length >= limit) break;
  }
  return names;
}

/** The newest user turn and the newest assistant turn before/after it. */
export function lastExchange(messages) {
  const list = Array.isArray(messages) ? messages : [];
  let ask = "";
  let askAt = -1;
  const asks = [];
  for (let i = list.length - 1; i >= 0 && asks.length < 2; i--) {
    if (roleOf(list[i]) !== "user") continue;
    const t = messageText(list[i]);
    if (!t) continue;
    if (askAt < 0) { ask = t; askAt = i; }
    asks.unshift(t);
  }
  let reply = "";
  for (let i = askAt >= 0 ? askAt - 1 : list.length - 1; i >= 0; i--) {
    if (roleOf(list[i]) !== "assistant") continue;
    const t = messageText(list[i]);
    if (t) { reply = t; break; }
  }
  return { ask, asks, reply, askAt };
}

/**
 * Keep the head and the tail: a long request opens with its intent, a long
 * reply ends with the question or the verdict. The middle is the part that
 * survives summarisation elsewhere.
 */
export function trimExchange(text, maxChars) {
  const s = String(text || "").trim();
  if (s.length <= maxChars) return s;
  const head = Math.max(1, Math.ceil(maxChars * 0.45));
  const tail = Math.max(1, maxChars - head);
  return `${s.slice(0, head).trimEnd()}\n\n[... ${s.length - head - tail} chars trimmed ...]\n\n${s.slice(-tail).trimStart()}`;
}

const POINTER_RE = /(?:^|[\s`"'(])((?:~\/|\.{1,2}\/|\/)?[\w.@-]+(?:\/[\w.@-]+)*\.[a-z0-9]{1,8})(?::(\d+))?/g;

/** path:line references in `text` that actually exist, newest first, deduped. */
export function resolvablePointers(text, { bases = [], limit = 6, exists = null } = {}) {
  if (!exists || !bases.length) return [];
  const seen = new Set();
  const out = [];
  for (const m of String(text || "").matchAll(POINTER_RE)) {
    const rel = m[1];
    const line = m[2] ? Number(m[2]) : null;
    if (!rel.includes("/") && (!line || !/\.[a-z0-9]{1,8}$/.test(rel))) continue;
    const key = line ? `${rel}:${line}` : rel;
    if (seen.has(key)) continue;
    seen.add(key);
    for (const base of bases) {
      try {
        if (exists(base, rel)) { out.push(key); break; }
      } catch { /* unreadable base: try the next one */ }
    }
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Build the anchor module for a transcript.
 * Returns null when there is nothing to anchor (empty transcript).
 */
export function anchorModule(messages, { maxChars = ANCHOR_MAX_CHARS, bases = [], exists = null } = {}) {
  const replyMax = Math.ceil(maxChars * 0.55);
  const askMax = maxChars - replyMax;
  const prevMax = Math.min(600, askMax);
  const { asks, reply } = lastExchange(messages);
  if (!asks.length && !reply) return null;
  const ask = asks.length ? asks[asks.length - 1] : "";
  const parts = [];
  if (asks.length > 1) {
    parts.push(`### The request before it (verbatim)\n${trimExchange(asks[asks.length - 2], prevMax)}`);
  }
  if (ask) parts.push(`### The request this pack continues (verbatim)\n${trimExchange(ask, askMax)}`);
  if (reply) parts.push(`### The reply it answers (verbatim)\n${trimExchange(reply, replyMax)}`);
  const tools = replyTools(messages);
  if (tools.length) parts.push(`### Tools in that reply\n${tools.map((t) => `- ${t}`).join("\n")}`);
  const pointers = resolvablePointers(`${ask}\n${reply}`, { bases, exists, limit: 6 });
  if (pointers.length) parts.push(`### Files in play\n${pointers.map((p) => `- ${p}`).join("\n")}`);
  const content = parts.join("\n\n").trim();
  if (!content) return null;
  const triggers = [...new Set(`${ask} ${reply}`.toLowerCase().match(/[a-z][a-z0-9_-]{3,}/g) ?? [])].slice(0, 6);
  return { kind: ANCHOR_KIND, name: ANCHOR_NAME, triggers, content, tokens: estTokens(content) };
}
