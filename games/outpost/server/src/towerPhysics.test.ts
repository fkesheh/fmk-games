// ============================================================================
// THE REGRESSION TEST THAT MATTERS MOST.
//
// The previous OUTPOST hand-rolled its own physics with a ground query that
// ran AFTER gravity: every floor of its 3-storey fort was a trapdoor, and
// players spawned on the roof fell straight through both slabs to y=0 within
// 1.5 seconds. The hero object — the tower — was never once visible in any
// judged screenshot, and an entire art-judging round was worthless as a
// result.
//
// OUTPOST now moves every actor with @fps/shared's stepBody (AABB
// collide-and-slide with step-up) against the AABBs frozen in
// @outpost/shared/map. This file builds the SAME solid set the room builds
// per tick (STATIC_SOLIDS + the AABB of every INTACT fence segment — see
// CONTRACT.md's `rebuildSolids()` = STATIC_SOLIDS + fenceSolids(intact)) and
// proves, with real stepBody ticks and no shortcuts, that the tower holds a
// body up, that every level is walkable in both directions on forward input
// alone, that the fence actually blocks (until it doesn't), and that falling
// off the map still resolves cleanly. If any of these regress, the tower is
// a trapdoor again — and no screenshot of it will mean anything.
// ============================================================================
import { describe, expect, it } from 'vitest';
import { PLAYER, makeBody, stepBody } from '@fps/shared';
import type { AABB, BodyState, MoveInput } from '@fps/shared';
import {
  TICK_DT,
  FENCE,
  FENCE_HALF,
  DECK1_Y,
  DECK2_Y,
  FOOTING_H,
  STAIR_OUTER_Z,
  STAIR_RISE,
  SEGMENTS,
  STATIC_SOLIDS,
  SURVIVOR_SPAWNS,
  FEATURES,
  segmentAABB,
} from '@outpost/shared';
import type { SegmentGeom, SegmentId } from '@outpost/shared';

/**
 * The solid set exactly as the room assembles it every tick (CONTRACT.md,
 * `room.ts`'s `rebuildSolids()`): STATIC_SOLIDS plus the AABB of every
 * INTACT fence segment. A breached segment contributes no collision at all —
 * both sides simply walk through the gap at ground level (map.ts's
 * `segmentAABB` doc).
 */
function buildSolids(breached: ReadonlySet<SegmentId> = new Set()): AABB[] {
  const intactWalls = SEGMENTS.filter((s) => !breached.has(s.id)).map(segmentAABB);
  return [...STATIC_SOLIDS, ...intactWalls];
}

/** Every fence segment intact — the steady-state solid set for most of these tests. */
const SOLIDS = buildSolids();

/** Advance an existing body `ticks` times with a fixed input, in place. */
function stepTicks(b: BodyState, solids: AABB[], inp: Partial<MoveInput>, ticks: number): void {
  const i: MoveInput = { moveX: 0, moveZ: 0, yaw: 0, jump: false, crouch: false, walk: false, ...inp };
  for (let t = 0; t < ticks; t++) {
    stepBody(b, i, 1, TICK_DT, solids);
  }
}

/** Spawn a fresh body and advance it `ticks` times with a fixed input. */
function walk(
  solids: AABB[],
  from: { x: number; y: number; z: number },
  inp: Partial<MoveInput>,
  ticks: number,
): BodyState {
  const b = makeBody(from.x, from.y, from.z);
  stepTicks(b, solids, inp, ticks);
  return b;
}

function requireFeature(key: string): { x: number; y: number; z: number } {
  const f = FEATURES.find((p) => p.key === key);
  if (!f) throw new Error(`FEATURES is missing '${key}' — map.ts contract changed`);
  return f;
}

function requireSegment(id: number): SegmentGeom {
  const seg = SEGMENTS[id];
  if (!seg) throw new Error(`SEGMENTS[${id}] missing — map.ts contract changed`);
  return seg;
}

describe('GUARD: the tower holds a body up under zero input', () => {
  it('every SURVIVOR_SPAWNS point holds DECK2_Y for 60 ticks of zero input — deck 2 is not a trapdoor', () => {
    const failed: string[] = [];
    for (const spawn of SURVIVOR_SPAWNS) {
      const b = walk(SOLIDS, spawn, {}, 60);
      if (Math.abs(b.y - DECK2_Y) > 0.05) {
        failed.push(`(${spawn.x.toFixed(2)}, ${spawn.z.toFixed(2)}) settled at y=${b.y.toFixed(3)}`);
      }
    }
    expect(failed, `spawns that fell through deck 2:\n  ${failed.join('\n  ')}`).toEqual([]);
  });

  it('a body resting on deck 1 holds DECK1_Y for 60 ticks of zero input — deck 1 is not a trapdoor', () => {
    const p = requireFeature('towerDeck');
    const b = walk(SOLIDS, p, {}, 60);
    expect(b.y).toBeCloseTo(DECK1_Y, 1);
  });

  it('a body resting on the fence firing step holds its height for 60 ticks of zero input — the firing step is not a trapdoor', () => {
    const seg = requireSegment(0); // north side, first (non-gate) segment
    const inX = -seg.nx;
    const inZ = -seg.nz;
    const off = FENCE.thickness / 2 + FENCE.stepDepth / 2;
    const stepPos = { x: seg.cx + inX * off, y: FENCE.stepHeight, z: seg.cz + inZ * off };
    const b = walk(SOLIDS, stepPos, {}, 60);
    expect(b.y).toBeCloseTo(FENCE.stepHeight, 1);
  });
});

describe('GUARD: every level is reachable by walking, forward input only', () => {
  it('a body climbs the external south run from ground to DECK1_Y on forward input alone', () => {
    // 53 ticks: enough (>47) to clear all 12 treads onto the deck-1 landing,
    // not so many (<59) that it walks on across deck 1 into the internal run.
    const b = walk(SOLIDS, { x: 0, y: 0, z: STAIR_OUTER_Z + 2 }, { moveZ: 1, yaw: 0 }, 53);
    expect(b.y).toBeCloseTo(DECK1_Y, 1);
  });

  it('a body climbs the internal north run from DECK1_Y to DECK2_Y on forward input alone', () => {
    const b = walk(SOLIDS, { x: 0, y: DECK1_Y, z: 6.0 }, { moveZ: 1, yaw: 0 }, 600);
    expect(b.y).toBeCloseTo(DECK2_Y, 1);
  });

  it('a body descends the internal north run from DECK2_Y to DECK1_Y on backward input alone', () => {
    const b = makeBody(0, DECK2_Y, -2);
    stepTicks(b, SOLIDS, { moveZ: -1, yaw: 0 }, 48); // clears every tread down onto the deck-1 landing
    stepTicks(b, SOLIDS, {}, 20); // settle
    expect(b.y).toBeCloseTo(DECK1_Y, 1);
  });

  it('a body descends the external south run from DECK1_Y to the ground on backward input alone', () => {
    // Start z=5.5, not 0: the internal run's own treads occupy x in
    // [-1.75,1.75], z in [-0.52, 5.0] on deck 1 (see map.ts FEATURES'
    // `towerDeck` note) — starting inside that footprint would spawn the
    // body inside solid timber instead of on the open deck.
    // 70 ticks: comfortably past the last tread onto open ground (reached by
    // ~tick 50), stopped well before the south fence's firing step at z~18.5
    // (reached by ~tick 80) so this test measures the stairs, not the fence.
    const b = walk(SOLIDS, { x: 0, y: DECK1_Y, z: 5.5 }, { moveZ: -1, yaw: 0 }, 70);
    expect(b.y).toBeCloseTo(0, 1);
  });
});

describe('GUARD: the fence actually blocks — until it is breached', () => {
  it('an intact fence segment stops a body walking straight at it', () => {
    const seg = requireSegment(0);
    const b = walk(SOLIDS, { x: seg.cx, y: 0, z: seg.cz + 6 }, { moveZ: 1, yaw: 0 }, 150);
    expect(b.z).toBeGreaterThan(-FENCE_HALF);
  });

  it('a breached fence segment lets a body walk straight through its gap', () => {
    const seg = requireSegment(0);
    const breachedSolids = buildSolids(new Set([seg.id]));
    const b = walk(breachedSolids, { x: seg.cx, y: 0, z: seg.cz + 6 }, { moveZ: 1, yaw: 0 }, 150);
    expect(b.z).toBeLessThan(-FENCE_HALF);
  });
});

describe('GUARD: the frozen climbability invariant actually holds', () => {
  it('STAIR_RISE never exceeds PLAYER.stepUp — the law that makes the stairs climbable', () => {
    expect(STAIR_RISE).toBeLessThanOrEqual(PLAYER.stepUp);
  });
});

describe('GUARD: falling off the map resolves cleanly, not into a phantom floor', () => {
  it('a body walking off the ground-floor deck edge falls to y=0 rather than tunnelling or hovering', () => {
    const b = walk(SOLIDS, { x: 5, y: FOOTING_H, z: 3 }, { moveX: 1, yaw: 0 }, 60);
    expect(b.y).toBeLessThan(FOOTING_H);
    expect(b.y).toBeCloseTo(0, 1);
  });
});
