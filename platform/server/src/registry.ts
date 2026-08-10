// ============================================================================
// COMPOSITION ROOT — the ONLY platform file that may import a game.
// Register each game's GameModule here; net.ts and lobby.ts stay game-agnostic.
// ============================================================================
import { bankModule } from '@bank/server';
import { fpsModule } from '@fps/server';
import { kartModule } from '@kart/server';
import type { GameModule } from '@platform/shared';
import { riftModule } from '@rift/server';
import { splatModule } from '@splat/server';
import { wordbombModule } from '@wordbomb/server';

export const GAMES: GameModule[] = [
  fpsModule,
  bankModule,
  kartModule,
  wordbombModule,
  riftModule,
  splatModule,
];
