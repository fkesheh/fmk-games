// ============================================================================
// FROZEN CONTRACT — the shared client visual vocabulary.
// EVERY mesh in the game is built through these factories and the frozen
// PALETTE. Raw `new THREE.Mesh*Material` / `new THREE.BoxGeometry` etc. in
// implementer code is a contract violation (fx shaders/points material for
// particles excepted where CONTRACT.md allows it).
// Material model (see STYLE_BIBLE.md): flat-shaded Lambert, no PBR, no env map.
// ============================================================================
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

export { PALETTE } from '@fps/shared';
export type { PaletteKey } from '@fps/shared';

// ---- cached material factory ------------------------------------------------
const matCache = new Map<string, THREE.MeshLambertMaterial>();

export interface MatOpts {
  emissive?: string; // emissive hex (fx only: muzzle, tracers, glow)
  transparent?: boolean;
  opacity?: number;
}

/** Shared, cached flat-shaded Lambert material. hex MUST come from PALETTE. */
export function mat(hex: string, opts: MatOpts = {}): THREE.MeshLambertMaterial {
  const key = `${hex}|${opts.emissive ?? ''}|${opts.transparent ? 1 : 0}|${opts.opacity ?? 1}`;
  let m = matCache.get(key);
  if (!m) {
    m = new THREE.MeshLambertMaterial({
      color: hex,
      emissive: opts.emissive ?? '#000000',
      transparent: opts.transparent ?? false,
      opacity: opts.opacity ?? 1,
      flatShading: true, // the STYLE_BIBLE flat-shaded look — do not remove
    });
    matCache.set(key, m);
  }
  return m;
}

// ---- mesh factories (origin at center, y-up) --------------------------------
export function box(w: number, h: number, d: number, hex: string, opts?: MatOpts): THREE.Mesh {
  return new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat(hex, opts));
}
export function cyl(rTop: number, rBottom: number, h: number, seg: number, hex: string, opts?: MatOpts): THREE.Mesh {
  return new THREE.Mesh(new THREE.CylinderGeometry(rTop, rBottom, h, seg), mat(hex, opts));
}
export function cone(r: number, h: number, seg: number, hex: string, opts?: MatOpts): THREE.Mesh {
  return new THREE.Mesh(new THREE.ConeGeometry(r, h, seg), mat(hex, opts));
}
export function sphere(r: number, seg: number, hex: string, opts?: MatOpts): THREE.Mesh {
  return new THREE.Mesh(new THREE.SphereGeometry(r, seg, Math.max(4, Math.floor(seg * 0.75))), mat(hex, opts));
}

/** Convenience: position a mesh and return it (chainable builder style). */
export function at<T extends THREE.Object3D>(obj: T, x: number, y: number, z: number): T {
  obj.position.set(x, y, z);
  return obj;
}

// ---- bake helper -------------------------------------------------------------
/**
 * Merge all Mesh descendants of `root` into one mesh per material, preserving
 * world transforms. Use for EVERY static structure (map geometry, props) to
 * keep draw calls flat. Dynamic/animated parts must NOT be baked — keep them
 * as separate pivots and animate their transforms.
 */
export function bake(root: THREE.Group): THREE.Group {
  root.updateMatrixWorld(true);
  const byMaterial = new Map<THREE.Material, THREE.BufferGeometry[]>();
  root.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    const g = child.geometry.clone().applyMatrix4(child.matrixWorld);
    // strip attributes that differ across primitives so merge succeeds
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
