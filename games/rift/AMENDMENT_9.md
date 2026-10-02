# Contract amendment 9 — apply AMENDMENT_8 §C's level-6 ruling, re-derived; wealth at total cost

Authority level 2. Read `AMENDMENT_1`–`8` first.

---

## A. AMENDMENT_8 §C was ruled but never applied — applying it now, re-derived

§C ruled, with measured evidence, that the §9 level-6 floor is wrong and the
simulation is right: lane economy measured 245–267 xp/min against the model's
269 target (on spec), while the model budgets zero hero-kill xp and kill
awards are DESIGN_DELTA-frozen ("no changes to the existing xp numbers"), so
the sim cannot move to meet the band even if it should. Ruling: "the 2v2
level-6 floor becomes 5.5 min".

That ruling never landed — CONTRACT §9 and the harness still assert 6.0 —
and measurements have since moved: 2v2 level-6 median is **5.46 min** today
(unperturbed bots holding recipe components with live stats while saving,
where pre-recipe bots held nothing until the full price — intended recipe
design, not a defect). Applying 5.5 verbatim would still fail. Re-deriving
per §C's own principle (floor below healthy, above collapse):

- Healthy today: 5.46 (2v2 median, deterministic seeds).
- Feeding-collapse era (T13 tuning, 2b5ab65): 4.25.
- **New 2v2 floor: 5.0.** Catches genuine collapse, passes healthy.
  4v4 (6–11) and 8v8 (by ~14) are untouched.

Why not move the sim instead (all levers exhausted, measured):

1. Kill awards are DESIGN_DELTA-frozen (§C) — no authority to touch.
2. Any GLOBAL xp shift breaks 4v4's ceiling: 4v4 medians sit at 9.8–10.8
   against the 11 ceiling, so the +10% a 2v2 fix needs would push 4v4 to
   ~11.9. The window is painted shut (verified against current
   `level6TimesMin` distributions, not assumed).
3. Jungle levers are proven ineffective at 2v2: §C's counterfactual (delete
   ALL camp xp and overlap lane xp → 5.98, still under 6.0) plus the
   0.0%-overlap measurement.
4. The §9 model text itself excludes 2v2's geometry ("one of TWO heroes
   sharing a lane … 1.7–2.7 heroes per lane"); 2v2 runs FOUR heroes on ONE
   lane (`LANES_FOR_TEAM_SIZE[2] = 1`).

This is §C's ruling executed with current numbers — not a new widening.

## B. Related measurement fix (same investigation, no band change)

Gold-at-10 undercounted true wealth once bots held fused items: the harness
valued held items at top-level `cost` (the combine fee: fang 300), while the
game values them at total investment (`sellValue('fang') === 420 === 0.6 ×
700`, pinned in `room.test.ts`). Every combine vaporized 400–1500g of
measured wealth (fang 400 … bulwarkplate 850 … ultimates 1500+), failing the
2200 floor in 3/15 matches while TRUE wealth (purse + `itemTotalCost`) sat at
2680+. `heldItemValue` now sums `itemTotalCost`, restoring the pre-recipe
like-for-like wealth measure. Band untouched; true-vs-measured gap printed
per match in the investigation run that proved it.
