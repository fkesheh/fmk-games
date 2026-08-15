// ============================================================================
// BIRCH — slender paper-bark. Model sheet: slim 5–6 sided trunk with dark
// lenticel bands, slight S-curve, 5–8 drooping branchlets, airy 4–7 blob
// canopy with sky visible through it.
// ============================================================================
import { Vector3 } from 'three';
import { blob, mat, nub, taperCylinder, type Next, type Part } from '../kit/geometry';
import { TREE_PALETTE as P } from '../kit/palette';
import type { AssetMeta, AssetModule, Quality } from '../types';
import { budgetFor, makeSpecies, scatter } from './_shared';

export const BIRCH_META: AssetMeta = {
  id: 'birch',
  category: 'tree',
  name: 'Birch',
  description:
    'A paper-bark slender — white trunk with dark lenticel bands, airy yellow-green canopy you can see the sky through.',
  variations: [
    { id: 'classic', label: 'Classic', seed: 0xb12c4a01, notes: 'single S-curve trunk' },
    { id: 'twin', label: 'Twin', seed: 0xb12c4a02, notes: 'double trunk from one root' },
    { id: 'leaning', label: 'Leaning', seed: 0xb12c4a03, notes: 'strong 6–8° lean, one-sided canopy' },
  ],
  motion: 'wind',
  triBudget: budgetFor('birch'),
  heightRange: budgetFor('birch').height,
};

const TIER = { lit: P.birchLeafLit, base: P.birchLeaf, dark: P.birchLeafDark };

interface TrunkResult {
  top: Vector3; // crown position
  dirAt: (y01: number) => Vector3; // trunk surface offset dir at height fraction
}

function birchTrunk(
  parts: Part[], next: Next, quality: Quality,
  height: number, leanX: number, baseOffset: Vector3,
): TrunkResult {
  const sides = quality === 'hero' ? 6 : 5;
  const segs = quality === 'micro' ? 2 : 3;
  let y = 0;
  let x = baseOffset.x;
  let z = baseOffset.z;
  let lean = leanX;
  const leanDir = new Vector3(1, 0, 0.15);
  for (let i = 0; i < segs; i++) {
    const h = height / segs;
    const t0 = i / segs;
    const rB = 0.3 * (1 - t0 * 0.55);
    const rT = 0.3 * (1 - (t0 + 1 / segs) * 0.55);
    parts.push({
      geom: taperCylinder({
        bottomR: rB, topR: rT, height: h, sides,
        color: i % 2 === 0 ? P.birchBark : P.birchBarkShade,
        deepBase: i === 0, deepColor: P.birchBand,
      }),
      matrix: mat.compose(x, y, z, 0, 0, lean, 1),
    });
    // advance along the lean
    x += Math.sin(lean) * h * leanDir.x;
    z += Math.sin(lean) * h * leanDir.z;
    y += Math.cos(lean) * h;
    lean += (next() - 0.5) * 0.06; // S-curve wobble
  }
  return {
    top: new Vector3(x, y, z),
    dirAt: () => leanDir.clone(),
  };
}

function birchParts(next: Next, quality: Quality, variationId: string): Part[] {
  const parts: Part[] = [];
  const leaning = variationId === 'leaning';
  const twin = variationId === 'twin';
  const height = 10.5 + next() * (leaning ? 1.5 : 3);
  const lean = leaning ? 0.12 : 0.05; // 3°..7°

  const main = birchTrunk(parts, next, quality, height, lean, new Vector3(0, 0, 0));
  if (twin && quality !== 'micro') {
    birchTrunk(parts, next, quality, height * 0.78, -lean * 0.7, new Vector3(0.55, 0, 0.1));
  }

  // ---- lenticel bands (hero/lod): dark paper dashes on the trunk ----
  const bandCount = quality === 'hero' ? 12 + Math.floor(next() * 5) : quality === 'lod' ? 6 : 0;
  for (let i = 0; i < bandCount; i++) {
    const y01 = 0.08 + next() * 0.8;
    const a = next() * Math.PI * 2;
    const r = 0.3 * (1 - y01 * 0.5);
    parts.push({
      geom: nub(0.05 + next() * 0.045, P.birchBand),
      matrix: mat.compose(
        Math.cos(a) * r, y01 * height, Math.sin(a) * r,
        next() * 0.4, next() * Math.PI, next() * 0.4,
      ).multiply(mat.scale(1, 0.5, 1.9)),
    });
  }

  // ---- branchlets: thin, drooping ----
  const twigCount = quality === 'hero' ? 5 + Math.floor(next() * 4) : quality === 'lod' ? 3 : 0;
  for (let i = 0; i < twigCount; i++) {
    const dir = next() * Math.PI * 2;
    const droop = 0.35 + next() * 0.25; // tips 20–35° below horizontal
    const len = 1.2 + next() * 1.1;
    const bh = height * (0.55 + next() * 0.38);
    parts.push({
      geom: taperCylinder({ bottomR: 0.05, topR: 0.012, height: len, sides: 4, color: P.birchBarkShade }),
      matrix: mat.compose(
        main.top.x * (bh / height), bh, main.top.z * (bh / height),
        droop * Math.cos(dir), 0, -droop * Math.sin(dir),
      ),
    });
  }

  // ---- airy canopy: smaller blobs, wider spread, more gaps ----
  const blobCount = quality === 'hero' ? 4 + Math.floor(next() * 4) : quality === 'lod' ? 4 : 1;
  const detail = quality === 'hero' ? 2 : 0;
  const radii = quality === 'hero' ? [1.05, 0.75, 0.9, 0.65, 0.85] : quality === 'lod' ? [1.0, 0.85, 0.9, 0.8, 0.95] : [1.8];
  const centre = new Vector3(main.top.x * 0.7, height * 0.86, main.top.z * 0.7);
  const spots = scatter(
    next, blobCount, centre,
    { x: leaning ? 2.2 : 1.7, yMin: -1.0, yMax: 1.9, z: 1.7 },
    0.78, radii, // high min-gap: deliberately airy
  );
  spots.forEach((p, i) => {
    const t01 = (p.y - centre.y + 1.0) / 2.9;
    const color = t01 > 0.6 ? TIER.lit : t01 > 0.3 ? TIER.base : TIER.dark;
    parts.push({
      geom: blob(next, { radius: radii[i % radii.length] ?? 0.9, detail, color, jitter: 0.2, squashY: 0.78 }),
      matrix: mat.at(p.x, p.y, p.z),
    });
  });
  return parts;
}

export const birch: AssetModule = makeSpecies(BIRCH_META, birchParts);
