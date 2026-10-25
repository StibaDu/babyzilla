// The dino's status mark: one badge that says what the last turn needs from you.
//
// A bubble is an *event* and fades on its own. A mark is a *state*: done, a
// question, or an error — and it stays on screen until the human decides
// something (answers, fixes, or gives a new task). That is why it is written to
// disk instead of living in the tail of the event log: a pet started tomorrow
// must still be holding yesterday's unanswered question.
//
// The plugin owns this file. The app only reads it, so the two can never
// disagree about whose write wins.

import fs from "node:fs";
import path from "node:path";

export const MARKS = ["done", "question", "error"];

/** The mark file inside a pet state dir. */
export function markFile(dir) {
  return path.join(dir, "mark.json");
}

/** The current mark, or null. A broken or hand-edited file means "nothing to say". */
export function readMark(dir) {
  try {
    const got = JSON.parse(fs.readFileSync(markFile(dir), "utf8"));
    return MARKS.includes(got?.mark) ? got.mark : null;
  } catch {
    return null;
  }
}

/**
 * Set the mark (null clears it). Atomic, because the app may read it at any
 * moment: a half-written badge is a lie, and a truncated file would clear a
 * question that is still waiting for an answer.
 */
export function writeMark(dir, kind) {
  try {
    const file = markFile(dir);
    fs.mkdirSync(dir, { recursive: true });
    const body = JSON.stringify({ mark: MARKS.includes(kind) ? kind : null, at: Date.now() });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

/**
 * What a finished turn leaves behind, read from the words the model ended on.
 *
 * The rule is deliberately literal: if the last thing it said is a question, it
 * stopped to ask something. Nothing is inferred from tone or vocabulary — a
 * question mark is the only reliable signal a model gives that it is waiting for
 * a human, and guessing past it would put words in its mouth.
 */
export function classifyTurn(text) {
  const t = String(text ?? "").trim();
  if (!t) return "done";
  // trailing quotes/brackets/emphasis are punctuation around the question,
  // not a different ending: `…right?"` still asks.
  return /[?][\s"'”’)\]`*_]*$/.test(t) ? "question" : "done";
}

/** The newest assistant answer, in either of the two message shapes a host sends. */
export function lastAnswer(messages) {
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if ((m?.role ?? m?.type) !== "assistant") continue;
    const parts = Array.isArray(m.content) ? m.content : Array.isArray(m.parts) ? m.parts : [];
    return parts
      .filter((p) => p?.type === "text")
      .map((p) => (typeof p.text === "string" ? p.text : ""))
      .join(" ")
      .trim();
  }
  return "";
}
