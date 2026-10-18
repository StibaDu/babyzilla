# Changelog

All notable changes to BabyZilla. Versions follow [SemVer](https://semver.org/).

## [0.7.0] — 2026-10-18

### Added

- **Layer 3: deterministic turn ledger.** Old tool steps no longer become
  anonymous "elided" markers. Each one collapses to a row built from the call
  itself — `#12 · bash · npm test · exit 1 · 3.1K tok · recall 8c1f…` — so the
  transcript stays an index of what was already tried. No model call, no drift:
  tool, target, exit status and size all come from the call. The newest
  `requestLedgerKeepTokens` (8K) / `requestLedgerKeepRecent` (5) results stay
  byte-for-byte.
- **Bulk historical user context.** A *historical* user message above
  `requestUserBulkMinTokens` (32K) is condensed to its opening, the lines that
  read like constraints, and its closing, plus a recall handle. The **live**
  user message is never touched. This is what harness checkpoints and pasted
  transcripts are made of; in practice it was 92% of the request.
- Options: `requestLedger`, `requestLedgerKeepRecent`,
  `requestLedgerKeepTokens`, `requestLedgerMinTokens`,
  `requestCompressUserBulk`, `requestUserBulkMinTokens`,
  `requestUserKeepTokens`, `requestUserHeadChars`, `requestUserTailChars`.

### Changed

- `requestMinSavingsPct` default 12: a rewrite that saves less is rolled back,
  so the prompt stays cache-stable instead of churning.
- `requestBudget()` is exported: the 8% / 12K floor / 45K cap interaction is now
  covered by tests instead of only by docs.

### Fixed

- Markers no longer advertise handles that cannot be resolved. Loop indexes
  (`i3`) and raw call ids (`call_…`) are not persisted by OpenCode, so only a
  real 16-hex page hash is printed as `babyzilla recall <hash>`.

## [0.6.0] — 2026-10-18

### Added

- **`babyzilla recall <hash>[:start-end]`** — paging is now reversible. Every
  elided block is written to a content-addressed page store
  (`~/.opencode/contextpacks/pages/`) before it is replaced, and the marker
  carries the handle. Works for **every** tool, including shell/grep output
  that cannot be re-read from a file. Falls back to the OpenCode database
  (`callID` / part id / message id) for older sessions.
- **Recovery contract.** The first time a request is paged, the model is told
  once what happened, what is preserved, and how to recall exact text — instead
  of discovering redactions marker by marker.

### Fixed

- **The working set is protected by tokens, not message count.** A single
  agentic turn can contain hundreds of tool results; protecting "the last 6
  messages" elided files the agent was still editing. The newest
  `requestTurnProtectTokens` (40K) of the current turn now stay verbatim, and
  the protected set is only structurally compressed when the budget requires
  it — never blanked or reduced to pointers.
- **No more re-read loops.** The newest result per file/command is never
  source-compressed, small results (< `toolResultMinTokens`, now 4000) are left
  alone, and source compression is deferred to the next user turn.
- **Near-no-op rewrites are rolled back.** A pass that saves less than
  `requestMinSavingsPct` (12%) restores the original messages, so the prompt
  prefix and the model's view stay stable (47/1147 passes previously saved
  <10%).
- **Proactive compaction waits for a turn boundary** — it no longer fires
  between a tool call and its result.
- **Reasoning removal is announced** (`[ContextPack] older reasoning elided`)
  instead of silently blanking it.

### Changed

- `requestTargetRatio` default is now documented as `0.08` (code default since
  v0.5.2).
- `toolResultProtectRecent` default `1` → `3`.
- `babyzilla prune` also prunes the page store.

## [0.5.2] — 2026-10-18

### Fixed

- **Any model, any window.** Layer 1b clamps its budget to the model's own
  context window (`requestMaxPromptRatio`, default 0.5). An 8K/32K local model
  no longer gets a 45K message budget it cannot hold. Distillation input scales
  with the window (40%, capped at 48K) instead of a fixed 48K that small models
  cannot accept; `distillBudgetTokens` overrides it.
- **Non-ASCII token estimates.** `estTokens` counts CJK/Cyrillic/emoji at ~1
  token per character instead of 4 chars per token, so Chinese/Japanese sessions
  no longer slip past the budget by 3-4x.
- **Tool/message shapes.** Persisted tool parts (`state.output`) are counted,
  compressed and elided like the API shape (`state.content`); source-level tool
  compression accepts both. System/developer turns are never rewritten.
  Attachments drop their provider fields (`url`, `mime`, `source`).
- **Signed reasoning.** Reasoning whose signature lives in `metadata` is
  preserved instead of blanked.
- **`babyzilla cost`.** Falls back to the `session` table on OpenCode versions
  without `session_v2`, honors `XDG_DATA_HOME`/`LOCALAPPDATA`, and explains
  itself when no usage table exists.
- **Windows paths.** Attachment URIs use `pathToFileURL`, and
  `retrieve file:///C:/…` no longer mangles the drive path.

## [0.5.1] — 2026-10-18

### Fixed

- **Cross-platform startup.** Layer 2 no longer depends on a POSIX shell:
  lowfat is located with `where` on Windows (`command -v` elsewhere) and
  invoked via `execFile` instead of a shell-quoted string. Homebrew and
  Windows install locations are probed; a missing lowfat still only disables
  Layer 2.
- **CI on macOS/Windows.** `npm test` expands `test/*.test.mjs` in Node, so the
  suite also runs under cmd.exe, and the `node:sqlite` test is skipped below
  Node 22.5. The matrix now covers Ubuntu, macOS and Windows.

## [0.5.0] — 2026-10-18

### Added

- `babyzilla cost [sessionID] [--limit N] [--json]` — provider-side spend from
  OpenCode's own usage records (`session_v2`): input, cached input, output,
  cache-hit rate, and cost estimated at list prices next to the recorded cost.
  Layer 1b's `request-stats.json` counts *message* tokens; this closes the loop
  with what the provider actually billed. Uses `node:sqlite` lazily, so the
  rest of the CLI still runs on older Node versions.

## [0.4.0] — 2026-10-18

### Added

- **Layer 1b — hard per-request budget** via OpenCode v2's
  `session.hook("context")`. BabyZilla previously only acted at compaction, so
  models with huge windows (Kimi K3: 1M tokens) could run entire sessions
  without the plugin ever firing. The new hook runs before every request:
  once the budget is exceeded it compresses old tool results, assistant prose,
  reasoning and attachments in place, then reduces the oldest parts to
  one-line pointers. It targets `requestTargetRatio` (10% of the incoming
  context, floored at 12K) and caps at `requestBudgetTokens` (45K). Measured
  on a 1.13M-token Kimi-K3 session: **1,129.6K → 44.9K tokens (96% smaller)**;
  a 160K request lands at ~16K (90%).
- Per-request savings are accumulated in `request-stats.json` per session and
  surfaced by `babyzilla stats`, `babyzilla show`, and `/contextpack` — so
  Layer 1b is measurable even when no compaction ever runs.
- New options: `requestCompression`, `requestBudgetTokens`,
  `requestTargetRatio`, `requestMinBudgetTokens`, `requestMinTokens`,
  `requestProtectRecent`, `requestHardProtect`, `requestPartMinTokens`,
  `requestElideAttachments`, `requestElideReasoning`.
- **Layer 1c — proactive compaction.** OpenCode's own compaction only fires
  near the model's context limit, which for a 1M-token model (Kimi K3) means a
  session can grow to hundreds of thousands of tokens before BabyZilla ever
  gets to replace the summary. When a request reaches
  `max(proactiveCompactMinTokens, proactiveCompactRatio × context window)`,
  BabyZilla now calls `session.compact()` itself (rate-limited per session), so
  the pack kicks in early. New options: `proactiveCompaction`,
  `proactiveCompactRatio`, `proactiveCompactMinTokens`,
  `proactiveCompactCooldownMs`.
- Manual/free-tier compactions that hand the hook a single synthetic message
  now fall back to the live session context, so distillation sees the real
  transcript instead of one blob (and no longer skips as "below minRawTokens").
- `test/plugin-context.test.mjs` — loads the real plugin and asserts >90%
  reduction on a 1M-token-shaped message list, and that a 1M-token request
  triggers a proactive compaction.

### Changed

- Docs now describe the four layers (1, 1b, 2, 2b) and when each one fires.
- `distillVia: "auto"` now starts with the session-scoped call for the
  `opencode` provider (free tier), avoiding a guaranteed failed request and
  the resulting native-compaction fallback.

## [0.3.2] — 2026-10-18

### Fixed

- `parseModules` now accepts a **top-level JSON array** (compact or
  pretty-printed), not just JSONL or `{modules:[…]}`. Models that answer with
  an array no longer cost a retry.

## [0.3.1] — 2026-10-18

### Added

- **`babyzilla retrieve <path>[:<start>[-<end>]]`** — print an exact, numbered
  line range, so an elided span can be pulled back without re-reading the file.
- **`toolResultProtectRecent`** (default `1`) — the most recent tool results
  stay verbatim; only older ones are compressed. Removes the "compress → agent
  re-reads" loop.
- **Attach freshness note** — when a cold module is attached, the session gets
  a short note that its captured line counts may be stale, and how to verify.
- **CI** — GitHub Actions runs the test suite on Node 18, 20 and 22 for every
  push to `main` and every pull request.
- **`docs/BENCHMARKS.md`** — the measured head-to-head against Headroom 0.41.0
  (same model, same files, four rounds), with methodology and caveats.

### Changed

- The pure distillation helpers (`reduceForDistill`, `parseModules`,
  `buildSummary`, `distillationPrompt`, `moduleFileFor`, `libraryIndex`) moved
  into `lib/` so Layer 1 is unit-testable without loading the plugin.
- Test suite grew from 30 to **71 tests**, including regression coverage for the
  library-path bug fixed in 0.3.0.

## [0.3.0] — 2026-10-18

### Added

- **Layer 2b — tool-result compression.** Large `read`, `grep`, `glob` and
  `list` results are compressed **at the source**, before they are persisted
  and resent on every later turn. Head, tail, structural and
  diagnostic/TODO lines are kept and line numbers stay intact, so exact ranges
  remain readable. Options: `toolResultCompression` (`true`),
  `toolResultMinTokens` (`1200`), `toolResultHeadLines` (`40`),
  `toolResultTailLines` (`20`).
- **`distillVia`** option — `"auto"` (default), `"session"`, `"text"` — selects
  how the distillation call is routed.

### Fixed

- **OpenCode free tier.** Distillation used the session-less
  `ctx.generate.text`, which the free tier rejects with *"free tier can only be
  used from within OpenCode"*. It now falls back to the session-scoped call, so
  Layer 1 works on free models.
- **Library module paths.** Library indexes store only a file basename, and the
  prompt hook resolved it under `sessions/<id>/` instead of
  `library/<project>/`.
- **Missing module files** no longer abort the whole turn with *"Unable to read
  attachment"*; they are skipped and logged.

### Measured

Same model (`ollama-cloud/deepseek-v4.1-flash`), same files, same prompts,
against Headroom 0.41.0:

| Round | BabyZilla | Headroom |
| --- | ---: | ---: |
| read-only, 4 files | **115,191** | 211,267 |
| constrained, 7 files | **46,516** | 103,470 |
| shell-only | **56,711** | 104,136 |

## [0.2.0] — 2026-10-16

### Added

- Bundled `lowfat` as **Layer 2**: shell commands are rewritten before
  execution, so tool output enters the context pre-compressed.

## [0.1.0] — 2026-10-16

### Added

- Initial release: AI-distilled ContextPack modules replace OpenCode's native
  compaction summary, with trigger-based auto-loading of cold modules.
