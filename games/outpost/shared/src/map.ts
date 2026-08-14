// ============================================================================
// FROZEN CONTRACT — "RIDGELINE" — the one OUTPOST map.
//
// PURE DATA + the derivations every consumer must agree on. Three consumers
// read this file and they MUST agree exactly:
//   - the server, for collision (`STATIC_SOLIDS`) and spawns
//   - the client, for geometry
//   - the capture harness, for camera framing (via debug `mapInfo()`)
//
// The previous build hand-copied feature coordinates into its capture script.
// When the layout changed the script kept aiming at the old numbers and
// photographed bare ground for a whole judging round. Nothing hard-codes a
// coordinate that lives here.
//
// GEOMETRY LAW — how this map avoids the previous build's fatal:
// The old OUTPOST hand-rolled physics whose ground query ran AFTER gravity, so
// every floor of its 3-storey fort was a trapdoor and players fell to y=0 from
// the spawn. OUTPOST uses STRICKEN's `stepBody`: AABB collide-and-slide with
// step-up, the exact code six shipped maps stand on. EVERY walkable surface
// here is the top face of an AABB and every rise is <= PLAYER.stepUp (0.42).
// No ramps, no slopes, no custom ground query.
//
// TOPOLOGY LAW — the second fatal, caught by the pre-freeze gauntlet:
// A sound physics engine does not give you a reachable building. The first
// draft of this file had a footing 0.6 m tall against a 0.42 m step-up (so the
// ground floor could not be entered), pillars planted dead-centre in both stair
// doorways, a parapet sealing the route to the upper run, and a "landing" that
// was 100% the underside of the staircase above it — measured exposed depth
// -0.000 m. Three independent reviewers running the real `stepBody` against
// this data all reported the same thing: `deck1 -> deck2 reachable: false`.
// Physics was never the problem; topology was.
//
// So the tower is now built around ONE rule: every level is reachable from
// every other level by walking, with no jump required. Access is:
//   ground --(external south run)--> deck1 --(internal stairwell)--> deck2
// The upper run climbs INSIDE the tower footprint and passes through a real
// opening in the deck-2 slab, so nothing is ever buried under anything.
// `mapTopology.test.ts` walks that whole round trip, in both directions,
// with forward input only. If it cannot, the map is wrong — not the test.
// ============================================================================

import { PLAYER } from '@fps/shared';
import type { AABB } from '@fps/shared';
import { FENCE } from './config.js';
import type { SegmentId } from './types.js';

/** Surface material. Resolve to colours via `MAT_COLORS` in `./palette.js`. */
export type MatKind =
  | 'timber' // palisade posts, stair treads, decking
  | 'timberDark' // beams, stringers, framing
  | 'stone' // tower footing, gate piers, boulders
  | 'concrete' // hard standing
  | 'steel' // railings, brackets
  | 'rust' // corrugated panels lashed to the fence, wrecks
  | 'sandbag' // firing step, emplacements
  | 'mud' // the plateau floor
  | 'gravel'; // paths, rubble

/** Centre position + FULL extents, exactly like STRICKEN's BoxDef. */
export interface OutpostBox {
  x: number;
  y: number;
  z: number;
  w: number;
  h: number;
  d: number;
  mat: MatKind;
  /** Client-only decoration: rendered but never collidable. */
  deco?: boolean;
}

export interface SpawnPoint {
  x: number;
  y: number;
  z: number;
  yaw: number;
}

// ---------------------------------------------------------------------------
// Dimensions
// ---------------------------------------------------------------------------

/** The fenced compound is 2*FENCE_HALF on a side. */
export const FENCE_HALF = 20;
/** Segments per side (4 sides x 4 = FENCE.segments). */
export const SEG_PER_SIDE = 4;
export const SEG_LEN = (FENCE_HALF * 2) / SEG_PER_SIDE; // 10 m

/** Tower core footprint: 14 x 14, centred on the origin. "A wide tower." */
export const TOWER_HALF = 7;
/**
 * The stone footing the tower stands on. Its top face is the ground floor.
 * MUST be <= PLAYER.stepUp or the tower cannot be entered — the first draft
 * was 0.6 and the gauntlet measured players bouncing off it at every face.
 */
export const FOOTING_H = 0.4;
export const DECK1_Y = 4.0; // walkable top surface
export const DECK2_Y = 8.0; // walkable top surface — the spawn deck
export const SLAB_H = 0.4;
export const PARAPET_H = 1.0;
export const PARAPET_T = 0.3;

/** Stairs. rise <= PLAYER.stepUp is the law that makes them climbable. */
export const STAIR_STEPS = 12;
export const STAIR_RISE = DECK1_Y / STAIR_STEPS; // 0.3333
export const STAIR_RUN = 0.46; // > PLAYER.radius, so the lifted-body probe clears the next tread
export const STAIR_WIDTH = 3.5;
/** Outer (ground) end of the external south run. */
export const STAIR_OUTER_Z = TOWER_HALF + STAIR_STEPS * STAIR_RUN; // 12.52

/**
 * The internal deck1 -> deck2 run: climbs from z = +5.0 northward, on deck 1.
 *
 * 5.0, not 6.0: at 6.0 the gap between the run's foot and the south parapet's
 * inner face (z = 6.7) was 0.7 m, and a body is 0.6 m across — survivors would
 * have squeezed through a slot rather than stepping onto a landing. 5.0 gives a
 * 1.7 m landing at the top of the external run.
 */
export const UPPER_RUN_START_Z = 5.0;
export const UPPER_RUN_END_Z = UPPER_RUN_START_Z - STAIR_STEPS * STAIR_RUN; // -0.52

/**
 * The stairwell opening in the deck-2 slab.
 *
 * `minZ` is EXACTLY `UPPER_RUN_END_Z` so the deck-2 slab meets the top tread
 * with no gap: the first draft left 0.68 m of open air there and the probe
 * measured a survivor walking south off deck 2 falling straight through to
 * deck 1 (`deck2->deck1 { y: 4, z: 0.18 }`).
 *
 * `maxZ` is far enough south to clear a 1.8 m body's head on every tread whose
 * top exceeds 5.8 (slab underside 7.6 minus body height), plus the body radius.
 * The first draft stopped the opening at 4.0 and the probe measured the climb
 * stalling at y=5.667 — head-first into the slab, five treads short of deck 2.
 */
export const STAIRWELL = {
  /**
   * DERIVED, never hardcoded. A body still supported by a tread can stand with
   * its centre at the tread edge, so its AABB reaches `STAIR_WIDTH/2 +
   * PLAYER.radius`; the lifted step-up probe must clear the slab at that x too,
   * which needs another radius of margin.
   *
   * Hardcoding this at +/-2.0 reproduced the round-1 fatal EXACTLY — same
   * measured signature, `y=5.667` head-first into the slab — in a 0.25 m lane
   * down each side of the run. The Z margin had been reasoned about (+0.30
   * spare); the X margin had not (-0.35 deficit). Deriving it is the only way
   * it cannot silently drift again when STAIR_WIDTH changes.
   */
  // Exactly the tread half-width plus a body radius (plus a hair). A body
  // standing on the outermost part of a tread reaches x = 1.75 + 0.30, so this
  // is the narrowest hole the ascent can pass through — and narrowness is the
  // point: at 2 * radius the hole was 0.6 m WIDER than the stairs on each side,
  // and descending off-centre dropped you into that gap to wedge on the top
  // tread (measured: y=4.33, z=4.90, stuck). The hole must match the stairs.
  minX: -(STAIR_WIDTH / 2 + PLAYER.radius + 0.05),
  maxX: STAIR_WIDTH / 2 + PLAYER.radius + 0.05,
  minZ: UPPER_RUN_END_Z,
  maxZ: 3.6,
} as const;

/** The flat, walkable plateau. Beyond this radius everything is decoration. */
export const PLATEAU_RADIUS = 84;

/** A rise a player cannot climb strands the squad on their own ground floor. */
export const STAIR_RISE_OK: boolean = STAIR_RISE <= PLAYER.stepUp;
export const FOOTING_OK: boolean = FOOTING_H <= PLAYER.stepUp;
export const FIRING_STEP_OK: boolean = FENCE.stepHeight <= PLAYER.stepUp;

// ---------------------------------------------------------------------------
// Fence segments
//
// Indexed CLOCKWISE FROM THE NORTH-WEST CORNER, viewed from above:
//   0-3   north side (z = -FENCE_HALF), running west -> east
//   4-7   east  side (x = +FENCE_HALF), running north -> south
//   8-11  south side (z = +FENCE_HALF), running east -> west
//   12-15 west  side (x = -FENCE_HALF), running south -> north
// ---------------------------------------------------------------------------

export type Side = 'north' | 'east' | 'south' | 'west';

export interface SegmentGeom {
  id: SegmentId;
  side: Side;
  /** Centre of the segment, on the ground. */
  cx: number;
  cz: number;
  /** Outward-facing normal (unit, horizontal). Zombies approach along -normal. */
  nx: number;
  nz: number;
  /** true for the one segment that is the compound's gate. */
  gate: boolean;
}

function buildSegments(): SegmentGeom[] {
  const out: SegmentGeom[] = [];
  const first = -FENCE_HALF + SEG_LEN / 2; // -15
  for (let i = 0; i < SEG_PER_SIDE; i++) {
    out.push({ id: out.length, side: 'north', cx: first + i * SEG_LEN, cz: -FENCE_HALF, nx: 0, nz: -1, gate: i === 2 });
  }
  for (let i = 0; i < SEG_PER_SIDE; i++) {
    out.push({ id: out.length, side: 'east', cx: FENCE_HALF, cz: first + i * SEG_LEN, nx: 1, nz: 0, gate: false });
  }
  for (let i = 0; i < SEG_PER_SIDE; i++) {
    out.push({ id: out.length, side: 'south', cx: -first - i * SEG_LEN, cz: FENCE_HALF, nx: 0, nz: 1, gate: false });
  }
  for (let i = 0; i < SEG_PER_SIDE; i++) {
    out.push({ id: out.length, side: 'west', cx: -FENCE_HALF, cz: -first - i * SEG_LEN, nx: -1, nz: 0, gate: false });
  }
  return out;
}

/** Length FENCE.segments (16); index === SegmentId. */
export const SEGMENTS: readonly SegmentGeom[] = buildSegments();

/**
 * The collision box of an INTACT segment. A BREACHED segment contributes NO
 * collision at all — the rubble the style bible describes is render-only
 * decoration, and both sides simply walk through the gap at ground level.
 */
export function segmentAABB(seg: SegmentGeom): AABB {
  const along = SEG_LEN / 2;
  const half = FENCE.thickness / 2;
  const horiz = seg.side === 'north' || seg.side === 'south';
  return {
    minX: seg.cx - (horiz ? along : half),
    maxX: seg.cx + (horiz ? along : half),
    minY: 0,
    maxY: FENCE.height,
    minZ: seg.cz - (horiz ? half : along),
    maxZ: seg.cz + (horiz ? half : along),
  };
}

/**
 * Distance from a world point to a segment's WALL — perpendicular distance,
 * clamped to the segment's 10 m span. NOT the distance to its centre point.
 *
 * Frozen as a helper because the two modules that need it are written in
 * parallel and cannot read each other: `srv-fence` owns `nearestSegment` and
 * `srv-survivors` owns `resolveInteract`. Under a centre-point reading with
 * `INTERACT.repairRange` 2.6, a survivor on the firing step (0.875 m
 * perpendicular) could only reach +/-2.45 m along a 10 m segment — 51% of every
 * segment would have been silently un-repairable, a core-loop failure no
 * compiler or unit test would ever surface.
 */
export function segmentDistance(x: number, z: number, seg: SegmentGeom): number {
  const horiz = seg.side === 'north' || seg.side === 'south';
  const half = SEG_LEN / 2;
  const along = horiz ? x - seg.cx : z - seg.cz;
  const across = horiz ? z - seg.cz : x - seg.cx;
  const over = Math.max(0, Math.abs(along) - half);
  return Math.hypot(over, across);
}

/** Where a zombie stands to chew segment `id` (just outside it). */
export function segmentAttackSpot(seg: SegmentGeom): { x: number; z: number } {
  const stand = 1.1;
  return { x: seg.cx + seg.nx * stand, z: seg.cz + seg.nz * stand };
}

// ---------------------------------------------------------------------------
// Static geometry
// ---------------------------------------------------------------------------

/**
 * One flight of treads. Each tread is SOLID from `baseY` up to its top face, so
 * the run is a staircase rather than a set of floating slabs.
 *
 * The flight marches from `outerZ` toward the tower, rising as it goes;
 * `zSign` is the sign of z the flight sits on (+1 = the south face).
 */
function stairRun(baseY: number, outerZ: number, zSign: 1 | -1, mat: MatKind): OutpostBox[] {
  const out: OutpostBox[] = [];
  for (let i = 0; i < STAIR_STEPS; i++) {
    const top = baseY + (i + 1) * STAIR_RISE;
    out.push({
      x: 0,
      y: (top + baseY) / 2,
      z: zSign * (outerZ - (i + 0.5) * STAIR_RUN),
      w: STAIR_WIDTH,
      h: top - baseY,
      d: STAIR_RUN,
      mat,
    });
  }
  return out;
}

function towerBoxes(): OutpostBox[] {
  const b: OutpostBox[] = [];
  const H = TOWER_HALF;

  // --- footing: its TOP FACE (y = FOOTING_H) is the ground floor. Climbable. ---
  b.push({ x: 0, y: FOOTING_H / 2, z: 0, w: H * 2, h: FOOTING_H, d: H * 2, mat: 'stone' });

  // --- deck 1: one solid slab, top face exactly at DECK1_Y ---
  b.push({ x: 0, y: DECK1_Y - SLAB_H / 2, z: 0, w: H * 2, h: SLAB_H, d: H * 2, mat: 'timber' });

  // --- deck 2: four pieces leaving the STAIRWELL opening the upper run rises through ---
  const sw = STAIRWELL;
  const y2 = DECK2_Y - SLAB_H / 2;
  b.push({ x: 0, y: y2, z: (-H + sw.minZ) / 2, w: H * 2, h: SLAB_H, d: sw.minZ + H, mat: 'timber' });
  b.push({ x: 0, y: y2, z: (sw.maxZ + H) / 2, w: H * 2, h: SLAB_H, d: H - sw.maxZ, mat: 'timber' });
  b.push({ x: (-H + sw.minX) / 2, y: y2, z: (sw.minZ + sw.maxZ) / 2, w: sw.minX + H, h: SLAB_H, d: sw.maxZ - sw.minZ, mat: 'timber' });
  b.push({ x: (sw.maxX + H) / 2, y: y2, z: (sw.minZ + sw.maxZ) / 2, w: H - sw.maxX, h: SLAB_H, d: sw.maxZ - sw.minZ, mat: 'timber' });

  // --- posts. Deliberately NOT on the doorway centrelines: the first draft put
  //     one dead centre in each stair doorway and players stopped at the top of
  //     their own staircase for no visible reason. The south pair now flanks
  //     the doorway and reads as a doorframe. ---
  const posts: Array<[number, number]> = [
    [-H + 0.6, -H + 0.6], [H - 0.6, -H + 0.6], [-H + 0.6, H - 0.6], [H - 0.6, H - 0.6],
    [-H + 0.6, 0], [H - 0.6, 0],
    [-(STAIR_WIDTH / 2 + 0.9), H - 1.4], [STAIR_WIDTH / 2 + 0.9, H - 1.4],
    [0, -H + 0.6],
  ];
  for (const [px, pz] of posts) {
    // lower: seated ON the footing top, stopping at the deck-1 slab underside
    b.push({ x: px, y: (FOOTING_H + DECK1_Y - SLAB_H) / 2, z: pz, w: 0.8, h: DECK1_Y - SLAB_H - FOOTING_H, d: 0.8, mat: 'timberDark' });
    // upper: deck-1 top to the deck-2 slab underside
    b.push({ x: px, y: (DECK1_Y + DECK2_Y - SLAB_H) / 2, z: pz, w: 0.8, h: DECK2_Y - SLAB_H - DECK1_Y, d: 0.8, mat: 'timberDark' });
  }

  // --- parapets. Deck 1 opens SOUTH (where the external run arrives). Deck 2
  //     needs no gap at all: it is reached from inside, through the stairwell. ---
  const rail = (deckY: number, gap: Side | null): void => {
    const sides: Array<[Side, number, number, number, number]> = [
      ['north', 0, -H + PARAPET_T / 2, H * 2, PARAPET_T],
      ['south', 0, H - PARAPET_T / 2, H * 2, PARAPET_T],
      ['west', -H + PARAPET_T / 2, 0, PARAPET_T, H * 2],
      ['east', H - PARAPET_T / 2, 0, PARAPET_T, H * 2],
    ];
    for (const [side, px, pz, w, d] of sides) {
      if (side === gap) {
        // DERIVED, like STAIRWELL: the doorway must pass a body standing at the
        // stair's outer edge, so it is the stair width plus a body diameter.
        // At exactly STAIR_WIDTH the outer 0.3 m of a 3.5 m staircase dead-ends
        // on a parapet — visible rather than invisible, but still a stair you
        // cannot use the full width of.
        const doorway = STAIR_WIDTH + 2 * PLAYER.radius;
        const solid = (H * 2 - doorway) / 2;
        const off = doorway / 2 + solid / 2;
        const horiz = side === 'north' || side === 'south';
        for (const s of [-1, 1]) {
          b.push({
            x: horiz ? s * off : px,
            y: deckY + PARAPET_H / 2,
            z: horiz ? pz : s * off,
            w: horiz ? solid : w,
            h: PARAPET_H,
            d: horiz ? d : solid,
            mat: 'timber',
          });
        }
      } else {
        b.push({ x: px, y: deckY + PARAPET_H / 2, z: pz, w, h: PARAPET_H, d, mat: 'timber' });
      }
    }
  };
  rail(DECK1_Y, 'south');
  rail(DECK2_Y, null);

  // --- the two flights ---
  // external: ground -> deck 1, arriving at deck 1's south doorway
  b.push(...stairRun(0, STAIR_OUTER_Z, 1, 'timber'));
  // internal: deck 1 -> deck 2, rising northward through the stairwell opening
  b.push(...stairRun(DECK1_Y, UPPER_RUN_START_Z, 1, 'timber'));

  return b;
}

function fenceBoxes(): OutpostBox[] {
  const b: OutpostBox[] = [];
  for (const seg of SEGMENTS) {
    // EVERY segment gets a firing step, INCLUDING the gate. Skipping the gate
    // left exactly one segment where a defender stands at ground level: eye
    // 1.62 against a 1.6 m fence is a 2 cm clearance and a 1.76 deg depression,
    // so the runner's and shambler's torsos are unhittable there — the precise
    // pathology the fence height was lowered to eliminate, alive on the map's
    // single most-photographed focal point. The "no step across the gate"
    // rationale bought nothing: nothing in the data ever opens the gate.
    const inX = -seg.nx;
    const inZ = -seg.nz;
    const off = FENCE.thickness / 2 + FENCE.stepDepth / 2;
    const horiz = seg.side === 'north' || seg.side === 'south';
    b.push({
      x: seg.cx + inX * off,
      y: FENCE.stepHeight / 2,
      z: seg.cz + inZ * off,
      w: horiz ? SEG_LEN : FENCE.stepDepth,
      h: FENCE.stepHeight,
      d: horiz ? FENCE.stepDepth : SEG_LEN,
      mat: 'sandbag',
    });
  }
  // Corner watch-posts: 4.5 m masts that break the dead-flat horizon line the
  // previous build was called out for. Pulled far enough inside the corner to
  // clear BOTH the fence segments and the firing steps that meet there — at
  // 0.6 they cleared the segments but buried 0.196 m^3 in each step, which is
  // visible z-fighting on one of the most-photographed surfaces in the game.
  const c = FENCE_HALF - (FENCE.thickness / 2 + FENCE.stepDepth + 0.5);
  for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as Array<[number, number]>) {
    b.push({ x: sx * c, y: 2.25, z: sz * c, w: 0.7, h: 4.5, d: 0.7, mat: 'timberDark' });
  }
  return b;
}

/**
 * Obstacles on the approach: burnt-out vehicles and boulders. They give the
 * horde something to path around, break up the treeline silhouette, and stop
 * the ground reading as one enormous flat polygon. All sit well inside the
 * horde's spawn ring so nothing spawns on top of them.
 */
function fieldBoxes(): OutpostBox[] {
  const spec: Array<[number, number, number, number, number, MatKind]> = [
    [-27, -31, 4.4, 1.7, 2.0, 'rust'],
    [30, -22, 2.2, 2.6, 2.2, 'stone'],
    [34, 14, 4.6, 1.8, 2.1, 'rust'],
    [-31, 26, 2.6, 3.0, 2.6, 'stone'],
    [6, 36, 4.4, 1.7, 2.0, 'rust'],
    [-14, -37, 2.4, 2.4, 2.4, 'stone'],
    [22, 32, 2.0, 2.0, 2.0, 'stone'],
    [-38, -8, 4.2, 1.9, 2.0, 'rust'],
  ];
  return spec.map(([x, z, w, h, d, mat]) => ({ x, y: h / 2, z, w, h, d, mat }));
}

/** Every collidable box in the static world (tower + fence furniture + field). */
export const STATIC_BOXES: readonly OutpostBox[] = [...towerBoxes(), ...fenceBoxes(), ...fieldBoxes()];

/**
 * Named `outpostBoxToAABB` and NOT `boxToAABB`: `@fps/shared` exports a
 * `boxToAABB` over its own BoxDefLike, and both barrels are imported together
 * all over this codebase.
 */
export function outpostBoxToAABB(b: OutpostBox): AABB {
  return {
    minX: b.x - b.w / 2,
    maxX: b.x + b.w / 2,
    minY: b.y - b.h / 2,
    maxY: b.y + b.h / 2,
    minZ: b.z - b.d / 2,
    maxZ: b.z + b.d / 2,
  };
}

/** Static collision set. Fence segment AABBs are added by the room on top. */
export const STATIC_SOLIDS: readonly AABB[] = STATIC_BOXES.filter((b) => b.deco !== true).map(outpostBoxToAABB);

// ---------------------------------------------------------------------------
// Spawns
// ---------------------------------------------------------------------------

/**
 * 16 survivor spawns on the top deck, facing OUTWARD.
 *
 * `yaw: -a`, not `a`: position uses (sin a, -cos a) while the engine's forward
 * is (-sin yaw, -cos yaw), so passing `a` mirrors the x component and half the
 * squad spawns staring at the middle of their own tower.
 */
export const SURVIVOR_SPAWNS: readonly SpawnPoint[] = Array.from({ length: 16 }, (_, i) => {
  const a = (i / 16) * Math.PI * 2;
  const r = 5.2;
  const x = Math.sin(a) * r;
  const z = -Math.cos(a) * r;
  return { x, y: DECK2_Y, z, yaw: -a };
});

/** Angle (radians) of horde spawn slot `i` of `n`, on the treeline ring. */
export function hordeSpawnAngle(i: number, n: number, jitter: number): number {
  return ((i % n) / n) * Math.PI * 2 + (jitter - 0.5) * (Math.PI / n);
}

// ---------------------------------------------------------------------------
// Feature points — the ONLY source of camera framing for the capture harness,
// surfaced to it at runtime through the debug API's `mapInfo()`.
// ---------------------------------------------------------------------------

export interface FeaturePoint {
  key: string;
  x: number;
  y: number;
  z: number;
  /** Eye height offset applied when this point is a camera POSITION. */
  eye: number;
}

export const FEATURES: readonly FeaturePoint[] = [
  { key: 'towerTop', x: 0, y: DECK2_Y, z: 0, eye: 1.62 },
  // NOT (0, DECK1_Y, 0): the internal stair run occupies x in [-1.75,1.75],
  // z in [-0.52, 5.0] on deck 1, so the tower's centre point is now INSIDE a
  // stair tread and the deck-1 interior shot would photograph solid timber.
  // That is the ammoCrate-inside-the-footing failure, reintroduced by the very
  // fix for it. `mapTopology.test.ts` now asserts no feature point is buried.
  { key: 'towerDeck', x: -3.5, y: DECK1_Y, z: 0, eye: 1.62 },
  { key: 'towerGround', x: 0, y: FOOTING_H, z: 0, eye: 1.62 },
  // on the footing TOP — the first draft buried this point inside a solid plinth
  // and the interior shot aimed below the floor at an object inside a rock.
  { key: 'ammoCrate', x: 2.5, y: FOOTING_H, z: 2.5, eye: 1.0 },
  { key: 'weaponRack', x: -2.5, y: DECK1_Y, z: -2.5, eye: 1.2 },
  { key: 'gate', x: SEGMENTS[2]?.cx ?? 5, y: 0, z: -FENCE_HALF, eye: 1.4 },
  { key: 'fenceNorth', x: 0, y: 0, z: -FENCE_HALF, eye: 1.4 },
  { key: 'fenceEast', x: FENCE_HALF, y: 0, z: 0, eye: 1.4 },
  { key: 'fenceSouth', x: 0, y: 0, z: FENCE_HALF, eye: 1.4 },
  { key: 'fenceWest', x: -FENCE_HALF, y: 0, z: 0, eye: 1.4 },
  { key: 'treelineNorth', x: 0, y: 0, z: -62, eye: 1.6 },
  { key: 'courtyardNE', x: 11, y: 0, z: -11, eye: 1.62 },
  { key: 'stairFoot', x: 0, y: 0, z: STAIR_OUTER_Z + 1.5, eye: 1.62 },
];

/** What `OutpostDebugApi.mapInfo()` hands the harnesses. */
export interface OutpostMapInfo {
  fenceHalf: number;
  deck1Y: number;
  deck2Y: number;
  footingH: number;
  segments: readonly { id: number; cx: number; cz: number; side: Side; gate: boolean }[];
  features: readonly FeaturePoint[];
}

export const MAP_INFO: OutpostMapInfo = {
  fenceHalf: FENCE_HALF,
  deck1Y: DECK1_Y,
  deck2Y: DECK2_Y,
  footingH: FOOTING_H,
  segments: SEGMENTS.map((s) => ({ id: s.id, cx: s.cx, cz: s.cz, side: s.side, gate: s.gate })),
  features: FEATURES,
};

/** Yaw that points from `from` at `to`. Sim convention: forward = (-sin, -cos). */
export function yawTo(fx: number, fz: number, tx: number, tz: number): number {
  return Math.atan2(-(tx - fx), -(tz - fz));
}

/** Pitch that centres a point `h` metres up at horizontal range `d`. */
export function pitchTo(fx: number, fy: number, fz: number, tx: number, ty: number, tz: number): number {
  const d = Math.hypot(tx - fx, tz - fz);
  return Math.atan2(ty - fy, Math.max(d, 0.5));
}
