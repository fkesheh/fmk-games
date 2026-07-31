// ============================================================================
// WORDBOMB dictionary (docs/WORDBOMB.md §3, ports.ts "W1"). Owns the ONE
// committed artifact — data/words.blob, 269,746 sorted words, latin1,
// newline-delimited — and everything derived from it.
//
// THE BLOB STAYS A BUFFER. `readFileSync(..., 'utf8')` or a `Set<string>` of
// the full list costs ~43 MB resident (§3.1) and is a contract violation. The
// budget is under 8 MB for blob + index + fragment table, and `bytesResident`
// exposes what we actually hold.
//
// ONE PASS builds BOTH derived structures (§3.1):
//   1. a SPARSE line index — the byte offset of every 16th word (16,860
//      entries, 66 KB). A per-word index costs ~1.1 MB and measures no faster.
//   2. the fragment table — every 3-letter fragment with
//      `common >= DIFFICULTY_BANDS.hard.minInclusive`, where `common` counts
//      the containing words of length <= COMMON_MAX_LEN.
// The pass reads bytes straight out of the Buffer; no per-word string is ever
// allocated. Deriving the table rather than committing it removes a second
// artifact, a second Dockerfile COPY, and any possibility of the table
// drifting out of sync with the word list.
//
// `has()` binary-searches the sparse index and then scans at most 16 lines,
// comparing bytewise. docs/WORDBOMB.md §3.1.1 deliberately supplies NO
// pseudocode: the architect's own sketch had an inverted comparison and
// reported all 269,746 words missing while looking entirely reasonable.
// Correctness here is proved by dict.test.ts's exhaustive round-trip, not by
// reading this comment.
//
// Never throws once loaded. `loadDict()` itself throws only when the blob is
// genuinely absent — it runs at server start, outside any GameRoomHandle
// member, so I6 is not in scope for it.
// ============================================================================
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMMON_MAX_LEN, DIFFICULTY_BANDS } from '@wordbomb/shared';
import type { Dict, DictBundle, FragmentStats } from './ports.js';

const LF = 0x0a;
const CODE_A = 97; // 'a'
const ALPHABET = 26;
/** Every 3-letter combination over [a-z]: 26^3. */
const FRAGMENT_CODES = ALPHABET * ALPHABET * ALPHABET;
/** Fragment length. FRAGMENT_MIN_LEN === FRAGMENT_MAX_LEN === 3 (config.ts). */
const FRAGMENT_LEN = 3;
/** One sparse-index entry per this many words. Powers of two keep the scan cheap. */
const INDEX_STRIDE = 16;

/**
 * Retained cost of one fragment-table entry, in bytes: a Map slot (~3 pointers)
 * + a 3-char one-byte string + the two-field stats object. Used only by the
 * `bytesResident` accounting; deliberately generous.
 */
const FRAGMENT_ENTRY_BYTES = 96;

// ---- byte helpers ------------------------------------------------------------

/**
 * `blob[i]`, or -1 past the end. `noUncheckedIndexedAccess` types a Uint8Array
 * read as `number | undefined`, and running off the end IS a real case in
 * `compareLineTo` (the final line), so it is folded into a sentinel that can
 * never equal a real byte.
 */
function byteAt(buf: Uint8Array, i: number): number {
  const b = buf[i];
  return b === undefined ? -1 : b;
}

// ---- the loaded bundle -------------------------------------------------------

class BlobDict implements Dict {
  /** The raw blob: sorted words, '\n'-separated, trailing '\n'. */
  private readonly blob: Buffer;
  /** Byte offset of word number `k * INDEX_STRIDE`, ascending. */
  private readonly blockOffsets: Uint32Array;

  /**
   * Shortest / longest word actually in this blob. Derived from the blob rather
   * than from MIN_WORD_LEN / MAX_WORD_LEN so `has()`'s fast reject can never
   * disagree with the data it is searching — a test fixture blob is still
   * answered correctly.
   */
  private readonly minLen: number;
  private readonly maxLen: number;

  readonly size: number;
  readonly bytesResident: number;
  readonly table: ReadonlyMap<string, FragmentStats>;

  constructor(blob: Buffer) {
    this.blob = blob;

    // ---- THE SINGLE PASS ----------------------------------------------------
    // Counters are indexed by a packed fragment code (c0*676 + c1*26 + c2), so
    // no string is built for a fragment until the table is materialised below.
    // `stamp` de-duplicates within a word: `banana` contains `ana` twice but is
    // ONE word containing `ana` (FragmentStats.total counts words).
    const totals = new Int32Array(FRAGMENT_CODES);
    const commons = new Int32Array(FRAGMENT_CODES);
    const stamps = new Int32Array(FRAGMENT_CODES);

    const blockOffsets: number[] = [];
    const len = blob.length;
    let words = 0;
    let start = 0;
    let minLen = Number.MAX_SAFE_INTEGER;
    let maxLen = 0;

    for (let i = 0; i < len; i++) {
      if (blob[i] !== LF) continue;

      if (words % INDEX_STRIDE === 0) blockOffsets.push(start);

      const wordLen = i - start;
      if (wordLen < minLen) minLen = wordLen;
      if (wordLen > maxLen) maxLen = wordLen;
      const isCommon = wordLen <= COMMON_MAX_LEN;
      const stamp = words + 1; // 0 means "never seen"; word numbers start at 1
      const lastFragStart = i - FRAGMENT_LEN;
      for (let p = start; p <= lastFragStart; p++) {
        // In range by construction: p, p+1, p+2 all sit inside [start, i).
        const c0 = blob[p]! - CODE_A;
        const c1 = blob[p + 1]! - CODE_A;
        const c2 = blob[p + 2]! - CODE_A;
        const code = c0 * ALPHABET * ALPHABET + c1 * ALPHABET + c2;
        // The generator guarantees [a-z] only; this guard keeps a corrupt blob
        // from silently writing outside the counters rather than being noticed.
        if (code < 0 || code >= FRAGMENT_CODES) continue;
        if (stamps[code] === stamp) continue;
        stamps[code] = stamp;
        totals[code]!++;
        if (isCommon) commons[code]!++;
      }

      words++;
      start = i + 1;
    }

    this.size = words;
    this.minLen = words === 0 ? 1 : minLen;
    this.maxLen = maxLen;
    this.blockOffsets = Uint32Array.from(blockOffsets);

    // ---- materialise the fragment table ------------------------------------
    // Only fragments at or above the hard band's floor survive; below it a
    // fragment is technically legal and humanly unanswerable (config.ts).
    const floor = DIFFICULTY_BANDS.hard.minInclusive;
    const table = new Map<string, FragmentStats>();
    for (let code = 0; code < FRAGMENT_CODES; code++) {
      const common = commons[code]!;
      if (common < floor) continue;
      const c0 = Math.floor(code / (ALPHABET * ALPHABET));
      const c1 = Math.floor(code / ALPHABET) % ALPHABET;
      const c2 = code % ALPHABET;
      const key = String.fromCharCode(CODE_A + c0, CODE_A + c1, CODE_A + c2);
      table.set(key, { total: totals[code]!, common });
    }
    this.table = table;

    // `stamps`/`totals`/`commons` are unreachable from here on and are collected.
    this.bytesResident =
      blob.byteLength + this.blockOffsets.byteLength + table.size * FRAGMENT_ENTRY_BYTES;
  }

  // ---- lookup ---------------------------------------------------------------

  /**
   * Order of the line starting at `offset` against `word`:
   * negative if the line sorts first, 0 if equal, positive if the word does.
   * A line that is a strict prefix of the word sorts first, and vice versa —
   * that is what makes `cat` < `cats` and keeps the search consistent with the
   * generator's byte-order sort.
   */
  private compareLineTo(offset: number, word: string): number {
    const blob = this.blob;
    let o = offset;
    let i = 0;
    const wlen = word.length;
    for (;;) {
      const b = byteAt(blob, o);
      const lineEnded = b === LF || b === -1;
      const wordEnded = i === wlen;
      if (lineEnded && wordEnded) return 0;
      if (lineEnded) return -1; // line is a prefix of word -> line sorts first
      if (wordEnded) return 1; // word is a prefix of line -> word sorts first
      const c = word.charCodeAt(i);
      if (b !== c) return b - c;
      o++;
      i++;
    }
  }

  has(word: string): boolean {
    // Fast reject on the blob's own length range. Purely an optimisation: the
    // search below is correct for ANY string — uppercase, punctuation and the
    // empty string all sort outside the blob and come back false on their own.
    const wlen = word.length;
    if (wlen < this.minLen || wlen > this.maxLen) return false;

    const blocks = this.blockOffsets;
    const nBlocks = blocks.length;
    if (nBlocks === 0) return false;

    // Find the LAST block whose first word is <= `word`. If even the first
    // block's word sorts after it, the word is below the whole blob.
    if (this.compareLineTo(blocks[0]!, word) > 0) return false;
    let lo = 0;
    let hi = nBlocks - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >>> 1;
      if (this.compareLineTo(blocks[mid]!, word) <= 0) lo = mid;
      else hi = mid - 1;
    }

    // `word` can only live in block `lo`: block lo starts at or below it and
    // block lo+1 starts above it. Scan the <= INDEX_STRIDE lines it holds.
    const blob = this.blob;
    const end = lo + 1 < nBlocks ? blocks[lo + 1]! : blob.length;
    let o = blocks[lo]!;
    while (o < end) {
      const cmp = this.compareLineTo(o, word);
      if (cmp === 0) return true;
      if (cmp > 0) return false; // passed where it would have been
      while (o < end && blob[o] !== LF) o++;
      o++; // step over the newline
    }
    return false;
  }
}

// ---- loading -----------------------------------------------------------------

const BLOB_FILENAME = 'words.blob';

/**
 * Candidate data directories, first hit wins. Mirrors the multi-candidate probe
 * in games/bank/server/src/module.ts, and for the same reason: esbuild inlines
 * this module into platform/server/dist/server.js, so `import.meta.url` is the
 * BUNDLE's url, not this file's. Getting it wrong builds clean and ENOENTs in
 * production.
 *   1. dev (tsx):   here = games/wordbomb/server/src  -> ../data
 *   2. bundled:     here = platform/server/dist       -> <root>/games/wordbomb/server/data
 *   3/4. cwd fallbacks: repo root (and the Docker WORKDIR), and the package dir
 *        (`npm -w @wordbomb/server` scripts run with cwd = the package).
 */
function dataDirCandidates(): string[] {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return [
    path.resolve(here, '../data'),
    path.resolve(here, '../../../games/wordbomb/server/data'),
    path.resolve(process.cwd(), 'games/wordbomb/server/data'),
    path.resolve(process.cwd(), 'data'),
  ];
}

/**
 * Load the blob and derive the index + fragment table. Call once at server
 * start — this is ~25 ms and ~3 MB, not something to do per room.
 *
 * @param dataDir optional explicit directory holding `words.blob` (tests).
 * @throws if the blob cannot be found or is empty/unterminated. Startup-only.
 */
export function loadDict(dataDir?: string): DictBundle {
  const candidates = dataDir === undefined ? dataDirCandidates() : [path.resolve(dataDir)];
  let file: string | undefined;
  for (const dir of candidates) {
    const p = path.join(dir, BLOB_FILENAME);
    if (existsSync(p)) {
      file = p;
      break;
    }
  }
  if (file === undefined) {
    throw new Error(
      `wordbomb: ${BLOB_FILENAME} not found. Looked in:\n  ${candidates.join('\n  ')}\n` +
        'Run `npm run generate -w @wordbomb/server` to build it.',
    );
  }

  const blob = readFileSync(file); // Buffer, never a string — see the header.
  if (blob.length === 0) throw new Error(`wordbomb: ${file} is empty`);
  if (blob[blob.length - 1] !== LF) {
    throw new Error(`wordbomb: ${file} does not end with a newline`);
  }

  const dict = new BlobDict(blob);
  const table = dict.table;
  return {
    dict,
    fragments: () => table,
    bytesResident: dict.bytesResident,
  };
}
