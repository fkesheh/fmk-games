// ============================================================================
// T3 — SIM CORE: combat.ts tests. Mitigation math (armor formula, hero-only
// magic resist), attack cadence, atkTarget set/cleared, last-hit bounty to the
// killing hero only, creep xp split radius, hero-kill gold/xp/first-blood/
// assists, tower bounty to living enemy heroes, Fortify on/off, ancient
// invulnerability while guards stand, tower hero-aggro switching, nearest-
// creep targeting, siege multiplier, lifesteal, stun. Gold assertions account
// for passive income (PASSIVE_GOLD_PER_S * TICK_DT per tick per hero).
// ============================================================================
import { describe, expect, it } from 'vitest';
import {
  ARMOR_K,
  ASSIST_GOLD,
  buildMap,
  FIRST_BLOOD_BONUS,
  FORTIFY_HERO_DAMAGE_MULT,
  HERO_KILL_XP_BASE,
  HERO_KILL_XP_PER_LEVEL,
  HERO_MAGIC_RESIST,
  KILL_GOLD_BASE,
  KILL_GOLD_PER_LEVEL,
  PASSIVE_GOLD_PER_S,
  SIEGE_BUILDING_MULT,
  TICK_DT,
  TOWER,
  TOWER_HERO_AGGRO_WINDOW_S,
  TICK_RATE,
} from '@rift/shared';
import { createWorld } from './world.js';
import { NO_ENT } from './types.js';
import type { AbilitiesEngine, Ent, SeatDef, World } from './types.js';

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
/** Off-lane arena, far from every tower. */
const ARENA = { x: 20, z: 60 };

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
    p2.x = ARENA.x + 5; // within XP_SHARE_RADIUS (12), does NOT attack
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
    expect(p0.gold - g0).toBeCloseTo(45 + PASSIVE_PER_TICK * ticks, 4); // bounty + passive
    expect(p2.gold - g2).toBeCloseTo(PASSIVE_PER_TICK * ticks, 4); // passive only
    expect(p0.xp - x0).toBeCloseTo(20, 4); // 40 xp split two ways
    expect(p2.xp - x2).toBeCloseTo(20, 4);
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
    expect(p0.gold - g0).toBeLessThan(45);
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
