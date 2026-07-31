// ============================================================================
// FROZEN CONTRACT — BANK dice game: rules & tuning. Pure data, no logic.
// Canonical rules (BoardGameGeek "Bank"): two dice per turn into a shared pot;
// first SAFE_ROLLS rolls are safe (a 7 there is worth SEVEN_BONUS); afterwards
// a 7 busts the round (pot lost) and doubles double the pot. Any player may
// bank the current pot at any time and sits out the rest of the round.
// ============================================================================

export const SAFE_ROLLS = 3;
export const SEVEN_BONUS = 70;
export const TOTAL_ROUNDS = 10;
export const MAX_PLAYERS = 32;
export const MIN_PLAYERS = 2;

// A round ends on a bust-7 or when everyone has banked; with SAFE_ROLLS = 3 and
// P(7) = 1/6 after that, the expected rolls per round is ~9 REGARDLESS of the
// seat count. So a 32-seat table does not run longer than an 8-seat one — but
// most seats never roll in a given round, and a player can wait ~32 turns
// between their own actions. 12 s is the pacing answer to that: it cannot
// create participation the rules do not produce, but it cuts the dead time a
// waiting player sits through by 60 %. The client's "up next" queue (game.ts)
// is the orientation half of the same fix, and the round-start seam in
// `room.ts` (`roundStartIndex`) is where the participation half would go.
export const TURN_SECONDS = 12; // auto-roll for the current player on expiry
export const ROUND_END_SECONDS = 5; // pause showing the outcome before next round
export const MATCH_RESET_SECONDS = 8; // matchEnd -> full reset to lobby
export const STALE_MS = 300_000; // idle player sweep (watching after banking is fine)

// ---- variant defaults & validation (room creation settings) ----
export const DEFAULT_SETTINGS: import('./types.js').BankSettings = {
  sevenBonus: true,
  totalRounds: 10,
  raceTarget: null,
};
export const ROUND_CHOICES = [10, 20] as const;
export const RACE_CHOICES = [500] as const;
