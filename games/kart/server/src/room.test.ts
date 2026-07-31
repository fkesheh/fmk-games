// ============================================================================
// kart-tests — KartRoom phase machine + race rules over a fake RoomIO. The
// room's own 15Hz interval is driven by vi fake timers (which also fake
// Date.now), and karts are "driven" by feeding kart_state positions taken
// straight from buildTrack().gates — a position exactly on a gate is always
// within GATE_RADIUS of it, so the run is fully deterministic. Also covers
// the pre-GO position freeze / GO grid reset, nitro charges, and gap timing
// (you.gapAheadMs, docs/KART.md "Gap timing").
// ============================================================================
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  COUNTDOWN_SECONDS,
  GATES,
  LAPS_TO_WIN,
  MAX_PLAYERS,
  MIN_PLAYERS,
  NITRO_CHARGES,
  NITRO_TIME,
  RACE_TIMEOUT_S,
  READY_SECONDS,
  RESULTS_SECONDS,
  SNAPSHOT_HZ,
  buildTrack,
  gridSlot,
} from '@kart/shared';
import type { KartPhase, KartS2C, RaceEvent } from '@kart/shared';
import type { PlayerId, RoomIO } from '@platform/shared';
import { KartRoom } from './room.js';

type SnapshotMsg = Extract<KartS2C, { t: 'kart_snapshot' }>;
type JoinedMsg = Extract<KartS2C, { t: 'kart_joined' }>;

// ---- fake RoomIO -------------------------------------------------------------
// Snapshots may be reused/mutated by the room across ticks, so everything is
// captured through structuredClone: history stays stable for assertions.

class FakeIO implements RoomIO {
  private readonly log = new Map<PlayerId, KartS2C[]>();

  send(id: PlayerId, msg: unknown): void {
    let msgs = this.log.get(id);
    if (msgs === undefined) {
      msgs = [];
      this.log.set(id, msgs);
    }
    msgs.push(structuredClone(msg) as KartS2C);
  }

  rttMs(): number {
    return 0;
  }

  private lastOf<T extends KartS2C['t']>(id: PlayerId, t: T): Extract<KartS2C, { t: T }> {
    const msgs = this.log.get(id) ?? [];
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m !== undefined && m.t === t) return m as Extract<KartS2C, { t: T }>;
    }
    throw new Error(`no '${t}' captured for ${id}`);
  }

  lastSnap(id: PlayerId): SnapshotMsg {
    return this.lastOf(id, 'kart_snapshot');
  }

  joined(id: PlayerId): JoinedMsg {
    return this.lastOf(id, 'kart_joined');
  }

  raceEvents(id: PlayerId): RaceEvent[] {
    return (this.log.get(id) ?? [])
      .filter((m): m is Extract<KartS2C, { t: 'race_event' }> => m.t === 'race_event')
      .map((m) => m.ev);
  }
}

// ---- drive helpers -----------------------------------------------------------

/** The one circuit under test; gates are fed to the room in race order. */
const TRACK = buildTrack();

/**
 * Gate visit order for one lap: 1..GATES-1, then gate 0 (start/finish) to
 * close the lap. nextGate starts at 1 — the grid sits behind the line.
 */
const LAP_ORDER = Array.from({ length: GATES }, (_, i) => (i + 1) % GATES);

/** Advance the room's interval one-ish tick (1000/15 = 66.67ms). */
function tick(): void {
  vi.advanceTimersByTime(Math.ceil(1000 / SNAPSHOT_HZ));
}

/** Advance until cond holds; false when the step budget ran out. */
function advanceUntil(cond: () => boolean, maxSteps = 600): boolean {
  for (let i = 0; i < maxSteps; i++) {
    tick(); // tick first: cond reads snapshots, which only exist after a tick
    if (cond()) return true;
  }
  return cond();
}

/** Monotonic per-player kart_state seqs (stale/duplicate seqs may be dropped). */
class StateFeed {
  private readonly seqs = new Map<PlayerId, number>();

  send(room: KartRoom, id: PlayerId, x: number, z: number): void {
    const seq = (this.seqs.get(id) ?? 0) + 1;
    this.seqs.set(id, seq);
    room.handleMessage(id, { t: 'kart_state', seq, p: [x, 0, z], yaw: 0, v: [0, 0], steer: 0, drift: false });
  }
}

/** Teleport `id` onto gate `gate` for a tick — exactly on it, so always in radius. */
function driveGate(room: KartRoom, feed: StateFeed, id: PlayerId, gate: number): void {
  const g = TRACK.gates[gate];
  if (g === undefined) throw new Error(`no gate ${gate}`);
  feed.send(room, id, g.x, g.z);
  tick();
}

function driveLap(room: KartRoom, feed: StateFeed, id: PlayerId): void {
  for (const g of LAP_ORDER) driveGate(room, feed, id, g);
}

function driveRace(room: KartRoom, feed: StateFeed, id: PlayerId): void {
  for (let lap = 0; lap < LAPS_TO_WIN; lap++) driveLap(room, feed, id);
}

/** Two players seated, room started, START pressed, driven all the way to 'racing'. */
function setupRace(io: FakeIO): { room: KartRoom; feed: StateFeed } {
  const room = new KartRoom('public', io);
  room.addPlayer('p1', 'Alpha');
  room.addPlayer('p2', 'Bravo');
  room.start();
  room.handleMessage('p1', { t: 'start' }); // nothing auto-starts: a seated player presses START
  const feed = new StateFeed();
  advanceToPhase(io, 'p1', 'racing');
  return { room, feed };
}

function advanceToPhase(io: FakeIO, id: PlayerId, phase: KartPhase, maxSteps = 600): void {
  const ok = advanceUntil(() => io.lastSnap(id).phase === phase, maxSteps);
  expect(ok, `room reaches phase ${phase}`).toBe(true);
}

function eventsOfKind<K extends RaceEvent['kind']>(
  io: FakeIO,
  id: PlayerId,
  kind: K,
): Array<Extract<RaceEvent, { kind: K }>> {
  return io.raceEvents(id).filter((e): e is Extract<RaceEvent, { kind: K }> => e.kind === kind);
}

// ---- tests -------------------------------------------------------------------

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('KartRoom phase flow', () => {
  it('stays in lobby solo; with 2 seated an explicit START runs ready -> countdown 3-2-1-go -> racing', () => {
    const io = new FakeIO();
    const room = new KartRoom('public', io);
    room.addPlayer('p1', 'Alpha');
    room.start();

    vi.advanceTimersByTime(200);
    expect(io.lastSnap('p1').phase).toBe('lobby'); // < MIN_PLAYERS
    expect(room.info().phase).toBe('lobby');
    expect(room.info().game).toBe('kart');
    expect(room.info().label).toBe('3 laps · circuit');
    expect(room.info().maxPlayers).toBe(MAX_PLAYERS); // never a literal: the cap moves

    room.addPlayer('p2', 'Bravo');
    vi.advanceTimersByTime(READY_SECONDS * 1000 + 2000); // a full lobby still WAITS
    expect(io.lastSnap('p1').phase).toBe('lobby');

    room.handleMessage('p2', { t: 'start' }); // any seated player may start it
    advanceToPhase(io, 'p1', 'ready');
    expect(room.info().phase).toBe('ready');
    const readySnap = io.lastSnap('p1');
    expect(readySnap.phaseEndsAt - readySnap.serverTime).toBeGreaterThan(0);
    expect(readySnap.phaseEndsAt - readySnap.serverTime).toBeLessThanOrEqual(READY_SECONDS * 1000);

    advanceToPhase(io, 'p1', 'countdown');
    advanceToPhase(io, 'p1', 'racing');
    expect(room.info().phase).toBe('racing');

    // exactly one countdown run, in order, immediately followed by go
    const kinds = io.raceEvents('p1').map((e) => e.kind);
    expect(kinds).toEqual([...Array.from({ length: COUNTDOWN_SECONDS }, () => 'countdown'), 'go']);
    const countdowns = eventsOfKind(io, 'p1', 'countdown').map((e) => e.n);
    expect(countdowns).toEqual(Array.from({ length: COUNTDOWN_SECONDS }, (_, i) => COUNTDOWN_SECONDS - i));
    room.stop();
  });
});

describe('KartRoom explicit start (frozen lobby contract)', () => {
  /** A seated lobby that is startable but has NOT been started. */
  function seatedLobby(io: FakeIO, n = MIN_PLAYERS): KartRoom {
    const room = new KartRoom('public', io);
    for (let i = 0; i < n; i++) room.addPlayer(`p${i + 1}`, `Driver${i + 1}`);
    room.start();
    tick();
    return room;
  }

  it('never auto-starts: a lobby at MIN_PLAYERS sits in lobby however long it waits', () => {
    const io = new FakeIO();
    const room = seatedLobby(io);

    vi.advanceTimersByTime((READY_SECONDS + COUNTDOWN_SECONDS) * 1000 + 10_000);
    expect(io.lastSnap('p1').phase).toBe('lobby');
    expect(room.info().phase).toBe('lobby');
    expect(io.raceEvents('p1').length).toBe(0); // no countdown, no go
    room.stop();
  });

  it('does not auto-start at a FULL grid either (MAX_PLAYERS seated)', () => {
    const io = new FakeIO();
    const room = seatedLobby(io, MAX_PLAYERS);

    vi.advanceTimersByTime((READY_SECONDS + COUNTDOWN_SECONDS) * 1000 + 5000);
    expect(room.playerCount()).toBe(MAX_PLAYERS);
    expect(io.lastSnap('p1').phase).toBe('lobby');
    room.stop();
  });

  it('the snapshot carries playerCount / minPlayers / canStart', () => {
    const io = new FakeIO();
    const room = new KartRoom('public', io);
    room.addPlayer('p1', 'Alpha');
    room.start();
    tick();

    let snap = io.lastSnap('p1');
    expect(snap.playerCount).toBe(1);
    expect(snap.minPlayers).toBe(MIN_PLAYERS);
    expect(snap.canStart).toBe(false); // one short

    room.addPlayer('p2', 'Bravo');
    tick();
    snap = io.lastSnap('p1');
    expect(snap.playerCount).toBe(2);
    expect(snap.canStart).toBe(true);

    room.handleMessage('p1', { t: 'start' });
    advanceToPhase(io, 'p1', 'ready');
    expect(io.lastSnap('p1').canStart).toBe(false); // no longer in the lobby phase
    room.stop();
  });

  it('start below MIN_PLAYERS is ignored (and never throws)', () => {
    const io = new FakeIO();
    const room = new KartRoom('public', io);
    room.addPlayer('p1', 'Alpha');
    room.start();

    expect(() => room.handleMessage('p1', { t: 'start' })).not.toThrow();
    vi.advanceTimersByTime((READY_SECONDS + COUNTDOWN_SECONDS) * 1000 + 2000);
    expect(io.lastSnap('p1').phase).toBe('lobby');
    expect(io.raceEvents('p1').length).toBe(0);
    room.stop();
  });

  it('start from a player who is not in the room is ignored', () => {
    const io = new FakeIO();
    const room = seatedLobby(io);

    expect(() => room.handleMessage('ghost', { t: 'start' })).not.toThrow();
    vi.advanceTimersByTime(READY_SECONDS * 1000 + 2000);
    expect(io.lastSnap('p1').phase).toBe('lobby');
    room.stop();
  });

  it('a valid start runs ready -> countdown -> racing, and any seated player may send it', () => {
    const io = new FakeIO();
    const room = seatedLobby(io);

    room.handleMessage('p2', { t: 'start' }); // the SECOND joiner, not a "host"
    advanceToPhase(io, 'p1', 'ready');
    advanceToPhase(io, 'p1', 'countdown');
    advanceToPhase(io, 'p1', 'racing');

    const kinds = io.raceEvents('p1').map((e) => e.kind);
    expect(kinds).toEqual([...Array.from({ length: COUNTDOWN_SECONDS }, () => 'countdown'), 'go']);
    room.stop();
  });

  it('extra starts during ready/countdown/racing/results change nothing', () => {
    const io = new FakeIO();
    const room = seatedLobby(io);

    room.handleMessage('p1', { t: 'start' });
    advanceToPhase(io, 'p1', 'ready');
    const readyEndsAt = io.lastSnap('p1').phaseEndsAt;
    room.handleMessage('p2', { t: 'start' }); // ignored: not in 'lobby'
    tick();
    expect(io.lastSnap('p1').phase).toBe('ready');
    expect(io.lastSnap('p1').phaseEndsAt).toBe(readyEndsAt); // the timer was NOT restarted

    advanceToPhase(io, 'p1', 'countdown');
    room.handleMessage('p1', { t: 'start' });
    tick();
    expect(io.lastSnap('p1').phase).toBe('countdown');

    advanceToPhase(io, 'p1', 'racing');
    room.handleMessage('p1', { t: 'start' });
    tick();
    expect(io.lastSnap('p1').phase).toBe('racing');

    const feed = new StateFeed();
    driveRace(room, feed, 'p1');
    driveRace(room, feed, 'p2');
    advanceToPhase(io, 'p1', 'results');
    room.handleMessage('p1', { t: 'start' });
    tick();
    expect(io.lastSnap('p1').phase).toBe('results'); // no early exit out of results

    // exactly one countdown run for the whole race, despite five start messages
    expect(eventsOfKind(io, 'p1', 'countdown').length).toBe(COUNTDOWN_SECONDS);
    expect(eventsOfKind(io, 'p1', 'go').length).toBe(1);
    room.stop();
  });
});

describe('KartRoom gates + laps', () => {
  it('credits the expected gate in order when passed within GATE_RADIUS', () => {
    const io = new FakeIO();
    const { room, feed } = setupRace(io);

    driveGate(room, feed, 'p1', 1);
    const you = io.lastSnap('p1').you;
    expect(you.nextGate).toBe(2);
    expect(you.progress).toBe(1);

    const gates = eventsOfKind(io, 'p1', 'gate').filter((e) => e.playerId === 'p1');
    expect(gates.length).toBe(1);
    expect(gates[0]?.gate).toBe(1);
    room.stop();
  });

  it('skipping to gate 3 first gives NO credit; the expected gate still credits after', () => {
    const io = new FakeIO();
    const { room, feed } = setupRace(io);

    driveGate(room, feed, 'p1', 3); // not the expected gate: ignored
    expect(io.lastSnap('p1').you.progress).toBe(0);
    expect(io.lastSnap('p1').you.nextGate).toBe(1);
    expect(eventsOfKind(io, 'p1', 'gate').filter((e) => e.playerId === 'p1').length).toBe(0);

    driveGate(room, feed, 'p1', 1); // in order again: credits normally
    expect(io.lastSnap('p1').you.progress).toBe(1);
    room.stop();
  });

  it('8 gates x 3 laps in order finishes: finish event place 1, finishMs > 0', () => {
    const io = new FakeIO();
    const { room, feed } = setupRace(io);

    driveRace(room, feed, 'p1');
    tick();

    const you = io.lastSnap('p1').you;
    expect(you.finished).toBe(true);
    expect(you.finishMs).toBeGreaterThan(0);
    expect(you.progress).toBe(LAPS_TO_WIN * GATES);

    // first (and only) finisher so far: finishOrder[0] === p1, seen as place 1
    const finishes = eventsOfKind(io, 'p1', 'finish');
    expect(finishes.length).toBe(1);
    expect(finishes[0]?.playerId).toBe('p1');
    expect(finishes[0]?.place).toBe(1);

    // the finish-line crossing may double as the final lap event, so >= 2
    const laps = eventsOfKind(io, 'p1', 'lap').filter((e) => e.playerId === 'p1');
    expect(laps.length).toBeGreaterThanOrEqual(LAPS_TO_WIN - 1);
    room.stop();
  });

  it('bestLapMs tracks the lap event after a full lap', () => {
    const io = new FakeIO();
    const { room, feed } = setupRace(io);

    driveLap(room, feed, 'p1');

    const laps = eventsOfKind(io, 'p1', 'lap').filter((e) => e.playerId === 'p1');
    expect(laps.length).toBe(1);
    const lapMs = laps[0]?.lapMs ?? -1;
    expect(lapMs).toBeGreaterThan(0);

    const you = io.lastSnap('p1').you;
    expect(you.lap).toBe(2);
    expect(you.bestLapMs).toBe(lapMs);
    room.stop();
  });
});

describe('KartRoom race end', () => {
  it('results last 10s, then the room resets to lobby keeping players, clearing progress, and WAITS', () => {
    const io = new FakeIO();
    const { room, feed } = setupRace(io);

    driveRace(room, feed, 'p1'); // p1 finishes first...
    driveRace(room, feed, 'p2'); // ...then p2: all connected finished => results
    advanceToPhase(io, 'p1', 'results');

    const finishes = eventsOfKind(io, 'p1', 'finish');
    expect(finishes.map((e) => e.playerId)).toEqual(['p1', 'p2']);
    expect(finishes.map((e) => e.place)).toEqual([1, 2]);
    expect(room.playerCount()).toBe(2); // both still seated through results

    vi.advanceTimersByTime(RESULTS_SECONDS * 1000 - 1500); // ~8.5s in: still results
    expect(io.lastSnap('p1').phase).toBe('results');
    vi.advanceTimersByTime(2000); // past the 10s mark
    expect(io.lastSnap('p1').phase).toBe('lobby');
    expect(room.info().phase).toBe('lobby');
    expect(room.playerCount()).toBe(2); // both kept across the reset

    const you = io.lastSnap('p1').you; // race state cleared for the next race
    expect(you.progress).toBe(0);
    expect(you.finished).toBe(false);
    expect(you.finishMs).toBe(-1);

    // ...and it STAYS there: a full lobby after a race never re-arms itself
    vi.advanceTimersByTime((READY_SECONDS + COUNTDOWN_SECONDS) * 1000 + 5000);
    expect(io.lastSnap('p1').phase).toBe('lobby');
    expect(io.lastSnap('p1').canStart).toBe(true); // startable, just not started

    room.handleMessage('p2', { t: 'start' }); // the NEXT race is another explicit press
    advanceToPhase(io, 'p1', 'ready');
    room.stop();
  });

  it('a mid-race joiner seats at the back with progress 0 and races too', () => {
    const io = new FakeIO();
    const { room, feed } = setupRace(io);

    // distinct progress so places are unambiguous: p1 ahead of p2
    driveGate(room, feed, 'p1', 1);
    driveGate(room, feed, 'p1', 2);
    driveGate(room, feed, 'p2', 1);

    room.addPlayer('p3', 'Carol');
    const joined = io.joined('p3');
    expect(joined.phase).toBe('racing');
    expect(joined.players.map((p) => p.id)).toEqual(['p1', 'p2', 'p3']);

    tick();
    const snap = io.lastSnap('p3');
    expect(snap.you.progress).toBe(0);
    expect(snap.you.lap).toBe(1);
    expect(snap.you.finished).toBe(false);
    expect(snap.you.place).toBe(3); // the back of the grid

    const self = snap.players.find((p) => p.id === 'p3');
    expect(self?.progress).toBe(0);
    expect(self?.place).toBe(3);
    room.stop();
  });

  it('RACE_TIMEOUT_S ends the race for players who never finish', () => {
    const io = new FakeIO();
    const { room } = setupRace(io);

    vi.advanceTimersByTime(RACE_TIMEOUT_S * 1000 + 2000);
    expect(io.lastSnap('p1').phase).toBe('results');
    expect(eventsOfKind(io, 'p1', 'timeout').length).toBe(1);
    expect(io.lastSnap('p1').you.finished).toBe(false);
    room.stop();
  });
});

describe('KartRoom pre-GO freeze', () => {
  /** p1 joins first => grid slot 0; snapshot positions come from `players`. */
  function posOf(io: FakeIO, id: PlayerId): [number, number, number] {
    const self = io.lastSnap(id).players.find((p) => p.id === id);
    if (self === undefined) throw new Error(`no ${id} in snapshot`);
    return self.p;
  }

  it('kart_state during ready/countdown is ignored (stays on grid); after GO it tracks', () => {
    const io = new FakeIO();
    const room = new KartRoom('public', io);
    room.addPlayer('p1', 'Alpha');
    room.addPlayer('p2', 'Bravo');
    room.start();
    room.handleMessage('p1', { t: 'start' }); // explicit start: nothing auto-starts
    const feed = new StateFeed();
    const spawn = gridSlot(TRACK, 0);

    advanceToPhase(io, 'p1', 'ready');
    feed.send(room, 'p1', spawn.x + 30, spawn.z + 30); // off-grid: ignored
    tick();
    expect(posOf(io, 'p1')).toEqual([spawn.x, 0, spawn.z]);

    advanceToPhase(io, 'p1', 'countdown');
    feed.send(room, 'p1', spawn.x - 25, spawn.z + 40); // still ignored
    tick();
    expect(posOf(io, 'p1')).toEqual([spawn.x, 0, spawn.z]);

    advanceToPhase(io, 'p1', 'racing');
    feed.send(room, 'p1', spawn.x + 12, spawn.z + 34); // racing: tracks normally
    tick();
    expect(posOf(io, 'p1')).toEqual([spawn.x + 12, 0, spawn.z + 34]);
    room.stop();
  });

  it('a player off the grid at GO is back on their slot in the first racing snapshot', () => {
    const io = new FakeIO();
    const room = new KartRoom('public', io);
    room.addPlayer('p1', 'Alpha');
    room.addPlayer('p2', 'Bravo');
    room.start();
    room.handleMessage('p1', { t: 'start' }); // explicit start: nothing auto-starts
    const feed = new StateFeed();
    const spawn = gridSlot(TRACK, 0);

    advanceToPhase(io, 'p1', 'countdown');
    feed.send(room, 'p1', spawn.x + 77, spawn.z - 55); // shoved off-grid pre-GO
    tick();
    advanceToPhase(io, 'p1', 'racing'); // first racing snapshot, no new kart_state fed

    expect(posOf(io, 'p1')).toEqual([spawn.x, 0, spawn.z]);
    room.stop();
  });
});

describe('KartRoom nitro', () => {
  it('spends 3 charges (events left 2/1/0), ignores a 4th, nitroActive clears after NITRO_TIME', () => {
    const io = new FakeIO();
    const { room } = setupRace(io); // p1 + p2 seated, phase 'racing'

    const selfNitroActive = (): boolean | undefined =>
      io.lastSnap('p1').players.find((p) => p.id === 'p1')?.nitroActive;
    const nitroEvents = (): Array<Extract<RaceEvent, { kind: 'nitro' }>> =>
      eventsOfKind(io, 'p1', 'nitro').filter((e) => e.playerId === 'p1');

    expect(io.lastSnap('p1').you.nitroLeft).toBe(NITRO_CHARGES); // refilled at GO
    expect(selfNitroActive()).toBe(false);

    room.handleMessage('p1', { t: 'nitro' });
    room.handleMessage('p1', { t: 'nitro' });
    room.handleMessage('p1', { t: 'nitro' });
    tick(); // let a snapshot land on top of the events

    expect(nitroEvents().map((e) => e.left)).toEqual([2, 1, 0]);
    expect(io.lastSnap('p1').you.nitroLeft).toBe(0);
    expect(selfNitroActive()).toBe(true);

    room.handleMessage('p1', { t: 'nitro' }); // no charges left: silently ignored
    tick();
    expect(nitroEvents().length).toBe(3);
    expect(io.lastSnap('p1').you.nitroLeft).toBe(0);
    expect(selfNitroActive()).toBe(true); // still inside the last charge's window

    vi.advanceTimersByTime(NITRO_TIME * 1000 + 200); // past the boost window
    expect(selfNitroActive()).toBe(false);
    room.stop();
  });
});

describe('KartRoom gap timing', () => {
  it('p2 crosses gate 1 two seconds after p1: p2 gapAheadMs ~2s, leader p1 sees 0', () => {
    const io = new FakeIO();
    const { room, feed } = setupRace(io);

    driveGate(room, feed, 'p1', 1); // p1 crosses gate 1 at t = X
    driveGate(room, feed, 'p1', 2); // keep p1 unambiguously ahead (progress 2 > 1)
    vi.advanceTimersByTime(2000);
    driveGate(room, feed, 'p2', 1); // p2 crosses gate 1 at t = X + ~2s

    // p2's next snapshot: both have a gate-1 timestamp, so the gap is the
    // real crossing delta (~2s), not the spatial estimate
    const p2you = io.lastSnap('p2').you;
    expect(p2you.place).toBe(2);
    expect(p2you.gapAheadMs).toBeGreaterThanOrEqual(1500);
    expect(p2you.gapAheadMs).toBeLessThanOrEqual(2500);

    const p1you = io.lastSnap('p1').you;
    expect(p1you.place).toBe(1);
    expect(p1you.gapAheadMs).toBe(0); // leader has nobody ahead
    room.stop();
  });

  it('gapAheadMs is 0 in every non-racing phase (lobby/ready/countdown/results)', () => {
    const io = new FakeIO();
    const room = new KartRoom('public', io);
    room.addPlayer('p1', 'Alpha');
    room.start();

    vi.advanceTimersByTime(200); // lobby
    expect(io.lastSnap('p1').phase).toBe('lobby');
    expect(io.lastSnap('p1').you.gapAheadMs).toBe(0);

    room.addPlayer('p2', 'Bravo');
    room.handleMessage('p2', { t: 'start' });
    advanceToPhase(io, 'p1', 'ready');
    expect(io.lastSnap('p1').you.gapAheadMs).toBe(0);

    advanceToPhase(io, 'p1', 'countdown');
    expect(io.lastSnap('p1').you.gapAheadMs).toBe(0);

    advanceToPhase(io, 'p1', 'racing');
    const feed = new StateFeed();
    driveRace(room, feed, 'p1');
    driveRace(room, feed, 'p2');
    advanceToPhase(io, 'p1', 'results');
    expect(io.lastSnap('p1').you.gapAheadMs).toBe(0);
    room.stop();
  });
});
