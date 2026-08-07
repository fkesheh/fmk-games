// TEMPORARY adversarial-review probe. Deleted before the review ends.
import { describe, expect, it } from 'vitest';
import { CAMP_LEASH_RADIUS, ELEV_HIGH, ELEV_LOW, TERRAIN_KINDS } from '@rift/shared';
import type { CampDef, MapDef, TerrainDef, TerrainKind } from '@rift/shared';
import { SimWorld } from './world.js';
import { stepMovement } from './movement.js';
import { stepCombat, stepDeaths } from './combat.js';
import { stepCamps } from './camps.js';
import { NO_ENT } from './types.js';
import type { AbilitiesEngine, CampState, Ent, SeatDef, World } from './types.js';

class Eng implements AbilitiesEngine {
  step(w: World): void {
    w.drainCasts();
  }
}
const SEATS: SeatDef[] = [
  { pid: 'p0', team: 0, hero: 'reaver', bot: false, lane: 0 },
  { pid: 'p1', team: 1, hero: 'longbow', bot: false, lane: 0 },
];
const HIGH: readonly TerrainKind[] = ['high', 'base', 'ramp'];

function terrainOf(side: number, camps: CampDef[], paint: (x: number, z: number) => TerrainKind): TerrainDef {
  const dim = side;
  const kind = new Uint8Array(dim * dim);
  const elev = new Uint8Array(dim * dim);
  for (let z = 0; z < dim; z++) {
    for (let x = 0; x < dim; x++) {
      const k = paint(x + 0.5, z + 0.5);
      kind[z * dim + x] = TERRAIN_KINDS.indexOf(k);
      elev[z * dim + x] = HIGH.includes(k) ? ELEV_HIGH : ELEV_LOW;
    }
  }
  return { grid: { side, res: 1, dim, kind, elev }, camps, landmarks: [] };
}
function world(camps: CampDef[], paint: (x: number, z: number) => TerrainKind = () => 'ground'): SimWorld {
  const terrain = terrainOf(64, camps, paint);
  const map: MapDef = { lanes: 1, side: 64, paths: [], structures: [], terrain };
  const w = new SimWorld(map, SEATS, new Eng());
  (w as unknown as { camps: CampState[] }).camps = camps.map((def) => ({
    id: def.id,
    def,
    memberIds: [],
    aliveCount: 0,
    respawnAtTick: 0,
  }));
  return w;
}
function campsOf(w: SimWorld): CampState[] {
  return (w as unknown as { camps: CampState[] }).camps;
}
function hero(w: SimWorld, pid: string): Ent {
  for (const e of w.mobileMap.values()) if (e.kind === 'hero' && e.pid === pid) return e;
  throw new Error('no hero');
}
function must<T>(v: T | undefined): T {
  if (v === undefined) throw new Error('nope');
  return v;
}

describe('AUDIT', () => {
  it('A: a hero standing on a post permanently disables the returning member', () => {
    const w = world([{ id: 0, tier: 'brute', x: 32, z: 32, half: 0 }]);
    w.tick += 1;
    stepCamps(w);
    const c = must(campsOf(w)[0]);
    const e = must(w.get(must(c.memberIds[0])));
    const postX = e.x;
    const postZ = e.z;
    const h = hero(w, 'p0');
    h.order = 'idle';
    e.x = 32 + CAMP_LEASH_RADIUS + 2;
    e.z = 32;
    w.damage(h.id, e.id, 120, 'physical');
    const hurt = e.hp;
    expect(hurt).toBeLessThan(e.maxHp);
    stepCamps(w);
    expect(e.order).toBe('move');
    for (let i = 0; i < 1000; i++) {
      h.x = postX;
      h.z = postZ;
      h.order = 'idle';
      w.tick += 1;
      stepMovement(w);
      stepCombat(w);
      stepDeaths(w);
      stepCamps(w);
    }
    // eslint-disable-next-line no-console
    console.log('A:', {
      order: e.order,
      hp: e.hp,
      maxHp: e.maxHp,
      distToPost: Math.hypot(e.x - postX, e.z - postZ),
      orderTarget: e.orderTarget,
      atkTarget: e.atkTarget,
      heroHp: h.hp,
      heroMaxHp: h.maxHp,
    });
    expect(true).toBe(true);
  });

  it('B: a one-point (straight-line) route is never re-planned after displacement', () => {
    const paint = (x: number, z: number): TerrainKind =>
      x > 20 && x < 26 && z > 20 && z < 26 ? 'cliff' : 'ground';
    const w = world([], paint);
    const h = hero(w, 'p0');
    // 1. order across OPEN ground: straight line clear -> pathUsable memoises a
    //    one-point route.
    h.x = 30;
    h.z = 23;
    h.order = 'move';
    h.ox = 36;
    h.oz = 23;
    h.orderTarget = NO_ENT;
    w.tick += 1;
    stepMovement(w);
    const plan = h.path;
    // eslint-disable-next-line no-console
    console.log('B: plan after clear-line order len =', plan?.length, JSON.stringify(plan));
    // 2. displaced to the far side of the rock, SAME destination, same order.
    h.x = 10;
    h.z = 23;
    h.order = 'move';
    h.ox = 36;
    h.oz = 23;
    h.orderTarget = NO_ENT;
    for (let i = 0; i < 600; i++) {
      w.tick += 1;
      stepMovement(w);
    }
    // eslint-disable-next-line no-console
    console.log('B: after 600 ticks', {
      pathLen: h.path?.length,
      samePlanObject: h.path === plan,
      x: h.x,
      z: h.z,
      order: h.order,
      distToDest: Math.hypot(h.x - 36, h.z - 23),
    });
    expect(true).toBe(true);
  });

  it('C: control — same displacement but the FIRST order needed A* (multi-point route)', () => {
    const paint = (x: number, z: number): TerrainKind =>
      x > 20 && x < 26 && z > 20 && z < 26 ? 'cliff' : 'ground';
    const w = world([], paint);
    const h = hero(w, 'p0');
    h.x = 10;
    h.z = 23;
    h.order = 'move';
    h.ox = 36;
    h.oz = 23;
    h.orderTarget = NO_ENT;
    for (let i = 0; i < 600; i++) {
      w.tick += 1;
      stepMovement(w);
    }
    // eslint-disable-next-line no-console
    console.log('C: after 600 ticks', {
      pathLen: h.path?.length,
      x: h.x,
      z: h.z,
      order: h.order,
      distToDest: Math.hypot(h.x - 36, h.z - 23),
    });
    expect(true).toBe(true);
  });
});
