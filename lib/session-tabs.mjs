// Open sessions, from OpenCode's TUI tab strip.
//
//   ~/.local/state/opencode/latest/tui/tabs.json
//   { global: { tabs: [...] }, cwd: { "<workspace>": { tabs: [...] } } }
//
// This is client state, not a stable API. A missing or torn file means "no
// open tabs"; the caller decides whether to fall back to every pack. The
// longest workspace that contains the current directory wins, so running
// from a project subdirectory still finds the workspace's tab strip.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function defaultTabsPath() {
  if (process.env.BABYZILLA_TABS) return path.resolve(process.env.BABYZILLA_TABS);
  const stateHome = process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state");
  return path.join(stateHome, "opencode", "latest", "tui", "tabs.json");
}

function isInside(root, dir) {
  const rel = path.relative(path.resolve(root), path.resolve(dir));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

function readTabs(entry) {
  if (!entry || !Array.isArray(entry.tabs)) return [];
  return entry.tabs
    .filter((tab) => tab && typeof tab.sessionID === "string" && tab.sessionID)
    .map((tab) => ({
      id: tab.sessionID,
      title: typeof tab.title === "string" ? tab.title : "",
    }));
}

/**
 * Sessions with an open tab in the current workspace. The current OpenCode
 * session (`OPENCODE_SESSION_ID`) wins when it appears in a tab strip, so the
 * answer does not depend on the shell's cwd; otherwise the longest workspace
 * containing `cwd` is used. Global tabs (if the UI ever has them) are included
 * once. With no matching workspace and more than one candidate, `sessions` is
 * empty rather than a guess.
 */
export function readSessionTabs({
  file = defaultTabsPath(),
  cwd = process.cwd(),
  sessionID = process.env.OPENCODE_SESSION_ID,
} = {}) {
  let data = null;
  try { data = JSON.parse(fs.readFileSync(file, "utf8")); } catch { /* no tab state */ }

  const byCwd = data?.cwd && typeof data.cwd === "object" ? data.cwd : {};
  const keys = Object.keys(byCwd);
  let workspace = null;
  if (sessionID) {
    workspace = keys.find((key) => readTabs(byCwd[key]).some((tab) => tab.id === sessionID)) ?? null;
  }
  if (!workspace) {
    const candidates = keys
      .filter((key) => isInside(key, cwd))
      .sort((a, b) => path.resolve(b).length - path.resolve(a).length);
    workspace = candidates[0] ?? (keys.length === 1 ? keys[0] : null);
  }

  const seen = new Set();
  const sessions = [];
  for (const tab of [...readTabs(data?.global), ...readTabs(workspace ? byCwd[workspace] : null)]) {
    if (seen.has(tab.id)) continue;
    seen.add(tab.id);
    sessions.push(tab);
  }

  return { file, workspace, keys, sessions, open: sessions.length > 0 };
}

/**
 * Title for any tab, across every workspace. Used by the charter when the
 * current session is not the one that selected the strip (CLI `--session`).
 */
export function sessionTitle(sessionID, { file = defaultTabsPath() } = {}) {
  if (!sessionID) return null;
  let data = null;
  try { data = JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
  const groups = [data?.global, ...Object.values(data?.cwd ?? {})];
  for (const group of groups) {
    const match = readTabs(group).find((tab) => tab.id === sessionID);
    if (match?.title) return match.title;
  }
  return null;
}
