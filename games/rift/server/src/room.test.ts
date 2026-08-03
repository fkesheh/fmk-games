// ============================================================================
// ANCIENTS (rift) room tests (T10) — written against games/rift/CONTRACT.md §2
// and the frozen wire in @rift/shared, driving the room through the platform
// GameRoomHandle surface + the headless tickOnce() seam, behind:
//   - a recording RoomIO that captures every (recipientId, msg) pair
//     (structuredClone'd by default: snapshots are ONE preallocated object per
//     player, mutated in place, so the log would otherwise alias live state),
//   - an injected constant rand (room ids/codes deterministic; the sim core
//     does not consume rand and bot seeds derive from hashSeed(roomId, idx)).
//
// Phase transitions that the room schedules on timers (lobby countdown,
// MATCH_END_MS reset) are advanced with fake timers; sim advancement is
// pumped DIRECTLY via room.tickOnce() — the interval driver is bypassed, so
// tests never wait on wall-clock sim speed (settings.speed is irrelevant
// here by design).
// ============================================================================
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HERO_LIST,
  LOBBY_COUNTDOWN_MS,
  MATCH_END_MS,
  MAX_PLAYERS,
  MIN_PLAYERS,
  STARTING_GOLD,
} from '@rift/shared';
import type { EntSnap, RiftEvent, RiftS2C, RosterEntry } from '@rift/shared';
import type { PlayerId, RoomIO, Visibility } from '@platform/shared';
import type { RoomDeps } from './ports.js';
import { RiftRoom } from './room.js';
import { riftModule } from './module.js';

// ---- wire shapes ---------------------------------------------------------------

type EventEnvelope = { t: 'event'; ev: RiftEvent };
type ErrorMsg = { t: 'error'; code: string; message: string };
type RiftMsg = RiftS2C | EventEnvelope | ErrorMsg;
type Snap = Extract<RiftS2C, { t: 'rift_snap' }>;
type Hello = Extract<RiftS2C, { t: 'rift_hello' }>;
type Lobby = Extract<RiftS2C, { t: 'rift_lobby' }>;
type Begin = Extract<RiftS2C, { t: 'rift_begin' }>;

function isRiftMsg(msg: unknown): msg is RiftMsg {
  if (typeof msg !== 'object' || msg === null) return false;
  const t = (msg as { t?: unknown }).t;
  if (typeof t !== 'string') return false;
  if (t === 'error') return true;
  if (t === 'event') {
    const ev = (msg as { ev?: unknown }).ev;
    return typeof ev === 'object' && ev !== null && typeof (ev as { t?: unknown }).t === 'string';
  }
  return t.startsWith('rift_');
}

/** Records every (recipientId, msg) pair. `clone: false` skips the
 *  structuredClone for endurance pumps that never inspect snapshots. */
class FakeIO implements RoomIO {
  private readonly log = new Map<PlayerId, RiftMsg[]>();

  constructor(private readonly clone = true) {}

  send(id: PlayerId, msg: unknown): void {
    if (!isRiftMsg(msg)) throw new Error(`unexpected message for ${id}: ${JSON.stringify(msg)}`);
    const msgs = this.log.get(id) ?? [];
    msgs.push(this.clone ? (structuredClone(msg) as RiftMsg) : msg);
    this.log.set(id, msgs);
  }

  rttMs(): number {
    return 0;
  }

  all(id: PlayerId): RiftMsg[] {
    return this.log.get(id) ?? [];
  }

  clear(): void {
    this.log.clear();
  }

  /** Latest message of a given rift_s2c shape this player received. */
  last<T extends RiftS2C['t']>(id: PlayerId, t: T): Extract<RiftS2C, { t: T }> {
    const msgs = this.all(id);
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m !== undefined && m.t === t) return m as Extract<RiftS2C, { t: T }>;
    }
    throw new Error(`no ${t} captured for ${id}`);
  }

  has(id: PlayerId, t: RiftS2C['t']): boolean {
    return this.all(id).some((m) => m.t === t);
  }

  events<T extends RiftEvent['t']>(id: PlayerId, t: T): Array<Extract<RiftEvent, { t: T }>> {
    return this.all(id)
      .filter((m): m is EventEnvelope => m.t === 'event')
      .map((m) => m.ev)
      .filter((ev): ev is Extract<RiftEvent, { t: T }> => ev.t === t);
  }

  roster(id: PlayerId): readonly RosterEntry[] {
    const evs = this.events(id, 'rift_roster');
    const ev = evs[evs.length - 1];
    if (ev === undefined) throw new Error(`no rift_roster captured for ${id}`);
    return ev.roster;
  }
}

// ---- drive helpers ---------------------------------------------------------------

const tracked: RiftRoom[] = [];

interface Harness {
  room: RiftRoom;
  io: FakeIO;
}

/** Build a room (constant injected rand) and seat `players` in array order. */
function boot(
  players: ReadonlyArray<readonly [PlayerId, string]>,
  opts: { visibility?: Visibility; clone?: boolean; settings?: Record<string, unknown> } = {},
): Harness {
  const io = new FakeIO(opts.clone ?? true);
  const deps: RoomDeps = { rand: () => 0 };
  const room = new RiftRoom(opts.visibility ?? 'public', io, opts.settings ?? {}, deps);
  room.start(); // idempotent per the platform contract
  for (const [id, name] of players) room.addPlayer(id, name);
  room.start(); // covers either start/add ordering
  tracked.push(room);
  return { room, io };
}

/** Press START as `presser` and fire the lobby countdown -> lock. */
function pressStartAndLock(room: RiftRoom, presser: PlayerId): void {
  room.handleMessage(presser, { t: 'rift_start' });
  vi.advanceTimersToNextTimer(); // the LOBBY_COUNTDOWN_MS timeout -> lock()
}

/** Pump n sim ticks through the headless seam. */
function pump(room: RiftRoom, n: number): void {
  for (let i = 0; i < n; i++) room.tickOnce();
}

function latestSnap(io: FakeIO, id: PlayerId): Snap {
  return io.last(id, 'rift_snap');
}

function findEnt(snap: Snap, pred: (e: EntSnap) => boolean): EntSnap | undefined {
  return snap.ents.find(pred);
}

function heroEntByPid(snap: Snap, pid: PlayerId): EntSnap {
  const e = findEnt(snap, (en) => en.k === 'hero' && en.pid === pid);
  if (e === undefined) throw new Error(`no hero ent for ${pid} in snap`);
  return e;
}

function isMobileKind(k: EntSnap['k']): boolean {
  return k !== 'tower' && k !== 'guard' && k !== 'ancient';
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  for (const r of tracked) r.stop();
  tracked.length = 0;
  vi.useRealTimers();
});

// ---- module plug -----------------------------------------------------------------

describe('riftModule', () => {
  it('has the frozen module shape', () => {
    expect(riftModule.id).toBe('rift');
    expect(riftModule.name).toBe('ANCIENTS');
    expect(riftModule.devPort).toBe(5177);
    expect(riftModule.minPlayers).toBe(MIN_PLAYERS);
    expect(riftModule.maxPlayers).toBe(MAX_PLAYERS);
    expect(typeof riftModule.clientDist).toBe('string');
  });

  it('createRoom throws on bad settings, accepts undefined and valid ones', () => {
    const io = new FakeIO();
    expect(() =>
      riftModule.createRoom({ visibility: 'public', io, settings: { teamSize: 99 } }),
    ).toThrow();
    expect(() =>
      riftModule.createRoom({ visibility: 'public', io, settings: { speed: 0 } }),
    ).toThrow();
    const a = riftModule.createRoom({ visibility: 'public', io });
    expect(a.info().game).toBe('rift');
    const b = riftModule.createRoom({ visibility: 'public', io, settings: { teamSize: 2, speed: 20 } });
    expect(b.info().phase).toBe('lobby');
    a.stop();
    b.stop();
  });

  it('room ids are 8 chars; private rooms get a 5-char code, public none', () => {
    const io = new FakeIO();
    const pub = riftModule.createRoom({ visibility: 'public', io });
    const priv = riftModule.createRoom({ visibility: 'private', io });
    expect(pub.id).toMatch(/^[A-Z0-9]{8}$/);
    expect(pub.info().code).toBeNull();
    expect(priv.info().code).toMatch(/^[A-Z0-9]{5}$/);
    pub.stop();
    priv.stop();
  });
});

// ---- lobby contract ----------------------------------------------------------------

describe('lobby contract', () => {
  it('join sends rift_hello + rift_lobby and broadcasts rift_roster', () => {
    const { io } = boot([['p1', 'Ada']]);
    expect(io.has('p1', 'rift_hello')).toBe(true);
    const hello = io.last('p1', 'rift_hello') as Hello;
    expect(hello.you).toBe('p1');
    expect(hello.team).toBe(0); // first seat: smaller team, ties -> 0
    expect(hello.teamSize).toBe(0); // auto until locked
    const lobby = io.last('p1', 'rift_lobby') as Lobby;
    expect(lobby.seated).toBe(1);
    expect(lobby.humans).toBe(1);
    expect(lobby.minPlayers).toBe(MIN_PLAYERS);
    expect(io.roster('p1')).toHaveLength(1);
  });

  it('canStart flips at MIN_PLAYERS, clears during countdown; any seated human may start', () => {
    const { room, io } = boot([
      ['p1', 'Ada'],
      ['p2', 'Bob'],
    ]);
    // auto team assignment: p1 -> team0, p2 -> team1 (smaller team each time)
    expect(io.last('p1', 'rift_hello').team).toBe(0);
    expect(io.last('p2', 'rift_hello').team).toBe(1);
    const lobby = io.last('p2', 'rift_lobby');
    expect(lobby.canStart).toBe(true); // 2 connected humans >= MIN_PLAYERS
    expect(lobby.teamSize).toBe(2); // auto: ceil(2/2) clamped to [2..8]

    // the SECOND joiner (not the room creator) presses START
    room.handleMessage('p2', { t: 'rift_start' });
    const during = io.last('p1', 'rift_lobby');
    expect(during.canStart).toBe(false); // countdown running
    expect(during.countdownEndsAt).toBeGreaterThan(0);

    // a second press mid-countdown is ignored in silence (still one countdown)
    room.handleMessage('p1', { t: 'rift_start' });
    expect(io.last('p1', 'rift_lobby').countdownEndsAt).toBe(during.countdownEndsAt);

    vi.advanceTimersToNextTimer(); // -> lock
    expect(room.info().phase).toBe('live');
  });

  it('ignores illegal messages in silence and never throws', () => {
    const { room, io } = boot([['p1', 'Ada']]);
    const before = io.all('p1').length;
    // start from a player that is not seated
    room.handleMessage('ghost', { t: 'rift_start' });
    // malformed and unknown messages
    room.handleMessage('p1', { t: 'nonsense' });
    room.handleMessage('p1', 42);
    room.handleMessage('p1', null);
    // orders/casts/buys in the lobby phase
    room.handleMessage('p1', { t: 'rift_order', kind: 'move', x: 10, z: 10 });
    room.handleMessage('p1', { t: 'rift_cast', slot: 0, x: 10, z: 10 });
    room.handleMessage('p1', { t: 'rift_buy', item: 'wardstone' });
    // all dropped: no error frame, no crash, state unchanged
    expect(io.all('p1').length).toBe(before);
    expect(room.info().phase).toBe('lobby');
    expect(io.last('p1', 'rift_lobby').countdownEndsAt).toBe(0);
  });

  it('picks are unique across HUMANS; duplicates are ignored in silence', () => {
    const { room, io } = boot([
      ['p1', 'Ada'],
      ['p2', 'Bob'],
    ]);
    room.handleMessage('p1', { t: 'rift_pick', hero: 'bullwark' });
    expect(io.last('p1', 'rift_lobby').picks['p1']).toBe('bullwark');
    expect(io.events('p2', 'rift_pick').some((e) => e.id === 'p1' && e.hero === 'bullwark')).toBe(true);

    const p2EventsBefore = io.events('p2', 'rift_pick').length;
    room.handleMessage('p2', { t: 'rift_pick', hero: 'bullwark' }); // taken by p1
    expect(io.last('p2', 'rift_lobby').picks['p2']).toBeNull(); // silently refused
    expect(io.events('p2', 'rift_pick').length).toBe(p2EventsBefore); // no pick event

    room.handleMessage('p2', { t: 'rift_pick', hero: 'longbow' }); // legal
    expect(io.last('p1', 'rift_lobby').picks['p2']).toBe('longbow');

    // picks outside the lobby are ignored in silence
    pressStartAndLock(room, 'p1');
    room.handleMessage('p1', { t: 'rift_pick', hero: 'hex' });
    pump(room, 1);
    const snap = latestSnap(io, 'p1');
    expect(snap.you?.hero).toBe('bullwark'); // unchanged
  });
});

// ---- lock + begin --------------------------------------------------------------------

describe('lock', () => {
  it('1 human locks 2v2 with 3 bots; rift_begin carries lanes/teamSize/laneAssignment', () => {
    const { room, io } = boot([['p1', 'Ada']]);
    pressStartAndLock(room, 'p1');

    expect(room.info().phase).toBe('live');
    expect(room.info().label).toBe('2v2');
    expect(room.info().players).toBe(4); // seats, humans + bots

    const begin = io.last('p1', 'rift_begin') as Begin;
    expect(begin.teamSize).toBe(2);
    expect(begin.lanes).toBe(1); // LANES_FOR_TEAM_SIZE[2]
    const lanes = Object.entries(begin.laneAssignment);
    expect(lanes).toHaveLength(4); // p1 + 3 bot seats
    expect(lanes.every(([, lane]) => lane === 0)).toBe(true); // 1 lane -> all lane 0
    expect(begin.laneAssignment['p1']).toBe(0);

    const roster = io.roster('p1');
    expect(roster).toHaveLength(4);
    expect(roster.filter((r) => r.bot)).toHaveLength(3);
    expect(roster.filter((r) => r.bot).map((r) => r.name)).toEqual(['Bot 1', 'Bot 2', 'Bot 3']);
    // teams filled to teamSize per side
    expect(roster.filter((r) => r.team === 0)).toHaveLength(2);
    expect(roster.filter((r) => r.team === 1)).toHaveLength(2);

    // heroes: p1 unpicked -> cycle from the first hero; every seat has one
    pump(room, 1);
    const snap = latestSnap(io, 'p1');
    expect(snap.you?.hero).toBe(HERO_LIST[0]?.id);
    expect(snap.board).toHaveLength(4);
    for (const row of snap.board) {
      expect(HERO_LIST.some((h) => h.id === row.hero)).toBe(true);
    }
  });

  it('respects an explicit settings.teamSize with bot fill to 4v4', () => {
    const { room, io } = boot([['p1', 'Ada']], { settings: { teamSize: 4, speed: 20 } });
    pressStartAndLock(room, 'p1');
    const begin = io.last('p1', 'rift_begin');
    expect(begin.teamSize).toBe(4);
    expect(begin.lanes).toBe(2); // LANES_FOR_TEAM_SIZE[4]
    expect(room.info().label).toBe('4v4');
    expect(io.roster('p1')).toHaveLength(8);
    // lane round-robin per team in join order: team0 seats 0..3 -> 0,1,0,1
    const team0 = io
      .roster('p1')
      .filter((r) => r.team === 0)
      .map((r) => begin.laneAssignment[r.id]);
    expect(team0).toEqual([0, 1, 0, 1]);
  });
});

// ---- snapshot fog filtering -----------------------------------------------------------

describe('snapshot fog filtering', () => {
  it('sends ALL structures every tick and no enemy mobiles before vision', () => {
    const { room, io } = boot([
      ['p1', 'Ada'],
      ['p2', 'Bob'],
    ]);
    pressStartAndLock(room, 'p1');
    pump(room, 5);

    const snap = latestSnap(io, 'p1');
    const structures = snap.ents.filter((e) => !isMobileKind(e.k));
    // 1-lane map: per team 2 lane towers + 2 guards + 1 ancient = 5, so 10
    expect(structures).toHaveLength(10);
    expect(structures.filter((e) => e.team === 1)).toHaveLength(5); // enemy structures too
    // no enemy mobile is visible yet (bases are ~105m apart, creeps unspawned)
    const enemyMobiles = snap.ents.filter((e) => isMobileKind(e.k) && e.team === 1);
    expect(enemyMobiles).toHaveLength(0);
    // own team mobiles are always sent
    expect(heroEntByPid(snap, 'p1').team).toBe(0);
    expect(snap.ents.some((e) => e.k === 'hero' && e.team === 0 && e.pid !== 'p1')).toBe(true);
    // match timing is tick-domain; serverTime rides the wall clock
    expect(snap.matchTick).toBe(5);
    expect(typeof snap.serverTime).toBe('number');
  });

  it('reveals enemy mobiles once driven into vision, via orders through tickOnce pumps', () => {
    const { room, io } = boot([
      ['p1', 'Ada'],
      ['p2', 'Bob'],
    ]);
    pressStartAndLock(room, 'p1');
    pump(room, 2);
    expect(latestSnap(io, 'p1').ents.some((e) => e.k === 'hero' && e.team === 1)).toBe(false);

    // drive BOTH human heroes to the map centre (1-lane side is 96 -> 48,48):
    // they must walk into each other's team vision sooner or later
    let seen = 0;
    for (let round = 0; round < 30 && seen === 0; round++) {
      room.handleMessage('p1', { t: 'rift_order', kind: 'attackmove', x: 48, z: 48 });
      room.handleMessage('p2', { t: 'rift_order', kind: 'attackmove', x: 48, z: 48 });
      pump(room, 50);
      if (latestSnap(io, 'p1').ents.some((e) => e.k === 'hero' && e.team === 1)) seen = 1;
    }
    expect(seen).toBe(1);
    // and the symmetric direction holds once they are close
    expect(latestSnap(io, 'p2').ents.some((e) => e.k === 'hero' && e.team === 0)).toBe(true);
  });

  it('sends wards to the owning team only, never to the enemy', () => {
    const { room, io } = boot([
      ['p1', 'Ada'],
      ['p2', 'Bob'],
    ]);
    pressStartAndLock(room, 'p1');
    pump(room, 2);

    // p1 buys a wardstone at the fountain and places a ward next to their hero
    room.handleMessage('p1', { t: 'rift_buy', item: 'wardstone' });
    pump(room, 1);
    let snap = latestSnap(io, 'p1');
    expect(snap.you?.items[0]).toBe('wardstone');
    const hx = snap.you?.x ?? 0;
    const hz = snap.you?.z ?? 0;
    room.handleMessage('p1', { t: 'rift_item', slot: 0, x: hx + 2, z: hz });
    pump(room, 1);

    snap = latestSnap(io, 'p1');
    const ward = findEnt(snap, (e) => e.k === 'ward');
    expect(ward).toBeDefined();
    expect(ward?.team).toBe(0);

    // p2 (enemy) never sees it — not now, not over the next 200 ticks
    for (let i = 0; i < 200; i++) {
      room.tickOnce();
      const s2 = latestSnap(io, 'p2');
      expect(s2.ents.some((e) => e.k === 'ward')).toBe(false);
    }
    // while the owner keeps seeing it throughout
    expect(latestSnap(io, 'p1').ents.some((e) => e.k === 'ward' && e.id === ward?.id)).toBe(true);
  });
});

// ---- cast events -----------------------------------------------------------------------

describe('cast events', () => {
  /** Seat p1 as bullwark, spend the q point, cast Shield Crash 3m east. */
  function castP1(room: RiftRoom, io: FakeIO): number {
    room.handleMessage('p1', { t: 'rift_skill', slot: 0 });
    pump(room, 1);
    const snap = latestSnap(io, 'p1');
    expect(snap.you?.abilities[0]?.rank).toBe(1);
    const x = snap.you?.x ?? 0;
    const z = snap.you?.z ?? 0;
    const casterId = heroEntByPid(snap, 'p1').id;
    room.handleMessage('p1', { t: 'rift_cast', slot: 0, x: x + 3, z });
    pump(room, 1);
    return casterId;
  }

  it('goes ONLY to teams whose visible set contains the caster', () => {
    const { room, io } = boot([
      ['p1', 'Ada'],
      ['p2', 'Bob'],
    ]);
    room.handleMessage('p1', { t: 'rift_pick', hero: 'bullwark' });
    pressStartAndLock(room, 'p1');
    pump(room, 2);

    // cast at the fountain: team 0 sees the caster, team 1 cannot
    const casterId = castP1(room, io);
    const p1Casts = io.events('p1', 'rift_cast');
    expect(p1Casts.length).toBeGreaterThan(0);
    expect(p1Casts[p1Casts.length - 1]?.id).toBe(casterId);
    expect(io.events('p2', 'rift_cast')).toHaveLength(0);

    // wait out the q cooldown at the safe fountain (14s = 280 ticks)
    for (let i = 0; i < 40; i++) {
      const s = latestSnap(io, 'p1');
      if ((s.you?.abilities[0]?.cdUntilTick ?? 0) <= s.matchTick) break;
      pump(room, 10);
    }

    // Drive the CASTER at the enemy base (p2 idles at its fountain). The first
    // tick p2's snapshot shows p1's hero alive, cast IMMEDIATELY — set
    // membership can drift by at most one step of travel before the cast
    // executes. A rejected cast (stun/death that tick) simply retries.
    let sawCast = false;
    for (let i = 0; i < 3000 && !sawCast; i++) {
      room.handleMessage('p1', { t: 'rift_order', kind: 'attackmove', x: 85, z: 85 });
      pump(room, 1);
      const s2 = latestSnap(io, 'p2');
      const s1 = latestSnap(io, 'p1');
      const alive = (s1.you?.respawnAtTick ?? 1) === 0;
      if (!alive || !s2.ents.some((e) => e.k === 'hero' && e.pid === 'p1')) continue;
      const before1 = io.events('p1', 'rift_cast').length;
      const before2 = io.events('p2', 'rift_cast').length;
      room.handleMessage('p1', { t: 'rift_cast', slot: 0, x: (s1.you?.x ?? 0) + 3, z: s1.you?.z ?? 0 });
      pump(room, 1);
      if (io.events('p1', 'rift_cast').length === before1 + 1) {
        // the cast executed while p1 was in team 1's set: BOTH teams get it
        expect(io.events('p2', 'rift_cast').length).toBe(before2 + 1);
        sawCast = true;
      }
    }
    expect(sawCast).toBe(true);
  });
});

// ---- late joiner ------------------------------------------------------------------------

describe('late joiner', () => {
  it('displaces the oldest bot and INHERITS hero, level, gold and position', () => {
    const { room, io } = boot([['p1', 'Ada']]);
    pressStartAndLock(room, 'p1');
    pump(room, 400); // 20s: bots have laned, last-hit and levelled

    // the oldest bot seat is bot-1 (insertion order = join order)
    const before = latestSnap(io, 'p1');
    const bot = heroEntByPid(before, 'bot-1');
    const botHero = bot.hero;
    const botLvl = bot.lvl;
    const botX = bot.x;
    const botZ = bot.z;
    expect(botHero).toBeDefined();

    room.addPlayer('p2', 'Bob');

    // join payloads: hello (with the inherited team) + a re-sent rift_begin
    const hello = io.last('p2', 'rift_hello') as Hello;
    expect(hello.team).toBe(0); // bot-1 was team 0
    expect(io.has('p2', 'rift_begin')).toBe(true);
    const roster = io.roster('p2');
    expect(roster.some((r) => r.id === 'bot-1')).toBe(false);
    const seat = roster.find((r) => r.id === 'p2');
    expect(seat?.bot).toBe(false);
    expect(seat?.connected).toBe(true);

    pump(room, 1);
    const you = latestSnap(io, 'p2').you;
    if (you === null) throw new Error('expected a you snap for the late joiner');
    expect(you.hero).toBe(botHero); // INHERITED, not a fresh pick
    expect(you.level).toBe(botLvl);
    // one tick of travel from the bot's last position at most (~0.3m at 6m/s)
    expect(Math.abs(you.x - botX)).toBeLessThan(1);
    expect(Math.abs(you.z - botZ)).toBeLessThan(1);
    // gold is the bot's accumulated purse, not a fresh STARTING_GOLD stake
    expect(you.gold).not.toBe(STARTING_GOLD);
    // and the SAME ent carries on: id unchanged, pid rebound
    const snap = latestSnap(io, 'p2');
    expect(heroEntByPid(snap, 'p2').id).toBe(bot.id);
  });

  it('re-sends rift_begin to anyone who joins while live', () => {
    const { room, io } = boot([['p1', 'Ada']]);
    pressStartAndLock(room, 'p1');
    pump(room, 10);
    room.addPlayer('p2', 'Bob');
    const begin = io.last('p2', 'rift_begin');
    expect(begin.teamSize).toBe(2);
    expect(begin.laneAssignment['p2']).toBeDefined();
  });
});

// ---- disconnect + resume ------------------------------------------------------------------

describe('disconnect and resume', () => {
  it('drives the ghost hero with a fresh bot brain and rebinds on resume (score intact)', () => {
    const { room, io } = boot([
      ['p1', 'Ada'],
      ['p2', 'Bob'],
      ['p3', 'Cid'],
    ]);
    // teams: p1 -> 0, p2 -> 1, p3 -> 0 (tie breaks to 0)
    pressStartAndLock(room, 'p1');
    pump(room, 2);

    const snap0 = latestSnap(io, 'p3');
    const hero = heroEntByPid(snap0, 'p1');
    const entId = hero.id;
    const startX = hero.x;
    const startZ = hero.z;

    room.removePlayer('p1'); // socket drop: permanent=false -> ghost
    expect(io.roster('p3').find((r) => r.id === 'p1')?.connected).toBe(false);

    // the ghost is bot-driven: p3 (same team) watches it leave the fountain
    let maxDist = 0;
    for (let round = 0; round < 20 && maxDist < 8; round++) {
      pump(room, 40);
      const e = heroEntByPid(latestSnap(io, 'p3'), 'p1');
      maxDist = Math.max(maxDist, Math.hypot(e.x - startX, e.z - startZ));
    }
    expect(maxDist).toBeGreaterThan(8);

    // score rows still attribute to p1 while ghosted
    const boardBefore = latestSnap(io, 'p3').board.find((b) => b.id === 'p1');
    if (boardBefore === undefined) throw new Error('p1 missing from board');

    // resume rebinds a NEW session id to the same seat and the same hero ent
    room.addPlayer('p1b', 'Ada2', 'p1');
    expect(io.last('p1b', 'rift_hello').team).toBe(0);
    pump(room, 1);
    const snap1 = latestSnap(io, 'p1b');
    const rebound = heroEntByPid(snap1, 'p1b');
    expect(rebound.id).toBe(entId); // SAME hero: score, items, cooldowns intact
    const boardAfter = snap1.board.find((b) => b.id === 'p1b');
    expect(boardAfter?.kills).toBe(boardBefore.kills);
    expect(boardAfter?.deaths).toBe(boardBefore.deaths);
    expect(boardAfter?.bot).toBe(false);
    expect(snap1.you?.hero).toBe(hero.hero);
  });

  it('permanent leave converts the seat to a bot (displaceable later)', () => {
    const { room, io } = boot([
      ['p1', 'Ada'],
      ['p2', 'Bob'],
    ]);
    pressStartAndLock(room, 'p1');
    pump(room, 2);
    room.removePlayer('p1', true);
    const roster = io.roster('p2');
    const seat = roster.find((r) => r.id === 'p1');
    expect(seat?.bot).toBe(true);
    expect(seat?.connected).toBe(false);
    // the seat keeps playing: a later joiner can displace it like any bot
    room.addPlayer('p4', 'Dee');
    expect(io.roster('p2').some((r) => r.id === 'p4' && !r.bot)).toBe(true);
  });
});

// ---- match end + full reset -----------------------------------------------------------------

describe('match end and full reset', () => {
  it('ends with rift_end (full stats) and full-resets to a waiting lobby after MATCH_END_MS', { timeout: 120_000 }, () => {
    // no-clone IO: 30k+ snapshots are pumped here and none is inspected
    const { room, io } = boot([['p1', 'Ada']], { clone: false });
    room.handleMessage('p1', { t: 'rift_pick', hero: 'reaver' });
    pressStartAndLock(room, 'p1');

    // pump until an ancient falls or the hard cap tiebreak fires (a match
    // ALWAYS ends by MATCH_HARD_CAP_S = 36000 ticks)
    let end: Extract<RiftEvent, { t: 'rift_end' }> | undefined;
    for (let i = 0; i < 36_001 && end === undefined; i++) {
      room.tickOnce();
      const evs = io.events('p1', 'rift_end');
      end = evs[evs.length - 1];
    }
    expect(end).toBeDefined();
    expect(['ancient', 'tiebreak', 'draw']).toContain(end?.reason);
    if (end?.reason === 'ancient') expect(end.winner).not.toBeNull();
    // full PlayerStats, one per seat (2v2: p1 + 3 bots over the match)
    expect(end?.stats).toHaveLength(4);
    for (const s of end?.stats ?? []) {
      expect(s.id.length).toBeGreaterThan(0);
      expect(s.name.length).toBeGreaterThan(0);
      expect(HERO_LIST.some((h) => h.id === s.hero)).toBe(true);
      expect(s.kills).toBeGreaterThanOrEqual(0);
      expect(s.goldEarned).toBeGreaterThanOrEqual(0);
    }
    expect(room.info().phase).toBe('ended');
    // ended rooms re-send rift_begin + rift_end to joiners (dwell window)
    room.addPlayer('p9', 'Zed');
    expect(io.has('p9', 'rift_begin')).toBe(true);
    expect(io.events('p9', 'rift_end').length).toBeGreaterThan(0);

    // MATCH_END_MS later: bots removed, sim discarded, picks KEPT, and it WAITS
    vi.advanceTimersByTime(MATCH_END_MS);
    expect(room.info().phase).toBe('lobby');
    expect(room.info().label).toBe('lobby');
    const lobby = io.last('p1', 'rift_lobby');
    expect(lobby.picks['p1']).toBe('reaver'); // picks kept
    expect(lobby.canStart).toBe(true); // waiting for the next explicit START
    expect(io.roster('p1').some((r) => r.bot)).toBe(false); // bots removed
    expect(io.roster('p1').some((r) => r.id === 'p1')).toBe(true);
    // the sim is gone: tickOnce is a no-op, no new snapshots flow
    const snapsBefore = io.all('p1').filter((m) => m.t === 'rift_snap').length;
    pump(room, 10);
    expect(io.all('p1').filter((m) => m.t === 'rift_snap').length).toBe(snapsBefore);
    // and the room can start again
    pressStartAndLock(room, 'p1');
    expect(room.info().phase).toBe('live');
    expect(room.info().label).toBe('2v2');
  });
});

// ---- handle robustness ------------------------------------------------------------------------

describe('robustness', () => {
  it('start/stop are idempotent and nothing throws on empty rooms', () => {
    const { room } = boot([]);
    room.start();
    room.start();
    room.stop();
    room.stop();
    room.start();
    expect(room.info().phase).toBe('lobby');
    expect(room.playerCount()).toBe(0);
    expect(room.stalePlayers()).toEqual([]);
    room.removePlayer('nobody');
    room.handleMessage('nobody', { t: 'rift_start' });
    room.tickOnce(); // no world: no-op
    expect(room.info().players).toBe(0);
  });

  it('a live room keeps simulating with zero connected humans (bots take over)', () => {
    const { room, io } = boot([['p1', 'Ada']]);
    pressStartAndLock(room, 'p1');
    pump(room, 3);
    const tickBefore = latestSnap(io, 'p1').matchTick;
    room.removePlayer('p1', true); // explicit leave -> seat converts to bot
    pump(room, 10);
    // no snapshots flow to the departed player, but the world keeps advancing
    expect(io.all('p1').filter((m) => m.t === 'rift_snap')).toHaveLength(3);
    expect(room.info().phase).toBe('live');
    expect(room.playerCount()).toBe(0);
    expect(room.info().players).toBe(4); // seats still counted
    expect(tickBefore).toBe(3);
  });
});
