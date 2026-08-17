// ============================================================================
// BIRCH — slender paper-bark. Model sheet: welded 6–8 sided trunk with chalk/
// warm-grey/cool-shadow tiers + dark lenticel BANDS, drift lean, branchlets
// whose tips carry flattened horizontal leaf sheets (airy by construction —
// sheets never merge into a ball). Trunk ends INSIDE the crown.
// ============================================================================
import { Vector3 } from 'three';
import {
  blob, growLimb, loft, mat, paintBands, paintTrunkTiers, type Next, type Part,
} from '../kit/geometry';
import { TREE_PALETTE as P } from '../kit/palette';
import type { AssetMeta, AssetModule, Quality } from '../types';
import { budgetFor, growChain, makeSpecies, tipOf, type SpeciesResult } from './_shared';

export const BIRCH_META: AssetMeta = {
  id: 'birch',
  category: 'tree',
  name: 'Birch',
  description:
    'A paper-bark slender — chalk-white trunk with dark lenticel bands, airy layered sheets you can see the sky through.',
  variations: [
    { id: 'classic', label: 'Classic', seed: 0xb12c4a01, notes: 'single drift-leaned trunk' },
    { id: 'twin', label: 'Twin', seed: 0xb12c4a02, notes: 'double trunk from one root' },
    { id: 'leaning', label: 'Leaning', seed: 0xb12c4a03, notes: 'strong 6–8° lean, one-sided crown' },
  ],
  motion: 'wind',
  triBudget: budgetFor('birch'),
  heightRange: budgetFor('birch').height,
};

function birchTrunk(
  next: Next, quality: Quality, height: number, lean: number, az: number,
): { parts: Part[]; chain: ReturnType<typeof growChain> } {
  const sides = quality === 'hero' ? 8 : 6;
  const chain = growChain(next, {
    height,
    baseR: 0.3, topR: 0.08, // tapers to a point — no flat-cut pipe top
    leanRad: lean, leanDirRad: az,
    wobble: 0.05, steps: quality === 'micro' ? 6 : 18, flare: 1.3, // FINE rings: bands render
  });
  const g = loft(chain.rings, sides);
  paintTrunkTiers(g, height, {
    lit: P.birchBark, base: P.birchBark, // chalk body — high near-white value
    dark: P.birchBarkCold, deep: P.birchBarkCold,
  }, 0.05);
  // lenticel BANDS: 4–6 short horizontal dark stripes, ragged, up the WHOLE
  // trunk — must read at 20 m
  const bands: { y01: number; h01: number; color: string }[] = [];
  let y01 = 0.1;
  while (y01 < 0.85) {
    const spacing = 0.09 + next() * 0.09;
    const h = 0.02 + next() * 0.022;
    bands.push({ y01, h01: h, color: P.birchBand });
    y01 += spacing + h;
  }
  paintBands(g, height, bands);
  return { parts: [{ geom: g }], chain };
}

function birchTree(next: Next, quality: Quality, variationId: string): SpeciesResult {
  const leaning = variationId === 'leaning';
  const twin = variationId === 'twin';
  const parts: Part[] = [];
  const anchors: Vector3[] = [];

  const height = 11 + next() * (leaning ? 1.5 : 2.5);
  const trunkHeight = height * 0.88; // trunk ends INSIDE the crown
  const lean = leaning ? 0.13 : 0.05 + next() * 0.03;
  const mainAz = next() * Math.PI * 2;

  const main = birchTrunk(next, quality, trunkHeight, lean, mainAz);
  parts.push(...main.parts);
  anchors.push(...main.chain.joints);
  let crownCentre = main.chain.top.clone();

  if (twin && quality !== 'micro') {
    // real multi-stem clump: stems splay from a SHARED base, different heights
    const second = birchTrunk(next, quality, trunkHeight * 0.7, lean * 1.3, mainAz + 1.8);
    parts.push(...second.parts);
    anchors.push(...second.chain.joints);
    crownCentre = crownCentre.lerp(second.chain.top, 0.4);
  }

  // ---- branch skeleton: VISIBLE ascending limbs sweep up-and-out
  // (birch branches rise steeply) — every sheet hangs off a limb tip
  const sheetAnchors: Vector3[] = [];
  const limbCount = quality === 'hero' ? 6 + Math.floor(next() * 3) : quality === 'lod' ? 4 : 2;
  for (let i = 0; i < limbCount; i++) {
    const t01 = 0.58 + next() * 0.34;
    const base = main.chain.at(t01);
    const az = mainAz + (next() - 0.5) * Math.PI * 1.5;
    const pitch = 0.35 + next() * 0.4; // steep rise — birch limbs sweep up
    const dir = new Vector3(
      Math.sin(pitch) * Math.cos(az), Math.cos(pitch), Math.sin(pitch) * Math.sin(az),
    );
    const len = 1.4 + next() * 1.0;
    const tip = tipOf(base, dir, len);
    parts.push({
      geom: growLimb(base, dir, len, 0.16, 0.06, quality === 'hero' ? 6 : 5, {
        lit: P.birchBark, base: P.birchBarkMid, dark: P.birchBarkCold, deep: P.birchBarkCold,
      }),
    });
    sheetAnchors.push(tip);
    anchors.push(tip);
  }
  // crown-top sheets cap the leader INSIDE the crown volume
  const topSheet = crownCentre.clone().add(new Vector3(0, 1.1, 0));
  sheetAnchors.push(topSheet);
  anchors.push(topSheet);

  // ---- crown: flat sheets that INTERLOCK — each sheet's inner edge
  // overlaps the crown core, so the crown is one airy mass with sky-gaps
  // BETWEEN sheets, never plates on poles ----
  const sheetCount = quality === 'hero' ? 7 + Math.floor(next() * 2) : quality === 'lod' ? 4 : 2;
  const detail = quality === 'hero' ? 1 : 0;
  for (let i = 0; i < sheetCount; i++) {
    const a = sheetAnchors[i % sheetAnchors.length]!;
    const t = i / Math.max(1, sheetCount - 1);
    const color = t > 0.6 ? P.birchLeafLit : t > 0.3 ? P.birchLeaf : P.birchLeafDark;
    // pull each sheet toward the crown axis so inner edges overlap
    const toward = new Vector3(crownCentre.x - a.x, 0, crownCentre.z - a.z);
    if (toward.length() > 0.01) toward.normalize().multiplyScalar(0.75);
    // tilt sheets off horizontal — a stacked-plates read is not birch
    const tilt = (i % 2 === 0 ? 1 : -1) * (0.06 + next() * 0.1);
    parts.push({
      geom: blob(next, {
        radius: 1.6 + next() * 0.6,
        detail,
        color,
        jitter: 0.34,       // ragged perimeter
        squashY: 0.3,       // flat sheet
      }),
      matrix: mat.compose(
        a.x + toward.x,
        a.y + (next() - 0.3) * 0.8,
        a.z + toward.z,
        tilt, next() * Math.PI, tilt * 0.6, 1,
      ),
    });
  }
  return { parts, anchors };
}

export const birch: AssetModule = makeSpecies(BIRCH_META, birchTree);
