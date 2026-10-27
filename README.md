```text
   ___  ___   _____  ______  ______   __   ___
  / _ )/ _ | / _ ) \/ /_  / /  _/ /  / /  / _ |
 / _  / __ |/ _  |\  / / /__/ // /__/ /__/ __ |
/____/_/ |_/____/ /_/ /___/___/____/____/_/ |_|
```

# BabyZilla 🦖

[![tests](https://github.com/StibaDu/babyzilla/actions/workflows/test.yml/badge.svg)](https://github.com/StibaDu/babyzilla/actions/workflows/test.yml)

**70–99% context compression for [OpenCode](https://opencode.ai) v2 — in seven layers, one install.**

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
- **Grounding — no silent guesses**: every request carries one constant system
  part: answer directly when sure, say "I'm not sure" or check it with a tool
  when not, never pass a guess off as a fact, and never ask you to verify what
  the model could check itself. On by default (`grounding: false` drops it).
- **Token calibration — `babyzilla calibrate`**: `chars/4` is the estimate behind
  every absolute number (budget floor/cap, compaction trigger, reported savings),
  and it drifts by model and by content. The plugin appends one line per request;
  the command pairs those lines with what the provider actually billed and stores
  a per-model correction. Measured here: **×1.06** for DeepSeek V4.1 Flash
  (62 requests, p25–p90 1.02–1.18) — small at the median, real at the tail.
- **Layer 0.5 — Vision routing**: text-only main models receive a placeholder
  instead of image pixels, so image prompts are routed *before* the request:
  when a prompt involves image content, a one-shot synthetic note tells the
  main model to delegate to the vision subagent with the exact readable
  paths (`visionRoute: true` default).
- **Layer 2 — Command compression** (lowfat, bundled and adapted from
  [zdk/lowfat](https://github.com/zdk/lowfat), Apache-2.0): shell commands are
  rewritten *before execution* (`git status`, `ls -la`, `docker …` →
  token-compact forms), so tool output enters the context pre-compressed.
- **Layer 2b — Tool-result compression**: any large tool result is compacted
  *at the source*, before it is persisted and resent on every later turn.
  Everything over `toolResultEagerTokens` (default 8K, ~1.2× a routine
  read) is paged by size — no tool-name allowlist to maintain — and results
  under the threshold stay inline for free. Head, tail, structural and error
  lines are kept; line numbers stay intact.
- **Layer 3 — Deterministic ledger + recall**: what Layer 1b has to drop does
  not become an anonymous "elided" marker. Every old tool step collapses to
  one row built from the call itself — `#12 · bash · npm test · exit 1 ·
  3.1K tok · recall 8c1f…` — so the model keeps the index of what was already
  tried without the payload. Nothing is rewritten by a model, and every row and
  pointer is reversible: `babyzilla recall <id>` prints the exact original
  text (add `:start-end` for a span) from a content-addressed page store.

All seven run automatically. Layer 2 needs the `lowfat` binary (~3 MB release
download, no Rust toolchain); without it BabyZilla stays fully functional
minus that layer.

**Warm starts (opt-in).** With `carryIn: true` a *new* session opens warm: its
first prompt attaches the project library's hot modules (`state`, `decisions`)
trigger-free — any wording of the first message works — labeled `[carry-in]`,
fired at most once per session, within the same `maxAttach` /
`attachBudgetTokens` budget as normal attachments. The next session inherits
"where we left off" instead of rebuilding it. Off by default; see
[`docs/OPTIONS.md`](docs/OPTIONS.md).

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
npm i -g --allow-git=all git+https://github.com/StibaDu/babyzilla.git
# or, with no npm flags at all (works on every npm version):
#   git clone https://github.com/StibaDu/babyzilla.git ~/.local/src/babyzilla
#   npm i -g ~/.local/src/babyzilla
babyzilla pet      # desktop pet: 100 expressions, reacts to this session live
babyzilla setup    # guided setup: registers the plugin, grants the two permissions it needs
babyzilla stats    # aggregate savings; also: show / verify / eval / prune
babyzilla update   # check for a newer release (daily, cached); asks before updating
babyzilla cost     # provider-side spend from OpenCode's usage records
babyzilla models   # Ollama Cloud model knowledge base: caps, pricing, lanes (--audit)
babyzilla selftune status   # self-tuning loop: knobs, pending proposal, floor
babyzilla recall 8c1f0b7a9d2e4c15   # exact original behind a paging marker / ledger row
babyzilla recall 8c1f0b7a9d2e4c15:120-180   # just those lines
babyzilla retrieve src/app.js:120-160   # exact span, numbered
```

### Desktop pet

A 16-bit creature that lives at the bottom of your screen, wanders, and reacts
to what OpenCode is doing — 100 expressions, generated from one locked palette.

```sh
babyzilla pet install     # builds a small native app (needs Xcode CLT once)
babyzilla pet status      # running? how many sprites? last event?
babyzilla pet list        # all 100 expressions
babyzilla pet gallery     # the sprite field guide
```

It reads `~/.opencode/pet/events.jsonl`, which the plugin appends to on prompt,
tool, compaction and error events. No sockets, no network, no daemon: if the pet
is closed the plugin writes a few bytes. Turn it off with `"pet": false`.

It also **talks about you**: one line per step, reduced locally from the model's
reasoning and aimed at its human. Click the pet to open its **chat log** — the same
lines kept, scrollable, closing only when you say so. Each pet has its own voice — the dino is a caveman
("Human keep ask for bigger pet"), the anime packs are not — and only the caveman
rewrites words. Set `"petThoughts": "verbatim"` for the model's own sentences
instead, or `false` to turn it off. Try it with
`babyzilla pet think "The user wants a bigger pet."` (add `--voice claude` to hear
another pet say it).

It can speak **German** too: **right-click → Sprache → Deutsch** (or
`babyzilla pet lang de`) switches the pet's asides, its event lines and the app's
menus (`BABYZILLA_PET_LANG=de` for one shell only). The model's own sentence is
quoted as written — there is no translation call.

A fresh install wears **Lil Dino**, and **right-click → Pet → More pets…** opens a
browser over the [OpenPets](https://openpets.dev) catalog: search 1300+ pets, pick
one, and it installs itself and hops on screen. The same from a terminal:
`babyzilla pet catalog --search cat`, `babyzilla pet add <id>`,
`babyzilla pet add --originals` for the 79 made by the OpenPets team,
`babyzilla pet packs` / `pet use <name>` to switch (or right-click → Pet). A look
of your own can be built from a sprite sheet — see [docs/PET.md](docs/PET.md). Five anime pets import from a folder in one command:
`node pet/import-openpet.mjs --repo <openpet-ai-girls checkout>`. Unused pets can be deleted from your install with
`babyzilla pet remove <name>` — `pet restore <name>` brings them back.

### Setup, and the permissions that actually matter

```sh
babyzilla setup           # asks a few questions, shows the diff, writes with a backup
babyzilla setup --check   # report only: what is missing, plus a live self-test
babyzilla setup --yes     # accept the recommended answers (scripts)
```

The wizard registers the plugin if it is missing, offers the two permissions
BabyZilla needs, and proves the pieces work on this machine (data dir,
compression, recall round-trip, CLI on `PATH`).

| Permission | Why it matters | If you say no |
|---|---|---|
| `bash` → `babyzilla recall *`, `babyzilla retrieve *` | paged-out tool output is only recoverable through these commands | every recall prompts you; in a `deny` setup the paged detail is unreachable |
| `external_directory` → `~/.opencode/contextpacks/**` | packs and recall pages live outside the project | the agent cannot open a module file by path (recall via bash still works) |

That is the whole list. BabyZilla does **not** need `webfetch`, `websearch`,
`edit`, or broad `bash`: it never edits your files and runs no model tools of
its own. The wizard writes only its own keys, appends rules so they win
(`last match wins` in OpenCode), keeps a `.bak-<timestamp>`, and leaves a `deny`
in place as `"*": "deny"` with a narrow exception rather than silently
loosening it.

### Updates

Once a day BabyZilla asks GitHub Releases whether a newer version exists (one
unauthenticated request, cached for 24h in `contextpacks/update.json`). If there
is one, the agent mentions it in one line and asks whether to update; nothing is
ever installed without your yes. The CLI says the same thing and can act on it:

```sh
babyzilla update          # check now, then ask
babyzilla update --yes    # update a git checkout in place (git pull --ff-only)
babyzilla update --check  # report only, change nothing
```

Turn it off with `"checkUpdates": false` or `BABYZILLA_NO_UPDATE_CHECK=1`; the
check is offline-safe (a failed lookup is silent and retried an hour later) and
sends no identifiers beyond a `babyzilla/<version>` user-agent.

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
4. **The tuner stays visible.** With the self-tuning loop on (default),
   `babyzilla selftune status` shows its knobs, any pending proposal, the
   measured noise floor, and the decision counts — every change is also in
   `~/.opencode/contextpacks/selftune/ledger.jsonl`.

A realistic first-week result on a light install is a modest per-request saving
and one compaction you barely noticed. The 98% figures are the ceiling for
transcript-heavy sessions, not the expected median.

## Does it tune itself?

Yes, within strict limits — and every decision is visible:

1. **Telemetry, free.** Each finished session gets one record in
   `~/.opencode/contextpacks/selftune/sessions.jsonl`: billed tokens and cost
   from OpenCode's own database, cache resets, recall round-trips, duplicate
   tool calls, paging volume, distillation diet. No model calls.
2. **One cheap analysis, occasionally.** After a few sessions of new
   experience (default 4, ≥3 turns each) and at most once per ~20 hours, one
   model call (`selflearnModel`, default: your session's model — free on
   `opencode`-tier models) may propose **one numeric knob change** — inside a
   hard clamp table, at most 35% per step. Prompts, routing, algorithms and
   code are structurally out of reach.
3. **Apply provisionally, then verify by replay.** The change takes effect
   immediately. After a grace window (24h of live signals), the real
   compression pipeline (`bench/replay.mjs`) is run twice over a fixed
   transcript — baseline knobs versus the proposal. Prompt bytes are a pure
   function of the transcript and the knobs, so the verdict is **exact, free
   and repeatable**: no model calls, no credits, no provider weather. Kept
   only if prompt tokens fall, every rewritten result keeps its recall
   handle, already-sent bytes stay byte-identical, the live user ask survives,
   and the knob stays within 35% of its documented default — otherwise it
   reverts. A recall storm while a change is provisional reverts it without
   waiting for any bench.
4. **Everything lands in `selftune/ledger.jsonl`** — proposals, applies,
   keeps, reverts, with reasons. `babyzilla selftune status` shows the state.

Disable the loop entirely with `"selfLearn": false` (telemetry keeps being
recorded) or freeze everything with `BABYZILLA_SELFTUNE_DISABLE=1`. Routine
verification is free; `babyzilla selftune verify --live` still runs the
dollar bench when you want task-quality evidence, and that one spends credits.

Why replay instead of the dollar bench: the live A/B measures cost, and on a
multi-turn agentic task that number is dominated by provider cache hits — the
first honest A/A run measured a **24.6% noise floor**, so no safe knob could
ever clear the gate. `bench/RESULTS.md` keeps those numbers; the replay
answers the question the knobs actually ask.

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
5. **Cache safety: credits, not just tokens.** Rewrites are a pure function of
   each part's own bytes — position-independent, monotone, byte-stable — so
   compressing at arrival never changes already-sent history, and the
   provider's prompt cache stays valid on later requests (`stablePrefix`, 2K
   size gate). A rewrite that would save less than 12% of the request
   (`requestMinSavingsPct`), or that would push it over the model window, is
   rolled back rather than buying a few tokens with a full-price cache miss.
   No compaction is required for any of this — which is what makes it work on
   1M-token models.
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
   context stays available *without staying in the window*. With
   `carryIn: true`, a new session's **first prompt** additionally carries the
   project library's hot modules over trigger-free (once per session, labeled
   `[carry-in]`) — the next session starts where the last one left off.
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
- [`bench/RESULTS.md`](bench/RESULTS.md) — live plugin-vs-plugin A/B results,
  including the cache-reset and noise-floor findings that shaped v0.10.
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
  database, no embeddings, no proxy, no daemon. The only network calls it
  makes are model calls to the provider you already configured: the
  compaction distillation, and — unless you set `selfLearn: false` — the
  occasional self-tuning analysis (a compact summary of recorded statistics,
  never transcripts).
- Distillation sends transcript text to your configured model provider.
  Journals, module files, `selftune/` telemetry and stats stay on disk in
  `~/.opencode/contextpacks/` — delete anytime (`babyzilla prune` or
  `rm -rf`).

## Status

Tested on OpenCode v2.0.29 (macOS). The test suite runs in CI on macOS, Linux
and Windows (Node 18, 20, 22). Layer 2 needs the optional `lowfat` binary and
is skipped when absent. If you try it, please open an issue with your version
and savings numbers — they go into the table above.
