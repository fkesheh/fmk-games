// ============================================================================
// splat-tests — SplatRoom over a fake RoomIO, with the room as the AUTHORITY
// for positions (the wire carries intent only: splat_input steer+dt+seq).
//
// Driven players keep a local TWIN (makeSim + stepSki, the exact code the room
// integrates) fed the exact same inputs, so the test always knows where the
// skier must be — that twin IS the client-prediction contract. Steering to a
// plant uses a proportional controller on the twin's live state; the room
// mirrors it bit-identically as long as no resolveSkiPair contact interferes
// (drivers are steered away from the parked grid, so none does).
//
// Phase timers (countdown/grace/hard-cap/results) are wall-clock, so
// vi.useFakeTimers drives the whole phase machine deterministically.
// ============================================================================
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ASSIST_SNARE_MUL,
  COUNTDOWN_MS,
  GATE_BOOST_MS,
  MAX_PLAYERS,
  MIN_PLAYERS,
  PLANT_SNARE_MS,
  RACE_FIRST_FINISH_GRACE_MS,
  RACE_HARD_CAP_MS,
  RESULTS_MS,
  SIM_DT,
  SNAPSHOT_HZ,
  START_PER_ROW,
  START_ROW_SPACING,
  TICK_HZ,
} from '@splat/shared';
import type {
  Phase,
  SkierSim,
  SlopeDef,
  SplatEvent,
  SplatJoined,
  SplatRoster,
  SplatS2C,
  SplatSnapshot,
} from '@splat/shared';
import { genSlope } from '@splat/shared/slope';
import { makeSim, stepSki } from '@splat/shared/sim';
import type { PlayerId, RoomIO } from '@platform/shared';
import { parseSplatRoomSettings, splatModule } from './module.js';
import { SplatRoom } from './room.js';

// ---- §4 start grid (mirrors room.ts; kept local so the test pins the formula) --
function gridX(slot: number): number {
  return (slot % START_PER_ROW - 1.5) * START_ROW_SPACING;
}

function gridZ(slot: number): number {
  return -Math.floor(slot / START_PER_ROW) * START_ROW_SPACING;
}

// ---- fake RoomIO -------------------------------------------------------------
// Snapshots are reused/mutated by the room across ticks (and `you.sim` is the
// room's LIVE sim object), so everything is captured through structuredClone:
// history stays stable for assertions.

class FakeIO implements RoomIO {
  private readonly log = new Map<PlayerId, SplatS2C[]>();

  send(id: PlayerId, msg: unknown): void {
    let msgs = this.log.get(id);
    if (msgs === undefined) {
      msgs = [];
      this.log.set(id, msgs);
    }
    msgs.push(structuredClone(msg) as SplatS2C);
  }

  rttMs(): number {
    return 0;
  }

  private lastOf<T extends SplatS2C['t']>(id: PlayerId, t: T): Extract<SplatS2C, { t: T }> | null {
    const msgs = this.log.get(id) ?? [];
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m !== undefined && m.t === t) return m as Extract<SplatS2C, { t: T }>;
    }
    return null;
  }

  lastSnap(id: PlayerId): SplatSnapshot {
    const m = this.lastOf(id, 'splat_snapshot');
    if (m === null) throw new Error(`no 'splat_snapshot' captured for ${id}`);
    return m;
  }

  /** Snapshots only exist after the first snapshot tick; poll loops need null. */
  snapOrNull(id: PlayerId): SplatSnapshot | null {
    return this.lastOf(id, 'splat_snapshot');
  }

  joined(id: PlayerId): SplatJoined {
    const m = this.lastOf(id, 'splat_joined');
    if (m === null) throw new Error(`no 'splat_joined' captured for ${id}`);
    return m;
  }

  roster(id: PlayerId): SplatRoster | null {
    return this.lastOf(id, 'splat_roster');
  }

  events(id: PlayerId): SplatEvent[] {
    return (this.log.get(id) ?? [])
      .filter((m): m is Extract<SplatS2C, { t: 'splat_event' }> => m.t === 'splat_event')
      .map((m) => m.ev);
  }
}

// ---- timing ------------------------------------------------------------------

const SIM_STEP_MS = Math.ceil(1000 / TICK_HZ); // 34ms: one sim tick (+ a little)
const SNAP_STEP_MS = Math.ceil(1000 / SNAPSHOT_HZ); // 50ms: one snapshot tick

/** Advance one sim tick — the rate one splat_input is consumed at. */
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

function advanceToPhase(io: FakeIO, id: PlayerId, phase: Phase, maxSteps = 400): void {
  const ok = advanceUntil(() => io.snapOrNull(id)?.phase === phase, maxSteps);
  expect(ok, `room reaches phase ${phase}`).toBe(true);
}

// ---- input drivers -----------------------------------------------------------

/**
 * One driven skier: sends `splat_input` to the room and advances an identical
 * local twin with the SAME shared step. While the skier is untouched by
 * contact the twin and the room's authoritative state are bit-identical.
 */
class Driver {
  readonly twin: SkierSim;
  assist = false;
  private seq = 0;

  constructor(
    readonly id: PlayerId,
    readonly slot: number,
    private readonly slope: SlopeDef,
  ) {
    this.twin = makeSim(gridX(slot), gridZ(slot), 0);
  }

  lastSeq(): number {
    return this.seq;
  }

  /**
   * A rejoin under a NEW playerId (the platform resume flow): the wire seq is
   * per-connection monotonic and the room carries the seat's watermarks across
   * the rebind, so the driver KEEPS COUNTING — restarting at 1 would have every
   * input dropped as already-processed.
   */
  rebind(newId: PlayerId): void {
    (this as { id: PlayerId }).id = newId;
  }

  /** Queue one input on the room and advance the twin identically. */
  send(room: SplatRoom, steer: number, dt: number = SIM_DT): void {
    room.handleMessage(this.id, { t: 'splat_input', seq: ++this.seq, steer, dt });
    stepSki(this.twin, steer, dt, this.slope, { assist: this.assist });
  }
}

/** Proportional heading controller: steer the twin toward (tx, tz). */
function steerToward(twin: SkierSim, tx: number, tz: number): number {
  const desired = Math.atan2(tx - twin.x, tz - twin.z);
  return Math.max(-1, Math.min(1, (desired - twin.yaw) * 4));
}

/** Straight-line drive (steer 0), one input each per sim tick. */
function drive(room: SplatRoom, drivers: Driver[], steps: number): void {
  for (let i = 0; i < steps; i++) {
    for (const d of drivers) d.send(room, 0);
    tick();
  }
}

// ---- room setup --------------------------------------------------------------

/** Seated players, room started, START pressed, driven all the way to 'racing'. */
function setupRace(
  io: FakeIO,
  ids: PlayerId[] = ['p1', 'p2'],
  seedOverride: number | null = null,
): { room: SplatRoom; slope: SlopeDef; drivers: Driver[] } {
  const room = new SplatRoom('public', io, seedOverride);
  ids.forEach((id, i) => room.addPlayer(id, `Skier${i + 1}`));
  room.start();
  room.handleMessage(ids[0]!, { t: 'start' }); // nothing auto-starts
  advanceToPhase(io, ids[0]!, 'racing');
  const seed = seedOverride ?? io.lastSnap(ids[0]!).seed;
  const slope = genSlope(seed);
  // the twins are built on the grid, which is exactly what countdown entry set
  return { room, slope, drivers: ids.map((id, i) => new Driver(id, i, slope)) };
}

function eventsOfKind<K extends SplatEvent['t']>(
  io: FakeIO,
  id: PlayerId,
  kind: K,
): Array<Extract<SplatEvent, { t: K }>> {
  return io.events(id).filter((e): e is Extract<SplatEvent, { t: K }> => e.t === kind);
}

/** This player's own entry in their latest snapshot roster. */
function snapOf(io: FakeIO, id: PlayerId): SplatSnapshot['players'][number] {
  const self = io.lastSnap(id).players.find((p) => p.id === id);
  if (self === undefined) throw new Error(`no ${id} in snapshot`);
  return self;
}

/** Pick a mid-slope plant reachable from the grid (deterministic per seed). */
function targetPlant(slope: SlopeDef): { ix: number; x: number; z: number } {
  for (let i = 0; i < slope.plants.length; i++) {
    const p = slope.plants[i]!;
    if (p.z >= 80 && p.z <= 300 && Math.abs(p.x) <= 18) return { ix: i, x: p.x, z: p.z };
  }
  throw new Error('no reachable plant on this slope');
}

/**
 * Drive p1 into a plant on the given seeded room and return the hit evidence:
 * the first plant_hit event plus the twin's recorded first hit. The twin and
 * the room run the same inputs over the same slope, so they record the SAME
 * first hit.
 */
function driveIntoPlant(
  room: SplatRoom,
  io: FakeIO,
  driver: Driver,
  slope: SlopeDef,
): { ev: Extract<SplatEvent, { t: 'plant_hit' }>; twinIx: number } {
  const target = targetPlant(slope);
  let twinIx = -1;
  for (let i = 0; i < 2500; i++) {
    driver.send(room, steerToward(driver.twin, target.x, target.z));
    if (twinIx < 0 && driver.twin.lastPlantIx >= 0) twinIx = driver.twin.lastPlantIx;
    tick();
    const hits = eventsOfKind(io, driver.id, 'plant_hit');
    if (hits.length > 0) return { ev: hits[0]!, twinIx };
  }
  throw new Error(`never hit a plant (twin at ${driver.twin.x.toFixed(1)},${driver.twin.z.toFixed(1)})`);
}

// ---- tests -------------------------------------------------------------------

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('SplatRoom join + roster', () => {
  it('sends splat_joined with the frozen shape and broadcasts splat_roster on join/leave', () => {
    const io = new FakeIO();
    const room = new SplatRoom('public', io);
    room.addPlayer('p1', 'Alpha');
    room.start();

    const joined = io.joined('p1');
    expect(joined.you).toBe('p1');
    expect(joined.slot).toBe(0);
    expect(joined.phase).toBe('lobby');
    expect(joined.seed).toBe(-1); // no race yet
    expect(joined.code).toBeNull(); // public room
    expect(typeof joined.serverTime).toBe('number');
    expect(joined.players).toEqual([{ id: 'p1', name: 'Alpha', slot: 0 }]);

    room.addPlayer('p2', 'Bravo');
    const roster = io.roster('p1');
    expect(roster?.players).toEqual([
      { id: 'p1', name: 'Alpha', slot: 0 },
      { id: 'p2', name: 'Bravo', slot: 1 },
    ]);
    expect(io.joined('p2').slot).toBe(1);

    room.removePlayer('p2', true); // explicit leave: seat gone, roster refresh
    expect(io.roster('p1')?.players).toEqual([{ id: 'p1', name: 'Alpha', slot: 0 }]);
    room.stop();
  });

  it('a private room gets a join code on splat_joined', () => {
    const io = new FakeIO();
    const room = new SplatRoom('private', io);
    room.addPlayer('p1', 'Alpha');
    room.start();
    expect(typeof io.joined('p1').code).toBe('string');
    expect(io.joined('p1').code?.length).toBeGreaterThan(0);
    room.stop();
  });

  it('the snapshot carries playerCount / minPlayers / canStart', () => {
    const io = new FakeIO();
    const room = new SplatRoom('public', io);
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
    advanceToPhase(io, 'p1', 'countdown');
    expect(io.lastSnap('p1').canStart).toBe(false); // no longer in the lobby phase
    room.stop();
  });
});

describe('SplatRoom explicit start (frozen lobby contract)', () => {
  it('never auto-starts: a seated lobby waits however long it sits', () => {
    const io = new FakeIO();
    const room = new SplatRoom('public', io);
    room.addPlayer('p1', 'Alpha');
    room.addPlayer('p2', 'Bravo');
    room.start();

    vi.advanceTimersByTime(COUNTDOWN_MS + 20_000);
    expect(io.lastSnap('p1').phase).toBe('lobby');
    expect(room.info().phase).toBe('lobby');
    expect(io.events('p1').length).toBe(0);
    room.stop();
  });

  it('start below MIN_PLAYERS is silently ignored (and never throws)', () => {
    const io = new FakeIO();
    const room = new SplatRoom('public', io);
    room.addPlayer('p1', 'Alpha');
    room.start();

    expect(() => room.handleMessage('p1', { t: 'start' })).not.toThrow();
    vi.advanceTimersByTime(COUNTDOWN_MS + 5000);
    expect(io.lastSnap('p1').phase).toBe('lobby');
    room.stop();
  });

  it('start from a player who is not in the room is silently ignored', () => {
    const io = new FakeIO();
    const room = new SplatRoom('public', io);
    room.addPlayer('p1', 'Alpha');
    room.addPlayer('p2', 'Bravo');
    room.start();
    settle();

    expect(() => room.handleMessage('ghost', { t: 'start' })).not.toThrow();
    vi.advanceTimersByTime(COUNTDOWN_MS + 3000);
    expect(io.lastSnap('p1').phase).toBe('lobby');
    room.stop();
  });

  it('any seated player may start: countdown 3-2-1 -> racing, seed + grid at countdown entry', () => {
    const io = new FakeIO();
    const room = new SplatRoom('public', io);
    room.addPlayer('p1', 'Alpha');
    room.addPlayer('p2', 'Bravo');
    room.start();
    settle();

    room.handleMessage('p2', { t: 'start' }); // the SECOND joiner, not a "host"
    advanceToPhase(io, 'p1', 'countdown');
    const cd = io.lastSnap('p1');
    expect(cd.countdown).toBeGreaterThanOrEqual(1);
    expect(cd.countdown).toBeLessThanOrEqual(3);
    expect(cd.phaseEndsAt - cd.serverTime).toBeGreaterThan(0);
    expect(cd.phaseEndsAt - cd.serverTime).toBeLessThanOrEqual(COUNTDOWN_MS);
    expect(cd.seed).not.toBe(-1); // the mountain exists from countdown entry

    advanceToPhase(io, 'p1', 'racing');
    const snap = io.lastSnap('p1');
    expect(snap.countdown).toBe(0);
    expect(snap.players.length).toBe(2);
    // everyone gridded by slot (GO wipe): slot 0 at (-4.5, 0), slot 1 at (-1.5, 0)
    expect(snapOf(io, 'p1').x).toBeCloseTo(gridX(0), 9);
    expect(snapOf(io, 'p1').z).toBeCloseTo(gridZ(0), 9);
    expect(snapOf(io, 'p2').x).toBeCloseTo(gridX(1), 9);
    room.stop();
  });

  it('extra starts during countdown/racing/results change nothing', () => {
    const io = new FakeIO();
    const { room } = setupRace(io, ['p1', 'p2'], 11);
    advanceToPhase(io, 'p1', 'racing');
    const racingEndsAt = io.lastSnap('p1').phaseEndsAt;

    room.handleMessage('p1', { t: 'start' }); // ignored: not in 'lobby'
    settle();
    expect(io.lastSnap('p1').phase).toBe('racing');
    expect(io.lastSnap('p1').phaseEndsAt).toBe(racingEndsAt); // timer NOT restarted

    vi.advanceTimersByTime(RACE_HARD_CAP_MS + 2000); // nobody moves: hard cap
    expect(io.lastSnap('p1').phase).toBe('results');
    room.handleMessage('p1', { t: 'start' });
    settle();
    expect(io.lastSnap('p1').phase).toBe('results'); // no early exit out of results
    room.stop();
  });
});

describe('SplatRoom server-authoritative simulation', () => {
  it('integrates the skier from inputs: the snapshot matches a locally-stepped twin exactly', () => {
    const io = new FakeIO();
    const { room, drivers } = setupRace(io, ['p1', 'p2'], 42);
    const d = drivers[0]!;

    drive(room, [d], 120); // 4s of honest 30Hz input, straight down
    settle();

    const self = snapOf(io, 'p1');
    // THE PREDICTION CONTRACT: same code, same inputs, same numbers.
    expect(self.x).toBeCloseTo(d.twin.x, 9);
    expect(self.z).toBeCloseTo(d.twin.z, 9);
    expect(self.yaw).toBeCloseTo(d.twin.yaw, 9);
    expect(self.v).toBeCloseTo(d.twin.v, 9);
    expect(self.steer).toBe(0);
    // and it really moved (a twin matching a parked skier is a vacuous pass)
    expect(self.z - gridZ(0)).toBeGreaterThan(20);
    // `you.sim` is the full authoritative sim, consistent with the roster entry
    const you = io.lastSnap('p1').you;
    expect(you.sim.x).toBe(self.x);
    expect(you.sim.z).toBe(self.z);
    expect(you.sim.simMs).toBeCloseTo(d.twin.simMs, 9);
    expect(you.lastProcessedSeq).toBe(d.lastSeq());
    room.stop();
  });

  it('pre-GO freeze: inputs during countdown are consumed and ACKED but not integrated', () => {
    const io = new FakeIO();
    const room = new SplatRoom('public', io, 42);
    room.addPlayer('p1', 'Alpha');
    room.addPlayer('p2', 'Bravo');
    room.start();
    room.handleMessage('p1', { t: 'start' });
    advanceToPhase(io, 'p1', 'countdown');

    const slope = genSlope(42);
    const d = new Driver('p1', 0, slope);
    for (let i = 0; i < 5; i++) {
      d.send(room, 0.5); // full-lock right, mid-countdown
      tick();
    }
    settle();

    const you = io.lastSnap('p1').you;
    expect(you.lastProcessedSeq).toBe(d.lastSeq()); // acked...
    expect(you.sim.x).toBeCloseTo(gridX(0), 9); // ...but frozen on the grid
    expect(you.sim.z).toBeCloseTo(gridZ(0), 9);
    expect(you.sim.yaw).toBeCloseTo(0, 9);
    room.stop();
  });
});

describe('SplatRoom race flow', () => {
  it('two players race to the finish: finished events in order, places, results -> lobby', () => {
    const io = new FakeIO();
    const { room, drivers } = setupRace(io, ['p1', 'p2'], 42);

    // both drive straight down the fall line; lanes are 3m apart, so no contact
    const maxSteps = 3000; // 800m at up to ~18.5 m/s needs ~50s of sim
    let steps = 0;
    while (steps < maxSteps && !(drivers[0]!.twin.finished && drivers[1]!.twin.finished)) {
      for (const d of drivers) d.send(room, 0);
      tick();
      steps++;
    }
    expect(steps, 'both skiers finish within budget').toBeLessThan(maxSteps);
    settle();

    const finishes = eventsOfKind(io, 'p1', 'finished');
    expect(finishes.length).toBe(2);
    expect(finishes[0]!.place).toBe(1); // first finisher is place 1
    expect(finishes[1]!.place).toBe(2);
    expect(new Set(finishes.map((e) => e.id))).toEqual(new Set(['p1', 'p2']));
    expect(finishes[0]!.finishMs).toBeGreaterThan(0);
    // the winner's roster place agrees with the event classification
    expect(snapOf(io, finishes[0]!.id).place).toBe(1);
    expect(snapOf(io, finishes[1]!.id).place).toBe(2);
    // finishMs is SIM ms, and the twin (same inputs) records the same stamp
    const winner = drivers.find((d) => d.id === finishes[0]!.id)!;
    expect(finishes[0]!.finishMs).toBeCloseTo(winner.twin.finishMs, 9);

    // all finished -> results on the same tick; the phase timer returns to lobby
    expect(io.lastSnap('p1').phase).toBe('results');
    vi.advanceTimersByTime(RESULTS_MS + 2000);
    expect(io.lastSnap('p1').phase).toBe('lobby');
    expect(room.info().phase).toBe('lobby');
    room.stop();
  });

  it('race end by GRACE: first finisher starts the clock, the race ends RACE_FIRST_FINISH_GRACE_MS later', () => {
    const io = new FakeIO();
    const { room, drivers } = setupRace(io, ['p1', 'p2'], 42);
    const d = drivers[0]!;
    // p2 sends NOTHING: parked on the grid forever, so only the grace clock
    // (or the hard cap) can end this race.

    const maxSteps = 3000;
    let steps = 0;
    while (steps < maxSteps && !d.twin.finished) {
      d.send(room, 0);
      tick();
      steps++;
    }
    expect(d.twin.finished, 'p1 finishes').toBe(true);
    settle();
    expect(eventsOfKind(io, 'p1', 'finished').length).toBe(1);
    expect(io.lastSnap('p1').phase).toBe('racing'); // p2 still out: race runs on

    vi.advanceTimersByTime(10_000); // well inside the 45s grace window
    expect(io.lastSnap('p1').phase).toBe('racing');

    // cross the grace deadline, but stay inside the 8s results window
    vi.advanceTimersByTime(RACE_FIRST_FINISH_GRACE_MS - 10_000 + 2000);
    expect(io.lastSnap('p1').phase).toBe('results');

    vi.advanceTimersByTime(RESULTS_MS + 2000);
    expect(io.lastSnap('p1').phase).toBe('lobby');
    room.stop();
  });

  it('race end by HARD CAP: nobody finishes, results at RACE_HARD_CAP_MS, then lobby', () => {
    const io = new FakeIO();
    const { room } = setupRace(io, ['p1', 'p2'], 42);

    vi.advanceTimersByTime(RACE_HARD_CAP_MS - 5000); // still racing just before the cap
    expect(io.lastSnap('p1').phase).toBe('racing');

    vi.advanceTimersByTime(7000); // past the cap
    expect(io.lastSnap('p1').phase).toBe('results');

    vi.advanceTimersByTime(RESULTS_MS + 2000);
    expect(io.lastSnap('p1').phase).toBe('lobby');
    room.stop();
  });

  it('rematch gets a NEW seed (no {seed} settings)', () => {
    const io = new FakeIO();
    const room = new SplatRoom('public', io); // no seed override
    room.addPlayer('p1', 'Alpha');
    room.addPlayer('p2', 'Bravo');
    room.start();
    room.handleMessage('p1', { t: 'start' });
    advanceToPhase(io, 'p1', 'racing');
    const seed1 = io.lastSnap('p1').seed;
    expect(seed1).not.toBe(-1);

    vi.advanceTimersByTime(RACE_HARD_CAP_MS + 2000); // -> results
    vi.advanceTimersByTime(RESULTS_MS + 2000); // -> lobby
    expect(io.lastSnap('p1').phase).toBe('lobby');

    room.handleMessage('p1', { t: 'start' });
    advanceToPhase(io, 'p1', 'countdown');
    const seed2 = io.lastSnap('p1').seed;
    expect(seed2).not.toBe(-1);
    expect(seed2).not.toBe(seed1); // rematch = new mountain
    room.stop();
  });
});

describe('SplatRoom plant hits + assist', () => {
  it('emits splat_event plant_hit when a seeded run reaches a known plant', () => {
    const io = new FakeIO();
    const { room, slope, drivers } = setupRace(io, ['p1', 'p2'], 42);

    const { ev, twinIx } = driveIntoPlant(room, io, drivers[0]!, slope);
    expect(twinIx).toBeGreaterThanOrEqual(0); // setup guard: the twin really hit
    expect(ev.id).toBe('p1');
    // the room detected the SAME hit the twin recorded (the lastPlantIx/lastPlantHitMs diff)
    expect(ev.plantIx).toBe(twinIx);
    expect(Number.isFinite(ev.x)).toBe(true);
    expect(Number.isFinite(ev.z)).toBe(true);
    const plant = slope.plants[ev.plantIx]!;
    expect(Math.hypot(ev.x - plant.x, ev.z - plant.z)).toBeLessThan(plant.r + 1);

    // the hit cost applies in sim ms: snare window of exactly PLANT_SNARE_MS
    // (no further inputs are consumed, so the snapshot's sim clock sits at the hit)
    settle();
    const sim = io.lastSnap('p1').you.sim;
    expect(sim.lastPlantIx).toBe(ev.plantIx);
    expect(sim.snareUntilMs - sim.simMs).toBeCloseTo(PLANT_SNARE_MS, 6);
    room.stop();
  });

  it('splat_assist is stored per player, changes the physics, and never reaches the wire', () => {
    const SEED = 42;

    // assist OFF run: same seed, same steering -> snare of PLANT_SNARE_MS
    const ioOff = new FakeIO();
    const off = setupRace(ioOff, ['p1', 'p2'], SEED);
    driveIntoPlant(off.room, ioOff, off.drivers[0]!, off.slope);
    settle();
    const simOff = ioOff.lastSnap('p1').you.sim;
    expect(simOff.snareUntilMs - simOff.simMs).toBeCloseTo(PLANT_SNARE_MS, 6);
    off.room.stop();

    // assist ON run: toggled in the LOBBY (allowed at any phase), snare x ASSIST_SNARE_MUL
    const ioOn = new FakeIO();
    const room = new SplatRoom('public', ioOn, SEED);
    room.addPlayer('p1', 'Alpha');
    room.addPlayer('p2', 'Bravo');
    room.start();
    expect(() => room.handleMessage('p1', { t: 'splat_assist', on: true })).not.toThrow();
    room.handleMessage('p1', { t: 'start' });
    advanceToPhase(ioOn, 'p1', 'racing');
    const slope = genSlope(SEED);
    const d = new Driver('p1', 0, slope);
    d.assist = true; // the twin mirrors the server's stored flag
    driveIntoPlant(room, ioOn, d, slope);
    settle();
    const simOn = ioOn.lastSnap('p1').you.sim;
    expect(simOn.snareUntilMs - simOn.simMs).toBeCloseTo(PLANT_SNARE_MS * ASSIST_SNARE_MUL, 6);

    // NEVER broadcast: the assist flag is invisible on the wire for both players
    expect(JSON.stringify(ioOn.lastSnap('p1'))).not.toContain('assist');
    expect(JSON.stringify(ioOn.lastSnap('p2'))).not.toContain('assist');
    expect(ioOn.events('p2').every((e) => !JSON.stringify(e).includes('assist'))).toBe(true);
    room.stop();
  });
});

describe('SplatRoom slalom gates', () => {
  it('emits splat_event gate on a clean pass, and NOTHING when the next gate is missed', () => {
    const io = new FakeIO();
    const { room, slope, drivers } = setupRace(io, ['p1', 'p2'], 42);
    const d = drivers[0]!;
    const gates = slope.gates;
    expect(gates.length).toBeGreaterThanOrEqual(2); // setup guard: pass + miss targets

    // ---- clean pass: pull away from the parked grid, then thread gate 0 ----
    const g0 = gates[0]!;
    for (let i = 0; i < 30; i++) {
      d.send(room, 0); // straight down first: no resolveSkiPair contact with p2
      tick();
    }
    let ev: Extract<SplatEvent, { t: 'gate' }> | null = null;
    for (let i = 0; i < 2500 && ev === null; i++) {
      const prevBoost = d.twin.boostUntilMs;
      d.send(room, steerToward(d.twin, g0.x, g0.z));
      if (d.twin.lastGateIx >= 0 && d.twin.boostUntilMs === prevBoost) {
        throw new Error(`twin MISSED gate 0 at (${d.twin.x.toFixed(1)},${d.twin.z.toFixed(1)})`);
      }
      tick();
      const hits = eventsOfKind(io, 'p1', 'gate');
      if (hits.length > 0) ev = hits[0]!;
    }
    expect(ev, 'a gate event arrives').not.toBeNull();
    const pass = ev as unknown as Extract<SplatEvent, { t: 'gate' }>;
    expect(eventsOfKind(io, 'p1', 'gate').length).toBe(1); // exactly one
    expect(pass.id).toBe('p1');
    // the room detected the SAME pass the twin recorded (lastGateIx advanced
    // AND boostUntilMs changed, atomically)
    expect(d.twin.lastGateIx).toBe(0);
    expect(pass.gateIx).toBe(0);
    expect(Number.isFinite(pass.x)).toBe(true);
    expect(Number.isFinite(pass.z)).toBe(true);
    expect(Math.abs(pass.x - g0.x)).toBeLessThanOrEqual(g0.halfWidth + 1e-9);
    expect(pass.z).toBeGreaterThanOrEqual(g0.z); // crossing step: prevZ < g.z <= newZ
    expect(eventsOfKind(io, 'p2', 'gate').length).toBe(1); // broadcast to everyone

    // the boost window applies in sim ms: exactly GATE_BOOST_MS past the sim
    // clock (no further inputs are consumed, so the snapshot sits at the pass)
    settle();
    const simAtPass = io.lastSnap('p1').you.sim;
    expect(simAtPass.lastGateIx).toBe(0);
    expect(simAtPass.boostUntilMs - simAtPass.simMs).toBeCloseTo(GATE_BOOST_MS, 6);

    // ---- miss: drive past the NEXT gate outside its opening ----------------
    const g1 = gates[1]!;
    const dir = g1.x >= 0 ? -1 : 1; // toward the piste centre: stays on-piste
    const missX = g1.x + dir * (g1.halfWidth + 3);
    const boostBefore = d.twin.boostUntilMs;
    let crossed = false;
    for (let i = 0; i < 2500 && !crossed; i++) {
      d.send(room, steerToward(d.twin, missX, g1.z));
      tick();
      if (d.twin.lastGateIx >= 1) crossed = true;
    }
    expect(crossed, 'the twin reaches gate 1').toBe(true);
    // the twin crossed it as a MISS (lastGateIx advanced, boost untouched)...
    expect(d.twin.lastGateIx).toBe(1);
    expect(d.twin.boostUntilMs).toBe(boostBefore);
    // ...and the room emitted NOTHING for it — still exactly one gate event
    expect(eventsOfKind(io, 'p1', 'gate').length).toBe(1);
    expect(eventsOfKind(io, 'p2', 'gate').length).toBe(1);

    // the skier keeps racing normally after the miss
    drive(room, [d], 60);
    settle();
    const after = io.lastSnap('p1');
    expect(after.phase).toBe('racing');
    expect(after.you.sim.finished).toBe(false);
    expect(after.you.sim.lastGateIx).toBe(1); // the miss is still consumed server-side
    expect(after.you.sim.z).toBeGreaterThan(g1.z);
    expect(eventsOfKind(io, 'p1', 'gate').length).toBe(1);
    room.stop();
  });
});

describe('SplatRoom late joiners', () => {
  it('a mid-race joiner is parked at the gate, excluded from players[], racing next round', () => {
    const io = new FakeIO();
    const { room } = setupRace(io, ['p1', 'p2'], 42);
    const seed = io.lastSnap('p1').seed;

    room.addPlayer('p3', 'Late');
    const joined = io.joined('p3');
    expect(joined.phase).toBe('racing'); // the LIVE phase, not 'lobby'
    expect(joined.seed).toBe(seed); // builds the same mountain while waiting
    expect(joined.slot).toBe(2);
    expect(joined.players.length).toBe(3); // roster: everyone seated

    settle();
    const snap = io.lastSnap('p3');
    expect(snap.phase).toBe('racing');
    expect(snap.players.length).toBe(2); // EXCLUDED from the racer roster
    expect(snap.players.find((p) => p.id === 'p3')).toBeUndefined();
    expect(io.lastSnap('p1').players.length).toBe(2); // ...for everyone
    // parked you.sim at the gate on its grid slot
    expect(snap.you.sim.x).toBeCloseTo(gridX(2), 9);
    expect(snap.you.sim.z).toBeCloseTo(gridZ(2), 9);
    expect(snap.you.sim.finished).toBe(false);

    // nobody drives: hard cap -> results -> lobby, then the next START grids p3
    vi.advanceTimersByTime(RACE_HARD_CAP_MS + 2000);
    vi.advanceTimersByTime(RESULTS_MS + 2000);
    expect(io.lastSnap('p3').phase).toBe('lobby');

    room.handleMessage('p3', { t: 'start' }); // the late joiner may start it too
    advanceToPhase(io, 'p3', 'countdown');
    settle();
    // gridded at countdown entry: now a RACER, in players[] for everyone
    expect(io.lastSnap('p3').players.length).toBe(3);
    expect(io.lastSnap('p1').players.length).toBe(3);
    expect(snapOf(io, 'p3').x).toBeCloseTo(gridX(2), 9);
    room.stop();
  });
});

describe('SplatRoom ghosts', () => {
  it('a mid-race drop ghosts the seat (no player_left), and resume rebinds it intact', () => {
    const io = new FakeIO();
    const { room, drivers } = setupRace(io, ['p1', 'p2'], 42);
    const d = drivers[0]!;

    drive(room, [d], 120);
    settle();
    const zBefore = io.lastSnap('p1').you.sim.z;
    expect(zBefore).toBeGreaterThan(10); // setup guard: really mid-descent

    room.removePlayer('p1'); // socket drop: GHOST, no permanent flag
    settle();
    expect(eventsOfKind(io, 'p2', 'player_left').length).toBe(0); // invisible until results
    // the ghost racer stays in players[] with its frozen last state
    const ghostEntry = io.lastSnap('p2').players.find((p) => p.id === 'p1');
    expect(ghostEntry).toBeDefined();
    expect(ghostEntry?.z).toBeCloseTo(zBefore, 9);
    expect(room.playerCount()).toBe(1); // ...but never counts as "here"

    // rejoin with the platform resume param: SAME seat, sim intact
    room.addPlayer('p1b', 'AlphaReturns', 'p1');
    const joined = io.joined('p1b');
    expect(joined.slot).toBe(0); // same slot
    expect(joined.players.map((p) => p.id).sort()).toEqual(['p1b', 'p2']);
    settle();
    expect(io.lastSnap('p1b').you.sim.z).toBe(zBefore); // sim intact, exactly
    expect(io.lastSnap('p2').players.find((p) => p.id === 'p1b')).toBeDefined();

    // ...and the rebound skier races on from where it ghosted (same driver:
    // the seq keeps counting across the rebind)
    d.rebind('p1b');
    d.send(room, 0);
    tick();
    settle();
    expect(io.lastSnap('p1b').you.sim.z).toBeGreaterThan(zBefore);
    room.stop();
  });

  it('ghosts are swept at results: player_left is broadcast there, not before', () => {
    const io = new FakeIO();
    const { room } = setupRace(io, ['p1', 'p2'], 42);

    room.removePlayer('p2'); // ghost mid-race, never returns
    settle();
    expect(eventsOfKind(io, 'p1', 'player_left').length).toBe(0);

    vi.advanceTimersByTime(RACE_HARD_CAP_MS + 2000); // -> results (the sweep point)
    expect(io.lastSnap('p1').phase).toBe('results');
    const left = eventsOfKind(io, 'p1', 'player_left');
    expect(left.length).toBe(1);
    expect(left[0]!.id).toBe('p2');
    expect(io.roster('p1')?.players).toEqual([{ id: 'p1', name: 'Skier1', slot: 0 }]);
    room.stop();
  });
});

describe('SplatRoom wire budget + robustness', () => {
  it('snapshot stays <= 2KB at MAX_PLAYERS (8) racers', () => {
    const io = new FakeIO();
    const ids = Array.from({ length: MAX_PLAYERS }, (_, i) => `p${i + 1}`);
    const { room, drivers } = setupRace(io, ids, 42);

    drive(room, drivers, 60); // mid-race state: places + real positions live
    settle();
    for (const id of ids) {
      const bytes = JSON.stringify(io.lastSnap(id)).length;
      expect(bytes, `snapshot for ${id} fits the 2KB wire budget`).toBeLessThanOrEqual(2048);
    }
    room.stop();
  });

  it('bad messages are silently dropped and never kill the room', () => {
    const io = new FakeIO();
    const room = new SplatRoom('public', io);
    room.addPlayer('p1', 'Alpha');
    room.start();
    settle();

    const junk: unknown[] = [
      undefined,
      null,
      42,
      'splat_input',
      [],
      {},
      { t: 'nope' },
      { t: 'splat_input' }, // missing everything
      { t: 'splat_input', seq: -1, steer: 0, dt: SIM_DT },
      { t: 'splat_input', seq: 1.5, steer: 0, dt: SIM_DT },
      { t: 'splat_input', seq: 1, steer: Number.NaN, dt: Number.NaN },
      { t: 'splat_input', seq: 'a', steer: 0, dt: SIM_DT },
      { t: 'splat_assist' }, // missing `on`
      { t: 'splat_assist', on: 'yes' },
    ];
    for (const m of junk) {
      expect(() => room.handleMessage('p1', m)).not.toThrow();
    }
    // a valid message from an unknown id, and a remove for one, are no-ops too
    expect(() => room.handleMessage('ghost', { t: 'start' })).not.toThrow();
    expect(() => room.removePlayer('ghost')).not.toThrow();
    expect(() => room.removePlayer('ghost', true)).not.toThrow();

    vi.advanceTimersByTime(1000);
    expect(room.info().phase).toBe('lobby');
    expect(io.lastSnap('p1').you.lastProcessedSeq).toBe(-1); // nothing was consumed
    room.stop();
  });

  it('stalePlayers() reports only connected players past INPUT_STALE_MS', () => {
    const io = new FakeIO();
    const room = new SplatRoom('public', io);
    room.addPlayer('p1', 'Alpha');
    room.addPlayer('p2', 'Bravo');
    room.start();

    expect(room.stalePlayers()).toEqual([]);
    vi.advanceTimersByTime(11_000); // past INPUT_STALE_MS (10s), no messages
    expect(room.stalePlayers().sort()).toEqual(['p1', 'p2']);

    room.handleMessage('p1', { t: 'splat_assist', on: true }); // any valid msg is liveness
    expect(room.stalePlayers()).toEqual(['p2']);

    room.removePlayer('p2'); // a ghost is never reported stale (it has no socket)
    expect(room.stalePlayers()).toEqual([]);
    room.stop();
  });
});

describe('splatModule', () => {
  it('exposes the frozen module contract', () => {
    expect(splatModule.id).toBe('splat');
    expect(splatModule.name).toBe('SKI SPLAT');
    expect(splatModule.devPort).toBe(5178);
    expect(splatModule.minPlayers).toBe(MIN_PLAYERS);
    expect(splatModule.maxPlayers).toBe(MAX_PLAYERS);
    expect(splatModule.clientDist).toContain('splat');
  });

  it('settings: accepts undefined / {} / {seed:number}, throws otherwise', () => {
    expect(parseSplatRoomSettings(undefined)).toEqual({ seed: null });
    expect(parseSplatRoomSettings({})).toEqual({ seed: null });
    expect(parseSplatRoomSettings({ seed: 7 })).toEqual({ seed: 7 });

    const bad: Array<Record<string, unknown> | undefined> = [
      { seed: 'x' },
      { seed: Number.NaN },
      { seed: Number.POSITIVE_INFINITY },
      { foo: 1 },
      { seed: 1, foo: 2 },
    ];
    for (const s of bad) {
      expect(() => parseSplatRoomSettings(s)).toThrow();
    }

    const io = new FakeIO();
    expect(() =>
      splatModule.createRoom({ visibility: 'public', io, settings: { seed: 'x' } }),
    ).toThrow(); // the platform maps this to bad_settings
  });

  it('createRoom with {seed} overrides the slope seed for the race', () => {
    const io = new FakeIO();
    const room = splatModule.createRoom({ visibility: 'public', io, settings: { seed: 7 } });
    room.addPlayer('p1', 'Alpha');
    room.addPlayer('p2', 'Bravo');
    room.start();
    room.handleMessage('p1', { t: 'start' });
    advanceToPhase(io, 'p1', 'countdown');
    expect(io.lastSnap('p1').seed).toBe(7);
    room.stop();
  });
});
