// ============================================================================
// FROZEN CONTRACT — BANK dice game: wire types. See docs/BANK.md.
// ============================================================================

export type BankPhase = 'lobby' | 'playing' | 'roundEnd' | 'matchEnd';

/** Room rule variants, chosen at creation (platform passes them opaquely). */
export interface BankSettings {
  sevenBonus: boolean; // true: a 7 in the safe window is worth 70; false: plain 7
  totalRounds: number; // 10 | 20 — ignored when raceTarget is set
  raceTarget: number | null; // 500 => race mode: first player to bank >= 500 wins immediately
}


/** Room-level messages (the platform lobby handles join/leave/list itself). */
/**
 * `start` is the ONLY way out of `lobby`. NO match ever begins by itself — not
 * the first one of a cold room, not the one after a finished match. There is no
 * host: any seated player may send it. It is a request, never a command — the
 * room ignores it silently outside `lobby` or below MIN_PLAYERS, and never
 * throws. `canStart` on the wire tells the client whether it would be accepted.
 */
export type BankC2S = { t: 'roll' } | { t: 'bank' } | { t: 'start' };

export interface BankPlayerState {
  id: string;
  name: string;
  score: number; // banked total across the match
  banked: boolean; // has banked this round (sits out the rest of it)
  connected: boolean;
}

export type RollEffect = 'add' | 'bonus70' | 'double' | 'bust7';

export interface LastRoll {
  d1: number; // 1..6
  d2: number;
  rollerId: string;
  effect: RollEffect;
  potAfter: number;
}

/** Full room state; sent to every player on join and after every action. */
export interface BankState {
  t: 'bank_state';
  phase: BankPhase;
  settings: BankSettings; // the variant this room is playing
  round: number; // 1-based during play
  totalRounds: number;
  pot: number;
  rollCount: number; // rolls taken THIS round (safe-rolls window = first 3)
  safeRolls: number;
  currentId: string | null; // whose turn to roll (null outside 'playing')
  turnEndsAt: number; // serverTime ms; 0 when no timer runs
  players: BankPlayerState[]; // join order
  lastRoll: LastRoll | null;
  winnerId: string | null; // set at matchEnd
  code: string | null; // the room's private join code (null for public rooms)
  /**
   * COSMETIC ONLY. True in a POST-MATCH lobby (the previous match finished and
   * the room reset), false in a cold lobby and during play. BOTH lobbies wait
   * for `{t:'start'}` — this bit only lets the client say "match complete"
   * instead of "waiting for players". Never gate the START control on it.
   */
  awaitingStart: boolean;
  /**
   * The three fields the lobby UI needs, straight from the server so no client
   * ever hardcodes the rule. `playerCount` counts CONNECTED seats (the same
   * number `{t:'start'}` is validated against — disconnected entries in
   * `players` hold no seat), `minPlayers` mirrors MIN_PLAYERS, and `canStart`
   * is exactly `phase === 'lobby' && playerCount >= minPlayers`: true iff a
   * `{t:'start'}` sent right now would be accepted.
   */
  playerCount: number;
  minPlayers: number;
  canStart: boolean;
  you: string; // the receiving player's id (per-recipient)
}

export type BankEvent =
  | { t: 'roll'; d1: number; d2: number; rollerId: string; effect: RollEffect; potAfter: number }
  | { t: 'bank'; playerId: string; amount: number }
  | { t: 'auto_roll'; playerId: string } // turn timer expired; server rolled for them
  | { t: 'round_end'; reason: 'bust7' | 'all_banked'; round: number }
  | { t: 'match_end'; winnerId: string | null };

// serverTime convention: same as platform — server Date.now() ms.
