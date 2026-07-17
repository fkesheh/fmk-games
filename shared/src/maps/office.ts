// PLACEHOLDER — replaced by task M2 with a full-quality office map
// (see CONTRACT.md "Map specs"). Must keep: id, enclosure, spawns, invariants.
import { PALETTE } from '../palette.js';
import type { MapDef } from './types.js';

const W = 40;
const D = 32;

export const office: MapDef = {
  id: 'office',
  name: 'Office',
  sizeX: W,
  sizeZ: D,
  floorMat: 'carpet',
  theme: {
    sky: PALETTE.skyIndoor,
    horizon: PALETTE.charcoal,
    ground: PALETTE.carpet,
    fog: PALETTE.charcoal,
    fogDensity: 0.012,
    sunDir: [0.3, -1, 0.2],
    sunColor: PALETTE.paper,
    sunIntensity: 1.0,
    hemiIntensity: 0.7,
  },
  boxes: [
    { x: 0, y: 1.75, z: -D / 2, w: W + 2, h: 3.5, d: 1, mat: 'plaster' },
    { x: 0, y: 1.75, z: D / 2, w: W + 2, h: 3.5, d: 1, mat: 'plaster' },
    { x: -W / 2, y: 1.75, z: 0, w: 1, h: 3.5, d: D + 2, mat: 'plaster' },
    { x: W / 2, y: 1.75, z: 0, w: 1, h: 3.5, d: D + 2, mat: 'plaster' },
    // ceiling
    { x: 0, y: 3.6, z: 0, w: W + 2, h: 0.3, d: D + 2, mat: 'concreteDark' },
    // desk rows
    { x: -8, y: 0.45, z: 0, w: 6, h: 0.9, d: 1.4, mat: 'desk' },
    { x: 8, y: 0.45, z: 0, w: 6, h: 0.9, d: 1.4, mat: 'desk' },
    { x: -8, y: 0.45, z: -8, w: 6, h: 0.9, d: 1.4, mat: 'desk' },
    { x: 8, y: 0.45, z: 8, w: 6, h: 0.9, d: 1.4, mat: 'desk' },
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
    { kind: 'paperStack', count: 10, x0: -18, z0: -14, x1: 18, z1: 14, minSpacing: 3 },
    { kind: 'plant', count: 6, x0: -18, z0: -14, x1: 18, z1: 14, minSpacing: 5 },
  ],
};
