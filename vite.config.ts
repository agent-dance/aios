import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    target: 'es2022',
    sourcemap: true,
    // Three.js lives in a route-level lazy chunk; its size is intentional and
    // does not delay the desktop shell or utility apps.
    chunkSizeWarningLimit: 1000,
  },
});
