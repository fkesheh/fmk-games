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
  G_ACCEL,
  GRADE_BASE,
  GRADE_MIN,
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
  copySim,
  makeSim,
  resetSim,
  resolveSkiPair,
  SkiPredictor,
  stepSki,
} from './sim.js';
import type { Plant, SkierSim, SlopeDef } from './types.js';

// ---- fixtures ---------------------------------------------------------------

interface FixtureOpts {
  readonly grade?: number | ((x: number, z: number, heading: number) => number);
  readonly width?: number;
  readonly length?: number;
  readonly plants?: readonly Plant[];
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
    const slope = makeFixtureSlope({ plants: [plantAt(0.4, 60), plantAt(-1, 220)] });
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
    const vt = Math.sqrt((G_ACCEL * GRADE_BASE) / DRAG); // analytic v* = 18.5 m/s
    const s = makeSim(0, 0, 0);
    let maxV = 0;
    for (let i = 0; i < Math.round(60 / SIM_DT); i++) {
      stepSki(s, 0, SIM_DT, slope);
      maxV = Math.max(maxV, s.v);
    }
    expect(maxV).toBeLessThanOrEqual(vt + 1e-9); // explicit Euler never overshoots v*
    expect(s.v).toBeGreaterThan(vt * 0.99); // ...and converges onto it
    expect(s.v).toBeLessThanOrEqual(MAX_SPEED);
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
  it.each([1, -1])('full lock %i for 60 s: yaw bounded, z never decreases, then finishes', (lock) => {
    const slope = makeFixtureSlope(); // 800 m, width 56, no plants
    const s = makeSim(0, 0, 0);
    let maxAbsYaw = 0;
    let prevZ = s.z;
    for (let i = 0; i < Math.round(60 / SIM_DT); i++) {
      stepSki(s, lock, SIM_DT, slope);
      maxAbsYaw = Math.max(maxAbsYaw, Math.abs(s.yaw));
      expect(s.z).toBeGreaterThanOrEqual(prevZ - 1e-9); // always descending
      prevZ = s.z;
    }
    expect(maxAbsYaw).toBeLessThan(YAW_MAX + 0.25); // spring-bounded, no spin-out
    // keep holding the lock: the skier spirals back and finishes the 800 m
    for (let i = 0; i < Math.round(240 / SIM_DT) && !s.finished; i++) {
      stepSki(s, lock, SIM_DT, slope);
    }
    expect(s.finished).toBe(true);
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
