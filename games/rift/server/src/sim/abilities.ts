// ============================================================================
// ANCIENTS (rift) — ABILITY ENGINE (T4). Implements the 8 frozen effect
// primitives from shared/src/ability.ts plus the two item actives
// (blinkstone dash, warhorn aura) that reuse the same machinery. Injected
// into the world at construction; step(world) runs as advance() step (2):
// drain the cast queue, validate + execute casts, move/resolve projectiles.
//
// SEAM GAPS (reported to the orchestrator — sim/types.ts is Layer-1 and may
// not be edited by this task): the frozen World surface has
//   1. no cast-queue drain — the engine cannot read queued casts;
//   2. no event sink — the engine cannot push the `cast` SimEvent that
//      world.drainEvents() is documented to return.
// Both are declared structurally below (WorldSeamGaps) and probed at runtime,
// so this module typechecks against the frozen interface today and works
// unchanged the moment the seam gains:
//   World.drainCasts(): QueuedCast[];
//   World.pushEvent(ev: SimEvent): void;
// Item actives reach the engine as { kind: 'item' } queue entries: units.ts
// validates + spends (charges/cooldown/ward stock) inside World.useItem and
// enqueues dash/aura actives here for execution; wardstone placement never
// leaves units.ts. Projectile/summon despawn uses Ent.expireAtTick = tick —
// the frozen surface has no despawnMobile, and expiry reaping is the world's
// own advance() step (7).
// ============================================================================
import type { AbilityDef, Effect, TargetTeam, TeamId } from '@rift/shared';
import { heroById, INVENTORY_SLOTS, ITEMS, SUMMON_MAX_ACTIVE, TICK_DT, TICK_RATE } from '@rift/shared';
import type { AbilitiesEngine, Ent, EntId, SimEvent, World } from './types.js';
import { NO_ENT } from './types.js';

/** One queued cast, drained by the engine at advance() step (2). 'ability'
 *  entries come from World.cast (slot 0..3 = q/w/e/r); 'item' entries are
 *  enqueued by World.useItem AFTER units.ts has validated and spent
 *  charges/cooldown (slot = inventory index 0..5). */
export type QueuedCast =
  | {
      readonly kind: 'ability';
      readonly hero: EntId;
      readonly slot: number;
      readonly x: number | null;
      readonly z: number | null;
      readonly target: EntId;
    }
  | {
      readonly kind: 'item';
      readonly hero: EntId;
      readonly slot: number;
      readonly x: number | null;
      readonly z: number | null;
    };

/** The two World members the frozen seam is missing (see header). Probed with
 *  typeof so a world built against the frozen interface alone simply no-ops
 *  casts instead of throwing — the "illegal input silently no-ops" rule. */
interface WorldSeamGaps {
  drainCasts(): QueuedCast[];
  pushEvent(ev: SimEvent): void;
}

/** Cast SimEvent slot base for item actives: ability casts report slot 0..3,
 *  item actives report ITEM_EVENT_SLOT_BASE + inventorySlot. */
export const ITEM_EVENT_SLOT_BASE = 4;

/** Engine-private projectile payload. The 'proj' Ent carries position/team;
 *  everything else lives here, keyed by insertion in a flat array (swap-remove
 *  on despawn — no per-tick allocation, no Map iterator tuples). */
interface ProjState {
  readonly id: EntId;
  readonly src: EntId;
  readonly team: TeamId;
  readonly effects: readonly Effect[];
  readonly rankIdx: number; // 0-based rank index
  readonly aoeRadius: number; // 0 = single target
  readonly homing: EntId; // NO_ENT = straight flight
  dirX: number;
  dirZ: number;
  readonly speed: number; // metres per second
  readonly radius: number; // hit radius
  remaining: number; // metres of flight left
  readonly pierce: boolean;
  readonly hit: Set<EntId>; // pierce applies once per unit
}

/** Per-rank array read; roster data guarantees length == maxRank and callers
 *  validate rank first, so the fallback is unreachable defensive code. */
function rk(arr: readonly number[], rankIdx: number): number {
  return arr[rankIdx] ?? 0;
}

/** Ability effects hit units only: heroes, creeps, summons. Never wards,
 *  never projectiles, never structures (combat.ts owns structure damage). */
function isUnitTargetable(e: Ent): boolean {
  return (
    e.kind === 'hero' ||
    e.kind === 'melee' ||
    e.kind === 'ranged' ||
    e.kind === 'siege' ||
    e.kind === 'shade'
  );
}

function teamOk(rule: TargetTeam, mine: TeamId, theirs: TeamId): boolean {
  if (rule === 'any') return true;
  if (rule === 'enemy') return theirs !== mine;
  return theirs === mine; // 'ally' includes self
}

function sideOk(side: 'enemy' | 'ally', mine: TeamId, theirs: TeamId): boolean {
  return side === 'enemy' ? theirs !== mine : theirs === mine;
}

function expired(e: Ent, tick: number): boolean {
  return e.expireAtTick !== 0 && e.expireAtTick <= tick;
}

export function createAbilitiesEngine(): AbilitiesEngine {
  return new AbilitiesEngineImpl();
}

class AbilitiesEngineImpl implements AbilitiesEngine {
  private readonly projs: ProjState[] = [];
  /** Reused inRadius scratch buffer (World fills it by index, never
   *  allocates); grown once to the widest query, then stable. */
  private readonly radiusBuf: Ent[] = [];

  step(world: World): void {
    const seam = world as World & Partial<WorldSeamGaps>;
    if (seam.drainCasts) {
      const casts = seam.drainCasts();
      for (const c of casts) {
        if (c.kind === 'ability') this.execAbilityCast(world, seam, c);
        else this.execItemCast(world, seam, c);
      }
    }
    this.moveProjectiles(world);
  }

  // --- Cast execution ---------------------------------------------------------

  private execAbilityCast(
    world: World,
    seam: Partial<WorldSeamGaps>,
    cast: Extract<QueuedCast, { kind: 'ability' }>,
  ): void {
    if (cast.slot < 0 || cast.slot > 3) return;
    const hero = world.get(cast.hero);
    if (!hero || hero.kind !== 'hero' || !hero.alive || hero.hero === null) return;
    if (hero.stunUntilTick > world.tick) return; // stunned: no casts
    const def: AbilityDef | undefined = heroById(hero.hero).abilities[cast.slot];
    if (!def || def.isPassive) return;
    const rank = hero.abilityRanks[cast.slot] ?? 0;
    if (rank < 1 || rank > def.maxRank) return;
    const ri = rank - 1;
    if ((hero.abilityCdUntilTick[cast.slot] ?? 0) > world.tick) return;
    const mana = rk(def.manaCost, ri);
    if (hero.mana < mana) return;
    const range = rk(def.castRange, ri);

    // Resolve the impact point + primary target per targeting mode.
    let ix = hero.x;
    let iz = hero.z;
    let primary: Ent | null = null;
    if (def.targeting === 'point') {
      const { x, z } = cast;
      if (x === null || z === null || !Number.isFinite(x) || !Number.isFinite(z)) return;
      if (Math.hypot(x - hero.x, z - hero.z) > range) return;
      ix = x;
      iz = z;
    } else if (def.targeting === 'unit') {
      const t = world.get(cast.target);
      if (!t || !t.alive || expired(t, world.tick) || !isUnitTargetable(t)) return;
      if (!teamOk(def.targetTeam ?? 'any', hero.team, t.team)) return;
      if (Math.hypot(t.x - hero.x, t.z - hero.z) > range) return;
      primary = t;
      ix = t.x;
      iz = t.z;
    }

    // Commit: spend mana, start cooldown, execute effects IN ARRAY ORDER.
    hero.mana -= mana;
    hero.abilityCdUntilTick[cast.slot] = world.tick + Math.round(rk(def.cooldown, ri) * TICK_RATE);
    const aoe = def.aoeRadius ? rk(def.aoeRadius, ri) : 0;
    if (def.projectile) {
      this.spawnProjectile(world, hero, def, ri, aoe, ix, iz, primary);
    } else {
      this.applyEffects(world, hero.id, hero.team, hero, def.effects, ri, aoe, ix, iz, primary);
    }
    seam.pushEvent?.({ k: 'cast', id: hero.id, team: hero.team, slot: cast.slot, x: ix, z: iz });
  }

  /** Item actives (blinkstone dash, warhorn aura). Validation + spend of
   *  charges/cooldown happened in units.ts before the entry was enqueued;
   *  the engine only re-checks that the caster lives and the slot still
   *  holds the item, then executes through the same effect machinery. */
  private execItemCast(
    world: World,
    seam: Partial<WorldSeamGaps>,
    cast: Extract<QueuedCast, { kind: 'item' }>,
  ): void {
    if (cast.slot < 0 || cast.slot >= INVENTORY_SLOTS) return;
    const hero = world.get(cast.hero);
    if (!hero || hero.kind !== 'hero' || !hero.alive) return;
    const itemId = hero.items[cast.slot];
    if (!itemId) return;
    const active = ITEMS[itemId].active;
    if (!active || active.kind === 'ward') return; // wardstone: units.ts owns it

    if (active.kind === 'dash') {
      const { x, z } = cast;
      if (x === null || z === null || !Number.isFinite(x) || !Number.isFinite(z)) return;
      this.dashToward(world, hero, x, z, active.distance);
      seam.pushEvent?.({
        k: 'cast',
        id: hero.id,
        team: hero.team,
        slot: ITEM_EVENT_SLOT_BASE + cast.slot,
        x,
        z,
      });
      return;
    }
    // aura: timed buff on all allies within radius of the caster (0 = self).
    if (active.radius <= 0) {
      world.applyAura(hero.id, active.stat, active.amount, active.pct, active.duration, hero.id);
    } else {
      this.eachAffected(world, hero.team, active.radius, hero.x, hero.z, null, 'ally', (id) =>
        world.applyAura(id, active.stat, active.amount, active.pct, active.duration, hero.id),
      );
    }
    seam.pushEvent?.({
      k: 'cast',
      id: hero.id,
      team: hero.team,
      slot: ITEM_EVENT_SLOT_BASE + cast.slot,
      x: hero.x,
      z: hero.z,
    });
  }

  // --- Effect primitives --------------------------------------------------------

  /** Execute effects in array order. `caster` is undefined only for projectile
   *  impacts whose source died in flight — caster-centric primitives (dash,
   *  summon) then skip; damage/heal/stun/slow/aura still land. */
  private applyEffects(
    world: World,
    src: EntId,
    team: TeamId,
    caster: Ent | undefined,
    effects: readonly Effect[],
    ri: number,
    aoe: number,
    ix: number,
    iz: number,
    primary: Ent | null,
  ): void {
    for (const fx of effects) {
      switch (fx.kind) {
        case 'dash':
          // Dash moves the caster FIRST (array order), so e.g. Shadow Strike
          // arrives at the target and then the damage effect cuts.
          if (caster && caster.alive) this.dashToward(world, caster, ix, iz, fx.distance);
          break;
        case 'damage':
          this.eachAffected(world, team, aoe, ix, iz, primary, 'enemy', (id) =>
            world.damage(src, id, rk(fx.amount, ri), fx.school),
          );
          break;
        case 'heal':
          this.eachAffected(world, team, aoe, ix, iz, primary, 'ally', (id) =>
            world.heal(id, rk(fx.amount, ri)),
          );
          break;
        case 'stun':
          this.eachAffected(world, team, aoe, ix, iz, primary, 'enemy', (id) =>
            world.stun(id, rk(fx.duration, ri)),
          );
          break;
        case 'slow':
          this.eachAffected(world, team, aoe, ix, iz, primary, 'enemy', (id) =>
            world.slow(id, rk(fx.pct, ri), rk(fx.duration, ri)),
          );
          break;
        case 'aura':
          // radius 0 = self; radius > 0 = all allies within radius of the
          // impact point at cast time; duration 0 = passive (world step 3
          // owns passive membership — passives never reach this engine).
          if (fx.radius <= 0) {
            if (caster && caster.alive) {
              world.applyAura(caster.id, fx.stat, rk(fx.amount, ri), fx.pct, fx.duration, src);
            }
          } else {
            this.eachAffected(world, team, fx.radius, ix, iz, null, 'ally', (id) =>
              world.applyAura(id, fx.stat, rk(fx.amount, ri), fx.pct, fx.duration, src),
            );
          }
          break;
        case 'summon':
          if (caster && caster.alive) this.doSummon(world, caster, rk(fx.count, ri), rk(fx.duration, ri));
          break;
      }
    }
  }

  /** Run fn over every eligible unit: the primary target when there is no
   *  AoE, else every targetable unit within `radius` of (x, z) on the given
   *  side ('enemy' for damage/stun/slow, 'ally' for heal/aura). */
  private eachAffected(
    world: World,
    team: TeamId,
    radius: number,
    x: number,
    z: number,
    primary: Ent | null,
    side: 'enemy' | 'ally',
    fn: (id: EntId) => void,
  ): void {
    if (radius <= 0) {
      if (primary && primary.alive && sideOk(side, team, primary.team)) fn(primary.id);
      return;
    }
    const n = world.inRadius(x, z, radius, this.radiusBuf);
    for (let i = 0; i < n; i++) {
      const e = this.radiusBuf[i];
      if (!e || !e.alive || expired(e, world.tick) || !isUnitTargetable(e)) continue;
      if (!sideOk(side, team, e.team)) continue;
      fn(e.id);
    }
  }

  /** Scripted dash toward (tx, tz), capped at `distance`; movement.ts clamps
   *  to bounds and stops at structure edges during the dash ticks. */
  private dashToward(world: World, caster: Ent, tx: number, tz: number, distance: number): void {
    const dx = tx - caster.x;
    const dz = tz - caster.z;
    const d = Math.hypot(dx, dz);
    const stepLen = Math.min(distance, d);
    if (d <= 1e-9 || stepLen <= 0) return;
    world.dash(caster.id, caster.x + (dx / d) * stepLen, caster.z + (dz / d) * stepLen);
  }

  /** Spawn 'shade' summons around the caster, capped at SUMMON_MAX_ACTIVE per
   *  owner — over-cap summons expire the OLDEST active shades first. */
  private doSummon(world: World, caster: Ent, count: number, durationS: number): void {
    if (count <= 0) return;
    const mine: Ent[] = [];
    for (const e of world.mobiles()) {
      if (e.kind === 'shade' && e.owner === caster.id && e.alive && !expired(e, world.tick)) {
        mine.push(e);
      }
    }
    const overflow = mine.length + count - SUMMON_MAX_ACTIVE;
    if (overflow > 0) {
      mine.sort((a, b) => a.expireAtTick - b.expireAtTick); // oldest first
      for (let i = 0; i < overflow && i < mine.length; i++) {
        const m = mine[i];
        if (m) m.expireAtTick = world.tick;
      }
    }
    const until = world.tick + Math.round(durationS * TICK_RATE);
    for (let i = 0; i < count; i++) {
      const ang = (i / count) * Math.PI * 2; // deterministic ring, no rng
      world.spawnMobile(
        'shade',
        caster.team,
        caster.x + Math.cos(ang),
        caster.z + Math.sin(ang),
        -1,
        until,
        caster.id,
      );
    }
  }

  // --- Projectiles --------------------------------------------------------------

  private spawnProjectile(
    world: World,
    caster: Ent,
    def: AbilityDef,
    ri: number,
    aoe: number,
    ix: number,
    iz: number,
    primary: Ent | null,
  ): void {
    const spec = def.projectile;
    if (!spec) return;
    let dx = ix - caster.x;
    let dz = iz - caster.z;
    const d = Math.hypot(dx, dz);
    if (d > 1e-9) {
      dx /= d;
      dz /= d;
    } else {
      dx = 1;
      dz = 0;
    }
    // Backstop expiry so a proj never leaks even if its payload is lost.
    const flightTicks = Math.ceil(spec.range / spec.speed / TICK_DT) + 2;
    const id = world.spawnMobile(
      'proj',
      caster.team,
      caster.x,
      caster.z,
      -1,
      world.tick + flightTicks,
      caster.id,
    );
    const ent = world.get(id);
    if (ent) {
      ent.ox = ix; // flight target, readable as snapshot tx/tz
      ent.oz = iz;
    }
    this.projs.push({
      id,
      src: caster.id,
      team: caster.team,
      effects: def.effects,
      rankIdx: ri,
      aoeRadius: aoe,
      homing: primary ? primary.id : NO_ENT,
      dirX: dx,
      dirZ: dz,
      speed: spec.speed,
      radius: spec.radius,
      remaining: spec.range,
      pierce: spec.pierce,
      hit: new Set<EntId>(),
    });
  }

  private moveProjectiles(world: World): void {
    const ps = this.projs;
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i];
      if (!p) continue;
      const ent = world.get(p.id);
      if (!ent || !ent.alive || expired(ent, world.tick)) {
        this.dropProj(i);
        i--;
        continue;
      }
      const stepLen = p.speed * TICK_DT;
      if (p.homing !== NO_ENT) {
        const t = world.get(p.homing);
        if (!t || !t.alive || expired(t, world.tick)) {
          // Target died/gone mid-flight: the shot fizzles.
          this.despawnProj(world, ent, i);
          i--;
          continue;
        }
        const dx = t.x - ent.x;
        const dz = t.z - ent.z;
        const d = Math.hypot(dx, dz);
        if (d <= stepLen + t.radius + p.radius) {
          this.impact(world, p, t.x, t.z, t);
          this.despawnProj(world, ent, i);
          i--;
          continue;
        }
        ent.x += (dx / d) * stepLen;
        ent.z += (dz / d) * stepLen;
        ent.ox = t.x;
        ent.oz = t.z;
        p.remaining -= stepLen;
        if (p.remaining <= 0) {
          this.despawnProj(world, ent, i);
          i--;
        }
        continue;
      }
      // Straight flight, clamped so the proj dies exactly at range end.
      const clamped = Math.min(stepLen, p.remaining);
      ent.x += p.dirX * clamped;
      ent.z += p.dirZ * clamped;
      p.remaining -= clamped;
      const hit = this.firstHit(world, p, ent);
      if (hit !== null) {
        this.impact(world, p, hit.x, hit.z, hit);
        if (!p.pierce) {
          this.despawnProj(world, ent, i);
          i--;
          continue;
        }
      }
      if (p.remaining <= 0) {
        this.despawnProj(world, ent, i);
        i--;
      }
    }
  }

  /** Straight-flight collision: enemies within hit radius at the new
   *  position. Non-pierce returns the nearest; pierce returns every unit it
   *  hasn't hit yet (effects apply once per unit along the whole flight). */
  private firstHit(world: World, p: ProjState, ent: Ent): Ent | null {
    const n = world.inRadius(ent.x, ent.z, p.radius, this.radiusBuf);
    let best: Ent | null = null;
    let bestD = Infinity;
    for (let i = 0; i < n; i++) {
      const e = this.radiusBuf[i];
      if (!e || !e.alive || expired(e, world.tick) || !isUnitTargetable(e)) continue;
      if (e.team === p.team || p.hit.has(e.id)) continue;
      if (p.pierce) {
        p.hit.add(e.id);
        this.impact(world, p, e.x, e.z, e);
        continue;
      }
      const d = Math.hypot(e.x - ent.x, e.z - ent.z);
      if (d < bestD) {
        bestD = d;
        best = e;
      }
    }
    return best;
  }

  /** Projectile impact: effects land where the projectile arrived, sourced
   *  to the (possibly dead) caster. */
  private impact(world: World, p: ProjState, x: number, z: number, primary: Ent): void {
    const caster = world.get(p.src);
    this.applyEffects(world, p.src, p.team, caster, p.effects, p.rankIdx, p.aoeRadius, x, z, primary);
  }

  /** The frozen surface has no despawnMobile: expiry at the current tick is
   *  the despawn signal — the world reaps the ent in advance() step (7). */
  private despawnProj(world: World, ent: Ent, index: number): void {
    ent.expireAtTick = world.tick;
    this.dropProj(index);
  }

  private dropProj(index: number): void {
    const ps = this.projs;
    const last = ps.pop();
    if (last !== undefined && index < ps.length) ps[index] = last;
  }
}
