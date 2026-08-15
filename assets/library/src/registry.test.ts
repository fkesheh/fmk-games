// Registry invariants: unique ids, >= 3 variations per species, seeds stable,
// every species registered in BUDGETS (budgets.ts and meta must agree).
import { describe, expect, it } from 'vitest';
import { ASSETS } from './registry';
import { BUDGETS } from './kit/budgets';

describe('asset registry', () => {
  it('has unique ids', () => {
    const ids = ASSETS.map((a) => a.meta.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every species has >= 3 variations with unique ids and uint32 seeds', () => {
    for (const a of ASSETS) {
      expect(a.meta.variations.length).toBeGreaterThanOrEqual(3);
      const vids = a.meta.variations.map((v) => v.id);
      expect(new Set(vids).size).toBe(vids.length);
      for (const v of a.meta.variations) {
        expect(Number.isInteger(v.seed)).toBe(true);
        expect(v.seed).toBeGreaterThanOrEqual(0);
        expect(v.seed).toBeLessThanOrEqual(0xffffffff);
      }
    }
  });

  it('meta mirrors the frozen budget table', () => {
    for (const a of ASSETS) {
      const b = BUDGETS[a.meta.id];
      expect(b, `budgets.ts is missing '${a.meta.id}'`).toBeDefined();
      expect(a.meta.triBudget).toEqual(b);
      expect(a.meta.heightRange).toEqual(b?.height);
    }
  });

  it('every budget table entry is registered', () => {
    const ids = new Set(ASSETS.map((a) => a.meta.id));
    for (const id of Object.keys(BUDGETS)) expect(ids.has(id)).toBe(true);
  });
});
