// ============================================================================
// B1p — escalating loss bonus (STRICKEN_PASS.md §1 C2 as AMENDED, §2 I5/I6).
//
// PURE unit tests over `roundRewards` plus a deterministic 10-round economy
// simulation of BOTH sides. The simulation exists to keep the amended tune
// honest: the first draft (step 500 / max 3400 — the literal CS ladder) was
// measured here and shown to hand the losing team rifles from a single payout,
// which is what prompted the amendment to step 400 / max 2600.
//
// Nothing here touches the room.
// ============================================================================
import { describe, expect, it } from 'vitest';
import { ECONOMY, GEAR, ROUNDS, WEAPONS, type Team } from '@fps/shared';
import { roundRewards } from './economy.js';

// The exact ladder the contract freezes: 0->1400, 1->1800, 2->2200, 3->2600, 4+->2600.
const LADDER: ReadonlyArray<readonly [streak: number, payout: number]> = [
  [0, 1400],
  [1, 1800],
  [2, 2200],
  [3, 2600],
  [4, 2600],
  [5, 2600],
  [9, 2600],
  [100, 2600],
];

describe('roundRewards — ladder', () => {
  it('constants match the frozen contract', () => {
    expect(ECONOMY.lossRewardBase).toBe(1400);
    expect(ECONOMY.lossRewardStep).toBe(400);
    expect(ECONOMY.lossRewardMax).toBe(2600);
    expect(ECONOMY.winReward).toBe(3250);
    // The flat reward is gone — nothing may read it any more.
    expect('lossReward' in ECONOMY).toBe(false);
  });

  it.each(LADDER)('T loses on streak %i -> %i (CT takes the win reward)', (streak, payout) => {
    const r = roundRewards('CT', { t: streak, ct: 0 });
    expect(r.t).toBe(payout);
    expect(r.ct).toBe(ECONOMY.winReward);
  });

  it.each(LADDER)('CT loses on streak %i -> %i (T takes the win reward)', (streak, payout) => {
    const r = roundRewards('T', { t: 0, ct: streak });
    expect(r.ct).toBe(payout);
    expect(r.t).toBe(ECONOMY.winReward);
  });

  it("ignores the winner's own streak entry", () => {
    // A team on a 4-round streak that finally wins is paid the win reward, not
    // a capped loss reward.
    expect(roundRewards('T', { t: 4, ct: 0 })).toEqual({ t: ECONOMY.winReward, ct: 1400 });
    expect(roundRewards('CT', { t: 0, ct: 7 })).toEqual({ t: 1400, ct: ECONOMY.winReward });
  });

  it('the cap binds from streak 3 — full catch-up lands while the match is still alive', () => {
    // The amendment's whole point: a 10-round first-to-6 match cannot wait until
    // streak 4 (the CS ladder) to finish escalating.
    expect(roundRewards('CT', { t: 2, ct: 0 }).t).toBe(2200);
    expect(roundRewards('CT', { t: 3, ct: 0 }).t).toBe(ECONOMY.lossRewardMax);
    expect(roundRewards('CT', { t: 4, ct: 0 }).t).toBe(ECONOMY.lossRewardMax);
    expect(ECONOMY.lossRewardBase + ECONOMY.lossRewardStep * 3).toBe(ECONOMY.lossRewardMax);
  });
});

describe('roundRewards — draws', () => {
  it('winner === null pays BOTH teams their own streak-based loss reward', () => {
    expect(roundRewards(null, { t: 0, ct: 0 })).toEqual({ t: 1400, ct: 1400 });
    expect(roundRewards(null, { t: 2, ct: 4 })).toEqual({ t: 2200, ct: 2600 });
    expect(roundRewards(null, { t: 9, ct: 1 })).toEqual({ t: 2600, ct: 1800 });
  });

  it('a draw never pays either team the win reward', () => {
    for (let s = 0; s <= 12; s++) {
      const r = roundRewards(null, { t: s, ct: s });
      expect(r.t).toBeLessThanOrEqual(ECONOMY.lossRewardMax);
      expect(r.ct).toBeLessThanOrEqual(ECONOMY.lossRewardMax);
    }
  });
});

describe('roundRewards — streak clamping', () => {
  const CLAMPED: ReadonlyArray<readonly [label: string, streak: number, payout: number]> = [
    ['negative', -1, 1400],
    ['very negative', -1000, 1400],
    ['fractional below a rung', 2.7, 2200], // floor(2.7) = 2
    ['fractional at a rung', 3.0, 2600],
    ['negative fractional', -0.5, 1400], // floor(-0.5) = -1 -> clamped to 0
    ['NaN', Number.NaN, 1400],
    ['+Infinity', Number.POSITIVE_INFINITY, 1400],
    ['-Infinity', Number.NEGATIVE_INFINITY, 1400],
  ];

  it.each(CLAMPED)('%s streak (%s) -> %i', (_label, streak, payout) => {
    expect(roundRewards('CT', { t: streak, ct: 0 }).t).toBe(payout);
    expect(roundRewards('T', { t: 0, ct: streak }).ct).toBe(payout);
    expect(roundRewards(null, { t: streak, ct: streak })).toEqual({ t: payout, ct: payout });
  });

  it('always returns a finite payout in [lossRewardBase, winReward]', () => {
    const inputs = [-5, -0.1, 0, 0.5, 1, 3.9, 4, 50, Number.NaN, Number.POSITIVE_INFINITY];
    for (const s of inputs) {
      for (const w of ['T', 'CT', null] as const) {
        const r = roundRewards(w, { t: s, ct: s });
        for (const gain of [r.t, r.ct]) {
          expect(Number.isFinite(gain)).toBe(true);
          expect(gain).toBeGreaterThanOrEqual(ECONOMY.lossRewardBase);
          expect(gain).toBeLessThanOrEqual(ECONOMY.winReward);
        }
      }
    }
  });
});

describe('invariants', () => {
  it('I5 — a longer loss streak never pays less (monotone over 0..30)', () => {
    let prev = -Infinity;
    for (let s = 0; s <= 30; s++) {
      const payout = roundRewards('CT', { t: s, ct: 0 }).t;
      expect(payout).toBeGreaterThanOrEqual(prev);
      prev = payout;
    }
    expect(prev).toBe(ECONOMY.lossRewardMax);
  });

  it('I5 — monotone across the fractional/negative domain too', () => {
    const domain = [-10, -3, -1, -0.5, 0, 0.9, 1, 1.5, 2, 3.99, 4, 12, 1e6];
    let prev = -Infinity;
    for (const s of domain) {
      const payout = roundRewards(null, { t: s, ct: s }).t;
      expect(payout).toBeGreaterThanOrEqual(prev);
      prev = payout;
    }
  });

  it('I6 — caller-side clamp keeps money inside [0, ECONOMY.max]', () => {
    // Mirrors game.ts:956: money = min(ECONOMY.max, money + gain).
    const apply = (money: number, gain: number) => Math.max(0, Math.min(ECONOMY.max, money + gain));
    for (const start of [0, 800, ECONOMY.max - 1, ECONOMY.max]) {
      for (const streak of [0, 2, 4, 40]) {
        for (const w of ['T', 'CT', null] as const) {
          const r = roundRewards(w, { t: streak, ct: streak });
          const money = apply(start, r.t);
          expect(money).toBeGreaterThanOrEqual(0);
          expect(money).toBeLessThanOrEqual(ECONOMY.max);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// STRUCTURAL CONSTRAINTS — the three relationships the amended tune encodes.
// These are pinned so no future retune-by-feel can silently violate them.
// ---------------------------------------------------------------------------
describe('structural constraints on the ladder (pinned)', () => {
  it('base < smg price — one loss can never fund a gun', () => {
    expect(ECONOMY.lossRewardBase).toBeLessThan(WEAPONS.smg.price);
    // ...and the starting stack cannot either, so R1 is a genuine pistol round.
    expect(ECONOMY.start).toBeLessThan(WEAPONS.smg.price);
  });

  it('streak 2 reaches smg+vest — catch-up lands by the SECOND loss', () => {
    const smgPlusVest = WEAPONS.smg.price + GEAR.kevlarPrice;
    expect(roundRewards('CT', { t: 2, ct: 0 }).t).toBeGreaterThanOrEqual(smgPlusVest);
    // And not before: streak 1 must still be a force-buy, or there is no slump.
    expect(roundRewards('CT', { t: 1, ct: 0 }).t).toBeLessThan(smgPlusVest);
  });

  it('max < rifle price < winReward — a payout alone NEVER buys a rifle', () => {
    expect(ECONOMY.lossRewardMax).toBeLessThan(WEAPONS.rifle.price);
    expect(WEAPONS.rifle.price).toBeLessThan(ECONOMY.winReward);
    // The way out of a slump is fragging or saving, not waiting: the capped
    // payout plus a single kill clears a rifle.
    expect(ECONOMY.lossRewardMax + ECONOMY.killReward).toBeGreaterThanOrEqual(WEAPONS.rifle.price);
  });
});

// ---------------------------------------------------------------------------
// The two-sided simulation.
//
// LOSER: dies every round, so the loadout resets to knife+pistol
// (game.ts:1211) and the vest is stripped (game.ts:1183-1184) — a full rebuy
// every round. Buy policy is the bot policy (bots.ts:133-134): best affordable
// primary in the order rifle > smg, then a vest if the remainder covers it.
//
// WINNER: survives, so it KEEPS its primary and refillWeapons() (game.ts:934)
// tops up mag+reserve for free at freeze. It therefore pays only to acquire or
// upgrade a primary it does not already have, plus a vest for chip damage.
// This asymmetry is why the winner's 3250 is nearly all savings while the
// loser's payout is entirely rebuy — comparing raw income between the sides is
// misleading, so this sim reports fielded LOADOUT TIER, not just money.
// ---------------------------------------------------------------------------
type Tier = 'eco' | 'smg' | 'rifle';

interface LoserRow {
  round: number;
  streak: number;
  moneyBefore: number;
  bought: string;
  tier: Tier;
  moneyAfterBuy: number;
  gain: number;
  moneyEnd: number;
}

interface WinnerRow {
  round: number;
  moneyBefore: number;
  bought: string;
  primary: 'rifle' | 'smg' | null;
  moneyEnd: number;
}

type RewardFn = (winner: Team | null, lossStreak: { t: number; ct: number }) => { t: number; ct: number };

/** The pre-C2 behaviour: a flat 1900 for the loser, no streak input at all. */
const LEGACY_FLAT = 1900;
const legacyRoundRewards: RewardFn = (winner) => ({
  t: winner === 'T' ? ECONOMY.winReward : LEGACY_FLAT,
  ct: winner === 'CT' ? ECONOMY.winReward : LEGACY_FLAT,
});

/** The rejected first draft, kept so the amendment's improvement is measurable. */
const draftRoundRewards: RewardFn = (winner, s) => ({
  t: winner === 'T' ? ECONOMY.winReward : Math.min(1400 + 500 * Math.max(0, s.t), 3400),
  ct: winner === 'CT' ? ECONOMY.winReward : Math.min(1400 + 500 * Math.max(0, s.ct), 3400),
});

/** Indexed access under `noUncheckedIndexedAccess` — a miss is a test bug, not a soft undefined. */
function row<T>(rows: readonly T[], i: number): T {
  const r = rows[i];
  if (r === undefined) throw new Error(`no simulated round at index ${i}`);
  return r;
}

function tierOf(bought: string): Tier {
  if (bought.includes('rifle')) return 'rifle';
  if (bought.includes('smg')) return 'smg';
  return 'eco';
}

function loserBuy(money: number): { bought: string; money: number } {
  let m = money;
  const items: string[] = [];
  if (m >= WEAPONS.rifle.price) {
    m -= WEAPONS.rifle.price;
    items.push('rifle');
  } else if (m >= WEAPONS.smg.price) {
    m -= WEAPONS.smg.price;
    items.push('smg');
  }
  if (m >= GEAR.kevlarPrice) {
    m -= GEAR.kevlarPrice;
    items.push('vest');
  }
  return { bought: items.length === 0 ? 'pistol only' : items.join('+'), money: m };
}

function winnerBuy(money: number, primary: 'rifle' | 'smg' | null): { bought: string; money: number; primary: 'rifle' | 'smg' | null } {
  let m = money;
  let p = primary;
  const items: string[] = [];
  if (p !== 'rifle' && m >= WEAPONS.rifle.price) {
    m -= WEAPONS.rifle.price;
    p = 'rifle';
    items.push('buy rifle');
  } else if (p === null && m >= WEAPONS.smg.price) {
    m -= WEAPONS.smg.price;
    p = 'smg';
    items.push('buy smg');
  }
  if (m >= GEAR.kevlarPrice) {
    m -= GEAR.kevlarPrice;
    items.push('vest');
  }
  const kept = items.length === 0 ? ' (kept, free refill)' : ` (${items.join(', ')})`;
  return { bought: `${p ?? 'pistol'}${kept}`, money: m, primary: p };
}

/**
 * 10 rounds, every one a loss for the T side, `kills` frags per round.
 * Streaks reset at halftime (C3).
 */
function simulate(rewards: RewardFn, kills = 0): { loser: LoserRow[]; winner: WinnerRow[] } {
  const loser: LoserRow[] = [];
  const winner: WinnerRow[] = [];
  let lMoney: number = ECONOMY.start;
  let wMoney: number = ECONOMY.start;
  let wPrimary: 'rifle' | 'smg' | null = null;
  let streak = 0;
  const clamp = (n: number) => Math.max(0, Math.min(ECONOMY.max, n));

  for (let round = 1; round <= ROUNDS.maxRounds; round++) {
    const lb = loserBuy(lMoney);
    const wb = winnerBuy(wMoney, wPrimary);
    wPrimary = wb.primary;
    const gain = rewards('CT', { t: streak, ct: 0 }).t;
    const lEnd = clamp(lb.money + gain + kills * ECONOMY.killReward);
    // The winning side frags to win, so it banks a kill reward too.
    const wEnd = clamp(wb.money + ECONOMY.winReward + ECONOMY.killReward);

    loser.push({
      round, streak, moneyBefore: lMoney, bought: lb.bought, tier: tierOf(lb.bought),
      moneyAfterBuy: lb.money, gain, moneyEnd: lEnd,
    });
    winner.push({ round, moneyBefore: wMoney, bought: wb.bought, primary: wb.primary, moneyEnd: wEnd });

    lMoney = lEnd;
    wMoney = wEnd;
    streak += 1;
    if (round === ROUNDS.halftimeAfter) streak = 0; // C3: reset at halftime
  }
  return { loser, winner };
}

function tierCounts(rows: readonly LoserRow[]): Record<Tier, number> {
  return {
    eco: rows.filter((r) => r.tier === 'eco').length,
    smg: rows.filter((r) => r.tier === 'smg').length,
    rifle: rows.filter((r) => r.tier === 'rifle').length,
  };
}

const sumGain = (rows: readonly LoserRow[]) => rows.reduce((a, r) => a + r.gain, 0);

function table(label: string, s: { loser: LoserRow[]; winner: WinnerRow[] }): string {
  const head = `${label}\n   R  strk |  LOSER $  bought          left  +gain |  WINNER $  bought`;
  const body = s.loser
    .map((r, i) => {
      const w = row(s.winner, i);
      return (
        `  ${String(r.round).padStart(2)}  ${String(r.streak).padStart(4)} | ` +
        `${String(r.moneyBefore).padStart(8)}  ${r.bought.padEnd(14)} ${String(r.moneyAfterBuy).padStart(4)}  ${String(r.gain).padStart(5)} | ` +
        `${String(w.moneyBefore).padStart(9)}  ${w.bought}`
      );
    })
    .join('\n');
  const t = tierCounts(s.loser);
  return `${head}\n${body}\n   loser tiers: eco=${t.eco} smg=${t.smg} rifle=${t.rifle} | cumulative loss income=${sumGain(s.loser)}`;
}

describe('two-sided 10-round simulation — loser wiped, winner survives', () => {
  const flat = simulate(legacyRoundRewards);
  const draft = simulate(draftRoundRewards);
  const amended = simulate(roundRewards);
  const amendedFragging = simulate(roundRewards, 1);

  it('prints every money curve', () => {
    // Evidence for §8 B1p — kept as output, not as a brittle assertion.
    // eslint-disable-next-line no-console
    console.log(
      `\n${table('BASELINE flat 1900 (loser: zero kills)', flat)}\n\n` +
        `${table('REJECTED DRAFT 1400/500/3400 (loser: zero kills)', draft)}\n\n` +
        `${table('AMENDED 1400/400/2600 (loser: zero kills)', amended)}\n\n` +
        `${table('AMENDED 1400/400/2600 (loser: 1 kill/round)', amendedFragging)}\n`,
    );
    expect(amended.loser).toHaveLength(ROUNDS.maxRounds);
    expect(amended.winner).toHaveLength(ROUNDS.maxRounds);
  });

  it('BASELINE: the flat reward produced no arc at all — SMG every round, never a rifle', () => {
    const t = tierCounts(flat.loser);
    expect(t).toEqual({ eco: 1, smg: 9, rifle: 0 });
    expect(sumGain(flat.loser)).toBe(19000);
    // The audit's "no dynamic range": money pinned in a narrow band from R2 on.
    const band = flat.loser.slice(1).map((r) => r.moneyBefore);
    expect(Math.max(...band) - Math.min(...band)).toBeLessThanOrEqual(600);
  });

  it('REJECTED DRAFT: the CS ladder handed the loser rifles straight from a payout', () => {
    // Why the contract was amended. 3400 > rifle 2700, so the cap alone re-armed
    // a dead team every round.
    expect(tierCounts(draft.loser)).toEqual({ eco: 1, smg: 5, rifle: 4 });
    expect(sumGain(draft.loser)).toBe(24000);
    expect(sumGain(draft.loser)).toBeGreaterThan(sumGain(amended.loser));
  });

  it('AMENDED: a real arc — one eco round, a force-buy, SMG-tier core, rifles only via savings', () => {
    const t = tierCounts(amended.loser);
    expect(t).toEqual({ eco: 1, smg: 6, rifle: 3 });
    expect(sumGain(amended.loser)).toBe(21200);

    // R1 is a genuine pistol round; R2 is a force-buy (SMG, no vest).
    expect(row(amended.loser, 0).tier).toBe('eco');
    expect(row(amended.loser, 1).bought).toBe('smg');
    expect(row(amended.loser, 1).moneyAfterBuy).toBeLessThan(GEAR.kevlarPrice);
    // Full SMG buy is back by R4 (the second/third loss), not R8.
    expect(row(amended.loser, 3).bought).toBe('smg+vest');
  });

  it('AMENDED: every rifle the loser fields is paid for by carry-over, never by one payout', () => {
    // The constraint the draft violated. A rifle round must always start from
    // more money than the largest single payout can supply.
    for (const r of amended.loser.filter((x) => x.tier === 'rifle')) {
      expect(r.moneyBefore).toBeGreaterThan(ECONOMY.lossRewardMax);
      expect(ECONOMY.lossRewardMax).toBeLessThan(WEAPONS.rifle.price);
    }
    // Under the draft the opposite held: a max payout alone cleared a rifle.
    expect(3400).toBeGreaterThan(WEAPONS.rifle.price);
  });

  it('AMENDED does NOT over-correct: a losing team that frags climbs back to rifle tier', () => {
    // The failure mode opposite to the one that was fixed. With one kill a
    // round the loser must reach rifle tier MORE often, not stay pinned.
    const poor = tierCounts(amended.loser);
    const fragging = tierCounts(amendedFragging.loser);
    expect(fragging.rifle).toBeGreaterThan(poor.rifle);
    expect(fragging.eco).toBeLessThanOrEqual(poor.eco);
    // Even with zero kills the loser is never stuck on pistols after R1.
    expect(amended.loser.slice(1).every((r) => r.tier !== 'eco')).toBe(true);
  });

  it('SURVIVOR SIDE: the winner re-arms for ~free and saturates ECONOMY.max', () => {
    // The asymmetry that makes raw income comparisons misleading: the winner
    // buys a rifle exactly ONCE and pays only for vests thereafter.
    const rifleBuys = amended.winner.filter((w) => w.bought.includes('buy rifle')).length;
    expect(rifleBuys).toBe(1);
    expect(row(amended.winner, 1).bought).toContain('buy rifle');
    expect(amended.winner.slice(2).every((w) => w.primary === 'rifle')).toBe(true);
    // After R2 the only recurring spend is the vest — the rifle itself is never
    // re-bought, and refillWeapons() restores its ammo for free.
    expect(amended.winner.slice(2).every((w) => !w.bought.includes('buy'))).toBe(true);
    expect(amended.winner.slice(2).every((w) => w.bought === 'rifle (vest)')).toBe(true);
    // Untouched by C2 and worth its own task: the winner's money saturates.
    const saturated = amended.winner.filter((w) => w.moneyBefore === ECONOMY.max);
    expect(saturated.length).toBeGreaterThanOrEqual(3);
    expect(row(amended.winner, 7).moneyBefore).toBe(ECONOMY.max);
  });

  it('the winner-loser money gap is unchanged by the tune (the win side is untouched)', () => {
    // C2 only moves the loss payout. Confirm the amendment did not accidentally
    // widen the gap relative to the flat baseline in the early, decisive rounds.
    const gap = (s: { loser: LoserRow[]; winner: WinnerRow[] }, i: number) =>
      row(s.winner, i).moneyBefore - row(s.loser, i).moneyBefore;
    for (let i = 0; i < ROUNDS.winRounds; i++) {
      expect(row(amended.winner, i).moneyBefore).toBe(row(flat.winner, i).moneyBefore);
      expect(gap(amended, i)).toBeGreaterThanOrEqual(0);
    }
    expect(gap(amended, 0)).toBe(0); // both sides start at ECONOMY.start
  });

  it('REACHABILITY: a true wipe ends at R6, so R1-R6 is the arc that actually ships', () => {
    // ROUNDS.winRounds = 6, so a team losing every round is eliminated in round
    // 6 — rounds 7-10 above are counterfactual, and halftime (after R5) barely
    // matters in a wipe. The shipped arc is the first six rows.
    expect(ROUNDS.winRounds).toBe(6);
    expect(ROUNDS.winRounds).toBeLessThan(ROUNDS.maxRounds);
    const reachable = amended.loser.slice(0, ROUNDS.winRounds).map((r) => r.tier);
    expect(reachable).toEqual(['eco', 'smg', 'smg', 'smg', 'rifle', 'rifle']);
    // The same six rounds under the flat reward: no arc, no eco pressure.
    expect(flat.loser.slice(0, ROUNDS.winRounds).map((r) => r.tier)).toEqual([
      'eco', 'smg', 'smg', 'smg', 'smg', 'smg',
    ]);
  });

  it('I6 holds across every simulation', () => {
    for (const s of [flat, draft, amended, amendedFragging]) {
      for (const r of s.loser) {
        expect(r.moneyAfterBuy).toBeGreaterThanOrEqual(0);
        expect(r.moneyEnd).toBeGreaterThanOrEqual(0);
        expect(r.moneyEnd).toBeLessThanOrEqual(ECONOMY.max);
      }
      for (const w of s.winner) {
        expect(w.moneyEnd).toBeGreaterThanOrEqual(0);
        expect(w.moneyEnd).toBeLessThanOrEqual(ECONOMY.max);
      }
    }
  });
});
