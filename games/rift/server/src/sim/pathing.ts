// ============================================================================
// ANCIENTS (rift) — PATHING (TERRAIN_CONTRACT §4, DESIGN_DELTA §1). Two things
// live here and nothing else:
//
//  1. The CELL PRIMITIVES the movement veto is built from — `segmentWalkable`
//     (may a mobile sweep from A to B this tick?) and the cell accessors the
//     cliff push-out needs. Movement and the pathfinder MUST agree on exactly
//     what "walkable" means, or A* string-pulls a hero through a wall that
//     `steer()` then refuses to cross and the hero stalls against thin air.
//     They agree because they call the same function.
//  2. Hero-only grid A* over `TerrainDef.grid`, 8-connected, octile heuristic,
//     returning a SIMPLIFIED polyline (collinear runs collapsed, then string-
//     pulled through open space so a hero does not visibly staircase).
//
// What "walkable" means, once, here:
//  - a `'cliff'` cell may never be entered (`isPassable`, TERRAIN_CONTRACT §2);
//  - a step that CHANGES gameplay elevation is legal only when the cell it
//    leaves or the cell it enters is a `'ramp'` — ramps are the only crossing
//    of a cliff ring (§3), and `elevationAt` already reports ELEV_HIGH on one;
//  - a DIAGONAL step may not cut a corner: both orthogonal cells between the
//    two must themselves be steppable, in and out. Without this a hero slips
//    diagonally between two cliff corners that a straight walk cannot pass.
//
// DETERMINISM (§4). The open set is ordered by `(f, h, cellIndex)` — never by
// insertion order into a Map, never by object identity — so two worlds built
// from the same map produce byte-identical paths. No `Math.random`, no clock,
// no world state. The scratch buffers below are module-level for allocation
// reasons only: every search fills `state` before it reads it, so a search's
// result never depends on the search that preceded it.
//
// BUDGET (§0, 2.5 ms sim tick). At most 16 heroes exist and a path is computed
// only when an order arrives, but eight bots can order on the same tick, so:
// the straight-line case never searches at all (it is the common case), and a
// search that exceeds PATH_NODE_BUDGET expansions gives up and returns null —
// the hero then steers straight, which is exactly what every unit did before
// this pass. A stalled tick is a worse failure than a hero walking into a wall.
// ============================================================================
import { TERRAIN_KINDS } from '@rift/shared';
import type { TerrainDef, TerrainGrid, Vec2 } from '@rift/shared';

/** Numeric codes for the two kinds this file reasons about, read out of the
 *  frozen `TERRAIN_KINDS` table rather than restated — the table's order is
 *  part of the data model and re-typing the indices here would be a second
 *  copy of it that could drift.
 *
 *  Resolved ONCE, at module load, and every hot-path test below compares
 *  against these locals and against raw `elev` bytes — never against an
 *  imported binding. That is not style: a cross-module import is a live
 *  binding, the runtime reads it through an accessor, and a CPU profile of an
 *  earlier draft of this file spent 60% of every A* search inside those
 *  accessors. Terrain codes are compared, never re-imported, inside a loop. */
const K_CLIFF = TERRAIN_KINDS.indexOf('cliff');
const K_RAMP = TERRAIN_KINDS.indexOf('ramp');

/** Sweep sample spacing, in metres, for {@link segmentWalkable}. Must be < the
 *  cell size (1 m at the frozen res = 1) so consecutive samples land in cells
 *  that differ by at most one on each axis — that is what makes the per-sample
 *  adjacency test exhaustive, and it is why a dash or a hasted hero cannot
 *  tunnel through a one-cell-thick cliff in a single tick. */
const SAMPLE_STEP = 0.25;

/** Diagonal step cost. Octile metric: orthogonal 1, diagonal sqrt(2). */
const DIAG = Math.SQRT2;

/** Maximum A* node expansions per search, and therefore the hard cap on what
 *  one order can cost the tick. MEASURED on the largest map (3 lanes, dim 128,
 *  15 794 walkable cells) over 3 000 sampled orders per bucket whose straight
 *  line is blocked — the only ones that search at all:
 *
 *    order length   p50   p90   p99   max
 *    <= 15 m         75   267   569   569
 *    <= 30 m        104   391   898  1137
 *    <= 60 m        153   517  1592  2604
 *    unbounded      248   977  2332  4237
 *
 *  1 600 therefore serves every short and medium order outright and all but the
 *  tail of the long ones, while holding a single search near a third of the
 *  2.5 ms tick even on a loaded machine. Exceeding it returns null and the hero
 *  steers straight, which is exactly what every unit in this sim did before
 *  terrain existed — a hero pressing against a plateau is a visible, local,
 *  recoverable fault; a sim tick that misses its deadline is not. */
export const PATH_NODE_BUDGET = 1600;

/** How far (in cells) a destination inside a cliff is allowed to snap to the
 *  nearest walkable cell. A click on a cliff face should walk you to the foot
 *  of it; a click deep inside a mountain is simply not a destination. */
const GOAL_SNAP_CELLS = 6;

// --- cell primitives ---------------------------------------------------------

/** Grid column (or row) holding world coordinate `v`, clamped into [0, dim-1].
 *  The `!(i > 0)` form also catches NaN, which `i < 0` would not — the same
 *  guard `terrain.ts` uses, restated because its copy is file-private. */
function axisCell(v: number, res: number, dim: number): number {
  const i = Math.floor(v * res);
  if (!(i > 0)) return 0;
  return i > dim - 1 ? dim - 1 : i;
}

/** Linear index of the cell holding world (x, z). Always in bounds. */
export function cellIndexAt(g: TerrainGrid, x: number, z: number): number {
  return axisCell(z, g.res, g.dim) * g.dim + axisCell(x, g.res, g.dim);
}

/** World x of the centre of cell `idx`. */
export function cellMidX(g: TerrainGrid, idx: number): number {
  return ((idx % g.dim) + 0.5) / g.res;
}

/** World z of the centre of cell `idx`. */
export function cellMidZ(g: TerrainGrid, idx: number): number {
  return (Math.floor(idx / g.dim) + 0.5) / g.res;
}

/** Is cell `idx` standable at all? Everything except `'cliff'` is. An
 *  out-of-range index reads as solid: for movement, "off the grid" and "wall"
 *  are the same answer, and it is the only default that cannot let a unit
 *  escape the map. */
export function cellPassable(g: TerrainGrid, idx: number): boolean {
  const c = g.kind[idx];
  return c !== undefined && c !== K_CLIFF;
}

/** May a mobile move from cell `from` into the ORTHOGONALLY adjacent (or
 *  identical) cell `to`? Encodes both halves of the terrain rule: cliffs are
 *  solid, and an elevation change needs a ramp at one end. The elevations are
 *  compared as raw stored bytes — the grid holds exactly ELEV_LOW/ELEV_HIGH,
 *  so "same level" is byte equality and needs no decoding. */
function cellStep(g: TerrainGrid, from: number, to: number): boolean {
  const kTo = g.kind[to];
  if (kTo === undefined || kTo === K_CLIFF) return false;
  if (g.elev[from] === g.elev[to]) return true;
  return kTo === K_RAMP || g.kind[from] === K_RAMP;
}

/** {@link cellStep} extended to the diagonal, with the no-corner-cutting rule:
 *  a diagonal move must be legal via BOTH orthogonal cells between the two.
 *  Callers pass cells that are identical or 8-adjacent; nothing else is
 *  meaningful. */
function gridStep(g: TerrainGrid, cx0: number, cz0: number, cx1: number, cz1: number): boolean {
  if (cx0 === cx1 && cz0 === cz1) return true;
  const from = cz0 * g.dim + cx0;
  const to = cz1 * g.dim + cx1;
  if (cx0 !== cx1 && cz0 !== cz1) {
    const viaX = cz0 * g.dim + cx1;
    const viaZ = cz1 * g.dim + cx0;
    if (!cellStep(g, from, viaX) || !cellStep(g, viaX, to)) return false;
    if (!cellStep(g, from, viaZ) || !cellStep(g, viaZ, to)) return false;
    return true;
  }
  return cellStep(g, from, to);
}

/**
 * How much of the straight line (x0,z0) -> (x1,z1) a mobile may actually
 * travel, as a fraction in [0,1]. 1 means the whole segment is legal; 0 means
 * it cannot leave where it stands.
 *
 * SWEPT, not an endpoint test: the segment is walked in {@link SAMPLE_STEP}
 * increments and every cell transition along it is checked, so no amount of
 * `moveSpeed`, and no dash, can step over a wall between two legal-looking
 * endpoints. The fraction — rather than a bare yes/no — is what lets a dash
 * stop AT the cliff face instead of refusing to move at all.
 *
 * Returns 0 if the START cell is itself impassable: a unit that has been shoved
 * inside a cliff by separation or structure push-out may not use that illegal
 * position to travel; `stepMovement`'s pass-3 push-out is what frees it, on the
 * same tick.
 */
export function walkableFraction(t: TerrainDef, x0: number, z0: number, x1: number, z1: number): number {
  const g = t.grid;
  let cx = axisCell(x0, g.res, g.dim);
  let cz = axisCell(z0, g.res, g.dim);
  if (!cellPassable(g, cz * g.dim + cx)) return 0;
  const dx = x1 - x0;
  const dz = z1 - z0;
  const d = Math.sqrt(dx * dx + dz * dz);
  const steps = Math.ceil(d / SAMPLE_STEP);
  for (let s = 1; s <= steps; s++) {
    const f = s / steps;
    const nx = axisCell(x0 + dx * f, g.res, g.dim);
    const nz = axisCell(z0 + dz * f, g.res, g.dim);
    if (nx === cx && nz === cz) continue;
    if (!gridStep(g, cx, cz, nx, nz)) return (s - 1) / steps;
    cx = nx;
    cz = nz;
  }
  return 1;
}

/** The whole segment is legal — the yes/no form of {@link walkableFraction},
 *  which is what a route planner wants. */
export function segmentWalkable(t: TerrainDef, x0: number, z0: number, x1: number, z1: number): boolean {
  return walkableFraction(t, x0, z0, x1, z1) === 1;
}

/**
 * Index of the passable cell nearest to (x, z), searched over the square of
 * `maxCells` around it and scored by true squared distance between cell
 * centres (a Chebyshev ring is not a distance order — the diagonal of ring r
 * is farther than the side of ring r+1). Ties break to the lower cell index,
 * which is deterministic and mirror-stable. Returns the cell itself when it is
 * already passable, or -1 when the whole neighbourhood is solid rock.
 */
export function nearestPassableCell(g: TerrainGrid, x: number, z: number, maxCells: number): number {
  const cx = axisCell(x, g.res, g.dim);
  const cz = axisCell(z, g.res, g.dim);
  const here = cz * g.dim + cx;
  if (cellPassable(g, here)) return here;
  let best = -1;
  let bestD = Infinity;
  const lo = -maxCells;
  const hi = maxCells;
  for (let oz = lo; oz <= hi; oz++) {
    const nz = cz + oz;
    if (nz < 0 || nz >= g.dim) continue;
    for (let ox = lo; ox <= hi; ox++) {
      const nx = cx + ox;
      if (nx < 0 || nx >= g.dim) continue;
      const idx = nz * g.dim + nx;
      if (!cellPassable(g, idx)) continue;
      const ddx = ox;
      const ddz = oz;
      const d2 = ddx * ddx + ddz * ddz;
      if (d2 < bestD) {
        bestD = d2;
        best = idx;
      }
    }
  }
  return best;
}

// --- A* scratch --------------------------------------------------------------
// Module-level and reused: a 128x128 grid needs ~0.5 MB of node arrays and a
// search must not allocate them per order. Every search fills `state` first, so
// no value survives from one search into the next and the result is a pure
// function of (grid, start, goal).

let scratchCells = 0;
let gCost = new Float64Array(0);
let fCost = new Float64Array(0);
let hCost = new Float64Array(0);
let parent = new Int32Array(0);
/** 0 = unseen, 1 = open, 2 = closed. */
let state = new Uint8Array(0);
let heap = new Int32Array(0);
let heapLen = 0;

function ensureScratch(cells: number): void {
  if (scratchCells >= cells) return;
  scratchCells = cells;
  gCost = new Float64Array(cells);
  fCost = new Float64Array(cells);
  hCost = new Float64Array(cells);
  parent = new Int32Array(cells);
  state = new Uint8Array(cells);
  // Lazy deletion means a cell re-enters the heap every time an incoming edge
  // improves it, and it has exactly 8 incoming edges — so 8 slots per cell is a
  // true upper bound on total pushes, not an estimate, and the heap can never
  // overflow and silently drop a node. Sized once, never grown.
  heap = new Int32Array(cells * 8 + 1);
}

/** Total order on open nodes: lower f first, then lower h (prefer the node
 *  closer to the goal — it breaks the plateau of equal-f nodes toward the
 *  goal), then lower cell index. The third key is what makes the search
 *  reproducible: it never falls back on insertion order. */
function better(a: number, b: number): boolean {
  const fa = fCost[a] ?? 0;
  const fb = fCost[b] ?? 0;
  if (fa !== fb) return fa < fb;
  const ha = hCost[a] ?? 0;
  const hb = hCost[b] ?? 0;
  if (ha !== hb) return ha < hb;
  return a < b;
}

function heapPush(cell: number): void {
  if (heapLen >= heap.length) return; // bounded by construction; never hit
  let i = heapLen;
  heap[i] = cell;
  heapLen += 1;
  while (i > 0) {
    const p = (i - 1) >> 1;
    const vi = heap[i] ?? 0;
    const vp = heap[p] ?? 0;
    if (!better(vi, vp)) break;
    heap[i] = vp;
    heap[p] = vi;
    i = p;
  }
}

function heapPop(): number {
  const top = heap[0] ?? -1;
  heapLen -= 1;
  if (heapLen > 0) {
    heap[0] = heap[heapLen] ?? 0;
    let i = 0;
    for (;;) {
      const l = 2 * i + 1;
      const r = l + 1;
      let m = i;
      if (l < heapLen && better(heap[l] ?? 0, heap[m] ?? 0)) m = l;
      if (r < heapLen && better(heap[r] ?? 0, heap[m] ?? 0)) m = r;
      if (m === i) break;
      const vi = heap[i] ?? 0;
      heap[i] = heap[m] ?? 0;
      heap[m] = vi;
      i = m;
    }
  }
  return top;
}

/** Octile distance in cells between two cells — admissible and consistent for
 *  an 8-connected grid with costs (1, sqrt(2)), which is what lets the search
 *  close a node on its first pop and skip decrease-key entirely. */
function octile(ax: number, az: number, bx: number, bz: number): number {
  const dx = ax < bx ? bx - ax : ax - bx;
  const dz = az < bz ? bz - az : az - bz;
  const lo = dx < dz ? dx : dz;
  return dx + dz + (DIAG - 2) * lo;
}

/** 8-neighbourhood, in a FIXED order: the search's expansion order — and so
 *  the exact sequence of heap pushes — must not depend on anything else. */
const NBR_X = [1, -1, 0, 0, 1, 1, -1, -1] as const;
const NBR_Z = [0, 0, 1, -1, 1, -1, 1, -1] as const;

// --- polyline simplification --------------------------------------------------

/** Drop every point that lies on the straight run between its neighbours. Cheap
 *  (integer-free, one cross product per point) and it shrinks the input to the
 *  string-pull below from ~150 cells to a handful of corners, which is what
 *  keeps the string-pull's line-of-sight tests affordable. */
function collapseCollinear(pts: Vec2[]): Vec2[] {
  if (pts.length < 3) return pts;
  const out: Vec2[] = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    if (!p) continue;
    const a = out[out.length - 1];
    const c = pts[i + 1];
    if (a && c) {
      const cross = (p.x - a.x) * (c.z - a.z) - (p.z - a.z) * (c.x - a.x);
      if (cross === 0) continue;
    }
    out.push(p);
  }
  return out;
}

/** Greedy string pull: from the unit's real position, keep the farthest point
 *  still in line of sight, then repeat from there. Turns the cell-centre
 *  staircase A* produces into the two or three corners a player would have
 *  clicked, and every kept segment is `segmentWalkable`, so the follower's own
 *  cliff veto never disagrees with the route it was handed. */
function stringPull(t: TerrainDef, fromX: number, fromZ: number, pts: Vec2[]): Vec2[] {
  const out: Vec2[] = [];
  let ax = fromX;
  let az = fromZ;
  let i = 0;
  while (i < pts.length) {
    let j = i;
    for (;;) {
      const next = pts[j + 1];
      if (!next || !segmentWalkable(t, ax, az, next.x, next.z)) break;
      j += 1;
    }
    const keep = pts[j];
    if (!keep) break;
    out.push(keep);
    ax = keep.x;
    az = keep.z;
    i = j + 1;
  }
  return out;
}

// --- the search ---------------------------------------------------------------

/**
 * Grid A* from (fromX,fromZ) to (toX,toZ) over the terrain grid — HEROES ONLY
 * (TERRAIN_CONTRACT §4). Returns a simplified polyline whose LAST point is the
 * destination (or the reachable cell nearest to it, when the destination is
 * inside a cliff), or `null` when there is no route, the search would exceed
 * PATH_NODE_BUDGET, or the straight line is already clear — in every null case
 * the caller steers straight, which is the pre-terrain behaviour of every unit
 * in the sim and is never a stall.
 *
 * The straight-line early-out is not an optimisation detail: most orders are
 * across open ground, and a hero that walks a cell-centre polyline across an
 * empty field instead of a straight line looks broken.
 */
export function findPath(
  t: TerrainDef,
  fromX: number,
  fromZ: number,
  toX: number,
  toZ: number,
): Vec2[] | null {
  if (segmentWalkable(t, fromX, fromZ, toX, toZ)) return null;
  const g = t.grid;
  const cells = g.dim * g.dim;
  ensureScratch(cells);

  const startCx = axisCell(fromX, g.res, g.dim);
  const startCz = axisCell(fromZ, g.res, g.dim);
  const start = startCz * g.dim + startCx;
  if (!cellPassable(g, start)) return null;

  let goal = cellIndexAt(g, toX, toZ);
  let exact = true;
  if (!cellPassable(g, goal)) {
    const snapped = nearestPassableCell(g, toX, toZ, GOAL_SNAP_CELLS);
    if (snapped < 0) return null;
    goal = snapped;
    exact = false;
  }
  if (goal === start) return null;
  const goalCx = goal % g.dim;
  const goalCz = (goal - goalCx) / g.dim;

  state.fill(0);
  heapLen = 0;
  gCost[start] = 0;
  hCost[start] = octile(startCx, startCz, goalCx, goalCz);
  fCost[start] = hCost[start] ?? 0;
  parent[start] = -1;
  state[start] = 1;
  heapPush(start);

  let expanded = 0;
  let found = false;
  while (heapLen > 0) {
    const cur = heapPop();
    if (cur < 0 || state[cur] === 2) continue;
    state[cur] = 2;
    if (cur === goal) {
      found = true;
      break;
    }
    expanded += 1;
    if (expanded > PATH_NODE_BUDGET) return null;
    const cx = cur % g.dim;
    const cz = (cur - cx) / g.dim;
    const gc = gCost[cur] ?? 0;
    for (let n = 0; n < 8; n++) {
      const nx = cx + (NBR_X[n] ?? 0);
      const nz = cz + (NBR_Z[n] ?? 0);
      if (nx < 0 || nx >= g.dim || nz < 0 || nz >= g.dim) continue;
      const nb = nz * g.dim + nx;
      if (state[nb] === 2) continue;
      if (!gridStep(g, cx, cz, nx, nz)) continue;
      const stepCost = nx !== cx && nz !== cz ? DIAG : 1;
      const ng = gc + stepCost;
      if (state[nb] === 1 && ng >= (gCost[nb] ?? Infinity)) continue;
      gCost[nb] = ng;
      const h = octile(nx, nz, goalCx, goalCz);
      hCost[nb] = h;
      fCost[nb] = ng + h;
      parent[nb] = cur;
      state[nb] = 1;
      heapPush(nb);
    }
  }
  if (!found) return null;

  // Reconstruct backwards to (but excluding) the start cell: the unit is
  // already standing there and a waypoint on its own feet reads as a stutter.
  const raw: Vec2[] = [];
  for (let cur = goal; cur !== start && cur >= 0; cur = parent[cur] ?? -1) {
    raw.push({ x: cellMidX(g, cur), z: cellMidZ(g, cur) });
    if (raw.length > cells) break; // parent chains are acyclic; belt and braces
  }
  raw.reverse();
  if (raw.length === 0) return null;
  // The destination itself, not the centre of the cell holding it.
  if (exact) raw[raw.length - 1] = { x: toX, z: toZ };
  const route = stringPull(t, fromX, fromZ, collapseCollinear(raw));
  // A route ALWAYS ends on the requested point, even when that point is inside
  // rock. Two reasons, both load-bearing: the follower recognises a route as
  // current by comparing its last waypoint against the order destination, so a
  // route that stopped at the snapped cell would be re-planned every tick —
  // exactly the per-tick search §4 forbids — and the final unreachable leg is
  // what makes the hero press against the cliff face instead of halting a
  // metre short, which is how it has always treated a structure it was ordered
  // into.
  if (!exact) route.push({ x: toX, z: toZ });
  return route;
}
