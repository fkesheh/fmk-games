// ============================================================================
// FROZEN CONTRACT — KART GP: the kart dynamics model. Client-owned simulation
// (server never steps karts); deterministic per (state, input, dt, surface).
// No I/O, no Date, no randomness. Units: meters, seconds, radians.
// yaw convention matches the platform: forward = (-sin(yaw), -cos(yaw)).
// ============================================================================
import {
  BRAKE, DOWNSHIFT_HYST, DRAG, DRIFT_DECEL, DRIFT_MIN_SPEED, DRIFT_STEER_MUL,
  ENGINE, GEARS, GRASS_DRAG, GRASS_ENGINE_MUL, GRIP_DRIFT, GRIP_GRASS, GRIP_ROAD,
  LAT_G, LAT_G_GRASS, MAX_LOCK, MIN_LOCK, NITRO_BOOST, REVERSE_TOP, ROLL,
  SHIFT_TIME, TOP_SPEED, WHEELBASE,
} from './config.js';

export type Surface = 'road' | 'grass';

export interface KartInput {
  throttle: number; // 0..1
  brake: number; // 0..1 (also reverses from standstill)
  steer: number; // -1..1 (positive = RIGHT: kart turns clockwise seen from above)
  drift: boolean; // handbrake held
}

export interface KartState {
  x: number; y: number; z: number;
  yaw: number;
  vx: number; vz: number; // world velocity
  gear: number; // 1-based index into GEARS (reverse always uses gear 1)
  shiftLeft: number; // remaining upshift engine-cut seconds
  drifting: boolean;
  nitroLeft: number; // remaining nitro boost seconds (client-applied after server ok)
}

export function makeKart(x: number, z: number, yaw: number): KartState {
  return { x, y: 0, z, yaw, vx: 0, vz: 0, gear: 1, shiftLeft: 0, drifting: false, nitroLeft: 0 };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Advance the kart one step.
 * Longitudinal: per-gear engine curve (automatic gearbox, engine cut during
 * upshifts), brake/reverse, drag. Steering: bicycle model (yaw rate =
 * v/L · tan δ) with speed-sensitive lock, capped by the surface's max lateral
 * acceleration (understeer at speed); positive steer turns RIGHT (yaw
 * decreases, platform convention). Lateral velocity killed by surface grip;
 * handbrake drift collapses grip AND bypasses the understeer cap (sliding),
 * charging a mini-turbo on release.
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

  // ---- drift state (rotation tool only — no boost attached) ----
  if (inp.drift && !s.drifting && Math.abs(speedF) > DRIFT_MIN_SPEED) {
    s.drifting = true;
  } else if (s.drifting && (!inp.drift || Math.abs(speedF) <= 2)) {
    s.drifting = false;
  }

  // ---- longitudinal: automatic gearbox ----
  if (s.shiftLeft > 0) {
    s.shiftLeft = Math.max(0, s.shiftLeft - dt); // engine cut during the shift
  }
  const gear = GEARS[clamp(s.gear, 1, GEARS.length) - 1]!;
  const engineMul = surface === 'grass' ? GRASS_ENGINE_MUL : 1;
  if (s.nitroLeft > 0) {
    s.nitroLeft = Math.max(0, s.nitroLeft - dt);
    speedF += NITRO_BOOST * engineMul * dt;
  }
  if (s.shiftLeft === 0 && throttle > 0 && speedF >= 0 && speedF < gear.top) {
    // flat engine force per gear; REV LIMITER: no engine force at/above the gear top
    // (drag pulls back under it, so speed settles at the top without taper math
    // that provably could never reach the shift point).
    speedF += ENGINE * gear.accel * engineMul * throttle * dt;
  }
  // upshift at the gear top; downshift only well below it (never below gear 1) —
  // the hysteresis exceeds the speed a shift cut costs, so the box never oscillates
  if (s.shiftLeft === 0 && s.gear < GEARS.length && speedF >= gear.top) {
    s.gear += 1;
    s.shiftLeft = SHIFT_TIME;
  } else if (s.gear > 1 && speedF < GEARS[s.gear - 2]!.top - DOWNSHIFT_HYST) {
    s.gear -= 1;
  }
  if (brake > 0) {
    if (speedF > 0.5) speedF -= BRAKE * brake * dt;
    else speedF = Math.max(-REVERSE_TOP, speedF - ENGINE * 0.6 * brake * dt); // reverse
  }
  // drag + rolling resistance (+ off-road drag) + handbrake deceleration
  const drag = DRAG + (surface === 'grass' ? GRASS_DRAG : 0);
  speedF -= drag * speedF * dt;
  if (s.drifting) {
    // handbrake: real deceleration (locks the rear axle) — drifts scrub speed,
    // they are not a free rotation button
    const d = DRIFT_DECEL * dt;
    speedF = Math.abs(speedF) <= d ? 0 : speedF - Math.sign(speedF) * d;
  }
  if (Math.abs(speedF) > 0.01) speedF -= Math.sign(speedF) * ROLL * dt;
  if (Math.abs(speedF) < 0.05 && throttle === 0 && brake === 0) speedF = 0;
  speedF = clamp(speedF, -REVERSE_TOP, TOP_SPEED * 1.15);

  // ---- steering (bicycle model) + understeer cap ----
  // positive steer = RIGHT: yaw decreases (platform convention).
  const lock = lerp(MAX_LOCK, MIN_LOCK, clamp(Math.abs(speedF) / TOP_SPEED, 0, 1));
  const steerAngle = steer * lock * (s.drifting ? DRIFT_STEER_MUL : 1);
  if (Math.abs(speedF) > 0.05) {
    let yawRate = -(speedF / WHEELBASE) * Math.tan(steerAngle);
    if (!s.drifting) {
      // grip-limited turn: lateral accel may not exceed μ (drift bypasses = sliding)
      const latG = surface === 'grass' ? LAT_G_GRASS : LAT_G;
      const cap = latG / Math.max(2, Math.abs(speedF));
      yawRate = clamp(yawRate, -cap, cap);
    }
    s.yaw += yawRate * dt;
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

/** Engine revs 0..1 within the current gear band (drives the engine audio). */
export function engineRevs(s: KartState): number {
  const top = GEARS[clamp(s.gear, 1, GEARS.length) - 1]!.top;
  const prev = s.gear > 1 ? GEARS[s.gear - 2]!.top : 0;
  const sp = clamp(Math.abs(forwardSpeed(s)), prev, top);
  return top === prev ? 1 : (sp - prev) / (top - prev);
}
