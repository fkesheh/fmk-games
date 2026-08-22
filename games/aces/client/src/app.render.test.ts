// ============================================================================
// ACES — C_APP render-pipeline tests (app.render.test.ts), headless.
//
// GRAPHICS_3D.md §6: the retired 2D render suites are "rewritten for pure
// math parts (mapping, pooling, determinism) without GL context". The 3D app
// pipeline keeps its logic in exported pure helpers in app.ts exactly for
// this suite: bank/turn derivation from heading deltas (no wire echo),
// pitch/bob attitude targets, the death-cam state machine, trail-threshold
// selection, server-id-keyed trail planning, and the crate fall→active edge
// detector. GL itself is pinned by render3d/scene.test.ts / planeModels.test.ts.
// Every describe names the law it pins; no DOM, no canvas, deterministic.
// ============================================================================
import { describe, expect, it } from 'vitest';
import { CLASSES, FIRE_BELOW, PLANE_Y, SMOKE_BELOW } from '@aces/shared/config.js';
import {
  CrateLandTracker,
  DeathCamMode,
  TrailCall,
  bankFromHeadingDelta,
  bankFromTurnInput,
  bobPhaseFor,
  deathCamNext,
  headingDeltaShortest,
  pitchAttitude,
  planeBobY,
  planTrailCalls,
  trailLevel,
  turnInputFromHeadingDelta,
} from './app.js';

const DT = 1 / 60;

/** Structural stand-in for app.ts's internal TrailRow (same field names). */
function row(over: Partial<{ id: string; x: number; y: number; hp: number; maxHp: number; dead: boolean }> = {}) {
  return { id: 'srv-1', x: 10, y: 20, hp: 100, maxHp: 100, dead: false, ...over };
}

// ---------------------------------------------------------------------------
// §1 attitude — own-bank derived from heading delta (sign + clamp)
// ---------------------------------------------------------------------------

describe('bank derivation — §1 roll = −turnInput·0.45rad from a derived turn echo', () => {
  it('treats clockwise heading growth (right turn) as positive turn input', () => {
    // fighter full-authority low-speed turn ≈ turnRate rad/s
    const dh = CLASSES.fighter.turnRate * DT;
    const turnIn = turnInputFromHeadingDelta(dh, DT);
    expect(turnIn).toBeGreaterThan(0);
    expect(turnIn).toBeCloseTo(CLASSES.fighter.turnRate / CLASSES.scout.turnRate, 12); // 3.0/3.7
    expect(turnInputFromHeadingDelta(-dh, DT)).toBeCloseTo(
      -CLASSES.fighter.turnRate / CLASSES.scout.turnRate,
      12,
    );
  });

  it('banks OPPOSITE the sign of the turn per the frozen formula', () => {
    expect(bankFromTurnInput(1)).toBeCloseTo(-0.45, 15);
    expect(bankFromTurnInput(-1)).toBeCloseTo(0.45, 15);
    expect(bankFromTurnInput(0)).toBe(0);
  });

  it('clamps the derived echo at ±1 so absurd deltas never exceed ±0.45rad of bank', () => {
    const dh = CLASSES.scout.turnRate * 4 * DT; // 4× beyond the fleet ceiling
    expect(turnInputFromHeadingDelta(dh, DT)).toBe(1);
    expect(bankFromTurnInput(1)).toBeCloseTo(-0.45, 15);
    expect(bankFromTurnInput(-1)).toBeCloseTo(0.45, 15);
    expect(bankFromHeadingDelta(0, dh, DT)).toBeCloseTo(-0.45, 15); // full chain
  });

  it('normalizes by dt — the same maneuver sampled slower yields the same echo', () => {
    const rate = 2.5; // rad/s steady turn
    const fast = turnInputFromHeadingDelta(rate / 120, 1 / 120);
    const slow = turnInputFromHeadingDelta(rate / 30, 1 / 30);
    expect(fast).toBeCloseTo(slow, 12);
    expect(bankFromHeadingDelta(0, rate / 60, DT)).toBeCloseTo(
      bankFromTurnInput(rate / CLASSES.scout.turnRate),
      12,
    );
  });

  it('takes the short way round the wrap boundary and stays neutral at dt≤0', () => {
    expect(headingDeltaShortest(3.1, -3.1)).toBeCloseTo(Math.PI * 2 - 6.2, 12); // +0.083 across π
    expect(headingDeltaShortest(-3.1, 3.1)).toBeCloseTo(-(Math.PI * 2 - 6.2), 12);
    expect(turnInputFromHeadingDelta(0.05, 0)).toBe(0);
    expect(turnInputFromHeadingDelta(0.05, -DT)).toBe(0);
    expect(bankFromHeadingDelta(0, 0.05, 0)).toBe(0); // first sighting: no bank kick
  });
});

describe('§1 pitch + bob attitude targets', () => {
  it('pitch climbs with throttle and dives while boosting', () => {
    expect(pitchAttitude(0, false)).toBe(0);
    expect(pitchAttitude(1, false)).toBeCloseTo(0.06, 15);
    expect(pitchAttitude(1, true)).toBeCloseTo(0.02, 15);
    expect(pitchAttitude(-0.3, true)).toBeCloseTo(-0.06 * 0.3 - 0.04, 15);
  });

  it('bob rides cruise altitude ±0.6u on sin(t·0.9+phase)', () => {
    expect(PLANE_Y).toBe(12);
    expect(planeBobY(0, 0)).toBeCloseTo(PLANE_Y, 15);
    expect(planeBobY(Math.PI / (2 * 0.9), 0)).toBeCloseTo(PLANE_Y + 0.6, 12); // first crest
    expect(planeBobY((3 * Math.PI) / (2 * 0.9), 0)).toBeCloseTo(PLANE_Y - 0.6, 12);
    for (let t = 0; t < 20; t += 0.37) {
      const y = planeBobY(t, 1.23);
      expect(y).toBeGreaterThanOrEqual(PLANE_Y - 0.600001);
      expect(y).toBeLessThanOrEqual(PLANE_Y + 0.600001);
    }
  });

  it('bob phase is deterministic per id and spans [0, 2π)', () => {
    expect(bobPhaseFor('pilot-1')).toBe(bobPhaseFor('pilot-1'));
    for (const id of ['a', 'bot-7', 'very-long-player-id-string']) {
      const p = bobPhaseFor(id);
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThan(Math.PI * 2);
    }
  });
});

// ---------------------------------------------------------------------------
// §2 camera — death-cam state machine (alive→dead switches follow→orbit)
// ---------------------------------------------------------------------------

describe('death-cam state machine — follow→orbit on death, respawn returns follow', () => {
  it('flies → follow; dies → orbit; keeps orbiting every dead frame', () => {
    let mode: DeathCamMode = 'follow';
    mode = deathCamNext(mode, true);
    expect(mode).toBe('follow');
    mode = deathCamNext(mode, false); // death edge
    expect(mode).toBe('orbit');
    mode = deathCamNext(mode, false); // still dead (respawn countdown)
    expect(mode).toBe('orbit');
    mode = deathCamNext(mode, false);
    expect(mode).toBe('orbit');
  });

  it('returns to follow exactly when a living own row reappears', () => {
    let mode: DeathCamMode = 'orbit';
    mode = deathCamNext(mode, true); // respawn
    expect(mode).toBe('follow');
    // and a second life→death→life cycle round-trips again
    mode = deathCamNext(deathCamNext(mode, false), true);
    expect(mode).toBe('follow');
  });
});

// ---------------------------------------------------------------------------
// Trails — threshold selection + SERVER-ID keying
// ---------------------------------------------------------------------------

describe('trail level selection — hpFrac vs SMOKE_BELOW/FIRE_BELOW', () => {
  it('burns below FIRE_BELOW, smokes below SMOKE_BELOW, else clean', () => {
    expect(trailLevel(24, 100)).toBe('fire'); // 0.24 < 0.25
    expect(trailLevel(25, 100)).toBe('smoke'); // boundary belongs to smoke
    expect(trailLevel(49, 100)).toBe('smoke'); // 0.49 < 0.5
    expect(trailLevel(50, 100)).toBeNull(); // boundary belongs to clean
    expect(trailLevel(100, 100)).toBeNull();
  });

  it('guards maxHp ≤ 0 wire noise as clean (never divides by zero)', () => {
    expect(trailLevel(0, 0)).toBeNull();
    expect(trailLevel(50, -10)).toBeNull();
  });

  it('pins the frozen thresholds themselves', () => {
    expect(FIRE_BELOW).toBe(0.25);
    expect(SMOKE_BELOW).toBe(0.5);
  });
});

describe('planTrailCalls — keying uses server ids, not array indices', () => {
  it('emits one call per non-own row keyed by its SERVER id', () => {
    const rows = [
      row({ id: 'alpha', hp: 10, maxHp: 100 }), // fire
      row({ id: 'bravo', hp: 30, maxHp: 100 }), // smoke
      row({ id: 'charlie' }), // clean
    ];
    const calls: TrailCall[] = [];
    expect(planTrailCalls(rows, 'me', null, calls)).toBe(3);
    expect(calls.slice(0, 3).map((c) => c.id)).toEqual(['alpha', 'bravo', 'charlie']);
    expect(calls.slice(0, 3).map((c) => c.level)).toEqual(['fire', 'smoke', null]);
    expect(calls[0]).toMatchObject({ x: 10, y: 20 });
  });

  it('skips the OWN row (the predictor plans that one separately)', () => {
    const rows = [row({ id: 'me', hp: 1, maxHp: 100 }), row({ id: 'other', hp: 40, maxHp: 100 })];
    const calls: TrailCall[] = [];
    expect(planTrailCalls(rows, 'me', null, calls)).toBe(1);
    expect(calls[0]!.id).toBe('other');
  });

  it('dead rows plan an EXPLICIT null so their emitter clears over wrecks', () => {
    const calls: TrailCall[] = [];
    expect(planTrailCalls([row({ id: 'wreck', hp: 80, maxHp: 100, dead: true })], 'me', null, calls)).toBe(1);
    expect(calls[0]).toEqual({ id: 'wreck', x: 10, y: 20, level: null });
  });

  it('plans the own row from the merged predictor view, cleared while dead', () => {
    const calls: TrailCall[] = [];
    expect(
      planTrailCalls([], 'me', row({ id: 'me', x: 99, y: 55, hp: 20, maxHp: 100, dead: false }), calls),
    ).toBe(1);
    expect(calls[0]).toEqual({ id: 'me', x: 99, y: 55, level: 'fire' });
    expect(planTrailCalls([], 'me', row({ id: 'me', dead: true }), calls)).toBe(1);
    expect(calls[0]).toEqual({ id: 'me', x: 10, y: 20, level: null });
    expect(planTrailCalls([], 'me', null, calls)).toBe(0); // spectating: nothing planned
  });

  it('reuses pooled output records across frames without truncation (zero steady-state allocation)', () => {
    const calls: TrailCall[] = [];
    planTrailCalls([row({ id: 'a' }), row({ id: 'b' })], '', null, calls);
    const refA = calls[0];
    const refB = calls[1];
    planTrailCalls([row({ id: 'c' })], '', null, calls);
    expect(calls[0]).toBe(refA); // same object reused, fields overwritten
    planTrailCalls([row(), row(), row()], '', null, calls);
    expect(calls[1]).toBe(refB); // surplus slot SURVIVED the smaller frame and got reused
    expect(calls[2]).toBeDefined(); // capacity grew once; never shrinks back
    expect(calls[0]!.id).toBe('srv-1');
  });
});

// ---------------------------------------------------------------------------
// Crates — fall→active transition fires 'land' EXACTLY ONCE per crate
// ---------------------------------------------------------------------------

describe('CrateLandTracker — snapshot-diff landing edge', () => {
  it('arms while falling and fires the land edge exactly once', () => {
    const t = new CrateLandTracker();
    expect(t.observe(1, 'fall')).toBe(false);
    expect(t.observe(1, 'fall')).toBe(false); // repeated falling snapshots stay silent
    expect(t.observe(1, 'active')).toBe(true); // THE land frame
    expect(t.observe(1, 'active')).toBe(false); // landed snapshots afterwards: nothing
    expect(t.observe(1, 'active')).toBe(false);
  });

  it('never fires for a crate first seen already active', () => {
    const t = new CrateLandTracker();
    expect(t.observe(7, 'active')).toBe(false);
  });

  it('re-arms for a NEW drop of the same crate id after clear()', () => {
    const t = new CrateLandTracker();
    t.observe(3, 'fall');
    expect(t.observe(3, 'active')).toBe(true);
    t.clear(); // round restart / fresh seat
    expect(t.observe(3, 'fall')).toBe(false);
    expect(t.observe(3, 'active')).toBe(true);
  });

  it('tracks several crates independently', () => {
    const t = new CrateLandTracker();
    t.observe(1, 'fall');
    t.observe(2, 'fall');
    expect(t.observe(2, 'active')).toBe(true);
    expect(t.observe(1, 'active')).toBe(true);
    expect(t.observe(2, 'active')).toBe(false);
  });
});
