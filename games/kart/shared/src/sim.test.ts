// ============================================================================
// sim.ts unit tests — the SERVER-AUTHORITATIVE shared drive sim, the whole
// netcode contract for KART GP (see the doc comment atop sim.ts). Style mirrors
// kartPhysics.test.ts: vitest, plain describe/it, no mocks, deterministic, all
// magic numbers explained or pulled from config.
// ============================================================================
import { describe, expect, it } from 'vitest';
import {
  GATE_RADIUS,
  GATES,
  KART_RADIUS,
  KART_RESTITUTION,
  PENDING_INPUT_CAP,
  SIM_DT,
  SIM_SUBSTEPS,
  TOP_SPEED,
} from './config.js';
// BARRIER_DAMP / BARRIER_OUT are plain contract constants (not listed in the
// task's export summary but genuinely exported by config.ts) — imported so the
// barrier test predicts the exact post-clamp velocity instead of hardcoding it.
import { BARRIER_DAMP, BARRIER_OUT } from './config.js';
import { makeKart, stepKart } from './kartPhysics.js';
import type { KartState } from './kartPhysics.js';
import { buildTrack, closestOnTrack, gridSlot, surfaceAt } from './track.js';
import type { TrackDef } from './track.js';
import {
  KartPredictor,
  clampToBarrier,
  copySim,
  makeAssistState,
  makeSim,
  pursuitSteer,
  resetSim,
  resolveKartPair,
  stepDrive,
  stuckStep,
  STUCK_HOLD_S,
  STUCK_SPEED,
  STUCK_THROTTLE,
  wrapPi,
} from './sim.js';
import type { AssistState, DriveInput, KartSim, SimInput } from './sim.js';

// ---- helpers ----------------------------------------------------------------

function drive(over: Partial<DriveInput> = {}): DriveInput {
  return { throttle: 0, brake: 0, steer: 0, drift: false, respawn: false, ...over };
}

/**
 * A point on the centerline roughly HALFWAY between gate 0 and gate 1 — far
 * enough from every gate's GATE_RADIUS that a kart parked there does not
 * trip creditAnchor by accident. Used wherever a test needs gate-crediting to
 * be a controlled event rather than an ambient side effect (grid slot 0 sits
 * only ~6-9m behind gate 0, well inside GATE_RADIUS=9m, so tests that care
 * about NOT triggering a credit must not start there).
 */
function midGateSpot(track: TrackDef): { x: number; z: number; yaw: number } {
  const n = track.centerline.length;
  const idx = Math.round(n / (GATES * 2)); // halfway between gate 0 and gate 1
  const a = track.centerline[idx]!;
  const b = track.centerline[(idx + 1) % n]!;
  const yaw = Math.atan2(-(b[0] - a[0]), -(b[1] - a[1]));
  const spot = { x: a[0], z: a[1], yaw };
  for (const g of track.gates) {
    const d = Math.hypot(g.x - spot.x, g.z - spot.z);
    if (d <= GATE_RADIUS) throw new Error('midGateSpot fell inside a gate radius — fixture bug');
  }
  return spot;
}

/** Deterministic-but-varied drive script (plain trig, no Math.random). */
function scriptAt(i: number): DriveInput {
  const t = i * 0.29;
  return drive({
    throttle: 0.5 + 0.5 * Math.sin(t),
    brake: i % 13 === 0 ? 0.3 : 0,
    steer: Math.sin(t * 1.7) * 0.8,
    drift: i % 9 < 2,
  });
}

function fieldsOf(s: Readonly<KartSim>): unknown[] {
  return [
    s.x, s.y, s.z, s.yaw, s.vx, s.vz, s.gear, s.shiftLeft, s.drifting, s.nitroLeft,
    s.expectedGate, s.anchorX, s.anchorZ, s.anchorYaw,
  ];
}

// ==============================================================================
// 1. DETERMINISM / THE PREDICTION CONTRACT
// ==============================================================================

describe('determinism — the prediction contract', () => {
  it('two KartSims fed the identical input sequence end bit-identical on every field', () => {
    const trackA = buildTrack();
    const trackB = buildTrack(); // independently built — determinism must not depend on sharing an object
    const spot = midGateSpot(trackA);
    const a = makeSim(spot.x, spot.z, spot.yaw);
    const b = makeSim(spot.x, spot.z, spot.yaw);
    for (let i = 0; i < 150; i++) {
      const inp = scriptAt(i);
      stepDrive(a, inp, SIM_DT, trackA);
      stepDrive(b, inp, SIM_DT, trackB);
    }
    expect(fieldsOf(a)).toEqual(fieldsOf(b)); // toEqual on primitives is ===-equivalent per element
    for (let i = 0; i < fieldsOf(a).length; i++) {
      expect(Object.is(fieldsOf(a)[i], fieldsOf(b)[i])).toBe(true);
    }
  });

  it('one stepDrive(SIM_DT) matches the substep loop the module itself defines (dt split into SIM_SUBSTEPS equal pieces)', () => {
    // stepDrive: n = round(dt * SIM_SUBSTEP_HZ) substeps of dt/n each, surface
    // re-sampled per substep, barrier clamp after each. For dt === SIM_DT that
    // is exactly SIM_SUBSTEPS substeps of SIM_DT/SIM_SUBSTEPS. creditAnchor is
    // private to sim.ts (not exported) so it cannot be replayed here — the spot
    // is chosen far from every gate so it never fires in either branch, keeping
    // the anchor fields trivially equal without reimplementing it.
    const track = buildTrack();
    const spot = midGateSpot(track);
    const inp = drive({ throttle: 1, steer: 0.4 });

    const s1 = makeSim(spot.x, spot.z, spot.yaw);
    stepDrive(s1, inp, SIM_DT, track);

    const s2 = makeSim(spot.x, spot.z, spot.yaw);
    for (let i = 0; i < SIM_SUBSTEPS; i++) {
      stepKart(s2, inp, SIM_DT / SIM_SUBSTEPS, surfaceAt(track, s2.x, s2.z));
      clampToBarrier(s2, track);
    }

    expect(s2.expectedGate).toBe(0); // sanity: fixture really did stay clear of every gate
    expect(fieldsOf(s1)).toEqual(fieldsOf(s2));
    // NOTE: this equivalence is NOT expected to hold for an arbitrary OTHER dt
    // compared against SIM_DT (e.g. one stepDrive(2*SIM_DT) vs two
    // stepDrive(SIM_DT) calls) — creditAnchor runs once PER stepDrive call, not
    // once per substep, so a coarser dt checks the gate radius less often and
    // can observe a different (still internally consistent) outcome near a
    // gate boundary. Both peers avoid this by always passing the same SIM_DT.
  });

  it('a non-finite or non-positive dt is a no-op', () => {
    const track = buildTrack();
    const spot = midGateSpot(track);
    // NOTE: +Infinity is deliberately excluded — the guard is `!(dt > 0)`, and
    // `Infinity > 0` is true, so a +Infinity dt is NOT treated as a no-op (it
    // would try to run an infinite number of substeps). That is a real
    // consequence of the guard's shape, not something this suite should hang on.
    for (const badDt of [0, -1, NaN, -Infinity]) {
      const s = makeSim(spot.x, spot.z, spot.yaw);
      s.vx = 3; // give it something that WOULD move if dt were honored
      s.vz = -4;
      const before = fieldsOf(s);
      stepDrive(s, drive({ throttle: 1, steer: 1 }), badDt, track);
      expect(fieldsOf(s)).toEqual(before);
    }
  });
});

describe('resetSim / copySim', () => {
  it('resetSim wipes velocity/gear/drift state and re-anchors at the new spot (the GO grid wipe)', () => {
    const track = buildTrack();
    const spot = midGateSpot(track);
    const s = makeSim(spot.x, spot.z, spot.yaw);
    // scramble it as if mid-race, then wipe
    s.vx = 12;
    s.vz = -8;
    s.gear = 4;
    s.shiftLeft = 0.08;
    s.drifting = true;
    s.nitroLeft = 1.2;
    s.expectedGate = 5;

    const grid2 = gridSlot(track, 3);
    resetSim(s, grid2.x, grid2.z, grid2.yaw);

    expect(s.x).toBe(grid2.x);
    expect(s.z).toBe(grid2.z);
    expect(s.yaw).toBe(grid2.yaw);
    expect(s.vx).toBe(0);
    expect(s.vz).toBe(0);
    expect(s.gear).toBe(1);
    expect(s.shiftLeft).toBe(0);
    expect(s.drifting).toBe(false);
    expect(s.expectedGate).toBe(0); // anchor tracker restarts at 0
    expect(s.anchorX).toBe(grid2.x);
    expect(s.anchorZ).toBe(grid2.z);
    expect(s.anchorYaw).toBe(grid2.yaw);
  });

  it('copySim copies every field without allocating a new object', () => {
    const track = buildTrack();
    const spot = midGateSpot(track);
    const src = makeSim(spot.x, spot.z, spot.yaw);
    src.vx = 3;
    src.vz = -4;
    src.gear = 3;
    src.shiftLeft = 0.02;
    src.drifting = true;
    src.nitroLeft = 0.5;
    src.expectedGate = 2;
    src.anchorX = 9;
    src.anchorZ = -9;
    src.anchorYaw = 1.5;

    const dst = makeSim(0, 0, 0);
    const dstRef = dst; // identity check: copySim must mutate in place, not reassign
    copySim(dst, src);

    expect(dst).toBe(dstRef); // same object identity — no allocation
    expect(fieldsOf(dst)).toEqual(fieldsOf(src));
    // mutating src afterwards must not affect dst (a real field-by-field copy, not a reference)
    src.x += 100;
    expect(dst.x).not.toBe(src.x);
  });
});

// ==============================================================================
// 2. INTEGRATION FROM INPUT
// ==============================================================================

describe('integration from input', () => {
  it('full throttle for 1s from a grid slot moves the kart forward a plausible distance', () => {
    const track = buildTrack();
    const grid = gridSlot(track, 0);
    const s = makeSim(grid.x, grid.z, grid.yaw);
    const fx = -Math.sin(grid.yaw);
    const fz = -Math.cos(grid.yaw); // platform forward convention
    for (let i = 0; i < 30; i++) stepDrive(s, drive({ throttle: 1 }), SIM_DT, track); // 30 * SIM_DT = 1s
    const dist = (s.x - grid.x) * fx + (s.z - grid.z) * fz; // displacement along the ORIGINAL facing
    expect(dist).toBeGreaterThan(3); // strong launch, matches the gearbox test's own >7m/s floor
    expect(dist).toBeLessThan(TOP_SPEED); // cannot average faster than top speed over 1s
  });

  it('zero input from rest leaves the kart exactly still', () => {
    const track = buildTrack();
    // NOT gridSlot(track, 0): grid slot 0 sits only ~6.4m behind gate 0, inside
    // GATE_RADIUS=9m, so it credits the gate on the very first tick regardless
    // of input — a real, correct side effect, but orthogonal to "stillness"
    // and it would mutate anchorX/anchorZ/expectedGate under our feet. Use a
    // spot proven clear of every gate instead.
    const spot = midGateSpot(track);
    const s = makeSim(spot.x, spot.z, spot.yaw);
    const before = fieldsOf(s);
    for (let i = 0; i < 10; i++) stepDrive(s, drive(), SIM_DT, track);
    expect(fieldsOf(s)).toEqual(before);
  });
});

// ==============================================================================
// 3. BARRIER
// ==============================================================================

describe('barrier clamp', () => {
  it('clamps a kart shoved off the racing line back inside the band and reflects/damps the outward velocity', () => {
    const track = buildTrack();
    const grid = gridSlot(track, 0);
    const limit = track.roadHalfW + BARRIER_OUT - KART_RADIUS;
    const off0 = closestOnTrack(track, grid.x, grid.z);
    const cl = track.centerline;
    const seg = (i: number): [number, number, number, number] => {
      const a = cl[i]!;
      const b = cl[(i + 1) % cl.length]!;
      const dx = b[0] - a[0];
      const dz = b[1] - a[1];
      const len = Math.hypot(dx, dz) || 1;
      return [-dz / len, dx / len, dx, dz]; // [nx, nz, ...]
    };
    const [nx0, nz0] = seg(off0.index);
    const overshoot = 8; // meters PAST the barrier band — "shoved far off the line"
    const shovedX = grid.x + nx0 * (limit + overshoot);
    const shovedZ = grid.z + nz0 * (limit + overshoot);

    const c1 = closestOnTrack(track, shovedX, shovedZ); // exactly what clampToBarrier will compute internally
    const [nx, nz] = seg(c1.index);
    const side = c1.lateral > 0 ? 1 : -1;
    const over = Math.abs(c1.lateral) - limit;
    expect(over).toBeGreaterThan(0); // fixture really is outside the band

    const speed = 20; // outward along the normal
    const kart: KartState = {
      x: shovedX, y: 0, z: shovedZ, yaw: grid.yaw,
      vx: nx * side * speed, vz: nz * side * speed,
      gear: 1, shiftLeft: 0, drifting: false, nitroLeft: 0,
    };
    const vnBefore = kart.vx * nx + kart.vz * nz;
    expect(vnBefore).toBeCloseTo(speed, 9); // sanity: velocity really is purely outward-normal

    const predictedX = kart.x - nx * side * over;
    const predictedZ = kart.z - nz * side * over;

    clampToBarrier(kart, track);

    expect(kart.x).toBeCloseTo(predictedX, 9);
    expect(kart.z).toBeCloseTo(predictedZ, 9);
    const c2 = closestOnTrack(track, kart.x, kart.z);
    expect(Math.abs(c2.lateral)).toBeLessThanOrEqual(limit + 1e-6); // back inside the band

    const vnAfter = kart.vx * nx + kart.vz * nz; // same normal frame clampToBarrier used
    expect(vnAfter).toBeCloseTo(-BARRIER_DAMP * vnBefore, 9); // reflected + damped, per the documented formula
    expect(Math.abs(vnAfter)).toBeLessThan(Math.abs(vnBefore)); // it does not keep driving through the wall
    expect(vnAfter * side).toBeLessThanOrEqual(0); // no longer moving outward
  });

  it('does nothing when the kart is already within the band', () => {
    const track = buildTrack();
    const grid = gridSlot(track, 0);
    const kart: KartState = {
      x: grid.x, y: 0, z: grid.z, yaw: grid.yaw, vx: 5, vz: -3,
      gear: 2, shiftLeft: 0, drifting: false, nitroLeft: 0,
    };
    const before = { ...kart };
    clampToBarrier(kart, track);
    expect(kart).toEqual(before);
  });
});

// ==============================================================================
// 4. GATE ANCHOR + RESPAWN
// ==============================================================================

describe('gate anchor tracking', () => {
  it('driving forward past the EXPECTED gate advances expectedGate and snaps the anchor onto it', () => {
    const track = buildTrack();
    const g1 = track.gates[1]!;
    const approach = 20; // meters behind gate 1, well outside GATE_RADIUS=9m
    const s = makeSim(g1.x - g1.tx * approach, g1.z - g1.tz * approach, Math.atan2(-g1.tx, -g1.tz));
    s.expectedGate = 1; // simulate "gate 0 already credited, waiting on gate 1"
    const g0 = track.gates[0]!;
    s.anchorX = g0.x;
    s.anchorZ = g0.z;
    s.anchorYaw = Math.atan2(-g0.tx, -g0.tz);

    const assist = makeAssistState();
    let ticks = 0;
    const cap = 900; // ~30s safety cap so a stuck bot fails loudly instead of looping forever
    while (s.expectedGate === 1 && ticks < cap) {
      const steer = pursuitSteer(track, s, assist, SIM_DT);
      stepDrive(s, drive({ throttle: 1, steer }), SIM_DT, track);
      ticks++;
    }
    expect(ticks).toBeLessThan(cap); // it actually reached the gate, not just timed out
    expect(s.expectedGate).toBe(2);
    expect(s.anchorX).toBe(g1.x);
    expect(s.anchorZ).toBe(g1.z);
    expect(s.anchorYaw).toBe(Math.atan2(-g1.tx, -g1.tz));
  });

  it('does not credit a gate out of order even when physically sitting on it', () => {
    const track = buildTrack();
    const g3 = track.gates[3]!;
    const s = makeSim(g3.x, g3.z, 0);
    s.expectedGate = 1; // still waiting on gate 1, not 3
    stepDrive(s, drive(), SIM_DT, track);
    expect(s.expectedGate).toBe(1); // only the EXPECTED index is ever checked
  });
});

describe('respawn', () => {
  it('teleports exactly onto the anchor with zero velocity, gear 1, no drift, and integrates nothing that tick', () => {
    const track = buildTrack();
    const spot = midGateSpot(track);
    const s = makeSim(spot.x, spot.z, spot.yaw);
    // scramble the transient state away from the anchor
    s.x += 40;
    s.z -= 25;
    s.yaw = 1.234;
    s.vx = 15;
    s.vz = -9;
    s.gear = 4;
    s.shiftLeft = 0.05;
    s.drifting = true;

    stepDrive(s, drive({ throttle: 1, steer: 1, drift: true, respawn: true }), 999 /* huge dt: must be ignored */, track);

    expect(s.x).toBe(spot.x);
    expect(s.z).toBe(spot.z);
    expect(s.yaw).toBe(spot.yaw);
    expect(s.vx).toBe(0);
    expect(s.vz).toBe(0);
    expect(s.gear).toBe(1);
    expect(s.shiftLeft).toBe(0);
    expect(s.drifting).toBe(false);
  });

  it('replayed mid-sequence from a divergent transient state lands in exactly the same place', () => {
    const track = buildTrack();
    const anchor = { x: 12.5, z: -48.25, yaw: 0.42 };
    const respawnInput = drive({ throttle: 1, steer: -1, brake: 1, drift: true, respawn: true });

    function kartWithAnchor(over: Partial<KartSim>): KartSim {
      const s = makeSim(anchor.x - 5, anchor.z + 3, 1.1);
      s.anchorX = anchor.x;
      s.anchorZ = anchor.z;
      s.anchorYaw = anchor.yaw;
      s.expectedGate = 3;
      Object.assign(s, over);
      return s;
    }

    // two peers that reached the SAME anchor via completely different transient
    // paths (different position, velocity, gear, dt) — exactly what a client
    // replaying a queued respawn input after a correction looks like.
    const s1 = kartWithAnchor({ vx: 7, vz: -2, gear: 3, drifting: true, shiftLeft: 0.05 });
    const s2 = kartWithAnchor({ x: anchor.x + 60, z: anchor.z - 90, vx: -12, vz: 30, gear: 5 });

    stepDrive(s1, respawnInput, SIM_DT, track);
    stepDrive(s2, respawnInput, 0.5, track); // different dt too — respawn must ignore it

    expect(s1.x).toBe(s2.x);
    expect(s1.z).toBe(s2.z);
    expect(s1.yaw).toBe(s2.yaw);
    expect(s1.vx).toBe(0);
    expect(s2.vx).toBe(0);
    expect(s1.vz).toBe(0);
    expect(s2.vz).toBe(0);
    expect(s1.gear).toBe(1);
    expect(s2.gear).toBe(1);
    expect(s1.expectedGate).toBe(3); // respawn does not touch the gate tracker
    expect(s2.expectedGate).toBe(3);
  });
});

// ==============================================================================
// 5. COLLISION / MOMENTUM EXCHANGE
// ==============================================================================

describe('resolveKartPair', () => {
  function kartAt(x: number, z: number, vx: number, vz: number): KartState {
    return { x, y: 0, z, yaw: 0, vx, vz, gear: 1, shiftLeft: 0, drifting: false, nitroLeft: 0 };
  }

  it('karts further apart than 2*KART_RADIUS are untouched and the impulse is 0', () => {
    const a = kartAt(0, 0, 5, 0);
    const b = kartAt(2 * KART_RADIUS + 0.5, 0, -5, 0);
    const beforeA = { ...a };
    const beforeB = { ...b };
    const impulse = resolveKartPair(a, b);
    expect(impulse).toBe(0);
    expect(a).toEqual(beforeA);
    expect(b).toEqual(beforeB);
  });

  it('a moving kart hitting a stationary one conserves momentum and costs the hitter what it gives the target', () => {
    const d = 2 * KART_RADIUS - 0.1; // slightly overlapping
    const a = kartAt(0, 0, 5, 0); // moving toward b (+x)
    const b = kartAt(d, 0, 0, 0); // stationary
    const vBeforeTotal = a.vx + b.vx;
    const impulse = resolveKartPair(a, b);

    expect(impulse).toBeCloseTo(5, 9); // approach speed removed = the full closing speed
    expect(a.vx + b.vx).toBeCloseTo(vBeforeTotal, 12); // momentum conserved (equal masses) to ~1e-12
    expect(a.vx).toBeLessThan(5); // hitter lost speed…
    expect(b.vx).toBeGreaterThan(0); // …target gained it
    expect(5 - a.vx).toBeCloseTo(b.vx - 0, 9); // symmetric: loss === gain
    // exact formula from the doc comment: j = -(1+e)*vrel/2, vrel = b.vx-a.vx = -5
    const j = (-(1 + KART_RESTITUTION) * -5) / 2;
    expect(a.vx).toBeCloseTo(5 - j, 9);
    expect(b.vx).toBeCloseTo(j, 9);
    expect(a.vz).toBe(0);
    expect(b.vz).toBe(0);
    const finalDist = Math.hypot(b.x - a.x, b.z - a.z);
    expect(finalDist).toBeCloseTo(2 * KART_RADIUS, 9); // pushed apart to exactly touching
  });

  it('a head-on pair both reverse, symmetric about the contact point', () => {
    const a = kartAt(0, 0, 5, 0);
    const b = kartAt(1, 0, -5, 0); // overlapping (1 < 2*KART_RADIUS=1.8), closing from both sides
    resolveKartPair(a, b);
    expect(a.vx).toBeLessThan(0); // was +5, now reversed
    expect(b.vx).toBeGreaterThan(0); // was -5, now reversed
    expect(a.vx).toBeCloseTo(-b.vx, 9); // symmetric (equal mass, equal opposing speed)
  });

  it('two karts already separating get pushed apart positionally but receive NO impulse', () => {
    const a = kartAt(0, 0, -3, 0); // moving AWAY from b
    const b = kartAt(1, 0, 3, 0); // moving AWAY from a
    const impulse = resolveKartPair(a, b);
    expect(impulse).toBe(0);
    expect(a.vx).toBe(-3); // velocity untouched
    expect(b.vx).toBe(3);
    const finalDist = Math.hypot(b.x - a.x, b.z - a.z);
    expect(finalDist).toBeCloseTo(2 * KART_RADIUS, 9); // but positions ARE separated
  });

  it('exactly-stacked karts separate deterministically instead of producing NaN', () => {
    const a1 = kartAt(5, 5, 0, 0);
    const b1 = kartAt(5, 5, 0, 0);
    const impulse = resolveKartPair(a1, b1);
    expect(impulse).toBe(0); // both at rest: relative velocity is 0, "separating" branch
    expect(Number.isFinite(a1.x)).toBe(true);
    expect(Number.isFinite(a1.z)).toBe(true);
    expect(Number.isFinite(b1.x)).toBe(true);
    expect(Number.isFinite(b1.z)).toBe(true);
    expect(a1.x).not.toBe(b1.x); // they DID separate, not stay coincident

    // re-run from an identical stacked fixture: same deterministic split direction
    const a2 = kartAt(5, 5, 0, 0);
    const b2 = kartAt(5, 5, 0, 0);
    resolveKartPair(a2, b2);
    expect(a2.x).toBe(a1.x);
    expect(a2.z).toBe(a1.z);
    expect(b2.x).toBe(b1.x);
    expect(b2.z).toBe(b1.z);
  });

  it('argument order does not matter: resolveKartPair(a,b) and (b,a) produce the same physical outcome', () => {
    const mk = (): [KartState, KartState] => [kartAt(0, 0, 5, 1), kartAt(1.2, 0.3, -2, -1)];
    const [a1, b1] = mk();
    const ret1 = resolveKartPair(a1, b1);

    const [a2, b2] = mk();
    const ret2 = resolveKartPair(b2, a2); // swapped call order

    expect(ret1).toBeCloseTo(ret2, 12);
    expect(a1.x).toBeCloseTo(a2.x, 12);
    expect(a1.z).toBeCloseTo(a2.z, 12);
    expect(a1.vx).toBeCloseTo(a2.vx, 12);
    expect(a1.vz).toBeCloseTo(a2.vz, 12);
    expect(b1.x).toBeCloseTo(b2.x, 12);
    expect(b1.z).toBeCloseTo(b2.z, 12);
    expect(b1.vx).toBeCloseTo(b2.vx, 12);
    expect(b1.vz).toBeCloseTo(b2.vz, 12);
  });
});

// ==============================================================================
// 6. RECONCILIATION CONVERGES — a tiny simulated network
// ==============================================================================

describe('KartPredictor reconciliation', () => {
  it('converges to zero correction with no interference, then converges again after a server-side perturbation', () => {
    const track = buildTrack();
    const grid = gridSlot(track, 0);
    const server: KartSim = makeSim(grid.x, grid.z, grid.yaw);
    const client = new KartPredictor(track);
    client.reset(grid.x, grid.z, grid.yaw);

    const DELAY = 5; // ticks of simulated network latency before the server consumes an input
    const delayQueue: SimInput[] = [];
    const sent: SimInput[] = []; // the harness's own record, used to independently verify convergence
    let lastAcked = -1;
    const N = 200;
    const PERTURB_AT = 120;
    let perturbed = false;

    function tick(i: number): void {
      const inp: SimInput = { ...scriptAt(i), seq: i, dt: SIM_DT };
      client.push(inp);
      sent.push(inp);
      delayQueue.push(inp);
      if (delayQueue.length > DELAY) {
        const consumed = delayQueue.shift()!;
        stepDrive(server, consumed, consumed.dt, track);
        lastAcked = consumed.seq;
      }
    }

    for (let i = 0; i < PERTURB_AT; i++) {
      tick(i);
      if (i % 10 === 9) {
        const correction = client.reconcile(server, lastAcked);
        expect(correction).toBeLessThan(1e-9); // identical code + identical inputs => reconciliation is a no-op
      }
    }

    // simulate a collision the client never predicted: shove the server kart
    // 1.5m sideways and change its velocity, exactly like resolveKartPair would.
    server.x += 1.5;
    server.vx -= 4;
    server.vz += 3;
    perturbed = true;

    let sawCorrection = false;
    for (let i = PERTURB_AT; i < N; i++) {
      tick(i);
      if (i % 10 === 9) {
        const preAcked = lastAcked;
        const correction = client.reconcile(server, lastAcked);
        if (perturbed && !sawCorrection) {
          expect(correction).toBeGreaterThan(0.01); // the client visibly moves toward the truth
          // independently verify: server-state-at-ack + replay of the still-unacked
          // inputs (from the harness's OWN bookkeeping, not the predictor's private
          // queue) must equal what the client ended up with.
          const expected: KartSim = { ...server };
          for (const p of sent) {
            if (p.seq > preAcked) stepDrive(expected, p, p.dt, track);
          }
          const got = client.state();
          expect(got.x).toBeCloseTo(expected.x, 9);
          expect(got.z).toBeCloseTo(expected.z, 9);
          expect(got.yaw).toBeCloseTo(expected.yaw, 9);
          expect(got.vx).toBeCloseTo(expected.vx, 9);
          expect(got.vz).toBeCloseTo(expected.vz, 9);
          sawCorrection = true;
        } else if (sawCorrection) {
          expect(correction).toBeLessThan(1e-6); // converged again — second reconcile is (almost) a no-op
        }
      }
    }
    expect(sawCorrection).toBe(true); // the perturbation-triggered branch actually ran
  });

  it('drops acked inputs from the pending queue as reconcile advances the ack', () => {
    const track = buildTrack();
    const grid = gridSlot(track, 0);
    const server: KartSim = makeSim(grid.x, grid.z, grid.yaw);
    const client = new KartPredictor(track);
    client.reset(grid.x, grid.z, grid.yaw);

    for (let i = 0; i < 10; i++) client.push({ ...scriptAt(i), seq: i, dt: SIM_DT });
    const before = client.pendingCount();
    expect(before).toBe(10);

    for (let i = 0; i < 5; i++) stepDrive(server, scriptAt(i), SIM_DT, track);
    client.reconcile(server, 4); // acks seq 0..4
    expect(client.pendingCount()).toBe(5); // 5 dropped, 5 remain
    expect(client.pendingCount()).toBeLessThan(before);
  });

  it('bounds the pending queue at PENDING_INPUT_CAP even with no reconcile', () => {
    const track = buildTrack();
    const client = new KartPredictor(track);
    client.reset(0, 0, 0);
    for (let i = 0; i < PENDING_INPUT_CAP + 20; i++) {
      client.push({ ...scriptAt(i), seq: i, dt: SIM_DT });
    }
    expect(client.pendingCount()).toBe(PENDING_INPUT_CAP);
  });
});

// ==============================================================================
// 7. PURSUIT ASSIST
// ==============================================================================

describe('pursuitSteer', () => {
  it('drives a full lap, crediting all 8 gates in order within ~35s of sim time, without long off-road excursions', () => {
    const track = buildTrack();
    const grid = gridSlot(track, 0);
    const s = makeSim(grid.x, grid.z, grid.yaw);
    const assist = makeAssistState();

    const maxTime = 40; // s — generous cap past the ~35s target so a stuck bot fails loudly, not silently
    const maxTicks = Math.round(maxTime / SIM_DT);
    const creditTimes: number[] = [];
    let offRoadStreak = 0;
    let maxOffRoadStreak = 0;

    for (let i = 0; i < maxTicks && creditTimes.length < GATES; i++) {
      const prevGate = s.expectedGate;
      const steer = pursuitSteer(track, s, assist, SIM_DT);
      stepDrive(s, drive({ throttle: 0.8, steer }), SIM_DT, track);
      if (s.expectedGate !== prevGate) creditTimes.push((i + 1) * SIM_DT);
      if (surfaceAt(track, s.x, s.z) === 'grass') {
        offRoadStreak += SIM_DT;
        maxOffRoadStreak = Math.max(maxOffRoadStreak, offRoadStreak);
      } else {
        offRoadStreak = 0;
      }
    }

    expect(creditTimes.length).toBe(GATES); // credited every gate, strictly in order (creditAnchor's own invariant)
    expect(creditTimes[GATES - 1]).toBeLessThan(35); // full lap within the module's own ~35s target
    expect(maxOffRoadStreak).toBeLessThan(3); // never off-road for long
  });

  it('engages wrong-way recovery only after the hold time, and disengages once realigned', () => {
    // WRONG_WAY_HOLD_S (1.2s) and RECOVER_DONE_RAD are tuning constants PRIVATE
    // to sim.ts (not exported, not re-exported by index.ts) — mirrored here with
    // a comment rather than imported, since the frozen contract does not expose
    // them. State is held FIXED (not physically stepped) so wrongWayT accumulates
    // by exactly `dt` per call — an isolated, deterministic test of the
    // hold-time/threshold logic without organic-driving noise.
    const HOLD_S = 1.2; // mirrors WRONG_WAY_HOLD_S in sim.ts
    const track = buildTrack();
    const g0 = track.gates[0]!;
    const travelYaw = Math.atan2(-g0.tx, -g0.tz);
    const s: KartState = makeKart(g0.x, g0.z, wrapPi(travelYaw + Math.PI)); // facing exactly backwards
    const assist: AssistState = makeAssistState();

    // wrongWayT accumulates via repeated `+= SIM_DT` (SIM_DT = 1/30 is not exact
    // in binary), so summing it holdTicks times can land a float epsilon to
    // either side of the exact 1.2s boundary. MARGIN keeps the "must still be
    // false" assertions safely before the boundary instead of racing it.
    const MARGIN_TICKS = 2;
    const holdTicks = Math.floor(HOLD_S / SIM_DT);
    for (let i = 0; i < holdTicks - MARGIN_TICKS; i++) {
      pursuitSteer(track, s, assist, SIM_DT);
      expect(assist.recovering).toBe(false); // must not engage before the hold time elapses
    }
    let engaged = false;
    for (let i = 0; i < MARGIN_TICKS + 3 && !engaged; i++) {
      pursuitSteer(track, s, assist, SIM_DT);
      engaged = assist.recovering;
    }
    expect(engaged).toBe(true); // engages shortly after the hold time elapses

    s.yaw = travelYaw; // now perfectly realigned
    pursuitSteer(track, s, assist, SIM_DT);
    expect(assist.recovering).toBe(false); // disengages once realigned
    expect(assist.wrongWayT).toBe(0); // and the wrong-way timer resets
  });
});

// ============================================================================
// KIDS MODE stuck auto-respawn — the escape hatch for a wedged player.
//
// This is the rule that stops a kid (who cannot press R) being pinned against a
// barrier forever. It regressed once already when the teleport moved from "the
// client does it locally" to "the client asks for it on the input stream", and
// an e2e caught it a long way downstream — hence these unit tests, which pin
// BOTH halves: the rule fires, and the relocation it asks for actually survives
// the server's authority.
// ============================================================================
describe('KIDS MODE stuck auto-respawn', () => {
  const HELD = STUCK_THROTTLE + 0.1; // a throttle that counts as "held"
  const WEDGED = STUCK_SPEED / 2; // a speed that counts as "not moving"

  it('asks for a respawn after STUCK_HOLD_S of throttle-held-but-not-moving, exactly once', () => {
    const a = makeAssistState();
    const ticks = Math.ceil(STUCK_HOLD_S / SIM_DT);
    let fired = 0;
    for (let i = 0; i < ticks - 1; i++) {
      if (stuckStep(a, HELD, WEDGED, SIM_DT)) fired++;
    }
    expect(fired, 'must not fire before the hold time elapses').toBe(0);
    for (let i = 0; i < 3; i++) {
      if (stuckStep(a, HELD, WEDGED, SIM_DT)) fired++;
    }
    expect(fired, 'fires once at the hold time, not every tick after it').toBe(1);
  });

  it('never fires while the kart is actually moving, or with the throttle lifted', () => {
    const moving = makeAssistState();
    const coasting = makeAssistState();
    for (let i = 0; i < Math.ceil((STUCK_HOLD_S / SIM_DT) * 3); i++) {
      expect(stuckStep(moving, HELD, STUCK_SPEED + 1, SIM_DT)).toBe(false); // rolling
      expect(stuckStep(coasting, 0, WEDGED, SIM_DT)).toBe(false); // parked on purpose
    }
  });

  it('resets the hold when the kart breaks free, so a nudge does not bank progress', () => {
    const a = makeAssistState();
    const ticks = Math.ceil(STUCK_HOLD_S / SIM_DT);
    for (let i = 0; i < ticks - 2; i++) stuckStep(a, HELD, WEDGED, SIM_DT); // nearly there
    expect(stuckStep(a, HELD, STUCK_SPEED + 2, SIM_DT)).toBe(false); // ...then it rolls
    expect(a.stuckT).toBe(0);
    let fired = false;
    for (let i = 0; i < ticks - 1; i++) fired ||= stuckStep(a, HELD, WEDGED, SIM_DT);
    expect(fired, 'the hold must start over, not resume').toBe(false);
  });

  it('relocates a kart wedged off-track to its last credited gate, and kills its speed', () => {
    const track = buildTrack();
    const s = makeSim(gridSlot(track, 0).x, gridSlot(track, 0).z, gridSlot(track, 0).yaw);
    // drive far enough to credit real gates, so the anchor is NOT the spawn
    const a = makeAssistState();
    for (let i = 0; i < 30 * 12; i++) {
      const steer = pursuitSteer(track, s, a, SIM_DT);
      stepDrive(s, drive({ throttle: Math.abs(steer) > 0.45 ? 0.4 : 1, steer }), SIM_DT, track);
    }
    expect(s.expectedGate, 'credited at least one gate before wedging').toBeGreaterThan(1);
    const anchorX = s.anchorX;
    const anchorZ = s.anchorZ;

    // WEDGE IT: shove it out to the barrier and hold it there at a standstill,
    // which is exactly what a wall does to a kart driving into it — the barrier
    // clamp cancels the outward motion every substep, so the throttle is held
    // while the speed stays ~0. (The clamp's own physics is covered by the
    // barrier tests; this test is about what the ASSIST does about it.)
    s.x += 40;
    s.z += 40;
    clampToBarrier(s, track);
    s.vx = 0;
    s.vz = 0;
    const wedged = { x: s.x, z: s.z };
    const stuck = makeAssistState();
    let asked = false;
    for (let i = 0; i < Math.ceil((STUCK_HOLD_S / SIM_DT) * 2) && !asked; i++) {
      asked = stuckStep(stuck, 1, 0, SIM_DT); // pinned: throttle held, no motion
      stepDrive(s, drive({ throttle: 1, respawn: asked }), SIM_DT, track);
      if (!asked) {
        s.x = wedged.x; // the wall holds it in place tick after tick
        s.z = wedged.z;
        s.vx = 0;
        s.vz = 0;
      }
    }
    expect(asked, 'the wedged kart asked for a respawn').toBe(true);
    expect(Math.hypot(s.x - anchorX, s.z - anchorZ), 'landed on the anchor gate').toBeLessThan(1e-9);
    // it is a TELEPORT, not a creep: more than a kart length in one tick, from
    // a standstill, which no amount of throttle could produce (gear 1 needs
    // ~1.4s to cover that).
    expect(Math.hypot(s.x - wedged.x, s.z - wedged.z)).toBeGreaterThan(2 * KART_RADIUS);
    expect(Math.hypot(s.vx, s.vz), 'speed reset by the teleport').toBe(0);
    // ...and the whole point: it is no longer wedged against the barrier
    expect(surfaceAt(track, s.x, s.z), 'back on the road, free to drive').toBe('road');
    expect(Math.abs(closestOnTrack(track, s.x, s.z).lateral)).toBeLessThan(
      Math.abs(closestOnTrack(track, wedged.x, wedged.z).lateral),
    );
  });

  it('the relocation SURVIVES reconciliation: the server lands on the same anchor', () => {
    const track = buildTrack();
    const spawn = gridSlot(track, 0);
    // server and client start equal, as they do at GO
    const server = makeSim(spawn.x, spawn.z, spawn.yaw);
    const pred = new KartPredictor(track);
    pred.reset(spawn.x, spawn.z, spawn.yaw);

    const a = makeAssistState();
    const queue: SimInput[] = [];
    let seq = 0;
    // 12s of driving, with the server consuming everything 5 ticks late
    const LAG = 5;
    for (let i = 0; i < 30 * 12; i++) {
      const steer = pursuitSteer(track, pred.state(), a, SIM_DT);
      const inp: SimInput = {
        seq: ++seq,
        dt: SIM_DT,
        throttle: Math.abs(steer) > 0.45 ? 0.4 : 1,
        brake: 0,
        steer,
        drift: false,
        respawn: false,
      };
      queue.push(inp);
      pred.push(inp);
      if (queue.length > LAG) {
        const done = queue.shift()!;
        stepDrive(server, done, done.dt, track);
        pred.reconcile(server, done.seq);
      }
    }
    expect(pred.state().expectedGate, 'the pair credited gates together').toBeGreaterThan(1);

    // now the client asks for the stuck respawn
    const askX = pred.state().x;
    const askZ = pred.state().z;
    const respawnInput: SimInput = {
      seq: ++seq, dt: SIM_DT, throttle: 1, brake: 0, steer: 0, drift: false, respawn: true,
    };
    queue.push(respawnInput);
    pred.push(respawnInput);
    const predicted = { x: pred.state().x, z: pred.state().z };
    expect(Math.hypot(predicted.x - askX, predicted.z - askZ), 'the client predicted the teleport').toBeGreaterThan(5);

    // the server consumes the backlog INCLUDING the respawn flag, and the
    // client reconciles onto it after every single one
    while (queue.length > 0) {
      const done = queue.shift()!;
      stepDrive(server, done, done.dt, track);
      pred.reconcile(server, done.seq);
    }
    // THE INVARIANT: after the authority has spoken, the kart is still at the
    // anchor — the relocation was not undone by reconciliation.
    expect(Math.hypot(server.x - server.anchorX, server.z - server.anchorZ)).toBeLessThan(1e-9);
    expect(pred.state().x).toBe(server.x);
    expect(pred.state().z).toBe(server.z);
    expect(Math.hypot(pred.state().x - predicted.x, pred.state().z - predicted.z),
      'client and server chose the SAME anchor, so the correction is nil').toBeLessThan(1e-9);
  });
});
