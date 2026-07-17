// MAP M5 — bunker (underground CQB). Replaces placeholder per CONTRACT.md "Map specs".
// Layout carved out of solid mass: 8x8 central hub, a 2.5m ring corridor around it
// (the loop), 4 side rooms (N/S = team spawn rooms, W/E = flank rooms); all other
// interior volume is solid concreteDark. Invariants verified:
//   - enclosed: outer walls h=3 + ceiling slab (bottom at y=2.8), no gaps
//   - routes CT(N) -> T(S): west ring, east ring, through the hub = 3 (+ ring loop)
//   - no spawn sightline: N/S lines must thread hub N door [0.8,2.8] + S door [-3,-1];
//     every such line crosses the 2x2 central pillar (door sets are staggered), and
//     ring routes require bends a straight line cannot make
//   - longest open sightline ~21m (worst case threads hub E door + W door + W room
//     door); straight ring runs are 15.4m; hard limit is 25m
//   - cover every <=8m on routes (room crates -> ring nub -> junction crate -> ...)
//   - corridors 2.5m; worst pinches 1.5m (ring nubs) / 1.6m (junction crates) >= 1.4m
//   - 7 spawns/team, all on y=0 ground, none inside boxes (>=0.9m clearance)
import { PALETTE } from '../palette.js';
import type { MapDef } from './types.js';

const W = 32;
const D = 32;

export const bunker: MapDef = {
  id: 'bunker',
  name: 'Bunker',
  sizeX: W,
  sizeZ: D,
  floorMat: 'metalDark',
  theme: {
    sky: PALETTE.skyIndoor,
    horizon: PALETTE.ink,
    ground: PALETTE.charcoal,
    fog: PALETTE.ink,
    fogDensity: 0.018,
    sunDir: [0.2, -1, 0.15],
    sunColor: PALETTE.steel,
    sunIntensity: 0.9,
    hemiIntensity: 0.8,
  },
  boxes: [
    // ---- outer shell: walls h=3 + ceiling (slab bottom y=2.8) ----
    { x: 0, y: 1.5, z: -D / 2, w: W + 2, h: 3, d: 1, mat: 'concreteDark' },
    { x: 0, y: 1.5, z: D / 2, w: W + 2, h: 3, d: 1, mat: 'concreteDark' },
    { x: -W / 2, y: 1.5, z: 0, w: 1, h: 3, d: D + 2, mat: 'concreteDark' },
    { x: W / 2, y: 1.5, z: 0, w: 1, h: 3, d: D + 2, mat: 'concreteDark' },
    { x: 0, y: 2.95, z: 0, w: W + 2, h: 0.3, d: D + 2, mat: 'metalDark' },

    // ---- solid corner masses (bunker is carved, not built) ----
    { x: -10.25, y: 1.5, z: -11.6, w: 10, h: 3, d: 7.8, mat: 'concreteDark' }, // NW
    { x: 10.25, y: 1.5, z: -11.6, w: 10, h: 3, d: 7.8, mat: 'concreteDark' }, // NE
    { x: -10.25, y: 1.5, z: 11.6, w: 10, h: 3, d: 7.8, mat: 'concreteDark' }, // SW
    { x: 10.25, y: 1.5, z: 11.6, w: 10, h: 3, d: 7.8, mat: 'concreteDark' }, // SE

    // ---- W/E room flank masses (seal ring corridor outer wall) ----
    { x: -11.6, y: 1.5, z: -6.6, w: 7.8, h: 3, d: 2.2, mat: 'concreteDark' },
    { x: -11.6, y: 1.5, z: 6.6, w: 7.8, h: 3, d: 2.2, mat: 'concreteDark' },
    { x: 11.6, y: 1.5, z: -6.6, w: 7.8, h: 3, d: 2.2, mat: 'concreteDark' },
    { x: 11.6, y: 1.5, z: 6.6, w: 7.8, h: 3, d: 2.2, mat: 'concreteDark' },

    // ---- W room east wall (doors z[-3.7,-1.7] + [1.7,3.7]) ----
    { x: -8.3, y: 1.5, z: -4.6, w: 1.2, h: 3, d: 1.8, mat: 'concreteDark' },
    { x: -8.3, y: 1.5, z: 0, w: 1.2, h: 3, d: 3.4, mat: 'concreteDark' },
    { x: -8.3, y: 1.5, z: 4.6, w: 1.2, h: 3, d: 1.8, mat: 'concreteDark' },
    // ---- E room west wall (doors z[-3.7,-1.7] + [1.7,3.7]) ----
    { x: 8.3, y: 1.5, z: -4.6, w: 1.2, h: 3, d: 1.8, mat: 'concreteDark' },
    { x: 8.3, y: 1.5, z: 0, w: 1.2, h: 3, d: 3.4, mat: 'concreteDark' },
    { x: 8.3, y: 1.5, z: 4.6, w: 1.2, h: 3, d: 1.8, mat: 'concreteDark' },

    // ---- N room (CT) south wall (doors x[-4.2,-2.2] + [2.2,4.2]) ----
    { x: -4.85, y: 1.5, z: -8.3, w: 1.3, h: 3, d: 1.2, mat: 'concreteDark' },
    { x: 0, y: 1.5, z: -8.3, w: 4.4, h: 3, d: 1.2, mat: 'concreteDark' },
    { x: 4.85, y: 1.5, z: -8.3, w: 1.3, h: 3, d: 1.2, mat: 'concreteDark' },
    // ---- S room (T) north wall (doors x[-4.2,-2.2] + [2.2,4.2]) ----
    { x: -4.85, y: 1.5, z: 8.3, w: 1.3, h: 3, d: 1.2, mat: 'concreteDark' },
    { x: 0, y: 1.5, z: 8.3, w: 4.4, h: 3, d: 1.2, mat: 'concreteDark' },
    { x: 4.85, y: 1.5, z: 8.3, w: 1.3, h: 3, d: 1.2, mat: 'concreteDark' },

    // ---- hub walls (metalDark); doors staggered so no straight N-S/W-E line ----
    // N wall: door x[0.8,2.8]
    { x: -2.2, y: 1.5, z: -4.6, w: 6, h: 3, d: 1.2, mat: 'metalDark' },
    { x: 4, y: 1.5, z: -4.6, w: 2.4, h: 3, d: 1.2, mat: 'metalDark' },
    // S wall: door x[-3,-1]
    { x: -4.1, y: 1.5, z: 4.6, w: 2.2, h: 3, d: 1.2, mat: 'metalDark' },
    { x: 2.1, y: 1.5, z: 4.6, w: 6.2, h: 3, d: 1.2, mat: 'metalDark' },
    // W wall: door z[1,3]
    { x: -4.6, y: 1.5, z: -2.1, w: 1.2, h: 3, d: 6.2, mat: 'metalDark' },
    { x: -4.6, y: 1.5, z: 4.1, w: 1.2, h: 3, d: 2.2, mat: 'metalDark' },
    // E wall: door z[-3,-1]
    { x: 4.6, y: 1.5, z: -4.1, w: 1.2, h: 3, d: 2.2, mat: 'metalDark' },
    { x: 4.6, y: 1.5, z: 2.1, w: 1.2, h: 3, d: 6.2, mat: 'metalDark' },

    // ---- hub: central pillar (blocks all through-hub spawn lines) + crates ----
    { x: 0, y: 1.5, z: 0, w: 2, h: 3, d: 2, mat: 'metalDark' },
    { x: -2.8, y: 0.6, z: -2.8, w: 1.2, h: 1.2, d: 1.2, mat: 'crate' },
    { x: 2.8, y: 0.6, z: 2.8, w: 1.2, h: 1.2, d: 1.2, mat: 'crate' },

    // ---- ring corridor nubs (mid-segment cover; leave 1.5m pinch) ----
    { x: 0, y: 1.5, z: -7.2, w: 1.2, h: 3, d: 1.0, mat: 'concreteDark' },
    { x: 0, y: 1.5, z: 7.2, w: 1.2, h: 3, d: 1.0, mat: 'concreteDark' },
    { x: -7.2, y: 1.5, z: 0, w: 1.0, h: 3, d: 1.2, mat: 'concreteDark' },
    { x: 7.2, y: 1.5, z: 0, w: 1.0, h: 3, d: 1.2, mat: 'concreteDark' },

    // ---- ring junction crates (outer corners; leave 1.6m pinch) ----
    { x: -7.25, y: 0.6, z: -7.25, w: 0.9, h: 1.2, d: 0.9, mat: 'crate' },
    { x: 7.25, y: 0.6, z: -7.25, w: 0.9, h: 1.2, d: 0.9, mat: 'crate' },
    { x: -7.25, y: 0.6, z: 7.25, w: 0.9, h: 1.2, d: 0.9, mat: 'crate' },
    { x: 7.25, y: 0.6, z: 7.25, w: 0.9, h: 1.2, d: 0.9, mat: 'crate' },

    // ---- N room (CT spawn) crate stacks ----
    { x: -4, y: 0.6, z: -11, w: 1.2, h: 1.2, d: 1.2, mat: 'crate' },
    { x: -4, y: 1.8, z: -11, w: 1.2, h: 1.2, d: 1.2, mat: 'crate' },
    { x: 4, y: 0.6, z: -11, w: 1.2, h: 1.2, d: 1.2, mat: 'crate' },
    { x: 0, y: 0.6, z: -12, w: 1.2, h: 1.2, d: 1.2, mat: 'crate' },
    { x: 4.9, y: 0.6, z: -9.6, w: 1.2, h: 1.2, d: 1.2, mat: 'crate' },
    // ---- S room (T spawn) crate stacks (180° rotation) ----
    { x: 4, y: 0.6, z: 11, w: 1.2, h: 1.2, d: 1.2, mat: 'crate' },
    { x: 4, y: 1.8, z: 11, w: 1.2, h: 1.2, d: 1.2, mat: 'crate' },
    { x: -4, y: 0.6, z: 11, w: 1.2, h: 1.2, d: 1.2, mat: 'crate' },
    { x: 0, y: 0.6, z: 12, w: 1.2, h: 1.2, d: 1.2, mat: 'crate' },
    { x: -4.9, y: 0.6, z: 9.6, w: 1.2, h: 1.2, d: 1.2, mat: 'crate' },
    // ---- W room crates ----
    { x: -11, y: 0.6, z: -4, w: 1.2, h: 1.2, d: 1.2, mat: 'crate' },
    { x: -11, y: 0.6, z: 4, w: 1.2, h: 1.2, d: 1.2, mat: 'crate' },
    { x: -12.5, y: 0.6, z: 0, w: 1.2, h: 1.2, d: 1.2, mat: 'crate' },
    { x: -12.5, y: 1.8, z: 0, w: 1.2, h: 1.2, d: 1.2, mat: 'crate' },
    // ---- E room crates (180° rotation) ----
    { x: 11, y: 0.6, z: 4, w: 1.2, h: 1.2, d: 1.2, mat: 'crate' },
    { x: 11, y: 0.6, z: -4, w: 1.2, h: 1.2, d: 1.2, mat: 'crate' },
    { x: 12.5, y: 0.6, z: 0, w: 1.2, h: 1.2, d: 1.2, mat: 'crate' },
    { x: 12.5, y: 1.8, z: 0, w: 1.2, h: 1.2, d: 1.2, mat: 'crate' },

    // ---- pipe runs along walls (y 2.325-2.575: above heads, below ceiling) ----
    { x: 0, y: 2.45, z: -7.55, w: 15, h: 0.25, d: 0.3, mat: 'metalDark' }, // ring N
    { x: 0, y: 2.45, z: 7.55, w: 15, h: 0.25, d: 0.3, mat: 'metalDark' }, // ring S
    { x: -7.55, y: 2.45, z: 0, w: 0.3, h: 0.25, d: 15, mat: 'metalDark' }, // ring W
    { x: 7.55, y: 2.45, z: 0, w: 0.3, h: 0.25, d: 15, mat: 'metalDark' }, // ring E
    { x: 0, y: 2.45, z: -15.35, w: 10.6, h: 0.25, d: 0.3, mat: 'metalDark' }, // N room
    { x: 0, y: 2.45, z: 15.35, w: 10.6, h: 0.25, d: 0.3, mat: 'metalDark' }, // S room
    { x: -15.35, y: 2.45, z: 0, w: 0.3, h: 0.25, d: 10.6, mat: 'metalDark' }, // W room
    { x: 15.35, y: 2.45, z: 0, w: 0.3, h: 0.25, d: 10.6, mat: 'metalDark' }, // E room
    // vertical drop pipes in room corners
    { x: -5.2, y: 1.4, z: -15.2, w: 0.3, h: 2.8, d: 0.3, mat: 'metalDark' },
    { x: 5.2, y: 1.4, z: -15.2, w: 0.3, h: 2.8, d: 0.3, mat: 'metalDark' },
    { x: -5.2, y: 1.4, z: 15.2, w: 0.3, h: 2.8, d: 0.3, mat: 'metalDark' },
    { x: 5.2, y: 1.4, z: 15.2, w: 0.3, h: 2.8, d: 0.3, mat: 'metalDark' },
    { x: -15.2, y: 1.4, z: -5.2, w: 0.3, h: 2.8, d: 0.3, mat: 'metalDark' },
    { x: -15.2, y: 1.4, z: 5.2, w: 0.3, h: 2.8, d: 0.3, mat: 'metalDark' },
    { x: 15.2, y: 1.4, z: -5.2, w: 0.3, h: 2.8, d: 0.3, mat: 'metalDark' },
    { x: 15.2, y: 1.4, z: 5.2, w: 0.3, h: 2.8, d: 0.3, mat: 'metalDark' },

    // ---- ceiling beams (hang to y2.51; clear of players and crate stacks) ----
    { x: 0, y: 2.62, z: 0, w: 8, h: 0.22, d: 0.5, mat: 'metalDark' }, // hub
    { x: 0, y: 2.62, z: 0, w: 0.5, h: 0.22, d: 8, mat: 'metalDark' }, // hub
    { x: 0, y: 2.62, z: -11.5, w: 10.6, h: 0.22, d: 0.5, mat: 'metalDark' }, // N room
    { x: 0, y: 2.62, z: 11.5, w: 10.6, h: 0.22, d: 0.5, mat: 'metalDark' }, // S room
    { x: -11.5, y: 2.62, z: 0, w: 0.5, h: 0.22, d: 10.6, mat: 'metalDark' }, // W room
    { x: 11.5, y: 2.62, z: 0, w: 0.5, h: 0.22, d: 10.6, mat: 'metalDark' }, // E room
  ],
  spawns: {
    // CT holds the N room, faces south (+Z); row keeps >=0.9m clear of all boxes
    CT: [
      { x: -4, z: -13.8, yaw: Math.PI },
      { x: -2.4, z: -13.8, yaw: Math.PI },
      { x: -0.8, z: -13.8, yaw: Math.PI },
      { x: 0.8, z: -13.8, yaw: Math.PI },
      { x: 2.4, z: -13.8, yaw: Math.PI },
      { x: 4, z: -13.8, yaw: Math.PI },
      { x: -0.8, z: -14.6, yaw: Math.PI },
    ],
    // T holds the S room, faces north (-Z); 180° rotation of CT
    T: [
      { x: 4, z: 13.8, yaw: 0 },
      { x: 2.4, z: 13.8, yaw: 0 },
      { x: 0.8, z: 13.8, yaw: 0 },
      { x: -0.8, z: 13.8, yaw: 0 },
      { x: -2.4, z: 13.8, yaw: 0 },
      { x: -4, z: 13.8, yaw: 0 },
      { x: 0.8, z: 14.6, yaw: 0 },
    ],
  },
  deco: [
    // pipe props: ring corridors + hub surroundings (no spawns nearby)
    { kind: 'pipe', count: 14, x0: -7.2, z0: -7.2, x1: 7.2, z1: 7.2, minSpacing: 3.5 },
    // pipe props in the four side rooms
    { kind: 'pipe', count: 4, x0: -5, z0: -14.5, x1: 5, z1: -9.4, minSpacing: 3 },
    { kind: 'pipe', count: 4, x0: -5, z0: 9.4, x1: 5, z1: 14.5, minSpacing: 3 },
    // barrels: spawn rooms south half (clear of the >=2.5m spawn rejection radius)
    { kind: 'barrel', count: 5, x0: -5, z0: -11.2, x1: 5, z1: -9.3, minSpacing: 2 },
    { kind: 'barrel', count: 5, x0: -5, z0: 9.3, x1: 5, z1: 11.2, minSpacing: 2 },
    // barrels: flank rooms (no spawns there)
    { kind: 'barrel', count: 5, x0: -14.8, z0: -5, x1: -9.4, z1: 5, minSpacing: 2.5 },
    { kind: 'barrel', count: 5, x0: 9.4, z0: -5, x1: 14.8, z1: 5, minSpacing: 2.5 },
  ],
};
