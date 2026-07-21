// ============================================================================
// kartPhysics unit tests (FROZEN contract module). Automatic gearbox (upshift
// at gear top + SHIFT_TIME engine cut, downshift hysteresis), steer sign
// contract (positive = RIGHT = yaw decreases), grip-limited understeer cap,
// lateral surface grip, drift mini-turbo, reverse clamp, determinism.
// All deterministic: stepKart directly with fixed DT, no DOM, no randomness.
// Note: the engine/drag equilibrium sits below each gear top, so gearbox tests
// seed speed at/above the top to cross the upshift threshold (same as a turbo
// or downhill overshoot would); drift tests seed speed >= DRIFT_MIN_SPEED.
// ============================================================================
import { describe, expect, it } from 'vitest';
import {
  DRIFT_MIN_SPEED,
  DRIFT_STEER_MUL,
  GEARS,
  GRIP_GRASS,
  GRIP_ROAD,
  LAT_G,
  LAT_G_GRASS,
  MAX_LOCK,
  MIN_LOCK,
  REVERSE_TOP,
  SHIFT_TIME,
  TOP_SPEED,
  TURBO_BOOST,
  TURBO_MIN_S,
  TURBO_S,
  WHEELBASE,
} from './config.js';
import {
  engineRevs,
  forwardSpeed,
  makeKart,
  stepKart,
  type KartInput,
  type KartState,
  type Surface,
} from './kartPhysics.js';

// ---- helpers ---------------------------------------------------------------

const DT = 1 / 120;

function input(over: Partial<KartInput> = {}): KartInput {
  return { throttle: 0, brake: 0, steer: 0, drift: false, ...over };
}

/** Fresh kart at yaw 0 moving forward at the given (signed) speed. */
function atSpeed(speed: number): KartState {
  const s = makeKart(0, 0, 0);
  s.vz = -speed; // yaw 0 faces -z
  return s;
}

function run(s: KartState, inp: KartInput, seconds: number, surface: Surface = 'road'): KartState {
  const steps = Math.round(seconds / DT);
  for (let i = 0; i < steps; i++) stepKart(s, inp, DT, surface);
  return s;
}

/** Speed-sensitive steering lock, mirroring the contract formula. */
function lockAt(speed: number): number {
  const t = Math.min(1, Math.abs(speed) / TOP_SPEED);
  return MAX_LOCK + (MIN_LOCK - MAX_LOCK) * t;
}

/** Yaw rate measured over a single step at the given speed/steer/surface. */
function yawRateAt(speed: number, steer: number, surface: Surface = 'road', drifting = false): number {
  const s = atSpeed(speed);
  if (drifting) {
    s.drifting = true;
    s.driftTime = 0.1;
  }
  stepKart(s, input({ steer, drift: drifting }), DT, surface);
  return s.yaw / DT;
}

// ---- (a) standstill acceleration + automatic gearbox ------------------------

describe('gearbox', () => {
  it('from standstill, full throttle accelerates and never exceeds the gear-1 top while in gear 1', () => {
    const s = makeKart(0, 0, 0);
    const top1 = GEARS[0]!.top;
    let maxInGear1 = 0;
    for (let i = 0; i < Math.round(8 / DT); i++) {
      stepKart(s, input({ throttle: 1 }), DT, 'road');
      const v = forwardSpeed(s);
      if (s.gear === 1) {
        expect(v).toBeLessThanOrEqual(top1 + 1e-9);
        maxInGear1 = Math.max(maxInGear1, v);
      }
    }
    expect(maxInGear1).toBeGreaterThan(7); // strong acceleration off the line
  });

  it('upshifts at the gear top and cuts the engine for SHIFT_TIME (speed stalls during the shift)', () => {
    const s = atSpeed(12); // above gear-1 top: upshifts on the first step
    stepKart(s, input({ throttle: 1 }), DT, 'road');
    expect(s.gear).toBe(2);
    expect(s.shiftLeft).toBeCloseTo(SHIFT_TIME, 10);

    // engine cut: while the shift is in progress, full throttle cannot accelerate
    let prev = forwardSpeed(s);
    let cutSteps = 0;
    while (s.shiftLeft > 0 && cutSteps < 100) {
      stepKart(s, input({ throttle: 1 }), DT, 'road');
      if (s.shiftLeft > 0) {
        const v = forwardSpeed(s);
        expect(v).toBeLessThan(prev); // drag/roll only — the engine is cut
        prev = v;
        cutSteps++;
      }
    }
    expect(cutSteps).toBeGreaterThanOrEqual(Math.floor(SHIFT_TIME / DT) - 2);

    // once the shift completes the engine pulls again in the new gear
    // (short window: the flat per-gear force is strong enough to reach the next
    // top quickly — a 2s pull would legitimately shift AGAIN)
    const afterCut = forwardSpeed(s);
    run(s, input({ throttle: 1 }), 0.3);
    expect(s.gear).toBe(2);
    expect(forwardSpeed(s)).toBeGreaterThan(afterCut);
  });

  it('reaches gear 2 at the gear-1 top and gear 3 at the gear-2 top, each with a shift pause', () => {
    const g1 = atSpeed(GEARS[0]!.top); // >= top triggers the upshift
    stepKart(g1, input({ throttle: 1 }), DT, 'road');
    expect(g1.gear).toBe(2);
    expect(g1.shiftLeft).toBeGreaterThan(0);

    const g2 = atSpeed(GEARS[1]!.top + 0.2);
    g2.gear = 2;
    stepKart(g2, input({ throttle: 1 }), DT, 'road');
    expect(g2.gear).toBe(3);
    expect(g2.shiftLeft).toBeGreaterThan(0);
  });

  it('downshifts with hysteresis (1.5 m/s below the previous top), never below gear 1', () => {
    const floor = GEARS[1]!.top - 1.5;
    const stays = atSpeed(floor + 0.5);
    stays.gear = 3;
    stepKart(stays, input(), DT, 'road');
    expect(stays.gear).toBe(3); // above the hysteresis floor: no downshift

    const drops = atSpeed(floor - 0.5);
    drops.gear = 3;
    stepKart(drops, input(), DT, 'road');
    expect(drops.gear).toBe(2); // below the floor: downshift one gear
  });
});

// ---- (b) steer sign: positive = RIGHT = yaw decreases -----------------------

describe('steer sign', () => {
  it('positive steer turns RIGHT (yaw decreases); negative steer turns LEFT', () => {
    const right = atSpeed(15);
    stepKart(right, input({ steer: 1 }), DT, 'road');
    expect(right.yaw).toBeLessThan(0);

    const left = atSpeed(15);
    stepKart(left, input({ steer: -1 }), DT, 'road');
    expect(left.yaw).toBeGreaterThan(0);

    expect(Math.abs(right.yaw)).toBeCloseTo(Math.abs(left.yaw), 9); // symmetric
  });
});

// ---- (c) grip-limited understeer cap ----------------------------------------

describe('understeer cap', () => {
  it('caps the yaw rate at LAT_G/v at speed, far below the uncapped bicycle rate', () => {
    const v = 25;
    const measured = Math.abs(yawRateAt(v, 1));
    const cap = LAT_G / v;
    // the measured rate IS the cap (within the drag bleed of one step)…
    expect(measured).toBeGreaterThan(cap * 0.9);
    expect(measured).toBeLessThan(cap * 1.1);
    // …and the turn completes much slower than the uncapped bicycle rate
    const uncapped = (v / WHEELBASE) * Math.tan(lockAt(v));
    expect(measured).toBeLessThan(uncapped * 0.5);
  });

  it('does not bind at low speed: full lock stays on the bicycle rate', () => {
    const v = 5; // at 8 m/s the cap already binds (bicycle 2.46 > 11/8), so probe at 5
    const measured = Math.abs(yawRateAt(v, 1));
    const uncapped = (v / WHEELBASE) * Math.tan(lockAt(v));
    expect(Math.abs(measured - uncapped) / uncapped).toBeLessThan(0.02);
    expect(measured).toBeLessThan(LAT_G / v); // comfortably below the cap
  });

  it('is bypassed while drifting (sliding)', () => {
    const v = 25;
    const measured = Math.abs(yawRateAt(v, 1, 'road', true));
    expect(measured).toBeGreaterThan((LAT_G / v) * 5); // way past the road cap
    const expected = (v / WHEELBASE) * Math.tan(lockAt(v) * DRIFT_STEER_MUL);
    expect(Math.abs(measured - expected) / expected).toBeLessThan(0.05);
  });

  it('grass caps the yaw rate at LAT_G_GRASS/v, lower than on road', () => {
    const v = 15;
    const grass = Math.abs(yawRateAt(v, 1, 'grass'));
    const road = Math.abs(yawRateAt(v, 1, 'road'));
    expect(grass).toBeLessThan(road);
    expect(Math.abs(grass - LAT_G_GRASS / v) / (LAT_G_GRASS / v)).toBeLessThan(0.1);
  });
});

// ---- (d) lateral grip per surface -------------------------------------------

describe('lateral grip', () => {
  it('grass kills lateral velocity slower than road', () => {
    const road = makeKart(0, 0, 0);
    road.vx = 6; // pure lateral velocity at yaw 0 (right = +x)
    stepKart(road, input(), DT, 'road');

    const grass = makeKart(0, 0, 0);
    grass.vx = 6;
    stepKart(grass, input(), DT, 'grass');

    expect(road.vx).toBeLessThan(6); // both surfaces bleed lateral speed…
    expect(grass.vx).toBeLessThan(6);
    expect(grass.vx).toBeGreaterThan(road.vx); // …but grass bleeds it slower
    expect(road.vx / 6).toBeCloseTo(1 - GRIP_ROAD * DT, 6);
    expect(grass.vx / 6).toBeCloseTo(1 - GRIP_GRASS * DT, 6);
  });
});

// ---- (e) drift + mini-turbo --------------------------------------------------

describe('drift mini-turbo', () => {
  it('holding a drift for >= TURBO_MIN_S charges a turbo on release', () => {
    const s = atSpeed(20);
    stepKart(s, input({ drift: true }), DT, 'road');
    expect(s.drifting).toBe(true);

    run(s, input({ drift: true, steer: 0.3 }), TURBO_MIN_S + 0.3);
    expect(s.drifting).toBe(true);
    expect(s.driftTime).toBeGreaterThanOrEqual(TURBO_MIN_S);

    stepKart(s, input(), DT, 'road'); // release the handbrake
    expect(s.drifting).toBe(false);
    expect(s.turboLeft).toBeGreaterThan(0);
    expect(s.turboLeft).toBeLessThanOrEqual(TURBO_S);
  });

  it('a short drift (< TURBO_MIN_S) charges no turbo', () => {
    const s = atSpeed(20);
    run(s, input({ drift: true, throttle: 1 }), 0.5);
    stepKart(s, input({ throttle: 1 }), DT, 'road'); // release
    expect(s.drifting).toBe(false);
    expect(s.turboLeft).toBe(0);
  });

  it('the turbo adds TURBO_BOOST of engine acceleration', () => {
    const boosted = atSpeed(20);
    boosted.turboLeft = 1;
    const base = atSpeed(20);
    stepKart(boosted, input(), DT, 'road');
    stepKart(base, input(), DT, 'road');
    expect(forwardSpeed(boosted) - forwardSpeed(base)).toBeCloseTo(TURBO_BOOST * DT, 2);
  });

  it('drift cannot engage below DRIFT_MIN_SPEED', () => {
    const s = atSpeed(DRIFT_MIN_SPEED - 1);
    stepKart(s, input({ drift: true }), DT, 'road');
    expect(s.drifting).toBe(false);
  });
});

// ---- (f) reverse -------------------------------------------------------------

describe('reverse', () => {
  it('brake from standstill reverses, clamped at REVERSE_TOP, staying in gear 1', () => {
    const s = makeKart(0, 0, 0);
    for (let i = 0; i < Math.round(3 / DT); i++) {
      stepKart(s, input({ brake: 1 }), DT, 'road');
      expect(forwardSpeed(s)).toBeGreaterThanOrEqual(-REVERSE_TOP);
      expect(s.gear).toBe(1);
    }
    expect(forwardSpeed(s)).toBeLessThan(-7); // approaches the clamp
    expect(s.z).toBeGreaterThan(0); // yaw 0 faces -z: reversing moves +z
  });
});

// ---- (g) determinism ----------------------------------------------------------

describe('determinism', () => {
  function trace(): string {
    const s = makeKart(3, -2, 0.7);
    const script: KartInput[] = [
      input({ throttle: 1 }),
      input({ throttle: 1, steer: 0.7 }),
      input({ throttle: 1, steer: -0.4, drift: true }),
      input({ brake: 1 }),
      input({ throttle: 0.5, steer: 1 }),
      input(),
    ];
    const out: number[] = [];
    for (let i = 0; i < 600; i++) {
      stepKart(s, script[i % script.length]!, DT, i % 240 < 120 ? 'road' : 'grass');
      out.push(s.x, s.z, s.yaw, s.vx, s.vz, s.gear, s.shiftLeft, s.driftTime, s.turboLeft);
    }
    return JSON.stringify(out);
  }

  it('two identical input sequences bit-match', () => {
    expect(trace()).toBe(trace());
  });
});

// ---- engineRevs ----------------------------------------------------------------

describe('engineRevs', () => {
  it('sweeps 0..1 within the current gear band', () => {
    expect(engineRevs(makeKart(0, 0, 0))).toBe(0);

    const halfG1 = atSpeed(GEARS[0]!.top / 2);
    expect(engineRevs(halfG1)).toBeCloseTo(0.5, 10);

    const over = atSpeed(GEARS[0]!.top * 2); // clamped at the top of the band
    expect(engineRevs(over)).toBe(1);

    const halfG2 = atSpeed((GEARS[0]!.top + GEARS[1]!.top) / 2);
    halfG2.gear = 2;
    expect(engineRevs(halfG2)).toBeCloseTo(0.5, 10);
  });
});
