// ============================================================================
// ANCIENTS (rift) — SIM SEAM. FROZEN Layer-1 contract (listed in
// games/rift/CONTRACT.md). Types only, no logic. This is the interface the
// sim modules (T3 world/movement/combat/units, T4 abilities, T5 vision),
// the bots (T6), and the room (T10) all build against IN PARALLEL — nobody
// negotiates shapes with anybody; everything flows through this file.
//
// AMENDED for TERRAIN_CONTRACT §5 (frozen, orchestrator-authored): entities
// carry `EntTeam` because neutral jungle camps are a third team, heroes carry
// an A* path, and the world exposes the live camp table. The amendment adds
// fields and widens `team`; it removes and re-values nothing.
// ============================================================================
import type { AuraStat } from '@rift/shared';
import type { CampDef, EndReason, EntKind, EntTeam, MapDef, Phase, TeamId, Vec2 } from '@rift/shared';
import type { HeroId, ItemId } from '@rift/shared';

/** Structure entities use their MapDef structure id (0..999). Mobile entities
 *  (heroes, creeps, summons, wards, projectiles) are numbered from 1000. */
export type EntId = number;
/** "No entity" sentinel for target fields. -1, never a legal structure id. */
export const NO_ENT: EntId = -1;

export type OrderKind = 'idle' | 'move' | 'attackmove' | 'attack';

/** A queued unit order (World.order intake). */
export type Order =
  | { kind: 'move' | 'attackmove'; x: number; z: number }
  | { kind: 'attack'; target: EntId }
  | { kind: 'stop' };

/** A queued cast, drained by the abilities engine each advance(). Item
 *  entries are pre-validated and pre-spent by useItem (charges/cooldown/ward
 *  stock) — the engine executes, never re-validates. Wardstone never enters
 *  the queue (units.ts places wards directly). */
export type QueuedCast =
  | { kind: 'ability'; hero: EntId; slot: number; x: number | null; z: number | null; target: EntId }
  | { kind: 'item'; hero: EntId; slot: number; x: number | null; z: number | null };

/** One timed stat modifier on an entity. untilTick 0 = passive permanent.
 *  Radius > 0 passives re-evaluate membership every 5 ticks — that
 *  re-evaluation (and rank-up refresh of passive amounts) is owned by T3's
 *  advance() step (3), reading the shared hero data; it is nobody else's job. */
export interface AuraInstance {
  stat: AuraStat;
  amount: number;
  pct: boolean;
  untilTick: number; // match-tick domain
  source: EntId;
}

/** The entity record. One flat struct per entity; the sim owns the stores,
 *  everyone else reads through World. Fields are match-tick domain unless
 *  suffixed otherwise. Progression fields are meaningful for heroes only. */
export interface Ent {
  readonly id: EntId;
  readonly kind: EntKind;
  /** `EntTeam`, not `TeamId`: a jungle camp creep carries `NEUTRAL_TEAM`
   *  (TERRAIN_CONTRACT §5). Players, seats, structures and match results stay
   *  `TeamId` — only ENTITIES may be neutral. Hostility falls out for free:
   *  `attackable()` tests `t.team !== e.team`, so a camp is an enemy to both
   *  player teams and each player team is an enemy to the camp.
   *
   *  **Narrowing obligation — read this before you index anything with it.**
   *  The sim is built on two-element per-team tuples: `visSets`,
   *  `wardStockArr`, `ancientId`/`ancientX`/`ancientZ`, `kills`,
   *  `fountainX`/`fountainZ`, and the client's `TEAM_COLOUR`/`TEAM_MARKER`.
   *  `NEUTRAL_TEAM` is 2 — indexing a two-element tuple with it is an
   *  out-of-bounds read that yields `undefined` under
   *  `noUncheckedIndexedAccess`, or silently wrong data on a typed array.
   *
   *  > Every site that indexes a per-team tuple, array or `Record` with an
   *  > entity's `team` MUST narrow with `isPlayerTeam(e.team)` first and
   *  > handle the neutral branch explicitly — that branch is the
   *  > documentation. No `as TeamId` casts, no non-null assertions, no
   *  > "cannot happen here". Grep the files you own for indexing by `.team`
   *  > and narrow all of them; a fixed site next to an unfixed one is exactly
   *  > the bug this rule exists to prevent. */
  readonly team: EntTeam;
  // position
  x: number;
  z: number;
  readonly radius: number;
  // resources
  hp: number;
  maxHp: number;
  mana: number;
  maxMana: number;
  alive: boolean;
  // EFFECTIVE combat stats (base + items + auras recomputed on change)
  damage: number;
  armor: number;
  attackPeriod: number;
  attackRange: number;
  moveSpeed: number;
  hpRegen: number;
  manaRegen: number;
  lifesteal: number;
  vision: number;
  bounty: number;
  xpValue: number;
  nextAttackTick: number;
  /** Target of the most recent basic attack (NO_ENT = none). Drives
   *  EntSnap.atk so clients can render tracers. */
  atkTarget: EntId;
  // orders / motion intent
  order: OrderKind;
  ox: number; // move/attackmove destination
  oz: number;
  orderTarget: EntId; // attack-order target
  /** Grid A* path toward (ox, oz) — HEROES ONLY (TERRAIN_CONTRACT §4). null
   *  means "no path, steer straight at the destination", which is the state
   *  of every non-hero forever: lane creeps are never pathed (their corridor
   *  is validated cliff-free) and camp creeps never leave their clearing.
   *  Written by movement.ts only when an order is issued or the current path
   *  is invalidated — never per tick.
   *  INVARIANT: every new order resets this to null and `pathIndex` to 0. A
   *  surviving path is a unit walking to the previous order's destination. */
  path: readonly Vec2[] | null;
  /** Index into `path` of the next waypoint not yet reached; advances as
   *  `steer()` consumes waypoints, and equals `path.length` once the final
   *  waypoint is reached (from there on the unit behaves exactly as it does
   *  today). Meaningless while `path` is null, where it holds 0. */
  pathIndex: number;
  /** Creep wave progress: assigned lane and next waypoint index. -1/0 for
   *  non-creeps — INCLUDING camp creeps, which are spawned with lane -1. A
   *  camp creep with lane >= 0 walks a lane polyline, which is the single
   *  most likely way the jungle breaks (TERRAIN_CONTRACT §5). */
  lane: number;
  waypoint: number;
  // timed modifiers
  stunUntilTick: number;
  slowPct: number; // strongest active slow wins; slows never stack
  slowUntilTick: number;
  /** Active dash: rapid scripted motion toward (ox, oz). */
  dashUntilTick: number;
  /** Summons/wards: tick at which the entity expires. 0 = never. */
  expireAtTick: number;
  auras: AuraInstance[]; // pooled per ent; length managed by sim
  // hero progression (heroes only)
  level: number;
  xp: number;
  gold: number;
  skillPoints: number;
  hero: HeroId | null;
  /** Owning player id for heroes; null for everything else. */
  pid: string | null;
  /** Owning ENTITY for summons/wards/projectiles (the caster); NO_ENT
   *  otherwise. Drives the per-hero summon cap. */
  owner: EntId;
  abilityRanks: number[]; // 4
  abilityCdUntilTick: number[]; // 4
  items: (ItemId | null)[]; // 6
  itemCharges: number[]; // 6
  itemCdUntilTick: number[]; // 6
  respawnAtTick: number; // 0 while alive
  kills: number;
  deaths: number;
  assists: number;
  goldEarned: number;
  heroDamage: number;
  structureDamage: number;
  /** Loot bookkeeping: last damager per source ent, match-tick stamped. */
  lastHitBy: EntId;
  /** Recent hero damagers for assist windows (pooled ring, sim-managed). */
  recentDamagers: { id: EntId; tick: number }[];
}

// --- Neutral jungle camps ---------------------------------------------------------

/** Live state of ONE jungle camp (TERRAIN_CONTRACT §5). The world builds one
 *  of these per `map.terrain.camps` entry at construction and never adds or
 *  removes another; `stepCamps` (sim/camps.ts, run between stepDeaths and
 *  stepUnits) mutates them in place, and the bots read them through the
 *  percept. Nothing here is allocated per tick — a respawn rewrites
 *  `memberIds` in place.
 *
 *  A camp is NEVER owned: `def.half` says which map half it sits in, for
 *  mirroring and validation only. Its creeps carry `NEUTRAL_TEAM`. */
export interface CampState {
  /** Mirrors `def.id`. Dense from 0, stable for the whole match, and equal to
   *  this camp's index in `World.camps`. */
  readonly id: number;
  /** The immutable placement record this camp was built from: the clearing
   *  centre (`def.x`, `def.z`) that the leash and the bots measure against,
   *  and the tier that fixes composition, tuning, bounty and respawn time. */
  readonly def: CampDef;
  /** Entity ids of the CURRENT generation of this camp's creeps. Rewritten in
   *  place on every respawn, so an id here may name a dead — or, after a
   *  respawn, a recycled — entity. `aliveCount`, never `memberIds.length`, is
   *  the liveness truth. */
  readonly memberIds: EntId[];
  /** How many of `memberIds` are still alive. Hits 0 on the tick the last
   *  creep dies, which is the tick `respawnAtTick` is stamped; set back to
   *  the tier's composition count when the camp respawns whole. */
  aliveCount: number;
  /** Match tick at which the camp respawns, or **-1 while the camp is up**.
   *  -1 is the only "alive" encoding — 0 is a legal match tick and must not
   *  be overloaded to mean anything else. */
  respawnAtTick: number;
}

// --- The World surface ------------------------------------------------------------

/** Everything T4/T5/T6/T10 may touch. Implementation is T3's; this interface
 *  is frozen. */
export interface World {
  readonly tick: number; // current match tick
  readonly map: MapDef;
  readonly overtime: boolean;
  /** The live camp table, one entry per `map.terrain.camps` entry, in that
   *  exact order — so `camps[i].id === i`. Built once at construction and
   *  never resized. The reference is readonly; the entries are not: only
   *  `stepCamps` mutates them, everybody else (bots, the room) reads. */
  readonly camps: CampState[];
  get(id: EntId): Ent | undefined;
  all(): Iterable<Ent>; // every entity, structures included
  mobiles(): Iterable<Ent>; // non-structure entities only
  /** Fill a caller-owned buffer with ents whose CIRCLE CENTRE is within r of
   *  (x, z); returns the count written. Never allocates. */
  inRadius(x: number, z: number, r: number, out: Ent[]): number;
  // --- intake (queued, applied/validated at the next advance(); illegal
  // input silently no-ops — bots and humans share this exact door) ---
  order(hero: EntId, order: Order): void;
  cast(hero: EntId, slot: number, x: number | null, z: number | null, target: EntId): void;
  // --- mutation surface (combat.ts + the abilities engine + units.ts) ---
  damage(src: EntId, dst: EntId, amount: number, school: 'physical' | 'magic'): void;
  heal(dst: EntId, amount: number): void;
  stun(dst: EntId, durationS: number): void;
  slow(dst: EntId, pct: number, durationS: number): void;
  /** durationS 0 = permanent passive instance. */
  applyAura(dst: EntId, stat: AuraStat, amount: number, pct: boolean, durationS: number, source: EntId): void;
  /** Scripted dash toward (tx, tz), clamped to map bounds and stopped at
   *  structure edges by movement. */
  dash(id: EntId, tx: number, tz: number): void;
  /** Spawn a mobile unit; returns its id. 'proj' ents are moved and resolved
   *  by the abilities engine (it owns their payload side table); everything
   *  else moves via movement.ts. owner attributes summons/wards/projs to
   *  their caster (NO_ENT for wave creeps).
   *
   *  `team` is `EntTeam`, not `TeamId`, for exactly one reason: camps spawn
   *  through this same door with `team = NEUTRAL_TEAM, lane = -1,
   *  owner = NO_ENT` (TERRAIN_CONTRACT §5). Every existing caller passes a
   *  `TeamId`, which is assignable unchanged. */
  spawnMobile(kind: EntKind, team: EntTeam, x: number, z: number, lane: number, expireAtTick: number, owner: EntId): EntId;
  /** Shop + progression (units.ts owns): buy into first free slot (validates
   *  gold + at-fountain), spend a skill point (validates rank caps +
   *  ULT_LEVEL_REQ), use an item (validates charges/cooldown/ward stock AND
   *  SPENDS, then enqueues a {kind:'item'} cast for dash/aura actives;
   *  wardstone places the ward directly, no queue entry). All three silently
   *  no-op on illegal input. */
  buy(hero: EntId, item: ItemId): void;
  spendSkillPoint(hero: EntId, slot: number): void;
  useItem(hero: EntId, slot: number, x: number | null, z: number | null): void;
  wardStock(team: TeamId): number;
  /** The event SINK for every sim module (combat kills, engine casts,
   *  structure falls, surge, end). The room drains once per tick. */
  pushEvent(ev: SimEvent): void;
  /** Returns and clears the queued casts. Called by the abilities engine at
   *  advance() step (2); the world never reads its own cast queue. */
  drainCasts(): QueuedCast[];
  /** Events since the last drain; the room maps these to wire events and
   *  filters cast events by team vision. */
  drainEvents(): SimEvent[];
  advance(): void; // one sim tick
}

export type SimEvent =
  | { k: 'cast'; id: EntId; team: TeamId; slot: number; x: number; z: number }
  | { k: 'kill'; killerPid: string | null; victimPid: string; gold: number; firstBlood: boolean }
  | { k: 'structure'; team: TeamId; kind: 'tower' | 'guard' | 'ancient'; lane: number | null }
  | { k: 'surge' }
  | { k: 'end'; winner: TeamId | null; reason: EndReason };

/** The ability engine (T4) is injected into the world at construction, so T3
 *  and T4 build in parallel with zero cross-imports. `step` runs inside
 *  advance() at orchestration step (2): it drains the cast queue, validates
 *  and executes casts, and moves/resolves every 'proj' ent (its payload side
 *  table is engine-private). */
export interface AbilitiesEngine {
  step(world: World): void;
}

/** One seat at match lock. */
export interface SeatDef {
  pid: string;
  team: TeamId;
  hero: HeroId;
  bot: boolean;
  lane: number; // assigned lane index, round-robin per team at lock
}

// Frozen function SIGNATURES live in CONTRACT.md §4/§5, not here (a types
// file carries no declarations without bodies):
//   T3 world.ts:      export function createWorld(map: MapDef, seats: readonly SeatDef[], rand: () => number, abilities: AbilitiesEngine): World;
//   T4 abilities.ts:  export function createAbilitiesEngine(): AbilitiesEngine;
//   T5 vision.ts:     export function computeTeamVisible(world: World, team: TeamId, out: Set<EntId>): void;
//   T6 bots.ts:       export function createBotBrain(seed: number, hero: HeroId): BotBrain;
// The room (T10) imports those from the implementation modules directly.

// --- Bot seam (T6 consumes, T10 builds) ----------------------------------------------

/** One jungle camp as a bot sees it — the minimum needed to pick a camp and
 *  know whether it is worth walking to, and deliberately nothing more
 *  (TERRAIN_CONTRACT §5).
 *
 *  Why this and not `CampState`: a bot must not reach the world's mutable
 *  state, and `memberIds`/`respawnAtTick` would hand it creep identities and
 *  an exact respawn clock — information no human client receives. Camp
 *  POSITIONS leak nothing: terrain is a pure function of the lane count and
 *  every client rebuilds it locally, so both sides already know where every
 *  clearing is. `up` is coarse camp-timer knowledge of the kind a human
 *  tracks by watching the clock; it is intentionally NOT vision-gated,
 *  because a bot that must stand in a clearing to learn it is empty can never
 *  route a jungle circuit.
 *
 *  `id` indexes `World.camps`, so a bot may pass it straight back as an
 *  identifier for the camp it committed to. */
export interface CampPercept {
  /** `CampState.id` — dense from 0, stable for the match. */
  readonly id: number;
  /** Tier, which is the danger/reward read: 'pack' is clearable early,
   *  'hive' is ranged and chip-heavy, 'brute' is the level-6 test. */
  readonly tier: CampDef['tier'];
  /** Clearing centre. Attack-move here to engage the camp; the camp's leash
   *  is measured from this same point, so a bot that walks away disengages. */
  readonly x: number;
  readonly z: number;
  /** True while at least one creep of the camp is alive (`aliveCount > 0`).
   *  MUTABLE by design: the room keeps ONE `CampPercept` object per camp for
   *  the whole match and refreshes this field in place each tick, so feeding
   *  camps to eight bots allocates nothing. A bot reads it and never writes
   *  it. */
  up: boolean;
}

/** The percept is TEAM-VISION-FILTERED: bots see exactly what their team's
 *  human clients see. A bot never gets information a human couldn't have.
 *  (The one documented carve-out is `CampPercept.up` — see above.) */
export interface BotPercept {
  readonly tick: number;
  readonly phase: Phase;
  readonly self: Ent;
  readonly visible: readonly Ent[]; // reused buffer, valid until next tick
  readonly lane: number; // assigned at lock
  /** Lane waypoint polylines (team-0 -> team-1 direction; team 1 walks them
   *  reversed) — from the same MapDef the room built. */
  readonly paths: readonly (readonly Vec2[])[];
  /** Every neutral camp on the map, in `World.camps` order (so index === id).
   *  A REUSED buffer owned by the room — valid only for this tick, exactly
   *  like `visible`; never retain it across ticks, and never mutate it. The
   *  set never changes size mid-match, only each entry's `up`. */
  readonly camps: readonly CampPercept[];
  readonly wardStock: number;
  readonly atFountain: boolean;
  readonly overtime: boolean;
}

export type BotCommand =
  | { c: 'order'; kind: 'move' | 'attackmove'; x: number; z: number }
  | { c: 'order'; kind: 'attack'; target: EntId }
  | { c: 'order'; kind: 'stop' }
  | { c: 'cast'; slot: number; x?: number; z?: number; target?: EntId }
  | { c: 'buy'; item: ItemId }
  | { c: 'skill'; slot: number }
  | { c: 'item'; slot: number; x?: number; z?: number };

export interface BotBrain {
  tick(p: BotPercept): BotCommand[]; // small fresh array per tick is allowed
}
