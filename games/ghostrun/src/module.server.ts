// ============================================================================
// GHOSTRUN GameModule — trivial solo registration shim for the platform
// registry (docs/PLATFORM.md §7). No rooms to speak of: a run is one player
// racing their own ghost, so createRoom hands back a 1-seat no-op handle.
// The real gameplay lives entirely client-side in @ghostrun/game.
// ============================================================================

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GameModule, GameRoomHandle, RoomInfo, Visibility } from '@platform/shared';

export const GAME_ID = 'ghostrun';
export const GAME_NAME = 'GHOSTRUN';
export const DEV_PORT = 5182;
export const MIN_PLAYERS = 1;
export const MAX_PLAYERS = 1;

/**
 * Absolute path to the built client. Candidates cover both layouts this file
 * runs in (first existing index.html wins — aces/module.ts precedent):
 *   1. dev (tsx):        here = games/ghostrun/src        → ../dist
 *   2. bundled:          here = platform/server/dist      → games/ghostrun/dist
 *   3/4. cwd fallbacks:  repo root / package dir.
 */
function resolveClientDist(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, '../dist'),
    path.resolve(here, '../../../games/ghostrun/dist'),
    path.resolve(process.cwd(), 'games/ghostrun/dist'),
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
  const id = `ghostrun-solo-${++seq}`;
  return {
    id,
    info(): RoomInfo {
      return {
        id,
        code: null,
        game: GAME_ID,
        label: "today's time trial",
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

export const ghostrunModule: GameModule = {
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
    sticks: [{ id: 'l', label: 'move' }],
    buttons: [{ bit: 0, label: 'JUMP' }],
  },
};
