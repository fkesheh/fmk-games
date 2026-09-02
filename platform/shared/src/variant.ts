// ============================================================================
// PLATFORM GAME-PORT HELPER (docs/PLATFORM.md §7) — register an EXISTING
// game's rooms under a second id ("·SDK" port) with zero legacy edits.
// The variant shares the base module's rooms/protocol verbatim; it overrides
// the registry-facing surface (id/name/devPort/clientDist) and reports ITS
// OWN id in RoomInfo.game — that field is what lobby URLs and launcher cards
// are built from, so a wrong value would misroute pads and launcher links.
// ============================================================================
import type { GameModule, GameRoomHandle, RoomIO } from './module.js';
import type { PadLayout } from './services.js';
import { CLAIM_ALPHABET } from './services.js';
import { rng } from './rng.js';

export interface VariantOpts {
  /** New GameModule.id (e.g. 'bank-sdk'). */
  readonly id: string;
  readonly name?: string;
  readonly devPort?: number;
  /** Dist of the PORT's own client build; falls back to the base module's. */
  readonly clientDist?: string;
  /** Extra pad declaration for the port (served at /api/pads/:id). */
  readonly padLayout?: PadLayout;
  /**
   * P2P mode (docs/PLATFORM.md §12): when the joiner's settings carry
   * {p2p:true}… — simpler: when set, EVERY room this variant creates is a
   * rendezvous shell; the real game runs in the host tab.
   */
  readonly p2pShell?: boolean;
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
      if (o.p2pShell === true) return p2pShellRoom(opts.io, base.maxPlayers, opts.visibility, o.id);
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

// ---- P2P shell rooms (docs/PLATFORM.md §12.6 P2) ---------------------------
// A rendezvous-only room: exists so peers can discover each other (rtc_peers
// presence) while the REAL game runs in the host's tab. No sim, no seats.

let shellSeq = 0;

export function p2pShellRoom(io: RoomIO, maxPlayers: number, visibility: 'public' | 'private', moduleId: string): GameRoomHandle {
  shellSeq += 1;
  const id = `p2p-shell-${shellSeq}`;
  let code = '';
  for (let i = 0; i < 6; i++) code += CLAIM_ALPHABET[Math.floor(rng(Date.now() ^ (i * 7919))() * CLAIM_ALPHABET.length)];
  const members = new Set<string>();
  let hostId: string | null = null; // first member = the creator = the host
  return {
    id,
    info: () => ({ id, code, game: moduleId, label: 'p2p', players: members.size, maxPlayers, phase: 'warmup', visibility }),
    playerCount: () => members.size,
    stalePlayers: () => [],
    addPlayer: (pid) => {
      if (hostId === null) hostId = pid;
      members.add(pid);
      io.send(pid, { t: 'p2p_ready', code, roomId: id, hostId });
    },
    removePlayer: (pid) => {
      members.delete(pid);
    },
    handleMessage: () => {},
    start: () => {},
    stop: () => {},
  };
}
