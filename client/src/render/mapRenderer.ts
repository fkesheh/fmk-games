// ============================================================================
// C3 — map renderer: MapDef (pure data) => baked static geometry + solids.
// Ground slab, sky dome (the ONE raw-geometry/MeshBasicMaterial exception),
// one box() per BoxDef, and seeded deco prop scatter — everything static is
// merged by bake() into ~1 mesh per material (<= ~20 draw calls total).
// Determinism: all scatter/jitter comes from rng(decoSeed(map.id, zoneIndex));
// Math.random is never touched. Props are client-only dressing: non-collidable,
// never inside solids (AABB inflated 0.5m) or within 2.5m of any spawn.
// ============================================================================
import * as THREE from 'three';
import {
  PALETTE,
  boxToAABB,
  decoSeed,
  rng,
  rngInt,
  rngRange,
  type AABB,
  type DecoKind,
  type MapDef,
  type MatId,
} from '@fps/shared';
import { at, bake, box, cyl, sphere } from '../contract/visual.js';

// ---- MatId -> PALETTE (frozen mapping, see STYLE_BIBLE.md) -------------------
export const MAT_COLORS: Record<MatId, string> = {
  sand: PALETTE.sand,
  sandDark: PALETTE.sandDark,
  concrete: PALETTE.concrete,
  concreteDark: PALETTE.concreteDark,
  metal: PALETTE.steel,
  metalDark: PALETTE.metalDark,
  wood: PALETTE.wood,
  crate: PALETTE.crate,
  brick: PALETTE.brick,
  plaster: PALETTE.plaster,
  roofRed: PALETTE.roofRed,
  carpet: PALETTE.carpet,
  desk: PALETTE.deskTop,
  paper: PALETTE.paper,
  snow: PALETTE.snow,
  ice: PALETTE.ice,
  rock: PALETTE.rockDark,
  leaf: PALETTE.leaf,
  cactus: PALETTE.cactus,
};

// ---- scatter tuning (frozen by CONTRACT/C3 spec) ------------------------------
const SOLID_PAD = 0.5; // solids inflated by this when rejecting prop points
const SPAWN_CLEARANCE = 2.5; // min prop distance to any spawn
const MAX_ATTEMPTS_PER_PROP = 30; // termination cap for rejection sampling
const DOME_RADIUS = 400;

/**
 * Build the whole map: ground, sky dome, collidable boxes, deco scatter.
 * Returns the renderable root group and the collision solids (same AABBs the
 * server derives — boxToAABB per BoxDef, order preserved).
 */
export function buildMap(map: MapDef): { root: THREE.Group; solids: AABB[] } {
  const solids = map.boxes.map(boxToAABB);
  const statics = new THREE.Group();

  // ---- ground: factory box as a slab; top surface at y=-0.01, 8m apron ----
  statics.add(at(box(map.sizeX + 8, 0.02, map.sizeZ + 8, MAT_COLORS[map.floorMat]), 0, -0.02, 0));

  // ---- collidable boxes at exact BoxDef coords ------------------------------
  for (const b of map.boxes) {
    statics.add(at(box(b.w, b.h, b.d, MAT_COLORS[b.mat]), b.x, b.y, b.z));
  }

  // ---- deco scatter: seeded per zone, rejection-sampled ----------------------
  const placed: Array<{ x: number; z: number }> = []; // all zones share spacing knowledge
  map.deco.forEach((zone, zoneIndex) => {
    const next = rng(decoSeed(map.id, zoneIndex));
    let placedInZone = 0;
    const maxAttempts = zone.count * MAX_ATTEMPTS_PER_PROP;
    for (let attempt = 0; attempt < maxAttempts && placedInZone < zone.count; attempt++) {
      const x = rngRange(next, zone.x0, zone.x1);
      const z = rngRange(next, zone.z0, zone.z1);
      if (insideSolid(x, z, solids)) continue;
      if (nearSpawn(x, z, map)) continue;
      if (tooClose(x, z, placed, zone.minSpacing)) continue;
      placed.push({ x, z });
      placedInZone++;
      const prop = buildProp(zone.kind, next);
      prop.position.set(x, 0, z);
      statics.add(prop);
    }
  });

  const root = new THREE.Group();
  root.add(bake(statics)); // one merged mesh per material, shadows on
  root.add(makeSkyDome(map)); // unbaked: must never cast/receive shadows
  return { root, solids };
}

// ---- scatter rejections -------------------------------------------------------

/** Point (ground plane) vs every solid, each AABB inflated by SOLID_PAD. */
function insideSolid(x: number, z: number, solids: AABB[]): boolean {
  for (const s of solids) {
    if (x > s.minX - SOLID_PAD && x < s.maxX + SOLID_PAD && z > s.minZ - SOLID_PAD && z < s.maxZ + SOLID_PAD) {
      return true;
    }
  }
  return false;
}

/** Props never crowd spawn points (both teams). */
function nearSpawn(x: number, z: number, map: MapDef): boolean {
  const d2 = SPAWN_CLEARANCE * SPAWN_CLEARANCE;
  for (const s of map.spawns.T) {
    const dx = s.x - x;
    const dz = s.z - z;
    if (dx * dx + dz * dz < d2) return true;
  }
  for (const s of map.spawns.CT) {
    const dx = s.x - x;
    const dz = s.z - z;
    if (dx * dx + dz * dz < d2) return true;
  }
  return false;
}

/** Min center distance to every already-placed prop. */
function tooClose(x: number, z: number, placed: ReadonlyArray<{ x: number; z: number }>, minSpacing: number): boolean {
  const d2 = minSpacing * minSpacing;
  for (const p of placed) {
    const dx = p.x - x;
    const dz = p.z - z;
    if (dx * dx + dz * dz < d2) return true;
  }
  return false;
}

// ---- sky dome (factory exception, CONTRACT rule 5) -----------------------------
// Raw SphereGeometry + MeshBasicMaterial with manual vertex colors: the single
// non-Lambert surface in the game. Gradient theme.sky (top) -> theme.horizon.

function makeSkyDome(map: MapDef): THREE.Mesh {
  const geo = new THREE.SphereGeometry(DOME_RADIUS, 24, 12);
  const pos = geo.getAttribute('position');
  const colors = new Float32Array(pos.count * 3);
  const top = new THREE.Color(map.theme.sky); // linear work-space, same as mat()
  const bottom = new THREE.Color(map.theme.horizon);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const t = smooth01(pos.getY(i) / DOME_RADIUS / 2 + 0.5);
    c.copy(bottom).lerp(top, t);
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const dome = new THREE.Mesh(
    geo,
    new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false }),
  );
  dome.frustumCulled = false; // the dome always encloses the camera
  return dome;
}

function smooth01(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
}

// ---- deco prop recipes (CONTRACT model sheets: 3-10 prims, PALETTE only) ------
// Every builder fills a group sitting on y=0; buildProp adds yaw + scale jitter.

function buildProp(kind: DecoKind, next: () => number): THREE.Group {
  const g = new THREE.Group();
  switch (kind) {
    case 'crate':
      buildCrate(g);
      break;
    case 'barrel':
      buildBarrel(g, next);
      break;
    case 'pallet':
      buildPallet(g);
      break;
    case 'pipe':
      buildPipe(g);
      break;
    case 'rock':
      scatterRocks(g, next, PALETTE.rockDark);
      break;
    case 'shrub':
      buildShrub(g, next);
      break;
    case 'cactus':
      buildCactus(g, next);
      break;
    case 'snowRock':
      buildSnowRock(g, next);
      break;
    case 'plant':
      buildPlant(g, next);
      break;
    case 'paperStack':
      buildPaperStack(g, next);
      break;
  }
  g.rotation.y = next() * Math.PI * 2; // slight organic yaw jitter
  g.scale.setScalar(rngRange(next, 0.85, 1.2));
  return g;
}

/** crate: wood box + 4 woodDark edge battens. */
function buildCrate(g: THREE.Group): void {
  const S = 0.9;
  const B = 0.09;
  g.add(at(box(S, S, S, PALETTE.wood), 0, S / 2, 0));
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      g.add(at(box(B, S, B, PALETTE.woodDark), (sx * (S - B)) / 2, S / 2, (sz * (S - B)) / 2));
    }
  }
}

/** barrel: cyl (steel or tBrown by rng) + 2 thin rim bands. */
function buildBarrel(g: THREE.Group, next: () => number): void {
  const R = 0.34;
  const H = 0.92;
  const body = next() < 0.5 ? PALETTE.steel : PALETTE.tBrown;
  g.add(at(cyl(R, R, H, 12, body), 0, H / 2, 0));
  g.add(at(cyl(R + 0.03, R + 0.03, 0.07, 12, PALETTE.metalDark), 0, H * 0.28, 0));
  g.add(at(cyl(R + 0.03, R + 0.03, 0.07, 12, PALETTE.metalDark), 0, H * 0.72, 0));
}

/** pallet: 3 slats over 2 beams. */
function buildPallet(g: THREE.Group): void {
  for (const z of [-0.35, 0, 0.35]) {
    g.add(at(box(1.15, 0.04, 0.28, PALETTE.wood), 0, 0.11, z));
  }
  for (const x of [-0.42, 0.42]) {
    g.add(at(box(0.14, 0.09, 1.0, PALETTE.woodDark), x, 0.045, 0));
  }
}

/** pipe: horizontal steel cyl + 2 ring flanges + vertical elbow riser. */
function buildPipe(g: THREE.Group): void {
  const R = 0.14;
  const L = 1.8;
  const run = at(cyl(R, R, L, 10, PALETTE.steel), 0, R, 0);
  run.rotation.z = Math.PI / 2; // axis along x, resting on the ground
  g.add(run);
  for (const x of [-0.55, 0.55]) {
    const flange = at(cyl(R + 0.06, R + 0.06, 0.08, 10, PALETTE.metalDark), x, R, 0);
    flange.rotation.z = Math.PI / 2;
    g.add(flange);
  }
  g.add(at(cyl(R, R, 0.9, 10, PALETTE.steel), L / 2 - R, R + 0.42, 0)); // elbow up at one end
}

/** rock/snowRock core: 2-3 overlapping squashed spheres; returns top y. */
function scatterRocks(g: THREE.Group, next: () => number, hex: string): number {
  let top = 0;
  const n = rngInt(next, 2, 3);
  for (let i = 0; i < n; i++) {
    const r = rngRange(next, 0.35, 0.6);
    const sy = rngRange(next, 0.45, 0.7);
    const cy = r * 0.45;
    const m = at(sphere(r, 7, hex), rngRange(next, -0.3, 0.3), cy, rngRange(next, -0.3, 0.3));
    m.scale.set(rngRange(next, 0.9, 1.3), sy, rngRange(next, 0.9, 1.3));
    m.rotation.y = next() * Math.PI;
    g.add(m);
    top = Math.max(top, cy + r * sy);
  }
  return top;
}

/** snowRock: rock recipe in snowShadow + snow cap sphere on top. */
function buildSnowRock(g: THREE.Group, next: () => number): void {
  const top = scatterRocks(g, next, PALETTE.snowShadow);
  const cap = at(sphere(0.4, 7, PALETTE.snow), 0, top + 0.05, 0);
  cap.scale.y = 0.35;
  g.add(cap);
}

/** shrub: 2-3 small leaf/leafDark spheres on a tiny trunk. */
function buildShrub(g: THREE.Group, next: () => number): void {
  g.add(at(cyl(0.035, 0.05, 0.3, 6, PALETTE.woodDark), 0, 0.15, 0));
  const n = rngInt(next, 2, 3);
  for (let i = 0; i < n; i++) {
    const r = rngRange(next, 0.22, 0.38);
    const hex = next() < 0.5 ? PALETTE.leaf : PALETTE.leafDark;
    g.add(at(sphere(r, 6, hex), rngRange(next, -0.18, 0.18), 0.3 + i * 0.16 + r * 0.4, rngRange(next, -0.18, 0.18)));
  }
}

/** cactus: main column + cap, 1-2 arms (horizontal + vertical + tip) = 5-7 prims. */
function buildCactus(g: THREE.Group, next: () => number): void {
  const H = rngRange(next, 1.1, 1.6);
  g.add(at(cyl(0.16, 0.2, H, 8, PALETTE.cactus), 0, H / 2, 0));
  g.add(at(sphere(0.16, 6, PALETTE.cactus), 0, H, 0));
  const arms = rngInt(next, 1, 2);
  for (let i = 0; i < arms; i++) {
    const side = i === 0 ? 1 : -1;
    const ay = H * rngRange(next, 0.45, 0.65);
    const h = at(cyl(0.1, 0.1, 0.36, 6, PALETTE.cactus), side * 0.3, ay, 0);
    h.rotation.z = Math.PI / 2;
    g.add(h);
    g.add(at(cyl(0.1, 0.1, 0.42, 6, PALETTE.cactus), side * 0.44, ay + 0.21, 0));
    g.add(at(sphere(0.1, 6, PALETTE.cactus), side * 0.44, ay + 0.42, 0));
  }
}

/** plant: thin brick pot + 3 leaf spheres. */
function buildPlant(g: THREE.Group, next: () => number): void {
  g.add(at(cyl(0.16, 0.12, 0.3, 8, PALETTE.brick), 0, 0.15, 0));
  for (let i = 0; i < 3; i++) {
    const r = rngRange(next, 0.14, 0.22);
    const hex = i % 2 === 0 ? PALETTE.leaf : PALETTE.leafDark;
    g.add(at(sphere(r, 6, hex), rngRange(next, -0.1, 0.1), 0.34 + i * 0.12, rngRange(next, -0.1, 0.1)));
  }
}

/** paperStack: 2-4 thin paper boxes with slight rotation offsets. */
function buildPaperStack(g: THREE.Group, next: () => number): void {
  const n = rngInt(next, 2, 4);
  for (let i = 0; i < n; i++) {
    const p = at(
      box(0.32, 0.025, 0.24, PALETTE.paper),
      rngRange(next, -0.03, 0.03),
      0.0125 + i * 0.026,
      rngRange(next, -0.03, 0.03),
    );
    p.rotation.y = rngRange(next, -0.4, 0.4);
    g.add(p);
  }
}
