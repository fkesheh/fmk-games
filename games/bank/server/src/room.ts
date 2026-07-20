// ============================================================================
// BANK room (docs/BANK.md) — authoritative, turn-based, event-driven (no tick
// loop). Two dice per turn into a shared pot; banking locks the pot in for one
// player and it KEEPS GROWING for the rest; a post-safe-window 7 busts the
// round. Match length + variant come from the frozen BankSettings (default:
// 10 rounds, 7=70, no race), then a full reset through the lobby rules. Race
// mode (raceTarget set): the match ends the MOMENT a bank takes a player to
// >= raceTarget. Timers (one at a time): 30s turn auto-roll, 5s roundEnd
// pause, 8s matchEnd reset. Behavioral invariants: docs/BANK.md "Server:
// room.ts". Never throws.
// ============================================================================
import {
  DEFAULT_SETTINGS,
  MATCH_RESET_SECONDS,
  MAX_PLAYERS,
  MIN_PLAYERS,
  ROUND_END_SECONDS,
  SAFE_ROLLS,
  STALE_MS,
  TURN_SECONDS,
  parseBankC2S,
  rollDice,
  rollEffect,
} from '@bank/shared';
import type {
  BankEvent,
  BankPhase,
  BankPlayerState,
  BankSettings,
  BankState,
  LastRoll,
} from '@bank/shared';
import { rng, rngInt } from '@platform/shared';
import type {
  GameRoomHandle,
  PlayerId,
  RoomId,
  RoomInfo,
  RoomIO,
  Visibility,
} from '@platform/shared';

const ROOM_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const PRIVATE_CODE_LEN = 5; // A-Z0-9 join code, same convention as the fps room
let roomSeq = 0; // mixes into the rng seed so same-ms rooms still differ

function randomToken(next: () => number, len: number): string {
  let s = '';
  for (let i = 0; i < len; i++) s += ROOM_ALPHABET.charAt(rngInt(next, 0, ROOM_ALPHABET.length - 1));
  return s;
}

/**
 * Server-side player record, join order = Map insertion order. Entries persist
 * (connected=false) when a player leaves: scores survive a low-pop abort and a
 * same-session rejoin, and the wire type carries `connected` for the rail.
 */
interface Player {
  id: PlayerId;
  name: string;
  score: number; // banked total across the match
  banked: boolean; // sits out the rest of the round (banked or joined mid-round)
  connected: boolean;
  lastMsgAt: number; // serverTime ms of last room-level message; stale sweep
}

export class BankRoom implements GameRoomHandle {
  readonly id: RoomId;
  readonly code: string | null;
  readonly visibility: Visibility;

  private readonly io: RoomIO;
  private readonly settings: BankSettings; // frozen variant for this room's lifetime
  private readonly players = new Map<PlayerId, Player>(); // insertion order = join order

  private phase: BankPhase = 'lobby';
  private round = 0; // 0 outside a match, 1..settings.totalRounds during play
  private pot = 0;
  private rollCount = 0; // rolls taken THIS round (safe window = first SAFE_ROLLS)
  private rollCounter = 0; // ever-increasing per-roll stream salt
  private currentId: PlayerId | null = null; // whose turn to roll (null outside 'playing')
  private turnEndsAt = 0; // serverTime ms; 0 when no turn timer runs
  private lastRoll: LastRoll | null = null;
  private winnerId: PlayerId | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null; // one phase timer at a time
  private stopped = false;

  constructor(visibility: Visibility, io: RoomIO, settings: BankSettings = DEFAULT_SETTINGS) {
    this.visibility = visibility;
    this.io = io;
    this.settings = { ...settings }; // defensive copy: the variant never mutates
    // server-side generation (room id, private code) uses rng(Date.now())
    const next = rng((Date.now() ^ (roomSeq++ * 0x9e3779b9)) >>> 0);
    this.id = randomToken(next, 8);
    this.code = visibility === 'private' ? randomToken(next, PRIVATE_CODE_LEN) : null;
  }

  /** Contract label: "10 rounds · 7=70" / "20 rounds · plain 7" / "race to 500 · 7=70". */
  private variantLabel(): string {
    const bonus = this.settings.sevenBonus ? '7=70' : 'plain 7';
    return this.settings.raceTarget !== null
      ? `race to ${this.settings.raceTarget} · ${bonus}`
      : `${this.settings.totalRounds} rounds · ${bonus}`;
  }

  info(): RoomInfo {
    return {
      id: this.id,
      code: this.code,
      game: 'bank',
      label: this.variantLabel(),
      players: this.playerCount(),
      maxPlayers: MAX_PLAYERS,
      phase: this.phase,
      visibility: this.visibility,
    };
  }

  /** Connected players only — disconnected entries hold no slot. */
  playerCount(): number {
    let n = 0;
    for (const p of this.players.values()) if (p.connected) n++;
    return n;
  }

  /** Connected players with no room-level message for STALE_MS. */
  stalePlayers(): PlayerId[] {
    const now = Date.now();
    const out: PlayerId[] = [];
    for (const p of this.players.values()) {
      if (p.connected && now - p.lastMsgAt > STALE_MS) out.push(p.id);
    }
    return out;
  }

  addPlayer(id: PlayerId, name: string): void {
    try {
      const now = Date.now();
      const existing = this.players.get(id);
      if (existing !== undefined) {
        // same-session rejoin: keep score + join-order slot, watch this round
        existing.connected = true;
        existing.name = name;
        existing.lastMsgAt = now;
        if (this.phase === 'playing' || this.phase === 'roundEnd') existing.banked = true;
      } else {
        if (this.playerCount() >= MAX_PLAYERS) {
          // unreachable via the lobby (it guards room_full first); never throws
          this.io.send(id, { t: 'error', code: 'room_full', message: 'room is full' });
          return;
        }
        // mid-match joiners go to the END of the order and play from the NEXT
        // round; this round they watch with banked=true
        this.players.set(id, {
          id,
          name,
          score: 0,
          banked: this.phase === 'playing' || this.phase === 'roundEnd',
          connected: true,
          lastMsgAt: now,
        });
      }
      // lobby fills up -> round 1 starts immediately (a NEW match resets scores)
      if (this.phase === 'lobby' && this.playerCount() >= MIN_PLAYERS) {
        this.startMatch(); // broadcasts fresh state to everyone, joiner included
        return;
      }
      this.broadcastState();
    } catch (err) {
      console.error('[bank] addPlayer failed', err);
    }
  }

  removePlayer(id: PlayerId): void {
    try {
      const p = this.players.get(id);
      if (p === undefined || !p.connected) return;
      p.connected = false; // entry + score persist (rejoin / low-pop abort)
      if (this.phase === 'playing' || this.phase === 'roundEnd') {
        if (this.playerCount() < MIN_PLAYERS) {
          this.abortToLobby(); // scores KEPT; the next match resets them
        } else if (this.phase === 'playing') {
          if (this.allConnectedBanked()) this.endRound('all_banked');
          else if (this.currentId === id) this.nextTurn(); // it was their turn: advance
        }
      }
      this.broadcastState();
    } catch (err) {
      console.error('[bank] removePlayer failed', err);
    }
  }

  handleMessage(id: PlayerId, msg: unknown): void {
    try {
      const parsed = parseBankC2S(msg);
      if (parsed === null) return;
      const p = this.players.get(id);
      if (p === undefined || !p.connected) return;
      p.lastMsgAt = Date.now();
      if (parsed.t === 'roll') this.tryRoll(p);
      else this.tryBank(p);
    } catch (err) {
      console.error('[bank] handleMessage failed', err);
    }
  }

  start(): void {
    this.stopped = false; // idempotent — event-driven, no loop to start
  }

  stop(): void {
    this.stopped = true;
    this.clearTimer();
  }

  // -------------------------------------------------------------------------
  // Match flow
  // -------------------------------------------------------------------------

  /** Round 1 from the lobby: a NEW match, so scores reset (low-pop abort kept them). */
  private startMatch(): void {
    for (const p of this.players.values()) {
      p.score = 0;
      p.banked = false;
    }
    this.round = 1;
    this.pot = 0;
    this.rollCount = 0;
    this.lastRoll = null;
    this.winnerId = null;
    this.phase = 'playing';
    this.currentId = this.firstConnectedId();
    this.startTurnTimer();
    this.broadcastState();
  }

  /**
   * Next round after the roundEnd pause. Normal mode: the end of round
   * settings.totalRounds goes to matchEnd. Race mode has no round cap (the
   * match ends only on a bank reaching raceTarget).
   */
  private startNextRound(): void {
    if (this.settings.raceTarget === null && this.round >= this.settings.totalRounds) {
      this.endMatch();
      return;
    }
    this.round++;
    for (const p of this.players.values()) p.banked = false;
    this.pot = 0;
    this.rollCount = 0;
    this.lastRoll = null;
    this.phase = 'playing';
    this.currentId = this.firstConnectedId();
    this.startTurnTimer();
    this.broadcastState();
  }

  /** bust7 (pot lost) or all_banked; the pot shows 0 already for the next round. */
  private endRound(reason: 'bust7' | 'all_banked'): void {
    this.broadcastEvent({ t: 'round_end', reason, round: this.round });
    this.phase = 'roundEnd';
    this.pot = 0;
    this.currentId = null;
    this.turnEndsAt = 0;
    this.setTimer(() => this.startNextRound(), ROUND_END_SECONDS * 1000);
  }

  /**
   * match_end + reset timer. `raceWinner` is set only by race mode (the bank
   * that crossed raceTarget wins instantly); otherwise highest score, ties
   * broken by join order.
   */
  private endMatch(raceWinner?: PlayerId): void {
    this.winnerId = raceWinner ?? this.computeWinnerId();
    this.phase = 'matchEnd';
    this.currentId = null;
    this.turnEndsAt = 0;
    this.broadcastEvent({ t: 'match_end', winnerId: this.winnerId });
    this.setTimer(() => this.fullReset(), MATCH_RESET_SECONDS * 1000);
    this.broadcastState(); // timer-driven transition: no caller broadcasts after us
  }

  /** matchEnd -> FULL reset, then lobby rules (>= MIN_PLAYERS restarts at once). */
  private fullReset(): void {
    for (const p of this.players.values()) {
      p.score = 0;
      p.banked = false;
    }
    this.round = 0;
    this.pot = 0;
    this.rollCount = 0;
    this.lastRoll = null;
    this.winnerId = null;
    this.currentId = null;
    this.turnEndsAt = 0;
    this.phase = 'lobby';
    if (this.playerCount() >= MIN_PLAYERS) {
      this.startMatch();
      return;
    }
    this.broadcastState();
  }

  /** Low pop mid-match: abort to the lobby with scores KEPT for a rejoiner. */
  private abortToLobby(): void {
    this.phase = 'lobby';
    this.round = 0;
    this.pot = 0;
    this.rollCount = 0;
    this.lastRoll = null;
    this.winnerId = null;
    this.currentId = null;
    this.turnEndsAt = 0;
    this.clearTimer();
  }

  // -------------------------------------------------------------------------
  // Roll / bank
  // -------------------------------------------------------------------------

  /** A roll is accepted only from the current player, only in 'playing'. */
  private tryRoll(p: Player): void {
    if (this.phase !== 'playing' || this.currentId !== p.id) return;
    this.doRoll(p.id);
  }

  private doRoll(rollerId: PlayerId): void {
    this.rollCount++;
    this.rollCounter++;
    // per-roll seeded stream (frozen): rng(Date.now() ^ (rollCounter * 2654435761))
    const next = rng((Date.now() ^ (this.rollCounter * 2654435761)) >>> 0);
    const [d1, d2] = rollDice(next);
    const { effect, apply } = rollEffect(d1, d2, this.rollCount, this.settings.sevenBonus);
    this.pot = apply(this.pot);
    this.lastRoll = { d1, d2, rollerId, effect, potAfter: this.pot };
    this.broadcastEvent({ t: 'roll', d1, d2, rollerId, effect, potAfter: this.pot });
    if (effect === 'bust7') this.endRound('bust7'); // pot lost
    else this.nextTurn();
    this.broadcastState();
  }

  /** Any connected non-banked player, ANY time in 'playing'; the pot NEVER resets. */
  private tryBank(p: Player): void {
    if (this.phase !== 'playing' || p.banked) return;
    p.score += this.pot;
    p.banked = true;
    this.broadcastEvent({ t: 'bank', playerId: p.id, amount: this.pot });
    // race mode: the match ends the MOMENT a bank reaches the target — the
    // match_end event fires right after this bank event
    if (this.settings.raceTarget !== null && p.score >= this.settings.raceTarget) {
      this.endMatch(p.id);
    } else if (this.allConnectedBanked()) this.endRound('all_banked');
    else if (this.currentId === p.id) this.nextTurn();
    this.broadcastState();
  }

  /** Pass the turn to the next connected, non-banked player in join order. */
  private nextTurn(): void {
    const order = [...this.players.values()];
    const from = order.findIndex((p) => p.id === this.currentId);
    for (let step = 1; step <= order.length; step++) {
      const cand = order[(from + step) % order.length];
      if (cand !== undefined && cand.connected && !cand.banked) {
        this.currentId = cand.id;
        this.startTurnTimer();
        return;
      }
    }
    // nobody eligible: every connected player has banked
    this.endRound('all_banked');
  }

  // -------------------------------------------------------------------------
  // Timers
  // -------------------------------------------------------------------------

  private startTurnTimer(): void {
    this.turnEndsAt = Date.now() + TURN_SECONDS * 1000;
    this.setTimer(() => this.autoRoll(), TURN_SECONDS * 1000);
  }

  /** Turn expiry: announce auto_roll first, then roll for the current player. */
  private autoRoll(): void {
    if (this.phase !== 'playing' || this.currentId === null) return;
    const rollerId = this.currentId;
    this.broadcastEvent({ t: 'auto_roll', playerId: rollerId });
    this.doRoll(rollerId);
  }

  private setTimer(fn: () => void, ms: number): void {
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.stopped) return;
      try {
        fn();
      } catch (err) {
        console.error('[bank] timer failed', err);
      }
    }, ms);
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private firstConnectedId(): PlayerId | null {
    for (const p of this.players.values()) {
      if (p.connected) return p.id;
    }
    return null;
  }

  private allConnectedBanked(): boolean {
    for (const p of this.players.values()) {
      if (p.connected && !p.banked) return false;
    }
    return true;
  }

  /** Highest score among connected players; ties break by join order. */
  private computeWinnerId(): PlayerId | null {
    let best: Player | null = null;
    for (const p of this.players.values()) {
      if (!p.connected) continue;
      if (best === null || p.score > best.score) best = p;
    }
    return best?.id ?? null;
  }

  private stateFor(you: PlayerId): BankState {
    const players: BankPlayerState[] = [];
    for (const p of this.players.values()) {
      players.push({
        id: p.id,
        name: p.name,
        score: p.score,
        banked: p.banked,
        connected: p.connected,
      });
    }
    return {
      t: 'bank_state',
      phase: this.phase,
      settings: this.settings, // frozen variant; never mutated, shared by reference
      round: this.round,
      totalRounds: this.settings.totalRounds,
      pot: this.pot,
      rollCount: this.rollCount,
      safeRolls: SAFE_ROLLS,
      currentId: this.currentId,
      turnEndsAt: this.turnEndsAt,
      players,
      lastRoll: this.lastRoll,
      winnerId: this.winnerId,
      you,
    };
  }

  /** Fresh per-recipient state (the `you` field differs). */
  private broadcastState(): void {
    for (const p of this.players.values()) {
      if (p.connected) this.io.send(p.id, this.stateFor(p.id));
    }
  }

  // one shared message object per event: Session.send JSON-encodes synchronously
  private broadcastEvent(ev: BankEvent): void {
    const msg = { t: 'event', ev };
    for (const p of this.players.values()) {
      if (p.connected) this.io.send(p.id, msg);
    }
  }
}
