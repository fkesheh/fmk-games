// ============================================================================
// EQUIVALENCE GATE for the two-pass direct-write `bake()` in contract/visual.ts.
//
// `bake()` is a FROZEN CONTRACT function (VISUAL_UPGRADE.md): its signature,
// semantics and OUTPUT are fixed, and only its body was allowed to change for
// performance. The old body was:
//
//     geometry.clone().applyMatrix4(child.matrixWorld)   // per mesh
//     -> strip non-position/normal/uv attributes
//     -> mergeGeometries(geoms, false)                   // per material bucket
//
// The new body counts first, allocates the merged buffers once, and transforms
// each source vertex straight into its slot — mirroring THREE's
// `BufferAttribute.applyMatrix4` / `applyNormalMatrix` operation-for-operation
// so every float lands BIT-IDENTICAL. That claim is only worth anything if
// something checks it, so this file re-implements the OLD body as `reference()`
// and asserts the two agree exactly.
//
// WHY BIT-IDENTICAL AND NOT "CLOSE". Positions live in a `Float32Array` and
// feed `coplanar.test.ts`, whose whole subject is faces landing on exactly the
// same plane. A 1-ulp drift is precisely the kind of change that turns a
// deliberate 6 mm trim offset into a flicker, so "approximately equal" would
// gate nothing that matters here.
//
// COVERAGE, in the two places output can diverge:
//  1. the FAST path — every factory in the contract (box/cyl/cone/sphere), at
//     depth, under rotation, non-uniform scale and nested parent transforms,
//     with several meshes sharing each cached material so real multi-mesh
//     buckets are exercised; plus a bucket large enough to cross the 65 535
//     vertex line where `setIndex()` switches Uint16 -> Uint32, because the
//     index buffer TYPE is part of the output (it decides the GPU upload).
//  2. the FALLBACK path — buckets the fast path must DECLINE (unindexed,
//     normalised, or disagreeing on which attributes they carry) and hand to
//     `mergeGeometries`, which is what the old body always did.
// ============================================================================
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { describe, expect, it } from 'vitest';

import { PALETTE, bake, box, cone, cyl, mat, sphere } from '../contract/visual.js';

/** The pre-rewrite `bake()` body, verbatim in behaviour. */
function reference(root: THREE.Group): THREE.Group {
  root.updateMatrixWorld(true);
  const byMaterial = new Map<THREE.Material, THREE.BufferGeometry[]>();
  root.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    const g = child.geometry.clone().applyMatrix4(child.matrixWorld);
    for (const name of Object.keys(g.attributes)) {
      if (name !== 'position' && name !== 'normal' && name !== 'uv') g.deleteAttribute(name);
    }
    const arr = byMaterial.get(child.material as THREE.Material) ?? [];
    arr.push(g);
    byMaterial.set(child.material as THREE.Material, arr);
  });
  const out = new THREE.Group();
  for (const [material, geoms] of byMaterial) {
    const merged = mergeGeometries(geoms, false);
    if (!merged) continue;
    const mesh = new THREE.Mesh(merged, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    out.add(mesh);
  }
  return out;
}

/** Deterministic pseudo-random in [0,1) — no Math.random in a gate. */
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/** Everything about one baked mesh that the renderer can observe. */
interface MeshFingerprint {
  material: THREE.Material;
  castShadow: boolean;
  receiveShadow: boolean;
  attrs: Record<string, { itemSize: number; count: number; ctor: string; values: number[] }>;
  index: { count: number; ctor: string; values: number[] } | null;
}

function fingerprint(group: THREE.Group): MeshFingerprint[] {
  return group.children.map((child) => {
    const mesh = child as THREE.Mesh;
    const g = mesh.geometry;
    const attrs: MeshFingerprint['attrs'] = {};
    for (const name of Object.keys(g.attributes).sort()) {
      const a = g.attributes[name] as THREE.BufferAttribute;
      attrs[name] = {
        itemSize: a.itemSize,
        count: a.count,
        ctor: a.array.constructor.name,
        values: Array.from(a.array as ArrayLike<number>),
      };
    }
    const idx = g.getIndex();
    return {
      material: mesh.material as THREE.Material,
      castShadow: mesh.castShadow,
      receiveShadow: mesh.receiveShadow,
      attrs,
      index:
        idx === null
          ? null
          : {
              count: idx.count,
              ctor: idx.array.constructor.name,
              values: Array.from(idx.array as ArrayLike<number>),
            },
    };
  });
}

/**
 * Two structurally identical trees — `bake()` consumes one and the reference
 * consumes the other, so neither can be disturbed by the other's traversal.
 */
function twice(build: () => THREE.Group): [THREE.Group, THREE.Group] {
  return [build(), build()];
}

function expectIdentical(build: () => THREE.Group): void {
  const [a, b] = twice(build);
  const got = fingerprint(bake(a));
  const want = fingerprint(reference(b));
  expect(got.length).toBe(want.length);
  expect(got).toStrictEqual(want);
}

describe('bake() is output-identical to the pre-rewrite merge', () => {
  it('matches over every contract factory, nested and transformed', () => {
    expectIdentical(() => {
      const next = makeRng(0x5eed);
      const root = new THREE.Group();
      // four material buckets, each fed by several meshes of several shapes
      const hexes = [PALETTE.sand, PALETTE.steel, PALETTE.ink, PALETTE.paper];
      for (let i = 0; i < 48; i++) {
        const hex = hexes[i % hexes.length]!;
        const kind = i % 4;
        const m =
          kind === 0
            ? box(0.4 + next(), 0.4 + next(), 0.4 + next(), hex)
            : kind === 1
              ? cyl(0.1 + next(), 0.2 + next(), 0.5 + next(), 6 + (i % 5), hex)
              : kind === 2
                ? cone(0.3 + next(), 0.8 + next(), 5 + (i % 4), hex)
                : sphere(0.3 + next(), 6 + (i % 3), hex);
        // rotation on all three axes + non-uniform scale: exercises the full
        // 4x4 multiply AND a normal matrix that is not the rotation itself
        m.position.set(next() * 20 - 10, next() * 6, next() * 20 - 10);
        m.rotation.set(next() * Math.PI, next() * Math.PI, next() * Math.PI);
        m.scale.set(0.5 + next() * 2, 0.5 + next() * 2, 0.5 + next() * 2);
        // every third mesh hangs under its own transformed parent, so
        // matrixWorld is a real composition rather than a local matrix
        if (i % 3 === 0) {
          const pivot = new THREE.Group();
          pivot.position.set(next() * 8 - 4, next() * 3, next() * 8 - 4);
          pivot.rotation.y = next() * Math.PI;
          pivot.scale.setScalar(0.6 + next());
          pivot.add(m);
          root.add(pivot);
        } else {
          root.add(m);
        }
      }
      return root;
    });
  });

  it('matches across the Uint16 -> Uint32 index boundary', () => {
    // A sphere at seg 24 is 24 x 18 segments = 475 vertices; 160 of them clear
    // 65 535 and force setIndex() onto Uint32. The bucket below that count must
    // stay Uint16 — the fingerprint compares the array constructor, so a
    // regression to "always Uint32" fails here.
    for (const count of [8, 160]) {
      expectIdentical(() => {
        const root = new THREE.Group();
        const next = makeRng(0xc0ffee + count);
        for (let i = 0; i < count; i++) {
          const m = sphere(0.4, 24, PALETTE.sand);
          m.position.set(next() * 30, next() * 4, next() * 30);
          m.rotation.y = next();
          root.add(m);
        }
        return root;
      });
    }
  });

  it('matches on the buckets the fast path must decline', () => {
    // Unindexed, normalised, and attribute-set-mismatched geometry all fall
    // through to mergeGeometries — the same call the old body always made.
    const cases: Array<() => THREE.Group> = [
      // (a) unindexed
      () => {
        const root = new THREE.Group();
        const material = mat(PALETTE.steel);
        for (let i = 0; i < 3; i++) {
          const g = new THREE.BoxGeometry(1, 1, 1).toNonIndexed();
          const m = new THREE.Mesh(g, material);
          m.position.set(i, i * 0.5, -i);
          m.rotation.z = i * 0.3;
          root.add(m);
        }
        return root;
      },
      // (b) normalised (non-float) positions
      () => {
        const root = new THREE.Group();
        const material = mat(PALETTE.ink);
        for (let i = 0; i < 2; i++) {
          const g = new THREE.BufferGeometry();
          const pos = new THREE.BufferAttribute(new Int16Array([0, 0, 0, 32767, 0, 0, 0, 32767, 0]), 3, true);
          g.setAttribute('position', pos);
          g.setIndex([0, 1, 2]);
          const m = new THREE.Mesh(g, material);
          m.position.set(i * 2, 0, 0);
          root.add(m);
        }
        return root;
      },
      // (c) one mesh in the bucket carries no uv while the first one does
      () => {
        const root = new THREE.Group();
        const material = mat(PALETTE.paper);
        const withUv = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material);
        const bare = new THREE.BoxGeometry(1, 1, 1);
        bare.deleteAttribute('uv');
        const without = new THREE.Mesh(bare, material);
        without.position.x = 3;
        root.add(withUv, without);
        return root;
      },
    ];
    for (const build of cases) expectIdentical(build);
  });

  it('preserves the per-bucket mesh contract (one mesh per material, shadows on)', () => {
    const root = new THREE.Group();
    root.add(box(1, 1, 1, PALETTE.sand), box(2, 1, 1, PALETTE.sand), box(1, 2, 1, PALETTE.steel));
    const out = bake(root);
    expect(out.children).toHaveLength(2); // two distinct cached materials
    const mats = new Set(out.children.map((c) => (c as THREE.Mesh).material));
    expect(mats.size).toBe(2);
    for (const child of out.children) {
      expect(child.castShadow).toBe(true);
      expect(child.receiveShadow).toBe(true);
      // merged geometry keeps only the three baked attributes
      const g = (child as THREE.Mesh).geometry;
      expect(Object.keys(g.attributes).sort()).toStrictEqual(['normal', 'position', 'uv']);
      expect(g.getIndex()).not.toBeNull();
    }
  });
});
