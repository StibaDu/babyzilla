# Options

BabyZilla needs no options to work — defaults are good. Set object-form
options in `opencode.json(c)` (they reach the plugin via `ctx.options` and
hot-reload on config change):

```jsonc
{
  "plugins": [
    "babyzilla",                                   // Method A already does this
    {
      "package": "babyzilla",
      "options": {
        "distillModel": null,
        "distillVia": "auto",
        "requestCompression": true,
        "requestBudgetTokens": 45000,
        "requestTargetRatio": 0.08,
        "requestMinBudgetTokens": 12000,
        "requestMaxPromptRatio": 0.5,
        "requestProtectTurns": true,
        "requestTurnProtectTokens": 40000,
        "requestMinSavingsPct": 12,
        "requestLedger": true,
        "requestLedgerKeepTokens": 8000,
        "requestLedgerKeepRecent": 5,
        "requestLedgerMinTokens": 60,
        "requestCompressUserBulk": true,
        "requestUserBulkMinTokens": 32000,
        "requestUserKeepTokens": 4000,
        "requestContract": true,
        "distillAnchors": true,
        "distillRecovered": true,
        "evalMaxChars": 400000,
        "distillBudgetTokens": 0,
        "toolResultCompression": true,
        "toolResultEagerMinTokens": 8000,
        "toolResultProtectRecent": 3,
        "toolResultProtectTurn": true,
        "proactiveCompactRatio": 0.35,
        "proactiveCompactMinTokens": 120000,
        "maxAttach": 2,
        "attachBudgetTokens": 6000,
        "library": true,
        "carryIn": true,
        "minRawTokens": 4000
      }
    }
  ]
}
```

(If both entries exist, the object one wins for options; the plugin loads
once.)

| Option | Default | Notes |
| --- | --- | --- |
| `toolCompression` | `true` | Layer 2 — rewrite shell commands through the `lowfat` binary before execution (`lowfat` by zdk, bundled integration). Needs the binary; without it the layer is skipped. |
| `requestCompression` | `true` | Layer 1b — the `session.hook("context")` rewrite. In the default `stablePrefix` mode it applies content-addressed compression; with `stablePrefix: false` it enforces a hard per-request token budget. This runs on **every** request, including models whose 1M-token window means native compaction never fires (Kimi K3). Disable only if you want to see the raw history. |
| `stablePrefix` | `true` | Compress each tool result **by its own content**, at the moment the request is built, and never revisit the decision. Because the choice depends only on a part's bytes (and the replacement is a content-hash function of them), an already-sent prefix serialises identically on every later request, so the provider's prompt cache keeps hitting. With position/budget-based rewriting the prefix changed each request and cached input was re-billed at full price — measured on Ollama Cloud: −45% tokens but **+4% credits**. Stable mode measured **−47% credits**. Set `false` to restore the old budget-driven rewriting. |
| `stableMinTokens` | `4000` | Size gate for `stablePrefix`. Results below this stay verbatim: those are the ones an agent acts on immediately, and paging them out buys a recall round-trip. Defaults to `toolResultMinTokens` when unset. |
| `stableOverflowRatio` | `0.9` | In stable mode the budget pass becomes an overflow valve: it only rewrites history when the prompt exceeds this share of the model window. A cache miss is worth paying once to avoid a hard context failure. |
| `requestBudgetTokens` | `45000` | Hard max estimated tokens for the outgoing message list (system prompt and tool definitions excluded). Clamped to `requestMaxPromptRatio × model context window`, so a small local model never receives more than it can hold. Lower = more savings, less raw history. |
| `requestTargetRatio` | `0.08` | Aim to keep this fraction of the incoming context (0 = disabled). A 160K-token request is cut to ~13K (>90% smaller); the hard cap wins for 1M-token windows. Set to `0` to only enforce `requestBudgetTokens`. |
| `requestMinBudgetTokens` | `12000` | Floor for the ratio target — never compress a request below this just because the ratio says so. |
| `requestMinTokens` | `20000` | Never apply Layer 1b below this estimated size, even if the budget is smaller. |
| `requestMaxPromptRatio` | `0.5` | Ceiling on one request as a fraction of the model's context window. The window comes from OpenCode's model metadata, so an 8K local model gets ~4K of messages while a 1M model keeps the 45K cap. System prompt and tool schemas are not counted, hence the headroom. |
| `distillBudgetTokens` | `0` | Transcript tokens fed to the distiller. `0` derives it from the model window (40%, capped at 48K); set a number when `distillModel` points at a small-window model. |
| `requestProtectRecent` | `6` | Newest N messages always sent verbatim. |
| `requestProtectTurns` | `true` | Also protect the current user turn's working set: an agentic turn can contain hundreds of tool results, so a message count of 6 covers only a few. |
| `requestTurnProtectTokens` | `40000` | How many tokens of the current turn stay verbatim (capped by the request budget, so small windows still compress). |
| `requestMinSavingsPct` | `12` | Skip a rewrite that saves less than this share of the request. A 2% pass still invalidates the provider's prompt cache and changes what the agent sees; below this threshold nothing is rewritten. |
| `distillAnchors` | `true` | Always keep the last user request and the reply it answers verbatim in the pack, as `00-anchors.md`. Built from the messages, never by the model, so a compaction cannot drop the question the next turn answers. Set to `false` to let the distiller decide. |
| `distillRecovered` | `true` | After the pack is assembled, compare it against the transcript and append a short `00-recovered.md` for facts and `path:line` pointers the distiller left out. Costs one scan of the transcript (skipped above `evalMaxChars`). |
| `evalMaxChars` | `400000` | Longest transcript scanned for `distillRecovered`. Above this the scan is skipped: a multi-MB history costs more to score than the recovered module saves. |
| `requestContract` | `true` | Send the one-time compression contract note (what is paged, what stays verbatim, how `babyzilla recall` works) when a session first compresses. |
| `requestHardProtect` | `2` | If the protected tail alone exceeds the budget, compress it oldest-first but always keep these final N messages. |
| `requestPartMinTokens` | `800` | Parts below this size are not worth rewriting. |
| `requestElideMinTokens` | `200` | In the hard-budget phase, parts are paged down to a pointer once they exceed this size; the page is recoverable via `babyzilla recall`. Lower means closer to the budget, higher means fewer, larger pages. |
| `requestLedger` | `true` | Layer 3. Old tool steps collapse to one deterministic row built from the call itself (`#12 · bash · npm test · exit 1 · 3.1K tok · recall …`). No model call, no drift; the transcript stays an index of what was tried. |
| `requestLedgerKeepTokens` | `8000` | Newest tool results (by tokens) that are never turned into rows. Token-based on purpose: 20 huge reads are still 250K tokens. |
| `requestLedgerKeepRecent` | `5` | Count floor for the same protection, so a few small results always stay verbatim. |
| `requestLedgerMinTokens` | `60` | Results below this size are left alone. |
| `requestCompressUserBulk` | `true` | Condense a *historical* user message above `requestUserBulkMinTokens`: keep its opening, constraint lines and closing, page the rest. The live user message is never touched. |
| `requestUserBulkMinTokens` | `32000` | Threshold for the above. Real instructions are far smaller; harness checkpoints and pasted logs are far larger. |
| `requestUserKeepTokens` | `4000` | Budget for lines that read like constraints (`never`, `always`, `must`, `only`, …) kept verbatim from a condensed user message. |
| `requestElideAttachments` | `true` | Replace old image/file parts with a one-line placeholder (re-attach if needed). |
| `requestElideReasoning` | `true` | Blank old reasoning text. Signed/encrypted reasoning blocks are never touched. |
| `toolResultCompression` | `true` | Layer 2b — compress large `read` / `grep` / `glob` results **at the source**, before they are persisted and resent on every later turn. Keeps the head, the tail, and every structural or diagnostic line; line numbers stay intact so exact ranges remain readable. |
| `toolResultMinTokens` | `4000` | Only tool results above this estimated token count are compressed. Small reads are kept verbatim: compressing them costs more in re-reads than it saves. |
| `toolResultEagerMinTokens` | `8000` | Layer 2b — when no tool allowlist is configured (or for tools outside it), any single tool result whose estimated tokens exceed this is compressed at the source, whatever tool produced it: `shell` / `execute` / MCP tools included. The result is paged through `babyzilla recall`, never deleted. `0` restores the fixed tool-name allowlist. Small results stay inline — the median tool output is far under this. |
| `toolResultHeadLines` | `40` | Verbatim lines kept from the start of a compressed tool result. |
| `toolResultTailLines` | `20` | Verbatim lines kept from the end of a compressed tool result. |
| `toolResultProtectRecent` | `3` | Number of most-recent tool results kept **verbatim**. Compression applies to older results only, so the agent keeps working from the content it just fetched instead of re-reading it. |
| `toolResultProtectTurn` | `true` | Never compress results from the current user turn; they become eligible on the next turn. |
| `distillModel` | `null` | `null` = use the session's model. Set `{"providerID":"…","id":"…"}` to pin a specific distiller (recommend a cheap, instruction-reliable model — distillation is a summarization task, not an agentic one). |
| `distillVia` | `"auto"` | How the distillation call is routed. `"auto"` tries the session-less call first and falls back to the session-scoped call when a provider rejects it; when the model's provider is `opencode` (free tier) it starts with the session-scoped call, since the session-less route is always rejected there. `"session"` tries the session-scoped call first. `"text"` keeps the strict legacy behaviour (session-less only, no fallback). |
| `maxAttach` | `2` | Max cold modules auto-attached to one prompt. Raise to 3–4 if you often jump between topics. |
| `attachBudgetTokens` | `6000` | Total estimated-token budget for auto-attached modules per prompt. |
| `library` | `true` | Promote carry kinds (state, decisions, tool, errors) to the cross-session project library. |
| `carryIn` | `false` | Opt-in. On a session's first prompt, attach the project library's hot modules (state, decisions) trigger-free, labeled `[carry-in]`, once per session. |
| `visionRoute` | `true` | Layer 0.5 — when a prompt involves image content (file attachments, concrete image paths, or screenshot wording), send a one-shot synthetic note telling the main model to delegate to the vision subagent with the exact readable paths. Text-only main models see a placeholder instead of the pixels, so routing has to happen before the request. Never routes when the prompt already names the delegate itself. Set `false` to disable. |
| `visionAgent` | `"vision"` | Subagent ID the vision note delegates to. Must exist as a subagent profile (e.g. `~/.config/opencode/agents/vision.md` pinned to a vision-capable model); when the agent catalog is readable and the ID is absent, no note is sent. |
| `minRawTokens` | `4000` | Below this, skip custom distillation and let native compaction run. |
| `proactiveCompaction` | `true` | Layer 1c — ask OpenCode to compact when the context reaches `max(proactiveCompactMinTokens, proactiveCompactRatio × model context window)`. On 1M-token models OpenCode's own threshold is so high that it effectively never fires, so sessions grow unbounded. Set to `false` to let OpenCode decide. |
| `proactiveCompactAtTurnBoundary` | `true` | Only request a proactive compaction when the request starts with a user message. Compacting mid-tool-loop replaces the working set the agent is still using. |
| `proactiveCompactRatio` | `0.35` | Fraction of the model's context window that triggers a proactive compaction. `0.35` compacts a 1M-token Kimi K3 session at ~367K; `0` disables by ratio (the floor still applies). |
| `proactiveCompactMinTokens` | `120000` | Absolute floor for proactive compaction, so small-window models are untouched. |
| `proactiveCompactCooldownMs` | `600000` | Minimum gap between two proactive compactions for the same session. Prevents a `/compact` on every step if a compaction produces little reduction. |

## Environment

| Variable | Default | Notes |
| --- | --- | --- |
| `BABYZILLA_ROOT` | `~/.opencode/contextpacks` | Data root for the CLI (`babyzilla show/stats/…`). The plugin itself always uses the default. |

## Changing options safely

Options hot-reload when config changes. After changing, confirm the plugin
logged its new options:

```sh
tail -1 ~/.opencode/contextpacks/debug.log   # → plugin ready (options: {...})
```