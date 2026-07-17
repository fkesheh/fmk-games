// PLACEHOLDER — replaced by task M5 with a full-quality CQB bunker map
// (see CONTRACT.md "Map specs"). Must keep: id, enclosure, spawns, invariants.
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
    hemiIntensity: 0.75,
  },
  boxes: [
    { x: 0, y: 1.5, z: -D / 2, w: W + 2, h: 3, d: 1, mat: 'metalDark' },
    { x: 0, y: 1.5, z: D / 2, w: W + 2, h: 3, d: 1, mat: 'metalDark' },
    { x: -W / 2, y: 1.5, z: 0, w: 1, h: 3, d: D + 2, mat: 'metalDark' },
    { x: W / 2, y: 1.5, z: 0, w: 1, h: 3, d: D + 2, mat: 'metalDark' },
    // ceiling
    { x: 0, y: 3.15, z: 0, w: W + 2, h: 0.3, d: D + 2, mat: 'metalDark' },
    // corridors
    { x: -6, y: 1.5, z: -6, w: 1.2, h: 3, d: 10, mat: 'concreteDark' },
    { x: 6, y: 1.5, z: 6, w: 1.2, h: 3, d: 10, mat: 'concreteDark' },
    { x: -6, y: 1.5, z: 8, w: 8, h: 3, d: 1.2, mat: 'concreteDark' },
    { x: 6, y: 1.5, z: -8, w: 8, h: 3, d: 1.2, mat: 'concreteDark' },
  ],
  spawns: {
    T: [
      { x: -4, z: 12, yaw: 0 }, { x: 0, z: 13, yaw: 0 }, { x: 4, z: 12, yaw: 0 },
      { x: -8, z: 12, yaw: 0 }, { x: 8, z: 12, yaw: 0 }, { x: 0, z: 11, yaw: 0 },
    ],
    CT: [
      { x: -4, z: -12, yaw: Math.PI }, { x: 0, z: -13, yaw: Math.PI }, { x: 4, z: -12, yaw: Math.PI },
      { x: -8, z: -12, yaw: Math.PI }, { x: 8, z: -12, yaw: Math.PI }, { x: 0, z: -11, yaw: Math.PI },
    ],
  },
  deco: [
    { kind: 'pipe', count: 8, x0: -14, z0: -14, x1: 14, z1: 14, minSpacing: 4 },
    { kind: 'barrel', count: 6, x0: -14, z0: -14, x1: 14, z1: 14, minSpacing: 4 },
  ],
};
