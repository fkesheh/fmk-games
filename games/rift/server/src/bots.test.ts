// ============================================================================
// server/src/bots.test.ts (T6) — bot brain determinism + scripted scenarios.
// Ents and percepts are plain data built per the frozen sim seam (makeEnt /
// makePercept); no world, no room. The 1-lane test path mirrors buildMap(1):
// side 96, team-0 ancient at (BASE_INSET, BASE_INSET), mid at (48, 48).
// ============================================================================
import { describe, expect, it } from 'vitest';
import type { EntKind, HeroId, TeamId } from '@rift/shared';
import { NO_ENT } from './sim/types.js';
import type { BotCommand, BotPercept, Ent } from './sim/types.js';
import { createBotBrain } from './bots.js';

// 1-lane map geometry: [(11,11) -> (48,48) -> (85,85)], team 1 walks it reversed.
const PATH = [
  { x: 11, z: 11 },
  { x: 48, z: 48 },
  { x: 85, z: 85 },
] as const;

function makeEnt(over: Partial<Ent> & { id: number; kind: EntKind; team: TeamId }): Ent {
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
    wardStock: 0,
    atFountain: false,
    overtime: false,
    ...over,
  };
}

function makeHero(id: number, team: TeamId, hero: HeroId, over?: Partial<Ent>): Ent {
  return makeEnt({ id, kind: 'hero', team, hero, ...over });
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
