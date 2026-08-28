import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev-only proxy: the Fastify server owns /api/* and the root-level /ws
// WebSocket endpoint (NOT /api/ws — see the design doc). In production the
// same Fastify server serves the built web/ assets directly, so no proxy is
// needed there.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:8082',
        changeOrigin: true,
      },
      '/ws': {
        target: 'ws://localhost:8082',
        ws: true,
      },
    },
  },
});
