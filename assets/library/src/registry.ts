// ============================================================================
// FROZEN SHAPE, ADDITIVE CONTENT — the asset registry. New species are ADDED
// here; existing entries are never renamed or removed (URLs depend on ids).
// ============================================================================
import type { AssetModule } from './types';
import { oak } from './trees/oak';
import { birch } from './trees/birch';
import { pine } from './trees/pine';
import { snag } from './trees/snag';
import { palm } from './trees/palm';

export const ASSETS: readonly AssetModule[] = [oak, birch, pine, snag, palm];

export function assetById(id: string): AssetModule | undefined {
  return ASSETS.find((a) => a.meta.id === id);
}
