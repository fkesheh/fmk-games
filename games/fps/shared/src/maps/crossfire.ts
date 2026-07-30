// CROSSFIRE — industrial yard (task M1). Same playability invariants as dustbowl:
//   - enclosed by outer walls (h>=4) with no gaps
//   - 3 attack lanes from T spawn (south) to CT spawn (north): west dock lane,
//     mid gantry plaza, east container yard (+ a 1.5m alley west of the warehouse)
//   - no spawn has a direct unobstructed sightline to an enemy spawn:
//     every T(x1,17.5) -> CT(x2,-17.5) line crosses the z=14 slab at
//     x = 0.9*x1 + 0.1*x2 in [-9,9] ⊆ slab x[-11,11] (h=3 > eye 1.62)
//   - every lane has cover at least every 8m; longest open sightline <= 42m
//     (horizontal lines are cut by slabs/dividers/containers so no open run
//     exceeds ~28m; verticals are bounded by the 39m inner depth; corner
//     diagonals all intersect a container, the gantry, or the warehouse)
//   - >= 6 spawns per team, all on y=0 ground, none inside boxes
// Landmarks: warehouse block + 0.8 loading dock with a 0.4 step (west, CT half),
// mid crane gantry (legs + bridge + trolley) parked over a ground container,
// double-stacked containers in the east yard, pipe runs and pallet piles.
import { PALETTE } from '../palette.js';
import type { MapDef } from './types.js';

const W = 56;
const D = 40;

export const crossfire: MapDef = {
  id: 'crossfire',
  name: 'Crossfire',
  sizeX: W,
  sizeZ: D,
  floorMat: 'concrete',
  theme: {
    skyHigh: PALETTE.skyDayHigh, // S1: zenith — retune with the rest of the theme
    sky: PALETTE.skyDay,
    horizon: PALETTE.fogDay,
    ground: PALETTE.concrete,
    fog: PALETTE.fogDay,
    fogDensity: 0.007,
    sunDir: [0.55, -0.62, 0.5],
    sunColor: PALETTE.paper,
    sunIntensity: 1.6,
    hemiIntensity: 1.35,
  },
  boxes: [
    // ---- outer walls ----
    { x: 0, y: 2.5, z: -D / 2, w: W + 2, h: 5, d: 1, mat: 'concrete' },
    { x: 0, y: 2.5, z: D / 2, w: W + 2, h: 5, d: 1, mat: 'concrete' },
    { x: -W / 2, y: 2.5, z: 0, w: 1, h: 5, d: D + 2, mat: 'concrete' },
    { x: W / 2, y: 2.5, z: 0, w: 1, h: 5, d: D + 2, mat: 'concrete' },

    // ---- spawn sightline slabs (x[-11,11], z +/-[13,15]) ----
    { x: 0, y: 1.5, z: 14, w: 22, h: 3, d: 2, mat: 'concrete' },
    { x: 0, y: 1.5, z: -14, w: 22, h: 3, d: 2, mat: 'concrete' },

    // ---- spawn yard dividers (cut the long z~+/-17.5 horizontal) ----
    { x: 14, y: 1, z: 17, w: 1.5, h: 2, d: 5, mat: 'concrete' },
    { x: -14, y: 1, z: 17, w: 1.5, h: 2, d: 5, mat: 'concrete' },
    { x: 14, y: 1, z: -17, w: 1.5, h: 2, d: 5, mat: 'concrete' },
    { x: -14, y: 1, z: -17, w: 1.5, h: 2, d: 5, mat: 'concrete' },

    // ---- warehouse block (x[-26,-15], z[-13,-5]) + loading dock ----
    { x: -20.5, y: 3, z: -9, w: 11, h: 6, d: 8, mat: 'concrete' },
    // dock platform top y=0.8 against the south face; single 0.4 step up
    { x: -20.5, y: 0.4, z: -4, w: 11, h: 0.8, d: 2, mat: 'concreteDark' },
    { x: -20.5, y: 0.2, z: -2.5, w: 6, h: 0.4, d: 1, mat: 'concreteDark' },

    // ---- mid lane container dividers (rotation gap z(-0.5,2) = 2.5m) ----
    { x: -7.5, y: 1.3, z: -4, w: 2.4, h: 2.6, d: 7, mat: 'metal' },
    { x: -7.5, y: 1.3, z: 5, w: 2.4, h: 2.6, d: 6, mat: 'metal' },
    { x: 7.5, y: 1.3, z: -4, w: 2.4, h: 2.6, d: 7, mat: 'metal' },
    { x: 7.5, y: 1.3, z: 5, w: 2.4, h: 2.6, d: 6, mat: 'metal' },

    // ---- mid crane gantry: legs + bridge (underside 3.2) + trolley ----
    { x: -3.5, y: 1.6, z: 0, w: 1, h: 3.2, d: 1, mat: 'metalDark' },
    { x: 3.5, y: 1.6, z: 0, w: 1, h: 3.2, d: 1, mat: 'metalDark' },
    { x: 0, y: 3.4, z: 0, w: 11, h: 0.4, d: 1.4, mat: 'metalDark' },
    { x: 0, y: 2.95, z: 0, w: 1.4, h: 0.5, d: 1.4, mat: 'metalDark' },
    // container parked under the crane (mid cover, splits the plaza 2 ways)
    { x: 0, y: 1.3, z: 1.5, w: 2.4, h: 2.6, d: 6, mat: 'metal' },

    // ---- mid approach containers (plug the z +/-[7,13] bands) ----
    { x: 2, y: 1.3, z: 10, w: 2.4, h: 2.6, d: 6, mat: 'metal' },
    { x: -2, y: 1.3, z: -10, w: 2.4, h: 2.6, d: 6, mat: 'metal' },

    // ---- east container yard (stack A is double, top y=5.2) ----
    { x: 20, y: 1.3, z: -8, w: 6, h: 2.6, d: 2.4, mat: 'metal' },
    { x: 20, y: 3.9, z: -8, w: 6, h: 2.6, d: 2.4, mat: 'metal' },
    { x: 24.5, y: 1.3, z: 1, w: 2.4, h: 2.6, d: 6, mat: 'metal' },
    { x: 18, y: 1.3, z: 8, w: 2.4, h: 2.6, d: 6, mat: 'metal' },
    { x: 24, y: 1.3, z: 11, w: 6, h: 2.6, d: 2.4, mat: 'metal' },

    // ---- pipe runs (low cover, h=0.9) ----
    { x: 14, y: 0.45, z: 12, w: 8, h: 0.9, d: 1, mat: 'metal' },
    { x: -12, y: 0.45, z: -11, w: 6, h: 0.9, d: 1, mat: 'metal' },
    { x: 26, y: 0.45, z: -12, w: 1, h: 0.9, d: 8, mat: 'metal' },

    // ---- pallet piles (0.6 base + 0.3 top = 0.9 cover) ----
    { x: -18, y: 0.3, z: 8, w: 3, h: 0.6, d: 2, mat: 'wood' },
    { x: -18, y: 0.75, z: 8, w: 2.2, h: 0.3, d: 1.5, mat: 'wood' },
    { x: -18, y: 0.3, z: 0, w: 3, h: 0.6, d: 2, mat: 'wood' },
    { x: -18, y: 0.75, z: 0, w: 2.2, h: 0.3, d: 1.5, mat: 'wood' },
    { x: -12, y: 0.3, z: 5, w: 2.6, h: 0.6, d: 2, mat: 'wood' },
    { x: -12, y: 0.75, z: 5, w: 1.8, h: 0.3, d: 1.4, mat: 'wood' },

    // ---- crates (head-glitch 1.2 lane cover) ----
    { x: -22, y: 0.6, z: 16, w: 1.2, h: 1.2, d: 1.2, mat: 'crate' },
    { x: 22, y: 0.6, z: 16, w: 1.2, h: 1.2, d: 1.2, mat: 'crate' },
    { x: -22, y: 0.6, z: -16, w: 1.2, h: 1.2, d: 1.2, mat: 'crate' },
    { x: 22, y: 0.6, z: -16, w: 1.2, h: 1.2, d: 1.2, mat: 'crate' },
    { x: -20, y: 0.6, z: 12, w: 1.2, h: 1.2, d: 1.2, mat: 'crate' },
    { x: -21, y: 0.6, z: 3, w: 1.2, h: 1.2, d: 1.2, mat: 'crate' },
    { x: -13, y: 0.6, z: -5, w: 1.2, h: 1.2, d: 1.2, mat: 'crate' },
    { x: -2.5, y: 0.6, z: 7, w: 1.2, h: 1.2, d: 1.2, mat: 'crate' },
    { x: 2.5, y: 0.6, z: -7, w: 1.2, h: 1.2, d: 1.2, mat: 'crate' },
    { x: 15, y: 0.6, z: -2, w: 1.2, h: 1.2, d: 1.2, mat: 'crate' },
    { x: 21, y: 0.6, z: 4, w: 1.2, h: 1.2, d: 1.2, mat: 'crate' },
    { x: 15, y: 0.6, z: -13, w: 1.2, h: 1.2, d: 1.2, mat: 'crate' },
  ],
  spawns: {
    T: [
      { x: -9, z: 17.5, yaw: 0 },
      { x: -6, z: 17.5, yaw: 0 },
      { x: -3, z: 17.5, yaw: 0 },
      { x: 0, z: 17.5, yaw: 0 },
      { x: 3, z: 17.5, yaw: 0 },
      { x: 6, z: 17.5, yaw: 0 },
      { x: 9, z: 17.5, yaw: 0 },
    ],
    CT: [
      { x: -9, z: -17.5, yaw: Math.PI },
      { x: -6, z: -17.5, yaw: Math.PI },
      { x: -3, z: -17.5, yaw: Math.PI },
      { x: 0, z: -17.5, yaw: Math.PI },
      { x: 3, z: -17.5, yaw: Math.PI },
      { x: 6, z: -17.5, yaw: Math.PI },
      { x: 9, z: -17.5, yaw: Math.PI },
    ],
  },
  deco: [
    { kind: 'barrel', count: 28, x0: -27, z0: -19, x1: -12, z1: 19, minSpacing: 3 },
    { kind: 'barrel', count: 16, x0: 14, z0: -19, x1: 27, z1: 0, minSpacing: 3.5 },
    { kind: 'pallet', count: 24, x0: -10, z0: 8, x1: 27, z1: 19, minSpacing: 3.5 },
    { kind: 'pipe', count: 22, x0: 2, z0: -19, x1: 27, z1: 19, minSpacing: 4 },
    // AAA pass: stacked pallets pile up around the warehouse/dock and the SE
    // container yard (appended — earlier zone indices/seeds unchanged)
    { kind: 'palletStack', count: 10, x0: -27, z0: -14, x1: -13, z1: 8, minSpacing: 4 },
    { kind: 'palletStack', count: 8, x0: 12, z0: 4, x1: 27, z1: 19, minSpacing: 4 },
  ],
  // AAA accent: safety amber (tAmber) — dock-edge hazard strip, painted
  // container doors, crane leg stripes: the industrial safety-yellow rhythm
  accents: [
    // loading-dock edge hazard strip (front face of the dock platform)
    { x: -20.5, y: 0.73, z: -2.96, w: 11, h: 0.14, d: 0.05, hex: PALETTE.tAmber },
    // painted container doors (end faces of two mid-lane containers)
    { x: 7.5, y: 1.3, z: -7.54, w: 1.8, h: 1.8, d: 0.06, hex: PALETTE.tAmber },
    { x: -7.5, y: 1.3, z: 8.04, w: 1.8, h: 1.8, d: 0.06, hex: PALETTE.tAmber },
    // crane leg hazard stripes
    { x: -3.5, y: 0.9, z: -0.53, w: 1.04, h: 0.3, d: 0.05, hex: PALETTE.tAmber },
    { x: 3.5, y: 0.9, z: -0.53, w: 1.04, h: 0.3, d: 0.05, hex: PALETTE.tAmber },
  ],
};
