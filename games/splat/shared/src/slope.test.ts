// ============================================================================
// slope.ts unit tests (task P2, CONTRACT §7). vitest, plain describe/it, no
// mocks, fully deterministic (all randomness flows from genSlope's seed).
// Covers: determinism, the GRADE_MIN grade floor (analytic fall-line bound +
// clamp behaviour), density ramp vs config, zero plants in both clear zones,
// the connected-corridor guarantee (generated slopes + synthetic bad defs),
// slalom gates (count/placement/corridor alignment + validator rejections),
// plantGrid band membership + the k-1/k/k+1 query pattern, height-field
// continuity/finiteness, and the stepSki full-lock integration suite (guarded:
// skips until P1's sim.ts exists — see the bottom describe).
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
  SIM_DT,
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
import { bandFreeIntervals, genSlope, validateSlope } from './slope.js';
import type { Gate, Plant, SkierSim, SlopeDef } from './types.js';

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
    // The analytic bound (config.ts): fall-line grade >= GRADE_BASE - 0.1142
    // ~ 0.0958, so the GRADE_MIN clamp must NEVER fire at heading 0 — if it
    // does, the undulation implementation is wrong, not the config.
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
    // Measured across 20 seeds x 10k samples: trueMin sits ~0.096, comfortably
    // above GRADE_MIN 0.08 (log kept as the report this gate was tuned against).
    console.log(`[slope] min fall-line grade over 20 seeds: ${trueMin.toFixed(4)}`);
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
    // Undulation correctness is proven at the fall line (previous test: true
    // min 0.0964, clamp NEVER fires). Off the fall line the clamp engaging is
    // geometry, not a bug: a 12-degree slope traversed at 34 degrees yields a
    // baseline grade of 0.21*cos(0.6) = 0.174, which the lateral octave (max
    // 0.067*sin) can legitimately pull under GRADE_MIN ~2.5% of the time, and
    // a near-90-degree traverse is genuinely near-flat ~50% of the time. The
    // clamp is the contract's safety net for exactly those headings. Asserted:
    // rare in the shallow-carve band (<1%), small in the full carve cone (<5%).
    expect(nearHits / nearTotal).toBeLessThan(0.01);
    expect(coneHits / coneTotal).toBeLessThan(0.05);
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

// ----------------------------------------------------------------------------
// Wave-2 integration suite (CONTRACT §7: this suite's home is wave 2). It
// exercises P1's stepSki against P2's generated slopes. sim.ts is P1's file
// and does not exist yet, so the import is dynamic and widened (a literal
// specifier would fail tsc --noEmit while the file is absent); a failed import
// skips the suite gracefully instead of going red during wave 1.
// ----------------------------------------------------------------------------
interface SlopeSimModule {
  makeSim(x: number, z: number, yaw: number): SkierSim;
  stepSki(s: SkierSim, steer: number, dt: number, slope: SlopeDef): void;
}
const SIM_SPECIFIER: string = './sim.js'; // widened on purpose — see above

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

  // Wave-2 integration: a skier steering toward successive kickers crosses
  // every one (lastKickerIx advances through all of them).
  it('a corridor-following skier crosses every kicker', async (ctx) => {
    let sim: SlopeSimModule;
    try {
      sim = (await import(/* @vite-ignore */ SIM_SPECIFIER)) as SlopeSimModule;
    } catch {
      ctx.skip();
      return;
    }
    for (const seed of SEEDS) {
      const slope = genSlope(seed);
      const skier = sim.makeSim(0, 0, 0);
      let nextIx = 0;
      for (let step = 0; step < 6000 && !skier.finished; step++) {
        // Steer toward the next unconsumed kicker to stay on the centreline.
        let steer = 0;
        if (nextIx < slope.kickers.length) {
          const t = slope.kickers[nextIx]!;
          const dx = t.x - skier.x;
          steer = Math.max(-1, Math.min(1, dx * 1.5));
        }
        sim.stepSki(skier, steer, SIM_DT, slope);
        while (nextIx < slope.kickers.length && skier.lastKickerIx >= nextIx) {
          nextIx = skier.lastKickerIx + 1;
        }
      }
      expect(skier.lastKickerIx, `seed ${seed}`).toBe(slope.kickers.length - 1);
      expect(skier.finished, `seed ${seed}`).toBe(true);
    }
  });
});

describe('stepSki full-lock integration (wave 2)', () => {
  it('full-lock both directions reaches the finish on 20 seeds', async (ctx) => {
    let sim: SlopeSimModule;
    try {
      sim = (await import(/* @vite-ignore */ SIM_SPECIFIER)) as SlopeSimModule;
    } catch {
      ctx.skip(); // P1's sim.ts has not landed yet; nothing to integrate.
      return;
    }
    for (const seed of SEEDS) {
      const slope = genSlope(seed);
      for (const steer of [-1, 1]) {
        const skier = sim.makeSim(0, 0, 0);
        // 6000 steps * SIM_DT = 200 s sim time >> RACE_HARD_CAP_MS territory.
        for (let step = 0; step < 6000 && !skier.finished; step++) {
          sim.stepSki(skier, steer, SIM_DT, slope);
        }
        expect(skier.finished, `seed ${seed} steer ${steer}`).toBe(true);
      }
    }
  });
});
