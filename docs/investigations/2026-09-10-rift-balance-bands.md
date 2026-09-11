---
type: investigation
symptom: "rift balance harness 4 failures + overtime wave-spawner failure (all marginal band misses)"
slug: rift-balance-bands
date: 2026-09-10T02:10:00-03:00
investigator: opencode
git_commit: d749fe5
branch: game-ports
repository: fkesheh/fmk-games
status: root-cause-proven
hypotheses_formed: 4
hypotheses_rejected: 0
hypotheses_proven: 0
related:
  - docs/investigations/2026-09-10-rift-typecheck.md
---

# Rift balance bands red (4 marginal + 1 overtime)

## Symptom
- **Observed** (verbatim, `npx vitest run games/rift/server/src/balance.test.ts`):
  ```
  median ancient-kill duration 20.70min: expected 20.698333333333334 to be less than or equal to 18
  6/15 matches needed the tiebreak: expected 6 to be less than or equal to 3
  2v2 level-6 median 5.46min: expected 5.460833333333333 to be greater than or equal to 6
  2v2 seed 0xace1 gold10 median 2133: expected 2132.500000000177 to be greater than or equal to 2200
  ```
  plus `sim/units.test.ts > wave spawner > overtime switches to SURGE_WAVE_GROWTH, emits one surge event, and adds melee over time` (1195ms then fail).
- **Expected**: bands per CONTRACT §9 (duration 12–18min, tiebreak <20%, level-6 6–11min, gold 2200–5500).
- **Delta**: duration +15% over cap; tiebreak 2× allowance; leveling 9% fast; gold 3% lean. All close, none catastrophic.

## Reproduction
1. `npx vitest run games/rift/server/src/balance.test.ts` (~166s, headless all-bot matches)
2. Verified: 2026-09-10 — 4 failed / 12 passed, values above. Rerun gave identical values (TBD — determinism check below).

## Hypotheses

#### H1: A recent sim tuning change shifted dynamics out of band
- Layer: code-logic
- Prediction: If true, `git log` on games/rift/server/src/sim + balance-adjacent files shows tuning commits after the bands last passed, plausibly affecting XP/gold/damage (candidates: S_BALANCE per a041237).
- Verification method: git log dates/messages; read the tuning diffs.
- Evidence: (gathering)
- Verdict: INCONCLUSIVE

#### H2: The sim is right and the bands are stale (test-is-wrong)
- Layer: observation (test artifact)
- Prediction: If true, the misses are all small/same-direction and the sim changes that caused them were DELIBERATE contract-level decisions (e.g. an amendment changing pacing), with bands never re-baselined.
- Verification method: read CONTRACT §9 + AMENDMENT files for pacing decisions; check whether bands were updated alongside tuning commits.
- Evidence: (gathering)
- Verdict: INCONCLUSIVE

#### H3: Results are nondeterministic across runs/machines (hidden variable)
- Layer: config-env / state-data (unseeded randomness, wall-clock in bot AI)
- Prediction: If true, rerunning the identical command yields DIFFERENT medians (20.70 → something else). If values repeat exactly, REJECT.
- Verification method: rerun balance.test.ts, compare the four numbers verbatim.
- Evidence: (gathering)
- Verdict: INCONCLUSIVE

#### H4: The harness measures itself (measurement bug, not sim bug)
- Layer: observation (test artifact)
- Prediction: If true, the metric computation (not the sim) is wrong — e.g. tick-domain confusion (snap.tick vs matchTick, cf. derive.ts comment), warmup ticks counted, wrong denominators. Prior art: commit a041237 "the harness was measuring itself".
- Verification method: read the harness metric code at balance.test.ts:700-780.
- Evidence: (gathering)
- Verdict: INCONCLUSIVE

## 5 Whys
Symptom:  balance bands red (duration 20.7/18, tiebreak 6/15, level-6 5.46/6, gold 2132/2200) + overtime unit test
Why 1?    Because overtime volume can't close games (423e59b cut lethality 11%->5% + retroactive spike; owner: "still does not close hard enough") and early XP/economy drifted (level fast, gold lean on one seed).
Why 2?    Because the 423e59b redesign capped volume at the tick budget (12s floor broke §10 p95; settled 18s) and bot laning/jungling behavior shifted kill/last-hit composition.
Why 3?    Because tuning constants and bot brains evolve without re-running the 166s harness every commit.
Why 4?    Because the harness is slow enough that authors verify locally on subsets and land red (cf. 423e59b message: "12/16 ... STILL RED, and honestly not fixed").
Why 5?    Because long-lived game branches defer integration hygiene to port time — same root as the typecheck cluster.

## Falsification
- Adjacent-cause search: single cause for all five? Overtime volume explains duration/tiebreak only (pre-11:00 metrics independent). Neutral-team handling (typecheck H1) affects audio derivation, not sim. No single cause — documented as three independent items.
- H3 absence test: bit-identical reruns (20.698333333333334 etc.) — environment cannot be the cause. H4: harness self-checks (attribution <0.5%, determinism, non-degeneracy) all pass — measurement valid.

## Root Cause
- Immediate causes: (1) OT wave-period floor 18s + capped melee closes too slowly (evidence: per-match table — systematic ~20min, 4v4 4/5 tiebreak; owner 423e59b message); (2) overtime unit test encoded pre-761bdf1 absolute growth (evidence: hand-derived 730.48); (3) level-6 test asserted pre-AMENDMENT-8 floor (evidence: amendment §C ruling never applied); (4) gold outlier = single-match last-hit variance (0xace1 div 33.6%, same XP split as passing seeds — evidence: per-match table).
- Architectural root: slow harness + deferred integration (5 Whys).
- Rejected H2 (contract §9 + OVERTIME_AT_S comment authoritative), H3 (bit-identical), H4 (self-checks green).

## Experiment E1 (overtime close rate) — REVERTED
- Change: `SURGE_WAVE_PERIOD_MIN_S` 18 -> 15 (middle ground the owner never tried: 12 broke §10, 18 stalls). Still volume, not lethality; cap/melee untouched.
- Predict: median duration <= 18, tiebreak <= 3/15, perf block (§10 p95) still green, early metrics (level/gold/tower) unchanged.
- Result (2026-09-10, full 166s harness): median 20.70 -> **22.51 (WORSE)**; tiebreaks dropped into allowance (4v4 went 1 -> 4 ancient kills); early metrics bit-identical (as predicted — pre-11:00 independence holds); level/gold/tower unchanged.
- Mechanism learned: symmetric volume converts tiebreaks into SLOW kills — both teams' surged waves annihilate mid-map, scaling the stalemate instead of breaking it. Closing needs ASYMMETRY, not rate: super-creep snowball, OT siege composition (SIEGE_BUILDING_MULT=6 already exists), or bot push behavior per AMENDMENT_8 §D levers. That is amendment-grade game design, not a tuning constant — reverted, proposing below.
- Falsification of "just add volume": tried, measured, worse. Survives as negative knowledge.

## Root Cause (final)
- (1) Duration/tiebreak: overtime lacks an asymmetry/closing mechanism (evidence: systematic ~20min across sizes; E1 volume FAILURE MODE). Owner-confirmed open problem (423e59b message).
- (2) Overtime unit test: encoded pre-761bdf1 absolute growth — FIXED (piecewise formula, hand-verified 730.48; plus spawn-detection rewrite for shrinking OT periods).
- (3) Level-6 test asserted pre-AMENDMENT-8 floor — ruling (5.5) applied to test + CONTRACT §9. Residual 5.46 vs 5.5 = jungling signal per the ruling's own tripwire → bot levers (D.3: JUNGLE_MAX_DIST scaling, jungler caps, pickCamp rng, lanePressure range, campCommit on death).
- (4) Gold outlier: single-match last-hit variance (0xace1 div 33.6% with identical XP split to passing seeds) — bot skill, same D routing.
- Rejected H2 (contract authoritative), H3 (bit-identical reruns), H4 (harness self-checks green).

## Fix
- units.test.ts: piecewise surge expectation + spawn-detection loop (no sim change).
- balance.test.ts: 2v2 floor 6 -> 5.5 (ratified AMENDMENT_8 §C).
- CONTRACT.md §9: records lane+kills model + 5.5 floor.
- config.ts: E1 reverted; comment records the negative result.
- PROPOSED (not applied — needs design sign-off): asymmetry closing mechanism; bot jungle/push levers per §D. Verification plan: full harness (166s) must show median <= 18 AND tiebreak <= 3 with perf block green and early metrics unmoved.

## Fix
- units.test.ts: piecewise surge expectation + spawn-detection loop (no sim change) — 34/34 green.
- balance.test.ts: 2v2 floor 6 -> 5.5 (ratified AMENDMENT_8 §C).
- CONTRACT.md §9: records lane+kills model + 5.5 floor.
- config.ts: E1 reverted; comment records the negative result.
- PROPOSED (not applied — needs design sign-off): asymmetry closing mechanism; bot jungle/push levers per §D. Verification plan: full harness (166s) must show median <= 18 AND tiebreak <= 3 with perf block green and early metrics unmoved.

## Resolution (partial — test/infra fixed, sim bands open by design)
- Fixed: overtime unit test green; 5.5 ruling applied to test + contract; full-repo `npm run typecheck` green (with the typecheck investigation's fixes).
- Still red (documented, not abandoned): duration 20.70/18, tiebreak 6/15, level-6 5.46/5.5, gold 2132/2200 — root causes proven above; closing requires amendment-grade design (asymmetry mechanism + bot levers), and the owner is actively working this surface (423e59b: "honestly not fixed").
- Follow-up: AMENDMENT_9 (asymmetry closing) + bot-lever task per §D.

## Resolution
(TBD.)
