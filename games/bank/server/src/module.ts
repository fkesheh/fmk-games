// ============================================================================
// BANK GameModule — the bank dice game plug into the platform registry (the
// ONLY bank-server file that imports @platform/shared). Owns the clientDist
// probe; createRoom ignores settings (bank has none) — all match logic stays
// in room.ts.
// ============================================================================
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GameModule, GameRoomHandle } from '@platform/shared';
import { BankRoom } from './room.js';

/**
 * Absolute path to the built bank client. Candidates cover the two layouts
 * this module runs in (first existing index.html wins):
 *   1. dev (tsx): here = games/bank/server/src   -> games/bank/client/dist
 *   2. bundled (repo root or Docker /app): here = platform/server/dist
 *      (esbuild inlines this module into dist/server.js, so import.meta.url
 *      is the BUNDLE's url)                       -> <root>/games/bank/client/dist
 *   3/4. cwd fallbacks: repo root, and the package dir (npm -w scripts).
 * When nothing is built yet the dev path is returned; the platform entry
 * already falls back to its placeholder text when index.html is absent.
 */
function resolveClientDist(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, '../../client/dist'),
    path.resolve(here, '../../../games/bank/client/dist'),
    path.resolve(process.cwd(), 'games/bank/client/dist'),
    path.resolve(process.cwd(), '../client/dist'),
  ];
  for (const dir of candidates) {
    if (existsSync(path.join(dir, 'index.html'))) return dir;
  }
  const dev = candidates[0];
  if (dev === undefined) throw new Error('unreachable: empty candidate list');
  return dev;
}

export const bankModule: GameModule = {
  id: 'bank',
  name: 'BANK',
  clientDist: resolveClientDist(),
  createRoom(opts): GameRoomHandle {
    // bank has no room settings; whatever the lobby passes through is ignored
    return new BankRoom(opts.visibility, opts.io);
  },
};
