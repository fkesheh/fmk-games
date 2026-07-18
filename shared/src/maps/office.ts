// ============================================================================
// OFFICE — indoor office floor (task M2). Full map, replaces placeholder.
// Invariants (see CONTRACT.md "Map specs"):
//   - enclosed: outer walls h=3.5, ceiling slab at y=3.2, no gaps
//   - routes: west + east ring corridors (jog slalom), two meeting-room
//     crossings through the core band, plus the full corridor ring loop
//   - no T spawn visible from any CT spawn: the core band (rooms, h=3.2)
//     spans |x|<=13.4; every spawn pair crosses it inside the wall span or
//     hits an archive bank (h=2.2); meeting-room door pairs are staggered
//     so threading both needs a spawn at |x|>16 (none exist)
//   - longest open sightline <= 25m (verified by sweep): corridors are cut
//     into <=8m segments by staggered jogs; archive banks seal the side
//     strips; storage spines split the open floors (the north spine also
//     covers the NW pocket); an SE corner copier plugs the bank-corner
//     pocket diagonal; longest free run ~24m
//   - cover (h>=0.9) at least every 8m along each route: jogs/cabinets on
//     corridors (corner copiers close the SW/NE ring corners), partitions
//     (1.1), desks/credenzas (0.9) in the open floor
//   - corridors/doors >= 1.4m (doors 1.8, slalom gaps 1.45+); >= 6
//     spawns/team, all on y=0, clear of boxes
// ============================================================================
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
    // interior gloom: the ceiling slab shadow-casts over the whole floor, so
    // the sun lights ~nothing — the hemisphere IS the light. Steel sky reads
    // as cool fluorescent fill; concrete-tinted ground bounce; fog stays
    // charcoal so the gloom survives once lit.
    sky: PALETTE.steel,
    horizon: PALETTE.charcoal,
    ground: PALETTE.concrete,
    fog: PALETTE.charcoal,
    fogDensity: 0.012,
    sunDir: [0.3, -1, 0.2],
    sunColor: PALETTE.paper,
    sunIntensity: 1.0,
    hemiIntensity: 1.5,
  },
  boxes: [
    // ---- outer walls (h=3.5, plaster) ----
    { x: 0, y: 1.75, z: -D / 2, w: W + 2, h: 3.5, d: 1, mat: 'plaster' },
    { x: 0, y: 1.75, z: D / 2, w: W + 2, h: 3.5, d: 1, mat: 'plaster' },
    { x: -W / 2, y: 1.75, z: 0, w: 1, h: 3.5, d: D + 2, mat: 'plaster' },
    { x: W / 2, y: 1.75, z: 0, w: 1, h: 3.5, d: D + 2, mat: 'plaster' },

    // ---- ceiling slab (thin, y=3.2) ----
    { x: 0, y: 3.2, z: 0, w: W + 2, h: 0.3, d: D + 2, mat: 'concreteDark' },

    // ---- core band z in [-2.9,2.9]: meeting W | server | meeting E ----
    // meeting room W (x in [-13,-4.5]): S door x[-12.1,-10.3], N door x[-7.3,-5.5]
    { x: -13, y: 1.6, z: 0, w: 0.8, h: 3.2, d: 5.8, mat: 'plaster' },
    { x: -4.5, y: 1.6, z: 0, w: 0.8, h: 3.2, d: 5.8, mat: 'plaster' },
    { x: -12.55, y: 1.6, z: 2.5, w: 0.9, h: 3.2, d: 0.8, mat: 'plaster' },
    { x: -7.4, y: 1.6, z: 2.5, w: 6.2, h: 3.2, d: 0.8, mat: 'plaster' },
    { x: -10.15, y: 1.6, z: -2.5, w: 5.7, h: 3.2, d: 0.8, mat: 'plaster' },
    { x: -5, y: 1.6, z: -2.5, w: 1, h: 3.2, d: 0.8, mat: 'plaster' },
    { x: -8.75, y: 0.4, z: 0, w: 3.2, h: 0.8, d: 1.2, mat: 'desk' },
    { x: -9.5, y: 0.86, z: 0.2, w: 0.6, h: 0.12, d: 0.45, mat: 'paper' },

    // meeting room E (x in [4.5,13]): S door x[10.3,12.1], N door x[5.5,7.3]
    { x: 4.5, y: 1.6, z: 0, w: 0.8, h: 3.2, d: 5.8, mat: 'plaster' },
    { x: 13, y: 1.6, z: 0, w: 0.8, h: 3.2, d: 5.8, mat: 'plaster' },
    { x: 7.4, y: 1.6, z: 2.5, w: 5.8, h: 3.2, d: 0.8, mat: 'plaster' },
    { x: 12.55, y: 1.6, z: 2.5, w: 0.9, h: 3.2, d: 0.8, mat: 'plaster' },
    { x: 5, y: 1.6, z: -2.5, w: 1, h: 3.2, d: 0.8, mat: 'plaster' },
    { x: 10.15, y: 1.6, z: -2.5, w: 5.7, h: 3.2, d: 0.8, mat: 'plaster' },
    { x: 8.75, y: 0.4, z: 0, w: 3.2, h: 0.8, d: 1.2, mat: 'desk' },
    { x: 9.5, y: 0.86, z: 0.2, w: 0.6, h: 0.12, d: 0.45, mat: 'paper' },

    // server room (x in [-4.5,4.5]): solid S wall, N door x[-0.9,0.9]
    { x: 0, y: 1.6, z: 2.5, w: 9, h: 3.2, d: 0.8, mat: 'plaster' },
    { x: -2.7, y: 1.6, z: -2.5, w: 3.6, h: 3.2, d: 0.8, mat: 'plaster' },
    { x: 2.7, y: 1.6, z: -2.5, w: 3.6, h: 3.2, d: 0.8, mat: 'plaster' },
    // metal rack rows (h=2.2, 1.5m aisles)
    { x: -2.5, y: 1.1, z: 0.2, w: 1, h: 2.2, d: 3.6, mat: 'metal' },
    { x: 0, y: 1.1, z: 0.7, w: 1, h: 2.2, d: 2.6, mat: 'metal' },
    { x: 2.5, y: 1.1, z: 0.2, w: 1, h: 2.2, d: 3.6, mat: 'metal' },

    // credenzas along the band faces (h=0.9 cover on the mid lanes, doors clear)
    { x: -9.3, y: 0.45, z: -3.6, w: 2.4, h: 0.9, d: 0.6, mat: 'desk' },
    { x: -2.6, y: 0.45, z: -3.6, w: 2.5, h: 0.9, d: 0.6, mat: 'desk' },
    { x: 9.3, y: 0.45, z: -3.6, w: 2.4, h: 0.9, d: 0.6, mat: 'desk' },
    { x: -8.9, y: 0.45, z: 3.6, w: 2.4, h: 0.9, d: 0.6, mat: 'desk' },
    { x: -0.2, y: 0.45, z: 3.6, w: 2.5, h: 0.9, d: 0.6, mat: 'desk' },
    { x: 8.5, y: 0.45, z: 3.6, w: 2.4, h: 0.9, d: 0.6, mat: 'desk' },

    // ---- ring corridor jogs (h=3.2; slalom gaps 1.45+, alternating sides;
    //      z=+-8 jogs overlap the bank faces so no crack threads the corridor) ----
    // west corridor x in [-19.5,-16.5]
    { x: -17.25, y: 1.6, z: -8, w: 1.6, h: 3.2, d: 0.8, mat: 'plaster' },
    { x: -18.8, y: 1.6, z: 0, w: 1.4, h: 3.2, d: 0.8, mat: 'plaster' },
    { x: -17.25, y: 1.6, z: 8, w: 1.6, h: 3.2, d: 0.8, mat: 'plaster' },
    // east corridor x in [16.5,19.5]
    { x: 17.25, y: 1.6, z: -8, w: 1.6, h: 3.2, d: 0.8, mat: 'plaster' },
    { x: 18.8, y: 1.6, z: 0, w: 1.4, h: 3.2, d: 0.8, mat: 'plaster' },
    { x: 17.25, y: 1.6, z: 8, w: 1.6, h: 3.2, d: 0.8, mat: 'plaster' },
    // corner copiers (h=2.2): cover in the SW/NE ring corners (the bank ends
    // already cover NW/SE); corridor keeps 2.0m clearance
    { x: -19, y: 1.1, z: 11.5, w: 1, h: 2.2, d: 2, mat: 'metal' },
    { x: 19, y: 1.1, z: -11.5, w: 1, h: 2.2, d: 2, mat: 'metal' },

    // ---- archive banks (h=2.2) sealing the side strips between corridor
    //      edge and band; 1.6m gaps at one end keep the ring connected ----
    { x: -14.95, y: 1.1, z: -2.95, w: 3.1, h: 2.2, d: 21.9, mat: 'metal' },
    { x: 14.95, y: 1.1, z: 2.95, w: 3.1, h: 2.2, d: 21.9, mat: 'metal' },

    // ---- north open floor (CT): cubicle grid z in [-13.1,-2.5] ----
    // partition rows (h=1.1 chest cover; 5 segments, 1.6m gaps) at z=-11.6/-8.7/-5.8
    { x: -11.2, y: 0.55, z: -11.6, w: 4, h: 1.1, d: 0.2, mat: 'plaster' },
    { x: -5.6, y: 0.55, z: -11.6, w: 4, h: 1.1, d: 0.2, mat: 'plaster' },
    { x: 0, y: 0.55, z: -11.6, w: 4, h: 1.1, d: 0.2, mat: 'plaster' },
    { x: 5.6, y: 0.55, z: -11.6, w: 4, h: 1.1, d: 0.2, mat: 'plaster' },
    { x: 11.2, y: 0.55, z: -11.6, w: 4, h: 1.1, d: 0.2, mat: 'plaster' },
    { x: -11.2, y: 0.55, z: -8.7, w: 4, h: 1.1, d: 0.2, mat: 'plaster' },
    { x: -5.6, y: 0.55, z: -8.7, w: 4, h: 1.1, d: 0.2, mat: 'plaster' },
    { x: 0, y: 0.55, z: -8.7, w: 4, h: 1.1, d: 0.2, mat: 'plaster' },
    { x: 5.6, y: 0.55, z: -8.7, w: 4, h: 1.1, d: 0.2, mat: 'plaster' },
    { x: 11.2, y: 0.55, z: -8.7, w: 4, h: 1.1, d: 0.2, mat: 'plaster' },
    { x: -11.2, y: 0.55, z: -5.8, w: 4, h: 1.1, d: 0.2, mat: 'plaster' },
    { x: -5.6, y: 0.55, z: -5.8, w: 4, h: 1.1, d: 0.2, mat: 'plaster' },
    { x: 0, y: 0.55, z: -5.8, w: 4, h: 1.1, d: 0.2, mat: 'plaster' },
    { x: 5.6, y: 0.55, z: -5.8, w: 4, h: 1.1, d: 0.2, mat: 'plaster' },
    { x: 11.2, y: 0.55, z: -5.8, w: 4, h: 1.1, d: 0.2, mat: 'plaster' },
    // desk rows (h=0.9) at z=-10.3/-7.4, aligned under partition segments
    { x: -11.2, y: 0.45, z: -10.3, w: 3.6, h: 0.9, d: 0.9, mat: 'desk' },
    { x: -5.6, y: 0.45, z: -10.3, w: 3.6, h: 0.9, d: 0.9, mat: 'desk' },
    { x: 0, y: 0.45, z: -10.3, w: 3.6, h: 0.9, d: 0.9, mat: 'desk' },
    { x: 5.6, y: 0.45, z: -10.3, w: 3.6, h: 0.9, d: 0.9, mat: 'desk' },
    { x: 11.2, y: 0.45, z: -10.3, w: 3.6, h: 0.9, d: 0.9, mat: 'desk' },
    { x: -11.2, y: 0.45, z: -7.4, w: 3.6, h: 0.9, d: 0.9, mat: 'desk' },
    { x: -5.6, y: 0.45, z: -7.4, w: 3.6, h: 0.9, d: 0.9, mat: 'desk' },
    { x: 0, y: 0.45, z: -7.4, w: 3.6, h: 0.9, d: 0.9, mat: 'desk' },
    { x: 5.6, y: 0.45, z: -7.4, w: 3.6, h: 0.9, d: 0.9, mat: 'desk' },
    { x: 11.2, y: 0.45, z: -7.4, w: 3.6, h: 0.9, d: 0.9, mat: 'desk' },
    // copier cabinets along the north wall (h=2.2, cover + sight breaks;
    // middle one offset west of the storage spine so no <1.4m L-gap forms)
    { x: -8, y: 1.1, z: -14.7, w: 2, h: 2.2, d: 1.6, mat: 'metal' },
    { x: -1.5, y: 1.1, z: -14.7, w: 2, h: 2.2, d: 1.6, mat: 'metal' },
    { x: 8, y: 1.1, z: -14.7, w: 2, h: 2.2, d: 1.6, mat: 'metal' },
    // storage spine threading a partition gap (h=2.2, full depth; guards both
    // meeting-room N doors from long farm sightlines)
    { x: 2.8, y: 1.1, z: -8.4, w: 1.5, h: 2.2, d: 11, mat: 'metal' },

    // ---- south open floor (T): bullpen desk rows z in [2.5,13.1] ----
    // desk rows (h=0.9) at z=6.5/10.5, clear of the spine and banks
    { x: -10.6, y: 0.45, z: 6.5, w: 5.4, h: 0.9, d: 1.2, mat: 'desk' },
    { x: -3.5, y: 0.45, z: 6.5, w: 5.4, h: 0.9, d: 1.2, mat: 'desk' },
    { x: 3.8, y: 0.45, z: 6.5, w: 5.4, h: 0.9, d: 1.2, mat: 'desk' },
    { x: 9.6, y: 0.45, z: 6.5, w: 5.4, h: 0.9, d: 1.2, mat: 'desk' },
    { x: -10.6, y: 0.45, z: 10.5, w: 5.4, h: 0.9, d: 1.2, mat: 'desk' },
    { x: -3.5, y: 0.45, z: 10.5, w: 5.4, h: 0.9, d: 1.2, mat: 'desk' },
    { x: 3.8, y: 0.45, z: 10.5, w: 5.4, h: 0.9, d: 1.2, mat: 'desk' },
    { x: 9.6, y: 0.45, z: 10.5, w: 5.4, h: 0.9, d: 1.2, mat: 'desk' },
    // planters (h=0.9 cover) between the desk rows
    { x: -11, y: 0.45, z: 8.5, w: 2, h: 0.9, d: 1, mat: 'plaster' },
    { x: 11, y: 0.45, z: 8.5, w: 2, h: 0.9, d: 1, mat: 'plaster' },
    // copier cabinets along the south wall (west one offset clear of the spine)
    { x: -10.5, y: 1.1, z: 14.7, w: 2, h: 2.2, d: 1.6, mat: 'metal' },
    { x: 0, y: 1.1, z: 14.7, w: 2, h: 2.2, d: 1.6, mat: 'metal' },
    { x: 8, y: 1.1, z: 14.7, w: 2, h: 2.2, d: 1.6, mat: 'metal' },
    // tall storage cabinet merging with the x=8 copier row: blocks the ENE
    // rays from the south floor (the ~26m diagonal past the bank's SE corner)
    // while keeping the SE window x[10.5,16.5] open for the ring route
    { x: 9.5, y: 1.1, z: 13.7, w: 2, h: 2.2, d: 3.6, mat: 'metal' },
    // storage spine (mirror of the north one, 180-degree rotational layout)
    { x: -7, y: 1.1, z: 8.4, w: 1.5, h: 2.2, d: 11, mat: 'metal' },
  ],
  spawns: {
    // south side, facing north; clear of cabinets/spine/desks
    T: [
      { x: 11.5, z: 13.8, yaw: 0 },
      { x: 4, z: 14.5, yaw: 0 },
      { x: -3, z: 14.5, yaw: 0 },
      { x: -13.5, z: 14.5, yaw: 0 },
      { x: 17.5, z: 13.2, yaw: 0 },
      { x: -16, z: 13.2, yaw: 0 },
      { x: 0, z: 12.6, yaw: 0 },
    ],
    // north side, facing south
    CT: [
      { x: -11, z: -14.5, yaw: Math.PI },
      { x: -4, z: -14.5, yaw: Math.PI },
      { x: 4.5, z: -14.5, yaw: Math.PI },
      { x: 11, z: -14.5, yaw: Math.PI },
      { x: -17.5, z: -13.2, yaw: Math.PI },
      { x: 16, z: -13.2, yaw: Math.PI },
      { x: 0, z: -12.6, yaw: Math.PI },
    ],
  },
  deco: [
    // paperStacks clutter the work floors; plants dress the ring + rooms
    { kind: 'paperStack', count: 22, x0: -16, z0: -13, x1: 16, z1: -3.5, minSpacing: 2 },
    { kind: 'paperStack', count: 18, x0: -16, z0: 3.5, x1: 16, z1: 13, minSpacing: 2 },
    { kind: 'plant', count: 6, x0: -19, z0: -15, x1: -17, z1: 15, minSpacing: 4 },
    { kind: 'plant', count: 6, x0: 17, z0: -15, x1: 19, z1: 15, minSpacing: 4 },
    { kind: 'plant', count: 5, x0: -16, z0: -15, x1: 16, z1: -13.6, minSpacing: 5 },
    { kind: 'plant', count: 5, x0: -16, z0: 13.6, x1: 16, z1: 15, minSpacing: 5 },
    { kind: 'plant', count: 6, x0: -13, z0: -2.5, x1: 13, z1: 2.5, minSpacing: 3 },
  ],
};
