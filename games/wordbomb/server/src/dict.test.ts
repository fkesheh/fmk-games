// ============================================================================
// WORDBOMB dictionary tests — the PROOF OBLIGATION that replaces the frozen
// search pseudocode (docs/WORDBOMB.md §3.1.1, ports.ts `Dict`).
//
// WHY THIS FILE IS THE CONTRACT. §3.1.1 deliberately specifies no binary
// search: the architect's own sketch had an inverted comparison and reported
// all 269,746 words missing while looking entirely reasonable. A reviewer
// reading that sketch would have approved it. So the dictionary is accepted on
// evidence, not on inspection, and the evidence is here:
//
//   1. the blob is well-formed  — every line matches DICT_WORD_RE
//   2. the blob is STRICTLY sorted — the upstream `word-list` file is not
//      (measured: `manlily` before `manlihood`), which silently breaks binary
//      search on real words while leaving 99.999% of lookups correct
//   3. EXHAUSTIVE round-trip — all 269,746 words, not a sample. A sample of
//      1,000 would have passed against a search that misses one 16-line block.
//   4. the off-by-one zone — every word adjacent to a sparse-index boundary
//   5. >= 5,000 known-absent strings reject, generated SYSTEMATICALLY from the
//      dictionary itself (prefix-minus-last, suffix-minus-first, one-letter
//      substitution) so the near-misses land in the exact blocks a sloppy
//      comparator over-accepts, plus seeded random strings and hand-picked
//      cases (`zanzibar` proves the proper-noun filter, §3)
//   6. `size` matches the blob's line count, and `bytesResident` is inside the
//      8 MB budget (§3.1)
//
// THE ORACLE. Assertions 3 and 5 are checked against a `Set<string>` of the
// full list built HERE, in the test process. §3.1 forbids that Set in the
// SERVER (~43 MB resident); a test process that runs for 400 ms and exits is
// exactly where it belongs, and it is the only independent oracle available —
// using `dict.has()` to decide what `dict.has()` should return proves nothing.
//
// THE BLOB IS REQUIRED. These tests run against the real generated artifact.
// If it is absent they FAIL LOUDLY with the command to build it; they do not
// skip and they do not synthesise a stand-in, because a green run against a
// 20-word fixture is precisely the false comfort §3.1.1 exists to prevent.
// ============================================================================
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { DICT_WORD_RE, MAX_WORD_LEN, MIN_WORD_LEN } from '@wordbomb/shared';
import { loadDict } from './dict.js';
import type { Dict, DictBundle } from './ports.js';

// ---- the artifact under test -------------------------------------------------

const DATA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../data');
const BLOB_PATH = path.join(DATA_DIR, 'words.blob');

/** docs/WORDBOMB.md §3: 274,137 raw entries, 269,746 surviving `^[a-z]{3,15}$`. */
const EXPECTED_WORD_COUNT = 269_746;

/**
 * §3.1 budget: "under 8 MB RSS for blob + index + pools". 8e6 is the stricter
 * reading of "8 MB" (8 MiB = 8,388,608), so passing this passes either.
 */
const MEMORY_BUDGET_BYTES = 8_000_000;

/**
 * §3.1: the sparse index holds every 16th line offset. The boundary sweep does
 * not assume that number — it sweeps a range of plausible strides so it still
 * lands on the off-by-one zone if W1 tunes the stride.
 */
const CANDIDATE_STRIDES = [8, 16, 32, 64, 128, 256] as const;

/** §3.1.1 requires at least this many known-absent strings to be rejected. */
const MIN_ABSENT_PROBES = 5_000;

/**
 * Hand-picked absentees. `zanzibar` is the load-bearing one: §3 rejected the
 * system dictionary (Webster's 2nd, 25,203 proper nouns) specifically because
 * it would admit this word. If it is ever found, the wrong source list shipped.
 * NOTE `qwerty` is deliberately NOT here — it IS in the list (line 188,764),
 * and sits in the positive controls below as the "looks fake, is real" case.
 */
const KNOWN_ABSENT = [
  'zanzibar',
  'asdfgh',
  'qqqqqq',
  'xyzzyx',
  'zzzzzzz',
  'jkjkjk',
  'vwxyzv',
  'blorptastic',
  'thisisnotaword',
] as const;

/** Words that must be present. `qwerty` guards against over-eager filtering. */
const KNOWN_PRESENT = ['aah', 'nation', 'rationale', 'qwerty', 'zzz', 'zyzzyva'] as const;

// ---- helpers -----------------------------------------------------------------

/** Deterministic PRNG — a failing seed must be reproducible from the source. */
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
 * `word` with the character at a salt-chosen position replaced by a different
 * letter. The shift is `1 + (salt % 25)`, which is never 0 mod 26, so the
 * result always differs from the input.
 */
function substituteOneLetter(word: string, salt: number): string {
  const n = word.length;
  const p = salt % n;
  const orig = word.charCodeAt(p);
  const next = 97 + (((orig - 97 + 1 + (salt % 25)) % 26) + 26) % 26;
  return word.slice(0, p) + String.fromCharCode(next) + word.slice(p + 1);
}

/** Only strings the dictionary would actually search for are useful probes. */
function isSearchable(s: string): boolean {
  return DICT_WORD_RE.test(s);
}

/** First `n` entries, for a failure message that names names. */
function sample<T>(items: readonly T[], n: number): T[] {
  return items.slice(0, n);
}

// ---- fixtures ----------------------------------------------------------------

let bundle: DictBundle;
let dict: Dict;
/** Every line of the blob, in blob order. */
let words: string[];
/** The independent oracle. Test-process only — see the header. */
let wordSet: Set<string>;
let blobBytes: Buffer;

beforeAll(() => {
  if (!existsSync(BLOB_PATH)) {
    throw new Error(
      `wordbomb dict.test.ts: the dictionary blob is missing.\n` +
        `  expected at: ${BLOB_PATH}\n` +
        `These tests run against the REAL 269,746-word artifact and will not skip,\n` +
        `and will not synthesise a fake blob — a green run against a fixture is\n` +
        `exactly the false comfort docs/WORDBOMB.md §3.1.1 exists to prevent.\n` +
        `Build it with:\n\n    npm run generate -w @wordbomb/server\n`,
    );
  }

  blobBytes = readFileSync(BLOB_PATH);

  // latin1 is the blob's declared encoding (§3.1) and is byte-for-byte here.
  const parts = blobBytes.toString('latin1').split('\n');
  const trailer = parts.pop();
  if (trailer !== '') {
    throw new Error(
      `wordbomb dict.test.ts: ${BLOB_PATH} does not end with a newline ` +
        `(trailing fragment: ${JSON.stringify(trailer)}). Regenerate it.`,
    );
  }
  words = parts;
  wordSet = new Set(words);

  bundle = loadDict(DATA_DIR);
  dict = bundle.dict;
});

// ---- 1. the artifact ---------------------------------------------------------

describe('words.blob — the one committed artifact', () => {
  it('holds exactly 269,746 lines, every one matching DICT_WORD_RE', () => {
    expect(words.length).toBe(EXPECTED_WORD_COUNT);

    const bad: string[] = [];
    for (const w of words) {
      if (!DICT_WORD_RE.test(w)) {
        bad.push(w);
        if (bad.length >= 10) break;
      }
    }
    expect(bad, `lines failing ${String(DICT_WORD_RE)}: ${JSON.stringify(bad)}`).toEqual([]);
  });

  it('is STRICTLY monotonically sorted (the upstream unsorted-list trap)', () => {
    // Every line is [a-z] only (asserted above), so UTF-16 `<` is identical to
    // the generator's bytewise sort — including prefix order (`cat` < `cats`).
    // STRICT, not merely non-decreasing: a duplicate line is also a defect.
    const inversions: string[] = [];
    for (let i = 1; i < words.length; i++) {
      const prev = words[i - 1];
      const cur = words[i];
      if (prev === undefined || cur === undefined) continue;
      if (!(prev < cur)) {
        inversions.push(`line ${i}: ${JSON.stringify(prev)} !< ${JSON.stringify(cur)}`);
        if (inversions.length >= 10) break;
      }
    }
    expect(
      inversions,
      `blob is not sorted — binary search is unsound. First inversions:\n${inversions.join('\n')}`,
    ).toEqual([]);
  });

  it('is a byte buffer of the documented size, newline-terminated', () => {
    expect(blobBytes.byteLength).toBeGreaterThan(2_000_000);
    expect(blobBytes[blobBytes.byteLength - 1]).toBe(0x0a);
  });
});

// ---- 2. the bundle -----------------------------------------------------------

describe('loadDict()', () => {
  it('reports a size matching the blob line count', () => {
    expect(dict.size).toBe(words.length);
    expect(dict.size).toBe(EXPECTED_WORD_COUNT);
  });

  it('holds blob + index + pools under the 8 MB budget (§3.1)', () => {
    expect(bundle.bytesResident).toBeGreaterThan(0);
    expect(bundle.bytesResident).toBeGreaterThanOrEqual(blobBytes.byteLength);
    expect(
      bundle.bytesResident,
      `bytesResident=${bundle.bytesResident} exceeds the ${MEMORY_BUDGET_BYTES}-byte budget; ` +
        `a Set<string> of the full list (~43 MB) is a contract violation`,
    ).toBeLessThan(MEMORY_BUDGET_BYTES);
  });

  it('fails loudly with a build instruction when the blob is absent', () => {
    let message = '';
    try {
      loadDict(path.join(DATA_DIR, '__definitely_not_a_data_dir__'));
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain('words.blob');
    expect(message).toContain('npm run generate -w @wordbomb/server');
  });
});

// ---- 3. the exhaustive round-trip -------------------------------------------

describe('Dict.has() — presence', () => {
  it('EXHAUSTIVE: finds all 269,746 words in the blob', () => {
    // Not a sample. A 1,000-word sample passes against a search that drops one
    // 16-line block, and that is the exact failure §3.1.1 was written about.
    // `expect` per word would be ~270k assertions; collect misses instead.
    const firstMisses: string[] = [];
    let missCount = 0;
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      if (w === undefined) continue;
      if (!dict.has(w)) {
        missCount++;
        if (firstMisses.length < 20) firstMisses.push(`#${i} ${JSON.stringify(w)}`);
      }
    }
    expect(
      missCount,
      `${missCount} of ${words.length} dictionary words were reported MISSING. ` +
        `First offenders: ${sample(firstMisses, 20).join(', ')}`,
    ).toBe(0);
  });

  it('finds the first and the last word in the blob', () => {
    const first = words[0];
    const last = words[words.length - 1];
    if (first === undefined || last === undefined) throw new Error('blob is empty');
    expect(dict.has(first), `first word ${JSON.stringify(first)} not found`).toBe(true);
    expect(dict.has(last), `last word ${JSON.stringify(last)} not found`).toBe(true);
  });

  it('finds every word adjacent to a sparse-index boundary (the off-by-one zone)', () => {
    const indices = new Set<number>();
    for (const stride of CANDIDATE_STRIDES) {
      for (let k = 0; k * stride <= words.length; k++) {
        const b = k * stride;
        for (const idx of [b - 1, b, b + 1]) {
          if (idx >= 0 && idx < words.length) indices.add(idx);
        }
      }
    }
    // Sanity: the sweep must actually cover the whole blob's boundaries.
    expect(indices.size).toBeGreaterThan(words.length / 8);

    const missing: string[] = [];
    for (const idx of indices) {
      const w = words[idx];
      if (w === undefined) continue;
      if (!dict.has(w) && missing.length < 20) missing.push(`#${idx} ${JSON.stringify(w)}`);
    }
    expect(missing, `boundary-adjacent words not found: ${missing.join(', ')}`).toEqual([]);
  });

  it('finds hand-picked known words', () => {
    for (const w of KNOWN_PRESENT) {
      expect(wordSet.has(w), `oracle premise broken: ${w} is not in the blob`).toBe(true);
      expect(dict.has(w), `${w} should be found`).toBe(true);
    }
  });
});

// ---- 4. rejection ------------------------------------------------------------

describe('Dict.has() — absence', () => {
  it('rejects the hand-picked absentees, including the proper-noun canary', () => {
    for (const w of KNOWN_ABSENT) {
      expect(wordSet.has(w), `oracle premise broken: ${w} IS in the blob`).toBe(false);
      expect(
        dict.has(w),
        w === 'zanzibar'
          ? 'zanzibar was found — the proper-noun-bearing system dictionary shipped (§3)'
          : `${w} should be rejected`,
      ).toBe(false);
    }
  });

  it('rejects >= 5,000 systematically generated near-misses and random strings', () => {
    // Near-misses are generated FROM the dictionary so each probe lands inside
    // the block where its neighbours live — the region a comparator that stops
    // one byte early, or an off-by-one scan bound, over-accepts. Anything that
    // turns out to be a real word is filtered out by the oracle, not guessed at.
    const leaked: string[] = [];
    let probes = 0;

    const probe = (candidate: string): void => {
      if (!isSearchable(candidate)) return;
      if (wordSet.has(candidate)) return; // it is a real word; not an absence probe
      probes++;
      if (dict.has(candidate) && leaked.length < 20) leaked.push(candidate);
    };

    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      if (w === undefined) continue;
      probe(w.slice(0, -1)); // prefix minus last char
      probe(w.slice(1)); // suffix minus first char
      probe(substituteOneLetter(w, i)); // one-letter substitution
    }

    // Seeded random letter strings, length MIN_WORD_LEN..MAX_WORD_LEN. The seed
    // is fixed so a failure here is reproducible from this source alone.
    const rand = mulberry32(0xb0_0b_51);
    for (let n = 0; n < 20_000; n++) {
      const len = MIN_WORD_LEN + Math.floor(rand() * (MAX_WORD_LEN - MIN_WORD_LEN + 1));
      let s = '';
      for (let c = 0; c < len; c++) s += String.fromCharCode(97 + Math.floor(rand() * 26));
      probe(s);
    }

    expect(
      probes,
      `only ${probes} known-absent probes were generated; §3.1.1 requires >= ${MIN_ABSENT_PROBES}`,
    ).toBeGreaterThanOrEqual(MIN_ABSENT_PROBES);
    expect(
      leaked,
      `${leaked.length}+ non-words were reported PRESENT: ${leaked.join(', ')}`,
    ).toEqual([]);
  });

  it('rejects structurally invalid input without throwing', () => {
    const junk = [
      '',
      'a',
      'ab',
      'abcdefghijklmnop', // 16 chars, one over MAX_WORD_LEN
      'NATION',
      'Nation',
      'na tion',
      'na-tion',
      "don't",
      'nati0n',
      'natión',
      '   ',
      '\n',
      'aah\n',
      '\naah',
    ];
    for (const s of junk) {
      expect(() => dict.has(s)).not.toThrow();
      expect(dict.has(s), `${JSON.stringify(s)} should be rejected`).toBe(false);
    }
  });
});
