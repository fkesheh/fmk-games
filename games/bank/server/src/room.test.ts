// ============================================================================
// BANK room tests — every invariant from docs/BANK.md "Tests" plus the
// "Room variants" contract (sevenBonus / totalRounds / raceTarget settings,
// bad_settings rejection), driven straight against BankRoom and the frozen
// bankModule.createRoom entry point over a fake RoomIO. vi fake timers also
// freeze Date.now, so the room's per-roll stream
// rng(Date.now() ^ (rollCounter * 2654435761)) is deterministic. Wanted dice
// outcomes are located by probing a throwaway room at candidate times, then
// replayed verbatim in the real room: same roll times + same roll history =>
// same seeds => same dice (settings never influence the dice stream, only how
// a roll resolves), regardless of how the room counts rolls internally.
// ============================================================================
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_SETTINGS,
  MATCH_RESET_SECONDS,
  MAX_PLAYERS,
  MIN_PLAYERS,
  ROUND_END_SECONDS,
  SAFE_ROLLS,
  SEVEN_BONUS,
  TOTAL_ROUNDS,
  TURN_SECONDS,
} from '@bank/shared';
import type { BankEvent, BankPlayerState, BankState } from '@bank/shared';
import type { GameRoomHandle, PlayerId, RoomIO } from '@platform/shared';
import { bankModule } from './module.js';
import { BankRoom } from './room.js';

/** Wire shape: fresh per-recipient state, or one shared event envelope. */
type EventEnvelope = { t: 'event'; ev: BankEvent };
/** Room-level error envelope; the only one the room emits is `room_full`. */
type ErrorEnvelope = { t: 'error'; code: string; message: string };
type BankMsg = BankState | EventEnvelope | ErrorEnvelope;
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
  if (t === 'error') return typeof (msg as { code?: unknown }).code === 'string';
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

  errors(id: PlayerId): ErrorEnvelope[] {
    return this.all(id).filter((m): m is ErrorEnvelope => m.t === 'error');
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
const tracked: GameRoomHandle[] = [];

/**
 * The room no longer auto-starts on reaching MIN_PLAYERS (docs/BANK.md "no
 * game may auto-start"): a seated player must send an explicit {t:'start'}.
 * boot/bootVariant/probeOutcome all seat a full table and then send it from
 * the FIRST seated player here, in one place, so the rest of the suite (which
 * overwhelmingly exercises the PLAYED game, not the lobby) doesn't have to.
 * A table under MIN_PLAYERS is left in `lobby`, matching production: sending
 * {t:'start'} early would be silently ignored anyway, but skipping it here
 * also lets single-seat tests observe the true cold-lobby state.
 */
function startIfReady(
  room: Pick<GameRoomHandle, 'handleMessage'>,
  players: ReadonlyArray<readonly [PlayerId, string]>,
): void {
  if (players.length < MIN_PLAYERS) return;
  const starter = players[0];
  if (starter === undefined) return;
  room.handleMessage(starter[0], { t: 'start' });
}

function boot(io: FakeIO, players: ReadonlyArray<readonly [PlayerId, string]>): BankRoom {
  const room = new BankRoom('public', io);
  room.start(); // idempotent per the platform contract
  for (const [id, name] of players) room.addPlayer(id, name);
  room.start(); // covers either start/add ordering
  startIfReady(room, players);
  tracked.push(room);
  return room;
}

/**
 * Variant room through the frozen module entry point: createRoom validates
 * the settings (throwing on bad ones) and freezes the variant into the room.
 */
function bootVariant(
  io: FakeIO,
  players: ReadonlyArray<readonly [PlayerId, string]>,
  settings: Record<string, unknown>,
): GameRoomHandle {
  const room = bankModule.createRoom({ visibility: 'public', io, settings });
  room.start();
  for (const [id, name] of players) room.addPlayer(id, name);
  room.start();
  startIfReady(room, players);
  tracked.push(room);
  return room;
}

/**
 * Roll from whoever currently holds the turn, at fake time t. `via` is any
 * connected player used to read state/events (events are broadcast to all).
 */
function rollAt(room: GameRoomHandle, io: FakeIO, t: number, via: PlayerId = 'p1'): RollMsg {
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
  // built through the EXACT same sequence as boot(io, [['p1', ...], ['p2', ...]])
  // (start/addPlayer/addPlayer/start/startIfReady) — the roll seed depends only
  // on Date.now() and rollCounter, but keeping the construction path identical
  // is what makes the probe-then-replay determinism safe to rely on at all.
  const players = [['p1', 'Probe A'], ['p2', 'Probe B']] as const;
  room.start();
  for (const [id, name] of players) room.addPlayer(id, name);
  room.start();
  startIfReady(room, players);
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
  it('waits in lobby, drops invalid messages, and only an explicit start begins the match', () => {
    const io = new FakeIO();
    const room = boot(io, [['p1', 'Alice']]); // 1 seat: below MIN_PLAYERS, boot sends no start
    const st = io.state('p1'); // addPlayer sends a fresh bank_state join payload
    expect(st.phase).toBe('lobby');
    expect(st.you).toBe('p1');
    expect(st.currentId).toBeNull();
    expect(st.totalRounds).toBe(TOTAL_ROUNDS);
    expect(st.safeRolls).toBe(SAFE_ROLLS);
    expect(st.settings).toEqual(DEFAULT_SETTINGS); // no settings at creation => defaults
    expect(room.playerCount()).toBe(1);
    const info = room.info();
    expect(info.game).toBe('bank');
    expect(info.label).toBe('10 rounds · 7=70');
    expect(info.maxPlayers).toBe(MAX_PLAYERS);
    expect(info.phase).toBe('lobby');
    // invalid room-level messages are silently dropped (game's own parser)
    room.handleMessage('p1', { t: 'nope' });
    room.handleMessage('p1', 'garbage');
    room.handleMessage('p1', { t: 'roll' }); // no effect outside 'playing'
    expect(io.events('p1', 'roll')).toHaveLength(0);
    // second player => the table is now STARTABLE, but does NOT start itself
    room.addPlayer('p2', 'Bob');
    const st2 = io.state('p1');
    expect(st2.phase).toBe('lobby');
    expect(st2.canStart).toBe(true);
    expect(st2.playerCount).toBe(2);
    expect(st2.minPlayers).toBe(MIN_PLAYERS);
    expect(st2.currentId).toBeNull();
    // an explicit start from a seated player => round 1 begins, first joiner
    // holds the turn
    room.handleMessage('p1', { t: 'start' });
    const st3 = io.state('p1');
    expect(st3.phase).toBe('playing');
    expect(st3.round).toBe(1);
    expect(st3.currentId).toBe('p1');
    expect(st3.turnEndsAt).toBe(Date.now() + TURN_MS);
  });

  it('a cold room seated to MIN_PLAYERS is startable but never starts on its own', () => {
    const io = new FakeIO();
    // built directly (not via boot()), which would send the start itself
    const room = new BankRoom('public', io);
    room.start();
    room.addPlayer('p1', 'Alice');
    room.addPlayer('p2', 'Bob');
    tracked.push(room);
    const st = io.state('p1');
    expect(st.phase).toBe('lobby');
    expect(st.awaitingStart).toBe(false); // cold, not post-match
    expect(st.canStart).toBe(true);
    expect(st.playerCount).toBe(2);
    expect(st.minPlayers).toBe(MIN_PLAYERS);
    expect(st.round).toBe(0);
    expect(st.currentId).toBeNull();
    expect(st.turnEndsAt).toBe(0);
    // advance far past every timer the room would be running if it HAD
    // started (turn/roundEnd/matchEnd are all well under 60s) — nothing
    // restarts it, because no timer is running underneath a lobby at all
    vi.advanceTimersByTime(60_000);
    const st2 = io.state('p1');
    expect(st2.phase).toBe('lobby');
    expect(st2.round).toBe(0);
    expect(st2.currentId).toBeNull();
    expect(st2.turnEndsAt).toBe(0);
  });

  it('any seated player may start the match, not only the first to join', () => {
    const io = new FakeIO();
    const room = new BankRoom('public', io);
    room.start();
    room.addPlayer('p1', 'Alice');
    room.addPlayer('p2', 'Bob');
    tracked.push(room);
    expect(io.state('p1').phase).toBe('lobby');
    room.handleMessage('p2', { t: 'start' }); // p2 joined second — there is no host
    const st = io.state('p1');
    expect(st.phase).toBe('playing');
    expect(st.round).toBe(1);
    expect(st.currentId).toBe('p1'); // the opening seat is unaffected by WHO started it
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
    expect(st.canStart).toBe(false); // start only ever fires from 'lobby'
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
    // p3 joined mid-round-1 and is active AT ONCE (the new join rule), so all
    // three must bank to end round 1; then all three play round 2.
    const potR1 = rollAt(room, io, EPOCH + 1_000).potAfter;
    room.handleMessage('p1', { t: 'bank' });
    room.handleMessage('p2', { t: 'bank' });
    room.handleMessage('p3', { t: 'bank' });
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
    expect(st.canStart).toBe(false); // never true outside 'lobby'
    expect(player(st, 'p1').score).toBe(s1);
    expect(player(st, 'p2').score).toBe(s2);
    const matchEnds = io.events('p2', 'match_end');
    expect(matchEnds).toHaveLength(1);
    expect(matchEnds[0]).toMatchObject({ winnerId: 'p1' });
    // MATCH_RESET_SECONDS later: full reset back to a lobby that WAITS. The
    // room no longer restarts itself — `awaitingStart` marks the post-match
    // lobby and an explicit {t:'start'} is the only way out of it.
    vi.advanceTimersByTime(MATCH_RESET_MS);
    const st2 = io.state('p1');
    expect(st2.phase).toBe('lobby');
    expect(st2.awaitingStart).toBe(true);
    expect(st2.canStart).toBe(true); // both seats are still connected
    expect(st2.playerCount).toBe(2);
    expect(st2.minPlayers).toBe(MIN_PLAYERS);
    expect(st2.round).toBe(0);
    expect(st2.pot).toBe(0);
    expect(st2.rollCount).toBe(0);
    expect(st2.currentId).toBeNull();
    expect(st2.turnEndsAt).toBe(0);
    expect(st2.winnerId).toBeNull();
    expect(player(st2, 'p1').score).toBe(0);
    expect(player(st2, 'p2').score).toBe(0);
    expect(player(st2, 'p1').banked).toBe(false);
    // ...and it STAYS there: no timer, no joiner, nothing restarts it
    vi.advanceTimersByTime(MATCH_RESET_MS * 4);
    expect(io.state('p1').phase).toBe('lobby');
    // any seated player may open the next match — p2 here, not the "first"
    // seat that opened the match originally
    room.handleMessage('p2', { t: 'start' });
    const st3 = io.state('p1');
    expect(st3.phase).toBe('playing');
    expect(st3.round).toBe(1);
    expect(st3.awaitingStart).toBe(false);
    expect(st3.canStart).toBe(false); // no longer in 'lobby'
    expect(st3.currentId).toBe('p1');
    // the new match's scores are ZEROED even though p1 scored s1 > 0 in the
    // match that just ended, and neither player is marked banked
    expect(player(st3, 'p1').score).toBe(0);
    expect(player(st3, 'p2').score).toBe(0);
    expect(player(st3, 'p1').banked).toBe(false);
    expect(player(st3, 'p2').banked).toBe(false);
  });

  it('post-match lobby: a JOINER does not restart it; only {t:start} does', () => {
    const io = new FakeIO();
    // Race mode is the cheapest route to matchEnd: no round cap, the match ends
    // the moment a bank crosses raceTarget. One roll per round keeps every roll
    // inside the safe window, so a 7 can never bust and the loop always ends.
    const race = bootVariant(io, [['p1', 'Alice'], ['p2', 'Bob']], { raceTarget: 500 });
    let t = EPOCH + 1_000;
    for (let i = 0; i < 400; i++) {
      const phase = io.state('p1').phase;
      if (phase === 'matchEnd') break;
      if (phase === 'roundEnd') {
        vi.advanceTimersByTime(ROUND_END_MS);
        t += ROUND_END_MS;
        continue;
      }
      rollAt(race, io, t);
      t += 1_000;
      if (io.state('p1').phase !== 'playing') continue;
      race.handleMessage('p1', { t: 'bank' });
      if (io.state('p1').phase !== 'playing') continue;
      race.handleMessage('p2', { t: 'bank' }); // both banked => round ends
    }
    expect(io.state('p1').phase).toBe('matchEnd');
    vi.advanceTimersByTime(MATCH_RESET_MS);
    expect(io.state('p1').phase).toBe('lobby');
    expect(io.state('p1').awaitingStart).toBe(true);
    expect(io.state('p1').canStart).toBe(true); // already >= MIN_PLAYERS
    expect(io.state('p1').playerCount).toBe(2);
    // a NEW seat arriving must not silently kick the next match off
    race.addPlayer('p3', 'Carol');
    expect(io.state('p1').phase).toBe('lobby');
    expect(io.state('p1').players).toHaveLength(3);
    expect(io.state('p1').playerCount).toBe(3);
    expect(io.state('p1').canStart).toBe(true);
    // ...the explicit start does, and the JOINER — who arrived after the
    // table was already startable, and is nobody's "host" — is allowed to
    // send it just as freely as an original seat
    race.handleMessage('p3', { t: 'start' });
    expect(io.state('p1').phase).toBe('playing');
    expect(io.state('p1').awaitingStart).toBe(false);
    expect(io.state('p1').canStart).toBe(false);
  });

  it('start is ignored below MIN_PLAYERS and outside the lobby, and never throws', () => {
    const io = new FakeIO();
    const room = boot(io, [['p1', 'Alice']]); // 1 seat: cold lobby, boot sends no start
    expect(io.state('p1').phase).toBe('lobby');
    expect(io.state('p1').awaitingStart).toBe(false); // COLD lobby, not post-match
    expect(io.state('p1').canStart).toBe(false); // below MIN_PLAYERS
    expect(() => room.handleMessage('p1', { t: 'start' })).not.toThrow(); // too few players => ignored
    expect(io.state('p1').phase).toBe('lobby');
    // the cold lobby does NOT auto-start on reaching MIN_PLAYERS anymore — it
    // only becomes STARTABLE; an explicit {t:'start'} is required to proceed
    room.addPlayer('p2', 'Bob');
    expect(io.state('p1').phase).toBe('lobby');
    expect(io.state('p1').canStart).toBe(true);
    room.handleMessage('p1', { t: 'start' });
    expect(io.state('p1').phase).toBe('playing');
    // mid-match start is ignored and does NOT reset the round, the pot or the
    // scores — compare a full before/after snapshot
    const before = io.state('p1');
    expect(before.canStart).toBe(false); // not in lobby => never startable
    room.handleMessage('p2', { t: 'start' });
    const after = io.state('p1');
    expect(after.phase).toBe('playing');
    expect(after.round).toBe(before.round);
    expect(after.currentId).toBe(before.currentId);
    expect(after.pot).toBe(before.pot);
    expect(player(after, 'p1').score).toBe(player(before, 'p1').score);
    expect(player(after, 'p2').score).toBe(player(before, 'p2').score);
    // and it is ignored during the round-end pause too
    room.handleMessage('p1', { t: 'bank' });
    room.handleMessage('p2', { t: 'bank' });
    expect(io.state('p1').phase).toBe('roundEnd');
    expect(io.state('p1').canStart).toBe(false);
    room.handleMessage('p1', { t: 'start' });
    expect(io.state('p1').phase).toBe('roundEnd');
  });

  it('seats MAX_PLAYERS, rotates in join order, and rejects the seat past the cap', () => {
    const io = new FakeIO();
    // MAX_PLAYERS is 32; the ids are zero-padded so the join order and the
    // string order agree and an off-by-one in the rotation is visible.
    const seats: Array<readonly [PlayerId, string]> = [];
    for (let i = 0; i < MAX_PLAYERS; i++) {
      const n = String(i + 1).padStart(2, '0');
      seats.push([`p${n}`, `Player ${n}`] as const);
    }
    const room = boot(io, seats);
    expect(room.playerCount()).toBe(MAX_PLAYERS);
    expect(room.info().maxPlayers).toBe(MAX_PLAYERS);
    const st = io.state('p01');
    expect(st.phase).toBe('playing'); // filled well past MIN_PLAYERS
    expect(st.players).toHaveLength(MAX_PLAYERS);
    expect(st.players.map((p) => p.id)).toEqual(seats.map(([id]) => id)); // join order
    expect(st.currentId).toBe('p01'); // the first seat opens the round

    // one seat past the cap is refused with room_full, and the table is unchanged
    room.addPlayer('p33', 'Overflow');
    expect(room.playerCount()).toBe(MAX_PLAYERS);
    expect(io.state('p01').players).toHaveLength(MAX_PLAYERS);
    expect(io.errors('p33')).toEqual([
      { t: 'error', code: 'room_full', message: 'room is full' },
    ]);
    expect(() => io.state('p33')).toThrow(); // a refused seat gets no bank_state

    //  TURN ROTATION over a FULL cycle: all 32 seats in join order, then back to
    //  the first. A bust would cut the round short, so every roll time is
    //  pre-selected (the file's probe technique) to be non-bust — the walk then
    //  survives all 32 turns and the assertion is about ORDER, not luck.
    const history: number[] = [];
    let t = EPOCH + 1_000;
    const visited: Array<string | null> = [st.currentId];
    for (let i = 0; i < MAX_PLAYERS; i++) {
      const when = findRollTime(history, (ev) => ev.effect !== 'bust7', t);
      history.push(when);
      t = when + 1;
      expect(rollAt(room, io, when, 'p01').effect).not.toBe('bust7');
      expect(io.state('p01').phase).toBe('playing'); // the round survived the roll
      visited.push(io.state('p01').currentId);
    }
    expect(visited.slice(0, MAX_PLAYERS)).toEqual(seats.map(([id]) => id));
    expect(visited[MAX_PLAYERS]).toBe('p01'); // one full cycle wraps to seat 1
    expect(io.state('p01').rollCount).toBe(MAX_PLAYERS);
  });

  it('auto-rolls at the NEW TURN_SECONDS, and not a tick before it', () => {
    const io = new FakeIO();
    boot(io, [['p1', 'Alice'], ['p2', 'Bob']]);
    expect(TURN_SECONDS).toBe(12); // pacing contract: config.ts
    expect(io.state('p1').turnEndsAt).toBe(Date.now() + TURN_MS);
    // one millisecond short of the deadline nothing has happened yet
    vi.advanceTimersByTime(TURN_MS - 1);
    expect(io.events('p1', 'auto_roll')).toHaveLength(0);
    expect(io.state('p1').currentId).toBe('p1');
    // ...and on the deadline the server rolls for the seat that stalled
    vi.advanceTimersByTime(1);
    expect(io.events('p1', 'auto_roll')).toHaveLength(1);
    expect(io.state('p1').rollCount).toBe(1);
    expect(io.state('p1').currentId).toBe('p2');
    expect(io.state('p1').turnEndsAt).toBe(Date.now() + TURN_MS); // fresh 12 s for p2
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

  it('mid-match joiner plays at once: appended to the END, rolls when their turn comes', () => {
    const io = new FakeIO();
    const room = boot(io, [['p1', 'Alice'], ['p2', 'Bob']]);
    rollAt(room, io, EPOCH + 1_000); // p1 rolls; the turn passes to p2
    room.addPlayer('p3', 'Carol');
    const joinSt = io.state('p3'); // joiners get a fresh bank_state
    expect(joinSt.phase).toBe('playing');
    expect(joinSt.you).toBe('p3');
    expect(joinSt.players).toHaveLength(3);
    const p3 = joinSt.players[2]; // appended to the END of the order
    expect(p3?.id).toBe('p3');
    expect(p3?.banked).toBe(false); // sits down and plays THIS round
    expect(joinSt.currentId).toBe('p2'); // the turn is unaffected
    // still cannot roll off-turn
    room.handleMessage('p3', { t: 'roll' });
    expect(io.events('p3', 'roll')).toHaveLength(0);
    expect(io.state('p3').rollCount).toBe(1);
    // p2 rolls and the turn reaches p3 in the CURRENT round
    rollAt(room, io, EPOCH + 2_000);
    expect(io.state('p1').currentId).toBe('p3');
    const ev = rollAt(room, io, EPOCH + 3_000, 'p3');
    expect(ev.rollerId).toBe('p3'); // the joiner rolled in the round they joined
    expect(io.state('p1').currentId).toBe('p1'); // then the order cycles back
  });

  it('3 players: a mid-round-1 joiner rolls and banks in round 1', () => {
    const io = new FakeIO();
    const room = boot(io, [['p1', 'Alice'], ['p2', 'Bob']]);
    rollAt(room, io, EPOCH + 1_000); // p1; currentId = p2
    room.addPlayer('p3', 'Carol'); // round-1 joiner — active immediately
    rollAt(room, io, EPOCH + 2_000); // p2; currentId = p3
    const ev = rollAt(room, io, EPOCH + 3_000, 'p3'); // p3 rolls IN round 1
    expect(ev.rollerId).toBe('p3');
    expect(io.state('p1').round).toBe(1);
    // all THREE must bank before round 1 can end: p3 is a live player
    room.handleMessage('p1', { t: 'bank' });
    room.handleMessage('p2', { t: 'bank' });
    expect(io.state('p1').phase).toBe('playing'); // p3 still in => round 1 goes on
    room.handleMessage('p3', { t: 'bank' });
    const ends = io.events('p1', 'round_end');
    expect(ends).toHaveLength(1);
    expect(ends[0]).toMatchObject({ reason: 'all_banked', round: 1 });
    expect(player(io.state('p3'), 'p3').score).toBeGreaterThan(0); // scored in round 1
  });

  it('aborts to lobby on low population, keeps scores, and only an explicit start resets them', () => {
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
    // rejoin brings the table back to startable, but the room does NOT
    // restart itself — it waits for an explicit {t:'start'} like any lobby
    room.addPlayer('p2', 'Bob');
    const stRejoined = io.state('p1');
    expect(stRejoined.phase).toBe('lobby');
    expect(stRejoined.canStart).toBe(true);
    expect(player(stRejoined, 'p1').score).toBe(pot); // still kept, pre-start
    // explicit start => a NEW match starts from round 1 with fresh scores
    room.handleMessage('p1', { t: 'start' });
    const st2 = io.state('p1');
    expect(st2.players).toHaveLength(2); // rejoin, not a duplicate row
    expect(st2.phase).toBe('playing');
    expect(st2.round).toBe(1);
    expect(player(st2, 'p1').score).toBe(0);
    expect(player(st2, 'p2').score).toBe(0);
  });

  it('rejoin: a resume token re-binds the entry — new id, order/score/banked preserved', () => {
    const io = new FakeIO();
    const room = boot(io, [['p1', 'Alice'], ['p2', 'Bob'], ['p3', 'Carol']]);
    const pot = rollAt(room, io, EPOCH + 1_000).potAfter;
    room.handleMessage('p1', { t: 'bank' }); // p1 banks: score = pot > 0
    expect(player(io.state('p2'), 'p1').score).toBe(pot);
    room.removePlayer('p1'); // disconnect: the entry stays (2 connected, no abort)
    expect(player(io.state('p2'), 'p1').connected).toBe(false);
    room.addPlayer('p1b', 'Alice', 'p1'); // resume = old id => re-bind
    const st = io.state('p2');
    expect(st.players).toHaveLength(3); // NO duplicate row
    const alice = st.players[0]; // the join-order slot is preserved (p1 was first)
    expect(alice?.id).toBe('p1b'); // the entry's id became the new session id
    expect(alice?.name).toBe('Alice');
    expect(alice?.score).toBe(pot); // score preserved
    expect(alice?.banked).toBe(true); // banked preserved
    expect(alice?.connected).toBe(true);
    expect(room.playerCount()).toBe(3); // the room doesn't double-count either
    expect(io.state('p1b').you).toBe('p1b'); // fresh state for the new session
    expect(st.phase).toBe('playing'); // the match continues untouched
    expect(st.currentId).toBe('p2');
  });

  it('resume against a still-connected entry is ignored: the joiner is a new player', () => {
    const io = new FakeIO();
    const room = boot(io, [['p1', 'Alice'], ['p2', 'Bob']]);
    const pot = rollAt(room, io, EPOCH + 1_000).potAfter;
    room.handleMessage('p1', { t: 'bank' }); // give p1 a score + banked state
    room.addPlayer('p1clone', 'Alice', 'p1'); // second tab with p1's token — p1 CONNECTED
    const st = io.state('p1');
    expect(st.players).toHaveLength(3); // two separate entries, no re-bind
    const orig = player(st, 'p1');
    expect(orig.connected).toBe(true); // the original session is untouched
    expect(orig.score).toBe(pot);
    expect(orig.banked).toBe(true);
    const clone = player(st, 'p1clone');
    expect(clone.score).toBe(0); // nothing transferred to the fresh entry
    expect(clone.banked).toBe(false); // a mid-round joiner, active at once
    expect(clone.connected).toBe(true);
    expect(room.playerCount()).toBe(3);
  });

  it('ghost purge: a disconnected entry is removed at the next round start', () => {
    const io = new FakeIO();
    const room = boot(io, [['p1', 'Alice'], ['p2', 'Bob'], ['p3', 'Carol']]);
    rollAt(room, io, EPOCH + 1_000); // p1 rolls; currentId = p2
    room.removePlayer('p3'); // ghost: the entry stays for THIS round
    let st = io.state('p1');
    expect(st.players).toHaveLength(3);
    expect(player(st, 'p3').connected).toBe(false);
    expect(room.playerCount()).toBe(2);
    room.handleMessage('p1', { t: 'bank' });
    room.handleMessage('p2', { t: 'bank' });
    expect(io.state('p1').phase).toBe('roundEnd');
    vi.advanceTimersByTime(ROUND_END_MS); // round 2 starts: ghosts are purged
    st = io.state('p1');
    expect(st.phase).toBe('playing');
    expect(st.round).toBe(2);
    expect(st.players).toHaveLength(2); // p3 is GONE from the state
    expect(st.players.some((p) => p.id === 'p3')).toBe(false);
    expect(st.currentId).toBe('p1'); // the game continues normally
    const ev = rollAt(room, io, EPOCH + 10_000);
    expect(ev.rollerId).toBe('p1');
    expect(io.state('p2').players).toHaveLength(2);
  });
});

// ---- sig rebind + roomId (browser-identity contract §2.3 / BankState.roomId) --
// `sig` is the durable browser signature, stamped on the seat by every
// addPlayer call that carries one. These rooms are built directly (not via
// boot()) so each seat's sig is known up front, matching how a real client
// stamps every join.

describe('BankRoom sig rebind + roomId', () => {
  it('drop then rejoin by sig alone (no resume, new playerId): same seat, score and join-order slot preserved', () => {
    const io = new FakeIO();
    const room = new BankRoom('public', io);
    room.start();
    room.addPlayer('p1', 'Alice', undefined, 'sig-alice');
    room.addPlayer('p2', 'Bob', undefined, 'sig-bob');
    room.addPlayer('p3', 'Carol', undefined, 'sig-carol');
    tracked.push(room);
    room.handleMessage('p1', { t: 'start' });
    const pot = rollAt(room, io, EPOCH + 1_000).potAfter; // p1 rolls
    room.handleMessage('p1', { t: 'bank' }); // p1 banks: score = pot > 0
    expect(player(io.state('p2'), 'p1').score).toBe(pot);
    room.removePlayer('p1'); // disconnect: ghost stays, sig retained
    expect(player(io.state('p2'), 'p1').connected).toBe(false);
    // brand-new session id, NO resume — only the durable sig matches
    room.addPlayer('p1new', 'Alice', undefined, 'sig-alice');
    const st = io.state('p2');
    expect(st.players).toHaveLength(3); // no duplicate row
    const alice = st.players[0]; // join-order slot preserved (p1 was first)
    expect(alice?.id).toBe('p1new');
    expect(alice?.score).toBe(pot); // score preserved
    expect(alice?.banked).toBe(true); // banked flag preserved
    expect(alice?.connected).toBe(true);
    expect(room.playerCount()).toBe(3); // no double-count
    expect(io.state('p1new').you).toBe('p1new');
  });

  it('resume and sig BOTH present and pointing at the same ghost: one rebind, one entry', () => {
    const io = new FakeIO();
    const room = new BankRoom('public', io);
    room.start();
    room.addPlayer('p1', 'Alice', undefined, 'sig-alice');
    room.addPlayer('p2', 'Bob', undefined, 'sig-bob');
    tracked.push(room);
    room.handleMessage('p1', { t: 'start' });
    const pot = rollAt(room, io, EPOCH + 1_000).potAfter;
    room.handleMessage('p1', { t: 'bank' });
    room.removePlayer('p1');
    // resume='p1' (exact) AND sig='sig-alice' both point at the SAME ghost —
    // step 1 (resume) wins and rebinds; step 2 must never run a second rebind
    room.addPlayer('p1b', 'Alice', 'p1', 'sig-alice');
    const st = io.state('p2');
    expect(st.players).toHaveLength(2); // NOT a duplicate row from a double rebind
    const alice = player(st, 'p1b');
    expect(alice.score).toBe(pot);
    expect(alice.banked).toBe(true);
    expect(alice.connected).toBe(true);
    expect(room.playerCount()).toBe(2);
  });

  it('wrong resume + wrong sig: a fresh seat, no rebind', () => {
    const io = new FakeIO();
    const room = new BankRoom('public', io);
    room.start();
    room.addPlayer('p1', 'Alice', undefined, 'sig-alice');
    room.addPlayer('p2', 'Bob', undefined, 'sig-bob');
    tracked.push(room);
    room.handleMessage('p1', { t: 'start' });
    const pot = rollAt(room, io, EPOCH + 1_000).potAfter;
    room.handleMessage('p1', { t: 'bank' });
    room.removePlayer('p1'); // p1 ghosted, sig 'sig-alice' retained
    room.addPlayer('p3', 'Mallory', 'not-p1', 'not-sig-alice');
    const st = io.state('p2');
    expect(st.players).toHaveLength(3); // fresh seat added, ghost untouched
    const ghost = player(st, 'p1');
    expect(ghost.connected).toBe(false); // the real ghost was never touched
    expect(ghost.score).toBe(pot);
    const mallory = player(st, 'p3');
    expect(mallory.score).toBe(0); // nothing transferred to the fresh entry
    expect(mallory.connected).toBe(true);
    expect(room.playerCount()).toBe(2); // p2 + p3 connected; p1's ghost holds no seat
  });

  it('BankState.roomId is populated and stable across states', () => {
    const io = new FakeIO();
    const room = boot(io, [['p1', 'Alice'], ['p2', 'Bob']]);
    const st1 = io.state('p1');
    expect(st1.roomId).toBe(room.id);
    expect(st1.roomId.length).toBeGreaterThan(0);
    rollAt(room, io, EPOCH + 1_000);
    const st2 = io.state('p1');
    expect(st2.roomId).toBe(st1.roomId); // stable across further snapshots
    expect(st2.roomId).toBe(room.info().id);
  });

  it('a mid-match drop of the CURRENT turn holder, then a sig rejoin: turn handed off on the drop, rejoiner is back in rotation with score intact', () => {
    // 3 seats, not 2: dropping the turn holder must stay ABOVE MIN_PLAYERS
    // (2) so the room hands the turn off normally instead of low-pop
    // aborting to the lobby — that abort path is covered elsewhere.
    const io = new FakeIO();
    const room = new BankRoom('public', io);
    room.start();
    room.addPlayer('p1', 'Alice', undefined, 'sig-alice');
    room.addPlayer('p2', 'Bob', undefined, 'sig-bob');
    room.addPlayer('p3', 'Carol', undefined, 'sig-carol');
    tracked.push(room);
    room.handleMessage('p1', { t: 'start' });
    expect(io.state('p1').currentId).toBe('p1'); // p1 opens round 1
    let now = EPOCH;
    now += 1_000;
    const pot1 = rollAt(room, io, now).potAfter; // p1 rolls; turn -> p2
    room.handleMessage('p1', { t: 'bank' }); // p1 banks round 1's pot (off-turn, allowed)
    expect(player(io.state('p1'), 'p1').score).toBe(pot1);
    room.handleMessage('p2', { t: 'bank' });
    room.handleMessage('p3', { t: 'bank' }); // all banked -> round ends
    expect(io.state('p1').phase).toBe('roundEnd');
    now += ROUND_END_MS;
    vi.advanceTimersByTime(ROUND_END_MS); // round 2 starts
    expect(io.state('p1').phase).toBe('playing');
    expect(io.state('p1').currentId).toBe('p1'); // fixed round-start seat: p1 again
    // p3 sits out the rest of round 2 up front, so the rotation below is
    // unambiguous: only p1/p1new and p2 remain eligible to roll
    room.handleMessage('p3', { t: 'bank' });
    // p1 holds the turn RIGHT NOW — drop them
    room.removePlayer('p1');
    const afterDrop = io.state('p2');
    expect(player(afterDrop, 'p1').connected).toBe(false);
    expect(player(afterDrop, 'p1').score).toBe(pot1); // score survives the drop
    expect(afterDrop.currentId).toBe('p2'); // the dropped turn was handed off at once
    // sig-only rejoin: a brand-new session id, no resume
    room.addPlayer('p1new', 'Alice', undefined, 'sig-alice');
    const st = io.state('p2');
    expect(st.players).toHaveLength(3); // no duplicate row
    expect(st.players[0]?.id).toBe('p1new'); // join-order slot preserved
    const alice = player(st, 'p1new');
    expect(alice.connected).toBe(true);
    expect(alice.score).toBe(pot1); // score intact through the rejoin
    expect(alice.banked).toBe(false); // round 2's banked flag, untouched by the rebind
    expect(st.currentId).toBe('p2'); // the rejoin itself doesn't steal the turn
    // and the rejoiner is truly back in the rotation, not just a static row
    now += 1_000;
    rollAt(room, io, now, 'p2'); // p2 rolls; p3 is banked (sits out) -> turn wraps to p1new
    expect(io.state('p2').currentId).toBe('p1new');
    now += 1_000;
    const ev = rollAt(room, io, now, 'p1new'); // p1new can roll on their turn
    expect(ev.rollerId).toBe('p1new');
  });
});

// ---- room variants (docs/BANK.md "Room variants") --------------------------
// Variant rooms are built through bankModule.createRoom, the frozen entry
// point that validates settings. The dice stream never depends on settings,
// so probe times found on default-settings rooms replay verbatim: only the
// roll RESOLUTION (effect/pot) and the match-length rules change.

describe('BankRoom variants', () => {
  it('sevenBonus:false — a safe-window 7 adds a plain 7 (no bonus70 effect)', () => {
    // probe on default settings: effect 'bonus70' marks a safe-window sum of 7
    const tRoll = findRollTime([], (ev) => ev.effect === 'bonus70', EPOCH + 1_000);
    const io = new FakeIO();
    const room = bootVariant(io, [['p1', 'Alice'], ['p2', 'Bob']], { sevenBonus: false });
    expect(room.info().label).toBe('10 rounds · plain 7');
    const ev = rollAt(room, io, tRoll); // same seed as the probe => same dice
    expect(ev.d1 + ev.d2).toBe(7);
    expect(ev.effect).toBe('add'); // the plain-7 variant never fires bonus70
    expect(ev.potAfter).toBe(7);
    const st = io.state('p1');
    expect(st.pot).toBe(7);
    expect(st.settings).toEqual({ sevenBonus: false, totalRounds: 10, raceTarget: null });
    expect(st.lastRoll?.effect).toBe('add');
  });

  it('totalRounds:20 — label reflects it and round 10 does NOT end the match', () => {
    const io = new FakeIO();
    const room = bootVariant(io, [['p1', 'Alice'], ['p2', 'Bob']], { totalRounds: 20 });
    expect(room.info().label).toBe('20 rounds · 7=70');
    let st = io.state('p1');
    expect(st.totalRounds).toBe(20);
    expect(st.settings).toEqual({ sevenBonus: true, totalRounds: 20, raceTarget: null });
    // play 10 full rounds (2 safe-window rolls + 2 banks each — never busts)
    let now = EPOCH;
    for (let round = 1; round <= 10; round++) {
      now += 1_000;
      rollAt(room, io, now);
      room.handleMessage('p2', { t: 'bank' });
      now += 1_000;
      rollAt(room, io, now);
      room.handleMessage('p1', { t: 'bank' });
      expect(io.state('p1').phase).toBe('roundEnd');
      expect(io.events('p1', 'round_end')).toHaveLength(round);
      now += ROUND_END_MS;
      vi.advanceTimersByTime(ROUND_END_MS);
    }
    // under the canonical 10-round rules the match would be over; here it isn't
    st = io.state('p1');
    expect(st.phase).toBe('playing');
    expect(st.round).toBe(11);
    expect(st.currentId).toBe('p1');
    expect(io.events('p1', 'match_end')).toHaveLength(0);
  });

  it('race mode (raceTarget:500) — banking past the target ends the match at once', () => {
    const io = new FakeIO();
    const room = bootVariant(io, [['p1', 'Alice'], ['p2', 'Bob']], { raceTarget: 500 });
    expect(room.info().label).toBe('race to 500 · 7=70');
    let st = io.state('p1');
    expect(st.settings).toEqual({ sevenBonus: true, totalRounds: 10, raceTarget: 500 });
    // grow the pot past 500: the safe window can't bust, then hunt doubles
    // (each doubles the pot); every probed time replays deterministically.
    const history: number[] = [EPOCH + 1_000, EPOCH + 2_000, EPOCH + 3_000];
    for (const t of history) rollAt(room, io, t);
    let pot = io.state('p1').pot;
    let t0 = EPOCH + 4_000;
    while (pot < 500) {
      const t = findRollTime(history, (ev) => ev.effect === 'double', t0);
      history.push(t);
      rollAt(room, io, t);
      pot = io.state('p1').pot;
      t0 = t + 1;
    }
    expect(pot).toBeGreaterThanOrEqual(500);
    expect(io.events('p1', 'match_end')).toHaveLength(0); // no round cap in race mode
    room.handleMessage('p1', { t: 'bank' }); // p1's score jumps to >= 500
    const banks = io.events('p1', 'bank');
    expect(banks[banks.length - 1]).toMatchObject({ playerId: 'p1', amount: pot });
    const ends = io.events('p1', 'match_end');
    expect(ends).toHaveLength(1);
    expect(ends[0]).toMatchObject({ winnerId: 'p1' }); // immediate win, no round cap
    st = io.state('p1');
    expect(st.phase).toBe('matchEnd');
    expect(st.winnerId).toBe('p1');
    expect(player(st, 'p1').score).toBe(pot);
    expect(io.events('p1', 'round_end')).toHaveLength(0); // race win skips round_end
    vi.advanceTimersByTime(ROUND_END_MS); // no roundEnd pause runs a new round
    expect(io.state('p1').phase).toBe('matchEnd');
    // the usual matchEnd reset still applies afterwards — into a WAITING lobby
    vi.advanceTimersByTime(MATCH_RESET_MS);
    const st2 = io.state('p1');
    expect(st2.phase).toBe('lobby');
    expect(st2.awaitingStart).toBe(true);
    expect(st2.round).toBe(0);
    expect(player(st2, 'p1').score).toBe(0);
    expect(player(st2, 'p2').score).toBe(0);
    // ...and the manual start opens the next race with the same frozen variant
    room.handleMessage('p1', { t: 'start' });
    const st3 = io.state('p1');
    expect(st3.phase).toBe('playing');
    expect(st3.round).toBe(1);
    expect(st3.settings.raceTarget).toBe(500);
  });

  it('createRoom throws on bad settings (the lobby surfaces bad_settings)', () => {
    const io = new FakeIO();
    // out-of-choice values
    expect(() =>
      bankModule.createRoom({ visibility: 'public', io, settings: { totalRounds: 15 } }),
    ).toThrow();
    expect(() =>
      bankModule.createRoom({ visibility: 'public', io, settings: { raceTarget: 1000 } }),
    ).toThrow();
    // wrong types
    expect(() =>
      bankModule.createRoom({ visibility: 'public', io, settings: { sevenBonus: 'yes' } }),
    ).toThrow();
    expect(() =>
      bankModule.createRoom({ visibility: 'public', io, settings: { totalRounds: '20' } }),
    ).toThrow();
  });
});
