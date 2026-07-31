// ============================================================================
// FROZEN CONTRACT — the server-internal seams.
//
// WHY THIS FILE EXISTS. The wire protocol in @wordbomb/shared freezes how the
// CLIENT and SERVER talk. It says nothing about how W1 (dictionary), W2
// (prompt selection), W3 (room) and W4 (module plug) talk to EACH OTHER — and
// those four run in parallel. Without this file each would invent its own
// `isWord()`, its own picker and its own room constructor, and integration
// would be a rewrite. Every signature here is immutable.
//
// Implementers own the BODIES behind these types, never the types.
// ============================================================================
import type { RoomIO, Visibility } from '@platform/shared';
import type { WbDifficulty, WordbombSettings } from '@wordbomb/shared';

// ---- W1: the dictionary ------------------------------------------------------
/**
 * Word lookup. Deliberately minimal — the room asks one question.
 *
 * NO SEARCH ALGORITHM IS SPECIFIED HERE, ON PURPOSE. The architect's own
 * binary-search sketch had an inverted comparison and reported all 269,746
 * words missing while looking entirely reasonable. Correctness is proved by
 * `dict.test.ts` (exhaustive round-trip), not by copying pseudocode.
 *
 * Implementation constraints (docs/WORDBOMB.md §3.1):
 *  - the blob is loaded as a `Buffer` — never `readFileSync(..., 'utf8')`
 *  - a `Set<string>` of the full list is a contract violation (~43 MB resident)
 *  - budget: under 8 MB RSS for blob + index + pools, measured and reported
 */
export interface Dict {
  has(word: string): boolean;
  readonly size: number;
}

/**
 * Per-fragment counts, derived in the SAME single pass that builds the word
 * index — never a committed artifact, so it cannot drift from the word list.
 */
export interface FragmentStats {
  /** All dictionary words containing the fragment. */
  total: number;
  /** Words of length <= COMMON_MAX_LEN containing it — the difficulty key. */
  common: number;
}

/**
 * Built once at server start. Owns the blob, the sparse line index and the
 * derived fragment table. `loadDict()` must resolve its data directory with the
 * SAME multi-candidate probe that games/bank/server/src/module.ts uses for
 * `clientDist` — esbuild inlines this module into dist/server.js, so
 * `import.meta.url` is the BUNDLE's url, not this file's.
 */
export interface DictBundle {
  readonly dict: Dict;
  /** Every 3-letter fragment with `common >= DIFFICULTY_BANDS.hard.minInclusive`. */
  fragments(): ReadonlyMap<string, FragmentStats>;
  /** Measured RSS cost in bytes, for the startup log and the budget gate. */
  readonly bytesResident: number;
}

export function declareLoadDict(): (dataDir?: string) => DictBundle {
  throw new Error('type-only declaration; W1 implements loadDict()');
}

// ---- W2: prompt selection ----------------------------------------------------
/**
 * Chooses fragments. Stateless with respect to a match — the room owns the
 * per-match `used` set and passes it in, so a picker can serve many rooms.
 */
export interface FragmentPicker {
  /**
   * A fragment in `difficulty`'s band that is not in `used`.
   * MUST NOT throw and MUST NOT return a repeat: pools are 512/969/851 against
   * a ROUNDS_MAX of 20, so exhaustion is impossible by construction (I5).
   */
  pick(difficulty: WbDifficulty, used: ReadonlySet<string>, rand: () => number): string;
  /** Pool size for a band. `prompts.test.ts` asserts >= MIN_POOL_SIZE. */
  poolSize(difficulty: WbDifficulty): number;
}

export function declareCreatePicker(): (bundle: DictBundle) => FragmentPicker {
  throw new Error('type-only declaration; W2 implements createPicker()');
}

// ---- W3: the room ------------------------------------------------------------
/**
 * The room takes its dependencies rather than importing them, so `room.test.ts`
 * can drive it with a 20-word stub dictionary and a scripted picker instead of
 * loading 2.6 MB and hoping the right fragment comes up.
 *
 * `rand` is injected for the same reason: the fuse length must be
 * deterministic under test. Production passes the platform `rng`.
 */
export interface RoomDeps {
  dict: Dict;
  picker: FragmentPicker;
  rand: () => number;
}

/** The constructor shape W4's module plug must call. */
export type WordbombRoomCtor = new (
  visibility: Visibility,
  io: RoomIO,
  settings: WordbombSettings,
  deps: RoomDeps,
) => import('@platform/shared').GameRoomHandle;

// NOTE: the W5 -> W7 client boot seam (`game.ts` exports
// `boot(root: HTMLElement): void`, `main.ts` calls it and does nothing else) is
// specified in docs/WORDBOMB.md §7, NOT here — this package's lib is ES2022 +
// node, so it cannot name `HTMLElement`.
