// ============================================================================
// ANCIENTS (rift) — interp tests (T8). The ghost/reappear rules of CONTRACT §6
// and handoff §2.4, plus interpolation order/determinism. Time is faked via
// sinon fake timers limited to `performance` (interp stamps arrivals with
// performance.now()).
// ============================================================================
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EntKind, EntSnap, TeamId } from '@rift/shared';
import type { SnapMsg } from './contract.js';
import { createInterp } from './interp.js';

function ent(id: number, x: number, z: number, k: EntKind = 'melee', team: TeamId = 0): EntSnap {
  return { id, k, team, x, z, hp: 100, maxHp: 100 };
}

function snap(tick: number, ents: EntSnap[]): SnapMsg {
  return {
    t: 'rift_snap',
    tick,
    serverTime: tick * 50,
    phase: 'live',
    matchTick: tick,
    overtime: false,
    wardStock: 0,
    kills: [0, 0],
    board: [],
    you: null,
    ents,
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['performance'] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createInterp', () => {
  it('is empty before the first snapshot', () => {
    const itp = createInterp();
    expect(itp.sample()).toEqual([]);
    expect(itp.ghosts()).toEqual([]);
    expect(itp.latest()).toBeNull();
  });

  it('interpolates between the two newest snaps, 100ms behind, older -> newer', () => {
    const itp = createInterp();
    itp.push(snap(1, [ent(5, 0, 0)])); // arrives at t=0
    vi.advanceTimersByTime(50);
    itp.push(snap(2, [ent(5, 10, 0)])); // arrives at t=50
    // render time is now-100: at t=125 the render clock reads t=25, halfway
    // between the two arrivals -> x=5, moving old -> new as time advances.
    vi.advanceTimersByTime(75);
    const mid = itp.sample();
    expect(mid).toHaveLength(1);
    expect(mid[0]?.x).toBeCloseTo(5, 6);
    vi.advanceTimersByTime(25); // t=150 -> render t=50 -> fully at the new snap
    expect(itp.sample()[0]?.x).toBeCloseTo(10, 6);
    expect(itp.latest()?.tick).toBe(2);
  });

  it('holds the newest position when the buffer starves (no extrapolation, no stale lerp)', () => {
    const itp = createInterp();
    itp.push(snap(1, [ent(5, 0, 0)]));
    vi.advanceTimersByTime(50);
    itp.push(snap(2, [ent(5, 10, 0)]));
    vi.advanceTimersByTime(500); // no new snaps: render clock is past the newest
    expect(itp.sample()[0]?.x).toBeCloseTo(10, 6);
  });

  it('emits entities sorted by id (deterministic sampling order)', () => {
    const itp = createInterp();
    itp.push(snap(1, [ent(9, 0, 0), ent(3, 1, 1), ent(5, 2, 2)]));
    const ids = itp.sample().map((e) => e.id);
    expect(ids).toEqual([3, 5, 9]);
  });

  it('ghosts a vanished entity at its last known position and fades over 0.5s', () => {
    const itp = createInterp();
    itp.push(snap(1, [ent(5, 10, 20)]));
    vi.advanceTimersByTime(50);
    itp.push(snap(2, [])); // id 5 vanishes here
    const g0 = itp.ghosts();
    expect(g0).toHaveLength(1);
    expect(g0[0]?.id).toBe(5);
    expect(g0[0]?.x).toBeCloseTo(10, 6);
    expect(g0[0]?.z).toBeCloseTo(20, 6);
    expect(g0[0]?.fade).toBeCloseTo(1, 6);
    // vanished entities leave sample() entirely — no stale-target lerp
    expect(itp.sample()).toHaveLength(0);
    vi.advanceTimersByTime(250);
    expect(itp.ghosts()[0]?.fade).toBeCloseTo(0.5, 6);
    vi.advanceTimersByTime(300); // 550ms > 500ms: fully faded, marker retired
    expect(itp.ghosts()).toHaveLength(0);
  });

  it('never snaps a ghost to the origin', () => {
    const itp = createInterp();
    itp.push(snap(1, [ent(7, 33.5, 44.25)]));
    vi.advanceTimersByTime(50);
    itp.push(snap(2, []));
    const g = itp.ghosts()[0];
    expect(g).toBeDefined();
    expect(g?.x).not.toBe(0);
    expect(g?.z).not.toBe(0);
    expect(g?.x).toBeCloseTo(33.5, 6);
    expect(g?.z).toBeCloseTo(44.25, 6);
  });

  it('structures never ghost — a missing structure is simply dropped', () => {
    const itp = createInterp();
    itp.push(snap(1, [ent(1, 8, 8, 'tower', 0), ent(2, 90, 90, 'ancient', 1), ent(5, 4, 4)]));
    vi.advanceTimersByTime(50);
    itp.push(snap(2, [ent(5, 4, 4)])); // tower + ancient gone from the snap
    expect(itp.ghosts()).toHaveLength(0);
    expect(itp.sample().map((e) => e.id)).toEqual([5]);
  });

  it('a reappearing entity interpolates fresh from its new position (no lerp from stale)', () => {
    const itp = createInterp();
    itp.push(snap(1, [ent(5, 10, 10)]));
    vi.advanceTimersByTime(50);
    itp.push(snap(2, [])); // vanishes, ghost at (10,10)
    vi.advanceTimersByTime(100);
    itp.push(snap(3, [ent(5, 50, 50)])); // reappears somewhere else entirely
    // immediately at the NEW position — from == to, nothing stale remains
    const s = itp.sample();
    expect(s).toHaveLength(1);
    expect(s[0]?.x).toBeCloseTo(50, 6);
    expect(s[0]?.z).toBeCloseTo(50, 6);
    expect(itp.ghosts()).toHaveLength(0); // reappear supersedes the ghost
    // and as the NEXT snap arrives it lerps new -> newer, never back to (10,10)
    vi.advanceTimersByTime(50);
    itp.push(snap(4, [ent(5, 60, 50)]));
    vi.advanceTimersByTime(75); // render clock halfway between snap3 and snap4
    const x = itp.sample()[0]?.x ?? -1;
    expect(x).toBeGreaterThan(50);
    expect(x).toBeLessThan(60);
  });

  it('keeps hp/maxHp and transient atk from the newest snap on the pooled ent', () => {
    const itp = createInterp();
    itp.push(snap(1, [{ ...ent(5, 0, 0), hp: 80 }]));
    vi.advanceTimersByTime(50);
    itp.push(snap(2, [{ ...ent(5, 1, 0), hp: 55, atk: 9 }]));
    const e = itp.sample()[0];
    expect(e?.hp).toBe(55);
    expect(e?.atk).toBe(9);
    vi.advanceTimersByTime(50);
    itp.push(snap(3, [{ ...ent(5, 2, 0), hp: 55 }])); // no attack this snap
    expect(itp.sample()[0]?.atk).toBeUndefined();
  });
});
