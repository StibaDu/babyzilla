// Assembling the final module list from the distiller's parsed output.
//
// Pure: no filesystem, no model calls — so the guarantees the compaction
// hook relies on (index.js) here are unit-testable where they live, not
// just where they happen to succeed. That seam is exactly where v0.7.3
// shipped two regressions that 134 green tests missed: a best-of-N winner
// allowed to be the anchorless pack, and a recovery pass run against the
// winner instead of the final pack.

import { anchorModule, ANCHOR_KIND } from "./anchor.mjs";
import { selectPack, renderModules, missingFactsModule } from "./eval.mjs";

export function assemblePack({ parsed, sourceMessages, transcript, rawTokens = 0, opts = {} } = {}) {
  // de-dupe: last state wins; unique kind/name pairs
  const seen = new Set();
  const uniq = [];
  for (const m of parsed ?? []) {
    if (m.kind === "state") m.name = "00-state";
    const key = `${m.kind}/${m.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    uniq.push(m);
  }

  // The question being answered must survive the swap. This module is
  // built from the messages, not by the model, so it cannot go missing.
  const anchor = opts.distillAnchors === false ? null : anchorModule(sourceMessages);
  const body = uniq.filter((m) => m.kind !== ANCHOR_KIND);
  const anchored = anchor ? [anchor, ...body] : body;

  // Rank candidate packs only when the transcript is small enough that
  // scoring is cheap; on a huge transcript the anchor is still added, it
  // just is not compared against a losing alternative.
  let chosen = anchored;
  let picked = null;
  let missing = null;
  let forced = false;
  if ((transcript ?? "").length <= (opts.evalMaxChars ?? 400_000)) {
    picked = selectPack(
      [{ name: "model", modules: body }, { name: "anchored", modules: anchored }],
      { transcript, rawTokens },
    );
    chosen = picked.winner?.modules ?? anchored;
    // The anchor is a guarantee, not a candidate. The model pack can only
    // ever match or trail the anchored pack's quality (the anchored text
    // contains all of it); it wins on the size-only budget term, or ties.
    // Fuzzy token-overlap askOk is not a substitute for verbatim, so the
    // winner is re-attached to the anchor either way.
    if (anchor && !chosen.some((m) => m.kind === ANCHOR_KIND)) {
      chosen = [anchor, ...chosen];
      forced = true;
    }
    // A fact the session already proved (a hash, a version string) is the
    // one thing a summary must not soften into prose. Computed against the
    // final pack, so recovery does not re-list lines the anchor verbatim
    // holds already.
    missing = opts.distillRecovered === false ? null : missingFactsModule(renderModules(chosen), transcript);
    if (missing) chosen = [...chosen, missing];
  }

  return { chosen, picked, missing, forced, uniq };
}
