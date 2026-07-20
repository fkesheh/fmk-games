import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
  // multi-game routing (docs/KART.md): the platform serves this dist at /kart/
  base: '/kart/',
  resolve: {
    alias: {
      '@kart/shared': fileURLToPath(new URL('../shared/src', import.meta.url)),
    },
  },
  server: {
    port: 5175,
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
