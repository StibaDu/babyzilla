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
        "requestTargetRatio": 0.1,
        "requestMinBudgetTokens": 12000,
        "requestMaxPromptRatio": 0.5,
        "distillBudgetTokens": 0,
        "toolResultCompression": true,
        "toolResultProtectRecent": 1,
        "proactiveCompactRatio": 0.35,
        "proactiveCompactMinTokens": 120000,
        "maxAttach": 2,
        "attachBudgetTokens": 6000,
        "library": true,
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
| `requestCompression` | `true` | Layer 1b — enforce a hard per-request token budget via OpenCode's `session.hook("context")`. This runs on **every** request, including models whose 1M-token window means native compaction never fires (Kimi K3). Disable only if you want to see the raw history. |
| `requestBudgetTokens` | `45000` | Hard max estimated tokens for the outgoing message list (system prompt and tool definitions excluded). Clamped to `requestMaxPromptRatio × model context window`, so a small local model never receives more than it can hold. Lower = more savings, less raw history. |
| `requestTargetRatio` | `0.1` | Aim to keep this fraction of the incoming context (0 = disabled). A 160K-token request is cut to ~16K (90% smaller); the hard cap wins for 1M-token windows. Set to `0` to only enforce `requestBudgetTokens`. |
| `requestMinBudgetTokens` | `12000` | Floor for the ratio target — never compress a request below this just because the ratio says so. |
| `requestMinTokens` | `20000` | Never apply Layer 1b below this estimated size, even if the budget is smaller. |
| `requestMaxPromptRatio` | `0.5` | Ceiling on one request as a fraction of the model's context window. The window comes from OpenCode's model metadata, so an 8K local model gets ~4K of messages while a 1M model keeps the 45K cap. System prompt and tool schemas are not counted, hence the headroom. |
| `distillBudgetTokens` | `0` | Transcript tokens fed to the distiller. `0` derives it from the model window (40%, capped at 48K); set a number when `distillModel` points at a small-window model. |
| `requestProtectRecent` | `6` | Newest N messages always sent verbatim. |
| `requestHardProtect` | `1` | If the protected tail alone exceeds the budget, compress it oldest-first but always keep these final N messages. |
| `requestPartMinTokens` | `800` | Parts below this size are not worth rewriting. |
| `requestElideAttachments` | `true` | Replace old image/file parts with a one-line placeholder (re-attach if needed). |
| `requestElideReasoning` | `true` | Blank old reasoning text. Signed/encrypted reasoning blocks are never touched. |
| `toolResultCompression` | `true` | Layer 2b — compress large `read` / `grep` / `glob` results **at the source**, before they are persisted and resent on every later turn. Keeps the head, the tail, and every structural or diagnostic line; line numbers stay intact so exact ranges remain readable. |
| `toolResultMinTokens` | `1200` | Only tool results above this estimated token count are compressed. |
| `toolResultHeadLines` | `40` | Verbatim lines kept from the start of a compressed tool result. |
| `toolResultTailLines` | `20` | Verbatim lines kept from the end of a compressed tool result. |
| `toolResultProtectRecent` | `1` | Number of most-recent tool results kept **verbatim**. Compression applies to older results only, so the agent keeps working from the content it just fetched instead of re-reading it. |
| `distillModel` | `null` | `null` = use the session's model. Set `{"providerID":"…","id":"…"}` to pin a specific distiller (recommend a cheap, instruction-reliable model — distillation is a summarization task, not an agentic one). |
| `distillVia` | `"auto"` | How the distillation call is routed. `"auto"` tries the session-less call first and falls back to the session-scoped call when a provider rejects it; when the model's provider is `opencode` (free tier) it starts with the session-scoped call, since the session-less route is always rejected there. `"session"` tries the session-scoped call first. `"text"` keeps the strict legacy behaviour (session-less only, no fallback). |
| `maxAttach` | `2` | Max cold modules auto-attached to one prompt. Raise to 3–4 if you often jump between topics. |
| `attachBudgetTokens` | `6000` | Total estimated-token budget for auto-attached modules per prompt. |
| `library` | `true` | Promote tool/errors modules to the cross-session project library. |
| `minRawTokens` | `4000` | Below this, skip custom distillation and let native compaction run. |
| `proactiveCompaction` | `true` | Layer 1c — ask OpenCode to compact when the context reaches `max(proactiveCompactMinTokens, proactiveCompactRatio × model context window)`. On 1M-token models OpenCode's own threshold is so high that it effectively never fires, so sessions grow unbounded. Set to `false` to let OpenCode decide. |
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