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
    // Interior gloom: the ceiling slab shadow-casts over the whole floor, so
    // the sun lights ~nothing — the hemisphere IS the light (§3a "screens are
    // the only saturated light source"). Steel sky = cool fluorescent fill.
    //
    // VALUE LADDER (VISUAL_UPGRADE.md §1):
    //   L1  plaster L83.5 - carpet L28.9 = 54.6 >= 20            (carpet is the
    //       darkest large surface; nothing on the floor is lighter than a wall)
    //   L4  hueDistance(carpet 215deg, plaster 38deg) = 177 >= 25 (cool blue-grey
    //       carpet against warm plaster — the map's whole hue story)
    //   S1  horizon tarmacDeep L21.1 - skyHigh skyIndoorHigh L6.7 = 14.4 >= 12,
    //       and blueBias(skyHigh)=+8 > blueBias(horizon)=+7, so the zenith is
    //       both darker AND cooler. charcoal used to sit here and failed BOTH
    //       halves (9.2 L apart, and warmer-not-cooler at blueBias +12).
    //       tarmacDeep also keeps luminance 0.033 well under the rig's 0.06
    //       indoor-theme threshold, so office still reads as an interior.
    //   S2  fog === horizon exactly.
    //   S4  ground (plasterDeep) !== horizon (tarmacDeep).
    //
    // ground is the hemisphere's DOWN colour (the bounce off the floor plane):
    // plasterDeep holds the old concrete's value (L55.6 vs L58.4 — no
    // brightness change, so readability is untouched) but swings it warm
    // (blueBias -21), giving §3d's free hue split — cool steel from above,
    // warm plaster bounce from below — on every surface for zero cost.
    skyHigh: PALETTE.skyIndoorHigh, // zenith: the dark void above the ceiling
    sky: PALETTE.steel, // mid: cool fluorescent fill (also the rig's indoor key)
    horizon: PALETTE.tarmacDeep, // was charcoal — failed S1 on both L* and hue
    ground: PALETTE.plasterDeep,
    fog: PALETTE.tarmacDeep, // S2: identical to horizon
    fogDensity: 0.014, // nudged up: interior haze now does real depth cueing
    sunDir: [0.3, -1, 0.2],
    sunColor: PALETTE.paper,
    sunIntensity: 1.0,
    hemiIntensity: 1.8, // indoor: the hemisphere IS the light (types.ts: 1.5-2.5)
  },
  boxes: [
    // MATERIAL LADDER (§3a "cool blue-grey carpet <=> warm plaster"). Two wall
    // families read against one dark floor, with every mass on its own rung:
    //   carpet       L28.9  floor (darkest large surface)
    //   concreteDeep L28.6  ceiling slab — a dark lid, so the light plaster
    //                       band between floor and ceiling carries the frame
    //   metalDark    L27.7  server racks (near-black inside the grey core)
    //   concreteDark L46.2  archive banks / storage spines / planters — the
    //                       tall secondary masses; were `metal` L66.6, only
    //                       17 L off the plaster walls (soup)
    //   plasterDeep  L55.6  cubicle partitions — warm, one clear step under
    //                       the walls they belong to; were `plaster` L83.5,
    //                       i.e. fifteen 4m stripes at the SAME value as the
    //                       walls behind them
    //   concrete     L58.4  server-core walls — the grey service shaft split
    //                       out of the white plaster perimeter
    //   desk         L60.8  desks / credenzas (warm tan, hue-split from grey)
    //   metal        L66.6  copiers / cabinets — discrete steel objects, kept
    //                       bright so they still pop as props
    //   plaster      L83.5  perimeter + meeting-room walls (L1 REFERENCE)
    //   paper        L91.3  paperwork highlight
    // No trim/plinth/cornice BoxDefs: `boxes` is the SERVER's collision source
    // (seam rule 2) — articulation is mapRenderer's articulate(), not map data.
    // ---- outer walls (h=3.5, plaster) ----
    { x: 0, y: 1.75, z: -D / 2, w: W + 2, h: 3.5, d: 1, mat: 'plaster' },
    { x: 0, y: 1.75, z: D / 2, w: W + 2, h: 3.5, d: 1, mat: 'plaster' },
    { x: -W / 2, y: 1.75, z: 0, w: 1, h: 3.5, d: D + 2, mat: 'plaster' },
    { x: W / 2, y: 1.75, z: 0, w: 1, h: 3.5, d: D + 2, mat: 'plaster' },

    // ---- ceiling slab (thin, y=3.2) — dark lid, reads as unlit soffit ----
    { x: 0, y: 3.2, z: 0, w: W + 2, h: 0.3, d: D + 2, mat: 'concreteDeep' },

    // ---- core band z in [-2.9,2.9]: meeting W | server | meeting E ----
    // meeting room W (x in [-13,-4.5]): S door x[-12.1,-10.3], N door x[-7.3,-5.5]
    { x: -13, y: 1.6, z: 0, w: 0.8, h: 3.2, d: 5.8, mat: 'plaster' },
    // shared with the server core -> concrete (the grey shaft, not the white ring)
    { x: -4.5, y: 1.6, z: 0, w: 0.8, h: 3.2, d: 5.8, mat: 'concrete' },
    { x: -12.55, y: 1.6, z: 2.5, w: 0.9, h: 3.2, d: 0.8, mat: 'plaster' },
    { x: -7.4, y: 1.6, z: 2.5, w: 6.2, h: 3.2, d: 0.8, mat: 'plaster' },
    { x: -10.15, y: 1.6, z: -2.5, w: 5.7, h: 3.2, d: 0.8, mat: 'plaster' },
    { x: -5, y: 1.6, z: -2.5, w: 1, h: 3.2, d: 0.8, mat: 'plaster' },
    { x: -8.75, y: 0.4, z: 0, w: 3.2, h: 0.8, d: 1.2, mat: 'desk' },
    { x: -9.5, y: 0.86, z: 0.2, w: 0.6, h: 0.12, d: 0.45, mat: 'paper' },

    // meeting room E (x in [4.5,13]): S door x[10.3,12.1], N door x[5.5,7.3]
    { x: 4.5, y: 1.6, z: 0, w: 0.8, h: 3.2, d: 5.8, mat: 'concrete' }, // server-core face
    { x: 13, y: 1.6, z: 0, w: 0.8, h: 3.2, d: 5.8, mat: 'plaster' },
    { x: 7.4, y: 1.6, z: 2.5, w: 5.8, h: 3.2, d: 0.8, mat: 'plaster' },
    { x: 12.55, y: 1.6, z: 2.5, w: 0.9, h: 3.2, d: 0.8, mat: 'plaster' },
    { x: 5, y: 1.6, z: -2.5, w: 1, h: 3.2, d: 0.8, mat: 'plaster' },
    { x: 10.15, y: 1.6, z: -2.5, w: 5.7, h: 3.2, d: 0.8, mat: 'plaster' },
    { x: 8.75, y: 0.4, z: 0, w: 3.2, h: 0.8, d: 1.2, mat: 'desk' },
    { x: 9.5, y: 0.86, z: 0.2, w: 0.6, h: 0.12, d: 0.45, mat: 'paper' },

    // server room (x in [-4.5,4.5]): solid S wall, N door x[-0.9,0.9].
    // concrete shell (L58) reads as the building's service core against the
    // white plaster office ring — a whole second wall family for free.
    { x: 0, y: 1.6, z: 2.5, w: 9, h: 3.2, d: 0.8, mat: 'concrete' },
    { x: -2.7, y: 1.6, z: -2.5, w: 3.6, h: 3.2, d: 0.8, mat: 'concrete' },
    { x: 2.7, y: 1.6, z: -2.5, w: 3.6, h: 3.2, d: 0.8, mat: 'concrete' },
    // rack rows (h=2.2, 1.5m aisles) — metalDark L28 against the L58 shell is
    // the map's hardest local value break, and the racks stop reading as walls
    { x: -2.5, y: 1.1, z: 0.2, w: 1, h: 2.2, d: 3.6, mat: 'metalDark' },
    { x: 0, y: 1.1, z: 0.7, w: 1, h: 2.2, d: 2.6, mat: 'metalDark' },
    { x: 2.5, y: 1.1, z: 0.2, w: 1, h: 2.2, d: 3.6, mat: 'metalDark' },

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
    //      edge and band; 1.6m gaps at one end keep the ring connected.
    //      concreteDark: two 22m masses at L46 give the map its mid-dark tier
    //      (as `metal` L66 they sat 17 L off the plaster walls behind them) ----
    { x: -14.95, y: 1.1, z: -2.95, w: 3.1, h: 2.2, d: 21.9, mat: 'concreteDark' },
    { x: 14.95, y: 1.1, z: 2.95, w: 3.1, h: 2.2, d: 21.9, mat: 'concreteDark' },

    // ---- north open floor (CT): cubicle grid z in [-13.1,-2.5] ----
    // partition rows (h=1.1 chest cover; 5 segments, 1.6m gaps) at z=-11.6/-8.7/-5.8.
    // plasterDeep, not plaster: fifteen 4m screens at the SAME value as the
    // walls behind them was the map's flattest read. L55.6 keeps them in the
    // warm plaster family, 27 L above the carpet and 28 L below the walls.
    { x: -11.2, y: 0.55, z: -11.6, w: 4, h: 1.1, d: 0.2, mat: 'plasterDeep' },
    { x: -5.6, y: 0.55, z: -11.6, w: 4, h: 1.1, d: 0.2, mat: 'plasterDeep' },
    { x: 0, y: 0.55, z: -11.6, w: 4, h: 1.1, d: 0.2, mat: 'plasterDeep' },
    { x: 5.6, y: 0.55, z: -11.6, w: 4, h: 1.1, d: 0.2, mat: 'plasterDeep' },
    { x: 11.2, y: 0.55, z: -11.6, w: 4, h: 1.1, d: 0.2, mat: 'plasterDeep' },
    { x: -11.2, y: 0.55, z: -8.7, w: 4, h: 1.1, d: 0.2, mat: 'plasterDeep' },
    { x: -5.6, y: 0.55, z: -8.7, w: 4, h: 1.1, d: 0.2, mat: 'plasterDeep' },
    { x: 0, y: 0.55, z: -8.7, w: 4, h: 1.1, d: 0.2, mat: 'plasterDeep' },
    { x: 5.6, y: 0.55, z: -8.7, w: 4, h: 1.1, d: 0.2, mat: 'plasterDeep' },
    { x: 11.2, y: 0.55, z: -8.7, w: 4, h: 1.1, d: 0.2, mat: 'plasterDeep' },
    { x: -11.2, y: 0.55, z: -5.8, w: 4, h: 1.1, d: 0.2, mat: 'plasterDeep' },
    { x: -5.6, y: 0.55, z: -5.8, w: 4, h: 1.1, d: 0.2, mat: 'plasterDeep' },
    { x: 0, y: 0.55, z: -5.8, w: 4, h: 1.1, d: 0.2, mat: 'plasterDeep' },
    { x: 5.6, y: 0.55, z: -5.8, w: 4, h: 1.1, d: 0.2, mat: 'plasterDeep' },
    { x: 11.2, y: 0.55, z: -5.8, w: 4, h: 1.1, d: 0.2, mat: 'plasterDeep' },
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
    // meeting-room N doors from long farm sightlines) — concreteDark, same
    // mid-dark tier as the archive banks it mirrors
    { x: 2.8, y: 1.1, z: -8.4, w: 1.5, h: 2.2, d: 11, mat: 'concreteDark' },

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
    // planters (h=0.9 cover) between the desk rows — cast-concrete tubs, not
    // white plaster blocks: a small dark mass that grounds the bullpen
    { x: -11, y: 0.45, z: 8.5, w: 2, h: 0.9, d: 1, mat: 'concreteDark' },
    { x: 11, y: 0.45, z: 8.5, w: 2, h: 0.9, d: 1, mat: 'concreteDark' },
    // copier cabinets along the south wall (west one offset clear of the spine)
    { x: -10.5, y: 1.1, z: 14.7, w: 2, h: 2.2, d: 1.6, mat: 'metal' },
    { x: 0, y: 1.1, z: 14.7, w: 2, h: 2.2, d: 1.6, mat: 'metal' },
    { x: 8, y: 1.1, z: 14.7, w: 2, h: 2.2, d: 1.6, mat: 'metal' },
    // tall storage cabinet merging with the x=8 copier row: blocks the ENE
    // rays from the south floor (the ~26m diagonal past the bank's SE corner)
    // while keeping the SE window x[10.5,16.5] open for the ring route
    { x: 9.5, y: 1.1, z: 13.7, w: 2, h: 2.2, d: 3.6, mat: 'metal' },
    // storage spine (mirror of the north one, 180-degree rotational layout)
    { x: -7, y: 1.1, z: 8.4, w: 1.5, h: 2.2, d: 11, mat: 'concreteDark' },
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
    // paperStacks clutter the work floors; plants dress the ring + rooms.
    // These two run FIRST, and `minSpacing` is global (see THE SCATTER BUDGET
    // below), so whatever they touch is off-limits to every later zone. Their
    // rects are therefore clipped to the cubicle/bullpen floors themselves
    // (|x| <= 13.6 = the archive-bank faces; |z| inside the furniture band):
    // the archive-strip pockets, the north service pockets and the south wall
    // pockets are left to the zones that dress them deliberately, instead of
    // being half-filled at random by these two and then starving those zones.
    { kind: 'paperStack', count: 22, x0: -13.6, z0: -12.2, x1: 13.6, z1: -3.5, minSpacing: 2 },
    { kind: 'paperStack', count: 18, x0: -13.6, z0: 3.5, x1: 13.6, z1: 11.6, minSpacing: 2 },
    { kind: 'plant', count: 6, x0: -19, z0: -15, x1: -17, z1: 15, minSpacing: 4 },
    { kind: 'plant', count: 6, x0: 17, z0: -15, x1: 19, z1: 15, minSpacing: 4 },
    { kind: 'plant', count: 5, x0: -16, z0: -15, x1: 16, z1: -13.6, minSpacing: 5 },
    { kind: 'plant', count: 5, x0: -16, z0: 13.6, x1: 16, z1: 15, minSpacing: 5 },
    { kind: 'plant', count: 6, x0: -13, z0: -2.5, x1: 13, z1: 2.5, minSpacing: 3 },
    // AAA pass: desk chairs cluster around the cubicle/bullpen desk rows,
    // water coolers + plants dot the ring corridors and their ends
    // (solid/spawn rejection keeps desks clear)
    { kind: 'deskChair', count: 16, x0: -13.5, z0: -12.5, x1: 13.5, z1: -4, minSpacing: 2.4 },
    { kind: 'deskChair', count: 14, x0: -13.5, z0: 4, x1: 13.5, z1: 12.5, minSpacing: 2.4 },
    // ---- THE SCATTER BUDGET (measured, not guessed) ------------------------
    // mapRenderer's rejection sampler is stricter than it looks, and both
    // rules below were mis-read by the zones this block replaces:
    //   1. `insideSolid` inflates EVERY solid AABB by SOLID_PAD = 0.5m, and
    //      `nearSpawn` rejects inside 2.5m of any of the 14 spawns. The outer
    //      walls' inner faces are x=+-19.5 / z=+-15.5, so NOTHING can stand
    //      outside |x| <= 19.0 / |z| <= 15.0 — a band authored at x0=-19.4 or
    //      z0=-15.4 spends half its width in dead space. The whole north and
    //      south wall band (|z| in [13.4,15.0]) is further eaten by the three
    //      copiers at |z|=14.7 and the four spawns at |z|=14.5: 3.6 m2 of the
    //      60 m2 band survives, in three pockets.
    //   2. `minSpacing` is measured against the GLOBAL placed list — every
    //      prop already dropped anywhere in the map, not this zone's own.
    //      A large minSpacing therefore does not "spread this zone out", it
    //      deletes the zone wherever an earlier zone has been. The coolers at
    //      minSpacing 9/12 could not place a single prop.
    // Total free floor is 296 m2, so a 2m global spacing floor caps the WHOLE
    // map at ~85 props: spacing is therefore sized to the prop's own footprint
    // (PROP_SHADOW_R: plant 0.26m, paperStack 0.30m, cooler 0.30m, chair
    // 0.38m, crate 0.70m, palletStack 0.78m), and counts are sized to the
    // measured free capacity of the rect rather than to an ambition.
    // Ring-corridor coolers: the usable corridor is x in [-19,-17] (outer wall
    // pad to archive-bank pad), so the band is authored there, at a spacing
    // that interleaves with the corridor plants above instead of erasing them.
    { kind: 'waterCooler', count: 3, x0: -18.9, z0: -13.4, x1: -17.2, z1: 7.6, minSpacing: 2.2 },
    { kind: 'waterCooler', count: 3, x0: 17.2, z0: -7.6, x1: 18.9, z1: 13.4, minSpacing: 2.2 },
    // SW / NE ring-corner pockets. The corner rects these replace sat inside
    // the corner spawns' 2.5m circles (T at -16,13.2 / CT at 16,-13.2) and
    // placed zero; the real free pockets are the 1.1m slivers outboard of them.
    { kind: 'plant', count: 1, x0: -18.9, z0: 13.1, x1: -17.8, z1: 14.9, minSpacing: 1.3 },
    { kind: 'plant', count: 1, x0: 17.8, z0: -14.9, x1: 18.9, z1: -13.1, minSpacing: 1.3 },

    // ---- VISUAL_UPGRADE §3c density pass -----------------------------------
    // Placement rule: dead corners and cul-de-sac pockets take the load, lanes
    // stay clear. Props are non-collidable and the scatter rejects points
    // inside solids (+0.5m) and within 2.5m of a spawn, so nothing here can
    // seal a route or a doorway. Every rect below was measured against the
    // free-floor map before it was authored (see THE SCATTER BUDGET above), and
    // every zone in this map now lands props: the shipped seed scatters 137
    // (was 99, with thirteen zones placing 0-2 against targets of 3-16).

    // ring corridors: file boxes down both corridors, sharing the coolers'
    // lane (26 m2 free per corridor — the largest undressed surface in the map
    // now that the spawn-choked end walls are off the table). The corridor
    // floor is 3m; SOLID_PAD keeps every prop >=0.5m off both the outer wall
    // face and the archive-bank face, so props can only ever sit in its middle
    // 2m, ~2m apart along its length, and they are non-collidable regardless.
    { kind: 'paperStack', count: 4, x0: -18.9, z0: -13.6, x1: -17.2, z1: 7.8, minSpacing: 1.6 },
    { kind: 'paperStack', count: 4, x0: 17.2, z0: -7.8, x1: 18.9, z1: 13.6, minSpacing: 1.6 },
    // meeting rooms: chairs pull in around the tables (the table box rejects
    // the centre, so they ring it the way real chairs do)
    { kind: 'deskChair', count: 5, x0: -12.2, z0: -1.9, x1: -5.3, z1: 1.9, minSpacing: 1.3 },
    { kind: 'deskChair', count: 5, x0: 5.3, z0: -1.9, x1: 12.2, z1: 1.9, minSpacing: 1.3 },
    // meeting-room paperwork (light-value accents on a dark floor)
    { kind: 'paperStack', count: 4, x0: -12.2, z0: -1.8, x1: 12.2, z1: 1.8, minSpacing: 1.4 },
    // work floors: a second, tighter chair pass INSIDE the cubicle/bullpen
    // bands so the rows read as occupied rather than as furniture diagrams.
    // Only the 0.6-1.0m slots between desk/partition segments are free here,
    // so the spacing floor has to be ~1m or the zone is a no-op, and the count
    // has to buy enough attempts (30 per prop) to find those slots.
    { kind: 'deskChair', count: 7, x0: -12.5, z0: -12, x1: 12.5, z1: -5.5, minSpacing: 1.2 },
    { kind: 'deskChair', count: 8, x0: -12.5, z0: 5.4, x1: 12.5, z1: 11.8, minSpacing: 1.2 },
    // the archive-strip mouths where the banks stop (bank west ends at z=8.0,
    // bank east at z=-8.0): a genuine cul-de-sac at each corridor elbow.
    // Greenery at the corridor end, overflow crates deeper in the pocket.
    { kind: 'plant', count: 2, x0: -18.8, z0: 8.6, x1: -16.6, z1: 10.4, minSpacing: 1.4 },
    { kind: 'plant', count: 2, x0: 16.6, z0: -10.4, x1: 18.8, z1: -8.6, minSpacing: 1.4 },
    { kind: 'crate', count: 2, x0: -16.4, z0: 8.6, x1: -13.8, z1: 10.9, minSpacing: 1.5 },
    { kind: 'crate', count: 2, x0: 13.8, z0: -10.9, x1: 16.4, z1: -8.6, minSpacing: 1.5 },
    // the two service pockets on the north wall — the strip between the copier
    // row (|z| pad to 13.4) and the first partition row, in the two x windows
    // the CT spawn circles leave open. This is what is actually left of the
    // "blank north wall" once the spawns and copiers are subtracted, so the
    // break-area coolers anchor it FIRST (a later zone can only ever fill the
    // gaps a previous one left) and the file boxes fill in around them.
    { kind: 'waterCooler', count: 1, x0: -9.3, z0: -13.3, x1: 9.3, z1: -12.4, minSpacing: 2 },
    { kind: 'paperStack', count: 1, x0: -9.3, z0: -13.3, x1: -5.7, z1: -12.3, minSpacing: 1.3 },
    { kind: 'paperStack', count: 1, x0: 5.7, z0: -13.3, x1: 9.3, z1: -12.3, minSpacing: 1.3 },
    // overflow pallets in the two south-floor pockets: between the x=0 and x=8
    // copiers, and west of the x=-10.5 copier — both are cul-de-sacs behind
    // the bullpen desk rows, and both clear the T spawn circles.
    { kind: 'palletStack', count: 1, x0: 2.6, z0: 11.7, x1: 7.9, z1: 13.4, minSpacing: 1.5 },
    { kind: 'palletStack', count: 1, x0: -12.8, z0: 12.4, x1: -8.5, z1: 13.6, minSpacing: 1.5 },
  ],
  // AAA accent: screenGlow wayfinding (emissive strips + door markers) plus
  // family-neutral whiteboards/picture frames on corridor and room walls
  accents: [
    // wayfinding strips at eye level along both ring corridors (lit signage)
    { x: -19.45, y: 1.5, z: -10, w: 0.04, h: 0.12, d: 2.4, hex: PALETTE.screenGlow, emissive: true },
    { x: -19.45, y: 1.5, z: 2, w: 0.04, h: 0.12, d: 2.4, hex: PALETTE.screenGlow, emissive: true },
    { x: -19.45, y: 1.5, z: 11, w: 0.04, h: 0.12, d: 2.4, hex: PALETTE.screenGlow, emissive: true },
    { x: 19.45, y: 1.5, z: -6, w: 0.04, h: 0.12, d: 2.4, hex: PALETTE.screenGlow, emissive: true },
    { x: 19.45, y: 1.5, z: 6, w: 0.04, h: 0.12, d: 2.4, hex: PALETTE.screenGlow, emissive: true },
    // whiteboards on the corridor jog faces (metalDark frame + paper board +
    // faint gray grid lines on the paper)
    { x: -16.42, y: 1.5, z: -8, w: 0.05, h: 1.2, d: 1.9, hex: PALETTE.metalDark },
    { x: -16.39, y: 1.5, z: -8, w: 0.05, h: 1.0, d: 1.7, hex: PALETTE.paper },
    { x: -16.36, y: 1.25, z: -8, w: 0.02, h: 0.02, d: 1.55, hex: PALETTE.concrete },
    { x: -16.36, y: 1.5, z: -8, w: 0.02, h: 0.02, d: 1.55, hex: PALETTE.concrete },
    { x: -16.36, y: 1.75, z: -8, w: 0.02, h: 0.02, d: 1.55, hex: PALETTE.concrete },
    { x: -16.36, y: 1.5, z: -8.4, w: 0.02, h: 0.85, d: 0.02, hex: PALETTE.concrete },
    { x: -16.36, y: 1.5, z: -7.6, w: 0.02, h: 0.85, d: 0.02, hex: PALETTE.concrete },
    { x: 16.42, y: 1.5, z: 8, w: 0.05, h: 1.2, d: 1.9, hex: PALETTE.metalDark },
    { x: 16.39, y: 1.5, z: 8, w: 0.05, h: 1.0, d: 1.7, hex: PALETTE.paper },
    { x: 16.36, y: 1.25, z: 8, w: 0.02, h: 0.02, d: 1.55, hex: PALETTE.concrete },
    { x: 16.36, y: 1.5, z: 8, w: 0.02, h: 0.02, d: 1.55, hex: PALETTE.concrete },
    { x: 16.36, y: 1.75, z: 8, w: 0.02, h: 0.02, d: 1.55, hex: PALETTE.concrete },
    { x: 16.36, y: 1.5, z: 7.6, w: 0.02, h: 0.85, d: 0.02, hex: PALETTE.concrete },
    { x: 16.36, y: 1.5, z: 8.4, w: 0.02, h: 0.85, d: 0.02, hex: PALETTE.concrete },
    // picture frames on the open-floor end walls
    { x: -6, y: 1.6, z: -15.45, w: 0.7, h: 0.55, d: 0.05, hex: PALETTE.metalDark },
    { x: -6, y: 1.6, z: -15.42, w: 0.55, h: 0.4, d: 0.05, hex: PALETTE.paper },
    { x: 2, y: 1.6, z: 15.45, w: 0.7, h: 0.55, d: 0.05, hex: PALETTE.metalDark },
    { x: 2, y: 1.6, z: 15.42, w: 0.55, h: 0.4, d: 0.05, hex: PALETTE.paper },
    // door markers flanking the meeting-room south doors
    { x: -12.25, y: 1.1, z: 2.93, w: 0.14, h: 2.2, d: 0.06, hex: PALETTE.screenGlow },
    { x: -10.15, y: 1.1, z: 2.93, w: 0.14, h: 2.2, d: 0.06, hex: PALETTE.screenGlow },
    { x: 10.15, y: 1.1, z: 2.93, w: 0.14, h: 2.2, d: 0.06, hex: PALETTE.screenGlow },
    { x: 12.25, y: 1.1, z: 2.93, w: 0.14, h: 2.2, d: 0.06, hex: PALETTE.screenGlow },
  ],
};
