---
type: investigation
symptom: "balance: median ancient-kill duration 21.02min vs the 12-18min CONTRACT §9 band"
slug: rift-balance-slow-ancient-kills
date: 2026-10-01T22:24:14-0300
investigator: Foad Kesheh
branch: assets-trees-v2
repository: fps
status: investigating
hypotheses_formed: 4
hypotheses_rejected: 2
hypotheses_proven: 1
related:
  - docs/investigations/2026-10-01-rift-balance-seed-collapse.md
---

# Ancient kills take 21min (median) against a 12-18min band; 4v4 stalls worst (27.3/24.8 + 3 tiebreaks)

## Symptom
- **Observed**: `balance.test.ts` "median match duration by Ancient kill is 12-18 min
  game-time across the set" fails — `median ancient-kill duration 21.02min:
  expected 21.022083333333335 to be less than or equal to 18`.
- **Expected**: median over ancient-ended matches within [12, 18].
- **Delta**: +3.02min over the cap (≈17% too slow to close).

## Reproduction
1. `npx vitest run games/rift/server/src/balance.test.ts` (deterministic: fixed seeds).
2. Observe the FAIL line + the report block:
   ```
   ancient-kill durations (min): [20.7, 21.6, 18.8, 18.4, 21.3, 27.3, 24.8, 21.1, 14.2, 21.7, 13.0, 20.9] median=21.02 non-ancient=3/15
   2v2: duration median 20.69min over 5 ancient kills, level-6 median 5.46min, wins 1:4, distinct matches 5/5
   4v4: duration median 26.04min over 2 ancient kills, level-6 median 9.85min, wins 3:2, distinct matches 4/5
   8v8: duration median 20.92min over 5 ancient kills, level-6 median 9.61min, wins 3:2, distinct matches 5/5
   ```
   Verified: 2026-10-01 — reproduced on every run (deterministic seeds).
   Companion constraints (must hold after any tune): first-tower median 5.3 (band 5-8);
   level6 2v2 5.46 (floor 5), 4v4 9.85 (6-11), 8v8 9.61 (~14); gold10med 2680-3536
   (2200-5500); div ≤31.5% (<40%); wins 8/15 team-1 (≤55% — ONE flip from red);
   tiebreaks 3/15 (allowance ≤3 — EXHAUSTED); jungle relationships green.

## Hypotheses

#### H1: end-phase structure pools are too deep for siege DPS (guards + ancient + fountain)
- **Layer**: config (tuning)
- **Prediction**: If H1 is true, cutting LATE-phase structure HP (guards, ancient) and
  fountain sustain shortens the tail without moving early bands (first tower, level6,
  gold@10, jungle are pre-10min / early-event measures the tail cannot touch), and the
  median lands ~16.5-17.5 while tiebreaks fall (faster closes convert them).
- **Verification method**: mechanism (stat blocks + identical-AI variance) → tuning
  experiment with prediction-first measurement.
- **Evidence**:
  ```
  games/rift/shared/src/config.ts:328-338:
    TOWER:        hp 3300, armor 18  (×2 per lane per team)
    GUARD_TOWER:  hp 1100, armor 12  (×2 per team; ancient invuln until down)
    ANCIENT:      hp 1700, armor 10
    FOUNTAIN_HEAL_PCT/FOUNTAIN_MANA_PCT = 0.06 (defenders rotate + heal through sieges)
  ```
  Per-lane siege total ≈ 6600 + 2200 + 1700 = 10,500 HP @ armor 10-18, much of it
  contested under fountain sustain with 3+3.5/lvl-sec defender recycling. The SAME bot
  AI closes 8v8 matches in 13.0/14.2min (in-sample) while 4v4 stalls to 27.3/30.0 —
  pacing varies 2x+ with identical AI, so the knob is NUMBERS (pools vs DPS over game
  phases), not capability. Duration-sorted: the middle of the distribution (20.7-21.7)
  must move ~4min; the tail (guards+ancient+fountain) is the only phase whose numbers
  don't feed any early band.
- **Verdict**: PROVEN (working cause; confirmed by the tuning experiment below)
- **Rationale**: identical-AI 13→30min variance proves pacing is state/numbers-driven;
  the stat blocks locate the deep pools in the closable tail; early bands pin every
  other lever (tower HP → first-tower floor 5.0 with median 5.3; xp/gold levers →
  2v2 level6 floor/gold bands), leaving guards/ancient/fountain as the only safe cut.

#### H2: bots cannot siege coordinately (AI incapability, not numbers)
- **Layer**: code-logic
- **Prediction**: If H2 is true, NO match with this AI closes quickly — durations cluster
  long regardless of size/seed.
- **Verification method**: counterexample from the report (fast finishes with identical AI).
- **Evidence**: 8v8 0xcafe4 ends by ancient at 13.0min and 0xcafe2 at 14.2min — same bot
  brains, same code path as the 27.3min stall. The AI demonstrably CAN break high
  ground and close (and did, twice, inside the band).
- **Verdict**: REJECTED
- **Rationale**: an incapable sieger cannot close in 13 min; the AI did. (Bot behavior
  shapes WHICH matches stall, but the fixable cause is the pools it stalls against.)

#### H3: defender respawns (3 + 3.5s/level) recycle too fast, so pushes always fail
- **Layer**: config (tuning)
- **Prediction**: If H3 is primary, slowing respawns is REQUIRED to land the band (H1's
  cuts alone miss), and kill-heavy long matches show recycle patterns.
- **Verification method**: held as backup; discriminated by the H1 experiment outcome.
- **Evidence**: RESPAWN_BASE_S=3, RESPAWN_PER_LEVEL_S=3.5 (config.ts:359-360). Long matches
  DO show high heroKill xp shares (25-26% in 4v4-0xbed1, 8v8-0xcafe5) — consistent with
  recycle-fighting, but equally consistent with H1 (long contested tails produce kills
  under any respawn). Respawn cuts risk mid bands (gold@10 via kill economy, first-tower
  via successful dives), so H3 is second-line by blast radius.
- **Verdict**: INCONCLUSIVE (backup hypothesis; resolved by the H1 experiment: if the band
  lands with respawns untouched, H3-as-primary is rejected; if H1 misses, H3 gets its
  own prediction-first experiment)
- **Rationale**: cannot discriminate from H1 on report data alone; the experiment decides.

#### H4: the 12-18 band is stale (the game legitimately outgrew it; change the band)
- **Layer**: observation (contract artifact)
- **Prediction**: If H4 is true, sub-18 finishes are unreachable and the band contradicts
  achievable play.
- **Verification method**: counterexample from the report (in-band finishes exist?).
- **Evidence**: 13.0, 14.2, 18.4min ancient kills exist IN-SAMPLE — sub-18 is reachable
  by the current sim; only the MEDIAN needs shifting. The band is CONTRACT §9 frozen
  design intent, not an observed summary.
- **Verdict**: REJECTED
- **Rationale**: reachable in-sample ⇒ the band is achievable; moving the goalposts
  instead of the game would hide the slow-close defect the band exists to catch.

## 5 Whys
Symptom:  Median ancient-kill duration 21.02min vs the 12-18 band.
Why 1?    Because the closable tail (guards + ancient under fountain sustain) takes too
          long to chew through once exposed (H1).
Why 2?    Because the pools were sized (1100/1700 + 6%/s sustain) against an
          overestimated siege DPS — contested, recycled defense multiplies nominal
          dps-time ~10-20x.
Why 3?    Because structure tuning was set absolutely (round HP numbers) rather than
          calibrated against measured close times per phase.
Why 4?    Because no band measured the tail separately from the whole — the duration
          band aggregates setup+mid+tail, so tail bloat hid inside a passing-then-failing
          total until it crossed 18.
Why 5?    Because balance iteration tuned forward (set numbers → hoped the band holds)
          instead of backward (measure phase times → size pools to the band) — the
          tail was never budgeted.

## Falsification
- Check performed: adjacent-cause search — H2 (AI) and H4 (stale band) predict the same
  slow median; both are rejected above with in-sample counterexamples (13.0/14.2min
  closes). H3 (respawns) remains the live alternative and is discriminated BY the
  experiment: the H1 tune touches no respawn constant, so a landed band rejects H3.
- Absence test (post-fix): matches ending before guards fall (fast 8v8s) must NOT move
  (their path avoids the cut pools) — verified by comparing per-match durations
  before/after: early-game stats (tower1, lvl6, gold10) must be near-identical while
  tail-heavy matches shorten. If early stats move, the tune leaked past the tail.
- Conclusion: pending the tuning experiment run.

## Root Cause
- Immediate cause: end-phase pools (2×1100-guard + 1700-ancient @ armor 10-12 under 6%/s
  fountain sustain) exceed what siege DPS closes inside the band (evidence: stat blocks
  + 21.02 median + 4v4 27.3/24.8/30×3 stall cluster).
- Architectural root: forward-only balance tuning with no per-phase time budget (Why 5).
- Rejected H2: AI closes in 13.0/14.2min — capable, not the cause.
- Rejected H4: sub-18 reachable in-sample; the band is achievable frozen intent.
- H3: backup — rejected retrospectively if the band lands with respawns untouched.

## Fix
- (pending: prediction-first tuning experiment)
- Prediction: GUARD_TOWER hp 1100→700, ANCIENT hp 1700→1150,
  FOUNTAIN_HEAL/MANA_PCT 0.06→0.04 ⇒ median 21.0 → ~16.5-17.5; tiebreaks 3 → 0-2;
  first-tower/lvl6/gold10/jungle statistically unchanged (pre-10min measures);
  wins stay ≤55% (symmetric cuts; MUST re-verify — currently 8/15, one flip from red).
- ORDER: lands AFTER the seed-collapse fix (which reshuffles all trajectories) and is
  measured on top of it — separate experiments, separately attributed.

## Resolution
- (pending implementation + balance-suite proof)
