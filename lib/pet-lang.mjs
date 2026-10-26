// The pet's language.
//
// A voice is a transform plus a pool of asides (see pet-voice.mjs). Language is a
// separate axis on top: the same dino, the same moods, the same honesty rules —
// only the words it was born into change.
//
// What can and cannot be localised here, stated plainly:
//
//   * everything the pet *authors* is localised: asides, event lines, menus;
//   * the thought it quotes is the model's own sentence and is passed through
//     untouched. There is no translation call in this file, deliberately — a pet
//     that invented your work in German would be worse than an English quote. A
//     German human usually gets German reasoning anyway, because the model mirrors
//     the conversation.
//
// German asides are written per register rather than per voice: the dino has its
// own cave German, and the other eleven voices share three registers (terse,
// warm, formal). That is enough for the pet to sound like itself in German without
// a 536-line translation table; a pack that wants its own German can be given one
// later without touching this file's callers.

import fs from "node:fs";
import path from "node:path";

import { petDir } from "./pet.mjs";

export const LANGUAGES = {
  en: { label: "English" },
  de: { label: "Deutsch" },
};

/** Which German register a voice speaks in. The dino is a special case. */
const REGISTER = {
  caveman: "caveman",
  plain: "terse",
  deadpan: "terse",
  gruff: "terse",
  robot: "terse",
  deepseek: "terse",
  chirpy: "warm",
  doubao: "warm",
  gemini: "warm",
  claude: "warm",
  regal: "formal",
  chatgpt: "formal",
};

/** German pools, by register. Same moods as the English table. */
const DE_MOODS = {
  caveman: {
    angry: {
      open: ["Hmph.", "Ugh!", "Grr.", "Tz!"],
      close: [
        "Ich wütend.",
        "Dino Geduld weg.",
        "Mensch testet Dino.",
        "Fehler macht Dino wild.",
        "Dino beißt Fehler.",
        "Diesen Stein vergeb ich nicht.",
        "Mensch wieder was kaputt.",
        "Dino stampft jetzt.",
        "Steine nicht so stur.",
        "Mensch schuldet Dino Stein.",
        "Ich zähl bis zehn. Klappt nicht.",
      ],
    },
    confused: {
      open: ["Hmm.", "Hä?", "Warte.", "Was."],
      close: [
        "Ich verwirrt.",
        "Mensch Wort komisch.",
        "Ich seh kein Muster.",
        "Dino blinzelt.",
        "Stein passt nicht.",
        "Ich schnupper. Nix.",
        "Mensch spricht verkehrt.",
        "Ich starr in Himmel.",
        "Dino Kopf tut weh.",
      ],
    },
    bored: {
      open: ["Seufz.", "Wieder?", "Hnn.", "Oh."],
      close: [
        "Ich gelangweilt.",
        "Wieder selber Stein.",
        "Dino wartet.",
        "Mensch schon wieder.",
        "Dino zählt Steine.",
        "Ich kenn das schon.",
        "Dino pennt gleich.",
        "Mensch im Kreis. Dino gähnt.",
        "Ich kerbe Striche. Viele Striche.",
        "Dino alt. Das alt.",
      ],
    },
    smug: {
      open: ["Ha.", "Ah!", "Hah.", "Ja."],
      close: [
        "Ich schlau.",
        "Dino hat recht.",
        "Braver Mensch.",
        "Kleiner Sieg.",
        "Ich großes Hirn.",
        "Dino trägt Team.",
        "Mensch sieht? Dino macht.",
        "Ich verdien Stein.",
        "Dino eins. Fehler null.",
        "Mensch lernt von Dino.",
        "Ich hab's Mensch gesagt.",
      ],
    },
    tease: {
      open: ["Tz.", "Oh?", "Hm.", "Na."],
      close: [
        "Mensch lustig.",
        "Mensch fragt viel.",
        "Dino hört zu. Vielleicht.",
        "Mensch redet viel.",
        "Mensch drückt Knopf. Dino denkt.",
        "Dino macht Arbeit. Mensch guckt.",
        "Mensch langsam. Dino schnell.",
        "Ich trag ganze Höhle.",
        "Mensch will viel. Dino macht viel.",
        "Dino wartet auf Mensch. Lange.",
        "Mensch Idee groß. Stein größer.",
        "Mensch hält Stein falsch. Dino richtet.",
      ],
    },
    flat: {
      open: ["Hmm.", "Ah.", "So."],
      close: [
        "Dino arbeitet.",
        "Dino sieht.",
        "Ich denk.",
        "Mensch guckt.",
        "Dino merkt.",
        "Ich grab.",
        "Noch ein Stein.",
        "Dino hier.",
        "Ich guck. Ich guck mehr.",
      ],
    },
  },
  terse: {
    angry: {
      open: ["Hm.", "Tz."],
      close: ["Das sieht falsch aus.", "Nicht gut.", "Prüf das mal.", "So nicht."],
    },
    confused: {
      open: ["Hmm.", "Hä?"],
      close: ["Unklar.", "Seltsam.", "Ich bin nicht sicher.", "Nochmal?"],
    },
    bored: {
      open: ["Wieder.", "Seufz."],
      close: ["Wie vorher.", "Dasselbe.", "Noch einmal.", "Schon wieder."],
    },
    smug: {
      open: ["Gut.", "Ha."],
      close: ["Fertig.", "Das klappt.", "Passt.", "Sauber."],
    },
    tease: {
      open: ["Ah.", "Na?"],
      close: ["Du bist dran.", "Okay.", "Klar.", "Dein Zug."],
    },
    flat: {
      open: ["Hmm.", "Ah."],
      close: ["Läuft.", "Notiert.", "Hier.", "Noch hier."],
    },
  },
  warm: {
    angry: {
      open: ["Hmpf!", "Eh?"],
      close: ["Nicht fair!", "Hmpf!", "Du bist gemein!", "Nein nein nein!", "Ich sag's weiter!"],
    },
    confused: {
      open: ["Hä?", "Eh?"],
      close: ["Versteh ich nicht.", "Komisch!", "Sag das nochmal?", "Was?", "Mein Kopf tut weh."],
    },
    bored: {
      open: ["Langweilig...", "Wieder?"],
      close: ["Langweilig...", "So langsam...", "Wieder?", "Hmpf.", "Spiel lieber mit mir."],
    },
    smug: {
      open: ["Hehe.", "Siehst du?"],
      close: ["Sag ich doch!", "Hehe.", "Siehst du?", "Einfach!", "Das kann ich gut."],
    },
    tease: {
      open: ["Oh!", "Hehe."],
      close: ["Du kleiner Witzbold.", "Guck mir zu!", "Noch einmal?", "Du bist lustig.", "Ich bin dran!", "Zu langsam!"],
    },
    flat: {
      open: ["Okay!", "Jep."],
      close: ["Okay!", "Mach ich.", "Jep.", "Hier!", "Bin dabei!"],
    },
  },
  formal: {
    angry: {
      open: ["Nun.", "Tz."],
      close: ["Das ist unwürdig.", "Nicht akzeptabel.", "Bitte prüfen Sie das.", "So nicht."],
    },
    confused: {
      open: ["Hm.", "Wie bitte?"],
      close: ["Unklar.", "Sonderbar.", "Ich bin nicht überzeugt.", "Erklären Sie das?"],
    },
    bored: {
      open: ["Erneut.", "Seufz."],
      close: ["Wie zuvor.", "Dasselbe.", "Ein weiteres Mal.", "Man kennt es."],
    },
    smug: {
      open: ["Gut.", "Ah."],
      close: ["Erledigt.", "Das trägt.", "Angemessen.", "Wie erwartet."],
    },
    tease: {
      open: ["Ah.", "Nun?"],
      close: ["Sie sind dran.", "Gewiss.", "Selbstverständlich.", "Ihr Zug."],
    },
    flat: {
      open: ["Hm.", "Ah."],
      close: ["Läuft.", "Notiert.", "Hier.", "Noch immer hier."],
    },
  },
};

/** The German mood table for a voice: its own cave, or its register's. */
export function germanMoods(voice) {
  return DE_MOODS[REGISTER[voice] ?? "terse"];
}

/**
 * The lines the pet says about events (not the model's sentence). Same keys in
 * every language so a caller never branches on the language itself.
 */
export const LINES = {
  en: {
    compacting: () => "Squeezing the context…",
    compacted: (from, to, pct) => `Compacted: ${from} → ${to} tok (${pct}% smaller).`,
    toolFailed: (name) => `${name} failed`,
    budgetFull: () => "I'm stuffed — compacting soon.",
    budgetLow: (pct) => `Context at ${Math.round(pct)}%.`,
    update: (latest, current) => `v${latest} is out (you have v${current}).`,
    rateLimited: () => "Rate limited. Waiting.",
    offline: () => "Can't reach the network.",
  },
  de: {
    compacting: () => "Kontext wird gepresst…",
    compacted: (from, to, pct) => `Zusammengefasst: ${from} → ${to} tok (${pct} % kleiner).`,
    toolFailed: (name) => `${name} fehlgeschlagen`,
    budgetFull: () => "Ich bin voll — gleich wird gepresst.",
    budgetLow: (pct) => `Kontext bei ${Math.round(pct)} %.`,
    update: (latest, current) => `v${latest} ist da (du hast v${current}).`,
    rateLimited: () => "Gebremst. Ich warte.",
    offline: () => "Netz nicht erreichbar.",
  },
};

/** One event line, in the asked-for language, with English as the floor. */
export function line(language, key, ...args) {
  const table = LINES[language] ?? LINES.en;
  const fn = table[key] ?? LINES.en[key];
  return fn ? fn(...args) : "";
}

/**
 * German mood reading. The English rules cannot see a German sentence, so a
 * German thought would always land in `flat` — every line the same shrug.
 */
const DE_MOOD_RULES = [
  ["angry", /\b(?:fehler|kaputt|falsch|schlecht|bricht|wirft|schuld|nervt|ärger\w*|mist|kaputt)\b/i],
  ["confused", /\b(?:unklar|seltsam|verwirr\w*|komisch|warum|hä|versteh\w*|keine ahnung)\b/i],
  ["bored", /\b(?:wieder|langweilig|immer noch|nochmal|schon wieder|erneut)\b/i],
  ["smug", /\b(?:fertig|geschafft|klappt|läuft|passt|erledigt|sauber)\b/i],
  ["tease", /\b(?:mensch|nutzer\w*)\b.*\b(?:will|möchte|sagt|fragt|nochmal|mehr|statt)\b/i],
];

export function readMoodDe(sentence) {
  for (const [mood, re] of DE_MOOD_RULES) if (re.test(sentence)) return mood;
  return null;
}

/**
 * German caveman: drop what carries grammar but not thought — articles and the
 * copulas — and leave the rest as written. The English transform cannot be reused
 * (its stop list is English), and inventing German verb forms would produce words
 * nobody says.
 */
const DE_DROP = new Set([
  "der", "die", "das", "den", "dem", "des", "ein", "eine", "einen", "einem",
  "einer", "eines", "ist", "sind", "war", "waren", "bin", "bist", "seid",
  "wird", "werden", "wurde", "hat", "habe", "haben", "hatte", "hatten",
  "kann", "können", "muss", "müssen", "soll", "sollen", "halt", "eben",
  "also", "nun", "mal", "doch", "ja",
]);

export function cavemanDe(sentence) {
  const source = String(sentence ?? "").trim();
  if (!source) return "";
  const words = [];
  for (const chunk of source.split(/\s+/)) {
    const core = chunk.replace(/^[("'„“]+/, "").replace(/[)"'“”.,;:!?]+$/, "");
    if (!core || DE_DROP.has(core.toLowerCase())) continue;
    words.push(/,$/.test(chunk) && words.length ? `${core},` : core);
  }
  const line = words.join(" ").replace(/\s+,/g, ",").trim();
  return line || source;
}

/** Valid language ids, for the CLI and the app to check against. */
export function isLanguage(id) {
  return Object.prototype.hasOwnProperty.call(LANGUAGES, String(id));
}

/**
 * The language the pet speaks. `BABYZILLA_PET_LANG` wins over the config file so a
 * shell can try German without writing anything, and the config is the app's
 * (config.json) so the choice follows the pet, not the terminal.
 */
export function resolveLanguage(dir = petDir()) {
  const env = process.env.BABYZILLA_PET_LANG;
  if (env && isLanguage(env)) return env;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8"));
    if (isLanguage(cfg.language)) return cfg.language;
  } catch { /* no config yet: the default */ }
  return "en";
}
