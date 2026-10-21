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

const KEEP = { keepOperators: true };
test('sanitizeText keeps literal comparison operators and only removes real tags', () => {
  expect(sanitizeText('income < $50,000 and age > 65', 2000, KEEP)).toBe(
    'income < $50,000 and age > 65',
  );
  expect(sanitizeText('income &lt; $50,000 and age &gt; 65', 2000, KEEP)).toBe(
    'income < $50,000 and age > 65',
  );
  // An unmatched "<" must not delete what follows it.
  expect(sanitizeText('if x < 5 then continue to the end', 2000, KEEP)).toBe(
    'if x < 5 then continue to the end',
  );
  expect(sanitizeText('a <b and c> d', 2000, KEEP)).toBe('a d');
  expect(
    sanitizeText('a<b>bold</b> <a href="x">l</a> <!--c--> <3 x<y', 2000, KEEP),
  ).toBe('a bold l <3 x<y');
  expect(
    sanitizeText('&lt;script&gt;x&lt;/script&gt; 1 &lt; 2', 2000, KEEP),
  ).toBe('x 1 < 2');
});
test('tag stripping stays linear on nested unmatched brackets', () => {
  for (const unit of ['<a ', '<a<', '<a>', '< ', '</']) {
    const started = performance.now();
    sanitizeText(unit.repeat(1_000_000 / unit.length), 2000, KEEP);
    expect(performance.now() - started).toBeLessThan(200);
  }
});
test('the default mode still drops every bare angle bracket', () => {
  expect(sanitizeText('income < $50,000 and age > 65')).toBe('income 65');
});
