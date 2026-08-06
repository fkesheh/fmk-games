// ============================================================================
// T3 — SIM CORE: movement.ts + pathing.ts tests (TERRAIN_CONTRACT §4, S_MOVE).
// Cliffs are solid and elevation changes need a ramp; heroes — and only heroes
// — get grid A*; lane creeps keep their polyline; camps hold their clearing;
// dashes stop at the rock instead of through it.
//
// Terrain is hand-painted per scenario rather than sampled from buildMap: the
// interesting cases (a one-cell-thick wall, a single ramp, a sealed pocket) are
// exactly the ones a generated map is contractually forbidden to contain, and a
// test that has to hunt the real map for a cliff asserts on whatever it found
// rather than on what the rule says. The real map is used where the real map IS
// the subject: lane corridors, camps, and cross-build determinism.
//
// `stepMovement` is driven directly rather than through `advance()` so that a
// failure here is a movement failure and not combat, waves or upkeep leaking in.
// ============================================================================
import { describe, expect, it } from 'vitest';
import {
  AGGRO_RADIUS,
  buildMap,
  CAMP_BRUTE,
  CAMP_HIVE,
  CAMP_LEASH_RADIUS,
  CAMP_PACK,
  ELEV_HIGH,
  ELEV_LOW,
  isPassable,
  isPlayerTeam,
  kindAt,
  LANE_CORRIDOR_HALF_W,
  NEUTRAL_TEAM,
  TERRAIN_KINDS,
  TICK_RATE,
} from '@rift/shared';
import type { CampDef, CreepTuning, EntKind, EntTeam, MapDef, TerrainDef, TerrainKind, Vec2 } from '@rift/shared';
import { SimWorld } from './world.js';
import { stepMovement } from './movement.js';
import { findPath, PATH_NODE_BUDGET, segmentWalkable, walkableFraction } from './pathing.js';
import { NO_ENT } from './types.js';
import type { AbilitiesEngine, Ent, EntId, SeatDef, World } from './types.js';

class EngineDouble implements AbilitiesEngine {
  step(world: World): void {
    world.drainCasts();
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
function terrainOf(side: number, paint: (x: number, z: number) => TerrainKind, camps: CampDef[] = []): TerrainDef {
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

/** Spawn a mobile, including a neutral one. `World.spawnMobile` is frozen with
 *  `team: EntTeam` (TERRAIN_CONTRACT §5), but the implementation still narrows
 *  to `TeamId` until S_WORLD widens it, so a neutral goes in as team 0 and has
 *  its team re-stamped — `Ent.team` is what movement actually reads. */
function spawn(w: SimWorld, kind: EntKind, team: EntTeam, x: number, z: number, lane: number): EntId {
  const id = w.spawnMobile(kind, isPlayerTeam(team) ? team : 0, x, z, lane, -1, NO_ENT);
  const e = must(w.get(id));
  if (!isPlayerTeam(team)) Object.assign(e, { team: NEUTRAL_TEAM });
  return id;
}

/** Spawn a camp member with its frozen tuning applied by hand.
 *  `spawnMobile`'s tuning table has no camp entries until S_CAMPS/S_WORLD add
 *  them, and a camp with `moveSpeed = 0` would make every leash assertion below
 *  pass for the wrong reason. Numbers come from config, never invented. */
function spawnCampMember(w: SimWorld, kind: EntKind, tuning: CreepTuning, x: number, z: number): Ent {
  const e = must(w.get(spawn(w, kind, NEUTRAL_TEAM, x, z, -1)));
  e.moveSpeed = tuning.moveSpeed;
  e.attackRange = tuning.attackRange;
  e.maxHp = tuning.hp;
  e.hp = tuning.hp;
  return e;
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

  it('plans once per destination and never re-searches per tick', () => {
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

    orderMove(h, 8, 40); // a new destination DOES re-plan
    tick(w);
    expect(h.path).not.toBe(planned);
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
    spawn(w, 'campPack', NEUTRAL_TEAM, at.x + 2, at.z, -1);
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
    spawn(w, 'campPack', NEUTRAL_TEAM, 42, 40, -1);
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
    const campId = spawn(w, 'campBrute', NEUTRAL_TEAM, 40 + AGGRO_RADIUS - 1, 40, -1);
    tick(w);
    expect(h.orderTarget).toBe(campId);
  });
});

describe('neutral camps', () => {
  const map = buildMap(2);
  const camp = map.terrain.camps[0];

  it('holds its clearing when nothing comes near', () => {
    const w = worldOf(map);
    const c = camp ?? { x: 50.5, z: 43.5 };
    const e = spawnCampMember(w, 'campHive', CAMP_HIVE, c.x, c.z);
    tick(w, 200);
    expect(Math.hypot(e.x - c.x, e.z - c.z)).toBeLessThan(0.2);
    expect(e.lane).toBe(-1);
    expect(e.waypoint).toBe(0); // it never entered lane-following code
    expect(e.path ?? null).toBeNull();
  });

  it('chases inside the leash and returns home when the target breaks away', () => {
    const w = worldOf(map);
    const c = camp ?? { x: 50.5, z: 43.5 };
    const e = spawnCampMember(w, 'campBrute', CAMP_BRUTE, c.x, c.z);
    const h = hero(w, 'p0');
    h.order = 'idle';
    h.x = c.x + 5;
    h.z = c.z;
    tick(w, 20);
    expect(e.orderTarget).toBe(h.id);
    expect(e.x).toBeGreaterThan(c.x); // it moved toward the intruder

    h.x = c.x + CAMP_LEASH_RADIUS + 6; // the hero leaves the leash disc
    tick(w, 200);
    expect(e.orderTarget).toBe(NO_ENT);
    expect(Math.hypot(e.x - c.x, e.z - c.z)).toBeLessThan(0.2);
  });

  it('never leaves its leash radius, whatever the bait does', () => {
    const w = worldOf(map);
    const c = camp ?? { x: 50.5, z: 43.5 };
    const e = spawnCampMember(w, 'campPack', CAMP_PACK, c.x, c.z);
    const h = hero(w, 'p0');
    h.order = 'idle';
    h.x = c.x + 4;
    h.z = c.z;
    let worst = 0;
    for (let i = 0; i < 400; i++) {
      h.x = c.x + 4 + (i % 40) * 0.5; // walked slowly out of the clearing, repeatedly
      tick(w);
      worst = Math.max(worst, Math.hypot(e.x - c.x, e.z - c.z));
    }
    expect(worst).toBeLessThanOrEqual(CAMP_LEASH_RADIUS);
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
