import { copyFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Plugin } from 'vite';
import { SITE_FONTS } from '../src/server/site/assets.js';

/**
 * Copies the latin woff2 files the public pages use into <outDir>/fonts/ under fixed names.
 * The app bundles the same fonts with hashed names, which a hand-written stylesheet cannot
 * reference; copying (instead of committing binaries) keeps the licence-bearing files in
 * node_modules where their package and version are recorded.
 */
export function siteFonts(): Plugin {
  let outDir = '';
  return {
    name: 'site-fonts',
    apply: 'build',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    async closeBundle() {
      const target = join(outDir, 'fonts');
      await mkdir(target, { recursive: true });
      await Promise.all(
        SITE_FONTS.map((font) =>
          copyFile(resolve('node_modules', font.from), join(target, font.file)),
        ),
      );
    },
  };
}
