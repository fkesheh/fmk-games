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
    ],
  },
});
