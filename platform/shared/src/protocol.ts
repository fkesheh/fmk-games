// ============================================================================
// PLATFORM PROTOCOL — lobby-level wire validation, game-agnostic. The lobby
// parses + sanitizes the seven lobby messages; EVERYTHING else is only
// envelope-checked ({t: string} object) and passed through RAW — the room's
// game validates it with its own parser and silently drops invalid messages.
// Invalid lobby input => null; never throw on wire data.
// ============================================================================
import type { PlayerId, RoomInfo } from './module.js';

/** Transport liveness: ws protocol-level ping cadence, used by net.ts. */
export const NET = {
  pingEveryMs: 2000,
} as const;

// ---- client -> server: lobby-level (parsed + handled by the platform) ----
// `game` is a GameModule.id; absent => the first registered module.
// `settings` is opaque to the platform; the module validates it in createRoom.
export type LobbyC2S =
  | { t: 'list_rooms' }
  | { t: 'quick_join'; name: string; game?: string; resume?: PlayerId }
  | { t: 'create_public'; name: string; game?: string; settings?: Record<string, unknown>; resume?: PlayerId }
  | { t: 'create_private'; name: string; game?: string; settings?: Record<string, unknown>; resume?: PlayerId }
  | { t: 'join_private'; name: string; code: string; resume?: PlayerId }
  | { t: 'leave' }
  | { t: 'ping'; ts: number };

/** Sanitize a resume token (a previous session's playerId), or undefined. */
export function cleanResume(v: unknown): PlayerId | undefined | null {
  if (v === undefined) return undefined;
  return typeof v === 'string' && v.length >= 4 && v.length <= 24 ? v : null;
}

/** Room-level pass-through: envelope-checked ({t: string}) but NOT validated. */
export type RawEnvelope = { t: string } & Record<string, unknown>;

/** Everything that can reach NetHooks.onMessage. */
export type C2S = LobbyC2S | RawEnvelope;

// ---- server -> client ----
export type LobbyS2C =
  | { t: 'welcome'; playerId: PlayerId }
  | { t: 'room_list'; rooms: RoomInfo[] }
  | { t: 'pong'; ts: number; serverTime: number }
  | { t: 'error'; code: string; message: string };

/** Lobby messages plus whatever a game room pushes through RoomIO.send. */
export type S2C = LobbyS2C | RawEnvelope;

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}
function num(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}
function str(v: unknown, maxLen: number): v is string {
  return typeof v === 'string' && v.length >= 1 && v.length <= maxLen;
}

/** Trimmed, length-capped display name; 'Player' when whitespace-only. */
function cleanName(v: unknown): string | null {
  if (!str(v, 16)) return null;
  return v.trim().slice(0, 16) || 'Player';
}

/** Optional game id, trimmed + capped. undefined = absent; null = invalid. */
function cleanGame(v: unknown): string | null | undefined {
  if (v === undefined) return undefined;
  if (!str(v, 32)) return null;
  return v.trim().slice(0, 32);
}

/** Opaque settings: a plain (non-array) object when present. undefined = absent; null = invalid. */
function cleanSettings(v: unknown): Record<string, unknown> | null | undefined {
  if (v === undefined) return undefined;
  if (!isObj(v) || Array.isArray(v)) return null;
  return v;
}

/** Parse + sanitize a raw decoded JSON value, or null. Unknown tags pass through RAW. */
export function parseC2S(raw: unknown): C2S | null {
  if (!isObj(raw) || typeof raw.t !== 'string') return null;
  switch (raw.t) {
    case 'list_rooms':
      return { t: 'list_rooms' };
    case 'quick_join': {
      const name = cleanName(raw.name);
      const game = cleanGame(raw.game);
      const resume = cleanResume(raw.resume);
      if (name === null || game === null || resume === null) return null;
      const msg: { t: 'quick_join'; name: string; game?: string; resume?: PlayerId } = { t: 'quick_join', name };
      if (game !== undefined) msg.game = game;
      if (resume !== undefined) msg.resume = resume;
      return msg;
    }
    case 'create_public': {
      const name = cleanName(raw.name);
      const game = cleanGame(raw.game);
      const settings = cleanSettings(raw.settings);
      const resume = cleanResume(raw.resume);
      if (name === null || game === null || settings === null || resume === null) return null;
      const msg: { t: 'create_public'; name: string; game?: string; settings?: Record<string, unknown>; resume?: PlayerId } = {
        t: 'create_public',
        name,
      };
      if (game !== undefined) msg.game = game;
      if (settings !== undefined) msg.settings = settings;
      if (resume !== undefined) msg.resume = resume;
      return msg;
    }
    case 'create_private': {
      const name = cleanName(raw.name);
      const game = cleanGame(raw.game);
      const settings = cleanSettings(raw.settings);
      const resume = cleanResume(raw.resume);
      if (name === null || game === null || settings === null || resume === null) return null;
      const msg: { t: 'create_private'; name: string; game?: string; settings?: Record<string, unknown>; resume?: PlayerId } = {
        t: 'create_private',
        name,
      };
      if (game !== undefined) msg.game = game;
      if (settings !== undefined) msg.settings = settings;
      if (resume !== undefined) msg.resume = resume;
      return msg;
    }
    case 'join_private': {
      if (!str(raw.name, 16) || !str(raw.code, 8)) return null;
      const resume = cleanResume(raw.resume);
      if (resume === null) return null;
      const msg: { t: 'join_private'; name: string; code: string; resume?: PlayerId } = {
        t: 'join_private',
        name: raw.name.trim().slice(0, 16) || 'Player',
        code: raw.code.toUpperCase(),
      };
      if (resume !== undefined) msg.resume = resume;
      return msg;
    }
    case 'leave':
      return { t: 'leave' };
    case 'ping':
      if (!num(raw.ts)) return null;
      return { t: 'ping', ts: raw.ts };
    default:
      // envelope-checked pass-through: routed RAW to the session's room
      return raw as RawEnvelope;
  }
}

export function encodeS2C(m: S2C): string {
  return JSON.stringify(m);
}
