# Real pack specimen

> **Version note:** this specimen was captured at **v0.1.0**. The plugin has
> since added Layer 2 (shell rewriting, v0.2.0), Layer 2b (tool-result
> compression), free-tier support and session-scoped distillation (v0.3.0) —
> see [`../tool-result-compression.md`](../tool-result-compression.md) for the
> newer layer. The pack structure below is unchanged.

This is the actual ContextPack BabyZilla produced for one real session
(a 3+-hour OpenCode plugin-development session).

- Incoming transcript at compaction: **72.2K tokens** (159 parts: 5 user,
  55 assistant, 99 tool results)
- Resulting pack: **~1.2K tokens** — **98.4% smaller**

Files:
- `00-state.md` — hot: the session's state, always inlined into the summary
- `decisions-design-decisions.md` — hot: design decisions with rationale
- `code-opencode-hook-shapes.md` — cold: verified API/hook knowledge, attached
  to later prompts when triggers match (`hook`, `compaction`, `api`, …)
- `errors-build-failures.md` — cold: failure history (promoted to the project
  library for future sessions)
- `index.json` — the machine-readable index the CLI and plugin read

Note the `file:line` pointers throughout the modules — that's the point:
after compaction the agent can re-fetch exact evidence from disk instead of
trusting a paraphrase.