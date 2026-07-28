// FROZEN CONTRACT — reference map (full quality bar). Other maps must match
// this density and these playability invariants:
//   - enclosed by outer walls (h>=4) with no gaps
//   - 3 attack lanes from T spawn (south) to CT spawn (north)
//   - no spawn has a direct unobstructed sightline to an enemy spawn
//   - every lane has cover at least every 8m; longest open sightline <= 42m
//   - >= 6 spawns per team, all on y=0 ground, none inside boxes
import { PALETTE } from '../palette.js';
import type { MapDef } from './types.js';

const W = 64;
const D = 48;

export const dustbowl: MapDef = {
  id: 'dustbowl',
  name: 'Dustbowl',
  sizeX: W,
  sizeZ: D,
  floorMat: 'sand',
  theme: {
    sky: PALETTE.skyDusk,
    horizon: PALETTE.sand,
    ground: PALETTE.dust,
    fog: PALETTE.fogDusk,
    fogDensity: 0.012,
    sunDir: [0.5, -1, 0.35],
    sunColor: PALETTE.muzzle,
    sunIntensity: 1.5,
    hemiIntensity: 0.7,
  },
  boxes: [
    // ---- outer walls ----
    { x: 0, y: 2.5, z: -D / 2, w: W + 2, h: 5, d: 1, mat: 'sandDark' },
    { x: 0, y: 2.5, z: D / 2, w: W + 2, h: 5, d: 1, mat: 'sandDark' },
    { x: -W / 2, y: 2.5, z: 0, w: 1, h: 5, d: D + 2, mat: 'sandDark' },
    { x: W / 2, y: 2.5, z: 0, w: 1, h: 5, d: D + 2, mat: 'sandDark' },

    // ---- mid lane flanks (corridor x[-2,2] stays open) ----
    { x: -6.5, y: 1.6, z: 0, w: 9, h: 3.2, d: 12, mat: 'sand' },
    { x: 6.5, y: 1.6, z: 0, w: 9, h: 3.2, d: 12, mat: 'sand' },

    // mid corridor cover (wood family — the saturated 'crate' read as an
    // orphan red accent here; teal painted plates now carry the accent)
    { x: 0, y: 0.6, z: 9, w: 1.2, h: 1.2, d: 1.2, mat: 'wood' },
    { x: 0, y: 0.6, z: -9, w: 1.2, h: 1.2, d: 1.2, mat: 'wood' },

    // ---- left lane divider (gap z[-6,4]) ----
    { x: -14.5, y: 1.6, z: -10, w: 1.5, h: 3.2, d: 8, mat: 'sand' },
    { x: -14.5, y: 1.6, z: 8, w: 1.5, h: 3.2, d: 8, mat: 'sand' },

    // left lane cover
    { x: -22, y: 0.6, z: -2, w: 1.2, h: 1.2, d: 1.2, mat: 'crate' },
    { x: -25, y: 0.6, z: 6, w: 1.2, h: 1.2, d: 1.2, mat: 'crate' },
    { x: -20, y: 0.45, z: -10, w: 4, h: 0.9, d: 1, mat: 'sandDark' },
    { x: -24, y: 0.45, z: 12, w: 4, h: 0.9, d: 1, mat: 'sandDark' },

    // A courtyard (NW) crates
    { x: -26, y: 0.6, z: -19, w: 1.2, h: 1.2, d: 1.2, mat: 'crate' },
    { x: -24.6, y: 0.6, z: -19.4, w: 1.2, h: 1.2, d: 1.2, mat: 'crate' },
    { x: -25.4, y: 1.8, z: -19.2, w: 1.2, h: 1.2, d: 1.2, mat: 'crate' },
    { x: -19, y: 0.6, z: -18, w: 1.2, h: 1.2, d: 1.2, mat: 'crate' },

    // ---- right lane divider (gap z[-4,8]) ----
    { x: 14.5, y: 1.6, z: -8, w: 1.5, h: 3.2, d: 8, mat: 'sand' },
    { x: 14.5, y: 1.6, z: 11, w: 1.5, h: 3.2, d: 8, mat: 'sand' },

    // right lane cover
    { x: 22, y: 0.6, z: 6, w: 1.2, h: 1.2, d: 1.2, mat: 'crate' },
    { x: 25, y: 0.6, z: -2, w: 1.2, h: 1.2, d: 1.2, mat: 'crate' },
    { x: 20, y: 0.45, z: 14, w: 4, h: 0.9, d: 1, mat: 'sandDark' },

    // B platform (top y=1.2) + stairs from the south (steps of 0.4)
    { x: 22, y: 0.6, z: -10, w: 6, h: 1.2, d: 6, mat: 'sandDark' },
    { x: 22, y: 0.2, z: -6.6, w: 3, h: 0.4, d: 0.9, mat: 'sandDark' },
    { x: 22, y: 0.4, z: -5.7, w: 3, h: 0.8, d: 0.9, mat: 'sandDark' },
    { x: 22, y: 0.6, z: -4.8, w: 3, h: 1.2, d: 0.9, mat: 'sandDark' },

    // ---- spawn sightline breakers ----
    { x: 0, y: 1.5, z: 15, w: 12, h: 3, d: 1, mat: 'sand' },
    { x: 0, y: 1.5, z: -15, w: 12, h: 3, d: 1, mat: 'sand' },

    // spawn courtyard cover
    { x: 10, y: 0.75, z: 18, w: 1.5, h: 1.5, d: 1.5, mat: 'metal' },
    { x: -10, y: 0.75, z: 18, w: 1.5, h: 1.5, d: 1.5, mat: 'metal' },
    { x: 10, y: 0.75, z: -18, w: 1.5, h: 1.5, d: 1.5, mat: 'metal' },
    { x: -10, y: 0.75, z: -18, w: 1.5, h: 1.5, d: 1.5, mat: 'metal' },

    // scattered extra cover
    { x: -8, y: 0.45, z: 20, w: 3, h: 0.9, d: 1, mat: 'sandDark' },
    { x: 8, y: 0.45, z: -20, w: 3, h: 0.9, d: 1, mat: 'sandDark' },

    // lane-gap + end-zone dressing (added post-review: keeps box count in the
    // 40-90 map invariant band; gaps stay > 1.4m, spawns untouched)
    { x: -14.5, y: 0.6, z: -2, w: 1.2, h: 1.2, d: 1.2, mat: 'crate' },
    { x: 14.5, y: 0.6, z: 2, w: 1.2, h: 1.2, d: 1.2, mat: 'crate' },
    { x: 0, y: 0.45, z: 12.5, w: 1, h: 0.9, d: 1, mat: 'sandDark' },
    { x: 0, y: 0.45, z: -12.5, w: 1, h: 0.9, d: 1, mat: 'sandDark' },
    { x: -22, y: 0.45, z: -20, w: 3, h: 0.9, d: 1, mat: 'sandDark' },
    { x: 18, y: 0.6, z: -14, w: 1.2, h: 1.2, d: 1.2, mat: 'crate' },
  ],
  spawns: {
    T: [
      { x: -8, z: 20.5, yaw: 0 },
      { x: -4, z: 21.5, yaw: 0 },
      { x: 0, z: 21, yaw: 0 },
      { x: 4, z: 21.5, yaw: 0 },
      { x: 8, z: 20.5, yaw: 0 },
      { x: 0, z: 18.5, yaw: 0 },
    ],
    CT: [
      { x: -8, z: -20.5, yaw: Math.PI },
      { x: -4, z: -21.5, yaw: Math.PI },
      { x: 0, z: -21, yaw: Math.PI },
      { x: 4, z: -21.5, yaw: Math.PI },
      { x: 8, z: -20.5, yaw: Math.PI },
      { x: 0, z: -18.5, yaw: Math.PI },
    ],
  },
  deco: [
    { kind: 'cactus', count: 14, x0: -31, z0: -23, x1: -16, z1: 23, minSpacing: 4 },
    { kind: 'rock', count: 8, x0: 16, z0: -23, x1: 31, z1: 23, minSpacing: 6 },
    { kind: 'shrub', count: 30, x0: -31, z0: -23, x1: 31, z1: 23, minSpacing: 3 },
    { kind: 'barrel', count: 14, x0: -16, z0: -23, x1: 16, z1: 23, minSpacing: 3, hex: PALETTE.dust },
    // corner/dead-zone dressing (style bible: corners get the most dressing)
    { kind: 'cactus', count: 6, x0: -31, z0: 16, x1: -18, z1: 23, minSpacing: 3 },
    { kind: 'shrub', count: 8, x0: 18, z0: -23, x1: 31, z1: -14, minSpacing: 3 },
    // AAA pass: sandbag fighting positions along the three lanes (appended —
    // earlier zone indices/seeds unchanged); solids/spawn rejection keeps the
    // corridor walls, crates and blocks clear
    { kind: 'sandbag', count: 16, x0: -3.5, z0: -13, x1: 3.5, z1: 13, minSpacing: 3 },
    { kind: 'sandbag', count: 8, x0: -27, z0: -14, x1: -18, z1: 14, minSpacing: 4 },
    { kind: 'sandbag', count: 8, x0: 18, z0: -14, x1: 27, z1: 14, minSpacing: 4 },
  ],
  // AAA skyline: dune/mesa silhouette ring beyond the outer walls (the sky is
  // a third of the frame down mid lane — it must not be empty)
  skyline: {
    hex: PALETTE.sandDark,
    capHex: PALETTE.dust,
    count: 12,
    minR: 42,
    maxR: 68,
    minH: 7,
    maxH: 13,
  },
  // AAA accent: muted steel-teal (screenGlow) — gate frames on both mid-lane
  // termini, painted plates on the mid crates, tarps on the flank faces:
  // three deliberate repeats down the mid sightline
  accents: [
    // gate frames on the z=-/+15 breaker walls (posts + lintel, visual only)
    { x: -1.8, y: 1.65, z: -14.35, w: 0.5, h: 3.3, d: 0.3, hex: PALETTE.screenGlow },
    { x: 1.8, y: 1.65, z: -14.35, w: 0.5, h: 3.3, d: 0.3, hex: PALETTE.screenGlow },
    { x: 0, y: 3.25, z: -14.35, w: 4.6, h: 0.5, d: 0.4, hex: PALETTE.screenGlow },
    { x: -1.8, y: 1.65, z: 14.35, w: 0.5, h: 3.3, d: 0.3, hex: PALETTE.screenGlow },
    { x: 1.8, y: 1.65, z: 14.35, w: 0.5, h: 3.3, d: 0.3, hex: PALETTE.screenGlow },
    { x: 0, y: 3.25, z: 14.35, w: 4.6, h: 0.5, d: 0.4, hex: PALETTE.screenGlow },
    // painted teal plates on the mid-lane cover crates (both faces, so the
    // accent reads from either attack direction)
    { x: 0, y: 0.62, z: -9.63, w: 1.0, h: 0.7, d: 0.06, hex: PALETTE.screenGlow },
    { x: 0, y: 0.62, z: -8.37, w: 1.0, h: 0.7, d: 0.06, hex: PALETTE.screenGlow },
    { x: 0, y: 0.62, z: 8.37, w: 1.0, h: 0.7, d: 0.06, hex: PALETTE.screenGlow },
    { x: 0, y: 0.62, z: 9.63, w: 1.0, h: 0.7, d: 0.06, hex: PALETTE.screenGlow },
    // tarps on the mid flank inner faces (corridor eye level)
    { x: -1.97, y: 1.9, z: 0, w: 0.06, h: 1.1, d: 2.2, hex: PALETTE.screenGlow },
    { x: 1.97, y: 1.9, z: 0, w: 0.06, h: 1.1, d: 2.2, hex: PALETTE.screenGlow },
  ],
};
