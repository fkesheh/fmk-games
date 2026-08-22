// ============================================================================
// ORBIT GameModule — trivial solo registration shim for the platform registry
// (docs/PLATFORM.md §7). A run is one pilot in their own tunnel: createRoom
// hands back a 1-seat no-op handle and says so. The gameplay lives entirely
// client-side in @orbit/game.
// ============================================================================

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GameModule, GameRoomHandle, RoomInfo, Visibility } from '@platform/shared';

export const GAME_ID = 'orbit';
export const GAME_NAME = 'ORBIT';
export const DEV_PORT = 5178;
export const MIN_PLAYERS = 1;
export const MAX_PLAYERS = 1;

/**
 * Absolute path to the built client. Candidates cover both layouts this file
 * runs in (first existing index.html wins — aces/module.ts precedent):
 *   1. dev (tsx):        here = games/orbit/src          → ../dist
 *   2. bundled:          here = platform/server/dist     → games/orbit/dist
 *   3/4. cwd fallbacks:  repo root / package dir.
 */
function resolveClientDist(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, '../dist'),
    path.resolve(here, '../../../games/orbit/dist'),
    path.resolve(process.cwd(), 'games/orbit/dist'),
    path.resolve(process.cwd(), '../dist'),
  ];
  for (const dir of candidates) {
    if (existsSync(path.join(dir, 'index.html'))) return dir;
  }
  return candidates[0] as string; // unbuilt yet — platform falls back to placeholder text
}

/** One seat, nothing to simulate: messages are dropped, lifecycle is counted. */
function createSoloRoom(visibility: Visibility): GameRoomHandle {
  let players = 0;
  let seq = 0;
  const id = `orbit-solo-${++seq}`;
  return {
    id,
    info(): RoomInfo {
      return {
        id,
        code: null,
        game: GAME_ID,
        label: 'solo — play at your own pace',
        players,
        maxPlayers: MAX_PLAYERS,
        phase: 'solo',
        visibility,
      };
    },
    playerCount(): number {
      return players;
    },
    stalePlayers(): string[] {
      return [];
    },
    addPlayer(): void {
      players++;
    },
    removePlayer(): void {
      players = Math.max(0, players - 1);
    },
    handleMessage(): void {
      // solo game: the platform envelope is already validated; drop the rest
    },
    start(): void {},
    stop(): void {},
  };
}

export const orbitModule: GameModule = {
  id: GAME_ID,
  name: GAME_NAME,
  clientDist: resolveClientDist(),
  devPort: DEV_PORT,
  minPlayers: MIN_PLAYERS,
  maxPlayers: MAX_PLAYERS,
  createRoom(opts): GameRoomHandle {
    return createSoloRoom(opts.visibility);
  },
  padLayout: {
    sticks: [{ id: 'l', label: 'steer' }],
    buttons: [{ bit: 0, label: 'BOOST' }],
  },
};
