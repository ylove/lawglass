// Static <head> tags for the web UI, built from BRAND. Kept as a pure function so it is unit
// tested, and wired into Vite as a tiny plugin (see vite.config.ts).
import { BRAND } from '../src/core/brand.js';

export const META_DESCRIPTION =
  'Plain-language answers about U.S. federal and Ohio bills, with citations to section, page and line.';
export const THEME_COLOR = '#0f3b6e';

export function escapeHtmlAttr(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

/** The tags injected into <head>. The app still sets document.title at runtime. */
export function brandHeadTags(
  name: string = BRAND.displayName,
  description: string = META_DESCRIPTION,
): string {
  const n = escapeHtmlAttr(name);
  const d = escapeHtmlAttr(description);
  return [
    `<title>${n}</title>`,
    `<meta name="description" content="${d}" />`,
    `<meta property="og:title" content="${n}" />`,
    `<meta property="og:description" content="${d}" />`,
    `<meta property="og:type" content="website" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="theme-color" content="${THEME_COLOR}" />`,
    // Private preview: remove at public launch (together with Disallow in public/robots.txt).
    `<meta name="robots" content="noindex" />`,
    `<link rel="icon" href="/favicon.svg" type="image/svg+xml" />`,
    `<link rel="apple-touch-icon" href="/apple-touch-icon.png" />`,
  ].join('\n    ');
}

/** Replaces the empty template <title> and adds the brand tags. */
export function injectBrandMeta(html: string): string {
  const tags = brandHeadTags();
  const withoutTitle = html.replace(/<title>[^<]*<\/title>\s*/i, '');
  return withoutTitle.replace('</head>', `    ${tags}\n  </head>`);
}
