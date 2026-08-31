// ============================================================================
// PLATFORM GAME-PORT HELPER (docs/PLATFORM.md §7) — register an EXISTING
// game's rooms under a second id ("·SDK" port) with zero legacy edits.
// The variant shares the base module's rooms/protocol verbatim; it overrides
// the registry-facing surface (id/name/devPort/clientDist) and reports ITS
// OWN id in RoomInfo.game — that field is what lobby URLs and launcher cards
// are built from, so a wrong value would misroute pads and launcher links.
// ============================================================================
import type { GameModule } from './module.js';
import type { PadLayout } from './services.js';

export interface VariantOpts {
  /** New GameModule.id (e.g. 'bank-sdk'). */
  readonly id: string;
  readonly name?: string;
  readonly devPort?: number;
  /** Dist of the PORT's own client build; falls back to the base module's. */
  readonly clientDist?: string;
  /** Extra pad declaration for the port (served at /api/pads/:id). */
  readonly padLayout?: PadLayout;
}

export function variantOf(base: GameModule, o: VariantOpts): GameModule {
  return {
    id: o.id,
    name: o.name ?? base.name,
    clientDist: o.clientDist ?? base.clientDist,
    ...(o.devPort !== undefined ? { devPort: o.devPort } : {}),
    ...(o.padLayout !== undefined ? { padLayout: o.padLayout } : {}),
    minPlayers: base.minPlayers,
    maxPlayers: base.maxPlayers,
    createRoom(opts) {
      const room = base.createRoom(opts);
      return {
        id: room.id,
        info: () => ({ ...room.info(), game: o.id }),
        playerCount: () => room.playerCount(),
        stalePlayers: () => room.stalePlayers(),
        addPlayer: (id, name, resume, sig) => room.addPlayer(id, name, resume, sig),
        removePlayer: (id, permanent) => room.removePlayer(id, permanent),
        ...(room.addPad !== undefined
          ? { addPad: (padId: string, token: string): boolean => room.addPad!(padId, token) }
          : {}),
        handleMessage: (id, msg) => room.handleMessage(id, msg),
        start: () => room.start(),
        stop: () => room.stop(),
      };
    },
  };
}
