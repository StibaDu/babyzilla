# Changelog

All notable changes to BabyZilla. Versions follow [SemVer](https://semver.org/).

## [0.33.4] — 2026-10-27

### Added

- **Stay put — a pet that holds its ground.** The pet decides what to do every
  3–9 seconds, and two of those five choices move it: wander somewhere else on the
  screen, or amble toward the pointer (`followCursor`). *Stay put*, in the pet's
  right-click menu **and** the menu bar, removes those two and keeps the rest —
  hops, head tilts, blinks and looking around still happen.

  - The remaining idle behaviour keeps its **original proportions**: the roll is
    drawn from the 0.62–1.0 band rather than the movement bands being deleted and
    the rest re-spread, which would have made a stationary pet hop ~3× as often.
  - Switching it on **stops the pet where it stands** — a pending wander target is
    cleared, so it does not finish the stroll it already started and look broken
    for the length of that walk.
  - It is about the pet's own decisions, not your input: dragging/throwing still
    work, and an explicit `walk` event is still honoured.
  - Persisted as `stayPut` in `~/.opencode/pet/config.json` (default `false`), so a
    restart or `pet install --login` does not turn it back into a walker.

### Changed

- The menu bar action is **Hide Pet / Show Pet** (German **Pet verstecken /
  Pet zeigen**) instead of *Hide Dino / Show Dino*. A pack is a second look, so an
  action named after the default pack's art went stale the moment you switched
  pets. The pack label **Lil Dino** is the creature's name and is unchanged.

### Verification

Two new app tests (`test/pet.test.mjs`), skipped when the app is not built and off
macOS: both menus are printed via `--menu` and checked for the wording and the
checkmark state, and `--stay-test` drives the real switch — toggling it clears a
pending walk, writes `config.json`, and 12 seconds later (longer than the 3–9 s
decision timer) the pet is on the same pixel.

## [0.33.3] — 2026-10-27

### Added

- **Token calibration — `babyzilla calibrate`.** `chars/4` is the estimate behind
  every absolute number in the plugin: the budget floor/cap, the proactive
  compaction trigger, the overflow valve, the reported savings. The plugin now
  records one line per request (system + messages + tool schemas, taken *after*
  compression, so the sample describes the bytes that are billed) and the command
  pairs those lines with provider usage (`tokens.input + tokens.cache.read`) to
  learn a per-model `billed / estimated` factor.

  - Median over samples, clamped to 0.6–1.8, applied only with ≥12 samples.
  - Samples under 8K estimated tokens, or where messages are <40% of the request,
    are counted but not used — they measure the system prompt and tool schemas,
    not the messages a budget governs.
  - Pairing is by time within the session, so an aborted request leaves a gap
    rather than shifting every later sample.
  - The factor scales **absolute thresholds only** (`estForReal`); savings
    percentages are ratios and are left alone.
  - `--dry` reports without writing, `--reset` drops the factors, `calibrate:
    false` stops sampling. The plugin re-reads `calibration.json` every 30s, so a
    fresh measurement lands without restarting.

### Measured on this machine (not an estimate)

```
model                                  samples  factor         p25–p90  state
deepseek-v4.1-flash:1017                    62   ×1.06       1.02–1.18  applied
```

~6% at the median, 18% at the p90 (JSON-heavy prompts). Small for this model —
which is the honest result: `chars/4` was already close here. The mechanism
exists for the models and content where it is not, and because the bias is
per-model by nature.

### Changed

- New default `calibrate: true` (one ~120-byte JSONL line per request).

## [0.33.2] — 2026-10-27

### Added

- **Grounding: no silent guesses.** Every request now carries one constant system
  part (`event.system`, via a second `context` hook):

  > Answer truthfully. When you are confident, answer directly; when you are not
  > certain of a factual claim, say so or verify it before asserting it (search,
  > read the file, run the command). Never present a guess as a fact. Label an
  > estimate as an estimate. If the user's premise looks wrong, say so instead of
  > going along with it. Do not ask the user to check what you can check yourself.

  It is a **system part, not a prompt edit**: prompt-hook edits become the
  canonical persisted user turn (OpenCode docs), so a directive there would live in
  the transcript forever. `event.system` is rebuilt per request, and constant bytes
  stay in the provider's cached prefix.
- The directive lives in its **own** `context` hook, so `requestCompression: false`
  cannot turn honesty off.

### Changed

- New default `grounding: true`. Set `grounding: false` to drop the instruction for
  work where being wrong out loud is the point (brainstorming, first drafts).

### Limits, stated

- This is an instruction, not a guarantee. It makes verification the cheap path and
  the silent guess the exception; it cannot make a model infallible. The release
  notes say so rather than implying otherwise.

## [0.33.1] — 2026-10-26

### Added

- **Choosing the language without a terminal.** Right-click the pet → **Sprache →
  Deutsch** (or **Language → English**), and the same submenu in the menu bar. The
  checkmark follows the active language, the choice is written to `config.json`, and
  the pet answers in the language you just picked (`Deutsch, bitte.` / `English,
  then.`) so the switch is visible rather than silent.
- `BabyZillaPet --menu` prints both menus (titles, checkmarks, submenus) and
  `--set-language <id>` drives the real menu action; the harnesses exist because a
  menu cannot be screen-captured on a machine that has not granted screen recording.

### Changed

- `More pets…` in the Pet submenu is translated as well (`Mehr Pets…`).

## [0.33.0] — 2026-10-26

### Added

- **German.** `babyzilla pet lang de` (or `BABYZILLA_PET_LANG=de` for one shell)
  switches the pet's language; the running pet adopts it immediately, no restart.
  - Everything the pet *authors* is German: asides, event lines (`bash
    fehlgeschlagen`, `Kontext wird gepresst…`), its canned speech, and the app's
    menus and windows (`Mehr Pets…`, `Gesprächigkeit`, `Chat öffnen…`, `Pet nehmen`).
  - Asides are written per **register**: the dino keeps its own cave German, the
    other eleven voices share three (terse, warm, formal). English never leaks into
    a German bubble.
  - A German mood is read from German words (`Fehler`/`kaputt` → angry, `unklar` →
    confused, `klappt` → smug); without that every German thought landed in `flat`.
  - `pet lang` with no argument reports the current language; `pet status` and
    `pet think` show it too.
- The bubble font gained `ä ö ü ß Ä Ö Ü` (5×7, diaeresis on the top row), so German
  is spelled correctly instead of being stripped to `a o u ss`.

### Changed

- Accented Latin folds to its base letter before a thought is drawn (`Café` →
  `Cafe`) rather than losing the character entirely.

### Not translated, on purpose

- **The quoted thought is the model's own sentence.** There is no translation call
  in the pet: inventing your work in German would be worse than quoting it in
  English. A German conversation usually gets German reasoning anyway.

## [0.32.0] — 2026-10-26

### Added

- **The pet browser: the OpenPets catalog, inside the app.** **Pet → More pets…**
  lists all 1300+ catalog pets with search. Packs already on disk come first (`●`
  active, `·` installed); anything else is a catalog entry with its category.
  Picking one downloads it, converts it to a pack, and switches to it — no terminal
  needed. The catalog is fetched once and cached for a day, and the browser fetches
  it itself on first open. `Esc` closes it.
- `pet install` now writes `~/.opencode/pet/cli.json` with the absolute `node` and
  CLI paths. The app is a login item with no `PATH`, so it cannot call either by
  name — the same lesson as the lowfat report, one layer down. The browser uses
  those pinned paths.

### Changed

- **A fresh install wears Lil Dino.** The pack ships with the plugin
  (`assets/pet/packs/lil-dino` — 50 frames, its own 48px scale, caveman voice) and
  `pet install` sets it as the default when `config.json` has no choice yet. An
  explicit choice is never overridden, but an upgrade from the legacy art lands on
  the dino.
- **BabyZilla is no longer a pet you can pick.** The generated art is still copied
  into the state dir as a fallback for a broken pack (a blank window is worse), but
  it is gone from the Pet menu and from `pet packs`. `pet use default` and
  `pet restore babyzilla` still work as recovery.
- `pet packs` lists the pets you actually have and points at the catalog for the
  rest; the menu's empty-state line says **More pets…** instead of a CLI command.

### Fixed

- **Offscreen captures included a rectangle at the window origin**, so a pet
  sitting at x=900 produced a 900px-wide strip of empty desktop around every
  snapshot. The union now starts from the first window, not `NSRect.zero`.

## [0.31.0] — 2026-10-26

### Added

- **A chat window: the bubble's lines, kept.** Click the pet to open it (click
  again, `Esc`, or the menu to close), scroll back through what it said, and watch
  new lines arrive. Thoughts are dim blue, speech is bright, newest at the bottom.
  It opens with the last 40 lines from `events.jsonl` instead of a blank page, and
  it keeps **every line it was asked to say** — including the ones a bubble dropped
  because another was already up. `babyzilla pet chat [--close]` does it from the
  shell, and the app writes `last-chat.json` so the CLI can prove the window is up.

### Changed

- **Bubbles stay long enough to read.** A thought held 1.8s minimum; it now holds
  `max(3.8s, 70ms/char)` up to 11s, and speech `max(4.0s, 80ms/char)` up to 16s.
- **A thought no longer cuts off the thought on screen.** The newest line waits its
  turn (one queued thought, latest wins), which is what made the bubble read as a
  flicker even though the pet was talking steadily.
- `babyzilla pet think`/`say` print how long the line will stay on screen (`shown at
  1:34:23 PM for 4.3s`).

### Fixed

- **`ps`/`kill` were looked up in `/usr/bin`, which no longer has them** (macOS 26+
  keeps both in `/bin`). `petPidAlive()` therefore always answered "no", so
  `pet status` could claim the pet was not running while it was, and a queued
  bubble was reported as "not running". All system tools are now resolved once at
  runtime (`lib/tool.mjs`) instead of hardcoded.

## [0.30.1] — 2026-10-26

### Fixed

- **Layer 2 no longer dies with `command not found: lowfat` (exit 127).**
  `lowfat rewrite` answers with the binary's *bare* name, and the tool shell that
  runs the rewritten line is spawned by the host — a stock macOS shell has
  `/opt/homebrew/bin` and `/usr/bin`, but not `~/.local/bin`, where
  `AGENT-INSTALL.md` installs lowfat. The plugin now pins the absolute path it
  resolved at load time into every command position (`LOWFAT_PIPED=1
  /Users/…/.local/bin/lowfat grep …`), leaves literal mentions in arguments
  alone, and falls back to lending the shell the directory on PATH if a future
  rewrite shape asks for a bare lowfat some other way. No PATH edit required.
- **The pet list is visible on a fresh install.** The `Pet` submenu was only
  added when more than one pet existed, so a new user saw no list at all and had
  no way to discover packs; it is now always offered, with a disabled
  "No other pets — babyzilla pet catalog" line while only the built-in exists.
- `babyzilla pet packs` says where to get more when the built-in is all there is.

## [0.30.0] — 2026-10-25

### Added

- **The OpenPets catalog is wired in.** [openpets.dev](https://openpets.dev) publishes
  1312 pets as `pet.json` + a 192x208 atlas; `babyzilla pet catalog` browses them
  (search, `--featured`, `--originals`, `--json`), `babyzilla pet add <id>` installs
  one, and `pet add --originals` installs all 79 OpenPets originals. The list is
  cached for a day in `~/.opencode/pet/catalog.v3.json`; art is only downloaded when
  you ask for it.
- **`pet add` takes anything**: a catalog id, a zip, a zip URL, a package folder, or
  a git URL (which installs every pet inside it). `--voice` and `--as` override the
  personality and the name; four downloads run at a time.
- **Two atlas generations**: V1 is the 8x9 sheet, V2 adds two rows of
  look-direction cells. The crop and the animations ignore the extra rows, so a V2
  pet imports exactly like a V1 one (`pack.json` records which it was).
- **Five more house voices** — `chirpy`, `deadpan`, `gruff`, `regal`, `robot` — so a
  catalog pet is never voiceless and never a caveman. Each imported pet gets one
  from its own id (deterministic, so it always sounds like itself); unmistakable
  characters are pinned (`hoodie-cat` → `deadpan`, `luna-techbot` → `robot`).
- **`pet/pet-package.mjs`**: one place that turns a package into a pack (crop,
  downscale, expressions, voice, attribution), shared by `pet add` and
  `pet/import-openpet.mjs` — which shrank to a loop over folders.
- `pack.json` now records the atlas it came from (`atlas.sheet`, `atlas.cell`,
  `atlas.rows`, `atlas.version`) and the package's description.

## [0.29.0] — 2026-10-25

### Added

- **Every pet has a voice.** A voice is a mechanical transform of the model's own
  sentence plus a pool of asides: `caveman` (the dino, the only one that rewrites
  words), `deepseek` (calm, precise, quietly superior), `doubao` (small, sweet,
  easily offended), `gemini` (bright, loud, delighted), `chatgpt` (relentlessly
  helpful), `claude` (gentle, thoughtful), and `plain` for anyone else. A pack
  declares its own in `pack.json` (`"voice": "doubao"`); a pack with no voice
  speaks plainly rather than borrowing the dino's opinions.
- **The same thought, six ways:**
  `Human keep ask for smaller bubble. Human again.` · `… Predictable.` · `… Hmph!` ·
  `… Really?` · `… Again, then.` · `… This again.`
- **`Rawr!` is the creature's, not the format's**: no other voice ever roars.
- **OpenPet AI Girls import**: `node pet/import-openpet.mjs --repo <checkout|url>`
  adds DeepSeek, Doubao, Gemini, ChatGPT and Claude as packs, each with its voice.
  It reads the 8x9 OpenPet/Codex atlas, crops the character from its own opaque
  pixels, box-filters to 112px, and maps every expression id onto the body that
  reads closest — a pet with no faces still reacts.
- **`pet/pack.mjs` handles real atlases**: non-square cells (`--cell 192x208`),
  `--resize N` (alpha-weighted box downscale, letterboxed so the character is never
  stretched), webp sheets via `sips`, `--voice`, and per-animation `--fps`.
- **`babyzilla pet think "…" --voice doubao`** previews any voice without switching
  the pet; `pet think` and `pet status` report the active one.

## [0.28.0] — 2026-10-25

### Added

- **The dino holds up a mark.** A badge beside its head that says what the last
  turn left for you — **✓ done**, **? it asked you something**, **! something
  broke** — and it does not fade. A bubble is an event; a mark is state, and it
  stays until *you* decide something: answer, fix, or give a new task.
- **Questions are read literally.** At turn end (`session.idle`, or
  `session.status` going idle) the plugin reads the model's own last answer: a
  final `?` means it stopped to ask, anything else means done. Nothing is inferred
  from tone, and a `?` in the middle of an explanation does not count.
- **Errors are immediate and withdrawable.** A failed tool raises **!** at once; a
  later success in the same turn takes it back down, so a badge still up at the end
  of a turn means "still broken", not "something once went wrong". `session.error`
  and `session.step.failed` raise it too.
- **It survives a restart and the pet being switched off.** The plugin owns
  `~/.opencode/pet/mark.json`; the app only reads it, so a login start still shows
  yesterday's unanswered question. Only your own sessions count — a subagent going
  quiet is not your turn.
- **`babyzilla pet mark [done|question|error|none]`** shows, sets or clears the
  badge, and reports whether the app really put it on screen (`last-mark.json`),
  the same observation-not-faith rule as bubbles.

## [0.27.0] — 2026-10-25

### Added

- **A much bigger, more varied voice.** Every mood now has eleven asides and four
  short grunts instead of three or four lines: angry gets cave proverbs
  (`Rocks not this stubborn.` `Me count to ten. Not work.`), teasing gets the human
  doing the watching (`Dino do work. Human watch.` `Human hold rock wrong.`), bored
  gets `Human loop. Dino yawn.` and `Me carve tally. Many marks.`
- **Asides can lead as well as trail.** A short grunt opens about a third of
  bubbles (`Hmph. Parser broken again…`); a longer aside closes them. A thought that
  already opens with a grunt never gets a second one stacked in front of it.
- **No evidence still means a voice.** Sentences with no mood words used to get
  nothing; they now get a neutral aside (`Dino work.` `Me look. Me look more.`) — the
  dino comments on its day without claiming a feeling it cannot back up.
- **One in nine thoughts stays bare**, so the voice does not become a formula, and
  **equally alive sentences now rotate** by the reasoning block instead of always
  quoting the first of the ties.

## [0.26.0] — 2026-10-25

### Added

- **The dino has opinions about its human, and moods.** Every thought keeps the
  model's own words as its content; the tone is read off evidence already in the
  sentence — `broken`/`fails`/`why` → angry, `again`/`twice`/`keeps` → bored,
  `hmm`/`wait` → confused, `pass`/`fixed` → smug, and a human who keeps asking →
  teasing. No evidence, no mood: it does not perform feelings it cannot back up,
  and it never invents a fact to have one.
- Tags are short caveman asides appended to the thought (`Human keep ask for smaller
  bubble. Human again.`), attached so they can never be the part that gets clipped.
- **Anger is visible, not just written**: an angry thought also emits `conflict`,
  which the pack's expressions map turns into the shaking animation.
- **`Rawr!`** lands on roughly one thought in twenty-three, unrelated to the mood.
  Deterministic per sentence by default (a test can never flake); pass `random` to
  make it genuinely surprising.

### Fixed

- `babyzilla … | head` printed an EPIPE stack trace instead of exiting; a closed pipe
  now exits quietly.

## [0.25.0] — 2026-10-25

### Fixed

- **The pet turned into the wall and stayed there.** Walking toward a screen edge was
  clamped silently: `x` stopped, `targetX` stayed set, and the dino stood with its nose
  against the edge facing outwards, forever. The wall now ends the walk — it flips to
  face the room, pauses a beat, and picks a new target. Standing at an edge with
  nowhere to go (after a drag, a throw or a pause) also faces inward, and a thrown pet
  bounces off the edge instead of sticking to it. Cursor-following targets are clamped
  to the pet's own floor bounds rather than the raw screen.
- `--edge-test` proves it headlessly: `right edge: x=1840 facing=left`, `left edge:
  x=80 facing=right`.

## [0.24.0] — 2026-10-25

### Added

- **The menu bar icon is the dino, and it turns the pet on and off.** The status item
  used the built-in `idle` sprite, which a pack does not have — pack users got a blank
  slot. It now uses the pack's own idle frame, **cropped to the character's bounds** so
  the menu bar gets the dino and not a corner of empty canvas, drawn nearest-neighbour
  and dimmed while the pet is off.
- The menu is rebuilt each time it opens (a stale checkmark is a lie) and carries
  Hide/Show, size, pet, mute, gallery and quit. Right-clicking the pet offers the same
  switch.
- **Off is a real stop:** windows ordered out, the 30 Hz timer invalidated, and the
  events file skipped rather than queued — turning it back on after an hour does not
  replay an hour of bubbles. The choice persists in `config.json`, so a login start
  leaves a hidden pet hidden.
- `pet install --login` now runs on this machine, so the pet is there after a reboot.

### Verified

- `--toggle-test` (headless, no screen-recording permission needed) prints the icon id,
  writes the exact bitmap the menu bar is handed, and asserts the windows and timer
  follow the switch: `hidden=true window=false timer=false` → `hidden=false
  window=true timer=true`.

## [0.23.0] — 2026-10-25

### Fixed

- **The pet no longer walks on the spot.** Two separate causes, both real: a bubble
  or an in-flight tool call froze the body while `targetX` stayed set, so the pack
  kept playing `walk` for the rest of the session; and the walk cycle ran on the
  clock (12 fps) while the pet crept at 46 px/s, so the legs outran the ground even
  when it was moving. Walking is now a consequence of displacement — the animation
  only plays while the body actually moved this tick — and the walk cadence advances
  by **distance**, one cycle per stride (half a body width), so the feet stay
  planted on the floor they cover. Walking speed is 74 px/s instead of 46, which
  matches that stride.
- Reactions still play standing still: a dino that keeps marching while it talks to
  you reads as not listening.

## [0.22.0] — 2026-10-25

### Added

- **`lean`, `bounce` and `slump` — the last states that were still falling back to
  idle.** Reading and searching tilt the dino towards the thing it is looking at
  (`tool-read`, `tool-grep`, `tool-list`, `tool-webfetch`, `tool-lsp`, `tool-mcp`);
  editing, writing and running commands get a crouch-and-hop (`tool-edit`,
  `tool-write`, `tool-bash`, `typing`); and a filling context makes it sag toward the
  floor (`budget-low`, `budget-full`) instead of stretching.
- Twelve animations in the pack now — idle, walk, jump, dash, nod, sway, shake,
  stretch, turn, lean, bounce, slump — 45 frames, all from the artist's own pixels.

## [0.21.0] — 2026-10-25

### Added

- **Three more pack animations, still no new art.** `pet/pack-animations.mjs` now also
  derives `shake` (the sprite jerking sideways — failures), `stretch` (the body growing
  up from its feet — waiting on a slow task) and `turn` (squeezed edge-on, then mirrored,
  which reads as the dino rotating to face you when the agent needs an answer).
- Wired through the pack's `expressions` map: `shell-fail`/`oops`/`conflict`/`offline` →
  `shake`, `tool-task`/`subagent-wait`/`budget-low` → `stretch`, `tool-question`/`waiting`
  → `turn`. The dino now has nine animations: idle, walk, jump, dash, nod, sway, shake,
  stretch, turn.

## [0.20.0] — 2026-10-25

### Added

- **Three more animations for a pack, with no new art.** `pet/pack-animations.mjs`
  imports the sheet row the pack never took (`dash` — four frames with dust, copied
  cell-relative so the pose still rises where the artist drew it) and derives `nod`
  (the body squashing toward its feet) and `sway` (a shear that leaves the feet
  planted) from the pack's own idle frame. Colours, pixel blocks and baseline cannot
  drift because nothing is repainted. Each animation is wired to states through the
  pack's `expressions` map, so the dino now nods while thinking, sways when a slow
  shell command lands, and dashes while compacting. `--remove` takes them back out.

### Changed

- **Thoughts are now what the pet makes of its human, in caveman.** The reducer picks
  the sentence about the human (`user`, `they`, `asked`, `keeps`, `again`) over the one
  about the bug, says "human" instead of "the user", drops the grammar and bares the
  verb: "The user wants me to make the pet talk" → "Human want me make pet talk".
  Negations, `because`, names and numbers survive; unknown verbs are left as written.
  `"petThoughts": "verbatim"` keeps the model's own quoted sentence instead.

## [0.19.0] — 2026-10-25

### Changed

- **The bubble quotes the thinking instead of summarising it.** Thoughts are the
  model's own sentence, verbatim: code, markdown and the "The user wants me to…"
  bookkeeping are removed, emoji the font cannot draw are dropped, and the sentence
  is picked for **interest** — a question, an aside, a "hmm" or a "wait" outranks the
  opening line. That is the funny part, and a gist was throwing it away.
- Caveman is now opt-in (`"petThoughts": "caveman"`, or `pet think --caveman`) rather
  than the default. It reads well but it eats the voice this feature exists for.
- A thought may now run to five bubble lines (~95 characters) instead of one short
  clause, which is what quoting a real sentence needs.

## [0.18.0] — 2026-10-25

### Changed

- **The dino thinks in caveman.** Thoughts are spoken bluntly: articles, copulas,
  auxiliaries and pronouns are dropped and verbs are bared from a known list, so
  "The tests are failing because the cache is stale" arrives as "Tests fail because
  cache stale". Negations, names, numbers and `because` survive — the point is to be
  clear in fewer words, not to be cute at the cost of meaning. Unknown verbs are left
  as written instead of being chopped into new ones ("retir", "stor"), and a sentence
  made only of grammar comes back unchanged rather than leaving the pet silent.
- **Bubble text sits between the two earlier sizes.** 1.5× instead of 2× (too few
  characters per line) or 1× (too small to read): about 19 characters per line at 3×,
  so a caveman thought lands in two rows. Glyph edges snap to the screen's device
  pixels, which is what keeps a half-step scale crisp instead of smeared.

### Fixed

- `--snapshot` rendered a 260pt bubble no matter how big the pet was, which flattered
  every layout check; it now uses the app's own width, and `--bubble <pt>` overrides it
  to match a smaller pack.
- `babyzilla pet think "…"` now speaks the same caveman as a live thought (it went
  through no reducer before), so testing the voice tests the voice; `--raw` keeps the
  words exactly as typed.

## [0.17.2] — 2026-10-25

### Fixed

- **The bubble outline was open along the top.** Its frame was 2pt shorter than
  what `draw` paints: `measure` budgeted 16pt of vertical padding where the box
  uses 9pt top and bottom, so the top stroke landed just outside the view and was
  clipped away. Frame height and drawn box now share one set of constants, so they
  cannot drift apart again.
- **A removed pet came back on the next install** whenever the pet had saved its
  config in between. The `retired` mark lived in `config.json`, which the app owns
  and re-encodes from a fixed struct — so a drag, a size change or a quit deleted
  the mark. Marks now live in `~/.opencode/pet/retired.json`; older marks migrate
  out of `config.json` on first read.
- Thought dots were sliced by the bottom edge of the bubble view; both dots now sit
  inside the tail band.

### Changed

- **Smaller bubble text, more of it.** The glyph scale is one step down at every pet
  size (at 3× that is 14 → 29 characters per line), and a bubble wraps to five lines
  before it truncates. A thought now fits instead of being chopped mid-sentence.

## [0.17.1] — 2026-10-25

### Fixed

- **`pet install` resurrected a pet you had removed.** It copied the built-in art
  back and cleared the mark, so removing a pet survived only until the next update.
  Install now skips retired pets (`skipped babyzilla (removed …)`) — a removal is a
  decision, not a missing file.
- **A thought or line could be "sent" and never seen, with no way to tell.** The app
  now writes `last-bubble.json` when a bubble reaches the screen, and
  `pet think` / `pet say` report `shown at 21:36:04 (thought)` — or `not running` /
  `queued` — instead of assuming the append was read.

### Added

- `babyzilla pet restore <name>` copies a removed pet's art back, built-in or
  bundled pack.

## [0.17.0] — 2026-10-25

### Added

- **The pet thinks out loud.** On every request it shows one short line distilled
  from the newest assistant reasoning, in a quieter bubble with dots instead of a
  tail — the thought that led to the step about to run. `lib/pet-thought.mjs` does
  the reduction locally (no model call, no tokens): code, markdown, links and
  anything the pixel font cannot draw are dropped; one sentence is kept; the
  throat-clearing ("Let me…", "The user wants me to…") is stripped; the result is
  clipped at a word and admits the cut. One thought per step, 2.6s throttle, never
  the same line twice, only the newest reasoning, never while the pet is speaking.
  Off with `petThoughts: false`.
- `babyzilla pet think "text"` and `pet say "text"` for trying it without a session;
  `--snapshot --thought` renders the thought bubble offscreen.
- **`babyzilla pet remove <name>`** deletes a pet you do not use, built-in or pack.
  It refuses to remove the pet you are wearing (that would leave a blank window on
  the next launch), hides it from `pet packs`, and `pet use` points at the restore.
  `pet install` puts the art back and clears the mark.

### Fixed

- **The bubble never advanced past its first line.** Its alpha was driven through
  an `NSView` animator proxy that no-opped (alpha stayed 0), so the fade-out — and
  therefore `orderOut` — never ran and `isVisible` stayed true forever. Every queued
  line and thought sat behind it. Alpha is now stepped in the tick loop and
  visibility is tracked explicitly, so lines play in order and a thought cuts short
  when something is actually said. Found with `BABYZILLA_PET_DEBUG=1`, which traces
  the bubble's alpha/queue state.

## [0.16.2] — 2026-10-25

### Added

- **`pack-expressions.mjs --remove`.** Faces are a layer on top of a pack, not part
  of it, so taking them back out is a command: it deletes the face frames, their
  animations and the `expressions` map, and leaves `pack.json` and every frame the
  artist drew untouched. Running it twice is a no-op, and the test suite now proves
  both the round trip and the idempotence.

### Changed

- The Lil Dino pack is back to its three animations (idle/walk/jump); reactions use
  the pre-0.16 heuristic again (a jump for energetic ids, idle otherwise).

## [0.16.1] — 2026-10-25

### Fixed

- **The first pack faces did not read.** Reviewing the frames as a viewer sees
  them (a 2x2 eye, a 1px nudge) showed most of them were unreadable noise. Rewritten
  around what actually carries an expression at 24x24 — the mouth: `happy` opens a
  second row with teeth, `angry` flattens the tooth row and adds a 2px brow,
  `surprised` replaces it with a hole, `hurt` breaks the grin and screws one eye
  shut. `sleep` is gone (it was a blink with cosmetic changes) and its expressions
  now use the closed-eye face; a floating `z` pixel that read as debris is gone.
- Orphan frames from dropped faces are deleted instead of lingering in the pack
  (the app loads every PNG and the installer copies them).

## [0.16.0] — 2026-10-25

### Added

- **Faces for packs.** `pet/pack-expressions.mjs` authors six expressions on the
  pack's own pixel grid — `blink`, `happy`, `angry`, `surprised`, `hurt`, `sleep`
  — by editing the eye, brow and tooth row of the idle frame, each with a 1px beat
  so it holds up when the app loops it. The palette is derived from the pack, so
  the same edits work on any pack and cannot blank a frame whose colours differ.
- **An expression map.** Every one of the 100 expression ids now resolves to a
  face (54 idle, 16 happy, 9 sleep, 8 angry, 7 hurt, 5 surprised, 1 blink), and the
  app plays the pack's face for the duration of the reaction instead of showing
  the same idle sprite for everything.

### Fixed

- **A pack played the same face for every reaction.** `setExpression` collapsed
  any id without a matching sprite to `"idle"`, so the pack's expression map never
  saw the real id.
- **The event watcher could miss appends** when the pet had created
  `events.jsonl` itself: the DispatchSource did not always fire for that case. A
  size check every half second now backs it up.
- **`pet install` / `pet start` claimed success without checking.** They now poll
  for the pid for up to nine seconds (macOS can be slow to launch a freshly
  rebuilt binary) and fail loudly; `pet stop` also clears strays for the default
  state dir, which a crashed or `--capture` instance leaves behind.

## [0.15.0] — 2026-10-25

### Added

- **Sprite packs: a second pet.** A pack is another look for the same pet — same
  reactions, bubbles and event bridge, different art. Packs carry whole
  animations (`idle`, `walk`, `jump`) rather than one sprite per expression,
  which is the shape a hand-drawn or third-party sheet actually has, and the only
  way to get a real walk cycle: legs move when the sheet was drawn for it. The app
  picks an animation by state — idle when still, walk while travelling, jump when
  the pet is excited or airborne.
- `pet/pack.mjs`: build a pack from a grid sheet (`--cell`, `--crop`, `--rows
  idle,walk,jump`, `--upscale`). Cells are copied cell-relative, so a jump that
  rises in the sheet rises in the app. `pack.json` records animations, frame rate,
  canvas size, default scale, source and license.
- `babyzilla pet packs | use <name> | start | stop | --help`. Switching rebuilds
  the windows and sprite library in place and keeps the position. `pet install`
  copies installed packs; the right-click menu has the same switch under **Pet**.

### Fixed

- **A config missing one key reset everything.** `PetConfig` used the synthesized
  initializer, so a hand-edited `{"pack": "lil-dino"}` threw and the loader fell
  back to defaults — losing the pack, the size and the saved position at once. It
  now decodes field by field.
- **The single-instance guard could be fooled by a stale pid**, letting a second
  pet run against the same state dir (and leaving a stale `pet.pid` behind). It
  now holds a `flock` for the process lifetime, which the kernel releases however
  the pet dies, and `pet.pid` is removed on exit.

### Notes

- Pack art built from someone else's sprite sheet is not ours to redistribute:
  the builder writes packs to `~/.opencode/pet/packs/` and the repo ignores
  `assets/pet/packs/`. Only the builder ships.
- 2 new tests (252 total): the pack builder against a synthetic sheet, and the
  `packs` / `use` CLI.

## [0.14.2] — 2026-10-25

### Changed

- **Smaller by default.** 2× (128 px) instead of 3×; the right-click sizes are
  now 1× / 2× / 3×, and the speech bubble scales with the pet instead of sitting
  at a fixed 260 px.
- **It hops instead of walking.** The four "walk" frames were pinned by the
  prompt — `front view, perfectly symmetric design` makes it impossible to move
  a leg — so all four came out with identical legs, and cycling them was a
  twitching statue sliding across the screen. Travel is now a four-beat hop
  (crouch → push → apex → land) whose cadence is derived from distance travelled,
  so the feet leave the ground and nothing skates. The idle breathing bob is
  suppressed while a locomotion frame is showing, so the two motions do not add.

### Added

- `walkPrompt`: a walk variant without the symmetry phrase, conditioned on the
  master, for frames whose legs must differ.
- 1 new test (250 total): every `loco-*` sprite named in the Swift app must exist
  as art, and every catalogue expression must have a sprite — a typo would
  otherwise fall back to `idle` and read as a broken animation.

## [0.14.1] — 2026-10-25

### Fixed

- **`pet install` no longer kills a pet from another state dir.** It used
  `pkill -f BabyZillaPet`, so any install — including the one the test suite runs
  against a temporary state dir — took down the pet on your screen. It now kills
  only the pid recorded in that state dir's `pet.pid`, after verifying the
  process command, and only `pet status` reading the same file can report it as
  running.
- 1 new test (249 total): an install in a temporary state dir must leave another
  pet running.

## [0.14.0] — 2026-10-25

### Added

- **A desktop pet.** `babyzilla pet install` builds a small native macOS app
  that lives at the bottom of the screen: it wanders, hops, turns at the edges,
  and reacts to what OpenCode is doing. It reads
  `~/.opencode/pet/events.jsonl`, which the plugin appends to on prompt, tool,
  compaction, budget and error events. No sockets, no ports, no daemon — if the
  pet is closed the plugin writes a few bytes, and a pet started late reads from
  the end of the file.
- **100 expressions**, each a 64×64 sprite on a locked 16-colour palette, plus a
  procedural motion class (`bob`, `pop`, `shake`, `float`, `still`) and speech
  lines. `babyzilla pet list` prints them; `babyzilla pet emit <id>` triggers one
  live; `babyzilla pet gallery` opens a field guide.
- **A pixel speech bubble** (hand-authored 5×7 font, no system text), with a
  message budget: important events speak (compaction results, context pressure,
  tool failures, updates, slow-success celebrations), routine tool calls do not,
  and bursts coalesce instead of stacking.
- **A native AppKit app** instead of a web view: a non-activating transparent
  panel (poking it never steals focus), 30Hz physics, nearest-neighbour blitting,
  drag/throw with gravity and landing squash, click-to-poke, right-click menu
  (size, mute, chattiness, gallery, quit), menu-bar icon.
- **Art pipeline** (`pet/`): mflux generation from one master reference, chroma
  key, box downscale, palette quantisation, ink outline, baseline alignment, and
  a contact sheet for review. `pet/manifest.json` keeps the seed and prompt for
  every sprite, so any one is reproducible. The PNG codec is in-repo, so the
  pipeline has no native dependencies.
- Pet state is isolated (`BABYZILLA_PET_STATE`) so tests never touch the real one.

### Notes

- Faces are generated conditioned on a master sprite, which is what keeps 100
  separately generated images on-model. Body poses cannot move under that
  conditioning, so locomotion is generated from the same seed without a
  reference — that is the one place the pose is free.
- The plugin emits pet events by default (`"pet": false` or `BABYZILLA_PET=0`
  turns it off). On non-macOS hosts there is no app to read them, so the only
  cost is a small append.
- 9 new tests (248 total): catalogue shape, every mapping target exists, tool
  classification, bridge JSONL + rotation + failure isolation, CLI list/emit/
  status, and sprite invariants (64×64, ≤16 colours, clean border, shared
  baseline).

## [0.13.1] — 2026-10-25

### Fixed

- **Windows: permission rules never matched.** `permission` values are written
  with `/` (`~/.opencode/contextpacks/**`) while a Windows home is
  `C:\Users\x`, so the inspector compared `\.opencode\` against `/.opencode/`
  and reported "not allowed" for a rule it had just written — the wizard would
  re-add the same rule on every run (and the self-test disagreed with itself).
  Separators are now normalized on both sides, and written patterns always use
  `/`.
- **Windows: `babyzilla` on PATH was reported as missing.** npm installs
  `babyzilla.cmd` (and `.exe`/`.ps1`) there, never a bare `babyzilla`.
- Test fixes for Windows: file modes are meaningless there (the atomic-write
  test now skips the mode check), and `test/updates.test.mjs` built its path
  from `URL.pathname`, producing `D:\D:\a\...` instead of `D:\a\...`.

## [0.13.0] — 2026-10-25

### Added

- **`babyzilla setup` — a wizard for the things that actually break an
  install.** Reads the real OpenCode config, reports what is missing, shows the
  exact changes, and writes them with a `.bak-<timestamp>` only after you say
  yes. It can change exactly four things:
  - the `plugins[]` entry (registers BabyZilla; supports the v2 object form and
    the legacy tuple form);
  - `permission.bash` allows for `babyzilla recall *` / `babyzilla retrieve *`
    — without these, every recovery of paged-out output prompts, and under a
    `deny` the detail is unreachable;
  - `permission.external_directory` for `~/.opencode/contextpacks/**`, so the
    agent can open a module file by path;
  - the `selfLearn` / `checkUpdates` switches.
  No `webfetch`, `websearch`, `edit` or broad `bash` is requested.
- **Comment-preserving config editing** (`lib/jsonc.mjs`): parse JSONC with
  byte spans, splice only the edited values. Comments, key order and formatting
  survive, and new permission rules are appended — required because OpenCode
  evaluates them last-match-wins, so an allow must come after the broad rule it
  is an exception to. A deliberate `"*": "deny"` is preserved as the wildcard
  and called out, never silently loosened.
- **Self-test in the wizard**: data-dir write, a real compression round-trip
  (must shrink and carry a recall handle), a page write/read round-trip, and a
  `PATH` check. Offline, no model calls. `--check` runs just this.
- Flags: `--yes`, `--dry-run`, `--check`, `--json` (never prompts, never writes
  without `--yes`), `--config PATH`, `--no-recall`, `--no-external`. Non-TTY
  runs print the plan instead of hanging on a prompt.
- The newer ordered `permissions: [{action, resource, effect}]` form is
  detected and gets appended allow rules instead of a `permission` object.

### Notes

- A one-line config is pretty-printed instead of spliced into (it has no
  comments to preserve, and splicing newlines into one line is unreadable).
- 23 new tests (239 total): the JSONC editor on comments/trailing commas/CRLF,
  rule resolution with wildcards and last-match-wins, the plan for every config
  shape, idempotency, backups, and two end-to-end CLI runs.

## [0.12.0] — 2026-10-25

### Added

- **Daily update check, with consent.** Once per 24h BabyZilla asks GitHub
  Releases for the newest tag (one unauthenticated request, cached in
  `contextpacks/update.json`). If there is a newer version:
  - the agent gets one synthetic note per day (across all sessions): mention it
    in a single line, ask whether to update, and run `babyzilla update --yes`
    only if the user agrees;
  - the CLI appends a one-line `⬆ BabyZilla vX is available` notice after a
    command (TTY only, never in `--json` output) and refreshes the cache in a
    detached process, so a CLI-only machine also checks.
  Nothing is ever installed without an explicit yes.
- `babyzilla update [--check] [--yes] [--json]`: check now; on a git checkout,
  `git pull --ff-only` after consent; otherwise print the exact install
  commands and change nothing. Non-TTY runs never block on a prompt.
- `lib/updates.mjs`: semver comparison (pre-release aware), 24h cache with a
  1h retry backoff after failures, and a merge-write so a failed check never
  erases the last known verdict or the notice stamps.
- Opt out with `checkUpdates: false` or `BABYZILLA_NO_UPDATE_CHECK=1`
  (the suite sets the latter so tests stay offline). `BABYZILLA_UPDATE_URL`
  overrides the feed for mirrors and tests.

### Notes

- Offline is silent: a failed lookup is a timestamp, not an error, and the
  previous "update available" verdict stays visible instead of flickering off.
- Long-running opencode processes need no restart: the prompt hook refreshes a
  stale cache in the background (never on the request path).
- 11 new tests (216 total): version matrix, cache TTL/force/backoff, notice
  throttle per surface, a real two-clone `git pull` update, the CLI against a
  local feed, and the hook notice with `checkUpdates:false` and the kill switch.

## [0.11.2] — 2026-10-25

### Fixed

- **The documented install command fails on npm 12.** npm 12 ships
  `allow-git=none` (and `allow-remote=none`), so `npm i -g git+https://…`
  exits with `EALLOWGIT`; a tarball URL fails with `EALLOWREMOTE`. README and
  AGENT-INSTALL now use the per-command `--allow-git=all` form and document a
  zero-flag clone install (`npm i -g <clone>`, updates with `git pull`). Both
  paths were verified on npm 12.0.1 / Node 26, including a replay verdict run
  from the installed copy.

## [0.11.1] — 2026-10-25

### Fixed

- **The published package omitted `bench/`.** `npm i -g git+…` (and any
  registry install) shipped `lib/`, `bin/` and docs but not `bench/`, so the
  deterministic verifier could not find `bench/replay.mjs` and every
  provisional knob would have deferred instead of being decided. `bench/` is
  now part of the package, and a packed-tarball install is exercised before
  release (status + a real replay verdict from the installed copy).

## [0.11.0] — 2026-10-25

### Changed

- **Verification is now a deterministic replay, so good knobs can actually be
  kept.** The dollar bench measured a 24.6% A/A noise floor on this task shape
  (v0.10.1), which meant no safe knob could ever clear the gate and the loop
  could only revert. `bench/replay.mjs` runs the real compression pipeline
  (`lib/text.mjs`) twice over a fixed 18-step transcript — baseline knobs
  versus the proposal — and compares prompt bytes, which are a pure function
  of transcript + knobs. Exact, repeatable, free: no model calls, no credits.
  Keep requires: prompt tokens fall (or peak context does), neither metric
  worse by more than 2%, all guards hold, and the knob stays within 35% of its
  documented default (anti-ratchet). `selftune verify --live` still runs the
  dollar bench for end-to-end quality evidence.
- The planner runs the replay inline after the 24h grace window, so a
  provisional knob is settled by evidence instead of waiting on a noisy bench.
  `distillBudgetDefault` is excluded from the default allowlist: a smaller
  budget always feeds fewer tokens, but the summary-quality loss is invisible
  to both benches, so the loop must not move it.
- The analysis prompt now states the replay objective and passes the live A/A
  floor as context only.

### Fixed

- **The live user's message could be condensed as "historical bulk".** The
  bulk-user gate excluded `i >= turnStart`, but `turnStart` is the index
  *after* the newest user message, so the message the agent was answering was
  eligible. A fresh 40K-token paste was rewritten on the first request.
- **User prose was compressed like a tool dump.** `compactPart` applied
  line-based structural trimming to every text ref, so a single-line 100KB
  user message collapsed to its first 240 characters — the ask deleted. Prose
  now gets head+tail characters only; tool output keeps structural trimming.
  Both are covered by the replay's `liveUserKeepsEnds` guard.

### Added

- `bench/replay.mjs` + `judgeReplay`: deterministic verification with
  recoverability, prefix-stability and live-user guards; 2 new tests
  (22 in the self-tuning suite, 205 overall).
- `lib/defaults.mjs`: plugin defaults moved into a pure module so the replay
  measures the real configuration instead of a drifting copy.

## [0.10.1] — 2026-10-25

### Fixed

- **The first A/A noise measurements were invalid in two ways.** (1) A leg that
  died after 2 requests (provider-side abort) was still scored against its
  completed pair, recording a 44.09% "noise" floor (66.64% gate) that would
  have frozen every keep decision. (2) Identical fixtures mean the second leg
  of a pair reads the first leg's prompt cache — 96K → 52K uncached input in
  the first complete pair — so a run with only one surviving leg order reports
  ~40% "savings" that are pure warm-up; the second run produced 40.62%. Noise
  samples now come only from marker-complete, work-matched reps with **both**
  leg orders present (the per-order means cancel warm-up); an invalid run
  records nothing and exits non-zero. The noise bench now defaults to 4 reps,
  and `judgeVerify` defers a verdict whose payload has one order. Both bogus
  samples were discarded locally. First honest measurement: **24.57% → floor
  37.36%** (3 valid reps), i.e. the live agentic bench cannot resolve small
  knob effects — such proposals are reverted by design (documented in README
  and `bench/RESULTS.md`).
- **A failed baseline leg no longer reverts a live knob.** `judgeVerify` treated
  any missing marker as a quality failure, so a provider hiccup on the OFF leg
  could revert a proposal that had real evidence behind it. A baseline-leg miss
  now defers (retry scheduled, pending knob untouched); only an ON-leg miss —
  baseline completed, proposal did not — is a quality verdict.

### Tests

- `noiseSample` contract: aborted/marker-missing legs never contribute; mixed
  runs keep the valid reps (`test/selftune.test.mjs`).
- `resolveVerify` deferral on baseline-leg failure; ON-leg failure still
  reverts. Self-tuning suite: 20/20.

## [0.10.0] — 2026-10-25

### Added

- **Self-tuning loop (v0.10).** The plugin now closes its own feedback loop:
  per-session telemetry (`selftune/sessions.jsonl` — billed tokens/cost from
  OpenCode's DB, cache resets, recall counts, duplicate calls, paging volume,
  distill diet; plus CLI-appended `selftune/recalls.jsonl`), then — after
  `selfLearnSessions` new sessions and ≥ `selfLearnIntervalHours` hours — one
  cheap analysis call proposes at most one numeric knob change, inside a hard
  clamp table (`lib/selftune.mjs` `KNOBS`), capped at a 35% step and an
  optional `selfLearnKnobs` allowlist. Proposals apply provisionally (state +
  ledger + live options), are verified by a marker-gated plugin-vs-plugin
  bench run (`bench/ab-live.mjs --both-plugins` with baseline values on the
  OFF leg), and are kept or automatically reverted; the acceptance bar is
  marker-found-in-every-leg, equal step counts, and a paired cost delta beyond
  the measured A/A noise floor (`selftune noise`). A recall storm while a knob
  is provisional triggers an emergency revert without a bench. Analyst model:
  `selflearnModel` or the session's own (free on `opencode`-tier models).
  CLI: `babyzilla selftune status|verify|noise|revert|baseline`. Freeze switch:
  `BABYZILLA_SELFTUNE_DISABLE=1` (the bench sets it for its own children).
  Prompts, contract text, routing, algorithms and code are structurally
  unreachable — the analyst moves numbers only.
- **Character-window compression for dump-shaped outputs.** The line-based
  compressor gave up on minified JSON, bundled JS and one-line command dumps
  (a live session measured `193.4K → 189.9K tok, 2% smaller` on a 193K-token
  prompt). Two fixes: kept lines longer than ~240 chars are folded, and
  few-huge-lines results go through a character window (~3K head/~1.2K tail
  chars). Deterministic and byte-stable like the rest of the stable path.
- **Distill diet (`distillBudgetDefault`, default 16K).** The distillation
  call billed its own tokens per compaction, and the derived cap was 48K
  (40% of the window). One compaction of a dump-heavy session was an
  uncached ~48K-token bill by itself, on the same credits as the session.
  Now capped at 16K; small-window models still clamp to 40% of the window;
  explicit `distillBudgetTokens` unchanged.
- **Cheaper size gate: `stableMinTokens` default 4000 → 2000.** Results in
  the 2-4K-token range are exactly the steady-state tail that re-bills
  uncached on every request.
- **Cache-reset telemetry in `bench/ab-live.mjs`** (`cache resets` /
  `wasted on resets` rows, `lib/cost.mjs` `cacheResets`): requests whose
  cached prefix read falls below a previous best are now counted and
  attributed to the provider, so ambient evictions stop looking like
  tuning opportunities.
- **Evidence: the request-#2 spike is not plugin content.** Rep 2 of the
  10×24KB run bills 11.1K uncached / 3.2K cached at request #2 while the
  plugin-visible payload there is ~1K (one compressed result + tool call).
  The rest is the provider cache warming over the system+schema prefix.
  The contract note (once, ~230 tokens) and module attaches (≤6K, gated on
  trigger keywords) are confirmed small.

- **Prefix-stable compression (`stablePrefix`, default on).** Tool results are
  compressed from their own bytes only, at request-build time, and never
  revisited — so an already-sent prefix serialises identically on every later
  request and the provider's prompt cache keeps hitting. The previous
  budget/position policy rewrote a different slice each request, which turned
  cheap cached input into full-price input: measured on Ollama Cloud, −45%
  tokens produced **+4% credits**. Stable mode measured **−46.6% credits**
  (−50% prompt tokens, −49.9% peak context, task success 6/6 in both arms).
  Options: `stableMinTokens` (size gate, default 4000) and
  `stableOverflowRatio` (default 0.9 — the budget pass now runs only as an
  overflow valve near the model window). `stablePrefix: false` restores the
  old behaviour.

- Capability-aware vision routing: when a prompt carries images, BabyZilla now
  checks whether the user's *selected* session model accepts image input
  (`ctx.catalog.model.get` → `capabilities.input` includes `image`). It does —
  the model reads its own pixels and no delegation note is sent. It doesn't (or
  the identity/shape is unknown) — the note to the `vision` subagent is sent
  exactly as before. The user picks the main model; the router adapts.
- `distillModel` now defaults to unpinned: set `distillModel: null` (the
  default) and distillation runs on the model the user actually selected
  (`event.model`), with the window taken from that model's limit. Pinning one
  model explicitly remains supported for setups that want a fixed lane.
- Model knowledge base for Ollama Cloud (`lib/modeldb.json` + `lib/modeldb.mjs`
  + `docs/MODELDB.md`): 22 entries covering caps, context, usage class, verified
  behaviors and use-for/avoid-for guidance; `priceForId` delegates to
  `lib/cost.mjs PRICES` (three missing rows added: minimax-m3.1-flash,
  mistral-large-4, muse-spark-open). New lane policies (`LANES`) degrade
  gracefully against the host catalog, and `catalogCompat()` flags unknown or
  vanished models both ways. CLI: `babyzilla models [--lanes|--json]`.

### Fixed

- Price table silently drifted from real billing. `PRICES` is now hydrated at
  load from OpenCode's own catalog (`~/.cache/opencode/models.json`), so numbers
  follow the metadata the host charges against instead of a hand-scraped page.
  Corrected by measuring actual billed spend across ~7k requests: all DeepSeek
  rows were 2x too high (v4.1-flash is $0.15/$0.003/$0.60), `mistral-large-4`
  2x too low ($1.36/$0.14/$4.18), `minimax-m3.1-flash` had a 2x-too-high cache
  rate ($0.015), and the nemotron rows invented cache rates (they bill at input).
  Added rows for nemotron-3-ultra/super and qwen3.5:397b.
- `babyzilla models --audit`: recovers the rate OpenCode actually charged per
  model (single-scale fit against the table's ratio structure; a full 3-param
  fit is collinear on this data) and flags drift at a 15% tolerance. Audit of
  all recorded spend now reconciles at 1.00x. Audited from per-request rows
  (`session_message`), not the `session` aggregate, whose token columns do not
  reconcile with the cost it records.
- **Docs/code drift, two real cases.** The eager size gate was documented as
  `toolResultEagerMinTokens` while the code read `toolResultEagerTokens` — a
  config copied from the old docs was silently inert. `toolResultEagerTokens`
  is now the documented name and the old spelling is accepted as an alias.
  Separately, `requestMinBudgetTokens` shipped as `10000` while README,
  OPTIONS and the library fallback all promised `12000`; the default now
  matches the documented floor (the conservative direction).

## [0.8.1] — 2026-10-25

### Fixed

- Windows CI: the vision-router decoded file attachments via
  `decodeURIComponent(url.pathname)`, which prepends a slash to Windows drive
  paths (`file:///C:/…` → `/C:/…`), so the routing note never contained the
  verbatim path. Path conversion now uses `fileURLToPath` (handles drive
  letters and malformed-URL skips), and file pointers are built with
  `pathToFileURL().href` — canonical on every platform — in
  `lib/distill.mjs` and the vision-route test fixtures.

## [0.8.0] — 2026-10-25

### Added

- **Vision auto-routing (Layer 0.5, `visionRoute` default on).** When a prompt
  involves image content — file attachments, concrete image paths in the text,
  or screenshot wording — the plugin sends a one-shot synthetic note before any
  module machinery: `[babyzilla vision-route] … delegate the visual work to the
  vision subagent`, carrying every verified readable path so the main model can
  spawn the subagent with exact paths. Never fires twice per prompt, never when
  the prompt already names the delegate (`vision subagent`),
  never with unverifiable paths, and silently skips when the configured
  `visionAgent` isn't in the agent catalog or the host lacks `session.synthetic`.
  Rationale: text-only main models receive a placeholder note instead of image
  pixels, so the route has to be established inside the prompt hook. Opt out
  with `visionRoute: false`; retarget with `visionAgent`.

### Fixed

- Test-cleanup race: per-file temp roots are now removed in a node:test
  `after()` hook instead of a module-level top-level `await`, which could fire
  mid-test and delete a seed image while the vision-route tests were running.

## [0.7.6] — 2026-10-24

### Added

- **Carry-in: warm session starts (opt-in `carryIn`).** On a session's first prompt,
  the plugin attaches the project library's hot modules (`state`, `decisions`)
  trigger-free — any wording of the first message opens the project warm instead of
  rebuilding file/search context from scratch. Attachments are labeled `[carry-in]`
  ("previous sessions — background only"), fire at most once per session (a
  `.carryin` stamp under `sessions/<sid>/`), and respect `maxAttach` /
  `attachBudgetTokens`. The re-audit (997K tok this session; in-session compression
  at ceiling: 8K+ results are 0.5% of calls but were 16% of raw tokens and are now
  paged; the 2–8K tail is not worth chasing) made session-start rebuild the last
  first-order lever. `promoteToLibrary` widened from tool/errors only to
  state/decisions/tool/errors (hot flag preserved on state/decisions), so the hot
  core actually reaches the library. `BABYZILLA_ROOT` env override now honored by
  the plugin core too, for sandboxed tests.

## [0.7.5] — 2026-10-24

### Added

- **Eager paging for any big tool result, by size — not by tool name.** Through the journal
  audit (48 sessions, ~19.9M journaled tool tokens): the top decile of `read` entries
  carries 73% of read tokens, one read entry was 1.55M tokens, and the largest MCP dump
  173K — while `shell`/`execute` is 20.7%. Layer 2b now compresses *any* single tool
  result over `toolResultEagerMinTokens` (default 8000 est. tokens, ~1.2× a routine read)
  at the source, paged via `babyzilla recall` (never deleted); the fixed
  read/grep/glob/list allowlist still applies when configured, and results under the
  threshold stay inline for free. Coverage without a name-list to maintain.

## [0.7.4] — 2026-10-23

### Fixed

- **The anchor now reaches the summary it was protecting.** v0.7.3 wrote
  `00-anchors.md` and listed it in the pack index, but rendered the visible
  compaction summary from the *pre-assembled* module list — so the newest
  exchange was on disk yet missing from the context the next reply actually
  saw. Promotion to the library used the same stale list.
- **Best-of-N can no longer pick the anchorless pack.** When the model-only
  candidate tied the anchored one (and it ties whenever fuzzy `askOk` already
  passes), the size tie-break chose it and silently dropped the anchor. The
  anchor is now a guarantee, not a candidate: re-attached after ranking when
  the winner lacks it.
- **The reply's tail survives the anchor's own budget.** `trimExchange` limits
  each half to a shared 1800 chars, but the summary renderer capped the
  *assembled* anchor at 3200 head-truncated chars — long exchanges lost the
  closing question. The summary cap is now derived from the anchor's bound,
  and the reply mathematically keeps the larger half (990 vs 810).
- **`kind-name` collisions stopped corrupting pack listings.** A `tool` and an
  `errors` module sharing a slug overwrote each other's entry in the files
  map (and `index.json` points at the file that is actually on disk now).
- **Recovery runs against the final pack.** `missingFactsModule` previously
  scored the winner before the anchor was re-attached, so recovery could
  re-add lines the anchor verbatim already holds.

### Added

- **The compaction hook is under test.** A new integration suite loads the
  real plugin with a canned distiller and asserts on what leaves the hook —
  verbatim tails in the summary, module files on disk, metadata counts. The
  139 green tests that kicked this off never touched the wiring; now the
  wiring itself is the assert.

## [0.7.3] — 2026-10-23

### Added

- **The last exchange can no longer be lost.** Every pack now starts with
  `00-anchors.md`: the newest user request, the one before it, and the reply
  they answered — copied verbatim from the messages, never written by the
  model. A distiller cannot drop what it was not asked to produce. Disable with
  `distillAnchors: false`.
- **Dropped coverage is filled back in.** Before a pack is written it is scored
  against the transcript it replaces; pointer and fact coverage the distiller
  missed is appended as a short module (`00-recovered.md`). Disable with
  `distillRecovered: false`.
- **`babyzilla eval [session]`** scores any existing pack the same way offline
  and lists what is missing, so a distiller change can be measured instead of
  guessed. Bounded by `evalMaxChars` (400K chars), above which the scan is
  skipped because a multi-MB history costs more to score than it saves. See
  [`examples/pack-eval.md`](examples/pack-eval.md).

## [0.7.2] — 2026-10-22

### Fixed

- **A "yes" could land with no question in sight.** Under budget pressure the
  assistant's own reply — the message that ends with "Want me to …?" — was
  replaced by a bare pointer marker, so the very next turn had nothing to
  answer. Replies are now compressed head+tail like any text (the closing
  question survives) and are never reduced to a pointer, and `requestHardProtect`
  defaults to 2 so the question stays in the protected window.
- The test that guarded assistant messages passed a stale option name
  (`requestBudget`, not `requestBudgetTokens`), so it never exercised a budget.

## [0.7.1] — 2026-10-18

### Fixed

- **`babyzilla recall` was a silent no-op through a symlink.** The CLI's main
  guard compared `import.meta.url` with the raw `argv[1]`, so
  `~/.local/bin/babyzilla -> bin/babyzilla.mjs` matched nothing and the process
  exited 0 with no output. Every `babyzilla recall <hash>` hint printed by a
  marker or a ledger row therefore did nothing. Both sides are now realpathed.
  Regression test spawns the bin through a symlink.
- Recall handles are only advertised when the bytes are actually paged: a
  synthetic `call_…`/`i3` id is no longer printed as if it were recallable.

### Changed

- README banner shrunk to `smslant` (47 cols) and moved to the very top; the
  layer overview is now six layers in execution order.
- `AGENT-INSTALL.md` documents the `~/.local/bin` symlink and how to verify it.

## [0.7.0] — 2026-10-18

### Added

- **Layer 3: deterministic turn ledger.** Old tool steps no longer become
  anonymous "elided" markers. Each one collapses to a row built from the call
  itself — `#12 · bash · npm test · exit 1 · 3.1K tok · recall 8c1f…` — so the
  transcript stays an index of what was already tried. No model call, no drift:
  tool, target, exit status and size all come from the call. The newest
  `requestLedgerKeepTokens` (8K) / `requestLedgerKeepRecent` (5) results stay
  byte-for-byte.
- **Bulk historical user context.** A *historical* user message above
  `requestUserBulkMinTokens` (32K) is condensed to its opening, the lines that
  read like constraints, and its closing, plus a recall handle. The **live**
  user message is never touched. This is what harness checkpoints and pasted
  transcripts are made of; in practice it was 92% of the request.
- Options: `requestLedger`, `requestLedgerKeepRecent`,
  `requestLedgerKeepTokens`, `requestLedgerMinTokens`,
  `requestCompressUserBulk`, `requestUserBulkMinTokens`,
  `requestUserKeepTokens`, `requestUserHeadChars`, `requestUserTailChars`.

### Changed

- `requestMinSavingsPct` default 12: a rewrite that saves less is rolled back,
  so the prompt stays cache-stable instead of churning.
- `requestBudget()` is exported: the 8% / 12K floor / 45K cap interaction is now
  covered by tests instead of only by docs.

### Fixed

- Markers no longer advertise handles that cannot be resolved. Loop indexes
  (`i3`) and raw call ids (`call_…`) are not persisted by OpenCode, so only a
  real 16-hex page hash is printed as `babyzilla recall <hash>`.

## [0.6.0] — 2026-10-18

### Added

- **`babyzilla recall <hash>[:start-end]`** — paging is now reversible. Every
  elided block is written to a content-addressed page store
  (`~/.opencode/contextpacks/pages/`) before it is replaced, and the marker
  carries the handle. Works for **every** tool, including shell/grep output
  that cannot be re-read from a file. Falls back to the OpenCode database
  (`callID` / part id / message id) for older sessions.
- **Recovery contract.** The first time a request is paged, the model is told
  once what happened, what is preserved, and how to recall exact text — instead
  of discovering redactions marker by marker.

### Fixed

- **The working set is protected by tokens, not message count.** A single
  agentic turn can contain hundreds of tool results; protecting "the last 6
  messages" elided files the agent was still editing. The newest
  `requestTurnProtectTokens` (40K) of the current turn now stay verbatim, and
  the protected set is only structurally compressed when the budget requires
  it — never blanked or reduced to pointers.
- **No more re-read loops.** The newest result per file/command is never
  source-compressed, small results (< `toolResultMinTokens`, now 4000) are left
  alone, and source compression is deferred to the next user turn.
- **Near-no-op rewrites are rolled back.** A pass that saves less than
  `requestMinSavingsPct` (12%) restores the original messages, so the prompt
  prefix and the model's view stay stable (47/1147 passes previously saved
  <10%).
- **Proactive compaction waits for a turn boundary** — it no longer fires
  between a tool call and its result.
- **Reasoning removal is announced** (`[ContextPack] older reasoning elided`)
  instead of silently blanking it.

### Changed

- `requestTargetRatio` default is now documented as `0.08` (code default since
  v0.5.2).
- `toolResultProtectRecent` default `1` → `3`.
- `babyzilla prune` also prunes the page store.

## [0.5.2] — 2026-10-18

### Fixed

- **Any model, any window.** Layer 1b clamps its budget to the model's own
  context window (`requestMaxPromptRatio`, default 0.5). An 8K/32K local model
  no longer gets a 45K message budget it cannot hold. Distillation input scales
  with the window (40%, capped at 48K) instead of a fixed 48K that small models
  cannot accept; `distillBudgetTokens` overrides it.
- **Non-ASCII token estimates.** `estTokens` counts CJK/Cyrillic/emoji at ~1
  token per character instead of 4 chars per token, so Chinese/Japanese sessions
  no longer slip past the budget by 3-4x.
- **Tool/message shapes.** Persisted tool parts (`state.output`) are counted,
  compressed and elided like the API shape (`state.content`); source-level tool
  compression accepts both. System/developer turns are never rewritten.
  Attachments drop their provider fields (`url`, `mime`, `source`).
- **Signed reasoning.** Reasoning whose signature lives in `metadata` is
  preserved instead of blanked.
- **`babyzilla cost`.** Falls back to the `session` table on OpenCode versions
  without `session_v2`, honors `XDG_DATA_HOME`/`LOCALAPPDATA`, and explains
  itself when no usage table exists.
- **Windows paths.** Attachment URIs use `pathToFileURL`, and
  `retrieve file:///C:/…` no longer mangles the drive path.

## [0.5.1] — 2026-10-18

### Fixed

- **Cross-platform startup.** Layer 2 no longer depends on a POSIX shell:
  lowfat is located with `where` on Windows (`command -v` elsewhere) and
  invoked via `execFile` instead of a shell-quoted string. Homebrew and
  Windows install locations are probed; a missing lowfat still only disables
  Layer 2.
- **CI on macOS/Windows.** `npm test` expands `test/*.test.mjs` in Node, so the
  suite also runs under cmd.exe, and the `node:sqlite` test is skipped below
  Node 22.5. The matrix now covers Ubuntu, macOS and Windows.

## [0.5.0] — 2026-10-18

### Added

- `babyzilla cost [sessionID] [--limit N] [--json]` — provider-side spend from
  OpenCode's own usage records (`session_v2`): input, cached input, output,
  cache-hit rate, and cost estimated at list prices next to the recorded cost.
  Layer 1b's `request-stats.json` counts *message* tokens; this closes the loop
  with what the provider actually billed. Uses `node:sqlite` lazily, so the
  rest of the CLI still runs on older Node versions.

## [0.4.0] — 2026-10-18

### Added

- **Layer 1b — hard per-request budget** via OpenCode v2's
  `session.hook("context")`. BabyZilla previously only acted at compaction, so
  models with huge windows (Kimi K3: 1M tokens) could run entire sessions
  without the plugin ever firing. The new hook runs before every request:
  once the budget is exceeded it compresses old tool results, assistant prose,
  reasoning and attachments in place, then reduces the oldest parts to
  one-line pointers. It targets `requestTargetRatio` (10% of the incoming
  context, floored at 12K) and caps at `requestBudgetTokens` (45K). Measured
  on a 1.13M-token Kimi-K3 session: **1,129.6K → 44.9K tokens (96% smaller)**;
  a 160K request lands at ~16K (90%).
- Per-request savings are accumulated in `request-stats.json` per session and
  surfaced by `babyzilla stats`, `babyzilla show`, and `/contextpack` — so
  Layer 1b is measurable even when no compaction ever runs.
- New options: `requestCompression`, `requestBudgetTokens`,
  `requestTargetRatio`, `requestMinBudgetTokens`, `requestMinTokens`,
  `requestProtectRecent`, `requestHardProtect`, `requestPartMinTokens`,
  `requestElideAttachments`, `requestElideReasoning`.
- **Layer 1c — proactive compaction.** OpenCode's own compaction only fires
  near the model's context limit, which for a 1M-token model (Kimi K3) means a
  session can grow to hundreds of thousands of tokens before BabyZilla ever
  gets to replace the summary. When a request reaches
  `max(proactiveCompactMinTokens, proactiveCompactRatio × context window)`,
  BabyZilla now calls `session.compact()` itself (rate-limited per session), so
  the pack kicks in early. New options: `proactiveCompaction`,
  `proactiveCompactRatio`, `proactiveCompactMinTokens`,
  `proactiveCompactCooldownMs`.
- Manual/free-tier compactions that hand the hook a single synthetic message
  now fall back to the live session context, so distillation sees the real
  transcript instead of one blob (and no longer skips as "below minRawTokens").
- `test/plugin-context.test.mjs` — loads the real plugin and asserts >90%
  reduction on a 1M-token-shaped message list, and that a 1M-token request
  triggers a proactive compaction.

### Changed

- Docs now describe the four layers (1, 1b, 2, 2b) and when each one fires.
- `distillVia: "auto"` now starts with the session-scoped call for the
  `opencode` provider (free tier), avoiding a guaranteed failed request and
  the resulting native-compaction fallback.

## [0.3.2] — 2026-10-18

### Fixed

- `parseModules` now accepts a **top-level JSON array** (compact or
  pretty-printed), not just JSONL or `{modules:[…]}`. Models that answer with
  an array no longer cost a retry.

## [0.3.1] — 2026-10-18

### Added

- **`babyzilla retrieve <path>[:<start>[-<end>]]`** — print an exact, numbered
  line range, so an elided span can be pulled back without re-reading the file.
- **`toolResultProtectRecent`** (default `1`) — the most recent tool results
  stay verbatim; only older ones are compressed. Removes the "compress → agent
  re-reads" loop.
- **Attach freshness note** — when a cold module is attached, the session gets
  a short note that its captured line counts may be stale, and how to verify.
- **CI** — GitHub Actions runs the test suite on Node 18, 20 and 22 for every
  push to `main` and every pull request.
- **`docs/BENCHMARKS.md`** — the measured head-to-head against Headroom 0.41.0
  (same model, same files, four rounds), with methodology and caveats.

### Changed

- The pure distillation helpers (`reduceForDistill`, `parseModules`,
  `buildSummary`, `distillationPrompt`, `moduleFileFor`, `libraryIndex`) moved
  into `lib/` so Layer 1 is unit-testable without loading the plugin.
- Test suite grew from 30 to **71 tests**, including regression coverage for the
  library-path bug fixed in 0.3.0.

## [0.3.0] — 2026-10-18

### Added

- **Layer 2b — tool-result compression.** Large `read`, `grep`, `glob` and
  `list` results are compressed **at the source**, before they are persisted
  and resent on every later turn. Head, tail, structural and
  diagnostic/TODO lines are kept and line numbers stay intact, so exact ranges
  remain readable. Options: `toolResultCompression` (`true`),
  `toolResultMinTokens` (`1200`), `toolResultHeadLines` (`40`),
  `toolResultTailLines` (`20`).
- **`distillVia`** option — `"auto"` (default), `"session"`, `"text"` — selects
  how the distillation call is routed.

### Fixed

- **OpenCode free tier.** Distillation used the session-less
  `ctx.generate.text`, which the free tier rejects with *"free tier can only be
  used from within OpenCode"*. It now falls back to the session-scoped call, so
  Layer 1 works on free models.
- **Library module paths.** Library indexes store only a file basename, and the
  prompt hook resolved it under `sessions/<id>/` instead of
  `library/<project>/`.
- **Missing module files** no longer abort the whole turn with *"Unable to read
  attachment"*; they are skipped and logged.

### Measured

Same model (`ollama-cloud/deepseek-v4.1-flash`), same files, same prompts,
against Headroom 0.41.0:

| Round | BabyZilla | Headroom |
| --- | ---: | ---: |
| read-only, 4 files | **115,191** | 211,267 |
| constrained, 7 files | **46,516** | 103,470 |
| shell-only | **56,711** | 104,136 |

## [0.2.0] — 2026-10-16

### Added

- Bundled `lowfat` as **Layer 2**: shell commands are rewritten before
  execution, so tool output enters the context pre-compressed.

## [0.1.0] — 2026-10-16

### Added

- Initial release: AI-distilled ContextPack modules replace OpenCode's native
  compaction summary, with trigger-based auto-loading of cold modules.
