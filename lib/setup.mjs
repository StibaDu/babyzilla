// Setup wizard: what BabyZilla actually needs on this machine, checked and
// (with consent) written into the OpenCode config.
//
// The rule this module follows: never guess about the user's config. Every
// check reads the real file, every edit goes through lib/jsonc.mjs so comments
// and ordering survive, and anything that would weaken a deliberate `deny` is
// reported instead of silently overridden.
//
// The permission that matters in practice is `bash`: paged-out tool output is
// only recoverable through `babyzilla recall` / `retrieve`. If bash is set to
// "ask", the agent has to interrupt the user for every recall; if it is
// "deny", the recovery path is closed. `external_directory` matters when the
// agent opens a module file by absolute path (packs live outside the project).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { parseJsonc, at, decode, member, setPath, appendToContainer, insertMember } from "./jsonc.mjs";
import { applyStableCompression } from "./text.mjs";
import { writePage, readPage } from "./pages.mjs";

export const RECALL_PATTERNS = ["babyzilla recall *", "babyzilla retrieve *"];
export const PLUGIN_SPEC = "github:StibaDu/babyzilla";
export const MIN_NODE_MAJOR = 18;

// ── locating the config ────────────────────────────────────────────────────
export function configCandidates({ env = process.env, home = os.homedir() } = {}) {
  const list = [];
  if (env.OPENCODE_CONFIG) list.push(env.OPENCODE_CONFIG);
  const xdg = env.XDG_CONFIG_HOME || path.join(home, ".config");
  for (const dir of [path.join(xdg, "opencode"), path.join(home, ".opencode")]) {
    for (const name of ["opencode.jsonc", "opencode.json"]) list.push(path.join(dir, name));
  }
  return list;
}

export function locateConfig(opts = {}) {
  const list = configCandidates(opts);
  return list.find((p) => {
    try { return fs.statSync(p).isFile(); } catch { return false; }
  }) ?? null;
}

// ── rule resolution ────────────────────────────────────────────────────────
/** `~` and `$HOME` expand at the start of a pattern (OpenCode does the same). */
export function expandHome(value, home = os.homedir()) {
  return String(value ?? "")
    .replace(/^~(?=$|[\\/])/, home)
    .replace(/^\$HOME(?=$|[\\/])/, home);
}

/** OpenCode wildcards: `*` = any run, `?` = one char. Everything else literal. */
export function globMatch(pattern, value) {
  const p = expandHome(pattern);
  const v = expandHome(value);
  let re = "^";
  for (const ch of p) {
    if (ch === "*") re += ".*";
    else if (ch === "?") re += ".";
    else re += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(re + "$").test(v);
}

/**
 * Effective action for one resource, following OpenCode's semantics:
 * object rules are last-match-wins, and a bare string action applies to all.
 * `rules` is the decoded value of a permission entry (string or object).
 */
export function resolveRule(rules, resource) {
  if (typeof rules === "string") return rules;
  if (!rules || typeof rules !== "object" || Array.isArray(rules)) return null;
  let winner = null;
  for (const [pattern, action] of Object.entries(rules)) {
    if (typeof action !== "string") continue;
    if (globMatch(pattern, resource)) winner = action;
  }
  return winner;
}

// OpenCode defaults when a permission is not configured at all: most tools are
// allowed, `external_directory` and `doom_loop` ask.
export const PERMISSION_DEFAULTS = {
  read: "allow", edit: "allow", glob: "allow", grep: "allow", list: "allow",
  bash: "allow", task: "allow", todowrite: "allow", question: "allow",
  webfetch: "allow", websearch: "allow", lsp: "allow", skill: "allow",
  external_directory: "ask", doom_loop: "ask",
};

/**
 * Effective effect for one resource: the action's own rules, then the global
 * `"*"` rule, then OpenCode's default. (A bare `"*": "ask"` really does make
 * every unlisted tool ask, so it has to be consulted, not ignored.)
 */
export function resolveEffective(permission, action, resource, defaults = PERMISSION_DEFAULTS) {
  if (typeof permission === "string") return permission;
  const entry = permission && typeof permission === "object" ? permission[action] : undefined;
  const star = permission && typeof permission === "object" ? permission["*"] : undefined;
  const direct = entry !== undefined ? resolveRule(entry, resource) : null;
  if (direct) return direct;
  const global = star !== undefined ? resolveRule(star, resource) : null;
  if (global) return global;
  return defaults[action] ?? "allow";
}

/** Resolve through the modern ordered ruleset form (`permissions: [...]`). */
export function resolveRuleset(rules, action, resource) {
  let winner = null;
  for (const rule of Array.isArray(rules) ? rules : []) {
    if (!rule || rule.action !== action) continue;
    if (!globMatch(rule.resource ?? "*", resource)) continue;
    winner = rule.effect ?? null;
  }
  return winner;
}

// ── inspection ─────────────────────────────────────────────────────────────
function pluginEntries(ast) {
  const out = [];
  for (const key of ["plugins", "plugin"]) {
    const node = at(ast, [key]);
    if (node?.type !== "array") continue;
    node.items.forEach((item, index) => {
      if (item.type === "string") {
        out.push({ arrayKey: key, index, node: item, spec: item.value, hasOptions: false, kind: "string" });
      } else if (item.type === "object") {
        const spec = member(item, "package")?.value ?? member(item, "spec")?.value;
        out.push({
          arrayKey: key, index, node: item, spec: decode(spec),
          hasOptions: Boolean(member(item, "options")), kind: "object",
        });
      } else if (item.type === "array" && item.items[0]) {
        // legacy `plugin: [[spec, options]]` tuple
        out.push({
          arrayKey: key, index, node: item, spec: decode(item.items[0]),
          hasOptions: Boolean(item.items[1]), kind: "tuple",
        });
      }
    });
  }
  return out;
}

export function inspectConfig(text) {
  const ast = parseJsonc(text);
  const entries = pluginEntries(ast);
  const plugin = entries.find((e) => /babyzilla/i.test(String(e.spec ?? ""))) ?? null;

  const permissionNode = at(ast, ["permission"]);
  const rulesetNode = at(ast, ["permissions"]);
  const permission = decode(permissionNode) ?? null;
  const ruleset = decode(rulesetNode) ?? null;

  const rulesFor = (action) => {
    if (Array.isArray(ruleset)) return ruleset;
    return permission && typeof permission === "object" ? permission[action] : permission;
  };
  const resolve = (action, resource) => {
    if (Array.isArray(ruleset)) {
      const explicit = resolveRuleset(ruleset, action, resource);
      return explicit ?? PERMISSION_DEFAULTS[action] ?? "allow";
    }
    return resolveEffective(permission, action, resource);
  };

  const recall = RECALL_PATTERNS.map((pattern) => ({
    pattern,
    effect: resolve("bash", pattern.replace(" *", " 8c1f0b7a")),
  }));
  const recallAllowed = recall.every((r) => r.effect === "allow");

  const pluginOptions = plugin?.kind === "object"
    ? (decode(member(plugin.node, "options")?.value) ?? {})
    : {};

  return {
    plugin,
    options: pluginOptions,
    registered: Boolean(plugin),
    pluginCount: entries.length,
    pluginArrayKey: entries[0]?.arrayKey ?? "plugins",
    permission: {
      present: Boolean(permissionNode || rulesetNode),
      form: Array.isArray(ruleset) ? "ruleset" : permissionNode ? "object" : "absent",
      bash: permission && typeof permission === "object" ? permission.bash ?? null : permission,
      external: permission && typeof permission === "object" ? permission.external_directory ?? null : permission,
      recall,
      recallAllowed,
      recallEffect: recallAllowed ? "allow" : (recall.find((r) => r.effect !== "allow")?.effect ?? "unset"),
      externalAllowed: resolve("external_directory", `${os.homedir()}/.opencode/contextpacks/x.md`) === "allow",
      taskEffect: resolve("task", "vision"),
    },
    raw: { permission, ruleset },
  };
}

// ── planning ───────────────────────────────────────────────────────────────
const DEFAULT_ANSWERS = {
  registerPlugin: null,   // null = only if missing
  allowRecall: true,
  allowExternal: true,
  allowTask: null,        // only report when denied
  selfLearn: null,        // null = leave as configured
  checkUpdates: null,
};

/**
 * Compute the new config text and a human-readable change list. Pure: no IO.
 * `root` is the data root, used for the external_directory pattern.
 */
export function planSetup({ text, answers = {}, root, home = os.homedir() }) {
  const a = { ...DEFAULT_ANSWERS, ...answers };
  const changes = [];
  const warnings = [];
  const manual = [];
  let next = text;

  // 1) plugin registration -------------------------------------------------
  const before = inspectConfig(next);
  if (!before.registered) {
    if (a.registerPlugin === false) {
      manual.push(`Add BabyZilla to your OpenCode config (${before.pluginArrayKey}): use \`opencode plugin add ${PLUGIN_SPEC}\`.`);
    } else {
      const spec = a.pluginSpec ?? PLUGIN_SPEC;
      const arrayKey = before.pluginArrayKey;
      const ast = parseJsonc(next);
      const arrayNode = at(ast, [arrayKey]);
      const topIndent = indentOfTopLevel(next, ast);
      const itemIndent = arrayNode?.type === "array" && arrayNode.items.length
        ? indentOfNode(next, arrayNode.items[arrayNode.items.length - 1].start)
        : `${topIndent}  `;
      const item = pluginItemText(next, spec, arrayKey, itemIndent);
      if (arrayNode?.type === "array") {
        next = appendToContainer(next, arrayNode, item);
      } else {
        next = insertMember(next, ast, arrayKey, arrayLiteral(next, item, topIndent));
      }
      changes.push({ kind: "plugin", detail: `${arrayKey} += ${spec}` });
    }
  } else if (before.plugin?.kind === "tuple") {
    manual.push("This config uses the legacy `plugin: [[spec, options]]` form; set options by hand.");
  }

  // 2) options -------------------------------------------------------------
  const optionPairs = [];
  if (typeof a.selfLearn === "boolean") optionPairs.push(["selfLearn", a.selfLearn]);
  if (typeof a.checkUpdates === "boolean") optionPairs.push(["checkUpdates", a.checkUpdates]);
  if (optionPairs.length) {
    const now = inspectConfig(next);
    if (!now.plugin) {
      manual.push("Register the plugin first; then options can be written.");
    } else if (now.plugin.kind === "string") {
      next = promoteStringPlugin(next, now.plugin, optionPairs);
      for (const [k, v] of optionPairs) changes.push({ kind: "option", detail: `options.${k} = ${JSON.stringify(v)}` });
    } else if (now.plugin.kind === "object") {
      const ast = parseJsonc(next);
      const entry = pluginEntries(ast).find((e) => /babyzilla/i.test(String(e.spec ?? "")));
      const optionsNode = member(entry.node, "options");
      for (const [k, v] of optionPairs) {
        const current = optionsNode ? decode(member(optionsNode.value, k)?.value) : undefined;
        if (current === v) continue;
        next = entryPathOptions(next, entry, k, v);
        changes.push({ kind: "option", detail: `options.${k} = ${JSON.stringify(v)}` });
      }
    }
  }

  // 3) permissions ---------------------------------------------------------
  const st = inspectConfig(next);
  const rootPattern = externalPattern(root, home);

  if (a.allowRecall !== false && !st.permission.recallAllowed) {
    const form = st.permission.form;
    if (form === "ruleset") {
      let ruleset = Array.isArray(st.raw.ruleset) ? st.raw.ruleset : [];
      for (const pattern of RECALL_PATTERNS) {
        if (resolveRuleset(ruleset, "bash", pattern.replace(" *", " x")) === "allow") continue;
        ruleset = [...ruleset, { action: "bash", resource: pattern, effect: "allow" }];
        next = appendRule(next, { action: "bash", resource: pattern, effect: "allow" });
        changes.push({ kind: "permission", detail: `permissions += bash ${pattern} → allow` });
      }
    } else if (st.permission.bash === "allow") {
      // already open
    } else if (st.permission.bash && typeof st.permission.bash === "object") {
      for (const pattern of RECALL_PATTERNS) {
        if (resolveRule(st.permission.bash, pattern.replace(" *", " x")) === "allow") continue;
        next = setPermissionRule(next, "bash", pattern, "allow");
        changes.push({ kind: "permission", detail: `bash["${pattern}"] = allow` });
      }
    } else {
      // bash unset, or a bare "ask"/"deny": keep the broad intent as "*"
      const fallback = typeof st.permission.bash === "string" ? st.permission.bash : null;
      if (fallback === "deny") {
        warnings.push("bash is denied globally; the wizard adds a narrow allow for babyzilla recall/retrieve only.");
      }
      if (fallback) next = setPermissionRule(next, "bash", "*", fallback);
      for (const pattern of RECALL_PATTERNS) {
        next = setPermissionRule(next, "bash", pattern, "allow");
        changes.push({ kind: "permission", detail: `bash["${pattern}"] = allow${fallback ? ` (after "*": ${fallback})` : ""}` });
      }
    }
  } else if (a.allowRecall === false && !st.permission.recallAllowed) {
    warnings.push("Recall still needs approval; paged-out tool output will prompt or be unreachable.");
  }

  if (a.allowExternal !== false) {
    const now = inspectConfig(next);
    if (!now.permission.externalAllowed) {
      const ext = now.permission.external;
      if (ext === "allow") {
        // open
      } else if (ext && typeof ext === "object") {
        next = setPermissionRule(next, "external_directory", rootPattern, "allow");
        changes.push({ kind: "permission", detail: `external_directory["${rootPattern}"] = allow` });
      } else if (typeof ext === "string") {
        next = setPermissionRule(next, "external_directory", "*", ext);
        next = setPermissionRule(next, "external_directory", rootPattern, "allow");
        changes.push({ kind: "permission", detail: `external_directory["${rootPattern}"] = allow (after "*": ${ext})` });
      } else {
        next = setPermissionRule(next, "external_directory", rootPattern, "allow");
        changes.push({ kind: "permission", detail: `external_directory["${rootPattern}"] = allow` });
      }
    }
  }

  // A one-line config has no comments or formatting to preserve, and splicing
  // newlines into it produces unreadable output: pretty-print the result.
  let final = inspectConfig(next);
  if (!text.includes("\n") && next !== text) {
    try { next = JSON.stringify(JSON.parse(next), null, 2) + "\n"; } catch { /* keep spliced text */ }
    final = inspectConfig(next);
  }
  if (final.permission.taskEffect === "deny") {
    warnings.push('`task` is denied: vision routing cannot delegate to a vision subagent (set permission.task to allow if you use it).');
  }

  return { text: next, changed: next !== text, changes, warnings, manual };
}

function indentOfNode(text, pos) {
  const lineStart = text.lastIndexOf("\n", Math.max(0, pos - 1)) + 1;
  return /^[ \t]*/.exec(text.slice(lineStart, pos))[0];
}

function indentOfTopLevel(text, ast) {
  const last = ast.members?.[ast.members.length - 1];
  if (!last) return "";
  const lineStart = text.lastIndexOf("\n", Math.max(0, last.keyStart - 1)) + 1;
  return /^[ \t]*/.exec(text.slice(lineStart, last.keyStart))[0];
}

/** Multi-line `{ package, options }` (v2) or `[spec, {}]` (legacy tuple). */
function pluginItemText(text, spec, arrayKey, baseIndent) {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  if (arrayKey === "plugin") return `[${JSON.stringify(spec)}, {}]`;
  return `{${eol}${baseIndent}  "package": ${JSON.stringify(spec)},${eol}${baseIndent}  "options": {}${eol}${baseIndent}}`;
}

function arrayLiteral(text, item, baseIndent) {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const inner = `${baseIndent}  `;
  return `[${eol}${inner}${item}${eol}${baseIndent}]`;
}

function externalPattern(root, home) {
  const base = String(root ?? path.join(home, ".opencode", "contextpacks"));
  if (base === home) return "~/**";
  if (base.startsWith(home + path.sep)) return `~/${base.slice(home.length + 1)}/**`;
  return `${base}/**`;
}

function setPermissionRule(text, action, pattern, value) {
  return setPath(text, ["permission", action, pattern], value);
}

function appendRule(text, rule) {
  const arr = at(parseJsonc(text), ["permissions"]);
  if (arr?.type !== "array") return setPath(text, ["permissions"], [rule]);
  return appendToContainer(text, arr, JSON.stringify(rule));
}

/** `plugins: [{ package, options: {...} }]` for one option key. */
function entryPathOptions(text, entry, key, value) {
  const ast = parseJsonc(text);
  const arr = at(ast, [entry.arrayKey]);
  const node = arr.items[entry.index];
  if (!member(node, "options")) {
    // add the options object first, then the key inside it
    const eol = text.includes("\r\n") ? "\r\n" : "\n";
    const lineStart = text.lastIndexOf("\n", node.start - 1) + 1;
    const indent = /^[ \t]*/.exec(text.slice(lineStart, node.start))[0];
    const last = node.members[node.members.length - 1];
    let atPos = last.value.end;
    let j = atPos;
    while (j < text.length && /\s/.test(text[j])) j++;
    const hasComma = text[j] === ",";
    if (hasComma) atPos = j + 1;
    const insert = `${hasComma ? "" : ","}${eol}${indent}  "options": {}`;
    const withOptions = text.slice(0, atPos) + insert + text.slice(atPos);
    return setPath(withOptions, ["plugins", entry.index, "options", key], value);
  }
  return setPath(text, ["plugins", entry.index, "options", key], value);
}

/** Turn `plugins: ["spec"]` into `plugins: [{ package: "spec", options: {} }]`. */
function promoteStringPlugin(text, entry, pairs) {
  const ast = parseJsonc(text);
  const node = at(ast, [entry.arrayKey]).items[entry.index];
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lineStart = text.lastIndexOf("\n", node.start - 1) + 1;
  const indent = /^[ \t]*/.exec(text.slice(lineStart, node.start))[0];
  const optionsBody = pairs.map(([k, v]) => `${indent}  ${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(`,${eol}`);
  const encoded = `{${eol}${indent}  "package": ${JSON.stringify(entry.spec)},${eol}${indent}  "options": {${eol}${optionsBody}${eol}${indent}  }${eol}${indent}}`;
  return text.slice(0, node.start) + encoded + text.slice(node.end);
}

// ── applying ───────────────────────────────────────────────────────────────
export function applyConfig({ file, text, now = Date.now(), mode = null }) {
  const backup = `${file}.bak-${Math.floor(now / 1000)}`;
  fs.copyFileSync(file, backup);
  const tmp = `${file}.${process.pid}.tmp`;
  // Keep the file's own permissions (configs are often 0600 or 0644).
  const keep = mode ?? (fs.statSync(file).mode & 0o777);
  fs.writeFileSync(tmp, text, { mode: keep });
  fs.renameSync(tmp, file);
  return { backup, bytes: Buffer.byteLength(text) };
}

// ── probes ─────────────────────────────────────────────────────────────────
const PROBE_TEXT = Array.from({ length: 220 }, (_, i) =>
  `${String(i + 1).padStart(4, " ")}  context budget window cache recall module session ${"payload ".repeat(6)}`).join("\n");

/** Prove the pieces work on this machine: data dir, compression, recall. */
export function probe({ root, now = Date.now() } = {}) {
  const checks = [];
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  checks.push({
    id: "node",
    ok: nodeMajor >= MIN_NODE_MAJOR,
    detail: `node ${process.versions.node}${nodeMajor >= MIN_NODE_MAJOR ? "" : ` (needs >= ${MIN_NODE_MAJOR})`}`,
  });

  let writable = false;
  try {
    fs.mkdirSync(root, { recursive: true });
    const f = path.join(root, `.probe-${process.pid}`);
    fs.writeFileSync(f, "ok");
    writable = fs.readFileSync(f, "utf8") === "ok";
    fs.unlinkSync(f);
  } catch { writable = false; }
  checks.push({ id: "data-dir", ok: writable, detail: writable ? root : `${root} is not writable` });

  let compression = { ok: false, detail: "not run" };
  try {
    const messages = [{
      role: "assistant",
      content: [{ type: "tool", id: "probe", name: "read", state: { status: "completed", input: { path: "probe.txt" }, output: PROBE_TEXT } }],
    }];
    const res = applyStableCompression(messages, { stableMinTokens: 400 }, () => `probe-${process.pid}`);
    const body = messages[0].content[0].state.output;
    compression = {
      ok: res.savedPct >= 50 && body.includes("[ContextPack]") && /recall |retrieve /.test(body),
      detail: `${res.savedPct}% smaller, marker ${body.includes("[ContextPack]") ? "present" : "MISSING"}`,
    };
  } catch (e) {
    compression = { ok: false, detail: `compression failed: ${e?.message ?? e}` };
  }
  checks.push({ id: "compression", ...compression });

  let recall = { ok: false, detail: "not run" };
  try {
    const text = `probe ${now} ${"x".repeat(200)}`;
    const hash = writePage(root, text);
    const back = readPage(root, hash);
    recall = { ok: back === text, detail: back === text ? `recall ${hash}` : "page bytes differ" };
  } catch (e) {
    recall = { ok: false, detail: `recall failed: ${e?.message ?? e}` };
  }
  checks.push({ id: "recall", ...recall });

  const binDir = path.dirname(process.execPath);
  const onPath = String(process.env.PATH ?? "").split(path.delimiter)
    .some((dir) => { try { return fs.existsSync(path.join(dir, "babyzilla")); } catch { return false; } });
  checks.push({
    id: "cli",
    ok: onPath,
    detail: onPath ? "babyzilla is on PATH" : `not on PATH (node is in ${binDir}); install it with npm i -g`,
  });

  return checks;
}
