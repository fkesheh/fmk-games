# DESIGN DELTA — ANCIENTS (rift): real terrain

**Status: FROZEN.** The design intent for the terrain/jungle gameplay pass. Every config number
added in this pass must be checkable against a target stated here. Balance is expressed as
**relationships and targets**, never as bare constants — a reviewer's job is to check the wired
numbers produce these relationships, and a number that cannot be traced to a target here is a
finding.

Everything in the existing design (lanes, waves, towers, the fortify rule, the match arc, the
tiebreak ladder) is unchanged. This document adds five features and nothing else.

---

## Why this pass exists

The map is currently a flat plane with lanes painted on it. Every fight happens on identical ground,
so position means nothing beyond range. The five features below exist to make **where you stand** a
decision, which is the thing that separates a MOBA from a lane-brawler — and, not incidentally, the
thing that makes the map worth looking at.

Design pillar for the pass: **terrain should create decisions, not chores.** Anything that adds
travel time without adding a choice is cut.

---

## 1. Elevation and cliffs

The map has exactly **two walkable heights** — low ground and high ground — separated by
**impassable cliffs**. Two levels, not a continuous heightfield: a player must be able to tell which
level they are on at a glance, and a continuous slope makes the vision and miss-chance rules
unreadable. The visual terrain may undulate for looks, but the *gameplay* height at any point is one
of two values.

Layout intent:
- Each team's **base sits on high ground**, so the last defensive stand is always uphill. This is
  what makes a 4th-tower defence winnable and stops snowballed games from ending on first contact.
- **Lanes run on low ground.** Lanes stay clean, readable arenas — elevation must never make last
  hitting fiddly.
- The **jungle between lanes carries the high-ground plateaus and the cliffs**, so moving through the
  jungle is where elevation is felt.
- Cliffs are impassable to everything, which means they also shape pathing: the jungle becomes a
  network of routes rather than open field. **Every camp must remain reachable, and no walkable
  region may be sealed off** — this is a hard validation, not an aspiration.

Gameplay rules:
- **Vision does not travel uphill.** A unit on low ground cannot see units or terrain on high ground
  (beyond a very short lip). A unit on high ground sees down freely. This is the single most
  important rule in the pass: it is what makes high ground worth taking and what makes walking into
  an unscouted jungle frightening.
- **Attacks uphill miss 25% of the time.** Attacker on lower ground than target ⇒ 25% of basic
  attacks deal no damage. Abilities are unaffected — this keeps the rule simple to read and stops it
  from silently rewriting every hero's kit.

Balance targets:
- A tower dive onto high ground before level 6 should be a **losing play** for an even-strength duo,
  and a viable one after. If diving high ground at level 4 is profitable, the miss chance or the
  fountain/tower numbers are wrong.
- Holding high ground should be worth roughly **one hero level** of effective strength in a fight —
  significant, but not so large that a behind team can never contest.

---

## 2. Jungle camps

Neutral creep camps in the jungle, mirrored exactly between the two halves.

- **Camp count scales with the map**: 2 camps per team half at 1 lane, 3 at 2 lanes, 4 at 3 lanes.
  Symmetric by construction, like every other structure.
- **Three tiers**, each with a distinct beast archetype (see the style bible §7): `campPack` (small,
  several weak quadrupeds), `campBrute` (medium, one heavy melee brute plus escorts), `campHive`
  (large, a ranged swarm). Each half gets one of each tier where the count allows.
- Camps are **neutral**: hostile to both teams, owned by neither, and they **never push a lane**.
  They aggro within a short radius and **leash back** to their camp, healing fully, if pulled beyond
  it. A camp that can be dragged into a lane is a bug, not a strategy.
- Camps **respawn on a fixed timer** measured from the moment the last creep in that camp dies.
  Respawn is long enough that camp timing is worth tracking (this is a skill expression we want) and
  short enough that a jungler is never idle.

Balance targets — the key relationship in this pass:
- **Jungling is a gold-tempo choice, not a strict upgrade.** A hero farming camps continuously from
  the start should reach **level 6 at roughly the same time** as a hero farming a lane (~6–7 minutes),
  but with **more gold and less experience**. If jungling wins on both axes, the camp bounties or xp
  are wrong and the lanes will empty out.
- **The large camp must be genuinely dangerous solo before level 6** — attemptable by most heroes at
  6, comfortable at 8. A large camp that a level-3 hero clears without risk is worthless as a
  decision.
- **Total jungle income per half must be below total lane income per half**, so contesting lanes
  stays the primary game and the jungle stays the supplement.
- A camp cleared the instant it respawns, forever, should yield **less** than the passive+lane income
  of a competent laner — jungling is a trade of safety and tempo, not free money.

---

## 3. Concealment

**Jungle foliage blocks vision.** A unit standing in a marked foliage cell is not visible to enemies
outside it unless the enemy is adjacent or has vision from a ward, a nearby ally, or high ground
looking down. Concealed units can still be seen while attacking.

This exists for one reason: it makes **ganking** possible, which is what makes lane position tense
and what makes wards worth their gold. Wards already exist in the build and currently do very little;
concealment is what gives them a job.

Balance target: a hero should be able to cross from jungle to lane and reach a target before the
target can reliably react — but a warded lane should give the target enough warning to escape. If
wards do not measurably reduce successful ganks, concealment is too strong or ward vision too weak.

---

## 4. The river

A shallow river runs the anti-diagonal across the map centre, perpendicular to the base-to-base line.

It is deliberately **not a mechanic**. It is the map's central landmark and its main chokepoint: it
sits on the lowest ground, it is where the jungle routes converge, and it is the natural boundary
between the two halves. No movement modifier, no rune spawns, no vision rule of its own.

The reasoning: the river's value is navigational and visual. Every extra rule attached to it would
add a chore rather than a decision, and the pass is already carrying elevation, camps and
concealment. It earns its place by making the map **legible and beautiful** — players say "mid
river" and mean somewhere specific.

---

## 5. Day / night

The match cycles between day and night on a fixed period, starting at day.

- **Night reduces vision radius** for heroes and creeps by roughly a quarter. Structures and wards
  are unaffected — they are lit.
- Nothing else changes mechanically.

This is a small rule with a large effect on both feel and looks: it makes the map periodically
dangerous, it rewards ward placement before nightfall, and it gives the renderer its second lighting
state — the one where a dark world lit by team colors, braziers and ability FX is at its strongest.

Balance target: night should make junglers and roamers **more** confident and laners **less** — a
visible swing in initiative, not a blackout. If players simply stop playing at night, the vision
penalty is too large.

---

## What this pass does NOT add

Stated explicitly so implementers do not helpfully invent them: no runes, no roshan/boss objective,
no couriers, no denying, no teleport scrolls, no ward-vision-blocking trees, no destructible terrain,
no third team, no new heroes, no new items, no changes to the existing wave, tower, fortify, gold,
xp or match-arc numbers.
