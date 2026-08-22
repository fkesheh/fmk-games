import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// base MUST be '/sumo/' and server.port MUST equal GameModule.devPort.
// DEVIATION from specs/P10.md: the spec says devPort 5178, but ORBIT already
// binds 5178 (games/orbit/vite.config.ts) — sumo uses 5183 everywhere.
export default defineConfig({
  base: '/sumo/',
  resolve: {
    alias: {
      '@sumo/shared': fileURLToPath(new URL('../shared/src', import.meta.url)),
      '@platform/shared': fileURLToPath(new URL('../../../platform/shared/src', import.meta.url)),
      '@platform/sdk': fileURLToPath(new URL('../../../platform/sdk/src', import.meta.url)),
      '@platform/engine': fileURLToPath(new URL('../../../platform/engine/src', import.meta.url)),
    },
  },
  server: {
    port: 5183,
    strictPort: true,
    proxy: {
      '/ws': { target: 'ws://localhost:8080', ws: true },
      '/api': { target: 'http://localhost:8080', changeOrigin: true },
    },
  },
});
