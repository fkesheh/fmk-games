// ============================================================================
// FROZEN CONTRACT — WORDBOMB scoring. Pure functions, no I/O, unit-testable.
// ============================================================================
import { MAX_SCORING_LEN } from './config.js';
import type { WbAnswer } from './types.js';

/**
 * points = max( L , floor( 12 * L / dupes^1.5 ) )   where L = min(len, 12)
 *
 * Arrived at by simulation, not taste. Two earlier formulas were measured and
 * rejected against 20,000-round Monte-Carlo runs using real word-frequency data:
 *
 *  - `len^2 / dupes` — BROKEN. "Always go long" beat "go unique" in 6 of 6
 *    cells by 17-32%. Length and uniqueness are POSITIVELY correlated, not a
 *    trade-off: collision rate at 8 players falls monotonically with length
 *    (3 letters 73.6%, 6 letters 44.5%, 12 letters 21.6%). No decision existed.
 *
 *  - `len^2 / dupes^2` — OVERCORRECTED. Fixed hard/normal but gutted them:
 *    median score in an 8-player hard round collapsed to 6, and `floor(9/16)`
 *    means ~10% of player-rounds awarded ZERO for a genuinely valid word, which
 *    reads to a player as a bug rather than a scoring rule.
 *
 * The divisor was the wrong lever. Measured ceiling: even scoring 0 on ANY
 * collision leaves the easy band at -13.8% (LONG still wins), so no exponent
 * can fix it. `len^2` is what makes long words unbeatable — so FLATTEN LENGTH
 * and put the weight on the split instead.
 *
 * The `max(L, ...)` floor is a structural guarantee: A VALID WORD ALWAYS PAYS
 * AT LEAST ITS OWN LENGTH. That is what eliminates the zero-award failure.
 *
 *   3 letters alone ->  36      6 letters x2 -> 25
 *   6 letters alone ->  72      6 letters x4 ->  9
 *  12 letters alone -> 144     12 letters x3 -> 27
 *
 * CLIENT USE: the client may only ever call this with `dupes = 1`, because
 * `dupes` is unknowable before the boom BY CONSTRUCTION of I1. That is a
 * MAXIMUM ("up to 144 — if nobody else finds it"), and the UI must label it as
 * such. Asking the server for a live dupe count is a fatal I1 breach.
 */
export function scoreWord(word: string, dupes: number): number {
  if (word.length === 0) return 0;
  const d = Number.isFinite(dupes) ? Math.max(1, Math.floor(dupes)) : 1;
  const len = Math.min(word.length, MAX_SCORING_LEN);
  return Math.max(len, Math.floor((MAX_SCORING_LEN * len) / Math.pow(d, 1.5)));
}

/**
 * Resolve a whole round.
 *
 * `players` is the roster at boom time; `words` maps a player id to their last
 * VALID word. Taking the roster as a SEPARATE parameter is deliberate: I7 (the
 * reveal is total) then holds BY CONSTRUCTION. An earlier signature took only
 * the word map, which meant a player who never locked simply vanished from the
 * reveal — an invariant the caller had to remember rather than one the type
 * enforced.
 *
 * Ids in `words` that are not in `players` are ignored.
 */
export function resolveRound(
  players: readonly { id: string; name: string }[],
  words: ReadonlyMap<string, string>,
): WbAnswer[] {
  const counts = new Map<string, number>();
  for (const p of players) {
    const word = words.get(p.id);
    if (word === undefined) continue;
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  const out: WbAnswer[] = [];
  for (const p of players) {
    const word = words.get(p.id);
    if (word === undefined) {
      out.push({ playerId: p.id, name: p.name, word: null, dupes: 0, points: 0 });
      continue;
    }
    const dupes = counts.get(word) ?? 1;
    out.push({ playerId: p.id, name: p.name, word, dupes, points: scoreWord(word, dupes) });
  }
  return out;
}

/**
 * Final standings: score DESC, then JOIN ORDER ASC (the order of `players`).
 * The winner is `standings[0]` when there is at least one player.
 *
 * Ties are common — scores are sums of floor(n^2/d) — so the tie-break is part
 * of the contract, not an implementation detail. Join order matches BANK.
 */
export function standingsOf(
  players: readonly { id: string; name: string; score: number }[],
): { playerId: string; name: string; score: number }[] {
  return players
    .map((p, i) => ({ p, i }))
    .sort((a, b) => (b.p.score - a.p.score) || (a.i - b.i))
    .map(({ p }) => ({ playerId: p.id, name: p.name, score: p.score }));
}
