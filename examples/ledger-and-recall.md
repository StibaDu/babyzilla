# Example: ledger rows + reversible recall

Layer 3 fires on *old* tool steps of a long session. Instead of a bare
head+tail (or a blind elision marker), each step becomes one deterministic
row built from the call itself: tool, target, exit status, size, and a recall
handle.

Nothing here is invented by a model — every field comes from the tool call and
its result metadata, so the row is safe to trust as an *index* of what was
already tried.

## Measured on a real request

Fixture shaped exactly like OpenCode v2's wire format (assistant `tool-call`
parts + `tool` messages carrying `tool-result` parts), 6 old steps plus the
current one, no model involved:

```
before: 10 010 tok   after: 1 822 tok   saved: 82%   17 messages
```

## What the old steps look like afterwards

```
[ContextPack] #2 · read · src/importer.js · ok · 1.8K tok · recall 1265788f853782f3
[ContextPack] #3 · bash · npm test · exit 1 · 3.1K tok · recall 8c1f0b7a9d2e4c15
[ContextPack] #4 · read · test/parser.test.mjs · ok · 2.4K tok · recall c0a91e5b74f2d318
[ContextPack] #5 · edit · lib/parser.mjs · ok · 1.2K tok · recall 4d7f3e2b90ac5611
```

Read that back and you know exactly where you were: *read the importer, ran the
suite and it failed, read the test, patched the parser*. That is the working
memory a long session actually needs, and it costs ~25 tokens per step instead
of thousands.

## Getting the content back

The handle is a content hash of the exact original bytes:

```sh
babyzilla recall 8c1f0b7a9d2e4c15          # the full `npm test` output
babyzilla recall 8c1f0b7a9d2e4c15:40-80     # just the failing assertions
```

```
$ babyzilla recall 8c1f0b7a9d2e4c15:1-6
# tests 41
# pass 39
# fail 2
not ok 12 - parses nested headers
not ok 17 - keeps CRLF endings
```

Paging, not deletion: the bytes live in
`~/.opencode/contextpacks/pages/<2 hex>/<hash>.txt` and are printed byte for
byte. `babyzilla show <hash>` renders a stored pack, `babyzilla verify` checks
the store.

## What is never ledgered

* the current user turn, in full;
* the newest messages (positional tail) and the newest result per file or
  command — the thing you are about to edit against;
* anything smaller than `requestPartMinTokens` (default 800): it is already
  cheap, and a row would not pay for itself;
* error-bearing results of the *last* turn if they are still in the protected
  window.

The ledger only collapses steps older than the working set, which is exactly
the part a model would otherwise re-read out of habit.

## Tuning

| Option | Default | Meaning |
| --- | --- | --- |
| `requestLedger` | `true` | Emit ledger rows for old tool steps. |
| `requestLedgerKeepRecent` | `5` | Newest N tool results are never ledgered. |
| `requestLedgerKeepTokens` | `8000` | …and never the newest N tokens either. |

Turn the ledger off and Layer 2's head+tail (plus elision markers) takes over:

```json
{ "requestLedger": false }
```

See [../docs/OPTIONS.md](../docs/OPTIONS.md) for every knob.
