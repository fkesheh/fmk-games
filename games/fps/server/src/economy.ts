// ============================================================================
// S3 — buy menu + round economy. PURE: no I/O, no Date.now, no timers.
// Used by game.ts (S2) for handleBuy / kill rewards / round-end payouts.
// ============================================================================
import { ECONOMY, GEAR, WEAPONS, type GearId, type Team, type WeaponId } from '@fps/shared';

export type BuyResult =
  | { ok: true; money: number; owned: WeaponId[] }
  | { ok: false; reason: string };

export type BuyGearResult =
  | { ok: true; money: number; armor: number; hasKevlar: boolean; helmet: boolean }
  | { ok: false; reason: string };

/** Buyable primary slots — everything with a price. knife+pistol (price 0) are issued. */
const PRIMARIES: readonly WeaponId[] = ['smg', 'shotgun', 'rifle', 'sniper'];

function isPrimary(w: WeaponId): boolean {
  return (PRIMARIES as readonly string[]).includes(w);
}

/**
 * Attempt a purchase. Checks run in this exact order (reason strings frozen):
 *   1. !canBuy           -> 'buy time expired'
 *   2. price 0 (issued)  -> 'not for sale'        (knife+pistol are never buyable)
 *   3. already in owned  -> 'already owned'
 *   4. money < price     -> 'insufficient funds'
 * On success the bought primary REPLACES the currently owned primary (no
 * refund); knife+pistol entries are preserved. Does not clamp money — a
 * successful buy always leaves money >= 0 by check 4.
 */
export function tryBuy(money: number, owned: WeaponId[], want: WeaponId, canBuy: boolean): BuyResult {
  if (!canBuy) return { ok: false, reason: 'buy time expired' };
  const def = WEAPONS[want];
  if (def.price <= 0) return { ok: false, reason: 'not for sale' };
  if (owned.includes(want)) return { ok: false, reason: 'already owned' };
  if (money < def.price) return { ok: false, reason: 'insufficient funds' };
  // Drop the old primary (at most one is ever owned), keep issued weapons.
  return { ok: true, money: money - def.price, owned: [...owned.filter((w) => !isPrimary(w)), want] };
}

/**
 * Attempt a gear purchase (CS kevlar vest / helmet). Checks run in this exact
 * order (reason strings frozen):
 *   1. !canBuy                          -> 'buy time expired'
 *   kevlar (no 'already owned' — a rebuy REFILLS armor for the full price):
 *   2. money < GEAR.kevlarPrice         -> 'insufficient funds'
 *      else armor = GEAR.armorStart, hasKevlar = true
 *   helmet:
 *   2. !hasKevlar                       -> 'requires kevlar'
 *   3. helmet already owned             -> 'already owned'
 *   4. money < GEAR.helmetPrice         -> 'insufficient funds'
 *      else helmet = true
 * Does not clamp money — a successful buy always leaves money >= 0 by the
 * funds check. Round start does not refill armor (handled by the caller).
 * Note: current armor is not an input, so `armor` is only AUTHORITATIVE on
 * kevlar buys; on helmet buys it is reported as GEAR.armorStart (the level
 * the required vest granted — buying vest+helmet together keeps armor at
 * 100). A caller tracking mid-round armor damage must not apply `armor`
 * from helmet results.
 */
export function tryBuyGear(
  money: number,
  hasKevlar: boolean,
  helmet: boolean,
  item: GearId,
  canBuy: boolean,
): BuyGearResult {
  if (!canBuy) return { ok: false, reason: 'buy time expired' };
  if (item === 'kevlar') {
    if (money < GEAR.kevlarPrice) return { ok: false, reason: 'insufficient funds' };
    return { ok: true, money: money - GEAR.kevlarPrice, armor: GEAR.armorStart, hasKevlar: true, helmet };
  }
  if (!hasKevlar) return { ok: false, reason: 'requires kevlar' };
  if (helmet) return { ok: false, reason: 'already owned' };
  if (money < GEAR.helmetPrice) return { ok: false, reason: 'insufficient funds' };
  return { ok: true, money: money - GEAR.helmetPrice, armor: GEAR.armorStart, hasKevlar, helmet: true };
}

/** Money after a kill: +ECONOMY.killReward, clamped to ECONOMY.max. */
export function killReward(money: number): number {
  return Math.min(money + ECONOMY.killReward, ECONOMY.max);
}

/**
 * Normalise a loss-streak input to a whole, non-negative round count.
 * Negative, fractional and non-finite values clamp to `max(0, floor(x))`
 * (NaN/Infinity are treated as 0 rather than propagating into the payout).
 */
function normalizeStreak(streak: number): number {
  if (!Number.isFinite(streak)) return 0;
  return Math.max(0, Math.floor(streak));
}

/**
 * Payout for a team that LOSES a round, given the consecutive rounds it had
 * already lost before this one:
 *   min(lossRewardBase + lossRewardStep * streak, lossRewardMax)
 * Ladder: 0->1400, 1->1800, 2->2200, 3->2600, 4+->2600. Monotone in `streak`
 * (I5: a longer streak never pays less). The cap is deliberately BELOW the
 * rifle price: a loss payout alone never buys a rifle.
 */
function lossPayout(streak: number): number {
  return Math.min(
    ECONOMY.lossRewardBase + ECONOMY.lossRewardStep * normalizeStreak(streak),
    ECONOMY.lossRewardMax,
  );
}

/**
 * Per-team money GAINS after a round.
 * `lossStreak` = consecutive rounds each team has ALREADY lost, BEFORE this
 * round's result is applied. A winner's entry is ignored.
 * Loss payout = min(base + step * streak, max) — see `lossPayout`.
 * `winner === null` (mutual elimination / draw) pays BOTH teams their own
 * streak-based loss reward.
 * These are deltas — the CALLER adds them and clamps to [0, ECONOMY.max].
 */
export function roundRewards(
  winner: Team | null,
  lossStreak: { t: number; ct: number },
): { t: number; ct: number } {
  return {
    t: winner === 'T' ? ECONOMY.winReward : lossPayout(lossStreak.t),
    ct: winner === 'CT' ? ECONOMY.winReward : lossPayout(lossStreak.ct),
  };
}
