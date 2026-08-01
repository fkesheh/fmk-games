// ============================================================================
// FROZEN CONTRACT — KART GP: room-level wire validation.
//
// The C2S surface carries INTENT ONLY. `kart_state` (absolute world position,
// yaw and velocity, copied straight into the room) is GONE: no message a
// client can send names a coordinate, so the entire class of "report yourself
// 800m down the road" cheats has nothing to attach to. What remains is a
// bounded control input the server integrates itself.
// ============================================================================
import { SIM_DT, SIM_DT_MAX, SIM_DT_MIN } from './config.js';
import type { KartC2S } from './types.js';

function num(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}
function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** Parse + sanitize a raw decoded JSON value into a KartC2S message, or null. */
export function parseKartC2S(raw: unknown): KartC2S | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (r.t === 'nitro') return { t: 'nitro' };
  // explicit lobby start; the ROOM validates phase + player count (never throws)
  if (r.t === 'start') return { t: 'start' };
  if (r.t !== 'kart_input') return null;
  if (!num(r.seq) || !num(r.throttle) || !num(r.brake) || !num(r.steer)) return null;
  return {
    t: 'kart_input',
    seq: Math.floor(r.seq),
    throttle: clamp(r.throttle, 0, 1),
    brake: clamp(r.brake, 0, 1),
    steer: clamp(r.steer, -1, 1),
    drift: r.drift === true,
    respawn: r.respawn === true,
    // an absent/garbage dt means "one nominal tick"; anything else is clamped
    // into the accepted band (the room additionally caps simulated time per
    // real second, so a flood of max-dt inputs still cannot outrun the clock)
    dt: clamp(num(r.dt) ? r.dt : SIM_DT, SIM_DT_MIN, SIM_DT_MAX),
  };
}
