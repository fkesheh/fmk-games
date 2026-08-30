import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
  // multi-game routing (docs/KART.md): the platform serves this dist at /kart/
  base: '/kart-sdk/',
  resolve: {
    alias: {
      '@kart/shared': fileURLToPath(new URL('../../kart/shared/src', import.meta.url)),
    },
  },
  server: {
    port: 5187,
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
    rollupOptions: {
      // TWO entries: the game and the phone controller. pad.html is reached by
      // scanning a pairing QR (docs/PAD.md) at the FILE url '/kart/pad.html' —
      // the platform's static server SPA-fallbacks directory misses to the game
      // page, so a pad.html that is not emitted here 404s straight into the
      // game instead of the controller.
      input: {
        index: fileURLToPath(new URL('index.html', import.meta.url)),
        pad: fileURLToPath(new URL('pad.html', import.meta.url)),
      },
    },
  },
});
