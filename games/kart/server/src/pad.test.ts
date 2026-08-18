// ============================================================================
// KART pad (phone-as-controller) — the ROOM half of docs/PAD.md.
//
// The lobby half lives in platform/server/src/pad.test.ts; everything past the
// bind is kart protocol and is asserted here: token minting/TTL/single-use,
// control transfer, the seq-gate reset that makes two independent input
// streams interchangeable, echo, and every unbind path.
//
// Reading the assertions: "input was accepted" is proven by the {t:'pad_input'}
// ECHO, which the room emits only for inputs that cleared the monotonic seq
// gate. That makes the seq-gate tests self-proving — if a dropped stream had
// really been queued, the gate would have advanced and the next (lower-seq)
// input would produce no echo.
// ============================================================================
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COUNTDOWN_SECONDS, DEFAULT_TRACK_ID, INPUT_STALE_MS, READY_SECONDS, SIM_DT } from '@kart/shared';
import { PAD } from '@platform/shared';
import type { PlayerId, RoomIO } from '@platform/shared';
import { KartRoom } from './room.js';

class PadIO implements RoomIO {
  private readonly log = new Map<PlayerId, unknown[]>();
  send(id: PlayerId, msg: unknown): void {
    let msgs = this.log.get(id);
    if (msgs === undefined) {
      msgs = [];
      this.log.set(id, msgs);
    }
    msgs.push(structuredClone(msg));
  }
  rttMs(): number {
    return 0;
  }
  all(id: PlayerId): readonly unknown[] {
    return this.log.get(id) ?? [];
  }
  ofType(id: PlayerId, t: string): Record<string, unknown>[] {
    return this.all(id).filter(
      (m): m is Record<string, unknown> => typeof m === 'object' && m !== null && (m as { t?: unknown }).t === t,
    );
  }
  last(id: PlayerId, t: string): Record<string, unknown> | undefined {
    const all = this.ofType(id, t);
    return all[all.length - 1];
  }
}

const SEAT = 'p1';
const PAD_A = 'pad-a';
const PAD_B = 'pad-b';

function seat(io: PadIO, ids: PlayerId[] = [SEAT]): KartRoom {
  const room = new KartRoom(DEFAULT_TRACK_ID, 'public', io);
  ids.forEach((id, i) => room.addPlayer(id, `Driver${String(i + 1)}`));
  room.start();
  return room;
}

/** Mint a token for `id` and return it. */
function pair(room: KartRoom, io: PadIO, id: PlayerId = SEAT): string {
  room.handleMessage(id, { t: 'pad_pair_request' });
  const msg = io.last(id, 'pad_pair');
  if (msg === undefined) throw new Error('no pad_pair issued');
  return msg['token'] as string;
}

function input(seq: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  return { t: 'kart_input', seq, throttle: 1, brake: 0, steer: 0, drift: false, respawn: false, dt: SIM_DT, ...over };
}

let rooms: KartRoom[] = [];
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  for (const r of rooms) r.stop();
  rooms = [];
  vi.useRealTimers();
});
const track = (r: KartRoom): KartRoom => {
  rooms.push(r);
  return r;
};

describe('kart pad: pairing tokens', () => {
  it('pad_pair_request answers the REQUESTING seat with a token and its TTL', () => {
    const io = new PadIO();
    const room = track(seat(io));
    room.handleMessage(SEAT, { t: 'pad_pair_request' });

    const msg = io.last(SEAT, 'pad_pair');
    expect(msg).toBeDefined();
    expect(typeof msg?.['token']).toBe('string');
    expect(msg?.['expiresInMs']).toBe(PAD.tokenTtlMs);
    expect(msg?.['room']).toBe(room.id); // public room => roomId, not a code
  });

  it('a PRIVATE room hands the pad its join CODE, not the roomId', () => {
    const io = new PadIO();
    const room = track(new KartRoom(DEFAULT_TRACK_ID, 'private', io));
    room.addPlayer(SEAT, 'Driver1');
    room.start();
    room.handleMessage(SEAT, { t: 'pad_pair_request' });

    expect(io.last(SEAT, 'pad_pair')?.['room']).toBe(room.info().code);
  });

  it('rejects a token it never minted', () => {
    const io = new PadIO();
    const room = track(seat(io));
    expect(room.addPad(PAD_A, 'never-minted')).toBe(false);
  });

  it('a token is SINGLE-USE: the second bind with it is refused', () => {
    const io = new PadIO();
    const room = track(seat(io));
    const token = pair(room, io);

    expect(room.addPad(PAD_A, token)).toBe(true);
    expect(room.addPad(PAD_B, token)).toBe(false);
  });

  it('a token EXPIRES after PAD.tokenTtlMs', () => {
    const io = new PadIO();
    const room = track(seat(io));
    const token = pair(room, io);

    vi.advanceTimersByTime(PAD.tokenTtlMs + 1);

    expect(room.addPad(PAD_A, token)).toBe(false);
  });

  it('is still valid just BEFORE the TTL (the expiry is not off-by-one-eager)', () => {
    const io = new PadIO();
    const room = track(seat(io));
    const token = pair(room, io);

    vi.advanceTimersByTime(PAD.tokenTtlMs - 100);

    expect(room.addPad(PAD_A, token)).toBe(true);
  });

  it('a NEW pair request retires the seat’s previous unconsumed token', () => {
    const io = new PadIO();
    const room = track(seat(io));
    const first = pair(room, io);
    const second = pair(room, io);

    expect(second).not.toBe(first);
    expect(room.addPad(PAD_A, first)).toBe(false); // the QR on screen is the only one that works
    expect(room.addPad(PAD_A, second)).toBe(true);
  });

  it('a token dies with the seat that minted it', () => {
    const io = new PadIO();
    const room = track(seat(io, [SEAT, 'p2']));
    const token = pair(room, io);

    room.removePlayer(SEAT, true);

    expect(room.addPad(PAD_A, token)).toBe(false);
  });
});

describe('kart pad: bind + control transfer', () => {
  it('binding tells the pad who it drives and the seat that it is bound', () => {
    const io = new PadIO();
    const room = track(seat(io));
    expect(room.addPad(PAD_A, pair(room, io))).toBe(true);

    expect(io.last(PAD_A, 'pad_joined')?.['name']).toBe('Driver1');
    expect(io.last(SEAT, 'pad_status')?.['bound']).toBe(true);
  });

  it('while bound the SEAT’s own input is dropped and the PAD’s is accepted', () => {
    const io = new PadIO();
    const room = track(seat(io));
    room.addPad(PAD_A, pair(room, io));

    room.handleMessage(SEAT, input(5)); // desktop keystroke — must be ignored
    room.handleMessage(PAD_A, input(0)); // pad's counter starts at 0

    // The pad's seq 0 could only clear the gate if the seat's seq 5 never
    // entered it: proof of control transfer AND of the bind-time gate reset.
    const echoes = io.ofType(SEAT, 'pad_input');
    expect(echoes.length).toBe(1);
    expect((echoes[0]?.['input'] as Record<string, unknown>)['seq']).toBe(0);
  });

  it('the echo carries the exact input the room accepted', () => {
    const io = new PadIO();
    const room = track(seat(io));
    room.addPad(PAD_A, pair(room, io));

    room.handleMessage(PAD_A, input(1, { steer: 0.5, drift: true }));

    const echoed = io.last(SEAT, 'pad_input')?.['input'] as Record<string, unknown>;
    expect(echoed['steer']).toBe(0.5);
    expect(echoed['drift']).toBe(true);
    expect(echoed['seq']).toBe(1);
  });

  it('the pad stream is still monotonic: a replayed seq is dropped', () => {
    const io = new PadIO();
    const room = track(seat(io));
    room.addPad(PAD_A, pair(room, io));

    room.handleMessage(PAD_A, input(3));
    room.handleMessage(PAD_A, input(3));

    expect(io.ofType(SEAT, 'pad_input').length).toBe(1);
  });

  it('pad input counts as the SEAT’s liveness (the desktop stops emitting while bound)', () => {
    const io = new PadIO();
    const room = track(seat(io));
    room.addPad(PAD_A, pair(room, io));

    vi.advanceTimersByTime(INPUT_STALE_MS + 1000);
    expect(room.stalePlayers()).toContain(SEAT); // silent desktop, silent pad => stale

    room.handleMessage(PAD_A, input(1));
    expect(room.stalePlayers()).not.toContain(SEAT); // the phone is driving; do not evict
  });

  it('a pad never takes a seat', () => {
    const io = new PadIO();
    const room = track(seat(io));
    const before = room.playerCount();

    room.addPad(PAD_A, pair(room, io));

    expect(room.playerCount()).toBe(before);
    expect(room.info().players).toBe(before);
  });

  it('nitro follows control too: the seat’s is dropped, the pad’s fires', () => {
    const io = new PadIO();
    const room = track(seat(io, [SEAT, 'p2']));
    room.handleMessage(SEAT, { t: 'start' });
    vi.advanceTimersByTime((READY_SECONDS + COUNTDOWN_SECONDS) * 1000 + 500);
    expect(room.info().phase).toBe('racing');
    room.addPad(PAD_A, pair(room, io));

    const nitroEvents = (): unknown[] =>
      io.ofType(SEAT, 'race_event').filter((m) => (m['ev'] as { kind?: string }).kind === 'nitro');

    room.handleMessage(SEAT, { t: 'nitro' });
    expect(nitroEvents().length).toBe(0); // desktop no longer holds the button

    room.handleMessage(PAD_A, { t: 'nitro' });
    expect(nitroEvents().length).toBe(1);
  });
});

describe('kart pad: unbind', () => {
  it('pad disconnect returns control and resets the gate for the desktop', () => {
    const io = new PadIO();
    const room = track(seat(io));
    room.addPad(PAD_A, pair(room, io));
    room.handleMessage(PAD_A, input(900)); // pad drove the gate up high

    room.removePlayer(PAD_A);

    expect(io.last(SEAT, 'pad_status')?.['bound']).toBe(false);
    // The desktop resumes from ITS counter, which is far behind the pad's.
    room.handleMessage(SEAT, input(2));
    expect(io.ofType(SEAT, 'pad_input').length).toBe(1); // no echo for the seat's own input
    room.addPad(PAD_B, pair(room, io));
    room.handleMessage(PAD_B, input(0));
    expect(io.ofType(SEAT, 'pad_input').length).toBe(2); // ...and the gate reset again on rebind
  });

  it('replacement is ATOMIC for the seat: the old pad is told, the seat never sees bound:false', () => {
    const io = new PadIO();
    const room = track(seat(io));
    room.addPad(PAD_A, pair(room, io));

    room.addPad(PAD_B, pair(room, io));

    expect(io.last(PAD_A, 'pad_left')?.['reason']).toBe('replaced');
    const flicker = io.ofType(SEAT, 'pad_status').filter((m) => m['bound'] === false);
    expect(flicker).toEqual([]); // no intermediate unbind
    expect(io.ofType(SEAT, 'pad_status').length).toBe(2); // one per bind, both true
  });

  it('a replaced pad stops driving', () => {
    const io = new PadIO();
    const room = track(seat(io));
    room.addPad(PAD_A, pair(room, io));
    room.addPad(PAD_B, pair(room, io));

    room.handleMessage(PAD_A, input(50));

    expect(io.ofType(SEAT, 'pad_input')).toEqual([]);
  });

  it('when the seat leaves, its pad is told player_left', () => {
    const io = new PadIO();
    const room = track(seat(io, [SEAT, 'p2']));
    room.addPad(PAD_A, pair(room, io));

    room.removePlayer(SEAT, true);

    expect(io.last(PAD_A, 'pad_left')?.['reason']).toBe('player_left');
  });

  it('an orphaned pad cannot drive anyone', () => {
    const io = new PadIO();
    const room = track(seat(io, [SEAT, 'p2']));
    room.addPad(PAD_A, pair(room, io));
    room.removePlayer(SEAT, true);

    room.handleMessage(PAD_A, input(1));

    expect(io.ofType(SEAT, 'pad_input')).toEqual([]);
  });
});
