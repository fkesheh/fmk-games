// ============================================================================
// BANK room tests — every invariant from docs/BANK.md "Tests", driven straight
// against BankRoom over a fake RoomIO. vi fake timers also freeze Date.now, so
// the room's per-roll stream rng(Date.now() ^ (rollCounter * 2654435761)) is
// deterministic. Wanted dice outcomes are located by probing a throwaway room
// at candidate times, then replayed verbatim in the real room: same
// construction + same roll times + same roll history => same seeds => same
// dice, regardless of how the room counts rolls internally.
// ============================================================================
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MATCH_RESET_SECONDS,
  MAX_PLAYERS,
  ROUND_END_SECONDS,
  SAFE_ROLLS,
  SEVEN_BONUS,
  TOTAL_ROUNDS,
  TURN_SECONDS,
} from '@bank/shared';
import type { BankEvent, BankPlayerState, BankState } from '@bank/shared';
import type { PlayerId, RoomIO } from '@platform/shared';
import { BankRoom } from './room.js';

/** Wire shape: fresh per-recipient state, or one shared event envelope. */
type EventEnvelope = { t: 'event'; ev: BankEvent };
type BankMsg = BankState | EventEnvelope;
type RollMsg = Extract<BankEvent, { t: 'roll' }>;

const TURN_MS = TURN_SECONDS * 1000;
const ROUND_END_MS = ROUND_END_SECONDS * 1000;
const MATCH_RESET_MS = MATCH_RESET_SECONDS * 1000;
const EPOCH = 1_700_000_000_000; // fixed fake-clock origin: full determinism

// ---- fake RoomIO -------------------------------------------------------------
// Every message the room emits is captured per player through structuredClone:
// state objects may be reused/mutated by the room between actions, and history
// must stay stable for assertions.

function isBankMsg(msg: unknown): msg is BankMsg {
  if (typeof msg !== 'object' || msg === null) return false;
  const t = (msg as { t?: unknown }).t;
  if (t === 'bank_state') return true;
  if (t !== 'event') return false;
  const ev = (msg as { ev?: unknown }).ev;
  return typeof ev === 'object' && ev !== null && typeof (ev as { t?: unknown }).t === 'string';
}

class FakeIO implements RoomIO {
  private readonly log = new Map<PlayerId, BankMsg[]>();

  send(id: PlayerId, msg: unknown): void {
    if (!isBankMsg(msg)) throw new Error(`unexpected message for ${id}: ${JSON.stringify(msg)}`);
    const msgs = this.log.get(id) ?? [];
    msgs.push(structuredClone(msg));
    this.log.set(id, msgs);
  }

  rttMs(): number {
    return 0;
  }

  all(id: PlayerId): BankMsg[] {
    return this.log.get(id) ?? [];
  }

  /** Most recent bank_state a player received (every action re-broadcasts it). */
  state(id: PlayerId): BankState {
    const msgs = this.all(id);
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m !== undefined && m.t === 'bank_state') return m;
    }
    throw new Error(`no bank_state captured for ${id}`);
  }

  events<T extends BankEvent['t']>(id: PlayerId, t: T): Array<Extract<BankEvent, { t: T }>> {
    return this.all(id)
      .filter((m): m is EventEnvelope => m.t === 'event')
      .map((m) => m.ev)
      .filter((ev): ev is Extract<BankEvent, { t: T }> => ev.t === t);
  }
}

// ---- drive helpers -----------------------------------------------------------

function player(st: BankState, id: PlayerId): BankPlayerState {
  const p = st.players.find((pl) => pl.id === id);
  if (p === undefined) throw new Error(`no player ${id} in state`);
  return p;
}

/** Rooms stopped in afterEach (the turn timer must be cleared per contract). */
const tracked: BankRoom[] = [];

function boot(io: FakeIO, players: ReadonlyArray<readonly [PlayerId, string]>): BankRoom {
  const room = new BankRoom('public', io);
  room.start(); // idempotent per the platform contract
  for (const [id, name] of players) room.addPlayer(id, name);
  room.start(); // covers either start/add ordering
  tracked.push(room);
  return room;
}

/**
 * Roll from whoever currently holds the turn, at fake time t. `via` is any
 * connected player used to read state/events (events are broadcast to all).
 */
function rollAt(room: BankRoom, io: FakeIO, t: number, via: PlayerId = 'p1'): RollMsg {
  const cur = io.state(via).currentId;
  if (cur === null) throw new Error('no current player to roll for');
  const before = io.events(via, 'roll').length;
  vi.setSystemTime(t);
  room.handleMessage(cur, { t: 'roll' });
  const evs = io.events(via, 'roll');
  const ev = evs[evs.length - 1];
  if (evs.length === before || ev === undefined) throw new Error(`roll at ${t} produced no event`);
  return ev;
}

// ---- seeded-time search ------------------------------------------------------
// The dice for a roll depend only on Date.now() and the room's roll history
// (the frozen per-roll rng formula). A probe room built and rolled exactly
// like the real one sees identical dice, so scan candidate times in probes
// until the wanted outcome appears, then replay that time in the real room.
// Probe histories stay inside the safe window, which can never bust.

function probeOutcome(history: ReadonlyArray<number>, t: number): RollMsg {
  const io = new FakeIO();
  const room = new BankRoom('public', io);
  room.start();
  room.addPlayer('p1', 'Probe A');
  room.addPlayer('p2', 'Probe B');
  room.start();
  try {
    for (const h of history) rollAt(room, io, h);
    return rollAt(room, io, t);
  } finally {
    room.stop();
  }
}

function findRollTime(
  history: ReadonlyArray<number>,
  pred: (ev: RollMsg) => boolean,
  t0: number,
): number {
  for (let t = t0; t < t0 + 100_000; t++) {
    if (pred(probeOutcome(history, t))) return t;
  }
  throw new Error('no roll time found within scan budget');
}

// ---- lifecycle ---------------------------------------------------------------

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(EPOCH);
});

afterEach(() => {
  while (tracked.length > 0) tracked.pop()?.stop();
  vi.useRealTimers();
});

// ---- tests -------------------------------------------------------------------

describe('BankRoom', () => {
  it('waits in lobby, drops invalid messages, starts the match at MIN_PLAYERS', () => {
    const io = new FakeIO();
    const room = boot(io, [['p1', 'Alice']]);
    const st = io.state('p1'); // addPlayer sends a fresh bank_state join payload
    expect(st.phase).toBe('lobby');
    expect(st.you).toBe('p1');
    expect(st.currentId).toBeNull();
    expect(st.totalRounds).toBe(TOTAL_ROUNDS);
    expect(st.safeRolls).toBe(SAFE_ROLLS);
    expect(room.playerCount()).toBe(1);
    const info = room.info();
    expect(info.game).toBe('bank');
    expect(info.label).toBe('10 rounds');
    expect(info.maxPlayers).toBe(MAX_PLAYERS);
    expect(info.phase).toBe('lobby');
    // invalid room-level messages are silently dropped (game's own parser)
    room.handleMessage('p1', { t: 'nope' });
    room.handleMessage('p1', 'garbage');
    room.handleMessage('p1', { t: 'roll' }); // no effect outside 'playing'
    expect(io.events('p1', 'roll')).toHaveLength(0);
    // second player => round 1 begins, first joiner holds the turn
    room.addPlayer('p2', 'Bob');
    const st2 = io.state('p1');
    expect(st2.phase).toBe('playing');
    expect(st2.round).toBe(1);
    expect(st2.currentId).toBe('p1');
    expect(st2.turnEndsAt).toBe(Date.now() + TURN_MS);
  });

  it('safe-window 7 is worth +70, and only the current player may roll', () => {
    const tRoll = findRollTime([], (ev) => ev.effect === 'bonus70', EPOCH + 1_000);
    const io = new FakeIO();
    const room = boot(io, [['p1', 'Alice'], ['p2', 'Bob']]);
    // not your turn => ignored
    room.handleMessage('p2', { t: 'roll' });
    expect(io.events('p2', 'roll')).toHaveLength(0);
    expect(io.state('p1').rollCount).toBe(0);
    const ev = rollAt(room, io, tRoll);
    expect(ev.d1 + ev.d2).toBe(7);
    expect(ev.rollerId).toBe('p1');
    expect(ev.effect).toBe('bonus70');
    expect(ev.potAfter).toBe(SEVEN_BONUS);
    const st = io.state('p2'); // broadcast reached everyone
    expect(st.pot).toBe(SEVEN_BONUS);
    expect(st.rollCount).toBe(1);
    expect(st.currentId).toBe('p2');
    expect(st.lastRoll?.effect).toBe('bonus70');
  });

  it('safe-window doubles only add the sum (no doubling)', () => {
    const tRoll = findRollTime([], (ev) => ev.d1 === ev.d2 && ev.effect === 'add', EPOCH + 1_000);
    const io = new FakeIO();
    const room = boot(io, [['p1', 'Alice'], ['p2', 'Bob']]);
    const ev = rollAt(room, io, tRoll);
    expect(ev.d1).toBe(ev.d2);
    expect(ev.effect).toBe('add');
    expect(ev.potAfter).toBe(ev.d1 + ev.d2);
    expect(io.state('p1').pot).toBe(ev.d1 + ev.d2);
  });

  it('post-safe doubles double the pot', () => {
    const history = [EPOCH + 1_000, EPOCH + 2_000, EPOCH + 3_000];
    const tRoll = findRollTime(history, (ev) => ev.effect === 'double', EPOCH + 4_000);
    const io = new FakeIO();
    const room = boot(io, [['p1', 'Alice'], ['p2', 'Bob']]);
    for (const h of history) rollAt(room, io, h);
    expect(io.state('p1').rollCount).toBe(SAFE_ROLLS);
    const potBefore = io.state('p1').pot;
    const ev = rollAt(room, io, tRoll);
    expect(ev.d1).toBe(ev.d2);
    expect(ev.effect).toBe('double');
    expect(ev.potAfter).toBe(potBefore * 2);
    expect(io.state('p1').pot).toBe(potBefore * 2);
  });

  it('post-safe 7 busts the round: round_end, pot lost, then the next round starts', () => {
    const history = [EPOCH + 1_000, EPOCH + 2_000, EPOCH + 3_000];
    const tRoll = findRollTime(history, (ev) => ev.effect === 'bust7', EPOCH + 4_000);
    const io = new FakeIO();
    const room = boot(io, [['p1', 'Alice'], ['p2', 'Bob']]);
    for (const h of history) rollAt(room, io, h);
    const potBefore = io.state('p1').pot;
    const ev = rollAt(room, io, tRoll);
    expect(ev.d1 + ev.d2).toBe(7);
    expect(ev.effect).toBe('bust7');
    expect(ev.potAfter).toBe(potBefore); // bust itself applies no delta
    const ends = io.events('p1', 'round_end');
    expect(ends).toHaveLength(1);
    expect(ends[0]).toMatchObject({ reason: 'bust7', round: 1 });
    const st = io.state('p1');
    expect(st.phase).toBe('roundEnd');
    expect(st.pot).toBe(0); // pot lost — shown as 0 for the next round
    expect(st.turnEndsAt).toBe(0); // no timer runs during roundEnd
    expect(player(st, 'p1').score).toBe(0); // nobody banked: the pot is gone
    expect(player(st, 'p2').score).toBe(0);
    vi.advanceTimersByTime(ROUND_END_MS);
    const st2 = io.state('p1');
    expect(st2.phase).toBe('playing');
    expect(st2.round).toBe(2);
    expect(st2.pot).toBe(0);
    expect(st2.rollCount).toBe(0);
    expect(st2.currentId).toBe('p1');
    expect(player(st2, 'p1').banked).toBe(false);
    expect(player(st2, 'p2').banked).toBe(false);
  });

  it('bank mid-round: score += pot, pot unchanged, turn passes to next non-banked', () => {
    const io = new FakeIO();
    const room = boot(io, [['p1', 'Alice'], ['p2', 'Bob'], ['p3', 'Carol']]);
    // round 1 has only the first two players active (p3 joined mid-match);
    // end it via all-banked so all three play round 2.
    const potR1 = rollAt(room, io, EPOCH + 1_000).potAfter;
    room.handleMessage('p1', { t: 'bank' });
    room.handleMessage('p2', { t: 'bank' });
    expect(io.state('p1').phase).toBe('roundEnd');
    vi.advanceTimersByTime(ROUND_END_MS);
    let st = io.state('p1');
    expect(st.round).toBe(2);
    expect(st.currentId).toBe('p1');
    const pot1 = rollAt(room, io, EPOCH + 2_000).potAfter;
    // off-turn bank (p1 while p2 is current): allowed any time in 'playing'
    room.handleMessage('p1', { t: 'bank' });
    st = io.state('p1');
    expect(player(st, 'p1').score).toBe(potR1 + pot1);
    expect(player(st, 'p1').banked).toBe(true);
    expect(st.pot).toBe(pot1); // the pot NEVER resets on a bank
    expect(st.phase).toBe('playing'); // the round continues
    expect(st.currentId).toBe('p2');
    const banks = io.events('p2', 'bank');
    expect(banks[banks.length - 1]).toMatchObject({ playerId: 'p1', amount: pot1 });
    // on-turn bank: the turn moves to the next non-banked player in join order
    room.handleMessage('p2', { t: 'bank' });
    st = io.state('p1');
    expect(player(st, 'p2').score).toBe(potR1 + pot1); // same unchanged pot
    expect(st.pot).toBe(pot1);
    expect(st.currentId).toBe('p3'); // p1 banked, so p3 is next
    const ev = rollAt(room, io, EPOCH + 3_000, 'p3'); // round still running
    expect(ev.rollerId).toBe('p3');
    // banking twice is a no-op for an already-banked player
    const bankCount = io.events('p1', 'bank').length;
    room.handleMessage('p1', { t: 'bank' });
    expect(io.events('p1', 'bank')).toHaveLength(bankCount);
  });

  it('ends the round with all_banked once every connected player has banked', () => {
    const io = new FakeIO();
    const room = boot(io, [['p1', 'Alice'], ['p2', 'Bob']]);
    const pot = rollAt(room, io, EPOCH + 1_000).potAfter;
    room.handleMessage('p1', { t: 'bank' });
    expect(io.state('p1').phase).toBe('playing'); // p2 is still in
    room.handleMessage('p2', { t: 'bank' });
    const ends = io.events('p1', 'round_end');
    expect(ends).toHaveLength(1);
    expect(ends[0]).toMatchObject({ reason: 'all_banked', round: 1 });
    const st = io.state('p1');
    expect(st.phase).toBe('roundEnd');
    expect(player(st, 'p1').score).toBe(pot);
    expect(player(st, 'p2').score).toBe(pot);
  });

  it('plays a full match: match_end with the right winner, then a full reset', () => {
    const io = new FakeIO();
    const room = boot(io, [['p1', 'Alice'], ['p2', 'Bob']]);
    let s1 = 0;
    let s2 = 0;
    let now = EPOCH;
    for (let round = 1; round <= TOTAL_ROUNDS; round++) {
      now += 1_000;
      const pot1 = rollAt(room, io, now).potAfter;
      room.handleMessage('p2', { t: 'bank' }); // Bob banks early for less
      s2 += pot1;
      now += 1_000;
      const pot2 = rollAt(room, io, now).potAfter;
      room.handleMessage('p1', { t: 'bank' }); // Alice banks the grown pot
      s1 += pot2;
      expect(pot2).toBeGreaterThan(pot1); // the pot only grows within a round
      expect(io.state('p1').phase).toBe('roundEnd');
      const ends = io.events('p1', 'round_end');
      expect(ends[ends.length - 1]).toMatchObject({ reason: 'all_banked', round });
      now += ROUND_END_MS;
      vi.advanceTimersByTime(ROUND_END_MS);
      const st = io.state('p1');
      if (round < TOTAL_ROUNDS) {
        expect(st.phase).toBe('playing');
        expect(st.round).toBe(round + 1);
      }
    }
    expect(s1).toBeGreaterThan(s2);
    // After the final round the room reaches matchEnd (whether it passes
    // through a roundEnd pause first is the room's choice).
    let st = io.state('p1');
    if (st.phase === 'roundEnd') {
      vi.advanceTimersByTime(ROUND_END_MS);
      st = io.state('p1');
    }
    expect(st.phase).toBe('matchEnd');
    expect(st.winnerId).toBe('p1');
    expect(player(st, 'p1').score).toBe(s1);
    expect(player(st, 'p2').score).toBe(s2);
    const matchEnds = io.events('p2', 'match_end');
    expect(matchEnds).toHaveLength(1);
    expect(matchEnds[0]).toMatchObject({ winnerId: 'p1' });
    // MATCH_RESET_SECONDS later: full reset; with 2 players still present the
    // lobby rules start round 1 immediately.
    vi.advanceTimersByTime(MATCH_RESET_MS);
    const st2 = io.state('p1');
    expect(st2.phase).toBe('playing');
    expect(st2.round).toBe(1);
    expect(st2.pot).toBe(0);
    expect(st2.rollCount).toBe(0);
    expect(st2.currentId).toBe('p1');
    expect(st2.winnerId).toBeNull();
    expect(player(st2, 'p1').score).toBe(0);
    expect(player(st2, 'p2').score).toBe(0);
    expect(player(st2, 'p1').banked).toBe(false);
  });

  it('auto-rolls for the current player when the turn timer expires', () => {
    const io = new FakeIO();
    const room = boot(io, [['p1', 'Alice'], ['p2', 'Bob']]);
    expect(io.state('p1').turnEndsAt).toBe(Date.now() + TURN_MS);
    vi.advanceTimersByTime(TURN_MS);
    // auto_roll is broadcast BEFORE the forced roll event
    const msgs = io.all('p2');
    const autoIdx = msgs.findIndex((m) => m.t === 'event' && m.ev.t === 'auto_roll');
    expect(autoIdx).toBeGreaterThanOrEqual(0);
    const auto = msgs[autoIdx];
    if (auto === undefined || auto.t !== 'event') throw new Error('unreachable: autoIdx checked');
    expect(auto.ev).toMatchObject({ t: 'auto_roll', playerId: 'p1' });
    const rollIdx = msgs.findIndex((m, i) => i > autoIdx && m.t === 'event' && m.ev.t === 'roll');
    expect(rollIdx).toBeGreaterThan(autoIdx);
    const roll = msgs[rollIdx];
    if (roll === undefined || roll.t !== 'event') throw new Error('unreachable: rollIdx checked');
    expect(roll.ev).toMatchObject({ t: 'roll', rollerId: 'p1' });
    const st = io.state('p1');
    expect(st.rollCount).toBe(1);
    expect(st.currentId).toBe('p2'); // the forced roll passes the turn
    expect(st.turnEndsAt).toBe(Date.now() + TURN_MS); // fresh timer for p2
  });

  it('mid-match joiner watches banked until the next round, then plays in join order', () => {
    const io = new FakeIO();
    const room = boot(io, [['p1', 'Alice'], ['p2', 'Bob']]);
    rollAt(room, io, EPOCH + 1_000);
    room.addPlayer('p3', 'Carol');
    const joinSt = io.state('p3'); // joiners get a fresh bank_state
    expect(joinSt.phase).toBe('playing');
    expect(joinSt.you).toBe('p3');
    expect(joinSt.players).toHaveLength(3);
    const p3 = joinSt.players[2]; // appended to the END of the order
    expect(p3?.id).toBe('p3');
    expect(p3?.banked).toBe(true); // sits out the rest of this round
    expect(joinSt.currentId).toBe('p2'); // the turn is unaffected
    // cannot roll while watching
    room.handleMessage('p3', { t: 'roll' });
    expect(io.events('p3', 'roll')).toHaveLength(0);
    expect(io.state('p3').rollCount).toBe(1);
    // p1 + p2 banking ends the round (p3 already counts as banked)
    room.handleMessage('p1', { t: 'bank' });
    room.handleMessage('p2', { t: 'bank' });
    expect(io.events('p3', 'round_end')[0]).toMatchObject({ reason: 'all_banked', round: 1 });
    vi.advanceTimersByTime(ROUND_END_MS);
    // next round: p3 is active, still last in the order
    let st = io.state('p3');
    expect(st.round).toBe(2);
    expect(player(st, 'p3').banked).toBe(false);
    expect(st.currentId).toBe('p1');
    rollAt(room, io, EPOCH + 2_000);
    rollAt(room, io, EPOCH + 3_000);
    st = io.state('p1');
    expect(st.currentId).toBe('p3');
    const ev = rollAt(room, io, EPOCH + 4_000, 'p3');
    expect(ev.rollerId).toBe('p3');
  });

  it('aborts to lobby on low population, keeps scores, resets them on the new match', () => {
    const io = new FakeIO();
    const room = boot(io, [['p1', 'Alice'], ['p2', 'Bob']]);
    const pot = rollAt(room, io, EPOCH + 1_000).potAfter;
    room.handleMessage('p1', { t: 'bank' });
    expect(player(io.state('p1'), 'p1').score).toBe(pot);
    room.removePlayer('p2'); // connected < MIN_PLAYERS mid-match
    const st = io.state('p1');
    expect(st.phase).toBe('lobby');
    expect(st.currentId).toBeNull();
    expect(player(st, 'p1').score).toBe(pot); // scores KEPT across the abort
    expect(player(st, 'p2').connected).toBe(false); // row kept for a rejoiner
    // rejoin => a NEW match starts from round 1 with fresh scores
    room.addPlayer('p2', 'Bob');
    const st2 = io.state('p1');
    expect(st2.players).toHaveLength(2); // rejoin, not a duplicate row
    expect(st2.phase).toBe('playing');
    expect(st2.round).toBe(1);
    expect(player(st2, 'p1').score).toBe(0);
    expect(player(st2, 'p2').score).toBe(0);
  });
});
