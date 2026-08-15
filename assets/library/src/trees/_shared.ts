// ============================================================================
// Species scaffold — shared body wiring so every trees/*.ts is pure art.
// (Infrastructure for the trees/ workstream; not part of the frozen kit.)
// ============================================================================
import * as THREE from 'three';
import { finalize, triCountOf, type Part } from '../kit/geometry';
import { rng } from '../kit/rng';
import { BUDGETS } from '../kit/budgets';
import type { AssetMeta, AssetModule, BuiltAsset, Quality } from '../types';

/** Non-undefined budget lookup — a species missing from budgets.ts fails loudly. */
export function budgetFor(id: string) {
  const b = BUDGETS[id];
  if (!b) throw new Error(`budgets.ts is missing '${id}'`);
  return b;
}

export type SpeciesBuilder = (
  next: () => number,
  quality: Quality,
  variationId: string,
) => Part[];

export function makeSpecies(meta: AssetMeta, buildParts: SpeciesBuilder): AssetModule {
  function buildSeed(variationId: string, seed: number, quality: Quality): BuiltAsset {
    const parts = buildParts(rng(seed), quality, variationId);
    const { geom, mesh } = finalize(parts);
    geom.computeBoundingBox();
    const root = new THREE.Group();
    root.add(mesh);
    return { root, mesh, tris: triCountOf(geom), bbox: geom.boundingBox ?? new THREE.Box3() };
  }
  return {
    meta,
    build: (quality) => {
      const v0 = meta.variations[0];
      if (!v0) throw new Error(`${meta.id}: no variations`);
      return buildSeed(v0.id, v0.seed, quality);
    },
    buildVariation: (variationId, quality) => {
      const v = meta.variations.find((x) => x.id === variationId);
      if (!v) throw new Error(`${meta.id}: unknown variation '${variationId}'`);
      return buildSeed(v.id, v.seed, quality);
    },
  };
}

/** Place blobs with minimum separation so canopies keep readable gaps. */
export function scatter(
  next: () => number,
  count: number,
  centre: THREE.Vector3,
  spread: { x: number; yMin: number; yMax: number; z: number },
  minGapFactor: number,
  radii: readonly number[],
): THREE.Vector3[] {
  const placed: { p: THREE.Vector3; r: number }[] = [];
  let guard = 0;
  while (placed.length < count && guard++ < count * 24) {
    const r = radii[placed.length % radii.length] ?? 1;
    const p = new THREE.Vector3(
      centre.x + (next() - 0.5) * 2 * spread.x,
      centre.y + spread.yMin + next() * (spread.yMax - spread.yMin),
      centre.z + (next() - 0.5) * 2 * spread.z,
    );
    const ok = placed.every((q) => q.p.distanceTo(p) > (q.r + r) * minGapFactor);
    if (ok) placed.push({ p, r });
  }
  return placed.map((q) => q.p);
}
