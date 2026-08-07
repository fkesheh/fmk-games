// ============================================================================
// ANCIENTS (rift) — SIM WORLD (CONTRACT §4, T3). Entity stores, intake queues,
// the mutation surface, and advance()'s 8-step orchestration. Pure TS: no I/O,
// no Date.now(), no Math.random() (the injected rand is accepted per the frozen
// signature; the sim core itself is fully deterministic and does not consume
// it — bots and room-side id minting are the rand consumers).
//
// Engine conventions (frozen seam, sim/types.ts): the injected AbilitiesEngine
// drains the cast queue at advance() step (2) via drainCasts() — the world
// never reads its own queue — and pushes `cast` SimEvents via pushEvent().
// useItem validates AND spends (charges/cooldown/ward stock), then enqueues a
// {kind:'item'} cast for dash/aura actives; wardstone places wards directly
// and never enters the queue. The engine retires projectiles and capped
// summons by setting expireAtTick = world.tick; units.ts step (7) reaps ALL
// expired mobiles, projs included.
// ============================================================================
import {
  ANCIENT,
  ARMOR_K,
  CAMP_BRUTE,
  CAMP_HIVE,
  CAMP_PACK,
  CREEP_MELEE,
  CREEP_RANGED,
  CREEP_SIEGE,
  FORTIFY_HERO_DAMAGE_MULT,
  FORTIFY_RADIUS,
  FOUNTAIN_RADIUS,
  GUARD_TOWER,
  HERO_MAGIC_RESIST,
  HERO_RADIUS,
  HERO_VISION,
  INVENTORY_SLOTS,
  ITEMS,
  MATCH_HARD_CAP_S,
  OVERTIME_AT_S,
  SIEGE_BUILDING_MULT,
  STARTING_GOLD,
  STARTING_SKILL_POINTS,
  SUMMON_SHADE,
  TICK_DT,
  TICK_RATE,
  TOWER,
  ULT_LEVEL_REQ,
  WARD_DURATION_S,
  WARD_PLACE_RANGE,
  WARD_TEAM_STOCK,
  WARD_VISION,
  WAVE_FIRST_AT_S,
  heroById,
  isPlayerTeam,
} from '@rift/shared';
import type {
  AuraStat,
  CreepTuning,
  EntKind,
  EntTeam,
  ItemId,
  MapDef,
  TeamId,
} from '@rift/shared';
import { NO_ENT } from './types.js';
import type {
  AbilitiesEngine,
  AuraInstance,
  CampState,
  Ent,
  EntId,
  Order,
  QueuedCast,
  SeatDef,
  SimEvent,
  World,
} from './types.js';
import { stepMovement } from './movement.js';
import { stepCombat, stepDeaths } from './combat.js';
import { stepCamps } from './camps.js';
import { stepUnits } from './units.js';
import { cellIndexAt, cellMidX, cellMidZ, nearestPassableCell } from './pathing.js';

interface QueuedOrder {
  readonly hero: EntId;
  readonly order: Order;
}

/** Per-mobile base stats (before items/auras). Heroes: base + level growth,
 *  updated on level-up. Creeps: wave tuning, scaled by wave growth at spawn.
 *  Effective stats are derived from this every tick in recomputeEnt(). */
export interface CoreStats {
  maxHp: number;
  maxMana: number;
  damage: number;
  armor: number;
  attackPeriod: number;
  attackRange: number;
  moveSpeed: number;
  hpRegen: number;
  manaRegen: number;
  lifesteal: number;
  vision: number;
}

/** One radius > 0 passive aura granted to `target` by `source`; membership is
 *  re-evaluated every 5 ticks (advance step 3) and stale entries are swept by
 *  stamp. Kept OUT of Ent.auras so a passive can never be confused with an
 *  active aura from the same source on the same stat. */
export interface PassiveAuraEntry {
  readonly source: EntId;
  readonly stat: AuraStat;
  amount: number;
  readonly pct: boolean;
  stamp: number;
}

const DASH_TICKS = Math.round(0.15 * TICK_RATE); // dashes cross in ~0.15 s
const MAX_AURA_INSTANCES = 16; // far above anything the roster can produce

/** How far (in cells) an order destination inside a cliff may snap out to the
 *  nearest walkable cell (AMENDMENT_1 §C).
 *
 *  Six cells, which is the same allowance A*'s goal snap uses in pathing.ts:
 *  an order and the search that serves it must agree about which destinations
 *  are reachable, or a hero would be sent to a point the planner then refuses
 *  to route to. A click on a cliff FACE walks you to the foot of it; a click
 *  six metres deep inside a mountain is not a destination at all, and the
 *  order keeps its literal coordinate so movement stops the unit at the face. */
const ORDER_SNAP_CELLS = 6;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function makeEnt(
  id: EntId,
  kind: EntKind,
  team: EntTeam,
  x: number,
  z: number,
  radius: number,
): Ent {
  return {
    id,
    kind,
    team,
    x,
    z,
    radius,
    hp: 1,
    maxHp: 1,
    mana: 0,
    maxMana: 0,
    alive: true,
    damage: 0,
    armor: 0,
    attackPeriod: 1,
    attackRange: 0,
    moveSpeed: 0,
    hpRegen: 0,
    manaRegen: 0,
    lifesteal: 0,
    vision: 0,
    bounty: 0,
    xpValue: 0,
    nextAttackTick: 0,
    atkTarget: NO_ENT,
    order: 'idle',
    ox: 0,
    oz: 0,
    orderTarget: NO_ENT,
    // AMENDMENT_2 §D.1. The frozen shape says `path: readonly Vec2[] | null`
    // and `pathIndex: number`, so "not written yet" is null/0 — never
    // `undefined`. Leaving them off forced every reader in movement.ts and
    // camps.ts to coalesce, and made the object literal itself a type error.
    path: null,
    pathIndex: 0,
    lane: -1,
    waypoint: 0,
    stunUntilTick: 0,
    slowPct: 0,
    slowUntilTick: 0,
    dashUntilTick: 0,
    expireAtTick: 0,
    auras: [],
    level: 0,
    xp: 0,
    gold: 0,
    skillPoints: 0,
    hero: null,
    pid: null,
    owner: NO_ENT,
    abilityRanks: [0, 0, 0, 0],
    abilityCdUntilTick: [0, 0, 0, 0],
    items: [null, null, null, null, null, null],
    itemCharges: [0, 0, 0, 0, 0, 0],
    itemCdUntilTick: [0, 0, 0, 0, 0, 0],
    respawnAtTick: 0,
    kills: 0,
    deaths: 0,
    assists: 0,
    goldEarned: 0,
    heroDamage: 0,
    structureDamage: 0,
    lastHitBy: NO_ENT,
    recentDamagers: [],
  };
}

/** Tuning for spawnMobile kinds that come from config's CreepTuning shape.
 *
 *  The three camp kinds are here for one reason that cannot be fixed anywhere
 *  else (AMENDMENT_2 §D.2): `Ent.radius` is `readonly` and is written once, by
 *  `makeEnt`, from `t.radius`. `applyCampStats` runs afterwards and cannot
 *  correct it — so without these arms every camp member carried the 0.3 m
 *  fallback instead of its tier's 0.38 / 0.70 / 0.40, and combat reach,
 *  separation and structure push-out were all wrong for a brute by 0.4 m. */
function mobileTuning(kind: EntKind): CreepTuning | null {
  switch (kind) {
    case 'melee':
      return CREEP_MELEE;
    case 'ranged':
      return CREEP_RANGED;
    case 'siege':
      return CREEP_SIEGE;
    case 'shade':
      return SUMMON_SHADE;
    case 'campPack':
      return CAMP_PACK;
    case 'campBrute':
      return CAMP_BRUTE;
    case 'campHive':
      return CAMP_HIVE;
    default:
      return null;
  }
}

// --- stat accumulation (module-level, reused: no per-tick allocation) --------

interface StatAcc {
  damageFlat: number;
  damagePct: number;
  armorFlat: number;
  armorPct: number;
  attackSpeed: number; // fraction
  moveFlat: number;
  movePct: number;
  hpRegenFlat: number;
  hpRegenPct: number;
  manaRegenFlat: number;
  manaRegenPct: number;
  lifesteal: number;
}

const ACC: StatAcc = {
  damageFlat: 0,
  damagePct: 0,
  armorFlat: 0,
  armorPct: 0,
  attackSpeed: 0,
  moveFlat: 0,
  movePct: 0,
  hpRegenFlat: 0,
  hpRegenPct: 0,
  manaRegenFlat: 0,
  manaRegenPct: 0,
  lifesteal: 0,
};

function resetAcc(): void {
  ACC.damageFlat = 0;
  ACC.damagePct = 0;
  ACC.armorFlat = 0;
  ACC.armorPct = 0;
  ACC.attackSpeed = 0;
  ACC.moveFlat = 0;
  ACC.movePct = 0;
  ACC.hpRegenFlat = 0;
  ACC.hpRegenPct = 0;
  ACC.manaRegenFlat = 0;
  ACC.manaRegenPct = 0;
  ACC.lifesteal = 0;
}

function accAura(stat: AuraStat, amount: number, pct: boolean): void {
  switch (stat) {
    case 'damage':
      if (pct) ACC.damagePct += amount;
      else ACC.damageFlat += amount;
      break;
    case 'armor':
      if (pct) ACC.armorPct += amount;
      else ACC.armorFlat += amount;
      break;
    case 'attackSpeed':
      ACC.attackSpeed += amount; // always read as a fraction
      break;
    case 'moveSpeed':
      if (pct) ACC.movePct += amount;
      else ACC.moveFlat += amount;
      break;
    case 'hpRegen':
      if (pct) ACC.hpRegenPct += amount;
      else ACC.hpRegenFlat += amount;
      break;
    case 'manaRegen':
      if (pct) ACC.manaRegenPct += amount;
      else ACC.manaRegenFlat += amount;
      break;
  }
}

// --- the world ----------------------------------------------------------------

export class SimWorld implements World {
  tick = 0;
  overtime = false;
  /** Set when the match end event has been emitted; advance() then no-ops. */
  ended = false;
  firstBloodDone = false;

  /** The live camp table (sim/types.ts `World.camps`): one entry per
   *  `map.terrain.camps` entry, in that exact order, so `camps[i].id === i`.
   *  Built once at construction and never resized — `stepCamps` is the only
   *  writer of the entries, and it rewrites `memberIds` in place. */
  readonly camps: CampState[] = [];

  readonly structures: Ent[] = []; // indexed by MapDef structure id
  readonly mobileMap = new Map<EntId, Ent>(); // ids >= 1000, insertion ordered
  nextMobileId = 1000;
  /** Base stat side table for mobiles (structures are static). */
  readonly base = new Map<EntId, CoreStats>();
  /** Radius > 0 passive aura membership, keyed by TARGET ent id. */
  readonly passiveAuras = new Map<EntId, PassiveAuraEntry[]>();
  passiveStamp = 0;

  readonly orderQueue: QueuedOrder[] = [];
  castQueue: QueuedCast[] = [];
  private castQueueSpare: QueuedCast[] = [];
  readonly events: SimEvent[] = [];

  /** Shared scratch for inRadius consumers; never held across calls. */
  readonly scratchA: Ent[] = [];
  readonly scratchB: Ent[] = [];
  /** Death/expiry sweep buffer. */
  readonly deadBuf: Ent[] = [];

  readonly wardStockArr: [number, number] = [WARD_TEAM_STOCK, WARD_TEAM_STOCK];
  lastRestockTick = 0;

  nextWaveTick: number;
  waveIndex = 0;

  /** Per-team ancient lookup, resolved once from the map. */
  readonly ancientId: [EntId, EntId] = [NO_ENT, NO_ENT];
  readonly ancientX: [number, number] = [0, 0];
  readonly ancientZ: [number, number] = [0, 0];

  constructor(
    readonly map: MapDef,
    seats: readonly SeatDef[],
    readonly abilities: AbilitiesEngine,
  ) {
    this.nextWaveTick = Math.round(WAVE_FIRST_AT_S * TICK_RATE);
    // The jungle table. `aliveCount` 0 with `respawnAtTick` 0 is the "due now"
    // encoding stepCamps reads: at tick 1 it finds every camp empty with its
    // clock already served and stands the whole jungle up. (-1 would mean "up",
    // and would leave the map permanently empty.)
    for (const def of map.terrain.camps) {
      this.camps.push({ id: def.id, def, memberIds: [], aliveCount: 0, respawnAtTick: 0 });
    }
    for (const def of map.structures) {
      const radius =
        def.kind === 'ancient'
          ? ANCIENT.radius
          : def.kind === 'guard'
            ? GUARD_TOWER.radius
            : TOWER.radius;
      const e = makeEnt(def.id, def.kind, def.team, def.x, def.z, radius);
      e.lane = def.lane ?? -1;
      switch (def.kind) {
        case 'tower': {
          e.maxHp = TOWER.hp;
          e.armor = TOWER.armor;
          e.damage = TOWER.damage;
          e.attackPeriod = TOWER.attackPeriod;
          e.attackRange = TOWER.attackRange;
          e.vision = TOWER.vision;
          e.bounty = TOWER.bounty;
          break;
        }
        case 'guard': {
          e.maxHp = GUARD_TOWER.hp;
          e.armor = GUARD_TOWER.armor;
          e.damage = GUARD_TOWER.damage;
          e.attackPeriod = GUARD_TOWER.attackPeriod;
          e.attackRange = GUARD_TOWER.attackRange;
          e.vision = GUARD_TOWER.vision;
          e.bounty = GUARD_TOWER.bounty;
          break;
        }
        case 'ancient': {
          e.maxHp = ANCIENT.hp;
          e.armor = ANCIENT.armor;
          e.vision = ANCIENT.vision;
          break;
        }
      }
      e.hp = e.maxHp;
      this.structures[def.id] = e;
      if (def.kind === 'ancient') {
        this.ancientId[def.team] = def.id;
        this.ancientX[def.team] = def.x;
        this.ancientZ[def.team] = def.z;
      }
    }
    const perTeam: [number, number] = [0, 0];
    for (const seat of seats) {
      const idx = perTeam[seat.team] ?? 0;
      perTeam[seat.team] = idx + 1;
      this.spawnHero(seat, idx);
    }
  }

  // --- reads -------------------------------------------------------------------

  get(id: EntId): Ent | undefined {
    if (id >= 1000) return this.mobileMap.get(id);
    if (id >= 0 && id < this.structures.length) return this.structures[id];
    return undefined;
  }

  *all(): Iterable<Ent> {
    yield* this.structures;
    yield* this.mobileMap.values();
  }

  *mobiles(): Iterable<Ent> {
    yield* this.mobileMap.values();
  }

  inRadius(x: number, z: number, r: number, out: Ent[]): number {
    const r2 = r * r;
    let n = 0;
    for (const e of this.all()) {
      if (!e.alive) continue;
      const dx = e.x - x;
      const dz = e.z - z;
      if (dx * dx + dz * dz <= r2) {
        // Index-write into the CALLER's buffer: it grows once to the high-water
        // mark and is then reused (scratch arrays never shrink) — the function
        // itself allocates nothing, and callers read only the returned count.
        out[n] = e;
        n += 1;
      }
    }
    return n;
  }

  // --- intake --------------------------------------------------------------------

  order(hero: EntId, order: Order): void {
    this.orderQueue.push({ hero, order });
  }

  cast(hero: EntId, slot: number, x: number | null, z: number | null, target: EntId): void {
    this.castQueue.push({ kind: 'ability', hero, slot, x, z, target });
  }

  /** Frozen seam: returns the queued casts in intake order and hands the
   *  buffer over (double-buffered; the returned array is reused on the NEXT
   *  drain, so the engine consumes it synchronously inside step(2)). */
  drainCasts(): QueuedCast[] {
    const out = this.castQueue;
    const spare = this.castQueueSpare;
    spare.length = 0;
    this.castQueue = spare;
    this.castQueueSpare = out;
    return out;
  }

  /** Frozen seam: the event sink for every sim module (combat kills,
   *  engine casts, structure falls, surge, end). */
  pushEvent(ev: SimEvent): void {
    this.events.push(ev);
  }

  // --- mutation surface ----------------------------------------------------------

  /** True while any of team's guard towers stands: its ancient is immune. */
  guardAlive(team: TeamId): boolean {
    for (const s of this.structures) {
      if (s.kind === 'guard' && s.team === team && s.alive) return true;
    }
    return false;
  }

  /** True when Fortify applies AGAINST structure d: no enemy wave-creep
   *  (melee/ranged/siege — summons do not count) within FORTIFY_RADIUS. */
  fortifyActive(d: Ent): boolean {
    const n = this.inRadius(d.x, d.z, FORTIFY_RADIUS, this.scratchB);
    for (let i = 0; i < n; i++) {
      const e = this.scratchB[i];
      if (!e || e.team === d.team) continue;
      if (e.kind === 'melee' || e.kind === 'ranged' || e.kind === 'siege') return false;
    }
    return true;
  }

  /** Internal damage pipeline: siege multiplier + Fortify + mitigation +
   *  ancient-guard immunity + bookkeeping. Returns the post-mitigation amount
   *  actually dealt (combat needs it for lifesteal). */
  dealDamage(src: EntId, dst: EntId, amount: number, school: 'physical' | 'magic'): number {
    const d = this.get(dst);
    if (!d || !d.alive || !(amount > 0)) return 0;
    // `guardAlive` takes a TeamId: narrow rather than assert (sim/types.ts
    // Ent.team). A neutral ancient does not exist and would have no guard ring
    // to hide behind, so the neutral branch is "takes the damage".
    if (d.kind === 'ancient' && isPlayerTeam(d.team) && this.guardAlive(d.team)) return 0;
    const s = src !== NO_ENT ? this.get(src) : undefined;
    let dealt = amount;
    if (d.id < 1000 && s) {
      if (s.kind === 'siege') dealt *= SIEGE_BUILDING_MULT;
      if (s.kind === 'hero' && this.fortifyActive(d)) dealt *= FORTIFY_HERO_DAMAGE_MULT;
    }
    if (school === 'physical') {
      const a = d.armor;
      dealt *= 1 - (ARMOR_K * a) / (1 + ARMOR_K * Math.abs(a));
    } else if (d.kind === 'hero') {
      dealt *= 1 - HERO_MAGIC_RESIST;
    }
    if (!(dealt > 0)) return 0;
    if (dealt > d.hp) dealt = d.hp;
    d.hp -= dealt;
    d.lastHitBy = src;
    if (s && s.kind === 'hero' && s.team !== d.team) {
      if (d.kind === 'hero') {
        s.heroDamage += dealt;
        this.noteDamager(d, src);
      } else if (d.id < 1000) {
        s.structureDamage += dealt;
      }
    }
    return dealt;
  }

  damage(src: EntId, dst: EntId, amount: number, school: 'physical' | 'magic'): void {
    this.dealDamage(src, dst, amount, school);
  }

  /** Record a hero-on-hero damager for assist windows and tower hero-aggro. */
  noteDamager(victim: Ent, src: EntId): void {
    const list = victim.recentDamagers;
    for (const rd of list) {
      if (rd.id === src) {
        rd.tick = this.tick;
        return;
      }
    }
    if (list.length >= 8) list.shift(); // bounded ring; 8 damagers is far past real
    list.push({ id: src, tick: this.tick });
  }

  heal(dst: EntId, amount: number): void {
    const d = this.get(dst);
    if (!d || !d.alive || !(amount > 0)) return;
    d.hp = Math.min(d.maxHp, d.hp + amount);
  }

  stun(dst: EntId, durationS: number): void {
    const d = this.get(dst);
    if (!d || !d.alive || !(durationS > 0)) return;
    const until = this.tick + Math.max(1, Math.round(durationS * TICK_RATE));
    if (until > d.stunUntilTick) d.stunUntilTick = until;
  }

  slow(dst: EntId, pct: number, durationS: number): void {
    const d = this.get(dst);
    if (!d || !d.alive || !(pct > 0) || !(durationS > 0)) return;
    const until = this.tick + Math.max(1, Math.round(durationS * TICK_RATE));
    // Slows never stack: the strongest active slow wins.
    if (this.tick >= d.slowUntilTick || pct >= d.slowPct) {
      d.slowPct = pct;
      d.slowUntilTick = until;
    }
  }

  applyAura(
    dst: EntId,
    stat: AuraStat,
    amount: number,
    pct: boolean,
    durationS: number,
    source: EntId,
  ): void {
    const d = this.get(dst);
    if (!d || !d.alive) return;
    const until = durationS === 0 ? 0 : this.tick + Math.max(1, Math.round(durationS * TICK_RATE));
    if (d.auras.length >= MAX_AURA_INSTANCES) d.auras.shift();
    d.auras.push({ stat, amount, pct, untilTick: until, source });
  }

  dash(id: EntId, tx: number, tz: number): void {
    const e = this.get(id);
    if (!e || !e.alive || id < 1000) return;
    e.ox = clamp(tx, 0, this.map.side);
    e.oz = clamp(tz, 0, this.map.side);
    e.dashUntilTick = this.tick + DASH_TICKS;
  }

  /** Frozen signature (sim/types.ts): `team` is `EntTeam`, because camps spawn
   *  through this same door with `NEUTRAL_TEAM, lane = -1, owner = NO_ENT`.
   *  Nothing in here narrows it back to `TeamId` or indexes a per-team tuple
   *  with it — the one place the team is read at all is the lane-waypoint seed
   *  below, and that is guarded. */
  spawnMobile(
    kind: EntKind,
    team: EntTeam,
    x: number,
    z: number,
    lane: number,
    expireAtTick: number,
    owner: EntId,
  ): EntId {
    const id = this.nextMobileId;
    this.nextMobileId += 1;
    const t = mobileTuning(kind);
    const e = makeEnt(id, kind, team, x, z, t ? t.radius : 0.3);
    e.lane = lane;
    e.expireAtTick = expireAtTick;
    e.owner = owner;
    let core: CoreStats;
    if (t) {
      e.maxHp = t.hp;
      e.hp = t.hp;
      e.damage = t.damage;
      e.armor = t.armor;
      e.attackPeriod = t.attackPeriod;
      e.attackRange = t.attackRange;
      e.moveSpeed = t.moveSpeed;
      e.vision = t.vision;
      e.bounty = t.bounty;
      e.xpValue = t.xp;
      core = {
        maxHp: t.hp,
        maxMana: 0,
        damage: t.damage,
        armor: t.armor,
        attackPeriod: t.attackPeriod,
        attackRange: t.attackRange,
        moveSpeed: t.moveSpeed,
        hpRegen: 0,
        manaRegen: 0,
        lifesteal: 0,
        vision: t.vision,
      };
    } else {
      // 'ward' / 'proj': untargetable markers. Wards see; projs are owned and
      // moved by the abilities engine.
      e.maxHp = 1;
      e.hp = 1;
      e.vision = kind === 'ward' ? WARD_VISION : 0;
      core = {
        maxHp: 1,
        maxMana: 0,
        damage: 0,
        armor: 0,
        attackPeriod: 1,
        attackRange: 0,
        moveSpeed: 0,
        hpRegen: 0,
        manaRegen: 0,
        lifesteal: 0,
        vision: e.vision,
      };
    }
    // First waypoint to walk toward (team 1 walks the polyline reversed).
    // `isPlayerTeam` is not decoration here: a lane polyline runs base-to-base
    // between the two PLAYER bases, so "the other end" is undefined for a
    // neutral, and a camp creep that ever picked up a waypoint would march
    // down a lane (TERRAIN_CONTRACT §5 names this the most likely way the
    // jungle breaks). Camps pass lane -1; this keeps them off a polyline even
    // if some future caller does not.
    if (lane >= 0 && isPlayerTeam(team)) {
      const path = this.map.paths[lane];
      if (path && path.length >= 2) {
        e.waypoint = team === 0 ? 1 : path.length - 2;
      }
    }
    this.mobileMap.set(id, e);
    this.base.set(id, core);
    return id;
  }

  // --- shop + progression (units.ts owns the rules; the door is here) ------------

  /** True when the hero stands within its own fountain radius. A neutral has
   *  no ancient and therefore no fountain, so it is never at one — narrowed
   *  before the two-element ancient tuples are indexed. */
  atOwnFountain(h: Ent): boolean {
    if (!isPlayerTeam(h.team)) return false;
    const ax = this.ancientX[h.team];
    const az = this.ancientZ[h.team];
    if (ax === undefined || az === undefined) return false;
    return Math.hypot(h.x - ax, h.z - az) <= FOUNTAIN_RADIUS;
  }

  buy(hero: EntId, item: ItemId): void {
    const h = this.get(hero);
    if (!h || !h.alive || h.kind !== 'hero') return;
    const def = ITEMS[item];
    if (!def || h.gold < def.cost) return;
    if (!this.atOwnFountain(h)) return;
    // Wardstone stacks charges into an existing wardstone slot.
    if (def.active?.kind === 'ward') {
      for (let i = 0; i < INVENTORY_SLOTS; i++) {
        if (h.items[i] === def.id) {
          h.gold -= def.cost;
          h.itemCharges[i] = (h.itemCharges[i] ?? 0) + def.active.charges;
          return;
        }
      }
    }
    let slot = -1;
    for (let i = 0; i < INVENTORY_SLOTS; i++) {
      const held = h.items[i];
      if (held === null || held === undefined) {
        slot = i;
        break;
      }
    }
    if (slot < 0) return; // full inventory: silent no-op
    h.gold -= def.cost;
    h.items[slot] = def.id;
    h.itemCharges[slot] = def.active?.kind === 'ward' ? def.active.charges : 0;
    h.itemCdUntilTick[slot] = 0;
    this.recomputeEnt(h);
  }

  spendSkillPoint(hero: EntId, slot: number): void {
    const h = this.get(hero);
    if (!h || h.kind !== 'hero' || h.hero === null) return;
    if (!Number.isInteger(slot) || slot < 0 || slot > 3) return;
    if (h.skillPoints < 1) return;
    const def = heroById(h.hero);
    const ab = def.abilities[slot];
    if (!ab) return;
    const rank = h.abilityRanks[slot] ?? 0;
    if (rank >= ab.maxRank) return;
    if (ab.ult) {
      const req = ULT_LEVEL_REQ[rank]; // index = next rank - 1
      if (req === undefined || h.level < req) return;
    }
    h.abilityRanks[slot] = rank + 1;
    h.skillPoints -= 1;
  }

  useItem(hero: EntId, slot: number, x: number | null, z: number | null): void {
    const h = this.get(hero);
    if (!h || !h.alive || h.kind !== 'hero') return;
    if (!Number.isInteger(slot) || slot < 0 || slot >= INVENTORY_SLOTS) return;
    const id = h.items[slot];
    if (id === null || id === undefined) return;
    const act = ITEMS[id].active;
    if (!act) return;
    if ((h.itemCdUntilTick[slot] ?? 0) > this.tick) return;
    switch (act.kind) {
      case 'dash':
      case 'aura': {
        // Validate + spend, then hand execution to the abilities engine: it
        // drains the {kind:'item'} entry at advance() step (2) and never
        // re-validates (frozen seam, sim/types.ts QueuedCast).
        if (act.kind === 'dash' && (x === null || z === null)) return;
        h.itemCdUntilTick[slot] = this.tick + Math.round(act.cooldown * TICK_RATE);
        this.castQueue.push({ kind: 'item', hero, slot, x, z });
        break;
      }
      case 'ward': {
        // Wardstone places directly in units.ts machinery — never queued.
        if (x === null || z === null) return;
        // `wardStockArr` is a two-element per-team tuple: narrow before
        // indexing it (sim/types.ts Ent.team). The stock pool is a player-team
        // resource, so a neutral holder has none and cannot place.
        const team = h.team;
        if (!isPlayerTeam(team)) return;
        if ((h.itemCharges[slot] ?? 0) < 1) return;
        if ((this.wardStockArr[team] ?? 0) < 1) return; // 0 team stock: silent no-op
        if (Math.hypot(x - h.x, z - h.z) > WARD_PLACE_RANGE) return;
        h.itemCharges[slot] = (h.itemCharges[slot] ?? 0) - 1;
        this.wardStockArr[team] = (this.wardStockArr[team] ?? 0) - 1;
        this.spawnMobile('ward', team, x, z, -1, this.tick + Math.round(WARD_DURATION_S * TICK_RATE), hero);
        if (h.itemCharges[slot] === 0) {
          h.items[slot] = null;
          h.itemCdUntilTick[slot] = 0;
        }
        break;
      }
    }
  }

  wardStock(team: TeamId): number {
    return this.wardStockArr[team] ?? 0;
  }

  drainEvents(): SimEvent[] {
    return this.events.splice(0, this.events.length);
  }

  // --- stat upkeep (advance step 3) ----------------------------------------------

  /** Recompute one mobile's effective stats from base + items + auras +
   *  passive-aura membership. Called every tick for every mobile (step 3) and
   *  immediately after buys/level-ups. Allocates nothing. */
  recomputeEnt(e: Ent): void {
    const core = this.base.get(e.id);
    if (!core) return;
    resetAcc();
    let maxHp = core.maxHp;
    let maxMana = core.maxMana;
    if (e.kind === 'hero') {
      for (const held of e.items) {
        if (held === null || held === undefined) continue;
        const st = ITEMS[held].stats;
        if (!st) continue;
        ACC.damageFlat += st.damage ?? 0;
        maxHp += st.maxHp ?? 0;
        ACC.armorFlat += st.armor ?? 0;
        ACC.moveFlat += st.moveSpeed ?? 0;
        ACC.attackSpeed += st.attackSpeed ?? 0;
        maxMana += st.mana ?? 0;
        ACC.manaRegenFlat += st.manaRegen ?? 0;
        ACC.hpRegenFlat += st.hpRegen ?? 0;
        ACC.lifesteal += st.lifesteal ?? 0;
      }
    }
    for (const a of e.auras) accAura(a.stat, a.amount, a.pct);
    const pl = this.passiveAuras.get(e.id);
    if (pl) for (const p of pl) accAura(p.stat, p.amount, p.pct);
    e.damage = (core.damage + ACC.damageFlat) * (1 + ACC.damagePct);
    e.armor = (core.armor + ACC.armorFlat) * (1 + ACC.armorPct);
    e.attackPeriod = core.attackPeriod / Math.max(0.05, 1 + ACC.attackSpeed);
    e.moveSpeed = (core.moveSpeed + ACC.moveFlat) * (1 + ACC.movePct);
    e.hpRegen = (core.hpRegen + ACC.hpRegenFlat) * (1 + ACC.hpRegenPct);
    e.manaRegen = (core.manaRegen + ACC.manaRegenFlat) * (1 + ACC.manaRegenPct);
    e.lifesteal = core.lifesteal + ACC.lifesteal;
    e.maxHp = maxHp;
    e.maxMana = maxMana;
    if (e.hp > e.maxHp) e.hp = e.maxHp;
    if (e.mana > e.maxMana) e.mana = e.maxMana;
  }

  /** Grant a passive membership entry to `target` from `source` (upsert by
   *  source+stat), stamped with the current re-evaluation cycle. */
  setPassiveAura(target: EntId, source: EntId, stat: AuraStat, amount: number, pct: boolean): void {
    let list = this.passiveAuras.get(target);
    if (!list) {
      list = [];
      this.passiveAuras.set(target, list);
    }
    for (const entry of list) {
      if (entry.source === source && entry.stat === stat) {
        entry.amount = amount;
        entry.stamp = this.passiveStamp;
        return;
      }
    }
    list.push({ source, stat, amount, pct, stamp: this.passiveStamp });
  }

  /** Step 3: slow/stun/aura expiry, self-passive rank refresh, radius > 0
   *  passive membership re-evaluation (every 5 ticks), full stat recompute. */
  stepUpkeep(): void {
    for (const e of this.mobileMap.values()) {
      if (e.slowUntilTick !== 0 && this.tick >= e.slowUntilTick) {
        e.slowPct = 0;
        e.slowUntilTick = 0;
      }
      if (e.stunUntilTick !== 0 && this.tick >= e.stunUntilTick) e.stunUntilTick = 0;
      const arr = e.auras;
      for (let i = arr.length - 1; i >= 0; i--) {
        const a = arr[i];
        if (!a) continue;
        if (a.untilTick !== 0 && this.tick >= a.untilTick) {
          const top = arr.pop();
          if (top !== undefined && i < arr.length) arr[i] = top;
        }
      }
    }
    this.refreshPassives();
    for (const e of this.mobileMap.values()) this.recomputeEnt(e);
  }

  private refreshPassives(): void {
    const reevaluate = this.tick % 5 === 0;
    if (reevaluate) this.passiveStamp += 1;
    for (const e of this.mobileMap.values()) {
      if (!e.alive || e.kind !== 'hero' || e.hero === null) continue;
      const def = heroById(e.hero);
      for (let s = 0; s < 4; s++) {
        const ab = def.abilities[s];
        if (!ab || !ab.isPassive) continue;
        const rank = e.abilityRanks[s] ?? 0;
        if (rank < 1) continue;
        for (const ef of ab.effects) {
          if (ef.kind !== 'aura') continue;
          const amount = ef.amount[rank - 1];
          if (amount === undefined) continue;
          if (ef.radius === 0) {
            // Self passive: a permanent instance at the current rank's amount
            // (this is also the rank-up refresh path for self passives).
            let found: AuraInstance | undefined;
            for (const a of e.auras) {
              if (a.untilTick === 0 && a.source === e.id && a.stat === ef.stat) {
                found = a;
                break;
              }
            }
            if (found) found.amount = amount;
            else e.auras.push({ stat: ef.stat, amount, pct: ef.pct, untilTick: 0, source: e.id });
          } else if (reevaluate) {
            // Radius > 0 passive: re-assert membership on allies in range.
            const n = this.inRadius(e.x, e.z, ef.radius, this.scratchA);
            for (let i = 0; i < n; i++) {
              const t = this.scratchA[i];
              if (t && t.team === e.team && t.id >= 1000) {
                this.setPassiveAura(t.id, e.id, ef.stat, amount, ef.pct);
              }
            }
          }
        }
      }
    }
    if (!reevaluate) return;
    // Sweep memberships that were not re-asserted this cycle.
    for (const [target, list] of this.passiveAuras) {
      for (let i = list.length - 1; i >= 0; i--) {
        const entry = list[i];
        if (entry && entry.stamp < this.passiveStamp) {
          const top = list.pop();
          if (top !== undefined && i < list.length) list[i] = top;
        }
      }
      if (list.length === 0) this.passiveAuras.delete(target);
    }
  }

  // --- orders (advance step 1) -----------------------------------------------------

  /**
   * Write an order destination onto `e`: clamped into the map, then SNAPPED to
   * the nearest passable cell centre (AMENDMENT_1 §C).
   *
   * The clamp comes first and is separately observable — `nearestPassableCell`
   * clamps into the grid on its own, so folding the two together would hide a
   * broken bounds clamp behind the snap for out-of-bounds coordinates.
   *
   * The snap exists because cliffs are now solid and nothing but a hero is
   * pathed: an order onto a cliff would otherwise steer the unit into the face
   * and leave it pressed there for the rest of the match, having consumed the
   * player's click. Only an IMPASSABLE destination moves — a legal click keeps
   * its exact coordinate, so ordinary orders are unaffected to the last bit,
   * and a destination buried more than {@link ORDER_SNAP_CELLS} deep in rock
   * keeps its coordinate too (there is no sensible nearby ground to mean).
   */
  private setDest(e: Ent, x: number, z: number): void {
    const cx = clamp(x, 0, this.map.side);
    const cz = clamp(z, 0, this.map.side);
    const g = this.map.terrain.grid;
    const here = cellIndexAt(g, cx, cz);
    const snapped = nearestPassableCell(g, cx, cz, ORDER_SNAP_CELLS);
    if (snapped < 0 || snapped === here) {
      e.ox = cx;
      e.oz = cz;
      return;
    }
    e.ox = cellMidX(g, snapped);
    e.oz = cellMidZ(g, snapped);
  }

  private applyOrders(): void {
    for (const q of this.orderQueue) {
      const e = this.get(q.hero);
      if (!e || !e.alive || e.kind !== 'hero') continue;
      const o = q.order;
      switch (o.kind) {
        case 'move':
          e.order = 'move';
          this.setDest(e, o.x, o.z);
          e.orderTarget = NO_ENT;
          break;
        case 'attackmove':
          e.order = 'attackmove';
          this.setDest(e, o.x, o.z);
          e.orderTarget = NO_ENT;
          break;
        case 'stop':
          e.order = 'idle';
          e.orderTarget = NO_ENT;
          break;
        case 'attack': {
          const t = this.get(o.target);
          const legal =
            t !== undefined &&
            t.alive &&
            t.team !== e.team &&
            t.kind !== 'ward' &&
            t.kind !== 'proj';
          if (legal) {
            e.order = 'attack';
            e.orderTarget = o.target;
          } else if (t !== undefined) {
            // Illegal target (dead / own team / ward): degrade to an
            // attack-move toward its last known position — through the same
            // clamp-and-snap door, since a corpse can lie anywhere.
            e.order = 'attackmove';
            this.setDest(e, t.x, t.z);
            e.orderTarget = NO_ENT;
          }
          // Unknown id: dropped entirely.
          break;
        }
      }
    }
    this.orderQueue.length = 0;
  }

  // --- win / overtime (advance step 8) ----------------------------------------------

  private finish(winner: TeamId | null, reason: 'ancient' | 'tiebreak' | 'draw'): void {
    if (this.ended) return;
    this.ended = true;
    this.events.push({ k: 'end', winner, reason });
  }

  private stepEndChecks(): void {
    const timeS = this.tick * TICK_DT;
    if (!this.overtime && timeS >= OVERTIME_AT_S) {
      this.overtime = true;
      this.events.push({ k: 'surge' });
    }
    for (const t of [0, 1] as const) {
      const aId = this.ancientId[t];
      const a = aId >= 0 ? this.structures[aId] : undefined;
      if (a && !a.alive) {
        this.finish(t === 0 ? 1 : 0, 'ancient');
        return;
      }
    }
    if (timeS >= MATCH_HARD_CAP_S) {
      // Tiebreak order (config.ts): ancient hp fraction, structures standing,
      // hero kills, team gold earned; exact equality = draw.
      const id0 = this.ancientId[0];
      const id1 = this.ancientId[1];
      const a0 = id0 >= 0 ? this.structures[id0] : undefined;
      const a1 = id1 >= 0 ? this.structures[id1] : undefined;
      const f0 = a0 ? a0.hp / a0.maxHp : 0;
      const f1 = a1 ? a1.hp / a1.maxHp : 0;
      let s0 = 0;
      let s1 = 0;
      // Both tallies below branch on the team EXPLICITLY rather than falling
      // through an `else`: `Ent.team` is EntTeam, and an `else` would silently
      // score a neutral for team 1. Structures and heroes are always on a
      // player team, so nothing is lost — but the tiebreak must not be the
      // place where that assumption is discovered to be wrong.
      for (const s of this.structures) {
        if (!s.alive) continue;
        if (s.team === 0) s0 += 1;
        else if (s.team === 1) s1 += 1;
      }
      let k0 = 0;
      let k1 = 0;
      let g0 = 0;
      let g1 = 0;
      for (const e of this.mobileMap.values()) {
        if (e.kind !== 'hero') continue;
        if (e.team === 0) {
          k0 += e.kills;
          g0 += e.goldEarned;
        } else if (e.team === 1) {
          k1 += e.kills;
          g1 += e.goldEarned;
        }
      }
      const metrics: readonly [number, number][] = [
        [f0, f1],
        [s0, s1],
        [k0, k1],
        [g0, g1],
      ];
      for (const m of metrics) {
        const m0 = m[0];
        const m1 = m[1];
        if (m0 === undefined || m1 === undefined) continue;
        if (m0 > m1) {
          this.finish(0, 'tiebreak');
          return;
        }
        if (m1 > m0) {
          this.finish(1, 'tiebreak');
          return;
        }
      }
      this.finish(null, 'draw');
    }
  }

  // --- hero spawn (construction / respawn share the fountain anchor) -----------------

  private spawnHero(seat: SeatDef, indexInTeam: number): void {
    const def = heroById(seat.hero);
    const id = this.nextMobileId;
    this.nextMobileId += 1;
    const spot = this.fountainSpot(seat.team, indexInTeam);
    const sx = spot[0] ?? 0;
    const sz = spot[1] ?? 0;
    const e = makeEnt(id, 'hero', seat.team, sx, sz, HERO_RADIUS);
    e.hero = seat.hero;
    e.pid = seat.pid;
    e.lane = seat.lane;
    e.level = 1;
    e.xp = 0;
    e.gold = STARTING_GOLD;
    e.skillPoints = STARTING_SKILL_POINTS;
    e.vision = HERO_VISION;
    const core: CoreStats = {
      maxHp: def.base.hp,
      maxMana: def.base.mana,
      damage: def.base.damage,
      armor: def.base.armor,
      attackPeriod: def.base.attackPeriod,
      attackRange: def.base.attackRange,
      moveSpeed: def.base.moveSpeed,
      hpRegen: def.base.hpRegen,
      manaRegen: def.base.manaRegen,
      lifesteal: 0,
      vision: HERO_VISION,
    };
    // attackRange has no item/aura modifier, so (like creeps in spawnMobile)
    // it is set once from the core; recomputeEnt owns the modifiable stats.
    e.attackRange = core.attackRange;
    e.hp = core.maxHp;
    e.mana = core.maxMana;
    this.mobileMap.set(id, e);
    this.base.set(id, core);
    this.recomputeEnt(e);
  }

  /** A point in team's fountain: 4 m toward the map centre from the ancient,
   *  fanned laterally by index so stacked heroes don't overlap exactly. */
  fountainSpot(team: TeamId, index: number): readonly [number, number] {
    const ax = this.ancientX[team] ?? 0;
    const az = this.ancientZ[team] ?? 0;
    const ex = this.ancientX[team === 0 ? 1 : 0] ?? 0;
    const ez = this.ancientZ[team === 0 ? 1 : 0] ?? 0;
    const d = Math.hypot(ex - ax, ez - az) || 1;
    const dx = (ex - ax) / d;
    const dz = (ez - az) / d;
    const lat = index === 0 ? 0 : (index % 2 === 1 ? 1 : -1) * Math.ceil(index / 2) * 1.2;
    return [ax + dx * 4 - dz * lat, az + dz * 4 + dx * lat];
  }

  // --- advance: the 9-step orchestration (CONTRACT §4 + AMENDMENT_1 §A) --------------

  advance(): void {
    if (this.ended) return;
    this.tick += 1;
    // (1) apply queued orders
    this.applyOrders();
    // (2) abilities: cast execution + projectile motion (INJECTED engine; it
    // drains the cast queue via drainCasts() — the world never reads it)
    this.abilities.step(this);
    // (3) buff expiry + stat recompute + passive membership (every 5 ticks)
    this.stepUpkeep();
    // (4) movement
    stepMovement(this);
    // (5) combat
    stepCombat(this);
    // (6) deaths / loot
    stepDeaths(this);
    // (7) neutral camps: leash, acquisition, respawn. AFTER stepDeaths so a
    // camp emptied this tick stamps its respawn on the same tick, and BEFORE
    // stepUnits so a member spawned here is an ordinary mobile for the rest of
    // it (AMENDMENT_1 §A, camps.ts header).
    stepCamps(this);
    // (8) waves / respawns / fountain / passive gold / expiry
    stepUnits(this);
    // (9) win / overtime checks
    this.stepEndChecks();
  }
}

/** Frozen signature (CONTRACT §4). `rand` is accepted per the seam; the sim
 *  core is fully deterministic and does not consume it. */
export function createWorld(
  map: MapDef,
  seats: readonly SeatDef[],
  rand: () => number,
  abilities: AbilitiesEngine,
): World {
  void rand;
  return new SimWorld(map, seats, abilities);
}
