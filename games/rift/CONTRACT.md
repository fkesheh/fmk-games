# ANCIENTS (rift) — FROZEN CONTRACT + BUILD SPEC

This file is the Layer-2 contract for the mini-MOBA. It is embedded verbatim in
every implementer prompt. The Layer-1 frozen code is:

- `games/rift/shared/src/`: `config.ts`, `types.ts`, `ability.ts`, `hero.ts`,
  `item.ts`, `protocol.ts`, `palette.ts`, `index.ts`
- `games/rift/server/src/sim/types.ts` — the sim/bots/room seam (types only)
- Workspace manifests: `games/rift/{shared,server,client}/package.json`,
  `tsconfig.json`, `client/vite.config.ts`, `client/index.html`

**Immutability rule.** No implementer may modify, rename, or re-export any
Layer-1 file, nor change any public signature specified here. If the contract
is wrong, the task fails back to the orchestrator with the contradiction cited;
nobody patches around it locally. The single permitted cross-file carve-out:
adding the one `export * from './map.js';` line to `shared/src/index.ts` is
owned by the map task (T1) and nobody else.

Handoff context: `docs/RIFT_HANDOFF.md` (decisions + reasoning). Model game:
`games/wordbomb/` (module shape), `games/kart/` (registry + validate pattern,
three.js world + DOM HUD), `games/fps/` (bots discipline, late-joiner
displacement). Repo laws: `VISUAL_UPGRADE.md`, `CONTRACT.md`, `UX_BIBLE.md`.

---

## 1. Game summary

Mini MOBA. Two teams (2v2 to 8v8, locked at match start) push generated lanes,
last-hit creeps for gold, buy items, level to 10, destroy towers, and win by
destroying the enemy Ancient. Sim 20Hz server-side, intent-only wire (orders
in, fog-filtered snapshots out), no client prediction. Bots fill empty seats
and drive disconnected players' heroes. Overtime surge at 20:00, hard cap with
tiebreak at 30:00.

## 2. Lobby + match flow (room.ts)

Phases: `'lobby' | 'live' | 'ended'`.

- **Lobby.** Humans join; each seat is auto-assigned the smaller team (ties ->
  team 0). On join the room sends `rift_hello` + a fresh `rift_lobby`, and
  broadcasts `rift_roster`. `rift_lobby` is re-broadcast to all seated clients
  on EVERY lobby change (join, leave, pick, start-press, countdown).
- **Picks.** `rift_pick` is accepted in lobby for ANY valid hero — duplicates
  are allowed and expected: there are six heroes and up to sixteen seats, so
  once six humans have picked, uniqueness would leave the rest with nothing
  legal to pick. Invalid input (an unknown hero id, or a pick outside the
  lobby phase) is ignored in silence and never throws. Accepted picks
  broadcast via `rift_pick` events. Auto-assignment and bot fill cycle
  `HERO_LIST` from the first un-picked hero (picked-hero set collapses
  duplicates for this purpose only), wrapping with duplicates allowed there
  too — at teamSize > 3 there will be duplicate heroes on a team, which is
  legal and expected.
- **canStart** = phase is lobby AND no countdown running AND connected humans
  >= `MIN_PLAYERS` (1). Any seated human may send `rift_start`; illegal presses
  are ignored in silence. On accept: `countdownEndsAt = now +
  LOBBY_COUNTDOWN_MS`, one `setTimeout`, then the match locks.
- **Lock.** teamSize = `settings.teamSize ?? auto` where auto = smallest size
  in [2..8] seating every human (ceil(humans/2), clamped). lanes =
  `LANES_FOR_TEAM_SIZE[teamSize]`. Unpicked players get heroes per the cycle
  rule above, in join order. Lane assignment: round-robin across lanes per
  team in join order (seat i -> lane i % lanes), for humans AND bots — sent in
  `rift_begin.laneAssignment`. Bots fill every seat to teamSize per team
  (`Bot N` names, insertion order = join order). `buildMap(lanes)` ->
  `rift_begin` -> 20Hz interval (period `1000 / TICK_RATE / speed`).
- **Live.** Orders queue per player and apply at tick start. Bots think before
  the world ticks. Vision sets compute per team. Each connected human gets a
  fog-filtered `rift_snap`; events go through `{t:'event', ev}`.
- **Late joiner (any phase).** If any bot seat exists, the joiner displaces the
  oldest bot (normal remove flow) and INHERITS its hero, level, gold, items,
  and position — via the normal join path. If no bot exists and a seat is free
  under the locked teamSize, the joiner gets a fresh level-1 hero at their
  team's fountain (cycle-assigned hero). `info().players` counts CONNECTED
  HUMANS only (same as `playerCount()`, which the platform's own room_full
  guard uses) — never seats, since bot-fill and ghost seats from
  disconnect-without-leave would otherwise over-report a room as full.
  `info().label` is `'<teamSize>v<teamSize>'` once locked, `'lobby'` before.
- **Disconnect.** `removePlayer(id)` with permanent=false: the hero stays in
  the sim, driven by a fresh bot brain until `addPlayer(id, name, resume)`
  rebinds it (score, items, cooldowns intact). permanent=true (explicit leave):
  the seat converts to a bot permanently. `stalePlayers()` returns `[]` — the
  platform's own liveness handles dead sockets.
- **Ended.** An Ancient falls -> `rift_end` (reason 'ancient'). At
  `OVERTIME_AT_S` the surge begins (one `rift_surge` event; wave rules per
  config). At `MATCH_HARD_CAP_S` the tiebreak order in config.ts decides;
  exact equality = draw, winner null. After `MATCH_END_MS` the room full-resets
  to lobby: bots removed, sim discarded, picks KEPT, and it WAITS there.
- `start()`/`stop()` are idempotent; no `GameRoomHandle` member ever throws;
  one bad tick is caught and logged, never kills the interval.
- `settings.speed` (1..20) is an intentional PUBLIC room option — the room
  creator's room, the room creator's rules. It is also the e2e/balance hook.

## 3. Map (T1 owns `shared/src/map.ts` + adds the barrel line)

Frozen exports (signatures fixed; bodies are T1's):

```ts
export function buildMap(lanes: number): MapDef;        // throws on lanes<1||>3
export function validateMap(map: MapDef): MapValidation; // ALL errors, never throws
export function assertValidMap(map: MapDef): void;
```

Geometry (deterministic, no rng): square `[0, side]^2`, `side = MAP_SIDE_BASE
+ MAP_SIDE_PER_LANE * (lanes-1)`. Team 0 Ancient at `(BASE_INSET, BASE_INSET)`,
team 1 at `(side-BASE_INSET, side-BASE_INSET)`. Lane paths are waypoint
polylines from team 0's Ancient to team 1's, with `E = LANE_EDGE_INSET`:

- 1 lane: mid diagonal `[(B,B) -> (side/2, side/2) -> (side-B, side-B)]`.
- 2 lanes: west-north `[(B,B) -> (E, side-E) -> (side-B, side-B)]` and
  south-east `[(B,B) -> (side-E, E) -> (side-B, side-B)]`.
- 3 lanes: both edge lanes + mid diagonal.

`B = BASE_INSET`; waypoints include both Ancients' positions as endpoints.
Lane towers per team sit at `TOWER_LANE_FRACTIONS` of path length from their
own Ancient, offset `TOWER_LANE_OFFSET` metres perpendicular to the path on
the side facing AWAY from the map centre; on the mid diagonal both sides are
equidistant, so the tiebreak there is LEFT of the OWNING team's travel
direction (team 0 walks the polyline team-0 -> team-1; team 1 walks it
reversed — equivalently, team 1's mid towers are the exact mirror image of
team 0's, which is what rule 2 demands). Guards: two per team, flanking the
Ancient perpendicular to the diagonal at `GUARD_FLANK_DIST` (sized so the
edge-to-edge gap to the Ancient is exactly `STRUCTURE_MARGIN`). Structure ids:
0..N-1, deterministic: team 0 lane towers (lane-major, near-to-far), team 0
guards, team 0 ancient, then team 1 mirrored.

`validateMap` asserts, accumulating every error with measured values:
1. waypoint/structure finiteness and bounds (inside `[0, side]` minus 1m);
2. **mirror symmetry**: reflecting every team-0 structure through the map
   centre lands exactly on a team-1 structure of the same kind (and vice
   versa) — both directions asserted;
3. **pathability with the real movement rule**: a disc of `HERO_RADIUS`
   walking each lane polyline in BOTH directions never intersects any
   structure's disc expanded by `HERO_RADIUS` — the two Ancients at the path
   endpoints are EXEMPT (units must reach them to attack) — and every tower's
   centre is within 6m of its lane polyline;
4. min pairwise structure EDGE-TO-EDGE clearance (centre distance minus both
   radii) >= `STRUCTURE_MARGIN`;
5. both teams have identical structure counts per kind.

`map.test.ts` (T1): `describe.each([1,2,3])` runs `assertValidMap`, plus
asserts path lengths of mirrored lanes are equal to 1e-9, tower fractions land
in both halves, and structure ids are dense `0..N-1`. **Prove the gate can
fail**: temporarily break symmetry, confirm red, revert.

## 4. Sim core (server/src/sim/)

**The seam is frozen in `server/src/sim/types.ts`** (Layer-1): the `Ent`
record, the `World` surface (incl. the `order`/`cast` intake methods),
`Order`, `AbilitiesEngine`, `SimEvent`, `SeatDef`,
`BotPercept`/`BotCommand`/`BotBrain`. T3, T4, T5, T6 all build against that
file IN PARALLEL — nobody reads another task's implementation. The ability
engine is INJECTED into the world at construction (`createWorld(...,
abilities)`), so T3 and T4 never import each other; T3's tests stub the
engine with a test double.

Pure TypeScript, no I/O, no `Date.now()` (match time is `tick * TICK_DT`), no
`Math.random` (the injected `rand`). All hot-path state preallocated;
advance() allocates nothing beyond drained event objects. Units are `Ent`
structs in flat stores keyed by entity id (mobile ids >= 1000; structure ids
are the MapDef ids; the no-entity sentinel is `NO_ENT = -1`).

- **world.ts** — `createWorld` + the `World` implementation: entity stores,
  spawn/despawn, the intake queue (`order`/`cast` — queued, validated at
  apply time, illegal input silently no-ops), the mutation surface
  (`damage/heal/stun/slow/applyAura/dash/spawnMobile/buy/spendSkillPoint/
  useItem/drainCasts/pushEvent/drainEvents`), and `advance()` — one tick,
  orchestration order:
  (1) apply queued orders, (2) `abilities.step(world)` — drains the cast
  queue via `world.drainCasts()`, executes casts, moves projectiles; cast
  SimEvents flow through `world.pushEvent()` (ability casts use slot 0-3;
  item actives use slot 4 + itemSlot), (3) buff expiry + stat recompute + passive-aura
  membership re-evaluation (every 5 ticks) + passive rank-up refresh,
  (4) movement, (5) combat, (6) deaths/loot, (7) waves/respawns,
  (8) win/overtime checks.
  Frozen signatures (the room imports these; bodies are T3's/T4's/T5's/T6's):
  `export function createWorld(map: MapDef, seats: readonly SeatDef[], rand: () => number, abilities: AbilitiesEngine): World;`
  (world.ts),
  `export function createAbilitiesEngine(): AbilitiesEngine;`
  (abilities.ts),
  `export function computeTeamVisible(world: World, team: TeamId, out: Set<EntId>): void;`
  (vision.ts — clears `out`, fills it with the mobile ids visible to `team`;
  the caller reuses two sets, one per team), and
  `export function createBotBrain(seed: number, hero: HeroId): BotBrain;`
  (bots.ts).
- **movement.ts** — heroes steer straight at their order target; structures
  are circle obstacles resolved by tangential slide (push-out + slide, no
  pathfinding — the map is open); soft unit separation between all mobiles
  (push apart at overlap, half-weight vs creeps for heroes); clamp to map
  bounds. Creeps follow their lane polyline waypoint-to-waypoint, detouring to
  attack per aggro, resuming at the nearest FORWARD waypoint. Speed =
  `(base + items) * (1 + haste) * (1 - maxSlow)`; stun zeroes movement,
  attacks, and casts. Dash moves the caster over ~0.15s, stops at structure
  edges, never crosses map bounds.
- **combat.ts** — attack cycle per `attackPeriod` when an ordered/aggro target
  is in range; all basic attacks land instantly and set `Ent.atkTarget`
  (drives `EntSnap.atk`; cleared each tick before combat runs). Physical
  damage reduced by armor: `mult = 1 - K*a/(1+K*|a|)`; magic by
  `HERO_MAGIC_RESIST` (heroes only; creeps/structures 0). Siege creeps deal
  `SIEGE_BUILDING_MULT` to structures. **Fortify**: a structure takes
  `FORTIFY_HERO_DAMAGE_MULT` from heroes while no enemy creep is within
  `FORTIFY_RADIUS`. Ancients are invulnerable while any own guard stands.
  Tower targeting: nearest enemy creep/summon in range; switches to a hero
  that damaged an allied hero within tower range in the last
  `TOWER_HERO_AGGRO_WINDOW_S`. Creep aggro: nearest enemy mobile within
  `AGGRO_RADIUS`, preferring the unit already being attacked. Attack orders
  with an illegal target (dead, own team, ward, unknown id) silently degrade
  to an attack-move toward the target's last known position if the target is
  visible, else are dropped. Lifesteal heals the attacker for the fraction of
  post-mitigation physical basic-attack damage vs units.
- **Loot** — last-hitter hero gets the bounty (killing-blow owner only).
  Creep xp splits equally among enemy heroes within `XP_SHARE_RADIUS`. Hero
  kill: killer `KILL_GOLD_BASE + KILL_GOLD_PER_LEVEL * victimLevel`
  (+`FIRST_BLOOD_BONUS` once per match); kill xp
  (`HERO_KILL_XP_BASE + HERO_KILL_XP_PER_LEVEL * victimLevel`) splits among
  ALL enemy-team heroes within `XP_SHARE_RADIUS` of the victim; non-killer
  damagers within `ASSIST_WINDOW_S` share `ASSIST_GOLD` and get assists.
  Tower bounty to every living enemy hero. Passive gold starts at match start.
  Heroes spawn with `STARTING_SKILL_POINTS` (1) and gain
  `SKILL_POINTS_PER_LEVEL` per level-up.
- **units.ts** — wave spawner (composition/growth/surge per config; waves spawn
  at each base per lane, walk toward the enemy base), structure entities,
  respawn logic, fountain heal, level-ups, **shop + inventory + skill points**:
  `buy` (fountain-radius + gold check, first free slot, wardstone stacks
  charges into an existing wardstone slot), `spendSkillPoint` (rank caps +
  `ULT_LEVEL_REQ`), ward placement (1 item charge + 1 team stock per
  `WARD_TEAM_STOCK`/`WARD_RESTOCK_S`; placing with 0 stock silently no-ops).
- **abilities.ts** — `createAbilitiesEngine()` returns the injected engine;
  its `step(world)` (advance step 2) drains the world's cast queue, validates
  and executes casts, and OWNS projectiles end-to-end: it spawns 'proj' ents
  via `world.spawnMobile`, keeps their payloads (effects, rank, homing target,
  pierce-hit set, remaining range) in an engine-private side table keyed by
  ent id, moves them each step, and applies effects on impact. The engine
  covers the 8 frozen primitives PLUS item actives (blinkstone dash, warhorn
  aura reuse the same machinery; wardstone placement lives in units.ts). Cast
  validation: alive, not stunned, not passive, rank
  >= 1, off cooldown, mana sufficient, target legal (`targeting`/`targetTeam`,
  in `castRange`; a point cast missing valid coordinates is rejected). On
  success: spend mana, set cooldown, execute effects IN ARRAY ORDER (dash
  moves the caster first, so `Shadow Strike` arrives then cuts), then push the
  `cast` SimEvent. AoE: damage/stun/slow hit enemies, heal/aura hit allies,
  within `aoeRadius` of the impact. Slows do not stack — strongest active
  wins. Auras: `radius 0` = self; `duration 0` = passive permanent (radius > 0
  passives re-evaluate membership every 5 ticks — applied by world.ts step
  (3)); active auras are timed buffs on all eligible units in radius at cast
  time. Summons spawn friendly 'shade'
  units (owner = caster) capped by `SUMMON_MAX_ACTIVE` per owner (oldest
  expires first). Projectiles: unit-targeted HOME onto their target;
  point-targeted fly straight to `range`; non-pierce applies effects to the
  first enemy unit within `radius` then despawns; pierce applies once per unit
  along the whole flight.
- **vision.ts** — `computeTeamVisible(world, team, out)` per the frozen seam:
  sources are own living heroes, creeps, summons, wards, structures (radii
  from config); squared distances; the two caller-owned sets are reused every
  tick. Structures are ALWAYS in every snapshot (position/hp public —
  `hp <= 0` means destroyed); wards are sent to their own team only; mobiles
  only when visible. Computed twice per tick (once per team).

## 5. Room + module + bots (server/src/)

- **module.ts** — `riftModule: GameModule` exactly per the wordbomb pattern:
  id `'rift'`, name `'ANCIENTS'`, devPort `5177`, minPlayers `MIN_PLAYERS`,
  maxPlayers `MAX_PLAYERS`, `createRoom` parses settings (throws on bad) and
  constructs the Room. Module-scope shared `rand = rng((Date.now() ^
  (roomSeq++ * 0x9e3779b9)) >>> 0)` for ids only; gameplay randomness is
  injected per room.
- **ports.ts** — `RoomDeps { rand: () => number }`, `RiftRoomCtor` (same shape
  as wordbomb's). Room deps are injected, never imported, so tests stub them.
- **room.ts** — the `GameRoomHandle`. Room id: 8 chars, private code: 5 chars,
  from `ROOM_ALPHABET` via the injected rand. Snapshot objects are preallocated
  per connected player and mutated in place. The concrete `Room` class
  exposes, beyond `GameRoomHandle`, a public **`tickOnce()`** that runs
  exactly one sim tick + snapshot push (the headless seam T13 pumps, and room
  tests drive) — the interval driver just calls it. Bot seeds come from a
  room-local `hashSeed(roomId, index)` helper (FNV-1a, 20 lines, T10 owns it —
  the platform does not export one). Each tick the room builds each bot's
  `BotPercept` (team-vision-filtered) and feeds the returned commands through
  the SAME handlers human messages hit (`handleOrder`, `handleCast`,
  `handleBuy`, `handleSkill`, `handleItem`). A bot never gets a code path a
  human can't hit.
- **bots.ts** — `BotBrain` per the frozen seam: pure deterministic
  `tick(percept): BotCommand[]`, no Date, no Math.random, no allocation beyond
  the returned array (scratch reused). Behaviour spec: use `percept.lane`;
  shadow the own creep wave down the lane; last-hit any enemy creep in attack
  range whose hp <= own expected damage (seeded slop +-15%); otherwise
  attack-move toward the next waypoint; retreat to fountain under 32% hp, stay
  till >80%; at the fountain, buy the next item in a per-role build order
  (declared as data at the top of the file) and spend skill points (q > w > e,
  ult whenever legal); cast per archetype (mage nukes the lowest-hp enemy hero
  in range; support heals the lowest ally under 60%; tank dashes in when >= 2
  enemies within dash range; assassin strikes a slowed or isolated target;
  carries cast on cooldown during engagements); support bots buy wardstone and
  place wards at their lane's mid waypoint when `percept.wardStock > 0`.
  Never attack towers while Fortify would proc (no own creep within
  `FORTIFY_RADIUS`) unless the tower is below 15% hp.

## 6. Wire + client (client/src/)

Connection/lifecycle mirrors wordbomb exactly: one `/ws`, `rift.name` +
`rift.resume` in localStorage (try/catch'd), `?code=` invite prefill +
`history.replaceState`, clock sync via platform ping/pong, reconnect with
backoff, every create/join carries `game: 'rift'`, room list filtered to rift.

**Frozen client seams** — `client/src/contract.ts` is Layer-1 (normative):
`InterpEnt`/`GhostEnt`/`InterpHandle`, `SceneHandle`/`UnitsHandle`/`FogHandle`/
`FxHandle`, `ClientState`/`UiActions`/`UiHandle`/`AudioHandle`,
`ClientModules`, and the frozen create-function signatures (in its footer
comment). `SceneHandle` includes `groundToScreen` (world -> CSS px) for DOM
overlays — hero name labels (§8's name-label law) render as pooled DOM
projected per frame. T7/T8/T9 import ONLY these types from each other's territory.
**main.ts and wire.ts are orchestrator-owned** (created at integration);
T8's `Game` class takes `(root, modules: ClientModules)` and never imports an
implementation module. The DOM CLASS
CONTRACT: T9/T7 render only these classes and T8's style.css styles exactly
this list (extend ONLY via the orchestrator):
  .hud .hud-portrait .hud-bars .bar .bar-hp .bar-mana .bar-xp
  .ability-bar .ability-slot .ability-cd .ability-rank .ability-plus
  .item-bar .item-slot .item-charges .item-cd .gold-readout .kda
  .topbar .match-clock .team-score .tower-count .killfeed .kill-row
  .shop-panel .shop-grid .shop-item .shop-cost .minimap .scoreboard
  .menu .menu-* .lobby .lobby-* .pick-grid .pick-card .end-screen .end-*
  .death-overlay .respawn-count .hint .banner .error-banner .dmg-number
  .tooltip

`.tooltip` (added by the ability-tooltip pass, R_HUD territory): ONE shared
rich-tooltip element replacing the native `title` on `.ability-slot`s. Its
inner structure is classless and styled by descendant selectors.

- **main.ts** (T8) — mirror APAL onto CSS vars, `unhandledrejection` banner,
  `boot(root)` in try/catch with `.error-banner` fallback.
- **net.ts** (T8) — socket, send (no-op unless OPEN), parse, clock offset.
- **game.ts** (T8) — state machine: menu -> lobby -> live -> end. Owns the
  modules through the seams above; routes events to fx/audio/killfeed.
- **interp.ts** (T8) — snapshot buffer, render 2 ticks (100ms) behind,
  interpolate positions; **the appear/disappear rules** (handoff §2.4 — where
  the bugs live): an entity that vanishes leaves a ghost at its last known
  position that fades over 0.5s — never snap to origin, never interpolate
  toward a stale target; an entity that reappears spawns its interpolation
  fresh from the new position — never lerp from 5 seconds ago. Structures
  never ghost (always sent).
- **input.ts** (T8) — MOBA controls: fixed-angle camera (pitch ~55deg, yaw
  fixed), pan via screen-edge / WASD / middle-drag, wheel zoom clamped [18,
  55]m height; RMB = move (attack if an enemy unit is under the cursor, via
  `pickUnit`), A+LMB = attack-move, S = stop; Q/W/E/R quick-cast at cursor
  (unit-target casts pick the unit under the cursor); 1-6 = item actives (ward
  placement targets the cursor ground point); Ctrl+Q/W/E/R and clickable `+` =
  spend skill point; TAB = scoreboard overlay; click own portrait = centre
  camera. Blur clears held keys; resize handled.
- **render/scene.ts** (T7) — one `WebGLRenderer`: ACESFilmicToneMapping, sRGB,
  antialias, PCFSoftShadowMap 2048, pixelRatio <= 2. Hemisphere light (cool
  sky tint, warm ground tint) + one directional sun with shadow frustum fitted
  to the map + `FogExp2` in `APAL.fog`. Flat `MeshLambertMaterial` ONLY, via a
  frozen `mat()` factory; static geometry merged/baked by material. NO PBR, no
  post-processing, no TextureLoader, no image assets. **Rift amendment to
  VISUAL_UPGRADE §0 (deliberate, recorded here):** generated `CanvasTexture`
  is permitted ONLY for the fog-of-war overlay and the minimap — never for
  world geometry, never loaded from a file. The sky is a BANDED dome (3
  flat-shaded bands `skyHigh -> horizon`, no vertex colors, no custom shader).
- **render/mapMesh.ts** (T7) — `buildMap(lanes)` (same shared code as the
  server) -> baked statics: ground plane `moss`; lane paving strips `stone`
  raised 0.02 (NEVER coplanar — `COPLANAR_EPS = 0.006` rule); base platforms
  with team-tinted trim; scattered deco via `rng(decoSeed('rift-' + lanes, 18))`: ruins fragments, foliage clusters (`leaf`/`leafDeep`/`trunk`),
  rocks — in organic clusters OFF the lane paths, denser toward map edges, ~1
  cluster per 150m² of off-path area, 3-8 pieces per cluster, all baked.
- **render/units.ts** (T7) — every entity attaches a visible mesh built from
  primitive factories (box/cyl/cone/sphere, merged Lambert, ONE merged mesh
  per unit, <= 2 draw calls per unit incl. team trim). Team tint via
  `azure`/`ember` (+Lit/Deep tiers). Per-asset silhouette spec in §7. **HP
  bars are instanced**: one `InstancedMesh` for bar backgrounds, one for fills
  (2 draw calls total), `inkDeep` bg, fill = team colour / `heal`-green for
  self / `danger` for enemies. Selection ring + order-target marker meshes.
  **Animated sub-parts carve-out:** the only unbaked moving parts are tower
  crystals, the Ancient heart, ward eyes, projectiles, and unit meshes
  themselves; everything else bakes.
- **render/fog.ts** (T7) — the client owns the PIXELS of fog: a generated
  CanvasTexture visibility mask (per-team, updated on snapshot at ~5Hz) drawn
  as a shroud overlay: unexplored = `shroud` opaque; explored-not-visible =
  terrain darkened (mask composites toward `shroud` 0.55); visible = clear.
  Soft edges (radial falloff in the mask). The minimap reads the same mask.
- **render/fx.ts** (T7) — pooled particle bursts (last-hit gold spark, death
  puff, tower collapse debris, cast flashes per school: physical `paper`,
  magic `arcane`, heal `heal`), attack tracers driven by `InterpEnt.atk`
  transitions, screen shake on own-hero damage taken, damage numbers (DOM,
  pooled, `.dmg-number`, `gold` for bounty, `danger` taken, `paper` dealt).
  Pool everything; no per-frame allocation.
- **ui/hud.ts** (T9) — bottom centre: portrait, hp/mana bars, ability bar
  (QWER with icon glyph, cooldown sweep, mana cost, rank pips, `+` when a
  point is available, ult greyed until level 6), 6 item slots (hotkeys,
  charges, cooldowns), gold, K/D/A, level + XP bar. Top centre: match clock
  (surge state), `kills` team score, towers standing (from structure ents).
  Kill feed top-right from `rift_kill` (ids resolved via the snap board).
  Shop button. Death overlay with respawn countdown. Every numeric HUD text
  >= 12px at 1080p, `paper` on `ink` (>= 7:1). Scoreboard overlay (TAB):
  `board` rows — hero, name, K/D/A, level — grouped by team.
- **ui/shop.ts** (T9) — panel toggled from HUD or near-fountain hint; grid of
  all `ITEM_LIST` with icon, name, cost, blurb; buy enabled only inside own
  fountain radius with sufficient gold (server is authoritative — the client
  greys, the server ignores); click-to-buy into first free slot.
- **ui/minimap.ts** (T9) — 2D canvas, ~4Hz: lane paths, structures (always),
  own + visible units as team dots, wards, the fog mask canvas, camera
  frustum; click to pan.
- **ui/menus.ts** (T9) — menu (name, room list, create with teamSize + speed
  settings), lobby (roster by team, hero pick grid with role/blurb/ability
  tooltips, human-taken greyed, teamSize readout, START with canStart state,
  invite code), end screen (winner banner, full stats table from `rift_end`,
  back-to-lobby). All states exist and look intentional (UX_BIBLE).
- **audio.ts** (T9) — WebAudio synthesis only (wordbomb pattern: master gain +
  compressor, no-op until first gesture): ui click, cast per school, last-hit
  cha-chime, hero kill sting, own-death thud, tower collapse rumble, surge
  horn, victory/defeat sting, ambient wind loop. Hit feedback is visual AND
  audio (UX law).

**Debug surface (frozen, for e2e):** `window.__rift = { state(), createPrivate(name, settings?), joinPrivate(name, code), start(), pick(hero), order(kind, x?, z?, target?), cast(slot, x?, z?, target?), buy(item), skill(slot), item(slot, x?, z?), snaps(), lastEvents(), messageLog() }`. `state()` returns the client's parsed snapshot view (phase, you, ents count, gold, positions).

## 7. Art direction (style bible — binding on every visual task)

**Mood.** Overgrown celestial ruins at dusk. Two dying campfires of civilisation
— azure and ember — facing across moss-dark ground. Everything readable at
gameplay zoom FIRST, charming in close-up second.

**Benchmark.** The bar is "a shipped indie MOBA/RTS you'd show a friend":
reference points are *Dota 2* (lane readability, team tint discipline) and
*Northgard* (stylised flat-shaded world, dusk palettes, readable clutter). We
cannot match their asset budgets; we MUST match their discipline: one material
model, palette-traced colours, deliberate silhouettes, dense-but-tidy ground
clutter.

**Material model.** Flat-shaded `MeshLambertMaterial` everywhere; static
geometry bakes per material; the ONLY unbaked moving parts are unit meshes,
tower crystals, the Ancient heart, ward eyes, and projectiles. No textures, no
PBR, no post-processing (repo law + the §6 CanvasTexture amendment).

**Per-asset model sheets** (15-40 primitive parts per design, merged to ONE
mesh per unit; team trim on EVERY combat asset):

- **Lane tower** — tapering octagonal stone column (`monument`), plinth
  `monumentDeep` proud 0.05, cornice `monumentLit` proud 0.06, and the ONE
  animated part: a floating team-tinted crystal (octahedron, team `Lit` tier)
  orbiting slowly above the brazier bowl; cracks suggested by 2-3 `stoneDeep`
  inset shards. ~3.5m tall.
- **Guard tower** — same family but twin-horned crown; +15% bulk.
- **Ancient** — a kneeling golem-fountain: stacked monolith slabs leaning
  inward around a floating team-crystal heart (team `Lit` + `goldLit` core),
  rubble ring, banner fins in team colour. THE landmark — 40 parts, ~6m.
- **Melee creep** — squat soldier: box torso, cylinder limbs, flat helm with
  team plume; carries a slab shield. ~1.2m.
- **Ranged creep** — robed acolyte: cone robe, hood, glowing team-tinted orb
  hands. ~1.3m.
- **Siege creep** — beetle-shaped stone ram on 4 legs, team banners. ~1.6m.
- **Heroes** — per `visual.build`: bulky (BULLWARK: tower shield + pauldron
  stacks, `pine` shield boss), standard (REAVER: greatblade with `gold` edge,
  MENDER: staff with `heal` orb), lithe (LONGBOW: longbow + quiver, `frost`
  string; HEX: floating rings, `void` core; SHADE: twin daggers + scarf,
  `shade` blades). Team tint colours plume/cloth. Readable silhouette at 30m
  zoom is the acceptance bar.
- **Ward** — small obelisk with a slowly pulsing `ward` eye (animated part).
- **Projectiles** — elongated glowing meshes tipped in school colour (`paper`
  physical, `arcane` magic), short pooled trail.

**World population.** Deco clusters (ruins, foliage, rocks) hug map edges and
lane shoulders — never ON paths; ~1 cluster per 150m² of off-path area, 3-8
pieces each; the map must never read as an empty plane. Ground gets subtle
2-tone mottling via `mix(moss, mossLit, t)` decal quads raised 0.01.

**Fog look.** Unexplored = full `shroud`; explored = terrain composited toward
`shroud` 0.55; team units remain readable on fog-darkened ground (ladder law).

## 8. UX bible (binding on every UI task)

- Glanceables always visible: own hp/mana, cooldowns, gold, match clock, team
  kill score (`rift_snap.kills`), towers standing, minimap. Feedback latency:
  order -> move marker < 100ms (client-side marker immediately, server confirm
  later); damage feedback same frame; death overlay < 300ms.
- Never colour alone: team identity is colour + banner shape + name labels;
  enemy units get `danger` hp bars, allies team-tinted, self `heal`-green.
- States: menu, joining, lobby (empty/1-player/filling), countdown, live,
  death-spectate (camera free), ended (win/lose/draw), disconnect banner,
  error banner. First-60-seconds: a new player spawns with a pulsing "RMB to
  move" hint, an arrow toward their assigned lane (`rift_begin.laneAssignment`
  -> lane path midpoint), and the shop hint when first at 400+ gold near the
  fountain. Hints dismiss on use.
- Min contrast: HUD text `paper` on `ink` (>= 7:1); smallest HUD text 12px at
  1080p; no flashing > 3Hz. Layout safe 16:9 and 21:9, usable at 1280x720.

## 9. Design + balance intent (checkable targets)

Core loop: lane -> last-hit -> buy -> fight -> take tower -> repeat, break the
Ancient. Decision per minute: which lane to pressure, when to back, what to
buy, when to force a fight. Targets the balance harness (T13) must MEASURE,
not reason about (bands derived from the frozen config arithmetic, not
wishful thinking): at even bot skill a match resolves by Ancient kill in
12-18 min game-time median (hard cap is a backstop, hit in < 20% of sims);
first tower falls at 5-8 min; heroes reach level 6 between 6 and 11 min at
2v2-4v4, and by ~14 min at 8v8 (bigger teams level slower — intended, not a
defect);
gold at 10 min is 2200-5500 per hero; team gold divergence at 10 min < 40%;
no NaN, no stalled sim (tick always advances; a match ALWAYS ends by hard
cap). Fortify + lane-scaled income are the two load-bearing anti-sprawl
mechanisms — do not weaken them without a measured reason. When the harness
finds a stall whose cause is bot BEHAVIOUR (not numbers), T13 reports the
finding and the proposed bot-logic delta; the orchestrator routes it to the
T6 agent to apply — config is not the only lever, but it is the only one T13
may touch directly.

## 10. Non-functional budgets (build-time requirements, not a post-pass)

- 60fps at 1080p on a 2020 laptop at 8v8/3-lane peak (~90 mobiles + fx);
  draw calls <= 400 measured via `renderer.info` (the unit/hp-bar instancing
  rules in §6 exist to make this reachable: ~180 unit calls + 2 hp-bar calls +
  ~54 structure calls + fx pools + baked map + sky bands + fog ~= 280);
  sim tick <= 2ms server-side at 8v8 (measured headless in T13); snapshot
  parse + scene diff <= 4ms client-side; bundle <= 1.5MB gz.
- No per-tick/per-frame allocation in hot paths (sim tick, render loop,
  interpolation); pool particles, damage numbers, projectile meshes.
- One exception must never white-screen: render loop and tick are guarded;
  WebGL failure -> readable error div; socket drop -> reconnect banner +
  resume; window blur clears held keys; resize reflows.
- Determinism: all gameplay randomness from injected/seeded rng streams.
  `Math.random` anywhere under `games/rift/` is a violation.

## 11. Rules prepended to EVERY implementer prompt

1. The Layer-1 files listed at the top of this contract are IMMUTABLE. Create
   only the files your task owns. If the contract seems wrong, STOP and report
   the contradiction; never patch around it.
2. Strict TS: no `any`, no `@ts-ignore`, no non-null `!` unless provably safe;
   `exactOptionalPropertyTypes` + `noUncheckedIndexedAccess` are ON.
3. No stubs, no TODOs, no dead code. Every exported function works.
4. All colours by APAL name (or `mix`/`composite` on APAL entries). Ad-hoc hex
   is a violation. All glyphs are unicode chars; no image assets, no fonts.
5. No `Date.now()`/`Math.random()` in sim or bots; match time is ticks;
   randomness is the injected `rand`.
6. No per-tick/per-frame allocation in hot paths; preallocate or pool.
7. Every gate must be run with binaries invoked directly and `$?` captured
   (`node node_modules/typescript/bin/tsc --noEmit -p <ws>`,
   `npx vitest run <path>`) — NEVER via `rtk`, never through a pipe. And every
   new gate must be proven red once (inject an error, see it fail, revert).
8. Tests live where `vitest.config.ts` includes them; after adding tests, run
   `npx vitest list` and CONFIRM your suite is collected.

## 12. Task DAG (file ownership is exclusive; deps are true data deps)

Wave 1 (parallel, depend on contract only):
- **T1 map** — owns `shared/src/map.ts`, `shared/src/map.test.ts`, the one
  barrel line in `shared/src/index.ts`. Gate: shared tsc + its vitest green.
- **T2 shared-data + ladder tests** — owns `shared/src/valueLadder.test.ts`,
  `shared/src/heroes.test.ts`, `shared/src/protocol.test.ts`,
  `shared/src/items.test.ts`. Ladder laws: tier floors (Lit/Deep vs base >= 8
  L*, scoped to bases with L >= 16 — `inkDeep` is exempt by construction and
  the test SAYS so), L5 ground floor (`L(moss) >= 22`), lane stone vs moss >=
  15 L*, monument vs moss >= 20 L*, team colours vs moss AND vs
  `composite(moss, shroud, 0.55)` >= 18 L* or >= 30 deg hue, azure vs ember >=
  25 deg hue or >= 20 L*, sky law S1/S2/S4, paper on ink >= 60 L*, hero accent
  pairwise distinguishability (>= 25 deg hue or >= 20 L*) and no accent equal
  to a team colour, CSS-var mirror 1:1. heroes.test.ts: schema validity (per-
  rank array lengths == maxRank, slot 3 ult/maxRank 2, passives aura-only with
  duration 0, unique ids), registry completeness (every HeroId present once).
  protocol.test.ts: parser robustness (malformed -> null, clamps, never
  throws) + settings validation. items.test.ts: costs > 0, active shapes.
  Gate: shared tsc + vitest green. If a LADDER law fails on the frozen
  palette, REPORT the measured values — do not edit palette.ts (bounces to
  the orchestrator).

Wave 2 (parallel; depend on contract + T1's map.ts + the frozen sim seam):
- **T3 sim core** — owns `sim/world.ts`, `sim/movement.ts`, `sim/combat.ts`,
  `sim/units.ts` + their tests. Implements the frozen `World` surface.
  Gate: server tsc + tests green.
- **T4 ability engine** — owns `sim/abilities.ts` + tests (every primitive,
  ordering, validation, homing/straight projectiles, pierce/non-pierce,
  aura/self/passive, summon cap, item actives). Imports the frozen seam only.
- **T5 vision** — owns `sim/vision.ts` + tests (filter sets, ward own-team
  only, structures always sent, appear/disappear set semantics).
- **T6 bots** — owns `bots.ts` + determinism test (same seed + same scripted
  percept stream = identical commands).
- **T7 client world render** — owns `render/scene.ts`, `render/mapMesh.ts`,
  `render/units.ts`, `render/fog.ts`, `render/fx.ts`. Gate: client tsc.
- **T8 client app shell** — owns `net.ts`, `game.ts`, `interp.ts`,
  `input.ts`, `style.css` + interp tests (ghost/reappear rules). `main.ts` +
  `wire.ts` are orchestrator-owned (integration). Gate: client
  tsc + its tests green.
- **T9 client UI** — owns `ui/hud.ts`, `ui/shop.ts`, `ui/minimap.ts`,
  `ui/menus.ts`, `audio.ts`. Gate: client tsc.

Wave 3:
- **T10 room+module** — owns `room.ts`, `module.ts`, `ports.ts` + room tests
  (lobby contract, lock, bot fill, late-join inheritance, disconnect-bot
  rebind, end/tiebreak, snapshot filtering integration, `tickOnce` headless
  seam). Depends on T3-T6.
- **T11 registration wiring** (ORCHESTRATOR, not a fan-out task) — registry.ts,
  root package.json scripts (dev/build/**e2e:rift** — sole owner of that
  file), platform/server package.json dep, launcher COPY/LPAL entry,
  deploy/Dockerfile. The vitest alias+include wiring lands at FREEZE TIME
  (before any fan-out) so every task's gate can collect.
- **T12 e2e** — owns `scripts/e2e-rift.mjs` ONLY (puppeteer, 2 browsers +
  bots, `speed: 20`): lobby -> pick -> start -> begin -> snaps flow, orders
  move the hero, creeps spawn and die, gold accrues on last-hit, buy works,
  cast works, tower falls, match ends; zero page errors. Depends on T7-T11.
- **T13 balance harness** — owns `server/src/balance.test.ts`: headless
  bot-vs-bot full matches via direct `room.tickOnce()` pumping (FakeIO);
  measures §9 targets across lane counts 1..3, 3 matches each; asserts the
  bands; asserts sim tick p95 <= 2ms at 8v8. Depends on T10.
- **T14 visual + perf verification** — owns `scripts/verify-rift.mjs`:
  screenshot captures (menu, lobby, pick grid, live HUD at 2 zooms, shop open,
  scoreboard, death overlay, end screen; 16:9 and 21:9), asserts zero page
  errors and `window.__rift` health, reads draw calls via the debug surface,
  and feeds the art-director/UX-director judge loops (orchestrator-driven).
  Depends on T7-T11.

---

## Audio amendment (deliberate, recorded here)

The audio rebuild (`docs/rift-audio/AUDIO_CONTRACT.md`, `docs/rift-audio/SONIC_BIBLE.md`)
supersedes §6's `audio.ts` (T9) line. It replaces the single
`client/src/ui/audio.ts` with the module directory `client/src/audio/`, whose own
Layer-1 files are `client/src/audio/contract.ts` and `client/src/audio/config.ts`.
Three carve-outs from the Immutability rule are granted, and only these three:

1. **`client/src/contract.ts`** (Layer-1, normative) may be edited by the
   ORCHESTRATOR ONLY, and only to re-export `RiftAudioHandle` from
   `./audio/contract.js` as `AudioHandle`. `RiftAudioHandle` is a structural
   superset of the previous `AudioHandle` — `event`/`ui`/`setPhase` keep their
   meaning and every existing `game.ts` call site stays valid — so no other seam
   in `ClientModules` changes. No implementer may touch this file.

2. **The DOM CLASS CONTRACT** is extended by exactly four classes, owned by the
   audio settings panel:
     .audio-panel .audio-panel-row .audio-panel-slider .audio-panel-mute
   plus `.audio-panel-toggle` for its self-contained open/close button. The panel
   appends its CSS to the end of `client/src/style.css` in a delimited block and
   modifies no existing rule.

3. **`client/vite.config.ts`** (a workspace manifest, normally Layer-1) gains a
   `build.rollupOptions.input` listing `index.html` AND `audio-lab.html`. The lab
   page is the offline-render seam the audio judge loop measures against; without
   it there is no way to score rendered audio. Nothing else in that file changes.

`wire.ts` and `main.ts` remain orchestrator-owned and the audio settings panel is
mounted from `wire.ts`, preserving §6's rule that `game.ts` never imports an
implementation module.

---

## Audio amendment (deliberate, recorded here)

The audio rebuild (`docs/rift-audio/AUDIO_CONTRACT.md`, `docs/rift-audio/SONIC_BIBLE.md`)
supersedes §6's `audio.ts` (T9) line. It replaces the single
`client/src/ui/audio.ts` with the module directory `client/src/audio/`, whose own
Layer-1 files are `client/src/audio/contract.ts` and `client/src/audio/config.ts`.
Three carve-outs from the Immutability rule are granted, and only these three:

1. **`client/src/contract.ts`** (Layer-1, normative) may be edited by the
   ORCHESTRATOR ONLY, and only to re-export `RiftAudioHandle` from
   `./audio/contract.js` as `AudioHandle`. `RiftAudioHandle` is a structural
   superset of the previous `AudioHandle` — `event`/`ui`/`setPhase` keep their
   meaning and every existing `game.ts` call site stays valid — so no other seam
   in `ClientModules` changes. No implementer may touch this file.

2. **The DOM CLASS CONTRACT** is extended by exactly four classes, owned by the
   audio settings panel:
     .audio-panel .audio-panel-row .audio-panel-slider .audio-panel-mute
   plus `.audio-panel-toggle` for its self-contained open/close button. The panel
   appends its CSS to the end of `client/src/style.css` in a delimited block and
   modifies no existing rule.

3. **`client/vite.config.ts`** (a workspace manifest, normally Layer-1) gains a
   `build.rollupOptions.input` listing `index.html` AND `audio-lab.html`. The lab
   page is the offline-render seam the audio judge loop measures against; without
   it there is no way to score rendered audio. Nothing else in that file changes.

`wire.ts` and `main.ts` remain orchestrator-owned and the audio settings panel is
mounted from `wire.ts`, preserving §6's rule that `game.ts` never imports an
implementation module.
