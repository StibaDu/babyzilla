# BabyZilla 🦖

**70–99% context compression for [OpenCode](https://opencode.ai) v2 — in two layers, one install.**

- **Layer 1 — Session compaction** (ContextPack): OpenCode's compaction
  summary is replaced by AI-distilled **context modules** — state, decisions,
  code pointers, failure histories — dropping tool-output bulk while keeping
  exact, re-fetchable facts.
- **Layer 2 — Command compression** (lowfat, bundled and adapted from
  [zdk/lowfat](https://github.com/zdk/lowfat), Apache-2.0): shell commands are
  rewritten *before execution* (`git status`, `ls -la`, `docker …` →
  token-compact forms), so tool output enters the context pre-compressed.

Both run automatically. Layer 2 needs the `lowfat` binary (~3 MB release
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
```

## How it works

1. **Layer 2, before every tool call**: the plugin hooks shell execution and,
   when the `lowfat` binary is present, rewrites the command through
   `lowfat rewrite` — output enters the context already compressed.
2. **Layer 1, at compaction**: BabyZilla hooks OpenCode's `compaction` hook,
   receives the full transcript, and calls your configured model to distill it
   into JSONL modules: a state module (*hot*, always inlined), a decisions
   module (*hot*), and topic/code/errors modules (*cold*).
3. **On later prompts** cold modules auto-attach when the prompt matches
   their trigger words (max 2 modules, 6K-token budget) — so long-session
   context stays available *without staying in the window*.
4. **Tool results** are journaled (kind + token estimate + 1200-char head) so
   savings are measurable and future sessions can reuse them.
5. **Anything fails → nothing happens.** OpenCode's native compaction runs.
   BabyZilla never modifies or deletes session history.

See [docs/HOW-IT-WORKS.md](docs/HOW-IT-WORKS.md) for the full picture and
[docs/OPTIONS.md](docs/OPTIONS.md) for the six knobs.

## Why it works

Traditional summaries compress lossily and irreversibly — whatever the model
paraphrased is all you keep. BabyZilla's modules are **pointers-first**: every
fact carries a `file:line`, a command, or a tool name, so post-compaction the
agent can *re-fetch exact evidence from disk* instead of trusting a paraphrase.
Cold modules live as real files — grep-able, merge-able, and promoted into a
per-project library that outlives individual sessions.

## Examples

- [`examples/tool-result-compression.md`](examples/tool-result-compression.md) —
  Layer 2b, before/after, with measured token counts.
- [`examples/real-pack/`](examples/real-pack/) — a real pack produced for a
  3-hour session (98.4% smaller than the incoming transcript).

## Requirements & privacy

- OpenCode **v2**, any model configured (distillation uses the session's
  model by default; pin a cheaper one with `distillModel`). This includes
  **OpenCode's free tier** — session-less distillation calls are rejected
  there, so BabyZilla falls back to the session-scoped call automatically
  (see `distillVia` in `docs/OPTIONS.md`).
- Distillation sends transcript text to your configured model provider.
  Journals, module files, and stats stay on disk in
  `~/.opencode/contextpacks/` — delete anytime (`babyzilla prune` or
  `rm -rf`).

## Status

Tested on OpenCode v2.0.29 (macOS). Linux expected to work identically;
Windows untested. If you try it, please open an issue with your version and
savings numbers — they go into the table above.