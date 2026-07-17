// PLACEHOLDER — replaced by task M1 with a full-quality industrial map
// (see CONTRACT.md "Map specs"). Must keep: id, enclosure, spawns, invariants.
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
    sky: PALETTE.skyDay,
    horizon: PALETTE.fogDay,
    ground: PALETTE.concreteDark,
    fog: PALETTE.fogDay,
    fogDensity: 0.007,
    sunDir: [0.4, -1, 0.25],
    sunColor: PALETTE.paper,
    sunIntensity: 1.4,
    hemiIntensity: 0.5,
  },
  boxes: [
    { x: 0, y: 2.5, z: -D / 2, w: W + 2, h: 5, d: 1, mat: 'concreteDark' },
    { x: 0, y: 2.5, z: D / 2, w: W + 2, h: 5, d: 1, mat: 'concreteDark' },
    { x: -W / 2, y: 2.5, z: 0, w: 1, h: 5, d: D + 2, mat: 'concreteDark' },
    { x: W / 2, y: 2.5, z: 0, w: 1, h: 5, d: D + 2, mat: 'concreteDark' },
    { x: -8, y: 1.5, z: 0, w: 10, h: 3, d: 2, mat: 'metal' },
    { x: 8, y: 1.5, z: 0, w: 10, h: 3, d: 2, mat: 'metal' },
    { x: 0, y: 0.6, z: 8, w: 1.2, h: 1.2, d: 1.2, mat: 'crate' },
    { x: 0, y: 0.6, z: -8, w: 1.2, h: 1.2, d: 1.2, mat: 'crate' },
    { x: -18, y: 0.6, z: 0, w: 1.2, h: 1.2, d: 1.2, mat: 'crate' },
    { x: 18, y: 0.6, z: 0, w: 1.2, h: 1.2, d: 1.2, mat: 'crate' },
  ],
  spawns: {
    T: [
      { x: -6, z: 16, yaw: 0 }, { x: -2, z: 17, yaw: 0 }, { x: 2, z: 17, yaw: 0 },
      { x: 6, z: 16, yaw: 0 }, { x: 0, z: 15, yaw: 0 }, { x: -4, z: 15, yaw: 0 },
    ],
    CT: [
      { x: -6, z: -16, yaw: Math.PI }, { x: -2, z: -17, yaw: Math.PI }, { x: 2, z: -17, yaw: Math.PI },
      { x: 6, z: -16, yaw: Math.PI }, { x: 0, z: -15, yaw: Math.PI }, { x: 4, z: -15, yaw: Math.PI },
    ],
  },
  deco: [
    { kind: 'barrel', count: 8, x0: -26, z0: -18, x1: 26, z1: 18, minSpacing: 5 },
    { kind: 'pallet', count: 6, x0: -26, z0: -18, x1: 26, z1: 18, minSpacing: 6 },
  ],
};
