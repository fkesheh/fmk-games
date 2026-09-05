// ============================================================================
// COMPOSITION ROOT — the ONLY platform file that may import a game.
// Register each game's GameModule here; net.ts and lobby.ts stay game-agnostic.
// ============================================================================
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { bankModule } from '@bank/server';
import { kartModule } from '@kart/server';
import type { GameModule } from '@platform/shared';
import { riftModule } from '@rift/server';
import { splatModule } from '@splat/server';
import { wordbombModule } from '@wordbomb/server';
// ·SDK ports (docs/PLATFORM.md §7): same rooms under second ids
import { bankSdkModule } from '@bank/server';
import { wordbombSdkModule } from '@wordbomb/server';
import { kartSdkModule } from '@kart/server';
import { splatSdkModule } from '@splat/server';
import { riftModuleVariant } from '@rift/server';

export const GAMES: GameModule[] = [
  bankModule,
  kartModule,
  wordbombModule,
  riftModule,
  splatModule,
  // PLATFORM v2 port (docs/PLATFORM.md §7): same ANCIENTS rooms under a
  // second id, SDK-shell client at /ancients/, stats sink + phone-pad adapter.
  riftModuleVariant({
    id: 'ancients',
    name: 'ANCIENTS·SDK',
    devPort: 5184,
    clientDist: resolveAncientsClientDist(),
  }),
  // ·SDK ports (docs/PLATFORM.md §7): same rooms under second ids
  bankSdkModule,
  wordbombSdkModule,
  kartSdkModule,
  splatSdkModule,
];

// The variant's clientDist points at the PORT's own shell build (games/ancients/client/dist);
// when it is not built yet the platform entry falls back to placeholder text.
function resolveAncientsClientDist(): string {
  const candidates = [
    path.resolve(process.cwd(), 'games/ancients/client/dist'),
    path.resolve(process.cwd(), '../ancients/client/dist'),
    // esbuild inlines this module into dist/server.js — bundle-relative root:
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../games/ancients/client/dist'),
  ];
  for (const dir of candidates) {
    if (existsSync(path.join(dir, 'index.html'))) return dir;
  }
  return candidates[0] ?? 'games/ancients/client/dist';
}
