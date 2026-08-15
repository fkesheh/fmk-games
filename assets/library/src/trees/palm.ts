// ============================================================================
// PALM — tropical. Model sheet: curved ringed trunk (rings every 0.4–0.6 u),
// 7–9 arched fronds with sagging tips, coconut cluster at the crown.
// ============================================================================
import { Vector3 } from 'three';
import { mat, nub, strip, taperCylinder, type Next, type Part } from '../kit/geometry';
import { TREE_PALETTE as P } from '../kit/palette';
import type { AssetMeta, AssetModule, Quality } from '../types';
import { budgetFor, makeSpecies } from './_shared';

export const PALM_META: AssetMeta = {
  id: 'palm',
  category: 'tree',
  name: 'Palm',
  description:
    'A tropical palm — curved ringed trunk, arched fronds with sagging tips, coconuts tucked in the crown.',
  variations: [
    { id: 'standard', label: 'Standard', seed: 0x9a100001, notes: 'gentle 6° curve, 3–4 coconuts' },
    { id: 'curved', label: 'Curved', seed: 0x9a100002, notes: 'strong 12° sea-windswept curve' },
    { id: 'coconut-heavy', label: 'Coconut Heavy', seed: 0x9a100003, notes: '5–7 nuts, slightly fewer fronds' },
  ],
  motion: 'wind',
  triBudget: budgetFor('palm'),
  heightRange: budgetFor('palm').height,
};

function palmParts(next: Next, quality: Quality, variationId: string): Part[] {
  const curved = variationId === 'curved';
  const nutty = variationId === 'coconut-heavy';
  const parts: Part[] = [];

  const height = 9.5 + next() * 3;
  const totalCurve = curved ? 0.21 : 0.1 + next() * 0.04; // rad — ~6°..12°
  const segCount = quality === 'micro' ? 3 : 7;
  const segH = height / segCount;

  // ---- trunk: stacked segments, progressive tilt, ring at each joint ----
  let pos = new Vector3(0, 0, 0);
  let tilt = 0;
  for (let i = 0; i < segCount; i++) {
    const r = 0.34 * (1 - (i / segCount) * 0.35);
    parts.push({
      geom: taperCylinder({
        bottomR: r, topR: r * 0.94, height: segH,
        sides: quality === 'hero' ? 7 : 5,
        color: i === segCount - 2 ? P.palmTrunkLit : i % 2 === 0 ? P.palmTrunk : P.palmTrunkDark,
        deepBase: i === 0, deepColor: P.palmRing,
      }),
      matrix: mat.compose(pos.x, pos.y, pos.z, 0, 0, tilt, 1),
    });
    // ring band at each joint
    if (quality !== 'micro' && i > 0 && i < segCount - 1) {
      parts.push({
        geom: taperCylinder({ bottomR: r * 1.06, topR: r * 1.04, height: 0.16, sides: 6, color: P.palmRing }),
        matrix: mat.compose(pos.x, pos.y + 0.02, pos.z, 0, 0, tilt, 1),
      });
    }
    pos = new Vector3(pos.x + Math.sin(tilt) * segH, pos.y + Math.cos(tilt) * segH, pos.z);
    tilt += totalCurve / segCount;
  }
  const crown = pos;

  // ---- fronds: arched ribbons radiating from the crown ----
  // strip extends +Z with sagging tip; yaw around Y sends it outward at
  // angle a, pitch around X (applied first by the XYZ euler order) drops it.
  const frondCount = quality === 'hero'
    ? (nutty ? 7 : 8) + Math.floor(next() * 2)
    : quality === 'lod' ? 6 : 3;
  const segs = quality === 'hero' ? 5 : 3;
  for (let i = 0; i < frondCount; i++) {
    const a = (i / frondCount) * Math.PI * 2 + next() * 0.5;
    const len = 2.6 + next() * 1.2;
    const width = 0.55 + next() * 0.2;
    const drop = 0.3 + next() * 0.55; // outward pitch below horizontal
    const color = i % 3 === 0 ? P.frondLit : i % 3 === 1 ? P.frond : P.frondDark;
    parts.push({
      geom: strip({ length: len, width, segs, arch: len * (0.55 + next() * 0.3), color, taperWidth: 0.3 }),
      matrix: mat.compose(crown.x, crown.y + 0.15, crown.z, drop, a, 0),
    });
  }
  // crown core (where fronds meet — the AO knot)
  parts.push({
    geom: nub(0.34, P.frondDeep),
    matrix: mat.at(crown.x, crown.y + 0.1, crown.z),
  });

  // ---- coconuts ----
  const nutCount = quality === 'hero'
    ? (nutty ? 5 + Math.floor(next() * 3) : 3 + Math.floor(next() * 2))
    : quality === 'lod' ? 2 : 0;
  for (let i = 0; i < nutCount; i++) {
    const a = (i / nutCount) * Math.PI * 2 + next() * 0.8;
    parts.push({
      geom: nub(0.22, i % 2 ? P.coconut : P.coconutDeep, true),
      matrix: mat.at(crown.x + Math.cos(a) * 0.3, crown.y - 0.12, crown.z + Math.sin(a) * 0.3),
    });
  }
  return parts;
}

export const palm: AssetModule = makeSpecies(PALM_META, palmParts);
