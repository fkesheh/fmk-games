// ============================================================================
// KART GP — the PER-CIRCUIT scenery palettes.
//
// KPAL (../palette.ts) is the shared look; this file is its per-circuit
// extension, consumed through the ONE seam the contract provides:
// `TrackTheme.palette`, a Partial<KPAL> that the renderer resolves as
// { ...KPAL, ...theme.palette } (games/kart/client/src/trackMesh.ts). Without
// it eight circuits would be eight identical afternoons in the same field.
//
// EVERY COLOUR IN A CIRCUIT IS NAMED HERE. Track files reference these objects;
// they never write a hex of their own — the same rule KPAL enforces for the
// shared look (VISUAL_UPGRADE.md §0: no ad-hoc hex literals at a usage site).
//
// THE LADDER LAW STILL APPLIES, per circuit, and is not a matter of taste:
// tracks.test.ts runs the §2 tier ordering, the §1 S2 fog rule and the
// atmospheric-perspective rule over the RESOLVED palette of every registered
// circuit, exactly as valueLadder.test.ts does over KPAL. A re-skin that
// flattens a ladder fails the suite. Measured CIE L* is in the comments.
// ============================================================================
import type { TrackTheme } from '../track.js';

/**
 * A circuit's scenery re-skin. Every KPAL key is optional (leave one out and the
 * shared value stands), EXCEPT the three sky stops: a circuit that re-skins the
 * ground but keeps Greenvale's sky reads as a paint error, so sky/horizon/fog
 * are required here and the TrackSource below reads its theme straight off this
 * object — one table per circuit, no second place for a sky colour to live.
 */
export type CircuitPalette = NonNullable<TrackTheme['palette']> & {
  readonly sky: string;
  readonly horizon: string;
  readonly fog: string;
};

/** Cobalt Coast — a high maritime sun, almost no haze — the far ridge stays legible. */
export const COBALT_PALETTE: CircuitPalette = {
  // terrain — the verge tier ladder (grassLit > grass > grassDark > grassDeep)
  grassLit: '#9db86a', //          L 71
  grass: '#7d9a52', //             L 60
  grassDark: '#6a8544', //         L 52
  grassDeep: '#475c2c', //         L 36
  // shoulders, rock and the wear tiers
  dirt: '#c2a874', //              L 70
  dirtDeep: '#8a7448', //          L 50
  rock: '#b9b3a4', //              L 73
  rockDeep: '#6e6a5e', //          L 45
  // distance ladder — ridgeFar is LIGHTER and LESS SATURATED than ridgeNear
  ridgeNear: '#5f8f56', //         L 55  sat 25
  ridgeFar: '#b3c2cc', //          L 78  sat 20
  // vegetation
  treeTrunk: '#7a6242', //         L 43
  treeTrunkDeep: '#4a3a26', //     L 26
  treeLeafLight: '#6f9a4a', //     L 59
  treeLeaf: '#4d7a34', //          L 47
  treeLeafDeep: '#2c4a1f', //      L 28
  // sky — fog MUST equal horizon (VISUAL_UPGRADE.md §1 S2)
  sky: '#86b8e0', //               L 73
  horizon: '#dcecf6', //           L 93
  fog: '#dcecf6', //               L 93
};

/** Lantern Row — a low amber evening sun raking across the park, long shadows. */
export const LANTERN_PALETTE: CircuitPalette = {
  // terrain — the verge tier ladder (grassLit > grass > grassDark > grassDeep)
  grassLit: '#63924e', //          L 56
  grass: '#457238', //             L 44
  grassDark: '#38602e', //         L 37
  grassDeep: '#22401e', //         L 24
  // shoulders, rock and the wear tiers
  dirt: '#6b4f31', //              L 36
  dirtDeep: '#3e2c1a', //          L 20
  rock: '#6b665c', //              L 43
  rockDeep: '#3b3833', //          L 24
  // distance ladder — ridgeFar is LIGHTER and LESS SATURATED than ridgeNear
  ridgeNear: '#3d5b4a', //         L 36  sat 20
  ridgeFar: '#8a8fa8', //          L 60  sat 15
  // vegetation
  treeTrunk: '#4e3a20', //         L 26
  treeTrunkDeep: '#2c2011', //     L 13
  treeLeafLight: '#4d7c34', //     L 47
  treeLeaf: '#345c26', //          L 35
  treeLeafDeep: '#1c3a16', //      L 21
  // road
  asphaltLit: '#6a6259', //        L 42
  asphaltLight: '#55504a', //      L 34
  asphalt: '#423e3a', //           L 26
  asphaltDeep: '#282523', //       L 15
  // sky — fog MUST equal horizon (VISUAL_UPGRADE.md §1 S2)
  sky: '#c98f63', //               L 64
  horizon: '#f0cfa8', //           L 85
  fog: '#f0cfa8', //               L 85
};

/** Thunder Mile — hard overhead desert sun through a dust haze. */
export const THUNDER_PALETTE: CircuitPalette = {
  // terrain — the verge tier ladder (grassLit > grass > grassDark > grassDeep)
  grassLit: '#b8a95e', //          L 69
  grass: '#97884a', //             L 57
  grassDark: '#7f723c', //         L 48
  grassDeep: '#574d26', //         L 33
  // shoulders, rock and the wear tiers
  dirt: '#b08a52', //              L 60
  dirtDeep: '#6b5029', //          L 36
  rock: '#a89a80', //              L 64
  rockDeep: '#5f5647', //          L 37
  // distance ladder — ridgeFar is LIGHTER and LESS SATURATED than ridgeNear
  ridgeNear: '#8a7b52', //         L 52  sat 25
  ridgeFar: '#c0b9ac', //          L 75  sat 14
  // vegetation
  treeTrunk: '#6b5334', //         L 37
  treeTrunkDeep: '#3f3020', //     L 21
  treeLeafLight: '#7d8a48', //     L 55
  treeLeaf: '#5a6534', //          L 41
  treeLeafDeep: '#36401f', //      L 25
  // road
  asphaltLit: '#6d6f6c', //        L 47
  asphaltLight: '#565855', //      L 37
  asphalt: '#434542', //           L 29
  asphaltDeep: '#292b28', //       L 17
  // sky — fog MUST equal horizon (VISUAL_UPGRADE.md §1 S2)
  sky: '#a8c2d8', //               L 77
  horizon: '#ecdcc0', //           L 88
  fog: '#ecdcc0', //               L 88
};

/** Copper Sprint — a low afternoon sun over red clay, warm bounce off the dirt. */
export const COPPER_PALETTE: CircuitPalette = {
  // terrain — the verge tier ladder (grassLit > grass > grassDark > grassDeep)
  grassLit: '#8fa254', //          L 64
  grass: '#6d8140', //             L 51
  grassDark: '#5a6c34', //         L 43
  grassDeep: '#3a4620', //         L 28
  // shoulders, rock and the wear tiers
  dirt: '#a85b34', //              L 47
  dirtDeep: '#5f2f18', //          L 25
  rock: '#9c6a4e', //              L 49
  rockDeep: '#55362a', //          L 26
  // distance ladder — ridgeFar is LIGHTER and LESS SATURATED than ridgeNear
  ridgeNear: '#7a5a44', //         L 41  sat 28
  ridgeFar: '#b8a29a', //          L 68  sat 17
  // vegetation
  treeTrunk: '#5f4326', //         L 31
  treeTrunkDeep: '#382614', //     L 17
  treeLeafLight: '#5f8a3a', //     L 53
  treeLeaf: '#436828', //          L 40
  treeLeafDeep: '#264016', //      L 24
  // road
  asphaltLit: '#6a625b', //        L 42
  asphaltLight: '#57504a', //      L 35
  asphalt: '#443e3a', //           L 27
  asphaltDeep: '#2a2624', //       L 16
  // sky — fog MUST equal horizon (VISUAL_UPGRADE.md §1 S2)
  sky: '#d59a6a', //               L 68
  horizon: '#f6ddc2', //           L 89
  fog: '#f6ddc2', //               L 89
};

/** Highland Long — thin cool northern light, high and diffuse. */
export const HIGHLAND_PALETTE: CircuitPalette = {
  // terrain — the verge tier ladder (grassLit > grass > grassDark > grassDeep)
  grassLit: '#7fa38c', //          L 64
  grass: '#5c806c', //             L 50
  grassDark: '#4b6b5a', //         L 42
  grassDeep: '#2e4739', //         L 28
  // shoulders, rock and the wear tiers
  dirt: '#7b6f5c', //              L 47
  dirtDeep: '#453d31', //          L 26
  rock: '#8b8f92', //              L 59
  rockDeep: '#4e5255', //          L 35
  // distance ladder — ridgeFar is LIGHTER and LESS SATURATED than ridgeNear
  ridgeNear: '#3d6478', //         L 40  sat 33
  ridgeFar: '#a6b2ba', //          L 72  sat 13
  // vegetation
  treeTrunk: '#4d4436', //         L 29
  treeTrunkDeep: '#2c261d', //     L 16
  treeLeafLight: '#4e8871', //     L 52
  treeLeaf: '#356453', //          L 39
  treeLeafDeep: '#1d3b31', //      L 22
  // sky — fog MUST equal horizon (VISUAL_UPGRADE.md §1 S2)
  sky: '#7d9bb8', //               L 63
  horizon: '#c3d2dc', //           L 83
  fog: '#c3d2dc', //               L 83
};

/** Crown Double — golden hour through an autumn wood. */
export const CROWN_PALETTE: CircuitPalette = {
  // terrain — the verge tier ladder (grassLit > grass > grassDark > grassDeep)
  grassLit: '#a8a44e', //          L 66
  grass: '#85813c', //             L 53
  grassDark: '#6e6b31', //         L 44
  grassDeep: '#46441d', //         L 28
  // shoulders, rock and the wear tiers
  dirt: '#8a6134', //              L 45
  dirtDeep: '#4e361c', //          L 25
  rock: '#8f8778', //              L 57
  rockDeep: '#514c42', //          L 33
  // distance ladder — ridgeFar is LIGHTER and LESS SATURATED than ridgeNear
  ridgeNear: '#7a6a48', //         L 46  sat 26
  ridgeFar: '#b6b0a4', //          L 72  sat 11
  // vegetation
  treeTrunk: '#5a4028', //         L 29
  treeTrunkDeep: '#332415', //     L 16
  treeLeafLight: '#d59a3a', //     L 68
  treeLeaf: '#a86a26', //          L 50
  treeLeafDeep: '#6b3f16', //      L 31
  // sky — fog MUST equal horizon (VISUAL_UPGRADE.md §1 S2)
  sky: '#9fc0d8', //               L 76
  horizon: '#f0e2c8', //           L 90
  fog: '#f0e2c8', //               L 90
};

/** Switchback Ridge — flat overcast light off wet slate. */
export const SWITCHBACK_PALETTE: CircuitPalette = {
  // terrain — the verge tier ladder (grassLit > grass > grassDark > grassDeep)
  grassLit: '#6a8258', //          L 52
  grass: '#4c6440', //             L 40
  grassDark: '#3e5435', //         L 33
  grassDeep: '#263420', //         L 20
  // shoulders, rock and the wear tiers
  dirt: '#6e6350', //              L 42
  dirtDeep: '#3f382c', //          L 24
  rock: '#7e8286', //              L 54
  rockDeep: '#464a4e', //          L 31
  // distance ladder — ridgeFar is LIGHTER and LESS SATURATED than ridgeNear
  ridgeNear: '#46565c', //         L 35  sat 14
  ridgeFar: '#97a6ae', //          L 67  sat 12
  // vegetation
  treeTrunk: '#463a2a', //         L 25
  treeTrunkDeep: '#281f16', //     L 13
  treeLeafLight: '#3f6e42', //     L 42
  treeLeaf: '#2b5030', //          L 31
  treeLeafDeep: '#17301c', //      L 17
  // road
  asphaltLit: '#565d63', //        L 39
  asphaltLight: '#454b50', //      L 32
  asphalt: '#353a3e', //           L 24
  asphaltDeep: '#202326', //       L 14
  // sky — fog MUST equal horizon (VISUAL_UPGRADE.md §1 S2)
  sky: '#8b939a', //               L 61
  horizon: '#c6c9c9', //           L 81
  fog: '#c6c9c9', //               L 81
};

/**
 * Key light colour per circuit (TrackTheme.sunColor). Light, not surface — no
 * tier ladder applies, but it is named here for the same reason every surface
 * colour is: so a circuit's look is one readable table, not scattered hexes.
 */
export const CIRCUIT_SUN = {
  cobalt: '#fdfbf2', // a high maritime sun, almost no haze — the far ridge stays legible
  lantern: '#ffcf92', // a low amber evening sun raking across the park, long shadows
  thunder: '#fff2cf', // hard overhead desert sun through a dust haze
  copper: '#ffd0a0', // a low afternoon sun over red clay, warm bounce off the dirt
  highland: '#eaf1f8', // thin cool northern light, high and diffuse
  crown: '#ffdda0', // golden hour through an autumn wood
  switchback: '#e6ecf2', // flat overcast light off wet slate
} as const;
