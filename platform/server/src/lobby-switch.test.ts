import { afterEach, describe, expect, it } from 'vitest';
import type { PlayerId, S2C } from '@platform/shared';
import type { KartS2C } from '@kart/shared';
import { Lobby } from './lobby.js';
import type { Session } from './net.js';
import { GAMES } from './registry.js';

// Room-switch coverage: the same session joins a public room, then creates a
// private one. The lobby must leave the old room (no ghost seat) and the new
// room's welcome must list exactly the joiner (no merged roster). Guards the
// kart e2e solo-roster shape at the unit level (server truth, no browser).

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
}

function asSession(s: FakeSession): Session {
  return s as unknown as Session;
}

const KART = (() => {
  const mod = GAMES.find((m) => m.id === 'kart');
  if (mod === undefined) throw new Error('no kart module registered');
  return mod;
})();

type KartJoined = Extract<KartS2C, { t: 'kart_joined' }>;

describe('room switch (public join then private create)', () => {
  let tracked: Lobby[] = [];
  afterEach(() => {
    for (const l of tracked) l.close();
    tracked = [];
  });

  it('leaves the public room and welcomes exactly the joiner to the private room', () => {
    const lobby = new Lobby([KART]);
    tracked.push(lobby);
    const sA = new FakeSession('sock-A');
    lobby.handleMessage(asSession(sA), { t: 'quick_join', name: 'Alice', game: 'kart' });
    lobby.handleMessage(asSession(sA), { t: 'create_private', name: 'Alice', game: 'kart' });
    const joined = sA.all().filter((m): m is KartJoined => m.t === 'kart_joined');
    expect(joined).toHaveLength(2);
    const pub = joined[0];
    const priv = joined[1];
    expect(pub?.code).toBeNull();
    expect(pub?.players).toHaveLength(1);
    expect(priv?.code).not.toBeNull();
    expect(priv?.players).toHaveLength(1);
    expect(priv?.roomId).not.toBe(pub?.roomId);
    const rooms = (
      lobby as unknown as { rooms: Map<string, { room: { playerCount(): number } }> }
    ).rooms;
    expect(rooms.get(pub?.roomId ?? '')?.room.playerCount()).toBe(0);
    expect(rooms.get(priv?.roomId ?? '')?.room.playerCount()).toBe(1);
  });
});
