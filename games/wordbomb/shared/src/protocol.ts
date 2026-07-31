// ============================================================================
// FROZEN CONTRACT — WORDBOMB input validation.
// The platform parses only the 8 lobby tags and passes every other {t: string}
// RAW to the room, so this is the game's only guard against malformed or
// hostile input. Never throws (except parseWordbombSettings, by design).
// ============================================================================
import {
  DIFFICULTIES,
  MAX_SUBMIT_LEN,
  ROUNDS_MAX,
  ROUNDS_MIN,
  DEFAULT_SETTINGS,
} from './config.js';
import type { WbC2S, WbDifficulty, WordbombSettings } from './types.js';

export function parseWordbombC2S(raw: unknown): WbC2S | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const t = (raw as { t?: unknown }).t;
  if (t !== 'wb_submit') return null;
  const word = (raw as { word?: unknown }).word;
  if (typeof word !== 'string') return null;
  if (word.length > MAX_SUBMIT_LEN) return null;
  // Freshly constructed, never the caller's object.
  return { t: 'wb_submit', word };
}

/** Runtime guard. Exists so consumers never reach for `as WbDifficulty`. */
export function isWbDifficulty(v: unknown): v is WbDifficulty {
  return v === 'easy' || v === 'normal' || v === 'hard';
}

/**
 * Validate opaque room settings from the lobby.
 * THROWS `Error(message)` on bad input — the platform converts that into
 * `{t:'error', code:'bad_settings', message}`.
 */
export function parseWordbombSettings(raw: unknown): WordbombSettings {
  if (raw === undefined) return { ...DEFAULT_SETTINGS };
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('settings must be an object');
  }
  const obj = raw as Record<string, unknown>;

  let rounds = DEFAULT_SETTINGS.rounds;
  if (obj['rounds'] !== undefined) {
    const r = obj['rounds'];
    if (typeof r !== 'number' || !Number.isInteger(r) || r < ROUNDS_MIN || r > ROUNDS_MAX) {
      throw new Error(`rounds must be an integer ${ROUNDS_MIN}-${ROUNDS_MAX}`);
    }
    rounds = r;
  }

  let difficulty = DEFAULT_SETTINGS.difficulty;
  if (obj['difficulty'] !== undefined) {
    if (!isWbDifficulty(obj['difficulty'])) {
      throw new Error(`difficulty must be one of ${DIFFICULTIES.join(', ')}`);
    }
    difficulty = obj['difficulty'];
  }

  return { rounds, difficulty };
}
