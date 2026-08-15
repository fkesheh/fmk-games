// ============================================================================
// srv-room tests — OutpostRoom over a fake RoomIO, driven by vi fake timers
// (which also fake Date.now()). Mirrors games/fps/server/src/game.test.ts's
// discipline: a FakeIO that structuredClone()s every send (the room reuses
// its snapshot/you wire objects across ticks, so history must be captured,
// not referenced), and a monotonic-seq InputFeed helper.
//
// Real combat (not a debug shortcut) is used to clear waves: DebugMsg has no
// "kill this zombie" op by design (see room.ts's contract-gap note on
// 'spawn'), so wave-clear tests stage deterministic melee kills with the
// knife (mag: -1, so no reload/ammo bookkeeping to fight) at point-blank
// range, aimed with the same yawTo/pitchTo helpers the map's own camera
// framing uses.
// ============================================================================
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rng } from '@platform/shared';
import type { PlayerId } from '@platform/shared';
import { INPUT_FIRE, NETCODE, WAVES, ZOMBIE_BASE, pitchTo, yawTo } from '@outpost/shared';
import type { InputMsg, JoinedMsg, OutpostEvent, S2C, SnapshotMsg } from '@outpost/shared';
import { OutpostRoom } from './room.js';
import type { RoomIO } from './room.js';

// ---- fake RoomIO ------------------------------------------------------------

class FakeIO implements RoomIO {
  private readonly log = new Map<PlayerId, S2C[]>();

  send(id: PlayerId, msg: S2C): void {
    let msgs = this.log.get(id);
    if (msgs === undefined) {
      msgs = [];
      this.log.set(id, msgs);
    }
    msgs.push(structuredClone(msg));
  }

  rttMs(): number {
    return 0;
  }

  private allOf<T extends S2C['t']>(id: PlayerId, t: T): Array<Extract<S2C, { t: T }>> {
    return (this.log.get(id) ?? []).filter((m): m is Extract<S2C, { t: T }> => m.t === t);
  }

  private lastOf<T extends S2C['t']>(id: PlayerId, t: T): Extract<S2C, { t: T }> {
    const msgs = this.allOf(id, t);
    const last = msgs[msgs.length - 1];
    if (last === undefined) throw new Error(`no '${t}' captured for ${id}`);
    return last;
  }

  lastSnap(id: PlayerId): SnapshotMsg {
    return this.lastOf(id, 'snapshot');
  }

  snapshotCount(id: PlayerId): number {
    return this.allOf(id, 'snapshot').length;
  }

  joined(id: PlayerId): JoinedMsg {
    return this.lastOf(id, 'joined');
  }

  events(id: PlayerId): OutpostEvent[] {
    return this.allOf(id, 'event').map((m) => m.ev);
  }
}

// ---- drive helpers ------------------------------------------------------------

/** Advance the room's interval one-ish tick (1000/30 = 33.33ms). */
function tick(): void {
  vi.advanceTimersByTime(34);
}

function advanceTicks(n: number): void {
  for (let i = 0; i < n; i++) tick();
}

/** Monotonic per-player input seqs (stale/duplicate seqs are dropped server-side). */
class InputFeed {
  private readonly seqs = new Map<PlayerId, number>();

  send(room: OutpostRoom, id: PlayerId, over: Partial<Omit<InputMsg, 't' | 'seq'>> = {}): void {
    const seq = (this.seqs.get(id) ?? 0) + 1;
    this.seqs.set(id, seq);
    room.handleInput(id, { t: 'input', seq, moveX: 0, moveZ: 0, yaw: 0, pitch: 0, buttons: 0, ...over });
  }
}

function makeRoom(debug = false): { room: OutpostRoom; io: FakeIO } {
  const io = new FakeIO();
  const room = new OutpostRoom('public', io, { rand: rng(12345), now: () => Date.now() }, debug ? { debug: true } : undefined);
  room.start();
  return { room, io };
}

function startAndReachWave1(room: OutpostRoom, io: FakeIO, id: PlayerId): void {
  room.handleMessage(id, { t: 'start' });
  advanceTicks(Math.ceil((WAVES.openingLullSec * 1000) / 34) + 4);
  expect(io.lastSnap(id).phase).toBe('wave');
  expect(io.lastSnap(id).wave).toBe(1);
}

/**
 * Point-blank knife kill: teleport the shooter 1.5m south of the target (via
 * the debug wire — requires a debug-enabled room), aim dead-centre at its
 * chest with the SAME yawTo/pitchTo helpers the map's camera framing uses,
 * then fire semi-auto (press/release/wait-out-the-interval) enough times to
 * guarantee a kill regardless of the small nonzero spread landing short.
 * Wave 1 is 100% shamblers (WAVES.unlock), so ZOMBIE_BASE.shambler is valid
 * for every target this helper is ever used against.
 */
function killZombieAt(room: OutpostRoom, feed: InputFeed, id: PlayerId, zx: number, zy: number, zz: number): void {
  const px = zx;
  const pz = zz + 1.5;
  room.handleMessage(id, { t: 'debug', op: 'teleport', a: px, b: 0, c: pz });
  const chestY = zy + ZOMBIE_BASE.shambler.height * 0.5;
  const yaw = yawTo(px, pz, zx, zz);
  const pitch = pitchTo(px, 1.62, pz, zx, chestY, zz);
  for (let shot = 0; shot < 4; shot++) {
    feed.send(room, id, { yaw, pitch, buttons: INPUT_FIRE });
    tick();
    feed.send(room, id, { yaw, pitch, buttons: 0 });
    tick();
    advanceTicks(24); // clear the knife's 0.8s interval before the next press
  }
}

/** Drain the CURRENT wave via real combat: kill every live (non-dying)
 *  zombie as it appears, waiting out the spawn drip between kills. */
function drainWave(room: OutpostRoom, io: FakeIO, feed: InputFeed, id: PlayerId): void {
  let guard = 0;
  while (guard++ < 2000) {
    const snap = io.lastSnap(id);
    if (snap.phase !== 'wave') return; // already cleared
    const target = snap.zombies.find((z) => z.st !== 'dying');
    if (target !== undefined) {
      killZombieAt(room, feed, id, target.x, target.y, target.z);
      continue;
    }
    if (snap.waveRemaining === 0) return;
    tick();
  }
  throw new Error('drainWave: guard exhausted without clearing the wave');
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});

afterEach(() => {
  vi.useRealTimers();
});

// ---- 1. lobby does not auto-start -------------------------------------------

describe('lobby', () => {
  it('never auto-starts, however long it sits idle', () => {
    const { room, io } = makeRoom();
    room.addPlayer('p1', 'Alpha');
    advanceTicks(300); // 10s of ticks — comfortably past any wave/intermission timer
    const snap = io.lastSnap('p1');
    expect(snap.phase).toBe('lobby');
    expect(snap.wave).toBe(0);
    expect(snap.canStart).toBe(true);
    room.stop();
  });
});

// ---- 2. start -> opening lull -> wave 1 -------------------------------------

describe('start', () => {
  it('is the only lobby exit, and leads through the opening lull into wave 1', () => {
    const { room, io } = makeRoom();
    room.addPlayer('p1', 'Alpha');
    room.handleMessage('p1', { t: 'start' });
    advanceTicks(2);
    // opening lull: intermission, wave still 0
    let snap = io.lastSnap('p1');
    expect(snap.phase).toBe('intermission');
    expect(snap.wave).toBe(0);

    advanceTicks(Math.ceil((WAVES.openingLullSec * 1000) / 34) + 4);
    snap = io.lastSnap('p1');
    expect(snap.phase).toBe('wave');
    expect(snap.wave).toBe(1);
    expect(io.events('p1').some((ev) => ev.t === 'wave_start' && ev.wave === 1)).toBe(true);
    room.stop();
  });

  it('is ignored from a non-lobby phase and below MIN_PLAYERS', () => {
    const { room, io } = makeRoom();
    room.addPlayer('p1', 'Alpha');
    room.handleMessage('p1', { t: 'start' });
    advanceTicks(2);
    expect(io.lastSnap('p1').phase).toBe('intermission');
    // a second start while already running is a no-op, not a re-triggered lull
    room.handleMessage('p1', { t: 'start' });
    advanceTicks(2);
    expect(io.lastSnap('p1').phase).toBe('intermission');
    room.stop();
  });
});

// ---- 3. wave clear -> intermission -> wave 2 --------------------------------

describe('wave progression', () => {
  it('clears wave 1 into intermission, then advances into wave 2', () => {
    const { room, io } = makeRoom(true);
    const feed = new InputFeed();
    room.addPlayer('p1', 'Alpha');
    startAndReachWave1(room, io, 'p1');
    // solo player standing at knife range of a shambler for ~3s per kill would
    // otherwise take real melee damage and risk a squad wipe mid-test; this
    // test is about the phase machine, not survivability, so stay invulnerable.
    room.handleMessage('p1', { t: 'debug', op: 'invuln', a: 1 });
    room.handleMessage('p1', { t: 'switch', weapon: 'knife' });
    advanceTicks(2);

    drainWave(room, io, feed, 'p1');

    let snap = io.lastSnap('p1');
    expect(snap.phase).toBe('intermission');
    expect(snap.wave).toBe(1); // wave counter only bumps when the NEXT wave begins
    expect(io.events('p1').some((ev) => ev.t === 'wave_clear' && ev.wave === 1)).toBe(true);

    advanceTicks(Math.ceil((WAVES.intermissionSec * 1000) / 34) + 4);
    snap = io.lastSnap('p1');
    expect(snap.phase).toBe('wave');
    expect(snap.wave).toBe(2);
    expect(io.events('p1').some((ev) => ev.t === 'wave_start' && ev.wave === 2)).toBe(true);
    room.stop();
  }, 20000);
});

describe('the wave clock', () => {
  it('lands the next wave on schedule with the previous one still alive', () => {
    // The old machine advanced ONLY on `spawnQueue empty && aliveThreatCount
    // === 0`, so a wave you could not clear stalled the run forever. Kill
    // nothing and the clock must still bring wave 2.
    const { room, io } = makeRoom(true);
    room.addPlayer('p1', 'Alpha');
    startAndReachWave1(room, io, 'p1');
    room.handleMessage('p1', { t: 'debug', op: 'invuln', a: 1 });
    advanceTicks(2);
    expect(io.lastSnap('p1').wave).toBe(1);

    // run out the period without killing a single zombie
    advanceTicks(Math.ceil((WAVES.wavePeriodSec * 1000) / 34) + 4);

    const snap = io.lastSnap('p1');
    expect(snap.phase).toBe('wave');
    expect(snap.wave).toBe(2);
    expect(io.events('p1').some((ev) => ev.t === 'wave_start' && ev.wave === 2)).toBe(true);
    room.stop();
  }, 60000);
});

// ---- 4. dead survivors return at the next wave ------------------------------

describe('return from death', () => {
  it('brings a dead survivor back alive when the squad reaches the wave they died in + 1', () => {
    const { room, io } = makeRoom(true);
    const feed = new InputFeed();
    room.addPlayer('p1', 'Alpha');
    room.addPlayer('p2', 'Bravo');
    startAndReachWave1(room, io, 'p1');

    // two debug hurts, back to back: alive -> downed -> dead (see damageSurvivor).
    room.handleMessage('p1', { t: 'debug', op: 'hurt', a: 200 });
    room.handleMessage('p1', { t: 'debug', op: 'hurt', a: 200 });
    advanceTicks(2);
    expect(io.lastSnap('p1').you.status).toBe('dead');
    expect(io.lastSnap('p1').you.returnAtWave).toBe(2);
    // a dead survivor is not a target: the squad is not wiped while p2 stands.
    expect(io.lastSnap('p1').phase).toBe('wave');

    room.handleMessage('p2', { t: 'debug', op: 'invuln', a: 1 });
    room.handleMessage('p2', { t: 'switch', weapon: 'knife' });
    advanceTicks(2);
    drainWave(room, io, feed, 'p2');

    expect(io.lastSnap('p2').phase).toBe('intermission');
    const p1After = io.lastSnap('p1');
    expect(p1After.you.status).toBe('alive');
    expect(p1After.you.hp).toBeGreaterThan(0);
    expect(io.events('p1').some((ev) => ev.t === 'returned' && ev.id === 'p1')).toBe(true);
    room.stop();
  }, 20000);
});

// ---- 5. squad wipe ends the run with stats ----------------------------------

describe('squad wipe', () => {
  it('ends the run and emits run_end with per-survivor stats the instant nobody is alive', () => {
    const { room, io } = makeRoom(true);
    room.addPlayer('p1', 'Alpha');
    startAndReachWave1(room, io, 'p1');

    room.handleMessage('p1', { t: 'debug', op: 'hurt', a: 200 });
    room.handleMessage('p1', { t: 'debug', op: 'hurt', a: 200 });
    advanceTicks(2);

    const snap = io.lastSnap('p1');
    expect(snap.phase).toBe('ended');
    const runEnd = io.events('p1').find((ev) => ev.t === 'run_end');
    expect(runEnd).toBeDefined();
    if (runEnd !== undefined && runEnd.t === 'run_end') {
      expect(runEnd.wave).toBe(1);
      expect(runEnd.stats).toHaveLength(1);
      expect(runEnd.stats[0]?.id).toBe('p1');
    }
    room.stop();
  });

  it('does not fire on an empty or freshly-seated room', () => {
    const { room, io } = makeRoom();
    room.addPlayer('p1', 'Alpha');
    advanceTicks(4);
    expect(io.lastSnap('p1').phase).toBe('lobby');
    expect(io.events('p1').some((ev) => ev.t === 'run_end')).toBe(false);
    room.stop();
  });
});

// ---- 6. a disconnected player ghosts and can rejoin -------------------------

describe('rejoin', () => {
  it('ghosts a mid-run disconnect (seat retained) and rebinds a resume to it, with a teammate keeping the run alive', () => {
    // Two survivors: p2 stays connected+alive throughout, so isSquadWiped
    // never trips while p1 is ghosted — this is the scenario the ghosting
    // mechanic exists for (a teammate's brief drop shouldn't end a run
    // others are still playing). A SOLO disconnect is a different, and now
    // intentionally distinct, case — see 'a solo disconnect mid-run ends the
    // run' below.
    const { room, io } = makeRoom();
    room.addPlayer('p1', 'Alpha');
    room.addPlayer('p2', 'Bravo');
    room.handleMessage('p1', { t: 'start' });
    advanceTicks(2);
    expect(io.lastSnap('p1').phase).toBe('intermission');

    room.removePlayer('p1'); // socket dropped, not a permanent leave
    expect(room.playerCount()).toBe(1); // ghost: seat retained, not counted as present
    advanceTicks(2); // the ghost must not be resurrected as an unpiloted body
    expect(io.lastSnap('p2').phase).toBe('intermission'); // p2 alive+connected: no wipe

    room.addPlayer('p1-new', 'Alpha', 'p1');
    expect(room.playerCount()).toBe(2);
    const joined = io.joined('p1-new');
    expect(joined.roomId).toBe(room.id);
    expect(joined.phase).toBe('intermission'); // state carried through the rebind

    advanceTicks(2);
    expect(io.lastSnap('p1-new').phase).toBe('intermission');
    room.stop();
  });

  it('a solo disconnect mid-run ends the run (no ghost left to falsely block the wipe)', () => {
    // Regression for the "phantom alive ghost blocks isSquadWiped forever"
    // bug: with only one survivor seated, a disconnect (connected=false,
    // status untouched at 'alive') must not masquerade as "still fighting".
    const { room, io } = makeRoom();
    room.addPlayer('p1', 'Alpha');
    room.handleMessage('p1', { t: 'start' });
    advanceTicks(2);
    expect(io.lastSnap('p1').phase).toBe('intermission');

    room.removePlayer('p1'); // socket dropped, not a permanent leave
    expect(room.playerCount()).toBe(0); // ghost: seat retained, not counted as present
    advanceTicks(2);

    room.addPlayer('p1-new', 'Alpha', 'p1');
    const joined = io.joined('p1-new');
    expect(joined.roomId).toBe(room.id);
    expect(joined.phase).toBe('ended'); // the run resolved while nobody was present to fight
    room.stop();
  });

  it('deletes the seat outright on an explicit leave', () => {
    const { room } = makeRoom();
    room.addPlayer('p1', 'Alpha');
    room.handleMessage('p1', { t: 'start' });
    room.removePlayer('p1', true);
    expect(room.playerCount()).toBe(0);
    room.addPlayer('p1-new', 'Alpha', 'p1'); // nothing to resume: a fresh seat
    expect(room.playerCount()).toBe(1);
    room.stop();
  });
});

// ---- 7. snapshots are sent at 15Hz not 30 -----------------------------------

describe('snapshot rate', () => {
  it('sends one snapshot every NETCODE.snapshotEveryTicks ticks (15Hz at SIM_HZ 30)', () => {
    const { room, io } = makeRoom();
    room.addPlayer('p1', 'Alpha');
    const n = 30;
    advanceTicks(n);
    expect(io.snapshotCount('p1')).toBe(Math.floor(n / NETCODE.snapshotEveryTicks));
    room.stop();
  });
});
