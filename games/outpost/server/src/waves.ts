// ============================================================================
// srv-waves — pure wave scheduling.
//
// Everything here reads its numbers from WAVES / ZOMBIE_BASE / ECONOMY
// (@outpost/shared/config). No system in this file invents a balance
// constant — see CONTRACT.md "server/src/waves.ts" and DESIGN_BIBLE.md's
// wave-composition intent.
// ============================================================================

import type { WaveCompositionFn, WaveSizeFn, ZombieKind, ZombieStatsFn } from '@outpost/shared';
import { ECONOMY, WAVES, ZOMBIE_BASE } from '@outpost/shared';

/**
 * Fixed enumeration order for composition sweeps. Not balance data (no
 * numbers live here) — just the order `waveComposition` walks the weighted
 * buckets in, kept stable so the same `rand()` stream always yields the same
 * roster (determinism).
 */
const KIND_ORDER: readonly ZombieKind[] = ['shambler', 'runner', 'brute', 'spitter'];

/**
 * Total zombies in `wave` for `players` seated survivors.
 *
 * count = round(baseCount * growth^(wave-1) * (playerBase + playerStep * players))
 * — exactly the formula frozen in config.ts's WAVES comment.
 */
export const waveSize: WaveSizeFn = (wave, players) => {
  const growthMul = Math.pow(WAVES.growth, wave - 1);
  const playerMul = WAVES.playerBase + WAVES.playerStep * players;
  return Math.round(WAVES.baseCount * growthMul * playerMul);
};

/**
 * Weighted-pick one kind from the currently-unlocked set. `unlocked` and
 * `totalWeight` are precomputed by the caller (once per `waveComposition`
 * call, not once per zombie) so this hot little loop never recomputes them.
 */
function pickKind(unlocked: readonly ZombieKind[], totalWeight: number, rand: () => number): ZombieKind {
  if (totalWeight <= 0 || unlocked.length === 0) return 'shambler';
  let roll = rand() * totalWeight;
  for (const kind of unlocked) {
    const w = WAVES.weight[kind];
    if (roll < w) return kind;
    roll -= w;
  }
  // Floating-point edge: roll landed exactly on (or past, by epsilon) the
  // summed weight. Fall back to the last unlocked kind rather than the
  // always-unlocked 'shambler', so the weighting isn't silently skewed.
  const last = unlocked[unlocked.length - 1];
  return last ?? 'shambler';
}

/**
 * The kind roster for one wave: length exactly `count`, respecting
 * `WAVES.unlock` (a kind not yet unlocked NEVER appears) and weighted by
 * `WAVES.weight` among whatever IS unlocked. At wave 1 only 'shambler' is
 * unlocked, so every entry is 'shambler'.
 */
export const waveComposition: WaveCompositionFn = (wave, count, rand) => {
  const unlocked = KIND_ORDER.filter((kind) => wave >= WAVES.unlock[kind]);
  let totalWeight = 0;
  for (const kind of unlocked) totalWeight += WAVES.weight[kind];

  const out: ZombieKind[] = [];
  for (let i = 0; i < count; i++) {
    out.push(pickKind(unlocked, totalWeight, rand));
  }
  return out;
};

/**
 * Per-kind stats scaled for `wave`. HP scales with wave only (never
 * headcount — the signature carries no player count), capped at
 * `WAVES.hpCapMul`. Every other field is base tuning, verbatim, plus the
 * kill reward read from `ECONOMY.killScrap`.
 */
export const zombieStats: ZombieStatsFn = (kind, wave) => {
  const base = ZOMBIE_BASE[kind];
  const hpMul = Math.min(1 + WAVES.hpGrowth * (wave - 1), WAVES.hpCapMul);
  return {
    hp: base.hp * hpMul,
    speed: base.speed,
    height: base.height,
    radius: base.radius,
    meleeDmg: base.meleeDmg,
    meleeReach: base.meleeReach,
    meleeInterval: base.meleeInterval,
    fenceDps: base.fenceDps,
    scrap: ECONOMY.killScrap[kind],
  };
};
