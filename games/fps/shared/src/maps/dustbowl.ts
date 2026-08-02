// FROZEN CONTRACT — reference map (full quality bar). Other maps must match
// this density and these playability invariants:
//   - enclosed by outer walls (h>=4) with no gaps
//   - 3 attack lanes from T spawn (south) to CT spawn (north)
//   - no spawn has a direct unobstructed sightline to an enemy spawn
//   - >= 7 spawns per team (MAX_PLAYERS 14 => 7 a side), all on y=0 ground,
//     none inside boxes
//
// SIGHTLINES + COVER — MEASURED, NOT ASSERTED. `maps/sightline.test.ts` computes
// every number below from `boxes` using the engine's own `raycastSolids`, and
// fails if the geometry drifts. The method (standing eye 1.62m, 1.0m grid over
// ground-level walkable space, which pairs are sampled) is documented there;
// the reading matters more than the figure, so each number names its reading.
//   - longest open sightline, WHOLE MAP including diagonals: 66.85m. This is a
//     corner-to-corner run across the open flanks, ~(-31,2) -> (31,-23).
//   - longest open sightline DOWN A LANE (within a lane's x-band, |dx| <= 2m):
//     mid 28.07m, left flank 46.04m, right flank 46.04m.
//   - cover in PLAN VIEW: every walkable point is within 5.71m of a solid, so
//     "cover at least every 8m" holds as a floor-plan statement.
//   - cover that BREAKS A STANDING SIGHTLINE: gaps to 8.50m. Only 13 of the 41
//     boxes reach above a 1.62m standing eye — every crate, sandbag block and
//     step is see-over cover, which is why the flank lanes measure 46m clear.
//
// This block previously read "every lane has cover at least every 8m; longest
// open sightline <= 42m". The 42m was never measured — it is the map's
// spawn-to-spawn depth (z +21 to -21) — and NO reading of this map comes in
// under it except the mid lane. The geometry is the frozen reference and was
// not touched (STRICKEN_PASS.md §8, A3); the claim was what was wrong. Other
// maps are held to these MEASURED figures, and to the split between plan-view
// cover and cover a standing player cannot see over.
//
// VISUAL_UPGRADE.md §1/§3a value ladder (this round — geometry untouched):
//   ground  `dust`      L 50  (floorMat; was `sand`, i.e. the SAME MatId as the
//                              main wall, so the ladder measured 0.0)
//   backdrop`sandDark`  L 62  outer walls — the darker secondary mass that
//                              frames the frame and silhouettes the skyline
//   walls   `sand`      L 80  L1 reference: 29.1 L above the ground
//   L4 clears on the desaturation clause: sat(sand) 48.1 - sat(dust) 26.6 = 21.5
//   Sky: warm dusk horizon (`fogDusk`, fog matched per S2) under the cool
//   VIOLET zenith (`skyDuskHigh`) — 27.1 L of separation. This pairing is the
//   map's signature and the reason `skyDusk` stays the mid stop (the renderer's
//   dusk grade is keyed on it).
import { PALETTE } from '../palette.js';
import type { MapDef } from './types.js';

const W = 64;
const D = 48;

export const dustbowl: MapDef = {
  id: 'dustbowl',
  name: 'Dustbowl',
  sizeX: W,
  sizeZ: D,
  floorMat: 'dust',
  theme: {
    skyHigh: PALETTE.skyDuskHigh, // S1: cool violet zenith, 27.1 L under horizon
    sky: PALETTE.skyDusk, //        mid stop (keys the renderer's dusk grade)
    horizon: PALETTE.fogDusk, //    warm dusk haze band
    ground: PALETTE.dust, //        S4: distinct from the horizon
    fog: PALETTE.fogDusk, //        S2: fog === horizon, never the zenith
    // Held: enemies must stay readable down the map's real longest sightline —
    // 66.85m whole-map / 46.04m down a flank lane (measured, see the header),
    // not the 42m this line used to cite.
    fogDensity: 0.012,
    // Azimuth only — the rig overrides elevation with its golden-hour value.
    // Swung almost due east so the raking light crosses the lanes instead of
    // running down them: both spawns get the same treatment (the old
    // [0.5,-1,0.35] leaned 35 deg toward CT) and every N-S wall gets a lit
    // face and a shaded face, which is where this map's modelling comes from.
    sunDir: [0.86, -0.5, 0.12],
    sunColor: PALETTE.muzzle,
    sunIntensity: 1.55,
    // §3d: hemi down (0.7 -> 0.45) so the sun's shadows actually register.
    // Effective fill after the dusk grade's 1.25x is 0.5625, comfortably above
    // the rig's MIN_AMBIENT_LUMINANCE floor (needs >= 0.26 against skyDusk),
    // so players stay clearly lit and the floor is not silently overridden.
    hemiIntensity: 0.45,
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

    // mid corridor cover — `woodDark` (L 27.9), 22 L BELOW the dust ground: the
    // dark anchor at the centre of the frame. It also fixes the teal accent
    // plates bolted to these two boxes, which at `wood` (L 42.7) sat 1.5 L from
    // `screenGlow` and were invisible; they now read 16 L lighter.
    { x: 0, y: 0.6, z: 9, w: 1.2, h: 1.2, d: 1.2, mat: 'woodDark' },
    { x: 0, y: 0.6, z: -9, w: 1.2, h: 1.2, d: 1.2, mat: 'woodDark' },

    // ---- left lane divider (gap z[-6,4]) ----
    { x: -14.5, y: 1.6, z: -10, w: 1.5, h: 3.2, d: 8, mat: 'sand' },
    { x: -14.5, y: 1.6, z: 8, w: 1.5, h: 3.2, d: 8, mat: 'sand' },

    // left lane cover — crates lifted to `crateLit` (L 63.0). At `crate`
    // (L 52.6) they sat 2.3 L from the ground and vanished into it; cover a
    // player must find at a glance may not share the floor's value.
    { x: -22, y: 0.6, z: -2, w: 1.2, h: 1.2, d: 1.2, mat: 'crateLit' },
    { x: -25, y: 0.6, z: 6, w: 1.2, h: 1.2, d: 1.2, mat: 'crateLit' },
    { x: -20, y: 0.45, z: -10, w: 4, h: 0.9, d: 1, mat: 'sandDark' },
    { x: -24, y: 0.45, z: 12, w: 4, h: 0.9, d: 1, mat: 'sandDark' },

    // A courtyard (NW) crates — the stack keeps one `crate` in the middle so
    // the cluster carries an internal value break instead of reading as one mass
    { x: -26, y: 0.6, z: -19, w: 1.2, h: 1.2, d: 1.2, mat: 'crateLit' },
    { x: -24.6, y: 0.6, z: -19.4, w: 1.2, h: 1.2, d: 1.2, mat: 'crate' },
    { x: -25.4, y: 1.8, z: -19.2, w: 1.2, h: 1.2, d: 1.2, mat: 'crateLit' },
    { x: -19, y: 0.6, z: -18, w: 1.2, h: 1.2, d: 1.2, mat: 'crateLit' },

    // ---- right lane divider (gap z[-4,8]) ----
    { x: 14.5, y: 1.6, z: -8, w: 1.5, h: 3.2, d: 8, mat: 'sand' },
    { x: 14.5, y: 1.6, z: 11, w: 1.5, h: 3.2, d: 8, mat: 'sand' },

    // right lane cover
    { x: 22, y: 0.6, z: 6, w: 1.2, h: 1.2, d: 1.2, mat: 'crateLit' },
    { x: 25, y: 0.6, z: -2, w: 1.2, h: 1.2, d: 1.2, mat: 'crateLit' },
    { x: 20, y: 0.45, z: 14, w: 4, h: 0.9, d: 1, mat: 'sandDark' },

    // B platform (top y=1.2) + stairs from the south (steps of 0.4)
    { x: 22, y: 0.6, z: -10, w: 6, h: 1.2, d: 6, mat: 'sandDark' },
    { x: 22, y: 0.2, z: -6.6, w: 3, h: 0.4, d: 0.9, mat: 'sandDark' },
    { x: 22, y: 0.4, z: -5.7, w: 3, h: 0.8, d: 0.9, mat: 'sandDark' },
    { x: 22, y: 0.6, z: -4.8, w: 3, h: 1.2, d: 0.9, mat: 'sandDark' },

    // ---- spawn sightline breakers ----
    { x: 0, y: 1.5, z: 15, w: 12, h: 3, d: 1, mat: 'sand' },
    { x: 0, y: 1.5, z: -15, w: 12, h: 3, d: 1, mat: 'sand' },

    // spawn courtyard cover — `metal` (L 66.6, cool) against the warm ground:
    // the only cool masses in the playable space, and they read from any angle
    { x: 10, y: 0.75, z: 18, w: 1.5, h: 1.5, d: 1.5, mat: 'metal' },
    { x: -10, y: 0.75, z: 18, w: 1.5, h: 1.5, d: 1.5, mat: 'metal' },
    { x: 10, y: 0.75, z: -18, w: 1.5, h: 1.5, d: 1.5, mat: 'metal' },
    { x: -10, y: 0.75, z: -18, w: 1.5, h: 1.5, d: 1.5, mat: 'metal' },

    // scattered extra cover
    { x: -8, y: 0.45, z: 20, w: 3, h: 0.9, d: 1, mat: 'sandDark' },
    { x: 8, y: 0.45, z: -20, w: 3, h: 0.9, d: 1, mat: 'sandDark' },

    // lane-gap + end-zone dressing (added post-review: keeps box count in the
    // 40-90 map invariant band; gaps stay > 1.4m, spawns untouched)
    { x: -14.5, y: 0.6, z: -2, w: 1.2, h: 1.2, d: 1.2, mat: 'crateLit' },
    { x: 14.5, y: 0.6, z: 2, w: 1.2, h: 1.2, d: 1.2, mat: 'crateLit' },
    { x: 0, y: 0.45, z: 12.5, w: 1, h: 0.9, d: 1, mat: 'sandDark' },
    { x: 0, y: 0.45, z: -12.5, w: 1, h: 0.9, d: 1, mat: 'sandDark' },
    { x: -22, y: 0.45, z: -20, w: 3, h: 0.9, d: 1, mat: 'sandDark' },
    { x: 18, y: 0.6, z: -14, w: 1.2, h: 1.2, d: 1.2, mat: 'crateLit' },
  ],
  spawns: {
    T: [
      { x: -8, z: 20.5, yaw: 0 },
      { x: -4, z: 21.5, yaw: 0 },
      { x: 0, z: 21, yaw: 0 },
      { x: 4, z: 21.5, yaw: 0 },
      { x: 8, z: 20.5, yaw: 0 },
      { x: 0, z: 18.5, yaw: 0 },
      // 7th spawn (7v7): at the mouth of the left lane, in line with the left
      // divider (x=-14.5, arms over z[4,12] and z[-14,-6]) — those arms are
      // what blocks the x=-14.5 column, so this point has no sightline to any
      // CT spawn. 3.0m clear of any solid, 6.5m from the nearest T spawn.
      // Verified numerically against `boxes`.
      { x: -14.5, z: 20.5, yaw: 0 },
    ],
    CT: [
      { x: -8, z: -20.5, yaw: Math.PI },
      { x: -4, z: -21.5, yaw: Math.PI },
      { x: 0, z: -21, yaw: Math.PI },
      { x: 4, z: -21.5, yaw: Math.PI },
      { x: 8, z: -20.5, yaw: Math.PI },
      { x: 0, z: -18.5, yaw: Math.PI },
      // 7th spawn (7v7): z-mirror of the T one, so both sides get the identical
      // extra position (the map's spawns mirror in z, never in x).
      { x: -14.5, z: -20.5, yaw: Math.PI },
    ],
  },
  // §3c deco density: 112 -> 222 requested placements (+98%). Zones 0-8 keep
  // their index AND their scatter rect, so the seeded stream is unchanged and
  // every previously placed prop lands exactly where it did — the raised counts
  // only append. Zones 9+ are new and target dead corners and the long blank
  // outer walls. All deco is non-collidable and rejection-sampled against
  // solids and spawn clearance, so no lane, sightline or spawn is touched.
  deco: [
    { kind: 'cactus', count: 20, x0: -31, z0: -23, x1: -16, z1: 23, minSpacing: 4 },
    { kind: 'rock', count: 13, x0: 16, z0: -23, x1: 31, z1: 23, minSpacing: 6 },
    { kind: 'shrub', count: 44, x0: -31, z0: -23, x1: 31, z1: 23, minSpacing: 3 },
    // steel drums: `metalDark` (L 27.7, cool) is 22.6 L under the dust ground.
    // The old `dust` override made every barrel the exact value of the floor.
    { kind: 'barrel', count: 20, x0: -16, z0: -23, x1: 16, z1: 23, minSpacing: 3, hex: PALETTE.metalDark },
    // corner/dead-zone dressing (style bible: corners get the most dressing)
    { kind: 'cactus', count: 9, x0: -31, z0: 16, x1: -18, z1: 23, minSpacing: 3 },
    { kind: 'shrub', count: 12, x0: 18, z0: -23, x1: 31, z1: -14, minSpacing: 3 },
    // AAA pass: sandbag fighting positions along the three lanes (appended —
    // earlier zone indices/seeds unchanged); solids/spawn rejection keeps the
    // corridor walls, crates and blocks clear
    { kind: 'sandbag', count: 20, x0: -3.5, z0: -13, x1: 3.5, z1: 13, minSpacing: 3 },
    { kind: 'sandbag', count: 11, x0: -27, z0: -14, x1: -18, z1: 14, minSpacing: 4 },
    { kind: 'sandbag', count: 11, x0: 18, z0: -14, x1: 27, z1: 14, minSpacing: 4 },
    // ---- this round: the long blank outer walls get a scrub line ----------
    // narrow bands hugging the N and S walls; spawn clearance culls whatever
    // strays into the two spawn courtyards
    { kind: 'shrub', count: 12, x0: -30, z0: -22.6, x1: 30, z1: -19.8, minSpacing: 2.5 },
    { kind: 'shrub', count: 12, x0: -30, z0: 19.8, x1: 30, z1: 22.6, minSpacing: 2.5 },
    { kind: 'rock', count: 7, x0: -30.5, z0: -19, x1: -27.5, z1: 19, minSpacing: 4 },
    { kind: 'rock', count: 7, x0: 27.5, z0: -19, x1: 30.5, z1: 19, minSpacing: 4 },
    // ---- dead corners: four clusters, none of them on a lane --------------
    { kind: 'sack', count: 7, x0: 21, z0: -22.5, x1: 30, z1: -16, minSpacing: 2 },
    { kind: 'palletStack', count: 5, x0: 20, z0: 15.5, x1: 30, z1: 22.5, minSpacing: 3 },
    { kind: 'barrel', count: 6, x0: -30, z0: 15.5, x1: -20, z1: 22.5, minSpacing: 2.5, hex: PALETTE.roofRed },
    { kind: 'pallet', count: 6, x0: -30, z0: -22.5, x1: -18, z1: -15.5, minSpacing: 2.5 },
  ],
  // AAA skyline: dune/mesa silhouette ring beyond the outer walls (the sky is
  // a third of the frame down mid lane — it must not be empty).
  //
  // §1 S3 retune. The old band (r 42-68, h 7-13) let a FAR tall landmark's
  // upper tier clear a NEAR short one by ~5.2 deg while its own body stayed
  // hidden behind that front rank — a bright cap floating free in the haze,
  // i.e. the "sky diamonds" that `stripSkylineCaps()` was deleting at runtime.
  // Tightening both bands (r 46-56, h 10.5-12) drops the worst poke-over to
  // ~1.9 deg and, more importantly, puts EVERY landmark's body above the 5m
  // outer walls from anywhere in the playable space, so a tip is always
  // attached to a silhouette the player can see. The haze mix does the rest.
  // minR stays > the rig's SKYLINE_INNER_RADIUS (42), so the shadow cascade's
  // near plane still clips the whole ring out of the playable area's shadows.
  //
  // Colours are RAW palette entries, deliberately. `buildSkyline()` draws two
  // depth tiers from this one def and applies the §0.7 atmospheric fade itself
  // — the FAR ring is `mix(hex, theme.fog, 0.5)`, which is the one "fading a
  // far tier toward the fog" that §0.7 sanctions. Pre-fading these values here
  // would fade the near ring too and then fade the far ring a second time,
  // collapsing both into the haze. Measured against the horizon (fogDusk,
  // L 72.2):
  //   near body `sandDark` L 61.9 (-10.3)   near cap `dust`  L 50.3 (-21.9)
  //   far  body  L 67.1     (-5.1)          far  cap         L 61.6 (-10.6)
  // so the two tiers are 5.2 L apart and the ring still reads as the dark mass
  // that silhouettes the skyline. The cap being DARKER than its body is also
  // what kills §1 S3 for good: a tip that clears its front rank now reads as a
  // dark ridge crest, never as one of the pale detached "diamonds".
  skyline: {
    hex: PALETTE.sandDark,
    capHex: PALETTE.dust,
    count: 16,
    minR: 46,
    maxR: 56,
    minH: 10.5,
    maxH: 12,
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
