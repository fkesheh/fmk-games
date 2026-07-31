// ============================================================================
// WORDBOMB — fragment selection (W2). Implements the `FragmentPicker` seam in
// `ports.ts`.
//
// SCOPE. This file owns SELECTION and nothing else. It never reads the blob,
// never counts words and never re-derives a fragment table — it consumes the
// `DictBundle` W1 produces (docs/WORDBOMB.md §7, "seam rules").
//
// BAND MEMBERSHIP IS NOT RE-IMPLEMENTED HERE. `bandOf()` in @wordbomb/shared is
// the single source of truth for the boundaries, which are half-open
// [minInclusive, maxExclusive). Writing `common >= 200 && common <= 400` by hand
// puts `common === 400` in two tiers at once (easy is [200,400), and 400 is also
// >= the easy floor under a naive inclusive test) and quietly re-admits the
// trivial `ing`/`er` tier that the ladder deliberately excludes.
//
// DETERMINISM. `rand` is injected on every `pick()` so `prompts.test.ts` can
// drive selection with a seeded generator. `Math.random` is never called from
// this module.
// ============================================================================
import {
  DIFFICULTIES,
  FRAGMENT_MAX_LEN,
  FRAGMENT_MIN_LEN,
  bandOf,
} from '@wordbomb/shared';
import type { WbDifficulty } from '@wordbomb/shared';

import type { DictBundle, FragmentPicker } from './ports.js';

/**
 * LAST-RESORT FRAGMENT — only reachable if a difficulty pool is completely
 * empty, i.e. the `DictBundle` is broken (empty blob, failed derivation). It
 * exists solely so `pick()` can honour "MUST NOT throw" (I6/I5) instead of
 * returning `undefined` into `WbPublicState.fragment` and taking the room down.
 *
 * `ing` is chosen because it is the most answerable 3-letter fragment in
 * English — a degraded room is still playable. It is intentionally NOT in any
 * band (its `common` count is far above the easy ceiling of 400), so it can
 * never be produced by normal operation and its appearance in a log is an
 * unambiguous signal that the dictionary failed to load.
 */
const LAST_RESORT_FRAGMENT = 'ing';

/**
 * Uniform integer in [0, length) from an injected `rand`.
 *
 * Defensive because `rand` is a caller-supplied function: a generator returning
 * NaN, a negative number, or exactly 1.0 must not produce an out-of-range index
 * (which would yield `undefined` under `noUncheckedIndexedAccess` and, unhandled,
 * a thrown or malformed fragment).
 */
function indexOf(rand: () => number, length: number): number {
  if (length <= 0) return 0;
  const r = rand();
  const unit = Number.isFinite(r) ? r : 0;
  const i = Math.floor(unit * length);
  if (!Number.isFinite(i) || i < 0) return 0;
  return i >= length ? length - 1 : i;
}

/**
 * Build the three pools once, then serve every room from them.
 *
 * The picker is stateless with respect to a match: the room owns the per-match
 * `used` set and passes it in, so one picker instance serves every concurrent
 * room without any cross-room coupling.
 */
export function createPicker(bundle: DictBundle): FragmentPicker {
  const pools: Record<WbDifficulty, string[]> = { easy: [], normal: [], hard: [] };

  for (const [fragment, stats] of bundle.fragments()) {
    // THREE-LETTER FRAGMENTS ONLY (config.ts: FRAGMENT_MIN_LEN === FRAGMENT_MAX_LEN === 3).
    // W1's table is specified to hold only 3-letter fragments, but the pools are
    // the last gate before a prompt reaches a player, so the length is enforced
    // here rather than assumed.
    if (fragment.length < FRAGMENT_MIN_LEN || fragment.length > FRAGMENT_MAX_LEN) continue;
    const band = bandOf(stats.common);
    // `null` = outside every band: either trivial (common >= 400) or humanly
    // unanswerable (common < 40). Both are excluded from play entirely.
    if (band === null) continue;
    pools[band].push(fragment);
  }

  // Sorted so pool ORDER — and therefore the sequence a seeded `rand` produces —
  // depends only on the word list, never on `Map` insertion order inside W1.
  // Without this, an unrelated change to the derivation pass would silently
  // change every seeded test's expected fragments.
  for (const difficulty of DIFFICULTIES) {
    pools[difficulty].sort();
  }

  return {
    pick(difficulty: WbDifficulty, used: ReadonlySet<string>, rand: () => number): string {
      const pool = pools[difficulty];

      // The normal path: choose uniformly among the fragments this match has not
      // used yet. Filtering (rather than resampling until a miss) makes the cost
      // bounded at O(pool) — ~969 string compares once per round — and keeps the
      // distribution exactly uniform over the unused remainder, which resampling
      // from a shrinking pool does not guarantee in bounded time.
      const available: string[] = [];
      for (const fragment of pool) {
        if (!used.has(fragment)) available.push(fragment);
      }

      const fromAvailable = available[indexOf(rand, available.length)];
      if (fromAvailable !== undefined) return fromAvailable;

      // ---- degraded paths. Unreachable in production; each MUST NOT throw. ----
      //
      // Pools measure 512/969/851 against a ROUNDS_MAX of 20, so `available` is
      // empty only if the pool itself is empty or a caller passed a `used` set
      // larger than the entire band. Neither can happen with a healthy bundle.

      // (a) Pool non-empty but everything is used: I5 (never repeat) is already
      //     unsatisfiable, so satisfy the stronger rule — never throw, always
      //     return a real playable fragment — and repeat rather than fail.
      const fromPool = pool[indexOf(rand, pool.length)];
      if (fromPool !== undefined) return fromPool;

      // (b) This band's pool is empty. Fall back to another band's unused
      //     fragments: a prompt at the wrong difficulty is far better than a
      //     broken round, and the sequence stays repeat-free.
      for (const other of DIFFICULTIES) {
        if (other === difficulty) continue;
        for (const fragment of pools[other]) {
          if (!used.has(fragment)) return fragment;
        }
      }

      // (c) Every pool is empty — the bundle failed to derive anything at all.
      return LAST_RESORT_FRAGMENT;
    },

    poolSize(difficulty: WbDifficulty): number {
      return pools[difficulty].length;
    },
  };
}
