// ============================================================================
// GameModule — the aces plug into the platform registry (the ONLY game-side
// file shaped by @platform/shared's GameModule). Mirrors games/outpost/
// server/src/module.ts: owns the clientDist probe and the createRoom seam;
// all match logic stays in room.ts.
//
// Settings flow through the FROZEN shared validateSettings(): unlike some
// platform modules it COERCES invalid values to defaults instead of throwing,
// so `createRoom` never rejects — every ACES room always runs on a fully-
// typed Required<RoomSettings> record (the room re-validates internally too,
// since tests construct AcesRoom directly).
// ============================================================================
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEV_PORT, GAME_ID, GAME_NAME, MAX_PLAYERS, MIN_PLAYERS, validateSettings } from '@aces/shared';
import type { GameModule, GameRoomHandle } from '@platform/shared';
import { AcesRoom } from './room.js';

/**
 * Absolute path to the built aces client. Candidates cover the two layouts
 * this module runs in (first existing index.html wins):
 *   1. dev (tsx): here = games/aces/server/src -> games/aces/client/dist
 *   2. bundled (repo root or Docker /app): here = platform/server/dist
 *      (esbuild inlines this module into dist/server.js, so import.meta.url
 *      is the BUNDLE's url)                    -> <root>/games/aces/client/dist
 *   3/4. cwd fallbacks: repo root, and the package dir (npm -w scripts).
 * When nothing is built yet the dev path is returned; the platform entry
 * already falls back to its placeholder text when index.html is absent.
 */
function resolveClientDist(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, '../../client/dist'),
    path.resolve(here, '../../../games/aces/client/dist'),
    path.resolve(process.cwd(), 'games/aces/client/dist'),
    path.resolve(process.cwd(), '../client/dist'),
  ];
  for (const dir of candidates) {
    if (existsSync(path.join(dir, 'index.html'))) return dir;
  }
  const dev = candidates[0];
  if (dev === undefined) throw new Error('unreachable: empty candidate list');
  return dev;
}

export const acesModule: GameModule = {
  id: GAME_ID,
  name: GAME_NAME,
  clientDist: resolveClientDist(),
  // vite dev server (npm run dev -w @aces/client): the platform proxies
  // /aces/ here when it answers, so one port serves launcher + HMR client.
  devPort: DEV_PORT,
  minPlayers: MIN_PLAYERS,
  maxPlayers: MAX_PLAYERS,
  createRoom(opts): GameRoomHandle {
    // Validation gate up front (coercive, never throws) — then hand the raw
    // record to the room, which re-validates into its own frozen copy.
    validateSettings(opts.settings);
    // The platform RoomIO is structurally identical to what AcesRoom expects
    // (send accepts unknown ⊇ S2C; rttMs over string ids), so the value
    // passes through unchanged — same shape as outpost/rift's seams.
    return new AcesRoom(opts.visibility, opts.io, opts.settings);
  },
};

// ============================================================================
// ·SDK PORT (docs/PLATFORM.md §7) — same rooms under a second id; the port's
// own client lives at games/aces-sdk/client. Zero legacy edits.
// ============================================================================
import { variantOf } from '@platform/shared';
import { existsSync as _es } from 'node:fs';
import _p from 'node:path';

function resolvePortDist_aces(): string {
  const here = _p.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    _p.resolve(here, '../../aces-sdk/client/dist'),
    _p.resolve(process.cwd(), 'games/aces-sdk/client/dist'),
    _p.resolve(process.cwd(), '../games/aces-sdk/client/dist'),
  ];
  for (const dir of candidates) if (_es(_p.join(dir, 'index.html'))) return dir;
  return candidates[0]!;
}

export const acesSdkModule = variantOf(acesModule, {
  id: 'aces-sdk',
  name: 'ACES·SDK',
  devPort: 5189,
  clientDist: resolvePortDist_aces(),
});
