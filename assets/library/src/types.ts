// ============================================================================
// FROZEN CONTRACT — cross-module types for the asset library. Types only, no
// logic. See assets/ASSET_CONTRACT.md. Implementers may never alter this file.
// ============================================================================
import type * as THREE from 'three';

export type AssetCategory = 'tree'; // grows: 'rock' | 'prop' | …
export type Quality = 'hero' | 'lod' | 'micro';
export type MotionKind = 'wind' | 'none';

export interface AssetVariation {
  readonly id: string; // 'autumn' — URL-safe
  readonly label: string; // 'Autumn Oak'
  readonly seed: number; // uint32 — feeds rng()
  readonly notes: string; // what makes this variation distinct
}

export interface AssetMeta {
  readonly id: string; // 'oak' — URL-safe
  readonly category: AssetCategory;
  readonly name: string; // 'Oak'
  readonly description: string; // one sentence, storytelling
  readonly variations: readonly AssetVariation[]; // >= 3
  readonly motion: MotionKind;
  readonly triBudget: Readonly<Record<Quality, number>>; // mirrors kit/budgets.ts
  readonly heightRange: readonly [number, number]; // metres, mirrors kit/budgets.ts
}

export interface BuiltAsset {
  readonly root: THREE.Object3D; // origin ground-centre, +Y up, ONE merged mesh
  readonly tris: number; // exact, from kit/geometry.ts counter
  readonly bbox: THREE.Box3; // world-space after build
  readonly mesh: THREE.Mesh; // uses ASSET_MATERIAL
}

export interface AssetModule {
  readonly meta: AssetMeta;
  build(quality: Quality): BuiltAsset; // variation 0
  buildVariation(variationId: string, quality: Quality): BuiltAsset;
}
