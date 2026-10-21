import { expect, test } from 'vitest';
import { BRAND } from '../src/core/brand.js';
import {
  brandHeadTags,
  escapeHtmlAttr,
  injectBrandMeta,
  META_DESCRIPTION,
} from './html-meta.js';

test('escapes attribute values', () => {
  expect(escapeHtmlAttr(`a&b"c'd<e>`)).toBe('a&amp;b&quot;c&#39;d&lt;e&gt;');
  expect(brandHeadTags('X"><script>', 'd')).not.toContain('<script>');
});

test('emits the title, social, theme, noindex and icon tags from BRAND', () => {
  const tags = brandHeadTags();
  expect(tags).toContain(`<title>${BRAND.displayName}</title>`);
  expect(tags).toContain(`property="og:title" content="${BRAND.displayName}"`);
  expect(tags).toContain(META_DESCRIPTION);
  expect(tags).toContain(`property="og:url" content="${BRAND.siteUrl}"`);
  expect(tags).toContain(
    `property="og:image" content="${BRAND.siteUrl}/og-image.png"`,
  );
  expect(tags).toContain(
    `name="twitter:image" content="${BRAND.siteUrl}/og-image.png"`,
  );
  expect(tags).toContain('name="twitter:card" content="summary_large_image"');
  expect(tags).toContain('name="theme-color" content="#0f3b6e"');
  expect(tags).toContain('name="robots" content="noindex"');
  expect(tags).toContain('href="/favicon.svg" type="image/svg+xml"');
  expect(tags).toContain('rel="apple-touch-icon" href="/apple-touch-icon.png"');
  // The strict CSP forbids inline script and style.
  expect(tags).not.toMatch(/<script|style=/);
});

test('replaces the empty title and injects once before </head>', () => {
  const out = injectBrandMeta(
    '<html><head><meta charset="UTF-8" />\n    <title></title>\n  </head></html>',
  );
  expect(out.match(/<title>/g)).toHaveLength(1);
  expect(out).toContain(`<title>${BRAND.displayName}</title>`);
  expect(out.indexOf('og:title')).toBeLessThan(out.indexOf('</head>'));
});
