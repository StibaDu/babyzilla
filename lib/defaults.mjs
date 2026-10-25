// Plugin defaults, in one place: the plugin merges them over user options,
// and the deterministic verification bench replays knobs against the same
// values (a bench that measured different defaults would prove nothing).

export const defaults = {
  // null -> use the session's own model for distillation.
  distillModel: null,
  // how to route the distillation call:
  //   "auto"    -> try the session-less call first (the unchanged legacy path)
  //                and only fall back to the session-scoped call when it is
  //                rejected. Every working provider stays byte-identical while
  //                gated ones (OpenCode's free tier) now succeed via fallback.
  //   "session" -> try the session-scoped call first (uses the session's own
  //                model), falling back to the session-less call.
  //   "text"    -> session-less only, no fallback (strict legacy behaviour).
  distillVia: "auto",
  // max cold modules attached to one prompt + their combined token budget.
  maxAttach: 2,
  attachBudgetTokens: 6000,
  // promote tool-* modules of a project into the cross-session library.
  library: true,
  // opt-in: on the first prompt of a new session, carry modules over from the
  // project's own distillation history instead of starting cold. Applies
  // carryKindAllowlist to what may cross a session boundary and shares the
  // attach budget with cold modules, never exceeding it. Turn OFF to keep the
  // old behavior where only keyword matches from the library could attach.
  carryIn: false,
  // vision auto-routing: when a prompt attaches images, names image paths, or
  // contains picture wording, verify the paths and send one routing note that
  // makes the main model delegate the visual work to `visionAgent`. Skipped
  // automatically when the session model's catalog entry confirms image
  // input — the user's selected model decides. Safe as a default: sessions
  // without that agent profile only get a debug-log line, never a note.
  visionRoute: true,
  // agent profile that receives routed image tasks. Create it as
  // ~/.config/opencode/agents/vision.md with a vision-capable model.
  visionAgent: "vision",
  // below this many estimated transcript tokens, native compaction is fine.
  minRawTokens: 4000,
  // cap on the transcript fed to the distiller when the window is unknown or
  // larger than this (small-window models still clamp to 40% of their window).
  // Was derived at 48K; at uncached input price one compaction of a
  // dump-heavy session was billing ~48K tokens on its own.
  distillBudgetDefault: 16_000,
  // layer 2: rewrite shell commands through the `lowfat` binary before
  // execution, so tool output enters the context pre-compressed.
  toolCompression: true,
  // layer 2b: compress large tool results (read/grep/glob) at the source,
  // before they are persisted and resent on every later turn. This is the
  // per-request gap Headroom had in the head-to-head.
  toolResultCompression: true,
  // A read of a 60-line file costs ~1K tokens; compressing that saves nothing
  // and costs a re-read. Only bulk results are worth rewriting.
  toolResultMinTokens: 4000,
  // eager gate for tools OUTSIDE the allowlist: any tool result estimated at
  // this many tokens or more is paged out, whichever tool produced it. The
  // audit of 48 real sessions showed 20.7% of journaled tool tokens come from
  // shell/execute and MCP dumps — classes the name-allowlist never covered.
  // null disables; 8000 catches the ugly tail (p90 reads are 61K) without
  // paging routine output (median shell result ≈ 590 tokens).
  toolResultEagerTokens: 8000,
  toolResultHeadLines: 40,
  toolResultTailLines: 20,
  // keep this many of the most recent tool results verbatim — the agent is
  // working from them, so compressing them causes re-reads.
  toolResultProtectRecent: 3,
  // never compress results from the current user turn (they become eligible on
  // the next turn); keeps the agent's working set intact mid-task.
  toolResultProtectTurn: true,
  // Layer 1b: hard per-request budget. Unlike Layer 1 (which waits for
  // OpenCode's compaction), this runs on every outgoing request, so models
  // with huge windows (Kimi K3: 1M tokens) are covered too. Once the message
  // list exceeds `requestBudgetTokens`, older tool output, assistant prose,
  // reasoning and attachments are compressed in place; if that is not enough,
  // the oldest parts are reduced to one-line pointers. Recent messages and all
  // user turns stay verbatim.
  requestCompression: true,
  // max estimated tokens for the message list of one request (not counting
  // the system prompt or tool definitions).
  requestBudgetTokens: 45_000,
  // Largest transcript worth scanning for the facts a pack left out. Above
  // this the scan is skipped: a multi-MB history costs more to score than the
  // recovered module saves.
  evalMaxChars: 400_000,
  // Keep the last request and the reply it answers verbatim in every pack, and
  // append what the distiller dropped. Both are cheap; both are on by default.
  distillAnchors: true,
  distillRecovered: true,
  // aim for this fraction of the incoming context (0 = disabled). With 0.08 a
  // 160K request is cut to ~13K (>90% smaller); the hard cap above still
  // applies to 1M-token windows, and the floor below prevents over-compression.
  requestTargetRatio: 0.08,
  // never shrink a request below this, even when the ratio says so.
  // 12K floor matches lib/text.mjs's own fallback and the documented value
  // (the code shipped 10K while README/OPTIONS promised 12K; the floor is a
  // safety minimum, so docs and code now agree on the conservative side).
  requestMinBudgetTokens: 12_000,
  // below this, leave the request alone even if the budget is smaller.
  requestMinTokens: 20_000,
  // Prefix-stable mode: compress each tool result once, when it arrives, and
  // decide from its own bytes only. Already-sent history is never rewritten, so
  // the provider's prompt-cache prefix survives — the only mode that actually
  // reduces billed input on a cache-discounting provider like Ollama.
  stablePrefix: true,
  // In stable mode the request hook is a valve only: it runs when the prompt
  // reaches this share of the model window (cache cost beats a hard failure).
  stableOverflowRatio: 0.9,
  // Size gate for stable compression. Results below this stay verbatim: those
  // are the ones an agent acts on immediately, and paging them out buys a
  // recall round-trip. Was 4000 (inherited from toolResultMinTokens);
  // medium results in the 2-4K range are exactly the steady-state tail that
  // keeps re-billing uncached.
  stableMinTokens: 2000,
  // never let one request exceed this fraction of the model's context window
  // (system prompt and tool schemas are not counted, so leave headroom).
  requestMaxPromptRatio: 0.5,
  // transcript tokens fed to the distiller; 0 = derive from the model window
  // clamped by `distillBudgetDefault` (16K). Set explicitly for a pinned small
  // distiller. `distillModel` can point at your cheapest competent model;
  // pinning it is deliberate — generation is retried with the session model
  // only when the pinned call fails outright.
  distillBudgetTokens: 0,
  // newest N messages are always sent verbatim.
  requestProtectRecent: 6,
  // protect the newest N tokens of the current user turn as well. A turn can
  // contain hundreds of tool results; a message count of 6 covers only a few.
  // Capped by the request budget, so small windows still compress.
  requestProtectTurns: true,
  requestTurnProtectTokens: 40_000,
  // skip a rewrite that saves less than this share of the request: a few
  // percent is not worth a cache miss or a changed view for the agent.
  requestMinSavingsPct: 12,
  // even when the protected tail alone exceeds the budget, the final N
  // messages are shielded from elision (they may still be head+tail
  // compressed). 0 = shield none; user turns are always protected.
  requestHardProtect: 2,
  // parts below this size are not worth rewriting.
  requestPartMinTokens: 800,
  // in the hard-budget phase, even small parts are worth paging once the
  // alternative is sending them verbatim; the marker costs ~35 tokens.
  requestElideMinTokens: 200,
  // Layer 3 — collapse old tool steps into deterministic ledger rows
  // (#step · tool · target · exit · size · recall). No model call, no drift;
  // the newest `requestLedgerKeepRecent` results stay byte-for-byte.
  requestLedger: true,
  requestLedgerKeepRecent: 5,
  requestLedgerKeepTokens: 8_000,
  requestLedgerMinTokens: 60,
  // A huge historical user message (pasted transcript, injected checkpoint,
  // log dump) is bulk, not an instruction. Condense it to opening + constraint
  // lines + closing, with a recall handle. The live user message is untouched.
  requestCompressUserBulk: true,
  requestUserBulkMinTokens: 32_000,
  requestUserKeepTokens: 4_000,
  requestUserHeadChars: 4_000,
  requestUserTailChars: 1_000,
  // elide old image/file attachments (re-attach if the model needs them).
  requestElideAttachments: true,
  // blank out old reasoning text — never for signed/encrypted reasoning.
  requestElideReasoning: true,
  // tell the model, once per session, how paging works and how to recover text.
  requestContract: true,
  // Layer 1c: ask OpenCode to compact when the model's own auto-compaction
  // would not fire for a very long time (e.g. 1M-token Kimi K3).
  proactiveCompaction: true,
  // only compact at a turn boundary: compacting mid-task replaces the working
  // set the agent is still using.
  proactiveCompactAtTurnBoundary: true,
  // fraction of the model's context window that triggers it.
  proactiveCompactRatio: 0.35,
  // absolute floor so small-window models are untouched.
  proactiveCompactMinTokens: 120_000,
  // minimum gap between two proactive compactions for the same session.
  proactiveCompactCooldownMs: 10 * 60_000,
  // Self-tuning loop: telemetry is always on (file appends only); the analysis
  // cycle additionally needs `selfLearnSessions` sessions of new experience
  // and ≥ selfLearnIntervalHours hours since the last call, proposes at most
  // one numeric knob inside the KNOB clamp table, and only after a
  // marker-gated bench run confirms it does the change become permanent
  // (otherwise it is reverted). Set selfLearnKnobs to an array to restrict
  // the tunables, or selfLearn:false to disable everything but telemetry.
  selfLearn: true,
  // model for the analysis call; null = the session's own model (free-tier
  // sessions distill through the session-scoped route, so this stays free).
  selflearnModel: null,
  // sessions of new experience (≥3 turns each) before an analysis may run.
  selfLearnSessions: 4,
  // minimum hours between two analyses — the loop cadence, not a rate limit.
  selfLearnIntervalHours: 20,
  // a provisional change lives at least this many days before its bench runs
  // (live signals need time to accumulate), and benches run at most once per
  // this interval.
  selfLearnVerifyDays: 7,
  selfLearnVerifyGraceHours: 24,
  // null = every knob in lib/selftune.mjs KNOBS; array = explicit allowlist.
  selfLearnKnobs: null,
};
