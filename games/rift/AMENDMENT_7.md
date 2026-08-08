# Contract amendment 7 — final rulings

Authority level 2. Read `AMENDMENT_1`–`6` first.

---

## A. A structure's miss is broadcast to both teams

**The gap** (found by S_ROOM, correctly not resolved by it). `stepCombat` calls `fire()` for
towers and guards, so a tower shooting uphill can lose the roll and emit
`{ k: 'miss', attacker: <structure id> }`. But `computeTeamVisible` **never puts a structure id
in a vision set** — structures are sent to everyone every tick instead. `protocol.ts` freezes the
`rift_miss` filter as "exactly like `rift_cast`", and casters are always mobiles, so this case was
simply never considered. Result: a tower's miss is filtered out for *both* teams and R_HUD's MISS
float can never fire for tower shots.

**Ruling.** If the attacker is a structure, the miss goes to **both teams, unfiltered**.
Structures are already public knowledge — their position, team and hp are on every snapshot for
everyone — so withholding only the fact that one missed leaks nothing and hides feedback the
player needs. A tower missing you because you are on high ground is exactly the moment the
mechanic should be legible.

Mobile attackers keep the existing vision filter on the attacker id.

## B. R_SCENE's `SHADOW_PAD` refutation is ACCEPTED

I assigned "SHADOW_PAD = 12 against a 26.3 m shadow, so tower and ancient shadows pop at the
frame edge" as a blocking defect. R_SCENE **refuted it with measurement rather than complying**,
and it is right.

In the light's orthographic basis a caster's silhouette and its shadow share the same
(right, up) coordinates, so shadow *length* never needs lateral pad. It walked a 14 m caster to
2/5/8/12/16/20/26/34 m behind the near edge and `renderer.info` shows the caster drawn into the
shadow map at every distance, at both camH 36 (74 m fitted radius) and camH 11 (32 m). Nothing
clips. The shadow's visible extent matches the projection arithmetic exactly at both day and
night sun angles.

Raising the pad to 27+ would have cost real texel density (74 → 89 m radius, 3.61 → 4.34 cm
texels) for no measured gain. The pad is now derived from what it actually absorbs — fit error
plus the ancient's silhouette half-width — and the comment that asserted the false model is
fixed.

**The defect was mine, not the module's.** Recorded because an agent that measures and pushes
back is doing the job correctly, and the record should say so.

## C. The balance baseline has moved — S_BALANCE's target is 4 failures, not 2

`STATUS.md` documents 2 `balance.test.ts` failures. After S_JUNGLE, S_WORLD, S_ROOM and S_BOTS
landed, the set is **4 and different**: median match duration, tiebreak/draw rate, level-6 timing
and tick p95 now fail, while `team gold divergence` — one of the original two — now passes.

S_ROOM A/B'd this properly: it reverted its own two files, re-ran `balance.test.ts` alone, got an
identical 4 failures, and restored. So the change is not S_ROOM's; it is the accumulated effect
of the jungle economy plus the new bot behaviour.

S_BALANCE re-baselines against the **current** tree, and must not weaken determinism to do it: if
identical seeds stop producing identical matches, that is a real defect, not a threshold.

## D. Standing note on test-honesty findings

Three separate agents have now found that one of their *own* tests could not fail, and fixed it
rather than reporting it away:

- S_JUNGLE — a leash test that dragged the member outside the disc, so the rule under test never ran
- S_WORLD — deleting `stepCamps` from the tick loop left **four** test files green
- S_ROOM — a percept test comparing a shared array against itself, and a "RED" that was a 5000 ms
  timeout rather than an assertion

That last one is worth naming: **a timeout is not a red.** A mutation that appears to fail because
the test hung has proved nothing, and the same test would be flaky on a loaded machine. Any
mutation matrix entry whose evidence is a timeout must be re-run with an explicit budget before it
counts.
