import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
  // multi-game routing: the platform serves this dist at /splat/
  base: '/splat-sdk/',
  resolve: {
    alias: {
      '@splat/shared': fileURLToPath(new URL('../../splat/shared/src', import.meta.url)),
    },
  },
  server: {
    port: 5188,
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
