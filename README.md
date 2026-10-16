# BabyZilla 🦖

**70–99% context compression for [OpenCode](https://opencode.ai) v2.**

BabyZilla replaces OpenCode's compaction summary with AI-distilled **context
modules** — small files that preserve what actually matters (state, decisions,
code pointers, failure histories) and drop what doesn't (tool-output bulk).
It runs automatically at every compaction. Your agent keeps working with,
measured on real sessions:

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

1. **At compaction** BabyZilla hooks OpenCode's `compaction` hook, receives
   the full transcript, and calls your configured model to distill it into
   JSONL modules: a state module (*hot*, always inlined), a decisions module
   (*hot*), and topic/code/errors modules (*cold*).
2. **On later prompts** cold modules auto-attach when the prompt matches
   their trigger words (max 2 modules, 6K-token budget) — so long-session
   context stays available *without staying in the window*.
3. **Tool results** are journaled (kind + token estimate + 1200-char head) so
   savings are measurable and future sessions can reuse them.
4. **Anything fails → nothing happens.** OpenCode's native compaction runs.
   BabyZilla never modifies or deletes session history.

See [docs/HOW-IT-WORKS.md](docs/HOW-IT-WORKS.md) for the full picture and
[docs/OPTIONS.md](docs/OPTIONS.md) for the five knobs.

## Why it works

Traditional summaries compress lossily and irreversibly — whatever the model
paraphrased is all you keep. BabyZilla's modules are **pointers-first**: every
fact carries a `file:line`, a command, or a tool name, so post-compaction the
agent can *re-fetch exact evidence from disk* instead of trusting a paraphrase.
Cold modules live as real files — grep-able, merge-able, and promoted into a
per-project library that outlives individual sessions.

## Requirements & privacy

- OpenCode **v2**, any model configured (distillation uses the session's
  model by default; pin a cheaper one with `distillModel`).
- Distillation sends transcript text to your configured model provider.
  Journals, module files, and stats stay on disk in
  `~/.opencode/contextpacks/` — delete anytime (`babyzilla prune` or
  `rm -rf`).

## Status

Tested on OpenCode v2.0.29 (macOS). Linux expected to work identically;
Windows untested. If you try it, please open an issue with your version and
savings numbers — they go into the table above.