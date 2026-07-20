// ============================================================================
// FROZEN CONTRACT — BANK dice game: dice + roll resolution. Deterministic,
// pure, no I/O. Server uses rng(Date.now() ^ tick) streams for live rolls;
// tests inject their own seeded stream.
// ============================================================================
import { SAFE_ROLLS, SEVEN_BONUS } from './config.js';
import type { RollEffect } from './types.js';

/** Two d6 from a seeded rng stream (values 1..6 each). */
export function rollDice(next: () => number): [number, number] {
  return [1 + Math.floor(next() * 6), 1 + Math.floor(next() * 6)];
}

/**
 * Resolve a roll against the round's roll count (1-based: the roll JUST taken).
 * - Safe window (rollCount <= SAFE_ROLLS): sum 7 => +SEVEN_BONUS; everything
 *   else => +sum (doubles do NOT double in the safe window).
 * - After the safe window: sum 7 => bust; doubles => double the pot; else +sum.
 */
export function rollEffect(
  d1: number,
  d2: number,
  rollCount: number,
): { effect: RollEffect; apply: (pot: number) => number } {
  const sum = d1 + d2;
  if (rollCount <= SAFE_ROLLS) {
    return sum === 7
      ? { effect: 'bonus70', apply: (pot) => pot + SEVEN_BONUS }
      : { effect: 'add', apply: (pot) => pot + sum };
  }
  if (sum === 7) return { effect: 'bust7', apply: (pot) => pot };
  if (d1 === d2) return { effect: 'double', apply: (pot) => pot * 2 };
  return { effect: 'add', apply: (pot) => pot + sum };
}
