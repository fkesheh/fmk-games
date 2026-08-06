// ============================================================================
// Lobby matchmaking tests — locks down the one invariant that motivated this
// file's existence, and that had NO test anywhere before it: two sessions
// that both quick_join the same game land in the SAME room. See lobby.ts
// (quickJoin ~:218, findPublicRoom ~:319, joinRoom ~:368) and registry.ts.
//
// Harness notes
// --------------
// - FakeSession stands in for net.ts's `Session` — the only three members
//   Lobby ever touches (id / send / rttMs). `Session` carries private fields
//   (ws, pingSentAt, ...), so TypeScript's structural check rejects a plain
//   object literal for it; the `as unknown as Session` cast below is the
//   accepted escape for that (not `any`, not `!`).
// - Every test below builds the Lobby with the REAL riftModule pulled
//   straight from registry.ts's GAMES — exactly "the rift module" per spec —
//   so they exercise the actual production matchmaking path, not a stand-in.
//   (An earlier draft of this file could not safely drive rift to a live,
//   bot-filled phase because `@rift/server` was resolving through
//   node_modules into an unrelated, far-diverged checkout; that was a
//   workspace symlink issue, now fixed, and every case below runs against
//   this worktree's own code.)
// - RIFT genuinely reports its waiting-for-players phase as the literal
//   string 'lobby', NOT 'warmup'. findPublicRoom (lobby.ts:224) prefers
//   'warmup' first but falls back to any phase at lobby.ts:319/327 — for
//   rift, that fallback is not a rare edge case, it is the ONLY path that
//   ever matches, on every single quick_join. The tests below assert that
//   truth and make the fallback explicit rather than assuming 'warmup'.
// ============================================================================
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GameModule, GameRoomHandle, PlayerId, RoomId, RoomIO, S2C } from '@platform/shared';
import { Lobby } from './lobby.js';
import type { Session } from './net.js';
import { GAMES } from './registry.js';

// ---- fake session -----------------------------------------------------------

class FakeSession {
  readonly id: PlayerId;
  private readonly messages: S2C[] = [];

  constructor(id: PlayerId) {
    this.id = id;
  }

  send(msg: S2C): void {
    this.messages.push(msg);
  }

  rttMs(): number {
    return 0;
  }

  all(): readonly S2C[] {
    return this.messages;
  }

  /** Typed lookup for platform-level (LobbyS2C) tags — 'room_list', 'error',
   *  'welcome', 'pong'. Game-specific wire messages (rift_hello, ...) pass
   *  through as an untyped RawEnvelope and are read with `riftRoomIdSeenBy`
   *  below instead, since the platform itself never parses them. */
  last<T extends S2C['t']>(t: T): Extract<S2C, { t: T }> | undefined {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const m = this.messages[i];
      if (m !== undefined && m.t === t) return m as Extract<S2C, { t: T }>;
    }
    return undefined;
  }
}

/** `Session` has private fields (ws, pingSentAt, ...), so a duck-typed
 *  object needs the `unknown` round-trip to satisfy it structurally. Lobby
 *  only ever calls `.id`, `.send()` and `.rttMs()` on a Session, all of which
 *  FakeSession implements for real. */
function asSession(s: FakeSession): Session {
  return s as unknown as Session;
}

/**
 * rift's own S2C payloads (rift_hello, rift_lobby, ...) pass through the
 * platform untouched as opaque RawEnvelopes (lobby.ts's io bridge: "game S2C
 * envelopes pass through unchanged"). Reading `roomId` off the `rift_hello`
 * a session receives on join is the ONLY way a client (or this test) learns
 * which room it landed in — exactly the black-box, per-session view the
 * "same room id" assertions below need.
 */
function riftRoomIdSeenBy(sess: FakeSession): RoomId {
  const hello = sess.all().find((m) => m.t === 'rift_hello');
  if (hello === undefined) throw new Error('no rift_hello observed for this session');
  const roomId = (hello as unknown as { roomId: unknown }).roomId;
  if (typeof roomId !== 'string') throw new Error('rift_hello carried no string roomId');
  return roomId;
}

const RIFT: GameModule = (() => {
  const mod = GAMES.find((m) => m.id === 'rift');
  if (mod === undefined) throw new Error('registry.ts GAMES has no "rift" module registered');
  return mod;
})();

// ---- quick_join matchmaking (the reported bug: two humans, two rooms) ------

describe('quick_join matchmaking (real riftModule from registry.ts)', () => {
  let tracked: Lobby[] = [];

  afterEach(() => {
    for (const l of tracked) l.close();
    tracked = [];
  });

  it('two quick-joiners for the same game land in the SAME room (core case)', () => {
    const lobby = new Lobby([RIFT]);
    tracked.push(lobby);

    const s1 = new FakeSession('p1');
    const s2 = new FakeSession('p2');
    lobby.handleMessage(asSession(s1), { t: 'quick_join', name: 'Ada', game: 'rift' });
    lobby.handleMessage(asSession(s2), { t: 'quick_join', name: 'Bob', game: 'rift' });

    // room count alone would not prove per-session identity (spec: "assert
    // on the actual room identity, not merely on the room count") — so pin
    // down the room id EACH session itself was told it joined.
    expect(lobby.roomCount()).toBe(1);
    const room1 = riftRoomIdSeenBy(s1);
    const room2 = riftRoomIdSeenBy(s2);
    expect(room1).toBe(room2);

    // and that id is the one and only room the lobby is tracking
    lobby.handleMessage(asSession(s1), { t: 'list_rooms' });
    const list = s1.last('room_list');
    if (list === undefined) throw new Error('expected a room_list reply');
    expect(list.rooms.map((r) => r.id)).toEqual([room1]);
    expect(list.rooms[0]?.players).toBe(2); // both humans counted on that one room
  });

  it('repeats the core case with the first room left fresh in "lobby" phase — NOT the preferred "warmup", so this is the fallback path', () => {
    const lobby = new Lobby([RIFT]);
    tracked.push(lobby);

    const s1 = new FakeSession('p1');
    lobby.handleMessage(asSession(s1), { t: 'quick_join', name: 'Ada', game: 'rift' });

    lobby.handleMessage(asSession(s1), { t: 'list_rooms' });
    const listBefore = s1.last('room_list');
    if (listBefore === undefined) throw new Error('expected a room_list reply');
    // findPublicRoom(gameId, 'warmup') (lobby.ts:224) is the PREFERRED match,
    // but rift's waiting-for-players phase is genuinely the literal string
    // 'lobby' — it never reports 'warmup' at all. So the preferred branch
    // can NEVER match a rift room, and every rift quick_join (this one
    // included) is served entirely by the null-phase fallback at
    // findPublicRoom(gameId, null) (lobby.ts:319/327). That fallback finding
    // this "wrong-phase" room is the actual point of this case.
    expect(listBefore.rooms[0]?.phase).toBe('lobby');

    const s2 = new FakeSession('p2');
    lobby.handleMessage(asSession(s2), { t: 'quick_join', name: 'Bob', game: 'rift' });

    expect(lobby.roomCount()).toBe(1); // the fallback reused the room; no second one opened
    expect(riftRoomIdSeenBy(s1)).toBe(riftRoomIdSeenBy(s2));
  });

  it('repeats the core case with the first room driven to LIVE (locked, bots filled) — still not "warmup"', () => {
    vi.useFakeTimers();
    try {
      const lobby = new Lobby([RIFT]);
      tracked.push(lobby);

      const s1 = new FakeSession('p1');
      lobby.handleMessage(asSession(s1), { t: 'quick_join', name: 'Ada', game: 'rift' });
      lobby.handleMessage(asSession(s1), { t: 'rift_start' }); // room-level pass-through
      vi.advanceTimersToNextTimer(); // fires the LOBBY_COUNTDOWN_MS timeout -> lock()

      lobby.handleMessage(asSession(s1), { t: 'list_rooms' });
      const listAfterLock = s1.last('room_list');
      if (listAfterLock === undefined) throw new Error('expected a room_list reply');
      expect(listAfterLock.rooms[0]?.phase).toBe('live'); // locked: bots filled, definitely not 'warmup'
      // this is the exact depth where the historical bug lived: a locked
      // 2v2 seats 1 human + 3 bots, but the lobby-list count must show
      // CONNECTED HUMANS (1), not seats (4) — else the room reads as full.
      expect(listAfterLock.rooms[0]?.players).toBe(1);

      const s2 = new FakeSession('p2');
      lobby.handleMessage(asSession(s2), { t: 'quick_join', name: 'Bob', game: 'rift' });

      // same room identity, proven from p2's own point of view — the
      // null-phase fallback found the live room and rift displaced a bot
      // seat for the new human rather than bouncing them to a new room.
      expect(lobby.roomCount()).toBe(1);
      expect(riftRoomIdSeenBy(s2)).toBe(riftRoomIdSeenBy(s1));

      lobby.handleMessage(asSession(s2), { t: 'list_rooms' });
      const listAfterJoin = s2.last('room_list');
      if (listAfterJoin === undefined) throw new Error('expected a room_list reply');
      expect(listAfterJoin.rooms[0]?.players).toBe(2); // 2 connected humans now, still not seats(4)
    } finally {
      vi.useRealTimers();
    }
  });

  it('when the first public room is genuinely at maxPlayers connected humans, the next quick-joiner gets a NEW room', () => {
    const lobby = new Lobby([RIFT]);
    tracked.push(lobby);

    const sessions: FakeSession[] = [];
    let firstSession: FakeSession | null = null;
    for (let i = 0; i < RIFT.maxPlayers; i++) {
      const s = new FakeSession(`p${i}`);
      if (firstSession === null) firstSession = s;
      sessions.push(s);
      lobby.handleMessage(asSession(s), { t: 'quick_join', name: `P${i}`, game: 'rift' });
    }
    if (firstSession === null) throw new Error('unreachable: RIFT.maxPlayers must be > 0');

    // still just the one room, genuinely full of CONNECTED HUMANS
    expect(lobby.roomCount()).toBe(1);
    const fullRoomId = riftRoomIdSeenBy(firstSession);
    for (const s of sessions) expect(riftRoomIdSeenBy(s)).toBe(fullRoomId);

    lobby.handleMessage(asSession(firstSession), { t: 'list_rooms' });
    const list = firstSession.last('room_list');
    if (list === undefined) throw new Error('expected a room_list reply');
    expect(list.rooms[0]?.players).toBe(RIFT.maxPlayers);

    const overflow = new FakeSession('overflow');
    lobby.handleMessage(asSession(overflow), { t: 'quick_join', name: 'Overflow', game: 'rift' });

    expect(lobby.roomCount()).toBe(2); // a second room was opened
    expect(riftRoomIdSeenBy(overflow)).not.toBe(fullRoomId); // never wedged into the full one
  });

  it('a PRIVATE room is never returned by quick_join; the quick-joiner gets their own room instead', () => {
    const lobby = new Lobby([RIFT]);
    tracked.push(lobby);

    const creator = new FakeSession('creator');
    lobby.handleMessage(asSession(creator), { t: 'create_private', name: 'Host', game: 'rift' });
    expect(lobby.roomCount()).toBe(1);
    const privateRoomId = riftRoomIdSeenBy(creator);

    const joiner = new FakeSession('joiner');
    lobby.handleMessage(asSession(joiner), { t: 'quick_join', name: 'Joiner', game: 'rift' });

    expect(lobby.roomCount()).toBe(2); // a fresh public room, not the private one
    const joinerRoomId = riftRoomIdSeenBy(joiner);
    expect(joinerRoomId).not.toBe(privateRoomId);

    // and the private room is still exactly as the creator left it: solo
    lobby.handleMessage(asSession(creator), { t: 'list_rooms' }); // private rooms never appear here anyway
    const list = creator.last('room_list');
    if (list === undefined) throw new Error('expected a room_list reply');
    expect(list.rooms.some((r) => r.id === privateRoomId)).toBe(false); // list_rooms never reveals it
  });
});

// ---- cross-module consistency: every registered game agrees on the shape --

describe('cross-module consistency (every module in registry.ts GAMES)', () => {
  const io: RoomIO = {
    send: () => {},
    rttMs: () => 0,
  };
  const trackedRooms: GameRoomHandle[] = [];

  afterEach(() => {
    for (const r of trackedRooms) r.stop();
    trackedRooms.length = 0;
  });

  for (const mod of GAMES) {
    it(`${mod.id}: info().players === playerCount(), info().maxPlayers === module.maxPlayers`, () => {
      const room = mod.createRoom({ visibility: 'public', io });
      trackedRooms.push(room);
      room.addPlayer('solo', 'Solo');

      // RIFT used to report seats-including-bots here while every other
      // game reported connected humans, which made a bot-filled rift room
      // display as full in the lobby list even with a free human seat. This
      // is the regression guard: every module must agree on this shape.
      expect(room.info().players).toBe(room.playerCount());
      expect(room.info().maxPlayers).toBe(mod.maxPlayers);
    });
  }
});
