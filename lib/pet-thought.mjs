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
  return clip(line, max);
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
