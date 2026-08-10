// ============================================================================
// SKI SPLAT — CLIENT VISUAL VOCABULARY (frozen, CONTRACT §1/§7 R1). The ONE
// way client code builds meshes: cached flat-shaded Lambert materials keyed by
// palette hex, box/cyl/cone/sphere factories, the `at` placement helper, and
// bake() to merge static groups into one mesh per material. Pattern cloned
// from games/kart/client/src/trackMesh.ts (§2.5: all colours from SPAL —
// an ad-hoc hex passed to `mat` is a contract violation).
//
// Also owns the frozen SUN RIG direction: terrain vertex shading
// (render/terrain.ts) and the directional light (render/scene.ts) read the
// same SUN_DIR so the painted snow shading and the real shadows always agree.
// ============================================================================
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { SPAL } from '@splat/shared';

export { SPAL };

/** Material factory seam — hex MUST be a SPAL entry (or a mix of two). */
export type MatFn = (hex: string) => THREE.MeshLambertMaterial;

// ---- cached material factory (the kart render.ts pattern) --------------------
// One bucket per hex for the WHOLE client, so baked statics sharing a colour
// merge into one draw call. Keyed by hex only — it must never grow parameters
// that would fork the cache key (vertex-coloured geometries get their own
// explicit materials in terrain.ts/plants.ts, not a second path through here).
const matCache = new Map<string, THREE.MeshLambertMaterial>();

export const mat: MatFn = (hex: string): THREE.MeshLambertMaterial => {
  let m = matCache.get(hex);
  if (!m) {
    m = new THREE.MeshLambertMaterial({
      color: hex,
      flatShading: true, // the flat-shaded look — do not remove
    });
    matCache.set(hex, m);
  }
  return m;
};

// ---- mesh factories (origin at center, y-up) -----------------------------------
export function box(matFn: MatFn, w: number, h: number, d: number, hex: string): THREE.Mesh {
  return new THREE.Mesh(new THREE.BoxGeometry(w, h, d), matFn(hex));
}

export function cyl(matFn: MatFn, rTop: number, rBottom: number, h: number, seg: number, hex: string): THREE.Mesh {
  return new THREE.Mesh(new THREE.CylinderGeometry(rTop, rBottom, h, seg), matFn(hex));
}

export function cone(matFn: MatFn, r: number, h: number, seg: number, hex: string): THREE.Mesh {
  return new THREE.Mesh(new THREE.ConeGeometry(r, h, seg), matFn(hex));
}

export function sphere(matFn: MatFn, r: number, seg: number, hex: string): THREE.Mesh {
  return new THREE.Mesh(
    new THREE.SphereGeometry(r, seg, Math.max(4, Math.floor(seg * 0.75))),
    matFn(hex),
  );
}

/** Convenience: position an object and return it (chainable builder style). */
export function at<T extends THREE.Object3D>(obj: T, x: number, y: number, z: number): T {
  obj.position.set(x, y, z);
  return obj;
}

/**
 * Merge all Mesh descendants of `root` into one mesh per material, preserving
 * world transforms. Used for EVERY static structure (gates, lodge, rocks,
 * forest prototypes) to keep draw calls flat — per-material cached materials
 * mean all same-colour props collapse into a single draw. Source geometries
 * are never uploaded (the source root is never added to the scene), so there
 * is nothing GPU-side to dispose for them; callers dispose the BAKED meshes'
 * geometries on rebuild (scene.ts disposeGeometries).
 */
export function bake(root: THREE.Group): THREE.Group {
  root.updateMatrixWorld(true);
  const byMaterial = new Map<THREE.Material, THREE.BufferGeometry[]>();
  root.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    const g = child.geometry.clone().applyMatrix4(child.matrixWorld);
    const arr = byMaterial.get(child.material as THREE.Material);
    if (arr) arr.push(g);
    else byMaterial.set(child.material as THREE.Material, [g]);
  });
  const out = new THREE.Group();
  for (const [material, geoms] of byMaterial) {
    const first = geoms[0];
    if (first === undefined) continue;
    const merged = geoms.length === 1 ? first : mergeGeometries(geoms, false);
    if (merged === null) {
      for (const g of geoms) g.dispose();
      continue;
    }
    if (merged !== first) for (const g of geoms) g.dispose();
    const mesh = new THREE.Mesh(merged, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    out.add(mesh);
  }
  return out;
}

// ---- the sun rig (ONE direction, read by light + terrain shading + sky) -------
// Low MORNING sun, behind and to the skier's right at the gate, so long soft
// shadows rake forward-left across the piste (STYLE_BIBLE lighting recipe).
export const SUN_ELEV = 0.24; // rad (~14°) — low morning angle
export const SUN_AZ = 2.2; // rad; yaw-convention azimuth of the visible sun

/** Unit vector TOWARD the sun, derived once from SUN_ELEV/SUN_AZ. */
export const SUN_DIR: readonly [number, number, number] = ((): [number, number, number] => {
  const ce = Math.cos(SUN_ELEV);
  return [Math.sin(SUN_AZ) * ce, Math.sin(SUN_ELEV), Math.cos(SUN_AZ) * ce];
})();
