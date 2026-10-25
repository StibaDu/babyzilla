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

/** Locomotion frames: generated from the master, legs and lean only. */
export const LOCOMOTION = [
  { id: "walk-1", delta: "left leg lifted forward, right leg back, body leaning forward, arms swinging" },
  { id: "walk-2", delta: "both legs together under the body, mid stride, slight bounce up" },
  { id: "walk-3", delta: "right leg lifted forward, left leg back, body leaning forward, arms swinging" },
  { id: "walk-4", delta: "both legs together under the body, mid stride, slight bounce down" },
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
