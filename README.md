```text
   ___  ___   _____  ______  ______   __   ___
  / _ )/ _ | / _ ) \/ /_  / /  _/ /  / /  / _ |
 / _  / __ |/ _  |\  / / /__/ // /__/ /__/ __ |
/____/_/ |_/____/ /_/ /___/___/____/____/_/ |_|
```

# BabyZilla 🦖

[![tests](https://github.com/StibaDu/babyzilla/actions/workflows/test.yml/badge.svg)](https://github.com/StibaDu/babyzilla/actions/workflows/test.yml)

**70–99% context compression for [OpenCode](https://opencode.ai) v2 — in six layers, one install.**

- **Layer 1 — Session compaction** (ContextPack): OpenCode's compaction
  summary is replaced by AI-distilled **context modules** — state, decisions,
  code pointers, failure histories — dropping tool-output bulk while keeping
  exact, re-fetchable facts.
- **Layer 1b — Per-request budget**: before *every* request the outgoing
  message list is capped — target 8% of the incoming context
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
- **Layer 3 — Deterministic ledger + recall**: what Layer 1b has to drop does
  not become an anonymous "elided" marker. Every old tool step collapses to
  one row built from the call itself — `#12 · bash · npm test · exit 1 ·
  3.1K tok · recall 8c1f…` — so the model keeps the index of what was already
  tried without the payload. Nothing is rewritten by a model, and every row and
  pointer is reversible: `babyzilla recall <id>` prints the exact original
  text (add `:start-end` for a span) from a content-addressed page store.

All six run automatically. Layer 2 needs the `lowfat` binary (~3 MB release
download, no Rust toolchain); without it BabyZilla stays fully functional
minus that layer.

| Transcript at compaction | Pack | Savings |
| --- | --- | --- |
| 72.2K tokens | 1.2K tokens | **98.4%** |
| 57.8K | 0.3K | ~99% |
| 18.4K | 0.3K | 98% |
| 8.2K | 0.6K | 93% |

That column is a **compression ratio**: how much of the older transcript leaves
the prompt at the moment Layer 1 compacts. It is not a claim about every
request — a short session that never reaches compaction saves through Layer 1b
and Layer 2 instead, and saves less in absolute terms because it carries less
to begin with. The benchmarks were run on a heavy session; see
[`docs/BENCHMARKS.md`](docs/BENCHMARKS.md#what-the-workload-carried) for what
that means on a light install.

## Do you need it?

Ask one question: **does a long session of yours get slow, expensive, or
context-starved?**

| Your sessions | Expected effect |
| --- | --- |
| short Q&A, a few files, under ~15K tokens | **none.** Layer 1b has a 12K floor and skips rewrites that save under 12%. Installing costs you nothing but changes nothing. |
| long agentic runs, many reads and shell commands, 30K–200K tokens | **the normal case.** Older tool output and prose compress per request; compaction swaps the transcript for a pack. |
| huge tool surface (thousands of MCP tools) | schemas are billed on every request and BabyZilla does **not** touch them — it compresses messages only. Helpful, but that bulk needs a different fix (e.g. code mode). |
| a small local model (8K–32K window) | **most valuable.** You get a budget that fits the window and a distillation input that fits too, instead of failures at half the conversation. |

Nothing in that table requires any particular tool set, provider, or account —
just OpenCode v2 and a model you already use.

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
babyzilla recall 8c1f0b7a9d2e4c15   # exact original behind a paging marker / ledger row
babyzilla recall 8c1f0b7a9d2e4c15:120-180   # just those lines
babyzilla retrieve src/app.js:120-160   # exact span, numbered
```

## How do I know it's working?

You do not have to trust a benchmark table — the plugin logs its own numbers.

1. **It loaded.** After the first turn in a new session,
   `~/.opencode/contextpacks/debug.log` should exist and mention the plugin
   version. If it doesn't, the plugin did not load (see `AGENT-INSTALL.md`
   Step 4 for the exact checks).
2. **It compressed something.** Work normally for a while, then:

   ```sh
   babyzilla stats
   ```

   Each pack row shows raw tokens in, tokens actually sent, and per-layer
   counts. A session under ~12K tokens may legitimately show zero: nothing
   crossed the floor.
3. **Nothing was lost.** Any marker or ledger row carries a handle:
   `babyzilla recall <handle>` returns the exact original text. If you ever
   cannot recover something, that is a bug — please open an issue with the
   handle.

A realistic first-week result on a light install is a modest per-request saving
and one compaction you barely noticed. The 98% figures are the ceiling for
transcript-heavy sessions, not the expected median.

## How it works

The layers run in this order, cheapest first. None of them needs a model call
except Layer 1.

1. **Layer 2, before every tool call**: the plugin hooks shell execution and,
   when the `lowfat` binary is present, rewrites the command through
   `lowfat rewrite` — output enters the context already compressed.
2. **Layer 2b, after each `read` / `grep` / `glob`**: large results are
   compacted at the source. The most recent results stay verbatim
   (`toolResultProtectRecent`), the current turn is untouched, and older
   duplicates of the same file/command are compressed first; the rest keep
   head + tail + structure with the exact text one `babyzilla recall` away.
3. **Layer 1b + Layer 3, before every request**: OpenCode v2's
   `session.hook("context")` hands the plugin the exact `messages` array it is
   about to send. Above the budget — 8% of the incoming request
   (`requestTargetRatio`), floored at 12K and hard-capped at 45K
   (`requestBudgetTokens`) — BabyZilla compresses old tool output, assistant
   prose, reasoning and attachments in place. Steps that still have to go
   become **ledger rows** built from the call itself (`#12 · bash · npm test ·
   exit 1 · 3.1K tok · recall 8c1f…`), never anonymous markers, and the newest
   ~8K tokens of tool results stay byte-for-byte. Every row and pointer is
   reversible through the content-addressed page store (falling back to the
   session database). Works for `shell`, `grep`, `read` — everything.
4. **Layer 1b, historical user bulk**: a user message *older than the current
   turn* above 32K tokens (`requestUserBulkMinTokens`) is condensed the same
   way — opening, constraint lines and closing kept verbatim, the rest paged
   behind a recall handle. The **live** user message is never touched.
5. **Cache safety**: a rewrite that would save less than 12%
   (`requestMinSavingsPct`) is rolled back instead of churning the provider's
   prompt cache, and so is any rewrite that would push the request over the
   model window. No compaction is required for any of this — which is what
   makes it work on 1M-token models.
6. **Layer 1c, proactive compaction**: OpenCode's own compaction only fires
   near the model's context limit, so a 1M-token session can grow unbounded
   before Layer 1 ever runs. Once the context passes
   `max(proactiveCompactMinTokens, proactiveCompactRatio × window)` BabyZilla
   asks OpenCode to compact (rate-limited per session), so the pack kicks in at
   ~35% of the window instead of ~90%. Disable with `proactiveCompaction: false`.
7. **Layer 1, at compaction**: BabyZilla hooks OpenCode's `compaction` hook,
   receives the full transcript, and calls your configured model to distill it
   into JSONL modules: a state module (*hot*, always inlined), a decisions
   module (*hot*), and topic/code/errors modules (*cold*). Two modules are
   never written by the model: `00-anchors.md`, the last question and the reply
   it answers kept verbatim, and `00-recovered.md`, the facts and `path:line`
   pointers the model dropped but the transcript still had.
8. **On later prompts** cold modules auto-attach when the prompt matches
   their trigger words (max 2 modules, 6K-token budget) — so long-session
   context stays available *without staying in the window*.
9. **Tool results** are journaled (kind + token estimate + 1200-char head) so
   savings are measurable and future sessions can reuse them.
10. **Anything fails → nothing happens.** OpenCode's native compaction runs.
    BabyZilla never modifies or deletes session history: paging moves text to a
    local page store, it does not destroy it.

See [docs/HOW-IT-WORKS.md](docs/HOW-IT-WORKS.md) for the full picture,
[docs/OPTIONS.md](docs/OPTIONS.md) for every option, and
[examples/](examples/) for before/after of each layer.

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
- [`examples/pack-eval.md`](examples/pack-eval.md) — `babyzilla eval`: score a
  pack against the transcript it replaced, on a real session.

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
- **No tool servers, no extra accounts.** BabyZilla reads OpenCode's own event
  stream, so it does not care which tools you have — a stock install with the
  built-in `read`/`grep`/`shell` tools is the normal case. There is nothing to
  connect: no MCP servers, no Cloudflare (or any other) account, no vector
  database, no embeddings, no proxy, no daemon. The one network call it makes
  is the distillation request to the model provider you already configured.
- Distillation sends transcript text to your configured model provider.
  Journals, module files, and stats stay on disk in
  `~/.opencode/contextpacks/` — delete anytime (`babyzilla prune` or
  `rm -rf`).

## Status

Tested on OpenCode v2.0.29 (macOS). The test suite runs in CI on macOS, Linux
and Windows (Node 18, 20, 22). Layer 2 needs the optional `lowfat` binary and
is skipped when absent. If you try it, please open an issue with your version
and savings numbers — they go into the table above.
