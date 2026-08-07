# RIFT graphics + terrain build — task specs

This document is the dispatch spec for the 27 build modules in `plan.graphics.json`.
Every implementer agent reads §0 (universal rules) plus exactly one task section.

Authority order, highest first:

1. `GRAPHICS_CONTRACT.md` §7 RULES
2. The frozen Layer-1 source files (`shared/src/{palette,surfaces,terrain,types,config,protocol,map}.ts`,
   `server/src/sim/types.ts`, `client/src/{contract.ts,render/core.ts,render/kit.ts}`)
3. `TERRAIN_CONTRACT.md`, `STYLE_BIBLE.md`, `DESIGN_DELTA.md`
4. This document
5. `games/rift/CONTRACT.md` (the pre-existing RIFT contract, as amended by GRAPHICS_CONTRACT §1)

If two of these disagree, the higher one wins and you **stop and report the conflict** in your
return summary. You do not resolve contract conflicts yourself.

---

## §0 Universal rules — every implementer

**Repo.** `/Users/fkesheh/projects/fps-rift`, branch `rift-graphics`. All paths below are
relative to that root.

**Ownership.** Your task section lists `Owns (exclusive)`. You may create and modify exactly
those files. You may **read** anything. You may **not** write, "fix", reformat, or add an
export to any file you do not own — not even a one-line type fix, not even if it is obviously
broken. Another agent owns it and is editing it concurrently; your edit will be lost or will
collide.

**The contract is immutable.** The 17 files in `plan.graphics.json.contract[]` are frozen.
Do not edit them. Do not add to them. If you need a symbol that does not exist there, you have
found a contract defect: implement nothing for that part, and report it as `CONTRACT_GAP:
<what you needed and why>` in your return summary.

**No stubs.** Every function you write is fully implemented. No `TODO`, no `FIXME`, no
`throw new Error('not implemented')`, no empty branch with a comment promising later work,
no placeholder constant awaiting a real value. If a section of your spec is genuinely
unimplementable, implement everything else and report the blocker — do not fake it.

**No dead code.** Do not leave the old implementation commented out beside the new one.

**Determinism.** Anything reachable from the simulation must be deterministic. `Math.random()`
is banned in `server/src/**` and in `shared/src/**`. Use `rng(seed)` from the kit (client) or
the seeded generator the contract provides (shared), and for combat-miss use
`missRoll(tick, attacker, target)` — never a stateful RNG, because `balance.test.ts` depends
on bit-identical replays.

**Terrain never goes on the wire.** The client rebuilds terrain from `buildTerrain(lanes)`.
It must therefore be a pure function of lane count and bit-identical on server and client:
no time, no randomness that is not seeded from `lanes`, no floating-point accumulation whose
order could differ.

### Material law (see GRAPHICS_CONTRACT §1)

- Every material comes from `surface()` or `emissiveSurface()` in `client/src/render/kit.ts`.
  You do not construct `new THREE.Mesh*Material` directly. Ever.
- `MeshLambertMaterial`, `MeshBasicMaterial`, `MeshPhongMaterial` are **banned** in
  `client/src/**` except where `GRAPHICS_CONTRACT` §1 explicitly permits (sprite/overlay paths).
- **Vertex-colour law.** All kit materials are `vertexColors: true`. Therefore every geometry
  you hand to `bake()` must carry a `color` attribute. `bake()` supplies white by default —
  but if you build a geometry by hand outside the kit helpers, you must add the attribute
  yourself or it renders black.
- **UV law.** All kit textures are `RepeatWrapping` and 1 UV unit ≙ 1 world metre. You never
  set `texture.repeat` — you scale UVs in geometry space instead.
- **Bloom is layer-masked.** A thing glows only if you call `markBloom(obj)`. Emissive alone
  does not bloom. Do not raise `emissiveIntensity` to fake glow on an unmarked object.
- Tone mapping is `NeutralToneMapping`, not ACES. This is a measured decision recorded in
  `STYLE_BIBLE.md` §4 — ACES crushed sun-lit moss to L*≈8 against a palette value of L*≈22.
  Do not change it, and do not compensate for it by brightening palette entries.

### Budgets (GRAPHICS_CONTRACT §5) — these are gates, not aspirations

| Budget | Limit | Notes |
| --- | --- | --- |
| Draw calls | ≤ 700 | `renderer.info.autoReset = false`, `reset()` at top of `render()` |
| Triangles | ≤ 1.2 M | |
| Cold load | ≤ 400 ms | split 150 / 150 / 100 ms across R_TERRAIN / R_VEG / R_MAPMESH |
| Bundle | ≤ 2.0 MB gz | |
| Sim tick | ≤ 2.5 ms | |

Static world geometry is baked per 16×16 m chunk. Repeated archetypes (trees, rocks, creeps)
are `InstancedMesh` per archetype. If your module adds more than a handful of draw calls,
you are doing it wrong — say so rather than shipping over budget.

### Your gate

Run these **scoped to your own workspace**, and paste the real output:

```bash
cd /Users/fkesheh/projects/fps-rift
npx tsc --noEmit -p <the tsconfig covering your files>   # or: npm run typecheck -w <your workspace>
npx vitest run <your test files> > /tmp/gate.txt 2>&1; echo "EXIT=$?"
```

Three hard rules about the gate:

1. **Never judge a command by piped output.** Redirect to a file and capture the exit code
   explicitly (`> out.txt 2>&1; echo $?`). Do not pipe to `tail`/`head` and read the tail.
   This environment has a wrapper that can print `PASS (0) FAIL (0)` with exit 0 on a run
   that actually hard-failed. The exit code is the truth.
2. **A workspace-wide red typecheck is expected mid-build** and is not your problem. Errors
   inside files you do not own are other agents' in-flight work. Your gate is: *no error
   whose file path is one of the files you own*. Report other files' errors as context if
   you like, but do not fix them and do not treat them as your failure.
3. If your gate cannot be green because a sibling module's file does not exist yet, say so
   precisely (`blocked on <path> not yet written by <module>`) — that is a scheduling fact,
   not a failure.

### What you return

A structured summary, and **nothing else**:

- what you implemented, in 5–15 lines
- exact list of files created/modified with final byte sizes
- your gate command(s) and their real output + exit codes
- every `CONTRACT_GAP:` you hit
- risks / things the next agent or the reviewer should look at
- **not** file contents, not diffs, not code listings

---

## §1 Wave structure

Wave 0 (the frozen Layer-1 contract) is complete before any of this dispatches.

**Wave 1** — depends on the contract only. All dispatched simultaneously.

> S_VISION, S_COMBAT, S_MOVE, S_CAMPS, S_ABIL, S_UNITS, S_SHAREDTEST, S_HARNESS,
> R_SCENE, R_POST, R_TERRAIN, R_VEG, R_MESH_HERO, R_MESH_CREEP, R_MESH_CAMP,
> R_MESH_STRUCT, R_FX, R_FOG, R_MINIMAP, R_HUD

**Wave 2** — needs Wave-1 files to exist for its imports.

> S_WORLD (imports the six sim steps), R_MAPMESH (terrain + structures),
> R_UNITS (the four mesh builders)

**Wave 3** — needs a coherent sim/renderer.

> S_BOTS, S_ROOM, S_BALANCE

**Wave 4** — integration, single-threaded.

> R_WIRE

Reviews stream: each completed diff goes to a reviewer that is **not** its author, dispatched
the moment that diff lands, not batched at the end.

---

## §1a Structural facts every implementer must know

These were established by reading the tree as it stands. They are not negotiable and they
are not obvious from the file names.

**A. There are currently TWO competing `SceneCore` interfaces.** The old one is declared
*inside* `render/scene.ts` and carries `mat(hex)` and `vertexMat()`. The new, frozen one is in
`render/core.ts` and deliberately drops both. `core.ts` is brand new and has **zero consumers**
today. R_SCENE performs the cutover; every other render module imports `sceneCore` and
`SceneCore` from `./core.js` and never from `./scene.js`.

**B. `paintGeo()` is deleted, not replaced in kind.** It baked albedo into vertex colours,
which double-multiplies under PBR. `core.ts` offers `whiteVertexColors(geo)` for geometry that
does not pass through `bake()`. Tint now comes from `surface(id, tint)`.

**C. The legacy material call sites are exactly these — no others exist in the tree:**

| File | Owner | What breaks |
| --- | --- | --- |
| `render/scene.ts` | R_SCENE | declares `mat`/`vertexMat` on its own `SceneCore`; 12× `MeshLambertMaterial` |
| `render/mapMesh.ts` | R_MAPMESH | `core.mat(...)` ×6 (lines 248, 276, 300, 306, 372, 556) |
| `render/units.ts` | R_UNITS | `core.vertexMat()` ×1 (line 568), `paintGeo` import, 14× `MeshLambertMaterial` |
| `render/fx.ts` | R_FX | `core.mat(APAL.paper)` ×1 (line 85), 3× `MeshLambertMaterial` |
| `render/fog.ts` | R_FOG | 1× `MeshLambertMaterial` |

There is no `MeshBasicMaterial` or `MeshPhongMaterial` anywhere in `games/rift`. 30 Lambert
constructions total. After this build the correct count is **zero**.

**D. `render/meshes/` does not exist.** All four mesh modules are net-new. So are
`render/post.ts`, `render/terrain.ts`, `render/vegetation.ts`, `sim/camps.ts`, `sim/pathing.ts`.

**E. The sim step functions take `SimWorld`, the concrete class from `world.ts` — not the
`World` interface.** `world.ts` imports the step functions and they import `SimWorld` as a
*type*. That circularity is pre-existing and fine. The practical rule: a step module may rely on
the `World` interface surface (frozen in `sim/types.ts`, and it already declares
`readonly camps: CampState[]`) plus `SimWorld`'s existing public methods. It may **not** require
a new public member on `SimWorld` — if you need one, that is a `CONTRACT_GAP:` for S_WORLD.

**F. Current `SimWorld.advance()` order** — 8 steps, no camp step:

```
guard ended -> tick += 1
(1) applyOrders()        (2) abilities.step(this)   (3) stepUpkeep()
(4) stepMovement(this)   (5) stepCombat(this)       (6) stepDeaths(this)
(7) stepUnits(this)      (8) stepEndChecks()
```

`stepCamps` is inserted by S_WORLD **between (6) and (7)**, per `TERRAIN_CONTRACT.md`.

**G. No pathfinding exists.** Movement is straight-line `steer()` + soft mobile separation +
post-hoc radial push-out off structures. Creeps index-walk the static polyline
`MapDef.paths[lane]` with `WAYPOINT_REACH = 1.2`. There is no graph, grid, navmesh, flow field
or A* in the sim today. This is why lane corridors must be validated cliff-free — see S_MOVE.

**H. `QueuedCast` is declared twice** — once in `sim/types.ts` (the contract) and again at
`abilities.ts:34`. The local copy is a defect. S_ABIL deletes it.

---

## §2 Task specs — server

### S_VISION

```
Task:        Elevation-, foliage- and night-aware team vision.
Model tier:  MEDIUM — one function, clear rules, but the perf shape matters.
Depends on:  contract only
Owns:        server/src/sim/vision.ts, server/src/sim/vision.test.ts
```

`vision.ts` today is 97 lines: one exported
`computeTeamVisible(world: World, team: TeamId, out: Set<EntId>): void` that unions per-kind
vision radii over the team's live units, wards and structures. Preserve that signature exactly —
`room.ts` calls it every tick, per team.

Add three modifiers, and **only** inside the pass-2 inner loop (the "can viewer V see entity E"
test). Do not touch pass 1 (collecting viewers).

1. **Uphill blocking.** If `elevationAt(t, E.x, E.z) === ELEV_HIGH` and
   `elevationAt(t, V.x, V.z) === ELEV_LOW`, V cannot see E — regardless of range. The reverse
   (high looking down at low) is unaffected. Equal elevations are unaffected.
2. **Foliage concealment.** If `isConcealing(t, E.x, E.z)` then V cannot see E **unless** E is
   currently attacking. "Currently attacking" is `E.nextAttackTick > world.tick` — i.e. E has
   fired within its own attack period and is still in recovery. Structures and wards are never
   concealed. A concealed entity still occupies space and is still damageable if targeted by
   something that already had it acquired.
3. **Night.** Vision radii scale by `nightVisionScale(dayPhase)` for `hero` and the four creep
   kinds only. Wards, towers, guards and ancients keep full radius day and night — they are
   fixed installations. Derive `dayPhase` from `world.tick` and `DAY_PERIOD_S` exactly the way
   `room.ts` puts it on the wire, so client and server agree; if that helper is not in the
   frozen contract, compute it inline as `(world.tick / TICK_RATE / DAY_PERIOD_S) % 1` and
   report a `CONTRACT_GAP:` recommending it be hoisted. Full night is a 25% reduction
   (`scale = 0.75`); ramp it smoothly rather than snapping, per `DESIGN_DELTA.md`.

Order matters: apply the night scale to the radius, do the range test, then apply the
elevation and concealment vetoes. A veto is absolute — it is not a range penalty.

**Perf.** This runs once per team per tick with up to ~200 entities. It is currently O(viewers ×
entities) with an early radius reject. Keep it allocation-free in the steady state — no
closures, no array literals, no `Set` construction inside the loops. `out` is caller-owned;
clear it, fill it, never replace it. Hoist the `TerrainDef` lookup (`world.map.terrain`) out of
the loops.

**Tests** (`vision.test.ts`, yours): a low viewer cannot see a high target at point-blank; a
high viewer sees a low target normally; equal-elevation pairs are unaffected; a concealed
stationary enemy is invisible at 1 m; the same enemy becomes visible on the tick it attacks and
invisible again once `nextAttackTick` lapses; a tower's radius is identical at `dayPhase` 0 and
0.5 while a hero's is not; `out` is cleared between calls; two calls with identical world state
produce identical sets.

**Gate:** `npx vitest run games/rift/server/src/sim/vision.test.ts` green, and no typecheck
error in either owned file.

---

### S_COMBAT

```
Task:        Uphill miss chance + neutral-safe kill attribution.
Model tier:  MEDIUM
Depends on:  contract only
Owns:        server/src/sim/combat.ts, server/src/sim/combat.test.ts
```

`combat.ts` is 255 lines exporting `stepCombat(w: SimWorld)` and `stepDeaths(w: SimWorld)`.
`fire(w, a, t)` is module-private at line 51 — keep it private.

1. **Uphill miss.** In `fire()` and nowhere else: if the attacker is at `ELEV_LOW` and the
   target at `ELEV_HIGH`, the attack has a 25% chance to miss. On a miss, consume the attack
   (advance `nextAttackTick` normally), deal no damage, apply no on-hit effects, and
   `w.pushEvent(...)` the miss so it reaches the client as `rift_miss` with **entity** ids
   (`{ attacker, target }` — the protocol comment is explicit that these are entity ids, not
   player ids). Ranged and melee are treated identically. Towers shooting uphill miss too.
2. **The roll must be `missRoll(tick, attacker, target)`** from the frozen terrain module — an
   integer avalanche hash, not a stateful RNG and not `Math.random()`. `balance.test.ts` replays
   matches and compares bit-for-bit; a stateful RNG here desynchronises every downstream tick.
   Miss iff `missRoll(w.tick, a.id, t.id) < 0.25` (or the integer equivalent — follow whatever
   return domain the frozen signature declares; do not assume it returns a float).
3. **Neutral-safe attribution in `stepDeaths`.** `splitXpAmongHeroes` currently filters with
   `e.team !== d.team`, which for a dead neutral (`team === 2`) admits heroes from **both**
   teams and pays the XP twice. Fix: XP and gold for a neutral death go only to heroes on the
   team of the killer (`lastHitBy`'s team), sharing within `XP_SHARE_RADIUS` as normal. Guard
   every per-team tuple index (`kills`, `wardStockArr`, ancient arrays) with `isPlayerTeam()` —
   indexing a 2-tuple with `2` is the exact bug this widening invites.
4. A neutral death must not touch first-blood, must not emit a `kill` `SimEvent` (that event
   carries `victimPid: string` and a camp has no pid), and must not increment hero `deaths`.

**Do not** change armour/magic-resist maths, aggro windows, fortify, assist windows, or bounty
values. This task adds terrain and neutrals to combat; it does not rebalance it.

**Tests:** low→high attacker misses at the expected rate over 10 000 seeded rolls (within ±2%);
high→low and level ground never miss from elevation; the same `(tick, attacker, target)` triple
always yields the same result; a missed attack still advances `nextAttackTick`; a neutral death
pays exactly one team; a neutral death never sets first blood; `isPlayerTeam` guards hold when
a camp lands the killing blow on a hero.

**Gate:** `npx vitest run games/rift/server/src/sim/combat.test.ts` green; no typecheck error in
owned files.

---

### S_MOVE

```
Task:        Cliff collision, ramps, and hero-only A* over the terrain grid.
Model tier:  LARGE — this is the one sim task with real algorithmic ambiguity.
Depends on:  contract only
Owns:        server/src/sim/movement.ts, server/src/sim/pathing.ts,
             server/src/sim/movement.test.ts
```

`movement.ts` is 350 lines: `entDist`, `inAttackRange`, `stepMovement(w: SimWorld)`, plus
private `steer`, `heroMotion`, `creepMotion`, `summonMotion`, `dashMotion`,
`nearestEnemyMobile`, `nearestEnemyAny`, `structureInReach`. `pathing.ts` is net-new.

**Cliffs are impassable.** A mobile may not cross from `ELEV_LOW` to `ELEV_HIGH` or back except
through a cell whose `TerrainKind` is `'ramp'`. Implement as a movement veto in `steer()`: if
the proposed post-step position is on a different elevation than the current position and
neither cell is a ramp, reject the step and slide along the cliff edge (project the motion onto
the tangent), exactly as the existing structure push-out slides. Never teleport, never allow a
one-frame overshoot at high `moveSpeed`, and never let the dash (`dashMotion`) cross a cliff —
a dash into a cliff stops at the face.

**Ramps** connect the two elevations and are ordinary walkable ground otherwise.

**Pathfinding — heroes only, and only heroes.** `Ent.path: readonly Vec2[] | null` and
`pathIndex` already exist in the frozen contract, documented "HEROES ONLY; null = steer
straight". `pathing.ts` exports a grid A* over `TerrainDef.grid` using `isPassable`, 8-connected,
octile heuristic, that returns a *simplified* polyline (collapse collinear runs; string-pull
through open space so heroes do not visibly staircase). Recompute a hero's path when it
receives a new move/attackmove order, not per tick. Cap: at most 16 heroes exist, so budget the
whole system at well under the 2.5 ms sim tick — if a search exceeds a node budget, return
`null` and let the hero steer straight rather than stalling the tick.

Creeps, summons, projectiles and wards keep **pure straight-line steering** with `path = null`.
Lane corridors are contractually validated cliff-free, so lane creeps never need a search.

**`nearestEnemyAny` must keep returning camps.** Heroes and bots need to acquire neutrals or
the jungle is unengageable. Only the lane-creep and summon acquisition paths exclude
`team === NEUTRAL_TEAM`. Get this backwards and either the jungle is inert or creep waves
suicide into the jungle — state in your summary which call sites you changed.

**Determinism:** A* tie-breaking must be deterministic — order the open set by
`(f, h, cellIndex)`, never by insertion order into a `Map`, and never by object identity.

**Tests:** a hero ordered across a cliff routes through the ramp and arrives; a hero ordered to
an unreachable cell fails gracefully (no path, no stall, no infinite loop); a creep on a lane
never leaves its polyline; a dash into a cliff face stops at the face; sliding along a cliff
does not jitter or deadlock head-on; a hero at max `moveSpeed` cannot tunnel through a
one-cell-thick cliff in a single tick; two identical worlds produce identical paths.

**Gate:** `npx vitest run games/rift/server/src/sim/movement.test.ts` green; no typecheck error
in owned files.

---

### S_CAMPS

```
Task:        Neutral jungle camps — spawn, aggro leash, death, respawn.
Model tier:  MEDIUM
Depends on:  contract only
Owns:        server/src/sim/camps.ts, server/src/sim/camps.test.ts
```

Net-new file. `sim/types.ts` already freezes `CampState { id, def, memberIds, aliveCount,
respawnAtTick }` and `World.camps: CampState[]`; `shared/src/map.ts` already emits `CampDef[]`
via `buildTerrain`. `world.ts` has **zero** camp references today — S_WORLD adds the wiring; you
provide the step.

Export `stepCamps(w: SimWorld): void` and `spawnCamp(w: SimWorld, c: CampState): void`.

- **Spawn.** All camps spawn at match start and refill on respawn. Members are spawned with
  `w.spawnMobile(kind, NEUTRAL_TEAM, x, z, -1, -1, NO_ENT)` — lane `-1`, no expiry, no owner —
  where `kind` is `campPack` / `campBrute` / `campHive` per `CampDef.tier`. Record the ids in
  `memberIds` and set `aliveCount`. Stat blocks (hp, damage, armour, bounty, xpValue, radius,
  attackRange, moveSpeed, vision) come from the frozen config tuning entries; do not invent
  numbers — if a tuning entry is missing, that is a `CONTRACT_GAP:`.
- **Leash.** Camp members are stationary until damaged or until an enemy enters aggro range.
  Once aggroed they chase, but never beyond `CAMP_LANE_CLEARANCE` from their camp origin. On
  leash break they return to origin, **reset to full hp**, and de-aggro. A camp that resets must
  not keep `recentDamagers` — otherwise a hero can chip a camp, walk away, and still be credited.
- **Death and respawn.** When `aliveCount` hits 0, set `respawnAtTick = w.tick + respawn delay`
  (from config; `-1` means the camp is UP — that is the frozen convention, respect it).
  On respawn, `spawnCamp` again with fresh ids. Do not reuse `EntId`s.
- **`stepCamps` runs between `stepDeaths` and `stepUnits`** so it observes this tick's deaths.

Camps never push lanes, never path, never acquire structures, and never leave their half of the
map. They are `EntTeam === 2`; every per-team array index near camp code needs `isPlayerTeam`.

**Tests:** camp count matches `DESIGN_DELTA` (2/3/4 per half for 1/2/3 lanes) and is mirrored
between halves; killing all members sets `respawnAtTick`; the camp is back at the configured
delay with full hp; leash break restores full hp and clears damagers; a camp never moves beyond
its clearance radius; camps are deterministic across two identical runs.

**Gate:** `npx vitest run games/rift/server/src/sim/camps.test.ts` green; no typecheck error in
owned files.

---

### S_ABIL

```
Task:        Neutral-safe ability targeting; delete the duplicate QueuedCast.
Model tier:  MEDIUM
Depends on:  contract only
Owns:        server/src/sim/abilities.ts, server/src/sim/abilities.test.ts
```

`abilities.ts` is 537 lines exporting `QueuedCast` (duplicate — **delete it**),
`ITEM_EVENT_SLOT_BASE = 4`, and `createAbilitiesEngine()`.

1. Delete the local `QueuedCast` type at line 34 and import the contract one from `./types.js`.
   Keep exporting `ITEM_EVENT_SLOT_BASE` and `createAbilitiesEngine` unchanged.
2. **`TargetTeam` resolution must handle `EntTeam`.** Every filter of the form
   `e.team === caster.team` (allies) or `e.team !== caster.team` (enemies) is now wrong for
   neutrals: a camp is an enemy of *both* teams and an ally of *neither*. Define the rule once,
   privately, and route every effect through it:
   - `'ally'` → `isPlayerTeam(e.team) && e.team === casterTeam`
   - `'enemy'` → `e.team !== casterTeam` (this correctly admits neutrals)
   - `'any'` → unchanged
   A camp must never be healed, buffed, or counted as an ally by an AoE.
3. Guard every per-team tuple index with `isPlayerTeam`.
4. Projectiles keep straight-line motion and are **not** blocked by cliffs — a fireball flies
   over terrain. Do not add elevation checks to projectile integration; the uphill penalty lives
   in auto-attacks only (S_COMBAT), which is the deliberate design in `DESIGN_DELTA.md`.

Do not rebalance any ability, change any cooldown, or alter `SUMMON_MAX_ACTIVE`.

**Tests:** an AoE heal centred on a camp heals no camp member; an AoE nuke damages camps and
enemy heroes but not allies; a single-target ally ability cannot target a neutral; casting
near a camp does not corrupt per-team arrays; existing ability behaviour on player targets is
unchanged (port the existing suite forward rather than rewriting it).

**Gate:** `npx vitest run games/rift/server/src/sim/abilities.test.ts` green; no typecheck error
in owned files.

---

### S_UNITS

```
Task:        Neutral-safe economy/lifecycle; keep camps out of wave logic.
Model tier:  SMALL — mechanical, fully specified.
Depends on:  contract only
Owns:        server/src/sim/units.ts, server/src/sim/units.test.ts
```

`units.ts` is 214 lines: `grantXp(w, h, amount)`, `stepUnits(w)`, private `stepWaves`,
`stepRespawns`, `stepExpiry`.

- `stepWaves` iterates to spawn lane creeps. It must never see or count camp entities — filter
  by `isPlayerTeam(e.team)` wherever it enumerates units, so a jungle full of neutrals cannot
  perturb wave sizing or the surge logic.
- `stepRespawns` handles **hero** respawn only. Camp respawn belongs to S_CAMPS. Make sure a
  neutral with `respawnAtTick` set never gets picked up here.
- `stepExpiry` reaps timed entities by `expireAtTick`. Camp members are spawned with
  `expireAtTick = -1` and must be exempt.
- `grantXp` is called from `combat.ts` for kills. Keep its signature. It must ignore a non-hero
  target defensively.
- Guard `wardStockArr` and any other per-team tuple with `isPlayerTeam`.

Change nothing about wave timing, surge growth, fountain regen rates, passive gold, level
thresholds, or ward restock.

**Tests:** wave composition is identical with and without camps present on the map; a camp
member is never reaped by expiry; a camp member is never hero-respawned; ward restock is
unaffected by neutral deaths.

**Gate:** `npx vitest run games/rift/server/src/sim/units.test.ts` green; no typecheck error in
owned files.

---

### S_WORLD

```
Task:        Wire camps + terrain into SimWorld and the tick order.
Model tier:  MEDIUM
Depends on:  S_CAMPS (imports stepCamps)
Owns:        server/src/sim/world.ts, server/src/sim/world.test.ts
```

`world.ts` is 1087 lines. It exports `CoreStats`, `PassiveAuraEntry`, `class SimWorld implements
World`, and `createWorld(map, seats, rand, abilities)`. **Preserve every existing public member**
— `room.ts`, three sim modules and four test files depend on them.

1. **Implement `World.camps`.** `SimWorld` currently has *no* camp references at all, so it does
   not actually satisfy the frozen `World` interface. Add `readonly camps: CampState[]`,
   populated at construction from `map.terrain.camps` (one `CampState` per `CampDef`, `memberIds`
   empty, `aliveCount` 0, `respawnAtTick` 0 so the first `stepCamps` spawns them).
2. **Insert `stepCamps(this)` between `stepDeaths(this)` and `stepUnits(this)`** in `advance()`.
   The resulting order is exactly: applyOrders, abilities.step, stepUpkeep, stepMovement,
   stepCombat, stepDeaths, **stepCamps**, stepUnits, stepEndChecks.
3. **`spawnMobile` must accept `EntTeam`.** Its frozen signature already says
   `team: EntTeam`. Verify the implementation does not narrow to `TeamId` internally and does
   not index a per-team array with the raw team. Same audit for `damage`, `dealDamage`,
   `noteDamager`, `heal`, `applyAura`, `recomputeEnt`, `guardAlive`, `fortifyActive`,
   `atOwnFountain`, `wardStock`, `fountainSpot`. Every per-team tuple index gets `isPlayerTeam`.
4. `createWorld` keeps accepting `rand: () => number` and keeps deliberately discarding it. Do
   not start using it — determinism is load-bearing for `balance.test.ts`.
5. Do not add a terrain or height step to `advance()`. Terrain is static.

**Tests:** `advance()` calls the nine steps in the documented order (spy or instrument);
`world.camps` is populated at construction with the right count for 1/2/3 lanes; a full
match tick loop runs 2 000 ticks without a neutral corrupting a per-team array; two worlds
built from the same map and seats produce identical state after 500 ticks.

**Gate:** `npx vitest run games/rift/server/src/sim/world.test.ts` green; no typecheck error in
owned files.

---

### S_BOTS

```
Task:        Teach bots the jungle and the high ground.
Model tier:  MEDIUM
Depends on:  S_WORLD, S_CAMPS
Owns:        server/src/bots.ts, server/src/bots.test.ts
```

`bots.ts` is 608 lines exporting `createBotBrain(seed: number, hero: HeroId): BotBrain`. Keep
that signature. `BotPercept` already carries `camps: readonly CampPercept[]` and
`CampPercept.up` is refreshed in place per tick — consume it, do not rebuild it.

- Add a **jungle behaviour**: when a bot is healthy, its lane is not under pressure, and a camp
  in its own half is `up` and within a reasonable distance, it goes and clears it, then returns
  to lane. Tier preference scales with level — a level-1 bot must not suicide into a `hive`.
- Add **high-ground awareness**: prefer not to initiate a fight from low ground against an enemy
  on high ground (they get the 25% miss advantage against you, not the other way round). This is
  a weighting in the existing retreat/engage scoring, not a new subsystem.
- Bots must remain **deterministic** given `(seed, hero)` and identical percepts. `bots.ts`
  already uses `rng` from `@platform/shared` — keep every new decision on that stream, in a
  fixed order. Do not add a second stream and do not reorder existing draws, or every existing
  bot replay changes.

Do not rewrite the bot architecture. This is two behaviours added to an existing scorer.

**Tests:** a healthy bot with a safe lane and an up camp issues an order toward that camp; the
same bot with a pushing enemy wave does not; a level-1 bot does not attack a `hive`; identical
seed + identical percept sequence yields an identical command sequence; the existing bot suite
still passes.

**Gate:** `npx vitest run games/rift/server/src/bots.test.ts` green; no typecheck error in owned
files.

---

### S_ROOM

```
Task:        Put camps, dayPhase and neutral entities on the wire.
Model tier:  MEDIUM
Depends on:  S_WORLD, S_VISION
Owns:        server/src/room.ts, server/src/room.test.ts
```

`room.ts` is 1349 lines exporting `class RiftRoom`. Keep its whole public surface.

1. **`dayPhase`.** `RiftS2C.rift_snap` already declares `readonly dayPhase: number` in `[0,1]`,
   wrapping. Compute it from `matchTick`, `TICK_RATE` and `DAY_PERIOD_S` and put it on every
   snapshot. It must be a pure function of `matchTick` — the client pins it for captures via
   `window.__rift.setDayPhase(t)` and any wall-clock dependence breaks reproducible screenshots.
2. **`fillEnts` must emit camp entities.** `EntKind` already includes `campPack`/`campBrute`/
   `campHive` and `EntSnap.team` is already `EntTeam`. Camps are subject to the same fog filter
   as everything else — a camp in unexplored jungle is not sent.
3. **`feedBot` must populate `CampPercept[]`.** Build the array once per tick and refresh `up`
   in place (the contract says it is mutable and refreshed in place — do not allocate a new
   array per bot per tick; 16 bots × 20 Hz makes that measurable).
4. Guard every per-team tuple index with `isPlayerTeam`. `buildBoard`, `fillYou`,
   `dispatchEvents` and the kill/structure event paths all index by team.
5. A neutral death must not produce a `rift_kill` event (no pid), and must not appear on the
   scoreboard.

**Tests:** `dayPhase` is a pure function of `matchTick` and wraps at `DAY_PERIOD_S`; a camp
inside vision appears in `ents` with `team === 2`; a camp outside vision does not; bot percepts
carry the right camp count and `up` flags; killing a camp emits no `rift_kill`; the existing
room suite still passes.

**Gate:** `npx vitest run games/rift/server/src/room.test.ts` green; no typecheck error in owned
files.

---

### S_SHAREDTEST

```
Task:        Extend the shared map/protocol suites for terrain and camps.
Model tier:  SMALL — the assertions are enumerated below.
Depends on:  contract only
Owns:        shared/src/map.test.ts, shared/src/protocol.test.ts
```

`map.test.ts` (228 lines) currently has **no** camp or terrain assertions, and — importantly —
it builds `MapDef` object literals that are now missing the required `terrain` field. That is
the one known-red typecheck in `@rift/shared`; fixing it is your job and nobody else's.

Add to `map.test.ts`, exercising `buildTerrain` / `buildMap` for lanes 1, 2 and 3:

- the grid is square, `dim === side * res`, and `kind`/`elev` are both `dim * dim` long
- **mirror exactness** — the terrain is symmetric under the map's 180° rotation, cell for cell,
  for both `kind` and `elev`. Assert bit-equality, not approximate similarity.
- **lane pathability** — every point along every `MapDef.paths[lane]` polyline, sampled densely,
  is passable and at a single consistent elevation with no cliff crossing
- **connectivity** — a flood fill over passable cells from one fountain reaches the other
- **no concave traps** — no passable cell is enclosed such that it has exactly one passable
  neighbour (a one-cell pocket a unit can enter and not steer out of)
- **camp isolation** — every camp is at least `CAMP_LANE_CLEARANCE` from every lane polyline,
  and camp counts are 2/3/4 per half for 1/2/3 lanes, mirrored
- **elevation coherence** — every `ELEV_LOW`↔`ELEV_HIGH` boundary cell is either `'cliff'` or
  `'ramp'`; no elevation change happens across plain ground
- **determinism** — `buildTerrain(n)` called twice returns bit-identical grids

Add to `protocol.test.ts`: `dayPhase` survives round-trip and is rejected outside `[0,1]` if the
parser validates it; camp `EntKind`s round-trip; `EntSnap.team === 2` round-trips.

These tests are the contract's enforcement mechanism — write them to fail loudly and specifically.

**Gate:** `npx vitest run games/rift/shared/src/map.test.ts games/rift/shared/src/protocol.test.ts`
green; `npx tsc --noEmit -p games/rift/shared` clean.

---

### S_BALANCE

```
Task:        Re-baseline the balance suite with jungle income in play.
Model tier:  MEDIUM
Depends on:  S_ROOM, S_BOTS, S_WORLD
Owns:        server/src/balance.test.ts
```

`balance.test.ts` runs full headless matches and asserts the outcome distribution. Jungle camps
add a new income source, so the existing thresholds will drift.

- Keep the suite's determinism guarantee: identical seeds must produce identical matches. If
  that breaks, it is a real defect in the sim, not a threshold to loosen — report it, do not
  paper over it.
- Re-measure and re-baseline: match length, gold curves, win-rate balance between teams,
  and the new jungle-income share. Tolerance is **±15%** per `GRAPHICS_CONTRACT` §5.
- Add an assertion that jungle income is a *meaningful but not dominant* share of total income —
  if clearing camps out-earns laning outright, that is a design failure worth surfacing.
- Assert mirror fairness: with mirrored bot skill, neither team wins more than 55% over the
  sample.

State the measured numbers in your return summary — I need them, not just "green".

**Gate:** `npx vitest run games/rift/server/src/balance.test.ts` green.

---

### S_HARNESS

```
Task:        Raise the budgets, add the new judge shots, pin dayPhase.
Model tier:  MEDIUM
Depends on:  contract only
Owns:        scripts/verify-rift.mjs, scripts/capture-rift-art.mjs, scripts/e2e-rift.mjs,
             scripts/check-rift-palette.ts
```

1. **`verify-rift.mjs`** — `DRAW_CALL_BUDGET` becomes **700**. Add a **triangle budget of
   1.2 M** read from `renderer.info.render.triangles`. Both are read after
   `renderer.info.autoReset = false` + one `reset()` per frame, so they accumulate across post
   passes — that is intended and is why the budget rose from its old value.
2. **Add 7 judge shots** across `verify-rift.mjs` and `capture-rift-art.mjs`:
   `high-ground`, `river-mid`, `camp-brute`, `jungle-wall`, `night-wide-mid`, `night-mid-lane`,
   `night-close-hero`.
3. **`dayPhase` pinning.** Expose and use `window.__rift.setDayPhase(t)` — `null` resumes
   snapshot-driven updates. Every night shot pins `t`; every day shot pins `t` too. An unpinned
   day/night cycle makes every capture non-reproducible and the whole judge loop worthless.
4. **Assert the frame is live and un-overlaid before every in-world shot.** A baseline capture
   was previously taken through the death-screen dim and nobody noticed. Before each in-world
   shot, assert the client phase is `live`, no modal/overlay element is visible, and the frame
   is not uniformly darkened. Fail the capture loudly rather than saving a wrong picture.
5. **Never judge a subprocess by piped output** — capture exit codes explicitly. This harness is
   the gate for everything downstream; a false green here invalidates the entire judge loop.
6. `check-rift-palette.ts` must cover any palette keys added in Wave 0 and keep enforcing the
   value-ladder law. Thresholds may be **extended, never weakened**.

**Gate:** `node scripts/verify-rift.mjs` runs to completion against the current build and
reports its assertions truthfully (it may legitimately FAIL on art quality at this stage — what
must be true is that it runs, measures, and reports honestly). `npx tsc --noEmit` clean for
`check-rift-palette.ts`.


---

## §3 Task specs — client render

### R_SCENE

```
Task:        Cut scene.ts over to the core.ts seam; PBR lights, IBL, shadows, tone map.
Model tier:  LARGE — this is the keystone. Every other render module fails if it is wrong.
Depends on:  contract only
Owns:        client/src/render/scene.ts
```

`scene.ts` is 388 lines and today exports `CAMERA_PITCH_DEG`, `paintGeo`, its **own**
`SceneCore` interface, its **own** `sceneCore()`, `cameraNormalY`, `cameraNormalZ`,
`createScene`. It contains 12 `MeshLambertMaterial` constructions.

**The seam cutover — exact, and the single highest-risk edit in this build.** `sceneCore()` in
`core.ts` is nothing but `return (scene as SceneHandleInternal).core;`. There is no registry and
no runtime check: if the handle you return does not carry an own property literally named
`core`, every consumer gets `undefined` **with no compile error anywhere**. So:

1. **Delete** the local `interface SceneHandleInternal` (line ~130) and the local exported
   `sceneCore()` (lines ~134-136). If the local export survives, half the tree imports the seam
   from `./scene.js` and half from `./core.js` and the duplication will bite later.
2. **Delete** the local `interface SceneCore` and `export function paintGeo` entirely.
3. `import type { SceneCore, SceneHandleInternal } from './core.js';`
4. Keep building `const core: SceneCore = { ... }` (~line 256) and keep `core,` in the returned
   handle literal (~line 327) — but type that literal `SceneHandleInternal` so the seam is
   checked in one place, which is the only compile-time protection that exists here.
5. Keep exporting `CAMERA_PITCH_DEG`, `cameraNormalY()`, `cameraNormalZ()` from `scene.ts` —
   they are deliberately not on the core seam and `R_UNITS` imports them.

**New `SceneCore` members you must supply:** `renderer` (the `WebGLRenderer` you already own),
`heightAt(x, z)` (returns `0` for every input until `setTerrain(t)` is called — that is
contractual, and `wire.ts` calls `setTerrain` as the first statement of `onBegin`), and
`setFramePass(fn | null)` (a single nullable slot; no stacking).

**`SceneHandle.render(dtMs)` does exactly this, in this order, inside the existing try/catch:**

```
1. renderer.info.reset()
2. every frame hook, in registration order, with dtMs
3. the camera rig update (shake offsets move every frame)
4. the installed frame pass pass(dtMs) IF installed — OTHERWISE renderer.render(three, camera)
```

Step 4 is either/or, never both — a composer's `RenderPass` already draws the scene.

**Metering:** `renderer.info.autoReset = false` set once in `createScene`; `reset()` exactly
once per frame at the top of `render`; `drawCalls()` returns `renderer.info.render.calls` at
read time. Nothing else may call `reset()` or re-enable `autoReset`.

**Lighting and IBL** (`STYLE_BIBLE` §4). Build the environment with `PMREMGenerator` and assign
`scene.environment`. **`scene.environment === null` is a failed build** — without IBL every
`MeshStandardMaterial` in the game renders as flat unlit plastic and the entire PBR conversion
is pointless. Day and night lighting rigs per the bible; sun shadow frustum is **view-fitted and
texel-snapped at 4096** and is fitted here, *not* in `fitMap`. Texel snapping is what stops
shadow edges crawling as the camera pans — without it the whole map shimmers.

**Tone mapping is `THREE.NeutralToneMapping`**, exposure 2.75 day → 1.9 night. Not ACES. This is
measured, not aesthetic: ACES crushed sun-lit moss to L*≈8 against a palette value of L*≈22.
`toneMapping`, `toneMappingExposure`, `shadowMap.*`, `setSize`, `setPixelRatio` and
`info.autoReset` are yours alone — R_POST must not touch them.

`setTimeOfDay(t)` drives the lighting rig and exposure. `setTerrain(t)` is called exactly once
and is what makes `heightAt` real. `fitMap(map)` is called once by `buildMapMeshes`.

Zero `MeshLambertMaterial` may remain. Any material you need comes from the kit.

**Gate:** `npx tsc --noEmit -p games/rift/client` shows no error in `scene.ts`; the client
builds; a smoke run shows a rendered frame with `scene.environment !== null`.

---

### R_POST

```
Task:        The post-processing stack.
Model tier:  MEDIUM
Depends on:  contract only (installs itself via the frozen setFramePass seam)
Owns:        client/src/render/post.ts
```

Net-new. Export `createPost(scene: SceneHandle): PostHandle` where
`PostHandle = { resize(): void; setTimeOfDay(t: number): void; enabled(): boolean }`.

**Pass order is fixed by `STYLE_BIBLE` §6 and is not yours to reorder:**

```
RenderPass -> GTAO/SSAO -> layer-masked selective bloom -> colour grade + vignette
           -> OutputPass -> SMAA/FXAA
```

- Install the composer by calling `scene`'s `setFramePass` **at construction**. You are the only
  legal caller, ever. There is no stacking — a second install silently orphans the first composer.
- **Bloom is layer-masked on `BLOOM_LAYER`, never a luminance threshold.** A luminance threshold
  blooms sunlit stone and washes the whole map; the layer mask is what makes only crystal and
  ability FX glow.
- **Graceful degradation:** if any pass fails to construct, call `setFramePass(null)`, return a
  handle whose `enabled()` is `false`, and let the renderer draw directly. A playable un-post-
  processed frame is the required failure mode. A blank canvas is not.
- `setTimeOfDay(t)` adjusts grade/vignette only. **Do not touch `renderer.toneMapping` or
  `toneMappingExposure`** — R_SCENE owns those and `OutputPass` inherits them.
- `resize()` takes no arguments by design: read size and pixel ratio back off the renderer, which
  `SceneHandle.resize()` has already set. There is no resize hook on the core seam, so also
  self-detect drawing-buffer size changes from inside your frame pass.
- Do not re-enable `renderer.info.autoReset` and never call `renderer.info.reset()`. Either
  collapses the draw-call meter to ~1 and silently voids the budget gate.
- Disabling a pass to save frame time is a **banned** regression. If you are over budget, reduce
  capture resolution, not the stack.

**Gate:** typecheck clean for `post.ts`; a smoke run shows `enabled() === true` and a composed
frame; forcing a pass constructor to throw yields `enabled() === false` and a still-visible frame.

---

### R_TERRAIN

```
Task:        The terrain heightfield — elevation, cliffs, river, lane paving.
Model tier:  LARGE — it defines the map's whole read.
Depends on:  contract only
Owns:        client/src/render/terrain.ts
```

Net-new. Export `createTerrain(scene: SceneHandle, map: MapDef): TerrainHandle` where
`TerrainHandle = { ready(): boolean }`.

Build a heightfield mesh from `map.terrain.grid` — `ELEV_LOW` and `ELEV_HIGH` plateaus joined by
cliff faces and ramps. This must agree **exactly** with the sim: what looks like a cliff must be
impassable and what looks like a ramp must be walkable, or players will fight the map. Sample
the same grid the sim samples; do not re-derive geometry from lane positions.

- Surface assignment by `TerrainKind`: `ground`→groundMoss/groundDirt blend, `lane`→lanePaving,
  `high`→groundMoss over cliffRock, `cliff`→cliffRock, `river`→riverWater (+ wetRock margins),
  `foliage`→ground under R_VEG's planting, `ramp`→lanePaving-ish worn track, `base`→monumentStone.
  All via `surface()`. Blend with the vertex-colour attribute as a *multiplicative* mask only.
- **Cliff faces need to read as rock, not as extruded ground.** Give them their own surface, their
  own UV scale, and enough vertical detail that the silhouette is not a clean extrusion — that
  clean extruded look is the single biggest tell of a toy map.
- **Vertex-colour law:** the heightfield does not go through `bake()`, so you must call
  `whiteVertexColors(geo)` before handing it to a `surface()` material and before `bakeVertexAO`.
  Skip this and it renders black.
- **UV law:** 1 UV unit ≙ 1 world metre. Never set `texture.repeat`; scale UVs in geometry space.
- Bake per **16×16 m chunk**. Use `bakeChunked(parts, budgetMs)` so construction is time-sliced;
  `ready()` returns false until the last chunk lands. **Your cold-load budget is 150 ms.**
- The river is **visual only** — no gameplay effect, by explicit design in `DESIGN_DELTA.md`.
  Do not slow, damage, or reveal units in it.

**Gate:** typecheck clean; terrain visible in a smoke capture; chunk construction stays inside
150 ms; draw-call contribution reported in your summary.

---

### R_VEG

```
Task:        Trees, ferns, ground cover — the jungle.
Model tier:  MEDIUM
Depends on:  contract only
Owns:        client/src/render/vegetation.ts
```

Net-new. Export `createVegetation(scene: SceneHandle, map: MapDef): VegetationHandle`.

- **≥6 tree archetypes**, 18–40 parts each (`STYLE_BIBLE` §7). One `InstancedMesh` per archetype
  — this is non-negotiable for the draw-call budget. Ferns and ground cover likewise instanced.
- Placement via `scatter()` with a seed derived from `map.lanes` only, so it is reproducible.
  Plant on `foliage` and `ground` cells; **never** on `lane`, `river`, `ramp`, `base` or `cliff`.
  Respect the lane corridor — vegetation must not encroach on walkable lane width, because there
  is no collision on it and players will read it as blocking when it is not.
- Densities from `STYLE_BIBLE` §8. Sample `heightAt` for placement Y — it is real by the time you
  are constructed (`setTerrain` runs first in `onBegin`).
- Instance geometry does not pass through `bake()` → `whiteVertexColors` applies. Use the
  per-instance colour attribute for subtle hue/value variation so a thousand copies of one tree
  do not read as wallpaper. Keep variation multiplicative and small.
- **Cold-load budget 150 ms**; time-slice with `bakeChunked`. `ready()` false until done.
- Foliage that the sim treats as concealing should read as visually dense from the camera angle.
  A player must be able to guess where they are hidden.

**Gate:** typecheck clean; vegetation visible; instanced draw calls counted and reported;
construction inside 150 ms.

---

### R_MESH_SHARED — shared rules, read by all four mesh tasks

Four independent net-new modules in a net-new directory. Same shape, so the shared rules are
stated once here; each task owns exactly one file and must not create the others. **This is not
a task.** If you were dispatched as `R_MESH_HERO`, `R_MESH_CREEP`, `R_MESH_CAMP` or
`R_MESH_STRUCT`, read this section first, then your own `### R_MESH_*` section below.

**Shared rules for all four.** Every module returns `UnitBuild`:

```ts
interface UnitBuild {
  readonly body: BakedMesh;
  readonly anim: THREE.BufferGeometry | null;
  readonly animKind: 'orbit' | 'bob' | 'spin' | null;
  readonly animY: number;
  readonly barH: number;
  readonly barW: number;
}
```

- Build parts with the kit primitives (`box`, `cyl`, `cone`, `sphere`, `ico`, `capsule`, `lathe`,
  `ribbon`), assign each part a `SurfaceId`, and `bake(parts)`. `bake()` supplies the white
  vertex-colour default, so you do not call `whiteVertexColors` on baked output.
- Per-part colour is a **surface**, not a vertex paint — use `surface(id, tint)`. `paintGeo` is
  gone and baking albedo into vertex colours double-multiplies under PBR.
- Team identity comes from tinted trim on a small number of parts, not from tinting the whole
  model. Read `STYLE_BIBLE` §7 for the silhouette law before you model anything: **silhouette
  first, detail second.** These are seen at ~40–110 px tall; a shape that is not readable as a
  black cutout is wasted geometry.
- Glow requires `markBloom(obj)`. Emissive alone does not bloom.
- No per-frame allocation. Build once; the caller pools and reuses.
- Call these builders once per archetype, never per entity.

**Gate (all four):** typecheck clean for the owned file; a smoke render of every archetype the
module builds; part counts inside the budget, reported per archetype in your summary.

---

### R_MESH_HERO

```
Task:        Hero meshes — the modules that carry the art bar.
Model tier:  LARGE
Depends on:  contract only
Owns:        client/src/render/meshes/heroes.ts
```

Read `### R_MESH_SHARED` above first — its rules bind you.

`export function buildHero(id: HeroId, team: EntTeam): UnitBuild`

**45–70 parts.** One distinct silhouette per `HeroId` in `HERO_LIST` — a player must identify the
hero from shape alone at gameplay zoom. Read `heroById(id)` for role/visual hints and honour
them. Weapon and headgear are the two strongest silhouette cues at this size; spend parts there,
not on faces. At `CAM_MIN_H = 11` a hero is roughly 70 px tall, which is what makes this part
budget worth spending at all — anything that reads only above that is wasted.

---

### R_MESH_CREEP

```
Task:        Lane creep, summon, ward and projectile meshes.
Model tier:  MEDIUM
Depends on:  contract only
Owns:        client/src/render/meshes/creeps.ts
```

Read `### R_MESH_SHARED` above first — its rules bind you.

`export function buildCreep(kind: EntKind, team: EntTeam): UnitBuild`

**22–35 parts.** Covers `melee`, `ranged`, `siege`, `shade`, `ward`, `proj`. Melee/ranged/siege
must be distinguishable at a glance — last-hitting depends on it, so this is a gameplay
requirement, not an art one. Siege reads bulky and slow; ranged reads light with a visible
implement; `shade` reads translucent/spectral and is the one creep that may use `emissiveSurface`
+ `markBloom`. Do not build camp creeps here — those are R_MESH_CAMP's.

---

### R_MESH_CAMP

```
Task:        Neutral jungle camp creature meshes.
Model tier:  MEDIUM
Depends on:  contract only
Owns:        client/src/render/meshes/camps.ts
```

Read `### R_MESH_SHARED` above first — its rules bind you.

`export function buildCamp(tier: 'pack' | 'brute' | 'hive'): UnitBuild`

**25–40 parts.** **Neutral palette only — no team colour, ever.** These are `team === 2`; a
player reading one as an enemy creep is a gameplay error, not a cosmetic one. Note the signature
takes no team, deliberately. The three tiers must be distinguishable at a distance by mass and
height, because that silhouette is how a player judges whether a camp is safe to take before
committing.

---

### R_MESH_STRUCT

```
Task:        Tower, guard and ancient meshes — the map's landmarks.
Model tier:  LARGE
Depends on:  contract only
Owns:        client/src/render/meshes/structures.ts
```

Read `### R_MESH_SHARED` above first — its rules bind you.

`export function buildStructure(kind: StructureKind, team: TeamId): UnitBuild`

`StructureKind` is `'tower' | 'guard' | 'ancient'`. **Towers 55–80 parts, ancients 110–160.**
Note this signature takes `TeamId`, not `EntTeam` — structures are never neutral.

These are the tallest things on the map and are what orient a player who has just panned; make
them read from across the map. Make a damaged-vs-healthy read possible if it is cheap. Crystal
and gold accents are the legitimate `markBloom` targets here — the ancient should be the single
brightest thing in a wide base shot.

---

### R_MAPMESH

```
Task:        Static map bake on PBR; place structures from the new builders.
Model tier:  MEDIUM
Depends on:  R_MESH_STRUCT, R_TERRAIN
Owns:        client/src/render/mapMesh.ts
```

562 lines exporting `buildMapMeshes(scene: SceneHandle, map: MapDef): void`. Six `core.mat(...)`
call sites (lines 248, 276, 300, 306, 372, 556) — all break, all become `surface()`.

- **Delete the ground and lane geometry.** R_TERRAIN owns the ground now; two modules drawing
  ground z-fight. Keep decorative props, curbs, base structures and landmarks.
- Structures come from `buildStructure(kind, team)`. Do not model them here any more.
- Place props using `map.terrain.landmarks` and `heightAt` so nothing floats or sinks.
- Bake per 16×16 m chunk; instance repeated props. **Cold-load budget 100 ms.**
- `fitMap(map)` is still called from here, exactly once per match. The sun shadow frustum is
  **no longer** fitted here — R_SCENE does it.
- Zero `core.mat`, zero Lambert.

**Gate:** typecheck clean; no z-fighting with terrain in a smoke capture; inside 100 ms; draw
calls reported.

---

### R_UNITS

```
Task:        Rewire unit rendering onto the four mesh builders and PBR.
Model tier:  LARGE — 1253 lines, the heaviest client rewrite.
Depends on:  R_MESH_HERO, R_MESH_CREEP, R_MESH_CAMP
Owns:        client/src/render/units.ts
```

52 KB, exports `createUnits(scene: SceneHandle, map: MapDef): UnitsHandle`. Today it builds every
hero/creep/summon/ward/projectile mesh inline, with 14 `MeshLambertMaterial`, one
`core.vertexMat()` at line 568, and a `paintGeo` import.

- **All inline mesh construction is deleted** and replaced by calls to `buildHero`, `buildCreep`,
  `buildCamp` — one call per archetype at init, then pooling and reuse. `buildStructure` is
  R_MAPMESH's, not yours.
- Remove the `paintGeo` import (it no longer exists) and the `core.vertexMat()` call. Keep
  importing `CAMERA_PITCH_DEG` / `cameraNormalY` / `cameraNormalZ` from `./scene.js`, and
  `sceneCore` from `./core.js`.
- **Handle `EntTeam`**: `InterpEnt.team` is now `TeamId | 2`. Neutrals get the neutral palette and
  must never be tinted with a team colour. Guard every per-team array index with `isPlayerTeam`
  — a raw `[2]` index into a 2-tuple is the exact failure this widening invites.
- Render the three camp kinds (`campPack`/`campBrute`/`campHive`) via `buildCamp`.
- Preserve everything that already works: pooling, health bars (`barH`/`barW` now come from
  `UnitBuild`), ghost fade, selection ring, order markers, `registerPick`/`unregisterPick` with
  numeric `userData.entId`, and the existing procedural animation driven by `animKind`/`animY`.
  **`unregisterPick` on despawn is mandatory** — a stale entry keeps a dead entity clickable and
  holds its geometry alive.
- Units must sit on the terrain: use `heightAt` for Y.
- No per-frame allocation in `sync()`. It runs every frame over every visible entity.

**Gate:** typecheck clean; smoke run shows heroes, creeps, camps and structures placed on
terrain with health bars and working selection; zero Lambert; draw calls reported.

---

### R_FX

```
Task:        Combat FX on PBR + bloom.
Model tier:  MEDIUM
Depends on:  contract only
Owns:        client/src/render/fx.ts
```

334 lines, `createFx(scene: SceneHandle): FxHandle`. One `core.mat(APAL.paper)` at line 85, three
Lambert constructions.

Keep the whole `FxHandle` surface: `burst`, `tracer`, `shake`, `damageNumber`, `tick`.

- Replace all four material sites with kit surfaces / `emissiveSurface`. Ability and impact FX are
  the legitimate bloom targets — `markBloom` them. Do not raise `emissiveIntensity` to fake glow
  on an unmarked object; it will not bloom and will just blow out the grade.
- Pooled FX meshes do not go through `bake()` → `whiteVertexColors` applies, once at pool
  construction, **never per frame**.
- `setShake` is state, not an impulse: you must write `(0, 0)` when a shake ends or the camera
  stays offset forever.
- `damageNumber` stays DOM-on-overlay. `worldToScreen` returns `false` when the point is behind
  the camera or outside the depth range — when it does, `out` is untouched and you must hide the
  node rather than draw it at a stale position.
- No per-frame allocation in `tick(dtMs)`.

**Gate:** typecheck clean; smoke capture shows bursts/tracers glowing through the bloom pass and
damage numbers tracking correctly; zero Lambert.

---

### R_FOG

```
Task:        Fog of war over real terrain.
Model tier:  MEDIUM
Depends on:  contract only
Owns:        client/src/render/fog.ts
```

517 lines, `createFog(scene: SceneHandle, map: MapDef): FogHandle`. One Lambert.

Keep `maskCanvas`, `update(snap)`, `isVisible(x, z)`.

- Replace the Lambert; the fog overlay must sit correctly over a heightfield rather than a flat
  plane — sample `heightAt`, or project in a way that does not float above valleys or sink into
  ridges. Fog visibly detached from the ground is an immediate tell.
- Mirror the server's vision rules closely enough that the client does not show a unit the server
  considers hidden, or hide one it considers visible. The server is authoritative; you are
  presenting its `snap`, not re-deriving truth.
- Night reduces hero and creep vision by up to 25%. Read `dayPhase` off the snapshot.
- The explored-area accumulation must stay cheap — no per-frame allocation, no full-canvas
  readback per frame.

**Gate:** typecheck clean; smoke capture shows fog conforming to terrain, explored area
persisting, and the unexplored region fully occluding.

---

### R_MINIMAP

```
Task:        Minimap over the real terrain, with camps.
Model tier:  SMALL
Depends on:  contract only
Owns:        client/src/ui/minimap.ts
```

212 lines, `createMinimap(parent: HTMLElement): UiHandle`. 2D canvas.

- Draw terrain: elevation as a value step (high ground lighter), river, and jungle/foliage
  regions. This is the player's only map-wide read of the terrain, so it must be legible at
  ~200 px, not pretty at 800 px.
- Draw camp blips in a neutral colour, distinct from both team colours, with alive/dead state.
- Preserve click-to-pan and drag-to-order exactly. Coordinate mapping must stay correct against
  the map side length.
- Palette from `APAL` only. Respect the value-ladder law — separations are enforced by
  `valueLadder.test.ts` and may be extended, never weakened.

**Gate:** typecheck clean; smoke capture shows terrain, camps, and blips; click-to-pan still maps
to the right world position.

---

### R_HUD

```
Task:        HUD polish + day/night and jungle affordances.
Model tier:  MEDIUM
Depends on:  contract only
Owns:        client/src/ui/hud.ts, client/src/style.css
```

967 lines, `createHud(parent: HTMLElement): UiHandle`, plus the stylesheet.

- Keep every existing element: portrait, health/mana/XP, ability and item bars with cooldowns,
  gold, clock, scoreboard, event feed.
- Add a **day/night indicator** driven by `snap.dayPhase`. It matters to the player because night
  cuts vision — make it readable at a glance, not decorative.
- Raise the visual quality to match the new world art: the HUD is in every single judge shot and
  a flat HUD over a PBR world reads worse than either would alone. `STYLE_BIBLE` §0 says what to
  chase from the benchmark and what explicitly not to.
- Palette from `APAL` / `APAL_CSS_VARS`. Do not hard-code colours in the stylesheet.
- The HUD must not occlude the play area more than it does today.

**Gate:** typecheck clean; smoke capture of the live HUD; no layout regression at 1920×1080 and
at the harness's other viewports.

---

## §4 Task spec — integration

### R_WIRE

```
Task:        Wire the whole thing together. The only genuinely serial step.
Model tier:  LARGE
Depends on:  every other module
Owns:        client/src/wire.ts, client/src/game.ts, client/src/net.ts,
             client/src/interp.ts, client/src/interp.test.ts, client/src/ui/nameLabels.ts
```

These six files are grouped into one task precisely because they cannot be split — they are the
seam where the widened `EntTeam`, the new snapshot fields and the new module construction order
all meet. Four of them were previously *unowned*, which was a fatal gap the pre-freeze gauntlet
caught.

**1. `net.ts` — the snapshot validator is currently a landmine.** It hard-rejects
`team === 2` and rejects the camp `EntKind`s, and — worse — **one bad entity nulls the entire
snapshot**, so a single camp on the wire would blank the whole frame rather than dropping one
unit. Fix all three:

- `teamOf` accepts `0 | 1 | 2` and returns `EntTeam`.
- `entKindOf` accepts `campPack`, `campBrute`, `campHive`.
- Add `dayPhase` validation: a finite number, clamped to `[0, 1]`.
- **A malformed entity is skipped, not fatal.** Drop the entity, keep the snapshot, and count
  the drop so it is diagnosable. Never return `null` for the whole snapshot because of one
  entity.

**2. `interp.ts` + `ui/nameLabels.ts` — the `EntTeam` widening.** `InterpEnt.team` and
`GhostEnt.team` are `TeamId | 2` in the frozen contract. Both files index per-team structures;
every such index needs `isPlayerTeam` narrowing. Name labels must not render a team-coloured
label for a neutral. `interp.test.ts` is yours — extend it to cover neutral entities through
interpolation and ghost fade.

**3. `game.ts` — `CAM_MIN_H` becomes `11`** (was 18). This is a measured change, not taste: at
`camH 18` a hero occupies roughly 40 px of a 1080p frame, at which size the 45–70 part hero
silhouettes the mesh tasks are building are entirely wasted. `STYLE_BIBLE` §5 records the
measurement. Verify the camera still cannot clip into terrain at the new minimum.

**4. `wire.ts` — construction order is contractual, not stylistic.** In `onBegin`:

```
setTerrain(buildMap(begin.lanes).terrain)   <- FIRST STATEMENT, always
  ... then, in any order:
buildMapMeshes(scene, map)                  (also calls fitMap, once)
createTerrain(scene, map)
createVegetation(scene, map)
createUnits(scene, map)
createFog(scene, map)
```

`heightAt` returns `0` for every input until `setTerrain` runs, and terrain, vegetation and
mapMesh all sample it while building. Get this order wrong and the entire world builds flat at
y=0 — with no error, no warning, and a smoke test that still renders something.

`createPost(scene)` is constructed at wire time immediately after `createScene`, before any
map-shaped module.

**5. Route `dayPhase` into both sinks.** `setTimeOfDay` deliberately exists twice — on
`SceneHandle` (lighting + exposure) and on `PostHandle` (grade + vignette) — because the scene
holds no reference to the post stack. You hold both handles, so you route `snap.dayPhase` into
both, with the same value and the same 0=day/1=night scale.

**6. `window.__rift.setDayPhase(t)`** pins the cycle for captures; `null` resumes snapshot-driven
updates. The judge harness depends on this — without it no night shot is reproducible.

**7. Verify the seam actually connected.** `sceneCore()` is an unchecked cast to a `.core`
property. If `createScene` ever returns a handle without it, every consumer receives `undefined`
with **no type error anywhere**. Add a startup assertion that `sceneCore(scene)` is defined and
that `scene.environment !== null`, and fail loudly at boot rather than rendering a broken world.

**Gate — this is the integration gate for the whole build:**

```bash
cd /Users/fkesheh/projects/fps-rift
npm run typecheck > /tmp/tc.txt 2>&1; echo "EXIT=$?"     # must be fully green, whole workspace
npm run build     > /tmp/bd.txt 2>&1; echo "EXIT=$?"
npx vitest run    > /tmp/vt.txt 2>&1; echo "EXIT=$?"     # full suite
node scripts/e2e-rift.mjs                                 # two-browser end-to-end match
node scripts/verify-rift.mjs                              # budgets + judge shots
```

Unlike every other task, your gate **is** workspace-wide and must be fully green. Report the
real exit codes.
