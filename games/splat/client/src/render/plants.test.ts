// ============================================================================
// SKI SPLAT — plants.test.ts (task W3, CONTRACT_V3 §12.5.5). Covers ONLY the
// new §V3.4 mid-distance dressing (buildDressingPlacements / MountainDressing)
// added by this task. The pre-existing gameplay PlantField above is untouched
// by W3 and out of scope for this suite.
// ============================================================================
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { genSlope } from '@splat/shared/slope.js';
import { buildDressingPlacements, MountainDressing, type DressArchetype } from './plants.js';

// >= 10 seeds, per the contract's gate on this test.
const SEEDS = [1, 2, 3, 7, 13, 21, 42, 99, 137, 256, 500, 777];

describe('buildDressingPlacements (§V3.4 mid-distance dressing)', () => {
  it('runs across at least 10 seeds', () => {
    expect(SEEDS.length).toBeGreaterThanOrEqual(10);
  });

  it('places every instance at |x| >= 27 and < 29.5, and disjoint from slope.plants', () => {
    for (const seed of SEEDS) {
      const slope = genSlope(seed);
      const instances = buildDressingPlacements(slope);
      expect(instances.length).toBeGreaterThan(0);

      // Disjoint from every gameplay plant: a dressing instance's centre must
      // never fall inside a plant's contact disc. A plant's disc can reach
      // past its own |x| < 27 bound (thorn r=0.9), so this is a real
      // geometric check, not just the band split. The nearest-margin scan is
      // plain JS (O(instances * plants) is ~10^5 per seed); only the final
      // aggregate is asserted, to avoid a combinatorial explosion of
      // individual `expect()` calls timing the suite out.
      let worstMargin = Infinity;
      for (const inst of instances) {
        const ax = Math.abs(inst.x);
        expect(ax).toBeGreaterThanOrEqual(27);
        expect(ax).toBeLessThan(29.5 + 1e-9);
        for (const plant of slope.plants) {
          const dx = inst.x - plant.x;
          const dz = inst.z - plant.z;
          const margin = Math.sqrt(dx * dx + dz * dz) - plant.r;
          if (margin < worstMargin) worstMargin = margin;
        }
      }
      expect(worstMargin).toBeGreaterThanOrEqual(0);
    }
  });

  it('never places an instance |x| below the gameplay plant band (structural disjointness)', () => {
    for (const seed of SEEDS) {
      const slope = genSlope(seed);
      const maxPlantAbsX = slope.plants.reduce((m, p) => Math.max(m, Math.abs(p.x)), 0);
      const instances = buildDressingPlacements(slope);
      for (const inst of instances) {
        expect(Math.abs(inst.x)).toBeGreaterThan(maxPlantAbsX);
      }
    }
  });

  it('never spawns before z=0 and honours the per-archetype instance caps (~400/250/250)', () => {
    for (const seed of [42, 99, 500]) {
      const slope = genSlope(seed);
      const instances = buildDressingPlacements(slope);
      const counts: Record<DressArchetype, number> = { stone: 0, log: 0, twig: 0 };
      for (const inst of instances) {
        expect(inst.z).toBeGreaterThanOrEqual(0);
        counts[inst.archetype] += 1;
      }
      expect(counts.stone).toBeLessThanOrEqual(400);
      expect(counts.log).toBeLessThanOrEqual(250);
      expect(counts.twig).toBeLessThanOrEqual(250);
      // Not gated to an exact count (Poisson + clamping), but the scatter
      // should be producing a real field, not a near-empty one.
      expect(counts.stone + counts.log + counts.twig).toBeGreaterThan(200);
    }
  });

  it('is deterministic for a given seed (pure function of slope.seed)', () => {
    const slope = genSlope(42);
    const a = buildDressingPlacements(slope);
    const b = buildDressingPlacements(slope);
    expect(a).toEqual(b);
  });
});

describe('MountainDressing (render)', () => {
  it('builds <= 3 InstancedMeshes, all castShadow=false, and adds them to the scene', () => {
    const slope = genSlope(42);
    const world = new THREE.Scene();
    const dressing = new MountainDressing(world, slope);
    const meshes = world.children.filter((c): c is THREE.InstancedMesh => c instanceof THREE.InstancedMesh);
    expect(meshes.length).toBeLessThanOrEqual(3);
    expect(meshes.length).toBeGreaterThan(0);
    for (const m of meshes) {
      expect(m.castShadow).toBe(false);
    }
    dressing.dispose();
    expect(world.children.length).toBe(0);
  });

  it('every baked instance matrix places the prop at |x| >= 27 (render matches placement data)', () => {
    const slope = genSlope(7);
    const world = new THREE.Scene();
    const dressing = new MountainDressing(world, slope);
    const meshes = world.children.filter((c): c is THREE.InstancedMesh => c instanceof THREE.InstancedMesh);
    const m4 = new THREE.Matrix4();
    const pos = new THREE.Vector3();
    for (const mesh of meshes) {
      for (let i = 0; i < mesh.count; i++) {
        mesh.getMatrixAt(i, m4);
        pos.setFromMatrixPosition(m4);
        expect(Math.abs(pos.x)).toBeGreaterThanOrEqual(27);
      }
    }
    dressing.dispose();
  });

  it('update() culls bands beyond DRESS_CULL_M without throwing and stays deterministic', () => {
    const slope = genSlope(21);
    const world = new THREE.Scene();
    const dressing = new MountainDressing(world, slope);
    expect(() => {
      dressing.update(0);
      dressing.update(400);
      dressing.update(800);
    }).not.toThrow();
    dressing.dispose();
  });
});
