// ============================================================================
// PALM — tropical. Model sheet: welded CURVED trunk (20–35° cumulative over
// the top two-thirds) with fine vertical resolution so ring BANDS render,
// crown diameter ~40% of trunk height (fronds arch up, crest, sag past
// horizontal), coconut cluster tucked at the crown, dead fronds hanging DOWN.
// ============================================================================
import { Vector3 } from 'three';
import { blade, loft, mat, nub, paintBands, paintTrunkTiers, type Next, type Part } from '../kit/geometry';
import { TREE_PALETTE as P } from '../kit/palette';
import type { AssetMeta, AssetModule, Quality } from '../types';
import { budgetFor, makeSpecies, type SpeciesResult } from './_shared';

export const PALM_META: AssetMeta = {
  id: 'palm',
  category: 'tree',
  name: 'Palm',
  description:
    'A tropical palm — curved ringed trunk, arched fronds sagging past horizontal, coconuts tucked in the crown.',
  variations: [
    { id: 'standard', label: 'Standard', seed: 0x9a100001, notes: 'gentle 6° curve, 3–4 coconuts' },
    { id: 'curved', label: 'Curved', seed: 0x9a100002, notes: 'strong sea-windswept 20° curve' },
    { id: 'coconut-heavy', label: 'Coconut Heavy', seed: 0x9a100003, notes: '5–7 nuts + 1–2 dead fronds skirt' },
  ],
  motion: 'wind',
  triBudget: budgetFor('palm'),
  heightRange: budgetFor('palm').height,
};

function palmTree(next: Next, quality: Quality, variationId: string): SpeciesResult {
  const curved = variationId === 'curved';
  const nutty = variationId === 'coconut-heavy';
  const parts: Part[] = [];
  const anchors: Vector3[] = [];

  const height = 9.5 + next() * 2.5;
  // curve: gentle low, accumulating over the top two-thirds; seed-varied dir
  const totalCurve = curved ? 0.55 : 0.3 + next() * 0.1; // 17°..31° — the curve must READ
  const curveAz = next() * Math.PI * 2;
  const steps = quality === 'micro' ? 5 : 18; // FINE rings — bands need resolution
  const sides = quality === 'hero' ? 8 : 6;

  // ---- welded curved trunk via loft rings along an accumulating tilt ----
  const rings: { pos: Vector3; radius: number }[] = [];
  let pos = new Vector3(0, 0, 0);
  let tilt = 0.02;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const taper = 0.38 * (1 - t * 0.52) * (t < 0.08 ? 1.3 : 1); // strong taper + base flare
    rings.push({ pos: pos.clone(), radius: taper });
    const grow = t < 0.33 ? 0 : (t - 0.33) / 0.67;
    const targetTilt = 0.02 + totalCurve * grow * grow;
    tilt += (targetTilt - tilt) * 0.4;
    pos = pos.clone().add(new Vector3(
      Math.sin(tilt) * Math.cos(curveAz), Math.cos(tilt), Math.sin(tilt) * Math.sin(curveAz),
    ).multiplyScalar(height / steps));
  }
  const trunk = loft(rings, sides);
  paintTrunkTiers(trunk, height, {
    lit: P.palmTrunkLit, base: P.palmTrunk, dark: P.palmTrunkDark, deep: P.palmTrunkDark,
  }, 0.06);
  // ring bands: 12–18 grooves, spacing TIGHTENING toward the crown, each
  // tall enough to read on BOTH silhouette edges
  const bands: { y01: number; h01: number; color: string }[] = [];
  let y01 = 0.04;
  while (y01 < 0.92) {
    bands.push({ y01, h01: 0.014 + next() * 0.012, color: P.palmRing });
    y01 += 0.075 - y01 * 0.045 + next() * 0.02;
  }
  paintBands(trunk, height, bands);
  parts.push({ geom: trunk });
  const crown = rings[rings.length - 1]!.pos.clone();
  anchors.push(...rings.map((r) => r.pos));
  anchors.push(crown);

  // ---- fronds: crown diameter ~40% of trunk height ----
  // arch: rise from the crown, crest, sag past horizontal so tips point down
  const frondCount = quality === 'hero'
    ? (nutty ? 10 : 12) + Math.floor(next() * 2)
    : quality === 'lod' ? 8 : 5;
  const crownSpan = height * 0.42; // target crown diameter
  for (let i = 0; i < frondCount; i++) {
    const a = (i / frondCount) * Math.PI * 2 + next() * 0.4;
    // tier by ELEVATION: small drop = upper arc = lit; big drop = sagging = dark
    const elevation = (i % 3) / 2; // 0, 0.5, 1 cycling
    const drop = 0.12 + (1 - elevation) * 0.55 + next() * 0.15;
    const color = elevation > 0.6 ? P.frondLit : elevation > 0.25 ? P.frond : P.frondDark;
    const len = crownSpan * (0.48 + next() * 0.16); // radius ≈ half the crown dia
    parts.push({
      geom: blade({
        length: len, width: 0.62 + next() * 0.25, segs: quality === 'hero' ? 6 : 3,
        arch: len * (0.62 + next() * 0.3), // sag well past horizontal
        color, tiltUp: len * 0.22, // crest above the crown first
      }),
      matrix: mat.compose(crown.x, crown.y + 0.12, crown.z, drop, a, 0),
    });
    // frond tips are attached (rooted at the crown) — anchor them so the
    // anti-float test measures the whole frond span, not just its root
    const fLen = len;
    anchors.push(new Vector3(
      crown.x + Math.cos(a) * fLen * 0.8,
      crown.y + 0.12 - fLen * 0.35,
      crown.z + Math.sin(a) * fLen * 0.8,
    ));
  }
  // dead brown fronds hanging straight DOWN against the trunk (story detail)
  if (nutty && quality !== 'micro') {
    for (let i = 0; i < 2; i++) {
      const a = next() * Math.PI * 2;
      parts.push({
        geom: blade({
          length: crownSpan * 0.55, width: 0.5, segs: 4,
          arch: crownSpan * 0.1, color: P.frondDead, tiltUp: 0,
        }),
        matrix: mat.compose(crown.x, crown.y - 0.1, crown.z, 1.45, a, 0), // steeply down
      });
      anchors.push(new Vector3(crown.x, crown.y - crownSpan * 0.5, crown.z));
    }
  }
  // crown core knot (where fronds meet — the AO)
  parts.push({ geom: nub(0.42, P.frondDeep), matrix: mat.at(crown.x, crown.y + 0.06, crown.z) });

  // ---- coconuts tucked at the crown base, lit clear of the crown shadow ----
  const nutCount = quality === 'hero'
    ? (nutty ? 5 + Math.floor(next() * 3) : 4)
    : quality === 'lod' ? 3 : 0;
  for (let i = 0; i < nutCount; i++) {
    const a = (i / nutCount) * Math.PI * 2 + next() * 0.8;
    parts.push({
      geom: nub(0.28, i % 2 ? P.coconut : P.coconutDeep, true),
      matrix: mat.at(crown.x + Math.cos(a) * 0.4, crown.y - 0.24, crown.z + Math.sin(a) * 0.4),
    });
  }
  return { parts, anchors };
}

export const palm: AssetModule = makeSpecies(PALM_META, palmTree);
