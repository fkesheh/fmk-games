// ============================================================================
// FROZEN CONTRACT — immutable once fan-out has started.
// If this contract is wrong or incomplete, STOP and report to the orchestrator;
// do not amend locally. Local amendments cause parallel implementers to diverge.
// ----------------------------------------------------------------------------
// KART pad (phone-as-controller) ROOM-LEVEL protocol. The platform owns the
// join handshake (@platform/shared pad.ts: join_as_pad + addPad); this file is
// everything past the bind. All messages here ride the platform's raw
// pass-through — no lobby involvement.
//
// FLOW
// 1. Desktop player sends {t:'pad_pair_request'} (lobby passes it RAW to the
//    room). The room mints a single-use token (PAD.tokenTtlMs lifetime),
//    replies {t:'pad_pair'} to THAT player only, and the desktop renders a QR
//    for `${location.origin}${KART_PAD_PAGE_PATH}?room=<room>&token=<token>`.
// 2. The phone loads the pad page, opens /ws, sends the lobby-level
//    {t:'join_as_pad', room, token}; the lobby calls room.addPad; on success
//    the room binds the pad session to the requesting player and sends the
//    pad {t:'pad_joined'} and the player {t:'pad_status', bound:true}.
// 3. CONTROL TRANSFER: while a pad is bound, the player's own session loses
//    input control — the room DROPS kart_input/nitro from the player session
//    and accepts them from the pad session instead (existing KartC2S shapes,
//    unchanged: the pad streams kart_input at SIM_HZ exactly like a client,
//    with its own seq counter starting at 0; the room resets the player's
//    seq gate on every bind AND unbind so either stream resumes cleanly).
//    Every pad input the room accepts is echoed to the player session as
//    {t:'pad_input'} — the desktop feeds these to its predictor, so its local
//    sim steps on exactly the inputs the server integrated.
// 4. Unbind (pad socket drop, pad 'leave', or replacement by a new bind):
//    the player's session regains control, the desktop gets
//    {t:'pad_status', bound:false}, and a still-connected old pad gets
//    {t:'pad_left', reason}.
//
// WHY the pad reuses kart_input/nitro instead of a parallel shape: one
// validator, one queue, one budget path — pad input is indistinguishable from
// honest client input the moment it is bound, which is exactly the trust
// level a same-room controller deserves.
// ============================================================================
import { PAD } from '@platform/shared';
import type { KartInputMsg } from './types.js';

/** Path (under the kart client mount) of the phone pad page; QR target.
 *  A FILE url, not a directory: the platform static server SPA-fallbacks
 *  directory misses to the game page, and vite dev only serves the real
 *  multi-entry html — '/kart/pad.html' resolves correctly in both. */
export const KART_PAD_PAGE_PATH = '/kart/pad.html';

// ---- seated player -> room ----
export type KartPadPlayerC2S = { t: 'pad_pair_request' };

// ---- room -> seated player ----
export type KartPadToPlayerS2C =
  /** Single-use pairing token; `room` is the join_as_pad room reference
   *  (private join code when the room has one, else the roomId). */
  | { t: 'pad_pair'; room: string; token: string; expiresInMs: number }
  /** Pad binding changed. bound=true: phone controls this kart now;
   *  false: control returned to this session (resync the seq gate — the room
   *  already reset its side). */
  | { t: 'pad_status'; bound: boolean }
  /** Echo of a pad input the room accepted; `input.seq` is the PAD's seq.
   *  Desktop: push to the predictor; do NOT also emit it yourself. */
  | { t: 'pad_input'; input: KartInputMsg };

// ---- room -> pad ----
export type KartPadToPadS2C =
  /** Bind succeeded; `name` is the controlled player's display name. */
  | { t: 'pad_joined'; name: string }
  /** The room dropped this pad (still-connected session: stop sending). */
  | { t: 'pad_left'; reason: 'replaced' | 'player_left' };

// ---- validation (contract-surface parsers; null = drop silently) ----

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

export function parseKartPadPlayerC2S(raw: unknown): KartPadPlayerC2S | null {
  if (!isObj(raw) || raw.t !== 'pad_pair_request') return null;
  return { t: 'pad_pair_request' };
}

export function parseKartPadToPlayerS2C(raw: unknown): KartPadToPlayerS2C | null {
  if (!isObj(raw)) return null;
  switch (raw.t) {
    case 'pad_pair':
      if (typeof raw.room !== 'string' || raw.room.length < 1 || raw.room.length > PAD.roomRefMax) return null;
      if (typeof raw.token !== 'string' || raw.token.length < 1 || raw.token.length > PAD.tokenMax) return null;
      if (typeof raw.expiresInMs !== 'number' || !Number.isFinite(raw.expiresInMs)) return null;
      return { t: 'pad_pair', room: raw.room, token: raw.token, expiresInMs: raw.expiresInMs };
    case 'pad_status':
      if (typeof raw.bound !== 'boolean') return null;
      return { t: 'pad_status', bound: raw.bound };
    case 'pad_input':
      // `input` is a wire KartInputMsg; the desktop only re-pushes it into its
      // predictor, so a shallow envelope check suffices — range-clamping was
      // the room's job before the echo.
      if (!isObj(raw.input) || raw.input.t !== 'kart_input') return null;
      return { t: 'pad_input', input: raw.input as unknown as KartInputMsg };
    default:
      return null;
  }
}

export function parseKartPadToPadS2C(raw: unknown): KartPadToPadS2C | null {
  if (!isObj(raw)) return null;
  switch (raw.t) {
    case 'pad_joined':
      if (typeof raw.name !== 'string') return null;
      return { t: 'pad_joined', name: raw.name };
    case 'pad_left':
      if (raw.reason !== 'replaced' && raw.reason !== 'player_left') return null;
      return { t: 'pad_left', reason: raw.reason };
    default:
      return null;
  }
}
