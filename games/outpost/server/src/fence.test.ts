// ============================================================================
// fence.ts tests — locks the DESIGN_BIBLE clocks down numerically (a brute
// alone opens a segment in ~4.6s, two shamblers in ~7.3s; a full repair of a
// destroyed-but-unbreached segment costs 112 scrap / 12.3s, rebuilding a
// breached one costs 168 / 24.6s) rather than trusting a constant read back,
// plus the CONTRACT.md invariants: breach clears every zombie's targetSeg,
// repair is all-or-nothing on affordability, fenceSolids only ever returns
// intact AABBs, and nearestSegment measures wall distance, not centre.
// ============================================================================
import { describe, expect, it } from 'vitest';
import { makeBody } from '@fps/shared';
import type { AABB } from '@fps/shared';
import {
  ECONOMY,
  FENCE,
  SEGMENTS,
  SIM_HZ,
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
  Survivor,
  Zombie,
} from '@outpost/shared';
import { damageSegment, fenceSolids, nearestSegment, repairSegment } from './fence.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeSegment(id: SegmentId, overrides: Partial<FenceSegment> = {}): FenceSegment {
  return {
    id,
    hp: FENCE.segmentHp,
    maxHp: FENCE.segmentHp,
    breached: false,
    rebuild: 0,
    sinceHit: 0,
    ...overrides,
  };
}

function makeSurvivor(id: PlayerId, scrap: number): Survivor {
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
    scrap,
    weapons: ['knife', 'pistol'],
    weapon: 'pistol',
    ammo: new Map(),
    reloadUntil: 0,
    nextShotAt: 0,
    bloom: 0,
    shotSeq: 0,
    interacting: false,
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
  };
}

function makeZombie(id: number, targetSeg: SegmentId, alive = true): Zombie {
  const base = ZOMBIE_BASE.shambler;
  return {
    id,
    kind: 'shambler',
    alive,
    hp: base.hp,
    maxHp: base.hp,
    body: makeBody(0, 0, 0),
    yaw: 0,
    height: base.height,
    radius: base.radius,
    speed: base.speed,
    state: 'attackFence',
    targetSeg,
    targetPlayer: null,
    retargetAt: 0,
    attackCooldown: 0,
    spitCooldown: 0,
    dyingFor: 0,
    gait: 0,
  };
}

interface TestCtx extends SimContext {
  events: OutpostEvent[];
  rebuildCalls: number;
}

function makeCtx(segments: FenceSegment[], zombies: Zombie[] = []): TestCtx {
  const events: OutpostEvent[] = [];
  const solids: AABB[] = [];
  const ctx: TestCtx = {
    tick: 0,
    dt: TICK_DT,
    serverTime: 0,
    phase: 'wave',
    wave: 1,
    survivors: new Map(),
    zombies,
    segments,
    spits: [],
    staticSolids: [],
    solids,
    rand: () => 0.5,
    emit: (ev) => events.push(ev),
    rebuildSolids: () => {
      ctx.rebuildCalls += 1;
    },
    events,
    rebuildCalls: 0,
  };
  return ctx;
}

/** Ticks `repairSegment` until it stops making progress. Returns totals. */
function repairToCompletion(
  ctx: TestCtx,
  s: Survivor,
  seg: SegmentId,
  maxTicks: number,
): { ticks: number; totalHp: number; totalScrap: number } {
  const segment = ctx.segments[seg];
  if (!segment) throw new Error('missing segment');
  const startScrap = s.scrap;
  let ticks = 0;
  let totalHp = 0;
  while (segment.hp < segment.maxHp && ticks < maxTicks) {
    const before = segment.hp;
    repairSegment(ctx, s, seg);
    totalHp += segment.hp - before;
    ticks++;
  }
  return { ticks, totalHp, totalScrap: startScrap - s.scrap };
}

// ---------------------------------------------------------------------------
// The fence clock (DESIGN_BIBLE "The fence clock")
// ---------------------------------------------------------------------------

describe('damageSegment — DESIGN_BIBLE clock targets', () => {
  it('one brute alone opens a segment in ~4.6s of continuous contact (320 hp / 70 dps)', () => {
    const seg = makeSegment(0);
    const ctx = makeCtx([seg]);
    const perTick = ZOMBIE_BASE.brute.fenceDps * TICK_DT;

    let ticks = 0;
    while (!seg.breached && ticks < 10 * SIM_HZ) {
      damageSegment(ctx, 0, perTick);
      ticks++;
    }

    expect(seg.breached).toBe(true);
    expect(seg.hp).toBe(0);
    expect(ticks / SIM_HZ).toBeCloseTo(4.6, 1);
  });

  it('two shamblers together open a segment in ~7.3s (320 hp / 44 combined dps)', () => {
    const seg = makeSegment(0);
    const ctx = makeCtx([seg]);
    const perTick = ZOMBIE_BASE.shambler.fenceDps * 2 * TICK_DT;

    let ticks = 0;
    while (!seg.breached && ticks < 10 * SIM_HZ) {
      damageSegment(ctx, 0, perTick);
      ticks++;
    }

    expect(seg.breached).toBe(true);
    expect(ticks / SIM_HZ).toBeCloseTo(7.3, 1);
  });
});

describe('damageSegment — breach behaviour', () => {
  it('clears targetSeg on every ALIVE zombie pointing at the segment that breaches, and leaves others alone', () => {
    const seg = makeSegment(0, { hp: 1 });
    const targeting1 = makeZombie(0, 0);
    const targeting2 = makeZombie(1, 0);
    const targetingOther = makeZombie(2, 1);
    const deadTargeting = makeZombie(3, 0, false);
    const ctx = makeCtx([seg, makeSegment(1)], [targeting1, targeting2, targetingOther, deadTargeting]);

    damageSegment(ctx, 0, 50);

    expect(seg.breached).toBe(true);
    expect(targeting1.targetSeg).toBe(-1);
    expect(targeting2.targetSeg).toBe(-1);
    expect(targetingOther.targetSeg).toBe(1); // untouched — different segment
    expect(deadTargeting.targetSeg).toBe(0); // untouched — not alive, must not be scanned as live state
  });

  it('emits seg_breached and calls ctx.rebuildSolids() exactly once on the breaching hit', () => {
    const seg = makeSegment(0, { hp: 10 });
    const ctx = makeCtx([seg]);

    damageSegment(ctx, 0, 5); // hp -> 5, no breach yet
    expect(seg.breached).toBe(false);
    expect(ctx.rebuildCalls).toBe(0);

    damageSegment(ctx, 0, 5); // hp -> 0, breaches
    expect(seg.breached).toBe(true);
    expect(ctx.rebuildCalls).toBe(1);
    expect(ctx.events).toContainEqual({ t: 'seg_breached', seg: 0 });
  });

  it('emits seg_hit with the post-damage hp on every non-breaching hit', () => {
    const seg = makeSegment(0, { hp: 100 });
    const ctx = makeCtx([seg]);
    damageSegment(ctx, 0, 30);
    expect(ctx.events).toContainEqual({ t: 'seg_hit', seg: 0, hp: 70 });
    expect(seg.sinceHit).toBe(0);
  });

  it('is a no-op on an already-breached segment: no further hp loss, no duplicate breach event', () => {
    const seg = makeSegment(0, { hp: 0, breached: true });
    const ctx = makeCtx([seg]);
    damageSegment(ctx, 0, 999);
    expect(seg.hp).toBe(0);
    expect(ctx.events).toHaveLength(0);
    expect(ctx.rebuildCalls).toBe(0);
  });

  it('is a no-op for a non-positive damage amount', () => {
    const seg = makeSegment(0, { hp: 100 });
    const ctx = makeCtx([seg]);
    damageSegment(ctx, 0, 0);
    damageSegment(ctx, 0, -5);
    expect(seg.hp).toBe(100);
    expect(ctx.events).toHaveLength(0);
  });

  it('is a no-op for an out-of-range segment id', () => {
    const ctx = makeCtx([makeSegment(0)]);
    expect(() => damageSegment(ctx, 7, 50)).not.toThrow();
    expect(ctx.events).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Repair economy (DESIGN_BIBLE "Economy pacing (solo)")
// ---------------------------------------------------------------------------

describe('repairSegment — DESIGN_BIBLE economy targets', () => {
  it('fully repairing one destroyed (unbreached) segment costs 112 scrap and ~12.3s', () => {
    const seg = makeSegment(0, { hp: 0, breached: false });
    const ctx = makeCtx([seg]);
    const s = makeSurvivor('p1', 100_000);

    const { ticks, totalHp, totalScrap } = repairToCompletion(ctx, s, 0, 60 * SIM_HZ);

    expect(seg.hp).toBe(FENCE.segmentHp);
    expect(seg.breached).toBe(false);
    expect(totalHp).toBeCloseTo(FENCE.segmentHp, 5);
    expect(totalScrap).toBeCloseTo(FENCE.segmentHp * ECONOMY.repairScrapPerHp, 5);
    expect(totalScrap).toBeCloseTo(112, 5);
    expect(ticks / SIM_HZ).toBeCloseTo(12.3, 1);
  });

  it('rebuilding a breached segment costs 168 scrap and ~24.6s, and un-breaches only at full hp', () => {
    const seg = makeSegment(0, { hp: 0, breached: true });
    const ctx = makeCtx([seg]);
    const s = makeSurvivor('p1', 100_000);

    let sawStillBreachedMidway = false;
    let ticks = 0;
    while (seg.hp < seg.maxHp && ticks < 60 * SIM_HZ) {
      repairSegment(ctx, s, 0);
      if (seg.hp > 0 && seg.hp < seg.maxHp) sawStillBreachedMidway = seg.breached === true;
      ticks++;
    }

    expect(seg.hp).toBe(FENCE.segmentHp);
    expect(seg.breached).toBe(false);
    expect(sawStillBreachedMidway).toBe(true); // hp climbed from 0 while still breached
    expect(100_000 - s.scrap).toBeCloseTo(FENCE.segmentHp * ECONOMY.repairScrapPerHp * ECONOMY.rebuildCostMul, 5);
    expect(100_000 - s.scrap).toBeCloseTo(168, 5);
    expect(ticks / SIM_HZ).toBeCloseTo(24.6, 1);
    expect(ctx.rebuildCalls).toBe(1); // called once, on the un-breach transition
    expect(ctx.events).toContainEqual({ t: 'seg_repaired', seg: 0, byId: 'p1', full: true });
  });

  it('restores hp and tracks it on the survivor run stats (repairHp)', () => {
    const seg = makeSegment(0, { hp: 50 });
    const ctx = makeCtx([seg]);
    const s = makeSurvivor('p1', 100_000);
    const before = s.repairHp;
    const restored = repairSegment(ctx, s, 0);
    expect(restored).toBeGreaterThan(0);
    expect(s.repairHp - before).toBeCloseTo(restored, 5);
  });
});

describe('repairSegment — edge cases', () => {
  it('insufficient scrap restores nothing and charges nothing', () => {
    const seg = makeSegment(0, { hp: 50 });
    const ctx = makeCtx([seg]);
    const s = makeSurvivor('p1', 0);

    const restored = repairSegment(ctx, s, 0);

    expect(restored).toBe(0);
    expect(seg.hp).toBe(50);
    expect(s.scrap).toBe(0);
    expect(ctx.events).toHaveLength(0);
  });

  it('a partially-affordable tick restores nothing (all-or-nothing, never a partial charge)', () => {
    const seg = makeSegment(0, { hp: 0, breached: false });
    const ctx = makeCtx([seg]);
    const fullTickCost = ECONOMY.repairHpPerSec * ctx.dt * ECONOMY.repairScrapPerHp;
    const s = makeSurvivor('p1', fullTickCost / 2);

    const restored = repairSegment(ctx, s, 0);

    expect(restored).toBe(0);
    expect(seg.hp).toBe(0);
    expect(s.scrap).toBeCloseTo(fullTickCost / 2, 8);
  });

  it('an already-full, unbreached segment costs nothing and restores nothing', () => {
    const seg = makeSegment(0, { hp: FENCE.segmentHp, breached: false });
    const ctx = makeCtx([seg]);
    const s = makeSurvivor('p1', 100_000);
    const restored = repairSegment(ctx, s, 0);
    expect(restored).toBe(0);
    expect(s.scrap).toBe(100_000);
    expect(ctx.events).toHaveLength(0);
  });

  it('never overshoots maxHp on the final tick even with abundant scrap', () => {
    // hpRoom (0.1) is deliberately smaller than one tick's normal repair rate
    // (ECONOMY.repairHpPerSec * TICK_DT ~= 0.867), so the clamp to hpRoom is
    // the only thing standing between this tick and an overshoot past maxHp.
    const seg = makeSegment(0, { hp: FENCE.segmentHp - 0.1 });
    const ctx = makeCtx([seg]);
    const s = makeSurvivor('p1', 100_000);
    repairSegment(ctx, s, 0);
    expect(seg.hp).toBe(FENCE.segmentHp);
  });

  it('is a no-op for an out-of-range segment id', () => {
    const ctx = makeCtx([makeSegment(0)]);
    const s = makeSurvivor('p1', 100_000);
    expect(repairSegment(ctx, s, 9)).toBe(0);
    expect(s.scrap).toBe(100_000);
  });
});

// ---------------------------------------------------------------------------
// fenceSolids
// ---------------------------------------------------------------------------

describe('fenceSolids', () => {
  it('returns the AABB of every intact segment, in segment order, and none for breached ones', () => {
    const segments = SEGMENTS.map((geom, i) => makeSegment(i, { breached: i % 3 === 0 }));
    const result = fenceSolids(segments);

    const expectedIds = segments.filter((s) => !s.breached).map((s) => s.id);
    expect(result).toHaveLength(expectedIds.length);
    expectedIds.forEach((id, i) => {
      const geom = SEGMENTS[id];
      expect(geom).toBeDefined();
      if (geom) expect(result[i]).toEqual(segmentAABB(geom));
    });
  });

  it('returns an empty array when every segment is breached', () => {
    const segments = SEGMENTS.map((geom, i) => makeSegment(i, { breached: true }));
    expect(fenceSolids(segments)).toEqual([]);
  });

  it('returns one AABB per segment when all are intact', () => {
    const segments = SEGMENTS.map((geom, i) => makeSegment(i));
    expect(fenceSolids(segments)).toHaveLength(SEGMENTS.length);
  });
});

// ---------------------------------------------------------------------------
// nearestSegment
// ---------------------------------------------------------------------------

describe('nearestSegment', () => {
  it('finds the exact segment when the point sits on that segment\'s wall centre', () => {
    const geom4 = SEGMENTS[4];
    expect(geom4).toBeDefined();
    if (!geom4) return;
    const result = nearestSegment(geom4.cx, geom4.cz);
    expect(result.seg).toBe(4);
    expect(result.dist).toBeCloseTo(0, 8);
  });

  it('agrees with a brute-force scan using segmentDistance over every point tested', () => {
    const points: Array<[number, number]> = [
      [0, -19],
      [18, 3],
      [-17, -17],
      [0, 0],
      [3, 21],
      [-20.5, -4],
      [40, 40],
      [-40, 5],
    ];
    for (const [x, z] of points) {
      let bestId = 0;
      let bestDist = Infinity;
      for (const geom of SEGMENTS) {
        const d = segmentDistance(x, z, geom);
        if (d < bestDist) {
          bestDist = d;
          bestId = geom.id;
        }
      }
      const result = nearestSegment(x, z);
      expect(result.seg).toBe(bestId);
      expect(result.dist).toBeCloseTo(bestDist, 8);
    }
  });

  it('measures perpendicular wall distance, not centre-point distance — a point beyond the span clamps to the endpoint', () => {
    const geom0 = SEGMENTS[0]; // north side, cx=-15, cz=-20, spans x in [-20,-10]
    expect(geom0).toBeDefined();
    if (!geom0) return;
    // Standing at the firing step (across = 0.875 per CONTRACT.md), well along
    // the segment (x = -12, still inside the 10 m span) must read a SMALL
    // distance, not the ~5+ m a centre-point reading would produce.
    const result = nearestSegment(-12, -20.875);
    expect(result.seg).toBe(0);
    expect(result.dist).toBeCloseTo(0.875, 5);
  });
});
