// ============================================================================
// OAK — heroic broadleaf. Model sheet (ASSET_CONTRACT): squat tapered trunk,
// 3–5 gnarled boughs at 35–55°, canopy of 6–9 large blob masses in three
// tiers with gaps between them. Story details: hollow knot, broken bough.
// ============================================================================
import { Vector3 } from 'three';
import { blob, mat, nub, taperCylinder, type Next, type Part } from '../kit/geometry';
import { TREE_PALETTE as P } from '../kit/palette';
import { BUDGETS } from '../kit/budgets';
import type { AssetMeta, AssetModule, Quality } from '../types';
import { makeSpecies, scatter } from './_shared';

export const OAK_META: AssetMeta = {
  id: 'oak',
  category: 'tree',
  name: 'Oak',
  description:
    'A veteran broadleaf — squat, confident, canopy massed in big readable clumps with sky between them.',
  variations: [
    { id: 'veteran', label: 'Veteran', seed: 0x0a11ce11, notes: 'hollow knot + one broken bough' },
    { id: 'autumn', label: 'Autumn', seed: 0xa67b6a17, notes: '40% of canopy shifts to autumn tiers' },
    { id: 'young', label: 'Young', seed: 0x0b0d1e55, notes: 'slimmer trunk, 5 blobs, brighter tiers' },
  ],
  motion: 'wind',
  triBudget: BUDGETS.oak,
  heightRange: BUDGETS.oak.height,
};

const TIER = { lit: P.leafLit, base: P.leaf, dark: P.leafDark, deep: P.leafDeep };
const AUTUMN = { lit: P.autumnLit, base: P.autumn, dark: P.autumnDark };

function oakParts(next: Next, quality: Quality, variationId: string): Part[] {
  const isAutumn = variationId === 'autumn';
  const isYoung = variationId === 'young';
  const parts: Part[] = [];

  // ---- proportions (metres) ----
  const trunkH = (isYoung ? 3.9 : 4.6) + next() * (isYoung ? 0.5 : 0.9);
