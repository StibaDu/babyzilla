# ModelDB — what every Ollama Cloud model is for

BabyZilla's local knowledge base for **lane picking** on Ollama Cloud
(subscription models only — no local/downloadable tags are tracked).

- **Data**: [`lib/modeldb.json`](../lib/modeldb.json) — one entry per catalog id:
  caps, context, usage class, vendor facts, verified behaviors, use-for / avoid-for.
- **Code**: [`lib/modeldb.mjs`](../lib/modeldb.mjs) — loader, lane policies, catalog
  cross-check, CLI renderer.
- **Prices**: live in [`lib/cost.mjs`](../lib/cost.mjs) (`PRICES`) — the single source
  of truth for USD/1M [input, cachedInput, output]. ModelDB *never* duplicates numbers.
- **CLI**: `babyzilla models` (table) · `babyzilla models --lanes` (lane picks) ·
  `--json` (machine-readable).

Legend used everywhere below: **T**ext · **K**thinking · **G**tools · **V**ision.

## Lane policies (defaults in `LANES`, `lib/modeldb.mjs`)

| Lane | Standard | Budget | Premium |
|---|---|---|---|
| main (build agent) | glm-5.2 | **beam** (free) | kimi-k3 |
| flash (quick thinking) | glm-5.3-flash | nemotron-3-super (input-heavy) / nemotron-3-nano (output-heavy) | minimax-m3.1-flash |
| vision | gemma4:31b | glm-5.3-flash | kimi-k3 / muse-spark-open |
| distill (compression) | glm-5.3-flash | nemotron-3-super | glm-5.2 |
| decision (special API) | clef:27b | — | — |

Ranks **degrade gracefully** (`pickLanes`): when a preferred id is absent from the
host catalog, the next rank is chosen; when nothing fits, the lane resolves to
`null` with an explanatory `why`. `catalogCompat(db, ids)` flags both directions:
`missingInDB` (catalog has models the DB does not know — add them below) and
`notInCatalog` (DB knows models the host can't serve — trim ranks).

## The catalog, in plain language

*Grouped by what they are actually good at. Prices = $ in/out per 1M tokens.*

### Builders (main lane)

**beam** — Reflection. 501B total / 23B active MoE, 1M ctx, free with the plan.
Token-efficient agentic reasoning ("~3× fewer reasoning tokens" vendor claim),
SWE-Bench Verified 81.6 / Terminal Bench 80.1. **Smoke-verified 2026-10-25**:
text+tools+`tool_calls` shape clean on the OpenAI-compat path, 19.8K-token needle
retrieved in 1.6s, images rejected cleanly (HTTP 400). Watch-outs: reasoning tokens
count against any `max_tokens` cap; text-only; new and unproven in *our* workloads
(pending head-to-head vs glm-5.2).

**glm-5.2** — Z.ai, $1.40/$4.40, 1M, T K G. The proven long-horizon flagship and
the standing main-lane default in this setup. Not multimodal, High usage pricing.

**glm-5.3** — Z.ai, $1.40/$4.40, 1M, T K G. "Most capable open-weights for coding."
Same price as 5.2 — choose by proven-vs-newest preference.

**minimax-m3.1-flash** — $0.15/$0.60, 976K, T K G **V**. Agentic/coding/Computer-Use
at flash pricing, ~3× faster and −70% cost vs M3. The best value agentic upgrade
for mixed text+image loops after glm-5.3-flash.

**kimi-k3** — Moonshot, $3.00/$15.00, 1M, T K G **V**. "Most capable to date" of
the Kimi line, the most expensive model on the index. Reserve for the hardest
long-horizon multimodal agent jobs.

**muse-spark-open** — 816B/42B active, $1.25/$4.25, 1M, T K G **V**. Native
multimodal flagship for complex software engineering; premium lane.

**deepseek-v4-pro:0813** — $1.32/$3.96, 1M, T K G, no vision. Frontier MoE with
three reasoning modes — DeepSeek's top reasoning at ~¼ of kimi-k3's output price.

### Flash / cheap loops

**glm-5.3-flash** — $0.15/$0.50, 1M, T K G **V**. The utility knife: cheapest
thinking+tools combo on the index, *and* multimodal, *and* 1M context. Standard
flash, distill and vision-fallback pick.

**nemotron-3-super** — $0.015/$0.60, 256K, T K G. Cheapest *input* tokens with
thinking. Distillation on a budget = read much, write short.

**nemotron-3-nano:30b** — $0.06/$0.24, 256K, T K G. Cheapest *output* side of any
thinking model. Micro-tasks, routing, streaming.

**nemotron-3-ultra** — $0.10/$3.00, 256K, T K G. Cheap input, pricey output —
ideal for long-context agentic loops where the model mostly emits short tool calls.

### Vision

**gemma4:31b** — $0.14/$0.40, 256K, T K G **V** (audio is family-level). Only
general-purpose vision+tools chat model on cloud at review time. Image chain
**smoke-verified** (1px red PNG → "Red"). Vision-lane standard.

**minimax-m3.1-flash / glm-5.3-flash** — the multimodal flash fallbacks.
**kimi-k3 / muse-spark-open / kimi-k2.7-code** — premium vision reasoning,
vision+coding hybrid, etc.

### Special-purpose (do not misuse)

**clef:27b** — Cloudflare. Turns a *state + schema of typed questions* into
decisions. Non-autoregressive single pass, served via the `/v1/systemone` API
(≠ standard chat), 64K input cap, max 4 images × 4 MiB/16MP, billed per *input*
token only ($0.24). Caps are literally `[decision, vision]` — no tools, no
thinking. Never route general chat or agent loops here.

**mistral-large-3:675b** — $0.50/$1.50, 256K, T G **V** — **no thinking**. Fast
non-reasoning multimodal requests only.

### Legacy / deprecated

**minimax-m2** — superseded by m2.7/m3; no cloud price row. Repro only.
**gpt-oss:120b / :20b** — OpenAI's Aug-2025 open-weights (historic $0.15/$0.60 and
$0.07/$0.30 in cost.mjs) but **no longer on the cloud price index** (checked
2026-10-25). Treat as historic fallback; re-verify availability before relying.

## Maintenance — how to refresh this DB

1. `curl -s https://ollama.com/api/tags | jq '.models[] | {name, capabilities, modified_at}'`
   → ground truth for *which ids exist and their caps*.
2. `curl -s "https://r.jina.ai/https://ollama.com/search?c=cloud"` → one page with
   per-model blurb, usage class, $in/$out, context size, badges.
3. Add new ids to **both** `lib/modeldb.json` (facts) and `lib/cost.mjs` `PRICES`
   (numbers), update `fetched` in the JSON meta, bump nothing else.
4. Run `node --test test/modeldb.test.mjs` and `babyzilla models --lanes`.

Personal overrides (no upstream edit needed): `~/.config/babyzilla/modeldb.overrides.json`
— a `{ "<id>": { patch... } }` object merged on top of the shipped entries at load.
