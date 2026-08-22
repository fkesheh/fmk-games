// ============================================================================
// SUMO GameModule — the plug for the platform registry (INT registers it;
// this file registers NOTHING). Owns the clientDist probe + padLayout
// declaration; all gameplay lives in room.ts/sim.ts.
//
// DEVIATION from specs/P10.md: devPort is 5183, not the spec's 5178 — ORBIT
// already took 5178 (games/orbit/vite.config.ts), so sumo's vite dev server
// binds 5183 and this module advertises the same port.
// ============================================================================

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GameModule, GameRoomHandle } from '@platform/shared';
import { MAX_PLAYERS, MIN_PLAYERS } from '@sumo/shared';
import { SumoRoom } from './room.js';

export const GAME_ID = 'sumo';
export const DEV_PORT = 5183;

/**
 * Absolute path to the built client (kart/module.ts precedent). Candidates
 * cover both layouts this file runs in — first existing index.html wins:
 *   1. dev (tsx):   here = games/sumo/server/src -> games/sumo/client/dist
 *   2. bundled:     here = platform/server/dist  -> <root>/games/sumo/client/dist
 *   3/4. cwd fallbacks: repo root / package dir.
 */
function resolveClientDist(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, '../../client/dist'),
    path.resolve(here, '../../../games/sumo/client/dist'),
    path.resolve(process.cwd(), 'games/sumo/client/dist'),
    path.resolve(process.cwd(), '../client/dist'),
  ];
  for (const dir of candidates) {
    if (existsSync(path.join(dir, 'index.html'))) return dir;
  }
  const dev = candidates[0];
  if (dev === undefined) throw new Error('unreachable: empty candidate list');
  return dev; // unbuilt yet — the platform falls back to placeholder text
}

export const sumoModule: GameModule = {
  id: GAME_ID,
  name: 'SUMO',
  clientDist: resolveClientDist(),
  // vite dev server (npm run dev -w @sumo/client); the platform proxies
  // /sumo/ here while it answers — one origin serves launcher + HMR client.
  devPort: DEV_PORT,
  minPlayers: MIN_PLAYERS,
  maxPlayers: MAX_PLAYERS,
  // Phone-as-pad support (docs/PLATFORM.md §4.4): left stick moves,
  // two buttons map to the same bits the keyboard uses.
  padLayout: {
    sticks: [{ id: 'l', label: 'move' }],
    buttons: [
      { bit: 0, label: 'DASH' },
      { bit: 1, label: 'JUMP' },
    ],
  },
  createRoom(opts): GameRoomHandle {
    // No settings to validate: sumo rooms are shapeless (first-to-3 match).
    // Unknown settings are ignored rather than rejected so a future client
    // can send extras without breaking older servers.
    return new SumoRoom(opts.visibility, opts.io);
  },
};
