// ============================================================================
// SNAG — dead tree. Model sheet: no foliage, jagged tapered trunk, 4–6 broken
// branches at expressive angles, woodpecker hole, lightning-split top on the
// lightning variation, moss on weathered.
// ============================================================================
import { mat, nub, taperCylinder, type Next, type Part } from '../kit/geometry';
import { TREE_PALETTE as P } from '../kit/palette';
import type { AssetMeta, AssetModule, Quality } from '../types';
import { budgetFor, makeSpecies } from './_shared';

export const SNAG_META: AssetMeta = {
  id: 'snag',
  category: 'tree',
  name: 'Dead Snag',
  description:
    'A standing dead tree — jagged, expressive, full of angles; the shape a raven picks.',
  variations: [
    { id: 'classic', label: 'Classic', seed: 0xdead0001, notes: 'broken top, woodpecker hole' },
    { id: 'lightning', label: 'Lightning', seed: 0xdead0002, notes: 'split charred top' },
    { id: 'weathered', label: 'Weathered', seed: 0xdead0003, notes: 'paler greys, moss at base' },
  ],
  motion: 'wind',
  triBudget: budgetFor('snag'),
  heightRange: budgetFor('snag').height,
};

function snagParts(next: Next, quality: Quality, variationId: string): Part[] {
  const lightning = variationId === 'lightning';
  const weathered = variationId === 'weathered';
  const parts: Part[] = [];

  const height = 7.5 + next() * (weathered ? 1.2 : 2.2);
  const bark = weathered ? P.deadwoodLit : P.deadwood;
  const barkDark = weathered ? P.deadwood : P.deadwoodDark;
  const sides = quality === 'hero' ? 7 : 5;

  // ---- jagged trunk: 3 segments with expressive kinks ----
  const segs = quality === 'micro' ? 2 : 3;
  let y = 0;
  let ang = (next() - 0.5) * 0.16;
  let x = 0, z = 0;
  for (let i = 0; i < segs; i++) {
    const h = (height / segs) * (i === segs - 1 ? 0.9 : 1);
    const rB = 0.4 * (1 - (i / segs) * 0.55);
    const rT = 0.4 * (1 - ((i + 1) / segs) * 0.55);
    parts.push({
      geom: taperCylinder({
        bottomR: rB, topR: rT, height: h, sides,
        color: i % 2 === 0 ? bark : barkDark,
        deepBase: i === 0, deepColor: P.deadwoodDeep,
      }),
      matrix: mat.compose(x, y, z, ang * 0.3, next() * Math.PI, ang, 1),
    });
    x += Math.sin(ang) * h;
    z += Math.cos(ang) * h * 0.2;
    y += Math.cos(ang) * h;
    ang += (next() - 0.5) * 0.35; // strong kinks
  }

  // ---- top: broken jagged tip / lightning split ----
  if (quality !== 'micro') {
    if (lightning) {
      // two split shards flying apart at the break
      for (const s of [-1, 1]) {
        parts.push({
          geom: taperCylinder({ bottomR: 0.14, topR: 0.02, height: 1.3, sides: 4, color: P.deadwoodDeep }),
          matrix: mat.compose(x + s * 0.22, y + 0.1, z, s * 0.5, 0, 0.2 * s),
        });
      }
      // char band just below the split
      parts.push({
        geom: nub(0.26, P.knotHole),
        matrix: mat.at(x, y - 0.5, z).multiply(mat.scale(1, 0.7, 1)),
      });
    } else {
      parts.push({
        geom: taperCylinder({ bottomR: 0.15, topR: 0.01, height: 1.0, sides: 4, color: barkDark }),
        matrix: mat.compose(x, y, z, 0.35, next(), 0.25),
      });
    }
  }

  // ---- broken branch stubs at expressive angles ----
  const stubCount = quality === 'hero' ? 4 + Math.floor(next() * 3) : quality === 'lod' ? 3 : 1;
  for (let i = 0; i < stubCount; i++) {
    const dir = (i / stubCount) * Math.PI * 2 + next() * 1.2;
    const tilt = 0.35 + next() * 0.85; // 20°..70°
    const len = 0.8 + next() * 1.4;
    const bh = height * (0.3 + next() * 0.55);
    parts.push({
      geom: taperCylinder({ bottomR: 0.12, topR: 0.03, height: len, sides: 4, color: i % 2 ? bark : barkDark }),
      matrix: mat.compose(
        x * (bh / height), bh, z * (bh / height),
        tilt * Math.cos(dir), 0, -tilt * Math.sin(dir),
      ),
    });
    // some stubs snap downward — dead-branch droop
    if (next() > 0.55 && quality === 'hero') {
      parts.push({
        geom: taperCylinder({ bottomR: 0.06, topR: 0.015, height: len * 0.6, sides: 4, color: barkDark }),
        matrix: mat.compose(
          Math.sin(dir) * len * 0.8, bh + Math.cos(tilt) * len * 0.75, Math.cos(dir) * len * 0.8,
          1.1 * Math.cos(dir), 0, -1.1 * Math.sin(dir),
        ),
      });
    }
  }

  // ---- story details ----
  if (quality === 'hero') {
    // woodpecker hole
    parts.push({
      geom: nub(0.14, P.knotHole),
      matrix: mat.at(0.3, height * 0.42, 0.16).multiply(mat.scale(0.7, 1.15, 0.7)),
    });
    if (weathered) {
      // moss patch at the base
      for (let i = 0; i < 3; i++) {
        const a = next() * Math.PI * 2;
        parts.push({
          geom: nub(0.28 + next() * 0.14, P.moss),
          matrix: mat.compose(Math.cos(a) * 0.34, 0.22 + next() * 0.3, Math.sin(a) * 0.34, 0, 0, 0)
            .multiply(mat.scale(1, 0.55, 1)),
        });
      }
    }
  }
  return parts;
}

export const snag: AssetModule = makeSpecies(SNAG_META, snagParts);
