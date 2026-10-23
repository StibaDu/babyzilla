import test from "node:test";
import assert from "node:assert/strict";
import { anchorModule, ANCHOR_KIND } from "../lib/anchor.mjs";

const text = (t) => [{ type: "text", text: t }];

test("the last question and the answer to it are kept verbatim", () => {
  const messages = [
    { role: "user", content: text("do people actually use the site?") },
    { role: "assistant", content: text("Short answer: barely.\n\nWant me to add crawlable links and deploy?") },
    { role: "user", content: text("yes") },
  ];
  const m = anchorModule(messages);
  assert.ok(m);
  assert.equal(m.kind, ANCHOR_KIND);
  assert.match(m.content, /Want me to add crawlable links and deploy\?/);
  assert.match(m.content, /### The request this pack continues \(verbatim\)\nyes/);
  assert.match(m.content, /do people actually use the site\?/);
});

test("a tool call in the reply is named, never pasted", () => {
  const messages = [
    { role: "user", content: text("check the deploy") },
    {
      role: "assistant",
      content: [
        { type: "text", text: "Checking the live bundle now." },
        { type: "tool", name: "bash", state: { status: "completed", input: { command: "curl -sI https://x.test" }, output: "HTTP/2 200\n".repeat(500) } },
      ],
    },
    { role: "user", content: text("and?") },
  ];
  const m = anchorModule(messages);
  assert.match(m.content, /Checking the live bundle now\./);
  assert.match(m.content, /Tools in that reply\n- bash/);
  assert.doesNotMatch(m.content, /HTTP\/2 200/);
  assert.ok(m.content.length < 1200, `anchor too long: ${m.content.length}`);
});

test("no messages means no anchor, not an empty module", () => {
  assert.equal(anchorModule([]), null);
  assert.equal(anchorModule(undefined), null);
  assert.equal(anchorModule([{ role: "assistant", content: [] }]), null);
});

test("a giant answer is clipped, the question is not", () => {
  const messages = [
    { role: "user", content: text("summarise everything") },
    { role: "assistant", content: text("x ".repeat(20_000) + "\n\nShall I go on?") },
    { role: "user", content: text("yes please, all of it") },
  ];
  const m = anchorModule(messages);
  assert.ok(m.content.length < 3200);
  assert.match(m.content, /Shall I go on\?/);
  assert.match(m.content, /yes please, all of it/);
});
