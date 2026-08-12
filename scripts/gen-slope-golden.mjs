#!/usr/bin/env -S npx tsx
// ============================================================================
// gen-slope-golden — freeze a golden digest of games/splat/shared/src/slope.ts
// (genSlope) captured on the current HEAD, BEFORE the ambient-occlusion /
// carve-track vertex-colour refactor (and the terrain-amplitude raise) touch
// slope.ts / config.ts. That work is required to be purely additive on the
// *world*: it must not move a single plant, gate, kicker, or corridor value,
// even though it is explicitly allowed to raise `slope.height` amplitude.
// games/splat/shared/src/slope.test.ts cannot detect a "world moved" style
// regression (plant x is never asserted, plant z only has to fall in a wide
// zone, density is a +/-25% band, gate.halfWidth is asserted against the SAME
// constant the generator uses). This script is the falsifiable evidence base
// for that "additive or it's wrong" claim.
//
// The digest is split in two, per seed, so "terrain got taller" (allowed) and
// "the world moved" (a critical regression) are independently observable:
//
//   rngDigest    — everything drawn from the sequential RNG stream: every
//                  plant (x,z,r,kind), every gate (x,z,halfWidth), every
//                  kicker (x,z,halfWidth), and the plant-derived
//                  bandFreeIntervals corridor sample. MUST NEVER CHANGE.
//   heightDigest — the height lattice plus the top-level scalars (length,
//                  width, finishZ). EXPECTED to change when terrain
//                  amplitude constants change.
//
// counts (plants/gates/kickers) are recorded alongside both digests so a
// failure report says *what* moved, not just *that* something moved.
//
// Usage:
//   npx tsx scripts/gen-slope-golden.mjs                   # (re)generate the fixture
//   npx tsx scripts/gen-slope-golden.mjs --verify           # verify rngDigest + heightDigest
//   npx tsx scripts/gen-slope-golden.mjs --verify --rng-only        # verify rngDigest only
//   npx tsx scripts/gen-slope-golden.mjs --verify --strict-height   # also fail hard on HEIGHT-CHANGED
// ============================================================================

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { bandFreeIntervals, genSlope } from '@splat/shared/slope';
import { PLANT_BAND_M } from '@splat/shared/config';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE_PATH = path.join(
  ROOT,
  'games/splat/shared/src/__fixtures__/slope-golden.json',
);

// Exactly the 20 fixed seeds required by the task spec (task G1).
const SEEDS = [1, 2, 3, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41, 42, 43, 47, 53, 59, 61, 67];

// Corridor/height lattice: z from 0 to the slope length in steps of 10,
// x in {-8,-4,0,4,8} (task spec, fixed).
const X_SAMPLES = [-8, -4, 0, 4, 8];
const Z_STEP = 10;

/** Fixed-precision round so the digest is stable across machines/platforms. */
function round(v) {
  return Number(v.toFixed(6));
}

/**
 * Canonical, fully-ordered snapshot of everything in one seed's generated
 * slope that flows from the sequential RNG stream: every plant/gate/kicker
 * field in generation order, plus the plant-derived bandFreeIntervals
 * corridor sample. Object keys are written in a fixed order and none are
 * numeric-like (so JSON.stringify's key ordering cannot vary), making the
 * resulting JSON string deterministic across runs and machines. Contains NO
 * height-field data — see canonicalHeight for that half.
 */
function canonicalRng(seed) {
  const s = genSlope(seed);
  const halfW = s.width / 2;

  const plants = s.plants.map((p) => ({
    x: round(p.x),
    z: round(p.z),
    r: round(p.r),
    kind: p.kind,
  }));

  const gates = s.gates.map((g) => ({
    x: round(g.x),
    z: round(g.z),
    halfWidth: round(g.halfWidth),
  }));

  const kickers = s.kickers.map((k) => ({
    x: round(k.x),
    z: round(k.z),
    halfWidth: round(k.halfWidth),
  }));

  // bandFreeIntervals is derived purely from plant placement (via the
  // plantGrid), never from the height field — it belongs here, not in the
  // height half of the digest.
  const bandFreeIntervals_ = [];
  for (let z = 0; z <= s.finishZ + 1e-9; z += Z_STEP) {
    const band = Math.floor(z / PLANT_BAND_M);
    const freeIntervals = bandFreeIntervals(s, band, halfW).map((iv) => ({
      lo: round(iv.lo),
      hi: round(iv.hi),
    }));
    bandFreeIntervals_.push({ z: round(z), freeIntervals });
  }

  return {
    seed: s.seed,
    plants,
    gates,
    kickers,
    bandFreeIntervals: bandFreeIntervals_,
  };
}

/**
 * Canonical, fully-ordered snapshot of everything in one seed's generated
 * slope that flows from the height field: the top-level scalars and the
 * height lattice sample. Contains NO plant/gate/kicker/corridor data — see
 * canonicalRng for that half.
 */
function canonicalHeight(seed) {
  const s = genSlope(seed);

  const heights = [];
  for (let z = 0; z <= s.finishZ + 1e-9; z += Z_STEP) {
    heights.push({ z: round(z), values: X_SAMPLES.map((x) => round(s.height(x, z))) });
  }

  return {
    seed: s.seed,
    length: round(s.length),
    width: round(s.width),
    finishZ: round(s.finishZ),
    heights,
  };
}

function sha256(str) {
  return createHash('sha256').update(str, 'utf8').digest('hex');
}

function buildFixture() {
  const seeds = {};
  for (const seed of SEEDS) {
    const rngCanon = canonicalRng(seed);
    const heightCanon = canonicalHeight(seed);
    seeds[String(seed)] = {
      rngDigest: sha256(JSON.stringify(rngCanon)),
      heightDigest: sha256(JSON.stringify(heightCanon)),
      counts: {
        plants: rngCanon.plants.length,
        gates: rngCanon.gates.length,
        kickers: rngCanon.kickers.length,
      },
    };
  }
  return { generatedOnHead: true, seeds };
}

function main() {
  const args = process.argv.slice(2);
  const verify = args.includes('--verify');
  const rngOnly = args.includes('--rng-only');
  const strictHeight = args.includes('--strict-height');

  const fixture = buildFixture();

  if (!verify) {
    writeFileSync(FIXTURE_PATH, `${JSON.stringify(fixture, null, 2)}\n`, 'utf8');
    console.log(`[gen-slope-golden] wrote ${FIXTURE_PATH}`);
    for (const seed of SEEDS) {
      const c = fixture.seeds[String(seed)].counts;
      console.log(
        `  seed ${String(seed).padStart(2)}: plants=${c.plants} gates=${c.gates} kickers=${c.kickers}`,
      );
    }
    return;
  }

  // --verify: recompute and compare against the committed fixture.
  let committed;
  try {
    committed = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
  } catch (err) {
    console.error(`[gen-slope-golden] cannot read fixture at ${FIXTURE_PATH}: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  let anyRngFail = false;
  let anyHeightChanged = false;

  for (const seed of SEEDS) {
    const key = String(seed);
    const got = fixture.seeds[key];
    const want = committed.seeds?.[key];
    if (!want) {
      console.log(`seed ${key}: FAIL (no committed entry)`);
      anyRngFail = true;
      continue;
    }

    const countsMatch =
      got.counts.plants === want.counts.plants &&
      got.counts.gates === want.counts.gates &&
      got.counts.kickers === want.counts.kickers;
    const rngPass = got.rngDigest === want.rngDigest && countsMatch;

    if (rngPass) {
      console.log(
        `seed ${key}: rngDigest PASS (${got.rngDigest.slice(0, 12)}...) ` +
          `counts=${JSON.stringify(got.counts)}`,
      );
    } else {
      console.log(
        `seed ${key}: rngDigest FAIL committed=${want.rngDigest} counts=${JSON.stringify(want.counts)} ` +
          `!= regenerated=${got.rngDigest} counts=${JSON.stringify(got.counts)}`,
      );
      anyRngFail = true;
    }

    if (rngOnly) continue;

    if (got.heightDigest === want.heightDigest) {
      console.log(`seed ${key}: heightDigest PASS (${got.heightDigest.slice(0, 12)}...)`);
    } else {
      console.log(
        `seed ${key}: heightDigest HEIGHT-CHANGED committed=${want.heightDigest} ` +
          `!= regenerated=${got.heightDigest}`,
      );
      anyHeightChanged = true;
    }
  }

  if (anyRngFail) {
    console.error('[gen-slope-golden] VERIFY FAILED: rngDigest mismatch on at least one seed');
    process.exitCode = 1;
    return;
  }

  console.log('[gen-slope-golden] rngDigest OK: all 20 seeds match the committed fixture');

  if (rngOnly) return;

  if (anyHeightChanged) {
    if (strictHeight) {
      console.error(
        '[gen-slope-golden] VERIFY FAILED (--strict-height): heightDigest changed on at least one seed',
      );
      process.exitCode = 1;
    } else {
      console.log(
        '[gen-slope-golden] heightDigest changed on at least one seed (HEIGHT-CHANGED — ' +
          're-baseline with the diff explained; not a failure without --strict-height)',
      );
    }
  } else {
    console.log('[gen-slope-golden] heightDigest OK: all 20 seeds match the committed fixture');
  }
}

main();
