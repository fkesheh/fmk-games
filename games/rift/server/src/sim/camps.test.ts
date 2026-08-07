// ============================================================================
// T3 — SIM CORE: camps.ts tests (TERRAIN_CONTRACT §5, DESIGN_DELTA §2,
// AMENDMENT_1 §A/§C/§E).
//
// Covers the whole camp lifecycle against a REAL SimWorld and the REAL sim
// steps — `stepMovement` (4), `stepDeaths` (6) and `stepCamps` (7), driven in
// advance()'s own order. There is NO stand-in mover. The previous suite had
// one, and it moved toward `ox`/`oz` and snapped, which the real `campMotion`
// does neither: every assertion about a camp's resting state was true of the
// fake and false of the sim. A camp fixture that walks differently from
// movement.ts is not a fixture, it is a second implementation.
//
// Where the terrain matters the scenario paints it (a flat square, or one wall
// in a known place), exactly as movement.test.ts does: the interesting cases —
// a target behind rock, a bait sprinting in a straight line for 500 ticks — are
// ones a generated map is not obliged to contain, and a test that hunts the
// real map for them asserts on whatever it found. `buildMap` is used where the
// real map IS the subject: the camp table, mirroring, and standing the whole
// three-lane jungle up.
//
// ONE deliberate fixture remains, `ensureCampTable`: S_WORLD (wave 2) builds
// `SimWorld.camps` at construction and has not landed, so this builds the
// identical table. Once S_WORLD lands it returns immediately and the suite runs
// against the world's own.
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
  CAMP_LANE_CLEARANCE,
  CAMP_LEASH_RADIUS,
  CAMP_PACK,
  CAMP_PACK_COUNT,
  CAMP_PACK_RESPAWN_S,
  CAMP_RESET_S,
  ELEV_HIGH,
  ELEV_LOW,
  NEUTRAL_TEAM,
  TERRAIN_KINDS,
  TICK_RATE,
  buildMap,
  isCampKind,
} from '@rift/shared';
import type {
  CampDef,
  CreepTuning,
  EntKind,
  MapDef,
  StructureDef,
  TerrainDef,
  TerrainKind,
} from '@rift/shared';
import { SimWorld } from './world.js';
import { stepDeaths } from './combat.js';
import { stepMovement } from './movement.js';
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
/** The out-of-combat reset delay in ticks (AMENDMENT_2 §B), derived here the
 *  same way camps.ts derives it, so the timing assertions move with config. */
const CAMP_RESET_TICKS = Math.round(CAMP_RESET_S * TICK_RATE);

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

const HIGH_KINDS: readonly TerrainKind[] = ['high', 'base', 'ramp'];

/** Paint a square terrain grid cell by cell from a function of the cell CENTRE.
 *  Elevation is derived from the kind exactly as TERRAIN_CONTRACT §3 defines it
 *  (`'ramp'` reads ELEV_HIGH), so a scenario only ever states kinds. */
function terrainOf(side: number, camps: CampDef[], paint: (x: number, z: number) => TerrainKind): TerrainDef {
  const dim = side;
  const kind = new Uint8Array(dim * dim);
  const elev = new Uint8Array(dim * dim);
  for (let z = 0; z < dim; z++) {
    for (let x = 0; x < dim; x++) {
      const k = paint(x + 0.5, z + 0.5);
      kind[z * dim + x] = TERRAIN_KINDS.indexOf(k);
      elev[z * dim + x] = HIGH_KINDS.includes(k) ? ELEV_HIGH : ELEV_LOW;
    }
  }
  return { grid: { side, res: 1, dim, kind, elev }, camps, landmarks: [] };
}

function campAt(id: number, tier: CampTier, x: number, z: number): CampDef {
  return { id, tier, x, z, half: 0 };
}

const SIDE = 64;

interface Scenario {
  paint?: (x: number, z: number) => TerrainKind;
  structures?: readonly StructureDef[];
  paths?: readonly (readonly { x: number; z: number }[])[];
}

/** S_WORLD (wave 2) constructs `readonly camps: CampState[]` from
 *  `map.terrain.camps`, `memberIds` empty, `aliveCount` 0 and `respawnAtTick` 0
 *  so the first stepCamps stands the jungle up. Until that lands, build the
 *  identical table here; once it lands this returns immediately and the suite
 *  runs against the world's own table. */
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

/** A hand-painted world holding exactly the camps a scenario asks for. */
function campWorld(camps: CampDef[], s: Scenario = {}): SimWorld {
  const terrain = terrainOf(SIDE, camps, s.paint ?? (() => 'ground'));
  const map: MapDef = {
    lanes: 1,
    side: SIDE,
    paths: s.paths ?? [],
    structures: s.structures ?? [],
    terrain,
  };
  const w = new SimWorld(map, SEATS, new EngineDouble());
  ensureCampTable(w, map);
  return w;
}

/** The real map, where the real map is the subject. */
function realWorld(lanes: number): SimWorld {
  const map = buildMap(lanes);
  const w = new SimWorld(map, SEATS, new EngineDouble());
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

function hero(w: SimWorld, pid: string): Ent {
  for (const e of w.mobileMap.values()) {
    if (e.kind === 'hero' && e.pid === pid) return e;
  }
  throw new Error(`no hero ${pid}`);
}

/** One full tick of the three advance() steps a camp lives inside, in
 *  advance()'s order: movement (4) EXECUTES last tick's orders, deaths (6)
 *  reaps, camps (7) DECIDES this tick's orders. That ordering is the seam —
 *  an order camps.ts writes takes effect on the next tick, by design. */
function tickSim(w: SimWorld): void {
  w.tick += 1;
  stepMovement(w);
  stepDeaths(w);
  stepCamps(w);
}

/** Stand the jungle up without moving anything: the first stepCamps spawns. */
function standUp(w: SimWorld): void {
  w.tick += 1;
  stepCamps(w);
}

function distTo(e: Ent, x: number, z: number): number {
  return Math.hypot(e.x - x, e.z - z);
}

function living(w: SimWorld, c: CampState): Ent[] {
  const out: Ent[] = [];
  for (const id of c.memberIds) {
    const e = w.get(id);
    if (e && e.alive) out.push(e);
  }
  return out;
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
    const w = realWorld(3);
    campsOf(w).forEach((c, i) => {
      expect(c.id).toBe(i);
      expect(c.def.id).toBe(i);
    });
  });
});

// --- spawn -------------------------------------------------------------------

describe('spawn', () => {
  it('stands every camp up on the first step, whole and at full hp', () => {
    const w = realWorld(3);
    standUp(w);
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
    const w = realWorld(2);
    standUp(w);
    for (const c of campsOf(w)) {
      for (const id of c.memberIds) {
        const e = ent(w, id);
        expect(e.team).toBe(NEUTRAL_TEAM);
        expect(e.lane).toBe(-1);
        expect(e.waypoint).toBe(0);
        expect(e.owner).toBe(NO_ENT);
        expect(e.expireAtTick).toBeLessThanOrEqual(0); // <= 0 means never (§B.3)
        expect(e.path ?? null).toBeNull();
        expect(e.pathIndex ?? 0).toBe(0);
      }
    }
  });

  it('gives every member of a camp its OWN post, far enough apart not to shove', () => {
    // Members spawn standing on their posts, so their spawn positions ARE the
    // posts. One shared point is what made a whole camp grind against pass-2
    // separation for ever, so this is measured per tier and against the real
    // entity radii rather than against the arithmetic in camps.ts.
    for (const tier of ['pack', 'brute', 'hive'] as const) {
      const w = campWorld([campAt(0, tier, 32, 32)]);
      standUp(w);
      const c = must(campsOf(w)[0]);
      const members = living(w, c);
      expect(members.length).toBe(must(TIER_COUNT[tier]));
      for (const m of members) {
        // The CAMP_LANE_CLEARANCE derivation assumes a resting member sits
        // within ~2 m of the clearing centre; hold it to that.
        expect(distTo(m, 32, 32)).toBeLessThanOrEqual(2);
      }
      for (let i = 0; i < members.length; i++) {
        for (let j = i + 1; j < members.length; j++) {
          const a = must(members[i]);
          const b = must(members[j]);
          const gap = Math.hypot(a.x - b.x, a.z - b.z);
          expect(gap, `${tier} members ${i} and ${j} share a post`).toBeGreaterThan(
            a.radius + b.radius,
          );
        }
      }
    }
  });

  it('carries its tier statline through recomputeEnt, radius included (§D.2)', () => {
    // CROSS-MODULE, and deliberately so. camps.ts stamps NOTHING: `spawnMobile`
    // writes both the Ent and the `w.base` core that recomputeEnt() re-derives
    // from every tick, out of `mobileTuning(kind)`. This file used to re-stamp
    // all of it from the same constants afterwards, which was a complete no-op
    // once AMENDMENT_2 §D.2 added world.ts's camp arms — so that function is
    // gone and this is what guards the door it went through.
    //
    // `radius` is the proof that the ownership had to move: it is `readonly`
    // and written once by `makeEnt`, so camps.ts could never have corrected it.
    // Drop world.ts's camp arms and radius falls to the 0.3 default and hp to
    // 1, and every assertion below fails.
    const w = campWorld([campAt(0, 'brute', 32, 32)]);
    standUp(w);
    const c = must(campsOf(w)[0]);
    const e = ent(w, must(c.memberIds[0]));
    expect(e.radius).toBe(CAMP_BRUTE.radius);
    w.recomputeEnt(e); // advance() step (3) runs this every tick, for everyone
    expect(e.maxHp).toBe(CAMP_BRUTE.hp);
    expect(e.damage).toBe(CAMP_BRUTE.damage);
    expect(e.armor).toBe(CAMP_BRUTE.armor);
    expect(e.moveSpeed).toBe(CAMP_BRUTE.moveSpeed);
    expect(e.attackRange).toBe(CAMP_BRUTE.attackRange);
  });

  it('carries no hp regen at all — the resets are the only heals (§C, §D.5)', () => {
    const w = campWorld([campAt(0, 'hive', 32, 32)]);
    standUp(w);
    const c = must(campsOf(w)[0]);
    for (const id of c.memberIds) {
      const e = ent(w, id);
      expect(e.hpRegen).toBe(0);
      // Also cross-module: stepUnits' regen loop reads the BASE table through
      // recomputeEnt, so a non-zero there would heal a camp mid-fight even with
      // the Ent at 0 — which is why §D.5 forbids world.ts giving camps regen.
      expect(must(w.base.get(id)).hpRegen).toBe(0);
    }
  });
});

// --- the seam: camps.ts decides, movement.ts executes (AMENDMENT_1 §A) -------

describe('the camps <-> movement seam', () => {
  it('camps.ts issues an order home and never writes a position', () => {
    const w = campWorld([campAt(0, 'pack', 32, 32)]);
    standUp(w);
    const c = must(campsOf(w)[0]);
    const e = ent(w, must(c.memberIds[0]));
    const postX = e.x;
    const postZ = e.z;

    // Dragged well outside the leash disc, as a displacement could leave it.
    e.x = 32 + CAMP_LEASH_RADIUS + 4;
    e.z = 32;
    const atX = e.x;
    const atZ = e.z;
    stepCamps(w); // the decider, alone

    expect(e.x).toBe(atX); // NOT clamped, NOT teleported
    expect(e.z).toBe(atZ);
    expect(e.order).toBe('move');
    expect(e.orderTarget).toBe(NO_ENT);
    expect(e.ox).toBe(postX);
    expect(e.oz).toBe(postZ);
  });

  it('movement.ts does not move an idle member', () => {
    const w = campWorld([campAt(0, 'pack', 32, 32)]);
    standUp(w);
    const c = must(campsOf(w)[0]);
    const e = ent(w, must(c.memberIds[0]));
    // Off its post but idle: the order is the whole truth, and idle means idle.
    e.x += 3;
    e.z += 1;
    const atX = e.x;
    const atZ = e.z;
    stepMovement(w); // the executor, alone
    expect(e.x).toBe(atX);
    expect(e.z).toBe(atZ);
  });

  it('movement.ts never acquires for a camp, and never walks it down a lane', () => {
    const lane = [
      { x: 2, z: 2 },
      { x: 61, z: 61 },
    ];
    const w = campWorld([campAt(0, 'pack', 32, 32)], { paths: [lane] });
    standUp(w);
    const c = must(campsOf(w)[0]);
    const e = ent(w, must(c.memberIds[0]));
    // Forced into the exact state the fall-through bug produces: a camp creep
    // carrying a lane index. If the camp arm ever falls through to creepMotion
    // this walks the polyline and acquires the intruder.
    e.lane = 0;
    w.spawnMobile('melee', 1, e.x + 1.2, e.z, -1, -1, NO_ENT);
    const atX = e.x;
    const atZ = e.z;
    stepMovement(w); // the executor, alone: no stepCamps this tick
    expect(e.orderTarget).toBe(NO_ENT);
    expect(e.order).toBe('idle');
    expect(e.x).toBe(atX);
    expect(e.z).toBe(atZ);
    expect(e.waypoint).toBe(0);
  });

  it('the two halves meet: an order written by camps.ts is walked by movement.ts', () => {
    const w = campWorld([campAt(0, 'brute', 32, 32)]);
    standUp(w);
    const c = must(campsOf(w)[0]);
    const e = ent(w, must(c.memberIds[0]));
    const h = hero(w, 'p0');
    h.order = 'idle';
    h.x = 32 + 6;
    h.z = 32;

    stepCamps(w); // decide
    expect(e.order).toBe('attack');
    expect(e.orderTarget).toBe(h.id);

    const reach = CAMP_BRUTE.attackRange + e.radius + h.radius;
    let closed = false;
    for (let i = 0; i < 120 && !closed; i++) {
      tickSim(w);
      closed = Math.hypot(e.x - h.x, e.z - h.z) <= reach + 1e-6;
    }
    expect(closed).toBe(true);
  });
});

// --- aggro -------------------------------------------------------------------

describe('aggro', () => {
  it('acquires an enemy that walks into the clearing', () => {
    const w = campWorld([campAt(0, 'pack', 32, 32)]);
    standUp(w);
    const c = must(campsOf(w)[0]);
    const bait = w.spawnMobile('melee', 0, 33, 32, -1, -1, NO_ENT);
    stepCamps(w);
    for (const e of living(w, c)) {
      expect(e.order).toBe('attack');
      expect(e.orderTarget).toBe(bait);
    }
  });

  it('answers a damager beyond AGGRO_RADIUS but inside the clearing — the pull', () => {
    const w = campWorld([campAt(0, 'pack', 32, 32)]);
    standUp(w);
    const c = must(campsOf(w)[0]);
    // 9 m from the centre, on the far side of the clearing from member 0's
    // post: outside every member's AGGRO_RADIUS, inside the acquire disc.
    const sniper = w.spawnMobile('ranged', 1, 32 - 9, 32, -1, -1, NO_ENT);
    const victim = must(c.memberIds[0]);
    w.damage(sniper, victim, 20, 'physical');
    stepCamps(w);

    const e = ent(w, victim);
    expect(Math.hypot(e.x - (32 - 9), e.z - 32)).toBeGreaterThan(AGGRO_RADIUS);
    expect(e.order).toBe('attack');
    expect(e.orderTarget).toBe(sniper);
    for (const id of c.memberIds) {
      if (id === victim) continue;
      expect(ent(w, id).order).toBe('idle'); // nothing came inside AGGRO_RADIUS
    }
  });

  it('ignores a damager in the hysteresis band, then RESETS out of combat (§B)', () => {
    const w = campWorld([campAt(0, 'brute', 32, 32)]);
    standUp(w);
    const c = must(campsOf(w)[0]);
    const victim = must(c.memberIds[0]);
    const e = ent(w, victim);
    // 9.5 m from the clearing centre: OUTSIDE the 9 m acquire disc, INSIDE the
    // 10 m retention radius, and 7.9 m from the nearest post — outside every
    // member's AGGRO_RADIUS. That is the live exploit AMENDMENT_2 §B closes:
    // the camp never acquires, so it never chases, never breaks its leash and
    // never reaches the arrival restore, and with hpRegen 0 it could be
    // whittled down for free across as many visits as the hero cared to make.
    // This test previously asserted that behaviour as CORRECT; it is inverted.
    const sniper = w.spawnMobile('ranged', 1, 32 + 9.5, 32, -1, -1, NO_ENT);

    for (let i = 0; i < 60; i++) {
      w.damage(sniper, victim, 3, 'physical');
      // `recentDamagers` is only filled by world.ts for HERO victims, so drive
      // it through the world's own door — otherwise the list is empty for the
      // whole test and "the reset clears it" is an assertion about nothing.
      w.noteDamager(e, sniper);
      const hp = e.hp;
      tickSim(w);
      // Still ignored: the pull is capped at the acquire radius, not the leash.
      expect(e.order).toBe('idle');
      expect(e.orderTarget).toBe(NO_ENT);
      // And still hurt: no regen, no resting heal, and no reset while the
      // damage keeps landing — the timer restarts on every tick that hurts.
      expect(e.hp).toBe(hp);
    }
    const hurt = e.hp;
    expect(hurt).toBeLessThan(e.maxHp);
    expect(e.recentDamagers.length).toBe(1); // there really is something to clear

    // The poking stops. Every member is idle and nothing damages the camp, so
    // after CAMP_RESET_S — and not one tick before it — the camp is whole.
    for (let i = 0; i < CAMP_RESET_TICKS - 1; i++) tickSim(w);
    expect(e.hp).toBe(hurt);
    tickSim(w);
    for (const m of living(w, c)) {
      expect(m.hp).toBe(m.maxHp);
      expect(m.recentDamagers.length).toBe(0);
      expect(m.lastHitBy).toBe(NO_ENT);
    }
  });

  it('does not reset while a member is still engaged, however quiet the fight', () => {
    const w = campWorld([campAt(0, 'pack', 32, 32)]);
    standUp(w);
    const c = must(campsOf(w)[0]);
    const victim = must(c.memberIds[0]);
    const e = ent(w, victim);
    const bait = hero(w, 'p0');
    bait.order = 'idle';
    bait.x = 35;
    bait.z = 32; // inside the clearing, inside every member's AGGRO_RADIUS
    w.damage(bait.id, victim, 40, 'physical');
    const hurt = e.hp;
    expect(hurt).toBeLessThan(e.maxHp);
    stepCamps(w);
    for (const m of living(w, c)) expect(m.order).toBe('attack');

    // Twice CAMP_RESET_S of a standoff. Nothing damages the camp again — a hero
    // between attack cooldowns does not, either — but the camp is still holding
    // an attack order, so the all-members-idle half of §B refuses to reset it.
    // Heal here and a hero could bait a camp and farm it for ever.
    for (let i = 0; i < CAMP_RESET_TICKS * 2; i++) {
      // Pinned: camp members are immovable (§A), so an unpinned bait would be
      // shoved out of the clearing and would end the fight for the wrong reason.
      bait.x = 35;
      bait.z = 32;
      tickSim(w);
    }
    expect(e.order).toBe('attack');
    expect(e.hp).toBe(hurt);
  });

  it('a respawned camp starts with a clean combat memory (§B)', () => {
    const w = campWorld([campAt(0, 'pack', 32, 32)]);
    standUp(w);
    const c = must(campsOf(w)[0]);
    const sniper = w.spawnMobile('ranged', 1, 32 + 9.5, 32, -1, -1, NO_ENT);
    // Leave the OUTGOING generation on a low hp watermark, then kill it.
    for (const id of c.memberIds) ent(w, id).hp = 10;
    tickSim(w);
    for (const id of c.memberIds) ent(w, id).hp = 0;
    tickSim(w);
    expect(c.aliveCount).toBe(0);

    w.tick = c.respawnAtTick;
    stepCamps(w);
    expect(c.aliveCount).toBe(CAMP_PACK_COUNT);

    // The fresh generation is poked one tick after it stands up. The outgoing
    // generation's watermark is far BELOW the new camp's total, so a memory
    // carried across the respawn would not read this as damage at all — and its
    // equally stale "last hurt" tick is already older than CAMP_RESET_S, so the
    // poke would be healed away on the very tick it landed.
    const victim = must(c.memberIds[0]);
    const e = ent(w, victim);
    w.damage(sniper, victim, 20, 'physical');
    const hurt = e.hp;
    expect(hurt).toBeLessThan(e.maxHp);
    tickSim(w);
    expect(e.hp).toBe(hurt);
  });

  it('will not ACQUIRE inside the hysteresis band, only retain there (§C)', () => {
    const w = campWorld([campAt(0, 'pack', 32, 32)]);
    standUp(w);
    const c = must(campsOf(w)[0]);
    const e = ent(w, must(c.memberIds[0]));
    // Displaced 4 m out along +x. From a resting post (1.6 m out) nothing in
    // the 9..10 m band is within AGGRO_RADIUS of anybody at all, so the band is
    // only observable from a member that has been moved off its post.
    e.x = 36;
    e.z = 32;
    e.order = 'idle';
    e.orderTarget = NO_ENT;
    const band = w.spawnMobile('melee', 0, 32 + 9.5, 32, -1, -1, NO_ENT);
    expect(Math.hypot(e.x - (32 + 9.5), e.z - 32)).toBeLessThan(AGGRO_RADIUS);
    stepCamps(w);
    // 9.5 m from the centre: inside the leash disc, outside the acquire disc.
    expect(e.orderTarget).toBe(NO_ENT);
    expect(e.order).not.toBe('attack');

    // Control: the same enemy one metre further in IS taken, so the member is
    // not simply refusing everything.
    ent(w, band).x = 32 + 8.5;
    e.x = 36;
    e.z = 32;
    e.order = 'idle';
    e.orderTarget = NO_ENT;
    stepCamps(w);
    expect(e.orderTarget).toBe(band);
  });

  it('RETAINS a target out to the full leash radius once it has one (§C)', () => {
    const w = campWorld([campAt(0, 'pack', 32, 32)]);
    standUp(w);
    const c = must(campsOf(w)[0]);
    const e = ent(w, must(c.memberIds[0]));
    e.x = 36;
    e.z = 32;
    e.order = 'idle';
    e.orderTarget = NO_ENT;
    const foe = w.spawnMobile('melee', 0, 32 + 8.5, 32, -1, -1, NO_ENT);
    stepCamps(w);
    expect(e.orderTarget).toBe(foe); // acquired inside the acquire disc

    // It backs off INTO the band: still inside the leash disc, no longer inside
    // the acquire disc. Retention is the FULL radius, so the fight continues.
    // Narrow retention to the acquire radius and a target loitering on the
    // boundary is dropped and re-taken on alternate ticks for ever, which is
    // the flicker the band exists to remove.
    ent(w, foe).x = 32 + 9.5;
    stepCamps(w);
    expect(e.order).toBe('attack');
    expect(e.orderTarget).toBe(foe);

    // Past the leash radius it IS dropped: retention is wider than acquisition,
    // not unbounded.
    ent(w, foe).x = 32 + CAMP_LEASH_RADIUS + 0.5;
    stepCamps(w);
    expect(e.orderTarget).toBe(NO_ENT);
  });

  it('breaks an exact distance tie on the lower entity id, not on scan order', () => {
    const w = campWorld([campAt(0, 'pack', 32, 32)]);
    standUp(w);
    const c = must(campsOf(w)[0]);
    for (const pid of ['p0', 'p1']) {
      const h = hero(w, pid);
      h.order = 'idle';
      h.x = 2;
      h.z = 2;
    }
    const e = ent(w, must(c.memberIds[0]));
    e.x = 32;
    e.z = 32;
    e.order = 'idle';
    e.orderTarget = NO_ENT;
    // Two hostiles EXACTLY equidistant (3 m) and both well inside the disc.
    const lo = w.spawnMobile('melee', 0, 32, 32 + 3, -1, -1, NO_ENT);
    const hi = w.spawnMobile('melee', 0, 32, 32 - 3, -1, -1, NO_ENT);
    expect(hi).toBeGreaterThan(lo);
    // `inRadius` walks `mobileMap` in INSERTION order, which is ascending id,
    // so the id tie-break can only ever be exercised by presenting the HIGHER
    // id first — which is precisely the "map iteration order" the rule exists
    // to be immune to. Re-inserting `lo` moves it to the back of the Map.
    const loEnt = ent(w, lo);
    w.mobileMap.delete(lo);
    w.mobileMap.set(lo, loEnt);
    const scanned = [...w.mobileMap.values()]
      .filter((m) => m.id === lo || m.id === hi)
      .map((m) => m.id);
    expect(scanned).toEqual([hi, lo]); // the higher id really is scanned first
    stepCamps(w);
    expect(e.orderTarget).toBe(lo);
  });

  it('ignores a target it cannot walk to, and still takes one it can', () => {
    // A wall down x in [26,27). The clearing and its members are west of it.
    const paint = (x: number): TerrainKind => (x > 26 && x < 27 ? 'cliff' : 'ground');
    const w = campWorld([campAt(0, 'pack', 22, 32)], { paint });
    standUp(w);
    const c = must(campsOf(w)[0]);
    const east = w.spawnMobile('melee', 0, 30, 32, -1, -1, NO_ENT); // 8 m out, behind rock
    stepCamps(w);
    for (const e of living(w, c)) {
      expect(e.orderTarget).not.toBe(east);
      expect(e.order).toBe('idle');
    }

    // Control: the same distance on the near side IS acquired, so the camp is
    // not simply inert.
    const west = w.spawnMobile('melee', 0, 22 - 5, 32, -1, -1, NO_ENT);
    stepCamps(w);
    const near = must(living(w, c).find((e) => e.orderTarget !== NO_ENT));
    expect(near.orderTarget).toBe(west);
  });

  it('does not let a distant damager shadow an enemy standing on top of it', () => {
    const w = campWorld([campAt(0, 'pack', 32, 32)]);
    standUp(w);
    const c = must(campsOf(w)[0]);
    const victim = must(c.memberIds[0]);
    const e = ent(w, victim);
    const sniper = w.spawnMobile('ranged', 1, 32 - 9, 32, -1, -1, NO_ENT);
    w.damage(sniper, victim, 20, 'physical');
    // ...and only then does somebody walk into contact.
    const contact = w.spawnMobile('melee', 0, e.x + 0.2, e.z, -1, -1, NO_ENT);
    stepCamps(w);
    expect(e.orderTarget).toBe(contact);
  });

  it('never acquires a ward, another neutral, or a structure', () => {
    const tower: StructureDef = { id: 0, kind: 'tower', team: 0, lane: 0, x: 32, z: 40 };
    const w = campWorld([campAt(0, 'pack', 32, 32)], { structures: [tower] });
    standUp(w);
    const c = must(campsOf(w)[0]);
    // A ward on the clearing centre, and a second camp's creep beside it.
    w.spawnMobile('ward', 0, 32, 32, -1, -1, NO_ENT);
    const other = must(campsOf(w)[0]);
    expect(other.id).toBe(0);
    stepCamps(w);
    for (const e of living(w, c)) {
      expect(e.order).toBe('idle');
      expect(e.orderTarget).toBe(NO_ENT);
    }
    // The tower is 6.4 m from the +z member — well inside AGGRO_RADIUS — and is
    // on a player team, so team hostility alone would have taken it.
    const north = must(living(w, c).find((e) => e.z > 33));
    expect(Math.hypot(north.x - tower.x, north.z - tower.z)).toBeLessThan(AGGRO_RADIUS);
  });
});

// --- leash -------------------------------------------------------------------

describe('leash', () => {
  it('sends a disengaged member home and restores it on ARRIVAL, not before', () => {
    const w = campWorld([campAt(0, 'brute', 32, 32)]);
    standUp(w);
    const c = must(campsOf(w)[0]);
    const e = ent(w, must(c.memberIds[0]));
    const postX = e.x;
    const postZ = e.z;
    const h = hero(w, 'p0');
    h.order = 'idle';
    // Inside the clearing but across it, so the member genuinely LEAVES its
    // post to fight — a hero that walks onto the post never breaks the leash
    // and is not entitled to reset the camp.
    h.x = 32;
    h.z = 32 - 6;
    stepCamps(w);
    expect(e.order).toBe('attack');

    w.damage(h.id, e.id, 150, 'physical');
    // `recentDamagers` is only filled by world.ts for HERO victims, so drive it
    // through the world's own door rather than asserting on a list that nothing
    // in production can fill. AMENDMENT_1 §A still requires camps.ts to clear it.
    w.noteDamager(e, h.id);
    expect(e.hp).toBeLessThan(e.maxHp);
    expect(e.recentDamagers.length).toBe(1);
    expect(e.lastHitBy).toBe(h.id);

    // Let it walk out to the intruder before the intruder leaves.
    let closed = 0;
    while (Math.hypot(e.x - postX, e.z - postZ) < 3 && closed < 200) {
      tickSim(w);
      closed += 1;
    }
    expect(Math.hypot(e.x - postX, e.z - postZ)).toBeGreaterThan(3);

    h.z = 32 - (CAMP_LEASH_RADIUS + 8); // the hero leaves the clearing
    tickSim(w);
    expect(e.order).toBe('move');
    expect(e.orderTarget).toBe(NO_ENT);
    expect(e.lastHitBy).toBe(NO_ENT);
    expect(e.recentDamagers.length).toBe(0);
    expect(e.hp).toBeLessThan(e.maxHp); // the restore has NOT landed yet

    let walked = 0;
    while (e.order === 'move' && walked < 400) {
      tickSim(w);
      walked += 1;
      // POKED ON THE WAY HOME, on one tick of the walk. `beginReturn` zeroed
      // the damage bookkeeping when the member disengaged, so without this the
      // wipe in `arriveAtPost` only ever restates what `beginReturn` already
      // guaranteed and the assertions below cannot fail. `World.damage` writes
      // `lastHitBy` on EVERY victim, so the return leg genuinely refills it —
      // and a member that arrives home still holding its attacker re-pulls onto
      // it the moment that attacker steps back inside the acquire disc.
      if (walked === 2) {
        w.damage(h.id, e.id, 1, 'physical');
        w.noteDamager(e, h.id);
        expect(e.lastHitBy).toBe(h.id);
        expect(e.recentDamagers.length).toBe(1);
      }
    }
    expect(walked).toBeGreaterThan(2); // the poke really did land mid-walk
    expect(walked).toBeLessThan(400);
    expect(e.order).toBe('idle');
    expect(e.hp).toBe(e.maxHp);
    expect(e.lastHitBy).toBe(NO_ENT);
    expect(e.recentDamagers.length).toBe(0);
    expect(Math.hypot(e.x - postX, e.z - postZ)).toBeLessThan(0.2); // its OWN post
  });

  it('leashes a member carried out of the disc even mid-fight', () => {
    // The leash is the FIRST rule stepMember applies, and it is the only one
    // that can catch this. Everything else defers to the chase cap, which is
    // applied to the TARGET measured from the clearing centre — so a member
    // that has been moved by something other than its own chase (separation, a
    // structure push-out, a displacement) still holds a target the cap is
    // perfectly happy with, and would go on fighting from outside its clearing.
    const w = campWorld([campAt(0, 'pack', 32, 32)]);
    standUp(w);
    const c = must(campsOf(w)[0]);
    const e = ent(w, must(c.memberIds[0]));
    const foe = w.spawnMobile('melee', 0, 32 + 2, 32, -1, -1, NO_ENT);
    stepCamps(w);
    expect(e.order).toBe('attack');
    expect(e.orderTarget).toBe(foe);

    e.x = 32 + CAMP_LEASH_RADIUS + 2;
    e.z = 32;
    stepCamps(w);
    expect(e.order).toBe('move');
    expect(e.orderTarget).toBe(NO_ENT);
    // The target it dropped is still perfectly legal — it is the MEMBER that
    // is out of bounds, which is the whole point of the rule.
    expect(ent(w, foe).alive).toBe(true);
    expect(distTo(ent(w, foe), 32, 32)).toBeLessThan(CAMP_LEASH_RADIUS);
  });

  it('walks home rather than being snapped there, however far out it was shoved', () => {
    // camps.ts is forbidden to write x/z (AMENDMENT_1 §A), so a member carried
    // past the leash — by separation, by a structure push-out, by a
    // displacement ability — is NOT pulled back onto the circle. It is ordered
    // home and it walks, which is the only resolution that cannot drop it
    // across a cliff or inside a structure. That is asserted here as a bound on
    // per-tick displacement: no tick may move it further than its own speed.
    const w = campWorld([campAt(0, 'pack', 32, 32)]);
    standUp(w);
    const c = must(campsOf(w)[0]);
    const e = ent(w, must(c.memberIds[0]));
    const postX = e.x;
    const postZ = e.z;
    w.damage(hero(w, 'p0').id, e.id, 90, 'physical');
    expect(e.hp).toBeLessThan(e.maxHp);

    e.x = 32 + 20; // 20 m out: double the leash
    e.z = 32;
    const step = CAMP_PACK.moveSpeed / TICK_RATE + 1e-9;
    let ticks = 0;
    for (;;) {
      const wasX = e.x;
      const wasZ = e.z;
      tickSim(w);
      expect(Math.hypot(e.x - wasX, e.z - wasZ)).toBeLessThanOrEqual(step);
      ticks += 1;
      if (ticks === 1) expect(e.order).toBe('move'); // ordered home, not moved home
      if (e.order === 'idle' || ticks >= 600) break;
    }
    expect(ticks).toBeLessThan(600);
    expect(Math.hypot(e.x - postX, e.z - postZ)).toBeLessThan(0.2);
    expect(e.hp).toBe(e.maxHp);
  });

  it('does not re-acquire while walking home', () => {
    const w = campWorld([campAt(0, 'pack', 32, 32)]);
    standUp(w);
    const c = must(campsOf(w)[0]);
    const e = ent(w, must(c.memberIds[0]));
    e.x = 32 + CAMP_LEASH_RADIUS + 1;
    e.z = 32;
    stepCamps(w);
    expect(e.order).toBe('move');

    // Walk it back INSIDE the leash disc but well short of its post, so the
    // leash rule is no longer what is holding the order: from here on, "keep
    // walking home" is the returning rule and nothing else.
    let walked = 0;
    while (distTo(e, 32, 32) > 5 && walked < 400) {
      tickSim(w);
      walked += 1;
    }
    expect(walked).toBeLessThan(400);
    expect(e.order).toBe('move');
    expect(distTo(e, 32, 32)).toBeLessThan(CAMP_LEASH_RADIUS);

    // A perfectly acquirable enemy — inside the clearing, inside AGGRO_RADIUS,
    // an arm's length away — is ignored until the member is home.
    const foe = w.spawnMobile('melee', 0, e.x, e.z + 0.9, -1, -1, NO_ENT);
    for (let i = 0; i < 5; i++) {
      tickSim(w);
      const f = ent(w, foe);
      // the enemy really is still acquirable — the ignoring is deliberate
      expect(Math.hypot(e.x - f.x, e.z - f.z)).toBeLessThan(AGGRO_RADIUS);
      expect(distTo(e, 32, 32)).toBeLessThan(CAMP_LEASH_RADIUS);
      expect(e.order).toBe('move');
      expect(e.orderTarget).toBe(NO_ENT);
    }
  });

  it('holds a WHOLE camp inside the leash however far the bait runs, then heals it', () => {
    const w = campWorld([campAt(0, 'pack', 32, 32)]);
    standUp(w);
    const c = must(campsOf(w)[0]);
    const posts = living(w, c).map((e) => ({ id: e.id, x: e.x, z: e.z }));
    expect(posts.length).toBe(CAMP_PACK_COUNT); // the WHOLE camp, not one member
    const bait = hero(w, 'p0');
    bait.order = 'idle';
    // Inside every member's aggro radius, but not in contact: a bait teleported
    // into a body would BULLDOZE it through pass-2 separation and would be
    // measuring the push-out, not the leash.
    bait.x = 37;
    bait.z = 32;
    for (const id of c.memberIds) w.damage(bait.id, id, 60, 'physical');
    stepCamps(w);
    for (const e of living(w, c)) expect(e.order).toBe('attack');

    // The bait sprints away in a straight line at 8 m/s — more than twice any
    // camp tier's moveSpeed.
    let worstChase = 0;
    let worstEver = 0;
    for (let i = 0; i < 500; i++) {
      bait.x = Math.min(SIDE - 1, bait.x + 0.4);
      tickSim(w);
      for (const e of living(w, c)) {
        const d = distTo(e, 32, 32);
        worstEver = Math.max(worstEver, d);
        if (e.order === 'attack') worstChase = Math.max(worstChase, d);
      }
    }
    // The chase itself never leaves the leash disc: the cap is applied to the
    // TARGET, measured from the clearing centre, so a member steering at a
    // legal target is steering inside a region it is already in. The slack is
    // one tick of camp movement, because movement executes last tick's order
    // before camps.ts re-decides.
    expect(worstChase).toBeLessThanOrEqual(CAMP_LEASH_RADIUS + CAMP_PACK.moveSpeed / TICK_RATE);
    // And nothing ever gets near the lane corridor, which is the property the
    // §3.5 clearance validation depends on.
    expect(worstEver).toBeLessThan(CAMP_LANE_CLEARANCE);

    for (const p of posts) {
      const e = ent(w, p.id);
      expect(e.order).toBe('idle');
      expect(e.hp).toBe(e.maxHp);
      expect(Math.hypot(e.x - p.x, e.z - p.z)).toBeLessThan(0.2); // its OWN post
    }
  });

  it('a camp at rest is perfectly still — no post is shared, so nothing shoves', () => {
    const w = campWorld([campAt(0, 'hive', 32, 32)]); // five bodies: the tightest ring
    standUp(w);
    const c = must(campsOf(w)[0]);
    for (let i = 0; i < 50; i++) tickSim(w);
    const settled = living(w, c).map((e) => `${e.id}:${e.x}:${e.z}`);
    expect(settled.length).toBe(CAMP_HIVE_COUNT);
    for (let i = 0; i < 200; i++) tickSim(w);
    expect(living(w, c).map((e) => `${e.id}:${e.x}:${e.z}`)).toEqual(settled);
    for (const e of living(w, c)) expect(e.order).toBe('idle');
  });
});

// --- death, respawn, and what a camp pays ------------------------------------

describe('death and respawn', () => {
  it('stamps the tier respawn clock when the last member dies', () => {
    const w = realWorld(3);
    standUp(w);
    for (const c of campsOf(w)) {
      for (const id of c.memberIds) ent(w, id).hp = 0;
    }
    w.tick += 1;
    stepDeaths(w);
    stepCamps(w);
    for (const c of campsOf(w)) {
      expect(c.aliveCount).toBe(0);
      expect(c.respawnAtTick).toBe(w.tick + must(TIER_RESPAWN_TICKS[c.def.tier]));
    }
  });

  it('keeps the camp up while one member lives', () => {
    const w = campWorld([campAt(0, 'pack', 32, 32)]);
    standUp(w);
    const c = must(campsOf(w)[0]);
    const survivor = must(c.memberIds[0]);
    for (const id of c.memberIds) {
      if (id !== survivor) ent(w, id).hp = 0;
    }
    tickSim(w);
    expect(c.aliveCount).toBe(1);
    expect(c.respawnAtTick).toBe(-1);
  });

  it('respawns whole, at full hp, with fresh ids, exactly on the clock', () => {
    const w = campWorld([campAt(0, 'brute', 32, 32)]);
    standUp(w);
    const c = must(campsOf(w)[0]);
    const oldIds = [...c.memberIds];
    for (const id of oldIds) ent(w, id).hp = 0;
    tickSim(w);
    const at = c.respawnAtTick;
    expect(at).toBeGreaterThan(w.tick);

    w.tick = at - 1;
    stepCamps(w);
    expect(c.aliveCount).toBe(0);
    expect(c.memberIds).toEqual(oldIds); // still the dead generation's ids

    w.tick = at;
    stepCamps(w);
    expect(c.aliveCount).toBe(CAMP_BRUTE_COUNT);
    expect(c.respawnAtTick).toBe(-1);
    for (const id of c.memberIds) {
      expect(oldIds).not.toContain(id); // EntIds are never recycled
      const e = ent(w, id);
      expect(e.alive).toBe(true);
      expect(e.hp).toBe(CAMP_BRUTE.hp);
      expect(distTo(e, 32, 32)).toBeLessThanOrEqual(2);
    }
  });

  it('respawn delay matches the tier constants, not a shared default', () => {
    const w = realWorld(3);
    standUp(w);
    const seen = new Set<CampTier>();
    for (const c of campsOf(w)) {
      for (const id of c.memberIds) ent(w, id).hp = 0;
      seen.add(c.def.tier);
    }
    const killTick = w.tick + 1;
    w.tick += 1;
    stepDeaths(w);
    stepCamps(w);
    for (const c of campsOf(w)) {
      expect(c.respawnAtTick - killTick).toBe(must(TIER_RESPAWN_TICKS[c.def.tier]));
    }
    // The 3-lane map carries all three tiers, so all three clocks were checked.
    expect(seen.size).toBe(3);
  });

  it('kills the outgoing generation before reusing the CampState', () => {
    const w = campWorld([campAt(0, 'pack', 32, 32)]);
    standUp(w);
    const c = must(campsOf(w)[0]);
    const orphans = [...c.memberIds];
    expect(orphans.length).toBe(CAMP_PACK_COUNT);
    const h = hero(w, 'p0');
    const goldBefore = h.gold;

    spawnCamp(w, c); // a respawn forced onto a camp that is still up

    for (const id of orphans) {
      expect(w.get(id), `member ${id} survived the respawn`).toBeUndefined();
      expect(w.base.get(id)).toBeUndefined();
    }
    // Nothing camp-shaped is left in the world except the new generation: an
    // orphan would still move, still leash nowhere, and still pay a bounty.
    const campEnts = [...w.mobileMap.values()].filter((e) => isCampKind(e.kind));
    expect(campEnts.map((e) => e.id).sort()).toEqual([...c.memberIds].sort());
    // A replaced generation is despawned, not killed: it pays nobody.
    stepDeaths(w);
    expect(h.gold).toBe(goldBefore);
  });

  it('pays last-hit bounty and xp to the killer team only (TERRAIN_CONTRACT §5)', () => {
    const w = campWorld([campAt(0, 'brute', 32, 32)]);
    standUp(w);
    const c = must(campsOf(w)[0]);
    const victim = must(c.memberIds[0]);
    const ally = hero(w, 'p0');
    const foe = hero(w, 'p1');
    ally.order = 'idle';
    foe.order = 'idle';
    ally.x = 32;
    ally.z = 35;
    foe.x = 32;
    foe.z = 29; // also well inside XP_SHARE_RADIUS of the corpse
    const allyGold = ally.gold;
    const allyXp = ally.xp;
    const foeGold = foe.gold;
    const foeXp = foe.xp;

    w.damage(ally.id, victim, 99999, 'physical');
    stepDeaths(w);

    expect(ally.gold - allyGold).toBe(CAMP_BRUTE.bounty);
    expect(ally.xp - allyXp).toBe(CAMP_BRUTE.xp);
    // A neutral pays the killer's team and nobody else — the enemy hero
    // standing over the corpse gets nothing.
    expect(foe.gold).toBe(foeGold);
    expect(foe.xp).toBe(foeXp);
  });
});

// --- determinism -------------------------------------------------------------

describe('determinism', () => {
  it('two identical runs produce bit-identical camp state', () => {
    function run(): string {
      const w = campWorld([campAt(0, 'pack', 22, 32), campAt(1, 'hive', 44, 32)]);
      standUp(w);
      const bait = hero(w, 'p0');
      bait.order = 'idle';
      bait.x = 23;
      bait.z = 32;
      for (let i = 0; i < 300; i++) {
        bait.x = Math.min(SIDE - 1, bait.x + 0.25);
        if (i === 40) {
          for (const id of must(campsOf(w)[1]).memberIds) {
            const e = w.get(id);
            if (e) e.hp = 0;
          }
        }
        tickSim(w);
      }
      return digest(w);
    }
    const a = run();
    const b = run();
    expect(a).toBe(b);
    expect(a.length).toBeGreaterThan(0);
  });

  it('consumes no randomness: two worlds stepped in lockstep agree', () => {
    const w1 = realWorld(2);
    const w2 = realWorld(2);
    for (let i = 0; i < 120; i++) {
      tickSim(w1);
      tickSim(w2);
    }
    expect(digest(w1)).toBe(digest(w2));
  });
});
