// ============================================================================
// T3 — SIM CORE: camps.ts tests (TERRAIN_CONTRACT §5, DESIGN_DELTA §2).
//
// Covers the whole camp lifecycle against a REAL SimWorld and the REAL
// stepDeaths: the terrain's camp table (2/3/4 per half at 1/2/3 lanes, mirrored
// exactly), spawn composition and statlines, the neutral spawn recipe
// (NEUTRAL_TEAM / lane -1 / no owner / no path), aggro by proximity and by
// damage, the leash — including the hard positional cap that is what stops a
// camp being dragged into a lane — the full-hp reset and damager wipe on
// arrival, death and the per-tier respawn clock, and bit-identical replays.
//
// Two deliberate fixtures, both documented where they are defined:
//   * `ensureCampTable` builds `World.camps` when SimWorld does not yet own it
//     (S_WORLD, wave 2, populates it at construction). The table it builds is
//     exactly the one that task specifies, so this suite tests the real world
//     object rather than a fake of it.
//   * `moveCamps` stands in for movement.ts's camp branch (S_MOVE owns the real
//     one). camps.ts writes intent — `order`/`ox`/`oz`/`orderTarget` — and never
//     moves anything itself, so a mover is needed to exercise the leash.
// ============================================================================
import { describe, expect, it } from 'vitest';
import {
  AGGRO_RADIUS,
  CAMPS_PER_HALF,
  CAMP_BRUTE,
  CAMP_BRUTE_COUNT,
  CAMP_BRUTE_RESPAWN_S,
  CAMP_HIVE,
  CAMP_HIVE_COUNT,
  CAMP_HIVE_RESPAWN_S,
  CAMP_LEASH_RADIUS,
  CAMP_PACK,
  CAMP_PACK_COUNT,
  CAMP_PACK_RESPAWN_S,
  NEUTRAL_TEAM,
  TICK_DT,
  TICK_RATE,
  buildMap,
} from '@rift/shared';
import type { CampDef, CreepTuning, EntKind, MapDef } from '@rift/shared';
import { SimWorld } from './world.js';
import { stepDeaths } from './combat.js';
import { spawnCamp, stepCamps } from './camps.js';
import { NO_ENT } from './types.js';
import type { AbilitiesEngine, CampState, Ent, EntId, QueuedCast, SeatDef, World } from './types.js';

type CampTier = CampDef['tier'];

const TIER_TUNING: Record<CampTier, CreepTuning> = {
  pack: CAMP_PACK,
  brute: CAMP_BRUTE,
  hive: CAMP_HIVE,
};
const TIER_COUNT: Record<CampTier, number> = {
  pack: CAMP_PACK_COUNT,
  brute: CAMP_BRUTE_COUNT,
  hive: CAMP_HIVE_COUNT,
};
const TIER_KIND: Record<CampTier, EntKind> = {
  pack: 'campPack',
  brute: 'campBrute',
  hive: 'campHive',
};
const TIER_RESPAWN_TICKS: Record<CampTier, number> = {
  pack: Math.round(CAMP_PACK_RESPAWN_S * TICK_RATE),
  brute: Math.round(CAMP_BRUTE_RESPAWN_S * TICK_RATE),
  hive: Math.round(CAMP_HIVE_RESPAWN_S * TICK_RATE),
};

/** The abilities engine is injected, never imported: it only has to drain. */
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

/** S_WORLD (wave 2) constructs `readonly camps: CampState[]` from
 *  `map.terrain.camps` — one entry per CampDef, `memberIds` empty, `aliveCount`
 *  0 and `respawnAtTick` 0 so the first stepCamps stands the jungle up. Until
 *  that lands, build the identical table here; once it lands this returns
 *  immediately and the suite runs against the world's own table. */
function ensureCampTable(w: SimWorld, map: MapDef): void {
  const host = w as unknown as { camps?: CampState[] };
  const defs = map.terrain.camps;
  const existing = host.camps;
  if (Array.isArray(existing) && existing.length === defs.length) return;
  host.camps = defs.map((def) => ({
    id: def.id,
    def,
    memberIds: [],
    aliveCount: 0,
    respawnAtTick: 0,
  }));
}

function campsOf(w: SimWorld): CampState[] {
  return (w as unknown as { camps: CampState[] }).camps;
}

function makeWorld(lanes = 2, seats: SeatDef[] = SEATS): SimWorld {
  const map = buildMap(lanes);
  const w = new SimWorld(map, seats, new EngineDouble());
  ensureCampTable(w, map);
  return w;
}

function must<T>(v: T | undefined): T {
  if (v === undefined) throw new Error('expected value to exist');
  return v;
}

function ent(w: SimWorld, id: EntId): Ent {
  return must(w.get(id));
}

/** One tick of the two advance() steps that matter here, in advance()'s order:
 *  tick, then deaths (6), then camps (7). */
function tickCamps(w: SimWorld): void {
  w.tick += 1;
  stepDeaths(w);
  stepCamps(w);
}

/** Stand-in for movement.ts's camp branch: walk every living camp member one
 *  tick toward its intent (its victim if it has one, else its order
 *  destination) at its own speed, snapping on arrival exactly as steer() does. */
function moveCamps(w: SimWorld): void {
  for (const c of campsOf(w)) {
    for (const id of c.memberIds) {
      const e = w.get(id);
      if (!e || !e.alive) continue;
      let tx = e.ox;
      let tz = e.oz;
      if (e.order === 'attack' && e.orderTarget !== NO_ENT) {
        const t = w.get(e.orderTarget);
        if (t) {
          tx = t.x;
          tz = t.z;
        }
      }
      if (e.order === 'idle') continue;
      const dx = tx - e.x;
      const dz = tz - e.z;
      const d = Math.hypot(dx, dz);
      const step = e.moveSpeed * TICK_DT;
      if (d <= step) {
        e.x = tx;
        e.z = tz;
        continue;
      }
      e.x += (dx / d) * step;
      e.z += (dz / d) * step;
    }
  }
}

function distTo(e: Ent, x: number, z: number): number {
  return Math.hypot(e.x - x, e.z - z);
}

/** A compact, order-stable digest of everything camps.ts owns. */
function digest(w: SimWorld): string {
  const parts: string[] = [];
  for (const c of campsOf(w)) {
    parts.push(`c${c.id}:${c.aliveCount}:${c.respawnAtTick}`);
    for (const id of c.memberIds) {
      const e = w.get(id);
      if (!e) {
        parts.push(`  ${id}:gone`);
        continue;
      }
      parts.push(
        `  ${id}:${e.kind}:${e.alive ? 1 : 0}:${e.hp.toFixed(6)}:${e.x.toFixed(6)}:` +
          `${e.z.toFixed(6)}:${e.order}:${e.orderTarget}`,
      );
    }
  }
  return parts.join('\n');
}

// --- the terrain's camp table ------------------------------------------------

describe('camp placement (DESIGN_DELTA §2)', () => {
  it('gives each half 2/3/4 camps at 1/2/3 lanes', () => {
    for (const lanes of [1, 2, 3]) {
      const map = buildMap(lanes);
      const perHalf = must(CAMPS_PER_HALF[lanes]);
      const camps = map.terrain.camps;
      expect(camps.length).toBe(perHalf * 2);
      expect(camps.filter((c) => c.half === 0).length).toBe(perHalf);
      expect(camps.filter((c) => c.half === 1).length).toBe(perHalf);
    }
  });

  it('mirrors every camp through the map centre, tier for tier', () => {
    for (const lanes of [1, 2, 3]) {
      const map = buildMap(lanes);
      for (const c of map.terrain.camps) {
        const mx = map.side - c.x;
        const mz = map.side - c.z;
        const twin = map.terrain.camps.find(
          (o) => o.id !== c.id && Math.abs(o.x - mx) < 1e-9 && Math.abs(o.z - mz) < 1e-9,
        );
        expect(twin, `camp ${c.id} at (${c.x}, ${c.z}) has no mirror`).toBeDefined();
        expect(must(twin).tier).toBe(c.tier);
        expect(must(twin).half).not.toBe(c.half);
      }
    }
  });

  it('ids are dense from 0 and match the camp table index', () => {
    const w = makeWorld(3);
    const camps = campsOf(w);
    camps.forEach((c, i) => {
      expect(c.id).toBe(i);
      expect(c.def.id).toBe(i);
    });
  });
});

// --- spawn -------------------------------------------------------------------

describe('spawn', () => {
  it('stands every camp up on the first step, whole and at full hp', () => {
    const w = makeWorld(3);
    tickCamps(w);
    for (const c of campsOf(w)) {
      const tuning = must(TIER_TUNING[c.def.tier]);
      const count = must(TIER_COUNT[c.def.tier]);
      expect(c.aliveCount).toBe(count);
      expect(c.memberIds.length).toBe(count);
      expect(c.respawnAtTick).toBe(-1); // -1 is the only "up" encoding
      for (const id of c.memberIds) {
        const e = ent(w, id);
        expect(e.alive).toBe(true);
        expect(e.kind).toBe(TIER_KIND[c.def.tier]);
        expect(e.hp).toBe(tuning.hp);
        expect(e.maxHp).toBe(tuning.hp);
        expect(e.damage).toBe(tuning.damage);
        expect(e.armor).toBe(tuning.armor);
        expect(e.attackPeriod).toBe(tuning.attackPeriod);
        expect(e.attackRange).toBe(tuning.attackRange);
        expect(e.moveSpeed).toBe(tuning.moveSpeed);
        expect(e.vision).toBe(tuning.vision);
        expect(e.bounty).toBe(tuning.bounty);
        expect(e.xpValue).toBe(tuning.xp);
      }
    }
  });

  it('spawns neutrals that can never become lane creeps', () => {
    const w = makeWorld(2);
    tickCamps(w);
    for (const c of campsOf(w)) {
      for (const id of c.memberIds) {
        const e = ent(w, id);
        expect(e.team).toBe(NEUTRAL_TEAM);
        expect(e.lane).toBe(-1);
        expect(e.waypoint).toBe(0);
        expect(e.owner).toBe(NO_ENT);
        expect(e.path).toBeNull();
        expect(e.pathIndex).toBe(0);
      }
    }
  });

  it('parks members on their clearing, idle, well inside the leash', () => {
    const w = makeWorld(3);
    tickCamps(w);
    tickCamps(w);
    for (const c of campsOf(w)) {
      for (const id of c.memberIds) {
        const e = ent(w, id);
        expect(e.order).toBe('idle');
        expect(e.orderTarget).toBe(NO_ENT);
        // The CAMP_LANE_CLEARANCE derivation assumes a resting member sits
        // within ~2 m of the clearing centre; hold it to that.
        expect(distTo(e, c.def.x, c.def.z)).toBeLessThanOrEqual(2);
      }
    }
  });

  it('survives stat recomputation — the base table is stamped too', () => {
    const w = makeWorld(2);
    tickCamps(w);
    const c = must(campsOf(w)[0]);
    const tuning = must(TIER_TUNING[c.def.tier]);
    const e = ent(w, must(c.memberIds[0]));
    w.recomputeEnt(e); // advance() step (3) runs this every tick, for everyone
    expect(e.maxHp).toBe(tuning.hp);
    expect(e.damage).toBe(tuning.damage);
    expect(e.armor).toBe(tuning.armor);
    expect(e.moveSpeed).toBe(tuning.moveSpeed);
    expect(e.attackRange).toBe(tuning.attackRange);
  });

  it('spawnCamp is idempotent in shape: a manual respawn replaces the generation', () => {
    const w = makeWorld(2);
    tickCamps(w);
    const c = must(campsOf(w)[1]);
    const first = [...c.memberIds];
    spawnCamp(w, c);
    expect(c.memberIds.length).toBe(must(TIER_COUNT[c.def.tier]));
    expect(c.aliveCount).toBe(c.memberIds.length);
    expect(c.respawnAtTick).toBe(-1);
    for (const id of c.memberIds) expect(first).not.toContain(id);
  });
});

// --- aggro -------------------------------------------------------------------

describe('aggro', () => {
  it('acquires an enemy that walks into the clearing', () => {
    const w = makeWorld(2);
    tickCamps(w);
    const c = must(campsOf(w)[0]);
    const bait = w.spawnMobile('melee', 0, c.def.x + 1, c.def.z, -1, 0, NO_ENT);
    tickCamps(w);
    for (const id of c.memberIds) {
      const e = ent(w, id);
      expect(e.order).toBe('attack');
      expect(e.orderTarget).toBe(bait);
    }
  });

  it('acquires a damager from outside the aggro radius — the pull', () => {
    const w = makeWorld(2);
    tickCamps(w);
    const c = must(campsOf(w)[0]);
    const sniper = w.spawnMobile(
      'ranged',
      1,
      c.def.x + AGGRO_RADIUS + 6,
      c.def.z,
      -1,
      0,
      NO_ENT,
    );
    const victim = must(c.memberIds[0]);
    w.damage(sniper, victim, 20, 'physical');
    tickCamps(w);
    const e = ent(w, victim);
    expect(e.order).toBe('attack');
    expect(e.orderTarget).toBe(sniper);
    // Untouched members stayed home: nothing came inside AGGRO_RADIUS.
    for (const id of c.memberIds) {
      if (id === victim) continue;
      expect(ent(w, id).order).toBe('idle');
    }
  });

  it('never acquires a ward, and never acquires another neutral', () => {
    const w = makeWorld(2);
    tickCamps(w);
    const c = must(campsOf(w)[0]);
    w.spawnMobile('ward', 0, c.def.x, c.def.z, -1, 0, NO_ENT);
    tickCamps(w);
    for (const id of c.memberIds) {
      const e = ent(w, id);
      expect(e.order).toBe('idle');
      expect(e.orderTarget).toBe(NO_ENT);
    }
  });
});

// --- leash -------------------------------------------------------------------

describe('leash', () => {
  it('resets a dragged member: full hp, no damagers, no target', () => {
    const w = makeWorld(2);
    tickCamps(w);
    const c = must(campsOf(w)[0]);
    const bait = w.spawnMobile('melee', 0, c.def.x + 1, c.def.z, -1, 0, NO_ENT);
    const id = must(c.memberIds[0]);
    const e = ent(w, id);
    w.damage(bait, id, 60, 'physical');
    w.noteDamager(e, bait);
    tickCamps(w);
    expect(e.order).toBe('attack');
    expect(e.hp).toBeLessThan(e.maxHp);
    expect(e.recentDamagers.length).toBe(1);

    // Dragged past the leash: clamped back onto the circle and sent home, but
    // NOT yet healed — the restore lands on arrival.
    e.x = c.def.x + CAMP_LEASH_RADIUS + 4;
    e.z = c.def.z;
    tickCamps(w);
    expect(distTo(e, c.def.x, c.def.z)).toBeCloseTo(CAMP_LEASH_RADIUS, 9);
    expect(e.order).toBe('move');
    expect(e.orderTarget).toBe(NO_ENT);
    expect(e.lastHitBy).toBe(NO_ENT);
    expect(e.recentDamagers.length).toBe(0);
    expect(e.hp).toBeLessThan(e.maxHp);

    // Walk it home the way movement.ts will.
    while (e.order === 'move' && distTo(e, e.ox, e.oz) > 1e-9) {
      moveCamps(w);
      tickCamps(w);
    }
    expect(e.hp).toBe(e.maxHp);
    expect(e.order).toBe('idle');
    expect(e.lastHitBy).toBe(NO_ENT);
    expect(e.recentDamagers.length).toBe(0);
  });

  it('does not re-acquire while walking home', () => {
    const w = makeWorld(2);
    tickCamps(w);
    const c = must(campsOf(w)[0]);
    const id = must(c.memberIds[0]);
    const e = ent(w, id);
    e.x = c.def.x + CAMP_LEASH_RADIUS + 1;
    e.z = c.def.z;
    tickCamps(w);
    expect(e.order).toBe('move');
    // An enemy parks right on top of the leashing member; it is ignored.
    w.spawnMobile('melee', 0, e.x, e.z, -1, 0, NO_ENT);
    tickCamps(w);
    expect(e.order).toBe('move');
    expect(e.orderTarget).toBe(NO_ENT);
  });

  it('never lets a member leave the leash radius, and always brings it home', () => {
    const w = makeWorld(3);
    tickCamps(w);
    const c = must(campsOf(w)[0]);
    const baitId = w.spawnMobile('melee', 0, c.def.x + 1, c.def.z, -1, 0, NO_ENT);
    const bait = ent(w, baitId);
    tickCamps(w); // camp aggroes the bait

    // The bait sprints away in a straight line, faster than any camp creep.
    for (let i = 0; i < 400; i++) {
      bait.x = Math.min(w.map.side, bait.x + 0.4);
      moveCamps(w);
      tickCamps(w);
      for (const id of c.memberIds) {
        const e = w.get(id);
        if (!e) continue;
        expect(distTo(e, c.def.x, c.def.z)).toBeLessThanOrEqual(CAMP_LEASH_RADIUS + 1e-9);
      }
    }
    for (const id of c.memberIds) {
      const e = ent(w, id);
      expect(e.order).toBe('idle');
      expect(e.hp).toBe(e.maxHp);
      expect(distTo(e, c.def.x, c.def.z)).toBeLessThanOrEqual(2);
    }
  });
});

// --- death and respawn -------------------------------------------------------

describe('death and respawn', () => {
  it('stamps the tier respawn clock when the last member dies', () => {
    const w = makeWorld(3);
    tickCamps(w);
    for (const c of campsOf(w)) {
      for (const id of c.memberIds) ent(w, id).hp = 0;
    }
    tickCamps(w);
    for (const c of campsOf(w)) {
      expect(c.aliveCount).toBe(0);
      expect(c.respawnAtTick).toBe(w.tick + must(TIER_RESPAWN_TICKS[c.def.tier]));
    }
  });

  it('keeps the camp up while one member lives', () => {
    const w = makeWorld(2);
    tickCamps(w);
    const c = must(campsOf(w)[0]);
    const survivor = must(c.memberIds[0]);
    for (const id of c.memberIds) {
      if (id !== survivor) ent(w, id).hp = 0;
    }
    tickCamps(w);
    expect(c.aliveCount).toBe(1);
    expect(c.respawnAtTick).toBe(-1);
  });

  it('respawns whole, at full hp, with fresh ids, exactly on the clock', () => {
    const w = makeWorld(2);
    tickCamps(w);
    const c = must(campsOf(w)[0]);
    const tuning = must(TIER_TUNING[c.def.tier]);
    const oldIds = [...c.memberIds];
    for (const id of oldIds) ent(w, id).hp = 0;
    tickCamps(w);
    const at = c.respawnAtTick;
    expect(at).toBeGreaterThan(w.tick);

    w.tick = at - 1;
    stepCamps(w);
    expect(c.aliveCount).toBe(0);
    expect(c.memberIds).toEqual(oldIds); // still the dead generation's ids

    w.tick = at;
    stepCamps(w);
    expect(c.aliveCount).toBe(must(TIER_COUNT[c.def.tier]));
    expect(c.respawnAtTick).toBe(-1);
    for (const id of c.memberIds) {
      expect(oldIds).not.toContain(id); // EntIds are never recycled
      const e = ent(w, id);
      expect(e.alive).toBe(true);
      expect(e.hp).toBe(tuning.hp);
      expect(e.maxHp).toBe(tuning.hp);
      expect(distTo(e, c.def.x, c.def.z)).toBeLessThanOrEqual(2);
    }
  });

  it('respawn delay matches the tier constants, not a shared default', () => {
    const w = makeWorld(3);
    tickCamps(w);
    const seen = new Set<CampTier>();
    for (const c of campsOf(w)) {
      for (const id of c.memberIds) ent(w, id).hp = 0;
      seen.add(c.def.tier);
    }
    const killTick = w.tick + 1;
    tickCamps(w);
    for (const c of campsOf(w)) {
      expect(c.respawnAtTick - killTick).toBe(must(TIER_RESPAWN_TICKS[c.def.tier]));
    }
    // The 3-lane map carries all three tiers, so all three clocks were checked.
    expect(seen.size).toBe(3);
  });
});

// --- determinism -------------------------------------------------------------

describe('determinism', () => {
  it('two identical runs produce bit-identical camp state', () => {
    function run(): string {
      const w = makeWorld(3);
      tickCamps(w);
      const c = must(campsOf(w)[0]);
      const bait = w.spawnMobile('melee', 0, c.def.x + 1, c.def.z, -1, 0, NO_ENT);
      for (let i = 0; i < 300; i++) {
        const b = w.get(bait);
        if (b) b.x = Math.min(w.map.side, b.x + 0.25);
        if (i === 40) {
          for (const id of must(campsOf(w)[1]).memberIds) {
            const e = w.get(id);
            if (e) e.hp = 0;
          }
        }
        moveCamps(w);
        tickCamps(w);
      }
      return digest(w);
    }
    const a = run();
    const b = run();
    expect(a).toBe(b);
    expect(a.length).toBeGreaterThan(0);
  });

  it('consumes no randomness: the same world stepped twice from a snapshot agrees', () => {
    const w1 = makeWorld(2);
    const w2 = makeWorld(2);
    for (let i = 0; i < 120; i++) {
      moveCamps(w1);
      tickCamps(w1);
      moveCamps(w2);
      tickCamps(w2);
    }
    expect(digest(w1)).toBe(digest(w2));
  });
});
