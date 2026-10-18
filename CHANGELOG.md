# Changelog

All notable changes to BabyZilla. Versions follow [SemVer](https://semver.org/).

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
