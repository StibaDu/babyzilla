# Example — tool-result compression (Layer 2b)

Added in **v0.3.0**. Large `read`, `grep`, `glob` and `list` results are
compressed **at the source**, before they are persisted and resent on every
later turn.

## What is kept

- the first `toolResultHeadLines` lines (default **40**)
- the last `toolResultTailLines` lines (default **20**)
- every structural line (`import`, `export`, `class`, `def`, `function`,
  `interface`, `struct`, `const`, `@…`)
- every diagnostic line (`ERROR`, `FATAL`, `WARN`, `Exception`, `panic`,
  `ERR-…`, `AB-12`)
- every `TODO` / `FIXME` / `XXX` / `HACK` line

Everything else is replaced by an elision marker. **Line numbers are never
renumbered**, so an exact range can be fetched verbatim with
`read(offset, limit)`.

## Before

```
Read file /Users/me/project/src/parser.js, lines 1-120
1: import fs from "node:fs";
2:
3: export class Parser {
4:   constructor(opts) {
5:     this.opts = opts;
...
48:   tokenize(input) {
49:     const out = [];
50:     for (const ch of input) {
...
120: }
```

## After

```
Read file /Users/me/project/src/parser.js, lines 1-120
1: import fs from "node:fs";
2:
3: export class Parser {
4:   constructor(opts) {
5:     this.opts = opts;
...
[... 38 lines elided by ContextPack — not truncation ...]
48:   tokenize(input) {
49:     const out = [];
50:     for (const ch of input) {
...
[... 64 lines elided by ContextPack — not truncation ...]
120: }

[ContextPack] 1.9K → 0.6K tokens (68% smaller). Elided spans can be read verbatim with offset/limit.
```

## Measured

Real runs of the same session prompt (model `ollama-cloud/deepseek-v4.1-flash`,
identical files and tool calls):

| Round | Without Layer 2b | With Layer 2b |
| --- | ---: | ---: |
| read-only, 4 files | 257,175 tokens | **115,191** |
| constrained, 7 files | — | **46,516** |

## Options

```jsonc
{
  "plugins": [{
    "package": "babyzilla",
    "options": {
      "toolResultCompression": true,
      "toolResultMinTokens": 1200,
      "toolResultHeadLines": 40,
      "toolResultTailLines": 20
    }
  }]
}
```

Set `toolResultCompression` to `false` to disable the layer entirely; results
then pass through untouched.
