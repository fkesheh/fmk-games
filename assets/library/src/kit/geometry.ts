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

// ---- lofted trunks: ONE welded mesh, no stacked-segment seams ---------------

export interface LoftRing {
  pos: THREE.Vector3; // world-space ring centre
  radius: number;
}

/**
 * Welded tube lofted through ring centres. This is THE trunk builder —
 * stacked CylinderGeometry segments (the round-1 bug) are forbidden: they
 * dislocate at joints and read as stacked prisms. Ring basis is the fixed
 * horizontal pair (X, Z) — trunks curve gently, so rings stay near-level.
 */
export function loft(rings: readonly LoftRing[], sides: number): THREE.BufferGeometry {
  if (rings.length < 2) throw new Error('loft: need >= 2 rings');
  const positions: number[] = [];
  const indices: number[] = [];
  for (const ring of rings) {
    for (let i = 0; i < sides; i++) {
      const t = (i / sides) * Math.PI * 2;
      const v = new THREE.Vector3(
        ring.pos.x + Math.cos(t) * ring.radius,
        ring.pos.y,
        ring.pos.z + Math.sin(t) * ring.radius,
      );
      positions.push(v.x, v.y, v.z);
    }
  }
  for (let r = 0; r < rings.length - 1; r++) {
    for (let i = 0; i < sides; i++) {
      const j = (i + 1) % sides;
      const a = r * sides + i, b2 = r * sides + j;
      const c = (r + 1) * sides + i, d = (r + 1) * sides + j;
      indices.push(a, c, b2, b2, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setIndex(indices);
  g.computeVertexNormals();
  g.deleteAttribute('uv');
  // neutral paint (callers overwrite with tier painting)
  paint(g, '#ffffff', 0.1);
  return g;
}

const TRUNK_SUN = new THREE.Vector3(0.55, 0.35, 0.4).normalize();

/**
 * Lofted branch/limb from base along dir — welded single mesh with tier
 * painting. Boughs grow with this; stacked cylinders are forbidden.
 */
export function growLimb(
  base: THREE.Vector3, dir: THREE.Vector3, len: number,
  baseR: number, tipR: number, sides: number, tiers: TrunkTiers,
): THREE.BufferGeometry {
  const d = dir.clone().normalize();
  const rings: LoftRing[] = [
    { pos: base.clone(), radius: baseR },
    { pos: base.clone().addScaledVector(d, len * 0.5), radius: (baseR + tipR) / 2 },
    { pos: base.clone().addScaledVector(d, len), radius: tipR },
  ];
  const g = loft(rings, sides);
  paintTrunkTiers(g, len, tiers, 0); // no deep band on limbs
  return g;
}

export interface TrunkTiers {
  lit: string; base: string; dark: string; deep: string;
}

/**
 * Author the trunk's value ladder per FACE: sun faces lit, shade faces dark,
 * contact band deep. This is the Firewatch read — discrete tiers, never a
 * smooth gradient. Height 0..1 for the band cutoff (default lowest 14%).
 */
export function paintTrunkTiers(
  g: THREE.BufferGeometry,
  height: number,
  tiers: TrunkTiers,
  deepCutoff = 0.14,
): void {
  const nonIndexed = g.index ? g.toNonIndexed() : g;
  const p2 = nonIndexed.getAttribute('position');
  const n2 = nonIndexed.getAttribute('normal');
  const colors = new Float32Array(p2.count * 3);
  const bends = new Float32Array(p2.count);
  const lit = new THREE.Color(tiers.lit), base = new THREE.Color(tiers.base);
  const dark = new THREE.Color(tiers.dark), deep = new THREE.Color(tiers.deep);
  for (let f = 0; f < p2.count / 3; f++) {
    const i0 = f * 3;
    const ny = (n2.getY(i0) + n2.getY(i0 + 1) + n2.getY(i0 + 2)) / 3;
    const nx = (n2.getX(i0) + n2.getX(i0 + 1) + n2.getX(i0 + 2)) / 3;
    const nz = (n2.getZ(i0) + n2.getZ(i0 + 1) + n2.getZ(i0 + 2)) / 3;
    const dot = nx * TRUNK_SUN.x + ny * TRUNK_SUN.y + nz * TRUNK_SUN.z;
    const yAvg = (p2.getY(i0) + p2.getY(i0 + 1) + p2.getY(i0 + 2)) / 3;
    // deep contact tier only on the SHADE side — a full horizontal ring
    // flips value at one height and reads as a material seam (round-3 bug)
    const inDeepBand = yAvg < height * deepCutoff && dot < 0.1;
    const c = inDeepBand ? deep : dot > 0.35 ? lit : dot > -0.05 ? base : dark;
    for (let k = 0; k < 3; k++) {
      colors[(i0 + k) * 3] = c.r;
      colors[(i0 + k) * 3 + 1] = c.g;
      colors[(i0 + k) * 3 + 2] = c.b;
      bends[i0 + k] = 0.06 + Math.min(1, Math.max(0, yAvg / height)) * 0.3;
    }
  }
  nonIndexed.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  nonIndexed.setAttribute('aBend', new THREE.BufferAttribute(bends, 1));
  nonIndexed.deleteAttribute('uv');
  // copy authored data back onto the caller's geometry
  g.setAttribute('position', nonIndexed.getAttribute('position'));
  g.setAttribute('normal', nonIndexed.getAttribute('normal'));
  g.setAttribute('color', nonIndexed.getAttribute('color'));
  g.setAttribute('aBend', nonIndexed.getAttribute('aBend'));
  g.setIndex(null);
}

/**
 * Horizontal dark bands (birch lenticels / palm rings / snag streaks)
 * painted by height FRACTION — pass the trunk height so 0..1 bands map
 * onto world-space Y correctly (round-3 bug: metres were compared to
 * fractions, so bands rendered as single seam lines).
 */
export function paintBands(
  g: THREE.BufferGeometry,
  height: number,
  bands: readonly { y01: number; h01: number; color: string }[],
): void {
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  const col = g.getAttribute('color') as THREE.BufferAttribute;
  const bandCols = bands.map((b) => ({ ...b, c: new THREE.Color(b.color) }));
  for (let i = 0; i < p.count; i++) {
    const y01 = p.getY(i) / height; // NORMALIZED
    for (const b of bandCols) {
      if (y01 >= b.y01 && y01 <= b.y01 + b.h01) {
        col.setXYZ(i, b.c.r, b.c.g, b.c.b);
      }
    }
  }
  col.needsUpdate = true;
}

/** Snow: repaint faces whose normal points up within an absolute Y band. */
export function paintUpFaces(
  g: THREE.BufferGeometry,
  height: number,
  y01Range: readonly [number, number],
  color: string,
  upThreshold = 0.45,
): void {
  const nonIndexed = g.index ? g.toNonIndexed() : g;
  const p2 = nonIndexed.getAttribute('position');
  const n2 = nonIndexed.getAttribute('normal');
  const c2 = nonIndexed.getAttribute('color').clone();
  const snow = new THREE.Color(color);
  for (let f = 0; f < p2.count / 3; f++) {
    const i0 = f * 3;
    const ny = (n2.getY(i0) + n2.getY(i0 + 1) + n2.getY(i0 + 2)) / 3;
    const yAvg = (p2.getY(i0) + p2.getY(i0 + 1) + p2.getY(i0 + 2)) / 3;
    const y01 = yAvg / height;
    if (ny > upThreshold && y01 >= y01Range[0] && y01 <= y01Range[1]) {
      for (let k = 0; k < 3; k++) c2.setXYZ(i0 + k, snow.r, snow.g, snow.b);
    }
  }
  nonIndexed.setAttribute('color', c2);
  g.setAttribute('position', nonIndexed.getAttribute('position'));
  g.setAttribute('normal', nonIndexed.getAttribute('normal'));
  g.setAttribute('color', c2);
  g.setAttribute('aBend', nonIndexed.getAttribute('aBend'));
  g.setIndex(null);
}

// ---- blades: thick-enough horizontal ribbons (fronds, pine tips) ----------

export interface BladeOpts {
  length: number;
  width: number; // root width — tapers to ~25% at the sagging tip
  segs: number;
  arch: number; // tip droop in metres (positive = sag past horizontal)
  color: string;
  tiltUp?: number; // slight rise before the sag (fronds arc up first)
  fold?: number; // V-fold height along the rachis — never vanishes edge-on
}

/**
 * Horizontal arched blade with a V-fold: root at origin, extends +Z,
 * tip sags -Y. The fold gives a dihedral cross-section so an edge-on view
 * shows a chevron, not a 1px hairline (round-3 fatal smell).
 */
export function blade(opts: BladeOpts): THREE.BufferGeometry {
  const g = new THREE.PlaneGeometry(opts.length, opts.width, opts.segs, 2);
  g.rotateX(Math.PI / 2); // width -> horizontal
  g.rotateY(Math.PI / 2); // length -> +Z
  g.translate(0, 0, opts.length / 2);
  const pos = g.attributes.position as THREE.BufferAttribute;
  const colors = new Float32Array(pos.count * 3);
  const bends = new Float32Array(pos.count);
  const c = new THREE.Color(opts.color);
  const fold = opts.fold ?? Math.min(0.22, opts.width * 0.5);
  for (let i = 0; i < pos.count; i++) {
    const t = pos.getZ(i) / opts.length; // 0 root .. 1 tip
    pos.setX(i, pos.getX(i) * (1 - 0.75 * t)); // taper to 25% width
    const rise = (opts.tiltUp ?? 0) * Math.sin(t * Math.PI); // gentle arc up
    pos.setY(i, rise - opts.arch * t * t); // then quadratic sag
    // V-fold: the centre spine (x≈0) lifts, edges stay — chevron cross-section
    const ax = Math.abs(pos.getX(i));
    const halfW = (opts.width / 2) * (1 - 0.75 * t) + 1e-6;
    pos.setY(i, pos.getY(i) + fold * (1 - ax / halfW) * (1 - t * 0.5));
    colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
    bends[i] = 0.6 + t * 0.4;
  }
  pos.needsUpdate = true;
  setAttrs(g, colors, bends);
  return g;
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
