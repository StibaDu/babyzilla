# Examples

Start with the one that matches what you are trying to understand.

| Example | Shows |
| --- | --- |
| [tool-result-compression.md](tool-result-compression.md) | Layer 2/2b: what a tool result looks like before and after head+tail + structural compaction, with line numbers preserved. |
| [ledger-and-recall.md](ledger-and-recall.md) | Layer 3: old steps become deterministic ledger rows (`#12 · bash · npm test · exit 1 · 3.1K tok · recall …`) and how to get the exact bytes back. |
| [real-pack/](real-pack/) | A pack captured from a live session, plus `babyzilla show` output. |
| [pack-eval.md](pack-eval.md) | `babyzilla eval`: score a pack against the transcript it replaced, plus the two modules the model never writes (`00-anchors.md`, `00-recovered.md`). |

Every example is reproducible: `npm test` covers the same behaviour the docs
describe (`test/text.test.mjs`, `test/real-shape.mjs`).

Want to measure your own? After a few turns:

```sh
babyzilla stats    # local: token savings per pack
babyzilla cost     # provider side: input, cache-read, cache-write, output
```
