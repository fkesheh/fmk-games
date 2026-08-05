// ============================================================================
// ANCIENTS (rift) — QUICK-JOIN regression tests. The reported defect: "only
// one person can join; it doesn't wait for other people". Root cause (proven
// with scripts/repro-quickjoin2.mjs before the fix): the platform lobby's
// quick_join PREFERS public rooms whose info().phase is 'warmup'
// (platform/server/src/lobby.ts findPublicRoom), and rift reported its
// pre-match phase as 'lobby' — so the preference never matched a waiting
// rift lobby and quick-joiners were routed into an older IN-PROGRESS room
// (or, without the fallback, each into their own fresh room).
//
// These tests replicate the platform's matching predicate verbatim (mirrored,
// never imported — lobby.ts is platform code and Layer-1 is frozen) and run
// it against rift's real info() output.
// ============================================================================
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlayerId, RoomIO } from '@platform/shared';
import type { GameRoomHandle } from '@platform/shared';
import { RiftRoom } from './room.js';

/** Mirrored from platform/server/src/lobby.ts findPublicRoom (2026-08): the
 *  exact predicate quick_join runs, phase preference and all. */
function findPublicRoom(
  rooms: readonly GameRoomHandle[],
  gameId: string,
  phase: 'warmup' | null,
): GameRoomHandle | undefined {
  for (const room of rooms) {
    const info = room.info();
    if (info.game !== gameId || info.visibility !== 'public' || room.playerCount() >= info.maxPlayers) continue;
    if (phase !== null && info.phase !== phase) continue;
    return room;
  }
  return undefined;
}

/** Mirrored quick_join selection: prefer 'warmup', fall back to any space. */
function quickJoinPick(rooms: readonly GameRoomHandle[]): GameRoomHandle | undefined {
  return findPublicRoom(rooms, 'rift', 'warmup') ?? findPublicRoom(rooms, 'rift', null);
}

class FakeIO implements RoomIO {
  readonly sent: Array<[PlayerId, unknown]> = [];
  send(id: PlayerId, msg: unknown): void {
    this.sent.push([id, msg]);
  }
  rttMs(): number {
    return 0;
  }
}

const tracked: RiftRoom[] = [];

function makeRoom(): RiftRoom {
  const room = new RiftRoom('public', new FakeIO(), {}, { rand: () => 0 });
  room.start();
  tracked.push(room);
  return room;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  for (const r of tracked) r.stop();
  tracked.length = 0;
  vi.useRealTimers();
});

describe('quick-join matching (platform predicate vs rift info())', () => {
  it('two quick-join-equivalent matchers land in ONE room', () => {
    // matcher A finds nothing and creates; matcher B's predicate must then
    // FIND A's waiting lobby via the 'warmup' preference — the regression
    const room = makeRoom();
    room.addPlayer('pA', 'Ada');
    expect(room.info().phase).toBe('warmup');
    const found = quickJoinPick([room]);
    expect(found).toBe(room);
    found?.addPlayer('pB', 'Bob');
    expect(room.playerCount()).toBe(2); // both humans in the SAME room
  });

  it('quick-join prefers a WAITING lobby over an in-progress room', () => {
    const live = makeRoom();
    live.addPlayer('pA', 'Ada');
    live.handleMessage('pA', { t: 'rift_start' });
    vi.advanceTimersToNextTimer(); // countdown -> lock; the room goes live
    expect(live.info().phase).toBe('live');

    const waiting = makeRoom();
    waiting.addPlayer('pC', 'Cy');

    // rooms map iteration order: the live room was created first — only a
    // working 'warmup' preference routes the joiner to the waiting lobby
    expect(quickJoinPick([live, waiting])).toBe(waiting);
  });

  it('a live room still admits a late joiner (fallback + bot displacement)', () => {
    const live = makeRoom();
    live.addPlayer('pA', 'Ada');
    live.handleMessage('pA', { t: 'rift_start' });
    vi.advanceTimersToNextTimer();
    expect(live.info().phase).toBe('live');

    // the fallback (phase === null) must still match the live room: it has
    // connected-human space even though every seat is filled
    expect(quickJoinPick([live])).toBe(live);
    const seatsBefore = live.info().players;
    live.addPlayer('pB', 'Bob'); // displaces the oldest bot, inherits its hero
    expect(live.playerCount()).toBe(2);
    expect(live.info().players).toBe(seatsBefore); // a bot seat became human
  });
});
