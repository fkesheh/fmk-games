import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// base MUST be '/<gameId>/' and server.port MUST equal GameModule.devPort.
export default defineConfig({
  base: '/rift/',
  resolve: {
    alias: {
      '@rift/shared': fileURLToPath(new URL('../shared/src', import.meta.url)),
      '@platform/shared': fileURLToPath(new URL('../../../platform/shared/src', import.meta.url)),
    },
  },
  server: {
    port: 5177,
    strictPort: true,
    proxy: { '/ws': { target: 'ws://localhost:8080', ws: true } },
  },
  build: {
    rollupOptions: {
      // Two HTML entries: the game itself, and the audio render lab (T11, driven offline by
      // scripts/audio-render-rift.mjs). Omitting index.html here would delist the game.
      input: {
        main: fileURLToPath(new URL('index.html', import.meta.url)),
        audioLab: fileURLToPath(new URL('audio-lab.html', import.meta.url)),
      },
    },
  },
});
