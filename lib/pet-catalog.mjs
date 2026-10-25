// The OpenPets pet catalog: 1300+ pets, fetched once and cached on disk.
//
//   babyzilla pet catalog                     # what is out there
//   babyzilla pet catalog --search cat        # narrow it down
//   babyzilla pet add hoodie-cat               # take one home
//
// A catalog entry is not a pet yet: it points at a zip that holds `pet.json` and
// a 192x208 atlas (8x9 rows, or 8x11 for the V2 look-direction sheets). Turning
// one into a BabyZilla pack is `pet/pet-package.mjs`'s job; this file only knows
// how to find things and where to remember them.

import fs from "node:fs";
import path from "node:path";

import { petDir } from "./pet.mjs";

const INDEX_URL = "https://openpets.dev/pets/catalog.v3.json";
const CACHE_FILE = "catalog.v3.json";
const CACHE_MS = 24 * 60 * 60 * 1000;
const UA = "babyzilla (+https://github.com/StibaDu/babyzilla)";

const isHttps = (value) => /^https:\/\//i.test(String(value));

async function getJson(url) {
  const res = await fetch(url, { headers: { "user-agent": UA } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.json();
}

function normalize(entry) {
  return {
    id: String(entry.id ?? ""),
    label: String(entry.displayName ?? entry.id ?? ""),
    description: String(entry.description ?? ""),
    thumbnail: entry.thumbnail ?? null,
    spritesheet: entry.spritesheet ?? null,
    zip: entry.zip ?? null,
    category: entry.category ?? null,
    subcategory: entry.subcategory ?? null,
    featured: entry.featured === true,
    original: entry.original === true,
    v2: entry.spriteVersionNumber === 2,
  };
}

/**
 * The whole catalog, from cache when it is younger than a day.
 *
 * `fresh` forces a refetch; `fetchImpl` exists so tests never reach the network.
 */
export async function catalog({ fresh = false, now = Date.now(), fetchImpl = null } = {}) {
  const file = path.join(petDir(), CACHE_FILE);
  if (!fresh) {
    try {
      const cached = JSON.parse(fs.readFileSync(file, "utf8"));
      if (Array.isArray(cached.pets) && cached.pets.length && now - Number(cached.fetchedAt) < CACHE_MS) {
        return { pets: cached.pets, fetchedAt: cached.fetchedAt, cached: true };
      }
    } catch { /* no cache yet, or a half-written one */ }
  }

  const get = fetchImpl ?? getJson;
  const index = await get(INDEX_URL);
  const pages = await Promise.all((index.pages ?? []).map((url) => get(url)));
  const pets = pages.flatMap((page) => page.pets ?? []).map(normalize).filter((pet) => pet.id);

  try {
    fs.mkdirSync(petDir(), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ fetchedAt: now, generatedAt: index.generatedAt ?? null, pets }));
  } catch { /* a read-only home is not a reason to fail an install */ }

  return { pets, fetchedAt: now, cached: false };
}

/** Filter what the catalog returned. `search` looks at the name, id and blurb. */
export function pickPets(pets, { search = null, featured = false, originals = false, category = null, limit = 0 } = {}) {
  const needle = String(search ?? "").trim().toLowerCase();
  let found = pets;
  if (originals) found = found.filter((pet) => pet.original);
  if (featured) found = found.filter((pet) => pet.featured);
  if (category) found = found.filter((pet) => String(pet.category).toLowerCase() === String(category).toLowerCase());
  if (needle) {
    found = found.filter((pet) => `${pet.id} ${pet.label} ${pet.description}`.toLowerCase().includes(needle));
  }
  return limit > 0 ? found.slice(0, limit) : found;
}

/** Find one pet by id, or by a catalog URL that carries the id. */
export function findPet(pets, wanted) {
  const key = String(wanted ?? "").trim().toLowerCase();
  if (!key) return null;
  return pets.find((pet) => pet.id.toLowerCase() === key)
    ?? pets.find((pet) => pet.label.toLowerCase() === key)
    ?? pets.find((pet) => pet.id.toLowerCase().startsWith(`${key}-`))
    ?? null;
}

/** True when the argument is something to download rather than an id. */
export function isRemoteSource(value) {
  return isHttps(value) || /^git@/.test(String(value)) || /\.zip$/i.test(String(value));
}
