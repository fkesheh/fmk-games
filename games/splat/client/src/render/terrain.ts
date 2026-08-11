// ============================================================================
// SKI SPLAT — TERRAIN + MOUNTAIN DRESSING (task R1, CONTRACT §7). One seeded
// procedural mountain per race, rebuilt on seed change (rematch = new
// mountain). Layout is deterministic: every scatter draw comes from
// rng(slope.seed ^ salt) — Math.random is a contract violation.
//
//   * The piste: ONE heightmap mesh (<= 128x256 segments, CONTRACT §8) over
//     the run plus a rising mountain skirt beyond both edges, vertex-coloured
//     snow — snowLit on sun-facing normals, snowShade (BLUE, never grey) on
//     the shadow side from the per-vertex sun dot, snowDeep blended into the
//     steep/carved bands. Terrain heightmap geometry is a §2.5 factory
//     exemption; colours still trace to SPAL.
//   * Forest walls: TWO InstancedMeshes of vertex-coloured mature-pine
//     archetypes (a tall fir + a wide offset-tier spruce, interleaved ~70/30
//     by the seeded rng, with per-axis scale jitter) OUTSIDE both piste edges
//     — sparse near the start, denser downhill — the rails that make the
//     piste corridor read at 60 km/h.
//   * Ridge rock outcrops (rockLit/rock, snow-dusted) baked to a handful of
//     draw calls, and distant-peak horizon cards pre-hazed into skyHorizon
//     (also a §2.5 exemption), so the world dissolves into the morning sky.
//   * v2.2: a seeded corduroy groom band down the piste centre (faint
//     lightening + ~2.5 m ridge lines in the vertex colours; off-piste keeps
//     the deeper powder), snow banks tucked against the piste edges (baked),
//     angular-fractured outcrops + small debris, and a nearer foothill depth
//     plane between the peak cards and the run.
// ============================================================================
import * as THREE from 'three';
import { rng, rngInt, rngRange } from '@platform/shared';
import { SPAL } from '@splat/shared';
import type { SlopeDef } from '@splat/shared';
import { SUN_DIR, at, bake, box, cone, cyl, mat, sphere } from '../contract/visual.js';

const TAU = Math.PI * 2;

// ---- slope mesh ----------------------------------------------------------------
const SEG_X = 128; // lateral segments (CONTRACT §8 cap)
const SEG_Z = 256; // downhill segments
const SKIRT = 28; // terrain width beyond each piste edge (m)
const SKIRT_RISE = 22; // mountain-wall lift at the outer skirt edge (m)
const Z_BACK = 30; // terrain behind the start gate (the summit shoulder)
const Z_RUNOUT = 140; // terrain past the finish (lodge meadow, fades into fog)
const NORMAL_EPS = 0.6; // central-difference step for heightfield normals

// ---- forest walls ---------------------------------------------------------------
const FOREST_IN = 1.5; // trees keep this clear of the piste edge (m)
const FOREST_DEPTH = 17; // forest band width (m)
const FOREST_STEP = 2.2; // z-step between scatter rows
const FOREST_MAX = 2200; // hard cap — total visual instances <= 3k with R2
const FOREST_Z0 = -12;
const FOREST_Z_PAD = 60; // trees continue past the finish into the runout
const FOREST_SINK = 0.15; // trunks sit slightly INTO the snow
const SPRUCE_SHARE = 0.3; // ~30% of instances are the wide spruce archetype

// ---- v2.2 groomed piste ---------------------------------------------------------------
const GROOM_BAND_FRAC = 0.18; // corduroy band half-width as a fraction of slope width
const GROOM_LIFT = 0.05; // in-band lightening toward snowLit (~±1% value on shadow snow)
const GROOM_RIDGE_AMP = 0.04; // corduroy ridge lerp strength (~±0.6% value per line)
const GROOM_WL = 2.5; // corduroy ridge wavelength (m)
const POWDER_DEEP = 0.04; // off-piste deepening toward snowDeep (the powder read)

// ---- v2.2 snow banks ------------------------------------------------------------------
const BANK_CLUSTERS_MIN = 12;
const BANK_CLUSTERS_MAX = 16;
const BANK_SIZE_MIN = 3;
const BANK_SIZE_MAX = 5;
const BANK_CLEAR = 2.5; // a bank never covers a plant (visual dressing, no collisions)
const BANK_MESH_CAP = 120; // source meshes before bake() — the brief's modest budget

// ---- ridge rocks ------------------------------------------------------------------
const ROCK_CLUSTERS = 14;
const ROCK_IN = 8; // outcrops start this far beyond the piste edge
const ROCK_SPREAD = 16; // ...and scatter this much farther out
const DEBRIS_COUNT = 20; // v2.2 small debris rocks near the piste edge

// ---- horizon peak cards -------------------------------------------------------------
const PEAK_COUNT = 16;
const FOOTHILL_COUNT = 12; // v2.2 nearer foothill ridge (10-14 cards)

function clamp01(t: number): number {
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

function smooth01(t: number): number {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
}

/** Mountain-wall lift beyond the piste edges — analytic, deterministic. */
function skirtLift(x: number, halfW: number): number {
  const d = Math.abs(x) - halfW;
  if (d <= 0) return 0;
  const t = Math.min(1, d / SKIRT);
  return SKIRT_RISE * t * t;
}

/** Ground height INCLUDING the skirt — every dressing prop sits on this. */
function groundHeight(slope: SlopeDef, x: number, z: number): number {
  return slope.height(x, z) + skirtLift(x, slope.width / 2);
}

// ---- vertex-colour snow (sun dot per vertex; blue shadows, never grey) -------------
const COL_LIT = new THREE.Color(SPAL.snowLit);
const COL_BASE = new THREE.Color(SPAL.snow);
const COL_SHADE = new THREE.Color(SPAL.snowShade);
const COL_DEEP = new THREE.Color(SPAL.snowDeep);

function snowColor(
  out: THREE.Color,
  sunDot: number,
  steepness: number,
  x: number,
  bandHalf: number,
  corrPhase: number,
): void {
  // sun-facing -> snowLit, shadow side -> snowShade, through the snow base.
  // Remapped (not raw N·L): the Lambert term already applies N·L once more at
  // render time, so mid-slope must paint near snowLit or the piste goes dusk.
  const t = clamp01((sunDot + 0.10) / 0.62);
  if (t < 0.5) out.lerpColors(COL_SHADE, COL_BASE, t * 2);
  else out.lerpColors(COL_BASE, COL_LIT, (t - 0.5) * 2);
  // steep rolls and the carved skirt bands sink toward snowDeep
  const deep = smooth01((steepness - 0.05) / 0.23) * 0.3;
  if (deep > 0) out.lerp(COL_DEEP, deep);

  // ---- v2.2 groomed piste: a seeded corduroy band down the fall line ----
  // Soft edge on the band's outer 15% so the corridor never reads as a hard
  // stripe. Inside: a faint lift toward snowLit plus very faint parallel
  // ridge lines (sine along x, ~2.5 m wavelength, ~±0.6% value — just
  // perceptible, not stripey). Outside: the deeper powder look holds.
  const bandT = 1 - smooth01(clamp01((Math.abs(x) - bandHalf * 0.85) / (bandHalf * 0.15)));
  if (bandT > 0) {
    out.lerp(COL_LIT, GROOM_LIFT * bandT);
    const corr = Math.sin((x / GROOM_WL) * TAU + corrPhase);
    if (corr < 0) out.lerp(COL_SHADE, -corr * GROOM_RIDGE_AMP * bandT);
    else out.lerp(COL_LIT, corr * GROOM_RIDGE_AMP * bandT);
  } else {
    out.lerp(COL_DEEP, POWDER_DEEP);
  }
}

/** The piste heightmap: one mesh, vertex-coloured, sun-shaded. */
function buildSlopeMesh(slope: SlopeDef, material: THREE.Material): THREE.Mesh {
  const halfW = slope.width / 2;
  // v2.2: the groom is seeded too — one phase draw makes the corduroy stable
  // per mountain without touching the gameplay scatter streams.
  const corrPhase = rngRange(rng(slope.seed ^ 0xc0a1), 0, TAU);
  const bandHalf = slope.width * GROOM_BAND_FRAC;
  const x0 = -halfW - SKIRT;
  const x1 = halfW + SKIRT;
  const z0 = -Z_BACK;
  const z1 = slope.finishZ + Z_RUNOUT;
  const nx = SEG_X + 1;
  const nz = SEG_Z + 1;
  const count = nx * nz;

  const pos = new Float32Array(count * 3);
  const nor = new Float32Array(count * 3);
  const col = new Float32Array(count * 3);
  const c = new THREE.Color();

  for (let iz = 0; iz < nz; iz++) {
    const z = z0 + ((z1 - z0) * iz) / SEG_Z;
    for (let ix = 0; ix < nx; ix++) {
      const x = x0 + ((x1 - x0) * ix) / SEG_X;
      const i = iz * nx + ix;
      const h = groundHeight(slope, x, z);
      pos[i * 3] = x;
      pos[i * 3 + 1] = h;
      pos[i * 3 + 2] = z;

      // heightfield normal via central differences: (-dhdx, 1, -dhdz)
      const dhdx =
        (groundHeight(slope, x + NORMAL_EPS, z) - groundHeight(slope, x - NORMAL_EPS, z)) /
        (2 * NORMAL_EPS);
      const dhdz =
        (groundHeight(slope, x, z + NORMAL_EPS) - groundHeight(slope, x, z - NORMAL_EPS)) /
        (2 * NORMAL_EPS);
      const inv = 1 / Math.hypot(dhdx, 1, dhdz);
      const nX = -dhdx * inv;
      const nY = inv;
      const nZ = -dhdz * inv;
      nor[i * 3] = nX;
      nor[i * 3 + 1] = nY;
      nor[i * 3 + 2] = nZ;

      const sunDot = nX * SUN_DIR[0] + nY * SUN_DIR[1] + nZ * SUN_DIR[2];
      snowColor(c, sunDot, 1 - nY, x, bandHalf, corrPhase);
      col[i * 3] = c.r;
      col[i * 3 + 1] = c.g;
      col[i * 3 + 2] = c.b;
    }
  }

  const idx = new Uint32Array(SEG_X * SEG_Z * 6);
  let k = 0;
  for (let iz = 0; iz < SEG_Z; iz++) {
    for (let ix = 0; ix < SEG_X; ix++) {
      const a = iz * nx + ix;
      const b = a + 1;
      const d = a + nx;
      const e = d + 1;
      idx[k++] = a;
      idx[k++] = d;
      idx[k++] = b;
      idx[k++] = b;
      idx[k++] = d;
      idx[k++] = e;
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.computeBoundingSphere();

  const mesh = new THREE.Mesh(geo, material);
  mesh.receiveShadow = true; // the long tree shadows across the piste land HERE
  mesh.castShadow = false; // 22m skirt walls would blanket the piste in shadow
                           // at this low sun — ridge shade is painted, not cast
  return mesh;
}

// ---- vertex-coloured merge (one material-coloured group -> one geometry) ----------
// Each forest archetype is built from the shared factories (each mesh carrying
// a cached SPAL material) and collapsed into a single BufferGeometry with a
// color attribute so ONE InstancedMesh draws that archetype's whole wall in
// one call. bake() first applies every world transform, so matrices below are
// identity-safe.
function mergeVertexColored(root: THREE.Group): THREE.BufferGeometry {
  root.updateMatrixWorld(true);
  const meshes: THREE.Mesh[] = [];
  root.traverse((child) => {
    if (child instanceof THREE.Mesh) meshes.push(child);
  });
  let vCount = 0;
  let iCount = 0;
  for (const m of meshes) {
    const p = m.geometry.getAttribute('position');
    if (p === undefined) continue;
    vCount += p.count;
    const index = m.geometry.getIndex();
    iCount += index === null ? p.count : index.count;
  }
  const pos = new Float32Array(vCount * 3);
  const nor = new Float32Array(vCount * 3);
  const col = new Float32Array(vCount * 3);
  const ind = new Uint32Array(iCount);
  let vOff = 0;
  let iOff = 0;
  const nm = new THREE.Matrix3();
  const v = new THREE.Vector3();
  for (const m of meshes) {
    const geo = m.geometry;
    const p = geo.getAttribute('position');
    if (p === undefined) continue;
    const n = geo.getAttribute('normal');
    const color = (m.material as THREE.MeshLambertMaterial).color;
    nm.getNormalMatrix(m.matrixWorld);
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i).applyMatrix4(m.matrixWorld);
      pos[(vOff + i) * 3] = v.x;
      pos[(vOff + i) * 3 + 1] = v.y;
      pos[(vOff + i) * 3 + 2] = v.z;
      if (n !== undefined) {
        v.fromBufferAttribute(n, i).applyMatrix3(nm).normalize();
        nor[(vOff + i) * 3] = v.x;
        nor[(vOff + i) * 3 + 1] = v.y;
        nor[(vOff + i) * 3 + 2] = v.z;
      }
      col[(vOff + i) * 3] = color.r;
      col[(vOff + i) * 3 + 1] = color.g;
      col[(vOff + i) * 3 + 2] = color.b;
    }
    const index = geo.getIndex();
    if (index === null) {
      for (let i = 0; i < p.count; i++) ind[iOff++] = vOff + i;
    } else {
      for (let i = 0; i < index.count; i++) ind[iOff++] = vOff + index.getX(i);
    }
    vOff += p.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  out.setIndex(new THREE.BufferAttribute(ind, 1));
  out.computeBoundingSphere();
  return out;
}

/** Mature pine (the FIR): bark trunk + four stacked cones (pineDark ->
 *  pineLit), snow-dusted tier caps and a snowLit tip — the STYLE_BIBLE model
 *  sheet, scaled up to forest-tree height (proto is ~5.2 m tall before
 *  instance scale). */
function buildForestGeometry(): THREE.BufferGeometry {
  const g = new THREE.Group();
  g.add(at(cyl(mat, 0.13, 0.24, 1.3, 6, SPAL.bark), 0, 0.65, 0));
  const tiers: ReadonlyArray<readonly [number, number, number, string]> = [
    // [radius, height, baseY, hex]
    [1.55, 1.9, 0.95, SPAL.pineDark],
    [1.25, 1.7, 2.15, SPAL.pine],
    [0.95, 1.5, 3.2, SPAL.pine],
    [0.62, 1.3, 4.1, SPAL.pineLit],
  ];
  for (const [r, h, baseY, hex] of tiers) {
    g.add(at(cone(mat, r, h, 7, hex), 0, baseY + h / 2, 0));
    // snow dust cap: a short snowLit cone parked on each tier's upper slope
    g.add(at(cone(mat, r * 0.55 + 0.05, h * 0.32, 6, SPAL.snowLit), 0, baseY + h * 0.78, 0));
  }
  g.add(at(cone(mat, 0.16, 0.34, 5, SPAL.snowLit), 0, 4.1 + 1.3 - 0.08, 0));
  const baked = bake(g);
  const geo = mergeVertexColored(baked);
  // the baked group and the source group are never rendered; nothing uploaded
  return geo;
}

/** Second archetype (the SPRUCE): fewer, WIDER tiers with alternating yaw
 *  offsets, a squatter silhouette (~4.7 m before instance scale) and a
 *  heavier trunk — interleaved with the fir so the forest walls stop reading
 *  as one stamped asset. Same merge-to-one-geometry path. */
function buildSpruceGeometry(): THREE.BufferGeometry {
  const g = new THREE.Group();
  g.add(at(cyl(mat, 0.17, 0.3, 1.1, 6, SPAL.bark), 0, 0.55, 0));
  const tiers: ReadonlyArray<readonly [number, number, number, string]> = [
    // [radius, height, baseY, hex] — wide, overlapping, drooping skirt
    [2.0, 2.0, 0.7, SPAL.pineDark],
    [1.5, 1.8, 1.9, SPAL.pine],
    [1.0, 1.6, 3.05, SPAL.pineLit],
  ];
  let k = 0;
  for (const [r, h, baseY, hex] of tiers) {
    const tier = cone(mat, r, h, 7, hex);
    tier.rotation.y = (k++ % 2) * (Math.PI / 7); // offset tiers — the spruce read
    g.add(at(tier, 0, baseY + h / 2, 0));
    g.add(at(cone(mat, r * 0.5 + 0.05, h * 0.3, 6, SPAL.snowLit), 0, baseY + h * 0.76, 0));
  }
  g.add(at(cone(mat, 0.2, 0.4, 5, SPAL.snowLit), 0, 3.05 + 1.6 - 0.06, 0));
  const baked = bake(g);
  return mergeVertexColored(baked);
}

/** Forest walls: TWO InstancedMeshes (fir + spruce), both sides, sparse ->
 *  dense downhill. Every draw — archetype pick, position, rotation and the
 *  per-axis scale jitter — comes from the seeded rng, in a fixed order. */
function buildForest(slope: SlopeDef, material: THREE.Material): THREE.Group {
  const halfW = slope.width / 2;
  const next = rng(slope.seed ^ 0x5f3a);
  const z1 = slope.finishZ + FOREST_Z_PAD;

  // scatter into plain arrays first so the InstancedMeshes are sized exactly
  const px: number[] = [];
  const py: number[] = [];
  const pz: number[] = [];
  const rot: number[] = [];
  const arch: number[] = []; // 0 = fir, 1 = spruce
  const sx: number[] = [];
  const sy: number[] = [];
  const sz: number[] = [];
  for (let side = -1; side <= 1; side += 2) {
    for (let z = FOREST_Z0; z < z1; z += FOREST_STEP) {
      // density ramp: open meadows near the gate, closing walls downhill
      const lambda = 0.35 + 1.5 * smooth01((z - FOREST_Z0) / 220);
      let n = Math.floor(lambda);
      if (next() < lambda - n) n += 1;
      for (let t = 0; t < n; t++) {
        if (px.length >= FOREST_MAX) break;
        const x = side * (halfW + FOREST_IN + rngRange(next, 0, FOREST_DEPTH));
        const zz = z + rngRange(next, -FOREST_STEP / 2, FOREST_STEP / 2);
        px.push(x);
        pz.push(zz);
        py.push(groundHeight(slope, x, zz) - FOREST_SINK);
        rot.push(next() * TAU);
        arch.push(next() < SPRUCE_SHARE ? 1 : 0);
        // per-axis jitter: girth (x/z) varies independently from height (y),
        // so even same-archetype neighbours never read as clones
        const h = rngRange(next, 0.85, 1.65);
        sy.push(h);
        sx.push(h * rngRange(next, 0.85, 1.15));
        sz.push(h * rngRange(next, 0.85, 1.15));
      }
    }
  }

  const geos = [buildForestGeometry(), buildSpruceGeometry()];
  const group = new THREE.Group();
  const dummy = new THREE.Object3D();
  for (let a = 0; a < geos.length; a++) {
    const ids: number[] = [];
    for (let i = 0; i < px.length; i++) if (arch[i] === a) ids.push(i);
    if (ids.length === 0) continue; // a tiny slope may draw one archetype only
    const geo = geos[a];
    if (geo === undefined) continue;
    const mesh = new THREE.InstancedMesh(geo, material, ids.length);
    for (let k = 0; k < ids.length; k++) {
      const i = ids[k] ?? 0;
      dummy.position.set(px[i] ?? 0, py[i] ?? 0, pz[i] ?? 0);
      dummy.rotation.y = rot[i] ?? 0;
      dummy.scale.set(sx[i] ?? 1, sy[i] ?? 1, sz[i] ?? 1);
      dummy.updateMatrix();
      mesh.setMatrixAt(k, dummy.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false; // spans the whole run; the bounding sphere lies
    group.add(mesh);
  }
  return group;
}

/** v2.2 snow banks: seeded rounded mounds tucked against the piste edges
 *  (mostly outside halfW - 2, a couple near the start). VISUAL ONLY — never
 *  inside the corridor and never covering a plant. Squashed snowShade
 *  half-spheres (scale y ~0.35) with a snowLit wind-scallop cap, clustered
 *  3-5 like the plants; ~12-16 clusters, <= 120 source meshes, then baked
 *  to two draw calls. */
function buildSnowBanks(slope: SlopeDef): THREE.Group {
  const halfW = slope.width / 2;
  const next = rng(slope.seed ^ 0xb3a7);
  const g = new THREE.Group();
  const nClusters = rngInt(next, BANK_CLUSTERS_MIN, BANK_CLUSTERS_MAX);
  const clearOfPlants = (px: number, pz: number): boolean => {
    for (const pl of slope.plants) {
      const dx = pl.x - px;
      const dz = pl.z - pz;
      if (dx * dx + dz * dz < (pl.r + BANK_CLEAR) * (pl.r + BANK_CLEAR)) return false;
    }
    return true;
  };
  let meshes = 0;
  for (let cIx = 0; cIx < nClusters && meshes < BANK_MESH_CAP; cIx++) {
    const side = cIx % 2 === 0 ? -1 : 1;
    const nearStart = cIx < 2;
    const cz = nearStart ? rngRange(next, 2, 30) : rngRange(next, 20, slope.finishZ + 70);
    const cx = side * (halfW - 2 + rngRange(next, 0.2, 4.2));
    const n = rngInt(next, BANK_SIZE_MIN, BANK_SIZE_MAX);
    for (let b = 0; b < n && meshes < BANK_MESH_CAP; b++) {
      const bx = cx + rngRange(next, -3, 3);
      const bz = cz + rngRange(next, -5, 5);
      if (!clearOfPlants(bx, bz)) continue; // dressing never covers a plant
      const r = rngRange(next, 1.4, 3.2);
      const baseY = groundHeight(slope, bx, bz);
      const bank = sphere(mat, r, 6, SPAL.snowShade);
      bank.scale.set(1, 0.35, 1);
      bank.rotation.y = next() * TAU;
      g.add(at(bank, bx, baseY - r * 0.3, bz));
      meshes++;
      // wind-scallop cap: a wider snowLit dome nudged downwind (+z)
      const cap = sphere(mat, r * 1.12, 6, SPAL.snowLit);
      cap.scale.set(1, 0.18, 1);
      cap.rotation.y = next() * TAU;
      g.add(at(cap, bx, baseY + r * 0.12, bz + r * 0.18));
      meshes++;
    }
  }
  return bake(g);
}

/** Ridge-line rock outcrops on the rising skirt, snow-dusted, baked. v2.2:
 *  angular fracture — each boulder is 2-3 interlocking squashed masses in
 *  rockLit/rock (spheres and boxes so facets catch the low sun), with a
 *  snowLit snow skirt on the uphill face and a snowShade shadow crease at
 *  the base — plus ~20 small debris rocks near the piste edge for foreground
 *  scale. Still baked to a handful of draw calls. */
function buildRocks(slope: SlopeDef): THREE.Group {
  const halfW = slope.width / 2;
  const next = rng(slope.seed ^ 0x9e37);
  const g = new THREE.Group();
  for (let cIx = 0; cIx < ROCK_CLUSTERS; cIx++) {
    const side = cIx % 2 === 0 ? -1 : 1;
    const cz = rngRange(next, 20, slope.finishZ + 80);
    const cx = side * (halfW + ROCK_IN + rngRange(next, 0, ROCK_SPREAD));
    const nBoulders = rngInt(next, 2, 5);
    for (let b = 0; b < nBoulders; b++) {
      const r = rngRange(next, 0.9, 3.2);
      const bx = cx + rngRange(next, -4, 4);
      const bz = cz + rngRange(next, -6, 6);
      const baseY = groundHeight(slope, bx, bz);
      const mainHex = next() < 0.5 ? SPAL.rock : SPAL.rockLit;
      const chunkHex = mainHex === SPAL.rock ? SPAL.rockLit : SPAL.rock;
      // main mass: squashed sphere or a box, tilted so facets catch the sun
      const main =
        next() < 0.6
          ? sphere(mat, r, 5, mainHex)
          : box(mat, r * 1.9, r * 1.15, r * 1.5, mainHex);
      main.scale.set(1, rngRange(next, 0.55, 0.85), 1);
      main.rotation.set(rngRange(next, -0.2, 0.2), next() * TAU, rngRange(next, -0.2, 0.2));
      g.add(at(main, bx, baseY - r * 0.35, bz));
      // fracture chunks: 1-2 interlocking smaller masses, the other rock tone
      const nChunks = rngInt(next, 1, 2);
      for (let f = 0; f < nChunks; f++) {
        const fr = r * rngRange(next, 0.3, 0.55);
        const chunk =
          next() < 0.5
            ? sphere(mat, fr, 5, chunkHex)
            : box(mat, fr * 2, fr * 1.4, fr * 1.7, chunkHex);
        chunk.rotation.set(rngRange(next, -1, 1), next() * TAU, rngRange(next, -1, 1));
        g.add(at(chunk, bx + rngRange(next, -0.75, 0.75) * r, baseY - fr * 0.45 + rngRange(next, 0, r * 0.4), bz + rngRange(next, -0.3, 0.8) * r));
      }
      // snow skirt on the uphill face (toward -z): a larger flattened cap
      const skirt = sphere(mat, r * 1.15, 5, SPAL.snowLit);
      skirt.scale.set(1, 0.28, 1);
      skirt.rotation.y = next() * TAU;
      g.add(at(skirt, bx, baseY + r * 0.2, bz - r * 0.45));
      // shadow crease at the base (downhill side reads as the snow contact)
      const crease = sphere(mat, r * 1.05, 5, SPAL.snowShade);
      crease.scale.set(1, 0.1, 1);
      crease.rotation.y = next() * TAU;
      g.add(at(crease, bx, baseY - r * 0.16, bz + r * 0.3));
    }
  }
  // small debris rocks near the piste edge — foreground scale at speed
  for (let d = 0; d < DEBRIS_COUNT; d++) {
    const side = next() < 0.5 ? -1 : 1;
    const dz = rngRange(next, 8, slope.finishZ + 60);
    const dx = side * rngRange(next, halfW - 10, halfW - 2.5);
    const dr = rngRange(next, 0.15, 0.3); // 0.3-0.6 m across
    const hex = next() < 0.5 ? SPAL.rock : SPAL.rockLit;
    const deb =
      next() < 0.6
        ? sphere(mat, dr, 4, hex)
        : box(mat, dr * 2, dr * 1.1, dr * 1.5, hex);
    deb.rotation.set(rngRange(next, -0.7, 0.7), next() * TAU, rngRange(next, -0.7, 0.7));
    g.add(at(deb, dx, groundHeight(slope, dx, dz) - dr * 0.4, dz));
  }
  return bake(g);
}

/** One ring of distant silhouette cards (far peaks or nearer foothills).
 *  fog:false with the haze BAKED into the vertex colours — FogExp2 would
 *  otherwise reduce them to invisible fog rectangles. §2.5-exempt geometry;
 *  every colour is a SPAL lerp toward skyHorizon. `round` swaps the jagged
 *  far-peak polyline for the lower, rounder foothill profile. */
function buildPeakRing(
  slope: SlopeDef,
  salt: number,
  count: number,
  rMin: number,
  rMax: number,
  wMin: number,
  wMax: number,
  hMin: number,
  hMax: number,
  baseYMin: number,
  baseYMax: number,
  hazeBase: THREE.Color,
  hazeTop: THREE.Color,
  round: boolean,
): THREE.Mesh {
  const next = rng(slope.seed ^ salt);

  const pos: number[] = [];
  const col: number[] = [];
  const c = new THREE.Color();
  const pushVert = (x: number, y: number, z: number, t: number): void => {
    pos.push(x, y, z);
    c.lerpColors(hazeBase, hazeTop, t);
    col.push(c.r, c.g, c.b);
  };

  for (let i = 0; i < count; i++) {
    const az = (i / count) * TAU + rngRange(next, -0.14, 0.14);
    const radius = rngRange(next, rMin, rMax);
    const cx = Math.sin(az) * radius;
    const cz = Math.cos(az) * radius;
    // local lateral axis (perpendicular to the view direction at the ring)
    const lx = Math.cos(az);
    const lz = -Math.sin(az);
    const w = rngRange(next, wMin, wMax);
    const h = rngRange(next, hMin, hMax);
    const baseY = rngRange(next, baseYMin, baseYMax);
    // silhouette polyline: base-left ... apex ... base-right
    const shape: ReadonlyArray<readonly [number, number]> = round
      ? [
          [-0.5, 0],
          [-0.34, rngRange(next, 0.55, 0.72)],
          [-0.17, rngRange(next, 0.72, 0.86)],
          [rngRange(next, -0.05, 0.05), 1],
          [0.17, rngRange(next, 0.72, 0.86)],
          [0.34, rngRange(next, 0.55, 0.72)],
          [0.5, 0],
        ]
      : [
          [-0.5, 0],
          [-0.22, rngRange(next, 0.4, 0.62)],
          [rngRange(next, -0.08, 0.08), 1],
          [0.24, rngRange(next, 0.42, 0.66)],
          [0.5, 0],
        ];
    const first = shape[0] ?? [-0.5, 0];
    for (let t = 1; t < shape.length - 1; t++) {
      const a = shape[t] ?? [0, 1];
      const b = shape[t + 1] ?? [0.5, 0];
      pushVert(cx + lx * first[0] * w, baseY + first[1] * h, cz + lz * first[0] * w, first[1]);
      pushVert(cx + lx * a[0] * w, baseY + a[1] * h, cz + lz * a[0] * w, a[1]);
      pushVert(cx + lx * b[0] * w, baseY + b[1] * h, cz + lz * b[0] * w, b[1]);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(col), 3));
  const material = new THREE.MeshBasicMaterial({
    vertexColors: true,
    fog: false,
    side: THREE.DoubleSide,
  });
  peakCardMaterials.push(material); // scene disposes with the terrain root
  const mesh = new THREE.Mesh(geo, material);
  mesh.frustumCulled = false;
  return mesh;
}

/** Distant peak cards: jagged ridge silhouettes pre-hazed into skyHorizon
 *  at ~640-860 m — the far depth plane. */
function buildPeakCards(slope: SlopeDef): THREE.Mesh {
  const hazeBase = new THREE.Color(SPAL.skyHorizon).lerp(new THREE.Color(SPAL.snowShade), 0.45);
  const hazeTop = new THREE.Color(SPAL.skyHorizon).lerp(new THREE.Color(SPAL.snowLit), 0.3);
  return buildPeakRing(
    slope, 0x51ab, PEAK_COUNT,
    640, 860, 200, 340, 120, 240, -190, -150,
    hazeBase, hazeTop, false,
  );
}

/** v2.2 nearer foothills: a second, rounder ridge at ~380-460 m, hazed only
 *  ~50% toward skyHorizon (the card colours mixed half with the full haze) so
 *  the world reads in three depth planes instead of two. Lower and rounder
 *  than the far peaks, fog:false like them. */
function buildFoothills(slope: SlopeDef): THREE.Mesh {
  const hazeBase = new THREE.Color(SPAL.snowShade).lerp(new THREE.Color(SPAL.skyHorizon), 0.5);
  const hazeTop = new THREE.Color(SPAL.snowLit).lerp(new THREE.Color(SPAL.skyHorizon), 0.5);
  return buildPeakRing(
    slope, 0x7e4d, FOOTHILL_COUNT,
    380, 460, 150, 220, 70, 130, -125, -95,
    hazeBase, hazeTop, true,
  );
}

/** Peak-card materials are NOT in the mat() cache (exempt unlit) — tracked so
 *  scene.ts can dispose them on terrain rebuild. */
const peakCardMaterials: THREE.Material[] = [];

/** Module-lazy vertex-colour Lamberts, shared across rebuilds (one program). */
let terrainMat: THREE.MeshLambertMaterial | null = null;
let forestMat: THREE.MeshLambertMaterial | null = null;

function terrainMaterial(): THREE.MeshLambertMaterial {
  if (!terrainMat) {
    terrainMat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  }
  return terrainMat;
}

function forestMaterial(): THREE.MeshLambertMaterial {
  if (!forestMat) {
    forestMat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  }
  return forestMat;
}

/**
 * The whole mountain: piste heightmap + forest walls + ridge rocks + horizon
 * peak cards, as one group the scene adds/removes on seed change. Idempotent:
 * the previous build's non-cached materials are disposed here (the caller
 * disposes geometries when it drops the old root).
 */
export function buildTerrain(slope: SlopeDef): THREE.Group {
  for (const m of peakCardMaterials) m.dispose();
  peakCardMaterials.length = 0;
  const root = new THREE.Group();
  root.add(buildSlopeMesh(slope, terrainMaterial()));
  root.add(buildForest(slope, forestMaterial()));
  root.add(buildSnowBanks(slope));
  root.add(buildRocks(slope));
  root.add(buildFoothills(slope));
  root.add(buildPeakCards(slope));
  return root;
}
