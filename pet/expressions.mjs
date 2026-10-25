// The 100 BabyZilla expressions. One source of truth for the art build
// (pet/build.mjs reads `delta`) and for the runtime (lib/pet-map.mjs resolves
// an opencode signal to one of these ids).
//
// `delta` is appended to BASE in pet/prompts.mjs: it describes only what
// changes (face/arms), so the img2img pass keeps the body identical.
// `motion` is procedural: the sprite itself is a single frame.
//   bob   — gentle 2px vertical idle
//   pop   — quick squash on entry (reactions)
//   shake — 2px horizontal tremor (errors, glitch)
//   float — slow drift up/down (sleep)
//   still — no motion (heavy, dead, holding something)
// `lines` are bubble candidates; the runtime picks one per event.

const E = (id, label, cat, delta, motion, lines = []) => ({ id, label, cat, delta, motion, lines });

export const EXPRESSIONS = [
  // ── idle & body (10) ────────────────────────────────────────────────────
  E("idle", "Idle", "idle", "relaxed neutral face, calm half smile, arms down", "bob",
    ["Ready when you are.", "Watching you work."]),
  E("blink", "Blink", "idle", "eyes fully closed mid blink, relaxed mouth", "bob"),
  E("breathe", "Breathe", "idle", "chest puffed up mid breath, eyes soft, calm", "bob"),
  E("look-left", "Look left", "idle", "pupils looking to its left, curious, head slightly turned", "bob"),
  E("look-right", "Look right", "idle", "pupils looking to its right, curious, head slightly turned", "bob"),
  E("yawn", "Yawn", "idle", "mouth wide open yawning, eyes squeezed shut, tongue visible", "bob"),
  E("stretch", "Stretch", "idle", "both arms stretched up high, back arched, eyes closed", "pop"),
  E("doze", "Doze", "idle", "eyes half closed, head drooping, sleepy", "float"),
  E("sit", "Sit", "idle", "crouched down low on bent knees, relaxed smile, tail curled", "still"),
  E("tilt-head", "Head tilt", "idle", "head tilted to one side, curious, one brow raised", "bob"),

  // ── sleep & wake (6) ────────────────────────────────────────────────────
  E("sleep", "Sleep", "sleep", "fast asleep standing up, eyes closed, head drooped forward, peaceful smile", "float",
    ["Zzz…", "Five more minutes."]),
  E("zzz", "Zzz", "sleep", "asleep with mouth slightly open, eyes closed, head tilted forward", "float"),
  E("wake-startled", "Wake startled", "sleep", "eyes wide open, body jolted upright, startled", "shake",
    ["I'm up! I'm up."]),
  E("groggy", "Groggy", "sleep", "eyes half open, slumped, miserable morning face", "float",
    ["Too early for this."]),
  E("coffee", "Coffee", "sleep", "blissful face, eyes closed, one hand raised as if holding a warm cup", "bob",
    ["Ahh. Caffeine acquired."]),
  E("morning-stretch", "Morning stretch", "sleep", "big stretch with a wide yawn, arms up, tail up", "pop"),

  // ── prompt lifecycle (12) ───────────────────────────────────────────────
  E("listening", "Listening", "prompt", "head up, attentive, eyes forward, small open smile", "bob",
    ["Mm-hm.", "Go on."]),
  E("reading-prompt", "Reading prompt", "prompt", "eyes scanning to the side, focused, mouth slightly open", "bob"),
  E("thinking", "Thinking", "prompt", "looking up, one hand on chin, thinking hard", "bob",
    ["Hmm…"]),
  E("planning", "Planning", "prompt", "serious focused face, brow down, determined", "bob"),
  E("typing", "Typing", "prompt", "both arms raised in front, fingers wiggling, focused", "bob"),
  E("writing-code", "Writing code", "prompt", "tongue sticking out slightly, eyes narrowed, concentrating", "bob"),
  E("rereading", "Re-reading", "prompt", "squinting, head pushed forward, suspicious", "bob"),
  E("confused", "Confused", "prompt", "one brow raised, mouth a squiggle, head tilted", "bob",
    ["Wait, what?"]),
  E("stuck", "Stuck", "prompt", "flat annoyed face, eyes half lidded, mouth a flat line", "bob",
    ["I'm going in circles."]),
  E("eureka", "Eureka", "prompt", "eyes wide with a big grin, one finger up, sparkle", "pop",
    ["Got it!"]),
  E("determined", "Determined", "prompt", "fierce little grin, brow down, fists clenched", "bob"),
  E("bored-waiting", "Bored waiting", "prompt", "heavy lidded eyes, slumped, sighing mouth", "float",
    ["Still waiting…"]),

  // ── tools (18) ──────────────────────────────────────────────────────────
  E("tool-read", "Reading files", "tools", "eyes scanning downward as if reading, calm focused face, mouth slightly open", "bob",
    ["Reading."]),
  E("tool-grep", "Searching", "tools", "squinting closely, one eye bigger than the other, leaning forward", "bob",
    ["Looking for it."]),
  E("tool-list", "Listing", "tools", "eyes scanning a list, mouth slightly open, focused", "bob"),
  E("tool-edit", "Editing", "tools", "concentrating hard, tongue sticking out, one hand raised in a pencil grip", "bob",
    ["Changing this bit."]),
  E("tool-write", "Writing", "tools", "pleased little smile, one hand raised in a pencil grip", "bob"),
  E("tool-bash", "Running a command", "tools", "one arm saluting, confident grin", "pop",
    ["Running it."]),
  E("shell-ok", "Command ok", "tools", "thumbs up, happy eyes", "pop",
    ["Clean exit."]),
  E("shell-fail", "Command failed", "tools", "wincing, one eye shut, sweat drop", "shake",
    ["That exit code though."]),
  E("tool-webfetch", "Fetching", "tools", "curious wide eyes, head tilted, one hand raised", "bob"),
  E("tool-websearch", "Searching web", "tools", "peering into the distance, hand over its brow, focused", "bob"),
  E("tool-task", "Delegating", "tools", "pointing forward, giving orders, confident", "pop",
    ["You. Go do that."]),
  E("subagent-wait", "Waiting on subagent", "tools", "standing patiently, hands behind back, humming", "bob"),
  E("tool-imagegen", "Generating image", "tools", "proud smile, one hand raised as if holding a paintbrush", "bob",
    ["Painting…"]),
  E("tool-lsp", "LSP", "tools", "focused, brow down, one hand raised as if holding a tool", "bob"),
  E("tool-mcp", "MCP", "tools", "head cocked, listening attentively, one hand up", "bob"),
  E("tool-vision", "Looking at an image", "tools", "hand over its brow, peering into the distance, one eye squinting", "bob"),
  E("tool-todo", "Todos", "tools", "nodding slightly, satisfied focused face", "bob"),
  E("tool-question", "Asking", "tools", "raised hand, puzzled, polite", "bob",
    ["Quick question."]),

  // ── outcomes (10) ───────────────────────────────────────────────────────
  E("success", "Success", "outcome", "big happy grin, arms up in celebration", "pop",
    ["Done!", "That worked."]),
  E("celebrate", "Celebrate", "outcome", "jumping with joy, eyes closed in a smile", "pop",
    ["Yes yes yes!"]),
  E("proud", "Proud", "outcome", "chest out, hands on hips, smug smile", "bob",
    ["Nailed it."]),
  E("error", "Error", "outcome", "shocked face, mouth open, eyes wide", "shake",
    ["Uh oh."]),
  E("oops", "Oops", "outcome", "sheepish grin, one eye closed, sweat drop", "shake",
    ["That's… not great."]),
  E("retry", "Retry", "outcome", "determined frown, cracking knuckles", "bob",
    ["Again. From the top."]),
  E("test-pass", "Tests pass", "outcome", "triumphant beaming grin, eyes closed with joy", "pop",
    ["Green across the board."]),
  E("test-fail", "Tests fail", "outcome", "devastated face, teary eyes, mouth open in dismay", "shake",
    ["Red. All red."]),
  E("conflict", "Conflict", "outcome", "scratched head, confused, mouth open", "bob",
    ["Someone else touched this."]),
  E("shrug", "Shrug", "outcome", "shrugging with both arms up, flat mouth", "bob",
    ["No idea."]),

  // ── babyzilla core (12) ─────────────────────────────────────────────────
  E("compressing", "Compressing", "core", "squeezing something with both arms, straining, eyes shut", "shake",
    ["Squeezing the context…"]),
  E("paging-out", "Paging out", "core", "holding a stack of papers, handing them away", "bob",
    ["Filing this away."]),
  E("pack-created", "Pack created", "core", "proud, both hands cupped in front holding something small", "pop",
    ["New context pack."]),
  E("module-attach", "Module attached", "core", "presenting something in front with both hands, pleased", "bob",
    ["Bringing the notes."]),
  E("library", "Library", "core", "wobbling under a heavy load, straining, eyes squeezed", "shake",
    ["From the library."]),
  E("recall", "Recall", "core", "one arm reaching out, delighted surprised eyes", "pop",
    ["Found the original."]),
  E("retrieve", "Retrieve", "core", "peering down at something in its hands, focused", "bob"),
  E("budget-low", "Budget low", "core", "nervous wide eyes, sweat drop, worried frown", "shake",
    ["Context is getting full."]),
  E("budget-full", "Budget full", "core", "puffed up and uncomfortable, cheeks bulging", "still",
    ["I'm stuffed."]),
  E("self-tune", "Self-tune", "core", "tinkering, tongue out, one hand raised, focused eyes", "bob",
    ["Tuning the knobs."]),
  E("replay", "Replay", "core", "curious, head tilted, one hand raised", "bob"),
  E("journal", "Journal", "core", "serious focused face, one hand moving as if writing", "bob"),

  // ── system (10) ─────────────────────────────────────────────────────────
  E("update-available", "Update available", "system", "excited, arms up, sparkling wide eyes", "pop",
    ["There's an update!", "New version is out."]),
  E("offline", "Offline", "system", "sad, shoulders down, glum frown", "float",
    ["Can't reach the network."]),
  E("rate-limited", "Rate limited", "system", "exhausted, one hand up in a stop gesture, half lidded eyes", "float",
    ["Everyone slow down."]),
  E("model-error", "Model error", "system", "confused, dizzy, question marks around head", "shake",
    ["The model coughed."]),
  E("long-session", "Long session", "system", "very tired, bags under eyes, slouched", "float",
    ["We've been at this a while."]),
  E("waiting-approval", "Waiting approval", "system", "attentive, hand raised, patient smile", "bob",
    ["Waiting on you."]),
  E("permission-denied", "Permission denied", "system", "arms crossed, stern face", "still",
    ["Blocked."]),
  E("syncing", "Syncing", "system", "eyes closed, humming, arms out", "float"),
  E("low-power", "Low power", "system", "sleepy, half lidded eyes, drooping", "float"),
  E("disk-full", "Disk full", "system", "worried, hugging itself, anxious eyes", "shake",
    ["No room left."]),

  // ── emotion & social (12) ───────────────────────────────────────────────
  E("wave", "Wave", "emotion", "one arm raised waving, big smile", "pop",
    ["Hi!", "Hey there."]),
  E("poke", "Poke", "emotion", "startled, both arms up, surprised eyes", "shake",
    ["Hey! That's me."]),
  E("pet", "Pet", "emotion", "eyes closed, blissful smile, leaning into it", "float"),
  E("love", "Love", "emotion", "big heart shaped pupils, blushing cheeks", "pop"),
  E("happy", "Happy", "emotion", "beaming smile, eyes closed", "bob"),
  E("excited", "Excited", "emotion", "vibrating with excitement, arms up, sparkles", "shake"),
  E("bored", "Bored", "emotion", "flat expression, looking away, sighing", "float"),
  E("hungry", "Hungry", "emotion", "rubbing its belly, drooling a little", "bob",
    ["Got any more tokens?"]),
  E("sleepy", "Sleepy", "emotion", "drooping eyes, swaying slightly", "float"),
  E("dance", "Dance", "emotion", "one arm up one arm down, mid dance move", "pop"),
  E("party", "Party", "emotion", "arms up in celebration, eyes closed with joy", "pop",
    ["Party!", "Ship it and party."]),
  E("sneeze", "Sneeze", "emotion", "mid sneeze, eyes shut tight, mouth open", "shake",
    ["Achoo!"]),

  // ── easter eggs (10) ────────────────────────────────────────────────────
  E("glitch", "Glitch", "egg", "glitching, duplicated outlines, static artifacts", "shake",
    ["I'm… f-f-fine."]),
  E("notfound", "404", "egg", "blank confused face, arms out, shrugging", "bob",
    ["404. Whatever you wanted, it's not here."]),
  E("roar", "Roar", "egg", "roaring, fierce, tiny flames", "shake",
    ["RAAAH!"]),
  E("atomic-breath", "Atomic breath", "egg", "breathing a small puff of green flame", "pop"),
  E("rubber-duck", "Rubber duck", "egg", "patient explaining face, one hand out, pleased", "bob",
    ["Explain it to the duck."]),
  E("coffee-bug", "Coffee bug", "egg", "holding coffee, wide awake staring eyes", "shake"),
  E("stack-overflow", "Stack overflow", "egg", "overwhelmed, eyes squeezed shut, head low, strained", "still",
    ["Too many tabs."]),
  E("segfault", "Segfault", "egg", "X shaped dead eyes, tongue out, head flopped to the side", "still",
    ["Segmentation fault. Core dumped."]),
  E("ship-it", "Ship it", "egg", "proud, arms raised holding something up, confident grin", "pop",
    ["Ship it!"]),
  E("cake", "Cake", "egg", "beaming, arms raised in celebration, eyes closed with joy", "bob",
    ["Happy commit-iversary."]),
];

export const EXPRESSION_IDS = EXPRESSIONS.map((e) => e.id);
export const byId = Object.fromEntries(EXPRESSIONS.map((e) => [e.id, e]));

export const CATEGORIES = [...new Set(EXPRESSIONS.map((e) => e.cat))];
