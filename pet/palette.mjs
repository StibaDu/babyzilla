// The locked 16-colour palette. Every sprite is quantised to exactly these, so
// 100 separately generated images still read as one coherent sprite sheet.
export const PALETTE = [
  { name: "ink", hex: "#14121f" },        // outline, pupils
  { name: "shadow", hex: "#2b2340" },     // deep shade / hard shadow
  { name: "body-dk", hex: "#2f6b4f" },    // back, under-belly shade
  { name: "body-md", hex: "#3f9668" },    // main shadow side
  { name: "body", hex: "#5cc487" },       // main body
  { name: "body-lt", hex: "#8fe3a8" },    // lit side
  { name: "body-hi", hex: "#c6f2c0" },    // highlight
  { name: "belly", hex: "#f5ecd2" },      // belly plates
  { name: "belly-sh", hex: "#dcc79f" },   // belly plate shade
  { name: "dorsal-dk", hex: "#1d5f6e" },  // dorsal plates
  { name: "dorsal-lt", hex: "#2e93a6" },  // dorsal plate light
  { name: "white", hex: "#ffffff" },      // eye white, specular, fangs
  { name: "amber", hex: "#f2b03c" },      // iris, gold trims
  { name: "blush", hex: "#e79a9a" },      // cheeks
  { name: "mouth", hex: "#c2556a" },      // mouth, tongue
  { name: "gold", hex: "#ffd479" },       // sparkles, props
].map((c, i) => ({ ...c, i, rgb: hexToRgb(c.hex) }));

export function hexToRgb(hex) {
  const h = hex.replace("#", "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

export const INK = PALETTE[0].rgb;

/** Nearest palette entry, weighted to keep outlines from drifting into green. */
export function nearest(r, g, b) {
  let best = 0;
  let bestD = Infinity;
  for (const p of PALETTE) {
    const dr = r - p.rgb[0];
    const dg = g - p.rgb[1];
    const db = b - p.rgb[2];
    // Rec.601 luma weights: hue errors matter less than brightness errors here.
    const d = 0.3 * dr * dr + 0.59 * dg * dg + 0.11 * db * db;
    if (d < bestD) { bestD = d; best = p.i; }
  }
  return { index: best, color: PALETTE[best] };
}

export const PALETTE_HEX = PALETTE.map((p) => p.hex);
