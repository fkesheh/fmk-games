// Map: FROSTBITE (task M3) — snowfield. Playability invariants (checked by reviewers):
//   - enclosed by h=5 walls with no gaps (snow-banked valley sides)
//   - 3 lanes from T spawn (south) to CT spawn (north): west / mid / east, linked by
//     two gaps per ice-ridge divider (south gap z 8..12, frozen creek z -9.2..-0.8)
//   - frozen creek gully: 0.6-deep trench (snow banks) with ice floor; crossed by
//     jumping the banks or via 0.4 step boxes at x = -21 / -6 / 6 / 21. Each of
//     those four lanes carries FOUR steps, mirrored about the creek midline
//     z = -5, so the walk-across works north->south as well as south->north
//     (a 0.6 bank is above PLAYER.stepUp 0.42 and needs a step on the face you
//     approach from). Asserted in maps/sightline.test.ts.
//   - no T spawn visible from any CT spawn (twin ice screens at z=+-15 block all pairs)
//   - cover (h>=0.9) at least every 8m along each lane; longest open sightline 41.4m <= 42m
//     (bank-top creek lane capped by h=2.5 dam/boulders; gap-mouth diagonal by w=5 ice spikes)
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
  // VALUE LADDER (VISUAL_UPGRADE.md §1/§3a). Frostbite is DECLARED MONOCHROME:
  // exempt from L4, so value carries the whole frame and must clear L1 >= 28.
  //   snowLit  L 98  sun-hit caps (trim tier, emitted by articulate())
  //   snow     L 89  MAIN WALL / L1 reference — the snow-banked valley sides
  //   ice      L 79  ridges, screens, creek floor: the mid tier
  //   snowShadow L 59  GROUND (floorMat + theme.ground)
  //   rock     L 33  dark anchor masses only (clusters, dam, boulders)
  //   rockDeep L 20  the darkest accents (satellite boulders, contact band)
  // L1 = 89.4 - 59.3 = 30.1 >= 28. `concrete` (L 58) is deliberately GONE from
  // this map: it sits level with the ground and would flatten the frame.
  floorMat: 'snowShadow',
  theme: {
    // S1: zenith is 21.3 L darker than the horizon and far cooler
    // (blueBias 62 vs 20). S2: fog === horizon. S4: ground !== horizon.
    skyHigh: PALETTE.skyColdHigh, // L 64 zenith
    sky: PALETTE.skyCold, // L 81 mid (also the OUTDOOR_GRADES key for this map)
    horizon: PALETTE.fogCold, // L 86 bright arctic haze band
    ground: PALETTE.snowShadow, // L 59 — matches floorMat, reads under the haze
    fog: PALETTE.fogCold, // S2: exactly the horizon stop
    fogDensity: 0.018, // unchanged: long-sightline visibility is a playability value
    sunDir: [0.3, -1, 0.4],
    sunColor: PALETTE.ice,
    // §3d: hemi DOWN, sun UP. Total light is held (1.4*1.3 + 0.55*1.1 = 2.43 vs
    // the old 2.50, so snow does not blow out) while the key/fill ratio goes
    // 1.7 -> 3.0 and the sun's shadows finally register on the snowfield.
    sunIntensity: 1.4,
    hemiIntensity: 0.55,
  },
  boxes: [
    // ---- outer walls (h=5, snow-banked valley sides = the L1 reference wall) ----
    { x: 0, y: 2.5, z: -D / 2, w: W + 2, h: 5, d: 1, mat: 'snow' },
    { x: 0, y: 2.5, z: D / 2, w: W + 2, h: 5, d: 1, mat: 'snow' },
    { x: -W / 2, y: 2.5, z: 0, w: 1, h: 5, d: D + 2, mat: 'snow' },
    { x: W / 2, y: 2.5, z: 0, w: 1, h: 5, d: D + 2, mat: 'snow' },

    // ---- ice-ridge lane dividers (x=+-12; gaps: creek z -9.2..-0.8, south z 8..12) ----
    { x: -12, y: 1.2, z: -12.1, w: 2.5, h: 2.4, d: 5.8, mat: 'ice' },
    { x: -12, y: 1.2, z: 3.6, w: 2.5, h: 2.4, d: 8.8, mat: 'ice' },
    { x: -12, y: 1.2, z: 14, w: 2.5, h: 2.4, d: 4, mat: 'ice' },
    { x: 12, y: 1.2, z: -12.1, w: 2.5, h: 2.4, d: 5.8, mat: 'ice' },
    { x: 12, y: 1.2, z: 3.6, w: 2.5, h: 2.4, d: 8.8, mat: 'ice' },
    { x: 12, y: 1.2, z: 14, w: 2.5, h: 2.4, d: 4, mat: 'ice' },

    // ice spikes guarding the south gap mouths (break x=+-14.5 lanes + the 42m
    // connector diagonal; w=5 keeps the z 9..11 crossing >= 12m wide)
    { x: -14.5, y: 1.3, z: 10, w: 5, h: 2.6, d: 2, mat: 'ice' },
    { x: 14.5, y: 1.3, z: 10, w: 5, h: 2.6, d: 2, mat: 'ice' },

    // ---- spawn screen ice ridges (block every T<->CT spawn sightline) ----
    { x: 0, y: 1.5, z: 15, w: 18, h: 3, d: 1.5, mat: 'ice' },
    { x: 0, y: 1.5, z: -15, w: 18, h: 3, d: 1.5, mat: 'ice' },

    // ---- quadrant rock clusters (lane screens + diagonal sightline breakers) ----
    // `rock` (L 33) is the map's DARK ANCHOR: 26 L below the ground and 56 below
    // the walls, so these masses read as hard silhouettes in the whiteout.
    { x: -20, y: 1.25, z: 15, w: 10.5, h: 2.5, d: 2.5, mat: 'rock' },
    { x: 20, y: 1.25, z: 15, w: 10.5, h: 2.5, d: 2.5, mat: 'rock' },
    { x: -20, y: 1.25, z: -15, w: 10.5, h: 2.5, d: 2.5, mat: 'rock' },
    { x: 20, y: 1.25, z: -15, w: 10.5, h: 2.5, d: 2.5, mat: 'rock' },
    // corner formations sealing the spawn strips (merge with the screens above);
    // rockDeep = the secondary, darker mass so the corners do not read as one slab
    { x: -20, y: 1.25, z: 18.5, w: 3, h: 2.5, d: 6, mat: 'rockDeep' },
    { x: 20, y: 1.25, z: 18.5, w: 3, h: 2.5, d: 6, mat: 'rockDeep' },
    { x: -20, y: 1.25, z: -18.5, w: 3, h: 2.5, d: 6, mat: 'rockDeep' },
    { x: 20, y: 1.25, z: -18.5, w: 3, h: 2.5, d: 6, mat: 'rockDeep' },

    // ---- frozen creek gully (channel z -8..-2, floor 0.6 below bank tops) ----
    { x: 0, y: 0.03, z: -5, w: 58, h: 0.06, d: 6, mat: 'ice' }, // ice floor
    { x: 0, y: 0.3, z: -1.4, w: 58, h: 0.6, d: 1.2, mat: 'snow' }, // south bank
    { x: 0, y: 0.3, z: -8.6, w: 58, h: 0.6, d: 1.2, mat: 'snow' }, // north bank
    { x: 0, y: 1.25, z: -5, w: 3, h: 2.5, d: 8.8, mat: 'rock' }, // dam rock jammed mid creek
    { x: -17.5, y: 1.25, z: -5, w: 2.5, h: 2.5, d: 3, mat: 'rock' }, // creek boulders
    { x: 17.5, y: 1.25, z: -5, w: 2.5, h: 2.5, d: 3, mat: 'rock' },
    { x: -27.5, y: 1.1, z: -2, w: 4, h: 2.2, d: 3, mat: 'rockDeep' }, // creek-mouth rocks
    { x: 27.5, y: 1.1, z: -2, w: 4, h: 2.2, d: 3, mat: 'rockDeep' },
    // step crossings (ground -> 0.4 step -> 0.6 bank), FOUR boxes per lane so the
    // crossing is symmetric about the creek's midline z = -5. Both banks are 0.6
    // tall and PLAYER.stepUp is 0.42, so a bank is only WALKABLE from a face that
    // has a step against it. The original set had steps on the south face of the
    // south bank and the south face of the north bank only, which made all four
    // crossings one-way south->north: a T walked over, a CT had to jump both
    // banks. The two boxes added per lane are the exact mirrors of the two that
    // were already here (z -0.3 <-> -9.7 on ground = `snow`, z -7.5 <-> -2.5
    // inside the creek = `ice`). Proven both ways by the stepUp-limited flood
    // fill in maps/sightline.test.ts. No existing box moved.
    { x: -21, y: 0.2, z: -0.3, w: 2.4, h: 0.4, d: 1, mat: 'snow' },
    { x: -21, y: 0.2, z: -2.5, w: 2.4, h: 0.4, d: 1, mat: 'ice' },
    { x: -21, y: 0.2, z: -7.5, w: 2.4, h: 0.4, d: 1, mat: 'ice' },
    { x: -21, y: 0.2, z: -9.7, w: 2.4, h: 0.4, d: 1, mat: 'snow' },
    { x: -6, y: 0.2, z: -0.3, w: 2.4, h: 0.4, d: 1, mat: 'snow' },
    { x: -6, y: 0.2, z: -2.5, w: 2.4, h: 0.4, d: 1, mat: 'ice' },
    { x: -6, y: 0.2, z: -7.5, w: 2.4, h: 0.4, d: 1, mat: 'ice' },
    { x: -6, y: 0.2, z: -9.7, w: 2.4, h: 0.4, d: 1, mat: 'snow' },
    { x: 6, y: 0.2, z: -0.3, w: 2.4, h: 0.4, d: 1, mat: 'snow' },
    { x: 6, y: 0.2, z: -2.5, w: 2.4, h: 0.4, d: 1, mat: 'ice' },
    { x: 6, y: 0.2, z: -7.5, w: 2.4, h: 0.4, d: 1, mat: 'ice' },
    { x: 6, y: 0.2, z: -9.7, w: 2.4, h: 0.4, d: 1, mat: 'snow' },
    { x: 21, y: 0.2, z: -0.3, w: 2.4, h: 0.4, d: 1, mat: 'snow' },
    { x: 21, y: 0.2, z: -2.5, w: 2.4, h: 0.4, d: 1, mat: 'ice' },
    { x: 21, y: 0.2, z: -7.5, w: 2.4, h: 0.4, d: 1, mat: 'ice' },
    { x: 21, y: 0.2, z: -9.7, w: 2.4, h: 0.4, d: 1, mat: 'snow' },

    // ---- mid lane cover ----
    { x: 0, y: 1.1, z: 3, w: 4, h: 2.2, d: 3, mat: 'ice' }, // central ice block
    { x: 0, y: 1.1, z: 10, w: 3, h: 2.2, d: 4.5, mat: 'ice' }, // gap-mouth block
    { x: -5, y: 0.95, z: 6, w: 2.5, h: 1.9, d: 2.5, mat: 'ice' },
    { x: 5, y: 0.95, z: 6, w: 2.5, h: 1.9, d: 2.5, mat: 'ice' },
    { x: -5, y: 0.95, z: -11, w: 2.5, h: 1.9, d: 3, mat: 'ice' },
    { x: 5, y: 0.95, z: -11, w: 2.5, h: 1.9, d: 3, mat: 'ice' },
    // bank-side ridges (z -1.05..4.95: cap the west-lane -> east-divider diagonal at ~39m)
    { x: -9.5, y: 1, z: 1.95, w: 2.5, h: 2, d: 6, mat: 'ice' },
    { x: 9.5, y: 1, z: 1.95, w: 2.5, h: 2, d: 6, mat: 'ice' },

    // ---- west lane cover (rock cluster + snowdrifts) ----
    { x: -24, y: 1, z: 2.5, w: 3, h: 2, d: 2.5, mat: 'rock' },
    { x: -25.5, y: 0.6, z: 4.2, w: 1.6, h: 1.2, d: 1.6, mat: 'rockDeep' },
    { x: -24, y: 0.45, z: 8, w: 4, h: 0.9, d: 2, mat: 'snow' },
    { x: -17, y: 0.45, z: 4, w: 3.5, h: 0.9, d: 2, mat: 'snow' },
    { x: -24, y: 0.45, z: -12, w: 4, h: 0.9, d: 2, mat: 'snow' },
    { x: -17, y: 0.45, z: -11, w: 3.5, h: 0.9, d: 2, mat: 'snow' },

    // ---- east lane cover (mirror of west) ----
    { x: 24, y: 1, z: 2.5, w: 3, h: 2, d: 2.5, mat: 'rock' },
    { x: 25.5, y: 0.6, z: 4.2, w: 1.6, h: 1.2, d: 1.6, mat: 'rockDeep' },
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
    { kind: 'snowRock', count: 8, x0: -29, z0: -21, x1: -20, z1: 21, minSpacing: 4 },
    { kind: 'snowRock', count: 8, x0: 20, z0: -21, x1: 29, z1: 21, minSpacing: 4 },
    { kind: 'snowRock', count: 10, x0: -13, z0: -21, x1: 13, z1: 21, minSpacing: 5 },
    { kind: 'snowRock', count: 10, x0: -13, z0: -20, x1: 13, z1: 20, minSpacing: 5 },
    { kind: 'shrub', count: 48, x0: -29, z0: -21, x1: 29, z1: 21, minSpacing: 3.5 },
    // AAA pass: frost-shard clusters at the ice-ridge feet and along the
    // frozen creek banks (appended — earlier zone indices/seeds unchanged;
    // solid rejection keeps the ridges themselves clear)
    { kind: 'icicle', count: 16, x0: -14.5, z0: -16, x1: -9.5, z1: 17, minSpacing: 3 },
    { kind: 'icicle', count: 16, x0: 9.5, z0: -16, x1: 14.5, z1: 17, minSpacing: 3 },
    { kind: 'icicle', count: 10, x0: -28, z0: -10, x1: 28, z1: 1, minSpacing: 5 },
    // ---- §3c density pass: 90 -> 171 props ON THE GROUND (+90.0%) -------------
    // MEASURED by re-running mapRenderer.ts's rejection sampler (DECO_DENSITY
    // 1.6, MAX_ATTEMPTS_PER_PROP 30, one shared `placed` array), NOT by summing
    // `count`. That distinction is the whole point here: this map was already
    // scatter-saturated at freeze, so raising declared counts alone bought almost
    // nothing — an earlier revision of this block declared 278 props and still
    // landed only 112 (+24% on the ground, against a +60-100% brief). Density on
    // this map is a SPACING budget, not a number in the data.
    // Two properties make the zones below actually land their props:
    //   - minSpacing 1.6-1.9. `tooClose()` tests each candidate against every
    //     prop already placed map-wide, so a new zone at 2.6-3.2 m was rejected
    //     by the legacy zones' own props before it could use the gaps between
    //     them. Icicles and shrubs are 0.3-0.9 m props; at 1.6-1.9 m they read as
    //     a frost cluster, which is the intent, not as a pile.
    //   - the rects sit on ground the legacy zones do not saturate: the four back
    //     corner pockets behind the quadrant clusters, the wall-hugging margins,
    //     and the two flank scree skirts. Still DEAD ground — no running lane,
    //     gap mouth or cover pocket gains a single prop.
    // Appended, so zones 0-9 keep their indices, seeds and exact freeze-era
    // scatter (90 props) and everything below is pure addition (+81).
    // Non-collidable; `insideSolid` + `nearSpawn` rejection keeps solids/spawns clear.
    // back corner pockets (behind the quadrant clusters, |z| 16..21): +34 props
    { kind: 'snowRock', count: 10, x0: -29, z0: -21, x1: -14, z1: -16, minSpacing: 1.9 },
    { kind: 'snowRock', count: 10, x0: 14, z0: -21, x1: 29, z1: -16, minSpacing: 1.9 },
    { kind: 'snowRock', count: 10, x0: -29, z0: 16, x1: -14, z1: 21, minSpacing: 1.9 },
    { kind: 'snowRock', count: 10, x0: 14, z0: 16, x1: 29, z1: 21, minSpacing: 1.9 },
    // frost shards along the blank outer walls; the strips stop short of the wall
    // solids' 0.5 m rejection pad. The end-wall strips are clipped to |x| <= 13.5
    // and the side-wall strips to |z| <= 15.5 so they do not re-fight the corner
    // pockets above for the same ground (whoever runs first simply wins it).
    { kind: 'icicle', count: 4, x0: -13.5, z0: -20.9, x1: 13.5, z1: -19.2, minSpacing: 1.6 },
    { kind: 'icicle', count: 4, x0: -13.5, z0: 19.2, x1: 13.5, z1: 20.9, minSpacing: 1.6 },
    { kind: 'icicle', count: 8, x0: -28.9, z0: -15.5, x1: -27.2, z1: 15.5, minSpacing: 1.6 },
    { kind: 'icicle', count: 8, x0: 27.2, z0: -15.5, x1: 28.9, z1: 15.5, minSpacing: 1.6 },
    // dead scrub in the flank-wall margins (outboard of the flank cover line at
    // x = +-24, so the flank running lane itself stays visually clean)
    { kind: 'shrub', count: 9, x0: -28.8, z0: -15, x1: -25, z1: 15, minSpacing: 1.6 },
    { kind: 'shrub', count: 9, x0: 25, z0: -15, x1: 28.8, z1: 15, minSpacing: 1.6 },
    // organic clustering around the two flank rock formations (scree skirts)
    { kind: 'snowRock', count: 4, x0: -27, z0: 0, x1: -21, z1: 9, minSpacing: 1.7 },
    { kind: 'snowRock', count: 4, x0: 21, z0: 0, x1: 27, z1: 9, minSpacing: 1.7 },
  ],
  // §1 S3: a two-tier snow-ridge backdrop ring. Frostbite had NO SkylineDef at
  // all, so once F7 removes `stripSkylineCaps()` its sky would be empty.
  // Tuned so tips CANNOT read as floating diamonds:
  //   - minR 44 >= scene.ts SKYLINE_INNER_RADIUS (42), so the shadow cascade's
  //     near plane still clips the ring and it never shadows the playable area;
  //   - the height band is deliberately narrow (6.4..7.4 => tips 8.3..11.0 m),
  //     so a back-rank tip can only clear a front rank by ~0.7 deg — a ridgeline
  //     nuance, not a detached shape;
  //   - count 18 over a ~320 m ring makes the silhouettes overlap into one ridge;
  //   - both tiers (L 49 / L 59) sit far BELOW the L 86 horizon haze, so the ring
  //     reads as a dark silhouette against the sky — a pale cap is what produced
  //     the diamonds in the first place.
  skyline: {
    hex: PALETTE.snowDeep,
    capHex: PALETTE.snowShadow,
    count: 18,
    minR: 44,
    maxR: 58,
    minH: 6.4,
    maxH: 7.4,
  },
  // AAA accent: rescue amber (hazardAmber) — dam marker plate, gap-spike markers,
  // creek-crossing step stripes: safety color against the snowfield
  accents: [
    // dam rock marker (south face, visible up the creek lane)
    { x: 0, y: 1.3, z: -0.56, w: 1.6, h: 1.0, d: 0.06, hex: PALETTE.hazardAmber },
    // south-gap spike markers (south faces)
    { x: -14.5, y: 1.4, z: 11.04, w: 1.8, h: 0.8, d: 0.06, hex: PALETTE.hazardAmber },
    { x: 14.5, y: 1.4, z: 11.04, w: 1.8, h: 0.8, d: 0.06, hex: PALETTE.hazardAmber },
    // creek step-crossing edge stripes — one on the OUTWARD face of each approach
    // step, so the crossing advertises itself from whichever side you arrive on.
    // Same mirror about z = -5 as the step boxes, same existing hazardAmber: no
    // new hex enters the map, so the value ladder is untouched.
    { x: -21, y: 0.42, z: 0.23, w: 2.44, h: 0.1, d: 0.06, hex: PALETTE.hazardAmber },
    { x: -6, y: 0.42, z: 0.23, w: 2.44, h: 0.1, d: 0.06, hex: PALETTE.hazardAmber },
    { x: 6, y: 0.42, z: 0.23, w: 2.44, h: 0.1, d: 0.06, hex: PALETTE.hazardAmber },
    { x: 21, y: 0.42, z: 0.23, w: 2.44, h: 0.1, d: 0.06, hex: PALETTE.hazardAmber },
    { x: -21, y: 0.42, z: -10.23, w: 2.44, h: 0.1, d: 0.06, hex: PALETTE.hazardAmber },
    { x: -6, y: 0.42, z: -10.23, w: 2.44, h: 0.1, d: 0.06, hex: PALETTE.hazardAmber },
    { x: 6, y: 0.42, z: -10.23, w: 2.44, h: 0.1, d: 0.06, hex: PALETTE.hazardAmber },
    { x: 21, y: 0.42, z: -10.23, w: 2.44, h: 0.1, d: 0.06, hex: PALETTE.hazardAmber },
  ],
};
