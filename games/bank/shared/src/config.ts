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
export const MAX_PLAYERS = 8;
export const MIN_PLAYERS = 2;

export const TURN_SECONDS = 30; // auto-roll for the current player on expiry
export const ROUND_END_SECONDS = 5; // pause showing the outcome before next round
export const MATCH_RESET_SECONDS = 8; // matchEnd -> full reset to lobby
export const STALE_MS = 300_000; // idle player sweep (watching after banking is fine)
