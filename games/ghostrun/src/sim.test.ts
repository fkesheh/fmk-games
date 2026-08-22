// ============================================================================
// SIM TESTS — the movement law + recording contract (specs/P11.md):
// jump arc, coyote time, air control 0.6, fall → respawn +1s penalty,
// strict 100 ms [t,x,y,z,yaw] sampling, ghost interpolation.
// ============================================================================

import { describe, expect, it } from 'vitest';
import {
  PHYS,
  createSim,
  drainEvents,
  finalTimeMs,
  quantizeSamples,
  sampleGhost,
  step,
} from './sim.js';
import type { SimInput } from './sim.js';
import { buildTrack } from './track.js';

const TRACK = buildTrack('2026-08-21');
const DT = 1 / 60;
const IDLE: SimInput = { mx: 0, mz: 0, jump: false };

function run(st: ReturnType<typeof createSim>, seconds: number, input: SimInput = IDLE): void {
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++) step(st, input, DT);
}

describe('jump arc', () => {
  it('launches at v=8.5 and lands after ≈2v/g with apex v²/2g', () => {
    const st = createSim(TRACK);
    step(st, { mx: 0, mz: 0, jump: true }, DT); // press (one gravity step may apply)
    expect(st.vel.y).toBeLessThanOrEqual(PHYS.jumpVel);
    expect(st.vel.y).toBeGreaterThan(PHYS.jumpVel * 0.95);

    // integrate until grounded again
    let peak = st.pos.y;
    let t = 0;
    for (let i = 0; i < 120 && (i < 5 || !st.onGround); i++) {
      step(st, IDLE, DT);
      peak = Math.max(peak, st.pos.y);
      t += DT;
    }
    const expectedApex = (PHYS.jumpVel * PHYS.jumpVel) / (2 * -PHYS.gravity);
    expect(peak).toBeGreaterThan(expectedApex * 0.9);
    expect(t).toBeGreaterThan(0.6);
    expect(st.onGround).toBe(true);
  });

  it('requires a fresh press — no pogo while holding', () => {
    const st = createSim(TRACK);
    let jumps = 0;
    for (let i = 0; i < 120; i++) {
      // 2s of HELD jump: one launch, then land and stay landed
      step(st, { mx: 0, mz: 0, jump: true }, DT);
      jumps += drainEvents(st).filter((e) => e.kind === 'jump').length;
    }
    expect(jumps).toBe(1);
    expect(st.onGround).toBe(true);
    expect(st.pos.y).toBeCloseTo(TRACK.startPos.y, 3);
  });
});

describe('coyote time', () => {
  function walkOffEdge(st: ReturnType<typeof createSim>): void {
    // run straight ahead off the start pad (edge ≈ 3.6u out at full speed)
    let guard = 0;
    while (st.onGround && guard++ < 300) step(st, { mx: 0, mz: 1, jump: false }, DT);
    expect(st.onGround).toBe(false);
  }

  it('allows a jump within 0.12s of walking off an edge', () => {
    const st = createSim(TRACK);
    walkOffEdge(st);
    step(st, { mx: 0, mz: 1, jump: true }, DT); // pressed immediately after leaving
    const events = drainEvents(st);
    expect(events.some((e) => e.kind === 'jump')).toBe(true);
    expect(st.vel.y).toBeGreaterThan(PHYS.jumpVel * 0.9);
  });

  it('denies a jump once coyote has expired (>0.12s airborne)', () => {
    const st = createSim(TRACK);
    walkOffEdge(st);
    run(st, 0.13, { mx: 0, mz: 1, jump: false }); // past the grace window
    expect(st.coyote).toBe(0);
    step(st, { mx: 0, mz: 1, jump: true }, DT);
    step(st, { mx: 0, mz: 1, jump: false }, DT);
    const events = drainEvents(st);
    expect(events.some((e) => e.kind === 'jump')).toBe(false);
    expect(st.vel.y).toBeLessThan(PHYS.jumpVel * 0.5); // gravity only
  });
});

describe('air control 0.6', () => {
  it('accelerates horizontally 60% as hard mid-air as on the ground', () => {
    const ground = createSim(TRACK);
    const air = createSim(TRACK);
    step(air, { mx: 0, mz: 0, jump: true }, DT); // pure vertical hop
    run(air, 0.05, IDLE);
    expect(air.onGround).toBe(false);
    expect(ground.onGround).toBe(true);

    // both accelerate toward cruise from rest over the same 0.1s window
    const n = Math.round(0.1 / DT);
    for (let i = 0; i < n; i++) step(ground, { mx: 0, mz: 1, jump: false }, DT);
    const dGround = Math.hypot(ground.vel.x, ground.vel.z);
    for (let i = 0; i < n; i++) step(air, { mx: 0, mz: 1, jump: false }, DT);
    const dAir = Math.hypot(air.vel.x, air.vel.z);

    expect(dGround).toBeGreaterThan(4); // ground accel 60/s² → ~6 u/s in 0.1s
    const ratio = dAir / dGround;
    expect(ratio).toBeGreaterThan(PHYS.airControl - 0.12);
    expect(ratio).toBeLessThan(PHYS.airControl + 0.12);
  });

  it('caps horizontal speed at the run speed', () => {
    const st = createSim(TRACK);
    run(st, 2, { mx: 0, mz: 1, jump: false });
    expect(Math.hypot(st.vel.x, st.vel.z)).toBeLessThanOrEqual(PHYS.runSpeed + 0.01);
  });
});

describe('fall penalty + respawn', () => {
  it('respawns at the last checkpoint and adds exactly +1000ms to the final time', () => {
    const st = createSim(TRACK);
    // teleport into the void below checkpoint 0
    st.pos.y = TRACK.checkpoints[0]!.pos.y - PHYS.fallLimit - 1;
    st.vel.y = -5;
    const clockBefore = st.timeMs;
    step(st, IDLE, DT);
    const events = drainEvents(st);
    expect(events.some((e) => e.kind === 'respawn')).toBe(true);
    expect(st.pos.x).toBeCloseTo(TRACK.checkpoints[0]!.pos.x, 5);
    expect(st.penaltyMs).toBe(PHYS.penaltyMs);
    expect(st.timeMs - clockBefore).toBeLessThan(50); // clock itself keeps rolling
    expect(finalTimeMs(st)).toBe(st.timeMs + 1000);
  });

  it('a second fall stacks to +2000ms', () => {
    const st = createSim(TRACK);
    st.pos.y = TRACK.checkpoints[0]!.pos.y - PHYS.fallLimit - 1;
    step(st, IDLE, DT);
    st.pos.y -= PHYS.fallLimit;
    step(st, IDLE, DT);
    expect(st.penaltyMs).toBe(2000);
  });
});

describe('finish line', () => {
  it('standing on the finish pad ends the run', () => {
    const st = createSim(TRACK);
    const finish = TRACK.platforms[TRACK.platforms.length - 1]!;
    st.pos.x = finish.cx;
    st.pos.z = finish.cz;
    st.pos.y = Math.max(finish.y0, finish.y1) + 0.5; // drop onto it
    let finished = false;
    for (let i = 0; i < 60 && !finished; i++) {
      step(st, IDLE, DT);
      finished = st.finished;
    }
    expect(finished).toBe(true);
    expect(drainEvents(st).some((e) => e.kind === 'finish')).toBe(true);
    // frozen world: stepping after finish changes nothing
    const frozenTime = st.timeMs;
    step(st, { mx: 0, mz: 1, jump: true }, DT);
    expect(st.timeMs).toBe(frozenTime);
  });
});

describe('recording cadence', () => {
  it('samples [t,x,y,z,yaw] every 100ms into growable arrays', () => {
    const st = createSim(TRACK);
    run(st, 2.0, { mx: 0, mz: 1, jump: false });
    const s = st.samples;
    expect(s.t.length).toBe(21); // t=0..2000 inclusive
    expect(s.x.length).toBe(s.t.length);
    expect(s.y.length).toBe(s.t.length);
    expect(s.z.length).toBe(s.t.length);
    expect(s.yaw.length).toBe(s.t.length);
    for (let i = 0; i < s.t.length; i++) {
      expect(s.t[i]).toBeCloseTo(i * 100, 6);
      expect(Number.isFinite(s.x[i]!)).toBe(true);
    }
    // strictly increasing timestamps at exact cadence
    for (let i = 1; i < s.t.length; i++) {
      expect(s.t[i]! - s.t[i - 1]!).toBeCloseTo(100, 6);
    }
  });

  it('keeps recording through respawns (the ghost shows the truth)', () => {
    const st = createSim(TRACK);
    st.pos.y = TRACK.checkpoints[0]!.pos.y - PHYS.fallLimit - 1;
    run(st, 0.5, IDLE);
    expect(st.samples.t.length).toBeGreaterThan(5);
  });

  it('quantizeSamples rounds to 2 decimals without changing length', () => {
    const st = createSim(TRACK);
    run(st, 0.4, { mx: 0, mz: 1, jump: false });
    const q = quantizeSamples(st.samples);
    expect(q.t.length).toBe(st.samples.t.length);
    q.x.forEach((v) => expect(Math.abs(v * 100 - Math.round(v * 100))).toBeLessThan(1e-9));
  });
});

describe('ghost interpolation', () => {
  it('lerps position between samples and clamps past the ends', () => {
    const samples = { t: [0, 100, 200], x: [0, 10, 20], y: [5, 5, 5], z: [0, 0, 0], yaw: [0, 1, 2] };
    const mid = sampleGhost(samples, 150)!;
    expect(mid.x).toBeCloseTo(15, 9);
    expect(mid.y).toBeCloseTo(5, 9);
    expect(sampleGhost(samples, -50)!.x).toBe(0);
    expect(sampleGhost(samples, 9999)!.x).toBe(20);
    expect(sampleGhost({ t: [], x: [], y: [], z: [], yaw: [] }, 0)).toBeNull();
  });

  it('interpolates yaw along the shortest arc', () => {
    const samples = { t: [0, 100], x: [0, 0], y: [0, 0], z: [0, 0], yaw: [3.0, -3.0] };
    const half = sampleGhost(samples, 50)!;
    // shortest path 3.0 → −3.0 passes through ±π, not through 0
    expect(Math.abs(half.yaw)).toBeGreaterThan(Math.PI - 0.01);
  });
});
