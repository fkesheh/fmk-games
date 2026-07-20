// ============================================================================
// kart-tests — KartRoom phase machine + race rules over a fake RoomIO. The
// room's own 15Hz interval is driven by vi fake timers (which also fake
// Date.now), and karts are "driven" by feeding kart_state positions taken
// straight from buildTrack().gates — a position exactly on a gate is always
// within GATE_RADIUS of it, so the run is fully deterministic.
// ============================================================================
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  COUNTDOWN_SECONDS,
  GATES,
  LAPS_TO_WIN,
  RACE_TIMEOUT_S,
  READY_SECONDS,
  RESULTS_SECONDS,
  SNAPSHOT_HZ,
  buildTrack,
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

/** Two players seated, room started, driven all the way to 'racing'. */
function setupRace(io: FakeIO): { room: KartRoom; feed: StateFeed } {
  const room = new KartRoom('public', io);
  room.addPlayer('p1', 'Alpha');
  room.addPlayer('p2', 'Bravo');
  room.start();
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
  it('stays in lobby solo; a second player runs ready -> countdown 3-2-1-go -> racing', () => {
    const io = new FakeIO();
    const room = new KartRoom('public', io);
    room.addPlayer('p1', 'Alpha');
    room.start();

    vi.advanceTimersByTime(200);
    expect(io.lastSnap('p1').phase).toBe('lobby'); // < MIN_PLAYERS
    expect(room.info().phase).toBe('lobby');
    expect(room.info().game).toBe('kart');
    expect(room.info().label).toBe('3 laps · circuit');
    expect(room.info().maxPlayers).toBe(8);

    room.addPlayer('p2', 'Bravo');
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
  it('results last 10s, then the room resets to lobby keeping players and clearing progress', () => {
    const io = new FakeIO();
    const { room, feed } = setupRace(io);

    driveRace(room, feed, 'p1'); // p1 finishes first...
    driveRace(room, feed, 'p2'); // ...then p2: all connected finished => results
    advanceToPhase(io, 'p1', 'results');

    const finishes = eventsOfKind(io, 'p1', 'finish');
    expect(finishes.map((e) => e.playerId)).toEqual(['p1', 'p2']);
    expect(finishes.map((e) => e.place)).toEqual([1, 2]);
    expect(room.playerCount()).toBe(2); // both still seated through results

    room.removePlayer('p2'); // below MIN_PLAYERS: the lobby reset can't re-arm a race
    vi.advanceTimersByTime(RESULTS_SECONDS * 1000 - 1500); // ~8.5s in: still results
    expect(io.lastSnap('p1').phase).toBe('results');
    vi.advanceTimersByTime(2000); // past the 10s mark
    expect(io.lastSnap('p1').phase).toBe('lobby');
    expect(room.info().phase).toBe('lobby');
    expect(room.playerCount()).toBe(1); // p1 kept (p2 left on its own above)

    const you = io.lastSnap('p1').you; // race state cleared for the next race
    expect(you.progress).toBe(0);
    expect(you.finished).toBe(false);
    expect(you.finishMs).toBe(-1);
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
