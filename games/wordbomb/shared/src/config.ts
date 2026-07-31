// ============================================================================
// FROZEN CONTRACT — WORDBOMB balance constants. PURE DATA + tiny pure helpers
// whose only job is to make a boundary rule single-sourced.
// ============================================================================
import type { WbDifficulty, WordbombSettings } from './types.js';

// ---- match shape -------------------------------------------------------------
export const ROUNDS_DEFAULT = 10;
export const ROUNDS_MIN = 5;
export const ROUNDS_MAX = 20;

export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 8;

// ---- timing (ms) -------------------------------------------------------------
/**
 * The fuse is drawn uniformly from [FUSE_MIN_MS, FUSE_MAX_MS] and is NEVER sent
 * to clients in any field — see the note on `WbPublicState.fuseMinMs`. The
 * unknown remainder is what turns re-locking into a gamble.
 */
export const FUSE_MIN_MS = 8_000;
export const FUSE_MAX_MS = 15_000;
/** Reading the reveal — who collided with whom — is part of the game. */
export const REVEAL_MS = 6_000;
/** Grace after MIN_PLAYERS is reached, so round 1 is not a cold start. */
export const LOBBY_COUNTDOWN_MS = 3_000;
/** How long final standings hold before the room resets to lobby. */
export const MATCH_END_MS = 12_000;
/** Matches BANK. Platform closes sockets of players idle this long. */
export const STALE_MS = 300_000;

/**
 * LATENCY GRACE. The game deliberately pushes players to lock at the last
 * possible instant, so a submission sent before the boom but arriving after it
 * is the COMMON case, not an edge case. Without this, a 180ms-RTT player loses
 * words a 20ms-RTT player scores — the game would silently reward connection
 * quality over vocabulary.
 *
 * Rule: the bomb VISUALLY explodes at fuse expiry, but scoring closes
 * SUBMIT_GRACE_MS later; a `wb_submit` landing inside that window is folded
 * into the round that just closed.
 */
export const SUBMIT_GRACE_MS = 250;

// ---- anti-abuse --------------------------------------------------------------
/**
 * Without these, the per-failure reject reason is a dictionary ORACLE: spray
 * candidate strings, read `not_a_word` vs accepted, and you have rebuilt the
 * auto-solver that I2 exists to prevent — over the wire, with no dictionary in
 * the bundle. Rate limiting is what makes I2 true rather than aspirational.
 *
 * Budget is per player per ROUND, so a normal player (a few re-locks) never
 * notices and a sprayer exhausts it immediately.
 */
export const SUBMIT_COOLDOWN_MS = 400;
export const MAX_SUBMITS_PER_ROUND = 20;
/** Hard wire cap, enforced by the parser before any game rule. */
export const MAX_SUBMIT_LEN = 64;

// ---- scoring -----------------------------------------------------------------
export const MIN_WORD_LEN = 3;
/** Longest word the dictionary holds; above this we say `too_long`, not `not_a_word`. */
export const MAX_WORD_LEN = 15;
/**
 * points = floor(min(len, MAX_SCORING_LEN)^2 / dupes)
 *
 * The cap exists because length^2 is unbounded:
 * `antidisestablishmentarianism` would score 784 and decide a match on its own.
 * 12 caps a perfect word at 144 — ambition still pays, one memorised party
 * trick does not win the game.
 */
export const MAX_SCORING_LEN = 12;

// ---- prompt difficulty -------------------------------------------------------
/**
 * A BAND of `common` counts (words of length <= COMMON_MAX_LEN containing the
 * fragment), not merely a minimum. A pure minimum does not work: "hard = at
 * least 40 words" is ALSO satisfied by `ing` and `er`, so the hard tier would
 * mostly serve trivial prompts. Bands keep the tiers distinct.
 *
 * THE LADDER SITS WHERE IT DOES BECAUSE OF A MEASURED SIGN FLIP. Simulation
 * showed the strategic tension (does hunting a unique word beat brute length?)
 * only exists below `common ~= 400`; above it, collision rates fall to ~5-18%
 * and going long simply wins. Fragments at `common >= 400` are therefore
 * EXCLUDED entirely as trivial — they are the `ing`/`er`/`st` tier and they
 * have no game in them.
 *
 * Measured pools over the filtered 269,746-word list, 3-letter fragments only:
 *   easy    common in [200, 400) -> 512 fragments  (cou, met, own, rep, ugh)
 *   normal  common in [ 80, 200) -> 969 fragments  (bet, dip, inf, nor, owl)
 *   hard    common in [ 40,  80) -> 851 fragments  (bom, hyp, mig, vor, ecr)
 *
 * The floor of 40 is deliberate: below it, fragments are technically legal and
 * humanly unanswerable. Every pool dwarfs ROUNDS_MAX, so I5 holds with room.
 *
 * Bounds are [minInclusive, maxExclusive). Use `bandOf()` — do not re-implement
 * the comparison, or `common === 400` lands in two tiers.
 */
export const DIFFICULTY_BANDS: Record<
  WbDifficulty,
  { minInclusive: number; maxExclusive: number }
> = {
  easy: { minInclusive: 200, maxExclusive: 400 },
  normal: { minInclusive: 80, maxExclusive: 200 },
  hard: { minInclusive: 40, maxExclusive: 80 },
};

/** The single source of truth for which tier a fragment belongs to. */
export function bandOf(common: number): WbDifficulty | null {
  for (const d of DIFFICULTIES) {
    const b = DIFFICULTY_BANDS[d];
    if (common >= b.minInclusive && common < b.maxExclusive) return d;
  }
  return null;
}

/** A pool smaller than this is a build failure — see I5. */
export const MIN_POOL_SIZE = 60;

/**
 * THREE-LETTER FRAGMENTS ONLY.
 *
 * 2-letter fragments were originally allowed on the assumption they would land
 * harmlessly in `easy`. Measurement killed that: once the ladder moved down,
 * the GOOD 2-letter pairs (`er`, `in`, `st`) were excluded as trivial and the
 * survivors were junk — `iu`, `ix`, `dj`, `aq`, `ez`. Nobody thinks "give me a
 * word containing IU". Dropping them costs 41/59/54 fragments per band and
 * leaves 512/969/851, still an order of magnitude above ROUNDS_MAX.
 */
export const FRAGMENT_MIN_LEN = 3;
export const FRAGMENT_MAX_LEN = 3;

/** Words no longer than this count toward the `common` proxy. */
export const COMMON_MAX_LEN = 8;

/** Dictionary filter applied at preprocessing time. */
export const DICT_WORD_RE = /^[a-z]{3,15}$/;

// ---- settings ----------------------------------------------------------------
export const DIFFICULTIES = ['easy', 'normal', 'hard'] as const;

export const DEFAULT_SETTINGS: WordbombSettings = {
  rounds: ROUNDS_DEFAULT,
  difficulty: 'normal',
};
