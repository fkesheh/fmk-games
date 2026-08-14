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
  buildMap,
  DAY_PERIOD_S,
  dayPhase,
  HERO_LIST,
  INVENTORY_SLOTS,
  isCampKind,
  ITEMS,
  LOBBY_COUNTDOWN_MS,
  MATCH_END_MS,
  MAX_PLAYERS,
  MIN_PLAYERS,
  NEUTRAL_TEAM,
  sellValue,
  STARTING_GOLD,
  TICK_RATE,
} from '@rift/shared';
import type { EntSnap, ItemId, RiftEvent, RiftS2C, RosterEntry } from '@rift/shared';
import type { PlayerId, RoomIO, Visibility } from '@platform/shared';
import type { RoomDeps } from './ports.js';
import { RiftRoom } from './room.js';
import { riftModule } from './module.js';
import type { BotBrain, BotPercept, CampPercept, Ent, World } from './sim/types.js';

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

function campEnts(snap: Snap): EntSnap[] {
  return snap.ents.filter((e) => isCampKind(e.k));
}

/**
 * Test-only view of the room's private live state. The room exposes no getter
 * for either — nothing in production needs one — but three things it MUST
 * handle cannot be provoked through the public surface inside a test's budget:
 * a `miss` SimEvent (needs an attacker on low ground and a target on high one,
 * plus a losing `missRoll`), a `kill` whose victim holds no seat, and a camp
 * wiped to the last creep. Driving them through `World.pushEvent` / a direct
 * hp write is the same world seam the sim itself uses, so the room still runs
 * its real dispatch and snapshot paths.
 */
interface RoomInternals {
  world: World | null;
  seats: Array<{ pid: PlayerId; bot: boolean; brain: BotBrain | null; sig: string | null }>;
}

function internals(room: RiftRoom): RoomInternals {
  return room as unknown as RoomInternals;
}

function worldOf(room: RiftRoom): World {
  const w = internals(room).world;
  if (w === null) throw new Error('room has no live world');
  return w;
}

/** Zero every living member of one camp; the next tickOnce reaps them. */
function wipeCamp(room: RiftRoom, campId: number): number {
  const w = worldOf(room);
  const camp = w.camps[campId];
  if (camp === undefined) throw new Error(`no camp ${campId}`);
  let n = 0;
  for (const id of camp.memberIds) {
    const e = w.get(id);
    if (e !== undefined && e.alive) {
      e.hp = 0;
      n += 1;
    }
  }
  return n;
}

/**
 * One tick's percept as the bot actually received it. `camps` is a buffer the
 * room owns and mutates, so reading it later cannot distinguish "refreshed in
 * place" from "refilled with fresh objects" — the element references and the
 * `up` flags have to be copied out AT THE MOMENT of the call. (A first cut of
 * this file read them live and a rebuild-every-tick mutation went undetected.)
 */
interface PerceptShot {
  percept: BotPercept;
  /** The array instance handed over. */
  campsArray: readonly CampPercept[];
  /** Its element references at that instant. */
  entries: readonly CampPercept[];
  /** Their `up` flags at that instant. */
  up: readonly boolean[];
}

/** Replace a bot seat's brain with a recorder and return the capture log. */
function recordBotPercepts(room: RiftRoom): PerceptShot[] {
  const seen: PerceptShot[] = [];
  const seat = internals(room).seats.find((s) => s.bot);
  if (seat === undefined) throw new Error('no bot seat to record');
  seat.brain = {
    tick(p: BotPercept) {
      seen.push({
        percept: p,
        campsArray: p.camps,
        entries: [...p.camps],
        up: p.camps.map((c) => c.up),
      });
      return [];
    },
  };
  return seen;
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

  it('picks allow DUPLICATES: any seated human may pick an already-taken hero', () => {
    const { room, io } = boot([
      ['p1', 'Ada'],
      ['p2', 'Bob'],
    ]);
    room.handleMessage('p1', { t: 'rift_pick', hero: 'bullwark' });
    expect(io.last('p1', 'rift_lobby').picks['p1']).toBe('bullwark');
    expect(io.events('p2', 'rift_pick').some((e) => e.id === 'p1' && e.hero === 'bullwark')).toBe(true);

    const p2EventsBefore = io.events('p2', 'rift_pick').length;
    room.handleMessage('p2', { t: 'rift_pick', hero: 'bullwark' }); // same hero as p1 -> now ACCEPTED
    expect(io.last('p2', 'rift_lobby').picks['p2']).toBe('bullwark'); // no longer refused
    expect(io.last('p1', 'rift_lobby').picks['p1']).toBe('bullwark'); // p1's own pick untouched
    expect(io.events('p2', 'rift_pick').length).toBe(p2EventsBefore + 1); // the duplicate pick IS broadcast
    expect(io.events('p2', 'rift_pick').some((e) => e.id === 'p2' && e.hero === 'bullwark')).toBe(true);

    room.handleMessage('p2', { t: 'rift_pick', hero: 'longbow' }); // re-pick to something else: also legal
    expect(io.last('p1', 'rift_lobby').picks['p2']).toBe('longbow');

    // picks outside the lobby are still ignored in silence
    pressStartAndLock(room, 'p1');
    room.handleMessage('p1', { t: 'rift_pick', hero: 'hex' });
    pump(room, 1);
    const snap = latestSnap(io, 'p1');
    expect(snap.you?.hero).toBe('bullwark'); // unchanged
  });

  it('rift_pick ignores invalid input in silence and never throws: unknown hero id, out-of-phase', () => {
    const { room, io } = boot([['p1', 'Ada']]);

    const before = io.all('p1').length;
    expect(() => room.handleMessage('p1', { t: 'rift_pick', hero: 'not-a-real-hero' })).not.toThrow();
    // parseRiftC2S rejects the unknown hero id before it ever reaches the
    // room: no lobby resend, no pick event, no error frame.
    expect(io.all('p1').length).toBe(before);
    expect(io.last('p1', 'rift_lobby').picks['p1']).toBeNull();

    pressStartAndLock(room, 'p1'); // phase is now 'live'
    const liveBefore = io.all('p1').length;
    expect(() => room.handleMessage('p1', { t: 'rift_pick', hero: 'hex' })).not.toThrow();
    expect(io.all('p1').length).toBe(liveBefore); // dropped: rift_pick is lobby-only
    pump(room, 1);
    expect(latestSnap(io, 'p1').you?.hero).not.toBe('hex'); // never applied
  });

  it('supports MORE than 6 humans picking across up to MAX_PLAYERS seats, duplicates included', () => {
    const heroes = HERO_LIST.map((h) => h.id);
    expect(heroes).toHaveLength(6); // RIFT: exactly 6 heroes

    const n = 9; // > 6 humans, well under MAX_PLAYERS (16)
    const players: Array<readonly [PlayerId, string]> = [];
    for (let i = 0; i < n; i++) players.push([`h${i}`, `Human ${i}`]);
    const { room, io } = boot(players);
    expect(io.roster('h0')).toHaveLength(n);
    expect(n).toBeLessThanOrEqual(MAX_PLAYERS);

    for (let i = 0; i < n; i++) {
      const hero = heroes[i % heroes.length];
      if (hero === undefined) throw new Error('unreachable: heroes is non-empty');
      room.handleMessage(`h${i}`, { t: 'rift_pick', hero });
    }

    const lobby = io.last('h0', 'rift_lobby');
    for (let i = 0; i < n; i++) {
      const hero = heroes[i % heroes.length];
      expect(lobby.picks[`h${i}`]).toBe(hero);
    }
    // h0 and h6 both landed on heroes[0]: a real duplicate, both accepted
    expect(lobby.picks['h0']).not.toBeNull();
    expect(lobby.picks['h0']).toBe(lobby.picks['h6']);

    // every pick — including the duplicate — was individually broadcast
    for (let i = 0; i < n; i++) {
      const hero = heroes[i % heroes.length];
      expect(io.events('h0', 'rift_pick').some((e) => e.id === `h${i}` && e.hero === hero)).toBe(true);
    }
  });

  it("info().players reports connected humans, NOT seat count, once bots fill a room (D1)", () => {
    const { room, io } = boot([['p1', 'Ada']]);
    pressStartAndLock(room, 'p1'); // 2v2: 1 human seat + 3 bot seats

    const roster = io.roster('p1');
    expect(roster).toHaveLength(4); // seats.length === 4
    expect(roster.filter((r) => r.bot)).toHaveLength(3);
    expect(roster.filter((r) => r.bot).every((r) => !r.connected)).toBe(true); // bot seats: connected: false

    expect(room.playerCount()).toBe(1); // exactly the connected humans
    expect(room.info().players).toBe(room.playerCount());
    expect(room.info().players).toBe(1);
    expect(room.info().players).not.toBe(roster.length); // must NOT equal seats.length (4)
  });

  it('ghost seats from non-permanent lobby leaves never inflate the room_full guard (D2)', () => {
    const initial: Array<readonly [PlayerId, string]> = [];
    for (let i = 0; i < MAX_PLAYERS; i++) initial.push([`g${i}`, `Ghost ${i}`]);
    const { room, io } = boot(initial);
    expect(io.roster('g0')).toHaveLength(MAX_PLAYERS); // seats.length === MAX_PLAYERS

    // every seat but g0 does a NON-permanent leave: lobby ghost seats are
    // kept (for reconnect), so seats.length stays at MAX_PLAYERS while
    // connected humans drops to 1.
    for (let i = 1; i < MAX_PLAYERS; i++) room.removePlayer(`g${i}`);
    expect(room.playerCount()).toBe(1); // only g0 remains connected
    const rosterAfterLeaves = io.roster('g0');
    expect(rosterAfterLeaves).toHaveLength(MAX_PLAYERS); // ghost seats retained, not evicted
    expect(rosterAfterLeaves.filter((r) => r.connected)).toHaveLength(1);

    // a genuinely new joiner must be SEATED, not bounced with room_full:
    // seats.length (MAX_PLAYERS) is at the old wrong threshold, but
    // connectedHumans (1) is nowhere near it.
    room.addPlayer('newcomer', 'Newbie');
    expect(io.all('newcomer').some((m) => m.t === 'error')).toBe(false);
    expect(io.has('newcomer', 'rift_hello')).toBe(true);

    const seat = io.roster('g0').find((r) => r.id === 'newcomer');
    expect(seat).toBeDefined();
    expect(seat?.bot).toBe(false);
    expect(seat?.connected).toBe(true);
    expect(room.playerCount()).toBe(2); // g0 + newcomer
  });
});

// ---- lock + begin --------------------------------------------------------------------

describe('lock', () => {
  it('1 human locks 2v2 with 3 bots; rift_begin carries lanes/teamSize/laneAssignment', () => {
    const { room, io } = boot([['p1', 'Ada']]);
    pressStartAndLock(room, 'p1');

    expect(room.info().phase).toBe('live');
    expect(room.info().label).toBe('2v2');
    // D1: connected humans (1), NOT seats.length (4 = 1 human + 3 bots) —
    // a bot-filled room must never advertise itself as full.
    expect(room.info().players).toBe(1);

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

// ---- sig-based rebind (CONTRACT §2.3: durable browser-signature fallback) ------------------
//
// `resume` (the previous session's playerId) is exact but ephemeral — it only
// matches while the ghost still holds precisely that id. `sig` is the durable
// per-browser fingerprint @platform/shared mints once and a client presents on
// every join; it survives a purge/rotation/reconnect that would break the
// resume chain. addPlayer's lookup tries resume FIRST (proven above, unchanged)
// and falls back to sig ONLY when resume is absent or misses — never the other
// way — and never against a seat an explicit leave already made a PERMANENT bot.

describe('sig-based rebind', () => {
  it('drop mid-match then rejoin by sig alone (no resume, new playerId): same seat/hero/entity, level/gold/KDA intact, brain released', () => {
    const SIG_P1 = 'sig-p1-durable-fingerprint-aaaa';
    const { room, io } = boot([
      ['p2', 'Bob'],
      ['p3', 'Cid'],
    ]);
    room.addPlayer('p1', 'Ada', undefined, SIG_P1); // presents its sig on the very first join
    pressStartAndLock(room, 'p1');
    pump(room, 2);

    // join order (p2, p3, p1) puts p1 on team0 with p2 (ties -> team0); p1's
    // own snapshot always shows itself regardless of fog, so read entId/level
    // from p1's OWN view — never an enemy's (p3 is the enemy here).
    const teamBefore = io.roster('p3').find((r) => r.id === 'p1')?.team;
    const snap0 = latestSnap(io, 'p1');
    const entId = heroEntByPid(snap0, 'p1').id;

    room.removePlayer('p1'); // socket drop: permanent=false -> ghost, fresh bot brain takes over
    expect(io.roster('p3').find((r) => r.id === 'p1')?.connected).toBe(false);
    expect(internals(room).seats.find((s) => s.pid === 'p1')?.brain).not.toBeNull();

    // let the bot brain play long enough for passive gold (PASSIVE_GOLD_PER_S)
    // to clear STARTING_GOLD by a wide margin — the "intact, not reset" proof.
    pump(room, 200);
    // board (the TAB scoreboard) is one shared row set sent identically to
    // everyone — unlike `.ents`, it is never fog-filtered, so any id works.
    const boardBefore = latestSnap(io, 'p3').board.find((b) => b.id === 'p1');
    if (boardBefore === undefined) throw new Error('p1 missing from board');
    const levelBefore = heroEntByPid(latestSnap(io, 'p2'), 'p1').lvl; // p2 is p1's teammate: allies are always visible

    // rejoin: a BRAND NEW playerId, NO resume — sig alone must find the ghost.
    room.addPlayer('p1-new-session', 'Ada2', undefined, SIG_P1);
    expect(io.last('p1-new-session', 'rift_hello').team).toBe(teamBefore);
    pump(room, 1);

    const snap1 = latestSnap(io, 'p1-new-session');
    const rebound = heroEntByPid(snap1, 'p1-new-session');
    expect(rebound.id).toBe(entId); // SAME hero ent, not a fresh spawn
    expect(rebound.lvl).toBe(levelBefore);
    const boardAfter = snap1.board.find((b) => b.id === 'p1-new-session');
    expect(boardAfter?.kills).toBe(boardBefore.kills);
    expect(boardAfter?.deaths).toBe(boardBefore.deaths);
    expect(boardAfter?.assists).toBe(boardBefore.assists);
    expect(boardAfter?.bot).toBe(false);
    expect(boardAfter?.connected).toBe(true);
    expect(snap1.you?.gold).not.toBe(STARTING_GOLD); // the ghost's accumulated purse, not a fresh stake
    // the bot brain that drove the ghost must be released back to the human
    expect(internals(room).seats.find((s) => s.pid === 'p1-new-session')?.brain).toBeNull();
  });

  it('resume and sig both present for the same ghost: one rebind, one seat, no duplicate', () => {
    const SIG_P1 = 'sig-p1-both-present-bbbbbbbbbb';
    const { room, io } = boot([
      ['p2', 'Bob'],
      ['p3', 'Cid'],
    ]);
    room.addPlayer('p1', 'Ada', undefined, SIG_P1);
    pressStartAndLock(room, 'p1');
    pump(room, 2);
    const seatCountBefore = internals(room).seats.length;

    room.removePlayer('p1');
    // BOTH tokens point at the same ghost — resume must win, and win exactly once.
    room.addPlayer('p1-rejoin', 'Ada2', 'p1', SIG_P1);

    expect(internals(room).seats.length).toBe(seatCountBefore); // no seat created
    const roster = io.roster('p3');
    expect(roster.filter((r) => r.id === 'p1-rejoin').length).toBe(1);
    expect(roster.some((r) => r.id === 'p1')).toBe(false); // old pid mutated away, not duplicated
    expect(internals(room).seats.find((s) => s.pid === 'p1-rejoin')?.brain).toBeNull();
  });

  it('wrong resume + wrong sig: never a silent rebind onto someone else\'s hero', () => {
    const { room, io } = boot([
      ['p1', 'Ada'],
      ['p2', 'Bob'],
    ]);
    pressStartAndLock(room, 'p1');
    pump(room, 2);
    // p1 and p2 land on OPPOSITE teams (ties -> team0, then team1) — an enemy
    // snapshot fog-filters p1's ent, so read it from p1's OWN view instead.
    const p1EntId = heroEntByPid(latestSnap(io, 'p1'), 'p1').id;

    room.removePlayer('p1'); // socket drop -> ghost (bot-driven, but seat.bot stays false)
    pump(room, 1);

    // neither token matches any seat's resume pid or stored sig.
    room.addPlayer('p9', 'Eve', 'bogus-resume-id', 'bogus-sig-that-matches-nothing-zzzz');

    const roster = io.roster('p2');
    const p1Seat = roster.find((r) => r.id === 'p1');
    expect(p1Seat?.connected).toBe(false); // p1's ghost untouched
    expect(p1Seat?.bot).toBe(false); // still just ghosted, not converted

    const p9Seat = roster.find((r) => r.id === 'p9');
    expect(p9Seat).toBeDefined();
    expect(p9Seat?.connected).toBe(true);

    pump(room, 1);
    const p9Ent = heroEntByPid(latestSnap(io, 'p9'), 'p9');
    expect(p9Ent.id).not.toBe(p1EntId); // NEVER p1's hero: a fresh/displaced seat, not a rebind
  });

  it('a seat turned permanent-bot by an explicit leave is NOT reclaimed by its old sig', () => {
    const SIG_P1 = 'sig-p1-permanent-leave-ccccccc';
    // p0 joins first (no sig) so its seat sits ahead of p1's in join order —
    // the decisive check below only works if SOME bot seat precedes p1's.
    const { room, io } = boot([
      ['p0', 'Zed'],
      ['p2', 'Cid'],
    ]);
    room.addPlayer('p1', 'Ada', undefined, SIG_P1);
    pressStartAndLock(room, 'p0');
    pump(room, 2);

    // p2 is the enemy of both p0 and p1 (join order puts p0+p1 on team0,
    // ties -> team0) — an enemy view fog-filters them, so read each hero's
    // ent id from its own owner's snapshot, which is always self-visible.
    const p0EntId = heroEntByPid(latestSnap(io, 'p0'), 'p0').id;
    const p1EntId = heroEntByPid(latestSnap(io, 'p1'), 'p1').id;

    // BOTH leave on purpose — p0 first, so p0's converted seat is the earliest
    // bot-flagged seat in join order once p1 also converts.
    room.removePlayer('p0', true);
    room.removePlayer('p1', true);
    pump(room, 1);
    expect(io.roster('p2').find((r) => r.id === 'p1')?.bot).toBe(true);

    // A joiner presenting p1's OLD sig, no resume: sig lookup excludes
    // bot:true seats, so it must NOT land on p1's seat/hero. Ordinary late-join
    // displacement still applies (existing rules) and picks the earliest
    // displaceable bot seat instead — p0's.
    room.addPlayer('p-late', 'Newcomer', undefined, SIG_P1);
    pump(room, 1);

    const roster = io.roster('p2');
    expect(roster.find((r) => r.id === 'p1')?.bot).toBe(true); // p1's seat: still untouched
    expect(roster.find((r) => r.id === 'p1')?.connected).toBe(false);

    const lateEnt = heroEntByPid(latestSnap(io, 'p-late'), 'p-late');
    expect(lateEnt.id).not.toBe(p1EntId); // never p1's hero
    expect(lateEnt.id).toBe(p0EntId); // the earliest displaceable bot seat instead
  });

  it('no outgoing message anywhere contains a sig field', () => {
    const SIG_A = 'sig-no-leak-check-dddddddddddd';
    const { room, io } = boot([
      ['p2', 'Bob'],
      ['p3', 'Cid'],
    ]);
    room.addPlayer('p1', 'Ada', undefined, SIG_A);
    pressStartAndLock(room, 'p1');
    pump(room, 2);
    room.removePlayer('p1');
    room.addPlayer('p1-again', 'Ada2', undefined, SIG_A); // sig-based rebind path
    pump(room, 1);

    // Match the wire KEY, not the bare substring — "laneAssignment" contains
    // "sig" as a substring and would otherwise false-positive this check.
    for (const id of ['p1', 'p1-again', 'p2', 'p3'] as const) {
      for (const msg of io.all(id)) {
        expect(JSON.stringify(msg)).not.toMatch(/"sig"\s*:/);
      }
    }
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

// ---- the day/night cycle on the wire ------------------------------------------------------

describe('rift_snap.dayPhase (AMENDMENT_1 §B.1)', () => {
  it('is on EVERY snapshot, equals the hoisted shared dayPhase(matchTick), and advances in play', () => {
    const { room, io } = boot([
      ['p1', 'Ada'],
      ['p2', 'Bob'],
    ]);
    pressStartAndLock(room, 'p1');

    const seen: number[] = [];
    for (let i = 0; i < 40; i++) {
      room.tickOnce();
      const s = latestSnap(io, 'p1');
      // The ONE definition, not a second derivation. Bit-identical, because a
      // sawtooth `(t / TICK_RATE / DAY_PERIOD_S) % 1` agrees with the frozen
      // triangle only at t === 0 and is exactly half of it everywhere in the
      // first half-cycle — that divergence is what §B.1 hoisted this to stop.
      expect(s.dayPhase).toBe(dayPhase(s.matchTick));
      expect(s.dayPhase).toBeGreaterThanOrEqual(0);
      expect(s.dayPhase).toBeLessThanOrEqual(1);
      seen.push(s.dayPhase);
    }
    // Derived from the CONSTANTS rather than from the function, so this still
    // fails if room.ts and config.ts agree on the wrong shape: a triangle
    // reaches 1 at half a cycle, so the first half ramps at 1/(cycle/2).
    const half = (DAY_PERIOD_S * TICK_RATE) / 2;
    expect(seen[seen.length - 1]).toBeCloseTo(40 / half, 12);
    expect(seen[0]).toBeCloseTo(1 / half, 12);
    // it MOVES — the field being absent read as a permanently frozen noon
    expect(seen[seen.length - 1]).toBeGreaterThan(seen[0] ?? 0);
    // both teams get the same phase on the same tick
    expect(latestSnap(io, 'p2').dayPhase).toBe(latestSnap(io, 'p1').dayPhase);
  });

  it('is a pure function of matchTick: the wall clock cannot move it', () => {
    const a = boot([
      ['p1', 'Ada'],
      ['p2', 'Bob'],
    ]);
    pressStartAndLock(a.room, 'p1');
    const seqA: number[] = [];
    for (let i = 0; i < 30; i++) {
      a.room.tickOnce();
      seqA.push(latestSnap(a.io, 'p1').dayPhase);
    }
    const timeA = latestSnap(a.io, 'p1').serverTime;
    a.room.stop(); // its tick interval must not steal room B's countdown timer

    // A fresh, identical room half a day later on the wall clock.
    vi.setSystemTime(new Date(Date.now() + 12 * 60 * 60 * 1000));
    const b = boot([
      ['p1', 'Ada'],
      ['p2', 'Bob'],
    ]);
    pressStartAndLock(b.room, 'p1');
    const seqB: number[] = [];
    for (let i = 0; i < 30; i++) {
      b.room.tickOnce();
      seqB.push(latestSnap(b.io, 'p1').dayPhase);
    }
    expect(seqB).toEqual(seqA);
    // ...and the clock really did jump, so the equality above means something
    expect(latestSnap(b.io, 'p1').serverTime).toBeGreaterThan(timeA + 11 * 60 * 60 * 1000);
  });

  it('stays inside [0,1] and climbs monotonically across a long pump', { timeout: 30_000 }, () => {
    const { room, io } = boot([['p1', 'Ada']], { clone: false });
    pressStartAndLock(room, 'p1');
    let prev = -1;
    for (let i = 0; i < 900; i++) {
      room.tickOnce();
      const s = latestSnap(io, 'p1');
      expect(s.dayPhase).toBeGreaterThanOrEqual(0);
      expect(s.dayPhase).toBeLessThanOrEqual(1);
      expect(s.dayPhase).toBeGreaterThan(prev); // 900 ticks is deep inside the first ramp
      prev = s.dayPhase;
    }
    expect(prev).toBeCloseTo(900 / ((DAY_PERIOD_S * TICK_RATE) / 2), 12);
  });
});

// ---- neutral jungle camps on the wire ------------------------------------------------------

describe('neutral camps on the wire (TERRAIN_CONTRACT §5)', () => {
  it('withholds a camp sitting in unexplored jungle from BOTH teams', () => {
    const { room, io } = boot([
      ['p1', 'Ada'],
      ['p2', 'Bob'],
    ]);
    pressStartAndLock(room, 'p1');
    pump(room, 5);

    // the jungle is populated — the absence below is fog, not an empty map
    const w = worldOf(room);
    expect(w.camps.length).toBeGreaterThan(0);
    expect(w.camps.every((c) => c.aliveCount > 0)).toBe(true);
    expect([...w.mobiles()].some((e) => isCampKind(e.kind))).toBe(true);

    // ...and neither fountain can see any of it
    expect(campEnts(latestSnap(io, 'p1'))).toHaveLength(0);
    expect(campEnts(latestSnap(io, 'p2'))).toHaveLength(0);
  });

  it('sends a camp once a hero walks it into vision, with team === NEUTRAL_TEAM', { timeout: 60_000 }, () => {
    const { room, io } = boot([
      ['p1', 'Ada'],
      ['p2', 'Bob'],
    ]);
    pressStartAndLock(room, 'p1');
    pump(room, 2);

    // camp 0 on the 1-lane map sits in team 0's half, ~50 m out from the base
    const camp = buildMap(1).terrain.camps[0];
    expect(camp).toBeDefined();
    let seen: EntSnap[] = [];
    for (let round = 0; round < 60 && seen.length === 0; round++) {
      room.handleMessage('p1', { t: 'rift_order', kind: 'move', x: camp?.x ?? 0, z: camp?.z ?? 0 });
      pump(room, 20);
      seen = campEnts(latestSnap(io, 'p1'));
    }
    expect(seen.length).toBeGreaterThan(0);
    for (const e of seen) {
      expect(e.team).toBe(NEUTRAL_TEAM);
      expect(isCampKind(e.k)).toBe(true);
      expect(e.maxHp).toBeGreaterThan(0);
      expect(e.hp).toBeGreaterThan(0);
      // a camp is never a laner and never anyone's minion on the wire
      expect(e.pid).toBeUndefined();
      expect(e.hero).toBeUndefined();
    }
    // the same fog rule applies per team: p2, still at its own fountain across
    // the map, is told nothing about a camp team 0 is standing in
    expect(campEnts(latestSnap(io, 'p2'))).toHaveLength(0);
  });
});

// ---- miss events ---------------------------------------------------------------------------

describe('rift_miss (AMENDMENT_1 §B.2)', () => {
  it('goes to the teams that see the ATTACKER, and never to the target-only team', () => {
    const { room, io } = boot([
      ['p1', 'Ada'],
      ['p2', 'Bob'],
    ]);
    pressStartAndLock(room, 'p1');
    pump(room, 3);

    // The two fountains are ~105 m apart, so each team's vision set holds its
    // own hero and not the enemy's — the exact split that tells filtering on
    // `attacker` apart from filtering on `target`.
    const h1 = heroEntByPid(latestSnap(io, 'p1'), 'p1').id;
    const h2 = heroEntByPid(latestSnap(io, 'p2'), 'p2').id;
    expect(latestSnap(io, 'p1').ents.some((e) => e.id === h2)).toBe(false);

    worldOf(room).pushEvent({ k: 'miss', attacker: h1, target: h2 });
    room.tickOnce();
    expect(io.events('p1', 'rift_miss')).toEqual([{ t: 'rift_miss', attacker: h1, target: h2 }]);
    expect(io.events('p2', 'rift_miss')).toHaveLength(0);

    // mirrored: the same pair with the roles swapped reaches p2 and only p2
    worldOf(room).pushEvent({ k: 'miss', attacker: h2, target: h1 });
    room.tickOnce();
    expect(io.events('p2', 'rift_miss')).toEqual([{ t: 'rift_miss', attacker: h2, target: h1 }]);
    expect(io.events('p1', 'rift_miss')).toHaveLength(1); // unchanged
  });

  it('carries ENTITY ids straight through — never a player id, never a remap', () => {
    const { room, io } = boot([
      ['p1', 'Ada'],
      ['p2', 'Bob'],
    ]);
    pressStartAndLock(room, 'p1');
    pump(room, 3);

    const snap = latestSnap(io, 'p1');
    const h1 = heroEntByPid(snap, 'p1').id;
    const ally = snap.ents.find((e) => e.k === 'hero' && e.team === 0 && e.pid !== 'p1');
    expect(ally).toBeDefined();
    worldOf(room).pushEvent({ k: 'miss', attacker: h1, target: ally?.id ?? 0 });
    room.tickOnce();

    const ev = io.events('p1', 'rift_miss')[0];
    expect(ev?.attacker).toBe(h1);
    expect(ev?.target).toBe(ally?.id);
    expect(typeof ev?.attacker).toBe('number');
    expect(typeof ev?.target).toBe('number');
  });
});

// ---- neutral deaths ------------------------------------------------------------------------

describe('a neutral death is not a kill', () => {
  it('wiping a camp emits no rift_kill and leaves the scoreboard untouched', () => {
    const { room, io } = boot([
      ['p1', 'Ada'],
      ['p2', 'Bob'],
    ]);
    pressStartAndLock(room, 'p1');
    pump(room, 5);
    expect(io.events('p1', 'rift_kill')).toHaveLength(0);
    const boardBefore = latestSnap(io, 'p1').board.map((r) => `${r.id}/${r.team}/${r.kills}`);

    const wiped = wipeCamp(room, 0);
    expect(wiped).toBeGreaterThan(0);
    pump(room, 3); // reap + the ticks after it

    expect(worldOf(room).camps[0]?.aliveCount).toBe(0);
    expect(io.events('p1', 'rift_kill')).toHaveLength(0);
    expect(io.events('p2', 'rift_kill')).toHaveLength(0);

    // the board still holds exactly the seats, all on player teams
    const board = latestSnap(io, 'p1').board;
    expect(board).toHaveLength(internals(room).seats.length);
    expect(board.map((r) => `${r.id}/${r.team}/${r.kills}`)).toEqual(boardBefore);
    for (const row of board) {
      expect(row.team === 0 || row.team === 1).toBe(true);
      expect(internals(room).seats.some((s) => s.pid === row.id)).toBe(true);
    }
  });

  it('drops a kill event whose victim holds no seat, and only that one', () => {
    const { room, io } = boot([
      ['p1', 'Ada'],
      ['p2', 'Bob'],
    ]);
    pressStartAndLock(room, 'p1');
    pump(room, 3);

    // '' is what combat.ts emits for a victim with a null pid; a camp creep
    // never had a pid to begin with. Neither resolves against the snapshot
    // board, so neither is renderable as a kill feed row.
    worldOf(room).pushEvent({ k: 'kill', killerPid: null, victimPid: '', gold: 0, firstBlood: false });
    worldOf(room).pushEvent({ k: 'kill', killerPid: 'p1', victimPid: 'camp-1004', gold: 42, firstBlood: false });
    room.tickOnce();
    expect(io.events('p1', 'rift_kill')).toHaveLength(0);
    expect(io.events('p2', 'rift_kill')).toHaveLength(0);

    // control: a real seated victim still goes out, unchanged, to everyone
    worldOf(room).pushEvent({ k: 'kill', killerPid: 'p1', victimPid: 'p2', gold: 300, firstBlood: true });
    room.tickOnce();
    expect(io.events('p1', 'rift_kill')).toEqual([
      { t: 'rift_kill', killer: 'p1', victim: 'p2', gold: 300, firstBlood: true },
    ]);
    expect(io.events('p2', 'rift_kill')).toHaveLength(1);
  });
});

// ---- bot camp percepts ---------------------------------------------------------------------

describe('bot camp percepts (TERRAIN_CONTRACT §5)', () => {
  it('feeds one CampPercept per World.camps entry, index === id, matching the map', () => {
    const { room } = boot([['p1', 'Ada']]);
    pressStartAndLock(room, 'p1');
    const seen = recordBotPercepts(room);
    // 3 ticks, not 1: the refresh runs at the TOP of tickOnce and stepCamps
    // spawns the first generation inside advance(), so tick 1 legitimately
    // reports every camp down. Tick 2 onward is the steady state.
    pump(room, 3);

    const defs = buildMap(1).terrain.camps;
    const shot = seen[seen.length - 1];
    expect(defs.length).toBeGreaterThan(0);
    expect(shot?.entries).toHaveLength(defs.length);
    defs.forEach((def, i) => {
      const p = shot?.entries[i];
      expect(p?.id).toBe(i); // index === id, so a bot can hand the id back
      expect(p?.tier).toBe(def.tier);
      expect(p?.x).toBe(def.x);
      expect(p?.z).toBe(def.z);
      expect(shot?.up[i]).toBe(true);
    });
    // the percept is the room's table, not a copy the bot could be handed
    expect(shot?.percept.camps).toBe(shot?.campsArray);
  });

  it('refreshes `up` IN PLACE — one array and one object per camp for the match', () => {
    const { room } = boot([['p1', 'Ada']]);
    pressStartAndLock(room, 'p1');
    const seen = recordBotPercepts(room);
    room.tickOnce();
    room.tickOnce();
    room.tickOnce();

    // Identity of the ARRAY and of every ELEMENT, compared against references
    // captured on the earlier tick — 16 bots at 20 Hz must allocate nothing.
    expect(seen).toHaveLength(3);
    const first = seen[0];
    const steady = seen[2];
    expect(steady?.campsArray).toBe(first?.campsArray);
    // reference equality per element, NOT toEqual — a rebuilt table holding
    // fresh objects with identical field values is deep-equal and is exactly
    // the allocation this rule forbids
    expect(steady?.entries.map((e, i) => e === first?.entries[i])).toEqual(
      first?.entries.map(() => true),
    );
    expect(steady?.up.every((u) => u)).toBe(true);

    wipeCamp(room, 0);
    room.tickOnce(); // advance() reaps the members
    room.tickOnce(); // the refresh at the top of THIS tick reads aliveCount 0
    const after = seen[seen.length - 1];

    expect(worldOf(room).camps[0]?.aliveCount).toBe(0);
    expect(after?.up[0]).toBe(false);
    expect(after?.up.slice(1).every((u) => u)).toBe(true);
    // still the very same table and the very same objects: `up` was rewritten
    // on the object the bot already held, not swapped for a fresh one
    expect(after?.campsArray).toBe(first?.campsArray);
    expect(after?.entries[0]).toBe(first?.entries[0]);
    expect(first?.entries[0]?.up).toBe(false);
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
    // D1: info().players tracks connectedHumans()/playerCount(), so it
    // drops to 0 with the seat bot-converted — NOT seats.length (4).
    expect(room.info().players).toBe(0);
    expect(tickBefore).toBe(3);
  });
});

// ---- inventory economy: rift_sell / rift_drop, and tier-3 ultimates ------------------------
//
// Gates the two PRIVATE handlers `handleSell`/`handleDrop` (only reachable via
// room.handleMessage) against the frozen behavioural spec: sell is the shop
// run backwards (fountain-gated, refunds sellValue = 0.6 * TOTAL cost), drop
// is the escape hatch for a full inventory away from the fountain (no gate,
// no refund, no world pickup entity). Assertions read the LIVE World Ent
// (worldOf(room).get(id)) rather than a snapshot: sell/drop mutate `gold` and
// `items`/`itemCharges`/`itemCdUntilTick` synchronously inside handleMessage,
// with no pump required — only the derived stats (maxHp, etc.) wait for the
// next tick's stepUpkeep(), per the frozen contract.

/** Boot a 1-human 2v2 room and lock it; heroes spawn at their own fountain,
 *  so the hero is already "at the shop" once live. */
function bootLive(): Harness {
  const { room, io } = boot([['p1', 'Ada']]);
  pressStartAndLock(room, 'p1');
  pump(room, 2);
  return { room, io };
}

/** The live (mutable) Ent behind p1's hero — NOT the frozen EntSnap. */
function p1Ent(room: RiftRoom, io: FakeIO): Ent {
  const id = heroEntByPid(latestSnap(io, 'p1'), 'p1').id;
  const ent = worldOf(room).get(id);
  if (ent === undefined) throw new Error('p1 hero ent missing from the live world');
  return ent;
}

function occupiedSlots(ent: Ent): number {
  return ent.items.filter((it) => it !== null && it !== undefined).length;
}

describe('economy: rift_sell', () => {
  it('sells an occupied slot at the fountain: gold rises by exactly sellValue(id), slot clears', () => {
    const { room, io } = bootLive();
    const ent = p1Ent(room, io);
    ent.gold = 5000;
    room.handleMessage('p1', { t: 'rift_buy', item: 'plategirdle' });
    const slot = ent.items.findIndex((it) => it === 'plategirdle');
    expect(slot, 'setup: plategirdle must have been bought into a slot').toBeGreaterThanOrEqual(0);
    const goldBeforeSell = ent.gold;

    room.handleMessage('p1', { t: 'rift_sell', slot });

    expect(ent.gold, 'sell must credit exactly sellValue(id)').toBe(goldBeforeSell + sellValue('plategirdle'));
    expect(ent.items[slot], 'sold slot must clear to null').toBeNull();
  });

  it('refunds from the item TOTAL cost, not the recipe step: bladestone+fang sells for 420, not 180', () => {
    // fang's recipe STEP (ITEMS.fang.cost) is 300, but its TOTAL cost
    // (component bladestone 400 + step 300) is 700. sellValue must read
    // floor(700 * 0.6) = 420 — never floor(300 * 0.6) = 180, which is what a
    // handler that accidentally refunded off the top-level `cost` field
    // (the buy-time price) instead of itemTotalCost would produce.
    const { room, io } = bootLive();
    const ent = p1Ent(room, io);
    ent.gold = 5000;
    room.handleMessage('p1', { t: 'rift_buy', item: 'bladestone' });
    room.handleMessage('p1', { t: 'rift_buy', item: 'fang' }); // combines the bladestone -> fang
    const slot = ent.items.findIndex((it) => it === 'fang');
    expect(slot, 'setup: fang must have combined into a slot').toBeGreaterThanOrEqual(0);
    const goldBeforeSell = ent.gold;

    room.handleMessage('p1', { t: 'rift_sell', slot });

    expect(sellValue('fang'), 'pin: the literal this test protects against silent re-pricing').toBe(420);
    expect(ent.gold, 'fang refund must be 420 (0.6 * 700 total), never 180 (0.6 * 300 step)').toBe(
      goldBeforeSell + 420,
    );
  });

  it('no-ops away from the fountain: gold unchanged, item still held', () => {
    const { room, io } = bootLive();
    const ent = p1Ent(room, io);
    ent.gold = 5000;
    room.handleMessage('p1', { t: 'rift_buy', item: 'bladestone' });
    const slot = ent.items.findIndex((it) => it === 'bladestone');
    expect(slot, 'setup: bladestone must have been bought into a slot').toBeGreaterThanOrEqual(0);
    ent.x += 60; // clearly outside FOUNTAIN_RADIUS (6m)
    ent.z += 60;
    const goldBefore = ent.gold;

    room.handleMessage('p1', { t: 'rift_sell', slot });

    expect(ent.gold, 'sell away from the fountain must not grant gold').toBe(goldBefore);
    expect(ent.items[slot], 'sell away from the fountain must not clear the slot').toBe('bladestone');
  });

  it('no-ops while dead', () => {
    const { room, io } = bootLive();
    const ent = p1Ent(room, io);
    ent.gold = 5000;
    room.handleMessage('p1', { t: 'rift_buy', item: 'bladestone' });
    const slot = ent.items.findIndex((it) => it === 'bladestone');
    expect(slot, 'setup: bladestone must have been bought into a slot').toBeGreaterThanOrEqual(0);
    ent.alive = false;
    const goldBefore = ent.gold;

    room.handleMessage('p1', { t: 'rift_sell', slot });

    expect(ent.gold, 'sell while dead must not grant gold').toBe(goldBefore);
    expect(ent.items[slot], 'sell while dead must not clear the slot').toBe('bladestone');
  });

  it('selling an empty slot grants no gold and changes nothing', () => {
    const { room, io } = bootLive();
    const ent = p1Ent(room, io);
    ent.gold = 1234;
    expect(ent.items[0], 'setup: slot 0 must start empty').toBeNull();

    room.handleMessage('p1', { t: 'rift_sell', slot: 0 });

    expect(ent.gold, 'selling an empty slot must not grant gold').toBe(1234);
    expect(ent.items[0], 'selling an empty slot must not change the slot').toBeNull();
  });

  it('malformed/out-of-range slots reach handleMessage without throwing and change nothing', () => {
    const { room, io } = bootLive();
    const ent = p1Ent(room, io);
    ent.gold = 5000;
    room.handleMessage('p1', { t: 'rift_buy', item: 'bladestone' });
    const slot = ent.items.findIndex((it) => it === 'bladestone');
    expect(slot, 'setup: bladestone must have been bought into a slot').toBeGreaterThanOrEqual(0);
    const goldBefore = ent.gold;
    const itemsBefore = [...ent.items];
    const bad: unknown[] = [
      { t: 'rift_sell', slot: INVENTORY_SLOTS }, // one past the last valid index
      { t: 'rift_sell', slot: -1 },
      { t: 'rift_sell', slot: 1.5 },
      { t: 'rift_sell', slot: '0' },
      { t: 'rift_sell' }, // missing slot entirely
    ];

    for (const msg of bad) {
      expect(() => room.handleMessage('p1', msg), `must never throw for ${JSON.stringify(msg)}`).not.toThrow();
    }

    expect(ent.gold, 'malformed rift_sell must never grant gold').toBe(goldBefore);
    expect(ent.items, 'malformed rift_sell must never change inventory').toEqual(itemsBefore);
  });

  it('gate equivalence: sell is legal exactly where buying is legal (proves the two fountain predicates cannot silently drift apart)', () => {
    // room.ts's handleSell reuses `this.atFountain`, documented as agreeing
    // with the sim's own `atOwnFountain` "by construction" (same
    // FOUNTAIN_RADIUS, same ancient anchor) rather than by a shared function
    // call. This test is the OBSERVABLE proof of that claim: buy and sell
    // must succeed/fail together at the same position, on every position.
    const { room, io } = bootLive();
    const ent = p1Ent(room, io);
    ent.gold = 10000;

    // at spawn (the fountain): both a buy and a sell succeed
    room.handleMessage('p1', { t: 'rift_buy', item: 'bladestone' });
    const slot1 = ent.items.findIndex((it) => it === 'bladestone');
    expect(slot1, 'buy at spawn (fountain) must succeed').toBeGreaterThanOrEqual(0);
    const goldAfterBuy = ent.gold;
    room.handleMessage('p1', { t: 'rift_sell', slot: slot1 });
    expect(ent.items[slot1], 'sell at spawn (fountain) must succeed').toBeNull();
    expect(ent.gold, 'sell at spawn (fountain) must credit gold').toBe(goldAfterBuy + sellValue('bladestone'));

    // move clearly outside FOUNTAIN_RADIUS (6m): both now no-op
    room.handleMessage('p1', { t: 'rift_buy', item: 'bladestone' });
    const slot2 = ent.items.findIndex((it) => it === 'bladestone');
    expect(slot2, 'setup: re-buy for the away-from-fountain half').toBeGreaterThanOrEqual(0);
    ent.x += 60;
    ent.z += 60;
    const goldBeforeAway = ent.gold;

    room.handleMessage('p1', { t: 'rift_buy', item: 'wardstone' });
    expect(ent.gold, 'buy away from the fountain must no-op (same gate as sell)').toBe(goldBeforeAway);
    expect(ent.items.some((it) => it === 'wardstone'), 'buy away from the fountain must no-op').toBe(false);

    room.handleMessage('p1', { t: 'rift_sell', slot: slot2 });
    expect(ent.items[slot2], 'sell away from the fountain must no-op — same gate as buy').toBe('bladestone');
    expect(ent.gold, 'sell away from the fountain must not credit gold').toBe(goldBeforeAway);
  });

  it('selling clears charges: buy a wardstone (2 charges), sell it, charges and cooldown both zero', () => {
    const { room, io } = bootLive();
    const ent = p1Ent(room, io);
    ent.gold = 5000;
    room.handleMessage('p1', { t: 'rift_buy', item: 'wardstone' });
    const slot = ent.items.findIndex((it) => it === 'wardstone');
    expect(slot, 'setup: wardstone must have been bought into a slot').toBeGreaterThanOrEqual(0);
    expect(ent.itemCharges[slot], 'setup: a fresh wardstone carries 2 charges').toBe(2);

    room.handleMessage('p1', { t: 'rift_sell', slot });

    expect(ent.itemCharges[slot], 'sell must clear charges to 0').toBe(0);
    expect(ent.itemCdUntilTick[slot], 'sell must clear the cooldown to 0').toBe(0);
  });
});

describe('economy: rift_drop', () => {
  it('works far from the fountain, where sell does not: slot clears, gold exactly unchanged', () => {
    const { room, io } = bootLive();
    const ent = p1Ent(room, io);
    ent.gold = 5000;
    room.handleMessage('p1', { t: 'rift_buy', item: 'bladestone' });
    const slot = ent.items.findIndex((it) => it === 'bladestone');
    expect(slot, 'setup: bladestone must have been bought into a slot').toBeGreaterThanOrEqual(0);
    ent.x += 60; // clearly outside FOUNTAIN_RADIUS (6m) — where sell would no-op
    ent.z += 60;
    const goldBefore = ent.gold;

    room.handleMessage('p1', { t: 'rift_drop', slot });

    expect(ent.items[slot], 'drop must clear the slot even far from the fountain').toBeNull();
    expect(ent.gold, 'drop must grant exactly zero gold — no refund').toBe(goldBefore);
  });

  it('destroys the item — no world pickup entity is created (pins the documented scope boundary)', () => {
    // room.ts's handleDrop comment states spawning a reclaimable pickup
    // entity is a separate, larger feature deliberately out of scope; this
    // pins that a drop never creates any world entity as a side effect.
    const { room, io } = bootLive();
    const ent = p1Ent(room, io);
    ent.gold = 5000;
    room.handleMessage('p1', { t: 'rift_buy', item: 'bladestone' });
    const slot = ent.items.findIndex((it) => it === 'bladestone');
    expect(slot, 'setup: bladestone must have been bought into a slot').toBeGreaterThanOrEqual(0);
    const countBefore = [...worldOf(room).all()].length;

    room.handleMessage('p1', { t: 'rift_drop', slot });

    const countAfter = [...worldOf(room).all()].length;
    expect(countAfter, 'dropping an item must not create any world entity — destroyed, not spawned as a pickup').toBe(
      countBefore,
    );
  });

  it('no-ops while dead, and no-ops on an already-empty slot', () => {
    const { room, io } = bootLive();
    const ent = p1Ent(room, io);
    ent.gold = 5000;
    room.handleMessage('p1', { t: 'rift_buy', item: 'bladestone' });
    const slot = ent.items.findIndex((it) => it === 'bladestone');
    expect(slot, 'setup: bladestone must have been bought into a slot').toBeGreaterThanOrEqual(0);
    ent.alive = false;

    room.handleMessage('p1', { t: 'rift_drop', slot });
    expect(ent.items[slot], 'drop while dead must not clear the slot').toBe('bladestone');

    ent.alive = true;
    const emptySlot = ent.items.findIndex((it) => it === null);
    expect(emptySlot, 'setup: some slot must still be empty').toBeGreaterThanOrEqual(0);

    room.handleMessage('p1', { t: 'rift_drop', slot: emptySlot });
    expect(ent.items[emptySlot], 'dropping an already-empty slot stays null (a no-op, not an error)').toBeNull();
  });
});

describe('economy: stat reconciliation after sell/drop', () => {
  it('recomputes maxHp on the NEXT tick (stepUpkeep), and clamps hp down with it', () => {
    // Stats are not recomputed inside handleSell/handleDrop — SimWorld.advance()
    // runs stepUpkeep() every tick, which recomputes every mobile from its
    // current `items` array and clamps hp/mana down when maxHp/maxMana shrink.
    // Drop shares the exact same "no recompute here" code path (see room.ts's
    // comment on handleDrop), so this single sell-side proof covers both.
    const { room, io } = bootLive();
    const ent = p1Ent(room, io);
    ent.gold = 5000;
    const maxHpBefore = ent.maxHp;

    room.handleMessage('p1', { t: 'rift_buy', item: 'warmail' }); // +250 maxHp
    pump(room, 1);
    const slot = ent.items.findIndex((it) => it === 'warmail');
    expect(slot, 'setup: warmail must have been bought into a slot').toBeGreaterThanOrEqual(0);
    expect(ent.maxHp, "warmail's +250 maxHp must be applied by the next tick").toBe(maxHpBefore + 250);

    ent.hp = ent.maxHp; // full hp while holding warmail
    room.handleMessage('p1', { t: 'rift_sell', slot });
    // NOT recomputed synchronously by the handler itself:
    expect(ent.maxHp, 'maxHp must not change before the next tick pumps stepUpkeep').toBe(maxHpBefore + 250);

    pump(room, 1);
    expect(ent.maxHp, 'maxHp must return to its pre-purchase value after one pumped tick').toBe(maxHpBefore);
    expect(ent.hp, 'hp must be clamped down to the shrunk maxHp, never left above it').toBeLessThanOrEqual(
      ent.maxHp,
    );
  });
});

describe('economy: the full-inventory escape hatch (feature A)', () => {
  it('rift_drop frees a slot so a follow-up buy succeeds where it previously no-oped', () => {
    // Before this feature, a full 6-slot inventory was a terminal state: sell
    // needs the fountain (not always reachable in time) and there was no
    // other way to shed an item, so a bad build was permanent for the match.
    const { room, io } = bootLive();
    const ent = p1Ent(room, io);
    ent.gold = 100_000;
    const fillers: ItemId[] = ['bladestone', 'warmail', 'plategirdle', 'swiftboots', 'manacharm', 'blinkstone'];
    expect(fillers, 'setup: exactly INVENTORY_SLOTS distinct, non-combining base items').toHaveLength(
      INVENTORY_SLOTS,
    );
    for (const item of fillers) room.handleMessage('p1', { t: 'rift_buy', item });
    expect(occupiedSlots(ent), 'setup: inventory must be completely full').toBe(INVENTORY_SLOTS);

    const goldBeforeFailedBuy = ent.gold;
    room.handleMessage('p1', { t: 'rift_buy', item: 'wardstone' });
    expect(ent.gold, 'buy into a full inventory must no-op: no gold spent').toBe(goldBeforeFailedBuy);
    expect(occupiedSlots(ent), 'buy into a full inventory must no-op: slot count unchanged').toBe(INVENTORY_SLOTS);

    room.handleMessage('p1', { t: 'rift_drop', slot: 0 });
    expect(occupiedSlots(ent), 'drop must free exactly one slot').toBe(INVENTORY_SLOTS - 1);

    room.handleMessage('p1', { t: 'rift_buy', item: 'wardstone' });
    expect(
      ent.items.some((it) => it === 'wardstone'),
      'the freed slot must now accept the buy that previously no-oped',
    ).toBe(true);
    expect(occupiedSlots(ent), 'inventory is full again once the buy succeeds').toBe(INVENTORY_SLOTS);
  });
});

describe('tier-3 ultimates (feature B)', () => {
  it('reaperedge: buys through the real door, frees a slot, and charges only the 900 step, not the 2400 total', () => {
    const { room, io } = bootLive();
    const ent = p1Ent(room, io);
    ent.gold = 100_000;
    room.handleMessage('p1', { t: 'rift_buy', item: 'bladestone' });
    room.handleMessage('p1', { t: 'rift_buy', item: 'fang' }); // combines -> fang
    room.handleMessage('p1', { t: 'rift_buy', item: 'bladestone' });
    room.handleMessage('p1', { t: 'rift_buy', item: 'stormbow' }); // combines -> stormbow
    const fangSlot = ent.items.findIndex((it) => it === 'fang');
    const stormbowSlot = ent.items.findIndex((it) => it === 'stormbow');
    expect(fangSlot, 'setup: fang must be held').toBeGreaterThanOrEqual(0);
    expect(stormbowSlot, 'setup: stormbow must be held').toBeGreaterThanOrEqual(0);
    const occupiedBefore = occupiedSlots(ent);
    const goldBefore = ent.gold;

    room.handleMessage('p1', { t: 'rift_buy', item: 'reaperedge' });

    expect(ent.items.some((it) => it === 'fang'), 'the fang component must be consumed').toBe(false);
    expect(ent.items.some((it) => it === 'stormbow'), 'the stormbow component must be consumed').toBe(false);
    const slot = ent.items.findIndex((it) => it === 'reaperedge');
    expect(slot, 'reaperedge must occupy a slot').toBeGreaterThanOrEqual(0);
    expect(slot, 'reaperedge must land in the LOWEST slot its components freed').toBe(
      Math.min(fangSlot, stormbowSlot),
    );
    expect(ent.gold, 'the recipe STEP (900) must be charged, never the 2400 total').toBe(goldBefore - 900);
    expect(occupiedSlots(ent), 'fusing two held components into one ultimate must free exactly one slot').toBe(
      occupiedBefore - 1,
    );
  });

  it('no-ops without both components, even with plenty of gold at the fountain', () => {
    const { room, io } = bootLive();
    const ent = p1Ent(room, io);
    ent.gold = 100_000;
    room.handleMessage('p1', { t: 'rift_buy', item: 'bladestone' });
    room.handleMessage('p1', { t: 'rift_buy', item: 'fang' }); // only fang held, no stormbow
    expect(ent.items.some((it) => it === 'fang'), 'setup: fang held').toBe(true);
    expect(ent.items.some((it) => it === 'stormbow'), 'setup: stormbow NOT held').toBe(false);
    const goldBefore = ent.gold;
    const itemsBefore = [...ent.items];

    room.handleMessage('p1', { t: 'rift_buy', item: 'reaperedge' });

    expect(ent.gold, 'missing the second component must not charge gold').toBe(goldBefore);
    expect(ent.items, 'missing the second component must not change inventory').toEqual(itemsBefore);
  });

  it('no-ops with insufficient gold for the step, even with both components held at the fountain', () => {
    const { room, io } = bootLive();
    const ent = p1Ent(room, io);
    ent.gold = 100_000;
    room.handleMessage('p1', { t: 'rift_buy', item: 'bladestone' });
    room.handleMessage('p1', { t: 'rift_buy', item: 'fang' });
    room.handleMessage('p1', { t: 'rift_buy', item: 'bladestone' });
    room.handleMessage('p1', { t: 'rift_buy', item: 'stormbow' });
    expect(ent.items.some((it) => it === 'fang'), 'setup: fang held').toBe(true);
    expect(ent.items.some((it) => it === 'stormbow'), 'setup: stormbow held').toBe(true);
    ent.gold = ITEMS.reaperedge.cost - 1; // one gold short of the 900 step
    const itemsBefore = [...ent.items];

    room.handleMessage('p1', { t: 'rift_buy', item: 'reaperedge' });

    expect(ent.gold, 'insufficient gold for the step must leave gold untouched (no partial charge)').toBe(
      ITEMS.reaperedge.cost - 1,
    );
    expect(ent.items, 'insufficient gold for the step must leave the components untouched').toEqual(itemsBefore);
  });

  it('sells reaperedge for its full sellValue (1440) and frees the slot', () => {
    const { room, io } = bootLive();
    const ent = p1Ent(room, io);
    ent.gold = 100_000;
    room.handleMessage('p1', { t: 'rift_buy', item: 'bladestone' });
    room.handleMessage('p1', { t: 'rift_buy', item: 'fang' });
    room.handleMessage('p1', { t: 'rift_buy', item: 'bladestone' });
    room.handleMessage('p1', { t: 'rift_buy', item: 'stormbow' });
    room.handleMessage('p1', { t: 'rift_buy', item: 'reaperedge' });
    const slot = ent.items.findIndex((it) => it === 'reaperedge');
    expect(slot, 'setup: reaperedge must have been fused').toBeGreaterThanOrEqual(0);
    expect(sellValue('reaperedge'), 'pin: the literal this test protects against silent re-pricing').toBe(1440);
    const goldBefore = ent.gold;

    room.handleMessage('p1', { t: 'rift_sell', slot });

    expect(ent.gold, 'selling an ultimate must refund its full sellValue (0.6 * 2400 total)').toBe(
      goldBefore + 1440,
    );
    expect(ent.items[slot], 'selling an ultimate must free its slot').toBeNull();
  });

  it('a second, different ultimate (aegiscolossus) end-to-end: buy then sell — not a single lucky path', () => {
    const { room, io } = bootLive();
    const ent = p1Ent(room, io);
    ent.gold = 100_000;
    room.handleMessage('p1', { t: 'rift_buy', item: 'warmail' });
    room.handleMessage('p1', { t: 'rift_buy', item: 'aegisheart' }); // combines -> aegisheart
    room.handleMessage('p1', { t: 'rift_buy', item: 'warmail' });
    room.handleMessage('p1', { t: 'rift_buy', item: 'plategirdle' });
    room.handleMessage('p1', { t: 'rift_buy', item: 'bulwarkplate' }); // combines -> bulwarkplate
    const aegisheartSlot = ent.items.findIndex((it) => it === 'aegisheart');
    const bulwarkplateSlot = ent.items.findIndex((it) => it === 'bulwarkplate');
    expect(aegisheartSlot, 'setup: aegisheart must be held').toBeGreaterThanOrEqual(0);
    expect(bulwarkplateSlot, 'setup: bulwarkplate must be held').toBeGreaterThanOrEqual(0);
    const occupiedBefore = occupiedSlots(ent);
    const goldBefore = ent.gold;

    room.handleMessage('p1', { t: 'rift_buy', item: 'aegiscolossus' });

    expect(ent.items.some((it) => it === 'aegisheart'), 'the aegisheart component must be consumed').toBe(false);
    expect(ent.items.some((it) => it === 'bulwarkplate'), 'the bulwarkplate component must be consumed').toBe(
      false,
    );
    const slot = ent.items.findIndex((it) => it === 'aegiscolossus');
    expect(slot, 'aegiscolossus must land in the LOWEST slot its components freed').toBe(
      Math.min(aegisheartSlot, bulwarkplateSlot),
    );
    expect(ent.gold, 'aegiscolossus must charge only its 900 step, never its 3000 total').toBe(goldBefore - 900);
    expect(occupiedSlots(ent), 'fusing must free exactly one slot').toBe(occupiedBefore - 1);

    expect(sellValue('aegiscolossus'), 'pin: the literal this test protects against silent re-pricing').toBe(1800);
    const goldBeforeSell = ent.gold;
    room.handleMessage('p1', { t: 'rift_sell', slot });
    expect(ent.gold, 'selling aegiscolossus must refund its full sellValue').toBe(goldBeforeSell + 1800);
    expect(ent.items[slot], 'selling aegiscolossus must free the slot').toBeNull();
  });
});
