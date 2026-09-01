// ============================================================================
// GameModule — the outpost plug into the platform registry (the ONLY
// game-side file that imports @platform/shared). Owns the clientDist probe;
// all match logic stays in room.ts.
// ============================================================================
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GAME_ID, GAME_NAME, DEV_PORT, MIN_PLAYERS, MAX_PLAYERS } from '@outpost/shared';
import type { GameModule, GameRoomHandle } from '@platform/shared';
import { OutpostRoom } from './room.js';

/**
 * Absolute path to the built outpost client. Candidates cover the two
 * layouts this module runs in (first existing index.html wins):
 *   1. dev (tsx): here = games/outpost/server/src -> games/outpost/client/dist
 *   2. bundled (repo root or Docker /app): here = platform/server/dist
 *      (esbuild inlines this module into dist/server.js, so import.meta.url
 *      is the BUNDLE's url)                       -> <root>/games/outpost/client/dist
 *   3/4. cwd fallbacks: repo root, and the package dir (npm -w scripts).
 * When nothing is built yet the dev path is returned; the platform entry
 * already falls back to its placeholder text when index.html is absent.
 */
function resolveClientDist(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, '../../client/dist'),
    path.resolve(here, '../../../games/outpost/client/dist'),
    path.resolve(process.cwd(), 'games/outpost/client/dist'),
    path.resolve(process.cwd(), '../client/dist'),
  ];
  for (const dir of candidates) {
    if (existsSync(path.join(dir, 'index.html'))) return dir;
  }
  const dev = candidates[0];
  if (dev === undefined) throw new Error('unreachable: empty candidate list');
  return dev;
}

export const outpostModule: GameModule = {
  id: GAME_ID,
  name: GAME_NAME,
  clientDist: resolveClientDist(),
  // vite dev server (npm run dev -w @outpost/client): the platform proxies
  // /outpost/ here when it answers, so one port (8080) serves launcher + HMR client.
  devPort: DEV_PORT,
  minPlayers: MIN_PLAYERS,
  maxPlayers: MAX_PLAYERS,
  createRoom(opts): GameRoomHandle {
    // The platform RoomIO is structurally identical to the outpost contract's
    // own RoomIO in room.ts (send/rttMs over PlayerId = string; send accepts
    // unknown, a supertype of outpost S2C) — OutpostRoom keeps its outpost-typed
    // io and the value passes through unchanged.
    return new OutpostRoom(opts.visibility, opts.io, undefined, opts.settings);
  },
};

// ============================================================================
// ·SDK PORT (docs/PLATFORM.md §7) — same rooms under a second id; the port's
// own client lives at games/outpost-sdk/client. Zero legacy edits.
// ============================================================================
import { variantOf } from '@platform/shared';
import { existsSync as _es } from 'node:fs';
import _p from 'node:path';

function resolvePortDist_outpost(): string {
  const here = _p.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    _p.resolve(here, '../../outpost-sdk/client/dist'),
    _p.resolve(process.cwd(), 'games/outpost-sdk/client/dist'),
    _p.resolve(process.cwd(), '../games/outpost-sdk/client/dist'),
  ];
  for (const dir of candidates) if (_es(_p.join(dir, 'index.html'))) return dir;
  return candidates[0]!;
}

export const outpostSdkModule = variantOf(outpostModule, {
  id: 'outpost-sdk',
  name: 'OUTPOST·SDK',
  devPort: 5193,
  clientDist: resolvePortDist_outpost(),
});
