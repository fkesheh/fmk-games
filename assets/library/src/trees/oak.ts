// ============================================================================
// OAK — heroic broadleaf. Model sheet: welded S-leaning trunk with asymmetric
// root buttresses, 3–5 boughs whose TIPS carry the crown: dominant masses +
// silhouette-edge breakup clumps (clamped to the tips — nothing floats),
// staggered underside (jagged crown bottom, never a bun), sky-gaps, inset
// hollow knot, thick splintered broken bough.
// ============================================================================
import { Vector3 } from 'three';
import {
  blob, growLimb, loft, mat, paint, paintTrunkTiers, type Next, type Part,
} from '../kit/geometry';
import { TREE_PALETTE as P } from '../kit/palette';
import type { AssetMeta, AssetModule, Quality } from '../types';
import { budgetFor, growChain, makeSpecies, tipOf, type SpeciesResult } from './_shared';

export const OAK_META: AssetMeta = {
  id: 'oak',
  category: 'tree',
  name: 'Oak',
  description:
    'A veteran broadleaf — squat, confident, canopy massed in big readable clumps with sky between them.',
  variations: [
    { id: 'veteran', label: 'Veteran', seed: 0x0a11ce11, notes: 'hollow knot + one broken bough' },
    { id: 'autumn', label: 'Autumn', seed: 0xa67b6a17, notes: 'same grove, autumn crown — broader + one fewer bough' },
    { id: 'young', label: 'Young', seed: 0x0b0d1e55, notes: 'slimmer, taller-crowned individual' },
  ],
  motion: 'wind',
  triBudget: budgetFor('oak'),
  heightRange: budgetFor('oak').height,
};

const GREEN = { lit: P.leafLit, base: P.leaf, dark: P.leafDark, deep: P.leafDeep };
const AUTUMN = { lit: P.autumnLit, base: P.autumn, dark: P.autumnDark, deep: P.leafDeep };

/** Per-variation individuality: same species + season, different tree. */
const VAR = {
  veteran: { h: 1.0, thick: 1.0, boughs: 5, breakup: 7, lean: 1.0 },
  autumn: { h: 1.12, thick: 1.08, boughs: 4, breakup: 9, lean: 1.35 },
  young: { h: 1.06, thick: 0.72, boughs: 4, breakup: 5, lean: 0.7 },
} as const;

function oakTree(next: Next, quality: Quality, variationId: string): SpeciesResult {
  const isAutumn = variationId === 'autumn';
  const v = VAR[variationId as keyof typeof VAR] ?? VAR.veteran;
  const parts: Part[] = [];
  const anchors: Vector3[] = [];

  // ---- welded trunk chain: S-lean, wobble, root flare ----
  const trunkH = (6.0 * v.h) + next() * 0.8;
  const thick = v.thick;
  const sides = quality === 'hero' ? 9 : quality === 'lod' ? 6 : 5;
  const chain = growChain(next, {
    height: trunkH,
    baseR: 0.6 * thick, topR: 0.26 * thick,
    leanRad: (0.06 + next() * 0.05) * v.lean, leanDirRad: next() * Math.PI * 2,
    wobble: 0.09, steps: quality === 'micro' ? 4 : 9,
  });
  const trunkGeom = loft(chain.rings, sides);
  paintTrunkTiers(trunkGeom, trunkH, {
    lit: P.barkOakLit, base: P.barkOak, dark: P.barkOakDark, deep: P.barkOakDeep,
  }, 0.1);
  parts.push({ geom: trunkGeom });
  anchors.push(...chain.joints);

  // ---- asymmetric root buttresses: 4–5 thick limbs angling into the ground
  if (quality !== 'micro') {
    const buttressCount = 4 + Math.floor(next() * 2);
    for (let i = 0; i < buttressCount; i++) {
      const a = (i / buttressCount) * Math.PI * 2 + next() * 0.6;
      const base = chain.at(0.05);
      const dir = new Vector3(Math.cos(a) * 0.85, -0.5, Math.sin(a) * 0.85).normalize();
      const len = 0.8 + next() * 0.6;
      parts.push({
        geom: growLimb(base, dir, len, 0.3 * thick, 0.22 * thick, 5, {
          lit: P.barkOakLit, base: P.barkOak, dark: P.barkOakDark, deep: P.barkOakDeep,
        }),
      });
    }
  }

  // ---- boughs from trunk joints; their tips are the crown anchors ----
  const boughCount = quality === 'hero' ? v.boughs : quality === 'lod' ? 2 : 0;
  const tips: Vector3[] = [];
  for (let i = 0; i < boughCount; i++) {
    const t01 = 0.66 + (i / Math.max(1, boughCount)) * 0.3;
    const base = chain.at(t01);
    const az = (i / Math.max(1, boughCount)) * Math.PI * 2 + next() * 0.9;
    const pitch = 0.45 + next() * 0.3; // rising boughs carry the crown high
    const dir = new Vector3(
      Math.sin(pitch) * Math.cos(az), Math.cos(pitch), Math.sin(pitch) * Math.sin(az),
    );
    const len = (2.0 + next() * 1.2) * (quality === 'lod' ? 0.85 : 1);
    const tip = tipOf(base, dir, len);
    parts.push({
      geom: growLimb(base, dir, len, 0.2 * thick, 0.08, sides === 9 ? 6 : 5, {
        lit: P.barkOakLit, base: P.barkOak, dark: P.barkOakDark, deep: P.barkOakDark,
      }),
    });
    tips.push(tip);
    anchors.push(tip);
  }
  anchors.push(chain.top.clone());
  if (tips.length === 0) tips.push(chain.top.clone()); // micro: crown on trunk top

  // ---- crown: dominant masses at tips, breakup clumps ON the silhouette
  // edge, staggered underside — no core blob, no bun ----
  const T = isAutumn ? AUTUMN : GREEN;
  const detail = quality === 'hero' ? 2 : 0;
  if (quality === 'micro') {
    parts.push({
      geom: blob(next, { radius: 2.1 * thick, detail: 0, color: T.base, jitter: 0.2, squashY: 0.8 }),
      matrix: mat.at(chain.top.x, chain.top.y + 1.4, chain.top.z),
    });
  } else {
    // 2–3 dominant masses centred ON the main tips (overlap the bough tips)
    const dominants = Math.min(tips.length, 3);
    for (let i = 0; i < dominants; i++) {
      const t = tips[i]!;
      parts.push({
        geom: blob(next, { radius: 1.55 * thick, detail, color: i === 0 ? T.lit : T.base, jitter: 0.24, squashY: 0.78 }),
        matrix: mat.at(t.x, t.y + 0.4, t.z),
      });
    }
    // breakup clumps: HALF-RADIUS, clamped tight to the dominant masses
    // (a clump never strays > 1.1u from its parent tip — it cannot float)
    const gapA = next() * Math.PI * 2;
    const gapB = gapA + Math.PI * (0.55 + next() * 0.4);
    const breakupCount = quality === 'hero' ? v.breakup : 3;
    for (let i = 0; i < breakupCount; i++) {
      const parent = tips[(i + 1) % tips.length]!;
      const ang = next() * Math.PI * 2;
      // deliberate sky-gaps: two WIDE open sectors stay clump-free
      const inGap = Math.abs(((ang - gapA + Math.PI * 3) % (Math.PI * 2)) - Math.PI) > Math.PI - 0.65
        || Math.abs(((ang - gapB + Math.PI * 3) % (Math.PI * 2)) - Math.PI) > Math.PI - 0.65;
      if (inGap) continue;
      const rr = Math.min(1.05, 0.55 + next() * 0.8); // clamped to parent mass
      const below = i % 3 === 2 ? -0.75 - next() * 0.4 : 0.25 * (next() - 0.2); // staggered underside
      const p = parent.clone().add(new Vector3(Math.cos(ang) * rr, below, Math.sin(ang) * rr));
      const heightAboveTrunk = (p.y - trunkH) / 4;
      const color = heightAboveTrunk > 0.4 ? T.lit : heightAboveTrunk > 0 ? T.base : T.dark;
      parts.push({
        geom: blob(next, { radius: (0.62 + next() * 0.28) * thick, detail, color, jitter: 0.27, squashY: 0.75 }),
        matrix: mat.at(p.x, p.y, p.z),
      });
      anchors.push(p);
    }
  }

  // ---- story details (hero only) ----
  if (quality === 'hero') {
    // hollow knot: bulge ring + recessed dark core, clamped to surface
    const kBase = chain.at(0.22);
    const kR = chain.rings[Math.floor(0.22 * (chain.rings.length - 1))]!.radius;
    const kx = kBase.x + kR * 0.82, kz = kBase.z + kR * 0.35;
    parts.push({
      geom: blob(next, { radius: 0.52, detail: 0, color: P.barkOakDark, jitter: 0.2, squashY: 0.85 }),
      matrix: mat.at(kx * 0.92, kBase.y, kz * 0.92),
    });
    parts.push({
      geom: blob(next, { radius: 0.34, detail: 0, color: P.barkOakDeep, jitter: 0.2, squashY: 0.9 }),
      matrix: mat.at(kx, kBase.y, kz),
    });
    parts.push({
      geom: blob(next, { radius: 0.2, detail: 0, color: P.knotHole, jitter: 0.18 }),
      matrix: mat.at(kx * 1.06, kBase.y, kz * 1.06),
    });
    if (!isAutumn) {
      // broken bough: LOAD-BEARING limb (60–70% of trunk diameter), splintered
      const bBase = chain.at(0.55);
      const dir = new Vector3(0.8, 0.45, -0.35).normalize();
      const bTip = tipOf(bBase, dir, 2.1);
      parts.push({
        geom: growLimb(bBase, dir, 2.1, 0.3, 0.16, 6, {
          lit: P.barkOakLit, base: P.barkOak, dark: P.barkOakDark, deep: P.barkOakDark,
        }),
      });
      for (let s = 0; s < 4; s++) {
        const sa = next() * Math.PI * 2;
        const sDir = dir.clone().add(new Vector3(Math.cos(sa) * 0.45, 0.2, Math.sin(sa) * 0.45)).normalize();
        const sp = loft([
          { pos: bTip.clone(), radius: 0.11 },
          { pos: bTip.clone().addScaledVector(sDir, 0.3 + next() * 0.3), radius: 0.02 },
        ], 4);
        paint(sp, P.deadwood, 0.5);
        parts.push({ geom: sp });
      }
      anchors.push(bTip);
    }
  }
  return { parts, anchors };
}

export const oak: AssetModule = makeSpecies(OAK_META, oakTree);
