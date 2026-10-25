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

## A second pet: packs

A pack is a different look for the same pet — same reactions, same bubbles, same
event bridge, different art. Packs carry whole animations (`idle`, `walk`,
`jump`) instead of one sprite per expression, which is the shape a hand-drawn or
third-party sprite sheet actually has. That is also the only way to get a real
walk cycle: legs can move when a sheet was drawn for it.

```sh
babyzilla pet packs          # what is installed, and which is active
babyzilla pet use lil-dino   # switch, restarts the pet if it was running
babyzilla pet use babyzilla  # back to the generated art
```

The same switch is in the pet's right-click menu under **Pet**.

### Building a pack from a sheet

```sh
node pet/pack.mjs   --sheet ~/Downloads/PACK.png   --name lil-dino --label "Lil Dino"   --cell 32 --crop 4,0,24,24   --rows idle,walk,jump --cols 6 --upscale 2   --out "$HOME/.opencode/pet/packs/lil-dino"
```

- `--cell` is the grid cell in the sheet; `--crop` is the region inside each cell
  that should become the frame (crop out the sheet's margins, once, for all).
- `--rows` names the animations top to bottom; empty cells are skipped.
- `--upscale` is nearest-neighbour, so pixels stay square.
- Frames are copied **cell-relative**, never re-aligned: a jump that rises in
  the sheet still rises in the app.
- `pack.json` records the animations, their frame rate, the canvas size, the
  default scale, and where the art came from.

### More faces, without more art

A 15x13 character has far too little identity for a diffusion model to hold: at
low strength it redesigns the creature, at high strength it melts the pose. So
new expressions are authored the way pixel pets always were — on the grid:

```sh
node pet/pack-expressions.mjs --pack ~/.opencode/pet/packs/lil-dino
```

This derives the pack's palette from its own frames, then writes `blink`,
`happy`, `angry`, `surprised`, `hurt` and `sleep` by editing the eye, the brow and
the tooth row of the idle frame, each with a 1px beat so it holds up when looped.
It also records an `expressions` map from every one of the 100 expression ids to
the face that fits — `celebrate` gets the grin, `oops` the X eye, `sleep` the
closed one — and the app plays that face for the duration of the reaction.

Because the colours are derived from the pack rather than hardcoded, the same
edits work on any pack that has an ink/shade/light/white relationship, and cannot
silently blank a frame whose palette differs.

Packs built from someone else's sheet are not ours to redistribute: the builder
writes them to `~/.opencode/pet/packs/`, and the repo ignores
`assets/pet/packs/`.

## What it does

- **Lives on the floor.** It sits above the Dock (`visibleFrame`, not the raw
  screen), wanders, pauses, turns at the edges, and hops. While it travels it
  *hops* rather than walks: the front-view sprites have planted legs, so a walk
  cycle can only skate. The hop cadence follows distance, not the clock, so the
  ground never slides under it.
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
expressions are 100 sprites, not 800 animation frames. Travel uses a four-beat
hop (crouch, push, apex, land) drawn from the locomotion frames.

Size is 2× by default (128 px); right-click the pet for 1×, 2× or 3×.

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
