import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// base MUST be '/orbit/' and server.port MUST equal GameModule.devPort.
export default defineConfig({
  base: '/orbit/',
  resolve: {
    alias: {
      '@platform/shared': fileURLToPath(new URL('../../platform/shared/src', import.meta.url)),
      '@platform/sdk': fileURLToPath(new URL('../../platform/sdk/src', import.meta.url)),
      '@platform/engine': fileURLToPath(new URL('../../platform/engine/src', import.meta.url)),
    },
  },
  server: {
    port: 5181,
    strictPort: true,
    proxy: {
      '/ws': { target: 'ws://localhost:8080', ws: true },
      '/api': { target: 'http://localhost:8080', changeOrigin: true },
    },
  },
});
