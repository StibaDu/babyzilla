# BabyZilla pet

A 16-bit creature that lives on the bottom edge of your screen, walks around,
and reacts to what OpenCode is doing. 100 expressions, drawn at 64×64 and shown
at 3× by default.

```sh
babyzilla pet install      # build + install the app, copy the sprites, start it
babyzilla pet status       # is it running, how many sprites, last event
babyzilla pet list         # all 100 expressions, grouped
babyzilla pet emit party   # make it react right now (testing / fun)
babyzilla pet gallery      # open the sprite field guide in a browser
```

Requirements: macOS with the Xcode command line tools (`xcode-select --install`)
the first time it builds. After that the app is a normal bundle in
`~/Applications/BabyZillaPet.app`.

## What it does

- **Lives on the floor.** It sits above the Dock (`visibleFrame`, not the raw
  screen), wanders, pauses, turns at the edges, and hops.
- **Reacts.** A prompt makes it listen, a tool call changes its face per tool,
  a failure makes it wince, compaction has it squeezing something, an available
  update makes it hold up a gift.
- **Tells you things.** A pixel-font bubble reports only what matters:
  compaction results, context pressure, tool failures, updates, session
  savings. Everything else is silent, because 30 tool calls should not produce
  30 bubbles.
- **Keeps its mouth shut while you work.** Reactions queue, coalesce, and
  respect `chattiness`.

## Controls

| Action | Result |
|---|---|
| drag | move it, throw it, it falls and squashes |
| click | poke (it reacts) |
| right-click | size 2×/3×/4×, mute, chattiness, gallery, quit |
| menu bar icon | show the pet, quit |

Position, size and chattiness persist in `~/.opencode/pet/config.json`.

## How the connection works

The plugin appends JSON lines to `~/.opencode/pet/events.jsonl`; the app tails
that file. No sockets, no ports, no lifecycle coupling: if the pet is closed the
plugin writes a few bytes, and if the pet starts late it reads from the end of
the file.

| OpenCode signal | Expression |
|---|---|
| `session.hook("prompt")` | `listening` |
| `session.hook("context")` (throttled 900ms) | `thinking`, plus `budget-low` at 80% |
| `tool.hook("execute.before")` | `tool-read`, `tool-grep`, `tool-edit`, `tool-bash`, `tool-task`, … |
| `tool.hook("execute.after")` | `shell-ok`, `shell-fail`, `oops`, `celebrate` (slow success) |
| `session.hook("compaction")` | `compressing` → `pack-created` |
| update check | `update-available` |
| model / network errors | `rate-limited`, `offline`, `model-error` |

Turn it off with the plugin option `"pet": false`, or the environment variable
`BABYZILLA_PET=0`.

## The expressions

`babyzilla pet list` prints all 100 with their categories:

| Category | # | Examples |
|---|---|---|
| idle | 10 | `idle`, `blink`, `breathe`, `yawn`, `stretch` |
| sleep | 6 | `sleep`, `zzz`, `wake-startled`, `coffee` |
| prompt | 12 | `listening`, `thinking`, `confused`, `eureka` |
| tools | 18 | `tool-read`, `tool-grep`, `tool-bash`, `subagent-wait` |
| outcome | 10 | `success`, `error`, `test-pass`, `shrug` |
| core | 12 | `compressing`, `recall`, `budget-low`, `self-tune` |
| system | 10 | `update-available`, `offline`, `rate-limited` |
| emotion | 12 | `wave`, `poke`, `love`, `party` |
| eggs | 10 | `glitch`, `roar`, `segfault`, `rubber-duck` |

Motion is procedural — `bob`, `pop`, `shake`, `float`, `still` — so 100
expressions are 100 sprites, not 800 animation frames.

## Art pipeline

The sprites are generated and then constrained, not painted:

```sh
node pet/build.mjs master          # 1 reference character
node pet/build.mjs expressions     # 100 faces, conditioned on the reference
node pet/build.mjs locomotion      # 10 walk/run/hop poses, same seed, no reference
node pet/build.mjs sheet           # 10×10 contact sheet for review
node pet/build.mjs data            # pet-data.json for the app
```

- A locked 16-colour palette (`pet/palette.mjs`); every sprite is quantised to it.
- 64×64 canvas, 1px ink outline, bottom-centre baseline so nothing jitters.
- Faces are generated with `--image-path master.png` so the body cannot drift.
- Legs *cannot* move under image conditioning, so locomotion is generated from
  the same seed without a reference — that is the only place the pose is free.
- `pet/manifest.json` records the seed and exact prompt for every sprite, so any
  one can be reproduced.

## Performance

The app idles at 30Hz with a single 192×192 layer and a nearest-neighbour blit;
measure it with `top -pid $(pgrep -f BabyZillaPet)`. It does no network I/O and
writes nothing except its config and, when you move it, its position.

## Troubleshooting

| Symptom | Cause |
|---|---|
| nothing on screen | `babyzilla pet status`; if not running, `babyzilla pet install` |
| it never reacts | the plugin is not loaded in the running OpenCode session, or `pet: false` |
| half a sprite | you are on a build before 0.14; the layer anchor bug is fixed |
| no bubble | muted, or chattiness `quiet` |
| `swiftc: command not found` | `xcode-select --install` |
