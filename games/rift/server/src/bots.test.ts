// ============================================================================
// server/src/bots.test.ts (T6) — bot brain determinism + scripted scenarios.
// Ents and percepts are plain data built per the frozen sim seam (makeEnt /
// makePercept); no world, no room. The 1-lane test path mirrors buildMap(1):
// side 96, team-0 ancient at (BASE_INSET, BASE_INSET), mid at (48, 48).
// ============================================================================
import { describe, expect, it } from 'vitest';
import { ELEV_HIGH, ELEV_LOW, NEUTRAL_TEAM, buildTerrain, elevationAt } from '@rift/shared';
import type { EntKind, EntTeam, HeroId, TeamId, Vec2 } from '@rift/shared';
import { NO_ENT } from './sim/types.js';
import type { BotCommand, BotPercept, CampPercept, Ent } from './sim/types.js';
import { createBotBrain } from './bots.js';

// 1-lane map geometry: [(11,11) -> (48,48) -> (85,85)], team 1 walks it reversed.
const PATH = [
  { x: 11, z: 11 },
  { x: 48, z: 48 },
  { x: 85, z: 85 },
] as const;

// `team` is EntTeam, not TeamId: camp creeps carry NEUTRAL_TEAM (sim/types.ts
// §Ent.team), and a factory that could not build one would leave the brain's
// neutral guard untestable. `makeHero` below keeps TeamId — a hero is never
// neutral.
function makeEnt(over: Partial<Ent> & { id: number; kind: EntKind; team: EntTeam }): Ent {
  return {
    x: 0,
    z: 0,
    radius: 0.5,
    hp: 100,
    maxHp: 100,
    mana: 300,
    maxMana: 300,
    alive: true,
    damage: 50,
    armor: 0,
    attackPeriod: 1,
    attackRange: 2,
    moveSpeed: 5,
    hpRegen: 1,
    manaRegen: 1,
    lifesteal: 0,
    vision: 10,
    bounty: 0,
    xpValue: 0,
    nextAttackTick: 0,
    atkTarget: NO_ENT,
    order: 'idle',
    ox: 0,
    oz: 0,
    orderTarget: NO_ENT,
    // AMENDMENT_2 §D.1: makeEnt in world.ts initialises these at construction,
    // so nothing downstream has to coalesce them. Mirrored here.
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
    ...over,
  };
}

function makePercept(self: Ent, over?: Partial<BotPercept>): BotPercept {
  return {
    tick: 100,
    phase: 'live',
    self,
    visible: [],
    lane: 0,
    paths: [PATH],
    camps: [],
    wardStock: 0,
    atFountain: false,
    overtime: false,
    ...over,
  };
}

function makeHero(id: number, team: TeamId, hero: HeroId, over?: Partial<Ent>): Ent {
  return makeEnt({ id, kind: 'hero', team, hero, ...over });
}

/** `CampPercept.id` MUST equal its index in `BotPercept.camps` (sim/types.ts):
 *  the brain re-reads its committed camp by index every tick, because the room
 *  owns one mutable percept per camp and refreshes `up` in place. */
function makeCamps(
  ...specs: readonly { tier: CampPercept['tier']; x: number; z: number; up?: boolean }[]
): CampPercept[] {
  return specs.map((s, id) => ({ id, tier: s.tier, x: s.x, z: s.z, up: s.up ?? true }));
}

/** True when some order in `cmds` targets (x, z). */
function ordersToward(cmds: readonly BotCommand[], x: number, z: number): boolean {
  return orders(cmds).some((o) => o.kind !== 'attack' && o.kind !== 'stop' && o.x === x && o.z === z);
}

const T1 = buildTerrain(1);
/** A DIFFERENT lane count's grid, used only to prove the brain reads the one
 *  its percept implies. Terrain never goes on the wire (§0) — it is rebuilt
 *  from the lane count, and `paths.length` is the only lane count a percept
 *  carries. */
const T3 = buildTerrain(3);

/** Two real 1-lane-map points within ENGAGE_RANGE (12 m) of each other at the
 *  given elevations. Searched rather than hard-coded: the plateau layout is
 *  terrain.ts's to decide, and a hard-coded pair would silently stop testing
 *  elevation the first time the layout moved. */
function findPair(
  fromElev: number,
  toElev: number,
  okB: (b: Vec2) => boolean = (): boolean => true,
): { a: Vec2; b: Vec2 } {
  for (let x = 1; x < 95; x++) {
    for (let z = 1; z < 95; z++) {
      const a = { x: x + 0.5, z: z + 0.5 };
      if (elevationAt(T1, a.x, a.z) !== fromElev) continue;
      for (let dx = -8; dx <= 8; dx++) {
        for (let dz = -8; dz <= 8; dz++) {
          if (dx * dx + dz * dz > 100 || (dx === 0 && dz === 0)) continue;
          const b = { x: a.x + dx, z: a.z + dz };
          if (b.x < 1 || b.z < 1 || b.x > 94 || b.z > 94) continue;
          if (elevationAt(T1, b.x, b.z) === toElev && okB(b)) return { a, b };
        }
      }
    }
  }
  throw new Error(`no ${String(fromElev)} -> ${String(toElev)} pair within range on the 1-lane map`);
}

function orders(cmds: readonly BotCommand[]): Extract<BotCommand, { c: 'order' }>[] {
  const out: Extract<BotCommand, { c: 'order' }>[] = [];
  for (const c of cmds) {
    if (c.c === 'order') out.push(c);
  }
  return out;
}

describe('createBotBrain determinism', () => {
  it('same seed + same percept stream -> identical command streams', () => {
    const a = createBotBrain(42, 'reaver');
    const b = createBotBrain(42, 'reaver');
    // Scripted stream exercising every rand-consuming branch: last-hit
    // thresholds, retreat latch, fountain buys, skill points.
    const stream: BotPercept[] = [];
    for (let t = 0; t < 300; t++) {
      const self = makeHero(1000, 0, 'reaver', {
        x: 20 + (t % 30),
        z: 20 + (t % 30),
        hp: 640 - (t % 40) * 12,
        maxHp: 640,
        gold: 300 + t * 3,
        skillPoints: t % 97 === 0 ? 1 : 0,
        level: 1 + (t % 10),
        attackRange: 8, // keep the scripted creep inside last-hit range
      });
      const creep = makeEnt({
        id: 1001,
        kind: 'melee',
        team: 1,
        lane: 0,
        x: 24 + (t % 30),
        z: 24 + (t % 30),
        hp: 450 - (t % 60) * 7,
        maxHp: 450,
        radius: 0.42,
      });
      stream.push(
        makePercept(self, {
          tick: t,
          visible: [creep],
          atFountain: t % 50 < 3,
        }),
      );
    }
    const outA = stream.map((p) => a.tick(p));
    const outB = stream.map((p) => b.tick(p));
    expect(outA).toEqual(outB);
    // The stream must actually exercise the brain, not just return empties.
    expect(outA.some((cmds) => cmds.length > 0)).toBe(true);
    expect(outA.some((cmds) => cmds.some((c) => c.c === 'order' && c.kind === 'attack'))).toBe(true);
  });

  it('different seeds diverge on rand-dependent ticks', () => {
    const a = createBotBrain(1, 'longbow');
    const b = createBotBrain(2, 'longbow');
    const self = makeHero(1000, 0, 'longbow', { x: 40, z: 40, hp: 540, maxHp: 540, attackRange: 10, damage: 48 });
    const creep = makeEnt({ id: 1001, kind: 'melee', team: 1, lane: 0, x: 44, z: 40, hp: 48, maxHp: 450, radius: 0.42 });
    const p = makePercept(self, { visible: [creep] });
    // hp exactly at self.damage: inside the +-15% slop band, so the last-hit
    // decision depends on the seeded draw. Across a handful of draws the two
    // streams must differ somewhere.
    const flat = (brain: ReturnType<typeof createBotBrain>): string =>
      Array.from({ length: 40 }, (_, t) => JSON.stringify(brain.tick({ ...p, tick: t }))).join('|');
    expect(flat(a)).not.toBe(flat(b));
  });
});

describe('retreat behaviour', () => {
  it('retreats toward the own fountain under 32% hp and latches till > 80%', () => {
    const brain = createBotBrain(1, 'bullwark');
    // 27.8% hp -> move to the team-0 base endpoint (11, 11).
    const low = brain.tick(
      makePercept(makeHero(1000, 0, 'bullwark', { x: 48, z: 48, hp: 200, maxHp: 720 })),
    );
    expect(orders(low)).toContainEqual({ c: 'order', kind: 'move', x: 11, z: 11 });
    // 50% hp: the latch holds — still retreating.
    const mid = brain.tick(
      makePercept(makeHero(1000, 0, 'bullwark', { x: 30, z: 30, hp: 360, maxHp: 720 })),
    );
    expect(orders(mid)).toContainEqual({ c: 'order', kind: 'move', x: 11, z: 11 });
    // 85% hp at the fountain: latch releases, no more fountain move.
    const healed = brain.tick(
      makePercept(makeHero(1000, 0, 'bullwark', { x: 11, z: 11, hp: 612, maxHp: 720 }), {
        atFountain: true,
      }),
    );
    expect(orders(healed).some((o) => o.kind === 'move')).toBe(false);
  });

  it('team 1 retreats to the reversed path endpoint', () => {
    const brain = createBotBrain(1, 'bullwark');
    const cmds = brain.tick(
      makePercept(makeHero(1000, 1, 'bullwark', { x: 48, z: 48, hp: 100, maxHp: 720 })),
    );
    expect(orders(cmds)).toContainEqual({ c: 'order', kind: 'move', x: 85, z: 85 });
  });
});

describe('last-hitting', () => {
  it('issues an attack command on a last-hittable enemy creep in range', () => {
    const brain = createBotBrain(7, 'longbow');
    const self = makeHero(1000, 0, 'longbow', {
      x: 40,
      z: 40,
      hp: 540,
      maxHp: 540,
      attackRange: 10,
      damage: 48,
    });
    // 30hp < 48 * 0.85: under the threshold for every seeded slop draw.
    const creep = makeEnt({ id: 1001, kind: 'melee', team: 1, lane: 0, x: 44, z: 40, hp: 30, maxHp: 450, radius: 0.42 });
    const cmds = brain.tick(makePercept(self, { visible: [creep] }));
    expect(cmds).toContainEqual({ c: 'order', kind: 'attack', target: 1001 });
  });

  it('attack-moves instead when no creep is last-hittable', () => {
    const brain = createBotBrain(7, 'longbow');
    const self = makeHero(1000, 0, 'longbow', {
      x: 40,
      z: 40,
      hp: 540,
      maxHp: 540,
      attackRange: 10,
      damage: 48,
    });
    const fat = makeEnt({ id: 1001, kind: 'melee', team: 1, lane: 0, x: 44, z: 40, hp: 400, maxHp: 450, radius: 0.42 });
    const cmds = brain.tick(makePercept(self, { visible: [fat] }));
    expect(cmds.some((c) => c.c === 'order' && c.kind === 'attack')).toBe(false);
    expect(orders(cmds).some((o) => o.kind === 'attackmove')).toBe(true);
  });
});

describe('fountain actions', () => {
  it('buys the next build-order item at the fountain with gold', () => {
    const brain = createBotBrain(3, 'reaver');
    const self = makeHero(1000, 0, 'reaver', { x: 11, z: 11, gold: 500 });
    const cmds = brain.tick(makePercept(self, { atFountain: true }));
    expect(cmds).toContainEqual({ c: 'buy', item: 'bladestone' });
  });

  it('advances down the build order as items are owned', () => {
    const brain = createBotBrain(3, 'reaver');
    const self = makeHero(1000, 0, 'reaver', {
      x: 11,
      z: 11,
      gold: 700,
      items: ['bladestone', null, null, null, null, null],
    });
    const cmds = brain.tick(makePercept(self, { atFountain: true }));
    expect(cmds).toContainEqual({ c: 'buy', item: 'fang' });
  });

  it('buys a recipe target component-first, then combines once components are held', () => {
    // Ranged-carry opens with stormbow, which combines from bladestone + 400g:
    // with nothing held, the component is the purchase, not the stormbow.
    const brain = createBotBrain(3, 'longbow');
    const empty = makeHero(1000, 0, 'longbow', { x: 11, z: 11, gold: 800 });
    expect(brain.tick(makePercept(empty, { atFountain: true }))).toContainEqual({
      c: 'buy',
      item: 'bladestone',
    });
    // Component held: the next buy is the combine itself (400g recipe cost).
    const holding = makeHero(1000, 0, 'longbow', {
      x: 11,
      z: 11,
      gold: 400,
      items: ['bladestone', null, null, null, null, null],
    });
    expect(brain.tick(makePercept(holding, { atFountain: true }))).toContainEqual({
      c: 'buy',
      item: 'stormbow',
    });
  });

  it('does not emit a buy away from the fountain or without gold', () => {
    const brain = createBotBrain(3, 'reaver');
    const poor = makeHero(1000, 0, 'reaver', { x: 11, z: 11, gold: 100 });
    expect(
      brain.tick(makePercept(poor, { atFountain: true })).some((c) => c.c === 'buy'),
    ).toBe(false);
    const rich = makeHero(1000, 0, 'reaver', { x: 48, z: 48, gold: 900 });
    expect(
      brain.tick(makePercept(rich, { atFountain: false })).some((c) => c.c === 'buy'),
    ).toBe(false);
  });
});

describe('skill points', () => {
  it('spends a point on q first (q > w > e)', () => {
    const brain = createBotBrain(5, 'hex');
    const self = makeHero(1000, 0, 'hex', { skillPoints: 1, level: 1 });
    const cmds = brain.tick(makePercept(self));
    expect(cmds).toContainEqual({ c: 'skill', slot: 0 });
  });

  it('takes the ult whenever legal (level 6, rank 0)', () => {
    const brain = createBotBrain(5, 'hex');
    const self = makeHero(1000, 0, 'hex', {
      skillPoints: 1,
      level: 6,
      abilityRanks: [1, 0, 0, 0],
    });
    const cmds = brain.tick(makePercept(self));
    expect(cmds).toContainEqual({ c: 'skill', slot: 3 });
  });

  it('backs off a silently-refused slot instead of wedging on it', () => {
    const brain = createBotBrain(5, 'hex');
    // Rank 4 q is at maxRank; sim would also refuse over-cap ranks — the brain
    // must rotate to w rather than re-emit q forever.
    const self = makeHero(1000, 0, 'hex', {
      skillPoints: 1,
      level: 5,
      abilityRanks: [4, 0, 0, 0],
    });
    const cmds = brain.tick(makePercept(self));
    expect(cmds).toContainEqual({ c: 'skill', slot: 1 });
  });
});

describe('support warding', () => {
  const menderAt = (x: number, z: number): Ent =>
    makeHero(1000, 0, 'mender', {
      x,
      z,
      items: ['wardstone', null, null, null, null, null],
      itemCharges: [2, 0, 0, 0, 0, 0],
    });

  it('places a ward at the lane-mid waypoint when stock > 0', () => {
    const brain = createBotBrain(9, 'mender');
    const cmds = brain.tick(makePercept(menderAt(46, 46), { wardStock: 1 }));
    expect(cmds).toContainEqual({ c: 'item', slot: 0, x: 48, z: 48 });
  });

  it('never attempts a ward with zero team stock', () => {
    const brain = createBotBrain(9, 'mender');
    const cmds = brain.tick(makePercept(menderAt(46, 46), { wardStock: 0 }));
    expect(cmds.some((c) => c.c === 'item')).toBe(false);
  });

  it('skips warding when an own ward already covers lane mid', () => {
    const brain = createBotBrain(9, 'mender');
    const ward = makeEnt({ id: 1002, kind: 'ward', team: 0, x: 48, z: 48 });
    const cmds = brain.tick(makePercept(menderAt(46, 46), { wardStock: 2, visible: [ward] }));
    expect(cmds.some((c) => c.c === 'item')).toBe(false);
  });
});

describe('fortify discipline', () => {
  const towerAt = (hp: number): Ent =>
    makeEnt({
      id: 7,
      kind: 'tower',
      team: 1,
      lane: 0,
      x: 55,
      z: 55,
      hp,
      maxHp: 1400,
      radius: 1.2,
    });

  it('holds outside range of a fortified tower instead of hitting it', () => {
    const brain = createBotBrain(11, 'reaver');
    // Self 12.5m from the tower (inside attackRange 10.5 + margin 2.5), no own
    // creeps anywhere -> fortify would proc, so the bot must not close in.
    const self = makeHero(1000, 0, 'reaver', { x: 46.16, z: 46.16, hp: 640, maxHp: 640 });
    const cmds = brain.tick(makePercept(self, { visible: [towerAt(1400)] }));
    expect(cmds.some((c) => c.c === 'order' && c.kind === 'attack' && c.target === 7)).toBe(false);
    const os = orders(cmds);
    expect(os).toHaveLength(1);
    const o = os[0];
    expect(o?.kind).toBe('attackmove');
    if (o?.kind === 'attackmove') {
      // Hold point sits outside tower attack range (10.5m).
      const d = Math.sqrt((o.x - 55) ** 2 + (o.z - 55) ** 2);
      expect(d).toBeGreaterThan(10.5);
    }
  });

  it('pushes a fortified tower under 15% hp (finishing blow is legal)', () => {
    const brain = createBotBrain(11, 'reaver');
    const self = makeHero(1000, 0, 'reaver', { x: 46.16, z: 46.16, hp: 640, maxHp: 640 });
    const cmds = brain.tick(makePercept(self, { visible: [towerAt(140)] })); // 10%
    const os = orders(cmds);
    // Not held back: it advances (attack-move forward, no hold computed).
    expect(os).toHaveLength(1);
    const o = os[0];
    if (o?.kind === 'attackmove') {
      const d = Math.sqrt((o.x - 55) ** 2 + (o.z - 55) ** 2);
      // The hold point would sit exactly 11.5m from the tower; any other
      // advance targets the lane ahead / the wave, not a standoff ring.
      expect(Math.abs(d - 11.5)).toBeGreaterThan(0.01);
    } else {
      expect.unreachable('expected an attackmove order');
    }
  });

  it('pushes a tower when own creeps are inside FORTIFY_RADIUS of it', () => {
    const brain = createBotBrain(11, 'reaver');
    const self = makeHero(1000, 0, 'reaver', { x: 46.16, z: 46.16, hp: 640, maxHp: 640 });
    const escort = makeEnt({ id: 1003, kind: 'melee', team: 0, lane: 0, x: 52, z: 52, hp: 450, maxHp: 450 });
    const cmds = brain.tick(makePercept(self, { visible: [towerAt(1400), escort] }));
    const os = orders(cmds);
    expect(os).toHaveLength(1);
    expect(os[0]?.kind).toBe('attackmove');
    if (os[0]?.kind === 'attackmove') {
      // Shadows the foremost own creep (at the tower), no standoff.
      expect(os[0].x).toBe(52);
      expect(os[0].z).toBe(52);
    }
  });
});

describe('archetype casting', () => {
  it('mage nukes the lowest-hp enemy hero in range', () => {
    const brain = createBotBrain(13, 'hex');
    const self = makeHero(1000, 0, 'hex', {
      x: 40,
      z: 40,
      hp: 520,
      maxHp: 520,
      mana: 380,
      abilityRanks: [1, 0, 0, 0], // hex_q: unit, range 10, cost 60
    });
    const far = makeHero(2001, 1, 'longbow', { x: 70, z: 70, hp: 100, maxHp: 540 }); // out of range
    const near = makeHero(2002, 1, 'reaver', { x: 45, z: 40, hp: 300, maxHp: 640 });
    const cmds = brain.tick(makePercept(self, { visible: [far, near] }));
    expect(cmds).toContainEqual({ c: 'cast', slot: 0, target: 2002 });
  });

  it('support heals the lowest ally under 60%', () => {
    const brain = createBotBrain(13, 'mender');
    const self = makeHero(1000, 0, 'mender', {
      x: 40,
      z: 40,
      hp: 560,
      maxHp: 560,
      mana: 360,
      abilityRanks: [1, 0, 0, 0], // mender_q: unit/ally heal, range 9
    });
    const hurt = makeHero(1001, 0, 'bullwark', { x: 44, z: 40, hp: 200, maxHp: 720 }); // 27.8%
    const fine = makeHero(1002, 0, 'reaver', { x: 42, z: 40, hp: 600, maxHp: 640 });
    const cmds = brain.tick(makePercept(self, { visible: [hurt, fine] }));
    expect(cmds).toContainEqual({ c: 'cast', slot: 0, target: 1001 });
  });

  it('tank dashes in when >= 2 enemies are within dash range', () => {
    const brain = createBotBrain(13, 'bullwark');
    const self = makeHero(1000, 0, 'bullwark', {
      x: 40,
      z: 40,
      hp: 720,
      maxHp: 720,
      mana: 280,
      abilityRanks: [1, 0, 0, 0], // bullwark_q: point dash, range 7
    });
    const e1 = makeHero(2001, 1, 'longbow', { x: 44, z: 40, hp: 540, maxHp: 540 });
    const e2 = makeHero(2002, 1, 'hex', { x: 40, z: 44, hp: 520, maxHp: 520 });
    const cmds = brain.tick(makePercept(self, { visible: [e1, e2] }));
    const cast = cmds.find((c) => c.c === 'cast');
    expect(cast).toMatchObject({ c: 'cast', slot: 0 });
    if (cast?.c === 'cast') {
      // Centroid of the two enemies.
      expect(cast.x).toBeCloseTo(42, 6);
      expect(cast.z).toBeCloseTo(42, 6);
    }
  });

  it('assassin strikes a slowed or isolated target', () => {
    const brain = createBotBrain(13, 'shade');
    const self = makeHero(1000, 0, 'shade', {
      x: 40,
      z: 40,
      hp: 580,
      maxHp: 580,
      mana: 260,
      abilityRanks: [1, 0, 0, 0], // shade_q: unit dash strike, range 7
    });
    const iso = makeHero(2001, 1, 'longbow', { x: 44, z: 40, hp: 540, maxHp: 540 });
    const cmds = brain.tick(makePercept(self, { visible: [iso], tick: 50 }));
    expect(cmds).toContainEqual({ c: 'cast', slot: 0, target: 2001 });
  });

  it('carries cast on cooldown during engagements', () => {
    const brain = createBotBrain(13, 'longbow');
    const self = makeHero(1000, 0, 'longbow', {
      x: 40,
      z: 40,
      hp: 540,
      maxHp: 540,
      mana: 240,
      abilityRanks: [1, 0, 0, 0], // longbow_q: point pierce, range 14
    });
    const enemy = makeHero(2001, 1, 'reaver', { x: 46, z: 40, hp: 640, maxHp: 640 });
    const cmds = brain.tick(makePercept(self, { visible: [enemy] }));
    const cast = cmds.find((c) => c.c === 'cast');
    expect(cast).toMatchObject({ c: 'cast', slot: 0, x: 46, z: 40 });
  });

  it('never casts a passive or an unskilled ability', () => {
    const brain = createBotBrain(13, 'longbow');
    // Only the passive w has "rank" — nothing castable.
    const self = makeHero(1000, 0, 'longbow', {
      x: 40,
      z: 40,
      hp: 540,
      maxHp: 540,
      mana: 240,
      abilityRanks: [0, 1, 0, 0],
    });
    const enemy = makeHero(2001, 1, 'reaver', { x: 46, z: 40, hp: 640, maxHp: 640 });
    const cmds = brain.tick(makePercept(self, { visible: [enemy] }));
    expect(cmds.some((c) => c.c === 'cast')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Jungle (DESIGN_DELTA §2). All coordinates are on the 1-lane map: the
// anti-diagonal x + z = 96 is the half boundary, team 0's base is (11, 11).
// The bot carries no ability ranks in these cases, so nothing casts and the
// order under test is the only order emitted.
// ---------------------------------------------------------------------------
describe('jungle behaviour', () => {
  /** Healthy, level 6, mid-lane, own half, nothing contesting. */
  const jungler = (over?: Partial<Ent>): Ent =>
    makeHero(1000, 0, 'reaver', { x: 40, z: 40, hp: 640, maxHp: 640, level: 6, ...over });

  it('walks a healthy bot with a safe lane to an up camp in its own half', () => {
    const brain = createBotBrain(21, 'reaver');
    const cmds = brain.tick(
      makePercept(jungler(), { camps: makeCamps({ tier: 'pack', x: 30, z: 46 }) }),
    );
    expect(cmds).toContainEqual({ c: 'order', kind: 'attackmove', x: 30, z: 46 });
  });

  it('stays in lane when an enemy wave is pushing it', () => {
    const brain = createBotBrain(21, 'reaver');
    // 5.7 m away, inside LANE_PRESSURE_RADIUS, and far too healthy to last-hit.
    const wave = makeEnt({ id: 1001, kind: 'melee', team: 1, lane: 0, x: 44, z: 44, hp: 400, maxHp: 450, radius: 0.42 });
    const cmds = brain.tick(
      makePercept(jungler(), {
        visible: [wave],
        camps: makeCamps({ tier: 'pack', x: 30, z: 46 }),
      }),
    );
    expect(ordersToward(cmds, 30, 46)).toBe(false);
    expect(orders(cmds).some((o) => o.kind === 'attackmove')).toBe(true);
  });

  it('stays in lane when an enemy hero is inside the engagement radius', () => {
    const brain = createBotBrain(21, 'reaver');
    const foe = makeHero(2001, 1, 'longbow', { x: 48, z: 44, hp: 540, maxHp: 540 });
    const cmds = brain.tick(
      makePercept(jungler(), { visible: [foe], camps: makeCamps({ tier: 'pack', x: 30, z: 46 }) }),
    );
    expect(ordersToward(cmds, 30, 46)).toBe(false);
  });

  it('does not leave lane below the jungle hp bar, even above the retreat bar', () => {
    const brain = createBotBrain(21, 'reaver');
    // 50%: past RETREAT_HP (32%) so it is not retreating, under JUNGLE_MIN_HP.
    const cmds = brain.tick(
      makePercept(jungler({ hp: 320 }), { camps: makeCamps({ tier: 'pack', x: 30, z: 46 }) }),
    );
    expect(ordersToward(cmds, 30, 46)).toBe(false);
    expect(orders(cmds).some((o) => o.kind === 'attackmove')).toBe(true);
  });

  it('ignores a camp in the enemy half', () => {
    const brain = createBotBrain(21, 'reaver');
    // 28.3 m away — inside JUNGLE_MAX_DIST, so only the half rule can reject it.
    const cmds = brain.tick(
      makePercept(jungler(), { camps: makeCamps({ tier: 'pack', x: 60, z: 60 }) }),
    );
    expect(ordersToward(cmds, 60, 60)).toBe(false);
  });

  it('mirrors the half rule for team 1', () => {
    const brain = createBotBrain(21, 'reaver');
    const self = makeHero(1000, 1, 'reaver', { x: 56, z: 56, hp: 640, maxHp: 640, level: 6 });
    const own = brain.tick(makePercept(self, { camps: makeCamps({ tier: 'pack', x: 66, z: 50 }) }));
    expect(own).toContainEqual({ c: 'order', kind: 'attackmove', x: 66, z: 50 });
    const other = createBotBrain(21, 'reaver');
    const across = other.tick(
      makePercept(self, { camps: makeCamps({ tier: 'pack', x: 30, z: 46 }) }),
    );
    expect(ordersToward(across, 30, 46)).toBe(false);
  });

  it('ignores a camp beyond the detour distance', () => {
    const brain = createBotBrain(21, 'reaver');
    // (14, 20) is own-half but 32.8 m from (40, 40).
    const cmds = brain.tick(
      makePercept(jungler(), { camps: makeCamps({ tier: 'pack', x: 14, z: 20 }) }),
    );
    expect(ordersToward(cmds, 14, 20)).toBe(false);
  });

  it('ignores a camp that is already cleared', () => {
    const brain = createBotBrain(21, 'reaver');
    const cmds = brain.tick(
      makePercept(jungler(), { camps: makeCamps({ tier: 'pack', x: 30, z: 46, up: false }) }),
    );
    expect(ordersToward(cmds, 30, 46)).toBe(false);
  });

  it('never sends a level-1 bot into a hive, and sends a level-6 one', () => {
    const camps = makeCamps({ tier: 'hive', x: 30, z: 46 });
    const rookie = createBotBrain(21, 'reaver');
    expect(
      ordersToward(rookie.tick(makePercept(jungler({ level: 1 }), { camps })), 30, 46),
    ).toBe(false);
    const veteran = createBotBrain(21, 'reaver');
    expect(
      ordersToward(veteran.tick(makePercept(jungler({ level: 6 }), { camps })), 30, 46),
    ).toBe(true);
  });

  it('gates each tier on its own level: pack at 2, brute at 4, hive at 6', () => {
    const at = (level: number, tier: CampPercept['tier']): boolean =>
      ordersToward(
        createBotBrain(21, 'reaver').tick(
          makePercept(jungler({ level }), { camps: makeCamps({ tier, x: 30, z: 46 }) }),
        ),
        30,
        46,
      );
    expect([at(1, 'pack'), at(2, 'pack')]).toEqual([false, true]);
    expect([at(3, 'brute'), at(4, 'brute')]).toEqual([false, true]);
    expect([at(5, 'hive'), at(6, 'hive')]).toEqual([false, true]);
  });

  it('prefers the richest tier its level allows over the nearest camp', () => {
    const brain = createBotBrain(21, 'reaver');
    // brute is FARTHEST (14.4 m vs 8.9 and 11.7) and still wins: camp gold is
    // brute 132 > hive 115 > pack 76, so tier rank beats proximity.
    const camps = makeCamps(
      { tier: 'hive', x: 32, z: 44 },
      { tier: 'pack', x: 30, z: 46 },
      { tier: 'brute', x: 28, z: 48 },
    );
    const cmds = brain.tick(makePercept(jungler(), { camps }));
    expect(cmds).toContainEqual({ c: 'order', kind: 'attackmove', x: 28, z: 48 });
  });

  it('drops to the best tier the level allows when the richest is out of reach', () => {
    const brain = createBotBrain(21, 'reaver');
    const camps = makeCamps(
      { tier: 'hive', x: 32, z: 44 },
      { tier: 'pack', x: 30, z: 46 },
      { tier: 'brute', x: 28, z: 48 },
    );
    // Level 5: brute (4) and pack (2) are legal, hive (6) is not.
    const cmds = brain.tick(makePercept(jungler({ level: 5 }), { camps }));
    expect(cmds).toContainEqual({ c: 'order', kind: 'attackmove', x: 28, z: 48 });
    const rookie = createBotBrain(21, 'reaver');
    // Level 3: only the pack is legal.
    const low = rookie.tick(makePercept(jungler({ level: 3 }), { camps }));
    expect(low).toContainEqual({ c: 'order', kind: 'attackmove', x: 30, z: 46 });
  });

  it('does not re-issue the camp order once the bot is already walking there', () => {
    const brain = createBotBrain(21, 'reaver');
    const camps = makeCamps({ tier: 'pack', x: 30, z: 46 });
    expect(brain.tick(makePercept(jungler(), { camps, tick: 100 }))).toContainEqual({
      c: 'order',
      kind: 'attackmove',
      x: 30,
      z: 46,
    });
    // Second tick: the sim has taken the order, so the bot must not repath.
    const enRoute = jungler({ x: 36, z: 42, order: 'attackmove', ox: 30, oz: 46 });
    const again = brain.tick(makePercept(enRoute, { camps, tick: 101 }));
    expect(orders(again)).toHaveLength(0);
  });

  it('re-issues the camp order when the standing order points somewhere else', () => {
    const brain = createBotBrain(21, 'reaver');
    const camps = makeCamps({ tier: 'pack', x: 30, z: 46 });
    brain.tick(makePercept(jungler(), { camps, tick: 100 }));
    // Still an attackmove, but at the lane destination it had before — the
    // destination, not the order kind, is what decides a repath.
    const stale = jungler({ x: 36, z: 42, order: 'attackmove', ox: 48, oz: 48 });
    expect(brain.tick(makePercept(stale, { camps, tick: 101 }))).toContainEqual({
      c: 'order',
      kind: 'attackmove',
      x: 30,
      z: 46,
    });
  });

  it('sticks to the camp it committed to when a richer one comes up', () => {
    const brain = createBotBrain(21, 'reaver');
    const camps = makeCamps(
      { tier: 'pack', x: 30, z: 46 },
      { tier: 'brute', x: 28, z: 48, up: false },
    );
    expect(brain.tick(makePercept(jungler(), { camps, tick: 100 }))).toContainEqual({
      c: 'order',
      kind: 'attackmove',
      x: 30,
      z: 46,
    });
    const richer = camps[1];
    if (!richer) expect.unreachable('camp table lost its entry');
    else richer.up = true;
    // Without the commitment the bot would turn around mid-walk every time a
    // better camp respawned and clear nothing.
    const enRoute = jungler({ x: 34, z: 44, order: 'attackmove', ox: 30, oz: 46 });
    const next = brain.tick(makePercept(enRoute, { camps, tick: 101 }));
    expect(ordersToward(next, 28, 48)).toBe(false);
  });

  it('re-issues the camp order if the sim dropped it', () => {
    const brain = createBotBrain(21, 'reaver');
    const camps = makeCamps({ tier: 'pack', x: 30, z: 46 });
    brain.tick(makePercept(jungler(), { camps, tick: 100 }));
    const stunned = jungler({ x: 36, z: 42, order: 'idle', ox: 0, oz: 0 });
    expect(brain.tick(makePercept(stunned, { camps, tick: 101 }))).toContainEqual({
      c: 'order',
      kind: 'attackmove',
      x: 30,
      z: 46,
    });
  });

  it('returns to lane the moment the camp is cleared', () => {
    const brain = createBotBrain(21, 'reaver');
    const camps = makeCamps({ tier: 'pack', x: 30, z: 46 });
    const atCamp = jungler({ x: 30, z: 46, order: 'attackmove', ox: 30, oz: 46 });
    brain.tick(makePercept(atCamp, { camps, tick: 100 }));
    // The room flips `up` in place on the SAME object it handed out.
    const held = camps[0];
    if (!held) expect.unreachable('camp table lost its entry');
    else held.up = false;
    const back = brain.tick(makePercept(atCamp, { camps, tick: 101 }));
    expect(ordersToward(back, 30, 46)).toBe(false);
    expect(orders(back).some((o) => o.kind === 'attackmove')).toBe(true);
  });

  it('holds the lane for the relane window before taking the next camp', () => {
    const brain = createBotBrain(21, 'reaver');
    const camps = makeCamps(
      { tier: 'pack', x: 30, z: 46 },
      { tier: 'pack', x: 34, z: 50 },
    );
    const atCamp = jungler({ x: 30, z: 46, order: 'attackmove', ox: 30, oz: 46 });
    brain.tick(makePercept(atCamp, { camps, tick: 100 }));
    const cleared = camps[0];
    if (!cleared) expect.unreachable('camp table lost its entry');
    else cleared.up = false;
    brain.tick(makePercept(atCamp, { camps, tick: 101 })); // commitment released
    // 399 ticks later (< JUNGLE_RELANE_TICKS = 400): still laning.
    expect(ordersToward(brain.tick(makePercept(atCamp, { camps, tick: 500 })), 34, 50)).toBe(false);
    // 400 ticks later: free to take the second camp.
    expect(ordersToward(brain.tick(makePercept(atCamp, { camps, tick: 501 })), 34, 50)).toBe(true);
  });

  it('routes to a real camp from the real 1-lane terrain table', () => {
    // The synthetic coordinates above pin the rules; this pins that the rules
    // fire at all against the camps terrain.ts actually places.
    const own = T1.camps.filter((c) => c.half === 0);
    expect(own.length).toBeGreaterThan(0);
    const target = own[0];
    if (!target) return expect.unreachable('no team-0 camp on the 1-lane map');
    const brain = createBotBrain(21, 'reaver');
    const self = makeHero(1000, 0, 'reaver', {
      x: target.x,
      z: target.z - 6,
      hp: 640,
      maxHp: 640,
      level: 6,
    });
    const camps = T1.camps.map((c) => ({ id: c.id, tier: c.tier, x: c.x, z: c.z, up: true }));
    const cmds = brain.tick(makePercept(self, { camps }));
    // The order must land on a team-0 CLEARING, not on the lane. Camps sit at
    // least CAMP_LANE_CLEARANCE (14 m) off every polyline, so no lane order can
    // satisfy this by accident — which is the whole point of asserting it here
    // rather than asserting "some attackmove".
    expect(
      orders(cmds).some(
        (o) =>
          o.kind === 'attackmove' && own.some((c) => c.x === o.x && c.z === o.z),
      ),
    ).toBe(true);
  });

  it('is deterministic across a camp-bearing percept stream', () => {
    const build = (): BotPercept[] => {
      const camps = makeCamps(
        { tier: 'pack', x: 30, z: 46 },
        { tier: 'brute', x: 28, z: 48 },
      );
      const out: BotPercept[] = [];
      for (let t = 0; t < 250; t++) {
        const first = camps[0];
        const second = camps[1];
        if (!first || !second) throw new Error('camp table lost an entry');
        first.up = t % 60 < 35;
        second.up = t % 90 < 40;
        out.push(
          makePercept(
            makeHero(1000, 0, 'reaver', {
              x: 38 + (t % 7),
              z: 40 + (t % 5),
              hp: 640 - (t % 30) * 8,
              maxHp: 640,
              level: 1 + (t % 8),
            }),
            // The room hands out ONE table per match, mutated in place; the
            // brain must snapshot nothing from it.
            { tick: t, camps: camps.map((c) => ({ ...c })) },
          ),
        );
      }
      return out;
    };
    const a = createBotBrain(77, 'reaver');
    const b = createBotBrain(77, 'reaver');
    const streamA = build();
    const streamB = build();
    const outA = streamA.map((p) => a.tick(p));
    const outB = streamB.map((p) => b.tick(p));
    expect(outA).toEqual(outB);
    expect(outA.some((cmds) => ordersToward(cmds, 28, 48) || ordersToward(cmds, 30, 46))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// High ground (DESIGN_DELTA §1). Terrain never goes on the wire: the brain
// rebuilds it from the lane count, which is `paths.length`.
// ---------------------------------------------------------------------------
describe('high-ground awareness', () => {
  it('disengages from low ground against a hero on high ground', () => {
    const { a: low, b: high } = findPair(ELEV_LOW, ELEV_HIGH);
    const brain = createBotBrain(31, 'reaver');
    const self = makeHero(1000, 0, 'reaver', { x: low.x, z: low.z, hp: 640, maxHp: 640 });
    const foe = makeHero(2001, 1, 'longbow', { x: high.x, z: high.z, hp: 540, maxHp: 540 });
    const cmds = brain.tick(makePercept(self, { visible: [foe] }));
    expect(orders(cmds)).toContainEqual({ c: 'order', kind: 'move', x: 11, z: 11 });
  });

  it('contests the same one-on-one on level ground', () => {
    const { a: low, b: alsoLow } = findPair(ELEV_LOW, ELEV_LOW);
    const brain = createBotBrain(31, 'reaver');
    const self = makeHero(1000, 0, 'reaver', { x: low.x, z: low.z, hp: 640, maxHp: 640 });
    const foe = makeHero(2001, 1, 'longbow', { x: alsoLow.x, z: alsoLow.z, hp: 540, maxHp: 540 });
    const cmds = brain.tick(makePercept(self, { visible: [foe] }));
    expect(orders(cmds).some((o) => o.kind === 'move')).toBe(false);
  });

  it('does not disengage when it is the one holding the high ground', () => {
    const { a: high, b: low } = findPair(ELEV_HIGH, ELEV_LOW);
    const brain = createBotBrain(31, 'reaver');
    const self = makeHero(1000, 0, 'reaver', { x: high.x, z: high.z, hp: 640, maxHp: 640 });
    const foe = makeHero(2001, 1, 'longbow', { x: low.x, z: low.z, hp: 540, maxHp: 540 });
    const cmds = brain.tick(makePercept(self, { visible: [foe] }));
    expect(orders(cmds).some((o) => o.kind === 'move')).toBe(false);
  });

  it('does not disengage when both sides are on the high ground', () => {
    // The rule is a HEIGHT DIFFERENCE, not "an enemy stands somewhere high":
    // level high ground carries no miss penalty either way.
    const { a: high, b: alsoHigh } = findPair(ELEV_HIGH, ELEV_HIGH);
    const brain = createBotBrain(31, 'reaver');
    const self = makeHero(1000, 0, 'reaver', { x: high.x, z: high.z, hp: 640, maxHp: 640 });
    const foe = makeHero(2001, 1, 'longbow', {
      x: alsoHigh.x,
      z: alsoHigh.z,
      hp: 540,
      maxHp: 540,
    });
    const cmds = brain.tick(makePercept(self, { visible: [foe] }));
    expect(orders(cmds).some((o) => o.kind === 'move')).toBe(false);
  });

  it('reads elevation from the lane count its own percept carries', () => {
    // A point that is HIGH on the 1-lane map and LOW on the 3-lane map. A brain
    // that rebuilt terrain from a fixed lane count would read this enemy as
    // level ground and stand its ground on a hill it is under.
    const { a: low, b: high } = findPair(
      ELEV_LOW,
      ELEV_HIGH,
      (b) => elevationAt(T3, b.x, b.z) === ELEV_LOW,
    );
    const brain = createBotBrain(31, 'reaver');
    const self = makeHero(1000, 0, 'reaver', { x: low.x, z: low.z, hp: 640, maxHp: 640 });
    const foe = makeHero(2001, 1, 'longbow', { x: high.x, z: high.z, hp: 540, maxHp: 540 });
    const cmds = brain.tick(makePercept(self, { visible: [foe] }));
    expect(orders(cmds)).toContainEqual({ c: 'order', kind: 'move', x: 11, z: 11 });
  });

  it('an ally on the spot pays for the uphill body', () => {
    const { a: low, b: high } = findPair(ELEV_LOW, ELEV_HIGH);
    const brain = createBotBrain(31, 'reaver');
    const self = makeHero(1000, 0, 'reaver', { x: low.x, z: low.z, hp: 640, maxHp: 640 });
    const foe = makeHero(2001, 1, 'longbow', { x: high.x, z: high.z, hp: 540, maxHp: 540 });
    const ally = makeHero(1002, 0, 'bullwark', { x: low.x + 1, z: low.z, hp: 720, maxHp: 720 });
    const cmds = brain.tick(makePercept(self, { visible: [foe, ally] }));
    expect(orders(cmds).some((o) => o.kind === 'move')).toBe(false);
  });

  it('skips the uphill weighting entirely when there are no enemy heroes near', () => {
    const { a: low } = findPair(ELEV_LOW, ELEV_HIGH);
    const brain = createBotBrain(31, 'reaver');
    const self = makeHero(1000, 0, 'reaver', { x: low.x, z: low.z, hp: 640, maxHp: 640 });
    const cmds = brain.tick(makePercept(self));
    expect(orders(cmds).some((o) => o.kind === 'move')).toBe(false);
  });
});

describe('neutral-team guard', () => {
  it('emits nothing for a self that is not on a player team', () => {
    const brain = createBotBrain(41, 'reaver');
    const neutral = makeEnt({
      id: 1500,
      kind: 'campBrute',
      team: NEUTRAL_TEAM,
      x: 30,
      z: 46,
      hp: 470,
      maxHp: 470,
      skillPoints: 1,
      gold: 5000,
      level: 6,
    });
    expect(brain.tick(makePercept(neutral, { atFountain: true }))).toEqual([]);
  });
});
