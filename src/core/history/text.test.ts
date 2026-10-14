import { expect, test } from 'vitest';
import { MAX_NAME, sanitizeText, stripInvisible } from './text.js';

test('stripInvisible removes zero-width and bidi characters only', () => {
  expect(stripInvisible('a​b‏c‪d‮e⁦f⁩g﻿h')).toBe('abcdefgh');
  expect(stripInvisible('café ünï')).toBe('café ünï');
});
test('sanitizeText strips tags, entities and control characters in one pass each', () => {
  expect(sanitizeText('a<b>b</b>\u0007 &amp; &lt;i&gt;c&lt;/i&gt; </')).toBe(
    'a b & c',
  );
  expect(sanitizeText('x'.repeat(500), MAX_NAME)).toBe(`${'x'.repeat(200)}…`);
});
test('hostile markup runs in linear time', () => {
  for (const unit of ['<', '<a', '&#x', '<script ', '&amp;', '​']) {
    const started = performance.now();
    sanitizeText(unit.repeat(1_000_000 / unit.length));
    expect(performance.now() - started).toBeLessThan(100);
  }
});
