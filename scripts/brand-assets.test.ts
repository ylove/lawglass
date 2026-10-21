import { expect, test } from 'vitest';
import { BRAND } from '../src/core/brand.js';
import { escapeHtml, fontFaceCss, iconHtml, ogHtml } from './brand-assets.js';

test('font faces point at local file:// woff2 files', () => {
  const css = fontFaceCss([400, 600], '/fonts');
  expect(css).toContain('file:///fonts/instrument-sans-latin-400-normal.woff2');
  expect(css).toContain('font-weight:600');
  expect(css).not.toContain('http');
});

test('og html carries the brand name and escapes text', () => {
  expect(escapeHtml('<a&b>')).toBe('&lt;a&amp;b&gt;');
  const html = ogHtml('<svg></svg>', '');
  expect(html).toContain(BRAND.displayName);
  expect(html).toContain('Understand any bill, line by line.');
  expect(html).not.toContain('http');
});

test('icon html sizes the mark to 180px', () => {
  expect(iconHtml('<svg viewBox="0 0 32 32"></svg>')).toContain(
    '<svg width="180" height="180" viewBox',
  );
});
