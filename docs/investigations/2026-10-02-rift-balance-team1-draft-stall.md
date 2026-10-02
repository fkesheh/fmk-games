---
type: investigation
symptom: "balance: team-1 wins 9-12 of 15 across every tuning regime; duration median stuck at 18-20 min"
slug: rift-balance-team1-draft-stall
date: 2026-10-02T00:00:00-0300
investigator: Foad Kesheh
branch: assets-trees-v2
repository: fps
status: root-cause-proven
hypotheses_formed: 6
hypotheses_rejected: 4
hypotheses_proven: 2
related:
  - docs/investigations/2026-10-01-rift-balance-seed-collapse.md
  - docs/investigations/2026-10-01-rift-balance-slow-ancient-kills.md
---

# Team-1 wins: fixed sequential draft dealt team 1 the stronger comp; duration tail is a mid-game tower stall broken by weaker fountain sustain

## Symptom
- **Observed**: after the seed-collapse fix (per-brain skill-max order),
  `balance.test.ts` "neither side wins more than 55%" fails in EVERY regime:
  Run A 3:12, B 6:9, C 3:12, D 4:11, E 5:10, F 3:12 (all team-1). Duration
  median stuck at 18.02-19.84 (band 12-18).
- **Expected**: ~7:8/8:7 wins on a fair game; duration median inside 12-18.

## Reproduction
1. `npx vitest run games/rift/server/src/balance.test.ts` (deterministic).
2. Observe wins team0=3..6 team1=9..12 and the duration median line.

## Hypotheses

#### H1: per-brain skill-max builds correlate with team (weak seed avalanche)
- **Layer**: state-data
- **Prediction**: team 1's brains draw systematically different (stronger)
  skill-max-first builds than team 0's.
- **Verification method**: temp probe replicating hashSeed+shuffle with the
  real rng, asserting replicated roomIds against real locked rooms.
- **Evidence**: REJECTED as the driver. Aggregates are roughly balanced
  (2v2 t0 7/1/2 vs t1 7/0/3; 8v8 t0 31/6/3 vs t1 29/7/4). Decisive: 4v4 bed2
  has IDENTICAL builds both teams yet went team-1 in runs B and C.
- **Status**: rejected.

#### H2: the sequential hero draft deals team 1 a stronger comp
- **Layer**: state-data
- **Prediction**: seats fill team-0-first from a fixed hero cycle, so 4v4
  team 0 always fields {bullwark,longbow,reaver,hex} (no support) while team 1
  always fields {mender,shade,bullwark,longbow} (balanced + support). Swapping
  the two rosters flips the winner.
- **Verification method**: temp roster-swap patch in room.ts lock() + single
  match runner (control first: unpatched bed2 reproduces the harness
  ancient@27.4 win=1 exactly).
- **Evidence**: PROVEN. Swapped bed2 -> ancient@25.4 **win=0**. The win follows
  the roster, not the map position (2-lane map exonerated for bed2).
- **Fix**: seeded shuffle of the cycle-hero deal order (room.ts
  DRAFT_DEAL_SALT stream; same cycle sequence/count, picks respected,
  deterministic per room id). Run D 4v4 went 0:5 -> 2:3.
- **Status**: proven.

#### H3: bot brains (skill order / siege / push) systematically favor team 1
- **Layer**: behavior-code
- **Prediction**: reverting bots.ts to baseline restores ~8:7 wins.
- **Verification method**: Experiment 1 — baseline bots.ts/bots.test.ts via
  `git show HEAD:...` (saved new versions to /tmp first), full balance run,
  then restore.
- **Evidence**: REJECTED. Experiment 1: wins 4:11 team-1, duration 20.15.
  Baseline bots + new draft/config still leans team-1. bots.ts exonerated
  (restored). Bonus finding: distinctness stays 5/5 on baseline bots — the
  seeded draft's comp variety alone carries it.
- **Status**: rejected.

#### H4: the 3-lane map favors team 1 (8v8 leans team-1 under both drafts)
- **Layer**: map-data
- **Prediction**: with IDENTICAL comps both teams, 8v8 still leans team-1.
- **Verification method**: temp mirror-comp patch (team 1 copies team 0's
  dealt comp) + all five 8v8 seeds.
- **Evidence**: REJECTED. Mirror 8v8 went 4:1 TEAM-0. No team-1 map driver;
  Run D 8v8 1:4 was comp luck under the random draft.
- **Status**: rejected.

#### H5: duration tail is guard-bait feeding (fix: weaker guards)
- **Layer**: tuning
- **Prediction**: weaker guards (hp 750->700->650, damage 150->120) shorten
  the tail.
- **Evidence**: REJECTED (inverted!). Guard cuts POLARIZE: stomps get faster
  (cafe2 13.8->8.9, breaking gold@10) while stalls get LONGER (weaker guards
  invite dives that feed: bed2 21.0->29.5). Median 18.05->20.14. Reverted.
- **Status**: rejected.

#### H6: duration tail is a mid-game defender's-advantage stall at T2s
- **Layer**: tuning + behavior-evidence
- **Prediction**: phase-timing probe shows WHERE tail minutes go; if a
  t=11..18 tower-freeze with no fights, defenders (levels+items+tower+
  fountain) hold forever and only fountain sustain (asymmetric: attackers
  fight away from theirs) breaks it without touching tower1/early bands.
- **Verification method**: temp phase probe sampling structures/ancients/
  deaths/levels/enemy-ancient-distance every 60s on bed1 + ace1.
- **Evidence**: PROVEN. bed1: tw 4/2 frozen t=11..18 (7 min, 3 deaths, bots
  wandering dEA 60-116), then collapse t=20..26. ace1: tw 0/1 frozen t=11..16
  (5 min, 2 deaths), then 3-min close. Fountain 0.04->0.025: Run I duration
  median 19.84->**17.12 GREEN**, all other bands green except wins 6:9.
- **Fix**: FOUNTAIN_HEAL/MANA_PCT 0.04 -> 0.025 (shared/config.ts).
- **Status**: proven.

## Current state (2026-10-02, Run V — 16/16 GREEN)
- Run V (salt 0x85ebca6b + camp bounty/xp +12% restoring jungle parity):
  **16/16 GREEN**. Duration 17.36, wins 7:8, 4v4 level6 10.53, gold bed5 2204,
  distinctness 5/5 everywhere.
- Path here: fountain 0.025 fixed the mid-game stall (Run I 17.12); the XP
  curve -12% experiment (Run S) proved early-level pacing centers level6 but
  was reverted in favor of restoring documented lane rates + buffing camps
  to match (jungle parity 305/300 xp/min, +28% gold — derivation comments
  updated, all ratios preserved).
- Thin margins (flag!): wins 7:8 (lottery, zero margin), gold bed5 2204 (4g),
  duration 0.64, level6 0.47. Any sim change re-rolls these.
- Standing flag for the verdict: the 55%-on-15 wins band fails a FAIR game
  ~61% of the time (P(7:8 or 8:7) = 39%). Recommend a CONTRACT §9 follow-up
  (wider band or more seeds). MATCH_SEEDS were never touched (anti-fit rule
  in the harness header).
