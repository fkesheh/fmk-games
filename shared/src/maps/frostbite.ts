// Map: FROSTBITE (task M3) — snowfield. Playability invariants (checked by reviewers):
//   - enclosed by h=5 rock walls with no gaps
//   - 3 lanes from T spawn (south) to CT spawn (north): west / mid / east, linked by
//     two gaps per ice-ridge divider (south gap z 8..12, frozen creek z -9.2..-0.8)
//   - frozen creek gully: 0.6-deep trench (snow banks) with ice floor; crossed by
//     jumping the banks or via 0.4 step boxes at x = -21 / -6 / 6 / 21
//   - no T spawn visible from any CT spawn (twin ice screens at z=+-15 block all pairs)
//   - cover (h>=0.9) at least every 8m along each lane; longest open sightline <= 37m
//   - 7 spawns per team, all on y=0 ground, none inside boxes
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
    // ---- outer walls (h=5, valley rock) ----
    { x: 0, y: 2.5, z: -D / 2, w: W + 2, h: 5, d: 1, mat: 'rock' },
    { x: 0, y: 2.5, z: D / 2, w: W + 2, h: 5, d: 1, mat: 'rock' },
    { x: -W / 2, y: 2.5, z: 0, w: 1, h: 5, d: D + 2, mat: 'rock' },
    { x: W / 2, y: 2.5, z: 0, w: 1, h: 5, d: D + 2, mat: 'rock' },

    // ---- ice-ridge lane dividers (x=+-12; gaps: creek z -9.2..-0.8, south z 8..12) ----
    { x: -12, y: 1.2, z: -12.1, w: 2.5, h: 2.4, d: 5.8, mat: 'ice' },
    { x: -12, y: 1.2, z: 3.6, w: 2.5, h: 2.4, d: 8.8, mat: 'ice' },
    { x: -12, y: 1.2, z: 14, w: 2.5, h: 2.4, d: 4, mat: 'ice' },
    { x: 12, y: 1.2, z: -12.1, w: 2.5, h: 2.4, d: 5.8, mat: 'ice' },
    { x: 12, y: 1.2, z: 3.6, w: 2.5, h: 2.4, d: 8.8, mat: 'ice' },
    { x: 12, y: 1.2, z: 14, w: 2.5, h: 2.4, d: 4, mat: 'ice' },

    // ice spikes guarding the south gap mouths (also break the x=+-14.5 sightlines)
    { x: -14.5, y: 1.3, z: 10, w: 2.5, h: 2.6, d: 2, mat: 'ice' },
    { x: 14.5, y: 1.3, z: 10, w: 2.5, h: 2.6, d: 2, mat: 'ice' },

    // ---- spawn screen ice ridges (block every T<->CT spawn sightline) ----
    { x: 0, y: 1.5, z: 15, w: 18, h: 3, d: 1.5, mat: 'ice' },
    { x: 0, y: 1.5, z: -15, w: 18, h: 3, d: 1.5, mat: 'ice' },

    // ---- quadrant rock clusters (lane screens + diagonal sightline breakers) ----
    { x: -20, y: 1.25, z: 15, w: 10.5, h: 2.5, d: 2.5, mat: 'rock' },
    { x: 20, y: 1.25, z: 15, w: 10.5, h: 2.5, d: 2.5, mat: 'rock' },
    { x: -20, y: 1.25, z: -15, w: 10.5, h: 2.5, d: 2.5, mat: 'rock' },
    { x: 20, y: 1.25, z: -15, w: 10.5, h: 2.5, d: 2.5, mat: 'rock' },
    // corner formations sealing the spawn strips (merge with the screens above)
    { x: -20, y: 1.25, z: 18.5, w: 3, h: 2.5, d: 6, mat: 'rock' },
    { x: 20, y: 1.25, z: 18.5, w: 3, h: 2.5, d: 6, mat: 'rock' },
    { x: -20, y: 1.25, z: -18.5, w: 3, h: 2.5, d: 6, mat: 'rock' },
    { x: 20, y: 1.25, z: -18.5, w: 3, h: 2.5, d: 6, mat: 'rock' },

    // ---- frozen creek gully (channel z -8..-2, floor 0.6 below bank tops) ----
    { x: 0, y: 0.03, z: -5, w: 58, h: 0.06, d: 6, mat: 'ice' }, // ice floor
    { x: 0, y: 0.3, z: -1.4, w: 58, h: 0.6, d: 1.2, mat: 'snow' }, // south bank
    { x: 0, y: 0.3, z: -8.6, w: 58, h: 0.6, d: 1.2, mat: 'snow' }, // north bank
    { x: 0, y: 1, z: -5, w: 3, h: 2, d: 8.8, mat: 'rock' }, // dam rock jammed mid creek
    { x: -17.5, y: 1, z: -5, w: 2.5, h: 2, d: 3, mat: 'rock' }, // creek boulders
    { x: 17.5, y: 1, z: -5, w: 2.5, h: 2, d: 3, mat: 'rock' },
    { x: -27.5, y: 1.1, z: -2, w: 4, h: 2.2, d: 3, mat: 'rock' }, // creek-mouth rocks
    { x: 27.5, y: 1.1, z: -2, w: 4, h: 2.2, d: 3, mat: 'rock' },
    // step crossings (ground -> 0.4 step -> 0.6 bank): south side + inside creek
    { x: -21, y: 0.2, z: -0.3, w: 2.4, h: 0.4, d: 1, mat: 'snow' },
    { x: -21, y: 0.2, z: -7.5, w: 2.4, h: 0.4, d: 1, mat: 'ice' },
    { x: -6, y: 0.2, z: -0.3, w: 2.4, h: 0.4, d: 1, mat: 'snow' },
    { x: -6, y: 0.2, z: -7.5, w: 2.4, h: 0.4, d: 1, mat: 'ice' },
    { x: 6, y: 0.2, z: -0.3, w: 2.4, h: 0.4, d: 1, mat: 'snow' },
    { x: 6, y: 0.2, z: -7.5, w: 2.4, h: 0.4, d: 1, mat: 'ice' },
    { x: 21, y: 0.2, z: -0.3, w: 2.4, h: 0.4, d: 1, mat: 'snow' },
    { x: 21, y: 0.2, z: -7.5, w: 2.4, h: 0.4, d: 1, mat: 'ice' },

    // ---- mid lane cover ----
    { x: 0, y: 1.1, z: 3, w: 4, h: 2.2, d: 3, mat: 'ice' }, // central ice block
    { x: 0, y: 1.1, z: 10, w: 3, h: 2.2, d: 4.5, mat: 'ice' }, // gap-mouth block
    { x: -5, y: 0.95, z: 6, w: 2.5, h: 1.9, d: 2.5, mat: 'ice' },
    { x: 5, y: 0.95, z: 6, w: 2.5, h: 1.9, d: 2.5, mat: 'ice' },
    { x: -5, y: 0.95, z: -11, w: 2.5, h: 1.9, d: 3, mat: 'ice' },
    { x: 5, y: 0.95, z: -11, w: 2.5, h: 1.9, d: 3, mat: 'ice' },
    { x: -9.5, y: 1, z: 0.2, w: 2.5, h: 2, d: 2.5, mat: 'ice' }, // bank-side blocks
    { x: 9.5, y: 1, z: 0.2, w: 2.5, h: 2, d: 2.5, mat: 'ice' },

    // ---- west lane cover (rock cluster + snowdrifts) ----
    { x: -24, y: 1, z: 2.5, w: 3, h: 2, d: 2.5, mat: 'rock' },
    { x: -25.5, y: 0.6, z: 4.2, w: 1.6, h: 1.2, d: 1.6, mat: 'rock' },
    { x: -24, y: 0.45, z: 8, w: 4, h: 0.9, d: 2, mat: 'snow' },
    { x: -17, y: 0.45, z: 4, w: 3.5, h: 0.9, d: 2, mat: 'snow' },
    { x: -24, y: 0.45, z: -12, w: 4, h: 0.9, d: 2, mat: 'snow' },
    { x: -17, y: 0.45, z: -11, w: 3.5, h: 0.9, d: 2, mat: 'snow' },

    // ---- east lane cover (mirror of west) ----
    { x: 24, y: 1, z: 2.5, w: 3, h: 2, d: 2.5, mat: 'rock' },
    { x: 25.5, y: 0.6, z: 4.2, w: 1.6, h: 1.2, d: 1.6, mat: 'rock' },
    { x: 24, y: 0.45, z: 8, w: 4, h: 0.9, d: 2, mat: 'snow' },
    { x: 17, y: 0.45, z: 4, w: 3.5, h: 0.9, d: 2, mat: 'snow' },
    { x: 24, y: 0.45, z: -12, w: 4, h: 0.9, d: 2, mat: 'snow' },
    { x: 17, y: 0.45, z: -11, w: 3.5, h: 0.9, d: 2, mat: 'snow' },

    // ---- spawn courtyard cover ----
    { x: 3.5, y: 0.5, z: 16.9, w: 3, h: 1, d: 1.4, mat: 'snow' },
    { x: -3.5, y: 0.5, z: -16.9, w: 3, h: 1, d: 1.4, mat: 'snow' },
  ],
  spawns: {
    T: [
      { x: -6, z: 20, yaw: 0 },
      { x: -3, z: 20.4, yaw: 0 },
      { x: 0, z: 20, yaw: 0 },
      { x: 3, z: 20.4, yaw: 0 },
      { x: 6, z: 20, yaw: 0 },
      { x: -1.5, z: 18.6, yaw: 0 },
      { x: 1.5, z: 18.6, yaw: 0 },
    ],
    CT: [
      { x: -6, z: -20, yaw: Math.PI },
      { x: -3, z: -20.4, yaw: Math.PI },
      { x: 0, z: -20, yaw: Math.PI },
      { x: 3, z: -20.4, yaw: Math.PI },
      { x: 6, z: -20, yaw: Math.PI },
      { x: -1.5, z: -18.6, yaw: Math.PI },
      { x: 1.5, z: -18.6, yaw: Math.PI },
    ],
  },
  deco: [
    { kind: 'snowRock', count: 16, x0: -29, z0: -21, x1: -14, z1: 21, minSpacing: 4.5 },
    { kind: 'snowRock', count: 16, x0: 14, z0: -21, x1: 29, z1: 21, minSpacing: 4.5 },
    { kind: 'snowRock', count: 10, x0: -13, z0: -21, x1: 13, z1: 21, minSpacing: 5 },
    { kind: 'shrub', count: 32, x0: -29, z0: -21, x1: 29, z1: 21, minSpacing: 3.5 },
  ],
};
