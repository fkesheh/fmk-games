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
export type BankC2S = { t: 'roll' } | { t: 'bank' };

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
  you: string; // the receiving player's id (per-recipient)
}

export type BankEvent =
  | { t: 'roll'; d1: number; d2: number; rollerId: string; effect: RollEffect; potAfter: number }
  | { t: 'bank'; playerId: string; amount: number }
  | { t: 'auto_roll'; playerId: string } // turn timer expired; server rolled for them
  | { t: 'round_end'; reason: 'bust7' | 'all_banked'; round: number }
  | { t: 'match_end'; winnerId: string | null };

// serverTime convention: same as platform — server Date.now() ms.
