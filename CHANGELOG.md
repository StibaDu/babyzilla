# Changelog

All notable changes to BabyZilla. Versions follow [SemVer](https://semver.org/).

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
