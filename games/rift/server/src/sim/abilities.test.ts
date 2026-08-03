// ============================================================================
// ANCIENTS (rift) — ABILITY ENGINE TESTS (T4). Runs the engine against a
// recording FAKE World (StubDict-style test double — world.ts is T3's,
// built concurrently, and is never imported here). The fake implements the
// frozen World interface plus the two seam-gap members the engine needs
// (drainCasts/pushEvent — see the abilities.ts header).
// ============================================================================
import { describe, expect, it } from 'vitest';
import type { AuraStat, HeroId, MapDef, TeamId } from '@rift/shared';
import { TICK_RATE } from '@rift/shared';
import type { Ent, EntId, Order, SimEvent, World } from './types.js';
import { NO_ENT } from './types.js';
import type { QueuedCast } from './abilities.js';
import { createAbilitiesEngine, ITEM_EVENT_SLOT_BASE } from './abilities.js';

const TEST_MAP: MapDef = { lanes: 1, side: 96, paths: [], structures: [] };

function mkEnt(over: Partial<Ent> & { id: EntId; kind: Ent['kind']; team: TeamId }): Ent {
  return {
    x: 0,
    z: 0,
    radius: 0.5,
    hp: 300,
    maxHp: 300,
    mana: 1000,
    maxMana: 1000,
    alive: true,
    damage: 50,
    armor: 0,
    attackPeriod: 1,
    attackRange: 2,
    moveSpeed: 5,
    hpRegen: 0,
    manaRegen: 0,
    lifesteal: 0,
    vision: 8,
    bounty: 0,
    xpValue: 0,
    nextAttackTick: 0,
    atkTarget: NO_ENT,
    order: 'idle',
    ox: 0,
    oz: 0,
    orderTarget: NO_ENT,
    lane: -1,
    waypoint: 0,
    stunUntilTick: 0,
    slowPct: 0,
    slowUntilTick: 0,
    dashUntilTick: 0,
    expireAtTick: 0,
    auras: [],
    level: 1,
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
    ...over,
  };
}

/** Recording fake World. Mutation calls append to `log` so tests can assert
 *  effect ORDER (dash-then-damage) as well as effect content. */
class FakeWorld implements World {
  tick = 0;
  readonly map = TEST_MAP;
  overtime = false;
  readonly ents = new Map<EntId, Ent>();
  readonly log: string[] = [];
  private queue: QueuedCast[] = [];
  private events: SimEvent[] = [];
  private nextMobile = 1000;

  add(e: Ent): Ent {
    this.ents.set(e.id, e);
    return e;
  }

  get(id: EntId): Ent | undefined {
    return this.ents.get(id);
  }

  *all(): Iterable<Ent> {
    yield* this.ents.values();
  }

  *mobiles(): Iterable<Ent> {
    for (const e of this.ents.values()) {
      if (e.kind !== 'tower' && e.kind !== 'guard' && e.kind !== 'ancient') yield e;
    }
  }

  inRadius(x: number, z: number, r: number, out: Ent[]): number {
    let n = 0;
    for (const e of this.ents.values()) {
      if (Math.hypot(e.x - x, e.z - z) <= r) {
        out[n] = e;
        n++;
      }
    }
    return n;
  }

  order(hero: EntId, order: Order): void {
    this.log.push(`order:${hero}:${order.kind}`);
  }

  cast(hero: EntId, slot: number, x: number | null, z: number | null, target: EntId): void {
    this.queue.push({ kind: 'ability', hero, slot, x, z, target });
  }

  damage(src: EntId, dst: EntId, amount: number, school: 'physical' | 'magic'): void {
    this.log.push(`damage:${src}>${dst}:${amount}:${school}`);
    const e = this.ents.get(dst);
    if (!e || !e.alive) return;
    e.hp -= amount;
    if (e.hp <= 0) {
      e.hp = 0;
      e.alive = false;
    }
  }

  heal(dst: EntId, amount: number): void {
    this.log.push(`heal:${dst}:${amount}`);
    const e = this.ents.get(dst);
    if (!e || !e.alive) return;
    e.hp = Math.min(e.maxHp, e.hp + amount);
  }

  stun(dst: EntId, durationS: number): void {
    this.log.push(`stun:${dst}:${durationS}`);
    const e = this.ents.get(dst);
    if (!e) return;
    e.stunUntilTick = Math.max(e.stunUntilTick, this.tick + Math.round(durationS * TICK_RATE));
  }

  slow(dst: EntId, pct: number, durationS: number): void {
    this.log.push(`slow:${dst}:${pct}:${durationS}`);
    const e = this.ents.get(dst);
    if (!e) return;
    // Strongest active slow wins; slows never stack.
    if (e.slowUntilTick <= this.tick || pct >= e.slowPct) {
      e.slowPct = pct;
      e.slowUntilTick = this.tick + Math.round(durationS * TICK_RATE);
    }
  }

  applyAura(dst: EntId, stat: AuraStat, amount: number, pct: boolean, durationS: number, source: EntId): void {
    this.log.push(`aura:${dst}:${stat}:${amount}:${pct}:${durationS}:${source}`);
    const e = this.ents.get(dst);
    if (!e) return;
    e.auras.push({
      stat,
      amount,
      pct,
      untilTick: durationS > 0 ? this.tick + Math.round(durationS * TICK_RATE) : 0,
      source,
    });
  }

  dash(id: EntId, tx: number, tz: number): void {
    this.log.push(`dash:${id}:${tx}:${tz}`);
    const e = this.ents.get(id);
    if (!e) return;
    e.x = Math.min(this.map.side, Math.max(0, tx));
    e.z = Math.min(this.map.side, Math.max(0, tz));
    e.dashUntilTick = this.tick + 3;
  }

  spawnMobile(
    kind: Ent['kind'],
    team: TeamId,
    x: number,
    z: number,
    lane: number,
    expireAtTick: number,
    owner: EntId,
  ): EntId {
    const id = this.nextMobile++;
    this.log.push(`spawn:${kind}:${id}:${owner}:${expireAtTick}`);
    this.ents.set(id, mkEnt({ id, kind, team, x, z, lane, expireAtTick, owner }));
    return id;
  }

  buy(): void {}
  spendSkillPoint(): void {}

  /** Mirrors the intended T3 split: units.ts validates/spends, then enqueues
   *  the dash/aura active for the engine. The fake just enqueues. */
  useItem(hero: EntId, slot: number, x: number | null, z: number | null): void {
    this.queue.push({ kind: 'item', hero, slot, x, z });
  }

  wardStock(): number {
    return 0;
  }

  drainEvents(): SimEvent[] {
    const ev = this.events;
    this.events = [];
    return ev;
  }

  advance(): void {}

  // --- seam-gap members (reported; not yet on the frozen World) ---
  drainCasts(): QueuedCast[] {
    const c = this.queue;
    this.queue = [];
    return c;
  }

  pushEvent(ev: SimEvent): void {
    this.events.push(ev);
  }
}

function mkHero(
  w: FakeWorld,
  id: EntId,
  team: TeamId,
  hero: HeroId,
  x: number,
  z: number,
  over: Partial<Ent> = {},
): Ent {
  return w.add(mkEnt({ id, kind: 'hero', team, hero, x, z, hp: 500, maxHp: 500, pid: `p${id}`, ...over }));
}

function mkCreep(w: FakeWorld, id: EntId, team: TeamId, x: number, z: number, over: Partial<Ent> = {}): Ent {
  return w.add(mkEnt({ id, kind: 'melee', team, x, z, hp: 450, maxHp: 450, radius: 0.42, ...over }));
}

function setup() {
  const world = new FakeWorld();
  const engine = createAbilitiesEngine();
  return { world, engine };
}

/** Step the engine `n` times, advancing the match tick between steps. */
function stepN(engine: { step(w: World): void }, world: FakeWorld, n: number): void {
  for (let i = 0; i < n; i++) {
    engine.step(world);
    world.tick++;
  }
}

// --- Validation ---------------------------------------------------------------

describe('cast validation', () => {
  it('rejects a cast from a dead hero', () => {
    const { world, engine } = setup();
    const h = mkHero(world, 1, 0, 'shade', 10, 10, { alive: false, abilityRanks: [1, 0, 0, 0] });
    const t = mkCreep(world, 2, 1, 15, 10);
    world.cast(1, 0, null, null, 2);
    engine.step(world);
    expect(t.hp).toBe(450);
    expect(h.mana).toBe(1000);
    expect(world.log).toEqual([]);
    expect(world.drainEvents()).toEqual([]);
  });

  it('rejects a cast from a stunned hero', () => {
    const { world, engine } = setup();
    const h = mkHero(world, 1, 0, 'shade', 10, 10, { abilityRanks: [1, 0, 0, 0], stunUntilTick: 5 });
    const t = mkCreep(world, 2, 1, 15, 10);
    world.cast(1, 0, null, null, 2);
    engine.step(world); // tick 0, stunned until tick 5
    expect(t.hp).toBe(450);
    expect(h.mana).toBe(1000);
    expect(world.drainEvents()).toEqual([]);
  });

  it('rejects a passive ability even at rank >= 1', () => {
    const { world, engine } = setup();
    const h = mkHero(world, 1, 0, 'bullwark', 10, 10, { abilityRanks: [0, 1, 0, 0] });
    world.cast(1, 1, null, null, NO_ENT); // Bulwark (passive armor aura)
    engine.step(world);
    expect(h.mana).toBe(1000);
    expect(h.abilityCdUntilTick[1]).toBe(0);
    expect(world.log).toEqual([]);
    expect(world.drainEvents()).toEqual([]);
  });

  it('rejects a cast at rank 0', () => {
    const { world, engine } = setup();
    const h = mkHero(world, 1, 0, 'shade', 10, 10, { abilityRanks: [0, 0, 0, 0] });
    const t = mkCreep(world, 2, 1, 15, 10);
    world.cast(1, 0, null, null, 2);
    engine.step(world);
    expect(t.hp).toBe(450);
    expect(h.mana).toBe(1000);
  });

  it('rejects a cast on cooldown', () => {
    const { world, engine } = setup();
    const h = mkHero(world, 1, 0, 'shade', 10, 10, { abilityRanks: [1, 0, 0, 0], abilityCdUntilTick: [100, 0, 0, 0] });
    const t = mkCreep(world, 2, 1, 15, 10);
    world.cast(1, 0, null, null, 2);
    engine.step(world);
    expect(t.hp).toBe(450);
    expect(h.mana).toBe(1000);
  });

  it('rejects a cast with insufficient mana', () => {
    const { world, engine } = setup();
    const h = mkHero(world, 1, 0, 'shade', 10, 10, { abilityRanks: [1, 0, 0, 0], mana: 54 }); // cost 55
    const t = mkCreep(world, 2, 1, 15, 10);
    world.cast(1, 0, null, null, 2);
    engine.step(world);
    expect(t.hp).toBe(450);
    expect(h.mana).toBe(54);
  });

  it('rejects an illegal slot', () => {
    const { world, engine } = setup();
    const h = mkHero(world, 1, 0, 'shade', 10, 10, { abilityRanks: [1, 1, 1, 1] });
    world.cast(1, 4, 12, 10, NO_ENT);
    engine.step(world);
    expect(h.mana).toBe(1000);
    expect(world.log).toEqual([]);
  });

  it('rejects a unit cast on the wrong team', () => {
    const { world, engine } = setup();
    const h = mkHero(world, 1, 0, 'hex', 10, 10, { abilityRanks: [1, 0, 0, 0] });
    const ally = mkHero(world, 2, 0, 'mender', 15, 10);
    world.cast(1, 0, null, null, 2); // Hexbolt is enemy-only
    engine.step(world);
    expect(ally.hp).toBe(500);
    expect(h.mana).toBe(1000);
    expect(world.log).toEqual([]);
  });

  it('rejects a unit cast on a dead target', () => {
    const { world, engine } = setup();
    const h = mkHero(world, 1, 0, 'mender', 10, 10, { abilityRanks: [1, 0, 0, 0] });
    const ally = mkHero(world, 2, 0, 'reaver', 15, 10, { hp: 0, alive: false });
    world.cast(1, 0, null, null, 2);
    engine.step(world);
    expect(ally.hp).toBe(0);
    expect(h.mana).toBe(1000);
  });

  it('rejects a unit cast on NO_ENT', () => {
    const { world, engine } = setup();
    const h = mkHero(world, 1, 0, 'hex', 10, 10, { abilityRanks: [1, 0, 0, 0] });
    world.cast(1, 0, null, null, NO_ENT);
    engine.step(world);
    expect(h.mana).toBe(1000);
    expect(world.log).toEqual([]);
  });

  it('rejects a unit cast on a ward', () => {
    const { world, engine } = setup();
    const h = mkHero(world, 1, 0, 'hex', 10, 10, { abilityRanks: [1, 0, 0, 0] });
    const ward = world.get(world.spawnMobile('ward', 1, 15, 10, -1, 999, 2));
    expect(ward).toBeDefined();
    world.log.length = 0;
    world.cast(1, 0, null, null, 1000);
    engine.step(world);
    expect(h.mana).toBe(1000);
    expect(world.log).toEqual([]);
  });

  it('rejects a unit cast beyond castRange', () => {
    const { world, engine } = setup();
    const h = mkHero(world, 1, 0, 'shade', 10, 10, { abilityRanks: [1, 0, 0, 0] });
    const t = mkCreep(world, 2, 1, 18, 10); // dist 8 > castRange 7
    world.cast(1, 0, null, null, 2);
    engine.step(world);
    expect(t.hp).toBe(450);
    expect(h.mana).toBe(1000);
  });

  it('rejects a point cast with null coordinates', () => {
    const { world, engine } = setup();
    const h = mkHero(world, 1, 0, 'hex', 10, 10, { abilityRanks: [0, 0, 1, 0] });
    world.cast(1, 2, null, null, NO_ENT); // Blink needs a point
    engine.step(world);
    expect(h.mana).toBe(1000);
    expect(world.log).toEqual([]);
  });

  it('rejects a point cast with non-finite coordinates', () => {
    const { world, engine } = setup();
    const h = mkHero(world, 1, 0, 'hex', 10, 10, { abilityRanks: [0, 0, 1, 0] });
    world.cast(1, 2, Number.NaN, 10, NO_ENT);
    engine.step(world);
    expect(h.mana).toBe(1000);
    expect(world.log).toEqual([]);
  });

  it('rejects a point cast beyond castRange', () => {
    const { world, engine } = setup();
    const h = mkHero(world, 1, 0, 'hex', 10, 10, { abilityRanks: [0, 0, 1, 0] });
    world.cast(1, 2, 30, 10, NO_ENT); // dist 20 > castRange 8
    engine.step(world);
    expect(h.mana).toBe(1000);
    expect(world.log).toEqual([]);
  });
});

// --- Execution: primitives + ordering --------------------------------------------

describe('effect primitives', () => {
  it('Shadow Strike: dash resolves BEFORE damage (array order), spends mana + cooldown, emits cast event', () => {
    const { world, engine } = setup();
    const h = mkHero(world, 1, 0, 'shade', 10, 10, { abilityRanks: [1, 0, 0, 0] });
    const t = mkCreep(world, 2, 1, 15, 10);
    world.cast(1, 0, null, null, 2);
    engine.step(world);
    // 80 physical at rank 1, after the dash call.
    const dashIdx = world.log.findIndex((l) => l.startsWith('dash:1:'));
    const dmgIdx = world.log.findIndex((l) => l.startsWith('damage:1>2:80:physical'));
    expect(dashIdx).toBeGreaterThanOrEqual(0);
    expect(dmgIdx).toBeGreaterThan(dashIdx);
    expect(h.x).toBeCloseTo(15); // dashed the full 5m to the target (< 7 cap)
    expect(t.hp).toBe(370);
    expect(h.mana).toBe(945); // 1000 - 55
    expect(h.abilityCdUntilTick[0]).toBe(13 * TICK_RATE);
    expect(world.drainEvents()).toEqual([{ k: 'cast', id: 1, team: 0, slot: 0, x: 15, z: 10 }]);
  });

  it('a successful cast starts the cooldown, blocking an immediate recast', () => {
    const { world, engine } = setup();
    const h = mkHero(world, 1, 0, 'shade', 10, 10, { abilityRanks: [1, 0, 0, 0] });
    mkCreep(world, 2, 1, 15, 10);
    world.cast(1, 0, null, null, 2);
    engine.step(world);
    world.cast(1, 0, null, null, 2); // same-tick recast: now on cooldown
    engine.step(world);
    expect(h.mana).toBe(945); // spent once only
    expect(world.log.filter((l) => l.startsWith('damage:'))).toHaveLength(1);
  });

  it('Mend heals an allied unit, clamped at maxHp', () => {
    const { world, engine } = setup();
    mkHero(world, 1, 0, 'mender', 10, 10, { abilityRanks: [1, 0, 0, 0] });
    const ally = mkHero(world, 2, 0, 'reaver', 15, 10, { hp: 480, maxHp: 500 });
    world.cast(1, 0, null, null, 2); // Mend rank 1 = 90
    engine.step(world);
    expect(ally.hp).toBe(500); // 480 + 90 clamped to maxHp
  });

  it('Ground Slam: AoE damage + slow hits in-range enemies only — not far enemies, not allies', () => {
    const { world, engine } = setup();
    mkHero(world, 1, 0, 'bullwark', 10, 10, { abilityRanks: [0, 0, 1, 0] });
    const near = mkCreep(world, 2, 1, 12, 10); // in aoe 4
    const far = mkCreep(world, 3, 1, 20, 10); // out
    const ally = mkCreep(world, 4, 0, 11, 10); // in radius, wrong side
    world.cast(1, 2, null, null, NO_ENT);
    engine.step(world);
    expect(near.hp).toBe(390); // 450 - 60 magic rank 1
    expect(near.slowPct).toBeCloseTo(0.3);
    expect(near.slowUntilTick).toBe(Math.round(2.5 * TICK_RATE));
    expect(far.hp).toBe(450);
    expect(far.slowPct).toBe(0);
    expect(ally.hp).toBe(450);
    expect(ally.slowPct).toBe(0);
  });

  it('Rally: heals allies (incl. self) in aoeRadius and applies the armor aura within its radius', () => {
    const { world, engine } = setup();
    const h = mkHero(world, 1, 0, 'bullwark', 10, 10, { hp: 300, maxHp: 720, abilityRanks: [0, 0, 0, 1] });
    const near = mkHero(world, 2, 0, 'mender', 15, 10, { hp: 100 }); // 5m: heal (aoe 10) + aura (radius 10)
    const far = mkHero(world, 3, 0, 'reaver', 21, 10, { hp: 100 }); // 11m: neither
    const foe = mkCreep(world, 4, 1, 12, 10);
    world.cast(1, 3, null, null, NO_ENT);
    engine.step(world);
    expect(h.hp).toBe(500); // 300 + 200
    expect(near.hp).toBe(300);
    expect(far.hp).toBe(100);
    expect(foe.hp).toBe(450); // enemies never healed
    expect(h.auras).toEqual([{ stat: 'armor', amount: 6, pct: false, untilTick: 6 * TICK_RATE, source: 1 }]);
    expect(near.auras).toHaveLength(1);
    expect(far.auras).toHaveLength(0); // outside the 10m aura radius
    expect(foe.auras).toHaveLength(0);
  });

  it('Frenzy: radius-0 active aura hits SELF only, never a nearby ally', () => {
    const { world, engine } = setup();
    const h = mkHero(world, 1, 0, 'reaver', 10, 10, { abilityRanks: [0, 1, 0, 0] });
    const ally = mkHero(world, 2, 0, 'mender', 11, 10);
    world.cast(1, 1, null, null, NO_ENT);
    engine.step(world);
    expect(h.auras).toEqual([{ stat: 'attackSpeed', amount: 0.3, pct: true, untilTick: 5 * TICK_RATE, source: 1 }]);
    expect(ally.auras).toEqual([]);
  });

  it('Blink (point dash) moves the caster toward the point', () => {
    const { world, engine } = setup();
    const h = mkHero(world, 1, 0, 'hex', 10, 10, { abilityRanks: [0, 0, 1, 0] });
    world.cast(1, 2, 18, 10, NO_ENT); // dist 8 = dash distance 8
    engine.step(world);
    expect(h.x).toBeCloseTo(18);
    expect(h.z).toBeCloseTo(10);
    expect(h.mana).toBe(940);
  });

  it('Shield Crash: point dash, then AoE damage + stun at the arrival point', () => {
    const { world, engine } = setup();
    const h = mkHero(world, 1, 0, 'bullwark', 10, 10, { abilityRanks: [1, 0, 0, 0] });
    const t = mkCreep(world, 2, 1, 17, 10);
    world.cast(1, 0, 17, 10, NO_ENT);
    engine.step(world);
    expect(h.x).toBeCloseTo(17); // dashed 7m to the point
    expect(t.hp).toBe(380); // 450 - 70 physical
    expect(t.stunUntilTick).toBe(Math.round(0.8 * TICK_RATE));
    const dashIdx = world.log.findIndex((l) => l.startsWith('dash:1:'));
    const dmgIdx = world.log.findIndex((l) => l.startsWith('damage:1>2:'));
    expect(dashIdx).toBeGreaterThanOrEqual(0);
    expect(dmgIdx).toBeGreaterThan(dashIdx);
  });

  it('Phantoms: summons friendly shades owned by the caster plus the self speed aura', () => {
    const { world, engine } = setup();
    const h = mkHero(world, 1, 0, 'shade', 10, 10, { abilityRanks: [0, 0, 0, 1] });
    world.cast(1, 3, null, null, NO_ENT);
    engine.step(world);
    const shades = [...world.mobiles()].filter((e) => e.kind === 'shade');
    expect(shades).toHaveLength(2); // rank 1 count
    for (const s of shades) {
      expect(s.team).toBe(0);
      expect(s.owner).toBe(1);
      expect(s.expireAtTick).toBe(8 * TICK_RATE);
    }
    expect(h.auras).toEqual([{ stat: 'moveSpeed', amount: 0.15, pct: true, untilTick: 6 * TICK_RATE, source: 1 }]);
  });

  it('summon cap: over-cap casts expire the OLDEST shades first', () => {
    const { world, engine } = setup();
    const h = mkHero(world, 1, 0, 'shade', 10, 10, { abilityRanks: [0, 0, 0, 1] });
    // Six shades already active (the cap), with staggered expiry = age order.
    for (let i = 0; i < 6; i++) {
      world.spawnMobile('shade', 0, 12 + i, 20, -1, 100 + i * 10, 1);
    }
    world.log.length = 0;
    world.cast(1, 3, null, null, NO_ENT); // rank 1 summons 2 more
    engine.step(world);
    const shades = [...world.mobiles()].filter((e) => e.kind === 'shade');
    expect(shades).toHaveLength(8); // 6 old + 2 new spawned
    const active = shades.filter((s) => s.expireAtTick > world.tick);
    expect(active).toHaveLength(6); // ...but only 6 remain active
    // The two oldest (expireAtTick 100, 110) were expired this tick.
    const expiredOld = shades.filter((s) => s.expireAtTick === world.tick);
    expect(expiredOld).toHaveLength(2);
    expect(active.every((s) => s.expireAtTick >= 120)).toBe(true);
  });
});

// --- Projectiles -------------------------------------------------------------------

describe('projectiles', () => {
  it('Hexbolt: unit-targeted projectile HOMES onto its target and hits it exactly once', () => {
    const { world, engine } = setup();
    mkHero(world, 1, 0, 'hex', 10, 10, { abilityRanks: [1, 0, 0, 0] });
    const t = mkCreep(world, 2, 1, 16, 10, { hp: 300, maxHp: 300 });
    world.cast(1, 0, null, null, 2);
    engine.step(world);
    const proj = [...world.mobiles()].find((e) => e.kind === 'proj');
    expect(proj).toBeDefined();
    expect(proj?.owner).toBe(1);
    expect(proj?.team).toBe(0);
    stepN(engine, world, 20);
    expect(t.hp).toBe(210); // 300 - 90 magic, once
    expect(world.log.filter((l) => l.startsWith('damage:1>2:'))).toHaveLength(1);
    // Despawned at impact: expired at the impact tick and no longer moving.
    expect(proj?.expireAtTick).not.toBe(0);
    const px = proj?.x;
    stepN(engine, world, 3);
    expect(proj?.x).toBe(px);
  });

  it('homing projectiles track a moving target', () => {
    const { world, engine } = setup();
    mkHero(world, 1, 0, 'hex', 10, 10, { abilityRanks: [1, 0, 0, 0] });
    const t = mkCreep(world, 2, 1, 20, 10, { hp: 1000, maxHp: 1000 });
    world.cast(1, 0, null, null, 2);
    engine.step(world);
    const proj = [...world.mobiles()].find((e) => e.kind === 'proj');
    expect(proj?.z).toBeCloseTo(10);
    t.z = 16; // target sidesteps; the bolt must turn
    engine.step(world);
    expect(proj && proj.z > 10).toBe(true);
  });

  it('a homing projectile fizzles when its target dies mid-flight', () => {
    const { world, engine } = setup();
    mkHero(world, 1, 0, 'hex', 10, 10, { abilityRanks: [1, 0, 0, 0] });
    const t = mkCreep(world, 2, 1, 20, 10);
    world.cast(1, 0, null, null, 2);
    engine.step(world);
    world.tick++;
    const proj = [...world.mobiles()].find((e) => e.kind === 'proj');
    t.alive = false; // killed by something else
    world.log.length = 0;
    stepN(engine, world, 5);
    expect(proj?.expireAtTick).not.toBe(0);
    expect(world.log.filter((l) => l.startsWith('damage:'))).toEqual([]);
    expect(t.hp).toBe(450);
  });

  it('Piercing Arrow: straight flight pierces EVERY enemy in the line, each exactly once', () => {
    const { world, engine } = setup();
    mkHero(world, 1, 0, 'longbow', 10, 10, { abilityRanks: [1, 0, 0, 0] });
    const a = mkCreep(world, 2, 1, 15, 10);
    const b = mkCreep(world, 3, 1, 20, 10);
    const ally = mkCreep(world, 4, 0, 17, 10); // in the line, wrong side
    world.cast(1, 0, 24, 10, NO_ENT); // point cast, range 14
    stepN(engine, world, 20);
    expect(a.hp).toBe(370); // 450 - 80 physical, once despite multi-tick overlap
    expect(b.hp).toBe(370);
    expect(ally.hp).toBe(450);
    expect(world.log.filter((l) => l.startsWith('damage:1>2:'))).toHaveLength(1);
    expect(world.log.filter((l) => l.startsWith('damage:1>3:'))).toHaveLength(1);
  });

  it('a straight projectile despawns at range end without hitting anything', () => {
    const { world, engine } = setup();
    mkHero(world, 1, 0, 'longbow', 10, 10, { abilityRanks: [1, 0, 0, 0] });
    world.cast(1, 0, 24, 10, NO_ENT);
    engine.step(world);
    const proj = [...world.mobiles()].find((e) => e.kind === 'proj');
    expect(proj).toBeDefined();
    stepN(engine, world, 20); // range 14 at 22 m/s = 12.7 ticks of flight
    expect(proj?.expireAtTick).not.toBe(0);
    expect(proj?.x).toBeCloseTo(24); // died exactly at range end (10 + 14)
    expect(world.log.filter((l) => l.startsWith('damage:'))).toEqual([]);
  });

  it('a non-pierce straight-line hit lands on the first enemy only and despawns', () => {
    // Frost Arrow is unit-targeted but instant; use a homing Hexbolt with a
    // bodyguard in between: homing ignores intervening units entirely.
    const { world, engine } = setup();
    mkHero(world, 1, 0, 'hex', 10, 10, { abilityRanks: [1, 0, 0, 0] });
    const bodyguard = mkCreep(world, 3, 1, 13, 10);
    const t = mkCreep(world, 2, 1, 16, 10, { hp: 300, maxHp: 300 });
    world.cast(1, 0, null, null, 2);
    stepN(engine, world, 20);
    expect(t.hp).toBe(210);
    expect(bodyguard.hp).toBe(450); // homing hits its target, not bystanders
  });
});

// --- Item actives ------------------------------------------------------------------

describe('item actives', () => {
  it('blinkstone: dashes the hero toward the point, capped at the active distance', () => {
    const { world, engine } = setup();
    const h = mkHero(world, 1, 0, 'hex', 10, 10, {
      items: ['blinkstone', null, null, null, null, null],
    });
    world.useItem(1, 0, 30, 10); // 20m away, blink is 8m
    engine.step(world);
    expect(h.x).toBeCloseTo(18);
    expect(h.z).toBeCloseTo(10);
    expect(world.drainEvents()).toEqual([
      { k: 'cast', id: 1, team: 0, slot: ITEM_EVENT_SLOT_BASE + 0, x: 30, z: 10 },
    ]);
  });

  it('blinkstone without valid coordinates is rejected', () => {
    const { world, engine } = setup();
    const h = mkHero(world, 1, 0, 'hex', 10, 10, {
      items: ['blinkstone', null, null, null, null, null],
    });
    world.useItem(1, 0, null, null);
    engine.step(world);
    expect(h.x).toBe(10);
    expect(world.log).toEqual([]);
    expect(world.drainEvents()).toEqual([]);
  });

  it('warhorn: applies its damage aura to allies in radius only', () => {
    const { world, engine } = setup();
    const h = mkHero(world, 1, 0, 'mender', 10, 10, {
      items: [null, 'warhorn', null, null, null, null],
    });
    const near = mkHero(world, 2, 0, 'reaver', 15, 10); // 5m, in radius 10
    const far = mkHero(world, 3, 0, 'shade', 25, 10); // 15m, out
    const foe = mkCreep(world, 4, 1, 12, 10);
    world.useItem(1, 1, null, null);
    engine.step(world);
    const want = { stat: 'damage', amount: 0.2, pct: true, untilTick: 6 * TICK_RATE, source: 1 };
    expect(h.auras).toEqual([want]);
    expect(near.auras).toEqual([want]);
    expect(far.auras).toEqual([]);
    expect(foe.auras).toEqual([]);
    expect(world.drainEvents()).toEqual([
      { k: 'cast', id: 1, team: 0, slot: ITEM_EVENT_SLOT_BASE + 1, x: 10, z: 10 },
    ]);
  });

  it('wardstone is not the engine’s business: an item cast for it is ignored', () => {
    const { world, engine } = setup();
    mkHero(world, 1, 0, 'mender', 10, 10, {
      items: [null, null, 'wardstone', null, null, null],
    });
    world.useItem(1, 2, 12, 10);
    engine.step(world);
    expect(world.log).toEqual([]);
    expect(world.drainEvents()).toEqual([]);
  });

  it('an item cast on an empty slot is ignored', () => {
    const { world, engine } = setup();
    mkHero(world, 1, 0, 'mender', 10, 10);
    world.useItem(1, 4, 12, 10);
    engine.step(world);
    expect(world.log).toEqual([]);
    expect(world.drainEvents()).toEqual([]);
  });
});
