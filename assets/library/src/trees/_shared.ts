// ============================================================================
// Species scaffold — shared body wiring so every trees/*.ts is pure art.
// (Infrastructure for the trees/ workstream; not part of the frozen kit.)
// ============================================================================
import * as THREE from 'three';
import { finalize, triCountOf, type LoftRing, type Part } from '../kit/geometry';
import { rng } from '../kit/rng';
import { BUDGETS } from '../kit/budgets';
import type { AssetMeta, AssetModule, BuiltAsset, Quality } from '../types';

/** Non-undefined budget lookup — a species missing from budgets.ts fails loudly. */
export function budgetFor(id: string) {
  const b = BUDGETS[id];
  if (!b) throw new Error(`budgets.ts is missing '${id}'`);
  return b;
}

export interface SpeciesResult {
  readonly parts: readonly Part[];
  /** trunk joints + branch tips — the attachment spine every part hangs off */
  readonly anchors: readonly THREE.Vector3[];
}

export type SpeciesBuilder = (
  next: () => number,
  quality: Quality,
  variationId: string,
) => SpeciesResult;

/**
 * Grow a continuous trunk chain: walks a direction that wobbles per step,
 * producing ring positions (with taper + root flare) AND joint anchors.
 * Branch tips hang off joints — nothing floats.
 */
export interface ChainOpts {
  height: number;
  baseR: number;
  topR: number;
  leanRad: number; // initial tilt from vertical
  leanDirRad: number; // azimuth of the lean
  wobble: number; // per-step random tilt (rad)
  steps: number;
  flare?: number; // root flare multiplier (default 1.55)
}

export interface TrunkChain {
  rings: LoftRing[];
  joints: THREE.Vector3[]; // one per ring
  top: THREE.Vector3;
  dirTop: THREE.Vector3;
  /** position at height fraction t (0..1) along the chain, interpolated */
  at(t01: number): THREE.Vector3;
  dirAt(t01: number): THREE.Vector3;
}

export function growChain(next: () => number, opts: ChainOpts): TrunkChain {
  const flare = opts.flare ?? 1.55;
  const lean = new THREE.Vector3(
    Math.sin(opts.leanRad) * Math.cos(opts.leanDirRad),
    Math.cos(opts.leanRad),
    Math.sin(opts.leanRad) * Math.sin(opts.leanDirRad),
  ).normalize();
  const joints: THREE.Vector3[] = [new THREE.Vector3(0, 0, 0)];
  const rings: LoftRing[] = [];
  const dirs: THREE.Vector3[] = [lean.clone()];
  const stepLen = opts.height / opts.steps;
  for (let i = 0; i <= opts.steps; i++) {
    const t = i / opts.steps;
    // taper with a root flare over the bottom 10%
    const taper = opts.topR + (opts.baseR - opts.topR) * Math.pow(1 - t, 1.25);
    const r = t < 0.1 ? taper * (1 + (flare - 1) * (1 - t / 0.1)) : taper;
    const j = joints[i]!;
    rings.push({ pos: j.clone(), radius: Math.max(0.02, r) });
    if (i < opts.steps) {
      // wobble the direction — bounded so the chain stays coherent
      const wob = opts.wobble;
      const nx = dirs[i]!.x + (next() - 0.5) * wob;
      const ny = Math.max(0.75, dirs[i]!.y + (next() - 0.5) * wob * 0.5);
      const nz = dirs[i]!.z + (next() - 0.5) * wob;
      const d = new THREE.Vector3(nx, ny, nz).normalize();
      dirs.push(d);
      joints.push(j.clone().addScaledVector(d, stepLen));
    }
  }
  const jointsF = joints;
  const dirsF = dirs;
  return {
    rings,
    joints: jointsF,
    top: jointsF[jointsF.length - 1]!.clone(),
    dirTop: dirsF[dirsF.length - 1]!.clone(),
    at: (t01) => {
      const f = Math.min(1, Math.max(0, t01)) * (jointsF.length - 1);
      const i = Math.min(jointsF.length - 2, Math.floor(f));
      const frac = f - i;
      return jointsF[i]!.clone().lerp(jointsF[i + 1]!, frac);
    },
    dirAt: (t01) => {
      const i = Math.min(dirsF.length - 1, Math.round(Math.min(1, Math.max(0, t01)) * (dirsF.length - 1)));
      return dirsF[i]!.clone();
    },
  };
}

/** Point on a branch grown from a joint: base + dir * len (dir unit-ish). */
export function tipOf(base: THREE.Vector3, dir: THREE.Vector3, len: number): THREE.Vector3 {
  return base.clone().addScaledVector(dir.clone().normalize(), len);
}

export function makeSpecies(meta: AssetMeta, buildParts: SpeciesBuilder): AssetModule {
  function buildSeed(variationId: string, seed: number, quality: Quality): BuiltAsset {
    const { parts, anchors } = buildParts(rng(seed), quality, variationId);
    const { geom, mesh } = finalize(parts);
    geom.computeBoundingBox();
    const root = new THREE.Group();
    root.add(mesh);
    return {
      root, mesh,
      tris: triCountOf(geom),
      bbox: geom.boundingBox ?? new THREE.Box3(),
      anchors,
    };
  }
  return {
    meta,
    build: (quality) => {
      const v0 = meta.variations[0];
      if (!v0) throw new Error(`${meta.id}: no variations`);
      return buildSeed(v0.id, v0.seed, quality);
    },
    buildVariation: (variationId, quality) => {
      const v = meta.variations.find((x) => x.id === variationId);
      if (!v) throw new Error(`${meta.id}: unknown variation '${variationId}'`);
      return buildSeed(v.id, v.seed, quality);
    },
  };
}

/** Place blobs near anchors (attachment guaranteed) with organic jitter. */
export function scatterNear(
  next: () => number,
  count: number,
  anchors: readonly THREE.Vector3[],
  jitterR: number,
): THREE.Vector3[] {
  const out: THREE.Vector3[] = [];
  for (let i = 0; i < count; i++) {
    const a = anchors[i % anchors.length]!;
    out.push(new THREE.Vector3(
      a.x + (next() - 0.5) * 2 * jitterR,
      a.y + (next() - 0.5) * 2 * jitterR * 0.7,
      a.z + (next() - 0.5) * 2 * jitterR,
    ));
  }
  return out;
}
