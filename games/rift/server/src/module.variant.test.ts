// ============================================================================
// riftModuleVariant tests (platform v2 port, docs/PLATFORM.md §7).
//
// SEAM: RiftRoom is MOCKED — the fake constructor captures the io the variant
// hands it (exactly the WRAPPED io whose send() carries the stats sink), and
// the fake handle records what survives the variant's pad-intercepting
// handleMessage(). No real room is ever constructed.
// ============================================================================
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GameRoomHandle, RoomIO } from '@platform/shared';

const state = vi.hoisted(() => ({
  /** The io the variant passed INTO the (mocked) room — the wrapped one. */
  wrappedIo: null as RoomIO | null,
  /** Messages that REACHED the inner room through the variant's wrapper. */
  roomMsgs: [] as Array<{ id: string; msg: unknown }>,
}));

vi.mock('./room.js', () => ({
  RiftRoom: class FakeRiftRoom implements GameRoomHandle {
    readonly id = 'r1';
    constructor(_visibility: unknown, io: RoomIO) {
      state.wrappedIo = io;
    }
    info(): import('@platform/shared').RoomInfo {
      return {
        id: 'r1', code: null, game: 'rift', label: '', players: 0,
        maxPlayers: 8, phase: 'lobby', visibility: 'public',
      };
    }
    playerCount(): number {
      return 1;
    }
    stalePlayers(): string[] {
      return [];
    }
    addPlayer(): void {}
    removePlayer(): void {}
    handleMessage(id: string, msg: unknown): void {
      state.roomMsgs.push({ id, msg });
    }
    start(): void {}
    stop(): void {}
  },
}));

import { riftModuleVariant } from './module.js';

interface FakeIo {
  io: RoomIO;
  report: Array<{ id: string; delta: Record<string, number> }>;
}

function fakeIo(profileIds: Record<string, string | null>): FakeIo {
  const report: Array<{ id: string; delta: Record<string, number> }> = [];
  const sent: Array<{ id: string; msg: unknown }> = [];
  const anyAuth = Object.values(profileIds).some((v) => v !== null);
  const io: RoomIO = {
    send: (id, msg) => {
      sent.push({ id, msg });
    },
    rttMs: () => 0,
    ...(anyAuth
      ? {
          profileId: (id: string) => profileIds[id] ?? '',
          reportStats: (id: string, delta: Record<string, number>) => {
            report.push({ id, delta });
          },
        }
      : {}),
      };
  return { io, report, sent };
}


/** Create a variant room against the mock; returns the intercepting handle + wrapped io. */
function setup(io: RoomIO): { room: GameRoomHandle; wrapped: RoomIO } {
  const mod = riftModuleVariant({ id: 'ancients' });
  const room = mod.createRoom({ visibility: 'private', io });
  if (state.wrappedIo === null) throw new Error('mocked RiftRoom never captured the wrapped io');
  return { room, wrapped: state.wrappedIo };
}

function ordersOf(handle: GameRoomHandle): Array<Record<string, unknown>> {
  void handle;
  return state.roomMsgs.filter((m) => (m.msg as Record<string, unknown>).t === 'rift_order')
    .map((m) => m.msg as Record<string, unknown>);
}
function castsOf(): Array<Record<string, unknown>> {
  return state.roomMsgs.filter((m) => (m.msg as Record<string, unknown>).t === 'rift_cast')
    .map((m) => m.msg as Record<string, unknown>);
}

const RIFT_END = {
  t: 'rift_end',
  winner: 'blue',
  reason: 'ancient',
  stats: [
    { id: 'p1', name: 'A', team: 'blue', kills: 3, deaths: 1 },
    { id: 'bot-9', name: 'Bot', team: 'blue', kills: 2, deaths: 4 },
    { id: 'p2', name: 'B', team: 'red', kills: 5, deaths: 2 },
  ],
} as const;

beforeEach(() => {
  state.wrappedIo = null;
  state.roomMsgs = [];
});

describe('riftModuleVariant stats sink', () => {
  it('credits kills/deaths to authenticated seats and win to winners only, via the WRAPPED io', () => {
    const f = fakeIo({ p1: 'prof-1', 'bot-9': null, p2: 'prof-2' });
    const { wrapped } = setup(f.io);
    expect(() => wrapped.send('p1', RIFT_END)).not.toThrow();

    // Stats credit by SEAT id — resolving seat→profile is the lobby's job
    // (RoomIO.reportStats contract), so the wrapper must forward seat ids.
    const flat = f.report.map((r) => `${r.id}:${JSON.stringify(r.delta)}`);
    expect(flat.some((x) => x.startsWith('p1:') && x.includes('"ancients.kill":3'))).toBe(true);
    expect(flat.some((x) => x.startsWith('p1:') && x.includes('"ancients.death":1'))).toBe(true);
    expect(flat.some((x) => x.startsWith('p1:') && x.includes('"ancients.win":1'))).toBe(true);
    // red seat: counters but NOT a win
    expect(flat.some((x) => x.startsWith('p2:') && x.includes('"ancients.win"'))).toBe(false);
    expect(flat.some((x) => x.startsWith('p2:') && x.includes('"ancients.kill":5'))).toBe(true);
    // anonymous/bot rows never credited
    expect(flat.filter((x) => x.startsWith('bot-9'))).toHaveLength(0);
  });

  it('no-ops cleanly on legacy io without v2 members', () => {
    const bare: RoomIO = { send: () => {}, rttMs: () => 0 };
    const { wrapped } = setup(bare);
    expect(() => wrapped.send('p1', RIFT_END)).not.toThrow();
    // the wrapper never invents members onto the caller's io
    expect(bare.profileId).toBeUndefined();
    expect(bare.reportStats).toBeUndefined();
  });

  it('delegates room verbs and forwards non-pad messages untouched', () => {
    const f = fakeIo({});
    const { room } = setup(f.io);
    room.handleMessage('p1', { t: 'rift_pick', hero: 'brannoc' });
    room.addPlayer('p1', 'A');
    expect(state.roomMsgs).toHaveLength(1);
    expect(room.playerCount()).toBe(1);
  });
});

describe('riftModuleVariant pad adapter', () => {
  function snap(x: number, z: number): unknown {
    return {
      t: 'rift_snap',
      tick: 1,
      ents: [{ id: 7, k: 'hero', team: 'blue', pid: 'h1', x, z, hp: 100, maxHp: 100 }],
    };
  }

  it('translates stick deflection into one move order at the tracked position', () => {
    const f = fakeIo({ h1: 'prof-hero' });
    const { room, wrapped } = setup(f.io);
    // Frozen handshake: pair_request -> wrapper-minted code -> addPad binds.
    room.handleMessage('h1', { t: 'pad_pair_request' }); // the SEAT pairs its own controller
    const code = (f.sent.find((x) => (x.msg as {t?:string}).t === 'pad_pair')!.msg as {token:string}).token;
    expect(room.addPad!('pad-1', code)).toBe(true);
    wrapped.send('h1', snap(10, 20)); // wrapper learns the hero position
    room.handleMessage('pad-1', { t: 'pad_input', seq: 1, lx: 0.8, ly: -0.6, rx: 0, ry: 0, buttons: 0 });

    const orders = ordersOf(room);
    expect(orders).toHaveLength(1);
    expect(orders[0]!.kind).toBe('move');
    expect(orders[0]!.x).toBeCloseTo(10 + 0.8 * 6, 5);
    expect(orders[0]!.z).toBeCloseTo(20 - 0.6 * 6, 5);
    // and every synthesized order reported its stat
    expect(f.report).toEqual([{ id: 'h1', delta: { 'ancients.pad_order': 1 } }]);
  });

  it('throttles to ~8Hz and needs position + deadzone clearance', () => {
    const f = fakeIo({ h1: 'prof-hero' });
    const { room, wrapped } = setup(f.io);
    room.handleMessage('h1', { t: 'pad_pair_request' }); // the SEAT pairs its own controller
    const code = (f.sent.find((x) => (x.msg as { t?: string }).t === 'pad_pair')!.msg as { token: string }).token;
    expect(room.addPad!('pad-1', code)).toBe(true);
    wrapped.send('h1', snap(0, 0));

    // below deadzone: nothing
    room.handleMessage('pad-1', { t: 'pad_input', seq: 1, lx: 0.2, ly: 0.2, rx: 0, ry: 0, buttons: 0 });
    expect(ordersOf(room)).toHaveLength(0);

    // first real deflection fires; an immediate repeat is throttled away
    room.handleMessage('pad-1', { t: 'pad_input', seq: 2, lx: 0.9, ly: 0, rx: 0, ry: 0, buttons: 0 });
    room.handleMessage('pad-1', { t: 'pad_input', seq: 3, lx: 0.9, ly: 0, rx: 0, ry: 0, buttons: 0 });
    expect(ordersOf(room)).toHaveLength(1);

    // a second pad session bound to NOBODY emits nothing (per-pad timers are
    // independent by design — padOwner returns null for it here)
    room.handleMessage('pad-2', { t: 'pad_input', seq: 1, lx: 1, ly: 0, rx: 0, ry: 0, buttons: 0 });
    expect(ordersOf(room)).toHaveLength(1);
  }, 10_000);

  it('casts once per button EDGE at the hero feet', () => {
    const f = fakeIo({ h1: 'prof-hero' });
    const { room, wrapped } = setup(f.io);
    room.handleMessage('h1', { t: 'pad_pair_request' }); // the SEAT pairs its own controller
    const code = (f.sent.find((x) => (x.msg as { t?: string }).t === 'pad_pair')!.msg as { token: string }).token;
    expect(room.addPad!('pad-1', code)).toBe(true);
    wrapped.send('h1', snap(-3, 4));
    room.handleMessage('pad-1', { t: 'pad_input', seq: 1, lx: 0, ly: 0, rx: 0, ry: 0, buttons: 0b001 }); // press bit0
    room.handleMessage('pad-1', { t: 'pad_input', seq: 2, lx: 0, ly: 0, rx: 0, ry: 0, buttons: 0b001 }); // held
    room.handleMessage('pad-1', { t: 'pad_input', seq: 3, lx: 0, ly: 0, rx: 0, ry: 0, buttons: 0b101 }); // bit2 edge

    const casts = castsOf();
    expect(casts.map((c) => c.slot)).toEqual([0, 2]);
    expect(casts[0]!.x).toBeCloseTo(-3, 5);
    expect(casts[0]!.z).toBeCloseTo(4, 5);
  }, 10_000);

  it('drops unbound pad sessions without touching the room', () => {
    const f = fakeIo({ h1: 'prof-hero' }, () => null);
    const { room } = setup(f.io);
    room.handleMessage('pad-x', { t: 'pad_input', seq: 1, lx: 1, ly: 0, rx: 0, ry: 0, buttons: 0 });
    expect(state.roomMsgs).toHaveLength(0);
  });

  it('declares the phone-pad layout the /pad page renders', () => {
    const mod = riftModuleVariant({ id: 'ancients' });
    expect(mod.padLayout).toBeDefined();
    expect(mod.padLayout?.sticks.map((s) => s.id)).toEqual(['l']);
    expect(mod.padLayout?.buttons.map((b) => b.bit)).toEqual([0, 1, 2]);
  });
});
