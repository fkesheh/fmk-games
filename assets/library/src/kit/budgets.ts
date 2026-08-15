// ============================================================================
// FROZEN — pure data. Triangle budgets and height ranges per species. Enforced
// by budgets.test.ts for every species x variation x quality. Numbers are the
// LAW: if a species can't hit its budget, the species code is wrong, not this.
// ============================================================================
import type { Quality } from '../types';

export interface SpeciesBudget {
  readonly hero: number;
  readonly lod: number;
  readonly micro: number;
  readonly height: readonly [number, number]; // metres, min..max across variations
}

export type BudgetTable = Readonly<Record<string, SpeciesBudget>>;

export const BUDGETS: BudgetTable = {
  oak: { hero: 6500, lod: 1200, micro: 260, height: [8, 12] },
  birch: { hero: 5000, lod: 1100, micro: 240, height: [10, 14] },
  pine: { hero: 5500, lod: 1200, micro: 240, height: [12, 16] },
  snag: { hero: 3000, lod: 900, micro: 200, height: [7, 10] },
  palm: { hero: 4500, lod: 1000, micro: 220, height: [9, 13] },
};

export const QUALITIES: readonly Quality[] = ['hero', 'lod', 'micro'];
