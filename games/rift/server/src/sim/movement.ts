// ============================================================================
// ANCIENTS (rift) — MOVEMENT (CONTRACT §4, T3). advance() step (4).
// Heroes steer at their order target; structures are circle obstacles resolved
// by push-out (the tangential remainder is the slide); soft separation between
// all mobiles (heroes take half weight against creeps); positions clamp to the
// map square. Creeps follow their lane polyline, detour to attack per aggro,
// and resume at the nearest FORWARD waypoint. Stun zeroes motion; dashes are
// scripted rapid moves that stop at structure edges and never leave the map.
//
// Speed = effective moveSpeed (base + items + haste, from recomputeEnt) *
// (1 - strongest active slow).
//
// AMENDED for TERRAIN_CONTRACT §4 and AMENDMENT_1 §A/§D:
//
//  1. CLIFFS ARE SOLID, AND ELEVATION NEEDS A RAMP. Every metre of motion in
//     this file goes through `travel()`, which sweeps the step against the
//     terrain grid (`segmentWalkable`, sim/pathing.ts) and, when the step is
//     refused, slides the motion along the face by keeping the axis component
//     that is still legal — the same "obstacle eats the normal, keeps the
//     tangent" resolution the structure push-out already uses. Swept, never an
//     endpoint test: a hasted hero and a dash both move further in one tick
//     than a cliff is thick, and an endpoint test would let them tunnel.
//  2. HEROES, AND ONLY HEROES, GET A* (sim/pathing.ts). Lane creeps keep pure
//     straight-line steering with `path = null` forever — their corridor is
//     contractually validated cliff-free (§3.2), which is the simplification
//     the whole design rests on. Camp creeps never leave their clearing.
//     A hero's path is planned when its destination CELL changes or when the
//     route it is holding is no longer walkable from where it stands — never
//     per tick — and at most `PATH_SEARCHES_PER_TICK` searches run in one tick
//     (AMENDMENT_1 §D); a hero whose request is deferred steers straight for
//     that tick and asks again on the next one.
//  3. NEUTRAL CAMPS ARE EXECUTED HERE, NOT DECIDED HERE (AMENDMENT_1 §A).
//     `campMotion` reads `order` / `ox` / `oz` / `orderTarget` and does exactly
//     what they say. It performs NO acquisition, NO leash test, NO home search
//     and NO hp change, it writes no order field, and it must not fall through
//     to `creepMotion` (a camp creep in lane-following code walks down a lane,
//     which is the single most likely way the jungle breaks). Every one of
//     those decisions belongs to sim/camps.ts, which runs after this step, so
//     an order it writes takes effect on the NEXT tick — that latency is
//     accepted and is not to be "fixed" by moving ents from camps.ts.
//     Lane creeps and summons still refuse to acquire camps, while hero
//     attack-move (`nearestEnemyAny`) still does — get that backwards and
//     either the jungle is inert or every creep wave suicides into it.
//  4. A CAMP MEMBER IS IMMOVABLE IN THE SEPARATION PASS (AMENDMENT_2 §A). It
//     takes none of the pair's displacement and the other party takes all of
//     it. The leash bounds what a camp CHOOSES to do; nothing bounded what
//     could be done TO it, and a member was measured shoved 31 m out of its
//     clearing by a hero driven into it every tick.
//
// Terrain collision is POINT-vs-cell, deliberately: unit radii resolve against
// other units and structures, as they always have, and a 1 m cell grid with
// per-cell corner rules already keeps a HERO_RADIUS disc off the rock.
// ============================================================================
import { AGGRO_RADIUS, isCampKind, isPlayerTeam, NEUTRAL_TEAM, TICK_DT } from '@rift/shared';
import type { TerrainDef } from '@rift/shared';
import { NO_ENT } from './types.js';
import type { Ent } from './types.js';
import {
  cellIndexAt,
  cellMidX,
  cellMidZ,
  cellPassable,
  nearestPassableCell,
  requestPath,
  resetPathBudget,
  segmentWalkable,
  walkableFraction,
} from './pathing.js';
import type { SimWorld } from './world.js';

/** Straight-line distance between two entities' centres. */
export function entDist(a: Ent, b: Ent): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

/** Edge-to-edge range check: a can basic-attack t when the gap between their
 *  discs is within a.attackRange. */
export function inAttackRange(a: Ent, t: Ent): boolean {
  return entDist(a, t) - a.radius - t.radius <= a.attackRange + 1e-9;
}

/** How far past its order destination a unit may aim before it counts as
 *  arrived (also the snap distance when a single step would overshoot). */
const ARRIVE_EPS = 0.12;
/** Creep aggro slack: a creep keeps chasing its current target until it is
 *  this far BEYOND the acquire radius (hysteresis against flicker). */
const AGGRO_LEASH = AGGRO_RADIUS + 2;
/** Hero attack-move chase leash. */
const AM_LEASH = AGGRO_RADIUS + 3;
/** Distance at which a creep counts a waypoint as reached. */
const WAYPOINT_REACH = 1.2;
/** Summons regroup on their owner beyond this distance. */
const SUMMON_FOLLOW_DIST = 3;
/** How far (in cells) the cliff push-out will look for standable ground. Cliff
 *  rings are one to three cells thick, so four always finds the outside. */
const PUSHOUT_SEARCH_CELLS = 4;

function clampNum(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Is `t` a MOBILE (as opposed to one of the map's structures)?
 *
 *  Asked of the world's own store rather than of the entity id. Structure ids
 *  and mobile ids are partitioned at 1000, but that partition is world.ts's
 *  private numbering with no type-level link to anything here: a module that
 *  spells `t.id < 1000` has hard-coded another file's invariant and will keep
 *  compiling on the day it changes. `mobileMap` IS the set of mobiles, so this
 *  is the definition rather than a proxy for it. */
function isMobile(w: SimWorld, t: Ent): boolean {
  return w.mobileMap.has(t.id);
}

/** Is t a legal thing for e to swing at (alive enemy, not a ward/projectile)?
 *  Neutrality falls out of the team comparison for free: a camp differs from
 *  both player teams, so camps and players are mutually hostile, and two camp
 *  creeps (both NEUTRAL_TEAM) never fight each other. */
function attackable(e: Ent, t: Ent): boolean {
  return t.alive && t.team !== e.team && t.kind !== 'ward' && t.kind !== 'proj';
}

/** Nearest attackable enemy MOBILE within radius r of e (wards/projs skipped).
 *  Uses the world's shared scratch; result must be consumed immediately.
 *
 *  `skipNeutral` is the auto-aggro carve-out of TERRAIN_CONTRACT §5: lane
 *  creeps and summons must never acquire a jungle camp, or a wave that clips a
 *  clearing walks out of its lane and dies in the jungle. Camps themselves
 *  never call this at all — acquisition for a camp lives in sim/camps.ts. */
function nearestEnemyMobile(w: SimWorld, e: Ent, r: number, skipNeutral: boolean): Ent | undefined {
  const n = w.inRadius(e.x, e.z, r, w.scratchA);
  let best: Ent | undefined;
  let bestD = Infinity;
  for (let i = 0; i < n; i++) {
    const t = w.scratchA[i];
    if (!t || !isMobile(w, t) || !attackable(e, t)) continue;
    if (skipNeutral && t.team === NEUTRAL_TEAM) continue;
    const d = entDist(e, t);
    if (d < bestD) {
      bestD = d;
      best = t;
    }
  }
  return best;
}

/** Nearest attackable enemy (mobile OR structure) within radius r — the hero
 *  attack-move acquisition rule. Camps are deliberately NOT excluded here:
 *  this is the only path by which a hero or a bot can ever engage the jungle
 *  (TERRAIN_CONTRACT §5). */
function nearestEnemyAny(w: SimWorld, e: Ent, r: number): Ent | undefined {
  const n = w.inRadius(e.x, e.z, r, w.scratchA);
  let best: Ent | undefined;
  let bestD = Infinity;
  for (let i = 0; i < n; i++) {
    const t = w.scratchA[i];
    if (!t || !attackable(e, t)) continue;
    const d = entDist(e, t);
    if (d < bestD) {
      bestD = d;
      best = t;
    }
  }
  return best;
}

/** Nearest enemy STRUCTURE already inside the creep's attack reach — creeps
 *  do not aggro structures at distance (CONTRACT: creep aggro is mobiles
 *  within AGGRO_RADIUS), but they swing at what their lane walk brings them
 *  to. Lane towers stand 2.5 m off the path, inside this reach. */
function structureInReach(w: SimWorld, e: Ent): Ent | undefined {
  let best: Ent | undefined;
  let bestD = Infinity;
  for (const s of w.structures) {
    if (!s.alive || s.team === e.team) continue;
    // An ancient its guards still protect cannot be damaged: like a ward, it
    // is not a legal target. `guardAlive` takes a TeamId and a structure is
    // never neutral (StructureDef.team is TeamId), so the guard narrows rather
    // than asserts — and a would-be neutral structure is simply not a target.
    if (s.kind === 'ancient' && (!isPlayerTeam(s.team) || w.guardAlive(s.team))) continue;
    const d = entDist(e, s);
    if (d - e.radius - s.radius > e.attackRange + 1e-9) continue;
    if (d < bestD) {
      bestD = d;
      best = s;
    }
  }
  return best;
}

// --- terrain-aware motion primitives ------------------------------------------

/** Spend a single-axis remainder if any of it is legal. Returns whether the
 *  unit moved at all. */
function slideAxis(t: TerrainDef, e: Ent, rx: number, rz: number): boolean {
  if (rx === 0 && rz === 0) return false;
  const f = walkableFraction(t, e.x, e.z, e.x + rx, e.z + rz);
  if (!(f > 0)) return false;
  e.x += rx * f;
  e.z += rz * f;
  return true;
}

/** Apply a motion vector with the cliff veto, in two stages: travel as far
 *  along it as the terrain allows (so a dash stops AT the face rather than
 *  refusing to start), then spend what is left of the step sliding.
 *
 *  Cell faces are axis-aligned, so re-offering the REMAINDER on a single axis
 *  is the projection of the motion onto the cliff tangent: a unit walking into
 *  a face keeps its sideways travel and loses only the component into the rock.
 *  Exactly one axis may take the remainder, so wall-hugging never travels
 *  further in a tick than open ground would. Head-on into a face both
 *  components vanish and the unit stops dead — there is nothing to oscillate
 *  between, which is why this needs no anti-jitter term.
 *
 *  WHICH axis is offered first is the motion's own dominant tangent, not a
 *  fixed X-then-Z order. A fixed order is a bias in world space: two units
 *  meeting the same wall from opposite sides both drifted +X, which reads as
 *  the terrain pushing everything one way. Comparing the two remainders is a
 *  property of the step, so the drift follows where the unit was going. An
 *  exact tie resolves to X, which keeps it deterministic. */
function slideStep(t: TerrainDef, e: Ent, mx: number, mz: number): void {
  const f = walkableFraction(t, e.x, e.z, e.x + mx, e.z + mz);
  if (f >= 1) {
    e.x += mx;
    e.z += mz;
    return;
  }
  if (f > 0) {
    e.x += mx * f;
    e.z += mz * f;
  }
  const rx = mx * (1 - f);
  const rz = mz * (1 - f);
  const ax = rx < 0 ? -rx : rx;
  const az = rz < 0 ? -rz : rz;
  if (ax >= az) {
    if (slideAxis(t, e, rx, 0)) return;
    slideAxis(t, e, 0, rz);
    return;
  }
  if (slideAxis(t, e, 0, rz)) return;
  slideAxis(t, e, rx, 0);
}

/**
 * Move `e` toward (tx,tz) spending at most `budget` metres of travel, honouring
 * the cliff veto. Returns the LEFTOVER budget when the destination was reached
 * on this call, or -1 when it was not (still travelling, or blocked by rock).
 *
 * The leftover is what lets a path follower consume several waypoints in one
 * tick without ever moving twice as far as its speed allows.
 */
function travel(w: SimWorld, e: Ent, tx: number, tz: number, budget: number): number {
  const t = w.map.terrain;
  const dx = tx - e.x;
  const dz = tz - e.z;
  const d = Math.hypot(dx, dz);
  if (!(d > 1e-9)) return budget > 0 ? budget : 0; // already standing on it
  const reach = budget > ARRIVE_EPS ? budget : ARRIVE_EPS;
  if (d <= reach) {
    if (segmentWalkable(t, e.x, e.z, tx, tz)) {
      e.x = tx;
      e.z = tz;
      return budget > d ? budget - d : 0;
    }
    // The last stretch is walled off: slide what is left of it and report that
    // the destination was NOT reached, so the order stays live.
    if (budget > 0) {
      const step = d < budget ? d : budget;
      slideStep(t, e, (dx / d) * step, (dz / d) * step);
    }
    return -1;
  }
  if (budget <= 0) return -1;
  slideStep(t, e, (dx / d) * budget, (dz / d) * budget);
  return -1;
}

/** Move e toward (tx,tz) at its current speed for one tick. Returns true when
 *  the destination is reached this tick. Caller handles unit/structure
 *  obstacles and bounds; terrain is handled here. */
function steer(w: SimWorld, e: Ent, tx: number, tz: number): boolean {
  const speed = e.moveSpeed * (1 - e.slowPct);
  return travel(w, e, tx, tz, speed * TICK_DT) >= 0;
}

/** Forget the current route. `Ent.path`'s frozen invariant is "every new order
 *  resets this to null and pathIndex to 0"; this is that reset, and it is
 *  called at every point where THIS file issues or completes an order. It is
 *  deliberately NOT called while chasing: a chase is straight-line steering
 *  that does not read the route, and clearing it every chase tick is what
 *  forced a fresh A* the moment the chase ended (AMENDMENT_1 §D). */
function clearPath(e: Ent): void {
  e.path = null;
  e.pathIndex = 0;
}

/**
 * May `e` keep walking the route it is holding?
 *
 * Three conditions, and the second is the one that was missing:
 *
 *  1. the route must lead to the CURRENT order destination — compared by CELL,
 *     per AMENDMENT_1 §D, so nudging a destination inside the metre it already
 *     occupies does not buy a search. The follower walks the exact (ox, oz) in
 *     its tail leg anyway, so cell equality loses no precision;
 *  2. the leg the unit is actually on must be walkable FROM WHERE IT STANDS.
 *     A route is planned from a position; a dash, a push-out or a chase can
 *     move the unit off it while the destination is unchanged, and the old code
 *     — which memoised on the destination alone — then kept a `pathIndex` that
 *     pointed at a waypoint the unit could no longer reach, so `travel()`
 *     returned -1 for ever and the hero never arrived;
 *  3. a route of ONE point is always terminal: it is what the follower writes
 *     when the search reported "no route, steer straight". Re-planning it would
 *     re-run that failed search every tick, which is the exact per-tick cost
 *     §4 forbids. The same applies to a leg blocked only because the DESTINATION
 *     is inside rock: pressing against the face is the intended behaviour there,
 *     not evidence of a stale route.
 */
function pathUsable(t: TerrainDef, e: Ent): boolean {
  const path = e.path;
  if (!path || path.length === 0) return false;
  const last = path[path.length - 1];
  if (!last) return false;
  const g = t.grid;
  const destCell = cellIndexAt(g, e.ox, e.oz);
  if (cellIndexAt(g, last.x, last.z) !== destCell) return false;
  if (path.length === 1) return true;
  if (e.pathIndex >= path.length) return true;
  const wp = path[e.pathIndex];
  if (!wp) return false;
  if (segmentWalkable(t, e.x, e.z, wp.x, wp.z)) return true;
  return !cellPassable(g, destCell);
}

/** Guarantee `e.path` describes a route the unit can walk to its CURRENT order
 *  destination. Returns false when the tick's search allowance is spent: the
 *  caller steers straight this tick and this runs again next tick, leaving the
 *  stale route untouched rather than memoising a guess. */
function ensurePath(t: TerrainDef, e: Ent): boolean {
  if (pathUsable(t, e)) return true;
  const plan = requestPath(t, e.x, e.z, e.ox, e.oz);
  if (plan.deferred) return false;
  // A null plan is the final answer "there is no route worth walking" — record
  // it as the one-point route so condition (3) above stops it being re-asked.
  e.path = plan.path ?? [{ x: e.ox, z: e.oz }];
  e.pathIndex = 0;
  return true;
}

/** Walk the hero along its A* route toward (ox, oz) for one tick. Returns true
 *  on arrival at the final waypoint, which is what ends a move order. */
function followPath(w: SimWorld, e: Ent): boolean {
  let budget = e.moveSpeed * (1 - e.slowPct) * TICK_DT;
  if (!ensurePath(w.map.terrain, e)) return travel(w, e, e.ox, e.oz, budget) >= 0;
  const path = e.path;
  if (!path || path.length === 0) return travel(w, e, e.ox, e.oz, budget) >= 0;
  // Bounded by the waypoint count: each iteration consumes one waypoint, and
  // running out of budget or hitting rock returns immediately.
  for (let hop = 0; hop <= path.length; hop++) {
    const i = e.pathIndex;
    if (i >= path.length) return travel(w, e, e.ox, e.oz, budget) >= 0;
    const wp = path[i];
    if (!wp) {
      e.pathIndex = i + 1;
      continue;
    }
    const left = travel(w, e, wp.x, wp.z, budget);
    if (left < 0) return false;
    e.pathIndex = i + 1;
    if (e.pathIndex >= path.length) return true;
    budget = left;
    if (budget <= 0) return false;
  }
  return false;
}

// --- per-kind motion -----------------------------------------------------------

function heroMotion(w: SimWorld, e: Ent): void {
  switch (e.order) {
    case 'move': {
      if (followPath(w, e)) {
        e.order = 'idle';
        clearPath(e);
      }
      return;
    }
    case 'attack': {
      const t = e.orderTarget !== NO_ENT ? w.get(e.orderTarget) : undefined;
      if (!t || !attackable(e, t)) {
        // Target gone: degrade to an attack-move to its last known position
        // (dead heroes keep their position), else drop to idle. Both are NEW
        // orders, so both reset the route.
        if (t) {
          e.order = 'attackmove';
          e.ox = t.x;
          e.oz = t.z;
        } else {
          e.order = 'idle';
        }
        e.orderTarget = NO_ENT;
        clearPath(e);
        return;
      }
      // Chasing is straight-line by design: the target moves, and re-planning a
      // route at it every tick is the per-tick search the contract forbids. The
      // route it is carrying is simply not read while this branch runs.
      if (!inAttackRange(e, t)) steer(w, e, t.x, t.z);
      return;
    }
    case 'attackmove': {
      let t = e.orderTarget !== NO_ENT ? w.get(e.orderTarget) : undefined;
      if (t && (!attackable(e, t) || entDist(e, t) > AM_LEASH)) {
        t = undefined;
        e.orderTarget = NO_ENT;
      }
      if (!t) {
        t = nearestEnemyAny(w, e, AGGRO_RADIUS);
        if (t) e.orderTarget = t.id;
      }
      if (t) {
        if (!inAttackRange(e, t)) steer(w, e, t.x, t.z);
        return;
      }
      // Back to travelling: `pathUsable` re-checks the route the chase left
      // behind and re-plans only if the hero has come off it.
      if (followPath(w, e)) {
        e.order = 'idle';
        clearPath(e);
      }
      return;
    }
    case 'idle':
      return;
  }
}

function creepMotion(w: SimWorld, e: Ent): void {
  // Sticky target: keep attacking the unit already being attacked while it
  // stays within the leash (CONTRACT: prefer the current target).
  let t = e.orderTarget !== NO_ENT ? w.get(e.orderTarget) : undefined;
  if (t && (!attackable(e, t) || entDist(e, t) > AGGRO_LEASH)) {
    t = undefined;
    e.orderTarget = NO_ENT;
  }
  if (!t) {
    t = nearestEnemyMobile(w, e, AGGRO_RADIUS, true);
    if (!t) t = structureInReach(w, e);
    if (t) e.orderTarget = t.id;
  }
  if (t) {
    if (!inAttackRange(e, t)) steer(w, e, t.x, t.z);
    return;
  }
  // Lane following: advance the waypoint cursor forward-only (never resume
  // backward after a detour), then walk at the current waypoint.
  const path = e.lane >= 0 ? w.map.paths[e.lane] : undefined;
  if (!path || path.length < 2) return;
  const dir = e.team === 0 ? 1 : -1;
  let wp = clampNum(e.waypoint, 0, path.length - 1);
  for (;;) {
    const cur = path[wp];
    if (!cur) break;
    const next = path[wp + dir];
    if (!next) break; // final waypoint (enemy base): head straight at it
    const sx = next.x - cur.x;
    const sz = next.z - cur.z;
    const len = Math.hypot(sx, sz) || 1;
    const along = ((e.x - cur.x) * sx + (e.z - cur.z) * sz) / len;
    if (along > 0 || Math.hypot(e.x - cur.x, e.z - cur.z) < WAYPOINT_REACH) {
      wp += dir;
      continue;
    }
    break;
  }
  e.waypoint = wp;
  const target = path[wp];
  if (target) steer(w, e, target.x, target.z);
}

function summonMotion(w: SimWorld, e: Ent): void {
  let t = e.orderTarget !== NO_ENT ? w.get(e.orderTarget) : undefined;
  if (t && (!attackable(e, t) || entDist(e, t) > AGGRO_LEASH)) {
    t = undefined;
    e.orderTarget = NO_ENT;
  }
  if (!t) {
    t = nearestEnemyMobile(w, e, AGGRO_RADIUS, true);
    if (!t) t = structureInReach(w, e);
    if (t) e.orderTarget = t.id;
  }
  if (t) {
    if (!inAttackRange(e, t)) steer(w, e, t.x, t.z);
    return;
  }
  const owner = e.owner !== NO_ENT ? w.get(e.owner) : undefined;
  if (owner && owner.alive && entDist(e, owner) > SUMMON_FOLLOW_DIST) {
    steer(w, e, owner.x, owner.z);
  }
}

/**
 * Neutral camp motion — the EXECUTOR half of the camps seam (AMENDMENT_1 §A).
 *
 * sim/camps.ts decides; this carries the decision out and nothing else. It
 * reads only `order`, `ox`, `oz` and `orderTarget`, and it writes only `x` and
 * `z` (through `steer`, so the cliff veto still applies). In particular it does
 * NOT acquire a target, does NOT measure a leash, does NOT know where the
 * member's clearing is, does NOT touch hp, and does NOT write an order field
 * back — every one of those was the half of the old design that never met the
 * other half. An `idle` member does not move at all: its post is where camps.ts
 * put it, and stepping toward anything from there would fight pass-2
 * separation for ever.
 *
 * An `attack` order follows the target's LIVE position, which is what "attack"
 * means for every other kind in this file. If that target has left the world
 * the member walks at `(ox, oz)` — the last position camps.ts recorded — for
 * exactly one tick, until camps.ts re-decides.
 */
function campMotion(w: SimWorld, e: Ent): void {
  if (e.order === 'idle') return;
  if (e.order === 'attack' && e.orderTarget !== NO_ENT) {
    const t = w.get(e.orderTarget);
    if (t) {
      if (!inAttackRange(e, t)) steer(w, e, t.x, t.z);
      return;
    }
  }
  steer(w, e, e.ox, e.oz);
}

/** Scripted dash: cover the remaining distance evenly over the remaining
 *  ticks (~0.15 s total), ignoring slows. Structure push-out, the bounds clamp
 *  and the cliff veto inside `travel` are what stop it at edges — a dash into a
 *  cliff face stops AT the face and never crosses it, and a dash that has been
 *  fully stopped ends there rather than grinding against the rock for the rest
 *  of its duration. */
function dashMotion(w: SimWorld, e: Ent): void {
  const remaining = e.dashUntilTick - w.tick;
  const dx = e.ox - e.x;
  const dz = e.oz - e.z;
  const d = Math.hypot(dx, dz);
  if (remaining <= 0 || d < 1e-3) {
    if (segmentWalkable(w.map.terrain, e.x, e.z, e.ox, e.oz)) {
      e.x = e.ox;
      e.z = e.oz;
    }
    e.dashUntilTick = 0;
    return;
  }
  const beforeX = e.x;
  const beforeZ = e.z;
  travel(w, e, e.ox, e.oz, d / remaining);
  if (e.x === beforeX && e.z === beforeZ) e.dashUntilTick = 0;
}

// --- the step --------------------------------------------------------------------

export function stepMovement(w: SimWorld): void {
  // A fresh A* allowance for this tick (AMENDMENT_1 §D). This is the only
  // caller: pathing's counter is per sim tick, and movement is the only thing
  // in the sim that searches.
  resetPathBudget();

  // 1. individual motion (steering / dash / waypoint following)
  for (const e of w.mobileMap.values()) {
    if (!e.alive || e.kind === 'proj' || e.kind === 'ward') continue;
    if (w.tick < e.stunUntilTick) continue; // stun zeroes movement
    if (e.dashUntilTick !== 0 && w.tick < e.dashUntilTick) {
      dashMotion(w, e);
      continue;
    }
    if (e.dashUntilTick !== 0) e.dashUntilTick = 0;
    // Dispatch by kind. The camp arm tests `isCampKind` (AMENDMENT_1 §B.4)
    // rather than restating the three camp kinds, so a fourth tier cannot
    // silently fall through into lane-following code.
    if (e.kind === 'hero') heroMotion(w, e);
    else if (e.kind === 'shade') summonMotion(w, e);
    else if (isCampKind(e.kind)) campMotion(w, e);
    else creepMotion(w, e); // melee / ranged / siege
  }

  // 2. soft separation between overlapping mobiles (heroes take half weight
  //    against creeps: the creep is pushed further than the hero)
  w.scratchA.length = 0;
  for (const e of w.mobileMap.values()) {
    if (!e.alive || e.kind === 'proj' || e.kind === 'ward') continue;
    w.scratchA.push(e);
  }
  const list = w.scratchA;
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (!a) continue;
    for (let j = i + 1; j < list.length; j++) {
      const b = list[j];
      if (!b) continue;
      const minD = a.radius + b.radius;
      let dx = b.x - a.x;
      let dz = b.z - a.z;
      let d = Math.hypot(dx, dz);
      if (d >= minD) continue;
      if (d < 1e-6) {
        dx = 1;
        dz = 0;
        d = 1;
      }
      const overlap = minD - d;
      const nx = dx / d;
      const nz = dz / d;
      // Weight split. A CAMP MEMBER HAS INFINITE MASS (AMENDMENT_2 §A): it does
      // not move, and the whole displacement goes to the other party, so heroes
      // and creeps slide around a camp instead of pushing it. AMENDMENT_1 §A
      // forbids the position clamp, which bounds a camp's CHASE at
      // CAMP_LEASH_RADIUS but bounds a SHOVE at nothing — a hero driven into a
      // member at 8 m/s every tick was measured carrying it 31 m from its
      // clearing, and a camp shoved into a lane drags neutrals into a fight
      // they should never be in, deterministically. Making the member immovable
      // removes that at the source and leaves the leash rule doing one job.
      // This wins over the hero split below: against a camp, a hero is the one
      // that moves. Camp-vs-camp is a normal even split, or two overlapping
      // members of the same camp would never separate at all.
      const aCamp = isCampKind(a.kind);
      const bCamp = isCampKind(b.kind);
      let shareA = 0.5;
      if (aCamp !== bCamp) shareA = aCamp ? 0 : 1;
      // Hero-vs-creep pairs push the hero at half weight (hero 1/3, creep 2/3);
      // equal kinds split evenly.
      else if (!aCamp && a.kind === 'hero' && b.kind !== 'hero') shareA = 1 / 3;
      else if (!aCamp && a.kind !== 'hero' && b.kind === 'hero') shareA = 2 / 3;
      a.x -= nx * overlap * shareA;
      a.z -= nz * overlap * shareA;
      b.x += nx * overlap * (1 - shareA);
      b.z += nz * overlap * (1 - shareA);
    }
  }

  // 3. structure push-out (tangential remainder = the slide), then cliff
  //    push-out, then map bounds
  const grid = w.map.terrain.grid;
  for (const e of list) {
    if (!e) continue;
    for (const s of w.structures) {
      if (!s.alive) continue;
      const minD = s.radius + e.radius;
      let dx = e.x - s.x;
      let dz = e.z - s.z;
      let d = Math.hypot(dx, dz);
      if (d >= minD) continue;
      if (d < 1e-6) {
        dx = 1;
        dz = 0;
        d = 1;
      }
      e.x = s.x + (dx / d) * minD;
      e.z = s.z + (dz / d) * minD;
      // Micro tangential drift (0.4 m/s while touching): breaks the degenerate
      // exactly-head-on alignment that pure radial push-out would deadlock.
      e.x += (-dz / d) * 0.02;
      e.z += (dx / d) * 0.02;
    }
    // Cliff push-out: separation and the structure push-out above both move
    // units without consulting terrain, so a unit can end a tick inside rock.
    // Eject it to the nearest standable cell centre — §3.4 (no passable cell
    // walled on three sides) is what makes this always an escape and not a
    // shuffle back into the same trap — with the same 0.02 tangential drift.
    const idx = cellIndexAt(grid, e.x, e.z);
    if (!cellPassable(grid, idx)) {
      const free = nearestPassableCell(grid, e.x, e.z, PUSHOUT_SEARCH_CELLS);
      if (free >= 0) {
        const fx = cellMidX(grid, free);
        const fz = cellMidZ(grid, free);
        const dx = fx - e.x;
        const dz = fz - e.z;
        const d = Math.hypot(dx, dz) || 1;
        e.x = fx + (-dz / d) * 0.02;
        e.z = fz + (dx / d) * 0.02;
      }
    }
    e.x = clampNum(e.x, 0, w.map.side);
    e.z = clampNum(e.z, 0, w.map.side);
  }
  w.scratchA.length = 0;
}
