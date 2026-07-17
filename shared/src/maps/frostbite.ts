// PLACEHOLDER — replaced by task M3 with a full-quality snow map
// (see CONTRACT.md "Map specs"). Must keep: id, enclosure, spawns, invariants.
import { PALETTE } from '../palette.js';
import type { MapDef } from './types.js';

const W = 60;
const D = 44;

export const frostbite: MapDef = {
  id: 'frostbite',
  name: 'Frostbite',
  sizeX: W,
  sizeZ: D,
  floorMat: 'snow',
  theme: {
    sky: PALETTE.skyCold,
    horizon: PALETTE.snowShadow,
    ground: PALETTE.snowShadow,
    fog: PALETTE.fogCold,
    fogDensity: 0.01,
    sunDir: [0.3, -1, 0.4],
    sunColor: PALETTE.ice,
    sunIntensity: 1.2,
    hemiIntensity: 0.65,
  },
  boxes: [
    { x: 0, y: 2.5, z: -D / 2, w: W + 2, h: 5, d: 1, mat: 'rock' },
    { x: 0, y: 2.5, z: D / 2, w: W + 2, h: 5, d: 1, mat: 'rock' },
    { x: -W / 2, y: 2.5, z: 0, w: 1, h: 5, d: D + 2, mat: 'rock' },
    { x: W / 2, y: 2.5, z: 0, w: 1, h: 5, d: D + 2, mat: 'rock' },
    { x: -7, y: 1.4, z: 0, w: 8, h: 2.8, d: 2, mat: 'ice' },
    { x: 7, y: 1.4, z: 0, w: 8, h: 2.8, d: 2, mat: 'ice' },
    { x: 0, y: 0.6, z: 9, w: 1.4, h: 1.2, d: 1.4, mat: 'rock' },
    { x: 0, y: 0.6, z: -9, w: 1.4, h: 1.2, d: 1.4, mat: 'rock' },
    { x: -20, y: 0.9, z: -6, w: 2, h: 1.8, d: 2, mat: 'rock' },
    { x: 20, y: 0.9, z: 6, w: 2, h: 1.8, d: 2, mat: 'rock' },
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
    { kind: 'snowRock', count: 12, x0: -28, z0: -20, x1: 28, z1: 20, minSpacing: 5 },
    { kind: 'shrub', count: 8, x0: -28, z0: -20, x1: 28, z1: 20, minSpacing: 6 },
  ],
};
