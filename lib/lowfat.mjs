// Pinning the lowfat binary into a rewritten command.
//
// `lowfat rewrite` answers with the tool's *bare* name:
//
//     $ lowfat rewrite "grep -rn foo /tmp | head -5"
//     LOWFAT_PIPED=1 lowfat grep -rn foo /tmp | head -5
//
// That line is then executed by the host's tool shell, whose PATH is not ours —
// a normal macOS tool shell has /opt/homebrew/bin and /usr/bin, but not
// ~/.local/bin, which is exactly where AGENT-INSTALL.md puts lowfat. So every
// rewritten search died with `command not found: lowfat` (exit 127) on machines
// where the install location is not on PATH.
//
// The plugin already resolved the binary to an absolute path to run the rewrite;
// this puts that same path where the shell can find it, in command position only,
// so a literal `lowfat` inside an argument (`grep -rn lowfat .`) is left alone.
// Rewriting beats prefixing PATH: the executed line stays readable in the tool
// log, and it cannot shadow a different lowfat earlier on PATH.

/** A path as one shell word: bare when it is boring, single-quoted otherwise. */
function shellWord(value) {
  const text = String(value);
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(text) ? text : `'${text.replace(/'/g, `'\\''`)}'`;
}

// Start of the line, or after a shell operator, optionally behind env assignments
// (`LOWFAT_PIPED=1 lowfat …`). Deliberately not /g on `lowfat` itself: only a
// word in command position is a program.
const COMMAND_POSITION = /(^|[|;&(]\s*)((?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*)lowfat(?=\s|$)/g;

/**
 * Replace every command-position `lowfat` with the absolute path we resolved.
 * Anything else in the string — arguments, quoted text, a path that already is
 * absolute — is returned untouched.
 */
export function pinLowfat(command, binary) {
  if (typeof command !== "string" || !command || !binary) return command;
  const word = shellWord(binary);
  return command.replace(COMMAND_POSITION, (_match, lead, env) => `${lead}${env}${word}`);
}

/**
 * Belt and braces for a rewrite shape this file has not seen: put the binary's
 * own directory in front of PATH for that one command.
 */
export function withLowfatOnPath(command, binary) {
  if (!command || !binary) return command;
  const dir = String(binary).replace(/\/[^/]*$/, "") || ".";
  return `PATH=${shellWord(dir)}:"$PATH" ${command}`;
}

/** True when a rewritten line still asks for a bare `lowfat`. */
export function hasBareLowfat(command) {
  if (typeof command !== "string" || !command) return false;
  COMMAND_POSITION.lastIndex = 0;
  return COMMAND_POSITION.test(command);
}
