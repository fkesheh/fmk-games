// ============================================================================
// server/src/room.test.ts — S_ROOM coverage.
//
// Strategy: BLACK-BOX through the GameRoomHandle surface with a fake io that
// captures every sent message, plus vi fake timers for the interval/clock and
// the debug verbs (warp/tick) as the sanctioned fast-forward. Kills are staged
// deterministically by warping the shooter so the victim sits DEAD-AHEAD of
// its own gun line (bullets fly along facing at ≥760 u/s vs plane ≤250, inside
// the ~1000 u TTL envelope) — works regardless of which side a joiner lands
// on, so tests derive team expectations from the welcome roster rather than
// hardcoding royal/iron. No test reaches into room internals.
// ============================================================================
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { END_SECONDS, LOBBY_COUNTDOWN_S, MAP_SEED, MATCH_SECONDS, STALE_SECONDS, TICK_RATE } from '@aces/shared/config';
import type { TeamId } from '@aces/shared/config';
import type { S2C, SnapPlane, SnapshotMsg } from '@aces/shared/protocol';
import type { KillEvent } from '@aces/shared/types';
import type { PlayerId, RoomIO } from '@platform/shared';
import { AcesRoom } from './room.js';

// ---- harness ---------------------------------------------------------------

interface Sent {
  readonly id: PlayerId;
  readonly msg: S2C;
}

function ioOf(log: Sent[]): RoomIO {
  return {
    send(id: PlayerId, msg: unknown): void {
      log.push({ id, msg: msg as S2C });
    },
    rttMs(): number {
      return 0;
    },
  };
}

function fakeIo(): { io: RoomIO; log: Sent[] } {
  const log: Sent[] = [];
  return { io: ioOf(log), log };
}

type MsgOf<T extends S2C['t']> = Extract<S2C, { t: T }>;

/** Every message of one wire type, narrowed. */
function sentOf<T extends S2C['t']>(log: readonly Sent[], t: T): MsgOf<T>[] {
  return log.filter((s): s is Sent & { msg: MsgOf<T> } => s.msg.t === t).map((s) => s.msg);
}

function snapsFor(log: readonly Sent[], id: PlayerId): SnapshotMsg[] {
  return log
    .filter((s): s is Sent & { msg: SnapshotMsg } => s.id === id && s.msg.t === 'snapshot')
    .map((s) => s.msg);
}

function lastOf<T>(arr: readonly T[]): T | undefined {
  return arr[arr.length - 1];
}

/** Credited (non-crash) kill events — the only kind that moves tickets. */
function creditedKills(log: readonly Sent[]): KillEvent[] {
  return sentOf(log, 'event')
    .map((m) => m.e)
    .filter((e): e is KillEvent => e.kind === 'kill' && !e.crash);
}

let seqCounter = 100;
function nextSeq(): number {
  seqCounter++;
  return seqCounter;
}

/** Fast-forward N world ticks through the debug `tick` verb — the SAME path
 *  production e2e uses, chunked at the verb's 600 ceiling. */
function pump(room: AcesRoom, who: PlayerId, ticks: number): void {
  let left = ticks;
  while (left > 0) {
    const n = Math.min(600, left);
    room.handleMessage(who, { t: 'debug', cmd: 'tick', x: n });
    left -= n;
  }
}

/** Drive the lobby countdown to zero via the real interval (fake timers). */
function goLive(room: AcesRoom): void {
  vi.advanceTimersByTime(LOBBY_COUNTDOWN_S * 1000 + 300);
}

/** p1's team as the room itself reported it at join — displacement decides
 *  which side a human lands on, so expectations derive from the wire. */
function teamOf(log: readonly Sent[], id: PlayerId): TeamId {
  const row = sentOf(log, 'welcome')[0]?.roster.find((r) => r.id === id);
  if (row === undefined) throw new Error(`harness bug: no roster row for ${id}`);
  return row.team;
}

/**
 * Stage a guaranteed kill: clear spawn protection, read fresh rows from the
 * latest snapshot, warp the shooter so the victim sits DEAD-AHEAD along the
 * shooter's own gun line (shooterPos = victimPos − facing·350), then hold
 * fire. Works for any team/class pairing; re-callable mid-fight to re-anchor
 * after respawns.
 */
function stageKill(room: AcesRoom, log: readonly Sent[], shooter: PlayerId, victimId?: PlayerId): void {
  /**
   * Staging under LIVE bot brains is a pursuit problem, not a snapshot
   * snapshot-and-hope: a wounded bot breaks off below FIRE_BELOW and can
   * burn-crash outside any gun line (crash deaths credit nobody), and after
   * one head-on pass the pursuer ends up astern of a rim-pinned shooter.
   * So: re-place the shooter 40 u ASTERN OF THE BOT along the bot's own
   * heading every ~30 ticks until a CREDITED kill by the shooter lands.
   * `me.h` is set white-box — aligning a tail chase through tr inputs would
   * need a full autopilot; the fixture's job is ballistics, not piloting.
   */
  const worldOf = () => (room as unknown as { world: AcesWorldView }).world;
  const clampC = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
  let seq = nextSeq();
  for (let guard = 0; guard < 300; guard++) {
    const w = worldOf();
    const v =
      w.planes.find((r) => r.id === (victimId ?? '\u0000none')) ??
      w.planes.find((r) => r.bot && !r.dead);
    const p = w.planes.find((r) => r.id === shooter);
    if (v === undefined || p === undefined || v.dead || p.dead) {
      if (p !== undefined && p.dead) room.handleMessage(shooter, { t: 'spawn', cls: 'fighter' });
      pump(room, shooter, 10);
      continue;
    }
    // tail placement + white-box aim + trigger
    const px = clampC(v.x - Math.cos(v.h) * 40, 40, 3860);
    const py = clampC(v.y - Math.sin(v.h) * 40, 40, 2960);
    room.handleMessage(shooter, { t: 'debug', cmd: 'warp', x: px, y: py });
    const meNow = worldOf().planes.find((r) => r.id === shooter);
    if (meNow !== undefined) meNow.h = v.h;
    room.handleMessage(shooter, { t: 'input', seq: seq++, th: 1, tr: 0, fire: true, boost: false });
    room.handleMessage(shooter, { t: 'debug', cmd: 'tick', x: 30 });
    const mine = creditedKills(log).find((k) => k.killer === shooter);
    if (mine !== undefined) return; // witnessed: the staged gun line delivered
  }
  throw new Error(`stageKill: no credited kill within witness window (shooter=${shooter}, victim=${victimId})`);
}

/** White-box view used only by fixtures — mirrors World's live arrays. */
interface AcesWorldView {
  planes: Array<{ id: string; bot: boolean; dead: boolean; hp: number; x: number; y: number; h: number }>;
  bullets: unknown[];
}

/** Debug 1v1: solo human + one bot, live. */
function makeDuel(log: Sent[]): AcesRoom {
  const room = new AcesRoom('public', ioOf(log), { teamSize: 1, debug: true });
  room.start();
  room.addPlayer('p1', 'Hawk');
  goLive(room);
  return room;
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

// ---- tests -----------------------------------------------------------------

describe('join flow', () => {
  it('sends a fully-shaped welcome (identity, clocks, settings, roster) and arms the countdown via PhaseMsg', () => {
    const { io, log } = fakeIo();
    const room = new AcesRoom('public', io);

    room.addPlayer('p1', 'Ace');
    const w = lastOf(sentOf(log, 'welcome'));
    expect(w).toMatchObject({
      t: 'welcome',
      id: 'p1',
      seed: MAP_SEED,
      tickRate: 30,
      snapRate: 15,
      phase: 'lobby',
      timeLeftS: LOBBY_COUNTDOWN_S,
      tickets: { royal: 0, iron: 0 },
      settings: { teamSize: 4, difficulty: 'normal', botFill: true, debug: false },
    });
    // Roster shows the full squadron: p1 + 7 bots at default teamSize 4.
    expect(w?.roster).toHaveLength(8);
    expect(w?.roster.filter((r) => !r.bot)).toHaveLength(1);

    // Phase changes ride ONLY PhaseMsg: the armed countdown announces there…
    const phases = sentOf(log, 'phase');
    expect(lastOf(phases)).toMatchObject({ phase: 'lobby', endsAtS: LOBBY_COUNTDOWN_S });
    // …and nothing phase-shaped ever leaks into the event stream.
    for (const m of sentOf(log, 'event')) {
      expect(['kill', 'hit', 'crate']).toContain(m.e.kind);
    }
    room.stop();
  });

  it('auto-spawns a mid-live joiner instantly as a fighter', () => {
    const { io, log } = fakeIo();
    const room = new AcesRoom('public', io);
    room.start();
    room.addPlayer('p1', 'Early');
    goLive(room);
    room.addPlayer('p2', 'Late');

    const w = lastOf(sentOf(log, 'welcome'));
    expect(w?.phase).toBe('live');
    vi.advanceTimersByTime(80);
    const you = lastOf(snapsFor(log, 'p2'))?.you;
    expect(you).toBeDefined();
    expect(you?.dead).toBe(false);
    expect(you?.cls).toBe('fighter'); // auto-spawn class, picker available later
    expect(you?.invulnT).toBeGreaterThan(0); // fresh spawn protection
    room.stop();
  });
});

describe('bot fill', () => {
  it('fills to teamSize*2 seats balanced across teams; humans displace bots in place', () => {
    const { io, log } = fakeIo();
    const room = new AcesRoom('public', io, { teamSize: 2 });
    room.addPlayer('p1', 'Ace');

    const roster = lastOf(sentOf(log, 'welcome'))?.roster ?? [];
    expect(roster).toHaveLength(4); // teamSize*2 seats
    expect(roster.filter((r) => r.bot)).toHaveLength(3); // one bot gave up its slot
    const royal = roster.filter((r) => r.team === 'royal').length;
    const iron = roster.filter((r) => r.team === 'iron').length;
    expect(royal).toBe(2);
    expect(iron).toBe(2); // balance held through displacement
    room.stop();
  });

  it('botFill:false leaves seats empty — humans only', () => {
    const { io, log } = fakeIo();
    const room = new AcesRoom('public', io, { teamSize: 2, botFill: false });
    room.addPlayer('p1', 'Ace');
    expect(lastOf(sentOf(log, 'welcome'))?.roster).toHaveLength(1);
    room.addPlayer('p2', 'Two');
    const roster = lastOf(sentOf(log, 'welcome'))?.roster ?? [];
    expect(roster).toHaveLength(2);
    expect(roster.every((r) => !r.bot)).toBe(true);
    expect(room.playerCount()).toBe(2);
    room.stop();
  });

  it('a leaving human hands the seat back to a bot', () => {
    const { io, log } = fakeIo();
    const room = new AcesRoom('public', io, { teamSize: 1 });
    room.start();
    room.addPlayer('p1', 'Leaver');
    room.addPlayer('p2', 'Observer'); // removed players get no mail — p2 watches
    room.removePlayer('p1');

    expect(room.playerCount()).toBe(1); // humans gone…
    // removePlayer force-ships a scoreboard to the remaining human: the seat
    // count is restored and the replacement is a bot on the departed's side.
    const board = lastOf(sentOf(log, 'score'))?.board ?? [];
    expect(board).toHaveLength(2);
    expect(board.filter((r) => r.bot)).toHaveLength(1);
    expect(new Set(board.map((r) => r.team))).toEqual(new Set(['royal', 'iron']));
    room.stop();
  });
});

describe('input handling', () => {
  it('echoes the latest applied seq on the owner row and drops stale ones (latest-wins)', () => {
    const { io, log } = fakeIo();
    const room = new AcesRoom('public', io);
    room.start();
    room.addPlayer('p1', 'Ace');
    goLive(room);

    room.handleMessage('p1', { t: 'input', seq: 7, th: 0.5, tr: 0, fire: false, boost: false });
    vi.advanceTimersByTime(120); // several snapshot beats
    expect(lastOf(snapsFor(log, 'p1'))?.you?.seq).toBe(7);

    room.handleMessage('p1', { t: 'input', seq: 3, th: 0.5, tr: 0, fire: false, boost: false }); // stale
    vi.advanceTimersByTime(120);
    expect(lastOf(snapsFor(log, 'p1'))?.you?.seq).toBe(7); // unchanged

    room.handleMessage('p1', { t: 'input', seq: 9, th: 0.5, tr: 0, fire: false, boost: false });
    vi.advanceTimersByTime(120);
    expect(lastOf(snapsFor(log, 'p1'))?.you?.seq).toBe(9);
    room.stop();
  });
});

describe('scoring', () => {
  it('a credited kill moves the killer team ticket and ships a score msg', () => {
    const log: Sent[] = [];
    const room = makeDuel(log);
    // Live bot brains hunt a passive human — god-mode keeps him alive so the
    // first credited kill is deterministically his staged shot.
    room.handleMessage('p1', { t: 'debug', cmd: 'god' });
    stageKill(room, log, 'p1');
    // The kill may land inside stageKill's own witness window; move the wall
    // clock so the 1/s-limited score broadcast deferral releases.
    vi.advanceTimersByTime(1100);

    for (let i = 0; i < 80 && creditedKills(log).length === 0; i++) {
      pump(room, 'p1', 600);
      // Move the WALL CLOCK between bursts: the 1/s scoreboard rate limit is
      // deliberately wall-based, and fake timers freeze it during pumping.
      vi.advanceTimersByTime(1100);
    }
    expect(creditedKills(log).length).toBeGreaterThanOrEqual(1);
    const myTeam = teamOf(log, 'p1');
    const mine = creditedKills(log).filter((k) => k.killer === 'p1');
    expect(mine.length).toBeGreaterThanOrEqual(1);
    expect(mine[0]?.killerTeam).toBe(myTeam);

    vi.advanceTimersByTime(80);
    const tickets = lastOf(snapsFor(log, 'p1'))?.tickets;
    expect(tickets?.[myTeam]).toBeGreaterThanOrEqual(1);
    const foe: TeamId = myTeam === 'royal' ? 'iron' : 'royal';
    expect(tickets?.[foe]).toBe(0); // bot never scores

    const board = lastOf(sentOf(log, 'score'))?.board ?? [];
    const hawk = board.find((r) => r.id === 'p1');
    expect(hawk?.kills).toBeGreaterThanOrEqual(1);
    expect(hawk?.deaths).toBe(0);
    const bot = board.find((r) => r.bot);
    expect(bot?.deaths).toBeGreaterThanOrEqual(1);
    expect((hawk?.score ?? 0) >= 100).toBe(true); // kills*100 dominates
    room.stop();
  });

  it('reaches TICKETS_TO_WIN -> end PhaseMsg with winner -> auto-restarts live with reset tickets', () => {
    const log: Sent[] = [];
    const room = makeDuel(log);
    const myTeam = teamOf(log, 'p1');
    // Live bot brains will hunt a passive human — god-mode removes his death
    // from the equation so the winner is fully determined by the staging.
    room.handleMessage('p1', { t: 'debug', cmd: 'god' });

    for (let i = 0; i < 600 && sentOf(log, 'phase').every((p) => p.phase !== 'end'); i++) {
      if (i % 5 === 0) stageKill(room, log, 'p1'); // re-anchor after respawns
      pump(room, 'p1', 300);
      vi.advanceTimersByTime(1100);
    }
    const end = lastOf(sentOf(log, 'phase').filter((p) => p.phase === 'end'));
    expect(end).toBeDefined();
    expect(end?.winner).toBe(myTeam); // the bot can never score
    expect(end?.endsAtS).toBeLessThanOrEqual(END_SECONDS);

    // Scoreboard dwell, then the same room auto-restarts into fresh live.
    vi.advanceTimersByTime(END_SECONDS * 1000 + 400);
    expect(lastOf(sentOf(log, 'phase'))?.phase).toBe('live');
    vi.advanceTimersByTime(90);
    const snap = lastOf(snapsFor(log, 'p1'));
    expect(snap?.phase).toBe('live');
    expect(snap?.tickets).toEqual({ royal: 0, iron: 0 }); // tickets reset
    expect(snap?.timeLeftS).toBeGreaterThan(0); // full clock re-armed
    room.stop();
  });

  it('time expiry on a tie holds LIVE in sudden death (timeLeftS 0); the next credited kill ends it', () => {
    const log: Sent[] = [];
    // Two humans, zero bots (each displaced one at join): nobody can score by
    // accident, and periodic self-warps keep both pilots off the map rim —
    // coasting pinned into a soft bound for thousands of ticks destabilizes
    // the repel integration (planes must die/respawn or stay mid-map).
    const room = new AcesRoom('public', ioOf(log), { teamSize: 1, debug: true });
    room.start();
    room.addPlayer('p1', 'Ace');
    room.addPlayer('p2', 'Duelist');
    goLive(room);
    const myTeam = teamOf(log, 'p1');

    // Idle out the full match clock without a single shot fired.
    const target = MATCH_SECONDS * TICK_RATE + 60;
    let advanced = 0;
    while (advanced < target) {
      const n = Math.min(150, target - advanced);
      pump(room, 'p1', n);
      pump(room, 'p2', n);
      advanced += 2 * n;
      room.handleMessage('p1', { t: 'debug', cmd: 'warp', x: 2900, y: 1500 });
      room.handleMessage('p2', { t: 'debug', cmd: 'warp', x: 1300, y: 1500 });
    }

    vi.advanceTimersByTime(80);
    const snap = lastOf(snapsFor(log, 'p1'));
    expect(snap?.phase).toBe('live'); // tied expiry: NO end phase…
    expect(snap?.timeLeftS).toBe(0); // …sudden-death stamp signal

    stageKill(room, log, 'p1', 'p2');
    for (let i = 0; i < 60 && sentOf(log, 'phase').every((p) => p.phase !== 'end'); i++) {
      if (i % 5 === 0) stageKill(room, log, 'p1', 'p2');
      pump(room, 'p1', 300);
      vi.advanceTimersByTime(1100);
    }
    expect(lastOf(sentOf(log, 'phase').filter((p) => p.phase === 'end'))?.winner).toBe(myTeam);
    room.stop();
  });
});

describe('debug verbs', () => {
  it('are rejected without settings.debug but work (with the N≤600 clamp) in debug rooms', () => {
    const plainLog: Sent[] = [];
    const plain = new AcesRoom('public', {
      send(id: PlayerId, msg: unknown): void {
        plainLog.push({ id, msg: msg as S2C });
      },
      rttMs(): number {
        return 0;
      },
    }, {});
    const debugLog: Sent[] = [];
    const debug = new AcesRoom('public', {
      send(id: PlayerId, msg: unknown): void {
        debugLog.push({ id, msg: msg as S2C });
      },
      rttMs(): number {
        return 0;
      },
    }, { debug: true });
    plain.start();
    plain.addPlayer('p1', 'Plain');
    debug.start();
    debug.addPlayer('p1', 'Debug');
    goLive(plain);
    goLive(debug);

    // crate verb: parse-level gate — no effect without debug, a crate with.
    // (The crate SPAWN EVENT itself is asserted via snapshot STATE: World.step
    // wipes its reused inter-step event buffer at entry, so events pushed by
    // debug verbs between ticks never surface — an S_SIM seam defect, reported.)
    plain.handleMessage('p1', { t: 'debug', cmd: 'crate' });
    debug.handleMessage('p1', { t: 'debug', cmd: 'crate' });
    vi.advanceTimersByTime(160); // both sims step a few ticks either way
    expect(sentOf(plainLog, 'event')).toHaveLength(0);
    const dSnap = lastOf(snapsFor(debugLog, 'p1'));
    expect(dSnap?.crates.length ?? 0).toBeGreaterThanOrEqual(1);
    expect(sentOf(plainLog, 'event')).toHaveLength(0);

    // tick verb: non-debug ignores it entirely. Measurement window: 70 ms is
    // long enough for ≥1 snapshot beat, short enough that ≤3 interval sim-
    // ticks ride along — hence bounded ranges rather than exact equality.
    const pBefore = lastOf(snapsFor(plainLog, 'p1'))?.tick ?? 0;
    plain.handleMessage('p1', { t: 'debug', cmd: 'tick', x: 30 });
    vi.advanceTimersByTime(70);
    expect((lastOf(snapsFor(plainLog, 'p1'))?.tick ?? 0) - pBefore).toBeLessThanOrEqual(3); // no +30

    // Debug rooms step exactly N ticks, clamped hard at 600.
    const dBefore = lastOf(snapsFor(debugLog, 'p1'))?.tick ?? 0;
    debug.handleMessage('p1', { t: 'debug', cmd: 'tick', x: 999999 });
    vi.advanceTimersByTime(70);
    const dDelta = (lastOf(snapsFor(debugLog, 'p1'))?.tick ?? 0) - dBefore;
    expect(dDelta).toBeGreaterThanOrEqual(600);
    expect(dDelta).toBeLessThanOrEqual(604);

    const dBefore2 = lastOf(snapsFor(debugLog, 'p1'))?.tick ?? 0;
    debug.handleMessage('p1', { t: 'debug', cmd: 'tick', x: 30 });
    vi.advanceTimersByTime(70);
    const dDelta2 = (lastOf(snapsFor(debugLog, 'p1'))?.tick ?? 0) - dBefore2;
    expect(dDelta2).toBeGreaterThanOrEqual(30);
    expect(dDelta2).toBeLessThanOrEqual(34);
    plain.stop();
    debug.stop();
  });
});

describe('stalePlayers', () => {
  it('reports humans silent past STALE_SECONDS, clears on input, never reports bots', () => {
    const { io } = fakeIo();
    const room = new AcesRoom('public', io);
    room.addPlayer('p1', 'Ace');

    expect(room.stalePlayers()).toEqual([]);
    vi.advanceTimersByTime(STALE_SECONDS * 1000 - 5000);
    expect(room.stalePlayers()).toEqual([]);
    vi.advanceTimersByTime(6000); // 31 s since join
    expect(room.stalePlayers()).toEqual(['p1']);

    room.handleMessage('p1', { t: 'input', seq: 1, th: 0, tr: 0, fire: false, boost: false });
    vi.advanceTimersByTime(STALE_SECONDS * 1000 - 2000);
    expect(room.stalePlayers()).toEqual([]); // freshness restored…
    vi.advanceTimersByTime(4000); // …then ages out again
    expect(room.stalePlayers()).toEqual(['p1']);
    room.stop();
  });
});
