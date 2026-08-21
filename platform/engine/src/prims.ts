// ============================================================================
// PRIMITIVE FACTORIES — box/cyl/cone/sphere/mat + static baking (docs/
// PLATFORM.md §4.6). Same vocabulary as STRICKEN's visual.ts, palette-free:
// colors are CSS hex passed by games.
// Owner: P5_ENGINE — implement; spec shapes live in types.ts.
//
// Geometry buffers are cached by dimensions (a 100 crates map builds ONE box
// geometry) and materials are cached by recipe key, so factory calls are cheap
// and draw-call reduction comes free. bake() merges every mesh under a root
// into one BufferGeometry per material via three's mergeGeometries — the house
// rule: static geometry bakes, dynamic pivots stay separate.
// ============================================================================

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { BoxSpec, ConeSpec, CylSpec, MatSpec, SphereSpec } from './types.js';

// Fixed tessellation: plenty for props/world blocks, one shared cache entry.
const CYL_SEGMENTS = 20;
const CONE_SEGMENTS = 20;
const SPHERE_WIDTH_SEGMENTS = 24;
const SPHERE_HEIGHT_SEGMENTS = 16;

// ---- caches ------------------------------------------------------------------

const geoCache = new Map<string, THREE.BufferGeometry>();
const matCache = new Map<string, THREE.MeshStandardMaterial>();

/** Canonical dims key for the geometry cache. */
function dimsKey(...dims: readonly number[]): string {
  let k = '';
  for (const d of dims) k += `${d},`;
  return k;
}

function cachedGeometry(key: string, build: () => THREE.BufferGeometry): THREE.BufferGeometry {
  const hit = geoCache.get(key);
  if (hit !== undefined) return hit;
  const geo = build();
  geoCache.set(key, geo);
  return geo;
}

// ---- factories ---------------------------------------------------------------

/** Cached MeshStandardMaterial per recipe key — reuse across meshes. */
export function mat(spec: MatSpec): THREE.MeshStandardMaterial {
  const roughness = spec.roughness ?? 0.9;
  const emissive = spec.emissive ?? 0;
  // Canonical key, not JSON.stringify: field order must not fork the cache.
  const key = `${spec.color}|${roughness}|${emissive}`;
  const hit = matCache.get(key);
  if (hit !== undefined) return hit;

  const m = new THREE.MeshStandardMaterial({ color: spec.color, roughness });
  if (emissive > 0) {
    m.emissive.copy(m.color).multiplyScalar(emissive); // glow tinted by base color
  }
  matCache.set(key, m);
  return m;
}

function positioned(mesh: THREE.Mesh, x: number, y: number, z: number, yaw?: number): THREE.Mesh {
  mesh.position.set(x, y, z);
  if (yaw !== undefined) mesh.rotation.y = yaw;
  return mesh;
}

export function box(s: BoxSpec): THREE.Mesh {
  const geo = cachedGeometry(`box|${s.w}|${s.h}|${s.d}`, () => new THREE.BoxGeometry(s.w, s.h, s.d));
  return positioned(new THREE.Mesh(geo, mat(s.mat)), s.x, s.y, s.z, s.yaw);
}

export function cyl(s: CylSpec): THREE.Mesh {
  const geo = cachedGeometry(
    `cyl|${s.rTop}|${s.rBot}|${s.h}`,
    () => new THREE.CylinderGeometry(s.rTop, s.rBot, s.h, CYL_SEGMENTS),
  );
  return positioned(new THREE.Mesh(geo, mat(s.mat)), s.x, s.y, s.z, s.yaw);
}

export function sphere(s: SphereSpec): THREE.Mesh {
  const geo = cachedGeometry(
    `sphere|${s.r}`,
    () => new THREE.SphereGeometry(s.r, SPHERE_WIDTH_SEGMENTS, SPHERE_HEIGHT_SEGMENTS),
  );
  return positioned(new THREE.Mesh(geo, mat(s.mat)), s.x, s.y, s.z);
}

export function cone(s: ConeSpec): THREE.Mesh {
  const geo = cachedGeometry(
    `cone|${s.r}|${s.h}`,
    () => new THREE.ConeGeometry(s.r, s.h, CONE_SEGMENTS),
  );
  return positioned(new THREE.Mesh(geo, mat(s.mat)), s.x, s.y, s.z);
}

// ---- bake --------------------------------------------------------------------

/** The only attributes a baked static carries; anything else is dropped so
 *  mergeGeometries never sees mismatched attribute sets across sources. */
const BAKE_ATTRS = ['position', 'normal', 'uv'] as const;

/**
 * Merge every MESH descendant of root into one BufferGeometry per material and
 * replace them with baked meshes parented to root (house rule: static
 * geometry bakes). Non-mesh children pass through untouched; source geometries
 * are disposed once merged. Materials come from the shared mat() cache and are
 * NOT disposed here.
 */
export function bake(root: THREE.Object3D): void {
  root.updateMatrixWorld(true);

  const buckets = new Map<THREE.Material, THREE.Mesh[]>();
  const meshes: THREE.Mesh[] = [];
  root.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    meshes.push(child);
    const material = child.material as THREE.Material;
    const bucket = buckets.get(material);
    if (bucket !== undefined) bucket.push(child);
    else buckets.set(material, [child]);
  });
  if (meshes.length === 0) return;

  for (const [material, bucket] of buckets) {
    const merged = mergeBucket(bucket);
    if (merged === null) continue; // nothing mergeable in this bucket — skip it
    const baked = new THREE.Mesh(merged, material);
    baked.castShadow = true;
    baked.receiveShadow = true;
    root.add(baked);
  }

  for (const m of meshes) m.removeFromParent(); // after merging: world matrices captured
}

/**
 * One material bucket -> merged world-space geometry, or null when nothing in
 * the bucket is mergeable (no position attribute). Exotic attributes are
 * stripped first so all sources agree on position/normal/uv.
 */
function mergeBucket(bucket: readonly THREE.Mesh[]): THREE.BufferGeometry | null {
  const geoms: THREE.BufferGeometry[] = [];
  for (const mesh of bucket) {
    if (mesh.geometry.getAttribute('position') === undefined) continue;
    const g = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
    for (const name of Object.keys(g.attributes)) {
      if (!(BAKE_ATTRS as readonly string[]).includes(name)) g.deleteAttribute(name);
    }
    geoms.push(g);
  }
  if (geoms.length === 0) return null;
  if (geoms.length === 1) return geoms[0]!;

  const merged = mergeGeometries(geoms, false);
  for (const g of geoms) g.dispose(); // sources consumed; keep only the merged buffer
  return merged;
}

// ---- test seam ---------------------------------------------------------------

/** Test-only: current cache sizes ([geometries, materials]). */
export function cacheSizes(): readonly [number, number] {
  return [geoCache.size, matCache.size];
}
