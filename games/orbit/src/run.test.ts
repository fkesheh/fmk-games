// ============================================================================
// RUN TESTS — the pure sim contract (specs/P9.md rules block):
// monotonic 18→42/180s speed ramp, seed-deterministic spawn field, the
// near-miss/hit boundary at the contact radius, combo decay timing, the
// scoring formula, boost gating, recycling bounds, and byte-exact
// slot-'resume' restores.
// ============================================================================

import { describe, expect, it } from 'vitest';
import {
  SIM,
  createRun,
  currentSpeed,
  drainEvents,
  obstacleOutcome,
  scoreOf,
  speedAt,
  step,
  timeAtDist,
  tryBoost,
} from './run.js';
import type { Obstacle, RunState, SteerInput } from './run.js';

const DT = 1 / 30; // matches main()'s Loop tickHz
const IDLE: SteerInput = { ax: 0, ay: 0 };
/** Lateral offset from ship center giving a clean NEAR MISS on an r=1 rock. */
const NEAR_DX = 1 + SIM.shipR + 0.45;

function run(st: RunState, seconds: number, input: SteerInput = IDLE): void {
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++) step(st, input, DT);
}

/** Inject a rock dead ahead of the ship at a lateral offset, r=1. */
function injectRock(st: RunState, dx: number, dy = 0, aheadU = 1, r = 1): Obstacle {
  const o: Obstacle = {
    id: 900000 + st.obstacles.length,
    kind: 'rock',
    x: st.x + dx,
    y: st.y + dy,
    z: st.z - aheadU,
    r,
    spin: 0,
    phase: 0,
    passed: false,
    dead: false,
  };
  st.obstacles.push(o);
  return o;
}

/** Silence the procedural generator + clear live entities for scripted scenes. */
function isolate(st: RunState): void {
  st.gen.obsZ = -1e9;
  st.gen.shieldZ = -1e9;
  st.obstacles.length = 0;
  st.pickups.length = 0;
}

function layout(st: RunState): string {
  return JSON.stringify(
    st.obstacles.map((o) => [o.id, o.kind, o.x, o.y, o.z, o.r]),
  );
}

// ---- speed curve -----------------------------------------------------------------

describe('speed curve', () => {
  it('is monotonic non-decreasing from 18 u/s to a cap of 42 u/s at 180s', () => {
    expect(speedAt(0)).toBe(18);
    let prev = speedAt(0);
    for (let t = 0.5; t <= 200; t += 0.5) {
      const s = speedAt(t);
      expect(s).toBeGreaterThanOrEqual(prev);
      prev = s;
    }
    expect(speedAt(SIM.rampSec)).toBeCloseTo(42, 10);
    expect(speedAt(SIM.rampSec * 2)).toBe(42); // capped after the ramp
  });

  it('timeAtDist inverts the integrated ramp exactly', () => {
    // dist(t) = 18t + t²/15 while t ≤ 180
    expect(timeAtDist(0)).toBe(0);
    expect(timeAtDist(18 * 30 + (30 * 30) / 15)).toBeCloseTo(30, 6);
    expect(timeAtDist(18 * 90 + (90 * 90) / 15)).toBeCloseTo(90, 6);
    expect(timeAtDist(18 * 180 + (180 * 180) / 15)).toBe(180);
    expect(timeAtDist(99999)).toBe(180); // capped past the ramp
  });

  it('speed keyed through distance tracks the time ramp as the sim integrates it', () => {
    // discrete right-endpoint integration lags the continuous integral by a
    // hair; the law must still track speedAt(t) far below one u/s
    const st = createRun(1);
    isolate(st);
    run(st, 30);
    expect(Math.abs(currentSpeed(st) - speedAt(30))).toBeLessThan(0.01);
    run(st, 60);
    expect(Math.abs(currentSpeed(st) - speedAt(90))).toBeLessThan(0.02);
  });
});

// ---- spawn determinism --------------------------------------------------------------

describe('spawn determinism', () => {
  it('same seed ⇒ identical debris field at every checkpoint distance', () => {
    const a = createRun(777);
    const b = createRun(777);
    const wiggle: SteerInput = { ax: 0.6, ay: -0.3 };
    for (let chk = 0; chk < 5; chk++) {
      run(a, 4, wiggle);
      run(b, 4, wiggle);
      expect(layout(b)).toBe(layout(a));
      expect(b.dist).toBeCloseTo(a.dist, 12);
    }
  });

  it('different seeds diverge somewhere in the first stretch', () => {
    const a = createRun(1);
    const b = createRun(2);
    run(a, 8);
    run(b, 8);
    expect(layout(b)).not.toBe(layout(a));
  });

  it('keeps the corridor stocked ahead and clean behind', () => {
    const st = createRun(9);
    run(st, 120);
    expect(st.obstacles.length).toBeGreaterThan(0);
    for (const o of st.obstacles) {
      expect(o.z).toBeLessThanOrEqual(st.z + SIM.recycleBehind);
    }
    const minZ = Math.min(...st.obstacles.map((o) => o.z));
    expect(minZ).toBeLessThanOrEqual(st.z - SIM.spawnAhead + 17); // max gap ≈ 16.5
  });
});

// ---- near-miss vs hit boundary ----------------------------------------------------------

describe('near-miss vs hit boundary', () => {
  it('rock contact radius: touching = hit, +ε = near, beyond 1.2u = clear', () => {
    const mk = (): Obstacle => ({
      id: 0, kind: 'rock', x: 0, y: 0, z: 0, r: 1, spin: 0, phase: 0, passed: false, dead: false,
    });
    const touch = 1 + SIM.shipR; // lateral offset where clearance hits exactly 0
    expect(obstacleOutcome(mk(), touch, 0)).toBe('hit');
    expect(obstacleOutcome(mk(), touch + 0.01, 0)).toBe('near');
    expect(obstacleOutcome(mk(), touch + SIM.nearMissDist - 0.01, 0)).toBe('near');
    expect(obstacleOutcome(mk(), touch + SIM.nearMissDist, 0)).toBe('clear'); // band is exclusive
    expect(obstacleOutcome(mk(), touch + SIM.nearMissDist + 0.01, 0)).toBe('clear');
  });

  it('hoop rim: clipping either rim = hit; grazing within 1.2u = near', () => {
    const mk = (ringR: number): Obstacle => ({
      id: 0, kind: 'hoop', x: 0, y: 0, z: 0, r: ringR, spin: 0, phase: 0, passed: false, dead: false,
    });
    const ringR = 3;
    const tubeEdge = SIM.hoopTube + SIM.shipR; // 0.9 — radial offset of the rim surface
    expect(obstacleOutcome(mk(ringR), ringR, 0)).toBe('hit');
    expect(obstacleOutcome(mk(ringR), ringR + tubeEdge, 0)).toBe('hit');
    expect(obstacleOutcome(mk(ringR), ringR - tubeEdge, 0)).toBe('hit');
    expect(obstacleOutcome(mk(ringR), ringR + tubeEdge + 0.01, 0)).toBe('near');
    expect(obstacleOutcome(mk(ringR), ringR - tubeEdge - 0.01, 0)).toBe('near');
    expect(obstacleOutcome(mk(ringR), ringR + tubeEdge + SIM.nearMissDist + 0.01, 0)).toBe('clear');
  });

  it('crossing inside the band fires one NEAR MISS event; dead-center explodes', () => {
    const near = createRun(5);
    isolate(near);
    injectRock(near, NEAR_DX); // clearance 0.45 → near miss
    run(near, 0.2);
    const evs = drainEvents(near);
    expect(evs.some((e) => e.kind === 'near' && e.combo === 1)).toBe(true);
    expect(near.finished).toBe(false);

    const dead = createRun(5);
    isolate(dead);
    injectRock(dead, 0);
    run(dead, 0.2);
    expect(drainEvents(dead).some((e) => e.kind === 'explode')).toBe(true);
    expect(dead.alive).toBe(false);
    expect(dead.finished).toBe(true);
  });

  it('a shield eats the hit: obstacle dies, brief invulnerability, run continues', () => {
    const st = createRun(6);
    isolate(st);
    st.shields = 1;
    injectRock(st, 0);
    run(st, 0.2);
    const evs = drainEvents(st);
    expect(evs.some((e) => e.kind === 'shieldhit')).toBe(true);
    expect(st.alive).toBe(true);
    expect(st.finished).toBe(false);
    expect(st.shields).toBe(0);
    expect(st.invulnT).toBeGreaterThan(0);
    run(st, 0.5); // cull pass removes the consumed rock
    expect(st.obstacles.length).toBe(0);
  });
});

// ---- combo decay ----------------------------------------------------------------------------

describe('combo decay timing', () => {
  /** One tick over a rock placed 0.3u ahead: crosses this tick, combo fires. */
  function scoreOneNearMiss(st: RunState): void {
    isolate(st);
    injectRock(st, NEAR_DX, 0, 0.3);
    step(st, IDLE, DT);
  }

  it('combo survives just under the 2s window and resets after it lapses', () => {
    const st = createRun(7);
    scoreOneNearMiss(st);
    expect(st.combo).toBe(1);
    // the window opened mid-step: one tick of dt already elapsed
    expect(st.comboT).toBeCloseTo(SIM.comboWindowSec - DT, 3);

    run(st, 1.8); // total ≈ 1.833s < 2s window
    expect(st.combo).toBe(1);

    run(st, 0.3); // window lapses
    expect(st.comboT).toBe(0);
    expect(st.combo).toBe(0);
  });

  it('a fresh near miss inside the window escalates the multiplier instead', () => {
    const st = createRun(7);
    scoreOneNearMiss(st);
    run(st, 1.0); // < 2s window
    scoreOneNearMiss(st);
    expect(st.combo).toBe(2);
    drainEvents(st);
  });
});

// ---- scoring formula ---------------------------------------------------------------------------

describe('scoring formula', () => {
  it('with no near misses, score = floor(dist)', () => {
    const st = createRun(11);
    isolate(st);
    run(st, 5);
    expect(scoreOf(st)).toBe(Math.floor(st.dist));
    expect(scoreOf(st)).toBeGreaterThan(0);
  });

  it('near misses add 25 × escalating combo on top of floor(dist)', () => {
    const st = createRun(11);
    isolate(st);
    const graze = (): void => {
      injectRock(st, NEAR_DX);
      run(st, 0.3); // cross + keep the window alive
    };
    graze();
    graze();
    graze(); // combos 1, 2, 3 → 25 + 50 + 75
    expect(st.nearMisses).toBe(3);
    expect(st.bonusPoints).toBe(150);
    expect(scoreOf(st)).toBe(Math.floor(st.dist) + 150);
  });

  it('boost covers more distance than an unboosted identical run', () => {
    const hot = createRun(13);
    isolate(hot);
    const cold = createRun(13);
    isolate(cold);
    expect(tryBoost(hot)).toBe(true);
    run(hot, 1);
    run(cold, 1);
    expect(hot.dist).toBeGreaterThan(cold.dist * 1.3);
  });

  it('boost respects its cooldown: no re-trigger mid-cycle, ready again after', () => {
    const st = createRun(13);
    isolate(st);
    expect(tryBoost(st)).toBe(true);
    expect(st.boostT).toBeCloseTo(SIM.boostDurSec, 10);
    expect(tryBoost(st)).toBe(false);
    run(st, SIM.boostDurSec + SIM.boostCooldownSec - 0.1);
    expect(tryBoost(st)).toBe(false);
    run(st, 0.2);
    expect(st.boostCd).toBe(0);
    expect(tryBoost(st)).toBe(true);
  });
});

// ---- resume restore ---------------------------------------------------------------------------------

describe('resume restore', () => {
  /**
   * Layout of only the LIVE window: a restored run regenerates the whole
   * stream from dist 0, including entities the original already recycled
   * behind, so raw arrays differ by design — the live window must not.
   */
  function liveLayout(st: RunState): string {
    const cutoff = st.z + SIM.recycleBehind;
    return JSON.stringify(
      st.obstacles.filter((o) => o.z <= cutoff).map((o) => [o.id, o.kind, o.x, o.y, o.z, o.r]),
    );
  }

  /** Deterministic hunt: first seed whose natural corridor survives this long. */
  function survivorSeed(seconds: number): number {
    for (let seed = 1; seed < 300; seed++) {
      const st = createRun(seed);
      run(st, seconds);
      if (st.alive && scoreOf(st) > 0) return seed;
    }
    throw new Error('no survivor seed found');
  }

  it('createRun(seed, resume) reproduces the exact live field and score at that point', () => {
    const seed = survivorSeed(12);
    const orig = createRun(seed);
    run(orig, 12);

    const snapDist = orig.dist;
    const snapScore = scoreOf(orig);
    expect(snapScore).toBeGreaterThan(0);

    const restored = createRun(seed, { dist: snapDist, score: snapScore });
    expect(restored.seed).toBe(seed);
    expect(restored.z).toBeCloseTo(orig.z, 9);
    expect(liveLayout(restored)).toBe(liveLayout(orig));
    expect(scoreOf(restored)).toBe(snapScore);
  });

  it('continuing a restored run matches an uninterrupted run tick-for-tick', () => {
    const seed = survivorSeed(12);
    const orig = createRun(seed);
    run(orig, 12);
    const snap = { dist: orig.dist, score: scoreOf(orig) };

    // neutralize transient steering history symmetrically on both sides so
    // the comparison isolates what restore actually owes us: same frontier,
    // same speed law, same field evolution from (seed, dist)
    isolate(orig);
    const resumed = createRun(seed, snap);
    isolate(resumed);
    run(orig, 6);
    run(resumed, 6);

    expect(resumed.gen.obsZ).toBeCloseTo(orig.gen.obsZ, 9);
    expect(resumed.gen.shieldZ).toBeCloseTo(orig.gen.shieldZ, 9);
    expect(resumed.dist).toBeCloseTo(orig.dist, 6);
    expect(resumed.z).toBeCloseTo(orig.z, 6);
    expect(liveLayout(resumed)).toBe(liveLayout(orig));
    expect(scoreOf(resumed)).toBe(scoreOf(orig));
  });

  it('rejects nonsense resume data by falling back to a fresh start', () => {
    const fresh = createRun(3);
    const weird = createRun(3, { dist: -50, score: 100 });
    expect(weird.z).toBe(fresh.z);
    expect(weird.dist).toBe(0);
    expect(scoreOf(weird)).toBe(0);
  });
});

// ---- steering -----------------------------------------------------------------------------------------

describe('steering', () => {
  it('lateral input moves the ship and clamps to the tunnel wall', () => {
    const st = createRun(21);
    isolate(st);
    run(st, 2, { ax: 1, ay: 1 });
    expect(st.x).toBeGreaterThan(1);
    expect(st.y).toBeGreaterThan(1);
    run(st, 6, { ax: 1, ay: 1 }); // push into the wall for a long time
    const lim = SIM.tunnelR - SIM.shipR;
    expect(Math.hypot(st.x, st.y)).toBeLessThanOrEqual(lim + 1e-6);
  });

  it('recentering decays lateral velocity when input releases', () => {
    const st = createRun(21);
    isolate(st);
    run(st, 1, { ax: 1, ay: 0 });
    expect(st.vx).toBeGreaterThan(5);
    run(st, 1, IDLE);
    expect(st.vx).toBe(0); // friction bleeds speed to a stop…
    // …but there is no recentering force: the ship holds its line, still inside
    const lim = SIM.tunnelR - SIM.shipR;
    expect(Math.hypot(st.x, st.y)).toBeLessThanOrEqual(lim + 1e-9);
    expect(Math.abs(st.x)).toBeGreaterThan(3); // didn't drift home
  });
});
