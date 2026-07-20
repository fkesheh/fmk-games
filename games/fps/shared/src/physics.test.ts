// ============================================================================
// T1 — physics unit tests (FROZEN contract module). stepBody collide-and-slide,
// raycasts/hitscan, falloff, spread. All deterministic: fixed TICK_DT, seeded rng.
// ============================================================================
import { describe, expect, it } from 'vitest';
import { PLAYER, TICK_DT, WEAPONS } from './config.js';
import { rng } from './rng.js';
import type { Vec3 } from './types.js';
import {
  applySpread,
  aimDir,
  boxToAABB,
  falloffMul,
  hitscan,
  makeBody,
  raycastAABB,
  stepBody,
  type AABB,
  type BodyState,
  type HitscanTarget,
  type MoveInput,
} from './physics.js';

// ---- helpers ---------------------------------------------------------------

/** Center+size box -> AABB, same shape as map BoxDefs. */
function box(x: number, y: number, z: number, w: number, h: number, d: number): AABB {
  return boxToAABB({ x, y, z, w, h, d });
}

function input(over: Partial<MoveInput> = {}): MoveInput {
  return { moveX: 0, moveZ: 0, yaw: 0, jump: false, crouch: false, walk: false, ...over };
}

function run(b: BodyState, inp: MoveInput, ticks: number, solids: AABB[], speedMul = 1): BodyState {
  for (let i = 0; i < ticks; i++) stepBody(b, inp, speedMul, TICK_DT, solids);
  return b;
}

function dirTo(from: Vec3, to: Vec3): Vec3 {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dz = to.z - from.z;
  const l = Math.hypot(dx, dy, dz);
  return { x: dx / l, y: dy / l, z: dz / l };
}

function must<T>(v: T | null): T {
  if (v === null) throw new Error('unexpected null');
  return v;
}

// ---- movement ---------------------------------------------------------------

describe('stepBody walking', () => {
  it('walks forward at speedRun (30 ticks ~= 4.8m), scaled by moveMul', () => {
    // yaw 0 faces -Z; speed is set directly from input (no accel), so
    // displacement over 30 ticks at 30Hz == speedRun * speedMul exactly.
    const b = makeBody(0, 0, 0);
    run(b, input({ moveZ: 1 }), 30, []);
    expect(b.x).toBeCloseTo(0, 5);
    expect(b.z).toBeCloseTo(-PLAYER.speedRun, 5);

    const heavy = makeBody(0, 0, 0);
    run(heavy, input({ moveZ: 1 }), 30, [], WEAPONS.rifle.moveMul);
    expect(heavy.z).toBeCloseTo(-PLAYER.speedRun * WEAPONS.rifle.moveMul, 5);
  });

  it('normalizes diagonal input to speedRun and slows while crouched', () => {
    const diag = makeBody(0, 0, 0);
    run(diag, input({ moveX: 1, moveZ: 1 }), 30, []);
    expect(Math.hypot(diag.x, diag.z)).toBeCloseTo(PLAYER.speedRun, 5);

    const crouched = makeBody(0, 0, 0);
    run(crouched, input({ moveZ: 1, crouch: true }), 30, []);
    expect(crouched.z).toBeCloseTo(-PLAYER.speedRun * PLAYER.crouchSpeedMul, 5);
    expect(crouched.height).toBe(PLAYER.heightCrouch);
  });

  it('walk (Shift) scales speed by walkSpeedMul, independent of crouch; crouch wins when both', () => {
    const walker = makeBody(0, 0, 0);
    run(walker, input({ moveZ: 1, walk: true }), 30, []);
    expect(walker.z).toBeCloseTo(-PLAYER.speedRun * PLAYER.walkSpeedMul, 5);
    expect(walker.height).toBe(PLAYER.heightStand); // walking never crouches the body

    // both held: crouch takes precedence (crouchSpeedMul < walkSpeedMul)
    const both = makeBody(0, 0, 0);
    run(both, input({ moveZ: 1, walk: true, crouch: true }), 30, []);
    expect(both.z).toBeCloseTo(-PLAYER.speedRun * PLAYER.crouchSpeedMul, 5);
    expect(both.height).toBe(PLAYER.heightCrouch);
  });
});

describe('stepBody vs solids', () => {
  it('blocks at a wall without penetration and slides along it diagonally', () => {
    const wall = box(0, 1.5, -2.5, 40, 3, 1); // near face at z = -2
    const b = makeBody(0, 0, 0);
    run(b, input({ moveX: 1, moveZ: 1 }), 60, [wall]);
    // pressed against the face at exactly one radius, slid sideways past 5m
    expect(b.z).toBeCloseTo(wall.maxZ + PLAYER.radius, 5);
    expect(b.z - PLAYER.radius).toBeGreaterThanOrEqual(wall.maxZ - 1e-9);
    expect(b.x).toBeGreaterThan(5);
  });

  it('stops dead running head-on into a wall', () => {
    const wall = box(0, 1.5, -2.5, 40, 3, 1);
    const b = makeBody(0, 0, 0);
    run(b, input({ moveZ: 1 }), 60, [wall]);
    expect(b.z).toBeCloseTo(wall.maxZ + PLAYER.radius, 5);
    expect(b.x).toBeCloseTo(0, 5);
  });

  it('steps up a 0.4 box but not a 0.6 box', () => {
    // ledge tops at 0.4 (<= PLAYER.stepUp 0.42) are walked onto
    const low = box(0, 0.2, -4, 4, 0.4, 6); // z in [-7,-1], top y=0.4
    const climber = makeBody(0, 0, 0);
    run(climber, input({ moveZ: 1 }), 25, [low]);
    expect(climber.y).toBeCloseTo(0.4, 5);
    expect(climber.onGround).toBe(true);
    expect(climber.z).toBeLessThan(-1);

    // 0.6 is too tall: blocked at the face, stays on the ground
    const high = box(0, 0.3, -4, 4, 0.6, 6); // z in [-7,-1], top y=0.6
    const blocked = makeBody(0, 0, 0);
    run(blocked, input({ moveZ: 1 }), 30, [high]);
    expect(blocked.z).toBeCloseTo(high.maxZ + PLAYER.radius, 5);
    expect(blocked.y).toBe(0);
  });

  it('cannot stand up under a 1.5 ceiling while crouched', () => {
    const ceiling = box(0, 2.25, 0, 4, 1.5, 4); // y in [1.5, 3]
    const b = makeBody(0, 0, 0);
    run(b, input({ crouch: true }), 5, [ceiling]);
    expect(b.height).toBe(PLAYER.heightCrouch);
    // stand request is refused: the grown volume would overlap the ceiling
    run(b, input(), 10, [ceiling]);
    expect(b.height).toBe(PLAYER.heightCrouch);
    // walking out from under it lets the body stand again
    run(b, input({ moveZ: 1 }), 30, [ceiling]);
    expect(b.height).toBe(PLAYER.heightStand);
  });
});

describe('stepBody vertical', () => {
  it('jump: rises then lands back onGround', () => {
    const b = makeBody(0, 0, 0);
    stepBody(b, input({ jump: true }), 1, TICK_DT, []);
    expect(b.onGround).toBe(false);
    expect(b.vy).toBeGreaterThan(0);

    let peak = 0;
    let rose = false;
    for (let i = 0; i < 90 && !b.onGround; i++) {
      const prev = b.y;
      stepBody(b, input(), 1, TICK_DT, []);
      if (b.y > prev) rose = true;
      peak = Math.max(peak, b.y);
    }
    expect(rose).toBe(true);
    // v^2 / 2g = 5.4^2 / 40 = 0.729m
    expect(peak).toBeGreaterThan(0.6);
    expect(peak).toBeLessThan(0.85);
    expect(b.onGround).toBe(true);
    expect(b.y).toBe(0);
    expect(b.vy).toBe(0);
  });

  it('gravity pulls a body from height to the floor y=0', () => {
    const b = makeBody(0, 3, 0);
    run(b, input(), 5, []);
    expect(b.y).toBeLessThan(3);
    expect(b.onGround).toBe(false);
    run(b, input(), 60, []);
    expect(b.y).toBe(0);
    expect(b.onGround).toBe(true);
    expect(b.vy).toBe(0);
  });
});

// ---- raycasts / hitscan -----------------------------------------------------

describe('raycastAABB', () => {
  const s = box(0, 1, -5, 2, 2, 2); // z in [-6,-4], y in [0,2], x in [-1,1]
  it('returns entry distance for a hit, -1 for miss/away/beyond maxDist', () => {
    expect(raycastAABB({ x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: -1 }, s, 100)).toBeCloseTo(4, 5);
    expect(raycastAABB({ x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: 1 }, s, 100)).toBe(-1); // pointing away
    expect(raycastAABB({ x: 5, y: 1, z: 0 }, { x: 0, y: 0, z: -1 }, s, 100)).toBe(-1); // parallel miss
    expect(raycastAABB({ x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: -1 }, s, 2)).toBe(-1); // too far
  });
});

describe('hitscan', () => {
  const eye: Vec3 = { x: 0, y: 1.62, z: 0 };
  const target: HitscanTarget = { id: 'enemy', x: 0, y: 0, z: -10, height: PLAYER.heightStand };

  it('hits the body when aiming at chest height', () => {
    const hit = must(hitscan(eye, dirTo(eye, { x: 0, y: 0.75, z: -10 }), [target], [], 100));
    expect(hit.targetId).toBe('enemy');
    expect(hit.headshot).toBe(false);
    expect(hit.dist).toBeGreaterThan(9);
    expect(hit.dist).toBeLessThan(10);
    expect(hit.point.y).toBeLessThan(1.5); // body box top
  });

  it('scores a headshot when aiming at the head box', () => {
    const hit = must(hitscan(eye, dirTo(eye, { x: 0, y: 1.65, z: -10 }), [target], [], 100));
    expect(hit.targetId).toBe('enemy');
    expect(hit.headshot).toBe(true);
    expect(hit.point.y).toBeGreaterThan(1.5);
  });

  it('is blocked by a solid in between', () => {
    const wall = box(0, 2, -5, 10, 4, 1);
    expect(hitscan(eye, dirTo(eye, { x: 0, y: 0.75, z: -10 }), [target], [wall], 100)).toBeNull();
    expect(hitscan(eye, dirTo(eye, { x: 0, y: 1.65, z: -10 }), [target], [wall], 100)).toBeNull();
  });

  it('respects maxDist', () => {
    expect(hitscan(eye, dirTo(eye, { x: 0, y: 0.75, z: -10 }), [target], [], 5)).toBeNull();
  });
});

// ---- damage falloff / spread ------------------------------------------------

describe('falloffMul', () => {
  const { rangeStart, rangeEnd, minDmgMul } = WEAPONS.pistol; // 18 / 36 / 0.5
  it('is 1 below rangeStart, minDmgMul past rangeEnd, linear between', () => {
    expect(falloffMul(0, rangeStart, rangeEnd, minDmgMul)).toBe(1);
    expect(falloffMul(rangeStart, rangeStart, rangeEnd, minDmgMul)).toBe(1);
    expect(falloffMul(rangeEnd, rangeStart, rangeEnd, minDmgMul)).toBe(minDmgMul);
    expect(falloffMul(1000, rangeStart, rangeEnd, minDmgMul)).toBe(minDmgMul);
    // midpoint of 18..36 is 27 -> halfway between 1 and 0.5
    expect(falloffMul(27, rangeStart, rangeEnd, minDmgMul)).toBeCloseTo(0.75, 10);
  });
});

describe('applySpread', () => {
  it('returns the input dir unchanged at 0 spread', () => {
    const dir = aimDir(0.7, -0.2);
    expect(applySpread(dir, 0, rng(42))).toBe(dir);
  });

  it('is deterministic for a fixed seed and stays inside the spread cone', () => {
    const dir = aimDir(0.3, 0.1);
    const a = applySpread(dir, 5, rng(1234));
    const b = applySpread(dir, 5, rng(1234));
    expect(a).toEqual(b);
    expect(a).not.toEqual(dir);
    expect(Math.hypot(a.x, a.y, a.z)).toBeCloseTo(1, 10);
    const dot = Math.min(1, a.x * dir.x + a.y * dir.y + a.z * dir.z);
    expect(Math.acos(dot)).toBeLessThanOrEqual((5 * Math.PI) / 180 + 1e-9);
  });
});
