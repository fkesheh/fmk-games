// ============================================================================
// PINE — layered conifer. Model sheet: welded trunk, skirts as LOBED jittered
// lofts (never a raw cone), drooping-tip blades clustered in tufts (tips point
// DOWN), cold blue-green tiers, snow as up-facing surface repaint.
// ============================================================================
import { BufferGeometry, Float32BufferAttribute, Vector3 } from 'three';
import {
  blade, loft, mat, paint, paintTrunkTiers, paintUpFaces, type Next, type Part,
} from '../kit/geometry';
import { TREE_PALETTE as P } from '../kit/palette';
import type { AssetMeta, AssetModule, Quality } from '../types';
import { budgetFor, growChain, makeSpecies, type SpeciesResult } from './_shared';

export const PINE_META: AssetMeta = {
  id: 'pine',
  category: 'tree',
  name: 'Pine',
  description:
    'A cold-climate conifer — layered lobed skirts with drooping tips, a straight trunk and a confident spike.',
  variations: [
    { id: 'standard', label: 'Standard', seed: 0x91ae0001, notes: '6 skirts, cold green tiers' },
    { id: 'tall', label: 'Tall', seed: 0x91ae0002, notes: '14–16 u, 7 skirts, tighter crown' },
    { id: 'snowbound', label: 'Snowbound', seed: 0x91ae0003, notes: 'snow-capped skirts, stunted + heavier droop' },
  ],
  motion: 'wind',
  triBudget: budgetFor('pine'),
  heightRange: budgetFor('pine').height,
};

/**
 * Lobed skirt: a three-ring loft whose bottom ring is deformed into k deep
 * scalloped lobes — every 2nd rim vertex also sags DOWN, so the silhouette
 * edge is a scallop, never a straight cone diagonal.
 */
function lobedSkirt(
  next: Next, y: number, radius: number, height: number,
  lobes: number, sides: number, color: string,
): { geom: BufferGeometry; rimAt: (t01: number) => Vector3 } {
  const phase = next() * Math.PI * 2;
  const mkRing = (yy: number, rScale: number, lobeAmp: number, sag: number): Vector3[] => {
    const verts: Vector3[] = [];
    for (let i = 0; i < sides; i++) {
      const t = (i / sides) * Math.PI * 2;
      const lobe = 1 + lobeAmp * Math.cos(lobes * t + phase) + (next() - 0.5) * lobeAmp * 0.8;
      // every 2nd vertex sags below the rim — the scallop
      const sagY = i % 2 === 0 ? -sag * (0.6 + next() * 0.4) : 0;
      verts.push(new Vector3(
        Math.cos(t) * radius * rScale * lobe, yy + sagY, Math.sin(t) * radius * rScale * lobe,
      ));
    }
    return verts;
  };
  const bottom = mkRing(y, 1, 0.3, height * 0.22);
  const mid = mkRing(y + height * 0.55, 0.55, 0.14, 0);
  const top = mkRing(y + height, 0.16, 0.05, 0);
  const positions: number[] = [];
  const indices: number[] = [];
  for (const ring of [bottom, mid, top]) {
    for (const v of ring) positions.push(v.x, v.y, v.z);
  }
  for (let r = 0; r < 2; r++) {
    for (let i = 0; i < sides; i++) {
      const j = (i + 1) % sides;
      const a = r * sides + i, b = r * sides + j;
      const c = (r + 1) * sides + i, d = (r + 1) * sides + j;
      indices.push(a, c, b, b, c, d);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(positions, 3));
  g.setIndex(indices);
  g.computeVertexNormals();
  paint(g, color, 0.55);
  return {
    geom: g,
    rimAt: (t01) => bottom[Math.floor(t01 * sides) % sides]!,
  };
}

function pineTree(next: Next, quality: Quality, variationId: string): SpeciesResult {
  const tall = variationId === 'tall';
  const snow = variationId === 'snowbound';
  const parts: Part[] = [];
  const anchors: Vector3[] = [];

  const height = tall ? 14 + next() * 2 : snow ? 12.4 + next() * 1 : 12.5 + next() * 1.8;
  const skirtCount = quality === 'hero' ? (tall ? 7 : 6) : quality === 'lod' ? 4 : 2;
  const sides = quality === 'hero' ? 8 : 6;

  // welded trunk
  const chain = growChain(next, {
    height: height * 0.94, baseR: 0.4, topR: 0.14,
    leanRad: 0.03 + next() * 0.04, leanDirRad: next() * Math.PI * 2,
    wobble: 0.05, steps: quality === 'micro' ? 3 : 6,
  });
  const trunk = loft(chain.rings, quality === 'hero' ? 7 : 5);
  paintTrunkTiers(trunk, height * 0.94, {
    lit: P.barkOakLit, base: P.barkPine, dark: P.barkPineDark, deep: P.barkPineDark,
  }, 0.05);
  parts.push({ geom: trunk });
  anchors.push(...chain.joints);

  // skirts: wide low, narrowing high; droop increases toward the LOW skirts
  const crownBase = height * 0.2;
  const skirtGeoms: BufferGeometry[] = [];
  for (let i = 0; i < skirtCount; i++) {
    const t = i / Math.max(1, skirtCount - 1);
    const y = crownBase + t * (height * 0.94 - crownBase) * 0.9;
    const radius = (2.9 - t * 2.0) * (snow ? 0.93 : 1);
    const sH = height * (0.26 - t * 0.1);
    const color = t > 0.66 ? P.pineLit : t > 0.28 ? P.pineBase : P.pineDark;
    const s = lobedSkirt(next, y, radius, sH, quality === 'hero' ? 7 : 5, sides, color);
    parts.push({ geom: s.geom });
    skirtGeoms.push(s.geom);

    // drooping TIP blades at the lobe tips — outside the hull, pointing
    // DOWN, in the skirt's own tier colours (never near-black)
    if (quality !== 'micro') {
      const tufts = quality === 'hero' ? 5 + Math.floor(next() * 3) : 3;
      const droop = (snow ? 0.75 : 0.55) + (1 - t) * 0.35; // lower skirts droop more
      for (let k = 0; k < tufts; k++) {
        const rim = s.rimAt((k + next() * 0.5) / tufts);
        const blades = quality === 'hero' ? 3 : 2;
        for (let bi = 0; bi < blades; bi++) {
          const az = Math.atan2(rim.z, rim.x) + (next() - 0.5) * 0.6;
          const tilt = -(0.45 + droop * 0.45) - next() * 0.2; // below horizontal
          parts.push({
            geom: blade({
              length: radius * (0.5 + next() * 0.22), width: 0.4 + next() * 0.16,
              segs: 3, arch: 0.5, color: bi === 0 ? color : t > 0.5 ? P.pineBase : P.pineDark,
            }),
            // root the blade AT the lobe tip, just outside the skirt hull
            matrix: mat.compose(rim.x * 1.04, y + sH * 0.1, rim.z * 1.04, tilt, az, 0),
          });
        }
        anchors.push(new Vector3(rim.x, y, rim.z));
      }
    }
  }

  // top spike: rooted INSIDE the top skirt (base below its rim — never a
  // cone impaled on a bare stick)
  const spikeH = height * 0.16;
  const lastSkirtY = crownBase + (height * 0.94 - crownBase) * 0.9;
  const spike = loft([
    { pos: new Vector3(chain.top.x, lastSkirtY + height * 0.02, chain.top.z), radius: 0.55 },
    { pos: new Vector3(chain.top.x, chain.top.y + spikeH, chain.top.z), radius: 0.03 },
  ], 6);
  paint(spike, snow ? P.snowDust : P.pineLit, 0.95);
  parts.push({ geom: spike });
  anchors.push(chain.top.clone());

  // snow: repaint up-facing faces near the TOP of each skirt only — shallow
  // cone sides count as up only past ny 0.6, so whole-cone repaints can't happen
  if (snow && quality !== 'micro') {
    for (const g of skirtGeoms) paintUpFaces(g, height, [0.45, 1], P.snowDust, 0.6);
  }
  return { parts, anchors };
}

export const pine: AssetModule = makeSpecies(PINE_META, pineTree);
