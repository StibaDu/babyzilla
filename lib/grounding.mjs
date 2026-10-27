// Grounding: one constant system instruction, added to every model request.
//
// Why a system part and not a prompt-hook edit: prompt-admission edits become the
// canonical *persisted* user turn (OpenCode's plugin docs say so explicitly), so a
// directive placed there would live in the transcript forever. `event.system` is
// assembled per request, so this stays out of history — and being byte-identical
// every time, it stays in the provider's cached prefix instead of busting it.
//
// The instruction is a floor, not a guarantee. It makes hedging the default and
// verification the cheap path; it cannot force a model to be truthful. That is
// stated in the docs rather than papered over here.

/** Marks our part, so the same instruction can never be added twice. */
export const GROUNDING_MARK = "[babyzilla:grounding]";

/**
 * Kept short: it is paid for on every request. It names the failure modes that
 * matter — a guess dressed as a fact, an estimate dressed as a measurement, a
 * wrong premise agreed with, and asking the human to verify what the model could
 * have checked itself.
 */
export const GROUNDING_TEXT = `${GROUNDING_MARK} Answer truthfully.
- When you are confident, answer directly; do not hedge what you know.
- When you are not certain of a factual claim, say so ("I'm not sure") or verify it before asserting it: search, read the file, run the command. Do not ask the user to check what you can check yourself.
- Never present a guess as a fact. Label an estimate as an estimate.
- If the user's premise looks wrong, say so instead of going along with it.`;

/**
 * Append the instruction to a request's system parts.
 *
 * Returns true only when it added something, so the caller can log the first
 * request and stay quiet afterwards. A host that hands over no `system` array
 * gets no instruction rather than a crash — the request must still run.
 */
export function groundSystem(system) {
  if (!Array.isArray(system)) return false;
  for (const part of system) {
    if (typeof part?.text === "string" && part.text.includes(GROUNDING_MARK)) return false;
  }
  system.push({ type: "text", text: GROUNDING_TEXT });
  return true;
}
