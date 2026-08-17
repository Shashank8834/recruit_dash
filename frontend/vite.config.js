import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
      // So you can point a local Evolution instance at the dev server.
      '/webhook': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
});
