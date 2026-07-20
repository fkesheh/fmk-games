// ============================================================================
// FROZEN CONTRACT — BANK dice game: room-level wire validation.
// ============================================================================
import type { BankC2S } from './types.js';

/** Parse + sanitize a raw decoded JSON value into a BankC2S message, or null. */
export function parseBankC2S(raw: unknown): BankC2S | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const t = (raw as Record<string, unknown>).t;
  if (t === 'roll') return { t: 'roll' };
  if (t === 'bank') return { t: 'bank' };
  return null;
}
