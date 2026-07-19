// Map M4 — URBANA (old town), 56x44. T spawns south, CT spawns north.
// Solid brick/plaster blocks (no interiors) carve three routes:
//   R1 central street (market stalls + tall crate stacks break it up)
//   R2 west alley -> plaza jog -> west alley north
//   R3 east alley -> courtyard jog -> east alley north
// Invariants held (verified mechanically: grid flood/BFS, ray casts, channel sweeps):
//   - enclosed by outer walls h=5, no gaps
//   - 3 distinct T->CT routes; alleys 4.5m, street 10m, tightest pinch 1.5m (annex corner)
//   - no T spawn visible from any CT spawn (stalls/stacks/blocks h>=2.4 cover every pair)
//   - cover (crates/stalls/low walls/cart/well, all >=0.9 high) every <=8m per route
//   - longest open sightline ~41m <= 42m (square houses + X2/S3/S4 lips cut the diagonals)
//   - 7 spawns/team on y=0, none inside boxes
// roofRed caps + stall awnings sit on top of solid bodies: skyline only, unreachable.
import { PALETTE } from '../palette.js';
import type { BoxDef, MapDef, MatId } from './types.js';

const W = 56;
const D = 44;

// center/extents box
const B = (x: number, y: number, z: number, w: number, h: number, d: number, mat: MatId): BoxDef =>
  ({ x, y, z, w, h, d, mat });

// ground-standing box from rect x0..x1, z0..z1
const R = (x0: number, x1: number, z0: number, z1: number, h: number, mat: MatId): BoxDef =>
  B((x0 + x1) / 2, h / 2, (z0 + z1) / 2, x1 - x0, h, z1 - z0, mat);

// building block + roofRed cap (cap bottom = building top: unreachable, skyline only)
const struct = (x0: number, x1: number, z0: number, z1: number, h: number, mat: MatId): BoxDef[] => [
  R(x0, x1, z0, z1, h, mat),
  B((x0 + x1) / 2, h + 0.55, (z0 + z1) / 2, x1 - x0 - 0.2, 1.1, z1 - z0 - 0.2, 'roofRed'),
];

// market stall: solid crate-mat body (eye-blocker) + roofRed awning slab
const stall = (x0: number, x1: number, z0: number, z1: number, h: number): BoxDef[] => [
  R(x0, x1, z0, z1, h, 'crate'),
  B((x0 + x1) / 2, h + 0.15, (z0 + z1) / 2, x1 - x0 + 0.6, 0.3, z1 - z0 + 0.6, 'roofRed'),
];

export const urbana: MapDef = {
  id: 'urbana',
  name: 'Urbana',
  sizeX: W,
  sizeZ: D,
  floorMat: 'concrete',
  theme: {
    sky: PALETTE.skyDay,
    horizon: PALETTE.plaster,
    ground: PALETTE.plaster,
    fog: PALETTE.fogDay,
    fogDensity: 0.006,
    sunDir: [0.45, -1, 0.3],
    sunColor: PALETTE.paper,
    sunIntensity: 1.5,
    hemiIntensity: 0.8,
  },
  boxes: [
    // ---- outer walls (h=5, corners overlap: no gaps) ----
    B(0, 2.5, -D / 2, W + 2, 5, 1, 'brick'),
    B(0, 2.5, D / 2, W + 2, 5, 1, 'brick'),
    B(-W / 2, 2.5, 0, 1, 5, D + 2, 'brick'),
    B(W / 2, 2.5, 0, 1, 5, D + 2, 'brick'),

    // ---- outer west block (west alley = x[-18,-13.5] on its east face) ----
    ...struct(-27, -18, -21.5, -5, 6, 'brick'), // W1: nook z[-5,1] south of it; touches the north wall
    ...struct(-27, -18, 1, 9, 5, 'plaster'), // W2: nook z[9,13] south of it
    ...struct(-27, -18, 13, 21.5, 6, 'brick'), // W3 touches the south wall

    // ---- inner west block (plaza = x[-13.5,-5] z[-10,10] between C1/C2) ----
    ...struct(-13.5, -5, -17, -10, 5, 'plaster'), // C1
    ...struct(-13.5, -4.8, 10, 17, 6, 'brick'), // C2 (-4.8: mirror of E2, closes the court-to-court diagonal)

    // ---- inner east block (courtyard = x[5,13.5] z[-12,2] between E1/E2) ----
    ...struct(5, 13.5, -17, -12, 6, 'brick'), // E1
    ...struct(4.8, 13.5, 2, 17, 5, 'plaster'), // E2 (4.8: mirror of C2; z=2 cuts nook->X2 diagonals)

    // ---- outer east block (east alley = x[13.5,18] on its west face) ----
    ...struct(18, 27, -21.5, -9, 5, 'plaster'), // X1: nook z[-9,-4.5] south of it; touches the north wall
    ...struct(18, 27, -4.5, 6.6, 6, 'brick'), // X2: nook z[6.6,11] south of it; faces catch the court diagonals
    ...struct(18, 27, 13, 21.5, 5, 'brick'), // X3 touches the south wall

    // ---- alley mid-blockers (force the plaza / courtyard jogs, break 43m alleys) ----
    ...struct(-18, -13.5, 1, 4, 4.5, 'plaster'), // west archhouse: alley jogs east into plaza
    ...struct(13.5, 18, -6, -3, 4.5, 'brick'), // east chapel: alley jogs west into courtyard

    // ---- square houses (cut the >42m wall-nook diagonals across plaza/courtyard) ----
    ...struct(-11, -7, -9, -3, 4.5, 'plaster'), // plaza house: passages 2.5m W / 2.0m E
    ...struct(10, 13.5, -10, -6, 4.5, 'brick'), // courtyard annex: corner slot 1.5m, 5m W rows, 2m to E1

    // ---- street market stalls (eye-blockers: top >= 2.4) ----
    ...stall(-3.2, -0.5, -9, -7, 2.4), // S1 north row (gap to C1: 1.8m)
    ...stall(0.5, 3.2, 7, 9, 2.4), // S2 south row (gap to E2: 1.6m)
    ...stall(-1.5, 1.5, -1.5, 3.5, 2.6), // S3 center (3.5m passages; z-lip cuts nook diagonals)
    ...stall(-8.5, -3.3, -3, 0, 2.5), // S4 plaza edge (covers the x=-8/-4 spawn lines + the x=-3.5 N-S lanes)
    ...stall(3.5, 8.5, -6, -3, 2.5), // S5 chapel row (covers the x=4..8 spawn lines)

    // ---- tall crate stacks (top 2.4: block the x=-2 / x=2.5 street lines) ----
    B(-2, 0.6, 8, 1.2, 1.2, 1.2, 'crate'),
    B(-2, 1.8, 8, 1.2, 1.2, 1.2, 'crate'),
    B(2.5, 0.6, -8, 1.2, 1.2, 1.2, 'crate'),
    B(2.5, 1.8, -8, 1.2, 1.2, 1.2, 'crate'),

    // ---- market cart (courtyard south, top 1.1: cover) ----
    B(7.5, 0.85, 0.5, 2.4, 0.5, 1.2, 'wood'), // bed
    B(7.5, 0.45, 0.5, 1.8, 0.3, 0.8, 'wood'), // undercarriage
    B(6.8, 0.35, -0.17, 0.7, 0.7, 0.15, 'crate'), // wheels (thin boxes read as discs)
    B(8.2, 0.35, -0.17, 0.7, 0.7, 0.15, 'crate'),
    B(6.8, 0.35, 1.17, 0.7, 0.7, 0.15, 'crate'),
    B(8.2, 0.35, 1.17, 0.7, 0.7, 0.15, 'crate'),
    B(5.85, 0.8, 0.5, 0.9, 0.12, 0.12, 'wood'), // pull handle (west side)

    // ---- plaza well (cover mid-plaza) ----
    B(-9, 0.5, 3, 1.6, 1, 1.6, 'concrete'),

    // ---- alley low walls (in-lane cover hugging the outer block, 3.5m passage kept) ----
    B(-17.4, 0.5, 14, 0.8, 1, 2.4, 'concrete'),
    B(-17.4, 0.5, 6, 0.8, 1, 2.4, 'concrete'),
    B(-17.4, 0.5, -3, 0.8, 1, 2.4, 'concrete'),
    B(-17.4, 0.5, -11, 0.8, 1, 2.4, 'concrete'),
    B(17.4, 0.5, 15, 0.8, 1, 2.4, 'concrete'),
    B(17.4, 0.5, 7, 0.8, 1, 2.4, 'concrete'),
    B(17.4, 0.5, -1, 0.8, 1, 2.4, 'concrete'),
    B(17.4, 0.5, -9, 0.8, 1, 2.4, 'concrete'),
    B(17.4, 0.5, -16, 0.8, 1, 2.4, 'concrete'),

    // ---- market crates (cover along routes + spawn courts) ----
    B(-6, 0.6, 18.8, 1.2, 1.2, 1.2, 'crate'), // T court
    B(6, 0.6, 18.8, 1.2, 1.2, 1.2, 'crate'),
    B(-16.5, 0.6, 18, 1.2, 1.2, 1.2, 'crate'),
    B(16.5, 0.6, 18, 1.2, 1.2, 1.2, 'crate'),
    B(-6, 0.6, -18.8, 1.2, 1.2, 1.2, 'crate'), // CT court
    B(6, 0.6, -18.8, 1.2, 1.2, 1.2, 'crate'),
    B(-16.5, 0.6, -18, 1.2, 1.2, 1.2, 'crate'),
    B(16.5, 0.6, -18, 1.2, 1.2, 1.2, 'crate'),
    B(-11, 0.6, 6, 1.2, 1.2, 1.2, 'crate'), // plaza
    B(-12, 0.6, 1.5, 1.2, 1.2, 1.2, 'crate'), // plaza SW (clear of the plaza house)
    B(11.5, 0.6, -1, 1.2, 1.2, 1.2, 'crate'), // east courtyard
    B(-22, 0.6, -2, 1.2, 1.2, 1.2, 'crate'), // west nook
    B(22, 0.6, 8, 1.2, 1.2, 1.2, 'crate'), // east nook
    B(3.5, 0.6, 14, 1.2, 1.2, 1.2, 'crate'), // street south
    B(-4, 0.6, -13, 1.2, 1.2, 1.2, 'crate'), // street north
    B(-2, 0.6, -16.5, 1.2, 1.2, 1.2, 'crate'), // CT court mouth
  ],
  spawns: {
    // 7 per team across the open spawn courts (z +/- 17..21.5); alleys stay clear.
    T: [
      { x: -14, z: 20.3, yaw: 0 },
      { x: -8, z: 20.6, yaw: 0 },
      { x: -3, z: 20.9, yaw: 0 },
      { x: 0, z: 19, yaw: 0 },
      { x: 3, z: 20.9, yaw: 0 },
      { x: 8, z: 20.6, yaw: 0 },
      { x: 14, z: 20.3, yaw: 0 },
    ],
    CT: [
      { x: -14, z: -20.3, yaw: Math.PI },
      { x: -8, z: -20.6, yaw: Math.PI },
      { x: -3, z: -20.9, yaw: Math.PI },
      { x: 0, z: -19, yaw: Math.PI },
      { x: 3, z: -20.9, yaw: Math.PI },
      { x: 8, z: -20.6, yaw: Math.PI },
      { x: 14, z: -20.3, yaw: Math.PI },
    ],
  },
  deco: [
    // market barrels along the street and squares (client scatter, non-collidable)
    { kind: 'barrel', count: 12, x0: -4.5, z0: -15, x1: 4.5, z1: 15, minSpacing: 2.5 },
    { kind: 'barrel', count: 9, x0: -13, z0: -9, x1: -5.5, z1: 9, minSpacing: 2.5 },
    { kind: 'barrel', count: 9, x0: 5.5, z0: -11, x1: 13, z1: 3, minSpacing: 2.5 },
    { kind: 'barrel', count: 5, x0: -17.5, z0: -19, x1: -14, z1: 19, minSpacing: 3 },
    { kind: 'barrel', count: 5, x0: 14, z0: -19, x1: 17.5, z1: 19, minSpacing: 3 },
    // shrubs dress corners, nooks and the spawn courts
    { kind: 'shrub', count: 12, x0: -27, z0: -21, x1: 27, z1: 21, minSpacing: 3 },
    { kind: 'shrub', count: 4, x0: -17, z0: -21.4, x1: 17, z1: -17.5, minSpacing: 2.5 },
    { kind: 'shrub', count: 4, x0: -17, z0: 17.5, x1: 17, z1: 21.4, minSpacing: 2.5 },
  ],
};
