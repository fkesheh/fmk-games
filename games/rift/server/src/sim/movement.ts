// ============================================================================
// ANCIENTS (rift) — MOVEMENT (CONTRACT §4, T3). advance() step (4).
// Heroes steer straight at their order target; structures are circle obstacles
// resolved by push-out (the tangential remainder is the slide — no pathfinding,
// the map is open); soft separation between all mobiles (heroes take half
// weight against creeps); positions clamp to the map square. Creeps follow
// their lane polyline, detour to attack per aggro, and resume at the nearest
// FORWARD waypoint. Stun zeroes motion; dashes are scripted rapid moves that
// stop at structure edges and never leave the map.
//
// Speed = effective moveSpeed (base + items + haste, from recomputeEnt) *
// (1 - strongest active slow).
// ============================================================================
import { AGGRO_RADIUS, TICK_DT } from '@rift/shared';
import { NO_ENT } from './types.js';
import type { Ent } from './types.js';
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

function clampNum(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Is t a legal thing for e to swing at (alive enemy, not a ward/projectile)? */
function attackable(e: Ent, t: Ent): boolean {
  return t.alive && t.team !== e.team && t.kind !== 'ward' && t.kind !== 'proj';
}

/** Nearest attackable enemy MOBILE within radius r of e (wards/projs skipped).
 *  Uses the world's shared scratch; result must be consumed immediately. */
function nearestEnemyMobile(w: SimWorld, e: Ent, r: number): Ent | undefined {
  const n = w.inRadius(e.x, e.z, r, w.scratchA);
  let best: Ent | undefined;
  let bestD = Infinity;
  for (let i = 0; i < n; i++) {
    const t = w.scratchA[i];
    if (!t || t.id < 1000 || !attackable(e, t)) continue;
    const d = entDist(e, t);
    if (d < bestD) {
      bestD = d;
      best = t;
    }
  }
  return best;
}

/** Nearest attackable enemy (mobile OR structure) within radius r — the hero
 *  attack-move acquisition rule. */
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
    // is not a legal target.
    if (s.kind === 'ancient' && w.guardAlive(s.team)) continue;
    const d = entDist(e, s);
    if (d - e.radius - s.radius > e.attackRange + 1e-9) continue;
    if (d < bestD) {
      bestD = d;
      best = s;
    }
  }
  return best;
}

/** Move e toward (tx,tz) at its current speed for one tick. Returns true when
 *  the destination is reached this tick. Caller handles obstacles/bounds. */
function steer(e: Ent, tx: number, tz: number): boolean {
  const speed = e.moveSpeed * (1 - e.slowPct);
  const dx = tx - e.x;
  const dz = tz - e.z;
  const d = Math.hypot(dx, dz);
  const step = speed * TICK_DT;
  if (d <= Math.max(step, ARRIVE_EPS)) {
    e.x = tx;
    e.z = tz;
    return true;
  }
  if (step <= 0) return false;
  e.x += (dx / d) * step;
  e.z += (dz / d) * step;
  return false;
}

// --- per-kind motion -----------------------------------------------------------

function heroMotion(w: SimWorld, e: Ent): void {
  switch (e.order) {
    case 'move': {
      if (steer(e, e.ox, e.oz)) e.order = 'idle';
      return;
    }
    case 'attack': {
      const t = e.orderTarget !== NO_ENT ? w.get(e.orderTarget) : undefined;
      if (!t || !attackable(e, t)) {
        // Target gone: degrade to an attack-move to its last known position
        // (dead heroes keep their position), else drop to idle.
        if (t) {
          e.order = 'attackmove';
          e.ox = t.x;
          e.oz = t.z;
        } else {
          e.order = 'idle';
        }
        e.orderTarget = NO_ENT;
        return;
      }
      if (!inAttackRange(e, t)) steer(e, t.x, t.z);
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
        if (!inAttackRange(e, t)) steer(e, t.x, t.z);
        return;
      }
      if (steer(e, e.ox, e.oz)) e.order = 'idle';
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
    t = nearestEnemyMobile(w, e, AGGRO_RADIUS);
    if (!t) t = structureInReach(w, e);
    if (t) e.orderTarget = t.id;
  }
  if (t) {
    if (!inAttackRange(e, t)) steer(e, t.x, t.z);
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
  if (target) steer(e, target.x, target.z);
}

function summonMotion(w: SimWorld, e: Ent): void {
  let t = e.orderTarget !== NO_ENT ? w.get(e.orderTarget) : undefined;
  if (t && (!attackable(e, t) || entDist(e, t) > AGGRO_LEASH)) {
    t = undefined;
    e.orderTarget = NO_ENT;
  }
  if (!t) {
    t = nearestEnemyMobile(w, e, AGGRO_RADIUS);
    if (!t) t = structureInReach(w, e);
    if (t) e.orderTarget = t.id;
  }
  if (t) {
    if (!inAttackRange(e, t)) steer(e, t.x, t.z);
    return;
  }
  const owner = e.owner !== NO_ENT ? w.get(e.owner) : undefined;
  if (owner && owner.alive && entDist(e, owner) > SUMMON_FOLLOW_DIST) {
    steer(e, owner.x, owner.z);
  }
}

/** Scripted dash: cover the remaining distance evenly over the remaining
 *  ticks (~0.15 s total), ignoring slows; structure push-out and the bounds
 *  clamp below are what stop it at edges. */
function dashMotion(w: SimWorld, e: Ent): void {
  const remaining = e.dashUntilTick - w.tick;
  const dx = e.ox - e.x;
  const dz = e.oz - e.z;
  const d = Math.hypot(dx, dz);
  if (remaining <= 0 || d < 1e-3) {
    e.x = e.ox;
    e.z = e.oz;
    e.dashUntilTick = 0;
    return;
  }
  const step = d / remaining;
  e.x += (dx / d) * step;
  e.z += (dz / d) * step;
}

// --- the step --------------------------------------------------------------------

export function stepMovement(w: SimWorld): void {
  // 1. individual motion (steering / dash / waypoint following)
  for (const e of w.mobileMap.values()) {
    if (!e.alive || e.kind === 'proj' || e.kind === 'ward') continue;
    if (w.tick < e.stunUntilTick) continue; // stun zeroes movement
    if (e.dashUntilTick !== 0 && w.tick < e.dashUntilTick) {
      dashMotion(w, e);
      continue;
    }
    if (e.dashUntilTick !== 0) e.dashUntilTick = 0;
    switch (e.kind) {
      case 'hero':
        heroMotion(w, e);
        break;
      case 'shade':
        summonMotion(w, e);
        break;
      default:
        creepMotion(w, e); // melee / ranged / siege
        break;
    }
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
      // Weight split: hero-vs-creep pairs push the hero at half weight
      // (hero 1/3, creep 2/3); equal kinds split evenly.
      let shareA = 0.5;
      if (a.kind === 'hero' && b.kind !== 'hero') shareA = 1 / 3;
      else if (a.kind !== 'hero' && b.kind === 'hero') shareA = 2 / 3;
      a.x -= nx * overlap * shareA;
      a.z -= nz * overlap * shareA;
      b.x += nx * overlap * (1 - shareA);
      b.z += nz * overlap * (1 - shareA);
    }
  }

  // 3. structure push-out (tangential remainder = the slide) + map bounds
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
    e.x = clampNum(e.x, 0, w.map.side);
    e.z = clampNum(e.z, 0, w.map.side);
  }
  w.scratchA.length = 0;
}
