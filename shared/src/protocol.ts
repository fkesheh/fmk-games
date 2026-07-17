// ============================================================================
// FROZEN CONTRACT — wire validation. Server MUST run every incoming message
// through parseC2S and silently drop nulls (never throw on malformed input).
// ============================================================================
import type { C2S, MapId, S2C, WeaponId } from './types.js';

const MAP_IDS: readonly MapId[] = ['dustbowl', 'crossfire', 'office', 'frostbite', 'urbana', 'bunker'];
const WEAPON_IDS: readonly WeaponId[] = ['knife', 'pistol', 'smg', 'shotgun', 'rifle', 'sniper'];

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}
function num(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}
function str(v: unknown, maxLen: number): v is string {
  return typeof v === 'string' && v.length >= 1 && v.length <= maxLen;
}
function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** Parse + sanitize a raw decoded JSON value into a C2S message, or null. */
export function parseC2S(raw: unknown): C2S | null {
  if (!isObj(raw) || typeof raw.t !== 'string') return null;
  switch (raw.t) {
    case 'list_rooms':
      return { t: 'list_rooms' };
    case 'quick_join':
      if (!str(raw.name, 16)) return null;
      return { t: 'quick_join', name: raw.name.trim().slice(0, 16) || 'Player' };
    case 'create_private':
      if (!str(raw.name, 16) || !MAP_IDS.includes(raw.mapId as MapId)) return null;
      return { t: 'create_private', name: raw.name.trim().slice(0, 16) || 'Player', mapId: raw.mapId as MapId };
    case 'join_private':
      if (!str(raw.name, 16) || !str(raw.code, 8)) return null;
      return { t: 'join_private', name: raw.name.trim().slice(0, 16) || 'Player', code: raw.code.toUpperCase() };
    case 'leave':
      return { t: 'leave' };
    case 'input': {
      if (!num(raw.seq) || !num(raw.moveX) || !num(raw.moveZ) || !num(raw.yaw) || !num(raw.pitch) || !num(raw.buttons)) return null;
      return {
        t: 'input',
        seq: Math.floor(raw.seq),
        moveX: clamp(raw.moveX, -1, 1),
        moveZ: clamp(raw.moveZ, -1, 1),
        yaw: raw.yaw,
        pitch: clamp(raw.pitch, -1.45, 1.45),
        buttons: raw.buttons & 0xf,
      };
    }
    case 'reload':
      return { t: 'reload' };
    case 'switch':
      if (!WEAPON_IDS.includes(raw.weapon as WeaponId)) return null;
      return { t: 'switch', weapon: raw.weapon as WeaponId };
    case 'buy':
      if (!WEAPON_IDS.includes(raw.weapon as WeaponId)) return null;
      return { t: 'buy', weapon: raw.weapon as WeaponId };
    case 'ping':
      if (!num(raw.ts)) return null;
      return { t: 'ping', ts: raw.ts };
    default:
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
