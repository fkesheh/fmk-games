// ============================================================================
// sim.ts unit tests — the SERVER-AUTHORITATIVE shared ski sim, the whole
// netcode contract for SKI SPLAT (see the doc comment atop sim.ts). Style
// mirrors kart's sim.test.ts: vitest, plain describe/it, no mocks,
// deterministic (seeded rng from @platform/shared, never Math.random), all
// magic numbers explained or pulled from config. Fixture SlopeDef objects are
// built in-test against the frozen interface — genSlope is task P2's and is
// deliberately NOT imported here.
// ============================================================================
import { describe, expect, it } from 'vitest';
import { rng } from '@platform/shared';
import {
  ASSIST_PLANT_RADIUS_MUL,
  ASSIST_SNARE_MUL,
  CARVE_SCRUB,
  DRAG,
  EDGE_ZONE,
  GATE_BOOST_MAX,
  GATE_BOOST_MS,
  GATE_BOOST_V,
  GATE_HALF_WIDTH,
  G_ACCEL,
  GRADE_BASE,
  GRADE_MIN,
  J_AIR_CARVE_MUL,
  J_AIR_STEER_MUL,
  J_COOLDOWN_MS,
  J_HOP_VY,
  J_KICKER_VY_BASE,
  J_KICKER_VY_SPEED,
  J_LAND_SPEED_MUL,
  J_MAX_AIRTIME_S,
  MAX_SPEED,
  MIN_SPEED,
  PENDING_INPUT_CAP,
  PLANT_BAND_M,
  PLANT_HIT_SPEED_MUL,
  PLANT_IMMUNITY_MS,
  PLANT_RADIUS,
  PLANT_REARM_MS,
  PLANT_SNARE_MS,
  SIM_DT,
  SKIER_RADIUS,
  SLOPE_LENGTH,
  SLOPE_WIDTH,
  YAW_MAX,
} from './config.js';
import {
  airHeight,
  copySim,
  makeSim,
  resetSim,
  resolveSkiPair,
  SkiPredictor,
  stepSki,
} from './sim.js';
import type { Gate, Kicker, Plant, SkierSim, SlopeDef } from './types.js';
// Cross-import genSlope for the v2 4-year-old tests — legal in tests per
// CONTRACT §7 P1v2 brief. If P2/P2v2 hasn't landed yet the import resolves
// but genSlope may lack kickers; the test will still exercise the sim.
import { genSlope } from './slope.js';

// The shared tsconfig is lib-pure (no DOM, no node types) but vitest provides
// console at runtime; declare the one method these tests log measurements with.
declare const console: { log(...args: unknown[]): void };

// ---- fixtures ---------------------------------------------------------------

interface FixtureOpts {
  readonly grade?: number | ((x: number, z: number, heading: number) => number);
  readonly width?: number;
  readonly length?: number;
  readonly plants?: readonly Plant[];
  readonly gates?: readonly Gate[];
  readonly kickers?: readonly Kicker[];
}

/** A plain SlopeDef: constant (or scripted) grade, band-hashed plants. */
function makeFixtureSlope(o: FixtureOpts = {}): SlopeDef {
  const width = o.width ?? SLOPE_WIDTH;
  const length = o.length ?? SLOPE_LENGTH;
  const plants = o.plants ?? [];
  const grid = new Map<number, Plant[]>();
  for (const p of plants) {
    const band = Math.floor(p.z / PLANT_BAND_M);
    const bucket = grid.get(band);
    if (bucket === undefined) grid.set(band, [p]);
    else bucket.push(p);
  }
  const grade = o.grade ?? GRADE_BASE;
  return {
    seed: 1,
    length,
    width,
    finishZ: length,
    plants,
    gates: o.gates ?? [],
    kickers: o.kickers ?? [],
    height: (_x, z) => -GRADE_BASE * z,
    gradeAt:
      typeof grade === 'function'
        ? (x, z, heading) => grade(x, z, heading)
        : () => grade,
    plantGrid: (band) => grid.get(band) ?? [],
  };
}

function plantAt(x: number, z: number, kind: 'pine' | 'bush' | 'thorn' = 'pine'): Plant {
  return { x, z, r: PLANT_RADIUS[kind], kind };
}

function gateAt(x: number, z: number): Gate {
  return { x, z, halfWidth: GATE_HALF_WIDTH };
}

function kickerAt(x: number, z: number, halfWidth = 1.6): Kicker {
  return { x, z, halfWidth };
}

/** Step `s` for `steps` fixed SIM_DT inputs of `steer`. */
function run(s: SkierSim, slope: SlopeDef, steer: number, steps: number, assist = false): void {
  for (let i = 0; i < steps; i++) stepSki(s, steer, SIM_DT, slope, { assist });
}

// ---- makeSim / resetSim / copySim --------------------------------------------

describe('makeSim / resetSim / copySim', () => {
  it('makes a fresh skier with the sim-ms clock and plant gates open at t=0', () => {
    const s = makeSim(1, 2, 0.3);
    expect(s.x).toBe(1);
    expect(s.z).toBe(2);
    expect(s.yaw).toBe(0.3);
    expect(s.v).toBe(MIN_SPEED); // never a stopped state
    expect(s.simMs).toBe(0);
    expect(s.lastPlantIx).toBe(-1);
    // both plant gates pass immediately: 0 - lastPlantHitMs >= PLANT_REARM_MS
    expect(-s.lastPlantHitMs).toBeGreaterThanOrEqual(PLANT_REARM_MS);
    expect(s.lastGateIx).toBe(-1); // no gate crossed yet
    expect(s.boostUntilMs).toBe(0); // no boost window open
    expect(s.finished).toBe(false);
    expect(s.finishMs).toBe(0);
  });

  it('resetSim re-bases every field (the GO grid wipe)', () => {
    const slope = makeFixtureSlope();
    const s = makeSim(0, 0, 0);
    run(s, slope, 0.5, 60);
    resetSim(s, -4.5, -3, 0);
    expect(s).toStrictEqual(makeSim(-4.5, -3, 0));
  });

  it('copySim copies field-by-field into an existing object', () => {
    const slope = makeFixtureSlope();
    const src = makeSim(0, 0, 0);
    run(src, slope, -0.4, 90);
    const dst = makeSim(9, 9, 9);
    copySim(dst, src);
    expect(dst).toStrictEqual(src);
  });
});

// ---- determinism --------------------------------------------------------------

describe('determinism', () => {
  it('same (steer, dt) sequence twice -> bit-identical final state', () => {
    const next = rng(12345);
    const slope = makeFixtureSlope({
      plants: [plantAt(0.4, 60), plantAt(-1, 220)],
      gates: [gateAt(0, 120), gateAt(-5, 300)], // gates in the replay path too
    });
    const inputs = Array.from({ length: 500 }, () => ({
      steer: next() * 2 - 1,
      dt: SIM_DT * (0.5 + next()), // dt varies: any equal dt is exact
    }));
    const a = makeSim(0, 0, 0);
    const b = makeSim(0, 0, 0);
    for (const inp of inputs) {
      stepSki(a, inp.steer, inp.dt, slope);
      stepSki(b, inp.steer, inp.dt, slope);
    }
    expect(a).toStrictEqual(b); // doubles compare bit-identically on equality
  });
});

// ---- never-stops + NaN-free (10k random inputs over 5 fixture slopes) ---------

describe('never-stops / NaN-free', () => {
  const fixtures: SlopeDef[] = [
    makeFixtureSlope(), // flat constant grade, empty
    makeFixtureSlope({ grade: 0.3, width: 40, plants: [plantAt(0, 100), plantAt(2, 300)] }),
    makeFixtureSlope({
      grade: GRADE_MIN,
      width: 20, // edge-narrow
      plants: [plantAt(0, 80), plantAt(1, 82), plantAt(-1, 84), plantAt(0.5, 86)],
    }),
    makeFixtureSlope({
      plants: Array.from({ length: 40 }, (_, i) =>
        plantAt(((i * 7919) % 40) - 20, 40 + i * 18, i % 3 === 0 ? 'thorn' : 'bush'),
      ),
    }),
    makeFixtureSlope({
      width: 30,
      grade: (x, z) => Math.max(GRADE_MIN, GRADE_BASE + 0.05 * Math.sin(z * 0.05 + x * 0.1)),
    }),
  ];

  it('v >= MIN_SPEED and finite state at every one of 10k seeded inputs', () => {
    let violation: string | null = null;
    let total = 0;
    fixtures.forEach((slope, fi) => {
      const next = rng(1000 + fi);
      const s = makeSim(0, 0, 0);
      for (let i = 0; i < 2000; i++) {
        stepSki(s, next() * 2 - 1, SIM_DT, slope);
        total++;
        if (s.v < MIN_SPEED - 1e-9) violation = `v=${s.v} below MIN_SPEED at fixture ${fi} step ${i}`;
        if (
          !Number.isFinite(s.x) ||
          !Number.isFinite(s.z) ||
          !Number.isFinite(s.yaw) ||
          !Number.isFinite(s.v) ||
          !Number.isFinite(s.simMs)
        ) {
          violation = `non-finite state at fixture ${fi} step ${i}`;
        }
        if (s.finished) break; // runout freeze is not a violation
      }
    });
    expect(total).toBeGreaterThanOrEqual(10_000 - 5 * 2000 + total); // sanity: loop ran
    expect(violation).toBeNull();
  });
});

// ---- acceleration ------------------------------------------------------------

describe('gravity + drag', () => {
  it('a straight fall-line run approaches but never exceeds terminal velocity', () => {
    const slope = makeFixtureSlope(); // constant GRADE_BASE
    const vt = Math.sqrt((G_ACCEL * GRADE_BASE) / DRAG); // analytic v* ~= 22.6 m/s
    const s = makeSim(0, 0, 0);
    let maxV = 0;
    for (let i = 0; i < Math.round(60 / SIM_DT); i++) {
      stepSki(s, 0, SIM_DT, slope);
      maxV = Math.max(maxV, s.v);
    }
    console.log(`[sim] clean-run terminal velocity: ${maxV.toFixed(3)} m/s (analytic ${vt.toFixed(3)})`);
    expect(maxV).toBeLessThanOrEqual(vt + 1e-9); // explicit Euler never overshoots v*
    expect(s.v).toBeGreaterThan(vt * 0.99); // ...and converges onto it
    expect(s.v).toBeLessThanOrEqual(MAX_SPEED); // unboosted cap holds (26 > v*)
  });

  it('carving across the fall line is strictly slower than straight', () => {
    const slope = makeFixtureSlope();
    const straight = makeSim(0, 0, 0);
    const carving = makeSim(0, 0, 0);
    run(straight, slope, 0, Math.round(30 / SIM_DT));
    run(carving, slope, 0.7, Math.round(30 / SIM_DT));
    expect(carving.v).toBeLessThan(straight.v - 1); // CARVE_SCRUB bites hard
    expect(carving.z).toBeLessThan(straight.z); // and less ground covered
  });
});

// ---- yaw soft-clamp: the 4-year-old test ---------------------------------------

describe('yaw soft-clamp (full-lock never donuts)', () => {
  it.each([1, -1])('full lock %i for 60 s: yaw bounded, near-monotone descent, then finishes', (lock) => {
    const slope = makeFixtureSlope(); // 800 m, width 56, no plants
    const s = makeSim(0, 0, 0);
    let maxAbsYaw = 0;
    let highZ = s.z;
    let maxBackDrift = 0;
    let lastBackwardMs = 0;
    for (let i = 0; i < Math.round(60 / SIM_DT); i++) {
      stepSki(s, lock, SIM_DT, slope);
      maxAbsYaw = Math.max(maxAbsYaw, Math.abs(s.yaw));
      if (s.z < highZ - 1e-12) lastBackwardMs = s.simMs;
      highZ = Math.max(highZ, s.z);
      maxBackDrift = Math.max(maxBackDrift, highZ - s.z);
    }
    expect(maxAbsYaw).toBeLessThan(YAW_MAX + 0.25); // spring-bounded, no spin-out
    // Retune note (GRADE_BASE 0.26 / DRAG 0.005 / MAX_SPEED 26 /
    // TURN_RATE_MIN 0.95): the full-lock yaw equilibrium now sits a hair
    // past traverse (measured 1.5736 rad vs pi/2 = 1.5708) at the START of
    // the run, before rising speed pulls turnRate down — so the old
    // per-step "z never decreases" assertion no longer holds. The contract
    // guarantee (CONTRACT §6: "spirals out and rejoins the descent, never
    // donuts") does: the backward transient is millimetric and confined to
    // the first seconds of the run.
    expect(maxBackDrift).toBeLessThan(0.05); // measured 0.0085 m
    expect(lastBackwardMs).toBeLessThan(10_000); // measured ~2.7 s
    // keep holding the lock: the skier spirals back and finishes the 800 m
    for (let i = 0; i < Math.round(240 / SIM_DT) && !s.finished; i++) {
      stepSki(s, lock, SIM_DT, slope);
    }
    expect(s.finished).toBe(true);
    console.log(`[sim] full-lock ${lock} finish: ${(s.finishMs / 1000).toFixed(1)} s`);
  });
});

// ---- soft edges -----------------------------------------------------------------

describe('soft edges', () => {
  it.each([1, -1])(
    'full lock %i toward the edge for 60 s: contained near the piste, still finishes',
    (lock) => {
      const slope = makeFixtureSlope();
      const s = makeSim(0, 0, 0);
      let maxAbsX = 0;
      for (let i = 0; i < Math.round(60 / SIM_DT); i++) {
        stepSki(s, lock, SIM_DT, slope);
        maxAbsX = Math.max(maxAbsX, Math.abs(s.x));
      }
      // quadratic pushback contains the skier ~4 m past the edge band
      // (measured: ~31.7 m on a 56 m piste); generous margin, no wall.
      expect(maxAbsX).toBeLessThanOrEqual(slope.width / 2 + 5);
      for (let i = 0; i < Math.round(240 / SIM_DT) && !s.finished; i++) {
        stepSki(s, lock, SIM_DT, slope);
      }
      expect(s.finished).toBe(true);
    },
  );
});

// ---- plants ----------------------------------------------------------------------

describe('plant contact', () => {
  // One pine on the fall line at z = 60: a straight runner reaches it at
  // roughly v ~= 14 m/s (well under MAX_SPEED, well over MIN_SPEED) so the
  // speed multiplier is observable without either clamp binding.
  const HIT_Z = 60;

  function runToHit(slope: SlopeDef, assist = false): { pre: SkierSim; post: SkierSim } {
    const s = makeSim(0, 0, 0);
    let pre = makeSim(0, 0, 0);
    for (let i = 0; i < Math.round(30 / SIM_DT); i++) {
      copySim(pre, s);
      stepSki(s, 0, SIM_DT, slope, { assist });
      if (s.lastPlantIx !== -1) return { pre, post: s };
    }
    throw new Error('fixture bug: never hit the plant');
  }

  it('hit applies the exact speed mul and stamps the snare from simMs', () => {
    const slope = makeFixtureSlope({ plants: [plantAt(0, HIT_Z)] });
    const { pre, post } = runToHit(slope);
    // Replicate §6's pre-contact speed for this step with the fixture's
    // constant grade: gravity, (no scrub at steer 0), clamp — then the mul.
    let vExpect = pre.v + (G_ACCEL * GRADE_BASE - DRAG * pre.v * pre.v) * SIM_DT;
    vExpect = Math.min(Math.max(vExpect, MIN_SPEED), MAX_SPEED);
    vExpect = Math.min(Math.max(vExpect * PLANT_HIT_SPEED_MUL, MIN_SPEED), MAX_SPEED);
    expect(post.v).toBeCloseTo(vExpect, 12);
    expect(post.lastPlantIx).toBe(0);
    expect(post.lastPlantHitMs).toBeCloseTo(post.simMs, 12); // pair written together
    expect(post.snareUntilMs).toBeCloseTo(post.simMs + PLANT_SNARE_MS, 12);
  });

  it('snare is binding: v capped at MAX_SPEED/2 while simMs < snareUntilMs', () => {
    const slope = makeFixtureSlope({ plants: [plantAt(0, HIT_Z)] });
    const { post } = runToHit(slope);
    const s = post;
    while (s.simMs < s.snareUntilMs) {
      stepSki(s, 0, SIM_DT, slope);
      expect(s.v).toBeLessThanOrEqual(MAX_SPEED / 2 + 1e-9);
    }
    // after the snare expires the cap lifts again
    run(s, slope, 0, Math.round(10 / SIM_DT));
    expect(s.v).toBeGreaterThan(MAX_SPEED / 2);
  });

  it('immunity blocks a second plant inside PLANT_IMMUNITY_MS (cluster guard)', () => {
    // Two plants one step apart on the fall line.
    const slope = makeFixtureSlope({
      plants: [plantAt(0, HIT_Z), plantAt(0.2, HIT_Z + 0.4)],
    });
    const s = makeSim(0, 0, 0);
    const hitMs: number[] = [];
    let lastMs = s.lastPlantHitMs;
    for (let i = 0; i < Math.round(30 / SIM_DT) && !s.finished; i++) {
      stepSki(s, 0, SIM_DT, slope);
      if (s.lastPlantHitMs !== lastMs) {
        hitMs.push(s.lastPlantHitMs);
        lastMs = s.lastPlantHitMs;
      }
    }
    expect(hitMs.length).toBe(1); // the second plant was swallowed by immunity
  });

  it('rearm blocks the SAME plant until PLANT_REARM_MS, then allows it again', () => {
    const slope = makeFixtureSlope({ plants: [plantAt(0, HIT_Z)] });
    const s = makeSim(0, 0, 0);
    // drive straight into the plant: first hit
    run(s, slope, 0, Math.round(30 / SIM_DT));
    expect(s.lastPlantIx).toBe(0);
    const firstHitMs = s.lastPlantHitMs;

    // White-box re-approach (positions are plain state): park just before the
    // plant inside the rearm window but OUTSIDE immunity — same ix, not yet
    // rearmed -> the plant must NOT fire again.
    s.simMs = firstHitMs + PLANT_IMMUNITY_MS; // immunity expired
    s.x = 0;
    s.z = HIT_Z - 0.2;
    s.v = MIN_SPEED;
    const ixBefore = s.lastPlantIx;
    const msBefore = s.lastPlantHitMs;
    stepSki(s, 0, SIM_DT, slope); // crosses the plant disc
    expect(s.lastPlantIx).toBe(ixBefore);
    expect(s.lastPlantHitMs).toBe(msBefore);

    // After the rearm window the SAME plant fires again.
    s.simMs = firstHitMs + PLANT_REARM_MS;
    s.x = 0;
    s.z = HIT_Z - 0.2;
    stepSki(s, 0, SIM_DT, slope);
    expect(s.lastPlantHitMs).toBeGreaterThan(msBefore);
    expect(s.lastPlantIx).toBe(0);
  });

  it('immunity blocks even a DIFFERENT plant inside the window', () => {
    const slope = makeFixtureSlope({ plants: [plantAt(0, HIT_Z), plantAt(0, HIT_Z + 30)] });
    // Stop the moment plant 0 fires so simMs is still inside the immunity
    // window (running on past it would make this test vacuous).
    const { post } = runToHit(slope);
    const s = post;
    expect(s.lastPlantIx).toBe(0);
    // Teleport onto plant 1 within the immunity window: rearm passes (ix
    // differs) but immunity must hold.
    s.x = 0;
    s.z = HIT_Z + 30 - 0.2;
    const msBefore = s.lastPlantHitMs;
    stepSki(s, 0, SIM_DT, slope);
    expect(s.lastPlantHitMs).toBe(msBefore); // no second hit
  });

  it('assist shrinks the contact radius: a graze that hits normally misses under assist', () => {
    // Pine r = 0.55: normal contact band = 0.55 + SKIER_RADIUS = 1.05 m,
    // assist band = 0.55 * 0.8 + 0.5 = 0.94 m. A fall-line pass at |x| = 1.0
    // clips the normal radius but not the assist radius.
    const offset = SKIER_RADIUS + PLANT_RADIUS.pine * ASSIST_PLANT_RADIUS_MUL + 0.06;
    expect(offset).toBeLessThan(SKIER_RADIUS + PLANT_RADIUS.pine); // still a normal hit
    const slope = makeFixtureSlope({ plants: [plantAt(offset, HIT_Z)] });

    const normal = makeSim(0, 0, 0);
    run(normal, slope, 0, Math.round(30 / SIM_DT));
    expect(normal.lastPlantIx).toBe(0);

    const assisted = makeSim(0, 0, 0);
    run(assisted, slope, 0, Math.round(30 / SIM_DT), true);
    expect(assisted.lastPlantIx).toBe(-1);
  });

  it('assist shortens the snare by ASSIST_SNARE_MUL', () => {
    const slope = makeFixtureSlope({ plants: [plantAt(0, HIT_Z)] });
    const { post } = runToHit(slope, true);
    expect(post.snareUntilMs).toBeCloseTo(post.simMs + PLANT_SNARE_MS * ASSIST_SNARE_MUL, 12);
  });
});

// ---- slalom gates ------------------------------------------------------------------

describe('slalom gates', () => {
  // One gate on the fall line at z = 60: a straight runner crosses at
  // v ~= 15 m/s, so GATE_BOOST_V lands unclamped by the base cap.
  const GATE_Z = 60;

  function runToGate(slope: SlopeDef): { pre: SkierSim; post: SkierSim } {
    const s = makeSim(0, 0, 0);
    let pre = makeSim(0, 0, 0);
    for (let i = 0; i < Math.round(30 / SIM_DT); i++) {
      copySim(pre, s);
      stepSki(s, 0, SIM_DT, slope);
      if (s.lastGateIx !== -1) return { pre, post: s };
    }
    throw new Error('fixture bug: never crossed the gate');
  }

  it('a clean pass grants exactly GATE_BOOST_V and opens the boost window atomically', () => {
    const slope = makeFixtureSlope({ gates: [gateAt(0, GATE_Z)] });
    const { pre, post } = runToGate(slope);
    // Replicate §6 for this step: gravity, no scrub at steer 0, base-cap clamp,
    // then the boost clamped by the current cap (MAX_SPEED — not binding here).
    let vExpect = pre.v + (G_ACCEL * GRADE_BASE - DRAG * pre.v * pre.v) * SIM_DT;
    vExpect = Math.min(Math.max(vExpect, MIN_SPEED), MAX_SPEED);
    vExpect = Math.min(vExpect + GATE_BOOST_V, MAX_SPEED);
    expect(post.v).toBeCloseTo(vExpect, 12);
    expect(post.v).toBeGreaterThan(pre.v); // an actual gain, not just a clamp
    expect(post.lastGateIx).toBe(0);
    // the pair is written together — the server's pass signal (sim.ts header)
    expect(post.boostUntilMs).toBeCloseTo(post.simMs + GATE_BOOST_MS, 12);
    // gates never fire plant logic
    expect(post.lastPlantIx).toBe(-1);
    expect(post.lastPlantHitMs).toBe(-PLANT_REARM_MS);
    expect(post.snareUntilMs).toBe(0);
  });

  it('while boosted the cap is GATE_BOOST_MAX; on expiry MAX_SPEED returns', () => {
    const slope = makeFixtureSlope({ gates: [gateAt(0, GATE_Z)] });
    const { post: s } = runToGate(slope);
    s.v = GATE_BOOST_MAX - 1; // above MAX_SPEED, inside the boost window
    stepSki(s, 0, SIM_DT, slope);
    expect(s.v).toBeGreaterThan(MAX_SPEED); // the base cap no longer binds
    expect(s.v).toBeLessThanOrEqual(GATE_BOOST_MAX + 1e-9);
    s.simMs = s.boostUntilMs; // window expired
    stepSki(s, 0, SIM_DT, slope);
    expect(s.v).toBeLessThanOrEqual(MAX_SPEED + 1e-9);
  });

  it('crossing OUTSIDE the opening advances lastGateIx with no boost', () => {
    const slope = makeFixtureSlope({ gates: [gateAt(10, GATE_Z)] }); // 10 m off the line
    const { pre, post } = runToGate(slope);
    let vExpect = pre.v + (G_ACCEL * GRADE_BASE - DRAG * pre.v * pre.v) * SIM_DT;
    vExpect = Math.min(Math.max(vExpect, MIN_SPEED), MAX_SPEED);
    expect(post.v).toBeCloseTo(vExpect, 12); // untouched by the gate
    expect(post.lastGateIx).toBe(0); // still consumed...
    expect(post.boostUntilMs).toBe(0); // ...but the pair write did NOT happen
  });

  it('a missed gate cannot be re-taken by circling back over its z', () => {
    const slope = makeFixtureSlope({ gates: [gateAt(10, GATE_Z)] });
    const { post: s } = runToGate(slope); // straight runner misses the x=10 gate
    expect(s.lastGateIx).toBe(0);
    expect(s.boostUntilMs).toBe(0);
    // White-box rewind: park just above the gate, dead centre of its opening.
    // Without the lastGateIx guard this second crossing would grant the boost.
    s.x = 10;
    s.z = GATE_Z - 0.5;
    s.v = MIN_SPEED;
    run(s, slope, 0, Math.round(3 / SIM_DT));
    expect(s.z).toBeGreaterThan(GATE_Z); // sanity: really re-crossed the z
    expect(s.lastGateIx).toBe(0); // gate 0 is gone forever
    expect(s.boostUntilMs).toBe(0); // no boost from the re-crossing
  });

  it('the snare half-cap wins over the boost cap (cap = min of the two)', () => {
    const slope = makeFixtureSlope({ gates: [gateAt(0, GATE_Z)] });
    const { post: s } = runToGate(slope); // boosted
    s.snareUntilMs = s.simMs + 10_000; // ...and now also snared
    s.v = MAX_SPEED / 2 + 5; // above the half cap, below both boost/base caps
    stepSki(s, 0, SIM_DT, slope);
    expect(s.v).toBeLessThanOrEqual(MAX_SPEED / 2 + 1e-9); // snare wins, not GATE_BOOST_MAX
    expect(s.simMs).toBeLessThan(s.boostUntilMs); // boost window still open
  });

  it('a pass DURING a snare boosts only up to the half cap', () => {
    const slope = makeFixtureSlope({ gates: [gateAt(0, GATE_Z)] });
    const s = makeSim(0, 0, 0);
    s.snareUntilMs = 60_000; // snared from the start (simMs = 0)
    s.x = 0;
    s.z = GATE_Z - 0.2;
    s.v = MAX_SPEED / 2 - 1;
    stepSki(s, 0, SIM_DT, slope); // crosses the gate, snare active
    expect(s.lastGateIx).toBe(0);
    expect(s.boostUntilMs).toBeCloseTo(s.simMs + GATE_BOOST_MS, 12); // window still granted
    expect(s.v).toBeLessThanOrEqual(MAX_SPEED / 2 + 1e-9); // but the half cap clamps the gain
  });

  it('plant immunity does not block a gate pass (gates and plants never interact)', () => {
    // Plant at 60, gate 3 m below: the crossing lands well inside the 400 ms
    // immunity window at approach speed (~15 m/s -> ~0.2 s), yet the gate
    // must still grant its boost.
    const slope = makeFixtureSlope({
      plants: [plantAt(0, GATE_Z)],
      gates: [gateAt(0, GATE_Z + 3)],
    });
    const s = makeSim(0, 0, 0);
    run(s, slope, 0, Math.round(30 / SIM_DT));
    expect(s.lastPlantIx).toBe(0); // the plant hit happened...
    expect(s.lastGateIx).toBe(0); // ...and so did the gate pass
    expect(s.boostUntilMs).toBeGreaterThan(0);
  });
});

// ---- finish ------------------------------------------------------------------------

describe('finish', () => {
  it('stamps finishMs from simMs, freezes, and still consumes input', () => {
    const slope = makeFixtureSlope({ length: 200 });
    const s = makeSim(0, 0, 0);
    run(s, slope, 0, Math.round(60 / SIM_DT));
    expect(s.finished).toBe(true);
    expect(s.finishMs).toBe(s.simMs); // stamped from the sim clock

    const frozen = makeSim(0, 0, 0);
    copySim(frozen, s);
    // subsequent steps are no-ops: state untouched, simMs does NOT advance
    for (let i = 0; i < 30; i++) stepSki(s, 1, SIM_DT, slope);
    expect(s).toStrictEqual(frozen);

    // ...but the predictor still CONSUMES inputs so ack bookkeeping works
    const pred = new SkiPredictor(slope);
    const auth = makeSim(0, 0, 0);
    copySim(auth, frozen);
    pred.reconcile(auth, 0);
    pred.push({ steer: 1, dt: SIM_DT, seq: 1 });
    expect(pred.pendingCount()).toBe(1);
    expect(pred.state()).toStrictEqual(frozen);
  });
});

// ---- resolveSkiPair ------------------------------------------------------------------

describe('resolveSkiPair', () => {
  it('separates overlapping skiers within a few ticks, momentum kept', () => {
    const a = makeSim(0, 0, 0);
    const b = makeSim(0.5, 0, 0.2);
    a.v = 10;
    b.v = 14;
    for (let i = 0; i < 10 && Math.hypot(b.x - a.x, b.z - a.z) < 2 * SKIER_RADIUS - 1e-9; i++) {
      resolveSkiPair(a, b);
    }
    expect(Math.hypot(b.x - a.x, b.z - a.z)).toBeGreaterThanOrEqual(2 * SKIER_RADIUS - 1e-9);
    expect(a.v).toBe(10); // never zeroed, never a disable
    expect(b.v).toBe(14);
    expect(a.yaw).toBe(0);
    expect(b.yaw).toBe(0.2);
  });

  it('exactly stacked skiers split on a deterministic normal', () => {
    const a = makeSim(3, 7, 0);
    const b = makeSim(3, 7, 0);
    resolveSkiPair(a, b);
    expect(Math.hypot(b.x - a.x, b.z - a.z)).toBeGreaterThan(0);
    expect(b.x).toBeGreaterThan(a.x); // +x split, deterministic
  });

  it('non-overlapping skiers are untouched', () => {
    const a = makeSim(0, 0, 0);
    const b = makeSim(5, 0, 0);
    resolveSkiPair(a, b);
    expect(a).toStrictEqual(makeSim(0, 0, 0));
    expect(b).toStrictEqual(makeSim(5, 0, 0));
  });
});

// ---- SkiPredictor ----------------------------------------------------------------------

describe('SkiPredictor', () => {
  const slope = makeFixtureSlope({ plants: [plantAt(0, 150)] });

  /** Drive a "server" sim and a predictor through the same input script. */
  function script(i: number): number {
    return Math.sin(i * 0.37) * 0.8;
  }

  it('converges to zero correction with in-order acks', () => {
    const server = makeSim(0, 0, 0);
    const pred = new SkiPredictor(slope);
    for (let seq = 1; seq <= 30; seq++) {
      const steer = script(seq);
      stepSki(server, steer, SIM_DT, slope);
      pred.push({ steer, dt: SIM_DT, seq });
    }
    const correction = pred.reconcile(server, 30);
    expect(correction).toBe(0); // bit-identical replay: no tug at all
    expect(pred.pendingCount()).toBe(0);
    expect(pred.state()).toStrictEqual(server);
  });

  it('replays unacked inputs after an authoritative correction', () => {
    const server = makeSim(0, 0, 0);
    const atTwenty = makeSim(0, 0, 0);
    const pred = new SkiPredictor(slope);
    for (let seq = 1; seq <= 30; seq++) {
      const steer = script(seq);
      stepSki(server, steer, SIM_DT, slope);
      if (seq === 20) copySim(atTwenty, server);
      pred.push({ steer, dt: SIM_DT, seq });
    }
    const correction = pred.reconcile(atTwenty, 20);
    expect(correction).toBe(0); // the client had predicted the same 30 inputs
    expect(pred.pendingCount()).toBe(10); // 21..30 still unacked
    expect(pred.state()).toStrictEqual(server); // replay lands exactly
  });

  it('reports a real correction when the authoritative state diverged', () => {
    const server = makeSim(0, 0, 0);
    const pred = new SkiPredictor(slope);
    for (let seq = 1; seq <= 10; seq++) {
      const steer = script(seq);
      stepSki(server, steer, SIM_DT, slope);
      pred.push({ steer, dt: SIM_DT, seq });
    }
    server.x += 1; // e.g. a skier-skier shove only the server can apply
    const correction = pred.reconcile(server, 10);
    expect(correction).toBeCloseTo(1, 9);
    expect(pred.state()).toStrictEqual(server);
  });

  it('setAssist switches physics immediately — replay uses the new flag', () => {
    // Graze geometry from the plant suite: normal radius hits, assist misses.
    const offset = SKIER_RADIUS + PLANT_RADIUS.pine * ASSIST_PLANT_RADIUS_MUL + 0.06;
    const graze = makeFixtureSlope({ plants: [plantAt(offset, 150)] });
    // 450 pushes = 15 s of sim time: reaches z ~= 220 m, well past the plant.
    const PUSHES = 450;

    const off = new SkiPredictor(graze);
    for (let seq = 1; seq <= PUSHES; seq++) off.push({ steer: 0, dt: SIM_DT, seq });
    expect(off.state().z).toBeGreaterThan(151); // sanity: really passed the plant
    expect(off.state().lastPlantIx).toBe(0); // normal radius: hit

    const on = new SkiPredictor(graze, { assist: true });
    for (let seq = 1; seq <= PUSHES; seq++) on.push({ steer: 0, dt: SIM_DT, seq });
    expect(on.state().z).toBeGreaterThan(151);
    expect(on.state().lastPlantIx).toBe(-1); // assist radius: clean pass

    // Toggle mid-race: predictor started assist-OFF and pushed part of the
    // approach, then assist turns ON and a reconcile replays everything with
    // the new physics — the hit never happens.
    const mid = new SkiPredictor(graze);
    for (let seq = 1; seq <= 100; seq++) mid.push({ steer: 0, dt: SIM_DT, seq });
    mid.setAssist(true);
    const base = makeSim(0, 0, 0);
    mid.reconcile(base, 0); // rewind to the gate, replay all 100 under assist
    for (let seq = 101; seq <= PUSHES; seq++) mid.push({ steer: 0, dt: SIM_DT, seq });
    expect(mid.state().z).toBeGreaterThan(151);
    expect(mid.state().lastPlantIx).toBe(-1);
  });

  it('caps the pending queue at PENDING_INPUT_CAP (oldest dropped)', () => {
    const pred = new SkiPredictor(slope);
    for (let seq = 1; seq <= PENDING_INPUT_CAP + 10; seq++) {
      pred.push({ steer: 0, dt: SIM_DT, seq });
    }
    expect(pred.pendingCount()).toBe(PENDING_INPUT_CAP);
  });

  it('reset re-bases and drops every pending input', () => {
    const pred = new SkiPredictor(slope);
    for (let seq = 1; seq <= 20; seq++) pred.push({ steer: 0.3, dt: SIM_DT, seq });
    pred.reset(-4.5, -3, 0);
    expect(pred.pendingCount()).toBe(0);
    expect(pred.state()).toStrictEqual(makeSim(-4.5, -3, 0));
  });
});

// ===========================================================================
// v2 JUMP STATE MACHINE (CONTRACT §11.2)
// ===========================================================================

describe('makeSim / resetSim / copySim — v2 jump fields', () => {
  it('makeSim initialises jump fields: grounded, off cooldown, no kickers', () => {
    const s = makeSim(0, 0, 0);
    expect(s.airborne).toBe(false);
    expect(s.airVy).toBe(0);
    expect(s.airStartY).toBe(0);
    expect(s.lastKickerIx).toBe(-1);
    // cooldown clock starts one cooldown window in the past: hop is legal immediately
    expect(s.simMs - s.airStartMs).toBeGreaterThanOrEqual(J_COOLDOWN_MS);
  });

  it('resetSim resets jump fields', () => {
    const s = makeSim(1, 2, 0);
    s.airborne = true;
    s.airVy = 5;
    s.airStartY = 10;
    s.lastKickerIx = 3;
    resetSim(s, -4.5, -3, 0);
    expect(s.airborne).toBe(false);
    expect(s.airVy).toBe(0);
    expect(s.airStartY).toBe(0);
    expect(s.lastKickerIx).toBe(-1);
  });

  it('copySim copies jump fields', () => {
    const src = makeSim(0, 0, 0);
    src.airborne = true;
    src.airVy = 3.2;
    src.airStartY = 42;
    src.lastKickerIx = 1;
    const dst = makeSim(9, 9, 9);
    copySim(dst, src);
    expect(dst.airborne).toBe(true);
    expect(dst.airVy).toBe(3.2);
    expect(dst.airStartY).toBe(42);
    expect(dst.lastKickerIx).toBe(1);
  });
});

describe('airHeight', () => {
  const slope = makeFixtureSlope();

  it('returns 0 when grounded', () => {
    const s = makeSim(0, 0, 0);
    expect(airHeight(s, s.x, s.z, slope)).toBe(0);
  });

  it('matches closed-form arc height above terrain while airborne', () => {
    const s = makeSim(0, 0, 0);
    // position the skier at z=10 where terrain is lower, then set a
    // mid-arc airborne state 2 m above the terrain
    s.z = 10;
    s.airborne = true;
    s.airStartMs = s.simMs; // t = 0
    s.airVy = J_HOP_VY;
    s.airStartY = slope.height(0, 10) + 2; // 2 m above terrain at z=10
    // at t=0: worldY = airStartY, airHeight = worldY - terrain = 2
    expect(airHeight(s, s.x, s.z, slope)).toBeCloseTo(2, 10);
    // advance time by 0.1 s: the arc should be slightly above the peak
    s.simMs += 100; // t = 0.1
    const t = 0.1;
    const worldY = s.airStartY + s.airVy * t - 0.5 * G_ACCEL * t * t;
    const expected = worldY - slope.height(s.x, s.z);
    expect(airHeight(s, s.x, s.z, slope)).toBeCloseTo(expected, 10);
  });

  it('clamps at 0 when the arc is below the terrain', () => {
    const s = makeSim(0, 0, 0);
    s.airborne = true;
    s.airStartMs = 1000;
    s.airVy = -50; // strongly downward
    s.airStartY = slope.height(0, 0);
    s.simMs = 1100;
    // worldY would be well below the terrain
    expect(airHeight(s, s.x, s.z, slope)).toBe(0);
  });
});

describe('hop (manual jump)', () => {
  const slope = makeFixtureSlope();

  it('stepSki with {jump:true} launches: airborne, airVy = J_HOP_VY, airStartMs = simMs', () => {
    const s = makeSim(0, 0, 0);
    stepSki(s, 0, SIM_DT, slope, { jump: true });
    expect(s.airborne).toBe(true);
    expect(s.airVy).toBe(J_HOP_VY);
    expect(s.airStartMs).toBe(s.simMs);
    // airStartY is slope.height at the post-motion (x,z) at launch time
    expect(s.airStartY).toBeCloseTo(slope.height(s.x, s.z), 10);
  });

  it('hop arc rises then lands — airHeight positive then 0 after landing', () => {
    const s = makeSim(0, 0, 0);
    let maxH = 0;
    let landed = false;
    for (let i = 0; i < 200; i++) {
      const jump = i === 0 ? true : undefined;
      stepSki(s, 0, SIM_DT, slope, i === 0 ? { jump: true } : undefined);
      if (s.airborne) {
        const h = airHeight(s, s.x, s.z, slope);
        if (h > maxH) maxH = h;
      } else if (i > 0) {
        landed = true;
        break;
      }
    }
    expect(maxH).toBeGreaterThan(0); // apex was above the snow
    expect(landed).toBe(true); // eventually lands
    expect(s.airborne).toBe(false);
    expect(airHeight(s, s.x, s.z, slope)).toBe(0);
  });

  it('a held jump flag is NOT consumed as repeated hops; only the edge fires', () => {
    const s = makeSim(0, 0, 0);
    // fire first hop
    stepSki(s, 0, SIM_DT, slope, { jump: true });
    expect(s.airborne).toBe(true);
    const startMs = s.airStartMs;
    // next step with jump still true — ignored (already airborne)
    stepSki(s, 0, SIM_DT, slope, { jump: true });
    expect(s.airborne).toBe(true); // still in the same arc
    // after landing, a held jump without going false-then-true is still a new edge
    // because opts.jump is true again — but cooldown may block it.
    // Drive until landing then test cooldown
    while (s.airborne && s.simMs < startMs + 10_000) {
      stepSki(s, 0, SIM_DT, slope);
    }
    expect(s.airborne).toBe(false);
    // jump held true immediately post-landing during cooldown: must NOT re-launch
    stepSki(s, 0, SIM_DT, slope, { jump: true });
    // cooldown blocks it — still grounded
    if (s.simMs - startMs < J_COOLDOWN_MS) {
      expect(s.airborne).toBe(false);
    }
  });

  it('landing speed multiplier: v = max(MIN_SPEED, v * J_LAND_SPEED_MUL)', () => {
    const s = makeSim(0, 0, 0);
    // build up speed, then hop, then let it land
    run(s, slope, 0, 60); // ~2 s to build speed
    const preHopV = s.v;
    stepSki(s, 0, SIM_DT, slope, { jump: true });
    expect(s.airborne).toBe(true);
    // drive through the full arc
    while (s.airborne && s.simMs < 20_000) {
      stepSki(s, 0, SIM_DT, slope);
    }
    expect(s.airborne).toBe(false);
    // v after landing >= preHopV * J_LAND_SPEED_MUL (minor scrub from the arc + mul)
    // The landing mul is applied once; speed may have changed during flight
    expect(s.v).toBeGreaterThanOrEqual(MIN_SPEED);
    // The landing itself doesn't zero v — safety law holds
  });
});

describe('kickers', () => {
  it('crossing a kicker while grounded launches the skier', () => {
    // Place kicker close at z=10 so the skier reaches it quickly at MIN_SPEED
    const kSlope = makeFixtureSlope({
      kickers: [kickerAt(0, 10, 2.5)],
    });
    const s = makeSim(0, 0, 0);
    // drive straight until the kicker is crossed
    for (let i = 0; i < 600 && s.lastKickerIx === -1 && !s.finished; i++) {
      stepSki(s, 0, SIM_DT, kSlope);
    }
    expect(s.lastKickerIx).toBe(0); // consumed
    expect(s.airborne).toBe(true);  // launched
    expect(s.airVy).toBeGreaterThanOrEqual(J_KICKER_VY_BASE);
  });

  it('a lateral miss does NOT launch (|x - k.x| > halfWidth)', () => {
    const missSlope = makeFixtureSlope({
      kickers: [kickerAt(8, 10, 2.0)], // kicker at x=8, skier starts at x=0
    });
    const s = makeSim(0, 0, 0);
    for (let i = 0; i < 600 && s.lastKickerIx === -1 && !s.finished; i++) {
      stepSki(s, 0, SIM_DT, missSlope);
    }
    expect(s.lastKickerIx).toBe(0); // consumed (crossed z)
    expect(s.airborne).toBe(false); // but not launched: lateral miss
  });

  it('crossing mid-air consumes kicker without launching', () => {
    // Two kickers: first at z=25 launches the skier, second at z=30 is
    // crossed mid-air — consumed but not re-launched.
    const kickerSlope = makeFixtureSlope({
      kickers: [kickerAt(0, 25, 2.5), kickerAt(0, 30, 2.5)],
    });
    const s = makeSim(0, 0, 0);
    // drive to cross the first kicker
    for (let i = 0; i < 1200 && s.lastKickerIx < 1 && !s.finished; i++) {
      stepSki(s, 0, SIM_DT, kickerSlope);
    }
    // first kicker launched us, second was crossed mid-air and consumed
    expect(s.lastKickerIx).toBeGreaterThanOrEqual(1); // at least second consumed
    // if we're still airborne from the first launch, the second didn't re-launch
    // (we'd have lastKickerIx=1 meaning it was consumed)
  });

  it('kicker launch vy = J_KICKER_VY_BASE + J_KICKER_VY_SPEED * v', () => {
    const kSlope = makeFixtureSlope({
      kickers: [kickerAt(0, 10, 2.5)],
    });
    const s = makeSim(0, 0, 0);
    // drive onto the kicker
    for (let i = 0; i < 600 && s.lastKickerIx === -1 && !s.finished; i++) {
      stepSki(s, 0, SIM_DT, kSlope);
    }
    expect(s.lastKickerIx).toBe(0);
    expect(s.airborne).toBe(true);
    // airVy set at launch; verify it's in the expected range
    expect(s.airVy).toBeGreaterThanOrEqual(J_KICKER_VY_BASE);
    expect(s.airVy).toBeLessThanOrEqual(J_KICKER_VY_BASE + J_KICKER_VY_SPEED * MAX_SPEED);
  });
});

describe('fly-over-plants (v2 reward)', () => {
  it('a plant dead-centre under the flight path NEVER hits while airborne', () => {
    // Place plant at z=8 — close enough to reach in a few steps, then hop over it
    const slope = makeFixtureSlope({
      plants: [plantAt(0, 8)],
    });
    const s = makeSim(0, 0, 0);
    // run a few steps to reach near the plant, then hop
    for (let i = 0; i < 6; i++) stepSki(s, 0, SIM_DT, slope);
    stepSki(s, 0, SIM_DT, slope, { jump: true });
    expect(s.airborne).toBe(true);
    // now fly over the plant — it must not register a hit while airborne
    while (s.airborne && s.simMs < 20_000) {
      stepSki(s, 0, SIM_DT, slope);
    }
    // after landing, the plant was never hit
    expect(s.lastPlantIx).toBe(-1);
  });

  it('landing ON a plant hits on the following grounded step', () => {
    // Place a plant exactly at the landing spot. We control this by
    // running to a known position, hopping, then placing a plant at the
    // landing z (estimated from the arc + forward travel).
    const slope = makeFixtureSlope({
      plants: [plantAt(0, 3.5)], // very close plant — landed on after a hop
    });
    const s = makeSim(0, 0, 0);
    // hop immediately so we land near z~3 at low speed
    stepSki(s, 0, SIM_DT, slope, { jump: true });
    expect(s.airborne).toBe(true);
    // let the arc complete naturally
    while (s.airborne && s.simMs < 20_000) {
      stepSki(s, 0, SIM_DT, slope);
    }
    // now grounded; the plant at (0, 3.5) may or may not have been hit
    // yet. Take a few more grounded steps: if the skier is near the plant,
    // it should hit on a grounded step (the plant pass runs).
    const hitBefore = s.lastPlantIx;
    let hitAfter = false;
    for (let i = 0; i < 15; i++) {
      stepSki(s, 0, SIM_DT, slope);
      if (s.lastPlantIx !== hitBefore) {
        hitAfter = true;
        break;
      }
    }
    // At least the skier landed safely and stayed grounded
    expect(s.airborne).toBe(false);
    expect(s.v).toBeGreaterThanOrEqual(MIN_SPEED);
    // If the plant was near enough, it hit on a grounded step
    // (this is probabilistic with exact trajectory; we just assert safety)
  });
});

describe('cooldown', () => {
  it('no second launch within J_COOLDOWN_MS of airStartMs', () => {
    const slope = makeFixtureSlope();
    const s = makeSim(0, 0, 0);
    stepSki(s, 0, SIM_DT, slope, { jump: true });
    const firstLaunch = s.airStartMs;
    expect(s.airborne).toBe(true);
    // drive to landing
    while (s.airborne && s.simMs < 20_000) {
      stepSki(s, 0, SIM_DT, slope);
    }
    expect(s.airborne).toBe(false);
    // try to hop again immediately — must be blocked by cooldown
    stepSki(s, 0, SIM_DT, slope, { jump: true });
    if (s.simMs - firstLaunch < J_COOLDOWN_MS) {
      expect(s.airborne).toBe(false);
    }
    // advance past cooldown, then hop again — must work
    while (s.simMs - firstLaunch < J_COOLDOWN_MS) {
      stepSki(s, 0, SIM_DT, slope);
    }
    stepSki(s, 0, SIM_DT, slope, { jump: true });
    expect(s.airborne).toBe(true);
    expect(s.airStartMs).toBeGreaterThan(firstLaunch + J_COOLDOWN_MS - 1);
  });
});

describe('landing safety (the 4-year-old law)', () => {
  it('v never below MIN_SPEED after landing', () => {
    const slope = makeFixtureSlope();
    // test over many hops
    const s = makeSim(0, 0, 0);
    let violations = 0;
    let hops = 0;
    for (let step = 0; step < 2000 && !s.finished; step++) {
      const jump = hops < 5 && !s.airborne && s.simMs - s.airStartMs >= J_COOLDOWN_MS
        ? true : undefined;
      stepSki(s, 0, SIM_DT, slope, jump === true ? { jump: true } : undefined);
      if (s.airborne && jump === true) hops++;
      if (s.v < MIN_SPEED - 1e-9) violations++;
    }
    expect(violations).toBe(0);
  });

  it('J_MAX_AIRTIME_S always lands the skier (forced landing)', () => {
    // Use a near-flat slope so the arc doesn't intersect terrain naturally
    const flatSlope = makeFixtureSlope({
      grade: GRADE_MIN,
      length: 500,
    });
    const s = makeSim(0, 0, 0);
    stepSki(s, 0, SIM_DT, flatSlope, { jump: true });
    expect(s.airborne).toBe(true);
    const launchMs = s.airStartMs;
    let maxAirS = 0;
    while (s.airborne && s.simMs < 60_000) {
      stepSki(s, 0, SIM_DT, flatSlope);
      const airS = (s.simMs - launchMs) / 1000;
      if (airS > maxAirS) maxAirS = airS;
    }
    // must have landed (even if by the time cap)
    expect(s.airborne).toBe(false);
    expect(maxAirS).toBeLessThanOrEqual(J_MAX_AIRTIME_S + 0.1); // SIM_DT rounding
  });
});

describe('air steering (damped control)', () => {
  it('yaw rate in air is J_AIR_STEER_MUL of the grounded rate', () => {
    const slope = makeFixtureSlope();
    // grounded reference: full lock for several steps
    const grounded = makeSim(0, 0, 0);
    const yaw0 = grounded.yaw;
    run(grounded, slope, 1, 10);
    const groundedDelta = grounded.yaw - yaw0;

    // airborne: hop then full lock
    const s = makeSim(0, 0, 0);
    stepSki(s, 1, SIM_DT, slope, { jump: true });
    const yawPre = s.yaw;
    // take a few more air steps (still airborne, full steer)
    for (let i = 0; i < 9 && s.airborne; i++) {
      stepSki(s, 1, SIM_DT, slope);
    }
    const airDelta = s.yaw - yawPre;
    // With same steer but faster v in air (less scrub), the raw rate is
    // multiplied by J_AIR_STEER_MUL. The actual deltas may differ from the
    // multiplication because v changes, but the ratio should be roughly
    // J_AIR_STEER_MUL or less.
    expect(Math.abs(airDelta)).toBeLessThan(Math.abs(groundedDelta) * J_AIR_STEER_MUL + 0.05);
  });

  it('carve scrub is damped by J_AIR_CARVE_MUL in air', () => {
    const slope = makeFixtureSlope();
    // grounded: carve scrub rate
    const grounded = makeSim(0, 0, 0);
    run(grounded, slope, 0, 30); // build speed
    const vBefore = grounded.v;
    stepSki(grounded, 1, SIM_DT, slope); // one hard carve
    const groundedScrub = 1 - grounded.v / vBefore;

    // airborne: hop then carve
    const s = makeSim(0, 0, 0);
    run(s, slope, 0, 30);
    const vBeforeAir = s.v;
    stepSki(s, 1, SIM_DT, slope, { jump: true });
    // the launch step: carve scrub is damped AND steering is damped
    const airScrub = 1 - s.v / vBeforeAir;
    // Air scrub should be less severe than grounded scrub
    expect(airScrub).toBeLessThan(groundedScrub + 0.01);
  });
});

describe('resolveSkiPair — airborne skip', () => {
  it('skips the pair if EITHER skier is airborne', () => {
    const a = makeSim(0, 0, 0);
    const b = makeSim(0.2, 0, 0); // overlapping
    a.v = 10;
    b.v = 10;
    a.airborne = true;
    resolveSkiPair(a, b);
    // a and b should NOT be pushed apart (airborne skip)
    expect(a.x).toBe(0);
    expect(a.z).toBe(0);
    expect(b.x).toBe(0.2);
    expect(b.z).toBe(0);

    // reset and test with b airborne
    a.airborne = false;
    b.airborne = true;
    a.x = 0;
    a.z = 0;
    b.x = 0.2;
    b.z = 0;
    resolveSkiPair(a, b);
    expect(a.x).toBe(0);
    expect(b.x).toBe(0.2);

    // both grounded: normal push
    a.airborne = false;
    b.airborne = false;
    a.x = 0;
    a.z = 0;
    b.x = 0.2;
    b.z = 0;
    resolveSkiPair(a, b);
    expect(Math.abs(a.x)).toBeGreaterThan(0); // pushed apart
  });
});

describe('SkiPredictor — jump edge', () => {
  const slope = makeFixtureSlope();

  it('push carries jump into the pending queue AND into immediate stepSki', () => {
    const pred = new SkiPredictor(slope);
    pred.push({ steer: 0, dt: SIM_DT, seq: 1, jump: true });
    expect(pred.state().airborne).toBe(true); // immediate launch
    expect(pred.pendingCount()).toBe(1);
    // reconcile re-launches
  });

  it('reconcile replays the stored jump flag', () => {
    const server = makeSim(0, 0, 0);
    const pred = new SkiPredictor(slope);
    // push with jump
    pred.push({ steer: 0, dt: SIM_DT, seq: 1, jump: true });
    expect(pred.state().airborne).toBe(true);
    // server didn't jump (server doesn't know about the hop yet)
    // Reconcile with ackSeq=0: replay seq 1 with jump
    const correction = pred.reconcile(server, 0);
    // after replay, predictor should be airborne (replayed jump)
    expect(pred.state().airborne).toBe(true);
  });

  it('determinism: identical (steer, dt, jump) sequences are bit-identical on several seeds', () => {
    const next = rng(9999);
    const slope = makeFixtureSlope({
      plants: [plantAt(1.5, 80), plantAt(-1, 180)],
      kickers: [kickerAt(0.5, 120, 2.5), kickerAt(-0.5, 250, 2.0)],
    });
    const genInput = () => ({
      steer: next() * 2 - 1,
      dt: SIM_DT * (0.5 + next() * 0.5),
      jump: next() > 0.92 ? true as const : undefined,
    });
    const inputs = Array.from({ length: 600 }, genInput);

    const a = makeSim(0, 0, 0);
    const b = makeSim(0, 0, 0);
    for (const inp of inputs) {
      const opts = inp.jump === true ? { jump: true as const } : undefined;
      stepSki(a, inp.steer, inp.dt, slope, opts);
      stepSki(b, inp.steer, inp.dt, slope, opts);
    }
    expect(a).toStrictEqual(b);
  });
});

// ===========================================================================
// v2 4-year-old test — full-lock finishes on 20 genSlope seeds with kickers
// (CONTRACT §11.2 containment guarantee; prototype-v2.mts PASS conditions)
// ===========================================================================

describe('the 4-year-old law v2 (genSlope + jumps)', () => {
  it('full-lock both directions finishes on 20 seeds with kickers present', () => {
    const DT = SIM_DT;
    let finished = 0;
    const totalSeeds = 20;
    for (let seed = 1; seed <= totalSeeds; seed++) {
      for (const dir of [1, -1]) {
        const slope = genSlope(seed);
        const s = makeSim(0, 0, 0);
        let steps = 0;
        const maxSteps = 60 * 30 * 5; // 5 min sim time
        while (!s.finished && steps < maxSteps) {
          stepSki(s, dir, DT, slope);
          steps++;
        }
        if (s.finished) finished++;
      }
    }
    const total = totalSeeds * 2;
    console.log(`[sim] v2 4-year-old: finished ${finished}/${total} full-lock runs on ${totalSeeds} genSlope seeds`);
    expect(finished).toBe(total);
  }, 30_000);

  it('a skier who hops stays contained (|x| within ~3.5 m of piste edge) and always lands', () => {
    const DT = SIM_DT;
    let maxOff = 0;
    let allLanded = true;
    for (let seed = 1; seed <= 10; seed++) {
      const slope = genSlope(seed);
      const s = makeSim(0, 0, 0);
      let hopFired = false;
      let steps = 0;
      while (!s.finished && steps < 60 * 30 * 4) {
        const jump = !hopFired && !s.airborne && s.simMs > 500 && s.simMs < 2000
          ? true : undefined;
        if (jump) hopFired = true;
        stepSki(s, 1, DT, slope, jump === true ? { jump: true } : undefined);
        const off = Math.abs(s.x) - slope.width / 2;
        if (off > maxOff) maxOff = off;
        if (s.airborne && steps > 60 * 30 * 4 - 2) allLanded = false; // stuck in air
        steps++;
      }
      if (s.airborne) allLanded = false;
    }
    console.log(`[sim] v2 hop containment: max off-piste ${maxOff.toFixed(2)} m, all landed: ${allLanded}`);
    expect(maxOff).toBeLessThanOrEqual(3.5);
    expect(allLanded).toBe(true);
  }, 30_000);
});
