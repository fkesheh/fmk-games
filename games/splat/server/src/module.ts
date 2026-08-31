import { MAX_PLAYERS, MIN_PLAYERS } from '@splat/shared';
// ============================================================================
// SKI SPLAT GameModule — the SKI SPLAT plug into the platform registry (the
// ONLY splat-server file whose job is the module contract; all race logic
// stays in room.ts). Owns the clientDist probe and createRoom settings
// validation ({seed} dev/e2e slope override).
// ============================================================================
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GameModule, GameRoomHandle } from '@platform/shared';
import { SplatRoom } from './room.js';

/**
 * Absolute path to the built splat client. Candidates cover the two layouts
 * this module runs in (first existing index.html wins):
 *   1. dev (tsx): here = games/splat/server/src   -> games/splat/client/dist
 *   2. bundled (repo root or Docker /app): here = platform/server/dist
 *      (esbuild inlines this module into dist/server.js, so import.meta.url
 *      is the BUNDLE's url)                        -> <root>/games/splat/client/dist
 *   3/4. cwd fallbacks: repo root, and the package dir (npm -w scripts).
 * When nothing is built yet the dev path is returned; the platform entry
 * already falls back to its placeholder text when index.html is absent.
 */
function resolveClientDist(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, '../../client/dist'),
    path.resolve(here, '../../../games/splat/client/dist'),
    path.resolve(process.cwd(), 'games/splat/client/dist'),
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
 * Settings validation (CONTRACT §7 V1): accept `undefined`, `{}`, or
 * `{seed: number}` — the dev/e2e slope-seed override. THROW on anything else;
 * the lobby forwards the message as `{t:'error', code:'bad_settings'}`.
 */
export function parseSplatRoomSettings(settings: Record<string, unknown> | undefined): {
  seed: number | null;
} {
  if (settings === undefined) return { seed: null };
  if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) {
    throw new Error('splat settings must be an object');
  }
  const keys = Object.keys(settings);
  if (keys.length === 0) return { seed: null };
  if (keys.length === 1 && keys[0] === 'seed') {
    const seed = settings.seed;
    if (typeof seed === 'number' && Number.isFinite(seed)) return { seed };
    throw new Error('splat settings.seed must be a finite number');
  }
  throw new Error(`unknown splat settings: ${keys.join(', ')}`);
}

export const splatModule: GameModule = {
  id: 'splat',
  name: 'SKI SPLAT',
  clientDist: resolveClientDist(),
  // vite dev server (npm run dev -w @splat/client): the platform proxies /splat/
  // here when it answers, so one port (8080) serves launcher + HMR client.
  devPort: 5178,
  minPlayers: MIN_PLAYERS,
  maxPlayers: MAX_PLAYERS,
  createRoom(opts): GameRoomHandle {
    // Settings are opaque to the platform; the game validates them and THROWS
    // on bad input, which the lobby forwards as `bad_settings`.
    const { seed } = parseSplatRoomSettings(opts.settings);
    return new SplatRoom(opts.visibility, opts.io, seed);
  },
};

// ============================================================================
// ·SDK PORT (docs/PLATFORM.md §7) — same rooms under a second id; the port's
// own client lives at games/splat-sdk/client. Zero legacy edits.
// ============================================================================
import { variantOf } from '@platform/shared';
import { existsSync as _es } from 'node:fs';
import _p from 'node:path';

function resolvePortDist_splat(): string {
  const here = _p.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    _p.resolve(here, '../../splat-sdk/client/dist'),
    _p.resolve(process.cwd(), 'games/splat-sdk/client/dist'),
    _p.resolve(process.cwd(), '../games/splat-sdk/client/dist'),
  ];
  for (const dir of candidates) if (_es(_p.join(dir, 'index.html'))) return dir;
  return candidates[0]!;
}

export const splatSdkModule = variantOf(splatModule, {
  id: 'splat-sdk',
  name: 'SPLAT·SDK',
  devPort: 5188,
  clientDist: resolvePortDist_splat(),
});
