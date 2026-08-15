// ============================================================================
// OAK — heroic broadleaf. Model sheet (ASSET_CONTRACT): squat tapered trunk,
// 3–5 gnarled boughs at 35–55°, canopy of 6–9 large blob masses in three
// tiers with gaps between them. Story details: hollow knot, broken bough.
// ============================================================================
import { Vector3 } from 'three';
import { blob, mat, nub, taperCylinder, type Next, type Part } from '../kit/geometry';
import { TREE_PALETTE as P } from '../kit/palette';
import type { AssetMeta, AssetModule, Quality } from '../types';
import { budgetFor, makeSpecies, scatter } from './_shared';

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
  triBudget: budgetFor('oak'),
  heightRange: budgetFor('oak').height,
};

const TIER = { lit: P.leafLit, base: P.leaf, dark: P.leafDark, deep: P.leafDeep };
const AUTUMN = { lit: P.autumnLit, base: P.autumn, dark: P.autumnDark };

function oakParts(next: Next, quality: Quality, variationId: string): Part[] {
  const isAutumn = variationId === 'autumn';
  const isYoung = variationId === 'young';
  const parts: Part[] = [];

  // ---- proportions (metres) ----
  const trunkH = (isYoung ? 4.9 : 4.6) + next() * (isYoung ? 0.5 : 0.9);
  const lean = (next() - 0.5) * 0.14; // ±4°
  const trunkSides = quality === 'hero' ? 8 : quality === 'lod' ? 6 : 5;
  const thickness = isYoung ? 0.68 : 1;

  // ---- trunk: 3 gnarled segments ----
  const segH = [trunkH * 0.45, trunkH * 0.35, trunkH * 0.2];
  const botR = [0.62, 0.44, 0.32].map((r) => r * thickness);
  const topR = [0.44, 0.32, 0.24].map((r) => r * thickness);
  let y = 0;
  let ang = lean;
  for (let i = 0; i < 3; i++) {
    const h = segH[i] ?? trunkH / 3;
    parts.push({
      geom: taperCylinder({
        bottomR: botR[i] ?? 0.4, topR: topR[i] ?? 0.3, height: h, sides: trunkSides,
        color: P.barkPine, deepBase: i === 0, deepColor: P.leafDeep,
      }),
      matrix: mat.compose(0, y, 0, ang * 0.4, next() * Math.PI, ang, 1),
    });
    y += h * 0.96;
    ang += (next() - 0.5) * 0.1;
  }
  const boughBase = trunkH * 0.62;

  // ---- boughs: 3–5, gnarled 35–55° ----
  const boughCount = quality === 'hero' ? (isYoung ? 2 : 3) + Math.floor(next() * 3) : quality === 'lod' ? 2 : 0;
  for (let i = 0; i < boughCount; i++) {
    const dir = (i / Math.max(1, boughCount)) * Math.PI * 2 + next() * 0.8;
    const tilt = 0.6 + next() * 0.35; // ~35–55° from vertical
    const len = (1.6 + next() * 1.4) * (quality === 'lod' ? 0.8 : 1) * thickness;
    const bh = boughBase + next() * (trunkH * 0.3);
    parts.push({
      geom: taperCylinder({ bottomR: 0.18, topR: 0.07, height: len, sides: 5, color: P.barkPine }),
      matrix: mat.compose(
        Math.sin(dir) * 0.2, bh, Math.cos(dir) * 0.2,
        tilt * Math.cos(dir), 0, -tilt * Math.sin(dir),
      ),
    });
  }

  // ---- canopy: big tiered masses with gaps ----
  const blobCount = isYoung && quality === 'hero' ? 5
    : quality === 'hero' ? 7 + Math.floor(next() * 3)
    : quality === 'lod' ? 5 : 1;
  const detail = quality === 'hero' ? 2 : 0;
  const centreY = trunkH + (isYoung ? 1.2 : 1.7);
  const radii = quality === 'hero'
    ? (isYoung ? [1.15, 0.95, 1.05, 0.9, 1.1] : [1.7, 1.45, 1.25, 1.6, 1.15])
    : quality === 'lod' ? [1.5, 1.3, 1.4, 1.2, 1.35] : [2.3];
  const spots = scatter(
    next, blobCount,
    new Vector3(0, centreY, 0),
    { x: isYoung ? 1.9 : 2.6, yMin: -0.9, yMax: 2.6, z: isYoung ? 1.9 : 2.6 },
    0.62, radii,
  );
  spots.forEach((p, i) => {
    const r = radii[i % radii.length] ?? 1.3;
    const t01 = (p.y - centreY + 0.9) / 3.5; // 0 low .. 1 crown
    let color: string;
    if (t01 > 0.62) color = isAutumn && i % 3 !== 0 ? AUTUMN.lit : TIER.lit;
    else if (t01 > 0.34) color = isAutumn && i % 2 === 0 ? AUTUMN.base : TIER.base;
    else color = isAutumn && i % 4 === 0 ? AUTUMN.dark : TIER.dark;
    parts.push({
      geom: blob(next, { radius: r, detail, color, jitter: 0.22, squashY: 0.8 }),
      matrix: mat.at(p.x, p.y, p.z),
    });
  });
  // deep core mass under the canopy (the library's AO)
  if (quality !== 'micro') {
    parts.push({
      geom: blob(next, { radius: 1.35 * thickness, detail: 0, color: TIER.deep, jitter: 0.16 }),
      matrix: mat.at(0, centreY - 1.15, 0),
    });
  }

  // ---- story details (hero only) ----
  if (quality === 'hero' && !isYoung) {
    // hollow knot low on the trunk
    parts.push({
      geom: nub(0.17, P.knotHole),
      matrix: mat.compose(0.52 * thickness, 1.15, 0.12, 0, 0.3, 0, 1).multiply(mat.scale(0.6, 1, 1)),
    });
    if (!isAutumn) {
      // broken bough stub
      parts.push({
        geom: taperCylinder({ bottomR: 0.16, topR: 0.11, height: 0.9, sides: 5, color: P.deadwood }),
        matrix: mat.compose(0.7, trunkH * 0.78, -0.5, 0.9, 0, 0.5),
      });
    }
  }
  return parts;
}

export const oak: AssetModule = makeSpecies(OAK_META, oakParts);
