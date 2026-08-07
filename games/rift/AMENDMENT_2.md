# Contract amendment 2 — rulings from the server fix wave

Authority level 2, same as `AMENDMENT_1.md`. Where this contradicts an older document, this
wins. Read `AMENDMENT_1.md` first; nothing here replaces it.

S_JUNGLE (the merged S_CAMPS + S_MOVE) surfaced five things it correctly refused to decide on
its own. Four are mine to rule on; two of those become S_WORLD's work.

---

## A. Camp members are immovable by the separation pass

**The problem, measured.** `AMENDMENT_1` §A forbids the position clamp, so a leashed member
walks home rather than snapping. That bounds the *chase* at exactly `CAMP_LEASH_RADIUS`, but it
does not bound a *shove*: S_JUNGLE measured a member bulldozed to **31 m** from its clearing by a
hero driven into it at 8 m/s every tick. A camp shoved into a lane is a real exploit — it drags
neutral creeps into a fight they should never be in, and it does it deterministically.

**Ruling.** In the mobile-vs-mobile separation pass, a camp member has **infinite mass**: it does
not move, and the full separation displacement goes to the other party. Heroes and creeps slide
around camp members instead of pushing them.

This is deliberately not a leash carve-out. Making the member immovable removes the failure at
its source, matches how every shipped MOBA treats neutrals (you cannot body-block a camp out of
its own pit), and keeps the leash rule doing exactly one job.

Owner: whoever owns `movement.ts` — currently S_JUNGLE, as a follow-up.

---

## B. Camps reset out of combat

**The problem.** With "heal only on leash-break arrival" plus `hpRegen = 0`, a camp poked from
outside its own reach never resets and can be whittled down for free across several visits.
S_JUNGLE flagged this as the direct consequence of defects 3/4/12 and asked. It is right to ask —
the rule as written is exploitable.

**Ruling.** Add an out-of-combat reset. When a camp has taken no damage for `CAMP_RESET_S` and
all its living members are `idle`, restore every member to full hp and clear `recentDamagers`.

`CAMP_RESET_S = 5`.

This is the standard behaviour and it closes the exploit without touching the leash rule. Note it
subsumes part of the leash restore: a member that walks home and idles will reset anyway after
5 s. Keep the arrival restore as well — it is immediate, which is what makes a broken chase feel
clean rather than laggy.

---

## C. `CAMP_ACQUIRE_MARGIN` is promoted to config

S_JUNGLE introduced a 1 m hysteresis band (acquire at 9 m, retain to 10 m) so `lastHitBy` cannot
re-pull forever at the boundary. That is the correct mechanism, and it is a balance-visible
number, so it does not belong as a module-local constant. It is now `CAMP_ACQUIRE_MARGIN` in
`shared/src/config.ts`, derived from `CAMP_LEASH_RADIUS`.

---

## D. S_WORLD obligations — added to its spec

Two defects S_JUNGLE found are S_WORLD's, and it correctly declined to work around either.

1. **`makeEnt` never initialises `path` / `pathIndex`.** They read `undefined`, not `null` / `0`,
   until movement first writes them. Every consumer currently has to coalesce (`?? null`,
   `?? 0`). This is also a live typecheck error in `world.ts`. Initialise them at construction;
   do not push the coalescing onto callers.

2. **`mobileTuning()` has no camp cases**, so every camp member gets the default `radius = 0.3`
   instead of the tuned 0.38 / 0.70 / 0.40. `Ent.radius` is `readonly` and set in `makeEnt`, so
   `applyCampStats` cannot correct it afterwards — it has to be right at construction. Until this
   lands, **combat reach and separation are wrong for brutes**. Add `campPack` → `CAMP_PACK`,
   `campBrute` → `CAMP_BRUTE`, `campHive` → `CAMP_HIVE`.

3. **The two `world.test.ts` failures are S_WORLD's to fix**, and they are correct failures, not
   regressions: `dash covers the distance … clamps to map bounds` and `clamps orders to the map
   bounds` both target `(0, 0)`, which is a **cliff cell** at 1, 2 and 3 lanes, so the hero now
   legitimately stops at ~4.02 instead of 0. Per `AMENDMENT_1` §C, `World.order` snaps its
   destination to the nearest passable cell — update both tests to match, and add one that pins
   the snapping behaviour itself.

4. `SimWorld` must expose `readonly camps: CampState[]` and `spawnMobile` must accept `EntTeam`,
   not `TeamId`. These are the two outstanding typecheck errors in `camps.ts`, which S_JUNGLE
   left standing rather than working around — correctly.

5. **Do not give camps non-zero `hpRegen`.** Per `AMENDMENT_1` §C they regen at 0; §B above is
   the only reset path. `stepUnits`' regen loop runs before the hero-only gate and would
   otherwise passively heal camp members mid-fight.

---

## E. On mutation testing — this is now the standard

S_JUNGLE ran 23 mutations, reported 20 RED, and — the part that matters — **found one of its own
tests still green** (M14, "returning member re-acquires": the test dragged the member outside the
disc, so the rule under test was never exercised), rewrote it, and re-ran to RED. It also
reported two mutations it could *not* make detectable, with reasoning, rather than faking them.

That is exactly the standard. Every fix task from here reports its mutation matrix, including the
ones that stayed green and why.
