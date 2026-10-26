import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import { injectBrandMeta } from './scripts/html-meta.js';
import { siteFonts } from './scripts/site-fonts.js';

/** Adds the title, social and icon tags from BRAND to index.html (dev and build). */
function brandMeta(): Plugin {
  return { name: 'brand-meta', transformIndexHtml: injectBrandMeta };
}

export default defineConfig({
  root: 'src/web',
  // `npm run dev` talks to a separately started `serve` on the default port.
  // '^/api/' (regex form) so the dev server's own /api.ts module is not proxied away.
  server: { proxy: { '^/api/': 'http://127.0.0.1:4317' } },
  plugins: [react(), brandMeta(), siteFonts()],
  build: {
    outDir: '../../dist/web',
    emptyOutDir: true,
  },
});
