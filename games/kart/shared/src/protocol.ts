// ============================================================================
// FROZEN CONTRACT — KART GP: room-level wire validation.
// ============================================================================
import type { KartC2S } from './types.js';

function num(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}
function vec3(v: unknown): v is [number, number, number] {
  return Array.isArray(v) && v.length === 3 && num(v[0]) && num(v[1]) && num(v[2]);
}
function vec2(v: unknown): v is [number, number] {
  return Array.isArray(v) && v.length === 2 && num(v[0]) && num(v[1]);
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
  if (r.t !== 'kart_state') return null;
  if (!num(r.seq) || !vec3(r.p) || !num(r.yaw) || !vec2(r.v) || !num(r.steer)) return null;
  for (const n of [r.p[0], r.p[1], r.p[2], r.v[0], r.v[1]]) {
    if (Math.abs(n) > 1000) return null; // sanity: teleport/NaN guard
  }
  return {
    t: 'kart_state',
    seq: Math.floor(r.seq),
    p: [clamp(r.p[0], -400, 400), clamp(r.p[1], -50, 50), clamp(r.p[2], -400, 400)],
    yaw: r.yaw,
    v: [clamp(r.v[0], -60, 60), clamp(r.v[1], -60, 60)],
    steer: clamp(r.steer, -1, 1),
    drift: r.drift === true,
  };
}
