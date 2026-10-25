// Setup wizard: detection, planning, and the writes it is allowed to make.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  inspectConfig, planSetup, globMatch, resolveRule, resolveRuleset, expandHome,
  probe, applyConfig, RECALL_PATTERNS,
} from "../lib/setup.mjs";
import { at, decode, parseJsonc } from "../lib/jsonc.mjs";

const run = promisify(execFile);
const BIN = fileURLToPath(new URL("../bin/babyzilla.mjs", import.meta.url));
const HOME = os.homedir();
const ROOT = path.join(HOME, ".opencode", "contextpacks");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "bz-setup-"));

const CONFIG = `{
  "$schema": "https://opencode.ai/config.json",
  // keep me
  "plugins": [
    { "package": "/Users/me/src/babyzilla", "options": { "stablePrefix": true } }
  ]
}
`;

test("wildcards, home expansion and last-match-wins", () => {
  assert.equal(globMatch("babyzilla recall *", "babyzilla recall abc"), true);
  assert.equal(globMatch("git *", "git status"), true);
  assert.equal(globMatch("git", "git status"), false);
  assert.equal(globMatch("a?c", "abc"), true);
  assert.equal(expandHome("~/x/**", "/h"), "/h/x/**");
  assert.equal(resolveRule({ "*": "ask", "git *": "allow" }, "git status"), "allow");
  assert.equal(resolveRule({ "*": "ask", "git *": "allow" }, "rm -rf /"), "ask");
  assert.equal(resolveRule("allow", "anything"), "allow");
  assert.equal(resolveRule({ "*": "allow", "rm *": "deny", "rm -rf /tmp": "allow" }, "rm -rf /tmp"), "allow");
  const rules = [
    { action: "bash", resource: "*", effect: "ask" },
    { action: "bash", resource: "babyzilla *", effect: "allow" },
  ];
  assert.equal(resolveRuleset(rules, "bash", "babyzilla recall x"), "allow");
  assert.equal(resolveRuleset(rules, "bash", "npm test"), "ask");
});

test("inspectConfig finds the plugin entry and the recall gap", () => {
  const info = inspectConfig(CONFIG);
  assert.equal(info.registered, true);
  assert.match(info.plugin.spec, /babyzilla/);
  assert.equal(info.permission.form, "absent");
  // No permission block at all: OpenCode allows bash by default, so recall is
  // already reachable and the wizard must not invent a gap.
  assert.equal(info.permission.recallAllowed, true);
  assert.equal(info.permission.recallEffect, "allow");
  assert.equal(info.permission.externalAllowed, false, "external_directory still asks by default");

  const allowed = inspectConfig(`{
    "permission": { "bash": { "*": "ask", "babyzilla recall *": "allow", "babyzilla retrieve *": "allow" } }
  }`);
  assert.equal(allowed.permission.recallAllowed, true);
  assert.equal(inspectConfig('{ "permission": "allow" }').permission.recallAllowed, true);
  assert.equal(inspectConfig('{ "permission": { "bash": "deny" } }').permission.recallEffect, "deny");
});

test("plan: adds narrow bash allows after a broad ask rule, idempotently", () => {
  const doc = `{
  "permission": {
    "bash": { "*": "ask" }
  }
}`;
  const plan = planSetup({ text: doc, root: ROOT, answers: {} });
  const info = inspectConfig(plan.text);
  assert.equal(info.permission.recallAllowed, true);
  assert.equal(info.permission.externalAllowed, true, "pack directory is readable by the agent");
  const bash = info.raw.permission.bash;
  assert.deepEqual(Object.keys(bash), ["*", ...RECALL_PATTERNS], "new allows must come after the broad rule");
  assert.equal(plan.changes.filter((c) => c.kind === "permission").length, 3);

  const again = planSetup({ text: plan.text, root: ROOT, answers: {} });
  assert.equal(again.changed, false);
  assert.deepEqual(again.changes, []);
});

test("plan: a global bash string keeps its intent as the wildcard", () => {
  const doc = '{\n  "permission": { "bash": "deny" }\n}';
  const plan = planSetup({ text: doc, root: ROOT, answers: {} });
  const bash = inspectConfig(plan.text).raw.permission.bash;
  assert.equal(bash["*"], "deny", "the deliberate deny is preserved");
  assert.equal(bash["babyzilla recall *"], "allow");
  assert.ok(plan.warnings.some((w) => /denied globally/i.test(w)), "and it is called out");
});

test("plan: opting out of the recall allow is reported, not silently ignored", () => {
  const doc = '{\n  "permission": { "bash": { "*": "ask" } }\n}';
  const plan = planSetup({ text: doc, root: ROOT, answers: { allowRecall: false, allowExternal: false } });
  assert.equal(inspectConfig(plan.text).permission.recallAllowed, false);
  assert.ok(plan.warnings.some((w) => /Recall still needs approval/i.test(w)));
});

test("plan: modern permissions ruleset gets appended allow rules", () => {
  const doc = `{
  "permissions": [
    { "action": "bash", "resource": "*", "effect": "ask" }
  ]
}`;
  const plan = planSetup({ text: doc, root: ROOT, answers: {} });
  const rules = inspectConfig(plan.text).raw.ruleset;
  assert.equal(rules.length, 3);
  assert.deepEqual(rules[1], { action: "bash", resource: "babyzilla recall *", effect: "allow" });
  assert.equal(inspectConfig(plan.text).permission.recallAllowed, true);
  assert.equal(planSetup({ text: plan.text, root: ROOT, answers: {} }).changed, false);
});

test("plan: registers a missing plugin and writes chosen options", () => {
  const plan = planSetup({
    text: '{\n  "$schema": "https://opencode.ai/config.json"\n}\n',
    root: ROOT,
    answers: { selfLearn: false, checkUpdates: true },
  });
  const info = inspectConfig(plan.text);
  assert.equal(info.registered, true);
  assert.equal(info.plugin.kind, "object");
  assert.equal(info.plugin.spec, "github:StibaDu/babyzilla");
  const options = value(plan.text, ["plugins", 0, "options"]);
  assert.deepEqual(options, { selfLearn: false, checkUpdates: true });
  assert.ok(plan.text.includes("// keep me") === false);
});

test("plan: string plugin entries become object entries when options are needed", () => {
  const doc = '{\n  "plugins": ["github:StibaDu/babyzilla"]\n}';
  const plan = planSetup({ text: doc, root: ROOT, answers: { selfLearn: true } });
  const entry = value(plan.text, ["plugins", 0]);
  assert.equal(entry.package, "github:StibaDu/babyzilla");
  assert.deepEqual(entry.options, { selfLearn: true });
  const again = planSetup({ text: plan.text, root: ROOT, answers: { selfLearn: true } });
  assert.equal(again.changed, false, "second pass is a no-op");
});

test("plan: existing options and comments are preserved", () => {
  const plan = planSetup({ text: CONFIG, root: ROOT, answers: { checkUpdates: false } });
  assert.ok(plan.text.includes("// keep me"));
  assert.equal(value(plan.text, ["plugins", 0, "options", "stablePrefix"]), true);
  assert.equal(value(plan.text, ["plugins", 0, "options", "checkUpdates"]), false);
});

test("plan: denies for `task` are surfaced for vision routing", () => {
  const doc = '{\n  "permission": { "task": "deny" }\n}';
  const plan = planSetup({ text: doc, root: ROOT, answers: {} });
  assert.ok(plan.warnings.some((w) => /vision routing/i.test(w)));
});

test("plan: a single-line config is pretty-printed instead of spliced", () => {
  const plan = planSetup({ text: '{"permission":{"bash":{"*":"ask"}}}', root: ROOT, answers: {} });
  assert.ok(plan.text.includes("\n  \"permission\""));
  const parsed = JSON.parse(plan.text);
  assert.equal(parsed.permission.bash["babyzilla recall *"], "allow");
  assert.equal(JSON.parse(plan.text).permission.bash["*"], "ask");
});

test("applyConfig writes atomically and keeps a backup", () => {
  const dir = tmp();
  const file = path.join(dir, "opencode.jsonc");
  fs.writeFileSync(file, '{\n  "a": 1\n}\n', { mode: 0o644 });
  const res = applyConfig({ file, text: '{\n  "a": 2\n}\n', now: 1_700_000_000_000 });
  assert.equal(fs.readFileSync(file, "utf8"), '{\n  "a": 2\n}\n');
  assert.equal(fs.readFileSync(res.backup, "utf8"), '{\n  "a": 1\n}\n');
  assert.equal(fs.statSync(file).mode & 0o777, 0o644, "mode preserved");
});

test("probe proves the data dir, compression and recall on this machine", () => {
  const root = path.join(tmp(), "ctx");
  const checks = probe({ root });
  const byId = Object.fromEntries(checks.map((c) => [c.id, c]));
  assert.equal(byId.node.ok, true);
  assert.equal(byId["data-dir"].ok, true);
  assert.equal(byId.compression.ok, true, byId.compression.detail);
  assert.match(byId.compression.detail, /% smaller/);
  assert.equal(byId.recall.ok, true, byId.recall.detail);
});

function value(text, pathParts) {
  const node = at(parseJsonc(text), pathParts);
  assert.ok(node, `missing ${pathParts.join(".")}`);
  return decode(node);
}

test("cli: setup --yes writes, keeps comments, backs up, and is idempotent", async () => {
  const dir = tmp();
  const file = path.join(dir, "opencode.jsonc");
  fs.writeFileSync(file, `{\n  // keep me\n  "permission": { "bash": { "*": "ask" } },\n  "plugins": [\n    { "package": "/Users/me/src/babyzilla", "options": { "stablePrefix": true } }\n  ]\n}\n`);
  const env = { ...process.env, BABYZILLA_NO_UPDATE_CHECK: "1" };

  const first = await run(process.execPath, [BIN, "setup", "--config", file, "--yes"], { env });
  assert.match(first.stdout, /wrote/);
  assert.match(first.stdout, /compression\s+\d+% smaller/);
  const after = fs.readFileSync(file, "utf8");
  assert.ok(after.includes("// keep me"), "user comment survived");
  assert.equal(value(after, ["permission", "bash", "babyzilla recall *"]), "allow");
  assert.equal(value(after, ["permission", "bash", "babyzilla retrieve *"]), "allow");
  assert.equal(value(after, ["plugins", 0, "options", "stablePrefix"]), true, "existing options untouched");
  assert.equal(fs.readdirSync(dir).filter((n) => n.includes(".bak-")).length, 1);

  const second = await run(process.execPath, [BIN, "setup", "--config", file, "--yes"], { env });
  assert.match(second.stdout, /config already complete/);
  assert.equal(fs.readFileSync(file, "utf8"), after, "no rewrite");
  assert.equal(fs.readdirSync(dir).filter((n) => n.includes(".bak-")).length, 1, "no extra backup");
});

test("cli: --json reports the plan and writes only with --yes", async () => {
  const dir = tmp();
  const file = path.join(dir, "opencode.json");
  fs.writeFileSync(file, '{ "permission": { "bash": "ask" } }\n');
  const env = { ...process.env, BABYZILLA_NO_UPDATE_CHECK: "1" };

  const dry = await run(process.execPath, [BIN, "setup", "--config", file, "--json"], { env });
  const dryPlan = JSON.parse(dry.stdout);
  assert.equal(dryPlan.wrote, null);
  assert.ok(dryPlan.plan.changes.length >= 3);
  assert.equal(fs.readFileSync(file, "utf8"), '{ "permission": { "bash": "ask" } }\n', "unchanged without --yes");

  const applied = await run(process.execPath, [BIN, "setup", "--config", file, "--json", "--yes"], { env });
  const appliedPlan = JSON.parse(applied.stdout);
  assert.ok(appliedPlan.wrote.file.endsWith("opencode.json"));
  assert.equal(appliedPlan.plan.changes.length, dryPlan.plan.changes.length);
  assert.ok(JSON.parse(fs.readFileSync(file, "utf8")).permission.bash["babyzilla recall *"] === "allow");
});
