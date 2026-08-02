// ============================================================================
// Gate for the STRICKEN in-match arc pass (task B3c): contract C5's derived
// accuracy + end-of-match stats, and contract C6's client-derived match point,
// plus the round-win run folded from the `round_end` stream.
//
// Lives under src/render/ ON PURPOSE. vitest.config.ts's ONLY include glob for
// the fps client is `games/fps/client/src/render/**/*.test.ts` -- a suite
// written next to hud.ts in src/ui/ would be SILENTLY SKIPPED, which has
// already happened three times in this repo. Verified collected with
// `rtk proxy "npx vitest list --filesOnly"` (plain `npx vitest list` is broken
// here and reports a false-negative "PASS (0) FAIL (0)").
//
// Everything asserted here is pure. There is no jsdom in this repo, so the DOM
// half -- layout, overlap, legibility -- is verified on PIXELS instead, which
// is where both sibling tasks found the defects their unit tests missed.
// ============================================================================
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ROUNDS } from '@fps/shared';
import type { Team } from '@fps/shared';
import {
  ACC_NONE,
  NO_STREAK,
  STREAK_MIN,
  accuracyText,
  damageBar01,
  matchPointCopy,
  matchPointOf,
  matchResultTitle,
  maxDamageOf,
  nextWinStreak,
  stakesVisible,
  streakCopy,
  swapStreakSides,
} from '../ui/hud.js';
import type { MatchStatRow, WinStreak } from '../ui/hud.js';

// ---------------------------------------------------------------------------
// C5 -- ACCURACY IS DERIVED ON THE CLIENT.
//
// The server sends shotsFired/shotsHit (trigger PULLS, not pellets) and never a
// float. The zero-fired case is the one that would embarrass us in front of a
// player, so it is asserted from every direction it can arrive: a knife-only
// round, a player who spent the match dead, a bot that never got line of sight.
// ---------------------------------------------------------------------------
describe('accuracyText (C5)', () => {
  it("renders '—' when shotsFired === 0 -- NOT 0%, NOT NaN%", () => {
    expect(accuracyText(0, 0)).toBe(ACC_NONE);
    expect(accuracyText(0, 0)).not.toBe('0%');
    expect(accuracyText(0, 0)).not.toContain('NaN');
  });

  it('uses an EM DASH, the character C5 spells out -- not a hyphen', () => {
    expect(ACC_NONE).toBe('—');
    expect(ACC_NONE).not.toBe('-');
  });

  it('never emits NaN/Infinity/undefined for any malformed pair', () => {
    const bad: ReadonlyArray<readonly [number, number]> = [
      [0, 0], [5, 0], [Number.NaN, 0], [0, Number.NaN], [Number.NaN, Number.NaN],
      [1, Number.POSITIVE_INFINITY], [Number.POSITIVE_INFINITY, 10],
      [-3, -3], [0, -1], [-3, 10],
    ];
    for (const [hit, fired] of bad) {
      const s = accuracyText(hit, fired);
      expect(s).not.toContain('NaN');
      expect(s).not.toContain('Infinity');
      expect(s).not.toContain('undefined');
      expect(s === ACC_NONE || /^\d{1,3}%$/.test(s)).toBe(true);
    }
  });

  it('computes shotsHit / shotsFired as a whole percent', () => {
    expect(accuracyText(7, 10)).toBe('70%');
    expect(accuracyText(1, 3)).toBe('33%');
    expect(accuracyText(2, 3)).toBe('67%');
    expect(accuracyText(30, 30)).toBe('100%');
  });

  it('distinguishes "never fired" from "fired and missed everything"', () => {
    // the entire reason this is a function and not a division
    expect(accuracyText(0, 0)).toBe(ACC_NONE);
    expect(accuracyText(0, 24)).toBe('0%');
    expect(accuracyText(0, 0)).not.toBe(accuracyText(0, 24));
  });

  it('clamps a hits > pulls server bug to 100% rather than printing 140%', () => {
    expect(accuracyText(14, 10)).toBe('100%');
  });
});

// ---------------------------------------------------------------------------
// C6 -- MATCH POINT IS DERIVED CLIENT-SIDE FROM round_start's SCORES.
//
// Nothing is added to the wire. The threshold comes from the shared config, so
// these tests are written against ROUNDS.winRounds AND against an explicit
// override -- an implementation that hard-coded 6 passes the first set and
// fails the second, which is exactly the drift the contract forbids.
// ---------------------------------------------------------------------------
describe('matchPointOf (C6)', () => {
  const W = ROUNDS.winRounds;

  it('is none while both sides are more than one win away', () => {
    expect(matchPointOf(0, 0)).toBe('none');
    expect(matchPointOf(W - 2, W - 2)).toBe('none');
    expect(matchPointOf(W - 2, 0)).toBe('none');
  });

  it('names the single side sitting on winRounds - 1', () => {
    expect(matchPointOf(W - 1, 0)).toBe('T');
    expect(matchPointOf(0, W - 1)).toBe('CT');
    expect(matchPointOf(W - 1, W - 2)).toBe('T');
    expect(matchPointOf(W - 2, W - 1)).toBe('CT');
  });

  it('reports BOTH when both sides are one win away (the C6 decider case)', () => {
    // reachable for real: maxRounds 10 with halftime at 5 makes a 5-5 tenth
    // round a genuine decider, not a defensive branch
    expect(matchPointOf(W - 1, W - 1)).toBe('both');
  });

  it('reads winRounds from the config -- a hard-coded 6 fails here', () => {
    expect(matchPointOf(2, 0, 3)).toBe('T');
    expect(matchPointOf(5, 0, 3)).toBe('none'); // already past a 3-round match
    expect(matchPointOf(6, 0, 8)).toBe('none'); // 6 means nothing at winRounds 8
    expect(matchPointOf(7, 0, 8)).toBe('T');
  });

  it('does not call a side that has ALREADY won the match "one win away"', () => {
    expect(matchPointOf(W, 0)).toBe('none');
    expect(matchPointOf(W + 3, 0)).toBe('none');
    // the other side is still judged on its own score. Unreachable in practice
    // (match_end owns the screen the instant a side reaches winRounds), pinned
    // so the branch is DEFINED rather than left to whoever reads it next.
    expect(matchPointOf(W + 3, W - 1)).toBe('CT');
  });

  it('degrades to none on a degenerate winRounds or a garbage score', () => {
    for (const w of [1, 0, -4, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(matchPointOf(0, 0, w)).toBe('none');
      expect(matchPointOf(5, 5, w)).toBe('none');
    }
    expect(matchPointOf(Number.NaN, Number.NaN)).toBe('none');
  });
});

describe('matchPointCopy (C6 -- ONE decider, never two banners)', () => {
  const W = ROUNDS.winRounds;

  it('says nothing at all when there is no match point', () => {
    expect(matchPointCopy('none', 'T')).toBeNull();
    expect(matchPointCopy('none', null)).toBeNull();
  });

  it('produces exactly ONE chip for the both-sides case', () => {
    const copy = matchPointCopy(matchPointOf(W - 1, W - 1), 'T');
    expect(copy).not.toBeNull();
    // the return type is a single ArcCopy: there is structurally no way to emit
    // a competing pair of banners from this call
    expect(Array.isArray(copy)).toBe(false);
  });

  it('names NEITHER side in the both-sides case', () => {
    const copy = matchPointCopy('both', 'T');
    expect(copy).not.toBeNull();
    const text = `${copy?.tag ?? ''} ${copy?.line ?? ''}`;
    expect(text).not.toMatch(/\bT\b/);
    expect(text).not.toMatch(/\bCT\b/);
    expect(copy?.tag).toBe('DECIDER');
  });

  it('reads identically whichever side you are on when both are at match point', () => {
    const asT = matchPointCopy('both', 'T');
    const asCT = matchPointCopy('both', 'CT');
    const asNobody = matchPointCopy('both', null);
    expect(asT).toEqual(asCT);
    expect(asT).toEqual(asNobody);
  });

  it('is a DIFFERENT state from a single side at match point', () => {
    const both = matchPointCopy('both', 'T');
    expect(both).not.toEqual(matchPointCopy('T', 'T'));
    expect(both).not.toEqual(matchPointCopy('CT', 'T'));
  });

  it('names the side, and says whose round it is, for a single match point', () => {
    for (const side of ['T', 'CT'] as const) {
      const foe: Team = side === 'T' ? 'CT' : 'T';
      const mine = matchPointCopy(side, side);
      const theirs = matchPointCopy(side, foe);
      expect(mine?.tag).toBe('MATCH POINT');
      expect(theirs?.tag).toBe('MATCH POINT');
      // the two readings must not be the same sentence -- "I can win it" and
      // "they can win it" are opposite information
      expect(mine?.line).not.toBe(theirs?.line);
      expect(theirs?.line).toContain(side);
    }
  });
});

// ---------------------------------------------------------------------------
// ROUND-WIN RUN -- folded from the round_end stream, NOT from the server's
// lossStreak pair.
//
// types.ts warns about this beside `round_end` and it is the trap this whole
// block exists to prove we did not fall into: a draw increments BOTH of the
// server's loss counters, so "the opponent's loss streak" is not a win streak.
// ---------------------------------------------------------------------------
describe('nextWinStreak (draws handled explicitly)', () => {
  /** Fold a whole round_end sequence, the way clientGame does live. */
  const fold = (seq: ReadonlyArray<Team | null>): WinStreak =>
    seq.reduce<WinStreak>((acc, w) => nextWinStreak(acc, w), NO_STREAK);

  it('starts with nobody on a run', () => {
    expect(NO_STREAK).toEqual({ team: null, count: 0 });
  });

  it('counts consecutive wins by one side', () => {
    expect(fold(['T'])).toEqual({ team: 'T', count: 1 });
    expect(fold(['T', 'T'])).toEqual({ team: 'T', count: 2 });
    expect(fold(['T', 'T', 'T'])).toEqual({ team: 'T', count: 3 });
  });

  it('hands the run over when the other side wins', () => {
    expect(fold(['T', 'T', 'CT'])).toEqual({ team: 'CT', count: 1 });
    expect(fold(['T', 'CT', 'T', 'CT'])).toEqual({ team: 'CT', count: 1 });
  });

  it('BREAKS BOTH runs on a draw -- winner null is nobody winning', () => {
    expect(fold(['T', 'T', 'T', null])).toEqual(NO_STREAK);
    expect(fold([null])).toEqual(NO_STREAK);
    expect(fold(['CT', null])).toEqual(NO_STREAK);
  });

  it('does not credit the OPPONENT of a draw with a win (the lossStreak trap)', () => {
    // The server increments both loss counters on a draw. If this had been read
    // off "the opponent's loss streak", CT would show a run of 2 here after
    // winning exactly one round. It must show 1.
    const after = fold(['CT', null, 'CT']);
    expect(after).toEqual({ team: 'CT', count: 1 });
    expect(after.count).not.toBe(2);
  });

  it('a draw in the middle of a run restarts the count, it does not continue it', () => {
    expect(fold(['T', 'T', 'T', null, 'T'])).toEqual({ team: 'T', count: 1 });
  });

  it('is pure -- folding the same sequence twice gives the same answer', () => {
    const seq: ReadonlyArray<Team | null> = ['T', 'CT', 'CT', null, 'CT', 'CT', 'CT'];
    expect(fold(seq)).toEqual(fold(seq));
    expect(fold(seq)).toEqual({ team: 'CT', count: 3 });
  });

  it('never mutates the streak it was handed', () => {
    const prev: WinStreak = { team: 'T', count: 4 };
    nextWinStreak(prev, 'T');
    nextWinStreak(prev, null);
    expect(prev).toEqual({ team: 'T', count: 4 });
  });
});

describe('swapStreakSides (halftime)', () => {
  it('moves the run to the other label, keeping the count', () => {
    expect(swapStreakSides({ team: 'T', count: 3 })).toEqual({ team: 'CT', count: 3 });
    expect(swapStreakSides({ team: 'CT', count: 1 })).toEqual({ team: 'T', count: 1 });
  });

  it('leaves "nobody is on a run" alone', () => {
    expect(swapStreakSides(NO_STREAK)).toEqual(NO_STREAK);
  });

  it('follows the players, exactly as the server makes the SCORES do', () => {
    // game.ts advanceAfterRound swaps scoreT/scoreCT at halftime "so they
    // follow the players". A run that stayed with the label while the score
    // moved would credit the wrong half of the room for the second half.
    const beforeSwap = nextWinStreak(nextWinStreak(NO_STREAK, 'T'), 'T');
    expect(beforeSwap).toEqual({ team: 'T', count: 2 });
    const afterSwap = swapStreakSides(beforeSwap);
    expect(afterSwap.team).toBe('CT');
    // and the run keeps counting for the same humans under their new label
    expect(nextWinStreak(afterSwap, 'CT')).toEqual({ team: 'CT', count: 3 });
  });

  it('is its own inverse', () => {
    const st: WinStreak = { team: 'T', count: 4 };
    expect(swapStreakSides(swapStreakSides(st))).toEqual(st);
  });
});

describe('stakesVisible', () => {
  it('is off before a match has a round', () => {
    expect(stakesVisible('warmup', 0)).toBe(false);
    expect(stakesVisible('freeze', 0)).toBe(false);
    expect(stakesVisible('warmup', 3)).toBe(false);
  });

  it('is on through a played round', () => {
    expect(stakesVisible('freeze', 1)).toBe(true);
    expect(stakesVisible('live', 1)).toBe(true);
    expect(stakesVisible('freeze', ROUNDS.maxRounds)).toBe(true);
    expect(stakesVisible('live', ROUNDS.maxRounds)).toBe(true);
  });

  it('is off on the match-end screen, which has the full board instead', () => {
    expect(stakesVisible('matchEnd', 6)).toBe(false);
    expect(stakesVisible('matchEnd', ROUNDS.maxRounds)).toBe(false);
  });

  it('survives roundEnd while another round is still coming', () => {
    expect(stakesVisible('roundEnd', 1)).toBe(true);
    expect(stakesVisible('roundEnd', ROUNDS.maxRounds - 1)).toBe(true);
  });

  it('does NOT claim a next round after the last one has been played', () => {
    // the real defect this guards: the server holds roundEnd for 4s after the
    // final round, and a maxRounds tie ends on 5-5 -- both sides at
    // winRounds - 1. Unguarded, that reads "DECIDER: NEXT ROUND TAKES THE
    // MATCH" for four seconds with no next round in existence.
    expect(matchPointOf(ROUNDS.winRounds - 1, ROUNDS.winRounds - 1)).toBe('both');
    expect(stakesVisible('roundEnd', ROUNDS.maxRounds)).toBe(false);
  });

  it('rejects a garbage round number rather than guessing', () => {
    expect(stakesVisible('live', Number.NaN)).toBe(false);
    expect(stakesVisible('live', -2)).toBe(false);
  });
});

describe('streakCopy', () => {
  it('stays silent below the threshold -- one win is not a run', () => {
    expect(streakCopy(NO_STREAK, 'T')).toBeNull();
    expect(streakCopy({ team: 'T', count: 1 }, 'T')).toBeNull();
    expect(STREAK_MIN).toBeGreaterThanOrEqual(2);
  });

  it('says nothing after a draw, whatever the previous run was', () => {
    const afterDraw = nextWinStreak({ team: 'T', count: 5 }, null);
    expect(streakCopy(afterDraw, 'T')).toBeNull();
  });

  it('reports the count once the run is worth naming', () => {
    expect(streakCopy({ team: 'T', count: STREAK_MIN }, 'CT')?.tag)
      .toBe(`${STREAK_MIN} IN A ROW`);
    expect(streakCopy({ team: 'CT', count: 4 }, 'T')?.tag).toBe('4 IN A ROW');
  });

  it('reads differently depending on whether the run is yours', () => {
    const mine = streakCopy({ team: 'T', count: 3 }, 'T');
    const theirs = streakCopy({ team: 'T', count: 3 }, 'CT');
    expect(mine?.line).not.toBe(theirs?.line);
    expect(theirs?.line).toContain('T');
  });
});

// ---------------------------------------------------------------------------
// C5 -- THE END SCREEN.
// ---------------------------------------------------------------------------
describe('matchResultTitle', () => {
  it('answers the first question the screen has to answer', () => {
    expect(matchResultTitle('T', 'T')).toBe('VICTORY');
    expect(matchResultTitle('T', 'CT')).toBe('DEFEAT');
    expect(matchResultTitle('CT', 'CT')).toBe('VICTORY');
    expect(matchResultTitle('CT', 'T')).toBe('DEFEAT');
  });

  it('claims neither result for a spectator with no side', () => {
    expect(matchResultTitle('T', null)).toBe('MATCH OVER');
    expect(matchResultTitle('CT', null)).toBe('MATCH OVER');
  });
});

describe('damage column', () => {
  const row = (damage: number): MatchStatRow => ({
    id: 'x', name: 'x', team: 'T',
    kills: 0, deaths: 0, headshots: 0, damage, shotsFired: 0, shotsHit: 0,
  });

  it('finds the top damage on the board', () => {
    expect(maxDamageOf([row(120), row(880), row(0)])).toBe(880);
    expect(maxDamageOf([])).toBe(0);
    expect(maxDamageOf([row(0), row(0)])).toBe(0);
    expect(maxDamageOf([row(Number.NaN), row(40)])).toBe(40);
  });

  it('scales a bar to the top damage, clamped to 0..1', () => {
    expect(damageBar01(440, 880)).toBeCloseTo(0.5, 6);
    expect(damageBar01(880, 880)).toBe(1);
    expect(damageBar01(0, 880)).toBe(0);
    expect(damageBar01(1200, 880)).toBe(1); // never overruns its track
  });

  it('degrades to an empty bar rather than NaN on a zero or garbage max', () => {
    for (const [d, m] of [[10, 0], [10, Number.NaN], [Number.NaN, 10], [-5, 10]] as const) {
      const v = damageBar01(d, m);
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it('makes the chip-everyone / kill-nobody player visible', () => {
    // the exact player the old top-3-BY-KILLS list rendered as nothing at all
    const board = [row(910), row(0), row(720)];
    expect(damageBar01(board[2]!.damage, maxDamageOf(board))).toBeGreaterThan(0.75);
  });
});

// ---------------------------------------------------------------------------
// C5 -- THE ORDER IS THE SERVER'S.
//
// `stats` arrives ordered by kills DESC, damage DESC, deaths ASC, join order
// ASC -- a documented strict total order. A client-side re-sort would produce a
// board that disagrees with the one the server described, and it would do it
// SILENTLY: no test that only checks "all rows rendered" can see it, and the
// screen still looks plausible. This is a source-level guard because the render
// path is DOM and there is no jsdom here to walk the rows with.
// ---------------------------------------------------------------------------
describe('end-screen render path never re-sorts (C5)', () => {
  const hudSrc = readFileSync(
    fileURLToPath(new URL('../ui/hud.ts', import.meta.url)),
    'utf8',
  );
  const start = hudSrc.indexOf('matchEnd(info: MatchEndInfo | null): void {');
  const end = hudSrc.indexOf('banner(title: string, sub: string): void {');

  it('locates the end-screen render path in hud.ts', () => {
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
  });

  it('contains no sort, reverse or comparator anywhere in that path', () => {
    const region = hudSrc.slice(start, end);
    expect(region).not.toMatch(/\bsort\b/);
    expect(region).not.toMatch(/\breverse\b/);
    expect(region).not.toMatch(/localeCompare/);
  });

  it('iterates info.stats directly, in the order it arrived', () => {
    const region = hudSrc.slice(start, end);
    expect(region).toContain('for (const r of info.stats)');
  });
});
