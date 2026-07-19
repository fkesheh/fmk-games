// ============================================================================
// COMPOSITION ROOT — the ONLY platform file that may import a game.
// Register each game's GameModule here; net.ts and lobby.ts stay game-agnostic.
// ============================================================================
import { fpsModule } from '@fps/server';
import type { GameModule } from '@platform/shared';

export const GAMES: GameModule[] = [fpsModule];
