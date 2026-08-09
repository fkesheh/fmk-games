// ============================================================================
// SKI SPLAT — PROTOCOL. Total, clamping, never throws; invalid => null and
// the message is silently dropped (CONTRACT §2.8/§5).
// ============================================================================

import { SIM_DT_MAX, SIM_DT_MIN } from './config.js';
import type { SplatC2S } from './types.js';

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Parse a raw client message. null = silently dropped. */
export function parseSplatC2S(raw: unknown): SplatC2S | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const m = raw as Record<string, unknown>;
  switch (m.t) {
    case 'splat_input': {
      const seq = num(m.seq);
      const steer = num(m.steer);
      const dt = num(m.dt);
      if (seq === null || steer === null || dt === null) return null;
      if (!Number.isInteger(seq) || seq < 0) return null;
      return {
        t: 'splat_input',
        seq,
        steer: clamp(steer, -1, 1),
        dt: clamp(dt, SIM_DT_MIN, SIM_DT_MAX),
      };
    }
    case 'splat_assist':
      return typeof m.on === 'boolean' ? { t: 'splat_assist', on: m.on } : null;
    case 'start':
      return { t: 'start' };
    default:
      return null;
  }
}

/** Server -> client messages are built by the room from trusted state; JSON
 *  encoding is the platform's job (RoomIO.send). No S2C parser is needed in
 *  v1 — the client validates shape defensively where it consumes. */
