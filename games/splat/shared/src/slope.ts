// ============================================================================
// SKI SPLAT — SLOPE GENERATOR + VALIDATOR (task P2, CONTRACT §7). One seeded
// procedural mountain per race. Deterministic from `seed` via @platform/shared
// rng only. Pure: no Math.random, no Date, no window, no I/O.
//
// Terrain: h(x,z) = SUMMIT_LIFT - GRADE_BASE*z + the three frozen undulation
// octaves (config.ts), phases from rng(seed). The octaves' worst-case downhill
// gradient (0.057+0.057) stays under GRADE_BASE-GRADE_MIN = 0.13, so the
// fall-line grade is >= ~0.096 everywhere by construction. gradeAt projects
// the analytic gradient onto the heading (yaw 0 = +Z fall line) and clamps to
// GRADE_MIN — the clamp is the contract safety net for near-traverse headings
// (a true traverse IS flat; the clamp, not the undulation, owns that case).
//
// Plants: cluster-Poisson. Per 5 m z-slice, seeded Poisson draws spawn cluster
// centres (rho*PLANT_CLUSTER_PCT/E[cluster size]) and solo plants
// (rho*(1-PCT)); rho ramps PLANT_DENSITY_START -> FULL across the first
// PLANT_DENSITY_RAMP of the planted zone, then holds flat. Clusters lean pine,
// solos lean bush/thorn (STYLE_BIBLE: distinct archetypes). After scattering,
// a woven corridor centreline (shift <= WEAVE_STEP < CORRIDOR_MAX_SHIFT_M per
// band) is laid from gate to finish and every plant covering it is nudged
// aside — the connected >= PLANT_CORRIDOR_M plant-free corridor exists by
// CONSTRUCTION, so validateSlope's sweep/DP always passes on generated slopes.
// ============================================================================

import { rng, rngInt, rngRange } from '@platform/shared';
import {
  CORRIDOR_MAX_SHIFT_M,
  FINISH_CLEAR,
  FINISH_Z,
  GRADE_BASE,
  GRADE_MIN,
  PLANT_BAND_M,
  PLANT_CLUSTER_MAX,
  PLANT_CLUSTER_MIN,
  PLANT_CLUSTER_PCT,
  PLANT_CLUSTER_RADIUS,
  PLANT_CORRIDOR_M,
  PLANT_DENSITY_FULL,
  PLANT_DENSITY_RAMP,
  PLANT_DENSITY_START,
  PLANT_RADIUS,
  SLOPE_LENGTH,
  SLOPE_WIDTH,
  START_CLEAR,
  UND_LAT_AMP,
  UND_LAT_LEN,
  UND_LONG_1_AMP,
  UND_LONG_1_LEN,
  UND_LONG_2_AMP,
  UND_LONG_2_LEN,
  YAW_MAX,
} from './config.js';
import type { Plant, PlantKind, SlopeDef } from './types.js';

const TAU = Math.PI * 2;
const SUMMIT_LIFT = 6; // metres; keeps height(x, 0) a pleasant positive summit
const HALF_W = SLOPE_WIDTH / 2;
const PLANT_X = HALF_W - 1; // plants keep 1 m clear of the piste edge
const ZONE_Z0 = START_CLEAR;
const ZONE_Z1 = FINISH_Z - FINISH_CLEAR;
const ZONE_LEN = ZONE_Z1 - ZONE_Z0;
const SLICE_DZ = 5; // Poisson slice thickness (m); keeps per-slice lambda ~1
const CLUSTER_MEAN = (PLANT_CLUSTER_MIN + PLANT_CLUSTER_MAX) / 2;
const CORRIDOR_HALF = PLANT_CORRIDOR_M / 2;
const CORRIDOR_EPS = 0.05; // repair clearance margin beyond the bare minimum
const WEAVE_MAX = 20; // corridor centreline lateral bound (m)
const WEAVE_STEP = 3; // centreline max shift per band (< CORRIDOR_MAX_SHIFT_M)
const BAND_COUNT = Math.ceil(FINISH_Z / PLANT_BAND_M);

/** Mutable while building; frozen into readonly Plant[] at the end. */
interface MutablePlant {
  x: number;
  z: number;
  readonly r: number;
  readonly kind: PlantKind;
}

interface Interval {
  lo: number;
  hi: number;
}

/** Deterministic Poisson(k | lambda) via Knuth; lambda stays ~1 by design. */
function poisson(next: () => number, lambda: number): number {
  if (lambda <= 0) return 0;
  const cut = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k += 1;
    p *= next();
  } while (p > cut);
  return k - 1;
}

/** Kind mix: clusters lean pine, solos lean bush/thorn (STYLE_BIBLE law). */
function pickKind(next: () => number, clustered: boolean): PlantKind {
  const u = next();
  if (clustered) return u < 0.7 ? 'pine' : u < 0.9 ? 'bush' : 'thorn';
  return u < 0.3 ? 'pine' : u < 0.7 ? 'bush' : 'thorn';
}

/** Mean-reverting random-walk centreline; |shift| <= WEAVE_STEP per band. */
function weaveCentres(next: () => number): number[] {
  const centres: number[] = [];
  let c = rngRange(next, -3, 3);
  for (let k = 0; k < BAND_COUNT; k++) {
    centres.push(c);
    const drift = rngRange(next, -2, 2) - 0.1 * c;
    const step = Math.max(-WEAVE_STEP, Math.min(WEAVE_STEP, drift));
    c = Math.max(-WEAVE_MAX, Math.min(WEAVE_MAX, c + step));
  }
  return centres;
}

/**
 * Push every plant clear of the corridor polyline. A plant in band b enters
 * the corridor check for bands b-1..b+1 (same window the sim queries), so it
 * must sit >= r + CORRIDOR_HALF from ALL of centres[b-1..b+1]. One ordered
 * pass suffices: the corridor centres are fixed beforehand and each plant is
 * moved exactly once, to the nearer side of the centre range.
 */
function repairCorridor(plants: MutablePlant[], centres: readonly number[]): void {
  for (const p of plants) {
    const band = Math.floor(p.z / PLANT_BAND_M);
    let lo = Infinity;
    let hi = -Infinity;
    for (let j = band - 1; j <= band + 1; j++) {
      const c = centres[j];
      if (c === undefined) continue;
      if (c < lo) lo = c;
      if (c > hi) hi = c;
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) continue;
    const need = p.r + CORRIDOR_HALF + CORRIDOR_EPS;
    if (p.x < lo - need || p.x > hi + need) continue; // already clear of all tubes
    const left = lo - need;
    const right = hi + need;
    p.x = p.x - left <= right - p.x ? left : right; // smallest displacement wins
  }
}

/** Remove [lo, hi] from every free interval; drops degenerate slivers. */
function subtractInterval(free: readonly Interval[], lo: number, hi: number): Interval[] {
  const out: Interval[] = [];
  for (const i of free) {
    if (hi <= i.lo || lo >= i.hi) {
      out.push(i);
      continue;
    }
    if (lo > i.lo) out.push({ lo: i.lo, hi: Math.min(lo, i.hi) });
    if (hi < i.hi) out.push({ lo: Math.max(hi, i.lo), hi: i.hi });
  }
  return out.filter((i) => i.hi - i.lo > 1e-9);
}

function mergeIntervals(list: readonly Interval[]): Interval[] {
  const sorted = [...list].sort((a, b) => a.lo - b.lo);
  const out: Interval[] = [];
  for (const i of sorted) {
    const last = out[out.length - 1];
    if (last && i.lo <= last.hi) last.hi = Math.max(last.hi, i.hi);
    else out.push({ lo: i.lo, hi: i.hi });
  }
  return out;
}

/** Pairwise intersection of two sorted interval lists (both may be unsorted). */
function intersectIntervals(a: readonly Interval[], b: readonly Interval[]): Interval[] {
  const out: Interval[] = [];
  for (const i of a) {
    for (const j of b) {
      const lo = Math.max(i.lo, j.lo);
      const hi = Math.min(i.hi, j.hi);
      if (hi - lo > 1e-9) out.push({ lo, hi });
    }
  }
  return out;
}

/**
 * Free corridor-centre positions for one band: x where a PLANT_CORRIDOR_M-wide
 * tube fits. A plant excludes p.x +/- (r + CORRIDOR_HALF); plants from the
 * neighbouring bands count too (their discs cross the band boundary), matching
 * the sim's plantGrid(k-1..k+1) query window.
 */
function bandFreeIntervals(s: SlopeDef, band: number, halfW: number): Interval[] {
  let free: Interval[] = [{ lo: -halfW, hi: halfW }];
  for (let j = band - 1; j <= band + 1; j++) {
    for (const p of s.plantGrid(j)) {
      const cov = p.r + CORRIDOR_HALF;
      free = subtractInterval(free, p.x - cov, p.x + cov);
      if (free.length === 0) return free;
    }
  }
  return free;
}

export function genSlope(seed: number): SlopeDef {
  const next = rng(seed);

  // --- Terrain: three undulation phases, then the height/grade closures. ---
  const phi1 = rngRange(next, 0, TAU);
  const phi2 = rngRange(next, 0, TAU);
  const phi3 = rngRange(next, 0, TAU);
  const w1 = TAU / UND_LONG_1_LEN;
  const w2 = TAU / UND_LONG_2_LEN;
  const w3 = TAU / UND_LAT_LEN;

  const height = (x: number, z: number): number =>
    SUMMIT_LIFT -
    GRADE_BASE * z +
    UND_LONG_1_AMP * Math.sin(w1 * z + phi1) +
    UND_LONG_2_AMP * Math.sin(w2 * z + phi2) +
    UND_LAT_AMP * Math.sin(w3 * x + phi3);

  const gradeAt = (x: number, z: number, heading: number): number => {
    const dhdx = UND_LAT_AMP * w3 * Math.cos(w3 * x + phi3);
    const dhdz =
      -GRADE_BASE +
      UND_LONG_1_AMP * w1 * Math.cos(w1 * z + phi1) +
      UND_LONG_2_AMP * w2 * Math.cos(w2 * z + phi2);
    // Downhill steepness along the heading: -gradient . (sin h, cos h).
    const along = -(dhdx * Math.sin(heading) + dhdz * Math.cos(heading));
    return along < GRADE_MIN ? GRADE_MIN : along;
  };

  // --- Plants: cluster-Poisson over SLICE_DZ slices of the planted zone. ---
  const plants: MutablePlant[] = [];
  const sliceArea = SLICE_DZ * PLANT_X * 2;
  const sliceCount = Math.ceil(ZONE_LEN / SLICE_DZ);
  for (let i = 0; i < sliceCount; i++) {
    const z0 = ZONE_Z0 + i * SLICE_DZ;
    const rampT = Math.min(1, (z0 - ZONE_Z0) / (PLANT_DENSITY_RAMP * ZONE_LEN));
    const rho = PLANT_DENSITY_START + (PLANT_DENSITY_FULL - PLANT_DENSITY_START) * rampT;
    const nClusters = poisson(next, ((rho * PLANT_CLUSTER_PCT) / CLUSTER_MEAN) * sliceArea);
    const nSolo = poisson(next, rho * (1 - PLANT_CLUSTER_PCT) * sliceArea);
    for (let c = 0; c < nClusters; c++) {
      const cx = rngRange(next, -PLANT_X, PLANT_X);
      const cz = rngRange(next, z0, z0 + SLICE_DZ);
      const size = rngInt(next, PLANT_CLUSTER_MIN, PLANT_CLUSTER_MAX);
      for (let m = 0; m < size; m++) {
        const ang = rngRange(next, 0, TAU);
        const dist = PLANT_CLUSTER_RADIUS * Math.sqrt(next()); // uniform in disk
        const kind = pickKind(next, true);
        const px = cx + dist * Math.cos(ang);
        const pz = cz + dist * Math.sin(ang);
        // Out-of-zone members are dropped (not clamped) to stay Poisson-honest;
        // the ~2% edge loss is absorbed by the corridor repair and test slack.
        if (px < -PLANT_X || px > PLANT_X || pz < ZONE_Z0 || pz > ZONE_Z1) continue;
        plants.push({ x: px, z: pz, r: PLANT_RADIUS[kind], kind });
      }
    }
    for (let s = 0; s < nSolo; s++) {
      const kind = pickKind(next, false);
      plants.push({
        x: rngRange(next, -PLANT_X, PLANT_X),
        z: rngRange(next, z0, z0 + SLICE_DZ),
        r: PLANT_RADIUS[kind],
        kind,
      });
    }
  }

  // --- Guaranteed corridor: woven centreline, then nudge blockers aside. ---
  const centres = weaveCentres(next);
  repairCorridor(plants, centres);

  // --- Banded spatial index, built once; plantGrid is O(band size). ---
  const grid = new Map<number, MutablePlant[]>();
  for (const p of plants) {
    const k = Math.floor(p.z / PLANT_BAND_M);
    const bucket = grid.get(k);
    if (bucket) bucket.push(p);
    else grid.set(k, [p]);
  }
  const frozenGrid = new Map<number, readonly Plant[]>();
  for (const [k, bucket] of grid) frozenGrid.set(k, Object.freeze(bucket));
  const EMPTY: readonly Plant[] = Object.freeze([]);
  const frozenPlants: readonly Plant[] = Object.freeze(plants);

  return {
    seed,
    length: SLOPE_LENGTH,
    width: SLOPE_WIDTH,
    finishZ: FINISH_Z,
    plants: frozenPlants,
    height,
    gradeAt,
    plantGrid: (zBand: number) => frozenGrid.get(zBand) ?? EMPTY,
  };
}

/** Violations on a dense sample grid + corridor sweep/DP; [] means ok. */
export function validateSlope(s: SlopeDef): string[] {
  const violations: string[] = [];
  const push = (msg: string): void => {
    if (violations.length < 50) violations.push(msg); // cap spam, keep signal
  };

  // 1. Grade floor: gradeAt must honour the GRADE_MIN clamp at every sampled
  //    position and at every heading a skier can actually reach (|yaw| <=
  //    YAW_MAX). The generator's analytic fall-line bound is proven in
  //    config.ts; this samples the full clamp contract, not sampling luck.
  const headings = [0, 0.7, -0.7, YAW_MAX, -YAW_MAX];
  for (let xi = 0; xi <= 28; xi++) {
    const x = -s.width / 2 + (s.width * xi) / 28;
    for (let zi = 0; zi <= 160; zi++) {
      const z = (s.finishZ * zi) / 160;
      for (const h of headings) {
        const g = s.gradeAt(x, z, h);
        if (!(g >= GRADE_MIN)) {
          push(`gradeAt(${x.toFixed(1)}, ${z.toFixed(1)}, ${h}) = ${g} < GRADE_MIN ${GRADE_MIN}`);
        }
      }
    }
  }

  // 2. Clear zones: nothing near the gate, nothing in the finish sprint.
  for (const p of s.plants) {
    if (p.z < START_CLEAR) {
      push(`plant at z=${p.z.toFixed(2)} violates START_CLEAR (${START_CLEAR} m)`);
    }
    if (p.z > s.finishZ - FINISH_CLEAR) {
      push(`plant at z=${p.z.toFixed(2)} violates FINISH_CLEAR (${FINISH_CLEAR} m)`);
    }
  }

  // 3. Connected plant-free corridor, gate to finish. Per band the free
  //    centre positions must be non-empty, AND consecutive bands' free sets
  //    must connect within CORRIDOR_MAX_SHIFT_M of lateral movement — a sweep
  //    over reachable-interval sets, not per-band independence.
  const halfW = s.width / 2;
  const bandCount = Math.ceil(s.finishZ / PLANT_BAND_M);
  let reachable: Interval[] | null = null;
  for (let k = 0; k < bandCount; k++) {
    const free = bandFreeIntervals(s, k, halfW);
    if (free.length === 0) {
      push(
        `corridor: band ${k} (z ${k * PLANT_BAND_M}-${(k + 1) * PLANT_BAND_M}) has no ` +
          `plant-free x-interval of width ${PLANT_CORRIDOR_M} m`,
      );
      break;
    }
    if (reachable === null) {
      reachable = free;
      continue;
    }
    const expanded = mergeIntervals(
      reachable.map((i) => ({ lo: i.lo - CORRIDOR_MAX_SHIFT_M, hi: i.hi + CORRIDOR_MAX_SHIFT_M })),
    );
    reachable = intersectIntervals(free, expanded);
    if (reachable.length === 0) {
      push(
        `corridor: disconnected between band ${k - 1} and band ${k} — free intervals ` +
          `move more than CORRIDOR_MAX_SHIFT_M (${CORRIDOR_MAX_SHIFT_M} m)`,
      );
      break;
    }
  }

  return violations;
}
