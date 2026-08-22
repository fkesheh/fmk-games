// ============================================================================
// SUMO SIM — pure physics at a fixed tick. NO clocks, NO maps of players, NO
// io: the room owns time and membership and calls into these functions once
// per body per tick. Everything here is unit-testable without a room.
//
// Movement model (specs/P10.md): accel 40 u/s², exponential friction 6/s,
// soft max speed 9 u/s — the cap only limits what ACCELERATION can reach, so
// a dash impulse (18 u/s) overshoots it and friction bleeds the excess back
// down (~0.12s from 18 to 9). DASH = bit-0 press edge while grounded and off
// cooldown; JUMP = bit-1 press edge while grounded; airborne bodies cannot
// dash. Contact is an elastic equal-mass circle pushout, so a dashing shover
// transfers most of its momentum to a standing shovee.
// ============================================================================
import {
  BODY_RADIUS,
  DASH_COOLDOWN_S,
  DASH_FLASH_S,
  DASH_IMPULSE,
  FALL_Y,
  FRICTION,
  GRAVITY,
  JUMP_VY,
  MAX_SPEED,
  MOVE_ACCEL,
  PLATFORM_R_END,
  PLATFORM_R_START,
  PUSH_RESTITUTION,
  ROUND_SHRINK_S,
} from '@sumo/shared';
import { BIT_DASH, BIT_JUMP } from '@sumo/shared';

/** One authoritative body. Positions are world units; y is FEET height. */
export interface SumoBody {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  /** Facing, radians (YXZ house convention: forward is +z rotated by yaw). */
  yaw: number;
  /** Seconds until the next dash is allowed (0 = ready). */
  dashCd: number;
  /** Seconds of `dashing=true` left (visual flag on the wire). */
  dashFlash: number;
  /** Ground contact this tick — gates dash/jump. */
  grounded: boolean;
  /** Held-button latch from the previous step (press-edge detection). */
  prevBits: number;
}

export function makeBody(x: number, z: number, yaw = 0): SumoBody {
  return {
    x,
    y: 0,
    z,
    vx: 0,
    vy: 0,
    vz: 0,
    yaw,
    dashCd: 0,
    dashFlash: 0,
    grounded: true,
    prevBits: 0,
  };
}

/**
 * Advance one body by `dt` seconds from intent (axes -1..1 each, button mask)
 * and whether the ground under it is still inside the platform (`supported`).
 * Press EDGES fire actions: holding a bit does not repeat it.
 */
export function stepBody(
  b: SumoBody,
  mx: number,
  mz: number,
  bits: number,
  supported: boolean,
  dt: number,
): void {
  const dashPress = (bits & BIT_DASH) !== 0 && (b.prevBits & BIT_DASH) === 0;
  const jumpPress = (bits & BIT_JUMP) !== 0 && (b.prevBits & BIT_JUMP) === 0;
  b.prevBits = bits;

  if (b.dashCd > 0) b.dashCd = Math.max(0, b.dashCd - dt);
  if (b.dashFlash > 0) b.dashFlash = Math.max(0, b.dashFlash - dt);

  // ---- intent direction (normalized, magnitude <= 1 so analog tilt scales) --
  let ix = 0;
  let iz = 0;
  const mag = Math.hypot(mx, mz);
  if (mag > 1e-6) {
    const k = mag > 1 ? 1 / mag : 1;
    ix = mx * k;
    iz = mz * k;
  }

  // ---- acceleration with the soft speed cap ---------------------------------
  // Sustained input ramps to exactly MAX_SPEED (the cap clamps post-accel
  // velocity whenever the body was at-or-below it); a body already ABOVE the
  // cap (fresh dash) gets no steering help until friction bleeds it back.
  const sp0 = Math.hypot(b.vx, b.vz);
  if (mag > 1e-6 && sp0 <= MAX_SPEED) {
    b.vx += ix * MOVE_ACCEL * dt;
    b.vz += iz * MOVE_ACCEL * dt;
    const sp1 = Math.hypot(b.vx, b.vz);
    if (sp1 > MAX_SPEED) {
      const k = MAX_SPEED / sp1;
      b.vx *= k;
      b.vz *= k;
    }
  }

  // ---- friction --------------------------------------------------------------
  // No input: exponential glide to a stop (v *= e^(-FRICTION·t)).
  // Input held: decay only the OVERSHOOT above MAX_SPEED, so a dash bleeds
  // back toward run speed while steering stays fully responsive.
  if (mag > 1e-6 && sp0 > MAX_SPEED) {
    const f = Math.exp(-FRICTION * dt);
    const sp = Math.hypot(b.vx, b.vz);
    const k = (MAX_SPEED + (sp - MAX_SPEED) * f) / sp;
    b.vx *= k;
    b.vz *= k;
  } else if (mag <= 1e-6) {
    const f = Math.exp(-FRICTION * dt);
    b.vx *= f;
    b.vz *= f;
  }

  // ---- actions ---------------------------------------------------------------
  if (dashPress && b.grounded && b.dashCd <= 0) {
    // Along the move dir; with no stick input, along current facing.
    let dx = ix;
    let dz = iz;
    if (mag <= 1e-6) {
      dx = Math.sin(b.yaw);
      dz = Math.cos(b.yaw);
    }
    const len = Math.hypot(dx, dz) || 1;
    b.vx += (dx / len) * DASH_IMPULSE;
    b.vz += (dz / len) * DASH_IMPULSE;
    b.dashCd = DASH_COOLDOWN_S;
    b.dashFlash = DASH_FLASH_S;
  }
  if (jumpPress && b.grounded) {
    b.vy = JUMP_VY;
    b.y = Math.max(b.y, 0.001); // leave the ground plane this instant
    b.grounded = false;
  }

  // ---- integrate ---------------------------------------------------------------
  b.x += b.vx * dt;
  b.z += b.vz * dt;

  // ---- vertical: gravity unless the platform is holding us up ----------------
  // "Resting" means EXACTLY y===0 on the disc; anything else (above it,
  // below the rim, past the edge) integrates. The landing check refuses
  // bodies that already sank well below the rim (y <= -1), so a body that
  // drifted back inside the radius mid-fall cannot teleport onto the disc.
  const airborne = !supported || b.y !== 0;
  if (airborne) {
    b.vy += GRAVITY * dt;
    b.y += b.vy * dt;
    b.grounded = false;
    if (supported && b.y <= 0 && b.vy <= 0 && b.y > -1) {
      b.y = 0;
      b.vy = 0;
      b.grounded = true;
    }
  } else {
    b.y = 0;
    b.vy = 0;
    b.grounded = true;
  }

  // Facing follows actual motion (dead zone avoids jitter at ~0 speed).
  const sp = Math.hypot(b.vx, b.vz);
  if (sp > 0.5) b.yaw = Math.atan2(b.vx, b.vz);
}

/** True once this body has fallen out of the world. */
export function hasFallenOut(b: SumoBody): boolean {
  return b.y < FALL_Y;
}

/**
 * Elastic circle pushout for one pair (equal masses). Overlap splits half/half
 * along the normal; the normal impulse uses restitution PUSH_RESTITUTION.
 * Returns the approach speed along the normal (> 0 means they collided AND
 * `a` was the shover — it moved toward `b`), else 0 (apart or separating).
 */
export function resolvePair(a: SumoBody, b: SumoBody): number {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const minD = BODY_RADIUS * 2;
  const d2 = dx * dx + dz * dz;
  if (d2 >= minD * minD) return 0;
  const d = Math.sqrt(d2);
  let nx = 1;
  let nz = 0;
  if (d > 1e-6) {
    nx = dx / d;
    nz = dz / d;
  } else {
    // Perfectly coincident: push apart along +x deterministically.
    a.x -= minD / 2;
    b.x += minD / 2;
    return 0;
  }

  const overlap = minD - d;
  a.x -= nx * overlap * 0.5;
  a.z -= nz * overlap * 0.5;
  b.x += nx * overlap * 0.5;
  b.z += nz * overlap * 0.5;

  const vn = (a.vx - b.vx) * nx + (a.vz - b.vz) * nz; // >0: a approaching b
  if (vn <= 0) return 0;
  const j = ((1 + PUSH_RESTITUTION) / 2) * vn; // equal masses: impulse split evenly
  a.vx -= j * nx;
  a.vz -= j * nz;
  b.vx += j * nx;
  b.vz += j * nz;
  return vn;
}

/**
 * Who initiated a collision between two overlapping bodies: the one carrying
 * MORE velocity toward the other along the pair normal (momentum-weighted
 * attribution — a dasher is credited over a drift). Call BEFORE resolvePair
 * mutates the velocities. True => `a` is the pusher.
 */
export function pusherIsA(a: SumoBody, b: SumoBody): boolean {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const d = Math.hypot(dx, dz) || 1;
  const nx = dx / d;
  const nz = dz / d;
  const ca = a.vx * nx + a.vz * nz; // a's speed toward b
  const cb = -(b.vx * nx + b.vz * nz); // b's speed toward a
  return ca >= cb;
}

/** Platform radius after `elapsedS` of live phase (linear shrink, clamped). */
export function platformRadiusAt(elapsedS: number): number {
  const t = elapsedS <= 0 ? 0 : elapsedS >= ROUND_SHRINK_S ? 1 : elapsedS / ROUND_SHRINK_S;
  return PLATFORM_R_START + (PLATFORM_R_END - PLATFORM_R_START) * t;
}

/** One alive player's claim to the round: id + distance from the center. */
export interface AliveStanding {
  readonly id: string;
  readonly distToCenter: number;
}

export interface RoundOutcome {
  /** Round winner id, or null. */
  winner: string | null;
  /** True only when NOBODY survived. */
  draw: boolean;
}

/**
 * Round resolution (frozen rule):
 *   exactly 1 alive            -> that player wins ('last_standing')
 *   timer expired, >= 2 alive  -> the MOST CENTERED survivor wins
 *   0 alive                    -> draw
 * Deterministic: distance ties break to the EARLIEST entry in `alive`.
 */
export function decideRound(alive: readonly AliveStanding[]): RoundOutcome {
  if (alive.length === 0) return { winner: null, draw: true };
  if (alive.length === 1) {
    const only = alive[0];
    return only !== undefined ? { winner: only.id, draw: false } : { winner: null, draw: true };
  }
  let best = alive[0];
  for (const c of alive) {
    if (c !== undefined && best !== undefined && c.distToCenter < best.distToCenter) best = c;
  }
  return best !== undefined ? { winner: best.id, draw: false } : { winner: null, draw: true };
}
