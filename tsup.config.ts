import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { cli: 'src/cli/index.ts', server: 'src/server/index.ts' },
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  outDir: 'dist',
  clean: true,
  splitting: false,
  sourcemap: true,
  outExtension: () => ({ js: '.js' }),
  // Inline PDF.js rather than depend on it: as a dependency it would make every npx install
  // fetch its full 35MB package plus the optional @napi-rs/canvas binary (about 27MB), which
  // the parser never uses because it never renders. See docs/decisions/0006.
  noExternal: ['pdfjs-dist'],
});
