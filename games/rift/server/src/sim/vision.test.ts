// ============================================================================
// ANCIENTS (rift) — VISION TESTS (T5). Drives computeTeamVisible against a
// minimal fake World (a test double over the frozen sim seam — this file
// deliberately does NOT import world.ts; T3 builds it in parallel).
//
// TERRAIN_CONTRACT §8 requires this suite to grow a terrain accessor plus
// uphill-block, concealment and night cases. The terrain is HAND-BUILT here
// (a TerrainDef literal over a Uint8Array grid) rather than produced by
// buildTerrain(lanes): the point of each case is one named cell being high or
// foliage at a known metre, which a generated map cannot promise.
// ============================================================================
import { describe, expect, it } from 'vitest';
import {
  ANCIENT,
  CAMP_BRUTE,
  CAMP_HIVE,
  CAMP_PACK,
  CONCEAL_REVEAL_RADIUS,
  CREEP_MELEE,
  CREEP_RANGED,
  CREEP_SIEGE,
  DAY_PERIOD_S,
  ELEV_HIGH,
  ELEV_LOW,
  GUARD_TOWER,
  HERO_VISION,
  NEUTRAL_TEAM,
  NIGHT_VISION_MULT,
  SUMMON_SHADE,
  TERRAIN_KINDS,
  TICK_RATE,
  TOWER,
  WARD_VISION,
  elevationAt,
  kindAt,
} from '@rift/shared';
import type {
  EntKind,
  EntTeam,
  ItemId,
  MapDef,
  TeamId,
  TerrainDef,
  TerrainKind,
} from '@rift/shared';
import { computeTeamVisible, scalesAtNight, visionRadius } from './vision.js';
import { NO_ENT } from './types.js';
import type { CampState, Ent, EntId, Order, QueuedCast, SimEvent, World } from './types.js';
import type { AuraStat } from '@rift/shared';

// --- Fake terrain -------------------------------------------------------------

const SIDE = 96;

/** Numeric code of a terrain kind, as `TerrainGrid.kind` stores it. */
function code(kind: TerrainKind): number {
  return TERRAIN_KINDS.indexOf(kind);
}

/** All-`'ground'`, all-ELEV_LOW terrain: the flat plane every pre-terrain case
 *  in this suite assumes, so those cases keep asserting exactly what they used
 *  to assert. */
function flatTerrain(): TerrainDef {
  const dim = SIDE;
  const kind = new Uint8Array(dim * dim);
  kind.fill(code('ground'));
  const elev = new Uint8Array(dim * dim);
  elev.fill(ELEV_LOW);
  return {
    grid: { side: SIDE, res: 1, dim, kind, elev },
    camps: [],
    landmarks: [],
  };
}

/** Paint the inclusive metre rectangle [x0,x1] x [z0,z1] with one kind, and
 *  with the elevation that kind implies (`'high'` is the only one used here;
 *  `elevationAt` reads the elev plane, `isConcealing` reads the kind plane). */
function paint(
  t: TerrainDef,
  x0: number,
  z0: number,
  x1: number,
  z1: number,
  kind: TerrainKind,
): void {
  const g = t.grid;
  const c = code(kind);
  const e = kind === 'high' || kind === 'base' || kind === 'ramp' ? ELEV_HIGH : ELEV_LOW;
  for (let z = z0; z <= z1; z += 1) {
    for (let x = x0; x <= x1; x += 1) {
      g.kind[z * g.dim + x] = c;
      g.elev[z * g.dim + x] = e;
    }
  }
}

// --- Fake World ---------------------------------------------------------------

const STRUCTURE_KINDS: readonly EntKind[] = ['tower', 'guard', 'ancient'];

function isStructureKind(kind: EntKind): boolean {
  return STRUCTURE_KINDS.includes(kind);
}

/** `team` is `EntTeam`, not `TeamId`: a jungle camp creep carries NEUTRAL_TEAM
 *  (sim/types.ts), and until this factory admitted a 2 no camp entity could be
 *  built at all — which is why the camp arms of `visionRadius` and
 *  `scalesAtNight`, and every neutral-as-target path below, went unpinned. */
function makeEnt(
  id: EntId,
  kind: EntKind,
  team: EntTeam,
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
    atkTarget: NO_ENT,
    order: 'idle',
    ox: 0,
    oz: 0,
    orderTarget: NO_ENT,
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
  };
  return { ...base, ...overrides };
}

/** Minimal World double: entity store + iteration + a terrain-carrying map;
 *  every other member of the frozen surface is an inert no-op (vision never
 *  calls them). `tick` is writable so the day/night cases can move the match
 *  clock without rebuilding the world. */
class FakeWorld implements World {
  tick = 0;
  readonly map: MapDef;
  readonly overtime = false;
  readonly camps: CampState[] = [];
  private readonly ents = new Map<EntId, Ent>();
  private allCache: Ent[] = [];
  private mobilesCache: Ent[] = [];

  constructor(terrain: TerrainDef = flatTerrain()) {
    this.map = { lanes: 1, side: SIDE, paths: [], structures: [], terrain };
  }

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
  spawnMobile(_kind: EntKind, _team: EntTeam, _x: number, _z: number, _lane: number, _expireAtTick: number, _owner: EntId): EntId {
    return NO_ENT;
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

/** Ticks at which the day/night cycle is at a given phase. `dayPhase` ramps
 *  0 -> 1 across the first half of the cycle and back across the second
 *  (protocol.ts), so full night is the half-cycle mark. */
const FULL_NIGHT_TICK = (TICK_RATE * DAY_PERIOD_S) / 2;
const HALF_NIGHT_TICK = (TICK_RATE * DAY_PERIOD_S) / 4;

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

  it('two calls over identical world state produce identical sets', () => {
    const terrain = flatTerrain();
    paint(terrain, 30, 18, 34, 22, 'high'); // an uphill target
    paint(terrain, 24, 18, 26, 22, 'foliage'); // a concealed one
    const world = new FakeWorld(terrain);
    world.tick = HALF_NIGHT_TICK; // mid-ramp, so the night scale is in play
    world.add(makeEnt(1000, 'hero', 0, 20, 20));
    world.add(makeEnt(1010, 'ward', 0, 40, 40));
    world.add(makeEnt(1001, 'hero', 1, 25, 20)); // in foliage
    world.add(makeEnt(1002, 'melee', 1, 32, 20)); // on high ground
    world.add(makeEnt(1003, 'melee', 1, 42, 41)); // inside the ward
    const a = new Set<EntId>();
    const b = new Set<EntId>();

    computeTeamVisible(world, 0, a);
    computeTeamVisible(world, 0, b);
    expect([...a].sort((p, q) => p - q)).toEqual([...b].sort((p, q) => p - q));
    // and the sets are not vacuous — the ward still sees its own area
    expect(a.has(1003)).toBe(true);
  });

  // --- Elevation (DESIGN_DELTA §1, TERRAIN_CONTRACT §4.1) ---------------------

  describe('uphill blocking', () => {
    it('a low viewer cannot see a high target at point blank', () => {
      const terrain = flatTerrain();
      paint(terrain, 22, 18, 30, 22, 'high');
      const world = new FakeWorld(terrain);
      world.add(makeEnt(1000, 'hero', 0, 20.5, 20.5)); // low ground
      const enemy = makeEnt(1001, 'hero', 1, 22.5, 20.5); // 2 m away, on the plateau
      world.add(enemy);
      const out = new Set<EntId>();

      expect(visibleIds(world, 0, out).has(1001)).toBe(false);

      // step off the plateau and the same 2 m is plainly visible again
      enemy.x = 21.5;
      expect(visibleIds(world, 0, out).has(1001)).toBe(true);
    });

    it('a high viewer sees a low target normally', () => {
      const terrain = flatTerrain();
      paint(terrain, 18, 18, 22, 22, 'high');
      const world = new FakeWorld(terrain);
      world.add(makeEnt(1000, 'hero', 0, 20.5, 20.5)); // on the plateau
      world.add(makeEnt(1001, 'hero', 1, 20.5 + HERO_VISION - 1, 20.5)); // low, in range
      world.add(makeEnt(1002, 'hero', 1, 20.5 + HERO_VISION + 3, 20.5)); // low, out of range
      const out = new Set<EntId>();

      const vis = visibleIds(world, 0, out);
      expect(vis.has(1001)).toBe(true);
      expect(vis.has(1002)).toBe(false); // downhill does not extend the radius
    });

    it('equal elevations are unaffected, on either level', () => {
      const terrain = flatTerrain();
      paint(terrain, 18, 18, 34, 22, 'high');
      const world = new FakeWorld(terrain);
      world.add(makeEnt(1000, 'hero', 0, 20.5, 20.5)); // high
      world.add(makeEnt(1001, 'hero', 1, 28.5, 20.5)); // high, 8 m away
      world.add(makeEnt(2000, 'hero', 0, 20.5, 60.5)); // low
      world.add(makeEnt(2001, 'hero', 1, 28.5, 60.5)); // low, 8 m away
      const out = new Set<EntId>();

      const vis = visibleIds(world, 0, out);
      expect(vis.has(1001)).toBe(true);
      expect(vis.has(2001)).toBe(true);
    });

    it('a ramp counts as high ground for the block', () => {
      const terrain = flatTerrain();
      paint(terrain, 22, 18, 30, 22, 'ramp');
      const world = new FakeWorld(terrain);
      world.add(makeEnt(1000, 'hero', 0, 20.5, 20.5));
      world.add(makeEnt(1001, 'hero', 1, 23.5, 20.5)); // standing on the ramp
      const out = new Set<EntId>();

      expect(visibleIds(world, 0, out).has(1001)).toBe(false);
    });
  });

  // --- Concealment (DESIGN_DELTA §3, TERRAIN_CONTRACT §4.2) -------------------

  describe('foliage concealment', () => {
    /** Hero at (20.5, 20.5); a foliage patch from x = 23 to x = 34 on the same
     *  row, so the enemy can be moved along it from inside CONCEAL_REVEAL_RADIUS
     *  to well outside it without ever leaving the bush. */
    function bushWorld(): { world: FakeWorld; enemy: Ent; out: Set<EntId> } {
      const terrain = flatTerrain();
      paint(terrain, 23, 19, 34, 21, 'foliage');
      const world = new FakeWorld(terrain);
      world.add(makeEnt(1000, 'hero', 0, 20.5, 20.5));
      const enemy = makeEnt(1001, 'hero', 1, 28.5, 20.5); // 8 m: in vision, in bush
      world.add(enemy);
      return { world, enemy, out: new Set<EntId>() };
    }

    it('a stationary enemy inside foliage is invisible though it is well inside the radius', () => {
      const { world, enemy, out } = bushWorld();
      expect(enemy.x - 20.5).toBeLessThan(HERO_VISION); // the radius is not what hides it
      expect(enemy.x - 20.5).toBeGreaterThan(CONCEAL_REVEAL_RADIUS);
      expect(visibleIds(world, 0, out).has(1001)).toBe(false);

      // one metre out of the bush and it is seen again
      enemy.x = 22.5;
      expect(visibleIds(world, 0, out).has(1001)).toBe(true);
    });

    it('an adjacent viewer sees into the bush (CONCEAL_REVEAL_RADIUS)', () => {
      const { world, enemy, out } = bushWorld();
      enemy.x = 20.5 + CONCEAL_REVEAL_RADIUS - 0.5; // inside the reveal radius
      expect(visibleIds(world, 0, out).has(1001)).toBe(true);

      enemy.x = 20.5 + CONCEAL_REVEAL_RADIUS + 0.5; // just outside it
      expect(visibleIds(world, 0, out).has(1001)).toBe(false);
    });

    it('attacking reveals: visible on the tick it swings, hidden again once atkTarget clears', () => {
      const { world, enemy, out } = bushWorld();
      expect(visibleIds(world, 0, out).has(1001)).toBe(false);

      // combat.ts stamps atkTarget on the swing tick and clears it on every
      // tick without one; vision runs before advance(), so this is last tick's
      // swing.
      enemy.atkTarget = 1000;
      expect(visibleIds(world, 0, out).has(1001)).toBe(true);

      enemy.atkTarget = NO_ENT;
      expect(visibleIds(world, 0, out).has(1001)).toBe(false);
    });

    it('a viewer standing in foliage itself is not blocked by it', () => {
      const { world, out } = bushWorld();
      const spotter = makeEnt(1002, 'melee', 0, 24.5, 20.5); // in the same bush
      world.add(spotter);
      expect(visibleIds(world, 0, out).has(1001)).toBe(true);

      spotter.x = 22.5; // out of the bush, still in range of the target
      expect(visibleIds(world, 0, out).has(1001)).toBe(false);
    });

    it('a viewer looking down from high ground is not blocked by it', () => {
      const terrain = flatTerrain();
      paint(terrain, 23, 19, 34, 21, 'foliage');
      paint(terrain, 18, 19, 21, 21, 'high');
      const world = new FakeWorld(terrain);
      const hero = makeEnt(1000, 'hero', 0, 20.5, 20.5); // on the plateau
      world.add(hero);
      world.add(makeEnt(1001, 'hero', 1, 28.5, 20.5)); // low bush, 8 m off
      const out = new Set<EntId>();

      expect(visibleIds(world, 0, out).has(1001)).toBe(true);
    });

    it('a viewer standing on a RAMP gets no look-down exemption (AMENDMENT_1 §C)', () => {
      // Same geometry as the plateau case above, with the viewer's cell painted
      // 'ramp' instead of 'high'. `elevationAt` reads both as ELEV_HIGH, so if
      // the exception keyed on elevation alone every ramp on the map would be a
      // free bush-reveal — a ramp is a slope up out of the low ground, not a
      // vantage over it.
      const terrain = flatTerrain();
      paint(terrain, 23, 19, 34, 21, 'foliage');
      paint(terrain, 18, 19, 21, 21, 'ramp');
      const world = new FakeWorld(terrain);
      world.add(makeEnt(1000, 'hero', 0, 20.5, 20.5)); // on the ramp
      world.add(makeEnt(1001, 'hero', 1, 28.5, 20.5)); // low bush, 8 m off
      const out = new Set<EntId>();

      expect(kindAt(terrain, 20.5, 20.5)).toBe('ramp');
      expect(elevationAt(terrain, 20.5, 20.5)).toBe(ELEV_HIGH); // still high...
      expect(visibleIds(world, 0, out).has(1001)).toBe(false); // ...but blind to the bush

      // Isolation: repaint that one patch 'high' — same elevation, same
      // distance, same bush — and the exemption comes back. The ramp KIND is
      // the only thing standing between the two results.
      paint(terrain, 18, 19, 21, 21, 'high');
      expect(visibleIds(world, 0, out).has(1001)).toBe(true);
    });

    it('a ramp viewer still sees a plain low target — only the foliage exemption is narrowed', () => {
      const terrain = flatTerrain();
      paint(terrain, 18, 19, 21, 21, 'ramp');
      const world = new FakeWorld(terrain);
      world.add(makeEnt(1000, 'hero', 0, 20.5, 20.5)); // on the ramp
      world.add(makeEnt(1001, 'hero', 1, 28.5, 20.5)); // open low ground, 8 m
      const out = new Set<EntId>();

      expect(visibleIds(world, 0, out).has(1001)).toBe(true);
    });

    it('a concealed enemy is still hidden from a viewer that is merely at the same level', () => {
      const terrain = flatTerrain();
      // both the bush and the viewer sit on high ground: level parity gives no
      // look-down exemption
      paint(terrain, 18, 19, 34, 21, 'high');
      paint(terrain, 23, 19, 34, 21, 'foliage');
      const g = terrain.grid;
      for (let x = 23; x <= 34; x += 1) g.elev[20 * g.dim + x] = ELEV_HIGH;
      const world = new FakeWorld(terrain);
      world.add(makeEnt(1000, 'hero', 0, 20.5, 20.5));
      world.add(makeEnt(1001, 'hero', 1, 28.5, 20.5));
      const out = new Set<EntId>();

      expect(visibleIds(world, 0, out).has(1001)).toBe(false);
    });
  });

  // --- Day / night (DESIGN_DELTA §5, TERRAIN_CONTRACT §4.3) -------------------

  describe('night vision', () => {
    it('shrinks hero radius at night and leaves a tower untouched', () => {
      const world = new FakeWorld();
      world.add(makeEnt(1000, 'hero', 0, 20, 20));
      world.add(makeEnt(4, 'tower', 0, 60, 60, { radius: 1.2 }));
      // just inside each source's DAY radius, outside the hero's NIGHT radius
      const byHero = makeEnt(1001, 'hero', 1, 20 + HERO_VISION - 0.5, 20);
      const byTower = makeEnt(1002, 'hero', 1, 60 + TOWER.vision - 0.5, 60);
      world.add(byHero);
      world.add(byTower);
      const out = new Set<EntId>();

      world.tick = 0; // full day
      let vis = visibleIds(world, 0, out);
      expect(vis.has(1001)).toBe(true);
      expect(vis.has(1002)).toBe(true);

      world.tick = FULL_NIGHT_TICK; // full night
      vis = visibleIds(world, 0, out);
      expect(vis.has(1001)).toBe(false); // hero radius fell to 0.75x
      expect(vis.has(1002)).toBe(true); // the tower is lit, day and night

      // the hero still sees inside its reduced radius
      byHero.x = 20 + HERO_VISION * NIGHT_VISION_MULT - 0.5;
      expect(visibleIds(world, 0, out).has(1001)).toBe(true);
    });

    it("a tower's radius is identical at dayPhase 0 and 0.5 while a hero's is not", () => {
      const world = new FakeWorld();
      world.add(makeEnt(1000, 'hero', 0, 20, 20));
      world.add(makeEnt(4, 'tower', 0, 60, 60, { radius: 1.2 }));
      // between the half-night hero radius and the full-day one
      const halfScale = 1 - (1 - NIGHT_VISION_MULT) * 0.5;
      const byHero = makeEnt(1001, 'hero', 1, 20 + (HERO_VISION * halfScale + HERO_VISION) / 2, 20);
      const byTower = makeEnt(1002, 'hero', 1, 60 + TOWER.vision - 0.5, 60);
      world.add(byHero);
      world.add(byTower);
      const out = new Set<EntId>();

      world.tick = 0; // dayPhase 0
      let vis = visibleIds(world, 0, out);
      expect(vis.has(1001)).toBe(true);
      expect(vis.has(1002)).toBe(true);

      world.tick = HALF_NIGHT_TICK; // dayPhase 0.5 — the ramp, not a snap
      vis = visibleIds(world, 0, out);
      expect(vis.has(1001)).toBe(false);
      expect(vis.has(1002)).toBe(true);
    });

    it('the cycle wraps back to full day after one period', () => {
      const world = new FakeWorld();
      world.add(makeEnt(1000, 'hero', 0, 20, 20));
      world.add(makeEnt(1001, 'hero', 1, 20 + HERO_VISION - 0.5, 20));
      const out = new Set<EntId>();

      world.tick = FULL_NIGHT_TICK;
      expect(visibleIds(world, 0, out).has(1001)).toBe(false);

      world.tick = FULL_NIGHT_TICK * 2; // one full cycle: day again
      expect(visibleIds(world, 0, out).has(1001)).toBe(true);

      world.tick = FULL_NIGHT_TICK * 3; // and night again
      expect(visibleIds(world, 0, out).has(1001)).toBe(false);
    });

    it('the falling limb mirrors the rising one — a triangle, not a sawtooth', () => {
      // The defining property of the frozen dayPhase: quarter-cycle and
      // three-quarter-cycle are the SAME phase (0.5). A sawtooth reads 0.25 and
      // 0.75 there, i.e. two different radii, and the client's lighting would
      // part company with the server's fog near every wrap (AMENDMENT_1 §B.1).
      const halfScale = 1 - (1 - NIGHT_VISION_MULT) * 0.5;
      const world = new FakeWorld();
      world.add(makeEnt(1000, 'hero', 0, 20, 20));
      const near = makeEnt(1001, 'hero', 1, 20 + HERO_VISION * halfScale - 0.25, 20);
      const far = makeEnt(1002, 'hero', 1, 20 + HERO_VISION * halfScale + 0.25, 20);
      world.add(near);
      world.add(far);
      const out = new Set<EntId>();

      const quarter = TICK_RATE * DAY_PERIOD_S * 0.25;
      const threeQuarter = TICK_RATE * DAY_PERIOD_S * 0.75;
      for (const tick of [quarter, threeQuarter]) {
        world.tick = tick;
        const vis = visibleIds(world, 0, out);
        expect(vis.has(1001), `inside the half-night radius at tick ${tick}`).toBe(true);
        expect(vis.has(1002), `outside the half-night radius at tick ${tick}`).toBe(false);
      }
    });

    it('night never shrinks ward vision', () => {
      const world = new FakeWorld();
      world.add(makeEnt(1100, 'ward', 0, 50, 50));
      world.add(makeEnt(1001, 'hero', 1, 50 + WARD_VISION - 0.5, 50));
      const out = new Set<EntId>();

      world.tick = FULL_NIGHT_TICK;
      expect(visibleIds(world, 0, out).has(1001)).toBe(true);
    });
  });

  // --- The two bypasses are ABOVE the terrain vetoes and must stay there -----

  describe('own-team and projectile bypasses are exempt from terrain', () => {
    /** One low-ground viewer, and a cell 8 m away that is BOTH high ground and
     *  foliage — so an ordinary enemy standing there trips the uphill veto and
     *  the concealment veto at once. 8 m is inside HERO_VISION even at full
     *  night (11 * 0.75 = 8.25), so range is never what decides these cases.
     *  The world is also set to full night, which is where a mis-ordered
     *  refactor would bite hardest. */
    function vetoCornerWorld(): { world: FakeWorld; out: Set<EntId> } {
      const terrain = flatTerrain();
      paint(terrain, 26, 19, 34, 21, 'foliage');
      const g = terrain.grid;
      for (let z = 19; z <= 21; z += 1) {
        for (let x = 26; x <= 34; x += 1) g.elev[z * g.dim + x] = ELEV_HIGH;
      }
      const world = new FakeWorld(terrain);
      world.tick = FULL_NIGHT_TICK;
      world.add(makeEnt(1000, 'hero', 0, 20.5, 20.5)); // low, open ground
      return { world, out: new Set<EntId>() };
    }

    it('the vetoes really do fire on that cell for an ordinary enemy', () => {
      // Guard for the two cases below: without this, "still visible" could mean
      // "nothing was ever vetoed here" and both bypass tests would be vacuous.
      const { world, out } = vetoCornerWorld();
      world.add(makeEnt(1001, 'hero', 1, 28.5, 20.5));
      expect(visibleIds(world, 0, out).has(1001)).toBe(false);
    });

    it('an own-team mobile in that cell is visible anyway', () => {
      // DEAD on purpose: a living own-team creep is trivially visible because
      // it is its own vision source, which would make this case vacuous. A
      // corpse sees nothing, so only the bypass can put it in the set.
      const { world, out } = vetoCornerWorld();
      world.add(makeEnt(1002, 'melee', 0, 28.5, 20.5, { alive: false, hp: 0 }));
      expect(visibleIds(world, 0, out).has(1002)).toBe(true);
    });

    it('an ENEMY projectile in that cell is visible anyway', () => {
      const { world, out } = vetoCornerWorld();
      world.add(makeEnt(1300, 'proj', 1, 28.5, 20.5));
      expect(visibleIds(world, 0, out).has(1300)).toBe(true);
    });

    it('a dead own-team mobile with no viewer in range at all is still visible', () => {
      // The own-team bypass is unconditional — not "alive", not "in range of
      // something". Both of those live BELOW it and must stay there.
      const { world, out } = vetoCornerWorld();
      world.add(makeEnt(1002, 'melee', 0, 90, 90, { alive: false, hp: 0 }));
      expect(visibleIds(world, 0, out).has(1002)).toBe(true);
    });
  });

  // --- Neutral jungle camps (TERRAIN_CONTRACT §5) -----------------------------

  describe('neutral camps', () => {
    it('every EntKind maps to its configured vision radius', () => {
      // `computeTeamVisible` takes a TeamId, so a NEUTRAL_TEAM creep is never
      // collected as a viewer and the camp arms are unreachable through the
      // seam — this table is the only thing that can pin them.
      const expected: ReadonlyArray<readonly [EntKind, number]> = [
        ['hero', HERO_VISION],
        ['melee', CREEP_MELEE.vision],
        ['ranged', CREEP_RANGED.vision],
        ['siege', CREEP_SIEGE.vision],
        ['shade', SUMMON_SHADE.vision],
        ['ward', WARD_VISION],
        ['tower', TOWER.vision],
        ['guard', GUARD_TOWER.vision],
        ['ancient', ANCIENT.vision],
        ['campPack', CAMP_PACK.vision],
        ['campBrute', CAMP_BRUTE.vision],
        ['campHive', CAMP_HIVE.vision],
        ['proj', 0],
      ];
      for (const [kind, radius] of expected) {
        expect(visionRadius({ kind }), `visionRadius('${kind}')`).toBe(radius);
      }
    });

    it('camp creeps scale at night; lit installations and projectiles do not', () => {
      for (const kind of ['campPack', 'campBrute', 'campHive'] as const) {
        expect(scalesAtNight(kind), `scalesAtNight('${kind}')`).toBe(true);
      }
      for (const kind of ['hero', 'melee', 'ranged', 'siege', 'shade'] as const) {
        expect(scalesAtNight(kind), `scalesAtNight('${kind}')`).toBe(true);
      }
      for (const kind of ['ward', 'tower', 'guard', 'ancient', 'proj'] as const) {
        expect(scalesAtNight(kind), `scalesAtNight('${kind}')`).toBe(false);
      }
    });

    it('a camp creep is an enemy target to BOTH player teams', () => {
      const world = new FakeWorld();
      world.add(makeEnt(1000, 'hero', 0, 20, 20));
      world.add(makeEnt(2000, 'hero', 1, 26, 20));
      world.add(makeEnt(3000, 'campBrute', NEUTRAL_TEAM, 23, 20)); // 3 m from each
      const out0 = new Set<EntId>();
      const out1 = new Set<EntId>();

      expect(visibleIds(world, 0, out0).has(3000)).toBe(true);
      expect(visibleIds(world, 1, out1).has(3000)).toBe(true);
    });

    it('a camp creep gives vision to NEITHER player team', () => {
      // A camp sitting on top of an enemy hero, both far from every friendly
      // eye. If the neutral were ever collected as a viewer, team 0 would see
      // its own enemy through the jungle's eyes.
      const world = new FakeWorld();
      world.add(makeEnt(1000, 'hero', 0, 5, 5));
      world.add(makeEnt(2000, 'hero', 1, 85, 85));
      world.add(makeEnt(3000, 'campHive', NEUTRAL_TEAM, 84, 85)); // 1 m off
      const out0 = new Set<EntId>();
      const out1 = new Set<EntId>();

      expect(visibleIds(world, 0, out0).has(2000)).toBe(false);
      expect(visibleIds(world, 0, out0).has(3000)).toBe(false); // camp out of range too
      // ...and symmetrically: a camp parked on team 0's hero reveals nothing to
      // team 1 either.
      world.add(makeEnt(3001, 'campPack', NEUTRAL_TEAM, 6, 5));
      expect(visibleIds(world, 1, out1).has(1000)).toBe(false);
      expect(visibleIds(world, 1, out1).has(3001)).toBe(false);
    });

    it('a camp creep in foliage is concealed like anything else', () => {
      const terrain = flatTerrain();
      paint(terrain, 23, 19, 34, 21, 'foliage');
      const world = new FakeWorld(terrain);
      world.add(makeEnt(1000, 'hero', 0, 20.5, 20.5));
      const camp = makeEnt(3000, 'campPack', NEUTRAL_TEAM, 28.5, 20.5);
      world.add(camp);
      const out = new Set<EntId>();

      expect(visibleIds(world, 0, out).has(3000)).toBe(false);

      camp.atkTarget = 1000; // it swung last tick — attacking reveals
      expect(visibleIds(world, 0, out).has(3000)).toBe(true);
    });

    it('a dead camp creep is not sent', () => {
      const world = new FakeWorld();
      world.add(makeEnt(1000, 'hero', 0, 20, 20));
      const camp = makeEnt(3000, 'campBrute', NEUTRAL_TEAM, 23, 20);
      world.add(camp);
      const out = new Set<EntId>();

      expect(visibleIds(world, 0, out).has(3000)).toBe(true);
      camp.alive = false;
      camp.hp = 0;
      expect(visibleIds(world, 0, out).has(3000)).toBe(false);
    });
  });

  // --- The module-level viewer pool (8v8 shaped) ------------------------------
  //
  // vision.ts reuses ONE module-level Viewer pool across every call so a steady
  // tick allocates nothing. The old test here looped 10k times and asserted
  // nothing that a single call did not already prove — it could not fail. What
  // the pool can actually get wrong is state leaking between calls: the room
  // calls this twice per tick, once per team, and if the active window is not
  // reset then team 1 inherits team 0's eyes. These cases pin exactly that.

  /** 8v8 shaped world: 16 heroes, 72 lane creeps, 4 summons, 4 wards, 8
   *  projectiles, and a 3-lane structure count (12 towers, 4 guards, 2
   *  ancients). Ids: structures below 1000, mobiles at 1000 and up. */
  function eightVEightWorld(): FakeWorld {
    const world = new FakeWorld();
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
    return world;
  }

  function sorted(s: Set<EntId>): EntId[] {
    return [...s].sort((p, q) => p - q);
  }

  describe('shared viewer pool', () => {
    it("a team's set is identical whether or not the other team was computed first", () => {
      // The pool is module-level and shared. If the active window is not reset
      // at the top of pass 1, the second call's viewers are APPENDED to the
      // first call's, and team 1 starts seeing through team 0's heroes — the
      // exact shape of a fog-of-war leak, and invisible to any single-call
      // test.
      const world = eightVEightWorld();
      const alone = new Set<EntId>();
      computeTeamVisible(world, 0, alone);
      const expected = sorted(alone);

      const other = new Set<EntId>();
      const after = new Set<EntId>();
      computeTeamVisible(world, 1, other);
      computeTeamVisible(world, 0, after);
      expect(sorted(after)).toEqual(expected);

      // and it survives repetition — a leak that only grows would show here
      for (let i = 0; i < 8; i += 1) {
        computeTeamVisible(world, 1, other);
        computeTeamVisible(world, 0, after);
      }
      expect(sorted(after)).toEqual(expected);
    });

    it('the two teams do not see the same set (the fixture is not symmetric junk)', () => {
      // Guard for the case above: if both teams saw everything, "identical"
      // would be trivially true no matter how badly the pool leaked.
      const world = eightVEightWorld();
      const out0 = new Set<EntId>();
      const out1 = new Set<EntId>();
      computeTeamVisible(world, 0, out0);
      computeTeamVisible(world, 1, out1);
      expect(sorted(out0)).not.toEqual(sorted(out1));
    });

    it('clears the caller set exactly once per call and never emits a structure id', () => {
      /** Spying set: proves the reuse contract (one clear per call, adds only
       *  into the caller-owned set) instead of a flaky wall-clock bound. */
      class SpySet extends Set<EntId> {
        clears = 0;
        override clear(): void {
          this.clears += 1;
          super.clear();
        }
      }
      const world = eightVEightWorld();
      const out0 = new SpySet();
      const out1 = new SpySet();
      for (let i = 0; i < 5; i += 1) {
        computeTeamVisible(world, 0, out0);
        computeTeamVisible(world, 1, out1);
      }

      expect(out0.clears).toBe(5);
      expect(out1.clears).toBe(5);
      // 52 own-team mobiles per team (8 heroes + 36 creeps + 2 shades +
      // 2 wards + 4 projectiles) are unconditionally in the set, and no
      // structure ever is — structure ids are all below 1000 in this fixture.
      expect(out0.size).toBeGreaterThanOrEqual(52);
      expect(out1.size).toBeGreaterThanOrEqual(52);
      for (const id of out0) expect(id).toBeGreaterThanOrEqual(1000);
      for (const id of out1) expect(id).toBeGreaterThanOrEqual(1000);
    });
  });
});
