// The OpenPets catalog: finding a pet, remembering the list, never inventing one.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { catalog, pickPets, findPet, isRemoteSource } from "../lib/pet-catalog.mjs";
import { houseVoice, VOICES } from "../lib/pet-voice.mjs";

const PETS = [
  { id: "hoodie-cat", label: "Hoodie Cat", description: "A laid-back cat in a blue hoodie", category: "western", featured: true, original: true, zip: "https://zip/x.zip", v2: true },
  { id: "snoopy", label: "Snoopy", description: "A tiny beagle with a red collar", category: "western", featured: false, original: false, zip: "https://zip/s.zip", v2: false },
  { id: "dartfrog", label: "Dartfrog", description: "A calm pixel art frog", category: "asian", featured: true, original: false, zip: "https://zip/d.zip", v2: false },
];

test("catalog: search, filters and limits are one predicate", () => {
  assert.deepEqual(pickPets(PETS, { search: "cat" }).map((p) => p.id), ["hoodie-cat"]);
  assert.deepEqual(pickPets(PETS, { search: "BEAGLE" }).map((p) => p.id), ["snoopy"]);
  assert.deepEqual(pickPets(PETS, { originals: true }).map((p) => p.id), ["hoodie-cat"]);
  assert.deepEqual(pickPets(PETS, { featured: true }).map((p) => p.id), ["hoodie-cat", "dartfrog"]);
  assert.deepEqual(pickPets(PETS, { featured: true, originals: true }).map((p) => p.id), ["hoodie-cat"]);
  assert.deepEqual(pickPets(PETS, { category: "asian" }).map((p) => p.id), ["dartfrog"]);
  assert.equal(pickPets(PETS, { limit: 2 }).length, 2);
  assert.deepEqual(pickPets(PETS, { search: "nothing here" }), []);
});

test("catalog: a pet is found by id, by display name, or by id prefix", () => {
  assert.equal(findPet(PETS, "snoopy").id, "snoopy");
  assert.equal(findPet(PETS, "SNOOPY").id, "snoopy");
  assert.equal(findPet(PETS, "Hoodie Cat").id, "hoodie-cat");
  // catalog ids carry a content hash (saas-is-dead-205e): typing the name is enough
  assert.equal(findPet([{ id: "saas-is-dead-205e", label: "SaaS Is Dead Official" }], "saas-is-dead").id, "saas-is-dead-205e");
  assert.equal(findPet(PETS, "unicorn"), null);
  assert.equal(findPet(PETS, ""), null);
});

test("catalog: sources are told apart from ids", () => {
  assert.ok(isRemoteSource("https://zip.openpets.dev/pets/x/x.zip"));
  assert.ok(isRemoteSource("/tmp/pet.zip"));
  assert.ok(!isRemoteSource("hoodie-cat"));
});

test("catalog: fetched once, cached for a day, refetchable", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bz-cat-"));
  const previous = process.env.BABYZILLA_PET_STATE;
  process.env.BABYZILLA_PET_STATE = dir;
  let calls = 0;
  const fake = async (url) => {
    calls++;
    if (url.endsWith("catalog.v3.json")) return { version: 3, generatedAt: "now", pages: ["https://openpets.dev/page-1.json"] };
    return { pets: [{ id: "hoodie-cat", displayName: "Hoodie Cat", zip: "https://zip/x.zip", original: true, spriteVersionNumber: 2 }] };
  };
  try {
    const first = await catalog({ fetchImpl: fake });
    assert.equal(first.cached, false);
    assert.equal(first.pets.length, 1);
    assert.equal(first.pets[0].label, "Hoodie Cat");
    assert.equal(first.pets[0].v2, true, "a V2 marker is kept for the installer");
    assert.equal(calls, 2, "index + one page");

    const second = await catalog({ fetchImpl: fake });
    assert.equal(second.cached, true);
    assert.equal(calls, 2, "the cache answered");
    assert.ok(fs.existsSync(path.join(dir, "catalog.v3.json")));

    const forced = await catalog({ fresh: true, fetchImpl: fake });
    assert.equal(forced.cached, false);
    assert.equal(calls, 4, "fresh goes back to the network");
  } finally {
    if (previous === undefined) delete process.env.BABYZILLA_PET_STATE;
    else process.env.BABYZILLA_PET_STATE = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("catalog: an unreadable home does not fail the listing", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bz-cat-"));
  const previous = process.env.BABYZILLA_PET_STATE;
  // a file where a directory should be: the cache cannot be written at all
  fs.writeFileSync(path.join(dir, "blocked"), "");
  process.env.BABYZILLA_PET_STATE = path.join(dir, "blocked", "deep");
  try {
    const got = await catalog({ fetchImpl: async (url) => (url.endsWith("catalog.v3.json")
      ? { pages: ["https://openpets.dev/p.json"] }
      : { pets: [{ id: "a" }] }) });
    assert.equal(got.pets.length, 1);
  } finally {
    if (previous === undefined) delete process.env.BABYZILLA_PET_STATE;
    else process.env.BABYZILLA_PET_STATE = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("catalog: an imported pet gets a house voice, the same one every time", () => {
  for (const id of ["snoopy", "clippit", "tux", "budgie-berry", "fixer"]) {
    const voice = houseVoice(id);
    assert.ok(VOICES[voice], `${id} → ${voice} exists`);
    assert.equal(houseVoice(id), voice, `${id} is stable`);
    assert.notEqual(voice, "caveman", `${id} is not a caveman`);
  }
  // the personalities we actually know are pinned, not hashed
  assert.equal(houseVoice("hoodie-cat"), "deadpan");
  assert.equal(houseVoice("luna-techbot"), "robot");
  // and the house set spreads out instead of collapsing onto one voice
  const used = new Set(Array.from({ length: 200 }, (_, i) => houseVoice(`pet-${i}`)));
  assert.ok(used.size >= 3, `${used.size} registers in use`);
});
