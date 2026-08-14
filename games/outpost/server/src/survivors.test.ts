import { describe, test, expect } from 'vitest';
import { makeBody } from '@fps/shared';
import { DOWNED, FENCE, FEATURES, SEGMENTS } from '@outpost/shared';
import type { FenceSegment, FeaturePoint, OutpostEvent, PlayerId, SegmentGeom, SimContext, Survivor } from '@outpost/shared';
import { damageSurvivor, stepDowned, stepRevives, resolveInteract, isSquadWiped } from './survivors.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function at<T>(arr: readonly T[], i: number): T {
  const v = arr[i];
  if (v === undefined) throw new Error(`fixture index ${i} out of range`);
  return v;
}

function makeSurvivor(id: PlayerId): Survivor {
  return {
    id,
    name: id,
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

function makeSegments(): FenceSegment[] {
  return SEGMENTS.map((g) => ({ id: g.id, hp: FENCE.segmentHp, maxHp: FENCE.segmentHp, breached: false, rebuild: 0, sinceHit: 0 }));
}

interface CtxOpts {
  wave?: number;
  dt?: number;
  serverTime?: number;
  emit?: (ev: OutpostEvent) => void;
}

function makeCtx(opts: CtxOpts = {}): SimContext {
  return {
    tick: 0,
    dt: opts.dt ?? 1 / 30,
    serverTime: opts.serverTime ?? 0,
    phase: 'wave',
    wave: opts.wave ?? 1,
    survivors: new Map(),
    zombies: [],
    segments: makeSegments(),
    spits: [],
    staticSolids: [],
    solids: [],
    rand: () => 0,
    emit: opts.emit ?? (() => {}),
    rebuildSolids: () => {},
  };
}

function segGeom(id: number): SegmentGeom {
  return at(SEGMENTS, id);
}

function featurePoint(key: string): FeaturePoint {
  const f = FEATURES.find((p) => p.key === key);
  if (f === undefined) throw new Error(`no feature point '${key}'`);
  return f;
}

// ---------------------------------------------------------------------------
// damageSurvivor
// ---------------------------------------------------------------------------

describe('damageSurvivor', () => {
  test('alive survivor loses hp, credited is clamped to what was available', () => {
    const ctx = makeCtx();
    const s = makeSurvivor('p1');
    s.hp = 10;
    ctx.survivors.set(s.id, s);

    const credited = damageSurvivor(ctx, s, 50, null);

    expect(credited).toBe(10);
    expect(s.hp).toBe(0);
    expect(s.status).toBe('downed');
  });

  test('alive at <=0 hp goes downed with a full bleedout timer and emits downed', () => {
    const events: OutpostEvent[] = [];
    const ctx = makeCtx({ emit: (e) => events.push(e) });
    const s = makeSurvivor('p1');
    s.body.x = 5;
    s.body.y = 8;
    s.body.z = -3;
    ctx.survivors.set(s.id, s);

    damageSurvivor(ctx, s, 999, null);

    expect(s.status).toBe('downed');
    expect(s.bleedout).toBe(DOWNED.bleedoutSec);
    const downedEv = events.find((e) => e.t === 'downed');
    expect(downedEv).toEqual({ t: 'downed', id: 'p1', x: 5, y: 8, z: -3 });
  });

  test('downed survivor takes DOWNED.damageMul-scaled credit and dies outright (finishing blow), emitting died', () => {
    const events: OutpostEvent[] = [];
    const ctx = makeCtx({ emit: (e) => events.push(e) });
    const s = makeSurvivor('p1');
    s.status = 'downed';
    s.hp = 0;
    s.bleedout = 30;
    ctx.survivors.set(s.id, s);

    const credited = damageSurvivor(ctx, s, 20, null);

    expect(credited).toBe(20 * DOWNED.damageMul);
    expect(s.status).toBe('dead');
    expect(s.bleedout).toBe(0);
    expect(events.some((e) => e.t === 'died' && e.id === 'p1')).toBe(true);
  });

  test('dead survivor takes no further damage', () => {
    const ctx = makeCtx();
    const s = makeSurvivor('p1');
    s.status = 'dead';
    s.hp = 0;
    ctx.survivors.set(s.id, s);

    const credited = damageSurvivor(ctx, s, 50, null);

    expect(credited).toBe(0);
    expect(s.status).toBe('dead');
  });

  test('emits dmg_taken with a yaw pointing from the victim toward the attacking zombie', () => {
    const events: OutpostEvent[] = [];
    const ctx = makeCtx({ emit: (e) => events.push(e) });
    const s = makeSurvivor('p1');
    s.body.x = 0;
    s.body.z = 0;
    ctx.survivors.set(s.id, s);
    ctx.zombies.push({
      id: 0,
      kind: 'shambler',
      alive: true,
      hp: 90,
      maxHp: 90,
      body: makeBody(0, 0, -5), // due north of the victim
      yaw: 0,
      height: 1.85,
      radius: 0.34,
      speed: 1.7,
      state: 'attackPlayer',
      targetSeg: -1,
      targetPlayer: 'p1',
      retargetAt: 0,
      attackCooldown: 0,
      spitCooldown: 0,
      dyingFor: 0,
      gait: 0,
    });

    damageSurvivor(ctx, s, 10, 0);

    const dmgEv = events.find((e) => e.t === 'dmg_taken');
    expect(dmgEv).toBeDefined();
    if (dmgEv?.t === 'dmg_taken') {
      expect(dmgEv.dmg).toBe(10);
      // north = yaw 0 under this engine's convention (forward = (-sin yaw, -cos yaw))
      expect(dmgEv.yaw).toBeCloseTo(0, 5);
    }
  });
});

// ---------------------------------------------------------------------------
// stepDowned — full bleedout timeline
// ---------------------------------------------------------------------------

describe('stepDowned', () => {
  test('full bleedout timeline: dies exactly at bleedoutSec, not a tick before, and wipes a solo squad', () => {
    const events: OutpostEvent[] = [];
    const ctx = makeCtx({ emit: (e) => events.push(e), dt: 1 });
    const s = makeSurvivor('solo');
    ctx.survivors.set(s.id, s);

    damageSurvivor(ctx, s, 999, null);
    expect(s.status).toBe('downed');
    // DESIGN_BIBLE: the run ends the instant nobody has status 'alive' — a
    // downed solo player already wipes the squad, before they even die.
    expect(isSquadWiped(ctx.survivors)).toBe(true);

    for (let elapsed = 1; elapsed < DOWNED.bleedoutSec; elapsed++) {
      stepDowned(ctx);
      expect(s.status).toBe('downed');
      expect(s.bleedout).toBeCloseTo(DOWNED.bleedoutSec - elapsed);
    }

    stepDowned(ctx);
    expect(s.status).toBe('dead');
    expect(s.bleedout).toBe(0);
    expect(s.returnAtWave).toBe(ctx.wave + 1);
    expect(events.some((e) => e.t === 'died' && e.id === 'solo')).toBe(true);
    expect(isSquadWiped(ctx.survivors)).toBe(true);
  });

  test('a solo downed player with nobody to revive them stays downed under stepRevives alone', () => {
    const ctx = makeCtx();
    const s = makeSurvivor('solo');
    ctx.survivors.set(s.id, s);
    damageSurvivor(ctx, s, 999, null);

    stepRevives(ctx);

    expect(s.status).toBe('downed');
    expect(s.reviveBy).toBeNull();
    expect(s.reviveProgress).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// stepRevives
// ---------------------------------------------------------------------------

describe('stepRevives', () => {
  function downedTarget(): Survivor {
    const t = makeSurvivor('down');
    t.status = 'downed';
    t.bleedout = 30;
    return t;
  }

  function reviverOn(target: Survivor, id: PlayerId, dx = 0.4): Survivor {
    const r = makeSurvivor(id);
    r.body.x = target.body.x + dx;
    r.body.z = target.body.z;
    r.interacting = true;
    r.interactKind = 'revive';
    r.reviveTargetId = target.id;
    return r;
  }

  test('accumulates progress and completes: restores hp, emits revived, credits the reviver', () => {
    const events: OutpostEvent[] = [];
    const ctx = makeCtx({ emit: (e) => events.push(e), dt: DOWNED.holdSec });
    const target = downedTarget();
    const reviver = reviverOn(target, 'rev');
    ctx.survivors.set(target.id, target);
    ctx.survivors.set(reviver.id, reviver);

    stepRevives(ctx);

    expect(target.status).toBe('alive');
    expect(target.hp).toBe(DOWNED.reviveHp);
    expect(target.bleedout).toBe(0);
    expect(reviver.revivesGiven).toBe(1);
    expect(events).toContainEqual({ t: 'revived', id: 'down', byId: 'rev' });
  });

  test('revive interrupted by the reviver moving out of range resets progress to 0', () => {
    const ctx = makeCtx({ dt: DOWNED.holdSec / 2 });
    const target = downedTarget();
    const reviver = reviverOn(target, 'rev');
    ctx.survivors.set(target.id, target);
    ctx.survivors.set(reviver.id, reviver);

    stepRevives(ctx);
    expect(target.reviveProgress).toBeCloseTo(0.5);
    expect(target.reviveBy).toBe('rev');

    reviver.body.x = target.body.x + DOWNED.range + 1;
    stepRevives(ctx);

    expect(target.reviveProgress).toBe(0);
    expect(target.reviveBy).toBeNull();
  });

  test('revive interrupted by the reviver going down resets progress to 0', () => {
    const ctx = makeCtx({ dt: DOWNED.holdSec / 2 });
    const target = downedTarget();
    const reviver = reviverOn(target, 'rev');
    ctx.survivors.set(target.id, target);
    ctx.survivors.set(reviver.id, reviver);

    stepRevives(ctx);
    expect(target.reviveProgress).toBeCloseTo(0.5);

    reviver.status = 'downed';
    stepRevives(ctx);

    expect(target.reviveProgress).toBe(0);
    expect(target.reviveBy).toBeNull();
  });

  test('releasing INTERACT (without moving or going down) also resets progress', () => {
    const ctx = makeCtx({ dt: DOWNED.holdSec / 2 });
    const target = downedTarget();
    const reviver = reviverOn(target, 'rev');
    ctx.survivors.set(target.id, target);
    ctx.survivors.set(reviver.id, reviver);

    stepRevives(ctx);
    expect(target.reviveProgress).toBeCloseTo(0.5);

    reviver.interacting = false;
    stepRevives(ctx);

    expect(target.reviveProgress).toBe(0);
  });

  test('two revivers on one target do not double-count: progress advances at the single-reviver rate', () => {
    const ctx = makeCtx({ dt: DOWNED.holdSec / 2 });
    const target = downedTarget();
    const r1 = reviverOn(target, 'r1', 0.3);
    const r2 = reviverOn(target, 'r2', -0.3);
    ctx.survivors.set(target.id, target);
    ctx.survivors.set(r1.id, r1);
    ctx.survivors.set(r2.id, r2);

    stepRevives(ctx);

    expect(target.reviveProgress).toBeCloseTo(0.5);
    expect([r1.id, r2.id]).toContain(target.reviveBy);

    // If both revivers were credited (double-counting), this second tick would
    // have already completed the revive after the FIRST tick. It didn't — so
    // completing only now, on the second tick, proves the single-reviver rate.
    stepRevives(ctx);
    expect(target.status).toBe('alive');
    expect(target.hp).toBe(DOWNED.reviveHp);
  });
});

// ---------------------------------------------------------------------------
// resolveInteract
// ---------------------------------------------------------------------------

describe('resolveInteract', () => {
  test('a downed or dead survivor never gets an interactable', () => {
    const ctx = makeCtx();
    const s = makeSurvivor('p1');
    s.status = 'downed';
    ctx.survivors.set(s.id, s);

    resolveInteract(ctx, s);

    expect(s.interactKind).toBe('none');
    expect(s.interactTarget).toBe(-1);
    expect(s.reviveTargetId).toBeNull();
  });

  test('out of range of everything resolves to none', () => {
    const ctx = makeCtx();
    const s = makeSurvivor('p1');
    s.body.x = 0;
    s.body.z = 0;
    ctx.survivors.set(s.id, s);

    resolveInteract(ctx, s);

    expect(s.interactKind).toBe('none');
  });

  test('a damaged segment within repairRange resolves to repair with the correct segment id', () => {
    const ctx = makeCtx();
    const geom = segGeom(3);
    at(ctx.segments, 3).hp = FENCE.segmentHp - 10;
    const s = makeSurvivor('p1');
    s.body.x = geom.cx;
    s.body.z = geom.cz + 1.0; // 1.0 m off the wall, inside repairRange
    ctx.survivors.set(s.id, s);

    resolveInteract(ctx, s);

    expect(s.interactKind).toBe('repair');
    expect(s.interactTarget).toBe(3);
    expect(s.reviveTargetId).toBeNull();
  });

  test('a full-hp segment is never a repair candidate', () => {
    const ctx = makeCtx();
    const geom = segGeom(3);
    const s = makeSurvivor('p1');
    s.body.x = geom.cx;
    s.body.z = geom.cz + 1.0;
    ctx.survivors.set(s.id, s);

    resolveInteract(ctx, s);

    expect(s.interactKind).toBe('none');
  });

  test('a downed teammate within reviveRange resolves to revive with reviveTargetId set', () => {
    const ctx = makeCtx();
    const s = makeSurvivor('p1');
    const teammate = makeSurvivor('down');
    teammate.status = 'downed';
    teammate.body.x = s.body.x + 1.0;
    teammate.body.z = s.body.z;
    ctx.survivors.set(s.id, s);
    ctx.survivors.set(teammate.id, teammate);

    resolveInteract(ctx, s);

    expect(s.interactKind).toBe('revive');
    expect(s.reviveTargetId).toBe('down');
    expect(s.interactTarget).toBe(-1);
  });

  test('interact priority: whichever of a damaged segment or a downed teammate is nearer wins', () => {
    const ctx = makeCtx();
    const geom0 = segGeom(0);
    at(ctx.segments, 0).hp = FENCE.segmentHp - 10;

    const s = makeSurvivor('p1');
    s.body.x = geom0.cx;
    s.body.z = geom0.cz + 1.0; // segment is 1.0 m away

    const teammate = makeSurvivor('down');
    teammate.status = 'downed';
    teammate.body.x = s.body.x + 0.4; // teammate is 0.4 m away — nearer
    teammate.body.z = s.body.z;

    ctx.survivors.set(s.id, s);
    ctx.survivors.set(teammate.id, teammate);

    resolveInteract(ctx, s);
    expect(s.interactKind).toBe('revive');
    expect(s.reviveTargetId).toBe('down');

    // push the teammate out to 2.0 m — now farther than the 1.0 m segment
    teammate.body.x = s.body.x + 2.0;
    resolveInteract(ctx, s);
    expect(s.interactKind).toBe('repair');
    expect(s.interactTarget).toBe(0);
  });

  test('the weapon rack and ammo crate feature points resolve within stationRange', () => {
    const ctx = makeCtx();
    const rack = featurePoint('weaponRack');
    const s = makeSurvivor('p1');
    s.body.x = rack.x;
    s.body.y = rack.y;
    s.body.z = rack.z;
    ctx.survivors.set(s.id, s);

    resolveInteract(ctx, s);

    expect(s.interactKind).toBe('weaponRack');

    const crate = featurePoint('ammoCrate');
    s.body.x = crate.x;
    s.body.y = crate.y;
    s.body.z = crate.z;
    resolveInteract(ctx, s);

    expect(s.interactKind).toBe('ammoCrate');
  });

  test('a slab between the survivor and a feature on another floor blocks the interaction', () => {
    // Regression for the cross-floor exploit: standing on deck2 directly
    // above the ground-floor ammo crate must NOT resolve to 'ammoCrate' —
    // dist2D alone is 0 here, but a floor slab sits between them.
    const ctx = makeCtx();
    const crate = featurePoint('ammoCrate');
    const s = makeSurvivor('p1');
    s.body.x = crate.x;
    s.body.z = crate.z;
    s.body.y = crate.y + 7.6; // deck2, two slabs above the ground-floor crate
    ctx.survivors.set(s.id, s);

    resolveInteract(ctx, s);

    expect(s.interactKind).toBe('none');
  });
});

// ---------------------------------------------------------------------------
// isSquadWiped
// ---------------------------------------------------------------------------

describe('isSquadWiped', () => {
  test('empty roster is not wiped', () => {
    expect(isSquadWiped(new Map())).toBe(false);
  });

  test('any alive survivor prevents a wipe', () => {
    const survivors = new Map<PlayerId, Survivor>();
    const a = makeSurvivor('a');
    a.status = 'downed';
    const b = makeSurvivor('b');
    b.status = 'alive';
    survivors.set(a.id, a);
    survivors.set(b.id, b);

    expect(isSquadWiped(survivors)).toBe(false);
  });

  test('all downed or dead (mixed) is a wipe', () => {
    const survivors = new Map<PlayerId, Survivor>();
    const a = makeSurvivor('a');
    a.status = 'downed';
    const b = makeSurvivor('b');
    b.status = 'dead';
    survivors.set(a.id, a);
    survivors.set(b.id, b);

    expect(isSquadWiped(survivors)).toBe(true);
  });
});
