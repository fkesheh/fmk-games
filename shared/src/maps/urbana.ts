// PLACEHOLDER — replaced by task M4 with a full-quality town map
// (see CONTRACT.md "Map specs"). Must keep: id, enclosure, spawns, invariants.
import { PALETTE } from '../palette.js';
import type { MapDef } from './types.js';

const W = 56;
const D = 44;

export const urbana: MapDef = {
  id: 'urbana',
  name: 'Urbana',
  sizeX: W,
  sizeZ: D,
  floorMat: 'concrete',
  theme: {
    sky: PALETTE.skyDay,
    horizon: PALETTE.plaster,
    ground: PALETTE.concreteDark,
    fog: PALETTE.fogDay,
    fogDensity: 0.006,
    sunDir: [0.45, -1, 0.3],
    sunColor: PALETTE.paper,
    sunIntensity: 1.7,
    hemiIntensity: 0.5,
  },
  boxes: [
    { x: 0, y: 2.5, z: -D / 2, w: W + 2, h: 5, d: 1, mat: 'brick' },
    { x: 0, y: 2.5, z: D / 2, w: W + 2, h: 5, d: 1, mat: 'brick' },
    { x: -W / 2, y: 2.5, z: 0, w: 1, h: 5, d: D + 2, mat: 'brick' },
    { x: W / 2, y: 2.5, z: 0, w: 1, h: 5, d: D + 2, mat: 'brick' },
    // buildings forming a central street
    { x: -10, y: 2.5, z: -6, w: 8, h: 5, d: 10, mat: 'plaster' },
    { x: 10, y: 2.5, z: 6, w: 8, h: 5, d: 10, mat: 'plaster' },
    { x: -10, y: 2.5, z: 12, w: 8, h: 5, d: 6, mat: 'brick' },
    { x: 10, y: 2.5, z: -12, w: 8, h: 5, d: 6, mat: 'brick' },
    { x: 0, y: 0.6, z: 0, w: 1.4, h: 1.2, d: 1.4, mat: 'crate' },
  ],
  spawns: {
    T: [
      { x: -6, z: 18, yaw: 0 }, { x: -2, z: 19, yaw: 0 }, { x: 2, z: 19, yaw: 0 },
      { x: 6, z: 18, yaw: 0 }, { x: 0, z: 16.5, yaw: 0 }, { x: -4, z: 17, yaw: 0 },
    ],
    CT: [
      { x: -6, z: -18, yaw: Math.PI }, { x: -2, z: -19, yaw: Math.PI }, { x: 2, z: -19, yaw: Math.PI },
      { x: 6, z: -18, yaw: Math.PI }, { x: 0, z: -16.5, yaw: Math.PI }, { x: 4, z: -17, yaw: Math.PI },
    ],
  },
  deco: [
    { kind: 'barrel', count: 6, x0: -26, z0: -20, x1: 26, z1: 20, minSpacing: 6 },
    { kind: 'shrub', count: 10, x0: -26, z0: -20, x1: 26, z1: 20, minSpacing: 5 },
  ],
};
