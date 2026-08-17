// The degenerate-mesh gate (judge round 3, non-negotiable): no triangle in
// any shipped asset may have an edge below the world-space threshold —
// sub-cm faces render as 1px black hairlines and read as a broken mesh.
import { describe, expect, it } from 'vitest';
import { ASSETS } from './registry';

const MIN_EDGE = 0.014; // 1.4 cm — below this, faces alias to hairlines

describe('degenerate mesh gate', () => {
  for (const asset of ASSETS) {
    for (const v of asset.meta.variations) {
      it(`${asset.meta.id}/${v.id}: no edge below ${MIN_EDGE * 100}cm (hero)`, () => {
        const built = asset.buildVariation(v.id, 'hero');
        const pos = built.mesh.geometry.getAttribute('position');
        const triCount = pos.count / 3;
        let worst = Infinity;
        for (let f = 0; f < triCount; f++) {
          const i0 = f * 3;
          const ax = pos.getX(i0)!, ay = pos.getY(i0)!, az = pos.getZ(i0)!;
          const bx = pos.getX(i0 + 1)!, by = pos.getY(i0 + 1)!, bz = pos.getZ(i0 + 1)!;
          const cx = pos.getX(i0 + 2)!, cy = pos.getY(i0 + 2)!, cz = pos.getZ(i0 + 2)!;
          const e1 = Math.hypot(ax - bx, ay - by, az - bz);
          const e2 = Math.hypot(bx - cx, by - cy, bz - cz);
          const e3 = Math.hypot(cx - ax, cy - ay, cz - az);
          worst = Math.min(worst, e1, e2, e3);
        }
        expect(worst, `${asset.meta.id}/${v.id}: min edge ${worst.toFixed(4)} < ${MIN_EDGE}`).toBeGreaterThanOrEqual(MIN_EDGE);
      });
    }
  }
});
