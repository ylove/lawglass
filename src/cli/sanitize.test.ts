import { expect, test } from 'vitest';
import { safeText } from './sanitize.js';

test('removes OSC hyperlinks, CSI colors and stray controls but keeps newlines and tabs', () => {
  expect(
    safeText('\u001b]8;;https://evil.example/\u0007link\u001b]8;;\u0007'),
  ).toBe('link');
  expect(safeText('\u001b]0;title\u001b\\x')).toBe('x');
  expect(safeText('\u001b[31mred\u001b[0m')).toBe('red');
  expect(safeText('a\u0000b\u0085c\u009bd\u007fe')).toBe('abcde');
  expect(safeText('line1\n\tline2')).toBe('line1\n\tline2');
  expect(safeText('\u001bMx')).toBe('x');
  expect(safeText('plain § text – ok')).toBe('plain § text – ok');
});

test('removes bidi controls and zero-width characters that disguise text', () => {
  const hidden = [
    '\u061c',
    '\u200b',
    '\u200c',
    '\u200d',
    '\u200e',
    '\u200f',
    '\u202a',
    '\u202b',
    '\u202c',
    '\u202d',
    '\u202e',
    '\u2060',
    '\u2066',
    '\u2067',
    '\u2068',
    '\u2069',
    '\ufeff',
  ];
  for (const char of hidden) expect(safeText(`a${char}b`)).toBe('ab');
  expect(safeText('pay\u202egpj.exe')).toBe('paygpj.exe');
  // Ordinary non-Latin text must survive.
  expect(safeText('שלום 世界 ñ')).toBe('שלום 世界 ñ');
});
