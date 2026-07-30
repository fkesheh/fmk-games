// Map M4 — URBANA (old town), 56x44. T spawns south, CT spawns north.
// Solid brick/plaster blocks (no interiors) carve three routes:
//   R1 central street (market stalls + tall crate stacks break it up)
//   R2 west alley -> plaza jog -> west alley north
//   R3 east alley -> courtyard jog -> east alley north
// Invariants held (verified mechanically: grid flood/BFS, ray casts, channel sweeps):
//   - enclosed by outer walls h=5, no gaps
//   - 3 distinct T->CT routes; alleys 4.5m, street 10m, tightest pinch 1.5m (annex corner)
//   - no T spawn visible from any CT spawn (stalls/stacks/blocks h>=2.4 cover every pair)
//   - cover (crates/stalls/low walls/cart/well, all >=0.9 high) every <=8m per route
//   - longest open sightline ~41m <= 42m (square houses + X2/S3/S4 lips cut the diagonals)
//   - 7 spawns/team on y=0, none inside boxes
// roof caps + stall awnings sit on top of solid bodies: skyline only, unreachable.
//
// VALUE STRUCTURE (VISUAL_UPGRADE.md §1/§3a). The street was `plaster` (L 83.5)
// under `brick` walls (L 56.5) — the inversion §1 opens with. The ground is now
// `tarmac` (L 34.7) and the facades read in three deliberate value tiers:
//   BRIGHT (inner street canyon)  `plaster`  L 83.5  <- the L1 reference wall
//   MID    (free-standing court houses / outer ring) `brick` L 56.5
//   DARK   (street furniture: kerb walls, well)      `concreteDark` L 46.2
// L1 = L(plaster) - L(tarmac) = 48.8 (>= 20). §3a secondary facade:
// L(brick) - L(tarmac) = 21.8 (>= 20). L4 = hueDistance(tarmac, plaster) = 175.8
// (>= 25) — a cool street against warm plaster/brick, exactly §3a's intended read.
// NOTE (seam rule 2): trim / plinths / cornices are NOT authored here. `boxes` is
// the server's collision source, so articulation lives in mapRenderer.articulate().
import { PALETTE } from '../palette.js';
import type { BoxDef, MapDef, MatId } from './types.js';

const W = 56;
const D = 44;

// center/extents box
const B = (x: number, y: number, z: number, w: number, h: number, d: number, mat: MatId): BoxDef =>
  ({ x, y, z, w, h, d, mat });

// ground-standing box from rect x0..x1, z0..z1
const R = (x0: number, x1: number, z0: number, z1: number, h: number, mat: MatId): BoxDef =>
  B((x0 + x1) / 2, h / 2, (z0 + z1) / 2, x1 - x0, h, z1 - z0, mat);

// building block + tile-roof cap (cap bottom = building top: unreachable, skyline
// only). `cap` tiers the roofline by depth: the inner blocks wear `roofRed`, the
// outer ring wears `roofRedDeep` so the flanks recede behind the street canyon.
const struct = (
  x0: number,
  x1: number,
  z0: number,
  z1: number,
  h: number,
  mat: MatId,
  cap: MatId = 'roofRed',
): BoxDef[] => [
  R(x0, x1, z0, z1, h, mat),
  B((x0 + x1) / 2, h + 0.55, (z0 + z1) / 2, x1 - x0 - 0.2, 1.1, z1 - z0 - 0.2, cap),
];

// market stall: solid crate-mat body (eye-blocker) + roofRed awning slab
const stall = (x0: number, x1: number, z0: number, z1: number, h: number): BoxDef[] => [
  R(x0, x1, z0, z1, h, 'crate'),
  B((x0 + x1) / 2, h + 0.15, (z0 + z1) / 2, x1 - x0 + 0.6, 0.3, z1 - z0 + 0.6, 'roofRed'),
];

export const urbana: MapDef = {
  id: 'urbana',
  name: 'Urbana',
  sizeX: W,
  sizeZ: D,
  // §3a: cool tarmac street under warm plaster/brick facades (was `plaster`,
  // which made the floor brighter than every wall it met).
  floorMat: 'tarmac',
  theme: {
    // S1: zenith is cooler (blueBias 97 vs 36) and 25.6 L* darker than the horizon.
    skyHigh: PALETTE.skyDayHigh,
    sky: PALETTE.skyDay,
    horizon: PALETTE.fogDay,
    // S4: the hemisphere's ground tint / horizon apron. Deliberately NOT the
    // horizon hex and NOT the street: a warm dry earth plain around the town, so
    // the hemisphere bounces warm from below against a cool sky (§3d's free hue
    // split). The playable floor itself is `floorMat` (tarmac) and covers it.
    ground: PALETTE.dustDeep,
    // S2: fog is the horizon stop, never the zenith.
    fog: PALETTE.fogDay,
    // lifted from 0.006: the skyline ring now sits at r 42..62 and needs real
    // aerial perspective. ~11% wash at the 41m max sightline keeps targets crisp.
    fogDensity: 0.0085,
    // golden hour: ~45 deg elevation, so 5-6m facades rake shadow right across
    // the 4.5m alleys and half the 10m street.
    sunDir: [0.55, -0.68, 0.38],
    sunColor: PALETTE.sandLit,
    sunIntensity: 1.75,
    // §3d: hemi down (was 0.8) so the sun's shadows actually register.
    hemiIntensity: 0.55,
  },
  boxes: [
    // ---- outer walls (h=5, corners overlap: no gaps) ----
    B(0, 2.5, -D / 2, W + 2, 5, 1, 'brick'),
    B(0, 2.5, D / 2, W + 2, 5, 1, 'brick'),
    B(-W / 2, 2.5, 0, 1, 5, D + 2, 'brick'),
    B(W / 2, 2.5, 0, 1, 5, D + 2, 'brick'),

    // ---- outer west block (west alley = x[-18,-13.5] on its east face) ----
    // the whole outer ring is the MID brick tier with a recessed roofRedDeep cap
    ...struct(-27, -18, -21.5, -5, 6, 'brick', 'roofRedDeep'), // W1: nook z[-5,1] south of it; touches the north wall
    ...struct(-27, -18, 1, 9, 5, 'brick', 'roofRedDeep'), // W2: nook z[9,13] south of it
    ...struct(-27, -18, 13, 21.5, 6, 'brick', 'roofRedDeep'), // W3 touches the south wall

    // ---- inner west block (plaza = x[-13.5,-5] z[-10,10] between C1/C2) ----
    // inner blocks are the BRIGHT plaster tier: they line the hero sightline
    ...struct(-13.5, -5, -17, -10, 5, 'plaster'), // C1
    ...struct(-13.5, -4.8, 10, 17, 6, 'plaster'), // C2 (-4.8: mirror of E2, closes the court-to-court diagonal)

    // ---- inner east block (courtyard = x[5,13.5] z[-12,2] between E1/E2) ----
    ...struct(5, 13.5, -17, -12, 6, 'plaster'), // E1
    ...struct(4.8, 13.5, 2, 17, 5, 'plaster'), // E2 (4.8: mirror of C2; z=2 cuts nook->X2 diagonals)

    // ---- outer east block (east alley = x[13.5,18] on its west face) ----
    ...struct(18, 27, -21.5, -9, 5, 'brick', 'roofRedDeep'), // X1: nook z[-9,-4.5] south of it; touches the north wall
    ...struct(18, 27, -4.5, 6.6, 6, 'brick', 'roofRedDeep'), // X2: nook z[6.6,11] south of it; faces catch the court diagonals
    ...struct(18, 27, 13, 21.5, 5, 'brick', 'roofRedDeep'), // X3 touches the south wall

    // ---- alley mid-blockers (force the plaza / courtyard jogs, break 43m alleys) ----
    // plaster plugs in brick alleys: the jog reads as a landmark from either end
    ...struct(-18, -13.5, 1, 4, 4.5, 'plaster'), // west archhouse: alley jogs east into plaza
    ...struct(13.5, 18, -6, -3, 4.5, 'plaster'), // east chapel: alley jogs west into courtyard

    // ---- square houses (cut the >42m wall-nook diagonals across plaza/courtyard) ----
    // free-standing brick masses inside plaster-walled courts: 27 L* of separation
    ...struct(-11, -7, -9, -3, 4.5, 'brick'), // plaza house: passages 2.5m W / 2.0m E
    ...struct(10, 13.5, -10, -6, 4.5, 'brick'), // courtyard annex: corner slot 1.5m, 5m W rows, 2m to E1

    // ---- street market stalls (eye-blockers: top >= 2.4) ----
    ...stall(-3.2, -0.5, -9, -7, 2.4), // S1 north row (gap to C1: 1.8m)
    ...stall(0.5, 3.2, 7, 9, 2.4), // S2 south row (gap to E2: 1.6m)
    ...stall(-1.5, 1.5, -1.5, 3.5, 2.6), // S3 center (3.5m passages; z-lip cuts nook diagonals)
    ...stall(-8.5, -3.3, -3, 0, 2.5), // S4 plaza edge (covers the x=-8/-4 spawn lines + the x=-3.5 N-S lanes)
    ...stall(3.5, 8.5, -6, -3, 2.5), // S5 chapel row (covers the x=4..8 spawn lines)

    // ---- tall crate stacks (top 2.4: block the x=-2 / x=2.5 street lines) ----
    // value break within the stack: shaded lower box, sun-caught upper box
    B(-2, 0.6, 8, 1.2, 1.2, 1.2, 'crate'),
    B(-2, 1.8, 8, 1.2, 1.2, 1.2, 'crateLit'),
    B(2.5, 0.6, -8, 1.2, 1.2, 1.2, 'crate'),
    B(2.5, 1.8, -8, 1.2, 1.2, 1.2, 'crateLit'),

    // ---- market cart (courtyard south, top 1.1: cover) ----
    // four-value read: lit bed / mid undercarriage / near-black wheels / bright handle
    B(7.5, 0.85, 0.5, 2.4, 0.5, 1.2, 'crate'), // bed
    B(7.5, 0.45, 0.5, 1.8, 0.3, 0.8, 'woodDark'), // undercarriage
    B(6.8, 0.35, -0.17, 0.7, 0.7, 0.15, 'woodDeep'), // wheels (thin boxes read as discs)
    B(8.2, 0.35, -0.17, 0.7, 0.7, 0.15, 'woodDeep'),
    B(6.8, 0.35, 1.17, 0.7, 0.7, 0.15, 'woodDeep'),
    B(8.2, 0.35, 1.17, 0.7, 0.7, 0.15, 'woodDeep'),
    B(5.85, 0.8, 0.5, 0.9, 0.12, 0.12, 'crateLit'), // pull handle (west side)

    // ---- plaza well (cover mid-plaza) ----
    // street furniture drops to the DARK tier: a grey stone mass that never
    // merges with the plaster court walls behind it (37 L* apart)
    B(-9, 0.5, 3, 1.6, 1, 1.6, 'concreteDark'),

    // ---- alley low walls (in-lane cover hugging the outer block, 3.5m passage kept) ----
    B(-17.4, 0.5, 14, 0.8, 1, 2.4, 'concreteDark'),
    B(-17.4, 0.5, 6, 0.8, 1, 2.4, 'concreteDark'),
    B(-17.4, 0.5, -3, 0.8, 1, 2.4, 'concreteDark'),
    B(-17.4, 0.5, -11, 0.8, 1, 2.4, 'concreteDark'),
    B(17.4, 0.5, 15, 0.8, 1, 2.4, 'concreteDark'),
    B(17.4, 0.5, 7, 0.8, 1, 2.4, 'concreteDark'),
    B(17.4, 0.5, -1, 0.8, 1, 2.4, 'concreteDark'),
    B(17.4, 0.5, -9, 0.8, 1, 2.4, 'concreteDark'),
    B(17.4, 0.5, -16, 0.8, 1, 2.4, 'concreteDark'),

    // ---- market crates (cover along routes + spawn courts) ----
    B(-6, 0.6, 18.8, 1.2, 1.2, 1.2, 'crate'), // T court
    B(6, 0.6, 18.8, 1.2, 1.2, 1.2, 'crate'),
    B(-16.5, 0.6, 18, 1.2, 1.2, 1.2, 'crateLit'),
    B(16.5, 0.6, 18, 1.2, 1.2, 1.2, 'crateLit'),
    B(-6, 0.6, -18.8, 1.2, 1.2, 1.2, 'crate'), // CT court
    B(6, 0.6, -18.8, 1.2, 1.2, 1.2, 'crate'),
    B(-16.5, 0.6, -18, 1.2, 1.2, 1.2, 'crateLit'),
    B(16.5, 0.6, -18, 1.2, 1.2, 1.2, 'crateLit'),
    B(-11, 0.6, 6, 1.2, 1.2, 1.2, 'crate'), // plaza
    B(-12, 0.6, 1.5, 1.2, 1.2, 1.2, 'crate'), // plaza SW (clear of the plaza house)
    B(11.5, 0.6, -1, 1.2, 1.2, 1.2, 'crate'), // east courtyard
    B(-22, 0.6, -2, 1.2, 1.2, 1.2, 'crateLit'), // west nook (dark pocket: lift it)
    B(22, 0.6, 8, 1.2, 1.2, 1.2, 'crateLit'), // east nook (dark pocket: lift it)
    B(3.5, 0.6, 14, 1.2, 1.2, 1.2, 'crate'), // street south
    B(-4, 0.6, -13, 1.2, 1.2, 1.2, 'crate'), // street north
    B(-2, 0.6, -16.5, 1.2, 1.2, 1.2, 'crate'), // CT court mouth
  ],
  spawns: {
    // 7 per team across the open spawn courts (z +/- 17..21.5); alleys stay clear.
    T: [
      { x: -14, z: 20.3, yaw: 0 },
      { x: -8, z: 20.6, yaw: 0 },
      { x: -3, z: 20.9, yaw: 0 },
      { x: 0, z: 19, yaw: 0 },
      { x: 3, z: 20.9, yaw: 0 },
      { x: 8, z: 20.6, yaw: 0 },
      { x: 14, z: 20.3, yaw: 0 },
    ],
    CT: [
      { x: -14, z: -20.3, yaw: Math.PI },
      { x: -8, z: -20.6, yaw: Math.PI },
      { x: -3, z: -20.9, yaw: Math.PI },
      { x: 0, z: -19, yaw: Math.PI },
      { x: 3, z: -20.9, yaw: Math.PI },
      { x: 8, z: -20.6, yaw: Math.PI },
      { x: 14, z: -20.3, yaw: Math.PI },
    ],
  },
  // ---- §3c deco density pass -------------------------------------------------
  // Read `mapRenderer`'s sampler before touching a number here, because two of
  // its properties decide whether a zone renders anything at all:
  //   1. `target = round(count * DECO_DENSITY)` — the renderer already applies a
  //      global 1.6x, so `count` is the PRE-density request, not the prop total.
  //   2. `tooClose()` tests a candidate against the GLOBAL `placed` list using
  //      the CURRENT zone's `minSpacing`. A later zone therefore has to clear its
  //      own spacing against every prop every earlier zone dropped — including
  //      props in rects it merely overlaps. A 1.3 m band asking for 3.2 m spacing
  //      inside a corridor an earlier zone already seeded places literally zero
  //      props, silently, and the 30-attempts-per-prop budget hides it.
  // So: the narrow wall bands own their strip exclusively (the centre-lane and
  // alley rects were pulled back off them), and every band's spacing is set from
  // its own width and its props' footprints (sack r~0.6, pallet/palletStack
  // r~0.78, barrel/shrub r~0.44) rather than from the wide-open-square numbers.
  //
  // Verified by replaying the exact sampler (SOLID_PAD 0.5, SPAWN_CLEARANCE 2.5,
  // MAX_ATTEMPTS_PER_PROP 30, DECO_DENSITY 1.6, shared `placed`) over this data:
  // every zone below places >= 90% of its target, and the map renders 152 props
  // against the 77 the pre-upgrade data actually placed (+97%, inside §3c's
  // +60-100% band). The old data asked for 270 and rendered 125 of them.
  deco: [
    // market barrels: street CENTRE LANE only — x +/- 2.8 stops this rect at the
    // inner edge of the facade bands below, so the two no longer fight
    { kind: 'barrel', count: 8, x0: -2.8, z0: -15, x1: 2.8, z1: 15, minSpacing: 2.2 },
    { kind: 'barrel', count: 5, x0: -13, z0: -9, x1: -5.5, z1: 9, minSpacing: 2.4 },
    { kind: 'barrel', count: 5, x0: 5.5, z0: -11, x1: 13, z1: 3, minSpacing: 2.4 },
    // alley barrels keep to the inner half of each 4.5m alley; the 1.3m strip
    // against the outer block face belongs to the wall bands further down
    { kind: 'barrel', count: 3, x0: -15.8, z0: -19, x1: -14, z1: 19, minSpacing: 3 },
    { kind: 'barrel', count: 3, x0: 14, z0: -19, x1: 15.8, z1: 19, minSpacing: 3 },
    // shrubs dress corners, nooks and the spawn courts
    { kind: 'shrub', count: 7, x0: -27, z0: -21, x1: 27, z1: 21, minSpacing: 3 },
    { kind: 'shrub', count: 3, x0: -17, z0: -21.4, x1: 17, z1: -17.5, minSpacing: 2.5 },
    { kind: 'shrub', count: 3, x0: -17, z0: 17.5, x1: 17, z1: 21.4, minSpacing: 2.5 },
    // grain sacks slumped around the market street, plaza and courtyard stalls.
    // These share their rects with the barrel zones above, so their spacing has
    // to be a sack-vs-barrel clearance (0.6 + 0.44), not a square's 2.8.
    { kind: 'sack', count: 6, x0: -2.8, z0: -13, x1: 2.8, z1: 13, minSpacing: 1.7 },
    { kind: 'sack', count: 4, x0: -13, z0: -9, x1: -5.5, z1: 9, minSpacing: 1.7 },
    { kind: 'sack', count: 4, x0: 5.5, z0: -11, x1: 13, z1: 3, minSpacing: 1.7 },

    // ---- dead pockets: the four nooks the routes never enter -----------------
    // west of the alley, between W1 and W2
    { kind: 'sack', count: 3, x0: -26.8, z0: -4.2, x1: -18.6, z1: 0.2, minSpacing: 1.5 },
    { kind: 'palletStack', count: 2, x0: -26.8, z0: -4.2, x1: -18.6, z1: 0.2, minSpacing: 1.9 },
    // between W2 and W3 (painted market barrels)
    {
      kind: 'barrel', count: 3, x0: -26.8, z0: 9.7, x1: -18.6, z1: 12.3,
      minSpacing: 1.6, hex: PALETTE.roofRed,
    },
    // east of the alley, between X1 and X2
    { kind: 'sack', count: 3, x0: 18.6, z0: -8.3, x1: 26.8, z1: -5.2, minSpacing: 1.5 },
    // between X2 and X3
    {
      kind: 'barrel', count: 3, x0: 18.6, z0: 7.3, x1: 26.8, z1: 12.3,
      minSpacing: 1.6, hex: PALETTE.roofRed,
    },
    { kind: 'palletStack', count: 2, x0: 18.6, z0: 7.3, x1: 26.8, z1: 12.3, minSpacing: 1.7 },

    // ---- spawn-court back bands (the two biggest empty floors) ---------------
    // 1.1m strips between the block line and the spawn pads; the sampler's own
    // 2.5m spawn clearance keeps every pad itself clear. Spacing is band-width
    // scaled: these strips also carry the court shrubs of zones 6/7 above.
    { kind: 'sack', count: 3, x0: -17, z0: 17.6, x1: 17, z1: 18.7, minSpacing: 1.6 },
    { kind: 'shrub', count: 2, x0: -17, z0: 17.6, x1: 17, z1: 18.7, minSpacing: 1.5 },
    { kind: 'sack', count: 3, x0: -17, z0: -18.7, x1: 17, z1: -17.6, minSpacing: 1.6 },
    { kind: 'shrub', count: 2, x0: -17, z0: -18.7, x1: 17, z1: -17.6, minSpacing: 1.4 },

    // ---- long blank alley walls ----------------------------------------------
    // a 1.3m band off the outer block face, leaving the alley's inner 2.5m clear.
    // 1.6m spacing is what a 1.3m-wide strip can actually hold (sack r ~0.6).
    { kind: 'sack', count: 4, x0: -17.3, z0: -19, x1: -16, z1: 19, minSpacing: 1.6 },
    { kind: 'sack', count: 4, x0: 16, z0: -19, x1: 17.3, z1: 19, minSpacing: 1.6 },

    // ---- long blank street facades (C1/C2 east faces, E1/E2 west faces) ------
    // a 1.4m band each side of the 10m street. It abuts the centre-lane rects
    // (pulled back to x +/- 2.8) instead of overlapping them, so the wall band
    // and the lane scatter no longer compete for the same points.
    { kind: 'sack', count: 3, x0: -4.4, z0: -16.3, x1: -3, z1: 16.3, minSpacing: 1.6 },
    { kind: 'pallet', count: 2, x0: -4.4, z0: -16.3, x1: -3, z1: 16.3, minSpacing: 1.8 },
    { kind: 'sack', count: 3, x0: 3, z0: -16.3, x1: 4.4, z1: 16.3, minSpacing: 1.6 },
    { kind: 'pallet', count: 2, x0: 3, z0: -16.3, x1: 4.4, z1: 16.3, minSpacing: 1.8 },
  ],
  // AAA accent: roofRed is urbana's established accent (awnings + roof caps) —
  // hanging banners extend the same red rhythm onto the square-house walls
  accents: [
    // plaza house east face banner
    { x: -6.97, y: 2.2, z: -6, w: 0.06, h: 1.6, d: 0.9, hex: PALETTE.roofRed },
    // courtyard annex west face banner
    { x: 9.97, y: 2.2, z: -8, w: 0.06, h: 1.6, d: 0.9, hex: PALETTE.roofRed },
    // street-facing banners on the inner blocks
    { x: -4.97, y: 2.4, z: -13, w: 0.06, h: 1.6, d: 0.9, hex: PALETTE.roofRed },
    { x: 4.97, y: 2.4, z: -14, w: 0.06, h: 1.6, d: 0.9, hex: PALETTE.roofRed },
    // alley-facing banners on the outer ring's blank faces (W1 east, X2 west) —
    // the only warm accent in an otherwise uniform brick alley
    { x: -17.97, y: 3, z: -13, w: 0.06, h: 1.6, d: 0.9, hex: PALETTE.roofRed },
    { x: 17.97, y: 3, z: 1, w: 0.06, h: 1.6, d: 0.9, hex: PALETTE.roofRed },
    // court-facing banners on C2 / E2 (thin in z: these hang off a z-face)
    { x: -9.5, y: 3, z: 9.97, w: 0.9, h: 1.6, d: 0.06, hex: PALETTE.roofRed },
    { x: 9.5, y: 2.6, z: 1.97, w: 0.9, h: 1.6, d: 0.06, hex: PALETTE.roofRed },
  ],
  // §1 S3 — skyline ring: the town continues past the walls. The height band is
  // deliberately narrow (5..6.5m) and the radius band shallow (42..62m) so a
  // BACK rank can never subtend more angle than a FRONT rank: worst-case back
  // tip = 7.2 deg above eye, best-case front tip = 7.5 deg. Tips therefore
  // cannot poke over their own front ranks, which is what produced the pale
  // "floating diamonds". Both tiers are dark (brickDeep body, roofRed caps), so
  // the ring silhouettes against the sky instead of glinting out of it.
  skyline: {
    hex: PALETTE.brickDeep,
    capHex: PALETTE.roofRed,
    count: 14,
    minR: 42,
    maxR: 62,
    minH: 5,
    maxH: 6.5,
  },
};
