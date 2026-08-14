// ============================================================================
// FROZEN CONTRACT — wire validation. Server MUST run every incoming message
// through parseC2S and silently drop nulls (never throw on malformed input).
// Mirrors games/fps/shared/src/protocol.ts's sanitisation discipline.
// ============================================================================
import { WEAPON_ORDER } from '@fps/shared';
import type { WeaponId } from '@fps/shared';
import { FENCE } from './config.js';
import { INPUT_MASK } from './types.js';
import type { C2S, DebugMsg, S2C } from './types.js';

/** Debug teleport/spawn coordinates are clamped to this half-extent. */
const WORLD_BOUND = 200;

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}
function num(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}
function isWeapon(v: unknown): v is WeaponId {
  return typeof v === 'string' && (WEAPON_ORDER as readonly string[]).includes(v);
}
function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** Parse + sanitise a raw decoded value into a C2S message, or null. MUST NEVER THROW. */
export function parseC2S(raw: unknown): C2S | null {
  try {
    if (!isObj(raw) || typeof raw.t !== 'string') return null;
    switch (raw.t) {
      case 'input': {
        if (
          !num(raw.seq) ||
          !num(raw.moveX) ||
          !num(raw.moveZ) ||
          !num(raw.yaw) ||
          !num(raw.pitch) ||
          !num(raw.buttons)
        ) {
          return null;
        }
        return {
          t: 'input',
          seq: Math.floor(raw.seq),
          moveX: clamp(raw.moveX, -1, 1),
          moveZ: clamp(raw.moveZ, -1, 1),
          yaw: raw.yaw,
          pitch: clamp(raw.pitch, -1.45, 1.45),
          buttons: raw.buttons & INPUT_MASK,
        };
      }
      case 'reload':
        return { t: 'reload' };
      case 'switch':
        if (!isWeapon(raw.weapon)) return null;
        return { t: 'switch', weapon: raw.weapon };
      case 'buy_weapon':
        if (!isWeapon(raw.weapon)) return null;
        return { t: 'buy_weapon', weapon: raw.weapon };
      case 'buy_ammo':
        return { t: 'buy_ammo' };
      case 'start':
        // `seed` MUST survive: without it wave composition and spawn angles are
        // server-random, so a capture round cannot be compared before/after an
        // art fix and a failed horde gate cannot be reproduced to debug. It was
        // declared in C2S and silently dropped here — typechecked perfectly.
        if (raw.seed !== undefined) {
          if (!num(raw.seed)) return null;
          return { t: 'start', seed: Math.floor(raw.seed) };
        }
        return { t: 'start' };
      case 'ping':
        if (!num(raw.ts)) return null;
        return { t: 'ping', ts: raw.ts };
      case 'debug': {
        const op = raw.op;
        if (
          op !== 'hurt' &&
          op !== 'teleport' &&
          op !== 'breach' &&
          op !== 'spawn' &&
          op !== 'end' &&
          op !== 'invuln'
        ) {
          return null;
        }
        const msg: DebugMsg = { t: 'debug', op };
        if (raw.a !== undefined) {
          if (!num(raw.a)) return null;
          // breach: SegmentId — a non-negative integer index.
          // invuln: a strict 0|1 flag.
          // hurt/teleport/spawn: pass the finite value through unchanged.
          if (op === 'breach') msg.a = clamp(Math.floor(raw.a), 0, FENCE.segments - 1);
          else if (op === 'invuln') msg.a = Math.round(clamp(raw.a, 0, 1));
          else if (op === 'hurt') msg.a = clamp(raw.a, 0, 10000);
          else msg.a = clamp(raw.a, -WORLD_BOUND, WORLD_BOUND);
        }
        if (raw.b !== undefined) {
          if (!num(raw.b)) return null;
          msg.b = clamp(raw.b, -WORLD_BOUND, WORLD_BOUND);
        }
        if (raw.c !== undefined) {
          if (!num(raw.c)) return null;
          msg.c = clamp(raw.c, -WORLD_BOUND, WORLD_BOUND);
        }
        if (raw.kind !== undefined) {
          const kind = raw.kind;
          if (kind !== 'shambler' && kind !== 'runner' && kind !== 'brute' && kind !== 'spitter') {
            return null;
          }
          msg.kind = kind;
        }
        return msg;
      }
      default:
        return null;
    }
  } catch {
    // A hostile getter on `raw` (or a property access that throws) must never
    // propagate — the server routes every inbound socket message through
    // this function and relies on null, not an exception, for "drop it".
    return null;
  }
}

export function encodeC2S(m: C2S): string {
  return JSON.stringify(m);
}
export function encodeS2C(m: S2C): string {
  return JSON.stringify(m);
}
export function decodeS2C(json: string): S2C | null {
  try {
    const v: unknown = JSON.parse(json);
    if (!isObj(v) || typeof v.t !== 'string') return null;
    return v as S2C; // server is trusted; only shape-smoke-check
  } catch {
    return null;
  }
}
