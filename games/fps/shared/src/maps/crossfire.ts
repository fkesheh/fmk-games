// CROSSFIRE — industrial yard (task M1). Same playability invariants as dustbowl:
//   - enclosed by outer walls (h>=4) with no gaps
//   - 3 attack lanes from T spawn (south) to CT spawn (north): west dock lane,
//     mid gantry plaza, east container yard (+ a 1.5m alley west of the warehouse)
//   - no spawn has a direct unobstructed sightline to an enemy spawn:
//     every T(x1,17.5) -> CT(x2,-17.5) line crosses the z=14 slab at
//     x = 0.9*x1 + 0.1*x2 in [-9,9] ⊆ slab x[-11,11] (h=3 > eye 1.62)
//   - every lane has cover at least every 8m; longest open sightline <= 42m
//     (horizontal lines are cut by slabs/dividers/containers so no open run
//     exceeds ~28m; verticals are bounded by the 39m inner depth; corner
//     diagonals all intersect a container, the gantry, or the warehouse)
//   - >= 6 spawns per team, all on y=0 ground, none inside boxes
// Landmarks: warehouse block + 0.8 loading dock with a 0.4 step (west, CT half),
// mid crane gantry (legs + bridge + trolley) parked over a ground container,
// double-stacked containers in the east yard, pipe runs and pallet piles.
//
// VALUE LADDER (VISUAL_UPGRADE.md §1/§3a) — this map's assigned read:
//   ground  `tarmac`   L 34.7  (cool blue-grey asphalt; was `concrete`, the
//                               same hex as the walls — the map's L1/L4 defect)
//   wall    `concrete` L 58.4  (warm-neutral, the L1 reference)  -> L1 = 23.7
//   contact `concreteDeep`     (plinths are F8's articulate(), not map data)
//   hue split: hueDistance(tarmac, concrete) = 153 deg  -> L4 clears easily.
//
// L5 READABILITY PASS (second visit). The ladder above is measured on MATERIAL
// L*, and it passed while the SCREEN was unreadable: with the sun on this
// azimuth every +x / +z facing surface is unlit, and at hemiIntensity 0.65 the
// hemisphere left them at L* 3-8 on screen. Half the frame was black and an
// enemy against the outer wall had no silhouette. Three data-only changes fix
// it, all of them light or albedo — geometry, spawns, lanes and cover spacing
// are byte-for-byte the same as before:
//   theme.hemiIntensity 0.65 -> 2.0      shaded outer wall  L*  7.4 -> 23.0
//   theme.ground tarmac -> steel         shaded spawn slab  L* 11.6 -> 22.3
//   container dark tier metalDark->roofRed  shaded container L*  6.2 -> 21.7
// and the LIT reference moves 24.2 -> 41.1, so the light/shade separation
// WIDENS (16.8 -> 19.9 L*) rather than flattening to mid-grey.
//
// Every box position, extent and spawn below is UNCHANGED — this pass moves
// `floorMat`, `theme`, `mat` ids, deco density and the backdrop ring only, so
// collision, lane widths, sightlines and cover spacing are bit-identical.
import { PALETTE } from '../palette.js';
import type { MapDef } from './types.js';

const W = 56;
const D = 40;

export const crossfire: MapDef = {
  id: 'crossfire',
  name: 'Crossfire',
  sizeX: W,
  sizeZ: D,
  // §3a: cool asphalt yard under warm-neutral concrete architecture.
  floorMat: 'tarmac',
  theme: {
    skyHigh: PALETTE.skyDayHigh, // S1: zenith, 25.7 L below the horizon + cooler
    sky: PALETTE.skyDay,
    horizon: PALETTE.fogDay,
    // §1 L5 READABILITY FIX. `theme.ground` is NOT the floor — the floor is
    // `floorMat`, still `tarmac`. The rig uses this field for exactly two
    // things: the HemisphereLight's GROUND half (the light bouncing back up
    // off a sunlit yard) and the 320 m horizon apron outside the walls.
    // Keying it to the tarmac's own ~8% reflectance made the lower
    // hemisphere near-black, and half the fill on every shaded vertical face
    // comes from that half. `steel` is the same cool blue-grey family read at
    // BOUNCE brightness instead of floor brightness: measured +4.5 L* on every
    // shade-side wall in frame, and ~0 on the floor itself (a floor's normal
    // points up, so it only ever sees the SKY half). S4 still holds — steel is
    // not the horizon hex, and this field was never pinned to `floorMat`
    // anyway — Office already runs `plasterDeep` (L 56) over a `carpet`
    // (L 29) floor and Frostbite `snowShadow` over snow.
    ground: PALETTE.steel,
    fog: PALETTE.fogDay, // S2: fog === horizon, never the zenith
    fogDensity: 0.009, // hazes the 60-76m skyline ring; ~12% at 40m combat range
    // §3d: sun dropped from ~40deg to ~31deg elevation — long raking shadows
    // off the containers and the gantry are this map's value structure.
    sunDir: [0.62, -0.45, 0.42],
    sunColor: PALETTE.sandLit, // warm afternoon key against the cool tarmac
    sunIntensity: 1.75,
    // §1 L5 READABILITY FIX — the single biggest cause of the crushed frame.
    // This azimuth leaves every +x and +z facing surface completely unlit,
    // and that is the ENTIRE forward view out of the T half: the north outer
    // wall, the z=14 spawn slab, and the east face of every container. Their
    // only light is the hemisphere, and at 0.65 that put the shaded outer
    // wall at a MEASURED L* 7.4 on screen — an enemy stood against it was
    // black on black, which is a gameplay regression, not a mood choice
    // (§1 L5: readability wins every tie). Crossfire is a dark-albedo map —
    // tarmac ~8% and concrete ~25% reflectance, roughly 2.4x darker than
    // Dustbowl's dust/sand — so it needs the top of the MapTheme band the
    // brighter daylight maps never have to touch (types.ts: hemiIntensity
    // "0.3..2.5 (indoor/dark-albedo maps run 1.5-2.5)").
    // This does NOT flatten the sun. Measured on the same two walls, the
    // lit-vs-shade separation goes UP, 16.8 -> 19.9 L*, because the lit side
    // is already on the ACES shoulder and the shade side is not.
    hemiIntensity: 2.0,
  },
  boxes: [
    // ---- outer walls (the `concrete` L1 reference mass) ----
    { x: 0, y: 2.5, z: -D / 2, w: W + 2, h: 5, d: 1, mat: 'concrete' },
    { x: 0, y: 2.5, z: D / 2, w: W + 2, h: 5, d: 1, mat: 'concrete' },
    { x: -W / 2, y: 2.5, z: 0, w: 1, h: 5, d: D + 2, mat: 'concrete' },
    { x: W / 2, y: 2.5, z: 0, w: 1, h: 5, d: D + 2, mat: 'concrete' },

    // ---- spawn sightline slabs (x[-11,11], z +/-[13,15]) ----
    // secondary mass: a step DOWN from the outer walls (L 46 vs 58) so the
    // spawn courts read as a separate plane instead of one concrete soup
    { x: 0, y: 1.5, z: 14, w: 22, h: 3, d: 2, mat: 'concreteDark' },
    { x: 0, y: 1.5, z: -14, w: 22, h: 3, d: 2, mat: 'concreteDark' },

    // ---- spawn yard dividers (cut the long z~+/-17.5 horizontal) ----
    { x: 14, y: 1, z: 17, w: 1.5, h: 2, d: 5, mat: 'concreteDark' },
    { x: -14, y: 1, z: 17, w: 1.5, h: 2, d: 5, mat: 'concreteDark' },
    { x: 14, y: 1, z: -17, w: 1.5, h: 2, d: 5, mat: 'concreteDark' },
    { x: -14, y: 1, z: -17, w: 1.5, h: 2, d: 5, mat: 'concreteDark' },

    // ---- warehouse block (x[-26,-15], z[-13,-5]) + loading dock ----
    { x: -20.5, y: 3, z: -9, w: 11, h: 6, d: 8, mat: 'concrete' },
    // dock platform top y=0.8 against the south face; single 0.4 step up.
    // Three-value stair: ground 34.7 -> platform 46.2 -> lit step nosing 58.4.
    { x: -20.5, y: 0.4, z: -4, w: 11, h: 0.8, d: 2, mat: 'concreteDark' },
    { x: -20.5, y: 0.2, z: -2.5, w: 6, h: 0.4, d: 1, mat: 'concrete' },

    // ---- mid lane container dividers (rotation gap z(-0.5,2) = 2.5m) ----
    // §1 L5 READABILITY FIX — the alternation was `metal` (L 66) against
    // `metalDark` (L 26). On the lit side that reads as a painted yard; on the
    // shade side — which is every east face, all game — L 26 has nothing left
    // to give and the container went to L* 6 on screen, a black hole exactly
    // at chest height beside a lane. The dark tier is now `roofRed` (L 39),
    // the map's own declared rust accent: it keeps a 27 L* alternation AND
    // adds a hue split the two steels never had, and it survives the shade
    // side (measured L* 6.2 -> 21.7). `metalDark` is kept ONLY on the gantry,
    // where a dark thin frame against the sky is the point.
    { x: -7.5, y: 1.3, z: -4, w: 2.4, h: 2.6, d: 7, mat: 'metal' },
    { x: -7.5, y: 1.3, z: 5, w: 2.4, h: 2.6, d: 6, mat: 'roofRed' },
    { x: 7.5, y: 1.3, z: -4, w: 2.4, h: 2.6, d: 7, mat: 'roofRed' },
    { x: 7.5, y: 1.3, z: 5, w: 2.4, h: 2.6, d: 6, mat: 'metal' },

    // ---- mid crane gantry: legs + bridge (underside 3.2) + trolley ----
    { x: -3.5, y: 1.6, z: 0, w: 1, h: 3.2, d: 1, mat: 'metalDark' },
    { x: 3.5, y: 1.6, z: 0, w: 1, h: 3.2, d: 1, mat: 'metalDark' },
    { x: 0, y: 3.4, z: 0, w: 11, h: 0.4, d: 1.4, mat: 'metalDark' },
    { x: 0, y: 2.95, z: 0, w: 1.4, h: 0.5, d: 1.4, mat: 'metal' }, // trolley reads bright on the dark bridge
    // container parked under the crane (mid cover, splits the plaza 2 ways)
    { x: 0, y: 1.3, z: 1.5, w: 2.4, h: 2.6, d: 6, mat: 'metal' },

    // ---- mid approach containers (plug the z +/-[7,13] bands) ----
    { x: 2, y: 1.3, z: 10, w: 2.4, h: 2.6, d: 6, mat: 'roofRed' },
    { x: -2, y: 1.3, z: -10, w: 2.4, h: 2.6, d: 6, mat: 'metal' },

    // ---- east container yard (stack A is double, top y=5.2) ----
    // rust base / light steel top: the stack still lifts (27 L*) instead of
    // reading as one slab, but the base no longer dies on the shade side.
    { x: 20, y: 1.3, z: -8, w: 6, h: 2.6, d: 2.4, mat: 'roofRed' },
    { x: 20, y: 3.9, z: -8, w: 6, h: 2.6, d: 2.4, mat: 'metal' },
    { x: 24.5, y: 1.3, z: 1, w: 2.4, h: 2.6, d: 6, mat: 'metal' },
    { x: 18, y: 1.3, z: 8, w: 2.4, h: 2.6, d: 6, mat: 'roofRed' },
    { x: 24, y: 1.3, z: 11, w: 6, h: 2.6, d: 2.4, mat: 'metal' },

    // ---- pipe runs (low cover, h=0.9) ----
    // kept `metal` (L 66.6): 32 L above the tarmac, so low cover stays readable
    { x: 14, y: 0.45, z: 12, w: 8, h: 0.9, d: 1, mat: 'metal' },
    { x: -12, y: 0.45, z: -11, w: 6, h: 0.9, d: 1, mat: 'metal' },
    { x: 26, y: 0.45, z: -12, w: 1, h: 0.9, d: 8, mat: 'metal' },

    // ---- pallet piles (0.6 base + 0.3 top = 0.9 cover) ----
    // base `wood` / top `woodLit`: the sun-hit top plank layer lifts 11 L
    { x: -18, y: 0.3, z: 8, w: 3, h: 0.6, d: 2, mat: 'wood' },
    { x: -18, y: 0.75, z: 8, w: 2.2, h: 0.3, d: 1.5, mat: 'woodLit' },
    { x: -18, y: 0.3, z: 0, w: 3, h: 0.6, d: 2, mat: 'wood' },
    { x: -18, y: 0.75, z: 0, w: 2.2, h: 0.3, d: 1.5, mat: 'woodLit' },
    { x: -12, y: 0.3, z: 5, w: 2.6, h: 0.6, d: 2, mat: 'wood' },
    { x: -12, y: 0.75, z: 5, w: 1.8, h: 0.3, d: 1.4, mat: 'woodLit' },

    // ---- crates (head-glitch 1.2 lane cover) ----
    // `crate` stays the map's warm accent mass against the cool ground
    { x: -22, y: 0.6, z: 16, w: 1.2, h: 1.2, d: 1.2, mat: 'crate' },
    { x: 22, y: 0.6, z: 16, w: 1.2, h: 1.2, d: 1.2, mat: 'crate' },
    { x: -22, y: 0.6, z: -16, w: 1.2, h: 1.2, d: 1.2, mat: 'crate' },
    { x: 22, y: 0.6, z: -16, w: 1.2, h: 1.2, d: 1.2, mat: 'crate' },
    { x: -20, y: 0.6, z: 12, w: 1.2, h: 1.2, d: 1.2, mat: 'crate' },
    { x: -21, y: 0.6, z: 3, w: 1.2, h: 1.2, d: 1.2, mat: 'crate' },
    { x: -13, y: 0.6, z: -5, w: 1.2, h: 1.2, d: 1.2, mat: 'crate' },
    { x: -2.5, y: 0.6, z: 7, w: 1.2, h: 1.2, d: 1.2, mat: 'crate' },
    { x: 2.5, y: 0.6, z: -7, w: 1.2, h: 1.2, d: 1.2, mat: 'crate' },
    { x: 15, y: 0.6, z: -2, w: 1.2, h: 1.2, d: 1.2, mat: 'crate' },
    { x: 21, y: 0.6, z: 4, w: 1.2, h: 1.2, d: 1.2, mat: 'crate' },
    { x: 15, y: 0.6, z: -13, w: 1.2, h: 1.2, d: 1.2, mat: 'crate' },
  ],
  spawns: {
    T: [
      { x: -9, z: 17.5, yaw: 0 },
      { x: -6, z: 17.5, yaw: 0 },
      { x: -3, z: 17.5, yaw: 0 },
      { x: 0, z: 17.5, yaw: 0 },
      { x: 3, z: 17.5, yaw: 0 },
      { x: 6, z: 17.5, yaw: 0 },
      { x: 9, z: 17.5, yaw: 0 },
    ],
    CT: [
      { x: -9, z: -17.5, yaw: Math.PI },
      { x: -6, z: -17.5, yaw: Math.PI },
      { x: -3, z: -17.5, yaw: Math.PI },
      { x: 0, z: -17.5, yaw: Math.PI },
      { x: 3, z: -17.5, yaw: Math.PI },
      { x: 6, z: -17.5, yaw: Math.PI },
      { x: 9, z: -17.5, yaw: Math.PI },
    ],
  },
  // §3c deco density: +96% (73 -> 143 props ACTUALLY placed; counts are
  // requests, and the renderer's rejection sampler shares one `placed` list
  // across all zones, so a zone's `count` is an upper bound, not a yield).
  //
  // Zones 0-5 keep their rect, kind and rng salt (= array index). Their
  // minSpacing is loosened where it was starving the sampler: zones 4 and 5
  // (palletStack, minSpacing 4) placed literally ZERO props before this pass —
  // the ~73 props from zones 0-3 already covered their rects at a 4 m radius,
  // so the warehouse and SE-yard pallet piles the map data asks for never
  // existed. At 2.4 m they nestle between the barrels and place 7 and 8.
  //
  // Zones 6-12 are new clusters, deliberately tight (1.6-2.0 m) so they read as
  // piles rather than a uniform sprinkle. Every one of them is pinned to a dead
  // corner, one of the two long blank outer walls, or the dock apron — none
  // sits in a lane. Spacing still exceeds each prop's own footprint (crate 1.13
  // m, pallet 1.38 m, barrel 0.82 m, sack ~1.1 m at max scale jitter), so props
  // never interpenetrate. The renderer's insideSolid + SPAWN_CLEARANCE
  // rejection keeps every prop out of solids and off the spawn courts, and deco
  // is non-collidable, so none of this touches cover spacing or sightlines.
  deco: [
    { kind: 'barrel', count: 28, x0: -27, z0: -19, x1: -12, z1: 19, minSpacing: 3 },
    { kind: 'barrel', count: 15, x0: 14, z0: -19, x1: 27, z1: 0, minSpacing: 3 },
    { kind: 'pallet', count: 20, x0: -10, z0: 8, x1: 27, z1: 19, minSpacing: 3 },
    { kind: 'pipe', count: 13, x0: 2, z0: -19, x1: 27, z1: 19, minSpacing: 2.8 },
    // stacked pallets around the warehouse/dock and the SE container yard
    { kind: 'palletStack', count: 10, x0: -27, z0: -14, x1: -13, z1: 8, minSpacing: 2.4 },
    { kind: 'palletStack', count: 8, x0: 12, z0: 4, x1: 27, z1: 19, minSpacing: 2.4 },
    // ---- §3c density pass: dead-corner and blank-wall clusters ----
    // NW dead pocket, west of the CT spawn court
    { kind: 'crate', count: 10, x0: -27, z0: -19.5, x1: -13, z1: -14, minSpacing: 1.8 },
    // NE dead pocket, east of the CT spawn court
    { kind: 'crate', count: 8, x0: 13, z0: -19.5, x1: 27, z1: -14.5, minSpacing: 1.8 },
    // long blank east outer wall: a rust-drum run hugging it (§3a rust accent)
    {
      kind: 'barrel',
      count: 9,
      x0: 24,
      z0: -12,
      x1: 26.8,
      z1: 19,
      minSpacing: 1.6,
      hex: PALETTE.roofRed,
    },
    // long blank west outer wall
    { kind: 'pallet', count: 10, x0: -26.8, z0: -19, x1: -24, z1: 19, minSpacing: 2 },
    // loading-dock apron: cargo piled off the dock face
    { kind: 'sack', count: 9, x0: -26, z0: -2.5, x1: -14, z1: 3, minSpacing: 1.6 },
    // SW dead corner, west of the T spawn court
    { kind: 'sack', count: 7, x0: -27, z0: 13.5, x1: -12, z1: 19, minSpacing: 1.6 },
    // SE dead corner, east of the T spawn court
    { kind: 'crate', count: 8, x0: 12, z0: 14, x1: 27, z1: 19, minSpacing: 1.8 },
  ],
  // AAA accent: safety amber (hazardAmber) — dock-edge hazard strip, painted
  // container doors, crane leg stripes: the industrial safety-yellow rhythm.
  // Both painted doors sit on the dark-tier containers, now `roofRed` (L 39)
  // rather than `metalDark` (L 26): the amber keeps a 23 L step instead of the
  // ~4 it had against `metal`, and unlike the old pairing it is still legible
  // when that container face is on the shade side.
  accents: [
    // loading-dock edge hazard strip (front face of the dock platform)
    { x: -20.5, y: 0.73, z: -2.96, w: 11, h: 0.14, d: 0.05, hex: PALETTE.hazardAmber },
    // painted container doors (end faces of two mid-lane containers)
    { x: 7.5, y: 1.3, z: -7.54, w: 1.8, h: 1.8, d: 0.06, hex: PALETTE.hazardAmber },
    { x: -7.5, y: 1.3, z: 8.04, w: 1.8, h: 1.8, d: 0.06, hex: PALETTE.hazardAmber },
    // crane leg hazard stripes
    { x: -3.5, y: 0.9, z: -0.53, w: 1.04, h: 0.3, d: 0.05, hex: PALETTE.hazardAmber },
    { x: 3.5, y: 0.9, z: -0.53, w: 1.04, h: 0.3, d: 0.05, hex: PALETTE.hazardAmber },
  ],
  // §1 S3 — skyline height band. Crossfire had NO SkylineDef, so the sky above
  // the 5 m outer walls was empty and the ground stopped at the 64x48 slab.
  // The band is tuned so tips can never read as detached "floating diamonds":
  //   * minR 60 clears the map's 35.1 m corner radius by more than the widest
  //     landmark's bounding radius (h=13 -> w<=36.4, d<=26 -> r<=22.4), so no
  //     silhouette can ever poke through an outer wall into the playable yard;
  //   * the 9-13 m height band is narrow, and at r 60-76 every landmark's top
  //     lands just above the wall line from mid-map, so the ring reads as one
  //     continuous industrial roofline rather than isolated caps over their own
  //     front ranks. count 16 at r~68 gives ~27 m spacing against 14-36 m
  //     widths, so the ranks overlap into a band by construction.
  //   * capHex is the LIGHTER tier: the upper mass lifts toward the pale
  //     horizon, which is free atmospheric perspective.
  skyline: {
    hex: PALETTE.concreteDark,
    capHex: PALETTE.concrete,
    count: 16,
    minR: 60,
    maxR: 76,
    minH: 9,
    maxH: 13,
  },
};
