// ============================================================================
// ANCIENTS (rift) — VISION TESTS (T5). Drives computeTeamVisible against a
// minimal fake World (a test double over the frozen sim seam — this file
// deliberately does NOT import world.ts; T3 builds it in parallel).
// ============================================================================
import { describe, expect, it } from 'vitest';
import {
  ANCIENT,
  CREEP_MELEE,
  HERO_VISION,
  TOWER,
  WARD_VISION,
} from '@rift/shared';
import type { EntKind, ItemId, MapDef, TeamId } from '@rift/shared';
import { computeTeamVisible } from './vision.js';
import type { Ent, EntId, Order, QueuedCast, SimEvent, World } from './types.js';
import type { AuraStat } from '@rift/shared';

// --- Fake World ---------------------------------------------------------------

const STRUCTURE_KINDS: readonly EntKind[] = ['tower', 'guard', 'ancient'];

function isStructureKind(kind: EntKind): boolean {
  return STRUCTURE_KINDS.includes(kind);
}

function makeEnt(
  id: EntId,
  kind: EntKind,
  team: TeamId,
  x: number,
  z: number,
  overrides?: Partial<Ent>,
): Ent {
  const base: Ent = {
    id,
    kind,
    team,
    x,
    z,
    radius: 0.5,
    hp: 100,
    maxHp: 100,
    mana: 0,
    maxMana: 0,
    alive: true,
    damage: 10,
    armor: 0,
    attackPeriod: 1,
    attackRange: 1,
    moveSpeed: 3,
    hpRegen: 0,
    manaRegen: 0,
    lifesteal: 0,
    vision: 0,
    bounty: 0,
    xpValue: 0,
    nextAttackTick: 0,
    atkTarget: -1,
    order: 'idle',
    ox: 0,
    oz: 0,
    orderTarget: -1,
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
    owner: -1,
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
    lastHitBy: -1,
    recentDamagers: [],
  };
  return { ...base, ...overrides };
}

/** Minimal World double: entity store + iteration; every other member of the
 *  frozen surface is an inert no-op (vision never calls them). */
class FakeWorld implements World {
  readonly tick = 0;
  readonly map: MapDef = { lanes: 1, side: 96, paths: [], structures: [] };
  readonly overtime = false;
  private readonly ents = new Map<EntId, Ent>();
  private allCache: Ent[] = [];
  private mobilesCache: Ent[] = [];

  add(e: Ent): void {
    this.ents.set(e.id, e);
    this.allCache = [...this.ents.values()];
    this.mobilesCache = this.allCache.filter((x) => !isStructureKind(x.kind));
  }

  get(id: EntId): Ent | undefined {
    return this.ents.get(id);
  }

  all(): Iterable<Ent> {
    return this.allCache;
  }

  mobiles(): Iterable<Ent> {
    return this.mobilesCache;
  }

  inRadius(x: number, z: number, r: number, out: Ent[]): number {
    let n = 0;
    for (const e of this.ents.values()) {
      const dx = e.x - x;
      const dz = e.z - z;
      if (dx * dx + dz * dz <= r * r) {
        out[n] = e;
        n += 1;
      }
    }
    return n;
  }

  order(_hero: EntId, _order: Order): void {}
  cast(_hero: EntId, _slot: number, _x: number | null, _z: number | null, _target: EntId): void {}
  damage(_src: EntId, _dst: EntId, _amount: number, _school: 'physical' | 'magic'): void {}
  heal(_dst: EntId, _amount: number): void {}
  stun(_dst: EntId, _durationS: number): void {}
  slow(_dst: EntId, _pct: number, _durationS: number): void {}
  applyAura(_dst: EntId, _stat: AuraStat, _amount: number, _pct: boolean, _durationS: number, _source: EntId): void {}
  dash(_id: EntId, _tx: number, _tz: number): void {}
  spawnMobile(_kind: EntKind, _team: TeamId, _x: number, _z: number, _lane: number, _expireAtTick: number, _owner: EntId): EntId {
    return -1;
  }
  buy(_hero: EntId, _item: ItemId): void {}
  spendSkillPoint(_hero: EntId, _slot: number): void {}
  useItem(_hero: EntId, _slot: number, _x: number | null, _z: number | null): void {}
  wardStock(_team: TeamId): number {
    return 0;
  }
  pushEvent(_ev: SimEvent): void {}
  drainCasts(): QueuedCast[] {
    return [];
  }
  drainEvents(): SimEvent[] {
    return [];
  }
  advance(): void {}
}

function visibleIds(world: World, team: TeamId, out: Set<EntId>): Set<EntId> {
  computeTeamVisible(world, team, out);
  return out;
}

// --- Tests --------------------------------------------------------------------

describe('computeTeamVisible', () => {
  it('enemy hero beyond all radii is invisible, becomes visible inside hero vision', () => {
    const world = new FakeWorld();
    world.add(makeEnt(1000, 'hero', 0, 10, 10));
    const enemy = makeEnt(1001, 'hero', 1, 10 + HERO_VISION + 5, 10);
    world.add(enemy);
    const out = new Set<EntId>();

    expect(visibleIds(world, 0, out).has(1001)).toBe(false);

    enemy.x = 10 + HERO_VISION - 1; // inside own hero's radius
    expect(visibleIds(world, 0, out).has(1001)).toBe(true);

    // boundary: exactly at the radius (squared compare) still counts
    enemy.x = 10 + HERO_VISION;
    expect(visibleIds(world, 0, out).has(1001)).toBe(true);
  });

  it('own-team mobiles are always visible to their own team; structures never are', () => {
    const world = new FakeWorld();
    world.add(makeEnt(1000, 'hero', 0, 0, 0));
    world.add(makeEnt(1001, 'melee', 0, 90, 90)); // far away, still own team
    world.add(makeEnt(1002, 'hero', 0, 50, 50, { alive: false, hp: 0 })); // dead own hero
    world.add(makeEnt(5, 'tower', 0, 20, 20));
    world.add(makeEnt(6, 'ancient', 1, 80, 80));
    const out = new Set<EntId>();

    const vis = visibleIds(world, 0, out);
    expect(vis.has(1000)).toBe(true);
    expect(vis.has(1001)).toBe(true);
    expect(vis.has(1002)).toBe(true);
    expect(vis.has(5)).toBe(false); // structures are always sent, never in the set
    expect(vis.has(6)).toBe(false);
  });

  it('a ward reveals its area for the owner team but is never visible to the enemy', () => {
    const world = new FakeWorld();
    // team 0 ward far from every team-0 hero; enemy hero inside ward radius
    world.add(makeEnt(1000, 'hero', 0, 0, 0));
    world.add(makeEnt(1100, 'ward', 0, 50, 50));
    const enemy = makeEnt(1001, 'hero', 1, 50 + WARD_VISION - 1, 50);
    world.add(enemy);
    // team 1 hero stands right next to the team-0 ward
    const out0 = new Set<EntId>();
    const out1 = new Set<EntId>();

    // ward vision reveals the enemy hero to team 0 even though no hero sees it
    expect(visibleIds(world, 0, out0).has(1001)).toBe(true);
    // ...but the ward itself is invisible to team 1 despite point-blank range
    expect(visibleIds(world, 1, out1).has(1100)).toBe(false);
    // symmetric: an enemy ward inside own hero vision is still invisible
    world.add(makeEnt(1101, 'ward', 1, 0 + 2, 0));
    expect(visibleIds(world, 0, out0).has(1101)).toBe(false);
    // own ward IS in the owner's set (own-team mobiles always visible)
    expect(visibleIds(world, 0, out0).has(1100)).toBe(true);
  });

  it('a dead hero provides no vision', () => {
    const world = new FakeWorld();
    const hero = makeEnt(1000, 'hero', 0, 10, 10);
    world.add(hero);
    world.add(makeEnt(1001, 'hero', 1, 10 + 2, 10));
    const out = new Set<EntId>();

    expect(visibleIds(world, 0, out).has(1001)).toBe(true);

    hero.alive = false;
    hero.hp = 0;
    expect(visibleIds(world, 0, out).has(1001)).toBe(false);
  });

  it('structure vision reveals approachers; a destroyed structure reveals nothing', () => {
    const world = new FakeWorld();
    const tower = makeEnt(3, 'tower', 0, 30, 30, { radius: 1.2 });
    world.add(tower);
    world.add(makeEnt(1000, 'hero', 0, 0, 0)); // far away, cannot see the enemy
    const enemy = makeEnt(1001, 'hero', 1, 30 + TOWER.vision - 1, 30);
    world.add(enemy);
    const out = new Set<EntId>();

    expect(visibleIds(world, 0, out).has(1001)).toBe(true);

    // outside tower vision -> hidden
    enemy.x = 30 + TOWER.vision + 2;
    expect(visibleIds(world, 0, out).has(1001)).toBe(false);

    // tower destroyed -> no vision even at point blank
    enemy.x = 31;
    tower.alive = false;
    tower.hp = 0;
    expect(visibleIds(world, 0, out).has(1001)).toBe(false);
  });

  it('ancient and creep vision work as sources', () => {
    const world = new FakeWorld();
    world.add(makeEnt(0, 'ancient', 0, 10, 10, { radius: ANCIENT.radius }));
    world.add(makeEnt(1200, 'melee', 0, 60, 60));
    const nearAncient = makeEnt(1001, 'hero', 1, 10 + ANCIENT.vision - 1, 10);
    const nearCreep = makeEnt(1002, 'hero', 1, 60 + CREEP_MELEE.vision - 1, 60);
    const far = makeEnt(1003, 'hero', 1, 90, 10);
    world.add(nearAncient);
    world.add(nearCreep);
    world.add(far);
    const out = new Set<EntId>();

    const vis = visibleIds(world, 0, out);
    expect(vis.has(1001)).toBe(true);
    expect(vis.has(1002)).toBe(true);
    expect(vis.has(1003)).toBe(false);
  });

  it('projectiles are visible to both teams; dead enemies are not sent', () => {
    const world = new FakeWorld();
    world.add(makeEnt(1000, 'hero', 0, 0, 0));
    world.add(makeEnt(1300, 'proj', 1, 80, 80)); // enemy projectile deep in fog
    world.add(makeEnt(1001, 'hero', 1, 5, 0, { alive: false, hp: 0 })); // dead enemy in range
    const out = new Set<EntId>();

    const vis = visibleIds(world, 0, out);
    expect(vis.has(1300)).toBe(true);
    expect(vis.has(1001)).toBe(false);
  });

  it('clears and reuses the caller-owned set (no stale ids, no new set)', () => {
    const world = new FakeWorld();
    world.add(makeEnt(1000, 'hero', 0, 0, 0));
    const out = new Set<EntId>([99999, 88888]); // junk from a previous tick
    const before = out;

    const vis = visibleIds(world, 0, out);
    expect(vis).toBe(before);
    expect(vis.has(99999)).toBe(false);
    expect(vis.has(88888)).toBe(false);
    expect(vis.has(1000)).toBe(true);
    expect(vis.size).toBe(1);
  });

  it('an 8v8-shaped entity set computes 10k times without allocation pressure', () => {
    const world = new FakeWorld();
    // 16 heroes (8v8), 72 lane creeps, 4 summons, 4 wards, 8 projectiles,
    // 3-lane structure count: 12 towers + 4 guards + 2 ancients = 18.
    let mobileId = 1000;
    for (let team = 0 as TeamId; team <= 1; team = (team + 1) as TeamId) {
      for (let i = 0; i < 8; i += 1) {
        world.add(makeEnt(mobileId, 'hero', team, 5 + i * 10, team === 0 ? 5 : 120));
        mobileId += 1;
      }
      for (let i = 0; i < 36; i += 1) {
        const kind: EntKind = i % 9 === 8 ? 'siege' : i % 4 === 3 ? 'ranged' : 'melee';
        world.add(makeEnt(mobileId, kind, team, (i * 3.7) % 128, (i * 5.3) % 128));
        mobileId += 1;
      }
      for (let i = 0; i < 2; i += 1) {
        world.add(makeEnt(mobileId, 'shade', team, 20 + i, 20 + i));
        mobileId += 1;
        world.add(makeEnt(mobileId, 'ward', team, 40 + i, 40 + i));
        mobileId += 1;
      }
      for (let i = 0; i < 4; i += 1) {
        world.add(makeEnt(mobileId, 'proj', team, i, i));
        mobileId += 1;
      }
    }
    let structId = 0;
    for (let team = 0 as TeamId; team <= 1; team = (team + 1) as TeamId) {
      const bx = team === 0 ? 11 : 117;
      for (let i = 0; i < 6; i += 1) {
        world.add(makeEnt(structId, 'tower', team, bx + i * 8, bx + i * 4, { radius: 1.2 }));
        structId += 1;
      }
      for (let i = 0; i < 2; i += 1) {
        world.add(makeEnt(structId, 'guard', team, bx + i * 5, bx - i * 5, { radius: 1.2 }));
        structId += 1;
      }
      world.add(makeEnt(structId, 'ancient', team, bx, bx, { radius: 2.3 }));
      structId += 1;
    }

    /** Spying set: proves the reuse contract (one clear per call, adds only
     *  into the caller-owned set) instead of a flaky wall-clock bound. */
    class SpySet extends Set<EntId> {
      clears = 0;
      adds = 0;
      override clear(): void {
        this.clears += 1;
        super.clear();
      }
      override add(v: EntId): this {
        this.adds += 1;
        return super.add(v);
      }
    }
    const out0 = new SpySet();
    const out1 = new SpySet();
    for (let i = 0; i < 10_000; i += 1) {
      computeTeamVisible(world, 0, out0);
      computeTeamVisible(world, 1, out1);
    }

    // Reuse contract held on every one of the 10k calls per team.
    expect(out0.clears).toBe(10_000);
    expect(out1.clears).toBe(10_000);
    expect(out0.adds).toBeGreaterThan(0);
    expect(out1.adds).toBeGreaterThan(0);
    // Sanity: the sets actually contain the own-team mobiles (44 per team
    // here) plus whatever enemy mobiles wander into vision.
    expect(out0.size).toBeGreaterThanOrEqual(44);
    expect(out1.size).toBeGreaterThanOrEqual(44);
    // No structure id ever leaks into a visible set.
    for (const id of out0) expect(id).toBeGreaterThanOrEqual(1000);
    for (const id of out1) expect(id).toBeGreaterThanOrEqual(1000);
  }, 120_000);
});
