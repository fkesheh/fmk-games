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

import { PALETTE } from '@fps/shared';

export { PALETTE };
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

/**
 * The four colours a wall's trim needs. Resolve them from the frozen tables in
 * `@fps/shared`: `MAT_COLORS[b.mat]` for `body`, `TRIM_MAT[b.mat]` for `trim`,
 * `DARK_MAT[b.mat]` for `dark`, `CONTACT_MAT[b.mat]` for `contact`.
 *
 * `trim` and `contact` may legitimately come back NULL from those tables when
 * the material is already at the top or bottom of its ladder (a `…Lit` surface
 * has nothing above it; a `…Deep` surface has nothing below it). Pass null and
 * `articulate()` SKIPS that element rather than emitting zero-contrast trim.
 */
export interface ArticulateColors {
  /** The wall's own colour. */
  body: string;
  /** Cornice / mid rail — >= 8 L* above `body`, or null to skip them. */
  trim: string | null;
  /** Alternating pilaster tier — below `body`. Falls back to `body`. */
  dark?: string | null;
  /** Plinth — >= 8 L* below `body`, or null to skip it. */
  contact: string | null;
}

export interface ArticulateOpts {
  /** Plinth height in metres. 0 disables. Default 0.32. */
  plinthH?: number;
  /** Cornice height in metres. 0 disables. Default 0.18. */
  corniceH?: number;
  /** Pilaster spacing in metres along the wall's long axis. 0 disables. Default 5. */
  pilasterEvery?: number;
  /** Plinth proud-of-face, metres per face. Default 0.04 (VISUAL_UPGRADE §3b). */
  plinthProud?: number;
  /** Cornice proud-of-face, metres per face. Default 0.06. */
  corniceProud?: number;
  /** Pilaster proud-of-face, metres per face. Default 0.05. */
  pilasterProud?: number;
  /** Add a mid rail. Auto-enabled for walls taller than 4m. */
  midRail?: boolean;
}

/** Below this height a wall cannot carry trim without self-intersecting. */
const MIN_ARTICULATE_H = 0.9;

/**
 * Build the trim set for a wall of full extents `w x h x d`, centred on the
 * origin — add it as a SIBLING of the wall box at the same position.
 *
 * Implements VISUAL_UPGRADE.md §3b. Long axis is inferred: pilasters and the
 * mid rail run along whichever of w/d is larger. Trim stands proud only on the
 * two LONG faces so end caps never intersect an abutting wall.
 *
 * Returns an EMPTY group for walls too short to carry trim — callers can add
 * the result unconditionally.
 *
 * ONLY `mapRenderer.ts` (F8) may call this. Map data files must NOT express
 * trim as extra `BoxDef`s: `MapDef.boxes` drives SERVER COLLISION
 * (games/fps/server/src/game.ts), so trim authored as data would become solid
 * world geometry and change gameplay.
 */
export function articulate(
  w: number,
  h: number,
  d: number,
  colors: ArticulateColors,
  opts: ArticulateOpts = {},
): THREE.Group {
  const g = new THREE.Group();
  if (h < MIN_ARTICULATE_H) return g;

  const every = opts.pilasterEvery ?? 5;
  const pp = opts.plinthProud ?? 0.04;
  const cp = opts.corniceProud ?? 0.06;
  const lp = opts.pilasterProud ?? 0.05;
  const midRail = opts.midRail ?? h > 4;
  const alongX = w >= d;
  const span = alongX ? w : d;
  const thick = alongX ? d : w;
  const darkHex = colors.dark ?? colors.body;

  // Scale the bands down if they would meet in the middle of a short wall.
  let plinthH = colors.contact ? (opts.plinthH ?? 0.32) : 0;
  let corniceH = colors.trim ? (opts.corniceH ?? 0.18) : 0;
  const avail = h * 0.7;
  if (plinthH + corniceH > avail) {
    const k = avail / (plinthH + corniceH);
    plinthH *= k;
    corniceH *= k;
  }

  // plinth — the contact band. This is what stops the wall from floating.
  if (plinthH > 0 && colors.contact) {
    const pl = alongX
      ? box(w, plinthH, d + pp * 2, colors.contact)
      : box(w + pp * 2, plinthH, d, colors.contact);
    g.add(at(pl, 0, -h / 2 + plinthH / 2, 0));
  }
  // cornice — catches the sun, reads the wall's top edge at distance.
  if (corniceH > 0 && colors.trim) {
    const cr = alongX
      ? box(w, corniceH, d + cp * 2, colors.trim)
      : box(w + cp * 2, corniceH, d, colors.trim);
    g.add(at(cr, 0, h / 2 - corniceH / 2, 0));
  }
  // pilasters — vertical ribs that break the span and self-shadow. Alternating
  // tiers so a long wall reads as rhythm rather than stripes.
  const bodyH = h - plinthH - corniceH;
  if (every > 0 && span > every && bodyH > 0.2) {
    const yC = -h / 2 + plinthH + bodyH / 2;
    const n = Math.max(1, Math.floor(span / every) - 1);
    for (let i = 1; i <= n; i++) {
      const t = (i / (n + 1) - 0.5) * span;
      const hex = i % 2 === 0 ? darkHex : (colors.trim ?? darkHex);
      const pil = alongX
        ? box(0.3, bodyH, thick + lp * 2, hex)
        : box(thick + lp * 2, bodyH, 0.3, hex);
      g.add(at(pil, alongX ? t : 0, yC, alongX ? 0 : t));
    }
  }
  // mid rail — breaks tall spans horizontally. MUST stand proud of the
  // pilasters it crosses, or bake() merges it into them and it disappears.
  if (midRail && colors.trim && bodyH > 0.4) {
    const rp = lp * 1.4;
    const rl = alongX
      ? box(w, 0.12, d + rp * 2, colors.trim)
      : box(w + rp * 2, 0.12, d, colors.trim);
    g.add(at(rl, 0, -h / 2 + plinthH + bodyH * 0.55, 0));
  }
  return g;
}

/** Height above the ground plane for contact shadows — avoids z-fighting. */
export const CONTACT_Y = 0.02;

/**
 * A flat contact-shadow quad to sit under a prop. The cheap, texture-free
 * replacement for ambient occlusion: without one of these, props visibly float.
 * Every scattered prop and every character gets one.
 *
 * The shadow is always `PALETTE.ink` — a shadow is an absence of light, not a
 * material tier, so it must not vary by surface. VISUAL_UPGRADE.md §1 L2b
 * requires the >= 8 L* drop of the COMPOSITE (use `composite()` from
 * `@platform/shared` to verify); the default alpha clears it on every ground
 * above L* 25. On near-black floors (Bunker) no alpha can, and grounding is
 * carried by the plinth geometry instead — that is expected, not a bug.
 */
export function contactShadow(radius: number, opacity = 0.5): THREE.Mesh {
  const m = new THREE.Mesh(
    new THREE.CircleGeometry(radius, 12),
    mat(PALETTE.ink, { transparent: true, opacity }),
  );
  m.rotation.x = -Math.PI / 2;
  m.position.y = CONTACT_Y;
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
