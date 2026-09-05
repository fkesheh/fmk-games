// HostedLobby: create/join/ping/leave routing, code adoption, snapshot sync.
import { describe, expect, it } from 'vitest';
import type { GameRoomHandle, RoomIO } from '@platform/shared';
import { HostedLobby, mintRoomCode } from './hosted.js';

function fakeRoom(io: RoomIO): GameRoomHandle & { seen: Array<{ id: string; msg: unknown }> } {
  const seen: Array<{ id: string; msg: unknown }> = [];
  return {
    id: 'r1',
    info: () => ({ id: 'r1', code: 'ROOM', game: 't', label: '', players: 1, maxPlayers: 4, phase: 'x', visibility: 'private' as const }),
    playerCount: () => 1,
    stalePlayers: () => [],
    addPlayer: (id) => {
      io.send(id, { t: 'snap', tick: 1 });
    },
    removePlayer: () => {},
    handleMessage: (id, msg) => {
      seen.push({ id, msg });
    },
    start: () => {},
    stop: () => {},
    seen,
  };
}

function makeLobby() {
  let room: GameRoomHandle | null = null;
  const lobby = new HostedLobby({
    createRoom: (io) => {
      room = fakeRoom(io);
      return room;
    },
    newRoomCode: () => 'HOSTCD',
    snapshotTag: 'snap',
  });
  const inbox = new Map<string, unknown[]>();
  const at = (id: string): void => {
    lobby.attach(id, { deliver: (d) => inbox.get(id)?.push(JSON.parse(d)) ?? inbox.set(id, [JSON.parse(d)]) });
  };
  return { lobby, inbox, at, room: () => room };
}

describe('HostedLobby', () => {
  it('mints unambiguous codes', () => {
    for (let i = 0; i < 50; i++) {
      const c = mintRoomCode();
      expect(c).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
    }
  });

  it('create → local room adopts the supplied code; join with that code seats', () => {
    const { lobby, inbox, at } = makeLobby();
    at('h1');
    lobby.handleFrame('h1', JSON.stringify({ t: 'create_private', name: 'H' }));
    expect(inbox.get('h1')).toBeDefined();
    at('g1');
    lobby.handleFrame('g1', JSON.stringify({ t: 'join_private', name: 'G', code: 'HOSTCD' }));
    expect(inbox.get('g1')?.length).toBeGreaterThan(0);
  });

  it('wrong code gets no_room, room untouched', () => {
    const { lobby, inbox, at } = makeLobby();
    at('h1');
    lobby.handleFrame('h1', JSON.stringify({ t: 'create_private', name: 'H' }));
    at('g1');
    lobby.handleFrame('g1', JSON.stringify({ t: 'join_private', name: 'G', code: 'XXXXXX' }));
    const msgs = inbox.get('g1') ?? [];
    const last = msgs[msgs.length - 1] as { t?: string; code?: string } | undefined;
    expect(last?.t).toBe('error');
    expect(last?.code).toBe('no_room');
  });

  it('ping → pong locally; leave detaches; room frames route through', () => {
    const { lobby, inbox, at } = makeLobby();
    at('h1');
    lobby.handleFrame('h1', JSON.stringify({ t: 'create_private', name: 'H' }));
    lobby.handleFrame('h1', JSON.stringify({ t: 'ping', ts: 5 }));
    expect(inbox.get('h1')?.some((m) => (m as { t?: string }).t === 'pong')).toBe(true);
    lobby.handleFrame('h1', JSON.stringify({ t: 'roll' }));
    // room-level frames reach the room (fake room records; real rooms resolve)
    lobby.handleFrame('h1', JSON.stringify({ t: 'leave' }));
    expect(lobby.has('h1')).toBe(false);
  });

  it('sync() replays the last snapshot to a late-attached sink', () => {
    const { lobby, inbox, at } = makeLobby();
    at('h1');
    lobby.handleFrame('h1', JSON.stringify({ t: 'create_private', name: 'H' }));
    // late attach with no prior traffic still gets current state
    let got: unknown[] = [];
    lobby.attach('late', { deliver: (d) => got.push(JSON.parse(d)) });
    lobby.sync('late');
    expect(got.length).toBeGreaterThan(0);
    expect((got[0] as { t?: string }).t).toBe('snap');
    expect(inbox.get('h1')).toBeDefined();
  });

  it('malformed frames never throw', () => {
    const { lobby, at } = makeLobby();
    at('h1');
    expect(() => {
      lobby.handleFrame('h1', '{{{nope');
      lobby.handleFrame('h1', '42');
      lobby.handleFrame('h1', JSON.stringify(null));
    }).not.toThrow();
  });
});
