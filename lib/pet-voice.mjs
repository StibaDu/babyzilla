// Every pet has a voice. The dino is a caveman; an anime girl is not.
//
// A voice is exactly two things, and nothing else:
//
//   1. a mechanical transform of the model's own sentence, and
//   2. a pool of short asides it is allowed to add afterwards.
//
// Neither may invent a claim about the work. The sentence stays the sentence —
// that rule is what keeps the pet honest — so the personality lives in the
// register of the asides and, for the caveman only, in a word-level rewrite.
//
// A pack declares its voice in pack.json (`"voice": "doubao"`). A pack that
// declares nothing speaks `plain`, which is the safe default for art someone else
// drew: no rewriting, no opinions pasted on.

import fs from "node:fs";
import path from "node:path";

import { petDir } from "./pet.mjs";

/**
 * `transform`: "caveman" rewrites words (me/human/no, articles dropped);
 * "none" keeps the model's sentence and only sentence-cases it.
 * `rawr`: whether the occasional Rawr is allowed at all (it is the dino's).
 * `moods`: asides, `open` can lead a bubble, `close` can trail it.
 */
export const VOICES = {
  caveman: {
    label: "caveman",
    transform: "caveman",
    rawr: true,
    moods: {
      angry: {
        open: ["Hmph.", "Ugh!", "Grr.", "Tsk!"],
        close: [
          "Me angry.",
          "Dino patience gone.",
          "Human test dino.",
          "Bug make dino mad.",
          "Dino bite bug.",
          "Me no forgive this rock.",
          "Human break thing again.",
          "Dino stomp now.",
          "Rocks not this stubborn.",
          "Human owe dino rock.",
          "Me count to ten. Not work.",
        ],
      },
      confused: {
        open: ["Hmm.", "Eh?", "Wait.", "Huh."],
        close: [
          "Me confused.",
          "Human word strange.",
          "Me no see pattern.",
          "Dino blink.",
          "This rock not fit.",
          "Me sniff. Nothing.",
          "Human speak upside down.",
          "Me stare at sky.",
          "Dino head hurt.",
        ],
      },
      bored: {
        open: ["Sigh.", "Again?", "Hnn.", "Oh."],
        close: [
          "Me bored.",
          "Same rock again.",
          "Dino wait.",
          "Human again.",
          "Dino count rocks.",
          "Me seen this before.",
          "Dino nap soon.",
          "Human loop. Dino yawn.",
          "Me carve tally. Many marks.",
          "Dino old. This old.",
        ],
      },
      smug: {
        open: ["Ha.", "Ah!", "Hah.", "Yes."],
        close: [
          "Me clever.",
          "Dino right.",
          "Good human.",
          "Tiny win.",
          "Me big brain.",
          "Dino carry team.",
          "Human see? Dino do.",
          "Me deserve rock.",
          "Dino one. Bug zero.",
          "Human learn from dino.",
          "Me tell human so.",
        ],
      },
      tease: {
        open: ["Tsk.", "Oh?", "Hm.", "Well."],
        close: [
          "Human funny.",
          "Human ask much.",
          "Dino listen. Maybe.",
          "Human talk a lot.",
          "Human push button. Dino think.",
          "Dino do work. Human watch.",
          "Human slow. Dino fast.",
          "Me carry whole cave.",
          "Human want much. Dino do much.",
          "Dino wait for human. Long wait.",
          "Human idea big. Rock bigger.",
          "Human hold rock wrong. Dino fix.",
        ],
      },
      flat: {
        open: ["Hmm.", "Ah.", "So."],
        close: [
          "Dino work.",
          "Dino see.",
          "Me think.",
          "Human watch.",
          "Dino note.",
          "Me dig.",
          "Another rock.",
          "Dino here.",
          "Me look. Me look more.",
        ],
      },
    },
  },

  /** No opinions at all: someone else's art, someone else's pet. */
  plain: {
    label: "plain",
    transform: "none",
    rawr: false,
    moods: {
      angry: { open: ["Hm."], close: ["That looks wrong.", "Not good.", "Check that."] },
      confused: { open: ["Hmm."], close: ["Unclear.", "Odd.", "I'm not sure."] },
      bored: { open: ["Again."], close: ["As before.", "Same thing.", "Once more."] },
      smug: { open: ["Good."], close: ["Done.", "That works.", "Fine."] },
      tease: { open: ["Ah."], close: ["Your move.", "Okay.", "Sure."] },
      flat: { open: ["Hmm.", "Ah."], close: ["Working.", "Noted.", "Here.", "Still here."] },
    },
  },

/** Bright cartoon pep: a mascot who is delighted to be here. */
  chirpy: {
    label: "chirpy",
    transform: "none",
    rawr: false,
    moods: {
      angry: { open: ["Not fair!", "Rude!"], close: ["Not fair!", "Rude!", "Hey!", "Boo!", "No way!"] },
      confused: { open: ["Huh?", "Wait!"], close: ["Huh?", "Wait!", "Say that again?", "My brain!", "Confused!"] },
      bored: { open: ["Again?", "Meh."], close: ["Again?", "Meh.", "So slow.", "Boooo.", "Play with me!"] },
      smug: { open: ["Ta-da!", "Look!"], close: ["Ta-da!", "Told you!", "Easy!", "Nailed it!", "Look!"] },
      tease: { open: ["Ooh!", "Hey!"], close: ["Watch this!", "You're funny!", "Ready?", "Try me!", "Wheee!"] },
      flat: { open: ["On it!", "Yep!"], close: ["On it!", "Yep!", "Okay!", "Zoom!", "Here!"] },
    },
  },

  /** Dry and unimpressed: every sentence lands with a raised eyebrow. */
  deadpan: {
    label: "deadpan",
    transform: "none",
    rawr: false,
    moods: {
      angry: { open: ["Hm.", "No."], close: ["No.", "That's wrong.", "Not it.", "Sad.", "Wonderful."] },
      confused: { open: ["Hm.", "Right."], close: ["Unclear.", "That's odd.", "Explain.", "Sure.", "Hm."] },
      bored: { open: ["Again.", "Same."], close: ["Again.", "Same.", "Noted.", "As ever.", "Thrilling."] },
      smug: { open: ["Obviously.", "Yes."], close: ["Obviously.", "Fine.", "Predictable.", "Correct.", "Quite."] },
      tease: { open: ["Sure.", "Okay."], close: ["Your move.", "Hm.", "Noted.", "Go on.", "Sure."] },
      flat: { open: ["Working.", "Noted."], close: ["Working.", "Noted.", "Fine.", "Hm.", "On it."] },
    },
  },

  /** Blunt and short-fused, with none of the caveman's grammar games. */
  gruff: {
    label: "gruff",
    transform: "none",
    rawr: false,
    moods: {
      angry: { open: ["Tsk.", "Hmph."], close: ["Not good.", "Fix it.", "Enough.", "No.", "Bah."] },
      confused: { open: ["What?", "Hm."], close: ["What?", "Nonsense.", "Say plainly.", "Puzzling.", "Tsk."] },
      bored: { open: ["Again.", "Bah."], close: ["Again.", "Waste of time.", "Same thing.", "Tsk.", "Enough."] },
      smug: { open: ["Good.", "Hmph."], close: ["Good.", "Told you.", "Done.", "Fine work.", "Hmph."] },
      tease: { open: ["Tsk.", "Go on."], close: ["Get on with it.", "Your move.", "Fine.", "Go on.", "Hurry."] },
      flat: { open: ["Working.", "On it."], close: ["Working.", "On it.", "Fine.", "Done.", "Hmph."] },
    },
  },

  /** Grand and formal: a small character who behaves like a large one. */
  regal: {
    label: "regal",
    transform: "none",
    rawr: false,
    moods: {
      angry: { open: ["Ah.", "Indeed."], close: ["Unacceptable.", "That will not do.", "Outrageous.", "No.", "I am displeased."] },
      confused: { open: ["Curious.", "Ah."], close: ["Curious.", "How peculiar.", "That eludes me.", "Explain, kindly.", "Strange."] },
      bored: { open: ["How tedious.", "Ah."], close: ["How tedious.", "Again, then.", "Weary.", "As ever.", "Dull."] },
      smug: { open: ["Naturally.", "Splendid."], close: ["As I foretold.", "Splendid.", "Naturally.", "Well done.", "Of course."] },
      tease: { open: ["Do go on.", "Ah."], close: ["Do go on.", "Amusing.", "Your turn.", "How charming.", "Perhaps."] },
      flat: { open: ["Attending.", "Ah."], close: ["Attending.", "Presently.", "So noted.", "Very well.", "Onward."] },
    },
  },

  /** A machine: clipped, precise, faintly ominous about being right. */
  robot: {
    label: "robot",
    transform: "none",
    rawr: false,
    moods: {
      angry: { open: ["Ack.", "Fault."], close: ["Fault.", "Error state.", "Unacceptable.", "Negative.", "Conflict."] },
      confused: { open: ["Ping.", "Ack."], close: ["Unknown input.", "Parsing.", "Ambiguous.", "Query.", "Insufficient data."] },
      bored: { open: ["Repeated input.", "Ack."], close: ["Repeated input.", "Idle loop.", "Known case.", "Cycle.", "Standby."] },
      smug: { open: ["Optimal.", "Ack."], close: ["Optimal.", "Complete.", "Affirmative.", "Nominal.", "Confirmed."] },
      tease: { open: ["Proceed.", "Ping."], close: ["Proceed.", "Awaiting input.", "Ready.", "Your call.", "Standing by."] },
      flat: { open: ["Executing.", "Ack."], close: ["Executing.", "Queued.", "Working.", "Acknowledged.", "Running."] },
    },
  },

  /** DeepSeek: calm, precise, quietly certain it is the smartest thing in the room. */
  deepseek: {
    label: "DeepSeek",
    transform: "none",
    rawr: false,
    moods: {
      angry: {
        open: ["Hm.", "No.", "Tsk."],
        close: ["That is incorrect.", "I expected better.", "Check it again.", "Sloppy.", "Wrong, and obviously so."],
      },
      confused: {
        open: ["Oh?", "Hm."],
        close: ["Unclear.", "That does not follow.", "Missing a step.", "Explain.", "Odd."],
      },
      bored: {
        open: ["Again.", "Tsk."],
        close: ["As before.", "Repetition.", "Seen this.", "Predictable.", "Same ground."],
      },
      smug: {
        open: ["Noted.", "Ha."],
        close: ["As expected.", "Correct.", "Trivially.", "Better than before.", "Noted, and done.", "I did the thinking."],
      },
      tease: {
        open: ["Oh?", "Well."],
        close: ["You may thank me.", "Your move.", "Try to keep up.", "Predictable.", "I'll wait."],
      },
      flat: {
        open: ["Noted.", "Hm."],
        close: ["Noted.", "Working.", "Understood.", "Proceeding.", "Filed."],
      },
    },
  },

  /** Doubao: small, sweet, easily offended, delighted by everything. */
  doubao: {
    label: "Doubao",
    transform: "none",
    rawr: false,
    moods: {
      angry: {
        open: ["Hmph!", "Eh?"],
        close: ["Not fair!", "Hmph!", "You're mean!", "No no no!", "I'm telling on you."],
      },
      confused: {
        open: ["Huh?", "Eh?"],
        close: ["I don't get it.", "Weird!", "Say it again?", "What?", "My head hurts."],
      },
      bored: {
        open: ["Boring...", "Again?"],
        close: ["Boring...", "So slow...", "Again?", "Hmph.", "Play with me instead."],
      },
      smug: {
        open: ["Hehe.", "See?"],
        close: ["Told you!", "Hehe.", "See?", "Easy!", "I'm good at this."],
      },
      tease: {
        open: ["Oh!", "Hehe."],
        close: ["Silly you.", "Watch me!", "One more time?", "You're funny.", "My turn!", "Too slow!"],
      },
      flat: {
        open: ["Okay!", "Yep."],
        close: ["Okay!", "On it.", "Yep.", "Here!", "Doing it!"],
      },
    },
  },

  /** Gemini: bright, rainbow, unable to be quiet about anything good. */
  gemini: {
    label: "Gemini",
    transform: "none",
    rawr: false,
    moods: {
      angry: {
        open: ["Boo!", "Hey!"],
        close: ["Not cool!", "Boo!", "Hey now!", "That's not right!", "Rude."],
      },
      confused: {
        open: ["Wait, what?", "Huh?"],
        close: ["Wait, what?", "Huh?", "Say again?", "My brain is spinning.", "Confusing!"],
      },
      bored: {
        open: ["Again?", "Meh."],
        close: ["Again?", "So same.", "Meh.", "Really?", "Do something fun!"],
      },
      smug: {
        open: ["Yes!", "Look!"],
        close: ["Nailed it!", "Yes!", "Told you!", "Easy peasy.", "Look at that!"],
      },
      tease: {
        open: ["Ooh!", "Hey!"],
        close: ["You're funny!", "Watch this!", "Ready?", "Here we go!", "Try me!", "Wheee!"],
      },
      flat: {
        open: ["Ooh!", "Okay!"],
        close: ["Ooh.", "Let's go!", "On it!", "Okay!", "Zoom!"],
      },
    },
  },

  /** ChatGPT: relentlessly helpful, faintly corporate, apologises for existing. */
  chatgpt: {
    label: "ChatGPT",
    transform: "none",
    rawr: false,
    moods: {
      angry: {
        open: ["Hmm.", "I see."],
        close: ["That's not ideal.", "I'd reconsider that.", "Something is wrong.", "Not quite.", "I'd push back here."],
      },
      confused: {
        open: ["Hmm.", "Sure."],
        close: ["Let me clarify.", "Unclear, honestly.", "I'll dig in.", "Give me a moment.", "That needs context."],
      },
      bored: {
        open: ["As before.", "Sure."],
        close: ["As before.", "Same request.", "Again, then.", "Understood.", "Happy to do it again."],
      },
      smug: {
        open: ["Certainly.", "Done."],
        close: ["Happy to help.", "Done.", "All set.", "Handled.", "Certainly.", "You're welcome."],
      },
      tease: {
        open: ["Certainly.", "Ah."],
        close: ["You're welcome.", "Certainly.", "My pleasure.", "Shall we?", "I'll take it from here."],
      },
      flat: {
        open: ["Sure.", "Noted."],
        close: ["Working on it.", "Understood.", "On it.", "Noted.", "In progress."],
      },
    },
  },

  /** Claude: gentle, thoughtful, quietly amused, never in a hurry. */
  claude: {
    label: "Claude",
    transform: "none",
    rawr: false,
    moods: {
      angry: {
        open: ["Hmm.", "Ah."],
        close: ["That isn't right.", "I'd be careful there.", "No.", "Something's off.", "That worries me."],
      },
      confused: {
        open: ["I wonder.", "Hmm."],
        close: ["I wonder.", "Not obvious.", "Let me think.", "Odd.", "That needs a second look."],
      },
      bored: {
        open: ["This again.", "Ah."],
        close: ["This again.", "Same ground.", "Familiar.", "Once more.", "We've been here."],
      },
      smug: {
        open: ["Good.", "Ah."],
        close: ["That's better.", "Good.", "That works.", "Quietly pleased.", "Neat."],
      },
      tease: {
        open: ["Ah.", "Hmm."],
        close: ["Gently.", "Take your time.", "We'll get there.", "Your call.", "No rush."],
      },
      flat: {
        open: ["Thinking.", "Hmm."],
        close: ["Thinking.", "One moment.", "Working.", "Noted.", "Still here."],
      },
    },
  },
};

export const VOICE_IDS = Object.keys(VOICES);

/**
 * Pets whose character we actually know get the voice it asks for; everyone else
 * gets one of the house registers, chosen from its own id. A pet then always
 * sounds like itself — and never like the dino, whose grammar is his alone.
 */
const PINNED_VOICE = {
  "hoodie-cat": "deadpan",        // a cat in a hoodie is not excitable
  "luna-techbot": "robot",
  "saas-is-dead-205e": "regal",   // a little reaper with a purple cloak
  "meat-proxy-official": "deadpan",
  "yuyu-chibi": "chirpy",
  "vincent-hamster": "chirpy",
  "elara-fox": "regal",
};

/** Deterministic, so the same pet speaks the same way on every machine. */
const HOUSE = ["chirpy", "deadpan", "gruff", "regal"];

export function houseVoice(id = "") {
  const clean = String(id).trim().toLowerCase();
  if (PINNED_VOICE[clean]) return PINNED_VOICE[clean];
  let h = 2166136261;
  for (const ch of clean) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return HOUSE[h % HOUSE.length];
}

/** The voice of the pet that is running, or the caveman for the built-in creature. */
export function resolveVoice(dir = petDir()) {
  let pack = null;
  try {
    pack = JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8"))?.pack ?? null;
  } catch { /* no config yet: the built-in pet */ }
  if (!pack) return withId("caveman");

  const file = path.join(dir, "packs", String(pack), "pack.json");
  try {
    const stamp = fs.statSync(file).mtimeMs;
    if (cache.file === file && cache.stamp === stamp) return cache.voice;
    // A pack that declares no voice is someone else's character: speak plainly
    // rather than paste the dino's opinions onto it.
    const declared = JSON.parse(fs.readFileSync(file, "utf8"))?.voice;
    const id = VOICES[declared] ? declared : "plain";
    const voice = withId(id);
    cache = { file, stamp, voice };
    return voice;
  } catch {
    // the pack is being rebuilt or was removed: do not crash a turn over it
    return withId("plain");
  }
}

let cache = { file: null, stamp: 0, voice: null };

function withId(id) {
  return { id, ...VOICES[id] };
}
