// The lightweight law, mechanically enforced: every species x variation x
// quality is within its triangle budget and height range, and builds
// deterministically (same seed -> identical geometry).
import { describe, expect, it } from 'vitest';
import { ASSETS } from './registry';
import { QUALITIES } from './kit/budgets';
import type { Quality } from './types';

describe('budgets & determinism', () => {
  for (const asset of ASSETS) {
    describe(asset.meta.id, () => {
      for (const v of asset.meta.variations) {
        for (const quality of QUALITIES) {
          it(`${v.id}/${quality} within budget, height range, deterministic`, () => {
            const a = asset.buildVariation(v.id, quality as Quality);
            expect(a.tris).toBeLessThanOrEqual(asset.meta.triBudget[quality as Quality]);
            const h = a.bbox.max.y;
            const [hMin, hMax] = asset.meta.heightRange;
            expect(h).toBeGreaterThanOrEqual(hMin * 0.9); // 10% sculpting tolerance
            expect(h).toBeLessThanOrEqual(hMax * 1.1);
            expect(a.bbox.min.y).toBeGreaterThanOrEqual(-0.05); // grounded at origin
            expect(a.root.children.length).toBe(1); // ONE mesh

            const b = asset.buildVariation(v.id, quality as Quality);
            expect(b.tris).toBe(a.tris);
            const pa = a.mesh.geometry.attributes.position!.array as Float32Array;
            const pb = b.mesh.geometry.attributes.position!.array as Float32Array;
            expect(pb.length).toBe(pa.length);
            // hash the first 300 verts — deterministic build check
            let ha = 0, hb = 0;
            const n = Math.min(300, pa.length);
            for (let i = 0; i < n; i++) {
              ha = (ha * 31 + Math.round(pa[i]! * 1000)) | 0;
              hb = (hb * 31 + Math.round(pb[i]! * 1000)) | 0;
            }
            expect(hb).toBe(ha);
          });
        }
      }
    });
  }
});
