// ============================================================================
// slope.ts unit tests (task P2, CONTRACT §7). vitest, plain describe/it, no
// mocks, fully deterministic (all randomness flows from genSlope's seed).
// Covers: determinism, the GRADE_MIN grade floor (analytic fall-line bound +
// clamp behaviour), density ramp vs config, zero plants in both clear zones,
// the connected-corridor guarantee (generated slopes + synthetic bad defs),
// slalom gates (count/placement/corridor alignment + validator rejections),
// plantGrid band membership + the k-1/k/k+1 query pattern, height-field
// continuity/finiteness. The stepSki full-lock integration suite (physics,
// not visual) lives in sim.test.ts per CONTRACT_V3 §12.2 — moved out of this
// file pre-fan-out so an air-lock regression cannot land in W1's visual gate.
// ============================================================================

import { describe, expect, it } from 'vitest';
import {
  CORRIDOR_MAX_SHIFT_M,
  FINISH_CLEAR,
  FINISH_Z,
  GATE_FIRST_Z,
  GATE_HALF_WIDTH,
  GATE_SPACING_M,
  GRADE_BASE,
  GRADE_MIN,
  KICKER_COUNT,
  KICKER_HALF_WIDTH,
  KICKER_PLANT_CLEAR,
  PLANT_BAND_M,
  PLANT_CLUSTER_PCT,
  PLANT_DENSITY_FULL,
  PLANT_DENSITY_RAMP,
  PLANT_DENSITY_START,
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
import {
  GROOM_BAND_HALF_M,
  GROOM_PHASE_SALT,
  bandFreeIntervals,
  buildTrackMask,
  genSlope,
  validateSlope,
} from './slope.js';
import type { Gate, Plant, SlopeDef } from './types.js';

// The shared tsconfig is lib-pure (no DOM, no node types) but vitest provides
// console at runtime; declare the one method these tests log measurements with.
declare const console: { log(...args: unknown[]): void };

const TAU = Math.PI * 2;
const HALF_W = SLOPE_WIDTH / 2;
const ZONE_Z0 = START_CLEAR;
const ZONE_Z1 = FINISH_Z - FINISH_CLEAR;
const ZONE_LEN = ZONE_Z1 - ZONE_Z0;
const RAMP_LEN = PLANT_DENSITY_RAMP * ZONE_LEN;
const BAND_COUNT = Math.ceil(FINISH_Z / PLANT_BAND_M);
const SEEDS = Array.from({ length: 20 }, (_, i) => i + 1);
const EXPECTED_GATES = Math.floor((FINISH_Z - FINISH_CLEAR - GATE_FIRST_Z) / GATE_SPACING_M);

/** A validator-clean gate set for synthetic defs (exact count, on-piste). */
function validGates(): Gate[] {
  return Array.from({ length: EXPECTED_GATES }, (_, i) => ({
    x: 0,
    z: GATE_FIRST_Z + i * GATE_SPACING_M,
    halfWidth: GATE_HALF_WIDTH,
  }));
}

/** Synthetic SlopeDef for validator tests: flat analytic grade, given plants. */
function syntheticDef(plants: Plant[], gates: Gate[] = validGates()): SlopeDef {
  const grid = new Map<number, Plant[]>();
  for (const p of plants) {
    const k = Math.floor(p.z / PLANT_BAND_M);
    const bucket = grid.get(k);
    if (bucket) bucket.push(p);
    else grid.set(k, [p]);
  }
  return {
    seed: -1,
    length: SLOPE_LENGTH,
    width: SLOPE_WIDTH,
    finishZ: FINISH_Z,
    plants,
    gates,
    kickers: [],
    height: (_x, z) => -GRADE_BASE * z,
    gradeAt: () => GRADE_BASE,
    plantGrid: (k) => grid.get(k) ?? [],
  };
}

/** Plants covering `cover` x-ranges at altitude z, leaving the gaps free. */
function coverPlants(z: number, cover: Array<[number, number]>): Plant[] {
  const out: Plant[] = [];
  for (const [a, b] of cover) {
    // Thorn (r=0.9) every 4 m: coverage radius r + CORRIDOR_HALF = 2.4 > 2.
    for (let x = a; x <= b + 1e-9; x += 4) {
      out.push({ x, z, r: 0.9, kind: 'thorn' });
    }
  }
  return out;
}

describe('determinism', () => {
  it('same seed regenerates identical plants and identical terrain', () => {
    const a = genSlope(42);
    const b = genSlope(42);
    expect(JSON.stringify(a.plants)).toBe(JSON.stringify(b.plants));
    for (let i = 0; i <= 50; i++) {
      const x = -HALF_W + (SLOPE_WIDTH * i) / 50;
      const z = (FINISH_Z * i) / 50;
      expect(a.height(x, z)).toBe(b.height(x, z));
      expect(a.gradeAt(x, z, 0.4)).toBe(b.gradeAt(x, z, 0.4));
    }
    // plantGrid returns the same arrays (band index is part of the def).
    for (let k = 0; k < BAND_COUNT; k++) {
      expect(JSON.stringify(a.plantGrid(k))).toBe(JSON.stringify(b.plantGrid(k)));
    }
  });

  it('different seeds produce different slopes', () => {
    const a = genSlope(1);
    const b = genSlope(2);
    expect(JSON.stringify(a.plants)).not.toBe(JSON.stringify(b.plants));
    expect(a.height(3, 100)).not.toBe(b.height(3, 100));
  });
});

describe('grade floor', () => {
  it('gradeAt >= GRADE_MIN on a 50x200 grid, 20 seeds, fall-line heading', () => {
    // RE-DERIVED for CONTRACT_V3 §12.2a's raised amplitudes (UND_LONG_1_AMP
    // 2.0->5.2, UND_LONG_2_AMP 1.0->0.4). The analytic bound (config.ts) is
    // fall-line grade >= GRADE_BASE - (A1*TAU/L1 + A2*TAU/L2)
    //   = 0.26 - (0.148512 + 0.022848) = 0.088640
    // (it was 0.0958 against the old constants). Still strictly above
    // GRADE_MIN 0.08, so the clamp must STILL never fire at heading 0 — if it
    // does, the undulation implementation is wrong, not the config. The margin
    // is now 0.0086, not 0.0158: this gate is the thing that would catch a
    // future amplitude bump breaking §12.2a's <= 0.171 gradient budget.
    let trueMin = Infinity;
    for (const seed of SEEDS) {
      const s = genSlope(seed);
      for (let xi = 0; xi <= 50; xi++) {
        const x = -HALF_W + (SLOPE_WIDTH * xi) / 50;
        for (let zi = 0; zi <= 200; zi++) {
          const z = (FINISH_Z * zi) / 200;
          const g = s.gradeAt(x, z, 0);
          if (g < trueMin) trueMin = g;
          expect(g).toBeGreaterThanOrEqual(GRADE_MIN);
        }
      }
    }
    // RE-DERIVED (§12.2a): measured across 20 seeds x 10k samples, trueMin now
    // sits at 0.08906 (was ~0.096), i.e. 0.0004 above the analytic floor of
    // 0.08864 — the sampled grid all but reaches the worst case. The assertion
    // bound GRADE_MIN + 0.005 = 0.085 is UNCHANGED and is still guaranteed by
    // construction, not by sampling luck: the analytic floor 0.08864 > 0.085.
    console.log(`[slope] min fall-line grade over 20 seeds: ${trueMin.toFixed(5)}`);
    expect(trueMin).toBeGreaterThan(GRADE_MIN + 0.005);
  });

  it('gradeAt >= GRADE_MIN across the whole reachable yaw range; clamp fires only near traverse', () => {
    const headings = [-YAW_MAX, -1.2, -0.9, -0.6, -0.3, 0.3, 0.6, 0.9, 1.2, YAW_MAX];
    const hitsByHeading = new Map<number, number>();
    let total = 0;
    let nearTotal = 0; // |heading| <= 0.3: shallow carve
    let nearHits = 0;
    let coneTotal = 0; // |heading| <= 0.6: the practical carve cone
    let coneHits = 0;
    for (const seed of SEEDS) {
      const s = genSlope(seed);
      for (let xi = 0; xi <= 20; xi++) {
        const x = -HALF_W + (SLOPE_WIDTH * xi) / 20;
        for (let zi = 0; zi <= 80; zi++) {
          const z = (FINISH_Z * zi) / 80;
          for (const h of headings) {
            const g = s.gradeAt(x, z, h);
            expect(g).toBeGreaterThanOrEqual(GRADE_MIN);
            total++;
            if (g === GRADE_MIN) hitsByHeading.set(h, (hitsByHeading.get(h) ?? 0) + 1);
            if (Math.abs(h) <= 0.3) {
              nearTotal++;
              if (g === GRADE_MIN) nearHits++;
            }
            if (Math.abs(h) <= 0.6) {
              coneTotal++;
              if (g === GRADE_MIN) coneHits++;
            }
          }
        }
      }
    }
    const samplesPerHeading = total / headings.length;
    const perHeading = headings
      .map((h) => `${h.toFixed(2)}:${((100 * (hitsByHeading.get(h) ?? 0)) / samplesPerHeading).toFixed(2)}%`)
      .join(' ');
    console.log(
      `[slope] clamp-hit rate per heading: ${perHeading} | ` +
        `|h|<=0.3: ${((100 * nearHits) / nearTotal).toFixed(3)}%, ` +
        `|h|<=0.6: ${((100 * coneHits) / coneTotal).toFixed(3)}%`,
    );
    // RE-DERIVED for CONTRACT_V3 §12.2a. Undulation correctness is proven at
    // the fall line (previous test: true min 0.08906, clamp NEVER fires). Off
    // the fall line the clamp engaging is geometry, not a bug — and §12.2a's
    // re-allocation moves BOTH terms of that geometry the wrong way at once:
    //
    //   worst-case along-grade(h) = (GRADE_BASE - longGrad)*cos(h)
    //                               - latGrad*|sin(h)|
    //   longGrad: 0.1142 -> 0.171360   => fall-line headroom over GRADE_MIN
    //                                     collapses 0.0158 -> 0.0086
    //   latGrad (UND_LAT_AMP 1.5->2.5): 0.06732 -> 0.11220 (x1.67)
    //
    // So a heading only 0.3 rad off the fall line can now be pulled to
    // 0.08864*cos(0.3) - 0.11220*sin(0.3) = 0.0515, well under GRADE_MIN, where
    // before it could not reach it at all. The old budgets (<1% / <5%) were
    // tuned to the old constants and are dead. Measured on the same fixed 20
    // seeds x 21x81 grid: |h|<=0.3 -> 2.9644%, |h|<=0.6 -> 6.7409%. Budgets set
    // ~18% above measurement — tight enough that a further amplitude bump trips
    // them, loose enough to survive a re-tune inside the frozen budget.
    // This is not a weakened assertion: it is the same invariant recomputed
    // against the constants §12.2a froze (the clamp is the contract's safety
    // net for near-traverse headings; only the traverse cone got wider).
    expect(nearHits / nearTotal).toBeLessThan(0.035);
    expect(coneHits / coneTotal).toBeLessThan(0.08);
  });
});

describe('plant density', () => {
  it('ramp zone and full zone match config densities (+/-25%), clear zones empty', () => {
    // Cluster members near the lateral/edge bounds are dropped (Poisson-
    // honest), so the measured density lands a couple of percent UNDER the
    // configured rho — the corridor repair only moves plants laterally.
    let rampCount = 0;
    let fullCount = 0;
    let totalPlants = 0;
    for (const seed of SEEDS) {
      const s = genSlope(seed);
      totalPlants += s.plants.length;
      for (const p of s.plants) {
        expect(p.z).toBeGreaterThanOrEqual(ZONE_Z0);
        expect(p.z).toBeLessThanOrEqual(ZONE_Z1);
        const rel = p.z - ZONE_Z0;
        if (rel <= RAMP_LEN) rampCount++;
        else fullCount++;
      }
    }
    const rampArea = RAMP_LEN * (HALF_W - 1) * 2 * SEEDS.length;
    const fullArea = (ZONE_LEN - RAMP_LEN) * (HALF_W - 1) * 2 * SEEDS.length;
    const rampExpected = (PLANT_DENSITY_START + PLANT_DENSITY_FULL) / 2; // linear ramp mean
    const rampMeasured = rampCount / rampArea;
    const fullMeasured = fullCount / fullArea;
    console.log(
      `[slope] density: ramp ${rampMeasured.toFixed(5)} vs expected ${rampExpected.toFixed(5)}, ` +
        `full ${fullMeasured.toFixed(5)} vs ${PLANT_DENSITY_FULL.toFixed(5)}, ` +
        `mean total plants ${(totalPlants / SEEDS.length).toFixed(1)} ` +
        `(cluster share target ${PLANT_CLUSTER_PCT})`,
    );
    expect(rampMeasured).toBeGreaterThan(rampExpected * 0.75);
    expect(rampMeasured).toBeLessThan(rampExpected * 1.25);
    expect(fullMeasured).toBeGreaterThan(PLANT_DENSITY_FULL * 0.75);
    expect(fullMeasured).toBeLessThan(PLANT_DENSITY_FULL * 1.25);
    // STYLE_BIBLE: ~150 in-piste plants over the run — keep a loose sanity band.
    expect(totalPlants / SEEDS.length).toBeGreaterThan(100);
    expect(totalPlants / SEEDS.length).toBeLessThan(220);
  });
});

describe('corridor (validateSlope)', () => {
  it('generated slopes pass all validators on 20 seeds', () => {
    for (const seed of SEEDS) {
      expect(validateSlope(genSlope(seed)), `seed ${seed}`).toEqual([]);
    }
  });

  it('a plant wall across the full width is a corridor violation', () => {
    const wall: Plant[] = [];
    for (let x = -HALF_W + 1; x <= HALF_W - 1 + 1e-9; x += 1.5) {
      wall.push({ x, z: 400, r: 0.9, kind: 'thorn' });
    }
    const violations = validateSlope(syntheticDef(wall));
    expect(violations.some((v) => v.includes('corridor'))).toBe(true);
  });

  it('a disconnected corridor (gap >> CORRIDOR_MAX_SHIFT_M) is a violation', () => {
    // Band 10 (z 100-110): free window only around x=-20.
    // Band 13 (z 130-140): free window only around x=+20.
    // 40 m over 3 bands >> CORRIDOR_MAX_SHIFT_M per band — the sweep/DP must
    // catch the disconnect even though every band individually has free space.
    const plants = [
      ...coverPlants(105, [
        [-HALF_W + 1, -23],
        [-17, HALF_W - 1],
      ]),
      ...coverPlants(135, [
        [-HALF_W + 1, 17],
        [23, HALF_W - 1],
      ]),
    ];
    const violations = validateSlope(syntheticDef(plants));
    expect(violations.some((v) => v.includes('corridor'))).toBe(true);
    void CORRIDOR_MAX_SHIFT_M; // the invariant under test, kept visible
  });
});

describe('slalom gates', () => {
  it('generated slopes place ~14 gates: ascending z, on-piste, clear zones free', () => {
    for (const seed of SEEDS) {
      const s = genSlope(seed);
      expect(
        Math.abs(s.gates.length - EXPECTED_GATES),
        `seed ${seed} gate count ${s.gates.length}`,
      ).toBeLessThanOrEqual(2);
      let prevZ = -Infinity;
      for (const g of s.gates) {
        expect(g.z, `seed ${seed}`).toBeGreaterThan(prevZ); // strictly ascending
        prevZ = g.z;
        expect(g.z).toBeGreaterThanOrEqual(GATE_FIRST_Z);
        expect(g.z).toBeGreaterThanOrEqual(START_CLEAR); // never in the start clear zone
        expect(g.z).toBeLessThanOrEqual(FINISH_Z - FINISH_CLEAR); // nor the finish sprint
        expect(g.halfWidth).toBe(GATE_HALF_WIDTH);
        expect(g.x - g.halfWidth).toBeGreaterThanOrEqual(-HALF_W); // opening on-piste
        expect(g.x + g.halfWidth).toBeLessThanOrEqual(HALF_W);
      }
    }
  });

  it('gates are deterministic per seed (and differ across seeds)', () => {
    expect(JSON.stringify(genSlope(7).gates)).toBe(JSON.stringify(genSlope(7).gates));
    expect(JSON.stringify(genSlope(7).gates)).not.toBe(JSON.stringify(genSlope(8).gates));
  });

  it('every gate sits inside the corridor free interval at its band', () => {
    // The same free-interval machinery validateSlope sweeps: a gate whose x
    // has no PLANT_CORRIDOR_M-wide plant-free tube at its band could not be
    // threaded by a corridor-following skier.
    for (const seed of SEEDS) {
      const s = genSlope(seed);
      for (const g of s.gates) {
        const band = Math.floor(g.z / PLANT_BAND_M);
        const free = bandFreeIntervals(s, band, HALF_W);
        const inside = free.some((iv) => g.x >= iv.lo - 1e-9 && g.x <= iv.hi + 1e-9);
        expect(
          inside,
          `seed ${seed} gate z=${g.z.toFixed(1)} x=${g.x.toFixed(2)} outside ` +
            `free intervals ${JSON.stringify(free)}`,
        ).toBe(true);
      }
    }
  });

  it('validator rejects descending, off-piste, clear-zone, and miscounted gates', () => {
    const descending = validGates();
    descending[3] = { ...descending[3]!, z: descending[1]!.z }; // duplicate z: not ascending
    expect(
      validateSlope(syntheticDef([], descending)).some((v) => v.includes('ascending')),
    ).toBe(true);

    const offPiste = validGates();
    offPiste[0] = { ...offPiste[0]!, x: HALF_W }; // opening edge past the piste
    expect(
      validateSlope(syntheticDef([], offPiste)).some((v) => v.includes('off-piste')),
    ).toBe(true);

    const inStartClear = validGates();
    inStartClear[0] = { ...inStartClear[0]!, z: START_CLEAR - 1 };
    expect(
      validateSlope(syntheticDef([], inStartClear)).some((v) => v.includes('START_CLEAR')),
    ).toBe(true);

    const inFinishClear = validGates();
    inFinishClear[EXPECTED_GATES - 1] = {
      ...inFinishClear[EXPECTED_GATES - 1]!,
      z: FINISH_Z - FINISH_CLEAR + 1,
    };
    expect(
      validateSlope(syntheticDef([], inFinishClear)).some((v) => v.includes('FINISH_CLEAR')),
    ).toBe(true);

    expect(
      validateSlope(syntheticDef([], validGates().slice(0, 4))).some((v) =>
        v.includes('gate count'),
      ),
    ).toBe(true);

    // ...and the untouched valid set is genuinely clean.
    expect(validateSlope(syntheticDef([]))).toEqual([]);
  });
});

describe('plantGrid', () => {
  it('band membership is exact for every band', () => {
    const s = genSlope(7);
    for (let k = 0; k < BAND_COUNT; k++) {
      const expected = s.plants.filter((p) => Math.floor(p.z / PLANT_BAND_M) === k);
      const got = s.plantGrid(k);
      expect(got.length, `band ${k} size`).toBe(expected.length);
      expect(new Set(got)).toEqual(new Set(expected));
      for (const p of got) expect(Math.floor(p.z / PLANT_BAND_M)).toBe(k);
    }
  });

  it('the k-1/k/k+1 query pattern returns every plant in the z window', () => {
    const s = genSlope(11);
    for (const k of [0, 5, 23, 40, BAND_COUNT - 1]) {
      const windowPlants = s.plants.filter(
        (p) => p.z >= (k - 1) * PLANT_BAND_M && p.z < (k + 2) * PLANT_BAND_M,
      );
      const got = new Set([...s.plantGrid(k - 1), ...s.plantGrid(k), ...s.plantGrid(k + 1)]);
      for (const p of windowPlants) expect(got.has(p)).toBe(true);
    }
  });

  it('a plant near a band boundary is found by the k-1/k/k+1 pattern from both sides', () => {
    // Deterministic search: some seed within 1..60 always has a plant within
    // 0.25 m of a band boundary (735 planted metres per slope, 10 m bands).
    let found: { s: SlopeDef; p: Plant } | null = null;
    for (let seed = 1; seed <= 60 && !found; seed++) {
      const s = genSlope(seed);
      for (const p of s.plants) {
        const frac = p.z / PLANT_BAND_M - Math.floor(p.z / PLANT_BAND_M);
        if (frac < 0.025 || frac > 0.975) {
          found = { s, p };
          break;
        }
      }
    }
    expect(found, 'expected a boundary plant within 60 seeds').not.toBeNull();
    const { s, p } = found as { s: SlopeDef; p: Plant };
    const k = Math.floor(p.z / PLANT_BAND_M);
    expect(s.plantGrid(k)).toContain(p);
    expect(s.plantGrid(k - 1)).not.toContain(p);
    expect(s.plantGrid(k + 1)).not.toContain(p);
    const above = new Set([...s.plantGrid(k), ...s.plantGrid(k + 1), ...s.plantGrid(k + 2)]);
    const below = new Set([...s.plantGrid(k - 2), ...s.plantGrid(k - 1), ...s.plantGrid(k)]);
    expect(above.has(p)).toBe(true);
    expect(below.has(p)).toBe(true);
  });
});

describe('height field', () => {
  it('is finite and continuous (Lipschitz) over the whole piste', () => {
    const maxDz =
      GRADE_BASE +
      (UND_LONG_1_AMP * TAU) / UND_LONG_1_LEN +
      (UND_LONG_2_AMP * TAU) / UND_LONG_2_LEN;
    const maxDx = (UND_LAT_AMP * TAU) / UND_LAT_LEN;
    const step = 0.5;
    for (const seed of [1, 2, 3]) {
      const s = genSlope(seed);
      for (let xi = 0; xi <= 28; xi++) {
        const x = -HALF_W + (SLOPE_WIDTH * xi) / 28;
        for (let zi = 0; zi <= 40; zi++) {
          const z = (FINISH_Z * zi) / 40;
          const h = s.height(x, z);
          expect(Number.isFinite(h)).toBe(true);
          expect(Math.abs(s.height(x + step, z) - h)).toBeLessThanOrEqual(maxDx * step + 1e-9);
          expect(Math.abs(s.height(x, z + step) - h)).toBeLessThanOrEqual(maxDz * step + 1e-9);
        }
      }
      // The summit is a pleasant positive rise; the mountain falls toward +z.
      expect(s.height(0, 0)).toBeGreaterThan(0);
      expect(s.height(0, FINISH_Z)).toBeLessThan(s.height(0, 0));
    }
  });
});

// ---------------------------------------------------------------------------
// Kicker placement tests (v2 §11.3)
// ---------------------------------------------------------------------------
describe('kicker placement (v2)', () => {
  it('kickers are deterministic per seed', () => {
    expect(JSON.stringify(genSlope(7).kickers)).toBe(JSON.stringify(genSlope(7).kickers));
    expect(JSON.stringify(genSlope(7).kickers)).not.toBe(JSON.stringify(genSlope(8).kickers));
  });

  it('kicker count is KICKER_COUNT on every seed', () => {
    for (const seed of SEEDS) {
      expect(genSlope(seed).kickers.length, `seed ${seed}`).toBe(KICKER_COUNT);
    }
  });

  it('kickers are strictly ascending and clear of both clear zones', () => {
    for (const seed of SEEDS) {
      const s = genSlope(seed);
      let prevZ = -Infinity;
      for (const k of s.kickers) {
        expect(k.z, `seed ${seed}`).toBeGreaterThan(prevZ);
        prevZ = k.z;
        expect(k.z).toBeGreaterThanOrEqual(START_CLEAR);
        expect(k.z).toBeLessThanOrEqual(FINISH_Z - FINISH_CLEAR);
      }
    }
  });

  it('every kicker is on-piste: |x| + halfWidth <= width/2 - 1', () => {
    for (const seed of SEEDS) {
      const s = genSlope(seed);
      for (const k of s.kickers) {
        expect(
          Math.abs(k.x) + k.halfWidth,
          `seed ${seed} kicker z=${k.z.toFixed(1)}`,
        ).toBeLessThanOrEqual(HALF_W - 1 + 1e-9);
        expect(k.halfWidth).toBe(KICKER_HALF_WIDTH);
      }
    }
  });

  it('every kicker sits inside a KICKER_PLANT_CLEAR-based free interval at its band', () => {
    // Kickers are placed using KICKER_PLANT_CLEAR exclusion, not CORRIDOR_HALF.
    // Replicate the same clearance check the generator uses.
    for (const seed of SEEDS) {
      const s = genSlope(seed);
      for (const k of s.kickers) {
        const band = Math.floor(k.z / PLANT_BAND_M);
        // Build free intervals with the same KICKER_PLANT_CLEAR exclusion the
        // generator uses (subtractInterval is not exported, so verify by
        // checking no plant in bands k-1..k+1 is within KICKER_PLANT_CLEAR).
        let tooClose = false;
        const pc2 = KICKER_PLANT_CLEAR * KICKER_PLANT_CLEAR;
        for (let j = band - 1; j <= band + 1 && !tooClose; j++) {
          for (const p of s.plantGrid(j)) {
            const dx = k.x - p.x;
            const dz = k.z - p.z;
            if (dx * dx + dz * dz < pc2 - 1e-9) {
              tooClose = true;
              break;
            }
          }
        }
        expect(
          tooClose,
          `seed ${seed} kicker z=${k.z.toFixed(1)} x=${k.x.toFixed(2)} ` +
            `too close to a plant in bands ${band - 1}..${band + 1}`,
        ).toBe(false);
      }
    }
  });

  it('no plant is within KICKER_PLANT_CLEAR of any kicker', () => {
    const pc2 = KICKER_PLANT_CLEAR * KICKER_PLANT_CLEAR;
    for (const seed of SEEDS) {
      const s = genSlope(seed);
      for (const k of s.kickers) {
        for (const p of s.plants) {
          const dx = k.x - p.x;
          const dz = k.z - p.z;
          const d2 = dx * dx + dz * dz;
          expect(
            d2,
            `seed ${seed} kicker z=${k.z.toFixed(1)} x=${k.x.toFixed(2)} ` +
              `too close to plant z=${p.z.toFixed(1)} x=${p.x.toFixed(2)} ` +
              `(dist ${Math.sqrt(d2).toFixed(2)} < ${KICKER_PLANT_CLEAR})`,
          ).toBeGreaterThanOrEqual(pc2 - 1e-9);
        }
      }
    }
  });

  it('generated slopes pass all validators on 20 seeds (kickers present)', () => {
    for (const seed of SEEDS) {
      const v = validateSlope(genSlope(seed));
      expect(v, `seed ${seed}: ${v.join('; ')}`).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// Carve tracks — task W1, CONTRACT_V3 §12.3a/§12.3c, STYLE_BIBLE §V3.8
//
// buildTrackMask is purely visual, so the tests that matter most are not about
// how it looks — they are the two ways it can silently wreck the game:
//   (1) drawing from genSlope's RNG stream, which relocates every plant, gate
//       and kicker on the mountain (§12.3c);
//   (2) constructing its generator per call, which turns terrain's 33k-vertex
//       loop into 33k generator builds (§12.3a — the reason the seam is a
//       two-stage builder and not a bare trackMask(slope, x, z)).
// Both have explicit gates below, alongside the §V3.8 shape assertions.
// ---------------------------------------------------------------------------
const TRACK_SEEDS = SEEDS;
/** Terrain's vertex loop size (terrain.ts SEG_X+1 x SEG_Z+1) — the real load. */
const TERRAIN_VERTS = 129 * 257;

/** Strongest |mask| anywhere within `halfSpan` m of x=cx at altitude z. */
function peakNear(
  mask: (x: number, z: number) => number,
  z: number,
  cx: number,
  halfSpan: number,
): number {
  let best = 0;
  const steps = Math.round(halfSpan / 0.1);
  for (let i = -steps; i <= steps; i++) {
    const v = Math.abs(mask(cx + i * 0.1, z));
    if (v > best) best = v;
  }
  return best;
}

describe('carve tracks (buildTrackMask, §V3.8)', () => {
  it('exports the groom seam constants CONTRACT_V3 §12.3a froze for W2', () => {
    // W2 imports these and deletes terrain.ts's local literals. They live in
    // shared/ because the tracks must sit on exactly the band the terrain
    // already draws, and shared/ cannot import from client/.
    expect(GROOM_PHASE_SALT).toBe(0xc0a1); // was terrain.ts:209's inline literal
    expect(GROOM_BAND_HALF_M).toBe(10.08); // was GROOM_BAND_FRAC 0.18 x width 56
    expect(GROOM_BAND_HALF_M).toBeCloseTo(SLOPE_WIDTH * 0.18, 9);
    // The band is a strict subset of the piste — never a reason to paint powder.
    expect(GROOM_BAND_HALF_M).toBeLessThan(HALF_W);
  });

  it('§12.3c: builds on its OWN stream — genSlope geometry is untouched', () => {
    // The whole point of §12.3c. If buildTrackMask ever consumed genSlope's
    // sequential stream (or genSlope gained/lost/reordered a draw to feed it),
    // every plant, gate and kicker would move and room.test.ts:590/613/650 plus
    // e2e 9b/10/11a would break for reasons no one would connect to a visual
    // task. Interleaving builds between generations must change nothing.
    const before = genSlope(42);
    const beforeJson = JSON.stringify({
      plants: before.plants,
      gates: before.gates,
      kickers: before.kickers,
    });
    for (const seed of TRACK_SEEDS) {
      const m = buildTrackMask(genSlope(seed));
      m(0, 100); // and sampling must not disturb anything either
      m(3.5, 401.25);
    }
    const after = genSlope(42);
    expect(
      JSON.stringify({ plants: after.plants, gates: after.gates, kickers: after.kickers }),
    ).toBe(beforeJson);
    // ...and the builder does not mutate the SlopeDef it was handed.
    const s = genSlope(7);
    const snapshot = JSON.stringify({ p: s.plants, g: s.gates, k: s.kickers, w: s.width });
    const mask = buildTrackMask(s);
    for (let i = 0; i < 200; i++) mask((i % 40) - 20, i * 4);
    expect(JSON.stringify({ p: s.plants, g: s.gates, k: s.kickers, w: s.width })).toBe(snapshot);
  });

  it('is deterministic per seed, order-independent, and differs across seeds', () => {
    const sample = (mask: (x: number, z: number) => number): string => {
      const out: number[] = [];
      for (let zi = 0; zi <= 120; zi++) {
        for (let xi = -12; xi <= 12; xi++) out.push(mask(xi * 0.9, zi * 6.5));
      }
      return out.join(',');
    };
    const a = sample(buildTrackMask(genSlope(42)));
    // Build an unrelated mask in between: no module-level state may leak.
    buildTrackMask(genSlope(3));
    const b = sample(buildTrackMask(genSlope(42)));
    expect(b).toBe(a);
    expect(sample(buildTrackMask(genSlope(43)))).not.toBe(a);

    // The sampler is pure: re-reading a point after wandering elsewhere gives
    // the identical value (it may not accumulate per-call state).
    const m = buildTrackMask(genSlope(42));
    const probe = m(2.4, 233.5);
    for (let i = 0; i < 500; i++) m(i * 0.037 - 9, i * 1.6);
    expect(m(2.4, 233.5)).toBe(probe);
  });

  it('§12.3a: the sampler carries no generator — 3x a terrain build stays cheap', () => {
    // A smoke gate, not a benchmark, and the bound is measured rather than
    // guessed. Both shapes were timed over these same 99,459 samples:
    //   baked closure (what §12.3a froze)            ~15 ms
    //   rng + 6-10 curves rebuilt per call (rev 2's  ~391 ms
    //     bare trackMask(slope, x, z) shape)
    // 200 ms sits between them: 13x headroom over the real cost so a loaded
    // runner cannot flake it, and 2x under the regression it exists to catch.
    const mask = buildTrackMask(genSlope(42));
    const t0 = Date.now();
    let acc = 0;
    for (let pass = 0; pass < 3; pass++) {
      for (let i = 0; i < 129; i++) {
        for (let j = 0; j < 257; j++) acc += mask((i - 64) * 0.9, j * 3.5);
      }
    }
    const ms = Date.now() - t0;
    console.log(`[slope] trackMask: ${3 * TERRAIN_VERTS} samples in ${ms} ms`);
    expect(Number.isFinite(acc)).toBe(true);
    expect(ms).toBeLessThan(200);
  });

  it('stays in -1..+1 and is finite everywhere on and off the piste, 20 seeds', () => {
    // Accumulate, then assert once. A per-sample expect() over this grid is
    // ~500k matcher invocations and times the suite out under parallel load —
    // the coverage is identical, the cost is not.
    let lo = Infinity;
    let hi = -Infinity;
    let nonFinite = 0;
    for (const seed of TRACK_SEEDS) {
      const mask = buildTrackMask(genSlope(seed));
      for (let zi = -5; zi <= 105; zi++) {
        const z = zi * 8;
        for (let xi = -56; xi <= 56; xi++) {
          const v = mask(xi * 0.5, z);
          if (!Number.isFinite(v)) nonFinite++;
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
      }
    }
    console.log(`[slope] trackMask range over 20 seeds: ${lo.toFixed(4)} .. ${hi.toFixed(4)}`);
    expect(nonFinite).toBe(0);
    expect(lo).toBeGreaterThanOrEqual(-1);
    expect(hi).toBeLessThanOrEqual(1);
    // Both readings must actually occur: a trench-only mask would lose the
    // §V3.8 spoil edge, a spoil-only one would lose the carve itself.
    expect(lo).toBeLessThan(-0.5); // snowShade trenches exist
    expect(hi).toBeGreaterThan(0.2); // snowLit spoil edges exist
  });

  it('§12.3b: lives on the groomed band only — exactly 0 outside it', () => {
    // The groomed band is x = 0 +/- 10.08 and does NOT follow the plant-free
    // weave. Anything outside is powder and must stay untouched, so W2 can use
    // a zero return as a hard early-out.
    let worst = 0;
    let where = 'none';
    const note = (v: number, seed: number, x: number, z: number): void => {
      const a = v < 0 ? -v : v;
      if (a > worst) {
        worst = a;
        where = `seed ${seed} x=${x.toFixed(2)} z=${z.toFixed(1)} -> ${v}`;
      }
    };
    for (const seed of TRACK_SEEDS) {
      const s = genSlope(seed);
      const mask = buildTrackMask(s);
      for (let zi = -5; zi <= 105; zi++) {
        const z = zi * 8;
        for (let xi = 0; xi <= 40; xi++) {
          const x = GROOM_BAND_HALF_M + (xi * (HALF_W + 12 - GROOM_BAND_HALF_M)) / 40;
          note(mask(x, z), seed, x, z);
          note(mask(-x, z), seed, -x, z);
        }
      }
      // ...and nothing exists far above the start gate or past the runout.
      for (let xi = -20; xi <= 20; xi++) {
        note(mask(xi * 0.5, -400), seed, xi * 0.5, -400);
        note(mask(xi * 0.5, s.finishZ + 200), seed, xi * 0.5, s.finishZ + 200);
      }
    }
    expect(worst, `off-band leak: ${where}`).toBe(0);
  });

  it('§V3.8: trenches are 1.6-2.2 m wide and never smear into a blanket', () => {
    // Widened post-V3.8 (bugfix): the old 0.5-0.7 m trench (full-strength core
    // 0.25-0.35 m) was narrower than the production mesh's vertex pitch
    // (dx=0.875 m / dz~3.79 m in terrain.ts), so point-sampling it produced
    // isolated single-vertex dots instead of a connected line (480/5911
    // in-band vertices nonzero, ~40% of those fully isolated). >=1.6 m keeps a
    // trench >= ~2x the tighter (x) pitch, so it always covers >=2 adjacent
    // vertex columns.
    // Measured across 5 seeds at 5 cm lateral resolution: p50 1.70 m, p90
    // 3.15 m, 78% of contiguous trench runs <= 2.5 m. Runs longer than that
    // are genuine crossings (two tracks overlapping), which §V3.8 asks for —
    // but if the bulk of the piste became one wide trench, the carve read is
    // gone and this gate catches it.
    const runs: number[] = [];
    for (const seed of [1, 5, 9, 13, 17]) {
      const mask = buildTrackMask(genSlope(seed));
      for (let zi = 0; zi <= 200; zi++) {
        const z = zi * 4;
        let run = 0;
        for (let xi = -220; xi <= 220; xi++) {
          if (mask(xi * 0.05, z) < -0.15) run += 0.05;
          else {
            if (run > 0) runs.push(run);
            run = 0;
          }
        }
        if (run > 0) runs.push(run);
      }
    }
    runs.sort((a, b) => a - b);
    const p = (q: number): number => runs[Math.min(runs.length - 1, Math.floor(runs.length * q))] ?? 0;
    const narrow = runs.filter((r) => r <= 2.5).length / runs.length;
    console.log(
      `[slope] trackMask trench widths (n=${runs.length}): p50 ${p(0.5).toFixed(2)} m, ` +
        `p90 ${p(0.9).toFixed(2)} m, max ${(runs[runs.length - 1] ?? 0).toFixed(2)} m, ` +
        `${(100 * narrow).toFixed(1)}% <= 2.5 m`,
    );
    expect(runs.length).toBeGreaterThan(1000);
    expect(p(0.5)).toBeGreaterThanOrEqual(1.2);
    expect(p(0.5)).toBeLessThanOrEqual(2.4);
    expect(narrow).toBeGreaterThan(0.7);
    expect(runs[runs.length - 1] ?? 0).toBeLessThan(10);
  });

  it('§V3.8 bugfix: trenches cover >=2 adjacent vertex columns on the real terrain grid (no isolated speckle)', () => {
    // Reproduces the reviewer's production-grid measurement (terrain.ts's
    // SEG_X=128 over x=+/-56, SEG_Z=256 over z=-30..940) and asserts the
    // regression it caught cannot recur: before the width fix, 190/480
    // (~40%) of nonzero in-band vertices had all 4 grid-neighbours exactly
    // zero — isolated dots, not lines.
    const SEG_X = 128;
    const SEG_Z = 256;
    const x0 = -HALF_W - 28;
    const x1 = HALF_W + 28;
    const z0v = -30;
    const z1v = FINISH_Z + 140;
    const mask = buildTrackMask(genSlope(42));
    const nx = SEG_X + 1;
    const nz = SEG_Z + 1;
    const grid: number[][] = [];
    for (let iz = 0; iz < nz; iz++) {
      const z = z0v + ((z1v - z0v) * iz) / SEG_Z;
      const row: number[] = [];
      for (let ix = 0; ix < nx; ix++) {
        row.push(mask(x0 + ((x1 - x0) * ix) / SEG_X, z));
      }
      grid.push(row);
    }
    let inBand = 0;
    let nonzero = 0;
    let isolated = 0;
    for (let iz = 0; iz < nz; iz++) {
      for (let ix = 0; ix < nx; ix++) {
        const x = x0 + ((x1 - x0) * ix) / SEG_X;
        if (Math.abs(x) > GROOM_BAND_HALF_M) continue;
        inBand++;
        const v = grid[iz]?.[ix] ?? 0;
        if (v === 0) continue;
        nonzero++;
        const neighbours = [
          ix > 0 ? grid[iz]?.[ix - 1] : 0,
          ix < nx - 1 ? grid[iz]?.[ix + 1] : 0,
          iz > 0 ? grid[iz - 1]?.[ix] : 0,
          iz < nz - 1 ? grid[iz + 1]?.[ix] : 0,
        ];
        if (neighbours.every((n) => (n ?? 0) === 0)) isolated++;
      }
    }
    console.log(
      `[slope] production-grid track vertices: inBand=${inBand} nonzero=${nonzero} isolated=${isolated}`,
    );
    expect(nonzero).toBeGreaterThan(0);
    expect(isolated).toBe(0);
  });

  it('§V3.8: tracks are S-curves that cover part of the band, not all of it', () => {
    for (const seed of TRACK_SEEDS) {
      const mask = buildTrackMask(genSlope(seed));
      let tracked = 0;
      let total = 0;
      let moved = 0;
      for (let zi = 0; zi <= 200; zi++) {
        const z = zi * 4;
        for (let xi = -55; xi <= 55; xi++) {
          const x = xi * 0.2;
          const v = mask(x, z);
          total++;
          if (v !== 0) tracked++;
          // An S-curve moves laterally with z; a straight rut would not.
          if (Math.abs(mask(x, z + 6) - v) > 0.1) moved++;
        }
      }
      const cov = tracked / total;
      expect(cov, `seed ${seed} coverage`).toBeGreaterThan(0.03); // the piste is skied
      expect(cov, `seed ${seed} coverage`).toBeLessThan(0.3); // ...not resurfaced
      expect(moved / total, `seed ${seed} lateral motion`).toBeGreaterThan(0.05);
    }
  });

  it('§V3.8: a few tracks run off a kicker lip and resume downhill of it', () => {
    // Detect it the way a player would see it: strong tracks arriving at the
    // ramp, nothing on the snow just past the lip.
    let seedsWithGap = 0;
    for (const seed of TRACK_SEEDS) {
      const s = genSlope(seed);
      const mask = buildTrackMask(s);
      for (const k of s.kickers) {
        if (peakNear(mask, k.z - 6, k.x, 6) > 0.4 && peakNear(mask, k.z + 3, k.x, 6) < 0.02) {
          seedsWithGap++;
          break;
        }
      }
    }
    console.log(`[slope] trackMask: ${seedsWithGap}/20 seeds show a kicker-lip gap`);
    // Measured 12/20. "A few" is per-mountain, not per-seed, so the gate is a
    // floor well under the measurement, not a fit to it.
    expect(seedsWithGap).toBeGreaterThanOrEqual(4);
  });

  it('has no cliffs: the field is piecewise smooth at terrain vertex scale', () => {
    // A discontinuity here shows up as a hard-edged seam in the vertex colours.
    // An earlier draft stepped the spoil edge to full height at the trench wall
    // and jumped 1.54 units across 5 cm; the bump profile removed it.
    let maxDx = 0;
    let maxDz = 0;
    for (const seed of [2, 6, 42]) {
      const mask = buildTrackMask(genSlope(seed));
      for (let zi = 0; zi <= 300; zi++) {
        const z = zi * 2.5;
        for (let xi = -210; xi <= 210; xi++) {
          const x = xi * 0.05;
          const v = mask(x, z);
          const dx = Math.abs(mask(x + 0.05, z) - v);
          const dz = Math.abs(mask(x, z + 0.05) - v);
          if (dx > maxDx) maxDx = dx;
          if (dz > maxDz) maxDz = dz;
        }
      }
    }
    console.log(`[slope] trackMask max step over 5 cm: dx ${maxDx.toFixed(3)}, dz ${maxDz.toFixed(3)}`);
    // Measured 0.94 / 0.58. The residual is two overlapping tracks' walls
    // adding, not a discontinuity: a single trench wall spans ~0.6 per 5 cm.
    expect(maxDx).toBeLessThan(1.2);
    expect(maxDz).toBeLessThan(1.2);
  });

  it('works on a kicker-free synthetic slope (the gap logic is optional)', () => {
    const s = syntheticDef([]);
    expect(s.kickers.length).toBe(0);
    const mask = buildTrackMask(s);
    let nonZero = 0;
    let bad = 0;
    for (let zi = 0; zi <= 200; zi++) {
      for (let xi = -100; xi <= 100; xi++) {
        const v = mask(xi * 0.1, zi * 4);
        if (!Number.isFinite(v) || v < -1 || v > 1) bad++;
        if (v !== 0) nonZero++;
      }
    }
    expect(bad).toBe(0);
    expect(nonZero).toBeGreaterThan(0);
  });
});
