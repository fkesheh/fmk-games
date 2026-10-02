---
type: investigation
symptom: "rift overtime surge test expects retroactive growth the sim deliberately removed"
slug: rift-overtime-surge-growth
date: 2026-09-27T19:38:30Z
investigator: Foad Kesheh
git_commit: 72497e03a28a109536014cb120fbf35548640551
branch: assets-trees-v2
repository: unknown/fps
status: resolved
hypotheses_formed: 4
hypotheses_rejected: 2
hypotheses_proven: 2
related: []
---

# rift overtime surge test expects retroactive growth the sim deliberately removed

## Symptom
- **Observed**: `games/rift/server/src/sim/units.test.ts > wave spawner > overtime switches to SURGE_WAVE_GROWTH…` fails with
  ```
  AssertionError: expected 730.4753944416035 to be close to 1382.1856901630156, received difference is 651.7102957214121, but expected 0.00005
  ```
- **Expected**: overtime wave melee `maxHp` equals `CREEP_MELEE.hp * (1 + SURGE_WAVE_GROWTH)^base` (test, units.test.ts:219-222).
- **Delta**: observed is 0.528x of expected — the sim grows the wave ~1.62x over base creep hp while the test demands ~3.07x.

## Reproduction
1. `npx vitest run games/rift/server/src/sim/units.test.ts` (also fails on the clean tree with all P0/P1/P2 work stashed).
2. Deterministic: failed 3/3 runs (full suite, isolated, clean tree). No time/randomness involved — pure arithmetic.
   Verified: 2026-09-27 — symptom reproduced on demand.

## Hypotheses

#### H1: stepWaves computes the wrong multiplier (code-logic bug: bad clamp/exponent)
- **Layer**: code-logic
- **Prediction**: If H1 is true, hand-evaluating the documented piecewise rule at the failing wave will NOT equal the observed 730.4753944416035 (the code deviates from its own spec). If false, they match to float precision.
- **Verification method**: read code at games/rift/server/src/sim/units.ts:160-165; evaluate both formulas in node with the config constants (WAVE_FIRST_AT_S=10, WAVE_PERIOD_S=30, OVERTIME_AT_S=660 → firstOt=22, base=23, otIndex=22; WAVE_GROWTH=0.02, SURGE_WAVE_GROWTH=0.05, CREEP_MELEE.hp=450).
- **Evidence**:
  ```
  test-expects : 1382.1856901630156   (= 450 × 1.05^23, the test's formula)
  code-computes: 730.4753944416035    (= 450 × 1.02^min(23,22) × 1.05^max(0,23-22))
  observed     : 730.4753944416035
  ```
  Code excerpt (units.ts:148-165) documents the piecewise rule as intentional, with the continuity rationale (`1.02^21 = 1.52 -> 1.02^22 * 1.11^0 = 1.55`).
- **Verdict**: REJECTED
- **Rationale**: the code computes EXACTLY what its spec comment says, to the last ulp. There is no clamp/exponent slip; H1's predicted deviation does not occur.

#### H2: the test asserts the retroactive formula that commit 761bdf1 deliberately removed
- **Layer**: observation (stale test artifact)
- **Prediction**: If H2 is true, (a) the test's expected value equals the OLD formula `hp × (1+SURGE)^absoluteIndex` exactly, and (b) the fix commit touched the sim but NOT the test. If false, either the numbers won't reconcile or the test was updated alongside.
- **Verification method**: node arithmetic (above: 450 × 1.05^23 = 1382.1856901630156, digit-exact vs the assertion message); `git show 761bdf1 --stat`; read the commit message.
- **Evidence**:
  ```
  commit 761bdf12eb4edc5777d7ad9273ebaa81ea5654a4
  rift: stop the overtime surge from applying retroactively to the whole match

  stepWaves computed creep scaling as pow(1 + growth, waveIndex) where `growth`
  switched from WAVE_GROWTH (2%) to SURGE_WAVE_GROWTH (11%) at overtime, but the
  EXPONENT stayed the absolute wave index. Crossing OVERTIME_AT_S therefore
  recomputed the entire match as if creeps had been ramping at 11% since minute
  zero, instead of ramping faster from that point on.

  games/rift/server/src/sim/units.ts | 20 ++++++++++++++++++--
  1 file changed, 18 insertions(+), 2 deletions(-)
  ```
  The test file `units.test.ts` is absent from the stat; its last touch (83ccf51, 08-09) predates the fix (08-14). The contract defers wave rules ("wave rules per config", CONTRACT.md:82-84) and mandates no retroactive jump. Expected value 1382.1856901630156 === 450 × 1.05^23 digit-exact: the test encodes the removed formula verbatim.
- **Verdict**: PROVEN (pending falsification below)
- **Rationale**: the expected value IS the old formula to 16 digits, the fix commit documents that formula as the bug, and the test was never updated. All three predictions hold.

#### H3: test and sim disagree on the SURGE_WAVE_GROWTH value (config mismatch)
- **Layer**: config-env
- **Prediction**: If H3 is true, the test imports a different rate than the sim (e.g., stale 0.11 vs tuned 0.05), and the numbers reconcile only with mixed rates.
- **Verification method**: read imports (units.test.ts:41, units.ts:51) and config value (config.ts:457).
- **Evidence**:
  ```
  units.test.ts:41:  SURGE_WAVE_GROWTH,     (from '@rift/shared')
  units.ts:51:  SURGE_WAVE_GROWTH,          (from '@rift/shared')
  config.ts:457:export const SURGE_WAVE_GROWTH = 0.05; // gentle stat ramp in overtime (was 0.11)
  ```
  Both sides share one import; the H1 arithmetic reconciles with 0.05 on BOTH sides (test: 1.05^23; code: 1.05^1).
- **Verdict**: REJECTED
- **Rationale**: single shared constant; no skew exists to explain a 1.89x gap.

## 5 Whys
Symptom:  overtime surge unit test fails (730.48 vs 1382.19).
Why 1?    Because the test asserts the retroactive surge formula (H2 proven).
Why 2?    Because commit 761bdf1 fixed the sim to piecewise growth but did not update the test's expectation (single-file stat).
Why 3?    Because the commit shipped with known-red suites ("KNOWN, NOT FIXED HERE: the harness's pacing bands are still red") — red was already the accepted state, so one more red unit test drew no attention.
Why 4?    Because nothing gates commits on the affected suites being green (no required per-area test run before commit; the balance suite takes ~4 min, so it is plausibly skipped).
Why 5?    Because verification is advisory rather than structural in this repo's workflow: a commit message can declare red acceptable, and no mechanism distinguishes "accepted-red" (balance tuning, deferred deliberately) from "unnoticed-red" (this stale assertion).

## Falsification
- Check performed: counterfactual edit (documented experiment): temporarily restore the OLD retroactive formula in stepWaves (`growthMult = 1.05^waveIndex` in OT), run ONLY the failing test, then revert (revert verified: `git diff` clean).
- Result: the hp assertion (line 219) PASSED under the old formula — then the test failed LATER at line 233 (`expected [] to have a length of 4 but got +0`: no fresh wave on the assumed tick). Experiment diff (reverted):
  ```
  -    ? Math.pow(1 + SURGE_WAVE_GROWTH, Math.max(0, w.waveIndex - otIndex))
  +    ? Math.pow(1 + SURGE_WAVE_GROWTH, w.waveIndex) / Math.pow(1 + WAVE_GROWTH, Math.min(w.waveIndex, otIndex))
  ```
- Conclusion: H2 SURVIVED (the test asserts exactly the removed behavior) — and the experiment exposed a SECOND, masked rot at line 233 (new child hypothesis H2.1 below). The 233 failure cannot be caused by the experiment edit (it touched only the stat multiplier; spawn timing identical), so it is pre-existing under current code, masked behind the earlier hp failure.

#### H2.1: the surged-wave checkpoint assumes fixed-period spawn ticks; 423e59b's shrinking OT periods moved real spawns earlier (child of H2)
- **Layer**: observation (stale test artifact)
- **Prediction**: If H2.1 is true, fixing ONLY the hp expectation will move the failure to line 233 with 0 fresh melee (actual waveIndex already past `surged` at `WAVE_TICK(surged)`), because OT periods shrink 30→26→22→18s (SURGE_PERIOD_STEP_S=4, MIN=18) while `WAVE_TICK(k)` assumes fixed 30s. If false, the hp fix alone turns the test green.
- **Verification method**: (a) the falsification run above (failed at 233 under identical timing); (b) schedule arithmetic: over the 190s march past OT the shrink spawns ~7.5 waves vs 6.3 fixed, so wave 28 lands ~30s before `WAVE_TICK(28)`; (c) PREDICTED intermediate observation after the hp-only fix (recorded below).
- **Evidence**:
  ```
  AssertionError: expected [] to have a length of 4 but got +0
  ❯ games/rift/server/src/sim/units.test.ts:233:24
  ```
  (from the falsification run; timing path untouched by the experiment edit).
  Adjacent rot in the same checkpoint: the test's `extraMeleeAt` mirror omits the `SURGE_EXTRA_MELEE_MAX = 2` cap the code applies (units.ts:167-172) — latent, non-binding at these values, fixed with the checkpoint.
- **Verdict**: PROVEN (experiment + arithmetic; intermediate observation to confirm)
- **Rationale**: 0 fresh melee on the assumed tick under timing-identical code, with the shrink schedule fully explaining the drift. The `base`-wave checkpoint is unaffected (shrink floor term is 0 that early: otSecs < 60s → period still 30s — confirmed by the digit-exact hp match at waveIndex 23).

## Root Cause
- Immediate cause: `units.test.ts`'s overtime expectations were not updated with two sim changes — (H2) 761bdf1's piecewise growth (test still asserts `hp × 1.05^absoluteIndex`, the exact removed formula, digit-exact 1382.1856901630156) and (H2.1) 423e59b's shrinking OT wave periods (test still assumes fixed-period spawn ticks at line 233; the second rot was masked behind the first).
- Architectural root (from 5 Whys): verification is advisory — a commit may ship known-red suites, and no mechanism distinguishes accepted-red (deferred balance tuning) from unnoticed-red (these stale assertions). Two behavior commits in a row landed without their test updates.
- Rejected H1: code computes exactly its documented piecewise rule (digit-exact 730.4753944416035). Rejected H3: single shared SURGE_WAVE_GROWTH import, no skew.
- Falsification: counterfactual old-formula edit made the hp assertion pass (H2 survived); the same run exposed H2.1, which is proven by timing-identical evidence + schedule arithmetic.

## Fix
- Test file ONLY (`games/rift/server/src/sim/units.test.ts`) — the sim behavior is the twice-deliberate design (761bdf1 + 423e59b + contract deference "wave rules per config"); no sim change.
  1. hp expectation → piecewise derivation from config (continuous across the boundary, per the documented rule).
  2. surged-wave checkpoint → timing-robust: march by TIME past one extra-melee period, catch the next fresh wave (bounded), assert its time-derived count INCLUDING the MAX cap.
- Regression test: the updated test itself — fails on retroactive-formula code (hp 1382 vs 730), fails on fixed-schedule assumption drift, passes on current code. Discrimination verified both directions (see Resolution).
- Justification for test-side fix (against the default rule): the test asserts the exact formula a prior commit documented AS the bug, with digit-exact evidence and a single-file commit stat proving the test update was missed — not a judgment call I am making to fit code I wrote.

## Resolution
- Intermediate observation (H2.1 prediction): after the hp-only fix, the failure moved to the surged-wave count (`expected [] to have a length of 4 but got +0`, line 238 post-edit) — exactly as predicted. H2.1 confirmed by direct observation.
- Diff summary: `games/rift/server/src/sim/units.test.ts` ONLY (no sim change):
  1. hp expectation → piecewise derivation from config (`1.02^min(k,ot) × 1.05^max(0,k-ot)`), replacing the removed retroactive formula;
  2. surged checkpoint → march by TIME past one extra-melee period, catch the next fresh wave within a bounded one-period window, assert the time-derived count INCLUDING the `SURGE_EXTRA_MELEE_MAX` cap (previously unmirrored).
- Verification:
  - `units.test.ts`: 34/34 pass; `@rift/server` typecheck clean.
  - Discrimination: updated test + restored old formula → FAILS (`expected 1382.19 to be close to 730.48`); updated test + current code → passes. Experiment reverted (`git diff` clean).
- Follow-up: none for this symptom. The balance-band failures are a separate symptom with their own log (`2026-09-27-rift-balance-bands.md`); the pre-OT metrics failing there (level-6 timing, gold@10min) cannot be caused by the overtime formula.
