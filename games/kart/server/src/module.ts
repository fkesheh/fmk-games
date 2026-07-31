import { MIN_PLAYERS, MAX_PLAYERS } from '@kart/shared';
// ============================================================================
// KART GameModule — the KART GP plug into the platform registry (the ONLY
// kart-server file that imports @platform/shared). Owns the clientDist probe;
// all race logic stays in room.ts. createRoom ignores settings (docs/KART.md:
// no room variants v1).
// ============================================================================
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GameModule, GameRoomHandle } from '@platform/shared';
import { KartRoom } from './room.js';

/**
 * Absolute path to the built kart client. Candidates cover the two layouts
 * this module runs in (first existing index.html wins):
 *   1. dev (tsx): here = games/kart/server/src   -> games/kart/client/dist
 *   2. bundled (repo root or Docker /app): here = platform/server/dist
 *      (esbuild inlines this module into dist/server.js, so import.meta.url
 *      is the BUNDLE's url)                       -> <root>/games/kart/client/dist
 *   3/4. cwd fallbacks: repo root, and the package dir (npm -w scripts).
 * When nothing is built yet the dev path is returned; the platform entry
 * already falls back to its placeholder text when index.html is absent.
 */
function resolveClientDist(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, '../../client/dist'),
    path.resolve(here, '../../../games/kart/client/dist'),
    path.resolve(process.cwd(), 'games/kart/client/dist'),
    path.resolve(process.cwd(), '../client/dist'),
  ];
  for (const dir of candidates) {
    if (existsSync(path.join(dir, 'index.html'))) return dir;
  }
  const dev = candidates[0];
  if (dev === undefined) throw new Error('unreachable: empty candidate list');
  return dev;
}

export const kartModule: GameModule = {
  id: 'kart',
  name: 'KART GP',
  clientDist: resolveClientDist(),
  // vite dev server (npm run dev -w @kart/client): the platform proxies /kart/
  // here when it answers, so one port (8080) serves launcher + HMR client.
  devPort: 5175,
  minPlayers: MIN_PLAYERS,
  maxPlayers: MAX_PLAYERS,
  createRoom(opts): GameRoomHandle {
    return new KartRoom(opts.visibility, opts.io); // settings ignored: no variants v1
  },
};
