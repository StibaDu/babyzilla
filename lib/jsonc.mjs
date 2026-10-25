// Minimal JSONC editor: parse with spans, splice edits, keep every byte of the
// user's file that we did not mean to change.
//
// The setup wizard must not reformat an OpenCode config. Users keep comments,
// ordering and formatting there; a JSON.parse/JSON.stringify round-trip would
// silently delete all of it (and reorder keys, which matters because permission
// rules are last-match-wins). So this module parses the file with positions and
// edits only the spans it was asked to edit.
//
// Supported: line/block comments, trailing commas, single-line and multi-line
// containers, CRLF files (inserted text follows the file's own line ending).

/** Parse JSONC into a tree carrying byte spans. Throws SyntaxError with an offset. */
export function parseJsonc(text) {
  let i = 0;
  const n = text.length;
  const fail = (msg) => {
    const line = text.slice(0, i).split("\n").length;
    throw new SyntaxError(`${msg} (line ${line}, offset ${i})`);
  };

  const skipTrivia = () => {
    for (;;) {
      const c = text[i];
      if (c === " " || c === "\t" || c === "\n" || c === "\r") { i++; continue; }
      if (c === "/" && text[i + 1] === "/") {
        i += 2;
        while (i < n && text[i] !== "\n") i++;
        continue;
      }
      if (c === "/" && text[i + 1] === "*") {
        const close = text.indexOf("*/", i + 2);
        if (close === -1) fail("unterminated block comment");
        i = close + 2;
        continue;
      }
      return;
    }
  };

  const parseString = () => {
    const start = i;
    i++; // opening quote
    while (i < n) {
      const c = text[i];
      if (c === "\\") { i += 2; continue; }
      if (c === '"') { i++; break; }
      i++;
    }
    const raw = text.slice(start, i);
    try { return JSON.parse(raw); } catch { fail("invalid string literal"); }
  };

  const parseValue = () => {
    skipTrivia();
    const start = i;
    const c = text[i];
    if (c === "{") return parseObject();
    if (c === "[") return parseArray();
    if (c === '"') {
      const value = parseString();
      return { type: "string", start, end: i, value };
    }
    if (c === "-" || (c >= "0" && c <= "9")) {
      const m = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(i));
      if (!m) fail("invalid number");
      i += m[0].length;
      return { type: "number", start, end: i, value: Number(m[0]) };
    }
    for (const lit of ["true", "false", "null"]) {
      if (text.startsWith(lit, i)) {
        i += lit.length;
        return { type: "literal", start, end: i, value: lit === "null" ? null : lit === "true" };
      }
    }
    fail("unexpected token");
  };

  const parseObject = () => {
    const start = i;
    i++; // {
    const members = [];
    for (;;) {
      skipTrivia();
      if (text[i] === "}") { i++; break; }
      if (text[i] !== '"') fail("expected an object key");
      const keyStart = i;
      const key = parseString();
      const keyEnd = i;
      skipTrivia();
      if (text[i] !== ":") fail("expected ':'");
      i++;
      const value = parseValue();
      members.push({ key, keyStart, keyEnd, value });
      skipTrivia();
      if (text[i] === ",") { i++; continue; }
      if (text[i] === "}") { i++; break; }
      fail("expected ',' or '}'");
    }
    return { type: "object", start, end: i, members };
  };

  const parseArray = () => {
    const start = i;
    i++; // [
    const items = [];
    for (;;) {
      skipTrivia();
      if (text[i] === "]") { i++; break; }
      items.push(parseValue());
      skipTrivia();
      if (text[i] === ",") { i++; continue; }
      if (text[i] === "]") { i++; break; }
      fail("expected ',' or ']'");
    }
    return { type: "array", start, end: i, items };
  };

  const root = parseValue();
  skipTrivia();
  if (i < n) fail("trailing content");
  return root;
}

// ── lookup ────────────────────────────────────────────────────────────────
export function member(node, key) {
  if (node?.type !== "object") return null;
  return node.members.find((m) => m.key === key) ?? null;
}

/** Follow a path of object keys (and numeric array indexes). */
export function at(node, path) {
  let cur = node;
  for (const step of path) {
    if (typeof step === "number") {
      if (cur?.type !== "array") return null;
      cur = cur.items[step] ?? null;
    } else {
      cur = member(cur, step)?.value ?? null;
    }
    if (!cur) return null;
  }
  return cur;
}

export function decode(node) {
  if (!node) return undefined;
  switch (node.type) {
    case "object": return Object.fromEntries(node.members.map((m) => [m.key, decode(m.value)]));
    case "array": return node.items.map(decode);
    default: return node.value;
  }
}

// ── edits ─────────────────────────────────────────────────────────────────
export const eolOf = (text) => (text.includes("\r\n") ? "\r\n" : "\n");
export const literal = (value) => JSON.stringify(value);

function indentAt(text, pos) {
  const lineStart = text.lastIndexOf("\n", Math.max(0, pos - 1)) + 1;
  return /^[ \t]*/.exec(text.slice(lineStart, pos))[0];
}

function unitFor(text) {
  // Match the file's own indent step when it is unambiguous.
  const m = /\n([ \t]+)\S/.exec(text);
  return m ? m[1] : "  ";
}

function appendPoint(text, endPos) {
  let i = endPos;
  while (i < text.length && (text[i] === " " || text[i] === "\t")) i++;
  let comma = false;
  if (text[i] === ",") { comma = true; i++; }
  // A same-line `// comment` belongs to the member above it: put the new
  // member on the next line instead of gluing it in front of that comment.
  let j = i;
  while (j < text.length && (text[j] === " " || text[j] === "\t")) j++;
  if (text.startsWith("//", j)) {
    const nl = text.indexOf("\n", j);
    if (nl !== -1) return { at: nl + 1, comma, atNewline: true, endPos };
  }
  return { at: i, comma, atNewline: false, endPos };
}

/**
 * Append a raw value as the last element of an object or array node.
 * Appending matters for permissions: OpenCode evaluates rules last-match-wins,
 * so an allow must come after the broader ask/deny it is an exception to.
 */
export function appendToContainer(text, node, valueText) {
  const isArray = node?.type === "array";
  if (!isArray && node?.type !== "object") throw new TypeError("appendToContainer: not a container");
  const last = isArray ? node.items[node.items.length - 1] : node.members[node.members.length - 1];
  const eol = eolOf(text);
  if (!last) {
    const indent = indentAt(text, node.start);
    const unit = unitFor(text);
    const body = isArray
      ? `[${eol}${indent}${unit}${valueText}${eol}${indent}]`
      : `{${eol}${indent}${unit}${valueText}${eol}${indent}}`;
    return text.slice(0, node.start) + body + text.slice(node.end);
  }
  const indent = indentAt(text, isArray ? last.start : last.keyStart);
  const endPos = isArray ? last.end : last.value.end;
  const { at, comma, atNewline } = appendPoint(text, endPos);
  if (!atNewline) {
    return text.slice(0, at) + (comma ? "" : ",") + eol + indent + valueText + text.slice(at);
  }
  // The line ends in a comment: append on the next line, and put the comma
  // before the comment when the member had none (trailing commas are legal).
  if (comma) return text.slice(0, at) + indent + valueText + eol + text.slice(at);
  return text.slice(0, endPos) + "," + text.slice(endPos, at) + indent + valueText + eol + text.slice(at);
}

/** Insert `"key": value` as the last member of an object node. */
export function insertMember(text, obj, key, valueText) {
  if (obj?.type !== "object") throw new TypeError("insertMember: not an object");
  return appendToContainer(text, obj, `"${key}": ${valueText}`);
}

/** Insert an item as the last element of an array node. */
export function insertItem(text, arr, valueText) {
  if (arr?.type !== "array") throw new TypeError("insertItem: not an array");
  return appendToContainer(text, arr, valueText);
}

/** Replace a value node's bytes (used to turn `"ask"` into an object, etc.). */
export function replaceNode(text, node, valueText) {
  return text.slice(0, node.start) + valueText + text.slice(node.end);
}

/**
 * Set a dotted path to a JSON value, creating objects along the way.
 * Recursive on the exact source slice, so every untouched byte (comments,
 * ordering, formatting) survives.
 */
export function setPath(text, path, value, baseIndent = null, unit = null) {
  if (!path.length) throw new TypeError("setPath: empty path");
  const root = parseJsonc(text);
  const key = path[0];
  // Arrays are addressed by numeric index (existing entries only).
  const found = typeof key === "number"
    ? (root.type === "array" && root.items[key] ? { key, value: root.items[key] } : null)
    : member(root, key);
  const indent = baseIndent ?? (root.members.length
    ? indentAt(text, root.members[root.members.length - 1].keyStart)
    : indentAt(text, root.start));
  const eol = eolOf(text);
  // The indent step must come from the whole document: a nested slice starts
  // at the object brace, so its own "first indented line" is the member indent.
  const step = unit ?? unitFor(text);

  const build = (keys, ind) => {
    if (!keys.length) return literal(value);
    const inner = build(keys.slice(1), ind + step);
    return `{${eol}${ind}${step}${JSON.stringify(keys[0])}: ${inner}${eol}${ind}}`;
  };
  const subtree = () => build(path.slice(1), indent);

  if (path.length === 1) {
    if (found) return replaceNode(text, found.value, literal(value));
    if (typeof key === "number") throw new RangeError(`setPath: no array item ${key}`);
    return insertMember(text, root, key, literal(value));
  }
  if (!found) {
    if (typeof key === "number") throw new RangeError(`setPath: no array item ${key}`);
    return insertMember(text, root, key, subtree());
  }
  if (found.value.type !== "object" && found.value.type !== "array") return replaceNode(text, found.value, subtree());

  const inner = text.slice(found.value.start, found.value.end);
  const next = setPath(inner, path.slice(1), value, indent + step, step);
  return text.slice(0, found.value.start) + next + text.slice(found.value.end);
}
