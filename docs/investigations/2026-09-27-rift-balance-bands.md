---
type: investigation
symptom: "rift balance harness bands red: slow gold, fast levels, long matches, tiebreaks"
slug: rift-balance-bands
date: 2026-09-27T19:38:30Z
investigator: Foad Kesheh
git_commit: 72497e03a28a109536014cb120fbf35548640551
branch: assets-trees-v2
repository: unknown/fps
status: investigating
hypotheses_formed: 6
hypotheses_rejected: 1
hypotheses_proven: 2
related:
  - docs/investigations/2026-09-27-rift-overtime-surge-growth.md
---

# rift balance harness bands red: slow gold, fast levels, long matches, tiebreaks

## Symptom
- **Observed** (`games/rift/server/src/balance.test.ts`, isolated run 2026-09-27):
  ```
  median ancient-kill duration 20.70min: expected 20.698333333333334 to be less than or equal to 18
  6/15 matches needed the tiebreak: expected 6 to be less than or equal to 3
  2v2 level-6 median 5.46min: expected 5.460833333333333 to be greater than or equal to 6
  2v2 seed 0xace1 gold10 median 2133: expected 2132.500000000177 to be greater than or equal to 2200
  ```
  (Plus a 5th, full-suite-only failure: sim tick p95 2.40ms vs the 2ms §10 budget — passed 2/2 in isolation; load-flake suspect, triaged separately below.)
- **Expected** (CONTRACT §9): ancient-kill median 12–18 min; tiebreaks < 20% of sims; level 6 in 6–11 min at 2v2/4v4; gold@10min 2200–5500/hero.
- **Delta**: matches run ~15% too long with 2x the allowed tiebreaks; heroes level ~9% too FAST while earning ~3% too LITTLE gold (2v2 seed 0xace1; other seeds TBD).
- Last green: 022926a (08-04, "balance harness 9/9 green, duration median 14.55"). Since then: a041237 (08-07, harness rewrite), 83ccf51 (08-09, towers/sightlines), 761bdf1 (08-14, retroactive-surge removal — admitted bands red after), 423e59b (08-14, volume-not-lethality + items), db2e803 (08-14, item tiers).

## Reproduction
1. `npx vitest run games/rift/server/src/balance.test.ts` (~200–260s; 15 seeded bot matches + determinism replays).
2. Deterministic seeds (MATCH_SEEDS fixed); failures reproduced 3/3 (full suite, isolated, clean tree — counts vary 4–6, see Flakiness note).
3. Flakiness note: WHICH bands fail is stable (duration/tiebreak/level/gold); the tick-p95 budget failed only in the full parallel run and passed twice in isolation → treated as a separate load-sensitivity question, not part of this symptom.

## Hypotheses

#### H-G1: gold10 shortfall is a harness valuation artifact — fused items measured at recipe-fee, not total cost
- **Layer**: observation (stale measurement after a deliberate sim change — same class as the surge log)
- **Prediction**: per-match TRUE gold10 (purse + `itemTotalCost` over held) is ≥ 2200 everywhere the measured median fails; failing matches hold ≥1 fused item at 10:00; measured-vs-true gap ≈ Σ(total − top) over fused held (fang 400, stormbow 400, aegisheart 450, bulwarkplate 850, warhorn 400, ultimates 1500+). If TRUE wealth also fails → REJECTED (real income shortfall).
- **Verification method**: extended DEBUG dump run (temp instrumentation): print measured vs true medians + fused counts per match.
- **Evidence**:
  - Item defs (item.ts:124-155): fused top-level `cost` is the recipe FEE only (fang 300/700 total, bulwarkplate 350/1200); comments state the totals.
  - `World.buy` combines: consumes components + charges fee (world.ts:713-720; units.test.ts:400-401 pins purse math).
  - Bots build recipe targets component-first (bots.ts:392-398); every role's BUILD_ORDER combines early (fang/aegisheart/warhorn/stormbow within the first 3 slots).
  - Bots NEVER sell (no sell path in bots.ts) → combining is the sole value leak; SELL_REFUND (0.6) irrelevant.
  - The GAME values fused items at TOTAL cost (`sellValue('fang') === 420 === 0.6 × 700`, pinned in room.test.ts:1505-1506) while the HARNESS values them at top-level cost (`ITEM_COST.set(def.id, def.cost)`, balance.test.ts) — direct contradiction, 300 vs 700 for the same fang.
  - Config bounty/gold numbers UNCHANGED since a041237 (`git diff` shows only OT/surge knobs); per-minute lane income is UP at HEAD vs baseline (365 vs 254 g/min) while wealth-at-10 is DOWN → leak between earning and measuring, not an income regression.
  - Timing: gold GREEN at a041237 (all matches ≥ 2518), RED at HEAD (3 matches 1975–2133); the window holds exactly the three item-system commits (83ccf51 recipes, db2e803 tiers, 423e59b review). 83ccf51's message claims "5 failures, already red on main" while a041237 had 4 — the count moved without that being noticed.
- **Verdict**: PENDING (extended dump run)
- **Rationale**: mechanism fully traced in code; awaiting the true-vs-measured observation to close the proof.

#### H-X1: level-6-fast because hero-kill XP (~15%) stacks on model-rate farm; model and band budget zero kills
- **Layer**: config-env (numbers/model truth — fix would be design-level)
- **Prediction**: pre-6 xp-by-source at 2v2 shows heroKill ≈ 10–20% with lane/camp at model rates (~269 xp/min); removing kill XP from the timeline restores ≥ 6.0. If pre-6 heroKill ≈ 0 → REJECTED.
- **Verification method**: same extended dump run (per-hero split snapshot at level6Tick).
- **Evidence**:
  - Design model (config.ts:170-186): reference laner 269 xp/min → level 6 (1750 xp) at 6.5 min + walk ≈ 6.8 min — with NO kill-XP term anywhere in the derivation.
  - Observed 2v2: 5.46 min ⇒ ~320 xp/min. Full-match heroKill share 13–15% ⇒ ~45 kill-xp/min over 275 farm ≈ model rate. The excess over the model is exactly kill-sized.
  - History: T13 tuning (2b5ab65) set the ladder observing churned bots; a041237 proved churned-vs-unperturbed matches diverge 9/9 — the 6.0 floor was tuned to apparatus-perturbed measurements.
- **Verdict**: PENDING (extended dump run)

#### H-X2 (alternative): 2v2 farm itself overpays — uptime/sharing/overlap assumptions violated
- **Layer**: code-logic/behavior
- **Prediction**: pre-6 lane+camp XP/min/hero >> 269 with SMALL heroKill share. Same dump discriminates H-X1 vs H-X2 by source shares.
- **Verification method**: same extended dump run.
- **Evidence**: circumstantial only — 2v2 packs 4 heroes onto 1 lane (LANES_FOR_TEAM_SIZE[2] = 1) plus nearby camps, a geometry the two-sharer model never describes. Against: a041237 REFUTED lane/camp XP overlap at 2v2 (0.0% measured).
- **Verdict**: PENDING (extended dump run)

#### H-D1: duration/tiebreak is weak OT close after de-lethalization (the deferred tuning task)
- **Layer**: code-logic/config tuning
- **Prediction**: tiebreak matches never seriously threaten the ancient (low structure damage relative to hero damage at end; late towers stand); ancient kills land 10–15 min after OT ramped. A volume-strengthening experiment that does NOT move duration/tiebreaks would REJECT this (→ behavior stall, H-D2).
- **Verification method**: extended dump (per-team end goldEarned/heroDamage/structureDamage — already in hand via end.stats) to confirm the stall shape; then ONE tuning experiment on the volume lever.
- **Evidence**:
  - 761bdf1's message: "median … 24.85 min …, 5/15 tiebreak. The retroactive surge was ending games by brute force; removing it reveals that the intended pacing does not close matches on its own. That is a balance-tuning task, not a bug fix."
  - 423e59b's volume pass moved the median to 20.70 but tiebreaks sit at 6/15 — same failure class, partially addressed.
  - 4v4 = 4/5 tiebreak@30 with towers falling on schedule (5–6 min) — mid-game progresses, the CLOSE fails.
- **Verdict**: PENDING (extended dump run + tuning experiment)

#### H-D2 (alternative): stall is behavioral — bots fight but don't press/siege
- **Layer**: behavior (T13's own anticipated alternative: "a stall whose cause is bot BEHAVIOUR (not numbers)")
- **Prediction**: tiebreak matches show HIGH hero damage with LOW structure damage and roughly even end-game gold (even trade, no conversion). Same end-stats dump discriminates H-D1 vs H-D2.
- **Verification method**: same extended dump run.
- **Evidence**: circumstantial — S_BOTS (fe18fa9) rewrote bot brains between green and the rewrite; winner one-sidedness within sizes at HEAD (2v2 all team-0, 4v4 all team-1) hints at systematic rather than emergent outcomes. Against: T13's disengage rule ("kills the even-skill feeding-collapse") still ships.
- **Verdict**: PENDING (extended dump run)

## 5 Whys (gold thread; level/duration Whys follow the dump)
Symptom:  gold10 band fails 3/15 matches, marginally (1975–2133 vs 2200 floor).
Why 1?    Because measured wealth understates true wealth once bots hold fused items (H-G1, verifying).
Why 2?    Because the harness's ITEM_COST predates recipes (top-level == full price then), and three item-system commits never updated the valuation.
Why 3?    Because no test pins "harness wealth == true wealth" — the attribution check covers XP reconstruction (0.00%), but gold has no equivalent self-check; the harness trusts its own measure.
Why 4?    Same architectural root as the surge log: verification is advisory and suites ship red (83ccf51: "5 failures, already red on main").
Why 5?    No mechanism distinguishes accepted-red from new-red per test: a041237 had 4 balance failures, 83ccf51 reported 5 as "already red" — the count moved without anyone verifying WHICH tests failed. Belief without verification.

## Falsification (extended dump run 2026-09-27, temp instrumentation — see Fix section for revert plan)
- H-G1: TRUE gold10 medians 2680–3657 (ALL in-band) vs measured 1975–2694 (3 fail); fused10 counts 7–31/match; gaps (+705 to +1050 on failing medians) match combine-destruction arithmetic. TRUE wealth in-band FALSIFIES "real income shortfall". H-G1 PROVEN (fix-verification run pending).
- H-X1 vs H-X2: pre-6 heroKill share 9–20% (2v2: 11–20%) with lane+camp at ~model rates (2v2 farm 280/min vs model 269; the ~20% excess over the model is kill-sized). Farm does NOT overpay → H-X2 REJECTED. Kill XP stacks on model-rate farm → H-X1 PROVEN as the mechanism; the FIX question (threshold vs award vs band) is a design decision — see Fix section.
- H-D1 vs H-D2: INCONCLUSIVE from this run — temp instrumentation bug (mine): `end.stats[].id` are seat ids, not ent ids, so the `byId` team lookup missed and all end damage/earn accumulated under team 0 (`endT1` zeros). TOTALS remain valid: tiebreak matches run ~10:1 hero:structure damage vs 2.5:1 for the fast closer — consistent with fight-not-push stalls, but team-split and tower-timeline data were lost. Re-instrumenting (correct team link + full tower-fall timeline) in the verification run.
- Kill volume magnitude: 6–10 kills/2v2 (~20 min), 19–21/4v4 (~28 min), 22–39/8v8 — ~0.09 kills/hero/min uniformly; NOT a feeding bloodbath. The disengage rule holds; kill XP is normal-trickle, unbudgeted-in-model trickle.
- Winners within sizes one-sided (2v2 all team-0, 4v4 all team-1) while the aggregate mirror test passes — noted, not a failing band, not pursued further here.

## Run B results (TEMP close experiment: guards 1100→550, ancient 1700→850 — REVERTED after)
- Tiebreaks 6/15 → 4/15 (bed4/bed5 converted at 21.92/29.14); median ROSE 20.70 → 21.02 (converting slow tiebreaks ADDS slow ancient samples — the metric punishes slow conversions). 4 winners flipped; ace4 SLOWED 15.68 → 22.73 (chaotic sensitivity to structure hp, expected in a deterministic-but-sensitive sim).
- Persisting tiebreaks: ancients at 100%/100% (bed1: 10 alternating falls through 29.8, one guard/side down) or 73% after ~2 min exposed (bed2: ~4 dps average on the exposed ancient — attackers rarely engage it).
- Divergence IDENTICAL to Run A (ace2 45.2% to 16 digits) — pre-10:00 game provably unaffected by post-10:00 structural changes. Full TRUE-gap distribution: 2v2 24.9–45.2% (TWO over 40: ace2/ace3, both clean — no pre-10 guard falls), 4v4/8v8 all ≤16.2%. Divergence is a 2v2 small-team-variance phenomenon.
- H-D1 verdict: SUPPORTED-but-insufficient — numbers move the close (6→4), but halving the entire base only converts slowly; the median needs FAST conversions (≤18), not slow grinds. H-D2 not rejected (bed2's trickle). Fountain heals mobiles ONLY (units.ts:271-286) — no immortal-ancient math; ancients take permanent damage.
- Decision: test the PRACTICAL fix vector (OT volume within documented perf/design constraints) before concluding behavioral. Volume acts through creep structure damage (fortify hits heroes only — world.ts:523), so it grinds even when heroes don't commit.

## Run C plan (TEMP OT volume dose — PENDING RUN)
- Dose: EXTRA_MELEE 180/MAX2 → 120/MAX3, STEP 4→5; MIN 18, growth 0.05, OT 660 UNTOUCHED (perf floor, no-lethality design, pre-11 metric purity all preserved).
- Predictions: tiebreaks 6 → 3–5; median 20.7 → ~18.5–20; pre-11 metrics IDENTICAL to Run A (gold10/level6/tower1/div10/fused10/pre6xp); p95 < 2ms isolated (else dose unusable); fastest match ≥ 12.
- If tiebreaks don't move → volume-within-budget INSUFFICIENT → escalate (behavioral close work or design-level sudden-death/base-fragility decision) with this evidence rather than burning more iterations.

## Run C resolution (measured 2026-09-27, second session — REVERTED)
- The TEMP dose was found still applied in `config.ts` with no recorded run. Measured A/B (15 seeded matches each, R1 bot policy both arms): WITH dose median 21.16 / 2 tiebreaks; WITHOUT (clean config) median 20.96 / 0 tiebreaks. The dose does not help; if anything it hurts (extra symmetric volume feeds defender farm and lengthens clashes). REVERTED to committed values (STEP 4, MAX 2, PERIOD 180). Do not re-apply without new evidence.
- All Run D numbers below are on CLEAN config unless noted.

## Run D results (behavioral close work, H-D2 — LANDED in `bots.ts`)
Mechanism chain, each step measured with a TEMP headless probe (15 seeded matches per experiment, deleted after):
1. Bed3 stall anatomy (control): red ancient exposed 22.6, first damage 22.98, then UNTOUCHED to the 30:00 cap — zero blue heroes within 20 m and zero blue creeps within 12 m for ~6 straight minutes while all 8 heroes fought mid-map. The sim has no objective logic: bots lane/last-hit/jungle/fight-nearby, nothing walks at structures. Heroes dealt ~5k of ~35k damage to structures.
2. R1 (LANDED): `siegeTarget` (explicit attack on unfortified structures in reach; Fortify bar kept) + `pushTarget` ladder (exposed ancient → open-lane guard; healthy bots only, 0.60 bar). Conversion is instant once exposed (guards fall → kill within ~1 min). Result: tiebreaks 6/15 → 0/15, median 20.70 → 20.96 (Run-B effect: slow conversions join the pool).
3. Six follow-up levers, ALL REVERTED after measuring harm or no gain (each 15-seed A/B):
   - siege courage (skip the outnumbered abort with wave cover): slowed T1 5.4→7.9, lost conversions. Overtime-only variant: median 21.50, one 28.4 blowup. The abort carries team reset rhythm; it is load-bearing.
   - guard/ancient dive (ignore Fortify when pushing): 8v8s fell to ~11–13 min but 4v4 broke (3 tiebreaks + a 29-min kill; a 12-min exposed-ancient stall). Diving desyncs exposure from waves — the hold's wave-sync is load-bearing.
   - overtime jungle cut: 2v2 improved but 4v4 collapsed (28s + 2 tiebreaks). Heroes in lane clear waves (parity); jungle absence lets waves through. Load-bearing.
   - overtime tower rung for the push: median flat, +2 tiebreaks, slower 8v8s. Walking at towers dissipates force across lanes; concentration (1–2 shared targets) is what converts.
   - wipe-window latch release (push at ≥0.40): median 20.07 but 4v4 deaths doubled and 2 tiebreaks. The latch is load-bearing anti-feed.
   - focus fire (explicit attack on lowest-hp defender): median 22.48, a 62/60-death tiebreak. Explicit attacks chase fleeing defenders past the objective (movement `attack` has no leash); auto-acquire's leash is the safety.
4. Siege pre-11 gate (LANDED as part of R1): ungated siege fired from wave one → T1s at 3.3 min (floor 5.0) and, worse, first tower ALWAYS team-1's (15/15), which the push amplified into 12–3 winners (band ≤55%). Gating siege on pushing-or-overtime restored tower1 (GREEN), winners 7:8 (GREEN), tiebreaks 3/15 (GREEN, at the limit). Pre-11 behavior is now baseline-identical except rare early-push states.
5. Standing failures after Run D (suite 15/17, rift tree 1036/1038, typecheck clean):
   - Duration median 21.02 vs 12–18. STRUCTURAL, not behavioral: kills are BIMODAL (~13–14 min 8v8 cascades vs 19–27 min grinds, nothing at 15–18). The §9 model assumption "overtime volume overwhelms defences within ~7 min" is falsified — symmetric escalation preserves parity by construction. Six behavior levers + Run B (halved base HP) + Run C all failed to move the median below ~20.7. RECOMMENDATION: re-derive the band from the honest engine (amendment-grade decision, needs design authority — NOT applied here), or accept red with this evidence.
   - Non-degeneracy 4/5 in 4v4 (bed4 ≡ bed5, bit-identical tiebreaks). LOTTERY, not mechanism: identical states + rng-free policy ⇒ identical orders forever; the pair can only be split by an rng read that flips (p-hacking the sample by redrawing policies until no pair collides is worse than the red). Documented, not fixed. Any future behavior change redraws this lottery — re-check the band after every `bots.ts` edit.

## Run A results (gold fix + level amendment applied; temp tower-timeline + team splits added)
- Gold band GREEN (H-G1 fix verified); level-6 GREEN (amendment verified); trajectories bit-identical to pre-fix run (durations/winners/tower1/kills/fused counts all match) — both fixes measurement-only, zero sim effect. H-G1 CLOSED.
- Duration + tiebreak still red (expected — tuning pending). Tiebreak timelines: teams trade towers evenly all game (bed1: 10 falls alternating sides through 29.8) with BOTH ancients at 100% at cap — parity never breaks; ancient-kill matches show a 10-minute mid-game stall (ace1: last outer fall 7.1 → guards 20.7) before OT volume finally breaks through.
- NEW failure surfaced by honest measurement: team-gold-divergence 45.2% in 2v2 ace2 (fee-valuation had compressed it under 40%). New child hypothesis:
#### H-V1: the 40% divergence threshold was tuned to fee-compressed measurements; true-wealth gaps run hotter
- **Layer**: observation (threshold calibration — child of H-G1's fix)
- **Prediction**: the 45.2% ace2 gap is REAL earned wealth (consistent with its full-match +43% earn gap and win); other matches' true gaps cluster below it. If the full true-gap distribution shows MANY matches near/over 40% → the threshold shape itself needs design review, not just recalibration.
- **Verification method**: print all 15 true divergences in Run B (the close experiment cannot plausibly move 10:00 wealth — earliest guard fall in any dump is 10.4, so guard-hp changes land post-sample; noted confound if a guard crosses 10:00).
- **Evidence**: ace2 endT0 earn 14614 vs endT1 10232 (+43%, matches the 45.2% at-10:00 gap direction and magnitude); team 0 won; under total valuation spending is wealth-neutral so the gap can only be earned income (+wards/deaths), not a spending artifact.
- **Verdict**: PENDING (Run B prints + amendment decision)

## Root Cause
PENDING.

## Fix
PENDING.

## Resolution
PENDING.
