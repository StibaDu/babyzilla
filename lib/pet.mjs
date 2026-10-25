// Bridge between the plugin and the desktop pet.
//
// The plugin never talks to the app directly: it appends one JSON object per
// line to ~/.opencode/pet/events.jsonl and the app tails the file. That keeps
// the plugin free of sockets, ports and lifecycle problems — if the pet is not
// running the writes are just a few bytes on disk, and if the app starts late
// it picks up from the end of the file.
//
// Nothing in here may throw into a hook. Every public function swallows errors.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** State dir, overridable so tests never touch the real one. */
export function petDir() {
  return process.env.BABYZILLA_PET_STATE || path.join(os.homedir(), ".opencode", "pet");
}
export function eventsPath() {
  return path.join(petDir(), "events.jsonl");
}
const MAX_BYTES = 512 * 1024;

/** Pet is on unless explicitly disabled. It costs one append per event. */
export function petEnabled(opts) {
  if (process.env.BABYZILLA_PET === "0") return false;
  if (opts?.pet === false) return false;
  return true;
}

let lastWrite = 0;
let queue = [];

/** Coalesce bursts: opencode can fire dozens of tool events per second. */
export function emit(event, { throttleMs = 0 } = {}) {
  try {
    const now = Date.now();
    if (throttleMs && now - lastWrite < throttleMs) return false;
    lastWrite = now;
    queue.push(JSON.stringify({ t: now, ...event }));
    if (queue.length > 64) queue = queue.slice(-64);
    if (!flush()) return false;
    return true;
  } catch {
    return false;
  }
}

let flushing = false;
function flush() {
  if (flushing || !queue.length) return true;
  flushing = true;
  const body = queue.join("\n") + "\n";
  queue = [];
  try {
    const dir = petDir();
    const file = eventsPath();
    fs.mkdirSync(dir, { recursive: true });
    try {
      const st = fs.statSync(file);
      if (st.size > MAX_BYTES) fs.renameSync(file, `${file}.1`);
    } catch { /* first write */ }
    fs.appendFileSync(file, body);
  } catch {
    return false;
  } finally {
    flushing = false;
  }
  return true;
}

export function expr(id, hold = 1.8) {
  return emit({ kind: "expr", id, hold });
}

export function say(text) {
  if (!text) return false;
  return emit({ kind: "say", text: String(text).slice(0, 160) });
}

export function busy(on) {
  return emit({ kind: "busy", on: Boolean(on) });
}
