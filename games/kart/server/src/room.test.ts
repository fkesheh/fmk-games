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
  CHAMPIONSHIP_DEFAULT,
  COUNTDOWN_SECONDS,
  DEFAULT_SEASON_ROUNDS,
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
  POINTS_TABLE,
  RACE_TIMEOUT_S,
  READY_SECONDS,
  RESULTS_SECONDS,
  SEASON_ROUNDS_MAX,
  SEASON_ROUNDS_MIN,
  SIM_BUDGET_MUL,
  SIM_DT,
  SIM_DT_MAX,
  SIM_DT_MIN,
  SIM_HZ,
  SNAPSHOT_HZ,
  buildCalendar,
  buildTrack,
  closestOnTrack,
  compareSeason,
  defaultKartRoomSettings,
  DEFAULT_TRACK_ID,
  gridSlot,
  makeAssistState,
  makeSim,
  parseKartC2S,
  parseKartRoomSettings,
  pointsForPlace,
  pursuitSteer,
  resetSim,
  stepDrive,
  TRACK_LIST,
  TRACKS,
} from '@kart/shared';
import type {
  KartInputMsg,
  KartPhase,
  KartS2C,
  KartSeason,
  KartSeasonSettings,
  KartSim,
  KartStandingRow,
  RaceEvent,
  SeasonSortKey,
  TrackDef,
  TrackId,
} from '@kart/shared';
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

  /**
   * EVERY snapshot this player ever received. `lastSnap` proves a value is
   * right once; this proves an invariant held on all of them — the difference
   * between "the championship is null now" and "this room never once shipped a
   * championship".
   */
  snaps(id: PlayerId): SnapshotMsg[] {
    return (this.log.get(id) ?? []).filter((m): m is SnapshotMsg => m.t === 'kart_snapshot');
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

/** The same TrackDef the room builds for a given circuit id. */
function trackFor(id: TrackId): TrackDef {
  return buildTrack(TRACKS[id]);
}

/**
 * The default circuit — what every non-championship test drives on. A
 * championship room changes circuit between rounds, so those tests build their
 * drivers on `trackFor(room.trackId)` (the LIVE one) instead.
 */
const TRACK = trackFor(DEFAULT_TRACK_ID);
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
  private assist = makeAssistState();
  private seq = 0;

  constructor(
    readonly id: PlayerId,
    readonly slot: number,
    /** The circuit this kart is racing — a championship round is not always TRACK. */
    private track: TrackDef = TRACK,
  ) {
    const g = gridSlot(track, slot);
    this.twin = makeSim(g.x, g.z, g.yaw);
  }

  /** Re-base the twin on the grid slot — exactly what the room's GO wipe does. */
  regrid(): void {
    const g = gridSlot(this.track, this.slot);
    resetSim(this.twin, g.x, g.z, g.yaw);
  }

  /**
   * Adopt the circuit the room has moved to (a championship changes circuit
   * between rounds) and re-grid the twin on it, steering assist included.
   *
   * `seq` deliberately KEEPS COUNTING. It is per-connection monotonic, and the
   * room carries its ack watermark across a race (GO acks the whole pre-race
   * backlog), so a driver that restarted its numbering each round would have
   * every input of round 2 dropped as already-processed — the kart would sit on
   * the grid while its twin drove off, which reads exactly like a stuck kart.
   */
  retrack(track: TrackDef): void {
    this.track = track;
    this.assist = makeAssistState();
    this.regrid();
  }

  lastSeq(): number {
    return this.seq;
  }

  /** Next pure-pursuit input; `over` replaces any field (reverse, coast, ...). */
  input(over: Partial<KartInputMsg> = {}): KartInputMsg {
    const steer = pursuitSteer(this.track, this.twin, this.assist, SIM_DT);
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
    stepDrive(this.twin, inp, inp.dt, this.track);
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
    // a default room IS a championship room, so the room list advertises the
    // ROUND a joiner would be walking into, not the lap count (e.g. "R1/8 ·
    // Greenvale Ring"); the old "3 laps · ..." form survives only on a room
    // booked with { championship: false } — pinned in the championship block
    expect(room.info().label).toBe(`R1/${DEFAULT_SEASON_ROUNDS} · ${TRACKS[DEFAULT_TRACK_ID].name}`);
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
    // ...and the kart is back on its grid slot, at rest. On the circuit the
    // room is ABOUT to race, not the one it just left: this is a championship
    // room (the default), so the reset that clears the race also advances the
    // calendar, and "back on the grid" means the NEXT round's grid.
    const spawn = gridSlot(trackFor(room.trackId), 0);
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

  it('room.info().label names the circuit (and, on a championship room, the round)', () => {
    const io = new FakeIO();
    const room = new KartRoom(DEFAULT_TRACK_ID, 'public', io);
    expect(room.info().label).toBe(`R1/${DEFAULT_SEASON_ROUNDS} · ${TRACKS[DEFAULT_TRACK_ID].name}`);
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

// ==============================================================================
// CHAMPIONSHIP — THE PURE RULEBOOK (shared/protocol.ts).
//
// Scoring, the tie-break, the calendar and the settings validator are pure
// functions precisely so they can be pinned here in microseconds, without a
// kart moving. Everything the room block below asserts is built on top of
// these, so if one of them is wrong the whole championship is wrong in a way
// no amount of driving would localise.
// ==============================================================================
describe('championship rules (pure)', () => {
  /** A standings key with everything at its "has never raced" value. */
  interface NamedKey extends SeasonSortKey {
    id: string;
  }
  function key(id: string, over: Partial<SeasonSortKey> = {}): NamedKey {
    return { id, points: 0, wins: 0, bestFinish: 0, seq: 0, ...over };
  }
  const orderOf = (rows: readonly NamedKey[]): string[] =>
    [...rows].sort(compareSeason).map((r) => r.id);

  /** Every arrangement of `xs` — used to prove a comparator is a TOTAL order. */
  function permutations<T>(xs: readonly T[]): T[][] {
    if (xs.length <= 1) return [[...xs]];
    const out: T[][] = [];
    xs.forEach((x, i) => {
      for (const rest of permutations([...xs.slice(0, i), ...xs.slice(i + 1)])) out.push([x, ...rest]);
    });
    return out;
  }

  it('pointsForPlace pays the F1 table for the top ten and nothing anywhere else', () => {
    POINTS_TABLE.forEach((pts, i) => expect(pointsForPlace(i + 1)).toBe(pts));
    // the table must actually REWARD a better place: a flat (or inverted) one
    // would make every scoring assertion in this file vacuously true
    for (let i = 1; i < POINTS_TABLE.length; i++) {
      expect(POINTS_TABLE[i - 1]!).toBeGreaterThan(POINTS_TABLE[i]!);
    }
    // a finish, but not a scoring one
    expect(pointsForPlace(POINTS_TABLE.length + 1)).toBe(0);
    expect(pointsForPlace(MAX_PLAYERS)).toBe(0); // the last kart of a full grid
    // ...and anything that is not a 1-based place scores nothing rather than
    // reading off the end of the table or throwing
    expect(pointsForPlace(0)).toBe(0);
    expect(pointsForPlace(-1)).toBe(0);
    expect(pointsForPlace(Number.NaN)).toBe(0);
    expect(pointsForPlace(Number.POSITIVE_INFINITY)).toBe(0);
    expect(pointsForPlace(1.5)).toBe(pointsForPlace(1)); // floored, never interpolated
  });

  it('the tie-break ladder is points, then wins, then best finish, then join order', () => {
    // rung 0: POINTS beat everything — one more point outranks a race winner
    expect(
      orderOf([
        key('winner', { points: POINTS_TABLE[0]!, wins: 1, bestFinish: 1, seq: 0 }),
        key('steady', { points: POINTS_TABLE[0]! + 1, wins: 0, bestFinish: 2, seq: 1 }),
      ]),
    ).toEqual(['steady', 'winner']);

    // rung 1: level on points, the countback goes to WINS (F1 art. 7.2)
    expect(
      orderOf([
        key('consistent', { points: 50, wins: 0, bestFinish: 2, seq: 0 }),
        key('spiky', { points: 50, wins: 2, bestFinish: 1, seq: 1 }),
      ]),
    ).toEqual(['spiky', 'consistent']);

    // rung 2: level on points AND wins, the better single finish decides
    expect(
      orderOf([
        key('bestIsFifth', { points: 20, wins: 0, bestFinish: 5, seq: 0 }),
        key('bestIsSecond', { points: 20, wins: 0, bestFinish: 2, seq: 1 }),
      ]),
    ).toEqual(['bestIsSecond', 'bestIsFifth']);

    // bestFinish 0 is "NEVER FINISHED", not "place zero": it must rank below the
    // worst real finish there is, not sort to the front as a small number would
    expect(
      orderOf([
        key('neverHome', { bestFinish: 0, seq: 0 }),
        key('lastButHome', { bestFinish: MAX_PLAYERS, seq: 1 }),
      ]),
    ).toEqual(['lastButHome', 'neverHome']);

    // rung 3: level all the way down, the earliest driver to appear this season
    // wins — and `seq` is unique, so this rung can never itself tie
    expect(orderOf([key('late', { seq: 7 }), key('early', { seq: 2 }), key('mid', { seq: 4 })])).toEqual([
      'early',
      'mid',
      'late',
    ]);
    expect(compareSeason(key('early', { seq: 2 }), key('late', { seq: 7 }))).toBeLessThan(0);
    expect(compareSeason(key('late', { seq: 7 }), key('early', { seq: 2 }))).toBeGreaterThan(0);
  });

  it('the standings have exactly ONE valid arrangement, whatever order the rows arrive in', () => {
    // five drivers that tie at every rung except the last one that separates them
    const rows: NamedKey[] = [
      key('a', { points: 43, wins: 1, bestFinish: 1, seq: 0 }),
      key('b', { points: 43, wins: 1, bestFinish: 1, seq: 3 }), // separated from a by seq only
      key('c', { points: 43, wins: 0, bestFinish: 1, seq: 1 }), // fewer wins
      key('d', { points: 43, wins: 0, bestFinish: 4, seq: 2 }), // worse best finish
      key('e', { points: 0, wins: 0, bestFinish: 0, seq: 4 }), // never scored, never finished
    ];
    const canonical = orderOf(rows);
    expect(canonical).toEqual(['a', 'b', 'c', 'd', 'e']);

    // idempotent: re-sorting a sorted table cannot reshuffle equals
    expect(orderOf([...rows].sort(compareSeason))).toEqual(canonical);
    // total: EVERY input permutation lands on the same arrangement, so two rooms
    // holding the same rows can never disagree about the championship order
    const perms = permutations(rows);
    expect(perms.length).toBe(120);
    for (const p of perms) expect(orderOf(p)).toEqual(canonical);
  });

  it('the calendar is `rounds` circuits of the registry rotation, starting at the room track and wrapping', () => {
    const ids = TRACK_LIST.map((t) => t.id);
    const first = ids[0]!;
    const last = ids[ids.length - 1]!;

    const full = buildCalendar(first, SEASON_ROUNDS_MAX);
    expect(full.length).toBe(SEASON_ROUNDS_MAX); // a full season however short the registry is
    expect(full[0]).toBe(first); // round 1 is the circuit the room was booked on
    // registry order, wrapping: with one circuit registered that is the same
    // circuit every round; with eight it is eight different ones, no code change
    full.forEach((id, i) => expect(id).toBe(ids[i % ids.length]));

    // starting elsewhere ROTATES the rotation, it never reorders it
    const rotated = buildCalendar(last, SEASON_ROUNDS_MAX);
    expect(rotated[0]).toBe(last);
    rotated.forEach((id, i) => expect(id).toBe(ids[(ids.length - 1 + i) % ids.length]));

    // a shorter season is a PREFIX of the same calendar — the rest is not
    // "missing", the season is simply shorter
    expect(buildCalendar(first, SEASON_ROUNDS_MIN)).toEqual(full.slice(0, SEASON_ROUNDS_MIN));
    expect(buildCalendar(first, SEASON_ROUNDS_MIN).length).toBe(SEASON_ROUNDS_MIN);
  });

  it('parseKartRoomSettings defaults an absent bag and accepts every documented value', () => {
    expect(parseKartRoomSettings(undefined)).toEqual(defaultKartRoomSettings());
    expect(parseKartRoomSettings({})).toEqual(defaultKartRoomSettings());
    expect(defaultKartRoomSettings().season).toEqual({
      championship: CHAMPIONSHIP_DEFAULT,
      rounds: DEFAULT_SEASON_ROUNDS,
    });

    // a registered circuit is taken and leaves the season half at its defaults
    const someTrack = TRACK_LIST[TRACK_LIST.length - 1]!.id;
    expect(parseKartRoomSettings({ trackId: someTrack })).toEqual(defaultKartRoomSettings(someTrack));

    // the championship can be switched off; `rounds` is ACCEPTED (and ignored)
    // beside it, so a client may send both fields unconditionally
    expect(parseKartRoomSettings({ championship: false })).toEqual({
      trackId: DEFAULT_TRACK_ID,
      season: { championship: false, rounds: DEFAULT_SEASON_ROUNDS },
    });
    expect(parseKartRoomSettings({ championship: false, rounds: SEASON_ROUNDS_MIN }).season).toEqual({
      championship: false,
      rounds: SEASON_ROUNDS_MIN,
    });

    // a short season, and both ends of the legal band
    expect(parseKartRoomSettings({ rounds: 3 }).season).toEqual({
      championship: CHAMPIONSHIP_DEFAULT,
      rounds: 3,
    });
    expect(parseKartRoomSettings({ rounds: SEASON_ROUNDS_MIN }).season.rounds).toBe(SEASON_ROUNDS_MIN);
    expect(parseKartRoomSettings({ rounds: SEASON_ROUNDS_MAX }).season.rounds).toBe(SEASON_ROUNDS_MAX);
  });

  it('parseKartRoomSettings THROWS on everything the lobby must reject as bad_settings', () => {
    expect(() => parseKartRoomSettings({ trackId: 'nope' })).toThrow();
    expect(() => parseKartRoomSettings({ trackId: 42 })).toThrow();
    expect(() => parseKartRoomSettings({ trackId: null })).toThrow();

    // `championship` is a BOOLEAN, not a truthy value: coercing '1' or 1 into
    // "on" would silently give a room a season its creator never asked for
    expect(() => parseKartRoomSettings({ championship: 'true' })).toThrow();
    expect(() => parseKartRoomSettings({ championship: 1 })).toThrow();
    expect(() => parseKartRoomSettings({ championship: null })).toThrow();

    // `rounds` is an INTEGER inside the band — never clamped, never floored
    expect(() => parseKartRoomSettings({ rounds: SEASON_ROUNDS_MIN - 1 })).toThrow();
    expect(() => parseKartRoomSettings({ rounds: SEASON_ROUNDS_MAX + 1 })).toThrow();
    expect(() => parseKartRoomSettings({ rounds: 2.5 })).toThrow();
    expect(() => parseKartRoomSettings({ rounds: '3' })).toThrow();
    expect(() => parseKartRoomSettings({ rounds: Number.NaN })).toThrow();
    expect(() => parseKartRoomSettings({ rounds: Number.POSITIVE_INFINITY })).toThrow();
  });
});

// ==============================================================================
// CHAMPIONSHIP — THE ROOM HALF.
//
// The season is read ONLY off the wire (`snapshot.championship`), never off the
// room's fields: the standings ARE a contract with the client, and a test that
// reached inside could not tell a broken snapshot from a broken table.
//
// Full 3-lap races cost ~3000 sim ticks each, so they are spent deliberately:
// the four-kart grid and the two-round title decider are driven for real, and
// every other round here ends the cheap way — either on RACE_TIMEOUT_S with an
// empty track, or the instant the last CONNECTED kart is home.
// ==============================================================================
describe('KartRoom championship', () => {
  const FULL_SEASON: KartSeasonSettings = {
    championship: true,
    rounds: DEFAULT_SEASON_ROUNDS,
  };

  /** The season off the wire. Throws rather than silently passing on `null`. */
  function seasonOf(io: FakeIO, id: PlayerId): KartSeason {
    const season = io.lastSnap(id).championship;
    if (season === null) throw new Error(`snapshot for ${id} carries no championship`);
    return season;
  }

  function rowOf(season: KartSeason, id: PlayerId): KartStandingRow {
    const row = season.standings.find((r) => r.id === id);
    if (row === undefined) throw new Error(`no standings row for ${id}`);
    return row;
  }

  /** The durable half of a standings row — what a reset may never touch. */
  function durable(row: KartStandingRow): Record<string, unknown> {
    const { id, name, pos, points, wins, bestFinish, joinedRound } = row;
    return { id, name, pos, points, wins, bestFinish, joinedRound };
  }

  /** A seated, started, NOT-yet-racing championship room. */
  function seasonRoom(io: FakeIO, ids: PlayerId[], season: KartSeasonSettings): KartRoom {
    const room = new KartRoom(DEFAULT_TRACK_ID, 'public', io, season);
    ids.forEach((id, i) => room.addPlayer(id, `Driver${i + 1}`));
    room.start();
    settle();
    return room;
  }

  /**
   * Press START and run the lights out. Drivers are built on the room's LIVE
   * circuit (`room.trackId` moves between rounds), so their twins integrate the
   * same road the room does — with a one-circuit registry that is always the
   * same track, with eight it is round 2's.
   */
  function startRound(io: FakeIO, room: KartRoom, ids: PlayerId[], reuse?: Driver[]): Driver[] {
    room.handleMessage(ids[0]!, { t: 'start' });
    advanceToPhase(io, ids[0]!, 'racing');
    const track = trackFor(room.trackId);
    // A second round must REUSE its drivers (see Driver.retrack): a fresh
    // Driver would restart `seq` at 1 and the room would drop every input.
    if (reuse === undefined) return ids.map((id, i) => new Driver(id, i, track));
    for (const d of reuse) d.retrack(track);
    return reuse;
  }

  /**
   * Run the clock out on the CURRENT phase and no further — measured from the
   * live snapshot rather than from RACE_TIMEOUT_S, because a race that has
   * already been driven for a minute has only the rest of the timeout left, and
   * a fixed advance would sail through results and out the other side.
   */
  function runOutThePhase(io: FakeIO, id: PlayerId): void {
    const live = io.lastSnap(id);
    expect(live.phaseEndsAt, 'this phase has a timer to run out').toBeGreaterThan(0);
    vi.advanceTimersByTime(live.phaseEndsAt - live.serverTime + SNAP_STEP_MS + SIM_STEP_MS);
  }

  /** Start and end a round with nobody driving: the race dies on RACE_TIMEOUT_S. */
  function timeoutRound(io: FakeIO, room: KartRoom, ids: PlayerId[]): void {
    startRound(io, room, ids);
    runOutThePhase(io, ids[0]!);
    expect(io.lastSnap(ids[0]!).phase, 'the race timed out').toBe('results');
    expect(eventsOfKind(io, ids[0]!, 'timeout').length).toBeGreaterThan(0);
  }

  /**
   * The cheapest round that actually SCORES. The passengers are disconnected
   * the instant the lights go out — which is the contract's second DNF case
   * ("disconnected before finishing") AND clears the starting grid, which sits
   * on the start straight the leader must drive down again on laps 2 and 3.
   * With every connected kart home the race ends on the spot: one kart's worth
   * of sim, and no RACE_TIMEOUT_S wait.
   */
  function sprintRound(io: FakeIO, room: KartRoom, winner: Driver, ...dnfIds: PlayerId[]): void {
    for (const id of dnfIds) room.removePlayer(id);
    driveUntil(room, io, [winner], () => io.lastSnap(winner.id).you.finished, 3600);
    settle();
    expect(io.lastSnap(winner.id).phase, 'the last connected kart home ends the race').toBe('results');
  }

  /** Sit through results; the room advances the round and the circuit on the way out. */
  function toLobby(io: FakeIO, id: PlayerId): void {
    vi.advanceTimersByTime(RESULTS_SECONDS * 1000 + SNAP_STEP_MS + SIM_STEP_MS);
    expect(io.lastSnap(id).phase, 'results ended').toBe('lobby');
  }

  it('scores a full grid straight off the F1 table: every finisher takes exactly pointsForPlace(their place)', () => {
    const io = new FakeIO();
    const ids: PlayerId[] = ['p1', 'p2', 'p3', 'p4'];
    const room = seasonRoom(io, ids, FULL_SEASON);
    const drivers = startRound(io, room, ids);

    // Release the grid one kart at a time. Every kart drives the SAME
    // pure-pursuit line, so a field that starts together simply drives into
    // itself — the head start is the trick the two-kart finish test already
    // uses, scaled to four. It also clears the start straight (which the grid
    // sits on) well before the leader comes back round to begin lap 2.
    const STAGGER = 200;
    for (let i = 1; i <= drivers.length; i++) drive(room, drivers.slice(0, i), STAGGER);
    driveUntil(room, io, drivers, () => io.lastSnap('p1').phase === 'results', 4200);
    settle();

    // the true order is READ, never assumed: whoever the sim put where
    const finishes = eventsOfKind(io, 'p1', 'finish');
    expect(finishes.length, 'the whole grid got home — nobody is a DNF here').toBe(ids.length);
    expect(finishes.map((e) => e.place)).toEqual(ids.map((_, i) => i + 1));

    const season = seasonOf(io, 'p1');
    expect(season.round, 'during results, `round` is the round just SCORED').toBe(1);
    expect(season.rounds).toBe(DEFAULT_SEASON_ROUNDS);
    expect(season.over).toBe(false);
    expect(season.championId).toBeNull();

    for (const ev of finishes) {
      const row = rowOf(season, ev.playerId);
      expect(row.points, `${ev.playerId} finished P${ev.place}`).toBe(pointsForPlace(ev.place));
      expect(row.delta, 'round 1: the delta IS the total').toBe(pointsForPlace(ev.place));
      expect(row.wins).toBe(ev.place === 1 ? 1 : 0);
      expect(row.bestFinish).toBe(ev.place);
      expect(row.here).toBe(true);
      expect(row.joinedRound).toBe(1);
      expect(row.pos, 'championship position after one round IS the race result').toBe(ev.place);
    }

    // places 1..4 pay strictly descending points, so no tie-break is involved
    // yet and the table must BE the finishing order
    expect(season.standings.map((r) => r.id)).toEqual(finishes.map((e) => e.playerId));
    expect(season.standings.map((r) => r.pos)).toEqual(ids.map((_, i) => i + 1));
    for (let i = 1; i < season.standings.length; i++) {
      expect(season.standings[i - 1]!.points).toBeGreaterThan(season.standings[i]!.points);
    }
    expect(season.standings[0]!.wins).toBe(1);
    // the season rode on EVERY snapshot, not just the results one
    expect(io.snaps('p1').length).toBeGreaterThan(SNAPSHOT_HZ);
    expect(io.snaps('p1').every((s) => s.championship !== null)).toBe(true);
    room.stop();
  });

  it('a kart that never reaches the finish order scores nothing, while the winner is paid in full', () => {
    const io = new FakeIO();
    const ids: PlayerId[] = ['p1', 'p2'];
    const room = seasonRoom(io, ids, FULL_SEASON);
    const drivers = startRound(io, room, ids);
    sprintRound(io, room, drivers[0]!, 'p2'); // p2 is gone at the lights: a DNF

    const season = seasonOf(io, 'p1');
    const won = rowOf(season, 'p1');
    expect(won.points).toBe(pointsForPlace(1));
    expect(won.delta).toBe(pointsForPlace(1));
    expect(won.wins).toBe(1);
    expect(won.bestFinish).toBe(1);
    expect(won.pos).toBe(1);

    // the DNF still has a ROW — they are in the championship, on nothing
    const dnf = rowOf(season, 'p2');
    expect(dnf.points).toBe(0);
    expect(dnf.delta).toBe(0);
    expect(dnf.bestFinish, '0 means never finished, not "finished last"').toBe(0);
    expect(dnf.wins).toBe(0);
    expect(dnf.here).toBe(false);
    expect(dnf.pos).toBe(2);
    // ...and it is an OMISSION, not a place the table happened to pay nothing
    // for: exactly one kart was ever classified
    expect(eventsOfKind(io, 'p1', 'finish').map((e) => e.playerId)).toEqual(['p1']);
    room.stop();
  });

  it('a race nobody finishes pays nobody, and still burns a round of the season', () => {
    const io = new FakeIO();
    const ids: PlayerId[] = ['p1', 'p2'];
    const room = seasonRoom(io, ids, FULL_SEASON);
    timeoutRound(io, room, ids); // both seated, both stationary, nobody home

    const scored = seasonOf(io, 'p1');
    expect(scored.round).toBe(1);
    expect(scored.standings.length).toBe(ids.length);
    for (const row of scored.standings) {
      expect(row.points).toBe(0);
      expect(row.delta).toBe(0);
      expect(row.wins).toBe(0);
      expect(row.bestFinish).toBe(0);
      expect(row.here, 'a seated DNF is still seated').toBe(true);
    }
    expect(eventsOfKind(io, 'p1', 'finish').length).toBe(0);
    expect(eventsOfKind(io, 'p1', 'timeout').length).toBe(1);

    toLobby(io, 'p1');
    expect(seasonOf(io, 'p1').round, 'a scoreless round is still a round').toBe(2);
    room.stop();
  });

  it('the championship is the one thing resetToLobby does NOT wipe: points survive, race state does not', () => {
    const io = new FakeIO();
    const ids: PlayerId[] = ['p1', 'p2'];
    const room = seasonRoom(io, ids, FULL_SEASON);
    const drivers = startRound(io, room, ids);
    sprintRound(io, room, drivers[0]!, 'p2');

    const scored = seasonOf(io, 'p1');
    expect(rowOf(scored, 'p1').points).toBe(pointsForPlace(1)); // there IS something to lose
    toLobby(io, 'p1');

    const lobby = seasonOf(io, 'p1');
    // every row came through the reset untouched — including the departed one
    expect(lobby.standings.map(durable)).toEqual(scored.standings.map(durable));
    // `delta` names the most recently SCORED round, which the reset did not change
    expect(lobby.standings.map((r) => r.delta)).toEqual(scored.standings.map((r) => r.delta));
    expect(lobby.round, 'the round advanced on the way out of results').toBe(2);
    expect(lobby.rounds).toBe(DEFAULT_SEASON_ROUNDS);
    expect(lobby.over).toBe(false);
    expect(lobby.championId).toBeNull();

    // ...while the per-race state was wiped exactly as it always was
    const you = io.lastSnap('p1').you;
    expect(you.progress).toBe(0);
    expect(you.lap).toBe(1);
    expect(you.finished).toBe(false);
    expect(you.finishMs).toBe(-1);
    expect(you.bestLapMs).toBe(-1);
    expect(io.lastSnap('p1').phase).toBe('lobby');
    room.stop();
  });

  it('mid-season the room still never auto-starts: round 2 waits for an explicit start, exactly like round 1', () => {
    const io = new FakeIO();
    const ids: PlayerId[] = ['p1', 'p2'];
    const room = seasonRoom(io, ids, FULL_SEASON);
    timeoutRound(io, room, ids);
    toLobby(io, 'p1');
    expect(seasonOf(io, 'p1').round).toBe(2);

    // a full lobby, a season in progress, and a circuit already chosen: still
    // nothing happens until somebody presses the button
    vi.advanceTimersByTime((READY_SECONDS + COUNTDOWN_SECONDS) * 1000 + 10_000);
    expect(io.lastSnap('p1').phase).toBe('lobby');
    expect(io.lastSnap('p1').canStart).toBe(true);
    expect(eventsOfKind(io, 'p1', 'go').length, 'exactly one GO so far: round 1').toBe(1);
    expect(seasonOf(io, 'p1').round).toBe(2);

    room.handleMessage('p2', { t: 'start' }); // any seated driver, mid-season too
    advanceToPhase(io, 'p1', 'ready');
    // and arming round 2 neither re-scored nor reset the table
    expect(seasonOf(io, 'p1').round).toBe(2);
    expect(seasonOf(io, 'p1').standings.length).toBe(ids.length);
    room.stop();
  });

  it('the season walks its calendar: each round races the next circuit, and the last round has no next', () => {
    const io = new FakeIO();
    const ids: PlayerId[] = ['p1', 'p2'];
    const ROUNDS = 3;
    const room = seasonRoom(io, ids, { championship: true, rounds: ROUNDS });
    // compared against the CALENDAR, never a literal id: this must hold with
    // one circuit registered (every round the same track) and with eight
    const calendar = buildCalendar(DEFAULT_TRACK_ID, ROUNDS);
    expect(calendar.length).toBe(ROUNDS);

    for (let r = 1; r <= ROUNDS; r++) {
      const circuit = calendar[r - 1]!;
      const lobby = seasonOf(io, 'p1');
      expect(lobby.round).toBe(r);
      expect(lobby.rounds).toBe(ROUNDS);
      expect(lobby.over).toBe(false);
      expect(lobby.trackId, `round ${r} is on the calendar's ${r}th circuit`).toBe(circuit);
      expect(io.lastSnap('p1').trackId).toBe(circuit); // the wire agrees...
      expect(room.trackId).toBe(circuit); // ...and so does the room itself
      expect(lobby.nextTrackId, 'the final round has nothing after it').toBe(
        r < ROUNDS ? calendar[r]! : null,
      );
      expect(room.info().label).toBe(`R${r}/${ROUNDS} · ${TRACKS[circuit].name}`);

      timeoutRound(io, room, ids);
      const scored = seasonOf(io, 'p1');
      expect(scored.round, 'results still names the round just scored').toBe(r);
      expect(scored.trackId).toBe(circuit);
      expect(scored.over).toBe(r === ROUNDS);
      toLobby(io, 'p1');
    }

    // the calendar is spent: the room rolls into a brand new season
    const fresh = seasonOf(io, 'p1');
    expect(fresh.round).toBe(1);
    expect(fresh.rounds).toBe(ROUNDS);
    expect(fresh.over).toBe(false);
    room.stop();
  });

  it('the final round crowns the standings leader, then the room opens a fresh season with the same drivers', () => {
    const io = new FakeIO();
    const ids: PlayerId[] = ['p1', 'p2'];
    const ROUNDS = 2;
    const room = seasonRoom(io, ids, { championship: true, rounds: ROUNDS });

    // ROUND 1 — driven for real, both karts home, so a genuine two-kart
    // classification (P1 and P2) comes out of the sim rather than out of a fixture.
    const r1 = startRound(io, room, ids);
    drive(room, [r1[0]!], 200); // a head start: one pure-pursuit line, two karts
    driveUntil(room, io, r1, () => io.lastSnap('p1').phase === 'results', 4200);
    settle();
    expect(eventsOfKind(io, 'p1', 'finish').length, 'both karts home in round 1').toBe(ids.length);
    const midSeason = seasonOf(io, 'p1');
    expect(midSeason.round).toBe(1);
    expect(midSeason.over, 'a season is not over until its LAST round is scored').toBe(false);
    expect(midSeason.championId).toBeNull();
    toLobby(io, 'p1');

    // ROUND 2 — a DIFFERENT circuit (the calendar moved), so only the leader is
    // driven and the round is closed by RACE_TIMEOUT_S. What this test is about
    // is the table, the champion and the tie-break; making it depend on a
    // hand-rolled autopilot lapping all eight circuits two-abreast would couple
    // a rules test to driving skill. p2 stays SEATED throughout and simply DNFs.
    const r2 = startRound(io, room, ids, r1);
    driveUntil(room, io, [r2[0]!], () => io.lastSnap('p1').you.finished, 3600);
    expect(io.lastSnap('p1').phase, 'a kart is still out there, so the race runs on').toBe('racing');
    runOutThePhase(io, 'p1'); // ...until the rest of RACE_TIMEOUT_S is spent
    expect(io.lastSnap('p1').phase).toBe('results');
    expect(seasonOf(io, 'p1').round).toBe(ROUNDS);

    // Rebuild the whole championship from the finish events alone and demand the
    // room agrees — table AND champion. Nothing here is hardcoded to a winner:
    // the sim decides the races, the frozen comparator decides the order.
    const finishes = eventsOfKind(io, 'p1', 'finish');
    const expected = ids
      .map((id, seq) => {
        const places = finishes.filter((e) => e.playerId === id).map((e) => e.place);
        return {
          id,
          points: places.reduce((sum, place) => sum + pointsForPlace(place), 0),
          wins: places.filter((place) => place === 1).length,
          bestFinish: places.length === 0 ? 0 : Math.min(...places),
          seq,
        };
      })
      .sort(compareSeason);

    const final = seasonOf(io, 'p1');
    expect(final.over, 'the last round of the calendar closes the season').toBe(true);
    expect(final.championId).toBe(expected[0]!.id);
    expect(final.championId).toBe(final.standings[0]!.id);
    expect(final.standings.map((r) => r.id)).toEqual(expected.map((k) => k.id));
    for (const k of expected) {
      const row = rowOf(final, k.id);
      expect(row.points, `${k.id} season total`).toBe(k.points);
      expect(row.wins).toBe(k.wins);
      expect(row.bestFinish).toBe(k.bestFinish);
    }
    // the table ACCUMULATED across the two rounds: the leader scored in both, so
    // their total is more than any single race could possibly pay. A room that
    // rebuilt the table each round could not produce this number.
    expect(final.standings[0]!.points).toBeGreaterThan(pointsForPlace(1));
    // ...while `delta` still names only the round that was just scored: the
    // solo winner of round 2 took the win, the kart that sat it out took nothing
    expect(rowOf(final, 'p1').delta).toBe(pointsForPlace(1));
    expect(rowOf(final, 'p2').delta, 'a DNF in the final round adds nothing').toBe(0);

    // ...and the next reset wipes the slate without emptying the room
    toLobby(io, 'p1');
    const fresh = seasonOf(io, 'p1');
    expect(fresh.round).toBe(1);
    expect(fresh.over).toBe(false);
    expect(fresh.championId).toBeNull();
    expect(fresh.standings.length).toBe(ids.length);
    for (const row of fresh.standings) {
      expect(row.points).toBe(0);
      expect(row.delta).toBe(0);
      expect(row.wins).toBe(0);
      expect(row.bestFinish).toBe(0);
      expect(row.here).toBe(true);
      expect(row.joinedRound, 'a new season starts everyone on round 1').toBe(1);
    }
    expect(room.playerCount()).toBe(ids.length); // nobody was evicted by the reset
    expect(io.lastSnap('p1').phase).toBe('lobby');
    room.stop();
  });

  it('a mid-season joiner starts on zero, behind everyone they are level with, and moves nobody else', () => {
    const io = new FakeIO();
    const ids: PlayerId[] = ['p1', 'p2'];
    const room = seasonRoom(io, ids, FULL_SEASON);
    timeoutRound(io, room, ids); // a scoreless round, so the joiner ties everybody
    toLobby(io, 'p1');

    const before = seasonOf(io, 'p1');
    expect(before.round).toBe(2);
    room.addPlayer('p3', 'Driver3');
    settle();

    const after = seasonOf(io, 'p1');
    const joiner = rowOf(after, 'p3');
    expect(joiner.points).toBe(0);
    expect(joiner.delta).toBe(0);
    expect(joiner.wins).toBe(0);
    expect(joiner.bestFinish).toBe(0);
    expect(joiner.here).toBe(true);
    expect(joiner.joinedRound, 'they walked in during the live round, not round 1').toBe(after.round);
    // level on points, wins and bestFinish with both incumbents, so the ONLY
    // rung left is join order — the newest driver must be last, not first
    expect(joiner.pos).toBe(after.standings.length);
    expect(after.standings[after.standings.length - 1]!.id).toBe('p3');
    // ...and joining is not a re-score: the drivers already there are untouched,
    // championship position included
    expect(after.standings.slice(0, ids.length)).toEqual(before.standings);
    room.stop();
  });

  it('a driver who leaves keeps the points they scored: the row stays, only `here` goes false', () => {
    const io = new FakeIO();
    const ids: PlayerId[] = ['p1', 'p2'];
    const room = seasonRoom(io, ids, FULL_SEASON);
    const drivers = startRound(io, room, ids);
    sprintRound(io, room, drivers[0]!, 'p2'); // p1 wins the round outright

    // an observer seats during results: the standings are a WIRE fact, so they
    // have to outlive the driver who scored them, on somebody else's snapshot
    room.addPlayer('obs', 'Observer');
    settle();
    const before = rowOf(seasonOf(io, 'obs'), 'p1');
    expect(before.points).toBe(pointsForPlace(1));
    expect(before.name).toBe('Driver1');
    expect(before.here).toBe(true);

    room.removePlayer('p1');
    settle();
    const after = rowOf(seasonOf(io, 'obs'), 'p1');
    expect(after.here, 'the only thing leaving changes').toBe(false);
    expect(after.points).toBe(before.points);
    expect(after.delta).toBe(before.delta);
    expect(after.wins).toBe(before.wins);
    expect(after.bestFinish).toBe(before.bestFinish);
    expect(after.joinedRound).toBe(before.joinedRound);
    // the NAME survives too: a results screen reading "DRIVER — 25 pts" for the
    // driver who just won the race is the placeholder leaking over a real name
    expect(after.name).toBe(before.name);
    expect(after.pos, 'still leading the championship they are no longer racing in').toBe(1);
    expect(room.playerCount()).toBe(1);

    // ...and coming BACK is not a second registration: the same id re-attaches
    // to the same row rather than starting a duplicate one on zero
    room.addPlayer('p1', 'Driver1');
    settle();
    const rejoined = seasonOf(io, 'obs');
    expect(rejoined.standings.filter((r) => r.id === 'p1').length).toBe(1);
    expect(rowOf(rejoined, 'p1').points).toBe(before.points);
    expect(rowOf(rejoined, 'p1').here).toBe(true);
    expect(rowOf(rejoined, 'p1').joinedRound).toBe(before.joinedRound);
    room.stop();
  });

  it('a round that was abandoned rather than raced does not burn a slot of the calendar', () => {
    const io = new FakeIO();
    const ids: PlayerId[] = ['p1', 'p2'];
    const room = seasonRoom(io, ids, FULL_SEASON);
    startRound(io, room, ids); // lights out on round 1...
    const circuit = room.trackId;

    // ...and then the room empties mid-race: there is nobody left to race it,
    // nobody to show results to, and NOTHING was scored
    room.removePlayer('p1');
    room.removePlayer('p2');
    settle();

    // a fresh pair walks in and finds round 1 still to be raced, on the circuit
    // it was always going to be raced on — an abandoned race costs the season
    // nothing, where a race that ran and paid nobody still costs it a round
    room.addPlayer('p3', 'Driver3');
    room.addPlayer('p4', 'Driver4');
    settle();
    expect(io.lastSnap('p3').phase).toBe('lobby');
    const season = seasonOf(io, 'p3');
    expect(season.round).toBe(1);
    expect(season.trackId).toBe(circuit);
    expect(room.trackId).toBe(circuit);
    expect(season.over).toBe(false);
    expect(rowOf(season, 'p3').joinedRound, 'they joined in round 1, because it never left').toBe(1);
    room.stop();
  });

  it('a room booked with { championship: false } behaves exactly as it did before championships existed', () => {
    const io = new FakeIO();
    const ids: PlayerId[] = ['p1', 'p2'];
    const room = new KartRoom(DEFAULT_TRACK_ID, 'public', io, {
      championship: false,
      rounds: DEFAULT_SEASON_ROUNDS, // accepted and ignored: there is no season
    });
    ids.forEach((id, i) => room.addPlayer(id, `Driver${i + 1}`));
    room.start();
    settle();
    expect(io.lastSnap('p1').championship).toBeNull();
    expect(room.info().label, 'the old label, not a round counter').toBe(
      `3 laps · ${TRACKS[DEFAULT_TRACK_ID].name}`,
    );

    // the unchanged phase machine: manual start, lights, race, 10s of results,
    // back to the lobby, and then a wait
    room.handleMessage('p1', { t: 'start' });
    advanceToPhase(io, 'p1', 'ready');
    advanceToPhase(io, 'p1', 'countdown');
    advanceToPhase(io, 'p1', 'racing');
    vi.advanceTimersByTime(RACE_TIMEOUT_S * 1000 + SNAP_STEP_MS);
    expect(io.lastSnap('p1').phase).toBe('results');
    vi.advanceTimersByTime(RESULTS_SECONDS * 1000 - 3000);
    expect(io.lastSnap('p1').phase, 'results still last the full 10s').toBe('results');
    vi.advanceTimersByTime(4000);
    expect(io.lastSnap('p1').phase).toBe('lobby');
    expect(room.playerCount()).toBe(ids.length);
    vi.advanceTimersByTime((READY_SECONDS + COUNTDOWN_SECONDS) * 1000 + 5000);
    expect(io.lastSnap('p1').phase, 'and it still never re-arms itself').toBe('lobby');
    expect(io.lastSnap('p1').canStart).toBe(true);

    // the circuit never moved, the label never learned to count rounds, and NO
    // snapshot in the room's whole life carried a season
    expect(room.trackId).toBe(DEFAULT_TRACK_ID);
    expect(room.info().label).toBe(`3 laps · ${TRACKS[DEFAULT_TRACK_ID].name}`);
    expect(io.snaps('p1').length).toBeGreaterThan(SNAPSHOT_HZ);
    expect(io.snaps('p1').every((s) => s.championship === null)).toBe(true);
    expect(io.snaps('p1').every((s) => s.trackId === DEFAULT_TRACK_ID)).toBe(true);
    room.stop();
  });
});


