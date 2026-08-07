// ============================================================================
// T3 — SIM CORE: world.ts + movement.ts tests. Construction/seats/structures,
// intake validation (orders degrade/no-op, cast queue drained by the INJECTED
// engine at step 2 — proven by a recording double, abilities.ts is never
// imported), the mutation surface (stun/slow/aura/dash), passive auras
// (self + radius membership re-evaluated every 5 ticks), movement (steering,
// structure slide, soft separation, bounds clamp, waypoint following), and
// the end-state freeze. Gold assertions account for passive income.
// ============================================================================
import { describe, expect, it } from 'vitest';
import {
  BASE_INSET,
  buildMap,
  CAMP_BRUTE,
  CAMP_HIVE,
  CAMP_PACK,
  HERO_VISION,
  isPassable,
  NEUTRAL_TEAM,
  STARTING_GOLD,
  STARTING_SKILL_POINTS,
  TICK_RATE,
} from '@rift/shared';
import type { CreepTuning, EntKind } from '@rift/shared';
import { createWorld } from './world.js';
import { NO_ENT } from './types.js';
import type { AbilitiesEngine, Ent, QueuedCast, SeatDef, World } from './types.js';

/** Recording abilities-engine double: counts step calls, drains the cast
 *  queue exactly like the real engine must, and snapshots what it saw. */
class EngineDouble implements AbilitiesEngine {
  stepCalls = 0;
  drains = 0;
  drained: QueuedCast[][] = [];
  /** order state of ent 1000 observed during each step (orchestration probe). */
  orderSeenDuringStep: (string | undefined)[] = [];
  step(world: World): void {
    this.stepCalls += 1;
    const q = world.drainCasts();
    this.drains += 1;
    this.drained.push(q.slice());
    this.orderSeenDuringStep.push(world.get(1000)?.order);
  }
}

const SEATS: SeatDef[] = [
  { pid: 'p0', team: 0, hero: 'reaver', bot: false, lane: 0 },
  { pid: 'p1', team: 1, hero: 'longbow', bot: false, lane: 0 },
];

function makeWorld(seats: SeatDef[] = SEATS, lanes = 1): { w: World; engine: EngineDouble } {
  const engine = new EngineDouble();
  return { w: createWorld(buildMap(lanes), seats, () => 0.5, engine), engine };
}

function must<T>(v: T | undefined): T {
  if (v === undefined) throw new Error('expected entity to exist');
  return v;
}

function heroByPid(w: World, pid: string): Ent {
  for (const e of w.mobiles()) {
    if (e.kind === 'hero' && e.pid === pid) return e;
  }
  throw new Error(`no hero for pid ${pid}`);
}

function advance(w: World, n: number): void {
  for (let i = 0; i < n; i++) w.advance();
}

/** world.ts's private `ORDER_SNAP_CELLS`, restated. It is deliberately not
 *  exported — it is an implementation budget, not contract — so the test
 *  carries its own copy and the snap assertions below are written to hold for
 *  any value at least this large. */
const ORDER_SNAP_CELLS = 6;

/** A pocket of the map with no structure, lane or camp clearing within reach:
 *  a lone neutral parked here is left completely alone, so anything that
 *  happens to its health bar came from the code under test. The tests using it
 *  assert that isolation rather than assuming it. */
const QUIET_SPOT = { x: 84.5, z: 8.5 };


describe('world construction', () => {
  it('builds structure ents at their MapDef ids and hero mobiles from 1000', () => {
    const { w } = makeWorld();
    const map = buildMap(1);
    for (const def of map.structures) {
      const e = must(w.get(def.id));
      expect(e.kind).toBe(def.kind);
      expect(e.team).toBe(def.team);
      expect(e.x).toBeCloseTo(def.x, 9);
      expect(e.z).toBeCloseTo(def.z, 9);
      expect(e.hp).toBeGreaterThan(0);
      expect(e.alive).toBe(true);
    }
    const anc0 = map.structures.find((s) => s.kind === 'ancient' && s.team === 0);
    expect(anc0?.x).toBeCloseTo(BASE_INSET, 9);
    const h0 = heroByPid(w, 'p0');
    const h1 = heroByPid(w, 'p1');
    expect(h0.id).toBeGreaterThanOrEqual(1000);
    expect(h1.id).toBeGreaterThanOrEqual(1000);
    expect(h0.level).toBe(1);
    expect(h0.gold).toBe(STARTING_GOLD);
    expect(h0.skillPoints).toBe(STARTING_SKILL_POINTS);
    expect(h0.vision).toBe(HERO_VISION);
    expect(h0.hero).toBe('reaver');
    // heroes spawn at their own fountains
    expect(Math.hypot(h0.x - BASE_INSET, h0.z - BASE_INSET)).toBeLessThan(6);
    expect(Math.hypot(h1.x - (map.side - BASE_INSET), h1.z - (map.side - BASE_INSET))).toBeLessThan(6);
  });

  it('inRadius fills the caller buffer with living ents only, no allocation semantics', () => {
    const { w } = makeWorld();
    const out: Ent[] = [];
    const n = w.inRadius(BASE_INSET, BASE_INSET, 8, out);
    expect(n).toBeGreaterThanOrEqual(2); // team-0 ancient + hero p0 nearby
    for (let i = 0; i < n; i++) {
      const e = must(out[i]);
      expect(Math.hypot(e.x - BASE_INSET, e.z - BASE_INSET)).toBeLessThanOrEqual(8);
    }
    const far = w.inRadius(0.5, 0.5, 1, out);
    expect(far).toBe(0);
  });
});

describe('order intake', () => {
  it('applies queued move orders at the next advance, not immediately', () => {
    const { w } = makeWorld();
    const h = heroByPid(w, 'p0');
    w.order(h.id, { kind: 'move', x: 40, z: 40 });
    expect(h.order).toBe('idle'); // queued, not applied yet
    w.advance();
    expect(h.order).toBe('move');
    expect(h.ox).toBe(40);
    expect(h.oz).toBe(40);
  });

  it('silently ignores orders for unknown or dead heroes', () => {
    const { w } = makeWorld();
    expect(() => {
      w.order(9999, { kind: 'move', x: 1, z: 1 });
      w.order(5, { kind: 'stop' }); // a structure id: not a hero
      w.advance();
    }).not.toThrow();
  });

  it('degrades attack on an illegal target to attack-move on its position, drops unknown ids', () => {
    const { w } = makeWorld();
    const h = heroByPid(w, 'p0');
    // own-team target (an allied structure): illegal, degrades to an
    // attack-move toward its last known position (far away, so the move
    // cannot complete inside the same tick)
    const ally = must([...w.all()].find((e) => e.kind === 'tower' && e.team === 0));
    w.order(h.id, { kind: 'attack', target: ally.id });
    w.advance();
    expect(h.order).toBe('attackmove');
    expect(h.ox).toBeCloseTo(ally.x, 9);
    expect(h.oz).toBeCloseTo(ally.z, 9);
    // unknown id: dropped entirely
    w.order(h.id, { kind: 'attack', target: 424242 });
    w.advance();
    expect(h.order).not.toBe('attack');
    expect(h.orderTarget).toBe(NO_ENT);
  });

  it('stop returns the hero to idle', () => {
    const { w } = makeWorld();
    const h = heroByPid(w, 'p0');
    w.order(h.id, { kind: 'move', x: 60, z: 60 });
    w.advance();
    w.order(h.id, { kind: 'stop' });
    w.advance();
    expect(h.order).toBe('idle');
  });

  it('snaps a destination inside a cliff to the NEAREST passable cell, and only then', () => {
    // AMENDMENT_1 §C. Cliffs are solid and nothing but a hero is pathed, so an
    // order onto one would otherwise steer the unit into the face and leave it
    // pressed there for the rest of the match, having eaten the click.
    const { w } = makeWorld();
    const map = buildMap(1);
    const g = map.terrain.grid;
    const cell = map.side / g.dim;
    const h = heroByPid(w, 'p0');

    // (0.5, 0.5) is the centre of a cliff cell, and it is comfortably INSIDE
    // the map — so nothing below can be produced by the bounds clamp.
    const click = { x: 0.5, z: 0.5 };
    expect(isPassable(map.terrain, click.x, click.z)).toBe(false);
    w.order(h.id, { kind: 'move', x: click.x, z: click.z });
    w.advance();
    expect(isPassable(map.terrain, h.ox, h.oz)).toBe(true);

    // NEAREST, not merely "some passable cell": nothing walkable within the
    // snap budget lies closer to the click than the destination chosen.
    const budget = ORDER_SNAP_CELLS * cell;
    const chosen = Math.hypot(h.ox - click.x, h.oz - click.z);
    expect(chosen).toBeLessThanOrEqual(budget);
    let best = Infinity;
    for (let cz = 0; cz < g.dim; cz++) {
      for (let cx = 0; cx < g.dim; cx++) {
        const px = (cx + 0.5) * cell;
        const pz = (cz + 0.5) * cell;
        const d = Math.hypot(px - click.x, pz - click.z);
        if (d > budget) continue;
        if (!isPassable(map.terrain, px, pz)) continue;
        if (d < best) best = d;
      }
    }
    expect(best).toBeLessThan(Infinity);
    expect(chosen).toBeCloseTo(best, 9);
    // and the hero can stand where it was sent
    advance(w, 600);
    expect(h.x).toBeCloseTo(h.ox, 6);
    expect(h.z).toBeCloseTo(h.oz, 6);

    // A LEGAL destination is untouched to the last bit — the snap must not
    // quantise ordinary clicks onto cell centres. (48.25, 48.75) is walkable
    // and is deliberately not the centre of its own cell.
    expect(isPassable(map.terrain, 48.25, 48.75)).toBe(true);
    w.order(h.id, { kind: 'move', x: 48.25, z: 48.75 });
    w.advance();
    expect(h.ox).toBe(48.25);
    expect(h.oz).toBe(48.75);
  });
});

describe('cast queue + injected engine', () => {
  it('the engine is stepped once per advance and drains queued casts', () => {
    const { w, engine } = makeWorld();
    const h = heroByPid(w, 'p0');
    w.cast(h.id, 0, 30, 30, NO_ENT);
    expect(engine.stepCalls).toBe(0);
    w.advance();
    expect(engine.stepCalls).toBe(1);
    expect(engine.drains).toBe(1);
    const q = must(engine.drained[0]);
    expect(q).toHaveLength(1);
    expect(q[0]).toEqual({ kind: 'ability', hero: h.id, slot: 0, x: 30, z: 30, target: NO_ENT });
    // next tick the queue is empty
    w.advance();
    expect(must(engine.drained[1])).toHaveLength(0);
  });

  it('runs step 1 (orders) before step 2 (the injected engine)', () => {
    const { w, engine } = makeWorld();
    w.order(1000, { kind: 'move', x: 50, z: 50 });
    w.advance();
    expect(engine.orderSeenDuringStep[0]).toBe('move'); // order already applied at step 2
  });
});

describe('mutation surface', () => {
  it('stun zeroes movement for its duration', () => {
    const { w } = makeWorld();
    const h = heroByPid(w, 'p0');
    h.x = 30;
    h.z = 30;
    w.stun(h.id, 1.0); // 20 ticks
    w.order(h.id, { kind: 'move', x: 50, z: 50 });
    advance(w, 10);
    expect(Math.hypot(h.x - 30, h.z - 30)).toBeLessThan(1e-9);
    advance(w, 15); // stun expired at +20
    expect(Math.hypot(h.x - 30, h.z - 30)).toBeGreaterThan(0.2);
  });

  it('strongest active slow wins and slows expire', () => {
    const { w } = makeWorld();
    const h = heroByPid(w, 'p0');
    w.slow(h.id, 0.3, 2);
    w.advance();
    expect(h.slowPct).toBeCloseTo(0.3, 9);
    w.slow(h.id, 0.5, 2);
    w.advance();
    expect(h.slowPct).toBeCloseTo(0.5, 9); // stronger overwrites
    w.slow(h.id, 0.4, 2);
    w.advance();
    expect(h.slowPct).toBeCloseTo(0.5, 9); // weaker does not
    advance(w, 2 * TICK_RATE + 2);
    expect(h.slowPct).toBe(0); // expired
  });

  it('dash covers the distance in ~0.15s and clamps to map bounds', () => {
    const { w } = makeWorld();
    const map = buildMap(1);
    const h = heroByPid(w, 'p0');
    h.x = 30;
    h.z = 30;
    w.dash(h.id, 36, 30);
    advance(w, 5);
    expect(h.x).toBeCloseTo(36, 6);
    expect(h.z).toBeCloseTo(30, 6);
    // Out of bounds: `dash` CLAMPS its destination into the map and stops
    // there. It does not snap — the nearest-passable-cell snap of
    // AMENDMENT_1 §C belongs to `World.order`, because a click is a guess at
    // where the player meant and a dash is a scripted vector that the ability
    // already aimed. The clamp is what this test names, and the clamped
    // destination is what it reads.
    w.dash(h.id, -50, -50);
    advance(w, 5);
    expect(h.ox).toBe(0);
    expect(h.oz).toBe(0);
    // The corner (0, 0) is a CLIFF cell at 1, 2 and 3 lanes and cliffs are
    // solid, so the arrival is the face in front of it, not the corner: the
    // hero travels toward the clamped point, ends up inside the map on
    // walkable ground, and then stops dead instead of grinding into the rock.
    expect(isPassable(map.terrain, 0, 0)).toBe(false);
    expect(h.x).toBeGreaterThanOrEqual(0);
    expect(h.z).toBeGreaterThanOrEqual(0);
    expect(Math.hypot(h.x, h.z)).toBeLessThan(Math.hypot(30, 30)); // it moved
    expect(isPassable(map.terrain, h.x, h.z)).toBe(true);
    const rest = { x: h.x, z: h.z };
    advance(w, 40);
    expect(h.x).toBe(rest.x);
    expect(h.z).toBe(rest.z);
  });

  it('applyAura changes effective stats until it expires', () => {
    const { w } = makeWorld();
    const h = heroByPid(w, 'p0');
    const baseArmor = h.armor;
    w.applyAura(h.id, 'armor', 5, false, 1.0, h.id);
    w.advance();
    expect(h.armor).toBeCloseTo(baseArmor + 5, 9);
    advance(w, TICK_RATE + 2);
    expect(h.armor).toBeCloseTo(baseArmor, 9);
  });

  it('heal clamps at maxHp', () => {
    const { w } = makeWorld();
    const h = heroByPid(w, 'p0');
    h.hp = 10;
    w.heal(h.id, 99999);
    expect(h.hp).toBe(h.maxHp);
  });
});

describe('passive auras (step 3)', () => {
  it('radius-0 self passive applies at rank 1 and refreshes on rank-up', () => {
    const seats: SeatDef[] = [
      { pid: 's', team: 0, hero: 'shade', bot: false, lane: 0 },
      { pid: 'x', team: 1, hero: 'longbow', bot: false, lane: 0 },
    ];
    const { w } = makeWorld(seats);
    const h = heroByPid(w, 's');
    const baseDmg = h.damage;
    w.spendSkillPoint(h.id, 2); // shade_e: +12 damage passive
    expect(h.abilityRanks[2]).toBe(1);
    w.advance();
    expect(h.damage).toBeCloseTo(baseDmg + 12, 9);
  });

  it('radius > 0 passive aura re-evaluates membership every 5 ticks', () => {
    const seats: SeatDef[] = [
      { pid: 'b', team: 0, hero: 'bullwark', bot: false, lane: 0 },
      { pid: 'r', team: 0, hero: 'reaver', bot: false, lane: 0 },
      { pid: 'x', team: 1, hero: 'longbow', bot: false, lane: 0 },
    ];
    const { w } = makeWorld(seats);
    const bull = heroByPid(w, 'b');
    const ally = heroByPid(w, 'r');
    w.spendSkillPoint(bull.id, 1); // bullwark_w: +3 armor to allies in 8m
    ally.x = bull.x + 3;
    ally.z = bull.z;
    const allyArmor = ally.armor;
    advance(w, 6); // crosses a 5-tick re-evaluation boundary
    expect(ally.armor).toBeCloseTo(allyArmor + 3, 9);
    // leaving the radius drops the aura at the next re-evaluation
    ally.x = bull.x + 40;
    advance(w, 7);
    expect(ally.armor).toBeCloseTo(allyArmor, 9);
  });
});

describe('movement', () => {
  it('steers straight at the order target and stops on arrival', () => {
    const { w } = makeWorld();
    const h = heroByPid(w, 'p0');
    h.x = 30;
    h.z = 30;
    w.order(h.id, { kind: 'move', x: 40, z: 30 });
    const perTick = h.moveSpeed * 0.05;
    w.advance();
    expect(h.x).toBeCloseTo(30 + perTick, 6);
    advance(w, 200);
    expect(h.x).toBeCloseTo(40, 6);
    expect(h.order).toBe('idle');
  });

  it('slides around structures instead of passing through them', () => {
    const { w } = makeWorld();
    const h = heroByPid(w, 'p0');
    const tower = must([...w.all()].find((e) => e.kind === 'tower' && e.team === 1));
    h.x = tower.x - 6;
    h.z = tower.z;
    w.order(h.id, { kind: 'move', x: tower.x + 6, z: tower.z });
    for (let i = 0; i < 300; i++) {
      w.advance();
      const d = Math.hypot(h.x - tower.x, h.z - tower.z);
      expect(d).toBeGreaterThanOrEqual(tower.radius + h.radius - 1e-6);
    }
    expect(Math.hypot(h.x - (tower.x + 6), h.z - tower.z)).toBeLessThan(2); // made it past
  });

  it('soft-separates overlapping mobiles', () => {
    const { w } = makeWorld();
    const a = must(w.get(w.spawnMobile('melee', 0, 30, 60, -1, 0, NO_ENT)));
    const b = must(w.get(w.spawnMobile('melee', 0, 30.1, 60, -1, 0, NO_ENT)));
    w.advance();
    const d = Math.hypot(a.x - b.x, a.z - b.z);
    expect(d).toBeGreaterThanOrEqual(a.radius + b.radius - 1e-6);
  });

  it('clamps orders to the map bounds', () => {
    const { w } = makeWorld();
    const map = buildMap(1);
    const h = heroByPid(w, 'p0');
    w.order(h.id, { kind: 'move', x: -50, z: -50 });
    w.advance();
    // Two separate steps, both observable here. The CLAMP puts the
    // destination back inside the map; without it the order would keep
    // (-50, -50) and the snap, which searches a bounded neighbourhood, would
    // have nothing near enough to find.
    expect(h.ox).toBeGreaterThanOrEqual(0);
    expect(h.oz).toBeGreaterThanOrEqual(0);
    expect(h.ox).toBeLessThanOrEqual(map.side);
    expect(h.oz).toBeLessThanOrEqual(map.side);
    // The SNAP then moves it off the cliff the clamped corner sits in
    // (AMENDMENT_1 §C), so the hero has somewhere it can actually stand.
    expect(h.ox === 0 && h.oz === 0).toBe(false);
    expect(isPassable(map.terrain, h.ox, h.oz)).toBe(true);
    // The clamp is asserted a second time somewhere the snap CANNOT stand in
    // for it. `nearestPassableCell` clamps into the grid on its own, so at the
    // cliff corner above a missing bounds clamp is invisible — the snap drags
    // the destination back inside anyway. (0, 95.5) is walkable, so the snap
    // is a no-op there and the coordinate that survives is the clamp's alone.
    expect(isPassable(map.terrain, 0, 95.5)).toBe(true);
    w.order(h.id, { kind: 'move', x: -100, z: 95.5 });
    w.advance();
    expect(h.ox).toBe(0);
    expect(h.oz).toBe(95.5);
    // and it walks all the way there and stops, rather than stalling on rock
    const dest = { x: h.ox, z: h.oz };
    advance(w, 600);
    expect(h.x).toBeCloseTo(dest.x, 6);
    expect(h.z).toBeCloseTo(dest.z, 6);
    expect(h.order).toBe('idle');
  });

  it('creeps follow their lane waypoints toward the enemy base', () => {
    const { w } = makeWorld();
    const map = buildMap(1);
    const c = must(w.get(w.spawnMobile('melee', 0, BASE_INSET + 3, BASE_INSET, 0, 0, NO_ENT)));
    expect(c.lane).toBe(0);
    const startX = c.x;
    advance(w, 120); // 6 s at 3.1 m/s ≈ 18 m down-lane
    const first = map.paths[0]?.[0];
    const mid = map.paths[0]?.[1];
    if (!first || !mid) throw new Error('path missing');
    const segLen = Math.hypot(mid.x - first.x, mid.z - first.z);
    const progressed = ((c.x - first.x) * (mid.x - first.x) + (c.z - first.z) * (mid.z - first.z)) / segLen;
    expect(progressed).toBeGreaterThan(10);
    expect(c.x).toBeGreaterThan(startX);
  });

  it('attack-move acquires an enemy within aggro radius and attacks it', () => {
    const { w } = makeWorld();
    const h = heroByPid(w, 'p0');
    h.x = 30;
    h.z = 60;
    const c = must(w.get(w.spawnMobile('melee', 1, 34, 60, -1, 0, NO_ENT)));
    w.order(h.id, { kind: 'attackmove', x: 60, z: 60 });
    advance(w, 3);
    expect(h.orderTarget).toBe(c.id);
    // in range already (reaver 1.8 + radii vs 4 m gap): swings begin
    advance(w, 25);
    expect(c.hp).toBeLessThan(c.maxHp);
  });
});

describe('neutral camps (AMENDMENT_2 §D)', () => {
  it('exposes one CampState per terrain clearing, in that exact order', () => {
    // §D.4. camps.ts indexes straight into this table by clearing id, so the
    // ordering is load-bearing, not incidental.
    const { w } = makeWorld();
    const defs = w.map.terrain.camps;
    expect(defs.length).toBeGreaterThan(0);
    expect(w.camps).toHaveLength(defs.length);
    w.camps.forEach((c, i) => {
      expect(c.id).toBe(i);
      expect(c.def).toBe(defs[i]); // the world's own def object, not a copy
    });
  });

  it('runs stepCamps inside advance(), after stepDeaths', () => {
    // AMENDMENT_1 §F held S_WORLD back from wiring step (7) until S_JUNGLE
    // landed, so nothing anywhere pinned that it eventually was: camps.test.ts
    // drives stepCamps directly and stays green with the call deleted.
    const { w } = makeWorld();
    expect(w.camps.every((c) => c.aliveCount === 0)).toBe(true);
    w.advance();
    expect(w.camps.every((c) => c.aliveCount > 0)).toBe(true); // the jungle stood up
    for (const c of w.camps) {
      for (const id of c.memberIds) {
        expect(must(w.get(id)).team).toBe(NEUTRAL_TEAM);
      }
    }
    // ORDERING (AMENDMENT_1 §A): step (7) runs AFTER stepDeaths, so a camp
    // emptied this tick stamps its respawn on the SAME tick. Run before it,
    // the members would still read `alive` and the clock would start a tick
    // late, every time, for every camp on the map.
    const camp = must(w.camps[0]);
    const h = heroByPid(w, 'p0');
    for (const id of camp.memberIds) w.damage(h.id, id, 999999, 'physical');
    const tickBefore = w.tick;
    w.advance();
    expect(camp.aliveCount).toBe(0);
    expect(camp.respawnAtTick).toBeGreaterThan(tickBefore);
  });

  it('spawns each camp kind with its own tuned radius and health', () => {
    // §D.2. `Ent.radius` is readonly and written once by makeEnt from the
    // tuning, so applyCampStats cannot correct it afterwards: without these
    // arms in mobileTuning() every member carries the 0.3 m fallback and a
    // brute's combat reach, separation and structure push-out are all out by
    // 0.4 m.
    const { w } = makeWorld();
    const cases: readonly [EntKind, CreepTuning][] = [
      ['campPack', CAMP_PACK],
      ['campBrute', CAMP_BRUTE],
      ['campHive', CAMP_HIVE],
    ];
    for (const [kind, tuning] of cases) {
      const e = must(w.get(w.spawnMobile(kind, NEUTRAL_TEAM, QUIET_SPOT.x, QUIET_SPOT.z, -1, 0, NO_ENT)));
      expect(e.radius).toBe(tuning.radius);
      expect(e.maxHp).toBe(tuning.hp);
      expect(e.hp).toBe(tuning.hp);
      expect(e.damage).toBe(tuning.damage);
      expect(e.attackRange).toBe(tuning.attackRange);
      expect(e.bounty).toBe(tuning.bounty);
      expect(e.xpValue).toBe(tuning.xp);
    }
    expect(new Set(cases.map(([, t]) => t.radius)).size).toBe(3); // the arms are distinguishable
  });

  it('gives a camp member no hp regen, so a wounded one stays wounded', () => {
    // §D.5 / AMENDMENT_1 §C. stepUnits' regen loop runs BEFORE its hero-only
    // gate, so a non-zero hpRegen here would passively heal camp members
    // mid-fight and quietly undo every poke a player lands on the jungle.
    const { w } = makeWorld();
    const e = must(
      w.get(w.spawnMobile('campBrute', NEUTRAL_TEAM, QUIET_SPOT.x, QUIET_SPOT.z, -1, 0, NO_ENT)),
    );
    expect(e.hpRegen).toBe(0);
    const wounded = e.maxHp / 2;
    e.hp = wounded;
    advance(w, 4 * TICK_RATE); // four seconds: any regen at all shows here
    expect(e.alive).toBe(true);
    expect(e.hpRegen).toBe(0);
    expect(e.hp).toBe(wounded); // not a metre of it healed, and nothing hit it
  });

  it('never seeds a lane waypoint onto a neutral, even asked for one', () => {
    // A lane polyline runs between the two PLAYER bases, so "the other end" is
    // undefined for a third team; a camp member that picked one up would march
    // down the lane. TERRAIN_CONTRACT §5 names this the most likely way the
    // jungle breaks, so the guard does not rely on every caller passing -1.
    const { w } = makeWorld();
    const onLane = must(w.get(w.spawnMobile('melee', 1, QUIET_SPOT.x, QUIET_SPOT.z, 0, 0, NO_ENT)));
    expect(onLane.waypoint).toBeGreaterThan(0); // team 1 walks the polyline reversed
    const neutral = must(
      w.get(w.spawnMobile('campPack', NEUTRAL_TEAM, QUIET_SPOT.x, QUIET_SPOT.z, 0, 0, NO_ENT)),
    );
    expect(neutral.waypoint).toBe(0);
  });

  it('gives every new mobile an initialised path, never undefined', () => {
    // §D.1. The frozen shape is `path: readonly Vec2[] | null` and
    // `pathIndex: number`; leaving them off made "not written yet" read as
    // `undefined` and forced every consumer in movement.ts and camps.ts to
    // coalesce.
    const { w } = makeWorld();
    const e = must(
      w.get(w.spawnMobile('campPack', NEUTRAL_TEAM, QUIET_SPOT.x, QUIET_SPOT.z, -1, 0, NO_ENT)),
    );
    expect(e.path).toBeNull();
    expect(e.pathIndex).toBe(0);
    const h = heroByPid(w, 'p0');
    expect(h.path === null || Array.isArray(h.path)).toBe(true);
    expect(typeof h.pathIndex).toBe('number');
  });
});

describe('end state', () => {
  it('advance() is a no-op once the match has ended', () => {
    const { w } = makeWorld();
    const anc1 = must([...w.all()].find((e) => e.kind === 'ancient' && e.team === 1));
    // murder the guards, then the ancient, via the mutation surface
    for (const g of [...w.all()].filter((e) => e.kind === 'guard' && e.team === 1)) {
      w.damage(heroByPid(w, 'p0').id, g.id, 99999, 'physical');
    }
    w.advance();
    w.damage(heroByPid(w, 'p0').id, anc1.id, 999999, 'physical');
    w.advance();
    const events = w.drainEvents();
    expect(events.some((e) => e.k === 'end' && e.winner === 0 && e.reason === 'ancient')).toBe(true);
    const tickAtEnd = w.tick;
    advance(w, 10);
    expect(w.tick).toBe(tickAtEnd);
  });
});
