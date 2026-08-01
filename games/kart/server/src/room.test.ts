// ============================================================================
// kart-tests — KartRoom over a fake RoomIO, now that the room is the AUTHORITY
// for positions and not just for race rules.
//
// The old suite drove karts by TELEPORTING them onto gates with `kart_state`.
// That message no longer exists (the wire carries intent only), so every driver
// here feeds `kart_input` and the room integrates it with the shared sim. Each
// driven player keeps a local TWIN (`makeSim` + `stepDrive`, the exact code the
// room runs) fed the exact same inputs, so the test always knows where the kart
// must be — that twin IS the client-prediction contract, asserted to 1e-9.
//
// Steering comes from the shared pure-pursuit assist (`pursuitSteer`), so laps
// are driven the way a kids-mode player drives them: ~4.3s of sim to gate 1,
// ~31s per lap, ~95s for the 3-lap race. Karts that receive NO inputs never
// move at all (the server integrates only what it consumed), which makes idle
// players perfectly stationary and every scenario deterministic.
// ============================================================================
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BARRIER_OUT,
  BUMP_MIN_SPEED,
  COUNTDOWN_SECONDS,
  GATES,
  GATE_RADIUS,
  INPUT_QUEUE_CAP,
  KART_RADIUS,
  KART_RESTITUTION,
  LAPS_TO_WIN,
  MAX_INPUTS_PER_TICK,
  MAX_PLAYERS,
  MIN_PLAYERS,
  NITRO_CHARGES,
  NITRO_TIME,
  RACE_TIMEOUT_S,
  READY_SECONDS,
  RESULTS_SECONDS,
  SIM_BUDGET_MUL,
  SIM_DT,
  SIM_DT_MAX,
  SIM_DT_MIN,
  SIM_HZ,
  SNAPSHOT_HZ,
  buildTrack,
  closestOnTrack,
  DEFAULT_TRACK_ID,
  gridSlot,
  makeAssistState,
  makeSim,
  parseKartC2S,
  pursuitSteer,
  resetSim,
  stepDrive,
  TRACKS,
} from '@kart/shared';
import type { KartInputMsg, KartPhase, KartS2C, KartSim, RaceEvent } from '@kart/shared';
import type { PlayerId, RoomIO } from '@platform/shared';
import { kartModule } from './module.js';
import { KartRoom } from './room.js';

type SnapshotMsg = Extract<KartS2C, { t: 'kart_snapshot' }>;
type JoinedMsg = Extract<KartS2C, { t: 'kart_joined' }>;

// ---- fake RoomIO -------------------------------------------------------------
// Snapshots are reused/mutated by the room across ticks (and `you.sim` is the
// room's LIVE kart object), so everything is captured through structuredClone:
// history stays stable for assertions.

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

  private lastOf<T extends KartS2C['t']>(id: PlayerId, t: T): Extract<KartS2C, { t: T }> | null {
    const msgs = this.log.get(id) ?? [];
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m !== undefined && m.t === t) return m as Extract<KartS2C, { t: T }>;
    }
    return null;
  }

  lastSnap(id: PlayerId): SnapshotMsg {
    const m = this.lastOf(id, 'kart_snapshot');
    if (m === null) throw new Error(`no 'kart_snapshot' captured for ${id}`);
    return m;
  }

  /** Snapshots only exist after the first snapshot tick; poll loops need null. */
  snapOrNull(id: PlayerId): SnapshotMsg | null {
    return this.lastOf(id, 'kart_snapshot');
  }

  joined(id: PlayerId): JoinedMsg {
    const m = this.lastOf(id, 'kart_joined');
    if (m === null) throw new Error(`no 'kart_joined' captured for ${id}`);
    return m;
  }

  raceEvents(id: PlayerId): RaceEvent[] {
    return (this.log.get(id) ?? [])
      .filter((m): m is Extract<KartS2C, { t: 'race_event' }> => m.t === 'race_event')
      .map((m) => m.ev);
  }
}

// ---- timing ------------------------------------------------------------------

/** The one circuit under test — the same TrackDef the room builds. */
const TRACK = buildTrack(TRACKS[DEFAULT_TRACK_ID]);
const SIM_STEP_MS = Math.ceil(1000 / SIM_HZ); // 34ms: one sim tick (+ a little)
const SNAP_STEP_MS = Math.ceil(1000 / SNAPSHOT_HZ); // 50ms: one snapshot tick

/** Advance one sim tick — the rate one kart_input is consumed at. */
function tick(): void {
  vi.advanceTimersByTime(SIM_STEP_MS);
}

/** Advance far enough that a fresh snapshot has certainly been broadcast. */
function settle(): void {
  vi.advanceTimersByTime(SNAP_STEP_MS + SIM_STEP_MS);
}

/** Advance until cond holds; false when the step budget ran out. */
function advanceUntil(cond: () => boolean, maxSteps = 400): boolean {
  for (let i = 0; i < maxSteps; i++) {
    tick();
    if (cond()) return true;
  }
  return cond();
}

function advanceToPhase(io: FakeIO, id: PlayerId, phase: KartPhase, maxSteps = 400): void {
  const ok = advanceUntil(() => io.snapOrNull(id)?.phase === phase, maxSteps);
  expect(ok, `room reaches phase ${phase}`).toBe(true);
}

// ---- input drivers -----------------------------------------------------------

/**
 * One driven kart: sends `kart_input` to the room and advances an identical
 * local twin with the SAME shared step. While the kart is untouched by contact
 * the twin and the room's authoritative state are bit-identical.
 */
class Driver {
  readonly twin: KartSim;
  private readonly assist = makeAssistState();
  private seq = 0;

  constructor(
    readonly id: PlayerId,
    readonly slot: number,
  ) {
    const g = gridSlot(TRACK, slot);
    this.twin = makeSim(g.x, g.z, g.yaw);
  }

  /** Re-base the twin on the grid slot — exactly what the room's GO wipe does. */
  regrid(): void {
    const g = gridSlot(TRACK, this.slot);
    resetSim(this.twin, g.x, g.z, g.yaw);
  }

  lastSeq(): number {
    return this.seq;
  }

  /** Next pure-pursuit input; `over` replaces any field (reverse, coast, ...). */
  input(over: Partial<KartInputMsg> = {}): KartInputMsg {
    const steer = pursuitSteer(TRACK, this.twin, this.assist, SIM_DT);
    const throttle = Math.abs(steer) > 0.45 ? 0.4 : 1; // ease off in the tight stuff
    return {
      t: 'kart_input',
      seq: ++this.seq,
      throttle,
      brake: 0,
      steer,
      drift: false,
      respawn: false,
      dt: SIM_DT,
      ...over,
    };
  }

  /**
   * Queue one input on the room and advance the twin identically. `junk` is
   * merged into the WIRE object only (never into the twin's input) so tests can
   * prove that extra fields a client invents are stripped by parseKartC2S.
   */
  send(room: KartRoom, over: Partial<KartInputMsg> = {}, junk?: Record<string, unknown>): KartInputMsg {
    const inp = this.input(over);
    room.handleMessage(this.id, junk === undefined ? inp : { ...inp, ...junk });
    stepDrive(this.twin, inp, inp.dt, TRACK);
    return inp;
  }
}

/** One input each, then one sim tick — the honest 1 input per SIM_DT cadence. */
function drive(
  room: KartRoom,
  drivers: Driver[],
  steps: number,
  over: Partial<KartInputMsg> = {},
): void {
  for (let i = 0; i < steps; i++) {
    for (const d of drivers) d.send(room, over);
    tick();
  }
}

/**
 * Drive until cond holds. Fails LOUDLY on a stall (with where each kart got
 * stuck) rather than silently running out of budget, so a real regression never
 * looks like "the test needed more ticks".
 */
function driveUntil(
  room: KartRoom,
  io: FakeIO,
  drivers: Driver[],
  cond: () => boolean,
  maxSteps: number,
  over: Partial<KartInputMsg> = {},
): number {
  for (let i = 0; i < maxSteps; i++) {
    for (const d of drivers) d.send(room, over);
    tick();
    if (cond()) return i + 1;
  }
  const where = drivers
    .map((d) => {
      const you = io.snapOrNull(d.id)?.you;
      return `${d.id} progress=${you?.progress} lap=${you?.lap} nextGate=${you?.nextGate} at (${d.twin.x.toFixed(1)},${d.twin.z.toFixed(1)})`;
    })
    .join('; ');
  throw new Error(`stalled after ${maxSteps} sim ticks — ${where}`);
}

// ---- room setup --------------------------------------------------------------

/** Seated players, room started, START pressed, driven all the way to 'racing'. */
function setupRace(io: FakeIO, ids: PlayerId[] = ['p1', 'p2']): { room: KartRoom; drivers: Driver[] } {
  const room = new KartRoom(DEFAULT_TRACK_ID, 'public', io);
  ids.forEach((id, i) => room.addPlayer(id, `Driver${i + 1}`));
  room.start();
  room.handleMessage(ids[0]!, { t: 'start' }); // nothing auto-starts
  advanceToPhase(io, ids[0]!, 'racing');
  // the twins are built on the grid, which is exactly what GO reset the room to
  return { room, drivers: ids.map((id, i) => new Driver(id, i)) };
}

function eventsOfKind<K extends RaceEvent['kind']>(
  io: FakeIO,
  id: PlayerId,
  kind: K,
): Array<Extract<RaceEvent, { kind: K }>> {
  return io.raceEvents(id).filter((e): e is Extract<RaceEvent, { kind: K }> => e.kind === kind);
}

/** This player's own entry in their latest snapshot roster. */
function snapOf(io: FakeIO, id: PlayerId): SnapshotMsg['players'][number] {
  const self = io.lastSnap(id).players.find((p) => p.id === id);
  if (self === undefined) throw new Error(`no ${id} in snapshot`);
  return self;
}

function posOf(io: FakeIO, id: PlayerId): [number, number, number] {
  return snapOf(io, id).p;
}

/** Minimum distance from `pos` to gate `g` — a gate is "visited" inside GATE_RADIUS. */
function distToGate(x: number, z: number, g: number): number {
  const gate = TRACK.gates[g]!;
  return Math.hypot(x - gate.x, z - gate.z);
}

// ---- raw wire helpers (no twin) ----------------------------------------------
// Queue / budget / rate tests must control the exact seq and dt of every message
// and must NOT advance a twin, so they bypass Driver entirely.

/** The default constant input below, as the SIM sees it (parser strips `t`/`seq`/`dt`). */
const REVERSE_IN = { throttle: 0, brake: 1, steer: 0, drift: false, respawn: false } as const;

/** One raw kart_input. Default payload = REVERSE_IN at the maximum accepted dt. */
function sendInput(
  room: KartRoom,
  id: PlayerId,
  seq: number,
  over: Partial<KartInputMsg> = {},
): void {
  room.handleMessage(id, { t: 'kart_input', seq, ...REVERSE_IN, dt: SIM_DT_MAX, ...over });
}

/**
 * How many of those identical inputs the server actually INTEGRATED, recovered
 * from its position: a constant input traces one monotone trajectory, so the
 * authoritative state pins the count exactly. This is what lets the ack be
 * checked against reality instead of against itself.
 */
function integratedCount(io: FakeIO, id: PlayerId, slot: number, dt: number, max = 400): number {
  const g = gridSlot(TRACK, slot);
  const probe = makeSim(g.x, g.z, g.yaw);
  const self = snapOf(io, id);
  for (let k = 0; k <= max; k++) {
    if (Math.abs(probe.x - self.p[0]) < 1e-9 && Math.abs(probe.z - self.p[2]) < 1e-9) return k;
    stepDrive(probe, REVERSE_IN, dt, TRACK);
  }
  return -1;
}

/** The barrier band a kart centre may never leave. */
const BAND = TRACK.roadHalfW + BARRIER_OUT - KART_RADIUS;

function lateralOf(p: [number, number, number]): number {
  return Math.abs(closestOnTrack(TRACK, p[0], p[2]).lateral);
}

/**
 * Park every kart on ONE point: drive each kart until IT has credited gate 0
 * (so they all share the same respawn anchor), then send a `respawn` input.
 * The result is a perfectly stacked pile with zero relative velocity — the
 * contact case resolveKartPair splits positions for while returning impulse 0.
 *
 * Once a kart's expectedGate reaches 1 it is braked, not just left at the
 * same throttle — a kart that keeps accelerating runs on toward gate 1, and
 * crossing THAT gate moves its anchor from gate 0 to gate 1 (598.2 m / 8 =
 * 74.8 m down the road), which un-stacks the pile that respawn is supposed to
 * produce. With the corrected (arc-length) starting grid every kart starts on
 * tarmac, so the front rows can clear gate 1 while the packed back rows are
 * still working through contact; braking each kart the instant it is anchored
 * holds it at gate 0 while the stragglers catch up. Do not "simplify" this
 * back to a single throttle applied to the whole field.
 */
function stackOnAnchor(room: KartRoom, io: FakeIO, ids: PlayerId[]): number {
  let seq = 0;
  const anchored = (): boolean =>
    ids.every((id) => (io.snapOrNull(id)?.you.sim.expectedGate ?? 0) >= 1);
  // 1200: with braking-on-anchor, the 3-kart pile settles in ~12 ticks but the
  // packed 20-kart pile needs ~1090 — braked leaders sit at gate 0 while the
  // still-accelerating back rows fight through contact to reach it too.
  for (let i = 0; i < 1200 && !anchored(); i++) {
    seq++;
    for (const id of ids) {
      const expectedGate = io.snapOrNull(id)?.you.sim.expectedGate ?? 0;
      const input = expectedGate >= 1 ? { throttle: 0, brake: 1 } : { throttle: 1, brake: 0 };
      sendInput(room, id, seq, { ...input, dt: SIM_DT });
    }
    tick();
  }
  expect(anchored(), 'every kart crossed the line and moved its respawn anchor').toBe(true);
  seq++;
  for (const id of ids) sendInput(room, id, seq, { respawn: true, dt: SIM_DT });
  tick();
  return seq;
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
    const room = new KartRoom(DEFAULT_TRACK_ID, 'public', io);
    room.addPlayer('p1', 'Alpha');
    room.start();

    vi.advanceTimersByTime(200);
    expect(io.lastSnap('p1').phase).toBe('lobby'); // < MIN_PLAYERS
    expect(room.info().phase).toBe('lobby');
    expect(room.info().game).toBe('kart');
    expect(room.info().label).toBe(`3 laps · ${TRACKS[DEFAULT_TRACK_ID].name}`); // e.g. "3 laps · Greenvale Ring"
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
    expect(countdowns).toEqual(
      Array.from({ length: COUNTDOWN_SECONDS }, (_, i) => COUNTDOWN_SECONDS - i),
    );
    room.stop();
  });

  it('runs a sim tick AND a snapshot tick, at their own rates', () => {
    const io = new FakeIO();
    const room = new KartRoom(DEFAULT_TRACK_ID, 'public', io);
    room.addPlayer('p1', 'Alpha');
    room.start();

    vi.advanceTimersByTime(1000);
    const first = io.lastSnap('p1').tick;
    vi.advanceTimersByTime(1000);
    const second = io.lastSnap('p1').tick;
    // the snapshot sequence advances at SNAPSHOT_HZ, not at SIM_HZ
    expect(second - first).toBeGreaterThanOrEqual(SNAPSHOT_HZ - 1);
    expect(second - first).toBeLessThanOrEqual(SNAPSHOT_HZ + 1);
    room.stop();
  });
});

describe('KartRoom explicit start (frozen lobby contract)', () => {
  /** A seated lobby that is startable but has NOT been started. */
  function seatedLobby(io: FakeIO, n = MIN_PLAYERS): KartRoom {
    const room = new KartRoom(DEFAULT_TRACK_ID, 'public', io);
    for (let i = 0; i < n; i++) room.addPlayer(`p${i + 1}`, `Driver${i + 1}`);
    room.start();
    settle();
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
    const room = new KartRoom(DEFAULT_TRACK_ID, 'public', io);
    room.addPlayer('p1', 'Alpha');
    room.start();
    settle();

    let snap = io.lastSnap('p1');
    expect(snap.playerCount).toBe(1);
    expect(snap.minPlayers).toBe(MIN_PLAYERS);
    expect(snap.canStart).toBe(false); // one short

    room.addPlayer('p2', 'Bravo');
    settle();
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
    const room = new KartRoom(DEFAULT_TRACK_ID, 'public', io);
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
    settle();
    expect(io.lastSnap('p1').phase).toBe('ready');
    expect(io.lastSnap('p1').phaseEndsAt).toBe(readyEndsAt); // the timer was NOT restarted

    advanceToPhase(io, 'p1', 'countdown');
    room.handleMessage('p1', { t: 'start' });
    settle();
    expect(io.lastSnap('p1').phase).toBe('countdown');

    advanceToPhase(io, 'p1', 'racing');
    room.handleMessage('p1', { t: 'start' });
    settle();
    expect(io.lastSnap('p1').phase).toBe('racing');

    vi.advanceTimersByTime(RACE_TIMEOUT_S * 1000 + 2000); // nobody finishes: timeout
    expect(io.lastSnap('p1').phase).toBe('results');
    room.handleMessage('p1', { t: 'start' });
    settle();
    expect(io.lastSnap('p1').phase).toBe('results'); // no early exit out of results

    // exactly one countdown run for the whole race, despite five start messages
    expect(eventsOfKind(io, 'p1', 'countdown').length).toBe(COUNTDOWN_SECONDS);
    expect(eventsOfKind(io, 'p1', 'go').length).toBe(1);
    room.stop();
  });
});

describe('KartRoom server-authoritative simulation', () => {
  it('integrates the kart from inputs: the snapshot matches a locally-stepped twin exactly', () => {
    const io = new FakeIO();
    const { room, drivers } = setupRace(io);
    const d = drivers[0]!;

    drive(room, [d], 60); // 2s of honest 30Hz input
    settle();

    const self = snapOf(io, 'p1');
    // THE PREDICTION CONTRACT: same code, same inputs, same numbers.
    expect(self.p[0]).toBeCloseTo(d.twin.x, 9);
    expect(self.p[2]).toBeCloseTo(d.twin.z, 9);
    expect(self.yaw).toBeCloseTo(d.twin.yaw, 9);
    expect(self.v[0]).toBeCloseTo(d.twin.vx, 9);
    expect(self.v[1]).toBeCloseTo(d.twin.vz, 9);
    // and it really moved (a twin matching a kart that never left the grid
    // would be a vacuous pass)
    const spawn = gridSlot(TRACK, 0);
    expect(Math.hypot(self.p[0] - spawn.x, self.p[2] - spawn.z)).toBeGreaterThan(20);
    room.stop();
  });

  it('a client cannot move by reporting a position', () => {
    const io = new FakeIO();
    const { room, drivers } = setupRace(io);
    const d = drivers[0]!;

    drive(room, [d], 30);
    settle();
    const before = posOf(io, 'p1');

    // the OLD wire message: rejected outright, so nothing reaches the room
    const lie = {
      t: 'kart_state',
      seq: 9999,
      p: [before[0] + 200, 0, before[2] + 200],
      yaw: 1,
      v: [30, 30],
      steer: 0,
      drift: false,
    };
    expect(parseKartC2S(lie)).toBeNull();
    room.handleMessage('p1', lie);
    settle();
    expect(posOf(io, 'p1')).toEqual(before); // not one millimetre

    // a WELL-FORMED input that smuggles p/v alongside it: the coordinates are
    // stripped by the parser, the intent still applies
    const junk = { p: [before[0] + 200, 0, before[2] + 200], v: [40, 40] };
    const parsed = parseKartC2S({ ...d.input(), ...junk });
    expect(parsed).not.toBeNull();
    expect(Object.prototype.hasOwnProperty.call(parsed, 'p')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(parsed, 'v')).toBe(false);

    for (let i = 0; i < 20; i++) {
      d.send(room, {}, junk);
      tick();
    }
    settle();
    const after = posOf(io, 'p1');
    // exactly where the INPUTS put it — 200m away is not reachable in 20 ticks
    expect(after[0]).toBeCloseTo(d.twin.x, 9);
    expect(after[2]).toBeCloseTo(d.twin.z, 9);
    expect(Math.hypot(after[0] - before[0], after[2] - before[2])).toBeLessThan(50);
    room.stop();
  });

  it('acks the last consumed seq and ships the authoritative sim in `you`', () => {
    const io = new FakeIO();
    const { room, drivers } = setupRace(io);
    const d = drivers[0]!;

    expect(io.lastSnap('p1').you.lastProcessedSeq).toBe(-1); // nothing consumed yet
    drive(room, [d], 40);
    settle();

    const snap = io.lastSnap('p1');
    expect(snap.you.lastProcessedSeq).toBe(d.lastSeq());
    // `you.sim` is the full authoritative kart, consistent with the roster entry
    expect(snap.you.sim.x).toBe(snap.players.find((p) => p.id === 'p1')?.p[0]);
    expect(snap.you.sim.z).toBe(snap.players.find((p) => p.id === 'p1')?.p[2]);
    expect(snap.you.sim.x).toBeCloseTo(d.twin.x, 9);
    expect(snap.you.sim.z).toBeCloseTo(d.twin.z, 9);
    expect(snap.you.sim.gear).toBe(d.twin.gear);
    expect(snap.you.sim.expectedGate).toBe(d.twin.expectedGate);
    room.stop();
  });

  it('caps simulated time at SIM_BUDGET_MUL per real second under an input flood', () => {
    const io = new FakeIO();
    const { room, drivers } = setupRace(io);
    const d = drivers[0]!;
    const spawn = gridSlot(TRACK, 0);

    // Constant, identical inputs at the maximum accepted dt. Reversing in a
    // straight line keeps the trajectory monotone, so the server's position
    // identifies EXACTLY how many inputs it integrated.
    const FLOOD = { throttle: 0, brake: 1, steer: 0, dt: SIM_DT_MAX } as const;
    const PER_TICK = 6; // 180 inputs/s: 6x what an honest client sends
    const STEPS = 60;
    const startSec = Math.floor(Date.now() / 1000);
    for (let i = 0; i < STEPS; i++) {
      for (let k = 0; k < PER_TICK; k++) d.send(room, FLOOD);
      tick();
    }
    settle();
    const endSec = Math.floor(Date.now() / 1000);
    const buckets = endSec - startSec + 1; // 1s speedhack windows the flood touched

    const self = snapOf(io, 'p1');
    // recover the integrated input count by replaying the same constant input
    const probe = makeSim(spawn.x, spawn.z, spawn.yaw);
    const inp = { throttle: 0, brake: 1, steer: 0, drift: false, respawn: false };
    let consumed = -1;
    for (let k = 0; k <= 400; k++) {
      if (Math.abs(probe.x - self.p[0]) < 1e-9 && Math.abs(probe.z - self.p[2]) < 1e-9) {
        consumed = k;
        break;
      }
      stepDrive(probe, inp, SIM_DT_MAX, TRACK);
    }
    expect(consumed, 'server state lies on the constant-input trajectory').toBeGreaterThanOrEqual(0);

    const simSeconds = consumed * SIM_DT_MAX;
    expect(consumed).toBeLessThan(STEPS * PER_TICK); // the flood did NOT get what it asked for
    expect(simSeconds).toBeLessThanOrEqual(SIM_BUDGET_MUL * buckets + 1e-9);
    expect(consumed).toBeGreaterThan(10); // ...but it is a rate limiter, not a wall
    room.stop();
  });

  it('does NOT acknowledge an input the budget refused to integrate', () => {
    const io = new FakeIO();
    const { room } = setupRace(io);
    const N = 40; // under INPUT_QUEUE_CAP, so nothing is dropped: only the budget bites
    for (let i = 1; i <= N; i++) sendInput(room, 'p1', i); // one burst, no ticks yet

    let stalled = false;
    let prevAck = -1;
    let ack = -1;
    for (let i = 0; i < 80 && ack < N; i++) {
      vi.advanceTimersByTime(60);
      ack = io.lastSnap('p1').you.lastProcessedSeq;
      // THE INVARIANT: the ack is exactly how many inputs actually integrated.
      // Acking the whole queue while simulating part of it would silently break
      // the client's replay — it would drop inputs the server never ran.
      expect(integratedCount(io, 'p1', 0, SIM_DT_MAX), `ack ${ack} matches integrated`).toBe(ack);
      if (ack === prevAck && ack < N) stalled = true;
      prevAck = ack;
    }
    expect(stalled, 'the budget really did throttle mid-queue').toBe(true);
    expect(ack, 'throttled leftovers stay queued and are consumed later, not discarded').toBe(N);
    room.stop();
  });

  it('caps the input queue at INPUT_QUEUE_CAP, dropping the OLDEST first', () => {
    const io = new FakeIO();
    const { room } = setupRace(io);
    const S = INPUT_QUEUE_CAP + 20;
    for (let i = 1; i <= S; i++) sendInput(room, 'p1', i, { dt: SIM_DT }); // all queued at once

    let ack = -1;
    let firstAck = -1;
    for (let i = 0; i < 90 && ack < S; i++) {
      vi.advanceTimersByTime(60);
      ack = io.lastSnap('p1').you.lastProcessedSeq;
      if (firstAck < 0 && ack >= 0) firstAck = ack;
    }
    // the survivors are the NEWEST: the first ack is already past the 20 seqs
    // that fell off the front (dropping from the BACK would ack 1..4 first)
    expect(firstAck).toBeGreaterThanOrEqual(S - INPUT_QUEUE_CAP + 1);
    // ...and the newest input is reached (a back-drop would top out at the cap)
    expect(ack).toBe(S);
    // ...while exactly INPUT_QUEUE_CAP of them were ever simulated: 20 are gone
    expect(integratedCount(io, 'p1', 0, SIM_DT)).toBe(INPUT_QUEUE_CAP);
    room.stop();
  });

  it('consumes inputs at SIM_HZ, not at SNAPSHOT_HZ', () => {
    const io = new FakeIO();
    const { room } = setupRace(io);
    // Supply faster than the sim tick can drain (SIM_HZ x MAX_INPUTS_PER_TICK =
    // 120/s) but slowly enough that the queue never reaches its cap, at the
    // smallest legal dt so the speedhack budget is nowhere near binding. The
    // drain rate is then purely the sim TICK rate — collapsing both timers onto
    // SNAPSHOT_HZ would cap this at 80/s.
    const PER_STEP = 8;
    const STEPS = 33;
    let seq = 0;
    const t0 = Date.now();
    for (let i = 0; i < STEPS; i++) {
      for (let k = 0; k < PER_STEP; k++) sendInput(room, 'p1', ++seq, { dt: SIM_DT_MIN });
      vi.advanceTimersByTime(60);
    }
    const elapsed = (Date.now() - t0) / 1000;
    // Measured from the POSITION, not from the ack: oversupply overflows the
    // queue, and a front-drop makes the ack skip seqs the server never ran, so
    // the ack rate overstates the drain rate by exactly the dropped count.
    const consumed = integratedCount(io, 'p1', 0, SIM_DT_MIN, 600);
    expect(consumed, 'server state lies on the constant-input trajectory').toBeGreaterThan(0);
    expect(consumed).toBeLessThan(seq); // it really was oversupplied

    const rate = consumed / elapsed;
    expect(rate).toBeGreaterThan(SNAPSHOT_HZ * MAX_INPUTS_PER_TICK * 1.15); // not the 20Hz timer
    expect(rate).toBeGreaterThan(SIM_HZ * MAX_INPUTS_PER_TICK * 0.85);
    expect(rate).toBeLessThan(SIM_HZ * MAX_INPUTS_PER_TICK * 1.15);
    room.stop();
  });
});

describe('KartRoom kart-vs-kart contact', () => {
  it('two karts colliding exchange momentum symmetrically and both hear the bump', () => {
    const io = new FakeIO();
    // p1 slot 0 and p3 slot 2 share a grid column: p3 sits 4m directly behind p1
    const { room, drivers } = setupRace(io, ['p1', 'p2', 'p3']);
    const hitter = drivers[2]!;
    const spawn0 = gridSlot(TRACK, 0);
    const fwdX = -Math.sin(spawn0.yaw);
    const fwdZ = -Math.cos(spawn0.yaw);

    // p1 and p2 send NOTHING, so the server never integrates them: they are
    // exactly stationary and any velocity they gain came from the collision.
    let prev = { a: [0, 0] as [number, number], b: [0, 0] as [number, number] };
    let hitA: [number, number] | null = null;
    let hitB: [number, number] | null = null;
    for (let i = 0; i < 90; i++) {
      // accelerate briefly, then coast in so the impact is (almost) the only
      // thing changing velocity on the collision tick
      hitter.send(room, i < 10 ? { throttle: 1, steer: 0 } : { throttle: 0, steer: 0 });
      vi.advanceTimersByTime(60); // >= 1 sim tick and >= 1 snapshot
      const snap = io.lastSnap('p1');
      const a = snap.players.find((p) => p.id === 'p1')!;
      const b = snap.players.find((p) => p.id === 'p3')!;
      if (Math.hypot(a.v[0], a.v[1]) > 0) {
        hitA = [a.v[0], a.v[1]];
        hitB = [b.v[0], b.v[1]];
        break;
      }
      prev = { a: [a.v[0], a.v[1]], b: [b.v[0], b.v[1]] };
    }
    expect(hitA, 'the rear kart reached the one in front').not.toBeNull();

    const bumps = eventsOfKind(io, 'p1', 'bump');
    expect(bumps.length).toBe(1);
    const ev = bumps[0]!;
    expect(ev.impulse).toBeGreaterThanOrEqual(BUMP_MIN_SPEED);
    // ...and the SAME event reached the other driver: one fact, not two guesses
    const bumps3 = eventsOfKind(io, 'p3', 'bump');
    expect(bumps3.length).toBe(1);
    expect(bumps3[0]).toEqual(ev);
    expect([ev.a, ev.b].sort()).toEqual(['p1', 'p3']);

    // the struck kart's velocity IS the shared impulse: j = (1+e)|v_approach|/2.
    // It never integrates (it sent no input), so nothing else could have set it.
    const j = ((1 + KART_RESTITUTION) * ev.impulse) / 2;
    expect(Math.hypot(hitA![0], hitA![1])).toBeCloseTo(j, 9);
    // shoved FORWARD, along the contact normal
    expect(hitA![0] * fwdX + hitA![1] * fwdZ).toBeGreaterThan(0);

    // equal and opposite along the normal: the hit gains what the hitter loses
    const dA = (hitA![0] - prev.a[0]) * fwdX + (hitA![1] - prev.a[1]) * fwdZ;
    const dB = (hitB![0] - prev.b[0]) * fwdX + (hitB![1] - prev.b[1]) * fwdZ;
    expect(dA).toBeGreaterThan(0);
    expect(dB).toBeLessThan(0);
    expect(Math.abs(dA + dB)).toBeLessThan(0.25 * Math.abs(dA)); // ~conserved

    // the third kart, 4.4m off to the side, was never touched
    const spawn1 = gridSlot(TRACK, 1);
    expect(posOf(io, 'p2')).toEqual([spawn1.x, 0, spawn1.z]);
    room.stop();
  });

  it('resolves EVERY unordered pair: three stacked karts all separate, silently', () => {
    const io = new FakeIO();
    const ids: PlayerId[] = ['p1', 'p2', 'p3'];
    const { room } = setupRace(io, ids);

    stackOnAnchor(room, io, ids); // all three on one point, zero relative velocity
    for (let i = 0; i < 60; i++) tick(); // no further inputs: only contact moves them
    settle();

    const roster = io.lastSnap('p1').players;
    expect(roster.length).toBe(3);
    for (let i = 0; i < 3; i++) {
      const a = roster[i]!;
      // nothing integrates them, so a spurious impulse is the only way to gain speed
      expect(a.v, `${a.id} was never given velocity by a resting pile`).toEqual([0, 0]);
      expect(lateralOf(a.p), `${a.id} inside the barrier band`).toBeLessThanOrEqual(BAND + 1e-9);
      for (let j = i + 1; j < 3; j++) {
        const b = roster[j]!;
        // a pair the loop skips stays overlapped FOREVER here — nothing else
        // can push these karts apart
        expect(
          Math.hypot(a.p[0] - b.p[0], a.p[2] - b.p[2]),
          `${a.id}/${b.id} separated`,
        ).toBeGreaterThanOrEqual(2 * KART_RADIUS - 1e-6);
      }
    }
    // contact at rest has no approach speed: no bump spam for a parked pile
    expect(eventsOfKind(io, 'p1', 'bump').length).toBe(0);
    room.stop();
  });

  it('re-clamps to the barrier after a ZERO-IMPULSE shove: a 20-kart pile stays on the track', () => {
    const io = new FakeIO();
    const ids: PlayerId[] = Array.from({ length: MAX_PLAYERS }, (_, i) => `p${i + 1}`);
    const { room } = setupRace(io, ids);

    stackOnAnchor(room, io, ids);
    // Two stacked karts can only ever push each other 0.9m apart, which no
    // barrier can be that close to — it takes a full grid pile for the chained
    // splits to reach the wall. Every one of those pairs is TOUCHING BUT
    // SEPARATING, i.e. resolveKartPair moves them and returns impulse 0, so a
    // clamp that only runs on impulse > 0 never runs at all here: unclamped,
    // this pile spreads to ~9.6m of lateral offset, ~4m outside the barrier.
    for (let i = 0; i < 150; i++) tick();
    settle();

    const roster = io.lastSnap('p1').players;
    expect(roster.length).toBe(MAX_PLAYERS);
    const gate0 = TRACK.gates[0]!;
    let spread = 0;
    for (let i = 0; i < roster.length; i++) {
      const a = roster[i]!;
      expect(lateralOf(a.p), `${a.id} inside the barrier band`).toBeLessThanOrEqual(BAND + 1e-9);
      // setup guard: everyone really did stack on gate 0's anchor
      expect(
        Math.hypot(a.p[0] - gate0.x, a.p[2] - gate0.z),
        `${a.id} respawned onto the shared anchor`,
      ).toBeLessThan(20);
      for (let j = i + 1; j < roster.length; j++) {
        const b = roster[j]!;
        spread = Math.max(spread, Math.hypot(a.p[0] - b.p[0], a.p[2] - b.p[2]));
      }
    }
    // ...and the pile genuinely unpacked itself (a clamp that collapsed every
    // kart onto one point would satisfy the band check vacuously)
    expect(spread).toBeGreaterThan(10);
    room.stop();
  });
});

describe('KartRoom gates + laps', () => {
  it('credits the expected gate in order when the kart drives through it', () => {
    const io = new FakeIO();
    const { room, drivers } = setupRace(io);
    const d = drivers[0]!;

    const steps = driveUntil(room, io, [d], () => io.lastSnap('p1').you.progress >= 1, 400);
    expect(steps, 'p1 reaches gate 1').toBeGreaterThan(0);
    settle();

    const you = io.lastSnap('p1').you;
    expect(you.nextGate).toBe(2);
    expect(you.progress).toBe(1);

    const gates = eventsOfKind(io, 'p1', 'gate').filter((e) => e.playerId === 'p1');
    expect(gates.length).toBe(1);
    expect(gates[0]?.gate).toBe(1);
    room.stop();
  });

  it('driving BACKWARDS over gates 0 and 7 credits nothing: only the expected gate counts', () => {
    const io = new FakeIO();
    const { room, drivers } = setupRace(io);
    const d = drivers[0]!;
    room.removePlayer('p2'); // solo track: no parked kart to bump into on the way back

    // reverse away from the line; pursuitSteer mirrors itself below REVERSE_FLIP
    let near0 = Infinity;
    let near7 = Infinity;
    for (let i = 0; i < 600; i++) {
      d.send(room, { throttle: 0, brake: 1 });
      tick();
      near0 = Math.min(near0, distToGate(d.twin.x, d.twin.z, 0));
      near7 = Math.min(near7, distToGate(d.twin.x, d.twin.z, 7));
    }
    settle();

    // it PHYSICALLY drove through two gates — they simply were not the expected
    // one (gate 0 is the line the grid sits behind; gate 7 is a real detour)
    expect(near0).toBeLessThan(GATE_RADIUS);
    expect(near7).toBeLessThan(GATE_RADIUS);
    expect(io.lastSnap('p1').you.progress).toBe(0);
    expect(io.lastSnap('p1').you.nextGate).toBe(1);
    expect(eventsOfKind(io, 'p1', 'gate').filter((e) => e.playerId === 'p1').length).toBe(0);

    // forward again: gate 1 credits normally
    const steps = driveUntil(room, io, [d], () => io.lastSnap('p1').you.progress >= 1, 900);
    expect(steps, 'p1 recovers and reaches gate 1').toBeGreaterThan(0);
    settle();
    expect(io.lastSnap('p1').you.progress).toBe(1);
    expect(io.lastSnap('p1').you.nextGate).toBe(2);
    room.stop();
  });

  it('8 gates x 3 laps driven for real finishes: place 1, finishMs > 0', () => {
    const io = new FakeIO();
    const { room, drivers } = setupRace(io);
    const d = drivers[0]!;
    // the race runs on with one kart (docs/KART.md "Low pop"); dropping p2 also
    // clears the grid, so lap 2 does not T-bone a kart parked on the line
    room.removePlayer('p2');

    const steps = driveUntil(room, io, [d], () => io.lastSnap('p1').you.finished, 3600);
    expect(steps, 'p1 completes the race').toBeGreaterThan(0);
    settle();

    const you = io.lastSnap('p1').you;
    expect(you.finished).toBe(true);
    expect(you.finishMs).toBeGreaterThan(0);
    expect(you.progress).toBe(LAPS_TO_WIN * GATES);

    const finishes = eventsOfKind(io, 'p1', 'finish');
    expect(finishes.length).toBe(1);
    expect(finishes[0]?.playerId).toBe('p1');
    expect(finishes[0]?.place).toBe(1);

    // every gate of every lap was credited, in order
    const gates = eventsOfKind(io, 'p1', 'gate').filter((e) => e.playerId === 'p1');
    expect(gates.length).toBe(LAPS_TO_WIN * GATES);
    expect(gates.map((e) => e.gate)).toEqual(
      Array.from({ length: LAPS_TO_WIN * GATES }, (_, i) => (i + 1) % GATES),
    );

    const laps = eventsOfKind(io, 'p1', 'lap').filter((e) => e.playerId === 'p1');
    expect(laps.length).toBe(LAPS_TO_WIN);
    expect(io.lastSnap('p1').you.bestLapMs).toBe(Math.min(...laps.map((e) => e.lapMs)));
    room.stop();
  });
});

describe('KartRoom race end', () => {
  it('results last 10s, then the room resets to lobby keeping players, clearing progress, and WAITS', () => {
    const io = new FakeIO();
    const { room, drivers } = setupRace(io);
    const d = drivers[0]!;

    driveUntil(room, io, [d], () => io.lastSnap('p1').you.progress >= 2, 800);
    const live = io.lastSnap('p1');
    vi.advanceTimersByTime(live.phaseEndsAt - live.serverTime + 500); // nobody finishes
    expect(io.lastSnap('p1').phase).toBe('results');
    expect(eventsOfKind(io, 'p1', 'timeout').length).toBe(1);
    expect(room.playerCount()).toBe(2); // both still seated through results

    vi.advanceTimersByTime(RESULTS_SECONDS * 1000 - 3000); // ~7s in: still results
    expect(io.lastSnap('p1').phase).toBe('results');
    vi.advanceTimersByTime(4000); // past the 10s mark
    expect(io.lastSnap('p1').phase).toBe('lobby');
    expect(room.info().phase).toBe('lobby');
    expect(room.playerCount()).toBe(2); // both kept across the reset

    const you = io.lastSnap('p1').you; // race state cleared for the next race
    expect(you.progress).toBe(0);
    expect(you.finished).toBe(false);
    expect(you.finishMs).toBe(-1);
    // ...and the kart is back on its grid slot, at rest
    const spawn = gridSlot(TRACK, 0);
    expect(posOf(io, 'p1')).toEqual([spawn.x, 0, spawn.z]);
    expect(you.sim.vx).toBe(0);
    expect(you.sim.vz).toBe(0);

    // ...and it STAYS there: a full lobby after a race never re-arms itself
    vi.advanceTimersByTime((READY_SECONDS + COUNTDOWN_SECONDS) * 1000 + 5000);
    expect(io.lastSnap('p1').phase).toBe('lobby');
    expect(io.lastSnap('p1').canStart).toBe(true); // startable, just not started

    room.handleMessage('p2', { t: 'start' }); // the NEXT race is another explicit press
    advanceToPhase(io, 'p1', 'ready');
    room.stop();
  });

  it('every connected kart finishing ends the race with an ordered finish list', () => {
    const io = new FakeIO();
    const { room, drivers } = setupRace(io);
    const [p1, p2] = drivers as [Driver, Driver];

    drive(room, [p1], 200); // stagger the field so the two never touch
    driveUntil(room, io, [p1, p2], () => io.lastSnap('p2').you.finished, 3600);
    settle();

    expect(io.lastSnap('p1').you.finished).toBe(true);
    const finishes = eventsOfKind(io, 'p1', 'finish');
    expect(finishes.map((e) => e.playerId)).toEqual(['p1', 'p2']);
    expect(finishes.map((e) => e.place)).toEqual([1, 2]);
    expect(io.lastSnap('p1').you.place).toBe(1);
    expect(io.lastSnap('p2').you.place).toBe(2);
    // all connected players home => the race ends immediately, no timeout wait
    expect(io.lastSnap('p1').phase).toBe('results');
    expect(eventsOfKind(io, 'p1', 'timeout').length).toBe(0);
    expect(room.playerCount()).toBe(2);
    room.stop();
  });

  it('a mid-race joiner seats at the back with progress 0 and races too', () => {
    const io = new FakeIO();
    const { room, drivers } = setupRace(io);
    const d = drivers[0]!;

    // distinct progress so places are unambiguous: p1 ahead, p2 still on the grid
    driveUntil(room, io, [d], () => io.lastSnap('p1').you.progress >= 1, 400);

    room.addPlayer('p3', 'Carol');
    const joined = io.joined('p3');
    expect(joined.phase).toBe('racing');
    expect(joined.players.map((p) => p.id)).toEqual(['p1', 'p2', 'p3']);

    settle();
    const snap = io.lastSnap('p3');
    expect(snap.you.progress).toBe(0);
    expect(snap.you.lap).toBe(1);
    expect(snap.you.finished).toBe(false);
    expect(snap.you.place).toBe(3); // the back of the grid (slot 2 is furthest back)

    const self = snap.players.find((p) => p.id === 'p3');
    expect(self?.progress).toBe(0);
    expect(self?.place).toBe(3);
    // and it spawned on grid slot 2, not at the origin
    const spawn2 = gridSlot(TRACK, 2);
    expect(self?.p).toEqual([spawn2.x, 0, spawn2.z]);
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
  it('inputs during ready/countdown are ACKED but never integrated; the kart moves only after GO', () => {
    const io = new FakeIO();
    const room = new KartRoom(DEFAULT_TRACK_ID, 'public', io);
    room.addPlayer('p1', 'Alpha');
    room.addPlayer('p2', 'Bravo');
    room.start();
    room.handleMessage('p1', { t: 'start' }); // explicit start: nothing auto-starts
    const d = new Driver('p1', 0);
    const spawn = gridSlot(TRACK, 0);

    advanceToPhase(io, 'p1', 'ready');
    for (let i = 0; i < 20; i++) {
      d.send(room, { throttle: 1, steer: 0.8 });
      tick();
    }
    settle();
    expect(posOf(io, 'p1')).toEqual([spawn.x, 0, spawn.z]); // EXACTLY on the grid
    // the wheel angle is client-supplied too, so it freezes with everything else
    expect(snapOf(io, 'p1').steer).toBe(0);
    // ...but the ack advanced, so the client's replay queue still drains
    expect(io.lastSnap('p1').you.lastProcessedSeq).toBeGreaterThan(0);

    advanceToPhase(io, 'p1', 'countdown');
    for (let i = 0; i < 20; i++) {
      d.send(room, { throttle: 1, steer: -0.8 });
      tick();
    }
    settle();
    expect(posOf(io, 'p1')).toEqual([spawn.x, 0, spawn.z]);
    expect(snapOf(io, 'p1').steer).toBe(0);

    advanceToPhase(io, 'p1', 'racing');
    expect(posOf(io, 'p1')).toEqual([spawn.x, 0, spawn.z]); // GO re-wiped the grid
    // GO also ACKED the whole pre-GO backlog: nothing from it may apply now
    expect(io.lastSnap('p1').you.lastProcessedSeq).toBe(d.lastSeq());

    d.regrid(); // the twin re-bases on the grid exactly like the server did
    drive(room, [d], 40);
    const last = d.send(room, { steer: 0.5 }); // ...and now steer tracks again
    tick();
    settle();
    const self = snapOf(io, 'p1');
    expect(Math.hypot(self.p[0] - spawn.x, self.p[2] - spawn.z)).toBeGreaterThan(5);
    expect(self.p[0]).toBeCloseTo(d.twin.x, 9);
    expect(self.p[2]).toBeCloseTo(d.twin.z, 9);
    expect(self.steer).toBe(last.steer);
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
    settle(); // let a snapshot land on top of the events

    expect(nitroEvents().map((e) => e.left)).toEqual([2, 1, 0]);
    expect(io.lastSnap('p1').you.nitroLeft).toBe(0);
    expect(selfNitroActive()).toBe(true);

    room.handleMessage('p1', { t: 'nitro' }); // no charges left: silently ignored
    settle();
    expect(nitroEvents().length).toBe(3);
    expect(io.lastSnap('p1').you.nitroLeft).toBe(0);
    expect(selfNitroActive()).toBe(true); // still inside the last charge's window

    vi.advanceTimersByTime(NITRO_TIME * 1000 + 200); // past the boost window
    expect(selfNitroActive()).toBe(false);
    room.stop();
  });

  it("applies the boost to the SERVER's sim: a boosted kart outruns the identical unboosted twin", () => {
    const io = new FakeIO();
    const { room, drivers } = setupRace(io);
    const d = drivers[0]!;

    drive(room, [d], 40); // both up to the same speed on identical inputs
    settle();
    expect(io.lastSnap('p1').you.sim.nitroLeft).toBe(0);
    const before = snapOf(io, 'p1');
    expect(Math.hypot(before.v[0], before.v[1])).toBeCloseTo(Math.hypot(d.twin.vx, d.twin.vz), 9);

    room.handleMessage('p1', { t: 'nitro' }); // the twin never gets the charge
    settle();
    expect(io.lastSnap('p1').you.sim.nitroLeft).toBeGreaterThan(0);

    drive(room, [d], 20); // ~0.7s into the boost
    settle();
    const boosted = snapOf(io, 'p1');
    const serverSpeed = Math.hypot(boosted.v[0], boosted.v[1]);
    const twinSpeed = Math.hypot(d.twin.vx, d.twin.vz);
    expect(serverSpeed).toBeGreaterThan(twinSpeed + 3); // the server really burned it

    drive(room, [d], Math.ceil(NITRO_TIME / SIM_DT) + 10); // past the whole charge
    settle();
    expect(io.lastSnap('p1').you.sim.nitroLeft).toBe(0); // burned down by the sim
    room.stop();
  });
});

describe('KartRoom gap timing', () => {
  it('the gap to the kart ahead is the real gate-crossing delta', () => {
    const io = new FakeIO();
    const { room, drivers } = setupRace(io);
    const p1 = drivers[0]!;
    const p2 = drivers[1]!;

    driveUntil(room, io, [p1], () => io.lastSnap('p1').you.progress >= 1, 400);
    const t1 = Date.now(); // p1 crossed gate 1 about now
    driveUntil(room, io, [p1], () => io.lastSnap('p1').you.progress >= 2, 800);
    vi.advanceTimersByTime(2000); // p1 parks; nobody moves without inputs
    driveUntil(room, io, [p2], () => io.lastSnap('p2').you.progress >= 1, 900);
    const t2 = Date.now(); // p2 crossed the SAME gate this much later
    settle();

    const p2you = io.lastSnap('p2').you;
    expect(p2you.place).toBe(2);
    // both have a timestamp for credit #1, so the gap is the real delta, not
    // the 20m/s spatial estimate
    expect(p2you.gapAheadMs).toBeGreaterThan(0);
    expect(Math.abs(p2you.gapAheadMs - (t2 - t1))).toBeLessThan(300);

    const p1you = io.lastSnap('p1').you;
    expect(p1you.place).toBe(1);
    expect(p1you.gapAheadMs).toBe(0); // leader has nobody ahead
    room.stop();
  });

  it('gapAheadMs is 0 in every non-racing phase (lobby/ready/countdown/results)', () => {
    const io = new FakeIO();
    const room = new KartRoom(DEFAULT_TRACK_ID, 'public', io);
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
    vi.advanceTimersByTime(RACE_TIMEOUT_S * 1000 + 2000);
    expect(io.lastSnap('p1').phase).toBe('results');
    expect(io.lastSnap('p1').you.gapAheadMs).toBe(0);
    room.stop();
  });
});

describe('KartRoom robustness', () => {
  it('never throws on junk, and junk never moves a kart', () => {
    const io = new FakeIO();
    const { room, drivers } = setupRace(io);
    const d = drivers[0]!;
    drive(room, [d], 20);
    settle();
    const before = posOf(io, 'p1');

    // every one of these is REJECTED by the parser, so none of them may reach
    // the room at all — no seq is consumed and the kart may not twitch
    const junk: unknown[] = [
      null,
      undefined,
      42,
      'hello',
      [],
      {},
      { t: 'kart_input' },
      { t: 'kart_input', seq: NaN, throttle: 1, brake: 0, steer: 0 },
      { t: 'kart_input', seq: 1, throttle: Infinity, brake: 0, steer: 0 },
      { t: 'kart_input', seq: 1, throttle: 1, brake: 0, steer: -Infinity },
      { t: 'kart_state', seq: 1, p: [0, 0, 0], yaw: 0, v: [0, 0], steer: 0, drift: false },
      { t: 'unknown' },
    ];
    for (const m of junk) {
      expect(parseKartC2S(m)).toBeNull();
      expect(() => room.handleMessage('p1', m)).not.toThrow();
    }
    settle();

    expect(posOf(io, 'p1')).toEqual(before); // not one millimetre
    expect(io.lastSnap('p1').phase).toBe('racing');
    room.stop();
  });

  it('clamps a hostile-but-parseable input, and its absurd seq only poisons its own sender', () => {
    const io = new FakeIO();
    // p2 is the guinea pig: a 1e9 seq permanently raises that player's monotonic
    // gate, so it gets its OWN player rather than wrecking every later assertion
    const { room } = setupRace(io, ['p1', 'p2']);
    const spawn = gridSlot(TRACK, 1);

    const hostile = {
      t: 'kart_input',
      seq: 1e9,
      throttle: 5,
      brake: -3,
      steer: 42,
      drift: 'yes',
      respawn: 0,
      dt: 1e6, // a million seconds of simulation, please
    };
    const parsed = parseKartC2S(hostile);
    expect(parsed).toEqual({
      t: 'kart_input',
      seq: 1e9,
      throttle: 1,
      brake: 0,
      steer: 1,
      drift: false, // only `true` is true
      respawn: false,
      dt: SIM_DT_MAX, // NOT 1e6
    });

    room.handleMessage('p2', hostile);
    settle();
    const after = posOf(io, 'p2');
    // one clamped tick of motion at most — a 1e6s dt would have left the planet
    expect(Math.hypot(after[0] - spawn.x, after[2] - spawn.z)).toBeLessThan(1);
    expect(io.lastSnap('p2').you.lastProcessedSeq).toBe(1e9);

    // and the gate now holds: anything below that seq is dropped outright
    room.handleMessage('p2', { t: 'kart_input', seq: 5, throttle: 1, brake: 0, steer: 0, dt: SIM_DT });
    settle();
    expect(posOf(io, 'p2')).toEqual(after);
    expect(io.lastSnap('p2').you.lastProcessedSeq).toBe(1e9);
    // p1, untouched by any of it, is still exactly on its own grid slot
    const spawn0 = gridSlot(TRACK, 0);
    expect(posOf(io, 'p1')).toEqual([spawn0.x, 0, spawn0.z]);
    room.stop();
  });

  it('stale players are reported once nothing arrives for INPUT_STALE_MS', () => {
    const io = new FakeIO();
    const { room, drivers } = setupRace(io);
    drive(room, [drivers[0]!], 10);
    expect(room.stalePlayers()).toEqual([]); // p2 joined recently too

    vi.advanceTimersByTime(11_000);
    expect(room.stalePlayers().sort()).toEqual(['p1', 'p2']);
    room.stop();
  });
});

// ==============================================================================
// MULTI-TRACK CONTRACT — trackId travels on kart_joined and every kart_snapshot,
// and the lobby label names the circuit instead of a generic "circuit" placeholder.
// ==============================================================================
describe('KartRoom multi-track contract', () => {
  it('kart_joined and every kart_snapshot carry trackId for a default-track room', () => {
    const io = new FakeIO();
    const room = new KartRoom(DEFAULT_TRACK_ID, 'public', io);
    room.addPlayer('p1', 'Alpha');
    expect(io.joined('p1').trackId).toBe(DEFAULT_TRACK_ID);

    room.start();
    settle();
    expect(io.lastSnap('p1').trackId).toBe(DEFAULT_TRACK_ID);

    room.addPlayer('p2', 'Bravo');
    expect(io.joined('p2').trackId).toBe(DEFAULT_TRACK_ID);
    settle();
    expect(io.lastSnap('p1').trackId).toBe(DEFAULT_TRACK_ID);
    expect(io.lastSnap('p2').trackId).toBe(DEFAULT_TRACK_ID);
    room.stop();
  });

  it('room.info().label names the circuit', () => {
    const io = new FakeIO();
    const room = new KartRoom(DEFAULT_TRACK_ID, 'public', io);
    expect(room.info().label).toBe(`3 laps · ${TRACKS[DEFAULT_TRACK_ID].name}`);
    room.stop();
  });
});

// ==============================================================================
// kartModule settings validation (games/kart/server/src/module.ts trackIdFrom):
// absent settings default to DEFAULT_TRACK_ID; an invalid trackId THROWS, which
// the platform lobby turns into 'bad_settings' — mirrors fps's mapIdFrom.
// ==============================================================================
describe('kartModule settings validation', () => {
  function fakeIo(): RoomIO {
    return {
      send() {
        /* no-op */
      },
      rttMs() {
        return 0;
      },
    };
  }

  it('accepts a known trackId and defaults when settings are absent', () => {
    const withTrack = kartModule.createRoom({
      visibility: 'public',
      io: fakeIo(),
      settings: { trackId: 'greenvale' },
    }) as KartRoom;
    expect(withTrack.trackId).toBe('greenvale');
    withTrack.stop();

    const withoutSettings = kartModule.createRoom({
      visibility: 'public',
      io: fakeIo(),
    }) as KartRoom;
    expect(withoutSettings.trackId).toBe(DEFAULT_TRACK_ID);
    withoutSettings.stop();
  });

  it('throws on an unknown or malformed trackId (the lobby turns this into bad_settings)', () => {
    expect(() =>
      kartModule.createRoom({ visibility: 'public', io: fakeIo(), settings: { trackId: 'nope' } }),
    ).toThrow();
    expect(() =>
      kartModule.createRoom({ visibility: 'public', io: fakeIo(), settings: { trackId: 42 } }),
    ).toThrow();
    expect(() =>
      kartModule.createRoom({ visibility: 'public', io: fakeIo(), settings: { trackId: null } }),
    ).toThrow();
  });
});
