import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@fps/shared': fileURLToPath(new URL('./games/fps/shared/src', import.meta.url)),
      '@bank/shared': fileURLToPath(new URL('./games/bank/shared/src', import.meta.url)),
      '@kart/shared': fileURLToPath(new URL('./games/kart/shared/src', import.meta.url)),
      '@platform/shared': fileURLToPath(new URL('./platform/shared/src', import.meta.url)),
    },
  },
  test: {
    include: [
      'games/fps/shared/src/**/*.test.ts',
      'games/fps/server/src/**/*.test.ts',
      'games/bank/server/src/**/*.test.ts',
      'games/kart/shared/src/**/*.test.ts',
      'games/kart/server/src/**/*.test.ts',
    ],
  },
});
