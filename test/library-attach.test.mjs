// Library rows may replace a session row in the same prompt, but never make
// the prompt larger. These are the pure guards behind the prompt hook.
import test from "node:test";
import assert from "node:assert/strict";
import { planAttach } from "../lib/library.mjs";

const mod = (name, kind, tokens, triggers) => ({ name, kind, tokens, triggers, file: `${name}.md` });
const names = (picked) => picked.map((m) => m.name);
const total = (picked) => picked.reduce((sum, m) => sum + m.tokens, 0);

test("a better library row replaces the weakest session row", () => {
  const session = {
    modules: [
      mod("errors-current", "errors", 50, ["gateway", "econnreset"]),
      mod("topic-current", "topic", 50, ["gateway"]),
    ],
  };
  const library = {
    modules: [mod("errors-old", "errors", 40, ["gateway", "econnreset"])],
  };
  const plan = planAttach({
    session, library, text: "gateway econnreset", maxAttach: 2, budgetTokens: 6000,
  });
  assert.deepEqual(names(plan.oldPicked), ["errors-current", "topic-current"]);
  assert.deepEqual(names(plan.picked).sort(), ["errors-current", "errors-old"].sort());
  assert.ok(total(plan.picked) <= total(plan.oldPicked), "merged pick must not cost more");
});

test("no session match means no library attachment: zero stays zero", () => {
  const session = { modules: [mod("topic-current", "topic", 50, ["unrelated"])] };
  const library = { modules: [mod("errors-old", "errors", 20, ["kestrel"])] };
  const plan = planAttach({
    session, library, text: "kestrel", maxAttach: 2, budgetTokens: 6000,
  });
  assert.deepEqual(names(plan.oldPicked), []);
  assert.deepEqual(names(plan.picked), []);
  assert.equal(plan.libraryScored.length, 1, "the library did match; the token guard refused to grow");
});

test("a promoted copy is deduped by module identity", () => {
  const session = { modules: [mod("errors-gateway", "errors", 50, ["gateway"])] };
  const library = { modules: [mod("errors-gateway", "errors", 40, ["gateway"])] };
  const plan = planAttach({
    session, library, text: "gateway", maxAttach: 2, budgetTokens: 6000,
  });
  assert.equal(plan.picked.length, 1);
  assert.equal(plan.picked[0].name, "errors-gateway");
  assert.ok(!plan.merged.some((item) => item.fromLibrary), "the library copy was not added");
});

test("the existing maxAttach and budget caps still apply", () => {
  const session = {
    modules: [
      mod("a", "topic", 50, ["gateway"]),
      mod("b", "topic", 50, ["gateway"]),
      mod("c", "topic", 50, ["gateway"]),
    ],
  };
  const plan = planAttach({
    session, library: null, text: "gateway", maxAttach: 2, budgetTokens: 60,
  });
  assert.deepEqual(names(plan.picked), ["a"]);
});
