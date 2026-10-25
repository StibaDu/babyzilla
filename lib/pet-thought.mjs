// One line of a model's reasoning, small enough for a bubble above a 90px pet.
//
// This is not a summary. A summary explains; a thought-bubble only has to *feel*
// like the thought. So the rules are about what a person would say out loud, not
// about coverage: drop code, paths and markdown (unreadable as speech), keep one
// sentence, remove the throat-clearing ("Let me…", "The user wants me to…"),
import { VOICES } from "./pet-voice.mjs";

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
  "been", "being", "will", "would", "should", "shall",
  "have", "has", "had", "to", "it", "its", "there", "then",
]);

const PRONOUN = {
  i: "me", my: "me", mine: "me", me: "me",
  we: "us", our: "us", ours: "us", us: "us",
  // in this persona the third person *is* the human
  they: "human", them: "human", their: "human", theirs: "human",
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
  // what a caveman says about its human
  "ask", "want", "need", "keep", "say", "expect", "insist", "complain",
  "repeat", "stop", "believe", "understand", "forget", "explain",
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
  // third person: "wants", "asks", "says", "fixes", "tries"
  VERB_FORMS.set(`${base}s`, base);
  VERB_FORMS.set(base.endsWith("y") ? `${base.slice(0, -1)}ies` : `${base}s`, base);
  if (/(?:s|ch|sh|x|z)$/.test(base)) VERB_FORMS.set(`${base}es`, base);
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
  let line = words.join(" ").replace(/\s+,/g, ",");
  // a caveman does not trail off into grammar ("…, so me")
  line = line.replace(/[,\s]+\b(?:so|and|but|or|because|then|to|of|for|me|it)$/i, "").trim();
  return line || source;
}

/** The spoken form: caveman words, sentence-cased for a bubble. */
export function cavemanLine(sentence) {
  // "the user" is how a model talks about its human; a caveman just says human
  return finish(caveman(String(sentence ?? "").replace(/\busers?\b/gi, "human")));
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
 * `max` is the bubble budget in characters (~19 per line at scale 3, five lines).
 */
/** Bookkeeping, not thinking: who asked for what. Kept out of every style. */
const META = [
  /^the user\s+(?:wants|asked|asks|said|says|is asking)(?:\s+me)?\s+to\s+/i,
  /^the goal is to\s+/i,
];

function stripMeta(sentence) {
  let out = sentence.trim();
  for (let pass = 0; pass < 3; pass++) {
    let changed = false;
    for (const re of META) {
      const next = out.replace(re, "");
      if (next !== out) { out = next; changed = true; }
    }
    if (!changed) break;
  }
  return out.trim();
}

// What makes a reasoning sentence worth quoting: a question, an aside, a bit of
// surprise. The model's voice is the point — that is the funny part.
const INTEREST = [
  [/[?!]/, 3],
  [/\b(?:hmm+|wait|oh|ah|ugh|oops|huh|wow|ha|haha|honestly|actually|interesting|weird|funny|nice|great|strange|suspicious|annoying|surprising)\b/i, 3],
  [/\b(?:i|me|my|myself)\b/i, 2],
  [/\b(?:because|so|but|unless|except)\b/i, 1],
];

/** Words that make a sentence *about the human* rather than about the code. */
const HUMAN = /\b(?:user|users|human|humans|they|them|their|you|person)\b/i;
const DEMAND = /\b(?:want|wants|asked|asks|ask|said|says|keep|keeps|again|instead|expect|expects|insist|insists|complain|complains|repeated|should|need|needs|stop|stops)\b/i;

function interest(sentence) {
  let score = 0;
  for (const [re, weight] of INTEREST) if (re.test(sentence)) score += weight;
  // A line that fits reads better than one that gets chopped; favour the middle.
  const words = sentence.split(/\s+/).length;
  if (words >= 5 && words <= 22) score += 1;
  // The point of this persona: what the pet makes of its human, not of the bug.
  if (HUMAN.test(sentence)) score += 4;
  if (DEMAND.test(sentence)) score += 3;
  return score;
}

/**
 * Reasoning -> what the bubble says.
 *
 * `style`:
 *  - "verbatim" (default): quote the reasoning as written. The model's own voice
 *    is the fun — asides, questions, the odd "hmm" — so nothing is paraphrased,
 *    only code/markdown/emoji removed and the sentence picked for interest.
 *  - "caveman": drop the grammar and keep the meaning ("Tests fail because cache
 *    stale"). Opt-in, because it eats exactly the voice this feature is for.
 */
// ── mood ────────────────────────────────────────────────────────────────────
// The dino is allowed an opinion, not a fantasy: every mood below is read off
// words the model actually wrote, and the thought itself is never rewritten to
// fit it. A mood that has no evidence is not put on — but the dino still has a
// voice, so a sentence with no evidence gets a neutral aside rather than silence.

/** Evidence buckets, in precedence order: the first that matches wins. */
const MOOD_RULES = [
  ["angry", /\b(?:broken|breaks?|break|wrong|fails?|failed|failure|why|ugh|annoying|stupid|hate|worse|worst|regression|mess|damn|refus\w*|impossible|sigh)\b/i],
  ["confused", /\b(?:hmm+|wait|unclear|unsure|maybe|weird|strange|confusing|confused|no idea|doubt|suspect)\b/i],
  ["bored", /\b(?:again|twice|same|still|repeat\w*|once more|keeps?|kept)\b/i],
  ["smug", /\b(?:works?|worked|pass(?:es|ing)?|fix(?:ed|es)?|done|green|shipped|clean|nice|easy|finally)\b/i],
];

/**
 * The dino's own table, kept as an export for tests and docs. Every other voice
 * lives in `lib/pet-voice.mjs`; a pack picks one by name.
 */
export const voice = VOICES.caveman.moods;

/** Rare on purpose: an exclamation that lands every time is not an exclamation. */
const RAWR_CHANCE = 0.06;
/** One thought in nine adds nothing: an aside every single time is a tic, not a voice. */
const PLAIN_CHANCE = 1 / 9;

export function readMood(sentence) {
  for (const [mood, re] of MOOD_RULES) if (re.test(sentence)) return mood;
  // Nothing loaded, but the human is being demanding: that is worth a raised brow.
  if (HUMAN.test(sentence) && ASKING.test(sentence)) return "tease";
  return null;
}

/** Words that mean the human asked for something, as opposed to merely being discussed. */
const ASKING = /\b(?:asks?|asked|want|wants|said|says|told|keeps?|repeat\w*|again|twice|instead|more)\b/i;

function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/**
 * Pick the aside and where it goes. Placement is its own axis: a line that always
 * trails is a signature, not a personality. Only the short grunts may lead — a
 * long aside up front would bury the thought it is commenting on.
 */
/** A thought that already opens with a grunt must not get a second one in front. */
const GRUNT_OPEN = /^(?:hmm|hm+|huh|wait|ugh|oh|ah|so|well|tsk|sigh|again|eh|ha+|yes|no|now|okay|alright)\b/i;

function asideFor(moods, mood, seed, body) {
  const say = moods[mood] ?? moods.flat;
  const lead = (seed >>> 3) % 3 === 0 && !GRUNT_OPEN.test(body);
  const pool = lead && say.open.length ? say.open : say.close;
  const index = (seed >>> 7) % pool.length;
  return { text: pool[index], where: pool === say.open ? "before" : "after" };
}

/** Attach the aside without letting it be the thing that gets clipped away. */
function decorate(body, aside, max) {
  if (aside.where === "before") {
    const room = max - aside.text.length - 1;
    // No room at the front: trail it instead of shrinking the thought to nothing.
    if (room >= 12) {
      const head = body.length <= room ? body : clip(body, room);
      return `${aside.text} ${head}`;
    }
  }
  const sep = /[.!?…]$/.test(body) ? " " : ". ";
  const room = max - aside.text.length - sep.length;
  if (room < 12) return body;
  return `${body.length <= room ? body : clip(body, room)}${sep}${aside.text}`;
}

/**
 * The full reduction: the thought plus the mood it was read with.
 * `gist()` is the string-only view, kept for callers that only want the line.
 */
export function thought(raw, { max = 95, style = "voice", voice = "caveman", mood = true, random = null } = {}) {
  const line = gist(raw, { max, style, voice, mood: false });
  if (!line) return null;

  const chosenRaw = chosenSentence(raw, { style });
  const said = { text: line, mood: null, rawr: false, aside: null };
  // The voice belongs to the persona, not to the quote: verbatim stays verbatim.
  if (!mood || style === "verbatim" || !chosenRaw) return said;

  const pools = VOICES[voice] ?? VOICES.plain;
  said.mood = readMood(chosenRaw);
  const seed = hash(chosenRaw);
  // Same thought, same answer by default, so a test can never flake; a caller
  // that passes `random` gets genuine chance instead. Only the caveman roars —
  // Rawr belongs to the creature, not to the format.
  said.rawr = pools.rawr === true && (random ? random() < RAWR_CHANCE : seed % 23 === 0);
  const plain = !said.rawr && (random ? random() < PLAIN_CHANCE : (seed >>> 11) % 9 === 0);
  if (plain) return said;

  const aside = said.rawr
    ? { text: "Rawr!", where: (seed >>> 5) % 3 === 0 ? "before" : "after" }
    : asideFor(pools.moods, said.mood, seed, line);
  said.aside = aside.text;
  said.text = decorate(line, aside, max);
  return said;
}

/** The one sentence worth saying, picked the same way for text and for mood. */
function chosenSentence(raw, { style = "caveman" } = {}) {
  const text = stripNoise(raw);
  if (!text) return null;
  // In caveman the "user wants…" lines *are* the thought: that is the pet sizing
  // up its human. Only the verbatim style strips them as bookkeeping.
  const sentences = text.split(/(?<=[.!?])\s+/)
    // Only the quote strips bookkeeping: every voice treats "the user wants…" as
    // the pet sizing up its human, which is the point of the persona.
    .map((sentence) => (style === "verbatim" ? stripMeta(sentence) : sentence.trim()))
    .filter(Boolean);
  if (!sentences.length) return null;
  // Quote the most alive sentence rather than the first one: reasoning opens with
  // throat-clearing and gets interesting two sentences later.
  let best = -1;
  let top = [];
  for (const sentence of sentences) {
    const score = interest(sentence);
    if (score > best) { best = score; top = []; }
    if (score === best) top.push(sentence);
  }
  // Equally alive sentences: rotate between them by the block as a whole instead of
  // always taking the first, so two similar steps do not say the same thing twice.
  let chosen = top[hash(text) % top.length] ?? sentences[0];
  if (chosen.split(/\s+/).length < 3) {
    chosen = sentences.find((s) => s.split(/\s+/).length >= 4) ?? "";
  }
  return chosen || null;
}

export function gist(raw, { max = 95, style = "voice", voice = "caveman", mood = false } = {}) {
  if (raw === null || raw === undefined) return null;
  const text = stripNoise(raw);
  if (!text) return null;

  const chosen = chosenSentence(raw, { style });
  // "Sure." is not a thought; a bubble with one word reads as a glitch.
  if (!chosen) return null;

  // "caveman" is the old name for "use the voice"; both mean the same thing now.
  if (style === "verbatim") {
    const line = finish(chosen);
    return line ? clip(line, max) : null;
  }
  const pools = VOICES[voice] ?? VOICES.plain;
  const line = pools.transform === "caveman" ? cavemanLine(finish(chosen)) : finish(chosen);
  return line ? clip(line, max) : null;
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
