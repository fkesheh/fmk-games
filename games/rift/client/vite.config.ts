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
});
