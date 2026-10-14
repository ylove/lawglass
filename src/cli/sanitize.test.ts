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
