import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
  // multi-game routing (docs/BANK.md): the platform serves this dist at /bank/
  base: '/bank-sdk/',
  resolve: {
    alias: {
      '@bank/shared': fileURLToPath(new URL('../../bank/shared/src', import.meta.url)),
      '@bank/server': fileURLToPath(new URL('../../bank/server/src', import.meta.url)) + '/',
    },
  },
  server: {
    port: 5185,
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
