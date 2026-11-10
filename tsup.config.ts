import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    cli: 'src/cli/index.ts',
    server: 'src/server/index.ts',
    // The cost calibration job (deploy/calibration). Built so the container, which prunes dev
    // dependencies and so has no tsx, can run it; kept out of the npm package (package.json files).
    calibrate: 'scripts/calibrate.ts',
  },
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  outDir: 'dist',
  clean: true,
  splitting: false,
  sourcemap: true,
  dts: {
    entry: { server: 'src/server/index.ts' },
    // tsup's declaration worker still sets baseUrl internally; TypeScript 6 deprecates it.
    compilerOptions: { ignoreDeprecations: '6.0' },
  },
  outExtension: () => ({ js: '.js' }),
  // Inline PDF.js rather than depend on it: as a dependency it would make every npx install
  // fetch its full 35MB package plus the optional @napi-rs/canvas binary (about 27MB), which
  // the parser never uses because it never renders. See docs/decisions/0006.
  noExternal: ['pdfjs-dist'],
});
