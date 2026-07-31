#!/usr/bin/env node
// ============================================================================
// WORDBOMB dictionary generator (docs/WORDBOMB.md §3.1, §3.2).
//
//   npm run generate -w @wordbomb/server
//
// Reads the `word-list` devDependency (SCOWL-derived, 274,137 raw entries),
// filters by DICT_WORD_RE, SORTS, de-duplicates, and writes the ONE committed
// artifact: data/words.blob — newline-delimited, latin1, ~2.60 MB.
//
// SORTING IS MANDATORY AND IS NOT COSMETIC. The upstream list is not sorted
// (measured inversions, e.g. `manlily` before `manlihood`); an unsorted blob
// silently breaks the runtime binary search on real words. The script verifies
// strict monotonicity of what it just wrote before it exits.
//
// The fragment table is deliberately NOT written. dict.ts derives it at
// startup from this same blob so the two can never drift (§3.1). This script
// re-derives it only to PRINT the pool sizes and 20 sample fragments per band:
// a band nobody can answer is a design failure that a green test will not
// catch (§3.2), so a human has to look at it.
//
// Constants come from @wordbomb/shared/config — imported as a subpath because
// the barrel (`@wordbomb/shared`) re-exports with `.js` specifiers that node's
// type stripping does not remap; config.ts's only import is `import type` and
// is erased cleanly.
// ============================================================================
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  COMMON_MAX_LEN,
  DICT_WORD_RE,
  DIFFICULTIES,
  DIFFICULTY_BANDS,
  FRAGMENT_MAX_LEN,
  FRAGMENT_MIN_LEN,
  MIN_POOL_SIZE,
  bandOf,
} from '@wordbomb/shared/config';

const LF = 0x0a;
const A = 97; // 'a'
const ALPHABET = 26;

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, '..');
const outDir = path.join(pkgRoot, 'data');
const outFile = path.join(outDir, 'words.blob');

/** Resolve the upstream list, preferring the package's own export. */
function resolveWordsTxt() {
  const require = createRequire(import.meta.url);
  try {
    return path.join(path.dirname(require.resolve('word-list/package.json')), 'words.txt');
  } catch {
    return path.resolve(pkgRoot, '../../../node_modules/word-list/words.txt');
  }
}

// ---- 1. read + filter --------------------------------------------------------
const srcPath = resolveWordsTxt();
const raw = readFileSync(srcPath, 'utf8').split('\n');
// A trailing newline yields one empty tail entry; the filter drops it.
const rawCount = raw.length - (raw[raw.length - 1] === '' ? 1 : 0);

const kept = [];
for (const line of raw) {
  const w = line.trim();
  if (DICT_WORD_RE.test(w)) kept.push(w);
}

// ---- 2. sort + dedupe (strict monotonicity is asserted by dict.test.ts) ------
// All entries are pure ASCII [a-z], so UTF-16 code-unit order IS byte order.
kept.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
const words = [];
let prev = '';
for (const w of kept) {
  if (w !== prev) words.push(w);
  prev = w;
}
const dupesDropped = kept.length - words.length;

// ---- 3. write the blob -------------------------------------------------------
mkdirSync(outDir, { recursive: true });
const blob = Buffer.from(`${words.join('\n')}\n`, 'latin1');
writeFileSync(outFile, blob);

// ---- 4. verify what we just wrote -------------------------------------------
const check = readFileSync(outFile);
if (check.length !== blob.length) {
  throw new Error(`readback size mismatch: wrote ${blob.length}, read ${check.length}`);
}
if (check[check.length - 1] !== LF) throw new Error('blob does not end with a newline');
{
  let lines = 0;
  let last = '';
  let start = 0;
  for (let i = 0; i < check.length; i++) {
    if (check[i] !== LF) continue;
    const w = check.toString('latin1', start, i);
    if (w.length === 0) throw new Error(`empty line at line ${lines}`);
    if (!DICT_WORD_RE.test(w)) throw new Error(`line ${lines} failed the filter: ${w}`);
    if (lines > 0 && !(last < w)) {
      throw new Error(`blob is not strictly sorted at line ${lines}: ${last} !< ${w}`);
    }
    last = w;
    lines++;
    start = i + 1;
  }
  if (start !== check.length) throw new Error('trailing bytes after the final newline');
  if (lines !== words.length) throw new Error(`line count mismatch: ${lines} vs ${words.length}`);
}

// ---- 5. derive the fragment table, exactly as dict.ts will -------------------
// `total` counts WORDS containing the fragment (a word is counted once even if
// the fragment occurs twice, e.g. `ana` in `banana`); `common` counts only the
// words of length <= COMMON_MAX_LEN, and is the difficulty key (§3.2).
if (FRAGMENT_MIN_LEN !== 3 || FRAGMENT_MAX_LEN !== 3) {
  throw new Error(
    `this generator derives 3-letter fragments only; config says [${FRAGMENT_MIN_LEN}, ${FRAGMENT_MAX_LEN}]`,
  );
}
const CODES = ALPHABET * ALPHABET * ALPHABET;
const total = new Int32Array(CODES);
const common = new Int32Array(CODES);
const seen = new Int32Array(CODES);

{
  let wordNo = 0;
  let start = 0;
  for (let i = 0; i < check.length; i++) {
    if (check[i] !== LF) continue;
    const wlen = i - start;
    const isCommon = wlen <= COMMON_MAX_LEN;
    const stamp = ++wordNo;
    for (let p = start; p + 3 <= i; p++) {
      const code =
        (check[p] - A) * ALPHABET * ALPHABET + (check[p + 1] - A) * ALPHABET + (check[p + 2] - A);
      if (code < 0 || code >= CODES) continue;
      if (seen[code] === stamp) continue;
      seen[code] = stamp;
      total[code]++;
      if (isCommon) common[code]++;
    }
    start = i + 1;
  }
}

const decode = (code) =>
  String.fromCharCode(
    A + Math.floor(code / (ALPHABET * ALPHABET)),
    A + (Math.floor(code / ALPHABET) % ALPHABET),
    A + (code % ALPHABET),
  );

const HARD_FLOOR = DIFFICULTY_BANDS.hard.minInclusive;
const pools = new Map(DIFFICULTIES.map((d) => [d, []]));
let tableSize = 0;
let distinctFragments = 0;
for (let code = 0; code < CODES; code++) {
  if (total[code] > 0) distinctFragments++;
  if (common[code] < HARD_FLOOR) continue;
  tableSize++;
  const band = bandOf(common[code]);
  if (band === null) continue; // >= 400: the `ing`/`er` tier, excluded as trivial
  pools.get(band).push(code);
}

// ---- 6. report ---------------------------------------------------------------
const mb = (n) => `${(n / 1024 / 1024).toFixed(2)} MB`;
console.log('WORDBOMB dictionary');
console.log(`  source          ${srcPath}`);
console.log(`  raw entries     ${rawCount.toLocaleString('en-US')}`);
console.log(
  `  after ${String(DICT_WORD_RE)}  ${words.length.toLocaleString('en-US')}` +
    (dupesDropped > 0 ? `  (${dupesDropped} duplicate(s) dropped)` : ''),
);
console.log(`  blob            ${outFile}`);
console.log(`  blob size       ${blob.length.toLocaleString('en-US')} bytes (${mb(blob.length)})`);
console.log(`  sorted          strictly ascending, verified on readback`);
console.log('');
console.log(
  `  3-letter fragments seen        ${distinctFragments.toLocaleString('en-US')} of ${CODES.toLocaleString('en-US')} possible`,
);
console.log(
  `  runtime table (common >= ${HARD_FLOOR})   ${tableSize.toLocaleString('en-US')} fragments`,
);
console.log('');
console.log('  DERIVED POOLS  (key = `common`: words of length <= '.concat(String(COMMON_MAX_LEN), ' containing the fragment)'));

let poolFailure = false;
for (const d of DIFFICULTIES) {
  const band = DIFFICULTY_BANDS[d];
  const codes = pools.get(d);
  codes.sort((a, b) => common[b] - common[a] || a - b);
  const ok = codes.length >= MIN_POOL_SIZE;
  if (!ok) poolFailure = true;
  console.log('');
  console.log(
    `  ${d.padEnd(6)} common in [${band.minInclusive}, ${band.maxExclusive})  ->  ` +
      `${codes.length.toLocaleString('en-US')} fragments  ` +
      `${ok ? 'OK' : `FAIL (< MIN_POOL_SIZE ${MIN_POOL_SIZE})`}`,
  );
  // 20 evenly-spaced samples across the band, most-common first — an even
  // spread shows the shape of the band, not just its friendly head.
  const n = Math.min(20, codes.length);
  const samples = [];
  for (let i = 0; i < n; i++) {
    const code = codes[Math.floor((i * codes.length) / n)];
    samples.push(`${decode(code)}(${common[code]}/${total[code]})`);
  }
  for (let i = 0; i < samples.length; i += 5) {
    console.log(`         ${samples.slice(i, i + 5).join('  ')}`);
  }
}

console.log('');
if (poolFailure) {
  console.error('  I5 VIOLATION: a difficulty pool is below MIN_POOL_SIZE.');
  process.exitCode = 1;
} else {
  console.log('  I5: every pool is non-empty and above MIN_POOL_SIZE.');
}
