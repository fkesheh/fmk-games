// ============================================================================
// SKI SPLAT — SLOPE GENERATOR + VALIDATOR (task P2, CONTRACT §7). One seeded
// procedural mountain per race. Deterministic from `seed` via @platform/shared
// rng only. Pure: no Math.random, no Date, no window, no I/O.
//
// Terrain: h(x,z) = SUMMIT_LIFT - GRADE_BASE*z + the three frozen undulation
// octaves (config.ts), phases from rng(seed). The octaves' worst-case downhill
// gradient (0.1485+0.0228 = 0.1714) stays under GRADE_BASE-GRADE_MIN = 0.18
// (0.26-0.08), but that margin does NOT make the fall-line grade >= ~0.146
// everywhere by construction — that older claim was wrong (verified by direct
// measurement: 20 seeds incl. 42, finite-difference sampling of height() at
// dz=0.5m over z=[0,800), the true minimum unclamped fall-line grade is
// ~0.089). gradeAt projects the analytic gradient onto the heading (yaw 0 =
// +Z fall line) and clamps to GRADE_MIN — the clamp (not construction) is
// what keeps the grade "never stuck": it's the contract safety net for both
// near-traverse headings and the fall-line dips that get within ~0.009 of
// GRADE_MIN (a true traverse IS flat; the clamp owns both cases).
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
//
// Slalom gates: GATE_COUNT flags, one per GATE_SPACING_M (z jitter +-
// GATE_JITTER_M, seeded) from GATE_FIRST_Z to the finish clear zone. Each
// gate's x starts on the woven corridor centreline (+- GATE_X_JITTER) and
// snaps to the nearest plant-free centre position of its band — the same
// free-interval machinery validateSlope sweeps — so a corridor-following
// skier can thread every gate, and the whole opening stays on-piste.
//
// Carve tracks (CONTRACT_V3 §12.3a, STYLE_BIBLE §V3.8): buildTrackMask() at
// the bottom of this file is a PURELY VISUAL, build-time sampler for the
// pre-skied S-curves the renderer paints over the corduroy. It runs on its
// OWN rng stream, rng(seed ^ GROOM_PHASE_SALT) — genSlope's sequential stream
// is not touched by a single draw (§12.3c: any inserted draw relocates every
// plant, gate and kicker in the world).
// ============================================================================

import { rng, rngInt, rngRange } from '@platform/shared';
import {
  CORRIDOR_MAX_SHIFT_M,
  FINISH_CLEAR,
  FINISH_Z,
  GATE_FIRST_Z,
  GATE_HALF_WIDTH,
  GATE_JITTER_M,
  GATE_SPACING_M,
  GRADE_BASE,
  KICKER_COUNT,
  KICKER_HALF_WIDTH,
  KICKER_PLANT_CLEAR,
  KICKER_SPACING,
  KICKER_X_JITTER,
  KICKER_Z0,
  KICKER_Z_JITTER,
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
import type { Gate, Kicker, Plant, PlantKind, SlopeDef } from './types.js';

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
// Gates: ~14 per run, first after the learning zone, last clear of the sprint.
const GATE_COUNT = Math.floor((FINISH_Z - FINISH_CLEAR - GATE_FIRST_Z) / GATE_SPACING_M);
const GATE_X_JITTER = 6; // gates sit on/within ~6 m of the corridor centreline
const GATE_X_MAX = HALF_W - 1 - GATE_HALF_WIDTH; // the whole opening stays on-piste
const KICKER_X_MAX = HALF_W - 1 - KICKER_HALF_WIDTH; // kicker fully on-piste: |x|+halfWidth <= width/2-1

/** Mutable while building; frozen into readonly Plant[] at the end. */
interface MutablePlant {
  x: number;
  z: number;
  readonly r: number;
  readonly kind: PlantKind;
}

/** A free x-range; exported so tests can read bandFreeIntervals results. */
export interface Interval {
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
function gridFreeIntervals(
  plantGrid: (zBand: number) => readonly Plant[],
  band: number,
  halfW: number,
): Interval[] {
  let free: Interval[] = [{ lo: -halfW, hi: halfW }];
  for (let j = band - 1; j <= band + 1; j++) {
    for (const p of plantGrid(j)) {
      const cov = p.r + CORRIDOR_HALF;
      free = subtractInterval(free, p.x - cov, p.x + cov);
      if (free.length === 0) return free;
    }
  }
  return free;
}

/**
 * The corridor machinery over a built SlopeDef (validator + gate placement +
 * the slope tests all read the same free intervals).
 */
export function bandFreeIntervals(s: SlopeDef, band: number, halfW: number): Interval[] {
  return gridFreeIntervals(s.plantGrid, band, halfW);
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
  const gridAt = (zBand: number): readonly Plant[] => frozenGrid.get(zBand) ?? EMPTY;

  // --- Slalom gates: one per GATE_SPACING_M (+- GATE_JITTER_M) along the
  // corridor. x aims at the centreline +- GATE_X_JITTER, then snaps to the
  // nearest plant-free centre position of its band (the centreline itself is
  // always free by construction, so the snap never travels far), clamped so
  // the whole opening stays on the piste.
  const gates: Gate[] = [];
  for (let i = 0; i < GATE_COUNT; i++) {
    const zJit = GATE_FIRST_Z + i * GATE_SPACING_M + rngRange(next, -GATE_JITTER_M, GATE_JITTER_M);
    const z = Math.max(GATE_FIRST_Z, Math.min(ZONE_Z1, zJit));
    const f = z / PLANT_BAND_M;
    const k = Math.floor(f);
    const c0 = centres[k] ?? 0;
    const c1 = centres[k + 1] ?? c0;
    const target = c0 + (c1 - c0) * (f - k) + rngRange(next, -GATE_X_JITTER, GATE_X_JITTER);
    let x = Math.max(-GATE_X_MAX, Math.min(GATE_X_MAX, target)); // fallback (never hit)
    let bestD = Infinity;
    for (const iv of gridFreeIntervals(gridAt, Math.floor(z / PLANT_BAND_M), HALF_W)) {
      const lo = Math.max(iv.lo, -GATE_X_MAX);
      const hi = Math.min(iv.hi, GATE_X_MAX);
      if (hi - lo <= 1e-9) continue;
      const p = Math.max(lo, Math.min(hi, target));
      const d = Math.abs(p - target);
      if (d < bestD) {
        bestD = d;
        x = p;
      }
    }
    gates.push({ x, z, halfWidth: GATE_HALF_WIDTH });
  }

  return {
    seed,
    length: SLOPE_LENGTH,
    width: SLOPE_WIDTH,
    finishZ: FINISH_Z,
    plants: frozenPlants,
    gates: Object.freeze(gates),
    // --- Kicker ramps (v2 §11.3): KICKER_COUNT ramps along the corridor
    // centreline, strictly ascending z, on-piste, plant-clear. Same
    // centreline + gridFreeIntervals machinery the slalom gates use.
    kickers: (() => {
      const out: Kicker[] = [];
      let prevZ = -Infinity;
      for (let i = 0; i < KICKER_COUNT; i++) {
        const zJit =
          KICKER_Z0 + i * KICKER_SPACING + rngRange(next, -KICKER_Z_JITTER, KICKER_Z_JITTER);
        let z = Math.max(START_CLEAR, Math.min(ZONE_Z1, zJit));
        if (z <= prevZ) z = Math.min(ZONE_Z1, prevZ + 0.01);
        if (z > ZONE_Z1) break; // ran out of room (shouldn't happen)
        prevZ = z;
        const f = z / PLANT_BAND_M;
        const k = Math.floor(f);
        const c0 = centres[k] ?? 0;
        const c1 = centres[k + 1] ?? c0;
        const target =
          c0 + (c1 - c0) * (f - k) + rngRange(next, -KICKER_X_JITTER, KICKER_X_JITTER);
        // Build free intervals using KICKER_PLANT_CLEAR (not CORRIDOR_HALF)
        // so the kicker centre is guaranteed plant-clear, not just corridor-clear.
        const band = Math.floor(z / PLANT_BAND_M);
        let free: Interval[] = [{ lo: -KICKER_X_MAX, hi: KICKER_X_MAX }];
        for (let j = band - 1; j <= band + 1 && free.length > 0; j++) {
          for (const p of gridAt(j)) {
            free = subtractInterval(free, p.x - KICKER_PLANT_CLEAR, p.x + KICKER_PLANT_CLEAR);
            if (free.length === 0) break;
          }
        }
        let x: number;
        if (free.length === 0) {
          // Every position in [-KICKER_X_MAX, KICKER_X_MAX] is too close to a
          // plant — should not happen because the corridor is wider than 2×
          // KICKER_PLANT_CLEAR (3 m > 4.4 m? no — but the corridor repair
          // pushes plants at least r+CORRIDOR_HALF away, so the centreline
          // region has at least ~2.4 m clearance on each side). Fall back to
          // the centreline clamp as a last resort.
          x = Math.max(-KICKER_X_MAX, Math.min(KICKER_X_MAX, target));
        } else {
          let bestD = Infinity;
          x = target; // will be overwritten
          for (const iv of free) {
            const p = Math.max(iv.lo, Math.min(iv.hi, target));
            const d = Math.abs(p - target);
            if (d < bestD) { bestD = d; x = p; }
          }
        }
        out.push({ x, z, halfWidth: KICKER_HALF_WIDTH });
      }
      return Object.freeze(out) as readonly Kicker[];
    })(),
    height,
    gradeAt,
    plantGrid: gridAt,
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

  // 4. Slalom gates: strictly ascending z, opening fully on the piste, none
  //    in either clear zone, and the count within +/-2 of the spacing
  //    expectation (jitter and the finish clear zone shift it a little).
  let prevGateZ = -Infinity;
  for (const g of s.gates) {
    if (!(g.z > prevGateZ)) {
      push(`gate at z=${g.z.toFixed(2)} is not strictly ascending (previous ${prevGateZ.toFixed(2)})`);
    }
    prevGateZ = g.z;
    if (g.z < START_CLEAR) {
      push(`gate at z=${g.z.toFixed(2)} violates START_CLEAR (${START_CLEAR} m)`);
    }
    if (g.z > s.finishZ - FINISH_CLEAR) {
      push(`gate at z=${g.z.toFixed(2)} violates FINISH_CLEAR (${FINISH_CLEAR} m)`);
    }
    if (g.x - g.halfWidth < -halfW || g.x + g.halfWidth > halfW) {
      push(
        `gate at z=${g.z.toFixed(2)} x=${g.x.toFixed(2)} halfWidth=${g.halfWidth} ` +
          `reaches off-piste (width ${s.width})`,
      );
    }
  }
  const expectedGates = Math.floor(
    (s.finishZ - FINISH_CLEAR - GATE_FIRST_Z) / GATE_SPACING_M,
  );
  if (Math.abs(s.gates.length - expectedGates) > 2) {
    push(`gate count ${s.gates.length} is outside +/-2 of the expected ${expectedGates}`);
  }

  // 5. Kicker placement laws (v2 §11.3). Skip when the slope carries no
  //    kickers (synthetic defs from tests are exempt unless they opt in).
  if (s.kickers.length > 0) {
    let prevKickerZ = -Infinity;
    for (const k of s.kickers) {
      if (!(k.z > prevKickerZ)) {
        push(
          `kicker at z=${k.z.toFixed(2)} is not strictly ascending ` +
            `(previous ${prevKickerZ.toFixed(2)})`,
        );
      }
      prevKickerZ = k.z;
      if (k.z < START_CLEAR) {
        push(`kicker at z=${k.z.toFixed(2)} violates START_CLEAR (${START_CLEAR} m)`);
      }
      if (k.z > s.finishZ - FINISH_CLEAR) {
        push(`kicker at z=${k.z.toFixed(2)} violates FINISH_CLEAR (${FINISH_CLEAR} m)`);
      }
      if (Math.abs(k.x) + k.halfWidth > s.width / 2 - 1 + 1e-9) {
        push(
          `kicker at z=${k.z.toFixed(2)} x=${k.x.toFixed(2)} ` +
            `halfWidth=${k.halfWidth} off-piste (width ${s.width})`,
        );
      }
    }
    if (Math.abs(s.kickers.length - KICKER_COUNT) > 1) {
      push(
        `kicker count ${s.kickers.length} outside ±1 of KICKER_COUNT ${KICKER_COUNT}`,
      );
    }
    // No plant within KICKER_PLANT_CLEAR of a kicker (launch + landing must be readable).
    const pc2 = KICKER_PLANT_CLEAR * KICKER_PLANT_CLEAR;
    for (const k of s.kickers) {
      for (const p of s.plants) {
        const dx = k.x - p.x;
        const dz = k.z - p.z;
        if (dx * dx + dz * dz < pc2 - 1e-9) {
          push(
            `kicker at z=${k.z.toFixed(2)} x=${k.x.toFixed(2)} too close to plant ` +
              `at z=${p.z.toFixed(2)} x=${p.x.toFixed(2)} (dist ${Math.sqrt(dx * dx + dz * dz).toFixed(2)} < ${KICKER_PLANT_CLEAR})`,
          );
          break; // one violation per kicker is enough
        }
      }
    }
  }

  return violations;
}

// ============================================================================
// CARVE TRACKS — task W1, CONTRACT_V3 §12.3a / §12.3c, STYLE_BIBLE §V3.8
//
// Purely visual. Nothing below this line is read by sim.ts, room.ts or
// validateSlope; it exists so the renderer can paint the mountain as *already
// skied* — the single cheapest read of "people have been here" available
// inside flat Lambert with no textures.
//
// THREE LAWS THIS SECTION OBEYS, IN ORDER OF HOW BADLY THEY BREAK THINGS:
//
// 1. RNG ISOLATION (§12.3c). genSlope() runs ONE sequential stream consumed by
//    phi1/2/3 -> weaveCentres -> the plant Poisson scatter -> gates -> kickers.
//    A single extra next() anywhere in it relocates every plant, gate and
//    kicker on the mountain and silently breaks room.test.ts:590/613/650 plus
//    e2e checks 9b/10/11a, all pinned to the exact geometry of genSlope(42).
//    So buildTrackMask constructs its OWN stream, rng(seed ^ GROOM_PHASE_SALT),
//    and genSlope above is not modified by one draw. Precedent: terrain.ts:209.
//
// 2. BUILD-TIME, NOT PER-VERTEX (§12.3a). The seam is a two-stage builder, not
//    a bare trackMask(slope, x, z): terrain's vertex loop runs 129 x 257 =
//    33,153 iterations, and a per-call `rng(...)` would rebuild the generator
//    and re-draw all 6-10 curves 33k times per terrain build. The curves are
//    drawn ONCE here; the returned closure is a pure, allocation-free sampler.
//
// 3. THE GROOMED BAND, NOT THE WEAVE (§12.3b). Tracks live on x = 0 +/-
//    GROOM_BAND_HALF_M — the FIXED corduroy band, which does NOT follow the
//    plant-free weave centreline. They are drawn OVER the corduroy (machine
//    first, then people), and share its phase: the first draw off this stream
//    is bit-identical to terrain.ts:209's corrPhase, so the two patterns move
//    together per mountain instead of sliding against each other.
// ============================================================================

/**
 * Half-width of the groomed corduroy band (m), measured from x = 0.
 * Frozen in CONTRACT_V3 §12.3a: terrain.ts's `GROOM_BAND_FRAC` (0.18) x
 * `SLOPE_WIDTH` (56). Lives here because the tracks must sit on exactly the
 * band the terrain already draws and `shared/` cannot import from `client/`.
 * W2 imports this and deletes its local literal.
 */
export const GROOM_BAND_HALF_M = 10.08;

/**
 * Salt for the groom RNG stream — was the inline literal at terrain.ts:209.
 * `rng(slope.seed ^ GROOM_PHASE_SALT)` is the ONE stream all groom-related
 * randomness (corduroy phase + carve tracks) may draw from (§12.3c).
 */
export const GROOM_PHASE_SALT = 0xc0a1;

// --- Track shape constants (§V3.8) -----------------------------------------
const TRACK_COUNT_MIN = 6; // "6-10 seeded S-curves"
const TRACK_COUNT_MAX = 10;
const TRACK_WL_MIN = 12; // S-curve wavelength along z (m)
const TRACK_WL_MAX = 25;
// Widened from 0.5/0.7 (§bugfix, post-V3.8 review): the consumer vertex grid
// (terrain.ts SEG_X=128 over +/-56m, SEG_Z=256 over -30..940m) samples at
// dx=0.875 m / dz~3.79 m. A 0.5-0.7 m trench (full-strength core 0.25-0.35 m)
// is narrower than one vertex column, so point-sampling it from the mesh
// produced isolated single-vertex dots instead of a connected line — measured
// 480/5911 in-band vertices nonzero, ~40% of those fully isolated (all 4
// neighbours zero). >=1.6 m keeps the trench >= ~2x the tighter (x) pitch, so
// a curve always covers >=2 adjacent columns at any point the mesh samples it.
const TRACK_WIDTH_MIN = 1.6; // trench full width (m)
const TRACK_WIDTH_MAX = 2.2;
// |dx/dz| ceiling for a curve. amp*TAU/wl is the steepest lateral rate; 0.85
// caps a track at ~40 deg off the fall line, which is a carve. Without it a
// 4 m amplitude on a 12 m wavelength would sweep at 67 deg — a traverse, and
// visibly not a line anyone skis down a groomed piste.
const TRACK_SLOPE_MAX = 0.85;
const TRACK_AMP_FRAC_MIN = 0.45; // shortest swing = 45% of the capped amplitude
// Widened from 0.28 alongside TRACK_WIDTH_* (see above) — kept proportional to
// the wider trench so the spoil edge stays a thin accent, not the dominant
// stripe.
const TRACK_SPOIL_M = 0.8; // "a thin snowLit spoil edge" outside the trench
// Spoil peak amplitude. Deliberately below the trench's 1.0: the shade side of
// a carve is the read, the bright spray is the accent. Also keeps the cross-
// section's steepest gradient (4*SPOIL_PEAK/TRACK_SPOIL_M ~ 3.75 /m) in the
// same band as the trench wall's (1.5/(half*0.5) ~ 2.7-3.75 /m), so neither
// edge aliases noticeably harder than the other at terrain vertex spacing.
const TRACK_SPOIL_PEAK = 0.75;
const TRACK_BAND_MARGIN = 0.9; // trench + spoil stay this far inside the band
const TRACK_FADE_M = 16; // "tracks ... fade in and out" — z ramp length (m)
const TRACK_Z0_MIN = -20; // a few tracks are already running at the start gate
const TRACK_Z0_MAX = 140;
const TRACK_LEN_MIN = 120;
const TRACK_LEN_MAX = 520;
const TRACK_Z_OVERRUN = 30; // tracks may run a little past the finish line
// "a few run off a kicker lip and resume downhill of it"
const TRACK_JUMP_PCT = 0.4; // share of tracks that take the ramps
const KICKER_TRACK_X = 6; // a track within this of a kicker's x rides its lip
const KICKER_GAP_MIN = 8; // airborne gap in the track downhill of the lip (m)
const KICKER_GAP_MAX = 18;
const KICKER_LIP_LEAD = 1.5; // the track lifts just before the lip, not on it
const KICKER_GAP_EDGE = 2; // soft take-off / landing ends of that gap (m)

/** Hermite smoothstep, clamped to [0, 1] (mirrors terrain.ts's smooth01). */
function smoothStep01(t: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return t * t * (3 - 2 * t);
}

/** One pre-skied S-curve, fully baked at build time. Never mutated. */
interface CarveTrack {
  readonly amp: number; // lateral swing (m)
  readonly k: number; // TAU / wavelength (rad per m of z)
  readonly phase: number; // includes the corduroy's corrPhase
  readonly offset: number; // the curve's mean x within the band (m)
  readonly half: number; // trench half-width (m)
  readonly outer: number; // half + TRACK_SPOIL_M — beyond this the track is 0
  readonly z0: number;
  readonly z1: number;
  /** Flat [g0, g1, g0, g1, ...] airborne gaps where the track leaves the snow. */
  readonly gaps: readonly number[];
}

/**
 * Build the pre-skied carve-track sampler for a slope (§V3.2 / §V3.8).
 *
 * The 6-10 S-curves are drawn ONCE here, from an isolated stream
 * `rng(slope.seed ^ GROOM_PHASE_SALT)` (§12.3c). The returned closure is a
 * cheap pure sampler safe to call per vertex at BUILD time (never per frame):
 * it allocates nothing, reads nothing outside its own captured tracks, and is
 * a total function of (x, z).
 *
 * Sampler range -1..+1: negative = trench (bias the vertex colour toward
 * `snowShade`), positive = spoil edge (bias toward `snowLit`), 0 = untracked.
 * It returns exactly 0 outside the groomed band, so a caller may early-out.
 *
 * @param slope a generated (or synthetic) slope; only `seed`, `finishZ` and
 *              `kickers` are read, and none of them are mutated.
 */
export function buildTrackMask(slope: SlopeDef): (x: number, z: number) => number {
  const next = rng(slope.seed ^ GROOM_PHASE_SALT);
  // FIRST DRAW — bit-identical to terrain.ts:209's corrPhase, by construction.
  // Every track phase is measured from it, so the people-tracks and the
  // machine-corduroy are locked to the same mountain-stable phase (§12.3b).
  const corrPhase = rngRange(next, 0, TAU);
  const bandHalf = GROOM_BAND_HALF_M;
  const bandKnee = bandHalf * 0.85; // matches terrain.ts:193's soft band shoulder
  const bandFade = bandHalf * 0.15;
  const zMax = slope.finishZ + TRACK_Z_OVERRUN;

  const count = rngInt(next, TRACK_COUNT_MIN, TRACK_COUNT_MAX);
  const tracks: CarveTrack[] = [];
  for (let i = 0; i < count; i++) {
    const wl = rngRange(next, TRACK_WL_MIN, TRACK_WL_MAX);
    const k = TAU / wl;
    const ampMax = (TRACK_SLOPE_MAX * wl) / TAU; // keep |dx/dz| <= TRACK_SLOPE_MAX
    const amp = rngRange(next, TRACK_AMP_FRAC_MIN * ampMax, ampMax);
    const half = rngRange(next, TRACK_WIDTH_MIN, TRACK_WIDTH_MAX) / 2;
    const outer = half + TRACK_SPOIL_M;
    // The whole swing, trench and spoil included, stays inside the band: a
    // carve track that spilled onto the powder would contradict §12.3b.
    const offLimit = Math.max(0, bandHalf - TRACK_BAND_MARGIN - amp - outer);
    const offset = rngRange(next, -offLimit, offLimit);
    const phase = corrPhase + rngRange(next, 0, TAU);
    const z0 = rngRange(next, TRACK_Z0_MIN, TRACK_Z0_MAX);
    const z1 = Math.min(zMax, z0 + rngRange(next, TRACK_LEN_MIN, TRACK_LEN_MAX));
    const jumps = next() < TRACK_JUMP_PCT;
    const gaps: number[] = [];
    if (jumps) {
      for (const kicker of slope.kickers) {
        if (kicker.z < z0 || kicker.z > z1) continue;
        const tx = offset + amp * Math.sin(k * kicker.z + phase);
        if (Math.abs(tx - kicker.x) > KICKER_TRACK_X) continue;
        const g0 = kicker.z - KICKER_LIP_LEAD;
        gaps.push(g0, g0 + rngRange(next, KICKER_GAP_MIN, KICKER_GAP_MAX));
      }
    }
    tracks.push({
      amp,
      k,
      phase,
      offset,
      half,
      outer,
      z0,
      z1,
      gaps: Object.freeze(gaps),
    });
  }
  const baked: readonly CarveTrack[] = Object.freeze(tracks);

  return (x: number, z: number): number => {
    // Band gate first — the cheap rejection for the ~82% of terrain vertices
    // that sit off the groomed band (the mesh spans x = +/-(28 + 28 m skirt) =
    // 112 m; the band is 20.16 m of it), and it uses exactly the shoulder
    // profile terrain.ts:193 fades the corduroy with, so tracks and corduroy
    // die out together instead of one outliving the other.
    const bandT = 1 - smoothStep01((Math.abs(x) - bandKnee) / bandFade);
    if (bandT <= 0) return 0;

    let trench = 0; // deepest trench touching (x, z), 0..1
    let spoil = 0; // strongest spoil edge touching (x, z), 0..1
    for (let i = 0; i < baked.length; i++) {
      const t = baked[i]!;
      if (z <= t.z0 || z >= t.z1) continue;

      // Longitudinal weight: fade in at z0, out at z1, and drop to zero across
      // any airborne gap (a track that ran off a kicker lip).
      let w = smoothStep01((z - t.z0) / TRACK_FADE_M);
      const wOut = smoothStep01((t.z1 - z) / TRACK_FADE_M);
      if (wOut < w) w = wOut;
      for (let j = 0; j < t.gaps.length; j += 2) {
        const din = Math.min(z - t.gaps[j]!, t.gaps[j + 1]! - z);
        if (din > 0) w *= 1 - smoothStep01(din / KICKER_GAP_EDGE);
      }
      if (w <= 0) continue;

      const sw = Math.sin(t.k * z + t.phase);
      const d = x - (t.offset + t.amp * sw);
      const ad = d < 0 ? -d : d;
      if (ad >= t.outer) continue;

      if (ad <= t.half) {
        // Trench: flat-bottomed core, smooth walls out to `half`.
        const g = w * (1 - smoothStep01((ad - t.half * 0.5) / (t.half * 0.5)));
        if (g > trench) trench = g;
      } else {
        // Spoil sits on the OUTSIDE of the turn — the side away from the centre
        // of curvature. x''(z) = -amp*k^2*sin, so outward = sign(amp*sin) =
        // sign(sw). It also scales with |sw|, which is zero at the inflection
        // where the ski is flat and throws no snow, and maximal at the apex.
        if (d * sw <= 0) continue;
        // Cross-section is a BUMP, not a step: 4u(1-u) is zero at the trench
        // wall (u=0) and zero at the outer lip (u=1), so the profile is
        // continuous across `half` where the trench has already reached 0. An
        // earlier draft ramped DOWN from u=0 and put a full-height cliff at
        // ad == half — a 1.5-unit discontinuity across 5 cm of piste.
        const u = (ad - t.half) / TRACK_SPOIL_M;
        const g = w * (sw < 0 ? -sw : sw) * TRACK_SPOIL_PEAK * 4 * u * (1 - u);
        if (g > spoil) spoil = g;
      }
    }

    if (trench === 0 && spoil === 0) return 0;
    // Trenches and spoil cancel where tracks cross: a later ski cutting through
    // an older spoil edge packs it back down. Both terms are maxima (never
    // sums), so the result is already inside -1..+1; the clamp is belt-and-
    // braces for callers who read the doc comment as a hard guarantee.
    const v = (spoil - trench) * bandT;
    return v < -1 ? -1 : v > 1 ? 1 : v;
  };
}
