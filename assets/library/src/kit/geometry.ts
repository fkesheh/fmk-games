// ============================================================================
// FROZEN — shared geometry vocabulary. Every species builds exclusively from
// these helpers so five independent species read as one art-directed library.
// All parts are merged into ONE geometry (position/normal/color/aBend) that
// renders as a single mesh with the single ASSET_MATERIAL.
// ============================================================================
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { ASSET_MATERIAL } from './material';
import { TREE_PALETTE } from './palette';

export type Next = () => number; // seeded rng() instance

// ---- deterministic per-position jitter (keeps shared vertices welded) ----
function hash3(x: number, y: number, z: number): number {
  let h = (x * 374761393 + y * 668265263 + z * 2147483647) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export interface BlobOpts {
  radius: number;
  detail: 0 | 1 | 2; // icosa subdivision: ~20 / 80 / 320 faces
  color: string; // TREE_PALETTE key value
  jitter?: number; // 0..1 vertex displacement fraction — the "hand-made" look
  squashY?: number; // 1 = sphere; <1 = flattened mass
}

/** Faceted foliage mass — the canopy building block. Origin at centre. */
export function blob(next: Next, opts: BlobOpts): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(opts.radius, opts.detail);
  const pos = g.attributes.position as THREE.BufferAttribute;
  const j = opts.jitter ?? 0.18;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const h = hash3(x, y, z) - 0.5;
    const k = 1 + h * j * 2;
    pos.setXYZ(i, x * k, y * k * (opts.squashY ?? 0.82), z * k);
  }
  pos.needsUpdate = true;
  g.computeVertexNormals();
  paint(g, opts.color, 0.85 + next() * 0.15);
  return g;
}

export interface TaperOpts {
  bottomR: number;
  topR: number;
  height: number;
  sides: number; // 5..9 per house silhouette law (chunky, readable)
  color: string;
  deepBase?: boolean; // root-flare contact band in the species …Deep tone
  deepColor?: string;
}

/** Tapered trunk/branch segment. Origin at base centre, grows +Y. */
export function taperCylinder(opts: TaperOpts): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(
    opts.topR, opts.bottomR * (opts.deepBase ? 1.28 : 1.0), // root flare
    opts.height,
    opts.sides,
    3,
  );
  g.translate(0, opts.height / 2, 0);
  const col = new THREE.Color(opts.color);
  const deep = new THREE.Color(opts.deepColor ?? opts.color);
  const pos = g.attributes.position as THREE.BufferAttribute;
  const colors = new Float32Array(pos.count * 3);
  const bends = new Float32Array(pos.count);
  for (let i = 0; i < pos.count; i++) {
    const y01 = Math.min(1, Math.max(0, pos.getY(i) / opts.height));
    // deep contact band occupies the lowest 12% of the trunk
    const c = y01 < 0.12 && opts.deepBase ? deep : col;
    colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
    bends[i] = 0.08 + y01 * 0.3; // stiff wood: barely bends, more near top
  }
  setAttrs(g, colors, bends);
  return g;
}

export interface StripOpts {
  length: number;
  width: number;
  segs: number; // length subdivisions: 4..6
  arch: number; // tip droop in metres (positive = sag)
  color: string;
  taperWidth?: number; // fraction of width kept at tip (default 0.25)
}

/** Arched blade/frond strip. Origin at root, extends +Z, droops -Y at tip. */
export function strip(opts: StripOpts): THREE.BufferGeometry {
  const g = new THREE.PlaneGeometry(opts.length, opts.width, opts.segs, 1);
  g.rotateY(Math.PI / 2); // length along +Z, width along X
  g.translate(0, 0, opts.length / 2);
  const pos = g.attributes.position as THREE.BufferAttribute;
  const colors = new Float32Array(pos.count * 3);
  const bends = new Float32Array(pos.count);
  const c = new THREE.Color(opts.color);
  const taper = opts.taperWidth ?? 0.25;
  for (let i = 0; i < pos.count; i++) {
    const z = pos.getZ(i);
    const t = z / opts.length; // 0 root .. 1 tip
    pos.setX(i, pos.getX(i) * (1 - (1 - taper) * t)); // taper toward tip
    pos.setY(i, -opts.arch * t * t); // quadratic sag
    colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
    bends[i] = 0.55 + t * 0.45; // fronds are the most animated part
  }
  pos.needsUpdate = true;
  setAttrs(g, colors, bends);
  return g;
}

/** Small faceted ball (coconuts, knots). Origin at centre. */
export function nub(radius: number, color: string, deep = false): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(radius, 0);
  paint(g, color, 0.9);
  if (deep) {
    // darken the lower hemisphere — cheap grounded shading
    const pos = g.attributes.position as THREE.BufferAttribute;
    const col = g.attributes.color as THREE.BufferAttribute;
    const c = new THREE.Color(color).multiplyScalar(0.72);
    for (let i = 0; i < pos.count; i++) {
      if (pos.getY(i) < 0) col.setXYZ(i, c.r, c.g, c.b);
    }
  }
  return g;
}

// ---- attribute plumbing ----------------------------------------------------

export function paint(g: THREE.BufferGeometry, color: string, bend: number): void {
  const c = new THREE.Color(color);
  const pos = g.attributes.position as THREE.BufferAttribute;
  const colors = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
  }
  setAttrs(g, colors, new Float32Array(pos.count).fill(bend));
}

function setAttrs(g: THREE.BufferGeometry, colors: Float32Array, bends: Float32Array): void {
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  g.setAttribute('aBend', new THREE.BufferAttribute(bends, 1));
  g.deleteAttribute('uv');
}

export interface Part {
  geom: THREE.BufferGeometry;
  matrix?: THREE.Matrix4;
}

/** Merge parts (applying their matrices) into ONE renderable geometry. */
export function mergeAll(parts: readonly Part[]): THREE.BufferGeometry {
  const prepared = parts.map(({ geom, matrix }) => {
    // normalize: indexed (cylinder/cone/plane) and non-indexed (icosa) parts
    // cannot merge — flatten everything to non-indexed (flat-shaded anyway).
    const g0 = matrix ? geom.clone().applyMatrix4(matrix) : geom;
    const g = g0.index ? g0.toNonIndexed() : g0;
    g.deleteAttribute('uv');
    return g;
  });
  const merged = mergeGeometries(prepared, false);
  if (!merged) throw new Error('mergeAll: incompatible attributes across parts');
  return merged;
}

/** transform helpers (chain via multiply) */
export const mat = {
  at(x: number, y: number, z: number): THREE.Matrix4 {
    return new THREE.Matrix4().makeTranslation(x, y, z);
  },
  tilt(rx: number, ry: number, rz: number): THREE.Matrix4 {
    return new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rx, ry, rz));
  },
  scale(sx: number, sy = sx, sz = sx): THREE.Matrix4 {
    return new THREE.Matrix4().makeScale(sx, sy, sz);
  },
  compose(x: number, y: number, z: number, rx: number, ry: number, rz: number, s = 1): THREE.Matrix4 {
    return new THREE.Matrix4().compose(
      new THREE.Vector3(x, y, z),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)),
      new THREE.Vector3(s, s, s),
    );
  },
};

export function triCountOf(g: THREE.BufferGeometry): number {
  const index = g.getIndex();
  return index ? index.count / 3 : (g.attributes.position as THREE.BufferAttribute).count / 3;
}

/** Finalize a species: one merged geometry -> one mesh on the ONE material. */
export function finalize(parts: readonly Part[]): { geom: THREE.BufferGeometry; mesh: THREE.Mesh } {
  const geom = mergeAll(parts);
  const mesh = new THREE.Mesh(geom, ASSET_MATERIAL);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return { geom, mesh };
}

export { TREE_PALETTE };
