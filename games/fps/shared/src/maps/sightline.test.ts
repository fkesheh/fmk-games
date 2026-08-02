// ============================================================================
// SIGHTLINE SWEEP — all six maps measured with ONE method.
//
// WHY THIS FILE EXISTS
// dustbowl.ts is the FROZEN REFERENCE MAP: its header states the quality bar
// every other map is held to. That header used to assert "cover at least every
// 8m; longest open sightline <= 42m" as unmeasured prose. A3 measured dustbowl
// and found 66.85m (whole-map) / 46.04m (down-lane): the 42m figure was never a
// sightline at all, it is the map's spawn-to-spawn depth (z=+21 to z=-21)
// written into the header by mistake.
//
// That matters beyond dustbowl, because every claim in this repo that a map
// "matches dustbowl's density and playability invariants" was checked against a
// number that never existed. A4 therefore applies A3's method, unchanged, to
// ALL SIX maps so the claims become comparable.
//
// MEASUREMENT ONLY. Nothing here may change map geometry — map rework is out of
// scope (STRICKEN_PASS.md §7). If a number below moves, the geometry moved, and
// catching that is precisely this file's job.
//
// It has since done that job once, deliberately: task A2 fixed a one-way creek
// crossing on frostbite and the pinned row went red on the spot. The row is
// re-pinned with the before/after spelled out inline, and A2's own reachability
// assertions live at the bottom of this file. That is the only sanctioned
// geometry change; every other pin stands as measured.
//
// ---------------------------------------------------------------------------
// METHOD — stated explicitly, because the answer depends entirely on it.
// Identical for all six maps; that comparability IS the deliverable.
// ---------------------------------------------------------------------------
// GEOMETRY. The real solids the server collides and shoots against:
//   `map.boxes.map(boxToAABB)` — byte-identical to `game.ts:206`. Blocking is
//   decided by `raycastSolids` from @fps/shared/physics, the same function
//   `combat.ts` uses for bullets and `bots.ts` uses for its can-I-see-you test.
//   No bespoke geometry is rolled here, so "open" means precisely what a player
//   experiences: a line a bullet would travel unobstructed. Client-only dressing
//   (`deco`, `accents`, `skyline`) is non-collidable and correctly ignored.
//
// WHICH POINTS. A 1.0m grid over the interior rectangle x,z in
//   [-sizeX/2+1, sizeX/2-1] x [-sizeZ/2+1, sizeZ/2-1], keeping only points where
//   a STANDING player body (PLAYER.radius, PLAYER.heightStand, feet at y=0) does
//   not overlap a solid — the same AABB overlap test physics.ts uses internally,
//   restated here because it is not exported. This is GROUND-LEVEL walkable
//   space only; see REACHABLE ELEVATION below for why that costs nothing.
//
// WHAT COUNTS AS "OPEN". Both endpoints are eyes at standing height,
//   y = PLAYER.heightStand - PLAYER.eyeOffset = 1.62m, so every probe ray is
//   horizontal. Open <=> `raycastSolids` finds no solid strictly between them.
//   Standing is the correct default: it is the taller eye and therefore the MORE
//   permissive one, and it is the stance a player moves and fights in.
//
// WHICH PAIRS — this distinction is the entire "42m vs 66.85m" discrepancy, so
//   both readings are measured and asserted separately, and neither is smoothed
//   into the other:
//     WHOLE-MAP  every unordered pair of walkable points, any direction,
//                INCLUDING DIAGONALS. This is what the gameplay audit measured.
//     DOWN-LANE  pairs within |dx| <= 2.0m of each other, i.e. looking straight
//                down the attack axis rather than across the map. Every one of
//                the six maps runs T at +z and CT at -z, so +/-z IS the attack
//                axis on all of them and one rule serves all six. On dustbowl
//                this reproduces A3's per-lane flank figure (46.04m) exactly,
//                which is why the generalisation is safe to trust.
//
// COVER, and the split that is the reusable lesson here:
//     PLAN VIEW      distance to the nearest solid that intersects the standing
//                    body band (minY < 1.8 && maxY > 0) — i.e. anything you would
//                    bump into. Ceilings and overhead awnings are excluded; they
//                    are not cover. On dustbowl all 41 boxes qualify, so A3's
//                    5.71m is reproduced unchanged.
//     ABOVE-EYE      distance to the nearest solid that CROSSES the standing eye
//                    plane (minY < 1.62 && maxY > 1.62) — cover you cannot simply
//                    see over, and the only cover that breaks a sightline. On
//                    dustbowl that is 13 of 41 boxes, A3's figure exactly.
//   Dustbowl passes "cover every 8m" in plan view (5.71m) and FAILS it above the
//   eye (8.50m). Crossfire fails it harder (9.30m). Every crate, sandbag block,
//   step and platform in this game is SEE-OVER cover, and the see-over ratio is
//   reported per map below.
//
// REACHABLE ELEVATION. Surfaces are enumerated per 0.5m cell (any box top with
//   PLAYER.heightStand of headroom), then flood-filled from ground level,
//   climbing only where the rise is <= the jump apex v^2/2g = 0.870m. This is
//   what makes the ground-level-only sampling above safe: the tallest surface a
//   player can actually reach on any of the six maps is 1.20m (dustbowl's B
//   platform), while every solid that blocks a standing eye is 1.62m+, so an
//   elevated eye at 2.82m still cannot see over anything that blocks a grounded
//   one. NOTE: a naive "highest standable surface per cell" gets this wrong —
//   office and bunker have full-footprint ceiling slabs whose TOPS are perfectly
//   standable in isolation and unreachable in fact.
//
// RESOLUTION. 1.0m in the suite, ~2.5s for all six maps. Verified converged
//   against a 0.5m sweep run offline (dustbowl, the largest walkable area at
//   2466 m^2, returns the IDENTICAL 66.85m and 46.04m; runtime 26s for six maps,
//   too slow for the suite). Grid sampling is a strict lower bound on the true
//   supremum: the 0.5m sweep moves whole-map figures up by at most +0.91m
//   (frostbite) and cover gaps up by at most +0.5m (dustbowl 5.71 -> 6.00 plan,
//   8.50 -> 9.00 above-eye). No verdict below changes between resolutions. The
//   assertions therefore lock the measured 1.0m value in a band rather than
//   claiming a proof of an upper bound.
// ============================================================================
import { describe, expect, it } from 'vitest';
import { PLAYER, WEAPONS } from '../config.js';
import { boxToAABB, raycastSolids, type AABB } from '../physics.js';
import { MAP_LIST } from './index.js';
import { dustbowl } from './dustbowl.js';
import type { MapDef } from './types.js';

const EYE_Y = PLAYER.heightStand - PLAYER.eyeOffset; // 1.62
const GRID_STEP = 1.0;
const REACH_CELL = 0.5;
/** Apex of a standing jump: the tallest ledge that can be mounted from a floor. */
const JUMP_APEX = (PLAYER.jumpVel * PLAYER.jumpVel) / (2 * PLAYER.gravity); // 0.87

/** The two numbers dustbowl's header asserts, and every other map is judged by. */
const REF_MAX_SIGHTLINE = 42;
const REF_MAX_COVER_GAP = 8;

interface P { x: number; z: number }

/** Mirrors the (unexported) body-vs-solid overlap in physics.ts, feet at y=0. */
function standingClear(x: number, z: number, solids: AABB[]): boolean {
  const r = PLAYER.radius;
  const h = PLAYER.heightStand;
  for (const s of solids) {
    if (
      x - r < s.maxX && x + r > s.minX &&
      0 < s.maxY && h > s.minY &&
      z - r < s.maxZ && z + r > s.minZ
    ) return false;
  }
  return true;
}

/** True if nothing solid stands between two standing eyes. */
function eyesOpen(a: P, b: P, dist: number, solids: AABB[]): boolean {
  const o = { x: a.x, y: EYE_Y, z: a.z };
  const d = { x: (b.x - a.x) / dist, y: 0, z: (b.z - a.z) / dist };
  return raycastSolids(o, d, solids, dist) < 0;
}

/**
 * Longest open sightline over the pairs `accept` admits.
 * Pairs no longer than the running best are skipped without a raycast — this
 * cannot change the answer (they could not raise a maximum) and it is what keeps
 * a multi-million-pair sweep inside a test timeout.
 */
function longestOpen(pts: P[], solids: AABB[], accept: (a: P, b: P) => boolean): number {
  let best = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]!;
    for (let j = i + 1; j < pts.length; j++) {
      const b = pts[j]!;
      const dist = Math.hypot(b.x - a.x, b.z - a.z);
      if (dist <= best) continue;
      if (!accept(a, b)) continue;
      if (eyesOpen(a, b, dist, solids)) best = dist;
    }
  }
  return best;
}

/** Planar distance from a point to an AABB's footprint (0 if inside). */
function planarDist(p: P, s: AABB): number {
  return Math.hypot(
    Math.max(s.minX - p.x, 0, p.x - s.maxX),
    Math.max(s.minZ - p.z, 0, p.z - s.maxZ),
  );
}

/** Worst "how far is the nearest piece of cover" over every walkable point. */
function worstCoverGap(pts: P[], cover: AABB[]): number {
  if (cover.length === 0) return Infinity;
  let worst = 0;
  for (const p of pts) {
    let nearest = Infinity;
    for (const s of cover) nearest = Math.min(nearest, planarDist(p, s));
    worst = Math.max(worst, nearest);
  }
  return worst;
}

const NEIGHBOURS = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;

interface SurfGrid {
  xs: number[];
  zs: number[];
  /** Every surface height at [i][j] a standing body fits on top of, ascending. */
  surf: number[][][];
}

/**
 * The (cell, surface) state space every reachability reading in this file
 * shares: a 0.5m grid over the interior, each cell carrying ground plus every
 * box top that has PLAYER.heightStand of headroom above it.
 *
 * States are (cell, surface) pairs, NOT (cell) — a cell can carry several
 * standable surfaces (floor under an awning, awning top) and collapsing them to
 * "the highest" wrongly reports an unreachable roof as the walkable floor.
 */
function surfaceGrid(m: MapDef, solids: AABB[]): SurfGrid {
  const r = PLAYER.radius;
  const h = PLAYER.heightStand;
  const hx = m.sizeX / 2 - 1;
  const hz = m.sizeZ / 2 - 1;
  const xs: number[] = [];
  const zs: number[] = [];
  for (let x = -hx; x <= hx + 1e-9; x += REACH_CELL) xs.push(x);
  for (let z = -hz; z <= hz + 1e-9; z += REACH_CELL) zs.push(z);
  const surf: number[][][] = xs.map((x) => zs.map((z) => {
    const cands = new Set<number>([0]);
    for (const s of solids) {
      if (x - r < s.maxX && x + r > s.minX && z - r < s.maxZ && z + r > s.minZ) cands.add(s.maxY);
    }
    const ok: number[] = [];
    for (const y of [...cands].sort((a, b) => a - b)) {
      let fits = true;
      for (const s of solids) {
        if (
          x - r < s.maxX && x + r > s.minX &&
          y + 1e-6 < s.maxY && y + h > s.minY + 1e-6 &&
          z - r < s.maxZ && z + r > s.minZ
        ) { fits = false; break; }
      }
      if (fits) ok.push(y);
    }
    return ok;
  }));
  return { xs, zs, surf };
}

/**
 * Flood-fill the (cell, surface) space from every GROUND cell the seed admits,
 * climbing only where the rise is within `maxRise`. Returns the visited state
 * keys.
 *
 * `maxRise` is the whole point of the split:
 *   PLAYER.stepUp (0.42m) — ON FOOT. The auto-step a moving player gets for
 *     free, with no jump input and no loss of speed.
 *   JUMP_APEX (0.87m)     — on foot PLUS a standing jump.
 * A route that exists only at the second limit is a route one team pays for and
 * the other does not, so the two readings must never be conflated.
 */
function floodFrom(
  g: SurfGrid,
  seed: (x: number, z: number) => boolean,
  maxRise: number,
  within: (x: number, z: number) => boolean = () => true,
): Set<string> {
  const { xs, zs, surf } = g;
  const seen = new Set<string>();
  const stack: [number, number, number][] = [];
  for (let i = 0; i < xs.length; i++) {
    for (let j = 0; j < zs.length; j++) {
      if (!seed(xs[i]!, zs[j]!) || !within(xs[i]!, zs[j]!)) continue;
      const k = surf[i]![j]!.indexOf(0);
      if (k >= 0) { seen.add(`${i},${j},${k}`); stack.push([i, j, k]); }
    }
  }
  while (stack.length > 0) {
    const [i, j, k] = stack.pop()!;
    const y = surf[i]![j]![k]!;
    for (const [di, dj] of NEIGHBOURS) {
      const ni = i + di;
      const nj = j + dj;
      if (ni < 0 || nj < 0 || ni >= xs.length || nj >= zs.length) continue;
      if (!within(xs[ni]!, zs[nj]!)) continue;
      const cand = surf[ni]![nj]!;
      for (let nk = 0; nk < cand.length; nk++) {
        if (cand[nk]! - y > maxRise + 1e-6) continue;
        const key = `${ni},${nj},${nk}`;
        if (seen.has(key)) continue;
        seen.add(key);
        stack.push([ni, nj, nk]);
      }
    }
  }
  return seen;
}

/** True if a fill reached GROUND (y=0) at any cell the predicate admits. */
function reachedGround(g: SurfGrid, seen: Set<string>, pred: (x: number, z: number) => boolean): boolean {
  const { xs, zs, surf } = g;
  for (let i = 0; i < xs.length; i++) {
    for (let j = 0; j < zs.length; j++) {
      if (!pred(xs[i]!, zs[j]!)) continue;
      const k = surf[i]![j]!.indexOf(0);
      if (k >= 0 && seen.has(`${i},${j},${k}`)) return true;
    }
  }
  return false;
}

/**
 * Highest standing surface a player can actually get to on foot, flood-filled
 * from ground level. Returns 0 for a map with no reachable elevation, plus the
 * distinct reachable levels and their areas.
 */
function reachableElevation(m: MapDef, solids: AABB[]): { max: number; levels: { y: number; area: number }[] } {
  const { xs, zs, surf } = surfaceGrid(m, solids);
  const seen = new Set<string>();
  const stack: [number, number, number][] = [];
  for (let i = 0; i < xs.length; i++) {
    for (let j = 0; j < zs.length; j++) {
      const k = surf[i]![j]!.indexOf(0);
      if (k >= 0) { seen.add(`${i},${j},${k}`); stack.push([i, j, k]); }
    }
  }
  const cells = new Map<number, number>();
  while (stack.length > 0) {
    const [i, j, k] = stack.pop()!;
    const y = surf[i]![j]![k]!;
    for (const [di, dj] of NEIGHBOURS) {
      const ni = i + di;
      const nj = j + dj;
      if (ni < 0 || nj < 0 || ni >= xs.length || nj >= zs.length) continue;
      const cand = surf[ni]![nj]!;
      for (let nk = 0; nk < cand.length; nk++) {
        const ny = cand[nk]!;
        if (ny - y > JUMP_APEX + 1e-6) continue; // too high to climb or jump
        const key = `${ni},${nj},${nk}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (ny > 1e-6) cells.set(Number(ny.toFixed(2)), (cells.get(Number(ny.toFixed(2))) ?? 0) + 1);
        stack.push([ni, nj, nk]);
      }
    }
  }
  const levels = [...cells.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([y, n]) => ({ y, area: n * REACH_CELL * REACH_CELL }));
  return { max: levels.length > 0 ? levels[levels.length - 1]!.y : 0, levels };
}

interface Measured {
  points: number;
  /** m^2 of ground-level standing room (one grid cell each). */
  area: number;
  solids: number;
  /** Solids intersecting the standing body band — everything that is cover. */
  cover: number;
  /** Solids crossing the standing eye plane — cover you cannot see over. */
  aboveEye: number;
  wholeMap: number;
  downLane: number;
  gapPlan: number;
  gapAboveEye: number;
  openSpawnPairs: number;
  spawnPairs: number;
  maxReachY: number;
  reachLevels: { y: number; area: number }[];
}

function measure(m: MapDef, boxes: readonly { x: number; y: number; z: number; w: number; h: number; d: number }[] = m.boxes): Measured {
  const solids = boxes.map(boxToAABB);
  const cover = solids.filter((s) => s.minY < PLAYER.heightStand && s.maxY > 0);
  const aboveEye = solids.filter((s) => s.minY < EYE_Y && s.maxY > EYE_Y);
  const pts: P[] = [];
  const hx = m.sizeX / 2 - 1;
  const hz = m.sizeZ / 2 - 1;
  for (let x = -hx; x <= hx + 1e-9; x += GRID_STEP) {
    for (let z = -hz; z <= hz + 1e-9; z += GRID_STEP) {
      if (standingClear(x, z, solids)) pts.push({ x, z });
    }
  }
  let openSpawnPairs = 0;
  for (const t of m.spawns.T) {
    for (const c of m.spawns.CT) {
      const d = Math.hypot(c.x - t.x, c.z - t.z);
      if (eyesOpen(t, c, d, solids)) openSpawnPairs++;
    }
  }
  const reach = reachableElevation(m, solids);
  return {
    points: pts.length,
    area: pts.length * GRID_STEP * GRID_STEP,
    solids: solids.length,
    cover: cover.length,
    aboveEye: aboveEye.length,
    wholeMap: longestOpen(pts, solids, () => true),
    downLane: longestOpen(pts, solids, (a, b) => Math.abs(b.x - a.x) <= 2.0),
    gapPlan: worstCoverGap(pts, cover),
    gapAboveEye: worstCoverGap(pts, aboveEye),
    openSpawnPairs,
    spawnPairs: m.spawns.T.length * m.spawns.CT.length,
    maxReachY: reach.max,
    reachLevels: reach.levels,
  };
}

const CACHE = new Map<string, Measured>();
function measured(m: MapDef): Measured {
  let v = CACHE.get(m.id);
  if (v === undefined) { v = measure(m); CACHE.set(m.id, v); }
  return v;
}

/**
 * The pinned sweep. Every figure below was MEASURED on a 1.0m grid, not chosen.
 * Distances carry a +/-0.5m band (they are deterministic, so the band exists
 * only to absorb a floating-point re-association, not real drift); counts are
 * pinned exactly, because a changed count means a box was added or removed.
 *
 * `verdictSightline` / `verdictCover` record whether the map meets the bar
 * dustbowl's header states. They are asserted, not annotated, so a map cannot
 * silently cross the line.
 */
const SWEEP = [
  {
    id: 'dustbowl', points: 2466, solids: 41, cover: 41, aboveEye: 13,
    wholeMap: 66.85, downLane: 46.04, gapPlan: 5.71, gapAboveEye: 8.50,
    openSpawnPairs: 0, maxReachY: 1.20,
  },
  {
    id: 'crossfire', points: 1553, solids: 50, cover: 47, aboveEye: 24,
    wholeMap: 60.54, downLane: 38.05, gapPlan: 4.29, gapAboveEye: 9.30,
    openSpawnPairs: 0, maxReachY: 0.90,
  },
  {
    id: 'office', points: 588, solids: 87, cover: 86, aboveEye: 41,
    wholeMap: 23.71, downLane: 22.09, gapPlan: 2.50, gapAboveEye: 5.35,
    openSpawnPairs: 0, maxReachY: 0.92,
  },
  {
    // RE-PINNED after the creek-crossing fix (A2): eight 0.4m step boxes added,
    // the mirrors of the eight already present, so all four crossings walk both
    // ways. Before -> after, every figure: points 1272 -> 1264, solids 60 -> 68,
    // cover 60 -> 68, aboveEye 37 -> 37 (unchanged — the new boxes are 0.4m, far
    // under the 1.62m eye), wholeMap 40.71 -> 40.71, downLane 29.07 -> 29.07,
    // gapPlan 3.26 -> 3.26, gapAboveEye 4.50 -> 4.50, openSpawnPairs 0 -> 0,
    // maxReachY 0.60 -> 0.60. NOT ONE SIGHTLINE OR COVER FIGURE MOVED: the fix
    // adds ankle-height geometry only, and how open frostbite plays is unchanged.
    // The see-over ratio moves 0.383 -> 0.456 purely as bookkeeping — the
    // denominator grew by 8 see-over boxes while `aboveEye` stood still.
    id: 'frostbite', points: 1264, solids: 68, cover: 68, aboveEye: 37,
    wholeMap: 40.71, downLane: 29.07, gapPlan: 3.26, gapAboveEye: 4.50,
    openSpawnPairs: 0, maxReachY: 0.60,
  },
  {
    id: 'urbana', points: 1106, solids: 79, cover: 60, aboveEye: 25,
    wholeMap: 42.30, downLane: 42.01, gapPlan: 3.80, gapAboveEye: 5.00,
    openSpawnPairs: 0, maxReachY: 1.10,
  },
  {
    id: 'bunker', points: 322, solids: 94, cover: 67, aboveEye: 51,
    wholeMap: 18.25, downLane: 17.12, gapPlan: 1.50, gapAboveEye: 3.10,
    openSpawnPairs: 0, maxReachY: 0.00,
  },
] as const;

const DIST_TOL = 0.5;
function byId(id: string): MapDef {
  const m = MAP_LIST.find((x) => x.id === id);
  if (m === undefined) throw new Error(`no such map: ${id}`);
  return m;
}

describe('sightline sweep — all six maps, one method', () => {
  it('covers every registered map, so a new map cannot dodge the sweep', () => {
    expect(SWEEP.map((s) => s.id).sort()).toEqual(MAP_LIST.map((m) => m.id).sort());
  });

  it.each(SWEEP)('$id: geometry census is unchanged', (row) => {
    const m = measured(byId(row.id));
    expect(m.solids).toBe(row.solids);
    expect(m.cover).toBe(row.cover);
    expect(m.aboveEye).toBe(row.aboveEye);
    expect(m.points).toBe(row.points);
  }, 60_000);

  it.each(SWEEP)('$id: WHOLE-MAP longest open sightline is $wholeMap m', (row) => {
    const m = measured(byId(row.id));
    expect(m.wholeMap).toBeGreaterThan(row.wholeMap - DIST_TOL);
    expect(m.wholeMap).toBeLessThan(row.wholeMap + DIST_TOL);
  }, 60_000);

  it.each(SWEEP)('$id: DOWN-LANE longest open sightline is $downLane m', (row) => {
    const m = measured(byId(row.id));
    expect(m.downLane).toBeGreaterThan(row.downLane - DIST_TOL);
    expect(m.downLane).toBeLessThan(row.downLane + DIST_TOL);
  }, 60_000);

  it.each(SWEEP)('$id: worst cover gap is $gapPlan m in plan view, $gapAboveEye m above the eye', (row) => {
    const m = measured(byId(row.id));
    expect(m.gapPlan).toBeGreaterThan(row.gapPlan - DIST_TOL);
    expect(m.gapPlan).toBeLessThan(row.gapPlan + DIST_TOL);
    expect(m.gapAboveEye).toBeGreaterThan(row.gapAboveEye - DIST_TOL);
    expect(m.gapAboveEye).toBeLessThan(row.gapAboveEye + DIST_TOL);
    // The lesson generalises: above-eye cover is never denser than plan cover.
    expect(m.gapAboveEye).toBeGreaterThanOrEqual(m.gapPlan);
  }, 60_000);

  it.each(SWEEP)('$id: no spawn sees an enemy spawn', (row) => {
    const m = measured(byId(row.id));
    // dustbowl's OTHER header invariant, and the one that genuinely holds —
    // here confirmed to hold on all six maps, mechanically rather than in prose.
    expect(m.openSpawnPairs).toBe(0);
    expect(m.spawnPairs).toBe(49);
  }, 60_000);
});

describe('the see-over-cover split — the lesson dustbowl taught, applied everywhere', () => {
  it.each(SWEEP)('$id: cover in PLAN VIEW meets the reference bar of 8m', (row) => {
    // This is the reading under which every map "matches dustbowl". All six pass.
    expect(measured(byId(row.id)).gapPlan).toBeLessThanOrEqual(REF_MAX_COVER_GAP);
  }, 60_000);

  it('dustbowl and crossfire FAIL the 8m bar once you only count cover you cannot see over', () => {
    // The reusable finding. Cover a standing player can see over is not cover:
    // it stops nothing and is the reason both maps measure so open. dustbowl,
    // the reference map, is the second-worst offender on its own bar.
    expect(measured(dustbowl).gapAboveEye).toBeGreaterThan(REF_MAX_COVER_GAP); // 8.50
    expect(measured(byId('crossfire')).gapAboveEye).toBeGreaterThan(REF_MAX_COVER_GAP); // 9.30
    for (const id of ['office', 'frostbite', 'urbana', 'bunker']) {
      expect(measured(byId(id)).gapAboveEye).toBeLessThanOrEqual(REF_MAX_COVER_GAP);
    }
  }, 60_000);

  it.each(SWEEP)('$id: see-over ratio — most cover is under a standing eye', (row) => {
    const m = measured(byId(row.id));
    const seeOver = 1 - m.aboveEye / m.cover;
    // Pinned per map; dustbowl is the WORST of the six at 68%, which is exactly
    // why the reference map is also the most open one.
    const expected: Record<string, number> = {
      dustbowl: 0.683, crossfire: 0.489, office: 0.523,
      // frostbite 0.383 -> 0.456 (A2): eight step boxes added to make the creek
      // crossing two-way. They are 0.4m tall, so they land in `cover` and never
      // in `aboveEye` — the ratio rose without a single sightline changing.
      frostbite: 0.456, urbana: 0.583, bunker: 0.239,
    };
    expect(seeOver).toBeCloseTo(expected[row.id]!, 2);
    expect(seeOver).toBeGreaterThan(0.2); // no map in this game is mostly hard cover
  }, 60_000);
});

describe("dustbowl's stated header invariants, applied to the maps that claim to match it", () => {
  it('three of six maps break the header\'s 42m figure on the WHOLE-MAP reading', () => {
    const over = SWEEP.filter((r) => measured(byId(r.id)).wholeMap > REF_MAX_SIGHTLINE).map((r) => r.id);
    expect(over.sort()).toEqual(['crossfire', 'dustbowl', 'urbana']);
  }, 60_000);

  it('two of six break it even DOWN-LANE, which is the more forgiving reading', () => {
    const over = SWEEP.filter((r) => measured(byId(r.id)).downLane > REF_MAX_SIGHTLINE).map((r) => r.id);
    expect(over.sort()).toEqual(['dustbowl', 'urbana']);
  }, 60_000);

  it('42m is the spawn-to-spawn depth, not a sightline — that is the whole error', () => {
    // The original figure reproduced from geometry: dustbowl's spawn rows sit at
    // z = +-21, and 21 - -21 = 42. It was a map dimension, written into the
    // header as if it were a measurement.
    const tz = Math.max(...dustbowl.spawns.T.map((s) => s.z));
    const cz = Math.min(...dustbowl.spawns.CT.map((s) => s.z));
    expect(tz - cz).toBe(REF_MAX_SIGHTLINE + 1); // 21.5 - -21.5, the outermost row
    expect(dustbowl.sizeZ).toBe(48);
  });
});

describe('audit claim: bunker is below the rifle\'s effective range', () => {
  it('the rifle rangeStart really is 22m and bunker really is shorter than that', () => {
    expect(WEAPONS.rifle.rangeStart).toBe(22);
    const m = measured(byId('bunker'));
    expect(m.wholeMap).toBeLessThan(WEAPONS.rifle.rangeStart);
  }, 60_000);

  it('but "below rangeStart" means FULL damage, so the claim\'s conclusion is inverted', () => {
    // falloffMul (physics.ts:277) returns 1 for dist <= rangeStart and only
    // DECAYS beyond it. Being under a weapon's rangeStart everywhere therefore
    // means that weapon is never penalised anywhere on the map.
    const longest = measured(byId('bunker')).wholeMap;
    // Rifle and sniper: never a single metre of falloff on bunker.
    expect(longest).toBeLessThan(WEAPONS.rifle.rangeStart);   // 22
    expect(longest).toBeLessThan(WEAPONS.sniper.rangeStart);  // 60
    // SMG and shotgun: these are the two that DO decay inside bunker.
    expect(longest).toBeGreaterThan(WEAPONS.smg.rangeStart);      // 14
    expect(longest).toBeGreaterThan(WEAPONS.shotgun.rangeEnd);    // 18
  }, 60_000);
});

describe('audit claim: "four maps have zero reachable height change"', () => {
  it('exactly ONE map is genuinely flat, and it is bunker', () => {
    const flat = SWEEP.filter((r) => measured(byId(r.id)).maxReachY === 0).map((r) => r.id);
    expect(flat).toEqual(['bunker']);
  }, 60_000);

  it('office and urbana do have reachable elevation, just a de-minimis amount', () => {
    // The claim named three maps while saying "four". Neither number is right.
    // Under a strict reading only bunker qualifies. Under a "no tactically
    // meaningful elevation" reading the named three do, and nothing else comes
    // close — the separation between the two groups is an order of magnitude of
    // elevated area, so it is a real distinction badly stated.
    const office = measured(byId('office'));
    const urbana = measured(byId('urbana'));
    expect(office.maxReachY).toBeCloseTo(0.92, 2); // a 0.8m desk, then its paper tray
    expect(urbana.maxReachY).toBeCloseTo(1.10, 2); // one market stall counter
    const area = (m: Measured) => m.reachLevels.reduce((a, l) => a + l.area, 0);
    expect(area(office)).toBeLessThan(15);   // ~12 m^2 of 588
    expect(area(urbana)).toBeLessThan(15);   // ~6.3 m^2 of 1106
    // The other three are not remotely in the same class.
    expect(area(measured(dustbowl))).toBeGreaterThan(40);
    expect(area(measured(byId('crossfire')))).toBeGreaterThan(40);
    expect(area(measured(byId('frostbite')))).toBeGreaterThan(400);
  }, 60_000);

  it('ground-level sampling is safe: no reachable surface lifts an eye over cover', () => {
    // Justifies the whole method. The tallest reachable floor across all six maps
    // is 1.20m; any solid that blocks a standing eye reaches at least 1.62m, and
    // the shortest such solid is taller than 1.20 + 1.62. So standing on the
    // highest thing a player can reach never grants a sightline the grid missed.
    for (const row of SWEEP) {
      expect(measured(byId(row.id)).maxReachY).toBeLessThanOrEqual(1.2);
    }
  }, 60_000);
});

describe('the measurement is sensitive — proof it can go red', () => {
  it('a cross of two tall walls collapses every dustbowl figure at once', () => {
    // Guards against the failure mode this whole file exists to prevent: a
    // number that looks measured but cannot actually respond to geometry. Two
    // 3m walls are injected into an in-memory COPY of the box list — one across
    // z=0, one down x=0. dustbowl.ts itself is never touched.
    const across = { x: 0, y: 1.5, z: 0, w: dustbowl.sizeX, h: 3, d: 1 };
    const along = { x: 0, y: 1.5, z: 0, w: 1, h: 3, d: dustbowl.sizeZ };
    const base = measured(dustbowl);
    const cut = measure(dustbowl, [...dustbowl.boxes, across, along]);
    expect(cut.aboveEye).toBe(base.aboveEye + 2);      // 13 -> 15
    expect(cut.points).toBeLessThan(base.points);      // 2466 -> 2385
    expect(cut.wholeMap).toBeLessThan(base.wholeMap - 25); // 66.85 -> 37.20
    expect(cut.downLane).toBeLessThan(base.downLane - 20); // 46.04 -> 22.09
    // A single wall across z is enough to halve the down-lane reading on its own.
    expect(measure(dustbowl, [...dustbowl.boxes, across]).downLane).toBeLessThan(25);
    // ...and the real map is unchanged by the probe.
    expect(measured(dustbowl).wholeMap).toBeGreaterThan(66.8);
    expect(measured(dustbowl).aboveEye).toBe(13);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// FROSTBITE — the frozen creek must be crossable ON FOOT in BOTH directions.
//
// The defect this section was written for: frostbite's creek is bounded by two
// 0.6m snow banks that run the FULL map width (x -29..29, i.e. wall to wall, no
// way round), and 0.6 > PLAYER.stepUp (0.42). The eight 0.4m step boxes that
// make the banks walkable were all placed on the SOUTH face of the obstacle
// they serve — one on the ground south of the south bank, one in the creek
// south of the north bank. Both therefore only assist a player moving south to
// north. A T could walk the whole way across; a CT could not walk across at
// all, in any lane, and had to jump both banks. On a map where creek control
// is the round, that is a free traversal for one team.
//
// Measured with the same (cell, surface) flood fill the census uses, at two
// rise limits: PLAYER.stepUp is "on foot", JUMP_APEX is "on foot plus a jump".
// ---------------------------------------------------------------------------
const FROSTBITE = byId('frostbite');
const FROST_SOLIDS: AABB[] = FROSTBITE.boxes.map(boxToAABB);
const FROST_GRID = surfaceGrid(FROSTBITE, FROST_SOLIDS);

/** The two spawn strips, used as the endpoints of a real traversal. */
const T_STRIP = (_x: number, z: number): boolean => z >= 18;
const CT_STRIP = (_x: number, z: number): boolean => z <= -18;

function walks(
  g: SurfGrid,
  from: (x: number, z: number) => boolean,
  to: (x: number, z: number) => boolean,
  maxRise: number,
  within?: (x: number, z: number) => boolean,
): boolean {
  return reachedGround(g, floodFrom(g, from, maxRise, within), to);
}

/** The four step-crossing lanes the map header names. */
const CREEK_LANES = [-21, -6, 6, 21] as const;

describe('frostbite: the frozen creek is crossable on foot in BOTH directions', () => {
  it('T -> CT: a terrorist walks from spawn to the CT spawn strip', () => {
    expect(walks(FROST_GRID, T_STRIP, CT_STRIP, PLAYER.stepUp)).toBe(true);
  }, 60_000);

  it('CT -> T: a counter-terrorist walks from spawn to the T spawn strip', () => {
    // THE REGRESSION. Against the pre-fix geometry this is false: every step box
    // faced south->north, so the CT had no walkable route over either bank.
    expect(walks(FROST_GRID, CT_STRIP, T_STRIP, PLAYER.stepUp)).toBe(true);
  }, 60_000);

  it.each(CREEK_LANES)('the x=%s crossing is two-way inside its own 3m corridor', (lane) => {
    // Stronger than "some route exists": each named lane must work both ways on
    // its own, so a fix cannot satisfy the map by adding a single step somewhere.
    const corridor = (x: number): boolean => Math.abs(x - lane) <= 1.5;
    const within = (x: number, _z: number): boolean => corridor(x);
    const south = (x: number, z: number): boolean => corridor(x) && z >= 2;
    const north = (x: number, z: number): boolean => corridor(x) && z <= -11;
    expect(walks(FROST_GRID, south, north, PLAYER.stepUp, within)).toBe(true);
    expect(walks(FROST_GRID, north, south, PLAYER.stepUp, within)).toBe(true);
  }, 60_000);

  it('the banks still cost something: they are above stepUp and only a jump clears them raw', () => {
    // The fix must not have flattened the creek. The banks are unchanged solids
    // 0.6m tall — taller than the 0.42m auto-step — so away from the four step
    // lanes the creek is still an obstacle you jump.
    const banks = FROSTBITE.boxes.filter((b) => b.h === 0.6 && b.w === 58);
    expect(banks.length).toBe(2);
    for (const b of banks) expect(b.y + b.h / 2).toBeGreaterThan(PLAYER.stepUp);
    expect(JUMP_APEX).toBeGreaterThan(0.6);
    // A 2m corridor at x=0 has no step lane in it and is dammed mid-creek: on
    // foot it is impassable in both directions, and that is intended cover.
    const mid = (x: number, _z: number): boolean => Math.abs(x) <= 1;
    const south = (x: number, z: number): boolean => Math.abs(x) <= 1 && z >= 2;
    const north = (x: number, z: number): boolean => Math.abs(x) <= 1 && z <= -11;
    expect(walks(FROST_GRID, south, north, PLAYER.stepUp, mid)).toBe(false);
    expect(walks(FROST_GRID, north, south, PLAYER.stepUp, mid)).toBe(false);
  }, 60_000);

  it('the fill is sensitive — deleting the step boxes closes the crossing again', () => {
    // Proof the two-way result above is produced by the step geometry and not by
    // a fill that says "true" for everything. The eight-plus step boxes are
    // removed from an in-memory COPY; frostbite.ts itself is never touched.
    const stripped = FROSTBITE.boxes.filter((b) => !(b.h === 0.4 && b.w === 2.4));
    expect(FROSTBITE.boxes.length - stripped.length).toBe(16); // 4 lanes x 4 steps
    const g = surfaceGrid(FROSTBITE, stripped.map(boxToAABB));
    expect(walks(g, T_STRIP, CT_STRIP, PLAYER.stepUp)).toBe(false);
    expect(walks(g, CT_STRIP, T_STRIP, PLAYER.stepUp)).toBe(false);
    // ...and with a jump allowed, the bank-only map is crossable both ways —
    // which is exactly why the defect was invisible to a jump-apex reading.
    expect(walks(g, T_STRIP, CT_STRIP, JUMP_APEX)).toBe(true);
    expect(walks(g, CT_STRIP, T_STRIP, JUMP_APEX)).toBe(true);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// A3's original dustbowl-specific readings, kept verbatim in substance. The
// generic DOWN-LANE rule above reproduces the flank figure (46.04m); these
// per-lane tests are what prove the two agree, and they carry the reference
// map's detail that a six-map table necessarily flattens.
// ---------------------------------------------------------------------------
const DUST_SOLIDS: AABB[] = dustbowl.boxes.map(boxToAABB);
const DUST_PTS: P[] = (() => {
  const pts: P[] = [];
  const hx = dustbowl.sizeX / 2 - 1;
  const hz = dustbowl.sizeZ / 2 - 1;
  for (let x = -hx; x <= hx; x += GRID_STEP) {
    for (let z = -hz; z <= hz; z += GRID_STEP) if (standingClear(x, z, DUST_SOLIDS)) pts.push({ x, z });
  }
  return pts;
})();

/** The three attack lanes, by the x-band the map's own dividers carve out. */
const LANES = [
  { name: 'mid', x0: -2, x1: 2, expected: 28.07 },
  { name: 'left', x0: -31, x1: -16, expected: 46.04 },
  { name: 'right', x0: 16, x1: 31, expected: 46.04 },
] as const;

describe('dustbowl per-lane detail (reference map)', () => {
  it.each(LANES)('$name lane measures $expected m', ({ x0, x1, expected }) => {
    const longest = longestOpen(DUST_PTS, DUST_SOLIDS, (a, b) =>
      a.x >= x0 && a.x <= x1 && b.x >= x0 && b.x <= x1 && Math.abs(b.x - a.x) <= 2.0);
    expect(longest).toBeCloseTo(expected, 1);
  }, 30_000);

  it('the flank lanes run 46.04m clear from back wall to back wall', () => {
    // The load-bearing correction. No reading of this map comes in at or under
    // 42m except the mid lane alone: the flanks have no above-eye cover at all,
    // their crates and sandbag lines topping out at 1.2m under a 1.62m eye.
    for (const L of LANES.filter((l) => l.name !== 'mid')) {
      const longest = longestOpen(DUST_PTS, DUST_SOLIDS, (a, b) =>
        a.x >= L.x0 && a.x <= L.x1 && b.x >= L.x0 && b.x <= L.x1 && Math.abs(b.x - a.x) <= 2.0);
      expect(longest).toBeGreaterThan(REF_MAX_SIGHTLINE);
    }
    // ...and the generic down-lane rule used for all six maps agrees with it.
    expect(measured(dustbowl).downLane).toBeCloseTo(46.04, 1);
  }, 30_000);

  it('the mid lane alone honours the old 42m figure, at 28.07m', () => {
    const longest = longestOpen(DUST_PTS, DUST_SOLIDS, (a, b) =>
      a.x >= -2 && a.x <= 2 && b.x >= -2 && b.x <= 2 && Math.abs(b.x - a.x) <= 2.0);
    expect(longest).toBeLessThan(REF_MAX_SIGHTLINE);
    expect(longest).toBeCloseTo(28.07, 1);
  }, 30_000);
});
