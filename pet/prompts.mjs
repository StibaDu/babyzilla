// Prompt construction. One character description is reused everywhere; each
// expression adds only a face/arm delta so img2img cannot redesign the body.
export const BASE =
  "a cute baby Godzilla kaiju hatchling, chunky pear shaped body, mint green skin, " +
  "cream coloured belly with four horizontal plate ridges, a row of dark teal triangular dorsal plates " +
  "along its back and thick tail, short stubby legs with three toes, two small arms, " +
  "big round white eyes with amber irises and large black pupils, tiny white fangs, soft pink blush cheeks, " +
  "perfectly symmetric design, front view, full body, standing on two feet";

export const STYLE =
  "16-bit pixel art, SNES era game sprite, hard 3 tone cel shading, chunky readable shapes, " +
  "bold 2 pixel black outline, limited 16 colour palette, flat colours, no gradients, no anti-aliasing, " +
  "isolated on a solid pure magenta background";

export const NEGATIVE =
  "photo, realistic, 3d render, painterly, blurry, soft shading, glossy, gradient background, text, watermark, " +
  "multiple characters, cropped, extra limbs, human, clothes, side view, back view";

export const masterPrompt = () =>
  `${BASE}, neutral friendly expression, arms relaxed at its sides, mouth closed in a small smile, ${STYLE}`;

/**
 * Walk frames cannot use BASE: it pins "perfectly symmetric design", which is
 * exactly what stops the model from moving a leg. This variant drops that phrase
 * and is conditioned on the master, so the design stays and only the pose moves.
 */
export const WALK_BASE =
  "a cute baby Godzilla kaiju hatchling, chunky pear shaped body, mint green skin, " +
  "cream coloured belly with four horizontal plate ridges, a row of dark teal triangular dorsal plates " +
  "along its back and thick tail, short stubby legs with three toes, two small arms, " +
  "big round white eyes with amber irises and large black pupils, tiny white fangs, soft pink blush cheeks, " +
  "front view, full body, standing on two feet, walking";

export const walkPrompt = (delta) => `${WALK_BASE}, ${delta}, ${STYLE}`;

/**
 * Walking needs a profile: a front view cannot show a stride, and conditioning
 * on the front master pins the legs. Side frames are generated from the same
 * character description and seed without a reference, which is the only way the
 * legs are free — the cost is that the profile is a second drawing of the
 * creature rather than a rotation of the first.
 */
export const SIDE_BASE =
  "a cute baby Godzilla kaiju hatchling, chunky pear shaped body with a big round belly, mint green skin, " +
  "cream coloured belly with four horizontal plate ridges, a row of dark teal triangular dorsal plates " +
  "along its back and thick tail, short stubby legs with three toes, two small arms, " +
  "big round white eyes with amber irises and large black pupils, tiny white fangs, soft pink blush cheeks, " +
  "side view profile facing right, full body, standing upright on two feet";

export const sidePrompt = (delta) => `${SIDE_BASE}, ${delta}, ${STYLE}`;

/** Locomotion frames: generated from the master, legs and lean only. */
export const LOCOMOTION = [
  // A four-beat march, front view: step, settle, opposite step, settle. Each
  // frame is conditioned on the master so the body cannot drift.
  { id: "walk-1", walk: true, delta: "left knee lifted high toward its belly, right leg planted straight, body tilted a little to the right, arms out for balance" },
  { id: "walk-2", walk: true, delta: "both feet flat on the ground, knees slightly bent, body at its lowest, arms hanging down" },
  { id: "walk-3", walk: true, delta: "right knee lifted high toward its belly, left leg planted straight, body tilted a little to the left, arms out for balance" },
  { id: "walk-4", walk: true, delta: "both feet flat on the ground, standing tall, arms slightly away from the body" },
  // profile walk cycle: contact, passing, opposite contact, passing
  { id: "side-1", side: true, delta: "near leg stepping forward, foot flat on the ground, far leg extended back with the heel lifted, arms swinging, tail out behind for balance" },
  { id: "side-2", side: true, delta: "legs passing under the body, feet close together, body at its lowest point, slight crouch, arms hanging" },
  { id: "side-3", side: true, delta: "far leg stepping forward, foot flat on the ground, near leg extended back with the heel lifted, arms swinging the other way, tail swinging forward" },
  { id: "side-4", side: true, delta: "legs passing under the body, body lifted high on the supporting leg, tail level, arms at its sides" },
  { id: "run-1", delta: "running fast, both legs stretched wide, body leaning far forward, arms back" },
  { id: "run-2", delta: "running fast, legs tucked under body mid air, tail straight back" },
  { id: "run-3", delta: "running fast, opposite leg stretch, body low, arms pumping" },
  { id: "hop-1", delta: "crouched low, knees bent, arms back, about to jump" },
  { id: "hop-2", delta: "in the air, legs tucked, arms up, tail up, joyful face" },
  { id: "sit", delta: "sitting on its bottom, legs forward, tail curled around, relaxed smile" },
];

export const expressionPrompt = (delta) => `${BASE}, ${delta}, ${STYLE}`;
export const locomotionPrompt = (delta) => `${BASE}, ${delta}, neutral focused face, ${STYLE}`;

/** Per-image seeds, so a sprite can be reproduced exactly. */
export function seedFor(id) {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return 1000 + (h >>> 0) % 900000;
}
