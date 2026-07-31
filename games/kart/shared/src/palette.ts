// ============================================================================
// FROZEN CONTRACT — KART GP: the named palette. ALL colors trace here.
//
// TIER SYSTEM (VISUAL_UPGRADE.md §2): …Lit / base / …Dark / …Deep.
// The `…Deep` tiers are CONTACT BANDS — the road shoulder where asphalt meets
// grass, the band under every prop, the base of every barrier. They are this
// round's replacement for ambient occlusion. Never skip them.
//
// The `grass*` tiers exist for ONE reason: the world is currently a single
// flat uniform green, which is KART's worst visual problem. No large surface
// may be one uncut colour — patch, stripe and wear it with these tiers.
// ============================================================================

export const KPAL = {
  // ---- road ----
  asphaltLit: '#5b626b', //      L 41  patches / repairs
  asphaltLight: '#4a5058', //    L 33  crown / lane variation
  asphalt: '#3a3f45', //         L 26  main road
  asphaltDeep: '#24282c', //     L 16  shoulder contact band
  curbRed: '#c0392b',
  curbWhite: '#e8e6df',
  startLine: '#e8e6df',
  lineWhite: '#d8d6cf', //       L 85  lane markings, slightly off-white

  // ---- terrain ----
  grassLit: '#6a9c52', //        L 59  mown stripe / sun-hit
  grass: '#4a7a3d', //           L 46  main verge
  grassDark: '#3d6a31', //       L 40  mown stripe alternate
  grassDeep: '#2a4a22', //       L 28  contact band / under-canopy
  dirt: '#7a5a39', //            L 42  wear at track edge
  dirtDeep: '#4a3722', //        L 25
  rock: '#6e6e66', //            L 45
  rockDeep: '#3f3f39', //        L 26
  // distance tiers for ridgelines — far tier desaturates toward fog, which is
  // free atmospheric perspective (VISUAL_UPGRADE.md §4).
  ridgeNear: '#4f7444', //       L 45
  ridgeFar: '#7d97a3', //        L 60

  // ---- sky ----
  // 3-stop: skyHigh (zenith) -> sky (mid) -> horizon. §1 S1: zenith is cooler
  // AND >= 12 L darker than the horizon. Fog matches the HORIZON, never zenith.
  skyHigh: '#4d78ae', //         L 48
  sky: '#7fa4c9', //             L 64
  horizon: '#c8d8e8', //         L 85
  fog: '#c8d8e8', //             L 86  MUST equal horizon (S2) //             L 75
  cloud: '#eef4f9', //           L 95
  cloudShade: '#b8c6d4', //      L 78

  // ---- vegetation ----
  treeTrunk: '#5d3a1a',
  treeTrunkDeep: '#38230f',
  treeLeafLight: '#3e7c2f', //   L 45  canopy top tier
  treeLeaf: '#2d5e23', //        L 34  canopy body
  treeLeafDeep: '#1b3d15', //    L 22  canopy underside

  // ---- trackside furniture ----
  barrierWhite: '#e8e6df',
  barrierRed: '#a03028',
  ink: '#14171c',
  charcoal: '#23282f',
  gold: '#d4af37',
  steel: '#9aa3ad',
  steelDeep: '#5a616a',
  tire: '#1d2126',
  concrete: '#8d8d83',
  concreteDeep: '#43443e',

  // ---- HUD ----
  hudText: '#e8e6df',
  danger: '#c0392b',

  // ---- player karts (index = KartPlayerInfo.color) ----
  // IDENTITY LAW (valueLadder.test.ts "KART kart identity"): every PAIR of kart
  // colours must differ by >= 20 deg of hue OR >= 18 L*. At MAX_PLAYERS 20 a
  // duplicate or near-duplicate livery destroys the only way to tell rivals
  // apart on track and on the minimap, so this is a gate, not a preference.
  // Comments carry the measured H (hue deg) / L (CIE L*) of each entry.
  //
  // The ORIGINAL EIGHT (indices 0-7) are unchanged: they are consumed outside
  // the kart roster (cones, nitro flame, signal lenses, flowers, crowd blocks)
  // and an 8-player race must look exactly as it did.
  kartRed: '#c0392b', //         H   6  L 45
  kartBlue: '#3d5a9b', //        H 222  L 39
  kartGreen: '#4a7a3d', //       H 107  L 47
  kartYellow: '#c8912f', //      H  38  L 64
  kartPurple: '#7a4a9b', //      H 276  L 40
  kartOrange: '#c86a2f', //      H  23  L 55
  kartTeal: '#2f8f8f', //        H 180  L 54
  kartPink: '#c86a9b', //        H 329  L 57
  // ---- the twelve added for the 20-kart grid ----
  // Placed to fill the hue gaps the original eight left, and where a gap was
  // too narrow for a 20 deg step, split by LIGHTNESS instead (mint/forest at
  // H 142, lime/olive at H 75-78, salmon over maroon, sky over blue). Every
  // one clears the law against all 19 others; the tightest is teal/cyan at
  // dH 22.4 AND dL 18.7 (passes on both axes).
  kartMaroon: '#87324e', //      H 340  L 34
  kartSalmon: '#ea989a', //      H 359  L 71
  kartRust: '#68431e', //        H  30  L 32
  kartLime: '#93b138', //        H  75  L 68
  kartOlive: '#536529', //       H  78  L 40
  kartMint: '#5ac581', //        H 142  L 72
  kartForest: '#16512c', //      H 142  L 30
  kartCyan: '#86bad9', //        H 202  L 73
  kartSky: '#8094d5', //         H 226  L 62
  kartIndigo: '#5343a3', //      H 250  L 35
  kartLilac: '#c39ddb', //       H 277  L 70
  kartMagenta: '#ad3aa1', //     H 306  L 45
} as const;

/**
 * Kart liveries, one per grid slot: `KART_COLORS.length` MUST equal
 * config.MAX_PLAYERS (asserted in valueLadder.test.ts) — the server assigns
 * `color: slot % KART_COLORS.length`, so a short list silently hands two karts
 * the same livery.
 *
 * ORDER IS LOAD-BEARING TWICE OVER: indices 0-7 are frozen so an 8-player race
 * is pixel-identical to before, and 8-19 alternate light/dark and jump hue
 * family each step, because gridSlot() seats slots 2k and 2k+1 side by side on
 * the same row — neighbours on the grid must never be near neighbours in hue.
 */
export const KART_COLORS: string[] = [
  KPAL.kartRed,
  KPAL.kartBlue,
  KPAL.kartGreen,
  KPAL.kartYellow,
  KPAL.kartPurple,
  KPAL.kartOrange,
  KPAL.kartTeal,
  KPAL.kartPink,
  KPAL.kartMint,
  KPAL.kartMaroon,
  KPAL.kartCyan,
  KPAL.kartRust,
  KPAL.kartLilac,
  KPAL.kartForest,
  KPAL.kartSalmon,
  KPAL.kartIndigo,
  KPAL.kartLime,
  KPAL.kartMagenta,
  KPAL.kartSky,
  KPAL.kartOlive,
];

/**
 * Grandstand crowd colours. The stands are currently EMPTY, which reads as a
 * dead world (VISUAL_UPGRADE.md §4). Spectator blocks cycle through these so a
 * packed stand reads as a crowd of individuals, not one coloured slab.
 */
export const CROWD_COLORS: string[] = [
  KPAL.kartRed,
  KPAL.kartBlue,
  KPAL.kartYellow,
  KPAL.kartTeal,
  KPAL.kartPurple,
  KPAL.kartOrange,
  KPAL.curbWhite,
  KPAL.charcoal,
];
