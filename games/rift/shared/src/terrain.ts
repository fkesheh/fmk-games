// ============================================================================
// ANCIENTS (rift) — TERRAIN (TERRAIN_CONTRACT §2-3). Pure math/data, no I/O,
// no rng, no clock. The SAME grid feeds the server's sim and the client's
// renderer: terrain is NEVER sent on the wire (§1), both sides call
// buildTerrain(lanes) independently and MUST agree bit-for-bit.
//
// DETERMINISM — why this file is written the way it is:
//  - buildTerrain(lanes) is a pure function of the lane count alone. Every
//    choice that could have been random is a hash of `lanes` plus a salt
//    (hash32 below), so there is no rng stream for the two sides to keep in
//    step and no seeding order to get wrong.
//  - ONLY exactly-specified floating point appears in the geometry: + - * /,
//    Math.sqrt, Math.floor, Math.abs, Math.min/max, comparisons, and the
//    spec-valued constant Math.SQRT1_2. Math.sin/cos/hypot/pow/atan2 are
//    IMPLEMENTATION-APPROXIMATED in ECMAScript — V8 (server, Chrome) and
//    JavaScriptCore/SpiderMonkey (client) may differ by an ulp, and one ulp at
//    a cell boundary flips that cell's kind and desyncs the match. sqrt is
//    IEEE-754 correctly rounded, so distances are compared squared or through
//    sqrt, never through hypot. (map.ts uses hypot only for structure
//    positions, which travel on the wire; terrain does not.)
//  - Mirror symmetry (§3, validateMap rule 6) is enforced, not hoped for:
//    every feature is chosen inside TEAM 0's HALF and point-reflected through
//    the map centre, and mirrorCanonical() copies each canonical cell over its
//    partner after every float paint. Rule 6 therefore holds EXACTLY, not to a
//    tolerance, whatever the last bit of a distance did.
//
// LAYOUT PIPELINE (buildTerrain, in order — each stage's rationale is at its
// own definition):
//   1  river band, lane corridors, base platforms      (analytic paint)
//   2  jungle census: the cells that are none of those (§7's coverage domain)
//   3  jungle plateaus, greedily placed to HIGH_GROUND_COVERAGE
//   4  cliff rings: every low cell orthogonally touching high ground
//   5  ramps: lane mouths through the base rings, one access per plateau
//   6  repair: fill concave traps (§3.4) and sealed pockets (§3.3)
//   7  foliage clumps to FOLIAGE_COVERAGE
//   8  neutral camps: sites, then the clearings they carve
//   9  landmark anchors for the renderer (STYLE_BIBLE §8)
// Stages 4, 6 are integer neighbourhood/flood operations on an already
// symmetric grid, so they are symmetric by construction; the float stages are
// followed by mirrorCanonical().
// ============================================================================
import {
  BASE_INSET,
  BASE_PLATFORM_RADIUS,
  CAMPS_PER_HALF,
  CAMP_LANE_CLEARANCE,
  FOLIAGE_COVERAGE,
  HIGH_GROUND_COVERAGE,
  LANE_CORRIDOR_HALF_W,
  LANE_EDGE_INSET,
  MAP_SIDE_BASE,
  MAP_SIDE_PER_LANE,
  MAX_LANES,
  MIN_LANES,
  RAMP_WIDTH,
  RIVER_BAND_W,
} from './config.js';
import type { TeamId, Vec2 } from './types.js';

// ---- the data model (TERRAIN_CONTRACT §2) ------------------------------------

/** Two walkable levels only. DESIGN_DELTA §1: a continuous heightfield makes
 *  the vision and miss rules unreadable. Visual relief is a renderer concern
 *  and must never contradict the gameplay level returned here. */
export const ELEV_LOW = 0;
export const ELEV_HIGH = 1;
export type Elevation = 0 | 1;

/** Terrain classification per cell. Exactly one kind per cell. */
export type TerrainKind =
  | 'ground' // open low ground
  | 'lane' // lane corridor; always ELEV_LOW, always passable, never foliage
  | 'high' // high-ground plateau
  | 'cliff' // impassable transition between levels; blocks movement, not vision
  | 'river' // low ground, passable, purely visual/navigational (DESIGN_DELTA §4)
  | 'foliage' // passable low ground that grants concealment
  | 'ramp' // passable low->high transition; the only legal crossing of a cliff ring
  | 'base'; // team base platform; ELEV_HIGH, passable

/** The code table `TerrainGrid.kind` indexes, in the declaration order of
 *  {@link TerrainKind}. Exported because a consumer that walks the grid itself
 *  — the terrain mesh baker, the minimap — wants the numeric code, not eight
 *  string comparisons per cell; `kindAt` is the O(1) query for everyone else.
 *  The order is part of the frozen data model: appending is a contract change,
 *  reordering is a desync. */
export const TERRAIN_KINDS: readonly TerrainKind[] = [
  'ground',
  'lane',
  'high',
  'cliff',
  'river',
  'foliage',
  'ramp',
  'base',
];

// Numeric codes, kept in lockstep with TERRAIN_KINDS above. Everything inside
// this file works in codes; only kindAt() converts back to the string.
const K_GROUND = 0;
const K_LANE = 1;
const K_HIGH = 2;
const K_CLIFF = 3;
const K_RIVER = 4;
const K_FOLIAGE = 5;
const K_RAMP = 6;
const K_BASE = 7;

export interface TerrainGrid {
  readonly side: number; // metres; equals MapDef.side
  readonly res: number; // cells per metre — frozen at 1
  readonly dim: number; // side * res, the row/column count
  /** dim*dim, values index TERRAIN_KINDS. Row-major in z: the cell holding
   *  world (x,z) is at `z * dim + x` at the frozen res = 1. */
  readonly kind: Uint8Array;
  readonly elev: Uint8Array; // dim*dim, ELEV_LOW | ELEV_HIGH
}

export interface CampDef {
  readonly id: number; // stable, dense from 0
  readonly tier: 'pack' | 'brute' | 'hive';
  readonly x: number; // clearing centre
  readonly z: number;
  /** Which half the camp sits in, for mirroring and validation only. Camps are
   *  NEUTRAL and are never owned by this team. */
  readonly half: TeamId;
}

export interface TerrainDef {
  readonly grid: TerrainGrid;
  readonly camps: readonly CampDef[];
  /** Hand-placed landmark anchors for the renderer (STYLE_BIBLE §8).
   *  Gameplay-inert: nothing in the sim reads them, and validateMap does not
   *  constrain them. Exactly four set-piece kinds are ever emitted, and R_MAPMESH
   *  may switch on this list exhaustively:
   *   - `'riverArch'`      one only, a collapsed arch standing in the river band
   *                        off the map centre — the map's one asymmetric feature
   *                        and the thing players mean by "the arch".
   *   - `'standingStones'` one per half, on the plateau nearest that team's base;
   *                        a stone ring on bare high ground (STYLE_BIBLE §8).
   *   - `'fallenColossus'` one per half, lying in open LOW jungle — never on a
   *                        plateau, never on a camp, never on a lane.
   *   - `'ruinedGate'`     one per half, straddling lane 0's polyline where it
   *                        leaves the base ramp. It is an ARCH over the lane:
   *                        the corridor under it stays walkable, and the mesh
   *                        must not read as a wall.
   *  Every anchor except `'riverArch'` is emitted as an exact mirrored pair. */
  readonly landmarks: readonly {
    readonly kind: string;
    readonly x: number;
    readonly z: number;
  }[];
}

// ---- the frozen queries (TERRAIN_CONTRACT §2) --------------------------------
// All O(1): two clamps, one multiply-add, one typed-array read. No scan, no
// polygon test, no allocation — they run per unit per tick inside the
// O(sources x mobiles) vision loop measured against the 2.5 ms tick budget.
// Out-of-bounds coordinates clamp to the nearest in-bounds cell: callers pass
// already-clamped positions, but a NaN or a dash overshoot must degrade to the
// map edge, never throw and never return undefined.

/** Grid column (or row) holding world coordinate `v`, clamped into [0, dim-1].
 *  The `!(i > 0)` form also catches NaN, which `i < 0` would not. */
function axisCell(v: number, res: number, dim: number): number {
  const i = Math.floor(v * res);
  if (!(i > 0)) return 0;
  return i > dim - 1 ? dim - 1 : i;
}

/** Linear index of the cell containing world (x,z). */
function cellOf(g: TerrainGrid, x: number, z: number): number {
  return axisCell(z, g.res, g.dim) * g.dim + axisCell(x, g.res, g.dim);
}

/** World centre of cell `i` on either axis — the point every painter and every
 *  validator samples, so a cell is addressed by position and never by index
 *  arithmetic outside this file. The mirror of a centre is exactly another
 *  centre: side - (i + 0.5) is the centre of cell dim-1-i at res = 1. */
function cellMid(i: number, res: number): number {
  return (i + 0.5) / res;
}

/**
 * Gameplay elevation at a world point. **A `'ramp'` cell returns `ELEV_HIGH`**
 * (§3): a transitional value would make the uphill vision block and the uphill
 * miss chance non-deterministic exactly at the boundary where they are read.
 * A `'cliff'` returns `ELEV_LOW` — nothing can stand on one, and the wall face
 * belongs to the low ground it rises from.
 */
export function elevationAt(t: TerrainDef, x: number, z: number): Elevation {
  return t.grid.elev[cellOf(t.grid, x, z)] === ELEV_HIGH ? ELEV_HIGH : ELEV_LOW;
}

/** Terrain classification at a world point. The two `undefined` branches are
 *  unreachable — the index is clamped and every stored code is a valid index —
 *  but `noUncheckedIndexedAccess` requires them narrowed rather than asserted,
 *  and open low ground is the only safe default for a query the movement code
 *  trusts. */
export function kindAt(t: TerrainDef, x: number, z: number): TerrainKind {
  const code = t.grid.kind[cellOf(t.grid, x, z)];
  const kind = code === undefined ? undefined : TERRAIN_KINDS[code];
  return kind === undefined ? 'ground' : kind;
}

/** Movement test: everything except `'cliff'` is walkable, including `'ramp'`,
 *  `'river'` and `'foliage'` (§3). Compares the stored code directly — the
 *  string round-trip through `kindAt` is pure overhead in the hot path. */
export function isPassable(t: TerrainDef, x: number, z: number): boolean {
  return t.grid.kind[cellOf(t.grid, x, z)] !== K_CLIFF;
}

/** Concealment test: `'foliage'` and nothing else (§3, DESIGN_DELTA §3). */
export function isConcealing(t: TerrainDef, x: number, z: number): boolean {
  return t.grid.kind[cellOf(t.grid, x, z)] === K_FOLIAGE;
}

// ---- the deterministic hash (TERRAIN_CONTRACT §4) ----------------------------

/** murmur3's 32-bit finalizer: an avalanche mix in which every input bit flips
 *  every output bit with probability ~0.5. `Math.imul` is exact 32-bit integer
 *  multiplication on every engine, so this is bit-identical everywhere — which
 *  is the whole point of using it instead of an rng stream. */
function mix32(h: number): number {
  let v = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  v = Math.imul(v ^ (v >>> 13), 0xc2b2ae35);
  return (v ^ (v >>> 16)) >>> 0;
}

/** Avalanche hash of three integers. The three inputs enter through DIFFERENT
 *  odd multipliers, so hash32(a,b,c) !== hash32(a,c,b) — an attacker and its
 *  target must not be interchangeable. */
function hash32(a: number, b: number, c: number): number {
  let h = mix32(0x9e3779b9 ^ (a | 0));
  h = mix32(h ^ Math.imul(b | 0, 0x85ebca6b));
  return mix32(h ^ Math.imul(c | 0, 0xc2b2ae35));
}

/** A uint32 as a double in [0,1). Takes the top 24 bits, which is every bit a
 *  double's mantissa can hold exactly, and scales by an exact power of two —
 *  so the conversion itself introduces no engine-dependent rounding. */
function frac01(h: number): number {
  return (h >>> 8) * 2 ** -24;
}

/**
 * Deterministic, reproducible, uniform-enough in [0,1). The ONLY randomness
 * source in combat resolution (TERRAIN_CONTRACT §4): `combat.ts`'s `fire()`
 * misses when `missRoll(tick, attacker, target) < HIGH_GROUND_MISS` and the
 * attacker stands below its target.
 *
 * Same inputs -> same result, on every machine, in every replay, in every test
 * run. It consumes no world state and advances nothing, so a miss cannot shift
 * an rng stream and desync a replay — `createWorld` deliberately discards its
 * `rand`, and `balance.test.ts` measures win-rate bands over headless bot
 * matches that depend on that. Integer math only: no floats enter the mix, and
 * `Math.random` appears nowhere under `games/rift/`.
 *
 * `attacker` and `target` are sim `EntId`s (a plain number alias; shared cannot
 * import from the server package). Negative ids such as `NO_ENT` are fine —
 * `| 0` keeps them as two's-complement 32-bit patterns.
 */
export function missRoll(tick: number, attacker: number, target: number): number {
  return frac01(hash32(tick, attacker, target));
}

// ---- layout constants --------------------------------------------------------
// config.ts holds the FROZEN inputs (corridor width, platform radius, river
// width, the two coverage fractions, camp clearance). The constants below are
// this file's mechanism for serving them: shapes and spacings that no other
// module can see and that no balance target names. Every one of them exists to
// satisfy a numbered rule in TERRAIN_CONTRACT §3.

/** Cells per metre. Frozen at 1 by §2, so `dim === side` and a cell index is a
 *  metre index. Kept as a named factor rather than inlined so every conversion
 *  in the file reads as a conversion. */
const TERRAIN_RES = 1;

/** Radius of a plateau's main disc. A plateau is that disc plus two smaller
 *  hash-placed lobes (see plateauDiscs), so it reads as carved ground rather
 *  than as a stamped circle, while staying star-shaped about its centre — a
 *  crescent or a dumbbell would produce deep concave armpits in the low ground
 *  around it, which is exactly what §3.4 forbids. 7 m of top plus its ring is
 *  the smallest plateau that still holds a camp clearing and a fight. */
const PLATEAU_R = 7;
/** Four sizes, tried largest first. The large plateaus claim what open jungle
 *  there is; each smaller size then fills the pockets the larger ones'
 *  clearances could not reach. One size alone stalls at HALF of
 *  HIGH_GROUND_COVERAGE — the jungle between lanes is cut into strips too
 *  narrow for a 7 m mesa, and DESIGN_DELTA §1 wants every jungle quadrant to
 *  have high ground worth holding, not two big plateaus and a featureless
 *  remainder. All four keep the same proportions, so one piece of clearance
 *  arithmetic serves them all. */
const PLATEAU_RADII: readonly number[] = [
  PLATEAU_R,
  PLATEAU_R * 0.8,
  PLATEAU_R * 0.62,
  PLATEAU_R * 0.45,
];
/** Lobe size and offset as fractions of the main disc. Chosen so the union
 *  nearly FILLS its own footprint disc (~92%): the footprint is what every
 *  clearance and every neighbour keeps away from, so a lobe arrangement that
 *  reserves ground it does not paint spends the coverage budget on nothing.
 *  The offset stays at most half the lobe radius, which keeps the union
 *  star-shaped about its centre — the shape law in plateauDiscs. */
const PLATEAU_LOBE_SCALE = 0.8;
const PLATEAU_LOBE_OFF_SCALE = 0.4;
/** Footprint radius of a plateau of main-disc radius `r`: no painted cell lies
 *  further than this from its centre, so every clearance is one number. */
function plateauExtent(r: number): number {
  return r * (PLATEAU_LOBE_OFF_SCALE + PLATEAU_LOBE_SCALE);
}
/** Walkable metres that must remain between a plateau's cliff ring and any
 *  other impassable thing. Three units abreast (HERO_RADIUS 0.5): a 1 m slot
 *  passes §3.4's "at most 2 blocked sides" and is still a wall to a unit with a
 *  radius, so this gap is set by movement, not by the rule. It is not applied
 *  to the map FRAME — a plateau may back onto it (see placePlateaus). */
const PLATEAU_GAP = 3;
/** The same gap, but against a LANE corridor, where it is deliberately smaller.
 *  A cliff standing close to the lane shoulder is the look and the gameplay
 *  DESIGN_DELTA §1 asks for — "the jungle becomes a network of routes" and a
 *  lane you can be jumped into — and it costs nothing: the corridor itself is
 *  2 * LANE_CORRIDOR_HALF_W = 6 m of walkable ground, so a cell at its edge
 *  still has open lane on three sides (§3.4), and rule 7 only requires the
 *  polyline to keep a HERO_RADIUS disc off the rock, which 2 m of shoulder plus
 *  the 3 m corridor clears six times over. At the PLATEAU_GAP used against
 *  everything else the 3-lane map's jungle strips are too narrow to hold a
 *  plateau at all, and the map
 *  loses the elevation the whole pass exists to add. */
const PLATEAU_LANE_GAP = 2;
/** Hard cap on plateaus per half, per size. The coverage target and pickSite's
 *  clearances both stop the loop long before this; it exists so a future config
 *  change cannot turn the placement loop into an unbounded one. */
const PLATEAU_MAX = 12;

/** Half-width of a ramp cut, from RAMP_WIDTH (7): >= the lane corridor's full
 *  width (2 * LANE_CORRIDOR_HALF_W = 6) as §3 requires at base mouths. */
const RAMP_HALF_W = RAMP_WIDTH / 2;

/** Perpendicular half-width of the river band. RIVER_BAND_W is the FULL width
 *  (config.ts), and the band is measured along the anti-diagonal x + z = side,
 *  so a point's perpendicular distance to the centreline is
 *  |x + z - side| * SQRT1_2. */
const RIVER_HALF_W = RIVER_BAND_W / 2;

/** Camp clearing radius per tier — the ground carved to `'ground'` and the room
 *  the tier's bodies need. DESIGN_DELTA §2: the large camp "needs the most
 *  clearing room", which is also why the 1-lane map drops it. */
const CAMP_CLEARING_R: Readonly<Record<CampDef['tier'], number>> = {
  pack: 2.5,
  brute: 3,
  hive: 3.5,
};
/** Extra margin around a clearing that must also be free of cliffs, ramps,
 *  lanes, bases and river. It buys two things at once: the clearing never
 *  straddles a cliff ring (so a camp is wholly on the plateau top or wholly off
 *  it, and its elevation is uniform), and §3's "fully enclosed by passable
 *  approach" holds without a second test. */
const CAMP_CLEARING_MARGIN = 1.5;
/** Metres between two camp clearing centres in the same half. Above
 *  CAMP_LEASH_RADIUS (10) + AGGRO_RADIUS (7) so pulling one camp can never
 *  aggro its neighbour, which would make a jungle clear a coin flip. */
const CAMP_SEPARATION = 18;
/** Margin added to CAMP_LANE_CLEARANCE when choosing a site. §3.5 is validated
 *  with a strict `<`, and a site chosen exactly at the bound would be one ulp
 *  from failing its own validator. */
const CAMP_LANE_MARGIN = 2;

/** Foliage clump radii, hash-varied per clump between these bounds. Small: §3
 *  wants clumps that conceal a ganker, not a second jungle wall, and
 *  CONCEAL_REVEAL_RADIUS (4) is the range at which standing in one stops
 *  working. */
const FOLIAGE_R_MIN = 2;
const FOLIAGE_R_MAX = 3.2;
/** Candidate lattice pitch for foliage clumps, in metres. Clumps are drawn from
 *  a hash-shuffled lattice rather than from pickSite: FOLIAGE_COVERAGE needs
 *  dozens of them and they WANT to sit against lane shoulders, which is the
 *  opposite of pickSite's most-open-spot criterion. */
const FOLIAGE_PITCH = 6;

/** Metres of hash jitter added to a site's score, so two equally good spots do
 *  not always resolve to the same one and the map does not read as a lattice.
 *  Small enough that it never overrides a real clearance difference. */
const SITE_JITTER = 1.5;

/** The four orthogonal neighbours. Everything the layout rules reason about —
 *  the cliff ring as a cut, the wall-slide push-out, the connectivity fill — is
 *  4-connected: a diagonal touch is not a crossing a unit can walk, and a
 *  4-adjacency ring is a complete cut for a 4-connected fill. */
const NEIGHBOURS: readonly { readonly di: number; readonly dj: number }[] = [
  { di: -1, dj: 0 },
  { di: 1, dj: 0 },
  { di: 0, dj: -1 },
  { di: 0, dj: 1 },
];

/** Candidate ramp directions for a plateau access, as EXACT unit vectors: the
 *  four axes and the four diagonals through Math.SQRT1_2, which is a
 *  spec-valued constant rather than a computed cosine. No trigonometry appears
 *  anywhere in this file (see the header). */
const RAMP_DIRS: readonly Vec2[] = [
  { x: 1, z: 0 },
  { x: Math.SQRT1_2, z: Math.SQRT1_2 },
  { x: 0, z: 1 },
  { x: -Math.SQRT1_2, z: Math.SQRT1_2 },
  { x: -1, z: 0 },
  { x: -Math.SQRT1_2, z: -Math.SQRT1_2 },
  { x: 0, z: -1 },
  { x: Math.SQRT1_2, z: -Math.SQRT1_2 },
];

/** Camp tiers per half, indexed by the camp COUNT from CAMPS_PER_HALF, in
 *  PLACEMENT order — biggest first, because the site chooser hands the most
 *  open ground to whoever asks first and the hive needs it most. The multisets
 *  are config.ts's: 4 -> pack, pack, brute, hive; 3 -> pack, brute, hive;
 *  2 -> pack, brute (the smallest map drops the large camp). */
const CAMP_TIERS: readonly (readonly CampDef['tier'][])[] = [
  [],
  ['pack'],
  ['brute', 'pack'],
  ['hive', 'brute', 'pack'],
  ['hive', 'brute', 'pack', 'pack'],
];

// Hash salts. Distinct per family so two families never draw the same jitter
// sequence and stack their features on top of each other.
const SALT_PLATEAU_SHAPE = 0x51ed;
const SALT_PLATEAU_SITE = 0x2f9b;
const SALT_CAMP_SITE = 0x7c1d;
const SALT_FOLIAGE = 0x1b3f;
const SALT_LANDMARK = 0x6ae5;

// ---- small geometry helpers --------------------------------------------------

/** Squared distance from (px,pz) to segment a->b. Squared throughout: a
 *  clearance test is `d2 >= r*r`, which is exact and cheaper than a sqrt. */
function segDist2(a: Vec2, b: Vec2, px: number, pz: number): number {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const len2 = dx * dx + dz * dz;
  let t = len2 > 0 ? ((px - a.x) * dx + (pz - a.z) * dz) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const ex = px - (a.x + t * dx);
  const ez = pz - (a.z + t * dz);
  return ex * ex + ez * ez;
}

/** Squared distance from (px,pz) to a polyline (min over its segments). */
function polylineDist2(path: readonly Vec2[], px: number, pz: number): number {
  let best = Infinity;
  for (let i = 0; i + 1 < path.length; i++) {
    const a = path[i];
    const b = path[i + 1];
    if (a === undefined || b === undefined) continue; // bounded by the loop; narrowing only
    const d = segDist2(a, b, px, pz);
    if (d < best) best = d;
  }
  return best;
}

/** Squared distance from (px,pz) to the NEAREST lane polyline. */
function lanesDist2(
  paths: readonly (readonly Vec2[])[],
  px: number,
  pz: number,
): number {
  let best = Infinity;
  for (const path of paths) {
    const d = polylineDist2(path, px, pz);
    if (d < best) best = d;
  }
  return best;
}

function dist2(ax: number, az: number, bx: number, bz: number): number {
  const dx = ax - bx;
  const dz = az - bz;
  return dx * dx + dz * dz;
}

/**
 * The lane polylines, built EXACTLY as `buildMap` builds them, from the same
 * constants. This is a deliberate duplication and not an oversight: `buildMap`
 * calls `buildTerrain`, so importing it here would be a cycle, and the terrain
 * must be derived from the same polylines the creeps walk or a cliff could
 * land on a lane. **If buildMap's path construction ever changes, this changes
 * with it in the same commit** — validateMap rule 7 (a hero disc walking each
 * polyline never touches a cliff) is what fails loudly if it does not.
 */
function lanePolylines(lanes: number, side: number): readonly (readonly Vec2[])[] {
  const b = BASE_INSET;
  const e = LANE_EDGE_INSET;
  const a0: Vec2 = { x: b, z: b };
  const a1: Vec2 = { x: side - b, z: side - b };
  const mid: Vec2 = { x: side / 2, z: side / 2 };
  if (lanes === 1) return [[a0, mid, a1]];
  const paths: Vec2[][] = [
    [a0, { x: e, z: side - e }, a1], // west-north edge lane
    [a0, { x: side - e, z: e }, a1], // south-east edge lane
  ];
  if (lanes === MAX_LANES) paths.push([a0, mid, a1]); // mid diagonal
  return paths;
}

// ---- the working grid --------------------------------------------------------

/** Everything the layout stages read. `kind` and `elev` are the arrays that
 *  become the returned grid; they are mutated in place, stage by stage. */
interface Ctx {
  readonly lanes: number;
  readonly side: number;
  readonly dim: number;
  readonly res: number;
  readonly paths: readonly (readonly Vec2[])[];
  /** Team 0's ancient first. Both are needed by every clearance test — a camp
   *  must be clear of the ENEMY base too, or the mirrored half is not fair. */
  readonly ancients: readonly Vec2[];
  readonly kind: Uint8Array;
  readonly elev: Uint8Array;
}

/** True for the representative of a mirrored cell pair: team 0's half, plus a
 *  first/second tiebreak on the anti-diagonal itself. `side` is always even
 *  (96/112/128), so `i + j === dim - 1` is odd and no cell is its own mirror —
 *  every cell has exactly one distinct partner. */
function isCanonical(i: number, j: number, dim: number): boolean {
  const s = i + j;
  return s < dim - 1 || (s === dim - 1 && i < j);
}

/**
 * Copy every canonical cell over its point reflection. Rule 6 (mirror
 * exactness) then holds by construction rather than by luck: the analytic
 * painters evaluate `(x - cx)^2` on one side and `((side - x) - (side - cx))^2`
 * on the other, which are equal in real arithmetic and need not be equal in the
 * last bit of a double. Run after every float paint; it is a no-op when the
 * paint was already symmetric.
 */
function mirrorCanonical(ctx: Ctx): void {
  const { dim, kind, elev } = ctx;
  for (let j = 0; j < dim; j++) {
    for (let i = 0; i < dim; i++) {
      if (!isCanonical(i, j, dim)) continue;
      const p = j * dim + i;
      const q = (dim - 1 - j) * dim + (dim - 1 - i);
      const k = kind[p];
      const e = elev[p];
      if (k === undefined || e === undefined) continue; // in-range by construction
      kind[q] = k;
      elev[q] = e;
    }
  }
}

/** Paint every cell whose centre lies inside the disc and whose current kind is
 *  `over`, ignoring the rest. Restricting the target kind is what keeps the
 *  jungle census honest (a plateau only ever consumes jungle) and what makes
 *  the paint order in buildTerrain a statement of priority rather than a
 *  sequence of overwrites. `elevation === null` leaves the level alone, for the
 *  two re-tags that must not move it: foliage and camp clearings. Returns the
 *  number of cells painted. */
function paintDisc(
  ctx: Ctx,
  cx: number,
  cz: number,
  r: number,
  over: number,
  code: number,
  elevation: number | null,
): number {
  const { dim, res, kind, elev } = ctx;
  const i0 = axisCell(cx - r, res, dim);
  const i1 = axisCell(cx + r, res, dim);
  const j0 = axisCell(cz - r, res, dim);
  const j1 = axisCell(cz + r, res, dim);
  const r2 = r * r;
  let painted = 0;
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const p = j * dim + i;
      if (kind[p] !== over) continue;
      if (dist2(cellMid(i, res), cellMid(j, res), cx, cz) > r2) continue;
      kind[p] = code;
      if (elevation !== null) elev[p] = elevation;
      painted++;
    }
  }
  return painted;
}

/** Cells the same disc WOULD paint, without painting. Used to decide whether
 *  one more plateau takes the coverage closer to its target or past it. */
function measureDisc(ctx: Ctx, cx: number, cz: number, r: number, over: number): number {
  const { dim, res, kind } = ctx;
  const i0 = axisCell(cx - r, res, dim);
  const i1 = axisCell(cx + r, res, dim);
  const j0 = axisCell(cz - r, res, dim);
  const j1 = axisCell(cz + r, res, dim);
  const r2 = r * r;
  let n = 0;
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      if (kind[j * dim + i] !== over) continue;
      if (dist2(cellMid(i, res), cellMid(j, res), cx, cz) > r2) continue;
      n++;
    }
  }
  return n;
}

// ---- site selection ----------------------------------------------------------

/** Minimum clearances a site must keep, in metres. Every one is a distance from
 *  the site's CENTRE, so a family's footprint is folded into its own numbers. */
interface SiteSpec {
  readonly minLane: number; // to the nearest lane polyline
  readonly minBase: number; // to either ancient
  /** Perpendicular distance to the river centreline; 0 disables the test. */
  readonly minRiver: number;
  readonly minEdge: number; // to the map frame
  /** Base distance to every already-placed peer; each peer adds its own
   *  `keepOut` on top, so a small feature may sit closer to another small one
   *  than to a large one without the caller pre-computing a worst case. */
  readonly minPeer: number;
  /** How to choose among the legal sites. `'open'` takes the largest slack —
   *  the centre of the biggest empty pocket. `'snug'` takes the smallest slack
   *  above zero — the tightest legal fit, hugging whichever lane shoulder,
   *  river bank, map frame or neighbouring ring it is closest to. The first
   *  gives a feature the room it deserves; the second is how the leftovers get
   *  filled without the map turning into a lattice of identical gaps. */
  readonly fit: 'open' | 'snug';
  readonly salt: number;
}

/** An already-placed feature a new site must stand clear of. `keepOut` is that
 *  feature's own footprint; a point peer (a camp, a landmark anchor) uses 0. */
interface SitePeer {
  readonly at: Vec2;
  readonly keepOut: number;
}

/**
 * The one site chooser, used for plateaus, camps and landmark anchors.
 *
 * A candidate's SLACK is the smallest margin it has against any one of its
 * clearances — lanes, bases, river, map frame, every already-placed peer — so
 * slack >= 0 is exactly "legal" and the slack itself measures how much room the
 * site has. `spec.fit` then says which legal site wins: `'open'` takes the
 * largest slack, the centre of the biggest empty pocket, which is what a camp
 * wants (open ground it cannot be pulled out of, and each placed peer pushes
 * the next pick into a different pocket with no explicit spreading rule);
 * `'snug'` takes the smallest, the tightest legal fit, which is what plateaus
 * want (a plateau parked in the middle of a pocket blocks the whole pocket).
 *
 * Candidates are cell centres in TEAM 0's HALF only; the caller mirrors. Ties
 * are broken by the hash jitter and then by scan order, so the result is a pure
 * function of the lane count. Returns null when nothing satisfies the spec —
 * every caller treats that as "stop", never as an error.
 */
function pickSite(
  ctx: Ctx,
  spec: SiteSpec,
  peers: readonly SitePeer[],
  accept: ((x: number, z: number) => boolean) | null,
): Vec2 | null {
  const { dim, res, side, paths, ancients } = ctx;
  let bestX = 0;
  let bestZ = 0;
  let bestScore = 0;
  let found = false;
  for (let j = 0; j < dim; j++) {
    for (let i = 0; i < dim; i++) {
      if (!(i + j < dim - 1)) continue; // team 0's half; the mirror is generated
      const x = cellMid(i, res);
      const z = cellMid(j, res);

      let slack = Math.min(x, z, side - x, side - z) - spec.minEdge;
      if (slack < 0) continue;
      slack = Math.min(slack, Math.sqrt(lanesDist2(paths, x, z)) - spec.minLane);
      if (slack < 0) continue;
      for (const a of ancients) {
        slack = Math.min(slack, Math.sqrt(dist2(x, z, a.x, a.z)) - spec.minBase);
      }
      if (slack < 0) continue;
      if (spec.minRiver > 0) {
        const river = Math.abs(x + z - side) * Math.SQRT1_2;
        slack = Math.min(slack, river - spec.minRiver);
        if (slack < 0) continue;
      }
      for (const p of peers) {
        const need = spec.minPeer + p.keepOut;
        slack = Math.min(slack, Math.sqrt(dist2(x, z, p.at.x, p.at.z)) - need);
      }
      if (slack < 0) continue;
      if (accept !== null && !accept(x, z)) continue;

      const jitter = (frac01(hash32(ctx.lanes, spec.salt, j * dim + i)) - 0.5) * SITE_JITTER;
      const score = spec.fit === 'open' ? slack + jitter : -slack + jitter;
      if (found && score <= bestScore) continue;
      found = true;
      bestScore = score;
      bestX = x;
      bestZ = z;
    }
  }
  return found ? { x: bestX, z: bestZ } : null;
}

/** Point reflection through the map centre — the ONE symmetry this map has
 *  (§3), the same one validateMap rule 2 enforces for structures. */
function mirrorPoint(ctx: Ctx, p: Vec2): Vec2 {
  return { x: ctx.side - p.x, z: ctx.side - p.z };
}

// ---- stage 1: river, lanes, bases --------------------------------------------

/** The river: a band along the anti-diagonal through the centre, ELEV_LOW and
 *  passable, with NO movement modifier (DESIGN_DELTA §4). It is painted first
 *  and everything else paints over it, because it is a landmark rather than an
 *  obstacle — a lane crossing it stays a lane. */
function paintRiver(ctx: Ctx): void {
  const { dim, res, side, kind } = ctx;
  const bound = RIVER_HALF_W / Math.SQRT1_2; // |x + z - side| at RIVER_HALF_W perpendicular
  for (let j = 0; j < dim; j++) {
    for (let i = 0; i < dim; i++) {
      const p = j * dim + i;
      if (kind[p] !== K_GROUND) continue;
      if (Math.abs(cellMid(i, res) + cellMid(j, res) - side) > bound) continue;
      kind[p] = K_RIVER;
    }
  }
}

/** Lane corridors: LANE_CORRIDOR_HALF_W around each polyline, always ELEV_LOW,
 *  always passable, never foliage (§3). Painted over the river; the base
 *  platforms then paint over the corridor, so the stretch inside a base disc is
 *  `'base'` and the crossing of the base's cliff ring becomes the mouth ramp. */
function paintLanes(ctx: Ctx): void {
  const { dim, res, paths, kind, elev } = ctx;
  const halfW2 = LANE_CORRIDOR_HALF_W * LANE_CORRIDOR_HALF_W;
  for (let j = 0; j < dim; j++) {
    for (let i = 0; i < dim; i++) {
      const p = j * dim + i;
      if (lanesDist2(paths, cellMid(i, res), cellMid(j, res)) > halfW2) continue;
      kind[p] = K_LANE;
      elev[p] = ELEV_LOW;
    }
  }
}

/** Base platforms: a disc of ELEV_HIGH around each ancient, painted over every
 *  kind that exists at this point — ground, river and lane are all of them, so
 *  the platform wins outright and the lane's last stretch becomes `'base'`.
 *  DESIGN_DELTA §1 — the last stand is always uphill. */
function paintBases(ctx: Ctx): void {
  for (const a of ctx.ancients) {
    for (const over of [K_GROUND, K_RIVER, K_LANE]) {
      paintDisc(ctx, a.x, a.z, BASE_PLATFORM_RADIUS, over, K_BASE, ELEV_HIGH);
    }
  }
}

// ---- stage 3: jungle plateaus ------------------------------------------------

/** A placed plateau: where its stair starts and how far its ground reaches. */
interface Plateau {
  readonly at: Vec2;
  readonly r: number;
  readonly extent: number;
}

/** The discs of plateau `n` in team 0's half: a main disc plus two lobes on
 *  hash-picked axes. The lobes overlap the main disc by more than half their
 *  radius, so the union stays star-shaped about the centre — deep armpits would
 *  wrap low ground in cliff on three sides, which §3.4 forbids and stage 6
 *  would then have to eat. */
function plateauDiscs(lanes: number, n: number, p: Plateau): readonly Vec2[] {
  const h = hash32(lanes, SALT_PLATEAU_SHAPE, n);
  const off = p.r * PLATEAU_LOBE_OFF_SCALE;
  const out: Vec2[] = [p.at];
  for (const d of [RAMP_DIRS[h % RAMP_DIRS.length], RAMP_DIRS[((h >>> 5) + 3) % RAMP_DIRS.length]]) {
    if (d === undefined) continue; // RAMP_DIRS is non-empty; narrowing only
    out.push({ x: p.at.x + d.x * off, z: p.at.z + d.z * off });
  }
  return out;
}

/** Radius of the n-th disc of a plateau: the main disc, then its two lobes. */
function plateauDiscRadius(p: Plateau, index: number): number {
  return index === 0 ? p.r : p.r * PLATEAU_LOBE_SCALE;
}

/**
 * Place plateaus greedily until HIGH_GROUND_COVERAGE of the jungle is high
 * ground, mirroring each one as it lands. DESIGN_DELTA §1 puts the elevation in
 * the jungle between the lanes, so a plateau keeps a walkable channel between
 * its cliff ring and the base rings, the river band and every other plateau
 * (PLATEAU_GAP) and a narrower one against a lane corridor (PLATEAU_LANE_GAP);
 * it may back onto the map frame.
 *
 * The loop stops one plateau EARLY when the next one would overshoot the target
 * by more than the current shortfall undershoots it, so the measured coverage
 * straddles the config fraction instead of always exceeding it. It also stops
 * when no site satisfies the clearances, and on every map that is what actually
 * binds: HIGH_GROUND_COVERAGE is 0.22, and the layout reaches
 *
 *     lanes 1: 1360 / 6900 jungle cells = 19.7%   (8 plateaus)
 *     lanes 2: 1478 / 8782                = 16.8%   (12 plateaus)
 *     lanes 3: 1668 / 11264               = 14.8%   (16 plateaus)
 *
 * — the shortfall growing with the lane count because each added lane cuts the
 * jungle into narrower strips while the corridor, river, base and peer
 * clearances stay fixed. That is the right way to miss this number. The
 * clearances are what §3.3 and §3.4 are made of, and config.ts's own note says
 * "past roughly a quarter coverage the cliff rings interlock and the jungle
 * becomes a maze, which is travel time without a decision": buying the last
 * five points of coverage by shaving the walkable channels would buy exactly
 * that maze. At least one plateau per half is always placed.
 */
function placePlateaus(ctx: Ctx, jungleCells: number): readonly Plateau[] {
  const halfTarget = (HIGH_GROUND_COVERAGE * jungleCells) / 2;
  const placed: Plateau[] = [];
  const peers: SitePeer[] = [];
  let painted = 0;
  let n = 0;
  for (const r of PLATEAU_RADII) {
    const extent = plateauExtent(r);
    // Every clearance is "footprint + its own cliff ring + the walkable gap",
    // and against another plateau both rings count.
    const spec: SiteSpec = {
      minLane: extent + 1 + LANE_CORRIDOR_HALF_W + PLATEAU_LANE_GAP,
      minBase: extent + 1 + BASE_PLATFORM_RADIUS + 1 + PLATEAU_GAP,
      minRiver: extent + 1 + RIVER_HALF_W,
      // The map frame is a wall, not a cliff: a plateau may back straight onto
      // it, and only its ring must stay on the grid. Whatever sliver of ground
      // is pinched behind it is sealed off, and stage 6 turns that into rock —
      // the map boundary reading as bare cliff is the intent (STYLE_BIBLE §8),
      // and reserving a walkable lap around the frame would cost most of the
      // 3-lane map's high ground for a strip nobody fights over.
      minEdge: extent + 1,
      // Peer spacing is symmetric: this footprint and its ring, the peer's own
      // footprint and ring (carried as the peer's keepOut), and one walkable
      // channel between them. A small plateau may therefore tuck in beside
      // another small one where it could not beside a large one, which is what
      // lets the smaller sizes contribute anything at all.
      minPeer: extent + 1 + 1 + PLATEAU_GAP,
      // Plateaus PACK. Taking the most open spot each time is the intuitive
      // choice and measures worse at every size: a plateau parked in the middle
      // of a pocket blocks the whole pocket, and coverage lands ~25% lower.
      // Snug also puts the high ground where it is worth holding — overlooking
      // a lane shoulder, a river bank or another plateau's channel.
      fit: 'snug',
      salt: SALT_PLATEAU_SITE,
    };
    for (let k = 0; k < PLATEAU_MAX; k++) {
      const site = pickSite(ctx, spec, peers, null);
      if (site === null) break;
      const plateau: Plateau = { at: site, r, extent };
      const discs = plateauDiscs(ctx.lanes, n, plateau);
      let cells = 0;
      for (const [d, disc] of discs.entries()) {
        cells += measureDisc(ctx, disc.x, disc.z, plateauDiscRadius(plateau, d), K_GROUND);
      }
      if (placed.length > 0 && painted + cells / 2 > halfTarget) return placed;
      for (const [d, disc] of discs.entries()) {
        const dr = plateauDiscRadius(plateau, d);
        painted += paintDisc(ctx, disc.x, disc.z, dr, K_GROUND, K_HIGH, ELEV_HIGH);
        const m = mirrorPoint(ctx, disc);
        paintDisc(ctx, m.x, m.z, dr, K_GROUND, K_HIGH, ELEV_HIGH);
      }
      placed.push(plateau);
      peers.push({ at: site, keepOut: extent });
      n++;
    }
  }
  return placed;
}

// ---- stage 4: cliff rings ----------------------------------------------------

/**
 * Every low cell orthogonally touching high ground becomes `'cliff'`.
 *
 * Two properties fall out, and both are load-bearing. (a) Rule 11 (elevation
 * coherence) holds by construction: a high cell's low neighbours are, without
 * exception, marked transitions. (b) The ring is a complete 4-cut — a
 * 4-connected walk from low ground onto a plateau must step through one of
 * these cells — so a ramp is genuinely the only way up, and the flood fills in
 * stage 6 and in validateMap cannot leak diagonally.
 *
 * The ring is carved from the LOW side, which is why BASE_PLATFORM_RADIUS (10)
 * plus one ring cell exactly fills the ground out to the map frame at
 * BASE_INSET (11) — config.ts's "no wasted corner".
 */
function paintCliffRings(ctx: Ctx): void {
  const { dim, kind, elev } = ctx;
  for (let j = 0; j < dim; j++) {
    for (let i = 0; i < dim; i++) {
      const p = j * dim + i;
      if (elev[p] === ELEV_HIGH) continue;
      for (const n of NEIGHBOURS) {
        const ni = i + n.di;
        const nj = j + n.dj;
        if (ni < 0 || ni >= dim || nj < 0 || nj >= dim) continue;
        if (elev[nj * dim + ni] !== ELEV_HIGH) continue;
        kind[p] = K_CLIFF;
        break;
      }
    }
  }
}

// ---- stage 5: ramps ----------------------------------------------------------

/** Cut every `'cliff'` cell within RAMP_HALF_W of the segment a->b into a
 *  `'ramp'` at ELEV_HIGH (§3: a ramp reads as high ground, one value). */
function cutRamp(ctx: Ctx, a: Vec2, b: Vec2): void {
  const { dim, res, kind, elev } = ctx;
  const r2 = RAMP_HALF_W * RAMP_HALF_W;
  const i0 = axisCell(Math.min(a.x, b.x) - RAMP_HALF_W, res, dim);
  const i1 = axisCell(Math.max(a.x, b.x) + RAMP_HALF_W, res, dim);
  const j0 = axisCell(Math.min(a.z, b.z) - RAMP_HALF_W, res, dim);
  const j1 = axisCell(Math.max(a.z, b.z) + RAMP_HALF_W, res, dim);
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const p = j * dim + i;
      if (kind[p] !== K_CLIFF) continue;
      if (segDist2(a, b, cellMid(i, res), cellMid(j, res)) > r2) continue;
      kind[p] = K_RAMP;
      elev[p] = ELEV_HIGH;
    }
  }
}

/**
 * Base mouths: every cliff cell within RAMP_HALF_W of ANY lane polyline. That
 * is exactly "one ramp per lane where that lane's corridor enters a base disc"
 * (§3) — the base rings are the only cliffs a lane comes near, because plateaus
 * keep PLATEAU_GAP clear of the corridor — and it is automatically at least as
 * wide as the corridor, since RAMP_WIDTH (7) exceeds 2 * LANE_CORRIDOR_HALF_W.
 * Without this the ring would strand every creep wave in its own fountain:
 * lane creeps have no pathfinding (§4), which is the design's load-bearing
 * simplification and the reason rule 7 is a hard validation.
 */
function cutLaneRamps(ctx: Ctx): void {
  const { dim, res, paths, kind, elev } = ctx;
  const r2 = RAMP_HALF_W * RAMP_HALF_W;
  for (let j = 0; j < dim; j++) {
    for (let i = 0; i < dim; i++) {
      const p = j * dim + i;
      if (kind[p] !== K_CLIFF) continue;
      if (lanesDist2(paths, cellMid(i, res), cellMid(j, res)) > r2) continue;
      kind[p] = K_RAMP;
      elev[p] = ELEV_HIGH;
    }
  }
}

/** Passable in-bounds cells within `r` of (x,z). The openness measure that
 *  picks a plateau's access side: an integer count, so the choice never turns
 *  on a float tie. */
function openCount(ctx: Ctx, x: number, z: number, r: number): number {
  const { dim, res, kind } = ctx;
  const r2 = r * r;
  let n = 0;
  const i0 = Math.floor((x - r) * res);
  const i1 = Math.floor((x + r) * res);
  const j0 = Math.floor((z - r) * res);
  const j1 = Math.floor((z + r) * res);
  for (let j = j0; j <= j1; j++) {
    if (j < 0 || j >= dim) continue;
    for (let i = i0; i <= i1; i++) {
      if (i < 0 || i >= dim) continue;
      if (dist2(cellMid(i, res), cellMid(j, res), x, z) > r2) continue;
      if (kind[j * dim + i] !== K_CLIFF) n++;
    }
  }
  return n;
}

/**
 * One ramp per jungle plateau (§3). The access side is the RAMP_DIRS direction
 * whose landing has the most open ground around it, so a plateau's stair faces
 * the jungle it commands rather than a wall or the map frame; ties fall to the
 * lowest direction index. The mirrored plateau is cut with the negated
 * direction rather than re-scored, so the pair is symmetric by construction and
 * not by two independent argmaxes agreeing.
 */
function cutPlateauRamps(ctx: Ctx, plateaus: readonly Plateau[]): void {
  for (const plateau of plateaus) {
    const site = plateau.at;
    const reach = plateau.extent + 1 + RAMP_HALF_W;
    let bestDir: Vec2 | null = null;
    let bestOpen = -1;
    for (const dir of RAMP_DIRS) {
      const lx = site.x + dir.x * reach;
      const lz = site.z + dir.z * reach;
      const open = openCount(ctx, lx, lz, RAMP_HALF_W);
      if (open <= bestOpen) continue;
      bestOpen = open;
      bestDir = dir;
    }
    if (bestDir === null) continue; // RAMP_DIRS is non-empty; narrowing only
    const landing: Vec2 = { x: site.x + bestDir.x * reach, z: site.z + bestDir.z * reach };
    cutRamp(ctx, site, landing);
    const mSite = mirrorPoint(ctx, site);
    cutRamp(ctx, mSite, mirrorPoint(ctx, landing));
  }
}

// ---- stage 6: repair ---------------------------------------------------------

/** Kinds the repair never converts. A lane, a ramp or a base platform is the
 *  layout's intent; if one of those is trapped or sealed the layout is wrong
 *  and validateMap must SAY so (rules 8 and 9) rather than have it quietly
 *  bricked over here. */
function repairProtected(code: number | undefined): boolean {
  return code === K_LANE || code === K_RAMP || code === K_BASE || code === K_CLIFF;
}

function fillCliff(ctx: Ctx, p: number): void {
  ctx.kind[p] = K_CLIFF;
  ctx.elev[p] = ELEV_LOW;
}

/**
 * Turn every concave trap into rock — §3.4: no passable cell may have
 * impassable neighbours on 3 or more of its 4 sides. **Off-map counts as
 * impassable**, exactly as validateMap counts it: the movement clamp at the map
 * frame behaves like a wall, so a one-cell pocket against the frame traps a
 * unit precisely as a pocket between cliffs does.
 *
 * The sweep is SYNCHRONOUS — every decision reads the snapshot taken at the top
 * — because an in-place sweep would depend on scan order and scan order is not
 * mirror-symmetric, which would break rule 6. Returns true if anything changed.
 */
function fillTraps(ctx: Ctx): boolean {
  const { dim, kind } = ctx;
  const before = kind.slice();
  let changed = false;
  for (let j = 0; j < dim; j++) {
    for (let i = 0; i < dim; i++) {
      const p = j * dim + i;
      if (repairProtected(before[p])) continue;
      let blocked = 0;
      for (const n of NEIGHBOURS) {
        const ni = i + n.di;
        const nj = j + n.dj;
        if (ni < 0 || ni >= dim || nj < 0 || nj >= dim) blocked++;
        else if (before[nj * dim + ni] === K_CLIFF) blocked++;
      }
      if (blocked < 3) continue;
      fillCliff(ctx, p);
      changed = true;
    }
  }
  return changed;
}

/**
 * Turn every walkable region that neither ancient can reach into rock — §3.3:
 * "No walkable region may be sealed off." The classic instance is the crescent
 * of ground behind a base, between its cliff ring and the map corner: nothing
 * can ever stand there, and left as ground it is a permanent supply of §3.4
 * traps and of terrain the renderer would light for nobody.
 *
 * The fill starts from BOTH ancients so its result is a mirror-symmetric set
 * even in the (invalid) case where the two halves are not connected to each
 * other — validateMap rule 8 is what reports that, and it must not be masked by
 * an asymmetric repair. Returns true if anything changed.
 */
function fillSealed(ctx: Ctx): boolean {
  const { dim, res, kind, ancients } = ctx;
  const seen = new Uint8Array(dim * dim);
  const stack: number[] = [];
  for (const a of ancients) {
    const i = axisCell(a.x, res, dim);
    const j = axisCell(a.z, res, dim);
    const p = j * dim + i;
    if (kind[p] === K_CLIFF || seen[p] === 1) continue;
    seen[p] = 1;
    stack.push(p);
  }
  while (stack.length > 0) {
    const p = stack.pop();
    if (p === undefined) break; // length > 0 guarantees a value; narrowing only
    const i = p % dim;
    const j = (p - i) / dim;
    for (const n of NEIGHBOURS) {
      const ni = i + n.di;
      const nj = j + n.dj;
      if (ni < 0 || ni >= dim || nj < 0 || nj >= dim) continue;
      const q = nj * dim + ni;
      if (seen[q] === 1 || kind[q] === K_CLIFF) continue;
      seen[q] = 1;
      stack.push(q);
    }
  }
  let changed = false;
  for (let p = 0; p < dim * dim; p++) {
    if (seen[p] === 1 || repairProtected(kind[p])) continue;
    fillCliff(ctx, p);
    changed = true;
  }
  return changed;
}

/**
 * Run both repairs to a fixed point: filling a trap can seal a pocket, and
 * sealing a pocket can trap its neighbour. Termination is structural — every
 * pass only ever turns a passable cell impassable, and there are dim*dim of
 * them — so no iteration cap is needed and none is imposed.
 */
function repairLayout(ctx: Ctx): void {
  for (;;) {
    const trapped = fillTraps(ctx);
    const sealed = fillSealed(ctx);
    if (!trapped && !sealed) return;
  }
}

// ---- stage 7: foliage --------------------------------------------------------

/**
 * Foliage clumps to FOLIAGE_COVERAGE of the jungle: passable, ELEV_LOW,
 * concealing (DESIGN_DELTA §3 — concealment is what makes ganking possible and
 * wards worth their gold).
 *
 * Clumps come from a hash-SHUFFLED lattice rather than from pickSite, for a
 * reason that is the whole design of the feature: pickSite finds the most open
 * spot, and a bush in the middle of nowhere conceals nobody. The lattice fills
 * the jungle uniformly and deliberately allows clumps hard against a lane
 * shoulder — that bush at the lane's edge IS the gank.
 *
 * It runs after the repair because it only ever re-tags LOW `'ground'`: it
 * changes no elevation, no passability and no connectivity, so it cannot
 * disturb the rings, the ramps or the repair, and the count it reports is
 * exact. It runs BEFORE the camps for one reason — §3 fixes a camp clearing at
 * `'ground'`, and a bush painted over a clearing would both break that and, on
 * a plateau camp, drag a high cell down to ELEV_LOW and put an unmarked step
 * through rule 11. The camps then carve their clearings back out of it.
 */
function placeFoliage(ctx: Ctx, jungleCells: number): void {
  const { dim, res, side } = ctx;
  const halfTarget = (FOLIAGE_COVERAGE * jungleCells) / 2;
  const lattice: { readonly at: Vec2; readonly r: number; readonly key: number }[] = [];
  const steps = Math.floor(side / FOLIAGE_PITCH);
  for (let b = 0; b <= steps; b++) {
    for (let a = 0; a <= steps; a++) {
      const h = hash32(ctx.lanes, SALT_FOLIAGE, b * (steps + 1) + a);
      const jx = (frac01(h) - 0.5) * FOLIAGE_PITCH;
      const jz = (frac01(mix32(h)) - 0.5) * FOLIAGE_PITCH;
      const x = a * FOLIAGE_PITCH + FOLIAGE_PITCH / 2 + jx;
      const z = b * FOLIAGE_PITCH + FOLIAGE_PITCH / 2 + jz;
      if (!(x + z < side)) continue; // team 0's half; the mirror is generated
      const i = axisCell(x, res, dim);
      const j = axisCell(z, res, dim);
      if (!(i + j < dim - 1)) continue;
      const r = FOLIAGE_R_MIN + frac01(mix32(h ^ 0x5bf0)) * (FOLIAGE_R_MAX - FOLIAGE_R_MIN);
      lattice.push({ at: { x: cellMid(i, res), z: cellMid(j, res) }, r, key: mix32(h ^ 0x27d4) });
    }
  }
  // A hash-keyed order, not scan order: raster order would pack every bush into
  // one corner of the half before the target was met.
  lattice.sort((p, q) => (p.key === q.key ? 0 : p.key < q.key ? -1 : 1));
  let painted = 0;
  for (const clump of lattice) {
    if (painted >= halfTarget) break;
    const n = paintDisc(ctx, clump.at.x, clump.at.z, clump.r, K_GROUND, K_FOLIAGE, null);
    if (n === 0) continue;
    painted += n;
    const m = mirrorPoint(ctx, clump.at);
    paintDisc(ctx, m.x, m.z, clump.r, K_GROUND, K_FOLIAGE, null);
  }
}

// ---- stage 8: neutral camps --------------------------------------------------

/** True when every cell within `r` of (x,z) is open jungle: ground, foliage or
 *  plateau top, and in bounds. Excluding cliff and ramp keeps a clearing from
 *  straddling a cliff ring, so a camp is wholly on a plateau or wholly off one
 *  and its elevation is uniform; excluding lane, base and river keeps it out of
 *  the places a camp must never be. */
function clearingIsOpen(ctx: Ctx, x: number, z: number, r: number, allowHigh: boolean): boolean {
  const { dim, res, kind } = ctx;
  const r2 = r * r;
  const i0 = Math.floor((x - r) * res);
  const i1 = Math.floor((x + r) * res);
  const j0 = Math.floor((z - r) * res);
  const j1 = Math.floor((z + r) * res);
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      if (i < 0 || i >= dim || j < 0 || j >= dim) return false;
      if (dist2(cellMid(i, res), cellMid(j, res), x, z) > r2) continue;
      const c = kind[j * dim + i];
      if (c === K_GROUND || c === K_FOLIAGE) continue;
      if (allowHigh && c === K_HIGH) continue;
      return false;
    }
  }
  return true;
}

/**
 * Place CAMPS_PER_HALF[lanes] camps in team 0's half and mirror them, biggest
 * tier first. Ids are dense from 0 in placement order, half 0 then half 1, so
 * `camps[i]` and `camps[i + n]` are always the mirrored pair — the property
 * `map.test.ts` leans on and the one `SimWorld` uses to build its `CampState`s.
 *
 * Sites run on the REPAIRED grid, so a camp can never land in a pocket the
 * repair was about to brick over, and they clear every lane by
 * CAMP_LANE_CLEARANCE + CAMP_LANE_MARGIN (§3.5, DESIGN_DELTA §2: "a camp that
 * can be dragged into a lane is a bug"). A camp that lands on a plateau top is
 * legal and intended — §3 allows a clearing at either elevation, and a camp
 * worth taking the high ground for is the point of the jungle.
 */
function placeCamps(ctx: Ctx): readonly CampDef[] {
  const count = CAMPS_PER_HALF[ctx.lanes];
  const tiers = count === undefined ? undefined : CAMP_TIERS[count];
  if (tiers === undefined) return [];

  const half0: { readonly tier: CampDef['tier']; readonly at: Vec2 }[] = [];
  const peers: SitePeer[] = [];
  for (const tier of tiers) {
    const clearing = CAMP_CLEARING_R[tier];
    const spec: SiteSpec = {
      minLane: CAMP_LANE_CLEARANCE + CAMP_LANE_MARGIN,
      minBase: BASE_PLATFORM_RADIUS + 1 + clearing + CAMP_CLEARING_MARGIN + 6,
      minRiver: 0, // a camp on the river bank is fine; clearingIsOpen keeps it dry
      minEdge: clearing + CAMP_CLEARING_MARGIN + 1,
      minPeer: CAMP_SEPARATION,
      fit: 'open', // a camp wants room to be fought over, not a corner
      salt: SALT_CAMP_SITE,
    };
    const site = pickSite(ctx, spec, peers, (x, z) =>
      clearingIsOpen(ctx, x, z, clearing + CAMP_CLEARING_MARGIN, true),
    );
    if (site === null) continue;
    half0.push({ tier, at: site });
    peers.push({ at: site, keepOut: 0 });
  }

  const camps: CampDef[] = [];
  for (const [n, c] of half0.entries()) {
    camps.push({ id: n, tier: c.tier, x: c.at.x, z: c.at.z, half: 0 });
  }
  for (const [n, c] of half0.entries()) {
    const m = mirrorPoint(ctx, c.at);
    camps.push({ id: half0.length + n, tier: c.tier, x: m.x, z: m.z, half: 1 });
  }
  // The clearing itself: `'ground'` (§3), ELEVATION UNTOUCHED. A clearing on a
  // plateau stays ELEV_HIGH, which is what makes rule 11 read it as high ground
  // rather than as an unmarked step, and what lets a camp be worth the climb.
  // Only plateau top and foliage are re-tagged: clearingIsOpen has already
  // proved nothing else is in reach.
  for (const c of camps) {
    const r = CAMP_CLEARING_R[c.tier];
    paintDisc(ctx, c.x, c.z, r, K_HIGH, K_GROUND, null);
    paintDisc(ctx, c.x, c.z, r, K_FOLIAGE, K_GROUND, null);
  }
  return camps;
}

// ---- stage 9: landmarks ------------------------------------------------------

/** The renderer's set-piece anchors (STYLE_BIBLE §8: "the map needs 4-6 unique,
 *  hand-placed set pieces that make locations nameable"). Four kinds, seven
 *  placements — every kind but the arch is emitted as a mirrored pair, because
 *  a set piece visible from one base and not the other is a fairness question
 *  even when it is inert. See {@link TerrainDef.landmarks} for what each kind
 *  is and what the mesh must not do. */
function placeLandmarks(
  ctx: Ctx,
  plateaus: readonly Plateau[],
  camps: readonly CampDef[],
): readonly { readonly kind: string; readonly x: number; readonly z: number }[] {
  const out: { kind: string; x: number; z: number }[] = [];

  // The arch: on the river centreline, pushed along the anti-diagonal so it
  // never straddles the mid lane on the 1- and 3-lane maps.
  const c = ctx.side / 2;
  const off = 11;
  out.push({
    kind: 'riverArch',
    x: c + off * Math.SQRT1_2,
    z: c - off * Math.SQRT1_2,
  });

  // Standing stones on the plateau nearest team 0's base, and its mirror.
  let stones: Vec2 | null = null;
  let bestD2 = Infinity;
  const a0 = ctx.ancients[0];
  for (const p of plateaus) {
    if (a0 === undefined) break;
    const d = dist2(p.at.x, p.at.z, a0.x, a0.z);
    if (d >= bestD2) continue;
    bestD2 = d;
    stones = p.at;
  }
  if (stones !== null) {
    const m = mirrorPoint(ctx, stones);
    out.push({ kind: 'standingStones', x: stones.x, z: stones.z });
    out.push({ kind: 'standingStones', x: m.x, z: m.z });
  }

  // The colossus: the most open LOW jungle left once the camps are down, kept
  // clear of them and of the plateaus so it never lands inside a set piece.
  const peers: SitePeer[] = [];
  for (const p of plateaus) peers.push({ at: p.at, keepOut: p.extent });
  for (const camp of camps) {
    if (camp.half === 0) peers.push({ at: { x: camp.x, z: camp.z }, keepOut: 0 });
  }
  const colossus = pickSite(
    ctx,
    {
      // Loose by design: this is a prop, and the clearingIsOpen probe below is
      // what actually keeps it out of the rock, the water and the lanes. The
      // peer distance only has to keep it out of a plateau's ring and off a
      // camp — on the 2- and 3-lane maps a stricter one leaves the jungle with
      // no legal spot at all and the landmark silently disappears.
      minLane: LANE_CORRIDOR_HALF_W + 3,
      minBase: BASE_PLATFORM_RADIUS + 5,
      minRiver: 0,
      minEdge: 5,
      minPeer: 5,
      fit: 'open',
      salt: SALT_LANDMARK,
    },
    peers,
    (x, z) => clearingIsOpen(ctx, x, z, 3, false),
  );
  if (colossus !== null) {
    const m = mirrorPoint(ctx, colossus);
    out.push({ kind: 'fallenColossus', x: colossus.x, z: colossus.z });
    out.push({ kind: 'fallenColossus', x: m.x, z: m.z });
  }

  // The gate: on lane 0's polyline just outside the base ramp, both bases.
  const lane0 = ctx.paths[0];
  const g0 = lane0 === undefined ? undefined : lane0[0];
  const g1 = lane0 === undefined ? undefined : lane0[1];
  if (g0 !== undefined && g1 !== undefined) {
    const dx = g1.x - g0.x;
    const dz = g1.z - g0.z;
    const len = Math.sqrt(dx * dx + dz * dz);
    if (len > 0) {
      const reach = BASE_PLATFORM_RADIUS + 2.5;
      const gx = g0.x + (dx / len) * reach;
      const gz = g0.z + (dz / len) * reach;
      const m = mirrorPoint(ctx, { x: gx, z: gz });
      out.push({ kind: 'ruinedGate', x: gx, z: gz });
      out.push({ kind: 'ruinedGate', x: m.x, z: m.z });
    }
  }
  return out;
}

// ---- buildTerrain ------------------------------------------------------------

/**
 * Compile the lane count into the terrain every consumer shares.
 *
 * PURE: no rng, no clock, no I/O, no module state. The server and every client
 * call it independently on the same `lanes` and get bit-identical arrays, which
 * is the whole reason terrain never travels on the wire (TERRAIN_CONTRACT §1).
 * Throws unless `lanes` is an integer in [MIN_LANES, MAX_LANES], exactly as
 * `buildMap` does — the two are called with the same value from the same place.
 *
 * The construction allocates freely; the QUERIES are what must not (§2). The
 * result satisfies every rule in §3, which `validateMap` rules 6..11 assert and
 * `map.test.ts` gates for lanes 1, 2 and 3.
 */
export function buildTerrain(lanes: number): TerrainDef {
  if (!Number.isInteger(lanes) || lanes < MIN_LANES || lanes > MAX_LANES) {
    throw new Error(
      `buildTerrain: lanes must be an integer in [${MIN_LANES}, ${MAX_LANES}], got ${String(lanes)}`,
    );
  }
  const side = MAP_SIDE_BASE + MAP_SIDE_PER_LANE * (lanes - 1);
  const dim = Math.round(side * TERRAIN_RES);
  const b = BASE_INSET;
  const ctx: Ctx = {
    lanes,
    side,
    dim,
    res: TERRAIN_RES,
    paths: lanePolylines(lanes, side),
    ancients: [
      { x: b, z: b },
      { x: side - b, z: side - b },
    ],
    kind: new Uint8Array(dim * dim), // K_GROUND === 0: open low ground everywhere
    elev: new Uint8Array(dim * dim), // ELEV_LOW === 0
  };

  // 1. The three features every other rule is measured against.
  paintRiver(ctx);
  paintLanes(ctx);
  paintBases(ctx);
  mirrorCanonical(ctx);

  // 2. The jungle census: §7's coverage fractions are "fraction of the JUNGLE
  //    area — cells that are neither lane corridor, base platform nor river",
  //    which after stage 1 is exactly the cells still holding K_GROUND.
  let jungleCells = 0;
  for (let p = 0; p < dim * dim; p++) {
    if (ctx.kind[p] === K_GROUND) jungleCells++;
  }

  // 3..5. Elevation: plateaus, the rings that make them mean something, and the
  //       ramps that keep them reachable.
  const plateaus = placePlateaus(ctx, jungleCells);
  mirrorCanonical(ctx);
  paintCliffRings(ctx);
  cutLaneRamps(ctx);
  cutPlateauRamps(ctx, plateaus);
  mirrorCanonical(ctx);

  // 6. Traps and sealed pockets, to a fixed point.
  repairLayout(ctx);

  // 7..8. Foliage over the finished walkable map, then the camps, which carve
  //       their clearings back out of whatever is under them.
  placeFoliage(ctx, jungleCells);
  const camps = placeCamps(ctx);
  mirrorCanonical(ctx);

  return {
    grid: { side, res: TERRAIN_RES, dim, kind: ctx.kind, elev: ctx.elev },
    camps,
    landmarks: placeLandmarks(ctx, plateaus, camps),
  };
}
