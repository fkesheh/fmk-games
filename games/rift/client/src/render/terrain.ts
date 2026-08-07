// ============================================================================
// ANCIENTS (rift) — TERRAIN (R_TERRAIN). The walkable heightfield, the cliff
// faces that ring every plateau and base, the ramps cut through them, the
// river bed and its animated water sheet. Everything whose shape comes from
// `MapDef.terrain`. Scattered props are R_VEG's; lane kerbs, structure
// platforms and landmarks are R_MAPMESH's.
//
// ---- THE ONE INVARIANT THIS MODULE EXISTS TO KEEP ---------------------------
// "What looks like a cliff must be impassable, and what looks like a ramp must
// be walkable." Two rules follow from it and decide every line below.
//
// 1. THE WALKABLE SURFACE IS `scene.heightAt`, NOT AN INTERPRETATION OF IT.
//    R_UNITS puts feet, R_MAPMESH puts plinths and R_SCENE rides the camera on
//    `heightAt`. Any vertex of a PASSABLE cell that disagrees with it is a unit
//    sunk into the ground or floating over it. So every passable cell's corner
//    height is `heightAt` sampled at that very corner and nothing else — no
//    smoothing toward a "nicer" profile, no ramp embankments, no erosion. The
//    visual invention happens where nothing can stand.
//
// 2. THE CLIFF RING IS WHERE THE INVENTION GOES. `buildTerrain` guarantees that
//    every low cell orthogonally touching high ground is a `'cliff'` cell
//    (shared/terrain.ts stage 4), so the impassable ring is exactly one metre
//    thick and exactly where the rock belongs. This module renders that ring as
//    the rock face itself: it rises from the low ground at the ring's outer edge
//    to the plateau at its inner edge over that one metre, subdivided 3x3,
//    bulged, jittered, capped with a broken overhanging lip and skirted with
//    talus. Impassable cell <-> visibly unclimbable rock, with no cell of slack
//    either way. It is ALSO why the module never smooths a cliff into a slope: a
//    tessellation that merely followed `heightAt` across the ring would render
//    whatever transition R_SCENE chose — most likely a walkable-looking hill —
//    and players would fight the map.
//
// Ramps fall out for free and are never special-cased in the geometry: a ramp
// cell is PASSABLE, so it tessellates against `heightAt` like any other ground,
// and the ring cells flanking it stay rock. A notch of walkable slope through a
// wall of rock is exactly what a ramp is.
//
// ---- HOW THE SURFACE IS MADE WATERTIGHT -------------------------------------
// Two corner lattices over the (dim+1)^2 grid corners, not one:
//   LO[c] = the height the LOW level sits at here, meaned over the incident
//           cells that are passable and ELEV_LOW;
//   HI[c] = the same for the incident cells that are passable and ELEV_HIGH
//           (which includes ramps).
// At a corner no rock touches and only one level reaches, the two collapse to
// one value read straight out of `heightAt` at that corner, so the surface
// passes exactly through the sampler. They separate only in the collar of
// corners the ring touches, which is where the whole point of separating them
// lives and where nothing but rock stands.
//
// A passable low cell reads LO at all four corners, a passable high cell reads
// HI, and a RAMP reads LO at any corner that has a passable low neighbour and HI
// elsewhere — which is what makes the ramp mouth continuous with the ground and
// its head continuous with the plateau, in one rule with no direction test.
//
// Two passable cells that share an EDGE always resolve that edge to the same
// pair of corner values (`buildTerrain` never puts a low cell orthogonally
// beside a high one — the ring is between them — and the ramp rule above covers
// the only case where a passable low and a passable high cell do touch). Two
// passable cells at different levels can still meet at a POINT, diagonally
// across two ring cells; a point hole has no area and no shading. Everywhere a
// height does jump across an edge, a wall strip closes it explicitly, so the
// mesh is watertight by construction rather than by tolerance.
//
// Cliff cells read a third value, CAP = HI where the corner sees any high
// ground and LO otherwise, which is what makes the ring's inner edge flush with
// the plateau and its outer edge flush with the ground.
//
// ---- THE FIVE LAWS ----------------------------------------------------------
// MATERIAL: every material comes from the kit — this module names `SurfaceId`s
//   on `Part`s and lets `bake()` construct them. The only direct kit material
//   calls are `surface('riverWater')` and `surface('cliffRock')`, to reach the
//   cached instances whose ripple normal map is scrolled and whose meshes carry
//   the shadow-caster flag. Nothing here constructs a THREE material.
// VERTEX COLOUR: none of this geometry comes out of a kit primitive, so every
//   part gets `whiteVertexColors(geo)` FIRST — that call is what creates the
//   attribute — and the shading terms are multiplied into it afterwards, never
//   assigned over it. Rock parts then take `bakeVertexAO` on top, which
//   multiplies again. Skip the first call and the whole map renders black.
// UV: not authored at all. `bake()` rewrites UVs into world space at 1 unit =
//   1 metre, per triangle, projecting near-vertical faces onto XY/ZY. That is
//   also the answer to "cliffs need their own UV scale": a hand-set scale is
//   banned outright (STYLE_BIBLE §11), and the per-face projection is what gives
//   the strata map a correct, non-degenerate footprint on a vertical wall.
// DETERMINISM: no `Math.random`, no clock in any geometry decision. Every
//   variation is a lattice of `rng(seed)` values indexed by cell or by
//   sub-vertex, so the same lane count builds the same map on every machine and
//   in every judge round. The clock is read for one purpose only — how much of
//   the bake to do this frame.
// BLOOM: nothing here is emissive, so nothing here is marked.
//
// ---- COST -------------------------------------------------------------------
// One `bakeChunked` per 16x16 m chunk (GRAPHICS_CONTRACT §5: never one map-wide
// merge — that is one draw call with no frustum culling, a different failure).
// The chunks are built and stepped from this module's own frame hook inside a
// per-frame slice, so the 150 ms cold-load budget is spent across frames instead
// of frozen into one. Once `ready()` is true the hook does nothing but advance
// two texture offsets: no allocation, no work.
// ============================================================================
import * as THREE from 'three';
import { ELEV_HIGH, TERRAIN_KINDS } from '@rift/shared';
import type { MapDef, SurfaceId, TerrainKind } from '@rift/shared';
import type { SceneHandle, TerrainHandle } from '../contract.js';
import { sceneCore, whiteVertexColors } from './core.js';
import { bakeChunked, bakeVertexAO, rng, surface } from './kit.js';
import type { ChunkedBake, Part } from './kit.js';

// ---- tuning -----------------------------------------------------------------
// Art direction transcribed from STYLE_BIBLE §2/§8 and the budgets of
// GRAPHICS_CONTRACT §5. None of it is a per-call-site dial.

/** Spatial bake granularity in metres (GRAPHICS_CONTRACT §5). */
const CHUNK_M = 16;
/** Main-thread slice per frame for construction. Comfortably inside one 60 fps
 *  frame; the 150 ms total budget is met by how many frames it takes. */
const SLICE_MS = 6;
/** Sub-quads per axis on a cliff cell's rock face. Three is what buys the face
 *  a bulge and a base-to-rim shade ramp; the boundary ring of the patch stays
 *  on the straight line between the cell's corners so the seam with the
 *  neighbouring surface quad is exact. */
const CLIFF_SUB = 3;
/** Maximum lateral / vertical break of a cliff sub-vertex, in metres. Applied
 *  ONLY where every cell incident to that sub-vertex is itself a cliff cell, so
 *  a jittered vertex can never open a seam against the walkable surface. */
const CLIFF_JITTER_XZ = 0.16;
const CLIFF_JITTER_Y = 0.22;
/** Amplitude of the per-cell bulge/undercut on a rock face. Vanishes at the
 *  cell boundary (a sin(pi u) sin(pi v) bump), which is what keeps two adjacent
 *  faces sharing an edge in exact agreement. */
const CLIFF_BULGE = 0.38;
/** The overhanging lip along a plateau rim: how far it stands proud of the rim
 *  and how far it hangs down. The rim is the line the 55 deg camera reads first,
 *  and a clean 1 m staircase there is the single loudest "extruded ground" tell.
 *  A quarter of rim edges get no lip at all, so the line is genuinely broken. */
const LIP_OUT_MIN = 0.1;
const LIP_OUT_MAX = 0.3;
const LIP_DROP_MIN = 0.2;
const LIP_DROP_MAX = 0.55;
const LIP_SKIP = 0.25;
/** Talus at the foot of a rock face: a low wedge leaning against the wall on a
 *  fraction of the ring's outward edges, to break the base line the same way the
 *  lip breaks the rim. Kept short enough that a unit standing against the cliff
 *  base does not visibly wade through it. */
const TALUS_CHANCE = 0.42;
const TALUS_OUT_MIN = 0.2;
const TALUS_OUT_MAX = 0.45;
const TALUS_H_MIN = 0.3;
const TALUS_H_MAX = 0.8;
/** Water sheet thickness mid-channel; it tapers to zero at the bank so the sheet
 *  meets the shore exactly instead of standing on it as a slab. Units wade —
 *  which is the intended read of "shallow moving water" — and the river has no
 *  gameplay effect whatsoever (DESIGN_DELTA §4). */
const WATER_DEPTH = 0.22;
/** Metres over which the sheet reaches full depth, measured from the bank. */
const WATER_TAPER = 2.2;
/** Ripple scroll, UV units per millisecond, on the two axes of the shared
 *  `ripple` normal map. Slow and cross-grained: a still frame of a MOBA should
 *  never look still (STYLE_BIBLE §9), but a fast scroll reads as a conveyor. */
const RIPPLE_U_PER_MS = 0.0000185;
const RIPPLE_V_PER_MS = 0.000033;
/** How far the world drops at the map frame. The boundary is bare rock by
 *  intent (STYLE_BIBLE §8); without a skirt the camera sees under the map at
 *  the far edge and the world reads as a cut-out. */
const SKIRT_DEPTH = 9;
/** Baked-AO strength on rock parts. The screen-space pass (R_POST) is the other
 *  half of the AO story; this half survives into the shadow side of every
 *  crevice where the screen-space pass has no depth gradient to work with. */
const CLIFF_AO = 0.55;
/** Vertex-shade floor. Vertex colour multiplies albedo, so it can only darken;
 *  a floor keeps the darkest contact band off black, which matters because moss
 *  is already the darkest large surface in the game. */
const SHADE_FLOOR = 0.42;
/** Broad value variation on the ground, as a multiplicative range. Ground
 *  variation comes from this and from the family's own normal/roughness maps —
 *  never from flat quads laid on the plane (STYLE_BIBLE §10a.1). */
const VALUE_VAR = 0.13;
/** Metres of wear bleeding out from lanes, ramps, bases and camp floors before
 *  the moss takes over, modulated by noise so the fringe is ragged. */
const WEAR_REACH = 3.2;
/** Noise lattice edge. The sampled period is `NOISE_DIM * metresPerCell`, which
 *  is >= 280 m for every frequency used here — longer than the biggest map, so
 *  no field can repeat inside a frame. */
const NOISE_DIM = 64;
/** A material bucket smaller than this, in triangles, is not worth a draw call:
 *  measured on the 3-lane map, the smallest 41 buckets of 271 carried 0.9% of
 *  the geometry between them. Below the threshold the triangles are folded into
 *  a neighbouring family that IS worth one (see FOLD_INTO), which costs a few
 *  square metres of the wrong-but-related ground and buys back a fifth of the
 *  terrain's draw calls. Vertex data is family-independent, so a fold is a
 *  concatenation and nothing has to be rebuilt. */
const MIN_BUCKET_TRIS = 40;
/** Where a marginal bucket goes. Each step is a family that reads as a
 *  plausible substitute at a few square metres: worn earth and a wet bank both
 *  fall back to the moss they sit in, a base fringe to the paving it continues.
 *  `cliffRock` and `riverWater` are deliberately absent — rock folded into moss
 *  would paint a green vertical face, and the water sheet is transparent and
 *  has no substitute at all. */
const FOLD_INTO: Partial<Record<SurfaceId, SurfaceId>> = {
  groundDirt: 'groundMoss',
  wetRock: 'groundMoss',
  monumentStone: 'lanePaving',
  lanePaving: 'groundDirt',
};

// ---- small math -------------------------------------------------------------

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function smooth01(t: number): number {
  return t * t * (3 - 2 * t);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Bilinear interpolation of a cell's four corner values. */
function bilerp(v00: number, v10: number, v01: number, v11: number, u: number, v: number): number {
  return lerp(lerp(v00, v10, u), lerp(v01, v11, u), v);
}

// ---- deterministic fields ---------------------------------------------------
// `rng(seed)` is the only randomness source in the game, and it is a STREAM —
// it cannot be indexed by position. So each field is one pass of that stream
// baked into a lattice, which is then indexed. Same lane count -> same lattice
// -> same map, on every machine and in every judge round.

function noiseLattice(seed: string): Float32Array {
  const r = rng(seed);
  const v = new Float32Array(NOISE_DIM * NOISE_DIM);
  for (let i = 0; i < v.length; i++) v[i] = r.next();
  return v;
}

/** Nearest-lattice read, wrapped — per-cell and per-sub-vertex variation. */
function latticeAt(f: Float32Array, a: number, b: number): number {
  const x = ((a % NOISE_DIM) + NOISE_DIM) % NOISE_DIM;
  const y = ((b % NOISE_DIM) + NOISE_DIM) % NOISE_DIM;
  return f[y * NOISE_DIM + x] ?? 0.5;
}

/** Smooth value noise in [0,1) at `metres` per lattice cell. */
function fieldAt(f: Float32Array, x: number, z: number, metres: number): number {
  const fx = x / metres;
  const fz = z / metres;
  const x0 = Math.floor(fx);
  const z0 = Math.floor(fz);
  const tx = smooth01(fx - x0);
  const tz = smooth01(fz - z0);
  const a = latticeAt(f, x0, z0);
  const b = latticeAt(f, x0 + 1, z0);
  const c = latticeAt(f, x0, z0 + 1);
  const d = latticeAt(f, x0 + 1, z0 + 1);
  return lerp(lerp(a, b, tx), lerp(c, d, tx), tz);
}

/** Two octaves of the same lattice — one broad shape, one finer break-up. */
function field2At(f: Float32Array, x: number, z: number, metres: number): number {
  return fieldAt(f, x, z, metres) * 0.68 + fieldAt(f, x + 37.25, z + 11.75, metres * 0.42) * 0.32;
}

// ---- geometry accumulation --------------------------------------------------

/** One material bucket of one chunk, gathered as a triangle soup. The map key
 *  may split a surface into several accumulators (rock face vs. map skirt) so
 *  baked AO can be applied to one and not the other; `bake()` merges them back
 *  into a single draw bucket because it keys on (surface, tint) alone. */
interface Accum {
  readonly id: SurfaceId;
  /** Baked-AO strength for this accumulator; 0 skips the pass. */
  readonly ao: number;
  readonly pos: number[];
  readonly nrm: number[];
  /** Per-vertex multiplicative shade, applied to the white vertex colour. */
  readonly shade: number[];
}

function accumOf(map: Map<string, Accum>, key: string, id: SurfaceId, ao: number): Accum {
  const hit = map.get(key);
  if (hit !== undefined) return hit;
  const made: Accum = { id, ao, pos: [], nrm: [], shade: [] };
  map.set(key, made);
  return made;
}

function pushVert(
  a: Accum,
  x: number,
  y: number,
  z: number,
  nx: number,
  ny: number,
  nz: number,
  s: number,
): void {
  a.pos.push(x, y, z);
  a.nrm.push(nx, ny, nz);
  a.shade.push(s);
}

/**
 * A flat-shaded triangle whose normal is computed from its own winding and then
 * forced to face `(wx,wy,wz)`. Used for every rock and water surface —
 * `cliffRock` is `flatShading: true`, so a per-face normal is the honest one,
 * and letting the emitter state which way a face should look is what keeps the
 * winding of thirty different little forms from having to be reasoned about.
 *
 * Scalar parameters rather than arrays on purpose: this runs a few hundred
 * thousand times during a cold load, and a temporary array per triangle is a
 * few hundred thousand objects for the GC to walk on the frame the map appears.
 */
function pushTriFlat(
  a: Accum,
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  cx: number,
  cy: number,
  cz: number,
  sa: number,
  sb: number,
  sc: number,
  wx: number,
  wy: number,
  wz: number,
): void {
  let nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
  let ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
  let nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (len < 1e-9) return; // degenerate sliver: no area, nothing to shade
  nx /= len;
  ny /= len;
  nz /= len;
  if (nx * wx + ny * wy + nz * wz < 0) {
    pushVert(a, ax, ay, az, -nx, -ny, -nz, sa);
    pushVert(a, cx, cy, cz, -nx, -ny, -nz, sc);
    pushVert(a, bx, by, bz, -nx, -ny, -nz, sb);
    return;
  }
  pushVert(a, ax, ay, az, nx, ny, nz, sa);
  pushVert(a, bx, by, bz, nx, ny, nz, sb);
  pushVert(a, cx, cy, cz, nx, ny, nz, sc);
}

/** A flat-shaded quad a-b-c-d, split into two triangles facing `(wx,wy,wz)`. */
function pushQuadFlat(
  a: Accum,
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  cx: number,
  cy: number,
  cz: number,
  dx: number,
  dy: number,
  dz: number,
  sa: number,
  sb: number,
  sc: number,
  sd: number,
  wx: number,
  wy: number,
  wz: number,
): void {
  pushTriFlat(a, ax, ay, az, bx, by, bz, cx, cy, cz, sa, sb, sc, wx, wy, wz);
  pushTriFlat(a, ax, ay, az, cx, cy, cz, dx, dy, dz, sa, sc, sd, wx, wy, wz);
}

/**
 * Turn one chunk's accumulators into the parts it bakes, folding away every
 * bucket too small to deserve a draw call.
 *
 * The fold is what keeps a 16 m chunk from costing seven draw calls because a
 * lane clipped its corner and a river clipped the opposite one. A family is
 * folded only into one that is ALREADY substantial in this same chunk — folding
 * a sliver into another sliver would trade one small bucket for another — and
 * `cliffRock` and `riverWater` are never folded at all.
 */
function finishChunk(acc: Map<string, Accum>): readonly Part[] {
  const byId = new Map<SurfaceId, number>();
  for (const a of acc.values()) {
    byId.set(a.id, (byId.get(a.id) ?? 0) + a.pos.length / 9);
  }
  const resolve = (id: SurfaceId): SurfaceId => {
    let cur = id;
    // Bounded by the length of the FOLD_INTO chain; the guard makes a future
    // cycle in that table a no-op rather than a hang.
    for (let step = 0; step < 4; step++) {
      if ((byId.get(cur) ?? 0) >= MIN_BUCKET_TRIS) return cur;
      const next = FOLD_INTO[cur];
      if (next === undefined) return cur;
      cur = next;
    }
    return cur;
  };

  const merged = new Map<string, Accum>();
  for (const a of acc.values()) {
    const id = resolve(a.id);
    // Folded triangles are ground, not rock: they must not pick up the rock
    // AO pass on the way into their new bucket.
    const ao = id === a.id ? a.ao : 0;
    const key = `${id}|${String(ao)}`;
    const tgt = merged.get(key);
    if (tgt === undefined) {
      merged.set(key, id === a.id ? a : { id, ao, pos: a.pos, nrm: a.nrm, shade: a.shade });
      continue;
    }
    for (const v of a.pos) tgt.pos.push(v);
    for (const v of a.nrm) tgt.nrm.push(v);
    for (const v of a.shade) tgt.shade.push(v);
  }

  const parts: Part[] = [];
  for (const a of merged.values()) {
    const part = finishPart(a);
    if (part !== null) parts.push(part);
  }
  return parts;
}

/** Turn one accumulator into a bakeable `Part`, obeying the vertex-colour law
 *  in the order the law requires: create the attribute with the kit's helper,
 *  THEN multiply the shading into it, THEN let `bakeVertexAO` multiply again. */
function finishPart(a: Accum): Part | null {
  if (a.pos.length === 0) return null;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(a.pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(a.nrm, 3));
  // VERTEX-COLOUR LAW: this geometry never passed through a kit primitive, so
  // this call is the only thing standing between it and a black frame.
  whiteVertexColors(geo);
  const col = geo.getAttribute('color');
  for (let v = 0; v < a.shade.length; v++) {
    const f = a.shade[v] ?? 1;
    col.setXYZ(v, col.getX(v) * f, col.getY(v) * f, col.getZ(v) * f);
  }
  col.needsUpdate = true;
  if (a.ao > 0) bakeVertexAO(geo, a.ao);
  return { geo, surface: a.id };
}

// ---- distance fields --------------------------------------------------------

/** Multi-source 4-connected BFS over the cell grid, capped. `seed` marks the
 *  zero-distance cells, `pass` gates which cells the wave may enter. Integer
 *  and O(cells): every mask this module needs — wear fringes, wet banks, rim
 *  rock, contact AO — is a distance from a set of cells. */
function distanceField(
  dim: number,
  cap: number,
  seed: (p: number) => boolean,
  pass: (p: number) => boolean,
): Uint8Array {
  const n = dim * dim;
  const d = new Uint8Array(n).fill(cap);
  const queue = new Int32Array(n);
  let head = 0;
  let tail = 0;
  for (let p = 0; p < n; p++) {
    if (!seed(p)) continue;
    d[p] = 0;
    queue[tail++] = p;
  }
  while (head < tail) {
    const p = queue[head++] ?? 0;
    const next = (d[p] ?? cap) + 1;
    if (next > cap) continue;
    const i = p % dim;
    const j = (p - i) / dim;
    for (let k = 0; k < 4; k++) {
      const ni = i + (k === 0 ? -1 : k === 1 ? 1 : 0);
      const nj = j + (k === 2 ? -1 : k === 3 ? 1 : 0);
      if (ni < 0 || nj < 0 || ni >= dim || nj >= dim) continue;
      const q = nj * dim + ni;
      if ((d[q] ?? cap) <= next || !pass(q)) continue;
      d[q] = next;
      queue[tail++] = q;
    }
  }
  return d;
}

// ---- construction-time scratch ----------------------------------------------
// Reused across cells so a 16k-cell map does not mint tens of thousands of
// short-lived arrays for the GC to walk on the frame the map appears.

const cornerYs = new Float32Array(4);
const cornerNs = new Float32Array(12);
const cornerSs = new Float32Array(4);
const patchXYZ = new Float32Array((CLIFF_SUB + 1) * (CLIFF_SUB + 1) * 3);
const patchS = new Float32Array((CLIFF_SUB + 1) * (CLIFF_SUB + 1));
/** Corner index (0..3) triples of the two triangulations of a cell quad, both
 *  wound counter-clockwise seen from +Y. Index 0=(i,j) 1=(i+1,j) 2=(i,j+1)
 *  3=(i+1,j+1). Which one a cell uses is hash-picked, so a family boundary runs
 *  as a ragged diagonal instead of an axis-aligned staircase. */
const QUAD_TRIS: readonly (readonly number[])[][] = [
  [
    [0, 2, 3],
    [0, 3, 1],
  ],
  [
    [0, 2, 1],
    [2, 3, 1],
  ],
];

function nowMs(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

/**
 * Build the terrain heightfield for `map` and add it to `scene`, chunk by
 * chunk, from this module's own frame hook.
 *
 * Must be constructed AFTER `SceneHandle.setTerrain` (wire.ts guarantees it as
 * the first statement of `onBegin`), because every vertex of every passable
 * cell is `scene.heightAt` evaluated at that vertex. Constructed earlier it
 * builds a legal, flat map rather than throwing — the documented degradation of
 * that seam — and says so on the console.
 */
export function createTerrain(scene: SceneHandle, map: MapDef): TerrainHandle {
  const core = sceneCore(scene);
  const grid = map.terrain.grid;
  const dim = grid.dim;
  const cw = dim + 1;
  const kindArr = grid.kind;
  const elevArr = grid.elev;
  const cells = dim * dim;
  const corners = cw * cw;

  // Terrain kind codes, resolved from the exported table rather than hard-coded:
  // TERRAIN_KINDS' order is part of the frozen data model and a literal here
  // would be a second, silent copy of it.
  const kindCode = (k: TerrainKind): number => TERRAIN_KINDS.indexOf(k);
  const K_GROUND = kindCode('ground');
  const K_LANE = kindCode('lane');
  const K_HIGH = kindCode('high');
  const K_CLIFF = kindCode('cliff');
  const K_RIVER = kindCode('river');
  const K_FOLIAGE = kindCode('foliage');
  const K_RAMP = kindCode('ramp');
  const K_BASE = kindCode('base');

  const kindOf = (i: number, j: number): number =>
    i < 0 || j < 0 || i >= dim || j >= dim ? -1 : kindArr[j * dim + i] ?? K_GROUND;
  const isCliff = (i: number, j: number): boolean => kindOf(i, j) === K_CLIFF;
  const isPassableCell = (i: number, j: number): boolean => {
    const k = kindOf(i, j);
    return k >= 0 && k !== K_CLIFF;
  };
  const isHighCell = (i: number, j: number): boolean =>
    i >= 0 && j >= 0 && i < dim && j < dim && (elevArr[j * dim + i] ?? 0) === ELEV_HIGH;

  // ---- 1. the height authority, sampled two ways --------------------------
  // Away from the ring the mesh must AGREE with `heightAt` — contract.ts asks
  // for "every vertex it emits is that function evaluated at the vertex's
  // (x, z)", and anything less is feet through the ground. At the ring it must
  // DISAGREE, in the one specific way rule 2 of the header describes, or a
  // smoothed `heightAt` renders the cliff as a hill. So there are two samplers
  // and a rule that says which corner gets which.
  //
  // AT-CORNER: `heightAt` at the corner itself, nudged EPS into the cell being
  //   asked about so a per-cell-lookup implementation answers for the right
  //   cell; on a smoothly interpolated one the nudge is under a millimetre.
  // AT-CENTRE: `heightAt` at the cell's own centre — "the height this level
  //   sits at here", which is the only unambiguous thing to ask when two levels
  //   meet at one corner and the field between them is a blur.
  const EPS = 0.02;
  const cornerSample = (i: number, j: number, ci: number, cj: number): number =>
    core.heightAt(ci + (ci === i ? EPS : -EPS), cj + (cj === j ? EPS : -EPS));

  // ---- 2. the two corner lattices -----------------------------------------
  const flatSum = new Float32Array(corners);
  const flatCnt = new Uint16Array(corners);
  const loSum = new Float32Array(corners);
  const loCnt = new Uint16Array(corners);
  const hiSum = new Float32Array(corners);
  const hiCnt = new Uint16Array(corners);
  const anySum = new Float32Array(corners);
  const anyCnt = new Uint16Array(corners);
  const hasLow = new Uint8Array(corners);
  const hasHigh = new Uint8Array(corners);
  const hasCliff = new Uint8Array(corners);
  let tMin = Infinity;
  let tMax = -Infinity;

  for (let j = 0; j < dim; j++) {
    for (let i = 0; i < dim; i++) {
      const p = j * dim + i;
      const k = kindArr[p] ?? K_GROUND;
      const high = (elevArr[p] ?? 0) === ELEV_HIGH;
      const walk = k !== K_CLIFF;
      const mid = core.heightAt(i + 0.5, j + 0.5);
      if (mid < tMin) tMin = mid;
      if (mid > tMax) tMax = mid;
      for (let cj = j; cj <= j + 1; cj++) {
        for (let ci = i; ci <= i + 1; ci++) {
          const c = cj * cw + ci;
          flatSum[c] = (flatSum[c] ?? 0) + cornerSample(i, j, ci, cj);
          flatCnt[c] = (flatCnt[c] ?? 0) + 1;
          anySum[c] = (anySum[c] ?? 0) + mid;
          anyCnt[c] = (anyCnt[c] ?? 0) + 1;
          if (!walk) {
            hasCliff[c] = 1;
            continue;
          }
          if (high) {
            hiSum[c] = (hiSum[c] ?? 0) + mid;
            hiCnt[c] = (hiCnt[c] ?? 0) + 1;
            hasHigh[c] = 1;
          } else {
            // A RAMP is ELEV_HIGH and feeds the high lattice only, even though
            // it is the one passable cell that legally touches passable ground
            // on the other level. Letting it feed the low lattice as well lifts
            // every ground cell around a ramp mouth by up to half a step — and
            // a unit standing there is then a unit floating. Instead the ramp
            // READS the low lattice at its mouth (see cellCornerY), which
            // leaves the ground exactly where `heightAt` put it and spends the
            // whole discrepancy on the one metre of ramp, where the slope is
            // supposed to be.
            loSum[c] = (loSum[c] ?? 0) + mid;
            loCnt[c] = (loCnt[c] ?? 0) + 1;
            hasLow[c] = 1;
          }
        }
      }
    }
  }

  const loH = new Float32Array(corners);
  const hiH = new Float32Array(corners);
  const capH = new Float32Array(corners);
  const loOk = new Uint8Array(corners);
  const hiOk = new Uint8Array(corners);
  for (let c = 0; c < corners; c++) {
    const ln = loCnt[c] ?? 0;
    const hn = hiCnt[c] ?? 0;
    const an = anyCnt[c] ?? 0;
    const fallback = an > 0 ? (anySum[c] ?? 0) / an : 0;
    // OPEN CORNER — no rock touches it and only one level does. Nothing here
    // needs a discontinuity, so the mesh takes `heightAt` at face value and the
    // surface passes through the sampler exactly. This is the overwhelming
    // majority of the map, and it is why a unit anywhere in the open jungle,
    // on a lane, in the river or on a plateau top stands on the ground it can
    // see rather than near it.
    if ((hasCliff[c] ?? 0) === 0 && ((hasLow[c] ?? 0) === 0 || (hasHigh[c] ?? 0) === 0)) {
      const fn = flatCnt[c] ?? 0;
      const v = fn > 0 ? (flatSum[c] ?? 0) / fn : fallback;
      loH[c] = v;
      hiH[c] = v;
      capH[c] = v;
      loOk[c] = 1;
      hiOk[c] = 1;
      continue;
    }
    // RING CORNER — two levels, or rock, meet here. Asking `heightAt` for a
    // single value at this point is asking it to answer a question with two
    // answers, and whatever it returns is halfway up the step. So each level
    // states its own height instead, and the metre of ring between them carries
    // the whole difference as rock.
    loH[c] = ln > 0 ? (loSum[c] ?? 0) / ln : fallback;
    hiH[c] = hn > 0 ? (hiSum[c] ?? 0) / hn : fallback;
    loOk[c] = ln > 0 ? 1 : 0;
    hiOk[c] = hn > 0 ? 1 : 0;
    // The ring's cap: flush with the plateau where it sees one, flush with the
    // ground where it does not. That single rule is what makes the rock face
    // start exactly at the plateau edge and land exactly on the ground.
    capH[c] = hn > 0 ? hiH[c] ?? 0 : ln > 0 ? loH[c] ?? 0 : fallback;
  }

  // Lattice gradients, for smooth ground and plateau normals. Central
  // differences over the corner field of the SAME level; one-sided where the
  // neighbour has no value on that level, so a plateau's normals never bend
  // toward the low ground beyond its own rim.
  const gradOf = (h: Float32Array, ok: Uint8Array, out: Float32Array): void => {
    for (let cj = 0; cj < cw; cj++) {
      for (let ci = 0; ci < cw; ci++) {
        const c = cj * cw + ci;
        const here = h[c] ?? 0;
        const l = ci > 0 && (ok[c - 1] ?? 0) === 1 ? h[c - 1] ?? here : here;
        const r = ci + 1 < cw && (ok[c + 1] ?? 0) === 1 ? h[c + 1] ?? here : here;
        const d = cj > 0 && (ok[c - cw] ?? 0) === 1 ? h[c - cw] ?? here : here;
        const u = cj + 1 < cw && (ok[c + cw] ?? 0) === 1 ? h[c + cw] ?? here : here;
        out[c * 2] = (r - l) * 0.5;
        out[c * 2 + 1] = (u - d) * 0.5;
      }
    }
  };
  const loGrad = new Float32Array(corners * 2);
  const hiGrad = new Float32Array(corners * 2);
  gradOf(loH, loOk, loGrad);
  gradOf(hiH, hiOk, hiGrad);

  // ---- 3. masks ------------------------------------------------------------
  const always = (): boolean => true;
  const isKind = (p: number, k: number): boolean => (kindArr[p] ?? K_GROUND) === k;
  /** Cells from the nearest rock. Drives both the bare rim on plateau tops and
   *  the contact darkening of the ground at a cliff foot — the cue STYLE_BIBLE
   *  §0 ranks third, above polygon count, for reading as shipped. */
  const distCliff = distanceField(dim, 4, (p) => isKind(p, K_CLIFF), always);
  /** Cells from the nearest built surface — lane, ramp or base platform. */
  const distWear = distanceField(
    dim,
    5,
    (p) => isKind(p, K_LANE) || isKind(p, K_RAMP) || isKind(p, K_BASE),
    always,
  );
  const distLane = distanceField(dim, 3, (p) => isKind(p, K_LANE), always);
  /** Distance from the verge, measured only through paving: which lane cells
   *  are the corridor's shoulder and which are its middle. */
  const distLaneEdge = distanceField(
    dim,
    3,
    (p) => !isKind(p, K_LANE),
    (p) => isKind(p, K_LANE),
  );
  const distRiver = distanceField(dim, 3, (p) => isKind(p, K_RIVER), always);
  /** Distance from the bank, measured only through water: the sheet's taper. */
  const distBank = distanceField(
    dim,
    4,
    (p) => !isKind(p, K_RIVER),
    (p) => isKind(p, K_RIVER),
  );

  /** Metres to the nearest neutral camp clearing centre. Camp floors are worn
   *  earth (STYLE_BIBLE §2, groundDirt = "lane edges, camp floors"). */
  const campDist = new Float32Array(cells).fill(64);
  for (const camp of map.terrain.camps) {
    const i0 = Math.max(0, Math.floor(camp.x - 7));
    const i1 = Math.min(dim - 1, Math.ceil(camp.x + 7));
    const j0 = Math.max(0, Math.floor(camp.z - 7));
    const j1 = Math.min(dim - 1, Math.ceil(camp.z + 7));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const dx = i + 0.5 - camp.x;
        const dz = j + 0.5 - camp.z;
        const d = Math.sqrt(dx * dx + dz * dz);
        const p = j * dim + i;
        if (d < (campDist[p] ?? 64)) campDist[p] = d;
      }
    }
  }

  // ---- 4. deterministic fields --------------------------------------------
  const seedTag = `rift:terrain:${String(map.lanes)}`;
  const fWear = noiseLattice(`${seedTag}:wear`);
  const fScour = noiseLattice(`${seedTag}:scour`);
  const fValue = noiseLattice(`${seedTag}:value`);
  const fCell = noiseLattice(`${seedTag}:cell`);
  const fCellB = noiseLattice(`${seedTag}:cellB`);
  const fJx = noiseLattice(`${seedTag}:jx`);
  const fJy = noiseLattice(`${seedTag}:jy`);
  const fJz = noiseLattice(`${seedTag}:jz`);

  // ---- 5. per-corner shading ----------------------------------------------
  // Computed on the corner lattice, not per cell, so the ground's shading is
  // continuous across cell boundaries. A per-cell shade would put a visible
  // 1 m grid on the moss, which is the defect STYLE_BIBLE §10a.1 names.
  const shadeC = new Float32Array(corners);
  for (let cj = 0; cj < cw; cj++) {
    for (let ci = 0; ci < cw; ci++) {
      let rock = 0;
      let foliage = 0;
      let river = 0;
      let n = 0;
      for (let j = cj - 1; j <= cj; j++) {
        for (let i = ci - 1; i <= ci; i++) {
          const k = kindOf(i, j);
          if (k < 0) continue;
          n++;
          const dc = distCliff[j * dim + i] ?? 4;
          rock += clamp01(1 - dc / 2.5);
          if (k === K_FOLIAGE) foliage++;
          if (k === K_RIVER) river++;
        }
      }
      const inv = n > 0 ? 1 / n : 1;
      let f = 1 - VALUE_VAR * (1 - field2At(fValue, ci, cj, 9));
      // Contact darkening where the ground runs up against rock.
      f *= 1 - 0.34 * (rock * inv);
      // Under a canopy the floor is in shade before a single leaf is planted.
      f *= 1 - 0.15 * (foliage * inv);
      // The channel bed reads deeper toward the middle of the river.
      f *= 1 - 0.16 * (river * inv);
      shadeC[cj * cw + ci] = Math.max(SHADE_FLOOR, f);
    }
  }

  // ---- 6. per-cell surface and vertex resolution --------------------------

  /** Corner height for one cell — the rule the whole watertightness argument
   *  rests on. Cliff cells read the cap; ramps read low wherever the corner has
   *  a passable low neighbour and high otherwise; everyone else reads their own
   *  level's lattice. */
  const cellCornerY = (i: number, j: number, ci: number, cj: number): number => {
    const c = cj * cw + ci;
    const k = kindOf(i, j);
    if (k === K_CLIFF || k < 0) return capH[c] ?? 0;
    if (k === K_RAMP) return (hasLow[c] ?? 0) === 1 ? loH[c] ?? 0 : hiH[c] ?? 0;
    return isHighCell(i, j) ? hiH[c] ?? 0 : loH[c] ?? 0;
  };

  /** Smooth normal at a passable cell's corner, from that level's lattice
   *  gradient. Ramps take the cell's own gradient instead: a ramp climbs a
   *  level in a single metre and the lattice around it is nearly flat, so a
   *  lattice normal would shade the one genuinely steep walkable surface in the
   *  game as though it were level ground. */
  const cornerNormalInto = (
    i: number,
    j: number,
    ci: number,
    cj: number,
    out: Float32Array,
    at: number,
  ): void => {
    const c = cj * cw + ci;
    let gx: number;
    let gz: number;
    if (kindOf(i, j) === K_RAMP) {
      const y00 = cellCornerY(i, j, i, j);
      const y10 = cellCornerY(i, j, i + 1, j);
      const y01 = cellCornerY(i, j, i, j + 1);
      const y11 = cellCornerY(i, j, i + 1, j + 1);
      gx = (y10 + y11 - y00 - y01) * 0.5;
      gz = (y01 + y11 - y00 - y10) * 0.5;
    } else if (isHighCell(i, j)) {
      gx = hiGrad[c * 2] ?? 0;
      gz = hiGrad[c * 2 + 1] ?? 0;
    } else {
      gx = loGrad[c * 2] ?? 0;
      gz = loGrad[c * 2 + 1] ?? 0;
    }
    const len = Math.sqrt(gx * gx + 1 + gz * gz);
    out[at] = -gx / len;
    out[at + 1] = 1 / len;
    out[at + 2] = -gz / len;
  };

  /** Wear in [0,1] at a point: how far the built world has trodden the moss
   *  down into earth. Proximity sets the reach, noise sets the edge, so the
   *  fringe is ragged rather than an offset outline of the lane. */
  const wearAt = (p: number, x: number, z: number): number => {
    const dw = distWear[p] ?? 5;
    const dc = campDist[p] ?? 64;
    const prox = Math.max(clamp01(1 - dw / WEAR_REACH), clamp01(1 - dc / 3.4));
    if (prox <= 0) return 0;
    return prox * (0.5 + 0.85 * field2At(fWear, x, z, 4.5));
  };

  /** Surface family for one point of a passable cell. Sampled per TRIANGLE, not
   *  per cell, and paired with the hash-flipped quad diagonal above. */
  const surfaceAt = (i: number, j: number, k: number, x: number, z: number): SurfaceId => {
    const p = j * dim + i;
    if (k === K_BASE) return 'monumentStone';
    if (k === K_RIVER) return 'wetRock';
    if (k === K_LANE) {
      // Worn margins where traffic spills off the paving onto the verge: only
      // the shoulder course is eligible, and only where the noise says the
      // paving has broken, so a lane keeps a continuous built spine.
      const shoulder = (distLaneEdge[p] ?? 3) <= 1;
      return shoulder && field2At(fWear, x, z, 3.2) > 0.58 ? 'groundDirt' : 'lanePaving';
    }
    if (k === K_RAMP) {
      // A base mouth is the lane climbing onto the platform and stays paved;
      // a jungle plateau access is a worn track cut through the rock.
      return (distLane[p] ?? 3) <= 1 ? 'lanePaving' : 'groundDirt';
    }
    if (k === K_HIGH) {
      // Bare and wind-scoured (STYLE_BIBLE §8): rock at the rim, where the
      // camera reads the plateau's edge, and rock through the scoured middle.
      // The contrast between bare high ground and dense low jungle is what
      // makes the elevation read from above.
      if ((distCliff[p] ?? 4) <= 1) return 'cliffRock';
      return field2At(fScour, x, z, 6) > 0.45 ? 'cliffRock' : 'groundMoss';
    }
    if ((distRiver[p] ?? 3) <= 1) return 'wetRock'; // the wet margin of the bank
    if (k === K_FOLIAGE) return 'groundMoss';
    return wearAt(p, x, z) > 0.5 ? 'groundDirt' : 'groundMoss';
  };

  /** Rock shares one accumulator wherever it comes from — a plateau's scoured
   *  top and the face below it are the same material and must bake into the
   *  same bucket — and that accumulator always carries the AO strength. */
  const surfaceAccum = (acc: Map<string, Accum>, id: SurfaceId): Accum =>
    accumOf(acc, id, id, id === 'cliffRock' ? CLIFF_AO : 0);

  // ---- 7. emitters ---------------------------------------------------------

  const emitPassableCell = (acc: Map<string, Accum>, i: number, j: number, k: number): void => {
    cornerYs[0] = cellCornerY(i, j, i, j);
    cornerYs[1] = cellCornerY(i, j, i + 1, j);
    cornerYs[2] = cellCornerY(i, j, i, j + 1);
    cornerYs[3] = cellCornerY(i, j, i + 1, j + 1);
    cornerNormalInto(i, j, i, j, cornerNs, 0);
    cornerNormalInto(i, j, i + 1, j, cornerNs, 3);
    cornerNormalInto(i, j, i, j + 1, cornerNs, 6);
    cornerNormalInto(i, j, i + 1, j + 1, cornerNs, 9);
    cornerSs[0] = shadeC[j * cw + i] ?? 1;
    cornerSs[1] = shadeC[j * cw + i + 1] ?? 1;
    cornerSs[2] = shadeC[(j + 1) * cw + i] ?? 1;
    cornerSs[3] = shadeC[(j + 1) * cw + i + 1] ?? 1;

    const tris = QUAD_TRIS[latticeAt(fCell, i, j) < 0.5 ? 1 : 0];
    if (tris === undefined) return;
    for (const tri of tris) {
      const c0 = tri[0] ?? 0;
      const c1 = tri[1] ?? 0;
      const c2 = tri[2] ?? 0;
      const cx = (c0 === 1 || c0 === 3 ? 1 : 0) + (c1 === 1 || c1 === 3 ? 1 : 0) + (c2 === 1 || c2 === 3 ? 1 : 0);
      const cz = (c0 === 2 || c0 === 3 ? 1 : 0) + (c1 === 2 || c1 === 3 ? 1 : 0) + (c2 === 2 || c2 === 3 ? 1 : 0);
      const id = surfaceAt(i, j, k, i + cx / 3, j + cz / 3);
      const a = surfaceAccum(acc, id);
      for (const c of tri) {
        pushVert(
          a,
          i + (c === 1 || c === 3 ? 1 : 0),
          cornerYs[c] ?? 0,
          j + (c === 2 || c === 3 ? 1 : 0),
          cornerNs[c * 3] ?? 0,
          cornerNs[c * 3 + 1] ?? 1,
          cornerNs[c * 3 + 2] ?? 0,
          cornerSs[c] ?? 1,
        );
      }
    }
  };

  /** True when every cell touching this sub-lattice vertex is a cliff cell —
   *  the only condition under which a sub-vertex may be moved, since anything
   *  shared with the passable surface has to stay exactly where that surface
   *  put it. */
  const subJitterOk = (subI: number, subJ: number): boolean => {
    const ru = subI % CLIFF_SUB;
    const rv = subJ % CLIFF_SUB;
    const bi = (subI - ru) / CLIFF_SUB;
    const bj = (subJ - rv) / CLIFF_SUB;
    for (let j = rv === 0 ? bj - 1 : bj; j <= bj; j++) {
      for (let i = ru === 0 ? bi - 1 : bi; i <= bi; i++) {
        if (!isCliff(i, j)) return false;
      }
    }
    return true;
  };

  const emitCliffCell = (acc: Map<string, Accum>, i: number, j: number): void => {
    const rock = surfaceAccum(acc, 'cliffRock');
    const q00 = capH[j * cw + i] ?? 0;
    const q10 = capH[j * cw + i + 1] ?? 0;
    const q01 = capH[(j + 1) * cw + i] ?? 0;
    const q11 = capH[(j + 1) * cw + i + 1] ?? 0;
    const s00 = shadeC[j * cw + i] ?? 1;
    const s10 = shadeC[j * cw + i + 1] ?? 1;
    const s01 = shadeC[(j + 1) * cw + i] ?? 1;
    const s11 = shadeC[(j + 1) * cw + i + 1] ?? 1;
    const yLo = Math.min(q00, q10, q01, q11);
    const yHi = Math.max(q00, q10, q01, q11);
    const span = Math.max(0.35, yHi - yLo);
    const bulge = (latticeAt(fCellB, i, j) - 0.5) * 2 * CLIFF_BULGE;

    const row = CLIFF_SUB + 1;
    for (let v = 0; v <= CLIFF_SUB; v++) {
      for (let u = 0; u <= CLIFF_SUB; u++) {
        const fu = u / CLIFF_SUB;
        const fv = v / CLIFF_SUB;
        let x = i + fu;
        let z = j + fv;
        // The bump vanishes on the cell boundary, so two faces sharing an edge
        // agree exactly no matter how differently they bulge in the middle.
        let y =
          bilerp(q00, q10, q01, q11, fu, fv) +
          bulge * Math.sin(Math.PI * fu) * Math.sin(Math.PI * fv);
        const subI = i * CLIFF_SUB + u;
        const subJ = j * CLIFF_SUB + v;
        if (subJitterOk(subI, subJ)) {
          x += (latticeAt(fJx, subI, subJ) - 0.5) * 2 * CLIFF_JITTER_XZ;
          z += (latticeAt(fJz, subI, subJ) - 0.5) * 2 * CLIFF_JITTER_XZ;
          y += (latticeAt(fJy, subI, subJ) - 0.5) * 2 * CLIFF_JITTER_Y;
        }
        const idx = v * row + u;
        patchXYZ[idx * 3] = x;
        patchXYZ[idx * 3 + 1] = y;
        patchXYZ[idx * 3 + 2] = z;
        // Rock darkens toward its own foot: the strongest single cue that a
        // face is a face and not a lit ramp.
        patchS[idx] = Math.max(
          SHADE_FLOOR,
          bilerp(s00, s10, s01, s11, fu, fv) * (0.66 + 0.34 * clamp01((y - yLo) / span)),
        );
      }
    }
    for (let v = 0; v < CLIFF_SUB; v++) {
      for (let u = 0; u < CLIFF_SUB; u++) {
        const a = v * row + u;
        const b = (v + 1) * row + u;
        const c = (v + 1) * row + u + 1;
        const d = v * row + u + 1;
        pushQuadFlat(
          rock,
          patchXYZ[a * 3] ?? 0, patchXYZ[a * 3 + 1] ?? 0, patchXYZ[a * 3 + 2] ?? 0,
          patchXYZ[b * 3] ?? 0, patchXYZ[b * 3 + 1] ?? 0, patchXYZ[b * 3 + 2] ?? 0,
          patchXYZ[c * 3] ?? 0, patchXYZ[c * 3 + 1] ?? 0, patchXYZ[c * 3 + 2] ?? 0,
          patchXYZ[d * 3] ?? 0, patchXYZ[d * 3 + 1] ?? 0, patchXYZ[d * 3 + 2] ?? 0,
          patchS[a] ?? 1, patchS[b] ?? 1, patchS[c] ?? 1, patchS[d] ?? 1,
          0, 1, 0,
        );
      }
    }

    // Rim lip, wall strips and talus: the two silhouette breaks plus the crack
    // closer. The lip and the talus overlap the face rather than sharing
    // vertices with it, so neither can open a seam, and both are hash-gated so
    // the lines they break stay irregular.
    for (let e = 0; e < 4; e++) {
      const di = e === 0 ? -1 : e === 1 ? 1 : 0;
      const dj = e === 2 ? -1 : e === 3 ? 1 : 0;
      const ni = i + di;
      const nj = j + dj;
      if (!isPassableCell(ni, nj)) continue;
      // The two shared corners of the (i,j)|(ni,nj) edge.
      const ci0 = di === 1 ? i + 1 : i;
      const cj0 = dj === 1 ? j + 1 : j;
      const ci1 = di === 0 ? i + 1 : ci0;
      const cj1 = dj === 0 ? j + 1 : cj0;
      const cap0 = capH[cj0 * cw + ci0] ?? 0;
      const cap1 = capH[cj1 * cw + ci1] ?? 0;
      const sh0 = shadeC[cj0 * cw + ci0] ?? 1;
      const sh1 = shadeC[cj1 * cw + ci1] ?? 1;

      if (isHighCell(ni, nj)) {
        if (latticeAt(fCell, i * 3 + e, j * 3 + 1) < LIP_SKIP) continue;
        const out = lerp(LIP_OUT_MIN, LIP_OUT_MAX, latticeAt(fCellB, i + e * 7, j));
        const drop = lerp(LIP_DROP_MIN, LIP_DROP_MAX, latticeAt(fCellB, i, j + e * 7));
        // The lip stands proud INTO the ring (away from the plateau) and hangs
        // down, so it casts a shadow band along the rim instead of leaving the
        // clean extruded step that reads as a toy map.
        const ox = -di * out;
        const oz = -dj * out;
        const lit = Math.max(SHADE_FLOOR, sh0 * 0.9);
        const dark = Math.max(SHADE_FLOOR, lit * 0.72);
        pushQuadFlat(
          rock,
          ci0, cap0, cj0,
          ci1, cap1, cj1,
          ci1 + ox, cap1, cj1 + oz,
          ci0 + ox, cap0, cj0 + oz,
          lit, lit, lit, lit,
          0, 1, 0,
        );
        pushQuadFlat(
          rock,
          ci0 + ox, cap0, cj0 + oz,
          ci1 + ox, cap1, cj1 + oz,
          ci1 + ox, cap1 - drop, cj1 + oz,
          ci0 + ox, cap0 - drop, cj0 + oz,
          lit, lit, dark, dark,
          -di, 0, -dj,
        );
        continue;
      }

      // Passable and NOT high: this is the foot of the face. Wall strip first —
      // the ring's cap and the ground can disagree here (a ring corner that
      // sees a plateau diagonally, or the flank of a ramp), and the strip is
      // what closes that gap instead of leaving a lit crack through the map.
      const gnd0 = cellCornerY(ni, nj, ci0, cj0);
      const gnd1 = cellCornerY(ni, nj, ci1, cj1);
      if (Math.abs(gnd0 - cap0) > 1e-4 || Math.abs(gnd1 - cap1) > 1e-4) {
        pushQuadFlat(
          rock,
          ci0, gnd0, cj0,
          ci1, gnd1, cj1,
          ci1, cap1, cj1,
          ci0, cap0, cj0,
          Math.max(SHADE_FLOOR, sh0 * 0.62),
          Math.max(SHADE_FLOOR, sh1 * 0.62),
          sh1,
          sh0,
          di, 0, dj,
        );
      }

      if (latticeAt(fCell, i + e * 13, j + e * 5) >= TALUS_CHANCE) continue;
      const out = lerp(TALUS_OUT_MIN, TALUS_OUT_MAX, latticeAt(fCellB, i + e * 11, j + e * 3));
      const hgt = lerp(TALUS_H_MIN, TALUS_H_MAX, latticeAt(fJy, i + e * 5, j + e * 11));
      const gMid = (gnd0 + gnd1) * 0.5;
      const mx = (ci0 + ci1) * 0.5;
      const mz = (cj0 + cj1) * 0.5;
      const apexY = Math.min(gMid + hgt, Math.max(cap0, cap1, gMid + 0.2));
      const shT = Math.max(SHADE_FLOOR, sh0 * 0.7);
      pushTriFlat(
        rock,
        ci0, gnd0, cj0,
        mx + di * out, gMid, mz + dj * out,
        mx, apexY, mz,
        shT, shT * 0.92, shT,
        di, 0.4, dj,
      );
      pushTriFlat(
        rock,
        mx + di * out, gMid, mz + dj * out,
        ci1, gnd1, cj1,
        mx, apexY, mz,
        shT * 0.92, shT, shT,
        di, 0.4, dj,
      );
    }
  };

  /** Depth of the water sheet at a grid corner: full mid-channel, zero at any
   *  corner the bank touches, so the sheet meets the shore instead of standing
   *  on it as a slab. */
  const waterDepthAt = (ci: number, cj: number): number => {
    let d = 4;
    for (let j = cj - 1; j <= cj; j++) {
      for (let i = ci - 1; i <= ci; i++) {
        if (i < 0 || j < 0 || i >= dim || j >= dim) return 0;
        const b = distBank[j * dim + i] ?? 0;
        if (b < d) d = b;
      }
    }
    return WATER_DEPTH * clamp01(d / WATER_TAPER);
  };

  /** The transparent sheet over a river cell. Visual only — nothing in the sim
   *  reads it, and nothing here slows, damages or reveals a unit standing in it
   *  (DESIGN_DELTA §4). */
  const emitWater = (acc: Map<string, Accum>, i: number, j: number): void => {
    const water = surfaceAccum(acc, 'riverWater');
    const sh = shadeC[j * cw + i] ?? 1;
    pushQuadFlat(
      water,
      i, (loH[j * cw + i] ?? 0) + waterDepthAt(i, j), j,
      i + 1, (loH[j * cw + i + 1] ?? 0) + waterDepthAt(i + 1, j), j,
      i + 1, (loH[(j + 1) * cw + i + 1] ?? 0) + waterDepthAt(i + 1, j + 1), j + 1,
      i, (loH[(j + 1) * cw + i] ?? 0) + waterDepthAt(i, j + 1), j + 1,
      sh, sh, sh, sh,
      0, 1, 0,
    );
  };

  /** The map frame, dropped into bare rock. Without it the camera sees under
   *  the world at the far edge and the map reads as a cut-out. Its own
   *  accumulator so the AO pass — whose contact term is measured from a
   *  geometry's own floor — is not dragged nine metres down by it; `bake()`
   *  merges it back into the one `cliffRock` draw bucket regardless. */
  const emitSkirt = (acc: Map<string, Accum>, i: number, j: number): void => {
    const skirt = accumOf(acc, 'cliffRock:skirt', 'cliffRock', 0);
    for (let e = 0; e < 4; e++) {
      const di = e === 0 ? -1 : e === 1 ? 1 : 0;
      const dj = e === 2 ? -1 : e === 3 ? 1 : 0;
      const ni = i + di;
      const nj = j + dj;
      if (ni >= 0 && nj >= 0 && ni < dim && nj < dim) continue;
      const ci0 = di === 1 ? i + 1 : i;
      const cj0 = dj === 1 ? j + 1 : j;
      const ci1 = di === 0 ? i + 1 : ci0;
      const cj1 = dj === 0 ? j + 1 : cj0;
      const y0 = cellCornerY(i, j, ci0, cj0);
      const y1 = cellCornerY(i, j, ci1, cj1);
      const floor = Math.min(y0, y1) - SKIRT_DEPTH;
      pushQuadFlat(
        skirt,
        ci0, y0, cj0,
        ci1, y1, cj1,
        ci1, floor, cj1,
        ci0, floor, cj0,
        0.9, 0.9, SHADE_FLOOR, SHADE_FLOOR,
        di, 0, dj,
      );
    }
  };

  /** Height steps between two PASSABLE cells. `buildTerrain` makes these rare —
   *  it never puts a low cell orthogonally beside a high one — but a ramp does
   *  touch both levels, and a step left open would be a lit crack straight
   *  through the map. Cheap to emit, and its absence is unrecoverable. */
  const emitPassableStep = (
    acc: Map<string, Accum>,
    i: number,
    j: number,
    ni: number,
    nj: number,
  ): void => {
    const di = ni - i;
    const dj = nj - j;
    const ci0 = di === 1 ? i + 1 : i;
    const cj0 = dj === 1 ? j + 1 : j;
    const ci1 = di === 0 ? i + 1 : ci0;
    const cj1 = dj === 0 ? j + 1 : cj0;
    const a0 = cellCornerY(i, j, ci0, cj0);
    const a1 = cellCornerY(i, j, ci1, cj1);
    const b0 = cellCornerY(ni, nj, ci0, cj0);
    const b1 = cellCornerY(ni, nj, ci1, cj1);
    if (Math.abs(a0 - b0) < 1e-4 && Math.abs(a1 - b1) < 1e-4) return;
    const rock = surfaceAccum(acc, 'cliffRock');
    const sh0 = (shadeC[cj0 * cw + ci0] ?? 1) * 0.8;
    const sh1 = (shadeC[cj1 * cw + ci1] ?? 1) * 0.8;
    // Face the lower of the two cells — that is the side anything can see.
    const toward = a0 + a1 < b0 + b1 ? -1 : 1;
    pushQuadFlat(
      rock,
      ci0, a0, cj0,
      ci1, a1, cj1,
      ci1, b1, cj1,
      ci0, b0, cj0,
      sh0, sh1, sh1, sh0,
      di * toward, 0, dj * toward,
    );
  };

  // ---- 8. chunking ---------------------------------------------------------
  interface Chunk {
    readonly i0: number;
    readonly i1: number;
    readonly j0: number;
    readonly j1: number;
  }
  const chunks: Chunk[] = [];
  for (let cz = 0; cz * CHUNK_M < dim; cz++) {
    for (let cx = 0; cx * CHUNK_M < dim; cx++) {
      chunks.push({
        i0: cx * CHUNK_M,
        i1: Math.min(dim, cx * CHUNK_M + CHUNK_M),
        j0: cz * CHUNK_M,
        j1: Math.min(dim, cz * CHUNK_M + CHUNK_M),
      });
    }
  }

  const buildChunk = (c: Chunk): readonly Part[] => {
    const acc = new Map<string, Accum>();
    for (let j = c.j0; j < c.j1; j++) {
      for (let i = c.i0; i < c.i1; i++) {
        const k = kindOf(i, j);
        if (k === K_CLIFF) {
          emitCliffCell(acc, i, j);
        } else {
          emitPassableCell(acc, i, j, k);
          // Each interior edge belongs to its lower-indexed cell, so it is
          // emitted once globally and lands in exactly one chunk.
          if (i + 1 < dim && !isCliff(i + 1, j)) emitPassableStep(acc, i, j, i + 1, j);
          if (j + 1 < dim && !isCliff(i, j + 1)) emitPassableStep(acc, i, j, i, j + 1);
        }
        if (k === K_RIVER) emitWater(acc, i, j);
        if (i === 0 || j === 0 || i === dim - 1 || j === dim - 1) emitSkirt(acc, i, j);
      }
    }
    return finishChunk(acc);
  };

  // ---- 9. the build loop ---------------------------------------------------
  const waterMat = surface('riverWater');
  const rockMat = surface('cliffRock');
  let chunkIx = 0;
  let job: ChunkedBake | null = null;
  let finished = false;
  let buildMs = 0;
  let buckets = 0;
  let triangles = 0;

  /** Shadow policy, applied as each chunk lands. Only the rock casts: it is
   *  what a plateau's silhouette is made of, and near-flat ground casting onto
   *  itself buys nothing but shadow-map fill and acne. Everything keeps
   *  receiving, which is the half that matters. */
  const settleJob = (done: ChunkedBake): void => {
    for (const child of done.mesh.group.children) {
      const mesh = child as THREE.Mesh;
      mesh.castShadow = mesh.material === rockMat;
    }
    buckets += done.mesh.parts.length;
    for (const part of done.mesh.parts) {
      triangles += Math.floor(part.geo.getAttribute('position').count / 3);
    }
  };

  const advance = (): void => {
    const t0 = nowMs();
    while (nowMs() - t0 < SLICE_MS) {
      if (job === null) {
        const c = chunks[chunkIx];
        chunkIx++;
        if (c === undefined) {
          finished = true;
          break;
        }
        const parts = buildChunk(c);
        if (parts.length === 0) continue;
        const next = bakeChunked(parts, SLICE_MS);
        next.mesh.group.name = 'rift:terrain';
        core.three.add(next.mesh.group);
        job = next;
      }
      if (!job.step()) {
        settleJob(job);
        job = null;
      }
    }
    buildMs += nowMs() - t0;
    if (!finished) return;
    console.info(
      `rift terrain: ${String(chunks.length)} chunks, ${String(buckets)} draw buckets, ` +
        `${String(triangles)} tris, built in ${buildMs.toFixed(1)} ms`,
    );
    if (tMax - tMin < 0.1) {
      // Not fatal and not repaired here: heightAt is the single height authority
      // and inventing relief it does not report would sink every unit in the
      // game into the ground.
      console.warn(
        'rift terrain: scene.heightAt is flat across the whole map — setTerrain ' +
          'must run before createTerrain or the map has no elevation.',
      );
    }
  };

  const rippleMap = waterMat.normalMap;
  core.addFrameHook((dtMs) => {
    if (!finished) {
      try {
        advance();
      } catch (err) {
        // Robustness (GRAPHICS_CONTRACT §5): a partially built map is a playable
        // frame; a hook that throws every frame is a dead game.
        finished = true;
        console.warn('rift terrain: bake failed, map left partially built', err);
      }
    }
    // Steady state: two numbers, no allocation, no work.
    if (rippleMap === null) return;
    rippleMap.offset.x = (rippleMap.offset.x + dtMs * RIPPLE_U_PER_MS) % 1;
    rippleMap.offset.y = (rippleMap.offset.y + dtMs * RIPPLE_V_PER_MS) % 1;
  });

  return {
    ready(): boolean {
      return finished;
    },
  };
}
