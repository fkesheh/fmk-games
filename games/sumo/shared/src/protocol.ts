// ============================================================================
// FROZEN CONTRACT — SUMO: room-level wire validation (kart/shared/protocol.ts
// shape). parseSumoC2S never throws: valid input => parsed message, anything
// else => null and the room silently drops it. The platform lobby already
// parsed `pad_input` before the room ever sees it; the room re-checks the
// fields defensively anyway (never trust the wire).
// ============================================================================
import { BIT_DASH, BIT_JUMP } from './types.js';
import type { SumoC2S } from './types.js';

function num(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function clamp11(v: number): number {
  return Math.max(-1, Math.min(1, v));
}

/** Parse + sanitize a raw decoded JSON value into a SumoC2S message, or null. */
export function parseSumoC2S(raw: unknown): SumoC2S | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (r.t === 'debug_bot') return { t: 'debug_bot' };
  if (r.t !== 'input') return null;
  if (!num(r.seq) || !num(r.mx) || !num(r.mz) || !num(r.bits)) return null;
  const seq = r.seq;
  if (seq < 0 || seq > 0xffffffff) return null;
  return {
    t: 'input',
    seq: Math.trunc(seq),
    mx: clamp11(r.mx),
    mz: clamp11(r.mz),
    bits: Math.max(0, Math.min(0xffffffff, Math.trunc(r.bits))) >>> 0,
  };
}

/**
 * Defensively validate an already-lobby-parsed pad frame into a player intent
 * frame. The lobby guarantees finite axes in [-1,1] and a uint32 buttons mask;
 * this exists so the room can treat every wire source through one funnel.
 */
export function padFrameToInput(
  msg: { readonly lx: number; readonly ly: number; readonly rx: number; readonly ry: number; readonly buttons: number; readonly seq?: unknown },
): { mx: number; mz: number; bits: number; seq: number } | null {
  if (!num(msg.lx) || !num(msg.ly) || !num(msg.buttons)) return null;
  // Left stick drives movement (up = forward); right stick is unused by sumo.
  return {
    mx: clamp11(num(msg.lx) ? msg.lx : 0),
    mz: clamp11(-msg.ly),
    bits: Math.max(0, Math.min(0xffffffff, Math.trunc(msg.buttons))) >>> 0,
    seq: num(msg.seq) && (msg.seq as number) >= 0 ? Math.trunc(msg.seq as number) : -1,
  };
}

/** True while `bits` holds a pressable action bit (dash/jump are the only two). */
export function hasActionBits(bits: number): boolean {
  return (bits & ~(BIT_DASH | BIT_JUMP)) === 0;
}
