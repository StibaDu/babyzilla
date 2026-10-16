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
| `distillModel` | `null` | `null` = use the session's model. Set `{"providerID":"…","id":"…"}` to pin a specific distiller (recommend a cheap, instruction-reliable model — distillation is a summarization task, not an agentic one). |
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