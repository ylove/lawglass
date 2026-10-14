import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  root: 'src/web',
  // `npm run dev` talks to a separately started `serve` on the default port.
  server: { proxy: { '/api': 'http://127.0.0.1:4317' } },
  plugins: [react()],
  build: {
    outDir: '../../dist/web',
    emptyOutDir: true,
  },
});
