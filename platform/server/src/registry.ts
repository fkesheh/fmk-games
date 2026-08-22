// ============================================================================
// COMPOSITION ROOT — the ONLY platform file that may import a game.
// Register each game's GameModule here; net.ts and lobby.ts stay game-agnostic.
// ============================================================================
import { acesModule } from '@aces/server';
import { bankModule } from '@bank/server';
import { fpsModule } from '@fps/server';
import { kartModule } from '@kart/server';
import type { GameModule } from '@platform/shared';
import { riftModule } from '@rift/server';
import { splatModule } from '@splat/server';
import { outpostModule } from '@outpost/server';
import { wordbombModule } from '@wordbomb/server';
// PLATFORM v2 showcase games (@platform/sdk + @platform/engine clients)
import { orbitModule } from '@orbit/game/module.server';
import { sumoModule } from '@sumo/server';
import { ghostrunModule } from '@ghostrun/game/module.server';

export const GAMES: GameModule[] = [
  fpsModule,
  bankModule,
  kartModule,
  wordbombModule,
  riftModule,
  splatModule,
  outpostModule,
  acesModule,
  orbitModule,
  sumoModule,
  ghostrunModule,
];
