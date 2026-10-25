// JSONC span editor: comments, ordering and formatting must survive edits.
import test from "node:test";
import assert from "node:assert/strict";

import { parseJsonc, decode, at, setPath, insertMember, insertItem, eolOf } from "../lib/jsonc.mjs";

const DOC = `{
  // the schema stays put
  "$schema": "https://opencode.ai/config.json",
  /* block comment */
  "plugins": [
    { "package": "/tmp/babyzilla", "options": { "stablePrefix": true } },
  ],
  "permission": {
    "bash": {
      "*": "ask", // broad default first
    },
  },
}
`;

test("parseJsonc handles comments, trailing commas and CRLF", () => {
  const doc = '{\r\n  // note\r\n  "a": [1, 2,],\r\n  "b": "http://x//y",\r\n}\r\n';
  const ast = parseJsonc(doc);
  assert.deepEqual(decode(ast), { a: [1, 2], b: "http://x//y" });
  assert.equal(eolOf(doc), "\r\n");
  assert.throws(() => parseJsonc('{ "a": }'), /unexpected token/);
});

test("setPath replaces an existing value without touching comments", () => {
  const out = setPath(DOC, ["plugins", 0, "options", "stablePrefix"], false);
  assert.equal(decode(at(parseJsonc(out), ["plugins", 0, "options", "stablePrefix"])), false);
  assert.equal(at(parseJsonc(out), ["plugins", 0, "options"]).members.length, 1, "no duplicate key");
  assert.ok(out.includes("// the schema stays put"));
  assert.ok(out.includes("/* block comment */"));
  assert.ok(out.includes("// broad default first"));
});

test("setPath appends (last-match-wins) inside an existing object", () => {
  const out = setPath(DOC, ["permission", "bash", "babyzilla recall *"], "allow");
  const bash = decode(at(parseJsonc(out), ["permission", "bash"]));
  assert.deepEqual(bash, { "*": "ask", "babyzilla recall *": "allow" });
  assert.deepEqual(Object.keys(bash), ["*", "babyzilla recall *"], "new rule must come after the broad rule");
  assert.ok(out.includes('"*": "ask", // broad default first'));
});

test("setPath creates multi-line parents with the file's own indent", () => {
  const out = setPath(DOC, ["permission", "external_directory", "~/p/**"], "allow");
  assert.match(out, /"external_directory": \{\n {6}"~\/p\/\*\*": "allow"\n {4}\}/);
  assert.equal(at(parseJsonc(out), ["permission"]).type, "object");
  const again = setPath(out, ["permission", "external_directory", "~/.opencode/**"], "allow");
  const ext = decode(at(parseJsonc(again), ["permission", "external_directory"]));
  assert.deepEqual(ext, { "~/p/**": "allow", "~/.opencode/**": "allow" });
  assert.ok(again.includes("// broad default first"), "sibling comments survive");
});

test("setPath converts a bare string into an object when a rule needs nesting", () => {
  const doc = '{\n  "permission": {\n    "bash": "ask"\n  }\n}';
  const out = setPath(doc, ["permission", "bash", "*"], "ask");
  assert.equal(at(parseJsonc(out), ["permission", "bash"]).type, "object");
  const out2 = setPath(out, ["permission", "bash", "babyzilla *"], "allow");
  assert.deepEqual(decode(at(parseJsonc(out2), ["permission", "bash"])), { "*": "ask", "babyzilla *": "allow" });
});

test("setPath writes a whole subtree when the parent is missing", () => {
  const out = setPath("{\n  \"a\": 1\n}\n", ["permission", "bash", "x *"], "allow");
  assert.equal(out, '{\n  "a": 1,\n  "permission": {\n    "bash": {\n      "x *": "allow"\n    }\n  }\n}\n');
});

test("CRLF files get CRLF insertions", () => {
  const doc = '{\r\n  "a": 1\r\n}\r\n';
  const out = setPath(doc, ["permission", "bash", "x *"], "allow");
  assert.ok(!/[^\r]\n/.test(out.replace(/\r\n/g, "")), "no bare LF introduced");
  assert.deepEqual(decode(at(parseJsonc(out), ["permission", "bash"])), { "x *": "allow" });
});

test("insertMember and insertItem keep the file parseable", () => {
  const doc = '{\n  "list": [1],\n  "obj": { "k": 1 }\n}\n';
  const withItem = insertItem(doc, at(parseJsonc(doc), ["list"]), '{"a":2}');
  assert.deepEqual(decode(at(parseJsonc(withItem), ["list"])), [1, { a: 2 }]);
  const withMember = insertMember(withItem, at(parseJsonc(withItem), ["obj"]), "z", "true");
  assert.deepEqual(decode(at(parseJsonc(withMember), ["obj"])), { k: 1, z: true });
});
