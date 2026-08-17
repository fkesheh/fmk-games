// The anti-float law (judge round 1): every part hangs off the trunk chain.
// A part whose centre is far from every anchor segment (trunk joints + branch
// tips) is an orphaned mesh — the floating-shard bug class. Threshold allows
// canopy clumps centred slightly past tips but catches detached debris.
import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { ASSETS } from './registry';

function distToAnchors(p: Vector3, anchors: readonly Vector3[]): number {
  let best = Infinity;
  for (const a of anchors) best = Math.min(best, p.distanceTo(a));
  return best;
}

describe('attachment (anti-float)', () => {
  for (const asset of ASSETS) {
    for (const v of asset.meta.variations) {
      it(`${asset.meta.id}/${v.id}: geometry stays on the anchor spine`, () => {
        const built = asset.buildVariation(v.id, 'hero');
        expect(built.anchors.length).toBeGreaterThan(1);
        // the merged mesh's vertex clusters must not stray from the spine:
        // sample every Nth vertex, allow generous canopy offset (clumps sit
        // just past branch tips), fail on anything truly detached.
        const pos = built.mesh.geometry.getAttribute('position');
        const stride = Math.max(1, Math.floor(pos.count / 400));
        let strays = 0;
        for (let i = 0; i < pos.count; i += stride) {
          const p = new Vector3(pos.getX(i), pos.getY(i), pos.getZ(i));
          if (distToAnchors(p, built.anchors) > 2.6) strays++;
        }
        expect(strays, `${asset.meta.id}/${v.id}: ${strays} detached vertices`).toBe(0);
      });
    }
  }
});
