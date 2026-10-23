# Scoring a pack: `babyzilla eval`

A pack is a lossy summary, so "did it work?" has an answer you can measure:
take the transcript the pack replaced, pull out the things a continuing agent
would need, and check whether the pack still contains them.

```sh
babyzilla eval                 # newest pack
babyzilla eval <session-id>    # a specific one
babyzilla eval --json          # machine-readable
```

## Real output

A 14-request session, 1.84M raw tokens distilled to a 4.2K-token pack:

```
  pack eval ses_f22c6416affex0OQSkSatVSeN2
  score 24/100 · facts 7/40 (18%) · pointers 3/60 (5%)
  last exchange LOST · 4189 tok (0% of 1842667)
  missing pointers: /Users/sebastian/Downloads/jlpt_n5_simulator.tsx, public/robots.txt, public/sitemap.xml
  missing facts: "Since the file can't be the problem, I removed the failure m" · "Live bytes are identical to local, structurally perfect: no " · "Sitemap could not be read" is actually a different, *more s…
  would append recovered.md (450 tok, 8 lines)
```

That pack is honest but mediocre — it was written by an earlier version that had
no anchors and no gap check. Two of the three findings are the ones users
notice: the last exchange is gone, and 3 of 60 `path:line` pointers the
transcript cited are missing.

## What is measured

| Probe | Where it comes from | Passes when |
| --- | --- | --- |
| facts | long assistant/user sentences in the transcript | ≥60% of the fact's word bigrams appear in the pack |
| pointers | every `path:line` the transcript cited | the pointer string is in the pack verbatim |
| last exchange | the newest user turn + the reply before it | ≥50% overlap for both |

`score = 85% quality + 15% budget`, where quality is
`0.5·factRecall + 0.3·pointerRecall + 0.2·questionKept` and the budget term
rewards staying under 15% of the raw tokens.

The bar is deliberately literal: a pointer the pack dropped is one the agent
will have to re-discover with a `grep`, and a fact it reworded into vagueness
is one it can no longer act on. A pack is not graded on prose quality.

## Two modules the model does not write

Both close gaps the eval finds.

`00-anchors.md` is built from the messages, not by the model: the last request,
the request before it, the reply that answered it, and the names of the tools
used in that reply (never their output). 66 tokens on a real turn, and the
question being answered survives every swap:

```
### The request this pack continues (verbatim)
great, all 3

### The reply it answers (verbatim)
Short answer: no — as code it's the wrong shape for babyzilla…
```

`00-recovered.md` is the eval run at compaction time: if the model's modules
miss pointers or facts that the transcript had, they are appended verbatim to a
hot state module. If nothing is missing, no module is written — the 450-token
append above is the cost, not a constant.

Both are *hot* (always inlined) and both are skipped when the transcript is
larger than 400 000 characters to score, since the scan would cost more than it
recovers.

## Why this and not an embedding index

Vector retrieval answers "which documents are relevant to this query", which
needs a model, a store, and a network call on every request. A pack has to be
built once, locally, deterministically, and be exactly reproducible — the same
transcript must give the same pack. Probes do that; embeddings do not.
