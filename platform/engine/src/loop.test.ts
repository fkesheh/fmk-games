// ============================================================================
// LOOP TESTS — deterministic virtual clock (docs/PLATFORM.md §4.6 / P5.md).
// Owner: P5_ENGINE.
//
// The fake rAF + virtual clock make every frame deterministic: `clock.frame()`
// fires exactly one rAF beat at a caller-chosen step, so tick cadence, alpha,
// catch-up clamping, stop semantics and throw accounting are asserted exactly —
// no timers, no flakiness. Pool recycling-bounds tests round out the engine's
// CPU-only surface (SceneRig needs WebGL and is excluded by design).
//
// Arithmetic notes (the Loop's contract, mirrored here):
//  - a frame contributes min(rawDt, 0.25s) to the accumulator;
//  - each step consumes 1/tickHz seconds, at most maxCatchUp steps per frame;
//  - hitting the step cap SNAPS the remainder away (spiral-of-death guard), so
//    assertions below compute owed steps from those exact rules.
// ============================================================================

import * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Loop } from './loop.js';
import { ParticlePool, TracerPool } from './pools.js';

/** Tracer lifetime in seconds (mirrors pools.ts spec: 60ms fading line). */
const TRACER_LIFE_S = 0.06;

/** One queued rAF callback. */
type FrameCb = (nowMs: number) => void;

/**
 * Deterministic rAF + clock. The Loop keeps AT MOST one callback queued at a
 * time, so `frame()` pops-and-fires that single beat; `tryFrame()` is the
 * stale-frame-safe variant used after stop(), where an empty queue is itself
 * the assertion (a halted loop schedules nothing).
 */
class VirtualClock {
  nowMs = 0;
  private pending: FrameCb[] = [];

  /** Injected into Loop as its frame source. */
  readonly raf = (cb: FrameCb): void => {
    this.pending.push(cb);
  };

  hasPending(): boolean {
    return this.pending.length > 0;
  }

  /** Fire one rAF beat after advancing the virtual clock by stepMs. */
  frame(stepMs: number): void {
    const cb = this.pending.shift();
    if (cb === undefined) throw new Error('VirtualClock.frame(): no pending rAF callback');
    this.nowMs += stepMs;
    cb(this.nowMs);
  }

  /** Fire a beat only if one is pending; false once the loop stopped scheduling. */
  tryFrame(stepMs: number): boolean {
    if (this.pending.length === 0) return false;
    this.frame(stepMs);
    return true;
  }
}

interface Recorder {
  ticks: Array<{ dt: number; tick: number }>;
  renders: Array<{ dtFrame: number; alpha: number; nowMs: number }>;
}

function recordingLoop(
  clock: VirtualClock,
  opts?: { tickHz?: number; maxCatchUp?: number },
): { loop: Loop; rec: Recorder } {
  const rec: Recorder = { ticks: [], renders: [] };
  const loop = new Loop(
    {
      ...(opts?.tickHz !== undefined ? { tickHz: opts.tickHz } : {}),
      ...(opts?.maxCatchUp !== undefined ? { maxCatchUp: opts.maxCatchUp } : {}),
      onTick: (dt, tick) => rec.ticks.push({ dt, tick }),
      onRender: (dtFrame, alpha, nowMs) => rec.renders.push({ dtFrame, alpha, nowMs }),
    },
    clock.raf,
    () => clock.nowMs,
  );
  return { loop, rec };
}

describe('Loop — fixed-step cadence', () => {
  it('fires N ticks at the right cadence and passes constant dt = 1/tickHz', () => {
    const clock = new VirtualClock();
    const { loop, rec } = recordingLoop(clock, { tickHz: 10 }); // step = 100ms
    loop.start();

    // 20 frames x 50ms = 1000ms of accumulated time -> exactly 10 ticks.
    for (let i = 0; i < 20; i++) clock.frame(50);

    expect(rec.ticks.map((t) => t.tick)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    for (const t of rec.ticks) expect(t.dt).toBe(0.1); // constant dt, never the frame time
    expect(loop.tickCount).toBe(10);
    expect(loop.running).toBe(true);
    expect(clock.hasPending()).toBe(true); // still scheduling while running
    loop.stop();
  });

  it('defaults to 30Hz when tickHz is omitted', () => {
    const clock = new VirtualClock();
    const { loop, rec } = recordingLoop(clock);
    loop.start();

    // 30 frames x 25ms = 750ms; floor(750 / 33.333…) = 22 ticks.
    for (let i = 0; i < 30; i++) clock.frame(25);

    expect(rec.ticks).toHaveLength(22);
    expect(rec.ticks[0]!.dt).toBeCloseTo(1 / 30, 12);
    loop.stop();
  });

  it('renders exactly once per frame (not per tick)', () => {
    const clock = new VirtualClock();
    const { loop, rec } = recordingLoop(clock, { tickHz: 10 });
    loop.start();

    clock.frame(16); // start() anchored the clock, so even frame 1 measures real time
    clock.frame(16);
    clock.frame(250); // big frame, several ticks inside, ONE render call

    expect(rec.renders).toHaveLength(3);
    expect(rec.renders[0]!.dtFrame).toBeCloseTo(0.016, 9);
    expect(rec.renders[1]!.dtFrame).toBeCloseTo(0.016, 9);
    expect(rec.renders[2]!.dtFrame).toBeCloseTo(0.25, 9);
    // 282ms accumulated -> 2 whole 100ms steps consumed so far.
    expect(rec.ticks).toHaveLength(2);
    loop.stop();
  });
});

describe('Loop — alpha interpolation fraction', () => {
  it('alpha is the fractional progress between ticks', () => {
    const clock = new VirtualClock();
    const { loop, rec } = recordingLoop(clock, { tickHz: 4 }); // step = 250ms
    loop.start();

    clock.frame(100); // acc 100ms -> no tick, alpha 0.4
    clock.frame(100); // acc 200ms -> no tick, alpha 0.8
    clock.frame(100); // acc 300ms -> 1 tick consumed, acc 50ms, alpha 0.2

    expect(rec.renders[0]!.alpha).toBeCloseTo(0.4, 12);
    expect(rec.renders[1]!.alpha).toBeCloseTo(0.8, 12);
    expect(rec.renders[2]!.alpha).toBeCloseTo(0.2, 12);
    expect(rec.ticks).toHaveLength(1);
    loop.stop();
  });

  it('alpha approaches 1 across a full interval and resets to 0 right after a tick', () => {
    const clock = new VirtualClock();
    const { loop, rec } = recordingLoop(clock, { tickHz: 5 }); // step = 200ms
    loop.start();

    clock.frame(199); // alpha 199/200
    clock.frame(1); // crosses the boundary: tick fires, accumulator empty

    expect(rec.renders[0]!.alpha).toBeCloseTo(0.995, 9);
    expect(rec.renders[1]!.alpha).toBe(0);
    expect(rec.ticks).toHaveLength(1);
    loop.stop();
  });

  it('alpha never exceeds 1, and is 0 after a snapped frame', () => {
    const clock = new VirtualClock();
    const { loop, rec } = recordingLoop(clock, { tickHz: 10, maxCatchUp: 2 });
    loop.start();

    clock.frame(5000); // clamped to 0.25s input -> 2 steps hit the cap -> snap
    for (const r of rec.renders) expect(r.alpha).toBeLessThanOrEqual(1);
    expect(rec.renders[rec.renders.length - 1]!.alpha).toBe(0);
    loop.stop();
  });
});

describe('Loop — catch-up clamp (spiral-of-death guard)', () => {
  it('a huge frame runs at most maxCatchUp ticks and SNAPS the remainder away', () => {
    const clock = new VirtualClock();
    // 0.25s clamped input at a 25ms step owes 10 steps; cap is 5.
    const { loop, rec } = recordingLoop(clock, { tickHz: 40, maxCatchUp: 5 });
    loop.start();

    clock.frame(1000);
    expect(rec.ticks).toHaveLength(5);

    // The snapped remainder is GONE, not carried as debt: this fresh 24ms frame
    // earns zero ticks (24ms < 25ms step) instead of paying off a backlog.
    const before = rec.ticks.length;
    clock.frame(24);
    expect(rec.ticks.length).toBe(before);
    loop.stop();
  });

  it('total ticks stay bounded across many slow frames', () => {
    const clock = new VirtualClock();
    const { loop, rec } = recordingLoop(clock, { tickHz: 60, maxCatchUp: 5 });
    loop.start();

    for (let i = 0; i < 50; i++) clock.frame(1000); // "lagging tab": 50 x 0.25s clamped
    // Every slow frame caps out: 15 steps owed, 5 run, remainder snapped.
    expect(rec.ticks).toHaveLength(50 * 5);
    expect(loop.running).toBe(true); // clamping, not dying — the game catches up
    loop.stop();
  });

  it('clamps dtFrame passed to onRender at 0.25s', () => {
    const clock = new VirtualClock();
    const { loop, rec } = recordingLoop(clock, { tickHz: 30, maxCatchUp: 1000 });
    loop.start();

    clock.frame(5000); // 5 real seconds elapse…
    expect(rec.renders[0]!.dtFrame).toBe(0.25); // …but render sees the clamp
    loop.stop();
  });

  it('default maxCatchUp is 5', () => {
    const clock = new VirtualClock();
    const { loop, rec } = recordingLoop(clock, { tickHz: 30 }); // step ≈ 33.3ms
    loop.start();

    clock.frame(60000); // 0.25s clamped -> floor(250/33.33) = 7 owed -> 5 run
    expect(rec.ticks).toHaveLength(5);
    loop.stop();
  });

  it('normal frames never trigger the clamp (full-rate sim keeps up exactly)', () => {
    const clock = new VirtualClock();
    const { loop, rec } = recordingLoop(clock, { tickHz: 10, maxCatchUp: 2 });
    loop.start();

    for (let i = 0; i < 40; i++) clock.frame(20); // 800ms -> 8 ticks, 2/frame budget unused
    expect(rec.ticks).toHaveLength(8);
    expect(loop.tickCount).toBe(8);
    loop.stop();
  });
});

describe('Loop — start/stop lifecycle', () => {
  it('stop() halts immediately: the stale queued beat fires as a no-op, nothing reschedules', () => {
    const clock = new VirtualClock();
    const { loop, rec } = recordingLoop(clock, { tickHz: 10 });
    loop.start();
    clock.frame(150); // 1 tick, 1 render; next beat now queued
    loop.stop();

    expect(loop.running).toBe(false);
    expect(clock.hasPending()).toBe(true); // a beat was already queued pre-stop

    expect(clock.tryFrame(1000)).toBe(true); // stale beat fires…
    expect(rec.ticks).toHaveLength(1); // …and does nothing
    expect(rec.renders).toHaveLength(1);
    expect(clock.hasPending()).toBe(false); // and nothing rescheduled
    expect(clock.tryFrame(1000)).toBe(false); // fully halted
  });

  it('start() resets tickCount and restarts numbering at 0', () => {
    const clock = new VirtualClock();
    const { loop, rec } = recordingLoop(clock, { tickHz: 10 });
    loop.start();
    for (let i = 0; i < 5; i++) clock.frame(100);
    expect(loop.tickCount).toBe(5);
    loop.stop();

    loop.start();
    expect(loop.tickCount).toBe(0);
    clock.frame(100);
    expect(loop.tickCount).toBe(1);
    expect(rec.ticks[rec.ticks.length - 1]!.tick).toBe(0); // numbering restarted
    loop.stop();
  });

  it('start() while running is a no-op (no double-scheduling)', () => {
    const clock = new VirtualClock();
    const { loop, rec } = recordingLoop(clock, { tickHz: 10 });
    loop.start();
    loop.start(); // second start must not fork the loop
    clock.frame(100);
    expect(rec.ticks).toHaveLength(1);
    expect(rec.renders).toHaveLength(1); // one render per frame, not two
    loop.stop();
  });
});

describe('Loop — throw accounting', () => {
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    consoleError.mockRestore();
  });

  it('stops after 3 consecutive throws, logging exactly once', () => {
    const clock = new VirtualClock();
    let calls = 0;
    const loop = new Loop(
      {
        onTick: () => {
          calls++;
          throw new Error('boom');
        },
        onRender: () => {},
      },
      clock.raf,
      () => clock.nowMs,
    );
    loop.start();

    // One frame is enough: three ticks throw consecutively -> stop inside it.
    clock.frame(1000);
    expect(calls).toBe(3);
    expect(loop.running).toBe(false);
    expect(consoleError).toHaveBeenCalledTimes(1);

    expect(clock.tryFrame(1000)).toBe(false); // halted — nothing left to fire
    expect(calls).toBe(3);
    expect(consoleError).toHaveBeenCalledTimes(1); // never spams the console
  });

  it('a successful callback resets the streak — intermittent throws never stop the loop', () => {
    const clock = new VirtualClock();
    let thrown = 0;
    const loop = new Loop(
      {
        onTick: (_dt, tick) => {
          if (tick % 2 === 0) throw new Error('intermittent'); // every OTHER tick throws
          thrown++;
        },
        onRender: () => {},
      },
      clock.raf,
      () => clock.nowMs,
    );
    loop.start();

    for (let i = 0; i < 40; i++) clock.frame(50); // many alternating throw/success cycles
    expect(thrown).toBeGreaterThan(0); // throws really happened…
    expect(loop.running).toBe(true); // …but never two consecutively -> keeps running
    expect(consoleError).not.toHaveBeenCalled();
    loop.stop();
  });

  it('counts a throwing onRender the same way: 3 consecutive throwing frames stop it', () => {
    const clock = new VirtualClock();
    const loop = new Loop(
      {
        tickHz: 1, // 1s step vs 0.25s-clamped frames -> no tick can EVER fire,
        // so the render throws stay strictly consecutive
        onTick: () => {},
        onRender: () => {
          throw new Error('render boom');
        },
      },
      clock.raf,
      () => clock.nowMs,
    );
    loop.start();

    clock.frame(100); // render throw #1 — loop survives
    expect(loop.running).toBe(true);
    clock.frame(100); // throw #2
    expect(loop.running).toBe(true);
    clock.frame(100); // throw #3 -> stop + log once
    expect(loop.running).toBe(false);
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(clock.hasPending()).toBe(false);
  });
});

describe('Pools — recycling bounds', () => {
  it('ParticlePool live count never exceeds capacity and drains to zero', () => {
    const scene = new THREE.Scene();
    const pool = new ParticlePool(scene, { particles: 4 });
    expect(pool.capacity).toBe(4);

    pool.burst({ x: 0, y: 1, z: 0, count: 3, color: '#ff0000', lifeSec: 1 });
    pool.update(0.01);
    expect(pool.live).toBe(3);

    pool.burst({ x: 0, y: 1, z: 0, count: 5, color: '#00ff00', lifeSec: 1 }); // overflows
    pool.update(0.01);
    expect(pool.live).toBe(4); // hard bound: oldest slots recycled, never grown

    for (let i = 0; i < 120; i++) pool.update(0.01); // outlive every lifetime (1s)
    expect(pool.live).toBe(0);

    pool.dispose();
  });

  it('TracerPool spawns recycle oldest slots and fade within their lifetime', () => {
    const scene = new THREE.Scene();
    const pool = new TracerPool(scene, { tracers: 2 });
    expect(pool.capacity).toBe(2);

    pool.spawn({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, '#ffff00');
    pool.spawn({ x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, '#00ffff');
    expect(pool.live).toBe(2);

    pool.spawn({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, '#ff00ff'); // overwrites slot 0
    expect(pool.live).toBe(2); // hard bound holds

    pool.update(TRACER_LIFE_S + 0.001);
    expect(pool.live).toBe(0);

    pool.dispose();
  });
});
