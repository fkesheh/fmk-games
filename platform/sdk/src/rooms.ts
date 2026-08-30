// ============================================================================
// SDK ROOMS — typed senders over the lobby's LobbyC2S verbs (docs/PLATFORM.md
// §4). Fire-and-forget by design: replies (room_list / welcome / error) arrive
// via net.onMessage — no fake promises here. Every join/create message carries
// the browser identity automatically: durable `sig` (@platform/shared) plus,
// when a per-game session pointer exists, `resume` — so reloads/reconnects
// rebind the seat they dropped.
// Owner: P6_SDK_CORE — implement RoomsApi from types.ts.
//
// DOM-free: identity.ts guards its own storage access; nothing here touches
// window/localStorage directly.
// ============================================================================

import { loadSession, loadSig, SIG_MAX, SIG_MIN } from '@platform/shared';
import type { PlayerId } from '@platform/shared';
import type { SdkNet } from './net.js';
import type { RoomsApi } from './types.js';

/** resume+sig fields for join/create envelopes, populated when available. */
interface IdentityFields {
  resume?: PlayerId;
  sig?: string;
}

function identityFields(gameId?: string): IdentityFields {
  const out: IdentityFields = {};
  const sig = loadSig();
  if (sig.length >= SIG_MIN && sig.length <= SIG_MAX) out.sig = sig;

  if (gameId !== undefined && gameId !== '') {
    const session = loadSession(gameId);
    if (session !== null && session.playerId !== '') out.resume = session.playerId;
  }
  return out;
}

/**
 * Typed lobby senders. `gameId` (a GameModule.id, when known) routes
 * quick_join/create_* to that game's module and keys the resume lookup.
 */
export class LobbyRooms implements RoomsApi {
  private readonly net: SdkNet;
  private readonly gameId?: string;

  constructor(net: SdkNet, gameId?: string) {
    this.net = net;
    if (gameId !== undefined && gameId !== '') this.gameId = gameId;
  }

  /** The game field routes quick_join/create_* at this game's module. */
  private gameField(): { game?: string } {
    return this.gameId !== undefined ? { game: this.gameId } : {};
  }

  list(): void {
    this.net.send({ t: 'list_rooms' });
  }

  quickJoin(name: string): void {
    this.net.send({
      t: 'quick_join',
      name,
      ...this.gameField(),
      ...identityFields(this.gameId),
    });
  }

  joinPublic(name: string, roomId: string): void {
    this.net.send({
      t: 'join_public',
      name,
      roomId,
      ...identityFields(),
    });
  }

  createPublic(name: string, settings?: Record<string, unknown>): void {
    this.create('create_public', name, settings);
  }

  createPrivate(name: string, settings?: Record<string, unknown>): void {
    this.create('create_private', name, settings);
  }

  private create(
    tag: 'create_public' | 'create_private',
    name: string,
    settings?: Record<string, unknown>,
  ): void {
    const payload =
      settings !== undefined
        ? { t: tag, name, settings, ...this.gameField(), ...identityFields(this.gameId) }
        : { t: tag, name, ...this.gameField(), ...identityFields(this.gameId) };
    this.net.send(payload);
  }

  joinPrivate(name: string, code: string): void {
    this.net.send({
      t: 'join_private',
      name,
      code,
      ...identityFields(),
    });
  }

  leave(): void {
    this.net.send({ t: 'leave' });
  }
}
