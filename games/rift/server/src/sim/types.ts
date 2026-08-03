// ============================================================================
// ANCIENTS (rift) — SIM SEAM. FROZEN Layer-1 contract (listed in
// games/rift/CONTRACT.md). Types only, no logic. This is the interface the
// sim modules (T3 world/movement/combat/units, T4 abilities, T5 vision),
// the bots (T6), and the room (T10) all build against IN PARALLEL — nobody
// negotiates shapes with anybody; everything flows through this file.
// ============================================================================
import type { AuraStat } from '@rift/shared';
import type { EndReason, EntKind, MapDef, Phase, TeamId, Vec2 } from '@rift/shared';
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
  readonly team: TeamId;
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
  /** Creep wave progress: assigned lane and next waypoint index. -1/0 for
   *  non-creeps. */
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

// --- The World surface ------------------------------------------------------------

/** Everything T4/T5/T6/T10 may touch. Implementation is T3's; this interface
 *  is frozen. */
export interface World {
  readonly tick: number; // current match tick
  readonly map: MapDef;
  readonly overtime: boolean;
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
   *  their caster (NO_ENT for wave creeps). */
  spawnMobile(kind: EntKind, team: TeamId, x: number, z: number, lane: number, expireAtTick: number, owner: EntId): EntId;
  /** Shop + progression (units.ts owns): buy into first free slot (validates
   *  gold + at-fountain), spend a skill point (validates rank caps +
   *  ULT_LEVEL_REQ), use an item active (validates charges/cooldown/ward
   *  stock). All three silently no-op on illegal input. */
  buy(hero: EntId, item: ItemId): void;
  spendSkillPoint(hero: EntId, slot: number): void;
  useItem(hero: EntId, slot: number, x: number | null, z: number | null): void;
  wardStock(team: TeamId): number;
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
/** The percept is TEAM-VISION-FILTERED: bots see exactly what their team's
 *  human clients see. A bot never gets information a human couldn't have. */
export interface BotPercept {
  readonly tick: number;
  readonly phase: Phase;
  readonly self: Ent;
  readonly visible: readonly Ent[]; // reused buffer, valid until next tick
  readonly lane: number; // assigned at lock
  /** Lane waypoint polylines (team-0 -> team-1 direction; team 1 walks them
   *  reversed) — from the same MapDef the room built. */
  readonly paths: readonly (readonly Vec2[])[];
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
