// ============================================================================
// PINE — layered conifer. Model sheet: straight trunk mostly hidden, 5–7
// drooping-tip skirts in cold tiers, top spike; snowbound dusts upward faces.
// ============================================================================
import { mat, nub, taperCylinder, type Next, type Part } from '../kit/geometry';
import { TREE_PALETTE as P } from '../kit/palette';
import type { AssetMeta, AssetModule, Quality } from '../types';
import { budgetFor, makeSpecies } from './_shared';
import { ConeGeometry } from 'three';
import { paint } from '../kit/geometry';

export const PINE_META: AssetMeta = {
  id: 'pine',
  category: 'tree',
  name: 'Pine',
  description:
    'A cold-climate conifer — layered skirts with drooping tips, a straight hidden trunk and a confident spike.',
  variations: [
    { id: 'standard', label: 'Standard', seed: 0x91ae0001, notes: '6 skirts, full green tiers' },
    { id: 'tall', label: 'Tall', seed: 0x91ae0002, notes: '14–16 u, 7 skirts, tighter crown' },
    { id: 'snowbound', label: 'Snowbound', seed: 0x91ae0003, notes: 'snow-dusted skirts, slightly stunted' },
  ],
  motion: 'wind',
  triBudget: budgetFor('pine'),
  heightRange: budgetFor('pine').height,
};

function skirt(
  next: Next, radius: number, height: number, y: number,
  sides: number, color: string, droopTips: boolean, snow: boolean,
): Part[] {
  const parts: Part[] = [];
  const cone = new ConeGeometry(radius, height, sides, 1, true);
  cone.translate(0, height / 2, 0);
  paint(cone, color, 0.5);
  parts.push({ geom: cone, matrix: mat.at(0, y, 0) });
  if (!droopTips) return parts;
  const tipCount = sides + 2;
  for (let i = 0; i < tipCount; i++) {
    const a = (i / tipCount) * Math.PI * 2 + next() * 0.3;
    const rr = radius * (0.82 + next() * 0.16);
    // small drooping wedge on the skirt rim — the "faceted drooping tips"
    const tip = new ConeGeometry(radius * 0.16, height * 0.55, 3, 1, true);
    tip.translate(0, height * 0.27, 0);
    paint(tip, color, 0.75);
    parts.push({
      geom: tip,
      matrix: mat.compose(Math.cos(a) * rr, y + height * 0.12, Math.sin(a) * rr, 0.35 * Math.sin(a), 0, -0.35 * Math.cos(a)),
    });
    if (snow) {
      const cap = nub(radius * 0.11, P.snowDust);
      parts.push({
        geom: cap,
        matrix: mat.compose(Math.cos(a) * rr * 0.9, y + height * 0.3, Math.sin(a) * rr * 0.9, 0, 0, 0)
          .multiply(mat.scale(1, 0.5, 1)),
      });
    }
  }
  return parts;
}

function pineParts(next: Next, quality: Quality, variationId: string): Part[] {
  const tall = variationId === 'tall';
  const snow = variationId === 'snowbound';
  const parts: Part[] = [];

  const height = tall ? 14 + next() * 2 : snow ? 12 + next() * 1 : 12.5 + next() * 2;
  const skirtCount = quality === 'hero' ? (tall ? 7 : 6) : quality === 'lod' ? 4 : 1;
  const sides = quality === 'hero' ? 9 : 7;
  const trunkH = height * 0.92;
  const lean = (next() - 0.5) * 0.1;

  // trunk (mostly hidden by skirts)
  parts.push({
    geom: taperCylinder({
      bottomR: 0.42, topR: 0.16, height: trunkH, sides: quality === 'hero' ? 7 : 5,
      color: P.barkPine, deepBase: true, deepColor: P.pineDeep,
    }),
    matrix: mat.compose(0, 0, 0, 0, 0, lean, 1),
  });

  // skirts: wide at ~35% height, narrowing to the spike
  const crownBase = height * 0.22;
  for (let i = 0; i < skirtCount; i++) {
    const t = i / Math.max(1, skirtCount - 1); // 0 bottom .. 1 top
    const y = crownBase + t * (trunkH - crownBase) * 0.92;
    const radius = (3.0 - t * 2.1) * (snow ? 0.94 : 1);
    const sH = height * (0.24 - t * 0.09);
    // tier ladder: dark below, base middle, lit crown
    const color = t > 0.66 ? P.pineLit : t > 0.28 ? P.pineBase : P.pineDark;
    parts.push(...skirt(next, radius, sH, y, sides, color, quality !== 'micro' && (quality === 'hero' || i < skirtCount - 1), snow && quality === 'hero'));
  }

  // top spike
  const spikeH = height * 0.16;
  const spike = new ConeGeometry(0.55, spikeH, 6, 1, true);
  spike.translate(0, spikeH / 2, 0);
  paint(spike, snow ? P.snowDust : P.pineLit, 0.95);
  parts.push({ geom: spike, matrix: mat.at(0, trunkH - spikeH * 0.25, 0) });

  return parts;
}

export const pine: AssetModule = makeSpecies(PINE_META, pineParts);
