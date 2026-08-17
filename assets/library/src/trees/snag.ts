// ============================================================================
// SNAG — dead tree. Model sheet: welded kinked trunk in bleached silver
// tiers with vertical cracks, splintered jagged top (4–7 spikes), thick
// tapered broken stubs, recessed woodpecker hole, optional char split.
// ============================================================================
import { BufferGeometry, Float32BufferAttribute, Vector3 } from 'three';
import { growLimb, loft, mat, nub, paint, paintBands, paintTrunkTiers, type Next, type Part } from '../kit/geometry';
import { TREE_PALETTE as P } from '../kit/palette';
import type { AssetMeta, AssetModule, Quality } from '../types';
import { budgetFor, growChain, makeSpecies, tipOf, type SpeciesResult } from './_shared';

export const SNAG_META: AssetMeta = {
  id: 'snag',
  category: 'tree',
  name: 'Dead Snag',
  description:
    'A standing dead tree — bleached silver, jagged splintered top, full of angles; the shape a raven picks.',
  variations: [
    { id: 'classic', label: 'Classic', seed: 0xdead0001, notes: 'splintered top, woodpecker hole' },
    { id: 'lightning', label: 'Lightning', seed: 0xdead0002, notes: 'split charred top' },
    { id: 'weathered', label: 'Weathered', seed: 0xdead0003, notes: 'paler silver, moss at base' },
  ],
  motion: 'wind',
  triBudget: budgetFor('snag'),
  heightRange: budgetFor('snag').height,
};

/** Splinter spike: thin 3-sided spike from a rim point, jagged by design. */
function splinter(base: Vector3, dir: Vector3, len: number, r: number): BufferGeometry {
  const g = loft([
    { pos: base.clone(), radius: r },
    { pos: base.clone().addScaledVector(dir, len), radius: 0.025 },
  ], 3);
  return g;
}

function snagTree(next: Next, quality: Quality, variationId: string): SpeciesResult {
  const lightning = variationId === 'lightning';
  const weathered = variationId === 'weathered';
  const parts: Part[] = [];
  const anchors: Vector3[] = [];

  const height = 7.5 + next() * (weathered ? 1.2 : 2.2);
  const sides = quality === 'hero' ? 7 : 5;

  // ---- welded kinked trunk: strong bounded wobbles, big lean on lightning ----
  const chain = growChain(next, {
    height,
    baseR: 0.42, topR: 0.16,
    leanRad: lightning ? 0.2 : 0.1 + next() * 0.1,
    leanDirRad: next() * Math.PI * 2,
    wobble: 0.22, steps: quality === 'micro' ? 4 : 12, flare: 1.5,
  });
  const trunk = loft(chain.rings, sides);
  paintTrunkTiers(trunk, height, {
    lit: weathered ? P.deadwoodPale : P.deadwoodLit,
    base: weathered ? P.deadwoodLit : P.deadwood,
    dark: P.deadwoodDark,
    deep: P.deadwoodDeep,
  }, 0.1);
  // vertical weathered streaks: pale silver bands running up the trunk
  const streaks: { y01: number; h01: number; color: string }[] = [];
  for (let i = 0; i < (quality === 'hero' ? 5 : 2); i++) {
    const y0 = 0.12 + next() * 0.5;
    streaks.push({ y01: y0, h01: 0.14 + next() * 0.2, color: weathered ? P.deadwoodPale : P.deadwoodLit });
  }
  paintBands(trunk, height, streaks);
  // vertical cracks: darker faces near the top third (lightning char) or
  // scattered (weathered) — painted as thin loft ribs along the trunk
  const crackCount = quality === 'hero' ? 3 : 1;
  for (let i = 0; i < crackCount; i++) {
    const t0 = 0.25 + next() * 0.5;
    const a = next() * Math.PI * 2;
    const r = chain.rings[Math.floor(t0 * (chain.rings.length - 1))]!.radius;
    const base = chain.at(t0);
    const dirV = chain.dirAt(t0).multiplyScalar(0.9).add(
      new Vector3(Math.cos(a) * 0.45, 0, Math.sin(a) * 0.45),
    ).normalize();
    const len = height * (0.16 + next() * 0.12);
    const g = loft([
      { pos: base.clone().add(new Vector3(Math.cos(a) * r * 0.92, 0, Math.sin(a) * r * 0.92)), radius: 0.035 },
      { pos: base.clone().add(new Vector3(Math.cos(a) * r * 0.92, 0, Math.sin(a) * r * 0.92)).addScaledVector(dirV, len), radius: 0.022 },
    ], 3);
    paint(g, lightning ? P.knotHole : P.deadwoodDeep, 0.4);
    parts.push({ geom: g });
    anchors.push(tipOf(base, dirV, len + 0.4));
  }
  parts.push({ geom: trunk });
  anchors.push(...chain.joints);

  // ---- splintered top: 4–7 spikes, tallest on one side — never a saw cut ----
  if (quality !== 'micro') {
    const spikeCount = lightning ? 5 + Math.floor(next() * 3) : 4 + Math.floor(next() * 3);
    const tallSide = next() * Math.PI * 2;
    for (let i = 0; i < spikeCount; i++) {
      const a = tallSide + (i / spikeCount) * Math.PI * 2 + (next() - 0.5) * 0.5;
      const near = 1 - Math.min(1, Math.abs(((a - tallSide + Math.PI * 3) % (Math.PI * 2)) - Math.PI) / Math.PI);
      const len = 0.4 + near * 1.1 + next() * 0.35;
      const baseR = chain.rings[chain.rings.length - 1]!.radius;
      const base = chain.top.clone().add(new Vector3(Math.cos(a) * baseR * 0.6, 0, Math.sin(a) * baseR * 0.6));
      const dirV = new Vector3(Math.cos(a) * 0.35, 1, Math.sin(a) * 0.35).normalize();
      const sp = splinter(base, dirV, len, 0.09);
      paint(sp, lightning && near > 0.7 ? P.knotHole : P.deadwood, 0.55);
      parts.push({ geom: sp });
      anchors.push(tipOf(base, dirV, len));
    }
  }

  // ---- broken branch stubs: THICK tapered limbs at expressive angles,
  // terminated in 2–3 splinter spikes — never a sphere cap ----
  const stubCount = quality === 'hero' ? 4 + Math.floor(next() * 3) : quality === 'lod' ? 3 : 1;
  for (let i = 0; i < stubCount; i++) {
    const t01 = 0.3 + next() * 0.55;
    const base = chain.at(t01);
    const az = (i / stubCount) * Math.PI * 2 + next() * 1.2;
    // vary: one drooping, one snapped back, others out — expressive angles
    const pitch = i === 0 ? 1.35 : i === 1 ? 0.5 : 0.8 + next() * 0.5;
    const dirV = new Vector3(
      Math.sin(pitch) * Math.cos(az), Math.cos(pitch), Math.sin(pitch) * Math.sin(az),
    );
    const len = 1.5 + next() * 1.1;
    const tip = tipOf(base, dirV, len);
    const tiers = {
      lit: P.deadwoodLit, base: P.deadwood, dark: P.deadwoodDark, deep: P.deadwoodDeep,
    };
    parts.push({ geom: growLimb(base, dirV, len, 0.24, 0.1, quality === 'hero' ? 6 : 5, tiers) });
    // splintered jagged end: 2–3 unequal spikes at the snap face
    if (quality === 'hero') {
      for (let s = 0; s < 2 + Math.floor(next() * 2); s++) {
        const sa = next() * Math.PI * 2;
        const sDir = dirV.clone().add(new Vector3(
          Math.cos(sa) * 0.5, 0.15 + next() * 0.2, Math.sin(sa) * 0.5,
        )).normalize();
        const sp = splinter(tip, sDir, 0.3 + next() * 0.4, 0.08);
        paint(sp, s % 2 ? P.deadwoodLit : P.deadwood, 0.5);
        parts.push({ geom: sp });
        anchors.push(tipOf(tip, sDir, 0.7));
      }
    }
    anchors.push(tip);
  }

  // ---- story details ----
  if (quality === 'hero') {
    // woodpecker hole: irregular recessed opening at eye height, ~2.5x bigger
    const hBase = chain.at(0.34);
    const a = next() * Math.PI * 2;
    const r = chain.rings[Math.floor(0.34 * (chain.rings.length - 1))]!.radius;
    const hx = hBase.x + Math.cos(a) * r * 0.95;
    const hz = hBase.z + Math.sin(a) * r * 0.95;
    parts.push({
      geom: nub(0.26, P.deadwoodLit), // chewed lighter rim
      matrix: mat.at(hx, hBase.y, hz).multiply(mat.scale(1, 1.25, 0.5)),
    });
    parts.push({
      geom: nub(0.17, P.knotHole), // dark recessed core
      matrix: mat.at(hx * 1.02, hBase.y, hz * 1.02).multiply(mat.scale(1, 1.2, 0.45)),
    });
    if (weathered) {
      for (let i = 0; i < 3; i++) {
        const ma = next() * Math.PI * 2;
        parts.push({
          geom: nub(0.3 + next() * 0.12, P.moss),
          matrix: mat.at(Math.cos(ma) * 0.36, 0.22 + next() * 0.35, Math.sin(ma) * 0.36)
            .multiply(mat.scale(1, 0.5, 1)),
        });
      }
    }
  }
  return { parts, anchors };
}

export const snag: AssetModule = makeSpecies(SNAG_META, snagTree);
