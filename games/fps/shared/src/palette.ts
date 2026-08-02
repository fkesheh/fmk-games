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
  // READABILITY LAW (§1 L6, enforced by valueLadder.test.ts): every team BASE
  // colour must clear BOTH the ground and the L1 reference wall of EVERY map by
  // >= 18 L* OR >= 30 degrees of hue. The old ctBlue/tAmber failed 6 of 12 pairs
  // — a CT sank into the cool tarmac/carpet floors, a T sank into the warm
  // sand/plaster walls — which is a fairness bug, not a taste one.
  //
  // WHY THE HUES MOVED, and why a "true" blue and a "true" amber are BOTH
  // unreachable (this is arithmetic, not preference):
  //   CT — every cool ground/wall in the game sits at hue 210-215
  //        (metalDark 26.6, carpet 28.9, tarmac 34.7, snowShadow 59.3, snow 89.4
  //        in L*). No single L* is >= 18 away from all five (the gaps between
  //        34.7/59.3 and 59.3/89.4 are only 24.6 and 30.1 wide), so L* alone
  //        cannot solve it at ANY lightness. Hue must do the work, which forces
  //        the family off 220 to >= 243. It sits at 250: a deep indigo that
  //        still reads blue, and now clears carpet by 35 deg and tarmac by 37.
  //   T  — the warm surfaces are dust L50.4 and plaster L83.5, only 33.1 L*
  //        apart, and they share a hue (38.3 / 37.5). Clearing both by 18 needs
  //        36 L* of room: 2.9 short. So an amber at hue ~40 is only legal below
  //        L*32 — a dark rust that would then sink into the four DARK cool
  //        floors instead. The family rotates to hue 6 (blaze / vermilion) and
  //        KEEPS its brightness, which is the readable half of the trade.
  // Team-vs-team separation is not weakened by this: dE76 rises 98.9 -> 121.2
  // (117.0 under simulated protanopia, was 97.1) and dL* holds at 24.1 (was 24.9).
  ctPale: '#b9aeeb', //          L 74  helmet shell — the long-range silhouette
  ctLit: '#7e6cd8', //           L 52  shoulders / helmet brim
  ctBlue: '#5239ca', //          L 36  uniform body (BASE — the tested tier)
  ctDark: '#3b2898', //          L 26  limb value break
  tPale: '#ffb4ab', //           L 80  helmet shell
  tLit: '#ff8e81', //            L 71  shoulders / helmet brim
  tAmber: '#ff5542', //          L 60  uniform body (BASE — the tested tier)
  tDark: '#de230e', //           L 48  limb value break
  // `tBrown` is NO LONGER a team tier — it lost that job when the T family
  // rotated to hue 6, because a red-brown would have tinted every sandbag and
  // barrel red. It stays exactly where it was as the WORLD's industrial brown
  // (mapRenderer's sack/barrel bodies) and must not be dragged along by team
  // retunes. The T dark tier is `tDark`.
  tBrown: '#6e5232', //          L 36  world industrial brown (sacks, barrels)
  skin: '#e0ac69', //            L 74

  // ---- signage / hazard dressing ----
  // These two ARE the old `tAmber` / `tLit` hexes, kept byte-for-byte. When the
  // T family rotated to hue 6 the maps' safety-amber stripes had to stop
  // tracking it: a hazard plate painted in the live enemy colour is a
  // false-positive enemy read every time you clear a corner, which is the same
  // fairness bug this pass exists to remove. Hazard dressing is world dressing;
  // it now has its own name and never moves with a team retune.
  hazardAmber: '#c8912f', //     L 62  hazard stripes, dock edges, door plates
  hazardAmberLit: '#e5b055', //  L 75  their lit companion + the shell accent

  // ---- fx ----
  muzzle: '#ffcf6e',
  tracer: '#ffd88a',
  blood: '#a03028',
  // Pushed from #ff7733 (hue 20) to hue 31 by the §1 L6 gate: it is the tracer
  // glow and the explosion core, and at hue 20 it sat 14 deg and 5 L* from the
  // retuned `tLit` — a tracer streak the colour of an enemy's shoulder. Hotter
  // and yellower is also the truer flame; the T family now owns the red end.
  fire: '#ff8e16',

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
