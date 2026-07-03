import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The DeepSeek key lives only in the Node server (server/index.mjs).
// The client talks to /api/*, which Vite proxies to it during development.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:8787',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
});
