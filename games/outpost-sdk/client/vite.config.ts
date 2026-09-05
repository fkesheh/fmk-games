import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
  // multi-game routing: the platform serves this dist at /outpost/
  base: '/outpost-sdk/',
  resolve: {
    alias: {
      '@outpost/shared': fileURLToPath(new URL('../../outpost/shared/src', import.meta.url)),
      '@fps/shared': fileURLToPath(new URL('../../fps/shared/src', import.meta.url)),
    },
  },
  server: {
    port: 5193,
    strictPort: true, // never drift — the platform dev proxy probes this exact port
    proxy: {
      '/ws': {
        target: 'ws://localhost:8080',
        ws: true,
      },
    },
  },
  build: {
    outDir: 'dist',
  },
});
