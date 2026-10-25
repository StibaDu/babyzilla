# Live A/B: BabyZilla ON vs OFF

Harness: `bench/ab-live.mjs`. Model `ollama-cloud/deepseek-v4.1-flash:1017`,
`opencode run --standalone=true --auto`, one isolated project per leg.

- OFF leg: private `XDG_CONFIG_HOME` with the `plugin` entry removed.
- ON leg: the real config (optionally with injected overrides via `--budget` / `--ratio`).
- Isolation is asserted per run: plugin log lines OFF = 0, ON > 0.
- Leg order alternates per rep so provider drift cannot look like a plugin effect.
- Cost is measured from OpenCode's own per-request records (`session_message`),
  not from the plugin's price table, so the accounting is the host's.

```
node bench/ab-live.mjs --files 10 --kb 14 --reps 6    # comparison
node bench/ab-live.mjs --files 10 --kb 14 --reps 6 --aa 1   # A/A noise floor
```

## Noise floor first (A/A, 6 reps, both legs plugin-free)

| | OFF | "ON" | delta |
|---|---|---|---|
| prompt tokens | 474.8K | 465.7K | −1.9% |
| cost | $0.0211 | $0.0211 | **−0.1%** |

Identical-config legs land within ~2%. Anything inside ±2% is not an effect.

## Result (6 reps each, 11/12 legs completed the task in both arms)

| metric | OFF | ON | delta |
|---|---|---|---|
| requests | 11 | 11 | 0 |
| prompt tokens | 475.7K | 241.2K | −49.3% |
| of which cached | 336.2K | 127.3K | −62.2% |
| uncached input | 138.1K | 125.9K | −8.8% |
| output tokens | 950 | 3.3K | +250% |
| peak request ctx | 75.3K | 33.3K | −55.8% |
| **cost** | **$0.0226** | **$0.0222** | **−1.6%** |

Per-rep cost (−15%, −5%, —, −17%, **+53%**, **+20%**).

## What this means

**Dollars: cost-neutral.** −1.6% sits on the A/A floor. Compression removes mostly
*cached* prefix, which OpenCode bills at ~2% of the input rate; the tier that
actually costs money (uncached input) only moves −8.8%.

**Context: the real win.** −55.8% peak request size. That is headroom, not cash:
it is what lets a 64K-window model finish a task the baseline would overflow.

**The tail is `recall`, not waste.** In the two expensive reps the model pulled
paged-out text back with 5–6 `babyzilla recall <id>` calls (15–16 turns vs 11).
That is the documented contract working — pay for the bytes you actually ask
back, instead of holding all of them from the start. On a task whose answer
needs *every* byte, cost therefore converges to the baseline; the plugin cannot
be cheaper than not-compressing when nothing can be forgotten.

**Where savings should show up:** long multi-turn sessions where most early
context is never needed again. The 10-file survey forces the model to consult
everything, which is the worst case for this design — worth measuring a
"read once, then 20 follow-ups" shape next.

## Bugs found and fixed by this harness

1. `prompt hook failed (non-fatal): null is not an object (evaluating 'idx.modules')`
   — the prompt hook threw on every call in any session with no index and no
   project library (headless `opencode run`, cold dir). Guarded in `index.js`;
   regression test `test/plugin-noindex.test.mjs`. 168/168 tests pass.
2. Earlier "+4.3% more expensive" reading was inflated by that crash plus
   unpaired noisy reps; the A/A control replaced that estimate.

## Caveats

- One workload, one model, one provider's cache pricing (2% cached reads).
  A provider with no prefix caching would show very different numbers.
- 6 reps; per-rep spread is $0.013–$0.034, so only the medians are meaningful.

## In Ollama's own meter (the question that matters)

Ollama returns two prompt fields per call — verified live against
`POST https://ollama.com/api/chat`:

- `prompt_eval_count` — total prompt tokens
- `prompt_eval_cached_count` — the subset served from cache (98.6% on a
  repeated 9.1K prompt, so caching is real and aggressive)

Pricing is `input / cached input / output` = `$0.30 / $0.006 / $1.20` per 1M
(off-peak halves all three; these runs billed off-peak). **Usage credits are
price-weighted, not raw tokens.**

Per-rep, task completed (r3 excluded — OFF bailed after 1 step):

```
off r1 prompt=403K (71% cached) uncached=113K out=1349 $0.0187
on  r1 prompt=215K (49% cached) uncached=108K out= 848 $0.0170
off r2 prompt=399K (74%) uncached=102K out= 703 $0.0166
on  r2 prompt=215K (42%) uncached=123K out=1366 $0.0195
off r4 prompt=400K (75%) uncached=100K out= 744 $0.0164
on  r4 prompt=220K (52%) uncached=105K out= 882 $0.0166
off r5 prompt=400K (67%) uncached=130K out= 758 $0.0208
on  r5 prompt=317K (48%) uncached=162K out=10814 $0.0313
off r6 prompt=401K (67%) uncached=130K out=1062 $0.0209
on  r6 prompt=351K (55%) uncached=157K out= 3130 $0.0261
```

| metric | OFF | ON | delta |
|---|---|---|---|
| total prompt tokens | 400.4K | 220.0K | **−45.1%** |
| cached share | 71% | 49% | −22 pts |
| uncached input | 113.4K | 122.8K | **+8.3%** |
| output tokens | 758 | 1366 | **+80%** |
| credits | $0.0187 | $0.0195 | **+4.3%** |

**Raw tokens −45%. Usage credits +4%.** Both true; only the second is what the
Ollama dashboard charges.

Compaction runs at *request time*, rewriting the message prefix. The prompt
roughly halves, but the surviving half stops being a cache hit (71% → 49%), so
tokens shift from the 2%-price tier into the 100%-price tier. Recovery turns
add output at the $1.20 tier on top.

### Fix this implies (not implemented)

Cache is prefix-based, so the prefix must never be rewritten. Compressing a
tool result **once when it arrives** (before its first send) rather than on
every request keeps the prefix byte-stable. Projected with cache share held at
OFF's 71% on the halved prompt (64K uncached / 156K cached / 758 out):

    $0.0096 + $0.0005 + $0.0005 ≈ $0.0105   ≈ −44% vs OFF
