# How BabyZilla works

OpenCode v2 gives plugins a hook on compaction and another on every outgoing
request. BabyZilla registers four hooks and one command, and owns zero
OpenCode state — everything lives in `~/.opencode/contextpacks/`.

## The hooks

### 0. `session.hook("context")` — hard per-request budget (Layer 1b)

Layer 1 only runs when OpenCode decides to compact. A model with a 1M-token
window (Kimi K3) may never reach that point, so without this layer the plugin
would have *zero effect* on exactly the long sessions where it matters most.

The `context` hook receives the exact `messages` array about to be sent.
BabyZilla:

1. Estimates the message tokens (`chars / 4`).
2. If the list exceeds the budget — `requestTargetRatio` (8%) of the incoming
   context, floored at `requestMinBudgetTokens` (12K) and capped at
   `requestBudgetTokens` (45K) — compresses, in place, old tool results
   (`result.value` / `output.value` / `state.content`), old assistant text, old
   reasoning (never signed/encrypted) and old image/file attachments.
3. If the request is still over budget, the oldest parts are replaced with
   one-line pointers. Every pointer carries a `babyzilla recall <hash>` handle:
   the exact bytes are in the page store (`~/.opencode/contextpacks/pages/`),
   so paging is reversible for **every** tool, including shell output that
   cannot be re-read from a file.
4. The newest `requestProtectRecent` messages, the newest
   `requestTurnProtectTokens` of the current user turn, the newest result per
   file/command, and every user turn stay verbatim. The protected working set
   is only structurally compressed (head + tail + structural lines) when the
   budget cannot otherwise be met — never blanked or reduced to pointers.
5. A rewrite that would save less than `requestMinSavingsPct` (12%) is rolled
   back, so near-no-op passes do not churn the prompt prefix or the model's
   view of the transcript.
6. Before a part is reduced to a pointer, it is turned into a **ledger row**
   (Layer 3) if it is an old tool step: `#12 · bash · npm test · exit 1 · 3.1K tok
   · recall 8c1f0b7a9d2e4c15`. Tool, target, status and size come from the call
   itself, so the row is a trustworthy index of what was already tried. The
   newest `requestLedgerKeepTokens` (8K) / `requestLedgerKeepRecent` (5) results
   are never ledgered.
7. A **historical** user message above `requestUserBulkMinTokens` (32K) is
   condensed to its opening, its constraint-shaped lines and its closing, plus
   a recall handle. The live user message is never touched — only bulk that a
   harness checkpoint or a pasted transcript left behind.

Every rewrite is idempotent (parts carrying `[ContextPack]` are skipped), and
a failure leaves the messages structurally valid. Measured on a 1.13M-token
Kimi-K3-shaped session: **1,129.6K → 44.9K tokens (96% smaller)**.

The same hook also keeps sessions from growing unbounded: once a request
exceeds `max(proactiveCompactMinTokens, proactiveCompactRatio × model window)`,
BabyZilla calls `ctx.session.compact({ sessionID })` itself (Layer 1c). Without
it, OpenCode waits for ~90% of the window — 900K+ on Kimi K3 — before Layer 1
ever gets a chance to run. Triggers are rate-limited per session
(`proactiveCompactCooldownMs`, 10 min) so a compaction that frees little cannot
loop.

### 1. `session.hook("compaction")` — replace the summary

When OpenCode compacts a session (automatic when the context fills, or manual
`/compact`), the hook receives the full transcript as provider-normalized
messages. Manual and free-tier compactions sometimes pass a single synthetic
message instead; BabyZilla then falls back to `ctx.session.context()` so the
distiller sees the real transcript. It then:

1. Estimates raw tokens (`text.length / 4`). Under `minRawTokens` (4000) it
   yields — native compaction is better than a big pack for small sessions.
2. Pre-trims the transcript to ~48K fed tokens: tool results cut to a 1600-char
   head (results are the bulk), keeping the most recent content intact.
3. Calls `ctx.generate.text` with the **session's model** (or `distillModel`
   if configured) asking for newline-delimited JSON modules — one JSON object
   per line, each self-contained:

   ```json
   {"kind":"state","name":"00-state","triggers":["..."],"content":"..."}
   ```

   JSONL (not one big JSON) is deliberate: truncated output drops only
   trailing lines instead of killing the whole parse. A tolerant line parser
   recovers valid lines from mixed output, with one stricter-instruction
   retry, then a legacy `{"modules":[...]}` fallback.
4. Writes the pack: `<kind>-<name>.md` files + `index.json` (stats, triggers,
   hot flags, `projectDir`) + metadata into OpenCode's compaction message.
5. Sets `event.result` with a compact inline summary (state + decisions
   inlined; cold modules listed by path). This is what the agent actually
   sees sitting at the top of its context.

**Hot/cold policy:** `state` + `decisions` are hot — always inlined into the
summary, never auto-attached (they're already there). `topic`/`code`/`tool` /
`errors` are cold — real files, attached only on trigger match.

**Safety:** every error path yields: no `event.result` → OpenCode runs native
compaction. The transcript is read-only. A result set by an earlier hook is
respected (yield); duplicate compaction events for one session are folded by
a per-session in-flight lock (120s TTL, ownership-tracked cleanup).

### 2. `session.hook("prompt")` — trigger-based module attach

On every user prompt admission, BabyZilla scans the prompt text against each
cold module's trigger words (from `index.json`), plus the cross-session
library for the project. Matching modules are attached as prompt files
(URI `file://…` references), capped by `maxAttach` and
`attachBudgetTokens`. The attached files appear to the agent just like
native prompt attachments.

### 3. `tool.hook("execute.after")` — the journal + tool-result compression

Every tool result appends one line to the session's `journal.jsonl`:
`{t, tool, status, tokens (est), head (≤1200 chars)}`. This is how savings
are quantifiable (`babyzilla stats`, `lowfat pack show`) and how big a session
got before compaction.

The same hook compresses large tool results (Layer 2b, below).

## Layer 2b — tool-result compression (`execute.after`)

Any single tool result whose estimated tokens exceed `toolResultEagerMinTokens`
(default 8000) is compressed at the source — whatever tool produced it:
`read`, `grep`, `glob`, `list`, `shell`, `execute`, MCP tools included — and is
paged through `babyzilla recall` (the original is never deleted), so every
later turn pays the smaller size. Results under the threshold stay inline for
free; `toolResultEagerMinTokens: 0` restores the fixed tool-name allowlist
(`read`, `grep`, `glob` and `list` above `toolResultMinTokens`). The rewrite
keeps a head, a tail, and every structural
(`import`/`export`/`class`/`def`/…), diagnostic (`ERROR`/`FATAL`/`panic`/…) and
`TODO` line; line numbers are preserved and elided spans are marked.

Compression is **deferred by one result**: `toolResultProtectRecent` (default
`1`) keeps the most recent result verbatim, because that is the content the
agent is actively working from. On the next tool call it becomes eligible.

`session.context({sessionID})` returns the live message objects, so the plugin
can compress older parts without touching the session history in the database.
The rewrite is idempotent: a part that already carries the ContextPack footer
is skipped.

## Layer 2 — `execute.before` hook (lowfat integration)

Adapted from the bundled lowfat v2 plugin ([zdk/lowfat](https://github.com/zdk/lowfat),
Apache-2.0). On every shell/bash tool call the plugin asks `lowfat rewrite`
to transform the command (`git` → `lowfat git`, `ls` → `lowfat ls`, piped
`| lowfat` markers are skipped). The rewritten command executes and its
compact output is what the transcript records — plus a row in lowfat's own
SQLite history backing `lowfat stats`.

The lowfat binary is discovered at plugin load: `PATH`, then
`~/.local/bin/lowfat`, `~/.cargo/bin/lowfat`, `/usr/local/bin/lowfat`. If it
is missing, layer 2 logs
`layer 2 skipped: lowfat binary not found` and everything else keeps working.
Install it per `AGENT-INSTALL.md` (release tarball — no Rust toolchain) or
build from source.

## Layer 3 — the turn ledger (`context`, before elision)

Layer 2b compresses a result *once*, at the source. But a 200-step session still
carries those results in every later request. Historically that was handled by
replacing them with a bare pointer, which costs the model its memory of what it
already did.

The ledger keeps the memory and drops the bytes. Each old tool step becomes one
deterministic row:

```
[ContextPack] #12 · bash · npm test · exit 1 · 3.1K tok · recall 8c1f0b7a9d2e4c15
```

Nothing is inferred: the tool name, target (`filePath` / `command` / `pattern`),
exit status, token size and recall handle all come from the call and its result
metadata. No model call, so no drift on every pass.

Rules:

* only steps older than the working set — the newest
  `requestLedgerKeepRecent` (5) results and the newest
  `requestLedgerKeepTokens` (8K) tokens are untouchable;
* nothing under `requestLedgerMinTokens` (60) is ledgered: a row would cost as
  much as the text;
* the newest result per file/command and the current user turn stay verbatim;
* `requestLedger: false` falls back to head+tail and plain pointers.

A row is an *index*, not content. Before editing, re-read the file — the handle
prints the exact original bytes:

```sh
babyzilla recall 8c1f0b7a9d2e4c15        # whole output
babyzilla recall 8c1f0b7a9d2e4c15:120-180 # a span
```

## Library promotion

Hot modules (`state`, `decisions`) plus cold `tool` and `errors` modules from
real project sessions are **promoted** to
`~/.opencode/contextpacks/library/<project-slug>/` and become attach
candidates in *future* sessions of the same project (e.g. "how we fixed the
ECONNRESET gateway bug" survives session death). The hot flag is preserved, so
with `carryIn: true` a new session's first prompt carries the project's hot
modules over trigger-free, labeled `[carry-in]`, at most once per session (a
`.carryin` stamp under `sessions/<sid>/` prevents repeats). Home-dir and
temp-dir sessions are skipped; promotions are add/merge-only; empty promotions
write nothing.

## Data layout

```
~/.opencode/contextpacks/
├── debug.log                        # plugin log (console.warn is unreliable)
├── sessions/<sessionID>/
│   ├── index.json                   # stats: rawTokens/packTokens/savedPct, module rows, projectDir
│   ├── 00-state.md                  # hot
│   ├── decisions-*.md               # hot
│   ├── topic-*.md / code-*.md       # cold
│   ├── errors-*.md / tool-*.md      # cold (+ library-promoted)
│   └── journal.jsonl
└── library/<project-slug>/          # cross-session modules: hot state/decisions
                                      # + cold tool/errors, carry-in source
```

## Why pointers-first matters

A standard summary says "fixed a bug in the retry logic". A BabyZilla module
says `src/util/retry.ts:40 — the backoff cap was wrong; fixed by <commit>`.
After compaction the agent can read the actual file instead of trusting a
paraphrase. `babyzilla verify` audits these pointers against the current
filesystem (resolving relative paths through projectDir → pack dir → cwd) so
you can see how much of a pack is still live.

## Known limitations

- Plugin load is lazy per location; a compaction firing immediately at load
  can be missed (benign — next compaction works).
- Distillation quality depends on the model; very weak models may produce
  thinner modules (still safe — worst case is fallback).
- Windows is untested.