// ============================================================================
// T3 — SIM CORE: units.ts tests. Wave spawner (first-wave timing, period,
// composition, siege cadence, compounding growth, overtime surge rules, lane
// assignment), respawn timing, fountain heal, level-ups via XP_THRESHOLDS,
// passive gold, expiry reaping (summons/wards/projs), shop buy validation
// (gold / fountain radius / first free slot / wardstone charge-stacking),
// spendSkillPoint rank caps + ULT_LEVEL_REQ, useItem spend-then-enqueue for
// dash/aura actives, and ward placement (charges + team stock + restock).
// The abilities engine is a recording double; abilities.ts is never imported.
// ============================================================================
import { describe, expect, it } from 'vitest';
import {
  CREEP_MELEE,
  FOUNTAIN_HEAL_PCT,
  FOUNTAIN_MANA_PCT,
  INVENTORY_SLOTS,
  ITEMS,
  OVERTIME_AT_S,
  PASSIVE_GOLD_PER_S,
  RESPAWN_BASE_S,
  RESPAWN_PER_LEVEL_S,
  STARTING_GOLD,
  SURGE_EXTRA_MELEE_PERIOD_S,
  SURGE_WAVE_GROWTH,
  TICK_DT,
  TICK_RATE,
  WARD_DURATION_S,
  WARD_RESTOCK_S,
  WARD_TEAM_STOCK,
  WAVE_FIRST_AT_S,
  WAVE_GROWTH,
  WAVE_MELEE,
  WAVE_PERIOD_S,
  WAVE_RANGED,
  buildMap,
} from '@rift/shared';
import { createWorld } from './world.js';
import { NO_ENT } from './types.js';
import type { AbilitiesEngine, Ent, QueuedCast, SeatDef, World } from './types.js';

class EngineDouble implements AbilitiesEngine {
  drained: QueuedCast[][] = [];
  step(world: World): void {
    this.drained.push(world.drainCasts().slice());
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

function hero(w: World, pid: string): Ent {
  for (const e of w.mobiles()) {
    if (e.kind === 'hero' && e.pid === pid) return e;
  }
  throw new Error(`no hero ${pid}`);
}

function mobilesOf(w: World, kind: Ent['kind'], team: 0 | 1): Ent[] {
  const out: Ent[] = [];
  for (const e of w.mobiles()) {
    if (e.kind === kind && e.team === team) out.push(e);
  }
  return out;
}

function advance(w: World, n: number): void {
  for (let i = 0; i < n; i++) w.advance();
}

/** Ticks to run from tick 0 until wave `k` (0-based) has spawned. */
const WAVE_TICK = (k: number): number =>
  Math.round(WAVE_FIRST_AT_S * TICK_RATE) + k * Math.round(WAVE_PERIOD_S * TICK_RATE);

describe('wave spawner', () => {
  it('spawns the first wave at WAVE_FIRST_AT_S, then every WAVE_PERIOD_S, both teams per lane', () => {
    const { w } = makeWorld();
    advance(w, WAVE_TICK(0) - 1);
    expect(mobilesOf(w, 'melee', 0)).toHaveLength(0); // not yet
    w.advance(); // first wave tick
    expect(mobilesOf(w, 'melee', 0)).toHaveLength(WAVE_MELEE);
    expect(mobilesOf(w, 'ranged', 0)).toHaveLength(WAVE_RANGED);
    expect(mobilesOf(w, 'melee', 1)).toHaveLength(WAVE_MELEE);
    expect(mobilesOf(w, 'ranged', 1)).toHaveLength(WAVE_RANGED);
    expect(mobilesOf(w, 'siege', 0)).toHaveLength(0); // no siege on wave 1
    // wave creeps carry their assigned lane
    for (const c of mobilesOf(w, 'melee', 0)) expect(c.lane).toBe(0);
    // no second wave until the period elapses
    const ids = new Set(mobilesOf(w, 'melee', 0).map((c) => c.id));
    advance(w, Math.round(WAVE_PERIOD_S * TICK_RATE) - 1);
    for (const c of mobilesOf(w, 'melee', 0)) expect(ids.has(c.id)).toBe(true);
    w.advance(); // wave 2 tick
    const wave2 = mobilesOf(w, 'melee', 0).filter((c) => !ids.has(c.id));
    expect(wave2.length).toBeGreaterThan(0);
  });

  it('scales creep hp and damage by (1 + WAVE_GROWTH)^waveIndex, compounding', () => {
    const { w } = makeWorld();
    advance(w, WAVE_TICK(0));
    const wave1 = must(mobilesOf(w, 'melee', 0)[0]);
    expect(wave1.maxHp).toBeCloseTo(CREEP_MELEE.hp, 6);
    expect(wave1.damage).toBeCloseTo(CREEP_MELEE.damage, 6);
    // kill the first wave so wave 2 is identifiable by freshness
    for (const c of [...mobilesOf(w, 'melee', 0), ...mobilesOf(w, 'ranged', 0)]) {
      w.damage(NO_ENT, c.id, 999999, 'physical');
    }
    for (const c of [...mobilesOf(w, 'melee', 1), ...mobilesOf(w, 'ranged', 1)]) {
      w.damage(NO_ENT, c.id, 999999, 'physical');
    }
    advance(w, WAVE_TICK(1) - WAVE_TICK(0));
    const wave2 = must(mobilesOf(w, 'melee', 0)[0]);
    expect(wave2.maxHp).toBeCloseTo(CREEP_MELEE.hp * (1 + WAVE_GROWTH), 6);
    expect(wave2.damage).toBeCloseTo(CREEP_MELEE.damage * (1 + WAVE_GROWTH), 6);
  });

  it('adds a siege creep every SIEGE_EVERY_NTH_WAVE-th wave', () => {
    const { w } = makeWorld();
    advance(w, WAVE_TICK(4)); // wave 5 (1-based) is the first siege wave
    expect(mobilesOf(w, 'siege', 0).length).toBeGreaterThanOrEqual(1);
    expect(mobilesOf(w, 'siege', 1).length).toBeGreaterThanOrEqual(1);
  });

  it('overtime switches to SURGE_WAVE_GROWTH, emits one surge event, and adds melee over time', () => {
    const { w } = makeWorld();
    // Every checkpoint below is DERIVED from the config, so balance retunes
    // (an earlier OVERTIME_AT_S, a longer SURGE_EXTRA_MELEE_PERIOD_S) cannot
    // stale this test. Wave index k (0-based) spawns at WAVE_TICK(k); the sim
    // adds floor((tick*TICK_DT - OVERTIME_AT_S) / SURGE_EXTRA_MELEE_PERIOD_S)
    // melee per wave in overtime — mirrored here with the same float ops.
    const extraMeleeAt = (k: number): number =>
      Math.floor((WAVE_TICK(k) * TICK_DT - OVERTIME_AT_S) / SURGE_EXTRA_MELEE_PERIOD_S);
    // first wave spawned strictly AFTER overtime begins (waves spawning exactly
    // at the boundary tick still use pre-overtime growth: stepUnits runs
    // before the overtime flip inside advance())
    const firstOt = Math.floor((OVERTIME_AT_S - WAVE_FIRST_AT_S) / WAVE_PERIOD_S) + 1;
    // first wave at least one full extra-melee period into overtime
    const surged = Math.ceil(
      (OVERTIME_AT_S + SURGE_EXTRA_MELEE_PERIOD_S - WAVE_FIRST_AT_S) / WAVE_PERIOD_S,
    );
    expect(surged).toBeGreaterThan(firstOt);
    const surgedExtra = extraMeleeAt(surged);
    expect(surgedExtra).toBeGreaterThanOrEqual(1);
    // The march to the surged wave spans many unmanaged waves; survivors push
    // lanes and would kill an ancient, ending the world (advance() no-ops
    // once ended) before the checkpoint. Top both ancients up — structure
    // damage is not what this test measures.
    const advanceSafely = (ticks: number): void => {
      for (let i = 0; i < ticks; i++) {
        for (const e of w.all()) {
          if (e.kind === 'ancient') e.hp = e.maxHp;
        }
        w.advance();
      }
    };
    advanceSafely(WAVE_TICK(firstOt));
    expect(w.overtime).toBe(true);
    const events = w.drainEvents();
    expect(events.filter((e) => e.k === 'surge')).toHaveLength(1);
    // clear every wave creep so the next waves are countable
    const clearCreeps = (): void => {
      for (const kind of ['melee', 'ranged', 'siege'] as const) {
        for (const c of [...mobilesOf(w, kind, 0), ...mobilesOf(w, kind, 1)]) {
          w.damage(NO_ENT, c.id, 1e9, 'physical');
        }
      }
      w.advance();
    };
    clearCreeps();
    const seen = new Set<number>();
    for (const e of w.mobiles()) seen.add(e.id);
    // first clean overtime wave: surge-growth hp, derived melee count
    const base = firstOt + 1;
    advanceSafely(WAVE_TICK(base) - w.tick);
    const baseWave = mobilesOf(w, 'melee', 0).filter((c) => !seen.has(c.id));
    expect(baseWave).toHaveLength(WAVE_MELEE + extraMeleeAt(base));
    expect(extraMeleeAt(base)).toBe(0); // scenario premise: < 1 OT period elapsed
    expect(baseWave[0]?.maxHp).toBeCloseTo(
      CREEP_MELEE.hp * Math.pow(1 + SURGE_WAVE_GROWTH, base),
      4,
    );
    clearCreeps();
    for (const e of w.mobiles()) seen.add(e.id);
    // one full extra-melee period into overtime: +surgedExtra melee per wave
    advanceSafely(WAVE_TICK(surged) - w.tick);
    const surgedWave = mobilesOf(w, 'melee', 0).filter((c) => !seen.has(c.id));
    expect(surgedWave).toHaveLength(WAVE_MELEE + surgedExtra);
  }, 20000);
});

describe('respawns + fountain', () => {
  it('respawns a dead hero at its fountain after RESPAWN_BASE_S + RESPAWN_PER_LEVEL_S * level', () => {
    const { w } = makeWorld();
    const p0 = hero(w, 'p0');
    p0.x = 40;
    p0.z = 60;
    w.advance(); // tick 1
    w.damage(NO_ENT, p0.id, 999999, 'physical');
    w.advance(); // tick 2: death processed here
    expect(p0.alive).toBe(false);
    expect(p0.deaths).toBe(1);
    const waitTicks = Math.round((RESPAWN_BASE_S + RESPAWN_PER_LEVEL_S * 1) * TICK_RATE);
    advance(w, waitTicks - 1);
    expect(p0.alive).toBe(false); // one tick early
    w.advance();
    expect(p0.alive).toBe(true);
    expect(p0.hp).toBe(p0.maxHp);
    expect(p0.mana).toBe(p0.maxMana);
    const map = buildMap(1);
    const anc = must(map.structures.find((s) => s.kind === 'ancient' && s.team === 0));
    expect(Math.hypot(p0.x - anc.x, p0.z - anc.z)).toBeLessThan(6);
  });

  it('heals hp and mana by a fraction of max per second inside the fountain only', () => {
    const { w } = makeWorld();
    const p0 = hero(w, 'p0');
    const p1 = hero(w, 'p1');
    p0.hp = p0.maxHp / 2;
    p0.mana = 0;
    // p1 starts at its own fountain too; move it far away as the control
    p1.hp = p1.maxHp / 2;
    p1.x = 40;
    p1.z = 60;
    const p1Regen = p1.hpRegen;
    advance(w, TICK_RATE); // exactly one second
    const healed = p0.hp - p0.maxHp / 2;
    const expected =
      (p0.maxHp * FOUNTAIN_HEAL_PCT + p0.hpRegen) * (TICK_RATE * TICK_DT);
    expect(healed).toBeCloseTo(expected, 4);
    expect(p0.mana).toBeCloseTo(
      (p0.maxMana * FOUNTAIN_MANA_PCT + p0.manaRegen) * (TICK_RATE * TICK_DT),
      4,
    );
    // away from the fountain: base regen only
    expect(p1.hp - p1.maxHp / 2).toBeCloseTo(p1Regen * (TICK_RATE * TICK_DT), 4);
  });

  it('pays passive gold from match start, living or dead', () => {
    const { w } = makeWorld();
    const p0 = hero(w, 'p0');
    const g0 = p0.gold;
    advance(w, 100);
    expect(p0.gold - g0).toBeCloseTo(100 * PASSIVE_GOLD_PER_S * TICK_DT, 6);
    expect(p0.goldEarned).toBeCloseTo(p0.gold - STARTING_GOLD, 6);
  });
});

describe('level-ups', () => {
  it('levels via XP_THRESHOLDS, grants a skill point, grows base stats, heals the gain', () => {
    const { w } = makeWorld();
    const p0 = hero(w, 'p0');
    p0.x = 20;
    p0.z = 60;
    p0.xp = 199; // one creep short of level 2 (threshold 200)
    const creep = must(w.get(w.spawnMobile('melee', 1, 21, 60, -1, 0, NO_ENT)));
    w.stun(creep.id, 600); // target dummy
    w.order(p0.id, { kind: 'attack', target: creep.id });
    let guard = 0;
    while (creep.alive && guard < 600) {
      w.advance();
      guard += 1;
    }
    expect(creep.alive).toBe(false);
    expect(p0.xp).toBeCloseTo(199 + CREEP_MELEE.xp, 6); // sole hero in radius
    expect(p0.level).toBe(2);
    expect(p0.skillPoints).toBe(2); // 1 starting + 1 per level
    // reaver growth: +78 hp, +12 mana, +6 damage
    expect(p0.maxHp).toBeCloseTo(640 + 78, 6);
    expect(p0.maxMana).toBeCloseTo(220 + 12, 6);
    expect(p0.damage).toBeCloseTo(58 + 6, 6);
    expect(p0.hp).toBe(p0.maxHp); // untouched dummy: level-up heal tops off
  });
});

describe('shop (buy)', () => {
  it('validates gold, fountain radius, and fills the first free slot', () => {
    const { w } = makeWorld();
    const p0 = hero(w, 'p0'); // at its fountain, STARTING_GOLD
    // too expensive: silent no-op
    w.buy(p0.id, 'aegisheart'); // 900 > 600
    expect(p0.gold).toBe(STARTING_GOLD);
    expect(p0.items.every((i) => i === null)).toBe(true);
    // legal buy: spends gold, fills slot 0, applies stats
    w.buy(p0.id, 'bladestone'); // 400, +12 damage
    expect(p0.gold).toBe(STARTING_GOLD - 400);
    expect(p0.items[0]).toBe('bladestone');
    expect(p0.damage).toBeCloseTo(58 + 12, 6);
    // away from the fountain: silent no-op even with gold
    p0.gold = 5000;
    const fx = p0.x;
    const fz = p0.z;
    p0.x = 40;
    p0.z = 60;
    w.buy(p0.id, 'warmail');
    expect(p0.gold).toBe(5000);
    expect(p0.items[1]).toBeNull();
    // back at the fountain the same buy lands in the next free slot
    p0.x = fx;
    p0.z = fz;
    w.buy(p0.id, 'warmail');
    expect(p0.gold).toBe(5000 - 450);
    expect(p0.items[1]).toBe('warmail');
  });

  it('silently no-ops on a full inventory', () => {
    const { w } = makeWorld();
    const p0 = hero(w, 'p0');
    p0.gold = 100000;
    const buys = ['bladestone', 'warmail', 'plategirdle', 'swiftboots', 'manacharm', 'fang'] as const;
    for (const item of buys) w.buy(p0.id, item);
    expect(p0.items.filter((i) => i !== null)).toHaveLength(INVENTORY_SLOTS);
    const gold = p0.gold;
    w.buy(p0.id, 'stormbow');
    expect(p0.gold).toBe(gold);
    expect(p0.items).not.toContain('stormbow');
  });

  it('stacks wardstone charges into the existing wardstone slot', () => {
    const { w } = makeWorld();
    const p0 = hero(w, 'p0');
    w.buy(p0.id, 'wardstone'); // 150, 2 charges
    w.buy(p0.id, 'wardstone'); // stacks: same slot, 4 charges
    expect(p0.gold).toBe(STARTING_GOLD - 300);
    expect(p0.items[0]).toBe('wardstone');
    expect(p0.itemCharges[0]).toBe(4);
    expect(p0.items[1]).toBeNull(); // no second slot consumed
  });
});

describe('skill points', () => {
  it('enforces rank caps, point availability, and ULT_LEVEL_REQ', () => {
    const { w } = makeWorld();
    const p0 = hero(w, 'p0');
    // starting point: one rank, then points run out
    w.spendSkillPoint(p0.id, 0);
    expect(p0.abilityRanks[0]).toBe(1);
    w.spendSkillPoint(p0.id, 0); // 0 points left: no-op
    expect(p0.abilityRanks[0]).toBe(1);
    // invalid slots: no-op
    w.spendSkillPoint(p0.id, 4);
    w.spendSkillPoint(p0.id, -1);
    // basic rank cap 4 (rank already 1 from the first spend above)
    p0.skillPoints = 10;
    for (let i = 0; i < 5; i++) w.spendSkillPoint(p0.id, 0);
    expect(p0.abilityRanks[0]).toBe(4);
    expect(p0.skillPoints).toBe(7); // 3 accepted, the last 2 rejected
    // ult: needs level 6 for rank 1, level 10 for rank 2
    w.spendSkillPoint(p0.id, 3);
    expect(p0.abilityRanks[3]).toBe(0); // level 2 < 6
    p0.level = 6;
    w.spendSkillPoint(p0.id, 3);
    expect(p0.abilityRanks[3]).toBe(1);
    p0.level = 9;
    w.spendSkillPoint(p0.id, 3);
    expect(p0.abilityRanks[3]).toBe(1); // needs 10
    p0.level = 10;
    w.spendSkillPoint(p0.id, 3);
    expect(p0.abilityRanks[3]).toBe(2);
    w.spendSkillPoint(p0.id, 3); // ult maxRank 2
    expect(p0.skillPoints).toBe(5);
  });
});

describe('useItem', () => {
  it('dash actives validate + spend, then enqueue a {kind:item} cast for the engine', () => {
    const { w, engine } = makeWorld();
    const p0 = hero(w, 'p0');
    p0.gold = 5000;
    w.buy(p0.id, 'blinkstone');
    const slot = p0.items.indexOf('blinkstone');
    // missing coordinates: rejected, nothing spent, nothing queued
    w.useItem(p0.id, slot, null, null);
    expect(p0.itemCdUntilTick[slot]).toBe(0);
    w.advance();
    expect(engine.drained[engine.drained.length - 1]).toHaveLength(0);
    // legal use: cooldown spent immediately, cast queued for the engine;
    // the world itself does NOT move the hero (that is the engine's job)
    const cd = ITEMS.blinkstone.active;
    if (!cd || cd.kind !== 'dash') throw new Error('blinkstone shape');
    const x = p0.x + 5;
    const z = p0.z;
    w.useItem(p0.id, slot, x, z);
    expect(p0.itemCdUntilTick[slot]).toBe(w.tick + Math.round(cd.cooldown * TICK_RATE));
    w.advance();
    const q = must(engine.drained[engine.drained.length - 1]);
    expect(q).toEqual([{ kind: 'item', hero: p0.id, slot, x, z }]);
    expect(Math.hypot(p0.x - x, p0.z - z)).toBeGreaterThan(1); // no dash yet
    // on cooldown: second use is a silent no-op
    w.useItem(p0.id, slot, x, z);
    w.advance();
    expect(engine.drained[engine.drained.length - 1]).toHaveLength(0);
    // after the cooldown it fires again
    advance(w, Math.round(cd.cooldown * TICK_RATE));
    w.useItem(p0.id, slot, x, z);
    w.advance();
    expect(engine.drained[engine.drained.length - 1]).toHaveLength(1);
  });

  it('aura actives enqueue without coordinates; passive items never do', () => {
    const { w, engine } = makeWorld();
    const p0 = hero(w, 'p0');
    p0.gold = 5000;
    w.buy(p0.id, 'warhorn');
    const slot = p0.items.indexOf('warhorn');
    w.useItem(p0.id, slot, null, null);
    w.advance();
    expect(engine.drained[engine.drained.length - 1]).toEqual([
      { kind: 'item', hero: p0.id, slot, x: null, z: null },
    ]);
    // bladestone has no active: nothing queued, ever
    w.buy(p0.id, 'bladestone');
    const passive = p0.items.indexOf('bladestone');
    w.useItem(p0.id, passive, 1, 1);
    // bad slots / empty slots: silent no-op
    w.useItem(p0.id, 5, 1, 1); // empty slot
    w.useItem(p0.id, 99, 1, 1); // out of range
    w.advance();
    expect(engine.drained[engine.drained.length - 1]).toHaveLength(0);
  });
});

describe('wards', () => {
  it('places a ward for 1 charge + 1 team stock, clears the slot at 0 charges', () => {
    const { w, engine } = makeWorld();
    const p0 = hero(w, 'p0');
    w.buy(p0.id, 'wardstone');
    const slot = p0.items.indexOf('wardstone');
    const stock0 = w.wardStock(0);
    expect(stock0).toBe(WARD_TEAM_STOCK);
    const wx = p0.x + 3;
    const wz = p0.z;
    w.useItem(p0.id, slot, wx, wz);
    expect(p0.itemCharges[slot]).toBe(1);
    expect(w.wardStock(0)).toBe(stock0 - 1);
    // the ward exists immediately, owned by the hero, expiring on schedule —
    // and never enters the cast queue
    const ward = mobilesOf(w, 'ward', 0)[0];
    expect(ward).toBeDefined();
    expect(must(ward).x).toBeCloseTo(wx, 9);
    expect(must(ward).owner).toBe(p0.id);
    expect(must(ward).expireAtTick).toBe(
      w.tick + Math.round(WARD_DURATION_S * TICK_RATE),
    );
    w.advance();
    expect(engine.drained[engine.drained.length - 1]).toHaveLength(0);
    // second charge: slot clears
    w.useItem(p0.id, slot, wx, wz);
    expect(p0.items[slot]).toBeNull();
    expect(w.wardStock(0)).toBe(stock0 - 2);
  });

  it('rejects placement at 0 team stock, at 0 charges, and beyond WARD_PLACE_RANGE', () => {
    const { w } = makeWorld();
    const p0 = hero(w, 'p0');
    w.buy(p0.id, 'wardstone');
    const slot = p0.items.indexOf('wardstone');
    // too far: no spend
    w.useItem(p0.id, slot, p0.x + 50, p0.z);
    expect(p0.itemCharges[slot]).toBe(2);
    expect(w.wardStock(0)).toBe(WARD_TEAM_STOCK);
    // burn both charges, restock the item, drain the team stock to 0 via the
    // OTHER team's... no — drain own stock with two legal placements
    w.useItem(p0.id, slot, p0.x + 2, p0.z);
    w.useItem(p0.id, slot, p0.x + 2, p0.z);
    expect(w.wardStock(0)).toBe(0);
    // fresh charges, but 0 team stock: silent no-op, charge NOT consumed
    w.buy(p0.id, 'wardstone');
    const slot2 = p0.items.indexOf('wardstone');
    expect(p0.itemCharges[slot2]).toBe(2);
    w.useItem(p0.id, slot2, p0.x + 2, p0.z);
    expect(p0.itemCharges[slot2]).toBe(2);
    expect(mobilesOf(w, 'ward', 0)).toHaveLength(2);
  });

  it('restocks +1 team stock per WARD_RESTOCK_S up to WARD_TEAM_STOCK', () => {
    const { w } = makeWorld();
    const p0 = hero(w, 'p0');
    w.buy(p0.id, 'wardstone');
    const slot = p0.items.indexOf('wardstone');
    w.useItem(p0.id, slot, p0.x + 2, p0.z);
    w.useItem(p0.id, slot, p0.x + 2, p0.z);
    expect(w.wardStock(0)).toBe(0);
    advance(w, Math.round(WARD_RESTOCK_S * TICK_RATE));
    expect(w.wardStock(0)).toBe(1);
    advance(w, Math.round(WARD_RESTOCK_S * TICK_RATE));
    expect(w.wardStock(0)).toBe(WARD_TEAM_STOCK);
    advance(w, Math.round(WARD_RESTOCK_S * TICK_RATE));
    expect(w.wardStock(0)).toBe(WARD_TEAM_STOCK); // capped
  });
});

describe('expiry (advance step 7)', () => {
  it('reaps ALL expired mobiles — summons, wards, and projs alike', () => {
    const { w } = makeWorld();
    const shade = w.spawnMobile('shade', 0, 30, 60, -1, w.tick + 2, NO_ENT);
    const proj = w.spawnMobile('proj', 0, 30, 60, -1, w.tick + 1, NO_ENT);
    const ward = w.spawnMobile('ward', 1, 30, 60, -1, w.tick + 3, NO_ENT);
    w.advance();
    expect(w.get(proj)).toBeUndefined(); // proj reaped first
    expect(w.get(shade)).toBeDefined();
    w.advance();
    expect(w.get(shade)).toBeUndefined();
    expect(w.get(ward)).toBeDefined();
    w.advance();
    expect(w.get(ward)).toBeUndefined();
  });

  it('never expires heroes, and expiry pays no bounty', () => {
    const { w } = makeWorld();
    const p0 = hero(w, 'p0');
    p0.expireAtTick = w.tick + 1; // heroes are exempt from the reaper
    const gold = p0.gold;
    const shade = w.spawnMobile('shade', 1, 30, 60, -1, w.tick + 1, NO_ENT);
    void shade;
    w.advance();
    expect(p0.alive).toBe(true);
    expect(w.get(p0.id)).toBeDefined();
    expect(p0.gold - gold).toBeCloseTo(PASSIVE_GOLD_PER_S * TICK_DT, 9);
  });
});
