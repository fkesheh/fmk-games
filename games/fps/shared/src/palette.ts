// ============================================================================
// FROZEN CONTRACT — the named palette. ALL colors in the game (map boxes,
// props, characters, weapons, fx, sky/fog themes, HUD) MUST trace to these
// entries. Ad-hoc hex literals outside this file are a contract violation.
//
// TIER SYSTEM (VISUAL_UPGRADE.md §2). Every surface family carries up to four
// value tiers so the VALUE LADDER LAW (§1) is expressible by name:
//   …Lit   trim / cornice / sun-hit detail   base +8 L* or more (enforced)
//   base   main wall / body surface
//   …Dark  secondary surface, shaded planes  a visible step down (guidance)
//   …Deep  CONTACT BAND, plinth, crevice     base -8 L* or more (enforced)
// The `…Deep` tiers are this round's replacement for ambient occlusion: every
// wall base and prop base wears one. Never skip them.
//
// Approximate L* is noted per entry. `valueLadder.test.ts` verifies the ladder
// numerically via `L()` from @platform/shared — if you change a value here and
// the test fails, the ART DIRECTION is broken, not the test.
// ============================================================================

export const PALETTE = {
  // ---- neutrals / industrial ----
  ink: '#14171c', //             L  8
  charcoal: '#23282f', //        L 16
  concreteLit: '#b9b9ac', //     L 74  trim
  concrete: '#8d8d83', //        L 57  main wall
  concreteDark: '#6e6e66', //    L 45
  concreteDeep: '#43443e', //    L 28  contact band
  steelLit: '#c2cad3', //        L 80
  steel: '#9aa3ad', //           L 66
  metalDark: '#3c4249', //       L 26
  metalDeep: '#21252a', //       L 14  contact band
  // outdoor hard ground — the fix for Crossfire/Urbana, whose floors used to
  // be the SAME hex as their walls (Crossfire) or lighter than them (Urbana).
  tarmac: '#4e5257', //          L 34  GROUND
  tarmacDeep: '#303337', //      L 21  contact band

  // ---- desert ----
  sandLit: '#f0e2b4', //         L 90  trim / sun-hit cornice
  sand: '#d6c48a', //            L 80  main wall (lifted from #cbb678)
  sandDark: '#a8945e', //        L 62
  sandDeep: '#6d5c3c', //        L 40  contact band
  dust: '#8a7550', //            L 50  GROUND (dropped + desaturated from #b09a6a)
  dustDeep: '#5e5039', //        L 35  ground shadow patches

  // ---- wood ----
  woodLit: '#a9744a', //         L 55
  wood: '#8b5a2b', //            L 44
  woodDark: '#5d3a1a', //        L 29
  woodDeep: '#3a2410', //        L 18  contact band
  crate: '#a97142', //           L 53
  crateLit: '#c48d5c', //        L 64

  // ---- urban / office ----
  brickLit: '#d29486', //        L 67
  brick: '#b8776a', //           L 57  facade (lifted to clear tarmac by 20)
  brickDeep: '#5a3128', //       L 25  contact band
  plasterLit: '#f0eade', //      L 93
  plaster: '#d8cfc0', //         L 83  main wall
  plasterDeep: '#8d8478', //     L 56  contact band
  roofRed: '#8a4a3a', //         L 39
  roofRedDeep: '#52281e', //     L 21
  carpet: '#3b4553', //          L 29  GROUND (darkened from #4a5568)
  carpetDeep: '#262d38', //      L 18  contact band
  deskTop: '#b08d57', //         L 60
  paper: '#e8e6df', //           L 91
  screenGlow: '#2f6f8f', //      L 43

  // ---- snow ----
  snowLit: '#f6fafd', //         L 98
  snow: '#d8e2ec', //            L 89  main wall (dropped so snowLit clears L3)
  snowShadow: '#7c91a9', //      L 58  GROUND (dropped for Frostbite L1 >= 28)
  snowDeep: '#64758c', //        L 47  contact band
  ice: '#a8c8d8', //             L 78
  rockDark: '#4a4f55', //        L 32
  rockDeep: '#2c3035', //        L 19  contact band

  // ---- foliage ----
  leafLit: '#56a03f', //         L 58
  leaf: '#3e7c2f', //            L 45
  leafDark: '#2d5e23', //        L 34
  leafDeep: '#1b3d15', //        L 22
  cactus: '#4a7a3d', //          L 45
  shrubDead: '#7a6a3f', //       L 44

  // ---- teams (saturated on purpose: enemies MUST pop from the muted world) --
  ctLit: '#5b7cc4', //           L 51
  ctBlue: '#3d5a9b', //          L 39
  ctDark: '#2a3f6e', //          L 27
  tLit: '#e5b055', //            L 75
  tAmber: '#c8912f', //          L 62
  tBrown: '#6e5232', //          L 36
  skin: '#e0ac69', //            L 74

  // ---- fx ----
  muzzle: '#ffcf6e',
  tracer: '#ffd88a',
  blood: '#a03028',
  fire: '#ff7733',

  // ---- skies & fog (map themes only) ----
  // Each sky family is a THREE-stop gradient: …High (zenith) -> base (mid) ->
  // fog/horizon. §1 S1 requires the zenith be COOLER and >= 12 L darker than
  // the horizon. skyDuskHigh's violet against warm sand is Dustbowl's signature.
  skyDay: '#7fa4c9', //          L 64
  skyDayHigh: '#4d78ae', //      L 48
  skyDusk: '#e8a86a', //         L 74
  skyDuskHigh: '#6f6494', //     L 45
  skyCold: '#b8ccd8', //         L 80
  skyColdHigh: '#7fa0bd', //     L 63
  skyIndoor: '#20242a', //       L 14
  skyIndoorHigh: '#12151a', //   L  7
  fogDay: '#a8bccc', //          L 75
  fogDusk: '#d8a878', //         L 71
  fogCold: '#ccd8e0', //         L 85

  // ---- HUD ----
  hudText: '#e8e6df',
  hudAccent: '#c8912f',
  danger: '#c0392b',
  hpGreen: '#7fb069',
} as const;

export type PaletteKey = keyof typeof PALETTE;
