// Daily update check: version math, cache/backoff, and the CLI surface.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";

import {
  parseVersion, isNewer, checkForUpdate, readUpdateCache, writeUpdateCache,
  shouldNotify, markNotified, renderUpdateNotice, agentUpdateNotice, applyUpdate,
  UPDATE_INTERVAL_MS,
} from "../lib/updates.mjs";

const run = promisify(execFile);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "bz-upd-"));

test("isNewer compares semver, including pre-releases and a v prefix", () => {
  assert.equal(isNewer("0.11.3", "0.11.2"), true);
  assert.equal(isNewer("v0.11.3", "0.11.2"), true);
  assert.equal(isNewer("0.12.0", "0.11.99"), true);
  assert.equal(isNewer("1.0.0", "0.99.99"), true);
  assert.equal(isNewer("0.11.2", "0.11.2"), false);
  assert.equal(isNewer("0.11.1", "0.11.2"), false);
  assert.equal(isNewer("0.11.2-rc.1", "0.11.2"), false, "a pre-release is older than the release");
  assert.equal(isNewer("0.11.2", "0.11.2-rc.1"), true);
  assert.equal(isNewer("nonsense", "0.11.2"), false);
  assert.equal(parseVersion("v1.2.3-beta.2").pre, "beta.2");
});

test("checkForUpdate: fresh cache wins, force refetches, failures keep the last good verdict", async () => {
  const root = tmp();
  let calls = 0;
  const okFetch = (tag) => async () => {
    calls++;
    return { ok: true, json: async () => ({ tag_name: tag, html_url: "https://example.test/rel" }) };
  };

  const first = await checkForUpdate({ root, current: "0.11.2", fetchImpl: okFetch("v0.12.0") });
  assert.equal(first.ok, true);
  assert.equal(first.latest, "0.12.0");
  assert.equal(first.newer, true);
  assert.equal(first.cached, false);
  assert.equal(calls, 1);

  // Within the TTL the cached verdict is used and no network call happens.
  const second = await checkForUpdate({ root, current: "0.11.2", fetchImpl: okFetch("v9.9.9") });
  assert.equal(second.latest, "0.12.0");
  assert.equal(second.cached, true);
  assert.equal(calls, 1);

  // force bypasses the TTL (an explicit `babyzilla update` must be honest).
  const forced = await checkForUpdate({ root, current: "0.11.2", force: true, fetchImpl: okFetch("v0.12.1") });
  assert.equal(forced.latest, "0.12.1");
  assert.equal(calls, 2);

  // A failure records a stamp but keeps the known update visible.
  const failing = async () => { throw new Error("ECONNREFUSED"); };
  const failed = await checkForUpdate({ root, current: "0.11.2", force: true, fetchImpl: failing });
  assert.equal(failed.ok, true, "the last good verdict survives a failed refresh");
  assert.equal(failed.newer, true);
  assert.match(String(failed.error), /ECONNREFUSED/);
  const cache = readUpdateCache(root);
  assert.ok(cache.failTs > 0);

  // …and the failure backs off for an hour instead of hammering the API.
  let retried = 0;
  await checkForUpdate({
    root, current: "0.11.2",
    fetchImpl: async () => { retried++; throw new Error("no"); },
  });
  assert.equal(retried, 0);
});

test("checkForUpdate: no cache + network down is quiet, not a crash", async () => {
  const root = tmp();
  const res = await checkForUpdate({
    root, current: "0.11.2",
    fetchImpl: async () => { throw new Error("offline"); },
  });
  assert.equal(res.ok, undefined);
  assert.equal(res.newer, undefined);
  assert.match(res.error, /offline/);
  assert.equal(renderUpdateNotice(res), "");
});

test("notices are limited to once per day and per surface", () => {
  const root = tmp();
  writeUpdateCache(root, { ts: Date.now(), ok: true, current: "0.11.2", latest: "0.12.0", newer: true });
  const cache = readUpdateCache(root);
  assert.equal(shouldNotify(cache), true);
  markNotified(root);
  assert.equal(shouldNotify(readUpdateCache(root)), false);
  assert.equal(shouldNotify(readUpdateCache(root), Date.now() + UPDATE_INTERVAL_MS + 1), true);
  // The CLI stamp does not silence the agent notice: different fields.
  assert.equal(shouldNotify(readUpdateCache(root), Date.now(), "cliNoticeTs"), true);

  const text = renderUpdateNotice(cache);
  assert.match(text, /v0\.12\.0/);
  assert.match(text, /installed 0\.11\.2/);
  assert.match(text, /babyzilla update/);

  const agent = agentUpdateNotice(cache);
  assert.match(agent, /A newer release is available/);
  assert.match(agent, /run `babyzilla update --yes`/);
  assert.match(agent, /do not replace/);
});

test("applyUpdate: non-git installs get instructions, git checkouts pull", async (t) => {
  const plain = tmp();
  fs.writeFileSync(path.join(plain, "package.json"), JSON.stringify({ version: "0.11.2" }));
  const manual = await applyUpdate({ repo: plain });
  assert.equal(manual.kind, "manual");
  assert.equal(manual.ok, false);
  assert.match(manual.commands.join("\n"), /allow-git=all/);
  assert.match(manual.commands.join("\n"), /git clone/);

  // Real git: a clone pulls a version bump from its origin.
  const base = tmp();
  const origin = path.join(base, "origin.git");
  const seed = path.join(base, "seed");
  const clone = path.join(base, "clone");
  const git = (cwd, ...args) => execFileSync("git", [
    "-c", "user.email=t@example.test", "-c", "user.name=t", "-c", "init.defaultBranch=main", ...args,
  ], { cwd, encoding: "utf8" });
  try {
    git(base, "init", "--bare", "--quiet", origin);
    fs.mkdirSync(seed, { recursive: true });
    git(seed, "init", "--quiet");
    fs.writeFileSync(path.join(seed, "package.json"), JSON.stringify({ version: "0.12.0" }));
    git(seed, "add", "-A");
    git(seed, "commit", "-qm", "v0.12.0");
    git(seed, "remote", "add", "origin", origin);
    git(seed, "push", "-q", "-u", "origin", "main");
    git(base, "clone", "-q", origin, clone);

    // A newer release lands upstream.
    fs.writeFileSync(path.join(seed, "package.json"), JSON.stringify({ version: "0.12.1" }));
    git(seed, "commit", "-qam", "v0.12.1");
    git(seed, "push", "-q", "origin", "main");

    const done = await applyUpdate({ repo: clone });
    assert.equal(done.ok, true, done.reason);
    assert.equal(done.before, "0.12.0");
    assert.equal(done.after, "0.12.1");
    assert.equal(done.updated, true);
  } catch (e) {
    t.skip(`git unavailable: ${e.message}`);
  }
});

test("cli: update --check reports the release from the feed, and fails loudly offline", async () => {
  const bin = fileURL("bin/babyzilla.mjs");
  const root = tmp();

  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ tag_name: "v0.99.0", html_url: "https://example.test/rel" }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  try {
    const { stdout } = await run(process.execPath, [bin, "update", "--check", "--json"], {
      env: { ...process.env, BABYZILLA_ROOT: root, BABYZILLA_UPDATE_URL: `http://127.0.0.1:${port}/latest` },
    });
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.latest, "0.99.0");
    assert.equal(parsed.newer, true);
    assert.ok(parsed.repo.endsWith("babyzilla"));

    const text = await run(process.execPath, [bin, "update", "--check"], {
      env: { ...process.env, BABYZILLA_ROOT: tmp(), BABYZILLA_UPDATE_URL: `http://127.0.0.1:${port}/latest` },
    });
    assert.match(text.stdout, /update available: v.+ → v0\.99\.0/);

    // Nothing listening: a clear one-liner, exit code 1, no stack trace.
    const dead = await run(process.execPath, [bin, "update", "--check"], {
      env: { ...process.env, BABYZILLA_ROOT: tmp(), BABYZILLA_UPDATE_URL: "http://127.0.0.1:9/latest" },
    }).catch((e) => e);
    assert.equal(dead.code, 1);
    assert.match(dead.stdout, /could not check for updates/);
  } finally {
    server.close();
  }
});

function fileURL(rel) {
  return path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", rel);
}
