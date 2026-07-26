import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { DEVELOPMENT_CONTENT_SECURITY_POLICY, PRODUCTION_CONTENT_SECURITY_POLICY } from './src/security/cspPolicy';

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'alsniper-csp-contract',
      transformIndexHtml(html, context) {
        if (!html.includes(PRODUCTION_CONTENT_SECURITY_POLICY)) {
          throw new Error('Production CSP marker is missing from index.html.');
        }
        return context.server
          ? html.replace(PRODUCTION_CONTENT_SECURITY_POLICY, DEVELOPMENT_CONTENT_SECURITY_POLICY)
          : html;
      },
    },
  ],
  build: {
    target: 'es2022',
    sourcemap: true,
    // Three.js lives in a route-level lazy chunk; its size is intentional and
    // does not delay the desktop shell or utility apps.
    chunkSizeWarningLimit: 1000,
  },
});
