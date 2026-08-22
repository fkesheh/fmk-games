// ============================================================================
// FROZEN CONTRACT — immutable once fan-out has started.
// If this contract is wrong or incomplete, STOP and report to the orchestrator;
// do not amend locally. Local amendments cause parallel implementers to diverge.
// ----------------------------------------------------------------------------
// PAD (phone-as-controller) platform primitives. A "pad" is a NON-PLAYER
// session bound to a seated player: it joins a room via the lobby message
// {t:'join_as_pad'} carrying a single-use pairing token the room issued to
// that player, and from then on its room-level messages are interpreted by
// the game as the bound player's intent. Pads never occupy a seat, never
// appear in RoomInfo.players, and never keep an empty room alive.
//
// The platform owns ONLY the join handshake (this file, protocol.ts,
// module.ts addPad). Everything past the bind — pair-token issuance, input
// shapes, echo semantics — is game-level protocol (kart: @kart/shared pad.ts).
// ============================================================================

/** Limits for the lobby-level pad join handshake. */
export const PAD = {
  /** Pairing-token lifetime, from issuance (room-level pad_pair) to bind attempt. */
  tokenTtlMs: 60_000,
  /** Max length of the room reference (public roomId or private join code). */
  roomRefMax: 24,
  /** Max length of a pairing token. */
  tokenMax: 24,
} as const;

/**
 * Every lobby-level failure a pad join can observe, delivered as the existing
 * S2C {t:'error', code, message} envelope. Pad client behavior per code:
 * - 'no_room': the room reference is wrong or the room is gone. Show
 *   "game not found — rescan the QR"; do not retry the same URL.
 * - 'pad_unsupported': the room's game has no pad support (addPad absent).
 *   Terminal for this game; show "this game has no phone-controller mode".
 * - 'pad_rejected': token invalid, expired, or already consumed. Recoverable:
 *   tell the user to regenerate the QR on the desktop and rescan.
 */
export type PadJoinErrorCode = 'no_room' | 'pad_unsupported' | 'pad_rejected';
