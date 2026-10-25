// Daily update check — one cached GitHub lookup, no dependencies.
//
// The check must never cost the user anything: it runs at most once every 24
// hours, has a short timeout, caches its result in <ROOT>/update.json, and a
// failure is a stamp (retry in an hour), not an error the user has to read.
// Two surfaces consume it: the plugin (tells the agent to mention the update
// once and ask) and the CLI (`babyzilla update` to act on it).
//
// Side-effect free except for the cache file, so the whole thing is testable
// with an injected fetch.

import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export const UPDATE_REPO = "StibaDu/babyzilla";
export const UPDATE_INTERVAL_MS = 24 * 3600_000;
export const RETRY_AFTER_MS = 3600_000;

export const disabled = () => {
  const v = String(process.env.BABYZILLA_NO_UPDATE_CHECK ?? "").toLowerCase();
  return v === "1" || v === "true" || v === "yes";
};

// ── versions ───────────────────────────────────────────────────────────────
export function parseVersion(value) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(String(value ?? "").trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] ?? null };
}

/** True when `candidate` is a strictly newer release than `current`. */
export function isNewer(candidate, current) {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (const k of ["major", "minor", "patch"]) {
    if (a[k] !== b[k]) return a[k] > b[k];
  }
  if (!a.pre && b.pre) return true;
  if (a.pre && !b.pre) return false;
  // Same core version: both pre-releases compare lexically, which is enough
  // for "is there something newer than the tag I am running".
  return Boolean(a.pre && b.pre && a.pre > b.pre);
}

// ── cache ──────────────────────────────────────────────────────────────────
export function cachePath(root) {
  return path.join(root, "update.json");
}

export function readUpdateCache(root) {
  try {
    const raw = JSON.parse(fs.readFileSync(cachePath(root), "utf8"));
    return raw && typeof raw === "object" ? raw : null;
  } catch {
    return null;
  }
}

/** Merge-write: a check must not drop the notice stamps it does not own. */
export function writeUpdateCache(root, data) {
  const prev = readUpdateCache(root) ?? {};
  const next = { ...prev, ...data };
  try {
    fs.mkdirSync(root, { recursive: true });
    const p = cachePath(root);
    const tmp = `${p}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n");
    fs.renameSync(tmp, p);
  } catch {
    /* a cache that cannot be written is not an error worth reporting */
  }
  return next;
}

// ── check ──────────────────────────────────────────────────────────────────
function feedUrl() {
  return process.env.BABYZILLA_UPDATE_URL ||
    `https://api.github.com/repos/${UPDATE_REPO}/releases/latest`;
}

/**
 * Return the cached verdict when it is still fresh, otherwise ask GitHub.
 *
 * `{ ok, current, latest, newer, url, cached, error }`. A network failure is
 * recorded as `failTs` (retry in an hour) and keeps the last good verdict, so
 * a flaky connection never hides a known update or nags about being offline.
 */
export async function checkForUpdate({
  root,
  current,
  now = Date.now(),
  force = false,
  fetchImpl = globalThis.fetch,
  timeoutMs = 2500,
} = {}) {
  const cache = readUpdateCache(root);
  const fresh = cache?.ok === true && now - (cache.ts ?? 0) < UPDATE_INTERVAL_MS;
  if (fresh && !force) return { ...cache, cached: true };

  const failedRecently = !fresh && cache && now - (cache.failTs ?? 0) < RETRY_AFTER_MS;
  if (failedRecently && !force) return { ...cache, cached: true };

  if (typeof fetchImpl !== "function") {
    return { ...(cache ?? {}), ok: Boolean(cache?.ok), cached: true, error: "fetch unavailable" };
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetchImpl(feedUrl(), {
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": `babyzilla/${current ?? "unknown"}`,
      },
      signal: ac.signal,
    });
    if (!res?.ok) throw new Error(`HTTP ${res?.status ?? "?"}`);
    const body = await res.json();
    const latest = String(body?.tag_name ?? body?.name ?? "").replace(/^v/, "").trim();
    if (!latest) throw new Error("no release tag in response");
    const data = writeUpdateCache(root, {
      ts: now,
      ok: true,
      current,
      latest,
      url: body?.html_url ?? `https://github.com/${UPDATE_REPO}/releases`,
      newer: isNewer(latest, current),
      error: null,
    });
    return { ...data, cached: false };
  } catch (e) {
    const error = String(e?.name === "AbortError" ? "check timed out" : (e?.message ?? e)).slice(0, 160);
    const data = writeUpdateCache(root, { failTs: now, error });
    return { ...data, cached: false };
  } finally {
    clearTimeout(timer);
  }
}

// ── telling the user ───────────────────────────────────────────────────────
/** At most one notice per day, per surface. */
export function shouldNotify(cache, now = Date.now(), field = "noticedTs") {
  return Boolean(cache?.ok && cache.newer && now - (cache[field] ?? 0) >= UPDATE_INTERVAL_MS);
}

export function markNotified(root, now = Date.now(), field = "noticedTs") {
  writeUpdateCache(root, { [field]: now });
}

/** One line for the CLI. */
export function renderUpdateNotice(cache) {
  if (!cache?.newer) return "";
  return `⬆ BabyZilla v${cache.latest} is available (installed ${cache.current}) — run: babyzilla update`;
}

/**
 * Instructions for the model, not the user: mention it once, ask, and only
 * then act. The user's actual request must still be answered.
 */
export function agentUpdateNotice(cache) {
  return `[babyzilla update] A newer release is available: v${cache.latest} (installed ${cache.current}). ` +
    `Mention this once, in one short sentence, alongside your answer to the user's request — do not replace ` +
    `or delay that answer. Ask whether they want to update now. If they say yes, run \`babyzilla update --yes\` ` +
    `and tell them to restart opencode afterwards. If they say no, drop it and do not ask again in this session.`;
}

// ── applying ───────────────────────────────────────────────────────────────
export function readVersion(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).version ?? null;
  } catch {
    return null;
  }
}

const GIT_INSTALL = `npm i -g --allow-git=all git+https://github.com/${UPDATE_REPO}.git`;
const CLONE_INSTALL = `git clone https://github.com/${UPDATE_REPO}.git ~/.local/src/babyzilla && npm i -g ~/.local/src/babyzilla`;

/**
 * Update in place when this copy is a git checkout (the documented install);
 * otherwise say exactly what to run and leave the machine alone.
 */
export async function applyUpdate({ repo, run: runner = defaultRun } = {}) {
  const before = readVersion(repo);
  if (!fs.existsSync(path.join(repo, ".git"))) {
    return {
      kind: "manual",
      ok: false,
      before,
      reason: "this copy is not a git checkout",
      commands: [GIT_INSTALL, CLONE_INSTALL],
    };
  }
  const r = await runner("git", ["-C", repo, "pull", "--ff-only"]);
  if (r.code !== 0) {
    return {
      kind: "git",
      ok: false,
      before,
      reason: (r.stderr || r.stdout || `git exited ${r.code}`).trim().slice(-400),
    };
  }
  const after = readVersion(repo);
  return { kind: "git", ok: true, before, after, updated: Boolean(before && after && before !== after) };
}

async function defaultRun(cmd, args) {
  try {
    const { stdout, stderr } = await run(cmd, args, { timeout: 180_000, maxBuffer: 8 * 1024 * 1024 });
    return { code: 0, stdout, stderr };
  } catch (e) {
    return { code: e?.code ?? 1, stdout: e?.stdout ?? "", stderr: e?.stderr ?? String(e?.message ?? e) };
  }
}
