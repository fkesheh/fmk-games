import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
  // multi-game routing (docs/BANK.md): the platform serves this dist at /bank/
  base: '/bank/',
  resolve: {
    alias: {
      '@bank/shared': fileURLToPath(new URL('../shared/src', import.meta.url)),
    },
  },
  server: {
    port: 5174,
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
