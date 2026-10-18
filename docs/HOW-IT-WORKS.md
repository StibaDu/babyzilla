# How BabyZilla works

OpenCode v2 gives plugins a hook on compaction. BabyZilla registers three
hooks and one command, and owns zero OpenCode state — everything lives in
`~/.opencode/contextpacks/`.

## The three hooks

### 1. `session.hook("compaction")` — replace the summary

When OpenCode compacts a session (automatic when the context fills, or manual
`/compact`), the hook receives the full transcript as provider-normalized
messages. BabyZilla then:

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

`read`, `grep`, `glob` and `list` results above `toolResultMinTokens` are
rewritten in place before they are persisted, so every later turn pays the
smaller size. The rewrite keeps a head, a tail, and every structural
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

## Library promotion

`tool` and `errors` modules from real project sessions are **promoted** to
`~/.opencode/contextpacks/library/<project-slug>/` and become attach
candidates in *future* sessions of the same project (e.g. "how we fixed the
ECONNRESET gateway bug" survives session death). Home-dir and temp-dir
sessions are skipped; promotions are add/merge-only; empty promotions write
nothing.

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
└── library/<project-slug>/          # cross-session cold modules
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