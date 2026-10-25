// One line of a model's reasoning, small enough for a bubble above a 90px pet.
//
// This is not a summary. A summary explains; a thought-bubble only has to *feel*
// like the thought. So the rules are about what a person would say out loud, not
// about coverage: drop code, paths and markdown (unreadable as speech), keep one
// sentence, remove the throat-clearing ("Let me…", "The user wants me to…"),
// strip anything the pixel font cannot draw, and clip at a word.
//
// Everything here is pure: no IO, no model call, no clock. A thought that costs a
// token is not worth having.

/** Punctuation the bubble font can actually draw. */
const DRAWABLE = /[^\x20-\x7E…]/g;

/** Openers that say nothing. Stripped repeatedly, because they stack. */
const FILLER = [
  /^(?:okay|ok|alright|sure|right|hmm+|well|ah|oh)\b[,.:!]?\s*/i,
  /^(?:so|now|then|next|also|but)\b[,.:!]?\s*/i,
  /^(?:first|firstly|second|third|finally)\b[,.:!]?\s*/i,
  /^let(?:'s| us)\s+/i,
  /^let me\s+/i,
  /^i\s*(?:'ll|will|should|need to|have to|want to|am going to|can|just)\s+/i,
  /^we\s*(?:'ll|will|should|need to|have to|want to|are going to|can)\s+/i,
  /^the user\s+(?:wants|asked|asks|said|says|is asking)(?:\s+me)?\s+to\s+/i,
  /^the goal is to\s+/i,
  /^i think\s+(?:i\s+)?/i,
];

function stripNoise(raw) {
  return String(raw)
    .replace(/```[\s\S]*?```/g, " ")          // fenced code
    .replace(/`[^`\n]*`/g, " ")                // inline code
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1") // links keep their label
    .replace(/https?:\/\/\S+/g, " ")            // bare urls
    .replace(/^\s{0,3}(?:#{1,6}|[-*+]|\d+[.)]|>)\s+/gm, " ") // markdown markers
    .replace(DRAWABLE, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stripFiller(sentence) {
  let out = sentence.trim();
  for (let pass = 0; pass < 4; pass++) {
    let changed = false;
    for (const re of FILLER) {
      const next = out.replace(re, "");
      if (next !== out) { out = next; changed = true; }
    }
    if (!changed) break;
  }
  return out.trim();
}

function finish(sentence) {
  const cleaned = sentence
    .replace(/^["'“”‘’\s]+/, "")
    .replace(/["'“”‘’]+$/, "")
    .replace(/[\s,;:.!?—–-]+$/, "")
    .trim();
  if (!cleaned) return "";
  return cleaned[0].toUpperCase() + cleaned.slice(1);
}

// The dino has a small head. Caveman register keeps the line readable by dropping
// only what carries no meaning: articles, copulas, auxiliaries and pronouns do the
// grammatical work but not the thinking, so "Parser slow, so me read it before the
// pack" says the same thing as the sentence it came from, in nine words.
const STOP = new Set([
  "the", "a", "an", "just", "really", "actually", "basically", "simply", "quite",
  "very", "please", "that", "which", "is", "are", "was", "were", "am", "be",
  "been", "being", "will", "would", "should", "shall", "do", "does", "did",
  "have", "has", "had", "to", "it", "its", "there", "then", "them", "they",
  "their",
]);

const PRONOUN = {
  i: "me", my: "me", mine: "me", me: "me",
  we: "us", our: "us", ours: "us", us: "us",
};

/** Words the bubble font can draw in caps without looking like a typo. */
const ACRONYM = new Set([
  "js", "ts", "css", "html", "json", "yaml", "sql", "api", "apis", "cli", "pr",
  "ci", "url", "urls", "http", "https", "ai", "llm", "mcp", "sdk", "npm", "csv",
  "pdf", "png", "ui", "ux", "id", "io", "os",
]);

// Baring a verb by chopping -ing/-ed invents words ("retir", "stor", "shar").
// Generate the real inflections of the verbs this work actually uses, and leave
// anything unknown as written: a caveman can be ungrammatical, not unclear.
const VERB_BASE = [
  "add", "animate", "build", "cache", "call", "change", "check", "clip", "close",
  "copy", "create", "delete", "draw", "emit", "fail", "find", "fix", "get",
  "give", "go", "keep", "load", "log", "look", "make", "merge", "move", "open",
  "parse", "pass", "paste", "poll", "print", "put", "read", "remove", "render",
  "retire", "run", "save", "send", "set", "share", "show", "skip", "start",
  "step", "stop", "store", "take", "tell", "test", "think", "tick", "trim",
  "try", "update", "use", "wait", "wrap", "write", "work",
];

const VERB_FORMS = new Map();
for (const base of VERB_BASE) {
  const doubling = /[aeiou][^aeiouwxy]$/.test(base) && /[^aeiou]$/.test(base);
  VERB_FORMS.set(base, base);
  VERB_FORMS.set(base + "ing", base);
  VERB_FORMS.set(base.endsWith("e") ? `${base.slice(0, -1)}ing` : base, base);
  if (doubling) VERB_FORMS.set(`${base}${base.slice(-1)}ing`, base);
  VERB_FORMS.set(`${base}ed`, base);
  VERB_FORMS.set(`${base}d`, base);
  if (base.endsWith("y")) VERB_FORMS.set(`${base.slice(0, -1)}ied`, base);
  if (doubling) VERB_FORMS.set(`${base}${base.slice(-1)}ed`, base);
}

/**
 * One sentence in caveman: "I should read the parser before the pack" ->
 * "Me read parser before pack". Never returns "" — if every word was grammar,
 * the caller gets its sentence back rather than a silent pet.
 */
export function caveman(sentence) {
  const source = String(sentence ?? "").trim();
  if (!source) return "";
  const expanded = source
    .replace(/'ll\b/gi, " ")
    .replace(/'re\b/gi, " ")
    .replace(/'ve\b/gi, " ")
    .replace(/'m\b/gi, " am ")
    .replace(/n't\b/gi, " not ");

  const words = [];
  for (const chunk of expanded.split(/\s+/)) {
    const core = chunk.replace(/^[("'“‘]+/, "").replace(/[)"'“”.,;:!?]+$/, "");
    if (!core) continue;
    const lower = core.toLowerCase();
    if (STOP.has(lower)) continue;
    const base = PRONOUN[lower] ?? VERB_FORMS.get(lower) ?? lower;
    const shown = ACRONYM.has(base) ? base.toUpperCase() : base;
    // a comma is the only punctuation worth keeping: it is how a caveman pauses
    words.push(/,$/.test(chunk) && words.length ? `${shown},` : shown);
  }
  if (!words.length) return source;
  return words.join(" ").replace(/\s+,/g, ",");
}

/** The spoken form: caveman words, sentence-cased for a bubble. */
export function cavemanLine(sentence) {
  return finish(caveman(sentence));
}

export function clip(text, max = 56) {
  if (text.length <= max) return text;
  let cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  // Only break at a space if it keeps most of the budget; otherwise a hard cut
  // beats a two-word thought.
  if (space > max * 0.5) cut = cut.slice(0, space);
  cut = cut.replace(/[\s,;:.!?—–-]+$/, "");
  return `${cut}…`;
}

/**
 * The reasoning text -> one line, or null when there is nothing worth showing.
 * `max` is the bubble budget in characters (~14 per line at scale 3, four lines).
 */
export function gist(raw, { max = 56 } = {}) {
  if (raw === null || raw === undefined) return null;
  const text = stripNoise(raw);
  if (!text) return null;

  const sentences = text.split(/(?<=[.!?])\s+/).filter(Boolean);
  // Prefer the first sentence with enough substance to stand alone; a one-word
  // opener ("Sure.") reads as noise in a bubble.
  const chosen = sentences.find((s) => s.split(" ").length >= 4) ?? sentences[0] ?? "";
  const line = finish(stripFiller(chosen));
  if (!line) return null;
  // The pet is a dinosaur: it thinks in caveman, out loud, about the work.
  return clip(cavemanLine(line), max);
}

/**
 * The newest reasoning in a conversation, from the last assistant message only.
 * Older thoughts are the ones the model already acted on — replaying them would
 * make the pet mutter the same line all turn.
 */
export function latestThought(messages) {
  if (!Array.isArray(messages)) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if ((m?.role ?? m?.type) !== "assistant") continue;
    const parts = Array.isArray(m.content) ? m.content : Array.isArray(m.parts) ? m.parts : [];
    const text = parts
      .filter((p) => p?.type === "reasoning")
      .map((p) => (typeof p.text === "string" ? p.text : typeof p.reasoning === "string" ? p.reasoning : ""))
      .join(" ")
      .trim();
    if (text) return text;
    return null; // the last assistant turn had no reasoning; do not reach further back
  }
  return null;
}
