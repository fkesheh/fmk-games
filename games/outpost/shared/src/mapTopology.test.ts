// FROZEN CONTRACT GUARD — RIDGELINE topology.
//
// A sound physics engine does not give you a reachable building. Three
// independent pre-freeze reviewers ran stepBody against the first draft of
// map.ts and all reported "deck1 -> deck2 reachable: false". This file exists
// so that can never be true again without a red test. Do not delete it, and do
// not weaken an assertion to make it pass — fix the map.
import { describe, expect, it } from 'vitest';
import { PLAYER, makeBody, stepBody } from '@fps/shared';
import type { AABB, MoveInput } from '@fps/shared';
import { TICK_DT, FENCE } from './config.js';
import {
  DECK1_Y, DECK2_Y, FOOTING_H, STAIR_OUTER_Z, SEGMENTS, STATIC_SOLIDS,
  SURVIVOR_SPAWNS, segmentAABB, FEATURES, FENCE_HALF,
  STAIR_RISE_OK, FOOTING_OK, FIRING_STEP_OK,
} from './map.js';

const SOLIDS: AABB[] = [...STATIC_SOLIDS, ...SEGMENTS.map(segmentAABB)];

function walk(
  from: { x: number; y: number; z: number },
  inp: Partial<MoveInput>,
  ticks: number,
): { x: number; y: number; z: number; minY: number; maxY: number } {
  const b = makeBody(from.x, from.y, from.z);
  const i: MoveInput = { moveX: 0, moveZ: 0, yaw: 0, jump: false, crouch: false, walk: false, ...inp };
  let minY = b.y;
  let maxY = b.y;
  for (let t = 0; t < ticks; t++) {
    stepBody(b, i, 1, TICK_DT, SOLIDS);
    if (b.y < minY) minY = b.y;
    if (b.y > maxY) maxY = b.y;
  }
  return { x: b.x, y: b.y, z: b.z, minY, maxY };
}

// ---------------------------------------------------------------------------
// LANE SWEEPS. A centreline-only guard passes any map that keeps a 0.6 m
// corridor open — which is exactly how the second draft shipped a jam in a
// 0.25 m lane down each side of the internal run, with the identical `y=5.667`
// signature the first draft died of. Every traversal below is swept across the
// full stair width, not walked at x=0.
// ---------------------------------------------------------------------------

const LANES: number[] = [];
// sweep the FULL stair half-width (1.75), not a comfortable inset: the doorway
// half-width is exactly STAIR_WIDTH/2 + PLAYER.radius, i.e. ZERO spare margin,
// so the outermost lanes are precisely where a regression would land.
for (let x = -1.75; x <= 1.7501; x += 0.05) LANES.push(Math.round(x * 100) / 100);

describe('GUARD: every lane of the tower is walkable, not just the centreline', () => {
  it('ground -> deck2 succeeds from EVERY lane across the stair width', () => {
    const failed: string[] = [];
    for (const x of LANES) {
      const e = walk({ x, y: 0, z: STAIR_OUTER_Z + 2 }, { moveZ: 1, yaw: 0 }, 900);
      if (Math.abs(e.y - DECK2_Y) > 0.1) failed.push(`x=${x} stalled at y=${e.y.toFixed(3)} z=${e.z.toFixed(2)}`);
    }
    expect(failed, `lanes that never reached deck 2:\n  ${failed.join('\n  ')}`).toEqual([]);
  });

  it('deck1 -> deck2 succeeds from EVERY lane of the internal run', () => {
    const failed: string[] = [];
    for (const x of LANES) {
      const e = walk({ x, y: DECK1_Y, z: 6.0 }, { moveZ: 1, yaw: 0 }, 600);
      if (Math.abs(e.y - DECK2_Y) > 0.1) failed.push(`x=${x} stalled at y=${e.y.toFixed(3)} z=${e.z.toFixed(2)}`);
    }
    expect(failed, `lanes jammed on the internal run:\n  ${failed.join('\n  ')}`).toEqual([]);
  });
});

describe('GUARD: every fence segment is a usable firing position', () => {
  it('all 16 segments allow a torso shot at a zombie in melee reach', () => {
    const bad: string[] = [];
    for (const seg of SEGMENTS) {
      const horiz = seg.side === 'north' || seg.side === 'south';
      const inX = -seg.nx;
      const inZ = -seg.nz;
      const start = { x: seg.cx + inX * 4, y: FENCE.stepHeight, z: seg.cz + inZ * 4 };
      const yaw = horiz ? (seg.nz < 0 ? 0 : Math.PI) : seg.nx > 0 ? -Math.PI / 2 : Math.PI / 2;
      const e = walk(start, { moveZ: 1, yaw }, 300);
      const eyeY = e.y + PLAYER.heightStand - PLAYER.eyeOffset;
      const along = horiz ? Math.abs(e.z - seg.cz) : Math.abs(e.x - seg.cx);
      // the far (outer) face is what occludes the shot — measuring to the near
      // face reported lowest=0.06 where the true figure is 1.00, ~3x optimistic
      const run = along + FENCE.thickness / 2;
      const clear = eyeY - FENCE.height;
      const lowest = eyeY - (clear / Math.max(run, 0.01)) * (along + 1.1);
      // a runner's head-top is 1.75 — the torso must be reachable, not just the skull
      if (lowest > 1.4) bad.push(`seg ${seg.id} (${seg.side}${seg.gate ? ', GATE' : ''}): lowest=${lowest.toFixed(3)} clear=${clear.toFixed(3)}`);
    }
    expect(bad, `segments where zombie torsos are unhittable:\n  ${bad.join('\n  ')}`).toEqual([]);
  });
});

describe('GUARD: no camera feature point is buried in geometry', () => {
  it('every FEATURES point and its eye position is outside every solid', () => {
    const buried: string[] = [];
    for (const f of FEATURES) {
      for (const [label, y] of [['feet', f.y + 0.1], ['eye', f.y + f.eye]] as Array<[string, number]>) {
        const hit = SOLIDS.find(
          (s) => f.x > s.minX && f.x < s.maxX && y > s.minY && y < s.maxY && f.z > s.minZ && f.z < s.maxZ,
        );
        // fence feature points sit ON the fence plane and are look-at TARGETS,
        // never camera positions; everything else must be clear.
        const isFenceTarget = f.key.startsWith('fence') || f.key === 'gate';
        if (hit && !isFenceTarget) buried.push(`${f.key} ${label} inside solid at y=${y.toFixed(2)}`);
      }
    }
    expect(buried, `feature points inside geometry:\n  ${buried.join('\n  ')}`).toEqual([]);
  });
});

describe('GUARD: the frozen climbability invariants actually hold', () => {
  it('every rise a survivor must climb is within PLAYER.stepUp', () => {
    expect(STAIR_RISE_OK, 'STAIR_RISE > PLAYER.stepUp — the stairs are unclimbable').toBe(true);
    expect(FOOTING_OK, 'FOOTING_H > PLAYER.stepUp — the ground floor is unenterable').toBe(true);
    expect(FIRING_STEP_OK, 'FENCE.stepHeight > PLAYER.stepUp — the firing step is unusable').toBe(true);
  });
});

describe('PROBE: the tower is reachable', () => {
  it('all 16 spawns hold the top deck with zero input', () => {
    for (const s of SURVIVOR_SPAWNS) {
      const e = walk(s, {}, 60);
      expect(`${Math.round(e.y * 100) / 100}`).toBe(`${DECK2_Y}`);
    }
  });

  it('ground -> deck1 -> deck2 in ONE continuous walk north', () => {
    // the whole point: no jump, no lateral correction, forward input only
    const e = walk({ x: 0, y: 0, z: STAIR_OUTER_Z + 2 }, { moveZ: 1, yaw: 0 }, 600);
    expect(e.y).toBeCloseTo(DECK2_Y, 1);
  });

  it('deck2 -> deck1 -> ground walking back south', () => {
    const e = walk({ x: 0, y: DECK2_Y, z: -2 }, { moveZ: -1, yaw: 0 }, 150);
    // it descends all the way to ground level at some point in the walk
    expect(e.minY).toBeCloseTo(0, 1);
    expect(e.z).toBeGreaterThan(STAIR_OUTER_Z - 2);
  });

  it('the ground floor (footing top) can be walked onto from outside', () => {
    const e = walk({ x: 4, y: 0, z: 12 }, { moveZ: 1, yaw: 0 }, 40);
    expect(e.y).toBeCloseTo(FOOTING_H, 1);
  });

  it('the ammo crate feature point is standable', () => {
    const f = FEATURES.find((p) => p.key === 'ammoCrate');
    expect(f).toBeDefined();
    const e = walk({ x: f!.x, y: f!.y + 0.5, z: f!.z }, {}, 60);
    expect(e.y).toBeCloseTo(FOOTING_H, 1);
  });

  it('an intact fence segment cannot be walked through', () => {
    const e = walk({ x: 0, y: 0, z: -FENCE_HALF + 6 }, { moveZ: 1, yaw: 0 }, 400);
    expect(e.z).toBeGreaterThan(-FENCE_HALF);
  });

  it('a survivor on the firing step can depress onto a zombie at the fence', () => {
    // stand on the step, walk into the fence
    const e = walk({ x: -15, y: FENCE.stepHeight, z: -FENCE_HALF + 4 }, { moveZ: 1, yaw: 0 }, 300);
    const eyeY = e.y + PLAYER.heightStand - PLAYER.eyeOffset;
    const outerFace = -FENCE_HALF - FENCE.thickness / 2;
    const run = Math.abs(e.z - outerFace);
    const clear = eyeY - FENCE.height;
    const slope = clear / run;
    const zombieRange = Math.abs(e.z - (-FENCE_HALF - 1.1));
    const lowest = eyeY - slope * zombieRange;
    // the shortest kind (runner, head-top 1.75) must be hittable well below its head
    expect(lowest).toBeLessThan(1.4);
  });
});
