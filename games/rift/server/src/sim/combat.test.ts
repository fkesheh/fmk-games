// ============================================================================
// T3 — SIM CORE: combat.ts tests. Mitigation math (armor formula, hero-only
// magic resist), attack cadence, atkTarget set/cleared, last-hit bounty to the
// killing hero only, creep xp split radius, hero-kill gold/xp/first-blood/
// assists, tower bounty to living enemy heroes, Fortify on/off, ancient
// invulnerability while guards stand, tower hero-aggro switching, nearest-
// creep targeting, siege multiplier, lifesteal, stun. Gold assertions account
// for passive income (PASSIVE_GOLD_PER_S * TICK_DT per tick per hero).
//
// Plus TERRAIN_CONTRACT §4/§5: the uphill miss (rate — measured both on the
// raw hash and on real swings through fire() — determinism, spent swing, wire
// event, and that only LOW->HIGH misses) and neutral-safe kill attribution (one
// paying team per neutral death, including when the last hitter has already
// been reaped; no first blood, no kill event, no deaths counter, and the
// isPlayerTeam guards holding when a camp lands the killing blow on a hero).
//
// Terrain positions are SEARCHED, never hard-coded: buildMap() is a pure
// function of the lane count, so the search is deterministic, and it cannot
// drift the way a literal coordinate can.
// ============================================================================
import { describe, expect, it } from 'vitest';
import {
  ARMOR_K,
  ASSIST_GOLD,
  buildMap,
  CAMP_LEASH_RADIUS,
  CAMP_PACK,
  CREEP_MELEE,
  ELEV_HIGH,
  ELEV_LOW,
  elevationAt,
  FIRST_BLOOD_BONUS,
  FORTIFY_HERO_DAMAGE_MULT,
  HERO_KILL_XP_BASE,
  HERO_KILL_XP_PER_LEVEL,
  HERO_MAGIC_RESIST,
  HIGH_GROUND_MISS,
  isPassable,
  KILL_GOLD_BASE,
  KILL_GOLD_PER_LEVEL,
  missRoll,
  NEUTRAL_TEAM,
  PASSIVE_GOLD_PER_S,
  SIEGE_BUILDING_MULT,
  TICK_DT,
  TOWER,
  TOWER_HERO_AGGRO_WINDOW_S,
  TICK_RATE,
  XP_SHARE_RADIUS,
} from '@rift/shared';
import type { Elevation, MapDef, Vec2 } from '@rift/shared';
import { createWorld } from './world.js';
import { NO_ENT } from './types.js';
import type { AbilitiesEngine, Ent, SeatDef, SimEvent, World } from './types.js';

class EngineDouble implements AbilitiesEngine {
  step(world: World): void {
    world.drainCasts();
  }
}

const SEATS: SeatDef[] = [
  { pid: 'p0', team: 0, hero: 'reaver', bot: false, lane: 0 },
  { pid: 'p2', team: 0, hero: 'bullwark', bot: false, lane: 0 },
  { pid: 'p3', team: 0, hero: 'mender', bot: false, lane: 0 },
  { pid: 'p1', team: 1, hero: 'longbow', bot: false, lane: 0 },
];

function makeWorld(seats: SeatDef[] = SEATS): World {
  return createWorld(buildMap(1), seats, () => 0.5, new EngineDouble());
}

function must<T>(v: T | undefined): T {
  if (v === undefined) throw new Error('expected entity to exist');
  return v;
}

function hero(w: World, pid: string): Ent {
  for (const e of w.mobiles()) {
    if (e.kind === 'hero' && e.pid === pid) return e;
  }
  throw new Error(`no hero ${pid}`);
}

function structure(w: World, kind: Ent['kind'], team: 0 | 1): Ent {
  for (const e of w.all()) {
    if (e.kind === kind && e.team === team) return e;
  }
  throw new Error(`no ${kind} for team ${team}`);
}

function advance(w: World, n: number): void {
  for (let i = 0; i < n; i++) w.advance();
}

/** Physical mitigation multiplier from the frozen armor formula. */
function physMult(armor: number): number {
  return 1 - (ARMOR_K * armor) / (1 + ARMOR_K * Math.abs(armor));
}

const PASSIVE_PER_TICK = PASSIVE_GOLD_PER_S * TICK_DT;

/** Every world in this file is `buildMap(1)`, and buildMap is a pure function
 *  of the lane count — so one shared copy is the same map every world gets. */
const MAP = buildMap(1);

// --- terrain fixtures -------------------------------------------------------

/** Squared distance from (x,z) to segment a->b. */
function distToSeg(x: number, z: number, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const len2 = dx * dx + dz * dz;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / len2)) : 0;
  return Math.hypot(a.x + dx * t - x, a.z + dz * t - z);
}

/** A duelling spot must be quiet for the whole test: no tower in range, no lane
 *  corridor whose creep waves could wander in and take a swing, and no camp
 *  clearing whose neutrals will spawn there once camps.ts is wired in. */
function quiet(map: MapDef, x: number, z: number, clearance: number): boolean {
  for (const s of map.structures) {
    if (Math.hypot(s.x - x, s.z - z) < clearance) return false;
  }
  for (const p of map.paths) {
    for (let i = 0; i + 1 < p.length; i++) {
      const a = p[i];
      const b = p[i + 1];
      if (!a || !b) continue;
      if (distToSeg(x, z, a, b) < clearance) return false;
    }
  }
  for (const c of map.terrain.camps) {
    if (Math.hypot(c.x - x, c.z - z) < clearance) return false;
  }
  return true;
}

/** The widest offset any test in this file puts between the arena centre and a
 *  combatant, plus the room a chasing hero needs to close on one. */
const ARENA_SPREAD = 8;

/** Clearance the arena needs from a camp CLEARING — the centre is not the edge
 *  of a camp's reach. A member acquires inside
 *  `CAMP_LEASH_RADIUS - CAMP_ACQUIRE_MARGIN` and retains out to
 *  `CAMP_LEASH_RADIUS`, measured from the clearing, so the whole arena
 *  footprint must sit outside that disc with margin. The same number is used
 *  for towers and lane corridors, where it is comfortably more than enough. */
const ARENA_CLEAR = CAMP_LEASH_RADIUS + ARENA_SPREAD + 6;

/** True when every metre of the square of half-width `r` around (x, z) is
 *  walkable, in bounds, and at ONE elevation.
 *
 *  Flatness is not cosmetic: TERRAIN_CONTRACT §4 makes a LOW->HIGH swing miss
 *  `HIGH_GROUND_MISS` of the time, so an arena straddling a ramp would drop
 *  swings out of every cadence and damage assertion in this file at a rate
 *  that depends on the entity ids the test happened to allocate. */
function flatOpen(map: MapDef, x: number, z: number, r: number): boolean {
  for (let dz = -r; dz <= r; dz++) {
    for (let dx = -r; dx <= r; dx++) {
      const px = x + dx;
      const pz = z + dz;
      if (px < 0 || pz < 0 || px > map.side || pz > map.side) return false;
      if (!isPassable(map.terrain, px, pz)) return false;
      if (elevationAt(map.terrain, px, pz) !== ELEV_LOW) return false;
    }
  }
  return true;
}

/** The duelling arena: a quiet, flat, walkable pocket every staged fight in
 *  this file happens in. SEARCHED in row-major order, so it is a pure function
 *  of the map and identical on every run — never written down.
 *
 *  It used to be the literal `(20, 60)`, which cost nothing right up until
 *  `stepCamps` was wired into `advance()`: that point is 1.6 m from the camp
 *  clearing at (21.5, 61.5), so three campBrutes began spawning inside the
 *  fixture and swinging at whatever it contained. Four tests that assert on
 *  cadence, bounty and first blood were measuring a three-on-one brawl. A
 *  literal cannot notice the map moving underneath it; this search can. */
function findArena(map: MapDef): Vec2 {
  const dim = map.terrain.grid.dim;
  for (let cz = 0; cz < dim; cz++) {
    for (let cx = 0; cx < dim; cx++) {
      const x = cx + 0.5;
      const z = cz + 0.5;
      if (!quiet(map, x, z, ARENA_CLEAR)) continue;
      if (!flatOpen(map, x, z, ARENA_SPREAD)) continue;
      return { x, z };
    }
  }
  throw new Error(`no ${ARENA_SPREAD}m flat arena with ${ARENA_CLEAR}m of clearance`);
}

/** Off-lane arena, far from every tower, lane and camp. */
const ARENA: Vec2 = findArena(MAP);

/** A point on the far side of the map from the arena: outside every share
 *  radius and every aggro radius the arena can reach, and still in bounds
 *  wherever the arena search lands. */
const FAR_FROM_ARENA: Vec2 = { x: MAP.side - ARENA.x, z: MAP.side - ARENA.z };

/** Two quiet, passable cell centres at the requested elevations, no more than
 *  `gap` metres apart. Scans in row-major order, so the answer is a pure
 *  function of the map — the same pair on every run and every machine. */
function findPair(map: MapDef, ea: Elevation, eb: Elevation, gap: number, clearance: number): {
  a: Vec2;
  b: Vec2;
} {
  const t = map.terrain;
  const dim = t.grid.dim;
  const r = Math.ceil(gap);
  const usable = (x: number, z: number, want: Elevation): boolean =>
    elevationAt(t, x, z) === want && isPassable(t, x, z) && quiet(map, x, z, clearance);
  for (let cz = 0; cz < dim; cz++) {
    for (let cx = 0; cx < dim; cx++) {
      const ax = cx + 0.5;
      const az = cz + 0.5;
      if (!usable(ax, az, ea)) continue;
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          if (dx === 0 && dz === 0) continue;
          const bx = ax + dx;
          const bz = az + dz;
          if (bx < 1 || bz < 1 || bx > dim - 1 || bz > dim - 1) continue;
          if (Math.hypot(bx - ax, bz - az) > gap) continue;
          if (!usable(bx, bz, eb)) continue;
          return { a: { x: ax, z: az }, b: { x: bx, z: bz } };
        }
      }
    }
  }
  throw new Error(`no ${ea}->${eb} pair within ${gap}m and ${clearance}m of clearance`);
}

/** longbow (attackRange 10) shooting a stunned melee dummy that cannot move,
 *  retaliate or die: the swing cadence is the only thing that varies. */
function duel(attackerAt: Vec2, targetAt: Vec2): { w: World; a: Ent; d: Ent } {
  const w = makeWorld();
  const a = hero(w, 'p1');
  a.x = attackerAt.x;
  a.z = attackerAt.z;
  const d = must(w.get(w.spawnMobile('melee', 0, targetAt.x, targetAt.z, -1, 0, NO_ENT)));
  w.stun(d.id, 3600);
  w.order(a.id, { kind: 'attack', target: d.id });
  return { w, a, d };
}

interface Swing {
  tick: number;
  hit: boolean;
  nextAttackTick: number;
}

/** Advance `ticks` ticks, logging one entry per swing. The dummy is topped up
 *  before every tick so it never dies and every swing is measured against a
 *  full bar; creeps have no hp regen, so any deficit after a tick is damage. */
function swings(w: World, a: Ent, d: Ent, ticks: number): Swing[] {
  const out: Swing[] = [];
  for (let i = 0; i < ticks; i++) {
    d.hp = d.maxHp;
    w.advance();
    if (a.atkTarget !== d.id) continue;
    out.push({ tick: w.tick, hit: d.hp < d.maxHp, nextAttackTick: a.nextAttackTick });
  }
  return out;
}

/** Write the one impossible state combat.ts guards against. `Ent.team` is
 *  readonly and every structure is built from `StructureDef.team`, which is a
 *  TeamId — so a structure off the player teams cannot be produced by any
 *  supported call, and the guard protecting `SimEvent.structure.team` would
 *  otherwise be unreachable and untestable. */
function forceNeutral(e: Ent): void {
  Object.assign(e, { team: NEUTRAL_TEAM });
}

/** The single blow every neutral-loot test below lands on its fixture. */
const NEUTRAL_KILL_DAMAGE = 50;

/** The health bar `neutral()` hands its fixture. Small and explicit: these
 *  tests are about who gets paid when a neutral dies, not about how much a
 *  campPack can take, so the death must be a certainty rather than an
 *  arithmetic race against a balance constant. Pinned against
 *  NEUTRAL_KILL_DAMAGE by the first test in the `neutral deaths` block. */
const NEUTRAL_FIXTURE_HP = 10;

/** A neutral jungle creep carrying known loot and a health bar the FIXTURE
 *  owns.
 *
 *  This used to set only `bounty`/`xpValue` and inherit its health, silently
 *  depending on `mobileTuning('campPack')` returning null and `spawnMobile`
 *  falling back to a 1 hp marker. AMENDMENT_2 §D.2 required that arm to exist
 *  — `Ent.radius` is readonly and written once from the tuning, so a brute's
 *  combat reach cannot be corrected afterwards — and the moment it landed a
 *  campPack had CAMP_PACK's real 240 hp and the 50-damage blow below stopped
 *  killing anything. The production change was right; the hidden dependency
 *  was the defect.
 *
 *  Only `hp` is written, deliberately. `recomputeEnt` rewrites `maxHp` from
 *  the base core on every tick of `advance()`, so a fixture that also assigned
 *  `maxHp` would be asserting a number the next tick silently discards — the
 *  same species of lie this helper is being fixed for. The current bar is the
 *  part a fixture can actually own, and it is the part these tests need. */
function neutral(w: World, x: number, z: number, bounty: number, xp: number): Ent {
  const e = must(w.get(w.spawnMobile('campPack', NEUTRAL_TEAM, x, z, -1, 0, NO_ENT)));
  e.hp = NEUTRAL_FIXTURE_HP;
  e.bounty = bounty;
  e.xpValue = xp;
  return e;
}

describe('the staged-fight arena', () => {
  it('stays empty of everything the sim spawns on its own', () => {
    // Every duel, bounty and first-blood assertion in this file assumes the
    // arena contains exactly the entities the test put there. That was true by
    // luck until stepCamps was wired into advance(); it is true by search now,
    // and this is what notices if it stops being true again.
    const w = makeWorld();
    const dummy = must(w.get(w.spawnMobile('melee', 0, ARENA.x, ARENA.z, -1, 0, NO_ENT)));
    w.stun(dummy.id, 3600); // it never moves, so the arena stays centred on it
    const intruders = new Set<string>();
    for (let i = 0; i < 400; i++) {
      w.advance();
      for (const e of w.mobiles()) {
        if (e.id === dummy.id) continue;
        if (Math.hypot(e.x - ARENA.x, e.z - ARENA.z) <= ARENA_SPREAD) {
          intruders.add(`${e.kind}#${e.id}`);
        }
      }
    }
    expect([...intruders]).toEqual([]);
    expect(dummy.hp).toBe(dummy.maxHp); // and nothing took a swing at it
    expect(dummy.alive).toBe(true);
  });
});

describe('mitigation', () => {
  it('applies the exact armor formula to physical damage', () => {
    const w = makeWorld();
    const p0 = hero(w, 'p0');
    const creep = must(w.get(w.spawnMobile('melee', 1, ARENA.x, ARENA.z, -1, 0, NO_ENT)));
    w.damage(p0.id, creep.id, 100, 'physical');
    expect(creep.maxHp - creep.hp).toBeCloseTo(100 * physMult(2), 6); // melee armor 2
  });

  it('applies flat magic resist to heroes only', () => {
    const w = makeWorld();
    const p0 = hero(w, 'p0');
    const p1 = hero(w, 'p1');
    const creep = must(w.get(w.spawnMobile('melee', 1, ARENA.x, ARENA.z, -1, 0, NO_ENT)));
    w.damage(p0.id, p1.id, 100, 'magic');
    expect(p1.maxHp - p1.hp).toBeCloseTo(100 * (1 - HERO_MAGIC_RESIST), 6);
    w.damage(p0.id, creep.id, 100, 'magic');
    expect(creep.maxHp - creep.hp).toBeCloseTo(100, 6); // creeps have no resist
  });
});

describe('basic attack cycle', () => {
  it('swings once per attackPeriod and sets/clears atkTarget each tick', () => {
    const w = makeWorld();
    const p0 = hero(w, 'p0');
    p0.x = ARENA.x;
    p0.z = ARENA.z;
    const creep = must(w.get(w.spawnMobile('melee', 1, ARENA.x + 1, ARENA.z, -1, 0, NO_ENT)));
    w.stun(creep.id, 60); // target dummy: no retaliation
    w.order(p0.id, { kind: 'attack', target: creep.id });
    let swings = 0;
    for (let i = 0; i < 45; i++) {
      w.advance();
      if (p0.atkTarget === creep.id) swings += 1;
    }
    expect(swings).toBe(3); // ticks 1, 21, 41 at attackPeriod 1.0
    // atkTarget clears on a tick with no swing
    expect(p0.atkTarget).toBe(NO_ENT);
    expect(creep.hp).toBeLessThan(creep.maxHp);
  });

  it('stun zeroes attacks', () => {
    const w = makeWorld();
    const p0 = hero(w, 'p0');
    p0.x = ARENA.x;
    p0.z = ARENA.z;
    const creep = must(w.get(w.spawnMobile('melee', 1, ARENA.x + 1, ARENA.z, -1, 0, NO_ENT)));
    w.stun(p0.id, 1.0); // 20 ticks
    w.order(p0.id, { kind: 'attack', target: creep.id });
    advance(w, 19);
    expect(creep.hp).toBe(creep.maxHp);
    advance(w, 25); // stun over, swings land
    expect(creep.hp).toBeLessThan(creep.maxHp);
  });

  it('lifesteal heals the attacker for post-mitigation physical damage vs units', () => {
    const w = makeWorld();
    const p0 = hero(w, 'p0');
    p0.gold = 5000;
    w.buy(p0.id, 'fang'); // 12% lifesteal (p0 is at its fountain)
    expect(p0.items).toContain('fang');
    p0.x = ARENA.x;
    p0.z = ARENA.z;
    p0.hp = 100;
    const creep = must(w.get(w.spawnMobile('melee', 1, ARENA.x + 1, ARENA.z, -1, 0, NO_ENT)));
    w.stun(creep.id, 60);
    w.order(p0.id, { kind: 'attack', target: creep.id });
    w.advance(); // exactly one swing
    const dealt = p0.damage * physMult(2);
    const expected = 100 + dealt * 0.12 + p0.hpRegen * TICK_DT;
    expect(p0.hp).toBeCloseTo(expected, 4);
  });
});

describe('creep loot', () => {
  it('last-hit bounty goes to the killing hero only; xp splits in the share radius', () => {
    const w = makeWorld();
    const p0 = hero(w, 'p0');
    const p2 = hero(w, 'p2');
    const p3 = hero(w, 'p3');
    p0.x = ARENA.x;
    p0.z = ARENA.z;
    p2.x = ARENA.x + 5; // within XP_SHARE_RADIUS (20), does NOT attack
    p2.z = ARENA.z;
    // p3 stays at its fountain, far away: same team, out of radius
    const creep = must(w.get(w.spawnMobile('melee', 1, ARENA.x + 1, ARENA.z, -1, 0, NO_ENT)));
    const g0 = p0.gold;
    const g2 = p2.gold;
    const g3 = p3.gold;
    const x0 = p0.xp;
    const x2 = p2.xp;
    const x3 = p3.xp;
    w.order(p0.id, { kind: 'attack', target: creep.id });
    let ticks = 0;
    while (creep.alive && ticks < 600) {
      w.advance();
      ticks += 1;
    }
    expect(creep.alive).toBe(false);
    expect(p0.gold - g0).toBeCloseTo(CREEP_MELEE.bounty + PASSIVE_PER_TICK * ticks, 4); // bounty + passive
    expect(p2.gold - g2).toBeCloseTo(PASSIVE_PER_TICK * ticks, 4); // passive only
    const sharedXp = CREEP_MELEE.xp / 2; // split two ways: p0 + p2 in radius
    expect(p0.xp - x0).toBeCloseTo(sharedXp, 4);
    expect(p2.xp - x2).toBeCloseTo(sharedXp, 4);
    expect(p3.xp - x3).toBeCloseTo(0, 9); // out of radius
    expect(p3.gold - g3).toBeCloseTo(PASSIVE_PER_TICK * ticks, 4);
  });

  it('a tower or creep last-hit pays no bounty to anyone', () => {
    const w = makeWorld();
    const p0 = hero(w, 'p0');
    const creep = must(w.get(w.spawnMobile('melee', 1, ARENA.x, ARENA.z, -1, 0, NO_ENT)));
    const g0 = p0.gold;
    w.damage(creep.id, creep.id, 9999, 'physical'); // suicide/neutral source
    const before = p0.gold;
    w.advance();
    expect(p0.gold - before).toBeCloseTo(PASSIVE_PER_TICK, 9);
    expect(p0.gold - g0).toBeLessThan(CREEP_MELEE.bounty);
  });
});

describe('hero kills', () => {
  it('pays kill gold + first blood once, splits kill xp, credits assists', () => {
    const w = makeWorld();
    const p0 = hero(w, 'p0');
    const p1 = hero(w, 'p1');
    const p2 = hero(w, 'p2');
    p0.x = ARENA.x;
    p0.z = ARENA.z;
    p2.x = ARENA.x + 4; // in xp share radius, an assister
    p2.z = ARENA.z;
    p1.x = ARENA.x + 1;
    p1.z = ARENA.z;
    // p2 damages p1 inside the assist window, then p0 gets the kill. The
    // victim starts pre-wounded so the kill lands well inside
    // ASSIST_WINDOW_S (8 s) — a full-hp longbow takes ~10 s to burn down,
    // which would legitimately expire the window.
    w.damage(p2.id, p1.id, 50, 'physical');
    p1.hp = 150;
    const g0 = p0.gold;
    const g2 = p2.gold;
    w.order(p0.id, { kind: 'attack', target: p1.id });
    let ticks = 0;
    while (p1.alive && ticks < 800) {
      w.advance();
      ticks += 1;
    }
    expect(p1.alive).toBe(false);
    const killGold = KILL_GOLD_BASE + KILL_GOLD_PER_LEVEL * 1 + FIRST_BLOOD_BONUS;
    expect(p0.gold - g0).toBeCloseTo(killGold + PASSIVE_PER_TICK * ticks, 3);
    expect(p0.kills).toBe(1);
    expect(p1.deaths).toBe(1);
    expect(p2.assists).toBe(1);
    expect(p2.gold - g2).toBeCloseTo(ASSIST_GOLD + PASSIVE_PER_TICK * ticks, 3);
    const killXp = HERO_KILL_XP_BASE + HERO_KILL_XP_PER_LEVEL * 1;
    expect(p0.xp).toBeCloseTo(killXp / 2, 3); // split p0/p2
    expect(p2.xp).toBeCloseTo(killXp / 2, 3);
    const events = w.drainEvents();
    const kill = events.find((e) => e.k === 'kill');
    expect(kill).toBeDefined();
    if (kill && kill.k === 'kill') {
      expect(kill.killerPid).toBe('p0');
      expect(kill.victimPid).toBe('p1');
      expect(kill.gold).toBe(killGold);
      expect(kill.firstBlood).toBe(true);
    }
  });

  it('awards no first-blood bonus on the second kill of the match', () => {
    const w = makeWorld();
    const p0 = hero(w, 'p0');
    const p1 = hero(w, 'p1');
    p0.x = ARENA.x;
    p0.z = ARENA.z;
    p1.x = ARENA.x + 1;
    p1.z = ARENA.z;
    w.order(p0.id, { kind: 'attack', target: p1.id });
    let guard = 0;
    while (p1.alive && guard < 800) {
      w.advance();
      guard += 1;
    }
    // wait out the respawn, drag the victim back, kill again
    advance(w, (6 + 3 * 1) * TICK_RATE + 2);
    expect(p1.alive).toBe(true);
    p1.x = ARENA.x + 1;
    p1.z = ARENA.z;
    p0.x = ARENA.x;
    p0.z = ARENA.z;
    w.order(p0.id, { kind: 'attack', target: p1.id });
    w.drainEvents();
    const g0 = p0.gold;
    guard = 0;
    while (p1.alive && guard < 800) {
      w.advance();
      guard += 1;
    }
    const killGold = KILL_GOLD_BASE + KILL_GOLD_PER_LEVEL * 1;
    expect(p0.gold - g0).toBeCloseTo(killGold + PASSIVE_PER_TICK * guard, 3);
    const second = w.drainEvents().find((e) => e.k === 'kill');
    expect(second).toBeDefined();
    if (second && second.k === 'kill') {
      expect(second.gold).toBe(killGold);
      expect(second.firstBlood).toBe(false);
    }
  });
});

describe('structures', () => {
  it('pays tower bounty to every LIVING enemy hero', () => {
    const w = makeWorld();
    const p0 = hero(w, 'p0');
    const p2 = hero(w, 'p2');
    const p3 = hero(w, 'p3');
    // p3 dies first (no bounty for the dead)
    w.damage(p0.id, p3.id, 99999, 'physical');
    w.advance();
    expect(p3.alive).toBe(false);
    w.drainEvents();
    const tower = structure(w, 'tower', 1);
    const g0 = p0.gold;
    const g2 = p2.gold;
    const g3 = p3.gold;
    w.damage(p0.id, tower.id, 99999, 'physical');
    w.advance();
    expect(tower.alive).toBe(false);
    expect(p0.gold - g0).toBeCloseTo(TOWER.bounty + PASSIVE_PER_TICK, 4);
    expect(p2.gold - g2).toBeCloseTo(TOWER.bounty + PASSIVE_PER_TICK, 4);
    expect(p3.gold - g3).toBeCloseTo(PASSIVE_PER_TICK, 4); // dead: no bounty
    const ev = w.drainEvents().find((e) => e.k === 'structure');
    expect(ev).toBeDefined();
    if (ev && ev.k === 'structure') {
      expect(ev.team).toBe(1);
      expect(ev.kind).toBe('tower');
      expect(ev.lane).toBe(0);
    }
  });

  it('pays a structure bounty even when the team guard blocks the announcement', () => {
    // The isPlayerTeam guard exists for ONE thing: SimEvent.structure.team is a
    // TeamId the client uses to index two-element tuples. It must gate the
    // event and nothing else — sitting above the payout would forfeit the
    // bounty of any structure that ever left the two player teams.
    const w = makeWorld();
    const p0 = hero(w, 'p0');
    const p2 = hero(w, 'p2');
    const tower = structure(w, 'tower', 1);
    forceNeutral(tower);
    expect(tower.team).toBe(NEUTRAL_TEAM);
    w.drainEvents();
    const g0 = p0.gold;
    const g2 = p2.gold;
    w.damage(p0.id, tower.id, 99999, 'physical');
    w.advance();
    expect(tower.alive).toBe(false);
    expect(p0.gold - g0).toBeCloseTo(TOWER.bounty + PASSIVE_PER_TICK, 4);
    expect(p2.gold - g2).toBeCloseTo(TOWER.bounty + PASSIVE_PER_TICK, 4);
    expect(w.drainEvents().some((e) => e.k === 'structure')).toBe(false);
  });

  it('Fortify reduces hero damage to structures with no enemy creep nearby', () => {
    const w = makeWorld();
    const p0 = hero(w, 'p0');
    const tower = structure(w, 'tower', 1);
    p0.x = tower.x - 2.5;
    p0.z = tower.z;
    w.order(p0.id, { kind: 'attack', target: tower.id });
    w.advance(); // one fortified swing
    const fortified = tower.maxHp - tower.hp;
    expect(fortified).toBeCloseTo(p0.damage * FORTIFY_HERO_DAMAGE_MULT * physMult(TOWER.armor), 4);
    // bring a friendly wave-creep within FORTIFY_RADIUS: Fortify drops
    w.spawnMobile('melee', 0, tower.x - 5, tower.z, -1, 0, NO_ENT);
    const hpBefore = tower.hp;
    advance(w, 20); // exactly one more swing
    const unfortified = hpBefore - tower.hp;
    expect(unfortified).toBeCloseTo(p0.damage * physMult(TOWER.armor), 4);
    expect(unfortified / fortified).toBeCloseTo(1 / FORTIFY_HERO_DAMAGE_MULT, 2);
  });

  it('ancients are invulnerable while any own guard stands', () => {
    const w = makeWorld();
    const p0 = hero(w, 'p0');
    const anc = structure(w, 'ancient', 1);
    w.damage(p0.id, anc.id, 5000, 'physical');
    expect(anc.hp).toBe(anc.maxHp);
    for (const e of [...w.all()]) {
      if (e.kind === 'guard' && e.team === 1) w.damage(p0.id, e.id, 999999, 'physical');
    }
    w.advance();
    w.damage(p0.id, anc.id, 5000, 'physical');
    expect(anc.hp).toBeLessThan(anc.maxHp);
  });

  it('siege creeps deal SIEGE_BUILDING_MULT to structures', () => {
    const w = makeWorld();
    const tower = structure(w, 'tower', 1);
    const siege = must(w.get(w.spawnMobile('siege', 0, tower.x - 6, tower.z, -1, 0, NO_ENT)));
    const hp0 = tower.hp;
    advance(w, 51); // two swings at attackPeriod 2.5
    expect(siege.alive).toBe(true);
    const perSwing = 46 * SIEGE_BUILDING_MULT * physMult(TOWER.armor);
    expect(hp0 - tower.hp).toBeCloseTo(perSwing * 2, 3);
  });
});

describe('tower targeting', () => {
  it('shoots the nearest enemy creep in range', () => {
    const w = makeWorld();
    const tower = structure(w, 'tower', 1);
    const near = must(w.get(w.spawnMobile('melee', 0, tower.x - 6, tower.z, -1, 0, NO_ENT)));
    w.spawnMobile('melee', 0, tower.x - 9, tower.z, -1, 0, NO_ENT);
    w.advance();
    expect(tower.atkTarget).toBe(near.id);
  });

  it('switches to a hero that damaged an allied hero, then back after the window', () => {
    const w = makeWorld();
    const p0 = hero(w, 'p0');
    const p1 = hero(w, 'p1');
    const tower = structure(w, 'tower', 1);
    const creep = must(w.get(w.spawnMobile('melee', 0, tower.x - 8, tower.z, -1, 0, NO_ENT)));
    p0.x = tower.x - 5;
    p0.z = tower.z;
    p1.x = tower.x - 4; // allied hero inside tower range
    p1.z = tower.z;
    w.advance();
    expect(tower.atkTarget).toBe(creep.id); // default: creeps
    w.damage(p0.id, p1.id, 10, 'physical'); // hero-on-hero aggro trigger
    // the tower is mid-cooldown from its first swing (attackPeriod 1.0): the
    // aggro switch shows on its NEXT swing, one second later
    advance(w, TICK_RATE);
    expect(tower.atkTarget).toBe(p0.id);
    // let the aggro window lapse without further hero damage
    advance(w, Math.round(TOWER_HERO_AGGRO_WINDOW_S * TICK_RATE) + 25);
    expect(p0.alive).toBe(true);
    expect(creep.alive).toBe(true);
    // atkTarget is per-swing tracer state, cleared every tick: advance to the
    // tower's next swing, then check who it chose
    let wait = 0;
    while (tower.atkTarget === NO_ENT && wait < TICK_RATE * 2) {
      w.advance();
      wait += 1;
    }
    expect(tower.atkTarget).toBe(creep.id);
  });
});

// --- TERRAIN_CONTRACT §4: the uphill miss ------------------------------------

describe('missRoll', () => {
  it('lands inside HIGH_GROUND_MISS at the stated rate over 10 000 rolls', () => {
    let low = 0;
    for (let i = 0; i < 10000; i++) {
      if (missRoll(i, 1000 + (i % 37), 2000 + ((i * 7) % 53)) < HIGH_GROUND_MISS) low += 1;
    }
    expect(Math.abs(low / 10000 - HIGH_GROUND_MISS)).toBeLessThanOrEqual(0.02);
  });

  it('sweeps uniformly over the tick alone, at a fixed attacker/target pair', () => {
    let low = 0;
    for (let tick = 0; tick < 10000; tick++) {
      if (missRoll(tick, 1042, 1077) < HIGH_GROUND_MISS) low += 1;
    }
    expect(Math.abs(low / 10000 - HIGH_GROUND_MISS)).toBeLessThanOrEqual(0.02);
  });

  it('is a pure function: the same triple always yields the same roll', () => {
    for (let i = 0; i < 500; i++) {
      const first = missRoll(i, 1001, 1002);
      expect(missRoll(i, 1001, 1002)).toBe(first);
      expect(first).toBeGreaterThanOrEqual(0);
      expect(first).toBeLessThan(1);
    }
    // attacker and target are not interchangeable
    expect(missRoll(9, 1001, 1002)).not.toBe(missRoll(9, 1002, 1001));
  });
});

describe('uphill miss', () => {
  const GAP = 4;
  const CLEAR = 22;

  it('the map offers quiet low->high and low->low duelling ground', () => {
    const slope = findPair(MAP, ELEV_LOW, ELEV_HIGH, GAP, CLEAR);
    expect(elevationAt(MAP.terrain, slope.a.x, slope.a.z)).toBe(ELEV_LOW);
    expect(elevationAt(MAP.terrain, slope.b.x, slope.b.z)).toBe(ELEV_HIGH);
    const flat = findPair(MAP, ELEV_LOW, ELEV_LOW, GAP, CLEAR);
    expect(elevationAt(MAP.terrain, flat.a.x, flat.a.z)).toBe(ELEV_LOW);
    expect(elevationAt(MAP.terrain, flat.b.x, flat.b.z)).toBe(ELEV_LOW);
  });

  it('misses exactly the swings missRoll marks, and spends every one of them', () => {
    const slope = findPair(MAP, ELEV_LOW, ELEV_HIGH, GAP, CLEAR);
    const { w, a, d } = duel(slope.a, slope.b);
    const log = swings(w, a, d, 1200);
    expect(log.length).toBeGreaterThan(30);
    const period = Math.max(1, Math.round(a.attackPeriod * TICK_RATE));
    let misses = 0;
    for (const s of log) {
      const expectedMiss = missRoll(s.tick, a.id, d.id) < HIGH_GROUND_MISS;
      expect(s.hit).toBe(!expectedMiss);
      // a missed swing is a SPENT swing: the cooldown advances either way
      expect(s.nextAttackTick).toBe(s.tick + period);
      if (expectedMiss) misses += 1;
    }
    expect(misses).toBeGreaterThan(0);
    expect(misses).toBeLessThan(log.length);
    // neither duellist drifted off the elevation the test set them on
    expect(elevationAt(w.map.terrain, a.x, a.z)).toBe(ELEV_LOW);
    expect(elevationAt(w.map.terrain, d.x, d.z)).toBe(ELEV_HIGH);
  });

  it('never misses shooting downhill', () => {
    const slope = findPair(MAP, ELEV_LOW, ELEV_HIGH, GAP, CLEAR);
    const { w, a, d } = duel(slope.b, slope.a);
    const log = swings(w, a, d, 1200);
    expect(log.length).toBeGreaterThan(30);
    for (const s of log) expect(s.hit).toBe(true);
    expect(elevationAt(w.map.terrain, a.x, a.z)).toBe(ELEV_HIGH);
    expect(elevationAt(w.map.terrain, d.x, d.z)).toBe(ELEV_LOW);
  });

  it('never misses on level ground, however the roll falls', () => {
    const flat = findPair(MAP, ELEV_LOW, ELEV_LOW, GAP, CLEAR);
    const { w, a, d } = duel(flat.a, flat.b);
    const log = swings(w, a, d, 1200);
    expect(log.length).toBeGreaterThan(30);
    let rolledUnder = 0;
    for (const s of log) {
      expect(s.hit).toBe(true);
      if (missRoll(s.tick, a.id, d.id) < HIGH_GROUND_MISS) rolledUnder += 1;
    }
    // the roll would have missed some of these had elevation permitted it
    expect(rolledUnder).toBeGreaterThan(0);
  });

  it('emits a miss event carrying ENTITY ids, and only on a miss', () => {
    const slope = findPair(MAP, ELEV_LOW, ELEV_HIGH, GAP, CLEAR);
    const { w, a, d } = duel(slope.a, slope.b);
    let seen: Extract<SimEvent, { k: 'miss' }> | undefined;
    let hitTicksWithMiss = 0;
    for (let i = 0; i < 1200 && seen === undefined; i++) {
      d.hp = d.maxHp;
      w.advance();
      // AMENDMENT_1 §B.2 put 'miss' in the SimEvent union, so the drained batch
      // narrows by discriminant: if combat.ts pushed anything else, or pushed
      // through a widened seam, this file would not compile.
      const drained: SimEvent[] = w.drainEvents();
      const miss = drained.find((ev) => ev.k === 'miss');
      if (a.atkTarget !== d.id) continue;
      if (d.hp < d.maxHp) {
        if (miss !== undefined) hitTicksWithMiss += 1;
        continue;
      }
      seen = miss;
    }
    expect(hitTicksWithMiss).toBe(0);
    expect(seen).toBeDefined();
    expect(seen?.attacker).toBe(a.id);
    expect(seen?.target).toBe(d.id);
    expect(seen?.attacker).toBeGreaterThanOrEqual(1000); // entity id, not a pid
  });

  it('the miss rate of REAL swings through fire() matches HIGH_GROUND_MISS', () => {
    // The missRoll suite above measures the hash with synthetic ids. This one
    // measures what the sim actually does: every sample is a swing that went
    // through stepCombat -> fire(), on the real terrain, at the real ids.
    const slope = findPair(MAP, ELEV_LOW, ELEV_HIGH, GAP, CLEAR);
    const { w, a, d } = duel(slope.a, slope.b);
    let swung = 0;
    let missed = 0;
    for (let i = 0; i < 10000; i++) {
      d.hp = d.maxHp;
      a.nextAttackTick = 0; // cadence is measured elsewhere; sample every tick
      w.advance();
      if (a.atkTarget !== d.id) continue;
      swung += 1;
      if (d.hp === d.maxHp) missed += 1;
    }
    expect(swung).toBeGreaterThanOrEqual(9900);
    expect(missed).toBeGreaterThan(0);
    expect(missed).toBeLessThan(swung);
    expect(Math.abs(missed / swung - HIGH_GROUND_MISS)).toBeLessThanOrEqual(0.02);
    expect(elevationAt(w.map.terrain, a.x, a.z)).toBe(ELEV_LOW);
    expect(elevationAt(w.map.terrain, d.x, d.z)).toBe(ELEV_HIGH);
  });

  it('replays bit-for-bit: two identical worlds diverge nowhere', () => {
    const slope = findPair(MAP, ELEV_LOW, ELEV_HIGH, GAP, CLEAR);
    const one = duel(slope.a, slope.b);
    const two = duel(slope.a, slope.b);
    for (let i = 0; i < 400; i++) {
      one.w.advance();
      two.w.advance();
      expect(two.d.hp).toBe(one.d.hp);
      expect(two.a.atkTarget).toBe(one.a.atkTarget);
      expect(two.a.nextAttackTick).toBe(one.a.nextAttackTick);
    }
    expect(one.d.hp).toBeLessThan(one.d.maxHp);
  });
});

// --- TERRAIN_CONTRACT §5: neutral-safe attribution ---------------------------

describe('neutral deaths', () => {
  it('the fixture carries real camp tuning and still dies to the blow below', () => {
    // Both halves of the trap that broke this block, pinned. If the camp arms
    // of mobileTuning() go away the first two assertions fail; if the fixture
    // goes back to inheriting its health from the tuning table the third does.
    const w = makeWorld();
    const camp = neutral(w, ARENA.x + 1, ARENA.z, 60, 120);
    expect(camp.maxHp).toBe(CAMP_PACK.hp);
    expect(camp.radius).toBe(CAMP_PACK.radius);
    expect(camp.hp).toBe(NEUTRAL_FIXTURE_HP);
    expect(NEUTRAL_KILL_DAMAGE * physMult(CAMP_PACK.armor)).toBeGreaterThan(NEUTRAL_FIXTURE_HP);
    // `maxHp` is the world's — recomputeEnt rewrites it from the base core
    // every tick — and `hp` is the fixture's, held because a camp does not
    // regenerate (AMENDMENT_1 §C, AMENDMENT_2 §D.5).
    advance(w, 20);
    expect(camp.alive).toBe(true);
    expect(camp.maxHp).toBe(CAMP_PACK.hp);
    expect(camp.hp).toBe(NEUTRAL_FIXTURE_HP);
  });

  it('pays xp and bounty to the killer team only, never to both', () => {
    const w = makeWorld();
    const p0 = hero(w, 'p0'); // team 0
    const p1 = hero(w, 'p1'); // team 1, well inside the share radius
    p0.x = ARENA.x;
    p0.z = ARENA.z;
    p1.x = ARENA.x + 3;
    p1.z = ARENA.z;
    const camp = neutral(w, ARENA.x + 1, ARENA.z, 60, 120);
    expect(camp.team).toBe(NEUTRAL_TEAM);
    expect(Math.hypot(p1.x - camp.x, p1.z - camp.z)).toBeLessThan(XP_SHARE_RADIUS);
    const g0 = p0.gold;
    const g1 = p1.gold;
    const x0 = p0.xp;
    const x1 = p1.xp;
    w.damage(p0.id, camp.id, NEUTRAL_KILL_DAMAGE, 'physical');
    w.advance();
    expect(camp.alive).toBe(false);
    expect(p0.xp - x0).toBeCloseTo(120, 6); // whole share, one team, one hero
    expect(p1.xp - x1).toBeCloseTo(0, 9); // the enemy team is paid nothing
    expect(p0.gold - g0).toBeCloseTo(60 + PASSIVE_PER_TICK, 4);
    expect(p1.gold - g1).toBeCloseTo(PASSIVE_PER_TICK, 4);
  });

  it('splits the neutral xp within the killer team, not across teams', () => {
    const w = makeWorld();
    const p0 = hero(w, 'p0');
    const p2 = hero(w, 'p2'); // same team, in radius, did not swing
    const p1 = hero(w, 'p1');
    p0.x = ARENA.x;
    p0.z = ARENA.z;
    p2.x = ARENA.x + 4;
    p2.z = ARENA.z;
    p1.x = ARENA.x + 2;
    p1.z = ARENA.z;
    const camp = neutral(w, ARENA.x + 1, ARENA.z, 30, 100);
    const x0 = p0.xp;
    const x1 = p1.xp;
    const x2 = p2.xp;
    w.damage(p0.id, camp.id, NEUTRAL_KILL_DAMAGE, 'physical');
    w.advance();
    expect(camp.alive).toBe(false);
    expect(p0.xp - x0).toBeCloseTo(50, 6);
    expect(p2.xp - x2).toBeCloseTo(50, 6);
    expect(p1.xp - x1).toBeCloseTo(0, 9);
  });

  it('still pays the last hitter team after the last hitter has been reaped', () => {
    // The undefined branch of the killer lookup. A wave creep lands the blow
    // that stays `lastHitBy`, dies, and leaves the store; the camp is finished
    // off later by a source that writes no lastHitBy at all — exactly how
    // camps.ts culls an orphaned member. The camp must still pay the creep's
    // team, not nobody.
    const w = makeWorld();
    const p0 = hero(w, 'p0'); // team 0 — the creep's team, the payee
    const p1 = hero(w, 'p1'); // team 1 — in radius, must be paid nothing
    p0.x = ARENA.x;
    p0.z = ARENA.z;
    p1.x = ARENA.x + 3;
    p1.z = ARENA.z;
    const camp = neutral(w, ARENA.x + 1, ARENA.z, 60, 120);
    expect(Math.hypot(p1.x - camp.x, p1.z - camp.z)).toBeLessThan(XP_SHARE_RADIUS);
    const creep = must(
      w.get(w.spawnMobile('melee', 0, FAR_FROM_ARENA.x, FAR_FROM_ARENA.z, -1, 0, NO_ENT)),
    );
    expect(Math.hypot(creep.x - camp.x, creep.z - camp.z)).toBeGreaterThan(XP_SHARE_RADIUS);
    // a real blow, small enough that the camp outlives the creep that dealt it
    w.damage(creep.id, camp.id, 0.25, 'physical');
    expect(camp.lastHitBy).toBe(creep.id);
    expect(camp.alive).toBe(true);
    camp.hp = camp.maxHp;
    w.advance(); // the tick that can still read the creep's team
    // now kill the creep and let stepDeaths reap its corpse
    w.damage(p1.id, creep.id, 999999, 'physical');
    w.advance();
    expect(w.get(creep.id)).toBeUndefined();
    expect(camp.alive).toBe(true);
    expect(camp.lastHitBy).toBe(creep.id); // a dangling id: no ent behind it
    advance(w, 5); // several ticks later, so this is not a same-tick fluke
    expect(camp.alive).toBe(true);
    expect(camp.lastHitBy).toBe(creep.id);
    const g0 = p0.gold;
    const x0 = p0.xp;
    const x1 = p1.xp;
    camp.hp = 0; // an orphan cull: no damage event, no fresh lastHitBy
    w.advance();
    expect(camp.alive).toBe(false);
    expect(p0.xp - x0).toBeCloseTo(120, 6); // the reaped creep's team is paid
    expect(p1.xp - x1).toBeCloseTo(0, 9); // and the other team still is not
    expect(p0.gold - g0).toBeCloseTo(PASSIVE_PER_TICK, 4); // bounty needs a hero
  });

  it('pays nobody when a neutral dies with no player killer', () => {
    const w = makeWorld();
    const p0 = hero(w, 'p0');
    const p1 = hero(w, 'p1');
    p0.x = ARENA.x;
    p0.z = ARENA.z;
    p1.x = ARENA.x + 2;
    p1.z = ARENA.z;
    const camp = neutral(w, ARENA.x + 1, ARENA.z, 60, 120);
    const x0 = p0.xp;
    const x1 = p1.xp;
    w.damage(camp.id, camp.id, NEUTRAL_KILL_DAMAGE, 'physical'); // neutral last-hitter
    w.advance();
    expect(camp.alive).toBe(false);
    expect(p0.xp - x0).toBeCloseTo(0, 9);
    expect(p1.xp - x1).toBeCloseTo(0, 9);
  });

  it('never claims first blood and never emits a kill event', () => {
    const w = makeWorld();
    const p0 = hero(w, 'p0');
    const p1 = hero(w, 'p1');
    p0.x = ARENA.x;
    p0.z = ARENA.z;
    const camp = neutral(w, ARENA.x + 1, ARENA.z, 60, 120);
    const deathsBefore = p0.deaths + p1.deaths;
    w.damage(p0.id, camp.id, NEUTRAL_KILL_DAMAGE, 'physical');
    w.advance();
    expect(camp.alive).toBe(false);
    expect(w.drainEvents().some((e) => e.k === 'kill')).toBe(false);
    expect(p0.deaths + p1.deaths).toBe(deathsBefore);
    // first blood is still on the table for the first HERO kill
    p1.x = ARENA.x + 1;
    p1.z = ARENA.z;
    w.order(p0.id, { kind: 'attack', target: p1.id });
    let guard = 0;
    while (p1.alive && guard < 800) {
      w.advance();
      guard += 1;
    }
    expect(p1.alive).toBe(false);
    const kill = w.drainEvents().find((e) => e.k === 'kill');
    expect(kill).toBeDefined();
    if (kill && kill.k === 'kill') {
      expect(kill.firstBlood).toBe(true);
      expect(kill.gold).toBe(KILL_GOLD_BASE + KILL_GOLD_PER_LEVEL * 1 + FIRST_BLOOD_BONUS);
    }
  });

  it('routes a hero victim to hero loot on ANY team, and never soft-locks it', () => {
    // The death router keys on kind alone. Gating it on isPlayerTeam too would
    // send this ent to killCreep — no respawnAtTick — while the corpse loop
    // never removes a hero: dead forever, in the store, unrespawnable.
    const w = makeWorld();
    const p0 = hero(w, 'p0');
    const stray = must(w.get(w.spawnMobile('hero', NEUTRAL_TEAM, ARENA.x, ARENA.z, -1, 0, NO_ENT)));
    expect(stray.kind).toBe('hero');
    expect(stray.team).toBe(NEUTRAL_TEAM);
    w.damage(p0.id, stray.id, 999999, 'physical');
    w.advance();
    expect(stray.alive).toBe(false);
    expect(w.get(stray.id)).toBeDefined(); // heroes are kept for the respawn
    expect(stray.respawnAtTick).toBeGreaterThan(w.tick); // and one is scheduled
  });

  it('survives a camp landing the killing blow on a hero', () => {
    const w = makeWorld();
    const p0 = hero(w, 'p0'); // team 0: in radius, paid the kill xp
    const p1 = hero(w, 'p1'); // team 1: the victim
    p1.x = ARENA.x;
    p1.z = ARENA.z;
    p0.x = ARENA.x + 3;
    p0.z = ARENA.z;
    const camp = neutral(w, ARENA.x + 1, ARENA.z, 60, 120);
    const g0 = p0.gold;
    const x0 = p0.xp;
    w.damage(camp.id, p1.id, 99999, 'physical');
    w.advance();
    expect(p1.alive).toBe(false);
    expect(p1.deaths).toBe(1);
    expect(p0.kills).toBe(0);
    expect(p0.gold - g0).toBeCloseTo(PASSIVE_PER_TICK, 4); // no bounty for a camp's kill
    expect(p0.xp - x0).toBeCloseTo(HERO_KILL_XP_BASE + HERO_KILL_XP_PER_LEVEL * 1, 4);
    const kill = w.drainEvents().find((e) => e.k === 'kill');
    expect(kill).toBeDefined();
    if (kill && kill.k === 'kill') {
      expect(kill.killerPid).toBe(null);
      expect(kill.victimPid).toBe('p1');
      expect(kill.gold).toBe(0);
      expect(kill.firstBlood).toBe(false);
    }
  });
});
