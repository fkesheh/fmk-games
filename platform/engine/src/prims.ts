// ============================================================================
// PRIMITIVE FACTORIES — box/cyl/cone/sphere/mat + static baking (docs/
// PLATFORM.md §4.6). Same vocabulary as STRICKEN's visual.ts, palette-free:
// colors are CSS hex passed by games.
// Owner: P5_ENGINE — implement; spec shapes live in types.ts.
// ============================================================================

import * as THREE from 'three';
import type { BoxSpec, ConeSpec, CylSpec, MatSpec, SphereSpec } from './types.js';

/** Cached MeshStandardMaterial per recipe key — reuse across meshes. */
export function mat(spec: MatSpec): THREE.MeshStandardMaterial {
  void spec;
  throw new Error('P5_ENGINE: not implemented');
}

export function box(s: BoxSpec): THREE.Mesh {
  void s;
  throw new Error('P5_ENGINE: not implemented');
}

export function cyl(s: CylSpec): THREE.Mesh {
  void s;
  throw new Error('P5_ENGINE: not implemented');
}

export function sphere(s: SphereSpec): THREE.Mesh {
  void s;
  throw new Error('P5_ENGINE: not implemented');
}

export function cone(s: ConeSpec): THREE.Mesh {
  void s;
  throw new Error('P5_ENGINE: not implemented');
}

/**
 * Merge every MESH child of root into one BufferGeometry per material and
 * replace them with baked meshes (house rule: static geometry bakes).
 * Non-mesh children pass through untouched.
 */
export function bake(root: THREE.Object3D): void {
  void root;
}
