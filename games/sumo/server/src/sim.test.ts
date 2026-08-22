import { describe, expect, it } from 'vitest';
// ============================================================================
// SUMO sim tests — pure physics + round rules, no room/clock involved.
// Every number here traces to specs/P10.md or shared/config.ts.
// ============================================================================
import {
  DASH_COOLDOWN_S,
  DASH_IMPULSE,
  FALL_Y,
  GRAVITY,
  JUMP_VY,
  MAX_SPEED,
  PLATFORM_R_END,
  PLATFORM_R_START,
  ROUND_SHRINK_S,
  SIM_DT,
} from '@sumo/shared';
import {
  decideRound,
  hasFallenOut,
  makeBody,
  platformRadiusAt,
  pusherIsA,
  resolvePair,
  stepBody,
} from './sim.js';

const TICKS = (sec: number): number => Math.round(sec / SIM_DT);

describe('movement model', () => {
  it('caps sustained running at MAX_SPEED', () => {
    const b = makeBody(0, 0);
    for (let i = 0; i < TICKS(3); i++) stepBody(b, 0, 1, 0, true, SIM_DT);
    expect(Math.hypot(b.vx, b.vz)).toBeCloseTo(MAX_SPEED, 1);
    // and it actually moved roughly max-speed * time
    expect(b.z).toBeGreaterThan(20);
  });

  it('stops through exponential friction when input releases', () => {
    const b = makeBody(0, 0);
    b.vz = 9;
    for (let i = 0; i < TICKS(2); i++) stepBody(b, 0, 0, 0, true, SIM_DT);
    expect(Math.hypot(b.vx, b.vz)).toBeLessThan(0.01);
  });

  it('normalizes diagonal intent so diagonals are not faster', () => {
    const straight = makeBody(0, 0);
    const diag = makeBody(0, 0);
    for (let i = 0; i < TICKS(1); i++) {
      stepBody(straight, 0, 1, 0, true, SIM_DT);
      stepBody(diag, Math.SQRT1_2, Math.SQRT1_2, 0, true, SIM_DT);
    }
    const vs = Math.hypot(straight.vx, straight.vz);
    const vd = Math.hypot(diag.vx, diag.vz);
    expect(vd).toBeCloseTo(vs, 5);
  });
});

describe('dash', () => {
  it('adds an 18 u/s impulse along the move dir on the press edge', () => {
    const b = makeBody(0, 0);
    const beforeX = b.x;
    stepBody(b, 1, 0, 1 << 0, true, SIM_DT); // BIT_DASH press while moving +x
    // accel this tick contributes ~1.09; the impulse dominates (>=17)
    expect(b.vx).toBeGreaterThan(DASH_IMPULSE - 1.2);
    expect(b.dashCd).toBeCloseTo(DASH_COOLDOWN_S, 5);
    expect(b.x).toBeGreaterThan(beforeX); // moved this same tick
    expect(b.dashFlash).toBeGreaterThan(0); // wire-visible dashing window
  });

  it('holding the button does not re-arm the cooldown (press-edge semantics)', () => {
    const b = makeBody(0, 0);
    let freshCooldowns = 0;
    for (let i = 0; i < TICKS(2); i++) {
      stepBody(b, 0, 0, 1 << 0, true, SIM_DT);
      // A fresh dash stamps the FULL cooldown; holding can never do it twice.
      if (b.dashCd > DASH_COOLDOWN_S - SIM_DT / 2) freshCooldowns++;
    }
    expect(freshCooldowns).toBe(1);
  });

  it('gates a second dash behind the 1.5s cooldown even across release/press', () => {
    const b = makeBody(0, 0);
    stepBody(b, 1, 0, 1 << 0, true, SIM_DT);
    const fast = Math.hypot(b.vx, b.vz);
    // Alternate release/press for the whole cooldown window; every press-edge
    // lands while the cooldown still holds, so speed only ever decays.
    for (let i = 0; i < TICKS(DASH_COOLDOWN_S); i++) {
      const held = i % 2 === 1;
      stepBody(b, 1, 0, held ? 1 << 0 : 0, true, SIM_DT);
      expect(Math.hypot(b.vx, b.vz)).toBeLessThanOrEqual(fast + 1e-9);
    }
    expect(b.dashCd).toBeCloseTo(0, 5);
    stepBody(b, 1, 0, 0, true, SIM_DT); // release settles the latch
    const sp = Math.hypot(b.vx, b.vz);
    stepBody(b, 1, 0, 1 << 0, true, SIM_DT); // NOW the dash lands
    expect(Math.hypot(b.vx, b.vz)).toBeGreaterThan(sp + 10);
  });

  it('refuses to dash while airborne (no air-dash)', () => {
    const b = makeBody(0, 0);
    stepBody(b, 0, 0, 1 << 1, true, SIM_DT); // jump
    expect(b.grounded).toBe(false);
    // one tick of gravity has acted on the launch tick already
    expect(b.vy).toBeGreaterThan(JUMP_VY + GRAVITY * SIM_DT * 1.5);
    stepBody(b, 0, 0, 1 << 0, true, SIM_DT); // bare dash attempt mid-air
    expect(b.dashCd).toBe(0); // never armed
    expect(b.vx).toBe(0); // no horizontal impulse
    expect(b.vz).toBe(0);
  });

  it('decays dash overshoot back under MAX_SPEED through friction alone', () => {
    const b = makeBody(0, 0);
    stepBody(b, 1, 0, 1 << 0, true, SIM_DT);
    expect(Math.hypot(b.vx, b.vz)).toBeGreaterThan(MAX_SPEED);
    for (let i = 0; i < TICKS(1); i++) stepBody(b, 0, 0, 0, true, SIM_DT);
    expect(Math.hypot(b.vx, b.vz)).toBeLessThanOrEqual(MAX_SPEED + 1e-6);
  });
});

describe('jump + gravity', () => {
  it('rises at 8 u/s and comes back down under g=-22, landing grounded', () => {
    const b = makeBody(0, 0);
    stepBody(b, 0, 0, 1 << 1, true, SIM_DT);
    // one tick of gravity has already acted on the launch tick
    expect(b.vy).toBeCloseTo(JUMP_VY + GRAVITY * SIM_DT, 5);
    let peak = b.y;
    let landed = false;
    for (let i = 0; i < TICKS(3); i++) {
      stepBody(b, 0, 0, 0, true, SIM_DT);
      peak = Math.max(peak, b.y);
      if (b.grounded && i > 2) landed = true;
    }
    // Discrete (semi-implicit Euler) integration lands ~8% under the
    // continuous apex v²/2g = 1.4545u; bound it loosely rather than exactly.
    expect(peak).toBeGreaterThan((JUMP_VY * JUMP_VY) / (2 * -GRAVITY) - 0.25); // ~1.2u floor
    expect(peak).toBeLessThan(2);
    expect(landed).toBe(true);
    expect(b.y).toBe(0);
  });

  it('cannot jump twice without touching the ground', () => {
    const b = makeBody(0, 0);
    stepBody(b, 0, 0, 1 << 1, true, SIM_DT);
    const v1 = b.vy;
    stepBody(b, 0, 0, 1 << 1, true, SIM_DT);
    expect(b.vy).toBeLessThan(v1); // gravity acted, no second launch
  });
});

describe('elastic circle pushout', () => {
  it('splits overlap half/half along the normal', () => {
    const a = makeBody(0, 0);
    const b = makeBody(0.4, 0); // min distance is 1.2 -> 0.8 overlap
    resolvePair(a, b);
    expect(Math.hypot(b.x - a.x, b.z - a.z)).toBeCloseTo(1.2, 5);
    expect(a.x).toBeLessThan(0);
    expect(b.x).toBeGreaterThan(0.4);
  });

  it('is momentum-weighted: a dashing shover launches a standing shovee', () => {
    const a = makeBody(-2, 0);
    a.vx = 18; // post-dash shover
    const b = makeBody(-1.0, 0); // standing, inside the 1.2 contact range
    expect(pusherIsA(a, b)).toBe(true);
    const impact = resolvePair(a, b);
    expect(impact).toBeCloseTo(18, 5);
    // equal-mass elastic with e=.9: impulse .95*18 = 17.1 transfers forward
    expect(b.vx).toBeCloseTo(17.1, 5);
    expect(b.vx).toBeGreaterThan(MAX_SPEED); // LAUNCHED past the cap
    expect(a.vx).toBeCloseTo(0.9, 5); // the shover nearly stops
  });

  it('bounces two equal head-on movers symmetrically', () => {
    const a = makeBody(-2, 0);
    a.vx = 3;
    const b = makeBody(-0.9, 0);
    b.vx = -3;
    const impact = resolvePair(a, b);
    expect(impact).toBeCloseTo(6, 5);
    expect(a.vx).toBeCloseTo(-2.7, 5);
    expect(b.vx).toBeCloseTo(2.7, 5);
  });

  it('does nothing for separated or separating pairs', () => {
    const a = makeBody(0, 0);
    const far = makeBody(5, 0);
    expect(resolvePair(a, far)).toBe(0);
    const sepA = makeBody(0, 0);
    const sepB = makeBody(1, 0);
    sepB.vx = 5; // moving AWAY from a
    const before = { ax: sepA.vx, bx: sepB.vx };
    expect(resolvePair(sepA, sepB)).toBe(0);
    expect(sepA.vx).toBe(before.ax);
    expect(sepB.vx).toBe(before.bx);
  });

  it('handles perfectly coincident bodies deterministically', () => {
    const a = makeBody(3, 3);
    const b = makeBody(3, 3);
    expect(resolvePair(a, b)).toBe(0);
    expect(Math.hypot(b.x - a.x, b.z - a.z)).toBeCloseTo(1.2, 5);
  });
});

describe('platform shrink timeline', () => {
  it('shrinks 14 -> 4 linearly over 45s and clamps outside the window', () => {
    expect(platformRadiusAt(0)).toBeCloseTo(PLATFORM_R_START, 9);
    expect(platformRadiusAt(ROUND_SHRINK_S / 2)).toBeCloseTo(9, 9); // midpoint
    expect(platformRadiusAt(ROUND_SHRINK_S)).toBeCloseTo(PLATFORM_R_END, 9);
    expect(platformRadiusAt(-5)).toBeCloseTo(PLATFORM_R_START, 9);
    expect(platformRadiusAt(1000)).toBeCloseTo(PLATFORM_R_END, 9);
  });

  it('is monotonically non-increasing across every sampled instant', () => {
    let prev = platformRadiusAt(0);
    for (let t = 0.25; t <= ROUND_SHRINK_S + 5; t += 0.25) {
      const r = platformRadiusAt(t);
      expect(r).toBeLessThanOrEqual(prev + 1e-12);
      prev = r;
    }
  });
});

describe('fall detection', () => {
  it('walks off the shrinking edge and passes FALL_Y', () => {
    const b = makeBody(PLATFORM_R_START - 0.5, 0);
    let elapsed = 0;
    let out = false;
    for (let i = 0; i < TICKS(20); i++) {
      elapsed += SIM_DT;
      const radius = platformRadiusAt(elapsed); // still ~14 early on
      stepBody(b, 1, 0, 0, Math.hypot(b.x, b.z) <= radius, SIM_DT);
      if (hasFallenOut(b)) {
        out = true;
        break;
      }
    }
    expect(out).toBe(true);
    expect(b.y).toBeLessThan(FALL_Y);
    expect(b.grounded).toBe(false);
  });

  it('keeps falling once below the rim even if drift re-enters the radius', () => {
    const b = makeBody(0, 0);
    b.y = -2; // already sank well below the disc
    b.vy = -5;
    stepBody(b, 0, 0, 0, true, SIM_DT); // "supported" but far below
    expect(b.y).toBeLessThan(-2); // kept falling, did not teleport up
  });
});

describe('round decision (frozen rule)', () => {
  it('draws when nobody survived', () => {
    expect(decideRound([])).toEqual({ winner: null, draw: true });
  });

  it('hands the round to the sole survivor', () => {
    expect(decideRound([{ id: 'p2', distToCenter: 7 }])).toEqual({ winner: 'p2', draw: false });
  });

  it('times out to the MOST CENTERED survivor when several remain', () => {
    const outcome = decideRound([
      { id: 'rim', distToCenter: 11 },
      { id: 'mid', distToCenter: 0.5 },
      { id: 'half', distToCenter: 5 },
    ]);
    expect(outcome).toEqual({ winner: 'mid', draw: false });
  });

  it('breaks exact center-distance ties to the earliest entry (deterministic)', () => {
    const outcome = decideRound([
      { id: 'first', distToCenter: 3 },
      { id: 'second', distToCenter: 3 },
    ]);
    expect(outcome.winner).toBe('first');
  });
});
