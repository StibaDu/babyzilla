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

### Known packs: OpenPet AI Girls

Five anime pets from [AwesomeHou/openpet-ai-girls](https://github.com/AwesomeHou/openpet-ai-girls)
import in one command, each with its own voice:

```sh
node pet/import-openpet.mjs --repo ~/src/openpet-ai-girls
babyzilla pet packs
babyzilla pet use deepseek
```

The importer reads the OpenPet / Codex atlas convention: **8 columns, 9 rows**, one
animation per row, in this order — `idle`, `running-right`, `running-left`,
`waving`, `jumping`, `failed`, `waiting`, `running`, `review`. It crops the character
from the union of its own opaque pixels (a 192x208 cell is not square), box-filters
the frames down to 112px, and maps every expression id onto the body that reads
closest, so a pet with no faces still reacts instead of freezing on idle.

Those girls are not pixel art and their atlas has no faces, so they get movement and
attitude rather than a blink and a grin. The art belongs to its author: the importer
records where it came from in `pack.json` and writes only to
`~/.opencode/pet/packs/`.

### The catalog: 1300+ pets, one at a time

[OpenPets](https://openpets.dev) publishes a catalog of over a thousand pets as
`pet.json` + a 192x208 atlas. BabyZilla can browse it and turn any of them into a
pack:

```sh
babyzilla pet catalog                        # the first 25, + marks what you own
babyzilla pet catalog --search cat           # by name, id or blurb
babyzilla pet catalog --originals            # the 79 made by the OpenPets team
babyzilla pet add hoodie-cat                 # one pet
babyzilla pet add --originals                # all 79 originals (~180 MB of art)
babyzilla pet add --featured --search bot    # or any slice of it
babyzilla pet add https://…/pet.zip          # or a package straight from a URL
```

The list is fetched once and cached for a day in
`~/.opencode/pet/catalog.v3.json`; `--fresh` ignores the cache. A pet is only
downloaded when you ask for it, and nothing is written outside
`~/.opencode/pet/packs/`.

The importer understands both atlas generations: **V1** is the 8x9 sheet, **V2**
adds two rows of look-direction cells that this app has no use for — the crop and
every animation ignore them, so a V2 pet imports exactly like a V1 one. A pet that
only ships SVG is refused with a message rather than guessed at.

**Which voice?** A catalog pet is a stranger: we know its art, not its character.
So each one gets one of four house registers — `chirpy`, `deadpan`, `gruff`,
`regal` — plus `robot` for the machines, chosen from the pet's own id so it always
sounds like itself. The few personalities that are unmistakable are pinned
(`hoodie-cat` is `deadpan`, `luna-techbot` is `robot`). Override any of it:

```sh
babyzilla pet add snoopy --voice chirpy
```

### More faces, without more art

A 15x13 character has far too little identity for a diffusion model to hold: at
low strength it redesigns the creature, at high strength it melts the pose. So
new expressions are authored the way pixel pets always were — on the grid:

```sh
node pet/pack-expressions.mjs --pack ~/.opencode/pet/packs/lil-dino
```

This derives the pack's palette from its own frames, then writes `blink`,
`happy`, `angry`, `surprised` and `hurt` by editing the eye, brow and mouth of the
idle frame, each with a 1px beat so it holds up when looped. It also records an
`expressions` map from every one of the 100 expression ids to the face that
fits — `celebrate` gets the grin, `oops` the X eye, `sleep` the closed one — and
the app plays that face for the duration of the reaction.

At 24x24 the **mouth** carries an expression; a 2x2 eye cannot. So each face
changes the silhouette of the grin (a second open row with teeth, a flat
clenched line, a hole) or adds a brow, rather than nudging the eye. Two faces
were dropped after review instead of shipped: a separate `sleep` was
indistinguishable from `blink`, and a "corner raised" smile read as a flat line.

Because the colours are derived from the pack rather than hardcoded, the same
edits work on any pack that has an ink/shade/light/white relationship, and cannot
silently blank a frame whose palette differs.

Faces are **opt-in**, and one command takes them back out:

```sh
node pet/pack-expressions.mjs --pack ~/.opencode/pet/packs/lil-dino --remove
```

That deletes the face frames, the animations and the `expressions` map and leaves
exactly the animations the pack's artist drew — nothing else in `pack.json` and no
frame is touched. Restart the pet (`babyzilla pet use <name>`) to reload it. A
pack without faces reacts the way it always did: its walk cycle, a jump for
`party`-style events, idle otherwise.

Packs built from someone else's sheet are not ours to redistribute: the builder
writes them to `~/.opencode/pet/packs/`, and the repo ignores
`assets/pet/packs/`.

## What it does

- **Lives on the floor.** It sits above the Dock (`visibleFrame`, not the raw
  screen), wanders, pauses, turns at the edges, and hops. With the built-in art it
  *hops* rather than walks — those front-view sprites have planted legs, so a walk
  cycle can only skate — while a pack that ships a walk gets its own walk cycle.
  Either way the cadence is driven by **distance travelled, not by the clock**:
  one cycle per stride, so the feet can never skate under a body that is not
  moving. If a bubble or a tool call freezes the pet mid-stride, the animation
  freezes with it (it stands and listens) instead of running on the spot.
- **Turns at the wall.** A walk that runs into the screen edge ends at the wall: the
  pet flips to face the room, pauses, then picks somewhere else. Standing at an edge
  with nowhere to go — after a drag, a throw or a pause — it faces inward too, and a
  pet thrown into the edge bounces off it instead of sticking.
- **Reacts.** A prompt makes it listen, a tool call changes its face per tool,
  a failure makes it wince, compaction has it squeezing something, an available
  update makes it hold up a gift.
- **Tells you things.** A pixel-font bubble reports only what matters:
  compaction results, context pressure, tool failures, updates, session
  savings. Everything else is silent, because 30 tool calls should not produce
  30 bubbles.
- **Keeps its mouth shut while you work.** Reactions queue, coalesce, and
  respect `chattiness`.
- **Holds up a mark.** A badge beside its head says what the last turn left for
  you: **✓ done**, **? it asked you something**, **! something broke**. Unlike a
  bubble it never fades — it stays until *you* decide something.

### The status mark

A bubble is an event and fades on its own. A mark is **state**, and the difference
is the whole point: the dino holds up ✓, ? or ! next to its head and keeps holding
it until you act. Answering, fixing, or giving it a new task clears it.

| mark | when it appears | how it is decided |
|---|---|---|
| **✓** done | the turn ended | `session.idle`, and the turn's last words were not a question |
| **?** question | the turn ended on a question | the final answer's last character is `?` |
| **!** error | anything failed | a tool result with an error, or `session.error` / `session.step.failed` |

Rules that keep it honest:

- **A question is read literally.** Only a `?` at the end of the model's own last
  sentence counts (`… right?"` still counts). A question mark in the middle is the
  model thinking, not asking you, and nothing is inferred from tone.
- **An error is immediate and can be withdrawn.** A failed command raises **!** at
  once; a later success in the same turn takes it back down, so a badge left up at
  the end of a turn means "still broken", not "something once went wrong".
- **It survives a restart.** The plugin owns `~/.opencode/pet/mark.json` and the app
  only reads it, so a dino launched tomorrow still holds yesterday's unanswered
  question. One writer, no disagreement.
- **Only your sessions count.** A subagent session going quiet does not raise a
  badge — it is not your turn.
- **It never steals a click.** The badge is a separate click-through window beside
  the head, below the bubble's tail.

`babyzilla pet mark` shows the current mark; `babyzilla pet mark done|question|error|none`
sets or clears it by hand (useful when testing the look, or to shut the dino up).

## Controls

| Action | Result |
|---|---|
| drag | move it, throw it, it falls and squashes |
| click | poke (it reacts) |
| right-click | hide/show, size 1×/2×/3×, pet, mute, chattiness, gallery, quit |
| menu bar icon | **Hide Dino / Show Dino**, size, pet, mute, gallery, quit |

Position, size, chattiness and whether it is on persist in
`~/.opencode/pet/config.json`.

### Turning it off

The menu bar icon *is* the dino's face — the pack's own idle frame, cropped to the
character and drawn nearest-neighbour, so it is the same creature and not a generic
glyph. Click it and the first item is **Hide Dino**; the icon dims while the pet is
off, so the menu bar tells you its state without opening anything.

Off is a real stop, not a fade: the windows are ordered out, the 30 Hz timer is
invalidated (no CPU while it is off), and the event file is skipped rather than
queued — otherwise turning it back on after an hour of work would replay a burst of
old bubbles. The choice is written to `config.json`, so `pet install --login` starts
the app at login but leaves a hidden dino hidden.

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

## Thinking out loud

On every request the pet says one line about **you**. Not a summary of the work —
the model's opinion of its human, bluntly. It speaks in the voice its pack declares,
and only the dino is a caveman:

```
   ╭──────────────────────────────╮
   │  Human keep ask for bigger   │
   │  pet. Me wait.               │
   ╰──────────────────╮───────────╯
                 · ·
```

`lib/pet-thought.mjs` does it locally (no model call, no tokens). The reducer:

- picks the sentence that is **about the human** — `user`, `they`, `asked`, `keeps`,
  `again` — over the one about the bug, because that is the interesting one;
- says `human` instead of `the user`, drops the grammar (articles, copulas,
  auxiliaries, pronouns) and bares the verb: "The user wants me to make the pet
  talk" → "Human want me make pet talk";
- keeps what changes meaning: **negations**, `because`, names, numbers;
- leaves unknown verbs alone rather than chopping them into new words ("retir");
- drops code, markdown, links and anything the pixel font cannot draw, then clips
  at a word and admits the cut with `…`.

Want the literal quote instead of the persona? `"petThoughts": "verbatim"` shows the
model's own sentence, picked for interest (a question, an aside, a "wait"):

```
   ╭──────────────────────────────╮
   │  Hmm, wait: the alpha never  │
   │  leaves zero, so the fade    │
   │  never runs.                 │
   ╰──────────────────╮───────────╯
```

### Voices

Every pet has one. A voice is exactly two things: a **mechanical transform** of the
model's own sentence, and a **pool of asides** it may add afterwards. A pack states
its voice in `pack.json` (`"voice": "doubao"`); a pack that states nothing speaks
plainly, because its art is someone else's and so is its character.

| pet | voice | register | the same thought, its way |
|---|---|---|---|
| Lil Dino | `caveman` | blunt, cave, rewrites words | `Human keep ask for smaller bubble. Human again.` |
| DeepSeek | `deepseek` | calm, precise, quietly superior | `The user keeps asking for a smaller bubble. Predictable.` |
| Doubao | `doubao` | small, sweet, easily offended | `The user keeps asking for a smaller bubble. Hmph!` |
| Gemini | `gemini` | bright, loud, delighted by everything | `The user keeps asking for a smaller bubble. Really?` |
| ChatGPT | `chatgpt` | relentlessly helpful, faintly corporate | `The user keeps asking for a smaller bubble. Again, then.` |
| Claude | `claude` | gentle, thoughtful, never in a hurry | `The user keeps asking for a smaller bubble. This again.` |
| *(a catalog pet)* | `chirpy` | bright cartoon pep | `The user keeps asking for a smaller bubble. Nailed it!` |
| *(a catalog pet)* | `deadpan` | dry, unimpressed | `The user keeps asking for a smaller bubble. Thrilling.` |
| *(a catalog pet)* | `gruff` | blunt, short fuse | `The user keeps asking for a smaller bubble. Waste of time.` |
| *(a catalog pet)* | `regal` | grand, formal, theatrical | `The user keeps asking for a smaller bubble. How tedious.` |
| *(a machine)* | `robot` | clipped and precise | `The user keeps asking for a smaller bubble. Idle loop.` |
| *(anything else)* | `plain` | no opinions pasted on | `The user keeps asking for a smaller bubble. As before.` |

Two rules keep this honest:

- **Only the caveman rewrites words.** Everyone else keeps the model's own sentence
  and adds attitude around it. `The user wants me to make the pet talk` becomes
  `Human want me make pet talk` for the dino, and stays itself for everyone else.
- **`Rawr!` belongs to the creature, not the format.** About one caveman thought in
  twenty-three roars; no other voice ever does.

A pet's voice follows the active pack, so `babyzilla pet use doubao` changes both the
body and the way it talks. `babyzilla pet think "…" --voice claude` previews one
without switching.

### Mood

A pet is allowed an opinion. It is not allowed a fantasy: the **content** is always
the model's own sentence; only the **tone** is the pet's. So the mood is read off
words that are already in the sentence, and a mood with no evidence is never put on.
Every voice answers every mood with its own lines — the table below is the dino's:

| evidence in the sentence | mood | some of what it says |
|---|---|---|
| `broken`, `fails`, `wrong`, `why`, `regression` | angry | `Me angry.` `Human owe dino rock.` `Me count to ten. Not work.` |
| `hmm`, `wait`, `unclear`, `weird` | confused | `Me confused.` `Human speak upside down.` `Dino blink.` |
| `again`, `twice`, `keeps`, `still`, `same` | bored | `Same rock again.` `Human loop. Dino yawn.` `Me carve tally. Many marks.` |
| `pass`, `fixed`, `done`, `green` | smug | `Dino right.` `Dino one. Bug zero.` `Human learn from dino.` |
| the human asked for something (`wants`, `asked`, `keeps`) | teasing | `Human ask much.` `Dino do work. Human watch.` `Dino listen. Maybe.` |
| no evidence at all | *(none)* | `Dino work.` `Me look. Me look more.` — it comments on its day, not on you |

**Variety is structural, not just a long list.** The caveman has eleven asides and
four short grunts per mood (the other voices five and two), and the same machinery
moves between them:

- **Placement.** A short grunt can open the bubble (`Hmph. Parser broken again…`)
  about a third of the time; a longer aside trails it. A thought that already opens
  with a grunt (`Hmm, wait…`) never gets a second one stacked in front of it.
- **Ties rotate.** When two sentences are equally alive, which one is quoted comes
  from the reasoning block as a whole, so two similar steps don't say the same thing.
- **One in nine stays bare.** No aside at all: an aside every single time is a tic,
  not a voice.
- **Mood ≠ silence.** Without mood evidence the dino still speaks, but in a neutral
  register (`Dino note.` `Another rock.`) — it never performs a feeling it cannot
  back up.

Anger is not only written: an angry thought also asks the app for `conflict`, which
the pack's expressions map turns into the shaking animation. The dino trembles at
the bug it is complaining about.

**Rawr.** About one thought in twenty-three is a plain `Rawr!` instead of an aside,
in front or behind the thought — deterministic per sentence (so a test can never
flake), unless a caller passes its own `random`. It is deliberately unrelated to the
mood: a dino that only roars when it is cross is a dino you can predict.

The aside is attached so it cannot be clipped away: the thought is clipped to make
room for it, never the other way round. `"petThoughts": "verbatim"` is a quote, so it
gets no tone at all.

Rules that keep it pleasant rather than spammy:

- **one thought per step**, 2.6s throttle, and never the same line twice;
- **speech wins** — a thought never displaces a line the pet is saying, and a
  line arriving mid-thought cuts it short;
- **only the newest** assistant reasoning is used, so a stale thought is never
  replayed later in the turn;
- off with `"petThoughts": false`, `"pet": false`, or `BABYZILLA_PET=0`.

Try it without a session:

```sh
babyzilla pet think "The user wants me to make the pet talk."
babyzilla pet think --caveman "They asked for this twice already."   # explicit
```

## More animations

A pack can answer many states through its `expressions` map, which points an
expression id at an animation name:

```json
"expressions": {
  "thinking": "nod",       "celebrate": "sway",    "compressing": "dash",
  "shell-fail": "shake",   "tool-question": "turn", "tool-task": "stretch",
  "tool-read": "lean",     "tool-edit": "bounce",   "budget-full": "slump"
}
```

`pet/pack-animations.mjs` adds nine of them without repainting anything — the
palette, the pixel blocks and the baseline cannot drift, because every frame comes
either from the artist's own sheet or from the pack's own idle frame:

```sh
node pet/pack-animations.mjs --pack ~/.opencode/pet/packs/lil-dino \
  --sheet "$HOME/Downloads/PACK - Lil Dino Free/PACK - Lil Dino Free.png" \
  --cell 32 --crop 4,0,24,24 --upscale 2 --row 2 --from-col 6
```

| animation | frames | how it is made | answers |
|---|---|---|---|
| `dash` | 4 | the sheet row the pack never imported, copied cell-relative | `compressing`, `ship-it`, `self-tune` |
| `nod` | 3 | the body squashing toward its feet | `thinking`, `listening`, `retrieve`, `tool-todo` |
| `sway` | 3 | a shear that leaves the feet planted | `celebrate`, `shell-ok`, `pack-created` |
| `shake` | 4 | the sprite jerking sideways, feet and all | `shell-fail`, `oops`, `conflict`, `offline` |
| `stretch` | 3 | the body growing up from its feet | `tool-task`, `subagent-wait`, `budget-low` |
| `turn` | 4 | squeezed edge-on, then mirrored | `tool-question`, `waiting` |
| `lean` | 4 | tipping forward, feet planted | `tool-read`, `tool-grep`, `tool-list`, `tool-webfetch` |
| `bounce` | 4 | crouch, then a small hop | `tool-edit`, `tool-write`, `tool-bash`, `typing` |
| `slump` | 3 | sagging toward the floor, slowly | `budget-low`, `budget-full` |

The `turn` is the one worth watching: frame 2 squashes the character to a sliver and
frame 3 is the mirror image, so it reads as the dino rotating to face its human —
which is exactly what it should do when the agent needs an answer from you.

`--remove` takes all nine out again and leaves the pack as drawn.

## Removing a pet

`pet install` puts the built-in pet in your state dir. If you only ever use a pack,
the built-in art is dead weight:

```sh
babyzilla pet use lil-dino      # you cannot remove what you are wearing
babyzilla pet remove babyzilla  # or: pet remove <pack-id>
```

`remove` refuses to delete the active pet (that would leave a blank window on the
next launch), hides it from `pet packs`, and makes `pet use` say how to get it
back. A later `pet install` does **not** resurrect it — it prints
`skipped babyzilla (removed …)` — because a removal is a decision, not a missing
file. Bringing one back is explicit:

```sh
babyzilla pet restore babyzilla   # or a bundled pack id
```

The art was never far away, just not installed.

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
