---
type: investigation
symptom: "balance: 4v4 seeds 0xbed4/0xbed5 play bit-identical 30-min tiebreaks (4 distinct of 5)"
slug: rift-balance-seed-collapse
date: 2026-10-01T22:24:14-0300
investigator: Foad Kesheh
git_commit: 72497e0
branch: assets-trees-v2
repository: fps
status: root-cause-proven
hypotheses_formed: 4
hypotheses_rejected: 3
hypotheses_proven: 1
related:
  - docs/investigations/2026-10-01-rift-flood-flap-storm.md
---

# 4v4 seed pair collapses: the sim's only seed channel is a ±15% last-hit wobble that never flips

## Symptom
- **Observed**: `balance.test.ts` "the sample is not degenerate" fails —
  `4v4: 5 seeds produced only 4 distinct matches: expected 4 to be 5`.
- **Expected**: all 5 seeds per team size produce distinct trajectory hashes.
- **Delta**: seeds 0xbed4 and 0xbed5 agree on EVERYTHING (end, winner, tower1,
  lvl6, gold10, divergence, xp splits, hash) — one trajectory, two seeds.

## Reproduction
1. `npx vitest run games/rift/server/src/balance.test.ts` (deterministic: fixed seeds).
2. Observe the FAIL line + the per-match report rows below.
   ```
   4v4 0xbed4 lanes=2 end=tiebreak@30.0min win=0 tower1=5.3 lvl6med=9.3(miss 0) gold10med=2735 div=12.9% | xp lane/camp/kill 67/9/24% | jungle share of creep gold 36.6% xp 11.8% | hash=3a398479 nan=0 anom=0
   4v4 0xbed5 lanes=2 end=tiebreak@30.0min win=0 tower1=5.3 lvl6med=9.3(miss 0) gold10med=2735 div=12.9% | xp lane/camp/kill 67/9/24% | jungle share of creep gold 36.6% xp 11.8% | hash=3a398479 nan=0 anom=0
   ```
   Verified: 2026-10-01 — reproduced on every run (deterministic seeds).

## Hypotheses

#### H1: the two matches played identically because no seed-influenced decision ever differed
- **Layer**: state-data
- **Prediction**: If H1 is true, the pair agrees on endTick-level stats (not just the
  hash), and code inspection shows exactly one narrow seed channel that can plausibly
  go 30 min without flipping.
- **Verification method**: read seed plumbing (room/world/bots) + compare the two report rows.
- **Evidence**:
  ```
  games/rift/server/src/sim/world.ts:1229:   void rand;   // sim core consumes NO randomness (frozen seam)
  games/rift/server/src/room.ts:271:         // Auto-assignment hero cycle (LEAST-picked first at lock, wrapping).  // deterministic draft
  games/rift/server/src/bots.ts:864:         const lethality = self.damage * (1 - LASTHIT_SLOP + 2 * LASTHIT_SLOP * rand());  // the ONLY rand() call in bots.ts
  games/rift/server/src/bots.ts:43:          const LASTHIT_SLOP = 0.15; // seeded +-15% wobble on the last-hit threshold
  ```
  The report rows above agree on all 12 measured stats (end reason, duration, winner,
  tower1, level6, gold, divergence, xp splits, jungle shares, hash) — full-trajectory
  identity, over 30 game-minutes × 8 heroes. Seed enters ONLY via
  `hashSeed(roomId, seat)` → per-brain rng stream → last-hit slop VALUES; when no
  threshold sits within ±15% of a margin all match (typical overkill dwarfs it),
  nothing diverges. (Sibling evidence: 0xbed1 shares tower1/lvl6/gold10 with the pair
  but diverges late — flips are rare, late, and occasionally absent.)
- **Verdict**: PROVEN
- **Rationale**: the rows prove trajectory identity (not hash coincidence), and the
  code proves a single ±15% channel is the only possible differentiator — a channel
  this narrow going 30 min without flipping one pair is expected, not surprising.

#### H2: the trajectories differ but FNV-1a collides on the trajectory hash
- **Layer**: code-logic
- **Prediction**: If H2 is true, the pair differs on endTick/stats while sharing `hash=`.
- **Verification method**: compare the two report rows field by field.
- **Evidence**: the rows are identical in all 12 stats (see H1) — no differing field exists.
- **Verdict**: REJECTED
- **Rationale**: a hash collision preserves differing inputs; here there are no differing
  inputs. (Prior p ≈ 2^-32 per pair also argues against, but the identical rows decide it.)

#### H3: hashSeed(roomId) collides, giving both matches identical bot brains
- **Layer**: code-logic
- **Prediction**: If H3 is true, the two roomIds hash to equal brain seeds for the seats.
- **Verification method**: mechanism analysis (roomId entropy + FNV width + seat count).
- **Evidence**: `hashSeed` is FNV-1a 32-bit over distinct room ids (`randomToken(rng(seed))`
  per room, room.ts:295) × 8 seat indices. Full-trajectory identity via H3 needs ALL 8
  brain seeds to collide simultaneously (any single differing brain whose slop flips
  anything diverges the match): p ≈ 2^-256. H1's mechanism (zero flips from narrow
  slop) explains the same observation without any collision.
- **Verdict**: REJECTED
- **Rationale**: requires a 16-fold simultaneous FNV collision; H1 explains the evidence
  with no collision at all.

#### H4: the test over-asserts — 4-of-5 distinct is not "degenerate"
- **Layer**: observation (test artifact)
- **Prediction**: If H4 is true, no sim-side change is warranted; relax to ≥4.
- **Verification method**: weigh test intent (comment at balance.test.ts:707-716) against sim capability.
- **Evidence**: the test comment frames this as an instrument check against AMENDMENT_6
  (reporting numbers over a degenerate sample). But the sim CAN distinguish seeds —
  the fix below makes the channel structural and the test passes at 5/5 — so the
  strict assertion is achievable and the sample genuinely gains a degree of freedom.
- **Verdict**: REJECTED
- **Rationale**: weakening the assertion would bless luck-dependent variety; the sim-side
  fix proves the strict bar is reachable, so the test stands as written.

## 5 Whys
Symptom:  4v4 seeds 0xbed4/0xbed5 play bit-identical matches.
Why 1?    Because no seed-influenced decision differed in 30 game-minutes (H1).
Why 2?    Because the only seed consumer is a ±15% last-hit wobble (sim voids rand,
          draft cycles, brains have one rand site).
Why 3?    Because variety was assumed to EMERGE from combat thresholds amplifying small
          slop differences — but overkill margins usually exceed ±15%, so amplification
          rarely triggers (and twice, never).
Why 4?    Because no design requirement pins per-seed MACROSCOPIC variety: the
          distinctness test asserts it, but nothing in the sim CONSTRUCTS it.
Why 5?    Because seed influence is INCIDENTAL (a side effect of one wobble constant)
          rather than STRUCTURAL (no seeded setup/strategy layer) — collisions are a
          matter of luck, hence a flaky-looking (but deterministic) red.

## Falsification
- Check performed: absence test — if the slop channel is the ONLY differentiator, matches
  whose slop DOES flip must diverge (they do: 13/15 hashes distinct, and 0xbed1 shares
  early stats with the pair but diverges late), and removing the slop entirely would
  collapse everything (not performed — destructive; the positive evidence suffices).
- Adjacent-cause search: H2 (hash collision) and H3 (brain-seed collision) would produce
  the same 4-of-5 signature; both are rejected above with row-level and probabilistic
  evidence. H1 alone predicts the observed SIBLING pattern (identical early stats +
  rare late divergence), which neither alternative explains.
- Conclusion: hypothesis survived.

## Root Cause
- Immediate cause: seeds 0xbed4/0xbed5 never hit a slop-marginal last-hit in 30 min, so
  their (identically set-up) matches played tick-identically (evidence: identical report
  rows; `bots.ts:864` sole rand site; `world.ts:1229` void rand; `room.ts:271` cycle).
- Architectural root: seed variety is incidental, not structural (5 Whys Why 5).
- Rejected H2: rows identical in all stats — no differing input for a hash to collide on.
- Rejected H3: needs 16 simultaneous FNV collisions; H1 needs none.
- Rejected H4: strict bar is achievable via the fix, so the test stands.

## Fix
- File `games/rift/server/src/bots.ts` — per-brain SEEDED skill-max order (Fisher-Yates
  over q/w/e at creation from the brain's rng stream; ult-first untouched): strategy-layer
  seed variety from the first spent point. Traced to Why 5 (make variety structural).
  Deterministic per seed (stream consumed at creation in fixed order); symmetric across teams (both sides
  draw from the same distribution → mirror/win-rate neutral in expectation).
- Regression test: `games/rift/server/src/bots.test.ts` — different brain seeds yield
  different skill orders; same seed yields the same order (fails before: fixed Q>W>E
  regardless of seed). Plus the balance distinctness test itself (fails before at 4/5).
- Symmetry note: item builds stay role-fixed; only the basic-ability max order varies.
  Every permutation reaches the same endpoint (all maxed ≈ level 9-10).

## Resolution
- FIXED 2026-10-01. `games/rift/server/src/bots.ts`: per-brain seeded skill-max order
  (Fisher-Yates over q/w/e at creation + Q-first bias: force Q front half the time it
  isn't, p(Q-first)=2/3). The uniform shuffle ALSO fixed distinctness but proved too
  chaotic (4v4 tower1 5.3→10+, 8v8 @9.8min stomps breaking the gold@10 sample, wins
  lopsided) — the bias keeps most bots on the known-stable meta while the off-meta
  minority carries seed variety. `pickSkillSlot` iterates the order; ult-first untouched.
- Regression: `bots.test.ts` "different seeds max different slots first" (fails before:
  all first-slots 0; passes after) + determinism + max-exactly guardrails (56/56).
  Balance-suite proof: distinct matches 5/5 in ALL groups (was 4/5 in 4v4),
  determinism test still green (same seed → same order).
- Side effects (measured, attributed): median duration 21.02→19.19 (still red — the
  subject of the companion slow-ancient-kills log); wins re-rolled 8/15→12/15 by the
  fixed-seed lottery (build distributions verified team-symmetric by direct probe:
  2v2 7/1/2 vs 7/0/3, 4v4 17/2/1 vs 15/1/4, 8v8 31/6/3 vs 29/7/4 — no team skew).
