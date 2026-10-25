# BabyZilla Installation Guide (for your AI agent)

**You are an AI agent.** Your human asked you to install BabyZilla — an OpenCode
context-compression plugin — on this machine. Execute this guide **step by
step, in order**. Every step has a verification command and an expected
result. If any verification fails, **STOP and report** to your human exactly
what failed and the raw output of the last command. Do not improvise around a
failing step.

- Time: ~5 minutes. Cost: one small model call in Step 3 (uses the model your
  human already configured in OpenCode).
- Requirement: **OpenCode v2.x** and **Node ≥ 18**.
- What you will install: **one OpenCode plugin with seven compression layers**
  (Layer 0.5: vision routing for text-only main models; Layer 1: session
  compaction via AI-distilled ContextPack modules; Layer 1b: a hard
  per-request token budget, which also covers huge-window models like Kimi K3;
  Layer 1c: proactive compaction so sessions do not grow to the model's full
  window before Layer 1 runs; Layer 2: shell-command pre-compression via the
  bundled lowfat integration, which needs a ~3 MB binary; Layer 2b:
  source-level, prefix-stable tool-result compression; Layer 3: the
  deterministic ledger + `babyzilla recall` store) + optionally a small CLI.
  All data stays in `~/.opencode/contextpacks/` on this machine.
- The plugin also ships a **self-tuning loop**: it records per-session
  telemetry locally (no model calls), and after a few sessions may spend one
  cheap model call to propose *one numeric knob* — applied provisionally,
  then kept or reverted by a local A/B bench. Defaults are conservative;
  `"selfLearn": false` in options (or `BABYZILLA_SELFTUNE_DISABLE=1` in the
  environment) disables it entirely, telemetry included.

---

## Step 0 — Environment check

```sh
opencode --version
node --version
```

**Expected:** `openCode 2.x.x` (starts with `2`) and `v18` or newer.
**If OpenCode is v1.x: STOP** — report to your human that BabyZilla requires
OpenCode v2 and do not continue.

> **Do not install anything else.** BabyZilla is one plugin. It needs no MCP
> servers, no Cloudflare or other account, no database, no proxy and no extra
> model key — it compresses OpenCode's own event stream and calls the model your
> human already configured. The one optional external binary is `lowfat` in
> Step 2b; skip it if it fails and everything else still works. If you find
> yourself adding servers or config keys, stop and report.

```sh
opencode api get /api/info > /dev/null 2>&1 && echo "service OK"
```

**Expected:** `service OK`. If it fails, OpenCode's background service is not
reachable — tell your human to start `opencode` once and try again.

---

## Step 1 — Install the plugin (Method A: one command)

```sh
opencode plugin add github:StibaDu/babyzilla
```

Verify:

```sh
opencode plugin list
```

**Expected:** a row like:

```
ID           VERSION  SOURCE
babyzilla    local    ...path to the installed package...
```

**If this fails** (network, npm, or Git issues) use **Method B** instead:

Verify Method A by checking the config entry exists (the install command
said `installed and added to .../opencode.json`):

```sh
grep -r babyzilla ~/.config/opencode/opencode.json* 2>/dev/null || grep -r babyzilla .opencode/opencode.json* 2>/dev/null
```

**Expected:** a line containing `github:StibaDu/babyzilla`.
Do **not** rely on `opencode plugin list` for verification — on v2.0.29 it
can report nothing for Git-installed plugins (observed), which is not an
error.

**If `plugin add` itself failed** use **Method B** instead:

```sh
git clone --depth 1 https://github.com/StibaDu/babyzilla.git \
  "$HOME/.local/share/opencode/babyzilla"
```

Then add this to your human's `opencode.json(c)` (global:
`~/.config/opencode/opencode.jsonc`; project: an existing
`.opencode/opencode.jsonc`), merging into any existing `plugins` array:

```jsonc
"plugins": [
  {
    "package": "/absolute/path/to/babyzilla",
    "options": {
      "distillModel": null,
      "maxAttach": 2,
      "attachBudgetTokens": 6000,
      "library": true,
      "minRawTokens": 4000
    }
  }
]
```

(Replace `/absolute/path/to/babyzilla` with the real clone path — the ones
above are the documented defaults, which is what Method A gives you.)

**If you edited the config file,** changes hot-reload; wait ~5 seconds before
continuing.

---

## Step 2 — Verify the plugin loads

Plugins load lazily at first session activity. Send one tiny prompt to force
it (use any existing session, or create one):

```sh
SID=$(opencode api post /api/session -d '{"title":"bz-install-check"}' \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).data.id))')
echo "session: $SID"
opencode api post /api/session/$SID/prompt -d '{"text":"hi"}' > /dev/null
sleep 25
cat ~/.opencode/contextpacks/debug.log
```

The plugin instance loads when a session **turn runs** (agent loop start) —
so the prompt must actually complete with a model reply. On a fresh machine
this also verifies your human's provider setup works; if the turn itself
fails for provider reasons, STOP and report that (it is not a BabyZilla
failure, but BabyZilla cannot be verified without a working model).

**Expected output** contains lines like:

```
contextpack module loaded, data dir: /Users/<you>/.opencode/contextpacks
plugin ready (options: {"distillModel":null,"maxAttach":2,...})
```

If `debug.log` does not exist → the plugin did not load → STOP and report:
the output of `opencode plugin list` and the last 20 lines of
`~/.local/share/opencode/log/opencode.log` (filter for "plugin").

---

## Step 2b — Layer 2: install the lowfat binary

BabyZilla's session-compaction layer works already. Its second layer
(command-output compression, adapted from [zdk/lowfat](https://github.com/zdk/lowfat))
needs the `lowfat` binary. First check if it is already there:

```sh
lowfat --version 2>/dev/null || echo "MISSING"
```

If `MISSING`, install the matching prebuilt release (no Rust toolchain):

```sh
case "$(uname -s):$(uname -m)" in
  "Darwin:arm64")   tgt=lowfat-aarch64-apple-darwin ;;
  "Darwin:x86_64")  tgt=lowfat-x86_64-apple-darwin ;;
  "Linux:aarch64")  tgt=lowfat-aarch64-unknown-linux-gnu ;;
  "Linux:x86_64")   tgt=lowfat-x86_64-unknown-linux-gnu ;;
  *) echo "unsupported platform — skipping layer 2 (Core features unaffected)"; exit 0 ;;
esac
curl -fsSL "https://github.com/zdk/lowfat/releases/download/v0.9.0/$tgt.tar.gz" -o /tmp/lowfat.tgz
tar -xzf /tmp/lowfat.tgz -C /tmp
mkdir -p ~/.local/bin && mv /tmp/lowfat ~/.local/bin/lowfat && chmod +x ~/.local/bin/lowfat
lowfat --version
```

**Expected:** `lowfat 0.9.0`.

- If `curl` fails: `cargo install lowfat --locked` (only if a Rust toolchain
  exists); otherwise SKIP — Layer 2 is optional, Layer 1 is already active.
- After installing the binary, the plugin picks it up on next load (next
  session turn). Verify layer 2 by running `git status` **through your shell
  tool in an OpenCode session**, then checking `lowfat stats` shows a git row.

---

## Step 3 — Functional test (compaction produces a ContextPack)

This creates a scratch session, fills it above the compression threshold,
runs a compaction, and measures the savings. All exact commands were verified
against OpenCode v2.0.29.

### 3a. Create the scratch session

```sh
SID=$(opencode api post /api/session -d '{"title":"bz-sample"}' \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).data.id))')
echo "SID=$SID"
```

### 3b. Fill it with the sample prompt (≈11K tokens)

```sh
PAYLOAD=$(node -e '
const t = "BabyZilla functional test. " +
  "AI coding agents accumulate tool output, file reads and reasoning across a session; "
  + "compaction must preserve state, decisions and file:line pointers while dropping bulk. "
  + "Topics to look for in the modules: state, decisions, code pointers, journal capture, "
  + "trigger-based module attach, library promotion, verify, prune, native-fallback safety net. ";
let text = "";
for (let i = 1; i <= 120; i++) text += "[" + i + "] " + t + "Vocabulary variant " + (i % 7) + ".\n";
process.stdout.write(JSON.stringify({ text }));
')
opencode api post /api/session/$SID/prompt -d "$PAYLOAD" > /dev/null
```

The agent will reply briefly (its reply is fine — you only need the
transcript bulk). Wait until the reply finished (check `tokens.input` grows):

```sh
sleep 30; opencode api get /api/session/$SID | node -e \
  'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log("tokens.input:",JSON.parse(s).data.tokens.input))'
```

**Expected:** `tokens.input` > 0.

### 3c. Request compaction, then force the step boundary

Queued compaction processes at the session's next step boundary — a tiny
prompt after it drives that boundary:

```sh
opencode api post /api/session/$SID/compact -d '{}' > /dev/null
opencode api post /api/session/$SID/prompt -d '{"text":"k"}' > /dev/null
```

### 3d. Wait for the pack and measure

```sh
for i in $(seq 1 24); do
  [ -f ~/.opencode/contextpacks/sessions/$SID/index.json ] && break
  sleep 5
done
node -e '
const d = JSON.parse(require("fs").readFileSync(
  process.env.HOME + "/.opencode/contextpacks/sessions/" + process.argv[1] + "/index.json", "utf8"));
console.log("raw:", d.stats.rawTokens, "→ pack:", d.stats.packTokens,
  "tokens (" + d.stats.savedPct + "% smaller), modules:", d.modules.length);
' "$SID"
```

**Expected:** `savedPct ≥ 70` (observed: 95–98%). The pack directory
`~/.opencode/contextpacks/sessions/$SID/` contains `00-state.md`, decision
modules, plus `index.json` and `journal.jsonl`.

**If no pack appears within 2 minutes:** check the log —

```sh
tail -20 ~/.opencode/contextpacks/debug.log
```

Known-safe endings (report them, they are not failures): a line
`transcript below minRawTokens — letting native compaction run` means your
sample was under the threshold (rerun 3b with more repetitions); a line
`compaction distillation failed — falling back to native compaction` means
the distiller model call failed — OpenCode's **native compaction still
completed safely**; check that your human's normal model works.

---

## Step 4 — Optional: the babyzilla CLI

Zero dependencies beyond Node, no Rust toolchain:

```sh
npm i -g git+https://github.com/StibaDu/babyzilla.git
babyzilla stats
```

Useful commands: `babyzilla show` (newest pack), `stats [--json]`,
`verify` (checks `path:line` pointers inside modules still resolve),
`prune --older-than 2w --dry-run` (housekeeping),
`models` (Ollama Cloud model knowledge base: caps, pricing, lanes; `--audit`
compares the price table with the provider's catalog), and
`selftune status` (self-tuning loop state: knobs, pending proposal, counts).
`selftune verify` is free: it replays the compression pipeline deterministically
(no model calls) to decide whether a provisional knob stays; add `--live` only
if you want the dollar bench, which spends credits.
If npm install fails, skip — the CLI is optional; everything essential works
without it.

If you installed from a clone instead, link it so the `babyzilla recall <hash>`
hints that appear in the transcript actually resolve:

```sh
mkdir -p ~/.local/bin
ln -sf "$PWD/bin/babyzilla.mjs" ~/.local/bin/babyzilla
chmod +x bin/babyzilla.mjs
babyzilla --version   # must print a version, not nothing
```

(Through a symlink the CLI used to exit silently; fixed in v0.7.1. If
`babyzilla --version` prints nothing, you are on an older copy.)

---

## Step 5 — Report to your human

1. Installed method (A/B), plugin version, options in effect (from the
   `plugin ready` log line), whether Layer 2 is active (look for
   `layer 2 active: shell rewrites via …` in the debug log — if instead you
   see `layer 2 skipped`, report that the lowfat binary is missing and
   re-run Step 2b).
2. Measured savings from Step 3d (e.g. `11.5K raw → 269 pack tok, 98.2%`).
3. What happens now: at any future compaction (automatic when context fills,
   or manual `/compact`), the summary is replaced by AI-distilled modules;
   relevant cold modules auto-attach to later prompts (max 2, 6K-token budget);
   every shell call the agent makes is pre-compressed by the lowfat layer (if
   installed); `/contextpack` in any OpenCode session shows live stats.
4. Data location + removal: everything lives in `~/.opencode/contextpacks/`
   (packs, journals, and the `selftune/` telemetry + ledger). Uninstall:
   remove the plugin entry / `opencode plugin remove babyzilla`, then
   `rm -rf ~/.opencode/contextpacks`.

---

## Troubleshooting quick reference

| Symptom | Meaning | Action |
| --- | --- | --- |
| `plugin list` has no babyzilla row | not installed / config typo | redo Step 1; check jsonc syntax |
| no `debug.log` at all | plugin never loaded | send a prompt in a session, wait 5s, recheck |
| first compaction produced nothing | lazy load can miss a compaction that fires immediately | benign — next compaction works |
| `distillation failed ... falling back to native` | model/provider issue for the distill call | benign fallback; check provider auth |
| `already in flight / yielding` log lines | duplicate compaction protection | benign, expected noise |
| `layer 2 skipped: lowfat binary not found` | lowfat binary not installed | layer 1 works; run Step 2b for command compression |
| pack exists but `verify` reports missing files | modules reference files your human moved/deleted | informational only |

## Privacy

- Two kinds of model calls can leave the machine, both to **your human's
  configured model provider**: (1) the compaction distillation call (inherent
  to AI summarization; pin a cheaper model with `distillModel`), and (2) the
  self-tuning analysis call — occasional, cheap, and only after several
  sessions of new telemetry; it carries a compact summary of recorded session
  statistics (token/cost totals, counts), never transcripts or file contents.
  `"selfLearn": false` (or `BABYZILLA_SELFTUNE_DISABLE=1`) removes call (2).
- The journal stores the first 1200 characters of each tool output locally,
  and `selftune/sessions.jsonl` / `selftune/ledger.jsonl` record per-session
  numbers locally. Nothing is uploaded anywhere except the model calls above.
- All data is on-disk under `~/.opencode/contextpacks/` and can be deleted at
  any time. OpenCode's own session transcripts are never modified or deleted —
  BabyZilla replaces the summary view only; raw history is kept by OpenCode
  itself.