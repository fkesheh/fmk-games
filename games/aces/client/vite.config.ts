import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// base MUST be '/aces/' and server.port MUST equal GameModule.devPort.
export default defineConfig({
  base: '/aces/',
  resolve: {
    alias: {
      '@aces/shared': fileURLToPath(new URL('../shared/src', import.meta.url)),
      '@platform/shared': fileURLToPath(new URL('../../../platform/shared/src', import.meta.url)),
    },
  },
  server: {
    port: 5180,
    strictPort: true,
    proxy: { '/ws': { target: 'ws://localhost:8080', ws: true } },
  },
});
