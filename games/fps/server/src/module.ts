// ============================================================================
// STRICKEN GameModule — the fps plug into the platform registry (the ONLY
// game-side file that imports @platform/shared). Owns the clientDist probe
// and createRoom settings validation; all match logic stays in game.ts.
// ============================================================================
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAPS, MAP_LIST, rng, rngPick } from '@fps/shared';
import type { MapId } from '@fps/shared';
import type { GameModule, GameRoomHandle } from '@platform/shared';
import { GameRoom } from './game.js';

/**
 * Absolute path to the built fps client. Candidates cover the two layouts
 * this module runs in (first existing index.html wins):
 *   1. dev (tsx): here = games/fps/server/src   -> games/fps/client/dist
 *   2. bundled (repo root or Docker /app): here = platform/server/dist
 *      (esbuild inlines this module into dist/server.js, so import.meta.url
 *      is the BUNDLE's url)                       -> <root>/games/fps/client/dist
 *   3/4. cwd fallbacks: repo root, and the package dir (npm -w scripts).
 * When nothing is built yet the dev path is returned; the platform entry
 * already falls back to its placeholder text when index.html is absent.
 */
function resolveClientDist(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, '../../client/dist'),
    path.resolve(here, '../../../games/fps/client/dist'),
    path.resolve(process.cwd(), 'games/fps/client/dist'),
    path.resolve(process.cwd(), '../client/dist'),
  ];
  for (const dir of candidates) {
    if (existsSync(path.join(dir, 'index.html'))) return dir;
  }
  const dev = candidates[0];
  if (dev === undefined) throw new Error('unreachable: empty candidate list');
  return dev;
}

/**
 * settings.mapId (opaque to the platform) must be a valid MapId; absent
 * (quick_join) => server-side random pick, rng(Date.now()) per RULE 7.
 * Invalid => throw; the lobby forwards the message as 'bad_settings'.
 */
function mapIdFrom(settings: Record<string, unknown> | undefined): MapId {
  const raw = settings?.['mapId'];
  if (raw === undefined) return rngPick(rng(Date.now()), MAP_LIST).id;
  if (typeof raw !== 'string' || !(raw in MAPS)) throw new Error('unknown map');
  return raw as MapId;
}

export const fpsModule: GameModule = {
  id: 'fps',
  name: 'STRICKEN',
  clientDist: resolveClientDist(),
  // vite dev server (npm run dev -w @fps/client): the platform proxies /fps/
  // here when it answers, so one port (8080) serves launcher + HMR client.
  devPort: 5173,
  createRoom(opts): GameRoomHandle {
    const mapId = mapIdFrom(opts.settings);
    // The platform RoomIO is structurally identical to the fps contract's own
    // RoomIO in game.ts (send/rttMs over PlayerId = string; send accepts
    // unknown, a supertype of fps S2C) — GameRoom keeps its fps-typed io and
    // the value passes through unchanged.
    return new GameRoom(mapId, opts.visibility, opts.io);
  },
};
