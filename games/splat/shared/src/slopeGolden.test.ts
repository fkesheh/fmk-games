// ============================================================================
// slopeGolden.test.ts (task G2, CONTRACT_V3 §12.3/§12.5 gate 4) — the CI gate
// for the slope-golden fixture. Nothing else imports
// games/splat/shared/src/__fixtures__/slope-golden.json (grep -rn
// slope-golden finds only scripts/gen-slope-golden.mjs and the contract), so
// without this test a run of `npm run test` would never notice that a change
// moved a plant, gate, kicker, or the terrain height lattice. This test
// shells out to `--verify --strict-height`, so the check is exactly the one
// CONTRACT_V3 §12.5 gate 4 requires: BOTH the rngDigest (plants/gates/
// kickers/corridor — must stay byte-identical) AND the heightDigest (terrain
// lattice — must match the committed baseline) for all 20 fixed seeds.
//
// The fixture was re-baselined against the §12.2a rev-3 amplitudes
// (UND_LONG_1_AMP = 5.2, UND_LONG_2_AMP = 0.4, UND_LAT_AMP = 2.5;
// config.ts:44-48) via `npx tsx scripts/gen-slope-golden.mjs` (no --verify).
// heightDigest is therefore load-bearing again: it now detects an
// *unintended* terrain change instead of being permanently red from the
// intended amplitude raise. If a future PR intentionally changes terrain
// amplitude again, re-run the regenerate step and note the justification in
// the commit that updates the fixture.
// ============================================================================
/// <reference types="node" />
// @splat/shared's tsconfig sets "types": [] (isomorphic package, no ambient
// Node globals) since nothing else here needs Node builtins. This test is
// the sole exception — it must shell out to verify the fixture — so it pulls
// in @types/node explicitly for itself only, rather than widening the
// package-level tsconfig for every other file.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const SCRIPT = path.join(ROOT, 'scripts/gen-slope-golden.mjs');

describe('slope-golden rngDigest + heightDigest gate', () => {
  it('gen-slope-golden --verify --strict-height exits 0 against the committed fixture', () => {
    const result = spawnSync('npx', ['tsx', SCRIPT, '--verify', '--strict-height'], {
      cwd: ROOT,
      encoding: 'utf8',
    });

    if (result.status !== 0) {
      throw new Error(
        `gen-slope-golden --verify --strict-height failed (exit ${result.status}):\n` +
          `${result.stdout}\n${result.stderr}`,
      );
    }

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      '[gen-slope-golden] rngDigest OK: all 20 seeds match the committed fixture',
    );
    expect(result.stdout).toContain(
      '[gen-slope-golden] heightDigest OK: all 20 seeds match the committed fixture',
    );
  }, 20_000);
});
