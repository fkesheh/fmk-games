// ============================================================================
// FROZEN CONTRACT — KART GP: the kart dynamics model. Client-owned simulation
// (server never steps karts); deterministic per (state, input, dt, surface).
// No I/O, no Date, no randomness. Units: meters, seconds, radians.
// yaw convention matches the platform: forward = (-sin(yaw), -cos(yaw)).
// ============================================================================
import {
  BRAKE, DRAG, DRIFT_MIN_SPEED, DRIFT_STEER_MUL, ENGINE, GRASS_DRAG, GRASS_ENGINE_MUL,
  GRIP_DRIFT, GRIP_GRASS, GRIP_ROAD, MAX_LOCK, MIN_LOCK, REVERSE_TOP, ROLL, TOP_SPEED,
  TURBO_BOOST, TURBO_MIN_S, TURBO_S, WHEELBASE,
} from './config.js';

export type Surface = 'road' | 'grass';

export interface KartInput {
  throttle: number; // 0..1
  brake: number; // 0..1 (also reverses from standstill)
  steer: number; // -1..1 (positive = right)
  drift: boolean; // handbrake held
}

export interface KartState {
  x: number; y: number; z: number;
  yaw: number;
  vx: number; vz: number; // world velocity
  drifting: boolean;
  driftTime: number; // consecutive seconds in drift (for turbo charge)
  turboLeft: number; // remaining mini-turbo seconds
}

export function makeKart(x: number, z: number, yaw: number): KartState {
  return { x, y: 0, z, yaw, vx: 0, vz: 0, drifting: false, driftTime: 0, turboLeft: 0 };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Advance the kart one step. Model: engine curve + brake/reverse + drag on the
 * forward axis; bicycle steering (yaw rate = v/L · tan δ) with speed-sensitive
 * lock; lateral velocity killed by surface grip (drift collapses it); handbrake
 * drift with mini-turbo on release.
 */
export function stepKart(s: KartState, inp: KartInput, dt: number, surface: Surface): KartState {
  const fx = -Math.sin(s.yaw);
  const fz = -Math.cos(s.yaw);
  const rx = Math.cos(s.yaw);
  const rz = -Math.sin(s.yaw);
  let speedF = s.vx * fx + s.vz * fz; // forward speed (signed)
  let speedL = s.vx * rx + s.vz * rz; // lateral speed

  const throttle = clamp(inp.throttle, 0, 1);
  const brake = clamp(inp.brake, 0, 1);
  const steer = clamp(inp.steer, -1, 1);

  // ---- drift state ----
  if (inp.drift && !s.drifting && Math.abs(speedF) > DRIFT_MIN_SPEED) {
    s.drifting = true;
    s.driftTime = 0;
  }
  if (s.drifting) {
    if (inp.drift && Math.abs(speedF) > 2) {
      s.driftTime += dt;
    } else {
      // release: charge a mini-turbo if the drift was long enough
      if (s.driftTime >= TURBO_MIN_S) s.turboLeft = TURBO_S;
      s.drifting = false;
      s.driftTime = 0;
    }
  }

  // ---- longitudinal ----
  let engineMul = surface === 'grass' ? GRASS_ENGINE_MUL : 1;
  if (s.turboLeft > 0) {
    s.turboLeft = Math.max(0, s.turboLeft - dt);
    speedF += TURBO_BOOST * engineMul * dt;
  }
  if (throttle > 0 && speedF < TOP_SPEED) {
    speedF += ENGINE * engineMul * throttle * Math.max(0, 1 - speedF / TOP_SPEED) * dt;
  }
  if (brake > 0) {
    if (speedF > 0.5) speedF -= BRAKE * brake * dt;
    else speedF = Math.max(-REVERSE_TOP, speedF - ENGINE * 0.6 * brake * dt); // reverse
  }
  // drag + rolling resistance (+ off-road drag)
  const drag = DRAG + (surface === 'grass' ? GRASS_DRAG : 0);
  speedF -= drag * speedF * dt;
  if (Math.abs(speedF) > 0.01) speedF -= Math.sign(speedF) * ROLL * dt;
  if (Math.abs(speedF) < 0.05 && throttle === 0 && brake === 0) speedF = 0;
  speedF = clamp(speedF, -REVERSE_TOP, TOP_SPEED * 1.15);

  // ---- steering (bicycle model) ----
  const lock = lerp(MAX_LOCK, MIN_LOCK, clamp(Math.abs(speedF) / TOP_SPEED, 0, 1));
  const steerAngle = steer * lock * (s.drifting ? DRIFT_STEER_MUL : 1);
  if (Math.abs(speedF) > 0.05) {
    s.yaw += (speedF / WHEELBASE) * Math.tan(steerAngle) * dt;
  }

  // ---- lateral grip ----
  const grip = s.drifting ? GRIP_DRIFT : surface === 'grass' ? GRIP_GRASS : GRIP_ROAD;
  speedL -= speedL * Math.min(1, grip * dt);

  // ---- recompose + integrate ----
  const nfx = -Math.sin(s.yaw);
  const nfz = -Math.cos(s.yaw);
  const nrx = Math.cos(s.yaw);
  const nrz = -Math.sin(s.yaw);
  s.vx = nfx * speedF + nrx * speedL;
  s.vz = nfz * speedF + nrz * speedL;
  s.x += s.vx * dt;
  s.z += s.vz * dt;
  return s;
}

/** Current forward speed in m/s (signed). */
export function forwardSpeed(s: KartState): number {
  return s.vx * -Math.sin(s.yaw) + s.vz * -Math.cos(s.yaw);
}
