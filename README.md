# BabyZilla 🦖

[![tests](https://github.com/StibaDu/babyzilla/actions/workflows/test.yml/badge.svg)](https://github.com/StibaDu/babyzilla/actions/workflows/test.yml)

**70–99% context compression for [OpenCode](https://opencode.ai) v2 — in five layers, one install.**

- **Layer 1 — Session compaction** (ContextPack): OpenCode's compaction
  summary is replaced by AI-distilled **context modules** — state, decisions,
  code pointers, failure histories — dropping tool-output bulk while keeping
  exact, re-fetchable facts.
- **Layer 1b — Per-request budget**: before *every* request the outgoing
  message list is capped — target 10% of the incoming context
  (`requestTargetRatio`), floored at 12K and hard-capped at 45K
  (`requestBudgetTokens`). Old tool output, assistant prose, reasoning and
  attachments are compressed in place; if that is not enough, the oldest parts
  become one-line pointers. Recent turns and all user messages stay verbatim.
  This is what makes BabyZilla work on huge-window models such as **Kimi K3
  (1M tokens)**, where native compaction may never fire. Savings are recorded
  per session and shown by `babyzilla stats` and `/contextpack`.
- **Layer 1c — Proactive compaction**: OpenCode's own compaction only fires
  near the model's context limit, so a 1M-token session can grow unbounded
  before Layer 1 ever runs. Once the context passes
  `max(proactiveCompactMinTokens, proactiveCompactRatio × window)` BabyZilla
  asks OpenCode to compact (rate-limited per session), so the pack kicks in at
  ~35% of the window instead of ~90%. Disable with `proactiveCompaction: false`.
- **Layer 2 — Command compression** (lowfat, bundled and adapted from
  [zdk/lowfat](https://github.com/zdk/lowfat), Apache-2.0): shell commands are
  rewritten *before execution* (`git status`, `ls -la`, `docker …` →
  token-compact forms), so tool output enters the context pre-compressed.
- **Layer 2b — Tool-result compression**: large `read` / `grep` / `glob`
  results are compacted *at the source*, before they are persisted and resent
  on every later turn. Head, tail, structural and error lines are kept; line
  numbers stay intact.

All five run automatically. Layer 2 needs the `lowfat` binary (~3 MB release
download, no Rust toolchain); without it BabyZilla stays fully functional
minus that layer.

| Transcript at compaction | Pack | Savings |
| --- | --- | --- |
| 72.2K tokens | 1.2K tokens | **98.4%** |
| 57.8K | 0.3K | ~99% |
| 18.4K | 0.3K | 98% |
| 8.2K | 0.6K | 93% |

## Install

Give this one sentence to your AI agent:

> Install BabyZilla from github.com/StibaDu/babyzilla — your agent will handle
> it (it should read `AGENT-INSTALL.md` and follow it).

Or, if you prefer humans doing it:

```sh
opencode plugin add github:StibaDu/babyzilla
```

Optional companion CLI (zero deps, needs Node ≥ 18):

```sh
npm i -g git+https://github.com/StibaDu/babyzilla.git
babyzilla stats    # savings across all packs; also: show / verify / prune
babyzilla cost     # provider-side spend from OpenCode's usage records
babyzilla recall call_abc123:120-180    # exact original behind an elision marker
babyzilla retrieve src/app.js:120-160   # exact span, numbered
```

## How it works

1. **Layer 1b, before every request**: OpenCode v2's `session.hook("context")`
   hands the plugin the exact `messages` array it is about to send. Above
   `requestBudgetTokens` (45K by default) BabyZilla compresses old tool output,
   assistant prose, reasoning and attachments in place, then elides the oldest
   bulk to one-line pointers if the budget is still exceeded. Every pointer is
   reversible: it names a `babyzilla recall <id>` handle that prints the exact
   original text from the content-addressed page store (falling back to the
   session database). Works for `shell`, `grep`, `read` — everything. The
   target is 8% of the incoming context
   (`requestTargetRatio`), with a 12K floor. The current user turn, the newest
   messages and the newest result per file stay verbatim. A rewrite that would
   save less than 12% (`requestMinSavingsPct`) is skipped instead of churning
   the prompt cache. No compaction required — so 1M-token models are covered.
2. **Layer 2, before every tool call**: the plugin hooks shell execution and,
   when the `lowfat` binary is present, rewrites the command through
   `lowfat rewrite` — output enters the context already compressed.
3. **Layer 2b, after each `read` / `grep` / `glob`**: large results are
   compacted at the source. The most recent results stay verbatim
   (`toolResultProtectRecent`), the current turn is untouched, and older
   duplicates of the same file/command are compressed first; the rest keep
   head + tail + structure with the exact text one `babyzilla recall` away.
4. **Layer 1, at compaction**: BabyZilla hooks OpenCode's `compaction` hook,
   receives the full transcript, and calls your configured model to distill it
   into JSONL modules: a state module (*hot*, always inlined), a decisions
   module (*hot*), and topic/code/errors modules (*cold*).
5. **On later prompts** cold modules auto-attach when the prompt matches
   their trigger words (max 2 modules, 6K-token budget) — so long-session
   context stays available *without staying in the window*.
6. **Tool results** are journaled (kind + token estimate + 1200-char head) so
   savings are measurable and future sessions can reuse them.
7. **Anything fails → nothing happens.** OpenCode's native compaction runs.
   BabyZilla never modifies or deletes session history.

See [docs/HOW-IT-WORKS.md](docs/HOW-IT-WORKS.md) for the full picture and
[docs/OPTIONS.md](docs/OPTIONS.md) for every option.

## Why it works

Traditional summaries compress lossily and irreversibly — whatever the model
paraphrased is all you keep. BabyZilla's modules are **pointers-first**: every
fact carries a `file:line`, a command, or a tool name, so post-compaction the
agent can *re-fetch exact evidence from disk* instead of trusting a paraphrase.
Cold modules live as real files — grep-able, merge-able, and promoted into a
per-project library that outlives individual sessions.

## Examples

- [`docs/BENCHMARKS.md`](docs/BENCHMARKS.md) — the measured head-to-head
  against Headroom (same model, same files, four rounds).
- [`examples/tool-result-compression.md`](examples/tool-result-compression.md) —
  Layer 2b, before/after, with measured token counts.
- [`examples/real-pack/`](examples/real-pack/) — a real pack produced for a
  3-hour session (98.4% smaller than the incoming transcript).

## Requirements & privacy

- OpenCode **v2**, any model configured (distillation uses the session's
  model by default; pin a cheaper one with `distillModel`). Works regardless of
  window size: models with 1M-token windows (Kimi K3) are capped per request by
  Layer 1b instead of waiting for compaction, while small local models (8K-32K)
  get a budget and a distillation input that fit their window. Token estimates
  count CJK/emoji at roughly one token per character. This includes
  **OpenCode's free tier** — session-less distillation calls are rejected there, so BabyZilla
  falls back to the session-scoped call automatically (see `distillVia` in
  `docs/OPTIONS.md`).
- **macOS, Linux and Windows.** Layers 1 and 1c are pure OpenCode hooks; the
  optional lowfat integration probes PATH with `where` on Windows and its
  absence only disables Layer 2. Node ≥ 18 for the CLI; `babyzilla cost` needs
  Node ≥ 22.5 (`node:sqlite`) and fails with a clear message otherwise.
- Distillation sends transcript text to your configured model provider.
  Journals, module files, and stats stay on disk in
  `~/.opencode/contextpacks/` — delete anytime (`babyzilla prune` or
  `rm -rf`).

## Status

Tested on OpenCode v2.0.29 (macOS). The test suite runs in CI on macOS, Linux
and Windows (Node 18, 20, 22). Layer 2 needs the optional `lowfat` binary and
is skipped when absent. If you try it, please open an issue with your version
and savings numbers — they go into the table above.