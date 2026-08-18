// ============================================================================
// PAD join handshake — the LOBBY half of docs/PAD.md.
//
// The lobby owns exactly three decisions here and nothing else: resolve the
// room reference (a QR carries either a public roomId or a private code, and
// the pad page cannot know which), answer 'pad_unsupported' without knowing
// which games have pads, and route the session's later messages to the room
// once the ROOM has accepted the token. Token validity is deliberately NOT a
// lobby concern — tokens are game state the room minted.
//
// Harness: a stub GameModule whose room records every call. `asSession` is the
// same `unknown` round-trip lobby.test.ts uses (Session has private fields).
// ============================================================================
import { afterEach, describe, expect, it } from 'vitest';
import type {
  GameModule,
  GameRoomHandle,
  PlayerId,
  RoomInfo,
  RoomIO,
  S2C,
  Visibility,
} from '@platform/shared';
import type { C2S } from '@platform/shared';
import { Lobby } from './lobby.js';
import type { Session } from './net.js';

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
  errorCode(): string | undefined {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const m = this.messages[i];
      if (m !== undefined && m.t === 'error') return (m as unknown as { code: string }).code;
    }
    return undefined;
  }
  count(): number {
    return this.messages.length;
  }
}

function asSession(s: FakeSession): Session {
  return s as unknown as Session;
}

interface StubRoom extends GameRoomHandle {
  readonly padCalls: { id: PlayerId; token: string }[];
  readonly roomMsgs: { id: PlayerId; msg: unknown }[];
  readonly addedPlayers: PlayerId[];
  readonly removed: { id: PlayerId; permanent: boolean | undefined }[];
}

/** `pads: false` omits addPad entirely — that absence IS 'pad_unsupported'. */
function makeModule(opts: { pads: boolean; accept: boolean; visibility: Visibility; code: string | null }): {
  mod: GameModule;
  rooms: StubRoom[];
} {
  const rooms: StubRoom[] = [];
  const mod: GameModule = {
    id: 'stub',
    name: 'Stub',
    clientDist: '/dev/null',
    minPlayers: 1,
    maxPlayers: 4,
    createRoom({ io }: { visibility: Visibility; io: RoomIO }): GameRoomHandle {
      const padCalls: { id: PlayerId; token: string }[] = [];
      const roomMsgs: { id: PlayerId; msg: unknown }[] = [];
      const addedPlayers: PlayerId[] = [];
      const removed: { id: PlayerId; permanent: boolean | undefined }[] = [];
      const seats = new Set<PlayerId>();
      const base = {
        id: `room-${String(rooms.length)}`,
        padCalls,
        roomMsgs,
        addedPlayers,
        removed,
        info: (): RoomInfo => ({
          id: base.id,
          code: opts.code,
          game: 'stub',
          label: 'stub',
          players: seats.size,
          maxPlayers: 4,
          phase: 'lobby',
          visibility: opts.visibility,
        }),
        playerCount: () => seats.size,
        stalePlayers: () => [],
        addPlayer: (id: PlayerId) => {
          addedPlayers.push(id);
          seats.add(id);
        },
        removePlayer: (id: PlayerId, permanent?: boolean) => {
          removed.push({ id, permanent });
          seats.delete(id);
        },
        handleMessage: (id: PlayerId, msg: unknown) => {
          roomMsgs.push({ id, msg });
        },
        start: () => {},
        stop: () => {},
        ...(opts.pads
          ? {
              addPad: (id: PlayerId, token: string): boolean => {
                padCalls.push({ id, token });
                if (opts.accept) io.send(id, { t: 'pad_joined', name: 'seat' });
                return opts.accept;
              },
            }
          : {}),
      };
      const room = base as unknown as StubRoom;
      rooms.push(room);
      return room;
    },
  };
  return { mod, rooms };
}

/** Creates one room by seating a host, then returns the room. */
function seatHost(lobby: Lobby, rooms: StubRoom[], visibility: Visibility): StubRoom {
  const host = new FakeSession('host');
  lobby.handleMessage(
    asSession(host),
    { t: visibility === 'private' ? 'create_private' : 'create_public', name: 'Host', game: 'stub' } as unknown as C2S,
  );
  const room = rooms[0];
  if (room === undefined) throw new Error('no room created');
  return room;
}

const padJoin = (room: string, token: string): C2S => ({ t: 'join_as_pad', room, token }) as unknown as C2S;

describe('lobby: join_as_pad', () => {
  let tracked: Lobby[] = [];
  const track = (l: Lobby): Lobby => {
    tracked.push(l);
    return l;
  };
  afterEach(() => {
    for (const l of tracked) l.close();
    tracked = [];
  });

  it('routes a public roomId to the room’s addPad and binds on true', () => {
    const { mod, rooms } = makeModule({ pads: true, accept: true, visibility: 'public', code: null });
    const lobby = track(new Lobby([mod]));
    const room = seatHost(lobby, rooms, 'public');

    const pad = new FakeSession('pad-1');
    lobby.handleMessage(asSession(pad), padJoin(room.id, 'tok-abc'));

    expect(room.padCalls).toEqual([{ id: 'pad-1', token: 'tok-abc' }]);
    expect(pad.errorCode()).toBeUndefined();
  });

  it('resolves a PRIVATE join code, case-insensitively (the QR carries either)', () => {
    const { mod, rooms } = makeModule({ pads: true, accept: true, visibility: 'private', code: 'ABCD' });
    const lobby = track(new Lobby([mod]));
    seatHost(lobby, rooms, 'private');

    const pad = new FakeSession('pad-1');
    lobby.handleMessage(asSession(pad), padJoin('abcd', 'tok'));

    expect(rooms[0]?.padCalls.length).toBe(1);
    expect(pad.errorCode()).toBeUndefined();
  });

  it('answers no_room for an unknown reference, without touching any room', () => {
    const { mod, rooms } = makeModule({ pads: true, accept: true, visibility: 'public', code: null });
    const lobby = track(new Lobby([mod]));
    const room = seatHost(lobby, rooms, 'public');

    const pad = new FakeSession('pad-1');
    lobby.handleMessage(asSession(pad), padJoin('nope', 'tok'));

    expect(pad.errorCode()).toBe('no_room');
    expect(room.padCalls).toEqual([]);
  });

  it('answers pad_unsupported when the game has no addPad', () => {
    const { mod, rooms } = makeModule({ pads: false, accept: true, visibility: 'public', code: null });
    const lobby = track(new Lobby([mod]));
    const room = seatHost(lobby, rooms, 'public');

    const pad = new FakeSession('pad-1');
    lobby.handleMessage(asSession(pad), padJoin(room.id, 'tok'));

    expect(pad.errorCode()).toBe('pad_unsupported');
  });

  it('answers pad_rejected when the ROOM refuses the token', () => {
    const { mod, rooms } = makeModule({ pads: true, accept: false, visibility: 'public', code: null });
    const lobby = track(new Lobby([mod]));
    const room = seatHost(lobby, rooms, 'public');

    const pad = new FakeSession('pad-1');
    lobby.handleMessage(asSession(pad), padJoin(room.id, 'stale'));

    expect(room.padCalls.length).toBe(1); // the room got its say
    expect(pad.errorCode()).toBe('pad_rejected');
  });

  it('a bound pad is NOT a player: no addPlayer, no seat', () => {
    const { mod, rooms } = makeModule({ pads: true, accept: true, visibility: 'public', code: null });
    const lobby = track(new Lobby([mod]));
    const room = seatHost(lobby, rooms, 'public');
    const seatsBefore = room.playerCount();

    lobby.handleMessage(asSession(new FakeSession('pad-1')), padJoin(room.id, 'tok'));

    expect(room.addedPlayers).not.toContain('pad-1');
    expect(room.playerCount()).toBe(seatsBefore);
  });

  it('routes the pad’s later room-level messages to the room', () => {
    const { mod, rooms } = makeModule({ pads: true, accept: true, visibility: 'public', code: null });
    const lobby = track(new Lobby([mod]));
    const room = seatHost(lobby, rooms, 'public');
    const pad = new FakeSession('pad-1');
    lobby.handleMessage(asSession(pad), padJoin(room.id, 'tok'));

    lobby.handleMessage(asSession(pad), { t: 'kart_input', seq: 1 } as unknown as C2S);

    expect(room.roomMsgs).toContainEqual({ id: 'pad-1', msg: { t: 'kart_input', seq: 1 } });
  });

  it('a REJECTED pad is not routed anywhere afterwards', () => {
    const { mod, rooms } = makeModule({ pads: true, accept: false, visibility: 'public', code: null });
    const lobby = track(new Lobby([mod]));
    const room = seatHost(lobby, rooms, 'public');
    const pad = new FakeSession('pad-1');
    lobby.handleMessage(asSession(pad), padJoin(room.id, 'stale'));

    lobby.handleMessage(asSession(pad), { t: 'kart_input', seq: 1 } as unknown as C2S);

    expect(room.roomMsgs).toEqual([]);
  });

  it('pad disconnect reaches the room as removePlayer(padId) — the unbind hook', () => {
    const { mod, rooms } = makeModule({ pads: true, accept: true, visibility: 'public', code: null });
    const lobby = track(new Lobby([mod]));
    const room = seatHost(lobby, rooms, 'public');
    const pad = new FakeSession('pad-1');
    lobby.handleMessage(asSession(pad), padJoin(room.id, 'tok'));

    lobby.handleDisconnect(asSession(pad));

    expect(room.removed.some((r) => r.id === 'pad-1')).toBe(true);
  });
});
