// ============================================================================
// BANK GameModule — the bank dice game plug into the platform registry (the
// ONLY bank-server file that imports @platform/shared). Owns the clientDist
// probe and the room-variant settings validation (docs/BANK.md "Room
// variants"); all match logic stays in room.ts.
// ============================================================================
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_SETTINGS, MAX_PLAYERS, MIN_PLAYERS } from '@bank/shared';
import type { BankSettings } from '@bank/shared';
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

/**
 * Validate + resolve the room variant (docs/BANK.md "Room variants"). Every
 * field is optional and defaults from DEFAULT_SETTINGS; a present-but-wrong
 * field (bad type or out-of-choice value) throws — the lobby forwards the
 * message as a `bad_settings` error.
 */
function resolveSettings(raw: Record<string, unknown> | undefined): BankSettings {
  const s = raw ?? {};
  const sevenBonus = s['sevenBonus'] ?? DEFAULT_SETTINGS.sevenBonus;
  if (typeof sevenBonus !== 'boolean') {
    throw new Error('settings.sevenBonus must be a boolean');
  }
  const totalRounds = s['totalRounds'] ?? DEFAULT_SETTINGS.totalRounds;
  if (totalRounds !== 10 && totalRounds !== 20) {
    throw new Error('settings.totalRounds must be 10 or 20');
  }
  const raceTarget = s['raceTarget'] ?? DEFAULT_SETTINGS.raceTarget;
  if (raceTarget !== null && raceTarget !== 500) {
    throw new Error('settings.raceTarget must be null or 500');
  }
  return { sevenBonus, totalRounds, raceTarget };
}

export const bankModule: GameModule = {
  id: 'bank',
  name: 'BANK',
  clientDist: resolveClientDist(),
  // vite dev server (npm run dev -w @bank/client): the platform proxies /bank/
  // here when it answers, so one port (8080) serves launcher + HMR client.
  devPort: 5174,
  minPlayers: MIN_PLAYERS,
  maxPlayers: MAX_PLAYERS,
  createRoom(opts): GameRoomHandle {
    return new BankRoom(opts.visibility, opts.io, resolveSettings(opts.settings));
  },
};

// ============================================================================
// ·SDK PORT (docs/PLATFORM.md §7) — same rooms under a second id; the port's
// own client lives at games/bank-sdk/client. Zero legacy edits.
// ============================================================================
import { variantOf } from '@platform/shared';
import { existsSync as _es } from 'node:fs';
import _p from 'node:path';

function resolvePortDist_bank(): string {
  const here = _p.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    _p.resolve(here, '../../bank-sdk/client/dist'),
    _p.resolve(process.cwd(), 'games/bank-sdk/client/dist'),
    _p.resolve(process.cwd(), '../games/bank-sdk/client/dist'),
  ];
  for (const dir of candidates) if (_es(_p.join(dir, 'index.html'))) return dir;
  return candidates[0]!;
}

export const bankSdkModule = variantOf(bankModule, {
  id: 'bank-sdk',
  name: 'BANK·SDK',
  devPort: 5185,
  clientDist: resolvePortDist_bank(),
});
