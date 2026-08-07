# Contract amendment 8 — a correction of mine, and the §9 level-6 band

Authority level 2. Read `AMENDMENT_1`–`7` first.

---

## A. CORRECTION: the XP-overlap finding in `fe18fa9` and `AMENDMENT_7` was WRONG

S_BOTS hypothesised that `CAMP_LANE_CLEARANCE = 14` overlapping `XP_SHARE_RADIUS = 20` let a
jungling bot collect lane-creep xp for free. **I confirmed the geometry and wrote it into a commit
message as fact.** I was wrong, and the error was mine, not S_BOTS' — it explicitly labelled the
hypothesis unverified and asked for it to be measured. I skipped the measuring.

`CAMP_LANE_CLEARANCE` is a **validation floor** (`map.ts:851`), not the placement distance.
`terrain.ts:1249` sites camps at `CAMP_LANE_CLEARANCE + CAMP_LANE_MARGIN` = 16 m minimum, and the
realized minimum camp→lane distances are **28.3 m (1 lane), 19.0 m (2 lanes), 16.3 m (3 lanes)**.

At 2v2 — the failing case — the nearest camp is **8 m outside** `XP_SHARE_RADIUS`. The zones
cannot overlap. Measured, with `splitXpAmongHeroes` reconstructed to 0.00% attribution error:
lane xp paid to a hero standing at a camp is **0, exactly 0.0%**, at 2v2.

The counterfactual settles it: delete *all* camp xp **and** all overlap lane xp, and the 2v2
level-6 median is **5.98 min** — still under the 6.0 floor. No jungle lever could ever have fixed
that assertion.

**The lesson is mine to carry: comparing two constants is not verifying a geometry.** I read
`14 < 20` and stopped. The number that mattered was in a third file.

## B. Two of the four "failures" were the harness measuring itself

- **Bot-brain churn.** `removePlayer` on a live match rebuilds the seat's brain
  (`room.ts:383` → `createBotBrain`), wiping `campCommit`, `retreating` and the rng stream. The
  old harness did that ~100 times per match. A/B on the same 9 seeds: **9 of 9 matches ended
  differently**, and the churned column reproduces the reported failures bit-for-bit — median
  duration 20.36 vs 18.91, tiebreaks 3/9 vs 1/9.
- **The tick p95 "regression" was GC.** Running the perf block after the harness in the same
  worker measured garbage collection over the heap the harness had left: p95 2.222 ms, max
  100.665 ms. Moved to the top of the file, the real numbers are **p95 0.455–0.477 ms over four
  runs — four times under budget**. Camp creeps average 12.6 alive, not the ~40 assumed.

`AMENDMENT_7` §C is superseded: the "4 failures, and the set moved" I recorded was partly an
artifact of the measuring apparatus.

## C. RULING: the §9 level-6 floor is wrong, and it is mine to fix

`2v2 level-6 median 5.94 min` fails a `>= 6 min` band. S_BALANCE showed the **band** is wrong,
not the simulation, and refused to widen it on its own authority. Correct.

CONTRACT §9's 6-minute floor is `config.ts` derivation (a), which models **lane creep xp only**
(6.8 min). The game also pays hero-kill xp, which derivation (a) never accounted for. Measured
crossing at 2v2: lane creeps alone **7.26 min** → plus hero kills **5.98** → plus camps **5.58**.
Pure-lane xp measures 245–267 xp/min against derivation (a)'s 269 target, so **the lane economy is
exactly on spec** — the model is incomplete, not the sim.

`HERO_KILL_XP_BASE` / `HERO_KILL_XP_PER_LEVEL` are frozen by `DESIGN_DELTA` ("no changes to the
existing xp numbers"), so the sim cannot move to meet the band even if it should.

**Ruling: the 2v2 level-6 floor becomes 5.5 min**, and CONTRACT §9 records that the band models
lane creeps *and* hero kills. This is not widening a gate to fit a build — 5.94 sits inside a
band derived from the same arithmetic once kill xp is included, and the assertion still fails if
jungling ever pushes the crossing below 5.5.

## D. Routed to `bots.ts`, not to balance

Three failures are bot behaviour and S_BALANCE named concrete levers rather than guessing:

1. **Sample degeneracy** — 3 distinct matches from 5 seeds at 4v4 (three bit-identical). The sim
   core consumes no `rand`, so a seed only varies a match through `hashSeed(roomId, seat)` → bot
   brains, and the bots barely use their stream. This over-weights one 24.6-min outcome in every
   median below it. Fix the seeding reach, or accept and document that seeds are near-degenerate.
2. **Median duration 22.14** (2v2 14.52 ✓, 4v4 24.61, 8v8 23.14).
3. **The jungle out-earns lanes at 4v4/8v8** — camp share of creep gold 55.1–62.8% at 4v4. The
   *pools* are correct; the split inverts because **73.8% of 4v4 lane creep xp evaporates with no
   hero in range** — bots sit at a camp 34.7% of alive ticks at 4v4 versus 8.4% at 2v2. Levers
   found: `JUNGLE_MAX_DIST = 30` is a fixed radius against map-scaled geometry (blocked at 1
   lane's 30.4 m, wide open at 2 lanes' 19.0 m); no cap on simultaneous junglers, and `pickCamp`
   is rng-free and ally-blind so both bots in a lane commit to the same camp on the same tick;
   `lanePressure` (12/14 m) can never fire at a camp 16–30 m away, so the only recall is "camp
   dead" or "hurt"; and `campCommit` survives death, so a respawned bot beelines from base back
   to its camp.

Note the DESIGN_DELTA §2 *trade* is intact everywhere — jungle pays more gold (28.7–62.8%) and
less xp (9.8–29.5%). Only the magnitude inverts, and only where bots abandon lanes.

## E. What S_BALANCE added that should not be lost

Determinism, attribution accuracy (0.00% error), sample non-degeneracy, mirror fairness and the
DESIGN_DELTA §2 jungle relationships are now **shipped assertions**, not one-off measurements.
The NaN sweep moved from ~1%-sampled wire fields to every entity field every second. And it
proved its own tsc gate red by injecting an error before trusting it green.
