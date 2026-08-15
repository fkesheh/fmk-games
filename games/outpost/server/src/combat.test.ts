// ============================================================================
// srv-combat tests. Every geometric assertion below is derived analytically
// from frozen @fps/shared constants (PLAYER.radius 0.3, HEAD_BOX_H 0.3,
// heightStand 1.8, eyeOffset 0.18 -> standing eye y = 1.62) rather than
// snapshotted, so a failure points at real math, not a stale golden value.
// ============================================================================
import { describe, expect, it } from 'vitest';
import { makeBody, WEAPONS, type AABB, type WeaponDef } from '@fps/shared';
import { type OutpostEvent, type SimContext, type Survivor, type Zombie } from '@outpost/shared';
import { resolveShot, zombieTargets, type ZombieTarget } from './combat.js';

type HitEvent = Extract<OutpostEvent, { t: 'hit' }>;
const isHit = (e: OutpostEvent): e is HitEvent => e.t === 'hit';

function makeCtx(
  zombies: Zombie[],
  solids: AABB[] = [],
  overrides: Partial<SimContext> = {},
): { ctx: SimContext; events: OutpostEvent[] } {
  const events: OutpostEvent[] = [];
  const ctx: SimContext = {
    tick: 1,
    dt: 1 / 30,
    serverTime: 0,
    phase: 'wave',
    wave: 1,
    survivors: new Map(),
    zombies,
    segments: [],
    spits: [],
    staticSolids: solids,
    solids,
    rand: () => 0.5,
    emit: (ev) => events.push(ev),
    rebuildSolids: () => {},
    ...overrides,
  };
  return { ctx, events };
}

function makeZombie(overrides: Partial<Zombie> = {}): Zombie {
  return {
    id: 0,
    kind: 'shambler',
    alive: true,
    hp: 90,
    maxHp: 90,
    body: makeBody(0, 0, -5),
    yaw: 0,
    height: 1.85,
    radius: 0.34,
    speed: 1.7,
    state: 'approach',
    targetSeg: -1,
    targetPlayer: null,
    retargetAt: 0,
    attackCooldown: 0,
    spitCooldown: 0,
    dyingFor: 0,
    gait: 0,
    ...overrides,
  };
}

function makeSurvivor(overrides: Partial<Survivor> = {}): Survivor {
  return {
    id: 'p1',
    name: 'Test',
    connected: true,
    sig: null,
    body: makeBody(0, 0, 0), // standing eye = (0, 1.62, 0), aiming yaw 0 / pitch 0 -> -Z
    yaw: 0,
    pitch: 0,
    hp: 100,
    status: 'alive',
    lastDamageAt: 0,
    bleedout: 0,
    reviveProgress: 0,
    reviveBy: null,
    returnAtWave: 0,
    scrap: 0,
    weapons: ['knife', 'pistol'],
    weapon: 'pistol',
    ammo: new Map(),
    reloadUntil: 0,
    nextShotAt: 0,
    bloom: 0,
    shotSeq: 1,
    interacting: false, scoped: false,
    interactKind: 'none',
    interactTarget: -1,
    reviveTargetId: null,
    kills: 0,
    headshots: 0,
    damageDealt: 0,
    repairHp: 0,
    revivesGiven: 0,
    timesDowned: 0,
    inputQueue: [],
    lastProcessedSeq: 0,
    lastInputAt: 0,
    prevButtons: 0,
    inputWindow: 0,
    inputWindowCount: 0,
    ...overrides,
  };
}

/** A weapon def with spread stripped so a straight shot is exact, not RNG-ish. */
function zeroSpread(def: WeaponDef, over: Partial<WeaponDef> = {}): WeaponDef {
  return { ...def, spreadDeg: 0, maxSpreadDeg: 0, spreadPerShot: 0, ...over };
}

describe('zombieTargets', () => {
  it('a dead zombie is not a valid target', () => {
    const alive = makeZombie({ id: 0 });
    const deadPoolSlot = makeZombie({ id: 1, alive: false });
    const dying = makeZombie({ id: 2, state: 'dying' });
    const { ctx } = makeCtx([alive, deadPoolSlot, dying]);

    const out: ZombieTarget[] = [];
    const result = zombieTargets(ctx, out);

    expect(result).toBe(out); // fills and returns the same array
    expect(out.map((t) => t.zid)).toEqual([0]);
  });
});

describe('scoped fire uses scopedSpreadDeg (the AWM was unusable without it)', () => {
  /** Fire the real sniper at a zombie 60 m down the -Z aim line, N times with
   *  distinct shot seeds, and count how many shots connect. */
  const hits = (scoped: boolean, shots = 40): number => {
    let n = 0;
    for (let i = 0; i < shots; i++) {
      const z = makeZombie({ id: 0, hp: 1_000_000, maxHp: 1_000_000, body: makeBody(0, 0, -60) });
      const { ctx, events } = makeCtx([z]);
      resolveShot(ctx, makeSurvivor({ weapon: 'sniper', shotSeq: i + 1, scoped }), WEAPONS.sniper);
      if (events.some(isHit)) n += 1;
    }
    return n;
  };

  it('scoped, the AWM lands every shot; unscoped its 8 deg cone lands almost none', () => {
    // spreadDeg 8 vs scopedSpreadDeg 0.05. At 60 m that is a ~8.4 m cone
    // against a ~5 cm one, on a 0.34 m radius target.
    const unscopedHits = hits(false);
    const scopedHits = hits(true);
    expect(scopedHits).toBe(40);
    expect(unscopedHits).toBeLessThan(4);
  });

  it('a weapon with no scope is unaffected by the flag', () => {
    // scopedSpreadDeg is null on every non-sniper, so holding right mouse must
    // not silently turn the AK into a laser.
    const z = makeZombie({ id: 0, hp: 10_000, maxHp: 10_000, body: makeBody(0, 0, -5) });
    const { ctx, events } = makeCtx([z]);
    const s = makeSurvivor({ weapon: 'rifle', scoped: true, bloom: WEAPONS.rifle.maxSpreadDeg });
    resolveShot(ctx, s, WEAPONS.rifle);
    expect(WEAPONS.rifle.scopedSpreadDeg).toBeNull();
    expect(events.some((e) => e.t === 'shot')).toBe(true);
  });
});

describe('resolveShot', () => {
  it('a pistol shot at a zombie 5m away kills or damages deterministically', () => {
    const zA = makeZombie({ id: 0, body: makeBody(0, 0, -5) });
    const { ctx: ctxA, events: evA } = makeCtx([zA], [], { tick: 42 });
    resolveShot(ctxA, makeSurvivor({ shotSeq: 5 }), WEAPONS.pistol);

    const zB = makeZombie({ id: 0, body: makeBody(0, 0, -5) });
    const { ctx: ctxB } = makeCtx([zB], [], { tick: 42 });
    resolveShot(ctxB, makeSurvivor({ shotSeq: 5 }), WEAPONS.pistol);

    expect(zA.hp).toBeLessThan(zA.maxHp);
    expect(zA.hp).toBe(zB.hp); // same (tick, shotSeq) -> same shotSeed -> same outcome
    expect(evA.some((e) => e.t === 'shot')).toBe(true);
    expect(evA.some(isHit)).toBe(true);
  });

  it('a wall between shooter and zombie blocks the shot', () => {
    const wall: AABB = { minX: -5, maxX: 5, minY: 0, maxY: 3, minZ: -3, maxZ: -2.5 };
    const z = makeZombie({ id: 0, body: makeBody(0, 0, -5) });
    const { ctx, events } = makeCtx([z], [wall]);

    resolveShot(ctx, makeSurvivor(), zeroSpread(WEAPONS.pistol));

    expect(z.hp).toBe(z.maxHp);
    expect(events.some(isHit)).toBe(false);
    expect(events.some((e) => e.t === 'shot')).toBe(true); // the trigger pull still fires
  });

  it('headshots multiply damage and scrap', () => {
    // Shambler head band is [height-0.3, height] = [1.55, 1.85]; the standing
    // eye (y=1.62) sits inside it at pitch 0, so this is a guaranteed headshot.
    const def = zeroSpread(WEAPONS.pistol, {
      damage: 50,
      headshotMul: 2,
      rangeStart: 100,
      rangeEnd: 200,
      minDmgMul: 1,
      pellets: 1,
    });
    const z = makeZombie({ id: 0, kind: 'shambler', height: 1.85, hp: 1000, maxHp: 1000, body: makeBody(0, 0, -5) });
    const { ctx, events } = makeCtx([z]);

    resolveShot(ctx, makeSurvivor(), def);

    const hit = events.find(isHit);
    expect(hit).toBeDefined();
    expect(hit?.headshot).toBe(true);
    expect(hit?.dmg).toBe(100); // 50 * headshotMul(2) * falloff(1)
    expect(z.hp).toBe(900);

    const died = events.find((e): e is Extract<OutpostEvent, { t: 'zombie_died' }> => e.t === 'zombie_died');
    expect(died).toBeUndefined(); // 1000 hp survives a single 100 dmg hit
  });

  it('falloff reduces damage at range', () => {
    // Brute head band is [2.2, 2.5]; the standing eye (y=1.62) never enters
    // it, so both shots below are guaranteed body hits at any distance —
    // isolating falloff from the headshot multiplier.
    const def = zeroSpread(WEAPONS.pistol, {
      damage: 100,
      headshotMul: 1,
      rangeStart: 8,
      rangeEnd: 30,
      minDmgMul: 0.25,
      pellets: 1,
    });

    // Body-box near face is (D - PLAYER.radius) from the shooter.
    // D=8  -> dist 7.7, <= rangeStart(8)  -> full damage.
    const near = makeZombie({ id: 0, kind: 'brute', height: 2.5, hp: 1000, maxHp: 1000, body: makeBody(0, 0, -8) });
    const { ctx: ctxNear, events: evNear } = makeCtx([near]);
    resolveShot(ctxNear, makeSurvivor(), def);

    // D=35 -> dist 34.7, >= rangeEnd(30) -> minDmgMul floor.
    const far = makeZombie({ id: 0, kind: 'brute', height: 2.5, hp: 1000, maxHp: 1000, body: makeBody(0, 0, -35) });
    const { ctx: ctxFar, events: evFar } = makeCtx([far]);
    resolveShot(ctxFar, makeSurvivor(), def);

    const hitNear = evNear.find(isHit);
    const hitFar = evFar.find(isHit);
    expect(hitNear).toBeDefined();
    expect(hitFar).toBeDefined();
    expect(hitNear?.headshot).toBe(false);
    expect(hitFar?.headshot).toBe(false);
    expect(hitNear?.dmg).toBe(100); // within rangeStart
    expect(hitFar?.dmg).toBe(25); // 100 * minDmgMul(0.25)
  });

  it('shotgun pellets are deterministic for a fixed seed', () => {
    function run(): { hp: number; totalDmg: number; hits: number } {
      const z = makeZombie({ id: 0, hp: 5000, maxHp: 5000, body: makeBody(0, 0, -5) });
      const { ctx, events } = makeCtx([z], [], { tick: 17 });
      resolveShot(ctx, makeSurvivor({ shotSeq: 9 }), WEAPONS.shotgun);
      const hitEvents = events.filter(isHit);
      const totalDmg = hitEvents.reduce((sum, e) => sum + e.dmg, 0);
      return { hp: z.hp, totalDmg, hits: hitEvents.length };
    }

    const a = run();
    const b = run();
    expect(a.hits).toBeGreaterThan(0); // sanity: some pellets connect at 5m
    expect(a).toEqual(b);
  });

  it('a dead zombie is not a valid target', () => {
    const dead = makeZombie({ id: 0, alive: false, hp: 0, body: makeBody(0, 0, -5) });
    const { ctx, events } = makeCtx([dead]);

    resolveShot(ctx, makeSurvivor(), zeroSpread(WEAPONS.pistol));

    expect(events.some(isHit)).toBe(false);
    expect(dead.hp).toBe(0);
  });

  it('awards assist scrap on a non-lethal hit and kill scrap (x headshotMul) on a lethal one', () => {
    const def = zeroSpread(WEAPONS.pistol, {
      damage: 40,
      headshotMul: 1,
      rangeStart: 100,
      rangeEnd: 200,
      minDmgMul: 1,
      pellets: 1,
    });
    // Brute body hit (see falloff test above) so headshotMul stays out of it.
    const z = makeZombie({ id: 0, kind: 'brute', height: 2.5, hp: 30, maxHp: 420, body: makeBody(0, 0, -8) });
    const { ctx, events } = makeCtx([z]);
    const s = makeSurvivor();

    resolveShot(ctx, s, def);

    expect(z.hp).toBe(0);
    expect(s.kills).toBe(1);
    expect(s.scrap).toBeGreaterThan(0);
    const died = events.find((e): e is Extract<OutpostEvent, { t: 'zombie_died' }> => e.t === 'zombie_died');
    expect(died).toBeDefined();
    expect(died?.byId).toBe(s.id);
  });
});
