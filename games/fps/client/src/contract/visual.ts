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

// ---- articulation helpers (VISUAL_UPGRADE.md §3b) ----------------------------
// Every wall over 3m currently renders as one flat untextured quad — the single
// biggest reason the game reads as blockout. These build the trim that breaks
// the span. Flat shading turns every added edge into a free value break, and
// `bake()` merges it all away, so articulation costs draw calls NOTHING.

export interface ArticulateOpts {
  /** Plinth height in metres. 0 disables. Default 0.32. */
  plinthH?: number;
  /** Cornice height in metres. 0 disables. Default 0.18. */
  corniceH?: number;
  /** Pilaster spacing in metres along the wall's long axis. 0 disables. Default 5. */
  pilasterEvery?: number;
  /** How far trim stands proud of the wall face, in metres. Default 0.05. */
  proud?: number;
  /** Add a mid rail. Auto-enabled for walls taller than 4m. */
  midRail?: boolean;
}

/**
 * Build the trim set for a wall of full extents `w x h x d`, centred on the
 * origin — add it as a SIBLING of the wall box at the same position.
 *
 * `bodyHex` is the wall's own colour; `trimHex` must be >= 8 L* above it
 * (use `TRIM_MAT`); `contactHex` must be >= 8 L* below the GROUND
 * (use `CONTACT_MAT`). Those two rules are the value ladder law's L2 and L3.
 *
 * Long axis is inferred: pilasters and rails run along whichever of w/d is
 * larger, and stand proud on the two long faces.
 */
export function articulate(
  w: number,
  h: number,
  d: number,
  trimHex: string,
  contactHex: string,
  opts: ArticulateOpts = {},
): THREE.Group {
  const plinthH = opts.plinthH ?? 0.32;
  const corniceH = opts.corniceH ?? 0.18;
  const every = opts.pilasterEvery ?? 5;
  const proud = opts.proud ?? 0.05;
  const midRail = opts.midRail ?? h > 4;
  const g = new THREE.Group();
  const alongX = w >= d;
  const span = alongX ? w : d;
  const thick = alongX ? d : w;
  const p2 = proud * 2;

  // plinth — the contact band. This is what stops the wall from floating.
  if (plinthH > 0) {
    const pl = alongX ? box(w + p2, plinthH, d + p2, contactHex) : box(w + p2, plinthH, d + p2, contactHex);
    g.add(at(pl, 0, -h / 2 + plinthH / 2, 0));
  }
  // cornice — catches the sun, reads the wall's top edge at distance.
  if (corniceH > 0) {
    const cr = box(w + p2 * 1.4, corniceH, d + p2 * 1.4, trimHex);
    g.add(at(cr, 0, h / 2 - corniceH / 2, 0));
  }
  // mid rail — breaks tall spans horizontally.
  if (midRail) {
    const rl = box(w + proud, 0.12, d + proud, trimHex);
    g.add(at(rl, 0, -h / 2 + plinthH + (h - plinthH - corniceH) * 0.55, 0));
  }
  // pilasters — vertical ribs that break the span and self-shadow.
  if (every > 0 && span > every) {
    const bodyH = h - plinthH - corniceH;
    if (bodyH > 0.2) {
      const yC = -h / 2 + plinthH + bodyH / 2;
      const n = Math.max(1, Math.floor(span / every) - 1);
      for (let i = 1; i <= n; i++) {
        const t = (i / (n + 1) - 0.5) * span;
        const pil = alongX
          ? box(0.3, bodyH, thick + p2, trimHex)
          : box(thick + p2, bodyH, 0.3, trimHex);
        g.add(at(pil, alongX ? t : 0, yC, alongX ? 0 : t));
      }
    }
  }
  return g;
}

/**
 * A flat contact-shadow quad to sit under a prop, at `y` just above the ground
 * plane. The cheap, texture-free replacement for ambient occlusion: without one
 * of these, props visibly float. Every scattered prop gets one.
 */
export function contactShadow(radius: number, hex: string, opacity = 0.38): THREE.Mesh {
  const m = new THREE.Mesh(
    new THREE.CircleGeometry(radius, 12),
    mat(hex, { transparent: true, opacity }),
  );
  m.rotation.x = -Math.PI / 2;
  m.receiveShadow = false;
  m.castShadow = false;
  return m;
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
