// ============================================================================
// WORDBOMB — prompt-selection tests (W13). This file is what makes I5 REAL:
//
//   "I5 — THE POOL IS NEVER EMPTY. Every difficulty must have a provably
//    non-empty fragment pool, and a match must never repeat a fragment.
//    Verified by a test, not by inspection." (docs/WORDBOMB.md §2)
//
// So nothing here is asserted by reading `prompts.ts`. The picker is treated as
// a black box with exactly the two members `ports.ts` freezes — `pick()` and
// `poolSize()` — and every pool is ENUMERATED through `pick()` itself: ask for
// `poolSize(d)` fragments, feeding each one back into `used`. That single loop
// proves three things at once (the pool really holds what `poolSize` claims,
// `pick` never repeats while unused fragments remain, and every member is a
// legal 3-letter prompt), and it cannot be fooled by a `poolSize` that lies.
//
// The enumerated pool is then cross-checked against the pool derived
// independently from `bundle.fragments()` + `bandOf()`, so a picker that
// silently drops or invents fragments fails even though its own two accessors
// agree with each other.
//
// TWO BUNDLES, DELIBERATELY:
//   - the REAL one (W1's `loadDict`) for the pool-size floors, because the only
//     honest measurement of "is the pool big enough" is the shipped word list.
//     If the blob is missing this suite FAILS LOUDLY with the generate command;
//     it never skips. A skipped I5 test is worse than no I5 test.
//   - hand-built STUBS for the band boundaries, because the real list happens to
//     contain whatever it contains and cannot be made to sit exactly on
//     `maxExclusive`. Boundary stubs are built FROM `DIFFICULTY_BANDS` rather
//     than from literals, so they cannot drift out of sync with config.ts.
//
// `rand` is injected everywhere (seeded mulberry32) — `Math.random` is never
// called, and the determinism test would fail if it were.
// ============================================================================
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  DIFFICULTIES,
  DIFFICULTY_BANDS,
  FRAGMENT_MAX_LEN,
  FRAGMENT_MIN_LEN,
  MIN_POOL_SIZE,
  ROUNDS_MAX,
  bandOf,
} from '@wordbomb/shared';
import type { WbDifficulty } from '@wordbomb/shared';
import { loadDict } from './dict.js';
import type { Dict, DictBundle, FragmentPicker, FragmentStats } from './ports.js';
import { createPicker } from './prompts.js';

// ---- fixtures ---------------------------------------------------------------

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(HERE, '../data');
const BLOB = path.join(DATA_DIR, 'words.blob');
const GENERATE_HINT = 'Run: npm run generate -w @wordbomb/server';

/** Exactly three lowercase a-z letters — the only shape a prompt may ever have. */
const FRAGMENT_RE = /^[a-z]{3}$/;

/** Seeded, deterministic, uniform-ish in [0,1). Same seed => same stream. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A `DictBundle` whose fragment table is exactly `entries`. `dict` is never
 * touched by the picker (selection owns no word logic — §7 seam rules), so it
 * is a minimal honest stub rather than a mock with expectations.
 */
function stubBundle(entries: ReadonlyArray<readonly [string, number]>): DictBundle {
  const table = new Map<string, FragmentStats>();
  for (const [fragment, common] of entries) {
    table.set(fragment, { total: common * 3, common });
  }
  const dict: Dict = { has: () => false, size: 0 };
  return { dict, fragments: () => table, bytesResident: 0 };
}

/** `n` picks, threading `used` so the caller sees exactly what a match sees. */
function pickMany(
  picker: FragmentPicker,
  difficulty: WbDifficulty,
  n: number,
  rand: () => number,
  used: Set<string> = new Set<string>(),
): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const fragment = picker.pick(difficulty, used, rand);
    out.push(fragment);
    used.add(fragment);
  }
  return out;
}

/** Drain a whole band through `pick()` — `poolSize` calls asked one at a time. */
function enumeratePool(
  picker: FragmentPicker,
  difficulty: WbDifficulty,
  seed: number,
): string[] {
  return pickMany(picker, difficulty, picker.poolSize(difficulty), mulberry32(seed));
}

/** The pool the bundle IMPLIES, derived without consulting the picker at all. */
function expectedPool(bundle: DictBundle, difficulty: WbDifficulty): string[] {
  const out: string[] = [];
  for (const [fragment, stats] of bundle.fragments()) {
    if (fragment.length !== FRAGMENT_MIN_LEN) continue;
    if (bandOf(stats.common) === difficulty) out.push(fragment);
  }
  return out.sort();
}

// ---- the real dictionary -----------------------------------------------------

describe('WORDBOMB prompt selection — real dictionary (I5)', () => {
  let bundle!: DictBundle;
  let picker!: FragmentPicker;
  const sizes: Record<WbDifficulty, number> = { easy: 0, normal: 0, hard: 0 };
  const pools: Record<WbDifficulty, string[]> = { easy: [], normal: [], hard: [] };

  beforeAll(() => {
    if (!existsSync(BLOB)) {
      throw new Error(
        `wordbomb prompts.test.ts cannot run: the dictionary blob is missing.\n` +
          `Expected: ${BLOB}\n${GENERATE_HINT}`,
      );
    }
    try {
      bundle = loadDict(DATA_DIR);
    } catch (err) {
      throw new Error(
        `wordbomb prompts.test.ts could not load the dictionary blob at ${BLOB}.\n` +
          `${GENERATE_HINT}\nUnderlying: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    picker = createPicker(bundle);
    for (const difficulty of DIFFICULTIES) {
      sizes[difficulty] = picker.poolSize(difficulty);
      pools[difficulty] = enumeratePool(picker, difficulty, 0xc0ffee);
    }
    // Measured pool sizes are printed, not asserted exactly: the floor is the
    // contract (MIN_POOL_SIZE), the exact counts are a drift signal for humans.
    console.info(
      `[wordbomb I5] measured pool sizes — easy=${sizes.easy} normal=${sizes.normal} ` +
        `hard=${sizes.hard} (floor MIN_POOL_SIZE=${MIN_POOL_SIZE}, ROUNDS_MAX=${ROUNDS_MAX}); ` +
        `fragment table=${bundle.fragments().size}, dict size=${bundle.dict.size}`,
    );
  }, 120_000);

  it('every difficulty clears MIN_POOL_SIZE — the pool is never empty (I5)', () => {
    for (const difficulty of DIFFICULTIES) {
      expect(
        sizes[difficulty],
        `${difficulty} pool is ${sizes[difficulty]}, below MIN_POOL_SIZE=${MIN_POOL_SIZE}`,
      ).toBeGreaterThanOrEqual(MIN_POOL_SIZE);
      // I5's second half needs headroom, not just non-emptiness: a match draws
      // ROUNDS_MAX fragments without repeating.
      expect(sizes[difficulty]).toBeGreaterThan(ROUNDS_MAX);
    }
  });

  it('poolSize() tells the truth — draining a band yields exactly that many distinct fragments', () => {
    for (const difficulty of DIFFICULTIES) {
      const drained = pools[difficulty];
      expect(drained.length).toBe(sizes[difficulty]);
      // No repeat anywhere in a full drain => pick() never returns a member of
      // `used` while any unused fragment remains.
      expect(new Set(drained).size).toBe(sizes[difficulty]);
    }
  });

  it('the enumerated pool equals the pool the fragment table implies', () => {
    for (const difficulty of DIFFICULTIES) {
      expect([...pools[difficulty]].sort()).toEqual(expectedPool(bundle, difficulty));
    }
  });

  it('every pooled fragment is exactly three lowercase a-z letters', () => {
    expect(FRAGMENT_MIN_LEN).toBe(3);
    expect(FRAGMENT_MAX_LEN).toBe(3);
    for (const difficulty of DIFFICULTIES) {
      for (const fragment of pools[difficulty]) {
        expect(fragment, `${difficulty} pool holds a malformed fragment: ${JSON.stringify(fragment)}`).toMatch(
          FRAGMENT_RE,
        );
        expect(fragment.length).toBe(FRAGMENT_MIN_LEN);
      }
    }
  });

  it('every pooled fragment sits inside its own band per bandOf()', () => {
    for (const difficulty of DIFFICULTIES) {
      const band = DIFFICULTY_BANDS[difficulty];
      for (const fragment of pools[difficulty]) {
        const stats = bundle.fragments().get(fragment);
        expect(stats, `${fragment} is pooled but absent from the fragment table`).toBeDefined();
        if (stats === undefined) continue;
        expect(
          bandOf(stats.common),
          `${fragment} (common=${stats.common}) is in the ${difficulty} pool but bandOf says otherwise`,
        ).toBe(difficulty);
        expect(stats.common).toBeGreaterThanOrEqual(band.minInclusive);
        expect(stats.common).toBeLessThan(band.maxExclusive);
        // `total` counts all containing words, `common` only the short ones, so
        // common can never exceed total. A table where it does is miscounted.
        expect(stats.common).toBeLessThanOrEqual(stats.total);
      }
    }
  });

  it('no fragment is below the hard floor of 40, and none is a trivial >= 400', () => {
    expect(DIFFICULTY_BANDS.hard.minInclusive).toBe(40);
    expect(DIFFICULTY_BANDS.easy.maxExclusive).toBe(400);
    for (const difficulty of DIFFICULTIES) {
      for (const fragment of pools[difficulty]) {
        const stats = bundle.fragments().get(fragment);
        if (stats === undefined) continue;
        expect(stats.common, `${fragment} is below the hard floor`).toBeGreaterThanOrEqual(
          DIFFICULTY_BANDS.hard.minInclusive,
        );
        expect(stats.common, `${fragment} is a trivial fragment`).toBeLessThan(
          DIFFICULTY_BANDS.easy.maxExclusive,
        );
      }
    }
  });

  it('no fragment appears in two pools', () => {
    const owner = new Map<string, WbDifficulty>();
    for (const difficulty of DIFFICULTIES) {
      for (const fragment of pools[difficulty]) {
        const previous = owner.get(fragment);
        expect(
          previous,
          `${fragment} appears in both the ${String(previous)} and ${difficulty} pools`,
        ).toBeUndefined();
        owner.set(fragment, difficulty);
      }
    }
    const total = DIFFICULTIES.reduce((n, d) => n + sizes[d], 0);
    expect(owner.size).toBe(total);
  });

  it('a ROUNDS_MAX-round match never repeats a fragment, over 200 seeded runs per band', () => {
    const RUNS = 200;
    expect(ROUNDS_MAX).toBe(20);
    for (const difficulty of DIFFICULTIES) {
      const inPool = new Set(pools[difficulty]);
      for (let seed = 1; seed <= RUNS; seed++) {
        const match = pickMany(picker, difficulty, ROUNDS_MAX, mulberry32(seed * 2_654_435_761));
        expect(match.length).toBe(ROUNDS_MAX);
        expect(
          new Set(match).size,
          `seed ${seed} (${difficulty}) repeated a fragment: ${match.join(',')}`,
        ).toBe(ROUNDS_MAX);
        for (const fragment of match) {
          expect(inPool.has(fragment), `seed ${seed} produced off-pool ${fragment}`).toBe(true);
          expect(fragment).toMatch(FRAGMENT_RE);
        }
      }
    }
  }, 120_000);

  it('the same seeded rand produces the same sequence — every time, and across pickers', () => {
    const SEED = 0x5eed;
    for (const difficulty of DIFFICULTIES) {
      const first = pickMany(picker, difficulty, ROUNDS_MAX, mulberry32(SEED));
      const second = pickMany(picker, difficulty, ROUNDS_MAX, mulberry32(SEED));
      expect(second).toEqual(first);

      // A second picker built from the same bundle must agree: pool ORDER is
      // sorted, so it cannot depend on Map insertion order inside W1.
      const twin = createPicker(bundle);
      expect(pickMany(twin, difficulty, ROUNDS_MAX, mulberry32(SEED))).toEqual(first);

      // Sanity: the sequence is actually driven by `rand`, not a constant.
      const other = pickMany(picker, difficulty, ROUNDS_MAX, mulberry32(SEED + 1));
      expect(other).not.toEqual(first);
    }
  });

  it('pick() never calls Math.random — a frozen rand yields a frozen first pick', () => {
    // rand() === 0 always => index 0 of the available list, every time.
    const zero = (): number => 0;
    for (const difficulty of DIFFICULTIES) {
      const a = picker.pick(difficulty, new Set<string>(), zero);
      const b = picker.pick(difficulty, new Set<string>(), zero);
      expect(b).toBe(a);
      expect(a).toMatch(FRAGMENT_RE);
    }
  });

  it('pick() never throws on hostile rand values and never leaves the pool', () => {
    const hostile: ReadonlyArray<readonly [string, () => number]> = [
      ['NaN', () => Number.NaN],
      ['negative', () => -0.5],
      ['exactly 1', () => 1],
      ['above 1', () => 7.5],
      ['+Infinity', () => Number.POSITIVE_INFINITY],
      ['-Infinity', () => Number.NEGATIVE_INFINITY],
      ['just under 1', () => 1 - Number.EPSILON],
      ['exactly 0', () => 0],
    ];
    for (const difficulty of DIFFICULTIES) {
      const inPool = new Set(pools[difficulty]);
      for (const [label, rand] of hostile) {
        let got = '';
        expect(
          () => {
            got = picker.pick(difficulty, new Set<string>(), rand);
          },
          `pick(${difficulty}) threw on a ${label} rand`,
        ).not.toThrow();
        expect(got, `${label} rand produced off-pool ${got}`).toMatch(FRAGMENT_RE);
        expect(inPool.has(got)).toBe(true);
      }
    }
  });

  it('pick() never returns a member of used while unused fragments remain', () => {
    const rand = mulberry32(0xbadc0de);
    for (const difficulty of DIFFICULTIES) {
      // Mark all but the final fragment as used: the only legal answer is the
      // one survivor, so an implementation that resampled naively would fail.
      const drained = pools[difficulty];
      const survivor = drained[drained.length - 1];
      expect(survivor).toBeDefined();
      if (survivor === undefined) continue;
      const used = new Set(drained.slice(0, -1));
      for (let i = 0; i < 25; i++) {
        expect(picker.pick(difficulty, used, rand)).toBe(survivor);
      }

      // A `used` set full of foreign entries must not disturb selection.
      const foreign = new Set(['zzz', 'qqq', 'not-a-fragment', '']);
      const fromForeign = picker.pick(difficulty, foreign, rand);
      expect(fromForeign).toMatch(FRAGMENT_RE);
      expect(foreign.has(fromForeign)).toBe(false);
    }
  });
});

// ---- band boundaries, on a hand-built table ----------------------------------

describe('WORDBOMB prompt selection — band boundaries (stub bundle)', () => {
  const B = DIFFICULTY_BANDS;

  it('the bands are contiguous, ordered and half-open — the shape the stubs assume', () => {
    expect(B.hard.maxExclusive).toBe(B.normal.minInclusive);
    expect(B.normal.maxExclusive).toBe(B.easy.minInclusive);
    expect(B.hard.minInclusive).toBeLessThan(B.hard.maxExclusive);
    expect(B.normal.minInclusive).toBeLessThan(B.normal.maxExclusive);
    expect(B.easy.minInclusive).toBeLessThan(B.easy.maxExclusive);

    expect(bandOf(B.hard.minInclusive - 1)).toBeNull();
    expect(bandOf(B.hard.minInclusive)).toBe('hard');
    expect(bandOf(B.hard.maxExclusive - 1)).toBe('hard');
    expect(bandOf(B.normal.minInclusive)).toBe('normal');
    expect(bandOf(B.normal.maxExclusive - 1)).toBe('normal');
    expect(bandOf(B.easy.minInclusive)).toBe('easy');
    expect(bandOf(B.easy.maxExclusive - 1)).toBe('easy');
    expect(bandOf(B.easy.maxExclusive)).toBeNull();
  });

  it('places every fragment in exactly the band bandOf() names, on both edges', () => {
    const picker = createPicker(
      stubBundle([
        ['aaa', B.hard.minInclusive - 1], // below the hard floor -> nowhere
        ['bbb', B.hard.minInclusive], // hard, inclusive edge
        ['ccc', B.hard.maxExclusive - 1], // hard, last legal value
        ['ddd', B.normal.minInclusive], // normal, inclusive edge
        ['eee', B.normal.maxExclusive - 1],
        ['fff', B.easy.minInclusive],
        ['ggg', B.easy.maxExclusive - 1],
        ['hhh', B.easy.maxExclusive], // trivial -> nowhere
        ['iii', 5_000], // wildly trivial -> nowhere
        ['jjj', 0],
      ]),
    );

    expect(picker.poolSize('hard')).toBe(2);
    expect(picker.poolSize('normal')).toBe(2);
    expect(picker.poolSize('easy')).toBe(2);

    expect(enumeratePool(picker, 'hard', 1).sort()).toEqual(['bbb', 'ccc']);
    expect(enumeratePool(picker, 'normal', 1).sort()).toEqual(['ddd', 'eee']);
    expect(enumeratePool(picker, 'easy', 1).sort()).toEqual(['fff', 'ggg']);

    // The excluded ones are in NO pool.
    const everything = new Set([
      ...enumeratePool(picker, 'hard', 2),
      ...enumeratePool(picker, 'normal', 2),
      ...enumeratePool(picker, 'easy', 2),
    ]);
    for (const excluded of ['aaa', 'hhh', 'iii', 'jjj']) {
      expect(everything.has(excluded), `${excluded} must be excluded from every pool`).toBe(false);
    }
  });

  it('rejects fragments that are not exactly FRAGMENT_MIN_LEN letters', () => {
    const inBand = B.normal.minInclusive;
    const picker = createPicker(
      stubBundle([
        ['er', inBand], // 2 letters
        ['a', inBand], // 1 letter
        ['ting', inBand], // 4 letters
        ['ation', inBand], // 5 letters
        ['', inBand],
        ['abc', inBand], // the only legal one
      ]),
    );
    expect(picker.poolSize('normal')).toBe(1);
    expect(picker.pick('normal', new Set<string>(), mulberry32(3))).toBe('abc');
    expect(enumeratePool(picker, 'normal', 4)).toEqual(['abc']);
  });
});

// ---- degraded bundles: pick() MUST NOT throw (I5 / I6) -----------------------

describe('WORDBOMB prompt selection — degraded bundles never throw', () => {
  const B = DIFFICULTY_BANDS;

  it('an empty fragment table still yields a legal 3-letter fragment', () => {
    const picker = createPicker(stubBundle([]));
    for (const difficulty of DIFFICULTIES) {
      expect(picker.poolSize(difficulty)).toBe(0);
      let got = '';
      expect(() => {
        got = picker.pick(difficulty, new Set<string>(), mulberry32(5));
      }).not.toThrow();
      expect(got).toMatch(FRAGMENT_RE);
    }
  });

  it('an empty band falls back to another band rather than failing the round', () => {
    // Only `hard` is populated. Asking for `easy` must still produce a prompt.
    const picker = createPicker(
      stubBundle([
        ['bbb', B.hard.minInclusive],
        ['ccc', B.hard.minInclusive + 1],
        ['ddd', B.hard.maxExclusive - 1],
      ]),
    );
    expect(picker.poolSize('easy')).toBe(0);
    expect(picker.poolSize('normal')).toBe(0);
    expect(picker.poolSize('hard')).toBe(3);

    const rand = mulberry32(11);
    const used = new Set<string>();
    for (let i = 0; i < 3; i++) {
      let got = '';
      expect(() => {
        got = picker.pick('easy', used, rand);
      }).not.toThrow();
      expect(got).toMatch(FRAGMENT_RE);
      expect(used.has(got), 'cross-band fallback repeated a fragment').toBe(false);
      used.add(got);
    }
    expect([...used].sort()).toEqual(['bbb', 'ccc', 'ddd']);
  });

  it('an exhausted pool repeats rather than throwing (I5 already unsatisfiable)', () => {
    const picker = createPicker(
      stubBundle([
        ['bbb', B.normal.minInclusive],
        ['ccc', B.normal.minInclusive + 1],
      ]),
    );
    const used = new Set(['bbb', 'ccc']);
    const rand = mulberry32(13);
    for (let i = 0; i < 20; i++) {
      let got = '';
      expect(() => {
        got = picker.pick('normal', used, rand);
      }).not.toThrow();
      expect(got).toMatch(FRAGMENT_RE);
      expect(['bbb', 'ccc']).toContain(got);
    }
  });

  it('a used set larger than every pool never throws', () => {
    const picker = createPicker(
      stubBundle([
        ['bbb', B.hard.minInclusive],
        ['ddd', B.normal.minInclusive],
        ['fff', B.easy.minInclusive],
      ]),
    );
    const used = new Set<string>();
    for (let i = 0; i < 500; i++) used.add(`x${i}y`);
    used.add('bbb');
    used.add('ddd');
    used.add('fff');
    for (const difficulty of DIFFICULTIES) {
      let got = '';
      expect(() => {
        got = picker.pick(difficulty, used, mulberry32(17));
      }).not.toThrow();
      expect(got).toMatch(FRAGMENT_RE);
    }
  });
});
