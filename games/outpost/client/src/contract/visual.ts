// ============================================================================
// FROZEN CONTRACT — OUTPOST's shared client visual vocabulary. Ported
// near-verbatim from STRICKEN (games/fps/client/src/contract/visual.ts):
// proven, shipped code, so this file does NOT "improve" any algorithm — it
// keeps the same bodies, the same caching, the same flat-shading, and the
// same coplanar-offset logic in `articulate()`.
// EVERY mesh in the game is built through these factories and the frozen
// PALETTE. Raw `new THREE.Mesh*Material` / `new THREE.BoxGeometry` etc. in
// implementer code is a contract violation (fx shaders/points material for
// particles excepted where CONTRACT.md allows it).
// Material model (see STYLE_BIBLE.md): flat-shaded Lambert, no PBR, no env
// map. `bake()` below is what keeps this style affordable: merging every
// static mesh down to one draw call per material is the entire reason OUTPOST
// can afford dense, articulated geometry without a material-count / draw-call
// blowout — see its doc comment for the measured cost and the frozen output
// guarantee.
// ============================================================================
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

import { PALETTE } from '@outpost/shared';
import { rng } from '@platform/shared';

export { PALETTE };
export type { PaletteKey } from '@outpost/shared';

/**
 * Seeded deterministic RNG for cosmetic variation (foliage jitter, prop
 * rotation, decal placement, etc.). Math.random is a contract violation —
 * every non-gameplay draw of randomness in client art goes through this so a
 * given seed always paints the same scene. Thin wrapper over the canonical
 * mulberry32 implementation in `@platform/shared` (frozen there; not
 * reimplemented here).
 */
export function vrng(seed: number): () => number {
  return rng(seed);
}

// ---- cached material factory ------------------------------------------------
const matCache = new Map<string, THREE.MeshLambertMaterial>();

export interface MatOpts {
  emissive?: string; // emissive hex (fx only: muzzle, tracers, glow)
  transparent?: boolean;
  opacity?: number;
}

/**
 * NO VERTEX COLOURS, deliberately. `bake()` merges to one mesh per material and
 * carries only position/normal/uv; a `vertexColors: true` material over a
 * geometry with no `color` attribute reads the WebGL default (0,0,0) and bakes
 * to PURE BLACK, and a bucket mixing tinted and untinted geometry fails the
 * merge and silently drops every mesh in it. Both were measured.
 *
 * Multi-tone surfaces (the ground's mud/gravel blend, biome variation) are built
 * as SEPARATE meshes per palette tier instead. `bake()` merges each tier into
 * one draw call for free, and crisp tier boundaries suit flat-shaded Lambert
 * better than a smooth vertex blend would anyway.
 */
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

// ---- articulation helpers ---------------------------------------------------
// A wall rendered as one flat untextured quad is the single biggest reason a
// scene reads as blockout — the previous OUTPOST measured stddev-luma 7.3 over
// a 300x220 wall patch and was called "a solid colour swatch". These build the
// trim that breaks the span. Flat shading turns every added edge into a free
// value break, and `bake()` merges it all away, so articulation costs draw
// calls NOTHING. Apply it to every built surface over MIN_ARTICULATE_H.

/**
 * The four colours a wall's trim needs.
 *
 * Resolve them with the ONE frozen table in `@outpost/shared`:
 *
 *     const c = MAT_COLORS[box.mat];   // MatKind -> MatColors
 *     articulate(w, h, d, c, opts);    // c is already {body, trim, dark, contact}
 *
 * `MAT_COLORS` returns the whole four-tier set for a `MatKind`; there are no
 * separate `TRIM_MAT` / `DARK_MAT` / `CONTACT_MAT` tables (this doc used to
 * name three that never existed in OUTPOST, which would have type-errored every
 * art agent at the same line and sent each of them off to invent their own
 * MatKind -> palette mapping — exactly the divergence MAT_COLORS exists to stop).
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
  /** Plinth proud-of-face, metres per face. Default 0.04 (see STYLE_BIBLE.md). */
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
 * Coplanar-face guard, in metres. Trim is a SIBLING of the full wall box, so any
 * trim face that lands on exactly the same plane as a wall face, facing the same
 * way, produces two fragments with the same depth. `bake()` merges by material,
 * so the two ended up in DIFFERENT meshes with different triangulations, and
 * which one survives the depth test is then decided by the last bits of the
 * interpolated depth — it changes with the camera. That is the flicker on wall
 * bases: the plinth's end caps and underside used to be exactly flush with the
 * wall's.
 *
 * The rule this file and its callers (the render/ modules) now hold to: NO TRIM
 * FACE MAY SHARE A PLANE WITH A WALL FACE. Wherever a band used to finish
 * exactly flush it is carried `COPLANAR_EPS` PAST instead — past the two end
 * faces along the long axis, past the underside, past the top face. Past rather
 * than short of, because a band cut short vanishes behind the wall's own face,
 * and on a box whose two horizontal extents are close (a 9 x 12 m building) the
 * "end" faces are full facades: cutting there strips the whole stack off half
 * the building. Every visible edge LINE — plinth top, cornice underside — is
 * left exactly where it was; only the buried edge moves.
 *
 * Why 6 mm:
 *  - Depth resolution of a 24-bit buffer at this camera's near/far (0.1 / 500,
 *    see scene.ts) is z^2 * (1/near - 1/far) / 2^24 ~= z^2 * 6e-7 m: 0.06 mm at
 *    10 m, 0.5 mm at 30 m, 2 mm at 60 m, 6 mm at 100 m. 6 mm therefore resolves
 *    to at least one depth step everywhere inside ~100 m, and past that a 0.32 m
 *    plinth is under 2 px tall and inside the fog.
 *  - It is a third of the SMALLEST proud-of-face offset in the stack (0.018) and
 *    an eighth of the shortest band (0.05), so it can never reorder the stack.
 *  - It is under the 10 mm gap between a wall's underside (y=0) and the ground
 *    slab's top face (y=-0.01), so a downward-grown plinth cannot land on the
 *    ground plane and trade one coplanar pair for another.
 */
export const COPLANAR_EPS = 0.006;

/**
 * Build the trim set for a wall of full extents `w x h x d`, centred on the
 * origin — add it as a SIBLING of the wall box at the same position.
 *
 * Long axis is inferred: pilasters and the mid rail run along whichever of w/d
 * is larger. Trim stands proud only on the two LONG faces so end caps never
 * intersect an abutting wall.
 *
 * Returns an EMPTY group for walls too short to carry trim — callers can add
 * the result unconditionally.
 *
 * Use this on every built surface over 1.5 m (STYLE_BIBLE) — the 1.6 m fence segments are IN scope: a box painted one
 * flat colour is the clearest programmer-art tell, and the previous OUTPOST
 * measured stddev-luma 7.3 over a 300x220 wall patch — "a solid colour swatch".
 *
 * TRIM IS RENDER-ONLY. Never express it as extra boxes in
 * `games/outpost/shared/src/map.ts`: `STATIC_BOXES` drives SERVER COLLISION, so
 * trim authored as map data would become solid world geometry and change
 * gameplay. Renderers call this; the frozen map data never does.
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

  // Long-axis extent of every horizontal band: a hair PAST the wall's two end
  // faces, so no band end cap is ever coplanar with them (see COPLANAR_EPS).
  //
  // Past, not short of. Shortening also kills the coplanarity, but it hides the
  // whole band behind the wall's own end face — and for a box whose two
  // horizontal extents are close (a 9 x 12 m building), the "end" faces are
  // full facades. Cutting the band there strips plinth, cornice and bead off
  // half the building and hands back exactly the flat blockout quad §3b exists
  // to kill. Standing 6 mm proud instead keeps the band reading all the way
  // round, and it cannot break the "never intersect an abutting wall" rule the
  // 0.04-0.06 m proud offsets are held to: 6 mm past a wall's end face is 6 mm
  // INSIDE whatever that end abuts, i.e. behind that neighbour's own surface.
  const bandSpan = span + COPLANAR_EPS * 2;

  // plinth — the contact band. This is what stops the wall from floating.
  // Grown COPLANAR_EPS DOWNWARD (into the ground / whatever it stands on) so its
  // underside is not flush with the wall's; its top edge — the line that reads —
  // is unmoved.
  if (plinthH > 0 && colors.contact) {
    const ph = plinthH + COPLANAR_EPS;
    const pl = alongX
      ? box(bandSpan, ph, d + pp * 2, colors.contact)
      : box(w + pp * 2, ph, bandSpan, colors.contact);
    g.add(at(pl, 0, -h / 2 + plinthH - ph / 2, 0));
  }
  // cornice — catches the sun, reads the wall's top edge at distance. Grown
  // COPLANAR_EPS UPWARD so its top face is not flush with the wall's top face
  // (which is what fought when you looked down on a roofline); its underside —
  // the line the soffit shadows — is unmoved.
  if (corniceH > 0 && colors.trim) {
    const ch = corniceH + COPLANAR_EPS;
    const cr = alongX
      ? box(bandSpan, ch, d + cp * 2, colors.trim)
      : box(w + cp * 2, ch, bandSpan, colors.trim);
    g.add(at(cr, 0, h / 2 - corniceH + ch / 2, 0));
  }
  // pilasters — vertical ribs that break the span and self-shadow. Alternating
  // tiers so a long wall reads as rhythm rather than stripes.
  const bodyH = h - plinthH - corniceH;
  if (every > 0 && span > every && bodyH > 0.2) {
    // A rib runs the full body height, but its ends must not land on the plinth
    // top / cornice underside — the caller's bead and soffit sit on exactly
    // those two lines. Bury it COPLANAR_EPS into the plinth below (or into the
    // ground, when the ladder gave this wall no plinth) and COPLANAR_EPS into
    // the cornice above; with no cornice, cut it that much SHORT instead, so a
    // rib never breaks a roofline.
    const ribLo = -h / 2 + plinthH - COPLANAR_EPS;
    const ribHi = h / 2 - corniceH + (corniceH > 0 ? COPLANAR_EPS : -COPLANAR_EPS);
    const ribH = ribHi - ribLo;
    const yC = (ribLo + ribHi) / 2;
    // round, not floor: flooring drove a 6m wall to a single rib at 3m spacing,
    // well under the 4-6m band §3b specifies. n === 0 means "no rib fits".
    const n = Math.max(0, Math.round(span / every) - 1);
    for (let i = 1; i <= n; i++) {
      const t = (i / (n + 1) - 0.5) * span;
      const hex = i % 2 === 0 ? darkHex : (colors.trim ?? darkHex);
      const pil = alongX
        ? box(0.3, ribH, thick + lp * 2, hex)
        : box(thick + lp * 2, ribH, 0.3, hex);
      g.add(at(pil, alongX ? t : 0, yC, alongX ? 0 : t));
    }
  }
  // mid rail — breaks tall spans horizontally. MUST stand proud of the
  // pilasters it crosses, or bake() merges it into them and it disappears.
  if (midRail && colors.trim && bodyH > 0.4) {
    const rp = lp * 1.4;
    const rl = alongX
      ? box(bandSpan, 0.12, d + rp * 2, colors.trim)
      : box(w + rp * 2, 0.12, bandSpan, colors.trim);
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
 * material tier, so it must not vary by surface. STYLE_BIBLE.md §1 L2b
 * requires the >= 8 L* drop of the COMPOSITE (verify with `composite()` from
 * `@platform/shared`, which blends in LINEAR light exactly as three.js does).
 *
 * OUTPOST's ground is the `mud` family (L* ~29 base, `mudDark` ~20). At the 0.6
 * default the composite drop over `mud` clears the 8 L* bar; over `mudDeep`
 * (L* ~13) it cannot, and grounding there is carried by plinth geometry
 * instead. That is expected, not a bug.
 * (Inherited baseline, STRICKEN's six shipped maps, for calibration only:
 *  dustbowl 16.3 · crossfire 11.4 · office 9.8 · frostbite 18.9 · urbana 11.4
 *  · bunker 3.8 — that last one being the same sub-L*20 exemption.)
 *
 * On grounds below L* 20 no alpha can produce the drop; there, grounding is
 * carried by plinth geometry instead. That is expected, not a bug.
 */
export function contactShadow(radius: number, opacity = 0.6): THREE.Mesh {
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
/** The only attributes a baked static carries; anything else is dropped. */
const BAKE_ATTRS = ['position', 'normal', 'uv'] as const;

/** Plain, non-normalised Float32 storage, or null if the attribute is exotic. */
function plainF32(attr: THREE.BufferAttribute | undefined): Float32Array | null {
  if (attr === undefined || attr.normalized) return null;
  return attr.array instanceof Float32Array ? attr.array : null;
}

/**
 * Walk `root`, bucketing every static Mesh descendant by material — but NEVER
 * descending into a subtree whose root is marked `userData.animate === true`.
 * That flag is OUTPOST's live/static seam: animated sub-parts, doors, anything
 * with a per-frame transform update must opt out of baking entirely (itself
 * AND everything under it), or `bake()` would merge it into a static batch
 * and its animation would silently stop moving. Ordinary Object3D#traverse
 * cannot skip a subtree, hence the hand-rolled recursion here.
 */
function collectStaticMeshes(node: THREE.Object3D, byMaterial: Map<THREE.Material, THREE.Mesh[]>): void {
  if (node.userData['animate'] === true) return;
  if (node instanceof THREE.Mesh) {
    const arr = byMaterial.get(node.material as THREE.Material);
    if (arr) arr.push(node);
    else byMaterial.set(node.material as THREE.Material, [node]);
  }
  for (const child of node.children) collectStaticMeshes(child, byMaterial);
}

/**
 * Merge all Mesh descendants of `root` into one mesh per material, preserving
 * world transforms. Use for EVERY static structure (map geometry, props) to
 * keep draw calls flat. Dynamic/animated parts must NOT be baked — keep them
 * as separate pivots and animate their transforms; mark the pivot's
 * `userData.animate = true` and `bake()` will leave that whole subtree alone
 * (see `collectStaticMeshes`) instead of merging it away.
 *
 * PERF (measured at the bulk of world-build cost; 2 400–2 700 source
 * meshes per map). The old body was `geometry.clone().applyMatrix4(m)` per prop
 * and then `mergeGeometries`, which writes every prop's attribute arrays THREE
 * times — once cloning, once transforming in place, once copying into the
 * merged buffer — and allocates several typed arrays per prop. It is now a
 * two-pass direct write: count, allocate the merged buffers ONCE, then
 * transform each source vertex straight into its slot in them.
 *
 * The arithmetic is deliberately the same operations in the same order as
 * THREE's `BufferAttribute.applyMatrix4` (perspective-divided Matrix4 multiply)
 * and `applyNormalMatrix` (Matrix3 multiply then normalise by 1/length),
 * reading f32 and writing f32, so every float lands BIT-IDENTICAL to the old
 * path. `mergeGeometries` is still the fallback for any bucket whose geometries
 * are exotic (interleaved / normalised / unindexed, or disagreeing on which
 * attributes they carry) — none of this file's primitives are, but the seam is
 * public and callers may pass anything.
 *
 * SIGNATURE, SEMANTICS AND OUTPUT ARE UNCHANGED (frozen contract) for the
 * static path: proven in STRICKEN by fingerprinting `buildMap()`'s whole
 * output — material colour, vertexColors, shadow flags, every attribute and
 * index array — across STRICKEN's six shipped maps (inherited baseline). The `userData.animate` skip is additive:
 * it removes nodes from the input set, it does not change how a merged node
 * is produced.
 */
export function bake(root: THREE.Group): THREE.Group {
  root.updateMatrixWorld(true);
  const byMaterial = new Map<THREE.Material, THREE.Mesh[]>();
  collectStaticMeshes(root, byMaterial);
  const out = new THREE.Group();
  const nm = new THREE.Matrix3();
  for (const [material, meshes] of byMaterial) {
    const merged = mergeMeshes(meshes, nm) ?? mergeFallback(meshes);
    if (!merged) continue;
    const mesh = new THREE.Mesh(merged, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    out.add(mesh);
  }
  return out;
}

/**
 * One material's worth of props transformed straight into shared buffers.
 * Returns null (rather than a wrong answer) whenever the inputs are not the
 * plain indexed Float32 primitives this file's factories build, so the caller
 * can fall back to THREE's own merge.
 */
function mergeMeshes(meshes: readonly THREE.Mesh[], nm: THREE.Matrix3): THREE.BufferGeometry | null {
  const first = meshes[0];
  if (first === undefined) return null;
  // the attribute set is the FIRST geometry's, exactly as mergeGeometries does;
  // a geometry that disagrees makes the whole bucket a fallback
  const names = BAKE_ATTRS.filter((n) => first.geometry.getAttribute(n) !== undefined);
  if (!names.includes('position')) return null;
  let verts = 0;
  let indices = 0;
  for (const m of meshes) {
    const g = m.geometry;
    const idx = g.getIndex();
    if (idx === null || !(idx.array instanceof Uint16Array || idx.array instanceof Uint32Array)) return null;
    for (const n of BAKE_ATTRS) {
      if ((g.getAttribute(n) !== undefined) !== names.includes(n)) return null;
      if (names.includes(n) && plainF32(g.getAttribute(n) as THREE.BufferAttribute) === null) return null;
    }
    verts += (g.getAttribute('position') as THREE.BufferAttribute).count;
    indices += idx.count;
  }
  if (verts === 0) return null;
  const pos = new Float32Array(verts * 3);
  const nrm = names.includes('normal') ? new Float32Array(verts * 3) : null;
  const uvs = names.includes('uv') ? new Float32Array(verts * 2) : null;
  const idxOut = new Uint32Array(indices);
  let vo = 0;
  let io = 0;
  let maxIndex = 0;
  for (const m of meshes) {
    const g = m.geometry;
    const src = plainF32(g.getAttribute('position') as THREE.BufferAttribute)!;
    const count = (g.getAttribute('position') as THREE.BufferAttribute).count;
    const e = m.matrixWorld.elements;
    const e0 = e[0]!, e4 = e[4]!, e8 = e[8]!, e12 = e[12]!;
    const e1 = e[1]!, e5 = e[5]!, e9 = e[9]!, e13 = e[13]!;
    const e2 = e[2]!, e6 = e[6]!, e10 = e[10]!, e14 = e[14]!;
    const e3 = e[3]!, e7 = e[7]!, e11 = e[11]!, e15 = e[15]!;
    for (let i = 0; i < count; i++) {
      const x = src[i * 3]!;
      const y = src[i * 3 + 1]!;
      const z = src[i * 3 + 2]!;
      const w = 1 / (e3 * x + e7 * y + e11 * z + e15);
      const k = (vo + i) * 3;
      pos[k] = (e0 * x + e4 * y + e8 * z + e12) * w;
      pos[k + 1] = (e1 * x + e5 * y + e9 * z + e13) * w;
      pos[k + 2] = (e2 * x + e6 * y + e10 * z + e14) * w;
    }
    if (nrm !== null) {
      const ns = plainF32(g.getAttribute('normal') as THREE.BufferAttribute)!;
      nm.getNormalMatrix(m.matrixWorld);
      const t = nm.elements;
      const t0 = t[0]!, t1 = t[1]!, t2 = t[2]!;
      const t3 = t[3]!, t4 = t[4]!, t5 = t[5]!;
      const t6 = t[6]!, t7 = t[7]!, t8 = t[8]!;
      for (let i = 0; i < count; i++) {
        const x = ns[i * 3]!;
        const y = ns[i * 3 + 1]!;
        const z = ns[i * 3 + 2]!;
        const ax = t0 * x + t3 * y + t6 * z;
        const ay = t1 * x + t4 * y + t7 * z;
        const az = t2 * x + t5 * y + t8 * z;
        // Vector3.normalize(): divideScalar(length() || 1) => multiply by 1/len
        const inv = 1 / (Math.sqrt(ax * ax + ay * ay + az * az) || 1);
        const k = (vo + i) * 3;
        nrm[k] = ax * inv;
        nrm[k + 1] = ay * inv;
        nrm[k + 2] = az * inv;
      }
    }
    if (uvs !== null) {
      const us = plainF32(g.getAttribute('uv') as THREE.BufferAttribute)!;
      uvs.set(us.subarray(0, count * 2), vo * 2);
    }
    const idx = g.getIndex()!;
    const ia = idx.array as Uint16Array | Uint32Array;
    for (let i = 0; i < idx.count; i++) {
      const v = ia[i]! + vo;
      idxOut[io + i] = v;
      if (v > maxIndex) maxIndex = v;
    }
    vo += count;
    io += idx.count;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  if (nrm !== null) geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  if (uvs !== null) geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  // setIndex() picks Uint16 below 65536 — match it, or the buffer type (and so
  // the GPU upload) would differ from the old path for small buckets
  geo.setIndex(new THREE.BufferAttribute(maxIndex > 65535 ? idxOut : new Uint16Array(idxOut), 1));
  return geo;
}

/** THREE's own merge, for a bucket `mergeMeshes` declined (see its contract). */
function mergeFallback(meshes: readonly THREE.Mesh[]): THREE.BufferGeometry | null {
  const geoms = meshes.map((child) => {
    const g = child.geometry.clone().applyMatrix4(child.matrixWorld);
    for (const name of Object.keys(g.attributes)) {
      if (!(BAKE_ATTRS as readonly string[]).includes(name)) g.deleteAttribute(name);
    }
    return g;
  });
  return mergeGeometries(geoms, false);
}
