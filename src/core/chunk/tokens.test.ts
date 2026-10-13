import { describe, expect, it } from 'vitest';
import { estimateTokens } from './tokens.js';

describe('estimateTokens', () => {
  it.each([
    ['', 0],
    ['   ', 1],
    ['one two three', 4],
    ['x'.repeat(21), 6],
    ['a\nb\tc', 4],
    ['水'.repeat(20), 5],
    ['😀'.repeat(10), 5],
  ])('sizes %j conservatively', (text, expected) => {
    expect(estimateTokens(text)).toBe(expected);
  });

  it('uses the larger of the word and character estimates', () => {
    const text = 'longword short\nwords!';
    expect(estimateTokens(text)).toBe(
      Math.max(Math.ceil(3 * 1.3), Math.ceil(text.length / 4)),
    );
  });
});
