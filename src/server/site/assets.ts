// Files the public pages may load without a session. The list is exact on purpose: the gate
// serves these paths and nothing else, so adding a file here is a decision to make it public.

/**
 * Fonts get fixed names so the stylesheet can reference them without knowing Vite's content
 * hashes. `from` is relative to node_modules; scripts/site-fonts.ts copies them at build time,
 * so no font binaries are committed.
 */
export const SITE_FONTS = [
  {
    file: 'instrument-sans-400.woff2',
    from: '@fontsource/instrument-sans/files/instrument-sans-latin-400-normal.woff2',
  },
  {
    file: 'instrument-sans-500.woff2',
    from: '@fontsource/instrument-sans/files/instrument-sans-latin-500-normal.woff2',
  },
  {
    file: 'instrument-sans-600.woff2',
    from: '@fontsource/instrument-sans/files/instrument-sans-latin-600-normal.woff2',
  },
  {
    file: 'source-serif-4-400.woff2',
    from: '@fontsource/source-serif-4/files/source-serif-4-latin-400-normal.woff2',
  },
] as const;

/** Screenshots of the app, produced by scripts/site-shots.ts. */
export const SITE_SHOTS = [
  '/site/in-brief.jpg',
  '/site/sections.jpg',
  '/site/find.jpg',
  '/site/history.jpg',
  '/site/changes.jpg',
  '/site/decides.jpg',
] as const;

export const PUBLIC_ASSETS: ReadonlySet<string> = new Set([
  '/favicon.svg',
  '/apple-touch-icon.png',
  '/og-image.png',
  '/robots.txt',
  '/site.css',
  ...SITE_FONTS.map((font) => `/fonts/${font.file}`),
  ...SITE_SHOTS,
]);
