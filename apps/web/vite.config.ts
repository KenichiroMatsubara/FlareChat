import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:8787',
      '/attendance': 'http://localhost:8787',
      '/oauth': 'http://localhost:8787',
    },
  },
});
