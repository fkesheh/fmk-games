// ============================================================================
// waves.ts tests — locks the DESIGN_BIBLE targets down numerically rather
// than trusting a constant read back: wave 1 solo == 8 zombies, unlock walls
// (no runner before wave 3, no brute before 6, no spitter before 8), the HP
// cap, composition length, and rand-stream determinism.
// ============================================================================
import { describe, expect, it } from 'vitest';
import { WAVES, ZOMBIE_BASE, ECONOMY } from '@outpost/shared';
import type { ZombieKind } from '@outpost/shared';
import { waveComposition, waveSize, zombieStats } from './waves.js';

const ALL_KINDS: readonly ZombieKind[] = ['shambler', 'runner', 'brute', 'spitter'];

/**
 * Deterministic sweep across [0, 1): rand() returns 0/n, 1/n, ..., (n-1)/n,
 * then repeats. Given a large `n` this exercises every weighted bucket
 * exactly rather than hoping a probabilistic draw happens to cover them —
 * an "unlock wall" assertion built on this is airtight, not lucky.
 */
function sweepRand(n: number): () => number {
  let i = 0;
  return () => (i++ % n) / n;
}

/** Simple seeded PRNG (mulberry32) — deterministic, not Math.random. */
function seededRand(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('waveSize', () => {
  it('wave 1 solo is exactly 8 zombies (DESIGN_BIBLE target)', () => {
    expect(waveSize(1, 1)).toBe(8);
  });

  it('matches the frozen formula: round(baseCount * growth^(wave-1) * (playerBase + playerStep*players))', () => {
    for (const wave of [1, 2, 5, 10, 20]) {
      for (const players of [1, 2, 4, 8, 16]) {
        const expected = Math.round(
          WAVES.baseCount * Math.pow(WAVES.growth, wave - 1) * (WAVES.playerBase + WAVES.playerStep * players),
        );
        expect(waveSize(wave, players)).toBe(expected);
      }
    }
  });

  it('grows with wave and with player count', () => {
    expect(waveSize(5, 1)).toBeGreaterThan(waveSize(1, 1));
    expect(waveSize(1, 4)).toBeGreaterThan(waveSize(1, 1));
  });
});

describe('waveComposition — unlock walls', () => {
  it('wave 1 is 100% shambler', () => {
    const roster = waveComposition(1, 1000, sweepRand(1000));
    expect(roster.every((k) => k === 'shambler')).toBe(true);
  });

  it('wave 2 is still 100% shambler (runner unlocks at 3)', () => {
    const roster = waveComposition(2, 1000, sweepRand(1000));
    expect(roster.every((k) => k === 'shambler')).toBe(true);
  });

  it('no runner before its unlock wave', () => {
    for (let wave = 1; wave < WAVES.unlock.runner; wave++) {
      const roster = waveComposition(wave, 1000, sweepRand(1000));
      expect(roster).not.toContain('runner');
    }
  });

  it('no brute before its unlock wave', () => {
    for (let wave = 1; wave < WAVES.unlock.brute; wave++) {
      const roster = waveComposition(wave, 1000, sweepRand(1000));
      expect(roster).not.toContain('brute');
    }
  });

  it('no spitter before its unlock wave', () => {
    for (let wave = 1; wave < WAVES.unlock.spitter; wave++) {
      const roster = waveComposition(wave, 1000, sweepRand(1000));
      expect(roster).not.toContain('spitter');
    }
  });

  it('a kind appears once its unlock wave is reached, when weighted range is swept', () => {
    for (const kind of ALL_KINDS) {
      const wave = WAVES.unlock[kind];
      const roster = waveComposition(wave, 1000, sweepRand(1000));
      expect(roster).toContain(kind);
    }
  });

  it('never emits a kind absent from ZombieKind at any wave', () => {
    for (const wave of [1, 3, 6, 8, 15, 50]) {
      const roster = waveComposition(wave, 500, sweepRand(500));
      for (const k of roster) expect(ALL_KINDS).toContain(k);
    }
  });
});

describe('waveComposition — weighting', () => {
  it('weights the roster by WAVES.weight among unlocked kinds (deterministic sweep)', () => {
    // At wave 8+ every kind is unlocked, so a full [0,1) sweep should land
    // each kind's share close to weight / totalWeight.
    const wave = WAVES.unlock.spitter;
    const n = 10_000;
    const roster = waveComposition(wave, n, sweepRand(n));
    const totalWeight = ALL_KINDS.reduce((s, k) => s + WAVES.weight[k], 0);
    for (const kind of ALL_KINDS) {
      const expectedShare = WAVES.weight[kind] / totalWeight;
      const actualShare = roster.filter((k) => k === kind).length / n;
      expect(actualShare).toBeGreaterThan(expectedShare - 0.02);
      expect(actualShare).toBeLessThan(expectedShare + 0.02);
    }
  });
});

describe('waveComposition — invariants', () => {
  it('returned array length always equals count', () => {
    for (const wave of [1, 2, 3, 6, 8, 20, 50]) {
      for (const count of [0, 1, 8, 47, 200]) {
        const roster = waveComposition(wave, count, seededRand(wave * 1000 + count));
        expect(roster.length).toBe(count);
      }
    }
  });

  it('is deterministic: the same rand seed produces the same roster', () => {
    const a = waveComposition(10, 300, seededRand(42));
    const b = waveComposition(10, 300, seededRand(42));
    expect(a).toEqual(b);
  });

  it('different seeds are free to diverge (sanity: not a constant roster)', () => {
    const a = waveComposition(10, 300, seededRand(1));
    const b = waveComposition(10, 300, seededRand(2));
    expect(a).not.toEqual(b);
  });
});

describe('zombieStats', () => {
  it('hp scales by wave only: wave 1 hp equals base hp for every kind', () => {
    for (const kind of ALL_KINDS) {
      expect(zombieStats(kind, 1).hp).toBeCloseTo(ZOMBIE_BASE[kind].hp, 6);
    }
  });

  it('hp follows 1 + hpGrowth*(wave-1) below the cap', () => {
    const wave = 5;
    for (const kind of ALL_KINDS) {
      const expected = ZOMBIE_BASE[kind].hp * (1 + WAVES.hpGrowth * (wave - 1));
      expect(zombieStats(kind, wave).hp).toBeCloseTo(expected, 6);
    }
  });

  it('hp is capped at WAVES.hpCapMul at wave 50', () => {
    for (const kind of ALL_KINDS) {
      const uncapped = 1 + WAVES.hpGrowth * (50 - 1);
      expect(uncapped).toBeGreaterThan(WAVES.hpCapMul); // sanity: the cap actually bites at wave 50
      expect(zombieStats(kind, 50).hp).toBeCloseTo(ZOMBIE_BASE[kind].hp * WAVES.hpCapMul, 6);
    }
  });

  it('hp never exceeds the cap even far past wave 50', () => {
    for (const kind of ALL_KINDS) {
      expect(zombieStats(kind, 500).hp).toBeCloseTo(ZOMBIE_BASE[kind].hp * WAVES.hpCapMul, 6);
    }
  });

  it('never scales by headcount — signature carries no player count, and repeated calls agree', () => {
    for (const kind of ALL_KINDS) {
      expect(zombieStats(kind, 7)).toEqual(zombieStats(kind, 7));
    }
  });

  it('speed/height/radius/melee/fenceDps are the base values, unscaled', () => {
    for (const kind of ALL_KINDS) {
      const s = zombieStats(kind, 12);
      const base = ZOMBIE_BASE[kind];
      expect(s.speed).toBe(base.speed);
      expect(s.height).toBe(base.height);
      expect(s.radius).toBe(base.radius);
      expect(s.meleeDmg).toBe(base.meleeDmg);
      expect(s.meleeReach).toBe(base.meleeReach);
      expect(s.meleeInterval).toBe(base.meleeInterval);
      expect(s.fenceDps).toBe(base.fenceDps);
    }
  });

  it('scrap reward is read from ECONOMY.killScrap, at every wave', () => {
    for (const kind of ALL_KINDS) {
      expect(zombieStats(kind, 1).scrap).toBe(ECONOMY.killScrap[kind]);
      expect(zombieStats(kind, 30).scrap).toBe(ECONOMY.killScrap[kind]);
    }
  });
});
