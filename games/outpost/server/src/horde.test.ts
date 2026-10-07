// ============================================================================
// horde.ts tests — the CONTRACT.md invariants this module is responsible
// for: a zombie walks the ring-to-fence approach and stops at reach (never
// through an intact segment), separation keeps two zombies from stacking on
// one point, a breach forces an immediate retarget away from the segment
// that just breached, the pool returns -1 once HORDE.maxAlive is reached and
// frees a slot when a corpse retires, a spitter's glob arcs under gravity
// and lands, and targetPlayer is nulled the instant its survivor dies.
// ============================================================================
import { describe, expect, it } from 'vitest';
import { makeBody } from '@fps/shared';
import type { AABB } from '@fps/shared';
import {
  FENCE,
  FENCE_HALF,
  HORDE,
  NOISE_HEARD_S,
  NOISE_RADIUS_M,
  SEGMENTS,
  SIM_HZ,
  SPIT,
  STATIC_SOLIDS,
  TICK_DT,
  ZOMBIE_BASE,
  segmentAABB,
  segmentDistance,
} from '@outpost/shared';
import type {
  FenceSegment,
  OutpostEvent,
  PlayerId,
  SegmentId,
  SimContext,
  Spit,
  Survivor,
  Zombie,
} from '@outpost/shared';
import { pushNoise, spawnZombie, stepHorde, stepSpits } from './horde.js';

// ---------------------------------------------------------------------------
// Fixtures — mirrors the pattern in fence.test.ts: plain object builders, no
// shared test-util module (there isn't one), a fake SimContext that records
// emitted events and rebuildSolids() calls.
// ---------------------------------------------------------------------------

function makeSegment(id: SegmentId, overrides: Partial<FenceSegment> = {}): FenceSegment {
  return { id, hp: FENCE.segmentHp, maxHp: FENCE.segmentHp, breached: false, rebuild: 0, sinceHit: 0, ...overrides };
}

function makeSurvivor(id: PlayerId, overrides: Partial<Survivor> = {}): Survivor {
  return {
    id,
    name: 'test',
    connected: true,
    sig: null,
    body: makeBody(0, 0, 0),
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
    shotSeq: 0,
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

/** A free (not-yet-spawned) pool slot, as room.ts would preallocate it. */
function makePoolZombie(id: number): Zombie {
  return {
    id,
    kind: 'shambler',
    alive: false,
    hp: 0,
    maxHp: 0,
    body: makeBody(0, 0, 0),
    yaw: 0,
    height: 0,
    radius: 0,
    speed: 0,
    state: 'approach',
    targetSeg: -1,
    targetPlayer: null,
    retargetAt: 0,
    attackCooldown: 0,
    spitCooldown: 0,
    dyingFor: 0,
    gait: 0,
  };
}

/** An already-alive zombie, for tests that drive stepHorde directly. */
function makeLiveZombie(id: number, overrides: Partial<Zombie> = {}): Zombie {
  const base = ZOMBIE_BASE.shambler;
  return {
    id,
    kind: 'shambler',
    alive: true,
    hp: base.hp,
    maxHp: base.hp,
    body: makeBody(0, 0, 0),
    yaw: 0,
    height: base.height,
    radius: base.radius,
    speed: base.speed,
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

interface TestCtx extends SimContext {
  events: OutpostEvent[];
  rebuildCalls: number;
}

function makeCtx(opts: {
  zombies?: Zombie[];
  segments?: FenceSegment[];
  survivors?: Survivor[];
  spits?: Spit[];
  solids?: AABB[];
  serverTime?: number;
  wave?: number;
  rand?: () => number;
} = {}): TestCtx {
  const events: OutpostEvent[] = [];
  const survivors = new Map<PlayerId, Survivor>();
  for (const s of opts.survivors ?? []) survivors.set(s.id, s);
  const solids: AABB[] = opts.solids ?? [];
  const ctx: TestCtx = {
    tick: 0,
    dt: TICK_DT,
    serverTime: opts.serverTime ?? 0,
    phase: 'wave',
    wave: opts.wave ?? 1,
    survivors,
    zombies: opts.zombies ?? [],
    segments: opts.segments ?? SEGMENTS.map((g) => makeSegment(g.id)),
    spits: opts.spits ?? [],
    staticSolids: [],
    solids,
    rand: opts.rand ?? (() => 0.5),
    emit: (ev) => events.push(ev),
    rebuildSolids: () => {
      ctx.rebuildCalls += 1;
    },
    events,
    rebuildCalls: 0,
  };
  return ctx;
}

// ---------------------------------------------------------------------------
// spawnZombie
// ---------------------------------------------------------------------------

describe('spawnZombie', () => {
  it('claims a free pool slot and places the zombie on the treeline ring', () => {
    const zombies = [makePoolZombie(0), makePoolZombie(1)];
    const ctx = makeCtx({ zombies });

    const id = spawnZombie(ctx, 'runner', 3);
    expect(id).toBe(0);

    const z = ctx.zombies[0]!;
    expect(z.alive).toBe(true);
    expect(z.kind).toBe('runner');
    const dist = Math.hypot(z.body.x, z.body.z);
    expect(dist).toBeCloseTo(HORDE.spawnRing, 3);
  });

  it('returns -1 once every pool slot is alive (pool exhaustion)', () => {
    const zombies = [makePoolZombie(0), makePoolZombie(1)];
    zombies[0]!.alive = true;
    zombies[1]!.alive = true;
    const ctx = makeCtx({ zombies });

    expect(spawnZombie(ctx, 'shambler', 1)).toBe(-1);
  });
});

// ---------------------------------------------------------------------------
// stepHorde — approach + fence contact
// ---------------------------------------------------------------------------

describe('stepHorde — approach and fence contact', () => {
  it('a zombie walks from the ring to the fence and stops at reach, never through it', () => {
    const solids = [...STATIC_SOLIDS, ...SEGMENTS.map(segmentAABB)];
    const zombies = [makePoolZombie(0)];
    const ctx = makeCtx({ zombies, solids });

    const id = spawnZombie(ctx, 'shambler', 1);
    expect(id).toBe(0);

    for (let t = 0; t < 1500; t++) {
      ctx.serverTime += TICK_DT * 1000;
      stepHorde(ctx);
    }

    const z = ctx.zombies[0]!;
    expect(z.state).toBe('attackFence');
    expect(z.targetSeg).toBeGreaterThanOrEqual(0);

    const geom = SEGMENTS[z.targetSeg]!;
    const base = ZOMBIE_BASE.shambler;
    const wallDist = segmentDistance(z.body.x, z.body.z, geom);
    expect(wallDist).toBeLessThanOrEqual(base.meleeReach + 0.05);

    const insideCompound = Math.abs(z.body.x) < FENCE_HALF && Math.abs(z.body.z) < FENCE_HALF;
    expect(insideCompound).toBe(false);
  });

  it('separation keeps two zombies aimed at the same spot from occupying the same point', () => {
    const solids = [...STATIC_SOLIDS, ...SEGMENTS.map(segmentAABB)];
    const z0 = makeLiveZombie(0, { body: makeBody(0, 0, -40), targetSeg: 1 });
    const z1 = makeLiveZombie(1, { body: makeBody(0, 0, -40), targetSeg: 1 });
    const ctx = makeCtx({ zombies: [z0, z1], solids });

    for (let t = 0; t < 300; t++) {
      ctx.serverTime += TICK_DT * 1000;
      stepHorde(ctx);
    }

    const dist = Math.hypot(z0.body.x - z1.body.x, z0.body.z - z1.body.z);
    expect(dist).toBeGreaterThan(0.3);
  });

  it('breaching its target segment forces a retarget off that segment', () => {
    const segments = SEGMENTS.map((g) => makeSegment(g.id));
    segments[0]!.breached = true;
    const z = makeLiveZombie(0, { body: makeBody(0, 0, -58), targetSeg: 0, state: 'attackFence' });
    const ctx = makeCtx({ zombies: [z], segments, solids: [] });

    stepHorde(ctx);

    expect(z.targetSeg).not.toBe(0);
    expect(z.targetSeg).toBeGreaterThanOrEqual(0);
    // the segment it moved to had better still be intact
    const reassigned = ctx.segments[z.targetSeg]!;
    expect(reassigned.breached).toBe(false);
  });

  it('targetPlayer is nulled the tick that survivor dies', () => {
    const survivor = makeSurvivor('p1');
    const z = makeLiveZombie(0, {
      body: makeBody(0, 0, 0),
      targetPlayer: 'p1',
      state: 'pursue',
      retargetAt: 1_000_000, // throttle would otherwise skip a fresh retarget this tick
    });
    const ctx = makeCtx({ zombies: [z], survivors: [survivor], solids: [] });

    survivor.status = 'dead';
    stepHorde(ctx);

    expect(z.targetPlayer).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Melee reach is 3D, not a ground-plane radius
//
// REGRESSION: melee used the same horizontal `hypot(dx, dz)` the pursuit and
// separation code uses, so a zombie standing in the mud at the tower footing
// was "in reach" of a survivor 8 m above it on the spawn deck and clawed
// them to death there. The e2e caught it as a squad wipe during a sweep from
// the deck, which is exactly the vantage config.ts calls melee-safe
// ("spitters break turtling on the top deck").
// ---------------------------------------------------------------------------

describe('stepHorde — melee reach respects height', () => {
  const meleeTicks = Math.ceil(ZOMBIE_BASE.shambler.meleeInterval / TICK_DT) + 2;

  /** Runs `meleeTicks` of stepHorde with one zombie parked next to one survivor. */
  function meleeRun(survivorY: number): { hp: number; state: Zombie['state'] } {
    const survivor = makeSurvivor('p1', { body: makeBody(0, survivorY, 0) });
    const z = makeLiveZombie(0, {
      body: makeBody(0.8, 0, 0), // 0.8 m away horizontally — well inside meleeReach
      targetPlayer: 'p1',
      state: 'pursue',
      retargetAt: 1_000_000, // keep the staged target; don't let retarget rewrite it
    });
    const ctx = makeCtx({ zombies: [z], survivors: [survivor], solids: [] });
    for (let t = 0; t < meleeTicks; t++) stepHorde(ctx);
    return { hp: survivor.hp, state: z.state };
  }

  it('a zombie at ground level mauls a survivor standing next to it', () => {
    const ground = meleeRun(0);
    expect(ground.state).toBe('attackPlayer');
    expect(ground.hp).toBeLessThan(100);
  });

  it('the SAME zombie cannot touch a survivor 8 m up on the tower deck', () => {
    const deck = meleeRun(8);
    expect(deck.hp).toBe(100);
    expect(deck.state).not.toBe('attackPlayer');
  });

  it('a survivor one small riser up (the 0.4 m fence footing) is still hittable', () => {
    const footing = meleeRun(0.4);
    expect(footing.state).toBe('attackPlayer');
    expect(footing.hp).toBeLessThan(100);
  });

  it('a survivor below the zombie by more than a body height is out of reach too', () => {
    // Inverted case: the zombie is the one up high. Only ONE tick is run —
    // with no solid under it a zombie at y=5 is in free fall and lands on
    // the survivor within half a second, which is the sim behaving
    // correctly, not melee reaching down 5 m.
    const survivor = makeSurvivor('p1', { body: makeBody(0, 0, 0) });
    const z = makeLiveZombie(0, {
      body: makeBody(0.8, 5, 0),
      targetPlayer: 'p1',
      state: 'pursue',
      retargetAt: 1_000_000,
    });
    const ctx = makeCtx({ zombies: [z], survivors: [survivor], solids: [] });
    stepHorde(ctx);

    expect(survivor.hp).toBe(100);
    expect(z.state).not.toBe('attackPlayer');
  });
});

// ---------------------------------------------------------------------------
// Corpse retirement
// ---------------------------------------------------------------------------

describe('stepHorde — corpse retirement', () => {
  it('a corpse frees its pool slot after HORDE.corpseSec, ready for reuse', () => {
    const z = makeLiveZombie(0, { state: 'dying', dyingFor: 0, hp: 0 });
    const ctx = makeCtx({ zombies: [z] });

    const ticksToRetire = Math.ceil(HORDE.corpseSec / TICK_DT) + 2;
    for (let t = 0; t < ticksToRetire; t++) stepHorde(ctx);

    expect(z.alive).toBe(false);
    expect(spawnZombie(ctx, 'shambler', 1)).toBe(0);
  });

  it('does not retire before HORDE.corpseSec has elapsed', () => {
    const z = makeLiveZombie(0, { state: 'dying', dyingFor: 0, hp: 0 });
    const ctx = makeCtx({ zombies: [z] });

    const ticksShort = Math.floor(HORDE.corpseSec / TICK_DT / 2);
    for (let t = 0; t < ticksShort; t++) stepHorde(ctx);

    expect(z.alive).toBe(true);
    expect(z.state).toBe('dying');
  });
});

// ---------------------------------------------------------------------------
// stepSpits
// ---------------------------------------------------------------------------

describe('stepSpits', () => {
  it('a spit arcs under gravity and lands, damaging a nearby survivor and emitting spit_land', () => {
    const survivor = makeSurvivor('p1', { body: makeBody(0, 0, 0) });
    // launched straight up from just above the survivor: it must arc back
    // down under SPIT.gravity and land back on top of them.
    const spit: Spit = { id: 0, alive: true, x: 0, y: 3, z: 0, vx: 0, vy: 8, vz: 0, ttl: SPIT.ttlSec, ownerId: 0 };
    const ctx = makeCtx({ spits: [spit], survivors: [survivor], solids: [] });

    const startHp = survivor.hp;
    let landedAtTick = -1;
    for (let t = 0; t < 90 && landedAtTick < 0; t++) {
      stepSpits(ctx);
      if (!spit.alive) landedAtTick = t;
    }

    expect(landedAtTick).toBeGreaterThanOrEqual(0);
    expect(survivor.hp).toBeLessThan(startHp);
    expect(ctx.events.some((e) => e.t === 'spit_land')).toBe(true);
  });

  it('a spit that never lands fizzles out at its TTL without crashing', () => {
    // aimed straight up hard enough, with no target nearby, it will still
    // come back down eventually (gravity always wins) — this instead proves
    // TTL expiry works by starting it already almost expired.
    const spit: Spit = { id: 0, alive: true, x: 0, y: 50, z: 0, vx: 0, vy: 0, vz: 0, ttl: TICK_DT * 2, ownerId: 0 };
    const ctx = makeCtx({ spits: [spit], solids: [] });

    for (let t = 0; t < 5; t++) stepSpits(ctx);

    expect(spit.alive).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Gunshot noise — firing pulls outside zombies off the fence onto the shooter.
//
// Geometry shared by most tests: the shooter stands 5 m outside the north
// fence, the zombie 20 m further out — beyond HORDE.pursueRadius (quiet must
// NOT pull it) but inside NOISE_RADIUS_M (a fresh shot must). Each test uses
// a unique shooter id: the noise registry is module-level, so ids are the
// isolation boundary between tests.
// ---------------------------------------------------------------------------

describe('stepHorde — gunshot noise', () => {
  const heardTicks = NOISE_HEARD_S * SIM_HZ;
  const shooterZ = -(FENCE_HALF + 5);
  const zombieZ = -(FENCE_HALF + 25);
  const gap = Math.abs(zombieZ - shooterZ);

  function noiseCtx(shooterId: PlayerId) {
    const shooter = makeSurvivor(shooterId, { body: makeBody(0, 0, shooterZ) });
    const z = makeLiveZombie(0, { body: makeBody(0, 0, zombieZ) });
    return { ctx: makeCtx({ zombies: [z], survivors: [shooter], solids: [] }), z, shooter };
  }

  it('quiet far survivor keeps the fence target (behavior lock)', () => {
    expect(gap).toBeGreaterThan(HORDE.pursueRadius);
    expect(gap).toBeLessThanOrEqual(NOISE_RADIUS_M);
    const { ctx, z } = noiseCtx('n-quiet');

    stepHorde(ctx);

    expect(z.targetPlayer).toBeNull();
    expect(z.targetSeg).toBeGreaterThanOrEqual(0);
    expect(z.state).toBe('approach');
  });

  it('a fresh in-radius pulse retargets the zombie onto the shooter', () => {
    const { ctx, z } = noiseCtx('n-shooter');
    pushNoise({ x: 0, z: shooterZ, tick: ctx.tick, shooterId: 'n-shooter' });

    stepHorde(ctx);

    expect(z.targetPlayer).toBe('n-shooter');
    expect(z.targetSeg).toBe(-1);
    expect(z.state).toBe('pursue');
  });

  it('an out-of-radius pulse is ignored', () => {
    // Shooter on the SOUTH side (z=+25), zombie far north (z=-45): 70 m apart.
    const southZ = FENCE_HALF + 5;
    expect(Math.abs(zombieZ - southZ)).toBeGreaterThan(NOISE_RADIUS_M);
    const shooter = makeSurvivor('n-far', { body: makeBody(0, 0, southZ) });
    const z = makeLiveZombie(0, { body: makeBody(0, 0, zombieZ) });
    const ctx = makeCtx({ zombies: [z], survivors: [shooter], solids: [] });
    pushNoise({ x: 0, z: southZ, tick: ctx.tick, shooterId: 'n-far' });

    stepHorde(ctx);

    expect(z.targetPlayer).toBeNull();
    expect(z.targetSeg).toBeGreaterThanOrEqual(0);
  });

  it('an expired pulse falls back to the fence', () => {
    const { ctx, z } = noiseCtx('n-old');
    pushNoise({ x: 0, z: shooterZ, tick: ctx.tick, shooterId: 'n-old' });
    ctx.tick += heardTicks + 1;

    stepHorde(ctx);

    expect(z.targetPlayer).toBeNull();
    expect(z.targetSeg).toBeGreaterThanOrEqual(0);
  });

  it('a dead shooter\'s pulse is ignored', () => {
    const { ctx, z, shooter } = noiseCtx('n-dead');
    pushNoise({ x: 0, z: shooterZ, tick: ctx.tick, shooterId: 'n-dead' });
    shooter.status = 'dead';

    stepHorde(ctx);

    expect(z.targetPlayer).toBeNull();
    expect(z.targetSeg).toBeGreaterThanOrEqual(0);
  });

  it('the inside rule still hunts the nearest victim, not a noisy outsider', () => {
    const victim = makeSurvivor('n-victim', { body: makeBody(5, 0, 0) });
    const outsider = makeSurvivor('n-outsider', { body: makeBody(0, 0, shooterZ) });
    const z = makeLiveZombie(0, { body: makeBody(0, 0, 0) });
    const ctx = makeCtx({ zombies: [z], survivors: [victim, outsider], solids: [] });
    pushNoise({ x: 0, z: shooterZ, tick: ctx.tick, shooterId: 'n-outsider' });

    stepHorde(ctx);

    expect(z.targetPlayer).toBe('n-victim');
    expect(z.state).toBe('pursue');
  });

  it('the registry caps at 16 pulses, oldest-dropped', () => {
    // n-cap-0's pulse is pushed first, then 16 more; the first must be evicted.
    const { ctx, z } = noiseCtx('n-cap-0');
    pushNoise({ x: 0, z: shooterZ, tick: ctx.tick, shooterId: 'n-cap-0' });
    for (let i = 1; i <= 16; i++) {
      const id = `n-cap-${i}`;
      ctx.survivors.set(id, makeSurvivor(id, { body: makeBody(200 + i, 0, 200) }));
      pushNoise({ x: 200 + i, z: 200, tick: ctx.tick, shooterId: id });
    }

    stepHorde(ctx);

    expect(z.targetPlayer).toBeNull();
    expect(z.targetSeg).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// Gunshot MAGNET — an INSIDE shooter's shot bends outside-zombie wall choice
// toward the shot-side wall (v1 noise only serves outside shooters via direct
// pursue; defenders inside were unheard).
//
// Geometry (C1): zombie south-outside at (8,35), shooter inside at (15,5) —
// pulse-zombie gap 30.8 m, inside NOISE_RADIUS_M. Baseline scoring picks
// seg 8 (south, the nearer wall: 37.3 vs 39.7 for seg 7); the magnet must
// flip it to seg 6 (east, the shot-side wall: 59.3 vs 74.9 for seg 7).
// Scores hand-derived from the spec formula, not from implementation output.
//
// Tick isolation: the noise registry is module-level, so every test here runs
// on its own large ctx.tick (50000+) — all earlier tests' tick-0 pulses read
// as stale — with unique shooter ids.
// ---------------------------------------------------------------------------

describe('stepHorde — gunshot magnet (inside shooter)', () => {
  const heardTicks = NOISE_HEARD_S * SIM_HZ;

  /** C1 geometry. Shooter/pulse at (15,5), zombie at (8,35). */
  function magnetCtx(shooterId: PlayerId, tick: number) {
    const shooter = makeSurvivor(shooterId, { body: makeBody(15, 0, 5) });
    const z = makeLiveZombie(0, { body: makeBody(8, 0, 35) });
    const ctx = makeCtx({ zombies: [z], survivors: [shooter], solids: [] });
    ctx.tick = tick;
    return { ctx, z, shooter };
  }

  it('inside shot pulls a far zombie to the shot-side segment over the nearer wall', () => {
    const { ctx, z } = magnetCtx('m-flip', 50000);

    stepHorde(ctx); // quiet baseline first: nearer (south) wall wins
    expect(z.targetPlayer).toBeNull();
    expect(z.targetSeg).toBe(8);

    pushNoise({ x: 15, z: 5, tick: ctx.tick, shooterId: 'm-flip' });
    z.retargetAt = 0; // force a fresh retarget past the throttle
    stepHorde(ctx);

    expect(z.targetPlayer).toBeNull();
    expect(z.targetSeg).toBe(6);
  });

  it('an out-of-earshot zombie keeps the baseline choice', () => {
    // Zombie on the north ring (58 m from the inside pulse): beyond noise range.
    const mkZombie = () => makeLiveZombie(0, { body: makeBody(0, 0, -58) });
    const mkShooter = () => makeSurvivor('m-deaf', { body: makeBody(0, 0, 0) });
    expect(Math.hypot(0 - 0, -58 - 0)).toBeGreaterThan(NOISE_RADIUS_M);
    const quiet = makeCtx({ zombies: [mkZombie()], survivors: [mkShooter()], solids: [] });
    quiet.tick = 60000;
    const loud = makeCtx({ zombies: [mkZombie()], survivors: [mkShooter()], solids: [] });
    loud.tick = 60000;
    pushNoise({ x: 0, z: 0, tick: loud.tick, shooterId: 'm-deaf' });

    stepHorde(quiet);
    stepHorde(loud);

    expect(loud.zombies[0]!.targetSeg).toBe(quiet.zombies[0]!.targetSeg);
    expect(loud.zombies[0]!.targetPlayer).toBeNull();
  });

  it('an expired pulse falls back to the baseline choice', () => {
    const { ctx, z } = magnetCtx('m-old', 70000);
    pushNoise({ x: 15, z: 5, tick: ctx.tick, shooterId: 'm-old' });
    ctx.tick += heardTicks + 1;

    stepHorde(ctx);

    expect(z.targetPlayer).toBeNull();
    expect(z.targetSeg).toBe(8);
  });

  it('alternating shots from two walls hold a stable choice (no flip-flop)', () => {
    // Zombie north-outside (-8,-32); A shoots inside-west (-12,-10), B
    // inside-east (12,-10). Both in earshot (22.4 / 29.7 m). A-only and
    // A+B-fresh both score seg 0; B-only would score seg 2 — so a
    // latest-pulse-wins bug flops to 2 on the second shot while the
    // min-over-fresh magnet holds 0, flipping to 2 only once A expires.
    const a = makeSurvivor('m-alt-a', { body: makeBody(-12, 0, -10) });
    const b = makeSurvivor('m-alt-b', { body: makeBody(12, 0, -10) });
    const z = makeLiveZombie(0, { body: makeBody(-8, 0, -32) });
    const ctx = makeCtx({ zombies: [z], survivors: [a, b], solids: [] });
    ctx.tick = 80000;
    const retarget = () => {
      z.body.x = -8; // re-pin: movement between retargets must not move the scores
      z.body.z = -32;
      z.retargetAt = 0;
      stepHorde(ctx);
    };

    pushNoise({ x: -12, z: -10, tick: ctx.tick, shooterId: 'm-alt-a' });
    retarget();
    expect(z.targetSeg).toBe(0);

    pushNoise({ x: 12, z: -10, tick: ctx.tick, shooterId: 'm-alt-b' });
    retarget();
    expect(z.targetSeg).toBe(0);

    ctx.tick += heardTicks + 1; // A expired; only a fresh B remains
    pushNoise({ x: 12, z: -10, tick: ctx.tick, shooterId: 'm-alt-b' });
    retarget();
    expect(z.targetSeg).toBe(2);
  });

  it("a dead shooter's pulse still attracts (a place, not a target)", () => {
    // The magnet keys off the pulse POSITION with no liveness check: the shot
    // was heard from that direction, and the shooter dying afterwards does not
    // un-ring it. (v1 pursue DOES require liveness — it chases a living
    // person, while the magnet steers at a remembered place.) With the only
    // survivor dead, `near` is null: zombie-dist-only baseline would pick the
    // nearest spot (seg 9, 14.2 m), the magnet must still pick seg 6.
    const { ctx, z, shooter } = magnetCtx('m-dead', 90000);
    shooter.status = 'dead';
    pushNoise({ x: 15, z: 5, tick: ctx.tick, shooterId: 'm-dead' });

    stepHorde(ctx);

    expect(z.targetPlayer).toBeNull();
    expect(z.targetSeg).toBe(6);
  });
});
