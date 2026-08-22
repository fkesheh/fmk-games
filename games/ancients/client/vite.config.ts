import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// base MUST be '/ancients/' and server.port MUST equal GameModule.devPort
// (riftModuleVariant opts). The game code itself is REUSED from @rift/client —
// only the shell (main.ts) and this config belong to the port.
export default defineConfig({
  base: '/ancients/',
  resolve: {
    alias: {
      '@rift/shared': fileURLToPath(new URL('../../rift/shared/src', import.meta.url)),
      '@rift/client': fileURLToPath(new URL('../../rift/client/src', import.meta.url)) + '/',
      '@platform/shared': fileURLToPath(new URL('../../../platform/shared/src', import.meta.url)),
      '@platform/sdk': fileURLToPath(new URL('../../../platform/sdk/src', import.meta.url)) + '/',
    },
  },
  server: {
    port: 5184,
    strictPort: true,
    proxy: { '/ws': { target: 'ws://localhost:8080', ws: true } },
  },
});
