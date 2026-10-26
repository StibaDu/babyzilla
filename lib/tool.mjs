// Where a system tool actually lives.
//
// macOS moves these between /usr/bin and /bin and it does not announce it: on
// macOS 26+ `/usr/bin/ps` and `/usr/bin/kill` no longer exist (they are in
// /bin), so a hardcoded path fails with ENOENT and the code around it silently
// decides "not running". The same mistake, one layer down, is what the lowfat
// report was about: never assume a binary is where it used to be.

import fs from "node:fs";

const cache = new Map();

/**
 * Locate a tool once per process: first the usual spots, then PATH.
 *
 * Returns the bare name when nothing is found, so the caller still gets a
 * normal `spawn ENOENT` instead of a wrong path that happens to exist on
 * another machine.
 */
export function tool(name, ...preferred) {
  if (cache.has(name)) return cache.get(name);
  const candidates = [...preferred, `/usr/bin/${name}`, `/bin/${name}`, `/usr/sbin/${name}`, `/sbin/${name}`];
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile()) {
        cache.set(name, candidate);
        return candidate;
      }
    } catch { /* try the next one */ }
  }
  cache.set(name, name);
  return name;
}
