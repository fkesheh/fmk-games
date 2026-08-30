// ============================================================================
// ACES flight model — FROZEN Layer-1 logic.
//
// Pure, deterministic functions over plain state objects. The SERVER sim and
// the CLIENT prediction both call stepPlane()/stepBullets() — they MUST stay
// byte-identical or prediction diverges. No randomness in here; spread jitter
// is applied by the shooter (server rolls it, clients render what arrived).
//
// Flight law (arcade, no stall):
//   - facing h turns at turnRate scaled by speed fraction (full authority at
//     speedMin, −TURN_LOSS_AT_MAX at speedMax)
//   - velocity chases heading*speed: speed integrates thrust−drag, direction
//     aligns to facing with grip ALIGN — this is what gives wide banking arcs
//   - throttle −0.3..1 (reverse is a weak airbrake), boost multiplies ceiling
//   - soft world bounds repel inside BOUND margin
// ============================================================================

import {
  BOOST_DRAIN,
  BOOST_MAX,
  BOOST_MULT,
  BOOST_REGEN,
  BULLET_HIT_R,
  BULLET_TTL_S,
  CLASSES,
  HEAT_COOL_FIRING,
  HEAT_COOL_IDLE,
  HEAT_MAX,
  HEAT_RESUME,
  SMOKE_BELOW,
  TURN_LOSS_AT_MAX,
  WORLD,
} from './config.js';
import type { InputFrame } from './types.js';
import type { BulletState, PlaneState } from './types.js';

export const TAU = Math.PI * 2;

/** Wrap angle into [0, 2π). */
export function wrapAngle(a: number): number {
  a %= TAU;
  return a < 0 ? a + TAU : a;
}

/** Signed smallest delta b−a in (−π, π]. */
export function angleDelta(a: number, b: number): number {
  let d = wrapAngle(b) - wrapAngle(a);
  if (d > Math.PI) d -= TAU;
  if (d <= -Math.PI) d += TAU;
  return d;
}

/** Velocity-alignment grip per second (rad/s of velocity chasing heading). */
const ALIGN = 6.0;

/**
 * Advance one plane by dt seconds under an input frame. Mutates p.
 * dt must be ≤ 1/20 for stability; the callers run fixed steps.
 */
export function stepPlane(p: PlaneState, input: InputFrame, dt: number): void {
  const spec = CLASSES[p.cls];

  // --- respawn / death gates -------------------------------------------------
  if (p.dead) {
    p.respawnT = Math.max(0, p.respawnT - dt);
    return;
  }
  if (p.invulnT > 0) p.invulnT = Math.max(0, p.invulnT - dt);

  // --- boost fuel --------------------------------------------------------------
  p.boosting = input.boost && p.boost > 0;
  if (p.boosting) {
    p.boost = Math.max(0, p.boost - BOOST_DRAIN * dt);
  } else {
    p.boost = Math.min(BOOST_MAX, p.boost + BOOST_REGEN * dt);
  }
  const mult = p.boosting ? BOOST_MULT : 1;

  // --- turning ------------------------------------------------------------------
  const speed = Math.hypot(p.vx, p.vy);
  const frac = clamp((speed - spec.speedMin) / Math.max(1, spec.speedMax - spec.speedMin), 0, 1);
  const turnAuthority = 1 - TURN_LOSS_AT_MAX * frac;
  p.h = wrapAngle(p.h + input.tr * spec.turnRate * turnAuthority * dt);

  // --- thrust & drag along facing -------------------------------------------------
  const throttle = clamp(input.th, -0.3, 1);
  p.throttle = throttle;
  const maxSpeed = spec.speedMax * mult;
  const minSpeed = spec.speedMin;
  const targetSpeed = minSpeed + (maxSpeed - minSpeed) * Math.max(0, throttle);
  let newSpeed = speed;
  if (throttle >= 0) {
    // accelerate toward target along facing
    newSpeed = moveToward(speed, targetSpeed, spec.accel * mult * dt);
  } else {
    // airbrake toward min speed
    newSpeed = moveToward(speed, minSpeed, spec.accel * 0.9 * dt);
  }

  // velocity: rotate current velocity vector toward facing (grip), then set magnitude
  const velAngle = Math.atan2(p.vy, p.vx);
  const aligned = wrapAngle(velAngle + angleDelta(velAngle, p.h) * Math.min(1, ALIGN * dt));
  p.vx = Math.cos(aligned) * newSpeed;
  p.vy = Math.sin(aligned) * newSpeed;

  // --- integrate --------------------------------------------------------------------
  p.x += p.vx * dt;
  p.y += p.vy * dt;

  // --- soft bounds -------------------------------------------------------------------
  const m = WORLD.BOUND;
  if (p.x < m) p.vx += (m - p.x) * 8 * dt;
  if (p.x > WORLD.W - m) p.vx -= (p.x - (WORLD.W - m)) * 8 * dt;
  if (p.y < m) p.vy += (m - p.y) * 8 * dt;
  if (p.y > WORLD.H - m) p.vy -= (p.y - (WORLD.H - m)) * 8 * dt;
  // Hard clamp backstop: a plane pinned against the soft bound for thousands
  // of ticks (debug fast-forward, AFK at the rim) can accumulate unbounded
  // repel velocity and numerically blow up. Real play never sees this.
  p.x = clamp(p.x, -m, WORLD.W + m);
  p.y = clamp(p.y, -m, WORLD.H + m);

  // --- heat ----------------------------------------------------------------------------
  if (p.jammed) {
    p.heat -= HEAT_COOL_IDLE * dt;
    if (p.heat <= HEAT_RESUME) {
      p.heat = Math.max(0, p.heat);
      p.jammed = false;
    }
  } else if (!input.fire) {
    p.heat = Math.max(0, p.heat - HEAT_COOL_IDLE * dt);
  } else {
    p.heat = Math.max(0, p.heat - HEAT_COOL_FIRING * dt);
  }

  // --- trigger cooldown -----------------------------------------------------------------
  if (p.fireCd > 0) p.fireCd = Math.max(0, p.fireCd - dt);
}

/** Fire one volley from p if allowed. Returns spawned bullets (may be empty). */
export function fireVolley(p: PlaneState, nextBulletId: () => number): BulletState[] {
  const spec = CLASSES[p.cls];
  if (p.dead || p.jammed || p.fireCd > 0) return [];
  if (p.invulnT > 0) return []; // spawn protection forbids shooting
  p.fireCd = 1 / spec.gun.rateHz;
  p.heat += spec.gun.heatPerShot * spec.gun.count;
  if (p.heat >= HEAT_MAX) {
    p.heat = HEAT_MAX;
    p.jammed = true;
  }
  const out: BulletState[] = [];
  const cos = Math.cos(p.h);
  const sin = Math.sin(p.h);
  const muzzles = spec.gun.muzzleX;
  for (let i = 0; i < spec.gun.count; i++) {
    const lat = muzzles[i % muzzles.length] ?? 0;
    out.push({
      id: nextBulletId(),
      team: p.team,
      owner: p.id,
      x: p.x + cos * 18 - sin * lat,
      y: p.y + sin * 18 + cos * lat,
      vx: p.vx + cos * spec.gun.bulletSpeed,
      vy: p.vy + sin * spec.gun.bulletSpeed,
      t: BULLET_TTL_S,
    });
  }
  return out;
}

/** Advance bullets; returns survivors. */
export function stepBullets(bullets: BulletState[], dt: number): void {
  for (let i = bullets.length - 1; i >= 0; i--) {
    const b = bullets[i]!;
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    b.t -= dt;
    if (b.t <= 0) bullets.splice(i, 1);
  }
}

/**
 * Swept bullet-vs-plane test. The bullet moved from (bx0,by0) to (b.x,b.y)
 * this tick; at closing speeds up to ~1,300 u/s a static point check tunnels
 * clean through a nose-on target (the head-on pass IS the game's signature
 * moment), so we test the SEGMENT against the hit circle instead.
 * Friendly fire is off; dead planes are not hittable.
 */
export function bulletHits(b: BulletState, bx0: number, by0: number, p: PlaneState): boolean {
  if (p.dead || p.team === b.team) return false;
  const r = CLASSES[p.cls].radius + BULLET_HIT_R;
  const dx = b.x - bx0;
  const dy = b.y - by0;
  const fx = bx0 - p.x;
  const fy = by0 - p.y;
  const a = dx * dx + dy * dy;
  // Degenerate segment (zero-length) → plain point-in-circle.
  if (a < 1e-9) return fx * fx + fy * fy <= r * r;
  const t = clamp(-(fx * dx + fy * dy) / a, 0, 1);
  const cx = fx + dx * t;
  const cy = fy + dy * t;
  return cx * cx + cy * cy <= r * r;
}

/**
 * Where to aim to lead a target: returns predicted intercept point for a
 * projectile of the given speed fired from (x0,y0). Used by bots AND by the
 * client's gun-crosshair readout.
 */
export function aimLead(
  x0: number,
  y0: number,
  tx: number,
  ty: number,
  tvx: number,
  tvy: number,
  projSpeed: number,
): { x: number; y: number } {
  const dx = tx - x0;
  const dy = ty - y0;
  const dist = Math.hypot(dx, dy) || 1;
  const tClose = dist / projSpeed;
  return { x: tx + tvx * tClose, y: ty + tvy * tClose };
}

/** True when this plane should be rendering its heavy smoke trail. */
export function isSmoking(p: PlaneState): boolean {
  return !p.dead && p.hp / CLASSES[p.cls].hp < SMOKE_BELOW;
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function moveToward(v: number, target: number, maxDelta: number): number {
  if (v < target) return Math.min(target, v + maxDelta);
  return Math.max(target, v - maxDelta);
}
