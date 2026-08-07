# TERRAIN CONTRACT — ANCIENTS (rift)

**Status: FROZEN.** Layer-1 specification for `games/rift/shared/src/terrain.ts` and the sim/render
rules that consume it. This is §4 of `games/rift/GRAPHICS_CONTRACT.md`, split out for length.
Gameplay intent lives in `games/rift/DESIGN_DELTA.md` and binds; this document is the mechanism.

---

## 1. The governing constraint

The client **never receives a `MapDef`**. `rift_begin` carries only
`{ lanes, teamSize, startAtTick, laneAssignment }`, and the client rebuilds geometry by calling
`buildMap(lanes)` locally. Therefore:

> **Terrain is a pure, total function of the lane count.** `buildTerrain(lanes)` must be
> deterministic, allocation-free after construction, and produce bit-identical output on server and
> client. It consumes no RNG beyond the kit's seeded generator keyed on a constant seed derived from
> `lanes`, no clock, and no I/O.

Terrain is **never sent on the wire.** A terrain payload in `rift_begin` is a contract violation.

---

## 2. The data model

```ts
/** Two walkable levels only. DESIGN_DELTA §1: a continuous heightfield makes the
 *  vision and miss rules unreadable. Visual relief is a renderer concern and must
 *  never contradict the gameplay level returned here. */
export const ELEV_LOW = 0;
export const ELEV_HIGH = 1;
export type Elevation = 0 | 1;

/** Terrain classification per cell. Exactly one kind per cell. */
export type TerrainKind =
  | 'ground'    // open low ground
  | 'lane'      // lane corridor; always ELEV_LOW, always passable, never foliage
  | 'high'      // high-ground plateau
  | 'cliff'     // impassable transition between levels; blocks movement, not vision
  | 'river'     // low ground, passable, purely visual/navigational (DESIGN_DELTA §4)
  | 'foliage'   // passable low ground that grants concealment
  | 'ramp'      // passable low->high transition; the only legal crossing of a cliff ring
  | 'base';     // team base platform; ELEV_HIGH, passable

export interface TerrainGrid {
  readonly side: number;          // metres; equals MapDef.side
  readonly res: number;           // cells per metre — frozen at 1
  readonly dim: number;           // side * res, the row/column count
  readonly kind: Uint8Array;      // dim*dim, values index TERRAIN_KINDS
  readonly elev: Uint8Array;      // dim*dim, ELEV_LOW | ELEV_HIGH
}

export interface CampDef {
  readonly id: number;            // stable, dense from 0
  readonly tier: 'pack' | 'brute' | 'hive';
  readonly x: number;             // clearing centre
  readonly z: number;
  /** Which half the camp sits in, for mirroring and validation only. Camps are
   *  NEUTRAL and are never owned by this team. */
  readonly half: TeamId;
}

export interface TerrainDef {
  readonly grid: TerrainGrid;
  readonly camps: readonly CampDef[];
  /** Hand-placed landmark anchors for the renderer (STYLE_BIBLE §8). Gameplay-inert. */
  readonly landmarks: readonly { readonly kind: string; readonly x: number; readonly z: number }[];
}
```

`MapDef` gains **one required field**: `readonly terrain: TerrainDef`. It is required, not optional —
`exactOptionalPropertyTypes: true` makes optional fields awkward at every consumer, and a silently
absent terrain would produce a game that runs with no cliffs and no camps, which is exactly the kind
of failure that hides. The two test files that build `MapDef` object literals
(`sim/abilities.test.ts:16`, `sim/vision.test.ts:101`) are updated by their owning tasks.

### Queries — all O(1), all hot-path

```ts
export function buildTerrain(lanes: number): TerrainDef;
export function elevationAt(t: TerrainDef, x: number, z: number): Elevation;
export function kindAt(t: TerrainDef, x: number, z: number): TerrainKind;
export function isPassable(t: TerrainDef, x: number, z: number): boolean;   // !== 'cliff'
export function isConcealing(t: TerrainDef, x: number, z: number): boolean; // === 'foliage'
```

Out-of-bounds coordinates clamp to the nearest in-bounds cell; these are called with already-clamped
positions but must never throw or return `undefined` (`noUncheckedIndexedAccess` is on — index
accesses must be narrowed, not asserted).

**A grid scan, a polygon test, or an allocation inside any of these is a contract violation.** They
run per unit per tick inside an O(sources × mobiles) double loop that is measured against the
2.5 ms tick budget.

---

## 3. Layout

Mirror symmetry is **point reflection through the map centre**, `(x,z) → (side−x, side−z)` — the same
symmetry `validateMap` already enforces for structures. Every terrain cell and every camp must
satisfy it exactly.

- **Lanes** (`'lane'`): a corridor of frozen half-width around each lane polyline from `buildMap`.
  Always `ELEV_LOW`, always passable, never foliage, never crossed by a cliff. This is a hard
  validation, not a preference — a cliff across a lane would strand every creep wave, and lane
  creeps have no pathfinding (§5).
- **Bases** (`'base'`): a disc around each ancient, `ELEV_HIGH`, passable. DESIGN_DELTA §1: the last
  stand is always uphill.
- **High ground** (`'high'`): plateaus in the jungle between lanes, `ELEV_HIGH`.
- **Cliffs** (`'cliff'`): the boundary ring between `high`/`base` and the surrounding low ground,
  impassable. Cliffs **block movement but not vision** — the vision rule is elevation-based (§4), not
  a line-of-sight raycast, which keeps it O(1) and readable.
- **Ramps** (`'ramp'`): passable transition cells cut through a cliff ring. `elevationAt` returns
  `ELEV_HIGH` on a ramp cell (a single value — a transitional return would make the uphill vision and
  miss rules non-deterministic at the boundary). Placement is fixed: **one ramp per lane where that
  lane's corridor enters a base disc**, plus one ramp per jungle plateau access. Ramp width ≥ the
  lane corridor width at base mouths.
- **River** (`'river'`): a band along the anti-diagonal through the map centre, `ELEV_LOW`, passable.
  Purely navigational and visual.
- **Foliage** (`'foliage'`): clumps in the jungle, `ELEV_LOW`, passable, concealing.
- **Camp clearings**: `'ground'`, `ELEV_LOW` or `ELEV_HIGH`, always fully enclosed by passable
  approach but never adjacent to a lane corridor — a camp that lane creeps can aggro is a defect.

### Validation — extends `validateMap`, asserted in `map.test.ts` for `lanes ∈ {1,2,3}`

1. **Mirror exactness**: for every cell, `kind[p] === kind[mirror(p)]` and `elev[p] === elev[mirror(p)]`.
2. **Lane pathability**: a `HERO_RADIUS` disc walking every lane polyline never touches a `'cliff'`
   cell (`'ramp'` cells are permitted and expected at base mouths). (Extends the existing
   structure-clearance rule with the same disc.)
3. **Connectivity**: flood-fill from each ancient over passable cells reaches **every** other
   ancient, every structure, and every camp clearing. No walkable region may be sealed off.
4. **No concave traps**: no passable cell may have impassable neighbours on 3 or more of its 4 sides.
   This is what makes the wall-slide in §5 sufficient and is why we do not need a navmesh for creeps.
5. **Camp isolation**: every camp clearing centre is at least `CAMP_LANE_CLEARANCE` from every lane
   polyline.
6. **Elevation coherence**: every `high`/`base` region is fully ringed by `cliff` **or `ramp`** cells
   where it borders low ground — no unmarked step, or units will walk uphill and the vision rule will
   read as a bug.

---

## 4. Sim rules — exact insertion points

These are the only places the sim changes. Each is a single chokepoint; the recon that established
them is authoritative.

**Vision — `sim/vision.ts`, inside `computeTeamVisible`'s pass-2 inner loop only.**
After the existing squared-distance radius test passes, apply in order:
1. **Uphill block**: if `elevationAt(source) < elevationAt(target)`, the source does not see the
   target — `continue`. High sees low freely; low never sees high.
2. **Concealment**: if `isConcealing(target)` and not `isConcealing(source)` and the pair is farther
   apart than `CONCEAL_REVEAL_RADIUS`, `continue` — **unless `target.atkTarget !== NO_ENT`, i.e. the
   target swung during the previous tick. Attacking reveals (DESIGN_DELTA §3). Ability casts do NOT
   reveal; `rift_cast` stays team-vision filtered as today. This ordering is safe because
   `computeTeamVisible` runs before `w.advance()`, so the previous tick's `atkTarget` is still
   readable.**
3. **Night**: the radius used in the distance test is `visionRadius(s) * (night ? NIGHT_VISION_MULT : 1)`
   for `hero` and creep kinds only. Wards, towers, guards and ancients are unaffected — they are lit.

The two existing bypasses are preserved exactly: `m.team === team` (own team always visible) and
`m.kind === 'proj'` (always visible). Neither is subject to terrain.
`vision.test.ts` builds a hand-made fake `World`; its owning task extends that fake with a terrain
accessor rather than importing `world.ts`.

**Combat — `sim/combat.ts`, inside `fire()` only.**
After the cooldown is stamped and `atkTarget` is set (so a miss still consumes the swing and still
draws a client tracer), before `dealDamage`:
if `elevationAt(attacker) < elevationAt(target)` then the swing misses with probability
`HIGH_GROUND_MISS`. Basic attacks only. **Abilities are unaffected** (DESIGN_DELTA §1), which is
precisely why the gate goes in `fire()` and *not* in `dealDamage`.

**Determinism — mandatory.** `createWorld` accepts `rand` and deliberately discards it; the sim is
fully deterministic today, and `balance.test.ts` measures win-rate bands over headless bot matches
that depend on that. A miss chance must therefore **not** consume an RNG stream. It uses a pure hash:

```ts
/** Deterministic, reproducible, uniform-enough in [0,1). The ONLY randomness
 *  source in combat resolution. Same inputs -> same result, on every machine,
 *  in every replay, in every test run. */
export function missRoll(tick: number, attacker: EntId, target: EntId): number;
```

Implemented as an integer avalanche hash (xorshift/multiply mix) of the three inputs, normalised to
`[0,1)`. No floats in the mix, no `Math.random`, no world state.

**A miss must be visible or it reads as a bug.** `RiftEvent` in `shared/src/protocol.ts` gains
`{ readonly t: 'rift_miss'; readonly attacker: number; readonly target: number }`, emitted from
`fire()` on a miss and filtered by team vision like `rift_cast`. R_HUD floats a `MISS` marker on it.
`protocol.test.ts` gains a case for the new event.

**Movement — `sim/movement.ts`.**
- **Lane creeps are never pathed.** Their lane corridor is validated cliff-free (§3.2), so
  `creepMotion` is unchanged. This is the design's load-bearing simplification.
- **Heroes get grid A\*.** A path is computed only when an order is issued or the current path is
  invalidated — not per tick. At most 16 heroes, so the cost is negligible. `steer()` follows the
  path's waypoints; on arrival at the final waypoint, behaviour is exactly as today.
- **Camp creeps leash** inside their clearing and never path (§6).
- **Cliff push-out**: in pass 3 of `stepMovement`, immediately before the existing bounds clamp,
  any unit inside a `'cliff'` cell is pushed to the nearest passable cell along the shortest normal,
  with the same 0.02 tangential drift the structure push-out already uses to break deadlock. §3.4
  (no concave traps) is what makes this sufficient.
- **Dashes** (`SimWorld.dash`) clamp to the nearest passable cell rather than only to map bounds —
  a dash must never end inside a cliff.
- **Ward placement** rejects impassable cells.
- The river applies **no** movement modifier (DESIGN_DELTA §4).

---

## 5. Neutral camps and the third team

`TeamId` stays `0 | 1` — it is load-bearing for players, the board, the kill tuple, structures and
the tiebreak, and widening it would ripple through every one of those. Entities widen instead:

```ts
export const NEUTRAL_TEAM = 2;
export type EntTeam = TeamId | 2;
export function isPlayerTeam(t: EntTeam): t is TeamId;   // narrowing guard
```

`Ent.team` and `EntSnap.team` become `EntTeam`. `RosterEntry.team`, `BoardEntry.team`,
`PlayerStats.team`, `StructureDef.team`, `rift_structure.team` and `rift_end.winner` **stay
`TeamId`** — structures and players are never neutral.

**The hazard, and the rule that removes it:** several structures are two-element tuples indexed by an
entity's team — `visSets`, `wardStockArr`, `ancientId/ancientX/ancientZ`, `kills`, `fountainX/Z`.
Indexing any of them with a neutral entity's team is an out-of-bounds read that TypeScript will not
catch on a `Uint8Array`-adjacent access pattern.

> **Every site that indexes a per-team tuple, array or `Record` with an entity's `team` must first
> narrow with `isPlayerTeam`.** This is a review lens and a per-task obligation: each owning task is
> responsible for finding and narrowing **every** such site in the files it owns — the files known to
> contain them are `sim/world.ts`, `sim/units.ts`, `sim/combat.ts`, `sim/vision.ts`,
> `sim/abilities.ts` and `room.ts`. Line numbers are deliberately not given: they drift, and a task
> that fixes only a listed line and misses an unlisted one has produced exactly the out-of-bounds
> read this rule exists to prevent. Grep your owned files for indexing by `.team` and narrow all of
> them.

New entity kinds: `'campPack' | 'campBrute' | 'campHive'`, added to `EntKind` and to the
`isUnitTargetable` whitelist in `abilities.ts` (otherwise camps are immune to every ability — a
silent, complete failure of the feature).

**Camp behaviour:**
- Spawned via the existing `spawnMobile` recipe with **`lane = -1`**, `owner = NO_ENT`,
  `team = NEUTRAL_TEAM`. A camp creep with `lane >= 0` will walk down a lane polyline — the single
  most likely way this feature breaks.
- `stepMovement`'s `switch (e.kind)` gains a camp branch; it must **not** fall through to
  `creepMotion`.
- **Camps are hostile to both teams** for free, because `attackable()` tests `t.team !== e.team`,
  and abilities' `teamOk`/`sideOk` treat a differing team as enemy. This is the desired semantics.
- **But the converse must be suppressed for lane units only:** camp creeps are excluded from
  `nearestEnemyMobile` **when the calling entity is a lane creep or a summon** — that is the only
  auto-aggro path that matters. `nearestEnemyAny` (hero attack-move) **keeps** camps acquirable, or
  no hero and no bot could ever engage one. `towerTarget` needs no change: it already restricts
  targets to wave creeps, summons and heroes. Combined with the §3.5 clearance validation, camps
  never interact with lanes.
- **Leash**: a camp creep that moves beyond `CAMP_LEASH_RADIUS` from its clearing centre returns to
  it and restores to full hp on arrival. A camp that can be dragged into a lane is a defect.
- **Respawn**: the camp's timer starts when its last creep dies; the camp respawns whole.
- Deaths route through the existing `killCreep` path automatically. Last-hit bounty is correct
  unchanged for neutrals. **`splitXpAmongHeroes` is NOT correct unchanged: its `e.team !== d.team`
  filter admits BOTH teams when `d.team === NEUTRAL_TEAM`. S_COMBAT amends it so that when
  `d.team === NEUTRAL_TEAM`, xp is split among living heroes of `d.lastHitBy`'s team only; the
  flat-ground creep behaviour is unchanged.** `combat.test.ts` gains a case asserting an enemy hero
  inside `XP_SHARE_RADIUS` of a cleared camp receives zero xp.

**New sim phase**: `export function stepCamps(w: SimWorld): void` in a new `sim/camps.ts`, called
from `advance()` **between `stepDeaths` and `stepUnits`** — after deaths are reaped so a camp can
start its respawn timer on the same tick, and before end checks.

**Camp and pathing state (Layer-1, in `sim/types.ts`).** Without this, S_CAMPS and S_MOVE would have
to negotiate an interface, which the contract forbids:

```ts
export interface CampState {
  readonly id: number;
  readonly def: CampDef;
  readonly memberIds: EntId[];
  aliveCount: number;
  respawnAtTick: number;   // -1 = alive
}
```

and `Ent` gains `path: readonly Vec2[] | null; pathIndex: number;`.

`SimWorld` (owned by S_WORLD) constructs and exposes `readonly camps: CampState[]`, populated from
`map.terrain.camps` at construction. `stepCamps` reads and mutates that array only; it never
allocates per tick. Hero A\* writes `Ent.path`/`Ent.pathIndex`, both reset to `null`/`0` on every new
order.

---

## 6. Day / night

A match-clock derived cycle; like terrain, it is a pure function and needs no wire payload for the
sim — but the **client must render it in sync**, so `rift_snap` gains one field:

```ts
readonly dayPhase: number;   // 0 = full day, 1 = full night; continuous, wraps
```

Derived from `matchTick` and `DAY_PERIOD_S`, starting at full day. The renderer feeds it straight to
`SceneHandle.setTimeOfDay`. The sim reads only whether it is night for the vision multiplier;
`dayPhase` on the wire is what keeps a reconnecting client's lighting correct.

---

## 7. New config constants (pure data, in `shared/src/config.ts`)

Every value below must be traceable to a balance target in `DESIGN_DELTA.md`. A reviewer checks that
mapping; a number with no target behind it is a finding.

Terrain geometry: lane corridor half-width, base platform radius, river band width, plateau and
foliage coverage fractions, `CAMP_LANE_CLEARANCE`.
Combat/vision: `HIGH_GROUND_MISS` (DESIGN_DELTA §1 fixes this at 0.25), `CONCEAL_REVEAL_RADIUS`,
`NIGHT_VISION_MULT`, `DAY_PERIOD_S = 600` (a full day+night cycle per 10 minutes of match time, so a
typical match sees two cycles — enough for night to matter, per DESIGN_DELTA §5, without the map
strobing).
Camps: per-tier `CreepTuning` (reusing the existing interface), per-tier composition counts, per-tier
respawn seconds, `CAMP_LEASH_RADIUS`, and camp counts per half by lane count (2/3/4).

---

## 8. Test impact — owned, not discovered

Each owning task updates its own suites; no task touches another's.

| Suite | Impact |
|---|---|
| `shared/map.test.ts` | new terrain validation cases (mirror, pathability, connectivity, traps, camp clearance, elevation coherence) |
| `shared/protocol.test.ts` | `dayPhase` on `rift_snap` |
| `sim/vision.test.ts` | fake `World` grows a terrain accessor; uphill-block, concealment, night cases |
| `sim/combat.test.ts` | miss-chance cases; existing cadence/mitigation suites must still pass unchanged on flat ground |
| `sim/world.test.ts` | cliff push-out, dash clamping, hero A\* pathing |
| `sim/units.test.ts` | unchanged unless camps land in `stepUnits` — they do not; camps get their own suite |
| `sim/camps.test.ts` | **new**: spawn, aggro, leash, respawn, bounty/xp, no lane interaction |
| `sim/abilities.test.ts` | `MapDef` literal gains `terrain`; camp kinds targetable |
| `bots.test.ts` | `BotPercept` gains camps; every `makePercept` literal updated; a bot with a jungle role attack-moves to the nearest visible camp clearing and clears it — assert a bot damages a camp |
| `room.test.ts` | fog filtering with neutral entities; camp percept plumbing; `dayPhase` in the pushed snapshot. (It contains no `MapDef` object literals — do not go looking for any.) |
| `balance.test.ts` | **expected to move, within a hard tolerance.** No band midpoint may move more than **15%** without an explicit orchestrator amendment; a larger move is a finding, not a re-measurement. Every band edit ships the measured before/after run in the test file's header. **New required assertions:** jungle gold-per-minute and xp-per-minute versus lane gold/xp-per-minute (DESIGN_DELTA §2's "jungle income below lane income"), and time-to-level-6 for a jungling bot (target 6–7 min). These depend on the S_BOTS jungle behaviour required in §5; if that behaviour is cut, the corresponding DESIGN_DELTA §2 targets are struck as unverifiable. |
