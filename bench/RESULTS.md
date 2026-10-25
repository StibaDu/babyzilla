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

## After the fix: prefix-stable compression (same harness, 10×24KB, 6 reps)

`stablePrefix` (now default) decides from each part's own bytes and never
rewrites an already-sent prefix. Same fixture, same model, same noise floor.

| metric | OFF | ON | delta |
|---|---|---|---|
| prompt tokens | 717.7K | 358.6K | **−50.0%** |
| uncached input | 191.0K | 100.2K | **−47.6%** |
| peak request ctx | 119.2K | 59.8K | −49.9% |
| output tokens | 1.3K | 1.7K | +31% |
| **credits** | **$0.0310** | **$0.0166** | **−46.6%** |
| task completed | 6/6 | 6/6 | — |

Per-rep credits: `$0.0208→$0.0191`, `$0.0278→$0.0161`, `$0.0352→$0.0155`,
`$0.0268→$0.0170`, `$0.0342→$0.0160`, `$0.0364→$0.0170` — **6/6 reps cheaper**,
and the ON spread ($0.0155–0.0191) is far tighter than OFF's ($0.0208–$0.0364)
because cache hits stop depending on luck.

That is the whole point of the change: the same token cut as before (−50%),
but it now lands in the cheap tier instead of destroying the cache.

## Two bugs found on the way

- `compressToolResult` never rewrote persisted parts: `slots === event.state`
  compared an array to an object, so `state.output` was dead code.
- `ctx.session.context()` returns a **copy** — mutating tool parts from
  `execute.after` never reaches the wire (compression logged 6.4K→2.5K while
  the request stayed raw). The honoured hook is `session.hook("context")`,
  which is where the stable rewrite now lives.

## Cost levers on top of stable compression (10×24KB prose, 6 reps)

Levers: character-window/folding compressor, `stableMinTokens` 4000→2000,
distill cap 48K→16K (`distillBudgetDefault`). Same fixture, alternating legs.

| metric | OFF | ON | delta |
|---|---|---|---|
| prompt tokens | 715.8K | 349.5K | **−51.2%** |
| uncached input | 164.9K | 71.8K | **−56.5%** |
| peak request ctx | 119.0K | 51.1K | −57.1% |
| **credits** | **$0.0271** | **$0.0129** | **−52.4%** |
| task completed | 5/6 | 5/6 | — |

Clean paired reps (11 steps, marker found in both arms):

- r1 `$0.0338 → $0.0158`, r4 `$0.0205 → $0.0157`, r5 `$0.0359 → $0.0101`,
  r6 `$0.0336 → $0.0163` — mean ≈ **−50%**, on top of the previous run's
  identical −46.6% (r2/r3 this run are one-armed task bailouts and are
  excluded from conditioning).

Caveats recorded so the numbers cannot be over-read:

- rerun variance: OFF's own median moved $0.0310 → $0.0271 between runs of
  the same fixture; per-rep pairwise legs are the only fair comparison.
- `cache resets` / `wasted on resets` rows (new) attribute provider-side
  prefix evictions; the big 30–55K uncached spikes of the stable3 run are
  evictions, not rewrites — byte-stability of the prefix was verified above.

## Invalid instrument: the dump fixture

`--dump 1` (10×24KB single-line JSON) is **not usable as a cost benchmark**:
OpenCode's `read` tool truncates a single line to its first 2000 characters
(model-visible, both arms), so the file bodies never reach the 2000-token
compression gate — the context hook was correctly silent, and the buried
marker sits past byte 2000 in every arm (7/8 marker MISS). Dump-shaped
compression is covered by unit tests (`test/cheap.test.mjs`) and by live
evidence (`193.4K → 189.9K` → now a ~99% cut, per the pipeline check run
against the actual fixture bytes: `6258 → 87 tok`).

## Verification bench (plugin-vs-plugin)

`babyzilla selftune noise` runs the same harness with the plugin on **both**
legs and no overrides, so every delta it finds is instrument noise. It is the
gate the self-tuner must clear before keeping a knob.

First honest measurement (4 reps, 2026-10-25): **24.57% → floor 37.36%**, from
three marker-complete, work-matched reps.

Two failed runs before that, both kept as regression tests:

- **Aborted leg scored as data.** One leg died after 2 requests (provider
  abort) while its pair completed; comparing their costs reported 44.09%
  "noise". A leg without the task marker now never contributes.
- **One surviving leg order.** With identical fixtures the second leg of a
  pair reads the first leg's prompt cache — 96K → 52K uncached input in a
  complete pair — so a run that loses one order reports ~40% "savings" that
  are pure warm-up. The estimate is now the mean of per-order means, and a
  run needs both orders (`off>on` and `on>off`); the noise bench defaults to
  4 reps for that reason.

Why the floor is large: cost here is dominated by **uncached input**, whose
share depends on provider cache hits and on which tool calls the model chose
that turn (11 requests per leg, output 1.2K–3.1K). Legs with identical configs
ranged $0.0086–$0.0166. That is the honest resolution of this bench shape; a
knob whose effect is smaller than that cannot be distinguished from cache
weather, so it is reverted rather than kept on faith.
