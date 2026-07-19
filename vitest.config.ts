import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@fps/shared': fileURLToPath(new URL('./games/fps/shared/src', import.meta.url)),
      '@platform/shared': fileURLToPath(new URL('./platform/shared/src', import.meta.url)),
    },
  },
  test: {
    include: ['games/fps/shared/src/**/*.test.ts', 'games/fps/server/src/**/*.test.ts'],
  },
});
