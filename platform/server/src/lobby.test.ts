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
// - Every test below builds the Lobby with the REAL ancients module pulled
//   straight from registry.ts's GAMES — exactly "the ancients module" per spec —
//   so they exercise the actual production matchmaking path, not a stand-in.
//   (An earlier draft of this file could not safely drive rift to a live,
//   bot-filled phase because `@rift/server` was resolving through
//   node_modules into an unrelated, far-diverged checkout; that was a
//   workspace symlink issue, now fixed, and every case below runs against
//   this worktree's own code.)
// - ANCIENTS genuinely reports its waiting-for-players phase as the literal
//   string 'lobby', NOT 'warmup'. findPublicRoom (lobby.ts:224) prefers
//   'warmup' first but falls back to any phase at lobby.ts:319/327 — for
//   rift, that fallback is not a rare edge case, it is the ONLY path that
//   ever matches, on every single quick_join. The tests below assert that
//   truth and make the fallback explicit rather than assuming 'warmup'.
// ============================================================================
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { C2S, GameModule, GameRoomHandle, PlayerId, RoomId, RoomIO, S2C } from '@platform/shared';
import { PADS, STATS } from '@platform/shared';
import { Lobby, parseLobbyOpts } from './lobby.js';
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

const ANCIENTS: GameModule = (() => {
  const mod = GAMES.find((m) => m.id === 'ancients');
  if (mod === undefined) throw new Error('registry.ts GAMES has no "ancients" module registered');
  return mod;
})();

// ---- quick_join matchmaking (the reported bug: two humans, two rooms) ------

describe('quick_join matchmaking (real ancients module from registry.ts)', () => {
  let tracked: Lobby[] = [];

  afterEach(() => {
    for (const l of tracked) l.close();
    tracked = [];
  });

  it('two quick-joiners for the same game land in the SAME room (core case)', () => {
    const lobby = new Lobby([ANCIENTS]);
    tracked.push(lobby);

    const s1 = new FakeSession('p1');
    const s2 = new FakeSession('p2');
    lobby.handleMessage(asSession(s1), { t: 'quick_join', name: 'Ada', game: 'ancients' });
    lobby.handleMessage(asSession(s2), { t: 'quick_join', name: 'Bob', game: 'ancients' });

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
    const lobby = new Lobby([ANCIENTS]);
    tracked.push(lobby);

    const s1 = new FakeSession('p1');
    lobby.handleMessage(asSession(s1), { t: 'quick_join', name: 'Ada', game: 'ancients' });

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
    lobby.handleMessage(asSession(s2), { t: 'quick_join', name: 'Bob', game: 'ancients' });

    expect(lobby.roomCount()).toBe(1); // the fallback reused the room; no second one opened
    expect(riftRoomIdSeenBy(s1)).toBe(riftRoomIdSeenBy(s2));
  });

  it('repeats the core case with the first room driven to LIVE (locked, bots filled) — still not "warmup"', () => {
    vi.useFakeTimers();
    try {
      const lobby = new Lobby([ANCIENTS]);
      tracked.push(lobby);

      const s1 = new FakeSession('p1');
      lobby.handleMessage(asSession(s1), { t: 'quick_join', name: 'Ada', game: 'ancients' });
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
      lobby.handleMessage(asSession(s2), { t: 'quick_join', name: 'Bob', game: 'ancients' });

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
    const lobby = new Lobby([ANCIENTS]);
    tracked.push(lobby);

    const sessions: FakeSession[] = [];
    let firstSession: FakeSession | null = null;
    for (let i = 0; i < ANCIENTS.maxPlayers; i++) {
      const s = new FakeSession(`p${i}`);
      if (firstSession === null) firstSession = s;
      sessions.push(s);
      lobby.handleMessage(asSession(s), { t: 'quick_join', name: `P${i}`, game: 'ancients' });
    }
    if (firstSession === null) throw new Error('unreachable: ANCIENTS.maxPlayers must be > 0');

    // still just the one room, genuinely full of CONNECTED HUMANS
    expect(lobby.roomCount()).toBe(1);
    const fullRoomId = riftRoomIdSeenBy(firstSession);
    for (const s of sessions) expect(riftRoomIdSeenBy(s)).toBe(fullRoomId);

    lobby.handleMessage(asSession(firstSession), { t: 'list_rooms' });
    const list = firstSession.last('room_list');
    if (list === undefined) throw new Error('expected a room_list reply');
    expect(list.rooms[0]?.players).toBe(ANCIENTS.maxPlayers);

    const overflow = new FakeSession('overflow');
    lobby.handleMessage(asSession(overflow), { t: 'quick_join', name: 'Overflow', game: 'ancients' });

    expect(lobby.roomCount()).toBe(2); // a second room was opened
    expect(riftRoomIdSeenBy(overflow)).not.toBe(fullRoomId); // never wedged into the full one
  });

  it('a PRIVATE room is never returned by quick_join; the quick-joiner gets their own room instead', () => {
    const lobby = new Lobby([ANCIENTS]);
    tracked.push(lobby);

    const creator = new FakeSession('creator');
    lobby.handleMessage(asSession(creator), { t: 'create_private', name: 'Host', game: 'ancients' });
    expect(lobby.roomCount()).toBe(1);
    const privateRoomId = riftRoomIdSeenBy(creator);

    const joiner = new FakeSession('joiner');
    lobby.handleMessage(asSession(joiner), { t: 'quick_join', name: 'Joiner', game: 'ancients' });

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

      // ANCIENTS used to report seats-including-bots here while every other
      // game reported connected humans, which made a bot-filled rift room
      // display as full in the lobby list even with a free human seat. This
      // is the regression guard: every module must agree on this shape.
      expect(room.info().players).toBe(room.playerCount());
      expect(room.info().maxPlayers).toBe(mod.maxPlayers);
    });
  }
});

// ---- sig pass-through: lobby forwards `sig` to GameRoomHandle.addPlayer ----
//
// The platform never interprets `sig` — no dedup, no "kick the old session
// with this sig", no room steering (see lobby.ts joinRoom). All it does is
// carry the value from the wire message to addPlayer's 4th parameter,
// exactly like `resume` already does. A stub GameModule with a spied
// addPlayer is used here (rather than the real ancients module, as the
// quick_join describe block above uses) because what these tests need to
// observe is the exact argument tuple Lobby hands to the room — something
// a real module's addPlayer would swallow silently.

/** A minimal GameModule whose addPlayer records every call it receives, so
 *  tests can assert on the exact (id, name, resume, sig) tuple Lobby sent. */
function makeSpyModule(id: string): {
  mod: GameModule;
  calls: Array<[PlayerId, string, PlayerId | undefined, string | undefined]>;
} {
  const calls: Array<[PlayerId, string, PlayerId | undefined, string | undefined]> = [];
  let nextRoomId = 0;

  const mod: GameModule = {
    id,
    name: id,
    clientDist: '',
    minPlayers: 1,
    maxPlayers: 4,
    createRoom(opts) {
      const roomId: RoomId = `${id}-room-${nextRoomId++}`;
      let count = 0;
      const code: string | null = opts.visibility === 'private' ? `CODE${roomId}` : null;
      const room: GameRoomHandle = {
        id: roomId,
        info: () => ({
          id: roomId,
          code,
          game: id,
          label: '',
          players: count,
          maxPlayers: 4,
          phase: 'warmup',
          visibility: opts.visibility,
        }),
        playerCount: () => count,
        stalePlayers: () => [],
        addPlayer(playerId, name, resume, sig) {
          calls.push([playerId, name, resume, sig]);
          count++;
          // Mirrors real modules ("the room sends its own join payload"), so
          // tests below can recover roomId/code the same way a real client
          // would: off the session's own message stream, not module internals.
          opts.io.send(playerId, { t: 'spy_hello', roomId, code });
        },
        removePlayer() {
          count = Math.max(0, count - 1);
        },
        handleMessage() {},
        start() {},
        stop() {},
      };
      return room;
    },
  };
  return { mod, calls };
}

/** Reads the {roomId, code} a session was told on join, same pattern as
 *  riftRoomIdSeenBy above but for makeSpyModule's synthetic join payload. */
function spyHelloSeenBy(sess: FakeSession): { roomId: RoomId; code: string | null } {
  const hello = sess.all().find((m) => m.t === 'spy_hello');
  if (hello === undefined) throw new Error('no spy_hello observed for this session');
  const h = hello as unknown as { roomId: unknown; code: unknown };
  if (typeof h.roomId !== 'string') throw new Error('spy_hello carried no string roomId');
  return { roomId: h.roomId, code: typeof h.code === 'string' ? h.code : null };
}

describe('sig pass-through to GameRoomHandle.addPlayer', () => {
  let tracked: Lobby[] = [];

  afterEach(() => {
    for (const l of tracked) l.close();
    tracked = [];
  });

  it('a join carrying `sig` reaches the room addPlayer as the 4th argument', () => {
    const { mod, calls } = makeSpyModule('spy1');
    const lobby = new Lobby([mod]);
    tracked.push(lobby);

    lobby.handleMessage(asSession(new FakeSession('p1')), {
      t: 'quick_join',
      name: 'Ada',
      game: 'spy1',
      sig: 'sig-abcdefgh',
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.[3]).toBe('sig-abcdefgh');
  });

  it('a join carrying BOTH resume and sig forwards both, in order', () => {
    const { mod, calls } = makeSpyModule('spy2');
    const lobby = new Lobby([mod]);
    tracked.push(lobby);

    lobby.handleMessage(asSession(new FakeSession('p1')), {
      t: 'quick_join',
      name: 'Ada',
      game: 'spy2',
      resume: 'old-player-id',
      sig: 'sig-abcdefgh',
    });

    expect(calls[0]).toEqual(['p1', 'Ada', 'old-player-id', 'sig-abcdefgh']);
  });

  it('a join carrying neither resume nor sig still calls addPlayer, both undefined, unchanged from today', () => {
    const { mod, calls } = makeSpyModule('spy3');
    const lobby = new Lobby([mod]);
    tracked.push(lobby);

    lobby.handleMessage(asSession(new FakeSession('p1')), { t: 'quick_join', name: 'Ada', game: 'spy3' });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(['p1', 'Ada', undefined, undefined]);
  });

  it('all five join message types forward sig', () => {
    const { mod, calls } = makeSpyModule('spy4');
    const lobby = new Lobby([mod]);
    tracked.push(lobby);

    // create_public — opens a fresh public room
    const pubCreator = new FakeSession('pub-creator');
    lobby.handleMessage(asSession(pubCreator), {
      t: 'create_public',
      name: 'A',
      game: 'spy4',
      sig: 'sig-createpub1',
    });
    const pubRoomId = spyHelloSeenBy(pubCreator).roomId; // learned the same way a real client would

    // join_public — same room, addressed by the id the creator was told
    lobby.handleMessage(asSession(new FakeSession('pub-joiner')), {
      t: 'join_public',
      name: 'B',
      roomId: pubRoomId,
      sig: 'sig-joinpub1',
    });

    // create_private — opens a fresh private room
    const privCreator = new FakeSession('priv-creator');
    lobby.handleMessage(asSession(privCreator), {
      t: 'create_private',
      name: 'C',
      game: 'spy4',
      sig: 'sig-createpriv1',
    });
    const privCode = spyHelloSeenBy(privCreator).code;
    if (privCode === null) throw new Error('expected a private room code');

    // join_private — same room, addressed by the code the creator was told
    lobby.handleMessage(asSession(new FakeSession('priv-joiner')), {
      t: 'join_private',
      name: 'D',
      code: privCode,
      sig: 'sig-joinpriv1',
    });

    // quick_join — the public room from above still has space and reports
    // 'warmup', so this lands there rather than opening a third room; either
    // way it is still a fifth addPlayer call carrying its own sig.
    lobby.handleMessage(asSession(new FakeSession('quick-joiner')), {
      t: 'quick_join',
      name: 'E',
      game: 'spy4',
      sig: 'sig-quickjoin1',
    });

    expect(calls.map((c) => c[3])).toEqual([
      'sig-createpub1',
      'sig-joinpub1',
      'sig-createpriv1',
      'sig-joinpriv1',
      'sig-quickjoin1',
    ]);
  });
});

// ============================================================================
// v2 additions (specs/P4.md) — ws auth, pad pairing + input relay, the
// RoomIO v2 members and their stats sink. Everything below is ADDITIVE;
// every test above predates P4 and is the regression gate for it.
//
// Harness notes (v2)
// ------------------
// - SpyStore satisfies Lobby's STRUCTURAL store seam ({profileIdByToken,
//   profileById, addStats}) without touching node:sqlite — exactly how the
//   real services/db.ts Store plugs in through index.ts.
// - makePadSpyModule captures what a real GameRoomHandle would swallow:
//   handleMessage args (pad relay), addPlayer calls ("pads are NOT players"),
//   and the RoomIO instance itself (so tests can call profileId/reportStats/
//   padOwner the way a v2 game would).
// - Messages go straight into Lobby.handleMessage as typed C2S literals,
//   like every pre-v2 test here — net.ts's parseC2S is upstream of this seam.
// ============================================================================

/** 43-char base64url strings — the exact shape isValidToken accepts. */
const TOKEN_A = 'a'.repeat(43);
const TOKEN_B = 'b'.repeat(43);

/**
 * Minimal spy double for the platform Store. Records stats writes so tests
 * can assert on the exact (profileId, gameId, delta) tuple the gateway wrote.
 */
class SpyStore {
  readonly statsWrites: Array<{ profileId: string; gameId: string; delta: Record<string, number> }> = [];
  private readonly profiles = new Map<string, { id: string; name: string }>();
  private readonly tokens = new Map<string, string>();

  seed(profileId: string, name: string, token: string): void {
    this.profiles.set(profileId, { id: profileId, name });
    this.tokens.set(token, profileId);
  }

  profileIdByToken(token: string): string | null {
    return this.tokens.get(token) ?? null;
  }

  profileById(id: string): { id: string; name: string } | null {
    return this.profiles.get(id) ?? null;
  }

  addStats(profileId: string, gameId: string, delta: Record<string, number>): void {
    this.statsWrites.push({ profileId, gameId, delta });
  }
}

type PadInputMsg = Extract<C2S, { t: 'pad_input' }>;

/** One valid pad_input frame (values already inside wire limits). */
function padFrame(seq: number): PadInputMsg {
  return { t: 'pad_input', seq, lx: 0, ly: 0, rx: 0, ry: 0, buttons: 0 };
}

interface PadSpyModule {
  mod: GameModule;
  /** Every (playerId, msg) the room received via handleMessage. */
  forwarded: Array<{ playerId: PlayerId; msg: unknown }>;
  /** Every id handed to addPlayer — pads must never appear here. */
  addedPlayers: PlayerId[];
  roomIds: readonly RoomId[];
  /** The RoomIO the module was created with (defined after first createRoom). */
  io(): RoomIO;
  /** Simulate a room-initiated kick: the player_left broadcast the lobby watches for. */
  kickFromRoom(playerId: PlayerId): void;
}

/**
 * The lobby always wires the OPTIONAL v2 members onto its shared RoomIO;
 * this narrows them from `?`-optional to definite so tests can call them
 * exactly the way a v2 game would.
 */
function v2io(io: RoomIO): Required<Pick<RoomIO, 'profileId' | 'reportStats' | 'padOwner'>> {
  const { profileId, reportStats, padOwner } = io;
  if (profileId === undefined || reportStats === undefined || padOwner === undefined) {
    throw new Error('expected the lobby io bridge to carry all v2 members');
  }
  return { profileId, reportStats, padOwner };
}

/**
 * A minimal real-plumbed module whose observable surface is everything the
 * relay/stats tests need. Room ids are `${id}-room-N` (4–16 chars, so they
 * pass parseC2S's join_as_pad room validation).
 */
function makePadSpyModule(id: string): PadSpyModule {
  const forwarded: Array<{ playerId: PlayerId; msg: unknown }> = [];
  const addedPlayers: PlayerId[] = [];
  const roomIds: RoomId[] = [];
  let created: RoomIO | null = null;
  let count = 0;

  const mod: GameModule = {
    id,
    name: id.toUpperCase(),
    clientDist: '',
    minPlayers: 1,
    maxPlayers: 4,
    createRoom(opts) {
      created = opts.io;
      const roomId: RoomId = `${id}-room-${roomIds.length}`;
      roomIds.push(roomId);
      const visibility = opts.visibility;
      const room: GameRoomHandle = {
        id: roomId,
        info: () => ({
          id: roomId,
          code: null,
          game: id,
          label: '',
          players: count,
          maxPlayers: 4,
          phase: 'warmup',
          visibility,
        }),
        playerCount: () => count,
        stalePlayers: () => [],
        addPlayer(playerId) {
          addedPlayers.push(playerId);
          count += 1;
          opts.io.send(playerId, { t: 'padspy_hello', roomId });
        },
        removePlayer() {
          count = Math.max(0, count - 1);
        },
        handleMessage(playerId, msg) {
          forwarded.push({ playerId, msg });
        },
        start() {},
        stop() {},
      };
      return room;
    },
  };
  return {
    mod,
    forwarded,
    addedPlayers,
    roomIds,
    io(): RoomIO {
      if (created === null) throw new Error('makePadSpyModule: createRoom has not run yet');
      return created;
    },
    kickFromRoom(playerId: PlayerId): void {
      if (created === null) throw new Error('makePadSpyModule: createRoom has not run yet');
      created.send(playerId, { t: 'event', ev: { t: 'player_left', id: playerId } });
    },
  };
}

/** Ask for a pairing code as an in-room player and hand back the typed reply. */
function requestPair(lobby: Lobby, owner: FakeSession): Extract<S2C, { t: 'pad_pair' }> {
  lobby.handleMessage(asSession(owner), { t: 'pad_pair_request' });
  const pair = owner.last('pad_pair');
  if (pair === undefined) throw new Error('expected a pad_pair reply');
  return pair;
}

/** A pad device spending `pair` (the join_as_pad hop of the pairing flow). */
function joinAsPad(lobby: Lobby, pad: FakeSession, pair: { room: string; token: string }): void {
  lobby.handleMessage(asSession(pad), { t: 'join_as_pad', room: pair.room, token: pair.token });
}

/** Count S2C messages of one tag a session received (echo counting etc.). */
function countTag(sess: FakeSession, tag: S2C['t']): number {
  return sess.all().filter((m) => m.t === tag).length;
}

/** Mint + bind in one step; throws unless BOTH sides saw success. */
function pairAndBind(lobby: Lobby, owner: FakeSession, pad: FakeSession): void {
  const pair = requestPair(lobby, owner);
  joinAsPad(lobby, pad, pair);
  if (pad.last('pad_joined') === undefined) throw new Error('pad was not bound (no pad_joined)');
}

// ---- v2 ws auth -------------------------------------------------------------

describe('v2 ws auth (specs/P4.md)', () => {
  let tracked: Lobby[] = [];

  afterEach(() => {
    for (const l of tracked) l.close();
    tracked = [];
  });

  it('a valid token binds the profile: auth_ok carries its id + platform name', () => {
    const store = new SpyStore();
    store.seed('prof-ada', 'AdaPrime', TOKEN_A);
    const lobby = new Lobby([ANCIENTS], store);
    tracked.push(lobby);

    const s = new FakeSession('p1');
    lobby.handleMessage(asSession(s), { t: 'auth', token: TOKEN_A });

    expect(s.last('auth_ok')).toEqual({ t: 'auth_ok', profileId: 'prof-ada', name: 'AdaPrime' });
    expect(s.last('auth_err')).toBeUndefined();
  });

  it('an unknown token answers auth_err with a message, binding nothing', () => {
    const store = new SpyStore();
    store.seed('prof-ada', 'AdaPrime', TOKEN_A);
    const lobby = new Lobby([ANCIENTS], store);
    tracked.push(lobby);

    const s = new FakeSession('p1');
    lobby.handleMessage(asSession(s), { t: 'auth', token: TOKEN_B }); // right shape, nobody's token

    const err = s.last('auth_err');
    expect(err).toBeDefined();
    expect(err?.message.length ?? 0).toBeGreaterThan(0);
    expect(s.last('auth_ok')).toBeUndefined();
  });

  it('a second auth replaces the first (protocol: idempotent, latest wins)', () => {
    const store = new SpyStore();
    store.seed('prof-ada', 'AdaPrime', TOKEN_A);
    store.seed('prof-bob', 'BobPrime', TOKEN_B);
    const lobby = new Lobby([ANCIENTS], store);
    tracked.push(lobby);

    const s = new FakeSession('p1');
    lobby.handleMessage(asSession(s), { t: 'auth', token: TOKEN_A });
    lobby.handleMessage(asSession(s), { t: 'auth', token: TOKEN_B });

    expect(countTag(s, 'auth_ok')).toBe(2);
    expect(s.last('auth_ok')?.profileId).toBe('prof-bob');
  });

  it('a pre-v2 lobby built WITHOUT a store still answers auth_err rather than throwing', () => {
    const lobby = new Lobby([ANCIENTS]); // legacy constructor arity, unchanged
    tracked.push(lobby);

    const s = new FakeSession('p1');
    expect(() => lobby.handleMessage(asSession(s), { t: 'auth', token: TOKEN_A })).not.toThrow();
    expect(s.last('auth_err')).toBeDefined();
    expect(s.last('auth_ok')).toBeUndefined();
  });
});

// ---- pad pairing ------------------------------------------------------------

describe('pad pairing (specs/P4.md)', () => {
  let tracked: Lobby[] = [];

  afterEach(() => {
    for (const l of tracked) l.close();
    tracked = [];
  });

  it('in-room pad_pair_request mints a claim-shaped code + the /pad/?game&r=<room> URL (real ancients room)', () => {
    const lobby = new Lobby([ANCIENTS]);
    tracked.push(lobby);

    const host = new FakeSession('host');
    lobby.handleMessage(asSession(host), { t: 'quick_join', name: 'Host', game: 'ancients' });
    const roomId = riftRoomIdSeenBy(host);

    const pair = requestPair(lobby, host);
    expect(pair.room).toBe(roomId);
    expect(pair.token).toMatch(/^[A-HJ-NP-Z2-9]{6}$/); // CLAIM_ALPHABET shape (isValidPairCode)
    expect(pair.urlPath).toBe(`/pad/?game=ancients&r=${roomId}`);
  });

  it('pad_pair_request outside any room is refused with an error, no token minted', () => {
    const lobby = new Lobby([ANCIENTS]);
    tracked.push(lobby);

    const loner = new FakeSession('loner');
    lobby.handleMessage(asSession(loner), { t: 'pad_pair_request' });

    expect(loner.last('pad_pair')).toBeUndefined();
    expect(loner.last('error')?.code).toBe('no_room');
  });

  it('join_as_pad happy path binds pad↔(room,owner) — and pads are NOT players', () => {
    const spy = makePadSpyModule('padspec');
    const lobby = new Lobby([spy.mod]);
    tracked.push(lobby);

    const owner = new FakeSession('owner');
    lobby.handleMessage(asSession(owner), { t: 'quick_join', name: 'Host', game: 'padspec' });
    const pad = new FakeSession('phone-1');
    pairAndBind(lobby, owner, pad);

    expect(pad.last('pad_joined')).toBeDefined();
    expect(owner.last('pad_status')).toEqual({ t: 'pad_status', bound: true });
    // invisible to membership: no seat consumed, count unchanged
    expect(spy.addedPlayers).toEqual(['owner']);
    lobby.handleMessage(asSession(owner), { t: 'list_rooms' });
    expect(owner.last('room_list')?.rooms[0]?.players).toBe(1);
    // RoomIO.padOwner resolves the pad SESSION id to its owning seat
    expect(v2io(spy.io()).padOwner('phone-1')).toBe('owner');
  });

  it('an unknown code is rejected (bad_code)', () => {
    const spy = makePadSpyModule('padspec');
    const lobby = new Lobby([spy.mod]);
    tracked.push(lobby);
    const owner = new FakeSession('owner');
    lobby.handleMessage(asSession(owner), { t: 'quick_join', name: 'Host', game: 'padspec' });

    const pad = new FakeSession('phone-1');
    joinAsPad(lobby, pad, { room: spy.roomIds[0] ?? '', token: 'X9X9X9' });

    expect(pad.last('pad_rejected')?.reason).toBe('bad_code');
    expect(pad.last('pad_joined')).toBeUndefined();
    expect(owner.last('pad_status')).toBeUndefined(); // owner never told bound:true
  });

  it('a consumed code cannot bind twice (single use)', () => {
    const spy = makePadSpyModule('padspec');
    const lobby = new Lobby([spy.mod]);
    tracked.push(lobby);
    const owner = new FakeSession('owner');
    lobby.handleMessage(asSession(owner), { t: 'quick_join', name: 'Host', game: 'padspec' });

    const first = requestPair(lobby, owner);
    joinAsPad(lobby, new FakeSession('phone-1'), first); // spent here
    expect(countTag(owner, 'pad_status')).toBe(1);

    const second = new FakeSession('phone-2');
    joinAsPad(lobby, second, first); // replayed token

    expect(second.last('pad_rejected')?.reason).toBe('bad_code'); // already consumed
    expect(second.last('pad_joined')).toBeUndefined();
    expect(countTag(owner, 'pad_status')).toBe(1); // no second bound:true
  });

  it('a code past PADS.pairTtlMs is rejected (TTL)', () => {
    vi.useFakeTimers();
    try {
      const spy = makePadSpyModule('padttl');
      const lobby = new Lobby([spy.mod]);
      tracked.push(lobby);
      const owner = new FakeSession('owner');
      lobby.handleMessage(asSession(owner), { t: 'quick_join', name: 'Host', game: 'padttl' });
      const pair = requestPair(lobby, owner);

      vi.advanceTimersByTime(PADS.pairTtlMs + 1);
      const late = new FakeSession('phone-1');
      joinAsPad(lobby, late, pair);

      expect(late.last('pad_rejected')).toBeDefined();
      expect(late.last('pad_joined')).toBeUndefined();
      expect(owner.last('pad_status')).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a valid code aimed at the WRONG room is rejected without being consumed', () => {
    const spy = makePadSpyModule('padspec');
    const lobby = new Lobby([spy.mod]);
    tracked.push(lobby);
    const owner = new FakeSession('owner');
    lobby.handleMessage(asSession(owner), { t: 'quick_join', name: 'Host', game: 'padspec' });
    const pair = requestPair(lobby, owner);

    const confused = new FakeSession('phone-x');
    joinAsPad(lobby, confused, { room: 'not-this-room', token: pair.token });
    expect(confused.last('pad_rejected')?.reason).toBe('room_mismatch');

    // mismatch did NOT spend the single-use code: the right room still binds
    const right = new FakeSession('phone-1');
    joinAsPad(lobby, right, pair);
    expect(right.last('pad_joined')).toBeDefined();
  });

  it('if the owner left between mint and bind, the code is dead (owner_gone)', () => {
    const spy = makePadSpyModule('padspec');
    const lobby = new Lobby([spy.mod]);
    tracked.push(lobby);
    const owner = new FakeSession('owner');
    lobby.handleMessage(asSession(owner), { t: 'quick_join', name: 'Host', game: 'padspec' });
    const pair = requestPair(lobby, owner);

    lobby.handleMessage(asSession(owner), { t: 'leave' });
    const pad = new FakeSession('phone-1');
    joinAsPad(lobby, pad, pair);

    expect(pad.last('pad_rejected')?.reason).toBe('owner_gone');
    expect(pad.last('pad_joined')).toBeUndefined();
  });
});

// ---- pad input relay ----------------------------------------------------------

describe('pad input relay (specs/PADS.inputMaxHz)', () => {
  let tracked: Lobby[] = [];

  afterEach(() => {
    for (const l of tracked) l.close();
    tracked = [];
  });

  /** Owner in-room + one bound pad; returns the fixtures the tests poke at. */
  function setupBound(): { lobby: Lobby; spy: PadSpyModule; owner: FakeSession; pad: FakeSession } {
    const spy = makePadSpyModule('relay');
    const lobby = new Lobby([spy.mod]);
    tracked.push(lobby);
    const owner = new FakeSession('owner');
    lobby.handleMessage(asSession(owner), { t: 'quick_join', name: 'Host', game: 'relay' });
    const pad = new FakeSession('phone-1');
    pairAndBind(lobby, owner, pad);
    return { lobby, spy, owner, pad };
  }

  it('bound pad_input reaches the room RAW under the PAD session id, then echoes seq', () => {
    const { lobby, spy, pad } = setupBound();
    const frame = { ...padFrame(7), lx: 0.5, ly: -0.5, buttons: 3 };

    lobby.handleMessage(asSession(pad), frame);

    expect(spy.forwarded).toEqual([{ playerId: 'phone-1', msg: frame }]);
    expect(pad.last('pad_input_echo')).toEqual({ t: 'pad_input_echo', seq: 7 });
  });

  it('frames beyond PADS.inputMaxHz inside the window are dropped silently (no forward, no echo)', () => {
    const { lobby, spy, pad } = setupBound();
    for (let seq = 0; seq < PADS.inputMaxHz + 15; seq++) {
      lobby.handleMessage(asSession(pad), padFrame(seq));
    }

    expect(spy.forwarded.length).toBe(PADS.inputMaxHz);
    expect(countTag(pad, 'pad_input_echo')).toBe(PADS.inputMaxHz);
    // the FIRST maxHz frames win, excess is what got cut
    const lastForwarded = spy.forwarded[spy.forwarded.length - 1];
    expect((lastForwarded?.msg as PadInputMsg | undefined)?.seq).toBe(PADS.inputMaxHz - 1);
  });

  it("an UNBOUND session's pad_input goes nowhere at all", () => {
    const { lobby, spy } = setupBound();

    const ghost = new FakeSession('ghost-pad');
    lobby.handleMessage(asSession(ghost), padFrame(1));

    expect(spy.forwarded).toEqual([]);
    expect(ghost.last('pad_input_echo')).toBeUndefined();
  });

  it('pad disconnect unbinds: the owner hears bound:false and later frames are dropped', () => {
    const { lobby, spy, owner, pad } = setupBound();

    lobby.handleDisconnect(asSession(pad));

    expect(owner.last('pad_status')).toEqual({ t: 'pad_status', bound: false });
    lobby.handleMessage(asSession(pad), padFrame(99)); // zombie frames after close
    expect(spy.forwarded).toEqual([]);
  });

  it("pad explicit leave unbinds: the owner hears bound:false and later frames are dropped (spec §4.4 step 4)", () => {
    const { lobby, spy, owner, pad } = setupBound();

    lobby.handleMessage(asSession(pad), { t: 'leave' });

    expect(owner.last('pad_status')).toEqual({ t: 'pad_status', bound: false });
    expect(v2io(spy.io()).padOwner('phone-1')).toBeNull();
    lobby.handleMessage(asSession(pad), padFrame(7)); // frames after the leave
    expect(spy.forwarded).toEqual([]);
  });

  it('the OWNER leaving unbinds the pad and hears bound:false itself', () => {
    const { lobby, spy, owner, pad } = setupBound();

    lobby.handleMessage(asSession(owner), { t: 'leave' });

    expect(owner.last('pad_status')).toEqual({ t: 'pad_status', bound: false });
    expect(v2io(spy.io()).padOwner('phone-1')).toBeNull();
    lobby.handleMessage(asSession(pad), padFrame(5));
    expect(spy.forwarded).toEqual([]); // no longer routed anywhere
  });

  it("a room-KICKED owner (player_left on the bridge) loses its pads immediately — it never hits leaveRoom's early return", () => {
    const { lobby, spy, owner, pad } = setupBound();

    spy.kickFromRoom('owner');

    expect(owner.last('pad_status')).toEqual({ t: 'pad_status', bound: false });
    lobby.handleMessage(asSession(pad), padFrame(11));
    expect(spy.forwarded).toEqual([]);
  });
});

// ---- RoomIO v2 members ---------------------------------------------------------

describe('RoomIO v2 members: profileId / reportStats / padOwner (specs/P4.md)', () => {
  let tracked: Lobby[] = [];

  afterEach(() => {
    for (const l of tracked) l.close();
    tracked = [];
  });

  function setupWith(store: SpyStore): { lobby: Lobby; spy: PadSpyModule; p1: FakeSession } {
    const spy = makePadSpyModule('ioroom');
    const lobby = new Lobby([spy.mod], store);
    tracked.push(lobby);
    const p1 = new FakeSession('p1');
    lobby.handleMessage(asSession(p1), { t: 'quick_join', name: 'P1', game: 'ioroom' });
    return { lobby, spy, p1 };
  }

  it('profileId: "" while anonymous, the bound profile once authed, "" for unknown ids', () => {
    const store = new SpyStore();
    store.seed('prof-1', 'AdaPrime', TOKEN_A);
    const { lobby, spy, p1 } = setupWith(store);
    const io = v2io(spy.io());

    expect(io.profileId('p1')).toBe('');
    lobby.handleMessage(asSession(p1), { t: 'auth', token: TOKEN_A });
    expect(io.profileId('p1')).toBe('prof-1');
    expect(io.profileId('bot-with-no-session')).toBe('');
  });

  it('reportStats clamps to STATS limits and writes through under (profileId, room gameId)', () => {
    const store = new SpyStore();
    store.seed('prof-1', 'AdaPrime', TOKEN_A);
    const { lobby, spy, p1 } = setupWith(store);
    lobby.handleMessage(asSession(p1), { t: 'auth', token: TOKEN_A });
    const io = v2io(spy.io());

    io.reportStats('p1', {
      kills: 3,
      huge: 5 * STATS.maxValue, // clamps down to +STATS.maxValue
      neg: -7,
      nan: Number.NaN, // dropped
      inf: Infinity, // dropped
    });
    lobby.flushStats(); // P0-2: writes land off-tick, not synchronously

    expect(store.statsWrites).toEqual([
      { profileId: 'prof-1', gameId: 'ioroom', delta: { kills: 3, huge: STATS.maxValue, neg: -7 } },
    ]);
  });

  it('anonymous players report nothing (no-op, no store write)', () => {
    const store = new SpyStore();
    const { lobby, spy } = setupWith(store);

    v2io(spy.io()).reportStats('p1', { kills: 1 }); // p1 never authenticated

    expect(store.statsWrites).toEqual([]);
    expect(lobby.statsPending()).toBe(0); // nothing even queued
  });

  it('at most STATS.maxKeysPerDelta keys survive one report', () => {
    const store = new SpyStore();
    store.seed('prof-1', 'AdaPrime', TOKEN_A);
    const { lobby, spy, p1 } = setupWith(store);
    lobby.handleMessage(asSession(p1), { t: 'auth', token: TOKEN_A });

    const twentyKeys: Record<string, number> = {};
    for (let i = 0; i < 20; i++) twentyKeys[`k${i}`] = 1;
    v2io(spy.io()).reportStats('p1', twentyKeys);
    lobby.flushStats(); // P0-2: writes land off-tick, not synchronously

    expect(Object.keys(store.statsWrites[0]?.delta ?? {}).length).toBe(STATS.maxKeysPerDelta);
  });

  it('a THROWING store never propagates out of reportStats or auth (game threads stay alive)', () => {
    const boom = {
      profileIdByToken(): string | null {
        throw new Error('db gone');
      },
      profileById(): { id: string; name: string } | null {
        throw new Error('db gone');
      },
      addStats(): void {
        throw new Error('db gone');
      },
    };
    const spy = makePadSpyModule('boomgame');
    const lobby = new Lobby([spy.mod], boom);
    tracked.push(lobby);
    const p1 = new FakeSession('p1');
    lobby.handleMessage(asSession(p1), { t: 'quick_join', name: 'P1', game: 'boomgame' });

    expect(() => v2io(spy.io()).reportStats('p1', { kills: 1 })).not.toThrow();
    expect(() => lobby.handleMessage(asSession(p1), { t: 'auth', token: TOKEN_A })).not.toThrow();
    expect(() => lobby.flushStats()).not.toThrow(); // the flush swallows store throws too
    expect(p1.last('auth_err')).toBeDefined();
  });
});

// ---- P0-2 off-tick stats queue ------------------------------------------------

describe('P0-2 off-tick stats queue', () => {
  let tracked: Lobby[] = [];

  afterEach(() => {
    for (const l of tracked) l.close();
    tracked = [];
  });

  function setupAuthed(store: SpyStore): { lobby: Lobby; spy: PadSpyModule; p1: FakeSession } {
    const spy = makePadSpyModule('qgame');
    const lobby = new Lobby([spy.mod], store);
    tracked.push(lobby);
    const p1 = new FakeSession('p1');
    lobby.handleMessage(asSession(p1), { t: 'quick_join', name: 'P1', game: 'qgame' });
    return { lobby, spy, p1 };
  }

  it('reportStats never touches the store synchronously — the write lands on flush', () => {
    const store = new SpyStore();
    store.seed('prof-1', 'AdaPrime', TOKEN_A);
    const { lobby, spy, p1 } = setupAuthed(store);
    lobby.handleMessage(asSession(p1), { t: 'auth', token: TOKEN_A });

    v2io(spy.io()).reportStats('p1', { kills: 2 });

    expect(store.statsWrites).toEqual([]); // tick thread did no sqlite
    expect(lobby.statsPending()).toBe(1);
    lobby.flushStats();
    expect(store.statsWrites).toEqual([{ profileId: 'prof-1', gameId: 'qgame', delta: { kills: 2 } }]);
    expect(lobby.statsPending()).toBe(0);
  });

  it('a store WITHOUT addStatsBatch still gets every entry via addStats (SpyStore path)', () => {
    const store = new SpyStore(); // structural LobbyStore, no addStatsBatch member
    store.seed('prof-1', 'AdaPrime', TOKEN_A);
    const { lobby, spy, p1 } = setupAuthed(store);
    lobby.handleMessage(asSession(p1), { t: 'auth', token: TOKEN_A });

    v2io(spy.io()).reportStats('p1', { a: 1 });
    v2io(spy.io()).reportStats('p1', { b: 2 });
    lobby.flushStats();

    expect(store.statsWrites).toEqual([
      { profileId: 'prof-1', gameId: 'qgame', delta: { a: 1 } },
      { profileId: 'prof-1', gameId: 'qgame', delta: { b: 2 } },
    ]);
  });

  it('a store WITH addStatsBatch gets ONE batch call for the whole flush', () => {
    const batches: Array<readonly { profileId: string; gameId: string; delta: Record<string, number> }[]> = [];
    const store = new SpyStore();
    (store as unknown as Record<string, unknown>).addStatsBatch = (
      entries: readonly { profileId: string; gameId: string; delta: Record<string, number> }[],
    ): void => {
      batches.push(entries);
    };
    store.seed('prof-1', 'AdaPrime', TOKEN_A);
    const { lobby, spy, p1 } = setupAuthed(store);
    lobby.handleMessage(asSession(p1), { t: 'auth', token: TOKEN_A });

    v2io(spy.io()).reportStats('p1', { a: 1 });
    v2io(spy.io()).reportStats('p1', { b: 2 });
    lobby.flushStats();

    expect(batches.length).toBe(1);
    expect(batches[0]).toEqual([
      { profileId: 'prof-1', gameId: 'qgame', delta: { a: 1 } },
      { profileId: 'prof-1', gameId: 'qgame', delta: { b: 2 } },
    ]);
    expect(store.statsWrites).toEqual([]); // batch path bypasses per-entry writes
  });

  it('close() flushes pending writes instead of dropping them', () => {
    const store = new SpyStore();
    store.seed('prof-1', 'AdaPrime', TOKEN_A);
    const { lobby, spy, p1 } = setupAuthed(store);
    lobby.handleMessage(asSession(p1), { t: 'auth', token: TOKEN_A });

    v2io(spy.io()).reportStats('p1', { kills: 9 });
    expect(store.statsWrites).toEqual([]);
    lobby.close();

    expect(store.statsWrites).toEqual([{ profileId: 'prof-1', gameId: 'qgame', delta: { kills: 9 } }]);
  });

  it('game id + profile are snapshotted at report time, so a flush after room close still lands', () => {
    const store = new SpyStore();
    store.seed('prof-1', 'AdaPrime', TOKEN_A);
    const { lobby, spy, p1 } = setupAuthed(store);
    lobby.handleMessage(asSession(p1), { t: 'auth', token: TOKEN_A });

    v2io(spy.io()).reportStats('p1', { kills: 4 });
    lobby.handleMessage(asSession(p1), { t: 'leave' }); // room gone before the flush
    lobby.flushStats();

    expect(store.statsWrites).toEqual([{ profileId: 'prof-1', gameId: 'qgame', delta: { kills: 4 } }]);
  });
});

// ---- P0-3 capacity + staggered sweep ------------------------------------------

describe('P0-3 capacity + staggered sweep', () => {
  let tracked: Lobby[] = [];

  afterEach(() => {
    for (const l of tracked) l.close();
    tracked = [];
  });

  /** Rooms with scriptable stalePlayers: tests decide who is stale, per room. */
  function makeStaleSpyModule(id: string): { mod: GameModule; staleOf: Map<RoomId, PlayerId[]> } {
    const staleOf = new Map<RoomId, PlayerId[]>();
    let n = 0;
    const mod: GameModule = {
      id,
      name: id.toUpperCase(),
      clientDist: '',
      minPlayers: 1,
      maxPlayers: 8,
      createRoom(opts) {
        const roomId: RoomId = `${id}-stale-${n++}`;
        const members = new Set<PlayerId>();
        staleOf.set(roomId, []);
        const room: GameRoomHandle = {
          id: roomId,
          info: () => ({
            id: roomId,
            code: null,
            game: id,
            label: '',
            players: members.size,
            maxPlayers: 8,
            phase: 'warmup',
            visibility: opts.visibility,
          }),
          playerCount: () => members.size,
          stalePlayers: () => [...(staleOf.get(roomId) ?? [])],
          addPlayer: (playerId) => {
            members.add(playerId);
          },
          removePlayer: (playerId) => {
            members.delete(playerId);
          },
          handleMessage: () => {},
          start: () => {},
          stop: () => {},
        };
        return room;
      },
    };
    return { mod, staleOf };
  }

  function createPrivateRoom(lobby: Lobby, sess: FakeSession, game: string): void {
    lobby.handleMessage(asSession(sess), { t: 'create_private', name: 'P', game });
  }

  it('default cap is 64 rooms: the 65th creation answers rooms_full', () => {
    const spy = makePadSpyModule('capgame');
    const lobby = new Lobby([spy.mod]);
    tracked.push(lobby);

    for (let i = 0; i < 64; i++) createPrivateRoom(lobby, new FakeSession(`p${i}`), 'capgame');
    expect(lobby.roomCount()).toBe(64);

    const extra = new FakeSession('p64');
    createPrivateRoom(lobby, extra, 'capgame');
    expect(extra.last('error')?.code).toBe('rooms_full');
    expect(lobby.roomCount()).toBe(64);
  });

  it('opts.maxRooms overrides the default (2 rooms, then rooms_full)', () => {
    const spy = makePadSpyModule('capgame');
    const lobby = new Lobby([spy.mod], null, { maxRooms: 2 });
    tracked.push(lobby);

    createPrivateRoom(lobby, new FakeSession('a'), 'capgame');
    createPrivateRoom(lobby, new FakeSession('b'), 'capgame');
    const third = new FakeSession('c');
    createPrivateRoom(lobby, third, 'capgame');

    expect(third.last('error')?.code).toBe('rooms_full');
    expect(lobby.roomCount()).toBe(2);
  });

  it('opts.maxRoomsPerGame caps one game while others stay uncapped', () => {
    const a = makePadSpyModule('capA');
    const b = makePadSpyModule('capB');
    const lobby = new Lobby([a.mod, b.mod], null, { maxRoomsPerGame: { capA: 1 } });
    tracked.push(lobby);

    createPrivateRoom(lobby, new FakeSession('a1'), 'capA');
    const a2 = new FakeSession('a2');
    createPrivateRoom(lobby, a2, 'capA');
    expect(a2.last('error')?.code).toBe('rooms_full');

    createPrivateRoom(lobby, new FakeSession('b1'), 'capB');
    createPrivateRoom(lobby, new FakeSession('b2'), 'capB');
    expect(lobby.roomCount()).toBe(3);
  });

  it('invalid caps fall back to defaults instead of bricking the lobby', () => {
    const spy = makePadSpyModule('capgame');
    const lobby = new Lobby([spy.mod], null, { maxRooms: 0, sweepRoomsPerPoll: -5, maxRoomsPerGame: { capgame: 0 } });
    tracked.push(lobby);

    createPrivateRoom(lobby, new FakeSession('a'), 'capgame');
    createPrivateRoom(lobby, new FakeSession('b'), 'capgame');
    createPrivateRoom(lobby, new FakeSession('c'), 'capgame');
    expect(lobby.roomCount()).toBe(3); // maxRooms:0 would have blocked ALL of these
  });

  it('parseLobbyOpts reads PLATFORM_MAX_ROOMS/PLATFORM_SWEEP_ROOMS, garbage => unset', () => {
    expect(parseLobbyOpts({})).toEqual({});
    expect(parseLobbyOpts({ PLATFORM_MAX_ROOMS: '128', PLATFORM_SWEEP_ROOMS: '16' })).toEqual({
      maxRooms: 128,
      sweepRoomsPerPoll: 16,
    });
    expect(parseLobbyOpts({ PLATFORM_MAX_ROOMS: 'lots' })).toEqual({});
    expect(parseLobbyOpts({ PLATFORM_MAX_ROOMS: '0', PLATFORM_SWEEP_ROOMS: '-2' })).toEqual({});
    expect(parseLobbyOpts({ PLATFORM_MAX_ROOMS: '1.5' })).toEqual({});
  });

  it('default sweep visits EVERY room each poll (historical behavior locked)', () => {
    const { mod, staleOf } = makeStaleSpyModule('sweepdef');
    const lobby = new Lobby([mod]);
    tracked.push(lobby);
    const s1 = new FakeSession('s1');
    const s2 = new FakeSession('s2');
    createPrivateRoom(lobby, s1, 'sweepdef');
    createPrivateRoom(lobby, s2, 'sweepdef');
    const [roomA, roomB] = [...staleOf.keys()];
    if (roomA === undefined || roomB === undefined) throw new Error('expected two rooms');
    staleOf.set(roomA, ['s1']);
    staleOf.set(roomB, ['s2']);

    const closed = lobby.pollStaleSessions().map((s) => s.id).sort();

    expect(closed).toEqual(['s1', 's2']);
  });

  it('sweepRoomsPerPoll:1 rotates round-robin — one stale room per poll', () => {
    const { mod, staleOf } = makeStaleSpyModule('sweep1');
    const lobby = new Lobby([mod], null, { sweepRoomsPerPoll: 1 });
    tracked.push(lobby);
    const s1 = new FakeSession('s1');
    const s2 = new FakeSession('s2');
    createPrivateRoom(lobby, s1, 'sweep1');
    createPrivateRoom(lobby, s2, 'sweep1');
    const [roomA, roomB] = [...staleOf.keys()];
    if (roomA === undefined || roomB === undefined) throw new Error('expected two rooms');
    staleOf.set(roomA, ['s1']);
    staleOf.set(roomB, ['s2']);

    // First poll visits roomA only (insertion order, cursor starts at 0).
    expect(lobby.pollStaleSessions().map((s) => s.id)).toEqual(['s1']);
    // Cursor rotated: the second poll visits roomB.
    expect(lobby.pollStaleSessions().map((s) => s.id)).toEqual(['s2']);
  });

  it('kicked players are returned every poll even when their room is outside the slice', () => {
    const spy = makePadSpyModule('kicksweep');
    const lobby = new Lobby([spy.mod], null, { sweepRoomsPerPoll: 1 });
    tracked.push(lobby);
    createPrivateRoom(lobby, new FakeSession('a'), 'kicksweep');
    const victim = new FakeSession('victim');
    createPrivateRoom(lobby, victim, 'kicksweep'); // victim's room is second, outside slice 1
    spy.kickFromRoom('victim');

    expect(lobby.pollStaleSessions().map((s) => s.id)).toEqual(['victim']);
  });
});

// ---- P0-1 wire byte probe -----------------------------------------------------

describe('P0-1 wire byte probe', () => {
  let tracked: Lobby[] = [];

  afterEach(() => {
    for (const l of tracked) l.close();
    tracked = [];
  });

  /** FakeSession that reports a fixed frame length, like the real Session.send. */
  class MeteredSession extends FakeSession {
    constructor(id: PlayerId, private readonly frameBytes: number) {
      super(id);
    }

    override send(msg: S2C): number {
      super.send(msg);
      return this.frameBytes;
    }
  }

  it('room sends attribute bytes to the sender room (join hello + snapshot)', () => {
    const spy = makePadSpyModule('metergame');
    const lobby = new Lobby([spy.mod]);
    tracked.push(lobby);
    const p1 = new MeteredSession('p1', 42);
    lobby.handleMessage(asSession(p1), { t: 'quick_join', name: 'P1', game: 'metergame' });

    spy.io().send('p1', { t: 'snap' }); // one more attributed frame

    expect(lobby.wireStats()).toEqual({
      messages: 2, // padspy_hello on join + the snap above
      bytes: 84,
      rooms: [{ roomId: spy.roomIds[0], gameId: 'metergame', messages: 2, bytes: 84 }],
    });
  });

  it('void-send sessions and unknown ids never corrupt the meter', () => {
    const spy = makePadSpyModule('metergame');
    const lobby = new Lobby([spy.mod]);
    tracked.push(lobby);
    const plain = new FakeSession('plain'); // send returns void, like pre-P0-1
    lobby.handleMessage(asSession(plain), { t: 'quick_join', name: 'P', game: 'metergame' });
    spy.io().send('nobody', { t: 'snap' }); // no session at all

    expect(lobby.wireStats()).toEqual({ messages: 0, bytes: 0, rooms: [] });
  });

  it('closing a room drops its entry while cumulative totals survive', () => {
    const spy = makePadSpyModule('metergame');
    const lobby = new Lobby([spy.mod]);
    tracked.push(lobby);
    const p1 = new MeteredSession('p1', 42);
    lobby.handleMessage(asSession(p1), { t: 'create_private', name: 'P1', game: 'metergame' });
    expect(lobby.wireStats().rooms.length).toBe(1);

    lobby.handleMessage(asSession(p1), { t: 'leave' }); // empties the private room => closed

    const w = lobby.wireStats();
    expect(w.rooms).toEqual([]);
    expect(w.messages).toBe(1);
    expect(w.bytes).toBe(42);
  });

  it('resetWireStats zeroes totals and rooms', () => {
    const spy = makePadSpyModule('metergame');
    const lobby = new Lobby([spy.mod]);
    tracked.push(lobby);
    const p1 = new MeteredSession('p1', 42);
    lobby.handleMessage(asSession(p1), { t: 'quick_join', name: 'P1', game: 'metergame' });
    expect(lobby.wireStats().messages).toBe(1);

    lobby.resetWireStats();

    expect(lobby.wireStats()).toEqual({ messages: 0, bytes: 0, rooms: [] });
  });
});

// ---- P1 hosted authority ------------------------------------------------------
//
// Harness notes
// -------------
// - makeHostedSpyModule is a hostedAuthority game whose rooms record start(),
//   setHosted(), handleMessage traffic and addPlayer args — everything the
//   lease/election/relay/fallback tests observe. Rooms NEVER sim (no timers),
//   so hosted-vs-central is proven purely by which lifecycle calls ran.
// - Raw frames (host_snap, start, input) go into handleMessage as untyped
//   object literals — the black-box client view, same as the wire.
// - Lease timing tests run under vi.useFakeTimers (try/finally, the file's
//   established pattern); the lobby reads Date.now() everywhere, so advancing
//   time drives the watchdog deterministically.

describe('P1 hosted authority (lease, election, relay, fallback)', () => {
  let tracked: Lobby[] = [];

  afterEach(() => {
    for (const l of tracked) l.close();
    tracked = [];
  });

  interface HostedSpy {
    mod: GameModule;
    roomIds: RoomId[];
    started: RoomId[];
    hostedCalls: Array<{ roomId: RoomId; active: boolean }>;
    forwarded: Array<{ playerId: PlayerId; msg: unknown }>;
    added: Array<{ id: PlayerId; resume: PlayerId | undefined }>;
    staleOf: Map<RoomId, PlayerId[]>;
  }

  function makeHostedSpyModule(id: string, opts?: { hostedAuthority?: boolean; setHosted?: boolean }): HostedSpy {
    const roomIds: RoomId[] = [];
    const started: RoomId[] = [];
    const hostedCalls: Array<{ roomId: RoomId; active: boolean }> = [];
    const forwarded: Array<{ playerId: PlayerId; msg: unknown }> = [];
    const added: Array<{ id: PlayerId; resume: PlayerId | undefined }> = [];
    const staleOf = new Map<RoomId, PlayerId[]>();
    const withAuthority = opts?.hostedAuthority ?? true;
    const withSetHosted = opts?.setHosted ?? true;
    let n = 0;

    const base: GameModule = {
      id,
      name: id.toUpperCase(),
      clientDist: '',
      minPlayers: 1,
      maxPlayers: 8,
      createRoom(roomOpts) {
        const roomId: RoomId = `${id}-hosted-${n++}`;
        roomIds.push(roomId);
        staleOf.set(roomId, []);
        const members = new Set<PlayerId>();
        const room: GameRoomHandle = {
          id: roomId,
          info: () => ({
            id: roomId,
            code: null,
            game: id,
            label: '',
            players: members.size,
            maxPlayers: 8,
            phase: 'warmup',
            visibility: roomOpts.visibility,
          }),
          playerCount: () => members.size,
          stalePlayers: () => [...(staleOf.get(roomId) ?? [])],
          addPlayer: (playerId, _name, resume) => {
            members.add(playerId);
            added.push({ id: playerId, resume });
            roomOpts.io.send(playerId, { t: 'hosted_hello', roomId });
          },
          removePlayer: (playerId) => {
            members.delete(playerId);
          },
          handleMessage: (playerId, msg) => {
            forwarded.push({ playerId, msg });
          },
          start: () => {
            started.push(roomId);
          },
          stop: () => {},
        };
        if (withSetHosted) {
          room.setHosted = (active: boolean): void => {
            hostedCalls.push({ roomId, active });
          };
        }
        return room;
      },
    };
    const mod: GameModule = withAuthority ? { ...base, hostedAuthority: true } : base;
    return { mod, roomIds, started, hostedCalls, forwarded, added, staleOf };
  }

  /** FakeSession with a scripted RTT sample (0 = unmeasured, like a fresh socket). */
  class RttSession extends FakeSession {
    constructor(id: PlayerId, private readonly rtt: number) {
      super(id);
    }

    override rttMs(): number {
      return this.rtt;
    }
  }

  /** FakeSession reporting a fixed frame length (relay byte metering). */
  class FrameSession extends FakeSession {
    constructor(id: PlayerId, private readonly frameBytes: number) {
      super(id);
    }

    override send(msg: S2C): number {
      super.send(msg);
      return this.frameBytes;
    }
  }

  function createRoom(
    lobby: Lobby,
    sess: FakeSession,
    game: string,
    vis: 'create_public' | 'create_private',
    hosted: boolean | undefined,
  ): void {
    if (hosted === undefined) {
      lobby.handleMessage(asSession(sess), { t: vis, name: 'P', game });
    } else {
      lobby.handleMessage(asSession(sess), { t: vis, name: 'P', game, settings: { hosted } });
    }
  }

  function liveLeaseId(host: FakeSession): string {
    const lease = host.last('host_lease');
    if (lease === undefined) throw new Error('expected a host_lease for the holder');
    return lease.leaseId;
  }

  // ---- P1-1: contract + lease table ----

  it('first seat in a hosted room goes cold: setHosted(true), no start(), lease unicast + change broadcast', () => {
    const spy = makeHostedSpyModule('hostgame');
    const lobby = new Lobby([spy.mod]);
    tracked.push(lobby);
    const s1 = new FakeSession('s1');
    createRoom(lobby, s1, 'hostgame', 'create_private', true);

    expect(spy.started).toEqual([]); // the server sim NEVER runs here
    expect(spy.hostedCalls).toEqual([{ roomId: spy.roomIds[0], active: true }]);
    // No 'start' press was ever sent: the lease-on-first-seat IS the starter
    // pistol (aces law — auto-start preserved as a shim-triggered lease).
    const lease = s1.last('host_lease');
    expect(lease?.hostId).toBe('s1');
    expect(lease?.leaseId.length).toBe(12);
    expect(lease?.ttlMs).toBe(6000);
    expect(s1.last('host_change')).toEqual({ t: 'host_change', newHostId: 's1', resumeTick: 0 });
    expect(lobby.hostOf(spy.roomIds[0] ?? '')).toBe('s1');
  });

  it('no settings flag => central even for opted-in games (legacy rooms untouched)', () => {
    const spy = makeHostedSpyModule('hostgame');
    const lobby = new Lobby([spy.mod]);
    tracked.push(lobby);
    const s1 = new FakeSession('s1');
    createRoom(lobby, s1, 'hostgame', 'create_private', undefined);

    expect(spy.started).toEqual([spy.roomIds[0]]);
    expect(spy.hostedCalls).toEqual([]);
    expect(s1.last('host_lease')).toBeUndefined();
    expect(lobby.hostOf(spy.roomIds[0] ?? '')).toBeNull();
  });

  it('settings.hosted without setHosted on the room => central (explicit opt-in is not enough)', () => {
    const spy = makeHostedSpyModule('hostgame', { setHosted: false });
    const lobby = new Lobby([spy.mod]);
    tracked.push(lobby);
    const s1 = new FakeSession('s1');
    createRoom(lobby, s1, 'hostgame', 'create_private', true);

    expect(spy.started).toEqual([spy.roomIds[0]]);
    expect(lobby.hostOf(spy.roomIds[0] ?? '')).toBeNull();
  });

  it('module without the flag stays central even when settings ask hosted', () => {
    const spy = makeHostedSpyModule('hostgame', { hostedAuthority: false });
    const lobby = new Lobby([spy.mod]);
    tracked.push(lobby);
    const s1 = new FakeSession('s1');
    createRoom(lobby, s1, 'hostgame', 'create_private', true);

    expect(spy.started).toEqual([spy.roomIds[0]]);
    expect(spy.hostedCalls).toEqual([]);
    expect(lobby.hostOf(spy.roomIds[0] ?? '')).toBeNull();
  });

  it('valid host_renew pushes the expiry and records the tick (no promotion past the old TTL)', () => {
    vi.useFakeTimers();
    try {
      const spy = makeHostedSpyModule('hostgame');
      const lobby = new Lobby([spy.mod]);
      tracked.push(lobby);
      const s1 = new FakeSession('s1');
      const s2 = new FakeSession('s2');
      createRoom(lobby, s1, 'hostgame', 'create_public', true);
      lobby.handleMessage(asSession(s2), { t: 'quick_join', name: 'S2', game: 'hostgame' });
      const roomId = spy.roomIds[0] ?? '';
      const live = liveLeaseId(s1);

      vi.advanceTimersByTime(5000);
      lobby.handleMessage(asSession(s1), { t: 'host_renew', leaseId: live, tick: 42 });
      vi.advanceTimersByTime(5000); // T+10000: past the ORIGINAL T+6000 expiry
      lobby.pollStaleSessions();

      expect(lobby.hostOf(roomId)).toBe('s1');
      expect(countTag(s1, 'host_lease')).toBe(1); // no re-election happened
    } finally {
      vi.useRealTimers();
    }
  });

  it('renew with a stale leaseId earns host_revoked echoing the PRESENTED id (live id never revealed)', () => {
    const spy = makeHostedSpyModule('hostgame');
    const lobby = new Lobby([spy.mod]);
    tracked.push(lobby);
    const s1 = new FakeSession('s1');
    createRoom(lobby, s1, 'hostgame', 'create_private', true);
    const live = liveLeaseId(s1);

    lobby.handleMessage(asSession(s1), { t: 'host_renew', leaseId: 'STALELEASE01', tick: 9 });

    expect(s1.last('host_revoked')).toEqual({ t: 'host_revoked', leaseId: 'STALELEASE01' });
    expect(lobby.hostOf(spy.roomIds[0] ?? '')).toBe('s1'); // lease untouched
    expect('STALELEASE01' === live).toBe(false);
  });

  it('non-holder renew with the live id is revoked (holder check, not just id check)', () => {
    const spy = makeHostedSpyModule('hostgame');
    const lobby = new Lobby([spy.mod]);
    tracked.push(lobby);
    const s1 = new FakeSession('s1');
    const s2 = new FakeSession('s2');
    createRoom(lobby, s1, 'hostgame', 'create_public', true);
    lobby.handleMessage(asSession(s2), { t: 'quick_join', name: 'S2', game: 'hostgame' });
    const live = liveLeaseId(s1);

    lobby.handleMessage(asSession(s2), { t: 'host_renew', leaseId: live, tick: 3 });

    expect(s2.last('host_revoked')).toEqual({ t: 'host_revoked', leaseId: live });
    expect(lobby.hostOf(spy.roomIds[0] ?? '')).toBe('s1');
  });

  it('valid host_snap relays to members (never sender/room) and feeds the wire meter', () => {
    const spy = makeHostedSpyModule('hostgame');
    const lobby = new Lobby([spy.mod]);
    tracked.push(lobby);
    const s1 = new FakeSession('s1');
    const s2 = new FrameSession('s2', 50);
    createRoom(lobby, s1, 'hostgame', 'create_public', true);
    lobby.handleMessage(asSession(s2), { t: 'quick_join', name: 'S2', game: 'hostgame' });
    const live = liveLeaseId(s1);
    const snap = { t: 'host_snap', leaseId: live, tick: 7 };
    lobby.resetWireStats(); // join hellos were metered too — isolate the relay

    lobby.handleMessage(asSession(s1), snap);

    expect(s2.all().some((m) => m.t === 'host_snap')).toBe(true);
    expect(s1.all().some((m) => m.t === 'host_snap')).toBe(false); // no echo to the holder
    expect(spy.forwarded.some((f) => (f.msg as { t?: unknown }).t === 'host_snap')).toBe(false);
    const w = lobby.wireStats();
    expect(w.messages).toBe(1);
    expect(w.bytes).toBe(50);
    expect(w.rooms).toEqual([{ roomId: spy.roomIds[0], gameId: 'hostgame', messages: 1, bytes: 50 }]);
  });

  it('forged host_snap is dropped and the sender told to halt', () => {
    const spy = makeHostedSpyModule('hostgame');
    const lobby = new Lobby([spy.mod]);
    tracked.push(lobby);
    const s1 = new FakeSession('s1');
    const s2 = new FakeSession('s2');
    createRoom(lobby, s1, 'hostgame', 'create_public', true);
    lobby.handleMessage(asSession(s2), { t: 'quick_join', name: 'S2', game: 'hostgame' });
    const live = liveLeaseId(s1);

    lobby.handleMessage(asSession(s2), { t: 'host_snap', leaseId: live, tick: 7 }); // right id, wrong sender

    expect(s1.all().some((m) => m.t === 'host_snap')).toBe(false);
    expect(s2.last('host_revoked')).toEqual({ t: 'host_revoked', leaseId: live });
    expect(lobby.wireStats().messages).toBe(0);
  });

  it('host_snap in a central room dies silently and never reaches the room', () => {
    const spy = makeHostedSpyModule('hostgame');
    const lobby = new Lobby([spy.mod]);
    tracked.push(lobby);
    const s1 = new FakeSession('s1');
    createRoom(lobby, s1, 'hostgame', 'create_private', undefined); // central
    const before = spy.forwarded.length;

    lobby.handleMessage(asSession(s1), { t: 'host_snap', leaseId: 'WHATEVER01', tick: 1 });

    expect(spy.forwarded.length).toBe(before);
    expect(s1.all().some((m) => m.t === 'host_revoked')).toBe(false);
  });

  // ---- P1-2: shim-owned start (intents ride to the holder) ----

  it('player envelopes ride to the holder AND the room (start intents included)', () => {
    const spy = makeHostedSpyModule('hostgame');
    const lobby = new Lobby([spy.mod]);
    tracked.push(lobby);
    const s1 = new FakeSession('s1');
    const s2 = new FakeSession('s2');
    createRoom(lobby, s1, 'hostgame', 'create_public', true);
    lobby.handleMessage(asSession(s2), { t: 'quick_join', name: 'S2', game: 'hostgame' });

    lobby.handleMessage(asSession(s2), { t: 'start' });

    expect(s1.all().some((m) => m.t === 'start')).toBe(true); // the host sim decides
    expect(spy.forwarded.some((f) => f.playerId === 's2' && (f.msg as { t?: unknown }).t === 'start')).toBe(true);
  });

  it('holder mail is not echoed back to the holder', () => {
    const spy = makeHostedSpyModule('hostgame');
    const lobby = new Lobby([spy.mod]);
    tracked.push(lobby);
    const s1 = new FakeSession('s1');
    createRoom(lobby, s1, 'hostgame', 'create_private', true);

    lobby.handleMessage(asSession(s1), { t: 'input', seq: 1 });

    expect(s1.all().some((m) => m.t === 'input')).toBe(false);
    expect(spy.forwarded.some((f) => (f.msg as { t?: unknown }).t === 'input')).toBe(true);
  });

  // ---- P1-3: election + promotion + fallback ----

  it('standby is the lowest-RTT runner-up (proven by who promotes next)', () => {
    const spy = makeHostedSpyModule('hostgame');
    const lobby = new Lobby([spy.mod]);
    tracked.push(lobby);
    const s1 = new RttSession('s1', 0);
    const s2 = new RttSession('s2', 50);
    const s3 = new RttSession('s3', 10);
    createRoom(lobby, s1, 'hostgame', 'create_public', true);
    lobby.handleMessage(asSession(s2), { t: 'quick_join', name: 'S2', game: 'hostgame' });
    lobby.handleMessage(asSession(s3), { t: 'quick_join', name: 'S3', game: 'hostgame' });

    lobby.handleMessage(asSession(s1), { t: 'leave' }); // host loss => standby promotes NOW

    expect(lobby.hostOf(spy.roomIds[0] ?? '')).toBe('s3'); // rtt 10 beats rtt 50
    expect(s3.last('host_lease')?.hostId).toBe('s3');
  });

  it('RTT ties break to the longest-lived session', () => {
    const spy = makeHostedSpyModule('hostgame');
    const lobby = new Lobby([spy.mod]);
    tracked.push(lobby);
    const s1 = new RttSession('s1', 0);
    const s2 = new RttSession('s2', 10);
    const s3 = new RttSession('s3', 10);
    createRoom(lobby, s1, 'hostgame', 'create_public', true);
    lobby.handleMessage(asSession(s2), { t: 'quick_join', name: 'S2', game: 'hostgame' });
    lobby.handleMessage(asSession(s3), { t: 'quick_join', name: 'S3', game: 'hostgame' });

    lobby.handleMessage(asSession(s1), { t: 'leave' });

    expect(lobby.hostOf(spy.roomIds[0] ?? '')).toBe('s2'); // same rtt, older wins
  });

  it('measured RTT beats unmeasured 0 (a fresh socket never outranks a known link)', () => {
    const spy = makeHostedSpyModule('hostgame');
    const lobby = new Lobby([spy.mod]);
    tracked.push(lobby);
    const s1 = new RttSession('s1', 0);
    const s2 = new RttSession('s2', 0); // unmeasured
    const s3 = new RttSession('s3', 500); // slow but KNOWN
    createRoom(lobby, s1, 'hostgame', 'create_public', true);
    lobby.handleMessage(asSession(s2), { t: 'quick_join', name: 'S2', game: 'hostgame' });
    lobby.handleMessage(asSession(s3), { t: 'quick_join', name: 'S3', game: 'hostgame' });

    lobby.handleMessage(asSession(s1), { t: 'leave' });

    expect(lobby.hostOf(spy.roomIds[0] ?? '')).toBe('s3');
  });

  it('host leave promotes the standby synchronously: new bearer id, last tick resumes', () => {
    const spy = makeHostedSpyModule('hostgame');
    const lobby = new Lobby([spy.mod]);
    tracked.push(lobby);
    const s1 = new FakeSession('s1');
    const s2 = new FakeSession('s2');
    const s3 = new FakeSession('s3');
    createRoom(lobby, s1, 'hostgame', 'create_public', true);
    lobby.handleMessage(asSession(s2), { t: 'quick_join', name: 'S2', game: 'hostgame' });
    lobby.handleMessage(asSession(s3), { t: 'quick_join', name: 'S3', game: 'hostgame' });
    const oldId = liveLeaseId(s1);
    lobby.handleMessage(asSession(s1), { t: 'host_renew', leaseId: oldId, tick: 77 });

    lobby.handleMessage(asSession(s1), { t: 'leave' });

    expect(lobby.hostOf(spy.roomIds[0] ?? '')).toBe('s2');
    const rotated = liveLeaseId(s2);
    expect(rotated === oldId).toBe(false); // Bearer [REDACTED] rotates on every handover
    expect(s2.last('host_change')).toEqual({ t: 'host_change', newHostId: 's2', resumeTick: 77 });
    // Full handover proof: the new holder's snaps relay under the new id.
    lobby.handleMessage(asSession(s2), { t: 'host_snap', leaseId: rotated, tick: 78 });
    expect(s3.all().some((m) => m.t === 'host_snap')).toBe(true);
  });

  it('host disconnect (drop path) promotes too, session gone', () => {
    const spy = makeHostedSpyModule('hostgame');
    const lobby = new Lobby([spy.mod]);
    tracked.push(lobby);
    const s1 = new FakeSession('s1');
    const s2 = new FakeSession('s2');
    createRoom(lobby, s1, 'hostgame', 'create_public', true);
    lobby.handleMessage(asSession(s2), { t: 'quick_join', name: 'S2', game: 'hostgame' });

    lobby.handleDisconnect(asSession(s1));

    expect(lobby.hostOf(spy.roomIds[0] ?? '')).toBe('s2');
    expect(s2.last('host_lease')?.hostId).toBe('s2');
  });

  it('standby leave recomputes the runner-up (third member promotes next)', () => {
    const spy = makeHostedSpyModule('hostgame');
    const lobby = new Lobby([spy.mod]);
    tracked.push(lobby);
    const s1 = new RttSession('s1', 0);
    const s2 = new RttSession('s2', 10);
    const s3 = new RttSession('s3', 30);
    createRoom(lobby, s1, 'hostgame', 'create_public', true);
    lobby.handleMessage(asSession(s2), { t: 'quick_join', name: 'S2', game: 'hostgame' });
    lobby.handleMessage(asSession(s3), { t: 'quick_join', name: 'S3', game: 'hostgame' });

    lobby.handleMessage(asSession(s2), { t: 'leave' }); // standby gone
    expect(lobby.hostOf(spy.roomIds[0] ?? '')).toBe('s1'); // lease untouched
    lobby.handleMessage(asSession(s1), { t: 'leave' });

    expect(lobby.hostOf(spy.roomIds[0] ?? '')).toBe('s3');
  });

  it('stale host reaped by the sweep promotes the standby', () => {
    const spy = makeHostedSpyModule('hostgame');
    const lobby = new Lobby([spy.mod]);
    tracked.push(lobby);
    const s1 = new FakeSession('s1');
    const s2 = new FakeSession('s2');
    createRoom(lobby, s1, 'hostgame', 'create_public', true);
    lobby.handleMessage(asSession(s2), { t: 'quick_join', name: 'S2', game: 'hostgame' });
    spy.staleOf.set(spy.roomIds[0] ?? '', ['s1']);

    const closed = lobby.pollStaleSessions().map((s) => s.id);

    expect(closed).toEqual(['s1']);
    expect(lobby.hostOf(spy.roomIds[0] ?? '')).toBe('s2');
  });

  it('first unrenewed lapse promotes (no fallback yet) carrying the last tick', () => {
    vi.useFakeTimers();
    try {
      const spy = makeHostedSpyModule('hostgame');
      const lobby = new Lobby([spy.mod]);
      tracked.push(lobby);
      const s1 = new FakeSession('s1');
      const s2 = new FakeSession('s2');
      createRoom(lobby, s1, 'hostgame', 'create_public', true);
      lobby.handleMessage(asSession(s2), { t: 'quick_join', name: 'S2', game: 'hostgame' });
      lobby.handleMessage(asSession(s1), { t: 'host_renew', leaseId: liveLeaseId(s1), tick: 77 });

      vi.advanceTimersByTime(7000); // past the 6000ms TTL with no further renew
      lobby.pollStaleSessions();

      expect(lobby.hostOf(spy.roomIds[0] ?? '')).toBe('s2');
      expect(s2.last('host_change')).toEqual({ t: 'host_change', newHostId: 's2', resumeTick: 77 });
      expect(spy.started).toEqual([]); // lapses: 1 — still hosted
    } finally {
      vi.useRealTimers();
    }
  });

  it('second consecutive lapse falls back to central, sticky (room un-colds and sims)', () => {
    vi.useFakeTimers();
    try {
      const spy = makeHostedSpyModule('hostgame');
      const lobby = new Lobby([spy.mod]);
      tracked.push(lobby);
      const s1 = new FakeSession('s1');
      const s2 = new FakeSession('s2');
      createRoom(lobby, s1, 'hostgame', 'create_public', true);
      lobby.handleMessage(asSession(s2), { t: 'quick_join', name: 'S2', game: 'hostgame' });
      const roomId = spy.roomIds[0] ?? '';

      vi.advanceTimersByTime(7000);
      lobby.pollStaleSessions(); // lapse 1: s2 promoted, nobody renews
      expect(lobby.hostOf(roomId)).toBe('s2');
      vi.advanceTimersByTime(7000);
      lobby.pollStaleSessions(); // lapse 2: central

      expect(s2.last('host_change')).toEqual({ t: 'host_change', newHostId: null, resumeTick: 0 });
      expect(spy.hostedCalls.at(-1)).toEqual({ roomId, active: false });
      expect(spy.started).toEqual([roomId]); // the cold room starts simming
      expect(lobby.hostOf(roomId)).toBeNull();
      vi.advanceTimersByTime(30000);
      lobby.pollStaleSessions();
      expect(spy.started).toEqual([roomId]); // sticky: no re-election, no double start
      expect(lobby.hostOf(roomId)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('any valid renew resets the lapse counter (re-lapse promotes instead of falling back)', () => {
    vi.useFakeTimers();
    try {
      const spy = makeHostedSpyModule('hostgame');
      const lobby = new Lobby([spy.mod]);
      tracked.push(lobby);
      const s1 = new FakeSession('s1');
      const s2 = new FakeSession('s2');
      createRoom(lobby, s1, 'hostgame', 'create_public', true);
      lobby.handleMessage(asSession(s2), { t: 'quick_join', name: 'S2', game: 'hostgame' });
      const roomId = spy.roomIds[0] ?? '';

      vi.advanceTimersByTime(7000);
      lobby.pollStaleSessions(); // lapse 1: s2 promoted
      expect(lobby.hostOf(roomId)).toBe('s2');
      lobby.handleMessage(asSession(s2), { t: 'host_renew', leaseId: liveLeaseId(s2), tick: 5 }); // lapses: 0
      vi.advanceTimersByTime(7000);
      lobby.pollStaleSessions(); // lapse 1 again: promote, NOT central

      expect(lobby.hostOf(roomId)).toBe('s1');
      expect(spy.started).toEqual([]);
      expect(s1.last('host_change')).toEqual({ t: 'host_change', newHostId: 's1', resumeTick: 5 });
    } finally {
      vi.useRealTimers();
    }
  });

  // ---- P2-1: migration reuses the ghost/rebind path ----

  it('ex-host rebinds as an ordinary member (promotion never disturbs seats)', () => {
    const spy = makeHostedSpyModule('hostgame');
    const lobby = new Lobby([spy.mod]);
    tracked.push(lobby);
    const s1 = new FakeSession('s1');
    const s2 = new FakeSession('s2');
    createRoom(lobby, s1, 'hostgame', 'create_public', true);
    lobby.handleMessage(asSession(s2), { t: 'quick_join', name: 'S2', game: 'hostgame' });
    lobby.handleDisconnect(asSession(s1)); // host drops => s2 promoted
    expect(lobby.hostOf(spy.roomIds[0] ?? '')).toBe('s2');

    const s1b = new FakeSession('s1b');
    lobby.handleMessage(asSession(s1b), { t: 'quick_join', name: 'S1', game: 'hostgame', resume: 's1' });

    expect(spy.added.at(-1)).toEqual({ id: 's1b', resume: 's1' }); // rebind hint delivered
    expect(lobby.hostOf(spy.roomIds[0] ?? '')).toBe('s2'); // lease untouched by the rebind
    expect(s1b.last('host_lease')).toBeUndefined(); // ...as an ordinary member
  });
});

// ---- ghost-aware empty-room grace (double-drop no_room) ----------------------
// A private room whose members drop near-simultaneously used to be swept the
// instant the second socket died — both players' reseats then landed on
// no_room even though rebindable ghost seats were waiting. Rooms that keep
// ghosts now report hasRebindableSeats() and get the grace window instead.

describe('ghost-aware empty-room grace', () => {
  let tracked: Lobby[] = [];

  afterEach(() => {
    for (const l of tracked) l.close();
    tracked = [];
  });

  interface GhostSpy {
    mod: GameModule;
    ghosts: Set<PlayerId>;
    stops: number;
  }

  /** Private rooms with rift-like ghost semantics: a drop parks a ghost, an
   *  explicit leave deletes. When withHook is false the room omits
   *  hasRebindableSeats entirely (rooms that remove on drop). */
  function makeGhostSpyModule(id: string, withHook: boolean): GhostSpy {
    const ghosts = new Set<PlayerId>();
    const members = new Set<PlayerId>();
    const spy: GhostSpy = {
      ghosts,
      stops: 0,
      mod: {
        id,
        name: id.toUpperCase(),
        clientDist: '',
        minPlayers: 1,
        maxPlayers: 8,
        createRoom(opts) {
          const roomId: RoomId = `${id}-ghost`;
          const room: GameRoomHandle = {
            id: roomId,
            info: () => ({
              id: roomId,
              code: 'GHOST-1',
              game: id,
              label: '',
              players: members.size,
              maxPlayers: 8,
              phase: 'warmup',
              visibility: opts.visibility,
            }),
            playerCount: () => members.size,
            stalePlayers: () => [],
            addPlayer: (playerId) => {
              members.add(playerId);
              ghosts.delete(playerId);
            },
            removePlayer: (playerId, permanent) => {
              members.delete(playerId);
              if (permanent === true) ghosts.delete(playerId);
              else ghosts.add(playerId);
            },
            handleMessage: () => {},
            start: () => {},
            stop: () => {
              spy.stops += 1;
            },
          };
          if (withHook) room.hasRebindableSeats = () => ghosts.size > 0;
          return room;
        },
      },
    };
    return spy;
  }

  function createPrivateRoom(lobby: Lobby, sess: FakeSession, game: string): void {
    lobby.handleMessage(asSession(sess), { t: 'create_private', name: 'P', game });
  }

  it('a double drop keeps a ghost-bearing private room open and the reseat lands', () => {
    const spy = makeGhostSpyModule('ghostgame', true);
    const lobby = new Lobby([spy.mod]);
    tracked.push(lobby);
    const s1 = new FakeSession('g1');
    createPrivateRoom(lobby, s1, 'ghostgame');
    lobby.handleMessage(asSession(new FakeSession('g2')), {
      t: 'join_private',
      name: 'Q',
      code: 'GHOST-1',
    });
    expect(lobby.roomCount()).toBe(1);

    lobby.handleDisconnect(asSession(s1)); // drop, not leave: ghost parked
    lobby.handleDisconnect(asSession(new FakeSession('g2'))); // second drop: empty but ghost-bearing

    expect(spy.stops).toBe(0);
    expect(lobby.roomCount()).toBe(1); // grace, not a sweep

    const s3 = new FakeSession('g3');
    lobby.handleMessage(asSession(s3), { t: 'join_private', name: 'P', code: 'GHOST-1', resume: 'g1' });
    expect(s3.last('error')).toBeUndefined(); // landed — no no_room strand
    expect(lobby.roomCount()).toBe(1);
  });

  it('an explicit leave of every member still closes a private room immediately', () => {
    const spy = makeGhostSpyModule('ghostleave', true);
    const lobby = new Lobby([spy.mod]);
    tracked.push(lobby);
    const s1 = new FakeSession('g1');
    createPrivateRoom(lobby, s1, 'ghostleave');

    lobby.handleMessage(asSession(s1), { t: 'leave' }); // permanent: no ghost parked

    expect(spy.stops).toBe(1);
    expect(lobby.roomCount()).toBe(0);
  });

  it('rooms without the hook sweep exactly as before (absent => no ghosts)', () => {
    const spy = makeGhostSpyModule('noghost', false);
    const lobby = new Lobby([spy.mod]);
    tracked.push(lobby);
    const s1 = new FakeSession('g1');
    createPrivateRoom(lobby, s1, 'noghost');

    lobby.handleDisconnect(asSession(s1));

    expect(spy.stops).toBe(1);
    expect(lobby.roomCount()).toBe(0);
  });

  it('the reaper grants grace to ghost rooms but sweeps them once it expires', () => {
    vi.useFakeTimers();
    try {
      const spy = makeGhostSpyModule('ghostreap', true);
      const lobby = new Lobby([spy.mod]);
      tracked.push(lobby);
      const s1 = new FakeSession('r1');
      createPrivateRoom(lobby, s1, 'ghostreap');
      lobby.handleDisconnect(asSession(s1));
      expect(lobby.roomCount()).toBe(1);

      lobby.pollStaleSessions(); // immediate reaper pass: grace holds
      expect(spy.stops).toBe(0);
      expect(lobby.roomCount()).toBe(1);

      vi.setSystemTime(Date.now() + 31_000); // past PUBLIC_REAP_MS (30s)
      lobby.pollStaleSessions();
      expect(spy.stops).toBe(1);
      expect(lobby.roomCount()).toBe(0); // grace expired: natural reap, no leak
    } finally {
      vi.useRealTimers();
    }
  });

  it('end to end through the real ancients module: double drop, grace, resume rebinds', () => {
    const lobby = new Lobby([ANCIENTS]);
    tracked.push(lobby);
    const s1 = new FakeSession('r1');
    lobby.handleMessage(asSession(s1), { t: 'create_private', name: 'Ada', game: 'ancients' });
    const hello = s1.all().find((m) => m.t === 'rift_hello') as unknown as { code: unknown } | undefined;
    const code = hello?.code;
    if (typeof code !== 'string') throw new Error('expected rift_hello to carry the private code');

    lobby.handleMessage(asSession(new FakeSession('r2')), { t: 'join_private', name: 'Bob', code });
    expect(lobby.roomCount()).toBe(1);

    lobby.handleDisconnect(asSession(s1));
    lobby.handleDisconnect(asSession(new FakeSession('r2')));
    expect(lobby.roomCount()).toBe(1); // rift ghosts hold the room open

    const s3 = new FakeSession('r3');
    lobby.handleMessage(asSession(s3), { t: 'join_private', name: 'Ada', code, resume: 'r1' });
    expect(s3.last('error')).toBeUndefined();
    expect(s3.all().some((m) => m.t === 'rift_hello')).toBe(true); // rebound onto the ghost
  });
});
