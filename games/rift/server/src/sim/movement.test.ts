// ============================================================================
// T3 — SIM CORE: movement.ts + pathing.ts tests (TERRAIN_CONTRACT §4,
// AMENDMENT_1 §A/§D). Cliffs are solid and elevation changes need a ramp;
// heroes — and only heroes — get grid A*, at most two searches a tick; lane
// creeps keep their polyline; camps EXECUTE the orders sim/camps.ts writes and
// decide nothing; dashes stop at the rock instead of through it.
//
// Terrain is hand-painted per scenario rather than sampled from buildMap: the
// interesting cases (a one-cell-thick wall, a single ramp, a sealed pocket, a
// lone pillar) are exactly the ones a generated map is contractually forbidden
// to contain, and a test that has to hunt the real map for a cliff asserts on
// whatever it found rather than on what the rule says. The real map is used
// where the real map IS the subject: lane corridors, the passability
// equivalence, and cross-build determinism.
//
// Camp members are stood up by the REAL `spawnCamp` from sim/camps.ts rather
// than hand-stamped here. movement.ts owns only the executing half of the camps
// seam (AMENDMENT_1 §A), so a fixture that invented a camp's statline or its
// orders would be testing the fixture.
//
// `stepMovement` is driven directly rather than through `advance()` so that a
// failure here is a movement failure and not combat, waves or upkeep leaking in.
// ============================================================================
import { describe, expect, it } from 'vitest';
import {
  AGGRO_RADIUS,
  buildMap,
  CAMP_BRUTE,
  CAMP_LEASH_RADIUS,
  ELEV_HIGH,
  ELEV_LOW,
  isPassable,
  kindAt,
  LANE_CORRIDOR_HALF_W,
  NEUTRAL_TEAM,
  TERRAIN_KINDS,
  TICK_RATE,
} from '@rift/shared';
import type { CampDef, EntKind, MapDef, TerrainDef, TerrainKind, Vec2 } from '@rift/shared';
import { SimWorld } from './world.js';
import { stepMovement } from './movement.js';
import { spawnCamp } from './camps.js';
import {
  cellPassable,
  findPath,
  PATH_NODE_BUDGET,
  PATH_SEARCHES_PER_TICK,
  pathSearchesUsed,
  segmentWalkable,
  walkableFraction,
} from './pathing.js';
import { NO_ENT } from './types.js';
import type { AbilitiesEngine, CampState, Ent, EntId, SeatDef, World } from './types.js';

class EngineDouble implements AbilitiesEngine {
  step(world: World): void {
    world.drainCasts();
  }
}

const SEATS: SeatDef[] = [
  { pid: 'p0', team: 0, hero: 'reaver', bot: false, lane: 0 },
  { pid: 'p1', team: 1, hero: 'longbow', bot: false, lane: 0 },
];

/** Eight seats, for the per-tick search budget: a full lobby can order on the
 *  same tick, which is the case AMENDMENT_1 §D exists for. */
const EIGHT_SEATS: SeatDef[] = Array.from({ length: 8 }, (_, i) => ({
  pid: `p${i}`,
  team: (i % 2) as 0 | 1,
  hero: i % 2 === 0 ? ('reaver' as const) : ('longbow' as const),
  bot: false,
  lane: 0,
}));

const HIGH_KINDS: readonly TerrainKind[] = ['high', 'base', 'ramp'];

/** Paint a square terrain grid cell by cell from a function of the cell CENTRE.
 *  Elevation is derived from the kind exactly as TERRAIN_CONTRACT §3 defines it
 *  (`'ramp'` reads ELEV_HIGH), so a scenario only ever states kinds. `res` is a
 *  parameter because the sweep sampler must be a fraction of a CELL, not a
 *  fixed number of metres — see the resolution case below. */
function terrainOf(
  side: number,
  paint: (x: number, z: number) => TerrainKind,
  camps: CampDef[] = [],
  res = 1,
): TerrainDef {
  const dim = side * res;
  const kind = new Uint8Array(dim * dim);
  const elev = new Uint8Array(dim * dim);
  for (let z = 0; z < dim; z++) {
    for (let x = 0; x < dim; x++) {
      const k = paint((x + 0.5) / res, (z + 0.5) / res);
      kind[z * dim + x] = TERRAIN_KINDS.indexOf(k);
      elev[z * dim + x] = HIGH_KINDS.includes(k) ? ELEV_HIGH : ELEV_LOW;
    }
  }
  return { grid: { side, res, dim, kind, elev }, camps, landmarks: [] };
}

function mapOf(terrain: TerrainDef, paths: readonly (readonly Vec2[])[] = []): MapDef {
  return { lanes: 1, side: terrain.grid.side, paths, structures: [], terrain };
}

function worldOf(map: MapDef, seats: readonly SeatDef[] = SEATS): SimWorld {
  return new SimWorld(map, seats, new EngineDouble());
}

function hero(w: SimWorld, pid: string): Ent {
  for (const e of w.mobileMap.values()) {
    if (e.kind === 'hero' && e.pid === pid) return e;
  }
  throw new Error(`no hero ${pid}`);
}

function must(e: Ent | undefined): Ent {
  if (!e) throw new Error('expected entity to exist');
  return e;
}

function spawn(w: SimWorld, kind: EntKind, team: 0 | 1, x: number, z: number, lane: number): EntId {
  return w.spawnMobile(kind, team, x, z, lane, -1, NO_ENT);
}

/**
 * Stand up a REAL camp at (x, z) through sim/camps.ts, and return its members.
 *
 * This is the only way a neutral enters these tests. `spawnCamp` owns the
 * spawn recipe (NEUTRAL_TEAM, lane -1, no owner, no expiry) and the tier
 * statline; movement.ts owns none of that and must not be handed a
 * hand-assembled camp whose numbers agree with nothing.
 */
function standCamp(w: SimWorld, tier: CampDef['tier'], x: number, z: number): Ent[] {
  const state: CampState = {
    id: 0,
    def: { id: 0, tier, x, z, half: 0 },
    memberIds: [],
    aliveCount: 0,
    respawnAtTick: -1,
  };
  spawnCamp(w, state);
  return state.memberIds.map((id) => must(w.get(id)));
}

function orderMove(e: Ent, x: number, z: number): void {
  e.order = 'move';
  e.ox = x;
  e.oz = z;
  e.orderTarget = NO_ENT;
}

/** One or more movement ticks. The tick counter is advanced exactly as
 *  `advance()` does, because stun/dash windows are compared against it. */
function tick(w: SimWorld, n = 1): void {
  for (let i = 0; i < n; i++) {
    w.tick += 1;
    stepMovement(w);
  }
}

/** Run movement until `done`, asserting the unit never stands in rock. Returns
 *  the tick count consumed; the caller asserts on it. */
function runUntil(w: SimWorld, e: Ent, limit: number, done: () => boolean): number {
  for (let i = 0; i < limit; i++) {
    if (done()) return i;
    tick(w);
    expect(kindAt(w.map.terrain, e.x, e.z)).not.toBe('cliff');
  }
  return limit;
}

// ---------------------------------------------------------------------------

describe('terrain primitives', () => {
  const t = terrainOf(16, (x) => (x > 8 && x < 9 ? 'cliff' : 'ground'));

  it('sweeps, rather than end-point tests, a step across a one-cell wall', () => {
    expect(segmentWalkable(t, 7.5, 5, 7.9, 5)).toBe(true);
    // Both ends are open ground; only the swept test sees the wall between.
    expect(isPassable(t, 7.5, 5)).toBe(true);
    expect(isPassable(t, 9.5, 5)).toBe(true);
    expect(segmentWalkable(t, 7.5, 5, 9.5, 5)).toBe(false);
  });

  it('reports the fraction that is walkable so motion can stop at the face', () => {
    const f = walkableFraction(t, 7.0, 5, 11.0, 5);
    expect(f).toBeGreaterThan(0);
    expect(7.0 + 4 * f).toBeLessThan(8.0);
  });

  it('refuses an elevation change except through a ramp', () => {
    const stepped = terrainOf(16, (x, z) => {
      if (x > 8 && x < 9) return z > 4 && z < 6 ? 'ramp' : 'cliff';
      return x > 9 ? 'high' : 'ground';
    });
    expect(segmentWalkable(stepped, 7.5, 2.5, 9.5, 2.5)).toBe(false);
    expect(segmentWalkable(stepped, 7.5, 5.5, 9.5, 5.5)).toBe(true);
    expect(kindAt(stepped, 8.5, 5.5)).toBe('ramp');
    expect(kindAt(stepped, 8.5, 2.5)).toBe('cliff');
  });

  it('reads a ramp as high ground and a cliff as low, per §3', () => {
    const stepped = terrainOf(8, (x) => (x < 3 ? 'ground' : x < 4 ? 'ramp' : x < 5 ? 'cliff' : 'high'));
    expect(stepped.grid.elev[3]).toBe(ELEV_HIGH);
    expect(stepped.grid.elev[4]).toBe(ELEV_LOW);
  });

  it('is the frozen isPassable, cell-indexed — the pathfinder derives nothing', () => {
    // `cellPassable` exists so A* can ask about a cell index it already holds
    // without converting to metres and back. That makes it a SECOND spelling of
    // `isPassable`, and a second spelling can drift; this is what stops it.
    const t3 = buildMap(3).terrain;
    const g = t3.grid;
    let solid = 0;
    for (let cz = 0; cz < g.dim; cz++) {
      for (let cx = 0; cx < g.dim; cx++) {
        const idx = cz * g.dim + cx;
        const p = cellPassable(g, idx);
        expect(p).toBe(isPassable(t3, (cx + 0.5) / g.res, (cz + 0.5) / g.res));
        if (!p) solid += 1;
      }
    }
    expect(solid).toBeGreaterThan(0); // the map really does contain rock
  });

  it('samples the sweep per CELL, so a finer grid cannot be tunnelled either', () => {
    // res 8 = 12.5 cm cells. A sampler fixed at 0.25 m steps over whole cells
    // here: it would land on 12.0625 and 12.3125 and never see the wall at
    // 12.125..12.25 between them. Derived from `res`, it cannot miss.
    const fine = terrainOf(32, (x) => (x > 12.125 && x < 12.25 ? 'cliff' : 'ground'), [], 8);
    expect(kindAt(fine, 12.1875, 5)).toBe('cliff');
    expect(kindAt(fine, 12.0625, 5)).toBe('ground');
    expect(kindAt(fine, 12.3125, 5)).toBe('ground');
    expect(segmentWalkable(fine, 11.0, 5, 13.0, 5)).toBe(false);
  });
});

describe('hero pathing over cliffs', () => {
  /** A wall down the middle at x in [24,25), crossable only by the ramp at
   *  z in [30,34). West is low ground, east is a plateau. */
  const wallWithRamp = terrainOf(48, (x, z) => {
    if (x > 24 && x < 25) return z > 30 && z < 34 ? 'ramp' : 'cliff';
    return x > 25 ? 'high' : 'ground';
  });

  it('routes a hero across a cliff through the ramp, and it arrives', () => {
    const w = worldOf(mapOf(wallWithRamp));
    const h = hero(w, 'p0');
    h.x = 6;
    h.z = 6;
    orderMove(h, 40, 6);

    let usedRamp = false;
    let crossed = false;
    const spent = runUntil(w, h, 1200, () => h.order === 'idle');
    expect(spent).toBeLessThan(1200);
    expect(h.x).toBeCloseTo(40, 3);
    expect(h.z).toBeCloseTo(6, 3);

    // Re-run recording where it went: arriving is not enough, it must have
    // used the one legal crossing rather than clipping a corner of the wall.
    const w2 = worldOf(mapOf(wallWithRamp));
    const h2 = hero(w2, 'p0');
    h2.x = 6;
    h2.z = 6;
    orderMove(h2, 40, 6);
    for (let i = 0; i < 1200 && h2.order !== 'idle'; i++) {
      tick(w2);
      const k = kindAt(wallWithRamp, h2.x, h2.z);
      expect(k).not.toBe('cliff');
      if (k === 'ramp') usedRamp = true;
      if (h2.x > 25) crossed = true;
      if (crossed) expect(usedRamp).toBe(true);
    }
    expect(usedRamp).toBe(true);
    expect(crossed).toBe(true);
  });

  it('plans once per destination cell and never re-searches per tick', () => {
    const w = worldOf(mapOf(wallWithRamp));
    const h = hero(w, 'p0');
    h.x = 6;
    h.z = 6;
    orderMove(h, 40, 6);
    tick(w);
    const planned = h.path;
    expect(planned).not.toBeNull();
    expect(planned?.length ?? 0).toBeGreaterThan(1);
    tick(w, 60);
    expect(h.path).toBe(planned); // same array object: no re-plan happened

    // Nudging the destination inside the metre it already occupies is not a new
    // destination: AMENDMENT_1 §D says re-plan on a destination CELL change, and
    // the follower walks the exact point in its tail leg regardless.
    orderMove(h, 40.3, 6.2);
    tick(w);
    expect(h.path).toBe(planned);

    orderMove(h, 8, 40); // a different CELL does re-plan
    tick(w);
    expect(h.path).not.toBe(planned);
  });

  it('re-plans a route it has been displaced off, to the very same destination', () => {
    // Ent.path's frozen invariant is "every new order resets this to null and
    // pathIndex to 0", and nothing in the sim implemented it. Memoising on the
    // destination alone kept a pathIndex that pointed at a waypoint the hero
    // could no longer reach, and `travel()` then returned -1 for ever.
    const blob = terrainOf(48, (x, z) => (x > 20 && x < 26 && z > 20 && z < 26 ? 'cliff' : 'ground'));
    const w = worldOf(mapOf(blob));
    const h = hero(w, 'p0');
    h.x = 10;
    h.z = 23;
    h.moveSpeed = 12; // cover ground fast enough to actually consume a waypoint
    orderMove(h, 36, 23);
    let walked = 0;
    // `?? 0`: world.ts's makeEnt does not yet initialise `pathIndex`, so it
    // reads undefined until movement writes it (see the S_WORLD note).
    while ((h.pathIndex ?? 0) === 0 && walked < 600) {
      tick(w);
      walked += 1;
    }
    const stale = h.path;
    expect(stale?.length ?? 0).toBeGreaterThan(1);
    expect(h.pathIndex).toBeGreaterThan(0);

    // Carried to the far side of the rock — as a dash, a push-out or a chase
    // could — and handed the IDENTICAL order again. The waypoint it was walking
    // to is now behind the rock, which is the precondition being tested.
    const wp = (stale ?? [])[h.pathIndex];
    if (!wp) throw new Error('expected a live waypoint');
    // Reflected through the rock's centre, so whichever way round the route
    // went, the waypoint it is holding is now on the far side of the rock.
    const tx = 46 - wp.x;
    const tz = 46 - wp.z;
    expect(segmentWalkable(blob, tx, tz, wp.x, wp.z)).toBe(false);
    h.x = tx;
    h.z = tz;
    orderMove(h, 36, 23);
    tick(w);
    expect(h.path).not.toBe(stale);
    expect(h.pathIndex).toBe(0);

    const spent = runUntil(w, h, 1200, () => h.order === 'idle');
    expect(spent).toBeLessThan(1200);
    expect(h.x).toBeCloseTo(36, 3);
    expect(h.z).toBeCloseTo(23, 3);
  });

  it('string-pulls the route instead of emitting a cell-by-cell staircase', () => {
    const route = findPath(wallWithRamp, 6, 6, 40, 6);
    expect(route).not.toBeNull();
    const pts = route ?? [];
    expect(pts.length).toBeGreaterThan(1);
    expect(pts.length).toBeLessThan(12); // ~80 m of travel, a handful of corners
    const last = pts[pts.length - 1];
    expect(last?.x).toBe(40);
    expect(last?.z).toBe(6);
    // Every leg the hero is asked to walk must itself be legal.
    let px = 6;
    let pz = 6;
    for (const p of pts) {
      expect(segmentWalkable(wallWithRamp, px, pz, p.x, p.z)).toBe(true);
      px = p.x;
      pz = p.z;
    }
  });

  it('does not search at all when the straight line is already clear', () => {
    expect(findPath(wallWithRamp, 4, 4, 20, 20)).toBeNull();
  });

  it('fails gracefully on an unreachable destination: no path, no stall', () => {
    const sealed = terrainOf(48, (x, z) => {
      const inPocket = x > 30 && x < 36 && z > 30 && z < 36;
      const inRing = x > 29 && x < 37 && z > 29 && z < 37;
      return inPocket ? 'ground' : inRing ? 'cliff' : 'ground';
    });
    const w = worldOf(mapOf(sealed));
    const h = hero(w, 'p0');
    h.x = 10;
    h.z = 10;
    orderMove(h, 33, 33);

    expect(findPath(sealed, 10, 10, 33, 33)).toBeNull();
    tick(w);
    const fallback = h.path;
    expect(fallback?.length).toBe(1); // degrades to "steer straight"
    tick(w, 400);
    expect(h.path).toBe(fallback); // and never searches again
    expect(h.order).toBe('move'); // still trying, exactly as it would at a wall
    expect(kindAt(sealed, h.x, h.z)).not.toBe('cliff');
    // It may slide anywhere around the outside of the ring; what it may never
    // do is end up inside the sealed pocket.
    const inside = h.x > 30 && h.x < 36 && h.z > 30 && h.z < 36;
    expect(inside).toBe(false);
  });

  it('walks to the foot of a destination that is inside the rock', () => {
    const blob = terrainOf(48, (x, z) => (x > 20 && x < 26 && z > 20 && z < 26 ? 'cliff' : 'ground'));
    const w = worldOf(mapOf(blob));
    const h = hero(w, 'p0');
    h.x = 10;
    h.z = 23;
    orderMove(h, 23, 23); // the middle of a solid block

    const route = findPath(blob, 10, 23, 23, 23);
    expect(route).not.toBeNull();
    // The route ends ON the click even though the click is solid rock: that is
    // what stops the follower re-planning every tick.
    const tail = (route ?? [])[(route ?? []).length - 1];
    expect(tail?.x).toBe(23);
    expect(tail?.z).toBe(23);
    tick(w);
    const planned = h.path;
    tick(w, 200);
    expect(h.path).toBe(planned); // one search, not one per tick
    tick(w, 400);
    expect(kindAt(blob, h.x, h.z)).not.toBe('cliff');
    // The click snapped to the walkable cell nearest the click — which side of
    // the block that is, is the grid's business; that it got AS CLOSE AS the
    // rock allows and stopped, is the rule.
    expect(Math.hypot(h.x - 23, h.z - 23)).toBeLessThan(4.5);
    expect(h.order).toBe('move');
  });

  it('keeps A* inside its node budget rather than stalling the tick', () => {
    expect(PATH_NODE_BUDGET).toBeGreaterThan(0);
    expect(PATH_NODE_BUDGET).toBeLessThanOrEqual(2400);
  });
});

describe('the per-tick search budget (AMENDMENT_1 §D)', () => {
  /** The same wall-and-ramp map: every order below has a blocked straight line
   *  and therefore genuinely needs A*. */
  const wallWithRamp = terrainOf(48, (x, z) => {
    if (x > 24 && x < 25) return z > 30 && z < 34 ? 'ramp' : 'cliff';
    return x > 25 ? 'high' : 'ground';
  });

  function eightOrdered(dest: readonly [number, number]): { w: SimWorld; heroes: Ent[] } {
    const w = worldOf(mapOf(wallWithRamp), EIGHT_SEATS);
    const heroes: Ent[] = [];
    for (let i = 0; i < 8; i++) {
      const h = hero(w, `p${i}`);
      h.x = 6;
      h.z = 3 + i * 3; // 3 m apart: no separation, no accidental re-plans
      orderMove(h, dest[0], dest[1]);
      heroes.push(h);
    }
    return { w, heroes };
  }

  function routed(heroes: readonly Ent[]): number {
    return heroes.filter((h) => (h.path?.length ?? 0) > 1).length;
  }

  it('runs at most two searches a tick and defers the rest to the next one', () => {
    const { w, heroes } = eightOrdered([40, 6]);
    tick(w);
    // A full lobby ordered on one tick: two are served, six wait.
    expect(pathSearchesUsed()).toBe(PATH_SEARCHES_PER_TICK);
    expect(routed(heroes)).toBe(PATH_SEARCHES_PER_TICK);

    for (let i = 0; i < 30; i++) {
      tick(w);
      expect(pathSearchesUsed()).toBeLessThanOrEqual(PATH_SEARCHES_PER_TICK);
    }
    expect(routed(heroes)).toBe(8); // the queue drains; nobody is starved
  });

  it('a deferred hero still moves that tick, and never memoises the deferral', () => {
    const { w, heroes } = eightOrdered([40, 6]);
    const before = heroes.map((h) => ({ x: h.x, z: h.z }));
    tick(w);
    heroes.forEach((h, i) => {
      const b = before[i];
      if (!b) throw new Error('missing snapshot');
      expect(Math.hypot(h.x - b.x, h.z - b.z)).toBeGreaterThan(0); // everyone moved
      // A deferred request leaves no route behind to be mistaken for an answer.
      if ((h.path?.length ?? 0) <= 1) expect(h.path ?? null).toBeNull();
    });
  });

  it('a clear straight line costs no search at all', () => {
    // Eight orders across open ground on the west side: the common case must
    // not consume the allowance, or genuine A* orders would starve behind it.
    const { w, heroes } = eightOrdered([20, 20]);
    tick(w);
    expect(pathSearchesUsed()).toBe(0);
    for (const h of heroes) expect(h.path?.length).toBe(1);
  });
});

describe('cliff collision', () => {
  /** A one-cell-thick wall at x in [24,25) spanning the whole map, with LOW
   *  ground on both sides: the only thing stopping anyone is the cliff itself. */
  const wall = terrainOf(48, (x) => (x > 24 && x < 25 ? 'cliff' : 'ground'));

  it('cannot be tunnelled by a hero at absurd moveSpeed in one tick', () => {
    const w = worldOf(mapOf(wall));
    const h = hero(w, 'p0');
    h.x = 23.5;
    h.z = 10;
    h.moveSpeed = 200; // 10 m per tick — four times the wall's thickness
    orderMove(h, 44, 10);
    for (let i = 0; i < 40; i++) {
      tick(w);
      expect(h.x).toBeLessThan(24);
      expect(kindAt(wall, h.x, h.z)).not.toBe('cliff');
    }
  });

  it('stops a head-on walk at the face without jitter or deadlock', () => {
    const w = worldOf(mapOf(wall));
    const h = hero(w, 'p0');
    h.x = 21;
    h.z = 10;
    orderMove(h, 44, 10);
    tick(w, 60);
    const restX = h.x;
    const restZ = h.z;
    expect(restX).toBeLessThan(24);
    expect(restX).toBeGreaterThan(23.5); // pressed against the face, not stalled early
    for (let i = 0; i < 20; i++) {
      tick(w);
      expect(h.x).toBe(restX); // bit-identical: nothing to oscillate between
      expect(h.z).toBe(restZ);
    }
  });

  it('slides along the face, monotonically, when the motion has a tangent', () => {
    const w = worldOf(mapOf(wall));
    const h = hero(w, 'p0');
    h.x = 22;
    h.z = 4;
    orderMove(h, 44, 40); // diagonal into the wall
    let prevZ = h.z;
    for (let i = 0; i < 400; i++) {
      tick(w);
      expect(h.x).toBeLessThan(24);
      expect(h.z).toBeGreaterThanOrEqual(prevZ); // never backs up: no jitter
      prevZ = h.z;
    }
    expect(h.z).toBeGreaterThan(30); // it really did travel along the wall
  });

  it('spends a blocked step on the tangent it was actually travelling', () => {
    // One isolated cliff cell. Standing diagonally off its corner and driving
    // into it is the one shape where BOTH axis remainders are legal — anywhere
    // else the motion is stopped at the blocking cell boundary and exactly one
    // axis is left — so it is the only case where the choice of axis is
    // observable. Taking X first regardless drifted every such unit east,
    // whatever direction it was heading.
    const pillar = terrainOf(48, (x, z) =>
      x > 24 && x < 25 && z > 24 && z < 25 ? 'cliff' : 'ground',
    );
    const w = worldOf(mapOf(pillar));
    const members = standCamp(w, 'pack', 6, 6); // a straight-line steerer, not a pather
    const e = must(members[0]);
    e.moveSpeed = 20; // 1 m in a tick, so the remainder is big enough to see
    e.x = 23.9;
    e.z = 23.95;
    orderMove(e, 23.9 + 6, 23.95 + 8); // 0.6 east / 0.8 north: mostly NORTH
    const x0 = e.x;
    const z0 = e.z;
    tick(w);
    expect(e.z - z0).toBeGreaterThan(0.5); // it kept going north
    expect(e.x).toBe(x0); // and spent nothing sideways
  });

  it('lets two units press head-on into the same face without deadlocking', () => {
    const w = worldOf(mapOf(wall));
    const a = hero(w, 'p0');
    const b = hero(w, 'p1');
    a.x = 22;
    a.z = 10;
    b.x = 22.4;
    b.z = 10;
    orderMove(a, 44, 10);
    orderMove(b, 44, 10);
    tick(w, 120);
    for (const e of [a, b]) {
      expect(e.x).toBeLessThan(24);
      expect(kindAt(wall, e.x, e.z)).not.toBe('cliff');
      expect(Number.isFinite(e.x)).toBe(true);
      expect(Number.isFinite(e.z)).toBe(true);
    }
    // separation still holds them apart rather than fusing them into the wall
    expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeGreaterThan(a.radius);
  });

  it('ejects a unit that has been shoved inside a cliff', () => {
    const w = worldOf(mapOf(wall));
    const h = hero(w, 'p0');
    h.x = 24.5; // inside the rock, as separation or a push-out could leave it
    h.z = 10;
    h.order = 'idle';
    expect(kindAt(wall, h.x, h.z)).toBe('cliff');
    tick(w);
    expect(kindAt(wall, h.x, h.z)).not.toBe('cliff');
    expect(isPassable(wall, h.x, h.z)).toBe(true);
  });

  it('stops a dash at the cliff face instead of through it', () => {
    const w = worldOf(mapOf(wall));
    const h = hero(w, 'p0');
    h.x = 20;
    h.z = 10;
    w.dash(h.id, 40, 10); // 20 m of dash, crossing the wall
    for (let i = 0; i < 12; i++) {
      tick(w);
      expect(h.x).toBeLessThan(24);
      expect(kindAt(wall, h.x, h.z)).not.toBe('cliff');
    }
    expect(h.x).toBeGreaterThan(23); // it reached the face
    expect(h.dashUntilTick).toBe(0); // and the dash ended there
  });

  it('lets an unobstructed dash complete exactly as before', () => {
    const w = worldOf(mapOf(wall));
    const h = hero(w, 'p0');
    h.x = 4;
    h.z = 10;
    w.dash(h.id, 14, 10);
    tick(w, 6);
    expect(h.x).toBeCloseTo(14, 6);
    expect(h.z).toBeCloseTo(10, 6);
    expect(h.dashUntilTick).toBe(0);
  });
});

describe('lane creeps and summons', () => {
  const map = buildMap(2);

  it('walks its polyline without ever being given a path', () => {
    const w = worldOf(map);
    const poly = map.paths[0] ?? [];
    const start = poly[0];
    expect(start).toBeDefined();
    const id = spawn(w, 'melee', 0, start?.x ?? 0, start?.z ?? 0, 0);
    const creep = must(w.get(id));
    let worst = 0;
    for (let i = 0; i < 900; i++) {
      tick(w);
      expect(creep.path ?? null).toBeNull(); // creeps are NEVER pathed
      worst = Math.max(worst, distToPolyline(poly, creep.x, creep.z));
      expect(kindAt(map.terrain, creep.x, creep.z)).not.toBe('cliff');
    }
    expect(worst).toBeLessThanOrEqual(LANE_CORRIDOR_HALF_W);
    expect(creep.waypoint).toBeGreaterThan(0); // it made progress down the lane
  });

  it('refuses to acquire a neutral camp, and keeps walking its lane', () => {
    const w = worldOf(map);
    const poly = map.paths[0] ?? [];
    const at = poly[1] ?? { x: 20, z: 20 };
    const creepId = spawn(w, 'melee', 0, at.x, at.z, 0);
    const creep = must(w.get(creepId));
    const camp = must(standCamp(w, 'pack', at.x + 2, at.z)[0]);
    expect(camp.team).toBe(NEUTRAL_TEAM);
    tick(w, 3);
    expect(creep.orderTarget).toBe(NO_ENT);
  });

  it('refuses the same for a summon', () => {
    const w = worldOf(map);
    const h = hero(w, 'p0');
    h.x = 40;
    h.z = 40;
    const shadeId = spawn(w, 'shade', 0, 40, 40, -1);
    const shade = must(w.get(shadeId));
    Object.assign(shade, { owner: h.id });
    standCamp(w, 'pack', 42, 40);
    tick(w, 3);
    expect(shade.orderTarget).toBe(NO_ENT);
  });

  it('still acquires an ordinary enemy creep', () => {
    const w = worldOf(map);
    const poly = map.paths[0] ?? [];
    const at = poly[1] ?? { x: 20, z: 20 };
    const mine = must(w.get(spawn(w, 'melee', 0, at.x, at.z, 0)));
    const theirs = spawn(w, 'melee', 1, at.x + 2, at.z, 0);
    tick(w);
    expect(mine.orderTarget).toBe(theirs);
  });

  it('lets a hero attack-move acquire a camp — the jungle must be engageable', () => {
    const w = worldOf(map);
    const h = hero(w, 'p0');
    h.x = 40;
    h.z = 40;
    h.order = 'attackmove';
    h.ox = 60;
    h.oz = 60;
    h.orderTarget = NO_ENT;
    const camp = standCamp(w, 'brute', 40 + AGGRO_RADIUS - 1, 40);
    tick(w);
    // Whichever member of the camp is nearest — the point is that a neutral is
    // a legal attack-move target at all.
    expect(camp.map((e) => e.id)).toContain(h.orderTarget);
  });

  it('never acquires a STRUCTURE as a mobile — the id partition is not the test', () => {
    // `nearestEnemyMobile` used to reject structures with `t.id < 1000`, which
    // is world.ts's private numbering. A lane creep beside an enemy tower must
    // pick the creep in front of it, not the building.
    const w = worldOf(map);
    const tower = must(w.structures.find((s) => s.kind === 'tower' && s.team === 1));
    const mine = must(w.get(spawn(w, 'melee', 0, tower.x, tower.z + 3, -1)));
    tick(w);
    expect(mine.orderTarget).not.toBe(tower.id);
  });
});

describe('neutral camps — the EXECUTING half of the seam (AMENDMENT_1 §A)', () => {
  const flat = terrainOf(48, () => 'ground');

  it('walks exactly where the order says, and stops being told to', () => {
    const w = worldOf(mapOf(flat));
    const e = must(standCamp(w, 'brute', 20, 20)[0]);
    orderMove(e, 26, 20);
    const need = Math.ceil(Math.hypot(26 - e.x, 20 - e.z) / (CAMP_BRUTE.moveSpeed / TICK_RATE)) + 2;
    tick(w, need);
    expect(e.x).toBeCloseTo(26, 6);
    expect(e.z).toBeCloseTo(20, 6);
    // movement.ts writes no order field for a camp: only sim/camps.ts does, and
    // it has not run. The member sits on its destination still "moving".
    expect(e.order).toBe('move');
  });

  it('holds still on an idle order, even with an enemy on top of it', () => {
    const w = worldOf(mapOf(flat));
    const e = must(standCamp(w, 'brute', 20, 20)[0]);
    e.order = 'idle';
    e.ox = 40; // a destination it must NOT walk to
    e.oz = 40;
    spawn(w, 'melee', 0, e.x + 1.5, e.z, -1);
    const x0 = e.x;
    const z0 = e.z;
    tick(w, 20);
    expect(e.x).toBe(x0);
    expect(e.z).toBe(z0);
    expect(e.orderTarget).toBe(NO_ENT); // and it acquired nothing on its own
    expect(e.order).toBe('idle');
  });

  it('never plans a path and never touches a lane polyline', () => {
    const lane: Vec2[] = [
      { x: 2, z: 2 },
      { x: 44, z: 44 },
    ];
    const w = worldOf(mapOf(flat, [lane]));
    const e = must(standCamp(w, 'pack', 20, 20)[0]);
    e.lane = 0; // the exact state the fall-through bug produces
    orderMove(e, 24, 20);
    tick(w, 60);
    expect(e.path ?? null).toBeNull(); // A* is heroes only
    expect(e.pathIndex ?? 0).toBe(0);
    expect(e.waypoint).toBe(0); // it never entered lane-following code
    expect(e.x).toBeCloseTo(24, 6);
    expect(e.z).toBeCloseTo(20, 6);
  });

  it('chases the LIVE position of its ordered target, not a recorded one', () => {
    const w = worldOf(mapOf(flat));
    const e = must(standCamp(w, 'brute', 20, 20)[0]);
    const h = hero(w, 'p0');
    h.order = 'idle';
    h.x = 20;
    h.z = 26;
    // camps.ts records the target's position in ox/oz when it issues the order;
    // by the time movement runs, the target has moved. The order names the
    // ENTITY, so the entity is what gets chased.
    e.order = 'attack';
    e.orderTarget = h.id;
    e.ox = 20;
    e.oz = 26;
    h.x = 20;
    h.z = 14; // the far side, past the stale destination
    tick(w, 40);
    expect(Math.hypot(e.x - h.x, e.z - h.z)).toBeLessThan(Math.hypot(e.x - 20, e.z - 26));
    expect(e.z).toBeLessThan(20);
  });

  it('leaves the leash entirely to camps.ts — it is not enforced here', () => {
    // Proof that the halves cannot silently both implement it: with camps.ts
    // never running, a move order 30 m from the clearing is carried out in full.
    // (`camps.test.ts` owns the composed behaviour, where the order is never
    // issued in the first place.)
    const w = worldOf(mapOf(flat));
    const e = must(standCamp(w, 'pack', 6, 20)[0]);
    const far = 6 + CAMP_LEASH_RADIUS + 20; // 36 m out, well inside the map square
    orderMove(e, far, 20);
    tick(w, 400);
    expect(e.x).toBeCloseTo(far, 6);
  });
});

describe('determinism', () => {
  it('produces bit-identical paths and positions in two identical worlds', () => {
    const terrain = terrainOf(48, (x, z) => {
      if (x > 24 && x < 25) return z > 30 && z < 34 ? 'ramp' : 'cliff';
      return x > 25 ? 'high' : 'ground';
    });
    const build = (): SimWorld => {
      const w = worldOf(mapOf(terrain));
      const h = hero(w, 'p0');
      h.x = 6;
      h.z = 6;
      orderMove(h, 40, 6);
      return w;
    };
    const a = build();
    const b = build();
    tick(a, 400);
    tick(b, 400);
    const ha = hero(a, 'p0');
    const hb = hero(b, 'p0');
    expect(ha.x).toBe(hb.x);
    expect(ha.z).toBe(hb.z);
    expect(ha.pathIndex).toBe(hb.pathIndex);
    expect(JSON.stringify(ha.path)).toBe(JSON.stringify(hb.path));
  });

  it('returns the same route for the same query on the real map', () => {
    const map = buildMap(3);
    const first = findPath(map.terrain, 20, 100, 100, 20);
    const second = findPath(map.terrain, 20, 100, 100, 20);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it('is unaffected by an interleaved unrelated search', () => {
    const map = buildMap(3);
    const solo = findPath(map.terrain, 20, 100, 100, 20);
    findPath(map.terrain, 60, 60, 12, 118);
    const again = findPath(map.terrain, 20, 100, 100, 20);
    expect(JSON.stringify(again)).toBe(JSON.stringify(solo));
  });
});

describe('the sim keeps working on flat ground', () => {
  const flat = terrainOf(48, () => 'ground');

  it('moves and arrives exactly as it did before terrain existed', () => {
    const w = worldOf(mapOf(flat));
    const h = hero(w, 'p0');
    h.x = 10;
    h.z = 10;
    h.moveSpeed = 6;
    orderMove(h, 22, 10);
    const ticks = Math.ceil(12 / (6 / TICK_RATE));
    tick(w, ticks + 1);
    expect(h.x).toBeCloseTo(22, 6);
    expect(h.z).toBeCloseTo(10, 6);
    expect(h.order).toBe('idle');
  });

  it('never leaves the map square', () => {
    const w = worldOf(mapOf(flat));
    const h = hero(w, 'p0');
    h.x = 2;
    h.z = 2;
    orderMove(h, -50, -50);
    tick(w, 200);
    expect(h.x).toBeGreaterThanOrEqual(0);
    expect(h.z).toBeGreaterThanOrEqual(0);
    expect(h.x).toBeLessThanOrEqual(48);
    expect(h.z).toBeLessThanOrEqual(48);
  });
});

/** Shortest distance from (x,z) to a polyline — the lane-corridor measure. */
function distToPolyline(poly: readonly Vec2[], x: number, z: number): number {
  let best = Infinity;
  for (let i = 0; i + 1 < poly.length; i++) {
    const a = poly[i];
    const b = poly[i + 1];
    if (!a || !b) continue;
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len2 = dx * dx + dz * dz;
    let u = len2 > 0 ? ((x - a.x) * dx + (z - a.z) * dz) / len2 : 0;
    u = u < 0 ? 0 : u > 1 ? 1 : u;
    best = Math.min(best, Math.hypot(x - (a.x + u * dx), z - (a.z + u * dz)));
  }
  return best;
}
