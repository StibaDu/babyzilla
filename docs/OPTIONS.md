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
        "toolResultCompression": true,
        "toolResultProtectRecent": 1,
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
| `toolResultCompression` | `true` | Layer 2b — compress large `read` / `grep` / `glob` results **at the source**, before they are persisted and resent on every later turn. Keeps the head, the tail, and every structural or diagnostic line; line numbers stay intact so exact ranges remain readable. |
| `toolResultMinTokens` | `1200` | Only tool results above this estimated token count are compressed. |
| `toolResultHeadLines` | `40` | Verbatim lines kept from the start of a compressed tool result. |
| `toolResultTailLines` | `20` | Verbatim lines kept from the end of a compressed tool result. |
| `toolResultProtectRecent` | `1` | Number of most-recent tool results kept **verbatim**. Compression applies to older results only, so the agent keeps working from the content it just fetched instead of re-reading it. |
| `distillModel` | `null` | `null` = use the session's model. Set `{"providerID":"…","id":"…"}` to pin a specific distiller (recommend a cheap, instruction-reliable model — distillation is a summarization task, not an agentic one). |
| `distillVia` | `"auto"` | How the distillation call is routed. `"auto"` tries the session-less call first (unchanged behaviour) and falls back to the session-scoped call when a provider rejects it — this is what makes **OpenCode's free tier** work. `"session"` tries the session-scoped call first. `"text"` keeps the strict legacy behaviour (session-less only, no fallback). |
| `maxAttach` | `2` | Max cold modules auto-attached to one prompt. Raise to 3–4 if you often jump between topics. |
| `attachBudgetTokens` | `6000` | Total estimated-token budget for auto-attached modules per prompt. |
| `library` | `true` | Promote tool/errors modules to the cross-session project library. |
| `minRawTokens` | `4000` | Below this, skip custom distillation and let native compaction run. |

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