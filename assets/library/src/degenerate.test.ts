// The degenerate-mesh gate (judge round 3, non-negotiable): no triangle in
// any shipped asset may be thinner than the world-space threshold — such
// faces render as 1px black hairlines and read as a broken mesh.
//
// The metric is triangle ALTITUDE (2*area / longest edge), i.e. how WIDE the
// sliver is, NOT edge length. An earlier version of this gate measured the
// shortest edge and was vacuous against the very defect it is named after:
// three nearly-collinear points at 0, 0.5 and 1.0 along a line have edges
// 0.5/0.5/1.0 — every one of them comfortably above any edge threshold —
// while enclosing zero area and rasterising to exactly the black hairline the
// judge rejected. Area is what aliases; length is not.
import { describe, expect, it } from 'vitest';
import { ASSETS } from './registry';

const MIN_THICKNESS = 0.014; // 1.4 cm of WIDTH — below this, faces alias to hairlines

describe('degenerate mesh gate', () => {
  for (const asset of ASSETS) {
    for (const v of asset.meta.variations) {
      it(`${asset.meta.id}/${v.id}: no face thinner than ${MIN_THICKNESS * 100}cm (hero)`, () => {
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
          const longest = Math.max(e1, e2, e3);
          if (longest === 0) {
            worst = 0; // a point: fully collapsed
            continue;
          }
          // |AB x AC| / 2 is the area; twice it over the longest edge is the
          // altitude to that edge — the sliver's width, in world units.
          const ux = bx - ax, uy = by - ay, uz = bz - az;
          const vx = cx - ax, vy = cy - ay, vz = cz - az;
          const cxp = uy * vz - uz * vy;
          const cyp = uz * vx - ux * vz;
          const czp = ux * vy - uy * vx;
          worst = Math.min(worst, Math.hypot(cxp, cyp, czp) / longest);
        }
        expect(
          worst,
          `${asset.meta.id}/${v.id}: thinnest face ${worst.toFixed(5)} < ${MIN_THICKNESS}`,
        ).toBeGreaterThanOrEqual(MIN_THICKNESS);
      });
    }
  }
});
