// ============================================================================
// OUTPOST GameModule — the OUTPOST plug into the platform registry (the ONLY
// outpost-server file whose job is the module contract; all horde logic stays
// in room.ts). Owns the clientDist probe and createRoom settings validation
// ({debug} test/e2e staging flag, forwarded to the room's 4th parameter).
// ============================================================================
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GAME_NAME, MAX_PLAYERS, MIN_PLAYERS } from '@outpost/shared';
import type { GameModule, GameRoomHandle } from '@platform/shared';
import { OutpostRoom } from './room.js';

/**
 * Absolute path to the built outpost client. Candidates cover the two layouts
 * this module runs in (first existing index.html wins):
 *   1. dev (tsx): here = games/outpost/server/src -> games/outpost/client/dist
 *   2. bundled (repo root or Docker /app): here = platform/server/dist
 *      (esbuild inlines this module into dist/server.js, so import.meta.url
 *      is the BUNDLE's url)                        -> <root>/games/outpost/client/dist
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

/**
 * Settings validation (CONTRACT §7 V1): accept `undefined`, `{}`, or
 * `{debug: boolean}` — the test/e2e staging flag room.ts gates DebugMsg on.
 * THROW on anything else; the lobby forwards the message as
 * `{t:'error', code:'bad_settings'}`.
 */
export function parseOutpostRoomSettings(settings: Record<string, unknown> | undefined): {
  debug: boolean;
} {
  if (settings === undefined) return { debug: false };
  if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) {
    throw new Error('outpost settings must be an object');
  }
  const keys = Object.keys(settings);
  if (keys.length === 0) return { debug: false };
  if (keys.length === 1 && keys[0] === 'debug') {
    const debug = settings.debug;
    if (typeof debug === 'boolean') return { debug };
    throw new Error('outpost settings.debug must be a boolean');
  }
  throw new Error(`unknown outpost settings: ${keys.join(', ')}`);
}

export const outpostModule: GameModule = {
  id: 'outpost',
  name: GAME_NAME,
  clientDist: resolveClientDist(),
  // vite dev server (npm run dev -w @outpost/client): the platform proxies
  // /outpost/ here when it answers, so one port (8080) serves launcher + HMR
  // client. Must match DEV_PORT (shared config) and `server.port` in the
  // client's vite.config.ts.
  devPort: 5179,
  minPlayers: MIN_PLAYERS,
  maxPlayers: MAX_PLAYERS,
  createRoom(opts): GameRoomHandle {
    // Settings are opaque to the platform; the game validates them and THROWS
    // on bad input, which the lobby forwards as `bad_settings`. The validated
    // record is forwarded to the room's additive 4th parameter (room.ts gates
    // its DebugMsg wire on `settings.debug === true`); production rooms run
    // with debug off unless the creator asked for it.
    const { debug } = parseOutpostRoomSettings(opts.settings);
    return new OutpostRoom(opts.visibility, opts.io, undefined, { debug });
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
  // P2P (docs/PLATFORM.md §12.6): outpost-sdk rooms are rendezvous shells;
  // the run itself sims in the host player's tab (games/outpost-sdk/client).
  p2pShell: true,
});
