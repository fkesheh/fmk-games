# Contract amendment 1 — after the server wave reviews

Authority: this document sits at level 2, beside the frozen source files. Where it contradicts
`TERRAIN_CONTRACT.md`, `BUILD_SPECS.md` or `GRAPHICS_CONTRACT.md`, **this wins** — those
documents were written before the wave ran and the reviews measured them wrong.

Every decision here is mine, not a subagent's. Implementers apply them; they do not renegotiate.

---

## A. The camps ↔ movement seam — FROZEN (root cause of 7 defects)

**What went wrong.** I specced camp behaviour across two tasks and never said which one owns
camp destination and acquisition. S_CAMPS parked members on a 1.6 m post ring and healed only
within 0.15 m of that post; S_MOVE's `campMotion` steered to the clearing centre and never read
`ox/oz`. Each passed its own suite. Composed, the hp-restore path, the leash clamp, the
de-aggro and the damager-wipe are all unreachable, and every member of a camp converges on one
point and oscillates against pass-2 separation forever. Both reviewers found this independently.

**The rule, from now on: `camps.ts` decides, `movement.ts` executes.** This mirrors how heroes
already work — orders are set elsewhere, `heroMotion` only carries them out.

`camps.ts` (S_CAMPS) owns and is the **only** writer of:
- acquisition — choosing `orderTarget`, including all range and reachability caps
- the leash decision, and issuing the go-home order
- hp restore on leash-break arrival, and clearing `recentDamagers`
- per-member rest posts: each member gets a **distinct** post, written as its idle destination,
  so a camp at rest does not stack on one point
- respawn, and killing any orphaned members before reusing a `CampState`

It communicates **only** by writing `e.order`, `e.ox`, `e.oz`, `e.orderTarget`. It never writes
`e.x`/`e.z`.

`movement.ts` (S_MOVE) owns `campMotion(w, e)`, which:
- reads `e.order`, `e.ox`, `e.oz`, `e.orderTarget` and does exactly what they say
- performs **no** acquisition, **no** leash logic, **no** home-finding, **no** hp changes
- **must not** fall through to `creepMotion`
- **must not** move the ent when `order === 'idle'`

**Consequences.** `campHome()` and its nearest-clearing search are deleted — the reviewer
measured clearings 17.80 m apart at 1 lane and 19.10 m at 3 lanes against a comment claiming a
20 m floor, and cross-half pairs have no floor at all, so "nearest clearing" could leash a
chased member against a foreign camp. With this seam there is no home search: `camps.ts` knows
which camp a member belongs to and writes the coordinate.

**No teleporting.** The leash clamp must never rewrite `e.x`/`e.z`. It issues a move order home
and the member walks back. Direct position writes ran after movement's push-out and could
place a member across a cliff or inside a structure.

**Ordering note.** `stepCamps` runs after `stepMovement` in the same tick, so an order it writes
takes effect on the *next* tick. That one-tick latency is accepted and must not be "fixed" by
having `camps.ts` move ents itself.

---

## B. Contract additions — these close reported gaps

Additive only, so nothing in flight breaks.

1. **`dayPhase(matchTick: number): number` and `nightVisionScale(dayPhase: number): number`
   move into `shared/src/config.ts`.** `vision.ts` and `room.ts` must both call these. They were
   each about to derive the cycle independently, and `BUILD_SPECS` had handed S_ROOM a *sawtooth*
   while `protocol.ts` freezes a wrapping *triangle* — that divergence would have put client
   lighting at 0.99 where server night read 0.02, near every cycle boundary.

2. **`SimEvent` gains `| { k: 'miss'; attacker: EntId; target: EntId }`** in
   `server/src/sim/types.ts`. S_COMBAT shipped a local `MissEvent` through a bivariance seam,
   which makes `drainEvents(): SimEvent[]` return non-`SimEvent` elements — unsound, and
   `rift_miss` could never reach the wire. §0 said to implement nothing on a contract gap and
   report it; that rule stands.

3. **`expireAtTick <= 0` means never.** `sim/types.ts` documented only `0`. Three modules
   independently rediscovered the `-1` sentinel and each widened its own predicate. The doc
   comment is corrected and the meaning is now `<= 0`.

4. **`isCampKind(k: EntKind): boolean` is exported from `shared/src/terrain.ts`.** S_UNITS
   duplicated the camp-kind list with no compile-time link; a fourth camp kind would silently
   stop being exempted from wave logic and expiry.

5. **Debug surface**: `window.__rift.triangles(): number` and `window.__rift.worldReady():
   boolean` are frozen names. R_SCENE exposes triangles off `renderer.info`; R_WIRE wires both.
   S_HARNESS already codes against exactly these.

---

## C. Rulings on conflicts the implementers flagged

**Night is a smooth ramp, not a snap — RATIFIED.** `TERRAIN_CONTRACT` §4.3 wrote it as a boolean
snap; S_VISION implemented a ramp against the lower-authority `BUILD_SPECS`. The ramp is correct
and §4.3 is hereby amended: `dayPhase` is frozen in `protocol.ts` as a continuous wrapping
triangle, a boolean `night` is undefined against it, and a snap would pop every unit's vision
radius in one tick at the threshold. S_VISION deviated from the authority order to get there and
should have asked — but the answer it reached is the right one.

**Camp chase cap is `CAMP_LEASH_RADIUS` (10), not `CAMP_LANE_CLEARANCE` (14).** `BUILD_SPECS`
§S_CAMPS was wrong; `config.ts` derives 14 *from* 10. S_CAMPS resolved this correctly.

**Concealment reveal is `atkTarget !== NO_ENT`,** per `TERRAIN_CONTRACT` §4.2, not
`nextAttackTick > tick`. `combat.ts` clears `atkTarget` every tick, whereas `nextAttackTick`
stays true for the whole cooldown and would leave anything that ever attacked permanently
revealed. `BUILD_SPECS`' version was wrong.

**But: a unit on a ramp must NOT ignore foliage.** `elevationAt` reads `ramp` as `ELEV_HIGH`, so
the "viewer looking down from high ground" exception currently lets anyone standing on a ramp
see through every bush on the map. Narrow that exception to `kindAt(viewer) !== 'ramp'`.

**`World.order` snaps its destination to the nearest passable cell.** Previously unassigned.
With no pathfinding for non-heroes and cliffs now solid, an order onto a cliff would otherwise
walk a unit into the face and stall it. `world.test.ts`'s two `(0,0)` cases must be updated —
`(0,0)` is a cliff cell at 1, 2 and 3 lanes.

**Camps have `hpRegen = 0`.** Leash-break restore is the only heal. Otherwise `stepUnits`' regen
loop would passively heal camp members mid-fight, which is not in `DESIGN_DELTA` and interacts
badly with the leash restore.

---

## D. Perf ruling — pathing needs a per-tick cap

The reviewer measured A* at **p99.9 = 2.017 ms and max 25.7 ms** against a **2.5 ms** tick
budget. `PATH_NODE_BUDGET` bounds expansions within one search but nothing bounds searches per
tick, and `heroMotion` calls `clearPath()` on every chase tick.

**Ruling:** at most **2** A* searches may run per tick. Overflow requests queue; a hero waiting
on the queue steers straight that tick and retries next tick. `clearPath()` must not be called
every chase tick — repath only when the destination cell changes.

---

## E. Test-honesty rulings

The reviewers proved several tests cannot fail. These are defects, not style:

- **S_UNITS** — the mandated "ward restock unaffected by neutral deaths" test wipes the jungle
  before asserting cadence; suppressing restock whenever a neutral exists stays green. Each of
  the five new guards must be pinned by a test that fails when that guard alone is reverted.
- **S_SHAREDTEST** — deleting validator rules 8 (connectivity) and 9 (no concave traps) leaves
  the suite green while its header claims full coverage. The S2C half of `protocol.test.ts` is
  `JSON.parse(JSON.stringify(literal))` with no production code on the path: seven cases cannot
  fail for any implementation.
- **S_VISION** — no `NEUTRAL_TEAM` entity exists anywhere in 716 lines of test, so the new camp
  arms in both `visionRadius` and `scalesAtNight` are entirely untested; and nothing asserts the
  `proj`/own-team bypasses stay exempt from the terrain vetoes.
- **S_CAMPS** — the fixtures fake the behaviour under test: `moveCamps` moves toward `ox/oz` and
  snaps, which the real `campMotion` does neither, so `expect(order).toBe('idle')` is false in
  the real sim. `noteDamager` only fires for hero victims, so `recentDamagers` is always empty in
  production and two code paths are permanent no-ops.

**Standing rule for every fix task:** a test that passes when you revert the behaviour it names
is not a test. Verify by reverting.

---

## F. What this means for scheduling

- **S_MOVE and S_CAMPS are re-issued as one merged task, `S_JUNGLE`,** owning
  `sim/camps.ts`, `sim/movement.ts`, `sim/pathing.ts` and all three suites. They could not be
  gated apart — that is the definition of the splitting floor in my own rules, and I crossed it.
- **S_COMBAT** gets a small follow-up: drop the bivariance seam, use the real `SimEvent` variant.
- **S_VISION** gets a small follow-up: call the hoisted `dayPhase`/`nightVisionScale`, narrow the
  ramp exception, add neutral-entity and bypass tests.
- **S_UNITS, S_SHAREDTEST** get test-honesty follow-ups.
- **S_HARNESS** gets a follow-up: 3-lane 8v8 for budget runs, fix the `night-close-hero` framing
  and `camp-brute` timeout, move the approach distance to the 9.5–11 m safe band, drop the
  out-of-spec quick-join check, and move module-scope imports inside the try block.
- **S_WORLD must not wire `stepCamps` into `advance()` until S_JUNGLE lands.** It would typecheck,
  pass, and be wrong in play.
