// ============================================================================
// FROZEN — the tree palette. ALL colors in every asset MUST trace to these
// entries (mechanically enforced by palette.test.ts scanning species sources).
// Ad-hoc hex outside this file is a contract violation.
//
// TIER SYSTEM (STYLE_BIBLE, inherited from the house law):
//   …Lit   sun-hit / crown tops            base +8 L* or more  (enforced)
//   base   main body surface
//   …Dark  shaded masses, under-canopy      a visible step down
//   …Deep  trunk base, knots, crevice      base -8 L* or more  (enforced)
// Approximate L* noted per entry; valueTiers.test.ts verifies ladders via
// L() from @platform/shared. If a test fails, the ART DIRECTION is
// broken, not the test.
// ============================================================================
import { L } from '@platform/shared/color';

export const TREE_PALETTE = {
  // ---- shared: oaks, birches, deadwood — warm bark ladders ----
  barkOakLit: '#8a6a4c', //      L 45  sun-hit bark face
  barkOak: '#6b5238', //       L 36  main bark
  barkOakDark: '#523d2b', //   L 28  shade face
  barkOakDeep: '#3a2b1e', //   L 21  root flare contact band

  // ---- oak — warm heroic greens ----
  leafLit: '#a6c46e', //       L 74  crown / sun-side masses
  leaf: '#7ba24f', //          L 61  main canopy
  leafDark: '#587c3a', //      L 47  under-canopy
  leafDeep: '#3f5c2c', //      L 35  canopy core / contact shadow masses
  autumnLit: '#d9a441', //     L 70  autumn accent, sun-hit
  autumn: '#b97f33', //        L 56  autumn accent, base
  autumnDark: '#8f5c28', //    L 42  autumn accent, shaded

  // ---- birch — airy yellow-greens + paper bark ----
  birchLeafLit: '#c6d788', //  L 80
  birchLeaf: '#a2ba62', //     L 69
  birchLeafDark: '#79974a', // L 55
  birchBark: '#eeeade', //     L 91  chalk-white sun face
  birchBarkMid: '#cbc6b4', //   L 79  warm grey mid tier
  birchBarkCold: '#a3aaa9', //  L 69  cool blue-grey shade face
  birchBand: '#33302a', //     L 19  lenticel bands / …Deep band

  // ---- pine — cold structured greens (shifted ~15° toward blue) ----
  pineLit: '#6ba083', //       L 62
  pineBase: '#4c7c62', //      L 49
  pineDark: '#38614b', //      L 39
  pineDeep: '#274736', //      L 28  skirt core / base band
  barkPine: '#5d4834', //      L 32
  barkPineDark: '#43311f', //  L 22
  snowDust: '#edf1f2', //      L 95  upward-facing snow

  // ---- deadwood — bleached silver (dead trees are grey, not chocolate) ----
  deadwoodLit: '#a89f8d', //   L 65  silver-grey sun face
  deadwoodPale: '#c0b8a6', //  L 75  bleached streak / weathered sun face
  deadwood: '#8d8272', //      L 55  bone mid tier
  deadwoodDark: '#6a6053', //  L 43  shade face
  deadwoodDeep: '#4a4238', //  L 33  crack / contact band
  crack: '#262019', //         L 14  vertical cracks / split core
  knotHole: '#241c13', //      L 12  hollow knot / woodpecker hole
  moss: '#5e7c3d', //          L 47  base moss accent

  // ---- palm — saturated tropical ----
  frondLit: '#82ba5e', //      L 68
  frond: '#5d9c47', //         L 56
  frondDark: '#3f7a34', //     L 44
  frondDeep: '#2c5a28', //     L 33  crown core
  palmTrunkLit: '#b6946b', //     L 63  sun-hit trunk segment under the crown
  palmTrunk: '#9d7c53', //     L 54
  palmTrunkDark: '#77603e', // L 42
  palmRing: '#6b5535', //      L 37  ring contact bands
  coconut: '#5b462e', //       L 31
  coconutDeep: '#3d2f1f', //   L 21
  frondDead: '#8a6b3c', //     L 47  dead brown frond (palm story detail)

  // ---- shared stage (viewer only; species never use these) ----
  stageGround: '#4b5740', //   L 35
  stageGroundDark: '#39432f', //L 26  radial edge break
  stageSkyZenith: '#9fc3dd', //L 79
  stageSkyHorizon: '#e8dcc4', //L 87  warm horizon
  stageSky: '#bfd6e6', //      L 83 (legacy flat sky — kept for compatibility)
} as const;

export type TreePaletteKey = keyof typeof TREE_PALETTE;

/** The keys whose names form a verified value ladder (…Lit / base / …Dark / …Deep). */
export const VALUE_LADDERS: readonly (readonly TreePaletteKey[])[] = [
  ['leafLit', 'leaf', 'leafDark', 'leafDeep'],
  ['autumnLit', 'autumn', 'autumnDark'],
  ['birchBark', 'birchBarkMid', 'birchBarkCold', 'birchBand'],
  ['birchLeafLit', 'birchLeaf', 'birchLeafDark'],
  ['barkOakLit', 'barkOak', 'barkOakDark', 'barkOakDeep'],
  ['pineLit', 'pineBase', 'pineDark', 'pineDeep'],
  ['deadwoodLit', 'deadwood', 'deadwoodDark', 'deadwoodDeep'],
  ['frondLit', 'frond', 'frondDark', 'frondDeep'],
  ['palmTrunkLit', 'palmTrunk', 'palmTrunkDark', 'palmRing'],
];

/** Ladder law: …Lit >= base+8 L*, …Deep <= base-8 L* (verified in valueTiers.test.ts). */
export const LADDER_STEP = 8;

export { L };
