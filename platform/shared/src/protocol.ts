// ============================================================================
// PLATFORM PROTOCOL — lobby-level wire validation, game-agnostic. The lobby
// parses + sanitizes the seven lobby messages; EVERYTHING else is only
// envelope-checked ({t: string} object) and passed through RAW — the room's
// game validates it with its own parser and silently drops invalid messages.
// Invalid lobby input => null; never throw on wire data.
// ============================================================================
import { SIG_MAX, SIG_MIN } from './identity.js';
import type { PlayerId, RoomInfo } from './module.js';
import { cleanPadFrame, isValidPairCode, isValidToken } from './services.js';
import type { PadLayout } from './services.js';

/** Transport liveness: ws protocol-level ping cadence, used by net.ts. */
export const NET = {
  pingEveryMs: 2000,
} as const;

// ---- client -> server: lobby-level (parsed + handled by the platform) ----
// `game` is a GameModule.id; absent => the first registered module.
// `settings` is opaque to the platform; the module validates it in createRoom.
export type LobbyC2S =
  | { t: 'list_rooms' }
  | { t: 'quick_join'; name: string; game?: string; resume?: PlayerId; sig?: string }
  | { t: 'join_public'; name: string; roomId: string; resume?: PlayerId; sig?: string } // join a specific public room by id (room list rows)
  | { t: 'create_public'; name: string; game?: string; settings?: Record<string, unknown>; resume?: PlayerId; sig?: string }
  | { t: 'create_private'; name: string; game?: string; settings?: Record<string, unknown>; resume?: PlayerId; sig?: string }
  | { t: 'join_private'; name: string; code: string; resume?: PlayerId; sig?: string }
  | { t: 'leave' }
  | { t: 'ping'; ts: number }
  // ---- v2 (docs/PLATFORM.md §5) — parsed + handled by the platform ----
  /** Bind this session to a profile. Idempotent; second auth replaces the first. */
  | { t: 'auth'; token: string }
  /** In-room: mint a one-time pad pairing token for THIS session's room. */
  | { t: 'pad_pair_request' }
  /** From a pad device: bind to a room with a pairing token (becomes a pad session). */
  | { t: 'join_as_pad'; room: string; token: string }
  /** Pad → paired room input frame (relayed RAW into the room + echoed). */
  | { t: 'pad_input'; seq: number; lx: number; ly: number; rx: number; ry: number; buttons: number };

/** Sanitize a resume token (a previous session's playerId), or undefined. */
export function cleanResume(v: unknown): PlayerId | undefined | null {
  if (v === undefined) return undefined;
  return typeof v === 'string' && v.length >= 4 && v.length <= 24 ? v : null;
}

/**
 * Sanitize a browser signature (@platform/shared identity), or undefined.
 *
 * Unlike `resume` this is DURABLE: the same browser presents the same value
 * across reloads, purges and reconnects, so a room can rebind a ghost seat by
 * signature when the playerId chain has already been broken. It is a rejoin
 * hint only — never a credential, and never trusted for anything a player
 * could gain by forging it (a forged sig can at most claim a ghost seat in
 * the room it is sent to, which is the same reach `resume` already had).
 */
export function cleanSig(v: unknown): string | undefined | null {
  if (v === undefined) return undefined;
  return typeof v === 'string' && v.length >= SIG_MIN && v.length <= SIG_MAX ? v : null;
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
  | { t: 'error'; code: string; message: string }
  // ---- v2 (docs/PLATFORM.md §5) ----
  /** Session is authenticated. */
  | { t: 'auth_ok'; profileId: PlayerId; name: string }
  /** auth failed (bad/expired token). */
  | { t: 'auth_err'; message: string }
  /** Reply to pad_pair_request: one-time token + the /pad/ URL path to open. */
  | { t: 'pad_pair'; room: string; token: string; urlPath: string }
  /** To the pairing player: a pad bound/unbound from their seat. */
  | { t: 'pad_status'; bound: boolean }
  /** To the pad device: binding accepted. */
  | { t: 'pad_joined' }
  /** To the pad device: binding refused (bad token, room gone, already used…). */
  | { t: 'pad_rejected'; reason: string }
  /** Ack to the pad for RTT estimation. */
  | { t: 'pad_input_echo'; seq: number };

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
      const sig = cleanSig(raw.sig);
      if (name === null || game === null || resume === null || sig === null) return null;
      const msg: { t: 'quick_join'; name: string; game?: string; resume?: PlayerId; sig?: string } = { t: 'quick_join', name };
      if (game !== undefined) msg.game = game;
      if (resume !== undefined) msg.resume = resume;
      if (sig !== undefined) msg.sig = sig;
      return msg;
    }
    case 'join_public': {
      const name = cleanName(raw.name);
      const resume = cleanResume(raw.resume);
      const sig = cleanSig(raw.sig);
      if (name === null || resume === null || sig === null) return null;
      if (!str(raw.roomId, 16)) return null;
      const msg: { t: 'join_public'; name: string; roomId: string; resume?: PlayerId; sig?: string } = {
        t: 'join_public',
        name,
        roomId: raw.roomId,
      };
      if (resume !== undefined) msg.resume = resume;
      if (sig !== undefined) msg.sig = sig;
      return msg;
    }
    case 'create_public': {
      const name = cleanName(raw.name);
      const game = cleanGame(raw.game);
      const settings = cleanSettings(raw.settings);
      const resume = cleanResume(raw.resume);
      const sig = cleanSig(raw.sig);
      if (name === null || game === null || settings === null || resume === null || sig === null) return null;
      const msg: { t: 'create_public'; name: string; game?: string; settings?: Record<string, unknown>; resume?: PlayerId; sig?: string } = {
        t: 'create_public',
        name,
      };
      if (game !== undefined) msg.game = game;
      if (settings !== undefined) msg.settings = settings;
      if (resume !== undefined) msg.resume = resume;
      if (sig !== undefined) msg.sig = sig;
      return msg;
    }
    case 'create_private': {
      const name = cleanName(raw.name);
      const game = cleanGame(raw.game);
      const settings = cleanSettings(raw.settings);
      const resume = cleanResume(raw.resume);
      const sig = cleanSig(raw.sig);
      if (name === null || game === null || settings === null || resume === null || sig === null) return null;
      const msg: { t: 'create_private'; name: string; game?: string; settings?: Record<string, unknown>; resume?: PlayerId; sig?: string } = {
        t: 'create_private',
        name,
      };
      if (game !== undefined) msg.game = game;
      if (settings !== undefined) msg.settings = settings;
      if (resume !== undefined) msg.resume = resume;
      if (sig !== undefined) msg.sig = sig;
      return msg;
    }
    case 'join_private': {
      if (!str(raw.name, 16) || !str(raw.code, 8)) return null;
      const resume = cleanResume(raw.resume);
      const sig = cleanSig(raw.sig);
      if (resume === null || sig === null) return null;
      const msg: { t: 'join_private'; name: string; code: string; resume?: PlayerId; sig?: string } = {
        t: 'join_private',
        name: raw.name.trim().slice(0, 16) || 'Player',
        code: raw.code.toUpperCase(),
      };
      if (resume !== undefined) msg.resume = resume;
      if (sig !== undefined) msg.sig = sig;
      return msg;
    }
    case 'leave':
      return { t: 'leave' };
    case 'ping':
      if (!num(raw.ts)) return null;
      return { t: 'ping', ts: raw.ts };
    // ---- v2 ----
    case 'auth':
      if (!isValidToken(raw.token)) return null;
      return { t: 'auth', token: raw.token };
    case 'pad_pair_request':
      return { t: 'pad_pair_request' };
    case 'join_as_pad': {
      if (typeof raw.room !== 'string' || raw.room.length < 4 || raw.room.length > 16) return null;
      if (!isValidPairCode(raw.token)) return null;
      return { t: 'join_as_pad', room: raw.room, token: raw.token };
    }
    case 'pad_input': {
      if (!num(raw.seq) || raw.seq < 0 || raw.seq > 0xffffffff) return null;
      const frame = cleanPadFrame({ lx: raw.lx, ly: raw.ly, rx: raw.rx, ry: raw.ry, buttons: raw.buttons });
      if (frame === null) return null;
      return {
        t: 'pad_input',
        seq: Math.trunc(raw.seq),
        lx: frame.lx,
        ly: frame.ly,
        rx: frame.rx,
        ry: frame.ry,
        buttons: frame.buttons,
      };
    }
    default:
      // envelope-checked pass-through: routed RAW to the session's room
      return raw as RawEnvelope;
  }
}

export function encodeS2C(m: S2C): string {
  return JSON.stringify(m);
}
