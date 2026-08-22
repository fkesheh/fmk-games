import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@fps/shared': fileURLToPath(new URL('./games/fps/shared/src', import.meta.url)),
      '@bank/shared': fileURLToPath(new URL('./games/bank/shared/src', import.meta.url)),
      '@kart/shared': fileURLToPath(new URL('./games/kart/shared/src', import.meta.url)),
      '@wordbomb/shared': fileURLToPath(new URL('./games/wordbomb/shared/src', import.meta.url)),
      '@rift/shared': fileURLToPath(new URL('./games/rift/shared/src', import.meta.url)),
      '@splat/shared': fileURLToPath(new URL('./games/splat/shared/src', import.meta.url)),
      '@outpost/shared': fileURLToPath(new URL('./games/outpost/shared/src', import.meta.url)),
      '@platform/shared': fileURLToPath(new URL('./platform/shared/src', import.meta.url)),
    },
  },
  test: {
    include: [
      'games/fps/shared/src/**/*.test.ts',
      'games/fps/server/src/**/*.test.ts',
      'games/fps/client/src/render/**/*.test.ts',
      'games/bank/shared/src/**/*.test.ts',
      'games/bank/server/src/**/*.test.ts',
      'games/kart/shared/src/**/*.test.ts',
      'games/kart/server/src/**/*.test.ts',
      // The kart CLIENT was missing an include, so any test written there would
      // have silently never run — the same defect that hid games/bank/shared.
      'games/kart/client/src/**/*.test.ts',
      'games/wordbomb/shared/src/**/*.test.ts',
      'games/wordbomb/server/src/**/*.test.ts',
      'games/rift/shared/src/**/*.test.ts',
      'games/rift/server/src/**/*.test.ts',
      'games/rift/client/src/**/*.test.ts',
      'games/splat/shared/src/**/*.test.ts',
      'games/splat/server/src/**/*.test.ts',
      'games/splat/client/src/**/*.test.ts',
      'games/outpost/shared/src/**/*.test.ts',
      'games/outpost/server/src/**/*.test.ts',
      'games/outpost/client/src/**/*.test.ts',
      // The PLATFORM had no include at all, so platform/server/src/lobby.test.ts —
      // the only coverage matchmaking has ever had — would have been silently
      // skipped. Same defect that hid games/bank/shared and the kart client.
      'platform/server/src/**/*.test.ts',
      'platform/shared/src/**/*.test.ts',
      // The ASSET LIBRARY workspace — added at its creation; without an
      // include here its tests would silently never run (the exact defect
      // documented above for bank/shared, the kart client, and platform).
      'assets/library/src/**/*.test.ts',
    ],
  },
});
