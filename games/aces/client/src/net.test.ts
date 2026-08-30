// ============================================================================
// ACES — C_NET tests (PURE logic only — no socket, no DOM, no timers; vitest
// node environment per CONTRACT RULES 8 "interp math" coverage).
//
// Covered here:
//   · RemoteInterp: mid-point lerp of x/y and shortest-arc h ACROSS the 2π
//     wrap; stale (out-of-order tick) snapshots ignored whole; clamp-to-
//     nearest before the first / after the last buffered snapshot; ALL rows
//     returned including the own-plane row (app filters); non-positional
//     fields always come from the NEWER bracketing snapshot
//   · OwnPredictor.advance: integrates straight flight EXACTLY like a hand-
//     rolled shared-stepPlane reference loop (same CLASSES, same substeps)
//   · reconcile: snaps beyond NET.RECONCILE_SNAP_U (exact server pose),
//     blends within it (exactly RECONCILE_BLEND of residual error)
//   · replay: after a snap to an acked older server pose, unacked inputs are
//     re-run so the predicted trajectory equals a reference simulation that
//     continued from that pose through those inputs
//   · pending queue pruned by the echoed seq
//   · setClass swaps the airframe spec: same input, different turn response
//   · death freeze: advance() is inert while dead
//
// Determinism law: zero Math.random anywhere; every expected value below is
// either exact arithmetic or a reference simulation over the frozen shared
// physics — never a re-derivation of the implementation under test's private
// logic.
// ============================================================================

import { describe, expect, it } from 'vitest';
import { CLASSES } from '@aces/shared/config.js';
import { INTERP_MS } from '@aces/shared/config.js';
import { angleDelta, stepPlane, wrapAngle } from '@aces/shared/physics.js';
import type { InputFrame, PlaneState } from '@aces/shared/types.js';
import type { SnapPlane } from '@aces/shared/protocol.js';
import type { SnapshotView } from './contract/seams.js';
import { RemoteInterp } from './net.js';
import { OwnPredictor } from './prediction.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let nextBulletId = 1;
void nextBulletId;

function mkPlane(id: string, x: number, y: number, h: number, patch: Partial<SnapPlane> = {}): SnapPlane {
  return {
    id,
    name: id.toUpperCase(),
    team: id === 'me' ? 'royal' : 'iron',
    cls: 'fighter',
    bot: false,
    x,
    y,
    h,
    sp: 150,
    vx: 150,
    vy: 0,
    hp: 100,
    maxHp: 100,
    heat: 0,
    jammed: false,
    boost: 100,
    boosting: false,
    throttle: 1,
    invulnT: 0,
    dead: false,
    streak: 0,
    seq: 0,
    ...patch,
  };
}

function mkSnap(tick: number, planes: SnapPlane[]): SnapshotView {
  return {
    tick,
    phase: 'live',
    timeLeftS: 300,
    tickets: { royal: 3, iron: 2 },
    you: undefined,
    planes,
    bullets: [],
    crates: [],
    rttMs: 0,
  };
}

/** Reference straight-line sim: apply each frame for `sub` shared-physics
 *  substeps — the hand-computed oracle the predictor must reproduce. */
function refStep(p: PlaneState, frame: InputFrame, sub = 2): void {
  for (let i = 0; i < sub; i++) stepPlane(p, frame, 1 / 60);
}

function mkRefState(cls: PlaneState['cls'], x: number, y: number): PlaneState {
  const spec = CLASSES[cls];
  return {
    id: 'ref',
    name: 'REF',
    team: 'royal',
    cls,
    bot: false,
    x,
    y,
    vx: spec.speedMin,
    vy: 0,
    h: 0,
    hp: spec.hp,
    heat: 0,
    jammed: false,
    boost: 100,
    boosting: false,
    throttle: 0,
    invulnT: 0,
    fireCd: 0,
    dead: false,
    respawnT: 0,
    streak: 0,
  };
}

const THRUST: InputFrame = { seq: 0, th: 1, tr: 0, fire: false, boost: false };

// ---------------------------------------------------------------------------
// RemoteInterp
// ---------------------------------------------------------------------------

describe('RemoteInterp', () => {
  it('lerps x/y and takes the shortest arc for h across the 2π wrap at the midpoint', () => {
    let nowMs = 1000;
    const ri = new RemoteInterp(() => nowMs);

    // A→B span 100 ms of arrival clock and 3 ticks @30 Hz (100 ms) — consistent.
    // h goes 6.0 rad → 0.5 rad: the naive numeric lerp would spin backwards the
    // LONG way (-5.5 rad); shortest arc goes forwards +0.783 rad over the wrap.
    const A = mkSnap(300, [mkPlane('a', 100, 200, 6.0), mkPlane('me', 0, 0, 0)]);
    nowMs = 1000;
    ri.push(A);
    const B = mkSnap(303, [mkPlane('a', 300, 400, 0.5, { hp: 42 }), mkPlane('me', 10, 0, 0)]);
    nowMs = 1100;
    ri.push(B);

    // Render time = now − INTERP_MS = 1170 − 120 = 1050 → exactly halfway.
    nowMs = 1000 + INTERP_MS + 50;
    const out: SnapPlane[] = [];
    ri.sampleRemotes(nowMs, out);

    expect(out).toHaveLength(2);
    const a = out.find((p) => p.id === 'a');
    expect(a).toBeDefined();
    const expectedMidH = wrapAngle(6.0 + angleDelta(6.0, 0.5) * 0.5);
    expect(expectedMidH).toBeCloseTo(0.1084, 3); // sanity: truly crossed the wrap
    expect(a!.x).toBeCloseTo(200, 9);
    expect(a!.y).toBeCloseTo(300, 9);
    expect(a!.h).toBeCloseTo(expectedMidH, 12);
    // Non-positional fields ride the NEWER snapshot (newer truth wins).
    expect(a!.hp).toBe(42);
  });

  it('ignores stale snapshots wholesale (older tick never enters the buffer)', () => {
    let nowMs = 1000;
    const ri = new RemoteInterp(() => nowMs);
    nowMs = 1000;
    ri.push(mkSnap(300, [mkPlane('a', 100, 200, 6.0)]));
    nowMs = 1100;
    ri.push(mkSnap(303, [mkPlane('a', 300, 400, 0.5)]));
    nowMs = 1105;
    ri.push(mkSnap(301, [mkPlane('a', -9999, -9999, 0)])); // stale: must vanish

    expect(ri.latest()!.tick).toBe(303);
    nowMs = 1000 + INTERP_MS + 50;
    const out: SnapPlane[] = [];
    ri.sampleRemotes(nowMs, out); // still brackets A(300) ↔ B(303)
    expect(out[0]!.x).toBeCloseTo(200, 9);
    expect(out[0]!.y).toBeCloseTo(300, 9);
  });

  it('clamps to the nearest snapshot before the first and after the last', () => {
    let nowMs = 1000;
    const ri = new RemoteInterp(() => nowMs);
    nowMs = 1000;
    ri.push(mkSnap(300, [mkPlane('a', 111, 222, 0.25)]));
    const last = mkSnap(306, [mkPlane('a', 333, 444, 0.75)]);
    nowMs = 1200;
    ri.push(last);

    const early: SnapPlane[] = [];
    nowMs = 1000; // render time 880 < first arrival → clamp to FIRST
    ri.sampleRemotes(nowMs, early);
    expect(early[0]!.x).toBe(111);
    expect(early[0]!.h).toBeCloseTo(0.25, 12);

    const late: SnapPlane[] = [];
    nowMs = 99999; // render time way past the newest → clamp to LAST
    ri.sampleRemotes(nowMs, late);
    expect(late[0]!.x).toBe(333);
    expect(late[0]!.y).toBe(444);
    expect(late[0]!.h).toBeCloseTo(0.75, 12);
  });

  it('returns ALL rows including the own-plane row (app filters), reused output array', () => {
    let nowMs = 1000;
    const ri = new RemoteInterp(() => nowMs);
    nowMs = 1000;
    ri.push(mkSnap(300, [mkPlane('me', 0, 0, 0)]));
    nowMs = 1100;
    ri.push(mkSnap(303, [mkPlane('me', 20, 0, 0), mkPlane('b2', 500, 500, 1)]));

    const out: SnapPlane[] = [];
    nowMs = 1100 + INTERP_MS; // render time = B's arrival exactly → B emitted verbatim
    ri.sampleRemotes(nowMs, out);
    expect(out).toHaveLength(2); // me + b2 — nothing filtered here
    expect(out.map((p) => p.id)).toEqual(['me', 'b2']);
  });
});

// ---------------------------------------------------------------------------
// OwnPredictor — advance()
// ---------------------------------------------------------------------------

describe('OwnPredictor.advance', () => {
  it('integrates straight flight exactly like a hand-run shared stepPlane loop', () => {
    const p = new OwnPredictor('fighter');
    p.state.x = 1000;
    p.state.y = 2000;
    const ref = mkRefState('fighter', 1000, 2000);

    p.onLocalInput({ ...THRUST, seq: 1 });
    for (let i = 0; i < 60; i++) {
      p.advance(1 / 60);
      stepPlane(ref, THRUST, 1 / 60);
    }

    // Bit-for-bit the same arithmetic path (shared stepPlane, same substeps,
    // same constants) — hence exact equality, not tolerance.
    expect(p.state.x).toBeCloseTo(ref.x, 9);
    expect(p.state.y).toBeCloseTo(ref.y, 9);
    expect(p.state.vx).toBeCloseTo(ref.vx, 9);
    expect(p.state.h).toBeCloseTo(ref.h, 9);
    // Physics sanity: 1 s at full throttle from floor speed hits speedMax
    // (fighter accel 200 u/s² covers the 115 u/s gap in 0.575 s).
    const spec = CLASSES.fighter;
    expect(Math.hypot(p.state.vx, p.state.vy)).toBeCloseTo(spec.speedMax, 6);
  });

  it('is inert while dead (death freeze)', () => {
    const p = new OwnPredictor('fighter');
    p.onLocalInput({ ...THRUST, seq: 1 });
    p.reconcile(mkPlane('me', 500, 500, 0, { dead: true, hp: 0 }));
    const frozen = { x: p.state.x, y: p.state.y };
    p.advance(10); // way past any backlog
    expect(p.state.x).toBe(frozen.x);
    expect(p.state.y).toBe(frozen.y);
  });
});

// ---------------------------------------------------------------------------
// OwnPredictor — reconcile
// ---------------------------------------------------------------------------

describe('OwnPredictor.reconcile', () => {
  it('snaps hard beyond NET.RECONCILE_SNAP_U (exact server pose, velocities included)', () => {
    const p = new OwnPredictor('fighter');
    p.state.x = 0;
    p.state.y = 0;
    p.state.vx = 0;
    p.state.vy = 0;
    p.reconcile(mkPlane('me', 500, 0, 0, { vx: 110, vy: 0 })); // err 500 > 80
    expect(p.state.x).toBe(500);
    expect(p.state.y).toBe(0);
    expect(p.state.vx).toBe(110);
  });

  it('blends exactly NET.RECONCILE_BLEND of the residual error within threshold', () => {
    const p = new OwnPredictor('fighter');
    p.state.x = 0;
    p.state.y = 0;
    // err 30 u < 80 u; seq 9 acks the whole queue → pure blend math, no
    // replay drift. (If unacked inputs survived pruning, the replayed
    // throttle frames would push x past the pure-blend value.)
    p.onLocalInput({ seq: 9, th: 1, tr: 0, fire: false, boost: false });
    p.reconcile(mkPlane('me', 30, 10, 0, { seq: 9 }));
    expect(p.state.x).toBeCloseTo(7.5, 12); // 0 + 30 × 0.25
    expect(p.state.y).toBeCloseTo(2.5, 12); // 0 + 10 × 0.25
  });

  it('replays unacked inputs after a snap, restoring the server+pending trajectory', () => {
    // Reference truth: fly four throttle frames (each 2 substeps @1/60).
    const frames: InputFrame[] = [1, 2, 3, 4].map((s) => ({ ...THRUST, seq: s }));
    const truth = mkRefState('fighter', 1000, 2000);
    for (const f of [frames[0], frames[1]]) refStep(truth, f!);
    // `truth` is now the server's view at acked seq 2. Continue to seq 4:
    const full = mkRefState('fighter', 1000, 2000);
    for (const f of frames) refStep(full, f!);
    // The player's predictor ran ahead to `full` (that is what prediction IS):
    const p = new OwnPredictor('fighter');
    p.state.x = 1000;
    p.state.y = 2000;
    for (const f of frames) {
      p.onLocalInput(f!);
      // Two explicit substeps per frame — NOT advance(1/30), whose substep
      // count depends on float accumulation; this keeps the predictor's
      // substep sequence BIT-IDENTICAL to refStep's rigid 2-per-frame.
      p.advance(1 / 60);
      p.advance(1 / 60);
    }
    expect(p.state.x).toBeCloseTo(full.x, 9); // predictor == reference pre-reconcile

    // Server snapshot lags: acked seq 2, pose = truth pulled 200 u west so the
    // position error clears the SNAP threshold (teleport-class correction).
    const lagX = truth.x - 200;
    p.reconcile(
      mkPlane('me', lagX, truth.y, truth.h, { seq: 2, vx: truth.vx, vy: truth.vy }),
    );

    // Oracle: a reference sim continuing from the snapped pose through the two
    // unacked frames. Replay must land EXACTLY there.
    const oracle = mkRefState('fighter', lagX, truth.y);
    oracle.h = truth.h;
    oracle.vx = truth.vx;
    oracle.vy = truth.vy;
    refStep(oracle, frames[2]!);
    refStep(oracle, frames[3]!);

    expect(p.state.x).toBeCloseTo(oracle.x, 9);
    expect(p.state.y).toBeCloseTo(oracle.y, 9);
    expect(p.state.vx).toBeCloseTo(oracle.vx, 9);
    expect(p.state.h).toBeCloseTo(wrapAngle(oracle.h), 9);

    // Behavioral proof the queue was pruned to exactly {f3, f4} by seq 2 AND
    // drained by a later full ack: displace within blend range, reconcile at
    // the current pose with seq 4 — if ANY input survived, replay would move
    // the plane past the pure-blend result.
    const settled = p.state.x;
    p.reconcile(mkPlane('me', p.state.x, p.state.y, p.state.h, { seq: 4 }));
    p.state.x -= 50; // err 50 < 80: blend branch
    p.reconcile(mkPlane('me', settled, p.state.y, p.state.h, { seq: 4 }));
    expect(p.state.x).toBeCloseTo(settled - 50 + 50 * 0.25, 9); // −37.5, nothing more
  });

  it('takes the server pose wholesale on rebirth (dead → alive transition)', () => {
    const p = new OwnPredictor('fighter');
    p.onLocalInput({ ...THRUST, seq: 1 });
    p.advance(0.05);
    p.reconcile(mkPlane('me', 700, 800, Math.PI, { dead: true, hp: 0 }));
    expect(p.state.dead).toBe(true);
    // New life appears elsewhere entirely:
    p.reconcile(mkPlane('me', 2500, 1200, 1.5));
    expect(p.state.dead).toBe(false);
    expect(p.state.x).toBe(2500);
    expect(p.state.y).toBe(1200);
    expect(p.state.hp).toBe(CLASSES.fighter.hp); // authoritative respawn HP
  });
});

// ---------------------------------------------------------------------------
// OwnPredictor — class swap
// ---------------------------------------------------------------------------

describe('OwnPredictor.setClass', () => {
  it('changes turn response: same input, airframe-specific heading gain', () => {
    const fly = (cls: 'scout' | 'gunship'): number => {
      const p = new OwnPredictor(cls);
      p.onLocalInput({ seq: 1, th: 0, tr: 1, fire: false, boost: false });
      for (let i = 0; i < 5; i++) p.advance(0.1); // 0.5 s → 30 substeps
      return p.state.h;
    };
    const scoutH = fly('scout');
    const gunshipH = fly('gunship');
    // Both sit at floor speed → full turn authority: 3.7·0.5 vs 2.2·0.5 rad.
    expect(scoutH).toBeCloseTo(1.85, 6);
    expect(gunshipH).toBeCloseTo(1.1, 6);
    expect(scoutH - gunshipH).toBeCloseTo(0.75, 6);
  });

  it('resets combat resources to the new airframe spec', () => {
    const p = new OwnPredictor('scout');
    p.setClass('gunship');
    expect(p.state.cls).toBe('gunship');
    expect(p.state.hp).toBe(CLASSES.gunship.hp); // PlaneState has no maxHp — hp IS the spec's fresh value
    expect(p.state.boost).toBe(100);
  });
});
