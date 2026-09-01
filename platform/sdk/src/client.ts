// ============================================================================
// SDK FACADE — createGameClient(): wires net/rooms/profile/saves/input/audio
// into one object (docs/PLATFORM.md §4.5). Also owns the pad-pairing flow:
// pad_pair_request → overlay with code → pad_status updates.
// Owner: P6_SDK_CORE — implement GameClient from types.ts.
//
// Wiring notes:
//   - The facade subscribes protocol-level handlers through
//     SdkNet.addInternalListener so a game assigning net.onMessage never
//     clobbers auth_ok hydration or pad-pair updates.
//   - autoAuth: after EVERY open (first + reconnect replays) net sends
//     {t:'auth',token} when a stored token exists and autoAuth isn't false.
//   - ready resolves once identity is loaded AND the first ws connect attempt
//     has settled — offline play stays fully supported (rejection swallowed;
//     autoReconnect keeps retrying in the background when enabled).
// ============================================================================

import { loadIdentity } from '@platform/shared';
import type { LobbyS2C } from '@platform/shared';
import { SynthKit } from './audio.js';
import { GameInputHub } from './input.js';
import { LobbyRooms } from './rooms.js';
import { Profiles } from './profile.js';
import { CloudSaves } from './saves.js';
import type { PadPairOverlay } from './padQr.js';
import { showPadPairing as renderPadOverlay } from './padQr.js';
import { SdkNet } from './net.js';
import type { C2S } from '@platform/shared';
import type { GameClient, GameClientOpts } from './types.js';

type Msg = LobbyS2C & Record<string, unknown>;

export function createGameClient(opts: GameClientOpts): GameClient {
  const gameId = opts.gameId;

  // ---- identity first (mints/persists the durable sig; storage-guarded) -----
  loadIdentity();

  const netOpts: {
    autoReconnect?: boolean;
    authPayload?: () => C2S | null;
  } = {
    authPayload: () => {
      if (opts.autoAuth === false) return null;
      const token = profiles.token();
      return token !== null && token !== '' ? { t: 'auth', token } : null;
    },
  };
  if (opts.autoReconnect !== undefined) netOpts.autoReconnect = opts.autoReconnect;
  const net = new SdkNet(netOpts);
  const profileOpts: { autoAuth?: boolean } = {};
  if (opts.autoAuth !== undefined) profileOpts.autoAuth = opts.autoAuth;
  const profiles = new Profiles(net, profileOpts);
  const rooms = new LobbyRooms(net, gameId);
  const saves = new CloudSaves(gameId, () => profiles.token());
  const input = new GameInputHub(opts.canvas ?? null);
  const audio = new SynthKit();

  // ---- service-level message wiring -----------------------------------------
  let overlay: PadPairOverlay | null = null;

  const unsubscribe = net.addInternalListener((msg: Msg): void => {
    switch (msg.t) {
      case 'auth_ok':
        profiles.handleAuthOk(msg.profileId, msg.name);
        break;
      case 'auth_err':
        profiles.handleAuthErr();
        break;
      case 'pad_pair':
        // First reply renders the overlay; re-pairs (TTL expiry) just update it.
        if (overlay === null) {
          try {
            // docs/PAD.md shape: {room, token, expiresInMs}; the SDK builds
            // the pad URL itself (game id + room ref baked into the path).
            const urlPath = `/pad/?game=${gameId}&r=${encodeURIComponent(msg.room)}`;
            overlay = renderPadOverlay(urlPath, msg.token);
          } catch {
            overlay = null; // no DOM / P7 pending — pairing still functions headless
          }
        } else {
          overlay.setCode(msg.token);
        }
        break;
      case 'pad_status':
        if (msg.bound === true) overlay?.bound();
        break;
      default:
        break;
    }
  });

  // ---- lifecycle ---------------------------------------------------------------
  const ready: Promise<void> = net.connect().then(
    () => undefined,
    () => undefined,
  );

  const client: GameClient = {
    gameId,
    ready,
    net,
    rooms,
    profile: profiles,
    saves,
    input,
    audio,

    /** Phone-as-pad pairing: request now, render the overlay on the reply. */
    showPadPairing(): void {
      net.send({ t: 'pad_pair_request' });
    },

    dispose(): void {
      unsubscribe();
      try {
        overlay?.dismiss();
      } catch {
        // already gone
      }
      overlay = null;
      input.stop();
      net.close();
    },
  };

  return client;
}
