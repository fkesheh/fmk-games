import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// base MUST be '/<gameId>/' and server.port MUST equal GameModule.devPort (5186).
export default defineConfig({
  base: '/wordbomb-sdk/',
  resolve: {
    alias: {
      '@wordbomb/shared': fileURLToPath(new URL('../../wordbomb/shared/src', import.meta.url)),
      '@platform/shared': fileURLToPath(new URL('../../../platform/shared/src', import.meta.url)),
    },
  },
  server: {
    port: 5186,
    strictPort: true,
    proxy: { '/ws': { target: 'ws://localhost:8080', ws: true } },
  },
});
